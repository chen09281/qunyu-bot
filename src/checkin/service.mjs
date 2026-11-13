import { existsSync, lstatSync, mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { messageSegments } from '../images.mjs';
import { DocumentGenerator, runDocumentWorker } from '../documents.mjs';
import { createCheckinAdapters, parseCredential, platformId, platforms } from './platforms.mjs';
import { CheckinError, errorKind, resultText } from './http.mjs';
import { CheckinHelpImage } from './help-image.mjs';

const qq = value => /^\d{5,20}$/.test(String(value));
export const chinaTime = now => new Date(now + 8 * 3600000).toISOString();
const allowed = (config, group) => config.allowedGroups.some(item => String(typeof item === 'string' ? item : item.id) === String(group));
const defaults = () => ({ enabled: false, time: '09:05', notify: true, platforms: { skland: true, miyoushe: true, kuro: true } });
const help = '发送「/签到 帮助」查看签到指令图片；发送「/签到 文档」获取详细账号绑定教程。凭据只发私聊。';
const resultLine = item => `${item.label}：${resultText[item.status] || resultText.failed}`;

// Recognize commands even when disabled, so credentials never reach model logs/history.
export function checkinCommand(event) {
  let text = '';
  for (const segment of messageSegments(event.message)) {
    if (segment.type === 'text') text += segment.data?.text || '';
  }
  const match = /^\s*[/#]?签到(?=$|\s|绑定|解绑|开通|帮助|文档|状态|自动)([\s\S]*)$/.exec(text);
  return match ? match[1].trim() : null;
}
function privateWrite(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, data, { flag: 'wx', mode: 0o600 }); renameSync(temp, path);
}

export class CheckinService {
  constructor(dataDir, store, { onebot, log = () => {}, adapters = createCheckinAdapters(), now = Date.now, documents, helpImage } = {}) {
    this.store = store; this.onebot = onebot; this.log = log; this.adapters = adapters; this.now = now;
    // A separate renderer keeps this fixed guide independent of DS and its document switch.
    this.documents = documents || new DocumentGenerator(dataDir, {
      worker: (input, options) => runDocumentWorker({ ...input, layout: 'checkin-binding' }, options),
    });
    this.helpImage = helpImage || new CheckinHelpImage();
    this.closed = false; this.active = new Set(); this.jobs = new Set(); this.controllers = new Set();
    this.seen = new Map(); this.cooldowns = new Map(); this.scheduled = false;
    const dir = join(dataDir, 'checkin');
    for (const path of [dir, join(dir, 'key'), join(dir, 'accounts.enc')]) {
      try { if (lstatSync(path).isSymbolicLink()) throw new Error('签到数据不能是符号链接'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    this.path = join(dir, 'accounts.enc'); const keyPath = join(dir, 'key');
    if (!existsSync(keyPath)) {
      if (existsSync(this.path)) throw new Error('签到数据密钥缺失，请恢复原密钥');
      writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    }
    chmodSync(keyPath, 0o600); this.key = readFileSync(keyPath);
    this.state = { version: 1, settings: defaults(), members: {} };
    if (existsSync(this.path)) {
      chmodSync(this.path, 0o600);
      try {
        const bytes = readFileSync(this.path), decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        const state = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
        if (state.version !== 1 || !state.members || !state.settings) throw new Error();
        this.state = state;
      } catch { throw new Error('签到数据无法解密，请检查数据和密钥备份'); }
    }
  }
  save() {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(this.state)), cipher.final()]);
    privateWrite(this.path, Buffer.concat([iv, cipher.getAuthTag(), bytes]));
  }
  status() {
    return { settings: structuredClone(this.state.settings), active: this.active.size, timezone: 'Asia/Shanghai',
      members: Object.entries(this.state.members).map(([user, member]) => ({ user, group: member.group, auto: member.auto,
        accounts: Object.entries(member.accounts).map(([platform, account]) => ({ platform, name: platforms[platform],
          needsLogin: Boolean(account.needsLogin), last: account.last ? structuredClone(account.last) : null })) })) };
  }
  configure(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['enabled', 'time', 'notify', 'platforms'].includes(k))) throw new Error('签到配置格式错误');
    const next = { ...this.state.settings };
    for (const key of ['enabled', 'notify']) if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw new Error('签到开关必须为布尔值'); next[key] = input[key];
    }
    if (input.time !== undefined) {
      if (typeof input.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('签到时间应为 HH:MM'); next.time = input.time;
    }
    if (input.platforms !== undefined) {
      if (!input.platforms || Array.isArray(input.platforms) || typeof input.platforms !== 'object'
        || Object.entries(input.platforms).some(([k, v]) => !Object.hasOwn(platforms, k) || typeof v !== 'boolean')) throw new Error('签到平台配置无效');
      next.platforms = { ...next.platforms, ...input.platforms };
    }
    const previous = this.state.settings; this.state.settings = next;
    try { this.save(); } catch (error) { this.state.settings = previous; throw error; }
    // Cancel on any settings change; next tick uses the newly saved policy.
    this.cancel(); return this.status();
  }
  enabled(group) { return !this.closed && this.store.config.enabled && this.state.settings.enabled && allowed(this.store.config, group); }
  async membership(user, group) {
    if (!this.enabled(group)) return false;
    try {
      const member = await this.onebot('get_group_member_info', { group_id: group, user_id: user, no_cache: true });
      return this.enabled(group) && String(member?.user_id) === user && String(member?.group_id) === group;
    } catch { return false; }
  }
  async reply(event, text) {
    if (this.closed) return;
    const group = event.message_type === 'group';
    if (group && !allowed(this.store.config, event.group_id)) return;
    await this.onebot(group ? 'send_group_msg' : 'send_private_msg', {
      ...(group ? { group_id: event.group_id } : { user_id: event.user_id }),
      message: [...(group ? [{ type: 'at', data: { qq: String(event.user_id) } }] : []), { type: 'text', data: { text } }],
    });
  }
  async sendHelp(event) {
    const controller = new AbortController(); this.controllers.add(controller);
    const group = event.message_type === 'group';
    const canSend = () => !controller.signal.aborted && !this.closed && this.store.config.enabled && this.state.settings.enabled
      && (!group || allowed(this.store.config, event.group_id));
    try {
      if (!canSend()) return;
      const file = await this.helpImage.create();
      if (!canSend()) return;
      await this.onebot(group ? 'send_group_msg' : 'send_private_msg', {
        ...(group ? { group_id: event.group_id } : { user_id: event.user_id }),
        message: [{ type: 'image', data: { file } }],
      }, this.store.config, 120);
      this.log('info', `${group ? `群 ${event.group_id}` : `私聊 ${event.user_id}`} 请求签到帮助图片`, {
        source: 'checkin',
        ...(group ? { groupId: String(event.group_id) } : {}),
        userId: String(event.user_id)
      });
    } catch {
      if (canSend()) {
        this.log('warn', '签到帮助图片生成或发送失败');
        await this.reply(event, '签到帮助图片暂时无法发送，请稍后重试；也可发送「/签到 文档」获取详细绑定教程。');
      }
    } finally { this.controllers.delete(controller); }
  }
  async sendGuide(event) {
    const controller = new AbortController(); this.controllers.add(controller);
    const group = event.message_type === 'group';
    const canSend = () => !controller.signal.aborted && !this.closed && this.store.config.enabled && this.state.settings.enabled
      && (!group || allowed(this.store.config, event.group_id));
    let document, keepDocument = false;
    try {
      if (!canSend()) return;
      const guideTemplate = readFileSync(new URL('./binding-guide.md', import.meta.url), 'utf8');
      const publicUrl = String(this.store.config.consolePublicUrl || '').trim().replace(/\/+$/, '');
      const guideContent = publicUrl ? guideTemplate.replaceAll('https://bot.example.com/tools/kuro/', `${publicUrl}/tools/kuro/`) : guideTemplate;
      document = await this.documents.create({ title: '签到账号绑定教程', content: guideContent }, ['pdf']);
      if (!canSend()) return;
      const file = document.files[0];
      try {
        await this.onebot(group ? 'upload_group_file' : 'upload_private_file', {
          ...(group ? { group_id: event.group_id } : { user_id: event.user_id }),
          file: file.uploadPath, name: file.name,
        }, this.store.config, 120);
        this.log('info', `${group ? `群 ${event.group_id}` : `私聊 ${event.user_id}`} 领取签到使用文档 (PDF)`, {
          source: 'checkin',
          ...(group ? { groupId: String(event.group_id) } : {}),
          userId: String(event.user_id)
        });
      } catch {
        // On timeout NapCat may still be reading the shared file, as with DS documents.
        keepDocument = true;
        if (canSend()) await this.reply(event, group
          ? '教程文档上传未确认成功，请检查群文件权限或空间，也可加机器人好友后私聊「/签到 文档」重试。'
          : '教程文档上传未确认成功，请确认已加机器人好友，稍后发送「/签到 文档」重试。');
      }
    } catch {
      if (canSend()) {
        this.log('warn', '签到帮助文档生成或发送失败');
        await this.reply(event, '教程文档暂时无法发送，请稍后重试「/签到 文档」或联系管理员检查文档组件。凭据只发私聊。');
      }
    } finally {
      this.controllers.delete(controller);
      if (document) {
        if (keepDocument) setTimeout(document.cleanup, 300000).unref();
        else document.cleanup();
      }
    }
  }
  receive(event) {
    const command = checkinCommand(event);
    if (command === null) return null;
    const config = this.store.config, user = String(event.user_id), group = event.message_type === 'group';
    if (this.closed || event.post_type !== 'message' || !['group', 'private'].includes(event.message_type) || !qq(event.self_id) || !qq(user)
      || String(event.self_id) === user || (config.botId && config.botId !== String(event.self_id)) || event.message_id == null
      || (group && (!qq(event.group_id) || !allowed(config, event.group_id)))) return { ignored: 'checkin_unauthorized' };
    const now = this.now();
    for (const [key, time] of this.seen) if (now - time > 600000) this.seen.delete(key);
    for (const [key, time] of this.cooldowns) if (now - time > 600000) this.cooldowns.delete(key);
    const id = `${event.self_id}:${event.message_type}:${event.group_id || ''}:${event.message_id}`;
    if (this.seen.has(id)) return { ignored: 'duplicate' };
    if (this.active.has(user) || this.active.size >= 2 || (this.cooldowns.has(user) && now - this.cooldowns.get(user) < 3000)) return { ignored: 'checkin_busy' };
    this.seen.set(id, now); this.cooldowns.set(user, now);
    if (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value);
    if (this.cooldowns.size > 1000) this.cooldowns.delete(this.cooldowns.keys().next().value);
    this.active.add(user);
    const job = this.handle(event, command).catch(() => this.log('warn', '签到指令处理或 QQ 回执失败'))
      .finally(() => { this.active.delete(user); this.jobs.delete(job); });
    this.jobs.add(job); return { accepted: true, plugin: 'checkin' };
  }
  async handle(event, command) {
    const user = String(event.user_id), group = event.message_type === 'group';
    const [action = '', name = ''] = command.split(/\s+/), member = this.state.members[user];
    if (action === '绑定' && group) return this.reply(event, '账号凭据请仅在私聊发送。先发送「/签到 开通」，再私聊「/签到 帮助」。');
    // Owners can delete their credentials even after the plugin/group/bot is disabled.
    if (action === '解绑' && !group) {
      const platform = platformId(name);
      if (!platform && name !== '全部') return this.reply(event, '请指定：森空岛、米游社、库街区或全部。');
      if (member) {
        if (name === '全部') delete this.state.members[user]; else delete member.accounts[platform];
        this.save();
      }
      return this.reply(event, '已解绑并删除保存的凭据。');
    }
    if (!this.store.config.enabled || !this.state.settings.enabled) return this.reply(event, '签到插件已暂停，请联系管理员开启。');
    if (command.length > 12500) return this.reply(event, '签到指令过长。');
    if (action === '帮助') return this.sendHelp(event);
    if (action === '文档') return this.sendGuide(event);
    if (action === '开通') {
      if (!group) return this.reply(event, '请先在已授权群内发送「/签到 开通」。');
      if (!member && Object.keys(this.state.members).length >= 500) return this.reply(event, '签到成员数量已达上限，请联系管理员。');
      this.state.members[user] = { ...(member || { auto: true, accounts: {} }), group: String(event.group_id) }; this.save();
      return this.reply(event, '已开通自己的签到账号入口。请加机器人好友并私聊「/签到 帮助」；绑定成功后默认每天自动签到。');
    }
    if (!member) return this.reply(event, '请先在已授权群发送「/签到 开通」，然后私聊绑定账号。');
    if (!await this.membership(user, member.group)) return this.reply(event, '暂时无法确认你仍在授权群内，请检查群白名单、群成员状态和 QQ 连接。');
    if (action === '绑定') {
      const platform = platformId(name), raw = command.replace(/^绑定\s+\S+\s*/, '');
      if (!platform || !raw || raw === command) return this.reply(event, '格式：/签到 绑定 森空岛 <token>（米游社使用 Cookie，库街区使用 token）。');
      if (!this.state.settings.platforms[platform]) return this.reply(event, '管理员已暂停该平台签到。');
      const controller = new AbortController(); this.controllers.add(controller);
      try {
        const credential = parseCredential(platform, raw);
        const verified = await this.adapters[platform].bind(credential, AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]));
        if (!this.enabled(member.group) || controller.signal.aborted) throw new CheckinError('cancelled');
        member.accounts[platform] = { credential: verified, needsLogin: false, last: null }; this.save();
        return this.reply(event, `${platforms[platform]}绑定成功。${member.auto ? `每日 ${this.state.settings.time}（北京时间）自动签到` : '自动签到已关闭'}。可发送「/签到」立即签到。`);
      } catch (error) { return this.reply(event, `绑定未完成：${resultText[errorKind(error)]}。格式示例见「/签到 帮助」和后台插件说明。`); }
      finally { this.controllers.delete(controller); }
    }
    if (action === '自动' && ['开', '关'].includes(name)) {
      member.auto = name === '开'; this.save(); return this.reply(event, `自己的自动签到已${member.auto ? '开启' : '关闭'}。`);
    }
    if (action === '状态') {
      const lines = Object.entries(member.accounts).map(([platform, account]) => `${platforms[platform]}：${account.needsLogin ? '需要重新绑定' : '已绑定'}${account.last ? `；${account.last.day}\n${account.last.items.map(resultLine).join('\n') || '任务开始，尚无完成结果'}` : ''}`);
      return this.reply(event, [`自动签到：${member.auto ? '开' : '关'}，北京时间 ${this.state.settings.time}`, ...lines.length ? lines : ['尚未绑定账号']].join('\n'));
    }
    if (!action) return this.reply(event, await this.runMember(user, false));
    return this.reply(event, help);
  }
  async runMember(user, automatic) {
    const member = this.state.members[user];
    if (!member || !this.enabled(member.group) || automatic && !member.auto) return '';
    const lines = [];
    for (const [platform, account] of Object.entries(member.accounts)) {
      if (!this.enabled(member.group)) break;
      if (!this.state.settings.platforms[platform]) { if (!automatic) lines.push(`${platforms[platform]}：管理员已暂停`); continue; }
      const now = this.now(), day = chinaTime(now).slice(0, 10), last = account.last;
      if (account.needsLogin) { if (!automatic) lines.push(`${platforms[platform]}：请重新绑定`); continue; }
      if (automatic && last?.day === day) continue;
      if (last?.day === day && last.items.length && last.items.every(item => ['success', 'already', 'missing'].includes(item.status))) {
        if (!automatic) lines.push(`${platforms[platform]}：今日已完成（保存结果）\n${last.items.map(resultLine).join('\n')}`); continue;
      }
      if (!automatic && last && now - last.at < 60000) { lines.push(`${platforms[platform]}：请在一分钟后重试`); continue; }
      // Persist before the external side effect: restart/duplicate events cannot repeat the daily run.
      account.last = { day, at: now, items: [] }; this.save();
      const controller = new AbortController(); this.controllers.add(controller);
      try {
        account.last.items = await this.adapters[platform].run(account.credential, AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]));
      } catch (error) { account.last.items = [{ label: '签到', status: errorKind(error) }]; }
      finally { this.controllers.delete(controller); }
      if (account.last.items.some(item => item.status === 'expired')) account.needsLogin = true;
      this.save();
      lines.push(`${platforms[platform]}：\n${account.last.items.map(resultLine).join('\n')}`);
      this.log('info', `${platforms[platform]}签到任务结束`);
    }
    return lines.length ? lines.join('\n\n') : automatic ? '' : '尚无可执行账号，请私聊绑定或检查平台开关。';
  }
  async tick() {
    if (this.scheduled || this.closed || !this.store.config.enabled || !this.state.settings.enabled
      || chinaTime(this.now()).slice(11, 16) < this.state.settings.time) return;
    this.scheduled = true;
    try {
      for (const [user, member] of Object.entries(this.state.members)) {
        if (this.closed || !this.store.config.enabled || !this.state.settings.enabled) break;
        if (!member.auto || !this.enabled(member.group) || this.active.has(user) || this.active.size >= 2) continue;
        const day = chinaTime(this.now()).slice(0, 10);
        if (!Object.entries(member.accounts).some(([p, a]) => this.state.settings.platforms[p] && !a.needsLogin && a.last?.day !== day)) continue;
        this.active.add(user);
        try {
          if (!await this.membership(user, member.group)) continue;
          const text = await this.runMember(user, true);
          if (text && this.enabled(member.group) && this.state.settings.notify) await this.reply({ message_type: 'private', user_id: user }, `每日签到结果\n${text}`);
        } catch { this.log('warn', '自动签到或私聊回执失败，请查看签到状态'); }
        finally { this.active.delete(user); }
      }
    } finally { this.scheduled = false; }
  }
  start() {
    if (this.timer || this.closed) return;
    const step = async () => {
      this.timer = null;
      try { await this.tick(); } catch { this.log('warn', '签到任务未完成'); }
      if (!this.closed) { this.timer = setTimeout(step, 60000); this.timer.unref(); }
    };
    this.timer = setTimeout(step, 1000); this.timer.unref();
  }
  cancel() { for (const controller of this.controllers) controller.abort(); this.documents.cancel(); this.helpImage.cancel(); }
  close() { this.closed = true; clearTimeout(this.timer); this.cancel(); }
}

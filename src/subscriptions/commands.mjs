import { readFileSync } from 'node:fs';
import { groupRule, privateAllowed } from '../bot.mjs';
import { messageSegments } from '../images.mjs';
import { DocumentGenerator, runDocumentWorker } from '../documents.mjs';
import { plainText, resolveSubscriptionSource, sourceTypes } from './feeds.mjs';
import { SubscriptionHelpImage } from './help-image.mjs';
import { games } from './games.mjs';

const qq = value => /^\d{5,20}$/.test(String(value));

export function subscriptionCommand(event) {
  const segments = messageSegments(event.message);
  if (segments.some(s => s.type === 'at' && ![String(event.self_id), ''].includes(String(s.data?.qq || '')) || !['text', 'at', 'reply'].includes(s.type))) return null;
  const text = segments.filter(s => s.type === 'text').map(s => s.data?.text || '').join('');
  return /^\s*[/#]?订阅(?=$|\s)([\s\S]*)$/.exec(text)?.[1].trim() ?? null;
}

export class SubscriptionCommands {
  constructor(dataDir, store, service, { onebot, log = () => {}, now = Date.now, resolveSource = resolveSubscriptionSource, documents, helpImage } = {}) {
    Object.assign(this, { store, service, onebot, log, now, resolveSource });
    this.documents = documents || new DocumentGenerator(dataDir, { worker: (input, options) => runDocumentWorker({ ...input, layout: 'subscription-guide' }, options) });
    this.helpImage = helpImage || new SubscriptionHelpImage();
    this.jobs = new Set(); this.active = new Set(); this.seen = new Map(); this.cooldowns = new Map(); this.controllers = new Set(); this.closed = false;
  }
  canSend(event) {
    return !this.closed && !this.service.closed && this.store.config.enabled && (event.message_type === 'group'
      ? groupRule(this.store.config, event.group_id).allowed : privateAllowed(this.store.config, event.user_id));
  }
  async reply(event, text) {
    if (!this.canSend(event)) return;
    const group = event.message_type === 'group';
    await this.onebot(group ? 'send_group_msg' : 'send_private_msg', {
      ...(group ? { group_id: event.group_id } : { user_id: event.user_id }),
      message: [...(group ? [{ type: 'at', data: { qq: String(event.user_id) } }] : []), { type: 'text', data: { text } }],
    });
  }
  receive(event) {
    const command = subscriptionCommand(event);
    if (command === null) return null;
    const group = event.message_type === 'group', config = this.store.config;
    if (event.post_type !== 'message' || !['group', 'private'].includes(event.message_type) || !qq(event.self_id) || !qq(event.user_id)
      || String(event.user_id) === String(event.self_id) || config.botId && String(event.self_id) !== config.botId || event.message_id == null
      || group && !qq(event.group_id) || !this.canSend(event)) return { ignored: 'subscription_unauthorized' };
    const now = this.now(), key = group ? `group:${event.group_id}` : `private:${event.user_id}`;
    const id = `${event.self_id}:${key}:${event.message_id}`;
    for (const map of [this.seen, this.cooldowns]) for (const [k, at] of map) if (now - at > 600000) map.delete(k);
    if (this.seen.has(id)) return { ignored: 'duplicate' };
    if (this.active.has(key) || this.active.size >= 2 || this.cooldowns.has(key) && now - this.cooldowns.get(key) < 3000) return { ignored: 'subscription_busy' };
    this.seen.set(id, now); this.cooldowns.set(key, now);
    if (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value);
    if (this.cooldowns.size > 1000) this.cooldowns.delete(this.cooldowns.keys().next().value);
    this.active.add(key);
    const job = this.handle(event, command).catch(() => this.log('warn', '订阅指令处理或 QQ 回执失败', { source: 'subscription' }))
      .finally(() => { this.active.delete(key); this.jobs.delete(job); });
    this.jobs.add(job); return { accepted: true, plugin: 'subscriptions' };
  }
  async sendHelp(event) {
    try {
      if (!this.canSend(event)) return;
      const file = await this.helpImage.create();
      if (!this.canSend(event)) return;
      const group = event.message_type === 'group';
      await this.onebot(group ? 'send_group_msg' : 'send_private_msg', {
        ...(group ? { group_id: event.group_id } : { user_id: event.user_id }),
        message: [{ type: 'image', data: { file } }],
      }, this.store.config, 120);
      this.log('info', `${group ? `群 ${event.group_id}` : `私聊 ${event.user_id}`} 请求订阅帮助图片`, {
        source: 'subscription',
        ...(group ? { groupId: String(event.group_id) } : {}),
        userId: String(event.user_id)
      });
    } catch {
      if (!this.canSend(event)) return;
      this.log('warn', '订阅帮助图片生成或发送失败', { source: 'subscription' });
      await this.reply(event, '订阅帮助图片暂时无法发送，请稍后重试；也可发送「/订阅 文档」获取详细教程。');
    }
  }
  async sendGuide(event) {
    let document, keep = false;
    try {
      document = await this.documents.create({ title: '订阅推送使用说明', content: readFileSync(new URL('./usage-guide.md', import.meta.url), 'utf8') }, ['pdf']);
      if (!this.canSend(event)) return;
      const file = document.files[0], group = event.message_type === 'group';
      try {
        await this.onebot(group ? 'upload_group_file' : 'upload_private_file', {
          ...(group ? { group_id: event.group_id } : { user_id: event.user_id }), file: file.uploadPath, name: file.name,
        }, this.store.config, 120);
        this.log('info', `${group ? `群 ${event.group_id}` : `私聊 ${event.user_id}`} 领取订阅使用文档 (PDF)`, {
          source: 'subscription',
          ...(group ? { groupId: String(event.group_id) } : {}),
          userId: String(event.user_id)
        });
      } catch {
        keep = true;
        await this.reply(event, '使用文档上传未确认成功，请检查群文件权限或空间；白名单成员也可加机器人好友后私聊「/订阅 文档」重试。');
      }
    } catch {
      this.log('warn', '订阅帮助文档生成失败', { source: 'subscription' });
      await this.reply(event, '使用文档暂时无法生成，请联系管理员检查文档组件；可发送「/订阅 帮助」查看帮助图片。');
    } finally {
      if (document) { if (keep) setTimeout(document.cleanup, 300000).unref(); else document.cleanup(); }
    }
  }
  async administrator(event) {
    try {
      const member = await this.onebot('get_group_member_info', { group_id: event.group_id, user_id: event.user_id, no_cache: true });
      return this.canSend(event) && String(member?.group_id) === String(event.group_id) && String(member?.user_id) === String(event.user_id) && ['owner', 'admin'].includes(member?.role);
    } catch { return false; }
  }
  async handle(event, command) {
    if (command.length > 4096) return this.reply(event, '订阅指令过长，请只发送一个主页链接。');
    if (!command || command === '帮助') return this.sendHelp(event);
    if (command === '文档') return this.sendGuide(event);
    if (command === '游戏') return this.reply(event, `支持的游戏：\n${games.map(game => `• ${game.name}`).join('\n')}\n\n群主或管理员在目标群发送「/订阅 游戏 游戏名」。例如「/订阅 游戏 zzz」「/订阅 游戏 终末地」。推送活动、版本更新和前瞻直播资讯，首次只记录已有内容。`);
    if (event.message_type !== 'group') return this.reply(event, '添加、查看或取消订阅请在已授权群操作。私聊可发送「/订阅 帮助」看图，或「/订阅 文档」获取详细教程。');
    const group = String(event.group_id), entries = () => this.service.state.entries.filter(e => e.groups.includes(group));
    if (/^列表(?:\s+\d+)?$/.test(command)) {
      const rows = entries(), pages = Math.max(1, Math.ceil(rows.length / 10)), page = Number(command.split(/\s+/)[1] || 1);
      if (!Number.isSafeInteger(page) || page < 1 || page > pages) return this.reply(event, `页码应为 1–${pages}，例如「/订阅 列表 1」。`);
      const statuses = new Map(this.service.status().entries.map(e => [e.id, e]));
      const text = rows.slice((page - 1) * 10, page * 10).map(e => {
        const priority = statuses.get(e.id);
        const state = !e.enabled ? '已暂停' : priority.suppressedGroups.includes(group) ? '同名跨平台绑定，本群优先抖音'
          : e.lastError ? '读取或发送失败，请管理员检查后台' : priority.fallbackGroups?.includes(group) ? '同名抖音不可用或状态过旧，本群暂用 B 站推送' : e.lastWarning ? '部分消息源不可用，请管理员检查后台' : priority.preferredGroups.includes(group) ? '本群同名跨平台优先来源' : e.initializedAt ? '已记录当前内容，等待更新' : '等待首次检查';
        return `${e.id.slice(0, 8)} · ${plainText(e.lastTitle || e.name, 50)}\n${sourceTypes[e.type]} · ${state}`;
      }).join('\n\n');
      return this.reply(event, `本群订阅 ${rows.length} 条（第 ${page}/${pages} 页）${this.service.state.settings.enabled ? '' : ' · 插件已暂停'}\n\n${text || '还没有订阅，群管理员可发送「/订阅 博主主页链接」。'}${rows.length ? '\n\n取消：/订阅 取消订阅 上面的8位编号' : ''}${pages > 1 ? '\n翻页：/订阅 列表 页码' : ''}`);
    }
    if (!await this.administrator(event)) return this.reply(event, '新增和取消订阅需要群主或管理员权限；若你是管理员，请检查 QQ 连接后重试。成员可使用「/订阅 列表」和「/订阅 帮助」。');
    if (!this.canSend(event)) return;
    const cancel = /^(?:取消订阅|取消)\s+(.+)$/.exec(command);
    if (cancel) {
      const key = cancel[1].trim().toLowerCase(), found = entries().filter(e => /^[a-f0-9-]{8,36}$/.test(key) && e.id.startsWith(key));
      if (found.length !== 1) return this.reply(event, '没有找到对应的本群订阅，请发送「/订阅 列表」复制8位编号。');
      try { this.service.unsubscribeGroup(found[0].id, group); }
      catch { return this.reply(event, '取消订阅未完成，请稍后重试，或联系后台管理员检查订阅数据。'); }
      return this.reply(event, `已取消订阅：${plainText(found[0].lastTitle || found[0].name, 80)}。其他群不受影响。`);
    }
    if (!this.service.state.settings.enabled) return this.reply(event, '订阅推送插件已暂停，请后台管理员在「插件 → 订阅推送」开启后再添加。帮助和列表仍可使用。');
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const source = await this.resolveSource(command.replace(/^添加\s+/, ''), { signal: controller.signal });
      if (!this.canSend(event) || controller.signal.aborted || !this.service.state.settings.enabled) return;
      const { entry, existing } = this.service.subscribeGroup(source, group);
      if (entry.type === 'game') return this.reply(event, `${existing ? '本群已订阅' : '已添加本群订阅'}：${plainText(entry.name, 80)}\n编号：${entry.id.slice(0, 8)}\n${entry.enabled ? '按后台间隔检查官方活动、版本更新和前瞻直播资讯。各来源首次读取只记录已有内容，新消息只发到订阅它的群。' : '这条来源已在后台暂停，请联系后台管理员恢复。'}\n前瞻直播补充使用 RSSHub 官方 B 站动态；来源异常会显示在后台。`);
      await this.reply(event, `${existing ? '本群已订阅' : '已添加本群订阅'}：${plainText(entry.lastTitle || entry.name, 80)}\n编号：${entry.id.slice(0, 8)}\n${entry.enabled ? '按后台间隔检查，首次读取只记录现有内容，之后推送图文与原文链接，不发送视频。' : '这条来源已在后台暂停，请联系后台管理员恢复。'}${entry.type === 'bilibili' ? '\n同时订阅投稿和动态，需使用可用的 RSSHub。' : entry.type === 'douyin' ? '\n优先使用后台抖音登录态读取主页；读取失败时请在后台检查登录与网络。' : ''}`);
    } catch (error) {
      if (controller.signal.aborted || !this.canSend(event)) return;
      const safe = /^(?:请填写|请发送|一次只能|订阅指令|分享链接|订阅类型|订阅地址|最多保存|请选择)/.test(error.message || '');
      await this.reply(event, safe ? error.message : '暂时无法添加订阅。请复制完整的博主主页链接后重试，或发送「/订阅 帮助」查看示例；订阅数量与目标群上限可在后台检查。');
    } finally { this.controllers.delete(controller); }
  }
  close() { this.closed = true; for (const controller of this.controllers) controller.abort(); this.documents.close(); this.helpImage.cancel(); }
}

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { groupRule, privateAllowed } from '../bot.mjs';
import { DocumentGenerator, runDocumentWorker } from '../documents.mjs';
import { messageSegments } from '../images.mjs';
import { TavernHelpImage } from './help-image.mjs';
import { PromptAssembler } from './prompt-assembler.mjs';
import { EMOTION_METRICS, matchEmotionTriggers, emotionScopeKey } from './emotions.mjs';

const qq = value => /^\d{5,20}$/.test(String(value));

export function parseTavernCommand(event) {
  const segments = messageSegments(event.message);
  if (segments.some(s => s.type === 'at' && ![String(event.self_id), ''].includes(String(s.data?.qq || '')) || !['text', 'at', 'reply'].includes(s.type))) return null;
  const text = segments.filter(s => s.type === 'text').map(s => s.data?.text || '').join('').trim();

  // 匹配 /酒馆, /tavern 快捷指令（必须携带 / 或 # 前缀，避免误拦截普通群聊）
  const tavernMatch = /^[/#](?:酒馆|tavern)(?:\s+([\s\S]*))?$/i.exec(text);
  if (tavernMatch) {
    const arg = (tavernMatch[1] || '').trim();
    if (!arg || /^(?:help|帮助)$/i.test(arg)) return { type: 'help' };
    if (/^(?:doc|文档)$/i.test(arg)) return { type: 'doc' };
    if (/^(?:undo|撤回)$/i.test(arg)) return { type: 'undo' };
    if (/^(?:retry|重试)$/i.test(arg)) return { type: 'retry' };
    if (/^(?:状态|情绪|档案|status|emotion)$/i.test(arg)) return { type: 'status' };
    if (/^(?:羁绊榜|好感榜|leaderboard|rank)$/i.test(arg)) return { type: 'leaderboard' };
    const subFeed = /^(?:投喂|feed)(?:\s+([\s\S]+))?$/i.exec(arg);
    if (subFeed) return { type: 'feed', item: (subFeed[1] || '').trim() };
    const subTheater = /^(?:剧场|小剧场|theater)(?:\s+([\s\S]+))?$/i.exec(arg);
    if (subTheater) return { type: 'theater', arg: (subTheater[1] || '').trim() };
    const subOoc = /^ooc(?:\s+([\s\S]*))?$/i.exec(arg);
    if (subOoc) {
      const instruction = (subOoc[1] || '').trim();
      if (!instruction || /^(?:clear|清除|off|关闭)$/i.test(instruction)) return { type: 'oocClear' };
      return { type: 'ooc', instruction };
    }
    return { type: 'char', arg };
  }

  // 匹配 /char, /角色, /undo, /撤回, /retry, /重试, /ooc, /情绪, /羁绊榜, /投喂, /剧场
  const charMatch = /^[/#](?:char|角色)(?:\s+([\s\S]*))?$/i.exec(text);
  if (charMatch) {
    return { type: 'char', arg: (charMatch[1] || '').trim() };
  }
  if (/^[/#](?:undo|撤回)$/i.test(text)) {
    return { type: 'undo' };
  }
  if (/^[/#](?:retry|重试)$/i.test(text)) {
    return { type: 'retry' };
  }
  const oocMatch = /^[/#]ooc(?:\s+([\s\S]*))?$/i.exec(text);
  if (oocMatch) {
    const instruction = (oocMatch[1] || '').trim();
    if (!instruction) return { type: 'oocHelp' };
    if (/^(?:clear|清除|off|关闭)$/i.test(instruction)) return { type: 'oocClear' };
    return { type: 'ooc', instruction };
  }
  if (/^[/#](?:情绪|档案|emotion)$/i.test(text)) {
    return { type: 'status' };
  }
  if (/^[/#](?:羁绊榜|好感榜)$/i.test(text)) {
    return { type: 'leaderboard' };
  }
  const feedMatch = /^[/#](?:投喂|feed)(?:\s+([\s\S]+))?$/i.exec(text);
  if (feedMatch) {
    return { type: 'feed', item: (feedMatch[1] || '').trim() };
  }
  const theaterMatch = /^[/#](?:剧场|小剧场|theater)(?:\s+([\s\S]*))?$/i.exec(text);
  if (theaterMatch) {
    return { type: 'theater', arg: (theaterMatch[1] || '').trim() };
  }
  return null;
}

export class TavernCommands {
  constructor(tavernManager, conversations, { onebot, log = () => {}, store, dataDir, documents, helpImage, askModel = null, onRetry = null, renderEmotionCard = null } = {}) {
    this.manager = tavernManager;
    this.conversations = conversations;
    this.onebot = onebot;
    this.log = log;
    this.store = store;
    const docDir = dataDir || tavernManager?.dataDir || tmpdir();
    this.documents = documents || new DocumentGenerator(docDir, {
      worker: (input, options) => runDocumentWorker({ ...input, layout: 'tavern-guide' }, options)
    });
    this.helpImage = helpImage || new TavernHelpImage();
    this.askModel = askModel;
    this.onRetry = onRetry;
    this.renderEmotionCard = renderEmotionCard;
    this.stickerTracker = new Map();
    this.active = new Set();
    this.jobs = new Set();
    this.seen = new Map();
    this.cooldowns = new Map();
    this.closed = false;
  }

  canSend(event, { requireTavernEnabled = true } = {}) {
    if (this.closed || !this.store.config.enabled) return false;
    if (requireTavernEnabled && this.manager?.state?.enabled === false) return false;
    return event.message_type === 'group'
      ? groupRule(this.store.config, event.group_id).allowed
      : privateAllowed(this.store.config, event.user_id);
  }

  async reply(event, text, imageBuffer = null) {
    if (!this.canSend(event, { requireTavernEnabled: false })) return;
    const isGroup = event.message_type === 'group';
    const message = [];
    if (isGroup) {
      message.push({ type: 'at', data: { qq: String(event.user_id) } });
      message.push({ type: 'text', data: { text: ' ' } });
    }
    if (imageBuffer && Buffer.isBuffer(imageBuffer)) {
      message.push({ type: 'image', data: { file: `base64://${imageBuffer.toString('base64')}` } });
    }
    if (text) {
      message.push({ type: 'text', data: { text } });
    }

    await this.onebot(isGroup ? 'send_group_msg' : 'send_private_msg', {
      ...(isGroup ? { group_id: event.group_id } : { user_id: event.user_id }),
      message
    });
  }

  receive(event) {
    const cmd = parseTavernCommand(event);
    if (!cmd) return null;

    const isGroup = event.message_type === 'group';
    const config = this.store.config;
    const tavernEnabled = this.manager?.state?.enabled !== false;
    // 酒馆关闭时不接管通用/模糊指令（如 /undo、/retry、/ooc），仅针对显式 /酒馆 或 /char 给出关闭提示。
    if (!tavernEnabled && !['help', 'doc', 'char'].includes(cmd.type)) {
      return null;
    }

    if (event.post_type !== 'message' || !['group', 'private'].includes(event.message_type) || !qq(event.self_id) || !qq(event.user_id)
      || String(event.user_id) === String(event.self_id) || config.botId && String(event.self_id) !== config.botId || event.message_id == null
      || isGroup && !qq(event.group_id) || !this.canSend(event, { requireTavernEnabled: false })) {
      return { ignored: 'tavern_unauthorized' };
    }

    const now = Date.now();
    const key = isGroup ? `group:${event.group_id}` : `private:${event.user_id}`;
    const id = `${event.self_id}:${key}:${event.message_id}`;
    for (const [k, at] of this.seen) if (now - at > 600000) this.seen.delete(k);
    if (this.seen.has(id)) return { ignored: 'duplicate' };
    this.seen.set(id, now);
    if (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value);

    const job = (!tavernEnabled
      ? this.reply(event, '酒馆角色扮演模式当前未启用，请联系管理员在管理后台开启。')
      : this.handle(event, cmd))
      .catch(error => {
        this.log('warn', `酒馆指令处理异常: ${error.message}`, { source: 'tavern' });
      })
      .finally(() => this.jobs.delete(job));
    this.jobs.add(job);

    return { accepted: true, plugin: 'tavern' };
  }

  async sendHelp(event) {
    try {
      if (!this.canSend(event)) return;
      const file = await this.helpImage.create();
      if (!this.canSend(event)) return;
      const group = event.message_type === 'group';
      await this.onebot(group ? 'send_group_msg' : 'send_private_msg', {
        ...(group ? { group_id: event.group_id } : { user_id: event.user_id }),
        message: [{ type: 'image', data: { file } }]
      }, this.store.config, 120);
      this.log('info', `${group ? `群 ${event.group_id}` : `私聊 ${event.user_id}`} 请求酒馆帮助图片`, {
        source: 'tavern',
        ...(group ? { groupId: String(event.group_id) } : {}),
        userId: String(event.user_id)
      });
    } catch {
      if (!this.canSend(event)) return;
      this.log('warn', '酒馆帮助图片生成或发送失败', { source: 'tavern' });
      await this.reply(event, '酒馆帮助图片暂时无法发送，请稍后重试；也可发送「/酒馆 文档」获取详细教程。');
    }
  }

  async sendGuide(event) {
    let document;
    let keep = false;
    try {
      document = await this.documents.create(
        { title: '酒馆角色扮演使用说明', content: readFileSync(new URL('./usage-guide.md', import.meta.url), 'utf8') },
        ['pdf']
      );
      if (!this.canSend(event)) return;
      const file = document.files[0];
      const group = event.message_type === 'group';
      try {
        await this.onebot(group ? 'upload_group_file' : 'upload_private_file', {
          ...(group ? { group_id: event.group_id } : { user_id: event.user_id }),
          file: file.uploadPath,
          name: file.name
        }, this.store.config, 120);
        this.log('info', `${group ? `群 ${event.group_id}` : `私聊 ${event.user_id}`} 领取酒馆使用文档 (PDF)`, {
          source: 'tavern',
          ...(group ? { groupId: String(event.group_id) } : {}),
          userId: String(event.user_id)
        });
      } catch {
        keep = true;
        await this.reply(event, '使用文档上传未确认成功，请检查群文件权限或空间；白名单成员也可加机器人好友后私聊「/酒馆 文档」重试。');
      }
    } catch {
      this.log('warn', '酒馆使用文档生成失败', { source: 'tavern' });
      await this.reply(event, '使用文档暂时无法生成，请联系管理员检查文档组件；可发送「/酒馆 帮助」查看帮助图片。');
    } finally {
      if (document) {
        if (keep) setTimeout(document.cleanup, 300000).unref();
        else document.cleanup();
      }
    }
  }

  async handle(event, cmd) {
    const isGroup = event.message_type === 'group';
    const scope = {
      isPrivate: !isGroup,
      userId: String(event.user_id),
      groupId: isGroup ? String(event.group_id) : undefined
    };
    const scopeMode = this.manager?.state?.emotionScopeMode || 'group';
    const userName = String(event.sender?.card || event.sender?.nickname || '群友');

    if (cmd.type === 'help') {
      return this.sendHelp(event);
    }

    if (cmd.type === 'doc') {
      return this.sendGuide(event);
    }

    if (cmd.type === 'char') {
      const parts = cmd.arg.split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      if (sub === 'help' || sub === '帮助') return this.sendHelp(event);
      if (sub === 'doc' || sub === '文档') return this.sendGuide(event);
      if (sub === 'status' || sub === 'emotion' || sub === '状态' || sub === '情绪' || sub === '档案') {
        return this.handle(event, { type: 'status' });
      }

      // 1. /char list
      if (!sub || sub === 'list' || sub === '列表') {
        const list = this.manager.listCharacters();
        if (!list.length) {
          return this.reply(event, '酒馆角色库为空，请管理员先在后台上传角色卡。');
        }
        const active = this.manager.getActiveCharacter(scope);
        const text = ['【酒馆角色列表】', ...list.map((c, i) => `${i + 1}. ${c.name}${active?.id === c.id ? ' [当前使用中]' : ''} (ID: ${c.id.slice(0, 8)})`)].join('\n')
          + '\n\n提示：发送「/char switch 角色名」即可切换角色；支持「/情绪」「/羁绊榜」「/投喂 物品」「/剧场 角色A 角色B」。';
        return this.reply(event, text);
      }

      // 2. /char info
      if (sub === 'info' || sub === '信息') {
        const active = this.manager.getActiveCharacter(scope);
        if (!active) {
          return this.reply(event, '当前未绑定任何角色卡。');
        }
        const avatar = this.manager.getAvatar(active.id);
        const infoText = `【当前角色: ${active.name}】\n`
          + (active.description ? `简介: ${active.description.slice(0, 200)}\n` : '')
          + (active.personality ? `性格: ${active.personality.slice(0, 100)}\n` : '')
          + (active.scenario ? `情景: ${active.scenario.slice(0, 100)}\n` : '');
        return this.reply(event, infoText.trim(), avatar);
      }

      // 3. /char reset
      if (sub === 'reset' || sub === '重置') {
        const session = this.conversations.findSession(event.self_id, isGroup ? event.group_id : 'private', event.user_id);
        if (session) {
          this.conversations.reset(session.id);
        }
        const active = this.manager.getActiveCharacter(scope);
        if (active) this.manager.emotions.reset(active.id, scope, scopeMode);
        this.manager.clearPendingOoc(scope);
        let greeting = '已重置对话历史与情绪状态。';
        let avatar = null;
        if (active) {
          avatar = this.manager.getAvatar(active.id);
          greeting = PromptAssembler.replaceMacros(active.first_mes || `（${active.name} 回到了最初的状态）`, {
            char: active.name,
            user: userName
          });
        }
        return this.reply(event, greeting, avatar);
      }

      // 4. /char switch <name|id>
      if (sub === 'switch' || sub === '切换') {
        const target = parts.slice(1).join(' ').trim();
        if (!target) {
          return this.reply(event, '请指定要切换的角色名或ID，如：/char switch 芙莉莲');
        }
        const all = this.manager.listCharacters();
        const found = all.find(c => c.name.toLowerCase() === target.toLowerCase() || c.id.startsWith(target.toLowerCase()));
        if (!found) {
          return this.reply(event, `未找到名为「${target}」的角色卡，发送「/char list」可查看列表。`);
        }
        this.manager.bindCharacter(scope, found.id);

        // 重置发指令者的会话与情绪，且通过 personaKey 为同群成员隔离旧角色历史
        const session = this.conversations.findSession(event.self_id, isGroup ? event.group_id : 'private', event.user_id);
        if (session) {
          this.conversations.reset(session.id);
        }
        this.manager.emotions.reset(found.id, scope, scopeMode);
        this.manager.clearPendingOoc(scope);

        const fullCard = this.manager.getCharacter(found.id);
        const avatar = this.manager.getAvatar(found.id);
        const greeting = fullCard.first_mes
          ? PromptAssembler.replaceMacros(fullCard.first_mes, { char: fullCard.name, user: userName })
          : `已成功切换为角色「${fullCard.name}」！`;

        return this.reply(event, greeting, avatar);
      }

      return this.reply(event, '未知的酒馆指令。常用指令：\n/酒馆 帮助 - 查看使用说明图片\n/酒馆 文档 - 获取 PDF 使用文档\n/酒馆 列表 - 查看角色列表\n/酒馆 切换 <角色名> - 切换角色\n/酒馆 信息 - 查看当前角色\n/情绪 - 查看情绪羁绊档案\n/羁绊榜 - 查看群内好感度排行\n/投喂 <礼物> - 给角色投喂礼物\n/剧场 <角色A> <角色B> [主题] - 跨角色对戏\n/ooc <指令> - 设置下轮场外导演提示\n/酒馆 重置 - 重置记忆与情绪');
    }

    if (cmd.type === 'status') {
      const active = this.manager.getActiveCharacter(scope);
      if (!active) return this.reply(event, '当前未绑定任何角色卡。');
      const e = this.manager.emotions.get(active.id, scope, scopeMode);
      const bars = EMOTION_METRICS.map(m => {
        const val = e[m.key] || 0;
        const len = Math.floor(val / 10);
        return `${m.label}: ${'█'.repeat(len)}${'░'.repeat(10 - len)} ${val}`;
      }).join('\n');
      const summary = `【${active.name} · 情绪状态】\n关系阶段: ${e.stage}\n\n${bars}\n\n当前心境: ${e.mood}\n最近波动: ${e.reason}`;
      let cardBuf = null;
      if (typeof this.renderEmotionCard === 'function') {
        try {
          cardBuf = await this.renderEmotionCard({
            character: active,
            emotion: e,
            avatarBuffer: this.manager.getAvatar(active.id),
            scopeLabel: !isGroup ? `私聊 · ${userName}` : scopeMode === 'group-member' ? `${userName} 专属羁绊` : '群内共享羁绊'
          });
        } catch {}
      }
      return this.reply(event, summary, cardBuf);
    }

    if (cmd.type === 'leaderboard') {
      const active = this.manager.getActiveCharacter(scope);
      if (!active) return this.reply(event, '当前未绑定任何角色卡。');
      if (!isGroup) {
        const e = this.manager.emotions.get(active.id, scope, scopeMode);
        return this.reply(event, `私聊中「${active.name}」对你的好感度为 ${e.affection}（${e.stage} · ${e.mood}）。`);
      }
      const rows = this.manager.emotions.leaderboard(active.id, String(event.group_id), 10);
      if (!rows.length) {
        return this.reply(event, `群内暂时还没有和「${active.name}」互动过的情绪记录，快去 @机器人 聊聊吧！`);
      }
      if (rows.length === 1 && rows[0].isGroupShared) {
        const only = rows[0];
        return this.reply(event, `当前「${active.name}」使用【全群共享好感度】模式：\n好感度 ${only.affection} · 阶段：${only.stage} · 心境：${only.mood}\n（管理员可在后台酒馆页切换为「群内个人独立好感度」开启个人羁绊榜）`);
      }
      const medals = ['🥇', '🥈', '🥉'];
      const lines = rows.map((row, idx) => `${medals[idx] || `${idx + 1}.`} QQ ${row.userId} · 好感 ${row.affection}（${row.stage} · ${row.mood}）`);
      return this.reply(event, `【${active.name} · 本群羁绊好感度榜】\n${lines.join('\n')}`);
    }

    if (cmd.type === 'feed') {
      const active = this.manager.getActiveCharacter(scope);
      if (!active) return this.reply(event, '当前未绑定任何角色卡。');
      const item = String(cmd.item || '').trim().slice(0, 60);
      if (!item) return this.reply(event, '请写上要投喂的物品，例如：/投喂 草莓大福');
      const e = this.manager.emotions.get(active.id, scope, scopeMode);
      let replyText = '';
      let delta = { affection: 2, joy: 2, trust: 1, mood: '开心', reason: `${userName} 投喂了「${item}」` };
      if (typeof this.askModel === 'function') {
        try {
          const messages = PromptAssembler.assembleFeedMessages({ card: active, userName, item, emotionState: e });
          const raw = await this.askModel({ event, scope, prompt: `/投喂 ${item}`, messages, purpose: 'tavern_feed' });
          const parsed = PromptAssembler.extractEmotionUpdate(raw);
          replyText = parsed.text;
          if (parsed.update) delta = parsed.update;
        } catch {
          // 降级本地温柔反馈
        }
      }
      if (!replyText) {
        replyText = `（${active.name} 接过「${item}」端详了一下，眼睛微微亮了起来）\n「嗯……是特意带给我的吗？谢谢 ${userName}，我很喜欢！」`;
      }
      const nextEmotion = this.manager.emotions.apply(active.id, scope, delta, scopeMode);
      let stickerBuf = null;
      const triggers = this.manager.getEmotionTriggers(active.id);
      if (triggers.length) {
        const sKey = `${active.id}:${emotionScopeKey(scope, scopeMode)}`;
        const tracker = this.stickerTracker.get(sKey) || { turn: 0, lastSent: new Map() };
        tracker.turn += 1;
        this.stickerTracker.set(sKey, tracker);
        if (this.stickerTracker.size > 300) this.stickerTracker.delete(this.stickerTracker.keys().next().value);
        const hitRule = matchEmotionTriggers(nextEmotion, triggers).find(rule => {
          if (!rule.sticker?.filename) return false;
          const prev = tracker.lastSent.get(rule.id);
          return prev === undefined || (tracker.turn - prev) >= (rule.stickerCooldown || 3);
        });
        if (hitRule) {
          stickerBuf = this.manager.readTriggerSticker(hitRule.sticker.filename);
          if (stickerBuf) tracker.lastSent.set(hitRule.id, tracker.turn);
        }
      }
      const summary = `${replyText}\n\n[好感度 ${nextEmotion.affection} · ${nextEmotion.stage} · 心境: ${nextEmotion.mood}]`;
      return this.reply(event, summary, stickerBuf);
    }

    if (cmd.type === 'theater') {
      const all = this.manager.listCharacters();
      if (all.length < 2) {
        return this.reply(event, '角色库至少需要 2 张角色卡才能开启「酒馆小剧场」对戏模式。');
      }
      const tokens = String(cmd.arg || '').trim().split(/\s+/).filter(Boolean);
      const findChar = q => all.find(c => c.name.toLowerCase() === q.toLowerCase() || c.id.toLowerCase().startsWith(q.toLowerCase()) || c.name.toLowerCase().includes(q.toLowerCase()));
      let cardA = tokens[0] ? findChar(tokens[0]) : null;
      let cardB = tokens[1] ? findChar(tokens[1]) : null;
      let topic = tokens.slice(2).join(' ').trim();
      if (!cardA || !cardB || cardA.id === cardB.id) {
        cardA = this.manager.getActiveCharacter(scope) || all[0];
        cardB = all.find(c => c.id !== cardA.id);
        topic = tokens.join(' ').trim();
      }
      const fullA = this.manager.getCharacter(cardA.id);
      const fullB = this.manager.getCharacter(cardB.id);
      const finalTopic = (topic || '偶遇在深夜食堂').slice(0, 80);
      if (typeof this.askModel !== 'function') {
        return this.reply(event, `【酒馆小剧场 · ${fullA.name} × ${fullB.name}】\n主题：${finalTopic}\n（当前未连接对话模型，请在配置模型密钥后体验 AI 飙戏）`);
      }
      try {
        const messages = PromptAssembler.assembleTheaterMessages({ cardA: fullA, cardB: fullB, topic: finalTopic });
        const script = await this.askModel({ event, scope, prompt: `/剧场 ${fullA.name} ${fullB.name} ${finalTopic}`, messages, purpose: 'tavern_theater' });
        return this.reply(event, `【酒馆小剧场 · ${fullA.name} × ${fullB.name}】\n主题：${finalTopic}\n\n${String(script || '').trim()}`);
      } catch (error) {
        return this.reply(event, `小剧场开演失败：${error.message}`);
      }
    }

    if (cmd.type === 'undo') {
      const session = this.conversations.findSession(event.self_id, isGroup ? event.group_id : 'private', event.user_id);
      if (!session) {
        return this.reply(event, '当前暂无可以撤回的对话记录。');
      }
      const undone = this.conversations.undoTurn(session.id);
      if (!undone) {
        return this.reply(event, '当前未找到可撤回的发言轮次。');
      }
      const active = this.manager.getActiveCharacter(scope);
      if (active) this.manager.emotions.undo(active.id, scope, scopeMode);
      return this.reply(event, `已撤回上一轮回复。\n（原发言：${undone.reply.slice(0, 30)}...）`);
    }

    if (cmd.type === 'retry') {
      const session = this.conversations.findSession(event.self_id, isGroup ? event.group_id : 'private', event.user_id);
      if (!session) {
        return this.reply(event, '没有可重新生成的对话。');
      }
      const last = this.conversations.lastTurn(session.id);
      if (!last) {
        return this.reply(event, '没有找到上一轮的提问内容。');
      }
      this.conversations.undoTurn(session.id);
      const active = this.manager.getActiveCharacter(scope);
      if (active) this.manager.emotions.undo(active.id, scope, scopeMode);
      if (typeof this.onRetry === 'function') {
        const cleanPrompt = String(last.prompt || '').replace(/\n\[(?:引用|附带) \d+ 张图片；原图不保存\]|\n\[B 站视频[\s\S]*$/g, '').trim();
        if (cleanPrompt) {
          const queued = this.onRetry(event, cleanPrompt);
          if (queued?.accepted) {
            return this.reply(event, `已回滚上一轮回复并重新排队生成：「${cleanPrompt.slice(0, 40)}」`);
          }
        }
      }
      return this.reply(event, `已重置上一轮回复与情绪状态。上一轮提问是：「${last.prompt.slice(0, 50)}」，请再次 @机器人 即可重新生成。`);
    }

    if (cmd.type === 'ooc') {
      const saved = this.manager.setPendingOoc(scope, cmd.instruction);
      return this.reply(event, `已记录下一轮场外指导要求：\n「${saved}」\n将在接下来你与角色的对话中作为导演指令生效（生效后自动清除，发 /ooc 清除 可取消）。`);
    }

    if (cmd.type === 'oocClear') {
      const cleared = this.manager.clearPendingOoc(scope);
      return this.reply(event, cleared ? '已清除当前待生效的场外导演指令。' : '当前没有待生效的场外导演指令。');
    }

    if (cmd.type === 'oocHelp') {
      const current = this.manager.getPendingOoc(scope);
      return this.reply(event, current
        ? `当前待生效的场外指导为：「${current}」\n发送「/ooc 新指令」可替换，发送「/ooc 清除」可取消。`
        : '请提供场外指导内容，例如：/ooc 请表现得更害羞一点\n发送「/ooc 清除」可取消已设置的指导。');
    }
  }

  close() {
    this.closed = true;
  }
}

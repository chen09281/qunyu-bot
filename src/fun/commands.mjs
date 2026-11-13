import { groupRule, privateAllowed } from '../bot.mjs';
import { messageSegments, originalImageUrl, resolveMessageImages } from '../images.mjs';
import {
  parseDiceCommand,
  rollDiceExpr,
  rollSkillCheck,
  UndercoverManager,
  SoupManager
} from './games.mjs';

const qq = value => /^\d{5,20}$/.test(String(value));

function extractPlainText(segments) {
  return segments.filter(s => s.type === 'text').map(s => String(s.data?.text || '')).join('').trim();
}

function extractFirstMentionedQq(segments, selfId) {
  for (const s of segments) {
    if (s.type === 'at') {
      const target = String(s.data?.qq || '').trim();
      if (/^\d{5,20}$/.test(target) && target !== String(selfId)) return target;
    }
  }
  return '';
}

function extractQuotedText(quoted) {
  const segs = messageSegments(quoted?.message);
  return segs.map(s => {
    if (s.type === 'text') return String(s.data?.text || '');
    if (s.type === 'image') return '[图片]';
    return '';
  }).join('').trim();
}

export function parseFunCommand(event) {
  const segments = messageSegments(event.message);
  if (segments.some(s => !['text', 'at', 'reply', 'image'].includes(s.type))) return null;
  const text = extractPlainText(segments);
  if (!text) return null;

  // 1. TRPG 跑团骰子 (.r / .ra / .rh)
  const dice = parseDiceCommand(text);
  if (dice) return { type: 'dice', dice };

  // 2. 斜杠 / 井号指令
  const m = /^[/#](玩法|娱乐|今日运势|运势|抽签|喜报|悲报|举牌|加字|存语录|语录|删语录|群日报|今日总结|十连|抽卡|欧非榜|海龟汤|汤|问|卧底|加入|开始|投票)(?:$|\s)([\s\S]*)$/.exec(text);
  if (!m) return null;
  const cmd = m[1];
  const arg = String(m[2] || '').trim();
  const replySeg = segments.find(s => s.type === 'reply');
  const mentionedQq = extractFirstMentionedQq(segments, event.self_id);

  if (cmd === '玩法' || cmd === '娱乐') return { type: 'help', arg };
  if (cmd === '今日运势' || cmd === '运势' || cmd === '抽签') return { type: 'fortune' };
  if (cmd === '喜报') return { type: 'meme', mode: 'xi_bao', arg };
  if (cmd === '悲报') return { type: 'meme', mode: 'bei_bao', arg };
  if (cmd === '举牌') return { type: 'meme', mode: 'signboard', arg };
  if (cmd === '加字') return { type: 'meme', mode: 'caption', arg };
  if (cmd === '存语录') return { type: 'quote_add', arg, replyId: replySeg?.data?.id || '' };
  if (cmd === '语录') return { type: 'quote_get', arg };
  if (cmd === '删语录') return { type: 'quote_del', arg };
  if (cmd === '群日报' || cmd === '今日总结') return { type: 'daily_report', arg };
  if (cmd === '十连' || cmd === '抽卡') return { type: 'gacha', arg };
  if (cmd === '欧非榜') return { type: 'gacha_rank' };
  if (cmd === '海龟汤') return { type: 'soup', arg };
  if (cmd === '汤' || cmd === '问') return { type: 'soup_ask', arg };
  if (cmd === '卧底') return { type: 'undercover', arg };
  if (cmd === '加入') return { type: 'undercover', arg: '加入' };
  if (cmd === '开始') return { type: 'undercover', arg: '开始' };
  if (cmd === '投票') return { type: 'undercover_vote', arg, mentionedQq };
  return null;
}

export function funHelpText() {
  return [
    '🎮 群屿娱乐工坊指南：',
    '【运势与语录】',
    '· /今日运势（或 /抽签）：生成今日运势签卡',
    '· /存语录 [内容]（或回复他人消息发 /存语录）：收录群名场面',
    '· /语录 [关键词]：随机抽一张群友语录海报',
    '· /群日报：生成今日群聊龙王/夜猫/热词日报卡片',
    '【梗图与十连】',
    '· /喜报 <文案> · /悲报 <文案> · /举牌 <文案>',
    '· 回复或附带图片发 /加字 上句|下句：制作梗图',
    '· /十连 [鸣潮/绝区零/方舟/终末地] · /欧非榜',
    '【派对桌游】',
    '· .r [1d100] / .ra [技能 65] / .rh [1d100]：TRPG 跑团骰娘',
    '· /海龟汤 开局 [主题] · /汤 <问题> · /汤 猜 <答案> · /海龟汤 提示|揭晓',
    '· /卧底 开局 · /加入 · /开始 · /投票 @某人 · /卧底 结束'
  ].join('\n');
}

export class FunCommands {
  constructor(store, funService, { onebot, log = () => {}, now = Date.now } = {}) {
    this.store = store;
    this.funService = funService;
    this.onebot = onebot;
    this.log = log;
    this.now = now;
    this.undercover = new UndercoverManager({ now });
    this.soup = new SoupManager({ now });
    this.jobs = new Set();
    this.active = new Set();
    this.seen = new Map();
    this.cooldowns = new Map();
    this.closed = false;
  }

  funSettings() {
    return this.funService.store.getSettings();
  }

  canHandle(event) {
    const settings = this.funSettings();
    if (this.closed || !this.store.config.enabled || !settings.enabled) return false;
    return event.message_type === 'group'
      ? groupRule(this.store.config, event.group_id).allowed
      : privateAllowed(this.store.config, event.user_id);
  }

  async sendReply(event, text, imageBuffer = null) {
    const settings = this.funSettings();
    if (this.closed || !this.store.config.enabled || !settings.enabled) return;
    const isGroup = event.message_type === 'group';
    const target = isGroup ? { group_id: event.group_id } : { user_id: event.user_id };
    if (imageBuffer && Buffer.isBuffer(imageBuffer)) {
      await this.onebot(isGroup ? 'send_group_msg' : 'send_private_msg', {
        ...target,
        message: [{ type: 'image', data: { file: `base64://${imageBuffer.toString('base64')}` } }]
      }, this.store.config, 120);
      return;
    }
    await this.onebot(isGroup ? 'send_group_msg' : 'send_private_msg', {
      ...target,
      message: [
        ...(isGroup ? [{ type: 'at', data: { qq: String(event.user_id) } }] : []),
        { type: 'text', data: { text: isGroup ? ` ${text}` : text } }
      ]
    }, this.store.config, 30);
  }

  async sendGroupNotice(groupId, text) {
    if (this.closed || !this.store.config.enabled) return;
    await this.onebot('send_group_msg', {
      group_id: groupId,
      message: [{ type: 'text', data: { text } }]
    }, this.store.config, 30);
  }

  async sendPrivateDm(userId, text) {
    if (this.closed || !this.store.config.enabled) return;
    await this.onebot('send_private_msg', {
      user_id: userId,
      message: [{ type: 'text', data: { text } }]
    }, this.store.config, 20);
  }

  receive(event) {
    const parsed = parseFunCommand(event);
    if (!parsed) return null;
    if (!this.funSettings().enabled) return null;

    const isGroup = event.message_type === 'group';
    const config = this.store.config;
    if (
      event.post_type !== 'message' ||
      !['group', 'private'].includes(event.message_type) ||
      !qq(event.self_id) ||
      !qq(event.user_id) ||
      String(event.user_id) === String(event.self_id) ||
      (config.botId && String(event.self_id) !== config.botId) ||
      event.message_id == null ||
      (isGroup && !qq(event.group_id)) ||
      !this.canHandle(event)
    ) {
      return { ignored: 'fun_unauthorized' };
    }

    const now = this.now();
    const key = isGroup ? `group:${event.group_id}` : `private:${event.user_id}`;
    const id = `${event.self_id}:${key}:${event.message_id}`;
    for (const map of [this.seen, this.cooldowns]) {
      for (const [k, at] of map) if (now - at > 600000) map.delete(k);
    }
    if (this.seen.has(id)) return { ignored: 'duplicate' };
    if (this.active.has(key) || this.active.size >= 4 || (this.cooldowns.has(key) && now - this.cooldowns.get(key) < 1200)) {
      return { ignored: 'fun_busy' };
    }
    this.seen.set(id, now);
    this.cooldowns.set(key, now);
    this.active.add(key);

    const job = this.execute(event, parsed)
      .catch(error => {
        this.log('error', `娱乐指令执行失败：${error.message}`, { source: 'fun', type: parsed.type });
      })
      .finally(() => {
        this.active.delete(key);
        this.jobs.delete(job);
      });
    this.jobs.add(job);
    return { accepted: true, fun: true, type: parsed.type };
  }

  async execute(event, parsed) {
    const settings = this.funSettings();
    const isGroup = event.message_type === 'group';
    const scope = isGroup ? { isPrivate: false, groupId: String(event.group_id), userId: String(event.user_id) } : { isPrivate: true, userId: String(event.user_id) };
    const scopeKey = isGroup ? `group:${event.group_id}` : `private:${event.user_id}`;
    const userId = String(event.user_id);
    const userName = String(event.sender?.card || event.sender?.nickname || `QQ ${userId}`).trim();

    try {
      if (parsed.type === 'help') {
        await this.sendReply(event, funHelpText());
        return;
      }

      if (parsed.type === 'fortune') {
        if (!settings.fortuneEnabled) { await this.sendReply(event, '今日运势功能已在后台关闭'); return; }
        const res = await this.funService.buildFortuneReply({ userId, userName });
        await this.sendReply(event, res.text, res.image);
        return;
      }

      if (parsed.type === 'meme') {
        if (!settings.memeEnabled) { await this.sendReply(event, '梗图工坊已在后台关闭'); return; }
        if (parsed.mode === 'caption') {
          const resolved = await resolveMessageImages(
            event,
            { ...this.store.config, imageRecognitionEnabled: true },
            (...args) => this.onebot(...args)
          ).catch(() => ({ urls: [] }));
          let imageUrl = resolved.urls[0] || '';
          if (!imageUrl) {
            const firstSeg = messageSegments(event.message).find(s => s.type === 'image');
            imageUrl = originalImageUrl(firstSeg?.data?.url) || originalImageUrl(firstSeg?.data?.file) || '';
          }
          const parts = parsed.arg.split(/[|｜\n]/);
          const topText = (parts[0] || '').trim().slice(0, 48);
          const bottomText = (parts.slice(1).join(' ') || '').trim().slice(0, 48);
          if (!topText && !bottomText) throw new Error('请输入配文，例如：回复图片发「/加字 上方文字|下方文字」');
          const res = await this.funService.renderMemeReply({ mode: 'caption', topText, bottomText, imageUrl });
          await this.sendReply(event, res.text, res.image);
          return;
        }
        const text = parsed.arg.slice(0, 64);
        if (!text) throw new Error(`请输入文案，例如：/${parsed.mode === 'bei_bao' ? '悲报' : parsed.mode === 'signboard' ? '举牌' : '喜报'} 今天提前下班啦`);
        const res = await this.funService.renderMemeReply({ mode: parsed.mode, text, scope });
        await this.sendReply(event, res.text, res.image);
        return;
      }

      if (parsed.type === 'quote_add') {
        if (!settings.quotesEnabled) { await this.sendReply(event, '群聊语录功能已在后台关闭'); return; }
        if (!isGroup) { await this.sendReply(event, '名场面语录仅支持在群聊中使用哦'); return; }
        let quoteText = parsed.arg;
        let authorName = userName;
        let authorQq = userId;
        if (parsed.replyId) {
          let quoted = null;
          try { quoted = await this.onebot('get_msg', { message_id: String(parsed.replyId) }, this.store.config, 15); } catch {}
          if (quoted && String(quoted.group_id) === String(event.group_id) && quoted.message_type !== 'private') {
            const extracted = extractQuotedText(quoted);
            if (!quoteText && extracted) quoteText = extracted;
            authorQq = String(quoted.sender?.user_id || authorQq);
            authorName = String(quoted.sender?.card || quoted.sender?.nickname || `QQ ${authorQq}`);
          }
        }
        const { quote, duplicated } = this.funService.store.addQuote({
          groupId: event.group_id,
          text: quoteText,
          authorName,
          authorQq,
          savedByName: userName,
          savedByQq: userId
        });
        await this.sendReply(event, duplicated
          ? `这条语录已经收进本群名人堂啦（编号 ${quote.id}）！`
          : `✨ 已收录「${quote.authorName}」的名场面（编号 ${quote.id}）：「${quote.text.slice(0, 60)}${quote.text.length > 60 ? '...' : ''}」`);
        return;
      }

      if (parsed.type === 'quote_get') {
        if (!settings.quotesEnabled) { await this.sendReply(event, '群聊语录功能已在后台关闭'); return; }
        if (!isGroup) { await this.sendReply(event, '请到群聊中使用「/语录」查看该群名场面'); return; }
        const q = this.funService.store.randomQuote(event.group_id, parsed.arg);
        if (!q) {
          await this.sendReply(event, parsed.arg ? `本群还没有包含「${parsed.arg}」的语录` : '本群还没有收录任何语录，回复群友金句并发送「/存语录」试试吧！');
          return;
        }
        const res = await this.funService.renderQuoteReply(q);
        await this.sendReply(event, res.text, res.image);
        return;
      }

      if (parsed.type === 'quote_del') {
        if (!settings.quotesEnabled) return;
        if (!isGroup) return;
        const qid = parsed.arg.trim();
        if (!qid) throw new Error('请指定语录编号，例如：/删语录 abc123');
        const list = this.funService.store.listQuotes({ groupId: event.group_id, limit: 100 });
        const target = list.find(q => q.id === qid);
        if (!target) { await this.sendReply(event, '本群未找到该编号的语录'); return; }
        if (target.savedByQq && target.savedByQq !== userId && target.authorQq !== userId) {
          await this.sendReply(event, '只能删除自己保存或自己名下的语录（管理员可在网页控制台删除任意语录）');
          return;
        }
        this.funService.store.deleteQuote(qid);
        await this.sendReply(event, `已删除语录 ${qid}`);
        return;
      }

      if (parsed.type === 'daily_report') {
        if (!settings.dailyReportEnabled) { await this.sendReply(event, '群聊日报功能已在后台关闭'); return; }
        if (!isGroup) { await this.sendReply(event, '「/群日报」仅支持在群聊中统计和生成哦'); return; }
        const res = await this.funService.buildDailyReportReply(event.group_id, event);
        await this.sendReply(event, res.text, res.image);
        return;
      }

      if (parsed.type === 'gacha') {
        if (!settings.gachaEnabled) { await this.sendReply(event, '十连抽卡模拟已在后台关闭'); return; }
        const res = await this.funService.runGacha({ scopeKey, userId, userName, gameInput: parsed.arg });
        await this.sendReply(event, res.text, res.image);
        return;
      }

      if (parsed.type === 'gacha_rank') {
        if (!settings.gachaEnabled) { await this.sendReply(event, '十连抽卡模拟已在后台关闭'); return; }
        const rows = this.funService.store.gachaLeaderboard(scopeKey, 8);
        if (!rows.length) {
          await this.sendReply(event, '本群还没有人模拟抽卡呢，快发送「/十连 鸣潮」试试手气！');
          return;
        }
        const lines = rows.map((r, i) => `${i + 1}. ${r.name} · 出金率 ${r.ratePct}%（${r.fiveStars}/${r.totalPulls} 抽${r.doubleGoldCount ? `，双黄+ ${r.doubleGoldCount} 次` : ''}）`);
        await this.sendReply(event, `🏆 本群十连欧非排行榜：\n${lines.join('\n')}`);
        return;
      }

      if (parsed.type === 'dice') {
        if (!settings.gamesEnabled) { await this.sendReply(event, '跑团与桌游功能已在后台关闭'); return; }
        const { cmd, rest } = parsed.dice;
        if (cmd === 'ra') {
          const chk = rollSkillCheck(rest);
          const detail = `🎲 ${userName} 进行【${chk.skill}】检定（1d100 ≤ ${chk.target}）：掷出 ${chk.roll} -> 【${chk.outcome}】`;
          const comment = await this.funService.buildDiceTavernComment({ event, detailText: detail, scope });
          await this.sendReply(event, comment ? `${detail}\n💬 ${comment}` : detail);
          return;
        }
        const res = rollDiceExpr(rest);
        if (cmd === 'rh' && isGroup) {
          try {
            await this.sendPrivateDm(userId, `🕵️ 暗骰结果（群 ${event.group_id} · ${res.exprText}${res.reason ? ` · ${res.reason}` : ''}）：${res.detail}`);
            await this.sendReply(event, `🎲 ${userName} 进行了一次暗骰${res.reason ? `（${res.reason}）` : ''}，结果已通过私聊偷偷告诉你~`);
          } catch {
            await this.sendReply(event, `暗骰私聊发送失败（请先加机器人好友或开启临时会话），改回公开结果：${res.exprText} = ${res.detail}`);
          }
          return;
        }
        const detail = `🎲 ${userName} 掷出 ${res.exprText}${res.reason ? `（${res.reason}）` : ''}：${res.detail}`;
        const comment = isGroup ? await this.funService.buildDiceTavernComment({ event, detailText: detail, scope }) : '';
        await this.sendReply(event, comment ? `${detail}\n💬 ${comment}` : detail);
        return;
      }

      if (parsed.type === 'soup') {
        if (!settings.gamesEnabled) { await this.sendReply(event, '桌游功能已在后台关闭'); return; }
        if (!isGroup) { await this.sendReply(event, '「海龟汤」仅支持在群聊内多人推理开局'); return; }
        const arg = parsed.arg.trim();
        const sub = arg.split(/\s+/)[0] || '';
        const rest = arg.slice(sub.length).trim();

        if (!arg || sub === '开局' || sub === '开始') {
          const custom = rest ? await this.funService.generateCustomSoup(rest, event) : null;
          const game = this.soup.startGame(event.group_id, custom);
          await this.sendGroupNotice(event.group_id, `🥣 海龟汤开锅啦！《${game.title}》\n\n【汤面】${game.surface}\n\n💡 用「/汤 <是非问句>」提问，「/海龟汤 提示」看线索，「/汤 猜 <答案>」交卷，或「/海龟汤 揭晓」看汤底！`);
          return;
        }
        if (sub === '提示') {
          const { hint } = this.soup.nextHint(event.group_id);
          await this.sendReply(event, `💡 海龟汤提示：${hint}`);
          return;
        }
        if (sub === '揭晓' || sub === '结束' || sub === '投降') {
          const game = this.soup.reveal(event.group_id);
          if (!game) { await this.sendReply(event, '本群当前没有进行中的海龟汤'); return; }
          await this.sendGroupNotice(event.group_id, `📖 《${game.title}》汤底揭晓：\n${game.bottom}`);
          return;
        }
        if (sub === '猜' && rest) {
          const game = this.soup.getGame(event.group_id);
          if (!game) { await this.sendReply(event, '本群当前没有进行中的海龟汤，发「/海龟汤 开局」先开一碗吧'); return; }
          const verdict = await this.funService.judgeSoupQuestion({ game, question: rest, isGuess: true, event });
          if (verdict.solved) {
            this.soup.reveal(event.group_id);
            await this.sendGroupNotice(event.group_id, `🎉 恭喜 ${userName} 喝光了这碗汤！\n${verdict.reply}\n\n【完整汤底】${game.bottom}`);
          } else {
            await this.sendReply(event, verdict.reply);
          }
          return;
        }
        // Treat `/海龟汤 某问题` directly as a question if game exists
        const game = this.soup.getGame(event.group_id);
        if (!game) { await this.sendReply(event, '发送「/海龟汤 开局」开始游戏，或加主题如「/海龟汤 开局 科幻」'); return; }
        const ans = await this.funService.judgeSoupQuestion({ game, question: arg, isGuess: false, event });
        await this.sendReply(event, ans.reply);
        return;
      }

      if (parsed.type === 'soup_ask') {
        if (!settings.gamesEnabled) { await this.sendReply(event, '桌游功能已在后台关闭'); return; }
        if (!isGroup) { await this.sendReply(event, '请到群聊中玩海龟汤哦'); return; }
        const game = this.soup.getGame(event.group_id);
        if (!game) { await this.sendReply(event, '本群还没有开海龟汤，发送「/海龟汤 开局」开始吧'); return; }
        const q = parsed.arg.trim();
        if (!q) { await this.sendReply(event, '请在后面写上你的问题，例如：/汤 车上还有别人吗？'); return; }
        const isGuess = q.startsWith('猜 ') || q.startsWith('答案 ');
        const question = isGuess ? q.replace(/^(?:猜|答案)\s+/, '').trim() : q;
        const ans = await this.funService.judgeSoupQuestion({ game, question, isGuess, event });
        if (ans.solved) {
          this.soup.reveal(event.group_id);
          await this.sendGroupNotice(event.group_id, `🎉 恭喜 ${userName} 猜中汤底！\n${ans.reply}\n\n【完整汤底】${game.bottom}`);
        } else {
          await this.sendReply(event, ans.reply);
        }
        return;
      }

      if (parsed.type === 'undercover') {
        if (!settings.gamesEnabled) { await this.sendReply(event, '桌游功能已在后台关闭'); return; }
        if (!isGroup) { await this.sendReply(event, '「谁是卧底」仅支持在群聊中进行'); return; }
        const sub = parsed.arg.trim() || '开局';
        if (sub === '开局') {
          const room = this.undercover.openRoom(event.group_id, userId, userName);
          await this.sendGroupNotice(event.group_id, `🕵️ 「谁是卧底」已建房！发起人：${userName}\n想玩的群友请发送「/加入」（3~10 人，人齐后发送「/开始」，注意需能接收机器人私聊发词哦~）`);
          return;
        }
        if (sub === '加入') {
          const { room, alreadyJoined } = this.undercover.joinRoom(event.group_id, userId, userName);
          await this.sendReply(event, alreadyJoined
            ? `你已经在局内啦，当前共 ${room.players.length} 人（${room.players.map(p => p.name).join('、')}）`
            : `欢迎 ${userName} 加入「谁是卧底」！当前共 ${room.players.length} 人：${room.players.map(p => p.name).join('、')}`);
          return;
        }
        if (sub === '开始') {
          const { room, assignments } = this.undercover.startGame(event.group_id, userId);
          const dmErrors = [];
          for (const item of assignments) {
            try {
              await this.sendPrivateDm(item.userId, `🕵️ 群 ${event.group_id}「谁是卧底」已发牌！你的本局词语是：【${item.word}】\n请回群轮流用一句话隐晦描述（别直接说出词本身哦）。`);
            } catch {
              dmErrors.push(item.name);
            }
          }
          if (dmErrors.length === assignments.length) {
            this.undercover.endRoom(event.group_id);
            await this.sendGroupNotice(event.group_id, '❌ 所有玩家的私聊发牌均失败（可能未加机器人好友或未开启群临时会话），本局已取消。');
            return;
          }
          await this.sendGroupNotice(event.group_id, `🎮 第 ${room.round} 轮开始！共 ${assignments.length} 人（含 ${room.undercoverIds.size} 名卧底），词语已私聊发放${dmErrors.length ? `（⚠️ ${dmErrors.join('、')} 私聊接收失败）` : ''}。\n请轮流发言后使用「/投票 @某人」投出嫌疑人！`);
          return;
        }
        if (sub === '状态') {
          const room = this.undercover.getRoom(event.group_id);
          if (!room) { await this.sendReply(event, '本群当前没有进行中的「谁是卧底」对局'); return; }
          const alive = room.players.filter(p => p.alive).map(p => p.name).join('、');
          await this.sendReply(event, `🕵️ 谁是卧底 · ${room.phase === 'waiting' ? '报名中' : `第 ${room.round} 轮`}，当前参与者：${alive}`);
          return;
        }
        if (sub === '结束') {
          const room = this.undercover.endRoom(event.group_id);
          if (!room) { await this.sendReply(event, '本群当前没有进行中的「谁是卧底」'); return; }
          const summary = room.words
            ? `\n平民词：【${room.words.civilian}】｜ 卧底词：【${room.words.undercover}】\n本局卧底：${room.players.filter(p => room.undercoverIds.has(p.userId)).map(p => p.name).join('、')}`
            : '';
          await this.sendGroupNotice(event.group_id, `🛑 本局「谁是卧底」已提前结束。${summary}`);
          return;
        }
        await this.sendReply(event, '用法：/卧底 开局 | /加入 | /开始 | /投票 @某人 | /卧底 状态 | /卧底 结束');
        return;
      }

      if (parsed.type === 'undercover_vote') {
        if (!settings.gamesEnabled || !isGroup) return;
        const targetId = parsed.mentionedQq || (/^\d{5,20}$/.test(parsed.arg.trim()) ? parsed.arg.trim() : '');
        if (!targetId) { await this.sendReply(event, '请 @ 要投票的玩家，例如：/投票 @张三'); return; }
        const res = this.undercover.castVote(event.group_id, userId, targetId);
        if (!res.settled) {
          await this.sendGroupNotice(event.group_id, `🗳️ ${res.voter.name} 已投票（当前 ${res.votedCount}/${res.neededCount} 票）。`);
          return;
        }
        if (res.tie) {
          await this.sendGroupNotice(event.group_id, `⚖️ 本轮平票（${res.tieNames.join('、')}）无人淘汰！进入第 ${res.room.round} 轮发言并重新投票。`);
          return;
        }
        const revealRole = res.eliminatedWasUndercover ? '【卧底】' : '【平民】';
        if (res.winner) {
          const winnerLabel = res.winner === 'civilian' ? '🎉 平民阵营胜利！' : '😈 卧底潜伏到底，卧底阵营胜利！';
          const underNames = res.room.players.filter(p => res.room.undercoverIds.has(p.userId)).map(p => p.name).join('、');
          await this.sendGroupNotice(
            event.group_id,
            `🗳️ ${res.eliminated.name} 以 ${res.topVotes} 票被投出，Ta 的身份是 ${revealRole}！\n${winnerLabel}\n平民词：【${res.room.words.civilian}】｜ 卧底词：【${res.room.words.undercover}】\n本局卧底：${underNames}`
          );
        } else {
          await this.sendGroupNotice(
            event.group_id,
            `🗳️ ${res.eliminated.name} 以 ${res.topVotes} 票被投出，Ta 的身份是 ${revealRole}！游戏继续，进入第 ${res.room.round} 轮（存活：${res.remaining.map(p => p.name).join('、')}）。`
          );
        }
      }
    } catch (error) {
      await this.sendReply(event, error.message || '执行失败');
    }
  }

  close() {
    this.closed = true;
    this.funService?.store?.close?.();
  }
}

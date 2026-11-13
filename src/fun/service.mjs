import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { games } from '../subscriptions/games.mjs';
import { downloadWebImage } from '../web-images.mjs';
import { beijingDateParts } from './store.mjs';
import { resolveGachaGame, simulateTenPull } from './gacha.mjs';
import {
  buildEmotionCardHtml,
  buildFortuneCardHtml,
  buildQuoteCardHtml,
  buildMemeCardHtml,
  buildGachaCardHtml,
  buildDailyReportCardHtml
} from './card-templates.mjs';
import { EMOTION_METRICS } from '../tavern/emotions.mjs';

const FORTUNE_TIERS = [
  { tier: '大吉', min: 88, color: '#e11d48', comment: '今天欧气爆棚，想到什么就大胆去做，说不定十连双金就在下一抽！' },
  { tier: '中吉', min: 68, color: '#ea580c', comment: '顺风顺水的一天，适合跟群友开黑摸鱼，保持好心情就会有小惊喜。' },
  { tier: '小吉', min: 45, color: '#0284c7', comment: '平淡里藏着小确幸，按部就班推进手头的事，晚上奖励自己一顿好的。' },
  { tier: '吉', min: 25, color: '#059669', comment: '稳扎稳打就是胜利，注意劳逸结合，别让琐事消耗太多精力。' },
  { tier: '末吉', min: 10, color: '#7c3aed', comment: '运势正在蓄力转弯，重要抽卡和重大决定建议先观望一会。' },
  { tier: '小凶', min: 0, color: '#475569', comment: '不宜硬刚高难副本与凌晨冲动消费，早点休息让好运重新加载。' }
];

const FORTUNE_VERSES = [
  '山海自有归期，风雨自有相逢，今日宜轻装向前。',
  '星火微芒亦能照夜，循心而行，所遇皆为风景。',
  '十连出金未可知，但今日清风与热茶已先到位。',
  '把焦虑调成静音，今日好运正在后台静默下载。',
  '与其在原地观望风向，不如先把今天过得漂亮。',
  '云开月明有时，手气起伏亦然，从容便是上上签。',
  '旧事翻篇莫回头，且看前方新副本与好朋友。',
  '风起青萍之末，微小的好意会变成今日的回响。'
];

const GOOD_LIST = ['水群摸鱼', '早睡早起', '喝杯奶茶', '整理桌面', '和朋友开黑', '清体力副本', '保存表情包', '吃顿热乎饭', '听首喜欢的歌', '刷一道轻松题'];
const BAD_LIST = ['上头硬氪', '凌晨熬夜', '带节奏对线', '空腹喝冰饮', '忘记存档', '拖延DDL', '硬刚玄学池', '久坐不动'];
const LUCKY_COLORS = ['樱花粉', '晴空蓝', '薄荷绿', '琥珀金', '丁香紫', '奶杏白', '珊瑚橘', '深海靛'];

function dataUrlFromBase64(b64String) {
  const b64 = String(b64String || '').replace(/^base64:\/\//, '');
  if (!b64) return '';
  let mime = 'image/png';
  if (b64.startsWith('/9j/')) mime = 'image/jpeg';
  else if (b64.startsWith('UklGR')) mime = 'image/webp';
  else if (b64.startsWith('R0lGOD')) mime = 'image/gif';
  return `data:${mime};base64,${b64}`;
}

function localFileDataUrl(filePath) {
  if (!filePath || !existsSync(filePath)) return '';
  try {
    const buf = readFileSync(filePath);
    if (buf.length > 2 * 1024 * 1024) return '';
    const ext = filePath.toLowerCase().endsWith('.jpg') || filePath.toLowerCase().endsWith('.jpeg')
      ? 'image/jpeg'
      : filePath.toLowerCase().endsWith('.webp')
        ? 'image/webp'
        : filePath.toLowerCase().endsWith('.gif')
          ? 'image/gif'
          : 'image/png';
    return `data:${ext};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

export class FunService {
  constructor(store, { cardRenderer = null, askModel = null, tavernManager = null } = {}) {
    this.store = store;
    this.cardRenderer = cardRenderer;
    this.askModel = askModel;
    this.tavernManager = tavernManager;
  }

  observeGroupMessage(event) {
    const settings = this.store.getSettings();
    if (!settings.enabled || !settings.dailyReportEnabled) return;
    const gid = String(event.group_id || '').trim();
    const uid = String(event.user_id || '').trim();
    if (!gid || !uid) return;
    const name = String(event.sender?.card || event.sender?.nickname || '').trim();
    let plain = '';
    if (Array.isArray(event.message)) {
      plain = event.message.filter(s => s?.type === 'text').map(s => s.data?.text || '').join(' ');
    } else if (typeof event.message === 'string') {
      plain = event.message.replace(/\[CQ:[^\]]+\]/g, ' ');
    }
    this.store.observeActivity(gid, uid, name, plain);
  }

  async fetchQqAvatarDataUrl(qq) {
    const clean = String(qq || '').trim();
    if (!/^\d{5,20}$/.test(clean)) return '';
    try {
      const downloaded = await downloadWebImage(`https://q1.qlogo.cn/g?b=qq&nk=${clean}&s=640`, { timeoutSeconds: 4 });
      return dataUrlFromBase64(downloaded.file);
    } catch {
      return '';
    }
  }

  async fetchExternalImage(url) {
    const downloaded = await downloadWebImage(url, { timeoutSeconds: 10 });
    return {
      dataUrl: dataUrlFromBase64(downloaded.file),
      width: downloaded.width,
      height: downloaded.height
    };
  }

  async renderCardSafely({ html, width, height }) {
    if (!this.cardRenderer) return null;
    try {
      return await this.cardRenderer.renderHtmlToPng({ html, width, height });
    } catch {
      return null;
    }
  }

  async renderEmotionCard({ character = null, card = null, emotion, scopeLabel = '', avatarBuffer = null, avatarPath = '' }) {
    if (!this.cardRenderer) return null;
    const target = character || card;
    const avatarDataUrl = Buffer.isBuffer(avatarBuffer)
      ? dataUrlFromBase64(avatarBuffer.toString('base64'))
      : localFileDataUrl(avatarPath);
    const html = buildEmotionCardHtml({
      characterName: target?.name || '角色',
      emotion,
      metrics: EMOTION_METRICS,
      avatarDataUrl,
      scopeLabel
    });
    return this.renderCardSafely({ html, width: 820, height: 520 });
  }

  computeFortune(userId) {
    const { dateText } = beijingDateParts(this.store.now());
    const cached = this.store.getFortune(userId, dateText);
    if (cached) return { ...cached, dateText };

    const digest = createHash('sha256').update(`${dateText}:${userId}:qqbot-fortune`).digest();
    const score = digest[0] % 101;
    const tierInfo = FORTUNE_TIERS.find(t => score >= t.min) || FORTUNE_TIERS[FORTUNE_TIERS.length - 1];
    const verse = FORTUNE_VERSES[digest[1] % FORTUNE_VERSES.length];
    const pickTwo = (list, aIdx, bIdx) => {
      const a = list[aIdx % list.length];
      const b = list[(aIdx + 1 + (bIdx % (list.length - 1))) % list.length];
      return [a, b];
    };
    const goodItems = pickTwo(GOOD_LIST, digest[2], digest[3]);
    const badItems = pickTwo(BAD_LIST, digest[4], digest[5]);
    const luckyColor = LUCKY_COLORS[digest[6] % LUCKY_COLORS.length];
    const luckyGame = games[digest[7] % games.length]?.name || '明日方舟';
    const record = {
      score,
      tier: tierInfo.tier,
      badgeColor: tierInfo.color,
      comment: tierInfo.comment,
      verse,
      goodItems,
      badItems,
      luckyColor,
      luckyGame
    };
    this.store.setFortune(userId, record, dateText);
    return { ...record, dateText };
  }

  async buildFortuneReply({ userId, userName }) {
    const f = this.computeFortune(userId);
    const avatarDataUrl = await this.fetchQqAvatarDataUrl(userId);
    const html = buildFortuneCardHtml({ userName, avatarDataUrl, ...f });
    const image = await this.renderCardSafely({ html, width: 780, height: 600 });
    const text = [
      `🎍 ${userName} 的今日运势（${f.dateText}）：【${f.tier}】（运势值 ${f.score}）`,
      `签文：${f.verse}`,
      `宜：${f.goodItems.join('、')} ｜ 忌：${f.badItems.join('、')}`,
      `幸运色：${f.luckyColor} ｜ 宜玩：${f.luckyGame}`,
      `点评：${f.comment}`
    ].join('\n');
    return { image, text, fortune: f };
  }

  async renderQuoteReply(quote) {
    const avatarDataUrl = quote.authorQq ? await this.fetchQqAvatarDataUrl(quote.authorQq) : '';
    const dateText = String(quote.createdAt || '').slice(0, 10) || beijingDateParts(this.store.now()).dateText;
    const html = buildQuoteCardHtml({
      text: quote.text,
      authorName: quote.authorName,
      authorQq: quote.authorQq,
      avatarDataUrl,
      groupId: quote.groupId,
      dateText
    });
    const image = await this.renderCardSafely({ html, width: 900, height: 480 });
    const text = `💬 「${quote.text}」\n—— ${quote.authorName}（收录于 ${dateText}）`;
    return { image, text };
  }

  async renderMemeReply({ mode, text = '', topText = '', bottomText = '', imageUrl = '', scope = null }) {
    if (mode === 'caption') {
      if (!imageUrl) throw new Error('请携带一张图片或回复包含图片的消息，例如：回复图片发送「/加字 顶部|底部」');
      const img = await this.fetchExternalImage(imageUrl);
      const scale = Math.min(900 / img.width, 720 / img.height, 1.5);
      const w = Math.max(420, Math.round(img.width * scale));
      const h = Math.max(320, Math.round(img.height * scale));
      const html = buildMemeCardHtml({ mode: 'caption', topText, bottomText, imageDataUrl: img.dataUrl, width: w, height: h });
      const image = await this.renderCardSafely({ html, width: w, height: h });
      if (!image) throw new Error('当前环境缺少无头浏览器渲染能力，暂时无法合成加字图片');
      return { image, text: `🖼️ 已生成加字梗图` };
    }
    if (mode === 'signboard') {
      const char = this.tavernManager?.state?.enabled ? this.tavernManager.getActiveCharacter(scope) : null;
      const charName = char?.name || '看板娘';
      const avatarBuf = char ? this.tavernManager?.getAvatar(char.id) : null;
      const avatarDataUrl = Buffer.isBuffer(avatarBuf) ? dataUrlFromBase64(avatarBuf.toString('base64')) : '';
      const html = buildMemeCardHtml({ mode: 'signboard', text, charName, avatarDataUrl });
      const image = await this.renderCardSafely({ html, width: 760, height: 600 });
      return { image, text: `${charName}举牌：「${text}」` };
    }
    const cleanMode = mode === 'bei_bao' ? 'bei_bao' : 'xi_bao';
    const html = buildMemeCardHtml({ mode: cleanMode, text });
    const image = await this.renderCardSafely({ html, width: 840, height: 540 });
    const title = cleanMode === 'bei_bao' ? '【悲报】' : '【喜报】';
    return { image, text: `${title} ${text}` };
  }

  async runGacha({ scopeKey, userId, userName, gameInput }) {
    const pool = resolveGachaGame(gameInput);
    if (!pool) {
      throw new Error('暂不支持该卡池，目前支持：鸣潮（wuwa）、绝区零（zzz）、明日方舟（方舟）、终末地（endfield）');
    }
    const prev = this.store.getUserGachaStats(scopeKey, userId, pool.id);
    const result = simulateTenPull(pool.id, prev);
    this.store.saveUserGachaStats(scopeKey, userId, userName, pool.id, result.stats);
    const html = buildGachaCardHtml({
      gameName: pool.name,
      gameColor: pool.color,
      pulls: result.pulls.map(p => ({ ...p, rarity: p.displayStars >= 6 ? 5 : p.displayStars >= 5 ? (p.rarity === 5 ? 5 : 4) : p.rarity })),
      pityAfter: result.stats.pity,
      pityLimit: pool.hardPity,
      totalPulls: result.stats.totalPulls,
      totalGold: result.stats.fiveStars,
      userName
    });
    const image = await this.renderCardSafely({ html, width: 960, height: 620 });
    const golds = result.pulls.filter(p => p.rarity >= 5).map(p => `${p.name}(${p.tag})`);
    const lineSummary = result.pulls.map(p => (p.rarity >= 5 ? `★${p.name}` : p.name)).join(' · ');
    const text = [
      `🎴 ${userName} 的【${pool.name}】十连结果：`,
      golds.length ? `🎉 出金啦！${golds.join('、')}` : '✨ 本轮未出金，继续垫抽中~',
      lineSummary,
      `当前水位：${result.stats.pity}/${pool.hardPity}${result.stats.guaranteed ? '（已在大保底）' : ''} · 累计 ${result.stats.totalPulls} 抽 / ${result.stats.fiveStars} 金`
    ].join('\n');
    return { image, text, result };
  }

  async buildDailyReportReply(groupId, event = null) {
    const data = this.store.getDailyReportData(groupId);
    if (!data.totalMessages) {
      return {
        image: null,
        text: `📊 群 ${groupId} 今日（${data.dateText}）还没有记录到足够的发言活跃数据，大家多聊几句再来看日报吧~`
      };
    }
    let aiSummary = '';
    if (this.askModel) {
      try {
        const promptData = {
          date: data.dateText,
          totalMessages: data.totalMessages,
          activeMembers: data.activeMembers,
          topTalkers: data.topTalkers.slice(0, 3).map(m => ({ name: m.name, count: m.count })),
          nightOwls: data.nightOwls.slice(0, 2).map(m => ({ name: m.name, count: m.nightCount })),
          hotWords: data.hotWords.slice(0, 8)
        };
        aiSummary = await this.askModel({
          event,
          purpose: 'fun_daily_report',
          maxTokens: 220,
          messages: [
            { role: 'system', content: '你是轻松幽默的QQ群聊风向观察员。根据给定的匿名活跃统计JSON（绝不编造未提及内容），写一段80字以内、俏皮温暖的群聊今日锐评。只返回正文，不带标题。' },
            { role: 'user', content: JSON.stringify(promptData) }
          ]
        });
      } catch {
        aiSummary = '';
      }
    }
    const html = buildDailyReportCardHtml({ ...data, aiSummary });
    const image = await this.renderCardSafely({ html, width: 900, height: 760 });
    const lines = [
      `📊 群聊今日风向日报（${data.dateText}）`,
      `共统计 ${data.totalMessages} 条发言，活跃群友 ${data.activeMembers} 位。`,
      data.topTalkers.length ? `🏆 话痨榜：${data.topTalkers.slice(0, 3).map((m, i) => `${i + 1}.${m.name}(${m.count})`).join('  ')}` : '',
      data.hotWords.length ? `🔥 高频词：${data.hotWords.slice(0, 6).map(w => w.word).join(' / ')}` : '',
      aiSummary ? `💬 锐评：${aiSummary}` : ''
    ].filter(Boolean);
    return { image, text: lines.join('\n') };
  }

  async judgeSoupQuestion({ game, question, isGuess = false, event = null }) {
    game.askCount += 1;
    game.updatedAt = this.store.now();
    if (!this.askModel) {
      const q = String(question || '').trim();
      const keywords = [...q.matchAll(/[\u4e00-\u9fa5]{2,4}/g)].map(m => m[0]);
      const hits = keywords.filter(k => game.bottom.includes(k)).length;
      if (isGuess) {
        return hits >= 2
          ? { solved: true, reply: `🎉 方向完全吻合！谜底正是：\n${game.bottom}` }
          : { solved: false, reply: '还没完全踩中核心真相哦，可以再用「/汤 问题」排查关键细节，或发送「/海龟汤 提示」。' };
      }
      if (hits >= 2) return { solved: false, reply: '【是 / 很接近】你已经摸到关键线索了！' };
      if (hits === 1) return { solved: false, reply: '【部分有关】顺着这个方向再细问一下。' };
      return { solved: false, reply: '【否 / 无关】和核心真相关系不大哦。' };
    }

    try {
      const prompt = isGuess
        ? `题目：《${game.title}》\n汤面：${game.surface}\n汤底（保密真相）：${game.bottom}\n玩家猜想：${question}\n请判断玩家是否已经猜出了核心因果真相。仅返回JSON：{"solved": true/false, "reply": "一句俏皮点评，如果没猜对绝对不能剧透汤底"}`
        : `题目：《${game.title}》\n汤面：${game.surface}\n汤底（保密真相）：${game.bottom}\n玩家第${game.askCount}问：${question}\n你作为海龟汤主持人，只根据汤底用“是 / 否 / 是也不是 / 无关 / 很接近”开头回答，并可附半句不剧透的简短引导。严禁泄露汤底！`;
      const raw = await this.askModel({
        event,
        purpose: 'fun_soup',
        maxTokens: isGuess ? 220 : 120,
        messages: [
          { role: 'system', content: '你是海龟汤主持人，严谨、有趣，绝对不提前剧透汤底。' },
          { role: 'user', content: prompt }
        ]
      });
      if (isGuess) {
        const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/g, '').trim();
        try {
          const parsed = JSON.parse(cleaned);
          return {
            solved: Boolean(parsed.solved),
            reply: String(parsed.reply || (parsed.solved ? '猜对啦！' : '还差一点点！'))
          };
        } catch {
          return { solved: false, reply: raw };
        }
      }
      return { solved: false, reply: raw };
    } catch {
      return { solved: false, reply: '裁判暂时走神了，先用「/海龟汤 提示」看看线索吧！' };
    }
  }

  async generateCustomSoup(topic = '', event = null) {
    if (!this.askModel) return null;
    try {
      const raw = await this.askModel({
        event,
        purpose: 'fun_soup_gen',
        maxTokens: 520,
        messages: [
          { role: 'system', content: '你是一个擅长创作巧妙、无血腥恐怖内容、逻辑严密的中文海龟汤出题人。仅输出合法JSON：{"title":"4-8字标题","surface":"80字内悬疑汤面","bottom":"150字内自洽汤底","hints":["提示1","提示2"]}。' },
          { role: 'user', content: `请创作一碗新的海龟汤${topic ? `，主题偏向「${topic.slice(0, 30)}」` : '（日常推理或二次元奇思妙想向）'}。` }
        ]
      });
      const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
      if (!jsonText) return null;
      const parsed = JSON.parse(jsonText);
      if (parsed?.title && parsed?.surface && parsed?.bottom) {
        return {
          title: String(parsed.title).slice(0, 24),
          surface: String(parsed.surface).slice(0, 300),
          bottom: String(parsed.bottom).slice(0, 500),
          hints: Array.isArray(parsed.hints) ? parsed.hints.slice(0, 3).map(h => String(h).slice(0, 100)) : []
        };
      }
    } catch {}
    return null;
  }

  async buildDiceTavernComment({ event, detailText, scope }) {
    if (!this.askModel || !this.tavernManager?.state?.enabled) return '';
    if (!this.store.getSettings().diceTavernComment) return '';
    const char = this.tavernManager.getActiveCharacter(scope);
    if (!char) return '';
    try {
      const line = await this.askModel({
        event,
        purpose: 'fun_dice_comment',
        maxTokens: 90,
        messages: [
          { role: 'system', content: `你正在扮演角色「${char.name}」：${String(char.persona || char.description || '').slice(0, 240)}。保持人设简短吐槽刚刚群友的跑团掷骰结果（不超过30字，1句话，不解释规则）。` },
          { role: 'user', content: detailText }
        ]
      });
      return line ? line.slice(0, 80) : '';
    } catch {
      return '';
    }
  }
}

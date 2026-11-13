import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteJson, quarantineCorruptFile, sanitizeJsonValue } from '../security.mjs';

export function defaultFunSettings() {
  return {
    enabled: true,
    fortuneEnabled: true,
    memeEnabled: true,
    gamesEnabled: true,
    gachaEnabled: true,
    quotesEnabled: true,
    dailyReportEnabled: true,
    diceTavernComment: true
  };
}

export function beijingDateParts(nowMs = Date.now()) {
  const bj = new Date(nowMs + 8 * 3600000);
  const year = bj.getUTCFullYear();
  const month = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(bj.getUTCDate()).padStart(2, '0');
  const hour = bj.getUTCHours();
  return { dateText: `${year}-${month}-${day}`, hour };
}

const STOPWORDS = new Set([
  '我们', '你们', '他们', '她们', '它们', '大家', '自己', '什么', '怎么', '怎样', '为什么',
  '这个', '那个', '这些', '那些', '这里', '那里', '这样', '那样', '可以', '不能', '没有',
  '不是', '就是', '还是', '或者', '因为', '所以', '但是', '不过', '如果', '虽然', '然后',
  '已经', '正在', '一个', '一种', '一样', '一直', '一起', '一下', '一点', '一些', '觉得',
  '知道', '看到', '听到', '以为', '感觉', '真的', '确实', '好像', '应该', '可能', '大概',
  '哈哈', '哈哈哈', '哈哈哈哈', '呵呵', '呜呜', '啊啊', '嗯嗯', '好的', '好吧', '行吧',
  '今天', '明天', '昨天', '现在', '时候', '东西', '事情', '问题', '回复', '消息', '图片',
  '群里', '群友', '机器人'
]);

/**
 * 提取脱敏的高频短词（不含长数字/QQ号/网址/原文，仅用于群日报词频统计）。
 */
export function extractSafeKeywords(text) {
  const cleaned = String(text || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[@#./][^\s]{1,32}/g, ' ')
    .replace(/\d{5,}/g, ' ')
    .trim();
  if (!cleaned) return [];
  const hits = [];
  let segmenter = null;
  if (typeof Intl?.Segmenter === 'function') {
    segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  }
  if (segmenter) {
    let cjkBuf = '';
    const flushCjk = () => {
      if (cjkBuf.length >= 2 && !STOPWORDS.has(cjkBuf)) hits.push(cjkBuf);
      cjkBuf = '';
    };
    for (const seg of segmenter.segment(cleaned)) {
      if (!seg.isWordLike) {
        flushCjk();
        continue;
      }
      const w = seg.segment.trim().toLowerCase();
      if (/^[\u4e00-\u9fa5]$/.test(w)) {
        cjkBuf += w;
        if (cjkBuf.length >= 4) flushCjk();
        continue;
      }
      flushCjk();
      if (w.length < 2 || w.length > 10) continue;
      if (/^\d+$/.test(w)) continue;
      if (STOPWORDS.has(w)) continue;
      hits.push(w);
    }
    flushCjk();
  } else {
    const matches = cleaned.match(/[\u4e00-\u9fa5]{2,4}|[a-zA-Z]{3,12}/g) || [];
    for (const raw of matches) {
      const w = raw.toLowerCase();
      if (!STOPWORDS.has(w)) hits.push(w);
    }
  }
  return [...new Set(hits)].slice(0, 12);
}

/**
 * 群聊娱乐功能持久化存储（仅保存功能配置、名场面语录、抽卡计数和匿名活跃计数）。
 */
export class FunStore {
  constructor(dataDir, { now = () => Date.now() } = {}) {
    this.dataDir = dataDir;
    this.path = join(dataDir, 'fun', 'state.json');
    this.now = now;
    this.corruptBackup = '';
    this.flushTimer = null;
    this.dirty = false;
    mkdirSync(dirname(this.path), { recursive: true });
    this.state = this.load();
  }

  load() {
    const defaults = defaultFunSettings();
    const empty = {
      version: 1,
      settings: defaults,
      quotes: [],
      gacha: {},
      activity: {},
      fortunes: {}
    };
    if (!existsSync(this.path)) return empty;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('娱乐数据格式错误');
      const clean = sanitizeJsonValue(raw);
      return {
        version: 1,
        settings: { ...defaults, ...(clean.settings && typeof clean.settings === 'object' ? clean.settings : {}) },
        quotes: Array.isArray(clean.quotes) ? clean.quotes.filter(Boolean) : [],
        gacha: clean.gacha && typeof clean.gacha === 'object' ? clean.gacha : {},
        activity: clean.activity && typeof clean.activity === 'object' ? clean.activity : {},
        fortunes: clean.fortunes && typeof clean.fortunes === 'object' ? clean.fortunes : {}
      };
    } catch {
      this.corruptBackup = quarantineCorruptFile(this.path);
      return empty;
    }
  }

  save() {
    this.pruneHistory();
    atomicWriteJson(this.path, this.state);
    this.dirty = false;
  }

  scheduleSave() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) {
        try { this.save(); } catch {}
      }
    }, 3000);
    this.flushTimer.unref?.();
  }

  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) {
      try { this.save(); } catch {}
    }
  }

  close() {
    this.flush();
  }

  pruneHistory() {
    const todayMs = this.now();
    const keepActivityDays = new Set();
    for (let i = 0; i < 7; i++) keepActivityDays.add(beijingDateParts(todayMs - i * 86400000).dateText);
    for (const [gid, days] of Object.entries(this.state.activity || {})) {
      if (!days || typeof days !== 'object') { delete this.state.activity[gid]; continue; }
      for (const dateKey of Object.keys(days)) {
        if (!keepActivityDays.has(dateKey)) delete days[dateKey];
      }
      if (!Object.keys(days).length) delete this.state.activity[gid];
    }
    const keepFortuneDays = new Set([
      beijingDateParts(todayMs).dateText,
      beijingDateParts(todayMs - 86400000).dateText
    ]);
    for (const dateKey of Object.keys(this.state.fortunes || {})) {
      if (!keepFortuneDays.has(dateKey)) delete this.state.fortunes[dateKey];
    }
  }

  getSettings() {
    return { ...defaultFunSettings(), ...this.state.settings };
  }

  updateSettings(patch = {}) {
    const next = { ...this.getSettings() };
    for (const key of Object.keys(defaultFunSettings())) {
      if (Object.hasOwn(patch, key)) next[key] = Boolean(patch[key]);
    }
    this.state.settings = next;
    this.save();
    return this.getSettings();
  }

  // ---- Quotes ----
  addQuote({ groupId, text, authorName = '', authorQq = '', savedByName = '', savedByQq = '' }) {
    const gid = String(groupId || '').trim();
    const body = String(text || '').trim().slice(0, 240);
    if (!gid) throw new Error('仅支持在群聊中收录名场面语录');
    if (!body) throw new Error('语录正文不能为空');
    const duplicate = this.state.quotes.find(q => q.groupId === gid && q.text === body && String(q.authorQq || '') === String(authorQq || ''));
    if (duplicate) return { quote: duplicate, duplicated: true };
    const entry = {
      id: randomUUID().slice(0, 10),
      groupId: gid,
      text: body,
      authorName: String(authorName || '群友').trim().slice(0, 40) || '群友',
      authorQq: String(authorQq || '').trim().slice(0, 24),
      savedByName: String(savedByName || '').trim().slice(0, 40),
      savedByQq: String(savedByQq || '').trim().slice(0, 24),
      createdAt: new Date(this.now()).toISOString()
    };
    this.state.quotes.unshift(entry);
    // Keep at most 100 quotes per group.
    let count = 0;
    this.state.quotes = this.state.quotes.filter(q => {
      if (q.groupId !== gid) return true;
      count++;
      return count <= 100;
    });
    this.save();
    return { quote: entry, duplicated: false };
  }

  listQuotes({ groupId = '', keyword = '', limit = 50 } = {}) {
    const gid = String(groupId || '').trim();
    const kw = String(keyword || '').trim().toLowerCase();
    return this.state.quotes
      .filter(q => (!gid || q.groupId === gid) && (!kw || q.text.toLowerCase().includes(kw) || q.authorName.toLowerCase().includes(kw)))
      .slice(0, Math.max(1, Number(limit) || 50));
  }

  randomQuote(groupId, keyword = '') {
    const pool = this.listQuotes({ groupId, keyword, limit: 100 });
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  deleteQuote(id) {
    const before = this.state.quotes.length;
    this.state.quotes = this.state.quotes.filter(q => q.id !== id);
    if (this.state.quotes.length === before) return false;
    this.save();
    return true;
  }

  // ---- Activity (Privacy-first: counts & anonymized keywords only) ----
  observeActivity(groupId, userId, userName, plainText) {
    const gid = String(groupId || '').trim();
    const uid = String(userId || '').trim();
    if (!gid || !uid) return;
    const { dateText, hour } = beijingDateParts(this.now());
    const groupBucket = (this.state.activity[gid] ||= {});
    const day = (groupBucket[dateText] ||= { total: 0, users: {}, words: {} });
    day.total += 1;
    const userBucket = (day.users[uid] ||= { name: '', count: 0, nightCount: 0 });
    if (userName) userBucket.name = String(userName).trim().slice(0, 40);
    userBucket.count += 1;
    if (hour >= 0 && hour < 5) userBucket.nightCount += 1;
    const words = extractSafeKeywords(plainText);
    for (const w of words) {
      if (Object.hasOwn(day.words, w)) {
        day.words[w] += 1;
      } else if (Object.keys(day.words).length < 240) {
        day.words[w] = 1;
      }
    }
    this.scheduleSave();
  }

  getDailyReportData(groupId, dateText = beijingDateParts(this.now()).dateText) {
    this.flush();
    const gid = String(groupId || '').trim();
    const day = this.state.activity?.[gid]?.[dateText];
    if (!day) {
      return { groupId: gid, dateText, totalMessages: 0, activeMembers: 0, topTalkers: [], nightOwls: [], hotWords: [] };
    }
    const members = Object.entries(day.users || {}).map(([userId, stat]) => ({
      userId,
      name: stat.name || `QQ ${userId}`,
      count: Number(stat.count || 0),
      nightCount: Number(stat.nightCount || 0)
    }));
    const topTalkers = [...members].sort((a, b) => b.count - a.count).slice(0, 5);
    const nightOwls = members.filter(m => m.nightCount > 0).sort((a, b) => b.nightCount - a.nightCount).slice(0, 5);
    const hotWords = Object.entries(day.words || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([word, count]) => ({ word, count }));
    return {
      groupId: gid,
      dateText,
      totalMessages: Number(day.total || 0),
      activeMembers: members.length,
      topTalkers,
      nightOwls,
      hotWords
    };
  }

  // ---- Fortunes cache ----
  getFortune(userId, dateText = beijingDateParts(this.now()).dateText) {
    return this.state.fortunes?.[dateText]?.[String(userId || '')] || null;
  }

  setFortune(userId, record, dateText = beijingDateParts(this.now()).dateText) {
    const uid = String(userId || '').trim();
    if (!uid) return;
    (this.state.fortunes[dateText] ||= {})[uid] = record;
    this.save();
  }

  // ---- Gacha stats ----
  getUserGachaStats(scopeKey, userId, gameId) {
    const u = this.state.gacha?.[scopeKey]?.[String(userId)]?.games?.[gameId];
    return u ? { ...u } : { pity: 0, guaranteed: false, totalPulls: 0, fiveStars: 0, fourStars: 0, doubleGoldCount: 0 };
  }

  saveUserGachaStats(scopeKey, userId, userName, gameId, stats) {
    const bucket = (this.state.gacha[scopeKey] ||= {});
    const user = (bucket[String(userId)] ||= { name: '', games: {} });
    if (userName) user.name = String(userName).trim().slice(0, 40);
    user.games[gameId] = { ...stats };
    this.save();
  }

  gachaLeaderboard(scopeKey, limit = 8) {
    const bucket = this.state.gacha?.[scopeKey] || {};
    const rows = [];
    for (const [userId, user] of Object.entries(bucket)) {
      let totalPulls = 0, fiveStars = 0, doubleGoldCount = 0;
      for (const g of Object.values(user.games || {})) {
        totalPulls += Number(g.totalPulls || 0);
        fiveStars += Number(g.fiveStars || 0);
        doubleGoldCount += Number(g.doubleGoldCount || 0);
      }
      if (totalPulls > 0) {
        const rate = fiveStars / totalPulls;
        rows.push({
          userId,
          name: user.name || `QQ ${userId}`,
          totalPulls,
          fiveStars,
          doubleGoldCount,
          ratePct: (rate * 100).toFixed(2)
        });
      }
    }
    return rows.sort((a, b) => (b.fiveStars / b.totalPulls) - (a.fiveStars / a.totalPulls) || b.fiveStars - a.fiveStars).slice(0, limit);
  }
}

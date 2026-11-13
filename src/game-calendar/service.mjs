import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writePrivate } from '../config.mjs';
import { games, gameInfo, normalizeGame } from '../subscriptions/games.mjs';
import { readGameFeed } from '../subscriptions/game-feeds.mjs';
import { plainText } from '../subscriptions/feeds.mjs';
import { runLinkWorker } from '../social-links.mjs';

export const activityKinds = {
  activity: '版本活动',
  banner: '卡池／唤取',
  livestream: '前瞻直播',
  version: '版本更新'
};

export function defaultCalendarSettings() {
  return {
    enabled: true,
    renderCard: true,
    autoSync: true,
    enabledGames: games.map(g => g.id)
  };
}

export function starterRedeemCodes() {
  return [
    { id: 'seed-wuwa-1', game: 'wuwa', code: 'MINGCHAO', reward: '星声×50、贝币×10000、高级共鸣促剂×2', expiresAt: '', note: '国服常驻兑换码', source: 'builtin', enabled: true },
    { id: 'seed-zzz-1', game: 'zzz', code: 'ZZZFREE100', reward: '菲林×50、丁尼×10000、资深调查员记录×2', expiresAt: '', note: '常驻福利兑换码', source: 'builtin', enabled: true },
    { id: 'seed-ak-1', game: 'arknights', code: 'GWSIX6JJA25P4QEK', reward: '龙门币×20000、作战记录、家具零件', expiresAt: '', note: '森空岛／官网兑换页使用', source: 'builtin', enabled: true }
  ];
}

export function starterActivities() {
  return [
    { id: 'seed-act-wuwa', game: 'wuwa', title: '「长航的星辉」版本主题活动与限时唤取', kind: 'activity', startAt: '2026-10-24 10:00', endAt: '2026-11-20 03:59', summary: '参与版本主题活动可获取星声、特级调谐器与活动限定奖励。', link: 'https://mc.kurogames.com/main/news', source: 'builtin' },
    { id: 'seed-act-zzz', game: 'zzz', title: '全新放送签到与限时独家频段调频', kind: 'banner', startAt: '2026-10-25 10:00', endAt: '2026-11-18 14:59', summary: '累计登录可领加密母带×10，同期开启限定代理人调频。', link: 'https://zzz.mihoyo.com/news', source: 'builtin' },
    { id: 'seed-act-ak', game: 'arknights', title: 'SideStory 主题活动关卡与限时寻访开启', kind: 'activity', startAt: '2026-10-28 16:00', endAt: '2026-11-18 03:59', summary: '活动商店与代币兑换开放，完成后请注意及时兑换奖励。', link: 'https://ak.hypergryph.com/news', source: 'builtin' },
    { id: 'seed-act-endfield', game: 'endfield', title: '塔卫二开拓研发通讯与版本前瞻动态', kind: 'version', startAt: '2026-10-26 12:00', endAt: '', summary: '关注官方最新实机演示、测试招募与版本开发进展。', link: 'https://endfield.hypergryph.com/news', source: 'builtin' }
  ];
}

export function parseBeijingTime(value) {
  if (!value || typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T23:59:59+08:00`);
    return Number.isFinite(ms) ? ms : null;
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
    const normalized = text.replace(' ', 'T') + (text.length === 16 ? ':00+08:00' : '+08:00');
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function formatBeijingNow(nowMs = Date.now()) {
  const shifted = new Date(nowMs + 8 * 3600 * 1000);
  return shifted.toISOString().slice(0, 16).replace('T', ' ');
}

export function remainingInfo(targetStr, nowMs = Date.now(), startStr = '') {
  const startMs = parseBeijingTime(startStr);
  if (startMs && startMs > nowMs) {
    const diff = startMs - nowMs;
    const days = Math.floor(diff / 86400000);
    const hours = Math.max(1, Math.floor((diff % 86400000) / 3600000));
    return { status: 'upcoming', badge: days > 0 ? `${days}天后开启` : `${hours}小时后开启`, tone: 'info', expired: false };
  }
  const endMs = parseBeijingTime(targetStr);
  if (!endMs) return { status: 'permanent', badge: '长期有效', tone: 'active', expired: false };
  const diff = endMs - nowMs;
  if (diff <= 0) return { status: 'expired', badge: '已结束', tone: 'muted', expired: true };
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days === 0) {
    return { status: 'ending', badge: `剩余 ${Math.max(1, hours)} 小时`, tone: 'urgent', expired: false };
  }
  if (days <= 3) {
    return { status: 'ending', badge: `剩余 ${days}天${hours}小时`, tone: 'urgent', expired: false };
  }
  return { status: 'active', badge: `剩余 ${days} 天`, tone: 'active', expired: false };
}

export function classifyActivityKind(title = '', summary = '', rawKind = '') {
  if (rawKind === 'livestream' || /前瞻|特别节目|直播/.test(title)) return 'livestream';
  if (/寻访|调频|唤取|招募|卡池|概率提升/.test(title)) return 'banner';
  if (/版本更新|停机维护|更新公告|预下载|制作组通讯|研发通讯/.test(title)) return 'version';
  return 'activity';
}

export function extractDateRangeFromText(text = '', referenceYear = new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear()) {
  const source = String(text || '');
  const fullRange = /(\d{4})[./年-](\d{1,2})[./月-](\d{1,2})日?\s*(\d{1,2}:\d{2})?\s*(?:~|～|-|—|至)\s*(?:(\d{4})[./年-])?(\d{1,2})[./月-](\d{1,2})日?\s*(\d{1,2}:\d{2})?/.exec(source);
  if (fullRange) {
    const [, y1, m1, d1, t1, y2, m2, d2, t2] = fullRange;
    const startYear = Number(y1);
    const endYear = y2 ? Number(y2) : (Number(m2) < Number(m1) ? startYear + 1 : startYear);
    const startAt = `${startYear}-${String(m1).padStart(2, '0')}-${String(d1).padStart(2, '0')}${t1 ? ' ' + t1.padStart(5, '0') : ''}`;
    const endAt = `${endYear}-${String(m2).padStart(2, '0')}-${String(d2).padStart(2, '0')}${t2 ? ' ' + t2.padStart(5, '0') : ' 03:59'}`;
    return { startAt, endAt };
  }
  const shortRange = /(\d{1,2})[./月](\d{1,2})日?\s*(\d{1,2}:\d{2})?\s*(?:~|～|-|—|至)\s*(\d{1,2})[./月](\d{1,2})日?\s*(\d{1,2}:\d{2})?/.exec(source);
  if (shortRange) {
    const [, m1, d1, t1, m2, d2, t2] = shortRange;
    const endYear = Number(m2) < Number(m1) ? referenceYear + 1 : referenceYear;
    const startAt = `${referenceYear}-${String(m1).padStart(2, '0')}-${String(d1).padStart(2, '0')}${t1 ? ' ' + t1.padStart(5, '0') : ''}`;
    const endAt = `${endYear}-${String(m2).padStart(2, '0')}-${String(d2).padStart(2, '0')}${t2 ? ' ' + t2.padStart(5, '0') : ' 03:59'}`;
    return { startAt, endAt };
  }
  return { startAt: '', endAt: '' };
}

export function extractCodesFromText(text = '') {
  const source = String(text || '');
  const found = new Set();
  for (const match of source.matchAll(/(?:兑换码|礼包码|福利码)[123一二三]?[：:\s「『【]*([A-Z0-9]{6,20})/gi)) {
    const code = match[1].toUpperCase();
    if (!/^\d+$/.test(code) && !/^HTTP/.test(code)) found.add(code);
  }
  return [...found].slice(0, 10);
}

function validateSettings(input, current = defaultCalendarSettings()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('日历插件配置格式错误');
  const base = { ...defaultCalendarSettings(), ...current };
  const enabled = input.enabled === undefined ? base.enabled : input.enabled;
  const renderCard = input.renderCard === undefined ? base.renderCard : input.renderCard;
  const autoSync = input.autoSync === undefined ? base.autoSync : input.autoSync;
  if (typeof enabled !== 'boolean' || typeof renderCard !== 'boolean' || typeof autoSync !== 'boolean') {
    throw new Error('插件开关选项必须为布尔值');
  }
  let enabledGames = base.enabledGames;
  if (input.enabledGames !== undefined) {
    if (!Array.isArray(input.enabledGames) || !input.enabledGames.length) throw new Error('请至少启用一款游戏');
    enabledGames = [...new Set(input.enabledGames.map(g => normalizeGame(g)))];
  }
  return { enabled, renderCard, autoSync, enabledGames };
}

export class GameCalendarService {
  constructor(dataDir, store, { now = Date.now, readFeed = readGameFeed, worker = runLinkWorker, log = () => {} } = {}) {
    Object.assign(this, { dataDir, store, now, readFeed, worker, log });
    this.dir = join(dataDir, 'game-calendar');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.filePath = join(this.dir, 'state.json');
    this.state = this.load();
    this.syncing = false;
  }
  load() {
    if (!existsSync(this.filePath)) {
      const initial = {
        initialized: true,
        settings: defaultCalendarSettings(),
        codes: starterRedeemCodes(),
        activities: starterActivities(),
        lastSyncAt: null,
        lastSyncError: ''
      };
      writePrivate(this.filePath, initial);
      return initial;
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return {
        initialized: true,
        settings: validateSettings(raw?.settings || {}, defaultCalendarSettings()),
        codes: Array.isArray(raw?.codes) ? raw.codes : starterRedeemCodes(),
        activities: Array.isArray(raw?.activities) ? raw.activities : starterActivities(),
        lastSyncAt: raw?.lastSyncAt || null,
        lastSyncError: String(raw?.lastSyncError || '')
      };
    } catch {
      return {
        initialized: true,
        settings: defaultCalendarSettings(),
        codes: starterRedeemCodes(),
        activities: starterActivities(),
        lastSyncAt: null,
        lastSyncError: ''
      };
    }
  }
  save() {
    writePrivate(this.filePath, this.state);
  }
  configure(patch) {
    this.state.settings = validateSettings(patch, this.state.settings);
    this.save();
    return this.status();
  }
  upsertCode(input, id = '') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('兑换码格式错误');
    const game = normalizeGame(input.game);
    const code = String(input.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{4,32}$/.test(code)) throw new Error('兑换码需为 4–32 位字母、数字、下划线或短横线');
    const reward = plainText(String(input.reward || '游戏内道具奖励'), 160) || '游戏内道具奖励';
    const note = plainText(String(input.note || ''), 120);
    const expiresAt = String(input.expiresAt || '').trim();
    if (expiresAt && !parseBeijingTime(expiresAt)) throw new Error('截止时间格式无效，请使用 YYYY-MM-DD HH:MM 或留空表示长期有效');
    const enabled = input.enabled !== false;
    const duplicate = this.state.codes.find(item => item.id !== id && item.game === game && item.code.toUpperCase() === code);
    if (duplicate) throw new Error(`${gameInfo(game).name}已存在兑换码 ${code}`);

    if (id) {
      const index = this.state.codes.findIndex(item => item.id === id);
      if (index === -1) throw Object.assign(new Error('兑换码不存在'), { status: 404 });
      this.state.codes[index] = { ...this.state.codes[index], game, code, reward, note, expiresAt, enabled };
    } else {
      if (this.state.codes.length >= 200) throw new Error('最多保存 200 条兑换码');
      this.state.codes.unshift({ id: randomUUID(), game, code, reward, note, expiresAt, source: 'manual', enabled });
    }
    this.save();
    return this.status();
  }
  removeCode(id) {
    const before = this.state.codes.length;
    this.state.codes = this.state.codes.filter(item => item.id !== id);
    if (this.state.codes.length === before) throw Object.assign(new Error('兑换码不存在'), { status: 404 });
    this.save();
    return this.status();
  }
  upsertActivity(input, id = '') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('活动日程格式错误');
    const game = normalizeGame(input.game);
    const title = plainText(String(input.title || ''), 160);
    if (!title) throw new Error('请填写活动或卡池名称');
    const kind = Object.hasOwn(activityKinds, input.kind) ? input.kind : 'activity';
    const startAt = String(input.startAt || '').trim();
    const endAt = String(input.endAt || '').trim();
    if (startAt && !parseBeijingTime(startAt)) throw new Error('开始时间格式无效，请使用 YYYY-MM-DD HH:MM');
    if (endAt && !parseBeijingTime(endAt)) throw new Error('结束时间格式无效，请使用 YYYY-MM-DD HH:MM');
    const summary = plainText(String(input.summary || ''), 300);
    const link = String(input.link || '').trim().slice(0, 500);
    if (id) {
      const index = this.state.activities.findIndex(item => item.id === id);
      if (index === -1) throw Object.assign(new Error('活动日程不存在'), { status: 404 });
      this.state.activities[index] = { ...this.state.activities[index], game, title, kind, startAt, endAt, summary, link };
    } else {
      if (this.state.activities.length >= 200) throw new Error('最多保存 200 条活动日程');
      this.state.activities.unshift({ id: randomUUID(), game, title, kind, startAt, endAt, summary, link, source: 'manual', publishedAt: new Date(this.now()).toISOString() });
    }
    this.save();
    return this.status();
  }
  removeActivity(id) {
    const before = this.state.activities.length;
    this.state.activities = this.state.activities.filter(item => item.id !== id);
    if (this.state.activities.length === before) throw Object.assign(new Error('活动日程不存在'), { status: 404 });
    this.save();
    return this.status();
  }
  async syncOfficial(targetGame = '') {
    if (this.syncing) throw Object.assign(new Error('正在同步官方活动，请稍候'), { status: 429 });
    this.syncing = true;
    const targets = targetGame ? [normalizeGame(targetGame)] : (this.state.settings.enabledGames?.length ? this.state.settings.enabledGames : games.map(g => g.id));
    const errors = [];
    let syncedCount = 0;
    try {
      for (const gameId of targets) {
        try {
          const feed = await this.readFeed(gameId, { rsshubUrl: 'https://rsshub.app' }, {});
          const items = (feed?.items || []).slice(0, 12);
          const freshOfficial = [];
          for (const item of items) {
            const combined = `${item.title || ''}\n${item.summary || ''}`;
            const dates = extractDateRangeFromText(combined);
            const pubClock = item.publishedAt ? formatBeijingNow(Date.parse(item.publishedAt)) : '';
            freshOfficial.push({
              id: `official-${item.id.slice(0, 24)}`,
              game: gameId,
              title: plainText(item.title, 160),
              kind: classifyActivityKind(item.title, item.summary, item.kind),
              startAt: dates.startAt || pubClock,
              endAt: dates.endAt || '',
              summary: plainText(item.summary, 260),
              link: item.link || gameInfo(gameId).website,
              source: 'official',
              publishedAt: item.publishedAt || new Date(this.now()).toISOString()
            });
            for (const code of extractCodesFromText(combined)) {
              if (!this.state.codes.some(c => c.game === gameId && c.code.toUpperCase() === code)) {
                this.state.codes.unshift({
                  id: randomUUID(),
                  game: gameId,
                  code,
                  reward: `官方公告提取 · ${plainText(item.title, 60)}`,
                  expiresAt: dates.endAt || '',
                  note: '自动从官方前瞻／公告提取',
                  source: 'official',
                  enabled: true
                });
              }
            }
          }
          if (freshOfficial.length) {
            const kept = this.state.activities.filter(act => act.game !== gameId || act.source === 'manual');
            this.state.activities = [...freshOfficial, ...kept].slice(0, 200);
            syncedCount += freshOfficial.length;
          }
        } catch (error) {
          errors.push(`${gameInfo(gameId)?.name || gameId}：${error.message}`);
        }
      }
      this.state.lastSyncAt = new Date(this.now()).toISOString();
      this.state.lastSyncError = errors.join('；');
      this.save();
      return { ...this.status(), syncedCount, warnings: errors };
    } finally {
      this.syncing = false;
    }
  }
  status() {
    const nowMs = this.now();
    const codes = this.state.codes.map(item => {
      const rem = remainingInfo(item.expiresAt, nowMs);
      return {
        ...item,
        gameName: gameInfo(item.game)?.name || item.game,
        status: !item.enabled ? 'disabled' : rem.status,
        statusLabel: !item.enabled ? '已停用' : rem.badge,
        expired: rem.expired
      };
    });
    const activities = this.state.activities.map(item => {
      const rem = remainingInfo(item.endAt, nowMs, item.startAt);
      return {
        ...item,
        gameName: gameInfo(item.game)?.name || item.game,
        kindLabel: activityKinds[item.kind] || '版本活动',
        status: rem.status,
        statusLabel: item.endAt ? rem.badge : (item.startAt ? `发布于 ${item.startAt.slice(0, 10)}` : '最新资讯'),
        expired: rem.expired
      };
    });
    return {
      settings: this.state.settings,
      games: games.map(g => ({ id: g.id, name: g.name, color: g.color, enabled: this.state.settings.enabledGames.includes(g.id) })),
      codes,
      activities,
      summary: {
        activeCodes: codes.filter(item => item.enabled !== false && !item.expired).length,
        activeActivities: activities.filter(item => !item.expired).length
      },
      lastSyncAt: this.state.lastSyncAt,
      lastSyncError: this.state.lastSyncError
    };
  }
  buildView(mode = 'codes', gameFilter = '') {
    const nowMs = this.now();
    const generatedAt = `${formatBeijingNow(nowMs)}（北京时间）`;
    const targetGames = gameFilter
      ? [gameInfo(normalizeGame(gameFilter))]
      : games.filter(g => this.state.settings.enabledGames.includes(g.id));

    if (mode === 'codes') {
      const sections = [];
      const textBlocks = [];
      for (const game of targetGames) {
        const list = this.state.codes.filter(item => item.game === game.id && item.enabled !== false);
        const active = list.filter(item => !remainingInfo(item.expiresAt, nowMs).expired);
        const items = active.slice(0, 8).map(item => {
          const rem = remainingInfo(item.expiresAt, nowMs);
          const secondary = [item.reward, item.note, item.expiresAt ? `截止：${item.expiresAt}` : '长期有效'].filter(Boolean).join(' · ');
          return { badge: rem.badge, tone: rem.tone, primary: item.code, secondary };
        });
        sections.push({ game: game.name, color: game.color, items, emptyText: '当前暂无可用兑换码，可在后台补充' });
        if (active.length) {
          textBlocks.push(`【${game.name}】\n` + active.slice(0, 8).map(item => {
            const rem = remainingInfo(item.expiresAt, nowMs);
            return `• ${item.code}（${rem.badge}）\n  奖励：${item.reward}${item.note ? ` · ${item.note}` : ''}`;
          }).join('\n'));
        } else if (gameFilter) {
          textBlocks.push(`【${game.name}】\n• 当前暂无可用兑换码`);
        }
      }
      const title = gameFilter ? `${targetGames[0].name} · 兑换码速查` : '游戏兑换码速查';
      const subtitle = targetGames.map(g => g.name).join(' · ');
      const text = `${title}\n更新时间：${generatedAt}\n\n${textBlocks.join('\n\n') || '当前暂无可用兑换码，管理员可在「插件 → 游戏兑换码与日历」中添加。'}\n\n提示：发送「/兑换码 游戏名」筛选单款游戏，或发送「/日历」查看活动倒计时。`;
      return {
        mode: 'codes',
        title,
        subtitle,
        generatedAt,
        footer: '发送「/兑换码 游戏名」或「/日历 游戏名」按游戏筛选 · 群屿助手',
        sections,
        text
      };
    }

    const sections = [];
    const textBlocks = [];
    for (const game of targetGames) {
      const list = this.state.activities.filter(item => item.game === game.id);
      const active = list.filter(item => !item.endAt || !remainingInfo(item.endAt, nowMs, item.startAt).expired);
      const items = active.slice(0, 6).map(item => {
        const rem = remainingInfo(item.endAt, nowMs, item.startAt);
        const kindLabel = activityKinds[item.kind] || '活动';
        const badge = item.endAt ? `${kindLabel} · ${rem.badge}` : kindLabel;
        const timeRange = item.startAt && item.endAt
          ? `${item.startAt} ~ ${item.endAt}`
          : item.endAt ? `截止：${item.endAt}` : item.startAt ? `时间：${item.startAt}` : '官方最新活动资讯';
        const secondary = [timeRange, item.summary].filter(Boolean).join(' ｜ ');
        return { badge, tone: item.endAt ? rem.tone : 'info', primary: item.title, secondary };
      });
      sections.push({ game: game.name, color: game.color, items, emptyText: '当前暂无进行中的活动记录' });
      if (active.length) {
        textBlocks.push(`【${game.name}】\n` + active.slice(0, 6).map(item => {
          const rem = remainingInfo(item.endAt, nowMs, item.startAt);
          const kindLabel = activityKinds[item.kind] || '活动';
          const status = item.endAt ? rem.badge : (item.startAt ? item.startAt.slice(0, 10) : '进行中');
          return `• [${kindLabel} · ${status}] ${item.title}${item.endAt ? `\n  截止：${item.endAt}` : ''}`;
        }).join('\n'));
      } else if (gameFilter) {
        textBlocks.push(`【${game.name}】\n• 当前暂无进行中的活动记录`);
      }
    }
    const title = gameFilter ? `${targetGames[0].name} · 活动与卡池日历` : '游戏活动与卡池日历';
    const subtitle = targetGames.map(g => g.name).join(' · ');
    const text = `${title}\n更新时间：${generatedAt}\n\n${textBlocks.join('\n\n') || '当前暂无活动记录。'}\n\n提示：发送「/日历 游戏名」查看指定游戏，或发送「/兑换码」查看可用礼包码。`;
    return {
      mode: 'calendar',
      title,
      subtitle,
      generatedAt,
      footer: '发送「/日历 游戏名」或「/兑换码 游戏名」按游戏筛选 · 群屿助手',
      sections,
      text
    };
  }
  async renderCardImage(view, { signal } = {}) {
    signal?.throwIfAborted();
    const directory = mkdtempSync(join(tmpdir(), 'qqbot-game-calendar-card-'));
    try {
      const result = await this.worker({
        action: 'game_calendar_card',
        directory,
        title: view.title,
        subtitle: view.subtitle,
        generatedAt: view.generatedAt,
        footer: view.footer,
        sections: view.sections
      }, { signal, timeout: 20, cwd: directory });
      signal?.throwIfAborted();
      const path = join(directory, 'card.png');
      if (result?.card !== 'card.png' || statSync(path).size > 10 * 1024 * 1024) throw new Error('日历卡片生成无效');
      const bytes = readFileSync(path);
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('日历卡片格式无效');
      const base64 = bytes.toString('base64');
      return { file: `base64://${base64}`, dataUrl: `data:image/png;base64,${base64}` };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  async preview(mode = 'codes', gameFilter = '') {
    const view = this.buildView(mode === 'calendar' ? 'calendar' : 'codes', gameFilter);
    let card = null, warning = '';
    if (this.state.settings.renderCard !== false) {
      try {
        card = (await this.renderCardImage(view)).dataUrl;
      } catch (error) {
        warning = `高清卡片渲染失败（${error.message}），群聊将自动回退为纯文本发送。`;
      }
    }
    return { ...view, card, warning };
  }
}

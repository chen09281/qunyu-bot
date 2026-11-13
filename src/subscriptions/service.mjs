import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { groupRule } from '../bot.mjs';
import { normalizeSource, parserSetupMessage, readFeed, rsshubBase, sourceTypes } from './feeds.mjs';
import { creatorName, creatorMatches, preferredDouyin, prioritySourceHealthy } from './creator-priority.mjs';
import { gameInfo } from './games.mjs';
import { internalRsshubBase } from './rsshub.mjs';
import { readDouyinFeed } from './douyin-feed.mjs';
import { subscriptionMessage } from './message.mjs';
import { staleSubscriptionReason } from './freshness.mjs';
import { quarantineCorruptFile } from '../security.mjs';

const defaults = () => ({ enabled: false, intervalMinutes: 10, rsshubUrl: 'https://rsshub.app' });
const cancelled = () => Object.assign(new Error('订阅任务已取消'), { cancelled: true });
function readFailure(error, entry) {
  if (error.code === 'RSS_PARSER_MISSING') return parserSetupMessage;
  if (entry.type === 'douyin' && error.code?.startsWith('DOUYIN_')) return error.code === 'DOUYIN_BROWSER_MISSING'
    ? '抖音订阅浏览器不可用，请安装 Chromium 或检查 RSSHub 抖音路由'
    : `${error.code === 'DOUYIN_TIMEOUT' ? '抖音主页读取超时' : error.code === 'DOUYIN_NETWORK' ? '抖音主页连接失败' : '抖音未返回该博主的有效作品'}；请在「链接解析 → 抖音登录」检查或更新登录态；若出现安全验证，请先在官方页面完成验证后重试`;
  const reason = error.code === 'ETIMEDOUT' ? '读取超时' : error.code === 'UPSTREAM_HTTP' && Number.isInteger(error.statusCode) ? `上游返回 HTTP ${error.statusCode}`
    : error.code === 'FEED_HTML' ? '上游返回网页或登录页，未返回 RSS' : error.code === 'FEED_FORMAT' ? 'RSS / Atom 格式无效' : '消息源读取失败';
  return `${reason}；${entry.type === 'game' ? '请检查官网连通性及 RSSHub 的 B 站动态路由' : '请检查网络及 RSSHub 对应路由，登录态需在自建实例中配置'}`;
}
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error('订阅配置格式无效');
}
function text(value, label, limit, empty = false) {
  if (typeof value !== 'string' || value.length > limit || !empty && !value.trim()) throw new Error(`${label}格式无效，最多 ${limit} 字符`);
  return value.trim();
}
const matches = (item, entry) => {
  const content = `${item.title}\n${item.summary}`.toLocaleLowerCase();
  const words = value => value.split(/[,，\n]/).map(s => s.trim().toLocaleLowerCase()).filter(Boolean);
  return (!entry.include || words(entry.include).some(w => content.includes(w))) && !words(entry.exclude).some(w => content.includes(w));
};
function appendWarning(entry, warning) {
  entry.lastWarning = [...new Set([...(entry.lastWarning || '').split('\n'), ...String(warning || '').split('\n')].filter(Boolean))].join('\n');
}

export class SubscriptionService {
  constructor(dataDir, store, { onebot, log = () => {}, fetchFeed = readFeed, prepareMessage = subscriptionMessage, preparePreview, downloadVideo, selfId, cookies, readDouyin = (source, options) => readDouyinFeed(source, { ...options, cookies }), readBilibili = null, onHealthChange = () => {}, onHealthReset = () => {}, now = Date.now, rsshubInternalUrl = process.env.RSSHUB_INTERNAL_URL } = {}) {
    this.store = store; this.onebot = onebot; this.log = log; this.fetchFeed = fetchFeed; this.now = now;
    this.prepareMessage = prepareMessage; this.preparePreview = preparePreview || prepareMessage; this.downloadVideo = downloadVideo; this.selfId = selfId; this.readDouyin = readDouyin; this.readBilibili = readBilibili;
    this.onHealthChange = onHealthChange; this.onHealthReset = onHealthReset;
    this.rsshubInternalUrl = internalRsshubBase(rsshubInternalUrl);
    this.activeReads = 0; this.readWaiters = []; this.diagnostics = new Map(); this.healthProbes = new Map();
    this.closed = false; this.busy = false; this.probeBusy = 0; this.revision = 0; this.controllers = new Set(); this.previews = 0;
    const dir = join(dataDir, 'subscriptions');
    this.path = join(dir, 'state.json');
    for (const path of [dir, this.path]) {
      try { if (lstatSync(path).isSymbolicLink()) throw new Error('订阅数据不能是符号链接'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    this.state = { version: 1, deliveryVersion: 2, settings: defaults(), entries: [] };
    if (existsSync(this.path)) {
      let state = null;
      try {
        state = JSON.parse(readFileSync(this.path, 'utf8'));
        if (state.version !== 1 || !state.settings || !Array.isArray(state.entries) || state.entries.length > 100) throw new Error('格式校验失败');
      } catch (error) {
        const backup = quarantineCorruptFile(this.path);
        console.error(`[subscriptions] 订阅状态文件损坏，已隔离至 ${backup || this.path}: ${error.message}`);
        state = null;
      }
      if (state) {
        this.state = state; chmodSync(this.path, 0o600);
        if (this.state.deliveryVersion !== 2) {
          // New official Douyin reads and Bilibili dynamics should be checked on
          // upgrade, rather than waiting hours for the old failing route's backoff.
          for (const entry of this.state.entries) if (['douyin', 'bilibili'].includes(entry.type)) entry.nextCheckAt = 0;
          this.state.deliveryVersion = 2; this.save();
        }
      }
    }
    // Clean persisted historical deliveries on startup, even while the plugin
    // is disabled. Normal retry progress for current updates stays intact.
    if (this.state.entries.map(entry => this.pruneHistorical(entry)).some(Boolean)) this.save();
  }
  save() {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600, flag: 'wx' }); renameSync(temp, this.path);
  }
  diagnosticsFor(entry) {
    if (!this.diagnostics.has(entry.id)) this.diagnostics.set(entry.id, { reads: 0, readFailures: 0, lastReadMs: null,
      mediaPreparations: 0, mediaFailures: 0, cardFallbacks: 0, lastMediaPrepareMs: 0, qqUploads: 0, qqUploadFailures: 0, lastQqUploadMs: 0 });
    return this.diagnostics.get(entry.id);
  }
  mutate(change) {
    const before = structuredClone(this.state);
    try { change(); this.save(); } catch (error) { this.state = before; throw error; }
  }
  status() {
    return { settings: { ...this.state.settings }, managedRsshub: Boolean(this.rsshubInternalUrl), active: this.busy, entries: this.state.entries.map(entry => ({
      id: entry.id, name: entry.name, type: entry.type, source: entry.source, groups: [...entry.groups], enabled: entry.enabled,
      ...this.priority(entry),
      include: entry.include, exclude: entry.exclude, createdAt: entry.createdAt, initializedAt: entry.initializedAt,
      checkedAt: entry.checkedAt, lastSuccessAt: entry.lastSuccessAt, lastError: entry.lastError, lastTitle: entry.lastTitle,
      lastWarning: entry.lastWarning || '',
      skippedHistorical: entry.skippedHistorical || 0,
      lastReadAt: entry.lastReadAt || null, nextCheckAt: entry.nextCheckAt || null,
      failures: entry.failures || 0, lastFailureStage: entry.lastFailureStage || '', lastReadFailed: Boolean(entry.lastReadFailed),
      lastFallbacks: [...(entry.lastFallbacks || [])], lastChannels: [...(entry.lastChannels || [])], probe: this.healthProbes.get(entry.id) || null,
      sent: entry.sent, pending: entry.pending.reduce((n, item) => n + item.groups.filter(g => !item.delivered.includes(g) && entry.groups.includes(g)).length, 0),
      unauthorizedGroups: entry.groups.filter(g => !groupRule(this.store.config, g).allowed),
      ...(this.diagnostics.has(entry.id) ? { diagnostics: { ...this.diagnostics.get(entry.id) } } : {}),
    })) };
  }
  configure(input) {
    object(input, ['enabled', 'intervalMinutes', 'rsshubUrl']);
    const next = { ...this.state.settings };
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw new Error('订阅插件开关必须为布尔值'); next.enabled = input.enabled;
    }
    if (input.intervalMinutes !== undefined) {
      if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 5 || input.intervalMinutes > 1440) throw new Error('检查间隔需为 5–1440 分钟');
      next.intervalMinutes = input.intervalMinutes;
    }
    if (input.rsshubUrl !== undefined) next.rsshubUrl = rsshubBase(input.rsshubUrl);
    this.cancel();
    this.mutate(() => { this.state.settings = next; for (const entry of this.state.entries) entry.nextCheckAt = 0; });
    return this.status();
  }
  get(id) {
    const entry = this.state.entries.find(e => e.id === id);
    if (!entry) throw Object.assign(new Error('订阅不存在'), { status: 404 }); return entry;
  }
  validate(input, previous) {
    object(input, ['name', 'type', 'source', 'groups', 'enabled', 'include', 'exclude', 'crossPlatformMatch']);
    const entry = { crossPlatformMatch: true, ...(previous || { enabled: true, include: '', exclude: '' }), ...input };
    const type = text(entry.type, '订阅类型', 20), source = normalizeSource(type, entry.source), name = text(entry.name, '订阅名称', 80);
    if (typeof entry.enabled !== 'boolean') throw new Error('单条订阅开关必须为布尔值');
    if (typeof entry.crossPlatformMatch !== 'boolean') throw new Error('同名跨平台匹配开关必须为布尔值');
    if (!Array.isArray(entry.groups) || !entry.groups.length || entry.groups.length > 20 || entry.groups.some(g => typeof g !== 'string' || !/^\d{5,20}$/.test(g))) throw new Error('请选择 1–20 个授权群');
    const groups = [...new Set(entry.groups)];
    for (const group of groups) if (!groupRule(this.store.config, group).allowed && !previous?.groups.includes(group)) throw new Error('推送目标必须在群聊白名单中');
    if (this.state.entries.some(e => e.id !== previous?.id && e.type === type && e.source === source)) throw new Error('该来源已订阅，请编辑已有订阅的推送群');
    return { name, type, source, groups, enabled: entry.enabled, crossPlatformMatch: entry.crossPlatformMatch,
      include: text(entry.include, '包含关键词', 200, true), exclude: text(entry.exclude, '排除关键词', 200, true) };
  }
  upsert(input, id) {
    const previous = id ? this.get(id) : null, value = this.validate(input, previous);
    if (!id && this.state.entries.length >= 100) throw new Error('最多保存 100 条订阅');
    const changedSource = previous && (previous.type !== value.type || previous.source !== value.source);
    this.cancel();
    this.mutate(() => {
      const entry = previous || { id: randomUUID(), createdAt: new Date(this.now()).toISOString(), sent: 0 };
      if (!previous || changedSource) Object.assign(entry, { seen: [], pending: [], initializedAt: null, checkedAt: null,
        lastSuccessAt: null, lastReadAt: null, lastReadFailed: false, lastFailureStage: '', lastError: '', lastWarning: '', lastFallbacks: [], lastChannels: [], lastTitle: '', failures: 0, gameBaselines: [], bilibiliBaselines: [] });
      if (changedSource) this.onHealthReset(id);
      Object.assign(entry, value, { nextCheckAt: 0 });
      // A removed target must never receive queued items if it is later added again.
      for (const item of entry.pending) item.groups = item.groups.filter(g => value.groups.includes(g));
      entry.pending = entry.pending.filter(item => item.groups.some(g => !item.delivered.includes(g)));
      if (!previous) this.state.entries.push(entry);
      this.pruneSuppressed();
    });
    return this.status();
  }
  remove(id) {
    this.get(id); this.cancel(); this.diagnostics.delete(id); this.healthProbes.delete(id); this.onHealthReset(id); this.mutate(() => { this.state.entries = this.state.entries.filter(e => e.id !== id); });
    return this.status();
  }
  subscribeGroup({ type, source }, group) {
    group = String(group); source = normalizeSource(type, source);
    if (!groupRule(this.store.config, group).allowed) throw new Error('当前群未获授权');
    const previous = this.state.entries.find(entry => entry.type === type && entry.source === source);
    if (previous?.groups.includes(group)) return { entry: previous, existing: true };
    const groups = [...(previous?.groups || []), group];
    this.upsert(previous ? { groups } : { type, source, groups, name: type === 'game' ? `${gameInfo(source).name} · 活动与前瞻` : `${sourceTypes[type]} · ${source}`.slice(0, 80) }, previous?.id);
    return { entry: this.state.entries.find(entry => entry.type === type && entry.source === source), existing: false };
  }
  unsubscribeGroup(id, group) {
    const entry = this.get(id); group = String(group);
    if (!groupRule(this.store.config, group).allowed || !entry.groups.includes(group)) throw new Error('当前群没有这条订阅');
    const groups = entry.groups.filter(value => value !== group);
    if (groups.length) this.upsert({ groups }, id); else this.remove(id);
  }
  enabled(entry) { return !this.closed && this.store.config.enabled && this.state.settings.enabled && entry.enabled && this.state.entries.includes(entry); }
  feedSettings() { return { ...this.state.settings, ...(this.rsshubInternalUrl ? { rsshubInternalUrl: this.rsshubInternalUrl } : {}) }; }
  async readSource(entry, signal) {
    signal.throwIfAborted();
    if (this.activeReads >= 2) await new Promise((resolve, reject) => {
      const waiting = { start: () => { signal.removeEventListener('abort', abort); this.activeReads++; resolve(); } };
      const abort = () => { this.readWaiters = this.readWaiters.filter(item => item !== waiting); reject(cancelled()); };
      signal.addEventListener('abort', abort, { once: true }); this.readWaiters.push(waiting);
    });
    else this.activeReads++;
    const metrics = this.diagnosticsFor(entry), started = Date.now(); metrics.reads++;
    try { return await this.fetchFeed(entry, this.feedSettings(), { signal, readDouyin: this.readDouyin, readBilibili: this.readBilibili }); }
    catch (error) { metrics.readFailures++; throw error; }
    finally { metrics.lastReadMs = Date.now() - started; this.activeReads--; this.readWaiters.shift()?.start(); }
  }
  priorityOptions() { return { now: this.now(), intervalMinutes: this.state.settings.intervalMinutes }; }
  priority(entry) {
    const matches = creatorMatches(entry, this.state.entries), groups = entry.groups.filter(g => groupRule(this.store.config, g).allowed);
    return { crossPlatformMatch: entry.crossPlatformMatch !== false, creatorName: creatorName(entry),
      matchedSubscriptions: matches.map(other => ({ id: other.id, type: other.type, name: creatorName(other),
        enabled: other.enabled, groups: other.groups.filter(g => entry.groups.includes(g)) })),
      suppressedGroups: entry.type === 'bilibili' && entry.enabled ? groups.filter(g => preferredDouyin(entry, this.state.entries, g, this.priorityOptions())) : [],
      fallbackGroups: entry.type === 'bilibili' && entry.enabled ? groups.filter(g => matches.some(other => other.enabled && other.groups.includes(g)) && !preferredDouyin(entry, this.state.entries, g, this.priorityOptions())) : [],
      preferredGroups: entry.type === 'douyin' && entry.enabled && prioritySourceHealthy(entry, this.priorityOptions()) ? groups.filter(g => matches.some(other => other.enabled && other.groups.includes(g))) : [] };
  }
  suppressed(entry, group, item) {
    if (entry.type === 'bilibili' && item?.channel === 'dynamic' && item.contentKind !== 'video') return false;
    return groupRule(this.store.config, group).allowed && Boolean(preferredDouyin(entry, this.state.entries, group, this.priorityOptions()));
  }
  pruneSuppressed() {
    for (const entry of this.state.entries) {
      if (entry.type !== 'bilibili') continue;
      for (const item of entry.pending) item.groups = item.groups.filter(g => !this.suppressed(entry, g, item));
      entry.pending = entry.pending.filter(item => item.groups.some(g => !item.delivered.includes(g)));
    }
  }
  pruneHistorical(entry) {
    const now = this.now(), before = entry.pending.length;
    entry.pending = entry.pending.filter(item => !staleSubscriptionReason(entry, item, now));
    const dropped = before - entry.pending.length;
    if (dropped) {
      entry.skippedHistorical = (entry.skippedHistorical || 0) + dropped;
      if (!entry.pending.length && ['sending', 'preparing'].includes(entry.lastFailureStage)) {
        entry.lastError = ''; entry.lastFailureStage = ''; entry.failures = 0;
      }
    }
    return dropped;
  }
  async identify(entry, revision) {
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const feed = await this.readSource(entry, controller.signal);
      if (this.enabled(entry) && revision === this.revision && !controller.signal.aborted) {
        this.mutate(() => { entry.lastTitle = feed.title || ''; entry.lastReadAt = new Date(this.now()).toISOString(); entry.lastReadFailed = false; entry.lastFailureStage = ''; this.pruneSuppressed(); });
      }
    } catch { if (this.enabled(entry) && revision === this.revision && !controller.signal.aborted) this.mutate(() => { entry.lastReadFailed = true; entry.lastFailureStage = 'reading'; }); }
    finally { this.controllers.delete(controller); }
  }
  async preview(id, { renderCard = false } = {}) {
    const entry = this.get(id);
    if (this.closed || this.previews >= 2) throw Object.assign(new Error('订阅源正在读取，请稍后重试'), { status: 409 });
    const controller = new AbortController(); this.controllers.add(controller); this.previews++;
    try {
      let feed;
      try { feed = await this.readSource(entry, controller.signal); }
      catch (error) { throw new Error(readFailure(error, entry)); }
      controller.signal.throwIfAborted();
      const result = { title: feed.title, items: feed.items.slice(0, 3), warnings: [...(feed.warnings || [])] };
      if (renderCard && result.items.length) {
        let prepared;
        try {
          prepared = await this.preparePreview(entry, result.items[0], { signal: controller.signal, cardOnly: true });
          controller.signal.throwIfAborted();
          const message = prepared.message || prepared.parts?.find(part => part.key === 'main')?.message || [];
          const file = message.find(part => part.type === 'image')?.data.file;
          if (/^base64:\/\/[A-Za-z0-9+/=]+$/.test(file || '')) result.card = 'data:image/png;base64,' + file.slice(9);
          result.text = message.filter(part => part.type === 'text').map(part => part.data.text).join('\n');
          if (prepared.warning) result.warnings.push(...prepared.warning.split('\n').filter(Boolean));
        } catch (error) {
          controller.signal.throwIfAborted();
          throw new Error('订阅卡片准备失败，请检查媒体下载、渲染器与字体');
        } finally { try { await prepared?.cleanup?.(); } catch {} }
      }
      return result;
    } finally { this.controllers.delete(controller); this.previews--; }
  }
  emitHealth(entry) {
    const state = entry.lastError || entry.lastReadFailed ? 'error' : entry.lastWarning || entry.lastFallbacks?.length ? 'degraded' : 'ok';
    const snapshot = { id: entry.id, name: entry.name, type: entry.type, state, error: entry.lastError || '', warning: entry.lastWarning || '',
      stage: entry.lastFailureStage || '', failures: entry.failures || 0, checkedAt: entry.checkedAt || null, nextCheckAt: entry.nextCheckAt || null,
      lastReadAt: entry.lastReadAt || null, fallbacks: [...(entry.lastFallbacks || [])] };
    Promise.resolve(this.onHealthChange(snapshot)).catch(() => {});
  }
  async probe(id) {
    const entry = this.get(id);
    if (this.closed || this.probeBusy >= 2) throw Object.assign(new Error('只读健康检查正在进行，请稍后重试'), { status: 409 });
    const controller = new AbortController(), started = Date.now(); this.controllers.add(controller); this.probeBusy++;
    let result;
    try {
      const feed = await this.readSource(entry, controller.signal);
      controller.signal.throwIfAborted();
      result = { ok: true, checkedAt: new Date(this.now()).toISOString(), title: feed.title || '', itemCount: feed.items.length,
        warnings: [...(feed.warnings || [])], channels: [...(feed.channels || [])], durationMs: Date.now() - started, error: '' };
    } catch (error) {
      if (controller.signal.aborted) throw error;
      result = { ok: false, checkedAt: new Date(this.now()).toISOString(), title: '', itemCount: 0, warnings: [], channels: [], durationMs: Date.now() - started, error: readFailure(error, entry) };
    } finally { this.controllers.delete(controller); this.probeBusy--; }
    this.healthProbes.set(id, result); return result;
  }
  async check(id) {
    if (this.busy) throw Object.assign(new Error('已有订阅任务执行中，请稍后重试'), { status: 409 });
    if (id) {
      const entry = this.get(id);
      if (!this.enabled(entry)) throw new Error('请先启用机器人、订阅插件和该条订阅');
      if (!entry.groups.some(g => groupRule(this.store.config, g).allowed)) throw new Error('该订阅没有已授权的目标群');
    }
    this.busy = true;
    try {
      const revision = this.revision;
      const selected = id ? this.get(id) : null;
      // A manual Bilibili check must also discover newly added Douyin accounts,
      // without sending updates or establishing their baseline as a side effect.
      if (selected?.type === 'bilibili' && selected.crossPlatformMatch !== false) {
        for (const other of [...this.state.entries]) {
          if (revision !== this.revision) break;
          if (other.type === 'douyin' && other.crossPlatformMatch !== false && this.enabled(other) && !creatorName(other)
            && other.groups.some(g => selected.groups.includes(g) && groupRule(this.store.config, g).allowed)) await this.identify(other, revision);
        }
      }
      const ordered = [...this.state.entries].sort((a, b) => Number(b.type === 'douyin') - Number(a.type === 'douyin'));
      const selectedEntries = ordered.filter(entry => !(id && entry.id !== id || !id && entry.nextCheckAt > this.now() || !this.enabled(entry))
        && entry.groups.some(g => groupRule(this.store.config, g).allowed));
      const done = new Map(selectedEntries.map(entry => { let resolve; const promise = new Promise(r => { resolve = r; }); return [entry.id, { promise, resolve, finished: false }]; }));
      const remaining = [...selectedEntries], failures = [];
      const worker = async () => {
        while (remaining.length) {
          // Waiting for a matching creator must not consume a work slot. Pick
          // another ready source first, and wait only when none can progress.
          const index = remaining.findIndex(entry => entry.type !== 'bilibili' || creatorMatches(entry, selectedEntries)
            .filter(other => other.type === 'douyin').every(other => done.get(other.id).finished));
          if (index < 0) { await Promise.race([...done.values()].filter(job => !job.finished).map(job => job.promise)); continue; }
          const [entry] = remaining.splice(index, 1);
          try {
            if (revision === this.revision && this.enabled(entry)) await this.poll(entry, revision);
          } catch (error) { failures.push(error); }
          finally { const job = done.get(entry.id); job.finished = true; job.resolve(); }
        }
      };
      await Promise.all([worker(), worker()]);
      if (failures.length) throw failures[0];
    } finally { this.busy = false; }
    return this.status();
  }
  async poll(entry, revision) {
    const controller = new AbortController(); this.controllers.add(controller);
    const metrics = this.diagnosticsFor(entry); metrics.lastMediaPrepareMs = 0; metrics.lastQqUploadMs = 0;
    const allowed = () => this.enabled(entry) && revision === this.revision && !controller.signal.aborted;
    const ensure = () => { if (!allowed()) throw cancelled(); };
    let stage = 'reading';
    try {
      let feed, readError;
      try { feed = await this.readSource(entry, controller.signal); }
      catch (error) { readError = error; }
      ensure();
      const now = new Date(this.now()).toISOString();
      this.mutate(() => {
        entry.checkedAt = now; entry.lastReadFailed = Boolean(readError);
        if (feed) { entry.lastReadAt = now; entry.lastFailureStage = ''; entry.lastTitle = feed.title || ''; }
        else entry.lastFailureStage = 'reading';
        this.pruneSuppressed();
        this.pruneHistorical(entry);
        for (const item of entry.pending) item.groups = item.groups.filter(g => entry.groups.includes(g) && groupRule(this.store.config, g).allowed);
        entry.pending = entry.pending.filter(item => item.groups.some(g => !item.delivered.includes(g)));
        // Delivery does not depend on a fresh source response: a temporary RSSHub
        // outage must not strand updates already persisted in the outbox.
        if (!feed) return;
        const seen = new Set(entry.seen);
        const baselines = new Set(entry.gameBaselines || []);
        // Existing Bilibili subscriptions already tracked videos. Initialize the
        // newly added dynamics separately without replaying historical posts.
        const biliBaselines = new Set(entry.bilibiliBaselines || (entry.initializedAt ? ['video'] : []));
        // Baseline every newly available channel before the bounded outbox loop.
        // Otherwise a full queue could leave historical items unseen, while the
        // channel is marked initialized, and replay them on the next check.
        if (entry.type === 'game') for (const item of feed.items) if (!baselines.has(item.channel)) seen.add(item.id);
        if (entry.type === 'bilibili') for (const item of feed.items) if (item.channel && !biliBaselines.has(item.channel)) seen.add(item.id);
        if (entry.initializedAt) {
          for (const item of [...feed.items].reverse()) {
            if (seen.has(item.id)) continue;
            const stale = staleSubscriptionReason(entry, item, this.now());
            if (stale) {
              // Retry invalid/missing dates on later reads in case the source
              // corrects them; definitely old IDs can be safely remembered.
              if (stale === 'historical') seen.add(item.id);
              continue;
            }
            if (!matches(item, entry)) { seen.add(item.id); continue; }
            const groups = entry.groups.filter(g => groupRule(this.store.config, g).allowed && !this.suppressed(entry, g, item));
            if (!groups.length) { seen.add(item.id); continue; }
            if (entry.pending.length >= 100) break;
            entry.pending.push({ ...item, groups: [...groups], delivered: [] });
            seen.add(item.id);
          }
        } else { entry.initializedAt = now; for (const item of [...feed.items].reverse()) seen.add(item.id); }
        if (entry.type === 'game') entry.gameBaselines = [...new Set([...baselines, ...(feed.successfulSources || [])])];
        if (entry.type === 'bilibili') entry.bilibiliBaselines = [...new Set([...biliBaselines, ...(feed.successfulSources || [])])];
        entry.lastWarning = (feed.warnings || []).join('\n');
        entry.lastFallbacks = [...(feed.fallbacks || [])];
        entry.lastChannels = [...(feed.channels || [])];
        entry.seen = [...seen].slice(-2000);
      });
      stage = 'sending'; let deliveryFailed = false, mediaPending = false, qqFailed = false;
      // Persist the outbox before calling QQ; successful targets are recorded individually.
      for (const item of entry.pending.slice(0, 3)) {
        const targets = item.groups.filter(group => !item.delivered.includes(group) && entry.groups.includes(group) && groupRule(this.store.config, group).allowed
          && !this.suppressed(entry, group, item));
        if (!targets.length) continue;
        const prepareStarted = Date.now(); metrics.mediaPreparations++; stage = 'preparing';
        let prepared;
        try { prepared = await this.prepareMessage(entry, item, { signal: controller.signal, downloadVideo: this.downloadVideo, selfId: this.selfId, pendingGroups: targets }); }
        catch (error) { metrics.mediaFailures++; throw error; }
        finally { metrics.lastMediaPrepareMs += Date.now() - prepareStarted; }
        stage = 'sending';
        const unavailable = prepared.parts?.filter(part => part.unavailable) || [];
        const recovered = prepared.parts?.filter(part => !part.unavailable && (part.message?.length || part.messages?.length) && item.imageFailures?.[part.key] > 0) || [];
        const cardFallback = prepared.cardFallback === true;
        metrics.mediaFailures += unavailable.length + Number(cardFallback);
        if (cardFallback) metrics.cardFallbacks++;
        let uploadFailed = false;
        try {
          ensure();
          if (prepared.warning || unavailable.length || recovered.length) this.mutate(() => {
            if (prepared.warning) appendWarning(entry, prepared.warning);
            for (const part of recovered) delete item.imageFailures[part.key];
            if (unavailable.length) {
              item.imageFailures ??= {};
              for (const part of unavailable) item.imageFailures[part.key] = (item.imageFailures[part.key] || 0) + 1;
            }
          });
          for (const group of item.groups) {
            ensure();
            if (item.delivered.includes(group) || !entry.groups.includes(group) || !groupRule(this.store.config, group).allowed
              || this.suppressed(entry, group, item)) continue;
            let complete = true;
            const parts = prepared.parts || [{ key: 'main', message: prepared.message }];
            for (const [partIndex, part] of parts.entries()) {
              ensure();
              if (!entry.groups.includes(group) || !groupRule(this.store.config, group).allowed || this.suppressed(entry, group, item)) { complete = false; break; }
              if (item.sentParts?.[group]?.includes(part.key)) continue;
              if (part.unavailable && item.imageFailures[part.key] < 3) {
                complete = false; deliveryFailed = true; mediaPending = true; continue;
              }
              if (part.unavailable) this.mutate(() => { appendWarning(entry, '部分媒体连续读取失败，已跳过失效内容；请通过原文链接查看。'); });
              const legacyMessages = part.key === 'images' && Array.isArray(part.imageKeys)
                ? (part.messages || []).filter((_, index) => !item.sentParts?.[group]?.includes(part.imageKeys[index])) : null;
              const hasContent = legacyMessages ? legacyMessages.length : part.message || part.messages?.length;
              if (hasContent) {
                const uploadStarted = Date.now(); metrics.qqUploads++;
                try {
                  const action = legacyMessages?.length === 1 ? 'send_group_msg' : part.action || 'send_group_msg';
                  const params = action === 'send_group_forward_msg' ? { group_id: group, messages: legacyMessages || part.messages }
                    : { group_id: group, message: legacyMessages?.length === 1 ? legacyMessages[0].data.content : part.message };
                  await this.onebot(action, params, undefined, 120);
                } catch (error) { metrics.qqUploadFailures++; qqFailed = true; uploadFailed = true; ensure(); deliveryFailed = true; complete = false; break; }
                finally { metrics.lastQqUploadMs += Date.now() - uploadStarted; }
              }
              if (this.state.entries.includes(entry) && entry.pending.includes(item)) this.mutate(() => {
                item.sentParts ??= {}; item.sentParts[group] ??= []; item.sentParts[group].push(part.key);
                if (complete && partIndex === parts.length - 1) { item.delivered.push(group); entry.sent++; }
              });
            }
            if (!complete) continue;
            if (!item.delivered.includes(group) && this.state.entries.includes(entry) && entry.pending.includes(item)) this.mutate(() => { item.delivered.push(group); entry.sent++; });
            this.log('success', '订阅更新已推送', { source: 'subscription', group, subscriptionId: entry.id, subscriptionName: entry.name });
            ensure();
          }
        } finally {
          if (prepared.cleanup) {
            if (uploadFailed) setTimeout(prepared.cleanup, 300000).unref();
            else prepared.cleanup();
          }
        }
      }
      ensure();
      if (deliveryFailed) throw Object.assign(new Error('Subscription delivery incomplete'), { code: mediaPending && qqFailed ? 'SUBSCRIPTION_MIXED_DELIVERY' : mediaPending ? 'SUBSCRIPTION_MEDIA_PENDING' : 'QQ_DELIVERY' });
      if (readError) { stage = 'reading'; throw readError; }
      ensure(); this.mutate(() => {
        entry.pending = entry.pending.filter(item => item.groups.some(g => !item.delivered.includes(g)));
        entry.lastSuccessAt = now; entry.lastError = ''; entry.lastFailureStage = ''; entry.failures = 0;
        entry.nextCheckAt = this.now() + this.state.settings.intervalMinutes * 60000;
      });
      this.emitHealth(entry);
    } catch (error) {
      if (error.cancelled || controller.signal.aborted || revision !== this.revision) return;
      entry = this.state.entries.find(candidate => candidate.id === entry.id);
      if (!entry || !this.enabled(entry)) return;
      // Never persist raw responses, feed credentials or upstream error bodies.
      const message = stage === 'preparing' ? '媒体准备失败，待推送项保留，下次检查重试'
        : stage === 'sending' ? error.code === 'SUBSCRIPTION_MIXED_DELIVERY' ? '部分媒体下载未完成，且部分 QQ 推送失败或未确认；待推送项保留，下次检查重试'
          : error.code === 'SUBSCRIPTION_MEDIA_PENDING' ? '部分媒体下载未完成，未确认的内容保留，下次检查重试；已发送内容不会重复' : 'QQ 推送失败或未确认，待推送项保留，下次检查重试' : readFailure(error, entry);
      this.mutate(() => {
        entry.pending = entry.pending.filter(item => item.groups.some(g => !item.delivered.includes(g)));
        entry.checkedAt = new Date(this.now()).toISOString(); entry.lastError = message; entry.lastFailureStage = stage; entry.failures++;
        entry.nextCheckAt = this.now() + Math.min(360, this.state.settings.intervalMinutes * 2 ** Math.min(entry.failures - 1, 5)) * 60000;
      });
      this.log('warn', message, { source: 'subscription', subscriptionId: entry.id, subscriptionName: entry.name });
      this.emitHealth(entry);
    } finally { this.controllers.delete(controller); }
  }
  start() {
    if (this.timer || this.closed) return;
    const tick = () => { if (!this.busy && this.store.config.enabled && this.state.settings.enabled) void this.check().catch(() => this.log('error', '订阅任务保存失败，请检查数据目录')); };
    this.timer = setInterval(tick, 30000); this.timer.unref(); tick();
  }
  cancel() { this.revision++; for (const controller of this.controllers) controller.abort(); }
  close() { if (this.closed) return; this.closed = true; clearInterval(this.timer); this.cancel(); }
}

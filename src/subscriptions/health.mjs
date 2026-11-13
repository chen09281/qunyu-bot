const latest = values => values.filter(Boolean).sort().at(-1) || null;
const earliest = values => values.filter(Boolean).sort()[0] || null;
const sourceState = entry => {
  if (!entry.enabled) return 'disabled';
  if (entry.lastError || entry.lastReadFailed) return 'error';
  if (entry.lastWarning || entry.unauthorizedGroups?.length) return 'degraded';
  return 'ok';
};
export class HealthCenter {
  constructor(subscriptions, parser, emailAlerts, { parserStatus = null, cacheMs = 60000, now = Date.now } = {}) {
    this.subscriptions = subscriptions; this.parser = parser; this.emailAlerts = emailAlerts;
    this.parserStatus = parserStatus || (() => parser.status()); this.cacheMs = cacheMs; this.now = now; this.parserCache = null; this.parserCacheAt = 0;
  }
  async parserInfo(refresh = false) {
    if (!refresh && this.parserCache && this.now() - this.parserCacheAt < this.cacheMs) return this.parserCache;
    try { this.parserCache = await this.parserStatus(); }
    catch { this.parserCache = { available: false, detail: '解析器状态读取失败', platforms: [] }; }
    this.parserCacheAt = this.now(); return this.parserCache;
  }
  async status({ refreshParser = false } = {}) {
    const snapshot = this.subscriptions.status();
    const sources = snapshot.entries.map(entry => ({ id: entry.id, name: entry.name, type: entry.type, source: entry.source,
      enabled: entry.enabled, state: sourceState(entry), checkedAt: entry.checkedAt, lastReadAt: entry.lastReadAt,
      lastSuccessAt: entry.lastSuccessAt, lastError: entry.lastError, lastWarning: entry.lastWarning,
      nextCheckAt: entry.nextCheckAt, failures: entry.failures, lastFailureStage: entry.lastFailureStage,
      pending: entry.pending, unauthorizedGroups: entry.unauthorizedGroups, lastFallbacks: entry.lastFallbacks,
      lastChannels: entry.lastChannels, probe: entry.probe }));
    const channel = (id, entries, transport) => {
      const relevant = id === 'rsshub' ? sources.filter(entry => ['bilibili', 'douyin', 'game'].includes(entry.type)) : sources.filter(entry => entry.type === id);
      let state;
      if (!relevant.length) state = 'disabled';
      else if (id === 'rsshub') {
        const failed = relevant.some(entry => entry.lastChannels?.some(channel => channel.transport === 'rsshub' && channel.ok === false)
          || /RSSHub/i.test(entry.lastError) || entry.lastReadFailed && !entry.lastChannels?.length);
        state = failed ? relevant.some(entry => entry.lastFallbacks?.length) ? 'degraded' : 'error'
          : relevant.some(entry => /RSSHub/i.test(entry.lastWarning)) ? 'degraded' : 'ok';
      } else state = relevant.some(entry => entry.state === 'error') ? 'error'
        : relevant.some(entry => entry.state === 'degraded' || entry.lastChannels?.some(channel => channel.ok === false && channel.transport === 'official')) ? 'degraded' : 'ok';
      return { id, state, sources: relevant.length, lastSuccessAt: latest(relevant.map(entry => entry.lastReadAt)),
        nextCheckAt: earliest(relevant.filter(entry => entry.enabled).map(entry => entry.nextCheckAt)),
        errors: relevant.filter(entry => entry.lastError).map(entry => entry.lastError).slice(0, 3),
        fallbacks: [...new Set(relevant.flatMap(entry => entry.lastFallbacks || []))], transport };
    };
    const abnormal = sources.filter(entry => entry.state === 'error').length;
    const warnings = sources.filter(entry => entry.state === 'degraded').length;
    return { state: abnormal ? 'error' : warnings ? 'degraded' : 'ok', active: snapshot.active,
      summary: { sources: sources.length, abnormal, warnings, pending: sources.reduce((total, entry) => total + entry.pending, 0),
        lastSuccessAt: latest(sources.map(entry => entry.lastReadAt)), nextCheckAt: earliest(sources.filter(entry => entry.enabled).map(entry => entry.nextCheckAt)) },
      channels: [channel('rsshub', sources, 'RSSHub'), channel('bilibili', sources, 'B 站'), channel('douyin', sources, '抖音')],
      sources, parser: await this.parserInfo(refreshParser), email: this.emailAlerts.status() };
  }
}

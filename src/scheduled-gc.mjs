export const defaultGcIntervalMinutes = 15;
export function gcIntervalMinutes(value = process.env.GC_INTERVAL_MINUTES) {
  if (value === undefined || value === '') return defaultGcIntervalMinutes;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : defaultGcIntervalMinutes;
}

// This collects only the bot's JS heap. V8's normal automatic GC remains active.
export class ScheduledGC {
  constructor({ intervalMinutes = gcIntervalMinutes(), collect = globalThis.gc, busy = () => false,
    prune = () => {}, memory = () => process.memoryUsage(), now = () => Date.now(), log = () => {} } = {}) {
    this.intervalMs = gcIntervalMinutes(intervalMinutes) * 60000;
    this.collect = collect; this.busy = busy; this.prune = prune; this.memory = memory; this.now = now; this.log = log;
    this.closed = false; this.started = false; this.running = false; this.timer = null;
    this.data = { state: !this.intervalMs ? 'disabled' : typeof collect !== 'function' ? 'unavailable' : 'scheduled',
      intervalMinutes: this.intervalMs / 60000, runs: 0, failures: 0, deferred: 0, nextAt: null, lastRunAt: null,
      lastDurationMs: null, lastFreedHeapBytes: null };
  }
  status() { return { ...this.data, available: typeof this.collect === 'function' }; }
  start() {
    if (this.closed || this.started) return;
    this.started = true;
    if (this.data.state === 'disabled' || this.data.state === 'unavailable') return;
    this.data.nextAt = this.now() + this.intervalMs; this.arm();
  }
  arm() {
    clearTimeout(this.timer);
    if (this.closed || !this.started || this.data.nextAt == null) return;
    this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, Math.max(1, this.data.nextAt - this.now()));
    this.timer.unref();
  }
  async tick() {
    if (this.closed || !this.started || this.running || this.data.nextAt == null || this.now() < this.data.nextAt) return false;
    if (this.busy()) {
      this.data.deferred++; this.data.state = 'waiting'; this.data.nextAt = this.now() + 30000; this.arm(); return false;
    }
    this.running = true; this.data.state = 'running'; this.data.nextAt = null;
    const start = this.now();
    try {
      const before = this.memory().heapUsed;
      this.prune();
      await this.collect({ type: 'major', execution: 'async' });
      const after = this.memory().heapUsed;
      this.data.runs++; this.data.lastRunAt = this.now(); this.data.lastDurationMs = Math.max(0, this.now() - start);
      this.data.lastFreedHeapBytes = Math.max(0, before - after); this.data.state = 'scheduled';
      this.log('info', `定时 GC 已完成，JS 堆减少 ${(this.data.lastFreedHeapBytes / 1024 / 1024).toFixed(1)} MiB`);
      return true;
    } catch {
      this.data.failures++; this.data.state = 'error'; this.log('warn', '定时 GC 未完成，将在下个周期重试'); return false;
    } finally {
      this.running = false;
      this.data.nextAt = this.closed ? null : this.now() + this.intervalMs;
      this.arm();
    }
  }
  close() { this.closed = true; clearTimeout(this.timer); this.timer = null; this.data.nextAt = null; }
}

import os from 'node:os';
import { readFileSync, statfsSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const percent = (used, total) => total > 0 ? Math.round(clamp(used / total * 100, 0, 100) * 10) / 10 : null;
const readText = path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

export function linuxMemory(text) {
  const fields = Object.fromEntries([...text.matchAll(/^([\w()]+):\s*(\d+)\s+kB\s*$/gm)].map(m => [m[1], Number(m[2]) * 1024]));
  if (!Number.isFinite(fields.MemTotal) || fields.MemTotal <= 0) return null;
  const total = fields.MemTotal;
  const available = clamp(fields.MemAvailable ?? ((fields.MemFree || 0) + (fields.Buffers || 0) + (fields.Cached || 0)
    + (fields.SReclaimable || 0) - (fields.Shmem || 0)), 0, total);
  const swapTotal = fields.SwapTotal, swapFree = fields.SwapFree;
  return { memory: { total, available, used: total - available, percent: percent(total - available, total), source: 'linux' },
    swap: Number.isFinite(swapTotal) && Number.isFinite(swapFree)
      ? { total: swapTotal, used: clamp(swapTotal - swapFree, 0, swapTotal), percent: percent(swapTotal - swapFree, swapTotal) } : null };
}

export function cpuSnapshot(text, cpus = []) {
  const match = /^cpu\s+([\d\s]+)$/m.exec(text);
  if (match) {
    // guest and guest_nice are already included in user/nice; do not count twice.
    const times = match[1].trim().split(/\s+/).slice(0, 8).map(Number);
    if (times.length >= 4 && times.every(Number.isFinite)) return { total: times.reduce((a, b) => a + b, 0), idle: times[3] + (times[4] || 0) };
  }
  if (!cpus.length) return null;
  return cpus.reduce((sum, cpu) => ({ total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0), idle: sum.idle + cpu.times.idle }), { total: 0, idle: 0 });
}

export function cpuPercent(previous, current) {
  if (!previous || !current || current.total <= previous.total || current.idle < previous.idle) return null;
  return percent((current.total - previous.total) - (current.idle - previous.idle), current.total - previous.total);
}

export class ServerStatus {
  constructor(dataDir, { now = () => Date.now(), read = readText, system = os, memory = () => process.memoryUsage(),
    disk = () => statfsSync(dataDir), gc = null } = {}) {
    this.now = now; this.read = read; this.system = system; this.memory = memory; this.disk = disk; this.gc = gc;
    this.closed = false; this.timer = null; this.previousCpu = null; this.snapshot = null;
    this.sample();
  }
  sample() {
    if (this.closed) return;
    const cpus = this.system.cpus(), linux = this.system.platform() === 'linux';
    const current = cpuSnapshot(linux ? this.read('/proc/stat') : '', cpus);
    const cpu = { cores: cpus.length || this.system.availableParallelism(), percent: cpuPercent(this.previousCpu, current),
      load: this.system.platform() === 'win32' ? null : this.system.loadavg().map(v => Math.round(v * 100) / 100) };
    this.previousCpu = current;
    const total = this.system.totalmem(), available = clamp(this.system.freemem(), 0, total);
    const mem = (linux && linuxMemory(this.read('/proc/meminfo'))) || {
      memory: { total, available, used: null, percent: null, source: 'os' }, swap: null
    };
    let disk = null;
    try {
      const value = this.disk(), total = value.bsize * value.blocks, free = value.bsize * value.bfree, available = value.bsize * value.bavail;
      if ([total, free, available].every(Number.isFinite) && total > 0) disk = { total, used: clamp(total - free, 0, total), available: clamp(available, 0, total), percent: percent(total - free, total) };
    } catch { /* A missing filesystem metric must not break the status endpoint. */ }
    this.snapshot = { sampledAt: this.now(), sampleIntervalSeconds: 5, platform: this.system.platform(),
      uptimeSeconds: Math.max(0, Math.floor(this.system.uptime())), cpu, ...mem, disk };
  }
  status() {
    const mem = this.memory();
    return { ...structuredClone(this.snapshot), process: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal,
      external: mem.external, heapLimit: getHeapStatistics().heap_size_limit, uptimeSeconds: Math.floor(process.uptime()) }, gc: this.gc?.status() || null };
  }
  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => this.sample(), 5000); this.timer.unref(); this.gc?.start();
  }
  close() { if (this.closed) return; this.closed = true; clearInterval(this.timer); this.timer = null; this.gc?.close(); }
}

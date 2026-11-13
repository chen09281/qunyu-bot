import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerStatus, linuxMemory, cpuSnapshot, cpuPercent } from '../src/server-status.mjs';
import { createApplication } from '../src/server.mjs';

const mib = 1024 * 1024;
const meminfo = 'MemTotal: 2048000 kB\nMemFree: 200000 kB\nMemAvailable: 1300000 kB\nCached: 900000 kB\nSwapTotal: 2048000 kB\nSwapFree: 1648000 kB\n';
test('Linux 内存使用 MemAvailable 计入可回收缓存，Swap 独立统计，缺失数据不伪装成零', () => {
  const { memory, swap } = linuxMemory(meminfo);
  assert.equal(memory.total, 2048000 * 1024); assert.equal(memory.used, 748000 * 1024);
  assert.equal(memory.available, 1300000 * 1024); assert.equal(swap.used, 400000 * 1024);
  assert.equal(linuxMemory('invalid'), null);
  assert.equal(linuxMemory('MemTotal: 100 kB\nMemFree: 10 kB\nCached: 30 kB\nBuffers: 5 kB\nSReclaimable: 5 kB\nShmem: 10 kB\n').memory.available, 40 * 1024);
  assert.equal(linuxMemory('MemTotal: 100 kB\nMemAvailable: 150 kB\n').memory.available, 100 * 1024);
  assert.equal(linuxMemory('MemTotal: 100 kB\n').swap, null);
  assert.equal(linuxMemory('MemTotal: 100 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n').swap.total, 0);
});

test('CPU 使用连续采样，iowait 计空闲且 guest 不重复计数，初次或计数器重置显示未知', () => {
  const before = cpuSnapshot('cpu  100 0 100 700 100 0 0 0 60 0\ncpu0 50 0 50 350 50 0 0 0 30 0\n');
  const after = cpuSnapshot('cpu  130 0 120 740 110 0 0 0 80 0\n');
  assert.equal(before.total, 1000); assert.equal(before.idle, 800);
  assert.equal(cpuPercent(before, after), 50);
  assert.equal(cpuPercent(null, after), null); assert.equal(cpuPercent(after, before), null);
  assert.equal(cpuPercent(after, after), null);
});

test('资源定时采样与进程内存分开，磁盘不可用不影响返回；停止时销毁定时任务', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let sample = 0, rss = 100 * mib, closed = 0, started = 0;
  const system = { cpus: () => [{ times: { idle: 0, user: 0 } }, { times: { idle: 0, user: 0 } }], platform: () => 'linux',
    totalmem: () => 2e9, freemem: () => 0, uptime: () => 100000, loadavg: () => [2.38, 1.32, .53] };
  const resources = new ServerStatus('/unused', { system, now: () => sample * 5000,
    read: path => path.endsWith('meminfo') ? meminfo : `cpu ${sample * 50} 0 0 ${1000 + sample * 50} 0 0 0 0\n`,
    disk: () => { throw Error('no permission'); }, memory: () => ({ rss, heapUsed: 20 * mib, heapTotal: 30 * mib, external: mib }),
    gc: { status: () => ({ state: 'scheduled' }), start() { started++; }, close() { closed++; } } });
  t.after(() => resources.close());
  assert.equal(resources.status().cpu.percent, null); assert.equal(resources.status().disk, null);
  assert.equal(resources.status().memory.available, 1300000 * 1024);
  resources.start(); resources.start(); assert.equal(started, 1);
  sample = 1; t.mock.timers.tick(5000); assert.equal(resources.status().cpu.percent, 50);
  rss = 110 * mib; assert.equal(resources.status().process.rss, rss);
  const publicData = resources.status(); publicData.memory.total = 0;
  assert.ok(resources.status().memory.total > 0);
  resources.close(); assert.equal(resources.timer, null); assert.equal(closed, 1);
  sample = 2; t.mock.timers.tick(5000); assert.equal(resources.status().sampledAt, 5000);
});

test('非 Linux 的内存、CPU 与磁盘降级仍可用，不虚报 Swap', () => {
  let idle = 10;
  const resources = new ServerStatus('/unused', { system: { cpus: () => [{ times: { user: 10, idle } }], platform: () => 'darwin',
    totalmem: () => 1000, freemem: () => 400, uptime: () => 60, loadavg: () => [0, 0, 0] },
    disk: () => ({ bsize: 4096, blocks: 100, bfree: 30, bavail: 25 }) });
  try {
    assert.equal(resources.status().memory.source, 'os'); assert.equal(resources.status().swap, null);
    assert.equal(resources.status().memory.percent, null); assert.equal(resources.status().memory.used, null);
    assert.equal(resources.status().disk.used, 70 * 4096); assert.equal(resources.status().disk.available, 25 * 4096);
    idle += 10; resources.sample(); assert.equal(resources.status().cpu.percent, 0);
  } finally { resources.close(); }
});

test('服务器指标仅通过管理员状态接口返回，公开健康检查不包含资源和运行环境信息', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-server-status-'));
  const app = await createApplication({ dataDir: dir, initialPassword: 'resource-test-password', bilibiliAutoStart: false,
    douyinAutoStart: false, checkinAutoStart: false, subscriptionAutoStart: false, scheduledChatAutoStart: false,
    gcOptions: { collect: null } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base + '/api/status')).status, 401);
  const health = await (await fetch(base + '/health')).json(); assert.equal(health.server, undefined);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' },
    body: JSON.stringify({ username: 'admin', password: 'resource-test-password' }) });
  const response = await fetch(base + '/api/status', { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const { server } = await response.json();
  assert.ok(server.memory.total > 0); assert.ok(server.process.rss > 0); assert.ok(server.cpu.cores > 0);
  assert.equal(server.gc.state, 'unavailable'); assert.equal(server.gc.nextAt, null);
  assert.equal(server.hostname, undefined); assert.equal(server.env, undefined);
  assert.equal(JSON.stringify(server).includes(dir), false);
});

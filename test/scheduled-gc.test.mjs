import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ScheduledGC, gcIntervalMinutes } from '../src/scheduled-gc.mjs';
import { Bot } from '../src/bot.mjs';
import { defaultConfig } from '../src/config.mjs';

test('定时 GC 在忙碌时延后，空闲后执行一次异步回收，不重叠运行', async t => {
  let now = 1000, busy = true, finish, pruned = 0, calls = 0, used = 1000;
  const gc = new ScheduledGC({ intervalMinutes: 1, now: () => now, busy: () => busy, prune: () => { pruned++; },
    memory: () => ({ heapUsed: used }), collect: async options => {
      calls++; assert.deepEqual(options, { type: 'major', execution: 'async' });
      await new Promise(resolve => { finish = resolve; }); used = 700;
    } });
  t.after(() => gc.close());
  gc.start(); gc.start(); assert.equal(gc.status().nextAt, 61000);
  assert.equal(await gc.tick(), false); now = 61000;
  assert.equal(await gc.tick(), false); assert.equal(calls, 0); assert.equal(gc.status().state, 'waiting');
  assert.equal(gc.status().nextAt, 91000); now = 91000; busy = false;
  const running = gc.tick(); assert.equal(gc.status().state, 'running'); assert.equal(await gc.tick(), false);
  assert.equal(calls, 1); assert.equal(pruned, 1); now += 12; finish(); assert.equal(await running, true);
  assert.equal(gc.status().runs, 1); assert.equal(gc.status().lastFreedHeapBytes, 300); assert.equal(gc.status().lastDurationMs, 12);
  assert.equal(gc.status().nextAt, now + 60000);
});

test('GC 的定时触发、关闭与执行失败均有边界，缺少启动参数时不假装已启用', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let calls = 0;
  const gc = new ScheduledGC({ intervalMinutes: 1, collect: async () => { calls++; throw Error('PRIVATE_ERROR'); } });
  gc.start(); t.mock.timers.tick(60000); await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1); assert.equal(gc.status().failures, 1); assert.equal(gc.status().state, 'error');
  assert.equal(JSON.stringify(gc.status()).includes('PRIVATE_ERROR'), false);
  gc.close(); t.mock.timers.tick(120000); assert.equal(calls, 1); assert.equal(gc.status().nextAt, null);
  for (const [options, state] of [[{ collect: null }, 'unavailable'], [{ collect() {}, intervalMinutes: 0 }, 'disabled']]) {
    const service = new ScheduledGC(options); service.start(); assert.equal(service.status().state, state);
    assert.equal(service.status().nextAt, null); assert.equal(service.timer, null); service.close();
  }
  assert.equal(gcIntervalMinutes('15'), 15); assert.equal(gcIntervalMinutes('0'), 0);
  for (const value of ['bad', '-1', '0.1', '1441']) assert.equal(gcIntervalMinutes(value), 15);
});

test('维护只清过期临时缓存，保留近期去重和续聊窗口以及持久聊天记录', () => {
  const now = Date.now(), cfg = { ...defaultConfig(), enabled: true, allowedGroups: ['10003'] };
  const bot = new Bot({ config: cfg }, undefined, null, null, { now: () => now });
  try {
    const event = { message_type: 'group', self_id: 10001, group_id: 10003, user_id: 10002, message_id: 1 };
    const turn = bot.conversations.begin(event, '保留的历史问题', cfg.model, 'log');
    bot.conversations.finish(turn.turnId, { status: 'sent', reply: '保留的历史回答' });
    bot.seen.set('old', now - 600001); bot.seen.set('recent', now);
    bot.cooldowns.set('old', now - 3600001); bot.cooldowns.set('recent', now);
    bot.linkSeen.set('old', { time: now - 600001 }); bot.linkSeen.set('recent', { time: now });
    bot.groupChat.replied({ ...event, user_id: undefined }, cfg, '定时问候', 1, 'scheduled');
    bot.groupChat.replied(event, cfg, '仍可续聊', 2, 'followup', bot.groupChat.sessions.get('10001:10003:').id);
    bot.groupChat.windows.set('10001:10003:10004', { until: now - 1 });
    bot.pruneTransientCaches(now);
    assert.equal(bot.seen.has('old'), false); assert.equal(bot.seen.has('recent'), true);
    assert.equal(bot.cooldowns.has('old'), false); assert.equal(bot.cooldowns.has('recent'), true);
    assert.equal(bot.linkSeen.has('old'), false); assert.equal(bot.linkSeen.has('recent'), true);
    assert.equal(bot.groupChat.windows.has('10001:10003:10004'), false); assert.equal(bot.groupChat.windows.has('10001:10003:10002'), true);
    assert.equal(bot.conversations.context(turn.conversationId).length, 2);
  } finally { bot.close(); }
});

test('标准 Node 启动参数可实际执行异步 GC，统计真实进程堆数据', () => {
  const source = `import assert from 'node:assert/strict';import {ScheduledGC} from './src/scheduled-gc.mjs';
    let now=1000;const gc=new ScheduledGC({intervalMinutes:1,now:()=>now});gc.start();now+=60000;
    assert.equal(await gc.tick(),true);assert.equal(gc.status().runs,1);assert.equal(gc.status().available,true);
    assert.ok(Number.isFinite(gc.status().lastFreedHeapBytes));gc.close();console.log('actual-gc-ok');`;
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /actual-gc-ok/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../src/config.mjs';
import { SubscriptionService } from '../src/subscriptions/service.mjs';
const start = Date.parse('2026-10-30T10:00:00.567Z');
const post = (id, time = start, channel = 'video') => ({ id, channel, title: id, summary: '', link: `https://example.com/${id}`, publishedAt: typeof time === 'number' ? new Date(time).toISOString() : time });
function fixture(t, type = 'bilibili') {
  const dir = mkdtempSync(join(tmpdir(), 'subscription-freshness-'));
  let clock = start, items = [post('baseline')], failRead = false, failSend = false;
  const store = { config: { ...defaultConfig(), enabled: true, allowedGroups: ['10003', '10005'] } }, sent = [];
  const options = { now: () => clock, fetchFeed: async () => { if (failRead) throw Error('offline'); return { items, successfulSources: ['video', 'dynamic'] }; },
    prepareMessage: async (_entry, item) => ({ message: [{ type: 'text', data: { text: item.id } }] }),
    onebot: async (_action, params) => { if (failSend) throw Error('offline'); sent.push(params); } };
  let service = new SubscriptionService(dir, store, options);
  service.configure({ enabled: true }); service.upsert({ name: '测试作者', type, source: type === 'bilibili' ? '123' : 'MS4wLjABAAAAabcdefghijk', groups: ['10003'] });
  const id = service.state.entries[0].id;
  t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  return { sent, dir, get service() { return service; }, get entry() { return service.get(id); },
    feed(value) { items = value; }, readFailure(value) { failRead = value; }, sendFailure(value) { failSend = value; }, advance(ms) { clock += ms; },
    async check() { await service.check(id); }, restart() { service.close(); service = new SubscriptionService(dir, store, options); } };
}

for (const type of ['bilibili', 'douyin']) test(`${type} 历史列表扩容、旧 ID 改变和置顶旧作品不推送，真正的新内容正常推送`, async t => {
  const f = fixture(t, type); await f.check(); f.advance(600000);
  f.feed([post('fresh', start + 300000), post('last-year', '2025-07-10T03:25:49Z'), post('older', start - 60000), post('baseline-new-guid', start - 100000)]);
  await f.check(); assert.deepEqual(f.sent.map(p => p.message[0].data.text), ['fresh']);
  assert.equal(f.entry.pending.length, 0); assert.ok(f.entry.seen.includes('last-year'));
  // A truncated seen ledger or a fallback reader returning new GUIDs cannot replay old media.
  f.entry.seen = []; f.feed([post('last-year-other-guid', '2025-07-10T03:25:49Z')]); await f.check(); assert.equal(f.sent.length, 1);
});

test('升级启动清除已误入队列的旧内容，即使插件关闭、已发部分图片或上游离线；新内容及各群进度保留', async t => {
  const f = fixture(t); await f.check();
  f.service.upsert({ groups: ['10003', '10005'] }, f.entry.id);
  f.entry.pending = [
    { ...post('old', '2025-07-10T03:25:49Z'), groups: ['10003'], delivered: [], sentParts: { '10003': ['main'] } },
    { ...post('new'), groups: ['10003', '10005'], delivered: ['10003'], sentParts: { '10003': ['main'] } }
  ];
  f.service.configure({ enabled: false }); f.restart(); assert.equal(f.service.state.settings.enabled, false);
  assert.deepEqual(f.entry.pending.map(p => p.id), ['new']); assert.equal(f.entry.skippedHistorical, 1);
  assert.deepEqual(JSON.parse(readFileSync(f.service.path)).entries[0].pending.map(p => p.id), ['new']);
  f.service.configure({ enabled: true }); f.readFailure(true); await f.check();
  assert.deepEqual(f.sent.map(p => p.group_id), ['10005']); assert.equal(f.entry.pending.length, 0);
  f.restart(); assert.equal(f.entry.skippedHistorical, 1);
});

test('超过 24 小时的新发现和待重试内容不再补发；未过期的 QQ 失败保持重试', async t => {
  const f = fixture(t); await f.check(); f.advance(1000); f.feed([post('retry', start + 1000)]); f.sendFailure(true); await f.check();
  assert.equal(f.entry.pending.length, 1); f.sendFailure(false); await f.check(); assert.equal(f.sent.length, 1);
  f.feed([post('expired', start + 1000)]); f.sendFailure(true); await f.check(); assert.equal(f.entry.pending.length, 1);
  f.advance(25 * 3600000); f.feed([post('old-but-after-baseline', start + 3600000)]); f.sendFailure(false); await f.check();
  assert.equal(f.entry.pending.length, 0); assert.equal(f.sent.length, 1); assert.equal(f.entry.skippedHistorical, 1);
});

test('无效日期和异常未来日期不能当作新作品；源修正时间后可正常推送', async t => {
  const f = fixture(t); await f.check();
  f.feed([post('missing', ''), post('invalid', 'bad date'), post('future', start + 86400000)]); await f.check(); assert.equal(f.sent.length, 0);
  f.feed([post('missing'), post('invalid'), post('future')]); await f.check(); assert.equal(f.sent.length, 3);
});

test('首次空源恢复只发送基线之后内容；动态转发按动态自己的时间判定', async t => {
  const f = fixture(t); f.feed([]); await f.check(); f.advance(1000);
  f.feed([post('old-video', start - 86400000), { ...post('new-dynamic', start + 1000, 'dynamic'), summary: '今天转发去年的视频' }]); await f.check();
  assert.deepEqual(f.sent.map(p => p.message[0].data.text), ['new-dynamic']);
});

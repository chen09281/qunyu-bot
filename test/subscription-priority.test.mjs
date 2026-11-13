import { prepareMessage } from './helpers/subscription-message.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.mjs';
import { SubscriptionService } from '../src/subscriptions/service.mjs';
import { creatorName, creatorKey, creatorMatches } from '../src/subscriptions/creator-priority.mjs';

const dySource = 'MS4wLjABAAAAabcdefghijk';
const post = id => ({ id: 'post-' + id, title: '新作品 ' + id, link: 'https://example.com/post/' + id, summary: '', publishedAt: '2026-10-25T02:00:00Z' });
function fixture(t, { biliGroups = ['10003', '10005'], dyGroups = ['10003'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-priority-')), sent = [], reads = [];
  let now = Date.parse('2026-10-25T02:00:00Z'), phase = 0;
  const titles = { bilibili: 'Fish 画师 的 bilibili 空间', douyin: 'ＦＩＳＨ 画师' };
  const store = { config: { ...defaultConfig(), enabled: true, allowedGroups: ['10003', '10005'] } };
  const options = { prepareMessage, now: () => now, onebot: async (action, params) => sent.push({ action, ...params }),
    fetchFeed: async entry => { reads.push(entry.type); return { title: titles[entry.type], items: Array.from({ length: phase + 1 }, (_, i) => post(phase - i)) }; } };
  const service = new SubscriptionService(dir, store, options);
  // Bilibili deliberately comes first in saved order.
  service.upsert({ name: 'B站备注', type: 'bilibili', source: '123', groups: biliGroups });
  service.upsert({ name: '抖音备注', type: 'douyin', source: dySource, groups: dyGroups });
  const [bili, dy] = service.state.entries; service.configure({ enabled: true });
  t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, service, bili, dy, sent, reads, store, options, titles,
    phase(value) { phase = value; now += 600001; },
    status(id) { return service.status().entries.find(e => e.id === id); } };
}

test('昵称来自平台源，兼容规范化但保留标点，不按手填备注、UID 或模糊名字匹配', () => {
  const bili = { type: 'bilibili', name: '任意备注', source: '123', lastTitle: 'Fish 画师 的 bilibili 空间', groups: ['10003'] };
  const dy = { type: 'douyin', name: '另一个备注', source: dySource, lastTitle: 'ＦＩＳＨ 画师', groups: ['10003'] };
  assert.equal(creatorName(bili), 'Fish 画师'); assert.equal(creatorKey(creatorName(bili)), creatorKey(creatorName(dy)));
  assert.deepEqual(creatorMatches(bili, [bili, dy]), [dy]);
  for (const changed of [
    { ...bili, lastTitle: '' }, { ...bili, lastTitle: '123 的 bilibili 空间' },
    { ...bili, lastTitle: 'RSS 聚合源', name: 'ＦＩＳＨ 画师' },
    { ...bili, type: 'rss', lastTitle: 'ＦＩＳＨ 画师' }, { ...bili, crossPlatformMatch: false },
  ]) assert.deepEqual(creatorMatches(changed, [changed, dy]), []);
  assert.notEqual(creatorKey('Fish_画师'), creatorKey('Fish画师'));
  assert.notEqual(creatorKey('Fish 画师'), creatorKey('Fish画师'));
});

test('同群同名优先抖音，另一群继续 B 站，首次不发历史且不受来源保存顺序影响', async t => {
  const f = fixture(t); await f.service.check();
  assert.deepEqual(f.reads, ['douyin', 'bilibili']); assert.equal(f.sent.length, 0);
  assert.deepEqual(f.status(f.bili.id).suppressedGroups, ['10003']);
  assert.deepEqual(f.status(f.dy.id).preferredGroups, ['10003']);
  assert.deepEqual(f.status(f.bili.id).matchedSubscriptions[0].groups, ['10003']);
  f.phase(1); await f.service.check();
  assert.deepEqual(f.sent.map(s => [s.group_id, /抖音作品/.test(s.message.find(segment => segment.type === 'text').data.text) ? 'douyin' : 'bilibili']), [['10003', 'douyin'], ['10005', 'bilibili']]);
  assert.equal(f.bili.sent, 1); assert.equal(f.dy.sent, 1);
  assert.equal(f.bili.pending.length, 0); assert.equal(f.bili.seen.includes('post-1'), true);
  await f.service.check(f.bili.id); await f.service.check(f.dy.id); assert.equal(f.sent.length, 2);
});

test('昵称相同但分属不同群，不归并、不跨群改变目标', async t => {
  const f = fixture(t, { biliGroups: ['10003'], dyGroups: ['10005'] }); await f.service.check();
  assert.deepEqual(f.status(f.bili.id).matchedSubscriptions, []); assert.deepEqual(f.status(f.bili.id).suppressedGroups, []);
  f.phase(1); await f.service.check();
  assert.deepEqual(f.sent.map(s => s.group_id), ['10005', '10003']);
});

test('不同昵称及通用 RSS 不受影响，单条来源可退出同名归并', async t => {
  const f = fixture(t); f.titles.douyin = 'Fish_画师'; await f.service.check();
  assert.deepEqual(f.status(f.bili.id).suppressedGroups, []);
  f.phase(1); await f.service.check(); assert.equal(f.sent.length, 3);
  f.titles.douyin = 'Fish 画师'; f.service.upsert({ crossPlatformMatch: false }, f.bili.id);
  f.phase(2); await f.service.check(); assert.equal(f.sent.length, 6);
  assert.deepEqual(f.status(f.bili.id).matchedSubscriptions, []);
  f.service.upsert({ crossPlatformMatch: true }, f.bili.id);
  assert.deepEqual(f.status(f.bili.id).suppressedGroups, ['10003']);
  for (const value of ['true', 1, null]) assert.throws(() => f.service.upsert({ crossPlatformMatch: value }, f.bili.id), /布尔/);
});

test('手动检查 B 站先识别新抖音账号，只读昵称、不替抖音发消息或建立基线', async t => {
  const f = fixture(t); f.bili.lastTitle = f.titles.bilibili;
  f.bili.initializedAt = '2026-10-25T01:00:00Z'; f.bili.seen = ['post-0'];
  f.phase(1); await f.service.check(f.bili.id);
  assert.deepEqual(f.reads, ['douyin', 'bilibili']); assert.equal(f.dy.initializedAt, null);
  assert.equal(f.dy.checkedAt, null); assert.equal(f.dy.sent, 0); assert.deepEqual(f.dy.seen, []);
  assert.deepEqual(f.sent.map(s => s.group_id), ['10005']);
  assert.deepEqual(f.status(f.bili.id).suppressedGroups, ['10003']);
});

test('已排队目标按群清理，重启保留识别与已读；暂停抖音后只恢复 B 站新内容', async t => {
  const f = fixture(t); f.service.upsert({ enabled: false }, f.dy.id); await f.service.check();
  f.phase(1); f.service.onebot = async (action, params) => { if (params.group_id === '10003') throw Error('failed'); f.sent.push({ action, ...params }); };
  await f.service.check(f.bili.id); assert.equal(f.bili.pending.length, 1);
  f.service.upsert({ enabled: true }, f.dy.id);
  f.phase(2); f.service.onebot = f.options.onebot; await f.service.check(f.bili.id);
  assert.equal(f.bili.pending.length, 0); assert.deepEqual(f.sent.map(s => s.group_id), ['10005', '10005']);
  f.service.close();
  const restored = new SubscriptionService(f.dir, f.store, f.options); t.after(() => restored.close());
  assert.deepEqual(restored.status().entries.find(e => e.id === f.bili.id).suppressedGroups, ['10003']);
  restored.upsert({ enabled: false }, f.dy.id); f.phase(3); await restored.check(f.bili.id);
  const later = f.sent.slice(2); assert.deepEqual(later.map(s => s.group_id), ['10003', '10005']);
  assert.ok(later.every(s => s.message.find(segment => segment.type === 'text').data.text.endsWith('https://example.com/post/3')));
});

test('取消抖音的某个群只恢复该群；改名与更换来源会重新判断', async t => {
  const f = fixture(t, { dyGroups: ['10003', '10005'] }); await f.service.check();
  f.service.unsubscribeGroup(f.dy.id, '10003');
  assert.deepEqual(f.status(f.bili.id).suppressedGroups, ['10005']);
  f.titles.douyin = '不同作者'; f.phase(1); await f.service.check();
  assert.deepEqual(f.status(f.bili.id).suppressedGroups, []);
  assert.equal(f.sent.filter(s => /B 站投稿/.test(s.message.find(segment => segment.type === 'text').data.text)).length, 2);
  f.service.upsert({ source: 'MS4wLjABAAAAnewaccount' }, f.dy.id);
  assert.equal(f.status(f.dy.id).creatorName, ''); assert.equal(f.dy.initializedAt, null);
});

test('抖音读取失败自动恢复同群 B 站，未知账号不阻止 B 站', async t => {
  const f = fixture(t); await f.service.check();
  f.service.fetchFeed = async entry => { if (entry.type === 'douyin') throw Error('PRIVATE_FEED_DETAILS'); return { title: f.titles.bilibili, items: [post(1), post(0)] }; };
  f.phase(1); await f.service.check();
  assert.deepEqual(f.sent.map(s => s.group_id), ['10003', '10005']); assert.deepEqual(f.status(f.bili.id).suppressedGroups, []);
  assert.deepEqual(f.status(f.bili.id).fallbackGroups, ['10003']);
  assert.equal(JSON.stringify(f.service.status()).includes('PRIVATE_FEED_DETAILS'), false);
  f.service.upsert({ source: 'MS4wLjABAAAAunknownname' }, f.dy.id);
  f.service.fetchFeed = async entry => { if (entry.type === 'douyin') throw Error('failed'); return { title: f.titles.bilibili, items: [post(2), post(1), post(0)] }; };
  await f.service.check(f.bili.id);
  assert.deepEqual(f.sent.slice(2).map(s => s.group_id), ['10003', '10005']);
});

test('识别途中撤销授权或取消检查，不保存迟到昵称、不推送后续来源', async t => {
  const f = fixture(t); let finish;
  f.service.fetchFeed = () => new Promise(resolve => { finish = resolve; });
  const pending = f.service.check(f.bili.id);
  f.service.upsert({ crossPlatformMatch: false }, f.bili.id);
  finish({ title: 'Fish 画师', items: [post(1)] }); await pending;
  assert.equal(f.dy.lastTitle, ''); assert.equal(f.sent.length, 0);
});

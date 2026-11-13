import { prepareMessage } from './helpers/subscription-message.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.mjs';
import { normalizeSource, resolveSubscriptionSource, sourceUrl } from '../src/subscriptions/feeds.mjs';
import { games } from '../src/subscriptions/games.mjs';
import { gameKind, parseHypergryphNews, parseZzzNews, parseWuwaNews, readGameFeed } from '../src/subscriptions/game-feeds.mjs';
import { SubscriptionService } from '../src/subscriptions/service.mjs';
import { downloadPublicJson } from '../src/web-images.mjs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const html = rows => `<script>self.__next_f.push(${JSON.stringify([1, `a:${JSON.stringify({ children: ['$', { initialData: rows }] })}\n`])})</script>`;
const news = (cid, title, extra = {}) => ({ cid, title, displayTime: 1792846800, brief: '活动日期详见公告。', ...extra });
const rss = (title, body = '', id = '123') => `<rss version="2.0"><channel><title>官方动态</title><item><guid>${id}</guid><title>${title}</title><link>https://www.bilibili.com/opus/${id}</link><description>${body}</description><pubDate>Mon, 26 Oct 2026 04:00:00 GMT</pubDate></item></channel></rss>`;
const item = (id, channel = 'official') => ({ id, channel, kind: channel === 'official' ? 'activity' : 'livestream', title: '限时活动 ' + id, link: 'https://example.com/' + id, summary: '', publishedAt: '2026-10-26T04:00:00Z' });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-game-feeds-'));
  const store = { config: { ...defaultConfig(), enabled: true, allowedGroups: ['10003', '10005'] } }, sent = [];
  let feed = { title: '明日方舟 · 活动与前瞻', items: [item('old')], successfulSources: ['official'], warnings: ['动态不可用'] }, failGroup = '';
  const options = { prepareMessage, fetchFeed: async () => feed, onebot: async (action, payload) => { if (payload.group_id === failGroup) throw Error('QQ offline'); sent.push({ action, ...payload }); } };
  const service = new SubscriptionService(dir, store, options);
  service.configure({ enabled: true });
  const { entry } = service.subscribeGroup({ type: 'game', source: '明日方舟' }, '10003');
  t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, entry, sent, store, dir, options, setFeed: value => { feed = value; }, setFailedGroup: value => { failGroup = value; } };
}

test('四款游戏和别名解析一致，不接受任意 URL 或混淆终末地与明日方舟', async () => {
  for (const [name, id] of [['明日方舟','arknights'],['ZZZ','zzz'],['绝区零','zzz'],['zmd','endfield'],['终末地','endfield'],['明日方舟：终末地','endfield'],['鸣潮','wuwa']]) {
    assert.equal(normalizeSource('game', name), id);
    assert.deepEqual(await resolveSubscriptionSource('游戏 ' + name), { type: 'game', source: id });
  }
  for (const bad of ['原神', 'http://127.0.0.1', 'constructor', '../zzz']) assert.throws(() => normalizeSource('game', bad));
  for (const game of games) assert.equal(sourceUrl({ type: 'game', source: game.id }, {}), game.website);
});

test('分类识别前瞻通讯、特别节目、活动和维护，排除录播、封禁、普通 PV', () => {
  for (const text of ['3.7版本前瞻通讯将于周五播出', '感谢庆典特别直播预告', '3.3版本前瞻特别节目', '3.0版本特别节目预告']) assert.equal(gameKind(text), 'livestream');
  assert.equal(gameKind('制作组通讯', '前瞻特别直播将于10月24日19:30进行'), 'livestream');
  for (const text of ['限时活动即将开启', '版本更新说明', '闪断更新公告', '调频预告', '限时唤取']) assert.equal(gameKind(text), 'activity');
  for (const text of ['版本前瞻直播回放', '前瞻录播', '版本违规封禁处理公告', '未成年人游戏限时管理', '角色PV', '二创壁纸']) assert.equal(gameKind(text), '');
});

test('鹰角公告从 JSON 数据帧读取，不执行脚本；保留前导零并去重', () => {
  const content = html([news('0078', '活动开启'), news('0078', '活动开启'), news('9','封禁公告')]);
  const rows = parseHypergryphNews(content, 'arknights');
  assert.equal(rows.length, 1); assert.equal(rows[0].link, 'https://ak.hypergryph.com/news/0078');
  assert.equal(rows[0].publishedAt, '2026-10-24T13:00:00.000Z');
  assert.notEqual(rows[0].id, parseHypergryphNews(content, 'endfield')[0].id);
  assert.throws(() => parseHypergryphNews('<script>throw new Error("do not run")</script>', 'arknights'));
  assert.throws(() => parseHypergryphNews('x'.repeat(1024 * 1024 + 1), 'endfield'));
});

test('绝区零接口清理正文、按北京时间解析并只拼接官方文章 URL', () => {
  const rows = parseZzzNews({ retcode: 0, data: { list: [{ iInfoId: 12, sTitle: '3.3版本前瞻特别节目预告', sContent: '<p>10月9日19:30播出</p><script>secret</script>', sUrl: 'http://127.0.0.1', dtStartTime: '2026-10-05 12:00:00' }] } });
  assert.equal(rows[0].publishedAt, '2026-10-05T04:00:00.000Z'); assert.equal(rows[0].link, 'https://zzz.mihoyo.com/news/12');
  assert.equal(rows[0].summary, '10月9日19:30播出'); assert.equal(rows[0].kind, 'livestream');
  assert.throws(() => parseZzzNews({ retcode: -1, data: { list: [] } }));
  assert.throws(() => parseZzzNews({ retcode: 0 }));
});

test('鸣潮按发布时间排序跨过置顶旧消息，不把截断 HTML 当摘要', () => {
  const rows = parseWuwaNews([{ articleId: 1, articleTitle: '旧版本更新', startTime: '2025-01-01 12:00:00' }, { articleId: 2, articleTitle: '限时活动开启', articleContent: '<div><img styl', startTime: '2026-10-26 12:00:00' }]);
  assert.equal(rows[0].link, 'https://mc.kurogames.com/main/news/detail/2'); assert.equal(rows[0].summary, '');
  assert.equal(rows[0].publishedAt, '2026-10-26T04:00:00.000Z');
  assert.throws(() => parseWuwaNews({ error: 'unavailable' })); assert.throws(() => parseWuwaNews([{ other: 'layout changed' }]));
});

test('双来源合并仅补充官方动态的前瞻直播；不把空动态当故障', async () => {
  const requested = [];
  const options = { downloadPage: async url => { requested.push(url); return { content: html([news(1, '活动公告')]) }; },
    downloadRss: async url => { requested.push(url); return { xml: rss('官方资讯', '新版本前瞻通讯将于周五播出'), url }; } };
  const feed = await readGameFeed('endfield', { rsshubUrl: 'https://example.com/hub/' }, options);
  assert.deepEqual(feed.successfulSources, ['official', 'bilibili']); assert.deepEqual(feed.warnings, []); assert.equal(feed.items.length, 2);
  assert.equal(feed.items.find(row => row.channel === 'bilibili').kind, 'livestream');
  assert.equal(requested[1], 'https://example.com/hub/bilibili/user/dynamic/1265652806');
  const empty = await readGameFeed('endfield', { rsshubUrl: 'https://example.com' }, { ...options, downloadRss: async () => ({ xml: rss('角色PV', '#新版本#'), url: 'https://example.com' }) });
  assert.equal(empty.items.length, 1); assert.equal(empty.successfulSources.length, 2);
});

test('单源失败保留正常结果并显示警告；全失败和取消不可伪装为正常空列表', async () => {
  const options = { downloadPage: async () => ({ content: html([news(1, '活动公告')]) }), downloadRss: async () => { throw Error('secret upstream body'); } };
  const feed = await readGameFeed('arknights', { rsshubUrl: 'https://example.com' }, options);
  assert.deepEqual(feed.successfulSources, ['official']); assert.match(feed.warnings[0], /前瞻直播提醒可能不完整/); assert.doesNotMatch(JSON.stringify(feed), /secret/);
  await assert.rejects(readGameFeed('arknights', {}, { ...options, downloadPage: async () => { throw Error('offline'); } }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readGameFeed('arknights', {}, { ...options, signal: controller.signal }));
});

test('JSON 公告传输沿用公网 DNS 与大小限制，不把 HTML 登录页当成功', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const request = body => (url, options, cb) => { const req = new EventEmitter(); req.end = () => { const res = Readable.from([Buffer.from(body)]); res.statusCode = 200; res.headers = {}; cb(res); }; return req; };
  assert.deepEqual((await downloadPublicJson('https://example.com', { lookup, request: request('{"ok":true}') })).data, { ok: true });
  await assert.rejects(downloadPublicJson('https://example.com', { lookup, request: request('<html>login</html>') }));
  await assert.rejects(downloadPublicJson('https://example.com', { lookup, request: request(' '.repeat(2 * 1024 * 1024 + 1)) }));
  await assert.rejects(downloadPublicJson('https://example.com', { lookup: async () => [{ address: '127.0.0.1', family: 4 }], request: request('{}') }));
});

test('分来源首次基线，恢复故障来源不刷历史；正常来源仍推新消息，重启不重复', async t => {
  const f = fixture(t); await f.service.preview(f.entry.id); assert.equal(f.entry.initializedAt, null);
  await f.service.check(f.entry.id); assert.equal(f.sent.length, 0); assert.deepEqual(f.entry.gameBaselines, ['official']);
  assert.match(f.service.status().entries[0].lastWarning, /动态不可用/);
  f.setFeed({ title: '活动', items: [item('new'), item('live-old', 'bilibili'), item('old')], successfulSources: ['official', 'bilibili'], warnings: [] });
  await f.service.check(f.entry.id); assert.equal(f.sent.length, 1); assert.match(f.sent[0].message.find(segment => segment.type === 'text').data.text, /活动／版本更新/);
  assert.equal(f.entry.lastWarning, '');
  f.setFeed({ title: '活动', items: [item('live-new', 'bilibili'), item('new'), item('old')], successfulSources: ['official', 'bilibili'], warnings: [] });
  await f.service.check(f.entry.id); assert.equal(f.sent.length, 2); assert.match(f.sent[1].message.find(segment => segment.type === 'text').data.text, /前瞻／直播资讯/);
  f.service.close(); const reopened = new SubscriptionService(f.dir, f.store, f.options); t.after(() => reopened.close());
  await reopened.check(f.entry.id); assert.equal(f.sent.length, 2);
});

test('各群目标隔离且保留发送失败队列；取消一群不影响其他群', async t => {
  const f = fixture(t); f.service.subscribeGroup({ type: 'game', source: '方舟' }, '10005');
  assert.equal(f.service.state.entries.length, 1); await f.service.check(f.entry.id);
  f.setFeed({ title: '活动', items: [item('new'), item('old')], successfulSources: ['official'] });
  f.setFailedGroup('10005'); await f.service.check(f.entry.id);
  assert.deepEqual(f.sent.map(x => x.group_id), ['10003']); assert.equal(f.entry.pending.length, 1);
  f.service.unsubscribeGroup(f.entry.id, '10003'); f.setFailedGroup(''); await f.service.check(f.entry.id);
  assert.deepEqual(f.sent.map(x => x.group_id), ['10003','10005']); assert.equal(f.entry.pending.length, 0);
});

test('换游戏重置来源基线，暂停或移出白名单后不发消息', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  f.service.upsert({ source: 'zzz' }, f.entry.id); assert.deepEqual(f.entry.gameBaselines, []); assert.equal(f.entry.initializedAt, null);
  f.service.upsert({ enabled: false }, f.entry.id); await assert.rejects(f.service.check(f.entry.id));
  f.service.upsert({ enabled: true }, f.entry.id); f.store.config.allowedGroups = []; await assert.rejects(f.service.check(f.entry.id));
  assert.equal(f.sent.length, 0);
});

test('待发队列已满也先记录恢复来源的全部历史，避免下一轮补发旧直播', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  f.entry.pending = Array.from({ length: 100 }, (_, n) => ({ ...item('queued' + n), groups: ['10003'], delivered: [] }));
  f.setFeed({ title: '活动', items: [item('historical-live', 'bilibili'), item('latest')], successfulSources: ['official', 'bilibili'] });
  await f.service.check(f.entry.id); assert.ok(f.entry.seen.includes('historical-live'));
  await f.service.check(f.entry.id); assert.equal(f.entry.pending.some(row => row.id === 'historical-live'), false);
});

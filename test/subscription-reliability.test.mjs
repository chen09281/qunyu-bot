import { prepareMessage } from './helpers/subscription-message.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { defaultConfig } from '../src/config.mjs';
import { SubscriptionService } from '../src/subscriptions/service.mjs';
import { normalizeSource, readFeed, resolveSubscriptionSource } from '../src/subscriptions/feeds.mjs';
import { internalRsshubBase, rsshubRequest } from '../src/subscriptions/rsshub.mjs';
import { downloadFeedXml, downloadRsshubXml } from '../src/web-images.mjs';

const post = id => ({ id, title: '公告 ' + id, summary: '', link: 'https://example.com/' + id, publishedAt: '2026-10-27T04:00:00Z' });
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-reliability-'));
  const sent = [], store = { config: { ...defaultConfig(), enabled: true, allowedGroups: ['10003'] } };
  const service = new SubscriptionService(dir, store, { now: () => Date.parse('2026-10-27T04:00:00Z'), prepareMessage, onebot: async (_action, params) => sent.push(params), fetchFeed: async () => ({ title: '作者', items: [post('old')] }), ...options });
  service.configure({ enabled: true }); t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  const add = (type = 'bilibili', source = '123') => { service.upsert({ name: '测试来源', type, source, groups: ['10003'] }); return service.state.entries.at(-1); };
  return { service, dir, sent, store, add };
}
const xml = '<rss version="2.0"><channel><title>测试 RSS</title></channel></rss>';

test('抖音浏览器路由有足够读取时间，慢来源不阻塞其他群订阅；并发最多两个', async t => {
  const f = fixture(t); const slow = f.add('douyin', 'MS4wLjABAAAAabcdefghijk'); const fast = [f.add('bilibili','123'),f.add('bilibili','456')];
  let release, active = 0, peak = 0; const finished = [];
  const gate = new Promise(resolve => { release = resolve; });
  f.service.fetchFeed = async entry => { active++; peak = Math.max(peak, active); if (entry === slow) await gate; active--; finished.push(entry.id); return { title: entry.type === 'douyin' ? '慢作者' : '快作者 的 bilibili 空间', items: [] }; };
  const checking = f.service.check();
  try {
    for (let n = 0; n < 20 && finished.length < 2; n++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(finished, fast.map(entry => entry.id)); assert.equal(peak, 2); assert.equal(slow.initializedAt, null);
  } finally { release(); await checking; }
  let options; await readFeed({ type: 'douyin', source: slow.source }, { rsshubUrl: 'https://example.com' }, { download: async (_url, input) => { options = input; return { xml: xml.replace("</channel>","<item><title>作品</title><link>https://www.douyin.com/video/1234567890</link></item></channel>") }; } });
  assert.ok(options.timeout > 60); assert.ok(options.timeout <= 90);
});

test('源读取故障不饿死已持久化的待发消息，重试不重复投递', async t => {
  const f = fixture(t), entry = f.add(); await f.service.check(entry.id);
  f.service.fetchFeed = async () => ({ title: '作者', items: [post('new'),post('old')] });
  f.service.onebot = async () => { throw Error('QQ offline'); }; await f.service.check(entry.id); assert.equal(entry.pending.length, 1);
  f.service.fetchFeed = async () => { throw Object.assign(Error('SECRET_UPSTREAM_BODY'), { code: 'UPSTREAM_HTTP', statusCode: 503 }); };
  f.service.onebot = async (_action, params) => f.sent.push(params);
  await f.service.check(entry.id); assert.equal(f.sent.length, 1); assert.equal(entry.pending.length, 0); assert.match(entry.lastError, /HTTP 503/);
  assert.equal(entry.lastReadFailed, true); await f.service.check(entry.id); assert.equal(f.sent.length, 1);
  assert.equal(JSON.stringify(f.service.status()).includes('SECRET_UPSTREAM_BODY'), false);
});

test('已知同名 B 站等待抖音结果时，不占住另一个工作位阻塞其他作者', async t => {
  const f = fixture(t), dy = f.add('douyin','MS4wLjABAAAAabcdefghijk'), matching = f.add('bilibili','123'), unrelated = f.add('bilibili','456');
  dy.lastTitle='同名作者'; matching.lastTitle='同名作者 的 bilibili 空间'; unrelated.lastTitle='其他作者 的 bilibili 空间';
  let release; const gate = new Promise(resolve => { release=resolve; }), finished=[];
  f.service.fetchFeed = async entry => { if(entry===dy)await gate;finished.push(entry.id);return{title:entry.lastTitle,items:[]}; };
  const checking=f.service.check();
  try {
    for(let n=0;n<20 && !finished.includes(unrelated.id);n++)await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(finished,[unrelated.id]);
  } finally {release();await checking;}
  assert.ok(finished.indexOf(dy.id)<finished.indexOf(matching.id));
});

test('抖音回退后恢复健康才重新优先，读取状态过旧不能永久屏蔽 B 站', async t => {
  let clock = Date.parse('2026-10-27T04:00:00Z'); const f = fixture(t, { now: () => clock });
  const bili = f.add(), dy = f.add('douyin','MS4wLjABAAAAabcdefghijk');
  f.service.fetchFeed = async entry => ({ title: entry === dy ? '同一作者' : '同一作者 的 bilibili 空间', items: [post('old')] });
  await f.service.check(); assert.deepEqual(f.service.priority(bili).suppressedGroups, ['10003']);
  clock += 31 * 60000; assert.deepEqual(f.service.priority(bili).suppressedGroups, []);
  await f.service.check(dy.id); assert.deepEqual(f.service.priority(bili).suppressedGroups, ['10003']);
  f.service.fetchFeed = async () => { throw Error('PRIVATE'); }; await f.service.check(dy.id);
  assert.deepEqual(f.service.priority(bili).suppressedGroups, []); assert.deepEqual(f.service.priority(bili).fallbackGroups, ['10003']);
  f.service.fetchFeed = async () => ({ title: '同一作者', items: [post('new'),post('old')] }); await f.service.check(dy.id);
  assert.deepEqual(f.service.priority(bili).suppressedGroups, ['10003']);
});

test('只由服务器配置的固定 RSSHub 路由允许内网，普通源和重定向不能借用例外', async () => {
  const base = 'http://rsshub:1200/hub';
  const settings = { rsshubUrl: 'https://example.com', rsshubInternalUrl: base };
  const expected = rsshubRequest(settings, '/bilibili/user/video/123'); assert.equal(expected.url, base + '/bilibili/user/video/123');
  for (const value of ['http://u:p@rsshub:1200','file:///etc/passwd','http://rsshub:1200?key=foo']) assert.throws(() => internalRsshubBase(value));
  assert.throws(() => rsshubRequest(settings, '/admin')); assert.throws(() => rsshubRequest(settings, '/bilibili/user/video/123/../../admin'));
  assert.throws(() => normalizeSource('rss', base)); await assert.rejects(resolveSubscriptionSource('RSS ' + base));
  let requests = 0;
  const lookup = async () => [{ address: '172.18.0.4', family: 4 }];
  const request = redirect => (url, options, cb) => { requests++; const req = new EventEmitter(); req.end = () => { const response = Readable.from([Buffer.from(xml)]); response.headers = redirect ? { location: redirect } : {}; response.statusCode = redirect ? 302 : 200; cb(response); }; return req; };
  assert.equal((await downloadRsshubXml(expected.url, { ...expected, lookup, request: request() })).xml, xml);
  const before = requests;
  await assert.rejects(downloadFeedXml(expected.url, { ...expected, lookup, request: request() })); assert.equal(requests, before);
  for (const redirect of ['http://rsshub:1200/admin','http://169.254.169.254/metadata','http://localhost/private']) {
    await assert.rejects(downloadRsshubXml(expected.url, { ...expected, lookup, request: request(redirect) }));
  }
});

test('服务器内网设置不进入可写后台字段；保存单项设置不会重置其他项', async t => {
  const f = fixture(t, { rsshubInternalUrl: 'http://rsshub:1200' }); f.add();
  assert.throws(() => f.service.configure({ rsshubInternalUrl: 'http://evil:1200' }));
  f.service.configure({ rsshubUrl: 'https://example.com', intervalMinutes: 30 }); f.service.configure({ enabled: false });
  assert.deepEqual(f.service.status().settings, { enabled: false, rsshubUrl: 'https://example.com', intervalMinutes: 30 });
  assert.equal(f.service.status().managedRsshub, true); assert.equal(JSON.stringify(f.service.status()).includes('http://rsshub'), false);
  assert.equal(readFileSync(f.service.path,'utf8').includes('http://rsshub'),false);
  f.service.configure({ enabled: true }); let supplied;
  f.service.fetchFeed = async (_entry, settings) => { supplied = settings; return { title: '作者', items: [] }; }; await f.service.check();
  assert.equal(supplied.rsshubInternalUrl, 'http://rsshub:1200');
});

test('上游错误分类保留状态与超时原因，绝不输出源响应或 Cookie', async t => {
  for (const [details, text] of [[{code:'ETIMEDOUT'},'超时'],[{code:'UPSTREAM_HTTP',statusCode:502},'HTTP 502'],[{code:'FEED_HTML'},'登录页'],[{code:'FEED_FORMAT'},'格式无效']]) {
    const f = fixture(t), entry = f.add(); f.service.fetchFeed = async () => { throw Object.assign(Error('SESSDATA=SECRET'),details); };
    await f.service.check(entry.id); assert.ok(entry.lastError.includes(text)); assert.ok(f.service.status().entries[0].nextCheckAt);
    await assert.rejects(f.service.preview(entry.id), error => error.message.includes(text) && !error.message.includes('SECRET'));
  }
});

test('预览和定时检查共用两个读取名额，取消排队任务后不会泄漏名额', async t => {
  const f = fixture(t), entry = f.add(); let active = 0, peak = 0;
  f.service.fetchFeed = async (_entry, _settings, { signal }) => {
    active++; peak = Math.max(peak, active);
    try { await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })); }
    finally { active--; }
  };
  const tasks = [f.service.preview(entry.id), f.service.preview(entry.id), f.service.check(entry.id)];
  for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak,2); assert.equal(f.service.readWaiters.length,1);
  f.service.configure({ enabled: false }); await Promise.allSettled(tasks);
  assert.equal(f.service.activeReads,0); assert.equal(f.service.readWaiters.length,0); assert.equal(f.sent.length,0);
});

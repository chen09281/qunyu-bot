import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SubscriptionService } from '../src/subscriptions/service.mjs';
import { HealthCenter } from '../src/subscriptions/health.mjs';
import { defaultConfig } from '../src/config.mjs';

const folder = t => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-health-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const feed = { title: '作者', items: [{ id: 'item-1', title: '更新', link: 'https://t.bilibili.com/998134289197432851', publishedAt: '2026-11-04T01:00:00.000Z' }],
  warnings: [], channels: [{ channel: 'dynamic', transport: 'rsshub', ok: false }, { channel: 'dynamic', transport: 'official', ok: true, fallbackUsed: true }], fallbacks: ['bilibili-official-dynamic'] };

test('只读探测不发送 QQ、不修改订阅基线，并返回实际通道', async t => {
  const dir = folder(t), store = { config: { ...defaultConfig(), allowedGroups: ['10003'] } };
  const service = new SubscriptionService(dir, store, { fetchFeed: async () => feed, onebot: async () => assert.fail('probe must not call OneBot') }); t.after(() => service.close());
  service.upsert({ name: '作者', type: 'bilibili', source: '12345', groups: ['10003'] });
  const id = service.state.entries[0].id, before = readFileSync(service.path, 'utf8');
  const result = await service.probe(id);
  assert.equal(result.ok, true); assert.equal(result.itemCount, 1); assert.equal(result.channels[1].transport, 'official');
  assert.equal(readFileSync(service.path, 'utf8'), before);
  assert.equal(service.status().entries[0].probe.ok, true); assert.equal(service.status().entries[0].lastReadAt, null);
});

test('探测失败返回安全错误，状态包含重试阶段和回退信息', async t => {
  const dir = folder(t), store = { config: { ...defaultConfig(), allowedGroups: ['10003'] } };
  const service = new SubscriptionService(dir, store, { fetchFeed: async () => { throw Object.assign(new Error('upstream PRIVATE_COOKIE'), { code: 'UPSTREAM_HTTP', statusCode: 503 }); }, onebot: async () => assert.fail('no QQ') }); t.after(() => service.close());
  service.upsert({ name: '作者', type: 'bilibili', source: '12345', groups: ['10003'] });
  const id = service.state.entries[0].id, result = await service.probe(id);
  assert.equal(result.ok, false); assert.match(result.error, /503/); assert.ok(!result.error.includes('PRIVATE_COOKIE'));
  const entry = service.state.entries[0]; Object.assign(entry, { failures: 2, lastFailureStage: 'reading', lastReadFailed: true, lastError: '读取失败', lastFallbacks: ['bilibili-official-dynamic'], lastChannels: feed.channels });
  const status = service.status().entries[0]; assert.equal(status.failures, 2); assert.equal(status.lastFailureStage, 'reading'); assert.deepEqual(status.lastFallbacks, ['bilibili-official-dynamic']);
});

test('健康与测试邮件接口受鉴权保护，探测不改状态且 SMTP 秘密不回显', async t => {
  const { createApplication } = await import('../src/server.mjs');
  const dir = folder(t), sent = [];
  const app = await createApplication({ dataDir: dir, initialPassword: 'test-health-password', bilibiliAutoStart: false, douyinAutoStart: false,
    checkinAutoStart: false, subscriptionAutoStart: false, scheduledChatAutoStart: false, serverStatusAutoStart: false, operationsAutoStart: false,
    subscriptionOptions: { fetchFeed: async () => feed }, healthOptions: { parserStatus: async () => ({ available: true, detail: '解析器已就绪', platforms: [] }) },
    emailAlertOptions: { sendMail: async mail => sent.push(mail) } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  app.bot.onebot = () => assert.fail('health checks must not send QQ messages');
  app.store.config.allowedGroups = ['10003']; app.subscriptions.upsert({ name: '作者', type: 'bilibili', source: '12345', groups: ['10003'] });
  const id = app.subscriptions.state.entries[0].id, base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base + '/api/health')).status, 401);
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  assert.equal((await fetch(base + '/api/test-email', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const login = await fetch(base + '/api/login', { method: 'POST', headers, body: JSON.stringify({ username: 'admin', password: 'test-health-password' }) });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const health = await (await fetch(base + '/api/health', { headers })).json();
  assert.equal(health.sources.length, 1); assert.equal(health.parser.available, true);
  const saved = await (await fetch(base + '/api/config', { method: 'PUT', headers, body: JSON.stringify({ smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecure: true,
    smtpUser: 'bot@example.com', smtpPassword: 'PRIVATE_SMTP_SECRET', emailAlertRecipient: 'admin@example.com', emailAlertsEnabled: false }) })).json();
  assert.equal(saved.smtpPasswordConfigured, true); assert.equal(saved.smtpPassword, undefined); assert.ok(!JSON.stringify(saved).includes('PRIVATE_SMTP_SECRET'));
  const before = readFileSync(app.subscriptions.path, 'utf8');
  const probeResponse = await fetch(`${base}/api/subscriptions/${id}/probe`, { method: 'POST', headers, body: '{}' });
  assert.equal(probeResponse.status, 200); assert.equal((await probeResponse.json()).ok, true); assert.equal(readFileSync(app.subscriptions.path, 'utf8'), before);
  const emailResponse = await fetch(base + '/api/test-email', { method: 'POST', headers, body: '{}' });
  assert.equal(emailResponse.status, 200); assert.equal(sent.length, 1); assert.equal(sent[0].to, 'admin@example.com');
  const after = await (await fetch(base + '/api/health', { headers })).json(); assert.ok(!JSON.stringify(after).includes('PRIVATE_SMTP_SECRET'));
});

test('健康中心聚合异常、回退、待投递和解析器状态，并缓存高成本状态读取', async () => {
  let parserCalls = 0;
  const subscriptions = { status: () => ({ active: false, entries: [
    { id: 'a', name: 'B 作者', type: 'bilibili', source: '1', enabled: true, state: 'degraded', lastReadAt: '2026-11-04T01:00:00.000Z', nextCheckAt: '2026-11-04T01:10:00.000Z', lastError: '', lastWarning: '', pending: 1, failures: 0, lastFailureStage: '', unauthorizedGroups: [], lastFallbacks: ['bilibili-official-dynamic'], lastChannels: feed.channels },
    { id: 'b', name: '抖音作者', type: 'douyin', source: '2', enabled: true, state: 'error', lastReadAt: '2026-11-03T01:00:00.000Z', nextCheckAt: '2026-11-04T01:05:00.000Z', lastError: '读取失败', lastWarning: '', pending: 2, failures: 3, lastFailureStage: 'reading', unauthorizedGroups: [], lastFallbacks: [], lastChannels: [] },
  ] }) };
  const health = new HealthCenter(subscriptions, null, { status: () => ({ activeIncidents: 1 }) }, { parserStatus: async () => { parserCalls++; return { available: true, detail: '解析器已就绪', platforms: [] }; } });
  const first = await health.status(), second = await health.status();
  assert.equal(first.summary.sources, 2); assert.equal(first.summary.abnormal, 1); assert.equal(first.summary.pending, 3); assert.equal(first.state, 'error');
  assert.equal(first.channels.find(channel => channel.id === 'rsshub').state, 'degraded'); assert.equal(first.channels.find(channel => channel.id === 'douyin').state, 'error');
  assert.equal(first.parser.available, true); assert.equal(parserCalls, 1); assert.equal(second.parser.available, true);
  await health.status({ refreshParser: true }); assert.equal(parserCalls, 2);
});

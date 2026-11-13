import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TokenUsageService } from '../src/token-usage.mjs';
function meter(t) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-filter-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new TokenUsageService(dir, { now: () => Date.parse('2026-11-03T16:00:00+08:00') });
}
const record = (m, timestamp, provider = 'deepseek', model = 'deepseek-flash', n = 1e6) => m.record({ provider, model, timestamp, usage: { prompt_tokens: n, completion_tokens: n, total_tokens: n * 2 } });

test('北京时间首尾日包含，单模型汇总/每日/最近调用一致，工具独立且不修改持久统计', t => {
  const m = meter(t);
  record(m, '2026-11-01T15:59:59Z'); // 11/1 23:59:59
  record(m, '2026-11-01T16:00:00Z'); // 11/2 00:00
  record(m, '2026-11-02T15:59:59Z'); // 11/2 23:59:59
  record(m, '2026-11-02T16:00:00Z'); // 11/3 00:00
  record(m, '2026-11-02T10:00:00+08:00', 'kimi', 'kimi-k3.1-pro');
  m.recordTool('search', '2026-11-02T10:00:00+08:00');
  const before = JSON.stringify(m.state);
  const result = m.status({ start: '2026-11-02', end: '2026-11-02', model: 'deepseek:deepseek-flash', detailed: true });
  assert.equal(result.totals.calls, 2); assert.equal(result.totals.cost, 10);
  assert.equal(result.totals.toolCalls, 0); assert.equal(result.totals.todayTokens, 0);
  assert.equal(result.byDay.length, 1); assert.equal(result.byDay[0].cost, result.totals.cost);
  assert.equal(result.byModel.length, 1); assert.equal(result.recent.length, 2); assert.equal(result.modelOptions.length, 2);
  const tool = m.status({ model: '__tools__', start: '2026-11-02', end: '2026-11-02' });
  assert.equal(tool.totals.cost, .005); assert.equal(tool.totals.totalTokens, 0); assert.equal(tool.totals.toolCalls, 1); assert.equal(tool.byModel.length, 0);
  assert.equal(JSON.stringify(m.state), before);
  const empty = m.status({ start: '2020-01-01', end: '2020-01-02' });
  assert.equal(empty.totals.cost, 0); assert.equal(empty.byDay.length, 0); assert.equal(empty.modelOptions.length, 2);
});

test('日期范围使用完整历史，固定官方费用按天相加不重新定价', t => {
  const m = meter(t);
  for (let i = 1; i <= 31; i++) record(m, `2026-10-${String(i).padStart(2, '0')}T10:00:00+08:00`);
  record(m, '2026-11-01T10:00:00+08:00');
  assert.equal(m.status().byDay.length, 30);
  assert.equal(m.status({ detailed: true }).byDay.length, 32);
  const row = m.state.days['2026-10-01'].models['deepseek:deepseek-flash'];
  row.officialBilledCost = 1.23456789;
  const s = m.status({ start: '2026-10-01', end: '2026-10-01' });
  assert.equal(s.totals.officialBilledCost, 1.23456789);
  assert.equal(s.totals.cost, 6.23456789); assert.equal(s.byDay[0].cost, s.totals.cost);
});

test('时间/费用/Token/请求排序双向，币种分别统计且不混排汇率', t => {
  const m = meter(t);
  record(m, '2026-11-01T10:00:00+08:00', 'kimi', 'kimi-k3.1-pro', 2e6);
  record(m, '2026-11-02T10:00:00+08:00');
  record(m, '2026-11-02T11:00:00+08:00');
  record(m, '2026-11-03T10:00:00+08:00', 'openai', 'gpt-6-sol', 5e6);
  for (const sort of ['time', 'cost', 'tokens', 'calls']) {
    const asc = m.status({ sort: `${sort}-asc`, detailed: true });
    const desc = m.status({ sort: `${sort}-desc`, detailed: true });
    const field = sort === 'time' ? 'day' : sort === 'tokens' ? 'totalTokens' : sort === 'calls' ? 'calls' : 'cost';
    assert.ok(asc.byDay[0][field] <= asc.byDay.at(-1)[field]);
    assert.ok(desc.byDay[0][field] >= desc.byDay.at(-1)[field]);
  }
  const asc = m.status({ sort: 'cost-asc' });
  assert.deepEqual(asc.byModel.map(r => r.provider), ['deepseek', 'kimi', 'openai']);
  assert.equal(asc.totals.cost, 182); assert.equal(asc.totals.costUSD, 60);
  assert.equal(m.status({ model: 'openai:gpt-6-sol', start: '2026-11-03' }).totals.costUSD, 60);
  assert.equal(m.status({ sort: 'time-asc' }).byModel[0].provider, 'kimi');
  assert.equal(m.status({ sort: 'time-desc', start: '2026-11-01' }).byModel[0].provider, 'openai');
});

test('拒绝非法日期、倒置范围和未知排序', t => {
  const m = meter(t);
  for (const options of [{ start: '2026-02-30' }, { end: 'not-date' }, { start: '2026-11-04', end: '2026-11-03' }, { sort: 'bogus' }]) assert.throws(() => m.status(options));
});

test('筛选 API 需要登录、传递日期与模型，非法日期返回 400', async t => {
  const { createApplication } = await import('../src/server.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'usage-filter-api-'));
  const app = await createApplication({ dataDir: dir, initialPassword: 'test-filter-only', bilibiliAutoStart: false,
    douyinAutoStart: false, checkinAutoStart: false, subscriptionAutoStart: false, scheduledChatAutoStart: false, serverStatusAutoStart: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); rmSync(dir, { recursive: true, force: true }); });
  record(app.tokenUsage, '2026-11-02T10:00:00+08:00');
  record(app.tokenUsage, '2026-11-03T10:00:00+08:00', 'kimi', 'kimi-k3.1-pro');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const endpoint = `${base}/api/token-usage?model=deepseek%3Adeepseek-flash&start=2026-11-02&end=2026-11-02&sort=time-asc&detailed=1`;
  assert.equal((await fetch(endpoint)).status, 401);
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers, body: JSON.stringify({ username: 'admin', password: 'test-filter-only' }) });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(endpoint, { headers }); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.totals.calls, 1); assert.equal(data.totals.cost, 10); assert.equal(data.byModel.length, 1);
  assert.equal(data.filters.sort, 'time-asc'); assert.equal(data.modelOptions.length, 2);
  assert.equal((await fetch(`${base}/api/token-usage?start=2026-02-30`, { headers })).status, 400);
  const calibration = { provider: 'deepseek', currency: 'CNY', cost: 4.4, tokens: 1621478, requests: 549 };
  assert.equal((await fetch(`${base}/api/api-billing`)).status, 401);
  assert.equal((await fetch(`${base}/api/api-billing/calibrate`, { method: 'POST', headers: {'Content-Type':'application/json','X-Admin-Request':'1'}, body: JSON.stringify(calibration) })).status, 401);
  assert.equal((await fetch(`${base}/api/api-billing/calibrate`, { method: 'POST', headers: {...headers,Origin:'https://evil.example'}, body: JSON.stringify(calibration) })).status, 403);
  const saved = await fetch(`${base}/api/api-billing/calibrate`, { method: 'POST', headers, body: JSON.stringify(calibration) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).rows.find(r=>r.provider==='deepseek').cost, 4.4);
  assert.equal((await fetch(`${base}/api/api-billing/calibrate`, { method: 'POST', headers, body: JSON.stringify({...calibration,cost:-1}) })).status, 400);

});

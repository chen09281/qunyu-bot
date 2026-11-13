import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenUsageService, resolveModelRate } from '../src/token-usage.mjs';
import { parseOfficialPrices, fetchOfficialPrices, priceSources } from '../src/model-prices.mjs';
import { Conversations } from '../src/conversations.mjs';

const folder = t => { const dir = mkdtempSync(join(tmpdir(), 'token-history-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const fixture = id => readFileSync(new URL(`./fixtures/prices/${id}${id === 'deepseek' ? '.html' : id === 'kimi' ? '.txt' : '.md'}`, import.meta.url), 'utf8');
const publicFetch = async url => new Response(fixture(priceSources.find(s => s.url === url).id));

test('旧聊天跨年补录、同日已计量去重，重启与清空不会复活旧用量', t => {
  const dir = folder(t), meter = new TokenUsageService(dir);
  meter.record({ provider: 'deepseek', model: 'deepseek-flash', timestamp: Date.parse('2026-10-30T04:00:00Z'), usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } });
  const rows = [
    { model: 'deepseek-flash', day: '2025-01-01', calls: 2, tokens: 500, unknownCalls: 0 },
    { model: 'deepseek-flash', day: '2026-10-30', calls: 3, tokens: 400, unknownCalls: 1 },
    { model: 'kimi-k3.1-pro', day: '2026-10-29', calls: 1, tokens: 200, unknownCalls: 0 }
  ];
  const report = meter.importHistory(rows);
  assert.equal(report.importedTokens, 1000);
  assert.equal(report.unknownCalls, 1);
  assert.equal(meter.status().totals.totalTokens, 1100);
  assert.equal(meter.status().totals.unknownBreakdownTokens, 1000);
  assert.equal(meter.status().totals.cost, 0.00016); // historical total-only usage is NOT charged
  assert.equal(JSON.parse(readFileSync(join(dir, 'token-usage.before-history.json'))).models['deepseek:deepseek-flash'].totalTokens, 100);
  const reopened = new TokenUsageService(dir);
  reopened.importHistory(rows);
  assert.equal(reopened.status().totals.totalTokens, 1100);
  reopened.clear();
  new TokenUsageService(dir).importHistory(rows);
  assert.equal(new TokenUsageService(dir).status().totals.totalTokens, 0);
});

test('旧统计已裁剪的日期和同名多服务商不重复累计，按日汇总不再裁剪', t => {
  const dir = folder(t), meter = new TokenUsageService(dir);
  meter.record({ model: 'shared', provider: 'deepseek', totalTokens: 100 });
  meter.record({ model: 'shared', provider: 'openai', totalTokens: 100 });
  meter.record({ model: 'deepseek-flash', totalTokens: 500 });
  meter.state.days = {};
  const report = meter.importHistory([
    { model: 'shared', day: '2025-01-01', calls: 1, tokens: 100, unknownCalls: 0 },
    { model: 'deepseek-flash', day: '2025-01-01', calls: 1, tokens: 500, unknownCalls: 0 }
  ]);
  assert.equal(report.ambiguousTokens, 600);
  assert.equal(meter.status().totals.totalTokens, 700);
  for (let i = 0; i < 95; i++) meter.record({ model: 'new', totalTokens: 1, timestamp: Date.UTC(2026, 0, i + 1) });
  assert.equal(Object.keys(new TokenUsageService(dir).state.days).length, 95);
});

test('SQLite 全历史聚合含失败调用与未知用量，不返回消息正文', t => {
  const db = new Conversations(join(folder(t), 'history.sqlite'));
  t.after(() => db.close());
  const event = { self_id: 1, group_id: 2, user_id: 3 };
  const a = db.begin(event, 'private question', 'gpt-6-sol', 'a');
  db.finish(a.turnId, { status: 'failed', tokens: 123 });
  db.begin(event, 'other secret', 'gpt-6-sol', 'b');
  const rows = db.usageHistory();
  assert.equal(rows[0].tokens, 123);
  assert.equal(rows[0].unknownCalls, 1);
  assert.doesNotMatch(JSON.stringify(rows), /secret|private question|user_id/);
});

test('人民币美元分开汇总，手动价优先；未知模型不能套用同系列价格', t => {
  const meter = new TokenUsageService(folder(t), {now:()=>Date.parse('2026-11-03T02:00:00Z')});
  for (const [provider, model] of [['deepseek', 'deepseek-flash'], ['openai', 'gpt-6.1-sol'], ['kimi', 'kimi-k3.1-pro']]) {
    meter.record({ provider, model, usage: { prompt_tokens: 1e6, completion_tokens: 1e6, total_tokens: 2e6 } });
  }
  assert.equal(meter.status().totals.cost, 91);
  assert.equal(meter.status().totals.costUSD, 12);
  assert.equal(resolveModelRate('deepseek', 'deepseek-unknown').source, 'unpriced');
  assert.equal(resolveModelRate('openai', 'gpt-6.1-sol-extra').source, 'unpriced');
  meter.configurePricing({ customModels: [{ provider: 'openai', model: 'gpt-6.1-sol', inputPrice: 10, outputPrice: 20 }] });
  assert.equal(meter.status().totals.cost, 121);
  assert.equal(meter.status().totals.costUSD, 0);
});

test('旧计量文件只有总数时也标记缺少明细，而不是显示免费', t => {
  const dir = folder(t), meter = new TokenUsageService(dir);
  meter.record({ model: 'deepseek-flash', totalTokens: 1000 });
  delete meter.state.models['deepseek:deepseek-flash'].unknownBreakdownTokens;
  for (const day of Object.values(meter.state.days)) delete day.models['deepseek:deepseek-flash'].unknownBreakdownTokens;
  meter.save();
  const view = new TokenUsageService(dir).status();
  assert.equal(view.totals.unknownBreakdownTokens, 1000);
  assert.equal(view.byDay[0].unknownBreakdownTokens, 1000);
  assert.equal(view.totals.cost, 0);
});

test('官方实际页面结构可解析，字段变更必须报错，不能把美元或空表当零元', () => {
  const ds = parseOfficialPrices('deepseek', fixture('deepseek'));
  assert.equal(ds[0].cachedInputPrice, 0.04);
  assert.equal(ds[1].offPeak.outputPrice, 13.5);
  const kimi = parseOfficialPrices('kimi', fixture('kimi'));
  assert.equal(kimi[0].inputPrice, 13);
  assert.equal(kimi[0].outputPrice, 68);
  assert.equal(kimi[0].cachedInputPrice, 1.3);
  assert.equal(kimi[1].cacheWriteHourPrice, 52);
  assert.throws(() => parseOfficialPrices('kimi', fixture('kimi').replace('title:`输入`', 'title:`输出`')), /表头/);
  assert.equal(parseOfficialPrices('gpt-6.1-sol', fixture('gpt-6.1-sol'))[0].currency, 'USD');
  for (const source of priceSources) assert.throws(() => parseOfficialPrices(source.id, '<html>unavailable</html>'));
  assert.throws(() => parseOfficialPrices('gpt-6-sol', fixture('gpt-6-sol').replace('| Input |', '| Changed |')));
});

test('实时同步、并发保护、部分来源失败保留旧价，不改手动配置', async t => {
  let fail = false, requests = 0;
  const meter = new TokenUsageService(folder(t), { fetchImpl: async (url, options) => {
    requests++;
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    if (fail && url.includes('openai')) return new Response('denied', { status: 403 });
    return publicFetch(url);
  } });
  meter.configurePricing({ customModels: [{ provider: 'kimi', model: 'kimi-k3.1-pro', inputPrice: 1, outputPrice: 2 }] });
  const pending = meter.syncPrices();
  await assert.rejects(meter.syncPrices(), /正在同步/);
  await pending;
  assert.equal(meter.status().catalog.syncing, false);
  assert.equal(requests, 4);
  assert.equal(Object.values(meter.status().catalog.sources).filter(s => s.error).length, 0);
  const oldPrice = meter.status().catalog.models.find(r => r.model === 'gpt-6-sol');
  fail = true;
  await meter.syncPrices();
  assert.deepEqual(meter.status().catalog.models.find(r => r.model === 'gpt-6-sol'), oldPrice);
  assert.equal(Object.values(meter.status().catalog.sources).filter(s => s.error).length, 2);
  assert.equal(meter.status().pricing.customModels[0].inputPrice, 1);
  assert.equal(new TokenUsageService(meter.dataDir).status().catalog.models.length, 7);
});

test('价格下载限制体积并拒绝错误状态，损坏统计不被自动覆盖', async t => {
  await assert.rejects(fetchOfficialPrices(priceSources[0], { fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), /过大/);
  await assert.rejects(fetchOfficialPrices(priceSources[0], { fetchImpl: async () => new Response('', { status: 302 }) }), /302/);
  const dir = folder(t); writeFileSync(join(dir, 'token-usage.json'), '{bad');
  assert.throws(() => new TokenUsageService(dir), /未覆盖原文件/);
  assert.equal(readFileSync(join(dir, 'token-usage.json'), 'utf8'), '{bad');
});

test('价格同步 API 必须登录且同源，正常同步返回价目表', async t => {
  const { createApplication } = await import('../src/server.mjs');
  const dir = folder(t), app = await createApplication({ dataDir: dir, initialPassword: 'test-only-password',
    bilibiliAutoStart: false, douyinAutoStart: false, checkinAutoStart: false, subscriptionAutoStart: false,
    scheduledChatAutoStart: false, serverStatusAutoStart: false, tokenUsageOptions: { fetchImpl: publicFetch } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.server.address().port}`, endpoint = `${base}/api/token-usage/prices/sync`;
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: '{}' })).status, 401);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers, body: JSON.stringify({ username: 'admin', password: 'test-only-password' }) });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const response = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).catalog.models.length, 7);
});

test('官方快照替换重叠日期并保留区间外和导入后的用量，工具不算 Tokens', t => {
  const dir = folder(t), meter = new TokenUsageService(dir);
  meter.record({model:'deepseek-v4-flash', timestamp:Date.parse('2026-10-16T04:00:00Z'), totalTokens:999});
  meter.record({model:'deepseek-flash', timestamp:Date.parse('2026-10-15T04:00:00Z'), totalTokens:50});
  const report={version:1,id:'a'.repeat(64),provider:'deepseek',keyName:'qqbot',start:'2026-10-16T00:00:00+08:00',end:'2026-10-17T00:00:00+08:00',actualCost:'0.00521',rows:[
    {model:'deepseek-flash',name:'deepseek-flash',start:'2026-10-16T00:00:00+08:00',end:'2026-10-17T00:00:00+08:00',counts:{request_count:1,input_cache_miss_tokens:100,output_tokens:10}},
    {model:'',name:'tool-search',counts:{function_call:1}}
  ]};
  meter.importOfficial(report);
  assert.equal(meter.status().totals.totalTokens,160);
  assert.equal(meter.status().officialImport.tokens,110);
  assert.equal(meter.status().officialImport.toolCalls,1);
  meter.record({model:'deepseek-flash',totalTokens:20});
  const reopened=new TokenUsageService(dir);
  reopened.importOfficial(report);
  assert.equal(reopened.status().totals.totalTokens,180);
  assert.equal(reopened.status().officialImport.actualCost,'0.00521');
  assert.throws(()=>reopened.importOfficial({...report,id:'b'.repeat(64)}),/已有官方/);
});

test('官方快照保持逐行实际费用、不猜测时段分布，并计入工具费', t => {
  const dir = folder(t), meter = new TokenUsageService(dir);
  const report = {
    version: 1,
    id: 'c'.repeat(64),
    provider: 'deepseek',
    keyName: 'qqbot',
    start: '2026-10-17T00:00:00+08:00',
    end: '2026-10-19T00:00:00+08:00',
    actualCost: '0.32220040',
    rows: [
      {
        model: 'deepseek-flash',
        name: 'deepseek-flash',
        start: '2026-10-17T00:00:00+08:00',
        end: '2026-10-18T00:00:00+08:00',
        counts: { request_count: 37, input_cache_miss_tokens: 76812, input_cache_hit_tokens: 5120, output_tokens: 14222 },
        actualCost: '0.1338024000000000'
      },
      {
        model: 'deepseek-v4-pro',
        name: 'deepseek-v4-pro',
        start: '2026-10-18T00:00:00+08:00',
        end: '2026-10-19T00:00:00+08:00',
        counts: { request_count: 1, input_cache_miss_tokens: 4226, output_tokens: 1806 },
        actualCost: '0.0433980000000000'
      },
      {
        model: '',
        name: 'tool-search',
        start: '2026-10-17T00:00:00+08:00',
        end: '2026-10-18T00:00:00+08:00',
        counts: { function_call: 29 },
        actualCost: '0.1450000000000000'
      }
    ]
  };
  meter.importOfficial(report);
  const s = meter.status();
  assert.equal(s.totals.modelCost, 0.1772004);
  assert.equal(s.totals.toolCalls, 29);
  assert.equal(s.totals.toolCost, 0.145);
  assert.equal(s.totals.cost, 0.3222004);
  assert.equal(s.totals.savedCost, 0);
  assert.equal(s.totals.discountCalls, 0);
});

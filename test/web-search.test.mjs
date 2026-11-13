import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validatePatch } from '../src/config.mjs';
import { webSearchProvider, searchWeb, fetchSearchPage } from '../src/web-search.mjs';
import { modelConfig, completionRequest } from '../src/model-provider.mjs';
import { Bot } from '../src/bot.mjs';

const profile = (provider, protocol = 'chat') => ({ id: provider, name: provider, provider, baseUrl: provider === 'kimi' ? 'https://api.moonshot.cn/v1' : 'https://openai.example/v1', apiKey: `TEST_${provider}`, model: provider === 'kimi' ? 'k3.1-pro' : protocol === 'responses' ? 'gpt-6.1-sol' : 'gpt-4.1-mini', protocol, vision: true, tools: true, search: true, effort: 'low', maxTokens: 4096, unlimited: false });
const config = (provider, protocol = 'chat') => validatePatch(defaultConfig(), { webSearchEnabled: true, modelProfiles: [profile(provider, protocol)], modelRoutes: { chat: provider } });
const answer = () => ({ choices: [{ message: { content: '回答', finish_reason: 'stop' } }], usage: { total_tokens: 3 } });

test('OpenAI Responses 使用原生 web_search，不调用 DeepSeek 搜索接口', async t => {
  const c = config('openai', 'responses'), bot = new Bot({ config: c }), calls = [];
  t.after(() => bot.close()); bot.request = async (url, body, key) => { calls.push({ url, body, key }); return answer(); };
  await bot.completion('查询最新信息', c);
  assert.equal(calls.length, 1); assert.match(calls[0].url, /responses$/);
  assert.equal(calls[0].body.tools[0].type, 'web_search');
  assert.equal(calls[0].body.tools[0].function, undefined);
});

test('Kimi 官方接口使用 text_query 并规范化搜索结果和网页正文', async t => {
  const c = config('kimi'), bot = new Bot({ config: c }), calls = [];
  t.after(() => bot.close());
  bot.request = async (url, body, key) => {
    calls.push({ url, body, key });
    if (url.endsWith('/tools/search')) return { search_results: [{ title: '鸣潮', url: 'https://example.com/post', snippet: '摘要', text: '正文' }] };
    if (url.endsWith('/tools/fetch')) return { title: '页面', markdown: '# 正文' };
    return answer();
  };
  await bot.completion('查询鸣潮最新信息', c);
  assert.equal(calls[0].body.text_query, '查询鸣潮最新信息'); assert.equal(calls[0].body.include_content, false);
  const provider = webSearchProvider(modelConfig(c));
  const page = await fetchSearchPage(bot, provider, 'https://example.com/post', 10);
  assert.equal(page.content, '# 正文');
});

test('兼容聊天模型可回退到已保存的 DeepSeek 搜索接口', async t => {
  const c = config('openai'); c.deepseekKey = 'TEST_deepseek'; c.deepseekUrl = 'https://api.deepseek.com';
  const bot = new Bot({ config: c }), calls = []; t.after(() => bot.close());
  bot.request = async (url, body, key) => { calls.push({ url, body, key }); return url.endsWith('/tools/search') ? { results: [] } : answer(); };
  await bot.completion('查询信息', c);
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search'); assert.equal(calls[0].key, 'TEST_deepseek');
  assert.equal(calls[0].body.query, '查询信息');
});

test('模型库搜索开关默认开启且可单独关闭，Responses 工具与文档工具兼容', () => {
  const c = config('openai', 'responses'); assert.equal(c.modelProfiles[0].search, true);
  c.modelProfiles[0].search = false; assert.equal(webSearchProvider(modelConfig(c)).kind, 'disabled');
  const disabled = modelConfig({ ...c, webSearchEnabled: false }); assert.equal(webSearchProvider(disabled).kind, 'disabled');
  const request = completionRequest({ ...modelConfig(c), nativeWebSearch: true }, [], []);
  assert.deepEqual(request.body.tools, [{ type: 'web_search' }]);
});

test('定时主动问候即使联网开启也不搜索，原生搜索未调用时不能误报完成', async t => {
  const c = config('openai', 'responses'), bot = new Bot({ config: c }), calls = []; t.after(() => bot.close());
  bot.request = async (url, body) => { calls.push({ url, body }); return answer(); };
  const proactive = {}; await bot.completion('午安', c, proactive, [], [], () => {}, [], '', 'proactive');
  assert.equal(calls[0].body.tools, undefined); assert.equal(proactive.searchStatus, 'disabled');
  const regular = {}; await bot.completion('你好', c, regular); assert.equal(regular.searchStatus, 'not_used');
});

test('原生搜索调用及引用来源在流式和 JSON 结果中保留，和文档工具结果兼容', async () => {
  const { readResponsesResponse } = await import('../src/responses-stream.mjs');
  const result = await readResponsesResponse(Response.json({ status: 'completed', output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ title: '官网', url: 'https://example.com/news' }] } },
    { type: 'message', content: [{ type: 'output_text', text: '最新公告', annotations: [{ type: 'url_citation', title: '官网', url: 'https://example.com/news' }, { type: 'url_citation', title: 'bad', url: 'http://127.0.0.1/private' }] }] }
  ] }));
  assert.equal(result.webSearch.calls, 1); assert.deepEqual(result.webSearch.sources, [{ title: '官网', url: 'https://example.com/news' }]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { defaultConfig, openStore, publicConfig, validatePatch } from '../src/config.mjs';
import { modelConfig } from '../src/model-provider.mjs';
import { Bot } from '../src/bot.mjs';
import { ScheduledChat } from '../src/scheduled-chat.mjs';
import { createApplication } from '../src/server.mjs';

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-openai-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
const configured = patch => ({ ...defaultConfig(), apiProvider: 'openai', openaiKey: 'OPENAI_TEST_ONLY', ...patch });

test('旧配置默认仍用 DeepSeek；两家凭据、模型与预算独立持久化且不回显', async t => {
  const dir = folder(t), old = defaultConfig();
  for (const key of Object.keys(old)) if (key.startsWith('openai') || key === 'apiProvider') delete old[key];
  old.deepseekKey = 'DS_TEST_ONLY'; writeFileSync(join(dir, 'config.json'), JSON.stringify(old));
  const store = await openStore(dir);
  assert.equal(store.config.apiProvider, 'deepseek'); assert.equal(modelConfig(store.config).model, old.model);
  const result = store.save({ apiProvider: 'openai', openaiKey: 'OPENAI_TEST_ONLY', openaiModel: 'example-chat-model', openaiMaxTokensUnlimited: false, openaiMaxTokens: 2048 });
  assert.equal(result.modelApiKeyConfigured, true); assert.equal(result.activeModel, 'example-chat-model');
  assert.equal(result.deepseekKeyConfigured, true); assert.equal(result.openaiKeyConfigured, true);
  assert.equal(JSON.stringify(result).includes('TEST_ONLY'), false);
  const restored = await openStore(dir), active = modelConfig(restored.config);
  assert.equal(active.deepseekKey, 'OPENAI_TEST_ONLY'); assert.equal(active.maxTokens, 2048);
  restored.save({ apiProvider: 'deepseek' });
  assert.equal(modelConfig(restored.config).deepseekKey, old.deepseekKey);
  assert.equal(modelConfig(restored.config).maxTokens, old.maxTokens);
  assert.equal(restored.config.openaiKey, 'OPENAI_TEST_ONLY');
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);
});

test('OpenAI 配置校验、切换主机防止沿用密钥，空识图模型沿用当前模型', () => {
  const config = configured();
  for (const patch of [{ apiProvider: 'unknown' }, { openaiUrl: 'http://example.com/v1' }, { openaiUrl: 'https://a.example/v1?token=x' }, { openaiUrl: 'https://a.example/v1/chat/completions' }, { openaiKey: 'abc\nsecret' }, { openaiModel: '' }, { openaiReasoningEffort: 'max' }, { openaiMaxTokens: 0 }, { openaiMaxTokensUnlimited: 1 }]) assert.throws(() => validatePatch(config, patch));
  assert.throws(() => validatePatch(config, { openaiUrl: 'https://new.example/v1' }), /重新填写/);
  assert.equal(validatePatch(config, { openaiUrl: 'https://new.example/v1', openaiKey: 'NEW_TEST_ONLY' }).openaiUrl, 'https://new.example/v1');
  assert.equal(validatePatch(config, { openaiUrl: 'https://api.openai.com/' }).openaiUrl, 'https://api.openai.com/v1');
  assert.equal(modelConfig(config).visionModel, config.openaiModel);
  assert.equal(validatePatch(defaultConfig(), { apiProvider: 'openai', enabled: true }).enabled, true);
  assert.equal(publicConfig({ ...config, deepseekKey: '' }).modelApiKeyConfigured, true);
});

test('关闭联网时 OpenAI 文字、图像、工具、预算、思考参数独立且不调用 DeepSeek 搜索', async t => {
  const config = configured({ webSearchEnabled: false, deepseekKey: 'DS_TEST_ONLY', openaiVisionModel: 'vision-example' }), bot = new Bot({ config });
  t.after(() => bot.close()); const calls = [];
  bot.request = async (url, body, key) => { calls.push({ url, body, key }); return { choices: [{ message: { content: '测试回答' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }; };
  const trace = {}; await bot.completion('你好', config, trace);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(calls[0].key, 'OPENAI_TEST_ONLY'); assert.equal(calls[0].body.model, config.openaiModel);
  assert.equal(calls[0].body.thinking, undefined); assert.equal(calls[0].body.reasoning_effort, undefined);
  assert.equal(calls[0].body.max_tokens, undefined); assert.equal(calls[0].body.max_completion_tokens, undefined);
  assert.doesNotMatch(calls[0].body.messages[0].content, /由 DeepSeek 驱动/);
  assert.equal(trace.searchStatus, 'disabled'); assert.equal(trace.tokens, 5);
  const active = modelConfig({ ...config, openaiMaxTokensUnlimited: false, openaiMaxTokens: 4096, openaiReasoningEffort: 'medium' });
  await bot.completion('图中是什么', { ...active, model: active.visionModel }, {}, [], ['data:image/png;base64,TEST']);
  assert.equal(calls.at(-1).body.model, 'vision-example'); assert.equal(calls.at(-1).body.max_completion_tokens, 4096);
  assert.equal(calls.at(-1).body.reasoning_effort, 'medium');
  assert.equal(calls.at(-1).body.messages.at(-1).content[1].type, 'image_url');
  await bot.completion('生成一份 Word 文档，标题为测试，内容介绍春天', config);
  assert.equal(calls.at(-1).body.tools[0].function.name, 'create_document');
  assert.equal(config.deepseekKey, 'DS_TEST_ONLY'); assert.equal(config.webSearchEnabled, false);
});

test('只绑定 OpenAI 也能定时聊天，并使用小预算、不继承 DeepSeek 参数', async t => {
  const dir = folder(t), config = configured({ enabled: true, botId: '10001', allowedGroups: ['10003'], openaiReasoningEffort: 'high' });
  const store = { config }, bot = new Bot(store), calls = [], sent = [];
  bot.request = async (url, body, key) => { calls.push({ url, body, key }); return { choices: [{ message: { content: '午安，补给时间到！' } }] }; };
  bot.onebot = async (action, params) => { sent.push({ action, params }); return { message_id: 1 }; };
  const scheduler = new ScheduledChat(dir, store, bot, { now: () => Date.parse('2026-10-28T04:00:05Z') });
  t.after(() => { scheduler.close(); bot.close(); });
  await scheduler.tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].key, config.openaiKey);
  assert.equal(calls[0].body.max_completion_tokens, 256); assert.equal(calls[0].body.thinking, undefined);
  assert.equal(calls[0].body.reasoning_effort, undefined); assert.equal(calls[0].body.tools, undefined);
  assert.equal(sent[0].action, 'send_group_msg');
});

test('后台首次绑定 OpenAI、模型列表、流式测试、群私聊均使用正确密钥和模型', async t => {
  const dir = folder(t), calls = [], sent = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    calls.push({ url: req.url, auth: req.headers.authorization, body });
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] }));
    if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('{}'); }
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: '+JSON.stringify({ choices: [{ index: 0, delta: { content: '连接成功' } }] })+'\n\n');
    res.write('data: '+JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const app = await createApplication({ dataDir: dir, initialPassword: 'test1234' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { app.bot.close(); for (const server of [app.server, upstream]) await new Promise(r => { server.close(r); server.closeAllConnections(); }); });
  const base = `http://127.0.0.1:${app.server.address().port}`, headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  const login = await fetch(base+'/api/login', { method: 'POST', headers, body: JSON.stringify({ username: 'admin', password: 'test1234' }) });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (path, body) => fetch(base+'/api/'+path, { method: 'POST', headers, body: JSON.stringify(body) });
  const setup = await post('setup-api-key', { provider: 'openai', key: 'OPENAI_TEST_ONLY' });
  assert.equal(setup.status, 200); assert.equal((await setup.json()).modelApiKeyConfigured, true);
  assert.equal(app.store.config.deepseekKey, '');
  await post('setup-api-key', { provider: 'deepseek', key: 'MUST_NOT_REPLACE' });
  assert.equal(app.store.config.apiProvider, 'openai');
  app.store.save({ openaiUrl: `http://127.0.0.1:${upstream.address().port}/v1`, openaiKey: 'OPENAI_TEST_ONLY', enabled: true, botId: '10001', allowedGroups: ['10003'], allowedPrivateUsers: ['10002'], cooldownSeconds: 0 });
  const models = await (await fetch(base+'/api/models', { headers })).json();
  assert.equal(models.savedModel, 'gpt-4.1-mini'); assert.equal(models.models.length, 1);
  const result = await post('test-deepseek', {}); assert.equal(result.status, 200); assert.equal((await result.json()).text, '连接成功');
  app.bot.onebot = async (action, params) => { sent.push({ action, params }); return { message_id: sent.length }; };
  for (const message_type of ['group', 'private']) {
    app.bot.receive({ post_type: 'message', message_type, self_id: 10001, user_id: 10002, group_id: 10003, message_id: message_type === 'group' ? 100 : 101, message: [...(message_type === 'group' ? [{ type: 'at', data: { qq: '10001' } }] : []), { type: 'text', data: { text: '你好' } }] });
    for (let n=0; (app.bot.active || app.bot.queue.length) && n<100; n++) await new Promise(r => setTimeout(r, 10));
  }
  assert.deepEqual(sent.map(x => x.action), ['send_group_msg', 'send_private_msg']);
  assert.ok(calls.every(x => x.auth === 'Bearer OPENAI_TEST_ONLY'));
  assert.ok(calls.filter(x => x.body).every(x => x.body.model === 'gpt-4.1-mini' && !Object.hasOwn(x.body, 'thinking')));
  assert.equal(JSON.stringify(app.bot.logs).includes('OPENAI_TEST_ONLY'), false);
});

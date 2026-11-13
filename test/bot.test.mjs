import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApplication } from '../src/server.mjs';
import { Bot, extractPrompt } from '../src/bot.mjs';
import { cleanGroupReply } from '../src/reply.mjs';
import { defaultConfig, validatePatch } from '../src/config.mjs';

const event = (overrides = {}) => ({ post_type: 'message', message_type: 'group', self_id: 10001, user_id: 10002, group_id: 10003, message_id: 1,
  message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 你好 ' } }], ...overrides });
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); });
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('异步任务未在预期时间内完成');
}

test('群回复去除来源附录和引用编号，保留正文、必要网址和代码', () => {
  assert.equal(cleanGroupReply('结论正确[1]，补充说明【2】。\n\n**参考来源：**\n1. https://example.com\n2. https://other.example'), '结论正确，补充说明。');
  assert.equal(cleanGroupReply('答案[^1]。\n[^1]: https://example.com\n来源：https://example.com'), '答案。');
  assert.equal(cleanGroupReply('答案[1](https://example.com)。（来源：https://example.com）'), '答案。');
  assert.equal(cleanGroupReply('用户需要的网址：https://example.com\n```js\nconst a = [1];\n```'), '用户需要的网址：https://example.com\n```js\nconst a = [1];\n```');
  assert.equal(cleanGroupReply('正文\n## 来源\nhttps://example.com\n## 结论\n总结内容'), '正文\n## 结论\n总结内容');
});

test('只提取真实 @ 自己的群消息', () => {
  assert.equal(extractPrompt(event()), '你好');
  for (const override of [
    { message_type: 'private' }, { post_type: 'message_sent' }, { user_id: 10001 },
    { message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '你好' } }] },
    { message: [{ type: 'at', data: { qq: '99999' } }, { type: 'text', data: { text: '你好' } }] },
    { message: [{ type: 'text', data: { text: '[CQ:at,qq=10001] 你好' } }] },
    { message: [{ type: 'at', data: { qq: '10001' } }] },
    { message: '&#91;CQ:at,qq=10001&#93; 你好' }, { message_id: null }
  ]) assert.equal(extractPrompt(event(override)), null);
  assert.equal(extractPrompt(event(), '99999'), null);
  assert.equal(extractPrompt(event({ message: '[CQ:reply,id=3][CQ:at,qq=10001] A &amp; B &#91;test&#93;' })), 'A & B [test]');
});

test('配置校验拒绝错误地址与参数，允许无模型密钥启用插件', () => {
  const c = defaultConfig();
  for (const patch of [{ enabled: 'true' }, { maxTokens: -1 }, { timeoutSeconds: 0 }, { allowedGroups: ['abc'] },
    { deepseekUrl: 'http://example.com' }, { onebotUrl: 'file:///etc/passwd' }, { webhookToken: 'x' }, { deepseekKey: 'x\r\ny' },
    { thinkingEnabled: 'true' }, { webSearchEnabled: 1 }, { reasoningEffort: 'unknown' },
    { memoryEnabled: 'true' }, { contextTurns: 0 }, { contextTurns: 51 }, { contextTurns: 1.5 }]) {
    assert.throws(() => validatePatch(c, patch));
  }
  assert.equal(validatePatch(c, { enabled: true }).enabled, true);
  assert.equal(validatePatch(c, { deepseekKey: 'test', enabled: true }).enabled, true);
});

test('限制并发与队列容量，暂停后不发送生成中回复或启动排队任务', async () => {
  const store = { config: { ...defaultConfig(), allowedGroups: ['10003'], enabled: true, deepseekKey: 'fake', cooldownSeconds: 0 } };
  const bot = new Bot(store), release = []; let modelCalls = 0, sent = 0;
  bot.completion = () => { modelCalls++; return new Promise(resolve => release.push(() => resolve({ text: '测试', tokens: 1 }))); };
  bot.onebot = async () => { sent++; };
  for (let i = 0; i < 25; i++) bot.receive(event({ message_id: i, user_id: 10002 + i % 2 }));
  assert.equal(modelCalls, 2); assert.equal(bot.active, 2); assert.equal(bot.queue.length, 20);
  assert.equal(bot.stats.triggered, 22); assert.equal(bot.stats.ignored, 3);
  store.config.enabled = false; release.forEach(resolve => resolve());
  await until(() => bot.active === 0);
  assert.equal(sent, 0); assert.equal(modelCalls, 2); assert.equal(bot.queue.length, 0); bot.close();
});

test('调用日志保留失败、空回复和取消发送时的真实用量，区分未调用与未知用量', async () => {
  const store = { config: { ...defaultConfig(), allowedGroups: ['10003'], enabled: true, deepseekKey: 'fake', webSearchEnabled: false } };
  const bot = new Bot(store), job = { event: event(), prompt: '你好', config: store.config };
  let calls = 0;
  bot.request = async () => { calls++; throw new Error('上游请求超时'); };
  await bot.run({ ...job, config: { ...store.config, deepseekKey: '' } });
  assert.equal(calls, 0);
  assert.equal(bot.logs[0].deepseekCalled, false); assert.equal(bot.logs[0].tokens, 0);
  await bot.run(job);
  assert.equal(bot.logs[0].deepseekCalled, true); assert.equal(bot.logs[0].tokens, null);
  assert.equal(bot.stats.tokens, 0);
  bot.request = async () => ({ choices: [{ message: { content: '回复' } }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } });
  bot.onebot = async () => { throw new Error('QQ 发送失败'); };
  await bot.run(job);
  assert.equal(bot.logs[0].message, 'QQ 发送失败'); assert.equal(bot.logs[0].tokens, 12);
  assert.equal(bot.logs[0].promptTokens, 8); assert.equal(bot.logs[0].completionTokens, 4);
  assert.equal(bot.stats.tokens, 12);
  bot.request = async () => ({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });
  await bot.run(job);
  assert.equal(bot.logs[0].level, 'error'); assert.equal(bot.logs[0].tokens, 5); assert.equal(bot.stats.tokens, 17);
  bot.request = async () => {
    store.config.enabled = false;
    return { choices: [{ message: { content: '回复' } }], usage: { total_tokens: 7 } };
  };
  await bot.run(job);
  assert.equal(bot.logs[0].level, 'warn'); assert.equal(bot.logs[0].deepseekCalled, true);
  assert.equal(bot.logs[0].tokens, 7); assert.equal(bot.logs[0].promptTokens, null); assert.equal(bot.stats.tokens, 24);
  store.config.enabled = true;
  bot.request = async () => ({ choices: [{ message: { content: '回复' } }], usage: { total_tokens: -1, prompt_tokens: 'bad' } });
  bot.onebot = async () => {};
  await bot.run(job);
  assert.equal(bot.logs[0].level, 'success'); assert.equal(bot.logs[0].tokens, null);
  assert.equal(bot.stats.tokens, 24);
  bot.receive(event({ message_id: 33 }));
  await until(() => bot.active === 0);
  bot.receive(event({ message_id: 34 }));
  assert.equal(bot.logs[0].message, '冷却中，已忽略');
  assert.equal(bot.logs[0].deepseekCalled, false); assert.equal(bot.logs[0].tokens, 0);
  assert.equal(JSON.stringify(bot.logs).includes('你好'), false);
  bot.close();
});

test('深度思考与官方搜索链路：Unicode 搜索词、参考资料、用量和失败状态', async () => {
  const config = { ...defaultConfig(), deepseekUrl: 'https://api.deepseek.com/v1', deepseekKey: 'fake-key' };
  const bot = new Bot({ config }), calls = [], trace = {};
  const prompt = '🧪'.repeat(140) + 'PRIVATE_QUESTION';
  bot.request = async (url, body, auth, timeout) => {
    calls.push({ url, body, auth, timeout });
    if (url.endsWith('/tools/search')) return { results: [
      { title: '搜索结果', url: 'https://example.com/news', summary: 'UNTRUSTED_WEB_CONTENT', date: '2026-10-17' },
      { title: '无效链接', url: 'javascript:alert(1)', summary: '不可引用' }
    ] };
    return { choices: [{ message: { content: '最终回答', reasoning_content: 'PRIVATE_REASONING' } }], usage: { prompt_tokens: 30, completion_tokens: 70, total_tokens: 100, completion_tokens_details: { reasoning_tokens: 60 } } };
  };
  const answer = await bot.completion(prompt, config, trace);
  assert.equal(calls.length, 2); assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(Array.from(calls[0].body.query).length, 128); assert.equal(calls[0].body.query.endsWith('🧪'), true);
  assert.equal(calls[0].auth, 'fake-key'); assert.equal(calls[0].body.count, 5); assert.equal(calls[0].timeout, 30);
  assert.equal(calls[1].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.deepEqual(calls[1].body.thinking, { type: 'enabled' }); assert.equal(calls[1].body.reasoning_effort, 'high');
  assert.equal(calls[1].body.messages.at(-1).content, prompt);
  assert.ok(calls[1].body.messages.some(message => message.role === 'user' && message.content.includes('UNTRUSTED_WEB_CONTENT')));
  assert.ok(calls[1].body.messages.some(message => message.role === 'system' && message.content.includes('不可信')));
  assert.equal(answer.text, '最终回答'); assert.equal(trace.searchStatus, 'completed'); assert.equal(trace.searchResults, 1);
  assert.equal(trace.tokens, 100); assert.equal(trace.reasoningTokens, 60); assert.equal(bot.stats.tokens, 100);
  assert.equal(JSON.stringify(trace).includes('PRIVATE'), false); assert.equal(JSON.stringify(trace).includes('UNTRUSTED'), false);
  calls.length = 0;
  await bot.completion('测试关闭', { ...config, thinkingEnabled: false, webSearchEnabled: false }, trace);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
  assert.equal(calls[0].body.reasoning_effort, undefined); assert.equal(trace.searchStatus, 'disabled');
  bot.request = async url => { assert.ok(url.endsWith('/tools/search')); throw new Error('上游 HTTP 402'); };
  await assert.rejects(bot.completion('测试失败', config, trace), /联网搜索失败.*402/);
  assert.equal(trace.searchStatus, 'failed'); assert.equal(trace.deepseekCalled, true); assert.equal(trace.tokens, 0);
  bot.request = async url => url.endsWith('/tools/search') ? { results: [] } : { choices: [{ message: { content: '缺少实时资料' } }], usage: { total_tokens: 5 } };
  await bot.completion('测试无结果', config, trace);
  assert.equal(trace.searchStatus, 'empty'); assert.equal(trace.searchResults, 0); assert.equal(trace.tokens, 5);
  bot.request = async () => ({ choices: [{ message: { content: '', reasoning_content: 'PRIVATE_REASONING' }, finish_reason: 'length' }], usage: { total_tokens: 20 } });
  await assert.rejects(bot.completion('测试思考截断', { ...config, webSearchEnabled: false }, trace), /输出 Token 已用完/);
  assert.equal(trace.tokens, 20); assert.equal(JSON.stringify(trace).includes('PRIVATE_REASONING'), false);
  bot.close();
});

test('完整 HTTP 链路：鉴权、配置、消息筛选、DeepSeek 调用、QQ 回复及失败处理', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-test-'));
  const modelCalls = [], sentMessages = []; let failModel = false, failSend = false, holdResolve, holdPromise;
  const upstream = createServer(async (req, res) => {
    if (req.url === '/models' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer ds-secret');
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [
        { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        { id: 'deepseek-flash', name: '重复项' }, { id: '' }, { id: 'future-model', name: '未来模型' }
      ] }));
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/chat/completions') {
      modelCalls.push({ input, auth: req.headers.authorization });
      if (holdPromise) await holdPromise;
      if (failModel) { res.writeHead(401); return res.end(JSON.stringify({ error: 'SECRET_should_never_leak' })); }
      return res.end(JSON.stringify({ choices: [{ message: { content: '你好！[CQ:at,qq=all][1]\n\n参考来源：\nhttps://example.com' } }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }));
    }
    if (req.url === '/get_login_info') return res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '测试机器人' } }));
    if (req.url === '/send_group_msg') {
      sentMessages.push({ input, auth: req.headers.authorization });
      return res.end(JSON.stringify({ status: failSend ? 'failed' : 'ok', retcode: failSend ? 100 : 0, data: { message_id: 99 } }));
    }
    res.writeHead(404); res.end('{}');
  });
  const upstreamUrl = await listen(upstream);
  await assert.rejects(createApplication({ dataDir: dir, initialPassword: 'short77' }), /8–256/);
  const app = await createApplication({ dataDir: dir, initialPassword: 'test1234' });
  const url = await listen(app.server);
  t.after(async () => { app.bot.close(); await close(app.server); await close(upstream); await rm(dir, { recursive: true, force: true }); });
  const jsonHeaders = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  let cookie = '';
  const admin = (path, method = 'GET', data) => fetch(`${url}/api/${path}`, { method, headers: { ...jsonHeaders, Cookie: cookie }, body: data === undefined ? undefined : JSON.stringify(data) });
  const hook = (payload, auth = app.store.config.webhookToken) => fetch(`${url}/onebot/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body: JSON.stringify(payload) });
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-security-policy').includes('unsafe-eval'), false);
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
  assert.ok(assets.some(path => path.endsWith('.js')));
  assert.ok(assets.some(path => path.endsWith('.css')));
  for (const path of assets) {
    const asset = await fetch(url + path); assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), path.endsWith('.js') ? /javascript/ : /css/);
  }
  assert.equal((await fetch(`${url}/frontend/src/App.vue`)).status, 404);
  assert.equal((await fetch(`${url}/assets/missing.js`)).status, 404);
  assert.equal((await admin('config')).status, 401);
  assert.equal((await admin('models')).status, 401);
  assert.equal((await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await admin('login', 'POST', { username: 'admin', password: 'wrong' })).status, 401);
  const login = await admin('login', 'POST', { username: 'admin', password: 'test1234' });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/); assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal((await admin('models')).status, 502);
  assert.equal((await admin('config', 'PUT', { onebotUrl: upstreamUrl, deepseekUrl: upstreamUrl, onebotToken: 'qq-secret', deepseekKey: 'ds-secret', enabled: true, webSearchEnabled: false, cooldownSeconds: 0, allowedGroups: ['10003'] })).status, 200);
  const saved = await (await admin('config')).json();
  const models = await (await admin('models')).json();
  assert.deepEqual(models.models.map(model => model.id), ['deepseek-flash', 'deepseek-v4-pro', 'future-model']);
  assert.equal(models.savedModel, 'deepseek-flash');
  assert.equal((await admin('config', 'PUT', { model: 'deepseek-v4-pro' })).status, 200);
  assert.equal((await (await admin('models')).json()).savedModel, 'deepseek-v4-pro');
  assert.equal(saved.deepseekKeyConfigured, true); assert.equal(saved.deepseekKey, undefined); assert.equal(saved.onebotToken, undefined); assert.equal(saved.webhookToken, undefined);
  assert.equal((await stat(join(dir, 'config.json'))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(dir, 'admin.json'), 'utf8')).includes('test1234'), false);
  assert.equal((await fetch(`${url}/data/config.json`)).status, 404);
  assert.equal((await hook(event(), 'wrong')).status, 401);
  assert.equal(modelCalls.length, 0);
  assert.equal((await admin('test-onebot', 'POST', {})).status, 200);
  for (const payload of [event({ message_type: 'private' }), event({ message: '普通消息' }), event({ group_id: 99999 }), event({ user_id: 10001 })]) assert.equal((await hook(payload)).status, 200);
  assert.equal(modelCalls.length, 0);
  await hook(event()); await until(() => app.bot.stats.replied === 1);
  assert.equal(modelCalls.length, 1); assert.equal(sentMessages.length, 1);
  assert.equal(modelCalls[0].auth, 'Bearer ds-secret'); assert.equal(modelCalls[0].input.messages.at(-1).content, '你好');
  assert.equal(modelCalls[0].input.stream, true); assert.deepEqual(modelCalls[0].input.stream_options, { include_usage: true }); assert.equal(sentMessages[0].auth, 'Bearer qq-secret');
  assert.equal(sentMessages[0].input.group_id, 10003); assert.equal(sentMessages[0].input.message[1].type, 'text');
  assert.equal(sentMessages[0].input.message[1].data.text, ' 你好！[CQ:at,qq=all]'); // Always a text segment, never interpreted as CQ.
  const successLog = (await (await admin('status')).json()).logs.find(log => log.message === '回复已发送');
  assert.equal(successLog.deepseekCalled, true); assert.equal(successLog.tokens, 12);
  assert.equal(successLog.promptTokens, 8); assert.equal(successLog.completionTokens, 4);
  await hook(event()); assert.equal(modelCalls.length, 1);
  const raw = JSON.stringify(event({ message_id: 2, message: '[CQ:at,qq=10001] CQ 提问' }));
  const signed = await fetch(`${url}/onebot/events`, { method: 'POST', headers: { 'X-Signature': 'sha1=' + createHmac('sha1', app.store.config.webhookToken).update(raw).digest('hex') }, body: raw });
  assert.equal(signed.status, 200); await until(() => app.bot.stats.replied === 2);
  assert.equal(modelCalls[1].input.messages.at(-1).content, 'CQ 提问');
  app.store.save({ cooldownSeconds: 30 }); await hook(event({ message_id: 3 })); assert.equal(modelCalls.length, 2);
  app.store.save({ cooldownSeconds: 0, maxPromptLength: 1 }); await hook(event({ message_id: 4 })); assert.equal(modelCalls.length, 2);
  app.store.save({ maxPromptLength: 4000 }); failModel = true;
  await hook(event({ message_id: 5 })); await until(() => app.bot.stats.failed === 1);
  assert.equal(sentMessages.length, 2); assert.equal(JSON.stringify(app.bot.logs).includes('SECRET'), false);
  assert.equal(app.bot.logs[0].deepseekCalled, true); assert.equal(app.bot.logs[0].tokens, null);
  failModel = false; failSend = true;
  await hook(event({ message_id: 6 })); await until(() => app.bot.stats.failed === 2); assert.equal(app.bot.stats.replied, 2); failSend = false;
  assert.equal(app.bot.logs[0].deepseekCalled, true); assert.equal(app.bot.logs[0].tokens, 12);
  holdPromise = new Promise(resolve => holdResolve = resolve);
  await hook(event({ message_id: 7 })); await until(() => modelCalls.length === 5);
  await admin('config', 'PUT', { enabled: false }); holdResolve(); holdPromise = null;
  await until(() => app.bot.active === 0); assert.equal(sentMessages.length, 3);
  await hook(event({ message_id: 8 })); assert.equal(modelCalls.length, 5);
  assert.equal(app.bot.logs[0].deepseekCalled, false); assert.equal(app.bot.logs[0].tokens, 0);
  const tokensBeforeTest = app.bot.stats.tokens;
  assert.equal((await admin('test-deepseek', 'POST', {})).status, 200);
  assert.equal(app.bot.logs[0].message, '模型 API 连接测试成功');
  assert.equal(app.bot.logs[0].deepseekCalled, true); assert.equal(app.bot.logs[0].tokens, 12);
  assert.equal(app.bot.stats.tokens, tokensBeforeTest + 12);
  failModel = true;
  assert.equal((await admin('test-deepseek', 'POST', {})).status, 502);
  assert.equal(app.bot.logs[0].level, 'error'); assert.equal(app.bot.logs[0].deepseekCalled, true);
  assert.equal(app.bot.logs[0].tokens, null); assert.equal(app.bot.stats.tokens, tokensBeforeTest + 12);
  failModel = false;
  assert.equal((await admin('config', 'PUT', { maxTokens: 0 })).status, 400);
  assert.equal((await fetch(`${url}/api/config`, { method: 'PUT', headers: { ...jsonHeaders, Cookie: cookie, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await admin('password', 'POST', { currentPassword: 'test1234', newPassword: 'short77' })).status, 400);
  assert.equal((await admin('session')).status, 200);
  assert.equal((await admin('password', 'POST', { currentPassword: 'test1234', newPassword: 'next1234' })).status, 200);
  assert.equal((await admin('session')).status, 401);
  assert.equal((await admin('login', 'POST', { username: 'admin', password: 'next1234' })).status, 200);
  const restart = await createApplication({ dataDir: dir });
  assert.equal(restart.store.config.deepseekKey, 'ds-secret'); assert.equal(restart.store.config.enabled, false); restart.bot.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig, openStore, publicConfig, validatePatch } from '../src/config.mjs';
import { modelConfig, profileConfig, completionRequest } from '../src/model-provider.mjs';
import { emptyModelRoutes, publicModelLibrary, importLegacyModels } from '../src/model-library.mjs';
import { readResponsesResponse } from '../src/responses-stream.mjs';
import { Bot } from '../src/bot.mjs';
import { createApplication } from '../src/server.mjs';
const profile = (id, provider = 'kimi', extra = {}) => ({ id, name: id, provider, baseUrl: `https://${provider}.example/v1`, apiKey: `TEST_ONLY_${id}`, model: provider === 'kimi' ? 'kimi-k3.1-pro' : provider === 'openai' ? 'gpt-6.1-sol' : 'deepseek-flash', protocol: provider === 'openai' ? 'responses' : 'chat', vision: true, tools: true, effort: 'low', maxTokens: 4096, unlimited: false, ...extra });
const config = () => validatePatch(defaultConfig(), { enabled: true, allowedGroups: ['10003'], webSearchEnabled: false, modelProfiles: [profile('chat', 'deepseek'), profile('image', 'openai'), profile('video'), profile('document')], modelRoutes: { chat: 'chat', image: 'image', video: 'video', document: 'document' } });
const textResult = text => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { total_tokens: 3 } });
const finished = (output = [{ type: 'message', content: [{ type: 'output_text', text: '你好🙂' }] }]) => ({ status: 'completed', output, usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5, output_tokens_details: { reasoning_tokens: 1 } } });
function response(events, width = 11) {
  const bytes = new TextEncoder().encode(events.map(e => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('')); let at = 0;
  return new Response(new ReadableStream({ pull(c) { if (at >= bytes.length) return c.close(); c.enqueue(bytes.slice(at, at += width)); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('模型库独立持久化，密钥不回显且空白保留；更换地址必须重新绑定', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-models-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await openStore(dir); store.save({ modelProfiles: config().modelProfiles, modelRoutes: config().modelRoutes });
  const view = publicModelLibrary(store.config);
  assert.doesNotMatch(JSON.stringify(view) + JSON.stringify(publicConfig(store.config)), /TEST_ONLY/);
  const profiles = view.profiles.map(({ keyConfigured, ...p }) => ({ ...p, apiKey: '' }));
  store.save({ modelProfiles: profiles }); assert.equal(store.config.modelProfiles[0].apiKey, 'TEST_ONLY_chat');
  assert.throws(() => store.save({ modelProfiles: profiles.map(p => ({ ...p, baseUrl: 'https://other.example/v1' })) }), /重新填写/);
  const restored = await openStore(dir); assert.equal(modelConfig(restored.config, 'video').deepseekKey, 'TEST_ONLY_video');
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);
  assert.equal(publicConfig(store.config).activeModel, 'deepseek-flash');
});

test('拒绝损坏引用、重复模型、危险地址和错误能力；可先解除分配再删除', () => {
  const c = config();
  for (const p of [profile('x', 'kimi', { baseUrl: 'http://remote.example' }), profile('x', 'kimi', { baseUrl: 'https://u:p@example.com' }), profile('x', 'kimi', { apiKey: 'a\nb' }), profile('x', 'kimi', { effort: 'none' }), profile('x', 'openai', { protocol: 'chat' }), profile('x', 'openai', { effort: 'none' }), profile('x', 'kimi', { maxTokens: 0 })]) assert.throws(() => validatePatch(defaultConfig(), { modelProfiles: [p] }));
  assert.throws(() => validatePatch(c, { modelProfiles: [profile('x'), profile('x')] }));
  assert.throws(() => validatePatch(c, { modelProfiles: [] }), /不存在/);
  assert.throws(() => validatePatch(c, { modelProfiles: c.modelProfiles.map(p => ({ ...p, vision: false })) }), /图片/);
  assert.throws(() => validatePatch(c, { modelProfiles: c.modelProfiles.map(p => ({ ...p, tools: false })) }), /工具/);
  assert.equal(validatePatch(c, { modelProfiles: [], modelRoutes: emptyModelRoutes() }).modelProfiles.length, 0);
});

test('四种用途的模型及凭据隔离，排队后修改配置不会改变旧任务选择', () => {
  const c = config(), queued = modelConfig(c);
  const next = validatePatch(c, { modelProfiles: c.modelProfiles.map(p => ({ ...p, apiKey: 'NEW_KEY' })) });
  for (const purpose of ['chat', 'image', 'video', 'document']) {
    assert.equal(modelConfig(queued, purpose).deepseekKey, `TEST_ONLY_${purpose}`);
    assert.equal(modelConfig(next, purpose).deepseekKey, 'NEW_KEY');
  }
  assert.equal(modelConfig({ ...c, modelRoutes: { ...c.modelRoutes, image: '' } }, 'image').modelProfileId, 'chat');
  assert.equal(profileConfig(c, 'video').apiProvider, 'kimi');
  const legacy = { ...defaultConfig(), deepseekKey: 'OLD', visionModel: 'legacy-vision' };
  assert.equal(modelConfig(legacy).deepseekKey, 'OLD');
  const imported = importLegacyModels(legacy); assert.equal(imported.length, 2);
  assert.equal(importLegacyModels({ ...legacy, modelProfiles: imported }).length, 2);
});

test('真实 Bot 请求按聊天、图片、视频和文档用途选接口，Kimi 不接收 DeepSeek/OpenAI 专用参数', async t => {
  const c = config(), bot = new Bot({ config: c }), calls = []; t.after(() => bot.close());
  bot.request = async (url, body, key, timeout, method, options) => { calls.push({ url, body, key, options }); return textResult('测试成功'); };
  await bot.completion('你好', c);
  await bot.completion('图片上是什么', c, {}, [], ['data:image/png;base64,TEST']);
  await bot.completion('总结视频', c, {}, [], ['data:image/png;base64,TEST'], () => {}, [{ bvid: 'BV_TEST' }]);
  await bot.completion('生成一份 Word 文档', c);
  assert.deepEqual(calls.map(c => c.key), ['TEST_ONLY_chat', 'TEST_ONLY_image', 'TEST_ONLY_video', 'TEST_ONLY_document']);
  assert.match(calls[1].url, /responses$/); assert.equal(calls[1].body.input.at(-1).content[1].type, 'input_image');
  assert.equal(calls[1].body.max_output_tokens, 4096); assert.equal(calls[1].body.store, false);
  assert.equal(calls[2].body.thinking, undefined); assert.equal(calls[2].body.max_completion_tokens, undefined); assert.equal(calls[2].body.reasoning_effort, 'low');
  assert.equal(calls[3].body.tools[0].function.name, 'create_document');
  assert.equal(calls[2].body.model, 'kimi-k3.1-pro');
  await bot.completion('导出为 PDF', c, {}, [{ role: 'user', content: '生成一份 Word 文档' }, { role: 'assistant', content: '正文' }]);
  assert.equal(calls.at(-1).key, 'TEST_ONLY_document');
  await bot.completion('根据图片生成一份 Word 文档', c, {}, [], ['data:image/png;base64,TEST']);
  assert.equal(calls.at(-1).key, 'TEST_ONLY_document');
  assert.deepEqual(calls.at(-1).body.messages.at(-1).content[1].image_url, { url: 'data:image/png;base64,TEST' });
  const textOnly = { ...c, modelProfiles: c.modelProfiles.map(p => p.id === 'document' ? { ...p, vision: false } : p) };
  await assert.rejects(bot.completion('根据图片生成一份 Word 文档', textOnly, {}, [], ['data:image/png;base64,TEST']), /图片输入/);
  await assert.rejects(bot.completion('总结视频', c, {}, [], ['https://example.com/image.png'], () => {}, [{}]), /重新发送原图/);
});

test('Responses 流式跨字节解码、用量与文档工具转换；拒绝中断和失败结果', async () => {
  const deltas = [];
  const result = await readResponsesResponse(response([{ type: 'response.output_text.delta', delta: '你好🙂' }, { type: 'response.completed', response: finished() }]), { onDelta: d => deltas.push(d) });
  assert.equal(result.choices[0].message.content, '你好🙂'); assert.equal(result.usage.total_tokens, 5); assert.equal(deltas.map(d => d.content || '').join(''), '你好🙂');
  const args = JSON.stringify({ title: '测试', content: '正文' });
  const doc = await readResponsesResponse(response([{ type: 'response.function_call_arguments.delta', delta: args }, { type: 'response.completed', response: finished([{ type: 'function_call', call_id: 'a', name: 'create_document', arguments: args }]) }]));
  assert.equal(doc.choices[0].message.tool_calls[0].function.arguments, args);
  assert.equal(doc.choices[0].finish_reason, 'tool_calls');
  assert.equal((await readResponsesResponse(Response.json(finished()))).choices[0].message.content, '你好🙂');
  await assert.rejects(readResponsesResponse(response([{ type: 'response.output_text.delta', delta: '不完整' }])), /中断/);
  await assert.rejects(readResponsesResponse(response([{ type: 'response.failed', response: { error: 'PRIVATE_SECRET' } }])), /失败/);
  await assert.rejects(readResponsesResponse(response([{ type: 'response.output_text.delta', delta: 'a'.repeat(2 * 1024 * 1024) }] , 65536)), /超过/);
  const incomplete = await readResponsesResponse(Response.json({ ...finished(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
  assert.equal(incomplete.choices[0].finish_reason, 'length');
});

test('Sol 文档经 Responses 真实传输解析为可导出文档，不返回虚构文件链接', async t => {
  const c = config(); c.modelRoutes.document = 'image';
  const bot = new Bot({ config: c }); t.after(() => bot.close());
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /responses$/); assert.equal(options.headers.Authorization, 'Bearer TEST_ONLY_image');
    const body = JSON.parse(options.body); assert.equal(body.tools[0].name, 'create_document'); assert.equal(body.tools[0].strict, false);
    return response([{ type: 'response.completed', response: finished([{ type: 'function_call', call_id: 'doc', name: 'create_document', arguments: JSON.stringify({ title: '测试标题', content: '# 测试\n正文' }) }]) }]);
  });
  const result = await bot.completion('生成一份 Word 文档', c); assert.equal(result.document.title, '测试标题'); assert.match(result.document.content, /正文/);
});

test('QQ 图片与视频任务实际使用分配模型，日志及聊天历史记录最终模型', async t => {
  const c = config(), bot = new Bot({ config: c }), calls = []; t.after(() => bot.close());
  bot.onebot = async action => action === 'get_image' ? { url: 'https://example.com/photo.png' } : { message_id: 1 };
  bot.prepareInputImages = async () => ({ images: ['data:image/png;base64,TEST'], notes: '', stats: {} });
  bot.links = { analyzeBilibili: async () => ({ evidence: { title: '测试视频', bvid: 'BV1bGJR6HErW', frameTimes: [1] }, images: ['data:image/png;base64,TEST'] }), close() {} };
  bot.request = async (url, body, key) => { calls.push({ url, body, key }); return textResult('回答'); };
  const event = { post_type: 'message', message_type: 'group', self_id: 10001, user_id: 10002, group_id: 10003, message_id: 1, message: [{ type: 'image', data: { file: 'photo', url: 'https://example.com/photo.png' } }] };
  await bot.run({ event, prompt: '看图', config: modelConfig(c) }); assert.equal(calls.at(-1).key, 'TEST_ONLY_image');
  const cid = bot.conversations.list().items[0].id; assert.equal(bot.conversations.context(cid).at(-1).content, '回答');
  assert.equal(bot.conversations.db.prepare('SELECT model FROM conversation_turns ORDER BY id DESC').get().model, 'gpt-6.1-sol');
  await bot.run({ event: { ...event, message: [] }, prompt: '总结 https://www.bilibili.com/video/BV1bGJR6HErW', config: modelConfig(c) });
  assert.equal(calls.at(-1).key, 'TEST_ONLY_video'); assert.equal(bot.liveTasks.status().selected.model, 'kimi-k3.1-pro');
  assert.equal(bot.stats.replied, 2);
});

test('运行概览只显示聊天回复分配，切换其他用途不改变当前聊天模型', () => {
  const c = config(), first = publicConfig(c);
  assert.equal(first.activeModel, 'deepseek-flash'); assert.equal(first.activeProvider, 'deepseek');
  c.modelRoutes = { ...c.modelRoutes, chat: 'image' };
  const second = publicConfig(c);
  assert.equal(second.activeModel, 'gpt-6.1-sol'); assert.equal(second.activeProvider, 'openai');
});

test('模型库管理接口鉴权、同源保护、过期保存冲突、模型列表和重启复用', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-models-api-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await createApplication({ dataDir: dir, initialPassword: 'test-password', bilibiliAutoStart: false, douyinAutoStart: false, checkinAutoStart: false, subscriptionAutoStart: false, scheduledChatAutoStart: false, serverStatusAutoStart: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { app.server.close(r); app.server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base + '/api/model-library')).status, 401);
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  const login = await fetch(base + '/api/login', { method: 'POST', headers, body: JSON.stringify({ username: 'admin', password: 'test-password' }) }); headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const library = await (await fetch(base + '/api/model-library', { headers })).json();
  const payload = { revision: library.revision, profiles: [profile('kimi')], routes: { ...emptyModelRoutes(), chat: 'kimi' } };
  const put = h => fetch(base + '/api/model-library', { method: 'PUT', headers: h || headers, body: JSON.stringify(payload) });
  assert.equal((await put({ ...headers, Origin: 'https://evil.example' })).status, 403);
  const saved = await put(); assert.equal(saved.status, 200); assert.doesNotMatch(await saved.text(), /TEST_ONLY/);
  assert.equal((await put()).status, 409);
  let calls = 0; app.bot.request = async (url, body, key) => {
    calls++;
    assert.ok(['TEST_ONLY_kimi', 'DRAFT_ONLY_SECRET'].includes(key));
    return url.endsWith('/models') ? { data: [{ id: key === 'DRAFT_ONLY_SECRET' ? 'deepseek-flash' : 'kimi-k3.1-pro' }] } : textResult('连接成功');
  };
  const models = await fetch(base + '/api/model-library/kimi/models', { method: 'POST', headers, body: '{}' }); assert.equal((await models.json()).models[0].id, 'kimi-k3.1-pro');
  const check = await fetch(base + '/api/model-library/kimi/test', { method: 'POST', headers, body: '{}' }); assert.equal((await check.json()).text, '连接成功'); assert.equal(calls, 2);

  const draft = profile('draft-preview', 'deepseek', { apiKey: 'DRAFT_ONLY_SECRET' });
  const draftModels = await fetch(base + '/api/model-library/models', { method: 'POST', headers, body: JSON.stringify({ profile: draft }) });
  assert.deepEqual((await draftModels.json()).models, [{ id: 'deepseek-flash', name: 'deepseek-flash' }]);
  const draftTest = await fetch(base + '/api/model-library/test', { method: 'POST', headers, body: JSON.stringify({ profile: draft }) });
  assert.deepEqual(await draftTest.json(), { text: '连接成功', model: 'deepseek-flash', provider: 'deepseek' });
  assert.doesNotMatch(await (await fetch(base + '/api/model-library')).text(), /DRAFT_ONLY_SECRET|draft-preview/);
  assert.equal(app.store.config.modelProfiles.some(p => p.id === 'draft-preview'), false);
  const invalidDraft = await fetch(base + '/api/model-library/test', { method: 'POST', headers, body: JSON.stringify({ profile: { ...draft, apiKey: '' } }) });
  assert.equal(invalidDraft.status, 400); assert.match((await invalidDraft.json()).error, /API Key/);

  app.bot.request = async () => { throw Error('上游 HTTP 404'); };
  const failedModels = await fetch(base + '/api/model-library/kimi/models', { method: 'POST', headers, body: '{}' });
  assert.equal(failedModels.status, 502); assert.match((await failedModels.json()).error, /获取模型列表失败：模型不存在或当前账号无权限/);
  const failed = await fetch(base + '/api/model-library/kimi/test', { method: 'POST', headers, body: '{}' });
  assert.equal(failed.status, 502); const failure = await failed.json();
  assert.match(failure.error, /模型不存在或当前账号无权限/); assert.doesNotMatch(failure.error, /服务内部错误/);
  assert.equal(app.bot.testing, false);
  assert.equal(app.bot.conversations.list().total, 0);
  const restored = await openStore(dir); assert.equal(modelConfig(restored.config).apiProvider, 'kimi');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatResponse } from '../src/chat-stream.mjs';
import { Bot } from '../src/bot.mjs';
import { defaultConfig, validatePatch } from '../src/config.mjs';
import { LiveTasks } from '../src/live-tasks.mjs';

const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
function response(text, width = 7) {
  const bytes = new TextEncoder().encode(text); let at = 0;
  return new Response(new ReadableStream({ pull(controller) { if (at >= bytes.length) return controller.close(); controller.enqueue(bytes.slice(at, at += width)); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('长思考的累计 SSE 超过 2 MiB 后仍能取得最终答案、用量，实时预览保持有界', async t => {
  const config = { ...defaultConfig(), deepseekKey: 'SYNTHETIC_TEST_KEY', webSearchEnabled: false, timeoutUnlimited: true };
  const bot = new Bot({ config }); t.after(() => bot.close());
  const piece = event({ id: 'chatcmpl-synthetic', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model',
    choices: [{ index: 0, delta: { reasoning_content: '模拟分析。' }, finish_reason: null }] });
  const text = (': heartbeat\n\n' + piece).repeat(12000)
    + event({ choices: [{ delta: { content: '完整最终答案' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 12010, total_tokens: 12110 } }) + 'data: [DONE]\n\n';
  assert.ok(Buffer.byteLength(text) > 2 * 1024 * 1024);
  t.mock.method(globalThis, 'fetch', async () => response(text, 8192));
  const trace = {}, result = await bot.completion('长响应回归', config, trace);
  assert.equal(result.text, '完整最终答案'); assert.equal(trace.tokens, 12110);
  const live = bot.liveTasks.status().selected;
  assert.equal(live.stage, 'generated'); assert.equal(live.reasoning.length, 30000); assert.equal(live.reasoningTruncated, true);
  assert.equal(live.answer, '完整最终答案'); assert.equal(live.tokens, 12110);
});

test('兼容超过 2 MiB 的完整 JSON 思考响应，保留最终答案和用量', async () => {
  const tasks = new LiveTasks(), id = tasks.begin({ question: '长 JSON' });
  const text = JSON.stringify({ choices: [{ message: { content: 'JSON 最终回答', reasoning_content: '模拟'.repeat(400000) }, finish_reason: 'stop' }], usage: { total_tokens: 800010 } });
  assert.ok(Buffer.byteLength(text) > 2 * 1024 * 1024);
  const data = await readChatResponse(new Response(text), { onDelta: delta => tasks.delta(id, delta) });
  assert.equal(data.choices[0].message.content, 'JSON 最终回答'); assert.equal(data.usage.total_tokens, 800010);
  assert.equal(tasks.status(id).selected.reasoning.length, 30000); assert.equal(tasks.status(id).selected.reasoningTruncated, true);
});

test('长正文和工具参数按实际内容合并，心跳和已消费思考不累计占用预算', async () => {
  const part = '文'.repeat(20000), toolPart = 'x'.repeat(40000);
  const text = ': heartbeat\n\n'.repeat(180000)
    + event({ choices: [{ delta: { reasoning_content: part } }] }).repeat(40)
    + event({ choices: [{ delta: { content: part } }] }).repeat(40)
    + event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'doc', function: { name: 'create_document', arguments: '{"content":"' } }] } }] })
    + event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: toolPart } }] } }] }).repeat(60)
    + event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
  const data = await readChatResponse(response(text, 65536));
  const message = data.choices[0].message;
  assert.equal(message.content, part.repeat(40)); assert.equal(message.reasoning_content, undefined);
  assert.equal(JSON.parse(message.tool_calls[0].function.arguments).content, toolPart.repeat(60));
});

test('超大单事件、未结束行、累计工具和正文、完整 JSON 仍会中止并关闭连接', async () => {
  const block = 'x'.repeat(512 * 1024);
  const content = event({ choices: [{ delta: { content: block } }] });
  const tool = event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: block } }] } }] });
  const cases = [
    ['data: ' + block.repeat(5), true, /单个流式事件超过 2 MiB/],
    ['data: ' + JSON.stringify({ unused: block.repeat(5) }) + '\n\n', true, /单个流式事件超过 2 MiB/],
    [('data: ' + JSON.stringify(block) + '\n').repeat(5), true, /单个流式事件超过 2 MiB/],
    [': ' + block.repeat(5), true, /单个流式事件超过 2 MiB/],
    [content.repeat(8) + tool.repeat(9), true, /回答或工具参数超过 8 MiB/],
    [JSON.stringify({ choices: [{ message: { reasoning_content: block.repeat(33), content: '不应发送' } }] }), false, /非流式响应超过 16 MiB/]
  ];
  for (const [text, streaming, pattern] of cases) {
    const bytes = new TextEncoder().encode(text); let at = 0, cancelled = false;
    const upstream = new Response(new ReadableStream({
      pull(controller) { if (at < bytes.length) controller.enqueue(bytes.subarray(at, at += 65536)); },
      cancel() { cancelled = true; }
    }), { headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' } });
    await assert.rejects(readChatResponse(upstream), pattern); assert.equal(cancelled, true); assert.equal(upstream.body.locked, false);
  }
});
test('SSE 正确合并 UTF-8 分片、思考、正文、工具参数与最终用量，不把思考混入答案', async () => {
  const deltas = [], text = ': heartbeat\r\n\r\n' + event({ choices: [{ index: 0, delta: { reasoning_content: '分析汉字🫧' } }] })
    + event({ choices: [{ index: 0, delta: { content: '回答' } }] })
    + event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'create_document', arguments: '{"title":' } }] } }] })
    + event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"测试"}' } }] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 42 } }) + 'data: [DONE]\r\n\r\n';
  const result = await readChatResponse(response(text, 1), { onDelta: delta => deltas.push(delta) });
  assert.equal(result.choices[0].message.content, '回答'); assert.equal(result.choices[0].message.reasoning_content, undefined);
  assert.equal(deltas.map(d => d.reasoning).join(''), '分析汉字🫧'); assert.equal(result.usage.total_tokens, 42);
  assert.deepEqual(result.choices[0].message.tool_calls, [{ id: 'call-1', type: 'function', function: { name: 'create_document', arguments: '{"title":"测试"}' } }]);
});

test('DONE 后不用等待连接关闭，兼容非流式 JSON，损坏或中断的流不冒充完整回复', async () => {
  let cancelled = false;
  const open = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(event({ choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\ndata: {ignored invalid trailing data}\n\n')); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  assert.equal((await readChatResponse(open)).choices[0].message.content, '完成'); assert.equal(cancelled, true);
  const deltas = []; await readChatResponse(new Response(JSON.stringify({ choices: [{ message: { content: '正文', reasoning_content: '接口明确返回的思考' } }] })), { onDelta: d => deltas.push(d) });
  assert.equal(deltas[0].reasoning, '接口明确返回的思考');
  await assert.rejects(readChatResponse(response(event({ choices: [{ delta: { content: '只有半句' } }] }))), /中断/);
  await assert.rejects(readChatResponse(response('data: {broken}\n\n')), /格式错误/);
  await assert.rejects(readChatResponse(response(event({ error: { message: 'PRIVATE_UPSTREAM_TOKEN' } }))), error => !error.message.includes('PRIVATE') && /失败/.test(error.message));
});

test('无超时不创建请求期限，关闭服务仍可取消，普通模式期限仍生效', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bot = new Bot({ config: defaultConfig() }); t.after(() => bot.close()); let signal, finish;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { signal = options.signal; return new Promise((resolve, reject) => {
    finish = () => resolve(new Response('{}')); signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }); });
  let pending = bot.request('https://example.com', {}, '', null); t.mock.timers.tick(86400000);
  assert.equal(signal.aborted, false); finish(); await pending;
  pending = bot.request('https://example.com', {}, '', 5); t.mock.timers.tick(5000); await assert.rejects(pending, /超时/);
  pending = bot.request('https://example.com', {}, '', null); bot.close(); await assert.rejects(pending, /服务正在停止/);
  assert.equal(bot.controllers.size, 0);
});

test('模型请求按超时开关传值，辅助请求保留自己的短超时', async t => {
  const config = { ...defaultConfig(), deepseekKey: 'SYNTHETIC_TEST_KEY', webSearchEnabled: false, timeoutUnlimited: true };
  const bot = new Bot({ config }); t.after(() => bot.close()); const requests = [];
  bot.request = async (_url, body, _auth, timeout) => { requests.push({ body, timeout }); return { choices: [{ message: { content: '回答' } }] }; };
  await bot.completion('测试', config); assert.equal(requests[0].timeout, null); assert.equal(requests[0].body.stream, true);
  config.timeoutUnlimited = false; await bot.completion('测试', config); assert.equal(requests[1].timeout, 180);
  assert.equal(validatePatch(config, { timeoutUnlimited: true }).timeoutUnlimited, true); assert.throws(() => validatePatch(config, { timeoutUnlimited: 'true' }));
});

test('无超时且上游一直未返回数据时，撤销授权仍会中断请求', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); let allowed = true;
  const bot = new Bot({ config: defaultConfig() }); t.after(() => bot.close());
  t.mock.method(globalThis, 'fetch', async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })));
  const pending = bot.request('https://example.com', {}, '', null, 'POST', { ensure() { if (!allowed) throw Object.assign(Error('授权已撤销'), { cancelled: true }); } });
  allowed = false; t.mock.timers.tick(1000); await assert.rejects(pending, error => error.cancelled && error.message === '授权已撤销');
  assert.equal(bot.controllers.size, 0);
});

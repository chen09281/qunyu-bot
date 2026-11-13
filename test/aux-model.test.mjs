import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Bot } from '../src/bot.mjs';
import { defaultConfig } from '../src/config.mjs';

const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const messages = [{ role: 'user', content: '写一句小剧场对白' }];
const chatUsage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20,
  prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } };
const chatResult = { choices: [{ message: { role: 'assistant', content: '  欢迎来到小剧场！  ' }, finish_reason: 'stop' }], usage: chatUsage };
const responsesResult = { status: 'completed', output: [{ type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: '  欢迎来到小剧场！  ' }] }],
  usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20,
    input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } } };

async function setup(t, protocol, respond, timeoutSeconds = 2) {
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: JSON.parse(raw) });
    respond(res);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const config = { ...defaultConfig(), deepseekKey: 'TEST_ONLY', deepseekUrl: baseUrl, timeoutSeconds };
  if (protocol === 'responses') {
    config.modelProfiles = [{ id: 'aux', name: 'Test', provider: 'openai', protocol, baseUrl,
      apiKey: 'TEST_ONLY', model: 'synthetic-model', effort: 'auto', maxTokens: 4096, unlimited: false }];
    config.modelRoutes = { chat: 'aux' };
  }
  const bot = new Bot({ config }), records = [];
  bot.tokenUsage = { record: usage => records.push(usage) };
  t.after(async () => {
    bot.close(); upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  return { bot, records, requests };
}

for (const protocol of ['chat', 'responses']) {
  for (const streaming of [true, false]) {
    test(`辅助模型 ${protocol} ${streaming ? 'SSE' : 'JSON'} 返回正文并记录完整用量，无需实时预览`, async t => {
      const { bot, records, requests } = await setup(t, protocol, res => {
        res.writeHead(200, { 'Content-Type': streaming ? 'text/event-stream' : 'application/json' });
        if (!streaming) return res.end(JSON.stringify(protocol === 'responses' ? responsesResult : chatResult));
        const text = protocol === 'responses'
          ? sse({ type: 'response.output_text.delta', delta: '  欢迎来到小剧场！  ' })
            + sse({ type: 'response.completed', response: responsesResult })
          : sse({ choices: [{ index: 0, delta: { reasoning_content: '内部思考' } }] })
            + sse({ choices: [{ index: 0, delta: { content: '  欢迎来到' } }] })
            + sse({ choices: [{ index: 0, delta: { content: '小剧场！  ' }, finish_reason: 'stop' }] })
            + sse({ choices: [], usage: chatUsage }) + 'data: [DONE]\n\n';
        res.end(text);
      });
      const event = { message_type: 'group', group_id: '10001', user_id: '10002', sender: { nickname: '测试用户' } };
      assert.equal(await bot.askAuxModel({ event, messages, purpose: 'tavern_theater' }), '欢迎来到小剧场！');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].path, protocol === 'responses' ? '/responses' : '/chat/completions');
      assert.equal(requests[0].body.stream, true);
      assert.deepEqual(requests[0].body[protocol === 'responses' ? 'input' : 'messages'], messages);
      assert.equal(records.length, 1);
      const usage = records[0];
      assert.equal(usage.purpose, 'tavern_theater');
      assert.deepEqual(usage.scope, { kind: 'group', groupId: '10001', userId: '10002', userName: '测试用户' });
      assert.deepEqual([usage.promptTokens, usage.cachedTokens, usage.completionTokens, usage.reasoningTokens, usage.totalTokens], [12, 4, 8, 3, 20]);
      assert.equal(bot.stats.tokens, 20);
      assert.equal(bot.controllers.size, 0);
      assert.equal(bot.liveTasks.status().selected, null);
    });
  }
}

test('辅助模型拒绝中断或损坏的流，不把半句当作成功回答', async t => {
  for (const protocol of ['chat', 'responses']) {
    const { bot, records } = await setup(t, protocol, res => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(protocol === 'responses' ? sse({ type: 'response.output_text.delta', delta: '半句' })
        : sse({ choices: [{ delta: { content: '半句' } }] }));
    });
    await assert.rejects(bot.askAuxModel({ messages }), /中断/);
    assert.equal(records.length, 0);
    assert.equal(bot.controllers.size, 0);
  }
  const { bot } = await setup(t, 'chat', res => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {broken}\n\n');
  });
  await assert.rejects(bot.askAuxModel({ messages }), /格式错误/);
});

test('辅助流式请求保持超时限制，服务关闭会取消读取', async t => {
  const { bot } = await setup(t, 'chat', res => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': waiting\n\n');
  }, 0.05);
  await assert.rejects(bot.askAuxModel({ messages }), /超时/);
  assert.equal(bot.controllers.size, 0);

  let received;
  const ready = new Promise(resolve => { received = resolve; });
  const { bot: closing } = await setup(t, 'responses', res => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': waiting\n\n'); received();
  });
  const request = closing.askAuxModel({ messages });
  const rejected = assert.rejects(request, /服务正在停止/);
  await ready; closing.close(); await rejected;
  assert.equal(closing.controllers.size, 0);
});

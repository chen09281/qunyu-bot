import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/server.mjs';
import { LiveTasks } from '../src/live-tasks.mjs';

const until = async condition => { for (let i = 0; i < 500; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('测试任务未完成'); };
const packet = (delta, extra = {}) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, ...extra }] }) + '\n\n';
test('管理员实时查看问题，长思考超过 2 MiB 后仍发送答案，状态与日志不含思考', async t => {
  let stream, input;
  const upstream = createServer(async (req, res) => { let text = ''; for await (const chunk of req) text += chunk;
    input = JSON.parse(text); stream = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r)); t.after(() => { upstream.closeAllConnections(); return new Promise(r => upstream.close(r)); });
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-live-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await createApplication({ dataDir: dir, initialPassword: 'live-test-password', scheduledChatAutoStart: false, subscriptionAutoStart: false, checkinAutoStart: false, bilibiliAutoStart: false, douyinAutoStart: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(() => { app.server.closeAllConnections(); return new Promise(r => app.server.close(r)); });
  const base = `http://127.0.0.1:${app.server.address().port}/api/`, headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  assert.equal((await fetch(base + 'live-tasks')).status, 401);
  const login = await fetch(base + 'login', { method: 'POST', headers, body: JSON.stringify({ username: 'admin', password: 'live-test-password' }) });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  app.store.save({ enabled: true, deepseekKey: 'SYNTHETIC_LIVE_KEY', deepseekUrl: `http://127.0.0.1:${upstream.address().port}`, allowedGroups: ['10003'], botId: '10001', webSearchEnabled: false, timeoutUnlimited: true });
  const sent = []; app.bot.onebot = async (_action, params) => { sent.push(params); return { message_id: 20 }; };
  app.bot.receive({ post_type: 'message', message_type: 'group', self_id: 10001, group_id: 10003, user_id: 10002, message_id: 1, sender: { nickname: '测试用户' }, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: '当前问题<script>测试' } }] });
  await until(() => stream); assert.equal(input.stream, true);
  stream.write(packet({ reasoning_content: '外部 DS 实际返回的思考 <script>' }));
  await until(() => app.bot.liveTasks.status().selected?.reasoning);
  let live = await (await fetch(base + 'live-tasks', { headers })).json();
  assert.match(live.selected.question, /当前问题<script>/); assert.match(live.selected.reasoning, /外部 DS 实际返回/);
  assert.equal(live.selected.stage, 'thinking'); assert.equal(live.selected.endedAt, null); assert.equal(live.selected.streaming, true);
  assert.equal(Object.hasOwn(live.tasks[0], 'reasoning'), false); assert.equal(JSON.stringify(live).includes('SYNTHETIC_LIVE_KEY'), false);
  assert.equal(JSON.stringify(app.bot.status()).includes('外部 DS 实际返回'), false); assert.equal(JSON.stringify(app.bot.status()).includes('当前问题'), false);
  const log = app.bot.logs[0]; assert.equal(JSON.stringify(app.bot.logDetail(log.id)).includes('外部 DS 实际返回'), false);
  const longReasoning = packet({ reasoning_content: '外部 DS 实际返回的思考 '.repeat(2000) }).repeat(60);
  assert.ok(Buffer.byteLength(longReasoning) > 2 * 1024 * 1024); stream.write(longReasoning);
  stream.write(packet({ content: '最终回答' }, { finish_reason: 'stop' })); stream.end('data: [DONE]\n\n');
  await until(() => app.bot.active === 0);
  live = await (await fetch(base + 'live-tasks?id=' + live.selected.id, { headers })).json();
  assert.equal(live.selected.stage, 'sent'); assert.equal(live.selected.answer, '最终回答'); assert.equal(sent.length, 1);
  assert.equal(live.selected.reasoning.length, 30000); assert.equal(live.selected.reasoningTruncated, true);
  assert.equal(JSON.stringify(sent).includes('外部 DS 实际返回'), false);
  const detail = app.bot.logDetail(log.id); assert.equal(JSON.stringify(app.bot.conversations.context(detail.conversationId)).includes('外部 DS 实际返回'), false);
});

test('实时任务文本和记录数量有界，任务彼此独立，不接收密钥或系统配置字段', () => {
  const live = new LiveTasks(); const a = live.begin({ question: '问题 A', deepseekKey: 'PRIVATE_KEY' }), b = live.begin({ question: '问题 B' });
  live.delta(a, { reasoning: '思'.repeat(31000), content: '答'.repeat(21000) }); live.delta(b, { reasoning: '独立思考' });
  assert.equal(live.status(a).selected.reasoning.length, 30000); assert.equal(live.status(a).selected.answer.length, 20000);
  assert.equal(live.status(b).selected.reasoning, '独立思考'); assert.equal(JSON.stringify(live.status(a)).includes('PRIVATE_KEY'), false);
  for (let i = 0; i < 80; i++) { const id = live.begin({ question: '新任务' }); live.finish(id, 'sent'); }
  assert.ok(live.status().tasks.length <= 30); live.close(); assert.equal(live.status().tasks.length, 0);
});

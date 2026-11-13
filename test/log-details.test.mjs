import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from '../src/bot.mjs';
import { createApplication } from '../src/server.mjs';
import { defaultConfig } from '../src/config.mjs';

const event = (message = [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 请解释 <script> 与换行\n内容 ' } }]) => ({
  post_type: 'message', message_type: 'group', self_id: 10001, user_id: 10002, group_id: 10003, message_id: 7,
  sender: { card: '测试群名片', nickname: '测试昵称' }, message
});
const store = () => ({ config: { ...defaultConfig(), allowedGroups: ['10003'], enabled: true, deepseekKey: 'mock-key', webSearchEnabled: false } });

test('日志详情记录原消息和真正发送的清理后回复，列表不携带正文或思考内容', async () => {
  const s = store(), bot = new Bot(s);
  const sent = [];
  bot.request = async () => ({ choices: [{ message: { content: '回答正文。\n\n来源：\nhttps://example.com', reasoning_content: 'PRIVATE_REASONING' } }], usage: { total_tokens: 12 } });
  bot.onebot = async (action, params) => sent.push(params);
  await bot.run({ event: event(), prompt: '请解释 <script> 与换行\n内容', config: s.config });
  const log = bot.logs[0], detail = bot.logDetail(log.id);
  assert.equal(detail.receivedMessage, '@机器人 请解释 <script> 与换行\n内容 ');
  assert.equal(detail.replyMessage, '回答正文。');
  assert.equal(sent[0].message[1].data.text, ' ' + detail.replyMessage);
  assert.equal(detail.replyMention, '10002'); assert.equal(detail.replyStatus, 'sent');
  assert.equal(detail.userName, '测试群名片'); assert.equal(detail.model, s.config.model);
  assert.equal(detail.tokens, 12);
  const summary = JSON.stringify(bot.status());
  assert.equal(summary.includes('回答正文'), false); assert.equal(summary.includes('请解释'), false);
  assert.equal(JSON.stringify(detail).includes('PRIVATE_REASONING'), false);
  assert.equal(JSON.stringify(detail).includes('mock-key'), false);
  bot.close();
});

test('详情区分生成中、发送失败、模型失败和取消发送，保留生成的实际截断内容', async () => {
  const s = store(), bot = new Bot(s), job = { event: event(), prompt: '测试', config: { ...s.config, maxReplyLength: 3 } };
  let release;
  bot.completion = () => new Promise(resolve => { release = resolve; });
  bot.onebot = async () => { throw new Error('发送失败'); };
  const pending = bot.run(job);
  assert.equal(bot.logDetail(bot.logs[0].id).replyStatus, 'generating');
  release({ text: '完整生成的回答' }); await pending;
  let detail = bot.logDetail(bot.logs[0].id);
  assert.equal(detail.replyStatus, 'send_failed'); assert.equal(detail.replyMessage, '完整生\n…（回复已截断）');
  bot.completion = async () => { throw new Error('模型超时'); };
  await bot.run(job);
  detail = bot.logDetail(bot.logs[0].id);
  assert.equal(detail.replyStatus, 'failed'); assert.equal(detail.replyMessage, '');
  bot.completion = async () => { s.config.enabled = false; return { text: '已生成的回答' }; };
  let sent = false; bot.onebot = async () => { sent = true; };
  await bot.run(job);
  detail = bot.logDetail(bot.logs[0].id);
  assert.equal(detail.replyStatus, 'cancelled'); assert.equal(detail.replyMessage, '已生成\n…（回复已截断）');
  assert.equal(sent, false);
  bot.close();
});

test('忽略消息仍可查看详情，超长正文有边界，日志淘汰同步清除详情且新实例不恢复', () => {
  const s = store(), bot = new Bot(s); s.config.enabled = false;
  bot.receive(event('[CQ:at,qq=10001]你好 &#91;CQ:at,qq=all&#93;[CQ:image,file=ignored]'));
  let detail = bot.logDetail(bot.logs[0].id);
  assert.equal(detail.receivedMessage, '@机器人你好 [CQ:at,qq=all][图片]');
  assert.equal(detail.replyStatus, 'not_sent'); assert.equal(detail.deepseekCalled, false);
  bot.receive(event([{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: '长'.repeat(30000) } }]));
  detail = bot.logDetail(bot.logs[0].id);
  assert.equal(detail.receivedMessage.length, 20000); assert.equal(detail.receivedTruncated, true);
  const old = bot.logs[0].id;
  for (let i = 0; i < 200; i++) bot.log('info', '系统事件');
  assert.equal(bot.logs.length, 200); assert.equal(bot.logDetails.size, 0); assert.equal(bot.logDetail(old), null);
  assert.equal(bot.logDetail(bot.logs[0].id).receivedMessage, null);
  assert.equal(new Bot(s).logDetail(old), null);
  bot.close();
});

test('详情 API 要求管理员登录，返回单条正文和最新状态，过期记录返回 404', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'qqbot-log-api-'));
  const app = await createApplication({ dataDir, initialPassword: 'test1234' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.bot.close(); await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true }); });
  app.bot.receive(event());
  const id = app.bot.logs[0].id, route = `${url}/api/logs/${id}`;
  assert.equal((await fetch(route)).status, 401);
  const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }, body: JSON.stringify({ username: 'admin', password: 'test1234' }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const response = await fetch(route, { headers }), detail = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(detail.receivedMessage, /请解释 <script>/); assert.equal(detail.replyStatus, 'not_sent');
  const status = await (await fetch(`${url}/api/status`, { headers })).json();
  assert.equal(JSON.stringify(status).includes('请解释'), false);
  for (let i = 0; i < 200; i++) app.bot.log('info', '系统事件');
  assert.equal((await fetch(route, { headers })).status, 404);
  assert.equal((await fetch(`${url}/api/logs/not-an-id`, { headers })).status, 404);
});

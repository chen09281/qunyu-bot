import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversations, contextCharacterLimit } from '../src/conversations.mjs';
import { Bot } from '../src/bot.mjs';
import { createApplication } from '../src/server.mjs';
import { defaultConfig } from '../src/config.mjs';

const event = (user = 10002, group = 10003, bot = 10001, question = '你好', messageId = 1) => ({
  post_type: 'message', message_type: 'group', self_id: bot, user_id: user, group_id: group, message_id: messageId,
  sender: { card: `用户${user}` }, message: [{ type: 'at', data: { qq: String(bot) } }, { type: 'text', data: { text: question } }]
});
const store = () => ({ config: { ...defaultConfig(), allowedGroups: ['10003'], enabled: true, deepseekKey: 'fake', webSearchEnabled: false, cooldownSeconds: 0 } });
const wait = async check => {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('任务未按预期完成');
};
const folder = t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
};

test('聊天持久化并按机器人、群和用户隔离，只有完整成功问答进入上下文', t => {
  const path = join(folder(t), 'conversations.sqlite');
  let chats = new Conversations(path);
  const a = chats.begin(event(), '我的名字是小明', 'model', 'a');
  chats.finish(a.turnId, { status: 'sent', reply: '记住了，小明。', tokens: 12 });
  const failed = chats.begin(event(), '没有成功的问题', 'model', 'b');
  chats.finish(failed.turnId, { status: 'send_failed', reply: '未确认发送的回复' });
  const b = chats.begin(event(10004), '另一个人', 'model', 'c');
  const c = chats.begin(event(10002, 10005), '另一个群', 'model', 'd');
  const d = chats.begin(event(10002, 10003, 10006), '另一个机器人', 'model', 'e');
  assert.equal(new Set([a, b, c, d].map(x => x.conversationId)).size, 4);
  assert.deepEqual(chats.context(a.conversationId), [{ role: 'user', content: '我的名字是小明' }, { role: 'assistant', content: '记住了，小明。' }]);
  assert.deepEqual(chats.context(b.conversationId), []);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  chats.close(); chats = new Conversations(path);
  assert.equal(chats.context(a.conversationId)[0].content, '我的名字是小明');
  assert.equal(chats.detail(b.conversationId).turns[0].status, 'interrupted');
  assert.equal(chats.list({ search: '10005' }).items[0].groupId, '10005');
  assert.equal(chats.list({ search: "' OR 1=1 --" }).total, 0);
  chats.close();
});

test('历史限制保留完整轮次；新话题保留聊天记录且排除重置前仍在生成的内容', () => {
  const chats = new Conversations();
  let id;
  for (let i = 0; i < 12; i++) {
    const turn = chats.begin(event(), `问题${i}`, 'model', String(i)); id = turn.conversationId;
    chats.finish(turn.turnId, { status: 'sent', reply: `回答${i}` });
  }
  assert.equal(chats.context(id, 3).length, 6); assert.equal(chats.context(id, 3)[0].content, '问题9');
  const oldInFlight = chats.begin(event(), '重置前的问题', 'model', 'old');
  assert.equal(chats.reset(id), true); assert.deepEqual(chats.context(id), []);
  chats.finish(oldInFlight.turnId, { status: 'sent', reply: '重置前的回答' });
  assert.deepEqual(chats.context(id), []); assert.equal(chats.detail(id).turns.length, 13);
  const fresh = chats.begin(event(), '新问题', 'model', 'new');
  chats.finish(fresh.turnId, { status: 'sent', reply: '新回答' });
  assert.equal(chats.context(id).length, 2);
  const huge = chats.begin(event(), '大'.repeat(contextCharacterLimit), 'model', 'huge');
  chats.finish(huge.turnId, { status: 'sent', reply: '回复' });
  assert.equal(chats.context(id).flatMap(x => x.content).join('').length <= contextCharacterLimit, true);
  chats.close();
});

test('同一提问者的第二问等第一轮发送成功后再生成，其他用户可并行且不串上下文', async () => {
  const s = store(), bot = new Bot(s), calls = []; let releaseFirst;
  bot.completion = async (prompt, config, trace, history) => {
    calls.push({ prompt, history });
    if (prompt === '第一问') await new Promise(resolve => { releaseFirst = resolve; });
    return { text: `${prompt}的回答` };
  };
  bot.onebot = async () => {};
  bot.receive(event(10002, 10003, 10001, '第一问', 1));
  bot.receive(event(10002, 10003, 10001, '第二问', 2));
  bot.receive(event(10004, 10003, 10001, '另一人的问题', 3));
  await wait(() => bot.stats.replied === 1);
  assert.deepEqual(calls.map(x => x.prompt), ['第一问', '另一人的问题']);
  releaseFirst(); await wait(() => bot.active === 0);
  assert.equal(bot.stats.replied, 3);
  assert.deepEqual(calls[2].history, [{ role: 'user', content: '第一问' }, { role: 'assistant', content: '第一问的回答' }]);
  assert.deepEqual(calls[1].history, []);
  bot.close();
});

test('实际模型请求携带成功历史，跨重启保留记忆，关闭携带和模型测试不混入历史', async t => {
  const path = join(folder(t), 'conversations.sqlite'), s = store(), requests = [];
  const make = () => {
    const bot = new Bot(s, new Conversations(path));
    bot.request = async (url, body) => {
      requests.push(body);
      return { choices: [{ message: { content: '收到。[1]\n\n来源：\nhttps://example.com', reasoning_content: 'PRIVATE_REASONING' } }], usage: { total_tokens: 9 } };
    };
    bot.onebot = async () => {}; return bot;
  };
  let bot = make();
  await bot.run({ event: event(), prompt: '我叫小明', config: s.config }); bot.close();
  bot = make();
  await bot.run({ event: event(), prompt: '我叫什么？', config: s.config });
  const messages = requests[1].messages;
  assert.equal(messages[1].content, '我叫小明'); assert.equal(messages[2].content, '收到。');
  assert.equal(messages.at(-1).content, '我叫什么？');
  assert.equal(JSON.stringify(messages).includes('PRIVATE_REASONING'), false);
  await bot.run({ event: event(), prompt: '不带记忆', config: { ...s.config, memoryEnabled: false } });
  assert.equal(requests.at(-1).messages.length, 2);
  await bot.completion('模型测试', s.config);
  assert.equal(requests.at(-1).messages.length, 2);
  assert.equal(bot.conversations.detail(bot.conversations.list().items[0].id).turns.length, 3);
  bot.close();
});

test('会话与分页 API 受管理员鉴权保护，重置只影响上下文，普通消息不创建记录', async t => {
  const app = await createApplication({ dataDir: folder(t), initialPassword: 'test1234' });
  app.store.save({ allowedGroups: ['10003'], enabled: true, deepseekKey: 'fake', webSearchEnabled: false });
  app.bot.completion = async () => ({ text: '模拟回答' }); app.bot.onebot = async () => {};
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.bot.close(); await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  app.bot.receive({ ...event(), message: '普通群消息' });
  assert.equal(app.bot.conversations.list().total, 0);
  await app.bot.run({ event: event(), prompt: '隐私问题', config: app.store.config });
  const id = app.bot.conversations.list().items[0].id;
  assert.equal((await fetch(url + '/api/conversations')).status, 401);
  assert.equal((await fetch(url + '/api/conversations/' + id)).status, 401);
  const base = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  const login = await fetch(url + '/api/login', { method: 'POST', headers: base, body: JSON.stringify({ username: 'admin', password: 'test1234' }) });
  const headers = { ...base, Cookie: login.headers.get('set-cookie').split(';')[0] };
  let data = await (await fetch(url + '/api/conversations', { headers })).json();
  assert.equal(data.items.length, 1); assert.equal(data.items[0].userId, '10002');
  assert.equal(JSON.stringify(await (await fetch(url + '/api/status', { headers })).json()).includes('隐私问题'), false);
  for (let i = 0; i < 61; i++) {
    const turn = app.bot.conversations.begin(event(), `问题${i}`, 'model', String(i));
    app.bot.conversations.finish(turn.turnId, { status: 'sent', reply: `回答${i}` });
  }
  data = await (await fetch(url + '/api/conversations/' + id, { headers })).json();
  assert.equal(data.turns.length, 50); assert.equal(data.hasMore, true);
  const older = await (await fetch(url + '/api/conversations/' + id + '?before=' + data.turns[0].id, { headers })).json();
  assert.equal(older.turns.length, 12); assert.equal(older.hasMore, false);
  assert.equal((await fetch(url + '/api/conversations/' + id + '?before=-1', { headers })).status, 400);
  assert.equal((await fetch(url + '/api/conversations?offset=bad', { headers })).status, 400);
  assert.equal((await fetch(url + '/api/conversations/' + id + '/reset', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(url + '/api/conversations/' + id + '/reset', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.deepEqual(app.bot.conversations.context(id), []);
  assert.equal(app.bot.conversations.detail(id).turns.length, 50);
  assert.equal((await fetch(url + '/api/conversations/00000000-0000-4000-8000-000000000000', { headers })).status, 404);
});

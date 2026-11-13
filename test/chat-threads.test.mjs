import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Conversations } from '../src/conversations.mjs';
import { createApplication } from '../src/server.mjs';
import { chatTime, chatTimeline } from '../frontend/src/utils/chatTimeline.js';

const event = (user = '10002', group = '10003', bot = '10001') => ({ self_id: bot, group_id: group, user_id: user,
  message_type: group === 'private' ? 'private' : 'group', sender: { nickname: `成员${user}` } });
const add = (chats, user, group, bot) => {
  const turn = chats.begin(event(user, group, bot), `问题 ${user}`, 'test-model', 'test-log');
  chats.finish(turn.turnId, { status: 'sent', reply: `回答 ${user}` }); return turn;
};

test('已有记录按群汇总，搜索成员仍返回整群，私聊、其他群及机器人隔离，重启后标识稳定', t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-threads-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let chats = new Conversations(join(dir, 'chats.sqlite'));
  const a = add(chats, '10002', '10003'), b = add(chats, '10004', '10003');
  const privateA = add(chats, '10002', 'private'); add(chats, '10004', 'private');
  add(chats, '10002', '10005'); add(chats, '10002', '10003', '10006');
  assert.equal(chats.list().total, 6); assert.equal(chats.threads().total, 5);
  const group = chats.threads().items.find(item => item.groupId === '10003' && item.botId === '10001');
  assert.equal(group.id, a.conversationId); assert.equal(group.memberCount, 2); assert.equal(group.userId, '');
  assert.equal(group.lastUserId, '10004');
  const filtered = chats.threads({ search: '成员10004' }); assert.equal(filtered.total, 2);
  assert.equal(filtered.items.find(item => item.groupId === '10003').memberCount, 2);
  assert.equal(chats.threads({ search: "' OR 1=1 --" }).total, 0);
  assert.deepEqual(chats.thread(b.conversationId).turns.map(turn => turn.userId), ['10002', '10004']);
  assert.equal(chats.thread(b.conversationId).session.id, a.conversationId);
  assert.equal(chats.thread(privateA.conversationId).turns.length, 1);
  assert.equal(chats.thread(privateA.conversationId).session.userId, '10002');
  chats.reset(b.conversationId);
  assert.deepEqual(chats.context(b.conversationId), []); assert.equal(chats.context(a.conversationId).length, 2);
  assert.equal(chats.context(privateA.conversationId).length, 2);
  assert.equal(chats.thread(a.conversationId).members.find(m => m.id === b.conversationId).epoch, 1);
  chats.close(); chats = new Conversations(join(dir, 'chats.sqlite')); t.after(() => chats.close());
  add(chats, '10007', '10003');
  assert.equal(chats.thread(b.conversationId).session.id, a.conversationId);
  assert.equal(chats.thread(a.conversationId).turns.length, 3);
});

test('按群统计与分页不受成员数量影响，混合成员历史翻页无丢失或重复，时间持久化', t => {
  const chats = new Conversations(); t.after(() => chats.close()); let clock = 1700000000000;
  t.mock.method(Date, 'now', () => clock);
  const ids = [];
  for (let i = 0; i < 63; i++) {
    const turn = chats.begin(event(String(20000 + i % 4)), `问题${i}`, 'model', 'log');
    clock += 1000; chats.finish(turn.turnId, { status: 'sent', reply: `回答${i}` }); clock += 1000; ids.push(turn.turnId);
  }
  add(chats, '30000', 'private');
  const page1 = chats.threads({ limit: 1 }), page2 = chats.threads({ offset: 1, limit: 1 });
  assert.equal(page1.total, 2); assert.equal(page1.hasMore, true); assert.equal(page2.hasMore, false);
  const group = [...page1.items, ...page2.items].find(item => item.groupId === '10003');
  const recent = chats.thread(group.id), older = chats.thread(group.id, recent.turns[0].id);
  assert.equal(recent.hasMore, true); assert.equal(recent.turns.length, 50); assert.equal(older.hasMore, false);
  const turns = [...older.turns, ...recent.turns]; assert.deepEqual(turns.map(turn => turn.id), ids);
  assert.equal(new Set(turns.map(turn => turn.userId)).size, 4);
  assert.ok(turns.every(turn => turn.updatedAt - turn.createdAt === 1000));
});

test('消息按发生时间交错展示，每条回复对应正确成员，显示北京时间及秒', () => {
  const base = Date.parse('2026-10-26T06:30:00Z');
  const turns = [{ id: 1, createdAt: base, updatedAt: base + 90000, userId: 'a' },
    { id: 2, createdAt: base + 10000, updatedAt: base + 20000, userId: 'b' }];
  const timeline = chatTimeline(turns);
  assert.deepEqual(timeline.map(message => message.key), ['1-user', '2-user', '2-bot', '1-bot']);
  assert.equal(timeline.at(-1).turn.userId, 'a'); assert.match(chatTime(base), /2026\/10\/26.*14:30:00/);
  assert.match(chatTime(Date.parse('2026-10-25T16:00:00Z')), /2026\/10\/26.*00:00:00/);
  assert.equal(chatTime(null), '时间未知');
  assert.deepEqual(chatTimeline([{ id: 1, createdAt: base, updatedAt: base }]).map(m => m.kind), ['user', 'bot']);
});

test('群聊汇总 API 需要登录、验证游标，重置只能明确操作成员会话', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-thread-api-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await createApplication({ dataDir: dir, initialPassword: 'test-thread-password', scheduledChatAutoStart: false, subscriptionAutoStart: false, checkinAutoStart: false, bilibiliAutoStart: false, douyinAutoStart: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => { app.bot.close(); app.server.closeAllConnections(); return new Promise(r => app.server.close(r)); });
  const base = `http://127.0.0.1:${app.server.address().port}/api/`;
  const a = add(app.bot.conversations, '10002', '10003'), b = add(app.bot.conversations, '10004', '10003');
  assert.equal((await fetch(base + 'chat-threads')).status, 401);
  assert.equal((await fetch(base + 'chat-threads/' + a.conversationId)).status, 401);
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  const login = await fetch(base + 'login', { method: 'POST', headers, body: JSON.stringify({ username: 'admin', password: 'test-thread-password' }) });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const list = await (await fetch(base + 'chat-threads?search=10004', { headers })).json();
  assert.equal(list.total, 1); assert.equal(list.items[0].memberCount, 2);
  const detail = await (await fetch(base + 'chat-threads/' + a.conversationId, { headers })).json();
  assert.equal(detail.turns.length, 2); assert.equal(detail.members.length, 2);
  for (const path of ['chat-threads?offset=bad', `chat-threads/${a.conversationId}?before=-1`]) assert.equal((await fetch(base + path, { headers })).status, 400);
  assert.equal((await fetch(base + 'chat-threads/00000000-0000-4000-8000-000000000000', { headers })).status, 404);
  assert.equal((await fetch(base + `chat-threads/${a.conversationId}/reset`, { method: 'POST', headers, body: '{}' })).status, 404);
  await fetch(base + `conversations/${b.conversationId}/reset`, { method: 'POST', headers, body: '{}' });
  assert.equal(app.bot.conversations.context(a.conversationId).length, 2); assert.deepEqual(app.bot.conversations.context(b.conversationId), []);
});

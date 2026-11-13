import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/server.mjs';
import { openStore } from '../src/config.mjs';

test('定时聊天逐群 API 仅修改现有白名单群，保留其他配置与窗口隔离，并持久化', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-chat-plugin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const password = 'scheduled-plugin-test-password';
  const app = await createApplication({ dataDir: dir, initialPassword: password, scheduledChatAutoStart: false,
    bilibiliAutoStart: false, douyinAutoStart: false, checkinAutoStart: false, subscriptionAutoStart: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => app.server.close(r)));
  const base = `http://127.0.0.1:${app.server.address().port}/api/`;
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  const update = (path, data, extra = {}) => fetch(base + path, { method: 'PUT', headers: { ...headers, ...extra }, body: JSON.stringify(data) });
  assert.equal((await update('scheduled-chat/groups/10003', { enabled: false })).status, 401);
  const login = await fetch(base + 'login', { method: 'POST', headers, body: JSON.stringify({ username: app.store.admin.username, password }) });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await update('config', { scheduledChatTimes: ['21:45', '09:30', '09:30'] })).status, 200);
  assert.deepEqual(app.store.config.scheduledChatTimes, ['09:30', '21:45']);
  for (const times of [[], null, '09:30', ['9:30'], ['24:00'], ['12:60'], [12], Array(25).fill('12:00')]) assert.equal((await update('config', { scheduledChatTimes: times })).status, 400);
  assert.deepEqual((await openStore(dir)).config.scheduledChatTimes, ['09:30', '21:45']);
  const initial = { enabled: true, deepseekKey: 'SYNTHETIC_TEST_KEY', systemPrompt: '保留人设', allowedGroups: [
    { id: '10003', ds: true, video: false }, { id: '10004', ds: true, video: true }, { id: '10005', ds: false, video: true },
  ] };
  assert.equal((await update('config', initial)).status, 200);
  const scheduled = group_id => app.bot.groupChat.replied({ message_type: 'group', self_id: 10001, group_id }, app.store.config, '问候', 90, 'scheduled');
  scheduled(10003); scheduled(10004); assert.equal(app.bot.groupChat.invitations.size, 2);
  assert.equal((await update('scheduled-chat/groups/10003', { enabled: false }, { Origin: 'https://evil.example' })).status, 403);
  for (const data of [{ enabled: 'false' }, {}, { enabled: null }, { enabled: false, ds: false }]) {
    assert.equal((await update('scheduled-chat/groups/10003', data)).status, 400);
  }
  const response = await update('scheduled-chat/groups/10003', { enabled: false }); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.deepseekKey, undefined);
  assert.deepEqual(result.allowedGroups, [
    { id: '10003', ds: true, video: false, scheduledChat: false },
    { id: '10004', ds: true, video: true, scheduledChat: true },
    { id: '10005', ds: false, video: true, scheduledChat: true },
  ]);
  assert.equal(app.store.config.deepseekKey, initial.deepseekKey); assert.equal(app.store.config.systemPrompt, initial.systemPrompt);
  assert.equal(app.bot.groupChat.invitations.has('10001:10003:'), false); assert.equal(app.bot.groupChat.invitations.has('10001:10004:'), true);
  // Legacy whitelist editors omit the new field without turning it back on.
  await update('config', { allowedGroups: [{ id: '10003', ds: true, video: true }, '10004', '10006'] });
  assert.equal(app.store.config.allowedGroups[0].scheduledChat, false); assert.equal(app.store.config.allowedGroups[2].scheduledChat, true);
  assert.equal((await update('scheduled-chat/groups/10005', { enabled: true })).status, 404);
  assert.equal(app.store.config.allowedGroups.some(g => g.id === '10005'), false);
  assert.equal((await openStore(dir)).config.allowedGroups[0].scheduledChat, false);
  await update('scheduled-chat/groups/10003', { enabled: true }); assert.equal(app.bot.groupChat.invitations.has('10001:10003:'), false);
  await update('config', { proactiveChatEnabled: false }); assert.equal(app.bot.groupChat.invitations.size, 0);
  await update('config', { proactiveChatEnabled: true }); assert.equal(app.bot.groupChat.invitations.size, 0);
  // A removed group re-added later is a new authorization item.
  await update('config', { allowedGroups: ['10004'] }); await update('config', { allowedGroups: ['10003', '10004'] });
  assert.equal(app.store.config.allowedGroups[0].scheduledChat, true);
});

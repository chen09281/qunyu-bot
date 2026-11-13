import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bot } from '../src/bot.mjs';
import { defaultConfig } from '../src/config.mjs';
import { ScheduledChat, scheduledChatSlot } from '../src/scheduled-chat.mjs';

const utc = value => Date.parse(value);
const idle = async bot => {
  for (let n = 0; n < 300; n++) { if (!bot.active && !bot.queue.length) return; await new Promise(r => setTimeout(r, 2)); }
  throw Error('定时聊天未完成');
};
function fixture(t, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-scheduled-')); let now = utc('2026-10-24T03:59:59Z'), id = 100;
  const store = { config: { ...defaultConfig(), enabled: true, deepseekKey: 'PRIVATE_TEST_KEY', botId: '10001', allowedGroups: ['10003', { id: '10004', ds: true }, { id: '10005', ds: false }], webSearchEnabled: true, cooldownSeconds: 0, ...patch } };
  const bot = new Bot(store, undefined, null, null, { now: () => now });
  const scheduler = new ScheduledChat(dir, store, bot, { now: () => now }); bot.scheduledChat = scheduler;
  const requests = [], sent = [];
  bot.request = async (url, body) => { requests.push({ url, body }); return { choices: [{ message: { content: '咕噜，午饭要好好吃呀。' } }], usage: { total_tokens: 7 } }; };
  bot.onebot = async (action, params) => {
    if (action === 'get_login_info') return { user_id: 10001 };
    sent.push({ action, params }); return { message_id: ++id };
  };
  t.after(() => { bot.close(); rmSync(dir, { force: true, recursive: true }); });
  return { dir, store, bot, scheduler, requests, sent, set: value => { now = utc(value); }, advance: ms => { now += ms; } };
}

test('默认北京时间三个时点，不依赖进程系统时区，不跨分钟补发', () => {
  assert.equal(scheduledChatSlot(utc('2026-10-24T03:59:59Z')), null);
  for (const [hour, time] of [[4, '12:00'], [7, '15:00'], [10, '18:00']]) {
    const stamp = `2026-10-24T${String(hour).padStart(2, '0')}:00:59Z`;
    assert.deepEqual(scheduledChatSlot(utc(stamp)), { day: '2026-10-24', time, key: `2026-10-24T${time}` });
  }
  assert.equal(scheduledChatSlot(utc('2026-10-24T04:01:00Z')), null);
  assert.equal(scheduledChatSlot(utc('2026-10-24T12:00:00Z')), null);
});

test('自定义多个时点按北京时间执行，跨天正确，重启去重与删除繁忙时点生效', async t => {
  assert.equal(scheduledChatSlot(utc('2026-10-25T16:00:00Z'), ['00:00']).key, '2026-10-26T00:00');
  assert.equal(scheduledChatSlot(utc('2026-10-26T15:59:00Z'), ['23:59']).time, '23:59');
  const f = fixture(t, { scheduledChatTimes: ['09:30', '21:45'] });
  f.set('2026-10-26T04:00:00Z'); await f.scheduler.tick(); assert.equal(f.sent.length, 0);
  f.set('2026-10-26T01:30:00Z'); await f.scheduler.tick(); assert.equal(f.sent.length, 2);
  f.scheduler.close(); const restored = new ScheduledChat(f.dir, f.store, f.bot, { now: () => utc('2026-10-26T01:30:30Z') }); t.after(() => restored.close());
  await restored.tick(); assert.equal(f.sent.length, 2);
  restored.now = () => utc('2026-10-26T13:45:00Z'); f.bot.active = 2; await restored.tick();
  f.store.config.scheduledChatTimes = ['09:30']; f.bot.active = 0; restored.now = () => utc('2026-10-26T13:45:30Z'); await restored.tick(); assert.equal(f.sent.length, 2);
  f.store.config.scheduledChatTimes = ['21:45']; let release;
  f.bot.request = async () => new Promise(resolve => { release = () => resolve({ choices: [{ message: { content: '不应发送' } }] }); });
  const pending = restored.tick(); f.store.config.scheduledChatTimes = ['09:30']; release(); await pending; assert.equal(f.sent.length, 2);
});

test('每天三次向各授权 DS 群发一条，空群也发；单次生成、无工具无历史无 @', async t => {
  const f = fixture(t);
  await f.scheduler.tick(); assert.equal(f.sent.length, 0);
  for (const hour of ['04', '07', '10']) {
    f.set(`2026-10-24T${hour}:00:00Z`);
    await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
    await f.scheduler.tick();
  }
  assert.equal(f.requests.length, 3); assert.equal(f.sent.length, 6);
  assert.deepEqual(f.sent.map(s => s.params.group_id), ['10003', '10004', '10003', '10004', '10003', '10004']);
  for (const { url, body } of f.requests) {
    assert.match(url, /chat\/completions$/); assert.equal(body.tools, undefined); assert.equal(body.max_tokens, 256);
    assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.messages.filter(m => m.role === 'user').length, 1);
    assert.equal(body.messages.filter(m => m.role === 'assistant').length, 0);
  }
  assert.ok(f.sent.every(s => s.action === 'send_group_msg' && s.params.message.length === 1 && s.params.message[0].type === 'text'));
  assert.equal(f.bot.conversations.list().total, 0); assert.equal(f.bot.stats.tokens, 21);
  assert.equal(f.bot.groupChat.windows.size, 0);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(f.dir, 'scheduled-chat.json'))).attempts).length, 6);
  assert.equal(statSync(join(f.dir, 'scheduled-chat.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(join(f.dir, 'scheduled-chat.json'), 'utf8'), /PRIVATE_TEST_KEY/);
});

test('同分钟重启不重发，次日同一时点可正常发送，错过的时点不补发', async t => {
  const f = fixture(t); f.set('2026-10-24T04:00:00Z'); await f.scheduler.tick(); f.scheduler.close();
  const restored = new ScheduledChat(f.dir, f.store, f.bot, { now: () => utc('2026-10-24T04:00:40Z') }); t.after(() => restored.close());
  await restored.tick(); assert.equal(f.sent.length, 2);
  restored.now = () => utc('2026-10-24T07:03:00Z'); await restored.tick(); assert.equal(f.sent.length, 2);
  restored.now = () => utc('2026-10-25T04:00:00Z'); await restored.tick(); assert.equal(f.sent.length, 4);
});

test('关闭总开关、定时功能、DS 群授权或 Key 时不认领；在线到点遇忙最多等五分钟', async t => {
  for (const patch of [{ enabled: false }, { proactiveChatEnabled: false }, { allowedGroups: [] }, { allowedGroups: [{ id: '10003', ds: false }] }, { allowedGroups: [{ id: '10003', scheduledChat: false }] }, { deepseekKey: '' }]) {
    const f = fixture(t, patch); f.set('2026-10-24T04:00:00Z'); await f.scheduler.tick();
    assert.equal(f.requests.length, 0); assert.equal(Object.keys(f.scheduler.attempts).length, 0);
  }
  const f = fixture(t); f.set('2026-10-24T04:00:00Z'); f.bot.active = 2;
  await f.scheduler.tick(); assert.equal(f.requests.length, 0);
  f.bot.active = 0; f.advance(10000); await f.scheduler.tick(); assert.equal(f.sent.length, 2);
  f.set('2026-10-24T07:00:00Z'); f.bot.active = 2; await f.scheduler.tick();
  f.bot.active = 0; f.advance(60000); await f.scheduler.tick(); assert.equal(f.sent.length, 4);
  f.set('2026-10-24T10:00:00Z'); f.bot.active = 2; await f.scheduler.tick();
  f.bot.active = 0; f.advance(300000); await f.scheduler.tick(); assert.equal(f.sent.length, 4);
});

test('生成期间关闭功能、撤销授权或停止服务会取消发言，部分撤权仅保留其他群', async t => {
  for (const revoke of [f => { f.store.config.enabled = false; }, f => { f.store.config.proactiveChatEnabled = false; }, f => { f.store.config.allowedGroups = []; }, f => { f.store.config.allowedGroups = [{ id: '10003', scheduledChat: false }, { id: '10004', scheduledChat: false }]; }, f => f.scheduler.close()]) {
    const f = fixture(t); f.set('2026-10-24T04:00:00Z'); let release;
    f.bot.request = async () => new Promise(resolve => { release = () => resolve({ choices: [{ message: { content: '不应发出' } }] }); });
    const pending = f.scheduler.tick(); revoke(f); release(); await pending;
    assert.equal(f.sent.length, 0); assert.equal(f.bot.groupChat.invitations.size, 0); assert.equal(f.bot.active, 0);
  }
  const f = fixture(t); f.set('2026-10-24T04:00:00Z'); let release;
  f.bot.request = async () => new Promise(resolve => { release = () => resolve({ choices: [{ message: { content: '只发给剩下的群' } }] }); });
  const pending = f.scheduler.tick(); f.store.config.allowedGroups = ['10004']; release(); await pending;
  assert.deepEqual(f.sent.map(s => s.params.group_id), ['10004']);
});

test('定时群开关随白名单增删同步，独立于 DS 与视频开关，重启保留关闭与时点去重', async t => {
  const f = fixture(t, { allowedGroups: [{ id: '10003', ds: true, video: true, scheduledChat: false }, { id: '10004', ds: true, video: false }] });
  f.set('2026-10-24T04:00:00Z'); await f.scheduler.tick();
  assert.deepEqual(f.sent.map(s => s.params.group_id), ['10004']); assert.equal(Object.keys(f.scheduler.attempts).length, 1);
  f.scheduler.close();
  const restored = new ScheduledChat(f.dir, f.store, f.bot, { now: () => utc('2026-10-24T04:00:40Z') }); t.after(() => restored.close());
  await restored.tick(); assert.equal(f.sent.length, 1);
  f.store.config.allowedGroups = [{ id: '10003', ds: true, scheduledChat: false }, '10006'];
  restored.now = () => utc('2026-10-24T07:00:00Z'); await restored.tick();
  assert.deepEqual(f.sent.map(s => s.params.group_id), ['10004', '10006']);
});

test('单群发送未确认也不重复，失败不阻断其他群，不为失败群开窗口', async t => {
  const f = fixture(t); f.set('2026-10-24T04:00:00Z'); const attempts = [];
  f.bot.onebot = async (_action, params) => { attempts.push(params.group_id); if (params.group_id === '10003') throw Error('QQ timeout'); return { message_id: 101 }; };
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.deepEqual(attempts, ['10003', '10004']); assert.equal(f.bot.groupChat.invitations.size, 1);
  assert.equal(f.bot.stats.failed, 1); assert.ok(f.bot.logs.some(log => log.message.includes('发送失败或未确认')));
  f.scheduler.close(); const restored = new ScheduledChat(f.dir, f.store, f.bot, { now: () => utc('2026-10-24T04:00:50Z') }); t.after(() => restored.close());
  await restored.tick(); assert.equal(attempts.length, 2);
});

test('生成失败已认领时点，不重试且不开窗口；数据损坏时隔离损坏文件并告警，不静默覆盖现场', async t => {
  const { readdirSync } = await import('node:fs');
  const f = fixture(t); f.set('2026-10-24T04:00:00Z'); let called = 0;
  f.bot.request = async () => { called++; throw Error('upstream unavailable'); };
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(called, 1); assert.equal(f.sent.length, 0); assert.equal(f.bot.groupChat.invitations.size, 0);
  writeFileSync(join(f.dir, 'scheduled-chat.json'), '{}');
  const recovered = new ScheduledChat(f.dir, f.store, f.bot);
  t.after(() => recovered.close());
  assert.ok(recovered.corruptBackup);
  assert.ok(readdirSync(f.dir).some(name => name.startsWith('scheduled-chat.json.corrupt.')));
  assert.ok(f.bot.logs.some(log => log.level === 'warn' && log.message.includes('已隔离')));
});

test('定时消息成功后任意成员免 @ 接话，仅携带公开问候并沿用五分钟窗口', async t => {
  const f = fixture(t); f.set('2026-10-24T04:00:00Z'); await f.scheduler.tick(); f.advance(10000);
  const event = { post_type: 'message', message_type: 'group', self_id: 10001, group_id: 10003, user_id: 10002, message_id: 1, message: [{ type: 'text', data: { text: '鱼鱼你喜欢什么午饭' } }] };
  f.store.config.webSearchEnabled = false;
  assert.deepEqual(f.bot.receive(event), { accepted: true }); await idle(f.bot);
  assert.deepEqual(f.requests[1].body.messages.slice(1).map(m => m.content), ['咕噜，午饭要好好吃呀。', '鱼鱼你喜欢什么午饭']);
  assert.equal(f.sent[2].params.message.some(s => s.type === 'at'), false);
  f.advance(300000);
  assert.deepEqual(f.bot.receive({ ...event, message_id: 2 }), { ignored: 'not_mentioned' });
});

test('定时窗口将过期时的普通 @ 问答不能延长窗口或让其普通回复支持免 @ 引用', async t => {
  const f = fixture(t); f.store.config.webSearchEnabled = false;
  f.set('2026-10-24T04:00:00Z'); await f.scheduler.tick(); f.advance(290000);
  const base = { post_type: 'message', message_type: 'group', self_id: 10001, group_id: 10003, user_id: 10002 };
  f.bot.receive({ ...base, message_id: 1, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: '普通 @ 问题' } }] });
  await idle(f.bot); assert.equal(f.sent.length, 3);
  f.advance(10000);
  assert.deepEqual(f.bot.receive({ ...base, message_id: 2, message: [{ type: 'text', data: { text: '这句话没有 @' } }] }), { ignored: 'not_mentioned' });
  assert.deepEqual(f.bot.receive({ ...base, user_id: 10006, message_id: 3, message: [{ type: 'reply', data: { id: '103' } }, { type: 'text', data: { text: '引用普通回复' } }] }), { ignored: 'not_mentioned' });
  assert.equal(f.requests.length, 2); assert.equal(f.sent.length, 3);
});

test('定时器到点触发，关闭服务后不再执行', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t); f.scheduler.start(); f.scheduler.start(); assert.equal(f.sent.length, 0);
  f.set('2026-10-24T04:00:00Z'); t.mock.timers.tick(10000); await idle(f.bot); assert.equal(f.sent.length, 2);
  f.bot.close(); f.set('2026-10-24T07:00:00Z'); t.mock.timers.tick(10000); assert.equal(f.sent.length, 2);
});

test('开启酒馆模式时按各群绑定的角色分别生成主动问候', async t => {
  const { TavernManager } = await import('../src/tavern/tavern-manager.mjs');
  const f = fixture(t);
  const tavern = new TavernManager(f.dir);
  const c1 = tavern.saveCharacter('char-a', { name: '角色甲', personality: '元气开朗' });
  const c2 = tavern.saveCharacter('char-b', { name: '角色乙', personality: '冷静温和' });
  tavern.saveConfig({
    enabled: true,
    defaultCharacterId: c1.id,
    groupBindings: { '10003': c1.id, '10004': c2.id }
  });
  f.bot.tavernManager = tavern;
  f.set('2026-10-24T04:00:00Z');
  await f.scheduler.tick();
  assert.equal(f.requests.length, 2);
  assert.equal(f.sent.length, 2);
  assert.ok(f.requests.some(r => r.body.messages[0].content.includes('角色甲')));
  assert.ok(f.requests.some(r => r.body.messages[0].content.includes('角色乙')));
});

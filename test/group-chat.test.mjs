import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from '../src/bot.mjs';
import { defaultConfig, openStore, validatePatch } from '../src/config.mjs';
import { followupWindowMs, followupIdleMs } from '../src/group-chat.mjs';

const text = value => ({ type: 'text', data: { text: value } });
const at = qq => ({ type: 'at', data: { qq: String(qq) } });
const quote = id => ({ type: 'reply', data: { id: String(id) } });
const event = (message = [text('今天有没有好玩的游戏呀')], fields = {}) => ({ post_type: 'message', message_type: 'group', self_id: 10001, user_id: 10002, group_id: 10003, message_id: 1, message, ...fields });
const idle = async bot => {
  for (let i = 0; i < 300; i++) { if (!bot.active && !bot.queue.length) return; await new Promise(r => setTimeout(r, 2)); }
  throw Error('群聊任务未结束');
};
function fixture(t, overrides = {}) {
  let now = 100000000, messageId = 100;
  const store = { config: { ...defaultConfig(), enabled: true, deepseekKey: 'TEST_KEY', allowedGroups: ['10003', '10004'], webSearchEnabled: false, cooldownSeconds: 0, ...overrides } };
  const bot = new Bot(store, undefined, null, null, { now: () => now });
  const requests = [], sent = [];
  bot.request = async (_url, body) => { requests.push(body); return { choices: [{ message: { content: '咕噜，一起聊游戏吧。' } }], usage: { total_tokens: 2 } }; };
  bot.onebot = async (action, params) => {
    if (action === 'get_msg') return { group_id: 10003, message: [text('咕噜，一起聊游戏吧。')] };
    sent.push({ action, params }); return { message_id: ++messageId };
  };
  t.after(() => bot.close());
  return { bot, store, requests, sent, advance: ms => { now += ms; }, async receive(message, fields) { const result = bot.receive(event(message, fields)); await idle(bot); return result; } };
}
function scheduledReply(f, id = 90) {
  f.bot.groupChat.replied({ message_type: 'group', self_id: 10001, group_id: 10003 }, f.store.config, '咕噜，一起聊游戏吧。', id, 'scheduled');
}

test('聊天开关升级后保留默认值，旧间隔被移除且可关闭持久化', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-groupchat-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = { ...defaultConfig(), systemPrompt: '保留提示词', allowedGroups: ['10003'] };
  for (const key of ['proactiveChatEnabled', 'proactiveIntervalMinutes', 'groupFollowupEnabled', 'scheduledChatTimes']) delete legacy[key];
  legacy.proactiveIntervalMinutes = 60;
  writeFileSync(join(dir, 'config.json'), JSON.stringify(legacy));
  const store = await openStore(dir);
  assert.equal(store.config.proactiveChatEnabled, true); assert.equal(Object.hasOwn(store.config, 'proactiveIntervalMinutes'), false); assert.equal(store.config.groupFollowupEnabled, true);
  assert.deepEqual(store.config.scheduledChatTimes, ['12:00', '15:00', '18:00']);
  for (const patch of [{ proactiveChatEnabled: 'true' }, { groupFollowupEnabled: 1 }, { proactiveIntervalMinutes: 9 }, { proactiveIntervalMinutes: 1441 }, { proactiveIntervalMinutes: 30.5 }]) assert.throws(() => validatePatch(store.config, patch));
  store.save({ proactiveChatEnabled: false, groupFollowupEnabled: false });
  assert.equal((await openStore(dir)).config.groupFollowupEnabled, false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'))).proactiveChatEnabled, false);
  assert.equal(store.config.systemPrompt, legacy.systemPrompt);
});

test('普通 @ 问答及其引用都不能开启免 @ 窗口', async t => {
  const f = fixture(t);
  await f.receive([at(10001), text('普通问题')]); f.advance(10000);
  assert.deepEqual(await f.receive([text('这句没有 @')], { message_id: 2 }), { ignored: 'not_mentioned' });
  assert.deepEqual(await f.receive([quote(101), text('引用普通回复也不能接话')], { user_id: 10005, message_id: 3 }), { ignored: 'not_mentioned' });
  assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.bot.groupChat.windows.size, 0); assert.equal(f.bot.groupChat.replies.size, 0);
});

test('定时问候固定前五分钟，之后按一分钟续聊；跨用户、跨群与超时引用隔离', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.receive(), { ignored: 'not_mentioned' });
  scheduledReply(f); f.advance(10000);
  await f.receive([text('你好鱼鱼')]); f.advance(10000);
  assert.deepEqual(await f.receive([text('继续刚才的话题')], { message_id: 2 }), { accepted: true });
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].messages.slice(1).map(m => m.content), ['你好鱼鱼', '咕噜，一起聊游戏吧。', '继续刚才的话题']);
  assert.equal(f.sent[1].params.message.some(s => s.type === 'at'), false);
  assert.equal(f.bot.logDetail(f.bot.logs[0].id).replyMention, '');
  assert.deepEqual(await f.receive([text('别人的普通群消息')], { user_id: 10005, message_id: 3 }), { ignored: 'not_mentioned' });
  assert.deepEqual(await f.receive([text('另一个群的消息')], { group_id: 10004, message_id: 4 }), { ignored: 'not_mentioned' });
  f.advance(followupWindowMs - 20001);
  assert.deepEqual(await f.receive([text('还在五分钟内')], { message_id: 5 }), { accepted: true });
  f.advance(followupIdleMs - 1);
  assert.deepEqual(await f.receive([text('超过五分钟但一分钟内接上')], { message_id: 6 }), { accepted: true });
  f.advance(followupIdleMs);
  assert.deepEqual(await f.receive([text('一分钟无人接话后退出')], { message_id: 7 }), { ignored: 'not_mentioned' });
  assert.deepEqual(await f.receive([quote(104), text('引用也不能重开')], { user_id: 10005, message_id: 8 }), { ignored: 'not_mentioned' });
  assert.equal(f.bot.stats.replied, 4);
});

test('首条定时消息五分钟无人参与即结束，早期接话不将五分钟整体后移', async t => {
  const empty = fixture(t); scheduledReply(empty); empty.advance(followupWindowMs);
  assert.deepEqual(await empty.receive([text('刚到五分钟才接话')]), { ignored: 'not_mentioned' });
  assert.deepEqual(await empty.receive([quote(90), text('引用旧问候')], { message_id: 2 }), { ignored: 'not_mentioned' });
  const f = fixture(t); scheduledReply(f); f.advance(10000); await f.receive([text('第一句')]);
  f.advance(200000); assert.deepEqual(await f.receive([text('前五分钟间隔超过一分钟仍可聊')], { message_id: 2 }), { accepted: true });
  f.advance(90000); assert.deepEqual(await f.receive([text('前五分钟结束且最后回复已超一分钟')], { message_id: 3 }), { ignored: 'not_mentioned' });
});

test('超过五分钟后按群连续接话计时，已参与者共用一分钟，旧引用不延长窗口', async t => {
  const f = fixture(t); scheduledReply(f); f.advance(280000);
  await f.receive([text('接上')]); f.advance(15000);
  await f.receive([quote(101), text('我也加入')], { user_id: 10005, message_id: 2 }); f.advance(50000);
  assert.deepEqual(await f.receive([text('前一个人的回复接续了本群')], { message_id: 3 }), { accepted: true }); f.advance(50000);
  assert.deepEqual(await f.receive([text('我接着说')], { user_id: 10005, message_id: 4 }), { accepted: true }); f.advance(followupIdleMs);
  assert.deepEqual(await f.receive([quote(104), text('过期后不能重开')], { user_id: 10006, message_id: 5 }), { ignored: 'not_mentioned' });
});

test('及时接话的生成耗时不挤占等待时间；新定时消息或关闭开关会取消旧会话在途回复', async t => {
  const f = fixture(t); scheduledReply(f); f.advance(299000); let release;
  f.bot.request = async () => new Promise(resolve => { release = () => resolve({ choices: [{ message: { content: '生成较慢的回复' } }] }); });
  assert.deepEqual(f.bot.receive(event()), { accepted: true }); f.advance(120000);
  f.bot.pruneTransientCaches(); release(); await idle(f.bot); assert.equal(f.sent.length, 1);
  assert.equal(f.bot.groupChat.sessions.get('10001:10003:').pending, 0);
  f.advance(10000); assert.deepEqual(f.bot.receive(event(undefined, { message_id: 2 })), { accepted: true });
  scheduledReply(f, 95); release(); await idle(f.bot); assert.equal(f.sent.length, 1);
  assert.equal(f.bot.groupChat.invitations.size, 1);
});

test('其他成员仅引用定时问候或后续免 @ 回复可接话，独立历史和其他引用不会混入', async t => {
  const f = fixture(t);
  await f.receive([at(10001), text('ORIGINAL_USER_HISTORY')]);
  scheduledReply(f); f.advance(10000);
  assert.deepEqual(await f.receive([quote(90), text('这个话题我也想聊')], { user_id: 10005, message_id: 2 }), { accepted: true });
  assert.doesNotMatch(JSON.stringify(f.requests[1].messages), /ORIGINAL_USER_HISTORY/);
  assert.deepEqual(f.requests[1].messages.slice(1).map(m => m.content), ['咕噜，一起聊游戏吧。', '这个话题我也想聊']);
  f.advance(10000);
  for (const [i, message] of [[at(10006), text('回复其他人')], [quote(999), text('引用其他人')], [quote(101), text('引用普通 @ 的回复')], [text('/签到 绑定 TOKEN')], [text('/订阅 帮助')]].entries()) {
    assert.deepEqual(await f.receive(message, { user_id: 10005, message_id: i + 3 }), { ignored: 'not_mentioned' });
  }
  assert.equal(f.requests.length, 2);
});

test('续聊按群限速、同一消息去重，拒绝的消息不延长窗口', async t => {
  const f = fixture(t); scheduledReply(f); f.advance(10000);
  await f.receive([text('来聊天')]);
  assert.deepEqual(await f.receive([text('发得太快')], { message_id: 2 }), { ignored: 'cooldown' });
  f.advance(10000); await f.receive([text('正常接话')], { message_id: 3 });
  f.advance(10000);
  assert.deepEqual(await f.receive([text('正常接话')], { message_id: 3 }), { ignored: 'duplicate' });
  f.advance(followupWindowMs - 10000);
  assert.deepEqual(await f.receive([text('窗口没有被重复消息续期')], { message_id: 4 }), { ignored: 'not_mentioned' });
  assert.equal(f.requests.length, 2);
});

test('普通群消息不再随机触发主动聊天', async t => {
  const f = fixture(t); f.advance(24 * 3600000);
  for (let i = 0; i < 30; i++) assert.deepEqual(await f.receive(undefined, { message_id: i }), { ignored: 'not_mentioned' });
  assert.equal(f.requests.length, 0); assert.equal(f.sent.length, 0);
});

test('未授权群、私聊、自身消息、关闭 DS 和畸形事件不主动接话', async t => {
  const f = fixture(t); f.advance(30 * 60000);
  for (const [i, fields] of [{ group_id: 99999 }, { message_type: 'private' }, { user_id: 10001 }, { self_id: 'invalid' }, { post_type: 'message_sent' }].entries()) await f.receive(undefined, { ...fields, message_id: i + 1 });
  f.store.config.allowedGroups = [{ id: '10003', ds: false, video: true }]; await f.receive(undefined, { message_id: 7 });
  assert.equal(f.requests.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.bot.conversations.list().total, 0);
});

test('接话窗口不抢平台链接解析，@ 他人和插件命令不触发模型', async t => {
  const f = fixture(t); f.advance(30 * 60000);
  const parsed = [];
  f.bot.links = { async parse(link) { parsed.push(link); return { title: '视频', media: [], cleanup() {} }; }, close() {} };
  await f.receive([text('https://b23.tv/example')]);
  await f.receive([at(10005), text('这句话是说给别人听的')], { message_id: 2 });
  await f.receive([text('/签到 绑定 绝不能送给模型')], { message_id: 3 });
  assert.equal(parsed.length, 1); assert.equal(f.requests.length, 0);
});

test('模型或发送失败不打开续聊，原窗口也不会因失败延期', async t => {
  const f = fixture(t); scheduledReply(f); f.advance(10000);
  f.bot.onebot = async () => { throw Error('发送失败'); };
  await f.receive([text('失败的第一问')]);
  assert.equal(f.bot.groupChat.windows.size, 0);
  f.bot.onebot = async () => ({ message_id: 101 });
  scheduledReply(f, 91); f.advance(10000);
  await f.receive([text('成功的一问')], { message_id: 2 });
  f.advance(followupWindowMs - 1000);
  f.bot.request = async () => { throw Error('模型失败'); };
  await f.receive([text('未成功的续聊')], { message_id: 3 });
  f.advance(1000);
  assert.deepEqual(await f.receive([text('原窗口已经过期')], { message_id: 4 }), { ignored: 'not_mentioned' });
});

test('关闭开关或群授权会取消生成中的免 @ 回复，重启关闭窗口', async t => {
  for (const revoke of [c => { c.enabled = false; }, c => { c.allowedGroups = []; }, c => { c.allowedGroups = [{ id: '10003', ds: false }]; }, c => { c.groupFollowupEnabled = false; }, c => { c.proactiveChatEnabled = false; }, c => { c.allowedGroups = [{ id: '10003', scheduledChat: false }]; }]) {
    const f = fixture(t);
    scheduledReply(f); f.advance(10000);
    await f.receive([text('先打开窗口')]); f.advance(10000);
    const count = f.sent.length; let release;
    f.bot.request = async () => new Promise(resolve => { release = () => resolve({ choices: [{ message: { content: '不应发出' } }] }); });
    f.bot.receive(event(undefined, { message_id: 2 })); assert.ok(release);
    revoke(f.store.config); release(); await idle(f.bot);
    assert.equal(f.sent.length, count); assert.equal(f.bot.stats.failed, 0);
    assert.equal(f.bot.logDetail(f.bot.logs[0].id).replyStatus, 'cancelled');
    f.bot.close(); assert.equal(f.bot.groupChat.windows.size, 0);
  }
});

test('关闭群定时聊天或插件总开关后普通 @ 继续工作，旧窗口关闭后不因重开而恢复', async t => {
  for (const patch of [{ proactiveChatEnabled: false }, { allowedGroups: [{ id: '10003', ds: true, scheduledChat: false }] }]) {
    const f = fixture(t); scheduledReply(f); Object.assign(f.store.config, patch); f.bot.groupChat.sync(f.store.config);
    assert.equal(f.bot.groupChat.invitations.size, 0); assert.equal(f.bot.groupChat.replies.size, 0);
    assert.deepEqual(await f.receive([text('不 @ 不会回复')]), { ignored: 'not_mentioned' });
    assert.deepEqual(await f.receive([at(10001), text('普通问题')], { message_id: 2 }), { accepted: true });
    assert.equal(f.sent.length, 1);
    Object.assign(f.store.config, { proactiveChatEnabled: true, allowedGroups: ['10003'] }); f.advance(10000);
    assert.deepEqual(await f.receive([text('不恢复旧窗口')], { message_id: 3 }), { ignored: 'not_mentioned' });
  }
});

test('排队期间关闭续聊开关，任务不再调用模型；普通消息保持静默', async t => {
  const f = fixture(t);
  scheduledReply(f); f.advance(10000);
  await f.receive([text('先打开窗口')]); f.advance(10000);
  let modelCalls = 0; const release = [];
  f.bot.request = async () => { modelCalls++; return new Promise(resolve => release.push(() => resolve({ choices: [{ message: { content: '回复' } }] }))); };
  for (let i = 0; i < 2; i++) f.bot.receive(event([at(10001), text('其他群的提问')], { group_id: 10004, user_id: 10008 + i, message_id: 10 + i }));
  assert.equal(modelCalls, 2);
  assert.deepEqual(f.bot.receive(event(undefined, { message_id: 2 })), { accepted: true });
  assert.equal(f.bot.queue.length, 1);
  f.store.config.groupFollowupEnabled = false;
  release.forEach(resolve => resolve()); await idle(f.bot);
  assert.equal(modelCalls, 2); assert.ok(f.bot.logs.some(log => log.message === '自主聊天开关已关闭，取消排队任务'));
  assert.deepEqual(await f.receive(undefined, { user_id: 10005, message_id: 3 }), { ignored: 'not_mentioned' });
});

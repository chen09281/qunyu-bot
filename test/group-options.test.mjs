import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from '../src/bot.mjs';
import { defaultConfig, openStore } from '../src/config.mjs';

const at = { type: 'at', data: { qq: '10001' } };
const text = value => ({ type: 'text', data: { text: value } });
const event = (message = [at, text('你好')], extra = {}) => ({ post_type: 'message', message_type: 'group',
  self_id: 10001, user_id: 10002, group_id: 10003, message_id: 1, message, ...extra });
const store = groups => ({ config: { ...defaultConfig(), enabled: true, deepseekKey: 'test-key', webSearchEnabled: false,
  cooldownSeconds: 0, linkCooldownSeconds: 0, allowedGroups: groups } });
const idle = async bot => {
  for (let i = 0; i < 300; i++) {
    if (bot.active === 0 && bot.queue.length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('群任务未结束');
};
const response = { choices: [{ message: { content: '回答' } }], usage: { total_tokens: 3 } };

test('旧版纯群号白名单读取后升级为带开关的对象并写回配置', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-groups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ ...defaultConfig(), allowedGroups: ['123456789', '987654321'] }));
  const store = await openStore(dir, 'password8');
  assert.deepEqual(store.config.allowedGroups, [
    { id: '123456789', ds: true, video: true, scheduledChat: true },
    { id: '987654321', ds: true, video: true, scheduledChat: true }
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).allowedGroups, store.config.allowedGroups);
});

test('白名单每项可单独设置模型与视频开关，非法开关与群号被拒绝，重复群号自动合并', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-groups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir, 'password8');
  const saved = store.save({ allowedGroups: [
    { id: '123456789', ds: false, video: true },
    { id: ' 987654321 ', ds: true, video: false },
    { id: '123456789', ds: true, video: true }
  ] });
  assert.deepEqual(saved.allowedGroups, [
    { id: '123456789', ds: false, video: true, scheduledChat: true },
    { id: '987654321', ds: true, video: false, scheduledChat: true }
  ]);
  for (const allowedGroups of [[{ id: '123456789', ds: 'yes' }], [{ id: '123456789', video: 1 }], [{ id: '123456789', scheduledChat: 'false' }], [{ id: 'abc' }], [{ id: '123' }], [null], ['123']]) {
    assert.throws(() => store.save({ allowedGroups }), /群白名单/);
  }
  assert.deepEqual(store.config.allowedGroups, saved.allowedGroups);
  // 旧版字符串仍可写入，并按默认全开保存。
  assert.deepEqual(store.save({ allowedGroups: ['123456789'] }).allowedGroups, [{ id: '123456789', ds: true, video: true, scheduledChat: true }]);
});

test('群关闭模型回复后，@ 消息不调用模型，但链接解析仍按该群授权工作', async t => {
  const s = store([{ id: '10003', ds: false, video: true }]);
  let requests = 0, parsed = 0, sent = 0;
  const seen = [];
  const parser = { async parse(link, config, options) { parsed++; seen.push(options); return { title: '标题', media: [], cleanup() {} }; }, close() {} };
  const bot = new Bot(s, undefined, parser);
  try {
    bot.request = async () => { requests++; return response; };
    bot.onebot = async () => { sent++; };
    assert.deepEqual(bot.receive(event()), { ignored: 'ds_disabled' });
    assert.equal(requests, 0); assert.equal(bot.logs[0].message, '该群未开启模型回复，已忽略 @');
    assert.deepEqual(bot.receive(event([at, text('https://b23.tv/example')])), { ignored: 'ds_disabled' });
    assert.equal(parsed, 0); assert.equal(bot.linkSeen.size, 0);
    assert.deepEqual(bot.receive(event([text('https://b23.tv/example')])), { accepted: true });
    await idle(bot);
    assert.equal(parsed, 1); assert.equal(requests, 0); assert.equal(seen[0].allowVideo, true);
    assert.ok(sent > 0);
  } finally { bot.close(); }
});

test('群关闭视频解析后，链接仍解析但要求解析器不下载视频', async t => {
  const s = store([{ id: '10003', ds: true, video: false }]);
  const seen = [];
  const parser = { async parse(link, config, options) { seen.push(options); return { title: '标题', media: [], cleanup() {} }; }, close() {} };
  const bot = new Bot(s, undefined, parser);
  try {
    bot.request = async () => { throw new Error('不应调用模型'); };
    bot.onebot = async () => {};
    bot.receive(event([text('https://b23.tv/example')]));
    await idle(bot);
    assert.equal(seen.length, 1); assert.equal(seen[0].allowVideo, false);
    assert.equal(bot.stats.linksParsed, 1);
  } finally { bot.close(); }
});

test('生成期间把该群的模型开关关掉，取消尚未发送的回复', async t => {
  const s = store([{ id: '10003', ds: true, video: true }]);
  const bot = new Bot(s); let release, calls = 0; const sent = [];
  try {
    bot.request = async () => { calls++; await new Promise(resolve => { release = resolve; }); return response; };
    bot.onebot = async (_action, params) => sent.push(params.group_id);
    bot.receive(event());
    s.config.allowedGroups = [{ id: '10003', ds: false, video: true }];
    release(); await idle(bot);
    assert.equal(calls, 1); assert.deepEqual(sent, []);
    assert.equal(bot.stats.replied, 0); assert.equal(bot.stats.failed, 0);
    assert.equal(bot.logDetail(bot.logs[0].id).replyStatus, 'cancelled');
  } finally { bot.close(); }
});

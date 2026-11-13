import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.mjs';
import { defaultConfig } from '../src/config.mjs';

const at = { type: 'at', data: { qq: '10001' } };
const text = value => ({ type: 'text', data: { text: value } });
const event = (message = [at, text('你好')], extra = {}) => ({ post_type: 'message', message_type: 'group',
  self_id: 10001, user_id: 10002, group_id: 10003, message_id: 1, message, ...extra });
const store = () => ({ config: { ...defaultConfig(), enabled: true, deepseekKey: 'test-key', allowedGroups: ['10003'],
  webSearchEnabled: false, cooldownSeconds: 0, linkCooldownSeconds: 0 } });
const idle = async bot => {
  for (let i = 0; i < 300; i++) {
    if (bot.active === 0 && bot.queue.length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('群任务未结束');
};
const response = { choices: [{ message: { content: '回答' } }], usage: { total_tokens: 3 } };

test('白名单为空、缺失或群号不匹配时，文字、图片和无需 @ 的链接均不调用、不回复、不建会话', async t => {
  assert.deepEqual(defaultConfig().allowedGroups, []);
  for (const groups of [[], undefined, ['100030']]) {
    await t.test(JSON.stringify(groups) ?? '旧配置缺少白名单', async () => {
      const s = store(); s.config.allowedGroups = groups;
      let requests = 0, parsed = 0, sent = 0;
      const parser = { async parse() { parsed++; return { media: [], cleanup() {} }; }, close() {} };
      const bot = new Bot(s, undefined, parser);
      try {
        bot.request = async () => { requests++; return response; };
        bot.onebot = async () => { sent++; };
        for (const message of [[at, text('你好')], [at, { type: 'image', data: { file: 'photo.png' } }], [text('https://b23.tv/example')]]) {
          assert.deepEqual(bot.receive(event(message)), { ignored: 'group_not_allowed' });
          assert.equal(bot.logs[0].deepseekCalled, false); assert.equal(bot.logs[0].tokens, 0);
        }
        assert.equal(requests, 0); assert.equal(parsed, 0); assert.equal(sent, 0);
        assert.equal(bot.conversations.list().total, 0); assert.equal(bot.queue.length, 0);
        // Ignoring an unauthorized event must not consume its deduplication/cooldown slot.
        s.config.allowedGroups = ['10003'];
        assert.deepEqual(bot.receive(event()), { accepted: true }); await idle(bot);
        assert.equal(requests, 1); assert.equal(sent, 1); assert.equal(bot.stats.replied, 1);
      } finally { bot.close(); }
    });
  }
});

test('清空或移除群授权后，取消生成中的回复及该群排队调用；其余授权群仍能调用', async t => {
  for (const remaining of [[], ['10004']]) {
    await t.test(JSON.stringify(remaining), async () => {
      const s = store(), bot = new Bot(s); let release, calls = 0; const sent = [];
      try {
        bot.request = async () => { calls++; if (calls === 1) await new Promise(resolve => { release = resolve; }); return response; };
        bot.onebot = async (_action, params) => sent.push(params.group_id);
        bot.receive(event()); bot.receive(event(undefined, { message_id: 2 }));
        assert.equal(calls, 1); assert.equal(bot.queue.length, 1);
        s.config.allowedGroups = remaining; release(); await idle(bot);
        assert.equal(calls, 1); assert.deepEqual(sent, []);
        assert.equal(bot.stats.failed, 0); assert.equal(bot.stats.replied, 0);
        assert.ok(bot.logs.every(log => bot.logDetail(log.id).replyStatus === 'cancelled'));
        const first = bot.logs.find(log => log.deepseekCalled);
        assert.equal(first.tokens, 3);
        const chat = bot.conversations.list().items[0];
        assert.deepEqual(bot.conversations.context(chat.id), []);
        if (remaining.length) {
          bot.receive(event(undefined, { group_id: 10004, message_id: 3 })); await idle(bot);
          assert.equal(calls, 2); assert.deepEqual(sent, [10004]);
        }
      } finally { bot.close(); }
    });
  }
});

test('读取引用图片期间清空白名单，不再调用识图模型或写入聊天上下文', async () => {
  const s = store(), bot = new Bot(s); let release, calls = 0;
  try {
    bot.request = async () => { calls++; return response; };
    bot.onebot = async action => {
      assert.equal(action, 'get_msg');
      return new Promise(resolve => { release = () => resolve({ group_id: 10003,
        message: [{ type: 'image', data: { url: 'https://gchat.qpic.cn/test.png' } }] }); });
    };
    bot.receive(event([at, { type: 'reply', data: { id: '123' } }]));
    s.config.allowedGroups = []; release(); await idle(bot);
    assert.equal(calls, 0); assert.equal(bot.conversations.list().total, 0);
    assert.equal(bot.logDetail(bot.logs[0].id).replyStatus, 'cancelled');
  } finally { bot.close(); }
});

test('联网搜索期间移除群授权，不再发起后续模型生成请求', async () => {
  const s = store(); s.config.webSearchEnabled = true;
  const bot = new Bot(s); let release; const urls = [];
  try {
    bot.request = async url => { urls.push(url); return new Promise(resolve => { release = () => resolve({ results: [] }); }); };
    bot.onebot = async () => assert.fail('撤销授权后不得发送');
    bot.receive(event()); s.config.allowedGroups = []; release(); await idle(bot);
    assert.equal(urls.length, 1); assert.match(urls[0], /\/tools\/search$/);
    assert.equal(bot.logDetail(bot.logs[0].id).replyStatus, 'cancelled');
    assert.equal(bot.stats.failed, 0);
  } finally { bot.close(); }
});

test('解析下载期间清空白名单，清理媒体且不再发送或启动排队解析', async () => {
  const s = store(); let release, parsed = 0, cleaned = 0;
  const parser = { async parse() { parsed++; return new Promise(resolve => { release = () => resolve({ title: '图集',
    media: [{ type: 'image', file: 'file:///test/1.jpg' }, { type: 'image', file: 'file:///test/2.jpg' }], cleanup() { cleaned++; } }); }); }, close() {} };
  const bot = new Bot(s, undefined, parser);
  try {
    bot.onebot = bot.request = async () => assert.fail('撤销授权后不得调用或发送');
    bot.receive(event([text('https://b23.tv/first')]));
    bot.receive(event([text('https://b23.tv/second')], { user_id: 10004, message_id: 2 }));
    assert.equal(parsed, 1); assert.equal(bot.queue.length, 1);
    s.config.allowedGroups = []; release(); await idle(bot);
    assert.equal(parsed, 1); assert.equal(cleaned, 1); assert.equal(bot.stats.linksParsed, 0);
    assert.ok(bot.logs.every(log => bot.logDetail(log.id).replyStatus === 'cancelled'));
  } finally { bot.close(); }
});

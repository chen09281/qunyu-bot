import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTavernCommand, TavernCommands } from '../src/tavern/commands.mjs';
import { TavernManager } from '../src/tavern/tavern-manager.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('parseTavernCommand 正确解析各类酒馆命令', () => {
  // /char list
  const e1 = { message: [{ type: 'text', data: { text: '/char list' } }] };
  assert.deepEqual(parseTavernCommand(e1), { type: 'char', arg: 'list' });

  // /角色 切换 芙莉莲
  const e2 = { message: [{ type: 'text', data: { text: '/角色 切换 芙莉莲' } }] };
  assert.deepEqual(parseTavernCommand(e2), { type: 'char', arg: '切换 芙莉莲' });

  // /undo
  const e3 = { message: [{ type: 'text', data: { text: '/undo' } }] };
  assert.deepEqual(parseTavernCommand(e3), { type: 'undo' });

  // /retry
  const e4 = { message: [{ type: 'text', data: { text: '/重试' } }] };
  assert.deepEqual(parseTavernCommand(e4), { type: 'retry' });

  // /ooc
  const e5 = { message: [{ type: 'text', data: { text: '/ooc 请表现得更害羞一点' } }] };
  assert.deepEqual(parseTavernCommand(e5), { type: 'ooc', instruction: '请表现得更害羞一点' });

  // /酒馆 系列快捷指令
  assert.deepEqual(parseTavernCommand({ message: [{ type: 'text', data: { text: '/酒馆' } }] }), { type: 'help' });
  assert.deepEqual(parseTavernCommand({ message: [{ type: 'text', data: { text: '/酒馆 帮助' } }] }), { type: 'help' });
  assert.deepEqual(parseTavernCommand({ message: [{ type: 'text', data: { text: '/酒馆 文档' } }] }), { type: 'doc' });
  assert.deepEqual(parseTavernCommand({ message: [{ type: 'text', data: { text: '/酒馆 列表' } }] }), { type: 'char', arg: '列表' });
  assert.deepEqual(parseTavernCommand({ message: [{ type: 'text', data: { text: '/酒馆 切换 芙莉莲' } }] }), { type: 'char', arg: '切换 芙莉莲' });
  assert.deepEqual(parseTavernCommand({ message: [{ type: 'text', data: { text: '/酒馆 撤回' } }] }), { type: 'undo' });
  assert.deepEqual(parseTavernCommand({ message: [{ type: 'text', data: { text: '/酒馆 重试' } }] }), { type: 'retry' });
  assert.deepEqual(parseTavernCommand({ message: [{ type: 'text', data: { text: '/酒馆 ooc 温柔一点' } }] }), { type: 'ooc', instruction: '温柔一点' });

  // 普通消息及无斜杠前缀关键词均不应被拦截
  const e6 = { message: [{ type: 'text', data: { text: '今天天气不错' } }] };
  assert.equal(parseTavernCommand(e6), null);
  assert.equal(parseTavernCommand({ message: [{ type: 'text', data: { text: '撤回' } }] }), null);
  assert.equal(parseTavernCommand({ message: [{ type: 'text', data: { text: '角色 列表' } }] }), null);
  assert.deepEqual(parseTavernCommand({ message: [{ type: 'text', data: { text: '/羁绊榜' } }] }), { type: 'leaderboard' });
  assert.deepEqual(parseTavernCommand({ message: [{ type: 'text', data: { text: '/投喂 草莓蛋糕' } }] }), { type: 'feed', item: '草莓蛋糕' });
  assert.deepEqual(parseTavernCommand({ message: [{ type: 'text', data: { text: '/剧场 海边烟花' } }] }), { type: 'theater', arg: '海边烟花' });
});

test('TavernCommands 执行 /char list 和 /char switch', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tavern-cmd-test-'));
  try {
    const mgr = new TavernManager(tmp);
    mgr.saveConfig({ ...mgr.state, enabled: true });
    mgr.saveCharacter('frieren', {
      name: '芙莉莲',
      first_mes: '你好，{{user}}。'
    });

    const replies = [];
    const dummyOnebot = async (action, params) => {
      replies.push({ action, params });
    };

    const dummyConversations = {
      findSession: () => null,
      reset: () => true,
      undoTurn: () => null,
      lastTurn: () => null
    };

    const store = {
      config: {
        enabled: true,
        allowedGroups: ['123456']
      }
    };

    const cmdHandler = new TavernCommands(mgr, dummyConversations, {
      onebot: dummyOnebot,
      store
    });

    // 1. 测试 /char list
    const event1 = {
      post_type: 'message',
      message_type: 'group',
      group_id: 123456,
      user_id: 99999,
      self_id: 10001,
      message_id: 1,
      message: [{ type: 'text', data: { text: '/char list' } }]
    };
    const res1 = cmdHandler.receive(event1);
    assert.equal(res1.accepted, true);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(replies.length, 1);
    const sentText1 = replies[0].params.message.find(m => m.type === 'text' && m.data.text.includes('芙莉莲'));
    assert.ok(sentText1);

    // 2. 测试 /char switch 芙莉莲
    const event2 = {
      post_type: 'message',
      message_type: 'group',
      group_id: 123456,
      user_id: 99999,
      self_id: 10001,
      message_id: 2,
      sender: { nickname: '辛美尔' },
      message: [{ type: 'text', data: { text: '/char switch 芙莉莲' } }]
    };
    const res2 = cmdHandler.receive(event2);
    assert.equal(res2.accepted, true);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(replies.length, 2);
    const sentText2 = replies[1].params.message.find(m => m.type === 'text' && m.data.text.includes('你好，辛美尔。'));
    assert.ok(sentText2);

    // 3. 测试 /情绪 指令查询五项指标（含抑郁值）
    mgr.emotions.apply('frieren', { isPrivate: false, groupId: '123456' }, { depression: 7, mood: '微醺怀念', reason: '回忆起旅途' });
    const event3 = {
      post_type: 'message',
      message_type: 'group',
      group_id: 123456,
      user_id: 99999,
      self_id: 10001,
      message_id: 3,
      message: [{ type: 'text', data: { text: '/情绪' } }]
    };
    const res3 = cmdHandler.receive(event3);
    assert.equal(res3.accepted, true);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(replies.length, 3);
    const sentText3 = replies[2].params.message.filter(m => m.type === 'text').map(m => m.data.text).join('');
    assert.match(sentText3, /好感度/);
    assert.match(sentText3, /抑郁值.*22/);
    assert.match(sentText3, /微醺怀念/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('TavernCommands 执行 /酒馆 帮助 与 /酒馆 文档', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tavern-help-doc-test-'));
  try {
    const mgr = new TavernManager(tmp);
    mgr.saveConfig({ ...mgr.state, enabled: true });
    const calls = [];
    let cleaned = false;

    const logs = [];
    const cmdHandler = new TavernCommands(mgr, {
      findSession: () => null,
      reset: () => true,
      undoTurn: () => null,
      lastTurn: () => null
    }, {
      dataDir: tmp,
      log: (level, message, fields) => logs.push({ level, message, fields }),
      onebot: async (action, params) => {
        calls.push({ action, params });
      },
      store: {
        config: {
          enabled: true,
          allowedGroups: ['123456']
        }
      },
      helpImage: {
        create: async () => 'base64://mock-help-image'
      },
      documents: {
        create: async (input, formats) => {
          assert.equal(input.title, '酒馆角色扮演使用说明');
          assert.ok(input.content.includes('/酒馆 帮助'));
          assert.deepEqual(formats, ['pdf']);
          return {
            files: [{ uploadPath: '/tmp/tavern-guide.pdf', name: '酒馆角色扮演使用说明.pdf' }],
            cleanup: () => { cleaned = true; }
          };
        }
      }
    });

    const baseEvent = {
      post_type: 'message',
      message_type: 'group',
      group_id: 123456,
      user_id: 99999,
      self_id: 10001
    };

    const helpRes = cmdHandler.receive({
      ...baseEvent,
      message_id: 10,
      message: [{ type: 'text', data: { text: '/酒馆 帮助' } }]
    });
    assert.equal(helpRes.accepted, true);

    const docRes = cmdHandler.receive({
      ...baseEvent,
      message_id: 11,
      message: [{ type: 'text', data: { text: '/酒馆 文档' } }]
    });
    assert.equal(docRes.accepted, true);

    await new Promise(r => setTimeout(r, 30));

    assert.equal(calls.length, 2);
    assert.equal(calls[0].action, 'send_group_msg');
    assert.deepEqual(calls[0].params.message, [{ type: 'image', data: { file: 'base64://mock-help-image' } }]);

    assert.equal(calls[1].action, 'upload_group_file');
    assert.equal(calls[1].params.name, '酒馆角色扮演使用说明.pdf');
    assert.equal(cleaned, true);
    assert.ok(logs.some(l => l.level === 'info' && l.message.includes('请求酒馆帮助图片')));
    assert.ok(logs.some(l => l.level === 'info' && l.message.includes('领取酒馆使用文档 (PDF)')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('TavernCommands 停用守卫、/ooc、/retry、/投喂、/剧场 与 /羁绊榜 协同工作', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'tavern-enhanced-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const mgr = new TavernManager(tmp);
  const frieren = mgr.saveCharacter('frieren', {
    name: '芙莉莲',
    personality: '温和但有些脱线的精灵魔法使'
  });
  mgr.saveCharacter('himmel', {
    name: '辛美尔',
    personality: '开朗自信的勇者'
  });

  const replies = [];
  const retried = [];
  let undoCalled = 0;
  let lastTurnUserText = '介绍一下魔法书';
  const dummyConversations = {
    findSession: () => 'conv-1',
    reset: () => true,
    undoTurn: () => { undoCalled += 1; return { turnId: 9, prompt: lastTurnUserText }; },
    lastTurn: () => ({ id: 9, prompt: lastTurnUserText })
  };
  const store = { config: { enabled: true, allowedGroups: ['123456'] } };

  const handler = new TavernCommands(mgr, dummyConversations, {
    store,
    onebot: async (action, params) => { replies.push({ action, params }); },
    askModel: async ({ purpose }) => {
      if (purpose === 'tavern_feed') return '芙莉莲眼睛一亮，小心接过甜点咬了一小口。\n[[TAVERN_EMOTION: {"affection": 6, "joy": 7, "trust": 3, "mood": "开心", "reason": "收到美味投喂"}]]';
      if (purpose === 'tavern_theater') return '【微风庭院】芙莉莲抬头望向渐暗的暮色，轻声说：“这里和当年路过的地方真像呢。”';
      return '';
    },
    onRetry: (event, cleanPrompt) => { retried.push({ event, cleanPrompt }); return { accepted: true }; },
    renderEmotionCard: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  });

  const makeEvt = (id, uid, text, nick = '勇者') => ({
    post_type: 'message',
    message_type: 'group',
    group_id: 123456,
    user_id: uid,
    self_id: 10001,
    message_id: id,
    sender: { nickname: nick },
    message: [{ type: 'text', data: { text } }]
  });

  // 1. 酒馆停用时：/retry、/ooc 等通用指令不应拦截，/酒馆 帮助 返回未启用提示
  assert.equal(handler.receive(makeEvt(1, 90001, '/retry')), null);
  assert.equal(handler.receive(makeEvt(10, 90001, '/ooc 温柔一点')), null);
  assert.equal(handler.receive(makeEvt(2, 90001, '/酒馆 帮助')).accepted, true);
  await Promise.all([...handler.jobs]);
  assert.match(replies.at(-1).params.message.at(-1).data.text, /当前未启用/);

  // 2. 开启酒馆与群内个人独立好感模式
  mgr.saveConfig({ ...mgr.state, enabled: true, emotionScopeMode: 'group-member' });

  await handler.receive(makeEvt(3, 90001, '/ooc 这一轮温柔鼓励一下群友'));
  await Promise.all([...handler.jobs]);
  assert.equal(mgr.getPendingOoc({ isPrivate: false, groupId: '123456', userId: '90001' }), '这一轮温柔鼓励一下群友');

  await handler.receive(makeEvt(4, 90001, '/ooc 清除'));
  await Promise.all([...handler.jobs]);
  assert.equal(mgr.getPendingOoc({ isPrivate: false, groupId: '123456', userId: '90001' }), '');

  await handler.receive(makeEvt(5, 90001, '/retry'));
  await Promise.all([...handler.jobs]);
  assert.equal(undoCalled, 1);
  assert.equal(retried.length, 1);
  assert.equal(retried[0].cleanPrompt, '介绍一下魔法书');

  // 3. 投喂与个人好感度变化 + 羁绊榜 + 卡片渲染 + 小剧场
  await handler.receive(makeEvt(6, 90001, '/投喂 草莓蛋糕', '勇者A'));
  await Promise.all([...handler.jobs]);
  assert.equal(mgr.emotions.get(frieren.id, { isPrivate: false, groupId: '123456', userId: '90001' }, 'group-member').affection, 56);
  assert.equal(mgr.emotions.get(frieren.id, { isPrivate: false, groupId: '123456', userId: '90002' }, 'group-member').affection, 50);

  await handler.receive(makeEvt(7, 90001, '/情绪', '勇者A'));
  await Promise.all([...handler.jobs]);
  assert.ok(replies.at(-1).params.message.some(s => s.type === 'image'));

  await handler.receive(makeEvt(8, 90001, '/羁绊榜', '勇者A'));
  await Promise.all([...handler.jobs]);
  assert.match(replies.at(-1).params.message.at(-1).data.text, /QQ 90001/);

  await handler.receive(makeEvt(9, 90001, '/剧场 星空营地', '勇者A'));
  await Promise.all([...handler.jobs]);
  assert.match(replies.at(-1).params.message.at(-1).data.text, /微风庭院/);
});

test('Bot + TavernManager 按角色隔离群友历史记录，并在本轮结束后消费 /ooc 导演指令', async t => {
  const { Bot } = await import('../src/bot.mjs');
  const { Conversations } = await import('../src/conversations.mjs');
  const { defaultConfig } = await import('../src/config.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'tavern-bot-isolation-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const mgr = new TavernManager(tmp);
  const c1 = mgr.saveCharacter('alpha', { name: '角色阿尔法', personality: '沉稳' });
  const c2 = mgr.saveCharacter('beta', { name: '角色贝塔', personality: '活泼' });
  mgr.saveConfig({ enabled: true, defaultCharacterId: c1.id });

  const store = {
    config: {
      ...defaultConfig(),
      enabled: true,
      deepseekKey: 'test-key',
      allowedGroups: ['10003'],
      webSearchEnabled: false,
      cooldownSeconds: 0
    }
  };
  const convs = new Conversations(join(tmp, 'conversations.sqlite'));
  const sent = [];
  const modelBodies = [];
  const bot = new Bot(store, convs, null, null);
  bot.onebot = async (action, params) => { sent.push({ action, params }); return { message_id: sent.length }; };
  bot.request = async (_url, body) => {
    modelBodies.push(body);
    return { choices: [{ message: { content: '收到回应。' }, finish_reason: 'stop' }], usage: { total_tokens: 10 } };
  };
  bot.tavernManager = mgr;
  bot.tavernCommands = new TavernCommands(mgr, convs, { store, onebot: bot.onebot });
  t.after(() => bot.close());

  const atBot = (id, uid, text) => ({
    post_type: 'message',
    message_type: 'group',
    self_id: 10001,
    group_id: 10003,
    user_id: uid,
    message_id: id,
    sender: { nickname: `用户${uid}` },
    message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text } }]
  });

  mgr.setPendingOoc({ isPrivate: false, groupId: '10003' }, '语气非常温柔');
  assert.equal(bot.receive(atBot(1, 20001, '你好阿尔法')).accepted, true);
  while (bot.active > 0 || bot.queue.length > 0) await new Promise(r => setTimeout(r, 15));

  assert.ok(modelBodies[0].messages.some(m => m.content.includes('语气非常温柔')));
  // 消费后应自动清除
  assert.equal(mgr.getPendingOoc({ isPrivate: false, groupId: '10003' }), '');

  // 切换到角色贝塔后，其他群成员提问不应携带阿尔法的群内历史回合
  mgr.bindCharacter({ isPrivate: false, groupId: '10003' }, c2.id);
  assert.equal(bot.receive(atBot(2, 20001, '你好贝塔')).accepted, true);
  while (bot.active > 0 || bot.queue.length > 0) await new Promise(r => setTimeout(r, 15));

  const betaUserContents = modelBodies[1].messages.filter(m => m.role === 'user').map(m => m.content);
  assert.equal(betaUserContents.some(text => text.includes('你好阿尔法')), false);
});

test('酒馆文档与帮助长图覆盖核心新功能且排版与尺寸自洽', async () => {
  const { readFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { tavernHelpImageSize } = await import('../src/tavern/help-image.mjs');

  const guide = readFileSync(new URL('../src/tavern/usage-guide.md', import.meta.url), 'utf8');
  const helpHtml = readFileSync(new URL('../src/tavern/help.html', import.meta.url), 'utf8');
  const operatorDoc = readFileSync(new URL('../docs/tavern.md', import.meta.url), 'utf8');

  for (const text of [guide, helpHtml, operatorDoc]) {
    assert.ok(text.includes('/情绪'));
    assert.ok(text.includes('/羁绊榜'));
    assert.ok(text.includes('/投喂'));
    assert.ok(text.includes('/剧场'));
    assert.ok(text.includes('/ooc 清除'));
    assert.ok(text.includes('/酒馆 文档'));
    assert.doesNotMatch(text, /端口\s*`?8000`?/);
  }
  for (const text of [guide, helpHtml]) {
    assert.doesNotMatch(text, /ccv3/i);
  }
  assert.match(operatorDoc, /仅识别 `chara` 关键字（不读取未转化的纯 `ccv3` 块）/);

  assert.match(helpHtml, new RegExp(`height:\\s*${tavernHelpImageSize.height}px`));
  assert.ok(guide.includes(`${tavernHelpImageSize.width}×${tavernHelpImageSize.height}`));
  assert.ok(operatorDoc.includes(`${tavernHelpImageSize.width}×${tavernHelpImageSize.height}`));

  const pyCheck = spawnSync('python3', [
    '-c',
    `import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('dw', sys.argv[1])
dw = importlib.util.module_from_spec(spec); spec.loader.exec_module(dw)
parts = dw.blocks(pathlib.Path(sys.argv[2]).read_text('utf-8'))
tables = [v for k, v in parts if k == 'table']
assert len(tables) >= 3
assert all(len({len(r) for r in t}) == 1 for t in tables)`,
    fileURLToPath(new URL('../src/document-worker.py', import.meta.url)),
    fileURLToPath(new URL('../src/tavern/usage-guide.md', import.meta.url))
  ], { encoding: 'utf8', timeout: 10000 });
  assert.equal(pyCheck.status, 0, pyCheck.stdout + pyCheck.stderr);
});

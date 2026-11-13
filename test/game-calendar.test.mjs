import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GameCalendarService,
  extractCodesFromText,
  extractDateRangeFromText
} from '../src/game-calendar/service.mjs';
import { GameCalendarCommands, gameCalendarCommand } from '../src/game-calendar/commands.mjs';
import { openStore } from '../src/config.mjs';

test('解析群聊与私聊中的游戏兑换码与日历指令', () => {
  assert.deepEqual(
    gameCalendarCommand({ self_id: 10001, message: [{ type: 'text', data: { text: '/兑换码' } }] }),
    { mode: 'codes', keyword: '兑换码', arg: '' }
  );
  assert.deepEqual(
    gameCalendarCommand({ self_id: 10001, message: [{ type: 'text', data: { text: '/礼包码 鸣潮' } }] }),
    { mode: 'codes', keyword: '礼包码', arg: '鸣潮' }
  );
  assert.deepEqual(
    gameCalendarCommand({ self_id: 10001, message: [{ type: 'text', data: { text: '/日历 明日方舟' } }] }),
    { mode: 'calendar', keyword: '日历', arg: '明日方舟' }
  );
  assert.deepEqual(
    gameCalendarCommand({ self_id: 10001, message: [{ type: 'text', data: { text: '/活动 帮助' } }] }),
    { mode: 'help', keyword: '活动', arg: '' }
  );
  assert.equal(
    gameCalendarCommand({ self_id: 10001, message: [{ type: 'text', data: { text: '今天吃什么' } }] }),
    null
  );
});

test('游戏兑换码与日历增删改查、公告提取同步及高清卡片渲染', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bot-game-calendar-'));
  const store = await openStore(dir, 'password123');
  const nowMs = Date.parse('2026-11-01T04:00:00Z');
  const service = new GameCalendarService(dir, store, {
    now: () => nowMs,
    readFeed: async gameId => ({
      items: [
        {
          id: `${gameId}-news-1`,
          title: '2.8版本前瞻特别节目回顾与限时寻访开启',
          summary: '活动时间：2026年11月01日 10:00 ~ 2026年11月25日 03:59。直播福利兑换码：WUWA2026GIFT，礼包码2：STARLIGHT888',
          link: 'https://mc.kurogames.com/main/news',
          publishedAt: '2026-11-01T02:00:00Z'
        }
      ]
    })
  });

  // 验证公告提取工具函数
  const codes = extractCodesFromText('前瞻兑换码：WUWA2026GIFT 礼包码2：STARLIGHT888');
  assert.deepEqual(codes, ['WUWA2026GIFT', 'STARLIGHT888']);
  const range = extractDateRangeFromText('活动时间：2026年11月01日 10:00 ~ 2026年11月25日 03:59');
  assert.equal(range.startAt, '2026-11-01 10:00');
  assert.equal(range.endAt, '2026-11-25 03:59');

  // 增删改兑换码与活动
  const afterCode = service.upsertCode({
    game: 'wuwa',
    code: 'AEMEATH999',
    reward: '星声×100',
    expiresAt: '2026-11-15 23:59',
    note: '版本福利'
  });
  const createdCode = afterCode.codes.find(c => c.code === 'AEMEATH999');
  assert.ok(createdCode);
  assert.equal(createdCode.reward, '星声×100');

  const afterAct = service.upsertActivity({
    game: 'zzz',
    title: '独家频段限时调频',
    kind: 'banner',
    startAt: '2026-11-01 10:00',
    endAt: '2026-11-20 14:59',
    summary: '限定 S 级代理人概率提升'
  });
  const createdAct = afterAct.activities.find(a => a.title === '独家频段限时调频');
  assert.ok(createdAct);

  // 官方公告同步
  const synced = await service.syncOfficial('wuwa');
  assert.equal(synced.syncedCount, 1);
  assert.ok(synced.codes.some(c => c.code === 'WUWA2026GIFT'));
  assert.ok(synced.codes.some(c => c.code === 'STARLIGHT888'));

  // 渲染高清 PNG 卡片
  const preview = await service.preview('codes', 'wuwa');
  assert.equal(preview.mode, 'codes');
  assert.ok(preview.text.includes('AEMEATH999'));
  if (preview.card) {
    assert.ok(preview.card.startsWith('data:image/png;base64,'));
  }

  // 删除创建的记录
  service.removeCode(createdCode.id);
  service.removeActivity(createdAct.id);
  assert.ok(!service.status().codes.some(c => c.id === createdCode.id));
  assert.ok(!service.status().activities.some(a => a.id === createdAct.id));
});

test('群聊发送 /兑换码 与 /日历 指令返回卡片或文本回退', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bot-game-cmd-'));
  const store = await openStore(dir, 'password123');
  store.save({ enabled: true, allowedGroups: [{ id: '123456', ds: true, video: true, scheduledChat: true }] });
  let clock = 100000;
  const sent = [];
  const service = new GameCalendarService(dir, store, {
    now: () => clock,
    worker: async input => {
      // 写入最小合法 PNG 头用于快速测试命令链路
      const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
        'hex'
      );
      fs.writeFileSync(path.join(input.directory, 'card.png'), png);
      return { card: 'card.png' };
    }
  });
  const commands = new GameCalendarCommands(store, service, {
    now: () => clock,
    onebot: async (action, payload) => { sent.push({ action, payload }); return { message_id: 1 }; }
  });

  const res1 = commands.receive({
    post_type: 'message',
    message_type: 'group',
    self_id: 10001,
    group_id: 123456,
    user_id: 20002,
    message_id: 1,
    message: [{ type: 'text', data: { text: '/兑换码 鸣潮' } }]
  });
  assert.equal(res1.accepted, true);
  await Promise.all([...commands.jobs]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'send_group_msg');
  assert.equal(sent[0].payload.message[0].type, 'image');

  // 关闭卡片渲染后自动回退为文本回复
  clock += 5000;
  service.configure({ renderCard: false });
  const res2 = commands.receive({
    post_type: 'message',
    message_type: 'group',
    self_id: 10001,
    group_id: 123456,
    user_id: 20002,
    message_id: 2,
    message: [{ type: 'text', data: { text: '/日历 绝区零' } }]
  });
  assert.equal(res2.accepted, true);
  await Promise.all([...commands.jobs]);
  assert.equal(sent.length, 2);
  assert.ok(sent[1].payload.message.some(seg => seg.type === 'text' && seg.data.text.includes('绝区零 · 活动与卡池日历')));
  commands.close();
});

test('前端控制台路由支持跳转至游戏兑换码与日历插件和模型用量账单', async t => {
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('vue/server-renderer');
  const { useConsole } = await import('../frontend/src/composables/useConsole.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const prevLocation = globalThis.location;
  const prevHistory = globalThis.history;
  globalThis.location = { hash: '#overview', origin: 'http://localhost:3080' };
  globalThis.history = {
    replaceState(_s, _t, hash) { globalThis.location.hash = hash; },
    pushState(_s, _t, hash) { globalThis.location.hash = hash; }
  };
  t.after(() => {
    globalThis.location = prevLocation;
    globalThis.history = prevHistory;
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ settings: { enabled: true }, entries: [], codes: [], activities: [] }));

  let c;
  await renderToString(createSSRApp({ setup() { c = useConsole(); return () => null; } }));
  c.state.authenticated = true;

  c.navigate('plugins/game-calendar');
  assert.equal(c.state.page, 'plugins');
  assert.equal(c.state.pluginDetail, 'game-calendar');
  assert.equal(globalThis.location.hash, '#plugins/game-calendar');

  c.navigate('model/usage');
  assert.equal(c.state.page, 'model');
  assert.equal(c.state.modelTab, 'usage');
});


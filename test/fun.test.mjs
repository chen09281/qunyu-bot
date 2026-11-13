import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardRenderer, escapeHtml } from '../src/card-renderer.mjs';
import { FunStore, extractSafeKeywords } from '../src/fun/store.mjs';
import { resolveGachaGame, simulateTenPull } from '../src/fun/gacha.mjs';
import {
  parseDiceCommand,
  rollDiceExpr,
  rollSkillCheck,
  UndercoverManager,
  SoupManager
} from '../src/fun/games.mjs';
import {
  buildEmotionCardHtml,
  buildFortuneCardHtml,
  buildQuoteCardHtml,
  buildMemeCardHtml,
  buildGachaCardHtml,
  buildDailyReportCardHtml
} from '../src/fun/card-templates.mjs';
import { FunService } from '../src/fun/service.mjs';
import { FunCommands, parseFunCommand } from '../src/fun/commands.mjs';
import { EMOTION_METRICS } from '../src/tavern/emotions.mjs';

test('FunStore 损坏恢复、语录管理及隐私边界（不存聊天原文且自动清理旧记录）', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fun-store-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 1. 写入损坏 JSON 应隔离为 .corrupt.* 而不是崩溃或静默丢失
  const corruptDir = join(dir, 'corrupt');
  const seed = new FunStore(corruptDir);
  seed.save();
  writeFileSync(join(corruptDir, 'fun', 'state.json'), '{broken-json');
  const recovered = new FunStore(corruptDir);
  assert.ok(recovered.corruptBackup);
  assert.ok(readdirSync(join(corruptDir, 'fun')).some(n => n.startsWith('state.json.corrupt.')));
  recovered.close();

  // 2. 语录增删改查、去重与上限
  let now = Date.UTC(2026, 10, 13, 18, 0, 0); // 对应北京时间次日 02:00 (深夜)
  const store = new FunStore(dir, { now: () => now });
  t.after(() => store.close());

  const added = store.addQuote({ groupId: '10003', text: '今天十连必双金！', authorName: '阿明', authorQq: '10002', savedByQq: '10005' });
  assert.equal(added.duplicated, false);
  const dup = store.addQuote({ groupId: '10003', text: '今天十连必双金！', authorName: '阿明', authorQq: '10002' });
  assert.equal(dup.duplicated, true);
  assert.equal(store.listQuotes({ groupId: '10003' }).length, 1);

  // 3. 活跃度观测绝不保留完整消息或长数字 QQ 号
  const rawSecret = '这是超长隐私原话我的秘密QQ是123456789快看https://secret.example/token';
  store.observeActivity('10003', '10002', '阿明', `${rawSecret} 鸣潮 抽卡 副本`);
  store.flush();
  const rawJson = readFileSync(join(dir, 'fun', 'state.json'), 'utf8');
  assert.equal(rawJson.includes(rawSecret), false);
  assert.equal(rawJson.includes('123456789'), false);
  assert.equal(rawJson.includes('secret.example'), false);
  assert.deepEqual(extractSafeKeywords('https://a.com @123456 鸣潮 鸣潮'), ['鸣潮']);

  const report = store.getDailyReportData('10003');
  assert.equal(report.totalMessages, 1);
  assert.equal(report.topTalkers[0].count, 1);
  assert.equal(report.nightOwls[0].nightCount, 1);

  // 推进 8 天后自动淘汰超过 7 天的活跃数据
  now += 8 * 86400000;
  store.save();
  assert.equal(Object.keys(store.state.activity).length, 0);
  assert.equal(store.deleteQuote(added.quote.id), true);
  assert.equal(store.deleteQuote('not-exist'), false);
});

test('Gacha 十连模拟支持四款游戏、保底机制与双黄统计', () => {
  assert.equal(resolveGachaGame('wuwa').id, 'wuwa');
  assert.equal(resolveGachaGame('绝区零').id, 'zzz');
  assert.equal(resolveGachaGame('方舟').id, 'arknights');
  assert.equal(resolveGachaGame('zmd').id, 'endfield');
  assert.equal(resolveGachaGame('不存在的游戏'), null);

  // 从垫抽 75 开始，必定在硬保底 80 抽内出金，且大保底必中 UP
  const res = simulateTenPull('wuwa', { pity: 75, guaranteed: true, totalPulls: 75 }, { random: () => 0.99 });
  assert.equal(res.pulls.length, 10);
  const gold = res.pulls.find(p => p.rarity >= 5);
  assert.ok(gold);
  assert.equal(gold.isUp, true);
  assert.equal(gold.tag, '大保底 UP');
  assert.equal(res.stats.fiveStars, 1);
  assert.equal(res.stats.guaranteed, false);
});

test('TRPG 跑团骰娘、谁是卧底与海龟汤状态机完整流转', () => {
  // Dice parsing should not hijack `.gitignore` or numbers
  assert.equal(parseDiceCommand('.gitignore'), null);
  assert.equal(parseDiceCommand('3.14159'), null);
  assert.deepEqual(parseDiceCommand('.r 2d6+3 伤害'), { cmd: 'r', rest: '2d6+3 伤害' });
  assert.deepEqual(parseDiceCommand('.rh 1d100'), { cmd: 'rh', rest: '1d100' });

  const diceRes = rollDiceExpr('2d6+3 伤害', { randInt: () => 4 });
  assert.equal(diceRes.total, 11);
  assert.equal(diceRes.reason, '伤害');
  assert.throws(() => rollDiceExpr('99d6'), /1 到 20/);
  assert.throws(() => rollDiceExpr('1d9999'), /2 到 1000/);

  const crit = rollSkillCheck('侦查 60', { randInt: () => 2 });
  assert.equal(crit.outcome, '大成功');
  const fumble = rollSkillCheck('跳跃 30', { randInt: () => 98 });
  assert.equal(fumble.outcome, '大失败');

  // Undercover state machine
  let now = 1000000;
  const uc = new UndercoverManager({ now: () => now, random: () => 0.1 });
  uc.openRoom('10003', '1', '甲');
  assert.throws(() => uc.startGame('10003', '1'), /至少需要 3 人/);
  uc.joinRoom('10003', '2', '乙');
  uc.joinRoom('10003', '3', '丙');
  const started = uc.startGame('10003', '1');
  assert.equal(started.assignments.length, 3);
  const under = started.assignments.find(a => a.isUndercover);
  const civs = started.assignments.filter(a => !a.isUndercover);
  assert.ok(under && civs.length === 2);

  // All civilians + undercover vote against undercover -> civilian win
  uc.castVote('10003', civs[0].userId, under.userId);
  uc.castVote('10003', civs[1].userId, under.userId);
  const settled = uc.castVote('10003', under.userId, civs[0].userId);
  assert.equal(settled.settled, true);
  assert.equal(settled.eliminatedWasUndercover, true);
  assert.equal(settled.winner, 'civilian');
  assert.equal(uc.getRoom('10003'), null);

  // Soup state machine
  const soup = new SoupManager({ now: () => now });
  const game = soup.startGame('10003');
  assert.ok(game.title && game.surface && game.bottom);
  const h1 = soup.nextHint('10003');
  assert.ok(h1.hint);
  const revealed = soup.reveal('10003');
  assert.equal(revealed.title, game.title);
  assert.equal(soup.getGame('10003'), null);
});

test('卡片模板 HTML 转义防 XSS 与无头浏览器高清 PNG 渲染', async t => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  const xssName = '<img src=x onerror=alert(1)>';
  const htmlList = [
    buildEmotionCardHtml({ characterName: xssName, emotion: { affection: 88, joy: 70, trust: 80, tension: 10, depression: 5, stage: '深度羁绊', mood: '温柔', reason: '投喂<script>' }, metrics: EMOTION_METRICS }),
    buildFortuneCardHtml({ userName: xssName, dateText: '2026-11-13', tier: '大吉', verse: '顺风顺水', goodItems: ['水群'], badItems: ['熬夜'], luckyColor: '樱花粉', luckyGame: '鸣潮', comment: '不错' }),
    buildQuoteCardHtml({ text: '名场面 <script>', authorName: xssName, authorQq: '10002', groupId: '10003', dateText: '2026-11-13' }),
    buildMemeCardHtml({ mode: 'xi_bao', text: '测试喜报 <tag>' }),
    buildMemeCardHtml({ mode: 'bei_bao', text: '测试悲报 <tag>' }),
    buildMemeCardHtml({ mode: 'signboard', text: '快去睡觉 <tag>', charName: xssName }),
    buildGachaCardHtml({ gameName: '鸣潮', pulls: [{ name: '守岸人', rarity: 5, tag: 'UP' }, { name: '散华', rarity: 4, tag: '4★' }], pityAfter: 5, pityLimit: 80, totalPulls: 10, totalGold: 1, userName: xssName }),
    buildDailyReportCardHtml({ groupId: '10003', dateText: '2026-11-13', totalMessages: 42, activeMembers: 6, topTalkers: [{ userId: '10002', name: xssName, count: 12 }], hotWords: [{ word: '鸣潮', count: 5 }], aiSummary: '今天气氛热闹' })
  ];
  for (const html of htmlList) {
    assert.equal(html.includes('<img src=x onerror='), false);
    assert.equal(html.includes('<script>'), false);
    assert.ok(html.includes('&lt;'));
  }

  const renderer = new CardRenderer();
  t.after(() => renderer.close());
  if (!renderer.available) {
    t.skip('环境未安装 Chrome/Chromium，跳过真实截图渲染测试');
    return;
  }
  const png = await renderer.renderHtmlToPng({ html: htmlList[0], width: 820, height: 520 });
  assert.ok(Buffer.isBuffer(png));
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(png.length > 5000);
});

test('FunCommands 完整调度运势、喜报、语录、十连、骰娘、日报与关闭开关保护', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fun-cmd-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const store = {
    config: {
      enabled: true,
      allowedGroups: ['10003'],
      allowedPrivateUsers: ['10002']
    }
  };
  const funStore = new FunStore(dir);
  t.after(() => funStore.close());
  const service = new FunService(funStore, {
    cardRenderer: null,
    askModel: async ({ purpose }) => purpose === 'fun_daily_report' ? '今天群里都在讨论抽卡，气氛极佳。' : '【是】就是这样！'
  });

  const sent = [];
  const onebot = async (action, params) => {
    if (action === 'get_msg') {
      return {
        message_type: 'group',
        group_id: '10003',
        sender: { user_id: 10005, nickname: '金句王' },
        message: [{ type: 'text', data: { text: '下发前记得跑测试' } }]
      };
    }
    sent.push({ action, params });
    return { message_id: sent.length };
  };

  const cmds = new FunCommands(store, service, { onebot });
  t.after(() => cmds.close());

  const makeEvt = (id, text, extra = {}) => ({
    post_type: 'message',
    message_type: 'group',
    self_id: 10001,
    group_id: 10003,
    user_id: 10002,
    sender: { nickname: '阿明' },
    message_id: id,
    message: [{ type: 'text', data: { text } }],
    ...extra
  });

  // Cooldown=1200ms per group, so let's advance clock deterministically by mocking now
  let clock = 100000;
  cmds.now = () => clock;
  const runCmd = async (evt) => {
    clock += 2000;
    const res = cmds.receive(evt);
    await Promise.all([...cmds.jobs]);
    return res;
  };

  assert.equal((await runCmd(makeEvt(1, '/今日运势'))).accepted, true);
  assert.match(sent.at(-1).params.message.at(-1).data.text, /今日运势/);

  await runCmd(makeEvt(2, '/喜报 所有测试一遍通过'));
  assert.match(sent.at(-1).params.message.at(-1).data.text, /【喜报】/);

  await runCmd(makeEvt(3, '/存语录', {
    message: [{ type: 'reply', data: { id: '888' } }, { type: 'text', data: { text: '/存语录' } }]
  }));
  assert.match(sent.at(-1).params.message.at(-1).data.text, /金句王/);

  await runCmd(makeEvt(4, '/语录'));
  assert.match(sent.at(-1).params.message.at(-1).data.text, /下发前记得跑测试/);

  await runCmd(makeEvt(5, '/十连 鸣潮'));
  assert.match(sent.at(-1).params.message.at(-1).data.text, /十连结果/);

  await runCmd(makeEvt(6, '/欧非榜'));
  assert.match(sent.at(-1).params.message.at(-1).data.text, /欧非排行榜/);

  await runCmd(makeEvt(7, '.ra 侦查 65'));
  assert.match(sent.at(-1).params.message.at(-1).data.text, /【侦查】检定/);

  service.observeGroupMessage(makeEvt(8, '今天抽鸣潮歪了吗'));
  await runCmd(makeEvt(9, '/群日报'));
  assert.match(sent.at(-1).params.message.at(-1).data.text, /群聊今日风向日报/);
  assert.match(sent.at(-1).params.message.at(-1).data.text, /讨论抽卡/);

  // 停用娱乐插件后不再响应或拦截指令
  funStore.updateSettings({ enabled: false });
  assert.equal(parseFunCommand(makeEvt(10, '普通聊天不应该触发')) , null);
  assert.equal(cmds.receive(makeEvt(10, '/今日运势')), null);
});

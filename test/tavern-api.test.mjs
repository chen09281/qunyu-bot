import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/server.mjs';

test('Tavern REST API 测试', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'tavern-server-test-'));
  const app = await createApplication({
    dataDir: tmp,
    initialPassword: 'test-password-123456',
    bilibiliAutoStart: false,
    douyinAutoStart: false,
    checkinAutoStart: false,
    subscriptionAutoStart: false,
    scheduledChatAutoStart: false,
    serverStatusAutoStart: false
  });

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(r => {
    app.server.close(r);
    app.server.closeAllConnections();
    rmSync(tmp, { recursive: true, force: true });
  }));

  const port = app.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const origin = baseUrl;

  // 1. 登录获取 Cookie
  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-request': '1',
      origin
    },
    body: JSON.stringify({
      username: app.store.admin.username,
      password: 'test-password-123456'
    })
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  const adminHeaders = {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'x-admin-request': '1',
    origin
  };

  // 2. 获取初始酒馆配置
  const configRes = await fetch(`${baseUrl}/api/tavern/config`, {
    headers: { Cookie: cookie }
  });
  assert.equal(configRes.status, 200);
  const configData = await configRes.json();
  assert.equal(typeof configData.enabled, 'boolean');

  // 3. 上传角色卡 (JSON 格式)
  const cardData = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '可莉',
      description: '蒙德城西风骑士团火花骑士。',
      first_mes: '哒哒哒！可莉来啦！'
    }
  };

  const uploadRes = await fetch(`${baseUrl}/api/tavern/characters/upload`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(cardData)
  });
  assert.equal(uploadRes.status, 200);
  const uploaded = await uploadRes.json();
  assert.equal(uploaded.name, '可莉');
  assert.ok(uploaded.id);

  // 4. 获取角色卡列表
  const listRes = await fetch(`${baseUrl}/api/tavern/characters`, {
    headers: { Cookie: cookie }
  });
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.equal(listData.characters.length, 1);
  assert.equal(listData.characters[0].name, '可莉');

  // 5. 更新酒馆配置 (启用酒馆)
  const updateConfRes = await fetch(`${baseUrl}/api/tavern/config`, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({ enabled: true, defaultCharacterId: uploaded.id })
  });
  assert.equal(updateConfRes.status, 200);
  const newConf = await updateConfRes.json();
  assert.equal(newConf.enabled, true);
  assert.equal(newConf.defaultCharacterId, uploaded.id);

  // 6. 删除角色卡
  const delRes = await fetch(`${baseUrl}/api/tavern/characters/${uploaded.id}`, {
    method: 'DELETE',
    headers: adminHeaders
  });
  assert.equal(delRes.status, 200);

  const listAfterRes = await fetch(`${baseUrl}/api/tavern/characters`, {
    headers: { Cookie: cookie }
  });
  const listAfterData = await listAfterRes.json();
  assert.equal(listAfterData.characters.length, 0);

  // 7. 测试角色情绪指标后台 API 与重置接口
  const card2Res = await fetch(`${baseUrl}/api/tavern/characters/upload`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: '达妮娅', description: '泡影视阈' })
  });
  assert.equal(card2Res.status, 200);
  const card2 = await card2Res.json();
  app.bot.tavernManager.emotions.apply(card2.id, { isPrivate: false, groupId: '20001' }, {
    affection: 4,
    depression: 6,
    mood: '轻声叹息',
    reason: '提起离别'
  });

  const emotionsRes = await fetch(`${baseUrl}/api/tavern/characters/${card2.id}/emotions`, {
    headers: { Cookie: cookie }
  });
  assert.equal(emotionsRes.status, 200);
  const emotionsJson = await emotionsRes.json();
  assert.equal(emotionsJson.metrics.length, 5);
  assert.ok(emotionsJson.metrics.some(m => m.key === 'depression' && m.label === '抑郁值'));
  assert.equal(emotionsJson.sessions.length, 1);
  assert.equal(emotionsJson.sessions[0].depression, 21);

  const resetEmotionsRes = await fetch(`${baseUrl}/api/tavern/characters/${card2.id}/emotions/reset`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ scopeKey: 'group:20001' })
  });
  assert.equal(resetEmotionsRes.status, 200);
  const resetJson = await resetEmotionsRes.json();
  assert.equal(resetJson.sessions.length, 0);

  // 8. 测试隐藏情绪标签剥离（含多行与空白场景）
  const { PromptAssembler } = await import('../src/tavern/prompt-assembler.mjs');
  const extracted = PromptAssembler.extractEmotionUpdate('嗯……其实还好啦。\n[[TAVERN_EMOTION:{"affection":1,"depression":3,"mood":"嘴硬","reason":"被看穿心事"}]]');
  assert.equal(extracted.text, '嗯……其实还好啦。');
  assert.equal(extracted.update.depression, 3);

  const multilineExtracted = PromptAssembler.extractEmotionUpdate(
    '你给我一句上下文，我再判断喵。\n\n[[TAVERN_EMOTION:\n{"affection":1,"joy":2,"trust":0,"tension":1,"depression":0,"mood":"略感困惑但兴致还在","reason":"搜索结果混杂"}]]'
  );
  assert.equal(multilineExtracted.text, '你给我一句上下文，我再判断喵。');
  assert.equal(multilineExtracted.update.joy, 2);
  assert.equal(multilineExtracted.update.mood, '略感困惑但兴致还在');

  const malformedExtracted = PromptAssembler.extractEmotionUpdate('收到啦。\n[[TAVERN_EMOTION:\n{"affection":1');
  assert.equal(malformedExtracted.text, '收到啦。');

  const spacedBracketExtracted = PromptAssembler.extractEmotionUpdate(
    '没问题喵。\n\n[[TAVERN_EMOTION:{"affection":3,"joy":4,"trust":1,"tension":-2,"depression":-2,"mood":"被逗乐了","reason":"配合请求"}] ]'
  );
  assert.equal(spacedBracketExtracted.text, '没问题喵。');
  assert.equal(spacedBracketExtracted.update.affection, 3);
  assert.equal(spacedBracketExtracted.update.depression, -2);
  assert.equal(spacedBracketExtracted.update.mood, '被逗乐了');

  // 9. 测试情绪阈值触发规则与表情包上传
  const saveTriggersRes = await fetch(`${baseUrl}/api/tavern/characters/${card2.id}/triggers`, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({
      triggers: [
        {
          id: 'trig_love',
          enabled: true,
          name: '深度羁绊口癖',
          metric: 'affection',
          operator: '>=',
          threshold: 80,
          promptHint: '称呼对方为专属伙伴，语气更撒娇。',
          stickerCooldown: 2
        }
      ]
    })
  });
  assert.equal(saveTriggersRes.status, 200);
  const savedTriggersJson = await saveTriggersRes.json();
  assert.equal(savedTriggersJson.triggers.length, 1);
  assert.equal(savedTriggersJson.triggers[0].threshold, 80);

  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const uploadStickerRes = await fetch(`${baseUrl}/api/tavern/characters/${card2.id}/triggers/trig_love/sticker`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ base64: tinyPng.toString('base64'), mimeType: 'image/png' })
  });
  assert.equal(uploadStickerRes.status, 200);
  const stickerJson = await uploadStickerRes.json();
  assert.ok(stickerJson.sticker.filename.endsWith('.png'));

  const getStickerRes = await fetch(`${baseUrl}/api/tavern/stickers/${stickerJson.sticker.filename}`, {
    headers: adminHeaders
  });
  assert.equal(getStickerRes.status, 200);

  const hitAsm = PromptAssembler.assembleMessages({
    card: card2,
    prompt: '早安',
    emotionState: { affection: 85, joy: 60, trust: 50, tension: 20, depression: 15, stage: '深度羁绊', mood: '开心', reason: 'test' },
    emotionTriggers: stickerJson.triggers
  });
  assert.ok(hitAsm.messages[0].content.includes('已触发的情绪状态与彩蛋指令'));
  assert.ok(hitAsm.messages[0].content.includes('称呼对方为专属伙伴'));

  const missAsm = PromptAssembler.assembleMessages({
    card: card2,
    prompt: '早安',
    emotionState: { affection: 50, joy: 60, trust: 50, tension: 20, depression: 15, stage: '普通熟人', mood: '平静', reason: 'test' },
    emotionTriggers: stickerJson.triggers
  });
  assert.ok(!missAsm.messages[0].content.includes('已触发的情绪状态与彩蛋指令'));

  const delStickerRes = await fetch(`${baseUrl}/api/tavern/characters/${card2.id}/triggers/trig_love/sticker`, {
    method: 'DELETE',
    headers: adminHeaders
  });
  assert.equal(delStickerRes.status, 200);
  const delStickerJson = await delStickerRes.json();
  assert.equal(delStickerJson.triggers[0].sticker, null);

  // 8. 测试 emotionScopeMode 与群绑定校验
  const badBindRes = await fetch(`${baseUrl}/api/tavern/config`, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({ groupBindings: { 'invalid': card2.id } })
  });
  assert.equal(badBindRes.status, 400);

  const goodBindRes = await fetch(`${baseUrl}/api/tavern/config`, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({ emotionScopeMode: 'group-member', groupBindings: { '10003': card2.id } })
  });
  assert.equal(goodBindRes.status, 200);
  const boundConf = await goodBindRes.json();
  assert.equal(boundConf.emotionScopeMode, 'group-member');
  assert.equal(boundConf.groupBindings['10003'], card2.id);

  // 9. 测试 /api/fun 与 /api/fun/quotes 管理接口
  const funGet = await fetch(`${baseUrl}/api/fun`, { headers: { Cookie: cookie } });
  assert.equal(funGet.status, 200);
  const funJson = await funGet.json();
  assert.equal(funJson.settings.enabled, true);

  const funPut = await fetch(`${baseUrl}/api/fun`, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({ fortuneEnabled: false })
  });
  assert.equal(funPut.status, 200);
  assert.equal((await funPut.json()).settings.fortuneEnabled, false);

  const qAdded = app.funStore.addQuote({ groupId: '10003', text: '测试名言 API', authorName: 'Tester', authorQq: '10002' });
  const quotesRes = await fetch(`${baseUrl}/api/fun/quotes?groupId=10003`, { headers: { Cookie: cookie } });
  assert.equal(quotesRes.status, 200);
  const quotesData = await quotesRes.json();
  assert.equal(quotesData.quotes.length, 1);
  assert.equal(quotesData.quotes[0].id, qAdded.quote.id);

  const delQuoteRes = await fetch(`${baseUrl}/api/fun/quotes/${qAdded.quote.id}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(delQuoteRes.status, 200);
  const delQuoteMissing = await fetch(`${baseUrl}/api/fun/quotes/${qAdded.quote.id}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(delQuoteMissing.status, 404);
});

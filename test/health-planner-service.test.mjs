import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../src/config.mjs';
import { HealthPlannerStore } from '../src/health-planner/store.mjs';
import { HealthPlannerService } from '../src/health-planner/service.mjs';
import { HealthPlannerCommands, parseHealthCommand } from '../src/health-planner/commands.mjs';
import { mealSourceLabel } from '../src/health-planner/nutrition.mjs';

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-health-svc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('HealthPlannerStore 使用 AES-256-GCM 加密存储并拒绝符号链接', async t => {
  const dataDir = makeTempDir(t);
  const store1 = new HealthPlannerStore(dataDir);
  store1.upsertProfile('10002', { userName: '张三', groupId: '10001' }, {
    sex: 'male', age: 26, heightCm: 175, weightKg: 72, bodyFatPct: null,
    goal: 'cut', activityLevel: 'moderate', dietStyle: 'balanced', dislikes: [], mealRatios: { breakfast: 0.3, lunch: 0.4, dinner: 0.3 }
  });
  const encRaw = readFileSync(join(dataDir, 'health-planner', 'accounts.enc'), 'utf8');
  assert.equal(encRaw.includes('10002'), false, '加密文件不应包含明文用户号');
  assert.equal(encRaw.includes('72'), false, '加密文件不应包含明文体重');

  const store2 = new HealthPlannerStore(dataDir);
  const loaded = store2.getUser('10002');
  assert.equal(loaded.profile.weightKg, 72);
  assert.ok(loaded.syncToken.length >= 32);

  // Symlink guard
  const symDir = makeTempDir(t);
  const targetFile = join(symDir, 'evil.txt');
  writeFileSync(targetFile, 'bad');
  const linkBase = makeTempDir(t);
  symlinkSync(targetFile, join(linkBase, 'health-planner'));
  assert.throws(() => new HealthPlannerStore(linkBase), /符号链接/);
});

test('QQ 指令完整闭环：建档、拍照识图记一餐、Apple 队列联动、撤销、私聊取令牌与删除', async t => {
  const dataDir = makeTempDir(t);
  const configStore = await openStore(dataDir, 'test1234');
  configStore.save({
    enabled: true,
    botId: '99999',
    allowedGroups: [{ id: '10001', ds: true, video: true, scheduledChat: true }],
    allowedPrivateUsers: [],
    consolePublicUrl: 'https://bot.example.com'
  });

  const sent = [];
  const plannerStore = new HealthPlannerStore(dataDir);
  const fakeVision = async () => JSON.stringify({
    mealType: 'lunch',
    summary: '黑椒鸡胸肉杂粮饭配西兰花',
    calories: 560,
    proteinG: 42,
    carbsG: 62,
    fatG: 14,
    items: [{ name: '鸡胸肉', grams: 150, calories: 200, proteinG: 36 }]
  });

  let nowMs = Date.parse('2026-11-13T11:30:00+08:00');
  const service = new HealthPlannerService(plannerStore, configStore, {
    onebot: async (action, params) => {
      sent.push({ action, params });
      if (action === 'get_group_member_info') return { user_id: params.user_id, group_id: params.group_id };
      if (action === 'get_msg') return {};
      return {};
    },
    prepareInputImages: async urls => ({ images: urls.map(() => 'data:image/jpeg;base64,FAKE') }),
    askVisionModel: fakeVision,
    now: () => nowMs
  });

  const cmds = new HealthPlannerCommands(configStore, service, {
    onebot: async (action, params) => {
      sent.push({ action, params });
      return {};
    },
    now: () => nowMs
  });

  const groupMsg = (id, text, extraSegments = []) => ({
    post_type: 'message',
    message_type: 'group',
    self_id: '99999',
    group_id: '10001',
    user_id: '20001',
    message_id: id,
    sender: { nickname: '小明' },
    message: [{ type: 'text', data: { text } }, ...extraSegments]
  });

  // 1. Onboard in allowed group
  const r1 = cmds.receive(groupMsg(1, '/健康 录入 男 26岁 175cm 72kg 减脂 中度'));
  assert.equal(r1.accepted, true);
  await Promise.all([...cmds.jobs]);
  assert.ok(sent.at(-1).params.message.some(s => s.type === 'text' && s.data.text.includes('档案已保存')));

  // 2. Sync command rejected safely in group
  nowMs += 2000;
  cmds.receive(groupMsg(2, '/健康 同步'));
  await Promise.all([...cmds.jobs]);
  assert.match(sent.at(-1).params.message.map(s => s.data?.text || '').join(''), /私聊/);

  // 3. Registered group user can privately get Apple Health sync token
  nowMs += 2000;
  cmds.receive({
    post_type: 'message',
    message_type: 'private',
    self_id: '99999',
    user_id: '20001',
    message_id: 3,
    sender: { nickname: '小明' },
    message: [{ type: 'text', data: { text: '/健康 同步' } }]
  });
  await Promise.all([...cmds.jobs]);
  const syncText = sent
    .filter(item => item.action === 'send_private_msg')
    .map(item => item.params.message.map(s => s.data?.text || '').join(''))
    .join('\n');
  assert.match(syncText, /https:\/\/bot\.example\.com\/bridge\/health\/sync/);
  assert.match(syncText, /个人同步 Token：/);

  // 4. Photo meal log triggers vision estimation & queues Apple Health writeback
  nowMs += 2000;
  cmds.receive(groupMsg(4, '/记一餐 午餐', [{ type: 'image', data: { url: 'https://img.example/food.jpg' } }]));
  await Promise.all([...cmds.jobs]);
  const logReply = sent.at(-1).params.message.map(s => s.data?.text || '').join('');
  assert.match(logReply, /560 kcal/);
  assert.match(logReply, /42g/);
  assert.equal(plannerStore.pullPendingAppleSync('20001').length, 1);

  // 5. Undo removes both today's meal log and un-acked Apple sync item
  nowMs += 2000;
  cmds.receive(groupMsg(5, '/健康 撤销'));
  await Promise.all([...cmds.jobs]);
  assert.equal(plannerStore.pullPendingAppleSync('20001').length, 0);

  // 6. Delete user data via private chat confirmation
  nowMs += 2000;
  cmds.receive({
    post_type: 'message',
    message_type: 'private',
    self_id: '99999',
    user_id: '20001',
    message_id: 6,
    sender: { nickname: '小明' },
    message: [{ type: 'text', data: { text: '/健康 删除数据 确认' } }]
  });
  await Promise.all([...cmds.jobs]);
  assert.equal(plannerStore.getUser('20001'), null);
});

test('定时推送 tick 按北京时间早报与午晚分时段推送，且同日同时段绝不重复发送', async t => {
  const dataDir = makeTempDir(t);
  const configStore = await openStore(dataDir, 'test1234');
  configStore.save({
    enabled: true,
    botId: '99999',
    allowedGroups: [{ id: '10001', ds: true, video: true, scheduledChat: true }]
  });

  let currentNow = Date.parse('2026-11-13T07:32:00+08:00');
  const sent = [];
  const plannerStore = new HealthPlannerStore(dataDir, { now: () => currentNow });
  plannerStore.upsertProfile('30001', { userName: '小红', groupId: '10001' }, {
    sex: 'female', age: 24, heightCm: 163, weightKg: 54, bodyFatPct: null,
    goal: 'cut', activityLevel: 'light', dietStyle: 'balanced', dislikes: [], mealRatios: { breakfast: 0.3, lunch: 0.4, dinner: 0.3 }
  });

  const service = new HealthPlannerService(plannerStore, configStore, {
    now: () => currentNow,
    onebot: async (action, params) => {
      if (action === 'get_group_member_info') return { user_id: params.user_id, group_id: params.group_id };
      sent.push({ action, params });
      return {};
    }
  });

  // 07:32 should fire morningOverview
  await service.tick();
  assert.equal(sent.filter(s => s.action === 'send_private_msg').length, 1);
  assert.match(sent[0].params.message[0].data.text, /早餐/);
  assert.match(sent[0].params.message[0].data.text, /午餐/);
  assert.match(sent[0].params.message[0].data.text, /晚餐/);

  // Duplicate tick at 07:35 must NOT resend morningOverview
  currentNow = Date.parse('2026-11-13T07:35:00+08:00');
  await service.tick();
  assert.equal(sent.filter(s => s.action === 'send_private_msg').length, 1);

  // 11:31 should fire lunch single-meal reminder
  currentNow = Date.parse('2026-11-13T11:31:00+08:00');
  await service.tick();
  assert.equal(sent.filter(s => s.action === 'send_private_msg').length, 2);
  const lunchMsg = sent[1].params.message[0].data.text;
  assert.match(lunchMsg, /午餐/);
  assert.equal(lunchMsg.includes('【早餐'), false);
});

test('parseHealthCommand 解析指令前缀与参数边界', () => {
  const event = text => ({ self_id: '999', message: [{ type: 'text', data: { text } }] });
  assert.equal(parseHealthCommand(event('普通聊天')), null);
  assert.equal(parseHealthCommand(event('#饮食 方案'))?.type, 'plan');
  assert.equal(parseHealthCommand(event('/吃什么 晚'))?.mealType, 'dinner');
  assert.equal(parseHealthCommand(event('/记一餐 早餐 牛奶麦片'))?.mealType, 'breakfast');
});

test('mealSourceLabel、logMealFromBridge 与字符串 ids 确认闭环', async t => {
  assert.equal(mealSourceLabel('vision'), '图片识别估算');
  assert.equal(mealSourceLabel('ai_text'), 'DeepSeek/AI 模型估算');
  assert.equal(mealSourceLabel('text'), '文字录入/本地估算');

  const dataDir = makeTempDir(t);
  const configStore = await openStore(dataDir, 'test1234');
  configStore.save({
    enabled: true,
    botId: '99999',
    allowedPrivateUsers: ['40001'],
    deepseekKey: 'test-ds-key',
    consolePublicUrl: 'https://bot.example.com'
  });

  const plannerStore = new HealthPlannerStore(dataDir);
  const user = plannerStore.upsertProfile('40001', { userName: '小李', groupId: '10001' }, {
    sex: 'male', age: 28, heightCm: 176, weightKg: 70, bodyFatPct: null,
    goal: 'cut', activityLevel: 'moderate', dietStyle: 'balanced', dislikes: [], mealRatios: { breakfast: 0.3, lunch: 0.4, dinner: 0.3 }
  });

  const service = new HealthPlannerService(plannerStore, configStore, {
    now: () => Date.parse('2026-11-13T12:15:00+08:00'),
    askModel: async () => JSON.stringify({
      mealType: 'lunch',
      summary: '塔斯汀鸡肉汉堡1个+鸡块3块',
      calories: 920,
      proteinG: 42,
      carbsG: 95,
      fatG: 39
    }),
    askVisionModel: async () => JSON.stringify({
      mealType: 'dinner',
      summary: '清蒸鲈鱼配糙米饭',
      calories: 510,
      proteinG: 44,
      carbsG: 52,
      fatG: 12
    })
  });

  // Unauthenticated / invalid inputs
  assert.equal((await service.logMealFromBridge('wrong', { text: '米饭' })).status, 401);
  assert.equal((await service.logMealFromBridge(user.syncToken, {})).status, 400);
  const badImg = await service.logMealFromBridge(user.syncToken, {
    imageBase64: Buffer.from('not-an-image').toString('base64')
  });
  assert.equal(badImg.status, 400);

  const tooBig = await service.logMealFromBridge(user.syncToken, {
    imageBase64: Buffer.alloc(3 * 1024 * 1024 + 64, 0xff).toString('base64')
  });
  assert.equal(tooBig.status, 413);

  // Text AI log (DeepSeek/AI 模型估算)
  const textRes = await service.logMealFromBridge(user.syncToken, { mealType: 'auto', text: '塔斯汀鸡肉汉堡+鸡块' });
  assert.equal(textRes.status, 200);
  assert.equal(textRes.body.ok, true);
  assert.equal(textRes.body.source, 'ai_text');
  assert.equal(textRes.body.sourceLabel, 'DeepSeek/AI 模型估算');
  assert.match(textRes.body.notificationText, /DeepSeek\/AI 模型估算/);

  // Image vision log with valid PNG magic bytes
  const tinyPng = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de', 'hex');
  const imgRes = await service.logMealFromBridge(user.syncToken, {
    mealType: 'dinner',
    imageBase64: tinyPng.toString('base64')
  });
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.body.source, 'vision');
  assert.equal(imgRes.body.sourceLabel, '图片识别估算');
  assert.equal(imgRes.body.calories, 510);

  // Ack supports newline-separated string produced by Apple Shortcuts Repeat Results
  const ackRes = service.ackPendingAppleNutrition(user.syncToken, {
    ids: `${textRes.body.id}\n${imgRes.body.id}`
  });
  assert.equal(ackRes.status, 200);
  assert.equal(ackRes.body.acked, 2);
  assert.equal(ackRes.body.remaining, 0);

  // QQ reply also prints DeepSeek/AI 模型估算 instead of vague 文字录入/估算
  const sent = [];
  const cmds = new HealthPlannerCommands(configStore, service, {
    onebot: async (action, params) => { sent.push({ action, params }); return {}; }
  });
  cmds.receive({
    post_type: 'message',
    message_type: 'private',
    self_id: '99999',
    user_id: '40001',
    message_id: 99,
    sender: { nickname: '小李' },
    message: [{ type: 'text', data: { text: '/记一餐 午餐 鸡胸肉沙拉' } }]
  });
  await Promise.all([...cmds.jobs]);
  const replyText = sent.at(-1).params.message.map(s => s.data?.text || '').join('');
  assert.match(replyText, /DeepSeek\/AI 模型估算/);
});

test('HealthPlannerCommands 支持 QQ 直发已签名 iPhone 快捷指令文件并清理临时目录', async t => {
  assert.deepEqual(
    parseHealthCommand({ message: [{ type: 'text', data: { text: '/健康 快捷指令' } }] }),
    { type: 'shortcuts', hasMedia: false }
  );
  assert.deepEqual(
    parseHealthCommand({ message: [{ type: 'text', data: { text: '#健康 shortcut' } }] }),
    { type: 'shortcuts', hasMedia: false }
  );

  const dataDir = makeTempDir(t);
  const configStore = await openStore(dataDir);
  configStore.save({
    enabled: true,
    consolePublicUrl: 'https://bot.example.com',
    allowedGroups: ['20001'],
    allowedPrivateUsers: ['50001']
  });
  const plannerStore = new HealthPlannerStore(dataDir);
  const sent = [];
  const onebot = async (action, params) => {
    sent.push({ action, params });
    return {};
  };
  const service = new HealthPlannerService(plannerStore, configStore, { onebot });
  service.configure({ enabled: true });
  const cmds = new HealthPlannerCommands(configStore, service, {
    onebot,
    dataDir,
    napcatMediaDir: '/app/qqbot-media'
  });

  // 1. 私聊 /健康 同步：直接发送 3 个 .shortcut 文件，并下发可复制的服务器地址与个人 Token
  cmds.receive({
    post_type: 'message',
    message_type: 'private',
    self_id: '99999',
    user_id: '50001',
    message_id: 101,
    sender: { nickname: '小陈' },
    message: [{ type: 'text', data: { text: '/健康 同步' } }]
  });
  await Promise.all([...cmds.jobs]);

  const privateUploads = sent.filter(item => item.action === 'upload_private_file');
  assert.equal(privateUploads.length, 3);
  assert.deepEqual(
    privateUploads.map(item => item.params.name),
    ['桌面一键记一餐.shortcut', '同步Apple健康到Bot.shortcut', 'Bot记餐写回Apple健康.shortcut']
  );
  for (const upload of privateUploads) {
    assert.equal(upload.params.user_id, '50001');
    assert.match(upload.params.file, /^\/app\/qqbot-media\/[0-9a-f-]+\/[^/]+\.shortcut$/);
  }
  assert.deepEqual(readdirSync(join(dataDir, 'media')), []);

  const privateMsgs = sent
    .filter(item => item.action === 'send_private_msg')
    .map(item => item.params.message.map(s => s.data?.text || '').join(''));
  assert.equal(privateMsgs.length, 3);
  assert.match(privateMsgs[0], /服务器地址：https:\/\/bot\.example\.com/);
  assert.match(privateMsgs[0], /个人同步 Token：/);
  const issuedToken = plannerStore.getUser('50001')?.syncToken;
  assert.ok(issuedToken);
  assert.ok(privateMsgs[0].includes(issuedToken));
  assert.equal(privateMsgs[1], 'https://bot.example.com');
  assert.equal(privateMsgs[2], issuedToken);

  // 2. 群聊 /健康 快捷指令：通过 upload_group_file 发送 3 个文件且不泄露个人 Token
  sent.length = 0;
  cmds.receive({
    post_type: 'message',
    message_type: 'group',
    group_id: '20001',
    self_id: '99999',
    user_id: '50002',
    message_id: 102,
    sender: { nickname: '小周' },
    message: [{ type: 'text', data: { text: '/健康 快捷指令' } }]
  });
  await Promise.all([...cmds.jobs]);

  const groupUploads = sent.filter(item => item.action === 'upload_group_file');
  assert.equal(groupUploads.length, 3);
  assert.deepEqual(
    groupUploads.map(item => item.params.name),
    ['桌面一键记一餐.shortcut', '同步Apple健康到Bot.shortcut', 'Bot记餐写回Apple健康.shortcut']
  );
  for (const upload of groupUploads) {
    assert.equal(upload.params.group_id, '20001');
    assert.match(upload.params.file, /^\/app\/qqbot-media\/[0-9a-f-]+\/[^/]+\.shortcut$/);
  }
  assert.deepEqual(readdirSync(join(dataDir, 'media')), []);

  const groupMsgs = sent.filter(item => item.action === 'send_group_msg');
  const groupText = groupMsgs.map(item => item.params.message.map(s => s.data?.text || '').join('')).join('\n');
  assert.ok(!groupText.includes(issuedToken));

  // 3. 符号链接防御：data/media 若为符号链接则拒绝写入
  const symDir = makeTempDir(t);
  const symTarget = makeTempDir(t);
  symlinkSync(symTarget, join(symDir, 'media'));
  const symCmds = new HealthPlannerCommands(configStore, service, {
    onebot,
    dataDir: symDir
  });
  await assert.rejects(
    symCmds.sendShortcutFiles({ user_id: '50001' }, { isGroup: false }),
    /符号链接/
  );
});

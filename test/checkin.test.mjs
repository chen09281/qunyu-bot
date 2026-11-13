import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, symlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, createHmac } from 'node:crypto';
import { Bot } from '../src/bot.mjs';
import { defaultConfig } from '../src/config.mjs';
import { CheckinService, checkinCommand, chinaTime } from '../src/checkin/service.mjs';
import { createCheckinAdapters, parseCredential, sklandSign, miyousheDS } from '../src/checkin/platforms.mjs';
import { CheckinError, requestJSON } from '../src/checkin/http.mjs';
import { devicePayload, sklandDevice } from '../src/checkin/skland-device.mjs';
import { createApplication } from '../src/server.mjs';
import { DocumentGenerator } from '../src/documents.mjs';

const now = Date.parse('2026-10-22T01:10:00Z');
const secret = 'PRIVATE_ACCOUNT_TOKEN_123456';
const json = data => new Response(JSON.stringify(data));
const event = (text, extra = {}) => ({ self_id: 10001, post_type: 'message', message_type: 'group', group_id: 10003,
  user_id: 10002, message_id: 1, message: [{ type: 'text', data: { text } }], ...extra });
function dir(t) { const value = mkdtempSync(join(tmpdir(), 'qqbot-checkin-')); t.after(() => rmSync(value, { recursive: true, force: true })); return value; }
function fixture(t) {
  const dataDir = dir(t), calls = [], executed = [], log = []; let clock = now, id = 0;
  const store = { config: { ...defaultConfig(), enabled: true, allowedGroups: ['10003'], deepseekKey: 'fake' } };
  const bot = new Bot(store);
  const adapters = Object.fromEntries(['skland', 'miyoushe', 'kuro'].map(platform => [platform, {
    async bind(c) { executed.push({ type: 'bind', platform, c }); return c; },
    async run(c) { executed.push({ type: 'run', platform, c }); return [{ label: '测试角色', status: 'success' }]; },
  }]));
  bot.onebot = async (action, params) => {
    calls.push({ action, params });
    if (action === 'get_group_member_info') return { user_id: params.user_id, group_id: params.group_id };
  };
  const options = { now: () => clock, adapters, onebot: (...args) => bot.onebot(...args), log: (...args) => log.push(args) };
  const service = new CheckinService(dataDir, store, options); bot.checkin = service;
  service.configure({ enabled: true }); t.after(() => bot.close());
  return { service, bot, store, calls, executed, dataDir, options, log,
    advance(ms) { clock += ms; },
    async send(text, extra) {
      clock += 3100;
      const accepted = bot.receive(event(text, { message_id: ++id, ...extra }));
      await Promise.all(service.jobs); return accepted;
    },
  };
}

function guideRenderer(f, worker) {
  const rendered = [];
  f.service.documents = new DocumentGenerator(f.dataDir, { napcatMediaDir: '/app/qqbot-media',
    worker: worker || (async input => {
      rendered.push(input);
      writeFileSync(join(input.directory, 'document.pdf'), Buffer.from('%PDF-1.7\ntest-guide'));
      return { files: ['document.pdf'] };
    }),
  });
  return rendered;
}

test('签到帮助在群聊与私聊只发送一张图，不附文字、@ 或文档，不调用 DS', async t => {
  const f = fixture(t), rendered = guideRenderer(f); let images = 0;
  f.service.helpImage = { async create() { images++; return 'base64://TEST_HELP'; }, cancel() {} };
  f.store.config.deepseekKey = ''; f.store.config.documentGenerationEnabled = false;
  await f.send('/签到 帮助');
  await f.send('/签到 帮助', { message_type: 'private', group_id: undefined });
  assert.deepEqual(f.calls.map(c => c.action), ['send_group_msg', 'send_private_msg']);
  assert.equal(f.calls[0].params.group_id, 10003);
  assert.equal(f.calls[1].params.user_id, 10002);
  for (const call of f.calls) assert.deepEqual(call.params.message, [{ type: 'image', data: { file: 'base64://TEST_HELP' } }]);
  assert.equal(rendered.length, 0); assert.equal(f.executed.length, 0); assert.equal(images, 2);
  assert.equal(f.bot.receive(event('/签到 帮助')).ignored, 'duplicate');
});

test('帮助图片失败提示文档指令且不泄露错误；生成中撤销权限或停止后不发图', async t => {
  const f = fixture(t);
  f.service.helpImage = { async create() { throw Error(secret); }, cancel() {} };
  await f.send('/签到 帮助');
  assert.match(JSON.stringify(f.calls), /签到 文档/); assert.doesNotMatch(JSON.stringify([f.calls, f.log]), /PRIVATE_ACCOUNT_TOKEN/);
  for (const change of ['group', 'bot', 'plugin', 'close']) await t.test(change, async t => {
    const f = fixture(t); let finish;
    f.service.helpImage = { create: () => new Promise(resolve => { finish = resolve; }), cancel() {} };
    const work = f.send('/签到 帮助');
    if (change === 'group') f.store.config.allowedGroups = [];
    if (change === 'bot') f.store.config.enabled = false;
    if (change === 'plugin') f.service.configure({ enabled: false });
    if (change === 'close') f.service.close();
    finish('base64://TEST_HELP'); await work;
    assert.equal(f.calls.length, 0);
  });
});

test('签到文档单独上传固定 Word 教程，群聊与私聊分别上传，无需绑定或 DS', async t => {
  const f = fixture(t), rendered = guideRenderer(f), uploaded = [];
  f.store.config.deepseekKey = ''; f.store.config.documentGenerationEnabled = false;
  const original = f.bot.onebot;
  f.bot.onebot = async (action, params, config, timeout) => {
    if (action.startsWith('upload_')) {
      const input = rendered.at(-1);
      assert.ok(existsSync(join(input.directory, 'document.pdf')), '上传期间保留文件');
      assert.equal(params.file, `/app/qqbot-media/${input.directory.split('/').at(-1)}/document.pdf`);
      assert.equal(params.name, '签到账号绑定教程.pdf'); assert.equal(timeout, 120);
      uploaded.push(action);
    }
    return original(action, params);
  };
  await f.send('/签到 文档');
  await f.send('/签到 文档', { message_type: 'private', group_id: undefined });
  assert.deepEqual(f.calls.map(c => c.action), ['upload_group_file', 'upload_private_file']);
  assert.equal(f.calls[0].params.group_id, 10003); assert.equal(f.calls[0].params.user_id, undefined);
  assert.equal(f.calls[1].params.user_id, 10002); assert.equal(f.calls[1].params.group_id, undefined);
  assert.equal(uploaded.length, 2); assert.equal(f.executed.length, 0);
  assert.deepEqual(f.service.state.members, {});
  for (const input of rendered) {
    assert.deepEqual(input.formats, ['pdf']);
    assert.equal(input.content, readFileSync(new URL('../src/checkin/binding-guide.md', import.meta.url), 'utf8').trim());
    assert.equal(existsSync(input.directory), false, '成功后清理文件');
  }
  const duplicate = f.bot.receive(event('/签到 文档'));
  assert.equal(duplicate.ignored, 'duplicate'); assert.equal(rendered.length, 2);
});

test('配置后台外网地址时，签到文档自动替换工具下载链接且不泄露示例域名以外的私有地址', async t => {
  const f = fixture(t), rendered = guideRenderer(f);
  f.store.config.consolePublicUrl = 'https://console.demo.org/';
  await f.send('/签到 文档');
  assert.equal(rendered.length, 1);
  assert.match(rendered[0].content, /https:\/\/console\.demo\.org\/tools\/kuro\//);
  assert.doesNotMatch(rendered[0].content, /https:\/\/bot\.example\.com\/tools\/kuro\//);
});

test('文档生成失败给出提示，不上传或暴露内部错误', async t => {
  const f = fixture(t);
  guideRenderer(f, async () => { throw new Error('/private/path/' + secret); });
  await f.send('/签到 文档');
  assert.deepEqual(f.calls.map(c => c.action), ['send_group_msg']);
  assert.match(JSON.stringify(f.calls[0]), /教程文档暂时无法发送/);
  assert.doesNotMatch(JSON.stringify([f.calls, f.log]), /PRIVATE_ACCOUNT_TOKEN|private\/path/);
});

test('教程上传未确认时提示对应渠道并延迟清理，避免 NapCat 读到已删除文件', async t => {
  for (const message_type of ['group', 'private']) await t.test(message_type, async t => {
    const f = fixture(t), rendered = guideRenderer(f), original = f.bot.onebot;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    f.bot.onebot = async (action, ...args) => {
      if (action.startsWith('upload_')) throw new Error(secret);
      return original(action, ...args);
    };
    await f.send('/签到 文档', { message_type });
    assert.ok(existsSync(rendered[0].directory));
    assert.match(JSON.stringify(f.calls.at(-1)), /教程文档上传未确认成功/);
    assert.match(JSON.stringify(f.calls.at(-1)), message_type === 'group' ? /群文件权限/ : /已加机器人好友/);
    assert.doesNotMatch(JSON.stringify([f.calls, f.log]), /PRIVATE_ACCOUNT_TOKEN/);
    t.mock.timers.tick(300000);
    assert.equal(existsSync(rendered[0].directory), false);
  });
});

test('未授权或暂停时不生成教程，生成中撤销权限或关闭服务后不上传并清理', async t => {
  for (const change of ['group', 'bot', 'plugin', 'close']) await t.test(change, async t => {
    const f = fixture(t); let complete, begun;
    const started = new Promise(resolve => { begun = resolve; });
    let directory;
    guideRenderer(f, input => {
      directory = input.directory; begun();
      return new Promise(resolve => { complete = () => {
        writeFileSync(join(directory, 'document.pdf'), Buffer.from('%PDF-1.7\ntest'));
        resolve({ files: ['document.pdf'] });
      }; });
    });
    const sending = f.send('/签到 文档'); await started;
    if (change === 'group') f.store.config.allowedGroups = [];
    if (change === 'bot') f.store.config.enabled = false;
    if (change === 'plugin') f.service.configure({ enabled: false });
    if (change === 'close') f.service.close();
    complete(); await sending;
    assert.equal(f.calls.some(c => c.action.startsWith('upload_')), false);
    assert.equal(existsSync(directory), false);
  });
  const f = fixture(t), rendered = guideRenderer(f);
  await f.send('/签到 文档', { group_id: 99999 });
  f.service.configure({ enabled: false });
  await f.send('/签到 文档');
  assert.equal(rendered.length, 0);
});

test('每个平台解析凭据，拒绝注入、无效 Cookie，保留 v2 所需字段', () => {
  assert.deepEqual(parseCredential('skland', JSON.stringify({ data: { content: secret } }, null, 2)), { token: secret });
  assert.throws(() => parseCredential('skland', 'https://evil.example/path\nInjected: yes'));
  assert.throws(() => parseCredential('kuro', JSON.stringify({ token: secret, userId: '../10002' })));
  assert.throws(() => parseCredential('miyoushe', 'ltoken=only-ltoken'));
  assert.throws(() => parseCredential('miyoushe', 'cookie_token=abc; account_id=123; stoken=v2_test'));
  const c = parseCredential('miyoushe', 'cookie_token_v2=abc; account_id_v2=123; stoken=v2_test; mid=mid123; unrelated=PRIVATE_OTHER');
  assert.match(c.cookie, /stoken=v2_test/); assert.doesNotMatch(c.cookie, /PRIVATE_OTHER/);
  assert.throws(() => parseCredential('miyoushe', 'cookie_token=abc; account_id=123\nX-Test: abc'));
});

test('森空岛签名使用发送的原始字节与固定头顺序；设备标识不含账号凭据', () => {
  const headers = sklandSign('/api/v1/game/attendance', '{"gameId":"1","uid":"123"}', { dId: 'Bdevice', cred: 'cred', signToken: secret }, now);
  const metadata = '{"platform":"3","timestamp":"1792631400","dId":"Bdevice","vName":"1.0.0"}';
  const expected = createHash('md5').update(createHmac('sha256', secret).update('/api/v1/game/attendance{"gameId":"1","uid":"123"}1792631400' + metadata).digest('hex')).digest('hex');
  assert.equal(headers.sign, expected);
  const payload = devicePayload(now);
  assert.equal(payload.organization, 'UWXspnCCJN4sfYlNfqps'); assert.match(payload.data, /^[a-f0-9]+$/);
  assert.equal(Buffer.from(payload.ep, 'base64').length, 128); assert.ok(payload.data.length > 100);
  assert.equal(JSON.stringify(payload).includes(secret), false);
  const [time, random, sign] = miyousheDS(now, '{"gids":"2"}').split(',');
  assert.equal(sign, createHash('md5').update(`salt=t0qEgfub6cvueAPgR5m9aQWWVciEer7v&t=${time}&r=${random}&b={"gids":"2"}&q=`).digest('hex'));
});

test('森空岛接受标准 Base64 设备标识，设备异常不误报 App 验证', async () => {
  const deviceId = Buffer.from([251, ...Array(63).fill(255)]).toString('base64');
  assert.match(deviceId, /\+/); assert.match(deviceId, /\//); assert.match(deviceId, /==$/);
  for (const value of [deviceId, 'device-id_123']) {
    const actual = await sklandDevice(async () => ({ code: 1100, detail: { deviceId: value } }));
    assert.equal(actual, 'B' + value);
  }
  for (const data of [{ code: 1902 }, { code: 1100 }, { code: 1100, detail: { deviceId: 123 } },
    ...['', 'id\r\nInjected: yes', 'a'.repeat(201), 'not base64', 'bad=id', 'bad==='].map(deviceId => ({ code: 1100, detail: { deviceId } }))]) {
    await assert.rejects(sklandDevice(async () => data), error => error.kind === 'device');
  }
});

test('森空岛 token 登录绑定不签到，执行覆盖方舟及终末地多个角色并识别重复', async () => {
  const calls = [];
  const deviceId = Buffer.from([251, ...Array(63).fill(255)]).toString('base64');
  const request = async (url, options) => {
    calls.push({ url, ...options });
    if (url.includes('deviceprofile')) return { code: 1100, detail: { deviceId } };
    assert.equal(options.headers.dId, 'B' + deviceId, 'Base64 标识原样用于登录和请求签名');
    if (url.includes('/grant')) return { status: 0, data: { code: 'grant-code-123' } };
    if (url.includes('generate_cred')) return { code: 0, data: { cred: 'valid-cred', token: 'valid-sign-token' } };
    if (url.endsWith('/binding')) return { code: 0, data: { list: [
      { appCode: 'arknights', bindingList: [{ gameId: 1, uid: '123', nickName: '博士#1234' }] },
      { appCode: 'endfield', bindingList: [{ nickName: '通行证昵称', roles: [{ roleId: '321', serverId: '1', nickname: '管理员' }, { roleId: '322', serverId: '2' }] }] },
    ] } };
    assert.ok(options.headers.sign); assert.equal(options.method, 'POST');
    return { code: url.includes('/web/') ? 0 : 10001 };
  };
  const adapter = createCheckinAdapters({ request, now: () => now, wait: async () => {} }).skland;
  const c = await adapter.bind({ token: secret });
  assert.equal(c.dId, 'B' + deviceId); assert.equal(c.cred, undefined);
  assert.equal(calls.filter(c => c.url.includes('attendance')).length, 0);
  const result = await adapter.run(c);
  assert.deepEqual(result.map(r => r.status), ['already', 'success', 'success']);
  assert.deepEqual(result.map(r => r.uid), ['123', '321', '322']);
  assert.deepEqual(result.map(r => r.label), ['明日方舟 · 博士#1234', '终末地 · 管理员', '终末地 · 角色 3（未返回昵称）']);
  assert.deepEqual(result.map(r => r.playerName), ['博士#1234', '管理员', undefined]);
  assert.deepEqual(JSON.parse(calls.find(c => c.url.endsWith('/api/v1/game/attendance')).body), { gameId: '1', uid: '123' });
  const endfield = calls.filter(c => c.url.includes('/web/v1/game/endfield/attendance'));
  assert.equal(endfield.length, 2); assert.equal(endfield[0].body, undefined); assert.equal(endfield[1].headers['sk-game-role'], '3_322_2');
  assert.equal(calls.filter(c => c.url.includes('deviceprofile')).length, 1);
  assert.equal(JSON.stringify(calls[0]).includes(secret), false);
});

test('米游社逐角色检查、验证码不冒充成功、绝区零独立端点、社区仅签到', async () => {
  const urls = [], cookie = 'cookie_token=abc; account_id=123; stoken=v2_abcd; mid=abcd';
  const request = async (url, options) => {
    urls.push(url); assert.equal(options.headers.Cookie, cookie);
    if (url.includes('getUserGameRoles')) return { retcode: 0, data: { list: [
      { game_biz: 'hk4e_cn', region: 'cn_gf01', game_uid: '123', nickname: '旅行者' },
      { game_biz: 'hkrpg_cn', region: 'prod_gf_cn', game_uid: '234', nickname: '开拓者🚂' },
      { game_biz: 'nap_cn', region: 'prod_gf_cn', game_uid: '345', nickname: '绳匠' },
    ] } };
    if (url.includes('/info')) return { retcode: 0, data: { is_sign: url.includes('uid=123') } };
    if (url.includes('bbs-api')) return { retcode: 0 };
    if (url.includes('act-nap-api')) { assert.equal(options.headers['x-rpc-signgame'], 'zzz'); return { retcode: 0, data: { success: 0 } }; }
    return { retcode: 0, data: { success: 1, challenge: 'PRIVATE_UPSTREAM' } };
  };
  const adapter = createCheckinAdapters({ request, wait: async () => {} }).miyoushe;
  await adapter.bind({ cookie }); const result = await adapter.run({ cookie });
  assert.deepEqual(result.map(r => r.status), ['already', 'verification', 'success', 'success', 'success', 'success']);
  assert.deepEqual(result.map(r => r.uid), ['123', '234', '345', undefined, undefined, undefined]);
  assert.deepEqual(result.slice(0, 3).map(r => r.label), ['原神 · 旅行者', '崩坏：星穹铁道 · 开拓者🚂', '绝区零 · 绳匠']);
  assert.deepEqual(result.slice(0, 3).map(r => r.playerName), ['旅行者', '开拓者🚂', '绳匠']);
  assert.equal(JSON.stringify(result).includes('PRIVATE_UPSTREAM'), false);
  assert.equal(urls.some(u => /upvote|share|comment|verifyVerification/.test(u)), false);
  const noStoken = createCheckinAdapters({ wait: async () => {}, request: async () => ({ retcode: 0, data: { list: [] } }) }).miyoushe;
  assert.deepEqual((await noStoken.run({ cookie: 'cookie_token=abc; account_id=123' })).map(r => r.status), ['empty', 'missing']);
});

test('库街区游戏和社区分别签到，登录失效与 code 220 风控区分', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/mine')) return { code: 200, data: { mine: { userId: '12345' } } };
    if (url.endsWith('/role/list')) return { code: 200, data: [{ serverId: 'server123', roleId: '456', roleName: options.body === 'gameId=2' ? '指挥官' : '漂泊者', userName: '社区昵称' }] };
    if (url.endsWith('/info')) return { code: 200, data: { hasSignIn: options.body === 'gameId=2' } };
    if (url.endsWith('/initSignInV2')) return { code: 200, data: { isSigIn: false } };
    return { code: 200, data: {} };
  };
  const adapter = createCheckinAdapters({ request, now: () => now, wait: async () => {} }).kuro;
  const c = await adapter.bind(parseCredential('kuro', secret)); assert.equal(c.userId, '12345');
  const results = await adapter.run(c);
  assert.deepEqual(results.map(r => r.status), ['already', 'success', 'success', 'success']);
  assert.deepEqual(results.map(r => r.uid), [undefined, '456', undefined, '456']);
  assert.deepEqual(results.map(r => r.playerName), [undefined, '指挥官', undefined, '漂泊者']);
  assert.deepEqual(results.filter(r => r.playerName).map(r => r.label), ['战双帕弥什 · 指挥官', '鸣潮 · 漂泊者']);
  assert.doesNotMatch(JSON.stringify(results), /社区昵称/);
  assert.ok(results.every(r => r.uid !== c.userId), '社区用户 ID 不当作游戏 UID');
  const signs = calls.filter(c => c.url.endsWith('/signIn/v2'));
  assert.equal(signs.length, 2); assert.match(signs[0].body, /reqMonth=10/); assert.match(signs[0].body, /userId=12345/);
  const risk = createCheckinAdapters({ request: async () => ({ code: 220, success: 1, msg: secret }), wait: async () => {} }).kuro;
  assert.ok((await risk.run(c)).every(r => r.status === 'verification'));
  const expired = createCheckinAdapters({ request: async () => ({ code: 220, msg: secret }), wait: async () => {} }).kuro;
  await assert.rejects(expired.bind(c), error => error.kind === 'expired');
});

test('网络客户端限定 HTTPS 域名、禁止重定向、限制响应并脱敏异常', async t => {
  let calls = 0;
  const mocked = t.mock.method(globalThis, 'fetch', async (_url, options) => { calls++; assert.equal(options.redirect, 'error'); return json({ code: 0 }); });
  await assert.rejects(requestJSON('https://evil.example/'), CheckinError);
  await assert.rejects(requestJSON('http://api.kurobbs.com/'), CheckinError); assert.equal(calls, 0);
  assert.deepEqual(await requestJSON('https://api.kurobbs.com/'), { code: 0 });
  mocked.mock.mockImplementation(async () => { throw new Error(secret); });
  await assert.rejects(requestJSON('https://api.kurobbs.com/'), error => error.kind === 'network' && !error.message.includes(secret));
  mocked.mock.mockImplementation(async () => new Response('x'.repeat(1024 * 1024 + 1)));
  await assert.rejects(requestJSON('https://api.kurobbs.com/'), CheckinError);
});

test('群内凭据不进入 DS/日志；私聊须开通且重新核验群成员，账号按 QQ 隔离', async t => {
  const f = fixture(t); let models = 0;
  f.bot.completion = async () => { models++; return { text: 'wrong', tokens: 0 }; };
  await f.send(`/签到 绑定 森空岛 ${secret}`);
  assert.equal(f.executed.length, 0); assert.equal(models, 0); assert.equal(JSON.stringify(f.bot.status()).includes(secret), false);
  await f.send(`/签到 绑定 森空岛 ${secret}`, { message_type: 'private' }); assert.equal(f.executed.length, 0);
  await f.send('/签到 开通');
  await f.send(`/签到 绑定 森空岛 ${secret}`, { message_type: 'private' });
  assert.equal(f.executed.length, 1); assert.equal(f.service.state.members['10002'].accounts.skland.credential.token, secret);
  assert.ok(f.calls.some(c => c.action === 'get_group_member_info' && c.params.no_cache));
  await f.send('/签到 开通', { user_id: 10004 });
  await f.send(`/签到 绑定 库街区 OTHER_TOKEN_123`, { user_id: 10004, message_type: 'private' });
  await f.send('/签到 解绑 全部', { user_id: 10004, message_type: 'private' });
  assert.ok(f.service.state.members['10002'].accounts.skland); assert.equal(f.service.state.members['10004'], undefined);
  assert.equal(JSON.stringify([f.calls, f.service.status(), f.bot.status(), f.log]).includes(secret), false);
  f.store.config.enabled = false;
  await f.send('/签到 解绑 全部', { message_type: 'private' }); assert.equal(f.service.state.members['10002'], undefined);
});

test('重复事件/并发绑定只执行一次，群不在白名单、错误 self_id 都不能开通', async t => {
  const f = fixture(t);
  await f.send('/签到 开通', { group_id: 99999 }); await f.send('/签到 开通', { self_id: 10002 });
  assert.equal(Object.keys(f.service.state.members).length, 0);
  await f.send('/签到 开通');
  const e = event(`/签到 绑定 森空岛 ${secret}`, { message_id: 100, message_type: 'private' });
  f.advance(4000);
  assert.equal(f.bot.receive(e).accepted, true); assert.equal(f.bot.receive(e).ignored, 'duplicate');
  await Promise.all(f.service.jobs); assert.equal(f.executed.length, 1);
  assert.equal(checkinCommand(event('/签到绑定 森空岛 x')), '绑定 森空岛 x');
  assert.equal(checkinCommand(event('今天的签到活动如何设计')), null);
});

test('加密存储、0600 权限、重启恢复、错误密钥不会重置凭据', async t => {
  const f = fixture(t); await f.send('/签到 开通'); await f.send(`/签到 绑定 森空岛 ${secret}`, { message_type: 'private' });
  const path = join(f.dataDir, 'checkin/accounts.enc'), key = join(f.dataDir, 'checkin/key');
  assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(key).mode & 0o777, 0o600);
  assert.equal(readFileSync(path).includes(Buffer.from(secret)), false);
  const restored = new CheckinService(f.dataDir, f.store, f.options); t.after(() => restored.close());
  assert.equal(restored.state.members['10002'].accounts.skland.credential.token, secret);
  writeFileSync(key, Buffer.alloc(32)); assert.throws(() => new CheckinService(f.dataDir, f.store, f.options), /无法解密/);
});

test('拒绝签到目录/密钥符号链接；重新绑定失败保留旧凭据且不泄露上游错误', async t => {
  const dataDir = dir(t), target = join(dataDir, 'target'); mkdirSync(target);
  symlinkSync(target, join(dataDir, 'checkin'));
  assert.throws(() => new CheckinService(dataDir, {}), /符号链接/);
  rmSync(join(dataDir, 'checkin')); mkdirSync(join(dataDir, 'checkin'));
  writeFileSync(join(target, 'secret'), 'KEEP'); symlinkSync(join(target, 'secret'), join(dataDir, 'checkin/key'));
  assert.throws(() => new CheckinService(dataDir, {}), /符号链接/); assert.equal(readFileSync(join(target, 'secret'), 'utf8'), 'KEEP');
  const f = fixture(t); await f.send('/签到 开通'); await f.send(`/签到 绑定 森空岛 ${secret}`, { message_type: 'private' });
  f.options.adapters.skland.bind = async () => { throw new Error('UPSTREAM_PRIVATE_SECRET'); };
  await f.send('/签到 绑定 森空岛 REPLACEMENT_PRIVATE', { message_type: 'private' });
  assert.equal(f.service.state.members['10002'].accounts.skland.credential.token, secret);
  assert.equal(JSON.stringify([f.calls, f.log, f.service.status()]).includes('UPSTREAM_PRIVATE_SECRET'), false);
});

test('北京时间计划、停用/白名单/退群、同日重启不重签、次日继续', async t => {
  const f = fixture(t); await f.send('/签到 开通'); await f.send(`/签到 绑定 森空岛 ${secret}`, { message_type: 'private' });
  f.service.configure({ time: '10:00' }); await f.service.tick(); assert.equal(f.executed.filter(e => e.type === 'run').length, 0);
  f.service.configure({ time: '09:05', enabled: false }); await f.service.tick(); assert.equal(f.executed.filter(e => e.type === 'run').length, 0);
  f.service.configure({ enabled: true });
  f.store.config.allowedGroups = []; await f.service.tick(); assert.equal(f.executed.filter(e => e.type === 'run').length, 0);
  f.store.config.allowedGroups = ['10003'];
  const onebot = f.bot.onebot; f.bot.onebot = async () => ({ user_id: 'wrong' });
  await f.service.tick(); assert.equal(f.executed.filter(e => e.type === 'run').length, 0); f.bot.onebot = onebot;
  await f.service.tick(); await f.service.tick(); assert.equal(f.executed.filter(e => e.type === 'run').length, 1);
  assert.ok(f.calls.some(c => c.action === 'send_private_msg' && JSON.stringify(c.params).includes('每日签到结果')));
  const restored = new CheckinService(f.dataDir, f.store, f.options); t.after(() => restored.close());
  await restored.tick(); assert.equal(f.executed.filter(e => e.type === 'run').length, 1);
  assert.equal(chinaTime(Date.parse('2026-10-22T16:00:00Z')).slice(0, 10), '2026-10-23');
  f.advance(86400000); await restored.tick(); assert.equal(f.executed.filter(e => e.type === 'run').length, 2);
});

test('失败可手动重试；登录失效只暂停该账号；取消后不再签到下一平台', async t => {
  const f = fixture(t); await f.send('/签到 开通'); await f.send(`/签到 绑定 森空岛 ${secret}`, { message_type: 'private' });
  let count = 0;
  f.options.adapters.skland.run = async () => { count++; throw new CheckinError('network'); };
  await f.service.tick(); await f.service.tick(); assert.equal(count, 1);
  await f.send('/签到'); assert.equal(count, 1);
  f.advance(60000); await f.send('/签到'); assert.equal(count, 2);
  f.options.adapters.skland.run = async () => { count++; throw new CheckinError('expired'); };
  f.advance(60000); await f.send('/签到'); assert.equal(f.service.state.members['10002'].accounts.skland.needsLogin, true);
  f.advance(86400000); await f.service.tick(); assert.equal(count, 3);
  await f.send(`/签到 绑定 森空岛 ${secret}`, { message_type: 'private' });
  await f.send('/签到 绑定 库街区 OTHER_TOKEN_123', { message_type: 'private' });
  let started;
  const ready = new Promise(resolve => started = resolve);
  f.options.adapters.skland.run = (_c, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new CheckinError('cancelled')), { once: true }); started(); });
  const pending = f.service.tick(); await ready; f.service.configure({ enabled: false }); await pending;
  assert.equal(f.executed.some(e => e.type === 'run' && e.platform === 'kuro'), false);
  assert.equal(f.service.state.members['10002'].accounts.skland.last.items[0].status, 'cancelled');
});

test('签到后台 API 需要管理员登录及同源校验，配置校验无凭据回显', async t => {
  const app = await createApplication({ dataDir: dir(t), initialPassword: 'test-password-123', bilibiliAutoStart: false, douyinAutoStart: false, checkinAutoStart: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(url + '/api/checkin')).status, 401);
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  const login = await fetch(url + '/api/login', { method: 'POST', headers, body: JSON.stringify({ username: app.store.admin.username, password: 'test-password-123' }) });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(url + '/api/checkin', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: headers.Cookie }, body: '{}' })).status, 403);
  assert.equal((await fetch(url + '/api/checkin', { method: 'PUT', headers, body: '{"time":"25:70"}' })).status, 400);
  const response = await fetch(url + '/api/checkin', { method: 'PUT', headers, body: '{"enabled":true,"time":"08:30"}' });
  assert.equal(response.status, 200); assert.equal((await response.json()).settings.time, '08:30');
  app.checkin.state.members['10002'] = { group: '10003', auto: true, accounts: { skland: { credential: { token: secret } } } };
  const status = await (await fetch(url + '/api/checkin', { headers })).text();
  assert.equal(status.includes(secret), false); assert.equal(status.includes('credential'), false);
});

test('手动签到、当天缓存、状态、自动私聊显示游戏昵称，不回显 UID，重启兼容旧记录', async t => {
  const f = fixture(t);
  await f.send('/签到 开通'); await f.send(`/签到 绑定 森空岛 ${secret}`, { message_type: 'private' });
  let count = 0;
  f.options.adapters.skland.run = async () => {
    count++;
    return [{label:'明日方舟 · 博士#1234',playerName:'博士#1234',uid:'123456789',status:'success'},
      {label:'终末地 · 管理员',playerName:'管理员',uid:'987654321',status:'already'},
      {label:'旧角色',uid:'333333333',status:'success'}];
  };
  await f.send('/签到');
  const lastText = () => JSON.stringify(f.calls.at(-1));
  assert.match(lastText(), /明日方舟 · 博士#1234：签到成功/);
  assert.match(lastText(), /终末地 · 管理员：今日已签到/);
  assert.match(lastText(), /旧角色：签到成功/);
  const noUid = () => assert.doesNotMatch(lastText(), /UID|123456789|987654321|333333333/);
  noUid();
  await f.send('/签到'); assert.equal(count, 1);
  assert.match(lastText(), /保存结果/); assert.match(lastText(), /博士#1234/); noUid();
  await f.send('/签到 状态'); assert.match(lastText(), /管理员/); noUid();
  const restarted = new CheckinService(f.dataDir, f.store, f.options); t.after(() => restarted.close());
  const saved = await restarted.runMember('10002', false); assert.match(saved, /博士#1234/); assert.doesNotMatch(saved, /UID|123456789|987654321|333333333/); assert.equal(count, 1);
  f.advance(86400000); await f.service.tick(); assert.equal(count, 2);
  assert.match(lastText(), /每日签到结果/); assert.match(lastText(), /博士#1234/); noUid();
  // Legacy records may have neither name nor UID; never repeat the sign-in just to refresh them.
  f.service.state.members['10002'].accounts.skland.last.items[0].label = '明日方舟 · 角色 1';
  delete f.service.state.members['10002'].accounts.skland.last.items[0].playerName;
  delete f.service.state.members['10002'].accounts.skland.last.items[0].uid;
  await f.send('/签到'); assert.equal(count, 2); assert.match(lastText(), /明日方舟 · 角色 1：签到成功/); noUid();
});

test('异常角色 ID 不持久化，其他角色的实际编号仍可用于签到', async () => {
  const adapter = createCheckinAdapters({wait:async()=>{},request:async url => {
    if(url.includes('getUserGameRoles'))return {retcode:0,data:{list:[
      {game_biz:'hk4e_cn',region:'cn_gf01',game_uid:'123\nPRIVATE_UPSTREAM'},
      {game_biz:'hk4e_cn',region:'cn_gf01',game_uid:'112233445'},
    ]}};
    return {retcode:0,data:{is_sign:true}};
  }}).miyoushe;
  const results = await adapter.run({cookie:'cookie_token=abc; account_id=123'});
  assert.equal(results[0].status,'failed'); assert.equal(results[0].uid,undefined);
  assert.equal(results[1].uid,'112233445'); assert.equal(results[1].status,'already');
  assert.doesNotMatch(JSON.stringify(results), /PRIVATE_UPSTREAM/);
});

test('游戏昵称支持 Unicode 和首尾空格，缺失或异常昵称不阻止签到、不冒充社区名', async () => {
  const names = ['  小团子🌸  ', undefined, null, 123, ' ', 'x'.repeat(101), '秘密\nPRIVATE_UPSTREAM', '秘密\u202ePRIVATE_UPSTREAM'];
  const adapter = createCheckinAdapters({ wait: async () => {}, request: async url => {
    if (url.includes('getUserGameRoles')) return { retcode: 0, data: { list: names.map((nickname, index) => ({
      game_biz: 'hk4e_cn', region: 'cn_gf01', game_uid: String(100 + index), nickname, userName: '社区名',
    })) } };
    return { retcode: 0, data: { is_sign: true } };
  } }).miyoushe;
  const results = (await adapter.run({ cookie: 'cookie_token=abc; account_id=123' })).slice(0, names.length);
  assert.equal(results[0].label, '原神 · 小团子🌸'); assert.equal(results[0].playerName, '小团子🌸');
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 'already'); assert.equal(result.uid, String(100 + index));
    if (index) { assert.equal(result.playerName, undefined); assert.match(result.label, /未返回昵称/); }
  }
  assert.doesNotMatch(JSON.stringify(results), /PRIVATE_UPSTREAM|社区名/);
});

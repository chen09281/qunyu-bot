import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/server.mjs';
import { prepareNapcat } from '../src/prepare-napcat.mjs';
import { openStore, verifyPassword } from '../src/config.mjs';

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)); });
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-napcat-'));
  const state = { online: false, phase: 'qrcode', failWeb: false, authError: false, twoFactor: false, forceUnauthorized: false, failOnebot: false,
    qrcode: 'https://txz.qq.com/p?k=test-only-login-code', credential: 'server-only-napcat-credential', authCalls: 0, statusCalls: 0, getQrCalls: 0, refreshCalls: 0, offlineFlag: true };
  const mock = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    res.setHeader('Content-Type', 'application/json');
    const send = value => { res.end(JSON.stringify(value)); };
    if (req.url === '/get_status' || req.url === '/get_login_info') {
      if (state.failOnebot) { res.writeHead(503); return send({}); }
      return send({ status: 'ok', retcode: 0, data: req.url === '/get_status' ? { online: state.online, good: true } : { user_id: 123456789, nickname: '测试 QQ' } });
    }
    if (state.failWeb) {
      if (state.pendingRestartDowntime > 0 && --state.pendingRestartDowntime === 0) state.failWeb = false;
      res.writeHead(503); return send({});
    }
    if (req.url === '/api/auth/login') {
      state.authCalls++;
      if (state.authError || input.hash !== createHash('sha256').update('test-webui-token.napcat').digest('hex')) return send({ code: -1, message: 'token is invalid SECRET_RAW_ERROR' });
      if (state.twoFactor && input.totpCode !== '123456') return send({ code: 0, data: { require2FA: true } });
      return send({ code: 0, data: { Credential: state.credential } });
    }
    if (req.headers.authorization !== `Bearer ${state.credential}` || state.forceUnauthorized) {
      state.forceUnauthorized = false; return send({ code: -1, message: 'Unauthorized' });
    }
    if (req.url === '/api/QQLogin/CheckLoginStatus') {
      state.statusCalls++;
      return send({ code: 0, data: { isLogin: state.online, isOffline: state.phase === 'offline' && state.offlineFlag, loginPhase: state.phase, qrcodeurl: state.qrcode } });
    }
    if (req.url === '/api/QQLogin/GetQQLoginInfo') return send({ code: 0, data: { uin: '123456789', nick: 'WebUI QQ' } });
    if (req.url === '/api/QQLogin/GetQQLoginQrcode') {
      state.getQrCalls++;
      if (state.getQrError) return send({ code: -1, message: 'QRCode Get Error: 尚未生成登录二维码' });
      return send({ code: 0, data: { qrcode: state.emptyInitialQr ? '' : state.qrcode } });
    }
    if (req.url === '/api/QQLogin/RefreshQRcode') {
      state.refreshCalls++;
      if (state.refreshDelay) await new Promise(resolve => setTimeout(resolve, state.refreshDelay));
      if (state.refreshError) return send({ code: -1, message: 'QRCode Refresh Error: 二维码刷新超时：QQ 登录服务未返回新的二维码' });
      if (state.emptyInitialQr) state.emptyInitialQr = false;
      if (state.refreshOnlyTriggers) return send({ code: 0, data: {} });
      return send({ code: 0, data: { qrcode: '', qrcodeurl: state.qrcode } });
    }
    if (req.url === '/api/QQLogin/SetQuickLoginQQ') {
      state.quickLoginCalls = (state.quickLoginCalls || 0) + 1;
      state.quickLoginUin = input.uin;
      return send({ code: 0, data: null });
    }
    if (req.url === '/api/QQLogin/RestartNapCat') {
      state.restartCalls = (state.restartCalls || 0) + 1;
      // 模拟重启后登录服务恢复：可先经历若干次连接失败再重新生成二维码。
      if (state.restartDowntimePolls > 0) {
        state.failWeb = true;
        state.pendingRestartDowntime = state.restartDowntimePolls;
      }
      if (state.logoutClearsOnline) state.online = false;
      state.getQrError = false; state.refreshError = false; state.phase = 'waiting_qrcode';
      return send({ code: 0, data: { message: '进程重启请求已发送' } });
    }
    res.writeHead(404); send({});
  });
  const upstream = await listen(mock);
  const app = await createApplication({ dataDir: dir, initialPassword: 'test1234', ...options });
  app.store.save({ napcatUrl: upstream, napcatToken: 'test-webui-token', onebotUrl: upstream });
  const url = await listen(app.server);
  t.after(async () => { app.bot.close(); await close(app.server); await close(mock); await rm(dir, { recursive: true, force: true }); });
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  const login = await fetch(`${url}/api/login`, { method: 'POST', headers, body: JSON.stringify({ username: 'admin', password: 'test1234' }) });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (route, data) => {
    const response = await fetch(url + '/api/' + route, { headers, method: data === undefined ? 'GET' : 'POST', body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  return { app, state, api, url };
}

test('NapCat 登录状态、凭据复用、缓存、掉线和二维码完整链路', async t => {
  const { app, state, api, url } = await fixture(t);
  assert.equal((await fetch(url + '/api/napcat/status')).status, 401);
  assert.equal((await fetch(url + '/api/napcat/qrcode', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }, body: '{}' })).status, 401);
  const first = await api('napcat/status');
  assert.equal(first.data.qq.state, 'waiting_scan'); assert.equal(first.data.webui.authenticated, true);
  assert.equal(first.data.account.userId, '123456789'); assert.equal(state.authCalls, 1);
  await api('napcat/status'); assert.equal(state.statusCalls, 1);
  const serialized = JSON.stringify(first.data);
  assert.equal(serialized.includes(state.credential), false); assert.equal(serialized.includes('test-webui-token'), false); assert.equal(serialized.includes('test-only-login-code'), false);
  const qr = await api('napcat/qrcode', {}); assert.equal(qr.status, 200); assert.equal(qr.data.url, state.qrcode);
  await api('napcat/qrcode', { refresh: true }); assert.equal(state.refreshCalls, 1);
  state.phase = 'qrcode_scanned'; assert.equal((await api('napcat/refresh', {})).data.qq.state, 'scanned');
  state.phase = 'initializing'; assert.equal((await api('napcat/refresh', {})).data.qq.state, 'initializing');
  state.phase = 'generating_qrcode'; assert.equal((await api('napcat/refresh', {})).data.qq.label, '正在生成二维码');
  state.phase = 'waiting_qrcode';
  const waiting = (await api('napcat/refresh', {})).data.qq; assert.equal(waiting.state, 'waiting_scan'); assert.equal(waiting.label, '等待扫码');
  state.online = true; state.phase = 'online';
  const online = await api('napcat/refresh', {}); assert.equal(online.data.qq.state, 'online'); assert.equal(online.data.account.nickname, '测试 QQ');
  assert.equal((await api('napcat/qrcode', { refresh: true })).status, 502);
  state.online = false; state.phase = 'offline';
  const offline = (await api('napcat/refresh', {})).data.qq;
  assert.equal(offline.state, 'offline'); // Cached account details do not imply online.
  assert.equal(offline.label, 'QQ 登录已失效'); assert.match(offline.detail, /获取新二维码/);
  state.offlineFlag = false;
  const phaseOnly = (await api('napcat/refresh', {})).data.qq;
  assert.equal(phaseOnly.state, 'offline'); assert.equal(phaseOnly.label, 'QQ 登录已失效'); assert.match(phaseOnly.detail, /重新扫码/);
  app.napcat.context().expiresAt = 0; await api('napcat/refresh', {}); assert.equal(state.authCalls, 2);
  state.forceUnauthorized = true; await api('napcat/refresh', {}); assert.equal(state.authCalls, 3);
  const config = (await api('config')).data;
  assert.equal(config.napcatToken, undefined); assert.equal(config.napcatTokenConfigured, true);
  state.qrcode = 'javascript:alert(1)'; assert.equal((await api('napcat/qrcode', { refresh: true })).status, 502);
});

test('管理鉴权失败时退避，接口不可达时不误报在线，OneBot 可独立报告 QQ 在线', async t => {
  const { app, state, api } = await fixture(t);
  state.authError = true;
  const results = await Promise.all([api('napcat/refresh', {}), api('napcat/refresh', {}), api('napcat/refresh', {})]);
  assert.equal(state.authCalls, 1);
  assert.equal(results[0].data.webui.authenticated, false);
  assert.equal(JSON.stringify(results).includes('SECRET_RAW_ERROR'), false);
  await api('napcat/refresh', {}); assert.equal(state.authCalls, 1);
  state.online = true;
  assert.equal((await api('napcat/refresh', {})).data.qq.state, 'online');
  state.failOnebot = true;
  assert.equal((await api('napcat/refresh', {})).data.qq.state, 'unknown');
  state.authError = false; state.failWeb = true;
  app.napcat.current = null;
  const failed = await api('napcat/refresh', {});
  assert.equal(failed.data.webui.reachable, false); assert.equal(failed.data.qq.state, 'unknown');
  // 临时连接失败不触发 60 秒退避，NapCat 恢复后下一次探测立即重连成功。
  state.failWeb = false; state.online = false;
  const recoveredConn = await api('napcat/refresh', {});
  assert.equal(recoveredConn.data.webui.authenticated, true);
  assert.equal(recoveredConn.data.qq.state, 'waiting_scan');
});

test('二维码获取与刷新回退、慢刷新及真实失败处理', async t => {
  const { app, state, api } = await fixture(t);
  state.getQrError = true;
  const fallbackFromError = await api('napcat/qrcode', { refresh: false });
  assert.equal(fallbackFromError.status, 200); assert.equal(fallbackFromError.data.url, state.qrcode);
  assert.equal(state.refreshCalls, 1);

  state.getQrError = false; state.emptyInitialQr = true; state.refreshOnlyTriggers = true;
  app.napcat.context().qr = null;
  const fallbackFromEmpty = await api('napcat/qrcode', { refresh: false });
  assert.equal(fallbackFromEmpty.status, 200); assert.equal(fallbackFromEmpty.data.url, state.qrcode);
  assert.equal(state.refreshCalls, 2);
  state.refreshOnlyTriggers = false;

  state.refreshDelay = 6500;
  const slow = await api('napcat/qrcode', { refresh: true });
  assert.equal(slow.status, 200); assert.equal(slow.data.url, state.qrcode);
  state.refreshDelay = 0; state.refreshError = true;
  const getCallsBeforeFallback = state.getQrCalls;
  const recovered = await api('napcat/qrcode', { refresh: true });
  assert.equal(recovered.status, 200); assert.equal(recovered.data.url, state.qrcode);
  assert.equal(state.getQrCalls, getCallsBeforeFallback + 1);
  state.getQrError = true;
  const stuck = await api('napcat/qrcode', { refresh: true });
  assert.equal(stuck.status, 502);
  assert.equal(state.getQrCalls, getCallsBeforeFallback + 2);
  assert.doesNotMatch(stuck.data.error, /无法连接/);
  assert.match(stuck.data.error, /暂未生成二维码|重启 NapCat/);
  // 刷新接口超时（NapCat 内部等待 10 秒无结果）说明登录服务已失效；未挂载 QQ 数据目录时不做自动恢复，只给出原因。
  assert.match(stuck.data.error, /无法生成二维码/);
  assert.match(stuck.data.error, /自动重置|data\/napcat\/qq/);
});

test('登录服务卡死时自动备份清空缓存并重启，冷却期内不重复恢复', async t => {
  const { app, state, api } = await fixture(t, { napcatOptions: { recoveryWaitMs: 6000, recoveryPollMs: 200, recoveryCooldownMs: 600000 } });
  const qqDir = app.napcat.qqDataDir;
  await mkdir(join(qqDir, 'nt_qq'), { recursive: true });
  await writeFile(join(qqDir, 'nt_qq', 'stale.db'), 'stale-session');
  state.getQrError = true; state.refreshError = true;
  const recovered = await api('napcat/qrcode', { refresh: true });
  assert.equal(recovered.status, 200); assert.equal(recovered.data.url, state.qrcode);
  assert.equal(state.restartCalls, 1);
  const backups = (await readdir(join(qqDir, '..'))).filter(name => name.startsWith('qq.auto-'));
  assert.equal(backups.length, 1);
  assert.equal((await readdir(qqDir)).length, 0);
  assert.equal(await readFile(join(qqDir, '..', backups[0], 'nt_qq', 'stale.db'), 'utf8'), 'stale-session');
  // 冷却期内再次卡死时不再自动清缓存，避免反复重启把 QQ 数据目录刷爆。
  state.getQrError = true; state.refreshError = true; app.napcat.context().qr = null;
  const again = await api('napcat/qrcode', { refresh: true });
  assert.equal(again.status, 502); assert.match(again.data.error, /无法生成二维码/);
  assert.doesNotMatch(again.data.error, /正在自动重置/);
  assert.equal(state.restartCalls, 1);
});

test('重启恢复期间短暂断连不锁定 60 秒，并发状态/扫码请求不报错并快速恢复', async t => {
  const { app, state, api } = await fixture(t, { napcatOptions: { recoveryWaitMs: 6000, recoveryPollMs: 120, recoveryCooldownMs: 600000 } });
  const qqDir = app.napcat.qqDataDir;
  await mkdir(join(qqDir, 'nt_qq'), { recursive: true });
  await writeFile(join(qqDir, 'nt_qq', 'stale.db'), 'stale-session');
  // 模拟真实重启过程：RestartNapCat 后管理接口短暂返回 503/断连（消耗 3 次请求），随后恢复服务。
  state.restartDowntimePolls = 3;
  state.getQrError = true; state.refreshError = true;

  const firstReq = api('napcat/qrcode', { refresh: true });
  // 等待自动恢复进入 RestartNapCat 断连窗口，再发并发 status 和第二次 qrcode 请求。
  while (!app.napcat.context().recovering) await new Promise(r => setTimeout(r, 20));
  const duringStatus = await api('napcat/refresh', {});
  assert.equal(duringStatus.status, 200);
  if (duringStatus.data.webui.recovering) {
    assert.equal(duringStatus.data.qq.state, 'reconnecting');
    assert.match(duringStatus.data.qq.label, /重置登录服务/);
  }
  const secondReq = api('napcat/qrcode', { refresh: false });
  const [r1, r2] = await Promise.all([firstReq, secondReq]);
  assert.equal(r1.status, 200); assert.equal(r1.data.url, state.qrcode);
  assert.equal(r2.status, 200); assert.equal(r2.data.url, state.qrcode);
  assert.equal(state.restartCalls, 1);

  const afterStatus = await api('napcat/status');
  assert.equal(afterStatus.data.webui.authenticated, true);
  assert.equal(afterStatus.data.qq.state, 'waiting_scan');
});

test('刷新二维码 HTTP 请求本身超时同样触发自动清缓存与重启恢复', async t => {
  const { app, state, api } = await fixture(t, { napcatOptions: { recoveryWaitMs: 6000, recoveryPollMs: 120, recoveryCooldownMs: 600000 } });
  const qqDir = app.napcat.qqDataDir;
  await mkdir(join(qqDir, 'nt_qq'), { recursive: true });
  await writeFile(join(qqDir, 'nt_qq', 'stale.db'), 'stale-session');

  const originalRequest = app.bot.request.bind(app.bot);
  let timeoutOnce = true;
  app.bot.request = async (url, body, auth, timeout, method, options) => {
    if (timeoutOnce && url.endsWith('/api/QQLogin/RefreshQRcode')) {
      timeoutOnce = false;
      throw new Error('上游请求超时');
    }
    return originalRequest(url, body, auth, timeout, method, options);
  };
  state.getQrError = true;
  const recovered = await api('napcat/qrcode', { refresh: true });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.url, state.qrcode);
  assert.equal(state.restartCalls, 1);
});

test('NapCat 二次验证不自动绕过，验证码只用于当前管理会话', async t => {  const { state, api, app } = await fixture(t);
  state.twoFactor = true;
  assert.equal((await api('napcat/refresh', {})).data.webui.requires2FA, true);
  await api('napcat/refresh', {}); assert.equal(state.authCalls, 1);
  assert.equal((await api('napcat/connect', { totpCode: '12345' })).status, 400);
  const connected = await api('napcat/connect', { totpCode: '123456' });
  assert.equal(connected.status, 200); assert.equal(connected.data.webui.authenticated, true);
  assert.equal(JSON.stringify(app.store.config).includes('123456"'), false);
});

test('一体化部署复用原密码与密钥、配对双向 HTTP，重复准备保持幂等', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-deploy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const initial = await openStore(dir, 'test1234');
  initial.save({ deepseekKey: 'existing-key', allowedGroups: ['123456789'] });
  const originalAdmin = await readFile(join(dir, 'admin.json'), 'utf8'), webhook = initial.config.webhookToken;
  const prepared = await prepareNapcat(dir);
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  assert.equal(await readFile(join(dir, 'admin.json'), 'utf8'), originalAdmin);
  assert.equal(await verifyPassword('test1234', JSON.parse(originalAdmin)), true);
  assert.equal(config.deepseekKey, 'existing-key'); assert.deepEqual(config.allowedGroups, [{ id: '123456789', ds: true, video: true, scheduledChat: true }]); assert.equal(config.webhookToken, webhook);
  const webui = JSON.parse(await readFile(join(prepared.configDir, 'webui.json'), 'utf8'));
  const onebot = JSON.parse(await readFile(join(prepared.configDir, 'onebot11.json'), 'utf8'));
  assert.equal(webui.token, config.napcatToken); assert.equal(onebot.network.httpServers[0].token, config.onebotToken);
  assert.equal(onebot.network.httpClients[0].token, webhook); assert.equal(onebot.network.httpClients[0].url, 'http://qq-bot:3080/onebot/events');
  assert.equal((await stat(join(prepared.configDir, 'webui.json'))).mode & 0o777, 0o600);
  // Keep other existing integrations when updating a previously logged-in account.
  onebot.network.httpClients.push({ name: 'another-bot', url: 'http://example.local/events' });
  await writeFile(join(prepared.configDir, 'onebot11_123456789.json'), JSON.stringify(onebot));
  await prepareNapcat(dir);
  const again = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  assert.equal(again.napcatToken, config.napcatToken); assert.equal(again.onebotToken, config.onebotToken);
  const account = JSON.parse(await readFile(join(prepared.configDir, 'onebot11_123456789.json'), 'utf8'));
  assert.equal(account.network.httpClients.length, 2); assert.equal(account.network.httpClients.filter(item => item.name === 'qunyu-events').length, 1);
});

test('退出 QQ 登录清理自动登录与会话缓存，重启后恢复为待扫码并可重新取码', async t => {
  const { app, state, api, url } = await fixture(t, { napcatOptions: { recoveryWaitMs: 6000, recoveryPollMs: 120, recoveryCooldownMs: 600000 } });
  assert.equal((await fetch(url + '/api/napcat/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }, body: '{}' })).status, 401);
  // 未挂载 data/napcat/qq 时明确报错，不伪造退出成功。
  const unmounted = await api('napcat/logout', {});
  assert.equal(unmounted.status, 400);
  assert.match(unmounted.data.error, /data\/napcat\/qq/);

  const qqDir = app.napcat.qqDataDir;
  await mkdir(join(qqDir, 'nt_qq'), { recursive: true });
  await writeFile(join(qqDir, 'nt_qq', 'session.db'), 'active-qq-session');
  app.bot.selfId = '123456789';
  state.online = true; state.phase = 'ready'; state.logoutClearsOnline = true;
  state.restartDowntimePolls = 3; state.quickLoginUin = '123456789';

  const loggingOut = api('napcat/logout', {});
  while (!app.napcat.context().loggingOut) await new Promise(r => setTimeout(r, 20));
  const duringStatus = await api('napcat/refresh', {});
  assert.equal(duringStatus.status, 200);
  if (duringStatus.data.webui.recovering) {
    assert.equal(duringStatus.data.qq.state, 'reconnecting');
    assert.match(duringStatus.data.qq.label, /退出 QQ 登录/);
  }
  const done = await loggingOut;
  assert.equal(done.status, 200);
  assert.equal(done.data.qq.state, 'waiting_scan');
  assert.equal(state.quickLoginCalls, 1);
  assert.equal(state.quickLoginUin, '');
  assert.equal(state.restartCalls, 1);
  assert.equal(app.bot.selfId, '');
  assert.equal((await readdir(qqDir)).length, 0);
  const backups = (await readdir(join(qqDir, '..'))).filter(name => name.startsWith('qq.auto-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(qqDir, '..', backups[0], 'nt_qq', 'session.db'), 'utf8'), 'active-qq-session');

  const qr = await api('napcat/qrcode', { refresh: false });
  assert.equal(qr.status, 200);
  assert.equal(qr.data.url, state.qrcode);
});

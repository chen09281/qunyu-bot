import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdminSessions, rememberedSessionSeconds, sessionSeconds } from '../src/admin-sessions.mjs';
import { createApplication } from '../src/server.mjs';
import { openStore } from '../src/config.mjs';

const admin = { username: 'admin', salt: 'TEST_SALT', hash: 'TEST_PASSWORD_HASH' };
function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-admin-sessions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}

test('管理员会话跨重启保留，仅存令牌哈希；严格到期并绑定账号密码版本', t => {
  const path = join(folder(t), 'admin-sessions.sqlite'); let now = Date.now();
  let sessions = new AdminSessions(path, { now: () => now });
  const remembered = sessions.create(admin, true), short = sessions.create(admin);
  assert.equal(remembered.maxAge, rememberedSessionSeconds); assert.equal(short.maxAge, sessionSeconds);
  sessions.close(); sessions = new AdminSessions(path, { now: () => now });
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const saved = readFileSync(path);
    assert.equal(saved.includes(Buffer.from(remembered.id)), false);
    assert.equal(saved.includes(Buffer.from(admin.hash)), false);
    assert.equal(sessions.valid(remembered.id, admin), true); assert.equal(sessions.valid(short.id, admin), true);
    assert.equal(sessions.valid(remembered.id, null), false);
    now += sessionSeconds * 1000;
    assert.equal(sessions.valid(short.id, admin), false); assert.equal(sessions.valid(remembered.id, admin), true);
    now += (rememberedSessionSeconds - sessionSeconds) * 1000;
    assert.equal(sessions.valid(remembered.id, admin), false);
    const changed = sessions.create(admin, true);
    assert.equal(sessions.valid(changed.id, { ...admin, hash: 'NEW_HASH' }), false);
    assert.equal(sessions.valid(changed.id, admin), false);
  } finally { sessions.close(); }
});

test('会话撤销跨实例立即生效，最多保留 1000 条，拒绝符号链接数据库与日志文件', t => {
  const dir = folder(t), path = join(dir, 'sessions.sqlite'); let now = 1;
  const one = new AdminSessions(path, { now: () => now++ }), two = new AdminSessions(path, { now: () => now++ });
  try {
    const first = one.create(admin, true);
    assert.equal(two.valid(first.id, admin), true); two.delete(first.id);
    assert.equal(one.valid(first.id, admin), false);
    const oldest = one.create(admin, true); let latest;
    for (let i = 0; i < 1000; i++) latest = one.create(admin, true);
    assert.equal(two.valid(oldest.id, admin), false); assert.equal(two.valid(latest.id, admin), true);
    two.clear(); assert.equal(one.valid(latest.id, admin), false);
  } finally { one.close(); two.close(); }
  const target = join(dir, 'private'); writeFileSync(target, 'do not change');
  const link = join(dir, 'link.sqlite'); symlinkSync(target, link);
  assert.throws(() => new AdminSessions(link), /符号链接/);
  const journal = join(dir, 'journal.sqlite'); symlinkSync(target, journal + '-journal');
  assert.throws(() => new AdminSessions(journal), /符号链接/);
  assert.equal(readFileSync(target, 'utf8'), 'do not change');
});

async function fixture(t, options = {}) {
  const dir = folder(t); let app, url;
  const stop = async () => { if (app) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app = null; } };
  const start = async () => {
    app = await createApplication({ dataDir: dir, initialPassword: 'password8', bilibiliAutoStart: false, douyinAutoStart: false, ...options });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${app.server.address().port}`;
  };
  t.after(stop); await start();
  const request = (name, data, cookie, extra = {}) => fetch(`${url}/api/${name}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...extra },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { dir, request, restart: async () => { await stop(); await start(); } };
}
const input = rememberMe => ({ username: 'admin', password: 'password8', rememberMe });
const cookieOf = response => response.headers.get('set-cookie').split(';')[0];

test('保持登录设置 30 天 HttpOnly Cookie，重启后恢复；未勾选只使用浏览器会话 Cookie', async t => {
  const f = await fixture(t, { secureCookie: true });
  assert.equal((await f.request('login', { ...input(true), rememberMe: 'true' })).status, 400);
  assert.equal((await f.request('login', { ...input(true), password: 'wrong' })).status, 401);
  assert.equal((await f.request('login', input(true), '', { Origin: 'https://evil.test' })).status, 403);
  const login = await f.request('login', input(true)), cookie = cookieOf(login);
  assert.equal(login.status, 200); assert.deepEqual(await login.json(), { ok: true });
  assert.match(login.headers.get('set-cookie'), /Max-Age=2592000/);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/.*; Secure/);
  const short = await f.request('login', input(false));
  assert.doesNotMatch(short.headers.get('set-cookie'), /Max-Age|Expires/);
  await f.restart();
  assert.equal((await f.request('session', undefined, cookie)).status, 200);
  const reused = await f.request('login', input(true), cookie);
  assert.notEqual(cookieOf(reused), cookie); assert.equal((await f.request('session', undefined, cookie)).status, 401);
  assert.equal((await f.request('session', undefined, cookieOf(reused))).status, 200);
  const publicData = await (await f.request('status', undefined, cookieOf(reused))).text();
  assert.equal(publicData.includes(cookieOf(reused).split('=')[1]), false);
});

test('退出登录与改密在重启后仍撤销旧 Cookie，命令行重置密码同样失效', async t => {
  const f = await fixture(t), a = cookieOf(await f.request('login', input(true))), b = cookieOf(await f.request('login', input(true)));
  const logout = await f.request('logout', {}, a); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  await f.restart();
  assert.equal((await f.request('session', undefined, a)).status, 401);
  assert.equal((await f.request('session', undefined, b)).status, 200);
  const c = cookieOf(await f.request('login', input(true)));
  const change = await f.request('password', { currentPassword: 'password8', newPassword: 'newpass88' }, b);
  assert.equal(change.status, 200); await f.restart();
  for (const cookie of [a, b, c]) assert.equal((await f.request('session', undefined, cookie)).status, 401);
  const fresh = await f.request('login', { ...input(true), password: 'newpass88' }), freshCookie = cookieOf(fresh);
  const store = await openStore(f.dir); await store.changePassword('reset888');
  await f.restart();
  assert.equal((await f.request('session', undefined, freshCookie)).status, 401);
  assert.equal((await f.request('login', { ...input(true), password: 'reset888' })).status, 200);
});

test('保持登录 Cookie 到期后不能继续访问后台', async t => {
  let now = Date.now(); const f = await fixture(t, { sessionOptions: { now: () => now } });
  const cookie = cookieOf(await f.request('login', input(true)));
  now += rememberedSessionSeconds * 1000 - 1;
  assert.equal((await f.request('session', undefined, cookie)).status, 200);
  now++;
  assert.equal((await f.request('session', undefined, cookie)).status, 401);
});

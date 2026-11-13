import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, passwordHash, verifyPassword } from '../src/config.mjs';
import { createApplication } from '../src/server.mjs';

test('旧账号迁移到 admin，原盐和密码哈希不变，修改密码后用户名仍保留', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-username-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = await passwordHash('existing1234'); writeFileSync(join(dir, 'admin.json'), JSON.stringify(original));
  const store = await openStore(dir, 'must-not-reset');
  assert.equal(store.admin.username, 'admin'); assert.equal(store.admin.salt, original.salt); assert.equal(store.admin.hash, original.hash);
  assert.equal(await verifyPassword('existing1234', store.admin), true);
  const persisted = readFileSync(join(dir, 'admin.json'), 'utf8'); await openStore(dir);
  assert.equal(readFileSync(join(dir, 'admin.json'), 'utf8'), persisted);
  await store.changePassword('updated1234'); assert.equal(store.admin.username, 'admin');
});

test('登录必须同时匹配用户名与原密码，旧的仅密码请求不能绕过，解析状态接口需要登录', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-username-api-'));
  const app = await createApplication({ dataDir: dir, initialPassword: 'existing1234' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.bot.close(); await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); rmSync(dir, { recursive: true, force: true }); });
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  const login = input => fetch(url + '/api/login', { method: 'POST', headers, body: JSON.stringify(input) });
  for (const input of [{ password: 'existing1234' }, { username: 'wrong', password: 'existing1234' }, { username: 'admin', password: 'wrong' }]) {
    const result = await login(input); assert.equal(result.status, 401); assert.equal((await result.json()).error, '用户名或密码错误');
  }
  assert.equal((await fetch(url + '/api/links')).status, 401);
  const result = await login({ username: 'admin', password: 'existing1234' }); assert.equal(result.status, 200);
  const auth = { Cookie: result.headers.get('set-cookie').split(';')[0] };
  assert.equal((await (await fetch(url + '/api/session', { headers: auth })).json()).username, 'admin');
  app.bot.links.worker = async () => ({ available: true, version: 'fixture' });
  assert.equal((await (await fetch(url + '/api/links', { headers: auth })).json()).available, true);
});

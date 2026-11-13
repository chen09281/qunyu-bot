import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/server.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'qqbot-key-setup-'));
  const app = await createApplication({ dataDir, initialPassword: 'test1234' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.bot.close(); await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  const login = await fetch(url + '/api/login', { method: 'POST', headers: base, body: JSON.stringify({ username: 'admin', password: 'test1234' }) });
  const headers = { ...base, Cookie: login.headers.get('set-cookie').split(';')[0] };
  const bind = (data, extras = {}) => fetch(url + '/api/setup-api-key', { method: 'POST', headers: { ...headers, ...extras }, body: JSON.stringify(data) });
  return { app, dataDir, url, headers, bind };
}

test('首次 Key 绑定必须登录且填写非空密钥，不调用付费 API，不改动原密码与其他设置', async t => {
  const { app, dataDir, url, headers, bind } = await fixture(t);
  app.store.save({ model: 'custom-saved-model', allowedGroups: ['123456789'], deepseekUrl: 'https://api.example.com/v1' });
  const original = { ...app.store.config }, admin = await readFile(join(dataDir, 'admin.json'), 'utf8');
  let calls = 0; app.bot.request = async () => { calls++; throw new Error('不应调用上游'); };
  assert.equal((await (await fetch(url + '/api/config', { headers })).json()).deepseekKeyConfigured, false);
  assert.equal((await fetch(url + '/api/setup-api-key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }, body: JSON.stringify({ key: 'fake-key' }) })).status, 401);
  assert.equal((await bind({ key: 'fake-key' }, { Origin: 'https://evil.example' })).status, 403);
  for (const data of [{}, { key: '' }, { key: '   ' }, { key: null }, { key: 12 }, { key: 'has\nnewline' }, { key: 'x'.repeat(2049) }]) {
    assert.equal((await bind(data)).status, 400); assert.equal(app.store.config.deepseekKey, '');
  }
  const response = await bind({ key: '  test-bound-key  ' }), body = await response.text();
  assert.equal(response.status, 200); assert.equal(JSON.parse(body).deepseekKeyConfigured, true);
  assert.equal(body.includes('test-bound-key'), false); assert.equal(app.store.config.deepseekKey, 'test-bound-key');
  assert.deepEqual({ ...app.store.config, deepseekKey: '' }, original);
  assert.equal(await readFile(join(dataDir, 'admin.json'), 'utf8'), admin);
  assert.equal(calls, 0);
  const reopened = await createApplication({ dataDir });
  assert.equal(reopened.store.config.deepseekKey, 'test-bound-key'); reopened.bot.close();
});

test('已有 Key 时跳过绑定，旧页面或并发的绑定请求不会覆盖已保存密钥', async t => {
  const { app, bind } = await fixture(t);
  const results = await Promise.all([bind({ key: 'first-tab-key' }), bind({ key: 'second-tab-key' })]);
  assert.ok(results.every(response => response.status === 200));
  const saved = app.store.config.deepseekKey;
  assert.ok(['first-tab-key', 'second-tab-key'].includes(saved));
  assert.equal(app.bot.logs.filter(log => log.message === '首次 API Key 绑定完成').length, 1);
  const skipped = await bind({ key: 'a-key-from-stale-setup' });
  assert.equal((await skipped.json()).deepseekKeyConfigured, true);
  assert.equal(app.store.config.deepseekKey, saved);
  assert.equal(app.bot.logs.filter(log => log.message === '首次 API Key 绑定完成').length, 1);
});

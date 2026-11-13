import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LinkCookies, normalizeCookies, maxCookieBytes } from '../src/link-cookies.mjs';
import { LinkParser, socialPlatforms, socialLink } from '../src/social-links.mjs';
import { createApplication } from '../src/server.mjs';
import { Bot } from '../src/bot.mjs';
import { defaultConfig } from '../src/config.mjs';
import { Conversations } from '../src/conversations.mjs';

const platform = id => socialPlatforms.find(item => item.id === id);
const header = '# Netscape HTTP Cookie File\n';
function folder(t) { const path = mkdtempSync(join(tmpdir(), 'qqbot-cookies-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }

test('Cookie 请求头转为 Netscape 格式，文件导入只保留所选平台并保留 HttpOnly 与会话 Cookie', () => {
  const plain = normalizeCookies('Cookie: SESSDATA=FAKE_SECRET==; bili_jct=token', platform('bilibili'));
  assert.match(plain.text, /\.bilibili\.com\tTRUE\t\/\tTRUE\t0\tSESSDATA\tFAKE_SECRET==/);
  assert.equal(plain.count, 2);
  const imported = normalizeCookies(header + '#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tfake\n'
    + '.douyin.com\tTRUE\t/\tTRUE\t0\tsessionid\tOTHER_SECRET\n', platform('bilibili'));
  assert.equal(imported.count, 1); assert.equal(imported.ignored, 1); assert.equal(imported.text.includes('OTHER_SECRET'), false);
  assert.match(imported.text, /#HttpOnly_\.bilibili\.com/);
  for (const value of ['', 'password123', 'name=value\nOther: header', 'x\u0000=y', header + 'invalid', 'x='.padEnd(maxCookieBytes + 1, 'x'),
    header + '.bilibili.com.evil.test\tTRUE\t/\tTRUE\t0\tsessionid\tfake\n']) assert.throws(() => normalizeCookies(value, platform('bilibili')));
});

test('Cookie 独立私密保存、响应不回显、跨重启保留、任务使用快照且不能读取符号链接', t => {
  const dir = folder(t), cookieDir = join(dir, 'link-cookies');
  let cookies = new LinkCookies(cookieDir, socialPlatforms);
  assert.equal(cookies.info('bilibili').configured, false);
  const saved = cookies.save('bilibili', 'SESSDATA=PRIVATE_COOKIE');
  assert.equal(saved.configured, true); assert.equal(JSON.stringify(saved).includes('PRIVATE_COOKIE'), false);
  assert.equal(statSync(cookieDir).mode & 0o777, 0o700); assert.equal(statSync(join(cookieDir, 'bilibili.txt')).mode & 0o777, 0o600);
  cookies = new LinkCookies(cookieDir, socialPlatforms); assert.equal(cookies.info('bilibili').configured, true);
  const job = join(dir, 'job'); mkdirSync(job);
  const snapshot = cookies.snapshot('bilibili', join(job, '.cookies.txt'));
  cookies.save('bilibili', 'SESSDATA=NEW_COOKIE');
  assert.equal(readFileSync(snapshot, 'utf8').includes('PRIVATE_COOKIE'), true);
  cookies.clear('bilibili'); assert.equal(cookies.info('bilibili').configured, false);
  assert.equal(existsSync(snapshot), true);
  assert.throws(() => cookies.save('../admin', 'x=y'), /不支持/);
  const outside = join(dir, 'outside'); writeFileSync(outside, 'DO_NOT_READ');
  symlinkSync(outside, join(cookieDir, 'bilibili.txt'));
  assert.throws(() => cookies.save('bilibili', 'x=y'), /普通文件/);
  assert.throws(() => cookies.snapshot('bilibili', join(job, '.second.txt')));
  assert.equal(readFileSync(outside, 'utf8'), 'DO_NOT_READ');
});

test('解析器把平台凭据快照交给任务，不暴露原文，任务清理移除临时登录态', async t => {
  const dir = folder(t); let taskCookie;
  const parser = new LinkParser(dir, { worker: async input => {
    if (input.action === 'status') return { available: true };
    taskCookie = input.cookieFile;
    assert.match(readFileSync(taskCookie, 'utf8'), /PRIVATE_COOKIE/);
    assert.notEqual(taskCookie, join(dir, 'link-cookies', 'bilibili.txt'));
    assert.equal(taskCookie.startsWith(join(dir, 'media')), false);
    return { title: '测试帖子', images: [] };
  } });
  parser.cookies.save('bilibili', 'SESSDATA=PRIVATE_COOKIE');
  const status = await parser.status(); assert.equal(status.platforms.find(item => item.id === 'bilibili').configured, true);
  assert.equal(JSON.stringify(status).includes('PRIVATE_COOKIE'), false);
  const result = await parser.parse(socialLink('https://b23.tv/test'), defaultConfig());
  result.cleanup(); assert.equal(existsSync(taskCookie), false);
  assert.equal(parser.cookies.info('bilibili').configured, true); parser.close();
});

test('登录态 API 需鉴权与同源校验，只返回状态，保存清除后刷新该平台去重且保留账号密码', async t => {
  const dir = folder(t), app = await createApplication({ dataDir: dir, initialPassword: 'test1234' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.bot.close(); await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); });
  const base = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
  const payload = { platform: 'bilibili', content: 'SESSDATA=PRIVATE_COOKIE' };
  const send = (path, data, headers = base) => fetch(url + path, { method: 'POST', headers, body: JSON.stringify(data) });
  for (const path of ['/api/links/cookies', '/api/links/cookies/clear']) assert.equal((await send(path, payload)).status, 401);
  const login = await send('/api/login', { username: 'admin', password: 'test1234' });
  const auth = { ...base, Cookie: login.headers.get('set-cookie').split(';')[0] };
  const adminBefore = readFileSync(join(dir, 'admin.json'), 'utf8');
  assert.equal((await send('/api/links/cookies', payload, { ...auth, Origin: 'https://evil.example' })).status, 403);
  app.bot.linkSeen.set('cached', { platform: 'bilibili', time: Date.now() });
  app.bot.linkSeen.set('another-platform', { platform: 'youtube', time: Date.now() });
  const response = await send('/api/links/cookies', payload, auth), data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.configured, true); assert.equal(JSON.stringify(data).includes('PRIVATE_COOKIE'), false);
  assert.equal(app.bot.linkSeen.has('cached'), false); assert.equal(app.bot.linkSeen.has('another-platform'), true);
  for (const input of [{ platform: '../../admin', content: 'x=y' }, { platform: 'bilibili', content: '' }, { platform: 'bilibili', content: 'invalid' }]) assert.equal((await send('/api/links/cookies', input, auth)).status, 400);
  assert.equal(JSON.stringify(app.bot.status()).includes('PRIVATE_COOKIE'), false);
  const clear = await send('/api/links/cookies/clear', { platform: 'bilibili' }, auth);
  assert.equal((await clear.json()).configured, false); assert.equal(readFileSync(join(dir, 'admin.json'), 'utf8'), adminBefore);
});

test('平台解析失败后，新群消息可以重试而不被十分钟缓存拦截，不自动重试旧事件', async () => {
  const store = { config: { ...defaultConfig(), allowedGroups: ['10003'], enabled: true, deepseekKey: 'fake', linkCooldownSeconds: 0 } };
  let calls = 0;
  const parser = { async parse() { calls++; throw new Error('平台要求登录'); }, close() {} };
  const bot = new Bot(store, new Conversations(), parser);
  const event = message_id => ({ post_type: 'message', message_type: 'group', self_id: 10001, user_id: 10002, group_id: 10003, message_id,
    message: [{ type: 'text', data: { text: 'https://b23.tv/needs-login' } }] });
  const idle = async () => { for (let i = 0; i < 100; i++) { if (!bot.active) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('not idle'); };
  bot.receive(event(1)); await idle(); assert.equal(calls, 1);
  bot.receive(event(1)); await idle(); assert.equal(calls, 1);
  bot.receive(event(2)); await idle(); assert.equal(calls, 2); bot.close();
});

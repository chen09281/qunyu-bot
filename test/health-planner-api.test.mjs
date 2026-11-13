import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createApplication } from '../src/server.mjs';
import { useConsole } from '../frontend/src/composables/useConsole.js';

const built = existsSync(resolve(dirname(fileURLToPath(import.meta.url)), '../dist/index.html'));

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'qqbot-hp-api-'));
  const app = await createApplication({
    dataDir,
    initialPassword: 'test1234',
    healthPlannerAutoStart: false,
    checkinAutoStart: false,
    subscriptionAutoStart: false,
    scheduledChatAutoStart: false,
    bilibiliAutoStart: false,
    douyinAutoStart: false
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.bot.close();
    await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true });
  });
  return { app, url };
}

test('Apple 健康桥接 API (/bridge/health/*) 鉴权与读写闭环，不被后台同源拦截或返回 HTML', { skip: built ? false : '需要先 npm run build' }, async t => {
  const { app, url } = await fixture(t);
  const user = app.healthPlannerStore.upsertProfile('50001', { userName: '小张', groupId: '10001' }, {
    sex: 'male', age: 27, heightCm: 178, weightKg: 76, bodyFatPct: null,
    goal: 'cut', activityLevel: 'moderate', dietStyle: 'balanced', dislikes: [], mealRatios: { breakfast: 0.3, lunch: 0.4, dinner: 0.3 }
  });
  app.healthPlannerStore.addMealLog('50001', '2026-11-13', {
    mealType: 'lunch', summary: '轻食鸡胸肉沙拉', calories: 480, proteinG: 38, carbsG: 35, fatG: 16
  }, true);

  // 1. Missing or invalid token returns 401 JSON
  const unauthSync = await fetch(`${url}/bridge/health/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps: 5000 })
  });
  assert.equal(unauthSync.status, 401);

  const badPending = await fetch(`${url}/bridge/health/pending`, {
    headers: { Authorization: 'Bearer wrong-token' }
  });
  assert.equal(badPending.status, 401);
  assert.match(badPending.headers.get('content-type'), /application\/json/);

  // 2. Unknown /bridge/ path returns JSON 404 (not SPA index.html)
  const missingBridge = await fetch(`${url}/bridge/health/nonexistent`);
  assert.equal(missingBridge.status, 404);
  assert.match(missingBridge.headers.get('content-type'), /application\/json/);

  // 3. Valid Apple Health sync updates weight & TDEE
  const syncRes = await fetch(`${url}/bridge/health/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.syncToken}`
    },
    body: JSON.stringify({
      date: '2026-11-13',
      steps: 10500,
      activeEnergyKcal: 520,
      weightKg: 74.8
    })
  });
  assert.equal(syncRes.status, 200);
  const syncBody = await syncRes.json();
  assert.equal(syncBody.ok, true);
  assert.equal(syncBody.metrics.activeEnergyKcal, 520);
  assert.equal(syncBody.dailyTargets.tdeeSource, 'apple_active_energy');
  assert.equal(app.healthPlannerStore.getUser('50001').profile.weightKg, 74.8);

  // 4. Pull pending items and acknowledge completion
  const pendingRes = await fetch(`${url}/bridge/health/pending`, {
    headers: { Authorization: `Bearer ${user.syncToken}` }
  });
  assert.equal(pendingRes.status, 200);
  const pendingBody = await pendingRes.json();
  assert.equal(pendingBody.count, 1);
  assert.equal(pendingBody.items[0].calories, 480);

  const ackRes = await fetch(`${url}/bridge/health/ack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.syncToken}`
    },
    body: JSON.stringify({ ids: pendingBody.items.map(i => i.id) })
  });
  assert.equal(ackRes.status, 200);
  const ackBody = await ackRes.json();
  assert.equal(ackBody.acked, 1);
  assert.equal(ackBody.remaining, 0);

  // 5. Admin /api/health-planner requires session and omits PII/syncToken
  assert.equal((await fetch(`${url}/api/health-planner`)).status, 401);
  const loginRes = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-request': '1' },
    body: JSON.stringify({ username: 'admin', password: 'test1234' })
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  const adminGet = await fetch(`${url}/api/health-planner`, { headers: { Cookie: cookie } });
  assert.equal(adminGet.status, 200);
  const summaryText = await adminGet.text();
  assert.equal(summaryText.includes('74.8'), false, '后台汇总接口不应暴露个人体重明细');
  assert.equal(summaryText.includes(user.syncToken), false, '后台汇总接口不应暴露个人同步 Token');
  const summary = JSON.parse(summaryText);
  assert.equal(summary.stats.userCount, 1);
  assert.equal(summary.stats.appleBoundCount, 1);

  const adminPut = await fetch(`${url}/api/health-planner`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-request': '1', Cookie: cookie },
    body: JSON.stringify({
      enabled: true,
      renderCard: false,
      pushSlots: { morningOverview: '08:00', breakfast: '', lunch: '12:00', dinner: '18:00' }
    })
  });
  assert.equal(adminPut.status, 200);
  const updated = await adminPut.json();
  assert.equal(updated.settings.renderCard, false);
  assert.equal(updated.settings.pushSlots.morningOverview, '08:00');
});

test('前端控制台 useConsole 支持 health-planner 插件导航、加载与保存', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const prevLoc = globalThis.location, prevHist = globalThis.history;
  globalThis.location = { hash: '#overview' };
  globalThis.history = {
    replaceState(_s, _t, h) { globalThis.location.hash = h; },
    pushState(_s, _t, h) { globalThis.location.hash = h; }
  };
  t.after(() => {
    if (prevLoc === undefined) delete globalThis.location; else globalThis.location = prevLoc;
    if (prevHist === undefined) delete globalThis.history; else globalThis.history = prevHist;
  });

  let c;
  await renderToString(createSSRApp({ setup() { c = useConsole(); return () => null; } }));
  c.state.authenticated = true;

  const sample = {
    settings: { enabled: true, renderCard: true, aiMenuEnhance: true, aiFoodVision: true, pushSlots: { morningOverview: '07:30', breakfast: '', lunch: '11:30', dinner: '17:30' } },
    stats: { userCount: 2, appleBoundCount: 1, pushEnabledCount: 2, mealsLoggedToday: 1, pushesToday: 1, pendingAppleItems: 0 }
  };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).includes('health-planner') && options.method === 'PUT') {
      const body = JSON.parse(options.body);
      return Response.json({ ...sample, settings: { ...sample.settings, ...body } });
    }
    return Response.json(String(url).includes('health-planner') ? sample : {});
  });

  c.navigate('plugins/health-planner');
  assert.equal(c.state.page, 'plugins');
  assert.equal(c.state.pluginDetail, 'health-planner');
  assert.equal(globalThis.location.hash, '#plugins/health-planner');

  for (let i = 0; i < 10 && c.state.busy.healthPlannerStatus; i += 1) await Promise.resolve();
  if (!c.state.healthPlanner) await c.loadHealthPlanner();
  assert.equal(c.state.healthPlanner.stats.userCount, 2);

  c.state.healthPlannerSettings.renderCard = false;
  await c.saveHealthPlannerSettings(false);
  assert.equal(c.state.healthPlanner.settings.renderCard, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { useConsole } from '../frontend/src/composables/useConsole.js';

async function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let c; await renderToString(createSSRApp({ setup() { c = useConsole(); return () => null; } })); return c;
}
const group = id => ({ id, ds: true, video: true, scheduledChat: true });
const entry = id => ({ id, name: `来源 ${id}`, type: 'github', source: `owner/${id}`, groups: ['10001'], enabled: true, include: '', exclude: '', crossPlatformMatch: true });
function browser(t, hash = '#overview') {
  const previous = { location: globalThis.location, history: globalThis.history }, calls = [];
  globalThis.location = { hash };
  globalThis.history = {
    replaceState(_state, _title, hash) { calls.push(['replace', hash]); globalThis.location.hash = hash; },
    pushState(_state, _title, hash) { calls.push(['push', hash]); globalThis.location.hash = hash; }
  };
  t.after(() => { for (const key of Object.keys(previous)) if (previous[key] === undefined) delete globalThis[key]; else globalThis[key] = previous[key]; });
  return calls;
}

test('危险操作经统一确认后执行，取消请求不发出，最后群订阅提示整源删除', async t => {
  const c = await setup(t); c.state.authenticated = true;
  c.state.linkStatus = { platforms: [{ id: 'bilibili', name: '哔哩哔哩', configured: true }] }; c.state.linkCookiePlatform = 'bilibili';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => { calls.push({ url, method: options.method || 'GET' }); return Response.json(url.includes('cookies/clear') ? { platform: 'bilibili', configured: false } : { entries: [] }); });
  let pending = c.removeLinkCookie(); assert.equal(c.state.confirmation.title, '清除平台登录态？'); c.resolveConfirmation(false); await pending; assert.equal(calls.length, 0);
  pending = c.removeLinkCookie(); c.resolveConfirmation(true); await pending; assert.equal(calls.filter(call => call.url.includes('cookies/clear')).length, 1);
  c.state.subscriptions = { entries: [entry('A')] };
  pending = c.removeSubscriptionGroup('A', '10001');
  assert.equal(c.state.confirmation.title, '删除这条订阅？'); assert.match(c.state.confirmation.detail, /最后一个目标群/);
  c.resolveConfirmation(true); await pending;
  assert.equal(calls.filter(call => call.url.includes('/subscriptions/')).length, 1); assert.equal(c.state.subscriptions.entries.length, 0);
});

test('保存群白名单保留在途添加、移除及开关编辑，失败不丢草稿', async t => {
  const c = await setup(t); let finish;
  c.state.config = { allowedGroups: [group('10001'), group('10002')] }; c.state.groupRules = [group('10001'), group('10002')];
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => finish = resolve));
  const pending = c.saveGroups();
  c.state.groupRules[0].ds = false; c.removeGroupRule('10002'); c.state.groupRules.push(group('10003'));
  finish(Response.json({ allowedGroups: [group('10001'), group('10002')] })); await pending;
  assert.deepEqual(c.state.groupRules, [{ ...group('10001'), ds: false }, group('10003')]);
  const failed = c.saveGroups(); finish(Response.json({ error: '未保存' }, { status: 500 })); await failed;
  assert.equal(c.state.groupRules[0].ds, false); assert.equal(c.state.groupRules[1].id, '10003');
});

test('保存私聊白名单保留提交之后的增删', async t => {
  const c = await setup(t); let finish;
  c.state.config = { allowedPrivateUsers: ['10001'] }; c.state.privateUsers = ['10001', '10002'];
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => finish = resolve));
  const pending = c.savePrivateUsers(); c.removePrivateUser('10001'); c.state.privateUsers.push('10003');
  finish(Response.json({ allowedPrivateUsers: ['10001', '10002'] })); await pending;
  assert.deepEqual(c.state.privateUsers, ['10002', '10003']);
});

test('保存订阅不清空另一条编辑中的草稿，同一条保存期间的修改也保留', async t => {
  const c = await setup(t); let finish;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => finish = resolve));
  c.editSubscription(entry('A')); let pending = c.saveSubscription();
  c.editSubscription(entry('B')); c.state.subscriptionDraft.name = 'B 未保存';
  finish(Response.json({ entries: [entry('A'), entry('B')] })); await pending;
  assert.equal(c.state.subscriptionEditId, 'B'); assert.equal(c.state.subscriptionDraft.name, 'B 未保存');
  pending = c.saveSubscription(); c.state.subscriptionDraft.include = '新关键词';
  finish(Response.json({ entries: [entry('B')] })); await pending;
  assert.equal(c.state.subscriptionEditId, 'B'); assert.equal(c.state.subscriptionDraft.include, '新关键词');
});

test('刷新插件设置同步未编辑字段，冲突保留输入并支持恢复服务器设置', async t => {
  const c = await setup(t); let settings = { enabled: true, time: '09:00', notify: true };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ settings, entries: [] }));
  await c.loadCheckin(); settings = { ...settings, time: '10:00' }; await c.loadCheckin();
  assert.equal(c.state.checkinSettings.time, '10:00'); assert.equal(c.state.checkinConflict, false);
  c.state.checkinSettings.time = '11:00'; settings = { ...settings, time: '12:00', notify: false }; await c.loadCheckin();
  assert.equal(c.state.checkinSettings.time, '11:00'); assert.equal(c.state.checkinSettings.notify, false); assert.equal(c.state.checkinConflict, true);
  const resetCheckin = c.resetCheckinDraft(); c.resolveConfirmation(true); await resetCheckin; assert.equal(c.state.checkinSettings.time, '12:00'); assert.equal(c.state.checkinConflict, false);
  settings = { enabled: true, intervalMinutes: 10, rsshubUrl: 'https://rsshub.app' }; await c.loadSubscriptions();
  settings = { ...settings, intervalMinutes: 20 }; await c.loadSubscriptions(); assert.equal(c.state.subscriptionSettings.intervalMinutes, 20);
  c.state.subscriptionSettings.intervalMinutes = 30; settings = { ...settings, intervalMinutes: 40 }; await c.loadSubscriptions();
  assert.equal(c.state.subscriptionConflict, true); const resetSubscriptions = c.resetSubscriptionSettings(); c.resolveConfirmation(true); await resetSubscriptions; assert.equal(c.state.subscriptionSettings.intervalMinutes, 40);
});

test('保存签到设置保留在途输入，并忽略早于保存的状态响应', async t => {
  const c = await setup(t); let finishRead, finishSave;
  const settings = { enabled: true, time: '09:00', notify: true }; c.state.checkin = { settings }; c.state.checkinSettings = { ...settings, time: '10:00' };
  t.mock.method(globalThis, 'fetch', (_url, options) => new Promise(resolve => { if (options.method === 'PUT') finishSave = resolve; else finishRead = resolve; }));
  const read = c.loadCheckin(), save = c.saveCheckin(); c.state.checkinSettings.time = '11:00';
  finishSave(Response.json({ settings: { ...settings, time: '10:00' } })); await save;
  finishRead(Response.json({ settings })); await read;
  assert.equal(c.state.checkin.settings.time, '10:00'); assert.equal(c.state.checkinSettings.time, '11:00');
});

test('过期自动刷新不能反转刚保存的开关，最新轮询仍同步干净的草稿', async t => {
  const c = await setup(t); c.state.authenticated = true; c.state.config = { enabled: false, allowedGroups: [] }; let finish;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (options.method === 'PUT') return Response.json({ enabled: true, allowedGroups: [] });
    if (url === '/api/config') return new Promise(resolve => finish = resolve);
    return Response.json({});
  });
  const refresh = c.refresh(); await c.toggle(); finish(Response.json({ enabled: false, allowedGroups: [] })); await refresh;
  assert.equal(c.state.config.enabled, true);
  const fresh = c.refresh(); finish(Response.json({ enabled: true, allowedGroups: [group('10001')] })); await fresh;
  assert.deepEqual(c.state.groupRules, [group('10001')]);
});

test('聊天刷新跨过多页新消息时补齐中间记录，不假设数据库 ID 连续', async t => {
  const c = await setup(t); c.state.authenticated = true; c.state.conversationId = 'group';
  c.state.conversation = { turns: [{ id: 10 }], hasMore: false };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    const start = url.endsWith('before=200') ? 100 : url.endsWith('before=100') ? 10 : 200;
    return Response.json({ session: { id: 'group' }, turns: [{ id: start }, { id: start + 1 }], hasMore: start !== 10 });
  });
  await c.loadConversation();
  assert.deepEqual(c.state.conversation.turns.map(turn => turn.id), [10, 11, 100, 101, 200, 201]);
  assert.equal(c.state.conversation.hasMore, false); assert.equal(calls.length, 3);
});

test('补齐记录时切换会话，迟到页面不能混入另一个群', async t => {
  const c = await setup(t); c.state.authenticated = true; c.state.conversationId = 'A';
  c.state.conversation = { turns: [{ id: 1 }], hasMore: false }; let finish;
  t.mock.method(globalThis, 'fetch', async url => url.endsWith('before=100') ? new Promise(resolve => finish = resolve)
    : Response.json({ session: { id: 'A' }, turns: [{ id: 100 }], hasMore: true }));
  const pending = c.loadConversation(); await new Promise(resolve => setImmediate(resolve));
  c.state.conversationId = 'B'; c.state.conversation = null;
  finish(Response.json({ turns: [{ id: 1 }], hasMore: false })); await pending; assert.equal(c.state.conversation, null);
});

test('管理请求超时释放按钮、取消浏览器请求并提示确认保存结果', async t => {
  const c = await setup(t); c.state.config = {}; let signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { signal = options.signal; return new Promise(() => {}); });
  const pending = c.toggle(); t.mock.timers.tick(30000); await pending;
  assert.equal(signal.aborted, true); assert.equal(c.state.busy.toggle, false); assert.match(c.state.toast.message, /超时.*确认是否已生效/);
});

test('普通导航新增历史记录，兼容旧地址且无密钥仍能访问插件', async t => {
  const c = await setup(t), calls = browser(t); c.navigate('plugins'); c.navigate('plugins/subscriptions');
  assert.deepEqual(calls, [['push', '#plugins'], ['push', '#plugins/subscriptions']]);
  c.navigate('links', { replace: true }); assert.deepEqual(calls.at(-1), ['replace', '#plugins/links']);
  c.state.authenticated = true; c.state.config = { modelApiKeyConfigured: false }; const requests = [];
  t.mock.method(globalThis, 'fetch', async url => { requests.push(url); return Response.json({ settings: {}, entries: [] }); });
  c.navigate('plugins'); await new Promise(resolve => setImmediate(resolve));
  assert.ok(requests.includes('/api/subscriptions')); assert.ok(requests.includes('/api/checkin'));
});

test('预览立即显示加载状态，关闭后迟到响应不重新打开弹窗', async t => {
  const c = await setup(t); c.state.subscriptions = { entries: [entry('A')] }; let finish;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => finish = resolve));
  const pending = c.subscriptionAction('A', 'preview'); assert.equal(c.state.subscriptionPreview.loading, true);
  c.closeSubscriptionPreview(); finish(Response.json({ title: '来源 A', items: [] })); await pending;
  assert.equal(c.state.subscriptionPreview, null);
});

test('QQ 连接退出登录先经危险确认，确认后更新为待扫码状态；界面正确渲染退出按钮', async t => {
  const c = await setup(t);
  c.state.authenticated = true;
  c.state.config = { napcatTokenConfigured: true };
  c.state.napcat = { qq: { state: 'online', label: 'QQ 在线', detail: 'QQ 已登录' }, webui: { authenticated: true }, onebot: { reachable: true }, account: { userId: '10001', nickname: '测试号' } };
  c.state.qrcode = { url: 'https://txz.qq.com/p?k=old' };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    return Response.json({ checkedAt: Date.now(), webui: { authenticated: true }, onebot: { reachable: true }, account: { userId: '', nickname: '' }, qq: { state: 'waiting_scan', label: '等待扫码', detail: '使用手机 QQ 扫码，并在手机上确认登录' } });
  });
  let pending = c.logoutNapcat();
  assert.equal(c.state.confirmation.title, '退出当前 QQ 登录？');
  assert.match(c.state.confirmation.description, /测试号（QQ 10001）/);
  c.resolveConfirmation(false);
  await pending;
  assert.equal(calls.length, 0);

  pending = c.logoutNapcat();
  c.resolveConfirmation(true);
  await pending;
  assert.deepEqual(calls, [{ url: '/api/napcat/logout', method: 'POST' }]);
  assert.equal(c.state.napcat.qq.state, 'waiting_scan');
  assert.equal(c.state.qrcode, null);
  assert.match(c.state.toast.message, /已退出 QQ 登录/);

  const { createServer } = await import('vite'), vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  t.after(() => vite.close());
  const { default: NapcatPanel } = await vite.ssrLoadModule('/src/components/NapcatPanel.vue');
  const { consoleKey } = await vite.ssrLoadModule('/src/composables/useConsole.js');
  const renderPanel = napcat => {
    const app = createSSRApp(NapcatPanel);
    app.provide(consoleKey, {
      state: { config: { napcatTokenConfigured: true }, napcat, busy: {}, qrcode: null, qrError: '', totpCode: '' },
      refreshNapcat() {}, connectNapcat() {}, getQrcode() {}, logoutNapcat() {}
    });
    return renderToString(app);
  };
  const onlineHtml = await renderPanel({ qq: { state: 'online', label: 'QQ 在线' }, webui: { authenticated: true }, onebot: { reachable: true }, account: { userId: '10001', nickname: '测试号' } });
  assert.match(onlineHtml, /id="napcat-qq-logout"/);
  assert.match(onlineHtml, /退出 QQ 登录/);
  const offlineHtml = await renderPanel({ qq: { state: 'waiting_scan', label: '等待扫码' }, webui: { authenticated: true }, onebot: { reachable: true }, account: {} });
  assert.doesNotMatch(offlineHtml, /id="napcat-qq-logout"/);
  assert.match(offlineHtml, /获取二维码/);
});

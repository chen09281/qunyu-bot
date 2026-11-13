import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { configPatch, useConsole } from '../frontend/src/composables/useConsole.js';

test('聊天汇总使用群视图，翻页与刷新合并记录，开启新话题仅提交选中的成员', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let c;
  await renderToString(createSSRApp({ setup() { c = useConsole(); return () => null; } }));
  c.state.authenticated = true;
  const calls = [], session = { id: 'group-anchor', groupId: '10003', memberCount: 2 };
  const members = [{ id: 'member-a', userId: '10002', userName: '甲' }, { id: 'member-b', userId: '10004', userName: '乙' }];
  let refresh = false;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.startsWith('/api/chat-threads?')) return Response.json({ items: [session], total: 1, hasMore: false });
    if (url === '/api/conversations/member-b/reset') return Response.json({ ok: true });
    assert.match(url, /^\/api\/chat-threads\/group-anchor/);
    return Response.json({ session, members, turns: url.endsWith('?before=2') ? [{ id: 1, userId: '10004' }]
      : [{ id: 2, userId: '10002', status: refresh ? 'sent' : 'generating' }, { id: 3, userId: '10004' }], hasMore: !url.includes('before=') });
  });
  await c.loadConversations(); assert.equal(c.state.conversationsTotal, 1);
  await c.selectConversation(session); await c.loadConversation(true); refresh = true; await c.loadConversation();
  assert.deepEqual(c.state.conversation.turns.map(turn => turn.id), [1, 2, 3]);
  assert.equal(c.state.conversation.turns[1].status, 'sent'); assert.equal(c.state.conversation.hasMore, false);
  const resetting = c.resetConversation('member-b');
  assert.match(c.state.confirmation.description, /乙/); c.resolveConfirmation(true); await resetting;
  assert.deepEqual(calls.filter(call => call.method === 'POST'), [{ url: '/api/conversations/member-b/reset', method: 'POST' }]);
  assert.match(c.state.toast.message, /乙/);
  await c.resetConversation('another-group-member');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('Vue 表单保存时保留空白密钥对应的已有凭据，并将数字字段传为数字', () => {
  const draft = { deepseekKey: '  ', model: ' deepseek-flash ', cooldownSeconds: '0', maxTokens: '2048' };
  const patch = configPatch(draft, Object.keys(draft));
  assert.equal(Object.hasOwn(patch, 'deepseekKey'), false);
  assert.deepEqual(patch, { model: 'deepseek-flash', cooldownSeconds: 0, maxTokens: 2048 });
  assert.deepEqual(configPatch({ onebotToken: ' replacement ' }, ['onebotToken']), { onebotToken: 'replacement' });
  assert.deepEqual(configPatch({ napcatToken: ' ' }, ['napcatToken']), {});
  assert.deepEqual(configPatch({ thinkingEnabled: true, webSearchEnabled: false, reasoningEffort: ' high ' }, ['thinkingEnabled', 'webSearchEnabled', 'reasoningEffort']), { thinkingEnabled: true, webSearchEnabled: false, reasoningEffort: 'high' });
  assert.deepEqual(configPatch({ animePersonaEnabled: false }, ['animePersonaEnabled']), { animePersonaEnabled: false });
  assert.deepEqual(configPatch({ maxTokens: '99999999', maxTokensUnlimited: true }, ['maxTokens', 'maxTokensUnlimited']), { maxTokens: 99999999, maxTokensUnlimited: true });
  assert.deepEqual(configPatch({ timeoutSeconds: '180', timeoutUnlimited: true }, ['timeoutSeconds', 'timeoutUnlimited']), { timeoutSeconds: 180, timeoutUnlimited: true });
  assert.deepEqual(configPatch({ proactiveChatEnabled: false, groupFollowupEnabled: true }, ['proactiveChatEnabled', 'groupFollowupEnabled']), { proactiveChatEnabled: false, groupFollowupEnabled: true });
});


test('抖音手动验证错误不会被自动刷新画面清空，下一次人工操作才能清除', async t => {
  let console;
  await renderToString(createSSRApp({ setup() { console = useConsole(); return () => null; } }));
  console.state.page = 'plugins'; console.state.pluginDetail = 'links'; console.state.linkCookiePlatform = 'douyin';
  console.state.douyinQr = { state: 'verification_required', expiresAt: 1234 };
  const responses = [
    new Response(JSON.stringify({ error: '请在官方验证画面中选择「接收短信验证码」' }), { status: 400 }),
    new Response(JSON.stringify({ image: 'data:image/jpeg;base64,TEST', width: 1280, height: 900 })),
    new Response(JSON.stringify({ accepted: true, detail: '已进入官方短信验证页。' })),
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift());
  await console.douyinVerificationRequest({ type: 'sms-method' });
  const error = console.state.douyinVerificationError;
  assert.match(error, /接收短信/);
  await console.douyinVerificationRequest();
  assert.equal(console.state.douyinVerificationError, error);
  assert.ok(console.state.douyinVerification.image);
  await console.douyinVerificationRequest({ type: 'sms-method' });
  assert.equal(console.state.douyinVerificationError, '');
  assert.equal(console.state.douyinVerificationNotice, '已进入官方短信验证页。');
});

test('插件快捷开关只保存启停项，阻止重复提交，失败保留原状态和其他未保存设置', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let c;
  await renderToString(createSSRApp({ setup() { c = useConsole(); return () => null; } }));
  c.state.config = { linkParsingEnabled: true, linkMaxVideoMB: 50 };
  c.state.linkSettings = { linkParsingEnabled: true, linkMaxVideoMB: 77 };
  const calls = []; let finish;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, patch: JSON.parse(options.body) });
    return await new Promise(resolve => finish = resolve);
  });
  const first = c.toggleLinks();
  await c.toggleLinks();
  assert.equal(c.state.busy.links, true);
  assert.deepEqual(calls, [{ url: '/api/config', patch: { linkParsingEnabled: false } }]);
  finish(new Response(JSON.stringify({ linkParsingEnabled: false, linkMaxVideoMB: 50 })));
  await first;
  assert.equal(c.state.config.linkParsingEnabled, false);
  assert.deepEqual(c.state.linkSettings, { linkParsingEnabled: false, linkMaxVideoMB: 77 });
  const failed = c.toggleLinks();
  finish(new Response(JSON.stringify({ error: '保存失败' }), { status: 500 }));
  await failed;
  assert.equal(c.state.config.linkParsingEnabled, false);
  assert.equal(c.state.linkSettings.linkParsingEnabled, false);
  assert.equal(c.state.toast.error, true); assert.equal(c.state.busy.links, false);
});

test('旧链接解析地址进入插件详情，返回与切页恢复列表路由', async t => {
  const oldLocation = globalThis.location, oldHistory = globalThis.history;
  globalThis.location = { hash: '#links' };
  globalThis.history = { replaceState(_state, _title, hash) { globalThis.location.hash = hash; } };
  t.after(() => { if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
    if (oldHistory === undefined) delete globalThis.history; else globalThis.history = oldHistory; });
  let c;
  await renderToString(createSSRApp({ setup() { c = useConsole(); return () => null; } }));
  c.navigate('links');
  assert.equal(c.state.page, 'plugins'); assert.equal(c.state.pluginDetail, 'links');
  assert.equal(location.hash, '#plugins/links');
  c.navigate('plugins');
  assert.equal(c.state.pluginDetail, ''); assert.equal(location.hash, '#plugins');
  c.navigate('plugins/links'); c.navigate('overview');
  assert.equal(c.state.pluginDetail, ''); assert.equal(location.hash, '#overview');
  c.navigate('plugins/checkin');
  assert.equal(c.state.page, 'plugins'); assert.equal(c.state.pluginDetail, 'checkin'); assert.equal(location.hash, '#plugins/checkin');
  c.state.checkinSettings = { time: '10:30' };
  c.navigate('plugins/checkin/records');
  assert.equal(c.state.pluginDetail, 'checkin'); assert.equal(c.state.checkinView, 'records'); assert.equal(location.hash, '#plugins/checkin/records');
  c.navigate('plugins/checkin'); assert.equal(c.state.checkinView, 'settings'); assert.equal(c.state.checkinSettings.time, '10:30');
  c.navigate('plugins'); assert.equal(c.state.pluginDetail, '');
  c.state.groupRules = [{ id: '10003', ds: false }]; c.state.privateUsers = ['10002'];
  c.navigate('groups'); assert.equal(c.state.page, 'whitelist'); assert.equal(c.state.whitelistTab, 'groups'); assert.equal(location.hash, '#whitelist/groups');
  c.navigate('private'); assert.equal(c.state.page, 'whitelist'); assert.equal(c.state.whitelistTab, 'private'); assert.equal(location.hash, '#whitelist/private');
  c.navigate('whitelist/groups'); assert.equal(c.state.groupRules[0].ds, false); assert.deepEqual(c.state.privateUsers, ['10002']);
  c.navigate('plugins/scheduled-chat');
  assert.equal(c.state.pluginDetail, 'scheduled-chat'); assert.equal(c.state.page, 'plugins'); assert.equal(location.hash, '#plugins/scheduled-chat');
  c.navigate('plugins'); assert.equal(c.state.pluginDetail, '');
});

test('实时页迟到响应不会在切页或退出后恢复问题和思考内容', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let c, finish;
  await renderToString(createSSRApp({ setup() { c = useConsole(); return () => null; } }));
  c.state.authenticated = true; c.state.page = 'live';
  t.mock.method(globalThis, 'fetch', async url => url === '/api/logout' ? new Response('{}') : new Promise(resolve => finish = resolve));
  let pending = c.loadLiveTasks(); c.state.page = 'model'; finish(new Response(JSON.stringify({ tasks: [{ question: '迟到的问题' }], selected: null }))); await pending;
  assert.equal(c.state.liveTasks, null);
  c.state.page = 'live'; pending = c.loadLiveTasks(); await c.logout(); finish(new Response(JSON.stringify({ tasks: [], selected: { id: 'late', reasoning: '迟到的思考' } }))); await pending;
  assert.equal(c.state.liveTasks, null); assert.equal(c.state.liveSelectedId, ''); assert.equal(c.state.authenticated, false);
});

test('签到设置保留草稿，快捷开关仅更新 enabled，退出后迟到响应不恢复成员信息', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let c, finish;
  await renderToString(createSSRApp({ setup() { c = useConsole(); return () => null; } }));
  c.state.authenticated = true;
  const settings = { enabled: false, time: '09:05', notify: true, platforms: { skland: true, miyoushe: true, kuro: true } };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/logout') return new Response('{}');
    return new Promise(resolve => finish = resolve);
  });
  const load = c.loadCheckin(); finish(new Response(JSON.stringify({ settings, members: [] }))); await load;
  c.state.checkinSettings.time = '10:30';
  const toggle = c.saveCheckin(true); await c.saveCheckin(true);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { enabled: true });
  finish(new Response(JSON.stringify({ settings: { ...settings, enabled: true }, members: [] }))); await toggle;
  assert.equal(c.state.checkinSettings.time, '10:30'); assert.equal(c.state.checkinSettings.enabled, true);
  const pending = c.loadCheckin(); await c.logout();
  finish(new Response(JSON.stringify({ settings, members: [{ user: '10002' }] }))); await pending;
  assert.equal(c.state.checkin, null); assert.equal(c.state.checkinSettings, null);
});

test('退出登录后迟到的插件开关响应不会恢复配置或登录态', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let c, finish;
  await renderToString(createSSRApp({ setup() { c = useConsole(); return () => null; } }));
  c.state.authenticated = true; c.state.config = { linkParsingEnabled: true }; c.state.pluginDetail = 'links';
  t.mock.method(globalThis, 'fetch', async url => url === '/api/logout' ? new Response('{}')
    : await new Promise(resolve => finish = resolve));
  const pending = c.toggleLinks();
  await c.logout();
  finish(new Response(JSON.stringify({ linkParsingEnabled: false })));
  await pending;
  assert.equal(c.state.authenticated, false); assert.deepEqual(c.state.config, {}); assert.equal(c.state.pluginDetail, '');
});

test('定时聊天开关立即单独保存，逐群更新不覆盖白名单草稿，失败和退出保持原状态', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let c, finish;
  await renderToString(createSSRApp({ setup() { c = useConsole(); return () => null; } }));
  c.state.authenticated = true;
  const config = { proactiveChatEnabled: true, groupFollowupEnabled: true, allowedGroups: [{ id: '10003', ds: true, video: true, scheduledChat: true }] };
  c.state.config = structuredClone(config); c.state.model = { systemPrompt: '未保存人设' };
  c.state.groupRules = [{ id: '10003', ds: false, video: false, scheduledChat: true }, { id: '10004', ds: true, video: true }];
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, patch: options?.body && JSON.parse(options.body) });
    if (url === '/api/logout') return new Response('{}');
    return new Promise(resolve => finish = resolve);
  });
  let pending = c.toggleScheduledChat(); await c.toggleScheduledChat();
  assert.deepEqual(calls, [{ url: '/api/config', patch: { proactiveChatEnabled: false } }]);
  finish(new Response(JSON.stringify({ ...config, proactiveChatEnabled: false }))); await pending;
  assert.equal(c.state.config.proactiveChatEnabled, false); assert.equal(c.state.model.systemPrompt, '未保存人设');
  pending = c.toggleScheduledChatGroup('10003');
  assert.deepEqual(calls.at(-1), { url: '/api/scheduled-chat/groups/10003', patch: { enabled: false } });
  finish(new Response(JSON.stringify({ ...config, allowedGroups: [{ ...config.allowedGroups[0], scheduledChat: false }] }))); await pending;
  assert.deepEqual(c.state.groupRules, [{ id: '10003', ds: false, video: false, scheduledChat: false }, { id: '10004', ds: true, video: true }]);
  pending = c.toggleScheduledChatGroup('10003'); finish(new Response(JSON.stringify({ error: '保存失败' }), { status: 500 })); await pending;
  assert.equal(c.state.config.allowedGroups[0].scheduledChat, false); assert.equal(c.state.toast.error, true);
  pending = c.toggleScheduledFollowup(); assert.deepEqual(calls.at(-1).patch, { groupFollowupEnabled: false });
  await c.logout(); finish(new Response(JSON.stringify(config))); await pending;
  assert.equal(c.state.authenticated, false); assert.deepEqual(c.state.config, {});
});

test('白名单与插件双向同步，保存模型不再提交旧定时字段，群草稿不反转插件设置', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let c;
  await renderToString(createSSRApp({ setup() { c = useConsole(); return () => null; } }));
  c.state.authenticated = true;
  let saved = { allowedGroups: [{ id: '10003', ds: true, video: true, scheduledChat: false }], proactiveChatEnabled: false };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options?.method === 'PUT') { const patch = JSON.parse(options.body); calls.push(patch); saved = { ...saved, ...patch }; }
    return new Response(JSON.stringify(url === '/api/status' ? {} : saved));
  });
  c.state.config = structuredClone(saved); c.state.groupRules = [{ id: '10003', ds: false, video: true, scheduledChat: true }, { id: '10004', ds: true, video: false }];
  await c.saveGroups();
  assert.deepEqual(calls[0].allowedGroups, [{ id: '10003', ds: false, video: true, scheduledChat: false }, { id: '10004', ds: true, video: false, scheduledChat: true }]);
  c.state.model = { proactiveChatEnabled: true, groupFollowupEnabled: true, model: 'saved-model' }; await c.saveModel();
  assert.equal(Object.hasOwn(calls[1], 'proactiveChatEnabled'), false); assert.equal(Object.hasOwn(calls[1], 'groupFollowupEnabled'), false);
  saved = { ...saved, allowedGroups: ['10005'] }; await c.refresh();
  assert.deepEqual(c.state.config.allowedGroups, ['10005']); // Plugin rows derive from saved config, never the stale form draft.
});

test('自定义时间草稿不被轮询覆盖，单独保存排序后的计划，失败与退出不恢复旧状态', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let c, finish;
  await renderToString(createSSRApp({ setup() { c = useConsole(); return () => null; } }));
  c.state.authenticated = true; c.state.config = { scheduledChatTimes: ['12:00', '15:00', '18:00'] };
  c.state.scheduledChatTimes = ['21:45', '09:30', '09:30']; const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/logout') return new Response('{}');
    if (!options?.method) return new Response(JSON.stringify(url === '/api/status' ? {} : c.state.config));
    calls.push(JSON.parse(options.body)); return new Promise(resolve => finish = resolve);
  });
  await c.refresh(); assert.deepEqual(c.state.scheduledChatTimes, ['21:45', '09:30', '09:30']);
  let pending = c.saveScheduledChatTimes(); await c.saveScheduledChatTimes();
  assert.deepEqual(calls, [{ scheduledChatTimes: ['21:45', '09:30', '09:30'] }]);
  finish(new Response(JSON.stringify({ scheduledChatTimes: ['09:30', '21:45'] }))); await pending;
  assert.deepEqual(c.state.scheduledChatTimes, ['09:30', '21:45']);
  c.state.scheduledChatTimes = ['']; pending = c.saveScheduledChatTimes(); finish(new Response(JSON.stringify({ error: '时间格式无效' }), { status: 400 })); await pending;
  assert.deepEqual(c.state.scheduledChatTimes, ['']); assert.deepEqual(c.state.config.scheduledChatTimes, ['09:30', '21:45']);
  pending = c.saveScheduledChatTimes(); await c.logout(); finish(new Response(JSON.stringify({ scheduledChatTimes: ['10:00'] }))); await pending;
  assert.equal(c.state.scheduledChatTimes, null); assert.deepEqual(c.state.config, {});
});

test('订阅插件路由、快捷开关和刷新保留草稿，退出后迟到响应不恢复订阅信息',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const oldLocation=globalThis.location,oldHistory=globalThis.history;
 globalThis.location={hash:'#plugins/subscriptions'};globalThis.history={replaceState(_s,_t,hash){globalThis.location.hash=hash;}};
 t.after(()=>{if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;if(oldHistory===undefined)delete globalThis.history;else globalThis.history=oldHistory;});
 let c,finish;await renderToString(createSSRApp({setup(){c=useConsole();return()=>null;}}));
 c.navigate('plugins/subscriptions');assert.equal(c.state.page,'plugins');assert.equal(c.state.pluginDetail,'subscriptions');assert.equal(location.hash,'#plugins/subscriptions');
 c.state.authenticated=true;const settings={enabled:false,intervalMinutes:10,rsshubUrl:'https://rsshub.app'},calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});if(url==='/api/logout')return new Response('{}');return new Promise(r=>finish=r);});
 let pending=c.loadSubscriptions();finish(new Response(JSON.stringify({settings,entries:[]})));await pending;
 c.state.subscriptionSettings.intervalMinutes=25;c.state.subscriptionDraft.name='未保存订阅';
 pending=c.saveSubscriptionSettings(true);await c.saveSubscriptionSettings(true);assert.deepEqual(JSON.parse(calls.at(-1).options.body),{enabled:true});
 finish(new Response(JSON.stringify({settings:{...settings,enabled:true},entries:[]})));await pending;assert.equal(c.state.subscriptionSettings.intervalMinutes,25);assert.equal(c.state.subscriptionSettings.enabled,true);assert.equal(c.state.subscriptionDraft.name,'未保存订阅');
 const entry={id:'test-id',name:'Release',type:'github',source:'owner/repo',groups:['10003'],enabled:true,include:'',exclude:''};
 c.editSubscription(entry);c.state.subscriptionDraft.groups.push('10005');assert.deepEqual(entry.groups,['10003']);assert.equal(c.state.subscriptionDraft.crossPlatformMatch,true);
 c.editSubscription({...entry,crossPlatformMatch:false});assert.equal(c.state.subscriptionDraft.crossPlatformMatch,false);
 pending=c.subscriptionAction(entry.id,'preview');await c.logout();finish(new Response(JSON.stringify({title:'迟到的源',items:[]})));await pending;
 assert.equal(c.state.subscriptions,null);assert.equal(c.state.subscriptionSettings,null);assert.equal(c.state.subscriptionDraft.name,'');assert.equal(c.state.subscriptionPreview,null);
});

test('按群取消订阅只修改当前群，最后一个群才删除来源，失败保留其他目标', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let c;
  await renderToString(createSSRApp({setup(){c=useConsole();return()=>null;}}));
  const entry={id:'one',name:'测试博主',type:'bilibili',source:'123',groups:['10001','10002'],enabled:true,include:'',exclude:''};
  c.state.subscriptions={settings:{enabled:true},entries:[structuredClone(entry)]};
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url,method:options.method,body:JSON.parse(options.body)});
    return new Response(JSON.stringify({settings:{enabled:true},entries:url.endsWith('/remove')?[]:[{...entry,groups:['10002']}]}));
  });
  const firstRemoval = c.removeSubscriptionGroup('one','10001'); c.resolveConfirmation(true); await firstRemoval;
  assert.deepEqual(calls[0],{url:'/api/subscriptions/one',method:'PUT',body:{groups:['10002']}});
  assert.deepEqual(c.state.subscriptions.entries[0].groups,['10002']);
  const duplicateRemoval = c.removeSubscriptionGroup('one','10001'); c.resolveConfirmation(true); await duplicateRemoval; assert.equal(calls.length,1);
  const lastRemoval = c.removeSubscriptionGroup('one','10002'); assert.equal(c.state.confirmation.title, '删除这条订阅？'); c.resolveConfirmation(true); await lastRemoval;
  assert.deepEqual(calls[1],{url:'/api/subscriptions/one/remove',method:'POST',body:{}});
  assert.deepEqual(c.state.subscriptions.entries,[]);
  c.state.subscriptions.entries=[structuredClone(entry)];
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:'保存失败'}),{status:500}));
  const failedRemoval = c.removeSubscriptionGroup('one','10001'); c.resolveConfirmation(true); await failedRemoval;
  assert.deepEqual(c.state.subscriptions.entries[0].groups,['10001','10002']);assert.equal(c.state.toast.error,true);
});

test('OpenAI 保存独立字段并同步规范化地址，留空保留两家密钥', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { defaultConfig, publicConfig, validatePatch } = await import('../src/config.mjs');
  let c; await renderToString(createSSRApp({ setup() { c = useConsole(); return () => null; } }));
  let config = { ...defaultConfig(), deepseekKey: 'DS_TEST_ONLY', openaiKey: 'OLD_OPENAI_TEST_ONLY' };
  c.state.config = publicConfig(config);
  c.state.model = { ...publicConfig(config), apiProvider: 'openai', openaiUrl: 'https://api.openai.com/v1/', openaiKey: '  ', deepseekKey: '' };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/models') return Response.json({ models: [{ id: 'gpt-4.1-mini' }] });
    assert.equal(url, '/api/config'); const patch = JSON.parse(options.body); calls.push(patch);
    config = validatePatch(config, patch); return Response.json(publicConfig(config));
  });
  await c.saveModel(); await Promise.resolve();
  assert.equal(calls[0].apiProvider, 'openai'); assert.equal(calls[0].openaiMaxTokensUnlimited, true);
  assert.equal(Object.hasOwn(calls[0], 'openaiKey'), false); assert.equal(Object.hasOwn(calls[0], 'deepseekKey'), false);
  assert.equal(c.state.model.openaiUrl, 'https://api.openai.com/v1'); assert.equal(c.state.model.openaiKey, '');
  assert.equal(config.deepseekKey, 'DS_TEST_ONLY'); assert.equal(config.openaiKey, 'OLD_OPENAI_TEST_ONLY');
  assert.equal(c.state.config.modelApiKeyConfigured, true); assert.equal(c.state.config.activeModel, 'gpt-4.1-mini');
  assert.deepEqual(configPatch({ openaiMaxTokens: '4096', openaiMaxTokensUnlimited: false }, ['openaiMaxTokens', 'openaiMaxTokensUnlimited']), { openaiMaxTokens: 4096, openaiMaxTokensUnlimited: false });
});

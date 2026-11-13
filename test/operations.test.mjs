import test from 'node:test';import assert from 'node:assert/strict';import{mkdtempSync,rmSync,writeFileSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import {Operations,reportWindow,billSummary,reportEmail} from '../src/operations.mjs';import {TokenUsageService} from '../src/token-usage.mjs';import{defaultConfig,publicConfig,validatePatch,openStore}from'../src/config.mjs';import{fallbackConfig,modelConfig}from'../src/model-provider.mjs';import{Bot}from'../src/bot.mjs';
const folder=t=>{const dir=mkdtempSync(join(tmpdir(),'ops-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const result={choices:[{message:{content:'回复成功'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}};
const profile=(id,provider,extra={})=>({id,name:id,provider,baseUrl:`https://${provider}.example/v1`,apiKey:'TEST_ONLY',model:id,protocol:'chat',vision:true,tools:true,effort:'low',maxTokens:4096,...extra});
test('群聊、私聊、工具与系统任务归属，筛选和重启持久化，旧数据只回填一次',t=>{
 const dir=folder(t),m=new TokenUsageService(dir);const scope={kind:'group',groupId:'10001',userId:'20001',userName:'小鱼'};
 m.record({provider:'deepseek',model:'deepseek-flash',timestamp:'2026-11-03T10:00:00+08:00',scope,usage:{prompt_tokens:1000,completion_tokens:1000,total_tokens:2000}});m.recordTool('search','2026-11-03T10:00:00+08:00',scope);
 m.record({provider:'kimi',model:'kimi-k3.1-pro',timestamp:'2026-11-04T10:00:00+08:00',scope:{kind:'private',userId:'20002'},totalTokens:30});
 const s=m.scopeStatus({start:'2026-11-03',end:'2026-11-03'});assert.equal(s.totals.tokens,2000);assert.equal(s.totals.totalCost,.015);assert.equal(s.users[0].name,'小鱼');assert.equal(s.scopes[0].kind,'group');assert.deepEqual(new TokenUsageService(dir).scopeStatus(),m.scopeStatus());
 m.importScopeHistory([{day:'2026-10-01',groupId:'private',userId:'20003',model:'missing',calls:1,tokens:100}]);assert.equal(m.scopeStatus().totals.tokens,2130);assert.equal(m.scopeStatus({end:'2026-10-01'}).totals.totalCost,0);
 m.importScopeHistory([{day:'2026-10-01',groupId:'private',userId:'20003',model:'missing',calls:1,tokens:100}]);assert.equal(m.scopeStatus().totals.tokens,2130);
});
test('每周邮件北京时间窗口、账单内容及发送去重，不调用 QQ 私聊',async t=>{
 let now=Date.parse('2026-11-09T08:00:00+08:00');const c={...defaultConfig(),billReportEnabled:true,smtpHost:'smtp.example.com',smtpUser:'TEST_USER',smtpPassword:'TEST_PASSWORD',emailAlertRecipient:'admin@example.com',billReportFrequency:'weekly'};assert.deepEqual(reportWindow(now,c),{key:'weekly:2026-11-09',start:'2026-11-02',end:'2026-11-08'});assert.equal(reportWindow(now+16*60000,c),null);
 const dir=folder(t),m=new TokenUsageService(dir);m.record({model:'deepseek-flash',timestamp:'2026-11-08T10:00:00+08:00',totalTokens:100});assert.equal(billSummary(m,reportWindow(now,c)).tokens,100);
 let sent=0;const bot={log(){},onebot:async()=>{assert.fail('不能再发送 QQ 私聊');}};const opts={now:()=>now,sendMail:async(config,subject,text,html)=>{assert.equal(config.emailAlertRecipient,'admin@example.com');assert.ok(subject.includes('账单'));assert.ok(text.includes('100'));assert.ok(html.includes('上')||html.includes('Tokens'));sent++;}};const ops=new Operations(dir,{config:c},bot,{},m,opts);await ops.tick();await ops.tick();assert.equal(sent,1);await new Operations(dir,{config:c},bot,{},m,opts).tick();assert.equal(sent,1);ops.close();
});
test('QQ 离线连续三次才通知、去重、恢复后可再次告警；失败延迟重试',async t=>{
 let now=Date.parse('2026-11-04T10:00:00+08:00'),online=false,sent=0,fail=false;
 const c={...defaultConfig(),emailAlertsEnabled:true,consolePublicUrl:'https://bot.example'};const dir=folder(t);const ops=new Operations(dir,{config:c},{log(){}},{status:async()=>({qq:{state:online?'online':'offline'}})},new TokenUsageService(dir),{now:()=>now,sendMail:async(config,subject,text)=>{assert.ok(text.includes('https://bot.example/#connection'));if(fail)throw Error('TEST');sent++;}});
 await ops.tick();await ops.tick();assert.equal(sent,0);await ops.tick();await ops.tick();assert.equal(sent,1);online=true;await ops.tick();now+=360000;online=false;fail=true;await ops.tick();await ops.tick();await ops.tick();assert.equal(sent,1);fail=false;await ops.tick();assert.equal(sent,1);now+=360000;await ops.tick();assert.equal(sent,2);ops.close();
});
test('故障只切换一次，权限错误及取消不切换，能力不匹配不选用',async t=>{
 const config={...defaultConfig(),deepseekKey:'TEST',webSearchEnabled:false,modelProfiles:[profile('backup','kimi')],modelFallbackProfileId:'backup'};const bot=new Bot({config});t.after(()=>bot.close());let n=0;
 bot.request=async()=>{if(++n===1)throw Error('上游 HTTP 429');return result;};const trace={};assert.equal((await bot.completion('你好',config,trace)).text,'回复成功');assert.equal(n,2);assert.equal(trace.fallbackTo,'backup');
 bot.request=async()=>{n++;throw Error('上游 HTTP 503');};n=0;await assert.rejects(bot.completion('你好',config));assert.equal(n,2);
 bot.request=async()=>{n++;throw Error('上游 HTTP 401');};n=0;await assert.rejects(bot.completion('你好',config));assert.equal(n,1);
 assert.equal(fallbackConfig(modelConfig({...config,modelProfiles:[profile('backup','kimi',{vision:false})]}),{images:true}),null);
 n=0;await assert.rejects(bot.completion('你好',config,{},[],[],()=>{throw Object.assign(Error('取消'),{cancelled:true});}));assert.equal(n,0);
});
test('SMTP 密钥不回显，设置校验及备用模型校验',()=>{
 const base=defaultConfig();assert.throws(()=>validatePatch(base,{emailAlertsEnabled:true}));assert.throws(()=>validatePatch(base,{modelFallbackProfileId:'missing'}));assert.throws(()=>validatePatch(base,{billReportTime:'99:00'}));const c=validatePatch(base,{smtpHost:'smtp.example.com',smtpUser:'test@example.com',smtpPassword:'TEST_ONLY',emailAlertRecipient:'admin@example.com',emailAlertsEnabled:true});assert.equal(publicConfig(c).smtpPassword,undefined);assert.equal(publicConfig(c).smtpPasswordConfigured,true);
});


test('只在周一发送；邮件 HTML 转义模型名；SMTP 未配置不消耗发送机会',async t=>{
 const now=Date.parse('2026-11-10T08:00:00+08:00');assert.equal(reportWindow(now,defaultConfig()),null);
 const mail=reportEmail({start:'2026-11-02',end:'2026-11-08',cost:1,tokens:10,calls:2,channels:[{provider:'<script>bad</script>',cost:1,tokens:10,calls:2}]});assert.ok(!mail.html.includes('<script>'));assert.ok(mail.html.includes('&lt;script&gt;'));assert.ok(mail.text.includes('¥1.0000'));
 const dir=folder(t),c={...defaultConfig(),billReportEnabled:true},ops=new Operations(dir,{config:c},{log(){}},{},new TokenUsageService(dir),{now:()=>Date.parse('2026-11-09T08:00:00+08:00'),sendMail:async()=>assert.fail('SMTP 未配置')});
 await ops.tick();assert.equal(Object.keys(ops.status().reports).length,0);ops.close();
 assert.throws(()=>validatePatch(defaultConfig(),{billReportEnabled:true}),/SMTP/);
});

test('旧每日私聊设置迁移为每周邮件，移除 QQ 收件人，连接凭据保持不变',async t=>{
 const dir=folder(t);writeFileSync(join(dir,'config.json'),JSON.stringify({...defaultConfig(),billReportFrequency:'daily',billReportRecipient:'20001',onebotToken:'TEST_CONNECTION_TOKEN'}));
 const store=await openStore(dir);assert.equal(store.config.billReportFrequency,'weekly');assert.equal(store.config.billReportRecipient,undefined);assert.equal(store.config.onebotToken,'TEST_CONNECTION_TOKEN');
 const next=validatePatch(store.config,{smtpHost:'smtp.example.com',smtpUser:'sender@example.com',smtpPassword:'TEST_ONLY',emailAlertRecipient:'admin@example.com',billReportEnabled:true,emailAlertsEnabled:false});assert.equal(next.billReportEnabled,true);
});

test('每周账单失败后按退避间隔自动重试（含跨过 15 分钟窗口与重启后），成功后继续去重', async t => {
 let now = Date.parse('2026-11-09T08:00:00+08:00'), fail = true, sent = 0;
 const warnings = [];
 const c = { ...defaultConfig(), billReportEnabled: true, smtpHost: 'smtp.example.com', smtpUser: 'TEST_USER', smtpPassword: 'TEST_SECRET_PASSWORD', emailAlertRecipient: 'admin@example.com' };
 const dir = folder(t), m = new TokenUsageService(dir), bot = { log: (lvl, msg) => warnings.push(`${lvl}:${msg}`) };
 const makeOps = () => new Operations(dir, { config: c }, bot, {}, m, {
   now: () => now,
   sendMail: async () => { if (fail) throw new Error(c.smtpPassword); sent++; }
 });

 const ops1 = makeOps();
 await ops1.tick();
 assert.equal(sent, 0);
 assert.equal(ops1.status().reports['weekly:2026-11-09'].status, 'failed');
 assert.equal(ops1.status().reports['weekly:2026-11-09'].attempts, 1);

 // 4 分钟后尚未到达 5 分钟退避窗口，不重试
 now += 4 * 60000;
 await ops1.tick();
 assert.equal(ops1.status().reports['weekly:2026-11-09'].attempts, 1);

 // 第 5 分钟同进程内触发第 2 次尝试，仍失败则进入 10 分钟退避（推迟到 08:15 之后）
 now += 60000;
 await ops1.tick();
 assert.equal(ops1.status().reports['weekly:2026-11-09'].attempts, 2);

 // 第 08:14（仅过去 9 分钟）重启也不提前重试
 now += 9 * 60000;
 ops1.close();
 const ops2 = makeOps();
 await ops2.tick();
 assert.equal(ops2.status().reports['weekly:2026-11-09'].attempts, 2);
 assert.equal(sent, 0);

 // 08:20 已超出 08:00~08:15 触发窗口，恢复正常并在重启实例中完成补发
 now += 6 * 60000;
 assert.equal(reportWindow(now, c), null);
 fail = false;
 await ops2.tick();
 assert.equal(sent, 1);
 assert.equal(ops2.status().reports['weekly:2026-11-09'].status, 'sent');

 // 成功后同进程与再次重启均去重
 await ops2.tick();
 ops2.close();
 await makeOps().tick();
 assert.equal(sent, 1);
 assert.ok(warnings.every(w => !w.includes(c.smtpPassword)));
});

test('每周账单兼容恢复重启中断的 sending 与旧版 failed 记录，超出重试上限或停机后正常收敛', async t => {
 let now = Date.parse('2026-11-09T08:00:00+08:00'), sent = 0;
 const c = { ...defaultConfig(), billReportEnabled: true, smtpHost: 'smtp.example.com', smtpUser: 'TEST_USER', smtpPassword: 'TEST_SECRET_PASSWORD', emailAlertRecipient: 'admin@example.com' };
 const dir = folder(t), m = new TokenUsageService(dir);
 const bot = { log() {} };

 // 1. 磁盘残留旧进程中断的 sending 状态
 writeFileSync(join(dir, 'operations.json'), JSON.stringify({ reports: { 'weekly:2026-11-09': { at: now, status: 'sending' } } }));
 now += 6 * 60000;
 const opsSending = new Operations(dir, { config: c }, bot, {}, m, { now: () => now, sendMail: async () => { sent++; } });
 await opsSending.tick();
 assert.equal(sent, 1);
 assert.equal(opsSending.status().reports['weekly:2026-11-09'].status, 'sent');
 opsSending.close();

 // 2. 磁盘残留旧版仅含 at/status=failed 的记录
 const dirLegacy = folder(t);
 let legacyNow = Date.parse('2026-11-09T08:00:00+08:00'), legacySent = 0;
 writeFileSync(join(dirLegacy, 'operations.json'), JSON.stringify({ reports: { 'weekly:2026-11-09': { at: legacyNow, status: 'failed' } } }));
 legacyNow += 5 * 60000;
 const opsLegacy = new Operations(dirLegacy, { config: c }, bot, {}, new TokenUsageService(dirLegacy), { now: () => legacyNow, sendMail: async () => { legacySent++; } });
 await opsLegacy.tick();
 assert.equal(legacySent, 1);
 assert.equal(opsLegacy.status().reports['weekly:2026-11-09'].status, 'sent');
 opsLegacy.close();

 // 3. 重试达到上限后不再重试
 const dirCap = folder(t);
 let capNow = Date.parse('2026-11-09T08:00:00+08:00'), attempts = 0;
 const opsCap = new Operations(dirCap, { config: c }, bot, {}, new TokenUsageService(dirCap), {
   now: () => capNow,
   sendMail: async () => { attempts++; throw new Error('SMTP down'); }
 });
 await opsCap.tick();
 for (let i = 0; i < 15; i++) {
   const next = opsCap.status().reports['weekly:2026-11-09'].nextRetryAt;
   if (!next) { capNow += 2 * 3600000; await opsCap.tick(); continue; }
   capNow = next;
   await opsCap.tick();
 }
 assert.equal(attempts, 12);
 assert.equal(opsCap.status().reports['weekly:2026-11-09'].status, 'failed');
 assert.equal(opsCap.status().reports['weekly:2026-11-09'].nextRetryAt, undefined);
 opsCap.close();
});

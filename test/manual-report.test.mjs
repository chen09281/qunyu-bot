import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Operations} from '../src/operations.mjs';
import {TokenUsageService} from '../src/token-usage.mjs';
import {defaultConfig,validatePatch,publicConfig} from '../src/config.mjs';
const folder=t=>{const dir=mkdtempSync(join(tmpdir(),'manual-bill-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const saved=()=>({...defaultConfig(),smtpHost:'smtp.example.com',smtpUser:'sender@example.com',smtpPassword:'TEST_ONLY_PASSWORD',emailAlertRecipient:'admin@example.com'});
const now=Date.parse('2026-11-04T18:00:00+08:00');
test('SMTP 授权码留空或不提交保留已有值；改变连接仍必须提供新授权码',()=>{
 const c=saved();for(const patch of [{smtpPassword:''},{smtpPassword:'   '},{billReportEnabled:true},{emailAlertsEnabled:true}])assert.equal(validatePatch(c,patch).smtpPassword,c.smtpPassword);
 assert.equal(validatePatch(c,{emailAlertsEnabled:true,smtpPassword:''}).emailAlertRecipient,c.emailAlertRecipient);
 assert.throws(()=>validatePatch(c,{smtpHost:'other.example.com',smtpPassword:''}),/重新填写/);
 assert.equal(publicConfig(c).smtpPassword,undefined);assert.equal(publicConfig(c).emailAlertRecipient,'admin@example.com');
});
test('手动邮件使用保存邮箱，可选本周或上周，不开启自动开关、不占用定时去重记录',async t=>{
 const dir=folder(t),config=saved(),m=new TokenUsageService(dir);let time=now;const sent=[];
 const ops=new Operations(dir,{config},{log(){}},{},m,{now:()=>time,sendMail:async(c,subject,text,html)=>sent.push({to:c.emailAlertRecipient,subject,text,html})});
 const last=await ops.sendReport();assert.equal(last.start,'2026-10-26');assert.equal(last.end,'2026-11-01');assert.equal(last.recipient,config.emailAlertRecipient);assert.equal(last.status,'sent');
 await assert.rejects(ops.sendReport(),e=>e.status===429);time+=30001;
 const current=await ops.sendReport('week');assert.equal(current.start,'2026-11-02');assert.equal(current.end,'2026-11-04');assert.equal(sent.length,2);assert.equal(config.billReportEnabled,false);assert.equal(Object.keys(ops.state.reports).length,0);
 assert.equal(new Operations(dir,{config},{log(){}},{},m).status().lastManualReport.status,'sent');ops.close();
});
test('不完整配置/非法周期拒绝发送，并发防重复，邮件错误不泄露授权码',async t=>{
 const dir=folder(t),config=saved(),meter=new TokenUsageService(dir);let done;const ops=new Operations(dir,{config},{log(){}},{},meter,{now:()=>now,sendMail:()=>new Promise(resolve=>{done=resolve;})});
 await assert.rejects(ops.sendReport('invalid'),e=>e.status===400);const running=ops.sendReport();await assert.rejects(ops.sendReport(),e=>e.status===409);done();await running;ops.close();
 const missing=new Operations(folder(t),{config:defaultConfig()},{log(){}},{},meter);await assert.rejects(missing.sendReport(),e=>e.status===400);
 const failed=new Operations(folder(t),{config},{log(){}},{},meter,{sendMail:async()=>{throw Error(config.smtpPassword);}});await assert.rejects(failed.sendReport(),e=>e.status===502&&!e.message.includes(config.smtpPassword));assert.equal(failed.status().lastManualReport.status,'failed');assert.equal(failed.busy,false);
});
test('手动账单接口需登录且同源，只用保存的邮箱；保存空授权码后仍可发送',async t=>{
 const {createApplication}=await import('../src/server.mjs');let sent=0;
 const app=await createApplication({dataDir:folder(t),initialPassword:'test-manual-billing',operationsAutoStart:false,operationsOptions:{now:()=>now,sendMail:async c=>{assert.equal(c.emailAlertRecipient,'admin@example.com');assert.equal(c.smtpPassword,'TEST_ONLY_PASSWORD');sent++;}},bilibiliAutoStart:false,douyinAutoStart:false,checkinAutoStart:false,subscriptionAutoStart:false,scheduledChatAutoStart:false,serverStatusAutoStart:false});
 app.store.save(Object.fromEntries(Object.entries(saved()).filter(([key])=>['smtpHost','smtpUser','smtpPassword','emailAlertRecipient'].includes(key))));await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();}));
 const base=`http://127.0.0.1:${app.server.address().port}`,endpoint=base+'/api/operations/report',headers={'Content-Type':'application/json','X-Admin-Request':'1'};
 assert.equal((await fetch(endpoint,{method:'POST',headers,body:'{}'})).status,401);
 const login=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({username:'admin',password:'test-manual-billing'})});headers.Cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await fetch(endpoint,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
 assert.equal((await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({recipient:'evil@example.com'})})).status,400);
 assert.equal((await fetch(base+'/api/operations',{method:'PUT',headers,body:JSON.stringify({smtpPassword:'',billReportEnabled:true})})).status,200);
 const info=await(await fetch(base+'/api/operations',{headers})).json();assert.equal(info.config.emailAlertRecipient,'admin@example.com');assert.equal(info.smtpPasswordConfigured,true);assert.equal(JSON.stringify(info).includes('TEST_ONLY_PASSWORD'),false);
 const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({period:'week'})});assert.equal(response.status,200);assert.equal((await response.json()).recipient,'admin@example.com');assert.equal(sent,1);
});

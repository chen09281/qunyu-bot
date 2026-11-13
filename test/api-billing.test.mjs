import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenUsageService } from '../src/token-usage.mjs';
const folder = t => { const d=mkdtempSync(join(tmpdir(),'api-billing-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d; };
const baseline={provider:'deepseek',currency:'CNY',label:'qqbot',cost:4.4,tokens:1621478,requests:549};
const record=(m,model='deepseek-flash',provider='deepseek')=>m.record({provider,model,timestamp:'2026-11-03T10:00:00+08:00',usage:{prompt_tokens:1000,completion_tokens:1000,total_tokens:2000}});
test('官方基准覆盖旧估算，后续模型及工具合并，重启和调价不改变已累计费用',t=>{
 const dir=folder(t),m=new TokenUsageService(dir);record(m);m.recordTool('search');
 m.calibrateApi(baseline);let row=m.apiStatus().rows[0];assert.equal(row.cost,4.4);assert.equal(row.tokens,1621478);assert.equal(row.requests,549);
 record(m);record(m,'deepseek-v4-pro');m.recordTool('fetch','2026-11-03T10:00:00+08:00');
 row=m.apiStatus().rows[0];assert.equal(row.cost,4.451);assert.equal(row.tokens,1625478);assert.equal(row.requests,552);assert.equal(row.added.cost,.051);
 const again=new TokenUsageService(dir);assert.deepEqual(again.apiStatus(),m.apiStatus());
 again.configurePricing({customModels:[{provider:'deepseek',model:'deepseek-flash',inputPrice:999,outputPrice:999}]});assert.equal(again.apiStatus().rows[0].cost,4.451);
 assert.equal(again.status().totals.calls,3); // 原始记录未删除
});
test('基准文件只初始化一次；后续校准重置新增并保留审计，不被重启覆盖',t=>{
 const dir=folder(t);writeFileSync(join(dir,'api-billing-baselines.json'),JSON.stringify({id:'test-snapshot',rows:[baseline]}));
 const m=new TokenUsageService(dir);record(m);assert.equal(new TokenUsageService(dir).apiStatus().rows[0].cost,4.41);
 m.calibrateApi({...baseline,cost:5,requests:600});assert.equal(new TokenUsageService(dir).apiStatus().rows[0].cost,5);assert.equal(m.state.apiBilling.deepseek.audit.length,1);
 m.clear();assert.equal(new TokenUsageService(dir).apiStatus().rows.length,0);
});
test('API 汇总合并同一渠道全部模型并自动将 USD 折算为 RMB；未校准渠道标记估算',t=>{
 const m=new TokenUsageService(folder(t));record(m);record(m,'deepseek-v4-pro');m.recordTool('search');record(m,'gpt-6-sol','openai');
 let rows=m.apiStatus().rows;assert.equal(rows.length,2);assert.equal(rows.find(r=>r.provider==='deepseek').requests,3);assert.equal(rows[0].official,null);
 m.calibrateApi({...baseline,provider:'openai',currency:'CNY'});record(m,'gpt-6-sol','openai');rows=m.apiStatus().rows.filter(r=>r.provider==='openai');assert.equal(rows.length,1);assert.equal(rows[0].currency,'CNY');assert.equal(rows[0].official.cost,4.4);assert.equal(rows[0].added.cost,.087);assert.equal(rows[0].cost,4.487);
});
test('校准输入必须有效，不接受负数/缺失值/小数请求',t=>{
 const m=new TokenUsageService(folder(t));for(const input of [{cost:-1},{tokens:1.2},{requests:''},{provider:'invalid'},{currency:'EUR'},{cost:undefined}])assert.throws(()=>m.calibrateApi({...baseline,...input}));
 assert.equal(m.apiStatus().rows.length,0);
});
test('官方截止日之后、校准之前已记录的调用补入新增，截止前的不重复计入',t=>{
 const now=Date.parse('2026-11-03T22:00:00+08:00'),m=new TokenUsageService(folder(t),{now:()=>now});
 m.record({provider:'deepseek',model:'deepseek-flash',timestamp:'2026-11-02T10:00:00+08:00',usage:{prompt_tokens:1000,completion_tokens:1000,total_tokens:2000}});
 record(m);m.recordTool('search','2026-11-03T10:00:00+08:00');
 m.calibrateApi({...baseline,asOf:'2026-11-03'});
 const row=m.apiStatus().rows.find(r=>r.provider==='deepseek');
 assert.equal(row.asOf,'2026-11-03');assert.equal(row.added.tokens,2000);assert.equal(row.added.requests,2);assert.equal(row.added.cost,.015);assert.equal(row.cost,4.415);
 assert.throws(()=>m.calibrateApi({...baseline,asOf:'2026-02-30'}),/截止日期/);
});

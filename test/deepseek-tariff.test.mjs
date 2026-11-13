import test from 'node:test';import assert from 'node:assert/strict';import{mkdtempSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import {deepseekTariff} from '../src/deepseek-tariff.mjs';import{TokenUsageService}from'../src/token-usage.mjs';import{searchWeb,fetchSearchPage}from'../src/web-search.mjs';
const folder=t=>{const d=mkdtempSync(join(tmpdir(),'tariff-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d};
test('北京时间高峰边界、午间、周末、节假日和调休周末',()=>{
 for(const [time,peak] of [['08:59',false],['09:00',true],['11:59',true],['12:00',false],['13:59',false],['14:00',true],['17:59',true],['18:00',false]]) assert.equal(deepseekTariff(`2026-11-03T${time}:00+08:00`).peak,peak,time);
 for(const day of ['2026-11-01','2026-10-01','2026-02-16','2026-10-10']) assert.equal(deepseekTariff(`${day}T10:00:00+08:00`).peak,false,day);
 assert.equal(deepseekTariff('2026-11-03T01:00:00Z').peak,true);
 assert.equal(deepseekTariff('2027-01-01T10:00:00+08:00').calendarKnown,false);
});
test('官方模型按请求时间选价，不受旧窗口开关影响；其他模型不享折扣',t=>{
 const meter=new TokenUsageService(folder(t));meter.configurePricing({discountEnabled:false});
 for(const [time,cost,period] of [['10:00',10,'standard'],['12:00',5,'discount'],['15:00',10,'standard'],['19:00',5,'discount']]){
 const r=meter.record({provider:'deepseek',model:'deepseek-flash',timestamp:`2026-11-03T${time}:00+08:00`,usage:{prompt_tokens:1e6,completion_tokens:1e6,total_tokens:2e6}});assert.equal(r.cost,cost);assert.equal(r.period,period);
 }
 assert.equal(meter.status().totals.cost,30);
 const r=meter.record({provider:'kimi',model:'kimi-k3.1-pro',timestamp:'2026-11-03T19:00:00+08:00',usage:{prompt_tokens:1e6,completion_tokens:1e6,total_tokens:2e6}});assert.equal(r.cost,81);
});
test('成功工具调用按次计费，失败不计，不计入 Token，重启保留',async t=>{
 const dir=folder(t),meter=new TokenUsageService(dir);let failed=false;
 const bot={tokenUsage:meter,request:async()=>{if(failed)throw Error('HTTP 429');return{results:[],content:'page'}}};const provider={kind:'deepseek',url:'https://api.deepseek.com',key:'test-only'};
 await searchWeb(bot,provider,'query',5,false,10);await fetchSearchPage(bot,provider,'https://example.com',10);failed=true;await assert.rejects(searchWeb(bot,provider,'query',5,false,10));
 assert.equal(meter.status().totals.toolCost,.01);assert.equal(meter.status().totals.toolCalls,2);assert.equal(meter.status().totals.totalTokens,0);
 assert.equal(new TokenUsageService(dir).status().totals.toolCost,.01);
});
test('旧实时调用按保留时间戳校正，重启不重复移动 Token',t=>{
 const dir=folder(t),meter=new TokenUsageService(dir);
 meter.record({provider:'deepseek',model:'deepseek-flash',timestamp:'2026-11-03T19:00:00+08:00',usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}});
 for(const bucket of [meter.state.models['deepseek:deepseek-flash'],meter.state.days['2026-11-03'].models['deepseek:deepseek-flash']]){
 for(const field of ['Calls','Tokens','UncachedPromptTokens','CachedTokens','CompletionTokens']){bucket['standard'+field]=bucket['discount'+field];bucket['discount'+field]=0;}}
 meter.state.recent[0].period='standard';meter.state.tariffMigration=null;
 meter.state.officialImport={reconciledVersion:2,id:'a'.repeat(64),start:'2026-10-16T00:00:00+08:00',end:'2026-10-17T00:00:00+08:00',rows:[{model:'deepseek-flash',name:'deepseek-flash',start:'2026-10-16T00:00:00+08:00',end:'2026-10-17T00:00:00+08:00',counts:{request_count:1,input_cache_miss_tokens:1},actualCost:'.000001'}]};meter.save();
 const migrated=new TokenUsageService(dir);assert.equal(migrated.status().totals.discountTokens,110);assert.equal(migrated.status().recent[0].period,'discount');assert.equal(migrated.status().totals.standardTokens,0);assert.equal(new TokenUsageService(dir).status().totals.discountTokens,110);
});

test('Kimi 旧服务商迁移不重复累计模型和每日 Token',t=>{
 const d=folder(t),meter=new TokenUsageService(d);meter.record({provider:'unknown',model:'k3.1-pro',totalTokens:123});
 const reopened=new TokenUsageService(d).status();assert.equal(reopened.totals.totalTokens,123);assert.equal(reopened.byDay[0].totalTokens,123);
});

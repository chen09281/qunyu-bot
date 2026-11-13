import test from 'node:test';import assert from 'node:assert/strict';import{mkdtempSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{TokenUsageService}from'../src/token-usage.mjs';import{billSummary,manualWindow}from'../src/operations.mjs';import{createReportEmail,reportEmail,trendSvg}from'../src/billing-report.mjs';
const dir=t=>{const d=mkdtempSync(join(tmpdir(),'mail-ui-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};
const now=Date.parse('2026-11-04T10:00:00+08:00');
test('日期/API 筛选应用于总额、渠道、缓存与图表；工具不产生 Token，历史仅总数标记未知',t=>{
 const m=new TokenUsageService(dir(t),{now:()=>now});
 m.record({provider:'deepseek',model:'deepseek-flash',timestamp:'2026-11-02T10:00:00+08:00',usage:{prompt_tokens:1000,prompt_cache_hit_tokens:200,completion_tokens:300,total_tokens:1300}});m.recordTool('search','2026-11-02T10:00:00+08:00');
 m.record({provider:'kimi',model:'kimi-k3.1-pro',timestamp:'2026-11-03T10:00:00+08:00',totalTokens:100});
 const all=billSummary(m,{start:'2026-11-02',end:'2026-11-03'});assert.equal(all.calls,3);assert.equal(all.tokens,1400);assert.equal(all.channels.length,2);assert.equal(all.details.cached,200);assert.equal(all.details.unknown,100);assert.equal(all.series[0].uncached,800);
 const kimi=billSummary(m,{start:'2026-11-02',end:'2026-11-03',provider:'kimi'});assert.equal(kimi.calls,1);assert.equal(kimi.tokens,100);assert.equal(kimi.channels.length,1);assert.equal(kimi.series.reduce((s,p)=>s+p.calls,0),1);
 const deepseek=billSummary(m,{start:'2026-11-02',end:'2026-11-02',provider:'deepseek'});assert.equal(deepseek.calls,2);assert.equal(deepseek.details.input,1000);assert.equal(deepseek.channels[0].cost,deepseek.cost);
});
test('自定义范围最多93天，拒绝无效/未来/倒置日期和未知 API',()=>{
 assert.deepEqual(manualWindow(now,'custom',{start:'2026-11-01',end:'2026-11-03',provider:'kimi'}),{start:'2026-11-01',end:'2026-11-03',provider:'kimi'});
 for(const filters of [{start:'2026-02-30',end:'2026-11-01'},{start:'2026-11-03',end:'2026-11-02'},{start:'2026-01-01',end:'2026-11-04'},{start:'2026-11-01',end:'2026-11-05'},{start:'2026-11-01',end:'2026-11-03',provider:'evil'}])assert.throws(()=>manualWindow(now,'custom',filters),e=>e.status===400);
});
test('图表与 Token 明细位于折叠区域，CID 附件可用，渲染失败保留数字数据',async()=>{
 const summary={start:'2026-11-02',end:'2026-11-03',cost:1,tokens:100,calls:1,channels:[{provider:'<unsafe>',cost:1,tokens:100,calls:1}],details:{input:70,output:30,cached:20,unknown:0},series:[{day:'2026-11-02',calls:1,tokens:100,uncached:50,cached:20,output:30,unknown:0}],updatedAt:new Date(now).toISOString()};
 const mail=await createReportEmail(summary,{renderChart:async()=>Buffer.from('89504e470d0a1a0a','hex')});assert.ok(mail.attachments.some(a=>a.cid==='billing-trend'));const detail=mail.html.split('<details')[1].split('</details>')[0];assert.ok(detail.includes('cid:billing-trend'));assert.ok(detail.includes('输入 Tokens'));assert.ok(!mail.html.includes('<unsafe>'));assert.ok(mail.html.includes('&lt;unsafe&gt;'));assert.ok(!mail.html.includes('<script'));assert.ok(mail.text.includes('参考消费：¥1.0000'));
 const fallback=await createReportEmail(summary,{renderChart:async()=>{throw Error('renderer unavailable');}});assert.ok(fallback.html.includes('图表暂未生成'));assert.ok(fallback.html.includes('2026-11-02'));assert.ok(!fallback.attachments.some(a=>a.cid==='billing-trend'));
 const svg=trendSvg(summary.series);assert.ok(!svg.includes('NaN'));assert.ok(svg.includes('API 请求次数'));assert.ok(svg.includes('Token 用量'));
});

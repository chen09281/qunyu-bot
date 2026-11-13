import {existsSync,readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {HelpImage} from './help-image.mjs';
export const apiNames={deepseek:'DeepSeek',kimi:'Kimi',openai:'OpenAI',anthropic:'Anthropic',unknown:'其他 API'};
const safe=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=x=>Number(x||0).toLocaleString('zh-CN');
const money=x=>`¥${Number(x||0).toFixed(4)}`;
const stamp=x=>x?new Date(x).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未记录';
export function trendSvg(series) {
  const maxCalls=Math.max(1,...series.map(r=>r.calls)),maxTokens=Math.max(1,...series.map(r=>r.tokens));
  const x=(i,base)=>base+ (series.length<2?210:i*420/(series.length-1));
  let svg='<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="390" viewBox="0 0 1120 390"><rect width="1120" height="390" rx="20" fill="#f3f5f4"/>';
  for(const [base,title,max] of [[70,'API 请求次数',maxCalls],[630,'Token 用量',maxTokens]]){
    svg+=`<text x="${base}" y="35" fill="#424b4e" font-size="19" font-family="sans-serif">${title}</text>`;
    for(let i=0;i<=2;i++){const y=90+i*95;svg+=`<line x1="${base}" y1="${y}" x2="${base+420}" y2="${y}" stroke="#dfe4e3"/><text x="${base-8}" y="${y+5}" text-anchor="end" fill="#738080" font-size="13">${num(Math.round(max*(2-i)/2))}</text>`;}
    for(const i of [...new Set([0,Math.floor((series.length-1)/2),series.length-1])])if(series[i])svg+=`<text x="${x(i,base)}" y="310" text-anchor="middle" fill="#738080" font-size="14">${safe(series[i].day.slice(5))}</text>`;
  }
  const pts=series.map((r,i)=>`${x(i,70)},${280-r.calls/maxCalls*190}`).join(' ');
  if(series.length)svg+=`<polygon points="${x(0,70)},280 ${pts} ${x(series.length-1,70)},280" fill="#c4d0d1" opacity=".45"/><polyline points="${pts}" fill="none" stroke="#7a9096" stroke-width="3"/>`;
  const width=Math.min(26,380/Math.max(1,series.length));
  series.forEach((r,i)=>{let y=280;for(const [key,color]of[['uncached','#8599a4'],['cached','#a4b6ab'],['output','#c4b6a3'],['unknown','#d1d5d4']]){const h=r[key]/maxTokens*190;y-=h;svg+=`<rect x="${x(i,630)-width/2}" y="${y}" width="${width}" height="${h}" fill="${color}"/>`;}});
  svg+='<text x="630" y="353" fill="#6f7d7e" font-size="13">蓝灰：未命中输入　鼠尾草：命中输入　米灰：输出　浅灰：未拆分</text></svg>';return svg;
}
async function renderTrend(series){
 const dir=mkdtempSync(join(tmpdir(),'qqbot-mail-chart-'));let renderer;
 try{const page=join(dir,'chart.html');writeFileSync(page,`<!doctype html><meta charset="utf-8"><style>body{margin:0}</style>${trendSvg(series)}`);renderer=new HelpImage({page:pathToFileURL(page),width:1120,height:390,label:'账单趋势图'});return Buffer.from((await renderer.create()).slice('base64://'.length),'base64');}
 finally{renderer?.cancel();rmSync(dir,{recursive:true,force:true});}
}
function character(){
 const path=fileURLToPath(new URL('./assets/denia.png',import.meta.url));
 return existsSync(path)?readFileSync(path):null;
}
export function reportEmail(s) {
 const channels=s.channels||[],details=s.details||{},series=s.series||[];
 const subject=`群屿 · 用量账单（${s.start} 至 ${s.end}）`;
 const channelText=channels.map(r=>`${apiNames[r.provider]||r.provider}：${money(r.cost)} / ${num(r.tokens)} Tokens / ${num(r.calls)} 次`).join('\n');
 const text=`${s.start} 至 ${s.end}（北京时间）\n参考消费：${money(s.cost)}\nTokens：${num(s.tokens)}\n请求次数：${num(s.calls)}\n${channelText}\nToken 明细：输入 ${num(details.input)}，输出 ${num(details.output)}，输入中缓存命中 ${num(details.cached)}，未拆分 ${num(details.unknown)}\n数据更新：${stamp(s.updatedAt)}\n官方基准校准：${stamp(s.calibratedAt)}\n本地已记录用量估算，以官方结算为准。`;
 const cell=(value,align='left')=>`<td style="padding:15px 0;border-bottom:1px solid #e2e7e5;text-align:${align};font-size:13px">${value}</td>`;
 const rows=channels.map(r=>`<tr>${cell(`<b>${safe(apiNames[r.provider]||r.provider)}</b>`)}${cell(money(r.cost),'right')}${cell(num(r.tokens),'right')}${cell(num(r.calls),'right')}</tr>`).join('');
 const trend=s.chartAvailable?'<img src="cid:billing-trend" width="596" alt="每日 API 请求趋势与 Token 堆叠柱状图" style="width:100%;height:auto;display:block;margin-top:18px">':`<p style="color:#74817e;font-size:12px">${series.length?'图表暂未生成，按日明细如下。':'暂无该周期的按日记录。'}</p>`;
 const daily=series.filter(r=>r.calls||r.tokens).map(r=>`<tr>${cell(safe(r.day))}${cell(num(r.calls),'right')}${cell(num(r.tokens),'right')}</tr>`).join('');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#f4f5f2;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#354144"><table role="presentation" width="660" cellspacing="0" cellpadding="0" style="width:100%;max-width:660px;margin:24px auto;background:#ffffff;border:1px solid #e2e7e3;border-radius:20px"><tr><td style="padding:28px 32px;border-bottom:1px solid #e2e7e3"><b style="font-size:21px">群屿</b><span style="font-size:12px;color:#707e7a;margin-left:12px">用量账单</span></td></tr><tr><td style="padding:25px 32px"><h1 style="font-size:23px;margin:0 0 10px">这次的账单，替你整理好了。</h1><p style="margin:0;color:#707e7a;font-size:12px">${safe(s.start)} — ${safe(s.end)} · 北京时间 · ${safe(apiNames[s.provider]||'全部 API')}</p></td></tr><tr><td style="padding:24px 32px;background:#eef2ef"><table width="100%" role="presentation"><tr><td><p style="color:#707e7a;font-size:12px;margin:0 0 12px">本期参考消费</p><strong style="font-size:48px;letter-spacing:-2px">¥${Number(s.cost||0).toFixed(2)}</strong><p style="color:#707e7a;font-size:11px">明细 ${money(s.cost)} · 所选周期已记录费用</p></td>${s.characterAvailable?'<td width="128"><img src="cid:billing-character" alt="达妮娅" width="128" style="display:block;width:128px;height:128px;object-fit:contain"></td>':''}</tr></table></td></tr><tr><td style="padding:24px 32px"><table role="presentation" width="100%"><tr><td width="58%"><small style="color:#707e7a">Token 总量</small><p style="font-size:28px;font-weight:600;margin:8px 0">${num(s.tokens)}</p></td><td style="border-left:1px solid #e2e7e3;padding-left:22px"><small style="color:#707e7a">API 请求次数</small><p style="font-size:28px;font-weight:600;margin:8px 0">${num(s.calls)}</p></td></tr></table><h2 style="font-size:15px;margin:26px 0 14px">API 渠道消费</h2><table width="100%" cellspacing="0" cellpadding="0"><thead><tr style="font-size:11px;color:#707e7a"><th align="left">API 渠道</th><th align="right">参考消费</th><th align="right">Tokens</th><th align="right">请求</th></tr></thead><tbody>${rows||'<tr><td colspan="4" style="padding:18px;color:#707e7a">暂无已记录调用</td></tr>'}</tbody></table>
 <details style="margin-top:24px;padding:16px;border:1px solid #e2e7e3;border-radius:12px;background:#f6f8f5"><summary style="cursor:pointer;font-size:13px;font-weight:600">Token 明细与趋势图 · 点击展开</summary><p style="font-size:11px;color:#707e7a">已按发送前选择的日期和 API 渠道筛选。邮箱不支持折叠时将直接显示明细。</p><table width="100%" style="font-size:12px;line-height:2"><tr><td>输入 Tokens</td><td align="right">${details.unknown&&!details.input?'未记录':num(details.input)}</td></tr><tr><td>输出 Tokens</td><td align="right">${details.unknown&&!details.output?'未记录':num(details.output)}</td></tr><tr><td>输入中缓存命中</td><td align="right">${details.unknown&&!details.input?'未记录':num(details.cached)}${details.input?`（${(details.cached/details.input*100).toFixed(1)}%）`:''}</td></tr><tr><td>历史未拆分 Tokens</td><td align="right">${num(details.unknown)}</td></tr></table>${trend}<table width="100%" cellspacing="0"><thead><tr style="font-size:11px;color:#707e7a"><th align="left">按日明细</th><th align="right">请求</th><th align="right">Tokens</th></tr></thead><tbody>${daily}</tbody></table></details>
 </td></tr><tr><td style="padding:18px 32px;border-top:1px solid #e2e7e3;font-size:11px;color:#707e7a;line-height:1.9">数据更新：${safe(stamp(s.updatedAt))}（北京时间）<br>官方基准校准：${safe(stamp(s.calibratedAt))}<br>本邮件金额为所选周期的本地记录，未将官方总额基准摊分到每天。美元按参考汇率折算，最终费用以官方结算为准。</td></tr></table></body></html>`;
 return {subject,text,html};
}
export async function createReportEmail(summary,{renderChart=renderTrend}={}){
 const attachments=[],portrait=character();let chartAvailable=false;
 if(portrait)attachments.push({filename:'denia.png',content:portrait,cid:'billing-character'});
 if(summary.series?.some(r=>r.calls||r.tokens))try{const content=await renderChart(summary.series);if(!Buffer.isBuffer(content)||content.length<8||!content.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw Error('invalid chart');attachments.push({filename:'billing-trend.png',content,cid:'billing-trend'});chartAvailable=true;}catch{/* Numeric details remain visible if the renderer is unavailable. */}
 return {...reportEmail({...summary,characterAvailable:Boolean(portrait),chartAvailable}),attachments};
}

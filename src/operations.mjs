import {reportEmail,createReportEmail} from './billing-report.mjs';
export {reportEmail} from './billing-report.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivate } from './config.mjs';
import { beijingClock } from './token-usage.mjs';
import { quarantineCorruptFile } from './security.mjs';
import { toCny } from './api-billing.mjs';
const dateShift = (day, n) => new Date(Date.parse(day) + n * 86400000).toISOString().slice(0,10);
export function reportWindow(now, config) {
  const clock = beijingClock(now), time = config.billReportTime || '08:00';
  const target = Date.parse(`${clock.day}T${time}:00+08:00`);
  if (now < target || now - target > 15 * 60000) return null;
  if ( new Date(`${clock.day}T00:00:00Z`).getUTCDay() !== 1) return null;
  return { key: `weekly:${clock.day}`, start: dateShift(clock.day, -7), end: dateShift(clock.day,-1) };
}
export function billSummary(meter, window) {
  const snapshot=meter.status({start:window.start,end:window.end,detailed:true});
  const channels=new Map(),series=[],models=new Map(),details={input:0,output:0,cached:0,unknown:0};
  let cost=0,tokens=0,calls=0;
  for(const day of [...snapshot.byDay].sort((a,b)=>a.day.localeCompare(b.day))) {
    const point={day:day.day,calls:0,tokens:0,uncached:0,cached:0,output:0,unknown:0};
    for(const row of day.models) {
      if(window.provider && row.provider!==window.provider)continue;
      const c=channels.get(row.provider)||{provider:row.provider,cost:0,tokens:0,calls:0};
      c.cost+=toCny(row.cost,row.currency);c.tokens+=row.totalTokens;c.calls+=row.calls;channels.set(row.provider,c);
      models.set(row.model,(models.get(row.model)||0)+row.totalTokens);
      point.calls+=row.calls;point.tokens+=row.totalTokens;
      point.cached+=row.cachedTokens||0;point.uncached+=Math.max(0,(row.promptTokens||0)-(row.cachedTokens||0));point.output+=row.completionTokens||0;point.unknown+=row.unknownBreakdownTokens||0;
    }
    if((!window.provider || window.provider==='deepseek') && day.toolCalls) {
      const c=channels.get('deepseek')||{provider:'deepseek',cost:0,tokens:0,calls:0};c.cost+=day.toolCost;c.calls+=day.toolCalls;channels.set('deepseek',c);point.calls+=day.toolCalls;
    }
    series.push(point);details.input+=point.cached+point.uncached;details.cached+=point.cached;details.output+=point.output;details.unknown+=point.unknown;
  }
  for(const c of channels.values()){cost+=c.cost;tokens+=c.tokens;calls+=c.calls;}
  const calibratedAt=Object.entries(meter.state?.apiBilling||{}).filter(([provider])=>!window.provider||provider===window.provider).map(([,row])=>row.at).filter(Boolean).sort().at(-1)||null;
  return {cost,tokens,calls,top:[...models].sort((a,b)=>b[1]-a[1])[0]?.[0]||'暂无',...window,channels:[...channels.values()].sort((a,b)=>b.cost-a.cost),series,details,updatedAt:snapshot.updatedAt,calibratedAt};
}
export function manualWindow(now,period,filters={}) {
  if(!['week','last-week','custom'].includes(period))throw Object.assign(Error('账单周期无效'),{status:400});
  if(filters.provider && !['deepseek','openai','kimi','anthropic','unknown'].includes(filters.provider))throw Object.assign(Error('API 渠道无效'),{status:400});
  const day=beijingClock(now).day,dow=new Date(day+'T00:00:00Z').getUTCDay()||7,monday=dateShift(day,1-dow);
  let window=period==='week'?{start:monday,end:day}:{start:dateShift(monday,-7),end:dateShift(monday,-1)};
  if(period==='custom') {
    const {start,end}=filters;
    for(const date of [start,end])if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw Object.assign(Error('请选择有效的开始和结束日期'),{status:400});
    if(start>end||end>day||Date.parse(end)-Date.parse(start)>92*86400000)throw Object.assign(Error('日期需按先后排列、不晚于今天且最多 93 天'),{status:400});
    window={start,end};
  }
  return {...window,...(filters.provider?{provider:filters.provider}:{})};
}
export class Operations {
  constructor(dataDir, store, bot, napcat, meter, {now=Date.now,sendMail,renderChart}={}) {
    Object.assign(this,{store,bot,napcat,meter,now,renderChart}); this.path=join(dataDir,'operations.json');
    this.state={reports:{}};
    if (existsSync(this.path)) {
      try { this.state=JSON.parse(readFileSync(this.path,'utf8')) || {reports:{}}; }
      catch (error) {
        const backup = quarantineCorruptFile(this.path);
        console.error(`[operations] operations.json 已损坏，已隔离至 ${backup || this.path}: ${error.message}`);
      }
    }
    this.state.reports ||= {}; this.failures=0;this.closed=false;this.busy=false;
    this.sendMail=sendMail || (async (config,subject,text,html,attachments)=>{
      const {default:nodemailer}=await import('nodemailer');
      const transport=nodemailer.createTransport({host:config.smtpHost,port:config.smtpPort,secure:config.smtpSecure,requireTLS:!config.smtpSecure,
        auth:{user:config.smtpUser,pass:config.smtpPassword},connectionTimeout:10000,socketTimeout:15000});
      try { await transport.sendMail({from:config.smtpUser,to:config.emailAlertRecipient,subject,text,html,attachments}); } finally { transport.close(); }
    });
  }
  save(){writePrivate(this.path,this.state);}
  status(){return {lastAlert:this.state.lastAlert||null,reports:this.state.reports,busy:this.busy,manualSending:Boolean(this.manualSending),lastManualReport:this.state.lastManualReport||null};}
  async sendReport(period = 'last-week', filters = {}) {
    const window=manualWindow(this.now(),period,filters);
    if (this.closed || this.busy) throw Object.assign(Error('通知任务正在处理，请稍后重试'), {status:409});
    const c={...this.store.config};
    if (!c.smtpHost || !c.smtpUser || !c.smtpPassword || !c.emailAlertRecipient) throw Object.assign(Error('请先保存完整邮箱和 SMTP 配置'), {status:400});
    if (this.state.lastManualAttempt && this.now()-this.state.lastManualAttempt < 30000) throw Object.assign(Error('请等待 30 秒后再次发送'), {status:429});
    this.busy=true; this.manualSending=true;
    try {
      this.state.lastManualAttempt=this.now(); this.save();
      const mail=await createReportEmail(billSummary(this.meter,window),{renderChart:this.renderChart});
      this.state.lastManualReport={...window,recipient:c.emailAlertRecipient,status:'sending',at:new Date(this.now()).toISOString()};this.save();
      await this.sendMail(c,mail.subject,mail.text,mail.html,mail.attachments);
      this.state.lastManualReport.status='sent';this.save();
      return {...this.state.lastManualReport};
    } catch(error) {
      if(this.state.lastManualReport?.status==='sending'){this.state.lastManualReport.status='failed';this.save();}
      this.bot.log('warn','手动账单邮件发送失败，请检查 SMTP 配置');
      throw Object.assign(Error('账单邮件发送失败，请检查 SMTP 配置或邮箱服务状态'), {status:502});
    } finally {this.busy=false;this.manualSending=false;}
  }
  async tick(){
    if(this.closed||this.busy)return;this.busy=true;
    try {
      const c={...this.store.config};
      if(c.emailAlertsEnabled) await this.checkOffline(c);
      if(c.billReportEnabled && c.smtpHost && c.smtpUser && c.smtpPassword && c.emailAlertRecipient) {
        const window=reportWindow(this.now(),c);
        if(window&&!this.state.reports[window.key]) {
          this.state.reports[window.key]={at:this.now(),status:'sending'};this.state.reports=Object.fromEntries(Object.entries(this.state.reports).slice(-40));this.save();
          try {
            const mail=await createReportEmail(billSummary(this.meter,window),{renderChart:this.renderChart});
            if(this.closed)return;
            await this.sendMail(c,mail.subject,mail.text,mail.html,mail.attachments);
            this.state.reports[window.key].status='sent';
          } catch {this.state.reports[window.key].status='failed';this.bot.log('warn','每周账单邮件发送失败，请检查 SMTP 配置');}
          this.save();
        }
      }
    } finally {this.busy=false;}
  }
  async checkOffline(c){
    let status;try{status=await this.napcat.status(true);}catch{status={qq:{state:'unknown'}};}
    if(this.closed)return;
    if(status.qq.state==='online'){this.failures=0;if(this.state.alerted){this.state.alerted=false;this.save();}return;}
    if(status.webui?.configured===false&&!status.onebot?.reachable)return;
    this.failures++;
    if(this.failures<3||this.state.alerted||this.now()-(this.state.lastAttempt||0)<300000)return;
    this.state.lastAttempt=this.now();this.save();
    const link=c.consolePublicUrl?`${c.consolePublicUrl}/#connection`:'请打开后台“QQ 连接”页面获取登录二维码。';
    try {
      await this.sendMail(c,'群屿：QQ 离线或连接异常',`连续三次检查 QQ 未在线。状态：${status.qq.state==='unknown'?'连接状态未知':status.qq.label||status.qq.state}\n${link}\n请登录后台检查；系统不会自动重启 NapCat 或刷新二维码。`);
      this.state.alerted=true;this.state.lastAlert=new Date(this.now()).toISOString();this.save();
    } catch {this.bot.log('warn','QQ 离线邮件发送失败，请检查 SMTP 配置');}
  }
  start(){this.timer=setInterval(()=>this.tick().catch(()=>this.bot.log('warn','运维定时任务执行失败')),60000);this.timer.unref();}
  close(){this.closed=true;clearInterval(this.timer);}
}

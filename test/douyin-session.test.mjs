import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DouyinSession, douyinCookieText } from '../src/douyin-session.mjs';
import { DouyinBrowser, douyinPollRequest, qrExpiresAt } from '../src/douyin-browser.mjs';
import { LinkCookies } from '../src/link-cookies.mjs';
import { socialPlatforms } from '../src/social-links.mjs';
import { createApplication } from '../src/server.mjs';
const image = 'data:image/png;base64,iVBORw0KGgo=';
const cookie = (value = 'PRIVATE_SESSION') => ({ domain: '.douyin.com', path: '/', secure: true, httpOnly: true, expires: 0, name: 'sessionid', value });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'qqbot-douyin-test-'));
  const cookies = new LinkCookies(join(directory, 'link-cookies'), socialPlatforms);
  let now = Date.now(), snapshot = { state: 'waiting_scan', cookies: [] }, start;
  const browsers = [], logs = []; let updated = 0;
  const factory = () => { const browser = { image, closed: false, async start(...args) { this.args = args; if (start) await start(); }, async snapshot() { return snapshot; }, async check() { return snapshot; }, close() { this.closed = true; } }; browsers.push(browser); return browser; };
  const service = new DouyinSession(directory, cookies, { browserFactory: factory, available: () => true, now: () => now, onUpdate: () => updated++, log: (...args) => logs.push(args) });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { service, cookies, directory, browsers, logs, factory, advance: ms => now += ms, snapshot: value => snapshot = value, start: value => start = value, updates: () => updated };
}
test('抖音扫码状态分离，确认后自动保存 HttpOnly Cookie，不回显凭据，重启保留', async t => {
  const f = fixture(t); const qr = await f.service.generateQr(); assert.equal(qr.image, image);
  assert.equal((await f.service.pollQr()).qr.state, 'waiting_scan');
  f.snapshot({ state: 'scanned', cookies: [] }); f.advance(3000); assert.equal((await f.service.pollQr()).qr.state, 'scanned');
  f.snapshot({ confirmed: true, authenticated: true, cookies: [cookie(), { ...cookie('BAD'), domain: '.evil.test' }] }); f.advance(3000);
  assert.equal((await f.service.pollQr()).qr.state, 'success'); assert.equal(f.service.status().state, 'valid');
  assert.match(f.cookies.read('douyin'), /#HttpOnly_\.douyin.com/); assert.match(f.cookies.read('douyin'), /PRIVATE_SESSION/);
  assert.doesNotMatch(f.cookies.read('douyin'), /evil.test|BAD/); assert.equal(f.browsers[0].closed, true);
  assert.equal(statSync(join(f.directory, 'link-cookies/douyin.txt')).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.directory, 'douyin-session.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify([f.service.status(), f.service.qrPublic(), f.logs, JSON.parse(readFileSync(join(f.directory, 'douyin-session.json')))]), /PRIVATE_SESSION/);
  const restored = new DouyinSession(f.directory, f.cookies, { available: () => true }); t.after(() => restored.close());
  assert.equal(restored.status().state, 'valid'); assert.ok(restored.status().nextCheckAt);
});
test('Cookie 存在不能冒充扫码成功；缺少确认不覆盖已有 Cookie，超时释放浏览器', async t => {
  const f=fixture(t); f.service.importCookie('sessionid=ORIGINAL'); await f.service.generateQr();
  f.snapshot({ cookies: [cookie()], state: 'waiting_scan' }); await f.service.pollQr(); assert.match(f.cookies.read('douyin'), /ORIGINAL/);
  f.snapshot({ confirmed:true, cookies: [] }); f.advance(3000); assert.equal((await f.service.pollQr()).qr.state,'confirming');
  f.advance(180000); assert.equal((await f.service.pollQr()).qr.state,'confirming');
  f.advance(20001); assert.equal((await f.service.pollQr()).qr.state,'expired'); assert.equal(f.browsers[0].closed,true); assert.match(f.cookies.read('douyin'), /ORIGINAL/);
});
test('立即检查确认平台登录后同步 Cookie，未知状态及网络失败保留旧凭据', async t => {
  const f=fixture(t); f.service.importCookie('sessionid=OLD'); f.snapshot({authenticated:true,cookies:[cookie('NEW')]});
  assert.equal((await f.service.check()).state,'valid');assert.match(f.cookies.read('douyin'),/NEW/);assert.equal(f.browsers[0].closed,true);
  assert.match(f.browsers[0].args[0],/OLD/);
  f.snapshot({cookies:[cookie('IGNORED')]});assert.equal((await f.service.check()).state,'error');assert.match(f.cookies.read('douyin'),/NEW/);
  f.snapshot({invalid:true,cookies:[]});assert.equal((await f.service.check()).state,'expired');assert.match(f.cookies.read('douyin'),/NEW/);
  f.start(()=>{throw new Error('SECRET_URL?Cookie=PRIVATE')});assert.equal((await f.service.check()).state,'error');assert.doesNotMatch(JSON.stringify(f.service.status()),/SECRET_URL|PRIVATE/);
});
test('手动更新、取消、关闭和并发操作不会让旧扫码覆盖凭据', async t => {
  const f=fixture(t); let release;f.start(()=>new Promise(resolve=>release=resolve));const pending=f.service.generateQr();
  await Promise.resolve(); await assert.rejects(f.service.generateQr(),/正在处理/);
  f.service.importCookie('sessionid=MANUAL');release();await assert.rejects(pending,/配置已变更/);assert.equal(f.browsers[0].closed,true);
  f.start(null);await f.service.generateQr();f.service.cancel();assert.equal(f.service.qrPublic().state,'none');assert.match(f.cookies.read('douyin'),/MANUAL/);
  await f.service.generateQr();f.cookies.save('douyin','sessionid=EXTERNAL');f.snapshot({confirmed:true,authenticated:true,cookies:[cookie()]});await assert.rejects(f.service.pollQr(),/读取失败/);assert.match(f.cookies.read('douyin'),/EXTERNAL/);
  f.service.importCookie('');assert.equal(f.service.status().configured,false);f.service.close();await assert.rejects(f.service.generateQr(),/停止/);
});
test('自动检查可关闭，未配置不启动浏览器，私密设置拒绝符号链接', async t => {
  const f=fixture(t);await f.service.check();assert.equal(f.browsers.length,0);f.service.start();assert.equal(f.service.timer,undefined);
  f.service.importCookie('sessionid=IMPORTED');assert.ok(f.service.timer);f.service.configure(false);assert.equal(f.service.status().nextCheckAt,null);
  assert.throws(()=>f.service.configure('yes'),/参数/);assert.throws(()=>douyinCookieText([cookie('')]),/完整登录态/);
  f.service.close();rmSync(join(f.directory,'douyin-session.json'));writeFileSync(join(f.directory,'other'),'{}');symlinkSync(join(f.directory,'other'),join(f.directory,'douyin-session.json'));
  assert.throws(()=>new DouyinSession(f.directory,f.cookies));
});
test('浏览器仅接受官方网络响应、完整 PNG 和平台认证信号', () => {
  const b=new DouyinBrowser();b.observe('/passport/web/get_qrcode/',{data:{qrcode:'https://evil.test'}});assert.equal(b.image,'');
  b.observe('/passport/web/get_qrcode/',{data:{qrcode:'iVBORw0KGgo='}});assert.equal(b.image,image);
  b.observe('/passport/web/check_qrconnect/',{data:{status:'2'}});assert.equal(b.state,'scanned');
  b.observe('/passport/web/check_qrconnect/',{data:{status:'3'}});assert.equal(b.confirmed,true);
  b.observe('/aweme/v1/web/user/profile/self/',{status_code:0,user:{uid:'100'}});assert.equal(b.authenticated,true);
  const anonymous=new DouyinBrowser();anonymous.observe('/web/api/media/user/info/',{status_code:0,user:{uid:'0'}});assert.equal(anonymous.authenticated,false);
  anonymous.observe('/web/api/media/user/info/',{status_code:8});assert.equal(anonymous.invalid,true);anonymous.close();
  b.close();
});
test('定时检查不依赖后台网页；关闭自动检查停止调度；无人轮询的二维码到期释放浏览器', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()}); const f=fixture(t);
  f.service.importCookie('sessionid=OLD');f.snapshot({authenticated:true,cookies:[cookie('UPDATED')]});f.service.start();
  assert.ok(f.service.status().nextCheckAt);f.advance(6*3600000);t.mock.timers.tick(6*3600000);await new Promise(setImmediate);
  assert.equal(f.browsers.length,1);assert.match(f.cookies.read('douyin'),/UPDATED/);assert.equal(f.browsers[0].closed,true);
  f.service.configure(false);f.advance(6*3600000);t.mock.timers.tick(6*3600000);await new Promise(setImmediate);assert.equal(f.browsers.length,1);
  await f.service.generateQr();f.advance(180000);t.mock.timers.tick(180000);assert.equal(f.service.qrPublic().state,'expired');assert.equal(f.browsers[1].closed,true);
});
test('手机切走网页后服务器继续核对并保存，漏掉确认回调但账号验证通过也能完成',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});const f=fixture(t);
  f.service.importCookie('sessionid=ORIGINAL');await f.service.generateQr();
  f.snapshot({authenticated:true,confirmed:false,cookies:[cookie('VERIFIED_NEW')]});
  f.advance(3000);t.mock.timers.tick(3000);await new Promise(setImmediate);
  assert.equal(f.service.qrPublic().state,'success');assert.equal(f.service.status().state,'valid');assert.match(f.cookies.read('douyin'),/VERIFIED_NEW/);assert.equal(f.browsers[0].closed,true);
});
test('手机确认但尚未验证账号时显示同步中，Cookie 稍后到达且验证通过才保存',async t=>{
  const f=fixture(t);f.service.importCookie('sessionid=ORIGINAL');await f.service.generateQr();
  f.snapshot({confirmed:true,cookies:[cookie('UNVERIFIED')]});assert.equal((await f.service.pollQr()).qr.state,'confirming');assert.match(f.cookies.read('douyin'),/ORIGINAL/);
  f.advance(3000);f.snapshot({state:'scanned',cookies:[]});assert.equal((await f.service.pollQr()).qr.state,'confirming');
  f.advance(3000);f.snapshot({authenticated:true,cookies:[cookie('VERIFIED')]});assert.equal((await f.service.pollQr()).qr.state,'success');assert.match(f.cookies.read('douyin'),/VERIFIED/);
});
test('平台额外身份验证有明确提示、等待上限且不会被已确认或迟到过期回退',async t=>{
  const f=fixture(t);await f.service.generateQr();f.snapshot({state:'verification_required',cookies:[]});
  const result=await f.service.pollQr();assert.equal(result.qr.state,'verification_required');assert.match(result.qr.detail,/身份验证/);
  const deadline=result.qr.expiresAt;f.advance(3000);f.snapshot({confirmed:true,cookies:[]});assert.equal((await f.service.pollQr()).qr.state,'verification_required');
  f.advance(3000);f.snapshot({state:'expired',cookies:[]});assert.equal((await f.service.pollQr()).qr.state,'verification_required');
  assert.equal(f.service.qrPublic().expiresAt,deadline);f.advance(300000);assert.equal((await f.service.pollQr()).qr.state,'expired');assert.equal(f.browsers[0].closed,true);
});
test('采用平台实际有效期，后台检查繁忙时前端读取状态不重复执行；取消能阻止延迟保存',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});const f=fixture(t);await f.service.generateQr();
  let release,calls=0;f.browsers[0].snapshot=async()=>{calls++;return new Promise(resolve=>release=resolve);};
  f.advance(3000);t.mock.timers.tick(3000);await Promise.resolve();assert.equal(f.service.busy,true);
  assert.equal((await f.service.pollQr()).qr.state,'waiting_scan');assert.equal(calls,1);
  f.service.cancel();release({authenticated:true,cookies:[cookie('MUST_NOT_SAVE')]});await new Promise(setImmediate);
  assert.equal(f.service.qrPublic().state,'none');assert.equal(f.cookies.info('douyin').configured,false);
  f.service.browserFactory=()=>({image,expiresAt:Date.now()+60000,async start(){},close(){}});
  const qr=await f.service.generateQr();assert.equal(qr.expiresAt,Date.now()+60000);
  f.advance(60000);t.mock.timers.tick(60000);assert.equal(f.service.qrPublic().state,'expired');
});
test('截止瞬间浏览器已收到确认但快照尚未完成，不能提前关闭登录回调',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});const f=fixture(t);await f.service.generateQr();
  f.browsers[0].confirmed=true;f.advance(180000);t.mock.timers.tick(180000);await new Promise(setImmediate);
  assert.equal(f.service.qrPublic().state,'confirming');assert.equal(f.browsers[0].closed,false);
  f.snapshot({authenticated:true,cookies:[cookie('FINAL_VERIFIED')]});f.advance(3000);t.mock.timers.tick(3000);await new Promise(setImmediate);
  assert.equal(f.service.qrPublic().state,'success');assert.match(f.cookies.read('douyin'),/FINAL_VERIFIED/);
});
test('官方验证画面和操作仅限当前验证会话，验证码不进入公开状态、配置或日志，取消阻止迟到画面',async t=>{
  const f=fixture(t);f.service.importCookie('sessionid=KEEP_ORIGINAL');
  await assert.rejects(f.service.verification(),/当前没有/);await f.service.generateQr();await assert.rejects(f.service.verification(),/当前没有/);
  f.snapshot({state:'verification_required',cookies:[]});await f.service.pollQr();
  const b=f.browsers[0];b.verificationView=async()=>({image:'data:image/jpeg;base64,dGVzdA==',width:1280,height:900});b.verificationInteract=async input=>{assert.equal(input.code,'123456');return {accepted:true};};
  assert.equal((await f.service.verification()).width,1280);assert.equal((await f.service.verification({type:'code',code:'123456'})).accepted,true);
  assert.doesNotMatch(JSON.stringify([f.service.status(),f.service.qrPublic(),f.logs,JSON.parse(readFileSync(join(f.directory,'douyin-session.json')))]),/123456/);assert.match(f.cookies.read('douyin'),/KEEP_ORIGINAL/);
  let release;b.verificationView=()=>new Promise(resolve=>release=resolve);const pending=f.service.verification();await Promise.resolve();f.service.cancel();release({image:'PRIVATE_LATE_IMAGE'});await assert.rejects(pending,/配置已变更/);
  await assert.rejects(f.service.verification(),/当前没有/);
});
test('抖音登录 API 受鉴权和同源保护，手动 Cookie 修改通过会话管理取消扫码', async t => {
  const directory=mkdtempSync(join(tmpdir(),'qqbot-douyin-http-'));
  const app=await createApplication({dataDir:directory,initialPassword:'test1234',bilibiliAutoStart:false,douyinAutoStart:false,
    douyinOptions:{available:()=>true,browserFactory:()=>({image,async start(){},async snapshot(){return {state:'verification_required',cookies:[]};},
      async verificationView(){return {image:'data:image/jpeg;base64,dGVzdA==',width:1280,height:900};},async verificationInteract(input){assert.equal(input.code,'123456');return {accepted:true};},close(){}})}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));rmSync(directory,{recursive:true,force:true});});
  const url='http://127.0.0.1:'+app.server.address().port,base={'Content-Type':'application/json','X-Admin-Request':'1'};
  const post=(path,data={},headers=base)=>fetch(url+path,{method:'POST',headers,body:JSON.stringify(data)});
  assert.equal((await fetch(url+'/api/links/douyin')).status,401);
  for(const action of ['qrcode','poll','check','settings','cancel','verification','interact'])assert.equal((await post('/api/links/douyin/'+action)).status,401);
  const login=await post('/api/login',{username:'admin',password:'test1234'}),headers={...base,Cookie:login.headers.get('set-cookie').split(';')[0]};
  assert.equal((await post('/api/links/douyin/settings',{autoCheck:false},{...headers,Origin:'https://evil.test'})).status,403);
  assert.equal((await post('/api/links/douyin/settings',{autoCheck:'yes'},headers)).status,400);
  assert.equal((await post('/api/links/douyin/settings',{autoCheck:false},headers)).status,200);
  assert.equal((await post('/api/links/douyin/interact',{type:'code',code:'123456'},{...headers,Origin:'https://evil.test'})).status,403);
  const before=readFileSync(join(directory,'admin.json'),'utf8'); app.bot.links.cookies.save('bilibili','SESSDATA=BILI_UNTOUCHED');
  await post('/api/links/douyin/qrcode',{},headers);assert.equal((await(await post('/api/links/douyin/poll',{},headers)).json()).qr.state,'verification_required');
  const restored=await(await fetch(url+'/api/links/douyin',{headers})).json();assert.equal(restored.qr.state,'verification_required');assert.match(restored.qr.detail,/验证/);
  const view=await(await post('/api/links/douyin/verification',{},headers)).json();assert.equal(view.width,1280);assert.match(view.image,/^data:image\/jpeg;base64,/);
  const interaction=await(await post('/api/links/douyin/interact',{type:'code',code:'123456'},headers)).json();assert.deepEqual(interaction,{accepted:true});
  await post('/api/links/cookies',{platform:'douyin',content:'sessionid=MANUAL'},headers);
  assert.equal((await post('/api/links/douyin/verification',{},headers)).status,400);
  assert.equal((await (await post('/api/links/douyin/poll',{},headers)).json()).qr.state,'none');
  assert.match(app.bot.links.cookies.read('douyin'),/MANUAL/);assert.match(app.bot.links.cookies.read('bilibili'),/BILI_UNTOUCHED/);assert.equal(readFileSync(join(directory,'admin.json'),'utf8'),before);
});

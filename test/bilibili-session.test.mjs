import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BilibiliSession, correspondPath } from '../src/bilibili-session.mjs';
import { LinkCookies } from '../src/link-cookies.mjs';
import { socialPlatforms } from '../src/social-links.mjs';
import { createApplication } from '../src/server.mjs';
const qrKey = 'q'.repeat(32), oldToken = 'PRIVATE_REFRESH_OLD_TOKEN', newToken = 'PRIVATE_REFRESH_NEW_TOKEN';
const reply = (body, cookies = []) => { const headers = new Headers(); for (const line of cookies) headers.append('Set-Cookie', line); return new Response(JSON.stringify(body), { headers }); };
const authCookies = session => [`SESSDATA=PRIVATE_SESSION_${session}; Path=/; Domain=.bilibili.com; Secure; HttpOnly`,
  `bili_jct=csrf_${session}; Path=/; Domain=bilibili.com; Secure`, 'DedeUserID=10001; Path=/; Domain=bilibili.com; Secure'];
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-bili-session-')), cookies = new LinkCookies(join(dir, 'link-cookies'), socialPlatforms);
  let now = Date.now(), handler;
  const calls = [], logs = [];
  const service = new BilibiliSession(dir, cookies, { now: () => now, request: async (url, options) => {
    calls.push({ url, options }); if (!handler) throw new Error('NO_REAL_NETWORK'); return handler(new URL(url), options);
  }, log: (...args) => logs.push(args), ...extra });
  t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, cookies, service, calls, logs, advance: n => now += n, setHandler: value => handler = value, now: () => now };
}
async function login(f) {
  f.setHandler(url => url.pathname.endsWith('/generate') ? reply({code:0,data:{url:`https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${qrKey}`,qrcode_key:qrKey}})
    : reply({code:0,data:{code:0,refresh_token:oldToken}},authCookies('OLD')));
  await f.service.generateQr(); await f.service.pollQr();
}

test('B 站扫码保存私密登录态和刷新令牌，响应与日志不回显凭据，重启保留', async t => {
  const f = fixture(t); await login(f);
  const publicText = JSON.stringify([f.service.status(),f.service.qrPublic(),f.logs]);
  for (const secret of [oldToken,'PRIVATE_SESSION_OLD','csrf_OLD',qrKey]) assert.equal(publicText.includes(secret),false);
  assert.match(f.cookies.read('bilibili'),/PRIVATE_SESSION_OLD/);
  assert.equal(statSync(join(f.dir,'bilibili-session.json')).mode & 0o777,0o600);
  assert.equal(statSync(join(f.dir,'link-cookies/bilibili.txt')).mode & 0o777,0o600);
  const restored = new BilibiliSession(f.dir,f.cookies); t.after(()=>restored.close());
  assert.equal(restored.status().refreshCapable,true); assert.equal(restored.status().state,'valid');
  assert.equal(f.service.qrPublic().state,'success');
});

test('扫码区分待扫描、待确认、过期；轮询限频且不接受非 B 站二维码', async t => {
  const f=fixture(t);
  f.setHandler(url=>url.pathname.endsWith('/generate')?reply({code:0,data:{url:`https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${qrKey}`,qrcode_key:qrKey}}):reply({code:0,data:{code:86101}}));
  await f.service.generateQr(); assert.equal((await f.service.pollQr()).qr.state,'waiting_scan');
  const count=f.calls.length; await f.service.pollQr(); assert.equal(f.calls.length,count);
  f.advance(3000);f.setHandler(()=>reply({code:0,data:{code:86090}}));assert.equal((await f.service.pollQr()).qr.state,'scanned');
  f.advance(180000);assert.equal((await f.service.pollQr()).qr.state,'expired');assert.equal(f.calls.length,count+1);
  f.setHandler(()=>reply({code:0,data:{url:`https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=${qrKey}`,qrcode_key:qrKey}}));
  assert.match((await f.service.generateQr()).url,/^https:\/\/account\.bilibili\.com\//);
  f.advance(3000);
  f.setHandler(()=>reply({code:0,data:{url:'https://evil.test/scan',qrcode_key:qrKey}}));await assert.rejects(f.service.generateQr(),/二维码/);
});

test('需要续期才轮换 Cookie，先落盘新令牌，再用新 Cookie 确认旧令牌', async t => {
  const f=fixture(t);await login(f);let confirmed=false;
  f.setHandler((url,options)=>{
    if(url.pathname.endsWith('/info'))return reply({code:0,data:{refresh:true,timestamp:f.now()}});
    if(url.pathname.startsWith('/correspond/')){assert.match(url.pathname,/\/[a-f0-9]{256}$/);return new Response('<div id="1-name">refresh_csrf</div>');}
    const form=new URLSearchParams(options.body);
    if(url.pathname.endsWith('/cookie/refresh')){assert.equal(form.get('refresh_token'),oldToken);assert.equal(form.get('csrf'),'csrf_OLD');assert.equal(form.get('source'),'main_web');return reply({code:0,data:{status:0,refresh_token:newToken}},authCookies('NEW'));}
    assert.equal(form.get('refresh_token'),oldToken);assert.equal(form.get('csrf'),'csrf_NEW');assert.match(options.headers.Cookie,/PRIVATE_SESSION_NEW/);
    const saved=JSON.parse(readFileSync(join(f.dir,'bilibili-session.json')));assert.equal(saved.refreshToken,newToken);assert.equal(saved.pendingConfirm,oldToken);
    assert.match(f.cookies.read('bilibili'),/PRIVATE_SESSION_NEW/);confirmed=true;return reply({code:0});
  });
  assert.equal((await f.service.check()).state,'refreshed');assert.equal(confirmed,true);
  assert.equal(JSON.parse(readFileSync(join(f.dir,'bilibili-session.json'))).pendingConfirm,'');
  assert.equal(f.service.status().nextCheckAt,f.now()+6*3600000);
  const before=f.calls.length;f.setHandler(()=>reply({code:0,data:{refresh:false}}));await f.service.check();assert.equal(f.calls.length,before+1);
});

test('续期确认中断后重启可继续，不能回滚或丢失新 Cookie；网络错误不泄密', async t => {
  const f=fixture(t);await login(f);
  f.setHandler(url=>url.pathname.endsWith('/info')?reply({code:0,data:{refresh:true,timestamp:f.now()}})
    :url.pathname.startsWith('/correspond/')?new Response('<div id="1-name">refresh_csrf</div>')
    :url.pathname.endsWith('/cookie/refresh')?reply({code:0,data:{status:0,refresh_token:newToken}},authCookies('NEW'))
    :Promise.reject(new Error('https://SECRET.test?refresh_token='+oldToken)));
  assert.equal((await f.service.check()).state,'confirm_pending');assert.match(f.cookies.read('bilibili'),/PRIVATE_SESSION_NEW/);
  assert.equal(JSON.stringify(f.service.status()).includes(oldToken),false);assert.equal(JSON.stringify(f.logs).includes(oldToken),false);
  const restored=new BilibiliSession(f.dir,f.cookies,{request:async url=>reply(url.includes('/info')?{code:0,data:{refresh:false}}:{code:0})});t.after(()=>restored.close());
  assert.equal((await restored.check()).state,'valid');assert.equal(JSON.parse(readFileSync(join(f.dir,'bilibili-session.json'))).pendingConfirm,'');
});

test('手动替换、清除和并发检查不会覆盖新登录；缺少令牌或已过期需扫码', async t => {
  const f=fixture(t);await login(f);let release;
  f.setHandler(()=>new Promise(resolve=>release=resolve));const pending=f.service.check();
  await Promise.resolve();await assert.rejects(f.service.generateQr(),/正在处理/);
  f.service.importCookie('SESSDATA=MANUAL_NEW; bili_jct=manual_csrf');release(reply({code:0,data:{refresh:true,timestamp:f.now()}}));
  await assert.rejects(pending,/配置已变更/);assert.match(f.cookies.read('bilibili'),/MANUAL_NEW/);assert.equal(f.service.status().refreshCapable,false);
  f.setHandler(()=>reply({code:0,data:{refresh:false}}));assert.equal((await f.service.check()).state,'needs_scan');
  f.setHandler(()=>reply({code:-101}));assert.equal((await f.service.check()).state,'expired');
  f.service.importCookie('');assert.equal(f.cookies.info('bilibili').configured,false);
  assert.equal(f.service.status().refreshCapable,false);assert.equal(f.service.status().state,'unconfigured');
});

test('投影写入中断能从私密主记录恢复，外部替换 Cookie 会撤销旧自动续期关联', async t => {
  const f=fixture(t);await login(f);const before=f.cookies.read('bilibili');
  f.service.commit(before.replace('PRIVATE_SESSION_OLD','PRIVATE_SESSION_NEW'),newToken,{pendingConfirm:oldToken});
  f.cookies.save('bilibili',before);
  const recovered=new BilibiliSession(f.dir,f.cookies);t.after(()=>recovered.close());assert.match(f.cookies.read('bilibili'),/PRIVATE_SESSION_NEW/);
  f.cookies.save('bilibili','SESSDATA=EXTERNAL_COOKIE');
  const imported=new BilibiliSession(f.dir,f.cookies);t.after(()=>imported.close());assert.equal(imported.status().refreshCapable,false);assert.match(f.cookies.read('bilibili'),/EXTERNAL_COOKIE/);
});

test('关闭自动续期跨重启保留，不启动定时器；私密文件拒绝符号链接', async t => {
  const f=fixture(t);f.service.configure(false);f.service.start();assert.equal(f.service.timer,undefined);
  const restored=new BilibiliSession(f.dir,f.cookies);t.after(()=>restored.close());assert.equal(restored.status().autoRefresh,false);assert.equal(restored.status().nextCheckAt,null);
  assert.equal(correspondPath(Date.now()).length,256);
  rmSync(join(f.dir,'bilibili-session.json'));symlinkSync(join(f.dir,'other'),join(f.dir,'bilibili-session.json'));
  assert.throws(()=>new BilibiliSession(f.dir,f.cookies));
});

test('后台自行按时检查，关闭自动续期立即停止后续调度，不依赖网页轮询', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const f = fixture(t);
  f.service.importCookie('SESSDATA=FAKE; bili_jct=csrf');
  f.setHandler(() => reply({ code: 0, data: { refresh: false } }));
  f.service.start();
  f.advance(30000); t.mock.timers.tick(30000); await new Promise(setImmediate);
  assert.equal(f.calls.length, 1);
  f.advance(6 * 3600000); t.mock.timers.tick(6 * 3600000); await new Promise(setImmediate);
  assert.equal(f.calls.length, 2);
  f.service.configure(false);
  f.advance(6 * 3600000); t.mock.timers.tick(6 * 3600000); await new Promise(setImmediate);
  assert.equal(f.calls.length, 2);
});

test('B 站登录与续期接口受鉴权和同源保护，保留其他平台与管理员密码', async t => {
  const dir=mkdtempSync(join(tmpdir(),'qqbot-bili-http-'));
  const app=await createApplication({dataDir:dir,initialPassword:'test1234',bilibiliAutoStart:false,
    bilibiliOptions:{request:async()=>reply({code:-101})}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));rmSync(dir,{recursive:true,force:true});});
  const url='http://127.0.0.1:'+app.server.address().port,base={'Content-Type':'application/json','X-Admin-Request':'1'};
  const post=(path,data={},headers=base)=>fetch(url+path,{method:'POST',headers,body:JSON.stringify(data)});
  assert.equal((await fetch(url+'/api/links/bilibili')).status,401);
  for(const action of ['qrcode','poll','check','settings'])assert.equal((await post('/api/links/bilibili/'+action)).status,401);
  const login=await post('/api/login',{username:'admin',password:'test1234'}),headers={...base,Cookie:login.headers.get('set-cookie').split(';')[0]};
  const admin=readFileSync(join(dir,'admin.json'),'utf8');app.bot.links.cookies.save('douyin','sessionid=OTHER_PLATFORM');
  assert.equal((await post('/api/links/bilibili/settings',{autoRefresh:false},{...headers,Origin:'https://evil.test'})).status,403);
  assert.equal((await post('/api/links/bilibili/settings',{autoRefresh:'yes'},headers)).status,400);
  assert.equal((await post('/api/links/bilibili/settings',{autoRefresh:false},headers)).status,200);
  await post('/api/links/cookies',{platform:'bilibili',content:'SESSDATA=PRIVATE_SESSION; bili_jct=test'},headers);
  const status=await (await post('/api/links/bilibili/check',{},headers)).json();assert.equal(status.state,'expired');assert.equal(JSON.stringify(status).includes('PRIVATE_SESSION'),false);
  assert.equal(readFileSync(join(dir,'admin.json'),'utf8'),admin);assert.match(app.bot.links.cookies.read('douyin'),/OTHER_PLATFORM/);
});

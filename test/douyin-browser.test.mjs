import test from 'node:test';
import assert from 'node:assert/strict';
import { DouyinBrowser, douyinPollRequest, qrExpiresAt } from '../src/douyin-browser.mjs';
const token='PRIVATE_QR_TOKEN', image='iVBORw0KGgo=';
const endpoint='https://creator.douyin.com/passport/web/check_qrconnect/';
const session=value=>({domain:'.douyin.com',name:'sessionid',value,path:'/',expires:0});
const qr=(b,extra={})=>b.observe('/passport/web/get_qrcode/',{message:'success',data:{error_code:0,token,qrcode:image,...extra}},{status:200});
const poll=(b,data,meta={})=>b.observe('/passport/web/check_qrconnect/',{message:'success',data:{error_code:0,...data}},{status:200,token,...meta});

test('使用当前二维码的实际 POST 表单做短轮询，关闭 frontier，保留方法和参数且不改原请求',()=>{
  const request={url:endpoint+'?aid=2906&a_bogus=old&_signature=old',method:'POST',postData:new URLSearchParams({token,is_frontier:'true',next:'https://creator.douyin.com/'}).toString()};
  const prepared=douyinPollRequest(request,token),body=new URLSearchParams(prepared.body);
  assert.equal(prepared.method,'POST');assert.equal(body.get('is_frontier'),'false');assert.equal(body.get('token'),token);
  assert.equal(body.get('next'),'https://creator.douyin.com/');assert.equal(new URL(prepared.url).searchParams.get('aid'),'2906');assert.doesNotMatch(prepared.url,/a_bogus|_signature/);
  assert.equal(new URLSearchParams(request.postData).get('is_frontier'),'true');
  const get=douyinPollRequest({url:endpoint+'?token='+token+'&aid=6383',method:'GET'},token);
  assert.equal(get.method,'GET');assert.equal(new URL(get.url).searchParams.get('is_frontier'),'false');assert.equal(get.body,undefined);
  for(const url of ['http://creator.douyin.com/passport/web/check_qrconnect/','https://evil.test/passport/web/check_qrconnect/','https://creator.douyin.com:8443/passport/web/check_qrconnect/','https://user@creator.douyin.com/passport/web/check_qrconnect/','https://creator.douyin.com/other'])assert.equal(douyinPollRequest({...request,url},token),null);
  assert.equal(douyinPollRequest(request,'OTHER'),null);assert.equal(douyinPollRequest({...request,method:'DELETE'},token),null);
});
test('确认不会被迟到的已扫描或过期响应回退；二次验证明确展示，不接受错误响应及其他 token',()=>{
  const b=new DouyinBrowser();qr(b);poll(b,{status:'scanned'});assert.equal(b.state,'scanned');
  poll(b,{status:'confirmed'},{token:'OTHER'});assert.equal(b.confirmed,false);
  poll(b,{status:'confirmed'},{status:500});assert.equal(b.confirmed,false);
  poll(b,{error_code:4031,status:'confirmed',redirect_url:'https://creator.douyin.com/'});assert.equal(b.confirmed,false);
  poll(b,{status:'confirmed',redirect_url:'https://evil.test/login'});assert.equal(b.confirmed,true);assert.equal(b.redirectUrl,undefined);
  assert.equal(b.state,'confirming');poll(b,{status:'scanned'});poll(b,{status:'expired'});assert.equal(b.state,'confirming');
  poll(b,{error_code:2046});assert.equal(b.state,'verification_required');poll(b,{status:'confirmed'});assert.equal(b.state,'verification_required');
  b.close();
});
test('官方自动换码使旧二维码失效，不把新 token 的确认当作旧码成功',()=>{
  const b=new DouyinBrowser();qr(b);qr(b,{token:'NEW_PRIVATE_TOKEN'});assert.equal(b.state,'expired');assert.equal(b.qrToken,token);
  poll(b,{status:'confirmed'},{token:'NEW_PRIVATE_TOKEN'});assert.equal(b.confirmed,false);b.close();
});
test('二维码按官方 UNIX 秒或毫秒与剩余秒数计算有效期，最多 3 分钟',()=>{
  const now=1792425900000;
  assert.equal(qrExpiresAt(now/1000+60,now),now+60000);assert.equal(qrExpiresAt(now+60000,now),now+60000);
  assert.equal(qrExpiresAt(60,now),now+60000);assert.equal(qrExpiresAt(undefined,now),now+180000);
  assert.equal(qrExpiresAt(now/1000+3600,now),now+180000);assert.equal(qrExpiresAt(now/1000-10,now),now-10000);
});
test('真实 Network 事件将响应与当前 POST token 关联，忽略非官方地址及其他页面',async()=>{
  const b=new DouyinBrowser();b.sessionId='MAIN';qr(b);
  b.call=async method=>{assert.equal(method,'Network.getResponseBody');return {body:JSON.stringify({message:'success',data:{error_code:0,status:'confirmed'}})};};
  const event=(method,params,sessionId='MAIN')=>b.message(JSON.stringify({method,params,sessionId}));
  event('Network.requestWillBeSent',{requestId:'poll',request:{url:endpoint+'?aid=2906',method:'POST',postData:'token='+token+'&is_frontier=true'}});
  assert.equal(new URLSearchParams(b.pollRequest.body).get('is_frontier'),'false');
  event('Network.responseReceived',{requestId:'other',response:{url:endpoint,status:200}},'OTHER_PAGE');assert.equal(b.responses.size,0);
  event('Network.responseReceived',{requestId:'evil',response:{url:'https://evil.test/passport/web/check_qrconnect/',status:200}});assert.equal(b.responses.size,0);
  event('Network.responseReceived',{requestId:'poll',response:{url:endpoint,status:200}});event('Network.loadingFinished',{requestId:'poll'});await new Promise(setImmediate);
  assert.equal(b.confirmed,true);assert.equal(b.requests.size,0);assert.equal(b.responses.size,0);b.close();
});
test('主动轮询在官方浏览器上下文执行，限频且坏响应不会中断原登录流程',async()=>{
  let now=Date.now(),calls=0;const b=new DouyinBrowser({now:()=>now});qr(b);
  b.pollRequest=douyinPollRequest({url:endpoint,method:'POST',postData:'token='+token+'&is_frontier=true'},token);
  b.evaluate=async expression=>{calls++;assert.match(expression,/credentials:'include'/);assert.match(expression,/AbortSignal.timeout/);return {status:200,body:{message:'success',data:{error_code:0,status:'confirmed'}}};};
  await b.pollLogin();assert.equal(b.confirmed,true);await b.pollLogin();assert.equal(calls,1);
  now+=3000;b.evaluate=async()=>{throw new Error('PRIVATE_BODY')};await assert.doesNotReject(b.pollLogin());assert.equal(b.state,'confirming');b.close();
});
test('缺少确认回调但新 Cookie 已写入时主动验证账号，并返回最新 Cookie',async()=>{
  const b=new DouyinBrowser();b.login=true;let reads=0,probes=0;
  b.call=async method=>{assert.equal(method,'Storage.getCookies');return {cookies:[session(++reads===1?'EARLY_PRIVATE':'FINAL_PRIVATE')]};};
  b.probeAuthentication=async()=>{probes++;b.authenticated=true;};
  const snapshot=await b.snapshot();assert.equal(snapshot.confirmed,false);assert.equal(snapshot.authenticated,true);assert.equal(probes,1);
  assert.equal(snapshot.cookies[0].value,'FINAL_PRIVATE');b.close();
});
test('Cookie 外形不能证明已登录，未通过账号验证不得标记成功',async()=>{
  const b=new DouyinBrowser();b.login=true;
  b.call=async()=>({cookies:[session('UNVERIFIED_PRIVATE')]});b.probeAuthentication=async()=>{};b.evaluate=async()=>false;
  assert.equal((await b.snapshot()).authenticated,false);
  b.observe('/web/api/media/user/info/',{status_code:0,user:{uid:'0'}});assert.equal(b.authenticated,false);
  b.observe('/aweme/v1/web/user/profile/self/',{status_code:0,user:{uid:'0'}});assert.equal(b.authenticated,false);b.close();
});
test('账号校验使用独立页面，不打断扫码原生回调，检查后关闭临时页面',async()=>{
  const b=new DouyinBrowser();b.sessionId='MAIN';const commands=[];
  b.call=async(method,params,sessionId)=>{commands.push({method,params,sessionId});if(method==='Target.createTarget')return {targetId:'PROBE'};if(method==='Target.attachToTarget')return {sessionId:'PROBE_SESSION'};return {};};
  b.evaluate=async(expression,awaitPromise,sessionId)=>{assert.equal(sessionId,'PROBE_SESSION');return {status_code:0,user:{uid:'12345'}};};
  await b.probeAuthentication();assert.equal(b.authenticated,true);
  const navigate=commands.find(c=>c.method==='Page.navigate');assert.equal(navigate.sessionId,'PROBE_SESSION');assert.equal(navigate.params.url,'https://creator.douyin.com/web/api/media/user/info/');
  assert.equal(commands.at(-1).method,'Target.closeTarget');assert.equal(commands.at(-1).params.targetId,'PROBE');b.close();
});
test('二次验证期间不主动短轮询或跳转；额外验证中出现登录 Cookie 仍可验证成功',async()=>{
  const b=new DouyinBrowser();b.login=true;b.state='verification_required';b.confirmed=true;b.confirmedAt=0;b.redirectUrl='https://creator.douyin.com/';
  b.pollLogin=async()=>assert.fail('must keep verification page intact');b.call=async method=>{assert.equal(method,'Storage.getCookies');return {cookies:[]};};b.evaluate=async()=>true;
  assert.equal((await b.snapshot()).state,'verification_required');
  b.call=async()=>({cookies:[session('NEW_PRIVATE')]});b.probeAuthentication=async()=>{b.authenticated=true;};assert.equal((await b.snapshot()).authenticated,true);b.close();
});
test('验证画面仅在隔离登录会话的官方身份验证页可读，拒绝已登录、失效或尺寸异常页面',async()=>{
  const b=new DouyinBrowser();b.login=true;b.state='verification_required';b.evaluate=async()=>({width:1280,height:900});
  b.call=async method=>{assert.equal(method,'Page.captureScreenshot');return {data:'dGVzdA=='};};
  const view=await b.verificationView();assert.equal(view.width,1280);assert.match(view.image,/^data:image\/jpeg;base64,/);
  b.authenticated=true;await assert.rejects(b.verificationView(),/当前没有/);b.authenticated=false;
  b.evaluate=async()=>null;await assert.rejects(b.verificationView(),/页面已变化/);
  b.evaluate=async()=>({width:999999,height:900});await assert.rejects(b.verificationView(),/页面已变化/);b.close();
});
test('人工验证只接受有界鼠标操作、数字验证码及有限按键，不接受脚本和网址',async()=>{
  const b=new DouyinBrowser();b.login=true;b.state='verification_required';b.verificationViewport=async()=>({width:1280,height:900});const calls=[];
  b.call=async(method,params)=>{calls.push({method,params});return {};};b.evaluate=async()=>true;
  await b.verificationInteract({type:'click',x:50,y:60});assert.equal(calls[0].method,'Input.dispatchMouseEvent');assert.equal(calls.at(-1).params.type,'mouseReleased');
  calls.length=0;await b.verificationInteract({type:'code',code:'123456'});assert.deepEqual(calls,[{method:'Input.insertText',params:{text:'123456'}}]);
  calls.length=0;await b.verificationInteract({type:'key',key:'Enter'});assert.equal(calls[0].params.windowsVirtualKeyCode,13);
  for(const input of [{type:'click',x:-1,y:10},{type:'click',x:1280,y:10},{type:'drag',from:{x:1,y:1},to:{x:Infinity,y:1}},{type:'code',code:'alert(1)'},{type:'code',code:'123456789'},{type:'key',key:'F12'},{type:'navigate',url:'https://evil.test'}])await assert.rejects(b.verificationInteract(input));
  b.close();
});
test('短信按钮必须在官方验证页中可见，拖动由人工提供端点并在结束时释放鼠标',async()=>{
  const b=new DouyinBrowser();b.verificationViewport=async()=>({width:1280,height:900});const calls=[];b.call=async(method,params)=>{calls.push({method,params});return {};};
  b.evaluate=async()=>({clicked:true});await b.verificationInteract({type:'sms'});assert.equal(calls.length,0);
  b.evaluate=async()=>null;await assert.rejects(b.verificationInteract({type:'sms'}),/官方可能已自动发送/);
  calls.length=0;await b.verificationInteract({type:'drag',from:{x:10,y:10},to:{x:110,y:10}});assert.equal(calls.at(-1).params.type,'mouseReleased');assert.equal(calls.at(-1).params.x,110);
  assert.equal(calls.filter(c=>c.params.type==='mouseMoved').length,21);b.close();
});
test('验证对话框完成后恢复登录同步，短暂加载空白不会打断验证',async()=>{
  let now=Date.now();const b=new DouyinBrowser({now:()=>now});b.login=true;b.state='verification_required';b.confirmed=true;
  b.call=async()=>({cookies:[]});b.evaluate=async()=>false;
  assert.equal((await b.snapshot()).state,'verification_required');now+=2000;assert.equal((await b.snapshot()).state,'verification_required');
  now+=1100;const result=await b.snapshot();assert.equal(result.state,'confirming');assert.equal(result.verificationComplete,true);b.close();
});

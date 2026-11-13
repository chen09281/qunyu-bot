import { prepareMessage } from './helpers/subscription-message.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync,symlinkSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {defaultConfig} from '../src/config.mjs';
import {createApplication} from '../src/server.mjs';
import {SubscriptionService} from '../src/subscriptions/service.mjs';
import {feedUrl,normalizeSource,parseFeed,readFeed,rsshubBase,sourceUrl} from '../src/subscriptions/feeds.mjs';
import {downloadFeedXml} from '../src/web-images.mjs';
const item=(id,title='更新 '+id)=>({id:String(id),title,link:'https://example.com/post/'+id,summary:'测试摘要',publishedAt:'2026-10-23T04:00:00.000Z'});
const rss=items=>`<?xml version="1.0"?><rss version="2.0"><channel><title>测试 RSS</title><link>https://example.com</link><description>Feed</description>${items.map(i=>`<item><guid>${i.id}</guid><title>${i.title}</title><link>${i.link}</link><description><![CDATA[<p>${i.summary}</p>]]></description><pubDate>Fri, 23 Oct 2026 04:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
const folder=t=>{const dir=mkdtempSync(join(tmpdir(),'qqbot-subscriptions-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
function fixture(t,options={}){
 const dir=folder(t),store={config:{...defaultConfig(),enabled:true,allowedGroups:['10003',{id:'10005',ds:false,video:false}]}},sent=[],logs=[];
 let feed={title:'测试源',items:[item(1)]},clock=Date.parse('2026-10-23T05:00:00Z'),reads=0;
 const settings={prepareMessage,onebot:async(a,p)=>sent.push({a,p}),fetchFeed:async()=>{reads++;return feed;},log:(...args)=>logs.push(args),now:()=>clock,...options};
 const service=new SubscriptionService(dir,store,settings);t.after(()=>service.close());
 return {dir,store,sent,logs,settings,service,add:(extra={})=>{service.upsert({name:'测试订阅',type:'github',source:'owner/repo',groups:['10003'],...extra});return service.state.entries.at(-1);},
  setFeed(items){feed={title:'测试源',items};},advance(ms){clock+=ms;},reads:()=>reads};
}

test('现成解析器支持 RSS 与 Atom，保留条目身份、清理正文、相对链接并去重',async()=>{
 const parsed=await parseFeed(rss([item('one','标题 &amp; 测试'),item('one','相同身份')]),'https://example.com/feed.xml');
 assert.equal(parsed.title,'测试 RSS');assert.equal(parsed.items.length,1);assert.equal(parsed.items[0].summary,'测试摘要');assert.equal(parsed.items[0].publishedAt,'2026-10-23T04:00:00.000Z');
 const atom=await parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>Release</title><entry><id>tag:github.com,2008:Repository/1/v2</id><title>v2</title><link href="/owner/repo/releases/tag/v2"/><updated>2026-10-23T01:00:00Z</updated><content type="html">&lt;p&gt;New release&lt;/p&gt;</content></entry></feed>','https://github.com/owner/repo/releases.atom');
 assert.equal(atom.items[0].link,'https://github.com/owner/repo/releases/tag/v2');assert.equal(atom.items[0].summary,'New release');
 for(const xml of ['<html>login</html>','not xml','<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+rss([]),rss([{...item(2),link:'file:///etc/passwd'}])])await assert.rejects(parseFeed(xml,'https://example.com/feed.xml'));
 await assert.rejects(parseFeed('x'.repeat(2*1024*1024+1),'https://example.com'));
});

test('来源标准化复用 GitHub Atom 与 RSSHub 官方 B 站路由，仅允许公网 HTTP 地址',async()=>{
 assert.equal(normalizeSource('github','https://github.com/DIYgod/RSSHub/releases'),'diygod/rsshub');
 assert.equal(normalizeSource('github','owner/repo.git'),'owner/repo');
 assert.equal(normalizeSource('bilibili','https://space.bilibili.com/2267573/?from=test'),'2267573');
 assert.equal(sourceUrl({type:'github',source:'owner/repo'},{}),'https://github.com/owner/repo/releases.atom');
 assert.equal(sourceUrl({type:'bilibili',source:'2267573'},{rsshubUrl:'https://feeds.example.com/hub/'}),'https://feeds.example.com/hub/bilibili/user/video/2267573');
 assert.equal(rsshubBase('https://rsshub.app/'),'https://rsshub.app');
 for(const suffix of ['?key=value','#fragment'])assert.throws(()=>rsshubBase('https://rsshub.app/'+suffix));
 for(const [type,value] of [['github','owner/.git'],['github','https://evil.example/owner/repo'],['github','owner/repo/issues'],['bilibili','0'],['bilibili','https://evil.example/123'],['unknown','x']])assert.throws(()=>normalizeSource(type,value));
 for(const url of ['http://127.0.0.1/a','http://169.254.169.254/meta','http://10.0.0.1/a','http://test.local/a','file:///tmp/a','https://user:pass@example.com/feed','http://example.com:3000/feed'])assert.throws(()=>feedUrl(url));
 let requested=[];const result=await readFeed({type:'bilibili',source:'123'},{rsshubUrl:'https://rsshub.app'},{download:async(url,options)=>{requested.push({url,options});return{xml:rss([item(1)]),url};}});
 assert.deepEqual(requested.map(r=>r.url),['https://rsshub.app/bilibili/user/video/123','https://rsshub.app/bilibili/user/dynamic/123']);assert.equal(result.items.length,1);assert.equal(requested[0].options.timeout,75);
});

test('抓取锁定公网 DNS，逐跳校验重定向、限制大小、支持取消且不发送 Cookie 或 API Key',async()=>{
 const lookup=async()=>[{address:'93.184.216.34',family:4}];let requests=0;
 const transport=handler=>(url,options,callback)=>{const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{requests++;const spec=handler(url,options),res=Readable.from(spec.chunks||[Buffer.from(rss([]))]);res.statusCode=spec.status||200;res.headers=spec.headers||{};callback(res);});return req;};
 const fetched=await downloadFeedXml('https://example.com/feed',{lookup,request:transport((url,options)=>{
  assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['Accept-Encoding'],'identity');
  options.lookup(url.hostname,{},(err,address)=>assert.equal(address,'93.184.216.34'));return{};
 })});assert.match(fetched.xml,/<rss/);
 const before=requests;
 await assert.rejects(downloadFeedXml('https://example.com/feed',{lookup:async()=>[{address:'127.0.0.1',family:4}],request:transport(()=>({}))}));assert.equal(requests,before);
 await assert.rejects(downloadFeedXml('https://example.com/feed',{lookup,request:transport(()=>({status:302,headers:{location:'http://169.254.169.254/meta'}}))}));
 await assert.rejects(downloadFeedXml('https://example.com/feed',{lookup,request:transport(()=>({chunks:[Buffer.alloc(2*1024*1024+1)]}))}));
 await assert.rejects(downloadFeedXml('https://example.com/feed',{lookup,request:transport(()=>({headers:{'content-type':'text/html'}}))}),/网页/);
 const c=new AbortController();c.abort();await assert.rejects(downloadFeedXml('https://example.com/feed',{signal:c.signal,lookup,request:transport(()=>({}))}));
});

test('默认关闭；保存校验类型、群授权、数量、重复源，修改其他设置不重置队列',async t=>{
 const f=fixture(t);assert.equal(f.service.status().settings.enabled,false);
 const entry=f.add();assert.equal(f.service.status().entries[0].pending,0);
 assert.throws(()=>f.add(),/已订阅/);
 for(const patch of [{groups:[]},{groups:['99999']},{groups:[10003]},{name:''},{type:'unknown'},{enabled:1},{include:'x'.repeat(201)},{bad:true}])assert.throws(()=>f.service.upsert(patch,entry.id));
 for(const patch of [{enabled:'yes'},{intervalMinutes:4},{intervalMinutes:5.5},{intervalMinutes:1441},{rsshubUrl:'http://127.0.0.1'},[]])assert.throws(()=>f.service.configure(patch));
 f.service.configure({enabled:true});await f.service.check(entry.id);f.service.configure({intervalMinutes:15});assert.ok(entry.initializedAt);
 assert.equal(statSync(join(f.dir,'subscriptions')).mode&0o777,0o700);assert.equal(statSync(f.service.path).mode&0o777,0o600);
 assert.deepEqual(f.store.config.allowedGroups,['10003',{id:'10005',ds:false,video:false}]);
});

test('首次只建立基线、预览不发消息；新增内容按旧到新发送，重启和手动重复检查不重推',async t=>{
 const f=fixture(t),entry=f.add();f.service.configure({enabled:true});
 const preview=await f.service.preview(entry.id);assert.equal(preview.items.length,1);assert.equal(entry.initializedAt,null);assert.equal(f.sent.length,0);
 const checked=await f.service.check(entry.id);assert.equal(checked.active,false);assert.equal(f.sent.length,0);assert.ok(entry.initializedAt);
 f.setFeed([item(3),item(2),item(1)]);await f.service.check(entry.id);
 assert.equal(f.sent.length,2);assert.match(f.sent[0].p.message.find(segment => segment.type === 'text').data.text,/https:\/\/example\.com\/post\/2$/);assert.match(f.sent[1].p.message.find(segment => segment.type === 'text').data.text,/https:\/\/example\.com\/post\/3$/);
 assert.deepEqual(f.sent[0].p.message.map(s=>s.type),['image','text']);assert.equal(f.sent[0].p.group_id,'10003');assert.doesNotMatch(f.sent[0].p.message.find(segment => segment.type === 'text').data.text,/北京时间|测试摘要|更新 2/);
 await f.service.check(entry.id);assert.equal(f.sent.length,2);assert.equal(f.service.status().entries[0].sent,2);
 f.service.close();const restored=new SubscriptionService(f.dir,f.store,f.settings);t.after(()=>restored.close());await restored.check(entry.id);assert.equal(f.sent.length,2);assert.equal(restored.status().entries[0].pending,0);
});

test('关键词包含任一命中、排除优先，修改过滤不补发旧条目，更换来源重新建立基线',async t=>{
 const f=fixture(t),entry=f.add({include:'更新,Release',exclude:'抽奖'});f.service.configure({enabled:true});await f.service.check(entry.id);
 f.setFeed([item(5,'普通内容'),item(4,'更新抽奖'),item(3,'RELEASE v3'),item(2,'版本更新'),item(1)]);await f.service.check(entry.id);assert.equal(f.sent.length,2);
 f.service.upsert({include:'',exclude:''},entry.id);await f.service.check(entry.id);assert.equal(f.sent.length,2);
 f.service.upsert({source:'owner/other'},entry.id);assert.equal(entry.initializedAt,null);await f.service.check(entry.id);assert.equal(f.sent.length,2);
});

test('多群只重试失败目标，记录重启保留；新增目标不会收到已排队旧内容',async t=>{
 const f=fixture(t),entry=f.add({groups:['10003','10005']});f.service.configure({enabled:true});await f.service.check(entry.id);
 let failure=true;f.service.onebot=async(a,p)=>{if(p.group_id==='10005'&&failure)throw Error('PRIVATE_ONEBOT_RESPONSE');f.sent.push({a,p});};
 f.setFeed([item(2),item(1)]);await f.service.check(entry.id);assert.equal(f.sent.length,1);assert.equal(f.service.status().entries[0].pending,1);
 assert.doesNotMatch(JSON.stringify(f.service.status())+JSON.stringify(f.logs),/PRIVATE_ONEBOT_RESPONSE/);
 f.service.close();const restored=new SubscriptionService(f.dir,f.store,{...f.settings,onebot:(...args)=>f.service.onebot(...args)});t.after(()=>restored.close());failure=false;await restored.check(entry.id);
 assert.deepEqual(f.sent.map(s=>s.p.group_id),['10003','10005']);assert.equal(restored.status().entries[0].pending,0);
 // Adding a new target after a failed delivery does not add it to the saved outbox.
 f.store.config.allowedGroups.push('10007');restored.upsert({groups:['10003','10005','10007']},entry.id);await restored.check(entry.id);assert.equal(f.sent.length,2);
});

test('暂停插件/机器人、移除目标与删除订阅会取消读取中的推送；并发检查不会重入',async t=>{
 for(const action of ['plugin','bot','groups','entry','remove','close'])await t.test(action,async t=>{
  const f=fixture(t),entry=f.add();f.service.configure({enabled:true});await f.service.check(entry.id);
  let finish;f.service.fetchFeed=async()=>new Promise(r=>finish=r);const pending=f.service.check(entry.id);
  await assert.rejects(f.service.check(entry.id),/执行中/);
  if(action==='plugin')f.service.configure({enabled:false});
  if(action==='bot')f.store.config.enabled=false;
  if(action==='groups')f.store.config.allowedGroups=[];
  if(action==='entry')f.service.upsert({enabled:false},entry.id);
  if(action==='remove')f.service.remove(entry.id);
  if(action==='close')f.service.close();
  finish({title:'测试',items:[item(2),item(1)]});await pending;assert.equal(f.sent.length,0);
 });
});

test('发送途中撤销剩余群授权后不发下一个群，已成功发送的目标不重复',async t=>{
 const f=fixture(t),entry=f.add({groups:['10003','10005']});f.service.configure({enabled:true});await f.service.check(entry.id);f.setFeed([item(2),item(1)]);
 f.service.onebot=async(a,p)=>{f.sent.push({a,p});f.store.config.allowedGroups=['10003'];f.service.cancel();};await f.service.check(entry.id);assert.equal(f.sent.length,1);
 f.service.onebot=async(a,p)=>f.sent.push({a,p});await f.service.check(entry.id);assert.equal(f.sent.length,1);assert.equal(f.service.status().entries[0].pending,0);
});

test('定时轮询遵守间隔与失败退避，队列每轮最多三个条目，空源基线之后仍能推送',async t=>{
 const f=fixture(t),entry=f.add();f.service.configure({enabled:true,intervalMinutes:5});f.setFeed([]);await f.service.check();assert.ok(entry.initializedAt);
 const before=f.reads();await f.service.check();assert.equal(f.reads(),before);
 f.advance(300000);f.setFeed([item(5),item(4),item(3),item(2),item(1)]);await f.service.check();assert.equal(f.sent.length,3);assert.equal(f.service.status().entries[0].pending,2);
 f.advance(300000);await f.service.check();assert.equal(f.sent.length,5);
 f.service.fetchFeed=async()=>{throw Error('SECRET_FEED_TOKEN');};f.advance(300000);await f.service.check();assert.equal(entry.failures,1);assert.doesNotMatch(JSON.stringify(f.service.status())+JSON.stringify(f.logs),/SECRET_FEED_TOKEN/);
 const first=entry.nextCheckAt;f.advance(300000);await f.service.check();assert.equal(entry.failures,2);assert.ok(entry.nextCheckAt>first+300000);
});

test('数据目录/状态符号链接被拒绝，停用插件和无授权群时不进行网络轮询',async t=>{
 const dir=folder(t),elsewhere=folder(t);symlinkSync(elsewhere,join(dir,'subscriptions'));assert.throws(()=>new SubscriptionService(dir,{config:defaultConfig()}),/符号链接/);
 const other=folder(t);mkdirSync(join(other,'subscriptions'));symlinkSync(join(elsewhere,'state'),join(other,'subscriptions','state.json'));assert.throws(()=>new SubscriptionService(other,{config:defaultConfig()}),/符号链接/);
 const f=fixture(t),entry=f.add();await f.service.check();assert.equal(f.reads(),0);f.service.configure({enabled:true});f.store.config.allowedGroups=[];await f.service.check();assert.equal(f.reads(),0);
 assert.deepEqual(f.service.status().entries[0].unauthorizedGroups,['10003']);await assert.rejects(f.service.check(entry.id),/没有已授权/);
});

test('管理 API 鉴权、同源、增删改查预览和检查使用真实插件，配置停用会取消在途请求',async t=>{
 let feed={title:'API 源',items:[item(1)]};const sent=[];
 const app=await createApplication({dataDir:folder(t),initialPassword:'test-subscriptions-password',bilibiliAutoStart:false,douyinAutoStart:false,checkinAutoStart:false,subscriptionAutoStart:false,subscriptionOptions:{prepareMessage,fetchFeed:async()=>feed}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.server.close(r)));const base='http://127.0.0.1:'+app.server.address().port;
 assert.equal((await fetch(base+'/api/subscriptions')).status,401);
 const headers={'Content-Type':'application/json','X-Admin-Request':'1'};
 const login=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({username:app.store.admin.username,password:'test-subscriptions-password'})});headers.Cookie=login.headers.get('set-cookie').split(';')[0];
 const request=(path,method='GET',data)=>fetch(base+'/api/'+path,{method,headers,...(data?{body:JSON.stringify(data)}:{})});
 assert.equal((await fetch(base+'/api/subscriptions',{method:'PUT',headers:{...headers,Origin:'https://evil.example'},body:'{"enabled":true}'})).status,403);
 await request('config','PUT',{enabled:true,deepseekKey:'SYNTHETIC_KEY',allowedGroups:['10003']});app.bot.onebot=async(a,p)=>sent.push({a,p});
 assert.equal((await request('subscriptions','PUT',{enabled:true,intervalMinutes:5})).status,200);
 assert.equal((await request('subscriptions','POST',{name:'API 订阅',type:'rss',source:'https://example.com/rss',groups:['10003']})).status,201);
 const entry=(await(await request('subscriptions')).json()).entries[0];
 assert.equal((await request('subscriptions/'+entry.id+'/preview','POST',{})).status,200);assert.equal(sent.length,0);
 await request('subscriptions/'+entry.id+'/check','POST',{});feed={title:'API 源',items:[item(2),item(1)]};await request('subscriptions/'+entry.id+'/check','POST',{});assert.equal(sent.length,1);
 assert.equal(app.bot.conversations.list().total,0);assert.equal(app.bot.stats.tokens,0);assert.ok(app.bot.logs.some(l=>l.source==='subscription'));
 let finish;app.subscriptions.fetchFeed=async()=>new Promise(r=>finish=r);const check=request('subscriptions/'+entry.id+'/check','POST',{});
 while(!finish)await new Promise(r=>setTimeout(r,2));await request('config','PUT',{enabled:false});finish({title:'源',items:[item(3),item(2),item(1)]});await check;assert.equal(sent.length,1);
 assert.equal((await request('subscriptions/'+entry.id,'PUT',{name:'已编辑'})).status,200);
 assert.equal((await request('subscriptions/'+entry.id+'/remove','POST',{})).status,200);assert.equal((await(await request('subscriptions')).json()).entries.length,0);
 assert.equal((await request('subscriptions/'+entry.id+'/remove','POST',{})).status,404);
 assert.equal(JSON.parse(readFileSync(join(app.dataDir,'subscriptions','state.json'))).entries.length,0);
});

test('一个目标发送失败不阻塞其他群，新增目标不补发旧队列，积压不会阻塞后续条目',async t=>{
 const f=fixture(t),entry=f.add({groups:['10003','10005']});f.service.configure({enabled:true});await f.service.check(entry.id);
 f.service.onebot=async(a,p)=>{if(p.group_id==='10003')throw Error('failed');f.sent.push({a,p});};
 f.setFeed([item(2),item(1)]);await f.service.check(entry.id);assert.deepEqual(f.sent.map(s=>s.p.group_id),['10005']);
 f.store.config.allowedGroups.push('10007');f.service.upsert({groups:['10003','10005','10007']},entry.id);
 f.service.onebot=async(a,p)=>f.sent.push({a,p});await f.service.check(entry.id);assert.deepEqual(f.sent.map(s=>s.p.group_id),['10005','10003']);
 // A full queue keeps unqueued feed IDs unseen and still drains its oldest rows.
 f.service.upsert({groups:['10003']},entry.id);
 entry.pending=Array.from({length:100},(_,i)=>({...item('queued-'+i),groups:['10003'],delivered:[]}));
 const count=f.sent.length;f.setFeed([item('new-unseen')]);await f.service.check(entry.id);
 assert.equal(f.sent.length,count+3);assert.equal(entry.seen.includes('new-unseen'),false);
 await f.service.check(entry.id);assert.equal(entry.seen.includes('new-unseen'),true);assert.equal(entry.pending.length,95);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Bot,extractPrivatePrompt,extractPrompt} from '../src/bot.mjs';
import {defaultConfig,openStore,validatePatch} from '../src/config.mjs';
import {Conversations,conversationKey} from '../src/conversations.mjs';
import {resolveMessageImages,imageOnlyPrompt,replyOnlyPrompt} from '../src/images.mjs';
import {CheckinService} from '../src/checkin/service.mjs';
import {createApplication} from '../src/server.mjs';

const text=value=>({type:'text',data:{text:value}}),image={type:'image',data:{url:'https://gchat.qpic.cn/test.png'}};
const event=(message=[text('你好')],extra={})=>({post_type:'message',message_type:'private',self_id:10001,user_id:10002,message_id:1,message,...extra});
const group=(message=[text('群内提问')],extra={})=>event([{type:'at',data:{qq:'10001'}},...message],{message_type:'group',group_id:10003,...extra});
const config=()=>({...defaultConfig(),enabled:true,deepseekKey:'SYNTHETIC_TEST_KEY',webSearchEnabled:false,cooldownSeconds:0,allowedGroups:['10003'],allowedPrivateUsers:['10002','10004']});
const idle=async bot=>{for(let n=0;n<400;n++){if(!bot.active&&!bot.queue.length)return;await new Promise(r=>setTimeout(r,5));}throw Error('bot did not become idle');};
const until=async check=>{for(let n=0;n<400;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('condition not reached');};
const folder=t=>{const p=mkdtempSync(join(tmpdir(),'qqbot-private-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;};
function fixture(t,overrides={}){
 const store={config:{...config(),...overrides}},bot=new Bot(store),sent=[],models=[];t.after(()=>bot.close());
 bot.prepareInputImages=async urls=>({images:urls,notes:'',stats:{}});
 bot.completion=async(prompt,c,trace,history,images)=>{models.push({prompt,history,images});return {text:'回答：'+prompt};};
 bot.onebot=async(action,params)=>{sent.push({action,params});};
 return {store,bot,sent,models};
}

test('旧配置默认关闭私聊，白名单严格验证、去重、持久化并保留群规则和密钥',async t=>{
 const dir=folder(t),legacy={...defaultConfig(),deepseekKey:'PRESERVE_TEST_KEY',allowedGroups:['10003']};delete legacy.allowedPrivateUsers;
 writeFileSync(join(dir,'config.json'),JSON.stringify(legacy));const store=await openStore(dir);
 assert.deepEqual(store.config.allowedPrivateUsers,[]);assert.equal(store.config.deepseekKey,legacy.deepseekKey);
 const result=store.save({allowedPrivateUsers:[' 10002 ','10002','10004']});assert.deepEqual(result.allowedPrivateUsers,['10002','10004']);
 for(const value of [null,'10002',[10002],['abc'],['123'],['12345\nInjected'],[{}],Array(501).fill('10002')]){
  assert.throws(()=>store.save({allowedPrivateUsers:value}),/私聊白名单/);
 }
 assert.deepEqual(store.config.allowedPrivateUsers,['10002','10004']);
 assert.equal((await openStore(dir)).config.deepseekKey,legacy.deepseekKey);assert.equal(statSync(join(dir,'config.json')).mode&0o777,0o600);
 assert.deepEqual(JSON.parse(readFileSync(join(dir,'config.json'))).allowedPrivateUsers,['10002','10004']);
 assert.deepEqual(validatePatch(defaultConfig(),{allowedPrivateUsers:[]}).allowedPrivateUsers,[]);
});

test('未授权私聊及伪造群号不能调用、回复、建会话或记录内容，不占用去重',async t=>{
 for(const allowedPrivateUsers of [[],undefined,['10004']]){
  const f=fixture(t,{allowedPrivateUsers});
  for(const message of [[text('PRIVATE_UNAUTHORIZED_CONTENT')],[image],[text('https://x.com/test/status/123')]]){
   assert.deepEqual(f.bot.receive(event(message,{group_id:10003})),{ignored:'private_not_allowed'});
  }
  assert.equal(f.models.length,0);assert.equal(f.sent.length,0);assert.equal(f.bot.conversations.list().total,0);assert.equal(f.bot.logs.length,0);
  f.store.config.allowedPrivateUsers=['10002'];assert.deepEqual(f.bot.receive(event()),{accepted:true});await idle(f.bot);assert.equal(f.models.length,1);
 }
 const f=fixture(t);
 for(const extra of [{user_id:10001},{self_id:'bad'},{user_id:'abc'},{message_id:null},{post_type:'message_sent'}])f.bot.receive(event(undefined,extra));
 assert.equal(f.models.length,0);assert.equal(f.bot.conversations.list().total,0);
 f.store.config.botId='99999';assert.equal(f.bot.receive(event()).ignored,'invalid_private_event');
});

test('白名单私聊无需 @，仅走私聊消息接口；群和私聊授权独立',async t=>{
 const f=fixture(t,{allowedGroups:[]});
 assert.equal(extractPrivatePrompt(event()),'你好');assert.equal(extractPrompt(event()),null);
 assert.equal(extractPrivatePrompt(event([image])),imageOnlyPrompt);assert.equal(extractPrivatePrompt(event([{type:'reply',data:{id:'123'}}])),replyOnlyPrompt);
 assert.equal(extractPrivatePrompt(event([],{})),null);
 assert.equal(f.bot.receive(event()).accepted,true);await idle(f.bot);
 assert.deepEqual(f.sent[0],{action:'send_private_msg',params:{user_id:10002,message:[text('回答：你好')]}});
 assert.equal(f.bot.logs[0].messageType,'private');assert.equal(f.bot.logs[0].group,undefined);assert.equal(f.bot.logDetail(f.bot.logs[0].id).replyMention,'');
 assert.equal(f.bot.conversations.list().items[0].groupId,'private');
 assert.equal(f.bot.receive(group()).ignored,'group_not_allowed');
 f.store.config.enabled=false;assert.equal(f.bot.receive(event(undefined,{message_id:2})).ignored,'disabled');
});

test('私聊与群聊、其他用户、机器人严格隔离上下文，重启仍保留',async t=>{
 const path=join(folder(t),'history.sqlite'),store={config:config()},bot=new Bot(store,new Conversations(path)),calls=[];t.after(()=>bot.close());
 bot.onebot=async()=>{};bot.completion=async(prompt,c,trace,history)=>{calls.push({prompt,history});return{text:'回复'+prompt};};
 for(const e of [group([text('群内')]),event([text('私聊')]),event([text('别人')],{user_id:10004}),event([text('另一个机器人')],{self_id:10005}),event([text('追问')],{message_id:2})]){bot.receive(e);await idle(bot);}
 assert.deepEqual(calls.slice(0,4).map(c=>c.history),[[],[],[],[]]);
 assert.deepEqual(calls[4].history,[{role:'user',content:'私聊'},{role:'assistant',content:'回复私聊'}]);
 assert.equal(bot.conversations.list().total,4);assert.notEqual(conversationKey(group()),conversationKey(event(undefined,{group_id:10003})));
 const privateId=bot.conversations.list().items.find(s=>s.groupId==='private'&&s.botId==='10001'&&s.userId==='10002').id;
 bot.close();const reopened=new Conversations(path);t.after(()=>reopened.close());assert.equal(reopened.context(privateId).length,4);
});

test('私聊去重、冷却与群聊独立，未授权账号不会进入队列',async t=>{
 const f=fixture(t,{cooldownSeconds:60});f.bot.receive(group());await idle(f.bot);
 assert.equal(f.bot.receive(event()).accepted,true);await idle(f.bot);
 assert.equal(f.bot.receive(event()).ignored,'duplicate');assert.equal(f.bot.receive(event(undefined,{message_id:2})).ignored,'cooldown');
 assert.equal(f.bot.receive(event(undefined,{user_id:10004})).accepted,true);await idle(f.bot);assert.equal(f.models.length,3);
});

test('移除私聊授权会取消生成与排队回复，其余白名单账号继续使用',async t=>{
 const f=fixture(t);let release;f.bot.completion=async()=>new Promise(r=>{release=()=>r({text:'不可发送的生成结果'});});
 f.bot.receive(event());f.bot.receive(event(undefined,{message_id:2}));assert.equal(f.bot.queue.length,1);
 f.store.config.allowedPrivateUsers=['10004'];release();await idle(f.bot);
 assert.equal(f.sent.length,0);assert.equal(f.bot.stats.failed,0);assert.equal(f.bot.conversations.context(f.bot.conversations.list().items[0].id).length,0);
 assert.ok(f.bot.logs.every(log=>f.bot.logDetail(log.id).replyStatus==='cancelled'));
 f.bot.completion=async()=>({text:'另一人的回复'});f.bot.receive(event(undefined,{user_id:10004}));await idle(f.bot);assert.equal(f.sent[0].params.user_id,10004);
});

test('私聊识图按实际模型能力发送，引用仅接受同一私聊中可确认归属的图片',async t=>{
 const f=fixture(t);f.bot.receive(event([image]));await idle(f.bot);assert.deepEqual(f.models[0].images,[image.data.url]);assert.equal(f.sent[0].action,'send_private_msg');
 const incoming={message_type:'private',sender:{user_id:10002},message:[image]};
 for(const quoted of [incoming,{...incoming,sender:{user_id:10001},target_id:10002}]){
  assert.deepEqual((await resolveMessageImages(event([{type:'reply',data:{id:'123'}}]),config(),async()=>quoted,replyOnlyPrompt)).urls,[image.data.url]);
 }
 for(const quoted of [{...incoming,sender:{user_id:10004}},{...incoming,sender:{user_id:10001}},{...incoming,group_id:10003},{...incoming,message_type:'group'}]){
  await assert.rejects(resolveMessageImages(event([{type:'reply',data:{id:'123'}}]),config(),async()=>quoted,replyOnlyPrompt),/当前私聊/);
 }
});

test('私聊文档使用 upload_private_file，生成中撤权后不上传并清理',async t=>{
 for(const revoke of [false,true]){
  const f=fixture(t);let release,cleaned=0;
  f.bot.completion=async()=>({document:{title:'测试文档',content:'正文',formats:['docx']}});
  f.bot.documents={create:async()=>new Promise(r=>{release=()=>r({files:[{name:'测试文档.docx',format:'docx',bytes:20,uploadPath:'/app/qqbot-media/test/document.docx'}],cleanup(){cleaned++;}});}),close(){}};
  f.bot.receive(event([text('生成一份 Word 文档')]));await until(()=>release);
  if(revoke)f.store.config.allowedPrivateUsers=[];release();await idle(f.bot);assert.equal(cleaned,1);
  if(revoke){assert.equal(f.sent.length,0);continue;}
  assert.deepEqual(f.sent.map(c=>c.action),['upload_private_file','send_private_msg']);assert.equal(f.sent[0].params.user_id,10002);assert.equal(f.sent[0].params.group_id,undefined);
  assert.match(f.sent[1].params.message[0].data.text,/已发送文件/);assert.ok(f.sent[1].params.message.every(s=>s.type!=='at'));
 }
});

test('签到绑定继续由插件处理，凭据不进入私聊 DS、日志或聊天记录',async t=>{
 const dir=folder(t),f=fixture(t,{allowedPrivateUsers:[]});let bound=0,clock=Date.now();
 f.bot.checkin=new CheckinService(dir,f.store,{now:()=>clock,adapters:{skland:{bind:async c=>{bound++;return c;}}},onebot:async(action,params)=>{
  if(action==='get_group_member_info')return {group_id:10003,user_id:10002};f.sent.push({action,params});
 }});f.bot.checkin.configure({enabled:true});
 f.bot.receive(group([text('/签到 开通')]));await Promise.all(f.bot.checkin.jobs);
 clock+=3100;
 f.bot.receive(event([text('/签到 绑定 森空岛 SYNTHETIC_PRIVATE_BINDING_TOKEN')],{message_id:2}));await Promise.all(f.bot.checkin.jobs);
 assert.equal(bound,1);assert.equal(f.models.length,0);assert.equal(f.bot.conversations.list().total,0);assert.doesNotMatch(JSON.stringify(f.bot.status()),/SYNTHETIC_PRIVATE_BINDING_TOKEN/);
});

test('私聊白名单 API 仅管理员同源可修改，webhook 使用保存的最新名单',async t=>{
 const app=await createApplication({dataDir:folder(t),initialPassword:'test-password-123',bilibiliAutoStart:false,douyinAutoStart:false,checkinAutoStart:false});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.server.close(r)));const base='http://127.0.0.1:'+app.server.address().port;
 assert.equal((await fetch(base+'/api/config')).status,401);
 const headers={'Content-Type':'application/json','X-Admin-Request':'1'};
 const login=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({username:app.store.admin.username,password:'test-password-123'})});headers.Cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await fetch(base+'/api/config',{method:'PUT',headers:{...headers,Origin:'https://foreign.example'},body:'{"allowedPrivateUsers":["10002"]}'})).status,403);
 for(const [value,status] of [[['10002'],200],[['bad'],400]])assert.equal((await fetch(base+'/api/config',{method:'PUT',headers,body:JSON.stringify({allowedPrivateUsers:value})})).status,status);
 assert.deepEqual(app.store.config.allowedPrivateUsers,['10002']);
 app.store.save({enabled:true,deepseekKey:'TEST_ONLY',webSearchEnabled:false,cooldownSeconds:0});const sent=[];app.bot.completion=async()=>({text:'私聊 API 验证'});app.bot.onebot=async(a,p)=>sent.push({a,p});
 const webhookHeaders={'Content-Type':'application/json',Authorization:'Bearer '+app.store.config.webhookToken};
 assert.equal((await fetch(base+'/onebot/events',{method:'POST',headers:webhookHeaders,body:JSON.stringify(event())})).status,200);await idle(app.bot);assert.equal(sent[0].a,'send_private_msg');
 await fetch(base+'/api/config',{method:'PUT',headers,body:'{"allowedPrivateUsers":[]}'});
 await fetch(base+'/onebot/events',{method:'POST',headers:webhookHeaders,body:JSON.stringify(event(undefined,{message_id:2}))});await idle(app.bot);assert.equal(sent.length,1);
});

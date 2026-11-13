import { prepareMessage } from './helpers/subscription-message.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Bot} from '../src/bot.mjs';
import {defaultConfig} from '../src/config.mjs';
import {DocumentGenerator} from '../src/documents.mjs';
import {SubscriptionService} from '../src/subscriptions/service.mjs';
import {SubscriptionCommands,subscriptionCommand} from '../src/subscriptions/commands.mjs';
import {normalizeSource,resolveSubscriptionSource,sourceUrl,readFeed} from '../src/subscriptions/feeds.mjs';
const uid='MS4wLjABAAAARcAHmmF9mAG3JEixq_CdP72APhBlGlLVbN-1eBcPqao';
const event=(text,extra={})=>({post_type:'message',message_type:'group',self_id:10001,group_id:10003,user_id:10002,message_id:1,message:[{type:'text',data:{text}}],...extra});
const feedItem=id=>({id:String(id),title:'更新 '+id,link:'https://example.com/'+id,summary:'',publishedAt:'2026-10-30T10:00:00Z'});
function fixture(t,options={}){
 const dir=mkdtempSync(join(tmpdir(),'qqbot-subscription-commands-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store={config:{...defaultConfig(),enabled:true,allowedGroups:[{id:'10003',ds:false,video:false},'10005'],allowedPrivateUsers:['10002'],deepseekKey:''}},calls=[],logs=[];let clock=0,id=0,role='admin',feed={title:'测试作者',items:[feedItem(1)]};
 const bot=new Bot(store);bot.onebot=async(a,p)=>{calls.push({a,p});if(a==='get_group_member_info')return{group_id:p.group_id,user_id:p.user_id,role};};
 const service=new SubscriptionService(dir,store,{now:()=>Date.parse('2026-10-30T10:00:00Z'),prepareMessage,onebot:(...a)=>bot.onebot(...a),fetchFeed:async()=>feed});service.configure({enabled:true});
 const rendered=[],documents=new DocumentGenerator(dir,{napcatMediaDir:'/shared/media',worker:async input=>{rendered.push(input);writeFileSync(join(input.directory,'document.pdf'),Buffer.from('%PDF-1.7\nTEST'));return{files:['document.pdf']};}});
 const imageRenders=[],helpImage={async create(){imageRenders.push(true);return 'base64://SUBSCRIPTION_HELP';},cancel(){}};
 const commands=new SubscriptionCommands(dir,store,service,{helpImage,...options,documents,now:()=>clock,onebot:(...a)=>bot.onebot(...a),log:(...a)=>logs.push(a)});bot.subscriptionCommands=commands;
 t.after(()=>{service.close();bot.close();});
 return{dir,store,bot,service,commands,calls,logs,rendered,documents,imageRenders,setRole:v=>role=v,setFeed:v=>feed=v,
  async send(text,extra={}){clock+=3100;const e=event(text,{...extra,message_id:++id}),result=bot.receive(e);await Promise.all(commands.jobs);return{result,event:e};},
  texts:()=>calls.filter(c=>['send_group_msg','send_private_msg'].includes(c.a)).map(c=>c.p.message.filter(s=>s.type==='text').map(s=>s.data.text).join(''))};
}

test('游戏订阅支持别名和本群绑定，普通成员不能添加，帮助仍单独发图片', async t => {
 const f=fixture(t);f.service.configure({enabled:true});
 await f.send('/订阅 游戏');assert.match(f.texts().at(-1),/明日方舟：终末地/);assert.equal(f.service.state.entries.length,0);
 await f.send('/订阅 游戏 zmd');assert.equal(f.service.state.entries[0].source,'endfield');assert.deepEqual(f.service.state.entries[0].groups,['10003']);assert.match(f.texts().at(-1),/前瞻直播/);
 await f.send('/订阅 游戏 终末地',{group_id:10005});assert.equal(f.service.state.entries.length,1);assert.deepEqual(f.service.state.entries[0].groups,['10003','10005']);
 f.setRole('member');await f.send('/订阅 游戏 zzz');assert.match(f.texts().at(-1),/管理员权限/);assert.equal(f.service.state.entries.length,1);
 await f.send('/订阅 帮助');assert.deepEqual(f.calls.at(-1).p.message.map(s=>s.type),['image']);
 f.setRole('admin');await f.send('/订阅 取消 '+f.service.state.entries[0].id.slice(0,8));assert.deepEqual(f.service.state.entries[0].groups,['10005']);
});

test('主页识别支持 B 站、抖音、GitHub、显式 RSS 与分享文字，拒绝作品和多链接',async()=>{
 assert.deepEqual(await resolveSubscriptionSource('https://space.bilibili.com/123?spm_id_from=x'),{type:'bilibili',source:'123'});
 assert.deepEqual(await resolveSubscriptionSource('B站 123'),{type:'bilibili',source:'123'});
 assert.equal(normalizeSource('bilibili','https://m.bilibili.com/space/123'),'123');
 assert.deepEqual(await resolveSubscriptionSource('来看博主 https://www.douyin.com/user/'+uid+'?from=share 。'),{type:'douyin',source:uid});
 assert.equal(normalizeSource('douyin','https://www.iesdouyin.com/share/user/123?sec_uid='+uid),uid);
 assert.equal(sourceUrl({type:'douyin',source:uid},{rsshubUrl:'https://example.com/rsshub'}),'https://example.com/rsshub/douyin/user/'+uid);
 const got=await readFeed({type:'douyin',source:uid},{rsshubUrl:'https://example.com'},{download:async url=>({url,xml:'<rss version="2.0"><channel><title>抖音作者</title><item><title>作品</title><link>https://www.douyin.com/video/1234567890</link></item></channel></rss>'})});assert.equal(got.title,'抖音作者');
 assert.deepEqual(await resolveSubscriptionSource('https://github.com/DIYgod/RSSHub?tab=readme'),{type:'github',source:'diygod/rsshub'});
 assert.deepEqual(await resolveSubscriptionSource('RSS https://example.com/custom?key=abc'),{type:'rss',source:'https://example.com/custom?key=abc'});
 for(const value of ['https://www.douyin.com/video/123','https://space.bilibili.com.evil.example/123','https://www.bilibili.com/video/BVtest','https://example.com/','https://github.com/o/r https://space.bilibili.com/1','RSS http://127.0.0.1/rss','https://user:pass@github.com/o/r'])await assert.rejects(resolveSubscriptionSource(value));
});

test('订阅列表显示当前群的同名抖音优先关系，不将其他群的关系带过来', async t => {
 const f=fixture(t);
 f.service.subscribeGroup({type:'bilibili',source:'123'},'10003');
 f.service.subscribeGroup({type:'bilibili',source:'123'},'10005');
 f.service.subscribeGroup({type:'douyin',source:uid},'10003');
 f.service.state.entries[0].lastTitle='同名博主 的 bilibili 空间';f.service.state.entries[1].lastTitle='同名博主';
 f.service.state.entries[1].lastReadAt=new Date().toISOString();
 await f.send('/订阅 列表');assert.match(f.texts().at(-1),/本群优先抖音/);assert.match(f.texts().at(-1),/本群同名跨平台优先来源/);
 await f.send('/订阅 列表',{group_id:10005});assert.doesNotMatch(f.texts().at(-1),/优先抖音|跨平台优先来源/);
});

test('分享短链沿用公网下载与取消，跳转必须仍是同平台主页',async()=>{
 const controller=new AbortController();let requested;
 const result=await resolveSubscriptionSource('6.66 主页分享 https://v.douyin.com/TEST/ 复制打开',{signal:controller.signal,download:async(url,opts)=>{requested={url,opts};return{url:'https://www.douyin.com/user/'+uid};}});
 assert.equal(result.source,uid);assert.equal(requested.url,'https://v.douyin.com/TEST/');assert.equal(requested.opts.signal,controller.signal);
 await assert.rejects(resolveSubscriptionSource('https://b23.tv/abc',{download:async()=>({url:'https://www.douyin.com/user/'+uid})}),/对应博主/);
 await assert.rejects(resolveSubscriptionSource('https://v.douyin.com/abc',{download:async()=>({url:'http://169.254.169.254/meta'})}));
});

test('帮助只发送一张图片，不附文字、@ 或文档，授权私聊也支持且独立于 DS',async t=>{
 const f=fixture(t);f.store.config.documentGenerationEnabled=false;f.service.configure({enabled:false});
 await f.send('/订阅 帮助');await f.send('/订阅 帮助',{message_type:'private',group_id:undefined});
 assert.equal(f.rendered.length,0);assert.equal(f.imageRenders.length,2);
 assert.deepEqual(f.calls.map(c=>c.a),['send_group_msg','send_private_msg']);
 for(const call of f.calls)assert.deepEqual(call.p.message,[{type:'image',data:{file:'base64://SUBSCRIPTION_HELP'}}]);
 assert.equal(f.bot.stats.tokens,0);assert.equal(f.bot.logs.length,0);
 const denied=await f.send('/订阅 帮助',{message_type:'private',group_id:undefined,user_id:10009});assert.equal(denied.result.ignored,'subscription_unauthorized');assert.equal(f.imageRenders.length,2);
});

test('文档指令单独发送 Word，群聊与授权私聊不附帮助图片或额外文字',async t=>{
 const f=fixture(t);f.store.config.documentGenerationEnabled=false;f.service.configure({enabled:false});
 await f.send('/订阅 文档');await f.send('/订阅 文档',{message_type:'private',group_id:undefined});
 assert.equal(f.rendered.length,2);assert.match(f.rendered[0].content,/各群分别选择作者/);assert.match(f.rendered[0].content,/抖音/);
 assert.deepEqual(f.calls.map(c=>c.a),['upload_group_file','upload_private_file']);assert.equal(f.imageRenders.length,0);
 assert.equal(f.calls[0].p.name,'订阅推送使用说明.pdf');assert.match(f.calls[0].p.file,/^\/shared\/media\//);assert.equal(existsSync(f.rendered[0].directory),false);
 assert.equal(f.bot.stats.tokens,0);assert.equal(f.bot.logs.length,0);
});

test('帮助图片失败只提示文档指令，生成时撤销授权或停止后不发图',async t=>{
 const f=fixture(t);f.commands.helpImage.create=async()=>{throw Error('PRIVATE_HELP_ERROR');};
 await f.send('/订阅 帮助');assert.match(f.texts().at(-1),/订阅 文档/);assert.doesNotMatch(JSON.stringify(f.calls)+JSON.stringify(f.logs),/PRIVATE_HELP_ERROR/);assert.equal(f.rendered.length,0);
 for(const action of ['group','close']){
  f.store.config.allowedGroups=['10003'];let finish;f.commands.helpImage.create=async()=>new Promise(r=>finish=r);
  const n=f.calls.length,pending=f.send('/订阅 帮助');await new Promise(r=>setImmediate(r));
  if(action==='group')f.store.config.allowedGroups=[];else f.commands.close();
  finish('base64://SUBSCRIPTION_HELP');await pending;assert.equal(f.calls.length,n);
 }
});

test('不同群选择不同来源，列表只看本群；同源多群取消不影响其他群和其队列',async t=>{
 const f=fixture(t);
 await f.send('/订阅 https://space.bilibili.com/123');await f.send('/订阅 https://github.com/owner/repo',{group_id:10005});
 assert.deepEqual(f.service.state.entries.map(e=>e.groups),[['10003'],['10005']]);
 await f.send('/订阅 列表');assert.match(f.texts().at(-1),/B 站投稿/);assert.doesNotMatch(f.texts().at(-1),/owner\/repo/);
 const shared=f.service.state.entries[0];await f.send('/订阅 https://space.bilibili.com/123',{group_id:10005});assert.deepEqual(shared.groups,['10003','10005']);
 await f.send('/订阅 https://space.bilibili.com/123',{group_id:10005});assert.equal(f.service.state.entries.length,2);assert.match(f.texts().at(-1),/本群已订阅/);
 shared.pending=[{...feedItem(9),groups:['10003','10005'],delivered:[]}];
 const foreign=f.service.state.entries[1];await f.send('/订阅 取消 '+foreign.id.slice(0,8));assert.equal(foreign.groups[0],'10005');
 await f.send('/订阅 取消订阅 '+shared.id.slice(0,8));assert.deepEqual(shared.groups,['10005']);assert.deepEqual(shared.pending[0].groups,['10005']);
 await f.send('/订阅 列表');assert.match(f.texts().at(-1),/还没有订阅/);
 await f.service.check(shared.id);f.calls.length=0;f.setFeed({title:'作者',items:[feedItem(2),feedItem(1)]});await f.service.check(shared.id);
 assert.ok(f.calls.length>0);assert.ok(f.calls.every(c=>c.a==='send_group_msg'&&c.p.group_id==='10005'));
 await f.send('/订阅 取消订阅 '+shared.id.slice(0,8),{group_id:10005});assert.equal(f.service.state.entries.includes(shared),false);
});

test('普通成员只能查看，伪造 sender.role 不授权；撤销群授权、停用或关闭不产生新订阅',async t=>{
 const f=fixture(t);f.setRole('member');await f.send('/订阅 https://space.bilibili.com/123',{sender:{role:'owner'}});assert.equal(f.service.state.entries.length,0);
 await f.send('/订阅 列表');assert.match(f.texts().at(-1),/还没有订阅/);f.setRole('owner');
 f.service.configure({enabled:false});await f.send('/订阅 https://space.bilibili.com/123');assert.equal(f.service.state.entries.length,0);
 f.service.configure({enabled:true});let finish;f.commands.resolveSource=async()=>new Promise(r=>finish=r);
 const pending=f.send('/订阅 https://space.bilibili.com/123');await new Promise(r=>setImmediate(r));f.store.config.allowedGroups=['10005'];
 finish({type:'bilibili',source:'123'});await pending;assert.equal(f.service.state.entries.length,0);
 f.store.config.enabled=false;const n=f.calls.length;await f.send('/订阅 帮助');assert.equal(f.calls.length,n);
});

test('不同群订阅不同作者时，更新内容只发往各自的目标群',async t=>{
 const f=fixture(t);await f.send('/订阅 https://space.bilibili.com/123');await f.send('/订阅 https://space.bilibili.com/456',{group_id:10005});
 let updated=false;f.service.fetchFeed=async entry=>({title:'作者 '+entry.source,items:[...(updated?[feedItem('new-'+entry.source)]:[]),feedItem('old-'+entry.source)]});
 for(const entry of f.service.state.entries)await f.service.check(entry.id);
 f.calls.length=0;updated=true;
 for(const entry of f.service.state.entries)await f.service.check(entry.id);
 assert.deepEqual(f.calls.map(call=>call.p.group_id),['10003','10005']);
 assert.match(f.calls[0].p.message.find(segment => segment.type === 'text').data.text,/new-123/);assert.doesNotMatch(f.calls[0].p.message.find(segment => segment.type === 'text').data.text,/new-456/);
 assert.match(f.calls[1].p.message.find(segment => segment.type === 'text').data.text,/new-456/);assert.doesNotMatch(f.calls[1].p.message.find(segment => segment.type === 'text').data.text,/new-123/);
});

test('重复事件不重复执行，非订阅文字及其他用户 @ 不截获，群名单仅返回当前群',async t=>{
 const f=fixture(t),sent=await f.send('/订阅 https://space.bilibili.com/123');assert.equal(f.bot.receive(sent.event).ignored,'duplicate');
 assert.equal(subscriptionCommand(event('订阅号是什么')),null);assert.equal(subscriptionCommand(event('/订阅 帮助',{message:[{type:'at',data:{qq:'10007'}},{type:'text',data:{text:'/订阅 帮助'}}]})),null);
 assert.equal(subscriptionCommand(event('/订阅 帮助',{message:[{type:'at',data:{qq:'10001'}},{type:'text',data:{text:'/订阅 帮助'}}]})),'帮助');
 assert.equal(f.service.state.entries.length,1);assert.equal(f.bot.stats.tokens,0);assert.equal(f.bot.logs.length,0);
 for(let i=0;i<11;i++)f.service.subscribeGroup({type:'github',source:'owner/repo'+i},'10003');
 await f.send('/订阅 列表 2');assert.match(f.texts().at(-1),/第 2\/2 页/);assert.equal(f.texts().at(-1).split('\n').filter(line=>line.startsWith('GitHub Release ·')).length,2);
 await f.send('/订阅 列表 9');assert.match(f.texts().at(-1),/页码应为/);
});

test('文档生成或上传失败给出可执行提示且不泄露原始错误；取消生成后不再上传',async t=>{
 const f=fixture(t);f.commands.documents={create:async()=>{throw Error('PRIVATE_RENDER_DETAIL');},close(){}};
 await f.send('/订阅 文档');assert.match(f.texts().at(-1),/暂时无法生成/);assert.doesNotMatch(JSON.stringify(f.calls)+JSON.stringify(f.logs),/PRIVATE_RENDER_DETAIL/);
 let cleanup=0;f.commands.documents={create:async()=>({files:[{uploadPath:'/test.docx',name:'订阅推送使用说明.docx'}],cleanup(){cleanup++;}}),close(){}};
 const onebot=f.bot.onebot;f.bot.onebot=async(a,p)=>{if(a==='upload_group_file')throw Error('PRIVATE_UPLOAD_DETAIL');return onebot(a,p);};
 await f.send('/订阅 文档');assert.match(f.texts().at(-1),/群文件权限/);assert.equal(cleanup,0);assert.doesNotMatch(JSON.stringify(f.calls),/PRIVATE_UPLOAD_DETAIL/);
 let finish;f.commands.documents={create:async()=>new Promise(r=>finish=r),close(){}};const pending=f.send('/订阅 文档');await new Promise(r=>setImmediate(r));f.commands.close();
 finish({files:[{uploadPath:'/test.docx',name:'test.docx'}],cleanup(){cleanup++;}});await pending;assert.equal(cleanup,1);
});

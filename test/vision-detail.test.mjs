import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {originalImageUrl,resolveMessageImages} from '../src/images.mjs';
import {downloadVisionImage} from '../src/web-images.mjs';
import {prepareVisionImages,runVisionWorker} from '../src/vision-images.mjs';
import {Bot} from '../src/bot.mjs';
import {defaultConfig} from '../src/config.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lR8AAAAASUVORK5CYII=','base64');
const python=process.env.VISION_PYTHON||process.env.LINK_PYTHON||'python3';
const pillow=spawnSync(python,['-I','-c','import PIL'],{timeout:10000}).status===0;
const event={post_type:'message',message_type:'group',self_id:10001,user_id:10002,group_id:10003,message_id:1,message:[{type:'at',data:{qq:'10001'}},{type:'image',data:{file:'photo.png',url:'https://gchat.qpic.cn/download?fileid=123&rkey=PRIVATE_IMAGE_TOKEN&spec=198'}}]};
const config={...defaultConfig(),enabled:true,allowedGroups:['10003'],deepseekKey:'TEST_KEY',webSearchEnabled:false};

test('QQ 原图地址仅在已知 CDN 修正缩略规格，带链接的文件仍优先刷新 get_image',async()=>{
 assert.equal(originalImageUrl(event.message[1].data.url),'https://gchat.qpic.cn/download?fileid=123&rkey=PRIVATE_IMAGE_TOKEN&spec=0');
 assert.equal(originalImageUrl('https://gchat.qpic.cn/gchatpic_new/1/2/198'),'https://gchat.qpic.cn/gchatpic_new/1/2/0');
 assert.equal(originalImageUrl('https://example.com/a?spec=198'),'https://example.com/a?spec=198');
 let calls=0;const result=await resolveMessageImages(event,config,async(action,params)=>{calls++;assert.equal(action,'get_image');assert.equal(params.file,'photo.png');return{url:'https://gchat.qpic.cn/download?rkey=REFRESHED&spec=198'};});
 assert.equal(calls,1);assert.match(result.urls[0],/REFRESHED&spec=0/);
 const fallback=await resolveMessageImages(event,config,async()=>{throw Error('PRIVATE_RESPONSE');});assert.match(fallback.urls[0],/spec=0/);
});

test('识图下载保留原始字节，支持超过发图的6MiB限制，且仍固定公网 DNS',async()=>{
 const original=Buffer.concat([png,Buffer.alloc(6*1024*1024)]);let calls=0;
 const request=(url,opts,callback)=>{assert.equal(opts.headers.Cookie,undefined);opts.lookup(url.hostname,{},(_err,ip)=>assert.equal(ip,'93.184.216.34'));const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{calls++;const response=Readable.from([original]);response.statusCode=200;response.headers={};callback(response);});return req;};
 const result=await downloadVisionImage('https://example.com/a.png',{lookup:async()=>[{address:'93.184.216.34',family:4}],request});assert.ok(result.buffer.equals(original));assert.equal(result.width,1);
 await assert.rejects(downloadVisionImage('https://example.com/a.png',{lookup:async()=>[{address:'127.0.0.1',family:4}],request}));assert.equal(calls,1);
});

test('预处理限制总切片和内联字节预算，记录尺寸与细节顺序；下载失败回退且取消不会被吞掉',async()=>{
 const requested=[];const prepared=await prepareVisionImages(['https://example.com/a','https://example.com/b'],{download:async()=>({buffer:png}),worker:async input=>{requested.push(input);return{width:2000,height:3000,overview:{mime:'image/png',data:png.toString('base64')},crops:[{box:[0,0,1200,1200],data:png.toString('base64')}],limited:false,partial:false};}});
 assert.equal(requested[0].maxCrops,4);assert.equal(requested[0].maxBytes,12*1024*1024);assert.equal(prepared.images.length,4);assert.equal(prepared.stats.imageDetailCrops,2);assert.equal(prepared.stats.imageSizes,'2000×3000、2000×3000');assert.match(prepared.notes,/局部坐标/);
 const fallback=await prepareVisionImages(['https://example.com/a'],{download:async()=>{throw Error('PRIVATE_DATA');}});assert.equal(fallback.stats.imagePreparationFallbacks,1);assert.deepEqual(fallback.images,['https://example.com/a']);assert.doesNotMatch(JSON.stringify(fallback),/PRIVATE_DATA/);
 const controller=new AbortController();await assert.rejects(prepareVisionImages(['https://example.com/a'],{signal:controller.signal,download:async()=>{controller.abort();throw Error();}}));
 await assert.rejects(prepareVisionImages(['https://example.com/a','https://example.com/b'],{download:async()=>({buffer:Buffer.alloc(21*1024*1024)}),worker:async()=>({width:100,height:100,overview:null,crops:[]})}),/合计超过 40 MiB/);
});

test('真实 Pillow 工作器保证截图裁剪像素一致、原始JPEG不重编码、长图覆盖与大小边界',{skip:!pillow},()=>{
 const result=spawnSync(python,['-I',fileURLToPath(new URL('./vision-worker_test.py',import.meta.url))],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);
});

test('真实机器人图片请求带 high 细节、整图和局部，并且不把图片数据写入历史和日志',{skip:!pillow},async()=>{
 const made=spawnSync(python,['-I','-c',"from PIL import Image, ImageDraw; import io,base64; im=Image.new('RGB',(4000,2400),'white'); ImageDraw.Draw(im).text((2000,1200),'Small print 739204',fill='black'); out=io.BytesIO(); im.save(out,format='PNG'); print(base64.b64encode(out.getvalue()).decode())"],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);const dense=Buffer.from(made.stdout.trim(),'base64');
 const bot=new Bot({config});let request;
 bot.prepareInputImages=urls=>prepareVisionImages(urls,{download:async()=>({buffer:dense}),worker:(input,opts)=>runVisionWorker(input,{...opts,python})});
 bot.onebot=async action=>action==='get_image'?{url:'https://gchat.qpic.cn/image.png?rkey=PRIVATE_IMAGE_TOKEN'}:{};
 bot.request=async(_url,body)=>{request=body;return{choices:[{message:{content:'测试图片已读取。'}}]};};
 try{bot.receive(event);for(let n=0;n<400&&bot.active;n++)await new Promise(r=>setTimeout(r,10));assert.equal(bot.stats.replied,1);const part=request.messages.at(-1).content[1];assert.equal(part.image_url.detail,'high');assert.ok(Buffer.from(part.image_url.url.split(',')[1],'base64').equals(dense));assert.match(request.messages.find(m=>m.content?.includes?.('程序已读取'))?.content,/4000×2400/);
 assert.equal(bot.logs[0].imageSizes,'4000×2400');assert.ok(bot.logs[0].imageDetailCrops>0);assert.ok(request.messages.at(-1).content.length>2);assert.doesNotMatch(JSON.stringify(bot.status())+JSON.stringify(bot.conversations.detail(bot.conversations.list().items[0].id)),/PRIVATE_IMAGE_TOKEN|iVBORw0/);
 }finally{bot.close();}
});

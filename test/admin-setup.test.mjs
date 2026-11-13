import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/server.mjs';
import { openStore, verifyPassword } from '../src/config.mjs';
import { prepareNapcat } from '../src/prepare-napcat.mjs';

function folder(t) { const dir=mkdtempSync(join(tmpdir(),'qqbot-first-admin-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir; }
async function fixture(t,dir=folder(t)) {
  const app=await createApplication({dataDir:dir,initialPassword:'',bilibiliAutoStart:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));});
  const url='http://127.0.0.1:'+app.server.address().port;
  const headers={'Content-Type':'application/json','X-Admin-Request':'1'};
  const post=(path,data,extra={})=>fetch(url+'/api/'+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(data)});
  return {app,dir,url,post};
}
const credentials={username:'delivery_admin',password:'password8',confirmPassword:'password8'};

test('全新安装没有默认账号或明文密码，必须先创建管理员；初始化仍受同源保护',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await (await fetch(f.url+'/api/setup')).json(),{required:true});
  assert.equal(existsSync(join(f.dir,'admin.json')),false);assert.equal(existsSync(join(f.dir,'initial-password.txt')),false);
  assert.equal((await fetch(f.url+'/api/config')).status,401);
  assert.equal((await f.post('login',{username:'admin',password:'password8'})).status,409);
  assert.equal((await f.post('setup-admin',credentials,{Origin:'https://evil.test'})).status,403);
  for(const data of [{...credentials,username:'ab'},{...credentials,username:'bad name'},{...credentials,password:'short',confirmPassword:'short'}, {...credentials,confirmPassword:'different'}]){
    assert.equal((await f.post('setup-admin',data)).status,400);
    assert.equal(existsSync(join(f.dir,'admin.json')),false);
  }
  const created=await f.post('setup-admin',credentials);assert.equal(created.status,201);
  const Cookie=created.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await (await fetch(f.url+'/api/setup')).json(),{required:false});
  assert.equal((await (await fetch(f.url+'/api/session',{headers:{Cookie}})).json()).username,credentials.username);
  assert.equal((await fetch(f.url+'/api/config',{headers:{Cookie}})).status,200);
  const admin=readFileSync(join(f.dir,'admin.json'),'utf8');assert.equal(admin.includes(credentials.password),false);assert.equal(statSync(join(f.dir,'admin.json')).mode & 0o777,0o600);
  assert.equal((await f.post('setup-admin',{...credentials,username:'takeover'})).status,409);
  assert.equal(readFileSync(join(f.dir,'admin.json'),'utf8'),admin);
  const login=await f.post('login',credentials);assert.equal(login.status,200);
  assert.equal((await f.post('login',{username:'admin',password:credentials.password})).status,401);
});

test('首次创建竞争只允许一位成功，跨 Store 实例也不能覆盖已创建账号',async t=>{
  const dir=folder(t),one=await openStore(dir),two=await openStore(dir);
  const results=await Promise.allSettled([one.setupAdmin('first_admin','password8'),two.setupAdmin('second_admin','another8')]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected').length,1);
  const saved=JSON.parse(readFileSync(join(dir,'admin.json')));
  assert.ok(['first_admin','second_admin'].includes(saved.username));assert.equal(one.setupRequired,false);assert.equal(two.setupRequired,false);
  assert.equal(await verifyPassword(saved.username==='first_admin'?'password8':'another8',saved),true);
});

test('自定义账号经改密、NapCat 初始化和服务重启后保持；旧账号不重新开放初始化',async t=>{
  const dir=folder(t),store=await openStore(dir);await store.setupAdmin('客户管理员','password8');
  await store.changePassword('changed88');const before=readFileSync(join(dir,'admin.json'),'utf8');
  await prepareNapcat(dir);assert.equal(readFileSync(join(dir,'admin.json'),'utf8'),before);
  const f=await fixture(t,dir);assert.equal(f.app.store.setupRequired,false);
  assert.equal(f.app.store.admin.username,'客户管理员');assert.equal(await verifyPassword('changed88',f.app.store.admin),true);
  assert.equal((await f.post('setup-admin',credentials)).status,409);
  assert.equal((await f.post('login',{username:'客户管理员',password:'changed88'})).status,200);
});

test('Ubuntu/Mac 一体化预配 NapCat 不创建默认管理员，首次页面引导仍可用',async t=>{
  const dir=folder(t);await prepareNapcat(dir);assert.equal(existsSync(join(dir,'admin.json')),false);
  assert.equal(existsSync(join(dir,'initial-password.txt')),false);assert.equal((await openStore(dir)).setupRequired,true);
});

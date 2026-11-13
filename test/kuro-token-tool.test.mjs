import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createApplication} from '../src/server.mjs';
import {parseCredential} from '../src/checkin/platforms.mjs';
import {tokenToolResponse} from '../src/checkin/token-tool/downloads.mjs';

const secret='PRIVATE_IOS_TEST_TOKEN_123456';
test('公开下载电脑包、安卓 APK 及 iOS 脚本，不需要后台登录，不接收账号数据',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'qqbot-kuro-download-'));
  mkdirSync(join(dir,'downloads'));writeFileSync(join(dir,'downloads/kuro-token-android.apk'),Buffer.from('504b0304414e44524f49445f544553545f4f4e4c59','hex'));
  const app=await createApplication({dataDir:dir,bilibiliAutoStart:false,douyinAutoStart:false,checkinAutoStart:false});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));rmSync(dir,{recursive:true,force:true});});
  const origin='http://127.0.0.1:'+app.server.address().port;
  const page=await fetch(origin+'/tools/kuro/');assert.equal(page.status,200);
  const html=await page.text();assert.match(html,/Scriptable/);assert.match(html,/下载安卓 APK/);assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
  const manifest=await(await fetch(origin+'/tools/kuro/manifest.json')).json();
  assert.equal(manifest.files.length,4);assert.equal(manifest.version,'1.1.0');assert.equal(manifest.android.available,true);
  for(const file of manifest.files){
    const response=await fetch(origin+file.url),bytes=Buffer.from(await response.arrayBuffer());
    assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/^attachment;/);
    assert.equal(bytes.length,file.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
    const head=await fetch(origin+file.url,{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);
    if(file.name.endsWith('.apk'))assert.equal(response.headers.get('content-type'),'application/vnd.android.package-archive');
    if(file.name.endsWith('.zip')){
      const result=spawnSync('python3',['-I','-c',`import io,sys,zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
 assert z.testzip() is None
 names={n.split('/',1)[1] for n in z.namelist()}
 assert names=={'kuro_token.py','desktop.html','启动.bat','启动.command','kuro-token-ios.js','README.md'}
 assert all(not n.endswith(('.env','.sqlite','.enc')) for n in names)
 assert 'same-device' not in z.read('kuro-token-tool/kuro_token.py').decode()
`],{input:bytes,encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);
    }
  }
  assert.equal((await fetch(origin+'/downloads/kuro-token-tool.zip',{method:'POST',body:secret})).status,405);
  assert.equal((await fetch(origin+'/downloads/kuro-token-android.apk',{method:'POST',body:secret})).status,405);
  assert.equal((await fetch(origin+'/tools/kuro/no-such-file')).status,404);
  assert.equal((await fetch(origin+'/downloads/kuro-token-secret.env')).status,404);
  assert.equal((await fetch(origin+'/api/checkin')).status,401);
  assert.deepEqual(app.checkin.state.members,{});
});

test('安卓包缺失、符号链接及无效文件不发布，缺失时不展示可用下载按钮',t=>{
 const dir=mkdtempSync(join(tmpdir(),'qqbot-android-artifact-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const apk=join(dir,'android.apk'), options={androidApkPath:apk};
 assert.equal(tokenToolResponse('/downloads/kuro-token-android.apk','GET',options).status,503);
 assert.doesNotMatch(tokenToolResponse('/tools/kuro/','GET',options).body.toString(),/下载安卓 APK/);
 assert.equal(JSON.parse(tokenToolResponse('/tools/kuro/manifest.json','GET',options).body).android.available,false);
 const target=join(dir,'private');writeFileSync(target,'PK\x03\x04'+secret);symlinkSync(target,apk);
 assert.equal(tokenToolResponse('/downloads/kuro-token-android.apk','GET',options).status,503);
 rmSync(apk);writeFileSync(apk,'not an apk');
 assert.equal(tokenToolResponse('/downloads/kuro-token-android.apk','GET',options).status,503);
});

test('iOS 脚本参数与输出兼容机器人，只访问官方 HTTPS，拒绝失败和风险响应',()=>{
  const source=readFileSync(new URL('../src/checkin/token-tool/kuro-token-ios.js',import.meta.url),'utf8');
  const context={};vm.createContext(context);
  vm.runInContext(source.split('// Scriptable entry')[0]+'\nglobalThis.api={extractCredential,loginSpec,parseLoginResponse};',context);
  const {extractCredential,loginSpec,parseLoginResponse}=context.api;
  const spec=loginSpec('13800000000','123456','device123','distinct123');
  assert.equal(spec.url,'https://api.kurobbs.com/user/sdkLogin');
  assert.equal(new URLSearchParams(spec.body).get('devCode'),spec.headers.devCode);
  const credential=parseLoginResponse({code:200,data:{token:secret,userId:'12345'}},'device123');
  const parsed=parseCredential('kuro',JSON.stringify(credential));
  assert.equal(parsed.token,secret);assert.equal(parsed.userId,'12345');assert.equal(parsed.devCode,'device123');
  assert.equal(extractCredential(secret).token,secret);
  for(const data of [{code:220,msg:secret},{code:200,success:false,data:{token:secret}},{code:200,data:{token:secret}}])assert.throws(()=>parseLoginResponse(data,'device123'),error=>!error.message.includes(secret));
  assert.throws(()=>loginSpec('bad','123456','device123','distinct123'));
  assert.throws(()=>extractCredential(JSON.stringify({code:220,data:{token:secret}})));
  assert.match(source,/onRedirect = \(\) => null/);assert.match(source,/allowInsecureRequest = false/);
  assert.doesNotMatch(source,/console\.log|Keychain\.|FileManager\./);
});

test('电脑本机工具登录与防跨站回归',()=>{
 const result=spawnSync('python3',['-B',fileURLToPath(new URL('./kuro-token-tool-test.py',import.meta.url))],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stdout+result.stderr);
});

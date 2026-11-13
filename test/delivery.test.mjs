import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

test('交付 ZIP 与文件夹一致、校验可验证、不夹带运行凭据，解压后无需 npm 依赖即可首次启动',t=>{
  const dir=mkdtempSync(join(tmpdir(),'qqbot-delivery-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const root=fileURLToPath(new URL('../',import.meta.url));
  const result=spawnSync(process.execPath,['scripts/package-delivery.mjs',dir],{cwd:root,encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const name=readdirSync(dir).find(n=>n.endsWith('.zip')),archive=join(dir,name),folder=join(dir,name.slice(0,-4));
  const expected=readFileSync(archive+'.sha256','utf8').split('  ')[0];assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'),expected);
  const inspect=spawnSync('python3',['-c',`import pathlib,sys,zipfile,hashlib
folder=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2]) as archive:
 assert archive.testzip() is None
 for name in archive.namelist():
  parts=pathlib.PurePosixPath(name).parts
  assert not any(p in ('data','node_modules','.git','AGENTS.md','.ssh','.local') for p in parts)
  assert all(not p.startswith('.env') or p in ('.env.example','.env.ubuntu.example') for p in parts)
  assert archive.read(name)==(folder.parent/name).read_bytes()
for line in (folder/'SHA256SUMS').read_text().splitlines():
 expected,name=line.split('  ',1)
 assert hashlib.sha256((folder/name).read_bytes()).hexdigest()==expected
`,folder,archive],{encoding:'utf8',timeout:10000});
  assert.equal(inspect.status,0,inspect.stdout+inspect.stderr);
  const appDir=join(folder,'应用');assert.equal(existsSync(join(appDir,'node_modules')),false);assert.equal(existsSync(join(appDir,'dist/index.html')),true);
  assert.equal(existsSync(join(appDir,'docs/subscriptions.md')),true);
  assert.equal(existsSync(join(appDir,'docs/tavern.md')),true);
  const code=`import {createApplication} from './src/server.mjs';
const app=await createApplication({dataDir:process.env.DELIVERY_TEST_DATA,initialPassword:'',bilibiliAutoStart:false});
try{await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
const setup=await(await fetch(base+'/api/setup')).json();if(!setup.required)throw Error('fresh setup missing');
if(app.subscriptions.status().settings.enabled)throw Error('subscriptions unexpectedly enabled');
const {parseFeed}=await import('./src/subscriptions/feeds.mjs');
try{await parseFeed('<rss version="2.0"><channel><title>Test</title></channel></rss>','https://example.com/rss');throw Error('missing parser accepted');}catch(error){if(error.code!=='RSS_PARSER_MISSING'||!error.message.includes('npm ci'))throw error;}
const page=await fetch(base+'/');if(!page.ok||!(await page.text()).includes('/assets/'))throw Error('prebuilt frontend missing');
const response=await fetch(base+'/api/setup-admin',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Request':'1'},body:JSON.stringify({username:'handover_admin',password:'password8',confirmPassword:'password8'})});if(response.status!==201)throw Error('cannot initialize delivered app');
console.log('delivery-smoke-ok');}finally{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));}`;
  const smoke=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:appDir,env:{...process.env,DELIVERY_TEST_DATA:join(dir,'smoke-data')},encoding:'utf8',timeout:15000});
  assert.equal(smoke.status,0,smoke.stdout+smoke.stderr);assert.match(smoke.stdout,/delivery-smoke-ok/);
  const repeated=spawnSync(process.execPath,['scripts/package-delivery.mjs',dir],{cwd:root,encoding:'utf8',timeout:10000});assert.notEqual(repeated.status,0);assert.match(repeated.stderr,/已存在/);
});

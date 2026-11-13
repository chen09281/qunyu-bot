import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseCredential} from '../src/checkin/platforms.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const jdk=process.env.KURO_ANDROID_JDK, json=process.env.KURO_ANDROID_JSON_JAR;
test('安卓登录协议与机器人绑定兼容，失败、过期、注入、超长和网络错误均脱敏', {skip:!jdk||!json},()=>{
 const directory=mkdtempSync(join(tmpdir(),'kuro-android-test-'));
 try {
  const source=join(root,'src/checkin/token-tool/android/java/local/qqbot/kuro/KuroProtocol.java');
  const compile=spawnSync(join(jdk,'bin/javac'),['-encoding','UTF-8','-cp',json,'-d',directory,source,join(root,'test/KuroProtocolTest.java')],{encoding:'utf8',timeout:30000});
  assert.equal(compile.status,0,compile.stderr);
  const run=spawnSync(join(jdk,'bin/java'),['-cp',directory+':'+json,'KuroProtocolTest'],{encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stderr);
  const command=run.stdout.trim();assert.ok(command.startsWith('/签到 绑定 库街区 '));
  const credential=parseCredential('kuro',command.slice('/签到 绑定 库街区 '.length));
  assert.equal(credential.token,'SYNTHETIC_ANDROID_TOKEN_123456');assert.equal(credential.devCode,'same-device-123');assert.equal(credential.userId,'12345');
 } finally {rmSync(directory,{recursive:true,force:true});}
});

test('安卓 APK 仅声明网络权限，禁用备份和明文流量，凭据不写存储、不自动读取短信',()=>{
 const base=new URL('../src/checkin/token-tool/android/',import.meta.url);
 const manifest=readFileSync(new URL('AndroidManifest.xml',base),'utf8');
 assert.deepEqual([...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map(m=>m[1]),['android.permission.INTERNET']);
 assert.match(manifest,/allowBackup="false"/);assert.match(manifest,/usesCleartextTraffic="false"/);assert.match(manifest,/minSdkVersion="26"/);
 const activity=readFileSync(new URL('java/local/qqbot/kuro/MainActivity.java',base),'utf8');
 assert.match(activity,/FLAG_SECURE/);assert.match(activity,/setInstanceFollowRedirects\(false\)/);assert.match(activity,/setSaveEnabled\(false\)/);
 assert.doesNotMatch(activity,/SharedPreferences|openFileOutput|Log\.|WebView|TrustAll|setDefaultHostnameVerifier/);
});

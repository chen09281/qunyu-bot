import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync, symlinkSync, cpSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openStore } from '../src/config.mjs';
import { initializeUbuntu, repairDataPermissions, validateDataSource } from '../src/init-ubuntu.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const uid = process.getuid?.() || 1000, gid = process.getgid?.() || 1000;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-ubuntu-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Ubuntu 初始化修复目录模式并保留旧密码、模型、Key、QQ 数据和 Token，重复执行不重置', async t => {
  const dir = fixture(t), dataDir = join(dir, 'data');
  const store = await openStore(dataDir, 'password8');
  store.save({ deepseekKey: 'test-key-to-preserve', model: 'saved-model', allowedGroups: ['123456789'] });
  const adminBefore = readFileSync(join(dataDir, 'admin.json'), 'utf8');
  mkdirSync(join(dataDir, 'napcat/qq'), { recursive: true });
  writeFileSync(join(dataDir, 'napcat/qq/session.bin'), 'existing-session');
  chmodSync(dataDir, 0o755);
  const params = { dataDir, uid, gid, initialPassword: 'another-password' };
  await initializeUbuntu(params);
  const first = JSON.parse(readFileSync(join(dataDir, 'config.json')));
  await initializeUbuntu(params);
  const second = JSON.parse(readFileSync(join(dataDir, 'config.json')));
  assert.equal(readFileSync(join(dataDir, 'admin.json'), 'utf8'), adminBefore);
  assert.equal(second.deepseekKey, 'test-key-to-preserve');
  assert.equal(second.model, 'saved-model');
  assert.deepEqual(second.allowedGroups, [{ id: '123456789', ds: true, video: true, scheduledChat: true }]);
  assert.equal(second.webhookToken, store.config.webhookToken);
  assert.equal(second.napcatToken, first.napcatToken);
  assert.equal(second.onebotToken, first.onebotToken);
  assert.equal(readFileSync(join(dataDir, 'napcat/qq/session.bin'), 'utf8'), 'existing-session');
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dataDir, 'config.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dataDir, 'admin.json')).uid, uid);
});

test('Ubuntu 权限修复不跟随 QQ 锁符号链接，拒绝敏感配置符号链接和 root 用户', async t => {
  const dir = fixture(t), dataDir = join(dir, 'data'), outside = join(dir, 'outside');
  mkdirSync(dataDir); writeFileSync(outside, 'do-not-change', { mode: 0o644 });
  const before = statSync(outside);
  symlinkSync(outside, join(dataDir, 'SingletonLock'));
  repairDataPermissions(dataDir, uid, gid);
  assert.equal(readFileSync(outside, 'utf8'), 'do-not-change');
  assert.equal(statSync(outside).mode, before.mode);
  assert.equal(statSync(outside).uid, before.uid);
  symlinkSync(outside, join(dataDir, 'config.json'));
  await assert.rejects(initializeUbuntu({ dataDir, uid, gid }), /配置路径不能是符号链接/);
  assert.throws(() => repairDataPermissions(dataDir, 0, gid), /不能使用 root/);
  assert.throws(() => repairDataPermissions(dataDir, '1000;id', gid), /整数/);
  for (const path of ['/', '.', './', '/home', '/var', '../data']) assert.throws(() => validateDataSource(path), /独立的数据目录/);
  for (const path of ['./data', '/opt/qq bot/data', '/srv/qq-data']) assert.doesNotThrow(() => validateDataSource(path));
  assert.equal(readFileSync(outside, 'utf8'), 'do-not-change');
});

function shellFixture(t, options = {}) {
  const dir = fixture(t), project = join(dir, 'project with spaces'), bin = join(dir, 'bin');
  mkdirSync(project); mkdirSync(bin);
  for (const name of ['ubuntu.sh', '.env.ubuntu.example', 'compose.ubuntu.yaml']) cpSync(join(root, name), join(project, name));
  writeFileSync(join(project, '.env'), 'BOT_BIND=127.0.0.1\n');
  const state = join(dir, 'state.json'), log = join(dir, 'calls.jsonl');
  writeFileSync(state, JSON.stringify({ binding: '0.0.0.0:3080', ...options }));
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2), state = JSON.parse(fs.readFileSync(process.env.TEST_DOCKER_STATE));
fs.appendFileSync(process.env.TEST_DOCKER_LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'info') process.exit(0);
if (a[0] === 'inspect') {
  if (a[2].includes('NetworkSettings')) console.log(state.actualBinding || state.binding);
  else console.log('running healthy');
  process.exit(0);
}
if (a[0] !== 'compose') process.exit(10);
if (a[1] === 'version') process.exit(0);
const config = a.indexOf('-f');
if (config < 0 || !a[config + 1].endsWith('/compose.ubuntu.yaml')) process.exit(11);
if (!a.includes('--env-file') || !a[a.indexOf('--env-file') + 1].endsWith('/.env.ubuntu')) process.exit(12);
const command = a[config + 2];
if (command === 'build' && state.buildFail) process.exit(3);
if (command === 'run' && a.includes('--entrypoint')) console.log(state.binding);
if (command === 'run' && !a.includes('--entrypoint') && state.initFail) process.exit(4);
if (command === 'ps') console.log('test-container-id');
if (command === 'port') console.log(state.actualBinding || state.binding);
`, { mode: 0o755 });
  const run = () => spawnSync('/bin/bash', [join(project, 'ubuntu.sh'), 'deploy'], {
    cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_DOCKER_STATE: state, TEST_DOCKER_LOG: log }, encoding: 'utf8', timeout: 15000
  });
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { run, calls, project };
}

test('Ubuntu 部署在含空格目录工作，隔离旧 env、强制重建并检查实际公网端口', t => {
  const f = shellFixture(t), result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /实际端口：0.0.0.0:3080/);
  assert.equal(statSync(join(f.project, '.env.ubuntu')).mode & 0o777, 0o600);
  const calls = f.calls();
  assert.ok(calls.some(a => a.includes('up') && a.includes('--force-recreate')));
  const index = command => calls.findIndex(a => a.includes(command));
  assert.ok(index('build') < index('stop'));
  assert.ok(index('stop') < calls.findIndex(a => a.includes('run') && !a.includes('--entrypoint')));
});

test('Ubuntu 构建失败不停止旧服务，初始化失败不启动后台，端口未更新则部署失败', t => {
  const build = shellFixture(t, { buildFail: true });
  assert.equal(build.run().status, 3);
  assert.equal(build.calls().some(a => a.includes('stop')), false);
  const init = shellFixture(t, { initFail: true });
  assert.equal(init.run().status, 4);
  assert.equal(init.calls().some(a => a.includes('up')), false);
  const mismatch = shellFixture(t, { actualBinding: '127.0.0.1:3080' }), result = mismatch.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /端口绑定不符合配置/);
  assert.equal(result.stdout.includes('后台已健康运行'), false);
});

test('VPS 磁盘负载低于 90% 时跳过清理，超过 90% 时清理临时目录与 Docker 镜像构建缓存且不停止容器', async t => {
  const dir = fixture(t), bin = join(dir, 'bin'), log = join(dir, 'docker-calls.jsonl'), dfState = join(dir, 'df.txt');
  mkdirSync(bin);
  writeFileSync(join(bin, 'df'), `#!${process.execPath}
const fs = require('node:fs');
const pct = fs.readFileSync(process.env.TEST_DF_STATE, 'utf8').trim();
console.log('Filesystem 1024-blocks Used Available Capacity Mounted on');
console.log('/dev/vda2 52428800 40000000 12428800 ' + pct + '% /');
`, { mode: 0o755 });
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_DOCKER_LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'inspect') { console.log('true'); process.exit(0); }
if (a[0] === 'images') {
  console.log('qunyu-qq-bot:ubuntu');
  console.log('qunyu-qq-bot:before-53c1471');
  console.log('qunyu-qq-bot:rollback-20261029');
  process.exit(0);
}
if (a[0] === 'exec') {
  fs.writeFileSync(process.env.TEST_DF_STATE, '42');
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });

  const script = join(root, 'scripts/vps-disk-guard.sh');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_DF_STATE: dfState, TEST_DOCKER_LOG: log };

  // 1. 低于 90% 时不触发任何清理
  writeFileSync(dfState, '85');
  const low = spawnSync('/bin/bash', [script], { env, encoding: 'utf8' });
  assert.equal(low.status, 0, low.stderr);
  assert.match(low.stdout, /磁盘负载正常.*85%/);
  assert.equal(existsSync(log), false);

  // 2. 达到或超过 90% 时自动清理容器临时目录、历史回滚镜像与构建缓存，不执行 stop/restart
  writeFileSync(dfState, '92');
  const high = spawnSync('/bin/bash', [script], { env, encoding: 'utf8' });
  assert.equal(high.status, 0, high.stderr);
  assert.match(high.stdout, /触发自动磁盘清理.*92%/);
  assert.match(high.stdout, /清理完成.*92% -> 42%/);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.some(a => a[0] === 'exec' && a[1] === 'qunyu-qq-bot-1' && a.join(' ').includes('org.chromium.Chromium.')));
  assert.ok(calls.some(a => a[0] === 'rmi' && a[1] === 'qunyu-qq-bot:before-53c1471'));
  assert.ok(calls.some(a => a[0] === 'rmi' && a[1] === 'qunyu-qq-bot:rollback-20261029'));
  assert.equal(calls.some(a => a[0] === 'rmi' && a[1] === 'qunyu-qq-bot:ubuntu'), false);
  assert.ok(calls.some(a => a[0] === 'image' && a[1] === 'prune'));
  assert.ok(calls.some(a => a[0] === 'builder' && a[1] === 'prune'));
  assert.equal(calls.some(a => ['stop', 'restart', 'kill', 'rm'].includes(a[0])), false);

  // 3. --install-cron 生成 15 分钟定时巡检配置（兼容放置在独立目录如 /home/clean）
  const cleanDir = join(dir, 'clean');
  mkdirSync(cleanDir, { recursive: true });
  const standaloneScript = join(cleanDir, 'vps-disk-guard.sh');
  cpSync(script, standaloneScript);
  chmodSync(standaloneScript, 0o755);
  const cronFile = join(dir, 'qqbot-disk-guard.cron');
  const cronRes = spawnSync('/bin/bash', [standaloneScript, '--install-cron', '--threshold', '90'], {
    env: { ...env, DISK_GUARD_CRON_FILE: cronFile }, encoding: 'utf8'
  });
  assert.equal(cronRes.status, 0, cronRes.stderr);
  assert.match(readFileSync(cronFile, 'utf8'), /\*\/15 \* \* \* \* root .*\/clean\/vps-disk-guard\.sh" --threshold "90"/);

  // 4. 容器内定时 GC 清理超过 30 分钟的 Chromium 临时目录，保留近期目录
  const { Bot } = await import('../src/bot.mjs');
  const tmpRoot = join(dir, 'tmp');
  const staleDir = join(tmpRoot, 'org.chromium.Chromium.STALE');
  const freshDir = join(tmpRoot, 'org.chromium.Chromium.FRESH');
  mkdirSync(staleDir, { recursive: true });
  mkdirSync(freshDir, { recursive: true });
  const now = Date.now();
  utimesSync(staleDir, (now - 3600000) / 1000, (now - 3600000) / 1000);
  const bot = new Bot({ config: {} });
  t.after(() => bot.close());
  bot.pruneTransientCaches(now, tmpRoot);
  assert.equal(existsSync(staleDir), false);
  assert.equal(existsSync(freshDir), true);
});

test('三份机器人 Compose 与环境示例均透传 DATA_ENCRYPTION_KEY', () => {
  for (const file of ['compose.yaml', 'compose.integrated.yaml', 'compose.ubuntu.yaml']) {
    const content = readFileSync(join(root, file), 'utf8');
    assert.match(content, /^\s+DATA_ENCRYPTION_KEY:\s*\$\{DATA_ENCRYPTION_KEY:-\}\s*$/m, `${file} 缺少 DATA_ENCRYPTION_KEY 透传`);
  }
  for (const envFile of ['.env.example', '.env.ubuntu.example']) {
    const content = readFileSync(join(root, envFile), 'utf8');
    assert.match(content, /^DATA_ENCRYPTION_KEY=/m, `${envFile} 缺少 DATA_ENCRYPTION_KEY 示例`);
  }
});

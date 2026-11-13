import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopLocalRuntime } from '../src/runtime.mjs';
import { dockerSetupError } from '../src/deploy.mjs';

test('部署区分 Linux 的缺少 Docker、服务未连接、权限不足和超时', () => {
  assert.match(dockerSetupError({ error: { code: 'ENOENT' } }, 'linux'), /Docker Engine/);
  assert.match(dockerSetupError({ status: 1, stderr: 'permission denied while trying to connect to the Docker daemon socket' }, 'linux'), /当前用户无权访问 Docker/);
  assert.match(dockerSetupError({ status: 1, stderr: 'Cannot connect to the Docker daemon' }, 'linux'), /systemctl enable --now docker/);
  assert.match(dockerSetupError({ error: { code: 'ETIMEDOUT' } }, 'linux'), /检查超时/);
  for (const result of [{ error: { code: 'ENOENT' } }, { status: 1 }, { status: 1, stderr: 'permission denied' }]) assert.equal(dockerSetupError(result, 'linux').includes('Docker Desktop'), false);
  assert.match(dockerSetupError({ status: 1 }, 'darwin'), /启动 Docker Desktop/);
});

test('端口冲突时退出并给出可操作的中文提示', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'qqbot-startup-'));
  const occupied = createServer();
  await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    await new Promise(resolve => occupied.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const port = occupied.address().port;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: 'startup-test-password' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 1);
  assert.match(output, new RegExp(`端口 ${port} 已被占用`));
  assert.ok(output.includes(`http://127.0.0.1:${port}`));
  assert.match(output, /Ctrl\+C/);
  assert.match(output, /npm start/);
});

test('部署只接管身份匹配的本项目进程，保留当前管理密码', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'qqbot-runtime-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, ADMIN_PASSWORD: 'test1234', RUNTIME_MODE: 'local' },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } await rm(dataDir, { recursive: true, force: true }); });
  const { readFile, writeFile } = await import('node:fs/promises');
  const runtimePath = join(dataDir, 'runtime.json');
  let record;
  for (let i = 0; i < 100; i++) {
    try { record = JSON.parse(await readFile(runtimePath, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.equal(record.pid, child.pid);
  const adminBefore = await readFile(join(dataDir, 'admin.json'), 'utf8');
  await writeFile(runtimePath, JSON.stringify({ ...record, instanceId: 'stale-instance' }));
  assert.equal(await stopLocalRuntime(dataDir, record.port), false);
  assert.equal(child.exitCode, null);
  await writeFile(runtimePath, JSON.stringify(record));
  assert.equal(await stopLocalRuntime(dataDir, record.port), true);
  assert.equal(await exited, 0);
  assert.equal(await readFile(join(dataDir, 'admin.json'), 'utf8'), adminBefore);
});

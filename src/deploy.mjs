import { spawn, spawnSync } from 'node:child_process';
import { createServer, isIPv4 } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { prepareNapcat } from './prepare-napcat.mjs';
import { stopLocalRuntime } from './runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerPath = [...(process.env.PATH || '').split(':').filter(Boolean).map(dir => resolve(dir, 'docker')),
  resolve(homedir(), '.docker/bin/docker'), '/Applications/Docker.app/Contents/Resources/bin/docker']
  .find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } }) || 'docker';
function command(args, env) {
  return spawnSync(dockerPath, args, { cwd: root, env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
}
export function dockerSetupError(result, platform = process.platform) {
  const linux = platform === 'linux';
  if (result.error?.code === 'ENOENT') return linux
    ? '未找到 Docker 命令。请先安装 Docker Engine：https://docs.docker.com/engine/install/ubuntu/ ，然后重新运行 npm run deploy。'
    : '尚未安装 Docker。请安装并启动 Docker Desktop：https://www.docker.com/products/docker-desktop/ ，然后重新运行 npm run deploy。';
  if (linux && /permission denied|access denied|operation not permitted/i.test(result.stderr || '')) {
    return '当前用户无权访问 Docker。先执行 sudo docker info；如果成功，请将当前部署用户加入 docker 组并重新登录 SSH，再执行 docker info 和 npm run deploy。docker 组具有管理员级权限。';
  }
  if (result.error?.code === 'ETIMEDOUT') return 'Docker 检查超时。请先在同一终端执行 docker info，检查 Docker 服务、当前 context 和 DOCKER_HOST 设置。';
  return linux
    ? '无法连接 Docker 引擎。Ubuntu 请先执行 sudo systemctl enable --now docker，再执行 docker info；若仅 sudo docker info 成功，请检查当前用户的 Docker 组权限。'
    : 'Docker 引擎尚未就绪。请启动 Docker Desktop，等待引擎启动完成，并确认同一终端执行 docker info 成功后，再运行 npm run deploy。';
}
function portAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}
export async function deploy() {
  const env = { ...process.env, PATH: dockerPath === 'docker' ? process.env.PATH : `${dirname(dockerPath)}:${process.env.PATH || ''}`,
    BOT_UID: String(process.getuid?.() ?? 1000), BOT_GID: String(process.getgid?.() ?? 1000),
    BOT_DATA_DIR: resolve(process.env.DATA_DIR || resolve(root, 'data')), BOT_PORT: process.env.BOT_PORT || process.env.PORT || '3080',
    BOT_BIND: process.env.BOT_BIND || '127.0.0.1' };
  const docker = command(['info', '--format', '{{.ServerVersion}}'], env);
  if (docker.error || docker.status !== 0) throw new Error(dockerSetupError(docker));
  if (command(['compose', 'version'], env).status !== 0) throw new Error(process.platform === 'linux'
    ? '缺少 Docker Compose 插件。使用 Docker 官方 apt 软件源安装后，执行 sudo apt install docker-compose-plugin，并确认 docker compose version 成功。'
    : '缺少 Docker Compose，请安装或更新 Docker Desktop。');
  const compose = ['compose', '-f', 'compose.integrated.yaml'];
  const port = Number(env.BOT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535 的端口号');
  if (!isIPv4(env.BOT_BIND)) throw new Error('BOT_BIND 需为 IPv4 地址，例如 127.0.0.1 或 0.0.0.0');
  if (!await portAvailable(port, env.BOT_BIND)) {
    if (await stopLocalRuntime(env.BOT_DATA_DIR, port)) {
      console.log('正在停止本项目的本机后台，切换为 Docker 一体化运行…');
      for (let i = 0; i < 50; i++) {
        if (await portAvailable(port, env.BOT_BIND)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  if (!await portAvailable(port, env.BOT_BIND)) {
    const own = command([...compose, 'ps', '-q', 'qq-bot'], env);
    const id = own.stdout?.trim();
    let ownedPort = false;
    if (own.status === 0 && id && /^[a-f0-9]+$/.test(id)) {
      const inspect = command(['inspect', '-f', '{{json .NetworkSettings.Ports}}', id], env);
      try { ownedPort = JSON.parse(inspect.stdout)?.['3080/tcp']?.some(binding => binding.HostPort === String(port)); } catch { /* Treat unknown listeners as another service. */ }
    }
    if (!ownedPort) throw new Error(`端口 ${port} 正被本机后台占用。请先在运行 npm start 的终端按 Ctrl+C 停止服务，再执行 npm run deploy。`);
  }
  const prepared = await prepareNapcat(env.BOT_DATA_DIR, process.env.ADMIN_PASSWORD || '');
  console.log('已准备 NapCat 与机器人配置，原管理密码和机器人配置已保留。');
  console.log(`配置迁移备份：${prepared.backup}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(dockerPath, [...compose, 'up', '-d', '--build'], { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject); child.once('close', resolve);
  });
  if (code !== 0) throw new Error('Docker 部署未完成。请修复上方构建/镜像拉取错误后再次运行 npm run deploy。');
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    const ps = command([...compose, 'ps', '-q', 'qq-bot'], env);
    const id = ps.stdout?.trim();
    if (ps.status === 0 && id && /^[a-f0-9]+$/.test(id)) {
      const inspect = command(['inspect', '-f', '{{.State.Health.Status}}', id], env);
      const status = inspect.stdout?.trim();
      if (status === 'healthy') { healthy = true; break; }
      if (status === 'unhealthy') break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!healthy) throw new Error('qq-bot 容器未通过健康检查，请执行 docker compose -f compose.integrated.yaml logs qq-bot 排查。');
  console.log(`部署已启动并健康运行。打开 http://127.0.0.1:${port}/#connection ，点击「获取二维码」登录 QQ。`);
  if (env.BOT_BIND !== '127.0.0.1') console.log(`后台已绑定 ${env.BOT_BIND}:${port}。请在云平台防火墙放行 TCP ${port}，通过 http://服务器公网IP:${port} 访问。`);
  console.log('Docker 已在后台运行；请勿同时执行 npm start。首次使用请打开后台创建管理员账号和密码；已有账号保持不变。');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await deploy(); } catch (error) { console.error('一体化部署未启动：', error.message); process.exitCode = 1; }
}

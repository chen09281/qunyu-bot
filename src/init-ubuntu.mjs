import { chmodSync, existsSync, lchownSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareNapcat } from './prepare-napcat.mjs';

function accountId(value, name) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 2147483647) {
    throw new Error(`${name} 必须为 1–2147483647 的整数，后台不能使用 root 用户运行`);
  }
  return Number(value);
}

export function validateDataSource(value) {
  const source = String(value).trim();
  const broad = new Set(['.', '..', '/', '/home', '/root', '/etc', '/usr', '/var', '/opt', '/srv', '/tmp',
    '/run', '/proc', '/sys', '/dev', '/boot', '/bin', '/lib', '/lib64', '/sbin', '/mnt', '/media']);
  const normalized = posix.normalize(source).replace(/\/+$/, '') || '/';
  if (!source || source.split('/').includes('..') || broad.has(normalized)) {
    throw new Error('UBUNTU_DATA_DIR 必须指向独立的数据目录，例如 ./data；不能使用根目录、系统目录或项目目录本身');
  }
}

// Never follow a link while repairing ownership, including QQ's lock symlinks.
export function repairDataPermissions(dataDir, uid, gid) {
  uid = accountId(uid, 'UBUNTU_UID'); gid = accountId(gid, 'UBUNTU_GID');
  dataDir = resolve(dataDir);
  if (dataDir === '/') throw new Error('数据目录不能是根目录');
  if (existsSync(dataDir) && lstatSync(dataDir).isSymbolicLink()) throw new Error('数据目录不能是符号链接');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // These paths are opened by the config writer; forbid links before any read/write.
  const managed = ['config.json', 'admin.json', 'initial-password.txt', 'config.before-napcat.json',
    'conversations.sqlite', 'conversations.sqlite-wal', 'conversations.sqlite-shm',
    'config.json.tmp', 'admin.json.tmp', 'config.before-napcat.json.tmp',
    'media', 'link-cookies', 'link-cookie-jobs', 'checkin', 'checkin/key', 'checkin/accounts.enc', 'napcat', 'napcat/config', 'napcat/qq', 'napcat/plugins'];
  for (const relative of managed) {
    const path = join(dataDir, relative);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`配置路径不能是符号链接：${relative}`);
  }
  const configDir = join(dataDir, 'napcat/config');
  if (existsSync(configDir)) {
    for (const name of readdirSync(configDir)) {
      if ((/^webui\.json(?:\.tmp)?$/.test(name) || /^onebot11(?:_\d+)?\.json(?:\.tmp)?$/.test(name)) && lstatSync(join(configDir, name)).isSymbolicLink()) {
        throw new Error(`NapCat 配置不能是符号链接：${name}`);
      }
    }
  }
  const walk = path => {
    const stat = lstatSync(path);
    if (stat.uid !== uid || stat.gid !== gid) lchownSync(path, uid, gid);
    if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(dataDir);
  chmodSync(dataDir, 0o700);
  for (const name of ['config.json', 'admin.json', 'initial-password.txt', 'config.before-napcat.json', 'conversations.sqlite', 'conversations.sqlite-wal', 'conversations.sqlite-shm']) {
    if (existsSync(join(dataDir, name))) chmodSync(join(dataDir, name), 0o600);
  }
}

export async function initializeUbuntu({ dataDir = process.env.DATA_DIR || '/app/data', uid = process.env.UBUNTU_UID || '1000',
  gid = process.env.UBUNTU_GID || '1000', initialPassword = process.env.ADMIN_PASSWORD || '' } = {}) {
  if (process.env.EXPECTED_DATA_DIR !== undefined) validateDataSource(process.env.EXPECTED_DATA_DIR);
  repairDataPermissions(dataDir, uid, gid);
  try {
    const result = await prepareNapcat(dataDir, initialPassword);
    console.log('Ubuntu 数据初始化完成，现有管理密码、API Key、群设置和 QQ 数据已保留。');
    return result;
  } finally {
    // Root creates the config files, then hands them to the unprivileged runtime.
    repairDataPermissions(dataDir, uid, gid);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await initializeUbuntu(); }
  catch (error) {
    console.error(`Ubuntu 初始化失败：${error.message}`);
    console.error('请检查数据目录是否可写；使用标准 Docker Engine 时可执行 sudo bash ubuntu.sh deploy。');
    process.exitCode = 1;
  }
}

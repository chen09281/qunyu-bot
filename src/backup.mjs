import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const MAGIC = Buffer.from('QQBOTBAK1');
const SKIP_DIRS = new Set(['media', 'napcat', 'backups', 'downloads']);

function collectFiles(rootDir, currentDir = rootDir, list = []) {
  for (const name of readdirSync(currentDir)) {
    const full = join(currentDir, name);
    const rel = relative(rootDir, full);
    if (SKIP_DIRS.has(rel.split(/[\\/]/)[0])) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      collectFiles(rootDir, full, list);
    } else if (st.isFile()) {
      if (/\.(?:sqlite-(?:wal|shm)|tmp)$/i.test(name) || /\.corrupt\./i.test(name)) continue;
      list.push({ rel, full });
    }
  }
  return list;
}

export function createEncryptedBackup(dataDir, password, outFile = '') {
  if (!password || String(password).length < 8) {
    throw new Error('备份密码至少需要 8 个字符');
  }
  const sourceDir = resolve(dataDir);
  if (!existsSync(sourceDir)) throw new Error(`数据目录不存在: ${sourceDir}`);
  const snapshotDir = mkdtempSync(join(tmpdir(), 'qqbot-backup-'));
  try {
    const files = collectFiles(sourceDir);
    const entries = [];
    for (const { rel, full } of files) {
      let content;
      if (rel.endsWith('.sqlite')) {
        const snapPath = join(snapshotDir, basename(rel));
        const db = new DatabaseSync(full, { readOnly: true });
        try {
          db.exec(`VACUUM INTO '${snapPath.replaceAll("'", "''")}'`);
        } finally {
          db.close();
        }
        content = readFileSync(snapPath);
      } else {
        content = readFileSync(full);
      }
      entries.push({ path: rel.replaceAll('\\', '/'), data: content.toString('base64') });
    }
    const payload = gzipSync(Buffer.from(JSON.stringify({ version: 1, createdAt: new Date().toISOString(), entries }), 'utf8'));
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(String(password), salt, 32);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();
    const out = outFile ? resolve(outFile) : join(sourceDir, 'backups', `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.qqbak.enc`);
    mkdirSync(resolve(out, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(out, Buffer.concat([MAGIC, salt, iv, tag, encrypted]), { mode: 0o600 });
    return { path: out, files: entries.length };
  } finally {
    rmSync(snapshotDir, { recursive: true, force: true });
  }
}

export function restoreEncryptedBackup(backupFile, targetDir, password) {
  if (!password) throw new Error('请提供备份解密密码');
  const raw = readFileSync(resolve(backupFile));
  if (raw.length < MAGIC.length + 16 + 12 + 16 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('无效的加密备份文件格式');
  }
  let offset = MAGIC.length;
  const salt = raw.subarray(offset, offset + 16); offset += 16;
  const iv = raw.subarray(offset, offset + 12); offset += 12;
  const tag = raw.subarray(offset, offset + 16); offset += 16;
  const encrypted = raw.subarray(offset);
  const key = scryptSync(String(password), salt, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const parsed = JSON.parse(gunzipSync(compressed).toString('utf8'));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('备份清单格式无效');
  }
  const destRoot = resolve(targetDir);
  mkdirSync(destRoot, { recursive: true, mode: 0o700 });
  for (const entry of parsed.entries) {
    if (typeof entry.path !== 'string' || !entry.path || entry.path.includes('..') || entry.path.startsWith('/')) {
      throw new Error(`备份包含非法路径: ${entry.path}`);
    }
    const target = resolve(destRoot, entry.path);
    if (!target.startsWith(`${destRoot}/`)) throw new Error(`备份路径越界: ${entry.path}`);
    mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(target, Buffer.from(entry.data, 'base64'), { mode: 0o600 });
  }
  return { files: parsed.entries.length, createdAt: parsed.createdAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2] || 'backup';
  const password = process.env.BACKUP_PASSWORD || '';
  const dataDir = resolve(process.env.DATA_DIR || './data');
  try {
    if (mode === 'restore') {
      const file = process.argv[3];
      if (!file) throw new Error('用法: BACKUP_PASSWORD=xxx npm run restore -- <备份文件路径> [目标目录]');
      const dest = process.argv[4] || dataDir;
      const result = restoreEncryptedBackup(file, dest, password);
      console.log(`备份恢复完成：共恢复 ${result.files} 个文件（备份时间 ${result.createdAt}）。`);
    } else {
      const out = process.argv[3] || '';
      const result = createEncryptedBackup(dataDir, password, out);
      console.log(`加密备份已生成：${result.path}（共 ${result.files} 个文件）。`);
    }
  } catch (error) {
    console.error('备份操作失败：', error.message);
    process.exitCode = 1;
  }
}

import { mkdtempSync, mkdirSync, rmSync, lstatSync, readdirSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyOpenSourceTree, projectRoot } from './release-files.mjs';

const FORBIDDEN_SEGMENTS = new Set(['data', 'node_modules', 'dist', '.git', '.local', '.ssh', '.workbuddy', '.claude', 'AGENTS.md', 'GIT-WORKFLOW.md', '.githooks', '交付版本', 'release']);
const FORBIDDEN_EXTENSIONS = new Set(['.sqlite', '.sqlite3', '.db', '.pem', '.key', '.log', '.pyc']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ttf', '.woff', '.woff2', '.mp3', '.wav', '.aac', '.zip', '.apk']);
const SENSITIVE_TEXT_RX = /\/home\/ubuntu|\/home\/qq\b|\/Users\/(?!<)[\w.-]+|ssh:\/\/(?!<)|BEGIN [A-Z ]*PRIVATE KEY|\bsk-[A-Za-z0-9]{20,}|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/;
const IPV4_RX = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
const SAFE_TEST_IPS = new Set(['1.1.1.1', '8.8.8.8', '1.2.3.4', '93.184.216.34', '129.0.0.0', '130.0.0.0']);

function isAllowedIp(a, b, c, d, full) {
  if ([a, b, c, d].some(n => n > 255)) return true; // Not a valid IPv4 (e.g. version string).
  if (SAFE_TEST_IPS.has(full)) return true;
  if (a === 0 || a === 10 || a === 127 || a === 255) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return true;
  return false;
}

function collectFiles(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const file = join(directory, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('开源导出目录不能包含符号链接：' + file);
    return stat.isDirectory() ? collectFiles(file) : [file];
  });
}

function assertCleanOpenSourceFiles(root) {
  const extraPattern = process.env.OPENSOURCE_EXTRA_DENY?.trim();
  const extraRx = extraPattern ? new RegExp(extraPattern, 'i') : null;
  const files = collectFiles(root);
  for (const file of files) {
    const rel = relative(root, file).split('\\').join('/');
    const parts = rel.split('/');
    if (parts.some(part => FORBIDDEN_SEGMENTS.has(part))) throw new Error('检测到禁止导出的路径：' + rel);
    const filename = parts.at(-1);
    if (filename.startsWith('.env') && !['.env.example', '.env.ubuntu.example'].includes(filename)) throw new Error('检测到私密环境文件：' + rel);
    const ext = extname(filename).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.has(ext)) throw new Error('检测到禁止导出的文件类型：' + rel);
    if (BINARY_EXTENSIONS.has(ext)) continue;
    const text = readFileSync(file, 'utf8');
    const match = SENSITIVE_TEXT_RX.exec(text) || extraRx?.exec(text);
    if (match) throw new Error(`隐私检查拦截 ${rel}（命中 "${match[0]}"）`);
    for (const m of text.matchAll(IPV4_RX)) {
      if (!isAllowedIp(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), m[0])) {
        throw new Error(`隐私检查拦截 ${rel}（检测到未列入白名单的公网 IP：${m[0]}）`);
      }
    }
  }
  return files.length;
}

function runGit(cwd, args, env) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args[0]} 失败：${result.error?.message || result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

/**
 * Create a clean, single-commit open-source Git repository snapshot without private history.
 */
export function exportOpenSourceRepo({
  outputDir = join(projectRoot, 'release/opensource-repo'),
  force = false,
  authorName = process.env.OPENSOURCE_AUTHOR_NAME?.trim() || 'qunyu-bot',
  authorEmail = process.env.OPENSOURCE_AUTHOR_EMAIL?.trim() || 'noreply@users.noreply.github.com',
} = {}) {
  const target = resolve(outputDir);
  if (target === '/' || target === projectRoot || target.startsWith(join(projectRoot, '.git'))) {
    throw new Error('无效的导出目标路径：' + target);
  }
  if (existsSync(target) && !force) {
    throw new Error(`导出目录已存在：${target}（如需覆盖请传入 --force）`);
  }
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, '.tmp-opensource-'));
  try {
    copyOpenSourceTree(staging);
    const fileCount = assertCleanOpenSourceFiles(staging);
    const pkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'));
    const gitEnv = {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    };
    runGit(staging, ['-c', 'init.defaultBranch=main', 'init'], gitEnv);
    runGit(staging, ['config', 'user.name', authorName], gitEnv);
    runGit(staging, ['config', 'user.email', authorEmail], gitEnv);
    runGit(staging, ['add', '-A'], gitEnv);
    runGit(staging, ['-c', 'commit.gpgsign=false', 'commit', '-m', `chore: initial clean release v${pkg.version}`], gitEnv);
    const commit = runGit(staging, ['rev-parse', 'HEAD'], gitEnv);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    return { target, commit, fileCount, authorName, authorEmail };
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

const isMain = import.meta.url === new URL(`file://${resolve(process.argv[1] || '')}`).href;
if (isMain) {
  let force = false, outputDir;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--force' || arg === '-f') force = true;
    else if (arg.startsWith('-')) throw new Error('未知参数：' + arg);
    else if (!outputDir) outputDir = arg;
    else throw new Error('仅支持指定一个输出目录');
  }
  const result = exportOpenSourceRepo({ outputDir, force });
  console.log(`开源发布仓库：${result.target}`);
  console.log(`初始单提交：${result.commit}（作者：${result.authorName} <${result.authorEmail}>）`);
  console.log(`导出文件数：${result.fileCount}`);
  console.log(`下一步示例：cd "${result.target}" && git remote add origin https://github.com/<user>/<repo>.git && git push -u origin main`);
}

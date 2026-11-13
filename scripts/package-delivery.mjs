import { mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, readdirSync, lstatSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyReleaseSource, projectRoot } from './release-files.mjs';

const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json')));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error('版本号格式无效');
const name = `群屿QQ机器人-v${pkg.version}`, output = resolve(process.argv[2] || join(projectRoot, '交付版本'));
const destination = join(output, name), archive = join(output, name + '.zip');
if (existsSync(destination) || existsSync(archive)) throw new Error('交付文件已存在。为保护接收方修改，请指定新的输出目录：node scripts/package-delivery.mjs 新目录');
const staging = mkdtempSync(join(tmpdir(), 'qqbot-delivery-')), folder = join(staging, name);
const digest = content => createHash('sha256').update(content).digest('hex');
function files(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const file = join(directory, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('交付目录不能包含符号链接');
    return stat.isDirectory() ? files(file) : [file];
  });
}
try {
  mkdirSync(folder);
  copyReleaseSource(join(folder, '应用'));
  cpSync(join(projectRoot, 'docs/delivery/README.md'), join(folder, 'README.md'));
  mkdirSync(join(folder, '文档'));
  for (const file of readdirSync(join(projectRoot, 'docs/delivery')).filter(file => file.endsWith('.md') && file !== 'README.md').sort()) {
    cpSync(join(projectRoot, 'docs/delivery', file), join(folder, '文档', file));
  }
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  writeFileSync(join(folder, 'VERSION.json'), JSON.stringify({ name: '群屿 QQ 机器人', version: pkg.version, builtAt: new Date().toISOString(),
    sourceCommit: git.status === 0 ? git.stdout.trim() : null, frontendPrebuilt: true, containsUserData: false }, null, 2) + '\n');
  const entries = files(folder);
  for (const file of entries) {
    const parts = relative(folder, file).split('/');
    if (parts.some(part => ['data', 'node_modules', '.git', '.local', 'AGENTS.md', '.ssh', '.workbuddy', '.claude', '交付版本', 'release'].includes(part))
      || parts.some(part => part.startsWith('.env') && !['.env.example', '.env.ubuntu.example'].includes(part))
      || /\.(?:sqlite(?:-wal|-shm)?|db|pem|key|log)$/.test(file)) throw new Error('交付检查发现不允许的文件：' + file);
  }
  writeFileSync(join(folder, 'SHA256SUMS'), entries.map(file => `${digest(readFileSync(file))}  ${relative(folder, file).split('\\').join('/')}`).join('\n') + '\n');
  const zip = join(staging, name + '.zip');
  const result = spawnSync('python3', ['-c',
    'import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED,compresslevel=9) as out:\n for p in sorted(root.rglob("*")):\n  if p.is_file(): out.write(p,p.relative_to(root.parent))', folder, zip], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'ZIP 创建失败，需要 Python 3');
  mkdirSync(output, { recursive: true });
  renameSync(folder, destination); renameSync(zip, archive);
  writeFileSync(archive + '.sha256', `${digest(readFileSync(archive))}  ${name}.zip\n`);
  console.log(`交付文件夹：${destination}\n交付 ZIP：${archive}\n文件数量：${entries.length + 1}\nSHA256：${digest(readFileSync(archive))}`);
} finally { rmSync(staging, { recursive: true, force: true }); }

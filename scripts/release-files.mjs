import { cpSync, mkdirSync, lstatSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const commonFiles = ['src', 'frontend', 'test', 'scripts', 'package.json', 'package-lock.json',
  'vite.config.mjs', 'Dockerfile', 'requirements-parser.txt', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'README.md',
  '.dockerignore', '.gitignore', '.env.example', '.env.ubuntu.example', 'compose.yaml', 'compose.integrated.yaml', 'compose.ubuntu.yaml', 'compose.rsshub.yaml', 'ubuntu.sh'];
const deliveryDocs = ['UBUNTU.md', 'RUNBOOK.md', 'checkin.md', 'subscriptions.md', 'tavern.md', 'rsshub-maintenance.md', 'delivery'];

function copyFiltered(source, destination) {
  const filter = item => {
    if (lstatSync(item).isSymbolicLink()) throw new Error('交付源码中不能包含符号链接：' + item);
    return !['.DS_Store', '__pycache__'].includes(item.split('/').at(-1)) && !item.endsWith('.pyc');
  };
  cpSync(source, destination, { recursive: true, filter });
}

export function copyReleaseSource(destination) {
  if (!existsSync(join(projectRoot, 'dist/index.html'))) throw new Error('缺少构建好的前端，请先运行 npm run build');
  mkdirSync(destination, { recursive: true });
  for (const file of [...commonFiles, '.githooks', 'dist']) copyFiltered(join(projectRoot, file), join(destination, file));
  mkdirSync(join(destination, 'docs'));
  for (const file of deliveryDocs) copyFiltered(join(projectRoot, 'docs', file), join(destination, 'docs', file));
}

/** Export a clean source-only snapshot suitable for a single-commit public Git repository. */
export function copyOpenSourceTree(destination) {
  mkdirSync(destination, { recursive: true });
  for (const file of commonFiles) copyFiltered(join(projectRoot, file), join(destination, file));
  mkdirSync(join(destination, 'docs'));
  for (const entry of readdirSync(join(projectRoot, 'docs'), { withFileTypes: true })) {
    if (entry.name === 'GIT-WORKFLOW.md' || entry.name === '.DS_Store') continue;
    if (entry.isDirectory() || entry.name.endsWith('.md')) copyFiltered(join(projectRoot, 'docs', entry.name), join(destination, 'docs', entry.name));
  }
}

import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyReleaseSource, projectRoot } from './release-files.mjs';

const staging = mkdtempSync(join(tmpdir(), 'qqbot-ubuntu-release-'));
try {
  copyReleaseSource(join(staging, 'qq-bot-ubuntu'));
  const release = join(projectRoot, 'release'); mkdirSync(release, { recursive: true });
  const archive = join(release, 'qq-bot-ubuntu.tar.gz');
  const result = spawnSync('tar', ['-czf', archive, '-C', staging, 'qq-bot-ubuntu'], { env: { ...process.env, COPYFILE_DISABLE: '1' }, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || '打包失败');
  const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(join(release, 'qq-bot-ubuntu.sha256'), `${hash}  qq-bot-ubuntu.tar.gz\n`);
  console.log(`Ubuntu 部署包：${archive}\nSHA256：${hash}`);
} finally { rmSync(staging, { recursive: true, force: true }); }

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { exportOpenSourceRepo } from '../scripts/export-opensource.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-opensource-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('开源导出生成干净单提交仓库，不含历史隐私、构建产物或维护者本地文件', t => {
  const parent = tempDir(t);
  const target = join(parent, 'qunyu-bot-public');
  const result = exportOpenSourceRepo({ outputDir: target });
  assert.ok(result.fileCount > 100);
  assert.match(result.commit, /^[0-9a-f]{40}$/);

  for (const forbidden of ['dist', 'data', '.env', '.env.ubuntu', 'node_modules', '.workbuddy', '.claude', 'AGENTS.md', '.githooks', 'docs/GIT-WORKFLOW.md']) {
    assert.equal(existsSync(join(target, forbidden)), false, `不应包含 ${forbidden}`);
  }
  assert.ok(existsSync(join(target, 'README.md')));
  assert.ok(existsSync(join(target, 'docs/ds-persona.md')));
  assert.ok(existsSync(join(target, 'docs/delivery/README.md')));
  assert.match(readFileSync(join(target, 'src/config.mjs'), 'utf8'), /export const adminUsername = 'admin';/);

  const count = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: target, encoding: 'utf8' });
  assert.equal(count.status, 0);
  assert.equal(count.stdout.trim(), '1');

  const meta = spawnSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: target, encoding: 'utf8' });
  assert.equal(meta.status, 0);
  assert.equal(meta.stdout.trim(), 'qunyu-bot <noreply@users.noreply.github.com>');

  assert.throws(() => exportOpenSourceRepo({ outputDir: target }), /已存在/);
  writeFileSync(join(target, 'stale.txt'), 'old');
  const rebuilt = exportOpenSourceRepo({ outputDir: target, force: true, authorName: 'custom-org', authorEmail: 'ops@example.com' });
  assert.equal(existsSync(join(target, 'stale.txt')), false);
  const customMeta = spawnSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: rebuilt.target, encoding: 'utf8' });
  assert.equal(customMeta.stdout.trim(), 'custom-org <ops@example.com>');
});

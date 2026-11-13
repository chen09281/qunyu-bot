import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('RSSHub 凭据轮换、过期保护、环境加载验证、迁移保护和回滚', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync(process.env.VISION_PYTHON || 'python3', ['-B', fileURLToPath(new URL('./rsshub-sync-test.py', import.meta.url))], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stdout, /SYNTHETIC_SESSION|SYNTHETIC_CSRF/);
});

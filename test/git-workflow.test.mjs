import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('本地 Git 钩子默认阻止推送，只有单次明确放行变量时允许，不连接远程', () => {
  const hook = fileURLToPath(new URL('../.githooks/pre-push', import.meta.url));
  const blocked = spawnSync('sh', [hook], { encoding: 'utf8', env: { ...process.env, QQBOT_ALLOW_PUSH: '0' } });
  assert.equal(blocked.status, 1); assert.match(blocked.stderr, /已阻止推送/);
  const allowed = spawnSync('sh', [hook], { encoding: 'utf8', env: { ...process.env, QQBOT_ALLOW_PUSH: '1' } });
  assert.equal(allowed.status, 0);
});

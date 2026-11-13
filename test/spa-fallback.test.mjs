import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../src/server.mjs';

const built = existsSync(resolve(dirname(fileURLToPath(import.meta.url)), '../dist/index.html'));

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'qqbot-spa-'));
  const app = await createApplication({ dataDir, initialPassword: 'test1234' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.bot.close();
    await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true });
  });
  return { url };
}

test('刷新后台页面始终返回入口 HTML，缺失的静态资源与接口仍返回 JSON 404', { skip: built ? false : '需要先 npm run build' }, async t => {
  const { url } = await fixture(t);
  for (const path of ['/', '/index.html', '/chats', '/groups/', '/overview']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 200, path);
    const body = await response.text();
    assert.match(response.headers.get('content-type'), /text\/html/, path);
    assert.match(body, /<div id="app">/, path);
  }
  assert.equal((await fetch(url + '/favicon.svg')).status, 200);
  const asset = await fetch(url + '/assets/missing-file.js');
  assert.equal(asset.status, 404); assert.match(asset.headers.get('content-type'), /application\/json/);
  const page = await fetch(url + '/missing.css');
  assert.equal(page.status, 404); assert.match(page.headers.get('content-type'), /application\/json/);
  const api = await fetch(url + '/api/not-found');
  assert.equal(api.status, 401); assert.deepEqual(await api.json(), { error: '请先登录管理后台' });
});


test('正式后台返回前端实际引用的爱弥斯立绘，而非仅在预览服务器中可见', { skip: built ? false : '需要先 npm run build' }, async t => {
  const { url } = await fixture(t);
  const html = await (await fetch(url + '/')).text();
  const bundle = html.match(/src="([^" ]+\.js)"/);
  assert.ok(bundle, '入口必须引用构建后的脚本');
  const script = await (await fetch(url + bundle[1])).text();
  const image = script.match(/\/assets\/aemeath-[a-zA-Z0-9_-]+\.png/);
  assert.ok(image, '角色图片必须由构建资源导入');
  const response = await fetch(url + image[0]);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /image\/png/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
  assert.equal(bytes.readUInt32BE(16), 600);
  assert.equal(bytes.readUInt32BE(20), 595);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bot, extractPrompt } from '../src/bot.mjs';
import { Conversations } from '../src/conversations.mjs';
import { defaultConfig, validatePatch } from '../src/config.mjs';
import { imageOnlyPrompt, replyOnlyPrompt, publicImageUrl, resolveMessageImages } from '../src/images.mjs';
import { createApplication } from '../src/server.mjs';

const at = { type: 'at', data: { qq: '10001' } };
const image = (data = {}) => ({ type: 'image', data: { url: 'https://gchat.qpic.cn/image.png?rkey=PRIVATE_IMAGE_TOKEN', ...data } });
const reply = { type: 'reply', data: { id: '-123' } };
const event = (message = [at, image()], fields = {}) => ({ post_type: 'message', message_type: 'group', self_id: 10001,
  user_id: 10002, group_id: 10003, message_id: 1, message, ...fields });
const config = () => ({ ...defaultConfig(), allowedGroups: ['10003'], enabled: true, deepseekKey: 'mock-key', model: 'deepseek-v4-pro',
  webSearchEnabled: false, cooldownSeconds: 0 });
const originalInputs = async urls => ({ images: urls, notes: '', stats: {} });
const answer = () => ({ choices: [{ message: { content: '图片是一只白猫，文字为「你好」。', reasoning_content: 'PRIVATE_REASONING' } }],
  usage: { prompt_tokens: 111, completion_tokens: 20, total_tokens: 131 } });
const wait = async check => {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('任务未完成');
};

test('识图触发支持数组和 CQ 图片、仅 @ 加图片及引用；普通图片和转义 CQ 不触发', () => {
  assert.equal(extractPrompt(event()), imageOnlyPrompt);
  assert.equal(extractPrompt(event([at, reply])), replyOnlyPrompt);
  assert.equal(extractPrompt(event('[CQ:at,qq=10001][CQ:image,file=photo.png,url=https://gchat.qpic.cn/a?x=1&#44;2&amp;y=3]')), imageOnlyPrompt);
  assert.equal(extractPrompt(event([image()])), null);
  assert.equal(extractPrompt(event([at, image()], { message_type: 'private' })), null);
  assert.equal(extractPrompt(event('[CQ:at,qq=10001]&#91;CQ:image,url=https://example.com/image.png&#93;')), '[CQ:image,url=https://example.com/image.png]');
  assert.equal(extractPrompt(event('&#91;CQ:at,qq=10001&#93;[CQ:image,url=https://example.com/image.png]')), null);
  assert.equal(extractPrompt(event([at])), null);
});

test('只允许公网 HTTP(S) 图片链接，拒绝本机、内网、凭据、文件和内联数据', () => {
  assert.equal(publicImageUrl('https://gchat.qpic.cn/a?rkey=abc'), 'https://gchat.qpic.cn/a?rkey=abc');
  for (const value of ['http://localhost/a', 'http://127.0.0.1/a', 'http://2130706433/a', 'http://10.1.2.3/a',
    'http://172.16.0.1/a', 'http://192.168.1.2/a', 'http://169.254.169.254/a', 'http://100.64.0.1/a',
    'http://[::1]/a', 'http://napcat/a', 'http://foo.local/a', 'http://user:pass@example.com/a',
    'file:///etc/passwd', '/app/private.png', 'base64://secret', 'data:image/png;base64,secret', 'https://example.com/' + 'x'.repeat(8192)]) {
    assert.equal(publicImageUrl(value), null, value);
  }
});

test('引用图片仅从当前群获取，文件 ID 可用 get_image 解析，不读取本地路径', async () => {
  const c = config(), calls = [];
  const onebot = async (action, params) => {
    calls.push({ action, params });
    if (action === 'get_msg') return { group_id: 10003, message_type: 'group', message: '[CQ:image,file=photo.png]' };
    return { url: 'https://gchat.qpic.cn/resolved.png' };
  };
  assert.deepEqual(await resolveMessageImages(event([at, reply]), c, onebot, replyOnlyPrompt), { urls: ['https://gchat.qpic.cn/resolved.png'], source: 'reply' });
  assert.deepEqual(calls.map(x => x.action), ['get_msg', 'get_image']);
  assert.deepEqual(calls[0].params, { message_id: '-123' });
  await assert.rejects(resolveMessageImages(event([at, reply]), c, async () => ({ group_id: 99999, message: [image()] })), /当前群/);
  await assert.rejects(resolveMessageImages(event([at, reply]), c, async () => ({ message_type: 'private', message: [image()] })), /当前群/);
  await assert.rejects(resolveMessageImages(event([at, reply]), c, async () => { throw new Error('PRIVATE_REPLY_URL'); }), /无法读取引用消息/);
  await assert.rejects(resolveMessageImages(event([at, reply]), c, async () => ({ group_id: 10003, message: [] }), replyOnlyPrompt), /没有图片/);
  await assert.rejects(resolveMessageImages(event([at, reply, { type: 'text', data: { text: '图里是什么' } }]),
    { ...c, imageRecognitionEnabled: false }, async () => ({ group_id: 10003, message: [image()] }), '图里是什么'), /识别已关闭/);
  const multiple = await resolveMessageImages(event([at, ...Array.from({ length: 4 }, (_, i) => image({ url: `https://gchat.qpic.cn/${i}.png` }))]), c, onebot);
  assert.equal(multiple.urls.length, 4);
  let fileCalls = 0;
  await assert.rejects(resolveMessageImages(event([at, image({ url: '', file: '/app/private.png' })]), c, async () => { fileCalls++; }), /公网链接/);
  assert.equal(fileCalls, 0);
});

test('图片调用识图模型并统计用量，聊天重启后保留文本记忆而不存图片链接，文字继续原模型', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-vision-')), path = join(dir, 'chats.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = { config: config() }, requests = [], sent = [];
  const make = () => {
    const bot = new Bot(s, new Conversations(path));
    bot.prepareInputImages = originalInputs;
    bot.request = async (url, body, auth) => { requests.push({ url, body, auth }); return answer(); };
    bot.onebot = async (action, params) => { assert.equal(action, 'send_group_msg'); sent.push(params); };
    return bot;
  };
  let bot = make();
  assert.deepEqual(bot.receive(event()), { accepted: true }); await wait(() => bot.active === 0);
  assert.equal(sent.length, 1); assert.equal(requests.length, 1);
  assert.equal(requests[0].body.model, 'deepseek-flash'); assert.equal(requests[0].auth, 'mock-key');
  assert.deepEqual(requests[0].body.messages.at(-1).content, [{ type: 'text', text: imageOnlyPrompt },
    { type: 'image_url', image_url: { url: image().data.url, detail: 'high' } }]);
  assert.equal(bot.logs[0].tokens, 131); assert.equal(bot.logs[0].imageCount, 1); assert.equal(bot.logs[0].imageStatus, 'completed');
  assert.equal(bot.logDetail(bot.logs[0].id).model, 'deepseek-flash');
  const id = bot.conversations.list().items[0].id;
  assert.match(bot.conversations.detail(id).turns[0].prompt, /附带 1 张图片/);
  for (const object of [bot.status(), bot.logDetail(bot.logs[0].id), bot.conversations.detail(id)]) {
    const json = JSON.stringify(object);
    assert.equal(json.includes('PRIVATE_IMAGE_TOKEN'), false); assert.equal(json.includes('PRIVATE_REASONING'), false);
  }
  bot.close(); bot = make();
  bot.receive(event([at, { type: 'text', data: { text: '它是什么颜色？' } }], { message_id: 2 }));
  await wait(() => bot.active === 0);
  assert.equal(requests[1].body.model, 'deepseek-v4-pro');
  assert.equal(requests[1].body.messages[2].content, '图片是一只白猫，文字为「你好」。');
  assert.equal(JSON.stringify(requests[1].body).includes('PRIVATE_IMAGE_TOKEN'), false);
  assert.equal(requests[1].body.messages.at(-1).content, '它是什么颜色？');
  bot.close();
});

test('四张图片、开关、大小与损坏链接有边界，失败不调用 DS 或发送误导回复', async () => {
  for (const [message, patch, error] of [
    [[at, ...Array.from({ length: 5 }, () => image())], {}, /最多识别 4/],
    [[at, image()], { imageRecognitionEnabled: false }, /识别已关闭/],
    [[at, image({ file_size: 33 * 1024 * 1024 })], {}, /32 MiB/],
    [[at, image({ url: 'file:///private.png' })], {}, /公网链接/]
  ]) {
    const s = { config: { ...config(), ...patch } }, bot = new Bot(s); let calls = 0;
    bot.request = bot.onebot = async () => { calls++; throw new Error('不能调用上游'); };
    bot.receive(event(message)); await wait(() => bot.active === 0);
    assert.match(bot.logs[0].message, error); assert.equal(bot.logs[0].deepseekCalled, false);
    assert.equal(bot.logs[0].imageStatus, 'failed'); assert.equal(calls, 0); bot.close();
  }
  assert.throws(() => validatePatch(defaultConfig(), { imageRecognitionEnabled: 'true' }));
  assert.throws(() => validatePatch(defaultConfig(), { visionModel: '' }));
  assert.throws(() => validatePatch(defaultConfig(), { visionModel: 'x'.repeat(101) }));
  assert.equal(validatePatch(defaultConfig(), { visionModel: 'custom-vision', imageRecognitionEnabled: false }).visionModel, 'custom-vision');
});

test('图片请求失败保留真实 DS 调用及未知用量；读取图片时暂停不再调用模型', async () => {
  const s = { config: config() }, bot = new Bot(s);
  bot.prepareInputImages = originalInputs;
  bot.request = async () => { throw new Error('上游 HTTP 400'); };
  bot.onebot = async () => { throw new Error('不能发消息'); };
  bot.receive(event()); await wait(() => bot.active === 0);
  assert.equal(bot.logs[0].imageStatus, 'failed'); assert.equal(bot.logs[0].deepseekCalled, true);
  assert.equal(bot.logs[0].tokens, null);
  let release; bot.request = async () => { throw new Error('不应调用模型'); };
  bot.onebot = () => new Promise(resolve => { release = resolve; });
  bot.receive(event([at, reply], { message_id: 2 }));
  s.config.enabled = false; release({ group_id: 10003, message: [image()] });
  await wait(() => bot.active === 0);
  assert.equal(bot.logs[0].deepseekCalled, false); assert.equal(bot.logDetail(bot.logs[0].id).replyStatus, 'cancelled');
  bot.close();
});

test('图片无文字时跳过无意义搜索，有文字时搜索词只包含文字，图片仅交给识图接口', async () => {
  const c = { ...config(), webSearchEnabled: true }, bot = new Bot({ config: c }), calls = [], trace = {};
  bot.request = async (url, body) => { calls.push({ url, body }); return url.endsWith('/tools/search') ? { results: [] } : answer(); };
  await bot.completion(imageOnlyPrompt, c, trace, [], [image().data.url]);
  assert.equal(calls.length, 1); assert.equal(trace.searchStatus, 'skipped_image');
  calls.length = 0;
  await bot.completion('图中产品最近的新闻', c, trace, [], [image().data.url]);
  assert.equal(calls.length, 2); assert.equal(calls[0].body.query, '图中产品最近的新闻');
  assert.equal(JSON.stringify(calls[0]).includes('PRIVATE_IMAGE_TOKEN'), false);
  assert.equal(trace.tokens, 131); bot.close();
});

test('带图片的真实 webhook 路由只在有效 @ 后识别，设置重启后保留且公开接口不泄露 Key', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-vision-api-'));
  const app = await createApplication({ dataDir: dir, initialPassword: 'test1234' });
  const { webhookToken, ...patch } = config(); app.store.save(patch);
  app.bot.prepareInputImages = originalInputs;
  let modelCalls = 0;
  app.bot.request = async (url, body) => { modelCalls++; assert.equal(body.model, 'deepseek-flash'); return answer(); };
  app.bot.onebot = async () => {};
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.bot.close(); await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); rmSync(dir, { recursive: true, force: true }); });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${app.store.config.webhookToken}` };
  assert.equal((await fetch(url + '/onebot/events', { method: 'POST', headers, body: JSON.stringify(event([image()])) })).status, 200);
  assert.equal(modelCalls, 0);
  assert.equal((await fetch(url + '/onebot/events', { method: 'POST', headers, body: JSON.stringify(event()) })).status, 200);
  await wait(() => app.bot.stats.replied === 1); assert.equal(modelCalls, 1);
  const login = await fetch(url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }, body: JSON.stringify({ username: 'admin', password: 'test1234' }) });
  const adminHeaders = { 'Content-Type': 'application/json', 'X-Admin-Request': '1', Cookie: login.headers.get('set-cookie').split(';')[0] };
  const response = await fetch(url + '/api/config', { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ imageRecognitionEnabled: false, visionModel: 'custom-vision' }) });
  const saved = await response.json(); assert.equal(response.status, 200); assert.equal(saved.deepseekKey, undefined);
  assert.equal(saved.imageRecognitionEnabled, false); assert.equal(saved.visionModel, 'custom-vision');
  app.bot.close();
  const reopened = await createApplication({ dataDir: dir });
  assert.equal(reopened.store.config.imageRecognitionEnabled, false); assert.equal(reopened.store.config.visionModel, 'custom-vision'); reopened.bot.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { Bot } from '../src/bot.mjs';
import { defaultConfig } from '../src/config.mjs';
import { webImagePlan, markdownImages, pageImages, collectWebImages, selectReplyImages, downloadWebImage, downloadWebPage, rasterDimensions } from '../src/web-images.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHaQAAAAASUVORK5CYII=', 'base64');
const page = 'https://example.com/characters/lili', imageUrl = 'https://cdn.example.com/lili.png';
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
function transport(handler) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const spec = handler(url, options), res = Readable.from(spec.chunks || [png]);
      res.statusCode = spec.status || 200; res.headers = spec.headers || {};
      callback(res);
    });
    return req;
  };
}
const event = (text, message_id = 1, user_id = 10002) => ({ post_type: 'message', message_type: 'group', self_id: 10001,
  user_id, group_id: 10003, message_id, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text } }] });
const config = () => ({ ...defaultConfig(), enabled: true, allowedGroups: ['10003'], deepseekKey: 'PRIVATE_API_KEY', cooldownSeconds: 0 });
function mockBot(t, c = config()) {
  const store = { config: c }, bot = new Bot(store), calls = [], sent = [];
  t.after(() => bot.close());
  bot.request = async (url, body, auth) => {
    calls.push({ url, body, auth });
    if (url.endsWith('/tools/search')) return { results: [{ title: '莉莉角色图片', url: page, summary: '鸣潮角色莉莉的图片介绍' }] };
    if (url.endsWith('/tools/fetch')) return { title: '莉莉角色立绘', content: `![莉莉立绘](${imageUrl})\n![网站图标](https://cdn.example.com/logo.png)` };
    return { choices: [{ message: { content: '找到一张相关立绘：[[QQ_IMAGE:1]]\n\n来源：\nhttps://example.com', reasoning_content: 'PRIVATE_REASONING' } }],
      usage: { total_tokens: 30, prompt_tokens: 20, completion_tokens: 10 } };
  };
  bot.downloadReplyImage = async url => { assert.equal(url, imageUrl); return { file: `base64://${png.toString('base64')}`, bytes: png.length, width: 1920, height: 1080 }; };
  bot.readImagePage = async () => ({ content: '', url: page });
  bot.onebot = async (action, params) => { assert.equal(action, 'send_group_msg'); sent.push(params); };
  return { store, bot, calls, sent };
}

test('找图意图与上下文追问保留主体，不把识图或普通问答误当发图请求', () => {
  const history = [{ role: 'user', content: '帮我找鸣潮莉莉的立绘' }, { role: 'assistant', content: '暂时无法附图。' }];
  assert.equal(webImagePlan('帮我找鸣潮莉莉的立绘').wanted, true);
  assert.equal(webImagePlan('找一张猫的照片发给我').wanted, true);
  assert.equal(webImagePlan('发出来', history).wanted, true);
  assert.match(webImagePlan('发出来', history).query, /鸣潮莉莉/);
  assert.equal(webImagePlan('发出来', []).wanted, false);
  assert.equal(webImagePlan('不要发图，只要文字', history).wanted, false);
  assert.equal(webImagePlan('图片识别怎么打开').wanted, false);
  assert.equal(webImagePlan('生成一张图片').wanted, false);
  assert.equal(webImagePlan('你能识别图片').wanted, false);
  assert.equal(webImagePlan('这张图是什么', history, true).wanted, false);
  assert.equal(Array.from(webImagePlan('🧪'.repeat(150)).query).length, 128);
});

test('从网页 Markdown、引用图片及 HTML 提取真实图片，过滤图标、本机和危险协议', () => {
  const content = `![莉莉](../images/lili(1).png "立绘")\n![另一张][art]\n[art]: https://cdn.example.com/art.png\n`
    + '<img src="//cdn.example.com/full.png?a=1&amp;b=2" alt="角色立绘">'
    + '<meta property="og:image" content="/cover.jpg">'
    + `![图标](https://cdn.example.com/logo.png) ![危险](http://127.0.0.1/secret) ![文件](file:///etc/passwd)\n`
    + '```markdown\n![代码示例](https://cdn.example.com/example.png)\n```';
  const result = pageImages(content, page, '角色页');
  assert.deepEqual(result.map(item => item.url), ['https://example.com/images/lili(1).png', 'https://cdn.example.com/art.png',
    'https://cdn.example.com/full.png?a=1&b=2', 'https://example.com/cover.jpg']);
  assert.equal(result.every(item => item.source === page), true);
  assert.equal(markdownImages('![原图](<https://cdn.example.com/a.png>)').length, 1);
  assert.equal(markdownImages('![未闭合链接](' + 'a'.repeat(100000)).length, 0);
});

test('网页读取有数量边界，单页失败仍可使用其他页面，去重且取消授权后不继续', async () => {
  let fetched = 0;
  const results = Array.from({ length: 5 }, (_, i) => ({ url: `https://example.com/${i}`, title: '角色页' }));
  const result = await collectWebImages(results, async url => {
    fetched++;
    if (url.endsWith('/1')) throw Error('上游失败');
    return { content: `![立绘](${imageUrl})` };
  });
  assert.equal(fetched, 5); assert.equal(result.fetched, 4); assert.equal(result.candidates.length, 1);
  let allowed = true;
  await assert.rejects(collectWebImages(results, async () => { allowed = false; return {}; }, () => {
    if (!allowed) throw Object.assign(Error('取消'), { cancelled: true });
  }), /取消/);
});

test('正文懒加载和 srcset 优先于占位图，不提取侧栏、脚本与注释中的无关图片', () => {
  const html = `<img src="https://cdn.example.com/sidebar.png"><article>
    <img src="/loading@2_1.jpg" data-src="${imageUrl}" alt="莉莉立绘">
    <img src=/small.jpg srcset="/medium.jpg 600w, /large.jpg 1800w" alt="壁纸">
    <!-- <img src="/comment.png"> --><script>const example='<img src="/example.png">';</script>
    <img src="/placeholder.jpg"></article><img src="/unrelated.png">`;
  assert.deepEqual(pageImages(html, page).map(image => image.url), [imageUrl, 'https://example.com/large.jpg']);
});

test('取图超过前三条且最多读取八页；Markdown 有小图时仍从原始正文补充立绘', async () => {
  let active = 0, peak = 0, reads = 0;
  const results = Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}`, title: '莉莉立绘' }));
  const found = await collectWebImages(results, async () => ({ content: '![作者](https://cdn.example.com/avatar.jpg)' }), () => {}, async url => {
    reads++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return { url, content: url.endsWith('/7') ? `<article><img data-original="${imageUrl}" src="/loading.gif"></article>` : '' };
  });
  assert.equal(reads, 8); assert.ok(peak <= 2);
  assert.deepEqual(found.candidates.map(image => image.url), [imageUrl]);
  assert.equal(found.candidates[0].alt, '莉莉立绘');
});

test('搜索摘要与 Fetch 移除图片时，从原始 HTML 取图；记录网页最终地址用于相对链接', async () => {
  const results = [{ url: page, title: '莉莉角色介绍' }];
  let direct = 0;
  const result = await collectWebImages(results, async () => ({ content: '角色介绍文字' }), () => {}, async () => {
    direct++;
    return { url: 'https://example.com/redirected/article', content: '<img alt="莉莉立绘" src="../lili.png">' };
  });
  assert.equal(direct, 1); assert.equal(result.candidates[0].url, 'https://example.com/lili.png');
  const html = await downloadWebPage(page, { lookup, request: transport(() => ({
    headers: { 'content-type': 'text/html; charset=utf-8' }, chunks: [Buffer.from('<img src="/lili.png">')]
  })) });
  assert.equal(html.content, '<img src="/lili.png">');
  await assert.rejects(downloadWebPage(page, { lookup, request: transport(() => ({ headers: { 'content-length': 2 * 1024 * 1024 } })) }));
  await assert.rejects(downloadWebPage(page, { lookup, request: transport(() => ({ headers: { 'content-type': 'application/json' } })) }));
});

test('仅将实际候选图转换为发图结果，伪造 URL、本地路径和代码示例不会发送，最多三张', () => {
  const candidates = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, url: `https://cdn.example.com/${i}.png`, alt: '立绘' }));
  const selected = selectReplyImages('正文 [[QQ_IMAGE:1]] [[QQ_IMAGE:2]] [[QQ_IMAGE:3]] [[QQ_IMAGE:4]]'
    + '![重复](https://cdn.example.com/0.png) ![伪造](https://evil.example.com/not-found.png) ![内网](http://127.0.0.1/a)', candidates);
  assert.equal(selected.images.length, 3); assert.equal(selected.text.trim(), '正文');
  const markdown = selectReplyImages('![原图](https://cdn.example.com/4.png)', candidates);
  assert.equal(markdown.images[0].id, 5); assert.equal(markdown.text, '');
  assert.deepEqual(selectReplyImages('[[QQ_IMAGE:1]]', []), { text: '', images: [] });
  assert.equal(selectReplyImages('示例 `[[QQ_IMAGE:1]]`', candidates).images.length, 0);
});

test('下载真实图片，锁定已校验的公网 DNS 地址，不向图片站发送 API 密钥或 Cookie', async () => {
  let requests = 0;
  const image = await downloadWebImage(imageUrl, { lookup, request: transport((url, options) => {
    requests++; assert.equal(url.hostname, 'cdn.example.com'); assert.equal(options.agent, false);
    assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined);
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4);
    });
    return {};
  }) });
  assert.equal(requests, 1); assert.equal(image.file, `base64://${png.toString('base64')}`); assert.equal(image.bytes, png.length);
  assert.deepEqual(rasterDimensions(png), { width: 1, height: 1 });
});

test('图片下载拒绝内网 DNS、重定向到内网、过大文件和伪造图片；支持取消与超时', async () => {
  let requests = 0;
  const request = transport(() => { requests++; return {}; });
  await assert.rejects(downloadWebImage(imageUrl, { lookup: async () => [{ address: '127.0.0.1', family: 4 }], request }));
  await assert.rejects(downloadWebImage('http://169.254.169.254/private', { lookup, request }));
  assert.equal(requests, 0);
  await assert.rejects(downloadWebImage(imageUrl, { lookup, request: transport(() => ({ status: 302, headers: { location: 'http://10.0.0.1/secret' } })) }));
  await assert.rejects(downloadWebImage(imageUrl, { lookup, request: transport(() => ({ headers: { 'content-length': 7 * 1024 * 1024 } })) }));
  await assert.rejects(downloadWebImage(imageUrl, { lookup, request: transport(() => ({ chunks: [Buffer.alloc(6 * 1024 * 1024), png] })) }));
  await assert.rejects(downloadWebImage(imageUrl, { lookup, request: transport(() => ({ chunks: [Buffer.from('<html>login</html>')] })) }));
  await assert.rejects(downloadWebImage(imageUrl, { lookup, request: transport(() => ({ status: 302, headers: { location: imageUrl } })) }));
  await assert.rejects(downloadWebImage(imageUrl, { lookup: () => new Promise(() => {}), timeout: 0.01 }), /超时/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(downloadWebImage(imageUrl, { lookup, signal: controller.signal, request }), /取消/);
});

test('真实群聊流程搜索、读取网页、选择、下载并发送 QQ 图片，记忆和详情不存 URL 或 base64', async t => {
  const { bot, calls, sent } = mockBot(t);
  const prompt = '找一张鸣潮莉莉的立绘发给我';
  await bot.run({ event: event(prompt), prompt, config: bot.store.config });
  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['search', 'fetch', 'completions']);
  assert.equal(calls.every(call => call.auth === 'PRIVATE_API_KEY'), true);
  assert.ok(calls.at(-1).body.messages.some(message => message.content.includes('[[QQ_IMAGE:数字ID]]')));
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].message.map(part => part.type), ['at', 'text', 'image']);
  assert.equal(sent[0].message[2].data.file, `base64://${png.toString('base64')}`);
  assert.equal(sent[0].message[1].data.text.includes('来源'), false);
  assert.equal(sent[0].message[1].data.text.includes('QQ_IMAGE'), false);
  const detail = bot.logDetail(bot.logs[0].id);
  assert.equal(detail.replyImageCount, 1); assert.equal(detail.imageSearchStatus, 'sent'); assert.equal(detail.replyStatus, 'sent');
  assert.match(detail.replyMessage, /\[图片：莉莉立绘\]/); assert.equal(detail.tokens, 30);
  const conversation = bot.conversations.list().items[0];
  const memory = bot.conversations.context(conversation.id);
  assert.match(memory[1].content, /图片：莉莉/);
  assert.equal(JSON.stringify({ detail, memory }).includes('base64://'), false);
  assert.equal(JSON.stringify({ detail, memory }).includes(imageUrl), false);
  assert.equal(JSON.stringify(bot.status()).includes('莉莉立绘'), false);
  await bot.run({ event: event('发出来', 2), prompt: '发出来', config: bot.store.config });
  assert.match(calls.filter(call => call.url.endsWith('/search'))[1].body.query, /鸣潮莉莉/);
  await bot.run({ event: event('发出来', 3, 10004), prompt: '发出来', config: bot.store.config });
  const latest = calls.filter(call => call.url.endsWith('/search')).at(-1);
  assert.equal(latest.body.query, '发出来');
});

test('下载失败回退实际说明；关闭搜索不抓图；群授权撤销后不发任何消息', async t => {
  const { bot, sent, calls, store } = mockBot(t);
  bot.downloadReplyImage = async () => { throw Error('PRIVATE_DOWNLOAD_URL'); };
  const prompt = '找一张莉莉立绘';
  await bot.run({ event: event(prompt), prompt, config: store.config });
  assert.equal(sent[0].message.length, 2); assert.match(sent[0].message[1].data.text, /图片下载失败/);
  assert.equal(bot.logs[0].replyImageCount, 0); assert.equal(bot.logs[0].imageDownloadFailures, 1);
  assert.equal(bot.logs[0].imageSearchStatus, 'download_failed');
  assert.equal(JSON.stringify(bot.logDetail(bot.logs[0].id)).includes('PRIVATE_DOWNLOAD_URL'), false);
  calls.length = 0;
  await bot.run({ event: event(prompt, 2), prompt, config: { ...store.config, webSearchEnabled: false } });
  assert.equal(calls.length, 1); assert.match(JSON.stringify(calls[0].body.messages), /联网搜索开关已关闭/);
  assert.equal(bot.logs[0].imageSearchStatus, 'disabled');
  bot.downloadReplyImage = async () => { store.config.allowedGroups = []; return { file: 'base64://test' }; };
  const count = sent.length;
  await bot.run({ event: event(prompt, 3), prompt, config: store.config });
  assert.equal(sent.length, count); assert.equal(bot.logDetail(bot.logs[0].id).replyStatus, 'cancelled');
  assert.equal(bot.logs[0].imageSearchStatus, 'cancelled');
});

test('选图前验证尺寸，跳过网页小头像；同一原图的 NetEase 缩略版本不重复计入', async t => {
  const { bot, store, sent } = mockBot(t);
  bot.request = async url => url.endsWith('/search') ? { results: [{ url: page, title: '莉莉立绘' }] }
    : url.endsWith('/fetch') ? { content: '![头像](https://cdn.example.com/profile.png) ![莉莉立绘](https://cdn.example.com/full.png)' }
      : { choices: [{ message: { content: '相关立绘 [[QQ_IMAGE:2]]' } }] };
  bot.downloadReplyImage = async url => ({ file: `base64://${png.toString('base64')}`, width: url.includes('profile') ? 50 : 1920, height: url.includes('profile') ? 50 : 1080 });
  const prompt = '找一张莉莉立绘';
  await bot.run({ event: event(prompt), prompt, config: store.config });
  assert.equal(bot.logs[0].imageCandidates, 1); assert.equal(sent[0].message.length, 3);
  const result = await collectWebImages([{ url: page }], async () => ({ content:
    '![立绘](https://seogc.fp.ps.netease.com/file/123) ![缩略](https://seogc.fp.ps.netease.com/file/123?fop=imageView%2F2%2Fw%2F600)' }));
  assert.equal(result.candidates.length, 1);
});

test('模型只返回图片标记仍能发图；网页无图时不捏造图片或误报已发送', async t => {
  const { bot, sent, store } = mockBot(t);
  const request = bot.request;
  bot.request = async (...args) => args[0].endsWith('/completions')
    ? { choices: [{ message: { content: '[[QQ_IMAGE:1]]' } }], usage: { total_tokens: 1 } } : request(...args);
  const prompt = '找一张莉莉立绘';
  await bot.run({ event: event(prompt), prompt, config: store.config });
  assert.equal(sent[0].message[1].data.text, ' 找到这些图片：'); assert.equal(sent[0].message.length, 3);
  bot.request = async (...args) => args[0].endsWith('/fetch') ? { title: '网页', content: '没有图片的文字页' } : request(...args);
  await bot.run({ event: event(prompt, 2), prompt, config: store.config });
  assert.equal(sent[1].message.length, 2); assert.match(sent[1].message[1].data.text, /未找到可确认相关并发送/);
  assert.equal(bot.logs[0].imageSearchStatus, 'not_found'); assert.equal(bot.logs[0].replyImageCount, 0);
});

test('首轮只有无图帖子时换站补搜，提取原始 HTML 的图片并发送真实 QQ 图片段', async t => {
  const { bot, sent, store, calls } = mockBot(t);
  let searches = 0;
  const extraPage = 'https://art.example.org/lili';
  bot.request = async (url, body) => {
    calls.push({ url, body });
    if (url.endsWith('/search')) {
      searches++;
      assert.equal(body.need_content, true); assert.equal(body.count, 8);
      if (searches === 2) { assert.match(body.query, /-site:example.com/); assert.ok(Array.from(body.query).length <= 128); }
      return { results: [{ url: searches === 1 ? page : extraPage, title: '鸣潮莉莉立绘' }] };
    }
    if (url.endsWith('/fetch')) return { content: '只有正文，没有 Markdown 图片。' };
    assert.match(JSON.stringify(body.messages), /已实际下载并验证尺寸/);
    return { choices: [{ message: { content: '这张是相关立绘，未确认官方来源。[[QQ_IMAGE:1]]' } }] };
  };
  bot.readImagePage = async url => ({ url, content: url === extraPage ? `<article><img data-src="${imageUrl}" src="/loading.jpg"></article>` : '' });
  const prompt = '收集鸣潮中的莉莉立绘';
  await bot.run({ event: event(prompt), prompt, config: store.config });
  assert.equal(searches, 2); assert.equal(sent[0].message[2].type, 'image');
  assert.equal(bot.logs[0].imageSearchAttempts, 2); assert.equal(bot.logs[0].imageSearchStatus, 'sent');
  assert.equal(sent[0].message[1].data.text.includes('未找到'), false);
});

test('补搜接口故障仍给出首轮文字回答，无图片证据时不会自动发图', async t => {
  const { bot, sent, store } = mockBot(t);
  let searches = 0;
  bot.request = async url => {
    if (url.endsWith('/search')) { if (++searches === 2) throw Error('上游 HTTP 429'); return { results: [{ url: page, title: '莉莉立绘' }] }; }
    if (url.endsWith('/fetch')) return { content: '仅有文字' };
    return { choices: [{ message: { content: '暂未找到相关图片。' } }] };
  };
  const prompt = '找一张莉莉立绘';
  await bot.run({ event: event(prompt), prompt, config: store.config });
  assert.equal(bot.logs[0].imageRetryFailed, true); assert.equal(bot.logs[0].replyStatus, undefined);
  assert.equal(bot.logDetail(bot.logs[0].id).replyStatus, 'sent');
  assert.equal(sent[0].message.length, 2); assert.equal(bot.logs[0].replyImageCount, 0);
});

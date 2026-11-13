import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { defaultConfig } from '../src/config.mjs';
import { parseFeed, readFeed } from '../src/subscriptions/feeds.mjs';
import { parseDouyinPosts, readDouyinFeed } from '../src/subscriptions/douyin-feed.mjs';
import { parseBilibiliDynamics } from '../src/subscriptions/bilibili-feed.mjs';
import { renderLinkStyleCard, subscriptionContent, subscriptionMessage } from '../src/subscriptions/message.mjs';
import { SubscriptionService } from '../src/subscriptions/service.mjs';
import { DouyinBrowser } from '../src/douyin-browser.mjs';
import { prepareMessage } from './helpers/subscription-message.mjs';

const source = 'MS4wLjABAAAAabcdefghijk', settings = { rsshubUrl: 'https://feeds.example.com' };
const post = (id, channel = 'dynamic') => ({ id, channel, title: '更新 ' + id, summary: '动态摘要', publishedAt: '2026-10-27T04:00:00Z', link: 'https://t.bilibili.com/' + id });
const xml = (title, items) => `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>${title}</title>${items.map(i => `<item><guid>${i.id || i.link}</guid><title>${i.title}</title><link>${i.link}</link><description><![CDATA[${i.html || ''}]]></description>${i.extra || ''}<pubDate>Tue, 27 Oct 2026 04:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-subscription-media-')), sent = [];
  const store = { config: { ...defaultConfig(), enabled: true, allowedGroups: ['10003', '10005'] } };
  let feed = { title: '作者 的 bilibili 空间', items: [post('old-video', 'video')], successfulSources: ['video'] };
  const options = { now: () => Date.parse('2026-10-27T04:00:00Z'), prepareMessage, onebot: async (_a, p) => sent.push(p), fetchFeed: async entry => entry.type === 'douyin' ? { title: '作者', items: [] } : feed };
  const service = new SubscriptionService(dir, store, options); service.configure({ enabled: true });
  service.upsert({ name: '作者', type: 'bilibili', source: '123', groups: ['10003', '10005'] });
  t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, sent, store, service, options, entry: service.state.entries[0], setFeed: value => { feed = value; } };
}

test('RSS 与 Atom 保留图片、poster 和媒体缩略图，丢弃视频源、脚本及私网图片', async () => {
  const parsed = await parseFeed(xml('图文源', [{ title: '图文', link: 'https://example.com/post', html: '<img src="/cover.jpg?a=1&amp;b=2"><img src="http://127.0.0.1/private"><video src="https://example.com/movie.mp4" poster="https://example.com/poster.png"></video><img src="javascript:alert(1)"><img src="https://example.com/movie.mp4">',
    extra: '<media:thumbnail url="https://example.com/thumb.webp"/><media:content url="https://example.com/clip.mp4" type="video/mp4"/><media:group><media:content url="https://example.com/photo.jpg" medium="image"/></media:group><enclosure url="https://example.com/other.jpg" type="image/jpeg"/>' }]), 'https://example.com/rss');
  assert.deepEqual(parsed.items[0].images, ['https://example.com/cover.jpg?a=1&b=2', 'https://example.com/poster.png', 'https://example.com/thumb.webp', 'https://example.com/photo.jpg', 'https://example.com/other.jpg']);
  const atom = await parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>图片</title><entry><id>1</id><title>更新</title><link href="https://example.com/1"/><content type="html">&lt;img src="https://example.com/atom.jpg"&gt;</content></entry></feed>', 'https://example.com/atom');
  assert.deepEqual(atom.items[0].images, ['https://example.com/atom.jpg']);
});

test('B 站合并投稿和所有动态，自动视频动态沿用旧投稿身份，转发保留独立身份', async () => {
  const video = 'https://www.bilibili.com/video/BV1abcdefghj', dynamic = 'https://t.bilibili.com/1234567890';
  const download = async url => ({ url, xml: url.includes('/video/') ? xml('作者 的 bilibili 空间', [{ title: '视频', link: video }]) : xml('作者 的 bilibili 动态', [
    { title: '视频', link: dynamic, html: `视频地址：<a href="${video}">${video}</a>` },
    { title: '文字动态', link: dynamic + '1', html: '<p>今天的公告</p><img src="https://example.com/1.jpg">' },
    { title: '转发视频', link: dynamic + '2', html: `//转发自: @其他人: 视频地址：<a href="${video}">${video}</a>` },
  ]) });
  const feed = await readFeed({ type: 'bilibili', source: '123' }, settings, { download });
  assert.equal(feed.items.length, 3); assert.deepEqual(feed.successfulSources, ['video', 'dynamic']);
  assert.equal(feed.items[0].id, createHash('sha256').update(video).digest('hex'));
  assert.equal(feed.items[0].channel, 'video'); assert.equal(feed.items[2].channel, 'dynamic');
  assert.equal(feed.items[2].ownVideo, undefined); assert.equal(feed.warnings.length, 0);
  const fallback = await readFeed({ type: 'bilibili', source: '123' }, settings, { download: async url => {
    if (url.includes('/video/')) throw Error('SECRET'); return download(url);
  } });
  assert.equal(fallback.items[0].id, feed.items[0].id); assert.equal(fallback.items[0].contentKind, 'video');
  assert.equal(fallback.title, '作者 的 bilibili 空间'); assert.deepEqual(fallback.successfulSources, ['dynamic']);
  assert.doesNotMatch(fallback.warnings.join(''), /SECRET/);
});

test('B 站直播条目按直播间链接识别，卡片与原文入口显示直播而非动态', async () => {
  for (const row of [
    { title: '正在直播', link: 'https://live.bilibili.com/12345', html: '快来围观' },
    { title: '开播了', link: 'https://t.bilibili.com/1234567890', html: '<a href="https://live.bilibili.com/12345">直播地址</a>' },
  ]) {
    const feed = await parseFeed(xml('作者 的 bilibili 动态', [row]), 'https://feeds.example.com/dynamic');
    const item = { ...feed.items[0], channel: 'dynamic' };
    assert.equal(item.contentKind, 'live');
    const data = subscriptionContent({ type: 'bilibili', name: '作者' }, item);
    assert.equal(data.type, '直播'); assert.doesNotMatch(data.content, /B 站动态/);
    const rendered = await subscriptionMessage({ type: 'bilibili', name: '作者' }, item, { renderCard: async () => 'base64://UE5H' });
    assert.match(rendered.message[1].data.text, /^\n直播 · 查看原文/); assert.doesNotMatch(rendered.message[1].data.text, /动态/);
  }
});

test('升级已有 B 站订阅只给新增动态建立基线，新投稿照发；重启不重推动态', async t => {
  const f = fixture(t); await f.service.check(f.entry.id); delete f.entry.bilibiliBaselines;
  f.setFeed({ title: '作者 的 bilibili 空间', successfulSources: ['video', 'dynamic'], items: [post('new-video', 'video'), post('old-dynamic'), post('old-video', 'video')] });
  await f.service.check(f.entry.id); assert.equal(f.sent.length, 2); assert.ok(f.sent.every(p => p.message.find(segment => segment.type === 'text').data.text.includes('new-video')));
  f.setFeed({ title: '作者 的 bilibili 空间', successfulSources: ['video', 'dynamic'], items: [post('new-dynamic'), post('old-dynamic'), post('new-video', 'video')] });
  await f.service.check(f.entry.id); assert.equal(f.sent.length, 4); assert.match(f.sent.at(-1).message.find(segment => segment.type === 'text').data.text, /B 站动态/);
  assert.deepEqual(f.sent.at(-1).message.map(s => s.type), ['image', 'text']);
  f.service.close(); const restored = new SubscriptionService(f.dir, f.store, f.options); t.after(() => restored.close());
  await restored.check(f.entry.id); assert.equal(f.sent.length, 4);
});

test('首次升级立即重试旧抖音失败路线与动态，保留已读和目标；后续重启保留正常间隔', t => {
  const f = fixture(t);
  f.service.upsert({ name: '抖音', type: 'douyin', source, groups: ['10003'] });
  f.service.state.deliveryVersion = 1;
  for (const entry of f.service.state.entries) { entry.seen = ['seen']; entry.nextCheckAt = Date.now() + 360 * 60000; }
  f.service.save(); f.service.close();
  const upgraded = new SubscriptionService(f.dir, f.store, f.options); t.after(() => upgraded.close());
  assert.ok(upgraded.state.entries.every(entry => entry.nextCheckAt === 0 && entry.seen[0] === 'seen'));
  assert.deepEqual(upgraded.state.entries[0].groups, ['10003','10005']);
  upgraded.state.entries[0].nextCheckAt = 123456; upgraded.save(); upgraded.close();
  const restarted = new SubscriptionService(f.dir, f.store, f.options); t.after(() => restarted.close()); assert.equal(restarted.state.entries[0].nextCheckAt, 123456);
});

test('动态恢复与队列满时不补发历史，动态不会被同名抖音优先规则删除', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  f.service.upsert({ name: '作者', type: 'douyin', source, groups: ['10003'] }); await f.service.check();
  f.entry.pending = Array.from({ length: 100 }, (_, i) => ({ ...post('queued-' + i), groups: ['10003'], delivered: [] }));
  f.setFeed({ title: '作者 的 bilibili 空间', successfulSources: ['video', 'dynamic'], items: [post('history'), post('old-video', 'video')] });
  await f.service.check(f.entry.id); assert.ok(f.entry.seen.includes('history')); assert.equal(f.entry.pending.length, 97);
  assert.deepEqual(f.sent.map(p => p.group_id), ['10003', '10003', '10003']);
  f.entry.pending = []; f.setFeed({ title: '作者 的 bilibili 空间', successfulSources: ['video', 'dynamic'], items: [post('new-dynamic'), post('new-video', 'video'), post('history')] });
  await f.service.check(f.entry.id);
  assert.equal(f.sent.filter(p => p.message.find(segment => segment.type === 'text').data.text.includes('new-dynamic')).length, 2);
  assert.deepEqual(f.sent.filter(p => p.message.find(segment => segment.type === 'text').data.text.includes('new-video')).map(p => p.group_id), ['10005']);
});

test('图文消息只下载原图，卡片与单独原图分开发送；渲染故障仍保留原文链接', async () => {
  const requests = [], renders = [], item = { ...post('one'), images: ['https://example.com/movie.mp4', 'http://127.0.0.1/private', 'https://example.com/cover.jpg'], video: 'https://example.com/clip.mp4' };
  const rendered = await subscriptionMessage({ type: 'bilibili', name: '作者' }, item, {
    downloadImage: async (url, options) => { requests.push(url); assert.equal(options.timeout, 8); return { file: 'base64:///9j/2Q==' }; },
    renderCard: async (_entry, _item, pictures) => { renders.push(pictures); return 'base64://UE5H'; },
  });
  assert.deepEqual(requests, ['https://example.com/cover.jpg']); assert.deepEqual(renders[0], [{ file: 'base64:///9j/2Q==' }]);
  assert.deepEqual(rendered.message.map(s => s.type), ['image', 'text']); assert.match(rendered.message.find(segment => segment.type === 'text').data.text, /https:\/\/t.bilibili.com\/one/);
  assert.equal(rendered.parts.length, 2); assert.deepEqual(rendered.parts[1].message, [{ type: 'image', data: { file: 'base64:///9j/2Q==' } }]);
  const fallback = await subscriptionMessage({ type: 'bilibili', name: '作者' }, item, { downloadImage: async () => { throw Error('SECRET_COOKIE'); }, renderCard: async () => { throw Error('PRIVATE'); } });
  assert.deepEqual(fallback.message.map(s => s.type), ['text']); assert.match(fallback.warning, /卡片生成失败/); assert.doesNotMatch(JSON.stringify(fallback), /SECRET_COOKIE|PRIVATE/);
});

test('多张原图保持顺序合并为一条聊天记录，不压缩且并发最多两张', async () => {
  const renders = []; let active = 0, peak = 0;
  const options = {
    downloadImage: async url => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return { file: 'base64://' + Buffer.from(url).toString('base64') }; },
    renderCard: async (_entry, item, pictures) => { renders.push(item); assert.equal(pictures.length, 1); return 'base64://UE5H'; },
    selfId: async () => '10001',
  };
  const item = { ...post('album'), images: [1,2,3].map(i => 'https://example.com/'+i+'.jpg') };
  const album = await subscriptionMessage({ type: 'bilibili', name: '作者' }, item, options);
  assert.equal(renders.length, 1); assert.equal(peak, 2); assert.equal(album.parts.length, 2);
  assert.equal(album.parts[1].key, 'images'); assert.equal(album.parts[1].action, 'send_group_forward_msg');
  assert.equal(album.parts[1].messages.length, 3);
  assert.deepEqual(album.parts[1].messages.map(node => Buffer.from(node.data.content[0].data.file.slice(9), 'base64').toString()), item.images);
  assert.ok(album.parts[1].messages.every(node => node.type === 'node' && node.data.user_id === '10001'));
});

test('视频更新优先作品地址下载并直接发送，封面不单独散发，失败保留可重试分片', async () => {
  let downloaded = '', cleaned = 0;
  const item = { ...post('dynamic'), ownVideo: 'https://www.bilibili.com/video/BV1HAxL62Esi/', contentKind: 'video', images: ['https://example.com/cover.jpg'] };
  const options = {
    downloadImage: async () => ({ file: 'base64://UE5H' }), renderCard: async () => 'base64://UE5H',
    downloadVideo: async url => { downloaded = url; return { media: [{ type: 'image', file: 'file:///test/cover.jpg' }, { type: 'video', file: 'file:///test/video.mp4' }], cleanup() { cleaned++; } }; },
  };
  const result = await subscriptionMessage({ type: 'bilibili', name: '作者' }, item, options);
  assert.equal(downloaded, item.ownVideo); assert.equal(result.parts.length, 2);
  assert.deepEqual(result.parts[1], { key: 'video', message: [{ type: 'video', data: { file: 'file:///test/video.mp4' } }] });
  assert.equal(cleaned, 0); result.cleanup(); assert.equal(cleaned, 1);
  const failed = await subscriptionMessage({ type: 'bilibili', name: '作者' }, item, { ...options, downloadVideo: async () => { throw Error('PRIVATE_VIDEO_ERROR'); } });
  assert.deepEqual(failed.parts[1], { key: 'video', unavailable: true }); assert.match(failed.warning, /视频暂时无法下载/);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_VIDEO_ERROR/);
  const invalid = await subscriptionMessage({ type: 'bilibili', name: '作者' }, item, { ...options, downloadVideo: async () => ({ media: [], cleanup() { cleaned++; } }) });
  assert.deepEqual(invalid.parts[1], { key: 'video', unavailable: true }); assert.equal(cleaned, 2);
});

test('并行视频、封面和卡片失败按固定顺序保留全部提示，不泄漏上游错误', async () => {
  for (const order of ['video-first', 'video-last']) {
    let releaseVideo;
    const videoWaiter = new Promise(resolve => { releaseVideo = resolve; });
    const pending = subscriptionMessage({ type: 'bilibili', name: '作者' }, {
      ...post('warnings'), contentKind: 'video', images: ['https://example.com/cover.jpg'],
    }, {
      downloadImage: async () => { throw Error('PRIVATE_IMAGE_ERROR'); },
      downloadVideo: async () => { if (order === 'video-last') await videoWaiter; throw Error('PRIVATE_VIDEO_ERROR'); },
      renderCard: async () => { throw Error('PRIVATE_RENDER_ERROR'); },
    });
    await new Promise(resolve => setImmediate(resolve)); releaseVideo();
    const result = await pending;
    const warnings = result.warning.split('\n');
    assert.equal(warnings.length, 3, order);
    assert.match(warnings[0], /卡片配图暂时无法读取/);
    assert.match(warnings[1], /卡片生成失败/);
    assert.match(warnings[2], /视频暂时无法下载/);
    assert.equal(result.cardFallback, true);
    assert.equal(result.message[0].type, 'text'); assert.ok(result.message[0].data.text.endsWith(post('warnings').link));
    assert.deepEqual(result.parts[1], { key: 'video', unavailable: true });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  }
});

test('按待发群组跳过已确认媒体，保留分片顺序且视频封面不作为原图', async () => {
  const entry = { type: 'bilibili', name: '作者' };
  const item = { ...post('progress'), contentKind: 'video', images: ['https://example.com/cover.jpg'], avatar: 'https://example.com/avatar.jpg' };
  let images = 0, renders = 0, videos = 0, cleaned = 0;
  const options = {
    downloadImage: async () => { images++; return { file: 'base64://UE5H' }; },
    renderCard: async () => { renders++; return 'base64://UE5H'; },
    downloadVideo: async () => { videos++; return { media: [{ type: 'video', file: 'file:///test/video.mp4' }], cleanup() { cleaned++; } }; },
  };
  const confirmed = await subscriptionMessage(entry, { ...item, sentParts: { '10003': ['main', 'video'] } }, { ...options, pendingGroups: ['10003'] });
  assert.deepEqual([images, renders, videos], [0, 0, 0]); assert.deepEqual(confirmed.parts, [{ key: 'main' }, { key: 'video' }]);
  const mainOnly = await subscriptionMessage(entry, { ...item, sentParts: { '10003': ['video'] } }, { ...options, pendingGroups: ['10003'] });
  assert.deepEqual([images, renders, videos], [2, 1, 0]); assert.equal(mainOnly.parts[0].message.length, 2);
  assert.deepEqual(mainOnly.parts[1], { key: 'video' }); assert.equal(mainOnly.parts.some(part => part.key.startsWith('image:')), false);
  const videoOnly = await subscriptionMessage(entry, { ...item, sentParts: { '10003': ['main'] } }, { ...options, pendingGroups: ['10003'] });
  assert.deepEqual([images, renders, videos], [2, 1, 1]); assert.deepEqual(videoOnly.parts[0], { key: 'main' });
  assert.equal(videoOnly.parts[1].message[0].type, 'video'); videoOnly.cleanup(); assert.equal(cleaned, 1);
});

test('原图、头像和视频并行准备，卡片不等待视频完成', async () => {
  const imageWaiters = []; let videoStarted = false, cardStarted = false, resolveVideo;
  const item = { ...post('parallel'), contentKind: 'video', images: ['https://example.com/cover.jpg'], avatar: 'https://example.com/avatar.jpg' };
  const pending = subscriptionMessage({ type: 'bilibili', name: '作者' }, item, {
    downloadImage: () => new Promise(resolve => imageWaiters.push(() => resolve({ file: 'base64://UE5H' }))),
    downloadVideo: () => { videoStarted = true; return new Promise(resolve => { resolveVideo = resolve; }); },
    renderCard: async () => { cardStarted = true; return 'base64://UE5H'; },
  });
  while (imageWaiters.length < 2 || !videoStarted) await new Promise(resolve => setImmediate(resolve));
  assert.equal(cardStarted, false); imageWaiters.splice(0).forEach(resolve => resolve());
  while (!cardStarted) await new Promise(resolve => setImmediate(resolve));
  assert.equal(videoStarted, true);
  resolveVideo({ media: [{ type: 'video', file: 'file:///test/video.mp4' }], cleanup() {} });
  const result = await pending; assert.equal(result.parts[1].message[0].type, 'video'); result.cleanup();
});

test('并行准备取消时等待任务收敛并只清理视频一次', async () => {
  const controller = new AbortController(); let videoStarted = false, cardStarted = false, resolveVideo, cleaned = 0;
  const item = { ...post('cancel-parallel'), contentKind: 'video', images: ['https://example.com/cover.jpg'] };
  const pending = subscriptionMessage({ type: 'bilibili', name: '作者' }, item, {
    signal: controller.signal, downloadImage: async () => ({ file: 'base64://UE5H' }),
    downloadVideo: () => { videoStarted = true; return new Promise(resolve => { resolveVideo = resolve; }); },
    renderCard: async (_entry, _item, _pictures, _avatar, { signal }) => {
      cardStarted = true; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return 'base64://UE5H';
    },
  });
  while (!videoStarted || !cardStarted) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); resolveVideo({ media: [{ type: 'video', file: 'file:///test/video.mp4' }], cleanup() { cleaned++; } });
  await assert.rejects(pending); assert.equal(cleaned, 1);
});

test('合并图集等待机器人 ID 时可立即取消，不继续完成消息准备', async () => {
  const controller = new AbortController(); let release;
  const pending = subscriptionMessage({ type: 'bilibili', name: '作者' }, {
    ...post('abort-id'), images: ['https://example.com/1.jpg', 'https://example.com/2.jpg'],
  }, {
    signal: controller.signal, downloadImage: async () => ({ file: 'base64://UE5H' }), renderCard: async () => 'base64://UE5H',
    selfId: () => new Promise(resolve => { release = resolve; }),
  });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await assert.rejects(pending); release('10001');
});

test('动态截断标题与正文只展示一次，成功推送仅附简短原文入口，失败保留有界摘要', async () => {
  const opening = '互动抽奖 #星穹铁道耀嘉音# https://www.bilibili.com/video/BV1HAxL62Esi/ 「我是耀嘉音，一名来自新艾利都的歌手。如果';
  const summary = opening + '你喜欢我的音乐，那我们之间一定很合拍；如果你还不是我的歌迷，那就来听听吧。」';
  const entry = { type: 'bilibili', lastTitle: '崩坏星穹铁道 的 bilibili 空间' };
  const item = { ...post('screenshot'), title: opening + '…', summary, publishedAt: '2026-10-28T04:00:24Z' };
  const data = subscriptionContent(entry, item);
  assert.equal(data.body, summary);
  for (const ellipsis of ['...', '……']) assert.equal(subscriptionContent(entry, { ...item, title: opening + ellipsis }).body, summary);
  const rendered = await subscriptionMessage(entry, item, { renderCard: async (_entry, cardItem) => {
    assert.equal(subscriptionContent(entry, cardItem).body, summary); return 'base64://UE5H';
  } });
  assert.deepEqual(rendered.message, [{ type: 'image', data: { file: 'base64://UE5H' } },
    { type: 'text', data: { text: '\nB 站动态 · 查看原文\nhttps://t.bilibili.com/screenshot' } }]);
  const fallback = await subscriptionMessage(entry, { ...item, summary: summary + '完整正文。'.repeat(500) }, { renderCard: async () => { throw Error('PRIVATE_RENDER_ERROR'); } });
  const text = fallback.message[0].data.text;
  assert.equal(text.split('互动抽奖').length - 1, 1);
  assert.match(text, /崩坏星穹铁道/); assert.match(text, /B 站动态/); assert.match(text, /2026/);
  assert.ok(text.endsWith(item.link)); assert.ok(text.length < 1200); assert.doesNotMatch(text, /PRIVATE_RENDER_ERROR/);
  const separate = subscriptionContent(entry, { ...item, title: '维护公告', summary: '服务将在今晚暂停十分钟。' }).body;
  assert.match(separate, /维护公告/); assert.match(separate, /服务将在今晚暂停十分钟/);
});

test('动态获取作者头像且不作为原图发送；所有订阅类型均发送卡片和链接', async () => {
  const requests = [], avatar = 'https://example.com/avatar.jpg', image = 'https://example.com/post.jpg';
  const item = { ...post('avatar'), avatar, images: [image] };
  const rendered = await subscriptionMessage({ type: 'bilibili', name: '作者' }, item, {
    downloadImage: async (url, options) => { requests.push(url); assert.equal(options.referer, item.link); return { file: 'base64://' + Buffer.from(url).toString('base64') }; },
    renderCard: async (_entry, _item, pictures, authorAvatar) => {
      assert.equal(pictures.length, 1); assert.equal(Buffer.from(pictures[0].file.slice(9), 'base64').toString(), image);
      assert.equal(Buffer.from(authorAvatar.file.slice(9), 'base64').toString(), avatar); return 'base64://UE5H';
    },
  });
  assert.deepEqual(requests.sort(), [image, avatar].sort()); assert.equal(rendered.parts.length, 2);
  assert.equal(rendered.parts[0].key, 'main');
  assert.equal(rendered.parts[1].key, 'image:' + createHash('sha256').update(image).digest('hex'));
  for (const type of ['bilibili', 'douyin', 'github', 'game', 'rss']) {
    let calls = 0;
    const result = await subscriptionMessage({ type, name: '订阅源' }, post(type), { renderCard: async () => { calls++; return 'base64://UE5H'; } });
    assert.equal(calls, 1); assert.deepEqual(result.message.map(segment => segment.type), ['image', 'text']);
    assert.ok(result.message[1].data.text.endsWith(post(type).link));
  }
});

test('渲染边界传递动态原图与去重摘要，视频只取封面，工作目录使用后清理', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4xQAAAAASUVORK5CYII=', 'base64');
  const picture = { file: 'base64://' + png.toString('base64') }, calls = [];
  const worker = async (input, options) => {
    calls.push(input); assert.equal(options.timeout, 20);
    for (const name of [...input.images, input.avatar].filter(Boolean)) assert.deepEqual(readFileSync(join(input.directory, name)), png);
    writeFileSync(join(input.directory, 'card.png'), png); return { card: 'card.png' };
  };
  const entry = { type: 'bilibili', name: '作者 的 bilibili 空间' }, item = { ...post('render'), title: '公告…', summary: '公告的完整内容 https://example.com/detail' };
  await renderLinkStyleCard(entry, item, Array(4).fill(picture), picture, { worker });
  assert.equal(calls[0].kind, 'photo'); assert.equal(calls[0].images.length, 1); assert.equal(calls[0].author, '作者');
  assert.equal(calls[0].description, '公告的完整内容 （链接见原文）'); assert.match(calls[0].published, /B 站动态/);
  await renderLinkStyleCard(entry, { ...item, contentKind: 'video' }, Array(4).fill(picture), undefined, { worker });
  assert.equal(calls[1].kind, 'video'); assert.equal(calls[1].images.length, 1);
  await renderLinkStyleCard(entry, item, [], undefined, { worker }); assert.equal(calls[2].kind, 'text');
  assert.ok(calls.every(call => !existsSync(call.directory)));
});

test('分段发送跨重启只重试失败的原图，已确认卡片和其他群不重复', async t => {
  const f = fixture(t); await f.service.check(f.entry.id); let failure = true;
  const assemble = async () => ({ message: [{ type: 'text', data: { text: 'card' } }], parts: ['card','original-1','original-2'].map(key => ({ key, message: [{ type: 'text', data: { text: key } }] })) });
  f.options.prepareMessage = assemble; f.service.prepareMessage = assemble;
  f.options.onebot = async (_a, params) => { if (failure && params.group_id === '10005' && params.message.find(segment => segment.type === 'text').data.text === 'original-2') throw Error('QQ upload'); f.sent.push(params); };
  f.service.onebot = f.options.onebot;
  f.setFeed({ title: '作者', items: [post('new', 'video')], successfulSources: ['video'] }); await f.service.check(f.entry.id);
  assert.equal(f.sent.length, 5); assert.equal(f.entry.pending.length, 1); assert.equal(f.entry.sent, 1);
  f.service.close(); failure = false; const reopened = new SubscriptionService(f.dir, f.store, f.options); t.after(() => reopened.close());
  await reopened.check(f.entry.id); assert.equal(f.sent.length, 6); assert.equal(f.sent.at(-1).message.find(segment => segment.type === 'text').data.text, 'original-2');
  assert.equal(reopened.get(f.entry.id).pending.length, 0); assert.equal(reopened.get(f.entry.id).sent, 2);
});

test('失效原图每轮只计一次失败，三轮后跳过并提示，卡片不重复发送', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  f.service.prepareMessage = async () => ({ message: [{ type: 'text', data: { text: 'card' } }], parts: [
    { key: 'main', message: [{ type: 'text', data: { text: 'card' } }] }, { key: 'image:expired', unavailable: true },
  ] });
  f.setFeed({ title: '作者', items: [post('new', 'video')], successfulSources: ['video'] });
  await f.service.check(f.entry.id); assert.equal(f.entry.pending[0].imageFailures['image:expired'], 1); assert.equal(f.sent.length, 2);
  await f.service.check(f.entry.id); assert.equal(f.entry.pending[0].imageFailures['image:expired'], 2); assert.equal(f.sent.length, 2);
  await f.service.check(f.entry.id); assert.equal(f.entry.pending.length, 0); assert.equal(f.sent.length, 2); assert.match(f.entry.lastWarning, /连续读取失败/);
});

test('旧逐图分片升级后不重复发图，部分确认只普通补发缺失图片', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  const images = ['https://example.com/1.jpg', 'https://example.com/2.jpg'];
  const keys = images.map(url => 'image:' + createHash('sha256').update(url).digest('hex'));
  const calls = [];
  f.service.prepareMessage = (entry, item, options) => subscriptionMessage(entry, item, { ...options,
    downloadImage: async url => ({ file: 'base64://' + Buffer.from(url).toString('base64') }),
    renderCard: async () => 'base64://UE5H', selfId: async () => '10001' });
  f.service.onebot = async (action, params) => calls.push({ action, params });
  f.setFeed({ title: '作者', items: [], successfulSources: ['dynamic'] });
  const pending = (id, sentParts) => ({ id, publishedAt: '2026-10-27T04:00:00Z', channel: 'dynamic', title: id, summary: '', link: 'https://t.bilibili.com/1234567890', images,
    groups: ['10003'], delivered: [], sentParts: { '10003': sentParts } });
  f.entry.pending = [pending('legacy-complete', ['main', ...keys])]; await f.service.check(f.entry.id);
  assert.equal(calls.length, 0); assert.equal(f.entry.pending.length, 0);
  f.entry.pending = [pending('legacy-partial', ['main', keys[0]])]; await f.service.check(f.entry.id);
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'send_group_msg');
  assert.equal(calls[0].params.message.length, 1);
  assert.equal(Buffer.from(calls[0].params.message[0].data.file.slice(9), 'base64').toString(), images[1]);
  assert.equal(f.entry.pending.length, 0);
});

test('多图合并分片跨重启只重试未确认记录，卡片和成功群不重复', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  const calls = [], nodes = [1, 2].map(index => ({ type: 'node', data: { user_id: '10001', nickname: 'bot', content: [{ type: 'image', data: { file: `file:///test/${index}.jpg` } }] } }));
  let failure = true;
  const assemble = async () => ({ parts: [
    { key: 'main', message: [{ type: 'text', data: { text: 'card' } }] },
    { key: 'images', action: 'send_group_forward_msg', messages: nodes },
  ] });
  f.options.prepareMessage = assemble; f.service.prepareMessage = assemble;
  f.options.onebot = async (action, params) => {
    calls.push({ action, params });
    if (failure && action === 'send_group_forward_msg' && params.group_id === '10005') throw Error('QQ upload');
  };
  f.service.onebot = f.options.onebot;
  f.setFeed({ title: '作者', items: [post('album', 'video')], successfulSources: ['video'] }); await f.service.check(f.entry.id);
  assert.equal(calls.length, 4); assert.deepEqual(f.entry.pending[0].sentParts['10003'], ['main', 'images']);
  assert.deepEqual(f.entry.pending[0].sentParts['10005'], ['main']);
  f.service.close(); failure = false; calls.length = 0;
  const reopened = new SubscriptionService(f.dir, f.store, f.options); t.after(() => reopened.close());
  await reopened.check(f.entry.id);
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'send_group_forward_msg'); assert.equal(calls[0].params.group_id, '10005');
  assert.deepEqual(calls[0].params.messages, nodes); assert.equal(reopened.get(f.entry.id).pending.length, 0);
});

test('媒体成功准备后重置连续失败计数，不因历史失败提前跳过', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  let preparation = 0;
  f.service.prepareMessage = async () => {
    preparation++;
    return { parts: [{ key: 'main', message: [{ type: 'text', data: { text: 'card' } }] },
      preparation === 2 || preparation === 5 ? { key: 'video', message: [{ type: 'video', data: { file: 'file:///test/video.mp4' } }] } : { key: 'video', unavailable: true }] };
  };
  f.service.onebot = async (_action, params) => {
    if (params.message?.[0]?.type === 'video' && preparation === 2) throw Error('QQ upload failed');
  };
  f.setFeed({ title: '作者', items: [post('streak', 'video')], successfulSources: ['video'] });
  await f.service.check(f.entry.id); assert.equal(f.entry.pending[0].imageFailures.video, 1);
  await f.service.check(f.entry.id); assert.equal(f.entry.pending[0].imageFailures.video, undefined);
  await f.service.check(f.entry.id); assert.equal(f.entry.pending[0].imageFailures.video, 1);
  await f.service.check(f.entry.id); assert.equal(f.entry.pending[0].imageFailures.video, 2); assert.equal(f.entry.pending.length, 1);
  await f.service.check(f.entry.id); assert.equal(f.entry.pending.length, 0);
});

test('多图部分失效三轮后合并发送可用图片，卡片不重复且每轮清理媒体', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  const calls = []; let cleaned = 0;
  f.service.prepareMessage = async () => ({ parts: [
    { key: 'main', message: [{ type: 'text', data: { text: 'card' } }] },
    { key: 'images', action: 'send_group_forward_msg', unavailable: true,
      messages: [{ type: 'node', data: { user_id: '10001', nickname: 'bot', content: [{ type: 'image', data: { file: 'file:///test/available.jpg' } }] } }] },
  ], cleanup() { cleaned++; } });
  f.service.onebot = async (action, params) => calls.push({ action, params });
  f.setFeed({ title: '作者', items: [post('partial', 'video')], successfulSources: ['video'] });
  await f.service.check(f.entry.id); await f.service.check(f.entry.id);
  assert.equal(calls.filter(call => call.action === 'send_group_forward_msg').length, 0); assert.equal(cleaned, 2);
  await f.service.check(f.entry.id);
  assert.equal(calls.filter(call => call.action === 'send_group_msg').length, 2);
  assert.equal(calls.filter(call => call.action === 'send_group_forward_msg').length, 2); assert.equal(cleaned, 3);
  assert.equal(f.entry.pending.length, 0); assert.match(f.entry.lastWarning, /部分媒体连续读取失败/);
});

test('所有分片已确认但完成状态未保存时，不准备媒体或调用 QQ', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  f.entry.pending = [{ ...post('recovery', 'video'), groups: ['10003'], delivered: [], sentParts: { '10003': ['main', 'video'] } }];
  let pendingGroups, uploads = 0;
  f.service.prepareMessage = async (_entry, _item, options) => { pendingGroups = options.pendingGroups; return { parts: [{ key: 'main' }, { key: 'video' }] }; };
  f.service.onebot = async () => { uploads++; };
  f.setFeed({ title: '作者', items: [], successfulSources: ['video'] }); await f.service.check(f.entry.id);
  assert.deepEqual(pendingGroups, ['10003']); assert.equal(uploads, 0);
  assert.equal(f.entry.pending.length, 0); assert.equal(f.entry.sent, 1);
});

test('最终分片与群组完成合并写盘，两群两分片成功投递仅保存六次', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  f.service.prepareMessage = async () => ({ parts: [
    { key: 'main', message: [{ type: 'text', data: { text: 'card' } }] },
    { key: 'video', message: [{ type: 'video', data: { file: 'file:///test/video.mp4' } }] },
  ] });
  f.service.onebot = async () => {};
  const save = f.service.save; let writes = 0;
  f.service.save = function () { writes++; return save.call(this); };
  f.setFeed({ title: '作者', items: [post('writes', 'video')], successfulSources: ['video'] }); await f.service.check(f.entry.id);
  assert.equal(writes, 6); assert.equal(f.entry.pending.length, 0); assert.equal(f.entry.sent, 2);
});

test('状态写盘异常不再被回滚引用误判为取消，能够记录并上报错误', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  const save = f.service.save; let fail = true;
  f.service.save = function () { if (fail) { fail = false; throw Error('simulated disk full'); } return save.call(this); };
  f.setFeed({ title: '作者', items: [], successfulSources: ['video'] }); await f.service.check(f.entry.id);
  const current = f.service.get(f.entry.id);
  assert.notEqual(current.lastError, ''); assert.ok(current.nextCheckAt > 0);
});

test('运行指标记录读取、媒体准备和 QQ 上传，失败累计但不写入状态', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  f.service.prepareMessage = async () => ({ parts: [{ key: 'main', message: [{ type: 'text', data: { text: 'card' } }] }] });
  f.service.onebot = async () => {};
  f.setFeed({ title: '作者', items: [post('metrics', 'video')], successfulSources: ['video'] }); await f.service.check(f.entry.id);
  let metrics = f.service.status().entries[0].diagnostics;
  assert.equal(metrics.reads, 2); assert.equal(metrics.mediaPreparations, 1); assert.equal(metrics.qqUploads, 2);
  assert.equal(metrics.readFailures + metrics.mediaFailures + metrics.qqUploadFailures, 0);
  assert.equal(metrics.cardFallbacks, 0);
  for (const key of ['lastReadMs', 'lastMediaPrepareMs', 'lastQqUploadMs']) assert.ok(Number.isFinite(metrics[key]) && metrics[key] >= 0);
  assert.doesNotMatch(readFileSync(f.service.path, 'utf8'), /diagnostics|lastMediaPrepareMs|lastQqUploadMs/);
  f.service.fetchFeed = async () => { throw Error('read failed'); }; await f.service.check(f.entry.id);
  metrics = f.service.status().entries[0].diagnostics; assert.equal(metrics.reads, 3); assert.equal(metrics.readFailures, 1);
  f.service.close(); const reopened = new SubscriptionService(f.dir, f.store, f.options); t.after(() => reopened.close());
  assert.equal(reopened.status().entries[0].diagnostics, undefined);
});

test('卡片降级计入媒体失败且多群只计一次，补发已确认卡片不重复计数', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  let renders = 0;
  f.service.prepareMessage = (entry, item, options) => subscriptionMessage(entry, item, {
    ...options,
    renderCard: async () => { renders++; throw Error('PRIVATE_RENDER_ERROR'); },
    downloadVideo: async () => { throw Error('PRIVATE_VIDEO_ERROR'); },
  });
  f.setFeed({ title: '作者', items: [{ ...post('degraded', 'video'), contentKind: 'video' }], successfulSources: ['video'] });
  await f.service.check(f.entry.id);
  let metrics = f.service.status().entries[0].diagnostics;
  assert.equal(metrics.cardFallbacks, 1); assert.equal(metrics.mediaFailures, 2);
  assert.equal(renders, 1); assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(params => params.message[0].type === 'text'));
  assert.match(f.entry.lastWarning, /卡片生成失败/); assert.match(f.entry.lastWarning, /视频暂时无法下载/);
  await f.service.check(f.entry.id);
  metrics = f.service.status().entries[0].diagnostics;
  assert.equal(metrics.cardFallbacks, 1); assert.equal(metrics.mediaFailures, 3);
  assert.equal(renders, 1); assert.equal(f.sent.length, 2);
  assert.doesNotMatch(readFileSync(f.service.path, 'utf8'), /cardFallback|PRIVATE_/);
});

test('单独卡片降级仍确认文字投递成功，后续正常卡片不增加失败或降级数', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  let fallback = true;
  f.service.prepareMessage = (entry, item, options) => subscriptionMessage(entry, item, { ...options,
    renderCard: async () => { if (fallback) throw Error('PRIVATE_RENDER_ERROR'); return 'base64://UE5H'; },
  });
  f.setFeed({ title: '作者', items: [post('fallback-only', 'video')], successfulSources: ['video'] });
  await f.service.check(f.entry.id);
  let metrics = f.service.status().entries[0].diagnostics;
  assert.equal(metrics.mediaFailures, 1); assert.equal(metrics.cardFallbacks, 1);
  assert.equal(f.entry.lastError, ''); assert.equal(f.entry.pending.length, 0); assert.equal(f.entry.sent, 2);
  assert.match(f.entry.lastWarning, /卡片生成失败/);
  fallback = false;
  f.setFeed({ title: '作者', items: [post('normal-card', 'video')], successfulSources: ['video'] });
  await f.service.check(f.entry.id);
  metrics = f.service.status().entries[0].diagnostics;
  assert.equal(metrics.mediaFailures, 1); assert.equal(metrics.cardFallbacks, 1);
  assert.match(f.entry.lastWarning, /订阅源未提供配图/); assert.equal(f.sent.length, 4);
  assert.deepEqual(f.sent.at(-1).message.map(segment => segment.type), ['image', 'text']);
});

test('媒体准备异常不再误报为 QQ 上传失败', async t => {
  const f = fixture(t); await f.service.check(f.entry.id);
  f.service.prepareMessage = async () => { throw Error('bot id unavailable'); };
  f.setFeed({ title: '作者', items: [post('prepare-error', 'video')], successfulSources: ['video'] }); await f.service.check(f.entry.id);
  assert.match(f.entry.lastError, /媒体准备失败/); assert.doesNotMatch(f.entry.lastError, /QQ 推送失败/);
  assert.equal(f.service.status().entries[0].diagnostics.qqUploads, 0);
});

test('媒体和 QQ 同轮失败时保留混合错误，不只报告媒体问题', async t => {
  const f = fixture(t); f.service.upsert({ groups: ['10003'] }, f.entry.id); await f.service.check(f.entry.id);
  let uploads = 0;
  f.service.prepareMessage = async (_entry, item) => item.id === 'media'
    ? { parts: [{ key: 'main', message: [{ type: 'text', data: { text: 'card' } }] }, { key: 'video', unavailable: true }] }
    : { parts: [{ key: 'main', message: [{ type: 'text', data: { text: 'card' } }] }] };
  f.service.onebot = async () => { uploads++; if (uploads === 2) throw Error('QQ failed'); };
  const pending = id => ({ ...post(id, 'video'), groups: ['10003'], delivered: [] });
  f.entry.pending = [pending('media'), pending('qq')]; f.setFeed({ title: '作者', items: [], successfulSources: ['video'] });
  await f.service.check(f.entry.id);
  assert.match(f.entry.lastError, /媒体下载未完成/); assert.match(f.entry.lastError, /QQ 推送失败/);
  assert.equal(f.service.status().entries[0].diagnostics.qqUploadFailures, 1);
});

test('多行警告逐行去重，第三轮媒体跳过仍保留来源和其他警告', async t => {
  const f = fixture(t); f.service.upsert({ groups: ['10003'] }, f.entry.id); await f.service.check(f.entry.id);
  const warning = '图片警告\n卡片警告\n视频警告';
  f.service.prepareMessage = async (_entry, item) => ({ warning, parts: [
    { key: 'main', message: [{ type: 'text', data: { text: 'card' } }] },
    ...(item.id === 'third' ? [{ key: 'video', unavailable: true }] : []),
  ] });
  f.entry.pending = [
    { ...post('first', 'video'), groups: ['10003'], delivered: [] },
    { ...post('third', 'video'), groups: ['10003'], delivered: [], imageFailures: { video: 2 } },
  ];
  f.setFeed({ title: '作者', items: [], successfulSources: ['video'], warnings: ['来源警告'] }); await f.service.check(f.entry.id);
  const lines = f.entry.lastWarning.split('\n');
  assert.deepEqual(lines, ['来源警告', '图片警告', '卡片警告', '视频警告', '部分媒体连续读取失败，已跳过失效内容；请通过原文链接查看。']);
});

test('视频上传未确认时延迟清理临时文件', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); f.service.upsert({ groups: ['10003'] }, f.entry.id); await f.service.check(f.entry.id);
  let cleaned = 0;
  f.service.prepareMessage = async () => ({ parts: [
    { key: 'main', message: [{ type: 'text', data: { text: 'card' } }] },
    { key: 'video', message: [{ type: 'video', data: { file: 'file:///test/video.mp4' } }] },
  ], cleanup() { cleaned++; } });
  f.service.onebot = async (_action, params) => { if (params.message[0].type === 'video') throw Error('QQ upload'); };
  f.setFeed({ title: '作者', items: [post('video', 'video')], successfulSources: ['video'] }); await f.service.check(f.entry.id);
  assert.equal(cleaned, 0); t.mock.timers.tick(299999); assert.equal(cleaned, 0);
  t.mock.timers.tick(1); assert.equal(cleaned, 1);
});

test('生成图文过程中取消订阅不发送，多群仅生成一次，成功目标不重推', async t => {
  const f = fixture(t); await f.service.check(f.entry.id); let renders = 0;
  f.service.prepareMessage = async (...args) => { renders++; return prepareMessage(...args); };
  f.setFeed({ title: '作者', items: [post('a')], successfulSources: ['video', 'dynamic'] }); await f.service.check(f.entry.id); // dynamic baseline
  f.setFeed({ title: '作者', items: [post('b')], successfulSources: ['video', 'dynamic'] }); await f.service.check(f.entry.id);
  assert.equal(renders, 1); assert.equal(f.sent.length, 2);
  f.service.prepareMessage = async (...args) => { f.service.upsert({ enabled: false }, f.entry.id); return prepareMessage(...args); };
  f.setFeed({ title: '作者', items: [post('c')], successfulSources: ['video', 'dynamic'] }); await f.service.check(f.entry.id);
  assert.equal(f.sent.length, 2); assert.equal(f.entry.pending.length, 1);
});

const douyinData = () => ({ status_code: 0, aweme_list: [
  { aweme_id: '7701283294985575369', desc: '新作品', create_time: 1793091600, author: { sec_uid: source, nickname: '作者' }, video: { cover: { url_list: ['https://example.com/cover.jpg'] }, play_addr: { url_list: ['https://example.com/movie.mp4'] } } },
  { aweme_id: '7701283294985575370', desc: '新图文', create_time: 1793091900, author: { sec_uid: source, nickname: '作者' }, images: [{ url_list: ['https://example.com/note.jpg'] }] },
] });

test('抖音只接收该博主作品，图文与视频均返回封面文案，不保存播放地址', () => {
  const data = douyinData(); data.aweme_list.push({ ...data.aweme_list[0], aweme_id: '7701283294985575371', author: { sec_uid: source + 'foreign', nickname: '外人' } });
  const feed = parseDouyinPosts(data, source); assert.equal(feed.title, '作者'); assert.equal(feed.items.length, 2);
  assert.match(feed.items[0].link, /\/note\//); assert.deepEqual(feed.items[1].images, ['https://example.com/cover.jpg']);
  assert.doesNotMatch(JSON.stringify(feed), /movie.mp4|play_addr|外人/);
  for (const value of [{ status_code: 0, aweme_list: [] }, { status_code: 8 }, { ...douyinData(), status_code: 5 }]) assert.throws(() => parseDouyinPosts(value, source));
});

test('官方主页读取复用后台 Cookie，成功、超时、取消都关闭隔离浏览器，错误不泄漏凭据', async () => {
  let closed = 0, supplied;
  const browserFactory = () => ({ async start(cookie, options) { supplied = { cookie, options }; this.profileData = douyinData(); }, close() { closed++; } });
  const feed = await readDouyinFeed(source, { available: () => true, browserFactory, cookies: { read: id => { assert.equal(id, 'douyin'); return 'PRIVATE_COOKIE'; } } });
  assert.equal(feed.items.length, 2); assert.equal(supplied.cookie, 'PRIVATE_COOKIE'); assert.deepEqual(supplied.options, { profile: source }); assert.equal(closed, 1);
  const wait = () => ({ async start() {}, close() { closed++; } });
  await assert.rejects(readDouyinFeed(source, { available: () => true, browserFactory: wait, timeoutMs: 20 }), { code: 'DOUYIN_TIMEOUT' });
  const controller = new AbortController(); const pending = readDouyinFeed(source, { available: () => true, browserFactory: wait, signal: controller.signal }); controller.abort(); await assert.rejects(pending);
  await assert.rejects(readDouyinFeed(source, { available: () => true, browserFactory: () => ({ async start() { throw Error('sessionid=PRIVATE_COOKIE'); }, close() {} }) }), error => error.code === 'DOUYIN_NETWORK' && !error.message.includes('PRIVATE_COOKIE'));
});

test('B 站动态 RSSHub 失败时使用官方 API，保留视频去重与直播身份', async () => {
  const uid = '12345', videoUrl = 'https://www.bilibili.com/video/BV1bK411W797';
  const official = parseBilibiliDynamics({ items: [
    { id: '998134289197432851', uploader_id: uid, uploader: '作者', title: '新视频', description: '视频动态', timestamp: 1792377600,
      webpage_url: 'https://t.bilibili.com/998134289197432851', video_url: videoUrl, own_video: true, thumbnail: 'https://i0.hdslb.com/cover.jpg', image_groups: [] },
    { id: '998134289197432852', uploader_id: uid, uploader: '作者', title: '直播标题', description: '开播了', timestamp: 1792377601,
      webpage_url: 'https://t.bilibili.com/998134289197432852', live_url: 'https://live.bilibili.com/123', image_groups: [] },
    { id: '998134289197432853', uploader_id: '456', uploader: '推荐作者', title: '无关推荐', timestamp: 1792377602 },
  ] }, uid);
  assert.equal(official.items.length, 2); assert.equal(official.items[0].contentKind, 'live');
  let officialCalls = 0;
  const feed = await readFeed({ type: 'bilibili', source: uid }, settings, {
    download: async url => {
      if (url.includes('/user/dynamic/')) throw Error('RSSHub unavailable');
      return { url, xml: xml('作者的 bilibili 空间', []) };
    },
    readBilibili: async value => { officialCalls++; assert.equal(value, uid); return official; },
  });
  assert.equal(officialCalls, 1); assert.deepEqual(feed.warnings, []);
  assert.deepEqual(feed.successfulSources.sort(), ['dynamic', 'video']);
  const video = feed.items.find(item => item.ownVideo);
  assert.equal(video.id, createHash('sha256').update(videoUrl).digest('hex'));
  assert.equal(feed.items.find(item => item.contentKind === 'live').link, 'https://live.bilibili.com/123');
});

test('抖音官方通道优先，RSSHub 仅作备用，取消时不启动备用，空结果不能假报健康', async () => {
  const subscription = { type: 'douyin', source }; let downloads = 0;
  const download = async url => { downloads++; return { url, xml: xml('作者', [{ title: '更新', link: 'https://www.douyin.com/video/7701283294985575369' }]) }; };
  const feed = await readFeed(subscription, settings, { readDouyin: async value => { assert.equal(value, source); return parseDouyinPosts(douyinData(), source); }, download });
  assert.equal(feed.items.length, 2); assert.equal(downloads, 0);
  await readFeed(subscription, settings, { readDouyin: async () => { throw Object.assign(Error('需要验证'), { code: 'DOUYIN_VERIFY' }); }, download }); assert.equal(downloads, 1);
  const controller = new AbortController(); await assert.rejects(readFeed(subscription, settings, { signal: controller.signal, readDouyin: async () => { controller.abort(); throw Error('cancelled'); }, download })); assert.equal(downloads, 1);
  await assert.rejects(readFeed(subscription, settings, { download: async () => ({ xml: xml('作者', []) }) }), { code: 'DOUYIN_EMPTY' });
});

test('抖音 RSS 回退的视频链接同样进入下载发送流程', async () => {
  const videoLink = 'https://www.douyin.com/video/7701283294985575369';
  const feed = await readFeed({ type: 'douyin', source }, settings, {
    readDouyin: async () => { throw Object.assign(Error('需要验证'), { code: 'DOUYIN_VERIFY' }); },
    download: async url => ({ url, xml: xml('作者', [{ title: '新视频', link: videoLink, html: '<img src="https://example.com/cover.jpg">' }]) }),
  });
  let downloads = 0;
  const prepared = await subscriptionMessage({ type: 'douyin', name: '作者' }, feed.items[0], {
    downloadImage: async () => ({ file: 'base64://UE5H' }), renderCard: async () => 'base64://UE5H',
    downloadVideo: async url => { downloads++; assert.equal(url, videoLink); return { media: [{ type: 'video', file: 'file:///test/video.mp4' }], cleanup() {} }; },
  });
  assert.equal(downloads, 1); assert.deepEqual(prepared.parts.map(part => part.key), ['main', 'video']);
  assert.equal(prepared.parts[1].message[0].type, 'video'); prepared.cleanup();
});

test('浏览器只捕获目标 sec_uid 的官方作品响应，阻止媒体下载，不捕获推荐和异站响应', () => {
  const browser = new DouyinBrowser(); browser.profile = source; browser.sessionId = 'test'; browser.call = async () => ({});
  const event = url => browser.message(JSON.stringify({ sessionId: 'test', method: 'Network.responseReceived', params: { requestId: url, response: { url, status: 200 } } }));
  event('https://evil.example/aweme/v1/web/aweme/post/?sec_user_id=' + source);
  event('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=' + source + 'other');
  event('https://www.douyin.com/aweme/v1/web/aweme/feed/?sec_user_id=' + source);
  assert.equal(browser.responses.size, 0);
  event('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=' + source); assert.equal(browser.responses.size, 1);
  const calls = []; browser.call = async (...args) => { calls.push(args); return {}; };
  browser.message(JSON.stringify({ sessionId: 'test', method: 'Fetch.requestPaused', params: { requestId: 'media' } }));
  assert.equal(calls[0][0], 'Fetch.failRequest'); browser.close();
});

test('卡片预览复用推送渲染，但不准备视频、原图聊天记录或读取机器人 QQ', async () => {
  const picture = { file: 'base64://aW1hZ2U=' }, image = 'base64://Y2FyZA==';
  for (const contentKind of ['photo', 'video']) {
    const output = await subscriptionMessage({ type: 'douyin', name: '作者' }, {
      ...post('preview'), contentKind, images: ['https://example.com/1.png', 'https://example.com/2.png']
    }, { cardOnly: true, downloadImage: async () => picture, renderCard: async () => image,
      downloadVideo: async () => { throw new Error('preview must not download video'); },
      selfId: async () => { throw new Error('preview must not query QQ'); } });
    assert.equal(output.warning, ''); assert.equal(output.cardFallback, false);
    assert.equal(output.parts.length, 1); assert.equal(output.message[0].data.file, image);
    assert.equal(output.cleanup, undefined);
  }
});

test('订阅预览返回最新卡片且不写入基线、待发记录或发送指标', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-preview-card-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [], store = { config: { ...defaultConfig(), allowedGroups: ['10003'] } };
  const service = new SubscriptionService(dir, store, {
    onebot: async () => assert.fail('preview must not send QQ messages'),
    fetchFeed: async () => ({ title: '作者', items: [post('latest'), post('previous')] }),
    preparePreview: async (_entry, item, options) => {
      assert.equal(options.cardOnly, true); calls.push(item.id);
      return { message: [{ type: 'image', data: { file: 'base64://Y2FyZA==' } }, { type: 'text', data: { text: item.link } }], warning: '' };
    }
  }); t.after(() => service.close());
  service.upsert({ name: '测试', type: 'bilibili', source: '12345', groups: ['10003'] });
  const entry = service.state.entries[0], before = readFileSync(service.path, 'utf8');
  const result = await service.preview(entry.id, { renderCard: true });
  assert.equal(result.card, 'data:image/png;base64,Y2FyZA=='); assert.deepEqual(calls, ['latest']);
  assert.equal(result.items.length, 2); assert.match(result.text, /latest$/);
  assert.equal(readFileSync(service.path, 'utf8'), before); assert.equal(service.diagnostics.get(entry.id).mediaPreparations, 0); assert.equal(service.diagnostics.get(entry.id).qqUploads, 0);
});

test('预览复用投递准备器并兼容 parts-only 结果，卡片异常不误报为源读取失败', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-preview-adapter-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = { config: { ...defaultConfig(), allowedGroups: ['10003'] } };
  const service = new SubscriptionService(dir, store, {
    fetchFeed: async () => ({ title: '作者', items: [post('preview')] }),
    prepareMessage: async () => ({ parts: [{ key: 'main', message: [{ type: 'text', data: { text: 'valid prepared result' } }] }] }),
  }); t.after(() => service.close());
  service.upsert({ name: '测试', type: 'bilibili', source: '12345', groups: ['10003'] });
  const result = await service.preview(service.state.entries[0].id, { renderCard: true });
  assert.equal(result.text, 'valid prepared result');
  service.preparePreview = async () => { throw Error('renderer unavailable'); };
  await assert.rejects(service.preview(service.state.entries[0].id, { renderCard: true }), /订阅卡片准备失败/);
});


test('首图备用地址恢复后仍优先首图，原图集顺序保持且不发送重复 CDN 版本', async () => {
  const first = 'https://example.com/first.jpg', backup = 'https://example.com/first-backup.jpg', second = 'https://example.com/second.jpg', rendered = [];
  const item = { ...post('cover-variants'), images: [first, second], imageGroups: [[first, backup], [second]] };
  const result = await subscriptionMessage({ type: 'bilibili', name: '作者' }, item, {
    downloadImage: async url => { if (url === first) throw Error('unavailable'); return { file: 'base64://' + Buffer.from(url).toString('base64') }; },
    renderCard: async (_entry, _item, pictures) => { rendered.push(...pictures); return 'base64://UE5H'; }, selfId: async () => '10001',
  });
  assert.deepEqual(rendered.map(p => Buffer.from(p.file.slice(9), 'base64').toString()), [backup]);
  assert.deepEqual(result.parts[1].messages.map(n => Buffer.from(n.data.content[0].data.file.slice(9), 'base64').toString()), [backup, second]);
  assert.equal(result.warning, '');
});

test('首图全部地址失效时使用第二张，视频配图缺失时使用解析器本地封面', async t => {
  const first = 'https://example.com/first.jpg', second = 'https://example.com/second.jpg'; let chosen;
  await subscriptionMessage({ type: 'bilibili', name: '作者' }, { ...post('second-cover'), images: [first, second] }, {
    downloadImage: async url => { if (url === first) throw Error('unavailable'); return { file: 'base64://UE5H' }; },
    renderCard: async (_entry, _item, pictures) => { chosen = pictures; return 'base64://UE5H'; }, selfId: async () => '10001',
  });
  assert.equal(chosen.length, 1);
  const { writeFileSync } = await import('node:fs'); const { pathToFileURL } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-video-cover-')), cover = join(dir, 'cover.png'); t.after(() => rmSync(dir, { recursive: true, force: true })); writeFileSync(cover, 'local-cover'); let cleaned = 0;
  const result = await subscriptionMessage({ type: 'douyin', name: '作者' }, { ...post('video-cover'), contentKind: 'video', images: [] }, {
    downloadVideo: async () => ({ media: [{ type: 'image', file: 'file:///napcat-media/cover.png', localFile: pathToFileURL(cover).href }, { type: 'video', file: 'file:///video.mp4' }], cleanup() { cleaned++; } }),
    renderCard: async (_entry, _item, pictures) => { chosen = pictures; return 'base64://UE5H'; },
  });
  assert.equal(Buffer.from(chosen[0].file.slice(9), 'base64').toString(), 'local-cover');
  assert.match(result.warning, /已使用视频解析封面/); result.cleanup(); assert.equal(cleaned, 1);
});

test('抖音原始封面为空时仍保留其他封面候选和图集备用地址', () => {
  const feed = parseDouyinPosts({ status_code: 0, aweme_list: [{ aweme_id: '7701283294985575369', author: { sec_uid: source }, video: {
    origin_cover: { url_list: [] }, cover: { url_list: ['https://example.com/a.jpg', 'https://example.com/b.jpg'] },
  } }] }, source);
  assert.deepEqual(feed.items[0].images, ['https://example.com/b.jpg']);
  assert.deepEqual(feed.items[0].imageGroups, [['https://example.com/b.jpg', 'https://example.com/a.jpg']]);
});

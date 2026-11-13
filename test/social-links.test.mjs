import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bot } from '../src/bot.mjs';
import { Conversations } from '../src/conversations.mjs';
import { defaultConfig, validatePatch } from '../src/config.mjs';
import { LinkParser, socialLink, extractSocialLinks, runLinkWorker, socialPlatforms } from '../src/social-links.mjs';

const text = value => [{ type: 'text', data: { text: value } }];
const event = (url = 'https://www.bilibili.com/video/BV1234567890', extra = {}) => ({ post_type: 'message', message_type: 'group',
  self_id: 10001, group_id: 10003, user_id: 10002, message_id: 1, message: text(url), ...extra });
const store = () => ({ config: { ...defaultConfig(), allowedGroups: ['10003', '10004'], deepseekKey: 'mock-key', enabled: true, webSearchEnabled: false, linkCooldownSeconds: 0 } });
const wait = async check => { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('任务未完成'); };
function fixture(t) { const path = mkdtempSync(join(tmpdir(), 'qqbot-links-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
const fakeParser = (media = true) => ({ parse: async () => ({ title: '测试视频', author: '测试作者', description: '内容简介',
  media: media ? [{ type: 'video', file: 'file:///app/qqbot-media/test/video.mp4' }] : [], bytes: 10, cleanup() {} }), close() {}, cancel() {} });

test('识别常见社交平台、短链和 QQ 卡片，拒绝伪装域名、任意端口及本地链接', () => {
  const urls = ['https://b23.tv/abcd', 'https://v.douyin.com/abcd/', 'https://v.kuaishou.com/xyz', 'https://xhslink.com/a/abc',
    'https://m.weibo.cn/detail/123', 'https://youtu.be/abc', 'https://vm.tiktok.com/abc', 'https://x.com/name/status/123',
    'https://instagram.com/reel/abc', 'https://fb.watch/abc/', 'https://reddit.com/r/test/comments/abc/', 'https://acfun.cn/v/ac123',
    'https://zhihu.com/question/123', 'https://tieba.baidu.com/p/123', 'https://mp.weixin.qq.com/s/abc'];
  assert.equal(new Set(urls.map(url => socialLink(url)?.platform)).size, socialPlatforms.length);
  for (const url of ['https://bilibili.com.evil.test/video/BV1', 'https://evilbilibili.com/video/BV1', 'https://bilibili.com:123/a',
    'http://localhost/video', 'file:///etc/passwd', 'https://user:pass@bilibili.com/video/a', 'https://bilibili.com/']) assert.equal(socialLink(url), null, url);
  const links = extractSocialLinks(event('来看 https://b23.tv/abcd。 https://b23.tv/abcd， https://x.com/user/status/123!'));
  assert.equal(links.length, 2);
  assert.equal(socialLink('https://bilibili.com/video/BV1?utm_source=share&vd_source=abc&p=2').url, 'https://bilibili.com/video/BV1?p=2');
  assert.match(socialLink('https://xiaohongshu.com/explore/abc?xsec_token=abc').url, /xsec_token=abc/);
  assert.equal(extractSocialLinks(event('', { message: [{ type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: urls[0] } } }) } }] }))[0].url, urls[0]);
  assert.equal(extractSocialLinks(event('[CQ:json,data={"url":"https://b23.tv/abcd"}]'))[0].platform, 'bilibili');
});

test('无需 @ 的视频链接下载后以视频段发送，不调用 DS 或写入聊天记忆', async () => {
  const s = store(), parser = fakeParser(), calls = []; let cleaned = 0;
  parser.parse = async () => ({ title: '视频标题', author: '作者', description: '简介', bytes: 123,
    media: [{ type: 'video', file: 'file:///app/qqbot-media/test/video.mp4' }], cleanup() { cleaned++; } });
  const bot = new Bot(s, new Conversations(), parser);
  bot.completion = bot.request = async () => { throw new Error('不得调用 DS'); };
  bot.onebot = async (action, params, config, timeout) => calls.push({ action, params, timeout });
  assert.deepEqual(bot.receive(event()), { accepted: true }); await wait(() => bot.active === 0);
  assert.equal(calls.length, 2); assert.equal(calls[1].params.message[0].type, 'video'); assert.equal(calls[1].timeout, 120);
  assert.equal(bot.stats.videosSent, 1); assert.equal(bot.stats.linksParsed, 1); assert.equal(cleaned, 1);
  assert.equal(bot.logs[0].deepseekCalled, false); assert.equal(bot.logs[0].tokens, 0);
  assert.equal(bot.conversations.list().total, 0); assert.equal(bot.stats.triggered, 0);
  assert.equal(bot.logDetail(bot.logs[0].id).replyMention, '');
  assert.equal(JSON.stringify(bot.status()).includes('简介'), false);
  bot.close();
});

test('@ 机器人附带文本、CQ 链接或 QQ 视频卡片时仅调用 DS，保留问题和链接到上下文', async t => {
  const s = store(); s.config.cooldownSeconds = 0;
  let parsed = 0; const prompts = [], sent = [];
  const parser = fakeParser(); parser.parse = async () => { parsed++; throw Error('不应解析'); };
  const bot = new Bot(s, new Conversations(), parser); t.after(() => bot.close());
  bot.request = async (url, body) => {
    assert.ok(url.endsWith('/chat/completions')); prompts.push(body.messages.at(-1).content);
    return { choices: [{ message: { content: '模型对该链接的回答' } }], usage: { total_tokens: 5 } };
  };
  bot.onebot = async (action, params) => { assert.equal(action, 'send_group_msg'); sent.push(params.message); };
  const at = { type: 'at', data: { qq: '10001' } }, url = 'https://b23.tv/example';
  const messages = [[at, ...text(`解释一下 ${url}`)], `[CQ:at,qq=10001] 解释一下 ${url}`,
    [at, ...text('解释一下'), { type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: url } } }) } }],
    [at, { type: 'xml', data: { data: `<msg url="${url}" />` } }]];
  for (const [index, message] of messages.entries()) {
    assert.deepEqual(bot.receive(event('', { message_id: index + 1, message })), { accepted: true });
    await wait(() => bot.active === 0);
  }
  bot.receive(event('', { message_id: 5, message: [at], raw_message: `[CQ:at,qq=10001][CQ:json,data={"url":"${url}"}]` }));
  await wait(() => bot.active === 0);
  assert.equal(parsed, 0); assert.equal(bot.stats.linksParsed, 0); assert.equal(bot.stats.replied, 5);
  assert.equal(prompts.length, 5); assert.ok(prompts.every(prompt => prompt.includes(url)));
  assert.ok(prompts.slice(0, 3).every(prompt => prompt.includes('解释一下')));
  assert.ok(sent.every(message => message.map(part => part.type).join(',') === 'at,text'));
  assert.equal(bot.conversations.context(bot.conversations.list().items[0].id).length, 10);
  assert.ok(bot.logs.every(log => log.deepseekCalled === true && log.tokens === 5));
});

test('@ 请求不占用链接去重或冷却；自动解析后仍可 @ 同一链接，模型失败也不回退解析', async t => {
  const s = store(); s.config.cooldownSeconds = 0; s.config.linkCooldownSeconds = 60;
  let parsed = 0, calls = 0, fail = false;
  const parser = fakeParser(false); parser.parse = async () => { parsed++; return { title: '帖子', media: [], cleanup() {} }; };
  const bot = new Bot(s, new Conversations(), parser); t.after(() => bot.close());
  bot.onebot = async () => {};
  bot.request = async () => { calls++; if (fail) throw Error('模型不可用'); return { choices: [{ message: { content: '模型回答' } }] }; };
  const url = 'https://b23.tv/example', atMessage = [{ type: 'at', data: { qq: '10001' } }, ...text(url)];
  bot.receive(event('', { message: atMessage })); await wait(() => bot.active === 0);
  assert.equal(parsed, 0); assert.equal(bot.linkSeen.size, 0); assert.equal(bot.linkCooldowns.size, 0);
  assert.deepEqual(bot.receive(event(url, { message_id: 2 })), { accepted: true }); await wait(() => bot.active === 0);
  assert.equal(parsed, 1);
  assert.deepEqual(bot.receive(event('', { message_id: 3, message: atMessage })), { accepted: true }); await wait(() => bot.active === 0);
  assert.equal(calls, 2); assert.equal(parsed, 1);
  fail = true;
  bot.receive(event('', { message_id: 4, message: atMessage })); await wait(() => bot.active === 0);
  assert.equal(calls, 3); assert.equal(parsed, 1); assert.equal(bot.stats.failed, 1);
});

test('识别小红书 cn 分享域名和原始文案，无需 @；拒绝伪装域名并保留访问参数', async () => {
  const share = '2026年最恐怖的動畫🤣 https://xhslink.cn/o/7X6IjXUvOPQ 拷走链接，去【小红书】逛逛分享~';
  const links = extractSocialLinks(event(share));
  assert.equal(links.length, 1); assert.equal(links[0].platform, 'xiaohongshu');
  assert.equal(links[0].url, 'https://xhslink.cn/o/7X6IjXUvOPQ');
  assert.equal(socialLink('https://xhslink.cn.evil.test/o/123'), null);
  const parser = fakeParser(false), parsed = [];
  parser.parse = async link => { parsed.push(link); return { title: '小红书分享', media: [], cleanup() {} }; };
  const bot = new Bot(store(), new Conversations(), parser);
  bot.onebot = async () => {}; bot.completion = async () => { throw Error('链接不能调用模型'); };
  bot.receive(event(share)); await wait(() => bot.active === 0);
  assert.equal(parsed.length, 1); assert.equal(bot.stats.linksParsed, 1); bot.close();
});

test('B 站 App 分享入口规范为桌面视频地址，保留分 P 并去重', () => {
  const canonical = 'https://www.bilibili.com/video/BV1bK411W797?p=2';
  for (const url of ['https://m.bilibili.com/video/BV1bK411W797?share_source=qq&p=2',
    'https://bilibili.com/video/BV1bK411W797/?p=2',
    'https://player.bilibili.com/player.html?bvid=BV1bK411W797&p=2']) {
    assert.equal(socialLink(url).url, canonical);
  }
  assert.equal(extractSocialLinks(event(`${canonical} https://m.bilibili.com/video/BV1bK411W797?p=2`)).length, 1);
  assert.equal(socialLink('https://m.bilibili.com/video/av12345?share_source=qq').url, 'https://www.bilibili.com/video/av12345');
});

test('小程序优先读取真实分享地址，兼容转义、编码、App 深链与 XML 卡片', () => {
  const short = 'https://b23.tv/example';
  const card = detail => event('', { message: [{ type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.miniapp_01', meta: { detail_1: detail } }) } }] });
  const fixtures = [
    [{ appid: '1109937557', qqdocurl: short, bvid: 'BV1bK411W797', url: 'm.q.qq.com/a/s/example' }, short],
    [{ qqdocurl: encodeURIComponent(short) }, short],
    [{ qqdocurl: encodeURIComponent(encodeURIComponent(short)) }, short],
    [{ jumpUrl: `mqqapi://app/open?url=${encodeURIComponent(short)}` }, short],
    [{ jumpUrl: `https://example.com/open?url=${encodeURIComponent(short)}` }, short],
    [{ qqdocurl: 'bilibili://video/12345' }, 'https://www.bilibili.com/video/av12345'],
    [{ appid: '1109937557', path: 'pages/video/video?bvid=BV1bK411W797&p=2' }, 'https://www.bilibili.com/video/BV1bK411W797?p=2'],
    [{ appid: '1109937557', aid: '12345' }, 'https://www.bilibili.com/video/av12345'],
  ];
  for (const [detail, expected] of fixtures) assert.deepEqual(extractSocialLinks(card(detail)).map(link => link.url), [expected]);
  assert.equal(extractSocialLinks(event('', { message: [{ type: 'json', data: { data: '{"url":"https:\\/\\/b23.tv\\/example"}' } }] }))[0].url, short);
  const xml = '<msg url="https://m.bilibili.com/video/BV1bK411W797?p=2&amp;share_source=qq" />';
  assert.equal(extractSocialLinks(event('', { message: [{ type: 'xml', data: { data: xml } }] }))[0].url, 'https://www.bilibili.com/video/BV1bK411W797?p=2');
  assert.equal(extractSocialLinks(event('', { message: [], raw_message: `[CQ:json,data={"url":"${short}"}]` }))[0].url, short);
  assert.deepEqual(extractSocialLinks(card({ preview: short, icon: short })), []);
  assert.deepEqual(extractSocialLinks(card({ appid: 'other', path: 'pages/video/video?bvid=BV1bK411W797' })), []);
  assert.deepEqual(extractSocialLinks(card({ qqdocurl: encodeURIComponent('https://bilibili.com.evil.test/video/BV1bK411W797') })), []);
  assert.deepEqual(extractSocialLinks(card({ qqdocurl: 'https%3A%2F%2F%ZZ' })), []);
  const urls = Array.from({ length: 4 }, (_, i) => `https://b23.tv/test${i}`);
  assert.equal(extractSocialLinks(event(urls.join(' '))).length, 3);
});

test('手机小程序分享视频进入自动解析并以视频发送', async () => {
  const parser = fakeParser(), calls = [];
  parser.parse = async link => {
    assert.equal(link.url, 'https://www.bilibili.com/video/BV1bK411W797');
    return { title: 'App 分享视频', media: [{ type: 'video', file: 'file:///test/video.mp4' }], cleanup() {} };
  };
  const bot = new Bot(store(), new Conversations(), parser);
  bot.onebot = async (action, params) => calls.push({ action, params });
  bot.completion = async () => { throw new Error('不得调用 DS'); };
  const data = JSON.stringify({ app: 'com.tencent.miniapp_01', meta: { detail_1: { qqdocurl: 'https://m.bilibili.com/video/BV1bK411W797?share_source=qq' } } });
  assert.deepEqual(bot.receive(event('', { message: [{ type: 'json', data: { data } }] })), { accepted: true });
  await wait(() => bot.active === 0);
  assert.equal(calls[1].params.message[0].type, 'video');
  assert.equal(bot.stats.videosSent, 1);
  assert.equal(bot.stats.linksFailed, 0);
  bot.close();
});

test('自动解析受群白名单、账户、启停和独立去重控制；不同群相同链接可解析', async () => {
  const s = store(), bot = new Bot(s, new Conversations(), fakeParser(false)); let parsed = 0;
  bot.links.parse = async () => { parsed++; return { title: '帖子', media: [], cleanup() {} }; }; bot.onebot = async () => {};
  for (const patch of [{ message_type: 'private' }, { user_id: 10001 }, { post_type: 'message_sent' }, { self_id: 'bad' }]) {
    bot.receive(event(undefined, patch));
  }
  s.config.allowedGroups = ['99999']; bot.receive(event()); s.config.allowedGroups = ['10003', '10004'];
  s.config.botId = '99999'; bot.receive(event()); s.config.botId = '';
  s.config.enabled = false; bot.receive(event()); s.config.enabled = true;
  s.config.linkParsingEnabled = false; bot.receive(event()); s.config.linkParsingEnabled = true;
  assert.equal(parsed, 0);
  bot.receive(event()); await wait(() => bot.active === 0);
  bot.receive(event(undefined, { message_id: 2 })); assert.equal(parsed, 1);
  bot.receive(event(undefined, { message_id: 3, group_id: 10004 })); await wait(() => bot.active === 0); assert.equal(parsed, 2);
  bot.close();
});

test('多图作品以一条合并转发发送，保留图片顺序和文字段，发送完成后清理', async () => {
  const parser = fakeParser(), calls = []; let cleaned = 0, finish;
  const media = Array.from({ length: 5 }, (_, i) => ({ type: 'image', file: `file:///app/qqbot-media/test/image-${i}.jpg` }));
  parser.parse = async () => ({ title: '[CQ:at,qq=all] 图集', media, bytes: 50, cleanup() { cleaned++; } });
  const bot = new Bot(store(), new Conversations(), parser);
  bot.onebot = async (action, params, _config, timeout) => { calls.push({ action, params, timeout }); await new Promise(resolve => { finish = resolve; }); };
  bot.receive(event('https://www.xiaohongshu.com/explore/abcd'));
  await wait(() => calls.length === 1);
  assert.equal(cleaned, 0);
  const { action, params, timeout } = calls[0];
  assert.equal(action, 'send_group_forward_msg'); assert.equal(timeout, 120);
  assert.equal(params.group_id, 10003); assert.equal(params.messages.length, 6);
  assert.equal(params.messages[0].data.content[0].type, 'text');
  assert.match(params.messages[0].data.content[0].data.text, /\[CQ:at,qq=all\]/);
  assert.deepEqual(params.messages.slice(1).map(node => node.data.content[0].data.file), media.map(item => item.file));
  assert.ok(params.messages.every(node => node.type === 'node' && node.data.user_id === '10001'));
  finish(); await wait(() => bot.active === 0);
  assert.equal(calls.length, 1); assert.equal(cleaned, 1); assert.equal(bot.stats.linksParsed, 1);
  assert.equal(bot.stats.videosSent, 0); assert.equal(bot.logs[0].deepseekCalled, false);
  assert.match(bot.logs[0].message, /图集已合并发送/);
  assert.equal(bot.logDetail(bot.logs[0].id).mediaCount, 5); bot.close();
});

test('抖音多图作品同样合并为一条聊天记录发送，不在一个聊天框堆叠图片，确认后清理', async t => {
  for (const card of [true, false]) {
    const parser = fakeParser(), calls = [], media = [0, 1, 2].map(i => ({ type: 'image', file: `file:///test/image-${i}.jpg` }));
    let finish, cleaned = 0;
    parser.parse = async () => ({ title: '[CQ:at,qq=all] 图集', media, bytes: 744951,
      imageSizes: [[1440, 2560], [1440, 2560], [1440, 2560]], ...(card ? { card: { file: 'file:///test/card.png' } } : {}), cleanup() { cleaned++; } });
    const bot = new Bot(store(), new Conversations(), parser); t.after(() => bot.close());
    bot.request = bot.completion = async () => { throw Error('图集不应调用 DS'); };
    bot.onebot = async (action, params, _config, timeout) => {
      calls.push({ action, params, timeout }); assert.equal(params.group_id, 10003);
      if (action === 'send_group_msg') assert.ok(params.message.filter(s => s.type === 'image').length <= 1);
      if (action === 'send_group_forward_msg') await new Promise(resolve => { finish = resolve; });
    };
    bot.receive(event('https://v.douyin.com/IfDq5XfcWII/'));
    await wait(() => !!finish);
    assert.equal(calls.length, card ? 2 : 1); assert.equal(cleaned, 0);
    const sent = calls.at(-1);
    assert.equal(sent.action, 'send_group_forward_msg'); assert.equal(sent.timeout, 120);
    const nodes = sent.params.messages;
    assert.deepEqual(nodes.filter(n => n.data.content[0].type === 'image').map(n => n.data.content[0].data.file), media.map(m => m.file));
    if (!card) assert.match(nodes[0].data.content[0].data.text, /\[CQ:at,qq=all\]/);
    else assert.equal(nodes.length, 3);
    const pending = bot.logDetail(bot.logs[0].id);
    assert.equal(pending.linkStage, 'album'); assert.equal(pending.mediaSendMode, 'forward');
    finish(); await wait(() => !bot.active);
    const detail = bot.logDetail(bot.logs[0].id);
    assert.equal(cleaned, 1); assert.equal(bot.stats.linksParsed, 1); assert.equal(detail.linkStage, 'completed');
    assert.equal(bot.conversations.list().total, 0); assert.match(bot.logs[0].message, /图集已合并发送（3 张）/);
  }
});

test('图集附带视频时图片合并为聊天记录，视频单独发送', async t => {
  const parser = fakeParser(), calls = [];
  parser.parse = async () => ({ title: '混合', media: [{ type: 'image', file: 'file:///a.jpg' }, { type: 'video', file: 'file:///v.mp4' }, { type: 'image', file: 'file:///b.jpg' }], cleanup() {} });
  const bot = new Bot(store(), new Conversations(), parser); t.after(() => bot.close());
  bot.onebot = async (action, params) => { calls.push({ action, params }); };
  bot.receive(event('https://v.douyin.com/IfDq5XfcWII/')); await wait(() => !bot.active);
  assert.deepEqual(calls.map(c => c.action), ['send_group_forward_msg', 'send_group_msg']);
  assert.equal(calls[0].params.messages.filter(n => n.data.content[0].type === 'image').length, 2);
  assert.equal(calls[1].params.message[0].type, 'video'); assert.equal(bot.stats.videosSent, 1);
});

test('抖音图集合并转发超时准确记录发送阶段，不重试且保留文件宽限期', async t => {
  const parser = fakeParser(); let cleaned = 0, calls = 0;
  parser.parse = async () => ({ title: '图集', media: [0, 1, 2].map(i => ({ type: 'image', file: `file:///test/${i}.jpg` })), cleanup() { cleaned++; } });
  const bot = new Bot(store(), new Conversations(), parser); t.after(() => bot.close());
  bot.onebot = async () => { calls++; throw Error('上游请求超时'); };
  bot.receive(event('https://v.douyin.com/IfDq5XfcWII/')); await wait(() => !bot.active);
  assert.equal(calls, 1); assert.equal(cleaned, 0); assert.equal(bot.stats.linksParsed, 0); assert.equal(bot.stats.linksFailed, 1);
  const detail = bot.logDetail(bot.logs[0].id);
  assert.equal(detail.replyStatus, 'send_failed'); assert.equal(detail.linkStage, 'album');
  assert.match(detail.message, /QQ 合并转发上传失败或未确认：请求超时/);
});

test('发出卡片后暂停机器人，抖音图集原图不再发送', async t => {
  const s = store(), parser = fakeParser(); let calls = 0;
  parser.parse = async () => ({ title: '图集', media: [0, 1].map(i => ({ type: 'image', file: `file:///test/${i}.jpg` })), card: { file: 'file:///test/card.png' }, cleanup() {} });
  const bot = new Bot(s, new Conversations(), parser); t.after(() => bot.close());
  bot.onebot = async () => { calls++; s.config.enabled = false; };
  bot.receive(event('https://v.douyin.com/IfDq5XfcWII/')); await wait(() => !bot.active);
  assert.equal(calls, 1); assert.equal(bot.stats.linksParsed, 0);
  assert.equal(bot.logDetail(bot.logs[0].id).replyStatus, 'cancelled');
});

test('合并转发失败不自动散发图片刷屏，单张图片继续正常发送', async () => {
  const parser = fakeParser(); let count = 0;
  parser.parse = async () => ({ title: '图集', media: Array.from({ length: 2 }, (_, i) => ({ type: 'image', file: `file:///test/${i}.jpg` })), cleanup() {} });
  const bot = new Bot(store(), new Conversations(), parser);
  bot.onebot = async action => { count++; assert.equal(action, 'send_group_forward_msg'); throw new Error('合并转发上传失败'); };
  bot.receive(event()); await wait(() => bot.active === 0);
  assert.equal(count, 1); assert.equal(bot.stats.linksFailed, 1); assert.equal(bot.stats.linksParsed, 0);
  assert.equal(bot.logDetail(bot.logs[0].id).replyStatus, 'send_failed'); bot.close();
  parser.parse = async () => ({ title: '单图', media: [{ type: 'image', file: 'file:///test/1.jpg' }], cleanup() {} });
  const single = new Bot(store(), new Conversations(), parser), calls = [];
  single.onebot = async (action, params) => calls.push({ action, params });
  single.receive(event()); await wait(() => single.active === 0);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.action === 'send_group_msg'));
  assert.equal(calls[1].params.message[0].type, 'image'); single.close();
});

test('链接下载仅并发一个，其他用户的文字提问仍可执行；暂停后丢弃下载结果', async () => {
  const s = store(), bot = new Bot(s, new Conversations(), fakeParser()); let release, parsing = 0, sent = 0;
  bot.links.parse = async () => { parsing++; return new Promise(resolve => { release = () => resolve({ title: '视频', media: [], cleanup() {} }); }); };
  bot.onebot = async () => { sent++; }; bot.completion = async () => ({ text: '文字回答' });
  bot.receive(event()); bot.receive(event('https://youtu.be/another', { message_id: 2, user_id: 10004 }));
  bot.receive(event('', { message_id: 3, user_id: 10005, message: [{ type: 'at', data: { qq: '10001' } }, ...text('你好')] }));
  await wait(() => bot.stats.replied === 1); assert.equal(parsing, 1); assert.equal(bot.queue.length, 1);
  s.config.enabled = false; release(); await wait(() => bot.active === 0);
  assert.equal(sent, 1); assert.equal(parsing, 1); assert.equal(bot.stats.linksParsed, 0); bot.close();
});

test('NapCat 发送视频失败不误报成功，保留失败状态且不自动重发；配置校验限制下载资源', async () => {
  const s = store(), bot = new Bot(s, new Conversations(), fakeParser()); let calls = 0;
  bot.onebot = async () => { if (++calls === 2) throw new Error('视频上传失败'); };
  bot.receive(event()); await wait(() => bot.active === 0);
  assert.equal(calls, 2); assert.equal(bot.stats.linksParsed, 0); assert.equal(bot.stats.videosSent, 0);
  assert.equal(bot.stats.linksFailed, 1); assert.equal(bot.logDetail(bot.logs[0].id).replyStatus, 'send_failed'); bot.close();
  assert.equal(defaultConfig().linkMaxVideoMB, 400);
  assert.equal(validatePatch(defaultConfig(), { linkMaxVideoMB: 400 }).linkMaxVideoMB, 400);
  for (const patch of [{ linkMaxVideoMB: 401 }, { linkMaxVideoMB: 0 }, { linkMaxDuration: 0 }, { linkTimeoutSeconds: 601 }, { linkParsingEnabled: 'true' }, { linkCooldownSeconds: -1 }]) assert.throws(() => validatePatch(defaultConfig(), patch));
});

test('先发解析卡片再发图片聊天记录，卡片发送失败时退回纯文字', async () => {
  const parser = fakeParser();
  parser.parse = async () => ({ title: '图集', description: '简介', bytes: 20,
    media: [0, 1].map(index => ({ type: 'image', file: `file:///test/${index}.jpg` })), card: { file: 'file:///test/card.png' }, cleanup() {} });
  const bot = new Bot(store(), new Conversations(), parser), calls = [];
  bot.onebot = async (action, params) => calls.push({ action, params });
  bot.receive(event()); await wait(() => bot.active === 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].action, 'send_group_msg');
  assert.equal(calls[0].params.message[0].type, 'image');
  assert.equal(calls[0].params.message[0].data.file, 'file:///test/card.png');
  assert.equal(calls[1].action, 'send_group_forward_msg');
  assert.equal(calls[1].params.messages.length, 2);
  assert.ok(calls[1].params.messages.every(node => node.data.content[0].type === 'image'));
  assert.equal(bot.logDetail(bot.logs[0].id).card, true);
  bot.close();

  const failing = new Bot(store(), new Conversations(), parser), fallback = [];
  failing.onebot = async (action, params) => {
    if (action === 'send_group_msg' && params.message[0].type === 'image') throw new Error('卡片上传失败');
    fallback.push({ action, params });
  };
  failing.receive(event()); await wait(() => failing.active === 0);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].action, 'send_group_forward_msg');
  assert.equal(fallback[0].params.messages[0].data.content[0].type, 'text');
  assert.equal(failing.logDetail(failing.logs[0].id).card, false);
  failing.close();

  // 单张图片也要发独立原图，等原图上传完成后才能清理本地文件。
  const single = new Bot(store(), new Conversations(), parser), singleCalls = [];
  let finishOriginal, cleaned = 0;
  parser.parse = async () => ({ title: '单图', media: [{ type: 'image', file: 'file:///test/1.jpg' }], card: { file: 'file:///test/card.png' }, cleanup() { cleaned++; } });
  single.onebot = async (action, params, _config, timeout) => {
    singleCalls.push({ action, params, timeout });
    if (params.message[0].data.file === 'file:///test/1.jpg') await new Promise(resolve => { finishOriginal = resolve; });
  };
  single.receive(event()); await wait(() => singleCalls.length === 2);
  assert.ok(singleCalls.every(call => call.action === 'send_group_msg' && call.params.group_id === 10003 && call.timeout === 120));
  assert.deepEqual(singleCalls.map(call => call.params.message), [
    [{ type: 'image', data: { file: 'file:///test/card.png' } }],
    [{ type: 'image', data: { file: 'file:///test/1.jpg' } }]
  ]);
  assert.equal(cleaned, 0); assert.equal(single.stats.linksParsed, 0);
  finishOriginal(); await wait(() => single.active === 0);
  assert.equal(cleaned, 1); assert.equal(single.stats.linksParsed, 1);
  assert.equal(single.logDetail(single.logs[0].id).replyStatus, 'sent');
  single.close();
});

test('B 站动态桌面、手机、App 和 QQ 卡片统一识别，保留长动态 ID 并去重', () => {
  const id = '1260448476206989329', canonical = `https://t.bilibili.com/${id}`;
  const urls = [canonical, `https://www.bilibili.com/opus/${id}?plat_id=242&share_source=QQ`,
    `https://m.bilibili.com/dynamic/${id}?share_from=dynamic`, `https://m.bilibili.com/opus/${id}/`,
    `https://m.bilibili.com/dynamic?dynamic_id=${id}`];
  for (const url of urls) assert.equal(socialLink(url).url, canonical);
  assert.equal(extractSocialLinks(event(urls.join(' '))).length, 1);
  for (const value of [`bilibili://following/detail/${id}`, `bilibili://opus/${id}`,
    encodeURIComponent(`bilibili://dynamic/${id}`)]) assert.equal(extractSocialLinks(event(value))[0].url, canonical);
  const card = data => event('', { message: [{type:'json', data:{data:JSON.stringify(data)}}] });
  assert.equal(extractSocialLinks(card({meta:{detail_1:{qqdocurl:urls[1],preview:'https://example.test/cover.jpg'}}}))[0].url, canonical);
  assert.equal(extractSocialLinks(card({appid:'1109937557',path:`pages/dynamic/detail?dynamic_id=${id}`}))[0].url, canonical);
  assert.equal(extractSocialLinks(event(`https://t.bilibili.com.evil.test/${id}`)).length, 0);
});

test('无需 @ 的 B 站图文动态沿用白名单和多图合并发送，不调用模型', async () => {
  const parser = fakeParser(), bot = new Bot(store(), new Conversations(), parser), calls = [];
  parser.parse = async link => {
    assert.equal(link.url, 'https://t.bilibili.com/1260448476206989329');
    return {title:'动态正文',author:'动态作者',description:'图文详情',media:[1,2,3].map(i=>({type:'image',file:`file:///test/${i}.jpg`})),cleanup(){}};
  };
  bot.onebot = async (action, params) => calls.push({action,params});
  bot.request = async () => { throw new Error('动态不应调用模型'); };
  bot.receive(event('https://www.bilibili.com/opus/1260448476206989329?share_source=QQ'));
  await wait(() => !bot.active);
  assert.equal(calls.length,1); assert.equal(calls[0].action,'send_group_forward_msg');
  assert.equal(calls[0].params.messages.filter(node=>node.data.content.some(segment=>segment.type==='image')).length,3);
  assert.equal(bot.logs[0].deepseekCalled,false);
  bot.close();
});

test('解析器只交付实际本地文件，跨容器路径映射正确，清理缓存并拒绝越界与符号链接', async t => {
  const dir = fixture(t);
  let made;
  const parser = new LinkParser(dir, { napcatMediaDir: '/app/qqbot-media', worker: async input => {
    made = input.directory; writeFileSync(join(input.directory, 'video.mp4'), 'test-video');
    return { title: '标题', video: 'video.mp4' };
  } });
  const result = await parser.parse(socialLink('https://b23.tv/abcd'), store().config);
  assert.match(result.media[0].file, /^file:\/\/\/app\/qqbot-media\/[a-f0-9-]+\/video.mp4$/);
  assert.equal(result.bytes, 10); result.cleanup(); assert.equal(existsSync(made), false);
  // 卡片与图片尺寸随结果透传，卡片只接受固定文件名。
  parser.worker = async input => {
    writeFileSync(join(input.directory, 'image-0.jpg'), 'test-image');
    writeFileSync(join(input.directory, 'card.png'), 'test-card');
    return { title: '标题', images: ['image-0.jpg'], imageSizes: [[1080, 1440]], card: 'card.png' };
  };
  const withCard = await parser.parse(socialLink('https://b23.tv/abcd'), store().config);
  assert.match(withCard.card.file, /^file:\/\/\/app\/qqbot-media\/[a-f0-9-]+\/card\.png$/);
  assert.deepEqual(withCard.imageSizes, [[1080, 1440]]);
  withCard.cleanup();
  parser.worker = async input => { writeFileSync(join(input.directory, 'card.png'), 'x'); return { title: '标题', card: '../outside.png' }; };
  assert.equal((await parser.parse(socialLink('https://b23.tv/abcd'), store().config)).card, null);
  for (const worker of [async () => ({ video: '../outside.mp4' }), async input => {
    symlinkSync('/etc/hosts', join(input.directory, 'video.mp4')); return { video: 'video.mp4' };
  }]) {
    parser.worker = worker; await assert.rejects(parser.parse(socialLink('https://b23.tv/abcd'), store().config), /媒体文件/);
  }
  parser.close();
});

test('B 站动态官方读取使用独立任务并限制结果边界', async t => {
  const dir = fixture(t), calls = [];
  const parser = new LinkParser(dir, { worker: async input => { calls.push(input); return { items: [{ id: '998134289197432851' }] }; } });
  t.after(() => parser.close());
  const result = await parser.readBilibiliDynamics('12345', store().config);
  assert.equal(result.items.length, 1); assert.equal(calls[0].action, 'bilibili_feed'); assert.equal(calls[0].uid, '12345');
  parser.worker = async () => ({ items: [] });
  await assert.rejects(parser.readBilibiliDynamics('12345', store().config), /媒体文件/);
});

test('B 站音乐音轨使用登录态 API 并交付后端本地文件，完成后清理', async t => {
  const dir = fixture(t); let made, action;
  const parser = new LinkParser(dir, { napcatMediaDir: '/app/qqbot-media', worker: async input => {
    action = input.action; made = input.directory;
    writeFileSync(join(made, 'source.mp4'), 'audio'); return { file: 'source.mp4' };
  } });
  t.after(() => parser.close());
  const result = await parser.downloadBilibiliAudio({ url: 'https://www.bilibili.com/video/BV1bK411W797' }, store().config);
  assert.equal(action, 'bilibili_audio'); assert.equal(result.file, join(made, 'source.mp4'));
  result.cleanup(); assert.equal(existsSync(made), false);
  parser.worker = async () => ({ file: '../outside.mp4' });
  await assert.rejects(parser.downloadBilibiliAudio({ url: 'https://www.bilibili.com/video/BV1bK411W797' }, store().config), /媒体文件/);
});

test('解析器响应外部取消信号并清理本次下载目录', async t => {
  const dir = fixture(t), controller = new AbortController();
  let made, workerSignal, notify;
  const started = new Promise(resolve => { notify = resolve; });
  const parser = new LinkParser(dir, { worker: async (_input, options) => {
    made = _input.directory; workerSignal = options.signal; notify();
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('下载已取消')), { once: true }));
  } });
  t.after(() => parser.close());
  const pending = parser.parse(socialLink('https://b23.tv/abcd'), store().config, { signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(pending, /下载已取消/);
  assert.equal(workerSignal.aborted, true); assert.equal(existsSync(made), false);
});

test('图片与视频允许 400 MiB 边界，超额文件和超额图集失败并清理，保留较小配置限制', async t => {
  const dir = fixture(t), mib = 1024 * 1024;
  const parser = new LinkParser(dir); t.after(() => parser.close());
  let made;
  const prepare = files => {
    parser.worker = async input => {
      made = input.directory; assert.equal(input.maxBytes, store().config.linkMaxVideoMB * mib);
      for (const [name, bytes] of files) { const path = join(made, name); writeFileSync(path, 'x'); truncateSync(path, bytes); }
      return { title: '大小边界', ...(files[0][0] === 'video.mp4' ? { video: 'video.mp4' } : { images: files.map(([name]) => name) }) };
    };
  };
  for (const name of ['image-0.jpg', 'video.mp4']) {
    prepare([[name, 400 * mib]]);
    const result = await parser.parse(socialLink('https://b23.tv/abcd'), store().config);
    assert.equal(result.bytes, 400 * mib); result.cleanup(); assert.equal(existsSync(made), false);
    prepare([[name, 400 * mib + 1]]);
    await assert.rejects(parser.parse(socialLink('https://b23.tv/abcd'), store().config), /大小/);
    assert.equal(existsSync(made), false);
  }
  prepare([['image-0.jpg', 200 * mib], ['image-1.jpg', 200 * mib + 1]]);
  await assert.rejects(parser.parse(socialLink('https://b23.tv/abcd'), store().config), /大小/);
  assert.equal(existsSync(made), false);
  parser.worker = async input => {
    made = input.directory; assert.equal(input.maxBytes, 50 * mib);
    writeFileSync(join(made, 'image-0.jpg'), 'x'); truncateSync(join(made, 'image-0.jpg'), 50 * mib + 1);
    return { images: ['image-0.jpg'] };
  };
  await assert.rejects(parser.parse(socialLink('https://b23.tv/abcd'), { ...store().config, linkMaxVideoMB: 50 }), /大小/);
  assert.equal(existsSync(made), false);
});

test('X 代理可配置并仅传给 X 任务，拒绝远程 DNS、认证信息、路径和其他协议', async t => {
  const config = validatePatch(store().config, { linkTwitterProxyUrl: 'socks5://127.0.0.1:7890/' });
  assert.equal(config.linkTwitterProxyUrl, 'socks5://127.0.0.1:7890');
  for (const value of ['http://127.0.0.1:7890', 'socks5h://127.0.0.1:7890', 'socks5://user:password@host:1080',
    'socks5://host:1080/path', 'socks5://host:1080?token=secret', 'socks5://host:0', 'socks5://host', 'file:///etc/passwd']) {
    assert.throws(() => validatePatch(store().config, { linkTwitterProxyUrl: value }), /代理/);
  }
  const seen = [], parser = new LinkParser(fixture(t), { worker: async input => { seen.push(input); return { title: '推文' }; } });
  t.after(() => parser.close());
  for (const url of ['https://x.com/test/status/123', 'https://b23.tv/abcd']) {
    const result = await parser.parse(socialLink(url), config); result.cleanup();
  }
  assert.equal(seen[0].proxyUrl, config.linkTwitterProxyUrl); assert.equal(seen[1].proxyUrl, '');
});

test('子进程使用 JSON 输入，错误输出不会泄露 Cookie，超时可取消，不执行 shell', async t => {
  const dir = fixture(t), runner = join(dir, 'mock-worker');
  writeFileSync(runner, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end',()=>{console.error('PRIVATE_COOKIE');console.log(JSON.stringify({error:'login'}));process.exitCode=1;});`, { mode: 0o755 });
  await assert.rejects(runLinkWorker({ url: 'https://b23.tv/x; echo HACK' }, { python: runner, cwd: dir }), error => !error.message.includes('PRIVATE_COOKIE') && /Cookie/.test(error.message));
  writeFileSync(runner, `#!${process.execPath}\nprocess.stdin.resume();setInterval(()=>{},1000);`, { mode: 0o755 });
  await assert.rejects(runLinkWorker({}, { python: runner, timeout: 0.05, cwd: dir }), /超时/);
});

test('Python 网络防护和 HTML 元数据解析回归', () => {
  const path = fileURLToPath(new URL('./link-worker-test.py', import.meta.url));
  const result = spawnSync(process.env.LINK_PYTHON || 'python3', ['-B', path], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('未配置模型密钥时可独立解析链接，群聊和私聊模型请求保持静默', async t => {
  const state = store(); state.config.deepseekKey = ''; state.config.allowedPrivateUsers = ['10002'];
  const bot = new Bot(state); t.after(() => bot.close());
  bot.links = fakeParser(false); bot.completion = async () => assert.fail('must not call a model without its key');
  let sent = 0; bot.onebot = async () => { sent++; return {}; };
  assert.equal(bot.receive(event()).accepted, true); await wait(() => bot.active === 0);
  assert.equal(sent, 1); assert.equal(bot.status().linksParsed, 1);
  assert.equal(bot.receive(event('', { message_id: 2, message: [{ type: 'at', data: { qq: '10001' } }, ...text('你好')] })).ignored, 'model_not_configured');
  assert.equal(bot.receive(event('', { message_id: 3, message_type: 'private', group_id: undefined, message: text('你好') })).ignored, 'model_not_configured');
  assert.equal(bot.status().triggered, 0); assert.equal(bot.status().failed, 0);
});

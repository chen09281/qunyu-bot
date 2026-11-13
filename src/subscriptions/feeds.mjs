import { createHash } from 'node:crypto';
import { publicImageUrl } from '../images.mjs';
import { downloadFeedXml, downloadRsshubXml, downloadWebPage } from '../web-images.mjs';
import { gameInfo, normalizeGame } from './games.mjs';
import { rsshubRequest } from './rsshub.mjs';

let parser;
export const parserSetupMessage = '缺少订阅解析依赖，请在应用目录执行 npm ci，或重新构建 Docker 镜像';
async function getParser() {
  if (!parser) {
    try { const { default: Parser } = await import('rss-parser'); parser = new Parser({ customFields: { item: [
      ['media:content', 'mediaContent', { keepArray: true }], ['media:thumbnail', 'mediaThumbnails', { keepArray: true }],
      ['media:group', 'mediaGroup', { keepArray: true }],
    ] } }); }
    catch { throw Object.assign(new Error(parserSetupMessage), { code: 'RSS_PARSER_MISSING' }); }
  }
  return parser;
}
export const sourceTypes = { bilibili: 'B 站投稿与动态', douyin: '抖音作品', github: 'GitHub Release', rss: 'RSS / Atom', game: '游戏活动提醒' };
export function feedUrl(value) {
  const safe = publicImageUrl(value);
  if (!safe || safe.length > 2048 || new URL(safe).port && !['80', '443'].includes(new URL(safe).port)) {
    throw new Error('订阅地址需为公网 HTTP(S) 地址，端口仅支持 80 / 443，不可包含账号密码');
  }
  return safe;
}
export function rsshubBase(value) {
  const url = new URL(feedUrl(value));
  if (url.search || new URL(value).hash) throw new Error('RSSHub 地址不能包含查询参数或片段');
  return url.href.replace(/\/+$/, '');
}
export function normalizeSource(type, value) {
  if (!Object.hasOwn(sourceTypes, type) || typeof value !== 'string' || value.length > 2048) throw new Error('订阅类型或来源无效');
  value = value.trim();
  if (type === 'game') return normalizeGame(value);
  if (type === 'rss') return feedUrl(value);
  if (type === 'bilibili') {
    const match = /^(?:https:\/\/(?:space\.bilibili\.com\/|m\.bilibili\.com\/space\/))?([1-9]\d{0,19})(?:\/?(?:\?[^#\s]*)?)?$/.exec(value);
    if (!match) throw new Error('请填写 B 站 UP 主 UID 或 https://space.bilibili.com/UID');
    return match[1];
  }
  if (type === 'douyin') {
    if (value.startsWith('https://')) {
      const url = new URL(feedUrl(value));
      if (!['www.douyin.com', 'douyin.com', 'www.iesdouyin.com', 'iesdouyin.com'].includes(url.hostname)) throw new Error('请填写抖音博主主页链接');
      value = /^\/user\/([^/]+)\/?$/.exec(url.pathname)?.[1]
        || (/^\/share\/user\/\d+\/?$/.test(url.pathname) ? url.searchParams.get('sec_uid') : '') || '';
    }
    if (!/^MS4wLjABAAAA[A-Za-z0-9_-]{8,200}$/.test(value)) throw new Error('请填写 https://www.douyin.com/user/MS4wLjABAAAA… 博主主页，不是作品链接或抖音号');
    return value;
  }
  const match = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})(?:\/releases(?:\.atom)?)?\/?$/.exec(value);
  if (!match || ['.', '..'].includes(match[2])) throw new Error('请填写 GitHub owner/repo 或仓库网址');
  const repo = match[2].replace(/\.git$/, '');
  if (!repo || ['.', '..'].includes(repo)) throw new Error('GitHub 仓库名称无效');
  return `${match[1]}/${repo}`.toLowerCase();
}
export function sourceUrl(subscription, settings) {
  if (subscription.type === 'game') return gameInfo(normalizeGame(subscription.source)).website;
  if (subscription.type === 'github') return `https://github.com/${subscription.source}/releases.atom`;
  if (['bilibili', 'douyin'].includes(subscription.type)) return rsshubRequest({ ...settings, rsshubUrl: rsshubBase(settings.rsshubUrl) }, rsshubRoute(subscription)).url;
  return feedUrl(subscription.source);
}
function rsshubRoute(subscription) {
  const source = normalizeSource(subscription.type, subscription.source);
  return subscription.type === 'bilibili' ? `/bilibili/user/video/${source}` : `/douyin/user/${source}`;
}

// Only infer well-known profiles. Generic pages need an explicit RSS prefix.
export async function resolveSubscriptionSource(input, { signal, download = downloadWebPage } = {}) {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('订阅指令过长，请只发送一个主页链接');
  const game = /^\s*游戏\s+(.+?)\s*$/i.exec(input);
  if (game) return { type: 'game', source: normalizeGame(game[1]) };
  const explicit = /^\s*(B站|bilibili|抖音|douyin|GitHub|RSS|Atom)\s+([\s\S]+)$/i.exec(input);
  const type = explicit ? ({ 'b站': 'bilibili', bilibili: 'bilibili', '抖音': 'douyin', douyin: 'douyin', github: 'github', rss: 'rss', atom: 'rss' })[explicit[1].toLowerCase()] : '';
  let raw = (explicit?.[2] || input).trim();
  const urls = raw.match(/https?:\/\/[^\s<>「」【】"']+/g) || [];
  if (urls.length > 1) throw new Error('一次只能订阅一个来源，请分别发送主页链接');
  if (urls.length) raw = urls[0].replace(/[，。！!；;）)]+$/, '');
  if (type) return { type, source: normalizeSource(type, raw) };
  const infer = value => {
    const url = new URL(feedUrl(value));
    if (['space.bilibili.com', 'm.bilibili.com'].includes(url.hostname)) return { type: 'bilibili', source: normalizeSource('bilibili', url.href) };
    if (['www.douyin.com', 'douyin.com', 'www.iesdouyin.com', 'iesdouyin.com'].includes(url.hostname)) return { type: 'douyin', source: normalizeSource('douyin', url.href) };
    if (url.hostname === 'github.com') return { type: 'github', source: normalizeSource('github', url.origin + url.pathname) };
    if (/\.(?:xml|rss|atom)$|\/(?:feed|rss|atom)\/?$/i.test(url.pathname)) return { type: 'rss', source: url.href };
    throw new Error('请发送 B 站或抖音博主主页、GitHub 仓库；其他订阅源请用「/订阅 RSS 完整源地址」');
  };
  const url = new URL(feedUrl(raw));
  if (['v.douyin.com', 'b23.tv'].includes(url.hostname) && url.protocol === 'https:') {
    const page = await download(url.href, { signal, timeout: 15 });
    signal?.throwIfAborted();
    const result = infer(page.url);
    if (result.type !== (url.hostname === 'b23.tv' ? 'bilibili' : 'douyin')) throw new Error('分享链接没有跳转到对应博主主页，请复制浏览器中的完整主页地址');
    return result;
  }
  return infer(url.href);
}
export function plainText(value, limit = 600) {
  return String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g, s => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[s])
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
const unescapeUrl = value => String(value || '').replace(/&amp;/gi, '&').replace(/&#(?:x([\da-f]+)|(\d+));/gi,
  (all, hex, number) => { const code = parseInt(hex || number, hex ? 16 : 10); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; });
export function feedImages(item, base) {
  const candidates = [];
  for (const html of [item.content, item['content:encoded'], item.summary]) {
    for (const tag of String(html || '').matchAll(/<(?:img|video)\b[^>]{0,8192}>/gi)) {
      const attr = /\b(?:src|data-src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
      // Only video posters are images; never request a video source.
      const value = /^<video\b/i.test(tag[0]) ? /\bposter\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1] : attr?.slice(1).find(v => v !== undefined);
      if (value) candidates.push(value);
    }
  }
  const visit = (nodes, thumbnail = false) => {
    for (const node of Array.isArray(nodes) ? nodes : nodes ? [nodes] : []) {
      const attr = node?.$ || node;
      if (attr && (thumbnail || attr.medium === 'image' || /^image\//i.test(attr.type || ''))) candidates.push(attr.url);
      if (node?.['media:thumbnail']) visit(node['media:thumbnail'], true);
      if (node?.['media:content']) visit(node['media:content']);
    }
  };
  visit(item.mediaContent); visit(item.mediaThumbnails, true); visit(item.mediaGroup);
  if (/^image\//i.test(item.enclosure?.type || '')) candidates.push(item.enclosure.url);
  return [...new Set(candidates.flatMap(value => {
    try { const resolved = new URL(unescapeUrl(value), base);
      if (resolved.protocol === 'http:' && /(?:^|\.)hdslb\.com$/i.test(resolved.hostname)) resolved.protocol = 'https:';
      const url = publicImageUrl(resolved.href);
      return url && !/\.(?:mp4|m3u8|mp3|webm|mov)(?:$|[?#])/i.test(url) ? [url] : []; } catch { return []; }
  }))].slice(0, 9);
}
export async function parseFeed(xml, url) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 2 * 1024 * 1024) throw new Error('订阅源超过 2 MiB');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('订阅源含不支持的 XML 实体声明');
  const parser = await getParser();
  let parsed;
  try { parsed = await parser.parseString(xml); } catch { throw Object.assign(new Error('订阅源格式无效，需要 RSS 或 Atom XML'), { code: 'FEED_FORMAT' }); }
  if (!Array.isArray(parsed.items)) throw new Error('订阅源未返回条目列表');
  const items = new Map();
  for (const item of parsed.items.slice(0, 100)) {
    let link;
    try { link = feedUrl(new URL(item.link || '', url).href); } catch { continue; }
    if (!item.link) continue;
    const title = plainText(item.title, 300) || '未命名更新';
    const identity = String(item.guid || item.id || link).slice(0, 4096);
    const id = createHash('sha256').update(identity).digest('hex');
    const time = Date.parse(item.isoDate || item.pubDate || '');
    const html = String(item['content:encoded'] || item.content || item.summary || '');
    const ownVideo = !/转发自/.test(plainText(html, 12000)) && /视频地址[：:]\s*<a\b[^>]*href=["']?(https:\/\/www\.bilibili\.com\/video\/(?:BV[A-Za-z0-9]+|av\d+))/i.exec(html)?.[1];
    const live = new URL(link).hostname === 'live.bilibili.com' || /https:\/\/live\.bilibili\.com\//i.test(html);
    items.set(id, { id, title, link, summary: plainText(item.contentSnippet || item.content || item.summary), images: feedImages(item, link),
      author: plainText(item.creator || item.author, 100), avatar: publicImageUrl(parsed.image?.url || parsed.image || '') || '',
      ...(ownVideo ? { ownVideo } : {}), ...(live ? { contentKind: 'live' } : {}),
      publishedAt: Number.isFinite(time) ? new Date(time).toISOString() : '' });
  }
  if (parsed.items.length && !items.size) throw new Error('订阅源没有可用的公网文章链接');
  return { title: plainText(parsed.title, 120), items: [...items.values()] };
}
export async function readFeed(subscription, settings, { signal, download, readDouyin, readBilibili } = {}) {
  if (subscription.type === 'game') {
    const { readGameFeed } = await import('./game-feeds.mjs');
    return readGameFeed(subscription.source, settings, { signal });
  }
  await getParser();
  if (subscription.type === 'bilibili') {
    const source = normalizeSource('bilibili', subscription.source);
    const channels = ['video', 'dynamic'];
    const results = await Promise.allSettled(channels.map(async channel => {
      try {
        const request = rsshubRequest(settings, `/bilibili/user/${channel}/${source}`);
        const result = await (download || downloadRsshubXml)(request.url, { ...request, signal });
        const feed = await parseFeed(result.xml, result.url || request.url);
        return { ...feed, channels: [{ channel, transport: 'rsshub', ok: true, fallbackUsed: false }] };
      } catch (error) {
        if (channel !== 'dynamic' || !readBilibili) throw error;
        const feed = await readBilibili(source, { signal });
        return { ...feed, channels: [{ channel, transport: 'rsshub', ok: false, error: 'RSSHub 动态读取失败' },
          { channel, transport: 'official', ok: true, fallbackUsed: true }], fallbacks: ['bilibili-official-dynamic'] };
      }
    }));
    signal?.throwIfAborted();
    const successfulSources = [], warnings = [], combined = new Map(); let title = '';
    results.forEach((result, index) => {
      const channel = channels[index];
      if (result.status === 'rejected') { warnings.push(`B 站${index ? '动态' : '投稿'}暂时无法读取，请检查 RSSHub 对应路由；恢复后自动重试。`); return; }
      successfulSources.push(channel);
      title ||= result.value.title.replace(/的\s*bilibili\s*动态$/i, '的 bilibili 空间');
      for (const item of result.value.items) {
        // RSSHub video GUID is its canonical video URL. Reuse that identity for
        // automatic video dynamics, keeping legacy seen IDs and fallback stable.
        const id = channel === 'dynamic' && item.ownVideo ? createHash('sha256').update(item.ownVideo).digest('hex') : item.id;
        if (!combined.has(id)) combined.set(id, { ...item, id, channel,
          author: item.author || result.value.title.replace(/\s*的\s*bilibili\s*(?:空间|动态)$/i, ''),
          ...(item.ownVideo || channel === 'video' ? { contentKind: 'video' } : {}) });
      }
    });
    if (!successfulSources.length) throw results[0].reason;
    const channelHealth = results.filter(result => result.status === 'fulfilled').flatMap(result => result.value.channels || []);
    const fallbacks = results.filter(result => result.status === 'fulfilled').flatMap(result => result.value.fallbacks || []);
    for (const [index, result] of results.entries()) if (result.status === 'rejected') channelHealth.push({ channel: channels[index], transport: 'rsshub', ok: false, error: 'RSSHub 读取失败' });
    return { title, items: [...combined.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)), successfulSources, warnings, channels: channelHealth, fallbacks };
  }
  let douyinError;
  if (subscription.type === 'douyin' && readDouyin) {
    try { const feed = await readDouyin(subscription.source, { signal });
      return { ...feed, channels: [{ channel: 'douyin', transport: 'official', ok: true, fallbackUsed: false }], fallbacks: [] }; }
    catch (error) { signal?.throwIfAborted(); douyinError = error; }
  }
  const url = sourceUrl(subscription, settings);
  const hub = ['bilibili', 'douyin'].includes(subscription.type);
  const request = hub ? rsshubRequest(settings, rsshubRoute(subscription)) : { timeout: 25 };
  try {
    const result = await (download || (hub ? downloadRsshubXml : downloadFeedXml))(url, { ...request, ...(douyinError ? { timeout: 25 } : {}), signal });
    const feed = await parseFeed(result.xml, result.url || url);
    if (subscription.type === 'douyin' && !feed.items.length) throw Object.assign(new Error('抖音未返回作品'), { code: 'DOUYIN_EMPTY' });
    if (subscription.type === 'douyin') return { ...feed, channels: [...(douyinError ? [{ channel: 'douyin', transport: 'official', ok: false, error: '抖音官方读取失败' }] : []),
      { channel: 'douyin', transport: 'rsshub', ok: true, fallbackUsed: Boolean(douyinError) }], fallbacks: douyinError ? ['douyin-rsshub'] : [] };
    return feed;
  } catch (error) { throw douyinError?.code === 'DOUYIN_BROWSER_MISSING' ? error : douyinError || error; }
}

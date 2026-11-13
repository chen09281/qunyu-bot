import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { publicImageUrl } from './images.mjs';

export const maxReplyImages = 3;
const maxBytes = 6 * 1024 * 1024;
const imageWords = /图片|照片|相片|壁纸|立绘|原画|原图|头像|表情包|[找搜发贴]图/i;

export function webImagePlan(prompt, history = [], hasInputImages = false) {
  if (!/搜|找/.test(prompt) && /(?:识别|分析|解读|理解|生成|绘制).{0,15}(?:图片|照片)|画(?:一张|一个|张|个)/.test(prompt)) return { wanted: false, query: Array.from(prompt.trim()).slice(0, 128).join('') };
  if (/(?:不要|不用|无需|别).{0,6}(?:发|搜|找|贴|展示).{0,4}(?:图|照片)|只(?:要|发|用)文字/.test(prompt)) return { wanted: false, query: Array.from(prompt.trim()).slice(0, 128).join('') };
  const previous = [...history].reverse().find(item => item.role === 'user' && typeof item.content === 'string')?.content || '';
  const followup = prompt.length < 80 && /发(?:给我|到群里|出来|一下)|发图|给我看看|展示一下|贴出来|再来一张|那张图/.test(prompt);
  const explicit = /(?:找|搜|发|给|来|提供|展示|看看|看下|贴).{0,25}(?:图|照片|壁纸|立绘|原画|头像)|(?:图片|照片|壁纸|立绘|原画|原图|头像).{0,15}(?:发|找|搜|展示)|立绘|壁纸|原画|(?:图片|照片|原图|头像|表情包)[？?！!。\s]*$/.test(prompt);
  const wanted = (explicit || (followup && imageWords.test(previous))) && (!hasInputImages || /找|搜|另一|更多/.test(prompt));
  // Follow-up requests such as “发出来” need the subject from this user's own conversation.
  const contextual = wanted && previous && (followup || (prompt.length < 30 && /它|她|他|这|那|^(?:找图|搜图|发图)/.test(prompt)));
  const query = contextual ? `${Array.from(previous).slice(0, 85).join('')} ${Array.from(prompt).slice(0, 40).join('')}` : prompt;
  return { wanted, query: Array.from(query.trim()).slice(0, 128).join('') };
}

const decodeEntities = value => value.replace(/&amp;|&#38;|&#x26;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
const inCode = text => text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, '');
function resolvedImage(value, source) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try { return publicImageUrl(new URL(decodeEntities(value), source).href); } catch { return null; }
}
export function markdownImages(text) {
  const result = [];
  const plain = inCode(String(text || '').slice(0, 100000));
  // Keep balanced parentheses inside CDN filenames; support the common optional title form.
  const pattern = /!\[([^\]\n]{0,300})\]\(\s*(?:<([^>\n]+)>|([^\s()]+(?:\([^\s()]*\)[^\s()]*)*))(?:\s+["'][^\n]*?["'])?\s*\)/g;
  for (const match of plain.matchAll(pattern)) result.push({ alt: match[1], url: match[2] || match[3], markup: match[0] });
  const definitions = new Map([...plain.matchAll(/^\s*\[([^\]\n]+)\]:\s*<?(https?:\/\/[^\s>]+)>?/gm)].map(match => [match[1].toLowerCase(), match[2]]));
  for (const match of plain.matchAll(/!\[([^\]\n]*)\]\[([^\]\n]*)\]/g)) {
    const url = definitions.get((match[2] || match[1]).toLowerCase());
    if (url) result.push({ alt: match[1], url, markup: match[0] });
  }
  return result;
}
export function pageImages(content, source, title = '') {
  const text = String(content || '').slice(0, 1024 * 1024).replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  // A sidebar's recommended posts are not pictures belonging to the requested article.
  const article = text.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i)?.[1];
  const main = text.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1];
  const body = article || main || text, images = markdownImages(body);
  const tags = [...body.matchAll(/<img\b[^>]{0,8000}>/gi), ...text.matchAll(/<meta\b[^>]{0,3000}>/gi)];
  for (const match of tags) {
    const attrs = Object.fromEntries([...match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)].map(a => [a[1].toLowerCase(), a[2] ?? a[3] ?? a[4]]));
    const srcset = attrs['data-srcset'] || attrs.srcset;
    const largest = srcset?.split(',').map(item => item.trim().split(/\s+/)).sort((a, b) => (parseFloat(b[1]) || 0) - (parseFloat(a[1]) || 0))[0]?.[0];
    const url = /^<img/i.test(match[0]) ? attrs['data-original'] || attrs['data-src'] || attrs['data-lazy-src'] || largest || attrs.src
      : /^(?:og:image|twitter:image)(?::url)?$/i.test(attrs.property || attrs.name || '') ? attrs.content : '';
    if (url) images.push({ url, alt: attrs.alt || title });
  }
  return images.flatMap(image => {
    const url = resolvedImage(image.url, source);
    if (!url || /(?:^|[/_.-])(?:favicon|avatar|logo|icon|qrcode|loading|placeholder|spacer)(?:[/_.?@-]|$)|二维码|网站图标|加载占位/.test(`${url} ${image.alt}`)) return [];
    return [{ url, alt: decodeEntities(image.alt || title).slice(0, 200), source }];
  });
}

export async function collectWebImages(results, fetchPage, ensureAllowed = () => {}, fetchOriginalPage) {
  const candidates = [], seen = new Set();
  const add = images => {
    let count = 0;
    for (const image of images) {
      const identity = new URL(image.url);
      // NetEase exposes the same original in og:image and a transformed thumbnail in img.
      if (/^image(?:View|Mogr)/i.test(identity.searchParams.get('fop') || '')) identity.searchParams.delete('fop');
      const key = identity.href;
      if (!seen.has(key) && candidates.length < 18 && count < 6) {
        seen.add(key); candidates.push({ ...image, id: candidates.length + 1 }); count++;
      }
    }
  };
  for (const result of results) {
    if (/\.(?:png|jpe?g|webp|gif)(?:[?#]|$)/i.test(result.url)) add([{ url: result.url, alt: result.title, source: result.url }]);
    add(pageImages(result.content || result.summary, result.url, result.title));
  }
  // Inspect lower-ranked pages too: several top hits may be the same inaccessible forum.
  const uniquePages = [...new Map(results.filter(result => publicImageUrl(result.url)).map(result => {
    const url = new URL(result.url); url.hash = '';
    return [url.href, result];
  })).values()].slice(0, 8);
  const pages = [];
  const read = async result => {
    ensureAllowed();
    let page, original;
    try { page = await fetchPage(result.url); } catch (error) { if (error.cancelled) throw error; }
    ensureAllowed();
    const images = pageImages(page?.content, result.url, page?.title || result.title);
    // Markdown extraction can leave only a small avatar or preview; inspect the HTML as well.
    if (fetchOriginalPage) {
      try { original = await fetchOriginalPage(result.url); } catch (error) { if (error.cancelled) throw error; }
      ensureAllowed();
      images.unshift(...pageImages(original?.content, original?.url || result.url, result.title));
    }
    if (!page && !original) throw new Error('网页无法读取');
    return images;
  };
  // Keep request concurrency bounded, including when a site is slow or rate-limited.
  for (let offset = 0; offset < uniquePages.length; offset += 2) {
    ensureAllowed();
    pages.push(...await Promise.allSettled(uniquePages.slice(offset, offset + 2).map(read)));
  }
  ensureAllowed();
  for (const page of pages) if (page.status === 'fulfilled') add(page.value);
  return { candidates, fetched: pages.filter(page => page.status === 'fulfilled').length };
}

// Only images actually present in search/fetch results can become QQ image segments.
export function selectReplyImages(text, candidates = []) {
  const selected = [], byUrl = new Map(candidates.map(image => [image.url, image]));
  const add = image => { if (image && !selected.some(item => item.url === image.url) && selected.length < maxReplyImages) selected.push(image); };
  const clean = String(text || '').split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g).map((part, index) => {
    if (index % 2) return part;
    let body = part.replace(/\[\[QQ_IMAGE:(\d{1,3})\]\]/g, (_, id) => { add(candidates.find(image => image.id === Number(id))); return ''; });
    for (const image of markdownImages(body)) {
      add(byUrl.get(publicImageUrl(image.url)));
      body = body.replace(image.markup, '');
    }
    return body;
  }).join('');
  return { text: clean.trim(), images: selected };
}

export function rasterDimensions(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer.length >= 10 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < buffer.length) {
      if (buffer[offset++] !== 0xff) return null;
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const type = buffer.toString('ascii', 12, 16);
    if (type === 'VP8X') return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    if (type === 'VP8L' && buffer[20] === 0x2f) return { width: ((buffer[22] & 0x3f) << 8 | buffer[21]) + 1, height: ((buffer[24] & 0x0f) << 10 | buffer[23] << 2 | buffer[22] >> 6) + 1 };
    if (type === 'VP8 ' && buffer.toString('hex', 23, 26) === '9d012a') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

async function downloadPublicResource(value, { signal, timeout = 15, lookup = dnsLookup, limit = maxBytes, accept, referer,
  trustedUrl,
  request = (url, options, callback) => (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, callback) } = {}) {
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(new Error('图片下载已取消或超时'));
    if (combined.aborted) abort(); else combined.addEventListener('abort', abort, { once: true });
  });
  const load = async (value, redirects = 0) => {
    // Only the exact, server-configured RSSHub endpoint may use internal DNS.
    // Redirects lose this exception; an arbitrary feed/image URL never gets it.
    const trusted = value === trustedUrl;
    const safe = trusted ? value : publicImageUrl(value);
    if (!safe) throw new Error('图片地址不是公网 HTTP(S) 地址');
    const url = new URL(safe);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('下载地址无效');
    if (!trusted && url.port && !['80', '443'].includes(url.port)) throw new Error('图片地址端口不受支持');
    const addresses = await lookup(url.hostname, { all: true, family: 4 });
    if (!addresses.length || !trusted && addresses.some(item => !publicImageUrl(`http://${item.address}/`))) throw new Error('图片域名指向非公网地址');
    combined.throwIfAborted();
    const response = await new Promise((resolve, reject) => {
      const req = request(url, {
        method: 'GET', signal: combined, agent: false,
        headers: { Accept: accept, 'User-Agent': 'QunyuBot/1.1', 'Accept-Encoding': 'identity',
          ...(publicImageUrl(referer) ? { Referer: new URL(referer).origin + '/' } : {}) },
        // Pin the validated address for this connection, including each redirect; no DNS rebinding.
        lookup: (_host, options, callback) => options.all ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, 4)
      }, resolve);
      req.once('error', reject); req.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      if (redirects >= 3 || !response.headers.location) throw new Error('图片重定向过多');
      return load(new URL(response.headers.location, url).href, redirects + 1);
    }
    if (response.statusCode !== 200 || Number(response.headers['content-length']) > limit) {
      response.destroy(); throw Object.assign(new Error('响应状态或大小无效'),
        response.statusCode !== 200 ? { code: 'UPSTREAM_HTTP', statusCode: response.statusCode } : { code: 'RESPONSE_TOO_LARGE' });
    }
    const chunks = []; let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > limit) { response.destroy(); throw new Error('响应超过大小限制'); }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    return { buffer, url: url.href, headers: response.headers };
  };
  try { return await Promise.race([load(value), aborted]); }
  catch (error) { throw Object.assign(new Error(combined.aborted ? '下载已取消或超时' : '下载失败（链接失效或访问受限）'),
    { code: combined.aborted ? signal?.aborted ? 'CANCELLED' : 'ETIMEDOUT' : error.code || 'NETWORK_ERROR',
      ...(Number.isInteger(error.statusCode) ? { statusCode: error.statusCode } : {}) }); }
  finally { clearTimeout(timer); combined.removeEventListener('abort', abort); }
}

export async function downloadWebImage(value, options = {}) {
  const { buffer } = await downloadPublicResource(value, { ...options, trustedUrl: undefined, limit: maxBytes, accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9' });
  const size = rasterDimensions(buffer);
  if (!size || !size.width || !size.height || size.width * size.height > 40_000_000) throw new Error('链接未返回支持的图片文件或尺寸过大');
  return { file: `base64://${buffer.toString('base64')}`, bytes: buffer.length, ...size };
}

// Vision inputs retain the original bytes; the reply-image 6 MiB limit is unrelated.
export async function downloadVisionImage(value, options = {}) {
  const { buffer } = await downloadPublicResource(value, { ...options, trustedUrl: undefined, limit: 32 * 1024 * 1024,
    accept: 'image/png,image/jpeg,image/webp,image/gif;q=0.9' });
  const size = rasterDimensions(buffer);
  if (!size?.width || !size.height || size.width * size.height > 40_000_000) throw new Error('图片格式不受支持或超过 4000 万像素');
  return { buffer, ...size };
}

export async function downloadWebPage(value, options = {}) {
  const { buffer, url, headers } = await downloadPublicResource(value, { ...options, trustedUrl: undefined, limit: 1024 * 1024, accept: 'text/html,application/xhtml+xml;q=0.9' });
  if (headers['content-type'] && !/^(?:text\/html|application\/xhtml\+xml)/i.test(headers['content-type'])) throw new Error('网页不是 HTML');
  return { content: buffer.toString('utf8'), url };
}

// Subscription feeds use the same bounded, DNS-pinned public HTTP transport as images.
export async function downloadFeedXml(value, options = {}) {
  return readFeedXml(value, { ...options, trustedUrl: undefined });
}
// This entry point is used only with rsshubRequest's server-configured endpoint.
export async function downloadRsshubXml(value, options = {}) {
  return readFeedXml(value, options);
}
async function readFeedXml(value, options) {
  let result;
  try { result = await downloadPublicResource(value, { ...options, limit: 2 * 1024 * 1024,
    accept: 'application/atom+xml,application/rss+xml,application/xml,text/xml;q=0.9' }); }
  catch (error) { throw Object.assign(new Error('订阅源读取失败，请检查网络、源地址或 RSSHub 服务'), { code: error.code, statusCode: error.statusCode }); }
  if (/^(?:text\/html|application\/xhtml\+xml)/i.test(result.headers['content-type'] || '')) throw Object.assign(new Error('订阅源返回了网页，需要 RSS 或 Atom 地址'), { code: 'FEED_HTML' });
  return { xml: result.buffer.toString('utf8'), url: result.url };
}

export async function downloadPublicJson(value, options = {}) {
  const { buffer, url } = await downloadPublicResource(value, { ...options, trustedUrl: undefined, limit: 2 * 1024 * 1024, accept: 'application/json' });
  try { return { data: JSON.parse(buffer.toString('utf8')), url }; }
  catch { throw new Error('公告接口未返回有效 JSON'); }
}

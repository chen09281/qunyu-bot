import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DouyinBrowser, chromiumPath } from '../douyin-browser.mjs';
import { publicImageUrl } from '../images.mjs';
import { normalizeSource, plainText } from './feeds.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });
const images = values => [...new Set(values.map(value => publicImageUrl(value)).filter(Boolean))].slice(0, 9);
export function parseDouyinPosts(data, source) {
  source = normalizeSource('douyin', source);
  if (data?.status_code !== 0 || !Array.isArray(data.aweme_list)) throw failure('DOUYIN_VERIFY', '抖音主页要求登录或安全验证');
  const items = [], names = [];
  for (const row of data.aweme_list.slice(0, 100)) {
    // Never identify the creator from recommendations, reposts or an unrelated response.
    if (row?.author?.sec_uid !== source || !/^\d{10,30}$/.test(String(row.aweme_id || ''))) continue;
    const link = `https://www.douyin.com/${row.images?.length ? 'note' : 'video'}/${row.aweme_id}`;
    const summary = plainText(row.desc);
    const imageGroups = (row.images?.length
      ? row.images.map(image => [...(image?.url_list || []), ...(image?.display_image?.url_list || [])])
      : [[...(row.video?.cover?.url_list || []), ...(row.video?.dynamic_cover?.url_list || []), ...(row.video?.origin_cover?.url_list || [])]])
      .map(group => images([...group].reverse())).filter(group => group.length);
    const covers = imageGroups.map(group => group[0]);
    const time = Number(row.create_time) * 1000;
    names.push(plainText(row.author.nickname, 120));
    items.push({ id: createHash('sha256').update(`https://www.douyin.com/video/${row.aweme_id}`).digest('hex'),
      channel: 'douyin', contentKind: row.images?.length ? 'photo' : 'video', author: plainText(row.author.nickname, 100),
      avatar: images(row.author.avatar_thumb?.url_list || row.author.avatar_larger?.url_list || []).at(-1) || '',
      title: summary.slice(0, 300) || '新作品', summary, link,
      images: images(covers), imageGroups, publishedAt: Number.isFinite(time) && time > 0 && time < 8.64e15 ? new Date(time).toISOString() : '' });
  }
  if (data.aweme_list.length && !items.length) throw failure('DOUYIN_FORMAT', '抖音未返回该博主的有效作品');
  // An empty response must not establish a false baseline or cross-platform priority.
  if (!items.length) throw failure('DOUYIN_EMPTY', '抖音主页暂未返回作品，可能受访问限制');
  return { title: names.find(Boolean) || '', items: [...new Map(items.map(item => [item.id, item])).values()]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)) };
}

export async function readDouyinFeed(source, { signal, cookies, browserFactory = () => new DouyinBrowser(), available = () => Boolean(chromiumPath()), timeoutMs = 45000 } = {}) {
  source = normalizeSource('douyin', source);
  signal?.throwIfAborted();
  if (!available()) throw failure('DOUYIN_BROWSER_MISSING', '抖音订阅需要 Chromium');
  const browser = browserFactory(), timeout = AbortSignal.timeout(timeoutMs);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const stop = () => browser.close(); active.addEventListener('abort', stop, { once: true });
  try {
    await browser.start(cookies?.read('douyin') || '', { profile: source });
    while (!active.aborted) {
      if (browser.profileData) return parseDouyinPosts(browser.profileData, source);
      if (browser.closed) throw failure('DOUYIN_NETWORK', '抖音主页浏览器已停止');
      await delay(250, undefined, { signal: active });
    }
    active.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted) throw failure('DOUYIN_TIMEOUT', '抖音主页读取超时');
    if (error.code?.startsWith('DOUYIN_')) throw error;
    throw failure('DOUYIN_NETWORK', '抖音主页读取失败');
  } finally { active.removeEventListener('abort', stop); browser.close(); }
}

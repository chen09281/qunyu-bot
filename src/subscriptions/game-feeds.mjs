import { createHash } from 'node:crypto';
import { downloadRsshubXml, downloadPublicJson, downloadWebPage } from '../web-images.mjs';
import { parseFeed, plainText } from './feeds.mjs';
import { gameInfo, normalizeGame } from './games.mjs';
import { rsshubRequest } from './rsshub.mjs';

export const zzzNewsUrl = 'https://api-takumi-static.mihoyo.com/content_v2_user/app/706fd13a87294881/getContentList?iChanId=273&iPageSize=50&iPage=1&sLangKey=zh-cn';
export const wuwaNewsUrl = 'https://media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/zh/ArticleMenu.json';

export function gameKind(title, summary = '') {
  const heading = plainText(title, 300), body = plainText(summary, 12000), content = `${heading}\n${body}`;
  if (/封禁|违规处理|未成年人|防沉迷|概率公示|隐私政策/.test(heading)) return '';
  // Replays are not an upcoming-stream announcement. Keep this check on the title:
  // an announcement may say that a replay will be available afterwards.
  if (/录播|回放|回顾/.test(heading)) return '';
  if (/前瞻.{0,24}(?:直播|特别节目|通讯)|(?:特别|庆典)直播|版本.{0,24}特别节目/.test(content)) return 'livestream';
  if (/活动|版本|更新|维护|限时|寻访|调频|唤取|招募|签到|预下载|制作组通讯|研发通讯/.test(heading)) return 'activity';
  return '';
}

function isoTime(value) {
  if (typeof value === 'number') value *= 1000;
  else if (typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)) value = value.replace(' ', 'T') + '+08:00';
  const time = new Date(value || NaN).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}
function newsItem(game, rawId, title, summary, time) {
  if (!/^\d{1,20}$/.test(String(rawId)) || typeof title !== 'string' || !title.trim()) return null;
  const kind = gameKind(title, summary);
  if (!kind) return null;
  return { id: createHash('sha256').update(`${game.id}:official:${rawId}`).digest('hex'), channel: 'official', kind,
    title: plainText(title, 300), summary: plainText(summary), publishedAt: isoTime(time),
    link: `${game.website}${game.id === 'wuwa' ? '/detail' : ''}/${rawId}` };
}
const sorted = items => [...new Map(items.filter(Boolean).map(item => [item.id, item])).values()]
  .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));

// Hypergryph publishes the initial announcement list in Next Flight JSON. Decode
// only data frames; never run the page's JavaScript or use URLs from its scripts.
export function parseHypergryphNews(html, gameId) {
  const game = gameInfo(normalizeGame(gameId));
  if (typeof html !== 'string' || Buffer.byteLength(html) > 1024 * 1024) throw new Error('公告页面过大');
  let payload = '';
  for (const match of html.matchAll(/<script\b[^>]*>\s*self\.__next_f\.push\((.*?)\)\s*;?\s*<\/script>/gs)) {
    try { const frame = JSON.parse(match[1]); if (frame[0] === 1 && typeof frame[1] === 'string') payload += frame[1]; } catch { /* Not a data frame. */ }
  }
  const rows = [];
  for (const line of payload.split('\n')) {
    let root;
    try { root = JSON.parse(line.slice(line.indexOf(':') + 1)); } catch { continue; }
    const stack = [root];
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== 'object') continue;
      if (!Array.isArray(value) && typeof value.title === 'string' && value.cid != null && value.displayTime != null) rows.push(value);
      for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child);
    }
  }
  if (!rows.length) throw new Error('官方公告列表结构已变化');
  return sorted(rows.map(row => newsItem(game, row.cid, row.title, row.brief, row.displayTime)));
}
export function parseZzzNews(data) {
  if (data?.retcode !== 0 || !Array.isArray(data.data?.list)
    || data.data.list.length && !data.data.list.some(row => row?.iInfoId && typeof row.sTitle === 'string')) throw new Error('绝区零公告接口返回异常');
  const game = gameInfo('zzz');
  return sorted(data.data.list.slice(0, 100).filter(row => row && typeof row === 'object').map(row => newsItem(game, row.iInfoId, row.sTitle, row.sContent || row.sIntro, row.dtStartTime)));
}
export function parseWuwaNews(data) {
  if (!Array.isArray(data) || data.length && !data.some(row => row?.articleId && typeof row.articleTitle === 'string')) throw new Error('鸣潮公告列表结构已变化');
  const game = gameInfo('wuwa');
  // ArticleMenu contains only a truncated HTML prefix in articleContent. Do not
  // present that prefix as an article summary, and sort past pinned older posts.
  return sorted(data.slice(0, 1000).filter(row => row && typeof row === 'object').map(row => newsItem(game, row.articleId, row.articleTitle, row.articleDesc, row.startTime || row.createTime))).slice(0, 100);
}

export async function readGameFeed(source, settings, { signal, downloadPage = downloadWebPage, downloadJson = downloadPublicJson, downloadRss = downloadRsshubXml } = {}) {
  const game = gameInfo(normalizeGame(source));
  const official = async () => {
    if (game.id === 'zzz') return parseZzzNews((await downloadJson(zzzNewsUrl, { signal, timeout: 25 })).data);
    if (game.id === 'wuwa') return parseWuwaNews((await downloadJson(wuwaNewsUrl, { signal, timeout: 25 })).data);
    return parseHypergryphNews((await downloadPage(game.website, { signal, timeout: 25 })).content, game.id);
  };
  const dynamic = async () => {
    const request = rsshubRequest(settings, `/bilibili/user/dynamic/${game.bilibili}`);
    const { url } = request;
    const result = await downloadRss(url, { ...request, signal });
    const feed = await parseFeed(result.xml, result.url || url);
    // Only supplement livestream announcements here, so routine PVs, fan art
    // and generic version hashtags do not become activity notifications.
    return feed.items.filter(item => gameKind(item.title, item.summary) === 'livestream').map(item => ({ ...item,
      id: createHash('sha256').update(`${game.id}:bilibili:${item.id}`).digest('hex'), channel: 'bilibili', kind: 'livestream' }));
  };
  const results = await Promise.allSettled([official(), dynamic()]);
  signal?.throwIfAborted();
  const successfulSources = [], items = [], warnings = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') { successfulSources.push(index ? 'bilibili' : 'official'); items.push(...result.value); }
    else warnings.push(index ? '官方 B 站动态暂时无法读取，前瞻直播提醒可能不完整；请检查 RSSHub 的 B 站动态路由。' : '游戏官网公告暂时无法读取，活动更新提醒可能不完整；下次检查会重试。');
  });
  if (!successfulSources.length) throw new Error('游戏官网和官方动态均读取失败');
  return { title: `${game.name} · 活动与前瞻`, items: sorted(items), successfulSources, warnings };
}

import { createHash } from 'node:crypto';
import { publicImageUrl } from '../images.mjs';
import { normalizeSource, plainText } from './feeds.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });
const images = values => [...new Set(values.map(value => publicImageUrl(value)).filter(Boolean))].slice(0, 9);

export function parseBilibiliDynamics(data, source) {
  source = normalizeSource('bilibili', source);
  if (!Array.isArray(data?.items)) throw failure('BILIBILI_FORMAT', 'B 站动态接口格式无效');
  const items = [], names = [];
  for (const row of data.items.slice(0, 100)) {
    const id = String(row?.id || '');
    if (!/^\d{5,25}$/.test(id) || String(row.uploader_id || '') !== source) continue;
    const dynamicUrl = `https://t.bilibili.com/${id}`;
    const liveUrl = /^https:\/\/live\.bilibili\.com\/\d+(?:\?[^\s]*)?$/.test(String(row.live_url || '')) ? row.live_url : '';
    const ownVideo = row.own_video && /^https:\/\/www\.bilibili\.com\/video\/(?:BV[\da-zA-Z]{10}|av\d+)(?:\?p=\d+)?$/.test(String(row.video_url || '')) ? row.video_url : '';
    const time = Number(row.timestamp) * 1000;
    const author = plainText(row.uploader, 100);
    names.push(plainText(row.uploader, 120));
    const imageGroups = (row.image_groups || []).filter(Array.isArray).map(group => images(group)).filter(group => group.length);
    const thumbnail = images([row.thumbnail])[0];
    if (thumbnail && !imageGroups.some(group => group.includes(thumbnail))) imageGroups.unshift([thumbnail]);
    items.push({ id: createHash('sha256').update(dynamicUrl).digest('hex'), channel: 'dynamic',
      ...(liveUrl ? { contentKind: 'live' } : ownVideo ? { contentKind: 'video' } : {}),
      ...(ownVideo ? { ownVideo } : {}), author, avatar: images([row.avatar]).at(-1) || '',
      title: plainText(row.title, 300) || '新动态', summary: plainText(row.description), link: liveUrl || dynamicUrl,
      images: images(imageGroups.map(group => group[0])), imageGroups,
      publishedAt: Number.isFinite(time) && time > 0 && time < 8.64e15 ? new Date(time).toISOString() : '' });
  }
  if (!items.length) throw failure('BILIBILI_EMPTY', 'B 站动态暂未返回有效内容');
  return { title: names.find(Boolean) || '', items: [...new Map(items.map(item => [item.id, item])).values()]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)) };
}

export async function readBilibiliFeed(source, { signal, parser, config } = {}) {
  source = normalizeSource('bilibili', source);
  if (!parser?.readBilibiliDynamics) throw failure('BILIBILI_UNAVAILABLE', 'B 站动态官方读取通道不可用');
  const data = await parser.readBilibiliDynamics(source, config, { signal });
  return parseBilibiliDynamics(data, source);
}

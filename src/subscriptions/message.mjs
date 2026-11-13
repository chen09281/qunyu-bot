import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { downloadWebImage } from '../web-images.mjs';
import { publicImageUrl } from '../images.mjs';
import { plainText, sourceTypes } from './feeds.mjs';
import { gameKinds } from './games.mjs';
import { runLinkWorker } from '../social-links.mjs';

const withoutEllipsis = value => value.replace(/(?:\.{3}|…)+$/u, '').trim();
function uniqueBody(title, summary) {
  if (!summary) return title;
  if (!title) return summary;
  // RSSHub frequently uses the beginning of a dynamic as its truncated title.
  const shortTitle = withoutEllipsis(title), shortSummary = withoutEllipsis(summary);
  if (shortTitle && summary.startsWith(shortTitle)) return summary;
  if (shortSummary && title.startsWith(shortSummary)) return title;
  return `${title}\n${summary}`;
}
const excerpt = (text, limit) => text.length > limit ? text.slice(0, limit).trimEnd() + '…' : text;
function videoItem(entry, item) {
  if (entry.type === 'douyin') {
    if (item.contentKind === 'video') return true;
    try {
      const url = new URL(item.link || '');
      return ['douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'].includes(url.hostname)
        && /^\/(?:video|mobile\/video)\//.test(url.pathname);
    } catch { return false; }
  }
  return entry.type === 'bilibili' && (item.contentKind === 'video' || item.channel !== 'dynamic');
}
export function subscriptionContent(entry, item) {
  const time = Date.parse(item.publishedAt || '');
  const timestamp = Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
  const type = entry.type === 'game' ? gameKinds[item.kind] || sourceTypes.game : entry.type === 'bilibili' ? item.contentKind === 'live' ? '直播' : item.channel === 'dynamic' && item.contentKind !== 'video' ? 'B 站动态' : 'B 站投稿' : sourceTypes[entry.type];
  const sourceName = entry.lastTitle || entry.name;
  const name = plainText(entry.type === 'game' ? sourceName : item.author || sourceName, 100).replace(/\s*的\s*bilibili\s*(?:空间|动态)$/i, ''), title = plainText(item.title, 300), summary = plainText(item.summary);
  const body = uniqueBody(title, summary);
  const content = [`${name} · ${type}`,
    entry.type === 'game' ? `来源：${item.channel === 'bilibili' ? '官方 B 站动态' : '游戏官网公告'}` : '',
    timestamp ? `发布：${timestamp}（北京时间）` : '', excerpt(body, 360), item.link].filter(Boolean).join('\n\n');
  return { name, title, summary, body, type, timestamp, content };
}

export async function renderLinkStyleCard(entry, item, pictures, avatar, { signal, worker = runLinkWorker } = {}) {
  signal?.throwIfAborted();
  const directory = mkdtempSync(join(tmpdir(), 'qqbot-subscription-link-card-'));
  try {
    const data = subscriptionContent(entry, item), images = [];
    const isVideo = videoItem(entry, item);
    for (const picture of pictures.slice(0, 1)) {
      const name = `image-${images.length}.png`; writeFileSync(join(directory, name), Buffer.from(picture.file.slice(9), 'base64'), { mode: 0o600 }); images.push(name);
    }
    if (avatar) writeFileSync(join(directory, 'avatar.png'), Buffer.from(avatar.file.slice(9), 'base64'), { mode: 0o600 });
    const result = await worker({ action: 'subscription_card', directory, platform: entry.type,
      kind: isVideo ? 'video' : images.length ? 'photo' : 'text', images, avatar: avatar ? 'avatar.png' : '',
      title: data.title, description: data.body.replace(/https?:\/\/[^\s<>]+/g, '（链接见原文）'),
      author: data.name, published: [data.timestamp, data.type].filter(Boolean).join(' · ') }, { signal, timeout: 20, cwd: directory });
    signal?.throwIfAborted();
    const path = join(directory, 'card.png');
    if (result.card !== 'card.png' || statSync(path).size > 10 * 1024 * 1024) throw new Error('解析卡片无效');
    const bytes = readFileSync(path);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('解析卡片格式无效');
    return 'base64://' + bytes.toString('base64');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function subscriptionMessage(entry, item, { signal, downloadImage = downloadWebImage, renderCard = renderLinkStyleCard, downloadVideo, selfId, pendingGroups, cardOnly = false } = {}) {
  signal?.throwIfAborted();
  const { content, type } = subscriptionContent(entry, item), message = [];
  const safePicture = url => typeof url === 'string' && publicImageUrl(url)
    && !/\.(?:mp4|m3u8|webm|mov|mp3)(?:$|[?#])/i.test(url);
  const candidates = [...new Set((Array.isArray(item.images) ? item.images : []).filter(safePicture))].slice(0, 9);
  const variants = url => [...new Set([url, ...(Array.isArray(item.imageGroups) ? item.imageGroups.find(group => Array.isArray(group) && group.includes(url)) || [] : [])].filter(safePicture))].slice(0, 6);
  const isVideo = videoItem(entry, item), videoSupported = !cardOnly && isVideo && Boolean(downloadVideo);
  const confirmed = (group, key) => Boolean(item.sentParts?.[group]?.includes(key));
  const required = key => !pendingGroups || pendingGroups.some(group => !confirmed(group, key));
  const imageKey = url => 'image:' + createHash('sha256').update(url).digest('hex');
  const albumRequired = () => !pendingGroups || pendingGroups.some(group => !confirmed(group, 'images')
    && candidates.some(url => !confirmed(group, imageKey(url))));
  const mainRequired = required('main'), videoRequired = videoSupported && required('video');
  const originalsRequired = !cardOnly && !isVideo && (candidates.length > 1 ? albumRequired() : candidates.some(url => required(imageKey(url))));
  const picturesRequired = mainRequired || originalsRequired;
  // Each concurrent task owns its warning slot; combine only after all settle.
  const warnings = {};
  let cardFallback = false, avatar, video, videoCover, cleanup;
  const pictures = new Array(candidates.length); let cursor = 0;
  const videoTask = videoRequired ? (async () => {
    try {
      const parsed = await downloadVideo(item.ownVideo || item.link, { signal }), release = parsed.cleanup;
      try {
        signal?.throwIfAborted();
        video = parsed.media?.find(media => media.type === 'video' && typeof media.file === 'string' && media.file);
        if (!video) throw new Error('视频下载结果无效');
        cleanup = release;
        // The parser owns these files. Copy only its bounded local cover before cleanup.
        const cover = parsed.media?.find(media => media.type === 'image' && /^file:\/\//.test(media.localFile || media.file || ''));
        if (cover && mainRequired) {
          try {
            const path = fileURLToPath(cover.localFile || cover.file), size = statSync(path).size;
            if (size > 0 && size <= 6 * 1024 * 1024) videoCover = { file: 'base64://' + readFileSync(path).toString('base64') };
          } catch {}
        }
      } catch (error) { try { release?.(); } catch {} throw error; }
    } catch {
      if (!signal?.aborted) warnings.video = '视频暂时无法下载，已保留原文链接；视频会在后续检查重试。';
    }
  })() : null;
  const avatarTask = mainRequired && publicImageUrl(item.avatar) ? (async () => {
    try { avatar = await downloadImage(item.avatar, { signal, timeout: 4, referer: item.link });
      if (!/^base64:\/\/[A-Za-z0-9+/=]+$/.test(avatar.file || '')) avatar = undefined;
    } catch { avatar = undefined; }
  })() : null;
  const load = async () => {
    while (!signal?.aborted && cursor < candidates.length) {
      const index = cursor++, url = candidates[index];
      for (const candidate of variants(url)) {
        if (signal?.aborted) break;
        try {
          const picture = await downloadImage(candidate, { signal, timeout: 8, referer: item.link });
          if (!/^base64:\/\/[A-Za-z0-9+/=]+$/.test(picture.file || '')) throw new Error('图片格式无效');
          pictures[index] = picture; break;
        } catch {}
      }
    }
  };
  await Promise.all([...(picturesRequired ? [load(), load()] : []), ...(avatarTask ? [avatarTask] : [])]);
  const available = pictures.filter(Boolean), availableKeys = candidates.filter((_, index) => pictures[index]).map(imageKey);
  if (available.length !== candidates.length) {
    if (originalsRequired) warnings.images = '部分原图暂时无法读取，已保留原文链接；未发送的图片会在后续检查重试。';
    else if (mainRequired) warnings.images = '部分卡片配图暂时无法读取，将使用可用内容生成卡片。';
  }
  const cardTask = mainRequired && !signal?.aborted ? (async () => {
    try {
      let coverPictures = available;
      if (!coverPictures.length && videoTask) { await videoTask; if (videoCover) coverPictures = [videoCover]; }
      if (!coverPictures.length && !candidates.length && ['bilibili', 'douyin'].includes(entry.type)) warnings.images = '订阅源未提供配图，将生成文字卡片。';
      else if (coverPictures.length && videoCover && !available.length) warnings.images = '订阅配图暂不可用，已使用视频解析封面。';
      const file = await renderCard(entry, item, coverPictures.slice(0, 1), avatar, { signal });
      signal?.throwIfAborted();
      message.push({ type: 'image', data: { file } }, { type: 'text', data: { text: `\n${type} · 查看原文\n${item.link}` } });
    } catch (error) {
      if (signal?.aborted) return;
      message.push({ type: 'text', data: { text: content } });
      cardFallback = true;
      const stage = error.code === 'ENOENT' || error.code === 'LINK_WORKER_UNAVAILABLE' ? '渲染依赖不可用' : '渲染失败';
      warnings.card = `图文卡片生成失败（${stage}），已保留文字摘要与原文链接${!isVideo && candidates.length ? '及可用原图' : ''}；请检查 Pillow / 字体。`;
    }
  })() : null;
  await Promise.all([...(cardTask ? [cardTask] : []), ...(videoTask ? [videoTask] : [])]);
  if (signal?.aborted) { try { cleanup?.(); } catch {} signal.throwIfAborted(); }
  const parts = [{ key: 'main', ...(mainRequired ? { message } : {}) }];
  if (cardOnly) return { message, parts, cardFallback, warning: ['images', 'card'].map(kind => warnings[kind]).filter(Boolean).join('\n') };
  if (isVideo) {
    if (videoSupported) parts.push({ key: 'video', ...(videoRequired ? video ? { message: [{ type: 'video', data: { file: video.file } }] } : { unavailable: true } : {}) });
  } else if (candidates.length > 1) {
    if (originalsRequired) {
      let messages;
      if (available.length) {
        let id;
        if (signal) {
          let onAbort;
          const aborted = new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); });
          try { id = String(await Promise.race([Promise.resolve(selfId?.()), aborted]) || ''); }
          finally { signal.removeEventListener('abort', onAbort); }
        } else id = String(await selfId?.() || '');
        signal?.throwIfAborted();
        if (!/^\d{5,20}$/.test(id)) throw new Error('无法确认机器人 QQ 号');
        messages = available.map(picture => ({ type: 'node', data: { user_id: id, nickname: 'bot', content: [{ type: 'image', data: { file: picture.file } }] } }));
      }
      parts.push({ key: 'images', action: 'send_group_forward_msg', imageKeys: availableKeys, ...(messages ? { messages } : {}),
        ...(available.length !== candidates.length ? { unavailable: true } : {}) });
    } else parts.push({ key: 'images' });
  } else {
    parts.push(...candidates.map((url, index) => {
      const key = imageKey(url);
      if (!required(key)) return { key };
      return { key, ...(pictures[index] ? { message: [{ type: 'image', data: { file: pictures[index].file } }] } : { unavailable: true }) };
    }));
  }
  const warning = ['images', 'card', 'video'].map(kind => warnings[kind]).filter(Boolean).join('\n');
  return { message, warning, parts, cardFallback, ...(cleanup ? { cleanup } : {}) };
}

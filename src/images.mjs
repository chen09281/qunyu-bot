import { isIP } from 'node:net';

export const maxImages = 4;
export const imageOnlyPrompt = '请识别这些图片，说明主要内容，并读出其中的重要文字。';
export const replyOnlyPrompt = '请识别引用消息中的图片，说明主要内容，并读出其中的重要文字。';
const decodeCQ = text => text.replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');

// Parse segments before decoding, so literal escaped CQ text cannot become an image or @.
export function messageSegments(message) {
  if (Array.isArray(message)) return message.filter(segment => segment && typeof segment === 'object');
  if (typeof message !== 'string') return [];
  const segments = []; let offset = 0;
  for (const match of message.matchAll(/\[CQ:([^,\]]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index > offset) segments.push({ type: 'text', data: { text: decodeCQ(message.slice(offset, match.index)) } });
    const data = Object.fromEntries(match[2].slice(1).split(',').filter(Boolean).map(part => {
      const index = part.indexOf('=');
      return [part.slice(0, index), decodeCQ(part.slice(index + 1))];
    }));
    segments.push({ type: match[1], data }); offset = match.index + match[0].length;
  }
  if (offset < message.length) segments.push({ type: 'text', data: { text: decodeCQ(message.slice(offset)) } });
  return segments;
}

export function publicImageUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  let url; try { url = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // Only forward public image links. Never read NapCat's local paths or fetch URLs on this server.
  if (!host.includes('.') || host === 'localhost' || /\.(?:localhost|local|internal|lan)$/.test(host) || host.includes(':')) return null;
  if (isIP(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b))) return null;
  }
  url.hash = '';
  return url.href;
}

export function originalImageUrl(value) {
  const safe = publicImageUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  if (['gchat.qpic.cn', 'c2cpicdw.qpic.cn', 'multimedia.nt.qq.com.cn'].includes(url.hostname)) {
    if (url.pathname === '/download') url.searchParams.set('spec', '0');
    else if (/^\/(?:gchatpic_new|offpic_new)\//.test(url.pathname)) url.pathname = url.pathname.replace(/\/\d+$/, '/0');
  }
  return url.href;
}

export async function resolveMessageImages(event, config, onebot, prompt = '') {
  const segments = messageSegments(event.message);
  let images = segments.filter(segment => segment.type === 'image'), source = 'message';
  const reply = segments.find(segment => segment.type === 'reply');
  const ensureEnabled = () => { if (images.length && config.imageRecognitionEnabled === false) throw new Error('图片识别已关闭，请在「模型与回复」中开启'); };
  ensureEnabled();
  if (!images.length && reply) {
    const id = String(reply.data?.id ?? '');
    if (!/^-?\d{1,20}$/.test(id)) throw new Error('引用消息 ID 无效，请重新发送图片');
    let quoted;
    try { quoted = await onebot('get_msg', { message_id: id }, config); }
    catch { throw new Error('无法读取引用消息，请将图片与 @ 一起重新发送'); }
    if (event.message_type === 'private') {
      const sender = String(quoted?.sender?.user_id ?? '');
      const samePeer = sender === String(event.user_id) || sender === String(event.self_id) && String(quoted?.target_id ?? '') === String(event.user_id);
      if (quoted?.message_type !== 'private' || quoted?.group_id != null || !samePeer) {
        throw new Error('只能识别当前私聊中可确认归属的引用图片，请直接重发图片');
      }
    } else if (String(quoted?.group_id) !== String(event.group_id) || quoted?.message_type === 'private') {
      throw new Error('只能识别当前群内引用的图片');
    }
    images = messageSegments(quoted.message).filter(segment => segment.type === 'image'); source = 'reply';
    if (!images.length && prompt === replyOnlyPrompt) throw new Error('引用消息中没有图片，请将图片与 @ 一起发送');
  }
  ensureEnabled();
  if (images.length > maxImages) throw new Error(`每次最多识别 ${maxImages} 张图片，请减少图片后重试`);
  const urls = [];
  for (const image of images) {
    if (Number(image.data?.file_size) > 32 * 1024 * 1024) throw new Error('单张图片不能超过 32 MiB');
    let url = originalImageUrl(image.data?.url) || originalImageUrl(image.data?.file);
    if (typeof image.data?.file === 'string' && !['.', '..'].includes(image.data.file) && /^[A-Za-z0-9_.{}()-]{1,512}$/.test(image.data.file)) {
      let data;
      try { data = await onebot('get_image', { file: image.data.file }, config); }
      catch { if (!url) throw new Error('无法获取图片链接，请重新发送图片'); }
      if (Number(data?.file_size) > 32 * 1024 * 1024) throw new Error('单张图片不能超过 32 MiB');
      url = originalImageUrl(data?.url) || url;
    }
    if (!url) throw new Error('图片没有可供模型读取的公网链接，请重新发送图片');
    if (!urls.includes(url)) urls.push(url);
  }
  return { urls, source };
}

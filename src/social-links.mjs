import { spawn } from 'node:child_process';
import { mkdirSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { messageSegments } from './images.mjs';
import { LinkCookies } from './link-cookies.mjs';

export const maxLinkImages = 9;

export const socialPlatforms = [
  { id: 'bilibili', name: '哔哩哔哩', domains: ['bilibili.com', 'b23.tv'], video: true },
  { id: 'douyin', name: '抖音', domains: ['douyin.com', 'iesdouyin.com'], video: true },
  { id: 'kuaishou', name: '快手', domains: ['kuaishou.com', 'gifshow.com', 'chenzhongtech.com'], video: true },
  { id: 'xiaohongshu', name: '小红书', domains: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'], video: true },
  { id: 'weibo', name: '微博', domains: ['weibo.com', 'weibo.cn', 't.cn'], video: true },
  { id: 'youtube', name: 'YouTube', domains: ['youtube.com', 'youtu.be'], video: true },
  { id: 'tiktok', name: 'TikTok', domains: ['tiktok.com'], video: true },
  { id: 'twitter', name: 'X / Twitter', domains: ['x.com', 'twitter.com', 't.co'], video: true },
  { id: 'instagram', name: 'Instagram', domains: ['instagram.com'], video: true },
  { id: 'facebook', name: 'Facebook', domains: ['facebook.com', 'fb.watch'], video: true },
  { id: 'reddit', name: 'Reddit', domains: ['reddit.com', 'redd.it'], video: true },
  { id: 'acfun', name: 'AcFun', domains: ['acfun.cn'], video: true },
  { id: 'zhihu', name: '知乎', domains: ['zhihu.com'], video: false },
  { id: 'tieba', name: '百度贴吧', domains: ['tieba.baidu.com'], video: false },
  { id: 'wechat', name: '微信公众号', domains: ['mp.weixin.qq.com'], video: false }
];
export function socialLink(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20]/.test(value)) return null;
  let url; try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const platform = socialPlatforms.find(p => p.domains.some(domain => host === domain || host.endsWith(`.${domain}`)));
  if (!platform || !url.pathname.replaceAll('/', '')) return null;
  if (platform.id === 'bilibili' && (host === 'bilibili.com' || host.endsWith('.bilibili.com'))) {
    const dynamicId = (host === 't.bilibili.com' ? url.pathname.match(/^\/(\d{5,25})\/?$/)?.[1] : '')
      || url.pathname.match(/^\/(?:opus|dynamic)\/(\d{5,25})\/?$/)?.[1]
      || (/^\/(?:opus|dynamic)\/?$/.test(url.pathname) ? url.searchParams.get('dynamic_id') || url.searchParams.get('id') : '');
    if (/^\d{5,25}$/.test(dynamicId)) return { url: `https://t.bilibili.com/${dynamicId}`, platform: platform.id, name: platform.name };
    const id = url.pathname.match(/^\/(?:video|mobile\/video)\/(BV[\da-zA-Z]{10}|av\d+)(?:\/|$)/i)?.[1]
      || url.searchParams.get('bvid') || (url.searchParams.get('aid') ? `av${url.searchParams.get('aid')}` : '');
    if (/^(?:BV[\da-zA-Z]{10}|av\d+)$/i.test(id)) {
      const page = url.searchParams.get('p');
      url = new URL(`https://www.bilibili.com/video/${/^bv/i.test(id) ? `BV${id.slice(2)}` : id.toLowerCase()}`);
      if (/^[1-9]\d{0,3}$/.test(page)) url.searchParams.set('p', page);
    }
  }
  url.hash = '';
  // Tracking parameters are not part of the identity; retain access/signature tokens needed by XHS etc.
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|spm|share_source|share_medium|share_from|vd_source)/i.test(key)) url.searchParams.delete(key);
  return { url: url.href, platform: platform.id, name: platform.name };
}
export function extractSocialLinks(event) {
  const links = new Map();
  const scan = (text, depth = 0) => {
    if (typeof text !== 'string' || text.length > 20000 || depth > 3 || links.size >= 3) return;
    text = text.replaceAll('\\/', '/').replace(/&amp;|&#38;|&#x26;/gi, '&').replace(/&quot;/g, '"');
    if (/^[\w+.-]+:\/\//.test(text)) {
      try {
        const wrapper = new URL(text);
        if (!socialLink(text)) for (const key of ['url', 'target', 'jumpUrl', 'qqdocurl']) scan(wrapper.searchParams.get(key), depth + 1);
      } catch {}
    }
    for (const match of text.matchAll(/(?:https?:\/\/|bilibili:\/\/(?:video|opus|dynamic|following\/detail)\/)[^\s<>"'\\\u3000-\u303f\uff00-\uffef]+/gi)) {
      let value = match[0].replace(/[)\]}>.,!?;:]+$/, '');
      const dynamicId = value.match(/^bilibili:\/\/(?:opus|dynamic|following\/detail)\/(\d{5,25})(?:[/?#]|$)/i)?.[1];
      if (dynamicId) value = `https://t.bilibili.com/${dynamicId}`;
      const appId = value.match(/^bilibili:\/\/video\/(BV[\da-zA-Z]{10}|(?:av)?\d+)(?:[/?#]|$)/i)?.[1];
      if (appId) value = `https://www.bilibili.com/video/${/^\d+$/.test(appId) ? `av${appId}` : appId}`;
      const link = socialLink(value);
      if (link) links.set(link.url, link);
      else {
        // Unwrap encoded destinations locally; never fetch QQ launchers or execute card scripts.
        try {
          const wrapper = new URL(value);
          for (const key of ['url', 'target', 'jumpUrl', 'qqdocurl']) scan(wrapper.searchParams.get(key), depth + 1);
        } catch {}
      }
      if (links.size >= 3) return;
    }
    if (!/^https?:\/\//i.test(text) && /(?:https?|bilibili)%(?:25){0,2}3a/i.test(text)) {
      try { scan(decodeURIComponent(text), depth + 1); } catch {}
    }
  };
  const walk = (value, depth = 0, bilibili = false) => {
    if (depth > 8 || links.size >= 3) return;
    if (typeof value === 'string') { scan(value); return; }
    if (!value || typeof value !== 'object') return;
    const before = links.size;
    for (const [key, destination] of Object.entries(value)) {
      if (/^(qqdocurl|jumpurl|url)$/i.test(key)) walk(destination, depth + 1);
      if (links.size > before) return;
    }
    bilibili ||= String(value.appid) === '1109937557';
    if (bilibili) {
      const id = value.bvid || (/^\d+$/.test(String(value.aid || '')) ? `av${value.aid}` : '');
      if (/^(?:BV[\da-zA-Z]{10}|av\d+)$/i.test(id)) scan(`https://www.bilibili.com/video/${id}`);
      for (const key of ['path', 'page', 'pagePath']) {
        if (typeof value[key] === 'string' && value[key].length < 4096) {
          try {
            const path = new URL(value[key], 'https://www.bilibili.com/');
            if (path.searchParams.has('bvid') || path.searchParams.has('aid')) scan(path.href);
            const dynamicId = path.searchParams.get('dynamic_id') || (/dynamic|opus/i.test(path.pathname) ? path.searchParams.get('id') : '');
            if (/^\d{5,25}$/.test(dynamicId)) scan(`https://t.bilibili.com/${dynamicId}`);
            else if (/^\/(?:opus|dynamic)\/\d{5,25}\/?$/.test(path.pathname)) scan(path.href);
          } catch {}
        }
      }
    }
    // Preview images and application icons are not share destinations.
    for (const key of Object.keys(value)) if (!/^(preview|icon|avatar|cover|qqdocurl|jumpurl|url)$/i.test(key)) walk(value[key], depth + 1, bilibili);
  };
  let segments = messageSegments(event.message);
  if (!segments.length) segments = messageSegments(event.raw_message);
  for (const segment of segments) {
    if (segment.type === 'text') scan(segment.data?.text);
    if (['json', 'xml'].includes(segment.type)) {
      const data = segment.data?.data;
      if (typeof data !== 'string' || data.length > 20000) continue;
      if (segment.type === 'xml') scan(data);
      else { try { walk(JSON.parse(data)); } catch {} }
    }
    if (links.size >= 3) break;
  }
  return [...links.values()];
}

export function bilibiliVideoLinks(prompt) {
  const links = extractSocialLinks({ message: prompt }).filter(link => link.platform === 'bilibili'
    && (new URL(link.url).hostname.endsWith('b23.tv') || /\/video\/(?:BV[\da-zA-Z]{10}|av\d+)/.test(new URL(link.url).pathname)));
  for (const match of prompt.matchAll(/(?<![\w/])BV[\da-zA-Z]{10}(?!\w)/g)) {
    const link = socialLink(`https://www.bilibili.com/video/${match[0]}`);
    if (!links.some(item => new URL(item.url).pathname === new URL(link.url).pathname)) links.push(link);
  }
  return links.slice(0, 2);
}

const failures = {
  dependencies: '链接解析依赖未安装，请重建 Docker 镜像或安装 requirements-parser.txt 和 ffmpeg',
  blocked: '链接指向非公网地址，已拒绝解析',
  login: '平台要求登录或触发风控，可配置该平台的 Cookie 后重试',
  upstream_empty: '抖音暂未返回这条作品的数据，请稍后重试；已有登录态已保留',
  size: '视频或图片超过配置的大小限制', duration: '视频超过配置的时长限制，或属于直播',
  unsupported: '暂时无法解析该链接，可能需要登录或平台规则已变化',
  unavailable: '推文不存在、不可公开访问或返回内容与链接不一致', proxy: 'X / Twitter 代理地址无效，请填写 SOCKS5 地址',
  network: '解析平台无法连接或链接已失效', timeout: '链接解析或下载超时',
  format: '平台未提供可下载的视频格式', processing: '视频音轨合并或转码失败，请检查媒体依赖及大小限制',
  cancelled: '链接解析已取消', output: '解析器未生成有效媒体文件',
  video_disabled: '该群未开启视频解析，且链接没有可展示的图文内容'
};
const workerPath = fileURLToPath(new URL('./link-worker.py', import.meta.url));
export function runLinkWorker(input, { signal, timeout = 180, python = process.env.LINK_PYTHON || 'python3', cwd } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, ['-I', workerPath], { cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8',
      ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {})
    } });
    let output = '', size = 0, failure, timer, killTimer;
    const kill = signal => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
    const stop = code => { failure ||= code; kill('SIGTERM'); killTimer ||= setTimeout(() => kill('SIGKILL'), 1000); killTimer.unref(); };
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => stop('timeout'), timeout * 1000); timer.unref();
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 256 * 1024) stop('output'); else output += chunk.toString(); });
    child.stderr.on('data', () => {}); // Upstream output can contain signed URLs or Cookie values.
    child.stdin.on('error', () => {});
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.once('error', () => { cleanup(); reject(new Error(failures.dependencies)); });
    child.once('close', code => {
      cleanup();
      if (failure) return reject(new Error(failures[failure]));
      let result; try { result = JSON.parse(output); } catch { return reject(new Error(failures.output)); }
      if (code !== 0 || result.error) return reject(new Error(failures[result.error] || failures.unsupported));
      resolvePromise(result);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export class LinkParser {
  constructor(dataDir, options = {}) {
    this.mediaDir = resolve(dataDir, 'media'); this.cookieDir = resolve(dataDir, 'link-cookies');
    this.cookies = new LinkCookies(this.cookieDir, socialPlatforms);
    this.cookieTaskDir = resolve(dataDir, 'link-cookie-jobs');
    mkdirSync(this.cookieTaskDir, { recursive: true, mode: 0o700 });
    if (lstatSync(this.cookieTaskDir).isSymbolicLink()) throw new Error('临时登录态目录不能是符号链接');
    for (const name of readdirSync(this.cookieTaskDir)) {
      if (/^[a-f0-9-]{36}\.txt$/.test(name) && lstatSync(join(this.cookieTaskDir, name)).mtimeMs < Date.now() - 3600000) rmSync(join(this.cookieTaskDir, name), { force: true });
    }
    this.napcatMediaDir = options.napcatMediaDir ?? process.env.NAPCAT_MEDIA_DIR ?? '';
    this.worker = options.worker || runLinkWorker; this.controllers = new Set();
    mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });
    if (lstatSync(this.mediaDir).isSymbolicLink()) throw new Error('媒体缓存目录不能是符号链接');
    for (const name of readdirSync(this.mediaDir)) {
      if (/^[a-f0-9-]{36}$/.test(name) && lstatSync(join(this.mediaDir, name)).mtimeMs < Date.now() - 3600000) rmSync(join(this.mediaDir, name), { recursive: true, force: true });
    }
  }
  async status() {
    const platforms = socialPlatforms.map(({ id, name, video }) => ({ id, name, video, ...this.cookies.info(id) }));
    try {
      const status = await this.worker({ action: 'status' }, { timeout: 8 });
      return { ...status, platforms };
    } catch (error) { return { available: false, detail: error.message, platforms }; }
  }
  async analyzeBilibili(link, config, { allowVideo = true, maxSheets = 3 } = {}) {
    const canonical = socialLink(link.url);
    if (canonical?.platform !== 'bilibili') throw new Error(failures.unsupported);
    const id = randomUUID(), dir = join(this.mediaDir, id), controller = new AbortController();
    const cookieSnapshot = join(this.cookieTaskDir, `${id}.txt`);
    mkdirSync(dir, { mode: 0o700 }); this.controllers.add(controller);
    try {
      const cookieFile = this.cookies.snapshot('bilibili', cookieSnapshot);
      const result = await this.worker({ action: 'analyze_bilibili', url: canonical.url, directory: dir, cookieFile,
        allowVideo, maxSheets: Math.max(0, Math.min(3, maxSheets)), maxBytes: config.linkMaxVideoMB * 1024 * 1024,
        maxDuration: config.linkMaxDuration }, { signal: controller.signal, timeout: config.linkTimeoutSeconds, cwd: dir });
      if (!Array.isArray(result.sheets) || result.sheets.length > Math.min(3, maxSheets)
        || (!allowVideo && result.sheets.length)) throw new Error(failures.output);
      const images = result.sheets.map((name, index) => {
        if (name !== `analysis-${index}.jpg`) throw new Error(failures.output);
        const path = join(dir, name), info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > 2 * 1024 * 1024) throw new Error(failures.output);
        const bytes = readFileSync(path);
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error(failures.output);
        return `data:image/jpeg;base64,${bytes.toString('base64')}`;
      });
      const { sheets, ...evidence } = result;
      return { evidence, images };
    } finally {
      this.controllers.delete(controller);
      rmSync(dir, { recursive: true, force: true });
      rmSync(cookieSnapshot, { force: true });
    }
  }
  async readBilibiliDynamics(uid, config, options = {}) {
    if (!/^[1-9]\d{0,19}$/.test(String(uid))) throw new Error(failures.unsupported);
    options.signal?.throwIfAborted();
    const id = randomUUID(), controller = new AbortController(), abort = () => controller.abort();
    const cookieSnapshot = join(this.cookieTaskDir, `${id}.txt`);
    this.controllers.add(controller); options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const cookieFile = this.cookies.snapshot('bilibili', cookieSnapshot);
      const result = await this.worker({ action: 'bilibili_feed', uid: String(uid), cookieFile },
        { signal: controller.signal, timeout: config.linkTimeoutSeconds });
      if (!Array.isArray(result.items) || !result.items.length || result.items.length > 100) throw new Error(failures.output);
      options.signal?.throwIfAborted();
      return result;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      this.controllers.delete(controller); try { rmSync(cookieSnapshot, { force: true }); } catch {}
    }
  }
  async downloadBilibiliAudio(link, config, options = {}) {
    if (socialLink(link.url)?.platform !== 'bilibili') throw new Error(failures.unsupported);
    options.signal?.throwIfAborted();
    const id = randomUUID(), dir = join(this.mediaDir, id), controller = new AbortController();
    const abort = () => controller.abort();
    const cookieSnapshot = join(this.cookieTaskDir, `${id}.txt`);
    mkdirSync(dir, { mode: 0o700 }); this.controllers.add(controller);
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };
    try {
      const cookieFile = this.cookies.snapshot('bilibili', cookieSnapshot);
      const result = await this.worker({ action: 'bilibili_audio', url: link.url, directory: dir,
        maxBytes: config.linkMaxVideoMB * 1024 * 1024, maxDuration: config.linkMaxDuration,
        cookieFile }, { signal: controller.signal, timeout: config.linkTimeoutSeconds, cwd: dir });
      if (result.file !== 'source.mp4') throw new Error(failures.output);
      const file = join(dir, result.file), info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > config.linkMaxVideoMB * 1024 * 1024) throw new Error(failures.output);
      options.signal?.throwIfAborted();
      return { file, cleanup };
    } catch (error) { cleanup(); throw error; }
    finally {
      options.signal?.removeEventListener('abort', abort);
      this.controllers.delete(controller); try { rmSync(cookieSnapshot, { force: true }); } catch {}
    }
  }
  async parse(link, config, options = {}) {
    if (!socialLink(link.url)) throw new Error(failures.unsupported);
    options.signal?.throwIfAborted();
    const allowVideo = options.allowVideo !== false;
    const id = randomUUID(), dir = join(this.mediaDir, id), controller = new AbortController();
    const abort = () => controller.abort();
    const cookieSnapshot = join(this.cookieTaskDir, `${id}.txt`);
    mkdirSync(dir, { mode: 0o700 }); this.controllers.add(controller);
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };
    try {
      const cookieFile = this.cookies.snapshot(link.platform, cookieSnapshot);
      const result = await this.worker({ action: 'parse', url: link.url, platform: link.platform, video: socialPlatforms.find(p => p.id === link.platform)?.video,
        allowVideo, directory: dir, maxBytes: config.linkMaxVideoMB * 1024 * 1024, maxDuration: config.linkMaxDuration,
        proxyUrl: link.platform === 'twitter' ? config.linkTwitterProxyUrl || '' : '',
        cookieFile }, { signal: controller.signal, timeout: config.linkTimeoutSeconds, cwd: dir });
      if (Array.isArray(result.images) && result.images.length > maxLinkImages) throw new Error(failures.output);
      const files = [...(result.video ? [result.video] : []), ...(Array.isArray(result.images) ? result.images : [])];
      let total = 0;
      const media = files.map(name => {
        if (typeof name !== 'string' || !/^(?:video\.mp4|image-\d+\.(?:jpg|png|webp))$/.test(name)) throw new Error(failures.output);
        const path = join(dir, name), info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error(failures.output);
        total += info.size;
        if (total > config.linkMaxVideoMB * 1024 * 1024) throw new Error(failures.size);
        return { type: name.startsWith('video') ? 'video' : 'image', ...(options.includeLocalFiles ? { localFile: pathToFileURL(path).href } : {}), file: pathToFileURL(this.napcatMediaDir ? join(this.napcatMediaDir, id, name) : path).href, bytes: info.size };
      });
      const title = String(result.title || '').slice(0, 200), description = String(result.description || '').slice(0, 1000), author = String(result.author || '').slice(0, 100);
      if (!title && !description && !media.length) throw new Error(allowVideo ? failures.unsupported : failures.video_disabled);
      // 卡片由本地渲染，只接受固定文件名，避免把任意路径交给 NapCat。
      let card = null;
      if (result.card === 'card.png') {
        const path = join(dir, 'card.png'), info = lstatSync(path);
        if (info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 10 * 1024 * 1024) {
          card = { file: pathToFileURL(this.napcatMediaDir ? join(this.napcatMediaDir, id, 'card.png') : path).href, bytes: info.size };
        }
      }
      const imageSizes = Array.isArray(result.imageSizes) ? result.imageSizes.slice(0, maxLinkImages) : [];
      options.signal?.throwIfAborted();
      return { title, description, author, media, bytes: total, card, imageSizes, cleanup };
    } catch (error) { cleanup(); throw error; }
    finally {
      options.signal?.removeEventListener('abort', abort);
      this.controllers.delete(controller); try { rmSync(cookieSnapshot, { force: true }); } catch {}
    }
  }
  cancel() { for (const controller of this.controllers) controller.abort(); }
  close() { this.cancel(); }
}

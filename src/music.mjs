import { mkdtempSync, mkdirSync, readFileSync, rmSync, lstatSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { atomicWriteJson, quarantineCorruptFile } from './security.mjs';

import { musicTracks, musicArtists, musicCatalog, musicRequest as matchMusicRequest, normalizeMusic as normalize, fullMusicRequested } from './music-catalog.mjs';
export { musicCatalog, musicRequest } from './music-catalog.mjs';
export function musicCatalogText() { return `飞行雪绒相关歌曲：\n${musicCatalog.map((title, index) => `${index + 1}. ${title}`).join('\n')}\n\n@机器人“播放／演奏／来一首 歌曲名”点歌；“播放飞行雪绒的歌”随机选曲。默认播放约 30 秒高潮片段，未标注高潮时播放试听片段；说“播放完整版 歌曲名”可请求整首。优先本地音源，没有本地音源时尝试在线音源。`; }
const fail = text => new Error(text);
const safeTrackPath = (tracksDir, title, ext) => {
  if (typeof title !== 'string' || !title || /[\/\\\x00]/.test(title) || title === '.' || title === '..' || title.includes('..')) return null;
  const target = resolve(tracksDir, `${title}.${ext}`);
  return target.startsWith(`${resolve(tracksDir)}${sep}`) ? target : null;
};
const appleUrl = value => { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password || u.port || !/(?:^|\.)(?:itunes\.apple\.com|mzstatic\.com)$/i.test(u.hostname)) throw fail('音乐预览地址无效'); return u.href; };
export class MusicService {
  constructor(dataDir, { fetchImpl = fetch, convert, napcatMediaDir = process.env.NAPCAT_MEDIA_DIR || '', linkParser = null, linkConfig = null } = {}) {
    this.mediaDir = resolve(dataDir, 'media'); this.dir = join(this.mediaDir, 'music'); this.tracksDir = resolve(dataDir, 'music', 'tracks');
    this.fetch = fetchImpl; this.convert = convert || this.ffmpeg; this.napcatMediaDir = napcatMediaDir; this.linkParser = linkParser; this.linkConfig = linkConfig || { linkMaxVideoMB: 50, linkMaxDuration: 600, linkTimeoutSeconds: 120 };
    this.controllers = new Set(); this.closed = false; this.catalog = null; this.catalogAt = 0; this.lastChecks = new Map(); this.checking = false;
    this.segmentsPath = resolve(dataDir, 'music', 'segments.json');
    this.catalogPath = resolve(dataDir, 'music', 'catalog.json'); this.customTracks = [];
    try {
      const saved = JSON.parse(readFileSync(this.catalogPath, 'utf8'));
      if (saved?.version !== 1 || !Array.isArray(saved.tracks)) throw fail('format_invalid');
      this.customTracks = saved.tracks;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const backup = quarantineCorruptFile(this.catalogPath);
        console.error(`[music] 自定义音乐目录损坏，已隔离至 ${backup || this.catalogPath}: ${error.message}`);
        this.customTracks = [];
      }
    }
    for (const dir of [this.mediaDir, this.dir, resolve(dataDir, 'music'), this.tracksDir]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); if (lstatSync(dir).isSymbolicLink()) throw fail('音乐目录不能是符号链接'); }
  }
  allTracks() { return [...musicTracks, ...this.customTracks]; }
  saveCustom() {
    atomicWriteJson(this.catalogPath, { version: 1, tracks: this.customTracks });
  }
  async search(term, { signal } = {}) {
    term = String(term || '').trim();
    if (!term || term.length > 100) throw fail('请输入 1–100 字的歌曲或歌手名称');
    const rows = await this.lookup(term, signal || new AbortController().signal, 20);
    return rows.filter(track => track.previewUrl).map(track => ({ title: String(track.trackName || '').slice(0, 100), artistName: String(track.artistName || '未知歌手').slice(0, 100), previewUrl: track.previewUrl, aliases: [] }));
  }
  addTrack(input) {
    const title = String(input?.title || '').trim(), artistName = String(input?.artistName || '未知歌手').trim();
    if (!title || title.length > 100 || artistName.length > 100 || /[\/\\\x00]/.test(title) || title.includes('..')) throw fail('歌曲名或歌手格式无效');
    if (this.allTracks().some(track => normalize(track.title) === normalize(title))) throw fail('歌曲已在点播目录中');
    const track = { title, artistName, artistId: 'custom', aliases: [], previewUrl: appleUrl(input.previewUrl) };
    this.customTracks.push(track); this.saveCustom(); return track;
  }
  removeTrack(title) {
    const before = this.customTracks.length;
    this.customTracks = this.customTracks.filter(track => normalize(track.title) !== normalize(title));
    if (this.customTracks.length === before) throw fail('该歌曲不是自定义目录条目');
    this.saveCustom();
  }
  request(prompt) {
    const base = matchMusicRequest(prompt);
    if (base) return base;
    const text = normalize(prompt);
    if (!/播放|演奏|点播|放一下|放一首|放首|放个|来一首|来首|听一下|听听|想听|我要听|听一首|唱一首|唱首|唱一下|唱唱|放/.test(text)) return null;
    const found = this.customTracks.find(track => [track.title, ...track.aliases].some(name => text.includes(normalize(name))));
    return found && !/(?:不要|别|不想|停止|取消|不用|不需要)(?:再|继续)?(?:播放|演奏|点播|放|来|听|唱)/.test(text) ? { type: 'song', title: found.title, ...(fullMusicRequested(prompt) ? { full: true } : {}) } : null;
  }
  catalogText() {
    const custom = this.customTracks.length ? `\n\n自定义歌曲：\n${this.customTracks.map((track, index) => `${index + 1}. ${track.title}`).join('\n')}` : '';
    return musicCatalogText() + custom;
  }
  async download(url, signal, limit = 12 * 1024 * 1024) {
    const active = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
    for (let redirects = 0; redirects < 4; redirects++) {
      const response = await this.fetch(appleUrl(url), { signal: active, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); url = new URL(response.headers.get('location'), url).href; continue; }
      if (!response.ok) { await response.body?.cancel(); throw fail('音乐服务暂时不可用'); }
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw fail('音乐预览超过大小限制'); }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try { while (true) { active.throwIfAborted(); const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw fail('音乐预览超过大小限制'); chunks.push(Buffer.from(value)); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return Buffer.concat(chunks);
    }
    throw fail('音乐预览重定向过多');
  }
  async downloadSource(url, signal) {
    if (!this.linkParser?.downloadBilibiliAudio) throw fail('歌曲没有可用的在线音源');
    const source = await this.linkParser.downloadBilibiliAudio({ url }, this.linkConfig, { signal });
    return { input: source.file, cleanup: source.cleanup };
  }
  async ffmpeg(input, output, signal, { start = 0, duration = 30 } = {}) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-ss', String(start), '-i', input, '-vn', '-codec:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', ...(duration === null ? [] : ['-t', String(duration)]), output], { stdio: 'ignore' });
      const stop = () => { child.kill('SIGKILL'); reject(fail('音频转换已取消')); };
      const timer = setTimeout(stop, 60000); signal.addEventListener('abort', stop, { once: true });
      child.once('error', () => reject(fail('音频转换不可用，请检查 ffmpeg')));
      child.once('close', code => { clearTimeout(timer); signal.removeEventListener('abort', stop); code === 0 ? resolve() : reject(fail('音频转换失败')); });
      if (signal.aborted) stop();
    });
  }
  segment(title) {
    try {
      if (lstatSync(this.segmentsPath).isSymbolicLink()) throw fail('音乐高潮配置不能是符号链接');
      const saved = JSON.parse(readFileSync(this.segmentsPath, 'utf8'));
      const value = saved[title];
      if (value === undefined) return null;
      const start = value.start, duration = value.duration ?? 30;
      if (!Number.isFinite(start) || start < 0 || start > 3600 || !Number.isFinite(duration) || duration < 5 || duration > 60) throw fail('音乐高潮配置无效');
      return { start, duration };
    } catch (error) { if (error.code === 'ENOENT') return null; throw fail('音乐高潮配置无效，请检查 segments.json'); }
  }
  async prepare(title, { signal, full = false } = {}) {
    if (this.closed || !this.allTracks().some(track => track.title === title)) throw fail('歌曲不在点播目录内');
    const controller = new AbortController(); this.controllers.add(controller);
    const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let directory, sourceCleanup;
    const cleanup = () => { if (directory) rmSync(directory, { recursive: true, force: true }); try { sourceCleanup?.(); } catch {} };
    try {
      active.throwIfAborted();
      let input, preview = false, local, displayTitle = title;
      const requested = this.allTracks().find(track => track.title === title);
      const wanted = this.allTracks().find(track => track.title === requested.onlineTitle) || requested;
      const segment = full ? null : this.segment(title) || (wanted.title !== title ? this.segment(wanted.title) : null);
      for (const ext of ['mp3', 'm4a', 'wav', 'flac', 'ogg']) {
        const file = safeTrackPath(this.tracksDir, title, ext);
        if (!file) continue;
        try { const st = lstatSync(file); if (st.isSymbolicLink() || !st.isFile() || st.size > 80 * 1024 * 1024) throw fail('本地音源无效'); local = file; break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      directory = mkdtempSync(join(this.dir, 'voice-'));
      if (local) { input = local; preview = false; }
      else {
        const track = (full || segment) && wanted.sourceUrl ? wanted : await this.findTrack(title, active);
        if (title === '星轨消逝之夜') displayTitle = '小小奇迹（星轨消逝之夜）';
        if (track?.previewUrl) { input = join(directory, 'preview.m4a'); preview = true; }
        else if (track?.sourceUrl) {
          const source = await this.downloadSource(track.sourceUrl, active); input = source.input; sourceCleanup = source.cleanup;
        } else throw fail(`暂未找到《${title}》的在线音源，请管理员检查音乐插件或添加本地音源`);
        if (track?.previewUrl) writeFileSync(input, await this.download(appleUrl(track.previewUrl), active), { mode: 0o600 });
      }
      const output = join(directory, 'voice.m4a');
      const mode = full && !preview ? 'full' : !preview && segment ? 'chorus' : 'preview';
      const clip = mode === 'full' ? { start: 0, duration: null } : mode === 'chorus' ? segment : { start: 0, duration: 30 };
      await this.convert(input, output, active, clip);
      active.throwIfAborted();
      this.lastChecks.set(title, { state: 'ready', checkedAt: new Date().toISOString(), error: '' });
      return { title: displayTitle, preview, mode, notice: full && preview ? '当前仅有试听音源，暂无法播放完整版。' : mode === 'preview' && !preview ? '暂未标注高潮位置，先播放试听片段。' : '', file: pathToFileURL(this.napcatMediaDir ? join(this.napcatMediaDir, relative(this.mediaDir, output)) : output).href, cleanup };
    } catch (error) { cleanup(); if (!active.aborted) this.lastChecks.set(title, { state: 'failed', checkedAt: new Date().toISOString(), error: /^暂未找到|本地音源|音乐|歌曲|音频/.test(error.message) ? error.message : '歌曲读取失败' }); if (active.aborted) throw Object.assign(fail('歌曲点播已取消'), { cancelled: true }); throw fail(/^暂未找到|本地音源|音乐|歌曲|音频/.test(error.message) ? error.message : '歌曲读取失败，请稍后重试'); }
    finally { this.controllers.delete(controller); }
  }
  matches(title, rows) {
    const requested = this.allTracks().find(t => t.title === title), wanted = this.allTracks().find(t => t.title === requested?.onlineTitle) || requested;
    return [wanted.title, ...wanted.aliases].flatMap(name => rows.filter(item => normalize(item.trackName) === normalize(name)
      && (requested?.artistId === 'custom' || /飞行雪绒|fleet[ -]?snowfluff|鸣潮先约电台/i.test(`${item.artistName || ''} ${item.collectionArtistName || ''}`))))[0];
  }
  async lookup(term, signal, limit = 200) {
    const query = new URLSearchParams({ term, media: 'music', entity: 'song', limit: String(limit), country: 'us' });
    const data = JSON.parse((await this.download(`https://itunes.apple.com/search?${query}`, signal, 1024 * 1024)).toString('utf8'));
    if (!Array.isArray(data.results)) throw fail('音乐目录格式无效');
    return data.results;
  }
  async findTrack(title, signal) {
    if (!this.catalog || Date.now() - this.catalogAt > (this.catalog.length ? 3600000 : 60000)) {
      this.catalog = await this.lookup('飞行雪绒', signal); this.catalogAt = Date.now();
    }
    let track = this.matches(title, this.catalog);
    const requested = this.allTracks().find(t => t.title === title), wanted = this.allTracks().find(t => t.title === requested?.onlineTitle) || requested;
    if (!track?.previewUrl && !wanted.sourceUrl) {
      // Artist search results can be incomplete. Resolve each missing track by
      // its own title, retaining exact title and artist checks (no instrumental).
      const rows = await this.lookup(`${wanted.aliases.find(a => /[a-z]/i.test(a)) || wanted.title} Fleet Snowfluff`, signal, 20);
      track = this.matches(title, rows);
      if (track?.previewUrl) this.catalog.push(track);
    }
    return track || (wanted.sourceUrl && this.linkParser ? wanted : undefined);
  }
  status() {
    const withStatus = track => {
      let local = false;
      for (const ext of ['mp3', 'm4a', 'wav', 'flac', 'ogg']) {
        const file = safeTrackPath(this.tracksDir, track.title, ext);
        if (!file) continue;
        try { const f = lstatSync(file); if (f.isFile() && !f.isSymbolicLink() && f.size <= 80 * 1024 * 1024) local = true; } catch {}
      }
      return { ...track, local, online: Boolean(this.catalog && (this.matches(track.title, this.catalog)?.previewUrl || track.sourceUrl)), lastCheck: this.lastChecks.get(track.title) || null };
    };
    const custom = this.customTracks.length ? [{ id: 'custom', name: '自定义歌曲', aliases: ['Music Search'], tracks: this.customTracks.map(withStatus) }] : [];
    return { checking: this.checking, artists: [...musicArtists.map(artist => ({ ...artist, tracks: musicTracks.filter(t => t.artistId === artist.id).map(withStatus) })), ...custom] };
  }
  async checkSources() {
    if (this.checking) throw Object.assign(fail('音源检测正在进行，请稍候'), { status: 409 });
    this.checking = true; const controller = new AbortController(); this.controllers.add(controller); const timer = setTimeout(() => controller.abort(), 90000);
    try {
      this.catalog = null;
      for (const title of this.allTracks().map(track => track.title)) {
        try { const track = await this.findTrack(title, controller.signal); this.lastChecks.set(title, { state: track?.previewUrl || track?.sourceUrl ? 'matched' : 'missing', checkedAt: new Date().toISOString(), error: track?.previewUrl || track?.sourceUrl ? '' : '未匹配到在线音源，可添加本地文件' }); }
        catch { if (controller.signal.aborted) throw fail('音源检测已取消'); this.lastChecks.set(title, { state: 'failed', checkedAt: new Date().toISOString(), error: '音源读取失败，请稍后重试' }); }
      }
      return this.status();
    } finally { clearTimeout(timer); this.controllers.delete(controller); this.checking = false; }
  }
  close() { this.closed = true; for (const controller of this.controllers) controller.abort(); }
}

import { readFileSync, writeFileSync, renameSync, lstatSync, unlinkSync, constants, openSync, closeSync, fstatSync, fsyncSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, createPublicKey, publicEncrypt, randomUUID, constants as cryptoConstants } from 'node:crypto';
import { normalizeCookies } from './link-cookies.mjs';

const passport = 'https://passport.bilibili.com/x/passport-login/web/';
const interval = 6 * 3600000, retryDelay = 3600000;
const hash = text => createHash('sha256').update(text).digest('hex');
const platform = { domains: ['bilibili.com'] };
const tokenValid = value => typeof value === 'string' && /^[\w-]{16,4096}$/.test(value);
const labels = { unconfigured: '未登录', imported: '手动导入', valid: '登录有效', needs_scan: '需要扫码登录',
  expired: '登录已失效', refreshed: '已自动续期', confirm_pending: '续期待确认', error: '检查失败' };
// Bilibili Web refresh protocol's public RSA key; no private key is used or stored.
const key = createPublicKey({ key: { kty: 'RSA', e: 'AQAB',
  n: 'y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE' }, format: 'jwk' });
export const correspondPath = timestamp => publicEncrypt({ key, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
  oaepHash: 'sha256' }, Buffer.from(`refresh_${timestamp}`)).toString('hex');

function records(text) {
  return text.split('\n').filter(line => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_'))).map(line => {
    const [domain, subdomains, path, secure, expires, name, value] = line.split('\t');
    return { domain: domain.replace(/^#HttpOnly_/, ''), subdomains, path, secure, expires: Number(expires), name, value };
  });
}
function cookieHeader(text, url) {
  const target = new URL(url), selected = new Map();
  for (const item of records(text).sort((a, b) => a.path.length - b.path.length)) {
    const domain = item.domain.replace(/^\./, '');
    if ((target.hostname === domain || (item.subdomains === 'TRUE' && target.hostname.endsWith('.' + domain)))
      && target.pathname.startsWith(item.path) && (!item.expires || item.expires * 1000 > Date.now())) selected.set(item.name, item.value);
  }
  return [...selected].map(([name, value]) => `${name}=${value}`).join('; ');
}
function csrf(text) { return /(?:^|; )bili_jct=([^;]*)/.exec(cookieHeader(text, passport))?.[1] || ''; }
function applyCookies(text, lines, url) {
  const values = new Map(records(text).map(item => [`${item.domain.replace(/^\./, '')}:${item.path}:${item.name}`, item]));
  for (const line of lines) {
    const [pair, ...attributes] = line.split(';'), at = pair.indexOf('=');
    if (at < 1) continue;
    const name = pair.slice(0, at).trim(), value = pair.slice(at + 1).trim();
    const attrs = Object.fromEntries(attributes.map(part => { const [key, ...rest] = part.trim().split('='); return [key.toLowerCase(), rest.join('=')]; }));
    const domain = (attrs.domain || new URL(url).hostname).replace(/^\./, '').toLowerCase();
    if (domain !== 'bilibili.com' && !domain.endsWith('.bilibili.com')) continue;
    const expires = attrs['max-age'] !== undefined ? Math.floor(Date.now() / 1000) + Number(attrs['max-age']) : attrs.expires ? Math.floor(Date.parse(attrs.expires) / 1000) : 0;
    if (!Number.isFinite(expires)) continue;
    const item = { domain: '.' + domain, subdomains: 'TRUE', path: attrs.path || '/', secure: 'TRUE', expires: Math.max(0, expires), name, value };
    const id = `${domain}:${item.path}:${name}`;
    if (expires && expires * 1000 <= Date.now()) values.delete(id); else values.set(id, item);
  }
  return normalizeCookies('# Netscape HTTP Cookie File\n' + [...values.values()].map(item =>
    [item.domain, item.subdomains, item.path, item.secure, item.expires, item.name, item.value].join('\t')).join('\n') + '\n', platform).text;
}
function privateRead(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > 256 * 1024) throw new Error('登录数据文件无效');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function privateWrite(file, data) {
  try { if (lstatSync(file).isSymbolicLink()) throw new Error('登录数据文件无效'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(data) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const directory = openSync(dirname(file), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

export class BilibiliSession {
  constructor(dataDir, cookies, { request = fetch, now = Date.now, onUpdate = () => {}, log = () => {} } = {}) {
    this.file = join(dataDir, 'bilibili-session.json'); this.cookies = cookies;
    this.request = request; this.now = now; this.onUpdate = onUpdate; this.log = log;
    this.version = 0; this.closed = false; this.busy = false; this.controllers = new Set();
    this.data = privateRead(this.file) || { autoRefresh: true, state: cookies.info('bilibili').configured ? 'imported' : 'unconfigured' };
    // Recover a crash between the authoritative credential write and the parser Cookie projection.
    const current = cookies.read('bilibili');
    if (this.data.cookieContent !== undefined && hash(current) === this.data.previousHash) this.project();
    else if (this.data.cookieContent !== undefined && hash(current) !== hash(this.data.cookieContent)) this.importCookie(current);
  }
  project() {
    if (this.data.cookieContent) this.cookies.save('bilibili', this.data.cookieContent);
    else this.cookies.clear('bilibili');
  }
  save(patch) { const next = { ...this.data, ...patch }; privateWrite(this.file, next); this.data = next; }
  commit(cookieContent, refreshToken, patch = {}) {
    this.save({ cookieContent, refreshToken, previousHash: hash(this.cookies.read('bilibili')), ...patch });
    this.project(); this.onUpdate();
  }
  importCookie(content) {
    const normalized = content ? normalizeCookies(content, platform) : { text: '', count: 0, ignored: 0 };
    this.version++; this.qr = null;
    this.commit(normalized.text, '', { pendingConfirm: '', state: normalized.text ? 'imported' : 'unconfigured',
      detail: normalized.text ? '已导入 Cookie；扫码登录后可保存刷新令牌并自动续期。' : '请使用哔哩哔哩 App 扫码登录。', nextCheckAt: null, lastCheckedAt: null, lastRefreshedAt: null });
    this.schedule(); return { ...this.cookies.info('bilibili'), count: normalized.count, ignored: normalized.ignored };
  }
  status() {
    const state = this.data.state || 'unconfigured';
    return { state, label: labels[state] || '状态未知', detail: this.data.detail || '', autoRefresh: this.data.autoRefresh !== false,
      refreshCapable: Boolean(this.data.refreshToken), lastCheckedAt: this.data.lastCheckedAt || null,
      lastRefreshedAt: this.data.lastRefreshedAt || null, nextCheckAt: this.data.autoRefresh === false ? null : this.data.nextCheckAt || null,
      configured: this.cookies.info('bilibili').configured, busy: this.busy };
  }
  start() { this.started = true; this.schedule(); }
  schedule() {
    clearTimeout(this.timer);
    if (!this.started || this.closed || this.data.autoRefresh === false) return;
    const delay = this.data.nextCheckAt ? Math.max(30000, Math.min(interval, this.data.nextCheckAt - this.now())) : 30000;
    this.timer = setTimeout(() => { void this.check().catch(() => {}).finally(() => this.schedule()); }, delay); this.timer.unref();
  }
  configure(autoRefresh) {
    if (typeof autoRefresh !== 'boolean') throw new Error('自动续期参数错误');
    this.save({ autoRefresh }); this.schedule(); return this.status();
  }
  async exclusive(operation) {
    if (this.closed) throw new Error('登录服务已停止');
    if (this.busy) throw new Error('正在处理 B 站登录，请稍后重试');
    this.busy = true;
    try { return await operation(this.version); } finally { this.busy = false; }
  }
  active(version) { if (this.closed || version !== this.version) throw new Error('登录配置已变更，请重新操作'); }
  async call(endpoint, { text = this.cookies.read('bilibili'), form, html = false, version = this.version } = {}) {
    const url = endpoint.startsWith('https://') ? endpoint : passport + endpoint;
    const target = new URL(url);
    if (target.protocol !== 'https:' || !['passport.bilibili.com', 'www.bilibili.com'].includes(target.hostname)) throw new Error('登录接口地址无效');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000); timer.unref();
    this.controllers.add(controller);
    try {
      this.active(version);
      const response = await this.request(url, { method: form ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
          Referer: 'https://www.bilibili.com/', Cookie: cookieHeader(text, url), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}) });
      this.active(version);
      if (!response.ok) { await response.body?.cancel(); throw new Error('request'); }
      const reader = response.body.getReader(); let size = 0; const chunks = [];
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 256 * 1024) { await reader.cancel(); throw new Error('response'); } chunks.push(Buffer.from(value)); }
      this.active(version);
      const raw = Buffer.concat(chunks).toString('utf8');
      return { body: html ? raw : JSON.parse(raw), cookies: response.headers.getSetCookie() };
    } catch { this.active(version); throw new Error('B 站接口暂时不可用，请稍后重试；原登录数据已保留'); }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  async generateQr() {
    return this.exclusive(async version => {
      if (this.qr && this.qr.expiresAt > this.now() && this.now() - this.qr.createdAt < 3000) return this.qrPublic();
      const { body } = await this.call('qrcode/generate', { text: '', version });
      const { url, qrcode_key: key } = body.data || {}; let target;
      try { target = new URL(url); } catch {}
      const officialQr = target && !target.username && !target.password && (
        (target.origin === 'https://passport.bilibili.com' && target.pathname.startsWith('/h5-app/passport/login/'))
        || (target.origin === 'https://account.bilibili.com' && target.pathname === '/h5/account-h5/auth/scan-web'));
      if (body.code !== 0 || !tokenValid(key) || !officialQr) throw new Error('无法获取 B 站登录二维码，请稍后重试');
      this.qr = { key, url, createdAt: this.now(), expiresAt: this.now() + 180000, state: 'waiting_scan', lastPollAt: 0 };
      return this.qrPublic();
    });
  }
  qrPublic() { return this.qr ? { url: this.qr.url, expiresAt: this.qr.expiresAt, state: this.qr.state } : { state: 'none' }; }
  async pollQr() {
    return this.exclusive(async version => {
      if (!this.qr) return { qr: { state: 'none' }, status: this.status() };
      if (this.qr.expiresAt <= this.now()) this.qr.state = 'expired';
      if (['expired', 'success'].includes(this.qr.state) || this.now() - this.qr.lastPollAt < 2500) return { qr: this.qrPublic(), status: this.status() };
      this.qr.lastPollAt = this.now();
      const { body, cookies } = await this.call('qrcode/poll?qrcode_key=' + encodeURIComponent(this.qr.key), { text: '', version });
      const code = body.data?.code;
      if (body.code !== 0) throw new Error('B 站扫码状态检查失败，请稍后重试');
      if (code === 86101) this.qr.state = 'waiting_scan';
      else if (code === 86090) this.qr.state = 'scanned';
      else if (code === 86038) this.qr.state = 'expired';
      else if (code === 0) {
        const text = applyCookies('', cookies, passport), refreshToken = body.data.refresh_token;
        if (!tokenValid(refreshToken) || !records(text).some(item => item.name === 'SESSDATA' && item.value) || !csrf(text)) throw new Error('登录返回的凭据不完整，请重新扫码');
        this.commit(text, refreshToken, { pendingConfirm: '', state: 'valid', detail: '扫码登录成功，登录态已保存；开启自动续期后每 6 小时检查。',
          lastCheckedAt: this.now(), lastRefreshedAt: this.now(), nextCheckAt: this.now() + interval });
        this.qr.state = 'success'; this.qr.url = ''; this.qr.key = '';
        this.log('success', 'B 站扫码登录成功，登录态与刷新令牌已保存'); this.schedule();
      } else throw new Error('B 站需要额外验证，请在 App 完成验证后重新扫码');
      return { qr: this.qrPublic(), status: this.status() };
    });
  }
  async confirm(version) {
    const { body } = await this.call('confirm/refresh', { version, form: { csrf: csrf(this.data.cookieContent), refresh_token: this.data.pendingConfirm } });
    if (body.code !== 0) throw new Error('续期已保存，确认请求失败，将稍后重试');
    this.save({ pendingConfirm: '' });
  }
  async check() {
    return this.exclusive(async version => {
      try {
        let current = this.cookies.read('bilibili');
        if (this.data.cookieContent !== undefined && hash(current) !== hash(this.data.cookieContent)) {
          if (hash(current) === this.data.previousHash) { this.project(); current = this.cookies.read('bilibili'); }
          else { this.importCookie(current); return this.status(); }
        }
        if (!current) { this.save({ state: 'unconfigured', detail: '请先扫码登录。', lastCheckedAt: this.now(), nextCheckAt: this.now() + interval }); return this.status(); }
        if (this.data.pendingConfirm) await this.confirm(version);
        const { body } = await this.call('cookie/info?csrf=' + encodeURIComponent(csrf(current)), { version });
        if (body.code === -101) {
          this.save({ state: 'expired', detail: 'B 站登录已失效，请重新扫码；失效的 Cookie 无法仅靠定时任务恢复。', lastCheckedAt: this.now(), nextCheckAt: this.now() + interval });
          this.log('warn', 'B 站登录已失效，需要重新扫码'); return this.status();
        }
        if (body.code !== 0 || typeof body.data?.refresh !== 'boolean') throw new Error('B 站登录检查暂时失败，原登录数据已保留');
        if (!this.data.refreshToken) {
          this.save({ state: 'needs_scan', detail: '当前 Cookie 有效，但未保存刷新令牌；请扫码一次以启用自动续期。', lastCheckedAt: this.now(), nextCheckAt: this.now() + interval }); return this.status();
        }
        if (body.data.refresh) {
          const timestamp = body.data.timestamp;
          if (!Number.isSafeInteger(timestamp) || Math.abs(timestamp - this.now()) > 86400000) throw new Error('B 站续期时间参数无效');
          const { body: page } = await this.call('https://www.bilibili.com/correspond/1/' + correspondPath(timestamp), { html: true, version });
          const refreshCsrf = /<div\b[^>]*\bid=["']1-name["'][^>]*>\s*([\w-]+)\s*<\/div>/i.exec(page)?.[1];
          if (!refreshCsrf) throw new Error('无法取得 B 站续期凭据，请稍后重试');
          const oldToken = this.data.refreshToken;
          const { body: updated, cookies } = await this.call('cookie/refresh', { version,
            form: { csrf: csrf(current), refresh_csrf: refreshCsrf, source: 'main_web', refresh_token: oldToken } });
          if (updated.code !== 0 || updated.data?.status !== 0 || !tokenValid(updated.data?.refresh_token)) throw new Error('B 站续期被拒绝，请重新扫码登录');
          const text = applyCookies(current, cookies, passport);
          if (!cookies.some(line => /^SESSDATA=/i.test(line)) || !csrf(text)) throw new Error('B 站续期返回不完整，请重新扫码');
          this.commit(text, updated.data.refresh_token, { pendingConfirm: oldToken, state: 'confirm_pending', lastRefreshedAt: this.now() });
          // Persist the new credentials BEFORE invalidating the previous refresh token.
          await this.confirm(version);
          this.save({ state: 'refreshed', detail: 'B 站登录态已自动续期，新解析任务会使用新 Cookie。' });
          this.log('success', 'B 站登录态已自动续期');
        } else this.save({ state: 'valid', detail: 'B 站登录有效，暂时无需续期。' });
        this.save({ lastCheckedAt: this.now(), nextCheckAt: this.now() + interval });
        return this.status();
      } catch (error) {
        this.active(version);
        this.save({ state: this.data.pendingConfirm ? 'confirm_pending' : 'error', detail: error.message,
          lastCheckedAt: this.now(), nextCheckAt: this.now() + retryDelay });
        this.log('warn', this.data.pendingConfirm ? 'B 站续期已保存，确认失败，稍后重试' : 'B 站登录检查或续期失败，请查看平台登录配置');
        return this.status();
      } finally { this.schedule(); }
    });
  }
  close() { this.closed = true; this.version++; clearTimeout(this.timer); for (const controller of this.controllers) controller.abort(); this.qr = null; }
}

import { readFileSync, writeFileSync, openSync, closeSync, fstatSync, fsyncSync, renameSync, unlinkSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DouyinBrowser, chromiumPath } from './douyin-browser.mjs';
import { normalizeCookies } from './link-cookies.mjs';

const interval = 6 * 3600000, ttl = 180000;
const pending = state => ['waiting_scan', 'scanned', 'confirming', 'verification_required'].includes(state);
const hash = value => createHash('sha256').update(value).digest('hex');
const labels = { unconfigured: '未登录', imported: '已导入，待检查', valid: '登录有效', expired: '需要重新扫码', error: '检查失败' };
const platform = { domains: ['douyin.com', 'iesdouyin.com'] };
export function douyinCookieText(items, now = Date.now()) {
  const rows = items.filter(item => typeof item.domain === 'string' && (item.domain.replace(/^\./, '') === 'douyin.com'
    || item.domain.replace(/^\./, '').endsWith('.douyin.com')) && (item.expires <= 0 || item.expires * 1000 > now));
  if (!rows.some(item => ['sessionid', 'sessionid_ss'].includes(item.name) && item.value)) throw new Error('抖音尚未返回完整登录态，请在 App 确认登录后稍候');
  return normalizeCookies('# Netscape HTTP Cookie File\n' + rows.map(item => [
    (item.httpOnly ? '#HttpOnly_' : '') + item.domain, item.domain.startsWith('.') ? 'TRUE' : 'FALSE', item.path || '/',
    item.secure ? 'TRUE' : 'FALSE', Math.max(0, Math.floor(item.expires || 0)), item.name, item.value
  ].join('\t')).join('\n') + '\n', platform).text;
}
function read(file) {
  let fd; try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192) throw new Error('抖音登录设置文件无效'); return JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; return {}; } finally { if (fd !== undefined) closeSync(fd); }
}
function write(file, data) {
  // Read with O_NOFOLLOW before replacing an existing file; never follow a symlink.
  read(file); const temp = file + '.' + randomUUID() + '.tmp';
  try { const fd = openSync(temp, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(data) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
  } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

export class DouyinSession {
  constructor(dataDir, cookies, { browserFactory = () => new DouyinBrowser(), available = () => Boolean(chromiumPath()), now = Date.now,
    onUpdate = () => {}, log = () => {} } = {}) {
    this.file = join(dataDir, 'douyin-session.json'); this.cookies = cookies; this.browserFactory = browserFactory;
    this.available = available; this.now = now; this.onUpdate = onUpdate; this.log = log;
    this.data = read(this.file); this.version = 0; this.busy = false;
    if (this.data.cookieHash !== hash(cookies.read('douyin'))) this.data = { autoCheck: this.data.autoCheck !== false, state: cookies.info('douyin').configured ? 'imported' : 'unconfigured' };
  }
  save(patch) { const next = { ...this.data, ...patch }; write(this.file, next); this.data = next; }
  status() {
    const configured = this.cookies.info('douyin').configured;
    const state = this.data.state || (configured ? 'imported' : 'unconfigured');
    return { state, label: labels[state] || '状态未知', detail: this.data.detail || '', configured, browserAvailable: this.available(),
      autoCheck: this.data.autoCheck !== false, lastCheckedAt: this.data.lastCheckedAt || null,
      lastSavedAt: this.data.lastSavedAt || null, nextCheckAt: this.data.autoCheck === false ? null : this.data.nextCheckAt || null, busy: this.busy };
  }
  start() { this.started = true; this.schedule(); }
  schedule() {
    clearTimeout(this.timer);
    if (!this.started || this.closed || this.data.autoCheck === false || !this.cookies.info('douyin').configured || !this.available()) return;
    if (!this.data.nextCheckAt) this.save({ nextCheckAt: this.now() + interval });
    const delay = this.data.nextCheckAt ? Math.max(30000, Math.min(interval, this.data.nextCheckAt - this.now())) : interval;
    this.timer = setTimeout(() => { if (!this.qr || !pending(this.qr.state)) void this.check().catch(() => {}).finally(() => this.schedule()); else this.schedule(); }, delay); this.timer.unref();
  }
  configure(autoCheck) { if (typeof autoCheck !== 'boolean') throw new Error('自动检查参数错误'); this.save({ autoCheck }); this.schedule(); return this.status(); }
  async exclusive(operation) {
    if (this.closed) throw new Error('登录服务已停止');
    if (this.busy) throw new Error('正在处理抖音登录，请稍后重试');
    this.busy = true; try { return await operation(this.version); } finally { this.busy = false; }
  }
  active(version) { if (this.closed || version !== this.version) throw new Error('登录配置已变更，请重新操作'); }
  stopBrowser() { clearTimeout(this.expiry); clearTimeout(this.qrWatch); this.browser?.close(); this.browser = null; }
  watchQr() {
    clearTimeout(this.qrWatch);
    if (this.closed || !this.browser || !pending(this.qr?.state)) return;
    this.qrWatch = setTimeout(() => { void this.pollQr().catch(() => {}).finally(() => this.watchQr()); }, 3000); this.qrWatch.unref();
  }
  expireQr() {
    if (!pending(this.qr?.state) || this.qr.expiresAt > this.now()) return;
    // Network callbacks may advance while an asynchronous snapshot is still in
    // progress. Honor those signals before an expiry timer closes the browser.
    if (this.browser?.state === 'verification_required' && !this.qr.verificationExtended) {
      this.qr.state = 'verification_required'; this.qr.verificationExtended = true;
      this.qr.expiresAt = this.qr.createdAt + 300000; this.armExpiry(); return;
    }
    if ((this.browser?.confirmed || this.browser?.authenticated) && this.qr.state !== 'verification_required') this.qr.state = 'confirming';
    if (this.qr.state === 'confirming' && !this.qr.confirmGrace) {
      this.qr.confirmGrace = true; this.qr.expiresAt = this.now() + 20000; this.armExpiry(); return;
    }
    this.qr.state = 'expired'; this.stopBrowser();
  }
  armExpiry() {
    clearTimeout(this.expiry); const qr = this.qr;
    this.expiry = setTimeout(() => { if (this.qr === qr) this.expireQr(); }, Math.max(1, qr.expiresAt - this.now())); this.expiry.unref();
  }
  importCookie(content) {
    const normalized = content ? normalizeCookies(content, platform) : null;
    this.version++; this.qr = null; this.stopBrowser();
    const result = normalized ? this.cookies.save('douyin', normalized.text) : this.cookies.clear('douyin');
    this.save({ cookieHash: hash(this.cookies.read('douyin')), state: normalized ? 'imported' : 'unconfigured',
      detail: normalized ? 'Cookie 已导入，可立即检查是否有效。' : '请用抖音 App 扫码登录。', lastCheckedAt: null, lastSavedAt: normalized ? this.now() : null, nextCheckAt: null });
    this.onUpdate(); this.schedule(); return result;
  }
  qrPublic() { return this.qr ? { state: this.qr.state, expiresAt: this.qr.expiresAt,
    ...(this.qr.state === 'verification_required' ? { detail: '手机扫码已进入额外身份验证。请在下方官方验证画面完成短信等验证；验证码只填写在后台，无需发送给他人。' } : {}),
    ...(['waiting_scan', 'scanned'].includes(this.qr.state) ? { image: this.qr.image } : {}) } : { state: 'none' }; }
  async generateQr() {
    return this.exclusive(async version => {
      if (this.qr && this.qr.expiresAt > this.now() && this.now() - this.qr.createdAt < 3000) return this.qrPublic();
      const cookieHash = hash(this.cookies.read('douyin'));
      this.stopBrowser(); this.qr = null;
      const browser = this.browser = this.browserFactory();
      try {
        await browser.start('', { login: true }); this.active(version);
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(browser.image || '') || browser.image.length > 400000) throw new Error('抖音二维码格式无效，请重试');
        const expiresAt = Math.min(this.now() + ttl, Number.isFinite(browser.expiresAt) ? browser.expiresAt : this.now() + ttl);
        if (expiresAt <= this.now()) throw new Error('抖音二维码已过期，请重新获取');
        this.qr = { image: browser.image, state: 'waiting_scan', createdAt: this.now(), expiresAt, lastPollAt: 0, cookieHash };
        this.armExpiry(); this.watchQr();
        return this.qrPublic();
      } catch (error) { if (this.browser === browser) this.stopBrowser(); throw error; }
    });
  }
  storeSnapshot(snapshot, version, expectedHash) {
    this.active(version); const text = douyinCookieText(snapshot.cookies, this.now());
    if (hash(this.cookies.read('douyin')) !== expectedHash) throw new Error('Cookie 已在其他位置更新，请重新操作');
    this.cookies.save('douyin', text);
    this.save({ state: 'valid', cookieHash: hash(text), lastCheckedAt: this.now(), lastSavedAt: this.now(), nextCheckAt: this.now() + interval,
      detail: '登录态已自动保存。每 6 小时检查并同步平台更新的 Cookie；平台要求重新登录时仍需扫码。' });
    this.onUpdate(); this.schedule();
  }
  async pollQr() {
    // The server watches QR completion even while the phone's browser is in the
    // background. UI polling reads the same state instead of starting a second job.
    if (this.busy) return { qr: this.qrPublic(), status: this.status() };
    return this.exclusive(async version => {
      this.expireQr();
      if (!this.qr || !pending(this.qr.state) || this.now() - this.qr.lastPollAt < 2500) return { qr: this.qrPublic(), status: this.status() };
      this.qr.lastPollAt = this.now();
      try {
        const snapshot = await this.browser.snapshot(); this.active(version);
        if (snapshot.authenticated) {
          // Completion requires a positive response from the official account API;
          // a QR acknowledgement or session-shaped Cookie alone is insufficient.
          try { this.storeSnapshot(snapshot, version, this.qr.cookieHash); this.qr.state = 'success'; this.stopBrowser(); this.log('success', '抖音扫码登录成功，Cookie 已自动保存'); }
          catch (error) { this.active(version); if (!snapshot.cookies?.some(item => ['sessionid', 'sessionid_ss'].includes(item.name) && item.value)) this.qr.state = 'confirming'; else throw error; }
        } else if (snapshot.state === 'verification_required') {
          this.qr.state = 'verification_required';
          if (!this.qr.verificationExtended) { this.qr.verificationExtended = true; this.qr.expiresAt = this.qr.createdAt + 300000; this.armExpiry(); }
        } else if (snapshot.confirmed || snapshot.state === 'confirming') {
          if (this.qr.state !== 'verification_required' || snapshot.verificationComplete) this.qr.state = 'confirming';
        } else if (snapshot.verificationComplete && this.qr.state === 'verification_required') this.qr.state = 'confirming';
        else if (snapshot.state === 'scanned' && this.qr.state === 'waiting_scan') this.qr.state = 'scanned';
        else if (snapshot.state === 'expired' && ['waiting_scan', 'scanned'].includes(this.qr.state)) { this.qr.state = 'expired'; this.stopBrowser(); }
        return { qr: this.qrPublic(), status: this.status() };
      } catch { this.active(version); throw new Error('抖音扫码状态读取失败，请稍后重试；原 Cookie 已保留'); }
    });
  }
  async check() {
    return this.exclusive(async version => {
      if (this.qr && pending(this.qr.state)) throw new Error('请先完成当前扫码登录，或取消后再检查');
      const text = this.cookies.read('douyin');
      if (!text) return this.status();
      this.stopBrowser(); const browser = this.browser = this.browserFactory();
      try {
        await browser.start(text); this.active(version); const snapshot = await browser.check(); this.active(version);
        if (snapshot.authenticated) this.storeSnapshot(snapshot, version, hash(text));
        else this.save({ state: snapshot.invalid ? 'expired' : 'error', detail: snapshot.invalid ? '平台提示登录已失效，请重新扫码；原 Cookie 已保留。' : '未能确认登录状态，可能需要安全验证或网络暂时受限；原 Cookie 已保留，可稍后重试。', lastCheckedAt: this.now(), nextCheckAt: this.now() + interval });
        return this.status();
      } catch { this.active(version); this.save({ state: 'error', detail: '抖音登录检查失败，可能需要安全验证或网络暂时受限；原 Cookie 已保留。', lastCheckedAt: this.now(), nextCheckAt: this.now() + interval }); return this.status(); }
      finally { if (this.browser === browser) this.stopBrowser(); this.schedule(); }
    });
  }
  async verification(input) {
    return this.exclusive(async version => {
      if (this.qr?.state !== 'verification_required' || !this.browser) throw new Error('当前没有等待处理的抖音身份验证，请先检查扫码状态');
      this.expireQr();
      if (!this.browser) throw new Error('验证会话已过期，请重新扫码');
      const result = input ? await this.browser.verificationInteract(input) : await this.browser.verificationView();
      this.active(version); return result;
    });
  }
  cancel() { this.version++; this.qr = null; this.stopBrowser(); return this.status(); }
  close() { if (this.closed) return; this.closed = true; this.version++; clearTimeout(this.timer); this.stopBrowser(); }
}

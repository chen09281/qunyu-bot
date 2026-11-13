import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const official = host => host === 'douyin.com' || host.endsWith('.douyin.com');
// Scope helpers to the actual identity dialog; the login form stays mounted
// behind its mask and must never receive the identity-verification code.
const verificationDOM = `
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
  const roots=[...document.querySelectorAll('#uc-second-verify,[role="dialog"],[aria-modal="true"]')]
    .filter(e=>(visible(e)||[...e.children].some(visible))&&/身份验证|完成安全验证|短信验证|人脸验证/.test(e.innerText||''));
  const root=roots.at(-1);
  const exposed=e=>{if(!root||!root.contains(e)||!visible(e))return false;const r=e.getBoundingClientRect();
    const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!hit&&(e===hit||e.contains(hit));};
  const enabled=e=>{if(e.disabled||e.closest('[disabled],[aria-disabled="true"]'))return false;
    for(let p=e;p&&p!==root;p=p.parentElement)if([...p.classList].some(c=>/^disabled(?:[-_]|$)/.test(c)))return false;return true;};
  const eligible=e=>e?.tagName==='INPUT'&&enabled(e)&&!e.readOnly&&exposed(e)
    &&(/验证码/.test(e.placeholder||'')||e.autocomplete==='one-time-code'
      ||(!e.placeholder&&['tel','text','number','password'].includes(e.type)&&e.maxLength>=4&&e.maxLength<=8));
`;

const hasSession = (items, now) => items.some(item => ['sessionid', 'sessionid_ss'].includes(item.name) && item.value
  && (item.expires <= 0 || item.expires * 1000 > now));
export function qrExpiresAt(value, now = Date.now()) {
  const number = Number(value);
  const expiry = number > 1e12 ? number : number > 1e9 ? number * 1000 : number > 0 ? now + number * 1000 : now + 180000;
  return Number.isFinite(expiry) ? Math.min(now + 180000, expiry) : now + 180000;
}
export function douyinPollRequest(request, token) {
  let url; try { url = new URL(request.url); } catch { return null; }
  if (url.protocol !== 'https:' || !official(url.hostname) || url.username || url.password || url.port && url.port !== '443'
    || !['/passport/web/check_qrconnect/', '/check_qrconnect/'].includes(url.pathname)
    || !['GET', 'POST'].includes(request.method) || request.url.length > 32768 || (request.postData || '').length > 16384) return null;
  const form = new URLSearchParams(request.postData || ''), current = form.get('token') || url.searchParams.get('token');
  if (!token || current !== token) return null;
  for (const key of ['a_bogus', 'X-Bogus', '_signature']) url.searchParams.delete(key);
  const body = request.method === 'POST' ? form : url.searchParams;
  body.set('is_frontier', 'false');
  return { url: url.href, method: request.method, ...(request.method === 'POST' ? { body: body.toString() } : {}) };
}
function callbackUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
    && ['douyin.com', 'iesdouyin.com', 'amemv.com', 'snssdk.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host)) ? url.href : ''; } catch { return ''; }
}
export function chromiumPath() {
  return [process.env.DOUYIN_CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find(path => path && existsSync(path)) || '';
}

// A short-lived, isolated official-site browser. Only its loopback DevTools endpoint
// is used; no debugging port, browser profile or arbitrary URL is exposed by the API.
export class DouyinBrowser {
  constructor({ executable = chromiumPath(), now = Date.now } = {}) {
    this.executable = executable; this.pending = new Map(); this.responses = new Map();
    this.requests = new Map(); this.now = now;
    this.serial = 0; this.state = 'waiting_scan'; this.image = ''; this.confirmed = false; this.authenticated = false; this.invalid = false;
  }
  async start(cookieText = '', { login = false, profile = '' } = {}) {
    if (profile && !/^MS4wLjABAAAA[A-Za-z0-9_-]{8,200}$/.test(profile)) throw new Error('抖音主页 ID 无效');
    this.profile = profile;
    this.login = login;
    if (!this.executable) throw new Error('未安装扫码浏览器；Docker 更新镜像后可用，本机可安装 Chrome 或设置 DOUYIN_CHROMIUM');
    this.directory = mkdtempSync(join(tmpdir(), 'qqbot-douyin-'));
    const child = this.child = spawn(this.executable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--window-size=1280,900',
      `--user-data-dir=${this.directory}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      const endpoint = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('浏览器启动超时')), 15000); timer.unref();
        let tail = '';
        const finish = (error, value) => { clearTimeout(timer); child.stderr.off('data', data); error ? reject(error) : resolve(value); };
        const data = chunk => { tail = (tail + chunk.toString()).slice(-4096); const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/.exec(tail); if (match) finish(null, match[1]); };
        child.stderr.on('data', data); child.once('error', () => finish(new Error('浏览器启动失败')));
        child.once('exit', () => finish(new Error('浏览器已退出')));
      });
      if (this.closed) throw new Error('登录已取消');
      const socket = this.socket = new WebSocket(endpoint);
      socket.addEventListener('message', event => this.message(event.data));
      socket.addEventListener('close', () => this.fail());
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('浏览器连接超时')), 10000); timer.unref();
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('浏览器连接失败')); }, { once: true }); });
      const { targetId } = await this.call('Target.createTarget', { url: 'about:blank' });
      this.sessionId = (await this.call('Target.attachToTarget', { targetId, flatten: true })).sessionId;
      await this.call('Network.enable'); await this.call('Page.enable');
      if (profile) {
        await this.call('Network.setBlockedURLs', { urls: ['*.mp4*', '*.m3u8*', '*.m4s*', '*.flv*', '*douyinvod.com/*'] });
        await this.call('Fetch.enable', { patterns: ['Media', 'Image', 'Font'].map(resourceType => ({ resourceType, requestStage: 'Request' })) });
      }
      await this.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      if (cookieText) {
        const cookies = cookieText.split('\n').filter(line => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_'))).map(line => {
          const [rawDomain, , path, secure, expiry, name, value] = line.split('\t');
          return { domain: rawDomain.replace(/^#HttpOnly_/, ''), path, secure: secure === 'TRUE', httpOnly: rawDomain.startsWith('#HttpOnly_'),
            ...(Number(expiry) > 0 ? { expires: Number(expiry) } : {}), name, value };
        }).filter(item => official(item.domain.replace(/^\./, '')));
        if (cookies.length) await this.call('Network.setCookies', { cookies });
      }
      await this.call('Page.navigate', { url: profile ? `https://www.douyin.com/user/${profile}` : login ? 'https://creator.douyin.com/' : 'https://creator.douyin.com/web/api/media/user/info/' });
      if (login) await this.waitQr();
      return this;
    } catch (error) { this.close(); throw error; }
  }
  call(method, params = {}, sessionId = this.sessionId) {
    if (this.closed || this.socket?.readyState !== 1) return Promise.reject(new Error('登录浏览器已停止'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('抖音页面响应超时')); }, 10000); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  message(raw) {
    let data; try { data = JSON.parse(raw); } catch { return; }
    if (data.id) { const pending = this.pending.get(data.id); if (!pending) return;
      this.pending.delete(data.id); clearTimeout(pending.timer); return data.error ? pending.reject(new Error('抖音页面操作失败')) : pending.resolve(data.result || {}); }
    if (data.sessionId !== this.sessionId) return;
    if (data.method === 'Fetch.requestPaused' && this.profile) {
      void this.call('Fetch.failRequest', { requestId: data.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      return;
    }
    if (data.method === 'Network.requestWillBeSent') {
      const { requestId, request } = data.params; let url; try { url = new URL(request.url); } catch { return; }
      if (url.protocol === 'https:' && official(url.hostname) && ['/passport/web/check_qrconnect/', '/check_qrconnect/'].includes(url.pathname)
        && (request.postData || '').length <= 16384 && request.url.length <= 32768) {
        const token = new URLSearchParams(request.postData || '').get('token') || url.searchParams.get('token');
        if (token?.length <= 4096 && this.requests.size < 100) this.requests.set(requestId, { token });
        if (token === this.qrToken) this.pollRequest = douyinPollRequest(request, this.qrToken);
      }
    }
    if (data.method === 'Network.responseReceived') {
      const { requestId, response } = data.params; let url; try { url = new URL(response.url); } catch { return; }
      if (url.protocol === 'https:' && official(url.hostname) && (/\/(get_qrcode|check_qrconnect|account\/info|user\/profile\/self)\//.test(url.pathname)
        || url.hostname === 'creator.douyin.com' && url.pathname === '/web/api/media/user/info/'
        || this.profile && url.hostname === 'www.douyin.com' && url.pathname === '/aweme/v1/web/aweme/post/' && url.searchParams.get('sec_user_id') === this.profile)) {
        if (this.responses.size < 100) this.responses.set(requestId, { path: url.pathname, token: this.requests.get(requestId)?.token, status: response.status,
          ...(this.profile && url.hostname === 'www.douyin.com' && url.pathname === '/aweme/v1/web/aweme/post/' && url.searchParams.get('sec_user_id') === this.profile ? { profile: this.profile } : {}) });
      }
    }
    if (data.method === 'Network.loadingFailed') { this.responses.delete(data.params.requestId); this.requests.delete(data.params.requestId); }
    if (data.method === 'Network.loadingFinished' && this.responses.has(data.params.requestId)) {
      const meta = this.responses.get(data.params.requestId); this.responses.delete(data.params.requestId); this.requests.delete(data.params.requestId);
      if (data.params.encodedDataLength > 2 * 1024 * 1024) return;
      void this.call('Network.getResponseBody', { requestId: data.params.requestId }).then(result => {
        if (result.body?.length > 3 * 1024 * 1024) return;
        const body = JSON.parse(result.base64Encoded ? Buffer.from(result.body, 'base64').toString() : result.body);
        if (meta.profile && meta.status === 200) this.profileData = body;
        this.observe(meta.path, body, meta);
      }).catch(() => {});
    }
  }
  observe(path, body, meta = {}) {
    if (this.closed || !body || meta.status !== undefined && meta.status !== 200) return;
    const data = body?.data || {};
    if (path.includes('get_qrcode')) {
      if (data.error_code !== undefined && data.error_code !== 0) return;
      if (this.qrToken && data.token && data.token !== this.qrToken) {
        if (!this.confirmed && this.state !== 'verification_required') this.state = 'expired';
        return;
      }
      if (typeof data.token === 'string' && data.token.length <= 4096) this.qrToken = data.token;
      this.expiresAt = qrExpiresAt(data.expire_time, this.now());
      const raw = data.qrcode?.replace?.(/^data:image\/png;base64,/, '');
      if (typeof raw === 'string' && raw.length < 180000 && /^[A-Za-z0-9+/=]+$/.test(raw)
        && Buffer.from(raw, 'base64').subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) this.image = 'data:image/png;base64,' + raw;
    }
    if (path.includes('check_qrconnect')) {
      if (this.qrToken && meta.token !== this.qrToken) return;
      if (data.error_code === 2046) { if (!this.authenticated) { this.state = 'verification_required'; this.verificationFinished = false; } return; }
      if (data.error_code !== undefined && data.error_code !== 0 || body.message && body.message !== 'success') return;
      const state = String(data.status ?? '');
      if (['2', 'scanned'].includes(state) && this.state === 'waiting_scan') this.state = 'scanned';
      if (['3', 'confirmed', 'success'].includes(state) || callbackUrl(data.redirect_url)) {
        this.confirmed = true; this.confirmedAt ??= this.now();
        if (this.state !== 'verification_required') this.state = 'confirming';
        this.redirectUrl = callbackUrl(data.redirect_url) || this.redirectUrl;
      } else if (['4', '5', 'expired', 'refused'].includes(state) && !this.confirmed && this.state !== 'verification_required') this.state = 'expired';
    }
    if (path.includes('user/profile/self') && body.status_code === 0 && /^[1-9]\d{0,30}$/.test(String(body.user?.uid || ''))) this.authenticated = true;
    if (path === '/web/api/media/user/info/' && body.status_code === 0 && /^[1-9]\d{0,30}$/.test(String(body.user?.uid || ''))) this.authenticated = true;
    if (path === '/web/api/media/user/info/' && body.status_code === 8) this.invalid = true;
    if (path.includes('account/info') && body.message === 'success' && /^[1-9]\d{0,30}$/.test(String(data.user_id || data.uid || ''))) this.authenticated = true;
    if (path.includes('account/info') && [1003, 2003].includes(data.error_code)) this.invalid = true;
  }
  async evaluate(expression, awaitPromise = false, sessionId = this.sessionId) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
    return result.result?.value;
  }
  async waitQr() {
    for (let attempt = 0; attempt < 70 && !this.closed; attempt++) {
      if (this.image) return;
      // Use the site's normal login control and capture only its QR container.
      const rectangle = await this.evaluate(`(() => {
        const qr = document.querySelector('#animate_qrcode_container, [data-e2e="qr-code"]');
        if (qr && [...qr.querySelectorAll('img,canvas')].some(e=>(e.naturalWidth||e.width)>80)) { const r=qr.getBoundingClientRect(); if(r.width>80&&r.height>80) return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}; }
        if (!document.querySelector('#animate_qrcode_container')) {
          const b=[...document.querySelectorAll('button,[role="button"],a')].find(e=>e.textContent.trim()==='登录');
          if(b) b.click();
        }
        return null;
      })()`);
      if (rectangle && rectangle.width < 600 && rectangle.height < 600 && rectangle.x >= 0 && rectangle.y >= 0) {
        const shot = await this.call('Page.captureScreenshot', { format: 'png', clip: rectangle });
        if (shot.data?.length < 400000) { this.image = 'data:image/png;base64,' + shot.data; return; }
      }
      await pause(500);
    }
    throw new Error('抖音未返回登录二维码，可能需要安全验证或服务器网络受限；原 Cookie 已保留，可稍后重试或手动导入');
  }
  async snapshot() {
    if (this.closed) throw new Error('登录浏览器已停止');
    if (this.login && !this.authenticated && this.state !== 'verification_required') await this.pollLogin();
    let { cookies } = await this.call('Storage.getCookies');
    if (this.login && !this.authenticated && hasSession(cookies, this.now())) await this.probeAuthentication();
    // Keep the site's callback alive first; only recover a missed official redirect
    // after a grace period, never while an identity-verification dialog is active.
    if (this.login && this.confirmed && !this.authenticated && !hasSession(cookies, this.now()) && this.state !== 'verification_required'
      && this.redirectUrl && this.followedRedirect !== this.redirectUrl && this.now() - this.confirmedAt >= 3000) {
      this.followedRedirect = this.redirectUrl;
      await this.call('Page.navigate', { url: this.redirectUrl });
    }
    if (this.login && !this.authenticated) {
      const verification = await this.evaluate(`(() => { const text=document.body?.innerText||''; return /身份验证|完成安全验证|短信验证|人脸验证/.test(text); })()`).catch(() => false);
      if (verification) { this.state = 'verification_required'; this.verificationAbsentSince = null; this.verificationFinished = false; }
      else if (this.state === 'verification_required') {
        this.verificationAbsentSince ??= this.now();
        if (this.now() - this.verificationAbsentSince >= 3000) { this.verificationFinished = true; this.state = this.confirmed ? 'confirming' : 'scanned'; }
      }
    }
    // Re-read after callback/probe activity; an earlier Cookie snapshot may be stale.
    ({ cookies } = await this.call('Storage.getCookies'));
    return { state: this.state, confirmed: this.confirmed, authenticated: this.authenticated, invalid: this.invalid, verificationComplete: this.verificationFinished === true,
      cookies: cookies.filter(item => official(item.domain.replace(/^\./, ''))) };
  }
  async pollLogin() {
    if (!this.pollRequest || this.now() - (this.lastActivePollAt || 0) < 2500) return;
    this.lastActivePollAt = this.now(); const request = this.pollRequest, token = this.qrToken;
    try {
      const result = await this.evaluate(`(async () => {
        const request=${JSON.stringify(request)};
        const response=await fetch(request.url,{method:request.method,credentials:'include',redirect:'error',signal:AbortSignal.timeout(6000),
          ...(request.body?{headers:{'Content-Type':'application/x-www-form-urlencoded'},body:request.body}:{})});
        const text=await response.text(); if(text.length>262144) return null;
        try{return {status:response.status,body:JSON.parse(text)};}catch{return null;}
      })()`, true);
      if (result && token === this.qrToken) this.observe(new URL(request.url).pathname, result.body, { status: result.status, token });
    } catch { /* A missed fallback request must not interrupt the official SDK. */ }
  }
  async probeAuthentication() {
    if (this.now() - (this.lastProbeAt || 0) < 2500) return;
    this.lastProbeAt = this.now(); let targetId;
    try {
      ({ targetId } = await this.call('Target.createTarget', { url: 'about:blank', background: true }));
      const { sessionId } = await this.call('Target.attachToTarget', { targetId, flatten: true });
      await this.call('Page.navigate', { url: 'https://creator.douyin.com/web/api/media/user/info/' }, sessionId);
      for (let attempt = 0; attempt < 25 && !this.closed; attempt++) {
        const body = await this.evaluate(`(() => { if(location.origin!=='https://creator.douyin.com'||location.pathname!=='/web/api/media/user/info/')return null;
          try {const text=document.body?.innerText||'';return text.length<=262144?JSON.parse(text):null;}catch{return null;} })()`, false, sessionId);
        if (typeof body?.status_code === 'number') { this.observe('/web/api/media/user/info/', body); break; }
        await pause(200);
      }
    } catch { /* Cookie presence alone is never treated as proof of login. */ }
    finally { if (targetId && !this.closed) await this.call('Target.closeTarget', { targetId }).catch(() => {}); }
  }
  async verificationViewport() {
    if (this.closed || !this.login || this.authenticated || this.state !== 'verification_required') throw new Error('当前没有等待处理的抖音身份验证');
    const viewport = await this.evaluate(`(() => {
      const official=location.protocol==='https:'&&(location.hostname==='douyin.com'||location.hostname.endsWith('.douyin.com'));
      const text=document.body?.innerText||'';
      if(!official||location.pathname.startsWith('/creator-micro/')||!/身份验证|完成安全验证|短信验证|人脸验证/.test(text))return null;
      return {width:innerWidth,height:innerHeight};
    })()`);
    if (!viewport || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)
      || viewport.width < 100 || viewport.width > 1600 || viewport.height < 100 || viewport.height > 1200) throw new Error('验证页面已变化，请立即检查登录状态');
    return viewport;
  }
  async verificationView() {
    const viewport = await this.verificationViewport();
    const result = await this.call('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: false });
    if (!result.data || result.data.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(result.data)) throw new Error('验证画面读取失败，请重试');
    return { ...viewport, image: 'data:image/jpeg;base64,' + result.data };
  }
  async verificationInteract(input) {
    // Only human actions on the currently visible login-verification page are
    // accepted. No URLs, arbitrary scripts, clipboard reads or stored OTPs.
    const { width, height } = await this.verificationViewport();
    const point = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x < width && p.y < height;
    if (input.type === 'click' || input.type === 'drag') {
      const from = input.type === 'click' ? input : input.from, to = input.type === 'click' ? input : input.to;
      if (!point(from) || !point(to)) throw new Error('验证操作坐标无效，请刷新画面后重试');
      await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
      try {
        if (input.type === 'drag') for (let step = 1; step <= 20; step++) {
          await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * step / 20,
            y: from.y + (to.y - from.y) * step / 20, button: 'left', buttons: 1 }); await pause(15);
        }
      } finally { await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {}); }
    } else if (['sms-method', 'sms', 'submit'].includes(input.type)) {
      const labels = input.type === 'sms-method' ? ['接收短信验证码', '短信验证']
        : input.type === 'sms' ? ['获取验证码', '发送验证码', '重新发送', '获取短信验证码', '重新获取验证码', '重新获取']
          : ['确认', '确定', '验证', '确认验证', '提交', '下一步'];
      const action = await this.evaluate(`(() => { ${verificationDOM}
        if(!root)return null;const labels=${JSON.stringify(labels)};
        if(${input.type === 'sms-method'}&&[...root.querySelectorAll('input')].some(eligible))return {ready:true};
        const buttons=[...root.querySelectorAll('button,[role="button"],a,span,div')]
          .filter(e=>!e.children.length&&enabled(e)&&exposed(e)&&labels.includes(e.textContent.trim()));
        if(buttons.length!==1)return null;
        // Trigger the selected official control directly. Coordinate dispatch can
        // be acknowledged by headless Chromium without delivering a DOM click.
        buttons[0].click();return {clicked:true};
      })()`);
      if (!action?.clicked && !action?.ready) throw new Error(input.type === 'sms-method' ? '请在官方验证画面中选择「接收短信验证码」'
        : input.type === 'sms' ? '官方可能已自动发送短信，请先查看手机；重发需等待倒计时结束'
          : '验证按钮尚不可用，请确认验证码已填写；也可在官方画面中点击验证');
      if (input.type === 'sms-method') {
        let ready = action.ready;
        for (let attempt = 0; !ready && attempt < 10; attempt++) {
          await pause(200);
          ready = await this.evaluate(`(() => { ${verificationDOM} return !!root&&[...root.querySelectorAll('input')].some(eligible); })()`);
        }
        if (!ready) throw new Error('官方页面尚未切换到短信输入框，请刷新画面查看平台提示后重试');
        return { accepted: true, detail: '已进入官方短信验证页。官方可能已自动发送短信；收到后可直接填写验证码，无需重复获取。' };
      }
    } else if (input.type === 'code') {
      if (typeof input.code !== 'string' || !/^\d{4,8}$/.test(input.code)) throw new Error('请输入 4–8 位数字验证码');
      const focused = await this.evaluate(`(() => { ${verificationDOM}
        if(!root)return false;
        let field=eligible(document.activeElement)?document.activeElement:null;
        if(!field){const fields=[...root.querySelectorAll('input')].filter(eligible);if(fields.length===1)field=fields[0];}
        if(!field)return false;field.focus();field.select();return field===document.activeElement;
      })()`);
      if (!focused) throw new Error('未找到当前身份验证弹窗的验证码框；请先选择「接收短信验证码」，再点击弹窗中的验证码输入框');
      await this.call('Input.insertText', { text: input.code });
      let filled = await this.evaluate(`(() => { ${verificationDOM}
        const field=document.activeElement;return eligible(field)&&field.value===${JSON.stringify(input.code)};
      })()`);
      if (!filled) filled = await this.evaluate(`(() => { ${verificationDOM}
        const field=document.activeElement;if(!eligible(field))return false;
        const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
        if(!set)return false;set.call(field,${JSON.stringify(input.code)});
        field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));
        return eligible(field)&&field.value===${JSON.stringify(input.code)};
      })()`);
      if (!filled) throw new Error('验证码未成功填入当前验证框，请刷新画面后重试');
    } else if (input.type === 'key' && ['Enter', 'Tab', 'Backspace'].includes(input.key)) {
      const keyCode = { Enter: 13, Tab: 9, Backspace: 8 }[input.key];
      const params = { key: input.key, code: input.key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await this.call('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(input.key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
      await this.call('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    } else throw new Error('不支持的验证操作');
    return { accepted: true };
  }
  async check() {
    for (let attempt = 0; attempt < 25 && !this.closed; attempt++) {
      if (this.authenticated || this.invalid) return this.snapshot();
      await pause(500);
    }
    // Ask the official browser session rather than marking a saved sessionid as valid.
    await this.evaluate(`fetch('https://login.douyin.com/passport/web/account/info/?aid=6383',{credentials:'include'}).catch(()=>{})`, true).catch(() => {});
    await pause(500);
    return this.snapshot();
  }
  fail() { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('登录浏览器已停止')); } this.pending.clear(); }
  close() {
    if (this.closed) return; this.closed = true; this.fail(); this.socket?.close();
    const directory = this.directory, child = this.child;
    const cleanup = () => {
      if (!directory) return;
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch { const retry = setTimeout(() => { try { rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} }, 2000); retry.unref(); }
    };
    if (child && child.exitCode === null && child.signalCode === null && child.pid) { child.once('exit', cleanup); child.kill('SIGTERM'); const timer=setTimeout(()=>child.kill('SIGKILL'),2000); timer.unref(); child.once('exit',()=>clearTimeout(timer)); }
    else cleanup();
  }
}

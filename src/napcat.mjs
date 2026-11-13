import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

class NapcatError extends Error {
  constructor(message, kind = 'upstream') { super(message); this.kind = kind; }
}
const identity = config => createHash('sha256').update(JSON.stringify([config.napcatUrl, config.napcatToken, config.onebotUrl, config.onebotToken, config.botId])).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const phases = {
  qrcode: ['waiting_scan', '等待扫码'], qrcode_ready: ['waiting_scan', '等待扫码'],
  generating_qrcode: ['waiting_scan', '正在生成二维码'], waiting_qrcode: ['waiting_scan', '等待扫码'],
  qrcode_scanned: ['scanned', '已扫码，等待确认'], initializing: ['initializing', '正在登录'],
  reconnecting: ['reconnecting', '正在重连'], offline: ['offline', 'QQ 登录已失效']
};
const qrFailure = (status, error) => error?.timeout
  // NapCat 刷新接口内部同步等待 10 秒仍拿不到二维码，说明登录服务（QQ 会话缓存）已失效，只能重启或重置缓存。
  ? 'NapCat 登录服务无法生成二维码（QQ 登录缓存异常或会话已失效）：正在自动重置登录缓存并重启登录服务；若仍失败，请手动重启 NapCat'
  : status.qq.state === 'offline'
    ? 'QQ 登录会话已失效，请重启 NapCat 登录服务后再获取二维码'
    : 'NapCat 尚未准备好登录二维码，请稍后重试；若持续失败，请重启 NapCat 登录服务';

export class Napcat {
  constructor(store, bot, { dataDir = process.env.DATA_DIR || 'data', recoveryWaitMs = 90000, recoveryPollMs = 5000, recoveryCooldownMs = 10 * 60000 } = {}) {
    Object.assign(this, { store, bot, recoveryWaitMs, recoveryPollMs, recoveryCooldownMs });
    this.qqDataDir = join(resolve(dataDir), 'napcat', 'qq');
  }
  context() {
    const config = { ...this.store.config }, key = identity(config);
    if (this.current?.key !== key) this.current = { key, config, credential: '', expiresAt: 0, retryAfter: 0, cache: null, pending: null };
    return this.current;
  }
  async raw(context, route, params = {}, credential = '', timeout = 5) {
    let result;
    try { result = await this.bot.request(`${context.config.napcatUrl}/api/${route}`, params, credential, timeout); }
    catch (error) {
      const message = String(error?.message || '');
      if (['TimeoutError', 'AbortError'].includes(error?.name) || /请求超时/.test(message)) throw new NapcatError('NapCat 响应超时，请稍后重试；二维码刷新可能需要等待登录服务恢复', 'timeout');
      if (/^上游 HTTP \d+/.test(message)) throw new NapcatError(`NapCat 管理接口返回异常状态（${message.replace('上游 ', '')}），请检查 NapCat 服务是否正常运行`, 'connection');
      if (/有效 JSON|响应过大/.test(message)) throw new NapcatError('NapCat 管理接口返回了无法识别的数据，请检查管理地址是否指向 NapCat WebUI');
      throw new NapcatError('无法连接 NapCat 管理接口，请检查地址及服务是否启动', 'connection');
    }
    if (Number(result.code) !== 0 || result.code == null) {
      const message = String(result.message || '');
      if (/unauthorized|authorization failed/i.test(message)) throw new NapcatError('NapCat 管理会话已失效', 'auth');
      if (/token is invalid/i.test(message)) throw new NapcatError('NapCat WebUI Token 不正确', 'auth');
      if (/login rate/i.test(message)) throw new NapcatError('NapCat 登录过于频繁，请一分钟后重试', 'auth');
      if (/is logined/i.test(message)) throw new NapcatError('QQ 已登录，无需再次获取二维码');
      if (/qrcode (?:refresh|get) error/i.test(message)) {
        const error = new NapcatError('QQ 登录服务暂未生成二维码，请稍后重试；若持续失败，请重启 NapCat 登录服务', 'qrcode');
        // NapCat 只在刷新接口内部等待 10 秒仍无结果时返回“刷新超时”，可直接判定登录服务失效。
        error.timeout = /超时|timeout/i.test(message);
        throw error;
      }
      if (/invalid or expired code/i.test(message)) throw new NapcatError('二次验证代码错误或已过期', 'twoFactor');
      throw new NapcatError('NapCat 接口暂不可用，请检查 NapCat 版本及管理配置');
    }
    return result.data;
  }
  async authenticate(context, totpCode) {
    if (context.credential && Date.now() < context.expiresAt) return context.credential;
    if (!context.config.napcatToken) throw new NapcatError('请先保存 NapCat WebUI Token', 'unconfigured');
    if (!totpCode && context.authError?.kind === 'twoFactor') throw context.authError;
    if (Date.now() < context.retryAfter) throw context.authError || new NapcatError('NapCat 连接暂不可用，请稍后重试');
    if (context.authPending) return context.authPending;
    context.authPending = (async () => {
      try {
        const hash = createHash('sha256').update(context.config.napcatToken + '.napcat').digest('hex');
        const data = await this.raw(context, 'auth/login', { hash, ...(totpCode ? { totpCode } : {}) });
        if (data?.require2FA) throw new NapcatError('NapCat 已启用二次验证，请输入动态验证码连接', 'twoFactor');
        if (typeof data?.Credential !== 'string' || !data.Credential || /[\r\n]/.test(data.Credential)) throw new NapcatError('NapCat 返回的管理凭据无效');
        context.credential = data.Credential; context.expiresAt = Date.now() + 50 * 60000;
        context.authError = null; context.retryAfter = 0;
        return context.credential;
      } catch (error) {
        context.authError = error; context.retryAfter = error.kind === 'twoFactor' ? 0 : Date.now() + 60000;
        throw error;
      }
    })();
    try { return await context.authPending; } finally { context.authPending = null; }
  }
  async webui(context, route, params = {}, timeout = 5) {
    const credential = await this.authenticate(context);
    try { return await this.raw(context, route, params, credential, timeout); }
    catch (error) {
      if (error.kind !== 'auth') throw error;
      context.credential = ''; context.expiresAt = 0;
      return this.raw(context, route, params, await this.authenticate(context), timeout);
    }
  }
  async connect(totpCode) {
    const context = this.context();
    await this.authenticate(context, totpCode);
    return this.status(true);
  }
  async status(force = false) {
    const context = this.context();
    if (context.pending) return context.pending;
    if (!force && context.cache && Date.now() - context.cache.checkedAt < 5000) return context.cache;
    context.pending = this.probe(context);
    try { context.cache = await context.pending; return context.cache; }
    finally { context.pending = null; }
  }
  async probe(context) {
    const config = context.config;
    const [web, obStatus, obInfo] = await Promise.allSettled([
      config.napcatToken ? this.webui(context, 'QQLogin/CheckLoginStatus') : Promise.reject(new NapcatError('请配置 NapCat 管理连接', 'unconfigured')),
      this.bot.onebot('get_status', {}, config), this.bot.onebot('get_login_info', {}, config)
    ]);
    const webui = { configured: Boolean(config.napcatToken), reachable: web.status === 'fulfilled', authenticated: web.status === 'fulfilled', error: '', requires2FA: false };
    if (web.status === 'rejected') {
      webui.error = web.reason.message; webui.requires2FA = web.reason.kind === 'twoFactor';
      webui.reachable = !['connection', 'unconfigured'].includes(web.reason.kind);
    }
    const onebot = { reachable: obStatus.status === 'fulfilled', online: obStatus.status === 'fulfilled' && typeof obStatus.value?.online === 'boolean' ? obStatus.value.online : null,
      error: obStatus.status === 'rejected' ? 'OneBot 接口未连接，请检查 NapCat 是否已启动及接口配置' : '' };
    const login = web.status === 'fulfilled' ? web.value : {};
    let info = obInfo.status === 'fulfilled' ? obInfo.value : null;
    if (!info && web.status === 'fulfilled' && login.isLogin) {
      try { info = await this.webui(context, 'QQLogin/GetQQLoginInfo'); } catch { /* Account status can remain available without profile details. */ }
    }
    const userId = info?.user_id ?? info?.uin;
    const account = { userId: /^\d{5,20}$/.test(String(userId)) ? String(userId) : '', nickname: String(info?.nickname ?? info?.nick ?? '').slice(0, 100) };
    let state = 'unknown', label = '状态未知', detail = webui.error || onebot.error;
    if (onebot.online === true || (onebot.online === null && login.isLogin === true)) { state = 'online'; label = 'QQ 在线'; detail = 'QQ 已登录，账号在线'; }
    else if (login.isOffline === true || (onebot.online === false && (web.status === 'rejected' || login.isLogin === true))) { state = 'offline'; label = 'QQ 登录已失效'; detail = 'QQ 登录会话已失效或账号已离线，请获取新二维码并重新扫码登录；若二维码无法生成，请重启 NapCat 登录服务'; }
    else if (web.status === 'fulfilled') {
      [state, label] = phases[login.loginPhase] || ['waiting_scan', '等待扫码'];
      detail = login.loginPhase === 'offline' ? 'QQ 登录会话已失效或登录服务未就绪，请获取新二维码并重新扫码登录；若二维码无法生成，请重启 NapCat 登录服务' : login.loginError ? 'NapCat 报告登录异常，请刷新二维码或在 NapCat 中检查登录状态' : '使用手机 QQ 扫码，并在手机上确认登录';
    }
    if (config.botId && account.userId && config.botId !== account.userId) detail += '；当前账号与机器人 QQ 号配置不一致';
    return { checkedAt: Date.now(), webui, onebot, account, qq: { state, label, detail }, phase: String(login.loginPhase || '').slice(0, 50) };
  }
  async qrcode(refresh = false) {
    try { return await this.fetchQrcode(refresh); }
    catch (error) {
      // 登录服务卡死（刷新接口内部等待 10 秒仍无二维码）时自动清缓存并重启，用户不必再手动进服务器处理。
      if (error.kind !== 'qrcode' || !error.timeout) throw error;
      const context = this.context();
      if (context.recovering) return context.recovering;
      if (Date.now() < (context.recoveredCooldownAt || 0)) throw error;
      // 没有挂载 QQ 登录目录（例如纯 Node 开发环境）时不做自动恢复，直接把原因交给界面。
      if (!existsSync(this.qqDataDir)) throw error;
      context.recoveredCooldownAt = Date.now() + this.recoveryCooldownMs;
      return this.recoverLogin(context);
    }
  }
  // 备份并清空 QQ 登录缓存。只在未登录时调用：缓存里的失效会话正是登录服务卡死的原因。
  // 用同目录改名而非复制，几百 MB 的缓存也能瞬间让位；只保留最近两份自动备份。
  resetLoginCache() {
    const dir = this.qqDataDir;
    if (!existsSync(dir)) throw new NapcatError('找不到 NapCat 登录数据目录，请确认 data/napcat/qq 已挂载', 'unconfigured');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const backup = `${dir}.auto-${stamp}`;
    mkdirSync(backup, { recursive: true });
    for (const entry of readdirSync(dir)) renameSync(join(dir, entry), join(backup, entry));
    const parent = dirname(dir);
    const older = readdirSync(parent).filter(name => /^qq\.auto-/.test(name)).sort()
      .slice(0, -2);
    for (const name of older) rmSync(join(parent, name), { recursive: true, force: true });
    return backup;
  }
  async recoverLogin(context) {
    context.recovering = (async () => {
      const backup = this.resetLoginCache();
      this.bot.log?.('warn', `QQ 登录服务无响应，已备份并清空登录缓存：${backup}`);
      try { await this.webui(context, 'QQLogin/RestartNapCat', {}, 10); }
      // 重启会先断开容器内的 QQ 进程（容器随后按策略重建），管理接口短暂不可用属于预期。
      catch { /* 等待重启完成后重新鉴权即可。 */ }
      context.credential = ''; context.expiresAt = 0; context.authError = null; context.retryAfter = 0; context.cache = null; context.qr = null;
      const deadline = Date.now() + this.recoveryWaitMs;
      while (Date.now() < deadline) {
        await sleep(this.recoveryPollMs);
        try {
          const qr = await this.fetchQrcode(true);
          if (qr?.url) return qr;
        } catch { /* 容器重启期间接口不可达，继续等待。 */ }
      }
      throw new NapcatError(`已备份并清空 QQ 登录缓存（${backup}）并重启 NapCat，但 ${Math.round(this.recoveryWaitMs / 1000)} 秒内仍未生成二维码，请检查 NapCat 容器日志`, 'qrcode');
    })();
    try { return await context.recovering; } finally { context.recovering = null; }
  }
  async fetchQrcode(refresh = false) {
    const context = this.context();
    if (context.qrPending) return context.qrPending;
    if (!refresh && context.qr && Date.now() - context.qr.generatedAt < 3000) return context.qr;
    context.qrPending = (async () => {
      const status = await this.status(true);
      if (status.qq.state === 'online') throw new NapcatError('QQ 已登录，无需再次获取二维码');
      const readQr = data => [data?.qrcode, data?.qrcodeurl].find(value => typeof value === 'string' && value.trim())?.trim() || '';
      let data, failure = null;
      // 保留信息量最大的失败原因：刷新超时可直接判定登录服务失效，优先于后续的“未生成二维码”。
      const remember = error => { if (!failure || (error.timeout && !failure.timeout)) failure = error; };
      if (!refresh) {
        try { data = await this.webui(context, 'QQLogin/GetQQLoginQrcode', {}, 10); }
        catch (error) { if (error.kind !== 'qrcode') throw error; remember(error); }
      }
      let value = readQr(data);
      if (!value && data?.restarting) throw new NapcatError('NapCat 正在重连，请稍后再获取二维码');
      // 获取二维码为空或报错时自动触发一次 RefreshQRcode；刷新二维码时直接请求 RefreshQRcode（预留 15 秒等待登录服务）。
      if (!value) {
        try {
          data = await this.webui(context, 'QQLogin/RefreshQRcode', {}, 15);
          value = readQr(data);
        } catch (error) {
          if (error.kind !== 'qrcode') throw error;
          remember(error); data = undefined;
        }
      }
      if (!value && data?.restarting) throw new NapcatError('NapCat 正在重连，请稍后再获取二维码');
      // 刷新后回读一次，避免把仍然可用的旧二维码误判为失败。
      if (!value) {
        try { value = readQr(await this.webui(context, 'QQLogin/GetQQLoginQrcode', {}, 8)); }
        catch (error) { if (error.kind !== 'qrcode') throw error; remember(error); }
      }
      if (!value) {
        const error = new NapcatError(qrFailure(status, failure), 'qrcode');
        error.timeout = Boolean(failure?.timeout);
        throw error;
      }
      let url;
      try { url = new URL(value); } catch { throw new NapcatError('NapCat 尚未准备好登录二维码，请稍后重试'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.href.length > 8192 || url.username || url.password) throw new NapcatError('NapCat 返回的二维码格式不支持');
      context.qr = { url: url.href, generatedAt: Date.now() }; context.cache = null;
      return context.qr;
    })();
    try { return await context.qrPending; } finally { context.qrPending = null; }
  }
}

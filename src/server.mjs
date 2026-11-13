import { Operations } from './operations.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';
import { normalizeGroups, openStore, publicConfig, safeEqual, token, verifyPassword } from './config.mjs';
import { modelConfig, profileConfig } from './model-provider.mjs';
import { publicModelLibrary, libraryRevision, importLegacyModels, validateModelProfiles } from './model-library.mjs';
import { Bot } from './bot.mjs';
import { ScheduledChat } from './scheduled-chat.mjs';
import { ScheduledGC } from './scheduled-gc.mjs';
import { ServerStatus } from './server-status.mjs';
import { Conversations } from './conversations.mjs';
import { Napcat } from './napcat.mjs';
import { registerRuntime } from './runtime.mjs';
import { LinkParser, socialLink } from './social-links.mjs';
import { BilibiliSession } from './bilibili-session.mjs';
import { DouyinSession } from './douyin-session.mjs';
import { AdminSessions, sessionSeconds } from './admin-sessions.mjs';
import { DocumentGenerator } from './documents.mjs';
import { CheckinService } from './checkin/service.mjs';
import { SubscriptionService } from './subscriptions/service.mjs';
import { SubscriptionCommands } from './subscriptions/commands.mjs';
import { readBilibiliFeed } from './subscriptions/bilibili-feed.mjs';
import { HealthCenter } from './subscriptions/health.mjs';
import { EmailAlerts } from './email-alerts.mjs';
import { MusicService } from './music.mjs';
import { TokenUsageService } from './token-usage.mjs';
import { GameCalendarService } from './game-calendar/service.mjs';
import { GameCalendarCommands } from './game-calendar/commands.mjs';
import { tokenToolResponse } from './checkin/token-tool/downloads.mjs';
import { TavernManager } from './tavern/tavern-manager.mjs';
import { TavernCommands } from './tavern/commands.mjs';
import { normalizeCardData } from './tavern/card-parser.mjs';
import { DEFAULT_EMOTION_STATE, EMOTION_METRICS, EMOTION_TRIGGER_TEMPLATES } from './tavern/emotions.mjs';
import { CardRenderer } from './card-renderer.mjs';
import { FunStore, defaultFunSettings } from './fun/store.mjs';
import { FunService } from './fun/service.mjs';
import { FunCommands } from './fun/commands.mjs';
import { HealthPlannerStore } from './health-planner/store.mjs';
import { HealthPlannerService } from './health-planner/service.mjs';
import { HealthPlannerCommands } from './health-planner/commands.mjs';
import { AuthAttemptGuard, quarantineCorruptFile, redactSecrets, sanitizeJsonValue, validHostHeader } from './security.mjs';
import { createEncryptedBackup } from './backup.mjs';
import { generateRecoveryCodes, generateTotpSecret, totpUri, verifyTotpCode } from './totp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function modelTestError(error) {
  const message = redactSecrets(String(error?.message || '未知错误')).slice(0, 300), status = /^上游 HTTP (\d{3})$/.exec(message)?.[1];
  if (status === '404') return '模型不存在或当前账号无权限，请检查模型 ID、渠道映射和账号权限';
  if (['401', '403'].includes(status)) return 'API Key 无效或当前渠道没有访问权限';
  if (status === '429') return '模型额度不足或触发上游限流，请检查账户额度和限流设置';
  return message;
}
async function body(req, limit = 128 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function parseJSON(raw) {
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return sanitizeJsonValue(value);
  } catch { throw new HttpError(400, '请求必须为 JSON 对象'); }
}
export async function createApplication(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || join(root, 'data'));
  const store = await openStore(dataDir, options.initialPassword ?? process.env.ADMIN_PASSWORD ?? '');
  const sessions = new AdminSessions(join(dataDir, 'admin-sessions.sqlite'), options.sessionOptions);
  const bot = new Bot(store, new Conversations(join(dataDir, 'conversations.sqlite')), new LinkParser(dataDir), new DocumentGenerator(dataDir)), authGuard = new AuthAttemptGuard(), pwdGuard = new AuthAttemptGuard({ ipMaxAttempts: 20 }), actionRate = new Map(), pendingTotp = new Map();
  const limitAction = (key, maxPerMinute = 20) => {
    const now = Date.now();
    for (const [k, rec] of actionRate) if (now - rec.start > 60_000) actionRate.delete(k);
    if (!actionRate.has(key) && actionRate.size >= 1000) throw new HttpError(429, '操作请求过多，请稍后再试');
    const rec = actionRate.get(key) || { start: now, count: 0 };
    rec.count++;
    actionRate.set(key, rec);
    if (rec.count > maxPerMinute) throw new HttpError(429, '操作过于频繁，请一分钟后重试');
  };
  async function assertCurrentPassword(req, currentPassword, errorMessage = '当前密码错误') {
    const ip = req.socket.remoteAddress || '';
    const pwdKey = `pwd:${store.admin.username}`;
    const pwdCheck = pwdGuard.check(ip, pwdKey);
    if (!pwdCheck.allowed) throw new HttpError(429, pwdCheck.message);
    if (typeof currentPassword !== 'string' || currentPassword.length > 256 || !await verifyPassword(currentPassword, store.admin)) {
      pwdGuard.recordFailure(pwdKey, ip);
      throw new HttpError(400, errorMessage);
    }
    pwdGuard.reset(pwdKey, ip);
  }
  const tokenUsage = new TokenUsageService(dataDir, options.tokenUsageOptions);
  tokenUsage.importHistory(bot.conversations.usageHistory());
  const officialUsagePath = join(dataDir, 'official-usage.json');
  if (existsSync(officialUsagePath)) {
    try { tokenUsage.importOfficial(JSON.parse(readFileSync(officialUsagePath, 'utf8'))); }
    catch (error) {
      const backup = quarantineCorruptFile(officialUsagePath);
      console.error(`[server] official-usage.json 已损坏，已隔离至 ${backup || officialUsagePath}: ${error.message}`);
    }
  }
  tokenUsage.importScopeHistory(bot.conversations.scopeUsageHistory());
  bot.tokenUsage = tokenUsage;
  bot.music = new MusicService(dataDir, { linkParser: bot.links, linkConfig: store.config, ...options.musicOptions });
  bot.scheduledChat = new ScheduledChat(dataDir, store, bot, options.scheduledChatOptions);
  const gameCalendar = new GameCalendarService(dataDir, store, { ...options.gameCalendarOptions, log: (level, message, fields) => bot.log(level, message, fields) });
  bot.gameCalendar = gameCalendar;
  bot.gameCalendarCommands = new GameCalendarCommands(store, gameCalendar, { ...options.gameCalendarCommandOptions,
    onebot: (...args) => bot.onebot(...args), log: (level, message, fields) => bot.log(level, message, fields) });
  const napcat = new Napcat(store, bot, { dataDir, ...options.napcatOptions });
  const operations = new Operations(dataDir, store, bot, napcat, tokenUsage, options.operationsOptions);
  const checkin = new CheckinService(dataDir, store, { ...options.checkinOptions,
    onebot: (...args) => bot.onebot(...args), log: (level, message) => bot.log(level, message) });
  bot.checkin = checkin;
  let emailAlerts;
  const subscriptions = new SubscriptionService(dataDir, store, { ...options.subscriptionOptions,
    onHealthChange: snapshot => emailAlerts?.observe(snapshot), onHealthReset: id => emailAlerts?.reset(id),
    cookies: bot.links.cookies,
    readBilibili: (source, readOptions) => readBilibiliFeed(source, { ...readOptions, parser: bot.links, config: store.config }),
    downloadVideo: (url, parseOptions) => {
      const link = socialLink(url);
      if (!link) throw new Error('订阅视频链接不受支持');
      return bot.links.parse(link, store.config, { ...parseOptions, includeLocalFiles: true });
    },
    selfId: async () => String(store.config.botId || bot.selfId || (await bot.onebot('get_login_info')).user_id),
    onebot: (...args) => bot.onebot(...args), log: (level, message, fields) => bot.log(level, message, fields) });
  emailAlerts = new EmailAlerts(dataDir, store, { sendMail: mail => operations.sendMail({ ...store.config, smtpUser: mail.from, emailAlertRecipient: mail.to }, mail.subject, mail.text), ...options.emailAlertOptions });
  const health = new HealthCenter(subscriptions, bot.links, emailAlerts, options.healthOptions);
  bot.subscriptionCommands = new SubscriptionCommands(dataDir, store, subscriptions, { ...options.subscriptionCommandOptions,
    onebot: (...args) => bot.onebot(...args), log: (level, message, fields) => bot.log(level, message, fields) });
  const cardRenderer = options.cardRenderer || new CardRenderer(options.cardRendererOptions);
  bot.cardRenderer = cardRenderer;
  const tavern = new TavernManager(dataDir);
  if (tavern.corruptBackup) bot.log('warn', `酒馆配置文件损坏已隔离至 ${tavern.corruptBackup}`);
  const funStore = new FunStore(dataDir);
  if (funStore.corruptBackup) bot.log('warn', `娱乐数据文件损坏已隔离至 ${funStore.corruptBackup}`);
  const funService = new FunService(funStore, {
    cardRenderer,
    tavernManager: tavern,
    askModel: opts => bot.askAuxModel(opts)
  });
  bot.tavernManager = tavern;
  bot.tavernCommands = new TavernCommands(tavern, bot.conversations, {
    ...options.tavernCommandOptions,
    dataDir,
    onebot: (...args) => bot.onebot(...args),
    log: (level, message, fields) => bot.log(level, message, fields),
    store,
    askModel: opts => bot.askAuxModel(opts),
    onRetry: (event, prompt) => bot.retryFromCommand(event, prompt),
    renderEmotionCard: payload => funService.renderEmotionCard(payload)
  });
  bot.funService = funService;
  bot.funCommands = new FunCommands(store, funService, {
    ...options.funCommandOptions,
    onebot: (...args) => bot.onebot(...args),
    log: (level, message, fields) => bot.log(level, message, fields)
  });
  const healthPlannerStore = new HealthPlannerStore(dataDir, options.healthPlannerOptions);
  const healthPlanner = new HealthPlannerService(healthPlannerStore, store, {
    ...options.healthPlannerOptions,
    cardRenderer,
    onebot: (...args) => bot.onebot(...args),
    log: (level, message, fields) => bot.log(level, message, fields),
    askModel: opts => bot.askAuxModel(opts),
    askVisionModel: opts => bot.askAuxModel({ ...opts, purpose: 'health_vision', modelPurpose: 'image' }),
    prepareInputImages: urls => bot.prepareInputImages(urls)
  });
  bot.healthPlannerCommands = new HealthPlannerCommands(store, healthPlanner, {
    ...options.healthPlannerCommandOptions,
    onebot: (...args) => bot.onebot(...args),
    log: (level, message, fields) => bot.log(level, message, fields)
  });
  const bilibili = new BilibiliSession(dataDir, bot.links.cookies, { ...options.bilibiliOptions,
    onUpdate: () => bot.resetLinkCache('bilibili'), log: (level, message) => bot.log(level, message) });
  const douyin = new DouyinSession(dataDir, bot.links.cookies, { ...options.douyinOptions,
    onUpdate: () => bot.resetLinkCache('douyin'), log: (level, message) => bot.log(level, message) });
  let lastConversationPruneAt = 0;
  const gc = new ScheduledGC({ busy: () => bot.active > 0 || bot.queue.length > 0 || checkin.active.size > 0
      || healthPlanner.scheduled || subscriptions.busy || subscriptions.previews > 0 || subscriptions.probeBusy > 0 || bilibili.busy || douyin.busy,
    prune: () => {
      bot.pruneTransientCaches();
      const retentionDays = Number(store.config.conversationRetentionDays || 0);
      if (retentionDays > 0 && Date.now() - lastConversationPruneAt >= 24 * 3600 * 1000) {
        lastConversationPruneAt = Date.now();
        const pruned = bot.conversations.pruneOlderThan(retentionDays);
        if (pruned.turns || pruned.conversations) {
          bot.log('info', `已按保留策略清理 ${pruned.turns} 条历史对话（${pruned.conversations} 个会话）`);
        }
      }
    }, log: (level, message) => bot.log(level, message), ...options.gcOptions });
  const resources = new ServerStatus(dataDir, { ...options.serverStatusOptions, gc });
  const instanceId = token();
  const secureCookie = options.secureCookie ?? process.env.COOKIE_SECURE === 'true';
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '';
  const cookie = (value, maxAge) => `qqbot_session=${value}; HttpOnly; SameSite=Strict; Path=/${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}${secureCookie ? '; Secure' : ''}`;
  function session(req) {
    const id = /(?:^|;\s*)qqbot_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (id && sessions.valid(id, store.admin)) return id;
    throw new HttpError(401, '请先登录管理后台');
  }
  const server = createServer(async (req, res) => {
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(data));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const requestUrl = new URL(req.url, 'http://localhost'), path = requestUrl.pathname;
      if (path === '/health' && req.method === 'GET') return send(200, { ok: true, app: 'qq-deepseek-bot', instanceId });
      const toolDownload = tokenToolResponse(path, req.method, { androidApkPath: join(dataDir, 'downloads', 'kuro-token-android.apk') });
      if (toolDownload) {
        res.writeHead(toolDownload.status, toolDownload.headers);
        res.end(req.method === 'HEAD' ? undefined : toolDownload.body); return;
      }
      if (path === '/onebot/events' && req.method === 'POST') {
        const config = store.config;
        const bearerValid = safeEqual(req.headers.authorization, `Bearer ${config.webhookToken}`);
        // NapCat HTTP Client uses Bearer token; standard OneBot HTTP POST also supports HMAC.
        if (!bearerValid && !req.headers['x-signature']) throw new HttpError(401, '上报鉴权失败');
        const raw = await body(req);
        if (!bearerValid) {
          const signature = 'sha1=' + createHmac('sha1', config.webhookToken).update(raw).digest('hex');
          if (!safeEqual(req.headers['x-signature'], signature)) throw new HttpError(401, '上报签名错误');
        }
        bot.receive(parseJSON(raw));
        return send(200, {}); // Acknowledge immediately, do not let NapCat retry slow model calls.
      }
      if (path.startsWith('/bridge/health/')) {
        const ip = req.socket.remoteAddress || '';
        limitAction(`health-bridge:${ip}`, 60);
        const bearer = /^\s*Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '')?.[1] || '';
        if (path === '/bridge/health/sync' && req.method === 'POST') {
          if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请使用 application/json');
          const result = healthPlanner.ingestAppleHealth(bearer, parseJSON(await body(req, 64 * 1024)));
          return send(result.status, result.body);
        }
        if (path === '/bridge/health/pending' && req.method === 'GET') {
          const result = healthPlanner.pullPendingAppleNutrition(bearer);
          return send(result.status, result.body);
        }
        if (path === '/bridge/health/ack' && req.method === 'POST') {
          if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请使用 application/json');
          const result = healthPlanner.ackPendingAppleNutrition(bearer, parseJSON(await body(req, 64 * 1024)));
          return send(result.status, result.body);
        }
        throw new HttpError(404, '接口不存在');
      }
      if (path.startsWith('/api/')) {
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) throw new HttpError(405, '不支持的请求方法');
        if (req.method !== 'GET') {
          if (!publicOrigin && !validHostHeader(req.headers.host)) throw new HttpError(400, '请求 Host 头无效');
          const expectedOrigin = publicOrigin || `${secureCookie ? 'https' : 'http'}://${req.headers.host}`;
          if (req.headers['x-admin-request'] !== '1' || (req.headers.origin && req.headers.origin !== expectedOrigin)
            || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '同源校验失败，请从后台页面操作');
          if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请使用 application/json');
        }
        if (path === '/api/setup' && req.method === 'GET') return send(200, { required: store.setupRequired });
        if (path === '/api/setup-admin' && req.method === 'POST') {
          if (!store.setupRequired) throw new HttpError(409, '管理账号已创建，请使用已设置的账号登录');
          const input = parseJSON(await body(req));
          if (input.password !== input.confirmPassword) throw new HttpError(400, '两次输入的密码不一致');
          try { await store.setupAdmin(input.username, input.password); }
          catch (error) { throw new HttpError(error.code === 'ADMIN_EXISTS' ? 409 : 400, error.code && error.code !== 'ADMIN_EXISTS' ? '账号保存失败，请检查数据目录权限' : error.message); }
          const { id } = sessions.create(store.admin);
          bot.log('success', '首次管理员账号已创建');
          return send(201, { ok: true }, { 'Set-Cookie': cookie(id, sessionSeconds) });
        }
        if (path === '/api/login' && req.method === 'POST') {
          if (store.setupRequired) throw new HttpError(409, '请先创建管理账号');
          const ip = req.socket.remoteAddress || '';
          const input = parseJSON(await body(req));
          if (input.rememberMe !== undefined && typeof input.rememberMe !== 'boolean') throw new HttpError(400, '保持登录选项必须为布尔值');
          const subject = typeof input.username === 'string' ? input.username.trim().slice(0, 64) : '';
          const guardCheck = authGuard.check(ip, subject || store.admin.username);
          if (!guardCheck.allowed) throw new HttpError(429, guardCheck.message);
          const passwordValid = typeof input.password === 'string' && input.password.length <= 256 && await verifyPassword(input.password, store.admin);
          if (input.username !== store.admin.username || !passwordValid) {
            authGuard.recordFailure(subject || store.admin.username, ip);
            throw new HttpError(401, '用户名或密码错误');
          }
          if (store.admin.totp?.enabled) {
            const totpCode = typeof input.totpCode === 'string' ? input.totpCode.trim() : '';
            if (!totpCode) return send(200, { requiresTotp: true });
            if (totpCode.length > 32 || (!verifyTotpCode(store.admin.totp.secret, totpCode) && !store.consumeRecoveryCode(totpCode))) {
              authGuard.recordFailure(subject || store.admin.username, ip);
              throw new HttpError(401, '动态验证码或恢复码错误');
            }
          }
          authGuard.reset(store.admin.username, ip);
          const initialFile = join(dataDir, 'initial-password.txt');
          if (existsSync(initialFile)) { try { unlinkSync(initialFile); } catch {} }
          const { id, maxAge } = sessions.create(store.admin, input.rememberMe === true);
          // Replace this browser's prior session rather than leaving another reusable token.
          const previous = /(?:^|;\s*)qqbot_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
          if (previous) sessions.delete(previous);
          return send(200, { ok: true }, { 'Set-Cookie': cookie(id, input.rememberMe === true ? maxAge : undefined) });
        }
        const id = session(req);
        const initialFile = join(dataDir, 'initial-password.txt');
        if (existsSync(initialFile)) {
          try { if (Date.now() - statSync(initialFile).mtimeMs > 24 * 3600 * 1000) unlinkSync(initialFile); } catch {}
        }
        if (path === '/api/session' && req.method === 'GET') return send(200, { authenticated: true, username: store.admin.username, totpEnabled: Boolean(store.admin?.totp?.enabled) });
        if (path === '/api/logout' && req.method === 'POST') {
          pendingTotp.delete(id);
          sessions.delete(id); return send(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
        }
        if (path === '/api/model-library' && req.method === 'GET') return send(200, publicModelLibrary(store.config));
        if (path === '/api/model-library' && req.method === 'PUT') {
          const input = parseJSON(await body(req));
          if (input.revision !== libraryRevision(store.config)) throw new HttpError(409, '模型库已在其他页面更新，请刷新后再保存');
          try { store.save({ modelProfiles: input.profiles, modelRoutes: input.routes, ...(input.fallbackEnabled !== undefined ? {modelFallbackEnabled:input.fallbackEnabled}:{}), ...(input.fallbackProfileId !== undefined ? {modelFallbackProfileId:input.fallbackProfileId}: {}) }); }
          catch (error) { if (error.code) throw error; throw new HttpError(400, error.message); }
          return send(200, publicModelLibrary(store.config));
        }
        if (path === '/api/model-library/import' && req.method === 'POST') {
          const input = parseJSON(await body(req));
          if (input.revision !== libraryRevision(store.config)) throw new HttpError(409, '模型库已更新，请刷新后重试');
          try { store.save({ modelProfiles: importLegacyModels(store.config) }); }
          catch (error) { throw new HttpError(400, error.message); }
          return send(200, publicModelLibrary(store.config));
        }
        const runLibraryAction = async (config, action) => {
          if (action === 'models') {
            try { return send(200, { models: await bot.models(config) }); }
            catch (error) { throw new HttpError(502, `获取模型列表失败：${modelTestError(error)}`); }
          }
          if (bot.testing) throw new HttpError(429, '模型测试正在进行，请稍候');
          bot.testing = true;
          try {
            const answer = await bot.completion('请只回复“连接成功”。', { ...config, webSearchEnabled: false, documentGenerationEnabled: false, maxTokens: 4096, maxTokensUnlimited: false, timeoutSeconds: 60, timeoutUnlimited: false });
            return send(200, { text: answer.text.slice(0, 500), model: config.model, provider: config.apiProvider });
          } catch (error) { throw new HttpError(502, `模型测试失败：${modelTestError(error)}`); }
          finally { bot.testing = false; }
        };
        if (['/api/model-library/models', '/api/model-library/test'].includes(path) && req.method === 'POST') {
          limitAction(`model:${id}`, 20);
          const input = parseJSON(await body(req));
          let profiles;
          try { profiles = validateModelProfiles([input.profile], store.config.modelProfiles); }
          catch (error) { throw new HttpError(400, error.message); }
          const config = profileConfig({ ...store.config, modelProfiles: profiles }, profiles[0].id);
          return await runLibraryAction(config, path.endsWith('/models') ? 'models' : 'test');
        }
        const libraryAction = /^\/api\/model-library\/([a-zA-Z0-9_-]{1,64})\/(models|test)$/.exec(path);
        if (libraryAction && req.method === 'POST') {
          limitAction(`model:${id}`, 20);
          const config = profileConfig(store.config, libraryAction[1]);
          return await runLibraryAction(config, libraryAction[2]);
        }
        if (path === '/api/tavern/config' && req.method === 'GET') return send(200, tavern.state);
        if (path === '/api/tavern/config' && req.method === 'PUT') {
          const input = parseJSON(await body(req));
          const allowedKeys = new Set(['enabled', 'defaultCharacterId', 'emotionScopeMode', 'groupBindings', 'userBindings', 'characterParams']);
          if (Object.keys(input).some(k => !allowedKeys.has(k))) throw new HttpError(400, '酒馆配置包含不支持的字段');
          if (Object.hasOwn(input, 'enabled') && typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须为布尔值');
          if (Object.hasOwn(input, 'defaultCharacterId') && typeof input.defaultCharacterId !== 'string') throw new HttpError(400, 'defaultCharacterId 必须为字符串');
          if (Object.hasOwn(input, 'emotionScopeMode') && !['group', 'group-member'].includes(input.emotionScopeMode)) {
            throw new HttpError(400, 'emotionScopeMode 必须为 group 或 group-member');
          }
          for (const mapKey of ['groupBindings', 'userBindings', 'characterParams']) {
            if (Object.hasOwn(input, mapKey) && (!input[mapKey] || typeof input[mapKey] !== 'object' || Array.isArray(input[mapKey]))) {
              throw new HttpError(400, `${mapKey} 必须为对象`);
            }
          }
          if (Object.hasOwn(input, 'groupBindings')) {
            for (const [gid, cid] of Object.entries(input.groupBindings)) {
              if (!/^\d{5,20}$/.test(String(gid))) throw new HttpError(400, '群号格式无效');
              if (typeof cid !== 'string' || !tavern.getCharacter(cid)) throw new HttpError(400, `群绑定了不存在的角色卡：${cid}`);
            }
          }
          if (Object.hasOwn(input, 'userBindings')) {
            for (const [uid, cid] of Object.entries(input.userBindings)) {
              if (!/^\d{5,20}$/.test(String(uid))) throw new HttpError(400, '用户 QQ 号格式无效');
              if (typeof cid !== 'string' || !tavern.getCharacter(cid)) throw new HttpError(400, `用户绑定了不存在的角色卡：${cid}`);
            }
          }
          tavern.saveConfig({ ...tavern.state, ...input });
          return send(200, tavern.state);
        }
        if (path === '/api/tavern/characters' && req.method === 'GET') return send(200, { characters: tavern.listCharacters() });
        const tavernCharMatch = /^\/api\/tavern\/characters\/([a-zA-Z0-9_-]{1,64})$/.exec(path);
        if (tavernCharMatch && req.method === 'GET') {
          const char = tavern.getCharacter(tavernCharMatch[1]);
          if (!char) throw new HttpError(404, '未找到该角色卡');
          return send(200, char);
        }
        if (tavernCharMatch && req.method === 'PUT') {
          const input = parseJSON(await body(req, 2 * 1024 * 1024));
          try {
            const normalized = normalizeCardData(input);
            const updated = tavern.saveCharacter(tavernCharMatch[1], normalized);
            return send(200, updated);
          } catch (error) {
            throw new HttpError(400, error.message);
          }
        }
        if (tavernCharMatch && req.method === 'DELETE') {
          const ok = tavern.deleteCharacter(tavernCharMatch[1]);
          return send(200, { success: ok });
        }
        const tavernAvatarMatch = /^\/api\/tavern\/characters\/([a-zA-Z0-9_-]{1,64})\/avatar$/.exec(path);
        if (tavernAvatarMatch && req.method === 'GET') {
          const avatarBuf = tavern.getAvatar(tavernAvatarMatch[1]);
          if (!avatarBuf) throw new HttpError(404, '该角色没有独立头像');
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' });
          return res.end(avatarBuf);
        }
        const tavernEmotionsMatch = /^\/api\/tavern\/characters\/([a-zA-Z0-9_-]{1,64})\/emotions$/.exec(path);
        if (tavernEmotionsMatch && req.method === 'GET') {
          const char = tavern.getCharacter(tavernEmotionsMatch[1]);
          if (!char) throw new HttpError(404, '未找到该角色卡');
          return send(200, {
            characterId: char.id,
            characterName: char.name,
            metrics: EMOTION_METRICS,
            defaults: DEFAULT_EMOTION_STATE,
            sessions: tavern.emotions.listByCharacter(char.id),
            triggers: tavern.getEmotionTriggers(char.id),
            triggerTemplates: EMOTION_TRIGGER_TEMPLATES
          });
        }
        const tavernTriggersMatch = /^\/api\/tavern\/characters\/([a-zA-Z0-9_-]{1,64})\/triggers$/.exec(path);
        if (tavernTriggersMatch && req.method === 'PUT') {
          const char = tavern.getCharacter(tavernTriggersMatch[1]);
          if (!char) throw new HttpError(404, '未找到该角色卡');
          const input = parseJSON(await body(req));
          try {
            const triggers = tavern.setEmotionTriggers(char.id, input?.triggers || []);
            return send(200, { characterId: char.id, triggers });
          } catch (error) {
            throw new HttpError(400, error.message);
          }
        }
        const tavernStickerUploadMatch = /^\/api\/tavern\/characters\/([a-zA-Z0-9_-]{1,64})\/triggers\/([a-zA-Z0-9_-]{1,64})\/sticker$/.exec(path);
        if (tavernStickerUploadMatch && req.method === 'POST') {
          const char = tavern.getCharacter(tavernStickerUploadMatch[1]);
          if (!char) throw new HttpError(404, '未找到该角色卡');
          const raw = await body(req, 6 * 1024 * 1024);
          const input = parseJSON(raw);
          const b64 = typeof input?.base64 === 'string' ? input.base64.replace(/^data:[^;]+;base64,/, '') : '';
          if (!b64) throw new HttpError(400, '请提供图片内容');
          const mimeType = typeof input?.mimeType === 'string' ? input.mimeType : 'image/png';
          try {
            const sticker = tavern.saveTriggerSticker(char.id, tavernStickerUploadMatch[2], Buffer.from(b64, 'base64'), mimeType);
            return send(200, { sticker, triggers: tavern.getEmotionTriggers(char.id) });
          } catch (error) {
            throw new HttpError(400, error.message);
          }
        }
        if (tavernStickerUploadMatch && req.method === 'DELETE') {
          const char = tavern.getCharacter(tavernStickerUploadMatch[1]);
          if (!char) throw new HttpError(404, '未找到该角色卡');
          const triggers = tavern.deleteTriggerSticker(char.id, tavernStickerUploadMatch[2]);
          return send(200, { triggers });
        }
        const tavernStickerFileMatch = /^\/api\/tavern\/stickers\/([a-zA-Z0-9_.-]{1,120})$/.exec(path);
        if (tavernStickerFileMatch && req.method === 'GET') {
          const filename = tavernStickerFileMatch[1];
          const buf = tavern.readTriggerSticker(filename);
          if (!buf) throw new HttpError(404, '表情包不存在');
          const mime = filename.endsWith('.gif') ? 'image/gif' : filename.endsWith('.webp') ? 'image/webp' : filename.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=86400' });
          return res.end(buf);
        }
        const tavernEmotionResetMatch = /^\/api\/tavern\/characters\/([a-zA-Z0-9_-]{1,64})\/emotions\/reset$/.exec(path);
        if (tavernEmotionResetMatch && req.method === 'POST') {
          const char = tavern.getCharacter(tavernEmotionResetMatch[1]);
          if (!char) throw new HttpError(404, '未找到该角色卡');
          const input = parseJSON(await body(req));
          const scopeKey = typeof input?.scopeKey === 'string' ? input.scopeKey.trim() : '';
          tavern.emotions.reset(char.id, scopeKey);
          return send(200, {
            characterId: char.id,
            sessions: tavern.emotions.listByCharacter(char.id)
          });
        }
        if (path === '/api/tavern/characters/upload' && req.method === 'POST') {
          limitAction(`upload:${id}`, 20);
          const raw = await body(req, 15 * 1024 * 1024);
          let buffer;
          try {
            const json = JSON.parse(raw.toString('utf8'));
            if (json.base64) buffer = Buffer.from(json.base64, 'base64');
            else buffer = raw;
          } catch {
            buffer = raw;
          }
          try {
            const imported = tavern.importCharacter(buffer);
            return send(200, imported);
          } catch (e) {
            throw new HttpError(400, `角色卡导入失败: ${e.message}`);
          }
        }
        if (path === '/api/fun' && req.method === 'GET') {
          return send(200, {
            settings: funStore.getSettings(),
            quotesCount: funStore.state.quotes.length
          });
        }
        if (path === '/api/fun' && req.method === 'PUT') {
          const input = parseJSON(await body(req));
          const allowed = new Set(Object.keys(defaultFunSettings()));
          for (const [k, v] of Object.entries(input)) {
            if (!allowed.has(k)) throw new HttpError(400, `不支持的娱乐配置项：${k}`);
            if (typeof v !== 'boolean') throw new HttpError(400, `${k} 必须为布尔值`);
          }
          const settings = funStore.updateSettings(input);
          return send(200, { settings, quotesCount: funStore.state.quotes.length });
        }
        if (path === '/api/fun/quotes' && req.method === 'GET') {
          const groupId = requestUrl.searchParams.get('groupId') || '';
          const keyword = requestUrl.searchParams.get('keyword') || '';
          return send(200, { quotes: funStore.listQuotes({ groupId, keyword, limit: 100 }) });
        }
        const funQuoteMatch = /^\/api\/fun\/quotes\/([a-zA-Z0-9_-]{1,32})$/.exec(path);
        if (funQuoteMatch && req.method === 'DELETE') {
          if (!funStore.deleteQuote(funQuoteMatch[1])) throw new HttpError(404, '语录不存在');
          return send(200, { ok: true, quotesCount: funStore.state.quotes.length });
        }
        if (path === '/api/health-planner' && req.method === 'GET') {
          return send(200, healthPlanner.status());
        }
        if (path === '/api/health-planner' && req.method === 'PUT') {
          try {
            healthPlanner.configure(parseJSON(await body(req)));
            return send(200, healthPlanner.status());
          } catch (error) {
            throw new HttpError(400, error.message);
          }
        }
        if (path === '/api/config' && req.method === 'GET') return send(200, publicConfig(store.config));
        if (path === '/api/setup-api-key' && req.method === 'POST') {
          const input = parseJSON(await body(req));
          // First-use binding never overwrites a key saved by another tab or session.
          if (modelConfig(store.config).deepseekKey) return send(200, publicConfig(store.config));
          if (typeof input.key !== 'string' || !input.key.trim() || input.key.length > 2048 || /[\r\n]/.test(input.key)) {
            throw new HttpError(400, '请填写有效的 API Key（不超过 2048 个字符，不能包含换行）');
          }
          const provider = input.provider ?? 'deepseek';
          if (!['deepseek', 'openai'].includes(provider)) throw new HttpError(400, '不支持的 API 服务商');
          const config = store.save({ apiProvider: provider, [provider === 'openai' ? 'openaiKey' : 'deepseekKey']: input.key.trim() });
          bot.log('success', '首次 API Key 绑定完成');
          return send(200, config);
        }
        if (path === '/api/config' && req.method === 'PUT') {
          let result; const input = parseJSON(await body(req)), previous = store.config;
          try { result = store.save(input); }
          catch (error) { if (error.code) throw error; throw new HttpError(400, error.message); }
          if (!store.config.enabled || !store.config.linkParsingEnabled) bot.links.cancel();
          if (!store.config.enabled || !store.config.documentGenerationEnabled) bot.documents.cancel();
          if (!store.config.enabled || Object.hasOwn(input, 'allowedGroups')) checkin.cancel();
          if (!store.config.enabled || Object.hasOwn(input, 'allowedGroups')) subscriptions.cancel();
          bot.groupChat.sync(store.config);
          bot.log('info', '配置已保存'); return send(200, result);
        }
        const scheduledChatGroup = /^\/api\/scheduled-chat\/groups\/(\d{5,20})$/.exec(path);
        if (scheduledChatGroup && req.method === 'PUT') {
          const input = parseJSON(await body(req)), group = scheduledChatGroup[1];
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.enabled !== 'boolean') throw new HttpError(400, '定时聊天群开关必须为布尔值');
          const rules = normalizeGroups(store.config.allowedGroups);
          if (!rules.some(rule => rule.id === group)) throw new HttpError(404, '该群已移出白名单，请刷新后重试');
          const config = store.save({ allowedGroups: rules.map(rule => rule.id === group ? { ...rule, scheduledChat: input.enabled } : rule) });
          bot.groupChat.sync(store.config);
          bot.log('info', `群定时聊天已${input.enabled ? '开启' : '关闭'}`, { group, source: 'scheduled_chat' });
          return send(200, config);
        }
        if (path === '/api/usage-scopes' && req.method === 'GET') {
          try { return send(200, tokenUsage.scopeStatus(Object.fromEntries(requestUrl.searchParams))); }
          catch(error) { throw new HttpError(400,error.message); }
        }
        if (path === '/api/operations' && req.method === 'GET') return send(200, { ...operations.status(), config: Object.fromEntries(['billReportEnabled','billReportTime','billReportFrequency','consolePublicUrl','emailAlertsEnabled','smtpHost','smtpPort','smtpSecure','smtpUser','emailAlertRecipient'].map(k=>[k,store.config[k]])), smtpPasswordConfigured:Boolean(store.config.smtpPassword) });
        if (path === '/api/operations/report' && req.method === 'POST') {
          const input = parseJSON(await body(req));
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['period','provider','start','end'].includes(k))) throw new HttpError(400,'手动账单只使用已保存的邮箱配置');
          try { return send(200, await operations.sendReport(input.period, input)); }
          catch(error) { throw new HttpError(error.status || 502,error.message); }
        }
        if (path === '/api/operations' && req.method === 'PUT') {
          const input = parseJSON(await body(req));
          const allowed = ['billReportEnabled','billReportTime','billReportFrequency','consolePublicUrl','emailAlertsEnabled','smtpHost','smtpPort','smtpSecure','smtpUser','smtpPassword','emailAlertRecipient'];
          if (!input || Object.keys(input).some(k=>!allowed.includes(k))) throw new HttpError(400,'运维设置字段无效');
          try { store.save(input); return send(200,{ok:true}); } catch(error){throw new HttpError(400,error.message);}
        }
        if (path === '/api/status' && req.method === 'GET') return send(200, { ...bot.status(), server: resources.status() });
        if (path === '/api/api-billing' && req.method === 'GET') return send(200, tokenUsage.apiStatus());
        if (path === '/api/api-billing/calibrate' && req.method === 'POST') {
          try { return send(200, tokenUsage.calibrateApi(parseJSON(await body(req)))); }
          catch (error) { throw new HttpError(400, error.message); }
        }
        if (path === '/api/token-usage' && req.method === 'GET') {
          try { return send(200, tokenUsage.status({ ...Object.fromEntries(requestUrl.searchParams), detailed: requestUrl.searchParams.get('detailed') === '1' })); }
          catch (error) { throw new HttpError(400, error.message); }
        }
        if (path === '/api/token-usage/prices/sync' && req.method === 'POST') {
          await body(req);
          return send(200, await tokenUsage.syncPrices());
        }
        if (path === '/api/token-usage/pricing' && req.method === 'PUT') {
          try {
            const result = tokenUsage.configurePricing(parseJSON(await body(req)));
            bot.log('info', 'Token 计费规则已更新');
            return send(200, result);
          } catch (error) { throw new HttpError(400, error.message); }
        }
        if (path === '/api/token-usage/clear' && req.method === 'POST') {
          await body(req);
          const result = tokenUsage.clear();
          bot.log('info', 'Token 累计用量与账单记录已清空');
          return send(200, result);
        }
        if (path === '/api/game-calendar' && req.method === 'GET') return send(200, gameCalendar.status());
        if (path === '/api/game-calendar' && req.method === 'PUT') {
          try { return send(200, gameCalendar.configure(parseJSON(await body(req)))); }
          catch (error) { throw new HttpError(400, error.message); }
        }
        const gameCalendarSub = /^\/api\/game-calendar\/(codes|activities|sync|preview)(?:\/([a-zA-Z0-9_-]{1,64})(?:\/(remove))?)?$/.exec(path);
        if (gameCalendarSub && ['POST', 'PUT'].includes(req.method)) {
          const [, kind, itemId, action] = gameCalendarSub, input = parseJSON(await body(req));
          try {
            if (kind === 'sync' && !itemId && req.method === 'POST') return send(200, await gameCalendar.syncOfficial(input.game || ''));
            if (kind === 'preview' && !itemId && req.method === 'POST') return send(200, await gameCalendar.preview(input.mode || 'codes', input.game || ''));
            if (kind === 'codes') {
              if (!itemId && req.method === 'POST') return send(201, gameCalendar.upsertCode(input));
              if (itemId && !action && req.method === 'PUT') return send(200, gameCalendar.upsertCode(input, itemId));
              if (itemId && action === 'remove' && req.method === 'POST') return send(200, gameCalendar.removeCode(itemId));
            }
            if (kind === 'activities') {
              if (!itemId && req.method === 'POST') return send(201, gameCalendar.upsertActivity(input));
              if (itemId && !action && req.method === 'PUT') return send(200, gameCalendar.upsertActivity(input, itemId));
              if (itemId && action === 'remove' && req.method === 'POST') return send(200, gameCalendar.removeActivity(itemId));
            }
          } catch (error) { if (error.code) throw error; throw new HttpError(error.status || 400, error.message); }
          throw new HttpError(405, '不支持的游戏日历操作');
        }
        if (path === '/api/live-tasks' && req.method === 'GET') return send(200, bot.liveTasks.status(requestUrl.searchParams.get('id')));
        if (path === '/api/health' && req.method === 'GET') return send(200, await health.status({ refreshParser: requestUrl.searchParams.get('refresh') === '1' }));
        if (path === '/api/test-email' && req.method === 'POST') {
          const input = parseJSON(await body(req));
          if (Object.keys(input).length) throw new HttpError(400, '测试邮件只使用已保存的 SMTP 配置');
          try { return send(200, await emailAlerts.testEmail()); }
          catch (error) { throw new HttpError(error.status || 502, error.message); }
        }
        if (path === '/api/subscriptions' && req.method === 'GET') return send(200, subscriptions.status());
        const subscriptionMatch = /^\/api\/subscriptions(?:\/([a-f0-9-]{36})(?:\/(preview|check|probe|remove))?)?$/.exec(path);
        if (subscriptionMatch && ['POST', 'PUT'].includes(req.method)) {
          const [, entryId, action] = subscriptionMatch, input = parseJSON(await body(req));
          try {
            if (!entryId && req.method === 'PUT') return send(200, subscriptions.configure(input));
            if (!entryId && req.method === 'POST') return send(201, subscriptions.upsert(input));
            if (entryId && !action && req.method === 'PUT') return send(200, subscriptions.upsert(input, entryId));
            if (action && req.method === 'POST') {
              const result = action === 'preview' ? await subscriptions.preview(entryId, { renderCard: true }) : action === 'check' ? await subscriptions.check(entryId) : action === 'probe' ? await subscriptions.probe(entryId) : subscriptions.remove(entryId);
              return send(200, result);
            }
          } catch (error) { if (error.code) throw error; throw new HttpError(error.status || 400, error.message); }
          throw new HttpError(405, '不支持的订阅操作');
        }
        if (path === '/api/music/search' && req.method === 'POST') return send(200, { tracks: await bot.music.search(parseJSON(await body(req)).term) });
        if (path === '/api/music/tracks' && req.method === 'POST') { bot.music.addTrack(parseJSON(await body(req))); return send(200, bot.music.status()); }
        if (path === '/api/music/tracks/remove' && req.method === 'POST') { bot.music.removeTrack(parseJSON(await body(req)).title); return send(200, bot.music.status()); }
        if (path === '/api/music' && req.method === 'GET') return send(200, bot.music.status());
        if (path === '/api/music/check' && req.method === 'POST') return send(200, await bot.music.checkSources());
        if (path === '/api/checkin' && req.method === 'GET') return send(200, checkin.status());
        if (path === '/api/checkin' && req.method === 'PUT') {
          try { return send(200, checkin.configure(parseJSON(await body(req)))); }
          catch (error) { if (error.code) throw error; throw new HttpError(400, error.message); }
        }
        if (path === '/api/links' && req.method === 'GET') return send(200, await bot.links.status());
        if (path === '/api/links/douyin' && req.method === 'GET') return send(200, { ...douyin.status(), qr: douyin.qrPublic() });
        if (/^\/api\/links\/douyin\/(qrcode|poll|check|settings|cancel|verification|interact)$/.test(path) && req.method === 'POST') {
          const action = path.split('/').at(-1), input = parseJSON(await body(req));
          try {
            const result = action === 'qrcode' ? await douyin.generateQr() : action === 'poll' ? await douyin.pollQr()
              : action === 'check' ? await douyin.check() : action === 'cancel' ? douyin.cancel()
                : action === 'verification' ? await douyin.verification() : action === 'interact' ? await douyin.verification(input) : douyin.configure(input.autoCheck);
            return send(200, result);
          } catch (error) { throw new HttpError(400, error.message); }
        }
        if (path === '/api/links/bilibili' && req.method === 'GET') return send(200, bilibili.status());
        if (/^\/api\/links\/bilibili\/(qrcode|poll|check|settings)$/.test(path) && req.method === 'POST') {
          const action = path.split('/').at(-1), input = parseJSON(await body(req));
          try {
            const result = action === 'qrcode' ? await bilibili.generateQr() : action === 'poll' ? await bilibili.pollQr()
              : action === 'check' ? await bilibili.check() : bilibili.configure(input.autoRefresh);
            return send(200, result);
          } catch (error) { throw new HttpError(400, error.message); }
        }
        if (['/api/links/cookies', '/api/links/cookies/clear'].includes(path) && req.method === 'POST') {
          const input = parseJSON(await body(req));
          let result;
          try {
            if (input.platform === 'bilibili') {
              if (!path.endsWith('/clear') && (typeof input.content !== 'string' || !input.content.trim())) throw new Error('请填写 Cookie');
              result = { platform: 'bilibili', ...bilibili.importCookie(path.endsWith('/clear') ? '' : input.content) };
            } else if (input.platform === 'douyin') {
              if (!path.endsWith('/clear') && (typeof input.content !== 'string' || !input.content.trim())) throw new Error('请填写 Cookie');
              result = douyin.importCookie(path.endsWith('/clear') ? '' : input.content);
            } else result = path.endsWith('/clear') ? bot.links.cookies.clear(input.platform) : bot.links.cookies.save(input.platform, input.content);
          }
          catch (error) { throw new HttpError(400, error.message); }
          bot.resetLinkCache(input.platform);
          bot.log('info', path.endsWith('/clear') ? '链接解析平台登录态已清除' : '链接解析平台登录态已保存');
          return send(200, result);
        }
        if (['/api/conversations', '/api/chat-threads'].includes(path) && req.method === 'GET') {
          const rawOffset = requestUrl.searchParams.get('offset') || '0';
          if (!/^\d{1,9}$/.test(rawOffset)) throw new HttpError(400, '会话分页参数无效');
          return send(200, bot.conversations[path === '/api/chat-threads' ? 'threads' : 'list']({ search: requestUrl.searchParams.get('search') || '', offset: Number(rawOffset) }));
        }
        if (path === '/api/conversations/prune' && req.method === 'POST') {
          const input = parseJSON(await body(req));
          try {
            if (input.groupId !== undefined || input.userId !== undefined) {
              if (input.groupId && !/^(?:private|\d{5,20})$/.test(String(input.groupId))) throw new HttpError(400, '群号格式无效');
              if (input.userId && !/^\d{5,20}$/.test(String(input.userId))) throw new HttpError(400, 'QQ 号格式无效');
              return send(200, bot.conversations.deleteByScope({ groupId: input.groupId || '', userId: input.userId || '' }));
            }
            const days = Number(input.days);
            if (!Number.isInteger(days) || days < 1 || days > 3650) throw new HttpError(400, '清理天数需为 1–3650 的整数');
            return send(200, bot.conversations.pruneOlderThan(days));
          } catch (error) {
            if (error.status) throw error;
            throw new HttpError(400, error.message);
          }
        }
        const conversationMatch = /^\/api\/(conversations|chat-threads)\/([a-f0-9-]{36})(\/reset)?$/.exec(path);
        if (conversationMatch) {
          if (conversationMatch[1] === 'conversations' && !conversationMatch[3] && req.method === 'DELETE') {
            if (!bot.conversations.deleteConversation(conversationMatch[2])) throw new HttpError(404, '会话不存在');
            return send(200, { ok: true });
          }
          if (conversationMatch[1] === 'conversations' && conversationMatch[3] && req.method === 'POST') {
            if (!bot.conversations.reset(conversationMatch[2])) throw new HttpError(404, '会话不存在');
            return send(200, { ok: true });
          }
          if (!conversationMatch[3] && req.method === 'GET') {
            const before = requestUrl.searchParams.get('before');
            if (before !== null && (!/^\d{1,16}$/.test(before) || !Number.isSafeInteger(Number(before)) || Number(before) < 1)) throw new HttpError(400, '消息分页参数无效');
            const detail = bot.conversations[conversationMatch[1] === 'chat-threads' ? 'thread' : 'detail'](conversationMatch[2], before === null ? null : Number(before));
            if (!detail) throw new HttpError(404, '会话不存在');
            return send(200, detail);
          }
        }
        const logMatch = /^\/api\/logs\/([a-f0-9-]{36})$/.exec(path);
        if (logMatch && req.method === 'GET') {
          const detail = bot.logDetail(logMatch[1]);
          if (!detail) throw new HttpError(404, '这条日志已过期或不存在，请刷新日志列表');
          return send(200, detail);
        }
        if (path === '/api/models' && req.method === 'GET') {
          const legacy = modelConfig({ ...store.config, modelRoutes: {} });
          try { return send(200, { models: await bot.models(legacy), savedModel: legacy.model }); }
          catch (error) { throw new HttpError(502, error.message); }
        }
        if (path === '/api/napcat/status' && req.method === 'GET') return send(200, await napcat.status());
        if (path === '/api/napcat/connect' && req.method === 'POST') {
          const input = parseJSON(await body(req));
          if (input.totpCode && (typeof input.totpCode !== 'string' || !/^\d{6}$/.test(input.totpCode))) throw new HttpError(400, '动态验证码需为 6 位数字');
          try { return send(200, await napcat.connect(input.totpCode)); } catch (error) { throw new HttpError(502, error.message); }
        }
        if (path === '/api/napcat/refresh' && req.method === 'POST') return send(200, await napcat.status(true));
        if (path === '/api/napcat/qrcode' && req.method === 'POST') {
          const input = parseJSON(await body(req));
          if (input.refresh !== undefined && typeof input.refresh !== 'boolean') throw new HttpError(400, '二维码刷新参数错误');
          try { return send(200, await napcat.qrcode(input.refresh === true)); } catch (error) { throw new HttpError(502, error.message); }
        }
        if (path === '/api/webhook-token' && req.method === 'POST') return send(200, { token: store.config.webhookToken });
        if (path === '/api/test-onebot' && req.method === 'POST') {
          try {
            const data = await bot.onebot('get_login_info');
            if (!data?.user_id) throw new Error('NapCat 尚未登录 QQ');
            bot.log('success', 'NapCat 连接测试成功');
            return send(200, { userId: String(data.user_id), nickname: data.nickname || '' });
          } catch (error) { throw new HttpError(502, error.message); }
        }
        if (path === '/api/test-deepseek' && req.method === 'POST') {
          if (bot.testing) throw new HttpError(429, '模型测试正在进行，请稍候');
          bot.testing = true;
          const detail = { receivedMessage: '请只回复“连接成功”。', replyMessage: '', replyStatus: 'generating', model: modelConfig(store.config).model, source: 'model_test' };
          const start = Date.now(), entry = bot.log('info', '正在测试模型 API 连接', { deepseekCalled: false, promptTokens: 0, completionTokens: 0, tokens: 0 }, detail);
          try {
            const answer = await bot.completion('请只回复“连接成功”。', store.config, entry);
            Object.assign(detail, { replyMessage: answer.text.slice(0, 20000), replyStatus: 'test_completed' });
            Object.assign(entry, { level: 'success', message: '模型 API 连接测试成功' });
            return send(200, { text: answer.text.slice(0, 1000), tokens: answer.tokens });
          } catch (error) { detail.replyStatus = 'failed'; Object.assign(entry, { level: 'error', message: `模型 API 连接测试失败：${error.message}` }); throw new HttpError(502, error.message); }
          finally { entry.duration = Date.now() - start; bot.testing = false; }
        }
        if (path === '/api/totp/setup' && req.method === 'POST') {
          if (store.admin.totp?.enabled) throw new HttpError(400, '已启用两步验证，如需更换密钥请先关闭');
          limitAction(`totp:${id}`, 10);
          const now = Date.now();
          for (const [k, entry] of pendingTotp) if (entry.expiresAt <= now) pendingTotp.delete(k);
          if (!pendingTotp.has(id) && pendingTotp.size >= 32) throw new HttpError(429, '待绑定会话过多，请稍后重试');
          const secret = generateTotpSecret();
          const otpauthUrl = totpUri({ secret, username: store.admin.username });
          pendingTotp.set(id, { secret, expiresAt: now + 10 * 60 * 1000 });
          return send(200, { secret, otpauthUrl });
        }
        if (path === '/api/totp/enable' && req.method === 'POST') {
          const input = parseJSON(await body(req));
          await assertCurrentPassword(req, input.currentPassword);
          const pending = pendingTotp.get(id);
          if (!pending || pending.expiresAt <= Date.now()) {
            pendingTotp.delete(id);
            throw new HttpError(400, 'TOTP 绑定已过期，请重新生成二维码');
          }
          const code = typeof input.code === 'string' ? input.code.trim() : '';
          if (!verifyTotpCode(pending.secret, code)) throw new HttpError(400, '动态验证码无效，请核对手机时间后重试');
          const { codes, hashes } = generateRecoveryCodes(6);
          store.enableTotp(pending.secret, hashes);
          pendingTotp.delete(id);
          sessions.clear();
          const next = sessions.create(store.admin, false);
          bot.log('success', '管理员已启用两步验证（TOTP）');
          return send(200, { ok: true, totpEnabled: true, recoveryCodes: codes }, { 'Set-Cookie': cookie(next.id) });
        }
        if (path === '/api/totp/disable' && req.method === 'POST') {
          const input = parseJSON(await body(req));
          await assertCurrentPassword(req, input.currentPassword);
          if (!store.admin.totp?.enabled) throw new HttpError(400, '当前未启用两步验证');
          const code = typeof input.code === 'string' ? input.code.trim() : '';
          if (!code || code.length > 32 || (!verifyTotpCode(store.admin.totp.secret, code) && !store.consumeRecoveryCode(code))) {
            throw new HttpError(400, '动态验证码或恢复码错误');
          }
          store.disableTotp();
          sessions.clear();
          const next = sessions.create(store.admin, false);
          bot.log('warn', '管理员已关闭两步验证（TOTP）');
          return send(200, { ok: true, totpEnabled: false }, { 'Set-Cookie': cookie(next.id) });
        }
        if (path === '/api/backup/export' && req.method === 'POST') {
          limitAction(`backup:${id}`, 5);
          const input = parseJSON(await body(req));
          await assertCurrentPassword(req, input.currentPassword);
          const backupPassword = typeof input.backupPassword === 'string' ? input.backupPassword : '';
          if (backupPassword.length < 8 || backupPassword.length > 256) throw new HttpError(400, '备份加密口令需为 8–256 个字符');
          const tempDir = mkdtempSync(join(tmpdir(), 'qqbot-export-'));
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filename = `qunyu-backup-${stamp}.qqbak.enc`;
            const outPath = join(tempDir, filename);
            createEncryptedBackup(dataDir, backupPassword, outPath);
            const payload = readFileSync(outPath);
            bot.log('info', '管理员已在线导出加密备份');
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${filename}"`,
              'Content-Length': payload.length
            });
            res.end(payload);
            return;
          } finally {
            rmSync(tempDir, { recursive: true, force: true });
          }
        }
        if (path === '/api/password' && req.method === 'POST') {
          const input = parseJSON(await body(req));
          await assertCurrentPassword(req, input.currentPassword, '原密码错误');
          try { await store.changePassword(input.newPassword); } catch (error) { throw new HttpError(400, error.message); }
          sessions.clear(); return send(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
        }
        throw new HttpError(404, '接口不存在');
      }
      const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2' };
      const isAsset = /^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css|svg|png|jpg|webp|woff2?)$/.test(path);
      if (req.method === 'GET' && (path === '/favicon.svg' || isAsset)) {
        const file = join(root, 'dist', path.slice(1));
        if (!existsSync(file)) throw new HttpError(404, '资源不存在');
        res.writeHead(200, { 'Content-Type': `${mimeTypes[extname(file)]}; charset=utf-8` }); res.end(readFileSync(file)); return;
      }
      // 后台是 hash 路由的单页应用：刷新 /index.html 或不带扩展名的地址（如 /chats）时返回入口页，
      // 而不是 JSON 格式的 404，避免页面直接显示 {"error":"页面不存在"}。
      if (req.method === 'GET' && !path.startsWith('/onebot/') && !path.startsWith('/bridge/') && (path === '/' || path === '/index.html' || !extname(path))) {
        const file = join(root, 'dist', 'index.html');
        if (!existsSync(file)) throw new HttpError(503, '请先运行 npm run build 构建 Vue 后台');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(readFileSync(file)); return;
      }
      throw new HttpError(404, '页面不存在');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(error.status || 500, { error: error.status ? error.message : '服务内部错误，请检查数据目录或服务日志' });
      if (!error.status) console.error('[server]', error.code || error.name);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  if (options.bilibiliAutoStart !== false) server.once('listening', () => bilibili.start());
  if (options.douyinAutoStart !== false) server.once('listening', () => douyin.start());
  if (options.checkinAutoStart !== false) server.once('listening', () => checkin.start());
  if (options.healthPlannerAutoStart !== false) server.once('listening', () => healthPlanner.start());
  if (options.subscriptionAutoStart !== false) server.once('listening', () => subscriptions.start());
  if (options.scheduledChatAutoStart !== false) server.once('listening', () => bot.scheduledChat.start());
  if (options.serverStatusAutoStart !== false) server.once('listening', () => resources.start());
  if (options.operationsAutoStart !== false) server.once('listening', () => operations.start());
  server.on('close', () => { emailAlerts.close(); operations.close(); resources.close(); subscriptions.close(); bilibili.close(); douyin.close(); funStore.close(); healthPlanner.close(); bot.close(); sessions.close(); });
  return { server, store, bot, napcat, operations, bilibili, douyin, checkin, healthPlanner, healthPlannerStore, subscriptions, health, emailAlerts, gameCalendar, tokenUsage, tavern, fun: funService, funStore, sessions, resources, dataDir, instanceId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const app = await createApplication();
    const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 3080);
    app.server.on('error', error => {
      if (error.code === 'EADDRINUSE') {
        console.error(`启动失败：端口 ${port} 已被占用，已有程序在使用该端口。`);
        console.error(`如果机器人后台已在运行，请直接打开 http://${host}:${port}。`);
        console.error('如需在当前终端运行，请先在原终端按 Ctrl+C 停止已有后台，再执行 npm start。');
      } else {
        console.error('启动失败：', error.code || error.message);
      }
      app.resources.close(); app.subscriptions.close(); app.bilibili.close(); app.douyin.close(); app.bot.close(); app.sessions.close();
      process.exitCode = 1;
    });
    app.server.listen(port, host, () => {
      const listeningPort = app.server.address().port;
      app.server.once('close', registerRuntime(app.dataDir, listeningPort, app.instanceId));
      console.log(`QQ Bot 管理后台：http://${host}:${listeningPort}`);
      console.log(app.store.setupRequired ? '首次使用：打开后台页面，设置管理员账号和密码。' : '使用已设置的管理员账号和密码登录。');
    });
    const stop = () => { app.resources.close(); app.subscriptions.close(); app.bilibili.close(); app.douyin.close(); app.bot.close(); app.server.close(); app.server.closeIdleConnections(); setTimeout(() => process.exit(0), 5000).unref(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error('启动失败：', error.message); process.exitCode = 1; }
}

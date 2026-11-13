import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { validateModelProfiles, validateModelRoutes, publicModelLibrary, emptyModelRoutes } from './model-library.mjs';
import { quarantineCorruptFile } from './security.mjs';
import { hashRecoveryCode } from './totp.mjs';

const derive = promisify(scrypt);
export const adminUsername = 'admin';
export function validateAdminCredentials(username, password) {
  if (typeof username !== 'string' || !/^[\p{L}\p{N}_.@-]{3,64}$/u.test(username)) throw new Error('账号需为 3–64 个字符，可使用文字、数字、下划线、点、@ 和短横线');
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) throw new Error('密码长度需为 8–256 个字符');
}
export const token = () => randomBytes(32).toString('hex');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
export function writePrivate(path, value) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await derive(password, salt, 64)).toString('hex') };
}
export async function verifyPassword(password, record) {
  return safeEqual((await derive(password, record.salt, 64)).toString('hex'), record.hash);
}
export const defaultScheduledChatTimes = Object.freeze(['12:00', '15:00', '18:00']);
export function normalizeScheduledChatTimes(value) {
  if (!Array.isArray(value) || !value.length || value.length > 24 || value.some(time => typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new Error('定时聊天时间需为 1–24 个 HH:MM 格式的北京时间，例如 12:00');
  return [...new Set(value)].sort();
}
export function defaultConfig() {
  return {
    enabled: false,
    musicEnabled: true,
    onebotUrl: 'http://127.0.0.1:3000',
    onebotToken: '',
    napcatUrl: 'http://127.0.0.1:6099',
    napcatToken: '',
    webhookToken: token(),
    botId: '',
    apiProvider: 'deepseek',
    modelProfiles: [],
    modelRoutes: emptyModelRoutes(),
    modelFallbackEnabled: true,
    modelFallbackProfileId: '',
    openaiUrl: 'https://api.openai.com/v1',
    openaiKey: '',
    openaiModel: 'gpt-4.1-mini',
    openaiVisionModel: '',
    openaiReasoningEffort: 'auto',
    openaiMaxTokens: 8192,
    openaiMaxTokensUnlimited: true,
    deepseekUrl: 'https://api.deepseek.com',
    deepseekKey: '',
    model: 'deepseek-flash',
    thinkingEnabled: true,
    reasoningEffort: 'high',
    webSearchEnabled: true,
    imageRecognitionEnabled: true,
    documentGenerationEnabled: true,
    visionModel: 'deepseek-flash',
    linkParsingEnabled: true,
    linkTwitterProxyUrl: '',
    linkMaxVideoMB: 400,
    linkMaxDuration: 480,
    linkTimeoutSeconds: 180,
    linkCooldownSeconds: 10,
    memoryEnabled: true,
    contextTurns: 10,
    animePersonaEnabled: false,
    personaPreset: 'blueFish',
    aemeathImpishEnabled: true,
    personaRoastLevel: 2,
    personaExplicitRoastLevel: 3,
    personaRoastFrequency: 10,
    proactiveChatEnabled: true,
    scheduledChatTimes: [...defaultScheduledChatTimes],
    groupFollowupEnabled: true,
    systemPrompt: '你是一个友好、简洁的 QQ 助手。请用中文回答，优先使用适合聊天阅读的纯文本。',
    allowedGroups: [],
    allowedPrivateUsers: [],
    cooldownSeconds: 5,
    maxTokens: 99999999,
    maxTokensUnlimited: false,
    timeoutSeconds: 180,
    timeoutUnlimited: false,
    maxPromptLength: 4000,
    maxReplyLength: 3000,
    conversationRetentionDays: 0,
    billReportEnabled: false,
    billReportTime: '08:00',
    billReportFrequency: 'weekly',
    consolePublicUrl: '',
    emailAlertsEnabled: false,
    smtpHost: '',
    smtpPort: 465,
    smtpSecure: true,
    smtpUser: '',
    smtpPassword: '',
    emailAlertRecipient: ''
  };
}
// 缺少定时聊天开关的旧白名单沿用开启状态，逐群开关与授权项一起增删。
export function normalizeGroup(value) {
  if (typeof value === 'string') return /^\d{5,20}$/.test(value) ? { id: value, ds: true, video: true, scheduledChat: true } : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!/^\d{5,20}$/.test(id)) return null;
  return { id, ds: value.ds !== false, video: value.video !== false, scheduledChat: value.scheduledChat !== false };
}
export function normalizeGroups(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set(), result = [];
  for (const item of list) {
    const rule = normalizeGroup(item);
    if (!rule || seen.has(rule.id)) continue;
    seen.add(rule.id); result.push(rule);
  }
  return result;
}
export const scheduledChatGroups = config => normalizeGroups(config.allowedGroups).filter(g => g.ds && g.scheduledChat).map(g => g.id);
export function normalizePrivateUsers(value) {
  return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string').map(id => id.trim()).filter(id => /^\d{5,20}$/.test(id)))].slice(0, 500) : [];
}
const secretFields = ['onebotToken', 'deepseekKey', 'openaiKey', 'webhookToken', 'napcatToken', 'smtpPassword'];
export function publicConfig(config) {
  const result = { ...config };
  result.modelProfiles = publicModelLibrary(config).profiles;
  for (const key of secretFields) {
    delete result[key];
    result[`${key}Configured`] = Boolean(config[key]);
  }
  result.modelApiKeyConfigured = Boolean(config.apiProvider === 'openai' ? config.openaiKey : config.deepseekKey);
  result.activeModel = config.apiProvider === 'openai' ? config.openaiModel : config.model;
  const bound = config.modelProfiles?.find(p => p.id === config.modelRoutes?.chat);
  if (bound) { result.modelApiKeyConfigured = Boolean(bound.apiKey); result.activeModel = bound.model; }
  result.activeProvider = bound?.provider || config.apiProvider;
  return result;
}
function validUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} 不是有效 URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} 只支持不含账号、查询参数的 HTTP(S) 地址`);
  }
  if (['DeepSeek 地址', 'OpenAI 地址'].includes(name) && url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`远程 ${name}必须使用 HTTPS`);
  }
  return url.href.replace(/\/+$/, '');
}
export function validatePatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('配置格式错误');
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(current, key) || key === 'webhookToken') throw new Error(`不支持的配置项：${key}`);
    if (key === 'smtpPassword' && typeof value === 'string' && !value.trim()) continue;
    if (key === 'modelProfiles') { next.modelProfiles = validateModelProfiles(value, current.modelProfiles); continue; }
    if (key === 'modelRoutes') { next.modelRoutes = value; continue; }
    if (['enabled', 'musicEnabled', 'thinkingEnabled', 'webSearchEnabled', 'memoryEnabled', 'imageRecognitionEnabled', 'documentGenerationEnabled', 'linkParsingEnabled', 'animePersonaEnabled', 'aemeathImpishEnabled', 'proactiveChatEnabled', 'groupFollowupEnabled', 'maxTokensUnlimited', 'openaiMaxTokensUnlimited', 'timeoutUnlimited', 'modelFallbackEnabled', 'emailAlertsEnabled', 'smtpSecure', 'billReportEnabled'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`);
    } else if (key === 'scheduledChatTimes') {
      next.scheduledChatTimes = normalizeScheduledChatTimes(value);
      continue;
    } else if (key === 'allowedGroups') {
      if (!Array.isArray(value) || value.length > 500) throw new Error('群白名单应为数组（最多 500 个群）');
      for (const item of value) {
        if (!normalizeGroup(item)) throw new Error('群白名单每项需要 5–20 位群号，并可单独设置是否调用模型、是否解析视频');
        if (typeof item === 'object' && item !== null) {
          if (item.ds !== undefined && typeof item.ds !== 'boolean') throw new Error('群白名单的模型开关必须是布尔值');
          if (item.video !== undefined && typeof item.video !== 'boolean') throw new Error('群白名单的视频开关必须是布尔值');
          if (item.scheduledChat !== undefined && typeof item.scheduledChat !== 'boolean') throw new Error('群白名单的定时聊天开关必须是布尔值');
        }
      }
      const previous = new Map(normalizeGroups(current.allowedGroups).map(rule => [rule.id, rule]));
      next.allowedGroups = normalizeGroups(value).map(rule => {
        const input = value.find(item => (typeof item === 'string' ? item : item.id.trim()) === rule.id);
        return typeof input === 'object' && Object.hasOwn(input, 'scheduledChat') ? rule : { ...rule, scheduledChat: previous.get(rule.id)?.scheduledChat ?? true };
      });
      continue;
    } else if (key === 'allowedPrivateUsers') {
      if (!Array.isArray(value) || value.length > 500 || value.some(id => typeof id !== 'string' || !/^\d{5,20}$/.test(id.trim()))) {
        throw new Error('私聊白名单应为 QQ 号数组，每项为 5–20 位数字，最多 500 个账号');
      }
      next.allowedPrivateUsers = normalizePrivateUsers(value);
      continue;
    } else if (typeof current[key] === 'number') {
      const limits = { personaRoastLevel: [0, 4], personaExplicitRoastLevel: [0, 4], personaRoastFrequency: [0, 100], cooldownSeconds: [0, 3600], maxTokens: [64, 99999999], openaiMaxTokens: [64, 99999999], timeoutSeconds: [5, 180], maxPromptLength: [1, 20000], maxReplyLength: [100, 10000], contextTurns: [1, 50], conversationRetentionDays: [0, 3650], linkMaxVideoMB: [1, 400], linkMaxDuration: [10, 1800], linkTimeoutSeconds: [30, 600], linkCooldownSeconds: [0, 3600], smtpPort: [1, 65535] };
      const [min, max] = limits[key];
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 必须为 ${min}–${max} 的整数`);
    } else if (typeof value !== 'string' || value.length > (key === 'systemPrompt' ? 12000 : 2048)) {
      throw new Error(`${key} 格式错误或过长`);
    }
    next[key] = typeof value === 'string' ? value.trim() : value;
  }
  next.modelRoutes = validateModelRoutes(next.modelRoutes, next.modelProfiles);
  if (!['blueFish', 'aemeath'].includes(next.personaPreset)) throw new Error('请选择蓝色大肥鱼或爱弥斯性格');
  next.onebotUrl = validUrl(next.onebotUrl, 'OneBot 地址');
  next.napcatUrl = validUrl(next.napcatUrl, 'NapCat 管理地址');
  next.deepseekUrl = validUrl(next.deepseekUrl, 'DeepSeek 地址');
  if (!['deepseek', 'openai'].includes(next.apiProvider)) throw new Error('API 服务商必须为 DeepSeek 或 OpenAI');
  next.openaiUrl = validUrl(next.openaiUrl, 'OpenAI 地址');
  const openaiUrl = new URL(next.openaiUrl);
  if (openaiUrl.hostname === 'api.openai.com' && openaiUrl.pathname === '/') next.openaiUrl += '/v1';
  if (/\/(chat\/completions|responses|models)$/.test(next.openaiUrl)) throw new Error('请填写 OpenAI 基础地址（通常以 /v1 结尾），不要附加接口路径');
  if (current.openaiKey && new URL(current.openaiUrl).origin !== new URL(next.openaiUrl).origin && !patch.openaiKey?.trim()) throw new Error('更换 OpenAI 服务地址时，请重新填写该服务的 API Key');
  if (!next.openaiModel || next.openaiModel.length > 100 || next.openaiVisionModel.length > 100) throw new Error('请输入有效的 OpenAI 模型名称（最多 100 个字符）');
  if (!['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(next.openaiReasoningEffort)) throw new Error('OpenAI 思考强度无效');
  if (next.linkTwitterProxyUrl) {
    let proxy;
    try { proxy = new URL(next.linkTwitterProxyUrl); } catch { throw new Error('X / Twitter 代理地址无效'); }
    if (proxy.protocol !== 'socks5:' || !proxy.hostname || !proxy.port || Number(proxy.port) < 1 || proxy.username || proxy.password
      || (proxy.pathname && proxy.pathname !== '/') || proxy.search || proxy.hash || /[\r\n]/.test(next.linkTwitterProxyUrl)) {
      throw new Error('X / Twitter 代理需为不含账号或路径的 socks5://主机:端口 地址');
    }
    next.linkTwitterProxyUrl = proxy.href.replace(/\/$/, '');
  }
  if (next.botId && !/^\d{5,20}$/.test(next.botId)) throw new Error('机器人 QQ 号格式错误');
  if (!next.model || next.model.length > 100) throw new Error('请输入有效模型名称');
  if (!next.visionModel || next.visionModel.length > 100) throw new Error('请输入有效识图模型名称');
  if (!['low', 'high', 'max'].includes(next.reasoningEffort)) throw new Error('思考强度必须为 low、high 或 max');
  if (/[\r\n]/.test(next.onebotToken + next.deepseekKey + next.openaiKey + next.napcatToken + next.smtpPassword)) throw new Error('密钥不能包含换行');
  if (next.smtpHost && !/^[a-z0-9.-]+$/i.test(next.smtpHost)) throw new Error('SMTP 主机只填写域名或 IP，不要包含协议、路径或账号');
  if (next.emailAlertRecipient && (next.emailAlertRecipient.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.emailAlertRecipient))) throw new Error('告警收件邮箱格式无效');
  if (/[\r\n]/.test(next.smtpHost + next.smtpUser + next.emailAlertRecipient)) throw new Error('SMTP 配置不能包含换行');
  if ((next.emailAlertsEnabled || next.billReportEnabled) && (!next.smtpHost || !next.smtpUser || !next.smtpPassword || !next.emailAlertRecipient)) throw new Error('启用邮件通知或每周账单前，请完整填写 SMTP 主机、账号、授权码和收件邮箱');
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(next.billReportTime)) throw new Error('账单时间应为 HH:MM');
  if (next.billReportFrequency !== 'weekly') throw new Error('账单周期无效');
  if (next.consolePublicUrl) next.consolePublicUrl = validUrl(next.consolePublicUrl, '后台外网地址');
  if (next.modelFallbackProfileId && !next.modelProfiles.some(p => p.id === next.modelFallbackProfileId)) throw new Error('备用模型不存在');
  const smtpConnectionChanged = ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser'].some(key => next[key] !== current[key]);
  if (current.smtpPassword && smtpConnectionChanged && !patch.smtpPassword?.trim()) throw new Error('修改 SMTP 连接或账号后，请重新填写授权码');
  return next;
}
export async function openStore(dataDir, initialPassword = '') {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const configPath = join(dataDir, 'config.json'), adminPath = join(dataDir, 'admin.json');
  let savedConfig = {};
  if (existsSync(configPath)) {
    try { savedConfig = JSON.parse(readFileSync(configPath, 'utf8')); }
    catch (error) {
      const backup = quarantineCorruptFile(configPath);
      console.error(`[config] config.json 已损坏，已隔离至 ${backup || configPath} 并回退默认配置: ${error.message}`);
    }
  }
  let config = { ...defaultConfig(), ...savedConfig };
  config.billReportFrequency = 'weekly';
  delete config.billReportRecipient;
  // 本次输出预算调整只迁移一次，之后保留管理员保存的数字或无上限模式。
  if (!Object.hasOwn(savedConfig, 'maxTokensUnlimited')) config.maxTokens = 99999999;
  // 随机冒泡已替换为北京时间固定三次，不再使用旧的最短间隔配置。
  delete config.proactiveIntervalMinutes;
  config.scheduledChatTimes = normalizeScheduledChatTimes(config.scheduledChatTimes);
  // 旧版白名单是纯群号字符串，读取时统一升级为带每群开关的对象并写回。
  config = { ...config, allowedGroups: normalizeGroups(config.allowedGroups), allowedPrivateUsers: normalizePrivateUsers(config.allowedPrivateUsers) };
  writePrivate(configPath, config);
  let admin = null, initializing = false;
  if (existsSync(adminPath)) {
    try { admin = JSON.parse(readFileSync(adminPath, 'utf8')); }
    catch (error) { throw new Error(`管理员凭据文件 ${adminPath} 已损坏，请从备份恢复后重启: ${error.message}`); }
    // Only accounts from the password-only era need a legacy name. Preserve custom names.
    if (!admin.username) { admin = { ...admin, username: adminUsername }; writePrivate(adminPath, admin); }
  }
  else if (initialPassword) {
    const password = initialPassword;
    if (password.length < 8 || password.length > 256) throw new Error('ADMIN_PASSWORD 需要 8–256 个字符');
    admin = { username: adminUsername, ...await passwordHash(password) };
    writePrivate(adminPath, admin);
  }
  return {
    get config() { return config; },
    get admin() { return admin; },
    get setupRequired() {
      if (!admin && existsSync(adminPath)) admin = JSON.parse(readFileSync(adminPath, 'utf8'));
      return !admin;
    },
    async setupAdmin(username, password) {
      const conflict = () => Object.assign(new Error('管理账号已创建或正在创建，请使用已设置的账号登录'), { code: 'ADMIN_EXISTS' });
      if (admin || initializing || existsSync(adminPath)) throw conflict();
      validateAdminCredentials(username, password);
      initializing = true;
      try {
        const next = { username, ...await passwordHash(password) };
        try { writeFileSync(adminPath, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code === 'EEXIST') { admin = JSON.parse(readFileSync(adminPath, 'utf8')); throw conflict(); } throw error; }
        admin = next;
      } finally { initializing = false; }
    },
    save(patch) { const next = validatePatch(config, patch); writePrivate(configPath, next); config = next; return publicConfig(config); },
    async changePassword(password) {
      if (typeof password !== 'string' || password.length < 8 || password.length > 256) throw new Error('密码长度需为 8–256 个字符');
      if (!admin) throw new Error('请先在首次配置页面创建管理员');
      const next = { username: admin.username, ...await passwordHash(password), ...(admin.totp ? { totp: admin.totp } : {}) }; writePrivate(adminPath, next); admin = next;
      const initial = join(dataDir, 'initial-password.txt'); if (existsSync(initial)) unlinkSync(initial);
    },
    enableTotp(secret, recoveryHashes = []) {
      if (!admin) throw new Error('请先创建管理员账号');
      const next = { ...admin, totp: { enabled: true, secret, recoveryHashes, enabledAt: new Date().toISOString() } };
      writePrivate(adminPath, next); admin = next;
    },
    disableTotp() {
      if (!admin || !admin.totp) return;
      const { totp: _removed, ...rest } = admin;
      writePrivate(adminPath, rest); admin = rest;
    },
    consumeRecoveryCode(input) {
      if (!admin?.totp?.enabled || !Array.isArray(admin.totp.recoveryHashes)) return false;
      const candidateHash = hashRecoveryCode(input);
      const index = admin.totp.recoveryHashes.findIndex(hash => safeEqual(hash, candidateHash));
      if (index === -1) return false;
      const remaining = admin.totp.recoveryHashes.filter((_, idx) => idx !== index);
      const next = { ...admin, totp: { ...admin.totp, recoveryHashes: remaining } };
      writePrivate(adminPath, next); admin = next;
      return true;
    }
  };
}

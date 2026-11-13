import { computed, nextTick, onMounted, onUnmounted, reactive } from 'vue';
import QRCode from 'qrcode';
import { removeGroupRequest } from '../utils/subscriptionGroups.js';
import { copyDraft, sameDraft, mergeDraft, draftConflicts, mergeGroupDraft, mergePrivateDraft } from '../utils/drafts.js';

export const consoleKey = Symbol('qq-bot-console');
export const pageNames = { overview: '运行概览', connection: 'QQ 连接', model: '模型与回复', tavern: '酒馆角色', live: '实时任务', whitelist: '白名单', plugins: '插件', chats: '聊天记录', logs: '运行日志', security: '账号安全' };
export const logLabels = { info: '信息', success: '成功', warn: '提醒', error: '错误' };
export const timeText = value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });

const connectionFields = ['onebotUrl', 'onebotToken', 'botId', 'napcatUrl', 'napcatToken'];
const modelFields = ['apiProvider', 'openaiUrl', 'openaiKey', 'openaiModel', 'openaiVisionModel', 'openaiReasoningEffort', 'openaiMaxTokens', 'openaiMaxTokensUnlimited', 'deepseekUrl', 'deepseekKey', 'model', 'thinkingEnabled', 'reasoningEffort', 'webSearchEnabled', 'imageRecognitionEnabled', 'visionModel', 'documentGenerationEnabled', 'memoryEnabled', 'contextTurns', 'cooldownSeconds', 'maxTokens', 'maxTokensUnlimited', 'timeoutSeconds', 'timeoutUnlimited', 'maxPromptLength', 'maxReplyLength'];
const linkFields = ['linkParsingEnabled', 'linkTwitterProxyUrl', 'linkMaxVideoMB', 'linkMaxDuration', 'linkTimeoutSeconds', 'linkCooldownSeconds'];
const emailFields = ['emailAlertsEnabled', 'smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPassword', 'emailAlertRecipient'];
const numericFields = new Set(['personaRoastLevel', 'personaExplicitRoastLevel', 'personaRoastFrequency', 'cooldownSeconds', 'maxTokens', 'openaiMaxTokens', 'timeoutSeconds', 'maxPromptLength', 'maxReplyLength', 'contextTurns', 'linkMaxVideoMB', 'linkMaxDuration', 'linkTimeoutSeconds', 'linkCooldownSeconds', 'smtpPort']);
const booleanFields = new Set(['thinkingEnabled', 'webSearchEnabled', 'memoryEnabled', 'imageRecognitionEnabled', 'documentGenerationEnabled', 'linkParsingEnabled', 'animePersonaEnabled', 'aemeathImpishEnabled', 'proactiveChatEnabled', 'groupFollowupEnabled', 'maxTokensUnlimited', 'openaiMaxTokensUnlimited', 'timeoutUnlimited', 'emailAlertsEnabled', 'smtpSecure']);
const newSubscription = () => ({ name: '', type: 'github', source: '', groups: [], enabled: true, include: '', exclude: '', crossPlatformMatch: true });
export const defaultChatTimes = Object.freeze(['12:00', '15:00', '18:00']);
// 保留插件的逐群开关；未保存的白名单草稿不作为定时聊天的目标。
export function normalizeGroupRule(value) {
  if (typeof value === 'string') return /^\d{5,20}$/.test(value) ? { id: value, ds: true, video: true, scheduledChat: true } : null;
  const id = String(value?.id ?? '').trim();
  if (!/^\d{5,20}$/.test(id)) return null;
  return { id, ds: value.ds !== false, video: value.video !== false, scheduledChat: value.scheduledChat !== false };
}
export function configPatch(draft, fields) {
  return Object.fromEntries(fields.filter(key => !['onebotToken', 'deepseekKey', 'openaiKey', 'napcatToken', 'smtpPassword'].includes(key) || draft[key]?.trim())
    .map(key => [key, booleanFields.has(key) ? draft[key] : numericFields.has(key) ? Number(draft[key]) : String(draft[key] ?? '').trim()]));
}

export function useConsole() {
  const state = reactive({
    ready: false, authenticated: false, adminSetupRequired: false, adminUsername: '', totpEnabled: false, adminSetup: { username: '', password: '', confirmPassword: '' }, adminSetupError: '', page: 'overview', config: {}, status: {}, setupKey: '', setupProvider: 'deepseek', setupError: '',
    connection: {}, model: {}, privateUsers: [], privateDraft: '', groupRules: [], groupDraft: { id: '', ds: true, video: true }, loginUsername: '', loginPassword: '', loginRemember: true, loginRequiresTotp: false, loginTotpCode: '', loginError: '',
    password: { currentPassword: '', newPassword: '', confirmPassword: '' },
    totpSetup: { qrDataUrl: '', secret: '', otpauthUrl: '', currentPassword: '', code: '', recoveryCodes: [] },
    totpDisable: { currentPassword: '', code: '' },
    backupExport: { currentPassword: '', backupPassword: '' },
    retentionDays: '0',
    chatPrune: { mode: 'days', days: '30', groupId: '', userId: '' },
    busy: {}, toast: null, refreshMessage: '实时更新', filter: 'all', webhookToken: '',
    onebotResult: '', onebotError: false, deepseekResult: '', deepseekError: false,
    napcat: null, qrcode: null, qrError: '', totpCode: '',
    models: [], modelsError: '', modelsLoaded: false, modelsSource: '',
    pluginDetail: '', modelTab: 'library', whitelistTab: 'groups', liveTasks: null, liveSelectedId: '', liveError: '', scheduledChatTimes: null, linkSettings: {}, linkStatus: null, linkStatusError: '', health: null, healthError: '', healthEmail: {}, healthEmailResult: '', healthEmailError: false,
    checkin: null, checkinSettings: null, checkinConflict: false, checkinError: '', checkinView: 'settings',
    subscriptions: null, subscriptionSettings: null, subscriptionConflict: false, subscriptionError: '', subscriptionDraft: newSubscription(), subscriptionEditId: '', subscriptionPreview: null,
    gameCalendar: null, gameCalendarSettings: null, gameCalendarError: '',
    fun: null, funSettings: null, funError: '', funQuotes: [], funQuotesLoading: false,
    healthPlanner: null, healthPlannerSettings: null, healthPlannerError: '',
    linkCookiePlatform: 'bilibili', linkCookieContent: '', linkCookieError: '',
    bilibili: null, bilibiliQr: null, bilibiliError: '',
    douyin: null, douyinQr: null, douyinError: '',
    douyinVerification: null, douyinVerificationError: '', douyinVerificationNotice: '',
    logDetailId: '', logDetail: null, logDetailLoading: false, logDetailError: '',
    conversations: [], conversationsTotal: 0, conversationsHasMore: false, conversationListLoading: false,
    chatSearch: '', chatActiveSearch: '', chatListError: '', conversationId: '', conversation: null, chatLoading: false, chatError: '', confirmation: null
  });
  let pollTimer, liveTimer, toastTimer, refreshing = false, generation = 0, disposed = false, napcatLoading = false, napcatGeneration = 0, confirmationResolve = null;
  let liveRevision = 0, liveRequestId = 0, liveInFlight = false, configRevision = 0, configWrites = 0, subscriptionEditRevision = 0, previewRevision = 0, healthGeneration = 0, healthLastLoad = 0;
  let detailGeneration = 0;
  const settingsRevision = { checkin: 0, subscriptions: 0, 'game-calendar': 0, fun: 0, 'health-planner': 0 }, settingsWrites = { checkin: 0, subscriptions: 0, 'game-calendar': 0, fun: 0, 'health-planner': 0 };
  let chatListGeneration = 0, chatGeneration = 0;

  function notify(message, error = false) {
    state.toast = { message, error };
    clearTimeout(toastTimer); toastTimer = setTimeout(() => state.toast = null, 4500);
  }
  function askConfirmation(options) {
    if (confirmationResolve) resolveConfirmation(false);
    return new Promise(resolve => { confirmationResolve = resolve; state.confirmation = { tone: 'default', ...options }; });
  }
  function resolveConfirmation(value) {
    const resolve = confirmationResolve;
    confirmationResolve = null; state.confirmation = null;
    resolve?.(value);
  }
  function showLogin() {
    resolveConfirmation(false);
    generation++; clearTimeout(pollTimer); clearTimeout(liveTimer); liveRevision++; liveRequestId++; liveInFlight = false; state.busy.live = false;
    state.authenticated = false; state.adminUsername = ''; state.config = {}; state.status = {};
    state.adminSetup = { username: '', password: '', confirmPassword: '' }; state.adminSetupError = '';
    state.connection = {}; state.model = {}; state.privateUsers = []; state.privateDraft = ''; state.groupRules = []; state.groupDraft = { id: '', ds: true, video: true }; state.webhookToken = '';
    state.loginUsername = ''; state.loginPassword = ''; state.loginRemember = true; state.loginRequiresTotp = false; state.loginTotpCode = ''; state.loginError = ''; state.onebotResult = ''; state.deepseekResult = '';
    state.totpEnabled = false;
    state.totpSetup = { qrDataUrl: '', secret: '', otpauthUrl: '', currentPassword: '', code: '', recoveryCodes: [] };
    state.totpDisable = { currentPassword: '', code: '' };
    state.backupExport = { currentPassword: '', backupPassword: '' };
    state.retentionDays = '0';
    state.chatPrune = { mode: 'days', days: '30', groupId: '', userId: '' };
    state.setupKey = ''; state.setupProvider = 'deepseek'; state.setupError = '';
    state.password = { currentPassword: '', newPassword: '', confirmPassword: '' };
    state.napcat = null; state.qrcode = null; state.qrError = ''; state.totpCode = ''; napcatGeneration++;
    state.models = []; state.modelsError = ''; state.modelsLoaded = false; state.modelsSource = '';
    state.pluginDetail = ''; state.modelTab = 'library'; state.scheduledChatTimes = null; state.linkSettings = {}; state.linkStatus = null; state.linkStatusError = ''; state.health = null; state.healthError = ''; state.healthEmail = {}; state.healthEmailResult = ''; healthGeneration++;
    state.whitelistTab = 'groups'; state.liveTasks = null; state.liveSelectedId = ''; state.liveError = '';
    state.checkin = null; state.checkinSettings = null; state.checkinConflict = false; state.checkinError = ''; state.checkinView = 'settings';
    state.subscriptions = null; state.subscriptionSettings = null; state.subscriptionConflict = false; state.subscriptionError = ''; state.subscriptionDraft = newSubscription(); state.subscriptionEditId = ''; state.subscriptionPreview = null; subscriptionEditRevision++; previewRevision++;
    state.gameCalendar = null; state.gameCalendarSettings = null; state.gameCalendarError = '';
    state.fun = null; state.funSettings = null; state.funError = ''; state.funQuotes = []; state.funQuotesLoading = false;
    state.healthPlanner = null; state.healthPlannerSettings = null; state.healthPlannerError = '';
    state.linkCookieContent = ''; state.linkCookieError = ''; state.linkCookiePlatform = 'bilibili';
    state.bilibili = null; state.bilibiliQr = null; state.bilibiliError = '';
    state.douyin = null; state.douyinQr = null; state.douyinError = '';
    state.douyinVerification = null; state.douyinVerificationError = ''; state.douyinVerificationNotice = '';
    closeLogDetail();
    chatListGeneration++; chatGeneration++;
    state.conversations = []; state.conversationsTotal = 0; state.conversationsHasMore = false;
    state.conversationId = ''; state.conversation = null; state.chatLoading = false; state.conversationListLoading = false;
    state.chatSearch = ''; state.chatActiveSearch = ''; state.chatListError = ''; state.chatError = '';
  }
  async function api(path, options = {}) {
    const settingsScope = ['checkin', 'subscriptions', 'game-calendar'].find(scope => path === scope || path.startsWith(scope + '/'));
    const writesSettings = settingsScope && ['PUT', 'POST'].includes(options.method) && !path.endsWith('/preview');
    if (writesSettings) { settingsRevision[settingsScope]++; settingsWrites[settingsScope]++; }
    const writesConfig = (path === 'config' || path.startsWith('scheduled-chat/groups/')) && options.method === 'PUT';
    if (writesConfig) { configRevision++; configWrites++; }
    const controller = new AbortController();
    const timeout = path.endsWith('/check') && path.startsWith('subscriptions/') ? 300000
      : path === 'napcat/qrcode' || path === 'napcat/logout' ? 150000
        : path.endsWith('/preview') || path.endsWith('/probe') || path.endsWith('/sync') || path === 'test-deepseek' ? 120000 : path.startsWith('links/') ? 90000 : 30000;
    let timer;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new Error('请求超时，请刷新状态确认是否已生效后再重试'));
    }, timeout); });
    try {
      return await Promise.race([(async () => {
        let response;
        try {
          response = await fetch(`/api/${path}`, { ...options, signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1', ...options.headers } });
        } catch { throw new Error(controller.signal.aborted ? '请求超时，请刷新状态确认是否已生效后再重试' : '无法连接后台服务，请检查服务是否运行'); }
        let data;
        try { data = await response.json(); } catch { throw new Error('后台返回格式异常，请确认从服务地址访问页面'); }
        if (!response.ok) {
          if (response.status === 401 && path !== 'login') showLogin();
          throw new Error(data.error || '操作失败');
        }
        return data;
      })(), expired]);
    } finally {
      clearTimeout(timer);
      if (writesConfig) { configWrites--; configRevision++; }
      if (writesSettings) { settingsWrites[settingsScope]--; settingsRevision[settingsScope]++; }
    }
  }
  function applyConfig(config, baseline = state.config) {
    state.connection = mergeDraft(state.connection, Object.fromEntries(connectionFields.map(key => [key, baseline[key] ?? ''])),
      Object.fromEntries(connectionFields.map(key => [key, config[key] ?? ''])));
    state.model = mergeDraft(state.model, Object.fromEntries(modelFields.map(key => [key, baseline[key] ?? ''])),
      Object.fromEntries(modelFields.map(key => [key, config[key] ?? ''])));
    state.linkSettings = mergeDraft(state.linkSettings, Object.fromEntries(linkFields.map(key => [key, baseline[key]])),
      Object.fromEntries(linkFields.map(key => [key, config[key]])));
    state.healthEmail = mergeDraft(state.healthEmail, Object.fromEntries(emailFields.map(key => [key, baseline[key] ?? (key === 'smtpPort' ? 465 : key === 'smtpSecure' ? true : '')])),
      Object.fromEntries(emailFields.map(key => [key, config[key] ?? (key === 'smtpPort' ? 465 : key === 'smtpSecure' ? true : '')])));
    state.groupRules = mergeGroupDraft(state.groupRules, (baseline.allowedGroups || []).map(normalizeGroupRule).filter(Boolean),
      (config.allowedGroups || []).map(normalizeGroupRule).filter(Boolean));
    state.privateUsers = mergePrivateDraft(state.privateUsers, baseline.allowedPrivateUsers || [], config.allowedPrivateUsers || []);
    const prevRetention = String(baseline.conversationRetentionDays ?? 0), nextRetention = String(config.conversationRetentionDays ?? 0);
    if (String(state.retentionDays ?? '') === prevRetention) state.retentionDays = nextRetention;
    syncScheduledTimes(config); state.config = config;
  }
  const post = (path, data = {}) => api(path, { method: 'POST', body: JSON.stringify(data) });
  const bindApiKey = () => run('apiKey', async () => {
    state.setupError = '';
    const key = state.setupKey.trim(), version = generation;
    if (!key) { state.setupError = '请填写 API Key'; return; }
    if (/[\r\n]/.test(key)) { state.setupError = 'API Key 不能包含换行'; return; }
    try {
      const config = await post('setup-api-key', { key, provider: state.setupProvider });
      if (version !== generation || disposed) return;
      state.config = config; state.setupKey = '';
      state.model = Object.fromEntries(modelFields.map(key => [key, config[key] ?? '']));
      notify('API Key 已绑定，欢迎进入工作空间'); syncHash(); schedule();
      void loadModels(); void loadNapcat();
    } catch (error) {
      if (version === generation && !disposed) state.setupError = error.message;
    }
  });
  async function loadConversations(more = false, force = false) {
    if (!state.authenticated || (state.conversationListLoading && !force)) return;
    const version = generation, request = ++chatListGeneration;
    const offset = more ? state.conversations.length : 0;
    state.conversationListLoading = true;
    try {
      const data = await api(`chat-threads?search=${encodeURIComponent(state.chatActiveSearch)}&offset=${offset}`);
      if (version !== generation || request !== chatListGeneration || disposed) return;
      const keptOlder = !more && !force && state.conversations.length > 50;
      const freshIds = new Set(data.items.map(item => item.id));
      const ordered = more ? [...state.conversations, ...data.items] : keptOlder
        ? [...data.items, ...state.conversations.filter(item => !freshIds.has(item.id))] : data.items;
      state.conversations = [...new Map(ordered.map(item => [item.id, item])).values()];
      state.conversationsTotal = data.total; state.conversationsHasMore = keptOlder ? state.conversationsHasMore : data.hasMore; state.chatListError = '';
    } catch (error) {
      if (version === generation && request === chatListGeneration && !disposed) state.chatListError = error.message;
    } finally {
      if (version === generation && request === chatListGeneration) state.conversationListLoading = false;
    }
  }
  function searchConversations() {
    state.chatActiveSearch = state.chatSearch.trim(); void loadConversations(false, true);
  }
  async function loadConversation(older = false) {
    if (!state.authenticated || !state.conversationId || state.chatLoading) return;
    const id = state.conversationId, version = generation, request = chatGeneration;
    const before = older ? state.conversation?.turns[0]?.id : null;
    if (older && !before) return;
    state.chatLoading = true;
    try {
      const data = await api(`chat-threads/${id}${before ? `?before=${before}` : ''}`);
      if (version !== generation || request !== chatGeneration || id !== state.conversationId || disposed) return;
      const previous = state.conversation;
      if (!older && previous?.turns.length && data.turns.length) {
        const last = previous.turns.at(-1).id;
        let page = data;
        while (page.hasMore && page.turns.length && page.turns[0].id > last) {
          page = await api(`chat-threads/${id}?before=${page.turns[0].id}`);
          if (version !== generation || request !== chatGeneration || id !== state.conversationId || disposed) return;
          data.turns = [...page.turns, ...data.turns];
          data.hasMore = page.hasMore;
        }
      }
      const turns = [...new Map([...(previous?.turns || []), ...data.turns].map(turn => [turn.id, turn])).values()].sort((a, b) => a.id - b.id);
      const keptOlder = !older && previous?.turns.length && data.turns.length && previous.turns[0].id < data.turns[0].id;
      state.conversation = { ...data, turns, hasMore: keptOlder ? previous.hasMore : data.hasMore }; state.chatError = '';
    } catch (error) {
      if (version === generation && request === chatGeneration && !disposed) state.chatError = error.message;
    } finally { if (version === generation && request === chatGeneration) state.chatLoading = false; }
  }
  function selectConversation(session) {
    if (state.conversationId === session.id) return;
    chatGeneration++; state.conversationId = session.id; state.conversation = null;
    state.chatLoading = false; state.chatError = ''; return loadConversation();
  }
  const resetConversation = async memberId => {
    const member = state.conversation?.members?.find(item => item.id === memberId);
    if (!member || !await askConfirmation({ title: '开启新话题？', description: `将清空 ${member.userName || member.userId} 在当前会话中的模型上下文。`, detail: '历史聊天记录会保留，之后的提问将不再携带当前话题的上下文。', confirmText: '开启新话题', tone: 'danger' })) return;
    return run('chatReset', async () => {
      if (!state.conversationId) return;
      const id = state.conversationId;
      await post(`conversations/${member.id}/reset`);
      notify(`已为 ${member.userName || member.userId} 开启新话题，历史记录已保留`);
      if (id === state.conversationId) { chatGeneration++; state.chatLoading = false; await loadConversation(); }
    });
  };
  const deleteConversation = async targetSession => {
    const item = targetSession || state.conversation?.session;
    if (!item) return;
    const privateChat = item.groupId === 'private';
    const label = privateChat ? `私聊 ${item.userName || item.userId}` : `群聊 ${item.groupId}`;
    if (!await askConfirmation({
      title: '永久删除聊天记录？',
      description: `将从数据库彻底删除「${label}」的全部会话和历史消息。`,
      detail: '此操作不可恢复，同时会整理数据库文件空间。',
      confirmText: '永久删除',
      tone: 'danger'
    })) return;
    return run('chatDelete', async () => {
      const version = generation;
      if (privateChat) await api(`conversations/${item.id}`, { method: 'DELETE' });
      else await post('conversations/prune', { groupId: item.groupId });
      if (version !== generation || disposed) return;
      if (state.conversationId === item.id || (!privateChat && state.conversation?.session?.groupId === item.groupId)) {
        chatGeneration++; state.conversationId = ''; state.conversation = null; state.chatLoading = false; state.chatError = '';
      }
      await loadConversations(false, true);
      notify(`已彻底删除 ${label} 的聊天记录`);
    });
  };
  const pruneConversations = async () => {
    const mode = state.chatPrune.mode;
    let payload, desc;
    if (mode === 'days') {
      const days = Number(String(state.chatPrune.days || '').trim());
      if (!Number.isInteger(days) || days < 1 || days > 3650) { notify('清理天数需为 1–3650 的整数', true); return; }
      payload = { days };
      desc = `将永久删除 ${days} 天前的所有群聊和私聊历史消息。`;
    } else if (mode === 'group') {
      const groupId = String(state.chatPrune.groupId || '').trim();
      if (!/^(?:private|\d{5,20})$/.test(groupId)) { notify('请输入有效的 5–20 位群号（或 private）', true); return; }
      payload = { groupId };
      desc = `将永久删除群聊 ${groupId} 的全部历史消息。`;
    } else {
      const userId = String(state.chatPrune.userId || '').trim();
      if (!/^\d{5,20}$/.test(userId)) { notify('请输入有效的 5–20 位 QQ 号', true); return; }
      payload = { userId };
      desc = `将永久删除 QQ ${userId} 在所有群和私聊中的历史消息。`;
    }
    if (!await askConfirmation({
      title: '确认清理历史聊天记录？',
      description: desc,
      detail: '删除后无法在控制台恢复，仅可通过事先导出的加密备份恢复。',
      confirmText: '确认清理',
      tone: 'danger'
    })) return;
    return run('chatPrune', async () => {
      const version = generation;
      const result = await post('conversations/prune', payload);
      if (version !== generation || disposed) return;
      chatGeneration++; state.conversationId = ''; state.conversation = null; state.chatLoading = false;
      await loadConversations(false, true);
      notify(`清理完成：共删除 ${result.turns || 0} 条消息，${result.conversations || 0} 个会话`);
    });
  };
  function closeLogDetail() {
    detailGeneration++; state.logDetailId = ''; state.logDetail = null;
    state.logDetailError = ''; state.logDetailLoading = false;
  }
  async function loadLogDetail() {
    if (!state.logDetailId || state.logDetailLoading || !state.authenticated) return;
    const id = state.logDetailId, version = generation, detailVersion = detailGeneration;
    state.logDetailLoading = true;
    try {
      const data = await api(`logs/${encodeURIComponent(id)}`);
      if (version === generation && detailVersion === detailGeneration && !disposed) {
        state.logDetail = data; state.logDetailError = '';
      }
    } catch (error) {
      if (version === generation && detailVersion === detailGeneration && !disposed) state.logDetailError = error.message;
    } finally {
      if (version === generation && detailVersion === detailGeneration) state.logDetailLoading = false;
    }
  }
  function openLogDetail(log) {
    closeLogDetail(); state.logDetailId = log.id;
    void loadLogDetail();
  }
  const loadModels = () => run('models', async () => {
    const version = generation;
    const source = `${state.config.apiProvider || 'deepseek'}|${state.config.apiProvider === 'openai' ? state.config.openaiUrl : state.config.deepseekUrl}`;
    state.modelsError = '';
    try {
      const data = await api('models');
      if (version !== generation || disposed) return;
      state.models = data.models; state.modelsLoaded = true; state.modelsSource = source;
    } catch (error) {
      if (version === generation && !disposed) { state.models = []; state.modelsLoaded = false; state.modelsError = error.message; }
    }
  });
  async function run(key, action) {
    if (state.busy[key]) return;
    state.busy[key] = true;
    try { await action(); } catch (error) { notify(error.message, true); }
    finally { state.busy[key] = false; }
  }
  function navigate(page, { replace = false } = {}) {
    if (page !== 'live') { clearTimeout(liveTimer); liveRevision++; liveRequestId++; liveInFlight = false; state.busy.live = false; }
    if (['groups', 'private', 'whitelist/groups', 'whitelist/private', 'whitelist'].includes(page)) {
      if (page !== 'whitelist') state.whitelistTab = page === 'private' || page === 'whitelist/private' ? 'private' : 'groups';
      page = 'whitelist';
    }
    if (page.startsWith('model/')) {
      const sub = page.slice(6);
      if (['library', 'usage', 'reply'].includes(sub)) state.modelTab = sub;
      page = 'model';
    }
    const links = page === 'links' || page === 'plugins/links';
    const records = page === 'plugins/checkin/records';
    const checkin = page === 'plugins/checkin' || records;
    const subscriptions = page === 'plugins/subscriptions';
    const scheduledChat = page === 'plugins/scheduled-chat';
    const music = page === 'plugins/music';
    const gameCalendar = page === 'plugins/game-calendar';
    const fun = page === 'plugins/fun';
    const healthPlanner = page === 'plugins/health-planner';
    if (state.pluginDetail === 'subscriptions' && !subscriptions) closeSubscriptionPreview();
    if (links || checkin || subscriptions || scheduledChat || music || gameCalendar || fun || healthPlanner) page = 'plugins';
    state.pluginDetail = links ? 'links' : checkin ? 'checkin' : subscriptions ? 'subscriptions' : scheduledChat ? 'scheduled-chat' : music ? 'music' : gameCalendar ? 'game-calendar' : fun ? 'fun' : healthPlanner ? 'health-planner' : '';
    state.checkinView = records ? 'records' : 'settings';
    state.page = Object.hasOwn(pageNames, page) ? page : 'overview';
    const hash = `#${state.page}${state.page === 'whitelist' ? '/' + state.whitelistTab : ''}${state.pluginDetail ? `/${state.pluginDetail}` : ''}${records ? '/records' : ''}`;
    if (location.hash !== hash) {
      const method = replace || typeof history.pushState !== 'function' ? 'replaceState' : 'pushState';
      history[method](null, '', hash);
      if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') void nextTick(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    }
    if (state.page === 'chats' && state.authenticated) { void loadConversations(); void loadConversation(); }
    if (state.page === 'live' && state.authenticated) void loadLiveTasks();
    if (state.page === 'plugins' && state.authenticated) {
      if (links || !state.pluginDetail) void loadLinkStatus();
      void loadCheckin();
      void loadSubscriptions();
      void loadGameCalendar();
      void loadFun();
      void loadHealthPlanner();
    }
  }
  function syncHash() { navigate(location.hash.slice(1), { replace: true }); }
  async function loadLiveTasks(trigger = false) {
    const manual = trigger === true || (typeof trigger === 'object' && trigger !== null && 'target' in trigger);
    const force = manual || trigger === 'select';
    if (liveInFlight && !force) return;
    if (manual && state.busy.live) return;
    clearTimeout(liveTimer);
    const version = generation, revision = liveRevision, request = ++liveRequestId;
    liveInFlight = true;
    if (manual) state.busy.live = true;
    try {
      const data = await api(`live-tasks${state.liveSelectedId ? '?id=' + encodeURIComponent(state.liveSelectedId) : ''}`);
      if (version !== generation || revision !== liveRevision || request !== liveRequestId || disposed || state.page !== 'live') return;
      state.liveTasks = data; state.liveSelectedId = data.selected?.id || ''; state.liveError = '';
    } catch (error) {
      if (version === generation && revision === liveRevision && request === liveRequestId && state.page === 'live') state.liveError = error.message;
    } finally {
      if (manual) state.busy.live = false;
      if (request === liveRequestId) liveInFlight = false;
      if (!disposed && version === generation && request === liveRequestId && state.authenticated && state.page === 'live') {
        liveTimer = setTimeout(() => { void loadLiveTasks(false); }, 1000);
      }
    }
  }
  function selectLiveTask(id) {
    if (id !== state.liveSelectedId) {
      state.liveSelectedId = id;
      liveRevision++;
      clearTimeout(liveTimer);
      void loadLiveTasks('select');
    }
  }
  function schedule() {
    clearTimeout(pollTimer);
    if (!disposed && state.authenticated) pollTimer = setTimeout(refresh, 5000);
  }
  const healthEmailDirty = computed(() => emailFields.some(key => key === 'smtpPassword' ? Boolean(state.healthEmail.smtpPassword)
    : String(state.healthEmail[key] ?? '') !== String(state.config[key] ?? '')));
  async function loadHealth(refreshParser = false) {
    if (!state.authenticated || state.busy.health) return;
    const version = generation, request = ++healthGeneration; state.busy.health = true;
    try {
      const data = await api(`health${refreshParser ? '?refresh=1' : ''}`);
      if (version !== generation || request !== healthGeneration || disposed) return;
      state.health = data; state.healthError = ''; healthLastLoad = Date.now();
    } catch (error) { if (version === generation && !disposed) state.healthError = error.message; }
    finally { state.busy.health = false; }
  }
  const probeSubscription = id => run(`healthProbe:${id}`, async () => {
    const version = generation, result = await post(`subscriptions/${id}/probe`);
    if (version !== generation || disposed) return;
    const source = state.health?.sources.find(entry => entry.id === id); if (source) source.probe = result;
    notify(result.ok ? `只读检查通过：${result.itemCount} 条可用内容` : `只读检查失败：${result.error}`, !result.ok);
  });
  const saveHealthEmail = () => run('healthEmail', async () => {
    const submitted = copyDraft(state.healthEmail), version = generation;
    const saved = await api('config', { method: 'PUT', body: JSON.stringify(configPatch(submitted, emailFields)) });
    if (version !== generation || disposed) return;
    applyConfig(saved); if (state.healthEmail.smtpPassword === submitted.smtpPassword) state.healthEmail.smtpPassword = '';
    state.healthEmailResult = 'SMTP 配置已保存'; state.healthEmailError = false; notify('邮件告警配置已保存');
  });
  const testHealthEmail = () => run('testEmail', async () => {
    if (healthEmailDirty.value) { notify('请先保存 SMTP 修改，再发送测试邮件', true); return; }
    const version = generation, result = await post('test-email');
    if (version !== generation || disposed) return;
    state.healthEmailResult = `测试邮件已发送 ${timeText(result.sentAt)}`; state.healthEmailError = false; notify('测试邮件已发送，请检查收件箱');
  });
  async function refresh() {
    if (refreshing || !state.authenticated) return;
    clearTimeout(pollTimer); refreshing = true;
    const version = generation, revision = configRevision;
    try {
      const [config, status] = await Promise.all([api('config'), api('status')]);
      if (version !== generation || disposed) return;
      if (revision === configRevision && !configWrites) applyConfig(config);
      state.status = status; state.refreshMessage = '实时更新';
      void loadLogDetail(); void loadNapcat();
      if (state.page === 'overview' && Date.now() - healthLastLoad > 30000) void loadHealth();
      if (state.page === 'chats') { void loadConversations(); void loadConversation(); }
      if (state.page === 'plugins' && !state.busy.subscriptionSettings && !state.busy.subscriptionEdit && !state.busy.subscriptionAction) void loadSubscriptions();
      if (state.page === 'plugins' && state.pluginDetail === 'checkin' && !state.busy.checkin) void loadCheckin();
      if (state.page === 'plugins' && state.pluginDetail === 'game-calendar' && !state.busy.gameCalendarSettings && !state.busy.gameCalendarEdit && !state.busy.gameCalendarSync) void loadGameCalendar();
      if (state.page === 'plugins' && state.pluginDetail === 'fun' && !state.busy.funSettings && !state.busy.funQuoteDelete) void loadFun();
      if (state.page === 'plugins' && state.pluginDetail === 'health-planner' && !state.busy.healthPlannerSettings) void loadHealthPlanner();
      // Keep form drafts independent from polling, so unsaved edits are never overwritten.
    } catch (error) { if (version === generation) state.refreshMessage = error.message; }
    finally { refreshing = false; schedule(); }
  }
  async function enter() {
    const version = generation;
    const [config, status, session] = await Promise.all([api('config'), api('status'), api('session')]);
    if (version !== generation || disposed) return;
    state.config = config; state.status = status;
    state.scheduledChatTimes = [...(config.scheduledChatTimes ?? defaultChatTimes)];
    state.connection = Object.fromEntries(connectionFields.map(key => [key, config[key] ?? '']));
    state.model = Object.fromEntries(modelFields.map(key => [key, config[key] ?? '']));
    state.linkSettings = Object.fromEntries(linkFields.map(key => [key, config[key]]));
    state.healthEmail = Object.fromEntries(emailFields.map(key => [key, config[key] ?? (key === 'smtpPort' ? 465 : key === 'smtpSecure' ? true : '')]));
    state.groupRules = (Array.isArray(config.allowedGroups) ? config.allowedGroups : []).map(normalizeGroupRule).filter(Boolean);
    state.privateUsers = [...(config.allowedPrivateUsers || [])];
    state.adminUsername = session.username; state.totpEnabled = Boolean(session.totpEnabled); state.retentionDays = String(config.conversationRetentionDays ?? 0); state.authenticated = true; state.refreshMessage = '实时更新'; syncHash(); schedule();
    void loadNapcat(); void loadHealth(); if (config.modelApiKeyConfigured) void loadModels();
  }
  const createAdmin = () => run('adminSetup', async () => {
    state.adminSetupError = '';
    try {
      await post('setup-admin', { ...state.adminSetup });
      state.adminSetupRequired = false;
      state.adminSetup = { username: '', password: '', confirmPassword: '' };
      await enter();
    } catch (error) {
      state.adminSetupError = error.message;
      try {
        if (!(await api('setup')).required) { state.adminSetupRequired = false; showLogin(); state.loginError = '账号已创建，请使用已设置的账号登录'; }
      } catch {}
    }
  });
  const login = () => run('login', async () => {
    state.loginError = '';
    try {
      const payload = { username: state.loginUsername, password: state.loginPassword, rememberMe: state.loginRemember };
      if (state.loginRequiresTotp) {
        const code = state.loginTotpCode.trim();
        if (!code) { state.loginError = '请输入 6 位动态验证码或恢复码'; return; }
        payload.totpCode = code;
      }
      const res = await post('login', payload);
      if (res?.requiresTotp) { state.loginRequiresTotp = true; state.loginTotpCode = ''; return; }
      state.loginUsername = ''; state.loginPassword = ''; state.loginRequiresTotp = false; state.loginTotpCode = '';
      await enter();
    } catch (error) { state.loginError = error.message; }
  });
  function cancelTotpLogin() {
    state.loginRequiresTotp = false; state.loginTotpCode = ''; state.loginError = '';
  }
  const logout = () => run('logout', async () => { await post('logout'); showLogin(); });
  const toggle = () => run('toggle', async () => {
    const version = generation;
    const config = await api('config', { method: 'PUT', body: JSON.stringify({ enabled: !state.config.enabled }) });
    if (version !== generation || disposed) return;
    applyConfig(config);
    notify(state.config.enabled ? '机器人已启用' : '机器人已暂停');
  });
  const saveConnection = () => run('connection', async () => {
    const submitted = copyDraft(state.connection), version = generation;
    const config = await api('config', { method: 'PUT', body: JSON.stringify(configPatch(submitted, connectionFields)) });
    if (version !== generation || disposed) return;
    applyConfig(config);
    for (const key of ['onebotToken', 'napcatToken']) if (state.connection[key] === submitted[key]) state.connection[key] = '';
    state.qrcode = null; state.qrError = ''; state.napcat = null; napcatGeneration++;
    notify('连接配置已保存'); void loadNapcat(true);
  });
  const saveModel = () => run('model', async () => {
    const submitted = { ...state.model }, version = generation;
    const patch = configPatch(submitted, modelFields);
    const saved = await api('config', { method: 'PUT', body: JSON.stringify(patch) });
    if (version !== generation || disposed) return;
    applyConfig(saved);
    for (const key of modelFields) {
      if (state.model[key] !== submitted[key]) continue;
      if (key === 'deepseekKey' || key === 'openaiKey') state.model[key] = '';
      else if (Object.hasOwn(saved, key)) state.model[key] = saved[key];
    }
    state.deepseekResult = ''; notify(`模型配置已保存：${state.config.activeModel}`); void loadModels();
  });
  function addGroupRule() {
    const id = state.groupDraft.id.trim();
    if (!/^\d{5,20}$/.test(id)) { notify('群号需为 5–20 位数字', true); return; }
    if (state.groupRules.some(rule => rule.id === id)) { notify('该群已在白名单中', true); return; }
    if (state.groupRules.length >= 500) { notify('群白名单最多 500 个群', true); return; }
    state.groupRules.push({ id, ds: state.groupDraft.ds, video: state.groupDraft.video, scheduledChat: true });
    state.groupDraft.id = '';
  }
  function removeGroupRule(id) {
    state.groupRules = state.groupRules.filter(rule => rule.id !== id);
  }
  const saveGroups = () => run('groups', async () => {
    const version = generation, submitted = copyDraft(state.groupRules);
    const saved = new Map((state.config.allowedGroups || []).map(normalizeGroupRule).filter(Boolean).map(rule => [rule.id, rule]));
    const allowedGroups = submitted.map(rule => ({ id: rule.id, ds: rule.ds !== false, video: rule.video !== false, scheduledChat: saved.get(rule.id)?.scheduledChat ?? true }));
    const config = await api('config', { method: 'PUT', body: JSON.stringify({ allowedGroups }) });
    if (version !== generation || disposed) return;
    const draft = mergeGroupDraft(state.groupRules, submitted, (config.allowedGroups || []).map(normalizeGroupRule).filter(Boolean));
    applyConfig(config); state.groupRules = draft;
    notify(allowedGroups.length ? `群白名单已保存，共 ${allowedGroups.length} 个群${sameDraft(draft, config.allowedGroups) ? '' : '；后续修改尚未保存'}` : '群白名单已清空，机器人不再处理任何群消息');
  });
  function addPrivateUser() {
    const id = state.privateDraft.trim();
    if (!/^\d{5,20}$/.test(id)) { notify('QQ 号需为 5–20 位数字', true); return; }
    if (state.privateUsers.includes(id)) { notify('该 QQ 已在私聊白名单中', true); return; }
    if (state.privateUsers.length >= 500) { notify('私聊白名单最多 500 个账号', true); return; }
    state.privateUsers.push(id); state.privateDraft = '';
  }
  function removePrivateUser(id) { state.privateUsers = state.privateUsers.filter(user => user !== id); }
  const savePrivateUsers = () => run('privateUsers', async () => {
    const version = generation, submitted = [...state.privateUsers];
    const config = await api('config', { method: 'PUT', body: JSON.stringify({ allowedPrivateUsers: submitted }) });
    if (version !== generation || disposed) return;
    const draft = mergePrivateDraft(state.privateUsers, submitted, config.allowedPrivateUsers || []);
    applyConfig(config); state.privateUsers = draft;
    notify(`私聊白名单已保存，共 ${(config.allowedPrivateUsers || []).length} 个账号${sameDraft(draft, config.allowedPrivateUsers) ? '' : '；后续修改尚未保存'}`);
  });
  const loadLinkStatus = () => run('linkStatus', async () => {
    const version = generation;
    try {
      const data = await api('links');
      if (version === generation && !disposed) { state.linkStatus = data; state.linkStatusError = ''; }
    } catch (error) { if (version === generation && !disposed) state.linkStatusError = error.message; }
  });
  const loadCheckin = () => run('checkinStatus', async () => {
    const version = generation, revision = settingsRevision.checkin;
    try {
      const data = await api('checkin');
      if (version !== generation || disposed || revision !== settingsRevision.checkin || settingsWrites.checkin) return;
      state.checkinConflict ||= draftConflicts(state.checkinSettings, state.checkin?.settings, data.settings);
      state.checkinSettings = state.checkinSettings ? mergeDraft(state.checkinSettings, state.checkin?.settings, data.settings) : copyDraft(data.settings);
      state.checkin = data; state.checkinError = '';
    } catch (error) { if (version === generation && !disposed) state.checkinError = error.message; }
  });
  const saveCheckin = (toggleOnly = false) => run('checkin', async () => {
    if (!state.checkin) return;
    const version = generation;
    const submitted = copyDraft(state.checkinSettings);
    const patch = toggleOnly === true ? { enabled: !state.checkin.settings.enabled } : submitted;
    const data = await api('checkin', { method: 'PUT', body: JSON.stringify(patch) });
    if (version !== generation || disposed) return;
    state.checkin = data; state.checkinError = '';
    if (toggleOnly === true) state.checkinSettings.enabled = mergeDraft(state.checkinSettings.enabled, submitted.enabled, data.settings.enabled);
    else { state.checkinSettings = mergeDraft(state.checkinSettings, submitted, data.settings); state.checkinConflict = false; }
    notify('签到插件设置已保存');
  });
  const loadSubscriptions = () => run('subscriptionStatus', async () => {
    const version = generation, revision = settingsRevision.subscriptions;
    try {
      const data = await api('subscriptions');
      if (version !== generation || disposed || revision !== settingsRevision.subscriptions || settingsWrites.subscriptions) return;
      state.subscriptionConflict ||= draftConflicts(state.subscriptionSettings, state.subscriptions?.settings, data.settings);
      state.subscriptionSettings = state.subscriptionSettings ? mergeDraft(state.subscriptionSettings, state.subscriptions?.settings, data.settings) : copyDraft(data.settings);
      state.subscriptions = data; state.subscriptionError = '';
    } catch (error) { if (version === generation && !disposed) state.subscriptionError = error.message; }
  });
  const saveSubscriptionSettings = (toggleOnly = false) => run('subscriptionSettings', async () => {
    if (!state.subscriptions) return;
    const version = generation;
    const submitted = copyDraft(state.subscriptionSettings);
    const input = toggleOnly === true ? { enabled: !state.subscriptions.settings.enabled } : submitted;
    const data = await api('subscriptions', { method: 'PUT', body: JSON.stringify(input) });
    if (version !== generation || disposed) return;
    state.subscriptions = data; state.subscriptionError = '';
    if (toggleOnly === true) state.subscriptionSettings.enabled = mergeDraft(state.subscriptionSettings.enabled, submitted.enabled, data.settings.enabled);
    else { state.subscriptionSettings = mergeDraft(state.subscriptionSettings, submitted, data.settings); state.subscriptionConflict = false; }
    notify('订阅推送设置已保存');
  });
  function editSubscription(entry = null) {
    subscriptionEditRevision++;
    state.subscriptionEditId = entry?.id || '';
    const defaults = newSubscription();
    state.subscriptionDraft = entry ? Object.fromEntries(Object.keys(defaults).map(k => [k, Array.isArray(entry[k]) ? [...entry[k]] : entry[k] ?? defaults[k]])) : defaults;
    closeSubscriptionPreview();
  }
  function closeSubscriptionPreview() { previewRevision++; state.subscriptionPreview = null; }
  const saveSubscription = () => run('subscriptionEdit', async () => {
    const version = generation, id = state.subscriptionEditId, editVersion = subscriptionEditRevision, submitted = copyDraft(state.subscriptionDraft);
    const existingIds = new Set((state.subscriptions?.entries || []).map(entry => entry.id));
    const data = await api('subscriptions' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body: JSON.stringify(submitted) });
    if (version !== generation || disposed) return;
    state.subscriptions = data;
    if (editVersion === subscriptionEditRevision) {
      if (sameDraft(state.subscriptionDraft, submitted)) editSubscription();
      else if (!id) {
        const created = data.entries.find(entry => !existingIds.has(entry.id) && entry.type === submitted.type);
        if (created) state.subscriptionEditId = created.id;
      }
    }
    notify(id ? '订阅已更新' : '订阅已添加，首次检查只建立基线');
  });
  const subscriptionAction = (id, action) => run('subscriptionAction', async () => {
    const version = generation, previewVersion = action === 'preview' ? ++previewRevision : previewRevision;
    if (action === 'preview') state.subscriptionPreview = { id, loading: true, title: state.subscriptions?.entries.find(entry => entry.id === id)?.name || '订阅源', items: [], warnings: [], error: '' };
    let data;
    try { data = await post(`subscriptions/${id}/${action}`); }
    catch (error) {
      if (action === 'preview' && version === generation && previewVersion === previewRevision) state.subscriptionPreview = { ...state.subscriptionPreview, loading: false, error: error.message };
      throw error;
    }
    if (version !== generation || disposed) return;
    if (action === 'preview') { if (previewVersion === previewRevision) state.subscriptionPreview = { id, ...data, loading: false, error: '' }; return; }
    state.subscriptions = data;
    if (action === 'remove' && state.subscriptionEditId === id) editSubscription();
    if (state.subscriptionPreview?.id === id) state.subscriptionPreview = null;
    notify(action === 'remove' ? '订阅已删除' : '检查完成，请查看订阅状态');
  });
  const toggleSubscription = entry => run('subscriptionAction', async () => {
    const version = generation;
    const data = await api(`subscriptions/${entry.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !entry.enabled }) });
    if (version !== generation || disposed) return;
    state.subscriptions = data; notify(entry.enabled ? '该订阅已暂停' : '该订阅已恢复');
  });
  const removeSubscriptionGroup = async (id, group) => {
    const entry = state.subscriptions?.entries.find(value => value.id === id);
    if (!entry) return;
    const request = removeGroupRequest(entry, group);
    if (!request) return;
    const lastGroup = entry.groups.length === 1 && entry.groups.includes(group);
    if (!await askConfirmation({ title: lastGroup ? '删除这条订阅？' : '取消当前群的订阅？',
      description: `来源：${entry.lastTitle || entry.name}\n目标群：${group}`,
      detail: lastGroup ? '这是该来源的最后一个目标群，确认后整条订阅及待发记录将被删除。' : '仅停止向当前群推送，其他目标群不受影响。',
      confirmText: lastGroup ? '删除订阅' : '取消订阅', tone: 'danger' })) return;
    return run('subscriptionAction', async () => {
      const version = generation;
      const data = await api(request.path, { method: request.method, body: JSON.stringify(request.body) });
      if (version !== generation || disposed) return;
      state.subscriptions = data;
      if (state.subscriptionEditId === id) editSubscription(data.entries.find(value => value.id === id));
      if (state.subscriptionPreview?.id === id) state.subscriptionPreview = null;
      notify(lastGroup ? '订阅已删除' : `已取消群 ${group} 的这条订阅`);
    });
  };
  const saveLinks = () => run('links', async () => {
    const version = generation;
    const config = await api('config', { method: 'PUT', body: JSON.stringify(configPatch(state.linkSettings, linkFields)) });
    if (version !== generation || disposed) return;
    applyConfig(config);
    notify('链接解析配置已保存');
  });
  const toggleMusic = () => run('music', async () => {
    const version = generation;
    const config = await api('config', { method: 'PUT', body: JSON.stringify({ musicEnabled: state.config.musicEnabled === false }) });
    if (version !== generation || disposed) return;
    applyConfig(config); notify(config.musicEnabled ? '音乐点播已开启' : '音乐点播已关闭');
  });
  const toggleLinks = () => run('links', async () => {
    const version = generation;
    const config = await api('config', { method: 'PUT', body: JSON.stringify({ linkParsingEnabled: !state.config.linkParsingEnabled }) });
    if (version !== generation || disposed) return;
    applyConfig(config);
    state.linkSettings.linkParsingEnabled = config.linkParsingEnabled;
    notify(config.linkParsingEnabled ? '链接解析已开启' : '链接解析已关闭');
  });
  function syncScheduledTimes(config) {
    if (!state.scheduledChatTimes || state.scheduledChatTimes.join() === (state.config.scheduledChatTimes ?? defaultChatTimes).join()) state.scheduledChatTimes = [...(config.scheduledChatTimes ?? defaultChatTimes)];
  }
  async function updateScheduledChat(path, patch, message) {
    const version = generation;
    const config = await api(path, { method: 'PUT', body: JSON.stringify(patch) });
    if (version !== generation || disposed) return;
    applyConfig(config);
    const rules = new Map((config.allowedGroups || []).map(normalizeGroupRule).filter(Boolean).map(rule => [rule.id, rule]));
    // Keep pending DS/video edits and group additions/removals in the whitelist form.
    for (const rule of state.groupRules) if (rules.has(rule.id)) rule.scheduledChat = rules.get(rule.id).scheduledChat;
    notify(message);
    return config;
  }
  const saveScheduledChatTimes = () => run('scheduledChat', async () => {
    const submitted = [...(state.scheduledChatTimes || [])];
    const config = await updateScheduledChat('config', { scheduledChatTimes: submitted }, '定时聊天时间已保存（北京时间）');
    if (config && sameDraft(state.scheduledChatTimes, submitted)) state.scheduledChatTimes = [...config.scheduledChatTimes];
  });
  const toggleScheduledChat = () => run('scheduledChat', () => {
    const enabled = state.config.proactiveChatEnabled === false;
    return updateScheduledChat('config', { proactiveChatEnabled: enabled }, enabled ? '定时聊天已开启' : '定时聊天已关闭，免 @ 续聊也已停止');
  });
  const toggleScheduledFollowup = () => run('scheduledChat', () => {
    const enabled = state.config.groupFollowupEnabled === false;
    return updateScheduledChat('config', { groupFollowupEnabled: enabled }, enabled ? '免 @ 续聊已开启' : '免 @ 续聊已关闭');
  });
  const toggleScheduledChatGroup = id => run('scheduledChat', () => {
    const rule = (state.config.allowedGroups || []).map(normalizeGroupRule).find(rule => rule?.id === id);
    if (!rule) throw new Error('该群已移出白名单，请刷新后重试');
    const enabled = !rule.scheduledChat;
    return updateScheduledChat(`scheduled-chat/groups/${id}`, { enabled }, `群 ${id} 的定时聊天已${enabled ? '开启' : '关闭'}`);
  });
  const bilibiliRequest = (action = '', input = {}) => run('bilibili', async () => {
    const version = generation;
    state.bilibiliError = '';
    try {
      const data = action ? await post(`links/bilibili/${action}`, input) : await api('links/bilibili');
      if (version !== generation || disposed) return;
      if (action === 'qrcode') state.bilibiliQr = data;
      else if (action === 'poll') { state.bilibiliQr = data.qr; state.bilibili = data.status; }
      else state.bilibili = data;
      if (action === 'poll' && data.qr.state === 'success') void loadLinkStatus();
    } catch (error) { if (version === generation && !disposed) state.bilibiliError = error.message; }
  });
  const douyinRequest = (action = '', input = {}) => run('douyin', async () => {
    const version = generation; state.douyinError = '';
    try {
      const data = action ? await post(`links/douyin/${action}`, input) : await api('links/douyin');
      if (version !== generation || disposed) return;
      if (action === 'qrcode') state.douyinQr = data;
      else if (action === 'poll') { state.douyinQr = data.qr; state.douyin = data.status; }
      else { state.douyin = data; if (!action && data.qr) state.douyinQr = data.qr; if (action === 'cancel') state.douyinQr = null; }
      if (action === 'check' || action === 'poll' && data.qr.state === 'success') void loadLinkStatus();
      if (state.douyinQr?.state !== 'verification_required') { state.douyinVerification = null; state.douyinVerificationError = ''; state.douyinVerificationNotice = ''; }
    } catch (error) { if (version === generation && !disposed) state.douyinError = error.message; }
  });
  const douyinVerificationRequest = input => run('douyinVerification', async () => {
    const version = generation, qr = state.douyinQr;
    if (input) { state.douyinVerificationError = ''; state.douyinVerificationNotice = ''; }
    try {
      const data = await post(`links/douyin/${input ? 'interact' : 'verification'}`, input || {});
      if (version !== generation || disposed || state.page !== 'plugins' || state.pluginDetail !== 'links' || state.linkCookiePlatform !== 'douyin'
        || qr?.expiresAt !== state.douyinQr?.expiresAt || state.douyinQr?.state !== 'verification_required') return;
      if (!input) state.douyinVerification = data;
      else state.douyinVerificationNotice = data.detail || (input.type === 'code' ? '验证码已填入官方输入框，请点击提交验证。' : '操作已发送，请查看官方画面。');
    } catch (error) { if (version === generation && !disposed && state.page === 'plugins' && state.pluginDetail === 'links' && state.linkCookiePlatform === 'douyin'
      && (input || !state.douyinVerificationError)) state.douyinVerificationError = error.message; }
  });
  function clearCookieDraft() { state.linkCookieContent = ''; state.linkCookieError = ''; }
  function updateCookieStatus(data) {
    const platform = state.linkStatus?.platforms?.find(item => item.id === data.platform);
    if (platform) Object.assign(platform, { configured: data.configured, updatedAt: data.updatedAt });
  }
  const saveLinkCookie = () => run('linkCookie', async () => {
    const version = generation, platform = state.linkCookiePlatform;
    state.linkCookieError = '';
    try {
      const data = await post('links/cookies', { platform, content: state.linkCookieContent });
      if (version !== generation || disposed) return;
      updateCookieStatus(data); clearCookieDraft();
      if (platform === 'bilibili') { state.bilibiliQr = null; void bilibiliRequest(); }
      if (platform === 'douyin') { state.douyinQr = null; void douyinRequest(); }
      notify(`平台登录态已保存${data.ignored ? `，已忽略 ${data.ignored} 条其他平台 Cookie` : ''}；对新解析任务生效`);
    } catch (error) { if (version === generation && !disposed) state.linkCookieError = error.message; }
  });
  const removeLinkCookie = async () => {
    const platform = state.linkStatus?.platforms?.find(item => item.id === state.linkCookiePlatform);
    if (!platform || !await askConfirmation({ title: '清除平台登录态？', description: `将删除 ${platform.name} 已保存的 Cookie。`,
      detail: '该平台后续只能解析无需登录的公开内容；需要登录的内容可能无法读取。此操作不会影响管理后台或 QQ 登录。', confirmText: '清除登录态', tone: 'danger' })) return;
    return run('linkCookie', async () => {
      const version = generation; state.linkCookieError = '';
      try {
        const data = await post('links/cookies/clear', { platform: state.linkCookiePlatform });
        if (version !== generation || disposed) return;
        updateCookieStatus(data); clearCookieDraft(); notify('该平台的登录态已清除');
        if (data.platform === 'bilibili') { state.bilibiliQr = null; void bilibiliRequest(); }
        if (data.platform === 'douyin') { state.douyinQr = null; void douyinRequest(); }
      } catch (error) { if (version === generation && !disposed) state.linkCookieError = error.message; }
    });
  };
  const revealToken = () => run('reveal', async () => { state.webhookToken = (await post('webhook-token')).token; });
  const testOnebot = () => run('onebotTest', async () => {
    state.onebotError = false; state.onebotResult = '正在连接 NapCat…';
    try { const data = await post('test-onebot'); state.onebotResult = `连接成功：${data.nickname}（${data.userId}）`; }
    catch (error) { state.onebotError = true; state.onebotResult = error.message; }
  });
  const testDeepseek = () => run('deepseekTest', async () => {
    state.deepseekError = false; state.deepseekResult = '正在请求已保存的模型（会产生少量 API 用量）…';
    try { const data = await post('test-deepseek'); state.deepseekResult = `模型回复：${data.text}\n本次用量：${data.tokens ?? '未知'} Tokens`; }
    catch (error) { state.deepseekError = true; state.deepseekResult = error.message; }
  });
  const changePassword = () => run('password', async () => {
    if (state.password.newPassword !== state.password.confirmPassword) { notify('两次输入的新密码不一致', true); return; }
    await post('password', { currentPassword: state.password.currentPassword, newPassword: state.password.newPassword });
    showLogin(); notify('密码已更新，请重新登录');
  });
  const saveRetentionDays = () => run('retention', async () => {
    const version = generation;
    const days = Number(String(state.retentionDays ?? '').trim() || 0);
    if (!Number.isInteger(days) || days < 0 || days > 3650) { notify('保留天数需为 0–3650 的整数（0 表示长期保留）', true); return; }
    const config = await api('config', { method: 'PUT', body: JSON.stringify({ conversationRetentionDays: days }) });
    if (version !== generation || disposed) return;
    applyConfig(config);
    state.retentionDays = String(config.conversationRetentionDays ?? 0);
    notify(days ? `已设置聊天记录自动保留 ${days} 天` : '已设置为长期保留聊天记录');
  });
  const startTotpSetup = () => run('totp', async () => {
    const version = generation;
    const data = await post('totp/setup');
    const qrDataUrl = await QRCode.toDataURL(data.otpauthUrl, { width: 220, margin: 1 });
    if (version !== generation || disposed) return;
    state.totpSetup = { ...data, qrDataUrl, currentPassword: '', code: '', recoveryCodes: [] };
  });
  const enableTotp = () => run('totp', async () => {
    const version = generation;
    const res = await post('totp/enable', { currentPassword: state.totpSetup.currentPassword, code: state.totpSetup.code });
    if (version !== generation || disposed) return;
    state.totpEnabled = true;
    state.totpSetup = { qrDataUrl: '', secret: '', otpauthUrl: '', currentPassword: '', code: '', recoveryCodes: res.recoveryCodes || [] };
    notify('两步验证已启用，请妥善保存一次性恢复码');
  });
  const disableTotp = async () => {
    if (!await askConfirmation({
      title: '关闭管理员两步验证？',
      description: '关闭后登录控制台将只需账号和密码，且已有恢复码将失效。',
      confirmText: '关闭两步验证',
      tone: 'danger'
    })) return;
    return run('totp', async () => {
      const version = generation;
      await post('totp/disable', { currentPassword: state.totpDisable.currentPassword, code: state.totpDisable.code });
      if (version !== generation || disposed) return;
      state.totpEnabled = false;
      state.totpDisable = { currentPassword: '', code: '' };
      state.totpSetup = { qrDataUrl: '', secret: '', otpauthUrl: '', currentPassword: '', code: '', recoveryCodes: [] };
      notify('两步验证已关闭');
    });
  };
  const exportEncryptedBackup = () => run('backup', async () => {
    const currentPassword = state.backupExport.currentPassword;
    const backupPassword = state.backupExport.backupPassword;
    if (!currentPassword) { notify('请输入当前管理密码', true); return; }
    if (!backupPassword || backupPassword.length < 8 || backupPassword.length > 256) {
      notify('备份加密口令需为 8–256 个字符', true); return;
    }
    const res = await fetch('/api/backup/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' },
      body: JSON.stringify({ currentPassword, backupPassword })
    });
    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch {}
      if (res.status === 401) showLogin();
      throw new Error(data.error || `请求失败（${res.status}）`);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || 'qunyu-backup.qqbak.enc';
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    state.backupExport = { currentPassword: '', backupPassword: '' };
    notify('加密备份已生成并开始下载');
  });
  function applyNapcat(data) {
    state.napcat = data;
    if (data.qq?.state === 'online') { state.qrcode = null; state.qrError = ''; }
  }
  async function loadNapcat(force = false) {
    if ((napcatLoading && !force) || !state.authenticated) return;
    napcatLoading = true;
    const version = generation, napcatVersion = napcatGeneration;
    try {
      const data = force ? await post('napcat/refresh') : await api('napcat/status');
      if (version === generation && napcatVersion === napcatGeneration && !disposed) applyNapcat(data);
    } catch (error) {
      if (version === generation && napcatVersion === napcatGeneration) state.napcat = { qq: { state: 'unknown', label: '状态未知', detail: error.message }, webui: {}, onebot: {}, account: {} };
    } finally { napcatLoading = false; }
  }
  const refreshNapcat = () => run('napcatRefresh', () => loadNapcat(true));
  const connectNapcat = () => run('napcatConnect', async () => {
    try { applyNapcat(await post('napcat/connect', { totpCode: state.totpCode })); notify('NapCat 管理接口已连接'); }
    finally { state.totpCode = ''; }
  });
  const getQrcode = (refresh = false) => run('qrcode', async () => {
    state.qrError = '';
    if (refresh) state.qrcode = null;
    try { state.qrcode = await post('napcat/qrcode', { refresh }); }
    catch (error) { state.qrcode = null; state.qrError = error.message; }
    void loadNapcat(true);
  });
  const logoutNapcat = () => run('napcatLogout', async () => {
    const account = state.napcat?.account;
    const who = account?.nickname && account?.userId ? `${account.nickname}（QQ ${account.userId}）` : account?.userId ? `QQ ${account.userId}` : '当前登录的 QQ 账号';
    if (!await askConfirmation({
      title: '退出当前 QQ 登录？',
      description: `将退出 ${who} 的 QQ 会话并清理当前登录缓存。`,
      detail: '退出后机器人将暂停收发 QQ 消息，并自动备份清理登录缓存后重启 NapCat；之后可在本页重新扫码登录。',
      confirmText: '退出 QQ 登录',
      tone: 'danger'
    })) return;
    const version = generation;
    state.qrcode = null; state.qrError = '';
    const data = await post('napcat/logout');
    if (version !== generation || disposed) return;
    napcatGeneration++;
    applyNapcat(data);
    notify('已退出 QQ 登录，可重新扫码登录');
  });
  onMounted(async () => {
    window.addEventListener('hashchange', syncHash); window.addEventListener('popstate', syncHash);
    try { state.adminSetupRequired = (await api('setup')).required; if (!state.adminSetupRequired) await enter(); }
    catch (error) { showLogin(); if (error.message !== '请先登录管理后台') state.loginError = error.message; }
    finally { state.ready = true; }
  });
  async function resetCheckinDraft() {
    if (!await askConfirmation({ title: '放弃本页修改？', description: '将使用服务器上最新的签到设置覆盖本页草稿。', detail: '本页尚未保存的修改会丢失，此操作不会影响已经生效的配置。', confirmText: '放弃修改', tone: 'danger' })) return;
    state.checkinSettings = copyDraft(state.checkin?.settings); state.checkinConflict = false;
  }
  async function resetSubscriptionSettings() {
    if (!await askConfirmation({ title: '放弃本页修改？', description: '将使用服务器上最新的订阅推送设置覆盖本页草稿。', detail: '本页尚未保存的修改会丢失，此操作不会影响已经生效的配置。', confirmText: '放弃修改', tone: 'danger' })) return;
    state.subscriptionSettings = copyDraft(state.subscriptions?.settings); state.subscriptionConflict = false;
  }
  const loadGameCalendar = () => run('gameCalendarStatus', async () => {
    const version = generation, revision = settingsRevision['game-calendar'];
    try {
      const data = await api('game-calendar');
      if (version !== generation || disposed || revision !== settingsRevision['game-calendar'] || settingsWrites['game-calendar']) return;
      const nextSettings = { enabled: true, renderCard: true, autoSync: true, enabledGames: ['wuwa', 'arknights', 'zzz', 'endfield'], ...(data?.settings || {}) };
      state.gameCalendarSettings = state.gameCalendarSettings && state.gameCalendar?.settings
        ? mergeDraft(state.gameCalendarSettings, state.gameCalendar.settings, nextSettings)
        : copyDraft(nextSettings);
      state.gameCalendar = { codes: [], activities: [], summary: {}, ...data, settings: nextSettings };
      state.gameCalendarError = '';
    } catch (error) { if (version === generation && !disposed) state.gameCalendarError = error.message; }
  });
  const saveGameCalendarSettings = (toggleOnly = false) => run('gameCalendarSettings', async () => {
    if (!state.gameCalendar) return;
    const version = generation;
    const submitted = copyDraft(state.gameCalendarSettings);
    const input = toggleOnly === true ? { enabled: !state.gameCalendar.settings.enabled } : submitted;
    const data = await api('game-calendar', { method: 'PUT', body: JSON.stringify(input) });
    if (version !== generation || disposed) return;
    state.gameCalendar = data; state.gameCalendarError = '';
    if (toggleOnly === true) state.gameCalendarSettings.enabled = mergeDraft(state.gameCalendarSettings.enabled, submitted.enabled, data.settings.enabled);
    else state.gameCalendarSettings = mergeDraft(state.gameCalendarSettings, submitted, data.settings);
    notify('游戏兑换码与日历设置已保存');
  });
  const saveGameRedeemCode = (draft, id = '') => run('gameCalendarEdit', async () => {
    const version = generation;
    const data = await api('game-calendar/codes' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body: JSON.stringify(draft) });
    if (version !== generation || disposed) return;
    state.gameCalendar = data;
    notify(id ? '兑换码已更新' : '兑换码已添加');
  });
  const removeGameRedeemCode = id => run('gameCalendarEdit', async () => {
    const version = generation;
    const data = await post(`game-calendar/codes/${id}/remove`);
    if (version !== generation || disposed) return;
    state.gameCalendar = data;
    notify('兑换码已删除');
  });
  const saveGameActivity = (draft, id = '') => run('gameCalendarEdit', async () => {
    const version = generation;
    const data = await api('game-calendar/activities' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body: JSON.stringify(draft) });
    if (version !== generation || disposed) return;
    state.gameCalendar = data;
    notify(id ? '日历活动已更新' : '日历活动已添加');
  });
  const removeGameActivity = id => run('gameCalendarEdit', async () => {
    const version = generation;
    const data = await post(`game-calendar/activities/${id}/remove`);
    if (version !== generation || disposed) return;
    state.gameCalendar = data;
    notify('日历活动已删除');
  });
  const syncGameCalendar = (game = '') => run('gameCalendarSync', async () => {
    const version = generation;
    const data = await post('game-calendar/sync', game ? { game } : {});
    if (version !== generation || disposed) return;
    state.gameCalendar = data;
    const r = data.syncResult || {};
    notify(`官方公告同步完成：新增活动 ${r.addedActivities || 0} 条、兑换码 ${r.addedCodes || 0} 个`);
  });
  const loadFun = () => run('funStatus', async () => {
    const version = generation, revision = settingsRevision.fun;
    try {
      const data = await api('fun');
      if (version !== generation || disposed || revision !== settingsRevision.fun || settingsWrites.fun) return;
      const nextSettings = {
        enabled: true,
        fortuneEnabled: true,
        memeEnabled: true,
        gamesEnabled: true,
        gachaEnabled: true,
        quotesEnabled: true,
        dailyReportEnabled: true,
        diceTavernComment: true,
        ...(data?.settings || {})
      };
      state.funSettings = state.funSettings && state.fun?.settings
        ? mergeDraft(state.funSettings, state.fun.settings, nextSettings)
        : copyDraft(nextSettings);
      state.fun = { quotesCount: 0, ...data, settings: nextSettings };
      state.funError = '';
    } catch (error) {
      if (version === generation && !disposed) state.funError = error.message;
    }
  });
  const saveFunSettings = (toggleOnly = false) => run('funSettings', async () => {
    if (!state.fun) return;
    const version = generation;
    settingsRevision.fun += 1;
    settingsWrites.fun += 1;
    const submitted = copyDraft(state.funSettings);
    const input = toggleOnly === true ? { enabled: !state.fun.settings.enabled } : submitted;
    try {
      const data = await api('fun', { method: 'PUT', body: JSON.stringify(input) });
      if (version !== generation || disposed) return;
      state.fun = data; state.funError = '';
      if (toggleOnly === true) state.funSettings.enabled = mergeDraft(state.funSettings.enabled, submitted.enabled, data.settings.enabled);
      else state.funSettings = mergeDraft(state.funSettings, submitted, data.settings);
      notify('群聊娱乐设置已保存');
    } finally {
      settingsWrites.fun = Math.max(0, settingsWrites.fun - 1);
    }
  });
  async function loadFunQuotes({ groupId = '', keyword = '' } = {}) {
    if (!state.authenticated) return;
    state.funQuotesLoading = true;
    try {
      const q = new URLSearchParams();
      if (groupId) q.set('groupId', groupId);
      if (keyword) q.set('keyword', keyword);
      const data = await api(`fun/quotes${q.toString() ? `?${q.toString()}` : ''}`);
      state.funQuotes = Array.isArray(data.quotes) ? data.quotes : [];
    } catch (error) {
      notify(error.message, true);
    } finally {
      state.funQuotesLoading = false;
    }
  }
  const deleteFunQuote = async id => {
    if (!await askConfirmation({
      title: '删除这条群聊语录？',
      description: '删除后该语录将无法通过 /语录 随机抽取，请确认。',
      confirmText: '确认删除',
      tone: 'danger'
    })) return;
    return run('funQuoteDelete', async () => {
      const data = await api(`fun/quotes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.funQuotes = state.funQuotes.filter(q => q.id !== id);
      if (state.fun) state.fun.quotesCount = data.quotesCount ?? state.funQuotes.length;
      notify('已删除该条语录');
    });
  };
  const loadHealthPlanner = () => run('healthPlannerStatus', async () => {
    const version = generation, revision = settingsRevision['health-planner'];
    try {
      const data = await api('health-planner');
      if (version !== generation || disposed || revision !== settingsRevision['health-planner'] || settingsWrites['health-planner']) return;
      const nextSettings = {
        enabled: true,
        renderCard: true,
        aiMenuEnhance: true,
        aiFoodVision: true,
        ...(data?.settings || {}),
        pushSlots: {
          morningOverview: '07:30',
          breakfast: '',
          lunch: '11:30',
          dinner: '17:30',
          ...(data?.settings?.pushSlots || {})
        }
      };
      state.healthPlannerSettings = state.healthPlannerSettings && state.healthPlanner?.settings
        ? mergeDraft(state.healthPlannerSettings, state.healthPlanner.settings, nextSettings)
        : copyDraft(nextSettings);
      state.healthPlanner = { ...data, settings: nextSettings };
      state.healthPlannerError = '';
    } catch (error) {
      if (version === generation && !disposed) state.healthPlannerError = error.message;
    }
  });
  const saveHealthPlannerSettings = (toggleOnly = false) => run('healthPlannerSettings', async () => {
    if (!state.healthPlanner) return;
    const version = generation;
    settingsRevision['health-planner'] += 1;
    settingsWrites['health-planner'] += 1;
    const submitted = copyDraft(state.healthPlannerSettings);
    const input = toggleOnly === true ? { enabled: !state.healthPlanner.settings.enabled } : submitted;
    try {
      const data = await api('health-planner', { method: 'PUT', body: JSON.stringify(input) });
      if (version !== generation || disposed) return;
      state.healthPlanner = data; state.healthPlannerError = '';
      if (toggleOnly === true) state.healthPlannerSettings.enabled = mergeDraft(state.healthPlannerSettings.enabled, submitted.enabled, data.settings.enabled);
      else state.healthPlannerSettings = mergeDraft(state.healthPlannerSettings, submitted, data.settings);
      notify('健康饮食插件设置已保存');
    } finally {
      settingsWrites['health-planner'] = Math.max(0, settingsWrites['health-planner'] - 1);
    }
  });
  onUnmounted(() => { disposed = true; generation++; resolveConfirmation(false); clearTimeout(pollTimer); clearTimeout(liveTimer); clearTimeout(toastTimer); window.removeEventListener('hashchange', syncHash); window.removeEventListener('popstate', syncHash); });

  return reactive({
    state, api, notify, navigate, refresh, login, cancelTotpLogin, logout, createAdmin, bindApiKey, toggle, saveConnection, saveModel, revealToken, testOnebot, testDeepseek, changePassword, saveRetentionDays, startTotpSetup, enableTotp, disableTotp, exportEncryptedBackup, loadLiveTasks, selectLiveTask, askConfirmation, resolveConfirmation,
    addGroupRule, removeGroupRule, saveGroups, addPrivateUser, removePrivateUser, savePrivateUsers,
    refreshNapcat, connectNapcat, getQrcode, logoutNapcat,
    loadModels, openLogDetail, closeLogDetail, loadLogDetail,
    loadLinkStatus, saveLinks, toggleLinks, toggleMusic, bilibiliRequest, douyinRequest, douyinVerificationRequest,
    loadHealth, probeSubscription, saveHealthEmail, testHealthEmail, healthEmailDirty,
    toggleScheduledChat, toggleScheduledFollowup, toggleScheduledChatGroup, saveScheduledChatTimes,
    resetCheckinDraft,
    resetSubscriptionSettings,
    closeSubscriptionPreview,
    loadSubscriptions, saveSubscriptionSettings, editSubscription, saveSubscription, subscriptionAction, toggleSubscription, removeSubscriptionGroup,
    loadGameCalendar, saveGameCalendarSettings, saveGameRedeemCode, removeGameRedeemCode, saveGameActivity, removeGameActivity, syncGameCalendar,
    loadFun, saveFunSettings, loadFunQuotes, deleteFunQuote,
    loadHealthPlanner, saveHealthPlannerSettings,
    loadCheckin, saveCheckin,
    saveLinkCookie, removeLinkCookie, clearCookieDraft,
    loadConversations, searchConversations, selectConversation, loadConversation, resetConversation, deleteConversation, pruneConversations,
    pageTitle: computed(() => pageNames[state.page]),
    webhookUrl: computed(() => `${location.origin}/onebot/events`),
    recentLogs: computed(() => (state.status.logs || []).slice(0, 4)),
    filteredLogs: computed(() => (state.status.logs || []).filter(log => state.filter === 'all' || log.level === state.filter)),
    recentEvent: computed(() => Boolean(state.status.lastEventAt && Date.now() - state.status.lastEventAt < 120000)),
    uptime: computed(() => Math.floor((Date.now() - (state.status.startedAt || Date.now())) / 60000)),
    heroTitle: computed(() => state.config.enabled ? state.config.modelApiKeyConfigured ? '已开启，等待下一次对话。' : '插件已启用，按需连接模型。' : state.config.modelApiKeyConfigured ? '准备好回应下一次对话。' : '准备就绪，等待连接。'),
    heroDescription: computed(() => state.config.enabled ? state.config.modelApiKeyConfigured ? '授权群内 @ 或白名单私聊交给模型回答，群内平台分享交给链接解析。' : '链接解析、签到与订阅按各自开关运行；配置模型密钥后启用聊天与定时发言。' : state.config.modelApiKeyConfigured ? '配置已保存，启用后处理授权群聊、白名单私聊与支持的平台链接。' : '配置 QQ 连接与模型密钥，开启你的群聊助手。')
  });
}

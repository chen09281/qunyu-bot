import { modelConfig } from '../model-provider.mjs';
import {
  MEAL_LABELS,
  beijingDateParts,
  buildMealPlan,
  computeDailyTargets,
  fallbackEstimateMealText,
  formatPlanText,
  inferCurrentMealSlot,
  mealSourceLabel,
  normalizeDislikes,
  normalizeMealRatios,
  parseMealType,
  parseProfileArgs
} from './nutrition.mjs';
import { buildMealPlanCardHtml } from './card.mjs';
import { HealthPlannerHelpImage } from './help-image.mjs';

const groupAllowed = (config, group) => (Array.isArray(config.allowedGroups) ? config.allowedGroups : [])
  .some(item => String(typeof item === 'string' ? item : item?.id) === String(group));

const privateAllowed = (config, user) => Array.isArray(config.allowedPrivateUsers)
  && config.allowedPrivateUsers.includes(String(user));

function parseMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

function extractJsonObject(raw) {
  const cleaned = String(raw || '')
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

const MAX_BRIDGE_IMAGE_BYTES = 3 * 1024 * 1024;

function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  const head = buffer.subarray(0, 6).toString('ascii');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  return null;
}

/** Decode and verify a bridge-uploaded base64 image using binary magic bytes rather than trusting MIME labels. */
function decodeBridgeImageBase64(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return { dataUrl: '' };
  if (raw.length > MAX_BRIDGE_IMAGE_BYTES * 2) {
    return { error: '图片体积超过 3 MiB 上限，请缩放后再试', status: 413 };
  }
  const stripped = raw.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/i, '').replace(/\s+/g, '');
  if (!stripped || stripped.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
    return { error: '图片 Base64 编码无效，请重新选择图片' };
  }
  const buffer = Buffer.from(stripped, 'base64');
  if (!buffer.length || buffer.length > MAX_BRIDGE_IMAGE_BYTES) {
    return { error: '图片体积超过 3 MiB 上限，请缩放后再试', status: 413 };
  }
  const mime = detectImageMime(buffer);
  if (!mime) {
    return { error: '仅支持 JPEG、PNG、WebP 或 GIF 图片格式' };
  }
  return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
}

function normalizeFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const cleaned = typeof value === 'string' ? value.trim().replace(/,/g, '') : value;
  if (cleaned === '') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export class HealthPlannerService {
  constructor(plannerStore, configStore, {
    onebot,
    log = () => {},
    cardRenderer = null,
    askModel = null,
    askVisionModel = null,
    prepareInputImages = null,
    now = Date.now
  } = {}) {
    this.plannerStore = plannerStore;
    this.configStore = configStore;
    this.onebot = onebot;
    this.log = log;
    this.cardRenderer = cardRenderer;
    this.askModel = askModel;
    this.askVisionModel = askVisionModel;
    this.prepareInputImages = prepareInputImages;
    this.now = now;
    this.helpImage = new HealthPlannerHelpImage(cardRenderer);
    this.controllers = new Set();
    this.timer = null;
    this.scheduled = false;
    this.closed = false;
  }

  get settings() {
    return this.plannerStore.getSettings();
  }

  status() {
    return this.plannerStore.publicSummary();
  }

  configure(input) {
    return this.plannerStore.configure(input);
  }

  enabled() {
    return !this.closed && Boolean(this.configStore.config.enabled) && Boolean(this.settings.enabled);
  }

  async canReachMember(userId, groupId = '') {
    if (this.closed || !this.configStore.config.enabled || !this.settings.enabled) return false;
    const config = this.configStore.config;
    if (privateAllowed(config, userId)) return true;
    if (!groupId || !groupAllowed(config, groupId)) return false;
    try {
      const member = await this.onebot('get_group_member_info', { group_id: groupId, user_id: userId, no_cache: true });
      return String(member?.user_id) === String(userId) && String(member?.group_id) === String(groupId);
    } catch {
      return false;
    }
  }

  computeUserPlan(userId, { day = '', singleMealType = '' } = {}) {
    const user = this.plannerStore.getUser(userId);
    if (!user || !user.profile) return null;
    const today = day || beijingDateParts(this.now()).day;
    const appleDay = user.appleHealth?.days?.[today] || null;
    const targets = computeDailyTargets(user.profile, appleDay);
    const logsToday = user.mealLogs?.[today] || [];
    const plan = buildMealPlan(user.profile, targets, { day: today, logsToday });
    return { user, appleDay, plan, singleMealType };
  }

  async maybeEnhanceTip(user, plan, singleMealType = '') {
    if (!this.settings.aiMenuEnhance || !this.askModel) return '';
    if (!modelConfig(this.configStore.config, 'chat').deepseekKey) return '';
    const slotsText = (singleMealType ? [singleMealType] : ['breakfast', 'lunch', 'dinner'])
      .map(k => {
        const m = plan.meals[k];
        if (!m || m.status === 'logged') return '';
        return `${m.label}(${m.actual.calories}kcal/蛋白${m.actual.proteinG}g): ${m.items.map(i => `${i.name}${i.grams}g`).join('、')}`;
      })
      .filter(Boolean)
      .join('；');
    if (!slotsText) return '';
    const dislikesText = user.profile.dislikes?.length ? `，忌口：${user.profile.dislikes.join('、')}` : '';
    try {
      const tip = await this.askModel({
        purpose: 'health_menu_tip',
        maxTokens: 160,
        thinkingEnabled: false,
        messages: [
          {
            role: 'system',
            content: '你是专业营养搭配助手。请根据给定的食谱克重，用 1–2 句中文（不超过 65 字）给出实用的备餐或外食替换建议，禁止改变原有热量和蛋白质数字。'
          },
          {
            role: 'user',
            content: `目标：${plan.targets.goalLabel}，全天 ${plan.targets.targetCalories}kcal / 蛋白 ${plan.targets.proteinG}g${dislikesText}。今日安排：${slotsText}`
          }
        ]
      });
      return String(tip || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    } catch {
      return '';
    }
  }

  async renderPlanCardBuffer({ user, plan, appleDay, singleMealType = '', aiTip = '' }) {
    if (!this.settings.renderCard || !this.cardRenderer?.available) return null;
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const { html, width, height } = buildMealPlanCardHtml({
        userName: user.userName || `QQ ${user.userId}`,
        plan,
        appleDay,
        singleMealType,
        aiTip
      });
      return await this.cardRenderer.renderHtmlToPng({
        html,
        width,
        height,
        scale: 1,
        signal: controller.signal
      });
    } catch {
      return null;
    } finally {
      this.controllers.delete(controller);
    }
  }

  async buildPlanPayload(userId, { day = '', singleMealType = '', includeAiTip = true } = {}) {
    const computed = this.computeUserPlan(userId, { day, singleMealType });
    if (!computed) return null;
    const { user, appleDay, plan } = computed;
    const aiTip = includeAiTip ? await this.maybeEnhanceTip(user, plan, singleMealType) : '';
    const text = formatPlanText(user.userName || `QQ ${user.userId}`, plan, singleMealType)
      + (aiTip ? `\n\n✨ 搭配贴士：${aiTip}` : '');
    const imageBuffer = await this.renderPlanCardBuffer({ user, plan, appleDay, singleMealType, aiTip });
    return { user, appleDay, plan, aiTip, text, imageBuffer };
  }

  onboardUser(userId, { userName = '', groupId = '' }, argsText) {
    const existing = this.plannerStore.getUser(userId)?.profile || null;
    const profile = parseProfileArgs(argsText, existing);
    const user = this.plannerStore.upsertProfile(userId, { userName, groupId }, profile);
    return user;
  }

  updateUserDislikes(userId, text) {
    const user = this.plannerStore.getUser(userId);
    if (!user?.profile) throw new Error('请先发送「/健康 录入 ...」完成基础档案录入');
    const clean = String(text || '').trim();
    const dislikes = !clean || ['无', '清空', '没有', 'none'].includes(clean.toLowerCase()) ? [] : normalizeDislikes(clean);
    user.profile = { ...user.profile, dislikes };
    user.updatedAt = this.now();
    this.plannerStore.save();
    return user;
  }

  updateUserStyle(userId, dietStyle) {
    const user = this.plannerStore.getUser(userId);
    if (!user?.profile) throw new Error('请先发送「/健康 录入 ...」完成基础档案录入');
    user.profile = { ...user.profile, dietStyle };
    user.updatedAt = this.now();
    this.plannerStore.save();
    return user;
  }

  updateUserRatios(userId, nums) {
    const user = this.plannerStore.getUser(userId);
    if (!user?.profile) throw new Error('请先发送「/健康 录入 ...」完成基础档案录入');
    if (nums.length !== 3) throw new Error('格式：/健康 比例 <早> <中> <晚>，例如 /健康 比例 30 40 30');
    const mealRatios = normalizeMealRatios({ breakfast: nums[0], lunch: nums[1], dinner: nums[2] });
    user.profile = { ...user.profile, mealRatios };
    user.updatedAt = this.now();
    this.plannerStore.save();
    return user;
  }

  async estimateAndLogMeal({ event = null, userId, mealTypeHint = '', textDescription = '', imageUrls = [], inlineImages = [] }) {
    const user = this.plannerStore.getUser(userId);
    if (!user?.profile) throw new Error('请先发送「/健康 录入 男/女 年龄 身高 体重 [减脂/维持/增肌]」录入档案后再记餐');
    const { day, hour } = beijingDateParts(this.now());
    const fallbackSlot = parseMealType(mealTypeHint) || inferCurrentMealSlot(hour);

    let parsed = null;
    let source = 'text';

    if (imageUrls.length > 0 || inlineImages.length > 0) {
      if (!this.settings.aiFoodVision || this.configStore.config.imageRecognitionEnabled === false) {
        throw new Error('管理员已在后台关闭图片识图功能，可改用文字描述（例如：/记一餐 午餐 牛肉面一碗 550大卡）');
      }
      if (!this.askVisionModel || (imageUrls.length > 0 && !this.prepareInputImages)) {
        throw new Error('当前识图服务未就绪，请稍后再试或使用文字记录');
      }
      const images = inlineImages.length > 0
        ? inlineImages
        : (await this.prepareInputImages(imageUrls)).images;
      const rawJson = await this.askVisionModel({
        event,
        images,
        maxTokens: 700,
        prompt: [
          '请识别图中的食物，结合常见份量估算整餐总热量（kcal）以及蛋白质、碳水化合物、脂肪（g）。',
          textDescription ? `用户补充描述：「${textDescription}」。` : '',
          `餐次倾向：${MEAL_LABELS[fallbackSlot]}。`,
          '只返回严格的 JSON 对象，不要附加解释，格式：',
          '{"mealType":"breakfast|lunch|dinner","summary":"简短菜品名称与份量","calories":620,"proteinG":34.5,"carbsG":72,"fatG":18,"items":[{"name":"菜名","grams":180,"calories":300,"proteinG":25}]}'
        ].filter(Boolean).join('\n')
      });
      const obj = extractJsonObject(rawJson);
      if (!obj || !Number.isFinite(Number(obj.calories)) || Number(obj.calories) <= 0) {
        throw new Error('未能从图片中可靠解析出食物热量，请附带文字说明克重或菜名重试');
      }
      source = 'vision';
      parsed = {
        mealType: parseMealType(mealTypeHint) || parseMealType(obj.mealType) || fallbackSlot,
        summary: String(obj.summary || textDescription || '拍照识别餐食').slice(0, 120),
        calories: Math.round(Number(obj.calories)),
        proteinG: Math.round(Number(obj.proteinG || 0) * 10) / 10,
        carbsG: Math.round(Number(obj.carbsG || 0) * 10) / 10,
        fatG: Math.round(Number(obj.fatG || 0) * 10) / 10,
        items: Array.isArray(obj.items) ? obj.items.slice(0, 10) : []
      };
    } else {
      const explicitNumbers = /\d{2,4}\s*(?:千卡|大卡|kcal|卡路里)/i.test(textDescription);
      if (!explicitNumbers && this.askModel && modelConfig(this.configStore.config, 'chat').deepseekKey) {
        try {
          const rawJson = await this.askModel({
            event,
            purpose: 'health_text_meal',
            maxTokens: 450,
            thinkingEnabled: false,
            messages: [
              {
                role: 'system',
                content: '你是营养分析助手。根据用户文字描述的食物与份量估算整餐热量（kcal）和蛋白质/碳水/脂肪（g）。只返回严格的 JSON 对象，不要其他说明：{"mealType":"breakfast|lunch|dinner","summary":"简短餐食描述","calories":550,"proteinG":30,"carbsG":65,"fatG":16,"items":[{"name":"食物","grams":150,"calories":250,"proteinG":20}]}'
              },
              { role: 'user', content: `餐次默认：${MEAL_LABELS[fallbackSlot]}；描述：${textDescription}` }
            ]
          });
          const obj = extractJsonObject(rawJson);
          if (obj && Number.isFinite(Number(obj.calories)) && Number(obj.calories) > 0) {
            source = 'ai_text';
            parsed = {
              mealType: parseMealType(mealTypeHint) || parseMealType(obj.mealType) || fallbackSlot,
              summary: String(obj.summary || textDescription).slice(0, 120),
              calories: Math.round(Number(obj.calories)),
              proteinG: Math.round(Number(obj.proteinG || 0) * 10) / 10,
              carbsG: Math.round(Number(obj.carbsG || 0) * 10) / 10,
              fatG: Math.round(Number(obj.fatG || 0) * 10) / 10,
              items: Array.isArray(obj.items) ? obj.items.slice(0, 10) : []
            };
          }
        } catch {
          // Graceful fallback to deterministic estimator when AI fails.
        }
      }
      if (!parsed) {
        parsed = fallbackEstimateMealText(textDescription, fallbackSlot);
        parsed.mealType = parseMealType(mealTypeHint) || parsed.mealType;
      }
    }

    const { log, appleSyncItem } = this.plannerStore.addMealLog(userId, day, { ...parsed, source }, true);
    const updatedPlan = this.computeUserPlan(userId, { day });
    return { log, appleSyncItem, updatedPlan };
  }

  // ---- Apple Health Bridge API ----

  ingestAppleHealth(bearerToken, payload) {
    const user = this.plannerStore.findUserByToken(bearerToken);
    if (!user) return { status: 401, body: { error: '同步令牌无效或已重置' } };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { status: 400, body: { error: '请求体必须为 JSON 对象' } };
    }

    let day = beijingDateParts(this.now()).day;
    if (typeof payload.date === 'string' && payload.date.trim()) {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(payload.date.trim());
      if (m) day = m[1];
    }

    const normalized = {
      steps: normalizeFiniteNumber(payload.steps),
      activeEnergyKcal: normalizeFiniteNumber(payload.activeEnergyKcal ?? payload.activeCalories),
      restingEnergyKcal: normalizeFiniteNumber(payload.restingEnergyKcal ?? payload.basalEnergyKcal),
      weightKg: normalizeFiniteNumber(payload.weightKg ?? payload.weight),
      dietaryEnergyKcal: normalizeFiniteNumber(payload.dietaryEnergyKcal ?? payload.dietaryCalories),
      proteinG: normalizeFiniteNumber(payload.proteinG ?? payload.protein)
    };
    const hasMetric = Object.values(normalized).some(v => v !== undefined);
    if (!hasMetric) {
      return { status: 400, body: { error: '至少需要提供一个有效的健康字段（如 steps、activeEnergyKcal、weightKg）' } };
    }

    const dayMetrics = this.plannerStore.recordAppleHealth(user.userId, day, normalized);
    const targets = user.profile ? computeDailyTargets(user.profile, dayMetrics) : null;
    this.log('info', `已接收 Apple 健康同步数据（用户 ${user.userId}，日期 ${day}）`, {
      source: 'health_planner',
      userId: user.userId
    });
    return {
      status: 200,
      body: {
        ok: true,
        day,
        metrics: dayMetrics,
        dailyTargets: targets
      }
    };
  }

  pullPendingAppleNutrition(bearerToken) {
    const user = this.plannerStore.findUserByToken(bearerToken);
    if (!user) return { status: 401, body: { error: '同步令牌无效或已重置' } };
    const items = this.plannerStore.pullPendingAppleSync(user.userId);
    return { status: 200, body: { ok: true, count: items.length, items } };
  }

  ackPendingAppleNutrition(bearerToken, payload) {
    const user = this.plannerStore.findUserByToken(bearerToken);
    if (!user) return { status: 401, body: { error: '同步令牌无效或已重置' } };
    const rawIds = payload?.ids;
    const ids = Array.isArray(rawIds)
      ? rawIds
      : typeof rawIds === 'string'
        ? rawIds.split(/[\s,]+/).filter(Boolean)
        : [];
    const acked = this.plannerStore.ackAppleSync(user.userId, ids);
    return {
      status: 200,
      body: { ok: true, acked, remaining: this.plannerStore.pullPendingAppleSync(user.userId).length }
    };
  }

  /**
   * Log a meal from the iPhone Shortcut quick-entry bridge (text and/or base64 image).
   * Returns flat top-level nutrition numbers so Apple Shortcuts can consume them directly.
   */
  async logMealFromBridge(bearerToken, payload) {
    const user = this.plannerStore.findUserByToken(bearerToken);
    if (!user) return { status: 401, body: { error: '同步令牌无效或已重置' } };
    if (!this.enabled()) return { status: 503, body: { error: '健康饮食管家功能当前已在后台暂停' } };
    if (!user.profile) {
      return { status: 400, body: { error: '请先在 QQ 发送「/健康 录入 男/女 年龄 身高 体重 [减脂/维持/增肌]」录入档案' } };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { status: 400, body: { error: '请求体必须为 JSON 对象' } };
    }

    const rawMealType = typeof payload.mealType === 'string' ? payload.mealType.trim() : '';
    const mealTypeHint = ['auto', '自动', '自动判断', '自动判断当前餐次'].includes(rawMealType.toLowerCase()) ? '' : rawMealType;
    const textDescription = String(payload.text ?? payload.description ?? '').trim().slice(0, 500);
    const decodedImage = decodeBridgeImageBase64(payload.imageBase64);
    if (decodedImage.error) {
      return { status: decodedImage.status || 400, body: { error: decodedImage.error } };
    }
    const inlineImages = decodedImage.dataUrl ? [decodedImage.dataUrl] : [];
    if (!inlineImages.length && !textDescription) {
      return { status: 400, body: { error: '请提供食物描述（text）或食物照片（imageBase64）' } };
    }

    try {
      const { log, appleSyncItem, updatedPlan } = await this.estimateAndLogMeal({
        userId: user.userId,
        mealTypeHint,
        textDescription,
        inlineImages
      });
      const rem = updatedPlan.plan.remainingBudget;
      const sourceLabel = mealSourceLabel(log.source);
      const mealLabel = MEAL_LABELS[log.mealType] || log.mealType;
      const notificationText = `${mealLabel}：${log.summary}\n${log.calories} kcal ｜ 蛋白 ${log.proteinG}g（${sourceLabel}）\n今日剩余：${rem.calories} kcal ｜ 蛋白 ${rem.proteinG}g`;
      this.log('info', `已接收快捷指令记餐（用户 ${user.userId}，${log.mealType}，${log.calories} kcal，来源 ${log.source}）`, {
        source: 'health_planner',
        userId: user.userId
      });
      return {
        status: 200,
        body: {
          ok: true,
          day: updatedPlan.plan.day,
          id: log.id,
          mealType: log.mealType,
          mealLabel,
          source: log.source,
          sourceLabel,
          summary: log.summary,
          calories: log.calories,
          proteinG: log.proteinG,
          carbsG: log.carbsG,
          fatG: log.fatG,
          remainingCalories: rem.calories,
          remainingProteinG: rem.proteinG,
          notificationText,
          appleSyncItem
        }
      };
    } catch (error) {
      return { status: 400, body: { error: error?.message || '记餐估算失败，请稍后重试' } };
    }
  }

  // ---- Scheduled Push Scheduler ----

  resolveDueSlotsForUser(user, nowMin, pushSlots) {
    const mode = user.push?.mode || 'all';
    const slotsToSend = [];
    const morningSlot = pushSlots.morningOverview;
    const breakfastSlot = pushSlots.breakfast;
    const lunchSlot = pushSlots.lunch;
    const dinnerSlot = pushSlots.dinner;

    const isDue = hhmm => {
      const m = parseMinutes(hhmm);
      return m >= 0 && nowMin >= m && nowMin - m < 15;
    };

    if (mode === 'morning') {
      const targetTime = morningSlot || breakfastSlot;
      if (isDue(targetTime)) slotsToSend.push({ slotKey: 'morningOverview', singleMealType: '' });
      return slotsToSend;
    }

    if (mode === 'meals') {
      const bTime = breakfastSlot || morningSlot;
      if (isDue(bTime)) slotsToSend.push({ slotKey: 'breakfast', singleMealType: 'breakfast' });
      if (isDue(lunchSlot)) slotsToSend.push({ slotKey: 'lunch', singleMealType: 'lunch' });
      if (isDue(dinnerSlot)) slotsToSend.push({ slotKey: 'dinner', singleMealType: 'dinner' });
      return slotsToSend;
    }

    // Default 'all': morning overview + lunch/dinner dynamic meal reminders
    if (isDue(morningSlot)) slotsToSend.push({ slotKey: 'morningOverview', singleMealType: '' });
    else if (!morningSlot && isDue(breakfastSlot)) slotsToSend.push({ slotKey: 'breakfast', singleMealType: 'breakfast' });
    if (isDue(lunchSlot)) slotsToSend.push({ slotKey: 'lunch', singleMealType: 'lunch' });
    if (isDue(dinnerSlot)) slotsToSend.push({ slotKey: 'dinner', singleMealType: 'dinner' });
    return slotsToSend;
  }

  async sendScheduledPush(user, { slotKey, singleMealType }, day) {
    const payload = await this.buildPlanPayload(user.userId, {
      day,
      singleMealType,
      includeAiTip: !singleMealType // Save tokens by running optional AI tip on morning overview
    });
    if (!payload) return;

    const useGroup = user.push?.channel === 'group'
      && user.push?.targetGroupId
      && groupAllowed(this.configStore.config, user.push.targetGroupId);

    const action = useGroup ? 'send_group_msg' : 'send_private_msg';
    const target = useGroup ? { group_id: user.push.targetGroupId } : { user_id: user.userId };
    const mention = useGroup ? [{ type: 'at', data: { qq: String(user.userId) } }, { type: 'text', data: { text: '\n' } }] : [];

    if (payload.imageBuffer) {
      const headline = singleMealType
        ? `⏰ 到${MEAL_LABELS[singleMealType]}时间了，为你送上本餐食物份量建议${payload.plan.meals[singleMealType]?.adjustedFromLogs ? '（已按今日已吃动态微调）' : ''}：`
        : `☀️ 早安！为你整理了今天（${day}）的早 / 中 / 晚饮食克重方案：`;
      await this.onebot(action, {
        ...target,
        message: [
          ...mention,
          { type: 'text', data: { text: `${headline}\n` } },
          { type: 'image', data: { file: `base64://${payload.imageBuffer.toString('base64')}` } }
        ]
      }, this.configStore.config, 120);
      return;
    }

    await this.onebot(action, {
      ...target,
      message: [...mention, { type: 'text', data: { text: payload.text } }]
    }, this.configStore.config, 45);
  }

  async tick() {
    if (this.scheduled || !this.enabled()) return;
    this.scheduled = true;
    try {
      const nowMs = this.now();
      const { day, time } = beijingDateParts(nowMs);
      const nowMin = parseMinutes(time);
      const pushSlots = this.settings.pushSlots || {};

      for (const user of Object.values(this.plannerStore.state.users)) {
        if (!this.enabled()) break;
        if (!user.profile || user.push?.enabled === false) continue;
        const due = this.resolveDueSlotsForUser(user, nowMin, pushSlots);
        if (!due.length) continue;

        const targetGroup = user.push?.channel === 'group' && user.push?.targetGroupId ? user.push.targetGroupId : user.groupId;
        if (!await this.canReachMember(user.userId, targetGroup)) continue;

        for (const item of due) {
          if (!this.enabled()) break;
          if (!this.plannerStore.claimPushSlot(user.userId, day, item.slotKey)) continue;
          try {
            await this.sendScheduledPush(user, item, day);
            this.log('info', `已推送饮食规划（用户 ${user.userId}，时段 ${item.slotKey}）`, {
              source: 'health_planner',
              userId: user.userId,
              slot: item.slotKey
            });
          } catch (error) {
            this.log('warn', `定时饮食推送失败（用户 ${user.userId}）：${error.message}`, {
              source: 'health_planner',
              userId: user.userId,
              slot: item.slotKey
            });
          }
        }
      }
    } finally {
      this.scheduled = false;
    }
  }

  start() {
    if (this.timer || this.closed) return;
    const step = async () => {
      this.timer = null;
      try { await this.tick(); } catch { this.log('warn', '定时饮食检查未完成'); }
      if (!this.closed) {
        this.timer = setTimeout(step, 60000);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(step, 1500);
    this.timer.unref();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}

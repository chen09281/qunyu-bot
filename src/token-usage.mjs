import { validateBaseline, addApiUsage, apiBillingStatus, toCny } from './api-billing.mjs';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deepseekTariff } from './deepseek-tariff.mjs';
import { writePrivate } from './config.mjs';
import { priceSources, fetchOfficialPrices } from './model-prices.mjs';
import priceSnapshot from './model-prices.snapshot.json' with { type: 'json' };

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const nonNegative = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, 100000) : fallback;
const intCount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const roundCost = value => Math.round((Number(value) || 0) * 1e8) / 1e8;

export function parseTimeMinutes(value, label = '时段') {
  if (typeof value !== 'string' || !timePattern.test(value.trim())) throw new Error(`${label}需为 HH:MM 格式的北京时间，例如 00:30`);
  const [hours, minutes] = value.trim().split(':').map(Number);
  return hours * 60 + minutes;
}

export function beijingClock(timestamp = Date.now()) {
  const time = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  const safe = Number.isFinite(time) ? time : Date.now();
  const shifted = new Date(safe + 8 * 3600 * 1000);
  const day = shifted.toISOString().slice(0, 10);
  const hours = shifted.getUTCHours(), minutes = shifted.getUTCMinutes();
  const hhmm = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return { timestamp: safe, iso: new Date(safe).toISOString(), day, minutes: hours * 60 + minutes, hhmm };
}

export function defaultPricing() {
  return {
    discountEnabled: true,
    discountStart: '00:30',
    discountEnd: '08:30',
    deepseekChat: {
      inputPrice: 2,
      cachedInputPrice: 0.5,
      outputPrice: 8,
      discountInputPrice: 1,
      discountCachedInputPrice: 0.25,
      discountOutputPrice: 4
    },
    deepseekReasoner: {
      inputPrice: 4,
      cachedInputPrice: 1,
      outputPrice: 16,
      discountInputPrice: 1,
      discountCachedInputPrice: 0.25,
      discountOutputPrice: 4
    },
    customModels: []
  };
}

function validateRateBlock(input, defaults, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...defaults };
  const result = {};
  for (const key of ['inputPrice', 'cachedInputPrice', 'outputPrice', 'discountInputPrice', 'discountCachedInputPrice', 'discountOutputPrice']) {
    const raw = input[key] ?? defaults[key];
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0 || num > 100000) throw new Error(`${label}单价必须为 0–100000 的数字（元 / 百万 Tokens）`);
    result[key] = Math.round(num * 10000) / 10000;
  }
  return result;
}

export function validatePricing(input, current = defaultPricing()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('计费配置格式错误');
  const base = { ...defaultPricing(), ...current };
  const discountEnabled = input.discountEnabled === undefined ? base.discountEnabled : input.discountEnabled;
  if (typeof discountEnabled !== 'boolean') throw new Error('分时优惠开关必须为布尔值');
  const discountStart = input.discountStart === undefined ? base.discountStart : String(input.discountStart).trim();
  const discountEnd = input.discountEnd === undefined ? base.discountEnd : String(input.discountEnd).trim();
  if ( parseTimeMinutes(discountStart, '优惠开始时间') === parseTimeMinutes(discountEnd, '优惠结束时间')) {
    throw new Error('优惠开始时间与结束时间不能相同');
  }
  const deepseekChat = validateRateBlock(input.deepseekChat ?? base.deepseekChat, defaultPricing().deepseekChat, 'DeepSeek 标准模型');
  const deepseekReasoner = validateRateBlock(input.deepseekReasoner ?? base.deepseekReasoner, defaultPricing().deepseekReasoner, 'DeepSeek 推理模型');
  const rawCustom = input.customModels === undefined ? base.customModels : input.customModels;
  if (!Array.isArray(rawCustom) || rawCustom.length > 50) throw new Error('自定义模型单价最多保存 50 条');
  const seen = new Set(), customModels = [];
  for (const item of rawCustom) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('自定义模型单价格式错误');
    const provider = String(item.provider || 'any').trim().toLowerCase();
    if (!['any', 'deepseek', 'openai', 'kimi'].includes(provider)) throw new Error('自定义模型服务商无效');
    const model = String(item.model || '').trim();
    if (!model || model.length > 100 || /[\r\n]/.test(model)) throw new Error('请填写有效的自定义计费模型名称（1–100 个字符）');
    const key = `${provider}:${model.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`模型 ${model} 的计费规则重复`);
    seen.add(key);
    const useDiscount = item.discountEnabled === undefined ? provider === 'deepseek' : Boolean(item.discountEnabled);
    const rates = validateRateBlock({
      inputPrice: item.inputPrice ?? 0,
      cachedInputPrice: item.cachedInputPrice ?? item.inputPrice ?? 0,
      outputPrice: item.outputPrice ?? 0,
      discountInputPrice: item.discountInputPrice ?? item.inputPrice ?? 0,
      discountCachedInputPrice: item.discountCachedInputPrice ?? item.cachedInputPrice ?? item.inputPrice ?? 0,
      discountOutputPrice: item.discountOutputPrice ?? item.outputPrice ?? 0
    }, { inputPrice: 0, cachedInputPrice: 0, outputPrice: 0, discountInputPrice: 0, discountCachedInputPrice: 0, discountOutputPrice: 0 }, `模型 ${model} `);
    customModels.push({ provider, model, discountEnabled: useDiscount, ...rates });
  }
  return { discountEnabled, discountStart, discountEnd, deepseekChat, deepseekReasoner, customModels };
}

export function isDiscountTime(timestamp, pricing = defaultPricing()) {
  if (!pricing?.discountEnabled) return false;
  const start = parseTimeMinutes(pricing.discountStart || '00:30');
  const end = parseTimeMinutes(pricing.discountEnd || '08:30');
  const { minutes } = beijingClock(timestamp);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function isDeepseekReasonerModel(model = '') {
  const id = String(model || '').toLowerCase();
  return /reasoner|(?:\b|[-_])r1(?:\b|[-_])|pro/.test(id);
}

export function resolveModelRate(provider = 'deepseek', model = '', pricing = defaultPricing()) {
  const normProvider = String(provider || 'deepseek').trim().toLowerCase();
  const normModel = String(model || '').trim().toLowerCase();
  const custom = (pricing?.customModels || []).find(item =>
    (item.provider === normProvider || item.provider === 'any') && item.model.toLowerCase() === normModel
  ) || (pricing?.customModels || []).find(item =>
    (item.provider === normProvider || item.provider === 'any') && normModel.startsWith(item.model.toLowerCase())
  );
  if (custom) {
    return {
      source: 'custom',
      currency: 'CNY',
      tier: custom.model,
      discountEligible: Boolean(custom.discountEnabled && pricing?.discountEnabled),
      inputPrice: nonNegative(custom.inputPrice),
      cachedInputPrice: nonNegative(custom.cachedInputPrice),
      outputPrice: nonNegative(custom.outputPrice),
      discountInputPrice: nonNegative(custom.discountInputPrice),
      discountCachedInputPrice: nonNegative(custom.discountCachedInputPrice),
      discountOutputPrice: nonNegative(custom.discountOutputPrice)
    };
  }
  const official = (pricing.officialModels || priceSnapshot.models).find(row =>
    (row.provider === normProvider || normProvider === 'unknown')
    && ([row.model, ...(row.aliases || [])].includes(normModel) || (row.provider === 'kimi' && row.model === `kimi-${normModel}`))
  );
  if (official) {
    const offPeak = official.offPeak && typeof official.offPeak === 'object' ? official.offPeak : null;
    return {
      ...official,
      source: 'official',
      tier: offPeak ? '官方分时计价（高峰 / 空闲）' : '官方标准参考价',
      discountEligible: false,
      discountInputPrice: offPeak ? nonNegative(offPeak.inputPrice) : official.inputPrice,
      discountCachedInputPrice: offPeak ? nonNegative(offPeak.cachedInputPrice) : official.cachedInputPrice,
      discountOutputPrice: offPeak ? nonNegative(offPeak.outputPrice) : official.outputPrice
    };
  }
  if (normProvider === 'deepseek' && ['deepseek-chat', 'deepseek-reasoner'].includes(normModel)) {
    const reasoner = isDeepseekReasonerModel(normModel);
    const block = reasoner ? (pricing?.deepseekReasoner || defaultPricing().deepseekReasoner) : (pricing?.deepseekChat || defaultPricing().deepseekChat);
    return {
      source: reasoner ? 'deepseekReasoner' : 'deepseekChat',
      currency: 'CNY',
      tier: reasoner ? 'DeepSeek 推理模型' : 'DeepSeek 标准模型',
      discountEligible: Boolean(pricing?.discountEnabled !== false),
      inputPrice: nonNegative(block.inputPrice),
      cachedInputPrice: nonNegative(block.cachedInputPrice),
      outputPrice: nonNegative(block.outputPrice),
      discountInputPrice: nonNegative(block.discountInputPrice),
      discountCachedInputPrice: nonNegative(block.discountCachedInputPrice),
      discountOutputPrice: nonNegative(block.discountOutputPrice)
    };
  }
  return {
    source: 'unpriced',
    currency: 'CNY',
    tier: '未设置单价（可在下方添加）',
    discountEligible: false,
    inputPrice: 0,
    cachedInputPrice: 0,
    outputPrice: 0,
    discountInputPrice: 0,
    discountCachedInputPrice: 0,
    discountOutputPrice: 0
  };
}

export function computeBucketCost(bucket, provider, model, pricing = defaultPricing()) {
  const rate = resolveModelRate(provider, model, pricing);
  const stdUncached = intCount(bucket.standardUncachedPromptTokens);
  const stdCached = intCount(bucket.standardCachedTokens);
  const stdOut = intCount(bucket.standardCompletionTokens);
  const offUncached = intCount(bucket.discountUncachedPromptTokens);
  const offCached = intCount(bucket.discountCachedTokens);
  const offOut = intCount(bucket.discountCompletionTokens);

  const standardPartCost = (stdUncached * rate.inputPrice + stdCached * rate.cachedInputPrice + stdOut * rate.outputPrice) / 1e6;
  const offPeakFullCost = (offUncached * rate.inputPrice + offCached * rate.cachedInputPrice + offOut * rate.outputPrice) / 1e6;
  const hasDiscountRate = Boolean(rate.discountEligible || rate.offPeak);
  const offPeakActualCost = hasDiscountRate
    ? (offUncached * rate.discountInputPrice + offCached * rate.discountCachedInputPrice + offOut * rate.discountOutputPrice) / 1e6
    : offPeakFullCost;
  const adj = rate.source === 'official' ? (Number(bucket.officialCostAdjustment) || 0) : 0;
  const historicalCost = Number(bucket.officialBilledCost) || 0;
  const cost = roundCost(Math.max(0, standardPartCost + offPeakActualCost + adj + historicalCost));
  const standardCost = roundCost(standardPartCost);
  const discountCost = roundCost(Math.max(0, offPeakActualCost + adj));
  const savedCost = roundCost(Math.max(0, offPeakFullCost - offPeakActualCost - adj));
  return { cost, standardCost, discountCost, savedCost, rate };
}

function emptyCounterBucket() {
  return {
    calls: 0,
    promptTokens: 0,
    cachedTokens: 0,
    uncachedPromptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    unknownBreakdownTokens: 0,
    standardCalls: 0,
    discountCalls: 0,
    standardTokens: 0,
    discountTokens: 0,
    standardUncachedPromptTokens: 0,
    standardCachedTokens: 0,
    standardCompletionTokens: 0,
    discountUncachedPromptTokens: 0,
    discountCachedTokens: 0,
    discountCompletionTokens: 0
  };
}

function addIntoBucket(target, delta) {
  for (const key of Object.keys(emptyCounterBucket())) {
    target[key] = intCount(target[key]) + intCount(delta[key]);
  }
}

export function extractTokenCounts(input = {}) {
  const usage = input.usage && typeof input.usage === 'object' ? input.usage : {};
  const rawPrompt = input.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens;
  const rawCompletion = input.completionTokens ?? usage.completion_tokens ?? usage.output_tokens;
  const promptTokens = intCount(rawPrompt);
  const completionTokens = intCount(rawCompletion);
  const rawCached = input.cachedTokens ?? usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens;
  const cachedTokens = Math.min(promptTokens, intCount(rawCached));
  const rawMiss = usage.prompt_cache_miss_tokens;
  const uncachedPromptTokens = Number.isSafeInteger(rawMiss) && rawMiss >= 0
    ? Math.min(promptTokens, rawMiss)
    : Math.max(0, promptTokens - cachedTokens);
  const rawReasoning = input.reasoningTokens ?? usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens;
  const reasoningTokens = Math.min(completionTokens, intCount(rawReasoning));
  const rawTotal = input.totalTokens ?? input.tokens ?? usage.total_tokens;
  const totalTokens = Number.isSafeInteger(rawTotal) && rawTotal >= 0 ? rawTotal : promptTokens + completionTokens;
  return { promptTokens, cachedTokens, uncachedPromptTokens, completionTokens, reasoningTokens, totalTokens };
}

// 消耗归属：群聊、私聊或后台/定时任务。只保存 QQ 号与最近一次的群名片/昵称，不保存消息内容。
const systemScopeNames = { scheduled: '定时发言', admin: '后台测试与预览', other: '其他后台任务' };
export function normalizeUsageScope(scope) {
  if (!scope || typeof scope !== 'object') return { kind: 'system', id: 'other', userId: '', userName: '' };
  const digits = value => /^\d{5,20}$/.test(String(value ?? '')) ? String(value) : '';
  const userId = digits(scope.userId), userName = String(scope.userName || '').replace(/[\r\n]/g, ' ').trim().slice(0, 60);
  if (scope.kind === 'group' && digits(scope.groupId)) return { kind: 'group', id: digits(scope.groupId), userId, userName };
  if (scope.kind === 'private' && userId) return { kind: 'private', id: userId, userId, userName };
  return { kind: 'system', id: Object.hasOwn(systemScopeNames, scope.id) ? scope.id : 'other', userId: '', userName: '' };
}
const emptyScopeBucket = () => ({ calls: 0, tokens: 0, promptTokens: 0, completionTokens: 0, cost: 0, toolCalls: 0, toolCost: 0 });
function addScopeBucket(target, delta) {
  for (const key of ['calls', 'tokens', 'promptTokens', 'completionTokens', 'toolCalls']) target[key] = intCount(target[key]) + intCount(delta[key]);
  for (const key of ['cost', 'toolCost']) target[key] = roundCost((Number(target[key]) || 0) + (Number(delta[key]) || 0));
}

export class TokenUsageService {
  constructor(dataDir, { now = Date.now, fetchImpl = fetch } = {}) {
    this.dataDir = dataDir;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.syncing = false;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.filePath = join(dataDir, 'token-usage.json');
    this.state = this.load();
    const seedPath = join(dataDir, 'api-billing-baselines.json');
    if (existsSync(seedPath)) {
      const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
      if (!seed.id || !Array.isArray(seed.rows)) throw Error('官方基准文件格式错误');
      const rows = seed.rows.map(validateBaseline);
      if (!(this.state.appliedBillingSeeds || []).includes(seed.id)) {
        for (const row of rows) this.calibrateApi(row);
        (this.state.appliedBillingSeeds ||= []).push(seed.id);
        this.save();
      }
    }
  }
  load() {
    if (!existsSync(this.filePath)) {
      return { pricing: defaultPricing(), models: {}, days: {}, recent: [], updatedAt: null };
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const pricing = validatePricing(raw?.pricing || {}, defaultPricing());
      const models = raw?.models && typeof raw.models === 'object' && !Array.isArray(raw.models) ? raw.models : {};
      const days = raw?.days && typeof raw.days === 'object' && !Array.isArray(raw.days) ? raw.days : {};
      let migrated = false;
      for (const [key, item] of Object.entries(models)) {
        if (item?.provider === 'unknown' && /^(?:kimi|moonshot|k\d)/i.test(item.model || '')) {
          const nextKey = `kimi:${item.model}`;
          const target = models[nextKey] ||= { ...item, ...emptyCounterBucket(), key: nextKey, provider: 'kimi' };
          if (target !== item) addIntoBucket(target, item);
          delete models[key];
          migrated = true;
        }
      }
      for (const day of Object.values(days)) {
        for (const [key, item] of Object.entries(day?.models || {})) {
          if (item?.provider === 'unknown' && /^(?:kimi|moonshot|k\d)/i.test(item.model || '')) {
            const nextKey = `kimi:${item.model}`;
            const target = day.models[nextKey] ||= { ...item, ...emptyCounterBucket(), provider: 'kimi' };
            if (target !== item) addIntoBucket(target, item);
            delete day.models[key];
            migrated = true;
          }
        }
      }
      for (const bucket of [...Object.values(models), ...Object.values(days).flatMap(day => Object.values(day.models || {}))]) {
        bucket.unknownBreakdownTokens = Math.max(intCount(bucket.unknownBreakdownTokens),
          intCount(bucket.totalTokens) - intCount(bucket.promptTokens) - intCount(bucket.completionTokens));
      }
      const recent = Array.isArray(raw?.recent) ? raw.recent.slice(0, 60) : [];
      let state = { pricing, models, days, recent, apiBilling: raw.apiBilling || {}, appliedBillingSeeds: raw.appliedBillingSeeds || [], officialImport: raw.officialImport || null, historyImport: raw.historyImport || null,
        scopeHistoryImport: raw.scopeHistoryImport || null, catalog: raw.catalog || null, updatedAt: raw?.updatedAt || null };
      if (state.officialImport && state.officialImport.reconciledVersion !== 3 && Array.isArray(state.officialImport.rows)) {
        state = this.reconcileOfficialState(state, state.officialImport);
        migrated = true;
      }
      state.tariffMigration = raw.tariffMigration || null;
      if (!state.tariffMigration) {
        let corrected = 0;
        const pricingForMigration = { ...pricing, officialModels: (state.catalog || priceSnapshot).models };
        for (const item of state.recent) {
          if (state.officialImport && item.time < state.officialImport.end) continue;
          const rate = resolveModelRate(item.provider, item.model, pricingForMigration);
          if (rate.source !== 'official' || !rate.offPeak || !Number.isFinite(Date.parse(item.time))) continue;
          const nextPeriod = deepseekTariff(item.time).period;
          if (item.period === nextPeriod) continue;
          const from = item.period === 'discount' ? 'discount' : 'standard', to = nextPeriod;
          const values = { Calls: 1, Tokens: item.totalTokens, UncachedPromptTokens: item.uncachedPromptTokens, CachedTokens: item.cachedTokens, CompletionTokens: item.completionTokens };
          const key = `${item.provider}:${item.model}`, day = beijingClock(item.time).day;
          for (const bucket of [state.models[key], state.days[day]?.models?.[key]]) {
            if (!bucket) continue;
            for (const [name, value] of Object.entries(values)) {
              const n = intCount(value); bucket[from + name] = Math.max(0, intCount(bucket[from + name]) - n); bucket[to + name] = intCount(bucket[to + name]) + n;
            }
          }
          item.period = nextPeriod; corrected++;
        }
        state.tariffMigration = { corrected, at: new Date(this.now()).toISOString(), note: '仅校正保留时间戳的调用；更早未保留时间的调用维持参考估算。' };
        migrated = true;
      }
      // Refresh retained call labels without moving counters a second time.
      for (const item of state.recent) {
        if (state.officialImport && item.time < state.officialImport.end) continue;
        const rate = resolveModelRate(item.provider, item.model, { ...pricing, officialModels: (state.catalog || priceSnapshot).models });
        if (rate.source !== 'official' || !rate.offPeak || !Number.isFinite(Date.parse(item.time))) continue;
        const period = deepseekTariff(item.time).period;
        if (item.period !== period) { item.period = period; migrated = true; }
      }
      if (migrated) writePrivate(this.filePath, state);
      return state;
    } catch {
      throw new Error('Token 统计文件无法读取，请恢复备份；为避免丢失历史，未覆盖原文件');
    }
  }
  save() {
    this.state.updatedAt = new Date(this.now()).toISOString();
    writePrivate(this.filePath, this.state);
  }
  configurePricing(patch) {
    this.state.pricing = validatePricing(patch, this.state.pricing);
    this.save();
    return this.status();
  }
  effectivePricing() {
    return { ...this.state.pricing, officialModels: (this.state.catalog || priceSnapshot).models };
  }
  async syncPrices() {
    if (this.syncing) throw Object.assign(Error('价格正在同步，请稍后查看'), { status: 409 });
    this.syncing = true;
    try {
      const results = await Promise.allSettled(priceSources.map(source => fetchOfficialPrices(source, { fetchImpl: this.fetchImpl })));
      const previous = this.state.catalog || priceSnapshot;
      let models = [...previous.models];
      const sources = { ...previous.sources };
      const checkedAt = new Date(this.now()).toISOString();
      results.forEach((result, i) => {
        const source = priceSources[i];
        if (result.status === 'fulfilled') {
          models = models.filter(row => row.sourceId !== source.id).concat(result.value);
          sources[source.id] = { updatedAt: checkedAt, attemptedAt: checkedAt, error: '' };
        } else {
          // Preserve last known good prices; a markup change must never set prices to zero.
          sources[source.id] = { ...sources[source.id], attemptedAt: checkedAt, error: '同步失败，保留上次价格；请查看官方来源或稍后重试。' };
        }
      });
      this.state.catalog = { models, sources, checkedAt };
      this.save();
      this.syncing = false;
      return this.status();
    } finally { this.syncing = false; }
  }
  importHistory(rows = []) {
    if (this.state.historyImport) return this.state.historyImport;
    if (existsSync(this.filePath) && !existsSync(join(this.dataDir, 'token-usage.before-history.json'))) {
      writePrivate(join(this.dataDir, 'token-usage.before-history.json'), this.state);
    }
    const report = { completedAt: new Date(this.now()).toISOString(), importedTokens: 0, importedCalls: 0,
      unknownCalls: 0, ambiguousTokens: 0, overlappingTokens: 0, rows: rows.length };
    // Legacy totals have no request IDs. Use day/model differences, never add the entire
    // conversation total on top of an existing meter. Conservatively flag pruned/ambiguous days.
    const legacyModels = structuredClone(this.state.models);
    const legacyDays = structuredClone(this.state.days);
    for (const row of rows) {
      report.unknownCalls += intCount(row.unknownCalls);
      if (!row.tokens || !row.day) continue;
      const matches = Object.values(legacyModels).filter(item => item.model === row.model);
      if (matches.length > 1) { report.ambiguousTokens += row.tokens; continue; }
      const provider = matches[0]?.provider || (/^deepseek/i.test(row.model) ? 'deepseek' : /^(kimi|moonshot|k\d)/i.test(row.model) ? 'kimi' : /^(gpt-|o[134](?:-|$))/i.test(row.model) ? 'openai' : 'unknown');
      const key = `${provider}:${row.model}`;
      const known = legacyDays[row.day]?.models?.[key];
      const retainedTokens = Object.values(legacyDays).reduce((sum, day) => sum + intCount(day.models?.[key]?.totalTokens), 0);
      if (!known && intCount(matches[0]?.totalTokens) > retainedTokens) {
        report.ambiguousTokens += row.tokens; continue;
      }
      const tokens = Math.max(0, row.tokens - intCount(known?.totalTokens));
      report.overlappingTokens += Math.min(row.tokens, intCount(known?.totalTokens));
      if (!tokens) continue;
      const calls = Math.max(0, row.calls - row.unknownCalls - intCount(known?.calls));
      const delta = { calls, totalTokens: tokens, unknownBreakdownTokens: tokens };
      const model = this.state.models[key] ||= { key, provider, model: row.model, ...emptyCounterBucket() };
      addIntoBucket(model, delta);
      const time = `${row.day}T00:00:00+08:00`;
      if (!model.lastUsedAt || Date.parse(model.lastUsedAt) < Date.parse(time)) model.lastUsedAt = new Date(time).toISOString();
      const day = this.state.days[row.day] ||= { day: row.day, models: {} };
      const dayModel = day.models[key] ||= { provider, model: row.model, ...emptyCounterBucket() };
      addIntoBucket(dayModel, delta);
      report.importedTokens += tokens; report.importedCalls += calls;
    }
    this.state.historyImport = report;
    this.save();
    return report;
  }
  importScopeHistory(rows = []) {
    if (this.state.scopeHistoryImport) return this.state.scopeHistoryImport;
    const pricing = this.effectivePricing();
    const existingScopeDays = new Set(Object.values(this.state.days).filter(d => d?.scopes && Object.keys(d.scopes).length).map(d => d.day));
    let importedCalls = 0, importedTokens = 0;
    for (const row of rows) {
      if (!row?.day || existingScopeDays.has(row.day)) continue;
      const calls = intCount(row.calls), tokens = intCount(row.tokens);
      if (!calls && !tokens) continue;
      const matches = Object.values(this.state.models).filter(item => item.model === row.model);
      if (matches.length > 1) continue;
      const provider = matches[0]?.provider || (/^deepseek/i.test(row.model) ? 'deepseek' : /^(kimi|moonshot|k\d)/i.test(row.model) ? 'kimi' : /^(gpt-|o[134](?:-|$))/i.test(row.model) ? 'openai' : 'unknown');
      const key = `${provider}:${row.model}`;
      const dayEntry = this.state.days[row.day] ||= { day: row.day, models: {} };
      const dayModel = dayEntry.models?.[key];
      let unitCostCny = 0;
      if (dayModel && intCount(dayModel.totalTokens) > 0) {
        const computed = computeBucketCost(dayModel, provider, row.model, pricing);
        unitCostCny = toCny(computed.cost, computed.rate.currency) / intCount(dayModel.totalTokens);
      }
      const cost = roundCost(tokens * unitCostCny);
      const scope = row.groupId === 'private'
        ? { kind: 'private', userId: row.userId, userName: row.userName }
        : { kind: 'group', groupId: row.groupId, userId: row.userId, userName: row.userName };
      this.addScopeUsage(dayEntry, provider, scope, { calls, tokens, cost });
      importedCalls += calls;
      importedTokens += tokens;
    }
    this.state.scopeHistoryImport = { completedAt: new Date(this.now()).toISOString(), importedCalls, importedTokens, rows: rows.length };
    this.save();
    return this.state.scopeHistoryImport;
  }
  reconcileOfficialState(baseState, report) {
    const incoming = [];
    const incomingTools = [];
    const officialModels = (baseState.catalog || priceSnapshot).models || priceSnapshot.models;
    for (const row of report.rows) {
      if (!row.model) {
        for (const value of Object.values(row.counts || {})) if (!Number.isSafeInteger(value) || value < 0) throw Error('官方工具调用数无效');
        const calls = intCount(row.counts?.function_call);
        const hasCost = row.actualCost !== undefined || row.calculatedCost !== undefined;
        const cost = hasCost ? nonNegative(Number(row.actualCost ?? row.calculatedCost), 0) : 0;
        const dayKey = typeof row.start === 'string' && row.start.length >= 10 ? row.start.slice(0, 10) : report.start.slice(0, 10);
        incomingTools.push({ day: dayKey, name: String(row.name || 'tool'), calls, cost });
        continue;
      }
      if (!['deepseek-flash', 'deepseek-v4-pro'].includes(row.model) || !row.start.endsWith('T00:00:00+08:00')
        || Date.parse(row.end) - Date.parse(row.start) !== 86400000) throw Error('官方导出模型或日期无效');
      for (const value of Object.values(row.counts)) if (!Number.isSafeInteger(value) || value < 0) throw Error('官方 Token 数无效');
      const cached = row.counts.input_cache_hit_tokens || 0, miss = row.counts.input_cache_miss_tokens || 0, output = row.counts.output_tokens || 0;
      const calls = row.counts.request_count || 0, totalTokens = cached + miss + output;
      const official = officialModels.find(m => m.provider === 'deepseek' && m.model === row.model)
        || priceSnapshot.models.find(m => m.provider === 'deepseek' && m.model === row.model);
      const peakCost = official ? (miss * official.inputPrice + cached * official.cachedInputPrice + output * official.outputPrice) / 1e6 : 0;
      const offPeak = official?.offPeak || official;
      const offPeakCost = offPeak ? (miss * offPeak.inputPrice + cached * offPeak.cachedInputPrice + output * offPeak.outputPrice) / 1e6 : peakCost;
      const hasActual = row.actualCost !== undefined || row.calculatedCost !== undefined;
      const actualCost = hasActual ? nonNegative(Number(row.actualCost ?? row.calculatedCost), peakCost) : peakCost;
      const dCalls = 0, sCalls = 0, dCached = 0, sCached = 0, dMiss = 0, sMiss = 0, dOut = 0, sOut = 0;
      const dTokens = 0, sTokens = 0;
      const officialBilledCost = actualCost;
      incoming.push({
        day: row.start.slice(0, 10),
        provider: 'deepseek',
        model: row.model,
        ...emptyCounterBucket(),
        calls,
        promptTokens: cached + miss,
        cachedTokens: cached,
        uncachedPromptTokens: miss,
        completionTokens: output,
        totalTokens,
        standardCalls: sCalls,
        discountCalls: dCalls,
        standardTokens: sTokens,
        discountTokens: dTokens,
        standardCachedTokens: sCached,
        standardUncachedPromptTokens: sMiss,
        standardCompletionTokens: sOut,
        discountCachedTokens: dCached,
        discountUncachedPromptTokens: dMiss,
        discountCompletionTokens: dOut,
        officialBilledCost
      });
    }
    const next = structuredClone(baseState);
    const names = new Set(incoming.map(row => row.model));
    for (const day of Object.values(next.days)) {
      const timestamp = Date.parse(`${day.day}T00:00:00+08:00`);
      if (timestamp < Date.parse(report.start) || timestamp >= Date.parse(report.end)) continue;
      day.toolCalls = 0;
      day.toolCost = 0;
      for (const [key, row] of Object.entries(day.models || {})) {
        const canonical = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(row.model) ? 'deepseek-flash' : row.model;
        if (row.provider !== 'deepseek' || !names.has(canonical)) continue;
        const total = next.models[key];
        if (!total) throw Error('原统计缺少模型累计值');
        for (const counter of Object.keys(emptyCounterBucket())) total[counter] = Math.max(0, intCount(total[counter]) - intCount(row[counter]));
        total.officialBilledCost = (Number(total.officialBilledCost) || 0) - (Number(row.officialBilledCost) || 0);
        total.officialCostAdjustment = (Number(total.officialCostAdjustment) || 0) - (Number(row.officialCostAdjustment) || 0);
        delete day.models[key];
      }
    }
    for (const row of incoming) {
      const key = `${row.provider}:${row.model}`;
      const total = next.models[key] ||= { key, provider: row.provider, model: row.model, ...emptyCounterBucket() };
      addIntoBucket(total, row);
      total.officialBilledCost = roundCost((Number(total.officialBilledCost) || 0) + (Number(row.officialBilledCost) || 0));
      const dayTime = `${row.day}T00:00:00+08:00`;
      if (!total.lastUsedAt || Date.parse(total.lastUsedAt) < Date.parse(dayTime)) total.lastUsedAt = new Date(dayTime).toISOString();
      const day = next.days[row.day] ||= { day: row.day, models: {} };
      const bucket = day.models[key] ||= { provider: row.provider, model: row.model, ...emptyCounterBucket() };
      addIntoBucket(bucket, row);
      bucket.officialBilledCost = roundCost((Number(bucket.officialBilledCost) || 0) + (Number(row.officialBilledCost) || 0));
    }
    for (const tool of incomingTools) {
      const day = next.days[tool.day] ||= { day: tool.day, models: {} };
      day.toolCalls = intCount(day.toolCalls) + tool.calls;
      day.toolCost = roundCost((Number(day.toolCost) || 0) + tool.cost);
    }
    const toolCalls = incomingTools.reduce((sum, item) => sum + item.calls, 0);
    const toolCost = roundCost(incomingTools.reduce((sum, item) => sum + item.cost, 0));
    next.officialImport = {
      ...report,
      importedAt: report.importedAt || new Date(this.now()).toISOString(),
      reconciledVersion: 3,
      tokens: incoming.reduce((sum, row) => sum + row.totalTokens, 0),
      calls: incoming.reduce((sum, row) => sum + row.calls, 0),
      toolCalls,
      toolCost
    };
    return next;
  }
  importOfficial(report) {
    if (!report || report.version !== 1 || report.provider !== 'deepseek' || report.keyName !== 'qqbot'
      || !/^[a-f0-9]{64}$/.test(report.id) || !Array.isArray(report.rows) || report.rows.length > 10000
      || !Number.isFinite(Date.parse(report.start)) || !Number.isFinite(Date.parse(report.end))) throw Error('官方导入数据无效');
    if (this.state.officialImport?.id === report.id && this.state.officialImport?.reconciledVersion === 3) return this.status();
    if (this.state.officialImport && this.state.officialImport.id !== report.id) throw Error('已有官方导出快照；请先核对重叠区间再导入新的快照');
    // Keep the meter backup private. The original ledger remains available for rollback.
    if (!existsSync(join(this.dataDir, 'token-usage.before-official.json'))) writePrivate(join(this.dataDir, 'token-usage.before-official.json'), this.state);
    this.state = this.reconcileOfficialState(this.state, report);
    this.save();
    return this.status();
  }
  calibrateApi(input) {
    const row = validateBaseline(input);
    const previous = this.state.apiBilling?.[row.provider];
    const audit = previous ? [...(previous.audit || []), { at: previous.at, cost: previous.cost, currency: previous.currency }].slice(-20) : [];
    // 官方网页通常只统计到某日 00:00（北京时间）。指定截止日时，截止日及之后已记录的调用补入新增，避免漏算；
    // 未指定则从保存时刻开始累计。
    const asOf = row.asOf || null;
    const days = {};
    for (const day of asOf ? this.status({ start: asOf, detailed: true }).byDay : []) {
      for (const item of day.models) {
        if (item.provider !== row.provider || item.unpriced) continue;
        const key = `${day.day}:CNY`, target = days[key] ||= { day: day.day, currency: 'CNY', cost: 0, tokens: 0, requests: 0 };
        target.cost = roundCost(target.cost + toCny(item.cost, item.currency)); target.tokens += item.totalTokens; target.requests += item.calls;
      }
      if (row.provider === 'deepseek' && day.toolCalls) {
        const key = `${day.day}:CNY`, target = days[key] ||= { day: day.day, currency: 'CNY', cost: 0, tokens: 0, requests: 0 };
        target.cost = roundCost(target.cost + (Number(day.toolCost) || 0)); target.requests += intCount(day.toolCalls);
      }
    }
    (this.state.apiBilling ||= {})[row.provider] = { ...row, asOf, at: new Date(this.now()).toISOString(), days, audit };
    this.save();
    return this.apiStatus();
  }
  apiStatus() { return apiBillingStatus(this.state, this.status({ detailed: true })); }
  clear() {
    this.state.apiBilling = {};
    this.state.models = {};
    this.state.days = {};
    this.state.recent = [];
    this.state.officialImport = null;
    this.state.historyImport = { completedAt: new Date(this.now()).toISOString(), cleared: true };
    this.state.scopeHistoryImport = { completedAt: new Date(this.now()).toISOString(), cleared: true };
    this.save();
    return this.status();
  }
  recordTool(name, timestamp = this.now(), scope = null) {
    if (!['search', 'fetch'].includes(name)) throw Error('未知工具类型');
    const clock = beijingClock(timestamp), day = this.state.days[clock.day] ||= { day: clock.day, models: {} };
    day.toolCalls = intCount(day.toolCalls) + 1;
    day.toolCost = roundCost((Number(day.toolCost) || 0) + 0.005);
    addApiUsage(this.state, 'deepseek', 'CNY', clock.day, 0.005, 0, 1);
    if (scope) this.addScopeUsage(day, 'deepseek', scope, { toolCalls: 1, toolCost: 0.005 });
    this.save();
  }
  // 按天、按 API 渠道累计群聊 / 私聊 / 用户的消耗，金额按记录时单价折算为人民币。
  addScopeUsage(day, provider, rawScope, delta) {
    const scope = normalizeUsageScope(rawScope);
    const scopes = day.scopes ||= {};
    const key = `${provider}|${scope.kind}:${scope.id}`;
    const bucket = scopes[key] ||= { provider, kind: scope.kind, id: scope.id, ...emptyScopeBucket() };
    addScopeBucket(bucket, delta);
    if (!scope.userId) return;
    const users = day.users ||= {};
    const userKey = `${provider}|${scope.userId}`;
    const user = users[userKey] ||= { provider, userId: scope.userId, name: '', groups: [], private: false, ...emptyScopeBucket() };
    addScopeBucket(user, delta);
    if (scope.userName) user.name = scope.userName;
    if (scope.kind === 'group' && !user.groups.includes(scope.id) && user.groups.length < 20) user.groups.push(scope.id);
    if (scope.kind === 'private') user.private = true;
  }
  scopeStatus(options = {}) {
    const start = String(options.start || ''), end = String(options.end || ''), provider = String(options.provider || '');
    for (const date of [start, end]) {
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) throw new Error('请选择有效日期');
    }
    if (start && end && start > end) throw new Error('开始日期不能晚于结束日期');
    if (provider && !/^[a-z0-9_-]{1,32}$/.test(provider)) throw new Error('API 渠道无效');
    const scopes = new Map(), users = new Map(), totals = emptyScopeBucket();
    let since = null;
    for (const day of Object.values(this.state.days)) {
      if (!day?.day || (!day.scopes && !day.users)) continue;
      if (!since || day.day < since) since = day.day;
      if ((start && day.day < start) || (end && day.day > end)) continue;
      for (const item of Object.values(day.scopes || {})) {
        if (provider && item.provider !== provider) continue;
        const key = `${item.kind}:${item.id}`;
        const target = scopes.get(key) || { kind: item.kind, id: item.id, name: item.kind === 'system' ? systemScopeNames[item.id] || item.id : '', ...emptyScopeBucket(), lastDay: day.day };
        addScopeBucket(target, item); addScopeBucket(totals, item);
        if (day.day > target.lastDay) target.lastDay = day.day;
        scopes.set(key, target);
      }
      for (const item of Object.values(day.users || {})) {
        if (provider && item.provider !== provider) continue;
        const target = users.get(item.userId) || { userId: item.userId, name: '', groups: [], private: false, ...emptyScopeBucket(), lastDay: '' };
        addScopeBucket(target, item);
        if (item.name && day.day >= target.lastDay) target.name = item.name;
        if (day.day > target.lastDay) target.lastDay = day.day;
        for (const group of item.groups || []) if (!target.groups.includes(group) && target.groups.length < 20) target.groups.push(group);
        target.private ||= Boolean(item.private);
        users.set(item.userId, target);
      }
    }
    const withTotal = item => ({ ...item, totalCost: roundCost(item.cost + item.toolCost) });
    const byCost = (a, b) => b.totalCost - a.totalCost || b.tokens - a.tokens || String(a.id || a.userId).localeCompare(String(b.id || b.userId));
    return {
      since,
      filters: { start, end, provider },
      totals: withTotal(totals),
      scopes: [...scopes.values()].map(withTotal).sort(byCost),
      users: [...users.values()].map(withTotal).sort(byCost).slice(0, 200)
    };
  }
  record(input = {}) {
    const counts = extractTokenCounts(input);
    const provider = String(input.provider || 'deepseek').trim().toLowerCase() || 'deepseek';
    const model = String(input.model || 'unknown').trim() || 'unknown';
    const profileName = String(input.profileName || '').trim().slice(0, 80);
    const purpose = String(input.purpose || 'chat').trim().slice(0, 32);
    const clock = beijingClock(input.timestamp ?? this.now());
    const rate = resolveModelRate(provider, model, this.effectivePricing());
    const officialTariff = rate.source === 'official' && rate.offPeak;
    const inDiscountWindow = officialTariff ? !deepseekTariff(clock.timestamp).peak : isDiscountTime(clock.timestamp, this.state.pricing);
    const discountApplied = inDiscountWindow && Boolean(officialTariff || rate.discountEligible);
    const period = discountApplied ? 'discount' : 'standard';

    const delta = {
      ...emptyCounterBucket(),
      calls: 1,
      promptTokens: counts.promptTokens,
      cachedTokens: counts.cachedTokens,
      uncachedPromptTokens: counts.uncachedPromptTokens,
      completionTokens: counts.completionTokens,
      reasoningTokens: counts.reasoningTokens,
      totalTokens: counts.totalTokens,
      unknownBreakdownTokens: Math.max(0, counts.totalTokens - counts.promptTokens - counts.completionTokens),
      ...(discountApplied ? {
        discountCalls: 1,
        discountTokens: counts.totalTokens,
        discountUncachedPromptTokens: counts.uncachedPromptTokens,
        discountCachedTokens: counts.cachedTokens,
        discountCompletionTokens: counts.completionTokens
      } : {
        standardCalls: 1,
        standardTokens: counts.totalTokens,
        standardUncachedPromptTokens: counts.uncachedPromptTokens,
        standardCachedTokens: counts.cachedTokens,
        standardCompletionTokens: counts.completionTokens
      })
    };

    const modelKey = `${provider}:${model}`;
    const existingModel = this.state.models[modelKey] || {
      key: modelKey,
      provider,
      model,
      profileName,
      ...emptyCounterBucket(),
      lastUsedAt: clock.iso
    };
    addIntoBucket(existingModel, delta);
    if (profileName) existingModel.profileName = profileName;
    existingModel.lastUsedAt = clock.iso;
    this.state.models[modelKey] = existingModel;

    const dayEntry = this.state.days[clock.day] || { day: clock.day, models: {} };
    const dayModel = dayEntry.models[modelKey] || { provider, model, ...emptyCounterBucket() };
    addIntoBucket(dayModel, delta);
    dayModel.lastUsedAt = clock.iso;
    dayEntry.models[modelKey] = dayModel;
    this.state.days[clock.day] = dayEntry;

    const callCost = computeBucketCost(delta, provider, model, this.effectivePricing());
    const recordItem = {
      id: `${clock.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
      time: clock.iso,
      beijingTime: `${clock.day} ${clock.hhmm}`,
      provider,
      model,
      profileName,
      purpose,
      period,
      inDiscountWindow,
      ...counts,
      cost: callCost.cost,
      currency: callCost.rate.currency,
      savedCost: callCost.savedCost
    };
    addApiUsage(this.state, provider, callCost.rate.currency, clock.day, callCost.cost, counts.totalTokens, 1);
    if (input.scope) {
      this.addScopeUsage(dayEntry, provider, input.scope, { calls: 1, tokens: counts.totalTokens, promptTokens: counts.promptTokens,
        completionTokens: counts.completionTokens, cost: toCny(callCost.cost, callCost.rate.currency) });
    }
    this.state.recent.unshift(recordItem);
    if (this.state.recent.length > 50) this.state.recent.length = 50;
    this.save();
    return recordItem;
  }
  status(options = {}) {
    const model = String(options.model || '');
    const start = String(options.start || ''), end = String(options.end || '');
    for (const date of [start, end]) {
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('请选择有效日期');
    }
    if (start && end && start > end) throw new Error('开始日期不能晚于结束日期');
    const sort = options.sort || 'tokens-desc';
    if (!['time-desc', 'time-asc', 'tokens-desc', 'tokens-asc', 'cost-desc', 'cost-asc', 'calls-desc', 'calls-asc'].includes(sort)) throw new Error('排序方式无效');
    const matchesModel = key => !model || key === model;
    const matchesDay = day => (!start || day >= start) && (!end || day <= end);
    const includeTools = !model || model === '__tools__';
    const sourceDays = Object.values(this.state.days)
      .filter(day => day && typeof day.day === 'string' && day.models && matchesDay(day.day))
      .map(day => ({ ...day, toolCalls: includeTools ? day.toolCalls : 0, toolCost: includeTools ? day.toolCost : 0,
        models: Object.fromEntries(Object.entries(day.models).filter(([key]) => matchesModel(key))) }))
      .filter(day => Object.keys(day.models).length || day.toolCalls || day.toolCost);
    let sourceModels = Object.values(this.state.models).filter(entry => matchesModel(entry.key || `${entry.provider}:${entry.model}`));
    if (start || end) {
      const grouped = new Map();
      for (const day of sourceDays) for (const [key, item] of Object.entries(day.models)) {
        const bucket = grouped.get(key) || { ...emptyCounterBucket(), key, provider: item.provider, model: item.model,
          profileName: this.state.models[key]?.profileName || '', lastUsedAt: null, officialBilledCost: 0, officialCostAdjustment: 0 };
        addIntoBucket(bucket, item);
        bucket.officialBilledCost = roundCost(bucket.officialBilledCost + (Number(item.officialBilledCost) || 0));
        bucket.officialCostAdjustment = roundCost(bucket.officialCostAdjustment + (Number(item.officialCostAdjustment) || 0));
        const lastUsed = item.lastUsedAt || `${day.day}T00:00:00+08:00`;
        if (!bucket.lastUsedAt || Date.parse(lastUsed) > Date.parse(bucket.lastUsedAt)) bucket.lastUsedAt = lastUsed;
        grouped.set(key, bucket);
      }
      sourceModels = [...grouped.values()];
    }
    sourceModels = sourceModels.map(entry => {
      const key = entry.key || `${entry.provider}:${entry.model}`;
      const latestDay = sourceDays.filter(day => day.models[key]).map(day => day.day).sort().at(-1);
      return { ...entry, lastUsedAt: entry.lastUsedAt || (latestDay ? `${latestDay}T00:00:00+08:00` : null) };
    });
    const compare = (a, b, days = false) => {
      const [field, direction] = sort.split('-'), sign = direction === 'asc' ? 1 : -1;
      // 不将人民币与美元当成同一种货币直接比较。
      if (field === 'cost' && !days && a.rate.currency !== b.rate.currency) return a.rate.currency.localeCompare(b.rate.currency);
      const delta = field === 'time' ? (Date.parse(days ? a.day : a.lastUsedAt) || 0) - (Date.parse(days ? b.day : b.lastUsedAt) || 0)
        : field === 'tokens' ? a.totalTokens - b.totalTokens : field === 'calls' ? a.calls - b.calls
        : days ? a.cost - b.cost || a.costUSD - b.costUSD : a.cost - b.cost;
      return sign * delta || String(a.key || a.day).localeCompare(String(b.key || b.day));
    };
    const pricing = this.effectivePricing();
    const nowClock = beijingClock(this.now());
    const currentInDiscount = isDiscountTime(nowClock.timestamp, pricing);
    const totals = {
      ...emptyCounterBucket(),
      cost: 0,
      standardCost: 0,
      discountCost: 0,
      savedCost: 0,
      todayTokens: 0,
      todayCost: 0,
      todayCalls: 0
    };
    Object.assign(totals, { officialBilledCost: 0, modelCost: 0, toolCalls: 0, toolCost: 0, costUSD: 0, todayCostUSD: 0, unpricedTokens: 0 });

    const byModel = sourceModels.map(entry => {
      const bucket = { ...emptyCounterBucket(), ...entry };
      const computed = computeBucketCost(bucket, entry.provider, entry.model, pricing);
      addIntoBucket(totals, bucket);
      const usd = computed.rate.currency === 'USD';
      totals[usd ? 'costUSD' : 'cost'] = roundCost(totals[usd ? 'costUSD' : 'cost'] + computed.cost);
      if (!usd) {
        totals.officialBilledCost = roundCost(totals.officialBilledCost + (Number(bucket.officialBilledCost) || 0));
        totals.modelCost = roundCost(totals.modelCost + computed.cost);
        totals.standardCost = roundCost(totals.standardCost + computed.standardCost);
        totals.discountCost = roundCost(totals.discountCost + computed.discountCost);
        totals.savedCost = roundCost(totals.savedCost + computed.savedCost);
      }
      if (computed.rate.source === 'unpriced') totals.unpricedTokens += bucket.totalTokens;
      return {
        key: entry.key || `${entry.provider}:${entry.model}`,
        provider: entry.provider,
        model: entry.model,
        profileName: entry.profileName || '',
        lastUsedAt: entry.lastUsedAt || null,
        ...bucket,
        cost: computed.cost,
        standardCost: computed.standardCost,
        discountCost: computed.discountCost,
        savedCost: computed.savedCost,
        rate: computed.rate
      };
    }).sort((a, b) => compare(a, b));

    const byDay = sourceDays
      .filter(day => day && typeof day.day === 'string' && day.models && typeof day.models === 'object')
      .map(day => {
        const toolCalls = intCount(day.toolCalls);
        const toolCost = roundCost(day.toolCost);
        const dayTotals = {
          ...emptyCounterBucket(),
          toolCalls,
          toolCost,
          modelCost: 0,
          cost: 0,
          costUSD: 0,
          standardCost: 0,
          discountCost: 0,
          savedCost: 0
        };
        const models = Object.entries(day.models).map(([key, item]) => {
          const bucket = { ...emptyCounterBucket(), ...item };
          const computed = computeBucketCost(bucket, item.provider, item.model, pricing);
          addIntoBucket(dayTotals, bucket);
          const usd = computed.rate.currency === 'USD';
          dayTotals[usd ? 'costUSD' : 'cost'] = roundCost(dayTotals[usd ? 'costUSD' : 'cost'] + computed.cost);
          if (!usd) {
            dayTotals.modelCost = roundCost(dayTotals.modelCost + computed.cost);
            dayTotals.standardCost = roundCost(dayTotals.standardCost + computed.standardCost);
            dayTotals.discountCost = roundCost(dayTotals.discountCost + computed.discountCost);
            dayTotals.savedCost = roundCost(dayTotals.savedCost + computed.savedCost);
          }
          return {
            key,
            provider: item.provider,
            model: item.model,
            calls: bucket.calls,
            totalTokens: bucket.totalTokens,
            unknownBreakdownTokens: bucket.unknownBreakdownTokens,
            unpriced: computed.rate.source === 'unpriced',
            promptTokens: bucket.promptTokens,
            cachedTokens: bucket.cachedTokens,
            completionTokens: bucket.completionTokens,
            standardTokens: bucket.standardTokens,
            discountTokens: bucket.discountTokens,
            cost: computed.cost,
            currency: computed.rate.currency,
            savedCost: computed.savedCost
          };
        }).sort((a, b) => b.totalTokens - a.totalTokens);
        dayTotals.cost = roundCost(dayTotals.modelCost + toolCost);
        return { day: day.day, ...dayTotals, models };
      })
      .sort((a, b) => options.sort ? compare(a, b, true) : b.day.localeCompare(a.day));

    for (const day of sourceDays) {
      if (!day || typeof day !== 'object') continue;
      totals.toolCalls += intCount(day.toolCalls);
      totals.toolCost = roundCost(totals.toolCost + (Number(day.toolCost) || 0));
    }
    totals.cost = roundCost(totals.modelCost + totals.toolCost);

    const todayEntry = byDay.find(item => item.day === nowClock.day);
    if (todayEntry) {
      totals.todayTokens = todayEntry.totalTokens;
      totals.todayCost = todayEntry.cost;
      totals.todayCostUSD = todayEntry.costUSD;
      totals.todayCalls = todayEntry.calls;
    }

    const recent = (this.state.recent || []).filter(item => matchesModel(`${item.provider}:${item.model}`) && matchesDay(beijingClock(item.time).day)).map(item => {
      const singleBucket = {
        ...emptyCounterBucket(),
        ...(item.period === 'discount' ? {
          discountUncachedPromptTokens: item.uncachedPromptTokens,
          discountCachedTokens: item.cachedTokens,
          discountCompletionTokens: item.completionTokens
        } : {
          standardUncachedPromptTokens: item.uncachedPromptTokens,
          standardCachedTokens: item.cachedTokens,
          standardCompletionTokens: item.completionTokens
        })
      };
      const computed = computeBucketCost(singleBucket, item.provider, item.model, pricing);
      return { ...item, cost: computed.cost, savedCost: computed.savedCost, currency: computed.rate.currency };
    });

    return {
      pricing: this.state.pricing,
      catalog: { ...(this.state.catalog || priceSnapshot), syncing: this.syncing },
      tariffMigration: this.state.tariffMigration || null,
      historyImport: this.state.historyImport || null,
      officialImport: this.state.officialImport || null,
      currentPeriod: {
        beijingTime: `${nowClock.day} ${nowClock.hhmm}`,
        period: currentInDiscount ? 'discount' : 'standard',
        label: deepseekTariff(this.now()).peak ? 'DeepSeek 高峰计费（北京时间）' : 'DeepSeek 谷时计费（北京时间）',
        calendarKnown: deepseekTariff(this.now()).calendarKnown
      },
      totals,
      byModel,
      filters: { model, start, end, sort },
      modelOptions: Object.values(this.state.models).map(entry => ({ key: entry.key || `${entry.provider}:${entry.model}`, provider: entry.provider, model: entry.model })).sort((a, b) => a.key.localeCompare(b.key)),
      byDay: options.detailed ? byDay : byDay.slice(0, 30),
      recent: recent.slice(0, 30),
      updatedAt: this.state.updatedAt
    };
  }
}

export const USD_TO_CNY = 7.25;
const round = n => Math.round((Number(n) || 0) * 1e8) / 1e8;
export const toCny = (cost, currency = 'CNY') => round((Number(cost) || 0) * (currency === 'USD' ? USD_TO_CNY : 1));

export function validateBaseline(input) {
  const provider = String(input.provider || '');
  if (!['deepseek', 'openai', 'kimi', 'anthropic', 'unknown'].includes(provider)) throw Error('API 渠道无效');
  const rawCurrency = input.currency === undefined || input.currency === '' ? 'CNY' : input.currency;
  if (!['CNY', 'USD'].includes(rawCurrency)) throw Error('请选择人民币或美元');
  const result = { provider, currency: 'CNY', label: String(input.label || provider).slice(0, 80) };
  for (const field of ['cost', 'tokens', 'requests']) {
    const n = Number(input[field]);
    if (!['string', 'number'].includes(typeof input[field]) || String(input[field]).trim() === '' || !Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER || n < 0 || (field !== 'cost' && !Number.isSafeInteger(n))) throw Error('金额、Token 和请求次数必须为非负数字，次数与 Token 须为整数');
    result[field] = field === 'cost' ? toCny(n, rawCurrency) : n;
  }
  if (input.asOf !== undefined && input.asOf !== '') {
    const asOf = String(input.asOf);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || new Date(`${asOf}T00:00:00Z`).toISOString().slice(0, 10) !== asOf) throw Error('官方数据截止日期无效');
    result.asOf = asOf;
  }
  return result;
}

export function addApiUsage(state, provider, currency, day, cost, tokens, requests) {
  const baseline = state.apiBilling?.[provider];
  if (!baseline) return;
  const cnyCost = toCny(cost, currency);
  const key = `${day}:CNY`;
  const row = baseline.days[key] ||= { day, currency: 'CNY', cost: 0, tokens: 0, requests: 0 };
  row.cost = round(row.cost + cnyCost);
  row.tokens += tokens;
  row.requests += requests;
}

export function apiBillingStatus(state, legacy) {
  const providers = new Set([...legacy.byModel.map(row => row.provider), ...Object.keys(state.apiBilling || {})]);
  if (legacy.totals.toolCalls) providers.add('deepseek');
  const rows = [], days = [], models = [], modelDays = [];

  for (const dayEntry of legacy.byDay || []) {
    if (!dayEntry?.day) continue;
    for (const item of dayEntry.models || []) {
      modelDays.push({
        provider: item.provider,
        model: item.model,
        day: dayEntry.day,
        currency: 'CNY',
        cost: toCny(item.cost, item.currency),
        tokens: item.totalTokens || 0,
        promptTokens: item.promptTokens || 0,
        completionTokens: item.completionTokens || 0,
        requests: item.calls || 0
      });
    }
    if (dayEntry.toolCalls || dayEntry.toolCost) {
      modelDays.push({
        provider: 'deepseek',
        model: '联网搜索与抓取',
        isTool: true,
        day: dayEntry.day,
        currency: 'CNY',
        cost: round(dayEntry.toolCost || 0),
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        requests: dayEntry.toolCalls || 0
      });
    }
  }

  for (const provider of providers) {
    const providerModels = legacy.byModel.filter(row => row.provider === provider);
    const promptTokens = providerModels.reduce((sum, row) => sum + (row.promptTokens || 0), 0);
    const completionTokens = providerModels.reduce((sum, row) => sum + (row.completionTokens || 0), 0);

    for (const row of providerModels) {
      models.push({
        provider,
        model: row.model,
        currency: 'CNY',
        cost: toCny(row.cost, row.rate?.currency),
        tokens: row.totalTokens || 0,
        promptTokens: row.promptTokens || 0,
        completionTokens: row.completionTokens || 0,
        requests: row.calls || 0
      });
    }
    if (provider === 'deepseek' && (legacy.totals.toolCalls || legacy.totals.toolCost)) {
      models.push({
        provider: 'deepseek',
        model: '联网搜索与抓取',
        isTool: true,
        currency: 'CNY',
        cost: round(legacy.totals.toolCost || 0),
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        requests: legacy.totals.toolCalls || 0
      });
    }

    const baseline = state.apiBilling?.[provider];
    if (baseline) {
      const mergedDays = new Map();
      for (const rawRow of Object.values(baseline.days || {})) {
        if (!rawRow?.day) continue;
        const prev = mergedDays.get(rawRow.day) || {
          day: rawRow.day,
          currency: 'CNY',
          cost: 0,
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          requests: 0
        };
        prev.cost = round(prev.cost + toCny(rawRow.cost, rawRow.currency));
        prev.tokens += rawRow.tokens || 0;
        prev.requests += rawRow.requests || 0;
        mergedDays.set(rawRow.day, prev);
      }
      for (const [dayKey, dayVal] of mergedDays) {
        const dayModels = modelDays.filter(m => m.provider === provider && m.day === dayKey);
        dayVal.promptTokens = dayModels.reduce((sum, m) => sum + (m.promptTokens || 0), 0);
        dayVal.completionTokens = dayModels.reduce((sum, m) => sum + (m.completionTokens || 0), 0);
      }
      const increments = [...mergedDays.values()];
      const added = increments.reduce(
        (sum, row) => ({
          cost: round(sum.cost + row.cost),
          tokens: sum.tokens + row.tokens,
          requests: sum.requests + row.requests
        }),
        { cost: 0, tokens: 0, requests: 0 }
      );
      const official = {
        cost: toCny(baseline.cost, baseline.currency),
        tokens: baseline.tokens,
        requests: baseline.requests
      };
      const totalCost = round(official.cost + added.cost);
      rows.push({
        provider,
        currency: 'CNY',
        label: baseline.label,
        calibratedAt: baseline.at,
        asOf: baseline.asOf || null,
        official,
        added,
        cost: totalCost,
        tokens: official.tokens + added.tokens,
        promptTokens,
        completionTokens,
        requests: official.requests + added.requests
      });
      days.push(...increments.map(row => ({ ...row, provider })));
    } else {
      const sum = { cost: 0, tokens: 0, requests: 0 };
      for (const row of providerModels) {
        sum.cost = round(sum.cost + toCny(row.cost, row.rate?.currency));
        sum.tokens += row.totalTokens;
        sum.requests += row.calls;
      }
      if (provider === 'deepseek') {
        sum.cost = round(sum.cost + legacy.totals.toolCost);
        sum.requests += legacy.totals.toolCalls;
      }
      if (sum.cost > 0 || sum.tokens > 0 || sum.requests > 0) {
        rows.push({
          provider,
          currency: 'CNY',
          label: provider,
          calibratedAt: null,
          official: null,
          added: { ...sum },
          ...sum,
          promptTokens,
          completionTokens
        });
      }
      const byDayMap = new Map();
      for (const mDay of modelDays.filter(m => m.provider === provider)) {
        const prev = byDayMap.get(mDay.day) || {
          provider,
          day: mDay.day,
          currency: 'CNY',
          cost: 0,
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          requests: 0
        };
        prev.cost = round(prev.cost + mDay.cost);
        prev.tokens += mDay.tokens;
        prev.promptTokens += mDay.promptTokens;
        prev.completionTokens += mDay.completionTokens;
        prev.requests += mDay.requests;
        byDayMap.set(mDay.day, prev);
      }
      days.push(...byDayMap.values());
    }
  }

  const scopeDays = [], userDays = [];
  for (const dayEntry of Object.values(state.days || {})) {
    if (!dayEntry?.day) continue;
    for (const item of Object.values(dayEntry.scopes || {})) {
      scopeDays.push({
        day: dayEntry.day,
        provider: item.provider,
        kind: item.kind,
        id: item.id,
        calls: item.calls || 0,
        tokens: item.tokens || 0,
        promptTokens: item.promptTokens || 0,
        completionTokens: item.completionTokens || 0,
        toolCalls: item.toolCalls || 0,
        cost: round((Number(item.cost) || 0) + (Number(item.toolCost) || 0))
      });
    }
    for (const item of Object.values(dayEntry.users || {})) {
      userDays.push({
        day: dayEntry.day,
        provider: item.provider,
        userId: item.userId,
        name: item.name || '',
        groups: item.groups || [],
        private: Boolean(item.private),
        calls: item.calls || 0,
        tokens: item.tokens || 0,
        promptTokens: item.promptTokens || 0,
        completionTokens: item.completionTokens || 0,
        toolCalls: item.toolCalls || 0,
        cost: round((Number(item.cost) || 0) + (Number(item.toolCost) || 0))
      });
    }
  }

  return {
    rows,
    days: days.sort((a, b) => b.day.localeCompare(a.day)),
    models,
    modelDays: modelDays.sort((a, b) => b.day.localeCompare(a.day)),
    scopeDays: scopeDays.sort((a, b) => b.day.localeCompare(a.day)),
    userDays: userDays.sort((a, b) => b.day.localeCompare(a.day))
  };
}

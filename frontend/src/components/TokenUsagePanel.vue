<script setup>
import { computed, inject, onMounted, reactive, ref, watch } from 'vue';
import { consoleKey } from '../composables/useConsole';
import ThemedDateRangePicker from './ThemedDateRangePicker.vue';
import WorkspaceIcon from './WorkspaceIcon.vue';

const c = inject(consoleKey);
const props = defineProps({ pricingOnly: Boolean });
const activeTab = ref(props.pricingOnly ? 'pricing' : 'models');
const filters = reactive({ model: '', range: 'all', start: '', end: '', sort: 'time-desc' });
function filterQuery() {
  return new URLSearchParams({
    detailed: '1',
    model: filters.model,
    start: filters.start,
    end: filters.end,
    sort: filters.sort
  }).toString();
}
const appliedScope = computed(() => {
  const f = state.data?.filters;
  if (!f) return '全部模型 · 全部时间';
  const model = state.data.modelOptions?.find(item => item.key === f.model);
  return `${f.model === '__tools__' ? '仅联网工具' : model ? `${providerNames[model.provider] || model.provider} / ${model.model}` : f.model ? f.model : '全部模型与工具'} · ${f.start || '最早记录'} 至 ${f.end || '最新记录'}（北京时间，含首尾日期）`;
});
function resetFilters() {
  Object.assign(filters, { model: '', range: 'all', start: '', end: '', sort: 'time-desc' });
  void load();
}
const providerNames = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  kimi: 'Kimi',
  anthropic: 'Anthropic',
  unknown: '其他渠道',
  any: '通用'
};

const defaultPricing = () => ({
  discountEnabled: true,
  discountStart: '00:30',
  discountEnd: '08:30',
  deepseekChat: { inputPrice: 2, cachedInputPrice: 0.5, outputPrice: 8, discountInputPrice: 1, discountCachedInputPrice: 0.25, discountOutputPrice: 4 },
  deepseekReasoner: { inputPrice: 4, cachedInputPrice: 1, outputPrice: 16, discountInputPrice: 1, discountCachedInputPrice: 0.25, discountOutputPrice: 4 },
  customModels: []
});

const state = reactive({
  loading: false,
  saving: false,
  clearing: false,
  syncing: false,
  error: '',
  data: null,
  draft: defaultPricing(),
  baseline: '',
  newCustom: { provider: 'openai', model: '', discountEnabled: false, inputPrice: 2, cachedInputPrice: 0.5, outputPrice: 8, discountInputPrice: 2, discountCachedInputPrice: 0.5, discountOutputPrice: 8 }
});

const busy = computed(() => state.loading || state.saving || state.clearing || state.syncing);
const dirty = computed(() => state.baseline !== '' && JSON.stringify(state.draft) !== state.baseline);

function syncDraft(pricing) {
  const source = pricing || defaultPricing();
  const next = {
    discountEnabled: source.discountEnabled !== false,
    discountStart: source.discountStart || '00:30',
    discountEnd: source.discountEnd || '08:30',
    deepseekChat: { ...defaultPricing().deepseekChat, ...(source.deepseekChat || {}) },
    deepseekReasoner: { ...defaultPricing().deepseekReasoner, ...(source.deepseekReasoner || {}) },
    customModels: Array.isArray(source.customModels) ? source.customModels.map(item => ({ ...item })) : []
  };
  state.draft = next;
  state.baseline = JSON.stringify(next);
}

async function load(force = false) {
  if (!c.state.authenticated || state.loading) return;
  if (filters.range === 'custom' && (!filters.start || !filters.end)) { state.error = '请选择自定义时间的开始和结束日期'; return; }
  state.loading = true;
  state.error = '';
  try {
    const data = await c.api(`token-usage?${filterQuery()}`);
    state.data = data;
    if (!dirty.value || force) syncDraft(data.pricing);
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
  }
}

async function syncPrices() {
  if (busy.value) return;
  state.syncing = true;
  state.error = '';
  try {
    const synced = await c.api('token-usage/prices/sync', { method: 'POST', body: '{}' });
    await load();
    const failures = Object.values(synced.catalog.sources).filter(source => source.error).length;
    c.notify(failures ? `${failures} 个来源未更新，已保留上次价格` : '官方价格已同步，手动单价保持不变', Boolean(failures));
    void c.refresh();
  } catch (error) { state.error = error.message; }
  finally { state.syncing = false; }
}

function checkedAt(value) {
  if (!value) return '尚未同步';
  if (value.length === 10) return `${value} 官方核验快照`;
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

async function savePricing() {
  if (state.saving) return;
  state.saving = true;
  state.error = '';
  try {
    const data = await c.api('token-usage/pricing', { method: 'PUT', body: JSON.stringify(state.draft) });
    syncDraft(data.pricing);
    await load();
    c.notify('计费规则已保存，估算费用已更新；官方历史账单保持不变');
    void c.refresh();
  } catch (error) {
    state.error = error.message;
    c.notify(error.message, true);
  } finally {
    state.saving = false;
  }
}

function restoreDefaultPricing() {
  state.draft = defaultPricing();
}

function addCustomModel() {
  const model = state.newCustom.model.trim();
  if (!model) { c.notify('请填写模型 ID，例如 gpt-6-astra 或 claude-opus-5-5', true); return; }
  if (state.draft.customModels.some(item => item.provider === state.newCustom.provider && item.model.toLowerCase() === model.toLowerCase())) {
    c.notify(`已存在模型 ${model} 的计费规则`, true);
    return;
  }
  state.draft.customModels.push({
    provider: state.newCustom.provider,
    model,
    discountEnabled: Boolean(state.newCustom.discountEnabled),
    inputPrice: Number(state.newCustom.inputPrice) || 0,
    cachedInputPrice: Number(state.newCustom.cachedInputPrice) || 0,
    outputPrice: Number(state.newCustom.outputPrice) || 0,
    discountInputPrice: Number(state.newCustom.discountInputPrice) || 0,
    discountCachedInputPrice: Number(state.newCustom.discountCachedInputPrice) || 0,
    discountOutputPrice: Number(state.newCustom.discountOutputPrice) || 0
  });
  state.newCustom.model = '';
}

function removeCustomModel(index) {
  state.draft.customModels.splice(index, 1);
}

async function clearUsage() {
  if (!await c.askConfirmation({
    title: '清空 Token 用量与账单记录？',
    description: '将清空所有已持久化的分模型 Token 统计、按日账单和最近调用明细。',
    detail: '当前保存的计费时段与模型单价设置会保留。此操作不可撤销。',
    confirmText: '确认清空',
    tone: 'danger'
  })) return;
  state.clearing = true;
  try {
    await c.api('token-usage/clear', { method: 'POST', body: JSON.stringify({}) });
    await load();
    c.notify('Token 累计用量与账单已清空');
    void c.refresh();
  } catch (error) {
    c.notify(error.message, true);
  } finally {
    state.clearing = false;
  }
}

function formatMainMoney(value, currency = 'CNY') {
  const symbol = currency === 'USD' ? 'US$' : '¥';
  const num = Math.max(0, Number(value) || 0);
  if (num === 0) return `${symbol}0.00`;
  if (num < 0.01) return `${symbol}${num.toFixed(4)}`;
  const floored = Math.floor((num + 1e-9) * 100) / 100;
  return `${symbol}${floored.toFixed(2)}`;
}

function formatMoney(value, currency = 'CNY') {
  const symbol = currency === 'USD' ? 'US$' : '¥';
  const num = Number(value) || 0;
  if (num === 0) return `${symbol}0.0000`;
  return num < 0.01 ? `${symbol}${num.toFixed(6)}` : `${symbol}${num.toFixed(4)}`;
}

const totals = computed(() => state.data?.totals || {
  calls: 0, toolCalls: 0, toolCost: 0, modelCost: 0,
  promptTokens: 0, cachedTokens: 0, uncachedPromptTokens: 0, completionTokens: 0, reasoningTokens: 0,
  totalTokens: 0, unknownBreakdownTokens: 0, unpricedTokens: 0,
  standardCalls: 0, discountCalls: 0, standardTokens: 0, discountTokens: 0,
  cost: 0, costUSD: 0, standardCost: 0, discountCost: 0, savedCost: 0,
  todayTokens: 0, todayCost: 0, todayCostUSD: 0, todayCalls: 0
});

const pricedTokens = computed(() => Math.max(0, Number(totals.value.totalTokens || 0) - Number(totals.value.unknownBreakdownTokens || 0)));
const historyOnlyCalls = computed(() => Math.max(0, Number(totals.value.calls || 0) - Number(totals.value.standardCalls || 0) - Number(totals.value.discountCalls || 0)));

const cacheHitRate = computed(() => {
  if (!totals.value.promptTokens) return '0.0%';
  return `${((totals.value.cachedTokens / totals.value.promptTokens) * 100).toFixed(1)}%`;
});

onMounted(() => { void load(); });
watch(() => c.state.authenticated, auth => { if (auth) void load(); });
</script>

<template>
  <div class="token-usage-workspace">
    <template v-if="!pricingOnly">
    <!-- 顶部横幅 -->
    <div class="card panel period-banner">
      <div>
        <span class="period-pill" :class="{ discount: state.data?.officialImport || state.data?.currentPeriod?.period === 'discount' }">
          <span class="dot" />
          {{ state.data?.officialImport ? '历史按官方账单 · 新增按峰谷计费' : (state.data?.currentPeriod?.label || '正在读取计费状态…') }}
        </span>
        <h2>Token 用量与账单</h2>
        <p class="muted">
          DeepSeek 新调用按北京时间工作日 09:00–12:00、14:00–18:00 高峰计费；其余时间及已收录节假日享谷时价。历史导出按实际费用保留，工具成功调用另计。
        </p>
      </div>
      <div class="banner-actions">
        <span v-if="state.data?.currentPeriod?.beijingTime" class="clock-tag">北京时间 {{ state.data.currentPeriod.beijingTime }}</span>
        <button type="button" class="secondary" :disabled="busy" @click="syncPrices">
          <WorkspaceIcon name="refresh" />{{ state.syncing ? '同步单价中…' : '同步官方单价' }}
        </button>
        <button type="button" class="secondary" :disabled="busy" @click="load()">
          <WorkspaceIcon name="refresh" />{{ state.loading ? '刷新中…' : '刷新账单' }}
        </button>
      </div>
    </div>

    <p v-if="state.data?.currentPeriod?.calendarKnown === false" class="error-text">当年节假日日历尚未收录，暂按周一至周五时段估算，请以官方账单为准。</p>
    <p v-if="state.error" class="error-text" role="status">{{ state.error }}</p>

    <section class="card panel usage-filters" aria-label="账单筛选">
      <ThemedDateRangePicker
        v-model:preset="filters.range"
        v-model:start="filters.start"
        v-model:end="filters.end"
        label="时间维度"
        :disabled="busy"
      >
        <label class="usage-filter-field">模型 / 费用类别
          <select v-model="filters.model" :disabled="busy">
            <option value="">全部模型与工具</option>
            <option v-for="item in state.data?.modelOptions || []" :key="item.key" :value="item.key">{{ providerNames[item.provider] || item.provider }} / {{ item.model }}</option>
            <option value="__tools__">仅 DeepSeek 联网工具</option>
          </select>
        </label>
        <label class="usage-filter-field">排序方式
          <select v-model="filters.sort" :disabled="busy">
            <option value="time-desc">时间：从新到旧</option><option value="time-asc">时间：从旧到新</option>
            <option value="cost-desc">费用：从高到低</option><option value="cost-asc">费用：从低到高</option>
            <option value="tokens-desc">Token：从多到少</option><option value="tokens-asc">Token：从少到多</option>
            <option value="calls-desc">模型请求：从多到少</option><option value="calls-asc">模型请求：从少到多</option>
          </select>
        </label>
        <div class="filter-actions"><button type="button" :disabled="busy" @click="load()">应用筛选</button><button type="button" class="secondary" :disabled="busy" @click="resetFilters">重置</button></div>
      </ThemedDateRangePicker>
      <p class="muted" role="status">当前统计：{{ appliedScope }}</p>
      <small class="muted">日期筛选只统计保留的按日记录；缺少日期的旧累计数据仅在“全部时间”中显示。</small>
      <small class="muted">汇总卡片、模型账单和每日明细同步筛选。单模型不含无法归属的联网工具费用；费用排序中，模型按币种分组，每日先按人民币、同额再按美元排序，不做汇率换算。模型时间排序按最近使用日期，工具单列于表尾。</small>
    </section>

    <!-- 4 个核心指标卡 -->
    <div class="stats-grid usage-stats-grid">
      <article class="card stat highlight-stat">
        <span>可计价部分 · 人民币 <b><WorkspaceIcon name="usage" /></b></span>
        <strong class="stat-main-row">
          {{ formatMainMoney(totals.cost) }}
          <em class="exact-pill">明细 {{ formatMoney(totals.cost) }}</em>
        </strong>
        <small>
          模型 {{ formatMoney(totals.modelCost ?? totals.cost) }}<template v-if="totals.toolCost"> + 联网工具 {{ formatMoney(totals.toolCost) }}</template>
        </small>
        <small>
          历史模型账单 {{ formatMoney(totals.officialBilledCost) }} · 新增高峰 {{ formatMoney(totals.standardCost) }} · 空闲优惠 {{ formatMoney(totals.discountCost) }}<template v-if="totals.savedCost > 0">（已省 {{ formatMoney(totals.savedCost) }}）</template>
        </small>
        <small v-if="totals.costUSD">美元另计 {{ formatMoney(totals.costUSD, 'USD') }} · 今日 {{ formatMoney(totals.todayCostUSD, 'USD') }}</small>
      </article>

      <article class="card stat">
        <span>筛选范围 Tokens <b><WorkspaceIcon name="model" /></b></span>
        <strong class="stat-main-row">
          {{ Number(totals.totalTokens || 0).toLocaleString() }}
          <em v-if="totals.todayTokens" class="exact-pill">今日 +{{ Number(totals.todayTokens).toLocaleString() }}</em>
        </strong>
        <small>已计价明细 {{ pricedTokens.toLocaleString() }}（入 {{ Number(totals.promptTokens || 0).toLocaleString() }} / 出 {{ Number(totals.completionTokens || 0).toLocaleString() }}）</small>
        <small v-if="totals.unknownBreakdownTokens">历史仅总数 {{ Number(totals.unknownBreakdownTokens).toLocaleString() }} Tokens（无输入/输出拆分，不估价）</small>
        <small v-else>所有已记录 Token 均包含完整输入与输出明细</small>
      </article>

      <article class="card stat">
        <span>请求与联网工具 <b><WorkspaceIcon name="check" /></b></span>
        <strong class="stat-main-row">
          {{ Number(totals.calls || 0).toLocaleString() }} 次
          <em v-if="totals.toolCalls" class="exact-pill">+ 工具 {{ Number(totals.toolCalls).toLocaleString() }} 次</em>
        </strong>
        <small>
          高峰 {{ Number(totals.standardCalls || 0).toLocaleString() }} 次 · 空闲优惠 {{ Number(totals.discountCalls || 0).toLocaleString() }} 次<template v-if="historyOnlyCalls > 0"> · 未拆分时段 {{ historyOnlyCalls }} 次</template>
        </small>
        <small v-if="totals.toolCalls">DeepSeek 联网搜索与抓取 {{ Number(totals.toolCalls).toLocaleString() }} 次（{{ formatMoney(totals.toolCost) }}）</small>
        <small v-else>今日调用 {{ Number(totals.todayCalls || 0).toLocaleString() }} 次 · 今日 {{ formatMoney(totals.todayCost) }}</small>
      </article>

      <article class="card stat">
        <span>缓存命中与错峰节省 <b><WorkspaceIcon name="live" /></b></span>
        <strong class="stat-main-row">
          {{ cacheHitRate }}
          <em v-if="totals.savedCost > 0" class="exact-pill saved-pill">已省 {{ formatMainMoney(totals.savedCost) }}</em>
        </strong>
        <small>缓存命中 {{ Number(totals.cachedTokens || 0).toLocaleString() }} · 未命中 {{ Number(totals.uncachedPromptTokens || 0).toLocaleString() }}</small>
        <small>新调用谷时累计节省 {{ formatMoney(totals.savedCost) }} · 今日费用 {{ formatMoney(totals.todayCost) }}</small>
      </article>
    </div>

    <!-- 子视图切换栏 -->
    <div class="usage-subnav">
      <div class="sub-tabs" role="tablist" aria-label="用量与计费视图">
        <button type="button" :class="{ active: activeTab === 'models' }" @click="activeTab = 'models'">
          分模型与工具账单
          <span class="tab-count">{{ (state.data?.byModel?.length || 0) + (totals.toolCalls ? 1 : 0) }}</span>
        </button>
        <button type="button" :class="{ active: activeTab === 'days' }" @click="activeTab = 'days'">
          按日消耗明细
          <span class="tab-count">{{ state.data?.byDay?.length || 0 }}</span>
        </button>
        <button type="button" :class="{ active: activeTab === 'pricing' }" @click="activeTab = 'pricing'">
          官方价目表与计费设置
          <span v-if="dirty" class="tab-dot" />
        </button>
      </div>
      <button v-if="state.data?.byModel?.length" type="button" class="text-button danger-text" :disabled="busy" @click="clearUsage">
        {{ state.clearing ? '清空中…' : '清空统计记录' }}
      </button>
    </div>

    <!-- Tab 1: 分模型与工具账单 -->
    <article v-if="activeTab === 'models'" class="card panel">
      <div class="panel-heading">
        <div>
          <h2>分模型与工具账单汇总</h2>
          <p class="muted">已计价模型按高峰／空闲分时单价与缓存命中核算；仅有历史总数的旧记录单独标记，不混入虚高估价。</p>
        </div>
      </div>

      <div v-if="state.data?.byModel?.length || totals.toolCalls" class="table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>服务商 / 模型</th>
              <th>调用次数</th>
              <th>输入 Tokens（命中 / 未命中）</th>
              <th>输出 Tokens</th>
              <th>总 Tokens（高峰 / 空闲）</th>
              <th>计费单价（每百万 Tokens）</th>
              <th>范围内费用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in state.data.byModel" :key="row.key" :class="{ 'row-unpriced': row.unknownBreakdownTokens === row.totalTokens }">
              <td>
                <div class="model-cell">
                  <span class="provider-badge" :class="row.provider">{{ providerNames[row.provider] || row.provider }}</span>
                  <strong>{{ row.model }}</strong>
                </div>
                <small v-if="row.profileName" class="muted">配置名称：{{ row.profileName }}</small>
                <small v-if="row.lastUsedAt" class="muted">最近记录：{{ new Date(row.lastUsedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) }}</small>
              </td>
              <td class="num-cell">
                <strong>{{ row.calls.toLocaleString() }} 次</strong>
                <small v-if="row.standardCalls || row.discountCalls" class="muted">
                  高峰 {{ row.standardCalls }} · 空闲 {{ row.discountCalls }}<template v-if="row.calls > row.standardCalls + row.discountCalls"> · 历史 {{ row.calls - row.standardCalls - row.discountCalls }}</template>
                </small>
                <small v-else class="muted">历史补录 {{ row.calls }} 次</small>
              </td>
              <td class="num-cell">
                <template v-if="row.promptTokens || row.completionTokens">
                  <strong>{{ row.promptTokens.toLocaleString() }}</strong>
                  <small class="muted">命中 {{ row.cachedTokens.toLocaleString() }} · 未命中 {{ row.uncachedPromptTokens.toLocaleString() }}</small>
                </template>
                <template v-else>
                  <span class="muted">—</span>
                  <small class="muted">无输入拆分明细</small>
                </template>
              </td>
              <td class="num-cell">
                <template v-if="row.promptTokens || row.completionTokens">
                  <strong>{{ row.completionTokens.toLocaleString() }}</strong>
                  <small class="muted">{{ row.reasoningTokens ? `含思考 ${row.reasoningTokens.toLocaleString()}` : '标准输出' }}</small>
                </template>
                <template v-else>
                  <span class="muted">—</span>
                  <small class="muted">无输出拆分明细</small>
                </template>
              </td>
              <td class="num-cell">
                <strong>{{ row.totalTokens.toLocaleString() }}</strong>
                <small v-if="row.standardTokens || row.discountTokens" class="muted">
                  高峰 {{ row.standardTokens.toLocaleString() }} · 空闲 {{ row.discountTokens.toLocaleString() }}
                </small>
                <small v-else class="muted">仅保留总 Token 数</small>
              </td>
              <td class="num-cell">
                <template v-if="row.rate.source !== 'unpriced'">
                  <span>{{ row.rate.currency === 'USD' ? 'US$' : '¥' }} 入 {{ row.rate.inputPrice }}（缓 {{ row.rate.cachedInputPrice }}）/ 出 {{ row.rate.outputPrice }}</span>
                  <small v-if="row.rate.discountEligible || row.rate.offPeak" class="discount-note">
                    空闲 5 折：入 {{ row.rate.discountInputPrice }}（缓 {{ row.rate.discountCachedInputPrice }}）/ 出 {{ row.rate.discountOutputPrice }}
                  </small>
                  <small v-else class="muted">{{ row.rate.tier }}</small>
                </template>
                <template v-else>
                  <span class="muted">未配置单价</span>
                  <small class="muted">可在「计费设置」添加</small>
                </template>
              </td>
              <td class="num-cell cost-cell">
                <template v-if="row.unknownBreakdownTokens === row.totalTokens">
                  <span class="pending-badge">历史仅总数</span>
                  <small class="muted">缺少输入/输出明细</small>
                </template>
                <template v-else-if="row.rate.source === 'unpriced'">
                  <span class="pending-badge">待设单价</span>
                  <small class="muted">未计入费用</small>
                </template>
                <template v-else>
                  <strong>{{ formatMoney(row.cost, row.rate.currency) }}</strong>
                  <small v-if="row.savedCost > 0" class="saved-note">错峰已省 {{ formatMoney(row.savedCost) }}</small>
                  <small v-if="row.unknownBreakdownTokens" class="muted">另 {{ row.unknownBreakdownTokens.toLocaleString() }} 仅总数未计</small>
                </template>
              </td>
            </tr>

            <!-- DeepSeek 联网搜索与网页抓取工具账单行 -->
            <tr v-if="totals.toolCalls" class="tool-billing-row">
              <td>
                <div class="model-cell">
                  <span class="provider-badge deepseek">DeepSeek</span>
                  <strong>联网搜索与网页抓取</strong>
                </div>
                <small class="muted">官方内置工具（tool-search / tool-fetch）</small>
              </td>
              <td class="num-cell">
                <strong>{{ totals.toolCalls.toLocaleString() }} 次</strong>
                <small class="muted">按调用次数计费</small>
              </td>
              <td class="num-cell"><span class="muted">—</span><small class="muted">不占输入 Token</small></td>
              <td class="num-cell"><span class="muted">—</span><small class="muted">不占输出 Token</small></td>
              <td class="num-cell"><span class="muted">—</span><small class="muted">独立于模型 Token</small></td>
              <td class="num-cell">
                <span>¥0.005 / 次（¥5 / 千次）</span>
                <small class="muted">DeepSeek 官方工具单价</small>
              </td>
              <td class="num-cell cost-cell">
                <strong>{{ formatMoney(totals.toolCost) }}</strong>
                <small class="muted">已计入人民币总账单</small>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="summary-foot-row">
              <td><strong>可计价账单合计</strong></td>
              <td class="num-cell">
                <strong>{{ totals.calls.toLocaleString() }} 次请求</strong>
                <small v-if="totals.toolCalls" class="muted">+ {{ totals.toolCalls.toLocaleString() }} 次联网工具</small>
              </td>
              <td class="num-cell"><strong>{{ totals.promptTokens.toLocaleString() }}</strong></td>
              <td class="num-cell"><strong>{{ totals.completionTokens.toLocaleString() }}</strong></td>
              <td class="num-cell">
                <strong>{{ totals.totalTokens.toLocaleString() }}</strong>
                <small class="muted">已计价 {{ pricedTokens.toLocaleString() }}</small>
              </td>
              <td class="num-cell">
                <span v-if="totals.savedCost > 0" class="saved-note">空闲错峰共省 {{ formatMoney(totals.savedCost) }}</span>
              </td>
              <td class="num-cell cost-cell">
                <strong>{{ formatMainMoney(totals.cost) }}</strong>
                <small class="muted">明细 {{ formatMoney(totals.cost) }}</small>
                <small v-if="totals.costUSD" class="muted">另 {{ formatMoney(totals.costUSD, 'USD') }}</small>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div v-else class="empty">
        当前筛选范围没有账单记录<br>
        <small>在群聊 @、授权私聊提问或测试模型后，将自动按模型与北京时间时段记录用量与费用。</small>
      </div>

      <!-- 底部紧凑数据口径说明条 -->
      <div class="scope-strip">
        <div v-if="state.data?.officialImport" class="scope-item">
          <span class="scope-tag ok">官方账单已校准（完整导入范围）</span>
          <p>
            已导入 <b>{{ state.data.officialImport.start.slice(0, 10) }}</b> 至 <b>{{ state.data.officialImport.end.slice(0, 10) }} 00:00</b> 的 DeepSeek 官方账单
            （{{ Number(state.data.officialImport.tokens).toLocaleString() }} Tokens · {{ state.data.officialImport.calls }} 次模型请求 · {{ state.data.officialImport.toolCalls }} 次工具调用，导出费用 <b>¥{{ Number(state.data.officialImport.actualCost).toFixed(4) }}</b>），后续新增调用按峰谷规则实时估算；历史导出未覆盖且旧版未记录的工具调用，需要新的官方账单补齐。
          </p>
        </div>
        <div v-if="totals.unknownBreakdownTokens" class="scope-item">
          <span class="scope-tag neutral">历史仅总数说明</span>
          <p>
            早期聊天记录补录中有 <b>{{ Number(totals.unknownBreakdownTokens).toLocaleString() }}</b> Tokens（如早期切换测试的 OpenAI / Kimi / Claude 记录）仅保存了总 Token 数而无输入与输出拆分，表格中标为「历史仅总数」，不混入人民币账单估算。
          </p>
        </div>
      </div>
    </article>

    <!-- Tab 2: 按日消耗明细 -->
    <article v-if="activeTab === 'days'" class="card panel">
      <div class="panel-heading">
        <div>
          <h2>按日账单明细（北京时间）</h2>
          <p class="muted">按日汇总模型 Token 消耗、高峰／空闲时段分布与联网工具调用费用，展示筛选范围内所有有记录的日期。</p>
        </div>
      </div>
      <div v-if="state.data?.byDay?.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>请求与工具</th>
              <th>总 Tokens</th>
              <th>输入 / 缓存命中 / 输出</th>
              <th>高峰 / 空闲时段</th>
              <th>当日模型与工具明细</th>
              <th>当日费用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="day in state.data.byDay" :key="day.day">
              <td><strong>{{ day.day }}</strong></td>
              <td class="num-cell">
                <strong>{{ day.calls.toLocaleString() }} 次</strong>
                <small v-if="day.toolCalls" class="muted">工具 {{ day.toolCalls }} 次</small>
              </td>
              <td class="num-cell"><strong>{{ day.totalTokens.toLocaleString() }}</strong></td>
              <td class="num-cell">
                {{ day.promptTokens.toLocaleString() }} / {{ day.cachedTokens.toLocaleString() }} / {{ day.completionTokens.toLocaleString() }}
              </td>
              <td class="num-cell">
                高峰 {{ day.standardTokens.toLocaleString() }} · 空闲 {{ day.discountTokens.toLocaleString() }}
              </td>
              <td>
                <div class="day-models">
                  <span v-for="m in day.models" :key="m.key" class="day-model-chip">
                    <b>{{ m.model }}</b> {{ m.totalTokens.toLocaleString() }} ({{ m.unpriced || m.unknownBreakdownTokens === m.totalTokens ? '历史仅总数' : formatMoney(m.cost, m.currency) }})
                  </span>
                  <span v-if="day.toolCalls" class="day-model-chip tool-chip">
                    <b>联网搜索/抓取</b> {{ day.toolCalls }} 次 ({{ formatMoney(day.toolCost) }})
                  </span>
                </div>
              </td>
              <td class="num-cell cost-cell">
                <strong>{{ day.unknownBreakdownTokens === day.totalTokens && !day.toolCost ? '历史仅总数' : formatMoney(day.cost) }}</strong>
                <small v-if="day.costUSD">{{ formatMoney(day.costUSD, 'USD') }}</small>
                <small v-if="day.savedCost > 0" class="saved-note">省 {{ formatMoney(day.savedCost) }}</small>
                <small v-if="day.unknownBreakdownTokens" class="muted">{{ day.unknownBreakdownTokens.toLocaleString() }} 仅总数未计</small>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty">当前筛选范围没有按日统计记录</div>
    </article>

    </template>
    <p v-if="pricingOnly && state.error" class="error-text">{{ state.error }}</p>
    <!-- Tab 3: 官方价目表与计费设置 -->
    <div v-if="activeTab === 'pricing'" class="pricing-tab-stack">
      <article class="card panel">
        <div class="panel-heading">
          <div>
            <h2>官方模型参考价目表</h2>
            <p class="muted">单位：每百万 Tokens · 手动自定义单价优先于官方参考价。点击同步会实时请求官方公开文档，不消耗模型额度。</p>
          </div>
          <button type="button" class="secondary" :disabled="busy" @click="syncPrices">
            <WorkspaceIcon name="refresh" />{{ state.syncing ? '同步官方价格中…' : '同步最新价格' }}
          </button>
        </div>
        <div class="table-wrap">
          <table class="official-price-table">
            <thead>
              <tr>
                <th>服务商 / 模型</th>
                <th>计费币种</th>
                <th>标准输入</th>
                <th>缓存命中</th>
                <th>标准输出</th>
                <th>分时优惠与补充规则</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in state.data?.catalog?.models || []" :key="row.model">
                <td>
                  <span class="provider-badge" :class="row.provider">{{ providerNames[row.provider] || row.provider }}</span>
                  <strong class="price-model">{{ row.model }}</strong>
                  <a class="price-model" :href="row.sourceUrl" target="_blank" rel="noopener noreferrer">官方定价文档 ↗</a>
                  <small class="price-model muted">{{ checkedAt(state.data.catalog.sources[row.sourceId]?.updatedAt) }}</small>
                  <small v-if="state.data.catalog.sources[row.sourceId]?.error" class="price-model error-text">{{ state.data.catalog.sources[row.sourceId].error }}</small>
                </td>
                <td>{{ row.currency === 'USD' ? '美元 USD' : '人民币 CNY' }}</td>
                <td>{{ row.inputPrice }}</td>
                <td>{{ row.cachedInputPrice }}</td>
                <td>{{ row.outputPrice }}</td>
                <td class="price-extras">
                  <span v-if="row.offPeak" class="discount-note">空闲时段 5 折：输入 {{ row.offPeak.inputPrice }} / 缓存 {{ row.offPeak.cachedInputPrice }} / 输出 {{ row.offPeak.outputPrice }}</span>
                  <span v-if="row.cacheWritePrice !== undefined">缓存写入 {{ row.cacheWritePrice }}<template v-if="row.cacheWriteHourPrice !== undefined">（5 分钟）/ {{ row.cacheWriteHourPrice }}（1 小时）</template></span>
                  <small class="muted">{{ row.note }}</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <form class="card panel form-panel" @submit.prevent="savePricing">
        <div class="panel-heading">
          <div>
            <h2>自定义模型单价与计费规则</h2>
            <p class="muted">为未收录模型或中转渠道设置单价（元 / 百万 Tokens），支持模型前缀匹配，保存后立即重算账单。</p>
          </div>
          <button type="button" class="text-button" @click="restoreDefaultPricing">恢复默认规则</button>
        </div>

        <section class="rate-box custom-rate-box">
          <div class="panel-heading">
            <div>
              <h3>自定义模型单价覆盖（支持前缀匹配）</h3>
              <small class="muted">适用于自建渠道、特定模型覆盖或未在上方官方表列出的模型。</small>
            </div>
          </div>
          <div v-if="state.draft.customModels.length" class="custom-model-list">
            <div v-for="(item, index) in state.draft.customModels" :key="`${item.provider}:${item.model}`" class="custom-rate-row">
              <div class="custom-rate-head">
                <span class="provider-badge" :class="item.provider">{{ providerNames[item.provider] || item.provider }}</span>
                <strong>{{ item.model }}</strong>
                <label class="inline-check">
                  <input v-model="item.discountEnabled" type="checkbox">参与分时优惠
                </label>
                <button type="button" class="text-button danger-text" @click="removeCustomModel(index)">删除</button>
              </div>
              <div class="field-grid three-cols">
                <label>标准输入<input v-model.number="item.inputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                <label>标准缓存命中<input v-model.number="item.cachedInputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                <label>标准输出<input v-model.number="item.outputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                <template v-if="item.discountEnabled">
                  <label>优惠输入<input v-model.number="item.discountInputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                  <label>优惠缓存命中<input v-model.number="item.discountCachedInputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                  <label>优惠输出<input v-model.number="item.discountOutputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                </template>
              </div>
            </div>
          </div>

          <div class="add-custom-rate">
            <div class="field-grid four-cols">
              <label>服务商<select v-model="state.newCustom.provider"><option value="openai">OpenAI</option><option value="kimi">Kimi</option><option value="deepseek">DeepSeek</option><option value="any">通用匹配</option></select></label>
              <label>模型 ID（支持前缀）<input v-model="state.newCustom.model" placeholder="如 gpt-6-astra 或 claude-opus"></label>
              <label>输入单价（元/M）<input v-model.number="state.newCustom.inputPrice" type="number" step="0.01" min="0" max="100000"></label>
              <label>输出单价（元/M）<input v-model.number="state.newCustom.outputPrice" type="number" step="0.01" min="0" max="100000"></label>
            </div>
            <div class="add-custom-actions">
              <label class="inline-check"><input v-model="state.newCustom.discountEnabled" type="checkbox">启用优惠时段单价</label>
              <button type="button" class="secondary" @click="addCustomModel">+ 添加模型单价规则</button>
            </div>
          </div>
        </section>

        <details class="legacy-rules-disclosure">
          <summary>旧版 DeepSeek 模型（deepseek-chat / deepseek-reasoner）与自定义分时窗口设置</summary>
          <div class="legacy-rules-body">
            <label class="capability-toggle">
              <input v-model="state.draft.discountEnabled" type="checkbox">
              <span>
                启用自定义北京时间分时优惠窗口
                <small>用于旧版 deepseek-chat / deepseek-reasoner 及勾选「参与分时优惠」的自定义模型。</small>
              </span>
            </label>

            <div v-if="state.draft.discountEnabled" class="field-grid time-window-grid">
              <label>
                优惠时段开始（北京时间）
                <input v-model="state.draft.discountStart" type="time" required>
              </label>
              <label>
                优惠时段结束（北京时间）
                <input v-model="state.draft.discountEnd" type="time" required>
              </label>
            </div>

            <div class="rate-sections">
              <section class="rate-box">
                <h3>旧版 deepseek-chat</h3>
                <div class="field-grid three-cols">
                  <label>标准 · 输入（未命中）<input v-model.number="state.draft.deepseekChat.inputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                  <label>标准 · 输入（缓存命中）<input v-model.number="state.draft.deepseekChat.cachedInputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                  <label>标准 · 输出<input v-model.number="state.draft.deepseekChat.outputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                  <label>优惠 · 输入（未命中）<input v-model.number="state.draft.deepseekChat.discountInputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                  <label>优惠 · 输入（缓存命中）<input v-model.number="state.draft.deepseekChat.discountCachedInputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                  <label>优惠 · 输出<input v-model.number="state.draft.deepseekChat.discountOutputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                </div>
              </section>

              <section class="rate-box">
                <h3>旧版 deepseek-reasoner</h3>
                <div class="field-grid three-cols">
                  <label>标准 · 输入（未命中）<input v-model.number="state.draft.deepseekReasoner.inputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                  <label>标准 · 输入（缓存命中）<input v-model.number="state.draft.deepseekReasoner.cachedInputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                  <label>标准 · 输出（含思考）<input v-model.number="state.draft.deepseekReasoner.outputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                  <label>优惠 · 输入（未命中）<input v-model.number="state.draft.deepseekReasoner.discountInputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                  <label>优惠 · 输入（缓存命中）<input v-model.number="state.draft.deepseekReasoner.discountCachedInputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                  <label>优惠 · 输出（含思考）<input v-model.number="state.draft.deepseekReasoner.discountOutputPrice" type="number" step="0.01" min="0" max="100000" required></label>
                </div>
              </section>
            </div>
          </div>
        </details>

        <div class="save-bar">
          <span class="muted">
            <b v-if="dirty" class="draft-marker">计费规则有未保存修改</b>
            <template v-else>计费规则已保存</template>
          </span>
          <div>
            <button type="submit" class="primary" :disabled="busy || !dirty">
              {{ state.saving ? '保存中…' : '保存计费规则 ↗' }}
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.usage-filters { display: grid; gap: 12px; overflow: visible; }
.filter-fields { display: flex; align-items: end; flex-wrap: wrap; gap: 14px; }
.filter-fields label, .usage-filter-field { display: grid; gap: 7px; flex: 1 1 180px; min-width: 0; font-size: 13px; }
.filter-fields select, .filter-fields input, .usage-filter-field select { width: 100%; min-width: 0; }
.filter-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.usage-filters p { margin: 0; }

.token-usage-workspace { display: flex; flex-direction: column; gap: 20px; }
.period-banner { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; flex-wrap: wrap; }
.period-banner h2 { margin: 10px 0 6px; font-size: 20px; }
.period-pill { display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #edf2fb; color: #36588a; }
.period-pill.discount { background: #e7f6ed; color: #206b42; }
.period-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.banner-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.clock-tag { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 4px; }

.usage-stats-grid { margin: 0; }
.usage-stats-grid small { display: block; line-height: 1.65; margin-top: 2px; }
.highlight-stat { border-color: rgba(32, 107, 66, 0.28); background: linear-gradient(180deg, #f9fdfb 0%, #ffffff 100%); }
.stat-main-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.exact-pill { font-style: normal; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: #eef3fb; color: #36588a; font-variant-numeric: tabular-nums; }
.exact-pill.saved-pill { background: #e7f6ed; color: #206b42; }

.usage-subnav { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.tab-count { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 18px; padding: 0 6px; margin-left: 6px; border-radius: 999px; font-size: 11px; background: rgba(0, 0, 0, 0.06); }
.tab-dot { display: inline-block; width: 7px; height: 7px; margin-left: 6px; border-radius: 50%; background: var(--green); }

.model-cell { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.provider-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 10px; font-weight: 600; background: #eef2f9; color: #3d5a8a; }
.provider-badge.openai { background: #ebf5f0; color: #24684b; }
.provider-badge.kimi { background: #f3eefb; color: #5b3e96; }
.provider-badge.unknown { background: #f2f4f7; color: #475467; }

.num-cell { font-variant-numeric: tabular-nums; }
.num-cell strong { display: block; font-size: 13px; }
.num-cell small { display: block; margin-top: 4px; font-size: 11px; }
.discount-note, .saved-note { color: #206b42; font-weight: 500; }
.cost-cell strong { color: var(--green); font-size: 14px; }
.pending-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; background: #f2f4f7; color: #475467; }
.row-unpriced { opacity: 0.82; }
.tool-billing-row { background: #fafcff; }
.summary-foot-row td { border-top: 2px solid var(--line); background: #f9fbf9; padding-top: 14px; padding-bottom: 14px; }

.scope-strip { display: flex; flex-direction: column; gap: 10px; margin-top: 18px; padding: 14px 16px; border-radius: 12px; background: #f8fafc; border: 1px solid var(--line); }
.scope-item { display: flex; align-items: flex-start; gap: 10px; font-size: 12px; line-height: 1.65; color: var(--muted); }
.scope-item p { margin: 0; }
.scope-item b { color: var(--text); }
.scope-tag { flex-shrink: 0; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
.scope-tag.ok { background: #e7f6ed; color: #206b42; }
.scope-tag.neutral { background: #eef2f9; color: #36588a; }

.day-models { display: flex; flex-wrap: wrap; gap: 6px; }
.day-model-chip { padding: 3px 8px; border-radius: 6px; border: 1px solid var(--line); background: #fafbfe; font-size: 11px; }
.day-model-chip.tool-chip { background: #f2f7ff; border-color: #d4e2fa; color: #2b4c7e; }

.pricing-tab-stack { display: flex; flex-direction: column; gap: 20px; }
.price-model { display: block; margin-top: 6px; overflow-wrap: anywhere; }
.price-extras { min-width: 230px; max-width: 400px; white-space: normal; }
.price-extras span, .price-extras small { display: block; margin-top: 4px; }
.official-price-table { table-layout: fixed; min-width: 720px; white-space: normal; }
.official-price-table th, .official-price-table td { padding: 16px 12px; vertical-align: top; }
.official-price-table th:first-child { width: 24%; }
.official-price-table th:nth-child(2) { width: 12%; }
.official-price-table th:nth-child(3), .official-price-table th:nth-child(4), .official-price-table th:nth-child(5) { width: 9%; }
.official-price-table .price-extras { min-width: 0; }

.rate-box { padding: 20px; border: 1px solid var(--line); border-radius: 14px; background: #fbfcff; }
.rate-box h3 { margin: 0 0 14px; font-size: 15px; }
.custom-rate-box { margin-top: 4px; }
.three-cols { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.four-cols { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.custom-model-list { display: flex; flex-direction: column; gap: 14px; margin: 14px 0; }
.custom-rate-row { padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: white; }
.custom-rate-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.inline-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; margin-left: auto; }
.inline-check input { width: 15px; height: 15px; margin: 0; }
.add-custom-rate { margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--line); }
.add-custom-actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }

.legacy-rules-disclosure { margin-top: 18px; border: 1px solid var(--line); border-radius: 14px; background: #fafbfc; padding: 14px 18px; }
.legacy-rules-disclosure summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--muted); user-select: none; }
.legacy-rules-body { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
.time-window-grid { margin-top: 16px; max-width: 480px; }
.rate-sections { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 18px; margin-top: 18px; }
.danger-text { color: #b42318; }
</style>

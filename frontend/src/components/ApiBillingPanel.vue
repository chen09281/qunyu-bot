<script setup>
import { computed, inject, onMounted, reactive, ref } from 'vue';
import { consoleKey } from '../composables/useConsole';
import ThemedDateRangePicker from './ThemedDateRangePicker.vue';
import UsageScopesPanel from './UsageScopesPanel.vue';
import TokenUsagePanel from './TokenUsagePanel.vue';

const c = inject(consoleKey);
const data = ref({ rows: [], days: [], models: [], modelDays: [] });
const busy = ref(false);
const error = ref('');

const names = {
  deepseek: 'DeepSeek API',
  openai: 'OpenAI API',
  kimi: 'Kimi API',
  anthropic: 'Anthropic API',
  unknown: '其他 API'
};

const filters = reactive({ provider: '', preset: 'all', start: '', end: '', sort: 'cost-desc' });
const todayBeijing = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const draft = reactive({
  provider: 'deepseek',
  currency: 'CNY',
  label: '',
  cost: '',
  tokens: '',
  requests: '',
  asOf: todayBeijing()
});
const editing = ref(false);
const dated = computed(() => filters.preset !== 'all' || !!(filters.start || filters.end));

function resetFilters() {
  Object.assign(filters, { provider: '', preset: 'all', start: '', end: '', sort: 'cost-desc' });
}

const days = computed(() =>
  (data.value.days || []).filter(
    r =>
      (!filters.provider || r.provider === filters.provider) &&
      (!filters.start || r.day >= filters.start) &&
      (!filters.end || r.day <= filters.end)
  )
);

const filteredModelDays = computed(() =>
  (data.value.modelDays || []).filter(
    r =>
      (!filters.provider || r.provider === filters.provider) &&
      (!filters.start || r.day >= filters.start) &&
      (!filters.end || r.day <= filters.end)
  )
);

const rows = computed(() => {
  const result = (data.value.rows || [])
    .filter(r => !filters.provider || r.provider === filters.provider)
    .map(r => {
      if (!dated.value) return r;
      const added = days.value
        .filter(d => d.provider === r.provider)
        .reduce(
          (s, d) => ({
            cost: s.cost + (d.cost || 0),
            tokens: s.tokens + (d.tokens || 0),
            promptTokens: s.promptTokens + (d.promptTokens || 0),
            completionTokens: s.completionTokens + (d.completionTokens || 0),
            requests: s.requests + (d.requests || 0)
          }),
          { cost: 0, tokens: 0, promptTokens: 0, completionTokens: 0, requests: 0 }
        );
      return { ...r, ...added };
    });
  const [field, order] = filters.sort.split('-');
  return result.sort((a, b) => (order === 'asc' ? 1 : -1) * ((a[field] || 0) - (b[field] || 0)));
});

const modelRows = computed(() => {
  let list = [];
  if (!dated.value) {
    list = (data.value.models || []).filter(m => !filters.provider || m.provider === filters.provider);
  } else {
    const grouped = new Map();
    for (const item of filteredModelDays.value) {
      const key = `${item.provider}:${item.model}`;
      const prev = grouped.get(key) || {
        provider: item.provider,
        model: item.model,
        isTool: item.isTool,
        cost: 0,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        requests: 0
      };
      prev.cost += item.cost || 0;
      prev.tokens += item.tokens || 0;
      prev.promptTokens += item.promptTokens || 0;
      prev.completionTokens += item.completionTokens || 0;
      prev.requests += item.requests || 0;
      grouped.set(key, prev);
    }
    list = [...grouped.values()];
  }
  const [field, order] = filters.sort.split('-');
  return [...list].sort((a, b) => (order === 'asc' ? 1 : -1) * ((a[field] || 0) - (b[field] || 0)));
});

const activeList = computed(() => (filters.provider ? modelRows.value : rows.value));

const totalCost = computed(() => rows.value.reduce((sum, r) => sum + (Number(r.cost) || 0), 0));
const totalTokens = computed(() => rows.value.reduce((sum, r) => sum + (Number(r.tokens) || 0), 0));
const totalPromptTokens = computed(() => rows.value.reduce((sum, r) => sum + (Number(r.promptTokens) || 0), 0));
const totalCompletionTokens = computed(() => rows.value.reduce((sum, r) => sum + (Number(r.completionTokens) || 0), 0));
const totalRequests = computed(() => rows.value.reduce((sum, r) => sum + (Number(r.requests) || 0), 0));

const money = value => `¥${Number(value || 0).toFixed(2)}`;

const usageSubtext = computed(() => {
  if (filters.provider) {
    if (!modelRows.value.length) return '当前渠道暂无模型调用记录';
    return modelRows.value.map(m => `${m.model} ${money(m.cost)}`).join(' · ');
  }
  if (!rows.value.length) return '暂无消费记录';
  return `共 ${totalRequests.value.toLocaleString()} 次调用 · ` + rows.value.map(r => `${names[r.provider] || r.provider} ${money(r.cost)}`).join(' · ');
});

const tokenSubtext = computed(() => {
  if (filters.provider) {
    const modelsOnly = modelRows.value.filter(m => !m.isTool);
    if (!modelsOnly.length) return '当前渠道累计消耗 Token';
    return modelsOnly.map(m => `${m.model} ${m.tokens.toLocaleString()}`).join(' · ');
  }
  return `累计 ${totalRequests.value.toLocaleString()} 次 API 请求消耗`;
});

async function load() {
  busy.value = true;
  error.value = '';
  try {
    data.value = await c.api('api-billing');
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function calibrate() {
  if (
    !(await c.askConfirmation({
      title: '更新官方网页账单基准？',
      description: '保存后，该 API 渠道总额将以填写的数据为基准，并自动累加以后的新增消耗。',
      detail: '不会删除原始调用记录；此前估算不会重复叠加。请确认网页选择了用于机器人的 API Key。',
      confirmText: '保存基准'
    }))
  )
    return;
  busy.value = true;
  error.value = '';
  try {
    data.value = await c.api('api-billing/calibrate', {
      method: 'POST',
      body: JSON.stringify({ ...draft, currency: 'CNY' })
    });
    editing.value = false;
    c.notify('账单基准已更新');
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="billing-workspace">
    <section class="card panel billing-filter-panel">
      <div class="panel-heading">
        <div>
          <h2>API 用量与账单</h2>
          <p class="muted">默认按 API 渠道汇总总使用量与 Token；切换「API 渠道」即可查看该渠道下单个模型的消费明细。</p>
        </div>
        <button type="button" class="secondary" :disabled="busy" @click="load">刷新账单</button>
      </div>

      <ThemedDateRangePicker
        v-model:preset="filters.preset"
        v-model:start="filters.start"
        v-model:end="filters.end"
        label="时间维度"
      >
        <label class="billing-filter-field">
          API 渠道
          <select v-model="filters.provider">
            <option value="">全部 API</option>
            <option v-for="(name, key) in names" :key="key" :value="key">{{ name }}</option>
          </select>
        </label>
        <label class="billing-filter-field">
          排序
          <select v-model="filters.sort">
            <option value="cost-desc">费用从高到低</option>
            <option value="cost-asc">费用从低到高</option>
            <option value="tokens-desc">Token 从多到少</option>
            <option value="requests-desc">请求从多到少</option>
          </select>
        </label>
        <button type="button" class="secondary" @click="resetFilters">重置</button>
      </ThemedDateRangePicker>
    </section>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="filters.start && filters.end && filters.start > filters.end" class="error-text">
      开始日期不能晚于结束日期
    </p>

    <!-- 3 个简洁核心卡片：总使用量（切换渠道时为单个模型消费） / 消耗 Token / 输入与输出 -->
    <div class="billing-stats">
      <article class="card panel stat-panel highlight-stat-panel">
        <span>{{ filters.provider ? `${names[filters.provider] || filters.provider} · 单个模型消费` : '总使用量' }}</span>
        <strong>{{ money(totalCost) }}</strong>
        <small>{{ usageSubtext }}</small>
      </article>
      <article class="card panel stat-panel">
        <span>消耗 Token</span>
        <strong>{{ totalTokens.toLocaleString() }}</strong>
        <small>{{ tokenSubtext }}</small>
      </article>
      <article class="card panel stat-panel">
        <span>输入与输出</span>
        <strong class="io-strong">{{ totalPromptTokens.toLocaleString() }} <em class="io-slash">/</em> {{ totalCompletionTokens.toLocaleString() }}</strong>
        <small>输入 {{ totalPromptTokens.toLocaleString() }} · 输出 {{ totalCompletionTokens.toLocaleString() }} Tokens</small>
      </article>
    </div>

    <section class="card panel billing-filter-panel">
      <div class="panel-heading">
        <div>
          <h2>{{ filters.provider ? `${names[filters.provider] || filters.provider} · 单个模型消费` : 'API 渠道消费' }}</h2>
        </div>
        <div class="heading-actions">
          <button v-if="filters.provider" type="button" class="secondary" @click="filters.provider = ''">
            查看全部 API
          </button>
          <button type="button" class="secondary" :disabled="busy" @click="editing = !editing">
            {{ editing ? '收起同步面板' : '同步官方账单金额' }}
          </button>
        </div>
      </div>

      <form v-if="editing" class="billing-calibration" @submit.prevent="calibrate">
        <p class="muted">
          填写官方用量页面选定 API Key 后显示的消费金额（¥）、Tokens 和 API 请求次数。
        </p>
        <div class="calibration-grid">
          <label class="billing-filter-field">
            API 渠道
            <select v-model="draft.provider">
              <option v-for="(name, key) in names" :key="key" :value="key">{{ name }}</option>
            </select>
          </label>
          <label class="billing-filter-field">
            账单名称
            <input v-model="draft.label" placeholder="例如 qqbot" maxlength="80" />
          </label>
          <label class="billing-filter-field">
            官方消费金额（¥）
            <input v-model="draft.cost" type="number" min="0" step="0.00000001" placeholder="例如 4.40" required />
          </label>
          <label class="billing-filter-field">
            官方 Tokens
            <input v-model="draft.tokens" type="number" min="0" step="1" placeholder="例如 1621478" required />
          </label>
          <label class="billing-filter-field">
            官方 API 请求次数
            <input v-model="draft.requests" type="number" min="0" step="1" placeholder="例如 549" required />
          </label>
          <ThemedDateRangePicker
            v-model="draft.asOf"
            mode="single"
            label="官方数据统计截止（00:00 北京）"
          />
        </div>

        <div class="calibration-footer">
          <small class="muted">
            官方网页一般统计到当天 00:00；截止日及之后本机已记录的调用会自动计入，不会漏算或重复。
          </small>
          <button type="submit" class="primary" :disabled="busy">保存</button>
        </div>
      </form>

      <!-- 当选择「全部 API」时：展示各 API 渠道消费 -->
      <div v-if="!filters.provider" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>API 渠道</th>
              <th>总使用量</th>
              <th>消耗 Token</th>
              <th>输入 Token</th>
              <th>输出 Token</th>
              <th>调用次数</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.provider"
              class="clickable-row"
              title="点击查看该渠道下单个模型的消费"
              @click="filters.provider = row.provider"
            >
              <td>
                <b>{{ names[row.provider] || row.provider }}</b>
                <small>{{ row.label && row.label !== row.provider ? row.label : '点击查看单个模型消费 →' }}</small>
              </td>
              <td><b>{{ money(row.cost) }}</b></td>
              <td>{{ row.tokens.toLocaleString() }}</td>
              <td>{{ (row.promptTokens || 0).toLocaleString() }}</td>
              <td>{{ (row.completionTokens || 0).toLocaleString() }}</td>
              <td>{{ row.requests.toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 当切换了某个具体「API 渠道」时：展示该渠道下单个模型的消费 -->
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>模型</th>
              <th>单个模型消费</th>
              <th>消耗 Token</th>
              <th>输入 Token</th>
              <th>输出 Token</th>
              <th>调用次数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in modelRows" :key="`${m.provider}:${m.model}`">
              <td>
                <b>{{ m.model }}</b>
                <small>{{ m.isTool ? 'DeepSeek 联网搜索与网页抓取工具' : (names[m.provider] || m.provider) }}</small>
              </td>
              <td><b>{{ money(m.cost) }}</b></td>
              <td>{{ m.isTool ? '—' : m.tokens.toLocaleString() }}</td>
              <td>{{ m.isTool ? '—' : (m.promptTokens || 0).toLocaleString() }}</td>
              <td>{{ m.isTool ? '—' : (m.completionTokens || 0).toLocaleString() }}</td>
              <td>{{ m.requests.toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="!activeList.length" class="muted">当前筛选范围内暂无消费记录。</p>
    </section>

    <section class="card panel">
      <div class="panel-heading">
        <h2>每日消耗明细</h2>
      </div>
      <div v-if="days.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期（北京）</th>
              <th>API 渠道</th>
              <th>消耗 Token</th>
              <th>输入 / 输出 Token</th>
              <th>调用次数</th>
              <th>当日使用量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="day in days" :key="day.provider + day.day">
              <td>{{ day.day }}</td>
              <td>{{ names[day.provider] || day.provider }}</td>
              <td>{{ day.tokens.toLocaleString() }}</td>
              <td>{{ (day.promptTokens || 0).toLocaleString() }} / {{ (day.completionTokens || 0).toLocaleString() }}</td>
              <td>{{ day.requests.toLocaleString() }}</td>
              <td><b>{{ money(day.cost) }}</b></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted">当前时间范围内暂无按日记录。</p>
    </section>

    <UsageScopesPanel />

    <details class="card panel">
      <summary>后续估算的单价与高级设置</summary>
      <TokenUsagePanel pricing-only />
    </details>
  </div>
</template>

<style scoped>
.billing-workspace {
  display: grid;
  gap: 20px;
}

.billing-filter-panel {
  overflow: visible;
}

.heading-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.billing-filter-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 200px;
  min-width: 0;
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  font-weight: 500;
  color: #425675;
}

.billing-filter-field input,
.billing-filter-field select {
  width: 100%;
  min-width: 0;
  height: 42px;
  min-height: 42px;
  margin: 0;
  padding: 0 36px 0 14px;
  box-sizing: border-box;
  font-size: 13px;
}

.billing-filter-field input {
  padding: 0 14px;
}

.billing-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.stat-panel {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.stat-panel > span {
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
}

.stat-panel strong {
  display: block;
  font-size: 30px;
  font-weight: 650;
  color: #354e7b;
  margin: 14px 0 10px;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
}

.stat-panel strong.io-strong {
  font-size: 24px;
}

.io-slash {
  font-style: normal;
  font-weight: 400;
  color: #95a3bd;
  margin: 0 3px;
}

.highlight-stat-panel {
  background: linear-gradient(135deg, #f3f6ff 0%, #f8f5fc 100%);
  border-color: #d6e0f5;
}

.clickable-row {
  cursor: pointer;
  transition: background-color 0.14s;
}

.clickable-row:hover td {
  background-color: #f6f8fe;
}

small {
  display: block;
  color: var(--muted);
  margin-top: 4px;
  line-height: 1.6;
}

.billing-calibration {
  display: grid;
  gap: 16px;
  padding: 18px 0 22px;
  margin-bottom: 18px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

.billing-calibration > p {
  margin: 0;
  font-size: 13px;
}

.calibration-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
  align-items: flex-end;
}

.calibration-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

@media (max-width: 800px) {
  .billing-stats {
    grid-template-columns: 1fr;
  }
}
</style>

<script setup>
import { computed, inject, onMounted, reactive, watch } from 'vue';
import { consoleKey } from '../composables/useConsole';
import { games } from '../../../src/subscriptions/games.mjs';
import WorkspaceIcon from './WorkspaceIcon.vue';

const c = inject(consoleKey);
const kindLabels = { activity: '版本活动', banner: '卡池／唤取', livestream: '前瞻直播', version: '版本更新' };

const state = reactive({
  tab: 'codes',
  gameFilter: 'all',
  syncing: false,
  previewLoading: false,
  previewData: null,
  codeEditId: '',
  codeDraft: { game: 'wuwa', code: '', reward: '', expiresAt: '', note: '', enabled: true },
  activityEditId: '',
  activityDraft: { game: 'wuwa', title: '', kind: 'activity', startAt: '', endAt: '', summary: '', link: '' }
});

const calendar = computed(() => c.state.gameCalendar || {
  settings: { enabled: true, renderCard: true, autoSync: true, enabledGames: games.map(g => g.id) },
  codes: [],
  activities: [],
  lastSyncAt: null,
  lastSyncError: ''
});

const settings = computed(() => c.state.gameCalendarSettings || calendar.value.settings);

const filteredCodes = computed(() => (calendar.value.codes || []).filter(item =>
  state.gameFilter === 'all' || item.game === state.gameFilter
));

const filteredActivities = computed(() => (calendar.value.activities || []).filter(item =>
  state.gameFilter === 'all' || item.game === state.gameFilter
));

function toggleGame(gameId) {
  const list = [...(settings.value.enabledGames || [])];
  const idx = list.indexOf(gameId);
  if (idx >= 0) {
    if (list.length <= 1) { c.notify('请至少保留一款启用的游戏', true); return; }
    list.splice(idx, 1);
  } else {
    list.push(gameId);
  }
  settings.value.enabledGames = list;
}

function resetCodeForm() {
  state.codeEditId = '';
  state.codeDraft = { game: state.gameFilter === 'all' ? 'wuwa' : state.gameFilter, code: '', reward: '', expiresAt: '', note: '', enabled: true };
}

function editCode(item) {
  state.codeEditId = item.id;
  state.codeDraft = {
    game: item.game,
    code: item.code,
    reward: item.reward || '',
    expiresAt: item.expiresAt || '',
    note: item.note || '',
    enabled: item.enabled !== false
  };
}

async function submitCode() {
  await c.saveGameRedeemCode({ ...state.codeDraft }, state.codeEditId);
  resetCodeForm();
}

function resetActivityForm() {
  state.activityEditId = '';
  state.activityDraft = { game: state.gameFilter === 'all' ? 'wuwa' : state.gameFilter, title: '', kind: 'activity', startAt: '', endAt: '', summary: '', link: '' };
}

function editActivity(item) {
  state.activityEditId = item.id;
  state.activityDraft = {
    game: item.game,
    title: item.title || '',
    kind: item.kind || 'activity',
    startAt: item.startAt || '',
    endAt: item.endAt || '',
    summary: item.summary || '',
    link: item.link || ''
  };
}

async function submitActivity() {
  await c.saveGameActivity({ ...state.activityDraft }, state.activityEditId);
  resetActivityForm();
}

async function triggerSync() {
  if (state.syncing) return;
  state.syncing = true;
  try {
    await c.syncGameCalendar(state.gameFilter === 'all' ? '' : state.gameFilter);
  } finally {
    state.syncing = false;
  }
}

async function openPreview(mode) {
  state.previewLoading = true;
  state.previewData = { mode, loading: true, title: mode === 'codes' ? '游戏兑换码速查' : '游戏活动与卡池日历' };
  try {
    const data = await c.api('game-calendar/preview', {
      method: 'POST',
      body: JSON.stringify({ mode, game: state.gameFilter === 'all' ? '' : state.gameFilter })
    });
    state.previewData = { ...data, loading: false };
  } catch (error) {
    state.previewData = null;
    c.notify(error.message, true);
  } finally {
    state.previewLoading = false;
  }
}

onMounted(() => { void c.loadGameCalendar(); });
watch(() => c.state.authenticated, auth => { if (auth) void c.loadGameCalendar(); });
</script>

<template>
  <div class="game-calendar-workspace">
    <article class="card panel form-panel">
      <div class="panel-heading">
        <div>
          <h2>插件开关与展示设置</h2>
          <p class="muted">群成员在已授权群或白名单私聊发送 <code>/兑换码</code>、<code>/日历</code> 或 <code>/活动</code> 即可获取高清卡片。</p>
        </div>
        <div class="header-actions">
          <button type="button" class="secondary" :disabled="state.syncing" @click="triggerSync">
            <WorkspaceIcon name="refresh" />{{ state.syncing ? '正在同步官网…' : '同步官方最新活动' }}
          </button>
          <button type="button" class="secondary" :disabled="state.previewLoading" @click="openPreview('codes')">预览兑换码卡</button>
          <button type="button" class="secondary" :disabled="state.previewLoading" @click="openPreview('calendar')">预览日历卡</button>
        </div>
      </div>

      <div class="settings-grid">
        <label class="capability-toggle">
          <input v-model="settings.enabled" type="checkbox">
          <span>
            启用游戏兑换码与活动日历插件
            <small>关闭后不再响应群内或私聊的 /兑换码、/日历、/活动 指令。</small>
          </span>
        </label>
        <label class="capability-toggle">
          <input v-model="settings.renderCard" type="checkbox">
          <span>
            优先生成高清图文卡片
            <small>使用本地 Pillow 合成二次元配色信息卡；若环境缺少 Pillow 自动回退为纯文本消息。</small>
          </span>
        </label>
      </div>

      <div class="enabled-games-box">
        <span class="field-label">汇总卡片默认展示的游戏（发送无参数 <code>/兑换码</code> 或 <code>/日历</code> 时包含）：</span>
        <div class="game-chips">
          <button
            v-for="game in games"
            :key="game.id"
            type="button"
            class="game-chip"
            :class="{ active: (settings.enabledGames || []).includes(game.id) }"
            @click="toggleGame(game.id)"
          >
            <span class="game-dot" :style="{ background: game.color }" />
            {{ game.name }}
          </button>
        </div>
      </div>

      <div class="callout command-callout">
        <b>群聊与私聊使用指令</b>
        <p>
          • <code>/兑换码</code> 或 <code>/礼包码</code>：查看全部启用游戏的有效兑换码与剩余时间卡片<br>
          • <code>/兑换码 鸣潮</code> / <code>/兑换码 zzz</code> / <code>/兑换码 方舟</code>：按游戏单独查询兑换码<br>
          • <code>/日历</code> 或 <code>/活动</code> 或 <code>/卡池</code>：查看当前版本活动、卡池与前瞻倒计时卡片<br>
          • <code>/日历 终末地</code> / <code>/活动 绝区零</code>：按游戏单独查询活动日历
        </p>
      </div>

      <div class="save-bar">
        <span class="muted">
          <template v-if="calendar.lastSyncAt">最近官方同步：{{ new Date(calendar.lastSyncAt).toLocaleString('zh-CN', { hour12: false }) }}</template>
          <template v-else>可点击上方「同步官方最新活动」拉取国服官网最新公告</template>
          <span v-if="calendar.lastSyncError" class="error-inline"> · {{ calendar.lastSyncError }}</span>
        </span>
        <button type="button" class="primary" :disabled="c.state.busy.gameCalendar" @click="c.saveGameCalendarSettings(false)">
          {{ c.state.busy.gameCalendar ? '保存中…' : '保存插件设置 ↗' }}
        </button>
      </div>
    </article>

    <article v-if="state.previewData" class="card panel preview-panel">
      <div class="panel-heading">
        <div>
          <h2>{{ state.previewData.title }} · 预览</h2>
          <p class="muted">仅在后台渲染预览，不会向 QQ 群发送消息。</p>
        </div>
        <button type="button" class="text-button" @click="state.previewData = null">关闭预览 ✕</button>
      </div>
      <div v-if="state.previewData.loading" class="empty">正在渲染高清卡片…</div>
      <div v-else class="preview-body">
        <p v-if="state.previewData.warning" class="error-text">{{ state.previewData.warning }}</p>
        <img v-if="state.previewData.card" :src="state.previewData.card" :alt="state.previewData.title" class="preview-image">
        <pre class="preview-text">{{ state.previewData.text }}</pre>
      </div>
    </article>

    <div class="sub-navigation">
      <div class="section-tabs" role="tablist">
        <button type="button" :aria-pressed="state.tab === 'codes'" @click="state.tab = 'codes'">
          兑换码管理（{{ (calendar.codes || []).length }}）
        </button>
        <button type="button" :aria-pressed="state.tab === 'activities'" @click="state.tab = 'activities'">
          活动与卡池日历（{{ (calendar.activities || []).length }}）
        </button>
      </div>
      <label class="filter-label">
        筛选游戏
        <select v-model="state.gameFilter">
          <option value="all">全部游戏</option>
          <option v-for="game in games" :key="game.id" :value="game.id">{{ game.name }}</option>
        </select>
      </label>
    </div>

    <div v-show="state.tab === 'codes'" class="two-columns">
      <form class="card panel form-panel" @submit.prevent="submitCode">
        <div class="panel-heading">
          <h2>{{ state.codeEditId ? '编辑兑换码' : '添加兑换码' }}</h2>
          <button v-if="state.codeEditId" type="button" class="text-button" @click="resetCodeForm">取消编辑</button>
        </div>
        <div class="field-grid">
          <label>
            所属游戏
            <select v-model="state.codeDraft.game" required>
              <option v-for="game in games" :key="game.id" :value="game.id">{{ game.name }}</option>
            </select>
          </label>
          <label>
            兑换码（自动转大写）
            <input v-model="state.codeDraft.code" required maxlength="32" placeholder="如 MINGCHAO 或前瞻兑换码">
          </label>
        </div>
        <label>
          奖励内容说明
          <input v-model="state.codeDraft.reward" required maxlength="160" placeholder="如 星声×100、贝币×30000 或 菲林×300">
        </label>
        <div class="field-grid">
          <label>
            截止时间（北京时间，留空为长期有效）
            <input v-model="state.codeDraft.expiresAt" maxlength="25" placeholder="YYYY-MM-DD HH:MM，如 2026-11-15 23:59">
          </label>
          <label>
            备注／来源
            <input v-model="state.codeDraft.note" maxlength="100" placeholder="如 2.1版本前瞻直播兑换码">
          </label>
        </div>
        <label class="capability-toggle">
          <input v-model="state.codeDraft.enabled" type="checkbox">
          <span>启用此兑换码（停用或已过期的兑换码不会展示在群聊卡片中）</span>
        </label>
        <div class="form-actions">
          <button type="submit" class="primary" :disabled="c.state.busy.gameCalendarCode">
            {{ state.codeEditId ? '保存修改' : '+ 添加兑换码' }}
          </button>
        </div>
      </form>

      <article class="card panel">
        <div class="panel-heading">
          <h2>兑换码列表</h2>
          <span class="subtle-tag">共 {{ filteredCodes.length }} 条</span>
        </div>
        <div v-if="filteredCodes.length" class="item-list">
          <div v-for="item in filteredCodes" :key="item.id" class="calendar-item" :class="{ muted: item.expired || !item.enabled }">
            <div class="item-main">
              <div class="item-head">
                <span class="game-tag">{{ item.gameName }}</span>
                <code class="code-pill">{{ item.code }}</code>
                <span class="status-pill" :class="item.status">{{ item.statusLabel }}</span>
              </div>
              <p class="item-desc">{{ item.reward }}</p>
              <small class="muted">
                {{ item.expiresAt ? `截止：${item.expiresAt}` : '长期有效' }}
                <template v-if="item.note"> · {{ item.note }}</template>
              </small>
            </div>
            <div class="item-actions">
              <button type="button" class="text-button" @click="editCode(item)">编辑</button>
              <button type="button" class="text-button danger-text" @click="c.removeGameRedeemCode(item.id)">删除</button>
            </div>
          </div>
        </div>
        <div v-else class="empty">当前筛选下暂无兑换码</div>
      </article>
    </div>

    <div v-show="state.tab === 'activities'" class="two-columns">
      <form class="card panel form-panel" @submit.prevent="submitActivity">
        <div class="panel-heading">
          <h2>{{ state.activityEditId ? '编辑活动日程' : '添加活动／卡池日程' }}</h2>
          <button v-if="state.activityEditId" type="button" class="text-button" @click="resetActivityForm">取消编辑</button>
        </div>
        <div class="field-grid">
          <label>
            所属游戏
            <select v-model="state.activityDraft.game" required>
              <option v-for="game in games" :key="game.id" :value="game.id">{{ game.name }}</option>
            </select>
          </label>
          <label>
            日程类型
            <select v-model="state.activityDraft.kind">
              <option v-for="(label, key) in kindLabels" :key="key" :value="key">{{ label }}</option>
            </select>
          </label>
        </div>
        <label>
          活动或卡池名称
          <input v-model="state.activityDraft.title" required maxlength="160" placeholder="如 「长航的星辉」限时角色唤取">
        </label>
        <div class="field-grid">
          <label>
            开始时间（北京时间，可选）
            <input v-model="state.activityDraft.startAt" maxlength="25" placeholder="YYYY-MM-DD HH:MM">
          </label>
          <label>
            结束时间（北京时间，用于计算倒计时）
            <input v-model="state.activityDraft.endAt" maxlength="25" placeholder="YYYY-MM-DD HH:MM，如 2026-11-20 03:59">
          </label>
        </div>
        <label>
          活动摘要或奖励说明
          <textarea v-model="state.activityDraft.summary" rows="3" maxlength="300" placeholder="简要说明活动奖励或注意事项" />
        </label>
        <div class="form-actions">
          <button type="submit" class="primary" :disabled="c.state.busy.gameCalendarActivity">
            {{ state.activityEditId ? '保存修改' : '+ 添加活动日程' }}
          </button>
        </div>
      </form>

      <article class="card panel">
        <div class="panel-heading">
          <h2>活动与卡池列表</h2>
          <span class="subtle-tag">共 {{ filteredActivities.length }} 项</span>
        </div>
        <div v-if="filteredActivities.length" class="item-list">
          <div v-for="item in filteredActivities" :key="item.id" class="calendar-item" :class="{ muted: item.expired }">
            <div class="item-main">
              <div class="item-head">
                <span class="game-tag">{{ item.gameName }}</span>
                <span class="kind-tag">{{ item.kindLabel }}</span>
                <span class="status-pill" :class="item.status">{{ item.statusLabel }}</span>
              </div>
              <p class="item-title">{{ item.title }}</p>
              <p v-if="item.summary" class="item-desc">{{ item.summary }}</p>
              <small class="muted">
                <template v-if="item.startAt || item.endAt">
                  {{ item.startAt || '已开启' }}{{ item.endAt ? ` ~ ${item.endAt}` : '' }}
                </template>
                <template v-if="item.source === 'official'"> · 官网自动同步</template>
              </small>
            </div>
            <div class="item-actions">
              <button type="button" class="text-button" @click="editActivity(item)">编辑</button>
              <button type="button" class="text-button danger-text" @click="c.removeGameActivity(item.id)">删除</button>
            </div>
          </div>
        </div>
        <div v-else class="empty">当前筛选下暂无活动日程</div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.game-calendar-workspace { display: flex; flex-direction: column; gap: 24px; }
.header-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; margin-top: 8px; }
.enabled-games-box { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--line); }
.field-label { display: block; font-size: 12px; font-weight: 550; margin-bottom: 12px; }
.game-chips { display: flex; flex-wrap: wrap; gap: 10px; }
.game-chip { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border: 1px solid var(--line); border-radius: 999px; background: white; font-size: 12px; cursor: pointer; transition: all .15s; }
.game-chip.active { border-color: var(--green); background: var(--soft); font-weight: 600; color: var(--green); }
.game-dot { width: 9px; height: 9px; border-radius: 50%; }
.command-callout { margin-top: 20px; }
.sub-navigation { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.item-list { display: flex; flex-direction: column; gap: 12px; max-height: 620px; overflow-y: auto; }
.calendar-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: #fbfcff; }
.calendar-item.muted { opacity: 0.62; }
.item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.game-tag { padding: 2px 8px; border-radius: 6px; background: #eef2f9; color: #36588a; font-size: 11px; font-weight: 600; }
.kind-tag { padding: 2px 8px; border-radius: 6px; background: #f2f4f7; color: #475467; font-size: 11px; }
.code-pill { padding: 3px 10px; border-radius: 6px; background: #1e2532; color: #fff; font-size: 13px; font-weight: 600; letter-spacing: 0.5px; }
.status-pill { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #eaf5ee; color: #206b42; }
.status-pill.ending { background: #fdf1ec; color: #b84a27; }
.status-pill.upcoming { background: #edf2fb; color: #3b5e9c; }
.status-pill.expired, .status-pill.disabled { background: #f0f2f6; color: #6e7887; }
.item-title { margin: 4px 0; font-size: 14px; font-weight: 600; }
.item-desc { margin: 4px 0; font-size: 12px; color: var(--ink); line-height: 1.6; }
.item-actions { display: flex; gap: 8px; flex-shrink: 0; }
.preview-body { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; align-items: start; }
.preview-image { width: 100%; max-width: 520px; border-radius: 14px; border: 1px solid var(--line); }
.preview-text { margin: 0; padding: 16px; border-radius: 12px; background: #f7f9fc; border: 1px solid var(--line); font-size: 12px; line-height: 1.7; white-space: pre-wrap; }
.error-inline { color: #b42318; }
.danger-text { color: #b42318; }
</style>

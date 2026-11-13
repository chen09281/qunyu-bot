<script setup>
import { computed, inject, onMounted } from 'vue';
import { consoleKey } from '../composables/useConsole';
import WorkspaceIcon from './WorkspaceIcon.vue';

const c = inject(consoleKey);

const settings = computed(() => c.state.healthPlannerSettings || c.state.healthPlanner?.settings || {
  enabled: true,
  renderCard: true,
  aiMenuEnhance: true,
  aiFoodVision: true,
  pushSlots: {
    morningOverview: '07:30',
    breakfast: '',
    lunch: '11:30',
    dinner: '17:30'
  }
});

const stats = computed(() => c.state.healthPlanner?.stats || {
  userCount: 0,
  appleBoundCount: 0,
  pushEnabledCount: 0,
  mealsLoggedToday: 0,
  pushesToday: 0,
  pendingAppleItems: 0
});

const bridgeBase = computed(() => {
  const configured = String(c.state.config?.consolePublicUrl || '').trim().replace(/\/+$/, '');
  return configured || (typeof location !== 'undefined' ? location.origin : '');
});

const toggleItems = [
  { key: 'enabled', title: '启用健康饮食管家', desc: '关闭后暂停响应 /健康、/饮食、/吃什么、/记一餐 与定时推送；保留历史档案。' },
  { key: 'renderCard', title: '发送高清早中晚食谱卡片', desc: '需要浏览器 Chromium 组件；开启后发送可视化三餐对比图片，不可用时自动退回纯文字。' },
  { key: 'aiFoodVision', title: '启用拍照/文字记一餐识别', desc: '发送食物照片配 /记一餐，调用识图模型估算大卡与蛋白质并推入 Apple 健康同步队列。' },
  { key: 'aiMenuEnhance', title: '启用 AI 搭配贴士润色', desc: '在确定性的食物克重结果基础上，补充 1–2 句贴合忌口偏好的实操小贴士。' }
];

const slotItems = [
  { key: 'morningOverview', label: '每日早报总览（全天早中晚方案）', placeholder: '07:30' },
  { key: 'breakfast', label: '早餐单独提醒（可选，默认并入早报）', placeholder: '留空不单推' },
  { key: 'lunch', label: '午餐动态提醒（饭前重算剩余量）', placeholder: '11:30' },
  { key: 'dinner', label: '晚餐动态提醒（饭前重算剩余量）', placeholder: '17:30' }
];

onMounted(() => {
  void c.loadHealthPlanner();
});
</script>

<template>
  <div class="hp-workspace">
    <article class="card panel">
      <div class="panel-heading">
        <div>
          <h2>运行概览（已脱敏）</h2>
          <p class="muted">个人体重、饮食记录与同步凭据均经 AES-256-GCM 加密，后台仅显示汇总数量。</p>
        </div>
        <button type="button" class="secondary" :disabled="c.state.busy.healthPlannerStatus" @click="c.loadHealthPlanner">
          <WorkspaceIcon name="refresh" />
          刷新状态
        </button>
      </div>
      <div class="stats-grid">
        <div class="stat-box"><span>已建档用户</span><b>{{ stats.userCount }}</b></div>
        <div class="stat-box"><span>已对接 Apple 健康</span><b>{{ stats.appleBoundCount }}</b></div>
        <div class="stat-box"><span>已开启定时推送</span><b>{{ stats.pushEnabledCount }}</b></div>
        <div class="stat-box"><span>今日已记餐次</span><b>{{ stats.mealsLoggedToday }}</b></div>
        <div class="stat-box"><span>今日已触发推送</span><b>{{ stats.pushesToday }}</b></div>
        <div class="stat-box"><span>待写回 Apple 队列</span><b>{{ stats.pendingAppleItems }}</b></div>
      </div>
    </article>

    <article class="card panel">
      <div class="panel-heading">
        <div>
          <h2>功能开关与早/中/晚推送时段</h2>
          <p class="muted">全部时间均按北京时间（UTC+8）触发；某时段留空即可跳过该时段推送。</p>
        </div>
        <button type="button" class="primary" :disabled="!c.state.healthPlanner || c.state.busy.healthPlannerSettings" @click="c.saveHealthPlannerSettings(false)">
          <WorkspaceIcon name="check" />
          {{ c.state.busy.healthPlannerSettings ? '保存中…' : '保存设置' }}
        </button>
      </div>

      <p v-if="c.state.healthPlannerError" class="error-inline">{{ c.state.healthPlannerError }}</p>

      <div class="toggle-grid">
        <label v-for="item in toggleItems" :key="item.key" class="toggle-item">
          <div class="toggle-copy">
            <b>{{ item.title }}</b>
            <small>{{ item.desc }}</small>
          </div>
          <input v-model="settings[item.key]" type="checkbox" :disabled="item.key !== 'enabled' && !settings.enabled" />
        </label>
      </div>

      <div class="slot-grid">
        <label v-for="slot in slotItems" :key="slot.key" class="slot-item">
          <span>{{ slot.label }}</span>
          <input v-model="settings.pushSlots[slot.key]" type="text" :placeholder="slot.placeholder" :disabled="!settings.enabled" />
        </label>
      </div>
    </article>

    <article class="card panel">
      <div class="panel-heading">
        <div>
          <h2>Apple 健康双向桥接与 QQ 指令</h2>
          <p class="muted">由于 Apple 健康数据加密存放在 iPhone 本地，用户可通过「苹果快捷指令」定时同步。</p>
        </div>
      </div>

      <div class="callout command-callout">
        <b>QQ 内常用指令速查（支持 / 与 # 前缀）</b>
        <p><code>/健康 录入 男 26岁 175cm 72kg 减脂 中度</code> —— 录入身体数据并生成早/中/晚三餐克重</p>
        <p><code>/健康 方案</code> · <code>/吃什么 早|中|晚</code> —— 查看当日或单餐具体食物量</p>
        <p><code>/记一餐 [早|中|晚] [菜品描述]</code>（支持同时附带食物图片）—— 自动估算热量与蛋白并重算余量</p>
        <p><code>/健康 今日</code> · <code>/健康 撤销</code> · <code>/健康 忌口 海鲜 牛奶</code> · <code>/健康 比例 30 40 30</code> · <code>/健康 推送 全部|早报|分餐|关闭</code></p>
        <p>私聊发送 <code>/健康 同步</code> —— 直接通过 QQ 发送 3 个 iPhone 快捷指令文件，并下发服务器地址与个人 Bearer Token（<code>/健康 快捷指令</code> 也可在群聊或私聊单独领取文件，无需任何 macOS 应用）。</p>
      </div>

      <div class="callout bridge-callout">
        <b>iPhone 快捷指令（Shortcuts）QQ 直发与网页备用安装</b>
        <p>推荐直接在 QQ 发送 <code>/健康 同步</code>（私聊）或 <code>/健康 快捷指令</code>，由机器人直接发送 3 个已签名 <code>.shortcut</code> 文件；网页备用下载页：<a :href="`${bridgeBase}/tools/health/`" target="_blank" rel="noreferrer"><code>{{ bridgeBase }}/tools/health/</code></a></p>
        <p>1. 上传 Apple 健康步数 / 活动消耗 / 体重（用于动态修正每日 TDEE）：<code>POST {{ bridgeBase }}/bridge/health/sync</code></p>
        <p>2. 拉取 QQ 记一餐待写入营养队列：<code>GET {{ bridgeBase }}/bridge/health/pending</code></p>
        <p>3. 手机调用「记录健康样本」写入膳食能量与蛋白后确认出队：<code>POST {{ bridgeBase }}/bridge/health/ack</code></p>
        <p>4. 桌面一键记一餐（优先直接识别剪贴板文字/截图，也支持粘贴编辑、拍照或相册 Base64 识图）：<code>POST {{ bridgeBase }}/bridge/health/log</code></p>
        <p>上述接口均使用请求头 <code>Authorization: Bearer &lt;私聊 /健康 同步 获取的个人 Token&gt;</code> 鉴权。</p>
      </div>
    </article>
  </div>
</template>

<style scoped>
.hp-workspace { display: flex; flex-direction: column; gap: 24px; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat-box { padding: 14px 16px; border: 1px solid var(--line); border-radius: 14px; background: #fbfcff; display: flex; flex-direction: column; gap: 6px; }
.stat-box span { font-size: 12px; color: var(--muted); }
.stat-box b { font-size: 22px; color: var(--ink); }
.toggle-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px; margin-top: 8px; }
.toggle-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: #fbfcff; cursor: pointer; }
.toggle-copy { display: flex; flex-direction: column; gap: 4px; }
.toggle-copy b { font-size: 13px; color: var(--ink); }
.toggle-copy small { font-size: 12px; line-height: 1.55; color: var(--muted); }
.toggle-item input { width: 18px; height: 18px; margin-top: 2px; flex-shrink: 0; }
.slot-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; margin-top: 18px; }
.slot-item { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--muted); }
.command-callout, .bridge-callout { margin-top: 12px; }
.command-callout p, .bridge-callout p { margin: 6px 0 0; font-size: 12px; line-height: 1.75; word-break: break-word; }
.error-inline { margin: 8px 0 0; color: #dc2626; font-size: 13px; }
</style>

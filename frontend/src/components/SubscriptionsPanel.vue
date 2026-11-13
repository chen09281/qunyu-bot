<script setup>
import { computed, inject, nextTick, ref } from 'vue';
import { consoleKey } from '../composables/useConsole';
import { groupSubscriptions } from '../utils/subscriptionGroups.js';
import WorkspaceIcon from './WorkspaceIcon.vue';
import SubscriptionPreviewDialog from './SubscriptionPreviewDialog.vue';
import StickySaveBar from './StickySaveBar.vue';
import { sameDraft } from '../utils/drafts.js';
import { games, gameInfo } from '../../../src/subscriptions/games.mjs';
const c = inject(consoleKey), editor = ref(null), nameInput = ref(null);
const types = { game: '游戏活动提醒', github: 'GitHub Release', bilibili: 'B 站投稿与动态', douyin: '抖音作品', rss: 'RSS / Atom' };
const groups = computed(() => (c.state.config.allowedGroups || []).map(g => typeof g === 'string' ? g : g.id));
const draft = computed(() => c.state.subscriptionDraft);
const query = ref(''), selectedGroup = ref(''), view = ref('list');
function showEditor() { view.value = 'editor'; }
async function addNew() { c.editSubscription(); showEditor(); await nextTick(); nameInput.value?.focus(); }
function cancelEditor() { c.editSubscription(); view.value = 'list'; }
const entries = computed(() => c.state.subscriptions?.entries || []);
const draftDefaults = { name: '', type: 'github', source: '', groups: [], enabled: true, include: '', exclude: '', crossPlatformMatch: true };
const draftKeys = Object.keys(draftDefaults);
const editorBaseline = computed(() => {
  const entry = entries.value.find(item => item.id === c.state.subscriptionEditId);
  return Object.fromEntries(draftKeys.map(key => [key, entry?.[key] ?? draftDefaults[key]]));
});
const editorDirtyCount = computed(() => draftKeys.filter(key => !sameDraft(draft.value[key], editorBaseline.value[key])).length);
const settingsDirtyCount = computed(() => ['enabled', 'intervalMinutes', 'rsshubUrl'].filter(key => !sameDraft(c.state.subscriptionSettings?.[key], c.state.subscriptions?.settings?.[key])).length);
const allGroups = computed(() => groupSubscriptions(entries.value, c.state.config.allowedGroups || []));
const grouped = computed(() => groupSubscriptions(entries.value, c.state.config.allowedGroups || [], { query: query.value, group: selectedGroup.value }));
const subscribedGroups = computed(() => allGroups.value.filter(group => group.entries.length).length);
const sourceHints = {
  game: { label: '选择游戏', help: '读取国服官网的活动、版本公告，并通过 RSSHub 官方 B 站动态补充前瞻直播资讯。各来源首次检查只记录已有内容；不自动生成活动倒计时。' },
  github: { label: '仓库', placeholder: 'owner/repo 或 GitHub 仓库网址', help: '订阅公开仓库的 Release 更新，使用 GitHub 提供的 Atom 源。' },
  bilibili: { label: 'UP 主 UID', placeholder: 'UID 或 https://space.bilibili.com/UID', help: '同时订阅 UP 主投稿、文字、图文和转发动态，通过 RSSHub 获取；新接入的动态首次只记录旧内容。' },
  douyin: { label: '抖音博主主页', placeholder: 'https://www.douyin.com/user/MS4wLjABAAAA…', help: '填写博主主页或 sec_uid；不是作品链接或抖音号。优先复用「链接解析 → 抖音登录」的登录态读取官方主页；失败后尝试 RSSHub，仍可能受风控限制。' },
  rss: { label: '订阅源地址', placeholder: 'https://example.com/feed.xml', help: '填写 RSS / Atom 地址；普通网页地址无法作为订阅源。' }
};
const hint = computed(() => sourceHints[draft.value.type]);
const date = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未检查';
const duration = value => Number.isFinite(value) ? value < 1000 ? `${value} 毫秒` : `${(value / 1000).toFixed(1)} 秒` : '—';
const suppressed = (entry, group) => entry.suppressedGroups?.includes(group.id);
const preferred = (entry, group) => entry.preferredGroups?.includes(group.id);
const fallback = (entry, group) => entry.fallbackGroups?.includes(group.id);
const matches = (entry, group) => (entry.matchedSubscriptions || []).filter(other => other.groups.includes(group.id));
const label = (entry, group) => !entry.enabled ? '已暂停' : !group.authorized ? '本群未授权' : suppressed(entry, group) ? '本群优先抖音' : entry.lastError ? '需要处理' : fallback(entry, group) ? '暂用 B 站推送' : entry.lastWarning ? '部分来源异常' : preferred(entry, group) ? '本群优先来源' : !entry.initializedAt ? '等待首次检查' : '已记录现有内容';
function selectGame() { draft.value.name = `${gameInfo(draft.value.source).name} · 活动与前瞻`; }
function changeType() { draft.value.source = draft.value.type === 'game' ? games[0].id : ''; if (draft.value.type === 'game') selectGame(); }
async function addGame(game) {
  const existing = entries.value.find(entry => entry.type === 'game' && entry.source === game.id);
  c.editSubscription(existing); showEditor();
  if (!existing) { Object.assign(draft.value, { type: 'game', source: game.id, groups: selectedGroup.value && groups.value.includes(selectedGroup.value) ? [selectedGroup.value] : [] }); selectGame(); }
  await nextTick(); editor.value?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); nameInput.value?.focus({ preventScroll: true });
}
async function addForGroup(group) {
  c.editSubscription(); c.state.subscriptionDraft.groups = [group]; showEditor();
  await nextTick(); editor.value?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); nameInput.value?.focus({ preventScroll: true });
}
async function edit(entry) {
  c.editSubscription(entry); showEditor(); await nextTick(); editor.value?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); nameInput.value?.focus({ preventScroll: true });
}
</script>

<template>
  <section class="subscriptions-panel">
    <div class="panel-heading"><p class="muted">按时检查新内容，多图合并为聊天记录，视频下载后直接发送并附原文链接。首次检查只记录当前内容，此后只推送新条目。</p><button class="secondary" :disabled="c.state.busy.subscriptionStatus" @click="c.loadSubscriptions">刷新状态</button></div>
    <p v-if="c.state.subscriptionError" class="error-text" role="alert">{{ c.state.subscriptionError }}</p>
    <div v-if="c.state.subscriptionConflict" class="service-note" role="status"><b>服务器推送设置已更新</b><p>与你正在编辑的字段存在冲突，已保留本页输入。保存将以本页内容为准。</p><button type="button" class="text-button" @click="c.resetSubscriptionSettings">放弃本页修改，使用服务器设置</button></div>
    <details class="subscription-help"><summary>群内快捷订阅 · 查看指令</summary><p class="service-note">群内快捷订阅：群主或管理员发送 <code>/订阅 博主主页链接</code>，自动推送到当前群。<code>/订阅 列表</code> 只看本群，<code>/订阅 取消订阅 编号</code> 取消当前群的订阅；<code>/订阅 帮助</code> 查看帮助图片，<code>/订阅 文档</code> 获取详细教程。各群可选择不同作者，后台也可统一设置多个目标群。</p></details>
    <p v-if="!c.state.subscriptionSettings" role="status">正在读取订阅设置…</p>
    <template v-else>
      <nav class="section-tabs" aria-label="订阅管理视图">
        <button type="button" :aria-pressed="view === 'list'" @click="view = 'list'">我的订阅 <span>{{ entries.length }}</span></button>
        <button type="button" :aria-pressed="view === 'editor'" @click="showEditor">{{ c.state.subscriptionEditId ? '编辑订阅' : '添加订阅' }}</button>
        <button type="button" :aria-pressed="view === 'settings'" @click="view = 'settings'">推送设置</button>
      </nav>
      <details v-show="view === 'editor'" class="card panel game-panel">
        <summary>快捷添加游戏活动提醒 <span class="muted">活动 · 版本更新 · 前瞻直播</span></summary>
        <p class="muted">选择游戏，再勾选要接收提醒的群。群管理员也可发送 <code>/订阅 游戏 终末地</code>，只为当前群开启。</p>
        <div class="game-options"><button v-for="game in games" :key="game.id" class="game-option" type="button" :style="{ '--game-color': game.color }" @click="addGame(game)"><strong>{{ game.name }}</strong><span>{{ entries.some(entry => entry.type === 'game' && entry.source === game.id) ? '管理推送群 →' : '添加游戏提醒 ＋' }}</span></button></div>
        <small>首次不补发旧公告；之前未读成功的来源恢复后，也先记录旧内容。读取异常会显示在对应订阅下方。</small>
      </details>
      <form v-show="view === 'settings'" class="card panel settings-form" @submit.prevent="c.saveSubscriptionSettings()">
        <div class="panel-heading"><h3>推送设置</h3><span class="subtle-tag">{{ c.state.subscriptions?.active ? '正在检查更新' : '定时检查' }}</span></div>
        <label class="choice"><input v-model="c.state.subscriptionSettings.enabled" type="checkbox">启用订阅推送</label>
        <div class="setting-fields">
          <label>检查间隔（分钟）<input v-model.number="c.state.subscriptionSettings.intervalMinutes" type="number" min="5" max="1440" required><small>5–1440 分钟；内容是否及时更新也取决于订阅源缓存。</small></label>
          <label>{{ c.state.subscriptions?.managedRsshub ? '备用 RSSHub 公网地址' : 'RSSHub 服务地址' }}<input v-model="c.state.subscriptionSettings.rsshubUrl" type="url" maxlength="2048" required placeholder="https://rsshub.app"><small>{{ c.state.subscriptions?.managedRsshub ? '当前使用服务器配置的自建服务；此处仅保留备用地址，更换当前服务需由服务器管理员操作。' : 'B 站和游戏官方动态需要可用的 RSSHub；抖音优先读取官方主页，RSSHub 为备用。公网地址支持 HTTP(S)，端口 80 / 443。' }}</small></label>
        </div>
        <p class="service-note">公共 RSSHub 实例可能受访问限制，也不会获得机器人的登录态。自建服务可由管理员配置独立的凭据同步工具；浏览器支持与平台限制仍会影响读取。GitHub 和普通 RSS 不依赖 RSSHub。<a href="https://github.com/DIYgod/RSSHub" target="_blank" rel="noopener noreferrer">了解 RSSHub ↗</a></p>
        <StickySaveBar :dirty-count="settingsDirtyCount"><button class="primary" type="submit" :disabled="c.state.busy.subscriptionSettings || !settingsDirtyCount">保存推送设置</button></StickySaveBar>
      </form>

      <form v-show="view === 'editor'" ref="editor" class="card panel subscription-editor" @submit.prevent="c.saveSubscription()">
        <div class="panel-heading"><h3>{{ c.state.subscriptionEditId ? '编辑订阅' : '添加订阅' }}</h3><button v-if="c.state.subscriptionEditId" class="text-button" type="button" @click="cancelEditor">取消编辑</button><span v-else class="subtle-tag">最多 100 条</span></div>
        <div class="setting-fields">
          <label>订阅名称<input ref="nameInput" v-model="draft.name" maxlength="80" required placeholder="给这条订阅起个名字"></label>
          <label>内容类型<select v-model="draft.type" @change="changeType"><option v-for="(name, id) in types" :key="id" :value="id">{{ name }}</option></select></label>
        </div>
        <label>{{ hint.label }}<select v-if="draft.type === 'game'" v-model="draft.source" required @change="selectGame"><option v-for="game in games" :key="game.id" :value="game.id">{{ game.name }}</option></select><input v-else v-model="draft.source" :placeholder="hint.placeholder" maxlength="2048" required><small>{{ hint.help }}</small></label>
        <template v-if="['bilibili', 'douyin'].includes(draft.type)"><label class="choice"><input v-model="draft.crossPlatformMatch" type="checkbox">参与同名跨平台匹配，优先抖音</label><p class="service-note">按订阅源返回的博主昵称匹配，不使用这里填写的订阅名称。同群绑定同名 B 站与抖音时，投稿优先推送读取正常的抖音来源，B 站动态仍独立推送；重名误匹配时可取消此项，保留独立推送。</p></template>
        <fieldset><legend>推送到哪些群</legend><p v-if="!groups.length" class="muted">请先在「群聊白名单」添加群号，再回来选择。</p><div class="group-options"><label v-for="group in groups" :key="group" class="choice"><input v-model="draft.groups" type="checkbox" :value="group">{{ group }}</label></div><small>每条订阅可选择 1–20 个群；新增目标只接收之后的新内容。</small></fieldset>
        <div class="setting-fields">
          <label>包含关键词（可选）<input v-model="draft.include" maxlength="200" placeholder="任一关键词命中即推送，用逗号分隔"><small>匹配标题和摘要，留空不过滤。</small></label>
          <label>排除关键词（可选）<input v-model="draft.exclude" maxlength="200" placeholder="如：预告,抽奖"><small>排除优先；支持普通关键词，不使用正则表达式。</small></label>
        </div>
        <label class="choice"><input v-model="draft.enabled" type="checkbox">启用这条订阅</label>
        <StickySaveBar :dirty-count="editorDirtyCount"><button class="primary" type="submit" :disabled="c.state.busy.subscriptionEdit || !draft.groups.length || !editorDirtyCount">{{ c.state.subscriptionEditId ? '保存订阅' : '添加订阅' }}</button></StickySaveBar>
      </form>

      <article v-show="view === 'list'" class="card panel subscription-list">
        <div class="panel-heading"><div><h3>我的订阅</h3><p class="grouped-intro">按群聊查看订阅的博主与更新来源，每个群独立管理关注列表。</p></div><div class="subscription-list-tools"><span class="subtle-tag">{{ entries.length }} 个来源 · {{ subscribedGroups }} 个已订阅群</span><button type="button" class="primary" @click="addNew">＋ 添加订阅</button></div></div>
        <div class="subscription-filters"><label>查找博主或群聊<input v-model="query" type="search" placeholder="博主名称、主页 ID 或群号" maxlength="100"></label><label>所属群聊<select v-model="selectedGroup"><option value="">全部群聊</option><option v-for="group in allGroups" :key="group.id" :value="group.id">群 {{ group.id }} · {{ group.entries.length }} 个来源</option></select></label></div>
        <p v-if="!allGroups.length" class="empty">请先添加群聊白名单，再为各群订阅喜欢的博主。</p>
        <div v-else-if="!grouped.length" class="grouped-empty"><p>没有找到匹配的博主或群聊。</p><button class="text-button" @click="query = ''; selectedGroup = ''">清除筛选</button></div>
        <details v-for="group in grouped" :key="group.id" class="subscription-group" :class="{ unauthorized: !group.authorized }" :open="group.entries.length > 0 && grouped.length <= 3">
          <summary><span class="subscription-group-icon"><WorkspaceIcon name="groups" /></span><span class="subscription-group-heading"><strong>群聊 {{ group.id }}</strong><span>{{ group.entries.length }} 位博主／来源<template v-if="!group.authorized"> · 已取消授权</template></span></span><span class="group-chevron" aria-hidden="true">⌄</span></summary>
          <div class="subscription-group-body">
            <div class="group-tools"><span>{{ group.authorized ? '新内容只推送到订阅它的群聊' : '本群不再接收推送，请恢复群授权或取消订阅' }}</span><button v-if="group.authorized" type="button" class="text-button" @click="addForGroup(group.id)">＋ 为本群添加</button></div>
            <p v-if="!group.entries.length" class="grouped-empty">这个群还没有订阅博主，点击“为本群添加”开始。</p>
            <article v-for="entry in group.entries" :key="entry.id" class="subscription-entry">
              <div class="entry-heading"><div><span class="entry-type">{{ types[entry.type] }}</span><h4>{{ entry.lastTitle || entry.name }}</h4></div><span class="entry-status" :class="{ warning: entry.lastError || entry.lastWarning || !group.authorized, priority: suppressed(entry, group) }">{{ label(entry, group) }}</span></div>
              <p class="entry-meta">最近检查：{{ date(entry.checkedAt) }} · 已推送 {{ entry.sent }} 次 · 待发送 {{ entry.pending }} 次</p>
              <p v-if="entry.nextCheckAt && entry.enabled && group.authorized" class="entry-meta">下次自动检查：{{ date(entry.nextCheckAt) }}（北京时间）<span v-if="entry.lastError"> · 失败后已延长间隔，可点击“检查更新”立即重试。</span></p>
              <p v-if="entry.lastError" class="entry-error">{{ entry.lastError }}</p>
              <p v-if="entry.lastWarning" class="entry-warning">{{ entry.lastWarning }}</p>
              <details class="entry-details"><summary>来源与运行详情<span v-if="entry.groups.length > 1"> · {{ entry.groups.length }} 个群共用来源</span></summary>
              <p class="entry-source">{{ entry.type === 'game' ? gameInfo(entry.source)?.name : entry.source }}<span v-if="entry.lastTitle && entry.lastTitle !== entry.name"> · {{ entry.name }}</span></p>
              <p v-if="entry.creatorName" class="entry-creator">已识别博主：{{ entry.creatorName }}<span v-if="entry.crossPlatformMatch === false"> · 独立推送</span></p>
              <p v-if="matches(entry, group).length" class="creator-priority-note"><b>检测到同名跨平台绑定</b><span v-if="suppressed(entry, group)">本群同名抖音来源最近读取正常，投稿优先由它推送，B 站文字和图文动态仍保留；抖音读取失败或长期没有更新读取状态时，自动恢复 B 站新内容。</span><span v-else-if="preferred(entry, group)">本群优先使用此抖音来源。读取失败后暂用同名 B 站，恢复读取后重新优先抖音。</span><span v-else-if="fallback(entry, group)">同名抖音来源尚未成功读取、读取失败或状态过旧，本群暂用 B 站推送新内容，避免漏推。</span><span v-else>同名来源当前不具备优先条件；已暂停或不可用的抖音来源不会阻止 B 站推送。</span></p>
              <p v-else-if="['bilibili', 'douyin'].includes(entry.type) && entry.crossPlatformMatch !== false && !entry.creatorName" class="entry-creator">等待成功读取订阅源后识别博主昵称。</p>
              <p v-if="entry.diagnostics" class="entry-meta">本次运行：读取 {{ duration(entry.diagnostics.lastReadMs) }} · 媒体准备 {{ duration(entry.diagnostics.lastMediaPrepareMs) }} · QQ 上传 {{ duration(entry.diagnostics.lastQqUploadMs) }}；累计失败：读取 {{ entry.diagnostics.readFailures }} / 媒体 {{ entry.diagnostics.mediaFailures }} / QQ {{ entry.diagnostics.qqUploadFailures }}；卡片转文字 {{ entry.diagnostics.cardFallbacks || 0 }} 次</p>
              <p v-if="entry.groups.length > 1" class="shared-source-note">此来源由 {{ entry.groups.length }} 个群共用；编辑、暂停和检查更新会作用于这些群，“取消订阅”只移除当前群的接收设置。推送次数为该来源各群合计。</p>
              </details>
              <p v-if="entry.groups.length > 1" class="entry-scope">编辑、暂停与检查更新影响 {{ entry.groups.length }} 个群；取消订阅仅影响当前群。</p>
              <div class="entry-actions"><button type="button" class="secondary" :disabled="c.state.busy.subscriptionAction" @click="c.subscriptionAction(entry.id, 'preview')">预览内容</button><button type="button" class="secondary" :disabled="c.state.busy.subscriptionAction || c.state.subscriptions.active || !c.state.config.enabled || !c.state.subscriptions.settings.enabled || !entry.enabled || !group.authorized" @click="c.subscriptionAction(entry.id, 'check')">检查更新</button><button type="button" class="text-button" :disabled="c.state.busy.subscriptionAction" @click="edit(entry)">编辑来源</button><details class="entry-more"><summary>更多操作</summary><div><button type="button" :disabled="c.state.busy.subscriptionAction" @click="c.toggleSubscription(entry)">{{ entry.enabled ? '暂停来源' : '恢复来源' }}<span class="effect-tag">立即生效</span></button><button type="button" class="danger" :disabled="c.state.busy.subscriptionAction" :aria-label="`取消群 ${group.id} 的 ${entry.lastTitle || entry.name} 订阅`" @click="c.removeSubscriptionGroup(entry.id, group.id)">取消订阅</button></div></details></div>
            </article>
          </div>
        </details>
      </article>

    </template>
  </section>
  <SubscriptionPreviewDialog v-if="c.state.subscriptionPreview" :preview="c.state.subscriptionPreview" @close="c.closeSubscriptionPreview" />
</template>

<style scoped>
.game-panel summary { cursor:pointer; font-size:14px; font-weight:600; }.game-panel summary span { display:inline-block; margin-left:12px; font-size:12px; font-weight:400; }.subscription-help { color:var(--muted); margin:16px 0; font-size:13px; }.subscription-help summary,.entry-details summary { cursor:pointer; min-height:36px; padding:8px 0; }
.subscription-list-tools { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }.entry-details { margin:12px 0; padding:0 12px; background:var(--soft); border-radius:10px; font-size:12px; color:var(--muted); }.entry-scope { font-size:12px; color:var(--muted); margin:12px 0; }

.game-options { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; margin:20px 0; }.game-option { display:flex; flex-direction:column; align-items:flex-start; gap:10px; text-align:left; padding:18px; border:1px solid var(--line); border-left:4px solid var(--game-color); border-radius:12px; background:var(--surface,#fff); cursor:pointer; min-width:0; }.game-option:hover { background:var(--soft); }.game-option strong { color:var(--game-color); font-size:15px; }.game-option span { font-size:12px; color:var(--muted); }.entry-warning { white-space:pre-line; color:#91652e; background:#fbf4e8; padding:12px; border-radius:8px; font-size:12px; }
.subscriptions-panel { font-size: 13px; line-height: 1.8; }.subscriptions-panel > .panel-heading { align-items: flex-start; flex-wrap: wrap; }.panel-heading p { margin: 0; flex: 1; min-width: 180px; }
h3,h4 { margin: 0; font-weight: 600; }h3 { font-size: 16px; }h4 { font-size: 17px; overflow-wrap: anywhere; }.card + .card { margin-top: 22px; }
label { display: block; margin: 18px 0; }.choice { display: flex; align-items: center; gap: 10px; }.choice input { width: 17px; height: 17px; margin: 0; accent-color: var(--green); }.setting-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }.setting-fields > label { min-width: 0; }
small,.service-note,.entry-meta { color: var(--muted); font-size: 11px; line-height: 1.9; }small { display: block; margin-top: 8px; }.service-note { background: var(--soft); border-radius: 10px; padding: 14px 16px; }.service-note a { white-space: nowrap; }
fieldset { border: 1px solid var(--line); border-radius: 10px; padding: 8px 16px 16px; margin: 22px 0; }legend { padding: 0 6px; }.group-options { display: flex; flex-wrap: wrap; gap: 0 24px; }.group-options label { margin: 10px 0; }.subscription-editor { scroll-margin-top: 120px; }
.grouped-intro { color:var(--muted); font-size:12px; margin:8px 0 0; }.subscription-filters { display:grid; grid-template-columns:minmax(0,1.5fr) minmax(0,1fr); gap:20px; margin:8px 0 14px; }.subscription-filters label { min-width:0; }.subscription-group { background:#fff; border:1px solid var(--line); border-radius:14px; margin-top:14px; overflow:hidden; }.subscription-group[open] { border-color:#c7d4ed; }.subscription-group > summary { display:flex; align-items:center; gap:14px; cursor:pointer; list-style:none; padding:20px; }.subscription-group > summary::marker { content:""; }.subscription-group > summary::-webkit-details-marker { display:none; }.subscription-group > summary:hover { background:#f6f8ff; }.subscription-group > summary:focus-visible { outline-offset:-4px; border-radius:14px; }.subscription-group-icon { width:42px; height:42px; display:grid; place-items:center; flex-shrink:0; background:var(--soft); color:var(--green); border-radius:12px; }.subscription-group-icon svg { width:21px; height:21px; }.subscription-group-heading { display:flex; flex-direction:column; min-width:0; flex:1; }.subscription-group-heading strong { font-size:15px; font-weight:600; overflow-wrap:anywhere; }.subscription-group-heading > span { color:var(--muted); font-size:11px; margin-top:3px; }.group-chevron { color:var(--muted); font-size:21px; transform:rotate(-90deg); }.subscription-group[open] .group-chevron { transform:rotate(0); }.subscription-group-body { margin:0 20px; border-top:1px solid var(--line); padding-bottom:20px; }.group-tools { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:14px 0; }.group-tools > span { color:var(--muted); font-size:11px; }.group-tools button { flex-shrink:0; min-height:36px; }.grouped-empty { padding:22px 0; color:var(--muted); font-size:12px; text-align:center; }.shared-source-note { color:var(--muted); background:var(--soft); font-size:11px; padding:10px 12px; border-radius:8px; margin:12px 0; }.unauthorized .subscription-group-icon { color:#986129; background:#faf0e3; }
.entry-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }.entry-type { color: var(--green); font-size: 10px; }.entry-status { font-size: 10px; color: var(--green); padding: 5px 9px; background: var(--soft); border-radius: 6px; white-space: nowrap; }.entry-status.warning { color: #9a6734; background: #faf2e5; }.subscription-entry { padding: 24px 0; border-top: 1px solid var(--line); }.subscription-entry:last-child { padding-bottom: 0; }.entry-source { color: var(--muted); font-size: 12px; margin: 12px 0; overflow-wrap: anywhere; }.entry-meta { margin: 12px 0; overflow-wrap: anywhere; }.entry-error { font-size: 12px; color: var(--red); margin: 10px 0; }.entry-actions { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }.entry-actions .text-button { min-height: 40px; }.entry-more { position:relative; }.entry-more summary { min-height:40px; display:flex; align-items:center; cursor:pointer; color:var(--accent); }.entry-more>div { position:absolute; z-index:5; right:0; bottom:calc(100% + 6px); min-width:180px; padding:8px; border:1px solid var(--line); border-radius:10px; background:var(--surface); box-shadow:0 10px 30px #344b7b20; }.entry-more>div>button { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; min-height:40px; padding:8px 10px; border:0; border-radius:7px; background:transparent; text-align:left; }.entry-more>div>button:hover { background:var(--soft); }.danger { color: var(--red); }.preview-item { padding: 16px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }.preview-item p { font-size: 12px; color: var(--muted); margin: 10px 0 0; }
.entry-status.priority { color:#596b64; background:#f0f3f0; }.entry-creator { color:var(--muted); font-size:11px; margin:8px 0; overflow-wrap:anywhere; }.creator-priority-note { display:flex; flex-direction:column; gap:4px; padding:12px 14px; margin:12px 0; border-radius:8px; border:1px solid #dfebe1; background:#f4f8f3; color:#557460; font-size:11px; line-height:1.8; overflow-wrap:anywhere; }.creator-priority-note b { font-weight:550; }
@media(max-width:650px) { .subscription-filters { grid-template-columns:1fr; gap:0; }.subscription-filters label { margin:12px 0; }.subscription-group > summary { padding:16px 12px; gap:10px; }.subscription-group-body { margin:0 12px; padding-bottom:16px; }.subscription-group-heading strong { font-size:14px; }.group-tools { flex-wrap:wrap; gap:4px; }.group-tools > span,.shared-source-note { font-size:12px; } .setting-fields { grid-template-columns: 1fr; gap: 0; }.panel { padding: 20px 16px; }input,select { font-size: 16px; }.entry-actions { gap: 12px 16px; }.entry-actions button { min-height: 44px; }.entry-actions .secondary { flex: 1; }.entry-heading { flex-wrap: wrap; gap: 10px; }.save-bar { flex-wrap: wrap; }.save-bar > button { flex: none; width: 100%; min-height: 44px; }small,.service-note,.entry-meta { font-size: 12px; } }
@media(prefers-reduced-motion:reduce) { .subscription-editor { scroll-behavior: auto; } }
</style>

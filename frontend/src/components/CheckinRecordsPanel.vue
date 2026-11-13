<script setup>
import { computed, inject, ref, watch } from 'vue';
import { consoleKey } from '../composables/useConsole';
import { accountStatus, checkinPlatforms, checkinRecordSummary, checkinResultLabels, filterCheckinMembers, latestCheckin, memberStatus } from '../utils/checkinRecords';
import WorkspaceIcon from './WorkspaceIcon.vue';
const c = inject(consoleKey);
const query = ref(''), platform = ref(''), status = ref(''), page = ref(1), expanded = ref('');
const members = computed(() => c.state.checkin?.members || []);
const totals = computed(() => checkinRecordSummary(members.value));
const filtered = computed(() => filterCheckinMembers(members.value, { query: query.value, platform: platform.value, status: status.value }));
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 10)));
const visible = computed(() => filtered.value.slice((page.value - 1) * 10, page.value * 10));
watch([query, platform, status], () => { page.value = 1; expanded.value = ''; });
watch(pages, value => { if (page.value > value) page.value = value; });
watch(page, () => { expanded.value = ''; });
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未执行';
function reset() { query.value = ''; platform.value = ''; status.value = ''; }
</script>

<template>
  <section class="records-panel">
    <div class="records-intro"><p>查看成员各平台的最近一次签到结果。需要处理的记录排在前面，时间均为北京时间。</p><button class="secondary" :disabled="c.state.busy.checkinStatus" @click="c.loadCheckin"><WorkspaceIcon name="refresh" />{{ c.state.busy.checkinStatus ? '刷新中' : '刷新记录' }}</button></div>
    <p v-if="c.state.checkinError" class="error-text" role="alert">{{ c.state.checkinError }}</p>
    <p v-if="!c.state.checkin" class="empty" role="status">{{ c.state.checkinError ? '暂时无法读取成员记录，请刷新重试。' : '正在读取成员记录…' }}</p>
    <template v-else>
      <dl class="record-stats"><div><dt>已开通成员</dt><dd>{{ totals.members }}<span>人</span></dd></div><div><dt>绑定账号</dt><dd>{{ totals.accounts }}<span>个</span></dd></div><div :class="{ attention: totals.attention }"><dt>需处理账号</dt><dd>{{ totals.attention }}<span>个</span></dd></div></dl>
      <div class="record-filters">
        <label class="record-search">查找成员<input v-model="query" type="search" placeholder="QQ、群号或游戏内昵称" maxlength="100"></label>
        <label>平台<select v-model="platform"><option value="">全部平台</option><option v-for="(name, id) in checkinPlatforms" :key="id" :value="id">{{ name }}</option></select></label>
        <label>状态<select v-model="status"><option value="">全部状态</option><option value="attention">需要处理</option><option value="success">有签到完成记录</option><option value="pending">待执行或待确认</option><option value="unbound">尚未绑定</option><option value="paused">已关自动签到</option></select></label>
      </div>
      <div class="results-heading"><p role="status">{{ filtered.length }} 位成员<template v-if="query || platform || status">符合条件</template><span> · {{ c.state.checkin.active || 0 }} 个任务执行中</span></p><button v-if="query || platform || status" class="text-button" @click="reset">清除筛选</button></div>
      <div v-if="!filtered.length" class="records-empty"><WorkspaceIcon name="groups" /><h3>{{ members.length ? '没有找到符合条件的成员' : '还没有成员开通签到' }}</h3><p>{{ members.length ? '试试其他 QQ、游戏内昵称，或清除筛选条件。' : '成员在授权群发送「/签到 开通」后，会出现在这里。' }}</p></div>
      <div v-else class="record-list">
        <article v-for="member in visible" :key="member.user" class="member-record" :class="{ expanded: expanded === member.user }">
          <button class="member-toggle" :aria-expanded="expanded === member.user" :aria-controls="`member-record-${member.user}`" @click="expanded = expanded === member.user ? '' : member.user">
            <span class="member-identity"><span class="member-avatar"><WorkspaceIcon name="private" /></span><span><strong>QQ {{ member.user }}</strong><span class="member-meta">群 {{ member.group }}<span class="auto-status">自动签到{{ member.auto ? '已开启' : '已关闭' }}</span></span></span></span>
            <span class="member-overview"><span class="result-badge" :class="memberStatus(member.accounts).key">{{ memberStatus(member.accounts).label }}</span><span class="expand-label">{{ expanded === member.user ? '收起记录' : '查看记录' }}<WorkspaceIcon name="arrow" /></span></span>
          </button>
          <div class="member-brief"><span class="platform-tags"><span v-for="account in member.accounts" :key="account.platform">{{ account.name || checkinPlatforms[account.platform] }}</span><span v-if="!member.accounts.length">未绑定平台</span></span><span>最近执行 {{ date(latestCheckin(member.accounts)) }}</span></div>
          <div v-if="expanded === member.user" :id="`member-record-${member.user}`" class="member-details">
            <p v-if="!member.accounts.length" class="binding-note">该成员尚未绑定平台账号。请让成员私聊机器人发送「/签到 帮助」查看绑定方法。</p>
            <section v-for="account in member.accounts" :key="account.platform" class="account-record">
              <div class="account-heading"><div><h3>{{ account.name || checkinPlatforms[account.platform] }}</h3><p>{{ date(account.last?.at) }}</p></div><span class="result-badge" :class="accountStatus(account).key">{{ accountStatus(account).label }}</span></div>
              <p v-if="account.needsLogin" class="binding-note warning-note">登录已失效，需由成员私聊重新绑定自己的账号。</p>
              <ul v-if="account.last?.items?.length" class="game-results"><li v-for="(item, index) in account.last.items" :key="index"><div><strong>{{ item.label || '签到结果' }}</strong></div><span class="result-badge" :class="['success', 'already'].includes(item.status) ? 'success' : item.status === 'cancelled' ? 'pending' : 'attention'">{{ checkinResultLabels[item.status] || '未完成' }}</span></li></ul>
              <p v-else class="binding-note">{{ account.last ? '任务已开始，但没有完成结果。若服务曾中断，可由成员手动发送「/签到」重试。' : '账号已绑定，等待每日计划执行；成员也可私聊发送「/签到」立即签到。' }}</p>
            </section>
          </div>
        </article>
      </div>
      <nav v-if="filtered.length > 10" class="record-pagination" aria-label="成员记录分页"><span>第 {{ page }} / {{ pages }} 页 · 每页 10 人</span><div><button class="secondary" :disabled="page === 1" @click="page--">上一页</button><button class="secondary" :disabled="page === pages" @click="page++">下一页</button></div></nav>
      <p class="record-footnote">这里展示各账号最近一次结果，不是完整历史流水；「签到完成」不代表今天已执行。</p>
    </template>
  </section>
</template>

<style scoped>
.records-panel { font-size:13px; line-height:1.7; }.records-intro { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }.records-intro p { color:var(--muted); margin:0; max-width:550px; }.records-intro button { display:flex; align-items:center; gap:8px; flex-shrink:0; }
.record-stats { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin:26px 0; }.record-stats > div { border:1px solid var(--line); border-radius:14px; background:white; padding:18px 22px; }.record-stats dt { color:var(--muted); font-size:12px; }.record-stats dd { margin:10px 0 0; font-size:30px; font-weight:550; line-height:1.2; font-variant-numeric:tabular-nums; }.record-stats dd span { font-size:12px; color:var(--muted); margin-left:8px; font-weight:400; }.record-stats .attention dd { color:#946026; }
.record-filters { display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1.15fr); gap:16px; }.record-filters label { min-width:0; font-size:12px; margin:0; }.record-filters input,.record-filters select { margin-top:8px; }.results-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin:20px 0 12px; }.results-heading p { margin:0; font-size:12px; }.results-heading span { color:var(--muted); }
.member-record { background:white; border:1px solid var(--line); border-radius:14px; overflow:hidden; margin-bottom:12px; }.member-record.expanded { border-color:#a9c4b3; }.member-toggle { border:0; background:transparent; width:100%; text-align:left; padding:20px 22px 10px; display:flex; align-items:center; justify-content:space-between; gap:20px; color:var(--ink); }.member-toggle:hover { background:#f7faf6; }.member-toggle:focus-visible { outline:2px solid var(--green); outline-offset:-3px; border-radius:12px; }.member-identity { display:flex; gap:12px; align-items:center; min-width:0; }.member-avatar { display:grid; place-items:center; width:40px; height:40px; flex-shrink:0; background:var(--soft); color:var(--green); border-radius:12px; }.member-identity strong { font-weight:600; display:block; font-size:14px; overflow-wrap:anywhere; }.member-meta { display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; margin-top:5px; font-size:11px; color:var(--muted); overflow-wrap:anywhere; }.auto-status { color:var(--muted); }.member-overview { display:flex; align-items:center; gap:20px; flex-shrink:0; }.expand-label { display:flex; align-items:center; gap:6px; color:var(--green); font-size:11px; white-space:nowrap; }.expand-label svg { width:16px; height:16px; transform:rotate(90deg); }.expanded .expand-label svg { transform:rotate(-90deg); }.member-brief { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; padding:0 22px 18px 74px; color:var(--muted); font-size:11px; }.platform-tags { display:flex; flex-wrap:wrap; gap:6px; }.platform-tags > span { background:#f3f5f1; padding:2px 7px; border-radius:4px; }
.result-badge { display:inline-block; font-size:11px; padding:4px 9px; border-radius:6px; max-width:100%; overflow-wrap:anywhere; }.result-badge.success { color:#275d43; background:#edf5ed; }.result-badge.attention { color:#87581f; background:#fbf1e4; }.result-badge.pending { color:#66746e; background:#f1f3f1; }.member-details { margin:0 22px; padding:0 0 20px; border-top:1px solid var(--line); }.account-record + .account-record { border-top:1px solid var(--line); margin-top:20px; }.account-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding-top:20px; }.account-heading h3 { margin:0; font-size:14px; font-weight:600; }.account-heading p { margin:4px 0 0; font-size:11px; color:var(--muted); }.game-results { list-style:none; padding:0; margin:12px 0 0; }.game-results li { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:12px 14px; background:#f8faf6; border-radius:8px; margin-top:8px; }.game-results li > div { min-width:0; }.game-results strong { font-weight:500; overflow-wrap:anywhere; }.game-results .result-badge { flex-shrink:0; max-width:45%; }.binding-note { font-size:12px; color:var(--muted); margin:14px 0 0; }.warning-note { color:#87581f; }.records-empty { text-align:center; padding:50px 20px; background:white; border:1px dashed var(--line); border-radius:14px; }.records-empty svg { width:32px; height:32px; color:var(--muted); }.records-empty h3 { font-size:15px; font-weight:550; margin:14px 0 8px; }.records-empty p { font-size:12px; color:var(--muted); margin:0; }.record-pagination { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:20px; color:var(--muted); font-size:12px; }.record-pagination > div { display:flex; gap:10px; }.record-footnote { color:var(--muted); font-size:11px; margin:22px 0 0; }
@media(max-width:650px) { .records-intro { gap:12px; flex-wrap:wrap; }.record-stats { gap:8px; margin:20px 0; }.record-stats > div { padding:14px 10px; border-radius:10px; }.record-stats dt { font-size:11px; }.record-stats dd { font-size:25px; }.record-stats dd span { margin-left:4px; }.record-filters { grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px 10px; }.record-search { grid-column:1/-1; }.record-filters input,.record-filters select { font-size:16px; }.member-toggle { flex-direction:column; align-items:stretch; gap:12px; padding:16px 14px 10px; }.member-overview { justify-content:space-between; }.member-identity strong { font-size:15px; }.member-meta { font-size:12px; }.member-brief { padding:0 14px 16px; font-size:12px; }.member-details { margin:0 14px; }.game-results li { align-items:flex-start; flex-direction:column; gap:8px; padding:12px; }.game-results .result-badge { max-width:100%; }.account-heading p,.record-footnote { font-size:12px; }.record-pagination { flex-wrap:wrap; }.record-pagination button,.records-intro button { min-height:44px; } }
</style>

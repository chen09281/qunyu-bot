<script setup>
import { computed, inject } from 'vue';
import { consoleKey } from '../composables/useConsole';
import { checkinPlatforms as platforms, checkinRecordSummary } from '../utils/checkinRecords';
import WorkspaceIcon from './WorkspaceIcon.vue';
import StickySaveBar from './StickySaveBar.vue';
import { sameDraft } from '../utils/drafts.js';
const c = inject(consoleKey);
const records = computed(() => checkinRecordSummary(c.state.checkin?.members));
const dirtyCount = computed(() => ['enabled', 'time', 'platforms', 'notify'].filter(key => !sameDraft(c.state.checkinSettings?.[key], c.state.checkin?.settings?.[key])).length);
</script>

<template>
  <section class="checkin-panel">
    <div class="panel-heading"><p class="muted">成员独立绑定账号。每日按北京时间执行，结果通过私聊发送。</p><button class="secondary" :disabled="c.state.busy.checkinStatus" @click="c.loadCheckin">刷新状态</button></div>
    <p v-if="c.state.checkinError" class="error-text" role="alert">{{ c.state.checkinError }}</p>
    <div v-if="c.state.checkinConflict" class="callout" role="status"><b>服务器设置已更新</b><p>与你正在编辑的字段存在冲突，已保留本页输入。保存将以本页内容为准。</p><button type="button" class="text-button" @click="c.resetCheckinDraft">放弃本页修改，使用服务器设置</button></div>
    <button class="records-entry" type="button" @click="c.navigate('plugins/checkin/records')">
      <span class="records-icon"><WorkspaceIcon name="logs" /></span><span class="records-copy"><strong>成员签到记录</strong><span>{{ c.state.checkin ? `${records.members} 位成员 · ${records.accounts} 个绑定账号` : '查看成员的绑定与最近签到结果' }}<span v-if="records.attention" class="records-attention"> · {{ records.attention }} 个账号需处理</span></span></span><span class="records-link">查看记录<WorkspaceIcon name="arrow" /></span>
    </button>
    <p v-if="!c.state.checkinSettings" role="status">正在读取签到设置…</p>
    <form v-else class="card panel form-panel" @submit.prevent="c.saveCheckin()">
      <div class="panel-heading"><h2>每日计划</h2><span class="subtle-tag">Asia/Shanghai</span></div>
      <label class="choice"><input v-model="c.state.checkinSettings.enabled" type="checkbox">启用签到插件</label>
      <label>每日签到时间<input v-model="c.state.checkinSettings.time" type="time" required><small>服务晚于此时间启动，会补跑今天尚未尝试的账号。当天失败可由成员手动重试。</small></label>
      <div class="choices"><label v-for="(name, id) in platforms" :key="id" class="choice"><input v-model="c.state.checkinSettings.platforms[id]" type="checkbox">{{ name }}</label></div>
      <label class="choice"><input v-model="c.state.checkinSettings.notify" type="checkbox">私聊发送每日结果</label>
      <p class="muted">暂停机器人、关闭插件或移出群白名单后暂停签到。登录失效会暂停该账号，重新绑定后恢复。</p>
      <StickySaveBar :dirty-count="dirtyCount"><button type="submit" class="primary" :disabled="c.state.busy.checkin || !dirtyCount">保存设置</button></StickySaveBar>
    </form>
    <details class="card panel member-help">
      <summary><span><strong>成员使用方法</strong><small>绑定步骤、常用指令与工具</small></span><span class="muted">展开说明</span></summary>
      <ol><li>在群白名单内的群发送 <code>/签到 开通</code>。</li><li>加机器人好友，私聊发送以下绑定指令。每个 QQ 在每个平台可绑定一个账号，支持该账号下多个游戏角色。</li><li>发送 <code>/签到</code> 立即执行，或等待每日任务。</li></ol>
      <dl>
        <dt>森空岛 · 明日方舟、终末地</dt><dd><code>/签到 绑定 森空岛 &lt;token&gt;</code><p>登录森空岛网页后，在同一浏览器打开 <a href="https://web-api.skland.com/account/info/hg" target="_blank" rel="noreferrer">官方 token 页面</a>，复制 data.content，或完整 JSON。也支持带 token、dId 的 JSON。</p></dd>
        <dt>米游社 · 原神、星铁、绝区零、崩坏3、崩坏学园2、未定事件簿国服</dt><dd><code>/签到 绑定 米游社 &lt;Cookie&gt;</code><p>使用本人米游社登录 Cookie，须含 cookie_token（或 cookie_token_v2）及对应账号 ID。社区签到还需要 stoken，v2 stoken 同时需要 mid；只提供游戏 Cookie 时仅签到游戏。</p></dd>
        <dt>库街区 · 鸣潮、战双帕弥什及社区</dt><dd><code>/签到 绑定 库街区 &lt;token&gt;</code><p>使用本人库街区 App 请求头中的 token；网页版 token 可能不适用。可用 <code>{"token":"…","userId":"…","devCode":"…"}</code> 提供完整 App 凭据。</p></dd>
      </dl>
      <p><code>/签到 状态</code> 查看自己的记录；<code>/签到 自动 关</code> 暂停个人计划；<code>/签到 自动 开</code> 恢复；私聊 <code>/签到 解绑 全部</code> 删除凭据。</p>
      <p class="muted">库街区可使用 <a href="/tools/kuro/" target="_blank" rel="noopener noreferrer">Token 获取工具</a>，提供安卓 App、电脑本机包和 iOS Scriptable 脚本。</p>
      <p class="muted">发送 <code>/签到 帮助</code> 查看帮助图片；发送 <code>/签到 文档</code> 单独获取详细绑定教程。</p>
      <p class="muted">绑定会验证登录态，凭据不回显。若平台要求验证码，请在官方 App 完成验证后手动重试。插件只执行签到，不自动评论、点赞或补签消费。</p>
    </details>
  </section>
</template>

<style scoped>
.checkin-panel { font-size: 13px; line-height: 1.9; }.checkin-panel > .panel { margin-top: 22px; }.panel-heading { flex-wrap: wrap; gap: 12px; }.panel-heading p { margin: 0; }.choice { display: flex; align-items: center; gap: 10px; }.choice input { width: 17px; height: 17px; margin: 0; accent-color: var(--green); }.choices { display: flex; flex-wrap: wrap; gap: 24px; }.choices label { margin: 0; }input[type="time"] { max-width: 240px; }code { background: var(--soft); border-radius: 4px; padding: 3px 5px; overflow-wrap: anywhere; }dt { margin-top: 18px; font-weight: 600; }dd { margin: 8px 0; }dd p { color: var(--muted); }a { color: var(--green); }.checkin-panel ol { padding-left: 20px; }
.records-entry { display:flex; align-items:center; gap:16px; width:100%; text-align:left; border:1px solid var(--line); background:white; color:var(--ink); padding:20px 24px; border-radius:14px; margin-top:22px; }.records-entry:hover { border-color:#9cbaa8; background:#f8fbf6; }.records-icon { width:44px; height:44px; flex-shrink:0; display:grid; place-items:center; color:var(--green); background:var(--soft); border-radius:12px; }.records-copy { flex:1; min-width:0; }.records-copy strong { display:block; font-size:15px; font-weight:600; }.records-copy > span { display:block; font-size:12px; color:var(--muted); margin-top:4px; }.records-copy .records-attention { color:#946026; }.records-link { display:flex; align-items:center; gap:8px; color:var(--green); font-size:12px; white-space:nowrap; }.records-link svg { width:17px; }.member-help summary { display:flex; justify-content:space-between; align-items:center; gap:16px; cursor:pointer; list-style:none; }.member-help summary::-webkit-details-marker { display:none; }.member-help summary strong { font-size:16px; font-weight:600; }.member-help summary small { display:block; color:var(--muted); margin-top:4px; font-size:12px; }.member-help summary > span:last-child { white-space:nowrap; font-size:12px; }.member-help[open] summary { padding-bottom:14px; border-bottom:1px solid var(--line); }
@media(max-width:650px) { .choices { gap:16px; }.save-bar { gap:16px; flex-wrap:wrap; }.save-bar > button { flex:none; width:100%; min-height:44px; }.records-entry { padding:16px; gap:12px; flex-wrap:wrap; }.records-link { margin-left:56px; }.records-copy { flex-basis:calc(100% - 56px); }.member-help { padding:20px 16px; } }
</style>

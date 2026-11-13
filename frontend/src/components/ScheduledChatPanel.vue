<script setup>
import { computed, inject, ref } from 'vue';
import { consoleKey, defaultChatTimes, normalizeGroupRule } from '../composables/useConsole';
import StickySaveBar from './StickySaveBar.vue';
const c = inject(consoleKey), query = ref('');
const enabled = computed(() => c.state.config.proactiveChatEnabled !== false);
const groups = computed(() => (c.state.config.allowedGroups || []).map(normalizeGroupRule).filter(Boolean));
const selected = computed(() => groups.value.filter(group => group.scheduledChat).length);
const visible = computed(() => groups.value.filter(group => group.id.includes(query.value.trim())));
const times = computed(() => c.state.config.scheduledChatTimes ?? defaultChatTimes);
const changed = computed(() => (c.state.scheduledChatTimes || []).join() !== times.value.join());
async function restoreDefaults() {
  if (!changed.value || !await c.askConfirmation({ title: '恢复默认发送时间？', description: '将放弃当前自定义的发送时间，恢复为每天 12:00、15:00 和 18:00。', detail: '恢复后仍需点击“保存发送时间”才会生效。', confirmText: '恢复默认', tone: 'danger' })) return;
  c.state.scheduledChatTimes = [...defaultChatTimes];
}
const status = group => !group.scheduledChat ? '本群已关闭' : !group.ds ? '等待开启调用 DS' : !enabled.value ? '插件已暂停' : !c.state.config.enabled ? '等待机器人启用' : !c.state.config.modelApiKeyConfigured ? '等待配置模型密钥' : '按已保存的计划参与定时聊天';
</script>

<template>
  <section class="scheduled-chat-settings">
    <p class="intro">按你设定的时刻，让当前角色来问好。群聊自动同步已保存的白名单；开关立即保存，自定义时间点击保存后生效。</p>
    <article class="card panel">
      <div class="panel-heading"><h3>聊天安排</h3><span class="subtle-tag">北京时间 · Asia/Shanghai · 开关立即生效</span></div>
      <div class="setting-row"><div><b>启用定时聊天</b><p>关闭后停止所有群的定时发言与免 @ 续聊，普通 @ 问答仍可使用。</p></div><button type="button" class="chat-switch" role="switch" :aria-checked="enabled" aria-label="定时聊天总开关" :disabled="c.state.busy.scheduledChat" @click="c.toggleScheduledChat"><span>{{ enabled ? '已开启' : '已关闭' }}</span><i aria-hidden="true" /></button></div>
      <form class="time-editor" @submit.prevent="c.saveScheduledChatTimes">
        <div class="time-heading"><b>自定义发送时间</b><span>每天 · 北京时间 · 最多 24 个</span></div>
        <div class="schedule-times"><div v-for="(_time, index) in c.state.scheduledChatTimes || []" :key="index" class="time-slot"><label :for="`chat-time-${index}`">时点 {{ index + 1 }}</label><input :id="`chat-time-${index}`" v-model="c.state.scheduledChatTimes[index]" type="time" step="60" required :disabled="c.state.busy.scheduledChat"><button type="button" class="text-button" :aria-label="`删除时点 ${index + 1}`" :disabled="c.state.busy.scheduledChat || c.state.scheduledChatTimes.length <= 1" @click="c.state.scheduledChatTimes.splice(index, 1)">删除</button></div></div>
        <StickySaveBar :dirty-count="changed ? 1 : 0" dirty-text="发送时间有未保存调整" saved-text="发送时间已保存"><button type="button" class="secondary" :disabled="c.state.busy.scheduledChat || c.state.scheduledChatTimes?.length >= 24" @click="c.state.scheduledChatTimes.push('09:00')">＋ 添加时点</button><button type="button" class="text-button" :disabled="c.state.busy.scheduledChat" @click="restoreDefaults">恢复默认</button><button type="submit" class="primary" :disabled="c.state.busy.scheduledChat || !changed">保存发送时间</button></StickySaveBar>
        <p class="note">当前计划：{{ times.join('、') }}。每天按这些时点发送，重复时间会合并；修改时间不会补发已错过的消息。</p>
      </form>
      <div class="setting-row followup"><div><b>免 @ 接话与连续聊天</b><p>定时发出后的前 5 分钟可接话；超过 5 分钟后，已参与的成员须在机器人回复后 1 分钟内接话。1 分钟无人接话即退出，普通 @ 问答不会开启窗口。</p></div><button type="button" class="chat-switch" role="switch" :aria-checked="c.state.config.groupFollowupEnabled !== false" aria-label="免 @ 续聊开关" :disabled="c.state.busy.scheduledChat" @click="c.toggleScheduledFollowup"><span>{{ c.state.config.groupFollowupEnabled !== false ? '已开启' : '已关闭' }}</span><i aria-hidden="true" /></button></div>
      <p class="note">问候沿用当前性格与二次元轻梗，不 @ 成员。错过的时点不补发，同群同一时点不重复发送。</p>
    </article>

    <article class="card panel group-panel">
      <div class="panel-heading"><h3>参与的群聊</h3><span class="subtle-tag">{{ selected }} / {{ groups.length }} 个群已选 · 开关立即生效</span></div>
      <p class="note">只向已启用本群定时聊天、且开启「调用 DS」的授权群发送。新群沿用开启状态，插件总开关仍然有效。</p>
      <div class="group-tools"><label>查找群号<input v-model="query" type="search" inputmode="numeric" placeholder="输入群号筛选" maxlength="20"></label><button type="button" class="text-button" @click="c.navigate('groups')">管理群聊白名单 ↗</button></div>
      <div v-for="group in visible" :key="group.id" class="group-row">
        <div><b class="group-id">群 {{ group.id }}</b><span class="group-status" :class="{ active: group.scheduledChat && group.ds && enabled && c.state.config.enabled && c.state.config.modelApiKeyConfigured }">{{ status(group) }}</span></div>
        <button type="button" class="chat-switch" role="switch" :aria-checked="group.scheduledChat" :aria-label="`群 ${group.id} 定时聊天开关`" :disabled="c.state.busy.scheduledChat || c.state.busy.groups" @click="c.toggleScheduledChatGroup(group.id)"><span>{{ group.scheduledChat ? '已开启' : '已关闭' }}</span><i aria-hidden="true" /></button>
      </div>
      <p v-if="!groups.length" class="empty">白名单还没有群聊，请先添加并保存群聊白名单。</p><p v-else-if="!visible.length" class="empty">没有找到这个群，请检查群号。</p>
      <p class="note bottom-note">关闭本群会立即结束已有的免 @ 窗口，并取消尚未发送的定时或续聊回复；重新开启后按计划执行，已尝试过的时点不重复发送。群聊被移出白名单后将从这里移除。</p>
    </article>
  </section>
</template>

<style scoped>
.intro,.note,.setting-row p { color:var(--muted); font-size:12px; line-height:1.9; }.intro { margin:0 0 22px; }.panel { padding:26px; }.panel h3 { font-size:16px; font-weight:600; margin:0; }.setting-row { display:flex; gap:24px; align-items:center; justify-content:space-between; }.setting-row > div { min-width:0; }.setting-row b { font-size:13px; font-weight:550; }.setting-row p { margin:6px 0 0; }.chat-switch { display:flex; align-items:center; gap:10px; flex-shrink:0; padding:6px 0 6px 8px; min-height:44px; background:transparent; border:0; border-radius:8px; color:var(--muted); font:inherit; font-size:11px; cursor:pointer; }.chat-switch i { display:block; width:40px; height:24px; padding:3px; border-radius:20px; background:#d7ded6; }.chat-switch i::after { content:''; display:block; width:18px; height:18px; border-radius:50%; background:white; box-shadow:0 1px 3px #0002; transition:transform .18s; }.chat-switch[aria-checked=true] i { background:var(--green); }.chat-switch[aria-checked=true] i::after { transform:translateX(16px); }.chat-switch:focus-visible { outline:3px solid #83ac94; outline-offset:3px; }.chat-switch:disabled { opacity:.6; cursor:wait; }.schedule-times { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin:24px 0; }.schedule-times > span { display:flex; flex-direction:column; gap:6px; padding:18px; background:var(--soft); border-radius:10px; color:var(--muted); font-size:11px; }.schedule-times b { color:var(--green); font-size:22px; font-weight:500; font-variant-numeric:tabular-nums; }.followup { padding-top:22px; border-top:1px solid var(--line); }.note { margin:12px 0 0; }.group-panel { margin-top:22px; }.group-tools { display:flex; align-items:end; justify-content:space-between; gap:24px; margin:20px 0 12px; }.group-tools label { flex:1; max-width:320px; margin:0; font-size:12px; }.group-tools input { margin-top:8px; }.group-tools button { flex-shrink:0; min-height:44px; }.group-row { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:16px 0; border-top:1px solid var(--line); }.group-id { display:block; font-size:13px; font-weight:550; overflow-wrap:anywhere; }.group-status { display:block; margin-top:6px; font-size:11px; color:var(--muted); }.group-status.active { color:var(--green); }.bottom-note { border-top:1px solid var(--line); padding-top:16px; }.empty { font-size:13px; padding:24px 0; color:var(--muted); text-align:center; }
.time-editor { margin:24px 0; }.time-heading { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; }.time-heading b { font-size:13px; font-weight:550; }.time-heading span { font-size:11px; color:var(--muted); }.schedule-times { grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr)); margin:16px 0; }.time-slot { background:var(--soft); padding:14px; border-radius:10px; min-width:0; }.time-slot label { display:block; margin:0 0 8px; font-size:11px; color:var(--muted); }.time-slot input { min-width:0; width:100%; font-size:18px; color:var(--green); background:#fff; }.time-slot button { min-height:36px; margin-top:4px; font-size:11px; }.time-actions { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }.time-actions .primary { margin-left:auto; }.time-actions button { min-height:40px; }
@media(max-width:650px) { .panel { padding:20px 16px; }.setting-row { gap:14px; align-items:flex-start; }.chat-switch { font-size:12px; }.schedule-times { gap:8px; }.time-slot input { font-size:16px; }.time-actions { gap:10px 16px; }.time-actions .primary { width:100%; margin-left:0; }.group-tools { flex-wrap:wrap; gap:6px; }.group-tools label { max-width:none; flex-basis:100%; }.group-tools input { font-size:16px; }.group-status { font-size:12px; } }
@media(prefers-reduced-motion:reduce) { .chat-switch i::after { transition:none; } }
</style>

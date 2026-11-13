<script setup>
import { computed, inject } from 'vue';
import { consoleKey } from '../composables/useConsole';
import StickySaveBar from './StickySaveBar.vue';
const c = inject(consoleKey);
defineProps({ embedded: Boolean });
const total = computed(() => c.state.groupRules.length);
const noModel = computed(() => c.state.groupRules.filter(rule => !rule.ds).length);
const noVideo = computed(() => c.state.groupRules.filter(rule => !rule.video).length);
const groupChanges = computed(() => {
  const saved = new Map((c.state.config?.allowedGroups || []).map(rule => [typeof rule === 'string' ? rule : rule.id, { ds: rule.ds !== false, video: rule.video !== false }]));
  const draft = new Map(c.state.groupRules.map(rule => [rule.id, { ds: rule.ds !== false, video: rule.video !== false }]));
  let added = 0, removed = 0, modified = 0;
  for (const [id, rule] of draft) {
    if (!saved.has(id)) added++;
    else if (saved.get(id).ds !== rule.ds || saved.get(id).video !== rule.video) modified++;
  }
  for (const id of saved.keys()) if (!draft.has(id)) removed++;
  return { added, removed, modified, total: added + removed + modified };
});
const changed = computed(() => groupChanges.value.total > 0);
const changeSummary = computed(() => [
  groupChanges.value.added ? `新增 ${groupChanges.value.added} 个群` : '',
  groupChanges.value.removed ? `移除 ${groupChanges.value.removed} 个群` : '',
  groupChanges.value.modified ? `修改 ${groupChanges.value.modified} 个群` : '',
].filter(Boolean).join('、'));
</script>

<template>
  <section id="page-groups" class="page">
    <div v-if="!embedded" class="page-heading"><div><span class="eyebrow">WHO MAY CALL</span><h1>决定谁能叫醒它<span class="title-dot">.</span></h1><p class="muted">逐个群授权，并可单独关闭模型回复或视频解析；未列出的群不会处理任何消息。</p></div></div>
    <div class="group-stats"><article class="card"><span>已授权群</span><strong>{{ total }}</strong><small>留空时机器人静默</small></article><article class="card"><span>已关闭模型回复</span><strong>{{ noModel }}</strong><small>仅解析链接，不调用 DeepSeek</small></article><article class="card"><span>已关闭视频解析</span><strong>{{ noVideo }}</strong><small>只发送标题、简介与图片</small></article></div>

    <form class="card panel form-panel group-add" @submit.prevent="c.addGroupRule">
      <div class="panel-heading"><h2>添加群聊</h2><span class="subtle-tag">群号可在 QQ 群资料页查看</span></div>
      <div class="group-add-row">
        <label>群号<input v-model="c.state.groupDraft.id" name="groupDraftId" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="例如 123456789" required></label>
        <label class="group-option"><input v-model="c.state.groupDraft.ds" type="checkbox" name="groupDraftDs"><span>调用 DS<small>允许 @ 回复，以及已开启的主动冒泡和免 @ 续聊</small></span></label>
        <label class="group-option"><input v-model="c.state.groupDraft.video" type="checkbox" name="groupDraftVideo"><span>解析视频<small>自动下载并发送链接中的视频</small></span></label>
        <button class="secondary" type="submit">＋ 添加</button>
      </div>
      <small class="group-hint">新添加的群两项默认开启；添加后记得点击下方「保存白名单」才会生效。</small>
    </form>

    <form class="card panel group-list" @submit.prevent="c.saveGroups">
      <div class="panel-heading"><h2>白名单</h2><span class="subtle-tag">{{ total || '空' }}</span></div>
      <p v-if="!total" class="empty">还没有授权任何群。<small>白名单为空时，机器人不会回复任何群消息。</small></p>
      <div v-else class="group-head"><span>群号</span><span>调用 DS</span><span>解析视频</span><span>操作</span></div>
      <div v-for="rule in c.state.groupRules" :key="rule.id" class="group-row">
        <code>{{ rule.id }}</code>
        <label class="switch"><input v-model="rule.ds" type="checkbox" :aria-label="`${rule.id} 调用 DeepSeek`"><span><b class="mobile-rule-label">调用 DS · </b>{{ rule.ds ? '开启' : '关闭' }}</span></label>
        <label class="switch"><input v-model="rule.video" type="checkbox" :aria-label="`${rule.id} 解析视频`"><span><b class="mobile-rule-label">解析视频 · </b>{{ rule.video ? '开启' : '关闭' }}</span></label>
        <button class="text-button" type="button" @click="c.removeGroupRule(rule.id)">移除</button>
      </div>
      <div class="callout"><b>开关的含义</b><p>关闭「调用 DS」后，该群的 @ 回复、定时聊天和免 @ 续聊全部停止，但社交平台链接仍会解析；关闭「解析视频」后，视频链接只发送标题、简介和图片，不下载视频。所有开关都在保存后生效，排队任务会按最新授权取消。仅需关闭定时发言时，可到插件单独管理，保留普通 @ 问答。</p><button type="button" class="text-button" @click="c.navigate('plugins/scheduled-chat')">管理定时聊天群开关 ↗</button></div>
      <StickySaveBar :dirty-count="groupChanges.total" :dirty-text="changeSummary"><button class="primary" type="submit" :disabled="c.state.busy.groups || !changed">{{ c.state.busy.groups ? '保存中…' : '保存白名单 ↗' }}</button></StickySaveBar>
    </form>
  </section>
</template>

<style scoped>
.mobile-rule-label { display: none; font-weight: inherit; }
.group-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-bottom: 24px; }
.group-stats article { padding: 24px; }
.group-stats span { color: var(--muted); font-size: 12px; }
.group-stats strong { display: block; font-size: 30px; font-weight: 550; margin: 12px 0 8px; color: var(--green); font-variant-numeric: tabular-nums; }
.group-stats small { font-size: 10px; color: #a0aaa0; }
.group-add-row { display: grid; grid-template-columns: minmax(180px, 1.2fr) minmax(150px, 1fr) minmax(150px, 1fr) auto; gap: 16px; align-items: end; }
.group-add-row > label { margin: 0; }
.group-add-row > button { margin-bottom: 1px; }
.group-option { display: flex; align-items: flex-start; gap: 10px; font-size: 12px; font-weight: 550; padding-bottom: 10px; }
.group-option input { width: 16px; height: 16px; margin: 0; flex-shrink: 0; accent-color: var(--green); }
.group-option span { line-height: 1.6; }
.group-option small { display: block; margin-top: 4px; font-weight: 400; }
.group-hint { display: block; margin-top: 16px; font-size: 10px; color: #8c998e; }
.group-list { margin-top: 24px; }
.group-head, .group-row { display: grid; grid-template-columns: minmax(140px, 1.4fr) 110px 110px 70px; gap: 12px; align-items: center; }
.group-head { padding: 0 4px 12px; border-bottom: 1px solid var(--line); font-size: 10px; color: #82937e; }
.group-row { padding: 14px 4px; border-bottom: 1px solid #f0f2ed; font-size: 12px; }
.group-row:hover { background: #fafcf8; }
.group-row code { font-family: ui-monospace, monospace; font-size: 12px; color: #3e5838; overflow-wrap: anywhere; }
.switch { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 11px; font-weight: 500; color: #6d7e69; cursor: pointer; }
.switch input { width: 16px; height: 16px; margin: 0; flex-shrink: 0; accent-color: var(--green); }
@media(max-width:900px) { .group-add-row { grid-template-columns: 1fr 1fr; } .group-add-row > button { grid-column: 1 / -1; } }
@media(max-width:650px) { .group-stats { gap: 8px; } .group-stats article { padding: 16px; } .group-stats strong { font-size: 24px; } .group-add-row { grid-template-columns: 1fr; } .group-head { display: none; } .group-row { grid-template-columns: 1fr auto auto; row-gap: 10px; } .group-row code { grid-column: 1 / -1; } }
@media(max-width:650px) {
  .group-stats { grid-template-columns: 1fr; }
  .group-stats article { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
  .group-stats strong { grid-column: 2; grid-row: 1 / 3; align-self: center; margin: 0; }
  .group-stats small { font-size: 11px; }
  .group-row { grid-template-columns: 1fr 1fr; padding: 16px 0; gap: 8px; }
  .group-row code { grid-column: 1; font-size: 14px; }.group-row>button { grid-column: 2; grid-row: 1; justify-self: end; }
  .switch { min-height: 44px; font-size: 12px; gap: 6px; }.mobile-rule-label { display: inline; }
  .group-option { min-height: 44px; }
}
</style>

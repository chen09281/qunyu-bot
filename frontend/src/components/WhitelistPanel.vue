<script setup>
import { inject, nextTick } from 'vue';
import { consoleKey } from '../composables/useConsole';
import GroupsPanel from './GroupsPanel.vue';
import PrivatePanel from './PrivatePanel.vue';
const c = inject(consoleKey);
async function changeTab(tab) { c.navigate('whitelist/' + tab); await nextTick(); document.getElementById('whitelist-tab-' + tab)?.focus(); }
</script>
<template>
  <section class="page" id="page-whitelist">
    <div class="page-heading"><div><span class="eyebrow">WHO MAY CALL</span><h1>白名单<span class="title-dot">.</span></h1><p class="muted">集中管理可调用机器人的群聊与私聊账号，各自授权、独立保存。</p></div></div>
    <div class="whitelist-tabs" role="tablist" aria-label="白名单类型"><button v-for="tab in ['groups', 'private']" :id="`whitelist-tab-${tab}`" :key="tab" type="button" role="tab" :tabindex="c.state.whitelistTab === tab ? 0 : -1" :aria-selected="c.state.whitelistTab === tab" :aria-controls="`whitelist-${tab}`" @click="c.navigate('whitelist/' + tab)" @keydown.left.prevent="changeTab(tab === 'groups' ? 'private' : 'groups')" @keydown.right.prevent="changeTab(tab === 'groups' ? 'private' : 'groups')" @keydown.home.prevent="changeTab('groups')" @keydown.end.prevent="changeTab('private')">{{ tab === 'groups' ? '群聊白名单' : '私聊白名单' }}<span>{{ tab === 'groups' ? c.state.config.allowedGroups?.length || 0 : c.state.config.allowedPrivateUsers?.length || 0 }}</span></button></div>
    <div :id="`whitelist-${c.state.whitelistTab}`" role="tabpanel" :aria-labelledby="`whitelist-tab-${c.state.whitelistTab}`"><GroupsPanel v-if="c.state.whitelistTab === 'groups'" embedded /><PrivatePanel v-else embedded /></div>
  </section>
</template>
<style scoped>
.whitelist-tabs { display:flex; gap:10px; margin-bottom:26px; padding:6px; background:var(--soft); border:1px solid var(--line); border-radius:12px; width:fit-content; max-width:100%; }.whitelist-tabs button { display:flex; align-items:center; gap:12px; border:0; border-radius:8px; padding:12px 18px; min-height:44px; background:transparent; color:var(--muted); font-size:13px; }.whitelist-tabs button[aria-selected=true] { background:white; color:var(--green); box-shadow:0 2px 8px #2143320a; }.whitelist-tabs span { font-size:11px; background:var(--soft); padding:3px 7px; border-radius:6px; }
@media(max-width:650px) { .whitelist-tabs { width:100%; gap:4px; }.whitelist-tabs button { justify-content:center; flex:1; padding:10px 8px; gap:6px; font-size:12px; } }
</style>

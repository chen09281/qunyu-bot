<script setup>
import { computed, inject } from 'vue';
import { consoleKey } from '../composables/useConsole';
import StickySaveBar from './StickySaveBar.vue';
const c = inject(consoleKey);
defineProps({ embedded: Boolean });
const privateChanges = computed(() => {
  const saved = new Set(c.state.config.allowedPrivateUsers || []), draft = new Set(c.state.privateUsers);
  const added = [...draft].filter(id => !saved.has(id)).length, removed = [...saved].filter(id => !draft.has(id)).length;
  return { added, removed, total: added + removed };
});
const changed = computed(() => privateChanges.value.total > 0);
const changeSummary = computed(() => [privateChanges.value.added ? `新增 ${privateChanges.value.added} 个账号` : '', privateChanges.value.removed ? `移除 ${privateChanges.value.removed} 个账号` : ''].filter(Boolean).join('、'));
</script>

<template>
  <section id="page-private" class="page">
    <div v-if="!embedded" class="page-heading"><div><span class="eyebrow">A CONVERSATION JUST FOR YOU</span><h1>为私聊留一扇门<span class="title-dot">.</span></h1><p class="muted">单独授权可以私聊调用 DS 的 QQ 号。白名单成员直接发消息即可，无需 @。</p></div></div>
    <div class="private-summary card"><div><span class="eyebrow">已授权账号</span><strong>{{ c.state.privateUsers.length }}<small>/ 500</small></strong></div><p>名单为空时，私聊不会调用模型。<br>群聊白名单和签到绑定等私聊指令使用各自的权限规则。</p></div>
    <form class="card panel private-add" @submit.prevent="c.addPrivateUser()">
      <div class="panel-heading"><h2>添加私聊账号</h2><span class="subtle-tag">QQ 白名单</span></div>
      <div class="private-add-row"><label for="private-user-id">QQ 号<input id="private-user-id" v-model="c.state.privateDraft" name="privateUser" inputmode="numeric" pattern="[0-9]{5,20}" maxlength="20" placeholder="输入允许调用 DS 的 QQ 号" required></label><button type="submit" class="primary">添加到名单</button></div>
      <p class="muted">添加或移除后，请点击下方“保存私聊白名单”。</p>
    </form>
    <article class="card panel private-list">
      <div class="panel-heading"><h2>私聊白名单</h2><span class="subtle-tag">{{ changed ? '有未保存修改' : '已保存' }}</span></div>
      <p v-if="!c.state.privateUsers.length" class="empty">尚未添加账号，所有普通私聊保持静默。</p>
      <div v-for="user in c.state.privateUsers" :key="user" class="private-user"><span><small>QQ</small><code>{{ user }}</code></span><span class="private-permission">可调用 DS</span><button type="button" class="text-button danger" :aria-label="`移除 QQ ${user}`" @click="c.removePrivateUser(user)">移除</button></div>
      <p class="private-note">白名单私聊沿用模型、识图、文档、冷却和上下文设置。移除后，排队任务会取消，生成中的结果不会继续发送。私聊记录与群聊、其他账号独立。</p>
      <StickySaveBar :dirty-count="privateChanges.total" :dirty-text="changeSummary"><button type="button" class="primary" :disabled="c.state.busy.privateUsers || !changed" @click="c.savePrivateUsers()">保存私聊白名单</button></StickySaveBar>
    </article>
  </section>
</template>

<style scoped>
.private-summary { display: flex; align-items: center; gap: 50px; padding: 28px 32px; }
.private-summary strong { display: block; font-size: 38px; font-weight: 550; color: var(--green); line-height: 1.3; margin-top: 10px; }
.private-summary strong small { font-size: 12px; color: var(--muted); font-weight: 400; margin-left: 10px; }
.private-summary p { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.9; }
.private-add,.private-list { margin-top: 24px; }
.private-add-row { display: flex; align-items: flex-end; gap: 20px; margin-top: 24px; }
.private-add-row label { flex: 1; max-width: 480px; }
.private-add-row button { margin-bottom: 0; min-height: 43px; white-space: nowrap; }
.private-add > p { font-size: 11px; margin-top: 17px; }
.private-user { display: flex; align-items: center; gap: 24px; border-bottom: 1px solid var(--line); padding: 20px 0; }
.private-user > span:first-child { display: flex; align-items: center; gap: 12px; flex: 1; }
.private-user small { color: var(--muted); font-size: 11px; }.private-user code { font-size: 14px; color: var(--ink); }
.private-permission { color: var(--green); font-size: 11px; }.private-note { font-size: 11px; color: var(--muted); line-height: 1.9; margin: 24px 0; }
@media (max-width:650px) {
  .private-summary { padding: 24px; gap: 18px; flex-wrap: wrap; }.private-summary p { font-size: 12px; }
  .private-add-row { display: block; }.private-add-row label { max-width: none; }.private-add-row input { font-size: 16px; }.private-add-row button { margin-top: 15px; width: 100%; }
  .private-user { gap: 14px; }.private-user code { font-size: 14px; overflow-wrap: anywhere; }.private-user > span:first-child { min-width: 0; }.private-permission { font-size: 10px; }
  .private-user > button { min-height: 44px; }.save-bar { flex-wrap: wrap; gap: 15px; }
  .save-bar > button { flex: none; width: 100%; min-height: 44px; }
}
</style>

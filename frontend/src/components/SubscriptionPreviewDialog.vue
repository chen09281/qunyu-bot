<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue';
defineProps({ preview: { type: Object, required: true } });
const emit = defineEmits(['close']), dialog = ref(null);
let trigger;
onMounted(() => { trigger = document.activeElement; dialog.value.showModal(); });
onBeforeUnmount(() => { dialog.value?.close(); if (trigger?.isConnected) trigger.focus(); });
function backdrop(event) {
  if (event.target !== dialog.value) return;
  const box = dialog.value.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) emit('close');
}
</script>
<template>
  <Teleport to="body"><dialog ref="dialog" class="subscription-preview-dialog" aria-labelledby="subscription-preview-title" @cancel.prevent="emit('close')" @click="backdrop">
    <header><div><h2 id="subscription-preview-title">{{ preview.title }} · 推送预览</h2><p>展示最新一条的卡片，不发送群消息，不修改推送记录。</p></div><button class="secondary" type="button" autofocus aria-label="关闭订阅预览" @click="emit('close')">关闭 ✕</button></header>
    <div class="preview-body" aria-live="polite">
      <p v-if="preview.loading" role="status">正在读取来源并生成卡片，请稍候…</p>
      <p v-if="preview.error" class="error-text" role="alert">{{ preview.error }}</p>
      <p v-for="warning in preview.warnings" :key="warning" class="preview-warning">{{ warning }}</p>
      <img v-if="preview.card" :src="preview.card" alt="最新订阅内容的实际推送卡片">
      <p v-if="preview.text" class="preview-copy">{{ preview.text }}</p>
      <p v-if="!preview.loading && !preview.error && !preview.items.length">来源有效，暂时没有内容。</p>
      <a v-if="preview.items[0]" :href="preview.items[0].link" target="_blank" rel="noopener noreferrer">打开最新内容 ↗</a>
      <details v-if="preview.items.length > 1"><summary>其他近期内容（{{ preview.items.length - 1 }} 条）</summary><p v-for="item in preview.items.slice(1)" :key="item.id"><a :href="item.link" target="_blank" rel="noopener noreferrer">{{ item.title }}</a></p></details>
    </div>
  </dialog></Teleport>
</template>
<style scoped>
.subscription-preview-dialog { width:min(660px,calc(100vw - 32px)); max-height:calc(100dvh - 40px); padding:0; border:1px solid var(--line); border-radius:18px; background:var(--bg); color:var(--ink); overflow:auto; overscroll-behavior:contain; box-shadow:0 24px 80px #17382744; }.subscription-preview-dialog::backdrop { background:#172b396e; }.subscription-preview-dialog header { position:sticky; top:0; display:flex; align-items:start; justify-content:space-between; gap:18px; padding:20px 24px; background:var(--bg); border-bottom:1px solid var(--line); z-index:1; }.subscription-preview-dialog h2 { margin:0; font-size:18px; overflow-wrap:anywhere; }.subscription-preview-dialog header p { font-size:12px; color:var(--muted); line-height:1.8; margin:8px 0 0; }.subscription-preview-dialog header button { flex-shrink:0; }.preview-body { padding:22px 24px; font-size:13px; line-height:1.9; overflow-wrap:anywhere; }.preview-body img { display:block; width:100%; height:auto; border-radius:12px; background:white; }.preview-copy { white-space:pre-wrap; }.preview-warning { padding:12px; background:#fbf4e8; color:#91652e; border-radius:8px; }.preview-body a { color:var(--green); }.preview-body details { margin-top:20px; border-top:1px solid var(--line); padding-top:14px; }.preview-body summary { cursor:pointer; }
@media(max-width:650px) { .subscription-preview-dialog { width:calc(100vw - 16px); }.subscription-preview-dialog header,.preview-body { padding:18px 16px; } }
</style>

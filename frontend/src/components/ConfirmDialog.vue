<script setup>
import { inject, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { consoleKey } from '../composables/useConsole';
const c = inject(consoleKey), dialog = ref(null), confirmButton = ref(null);
let trigger;
onMounted(async () => {
  trigger = document.activeElement;
  dialog.value.showModal();
  await nextTick(); confirmButton.value?.focus();
});
onBeforeUnmount(() => { dialog.value?.close(); if (trigger?.isConnected) trigger.focus(); });
function backdrop(event) {
  if (event.target === dialog.value) c.resolveConfirmation(false);
}
</script>

<template>
  <Teleport to="body"><dialog ref="dialog" class="confirm-dialog" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" @cancel.prevent="c.resolveConfirmation(false)" @click="backdrop">
    <h2 id="confirm-dialog-title">{{ c.state.confirmation.title }}</h2>
    <p id="confirm-dialog-description">{{ c.state.confirmation.description }}</p>
    <p v-if="c.state.confirmation.detail" class="confirm-detail">{{ c.state.confirmation.detail }}</p>
    <div class="confirm-actions"><button type="button" class="secondary" @click="c.resolveConfirmation(false)">取消</button><button ref="confirmButton" type="button" class="primary" :class="{ 'danger-primary': c.state.confirmation.tone === 'danger' }" @click="c.resolveConfirmation(true)">{{ c.state.confirmation.confirmText || '确认' }}</button></div>
  </dialog></Teleport>
</template>

<style scoped>
.confirm-dialog { width:min(460px,calc(100vw - 32px)); padding:26px; border:1px solid var(--line); border-radius:18px; background:var(--surface); color:var(--ink); }
.confirm-dialog h2 { margin:0 0 14px; font-size:19px; }.confirm-dialog p { line-height:1.8; color:var(--muted); font-size:13px; white-space:pre-line; }.confirm-detail { padding:12px 14px; border-radius:10px; background:var(--soft); }
.confirm-actions { display:flex; justify-content:flex-end; gap:12px; margin-top:24px; }.danger-primary { background:var(--red); border-color:var(--red); }
@media(max-width:650px) { .confirm-dialog { padding:22px 18px; }.confirm-actions button { flex:1; } }
</style>

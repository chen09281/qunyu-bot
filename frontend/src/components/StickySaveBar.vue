<script setup>
defineProps({
  dirtyCount: { type: Number, default: 0 },
  dirtyText: { type: String, default: '' },
  savedText: { type: String, default: '设置已保存' },
  effect: { type: String, default: '保存后生效' },
});
</script>

<template>
  <div class="save-bar sticky-save-bar"><span class="muted"><b v-if="dirtyCount" class="draft-marker">{{ dirtyText || `有 ${dirtyCount} 项未保存修改` }}</b><template v-else>{{ savedText }}</template> · {{ effect }}</span><div class="save-actions"><slot /></div></div>
</template>

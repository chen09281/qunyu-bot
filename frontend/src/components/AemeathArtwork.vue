<script setup>
import { ref } from 'vue';
import aemeathUrl from '../assets/aemeath.png';
const unavailable = ref(false);
</script>

<template>
  <div class="aemeath-artwork" aria-hidden="true">
    <span class="starlight-halo"></span><span class="starlight-orbit"></span>
    <svg class="starlight-mark" viewBox="0 0 32 32" fill="none" focusable="false"><path d="m16 2 3.5 10.5L30 16l-10.5 3.5L16 30l-3.5-10.5L2 16l10.5-3.5Z" fill="currentColor"/><path d="m16 8 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" fill="#fff" /></svg>
    <img v-if="!unavailable" :src="aemeathUrl" alt="" width="600" height="595" decoding="async" draggable="false" @error="unavailable = true">
    <span v-else class="starlight-fallback">✦</span>
    <span class="starlight-fragment one"></span><span class="starlight-fragment two"></span>
  </div>
</template>

<style scoped>
.aemeath-artwork { position:relative; width:280px; height:260px; isolation:isolate; pointer-events:none; flex-shrink:0; }
.starlight-halo { position:absolute; inset:22px 8px 12px 25px; border-radius:50%; background:radial-gradient(ellipse at 45% 35%,#f5d6e9c9 0%,#e2ddf87a 48%,#e3f3fb00 73%); }
.starlight-orbit { position:absolute; inset:38px 5px 24px 18px; border:1px solid #b4bce27a; border-radius:50%; transform:rotate(-27deg) scaleY(.7); }
.aemeath-artwork img { position:absolute; z-index:1; left:-12px; top:-18px; width:290px; height:auto; max-width:none; filter:drop-shadow(0 10px 12px #697cbb20); }
.starlight-mark { position:absolute; z-index:2; right:7px; top:38px; width:22px; height:22px; color:#b89bd4; }
.starlight-fragment { position:absolute; width:6px; height:6px; border:1px solid #91cddc; transform:rotate(45deg); }.starlight-fragment.one { left:25px; top:88px; }.starlight-fragment.two { right:22px; bottom:28px; width:4px; height:4px; border-color:#c9a3c9; }
.starlight-fallback { position:absolute; inset:0; display:grid; place-items:center; color:#ad94ca; font-size:110px; }
</style>

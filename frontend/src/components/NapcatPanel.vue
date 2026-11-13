<script setup>
import { computed, inject, ref, watch } from 'vue';
import QRCode from 'qrcode';
import { consoleKey, timeText } from '../composables/useConsole';

const c = inject(consoleKey);
const qrImage = ref('');
const imageError = ref('');
const online = computed(() => c.state.napcat?.qq?.state === 'online');
let version = 0;
watch(() => c.state.qrcode?.url, async url => {
  const current = ++version; qrImage.value = ''; imageError.value = '';
  if (!url) return;
  try {
    const image = await QRCode.toDataURL(url, { width: 256, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#20352e', light: '#ffffff' } });
    if (current === version) qrImage.value = image;
  } catch { if (current === version) imageError.value = '二维码渲染失败，请刷新二维码重试'; }
});
</script>

<template>
  <article class="card panel napcat-panel">
    <div class="panel-heading"><div><h2>NapCat · QQ 登录</h2><p class="muted napcat-subtitle">直接在这里扫码登录，账号状态每 5 秒自动检查。</p></div><button class="secondary" :disabled="c.state.busy.napcatRefresh" @click="c.refreshNapcat">{{ c.state.busy.napcatRefresh ? '检查中…' : '↻ 检查状态' }}</button></div>
    <div class="napcat-layout">
      <div class="napcat-account">
        <div class="account-line"><span class="account-avatar">{{ (c.state.napcat?.account?.nickname || 'Q').slice(0, 1) }}</span><div><span class="pill" :class="{ on: online }">{{ c.state.napcat?.qq?.label || '正在检查状态…' }}</span><h3>{{ c.state.napcat?.account?.nickname || (online ? 'QQ 账号已登录' : '连接你的 QQ 账号') }}</h3><p class="muted">{{ c.state.napcat?.account?.userId ? `QQ ${c.state.napcat.account.userId}` : '扫码成功后显示 QQ 号和昵称' }}</p></div></div>
        <p class="napcat-detail">{{ c.state.napcat?.qq?.detail || '正在检查 NapCat 管理接口和 OneBot 连接…' }}</p>
        <div class="napcat-services"><div><span>NapCat 管理接口</span><b :class="{ ready: c.state.napcat?.webui?.authenticated }">{{ c.state.napcat?.webui?.authenticated ? '已连接' : c.state.napcat?.webui?.requires2FA ? '需要二次验证' : c.state.napcat?.webui?.configured ? '连接异常' : '未配置 Token' }}</b></div><div><span>OneBot 消息接口</span><b :class="{ ready: c.state.napcat?.onebot?.reachable }">{{ c.state.napcat?.onebot?.reachable ? '已连接' : '未连接' }}</b></div></div>
        <p v-if="c.state.napcat?.webui?.error" class="napcat-warning">{{ c.state.napcat.webui.error }}</p>
        <p v-if="online && !c.state.napcat?.onebot?.reachable" class="napcat-warning">QQ 已登录，但消息接口未连接。请核对下方 OneBot 地址与 Token。</p>
        <form v-if="c.state.napcat?.webui?.requires2FA" class="napcat-2fa" @submit.prevent="c.connectNapcat"><label>NapCat 动态验证码<input v-model="c.state.totpCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="6 位验证码"></label><button class="primary" type="submit" :disabled="c.state.busy.napcatConnect">验证并连接</button></form>
        <small class="napcat-checked">{{ c.state.napcat?.checkedAt ? `最近检查：${timeText(c.state.napcat.checkedAt)}` : '正在等待检测结果' }} · 扫码确认后自动更新</small>
      </div>
      <div class="napcat-login">
        <div v-if="online" class="qr-placeholder qr-success"><span>✓</span><b>QQ 已在线</b><small>可以在群里 @ 机器人了</small></div>
        <template v-else><div class="qr-frame"><img v-if="qrImage" :src="qrImage" alt="QQ 登录二维码" width="224" height="224"><div v-else class="qr-placeholder"><span>⌗</span><b>{{ c.state.busy.qrcode ? '正在获取二维码…' : '手机 QQ 扫码登录' }}</b><small>{{ c.state.config.napcatTokenConfigured ? '点击下方按钮获取登录二维码' : '先保存下方 NapCat 管理连接' }}</small></div></div><p class="qr-caption">使用手机 QQ 扫码，并在手机上确认登录。</p><div class="qr-actions"><button class="primary" :disabled="c.state.busy.qrcode || !c.state.config.napcatTokenConfigured" @click="c.getQrcode(false)">{{ c.state.busy.qrcode ? '获取中…' : '获取二维码' }}</button><button class="secondary" :disabled="c.state.busy.qrcode || !c.state.config.napcatTokenConfigured" @click="c.getQrcode(true)">刷新二维码</button></div></template>
        <p v-if="c.state.qrError || imageError" class="error-text" role="alert">{{ c.state.qrError || imageError }}</p>
      </div>
    </div>
  </article>
</template>

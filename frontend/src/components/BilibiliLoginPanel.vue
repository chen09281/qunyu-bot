<script setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue';
import QRCode from 'qrcode';
import { consoleKey } from '../composables/useConsole';
const c = inject(consoleKey), image = ref(''), imageError = ref(''), automatic = ref(true);
const status = computed(() => c.state.bilibili), qr = computed(() => c.state.bilibiliQr);
const labels = { waiting_scan: '请用哔哩哔哩 App 扫码', scanned: '已扫码，请在 App 确认登录', expired: '二维码已过期，请重新获取', success: '扫码成功，登录态已保存' };
const dateText = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
let timer, disposed = false, renderVersion = 0;
function schedule() {
  clearTimeout(timer);
  if (disposed || !['waiting_scan', 'scanned'].includes(qr.value?.state)) return;
  timer = setTimeout(async () => { await c.bilibiliRequest('poll'); schedule(); }, 3000);
}
watch(qr, schedule);
watch(() => status.value?.autoRefresh, value => automatic.value = value !== false, { immediate: true });
watch(() => qr.value?.url, async url => {
  const version = ++renderVersion; image.value = ''; imageError.value = '';
  if (!url) return;
  try {
    const data = await QRCode.toDataURL(url, { width: 256, margin: 2, errorCorrectionLevel: 'M' });
    if (!disposed && version === renderVersion) image.value = data;
  } catch { if (!disposed && version === renderVersion) imageError.value = '二维码显示失败，请重新获取。'; }
}, { immediate: true });
async function configure() {
  await c.bilibiliRequest('settings', { autoRefresh: automatic.value });
  automatic.value = status.value?.autoRefresh !== false;
}
onMounted(() => { void c.bilibiliRequest(); schedule(); });
onUnmounted(() => { disposed = true; renderVersion++; clearTimeout(timer); });
</script>

<template>
  <section class="bili-login" aria-label="哔哩哔哩扫码登录与自动续期">
    <div class="bili-heading"><div><h3>B 站扫码登录 · 自动续期</h3><p>用哔哩哔哩 App 扫码并确认，登录态直接保存在运行机器人的服务器。</p></div><span class="pill" :class="{ on: ['valid', 'refreshed'].includes(status?.state) }">{{ status?.label || '正在读取…' }}</span></div>
    <p class="bili-detail" role="status">{{ status?.detail || '扫码登录会同时保存刷新令牌，无需反复从浏览器复制 Cookie。' }}</p>
    <label class="bili-auto"><input v-model="automatic" type="checkbox" :disabled="!status || c.state.busy.bilibili" @change="configure"><span>自动检查并续期<small>每 6 小时检查，仅在 B 站要求时更新；关闭后台网页后仍由服务器执行。</small></span></label>
    <dl class="bili-times"><div><dt>上次检查</dt><dd>{{ dateText(status?.lastCheckedAt) }}</dd></div><div><dt>上次登录 / 续期</dt><dd>{{ dateText(status?.lastRefreshedAt) }}</dd></div><div><dt>下次检查</dt><dd>{{ status?.autoRefresh === false ? '自动检查已关闭' : dateText(status?.nextCheckAt) }}</dd></div></dl>
    <p v-if="status?.configured && !status?.refreshCapable" class="bili-note">当前只保存了手动导入的 Cookie。请扫码一次，才能取得此登录会话对应的刷新令牌。</p>
    <div v-if="qr && qr.state !== 'none'" class="bili-qr">
      <img v-if="image && ['waiting_scan', 'scanned'].includes(qr.state)" :src="image" width="256" height="256" alt="用哔哩哔哩 App 扫描此二维码登录服务器">
      <p>{{ labels[qr.state] || '请重新获取二维码' }}</p><small v-if="['waiting_scan', 'scanned'].includes(qr.state)">二维码有效期约 3 分钟；请确认 App 中显示的登录设备。</small>
    </div>
    <p v-if="c.state.bilibiliError || imageError" class="error-text" role="alert">{{ c.state.bilibiliError || imageError }}</p>
    <div class="bili-actions"><button class="secondary" type="button" :disabled="c.state.busy.bilibili" @click="c.bilibiliRequest('qrcode')">{{ qr && qr.state !== 'success' ? '重新获取二维码' : '扫码登录 B 站' }}</button><button class="secondary" type="button" :disabled="c.state.busy.bilibili || !status?.configured" @click="c.bilibiliRequest('check')">立即检查 / 续期</button></div>
    <p class="bili-note">被平台强制下线、刷新令牌失效或遇到安全验证时，需要重新扫码。手动保存或清除下方 Cookie 会解除当前扫码登录的自动续期关联。</p>
  </section>
</template>

<style scoped>
.bili-login { margin: 22px 0; padding: 22px; border: 1px solid #dbe8da; border-radius: 12px; background: #f6faf3; }
.bili-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.bili-heading h3 { font-size: 15px; margin: 0 0 10px; color: var(--green); }.bili-heading p { font-size: 12px; color: var(--muted); margin: 0; }
.bili-detail { font-size: 12px; margin: 16px 0; overflow-wrap: anywhere; }
.form-panel .bili-auto { display: flex; gap: 10px; align-items: flex-start; min-height: 44px; font-size: 13px; }
.bili-auto input { width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--green); flex-shrink: 0; }
.bili-times { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }.bili-times dt { font-size: 10px; color: var(--muted); }.bili-times dd { font-size: 12px; margin: 7px 0 0; overflow-wrap: anywhere; }
.bili-qr { padding: 20px 0; text-align: center; }.bili-qr img { display: block; width: min(256px, 100%); height: auto; margin: 0 auto 16px; border-radius: 10px; }.bili-qr p { font-size: 13px; margin-bottom: 8px; }
.bili-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }.bili-note { font-size: 11px; color: var(--muted); margin: 18px 0 0; }
@media(max-width:650px) { .bili-login { padding: 18px 14px; }.bili-times { grid-template-columns: minmax(0, 1fr); gap: 14px; }.bili-times dt { font-size: 11px; }.bili-actions button { flex: 1 1 150px; }.bili-note { font-size: 12px; } }
</style>

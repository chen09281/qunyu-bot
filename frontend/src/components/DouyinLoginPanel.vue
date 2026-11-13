<script setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue';
import { consoleKey } from '../composables/useConsole';
const c = inject(consoleKey), automatic = ref(true), code = ref(''), dragMode = ref(false);
const status = computed(() => c.state.douyin), qr = computed(() => c.state.douyinQr);
const pending = computed(() => ['waiting_scan', 'scanned', 'confirming', 'verification_required'].includes(qr.value?.state));
const labels = { waiting_scan: '请用抖音 App 扫码', scanned: '已扫码，请在抖音 App 确认登录', confirming: '手机已确认，正在验证登录并保存 Cookie…', verification_required: '抖音要求额外身份验证', expired: '二维码已过期，请重新获取', success: '登录成功，Cookie 已自动保存' };
const dateText = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
let timer, viewTimer, disposed = false, gesture;
function schedule() {
  clearTimeout(timer); if (disposed || !pending.value) return;
  timer = setTimeout(async () => { await c.douyinRequest('poll'); schedule(); }, 3000);
}
watch(qr, schedule);
function refreshView() {
  clearTimeout(viewTimer);
  if (disposed || qr.value?.state !== 'verification_required') return;
  if (gesture) { viewTimer = setTimeout(refreshView, 2000); return; }
  void c.douyinVerificationRequest().finally(() => { if (!disposed && qr.value?.state === 'verification_required') viewTimer = setTimeout(refreshView, 2500); });
}
watch(() => qr.value?.state, state => {
  code.value = ''; gesture = null; clearTimeout(viewTimer);
  if (state === 'verification_required') refreshView();
  else { c.state.douyinVerification = null; c.state.douyinVerificationError = ''; c.state.douyinVerificationNotice = ''; }
});
function coordinates(event) {
  const rect = event.currentTarget.getBoundingClientRect(), view = c.state.douyinVerification;
  return { x: Math.max(0, Math.min(view.width - 1, (event.clientX - rect.left) * view.width / rect.width)),
    y: Math.max(0, Math.min(view.height - 1, (event.clientY - rect.top) * view.height / rect.height)) };
}
async function interact(input) {
  clearTimeout(viewTimer);
  await c.douyinVerificationRequest(input); await c.douyinRequest('poll');
  if (!disposed) viewTimer = setTimeout(refreshView, 500);
}
function clickView(event) { if (!dragMode.value && !c.state.busy.douyinVerification) void interact({ type: 'click', ...coordinates(event) }); }
function pointerDown(event) { if (dragMode.value && !c.state.busy.douyinVerification) { event.preventDefault(); gesture = coordinates(event); event.currentTarget.setPointerCapture(event.pointerId); } }
function pointerUp(event) { if (!gesture) return; const from = gesture; gesture = null; void interact({ type: 'drag', from, to: coordinates(event) }); }
function pointerCancel() { gesture = null; }
function centerView(event) {
  const image = event.currentTarget, box = image.parentElement;
  if (!box.dataset.centered) { box.scrollLeft = Math.max(0, (image.clientWidth - box.clientWidth) / 2); box.scrollTop = Math.max(0, (image.clientHeight - box.clientHeight) / 2); box.dataset.centered = '1'; }
}
async function sendCode() { const value = code.value.trim(); code.value = ''; await interact({ type: 'code', code: value }); }
watch(() => status.value?.autoCheck, value => automatic.value = value !== false, { immediate: true });
async function configure() { await c.douyinRequest('settings', { autoCheck: automatic.value }); automatic.value = status.value?.autoCheck !== false; }
onMounted(() => { void c.douyinRequest(); schedule(); if (qr.value?.state === 'verification_required') refreshView(); });
onUnmounted(() => { disposed = true; code.value = ''; gesture = null; clearTimeout(timer); clearTimeout(viewTimer); c.state.douyinVerification = null; c.state.douyinVerificationError = ''; c.state.douyinVerificationNotice = ''; });
</script>

<template>
  <section class="douyin-login" aria-label="抖音扫码登录与 Cookie 自动配置">
    <div class="heading"><div><h3>抖音扫码登录 · 自动保存 Cookie</h3><p>通过抖音官方创作者中心登录；用抖音 App 扫码并确认，登录态保存在机器人服务器。</p></div><span class="pill" :class="{ on: status?.state === 'valid' }">{{ status?.label || '正在读取…' }}</span></div>
    <p class="detail" role="status">{{ status?.detail || '无需复制浏览器 Cookie。首次出码可能需要约半分钟；手机确认后，服务器会继续核对并自动保存登录态。' }}</p>
    <p v-if="status && !status.browserAvailable" class="error-text">当前机器缺少扫码浏览器。Docker 请重新构建镜像；本机可安装 Chrome，或设置 DOUYIN_CHROMIUM 为浏览器可执行文件路径。</p>
    <label class="automatic"><input v-model="automatic" type="checkbox" :disabled="!status || c.state.busy.douyin" @change="configure"><span>每 6 小时自动检查并同步 Cookie<small>服务器会保存平台在有效登录中更新的 Cookie；平台要求验证或重新登录时，仍需再次扫码。</small></span></label>
    <dl><div><dt>上次检查</dt><dd>{{ dateText(status?.lastCheckedAt) }}</dd></div><div><dt>上次保存</dt><dd>{{ dateText(status?.lastSavedAt) }}</dd></div><div><dt>下次检查</dt><dd>{{ status?.autoCheck === false ? '自动检查已关闭' : dateText(status?.nextCheckAt) }}</dd></div></dl>
    <div v-if="qr && qr.state !== 'none'" class="qr">
      <img v-if="['waiting_scan', 'scanned'].includes(qr.state) && qr.image" :src="qr.image" width="256" height="256" alt="用抖音 App 扫描此二维码登录服务器">
      <p role="status">{{ labels[qr.state] || '正在同步登录状态，请点击立即检查' }}</p>
      <p v-if="qr.detail" class="detail" role="alert">{{ qr.detail }}</p>
      <small v-if="['waiting_scan', 'scanned'].includes(qr.state)">到期时间：{{ dateText(qr.expiresAt) }}。请核对 App 中的登录设备。</small>
      <small v-else-if="qr.state === 'confirming'">服务器正在核对官方登录结果，通常需要几秒；请勿重复扫码。</small>
    </div>
    <section v-if="qr?.state === 'verification_required'" class="verification" aria-label="抖音官方身份验证画面">
      <h4>完成官方身份验证</h4>
      <p>先选择「接收短信验证码」。官方可能直接发送短信，收到后可直接填写并提交；未收到时等待倒计时结束再重发。下方为官方页面，可滚动查看并点击；需要手动拖动时开启「拖动操作」。</p>
      <p v-if="c.state.douyinVerificationError" class="error-text" role="alert">{{ c.state.douyinVerificationError }}</p>
      <p v-if="c.state.douyinVerificationNotice" role="status" class="detail">{{ c.state.douyinVerificationNotice }}</p>
      <div class="actions">
        <button type="button" class="secondary" :disabled="c.state.busy.douyinVerification" @click="interact({ type: 'sms-method' })">① 选择接收短信验证</button>
        <button type="button" class="secondary" :disabled="c.state.busy.douyinVerification" @click="interact({ type: 'sms' })">② 获取 / 重发短信（按需）</button>
        <button type="button" class="secondary" :disabled="c.state.busy.douyinVerification" @click="refreshView">刷新验证画面</button>
        <label class="drag-mode"><input v-model="dragMode" type="checkbox">拖动操作</label>
      </div>
      <div class="verification-code"><label>在这里填写手机收到的短信验证码<input v-model="code" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="4–8 位数字" :disabled="c.state.busy.douyinVerification" @keydown.enter.prevent="sendCode"></label>
        <button type="button" class="secondary" :disabled="c.state.busy.douyinVerification || !/^\d{4,8}$/.test(code)" @click="sendCode">③ 填写到官方页面</button>
        <button type="button" class="secondary" :disabled="c.state.busy.douyinVerification" @click="interact({ type: 'submit' })">④ 提交验证</button></div>
      <div v-if="c.state.douyinVerification?.image" class="verification-screen">
        <img :src="c.state.douyinVerification.image" :width="c.state.douyinVerification.width" :height="c.state.douyinVerification.height" :style="{ touchAction: dragMode ? 'none' : 'auto' }" draggable="false" alt="当前抖音官方验证页；可点击按钮、填写验证码并提交" @load="centerView" @click="clickView" @pointerdown="pointerDown" @pointerup="pointerUp" @pointercancel="pointerCancel">
      </div>
      <p v-else role="status">正在读取验证画面…</p>
      <p class="note">验证码仅送入本次官方验证页面，发送后立即清空，不写入日志或配置。验证成功会自动保存 Cookie；需人脸验证或当前方式无法完成时，可改用 App 提示的方式或手动导入 Cookie。</p>
    </section>
    <p v-if="c.state.douyinError" class="error-text" role="alert">{{ c.state.douyinError }}</p>
    <div class="actions">
      <button class="secondary" type="button" :disabled="c.state.busy.douyin || !status?.browserAvailable" @click="c.douyinRequest('qrcode')">{{ c.state.busy.douyin ? '处理中…' : pending ? '重新获取二维码' : '扫码登录抖音' }}</button>
      <button v-if="pending" class="secondary" type="button" :disabled="c.state.busy.douyin" @click="c.douyinRequest('cancel')">取消扫码</button>
      <button v-if="pending" class="secondary" type="button" :disabled="c.state.busy.douyin" @click="c.douyinRequest('poll')">我已确认，立即检查</button>
      <button class="secondary" type="button" :disabled="c.state.busy.douyin || pending || !status?.configured || !status?.browserAvailable" @click="c.douyinRequest('check')">立即检查 / 同步</button>
    </div>
    <p class="note">抖音与 B 站分别登录，不能共用刷新令牌。安全验证、登录失效或服务器网络限制可能中断扫码；可使用下方手动导入。手动替换或清除 Cookie 会取消未完成的扫码。</p>
  </section>
</template>

<style scoped>
.douyin-login { margin: 22px 0; padding: 22px; border: 1px solid #dbe8da; border-radius: 12px; background: #f6faf3; }
.heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }.heading h3 { font-size: 15px; margin: 0 0 10px; color: var(--green); }.heading p,.detail { font-size: 12px; }.heading p { color: var(--muted); margin: 0; }.detail { margin: 16px 0; overflow-wrap: anywhere; }
.form-panel .automatic { display: flex; gap: 10px; align-items: flex-start; min-height: 44px; font-size: 13px; }.automatic input { width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--green); flex-shrink: 0; }
dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }dt { font-size: 10px; color: var(--muted); }dd { font-size: 12px; margin: 7px 0 0; overflow-wrap: anywhere; }
.qr { padding: 20px 0; text-align: center; }.qr img { display: block; width: min(256px,100%); height: auto; margin: 0 auto 16px; border-radius: 10px; }.qr p { font-size: 13px; margin-bottom: 8px; }.actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }.note { font-size: 11px; color: var(--muted); margin: 18px 0 0; }
.verification { margin-top: 20px; padding: 16px; border: 1px solid var(--line); border-radius: 12px; background: white; }.verification h4 { margin: 0 0 12px; color: var(--green); }.verification>p { font-size: 12px; }.verification-screen { overflow: auto; max-height: 460px; border: 1px solid var(--line); border-radius: 8px; background: #f3f4f5; overscroll-behavior: contain; }.verification-screen img { display: block; max-width: none; cursor: pointer; }.form-panel .drag-mode { display: flex; align-items: center; gap: 8px; font-size: 12px; }.drag-mode input { width: 18px; height: 18px; accent-color: var(--green); }.verification-code { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-top: 18px; }.verification-code label { flex: 1 1 160px; margin: 0; }.verification-code input { margin-top: 8px; }
@media(max-width:650px) { .douyin-login { padding: 18px 14px; }dl { grid-template-columns: minmax(0,1fr); gap: 14px; }dt { font-size: 11px; }.actions button { flex: 1 1 150px; }.note { font-size: 12px; } }
</style>

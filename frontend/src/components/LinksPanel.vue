<script setup>
import { computed, inject, onUnmounted, ref } from 'vue';
import { consoleKey } from '../composables/useConsole';
import CookieGuideDialog from './CookieGuideDialog.vue';
import BilibiliLoginPanel from './BilibiliLoginPanel.vue';
import DouyinLoginPanel from './DouyinLoginPanel.vue';
import StickySaveBar from './StickySaveBar.vue';
defineProps({ embedded: Boolean });
const c = inject(consoleKey);
const cookieGuideOpen = ref(false);
const selectedPlatform = computed(() => c.state.linkStatus?.platforms?.find(item => item.id === c.state.linkCookiePlatform));
const linkFields = ['linkParsingEnabled', 'linkTwitterProxyUrl', 'linkMaxVideoMB', 'linkMaxDuration', 'linkTimeoutSeconds', 'linkCooldownSeconds'];
const linkDirtyCount = computed(() => linkFields.filter(key => (c.state.linkSettings[key] ?? '') !== (c.state.config[key] ?? '')).length);
let importGeneration = 0;
function changePlatform() { importGeneration++; c.clearCookieDraft(); }
async function importCookies(event) {
  const file = event.target.files?.[0], generation = ++importGeneration, platform = c.state.linkCookiePlatform;
  event.target.value = '';
  if (!file) return;
  c.state.linkCookieError = '';
  if (file.size > 96 * 1024) { c.state.linkCookieError = '文件过大，请仅导出所选平台的 Cookie（最多 96 KiB）'; return; }
  try {
    const content = await file.text();
    if (generation === importGeneration && platform === c.state.linkCookiePlatform) c.state.linkCookieContent = content;
  } catch { if (generation === importGeneration) c.state.linkCookieError = '无法读取文件，请重新导入'; }
}
onUnmounted(() => { importGeneration++; c.clearCookieDraft(); });
</script>

<template>
  <section id="page-links" class="page">
    <div :class="embedded ? 'embedded-heading' : 'page-heading'"><div><template v-if="!embedded"><span class="eyebrow">SHARE IT, SEE IT</span><h1>让分享直接呈现<span class="title-dot">.</span></h1></template><p class="muted">识别社交平台链接，展示图文，把视频发回群里。无需 @，不调用 DeepSeek。</p></div><button class="secondary" :disabled="c.state.busy.linkStatus" @click="c.loadLinkStatus">{{ c.state.busy.linkStatus ? '检测中…' : '↻ 检查解析器' }}</button></div>
    <div class="link-stats"><article class="card"><span>成功解析</span><strong>{{ c.state.status.linksParsed || 0 }}</strong></article><article class="card"><span>已发送视频</span><strong>{{ c.state.status.videosSent || 0 }}</strong></article><article class="card"><span>解析或发送失败</span><strong>{{ c.state.status.linksFailed || 0 }}</strong></article></div>
    <form class="card panel form-panel" @submit.prevent="c.saveLinks">
      <div class="panel-heading"><h2>自动解析设置</h2><span class="subtle-tag">当前{{ c.state.config.linkParsingEnabled ? '已开启' : '已关闭' }}</span></div>
      <label>X / Twitter SOCKS5 代理<input v-model="c.state.linkSettings.linkTwitterProxyUrl" name="linkTwitterProxyUrl" type="text" maxlength="2048" placeholder="socks5://127.0.0.1:7890"><small>留空则直连；可填写 Mihomo 的 SOCKS5 地址，用于 X 推文和图片、视频下载。Docker 部署需填写容器可访问的代理地址。</small></label>
      <label class="link-toggle"><input v-model="c.state.linkSettings.linkParsingEnabled" type="checkbox" name="linkParsingEnabled"><span>自动解析群聊链接<small>机器人启用时生效，沿用「群聊白名单」中的授权。白名单留空时不解析任何群的链接；某个群关闭「解析视频」后，该群只发送标题、简介与图片。暂停机器人会同时暂停链接解析。</small></span></label>
      <div class="field-grid"><label>图片 / 视频最大大小 / MiB<input v-model.number="c.state.linkSettings.linkMaxVideoMB" type="number" name="linkMaxVideoMB" min="1" max="400" required><small>默认及上限均为 400 MiB，含视频音轨或整组图片；单张图片也使用此限额。已有配置保留原值，可修改后保存；超过限制会记入日志。</small></label><label>视频最长时长 / 秒<input v-model.number="c.state.linkSettings.linkMaxDuration" type="number" name="linkMaxDuration" min="10" max="1800" required><small>默认 480 秒，不下载直播。</small></label><label>解析与下载超时 / 秒<input v-model.number="c.state.linkSettings.linkTimeoutSeconds" type="number" name="linkTimeoutSeconds" min="30" max="600" required></label><label>同一用户解析间隔 / 秒<input v-model.number="c.state.linkSettings.linkCooldownSeconds" type="number" name="linkCooldownSeconds" min="0" max="3600" required></label></div>
      <div class="callout"><b>视频直接发送，多图合并为聊天记录</b><p>每条消息最多处理 3 个链接；同一群相同链接 10 分钟内去重。视频优先 720p，按音视频合计体积选择可容纳的清晰度；每组最多展示 9 张图片，超过时只取前 9 张，标题和图片合为一条聊天记录发送。发送完成后清理临时文件，失败原因可在运行日志查看。</p></div>
      <StickySaveBar :dirty-count="linkDirtyCount"><button class="primary" type="submit" :disabled="c.state.busy.links || !linkDirtyCount">{{ c.state.busy.links ? '保存中…' : '保存解析设置 ↗' }}</button></StickySaveBar>
    </form>
    <form class="card panel form-panel cookie-panel" autocomplete="off" @submit.prevent="c.saveLinkCookie">
      <div class="panel-heading"><h2>平台登录配置</h2><span class="subtle-tag">{{ selectedPlatform?.configured ? '已配置登录态' : '未配置登录态' }}</span></div>
      <p class="muted status-detail">为需要登录的平台配置 Cookie。先在该平台登录，再导入登录态；平台账号与管理后台账号分别使用。</p>
      <label>选择平台<select v-model="c.state.linkCookiePlatform" name="cookiePlatform" :disabled="c.state.busy.linkCookie || !c.state.linkStatus?.platforms?.length" @change="changePlatform"><option v-for="platform in c.state.linkStatus?.platforms || []" :key="platform.id" :value="platform.id">{{ platform.name }} · {{ platform.configured ? '已配置' : '未配置' }}</option></select><small v-if="selectedPlatform?.updatedAt">最近配置：{{ new Date(selectedPlatform.updatedAt).toLocaleString('zh-CN', { hour12: false }) }}。配置状态不代表 Cookie 仍有效。</small></label>
      <BilibiliLoginPanel v-if="c.state.linkCookiePlatform === 'bilibili'" />
      <DouyinLoginPanel v-if="c.state.linkCookiePlatform === 'douyin'" />
      <label>Cookie<textarea id="platform-cookie" v-model="c.state.linkCookieContent" name="platformCookie" rows="5" autocomplete="off" autocapitalize="off" autocorrect="off" :spellcheck="false" placeholder="粘贴 Cookie 请求头，例如 name=value; name2=value2，或导入 cookies.txt" maxlength="100000" :disabled="c.state.busy.linkCookie"></textarea><small>支持 Cookie 请求头和 Netscape cookies.txt。保存后清空输入，不回显已保存的凭据；留空不会覆盖原配置，仅保存所选平台的 Cookie。</small></label>
      <label class="cookie-import">导入 cookies.txt<input id="cookie-file" type="file" accept=".txt,text/plain" :disabled="c.state.busy.linkCookie" @change="importCookies"></label>
      <div class="cookie-help"><div><b>不知道如何获取 Cookie？</b><p>查看小红书、哔哩哔哩、抖音的分步教程，以及浏览器操作和常见问题。</p></div><button type="button" class="secondary" aria-haspopup="dialog" @click="cookieGuideOpen = true">获取 Cookie · 查看详情 ↗</button></div>
      <p v-if="c.state.linkCookieError" class="error-text" role="alert">{{ c.state.linkCookieError }}</p>
      <StickySaveBar :dirty-count="c.state.linkCookieContent.trim() ? 1 : 0" dirty-text="有新的登录态待保存" saved-text="登录态未修改"><button class="text-button danger" type="button" :disabled="c.state.busy.linkCookie || !selectedPlatform?.configured" @click="c.removeLinkCookie">清除该平台登录态</button><button class="primary" type="submit" :disabled="c.state.busy.linkCookie || !selectedPlatform || !c.state.linkCookieContent.trim()">{{ c.state.busy.linkCookie ? '处理中…' : '保存登录态 ↗' }}</button></StickySaveBar>
    </form>
    <article class="card panel platform-panel"><div class="panel-heading"><h2>支持的平台</h2><span class="subtle-tag" :class="{ unavailable: c.state.linkStatus && !c.state.linkStatus.available }">{{ c.state.linkStatus?.available ? `yt-dlp ${c.state.linkStatus.version}` : '解析器待就绪' }}</span></div><p v-if="c.state.linkStatusError" class="error-text" role="alert">{{ c.state.linkStatusError }}</p><p class="muted status-detail" role="status">{{ c.state.linkStatus?.detail || '正在检查解析器与媒体依赖…' }}</p><div class="platform-grid"><div v-for="platform in c.state.linkStatus?.platforms || []" :key="platform.id"><strong>{{ platform.name }}</strong><span>{{ platform.video ? '视频 · 图文' : '图文摘要' }} · {{ platform.configured ? '已配置登录态' : '未配置登录态' }}</span></div></div><p class="footnote">支持公开帖子、视频、常见分享短链及 QQ 分享卡片（含 B 站小程序），实际可用性取决于平台接口、服务器网络和登录限制。需要登录的平台可在上方配置 Cookie；不可访问的内容会明确报错，不保证所有链接都可下载。</p></article>
  </section>
  <CookieGuideDialog v-if="cookieGuideOpen" :platform="c.state.linkCookiePlatform" @close="cookieGuideOpen = false" />
</template>

<style scoped>
.embedded-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; font-size: 12px; line-height: 1.8; }.embedded-heading p { margin: 0; }.embedded-heading button { flex-shrink: 0; }
.link-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-bottom: 24px; }.link-stats article { padding: 24px; }.link-stats span { color: var(--muted); font-size: 12px; }.link-stats strong { display: block; font-size: 30px; font-weight: 550; margin-top: 12px; color: var(--green); }
.cookie-panel { margin-top: 24px; }.cookie-help { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; margin-top: 20px; padding: 18px; border: 1px solid var(--line); border-radius: 10px; background: #f5f8f2; font-size: 12px; }.cookie-help b { color: var(--green); font-weight: 550; }.cookie-help p { color: var(--muted); margin: 7px 0 0; font-size: 11px; }.cookie-import { font-size: 12px; }.cookie-panel textarea { overflow-wrap: anywhere; }.cookie-panel .save-bar>div { display: flex; gap: 12px; flex-wrap: wrap; }
.form-panel .link-toggle { display: flex; align-items: flex-start; gap: 12px; }.link-toggle input { width: 17px; height: 17px; accent-color: var(--green); margin-top: 2px; flex-shrink: 0; }.link-toggle span { font-size: 13px; }.link-toggle small { display: block; }.platform-panel { margin-top: 24px; }.status-detail { font-size: 12px; }.platform-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 24px; }.platform-grid>div { padding: 16px; border: 1px solid var(--line); border-radius: 10px; }.platform-grid strong { font-size: 13px; font-weight: 550; }.platform-grid span { display: block; color: var(--muted); font-size: 10px; margin-top: 8px; }.unavailable { color: var(--red); }
@media(max-width:650px) { .link-stats { gap: 8px; }.link-stats article { padding: 16px; }.link-stats strong { font-size: 24px; }.platform-grid { grid-template-columns: repeat(2, 1fr); } }
@media(max-width:650px) {
  .link-stats article { padding: 16px 10px; }.link-stats span { font-size: 11px; line-height: 1.6; display: block; min-height: 36px; }
  .platform-grid { grid-template-columns: minmax(0, 1fr); }.platform-grid span { font-size: 12px; }
  .cookie-help { padding: 16px; }.cookie-help button { width: 100%; white-space: normal; }
}
</style>

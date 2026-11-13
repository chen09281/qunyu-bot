<script setup>
import { computed, onMounted, ref } from 'vue';

const props = defineProps({ platform: { type: String, default: '' } });
const emit = defineEmits(['close']);
const dialog = ref(null);
const guides = [
  {
    id: 'xiaohongshu', name: '小红书', url: 'https://www.xiaohongshu.com',
    intro: '使用电脑版小红书网页版，在登录后打开一篇能正常查看的笔记。',
    steps: [
      ['登录小红书网页版', '打开 www.xiaohongshu.com，用自己的账号扫码或按页面提示登录。确认网页已经显示个人头像，并且能正常查看目标笔记。仅在手机 App 登录还不够。'],
      ['打开完整笔记页面', '如果拿到的是 xhslink.com 分享短链，先在浏览器打开，等待跳转到小红书笔记页面。保留地址中的查询参数，尤其是 xsec_token；不要只截取笔记编号。'],
      ['开始记录网络请求', '按上方「打开开发者工具」的方法进入 Network / 网络，清空筛选或选择 All / 全部，然后刷新笔记页面。'],
      ['找到小红书站点请求', '在筛选框输入 xiaohongshu.com。优先点开地址为 www.xiaohongshu.com 的页面请求；也可查看 edith.xiaohongshu.com 的接口请求。核对 Request URL / 请求网址属于小红书站点。'],
      ['复制完整 Cookie 值', '打开 Headers / 标头 → Request Headers / 请求标头，找到 Cookie，复制这一项的完整值（name=value; name2=value2）。不要复制 Response Headers 中的 Set-Cookie，也不要只复制某一个 Cookie。'],
      ['保存并重新发送链接', '关闭教程，在「选择平台」中选小红书，把值粘贴到 Cookie 输入框，点击「保存登录态」。看到已配置后，把原始完整分享链接重新发到群里，再查看运行日志。'],
    ],
    tip: '笔记在浏览器里也打不开时，先处理网页的登录或验证提示。Cookie 无法让已删除、无权限的笔记变为可访问；带参数的原始分享链接通常比手动拼出的链接更完整。',
  },
  {
    id: 'bilibili', name: '哔哩哔哩', url: 'https://www.bilibili.com',
    intro: '使用 B 站网页版登录后，从视频页面的请求中获取完整登录态。',
    steps: [
      ['登录 B 站网页版', '打开 www.bilibili.com，用自己的账号扫码或按页面提示登录。确认网页右上角能看到个人头像，目标视频可以正常播放。'],
      ['进入目标视频', '打开需要解析的 BV 视频页面。如果是 b23.tv 短链，先等它跳转到 www.bilibili.com/video/…，再进行下面的操作。'],
      ['打开 Network 并刷新', '按上方浏览器说明打开开发者工具，切换 Network / 网络，选择 All / 全部，再刷新当前视频页面，让请求列表出现新记录。'],
      ['选择 B 站页面或接口请求', '在筛选框输入 bilibili.com，点开 www.bilibili.com/video/… 的页面请求，或 api.bilibili.com 的接口请求。不要选择视频 CDN 的分片、图片或广告请求。'],
      ['复制请求头 Cookie', '在 Headers / 标头 → Request Headers / 请求标头里找到 Cookie，复制它的完整值。若值显示为多行，确认复制了整项；不要复制响应头 Set-Cookie、整个 cURL 命令或全部请求头。'],
      ['在后台保存并验证', '关闭教程，选择平台「哔哩哔哩」，粘贴 Cookie 后点击「保存登录态」。重新在群里发送视频链接，在运行日志查看是否解析成功或仍有登录提示。'],
    ],
    tip: '只有账号本身有权限观看的内容才能尝试解析。大会员、付费或地区限制不会因导入 Cookie 而自动解除，后台的视频大小与时长限制也仍会生效。',
  },
  {
    id: 'douyin', name: '抖音', url: 'https://www.douyin.com',
    intro: '推荐在「链接解析」选择抖音并扫码，确认后自动保存 Cookie。以下是遇到验证时的手动导入方法。',
    steps: [
      ['登录抖音网页版', '打开 www.douyin.com，用自己的账号扫码或按页面提示登录。先完成网页要求的验证码或其他验证，并确认网页能正常播放目标作品。'],
      ['打开作品完整页面', '如果是 v.douyin.com 分享短链，先在浏览器打开并等待跳转；尽量进入 www.douyin.com/video/… 的作品详情页，不要停在登录页或验证页。'],
      ['记录作品页请求', '按上方说明进入开发者工具的 Network / 网络，选择 All / 全部，刷新作品页面；必要时点击播放，让页面产生新的请求。'],
      ['找到抖音站点请求', '在筛选框输入 douyin.com，点开 www.douyin.com 的作品页面请求，或同站点包含 aweme 的作品接口请求。不要选择 douyinvod.com 等视频 CDN 请求。'],
      ['复制 Cookie 的完整值', '打开 Headers / 标头 → Request Headers / 请求标头，找到 Cookie 并复制完整值。若没有 Cookie，换一个 www.douyin.com 请求检查；不要把请求参数、响应正文或 Set-Cookie 当作 Cookie。'],
      ['立即保存并重试', '关闭教程，选择平台「抖音」，粘贴后点击「保存登录态」，再把视频分享链接发到群里。仍提示登录或风控时，先回网页确认可以播放，再重新获取当前 Cookie。'],
    ],
    tip: '抖音可能同时检查访问环境和网络。浏览器可播放但服务器仍被限制时，仅更新 Cookie 未必能解决；可先查看运行日志确认是登录限制、网络问题还是视频超过设置上限。',
  },
];
const selected = ref(guides.some(item => item.id === props.platform) ? props.platform : 'general');
const guide = computed(() => guides.find(item => item.id === selected.value));
function closeGuide() { dialog.value.close(); emit('close'); }
function backdrop(event) {
  if (event.target !== dialog.value) return;
  const box = dialog.value.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeGuide();
}
function selectGuide(id) {
  selected.value = id;
  dialog.value.querySelector('.guide-body').scrollTop = 0;
}
onMounted(() => dialog.value.showModal());
</script>

<template>
  <dialog ref="dialog" class="cookie-guide" aria-labelledby="cookie-guide-title" @cancel.prevent="closeGuide" @click="backdrop">
    <header class="guide-header">
      <div><span class="eyebrow">COOKIE GUIDE</span><h2 id="cookie-guide-title">获取 Cookie · 详细教程</h2></div>
      <button type="button" class="secondary" autofocus aria-label="关闭 Cookie 教程" @click="closeGuide">关闭 ✕</button>
    </header>
    <nav class="guide-tabs" aria-label="选择 Cookie 教程">
      <button v-for="item in guides" :key="item.id" type="button" :aria-pressed="selected === item.id" :class="{ active: selected === item.id }" @click="selectGuide(item.id)">{{ item.name }}</button>
      <button type="button" :aria-pressed="selected === 'general'" :class="{ active: selected === 'general' }" @click="selectGuide('general')">通用方法</button>
    </nav>
    <div class="guide-body" tabindex="0" aria-label="Cookie 教程内容">
      <div class="guide-intro">
        <span class="subtle-tag">电脑浏览器操作</span>
        <h3>{{ guide ? `${guide.name} Cookie 获取步骤` : '其他平台 · 通用获取方法' }}</h3>
        <p>{{ guide?.intro || '在所选平台的网页版登录，并打开需要解析的作品。下面的方法适用于提供网页 Cookie 的站点。' }}</p>
        <a v-if="guide" :href="guide.url" target="_blank" rel="noopener noreferrer">打开{{ guide.name }}网页版 ↗</a>
      </div>
      <details class="browser-help" open>
        <summary>先看这里：如何打开开发者工具</summary>
        <dl>
          <div><dt>Chrome / Edge · Windows、Linux</dt><dd>按 F12，或 Ctrl + Shift + I（部分笔记本需 Fn + F12）；也可右键网页 → 检查 / Inspect。</dd></div>
          <div><dt>Chrome / Edge · macOS</dt><dd>按 ⌘ + ⌥ + I；也可右键网页 → 检查 / Inspect。</dd></div>
          <div><dt>Safari · macOS</dt><dd>Safari → 设置 → 高级，启用网页开发者功能（旧版为「在菜单栏中显示“开发”菜单」）。再点「开发 → 显示网页检查器」，或按 ⌘ + ⌥ + I，切换到「网络 / Network」。</dd></div>
        </dl>
        <p>先打开工具再刷新网页；如果看不到请求，清空筛选并选 All / 全部。Cookie 在请求的「标头 / Headers」里，不在 Console / 控制台。</p>
      </details>
      <ol v-if="guide" class="guide-steps">
        <li v-for="(step, index) in guide.steps" :key="step[0]"><span class="step-number" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span><div><h4>{{ step[0] }}</h4><p>{{ step[1] }}</p></div></li>
      </ol>
      <ol v-else class="general-steps">
        <li>在自己的电脑浏览器登录平台网页版，确认目标作品可以正常访问。</li>
        <li>打开 Network / 网络，刷新作品页，选择属于平台自身域名的页面或接口请求。</li>
        <li>在 Headers → Request Headers 中复制 Cookie 的完整值，格式为 <code>name=value; name2=value2</code>。</li>
        <li>关闭教程，在后台选择对应平台，粘贴后保存登录态，再在群里重新发送链接。</li>
      </ol>
      <aside v-if="guide" class="platform-note"><b>{{ guide.name }}使用提示</b><p>{{ guide.tip }}</p></aside>
      <details class="guide-extra">
        <summary>找不到 Cookie，或保存后还是失败？</summary>
        <ul>
          <li><b>请求列表是空的：</b>保持 Network 开着，再刷新网页；清除筛选，确认没有暂停记录。</li>
          <li><b>请求头没有 Cookie：</b>确认网页版已登录，换一个平台页面或接口请求，避开图片、视频分片和第三方域名。如果提示仅显示临时标头，等请求完成或重新刷新。</li>
          <li><b>提示 Cookie 格式错误：</b>只粘贴 Cookie 的值；不要粘贴 JSON、Set-Cookie、cURL 或全部请求头。示例 <code>name=value; name2=value2</code> 只是格式，不能用于登录。</li>
          <li><b>提示没有所选平台的 Cookie：</b>检查平台是否选对；导入文件时确认导出的是当前平台的 Cookie，而不是其他站点。</li>
          <li><b>保存成功但解析失败：</b>「已配置」只表示保存完成，不表示登录验证通过。重新发送链接，在运行日志点击整条记录看详情；Cookie 过期时重新登录获取，风控时先完成平台网页验证。</li>
          <li><b>浏览器能看、服务器仍失败：</b>还可能受平台策略、服务器网络、解析器适配或视频大小与时长设置影响，按日志中的具体原因处理。</li>
        </ul>
      </details>
      <details class="guide-extra">
        <summary>替代方法：导入 cookies.txt</summary>
        <ol>
          <li>如已使用可信的 Cookie 导出工具，在已登录的平台页面，仅导出该站点的 Mozilla / Netscape 格式 Cookie，包含登录态（含 HttpOnly 项）。</li>
          <li>文件首行应为 <code># Netscape HTTP Cookie File</code> 或 <code># HTTP Cookie File</code>，后续按制表符分列；JSON、浏览器数据库或改后缀的文件不能直接导入。</li>
          <li>关闭教程，选择对应平台 →「导入 cookies.txt」→ 检查输入框已载入内容 →「保存登录态」。每次最多 96 KiB，请仅导出所选平台。</li>
        </ol>
        <p>这两种方法任选一种即可。后台不读取电脑浏览器的登录数据库，也不提供平台账号密码登录。</p>
      </details>
      <p class="privacy-note">Cookie 相当于登录凭据，仅粘贴到自己的后台，不要发到群聊、截图或提交到 Git。保存后输入框会清空，不回显已保存内容；新任务使用新登录态。</p>
      <div class="guide-sources">操作参考：<a href="https://developer.chrome.com/docs/devtools/network/reference" target="_blank" rel="noopener noreferrer">Chrome 网络面板</a><a href="https://webkit.org/web-inspector/enabling-web-inspector/" target="_blank" rel="noopener noreferrer">Safari 网页检查器</a><a href="https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp" target="_blank" rel="noopener noreferrer">yt-dlp Cookie 格式</a></div>
    </div>
    <footer class="guide-footer"><span>切换教程不会更改配置中选中的平台</span><button type="button" class="primary" @click="closeGuide">返回配置</button></footer>
  </dialog>
</template>

<style scoped>
.cookie-guide { width: min(840px, calc(100vw - 32px)); max-height: calc(100dvh - 40px); margin: auto; padding: 0; border: 1px solid var(--line); border-radius: 18px; background: var(--bg); color: var(--ink); box-shadow: 0 24px 90px #172d3b30; display: flex; flex-direction: column; overflow: hidden; }
.cookie-guide::backdrop { background: #1b302d66; backdrop-filter: blur(3px); }
.guide-header { padding: 24px 28px 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px; background: white; }
.guide-header .eyebrow { font-size: 9px; margin-bottom: 8px; }.guide-header h2 { font-size: 22px; }.guide-header>button { flex-shrink: 0; }
.guide-tabs { display: flex; gap: 8px; padding: 0 28px 18px; background: white; border-bottom: 1px solid var(--line); flex-shrink: 0; flex-wrap: wrap; }
.guide-tabs button { padding: 9px 16px; border: 1px solid var(--line); border-radius: 7px; background: white; color: #65756b; font-size: 12px; }.guide-tabs button.active { color: var(--green); border-color: #b9d0bc; background: var(--soft); font-weight: 600; }
.guide-body { padding: 26px 28px; overflow-y: auto; min-height: 0; line-height: 1.9; font-size: 13px; overscroll-behavior: contain; }
.guide-intro { margin-bottom: 22px; }.guide-intro h3 { font-size: 20px; margin: 14px 0 8px; }.guide-intro p { color: #6a7b70; margin-bottom: 10px; }.guide-intro>a { font-size: 12px; }
.browser-help, .guide-extra { padding: 16px 18px; border: 1px solid var(--line); border-radius: 10px; background: white; margin: 14px 0; }
summary { color: var(--green); cursor: pointer; font-weight: 550; }dl { margin: 14px 0; }dl>div+div { margin-top: 12px; }dt { font-weight: 550; font-size: 12px; }dd { margin: 4px 0 0; color: #6a7b70; font-size: 12px; }.browser-help>p { color: #6a7b70; font-size: 12px; margin-bottom: 0; }
.guide-steps { list-style: none; padding: 0; margin: 26px 0; }.guide-steps li { display: flex; gap: 16px; padding: 18px 0; border-bottom: 1px solid var(--line); }.guide-steps li:first-child { padding-top: 0; }.step-number { background: #e9f0e6; color: var(--green); border-radius: 9px; width: 34px; height: 34px; display: grid; place-items: center; flex-shrink: 0; font-size: 11px; font-weight: 650; }.guide-steps h4 { font-size: 14px; margin: 4px 0 8px; font-weight: 600; }.guide-steps p { margin: 0; color: #64756a; }
.general-steps, .guide-extra ol, .guide-extra ul { padding-left: 22px; }.general-steps li, .guide-extra li { margin-top: 10px; }.guide-extra li, .guide-extra>p { color: #64756a; font-size: 12px; }.guide-extra>p { margin-bottom: 0; }.guide-extra b { color: var(--ink); font-weight: 550; }
.platform-note { padding: 18px; border-radius: 10px; background: #eaf1e5; margin-bottom: 22px; font-size: 12px; }.platform-note b { color: var(--green); font-weight: 550; }.platform-note p { margin: 8px 0 0; color: #64765c; }
code { font-family: ui-monospace, monospace; font-size: 11px; overflow-wrap: anywhere; color: var(--green); }.privacy-note { font-size: 11px; color: #78867b; margin: 24px 0 16px; }.guide-sources { display: flex; flex-wrap: wrap; gap: 8px 14px; font-size: 10px; color: var(--muted); }
.guide-footer { display: flex; justify-content: space-between; align-items: center; width: 100%; margin: 0; gap: 16px; padding: 16px 28px; border-top: 1px solid var(--line); background: white; flex-shrink: 0; }.guide-footer>span { margin: 0; font-size: 10px; color: var(--muted); }.guide-footer>button { flex-shrink: 0; }
@media(max-width:650px) { .cookie-guide { width: calc(100vw - 20px); max-height: calc(100dvh - 20px); }.guide-header { padding: 18px; }.guide-header h2 { font-size: 18px; }.guide-tabs { padding: 0 18px 14px; gap: 6px; }.guide-tabs button { padding: 8px 11px; font-size: 11px; }.guide-body { padding: 20px 18px; font-size: 12px; }.guide-intro h3 { font-size: 18px; }.browser-help, .guide-extra { padding: 14px; }.guide-steps li { gap: 12px; }.guide-footer { padding: 14px 18px; }.guide-footer>span { max-width: 150px; } }
@media(max-width:650px) {
  .cookie-guide { max-height: calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); }
  .guide-tabs button { min-height: 44px; font-size: 12px; }
  .guide-body { font-size: 14px; overflow-wrap: anywhere; }
  .guide-header { flex-shrink: 0; }.guide-footer { padding-bottom: max(14px, env(safe-area-inset-bottom)); }
}
</style>

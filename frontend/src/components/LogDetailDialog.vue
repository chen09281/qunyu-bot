<script setup>
import { computed, inject, onMounted, ref } from 'vue';
import { consoleKey, logLabels } from '../composables/useConsole';
const c = inject(consoleKey), dialog = ref(null);
const detail = computed(() => c.state.logDetail);
const statuses = { skipped: '本次保持安静，未发送', generating: '正在生成回复', sending: '正在发送，等待确认', sent: '已发送到群聊', send_failed: '发送失败或未确认',
  cancelled: '已取消，未发送到群聊', not_sent: '未调用模型，未发送回复', failed: '未生成可发送的回复', test_completed: '模型测试结果，未发送到群聊', not_applicable: '系统事件' };
const imageStatuses = { resolving: '正在读取图片', recognizing: '正在识别', completed: '识别完成', failed: '识别失败', cancelled: '已取消识别' };
const videoStatuses = { reading: '正在读取原视频', completed: '已抽样读取画面', metadata_only: '已读取文字资料，未取得画面', failed: '读取失败', cancelled: '已取消' };
const linkStages = { parsing: '读取作品与下载', card: '上传预览卡片', text: '发送文字', images: '上传原图', album: '上传合并转发', video: '上传视频', completed: '发送完成' };
const documentStatuses = { drafting: '正在撰写文档', rendering: '正在排版导出', uploading: '正在上传群文件', sent: '群文件已上传',
  disabled: '文档生成已关闭', unsupported: '请求的文档格式尚不支持', not_created: '本轮仅文字回复，未生成文件', failed: '文档生成失败', upload_failed: '群文件上传失败或未确认', cancelled: '已取消' };
const imageSearchStatuses = { unsupported: '当前接口仅支持文字搜索', searching: '正在搜索', selecting: '正在选择相关图片', empty: '网页未提供图片', downloading: '正在下载图片',
  ready: '已下载，等待群聊发送确认', sent: '已发送图片', disabled: '联网搜索已关闭', not_found: '未找到合适图片', download_failed: '图片下载失败', failed: '搜索失败', cancelled: '已取消发图', send_failed: '发送失败或未确认' };
const noReply = computed(() => ({ generating: '正在等待模型生成回复…', sending: '正在等待发送结果…',
  cancelled: '本次任务已取消，没有发送回复。', not_sent: '这条消息被规则忽略，没有生成或发送回复。',
  skipped: '模型判断本次不适合插话，没有发送消息。', failed: '本次调用失败，没有可显示的回复。', not_applicable: '这条系统事件没有群聊回复。' })[detail.value?.replyStatus] || '暂无回复内容');
function backdrop(event) {
  if (event.target !== dialog.value) return;
  const box = dialog.value.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) c.closeLogDetail();
}
onMounted(() => dialog.value.showModal());
</script>

<template>
  <dialog ref="dialog" class="log-detail" aria-labelledby="log-detail-title" @cancel.prevent="c.closeLogDetail()" @click="backdrop">
    <header class="detail-header"><div><span class="eyebrow">MESSAGE DETAILS</span><h2 id="log-detail-title">事件详情</h2></div><button class="secondary close-detail" autofocus aria-label="关闭详情" @click="c.closeLogDetail()">关闭 ✕</button></header>
    <div class="detail-body" :aria-busy="c.state.logDetailLoading">
      <p v-if="c.state.logDetailLoading && !detail" class="empty" role="status">正在加载消息详情…</p>
      <div v-if="c.state.logDetailError" class="detail-error" role="alert"><p>{{ c.state.logDetailError }}</p><button class="secondary" :disabled="c.state.logDetailLoading" @click="c.loadLogDetail()">重新加载</button></div>
      <template v-if="detail">
        <div class="detail-event"><span class="log-badge" :class="detail.level">{{ logLabels[detail.level] }}</span><strong>{{ detail.message }}</strong></div>
        <dl class="detail-meta">
          <div><dt>时间</dt><dd>{{ new Date(detail.time).toLocaleString('zh-CN', { hour12: false }) }}</dd></div>
          <div><dt>会话</dt><dd>{{ detail.messageType === 'private' ? '私聊' : detail.group || (detail.source === 'model_test' ? '后台模型测试' : '—') }}</dd></div>
          <div><dt>发送者</dt><dd>{{ detail.userName ? `${detail.userName}（${detail.user}）` : detail.user || '—' }}</dd></div>
          <div><dt>模型</dt><dd>{{ detail.modelProfileName ? detail.modelProfileName + ' · ' : '' }}{{ detail.model || '—' }}{{ detail.provider ? '（' + detail.provider + '）' : '' }}</dd></div>
          <div v-if="detail.source === 'subscription'"><dt>订阅推送</dt><dd>{{ detail.subscriptionName || '—' }}</dd></div>
          <div v-if="detail.source === 'social_link'"><dt>链接解析</dt><dd>{{ detail.platform }}<template v-if="detail.mediaCount"> · {{ detail.mediaCount }} 个媒体</template><template v-if="detail.card !== undefined"> · {{ detail.card ? '已发解析卡片' : '卡片发送失败，已退回文字' }}</template></dd></div>
          <div v-if="detail.linkStage"><dt>处理阶段</dt><dd>{{ linkStages[detail.linkStage] || detail.linkStage }}<template v-if="detail.parseDuration != null"> · 解析下载 {{ (detail.parseDuration / 1000).toFixed(1) }}s</template><template v-if="detail.sendDuration != null"> · QQ 发送 {{ (detail.sendDuration / 1000).toFixed(1) }}s</template></dd></div>
          <div v-if="detail.imageSizes"><dt>图片尺寸</dt><dd>{{ detail.imageSizes }}</dd></div>
          <div v-if="detail.imageModelInputs != null"><dt>识图清晰度</dt><dd>原图与 {{ detail.imageDetailCrops || 0 }} 张无损细节切片 · 高精度输入<template v-if="detail.imagePreparationFallbacks"> · {{ detail.imagePreparationFallbacks }} 张仅传图片链接</template><template v-if="detail.imageDetailPartial"> · 部分细节未覆盖</template><template v-else-if="detail.imageDetailLimited"> · 大图切片数量已达上限</template></dd></div>
          <div v-if="detail.videoStatus"><dt>B 站内容分析</dt><dd>{{ videoStatuses[detail.videoStatus] || detail.videoStatus }} · {{ detail.videoCount }} 条<template v-if="detail.videoFrameCount"> · {{ detail.videoFrameCount }} 帧</template></dd></div>
          <div v-if="detail.documentStatus"><dt>文档生成</dt><dd>{{ documentStatuses[detail.documentStatus] || detail.documentStatus }}<template v-if="detail.documentCount"> · {{ detail.documentCount }} 份</template><template v-for="file in detail.documents || []" :key="file.name"><br>{{ file.name }}（{{ (file.bytes / 1024).toFixed(1) }} KiB）</template></dd></div>
          <div v-if="detail.imageStatus && detail.imageStatus !== 'none'"><dt>图片识别</dt><dd>{{ imageStatuses[detail.imageStatus] || detail.imageStatus }}<template v-if="detail.imageCount"> · {{ detail.imageCount }} 张{{ detail.imageSource === 'reply' ? '引用图片' : '图片' }}</template></dd></div>
          <div v-if="detail.imageSearchStatus"><dt>搜索发图</dt><dd>{{ imageSearchStatuses[detail.imageSearchStatus] || detail.imageSearchStatus }}<template v-if="detail.imagePagesFetched != null"> · 读取 {{ detail.imagePagesFetched }} 页</template><template v-if="detail.imageSearchAttempts > 1"> · 已补搜一次<template v-if="detail.imageRetryFailed">（补搜失败）</template></template><template v-if="detail.imageCandidates != null"> · {{ detail.imageCandidates }} 张候选图</template><template v-if="detail.replyImageCount"> · 发送 {{ detail.replyImageCount }} 张</template><template v-if="detail.replyImageFailures || detail.imageDownloadFailures"> · 下载失败 {{ (detail.replyImageFailures || 0) + (detail.imageDownloadFailures || 0) }} 张</template></dd></div>
          <div><dt>DS 调用</dt><dd>{{ typeof detail.deepseekCalled === 'boolean' ? detail.deepseekCalled ? '已调用' : '未调用' : '—' }}</dd></div>
          <div><dt>Tokens / 耗时</dt><dd>{{ typeof detail.deepseekCalled === 'boolean' ? detail.tokens ?? '未知' : '—' }} / {{ detail.duration != null ? `${(detail.duration / 1000).toFixed(1)}s` : ['generating', 'sending'].includes(detail.replyStatus) ? '进行中' : '—' }}</dd></div>
        </dl>
        <section class="message-section"><h3>收到的消息<span v-if="detail.user">群聊中的 @ 以文字显示</span></h3><pre v-if="detail.receivedMessage != null" class="message-content received">{{ detail.receivedMessage }}</pre><p v-else class="message-placeholder">这条系统事件没有群聊消息内容。</p><p v-if="detail.receivedTruncated" class="detail-note">消息过长，仅展示前 20,000 个字符。</p></section>
        <section class="message-section"><h3>机器人回复<span>{{ statuses[detail.replyStatus] || '暂无发送状态' }}</span></h3><p v-if="detail.replyMessage && detail.replyMention" class="detail-note">@{{ detail.replyMention }}</p><pre v-if="detail.replyMessage" class="message-content reply">{{ detail.replyMessage }}</pre><p v-else class="message-placeholder">{{ noReply }}</p></section>
        <p class="detail-note">详情随运行状态自动更新，仅保留本次服务运行期间最近 200 条日志。</p>
      </template>
    </div>
  </dialog>
</template>

<style scoped>
.log-detail { width: min(760px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); margin: auto; padding: 0; border: 1px solid var(--line); border-radius: 18px; color: var(--ink); background: var(--bg); box-shadow: 0 24px 90px #172d3b30; overflow: auto; }
.log-detail::backdrop { background: #1b302d66; backdrop-filter: blur(3px); }
.detail-header { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 24px 28px; background: var(--bg); border-bottom: 1px solid var(--line); }
.detail-header h2 { margin: 8px 0 0; font-size: 22px; font-weight: 600; }
.detail-header .eyebrow { font-size: 9px; }
.close-detail { white-space: nowrap; }
.detail-body { padding: 24px 28px 28px; }
.detail-event { display: flex; align-items: center; gap: 12px; overflow-wrap: anywhere; }
.detail-event strong { font-size: 13px; font-weight: 550; }
.detail-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 28px; margin: 24px 0; }
.detail-meta dt { color: var(--muted); font-size: 10px; margin-bottom: 6px; }
.detail-meta dd { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.message-section { margin-top: 24px; }
.message-section h3 { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; font-size: 13px; font-weight: 550; margin: 0 0 12px; }
.message-section h3 span { color: var(--muted); font-size: 10px; font-weight: 400; }
.message-content { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; margin: 0; padding: 18px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: #304c3c; font: inherit; font-size: 13px; line-height: 1.9; }
.message-content.reply { background: #eef5ec; border-color: #dae8d7; }
.message-placeholder { border: 1px dashed var(--line); border-radius: 10px; padding: 20px; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.8; }
.detail-note { color: var(--muted); font-size: 10px; line-height: 1.8; margin: 12px 0; }
.detail-body > .detail-note:last-child { margin: 24px 0 0; }
.detail-error { color: var(--red); font-size: 12px; margin-bottom: 20px; }
@media (max-width: 650px) { .detail-header { padding: 18px; } .detail-body { padding: 18px; } .detail-meta { gap: 16px; } .message-content { padding: 14px; font-size: 12px; } }
@media (max-width: 650px) {
  .log-detail { width: calc(100vw - 20px); max-height: calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom)); }
  .detail-header { position: sticky; top: 0; z-index: 1; background: white; }
  .detail-meta { grid-template-columns: minmax(0, 1fr); }.detail-event { flex-wrap: wrap; }
  .message-content { font-size: 14px; }.detail-meta dd { overflow-wrap: anywhere; }
}
</style>

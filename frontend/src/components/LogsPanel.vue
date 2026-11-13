<script setup>
import { inject, onUnmounted } from 'vue';
import LogDetailDialog from './LogDetailDialog.vue';
import { consoleKey, logLabels, timeText } from '../composables/useConsole';
const c = inject(consoleKey);
onUnmounted(() => c.closeLogDetail());
function openRow(log, event) {
  if (event.type === 'click' && window.getSelection()?.toString()) return;
  c.openLogDetail(log);
}
const searchLabels = { not_used: '本轮未使用搜索', pending: '待搜索', searching: '搜索中', completed: '已搜索', empty: '搜索无结果', failed: '搜索失败', disabled: '联网关闭', skipped_image: '纯图片跳过搜索', skipped_video: '已读取 B 站原视频资料' };
</script>

<template>
  <section id="page-logs" class="page">
    <div class="page-heading"><div><span class="eyebrow">FOLLOW EVERY RESPONSE</span><h1>每一次回应，都有迹可循<span class="title-dot">.</span></h1><p class="muted">保留最近 200 条运行记录，点击任意一行查看消息和回复详情。</p></div><label class="filter-label">日志级别<select v-model="c.state.filter"><option value="all">全部记录</option><option value="error">错误</option><option value="warn">提醒</option><option value="success">成功</option><option value="info">信息</option></select></label></div>
    <div class="card table-wrap logs-table">
      <table>
        <thead><tr><th>时间</th><th>状态</th><th>事件</th><th>模型调用</th><th>消耗 Tokens</th><th>会话</th><th>耗时</th></tr></thead>
        <tbody>
          <tr v-for="log in c.filteredLogs" :key="log.id" class="log-row" tabindex="0" :aria-label="`${log.message}，查看详情`" @click="openRow(log, $event)" @keydown.enter.prevent="openRow(log, $event)" @keydown.space.prevent="openRow(log, $event)">
            <td class="log-time" data-label="时间">{{ timeText(log.time) }}</td>
            <td class="log-status" data-label="状态"><span class="log-badge" :class="log.level">{{ logLabels[log.level] }}</span></td>
            <td class="log-event" data-label="事件"><span class="event-text">{{ log.message }}<span aria-hidden="true"> ↗</span></span><small v-if="typeof log.thinkingEnabled === 'boolean'" class="request-modes">深度思考{{ log.thinkingEnabled ? '开启' : '关闭' }} · {{ searchLabels[log.searchStatus] || '待搜索' }}{{ log.searchStatus === 'completed' ? ` ${log.searchResults} 条` : '' }}<template v-if="log.contextTurns"> · 上下文 {{ log.contextTurns }} 轮</template><template v-if="log.imageCount"> · 识图 {{ log.imageCount }} 张</template></small></td>
            <td class="log-ds" data-label="模型调用"><span v-if="typeof log.deepseekCalled === 'boolean'" class="log-badge" :class="log.deepseekCalled ? 'success' : ''">{{ log.deepseekCalled ? '已调用' : '未调用' }}</span><span v-else>—</span></td>
            <td class="token-usage" data-label="Tokens">
              <template v-if="typeof log.deepseekCalled === 'boolean'">
                <strong>{{ log.tokens ?? '未知' }}<template v-if="log.cost != null"> · ¥{{ Number(log.cost).toFixed(4) }}</template></strong>
                <small>输入 {{ log.promptTokens ?? '未知' }}<template v-if="log.cachedTokens">（命中 {{ log.cachedTokens }}）</template> · 输出 {{ log.completionTokens ?? '未知' }}</small>
              </template>
              <template v-else>—</template>
            </td>
            <td class="log-group" data-label="会话">{{ log.messageType === 'private' ? `私聊 · ${log.user}` : log.group || '—' }}</td>
            <td class="log-duration" data-label="耗时">{{ log.duration != null ? `${(log.duration / 1000).toFixed(1)}s` : '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="!c.filteredLogs.length" class="empty">暂无运行记录</div>
    </div>
    <p class="footnote">Tokens 以 DeepSeek 返回的 usage 为准；请求中、超时或接口未返回用量时显示「未知」。未调用时为 0，普通系统事件显示「—」。</p>
    <p class="footnote">图片 Token 包含在输入用量中，思考 Token 包含在输出用量中。联网搜索按请求次数另行计费，不计入此处 Token 总数。</p>
    <p class="footnote">消息详情仅向已登录管理员展示，随最近 200 条日志保存在内存，服务重启后清空。</p>
    <LogDetailDialog v-if="c.state.logDetailId" />
  </section>
</template>

<style scoped>
.token-usage { font-variant-numeric: tabular-nums; }
.token-usage strong { display: block; font-size: 12px; font-weight: 550; color: var(--green); }
.token-usage small { display: block; margin-top: 5px; color: var(--muted); font-size: 9px; }
.request-modes { display: block; margin-top: 6px; color: var(--muted); font-size: 9px; }
.log-row { cursor: pointer; transition: background .15s; }
.log-row:hover { background: #f0f5ee; }
.log-row:focus-visible { outline: 2px solid var(--green); outline-offset: -2px; }
.event-text { color: var(--green); line-height: 1.7; }
.event-text span { color: var(--muted); font-size: 10px; }
@media (max-width: 650px) {
  .logs-table { background: transparent; border: 0; overflow: visible; }
  table, tbody { display: block; white-space: normal; }
  thead { display: none; }
  .log-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px 18px; padding: 18px; margin-bottom: 12px; border: 1px solid var(--line); border-radius: 14px; background: white; }
  .log-row td { display: block; padding: 0; border: 0; min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
  td::before { content: attr(data-label); display: block; font-size: 11px; color: var(--muted); margin-bottom: 6px; }
  .log-row .log-time, .log-row .log-status { display: flex; gap: 10px; align-items: center; }
  .log-time::before, .log-status::before, .log-event::before { display: none; }
  .log-status { justify-content: flex-end; }
  .log-event, .token-usage { grid-column: 1 / -1; }
  .event-text { font-size: 14px; }
  .token-usage strong { display: inline; margin-right: 10px; font-size: 16px; }
  .token-usage small { display: inline; font-size: 11px; }
  .request-modes { font-size: 11px; line-height: 1.7; }
  .log-group { grid-row: 4; }.log-duration { grid-row: 4; }
}
</style>

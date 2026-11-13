<script setup>
import { computed, inject } from 'vue';
import { consoleKey, timeText } from '../composables/useConsole';
const c = inject(consoleKey);
const server = computed(() => c.state.status.server);
const gc = computed(() => server.value?.gc);
const gcStates = { scheduled: '等待下次执行', waiting: '任务繁忙，稍后重试', running: '正在回收', error: '本次未完成，等待重试', disabled: '已关闭', unavailable: '启动时未启用 GC 接口' };
const pressure = computed(() => {
  if (!server.value) return { label: '正在读取', level: '' };
  if (server.value.memory?.percent >= 90) return { label: '内存占用较高', level: 'high' };
  if (server.value.disk?.percent >= 90) return { label: '数据分区空间紧张', level: 'high' };
  if (server.value.cpu?.percent >= 85) return { label: 'CPU 较忙', level: 'high' };
  if (server.value.cpu?.percent == null) return { label: 'CPU 采样中', level: '' };
  return { label: server.value.memory?.source === 'linux' ? '资源占用正常' : 'CPU 占用正常', level: 'normal' };
});
function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (!value) return '0 MiB';
  const index = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][index]}`;
}
const percent = value => Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
const width = value => `${Math.max(0, Math.min(100, value || 0))}%`;
function uptime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}
</script>

<template>
  <section class="card server-panel" aria-labelledby="server-status-title">
    <div class="server-heading">
      <div><span class="server-kicker">SERVER RESOURCES</span><h2 id="server-status-title">服务器状态</h2></div>
      <div class="server-meta"><span class="server-pressure" :class="pressure.level"><i></i>{{ pressure.label }}</span><small>每 5 秒采样</small></div>
    </div>
    <div v-if="!server" class="server-loading" role="status">正在读取服务器资源…</div>
    <template v-else>
      <div class="resource-grid">
        <article class="resource-item"><div class="resource-title">CPU <span>{{ server.cpu.cores }} 核</span></div>
          <strong>{{ percent(server.cpu.percent) }}<small v-if="server.cpu.percent == null">采样中</small></strong>
          <div class="usage-track" :class="{ high: server.cpu.percent >= 85 }" aria-hidden="true"><i :style="{ width: width(server.cpu.percent) }"></i></div>
          <p>平均负载 <span>{{ server.cpu.load ? server.cpu.load.join(' / ') : '系统未提供' }}</span></p><small>最近 1 / 5 / 15 分钟</small>
        </article>
        <article class="resource-item"><div class="resource-title">系统内存 <span>总计 {{ bytes(server.memory.total) }}</span></div>
          <strong v-if="server.memory.source === 'linux'">{{ percent(server.memory.percent) }}</strong><strong v-else class="process-memory">{{ bytes(server.memory.available) }}<small>空闲</small></strong>
          <div class="usage-track" :class="{ high: server.memory.percent >= 90 }" aria-hidden="true"><i :style="{ width: width(server.memory.percent) }"></i></div>
          <p v-if="server.memory.source === 'linux'">已用 {{ bytes(server.memory.used) }}<br>可用 {{ bytes(server.memory.available) }}</p><p v-else>显示系统报告的空闲内存<br>此环境未提供可用内存统计</p>
          <small>Swap {{ !server.swap ? '系统未提供' : !server.swap.total ? '未配置' : `${bytes(server.swap.used)} / ${bytes(server.swap.total)}` }}</small>
        </article>
        <article class="resource-item"><div class="resource-title">数据分区 <span v-if="server.disk">{{ bytes(server.disk.total) }}</span></div>
          <strong>{{ percent(server.disk?.percent) }}</strong>
          <div class="usage-track" :class="{ high: server.disk?.percent >= 90 }" aria-hidden="true"><i :style="{ width: width(server.disk?.percent) }"></i></div>
          <p v-if="server.disk">已用 {{ bytes(server.disk.used) }}<br>可用 {{ bytes(server.disk.available) }}</p><p v-else>系统未提供分区信息</p>
          <small>机器人数据所在文件系统</small>
        </article>
        <article class="resource-item process-item"><div class="resource-title">机器人进程 <span>Node.js</span></div>
          <strong class="process-memory">{{ bytes(server.process.rss) }}</strong>
          <div class="heap-caption">JS 堆 {{ bytes(server.process.heapUsed) }} / {{ bytes(server.process.heapTotal) }}</div>
          <p>进程运行 {{ uptime(server.process.uptimeSeconds) }}<br>系统运行 {{ uptime(server.uptimeSeconds) }}</p><small>进程占用不含 NapCat、视频子进程</small>
        </article>
      </div>
      <div class="gc-summary" v-if="gc">
        <div class="gc-plan"><span class="gc-icon" aria-hidden="true">↻</span><div><b>定时 GC<span v-if="gc.intervalMinutes && gc.available">每 {{ gc.intervalMinutes }} 分钟 · 空闲时执行</span></b><p>{{ gcStates[gc.state] || '等待状态' }}<template v-if="gc.nextAt"> · 下次 {{ timeText(gc.nextAt) }}</template><template v-if="gc.state === 'unavailable'">，使用标准启动命令后生效</template></p></div></div>
        <div class="gc-result"><template v-if="gc.lastRunAt"><b>已完成 {{ gc.runs }} 次</b><small>最近 {{ timeText(gc.lastRunAt) }} · JS 堆减少 {{ bytes(gc.lastFreedHeapBytes) }} · {{ gc.lastDurationMs }} ms</small></template><template v-else><b>尚未执行定时回收</b><small>Node.js 自动垃圾回收持续运行</small></template></div>
      </div>
      <p class="server-note">{{ server.platform === 'linux' ? 'Linux' : server.platform }} · {{ server.sampledAt ? timeText(server.sampledAt) : '—' }} 更新。系统资源由运行环境提供；JS 堆回收量不等同于整机内存减少量。</p>
    </template>
  </section>
</template>

<style scoped>
.server-panel { padding:26px 28px 18px; margin:24px 0; }.server-heading { display:flex; justify-content:space-between; align-items:center; gap:18px; margin-bottom:25px; }.server-kicker { display:block; color:var(--muted); font-size:9px; letter-spacing:1.7px; margin-bottom:7px; }.server-meta { display:flex; align-items:center; gap:14px; }.server-meta small { font-size:10px; color:var(--muted); }.server-pressure { display:inline-flex; align-items:center; gap:7px; font-size:11px; color:var(--muted); }.server-pressure i { width:6px; height:6px; border-radius:50%; background:currentColor; }.server-pressure.normal { color:var(--green); }.server-pressure.high { color:#ad7026; }.resource-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:24px; }.resource-item { min-width:0; padding-right:23px; border-right:1px solid var(--line); }.resource-item:last-child { padding-right:0; border-right:0; }.resource-title { display:flex; justify-content:space-between; gap:6px; flex-wrap:wrap; font-size:12px; font-weight:550; }.resource-title span { color:var(--muted); font-size:10px; font-weight:400; }.resource-item strong { display:block; font-size:29px; font-weight:550; letter-spacing:-1px; line-height:1.4; margin:14px 0 12px; font-variant-numeric:tabular-nums; white-space:nowrap; }.resource-item strong small { font-size:11px; margin-left:8px; font-weight:400; letter-spacing:0; }.usage-track { height:4px; border-radius:5px; background:#edf1ec; overflow:hidden; margin-bottom:17px; }.usage-track i { display:block; height:100%; border-radius:5px; background:#77a38b; transition:width .3s; }.usage-track.high i { background:#c39754; }.resource-item p { font-size:11px; line-height:1.85; margin:0 0 4px; color:#52685c; overflow-wrap:anywhere; }.resource-item > small { color:var(--muted); font-size:10px; line-height:1.6; }.resource-item .process-memory { font-size:26px; }.heap-caption { color:var(--green); font-size:10px; margin:0 0 13px; line-height:1.6; }.gc-summary { display:flex; justify-content:space-between; align-items:center; gap:20px; margin-top:25px; padding:18px 0 14px; border-top:1px solid var(--line); }.gc-plan { display:flex; align-items:center; gap:11px; min-width:0; }.gc-icon { display:grid; place-items:center; width:32px; height:32px; color:var(--green); background:var(--soft); border-radius:10px; font-size:22px; flex-shrink:0; }.gc-plan b,.gc-result b { display:block; font-size:11px; font-weight:550; }.gc-plan b span { margin-left:12px; color:var(--muted); font-weight:400; }.gc-plan p { color:var(--muted); font-size:10px; line-height:1.8; margin:5px 0 0; }.gc-result { text-align:right; }.gc-result small { display:block; font-size:10px; color:var(--muted); margin-top:6px; line-height:1.8; }.server-note { font-size:10px; color:var(--muted); line-height:1.8; margin:0; }.server-loading { padding:35px 0; font-size:12px; color:var(--muted); }
@media(max-width:1100px) { .resource-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px 20px; }.resource-item:nth-child(2) { border-right:0; padding-right:0; }.resource-item:nth-child(n+3) { padding-top:22px; border-top:1px solid var(--line); } }
@media(max-width:650px) { .server-panel { padding:20px 17px 16px; }.server-heading { align-items:flex-start; margin-bottom:22px; }.server-meta { align-items:flex-end; flex-direction:column; gap:6px; }.resource-grid { gap:20px 14px; }.resource-item { padding-right:13px; }.resource-item strong { font-size:26px; }.resource-item .process-memory { font-size:22px; }.resource-title { min-height:32px; align-content:flex-start; }.resource-title span { display:block; width:100%; }.resource-item p { font-size:11px; }.gc-summary { flex-direction:column; align-items:stretch; gap:15px; padding-top:18px; }.gc-plan b span { display:block; margin:5px 0 0; }.gc-result { text-align:left; padding-left:43px; }.server-note { margin-top:5px; } }
</style>

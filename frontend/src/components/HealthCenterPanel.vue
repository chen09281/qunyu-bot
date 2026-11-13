<script setup>
import { inject } from 'vue';
import { consoleKey } from '../composables/useConsole';
import WorkspaceIcon from './WorkspaceIcon.vue';
const c = inject(consoleKey);
const labels = { ok: '正常', degraded: '降级', error: '异常', disabled: '未配置', checking: '检查中' };
const channelNames = { rsshub: 'RSSHub', bilibili: 'B 站', douyin: '抖音' };
const dateText = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未成功';
const sourceState = entry => entry.probe ? (entry.probe.ok ? '最近探测正常' : '最近探测失败') : labels[entry.state] || '未知';
</script>

<template>
  <article class="card panel health-panel">
    <div class="panel-heading">
      <div><h2>订阅与解析健康</h2><p class="muted">通道状态、重试与只读检查，不影响订阅推送。</p></div>
      <div class="health-heading-actions"><span class="status-label" :class="c.state.health?.state">{{ labels[c.state.health?.state] || '读取中' }}</span><button class="secondary icon-button" :disabled="c.state.busy.health" @click="c.loadHealth(true)"><WorkspaceIcon name="refresh" />刷新</button></div>
    </div>
    <p v-if="c.state.healthError" class="error-text">{{ c.state.healthError }}</p>
    <div v-if="c.state.health" class="health-content">
      <div class="health-summary">
        <div v-for="channel in c.state.health.channels" :key="channel.id" class="health-channel" :class="channel.state">
          <span>{{ channelNames[channel.id] }}</span><strong>{{ labels[channel.state] }}</strong>
          <small>最近成功 {{ dateText(channel.lastSuccessAt) }}</small>
          <small v-if="channel.fallbacks.length">正在使用官方回退</small>
          <small v-else-if="channel.nextCheckAt">下次检查 {{ dateText(channel.nextCheckAt) }}</small>
        </div>
      </div>
      <div class="health-meta">
        <span>异常 {{ c.state.health.summary.abnormal }} · 警告 {{ c.state.health.summary.warnings }} · 待投递 {{ c.state.health.summary.pending }}</span>
        <span :class="{ 'error-text': !c.state.health.parser.available }">解析器：{{ c.state.health.parser.detail }}</span>
        <span>邮件告警：{{ c.state.config.emailAlertsEnabled ? '已启用' : '未启用' }}<template v-if="c.state.health.email.activeIncidents"> · {{ c.state.health.email.activeIncidents }} 个处理中事件</template></span>
      </div>
      <p v-if="c.state.health.email.lastAlertError" class="error-text">最近邮件发送失败：{{ c.state.health.email.lastAlertError }}</p>

      <details class="health-details">
        <summary>来源健康与只读检查 <span>{{ c.state.health.sources.length }} 个来源</span></summary>
        <div v-if="!c.state.health.sources.length" class="empty">尚未配置订阅来源</div>
        <div v-for="entry in c.state.health.sources" :key="entry.id" class="health-source">
          <div class="health-source-main">
            <div><b>{{ entry.name }}</b><span class="source-type">{{ entry.type }}</span></div>
            <p class="entry-meta">最近成功 {{ dateText(entry.lastReadAt) }} · {{ sourceState(entry) }}<template v-if="entry.failures"> · 连续失败 {{ entry.failures }} 次</template></p>
            <p v-if="entry.nextCheckAt && entry.state === 'error'" class="entry-meta">下次重试 {{ dateText(entry.nextCheckAt) }}<template v-if="entry.lastFailureStage"> · 阶段 {{ entry.lastFailureStage }}</template></p>
            <p v-if="entry.lastError" class="error-text">{{ entry.lastError }}</p>
            <p v-else-if="entry.lastWarning" class="warning-text">{{ entry.lastWarning }}</p>
            <p v-if="entry.lastFallbacks.length" class="entry-meta">RSSHub 不可用，当前由官方接口回退</p>
            <p v-if="entry.probe" class="entry-meta">只读检查 {{ dateText(entry.probe.checkedAt) }}：{{ entry.probe.ok ? `通过，${entry.probe.itemCount} 条内容` : entry.probe.error }}</p>
          </div>
          <button class="secondary" :disabled="c.state.busy[`healthProbe:${entry.id}`]" @click="c.probeSubscription(entry.id)">{{ c.state.busy[`healthProbe:${entry.id}`] ? '检查中…' : '只读检查' }}</button>
        </div>
      </details>

      <details class="health-details">
        <summary>异常邮件与 SMTP <span>{{ c.state.config.smtpPasswordConfigured ? '授权码已配置' : '尚未配置' }}</span></summary>
        <form class="smtp-form" @submit.prevent="c.saveHealthEmail">
          <label class="choice"><input v-model="c.state.healthEmail.emailAlertsEnabled" type="checkbox">连续三次异常时发送告警，恢复后发送恢复通知</label>
          <div class="field-grid">
            <label>SMTP 主机<input v-model="c.state.healthEmail.smtpHost" placeholder="smtp.qq.com" autocomplete="off" required></label>
            <label>端口<input v-model="c.state.healthEmail.smtpPort" type="number" min="1" max="65535" required></label>
            <label>SMTP 账号<input v-model="c.state.healthEmail.smtpUser" type="email" autocomplete="username" required></label>
            <label>告警收件邮箱<input v-model="c.state.healthEmail.emailAlertRecipient" type="email" autocomplete="email" required></label>
            <label>SMTP 授权码<input v-model="c.state.healthEmail.smtpPassword" type="password" autocomplete="new-password" :placeholder="c.state.config.smtpPasswordConfigured ? '已配置，留空保留原授权码' : '请输入授权码'" :required="!c.state.config.smtpPasswordConfigured"></label>
            <label>TLS 模式<select v-model="c.state.healthEmail.smtpSecure"><option :value="true">隐式 TLS（通常 465）</option><option :value="false">STARTTLS（通常 587）</option></select></label>
          </div>
          <p class="entry-meta">持续异常最多每六小时提醒一次；同一事件不重复发送。邮件不包含订阅正文或群聊内容。</p>
          <div class="form-actions"><button class="primary" type="submit" :disabled="c.state.busy.healthEmail">保存邮件配置</button><button class="secondary" type="button" :disabled="c.healthEmailDirty || !c.state.config.smtpPasswordConfigured || c.state.busy.testEmail" @click="c.testHealthEmail">{{ c.state.busy.testEmail ? '发送中…' : '发送测试邮件' }}</button></div>
          <p v-if="c.healthEmailDirty" class="entry-meta">有未保存修改，保存后才能发送测试邮件。</p>
          <p v-if="c.state.healthEmailResult" class="result-text" role="status">{{ c.state.healthEmailResult }}</p>
        </form>
      </details>
    </div>
    <div v-else class="empty">正在读取健康状态…</div>
  </article>
</template>

<style scoped>
.health-heading-actions,.health-meta,.form-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.health-heading-actions{justify-content:flex-end}.health-content{display:grid;gap:18px;margin-top:18px}.health-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.health-channel{display:grid;gap:5px;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--surface-soft)}.health-channel strong{font-size:18px}.health-channel small,.entry-meta{color:var(--muted);font-size:12px}.health-channel.ok strong{color:var(--success)}.health-channel.degraded strong{color:var(--warning)}.health-channel.error strong{color:var(--danger)}.health-channel.disabled strong{color:var(--muted)}.health-meta{justify-content:space-between;color:var(--muted);font-size:12px}.health-details{border-top:1px solid var(--line);padding-top:14px}.health-details summary{cursor:pointer;font-weight:650;display:flex;justify-content:space-between;gap:12px}.health-details summary span{font-weight:400;color:var(--muted);font-size:12px}.health-source{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--line)}.health-source:last-child{border-bottom:0}.health-source-main{min-width:0;display:grid;gap:5px}.health-source-main>div{display:flex;align-items:center;gap:8px}.source-type{font-size:11px;color:var(--muted);text-transform:uppercase}.health-source p{margin:0;overflow-wrap:anywhere}.warning-text{color:var(--warning);font-size:12px}.smtp-form{display:grid;gap:16px;margin-top:16px}.smtp-form label{display:grid;gap:6px;font-size:13px}.smtp-form label.choice{display:flex;align-items:center;gap:8px}.result-text{color:var(--success);font-size:13px}@media(max-width:760px){.health-summary{grid-template-columns:1fr}.health-source{flex-direction:column}.health-source button{width:100%}.health-heading-actions{justify-content:flex-start}}
</style>

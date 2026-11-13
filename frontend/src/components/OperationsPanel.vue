<script setup>
import { computed, inject, onMounted, reactive, ref } from 'vue';
import { consoleKey } from '../composables/useConsole';
import WorkspaceIcon from './WorkspaceIcon.vue';
const c = inject(consoleKey), draft = reactive({}), info = ref(null);
const loading = ref(false), saving = ref(false), sending = ref(false), editing = ref(false);
const error = ref(''), result = ref(''), period = ref('last-week');
const reportFilters = reactive({ provider: '', start: '', end: '' });
const busy = computed(() => loading.value || saving.value || sending.value);
const configured = computed(() => Boolean(info.value?.config.smtpHost && info.value?.config.smtpUser && info.value?.smtpPasswordConfigured && info.value?.config.emailAlertRecipient));
const dirty = computed(() => info.value && (Boolean(draft.smtpPassword?.trim()) || Object.keys(info.value.config).some(key => draft[key] !== info.value.config[key])));
const stamp = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
async function load() {
  loading.value = true; error.value = '';
  try {
    const first = !info.value;
    info.value = await c.api('operations');
    Object.assign(draft, info.value.config, { smtpPassword: '' });
    if (first) editing.value = !configured.value;
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}
async function save() {
  saving.value = true; error.value = ''; result.value = '';
  try {
    const patch = Object.fromEntries(Object.entries(draft).filter(([key, value]) => key === 'smtpPassword' ? Boolean(value.trim()) : value !== info.value.config[key]));
    await c.api('operations', { method: 'PUT', body: JSON.stringify(patch) });
    await load(); editing.value = !configured.value;
    c.notify('邮箱与通知设置已保存');
  } catch (e) { error.value = e.message; }
  finally { saving.value = false; }
}
async function send() {
  sending.value = true; error.value = ''; result.value = '';
  try {
    const sent = await c.api('operations/report', { method: 'POST', body: JSON.stringify({ period: period.value, provider: reportFilters.provider, ...(period.value === 'custom' ? { start: reportFilters.start, end: reportFilters.end } : {}) }) });
    info.value.lastManualReport = sent;
    result.value = `${sent.start} 至 ${sent.end} 的账单已提交邮箱服务，收件人：${sent.recipient}`;
    c.notify('账单邮件已发送');
  } catch (e) { error.value = e.message; }
  finally { sending.value = false; }
}
onMounted(load);
</script>

<template>
  <section class="card panel form-panel email-panel">
    <div class="panel-heading">
      <div><h2>邮箱与通知</h2><p class="muted">QQ 掉线提醒与每周账单，共用一套已保存的邮箱配置。</p></div>
      <span class="subtle-tag" :class="{ 'email-ready': configured }"><WorkspaceIcon :name="configured ? 'check' : 'alert'" />{{ configured ? '邮箱已配置' : '待配置邮箱' }}</span>
    </div>
    <p v-if="loading && !info" class="muted" role="status">正在读取邮箱设置…</p>
    <p v-if="error" class="result-text error-text" role="alert">{{ error }}</p>
    <template v-if="info">
      <div class="saved-mailbox">
        <span class="mailbox-icon"><WorkspaceIcon name="subscriptions" /></span>
        <div class="mailbox-copy"><small>已保存的收件邮箱</small><strong>{{ info.config.emailAlertRecipient || '尚未保存收件邮箱' }}</strong><p class="muted">发件账号：{{ info.config.smtpUser || '未配置' }}<template v-if="info.config.smtpHost"> · {{ info.config.smtpHost }}</template></p><small>{{ configured ? '日常使用无需重新填写，授权码已安全保存。' : '请展开邮箱设置，补齐 SMTP 与收件邮箱。' }}</small></div>
        <button type="button" class="secondary" :disabled="busy" @click="editing = !editing">{{ editing ? '收起设置' : '修改邮箱' }}</button>
      </div>
      <form @submit.prevent="save">
        <fieldset :disabled="busy" class="email-fields">
          <div v-if="editing" class="mailbox-editor">
            <div class="field-grid">
              <label>收件邮箱<input v-model="draft.emailAlertRecipient" type="email" placeholder="接收掉线提醒和账单的邮箱"><small>已保存的邮箱会自动填入，只在需要更换时修改。</small></label>
              <label>SMTP 发件账号<input v-model="draft.smtpUser" autocomplete="username" placeholder="sender@example.com"></label>
              <label>SMTP 主机<input v-model="draft.smtpHost" placeholder="smtp.example.com"></label>
              <label>SMTP 端口<input v-model.number="draft.smtpPort" type="number" min="1" max="65535"></label>
              <label>SMTP 授权码<input v-model="draft.smtpPassword" type="password" autocomplete="new-password" :placeholder="info.smtpPasswordConfigured ? '已保存，留空沿用' : '填写邮箱服务授权码'"><small>授权码不回显。更换发件账号、主机或连接方式时需重新填写。</small></label>
              <label>后台外网地址<input v-model="draft.consolePublicUrl" type="url" placeholder="https://bot.example.com"><small>用于掉线邮件中的 QQ 登录入口。</small></label>
            </div>
            <label class="mailbox-check"><input v-model="draft.smtpSecure" type="checkbox"><span>隐式 TLS<small>通常使用 465 端口；关闭后要求 STARTTLS。</small></span></label>
          </div>
          <div class="notification-grid">
            <div class="notification-option"><label class="mailbox-check"><input v-model="draft.emailAlertsEnabled" type="checkbox"><span><b>QQ 掉线邮件提醒</b><small>连续三次检测未在线后通知，恢复在线后重新监测。</small></span></label><p v-if="info.lastAlert" class="muted">最近告警：{{ stamp(info.lastAlert) }}</p></div>
            <div class="notification-option"><label class="mailbox-check"><input v-model="draft.billReportEnabled" type="checkbox"><span><b>每周账单邮件</b><small>每周一发送上周的费用、Token 和请求次数。</small></span></label><label class="report-time">发送时间（北京时间）<input v-model="draft.billReportTime" type="time" required></label></div>
          </div>
          <div class="form-actions mailbox-actions"><button class="primary" type="submit" :disabled="!dirty"><WorkspaceIcon name="check" />{{ saving ? '保存中…' : dirty ? '保存设置' : '设置已保存' }}</button><span class="muted">{{ dirty ? '有未保存的修改' : '将持续使用上方已保存的邮箱' }}</span></div>
        </fieldset>
      </form>
      <div class="manual-report">
        <div><h3>手动发送账单</h3><p class="muted">按日期和 API 筛选后发往已保存的邮箱。邮件内的 Token 明细、请求趋势图和 Token 图表放在折叠区；每周自动邮件默认包含全部 API。</p></div>
        <div class="manual-actions"><label>账单范围<select v-model="period" :disabled="busy"><option value="last-week">上周完整账单</option><option value="week">本周截至现在</option><option value="custom">自定义日期</option></select></label><label>API 渠道<select v-model="reportFilters.provider" :disabled="busy"><option value="">全部 API</option><option value="deepseek">DeepSeek</option><option value="kimi">Kimi</option><option value="openai">OpenAI</option></select></label><template v-if="period === 'custom'"><label>开始日期<input v-model="reportFilters.start" type="date" :disabled="busy"></label><label>结束日期<input v-model="reportFilters.end" type="date" :disabled="busy"></label></template><button class="secondary" type="button" :disabled="busy || !configured || dirty" @click="send"><WorkspaceIcon name="arrow" />{{ sending ? '正在发送…' : '发送账单邮件' }}</button></div>
        <small v-if="dirty" class="muted">请先保存修改，再按新配置发送。</small><small v-else-if="!configured" class="muted">请先补齐并保存邮箱配置。</small>
        <p v-if="result" class="result-text" role="status">{{ result }}</p>
        <p v-else-if="info.lastManualReport" class="muted" role="status">上次手动发送：{{ stamp(info.lastManualReport.at) }} · {{ info.lastManualReport.status === 'sent' ? '已提交邮箱服务' : info.lastManualReport.status === 'failed' ? '发送失败' : '发送未确认' }} · {{ info.lastManualReport.recipient }}</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.email-panel { display: grid; gap: 20px; }
.email-panel .panel-heading { margin: 0; flex-wrap: wrap; gap: 12px; }
.email-panel h2,.email-panel h3,.email-panel p { margin: 0; }
.email-panel .panel-heading p { margin-top: 8px; font-size: 13px; }
.email-ready { color: var(--accent); }
.subtle-tag { display: inline-flex; align-items: center; gap: 6px; }
.subtle-tag .workspace-icon { width: 16px; height: 16px; }
.saved-mailbox { display: flex; gap: 16px; align-items: center; padding: 20px; border: 1px solid var(--line); border-radius: 14px; background: var(--soft); }
.mailbox-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; background: var(--panel); color: var(--accent); flex-shrink: 0; }
.mailbox-copy { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.mailbox-copy strong { display: block; font-size: 19px; margin: 5px 0; color: var(--ink); }
.mailbox-copy p { font-size: 12px; line-height: 1.8; }
.email-fields { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: 20px; }
.mailbox-editor { padding-bottom: 20px; border-bottom: 1px solid var(--line); }
.notification-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; }
.notification-option { padding: 18px; border: 1px solid var(--line); border-radius: 12px; }
.mailbox-check { display: flex; gap: 10px; align-items: flex-start; margin: 0; cursor: pointer; }
.mailbox-check input[type=checkbox] { width: 17px; height: 17px; flex-shrink: 0; margin: 3px 0 0; accent-color: var(--accent); }
.mailbox-check small { display: block; margin-top: 5px; font-weight: normal; }
.mailbox-editor>.mailbox-check { margin-top: 16px; }
.report-time { display: flex; align-items: center; gap: 12px; margin: 16px 0 0; font-size: 12px; flex-wrap: wrap; }
.report-time input { width: 130px; }
.mailbox-actions { margin: 0; align-items: center; }
.mailbox-actions .muted { font-size: 12px; }
.manual-report { border-top: 1px solid var(--line); padding-top: 20px; display: grid; gap: 14px; }
.manual-report h3 { font-size: 15px; margin-bottom: 7px; }
.manual-report p { font-size: 13px; }
.manual-actions { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; }
.manual-actions label { margin: 0; min-width: 190px; }
@media(max-width:750px) { .saved-mailbox { flex-wrap: wrap; padding: 16px; }.saved-mailbox>.secondary { width: 100%; }.notification-grid { grid-template-columns: 1fr; }.manual-actions>* { flex: 1 1 100%; } }
</style>

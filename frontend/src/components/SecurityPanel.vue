<script setup>
import { inject } from 'vue';
import { consoleKey } from '../composables/useConsole';
const c = inject(consoleKey);
</script>

<template>
  <section id="page-security" class="page">
    <div class="page-heading"><div><span class="eyebrow">KEEP YOUR CONSOLE PRIVATE</span><h1>管理账号安全<span class="title-dot">.</span></h1><p class="muted">当前账号 {{ c.state.adminUsername }} · 支持两步验证（TOTP）、聊天记录保留策略与在线加密备份导出。</p></div></div>
    <div class="two-columns settings-columns security-grid">
      <form class="card panel form-panel" @submit.prevent="c.changePassword">
        <h2>修改管理密码</h2>
        <p class="muted">修改密码后所有已登录设备都需要重新登录。</p>
        <label>当前密码<input v-model="c.state.password.currentPassword" type="password" autocomplete="current-password" required maxlength="256"></label>
        <label>新密码<input v-model="c.state.password.newPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="256"><small>至少 8 个字符，修改后需要重新登录。</small></label>
        <label>确认新密码<input v-model="c.state.password.confirmPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="256"></label>
        <button class="primary" type="submit" :disabled="c.state.busy.password">{{ c.state.busy.password ? '更新中…' : '更新密码' }}</button>
      </form>

      <article id="security-totp-card" class="card panel form-panel">
        <div class="panel-heading">
          <h2>两步验证（TOTP MFA）</h2>
          <span class="pill" :class="{ on: c.state.totpEnabled }">{{ c.state.totpEnabled ? '已启用' : '未启用' }}</span>
        </div>
        <p class="muted">使用 Microsoft / Google Authenticator、1Password 等身份验证器生成 6 位动态验证码，防止密码泄露后被直接登录。</p>

        <template v-if="!c.state.totpEnabled">
          <div v-if="!c.state.totpSetup.secret" class="form-actions">
            <button id="totp-start-btn" class="primary" type="button" :disabled="c.state.busy.totp" @click="c.startTotpSetup">{{ c.state.busy.totp ? '生成中…' : '生成绑定二维码' }}</button>
          </div>
          <form v-else class="totp-form" @submit.prevent="c.enableTotp">
            <div class="totp-qr-wrap">
              <img class="totp-qr" :src="c.state.totpSetup.qrDataUrl" width="180" height="180" alt="TOTP 绑定二维码">
              <div class="totp-secret-copy">
                <small>无法扫码时可手动输入密钥（SHA1 · 30 秒）：</small>
                <code class="totp-secret">{{ c.state.totpSetup.secret }}</code>
              </div>
            </div>
            <label>当前管理密码<input v-model="c.state.totpSetup.currentPassword" type="password" autocomplete="current-password" required maxlength="256"></label>
            <label>6 位动态验证码<input v-model="c.state.totpSetup.code" type="text" inputmode="numeric" autocomplete="one-time-code" required maxlength="8" placeholder="例如 123456"></label>
            <div class="form-actions">
              <button class="primary" type="submit" :disabled="c.state.busy.totp">{{ c.state.busy.totp ? '验证中…' : '确认启用两步验证' }}</button>
              <button class="secondary" type="button" :disabled="c.state.busy.totp" @click="c.startTotpSetup">刷新二维码</button>
            </div>
          </form>
        </template>

        <template v-else>
          <div v-if="c.state.totpSetup.recoveryCodes.length" class="callout" role="status">
            <b>请立即保存以下一次性恢复码</b>
            <p>手机丢失或更换时，每个恢复码可替代动态验证码使用一次；刷新页面后将不再显示：</p>
            <div class="recovery-grid"><code v-for="code in c.state.totpSetup.recoveryCodes" :key="code">{{ code }}</code></div>
          </div>
          <form class="totp-form" @submit.prevent="c.disableTotp">
            <label>当前管理密码<input v-model="c.state.totpDisable.currentPassword" type="password" autocomplete="current-password" required maxlength="256"></label>
            <label>动态验证码或恢复码<input v-model="c.state.totpDisable.code" type="text" autocomplete="one-time-code" required maxlength="32" placeholder="6 位数字或恢复码"></label>
            <button class="secondary danger-btn" type="submit" :disabled="c.state.busy.totp">{{ c.state.busy.totp ? '处理中…' : '关闭两步验证' }}</button>
          </form>
        </template>
        <p class="footnote">若设备与恢复码全部丢失，服务器管理员可运行 <code>npm run reset-password</code> 重置密码并解除两步验证。</p>
      </article>

      <form id="security-retention-card" class="card panel form-panel" @submit.prevent="c.saveRetentionDays">
        <h2>聊天记录保留策略</h2>
        <p class="muted">设置自动清理周期。后台每小时按北京时间清理超出保留天数的历史消息并执行数据库空间整理。</p>
        <label>自动保留天数<input id="retention-days-input" v-model="c.state.retentionDays" type="number" min="0" max="3650" required><small>填 0 表示长期保留；填 1–3650 表示仅保留最近 N 天记录。如需立即手工清理，请前往「聊天记录」页面。</small></label>
        <button class="primary" type="submit" :disabled="c.state.busy.retention">{{ c.state.busy.retention ? '保存中…' : '保存保留策略' }}</button>
      </form>

      <form id="security-backup-card" class="card panel form-panel" @submit.prevent="c.exportEncryptedBackup">
        <h2>在线导出加密备份</h2>
        <p class="muted">打包全部配置、凭证、聊天数据库、签到与订阅状态，并用 <code>AES-256-GCM</code> 加密为 <code>.qqbak.enc</code> 文件下载到本机。</p>
        <label>当前管理密码<input id="backup-current-password" v-model="c.state.backupExport.currentPassword" type="password" autocomplete="current-password" required maxlength="256"></label>
        <label>备份加密口令<input id="backup-passphrase" v-model="c.state.backupExport.backupPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="256"><small>至少 8 个字符；恢复时需使用相同口令：<code>npm run restore -- 备份文件 口令</code></small></label>
        <button class="primary" type="submit" :disabled="c.state.busy.backup">{{ c.state.busy.backup ? '加密打包中…' : '导出加密备份' }}</button>
      </form>
    </div>
  </section>
</template>

<style scoped>
.security-grid { gap: 22px; }
.totp-form { display: grid; gap: 14px; margin-top: 14px; }
.totp-qr-wrap { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: #fbfcfa; }
.totp-qr { border-radius: 8px; border: 1px solid var(--line); background: #fff; }
.totp-secret-copy { display: grid; gap: 6px; min-width: 0; flex: 1; }
.totp-secret { word-break: break-all; font-size: 12px; padding: 6px 8px; background: var(--soft); border-radius: 6px; color: var(--green); }
.recovery-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin-top: 10px; }
.recovery-grid code { text-align: center; padding: 6px 8px; background: #fff; border: 1px solid var(--line); border-radius: 6px; font-weight: 600; color: var(--ink); }
.danger-btn { color: var(--red); border-color: #e6c6c6; }
.danger-btn:hover { background: #fdf3f3; }
</style>

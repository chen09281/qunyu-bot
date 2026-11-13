import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivate } from './config.mjs';

const clean = (value, limit = 500) => String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, limit);
const safeError = error => {
  const code = String(error?.code || '').toUpperCase();
  if (['EAUTH', 'EAUTHEN'].includes(code) || error?.responseCode === 535) return 'SMTP 认证失败，请检查账号和授权码';
  if (['ESOCKET', 'ECONNECTION', 'ETIMEDOUT', 'ECONNREFUSED'].includes(code)) return 'SMTP 连接失败，请检查主机、端口、TLS 和网络';
  if (['EENVELOPE', 'EADDRESS'].includes(code)) return '发件人或收件邮箱不被 SMTP 服务接受';
  return '邮件发送失败，请检查 SMTP 配置和服务状态';
};
export function smtpOptions(config) {
  return { host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure,
    ...(!config.smtpSecure ? { requireTLS: true } : {}),
    auth: { user: config.smtpUser, pass: config.smtpPassword },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    tls: { minVersion: 'TLSv1.2' } };
}
export class EmailAlerts {
  constructor(dataDir, store, { sendMail = null, transportFactory = null, now = Date.now, reminderMs = 6 * 3600000 } = {}) {
    this.store = store; this.path = join(dataDir, 'email-alerts.json'); this.sendMail = sendMail;
    this.transportFactory = transportFactory || null;
    this.now = now; this.reminderMs = reminderMs; this.streaks = new Map(); this.incidents = new Map(); this.pending = new Map(); this.transports = new Set();
    this.testing = false; this.closed = false; this.lastAlertAt = null; this.lastAlertError = '';
    if (existsSync(this.path)) {
      const saved = JSON.parse(readFileSync(this.path, 'utf8'));
      if (saved.version !== 1 || typeof saved.incidents !== 'object' || !saved.incidents) throw new Error('邮件告警状态读取失败');
      this.incidents = new Map(Object.entries(saved.incidents)); this.lastAlertAt = saved.lastAlertAt || null;
    }
  }
  status() { return { lastAlertAt: this.lastAlertAt, lastAlertError: this.lastAlertError, activeIncidents: [...this.incidents.values()].filter(item => item.notifiedAt).length, testing: this.testing }; }
  persist() {
    try { writePrivate(this.path, { version: 1, incidents: Object.fromEntries(this.incidents), lastAlertAt: this.lastAlertAt }); }
    catch { this.lastAlertError = '邮件告警状态保存失败，请检查数据目录'; }
  }
  config(required = false) {
    const config = this.store.config;
    if (!required && !config.emailAlertsEnabled) return null;
    if (!config.smtpHost || !config.smtpUser || !config.smtpPassword || !config.emailAlertRecipient) {
      const error = new Error('请先完整保存 SMTP 主机、账号、授权码和收件邮箱'); error.status = 400; throw error;
    }
    return config;
  }
  async deliver(subject, text, required = false) {
    const config = this.config(required);
    if (this.sendMail) return this.sendMail({ from: config.smtpUser, to: config.emailAlertRecipient, subject, text });
    const transportFactory = this.transportFactory || (await import('nodemailer')).default.createTransport;
    const transport = transportFactory(smtpOptions(config)); this.transports.add(transport);
    try { return await transport.sendMail({ from: config.smtpUser, to: config.emailAlertRecipient, subject, text }); }
    finally { this.transports.delete(transport); transport.close(); }
  }
  async testEmail() {
    if (this.testing) throw Object.assign(new Error('测试邮件正在发送，请稍候'), { status: 429 });
    this.config(true); this.testing = true;
    try {
      await this.deliver('QQ Bot SMTP 测试邮件', `这是一封来自 QQ Bot 管理后台的测试邮件。\n发送时间：${new Date(this.now()).toISOString()}\n仅用于验证 SMTP 配置。`, true);
      return { ok: true, sentAt: new Date(this.now()).toISOString() };
    } catch (error) { throw Object.assign(new Error(safeError(error)), { status: 502 }); }
    finally { this.testing = false; }
  }
  async notify(key, type, snapshot, signature = '') {
    if (this.pending.has(key)) return this.pending.get(key);
    const task = (async () => {
      try {
        this.config();
        const recovery = type === 'recovery', name = clean(snapshot.name || snapshot.id, 80);
        const subject = `QQ Bot ${recovery ? '恢复通知' : '异常告警'}：${name}`;
        const lines = [recovery ? '订阅通道已恢复正常。' : '订阅通道连续异常，请检查。', `来源：${name}`, `类型：${clean(snapshot.type, 30)}`, `检查时间：${clean(snapshot.checkedAt || new Date(this.now()).toISOString(), 40)}`];
        if (!recovery) {
          if (snapshot.stage) lines.push(`阶段：${clean(snapshot.stage, 40)}`);
          if (snapshot.error) lines.push(`错误：${clean(snapshot.error)}`);
          if (snapshot.warning) lines.push(`警告：${clean(snapshot.warning)}`);
          if (snapshot.nextCheckAt) lines.push(`下次重试：${clean(snapshot.nextCheckAt, 40)}`);
        }
        await this.deliver(subject, lines.join('\n'));
        this.lastAlertError = '';
        if (recovery) this.incidents.delete(key);
        else {
          const notifiedAt = new Date(this.now()).toISOString(); this.lastAlertAt = notifiedAt;
          this.incidents.set(key, { signature, notifiedAt, name: clean(snapshot.name, 80), type: clean(snapshot.type, 30) });
        }
        this.persist(); return true;
      } catch (error) { this.lastAlertError = safeError(error); return false; }
    })();
    this.pending.set(key, task);
    try { return await task; } finally { this.pending.delete(key); }
  }
  async observe(snapshot) {
    if (this.closed || !snapshot?.id) return;
    const key = String(snapshot.id), healthy = snapshot.state !== 'error';
    if (this.pending.has(key)) await this.pending.get(key).catch(() => {});
    if (this.closed) return;
    if (healthy) {
      this.streaks.delete(key);
      const incident = this.incidents.get(key);
      if (incident?.notifiedAt) await this.notify(key, 'recovery', snapshot);
      else if (incident) { this.incidents.delete(key); this.persist(); }
      return;
    }
    const streak = Math.min(3, (this.streaks.get(key) || 0) + 1); this.streaks.set(key, streak);
    if (streak < 3) return;
    const signature = clean([snapshot.stage, snapshot.error, snapshot.warning, ...(snapshot.fallbacks || [])].filter(Boolean).join('|'));
    const incident = this.incidents.get(key);
    if (incident?.notifiedAt && incident.signature === signature && this.now() - Date.parse(incident.notifiedAt) < this.reminderMs) return;
    await this.notify(key, 'alert', snapshot, signature);
  }
  reset(id) {
    const key = String(id); this.streaks.delete(key);
    if (this.incidents.delete(key)) this.persist();
  }
  close() {
    this.closed = true; this.streaks.clear();
    for (const transport of this.transports) { try { transport.close(); } catch {} }
    this.transports.clear();
  }
}

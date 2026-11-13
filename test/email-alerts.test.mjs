import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EmailAlerts, smtpOptions } from '../src/email-alerts.mjs';
import { defaultConfig, publicConfig, validatePatch } from '../src/config.mjs';

const folder = t => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-email-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const smtp = { emailAlertsEnabled: true, smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecure: true, smtpUser: 'bot@example.com', smtpPassword: 'PRIVATE_SMTP_SECRET', emailAlertRecipient: 'admin@example.com' };
const event = { id: 'entry-1', name: '测试作者', type: 'bilibili', state: 'error', stage: 'reading', error: 'RSSHub 读取失败', warning: '', checkedAt: '2026-11-04T01:00:00.000Z', nextCheckAt: '2026-11-04T01:10:00.000Z' };

test('SMTP 配置校验、秘密字段隐藏和 TLS 选项正确', () => {
  assert.throws(() => validatePatch(defaultConfig(), { emailAlertsEnabled: true }), /完整填写/);
  assert.throws(() => validatePatch(defaultConfig(), { smtpHost: 'https://smtp.example.com' }), /不要包含协议/);
  assert.throws(() => validatePatch(defaultConfig(), { emailAlertRecipient: 'invalid' }), /邮箱格式/);
  const config = validatePatch(defaultConfig(), smtp);
  assert.equal(publicConfig(config).smtpPassword, undefined); assert.equal(publicConfig(config).smtpPasswordConfigured, true);
  assert.throws(() => validatePatch(config, { smtpHost: 'smtp.other.example' }), /重新填写授权码/);
  const secure = smtpOptions(config); assert.equal(secure.secure, true); assert.equal(secure.requireTLS, undefined); assert.equal(secure.tls.minVersion, 'TLSv1.2');
  const starttls = smtpOptions({ ...config, smtpSecure: false, smtpPort: 587 }); assert.equal(starttls.secure, false); assert.equal(starttls.requireTLS, true);
});

test('连续三次异常才通知，恢复也通知，持续异常每六小时最多提醒一次', async t => {
  const dir = folder(t), sent = []; let now = Date.parse('2026-11-04T01:00:00.000Z');
  const alerts = new EmailAlerts(dir, { config: { ...defaultConfig(), ...smtp } }, { sendMail: async mail => sent.push(mail), now: () => now }); t.after(() => alerts.close());
  await alerts.observe(event); await alerts.observe(event); assert.equal(sent.length, 0);
  await alerts.observe(event); assert.equal(sent.length, 1); assert.match(sent[0].subject, /异常告警/);
  await alerts.observe(event); assert.equal(sent.length, 1);
  now += 6 * 3600000 + 1; await alerts.observe(event); assert.equal(sent.length, 2);
  await alerts.observe({ ...event, state: 'ok', error: '' }); assert.equal(sent.length, 3); assert.match(sent[2].subject, /恢复通知/);
  await alerts.observe({ ...event, state: 'ok', error: '' }); assert.equal(sent.length, 3);
  const saved = JSON.parse(readFileSync(alerts.path, 'utf8')); assert.equal(Object.keys(saved.incidents).length, 0);
  assert.ok(!JSON.stringify(sent).includes('PRIVATE_SMTP_SECRET'));
});

test('SMTP 失败不记录已通知，后续可重试；并发健康事件不重复发信', async t => {
  const dir = folder(t); let calls = 0, release;
  const alerts = new EmailAlerts(dir, { config: { ...defaultConfig(), ...smtp } }, { sendMail: async () => {
    calls++; if (calls === 1) throw Object.assign(new Error('535 PRIVATE_SMTP_SECRET'), { code: 'EAUTH', responseCode: 535 });
    await new Promise(resolve => { release = resolve; });
  } }); t.after(() => alerts.close());
  await alerts.observe(event); await alerts.observe(event); await alerts.observe(event);
  assert.equal(alerts.incidents.size, 0); assert.match(alerts.status().lastAlertError, /认证失败/); assert.ok(!alerts.status().lastAlertError.includes('PRIVATE_SMTP_SECRET'));
  const first = alerts.observe(event), second = alerts.observe(event); await new Promise(resolve => setImmediate(resolve)); release();
  await Promise.all([first, second]); assert.equal(calls, 2); assert.equal(alerts.incidents.size, 1);
});

test('重启后同一事件不重复告警，测试邮件不依赖告警开关且不修改事件', async t => {
  const dir = folder(t), sent = [], store = { config: { ...defaultConfig(), ...smtp } };
  const alerts = new EmailAlerts(dir, store, { sendMail: async mail => sent.push(mail) });
  for (let i = 0; i < 3; i++) await alerts.observe(event); assert.equal(sent.length, 1); alerts.close();
  const restored = new EmailAlerts(dir, store, { sendMail: async mail => sent.push(mail) }); t.after(() => restored.close());
  for (let i = 0; i < 3; i++) await restored.observe(event); assert.equal(sent.length, 1);
  store.config.emailAlertsEnabled = false;
  const result = await restored.testEmail(); assert.equal(result.ok, true); assert.equal(sent.length, 2); assert.match(sent[1].subject, /测试邮件/);
  assert.equal(restored.incidents.size, 1);
});

test('删除来源会清除事件，SMTP 错误不会泄露原始响应', async t => {
  const dir = folder(t), alerts = new EmailAlerts(dir, { config: { ...defaultConfig(), ...smtp } }, { sendMail: async () => { throw new Error('SMTP raw PRIVATE_SMTP_SECRET'); } }); t.after(() => alerts.close());
  await assert.rejects(alerts.testEmail(), error => error.status === 502 && !error.message.includes('PRIVATE_SMTP_SECRET'));
  alerts.streaks.set('entry-1', 2); alerts.incidents.set('entry-1', { signature: 'x', notifiedAt: new Date().toISOString() }); alerts.reset('entry-1');
  assert.equal(alerts.streaks.size, 0); assert.equal(alerts.incidents.size, 0);
});

test('降级状态（如走备援通道）不触发异常告警，异常恢复到降级或正常后发送恢复通知', async t => {
  const dir = folder(t), sent = [];
  const alerts = new EmailAlerts(dir, { config: { ...defaultConfig(), ...smtp } }, { sendMail: async mail => sent.push(mail) }); t.after(() => alerts.close());
  const degraded = { ...event, state: 'degraded', error: '', stage: '', fallbacks: ['bilibili-official-dynamic'] };
  for (let i = 0; i < 5; i++) await alerts.observe(degraded);
  assert.equal(sent.length, 0);
  for (let i = 0; i < 3; i++) await alerts.observe(event);
  assert.equal(sent.length, 1); assert.match(sent[0].subject, /异常告警/);
  await alerts.observe(degraded);
  assert.equal(sent.length, 2); assert.match(sent[1].subject, /恢复通知/);
  await alerts.observe({ ...event, state: 'ok', error: '' });
  assert.equal(sent.length, 2);
});

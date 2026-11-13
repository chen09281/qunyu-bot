import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { configPatch } from '../frontend/src/composables/useConsole.js';

test('SMTP 草稿省略空白授权码并转换端口和开关', () => {
  const patch = configPatch({ emailAlertsEnabled: true, smtpHost: ' smtp.example.com ', smtpPort: '587', smtpSecure: false,
    smtpUser: ' bot@example.com ', smtpPassword: '', emailAlertRecipient: ' admin@example.com ' },
  ['emailAlertsEnabled', 'smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPassword', 'emailAlertRecipient']);
  assert.deepEqual(patch, { emailAlertsEnabled: true, smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecure: false,
    smtpUser: 'bot@example.com', emailAlertRecipient: 'admin@example.com' });
});

test('主页健康组件渲染通道、来源只读检查和 SMTP 设置', async t => {
  const { createServer } = await import('vite'), vite = await createServer({ appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  t.after(() => vite.close());
  const { default: HealthCenterPanel } = await vite.ssrLoadModule('/src/components/HealthCenterPanel.vue');
  const { default: WorkspaceIcon } = await vite.ssrLoadModule('/src/components/WorkspaceIcon.vue');
  const { consoleKey } = await vite.ssrLoadModule('/src/composables/useConsole.js');
  const state = {
    health: { state: 'degraded', summary: { sources: 1, abnormal: 0, warnings: 1, pending: 2 },
      channels: [{ id: 'rsshub', state: 'degraded', lastSuccessAt: '2026-11-04T01:00:00.000Z', nextCheckAt: null, fallbacks: ['bilibili-official-dynamic'] },
        { id: 'bilibili', state: 'ok', lastSuccessAt: '2026-11-04T01:00:00.000Z', nextCheckAt: null, fallbacks: [] },
        { id: 'douyin', state: 'disabled', lastSuccessAt: null, nextCheckAt: null, fallbacks: [] }],
      sources: [{ id: 'a', name: '测试作者', type: 'bilibili', state: 'degraded', lastReadAt: '2026-11-04T01:00:00.000Z', nextCheckAt: null,
        failures: 0, lastFailureStage: '', lastError: '', lastWarning: '', lastFallbacks: ['bilibili-official-dynamic'], probe: null }],
      parser: { available: true, detail: '解析器已就绪' }, email: { activeIncidents: 0, lastAlertError: '' } },
    config: { emailAlertsEnabled: false, smtpPasswordConfigured: true }, healthEmail: { emailAlertsEnabled: false, smtpHost: 'smtp.example.com', smtpPort: 465,
      smtpSecure: true, smtpUser: 'bot@example.com', smtpPassword: '', emailAlertRecipient: 'admin@example.com' },
    busy: {}, healthError: '', healthEmailResult: '',
  };
  const app = createSSRApp(HealthCenterPanel);
  app.provide(consoleKey, { state, healthEmailDirty: false, loadHealth() {}, probeSubscription() {}, saveHealthEmail() {}, testHealthEmail() {} });
  app.component('WorkspaceIcon', WorkspaceIcon);
  const html = await renderToString(app);
  assert.match(html, /订阅与解析健康/); assert.match(html, /RSSHub/); assert.match(html, /只读检查/); assert.match(html, /异常邮件与 SMTP/);
  assert.match(html, /测试作者/); assert.match(html, /授权码已配置/);
});

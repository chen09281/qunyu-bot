import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../src/server.mjs';
import { chromiumPath } from '../src/douyin-browser.mjs';
import { totpCode } from '../src/totp.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = existsSync(join(rootDir, 'dist', 'index.html'));
const chromeExecutable = chromiumPath();

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result || {});
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const desc = msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || 'Runtime exception';
        this.errors.push(`RuntimeException: ${desc}`);
      } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        this.errors.push(`BrowserLog(${msg.params.entry.source}): ${msg.params.entry.text}`);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const text = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
        this.errors.push(`ConsoleError: ${text}`);
      }
    });
  }
  call(method, params = {}, sessionId = this.sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evalJs(expression) {
    const res = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'JS eval failed');
    }
    return res.result?.value;
  }
  async waitFor(expression, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.evalJs(expression);
      if (value) return value;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  }
}

async function launchChrome(profileDir) {
  const child = spawn(chromeExecutable, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--window-size=1280,900',
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome launch timeout')), 15000);
    timer.unref();
    let tail = '';
    const finish = (err, val) => { clearTimeout(timer); child.stderr.off('data', onData); err ? reject(err) : resolve(val); };
    const onData = chunk => {
      tail = (tail + chunk.toString()).slice(-4096);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/.exec(tail);
      if (match) finish(null, match[1]);
    };
    child.stderr.on('data', onData);
    child.once('error', err => finish(err));
    child.once('exit', code => finish(new Error(`Chrome exited early (${code})`)));
  });

  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 10000);
    timer.unref();
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket error')); }, { once: true });
  });

  const cdp = new CdpClient(ws);
  const { targetId } = await cdp.call('Target.createTarget', { url: 'about:blank' }, null);
  cdp.sessionId = (await cdp.call('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId;
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');
  await cdp.call('Log.enable');
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__cspViolations = []; document.addEventListener('securitypolicyviolation', e => window.__cspViolations.push(e.violatedDirective + ':' + e.blockedURI));`
  });
  return {
    cdp,
    close: () => {
      try { ws.close(); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    }
  };
}

test('真实 Headless 浏览器端到端冒烟：建号、路由切换、聊天清理、TOTP 启用与两步登录、CSP 零违规', {
  skip: !built ? '需要先运行 npm run build' : (!chromeExecutable ? '本机未安装 Chrome / Chromium' : false)
}, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-e2e-data-'));
  const profileDir = mkdtempSync(join(tmpdir(), 'qqbot-e2e-chrome-'));
  const app = await createApplication({
    dataDir,
    bilibiliAutoStart: false,
    douyinAutoStart: false,
    checkinAutoStart: false,
    subscriptionAutoStart: false,
    scheduledChatAutoStart: false,
    serverStatusAutoStart: false,
    operationsAutoStart: false
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  // Seed one conversation so ChatsPanel renders a live thread + delete action
  const seeded = app.bot.conversations.begin(
    { self_id: '10000', message_type: 'private', user_id: '20001', sender: { nickname: '测试好友' } },
    '你好，群屿',
    'deepseek-chat',
    'log-e2e-1'
  );
  app.bot.conversations.finish(seeded.turnId, { status: 'sent', reply: '你好！我是测试回复。', tokens: 12 });

  const browser = await launchChrome(profileDir);
  const { cdp } = browser;
  const fillInput = (selector, value) => `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Missing selector: ' + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;

  try {
    await cdp.call('Page.navigate', { url: `${baseUrl}/` });
    await cdp.waitFor(`!!document.querySelector('#setup-username')`);
    await cdp.evalJs(fillInput('#setup-username', 'admin'));
    await cdp.evalJs(fillInput('#setup-password', 'StrongPass123!'));
    await cdp.evalJs(fillInput('#setup-confirm', 'StrongPass123!'));
    await cdp.evalJs(`document.querySelector('form button[type="submit"]').click()`);
    await cdp.waitFor(`!!document.querySelector('#page-overview')`);

    // Navigate to Tavern page via sidebar button and check scope mode selector
    await cdp.evalJs(`Array.from(document.querySelectorAll('.nav-item')).find(b => b.textContent.includes('酒馆')).click()`);
    await cdp.waitFor(`!!document.querySelector('.tavern-panel') && !!document.querySelector('.scope-mode-select')`);

    // Navigate to Live Tasks page and verify empty-state right card & refresh button stay steady across 1s polls
    await cdp.evalJs(`Array.from(document.querySelectorAll('.nav-item')).find(b => b.textContent.includes('实时任务')).click()`);
    await cdp.waitFor(`document.querySelector('#page-live .detail-empty')?.textContent?.includes('选择一条任务')`);
    await cdp.evalJs(`(() => {
      const detail = document.querySelector('#page-live .task-detail');
      const refreshBtn = document.querySelector('#page-live .page-heading button');
      window.__liveMutations = 0;
      window.__liveInitialHeight = detail.getBoundingClientRect().height;
      const obs = new MutationObserver(() => { window.__liveMutations++; });
      obs.observe(detail, { childList: true, characterData: true, attributes: true, subtree: true });
      obs.observe(refreshBtn, { attributes: true, attributeFilter: ['disabled'] });
      window.__liveObserver = obs;
    })()`);
    await new Promise(resolve => setTimeout(resolve, 2300));
    const liveCheck = await cdp.evalJs(`(() => {
      window.__liveObserver.disconnect();
      const detail = document.querySelector('#page-live .task-detail');
      return { mutations: window.__liveMutations, heightDelta: Math.abs(detail.getBoundingClientRect().height - window.__liveInitialHeight) };
    })()`);
    assert.deepEqual(liveCheck, { mutations: 0, heightDelta: 0 });

    // Navigate to Plugins -> Fun Workshop & save a toggle
    await cdp.evalJs(`Array.from(document.querySelectorAll('.nav-item')).find(b => b.textContent.includes('插件')).click()`);
    await cdp.waitFor(`!!document.querySelector('#fun-plugin-title')`);
    await cdp.evalJs(`document.querySelector('#fun-plugin-title').closest('button').click()`);
    await cdp.waitFor(`!!document.querySelector('.fun-workspace')`);
    await cdp.evalJs(`document.querySelector('.fun-workspace button.primary').click()`);
    await cdp.waitFor(`document.querySelector('.toast')?.textContent?.includes('群聊娱乐设置已保存')`);

    // Navigate to Chats page, verify prune panel + delete active conversation
    await cdp.evalJs(`Array.from(document.querySelectorAll('.nav-item')).find(b => b.textContent.includes('聊天记录')).click()`);
    await cdp.waitFor(`!!document.querySelector('.chat-prune-box') && document.querySelectorAll('.session-item').length === 1`);
    await cdp.evalJs(`document.querySelector('.session-item').click()`);
    await cdp.waitFor(`!!document.querySelector('.topic-buttons .danger-btn')`);
    await cdp.evalJs(`document.querySelector('.topic-buttons .danger-btn').click()`);
    await cdp.waitFor(`!!document.querySelector('.confirm-actions .danger-primary')`);
    await cdp.evalJs(`document.querySelector('.confirm-actions .danger-primary').click()`);
    await cdp.waitFor(`document.querySelectorAll('.session-item').length === 0`);

    // Navigate to Security page -> update retention days + bind TOTP
    await cdp.evalJs(`Array.from(document.querySelectorAll('.nav-item')).find(b => b.textContent.includes('账号安全')).click()`);
    await cdp.waitFor(`!!document.querySelector('#security-totp-card') && !!document.querySelector('#security-retention-card') && !!document.querySelector('#security-backup-card')`);
    await cdp.evalJs(fillInput('#retention-days-input', '15'));
    await cdp.evalJs(`document.querySelector('#security-retention-card button[type="submit"]').click()`);
    await cdp.waitFor(`document.querySelector('.toast')?.textContent?.includes('15 天')`);
    assert.equal(app.store.config.conversationRetentionDays, 15);

    // Start TOTP setup -> verify data:image/png QR renders cleanly under CSP
    await cdp.evalJs(`document.querySelector('#totp-start-btn').click()`);
    const secret = await cdp.waitFor(`(() => {
      const img = document.querySelector('.totp-qr');
      const codeEl = document.querySelector('.totp-secret');
      if (!img || !img.complete || img.naturalWidth <= 0 || !codeEl) return '';
      return codeEl.textContent.trim();
    })()`);
    assert.ok(secret.length >= 16);

    await cdp.evalJs(fillInput('#security-totp-card input[type="password"]', 'StrongPass123!'));
    await cdp.evalJs(fillInput('#security-totp-card input[inputmode="numeric"]', totpCode(secret)));
    await cdp.evalJs(`document.querySelector('#security-totp-card form button[type="submit"]').click()`);
    const recoveryCount = await cdp.waitFor(`document.querySelectorAll('.recovery-grid code').length`);
    assert.equal(recoveryCount, 6);

    // Log out -> two-step TOTP login in real browser DOM
    await cdp.evalJs(`document.querySelector('#logout').click()`);
    await cdp.waitFor(`!!document.querySelector('#login-username')`);
    await cdp.evalJs(fillInput('#login-username', 'admin'));
    await cdp.evalJs(fillInput('#login-password', 'StrongPass123!'));
    await cdp.evalJs(`document.querySelector('#login-form button[type="submit"]').click()`);
    await cdp.waitFor(`!!document.querySelector('#login-totp')`);
    await cdp.evalJs(fillInput('#login-totp', totpCode(secret)));
    await cdp.evalJs(`document.querySelector('#login-form button[type="submit"]').click()`);
    await cdp.waitFor(`!!document.querySelector('#app-view') && !!document.querySelector('#page-security')`);
    await cdp.evalJs(`Array.from(document.querySelectorAll('.nav-item')).find(b => b.textContent.includes('概览')).click()`);
    await cdp.waitFor(`!!document.querySelector('#page-overview')`);

    const cspViolations = await cdp.evalJs(`window.__cspViolations`);
    assert.deepEqual(cspViolations, []);
    assert.deepEqual(cdp.errors, []);
  } finally {
    browser.close();
    await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  }
});

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromiumPath } from './douyin-browser.mjs';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class CardRenderer {
  constructor({ executable = chromiumPath(), maxConcurrent = 1 } = {}) {
    this.executable = executable;
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.running = 0;
    this.waiters = [];
    this.controllers = new Set();
    this.closed = false;
  }

  get available() {
    return Boolean(this.executable);
  }

  async acquire(signal) {
    if (this.closed) throw new Error('卡片渲染器已关闭');
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    if (this.waiters.length >= 16) {
      throw new Error('卡片渲染队列繁忙，请稍后再试');
    }
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      const onAbort = () => {
        const idx = this.waiters.indexOf(entry);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('卡片渲染已取消'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.cleanup = () => signal?.removeEventListener('abort', onAbort);
      this.waiters.push(entry);
    });
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      next.cleanup?.();
      next.resolve();
      return;
    }
    this.running = Math.max(0, this.running - 1);
  }

  async renderHtmlToPng({ html, width = 880, height = 600, scale = 1, timeoutMs = 20000, signal } = {}) {
    if (this.closed) throw new Error('卡片渲染器已关闭');
    if (!this.executable) throw new Error('渲染高清卡片需要 Chromium');
    const safeWidth = Math.min(1400, Math.max(320, Math.round(Number(width) || 880)));
    const safeHeight = Math.min(3200, Math.max(200, Math.round(Number(height) || 600)));
    const safeScale = Math.min(2, Math.max(1, Number(scale) || 1));

    await this.acquire(signal);
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-card-'));
    const controller = new AbortController();
    this.controllers.add(controller);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const htmlPath = join(dir, 'card.html');
      const pngPath = join(dir, 'card.png');
      writeFileSync(htmlPath, String(html || ''), { mode: 0o600 });

      await new Promise((resolve, reject) => {
        const child = spawn(this.executable, [
          '--headless=new',
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--disable-background-networking',
          '--disable-extensions',
          '--disable-sync',
          '--no-first-run',
          '--no-default-browser-check',
          '--hide-scrollbars',
          `--force-device-scale-factor=${safeScale}`,
          '--proxy-server=http://127.0.0.1:9',
          '--proxy-bypass-list=<-loopback>',
          `--user-data-dir=${join(dir, 'profile')}`,
          `--window-size=${safeWidth},${safeHeight}`,
          `--screenshot=${pngPath}`,
          pathToFileURL(htmlPath).href
        ], { stdio: 'ignore', detached: process.platform !== 'win32' });

        const stop = () => {
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {}
        };
        controller.signal.addEventListener('abort', stop, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref();

        const finish = err => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', stop);
          err ? reject(err) : resolve();
        };
        child.once('error', () => finish(new Error('卡片渲染进程启动失败')));
        child.once('close', code => finish(code === 0 && !controller.signal.aborted ? null : new Error('卡片渲染失败或超时')));
      });

      if (controller.signal.aborted || statSync(pngPath).size > 8 * 1024 * 1024) {
        throw new Error('卡片图片生成异常');
      }
      const bytes = readFileSync(pngPath);
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
        throw new Error('生成的卡片不是有效 PNG');
      }
      return bytes;
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
      this.controllers.delete(controller);
      this.release();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  close() {
    this.closed = true;
    for (const c of this.controllers) c.abort();
    while (this.waiters.length) {
      const w = this.waiters.shift();
      w.cleanup?.();
      w.reject(new Error('卡片渲染器已关闭'));
    }
  }
}

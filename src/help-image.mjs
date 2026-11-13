import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumPath } from './douyin-browser.mjs';

export class HelpImage {
  constructor({ executable = chromiumPath(), page, width, height, label } = {}) {
    this.page = page; this.size = { width, height }; this.label = label;
    this.executable = executable; this.controllers = new Set(); this.cached = null; this.pending = null;
  }
  async create() {
    if (this.cached) return this.cached;
    if (!this.pending) this.pending = this.render().finally(() => { this.pending = null; });
    return this.pending;
  }
  async render() {
    if (!this.executable) throw new Error(`${this.label}需要 Chromium`);
    const directory = mkdtempSync(join(tmpdir(), 'qqbot-help-image-'));
    const path = join(directory, 'help.png'), controller = new AbortController();
    this.controllers.add(controller);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(this.executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
          '--disable-background-networking', '--disable-extensions', '--disable-sync', '--no-first-run', '--no-default-browser-check',
          '--hide-scrollbars', '--force-device-scale-factor=1', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
          `--user-data-dir=${join(directory, 'profile')}`, `--window-size=${this.size.width},${this.size.height}`,
          `--screenshot=${path}`, this.page.href],
        { stdio: 'ignore', detached: process.platform !== 'win32' });
        const stop = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
        controller.signal.addEventListener('abort', stop, { once: true });
        const timer = setTimeout(() => controller.abort(), 30000); timer.unref();
        const finish = error => {
          clearTimeout(timer); controller.signal.removeEventListener('abort', stop);
          error ? reject(error) : resolve();
        };
        child.once('error', () => finish(new Error(`${this.label}渲染启动失败`)));
        child.once('close', code => finish(code === 0 && !controller.signal.aborted ? null : new Error(`${this.label}生成失败或已取消`)));
      });
      if (controller.signal.aborted || statSync(path).size > 5 * 1024 * 1024) throw new Error(`${this.label}无效`);
      const bytes = readFileSync(path);
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        || bytes.readUInt32BE(16) !== this.size.width || bytes.readUInt32BE(20) !== this.size.height) throw new Error(`${this.label}格式无效`);
      this.cached = 'base64://' + bytes.toString('base64');
      return this.cached;
    } finally {
      this.controllers.delete(controller); rmSync(directory, { recursive: true, force: true });
    }
  }
  cancel() { for (const controller of this.controllers) controller.abort(); }
}

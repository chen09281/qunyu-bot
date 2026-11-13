import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, renameSync, writeFileSync } from 'node:fs';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 递归移除 JSON 值中的危险原型链键，防止原型链污染；超过深度限制时直接丢弃。
 */
export function sanitizeJsonValue(value, depth = 0) {
  if (depth > 32) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => sanitizeJsonValue(item, depth + 1)).filter(item => item !== undefined);
  const clean = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const sanitized = sanitizeJsonValue(entry, depth + 1);
    if (sanitized !== undefined) clean[key] = sanitized;
  }
  return clean;
}

/**
 * 原子写入字节或文本文件（临时文件 + chmod 0600 + rename），防止崩溃/断电产生半截文件。
 */
export function atomicWriteBuffer(filePath, content, { mode = 0o600 } = {}) {
  const temp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temp, content, { mode });
  chmodSync(temp, mode);
  renameSync(temp, filePath);
}

/**
 * 原子写入 JSON 文件（临时文件 + chmod 0600 + rename），防止崩溃/断电产生半截文件。
 */
export function atomicWriteJson(filePath, data, { mode = 0o600 } = {}) {
  atomicWriteBuffer(filePath, JSON.stringify(data, null, 2) + '\n', { mode });
}

/**
 * 隔离损坏的 JSON 文件为 .corrupt.<timestamp> 备份，避免静默覆盖丢失现场。
 */
export function quarantineCorruptFile(filePath) {
  if (!existsSync(filePath)) return '';
  const backup = `${filePath}.corrupt.${Date.now()}`;
  try {
    renameSync(filePath, backup);
    return backup;
  } catch {
    return '';
  }
}

/**
 * 脱敏日志或错误消息中的常见敏感凭据（Bearer Token、API Key、URL 密钥参数、Cookie）。
 */
export function redactSecrets(input) {
  if (input === null || input === undefined) return '';
  let text = String(input);
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]');
  text = text.replace(/\b(sk-(?:proj-|live-|test-)?)[A-Za-z0-9_-]{8,}/g, '$1[REDACTED]');
  text = text.replace(/([?&](?:api[-_]?key|key|token|access_token|secret|password|passwd|auth|signature)=)[^&\s"'<>]+/gi, '$1[REDACTED]');
  text = text.replace(/((?:^|[\s;])(?:cookie|set-cookie|authorization)\s*[:=]\s*)([^\r\n]+)/gi, '$1[REDACTED]');
  return text;
}

/**
 * 校验 HTTP Host 请求头格式，防止 Host 头注入。
 */
export function validHostHeader(host) {
  if (typeof host !== 'string' || !host || host.length > 255 || /[\s/\\@\r\n\x00-\x1f]/.test(host)) return false;
  return /^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::\d{1,5})?$/.test(host);
}

/**
 * 登录与敏感操作防爆破守卫：同时限制单 IP 高频请求与单账号连续失败锁定。
 */
export class AuthAttemptGuard {
  constructor({
    now = Date.now,
    ipWindowMs = 60_000,
    ipMaxAttempts = 10,
    lockThreshold = 5,
    lockDurationMs = 5 * 60_000,
    extendedLockThreshold = 10,
    extendedLockDurationMs = 15 * 60_000,
    maxEntries = 1000
  } = {}) {
    this.now = now;
    this.ipWindowMs = ipWindowMs;
    this.ipMaxAttempts = ipMaxAttempts;
    this.lockThreshold = lockThreshold;
    this.lockDurationMs = lockDurationMs;
    this.extendedLockThreshold = extendedLockThreshold;
    this.extendedLockDurationMs = extendedLockDurationMs;
    this.maxEntries = maxEntries;
    this.ipAttempts = new Map();
    this.accountFailures = new Map();
  }

  prune(now = this.now()) {
    for (const [key, record] of this.ipAttempts) {
      if (now - record.start > this.ipWindowMs) this.ipAttempts.delete(key);
    }
    for (const [key, record] of this.accountFailures) {
      if (record.lockedUntil && now > record.lockedUntil && now - record.lastFailedAt > this.extendedLockDurationMs) {
        this.accountFailures.delete(key);
      } else if (!record.lockedUntil && now - record.lastFailedAt > this.extendedLockDurationMs) {
        this.accountFailures.delete(key);
      }
    }
  }

  failureKey(ip, subject) {
    if (!subject) return '';
    return `${ip || 'unknown'}:${subject}`;
  }

  check(ip, subject = '') {
    const now = this.now();
    this.prune(now);
    if (ip) {
      if (!this.ipAttempts.has(ip) && this.ipAttempts.size >= this.maxEntries) {
        return { allowed: false, reason: 'ip_overflow', message: '登录请求过多，请稍后重试' };
      }
      const record = this.ipAttempts.get(ip) || { start: now, count: 0 };
      record.count++;
      this.ipAttempts.set(ip, record);
      if (record.count > this.ipMaxAttempts) {
        return { allowed: false, reason: 'ip_rate', message: '尝试过于频繁，请一分钟后重试' };
      }
    }
    const key = this.failureKey(ip, subject);
    if (key) {
      const account = this.accountFailures.get(key);
      if (account?.lockedUntil && account.lockedUntil > now) {
        const waitMinutes = Math.max(1, Math.ceil((account.lockedUntil - now) / 60_000));
        return { allowed: false, reason: 'account_locked', message: `连续失败次数过多，请 ${waitMinutes} 分钟后再试` };
      }
    }
    return { allowed: true };
  }

  recordFailure(subject, ip = '') {
    const key = this.failureKey(ip, subject);
    if (!key) return;
    const now = this.now();
    if (!this.accountFailures.has(key) && this.accountFailures.size >= this.maxEntries) {
      this.accountFailures.delete(this.accountFailures.keys().next().value);
    }
    const prev = this.accountFailures.get(key) || { count: 0, lockedUntil: 0, lastFailedAt: 0 };
    const count = prev.count + 1;
    let lockedUntil = prev.lockedUntil;
    if (count >= this.extendedLockThreshold) {
      lockedUntil = now + this.extendedLockDurationMs;
    } else if (count >= this.lockThreshold) {
      lockedUntil = now + this.lockDurationMs;
    }
    this.accountFailures.set(key, { count, lockedUntil, lastFailedAt: now });
  }

  reset(subject, ip = '') {
    const key = this.failureKey(ip, subject);
    if (key) this.accountFailures.delete(key);
  }
}

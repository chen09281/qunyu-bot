import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';

const ENC_PREFIX = 'QQBOT_ENC_V1:';
function deriveCookieKey(secret) {
  if (!secret) return null;
  return scryptSync(String(secret), 'qqbot-link-cookies-v1', 32);
}
function encryptCookieText(text, key) {
  if (!key) return text;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}\n`;
}
function decryptCookieText(raw, key) {
  if (!raw.startsWith(ENC_PREFIX)) return raw;
  if (!key) throw new Error('Cookie 已加密存储，请配置 DATA_ENCRYPTION_KEY 后再读取');
  const [, ivB64, tagB64, dataB64] = raw.trim().split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('加密 Cookie 格式无效');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export const maxCookieBytes = 96 * 1024;
const cookieName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const withinPlatform = (domain, platform) => platform.domains.some(root => domain === root || domain.endsWith(`.${root}`));
const genericError = 'Cookie 格式错误，请粘贴 Cookie 请求头或导入 Netscape cookies.txt';

export function normalizeCookies(content, platform) {
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > maxCookieBytes || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw new Error(genericError);
  const source = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const records = new Map(); let ignored = 0;
  if (source.startsWith('#') || source.includes('\t')) {
    if (!/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)(?:\n|$)/.test(source)) throw new Error(genericError);
    for (const line of source.split('\n').slice(1)) {
      if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
      const fields = line.split('\t');
      if (fields.length !== 7) throw new Error(genericError);
      const [rawDomain, includeSubdomains, path, secure, expiry, name, value] = fields;
      const domain = rawDomain.replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase();
      if (!/^[a-z0-9.-]+$/.test(domain) || !['TRUE', 'FALSE'].includes(includeSubdomains) || !['TRUE', 'FALSE'].includes(secure)
        || !path.startsWith('/') || /[\s;]/.test(path) || !/^\d+$/.test(expiry) || !Number.isSafeInteger(Number(expiry)) || !cookieName.test(name)) throw new Error(genericError);
      if (!withinPlatform(domain, platform)) { ignored++; continue; }
      records.set(`${domain}:${path}:${name}`, [rawDomain, includeSubdomains, path, secure, expiry, name, value].join('\t'));
    }
  } else {
    if (/[\r\n]/.test(source)) throw new Error(genericError);
    for (const part of source.replace(/^Cookie:\s*/i, '').split(';')) {
      const pair = part.trim(); if (!pair) continue;
      const index = pair.indexOf('='), name = pair.slice(0, index), value = pair.slice(index + 1);
      if (index < 1 || !cookieName.test(name) || /[\t\r\n]/.test(value)) throw new Error(genericError);
      records.set(name, [`.${platform.domains[0]}`, 'TRUE', '/', 'TRUE', '0', name, value].join('\t'));
    }
  }
  if (!records.size) throw new Error('没有找到所选平台的 Cookie，请确认平台与导出的登录态一致');
  return { text: '# Netscape HTTP Cookie File\n' + [...records.values()].join('\n') + '\n', count: records.size, ignored };
}

export class LinkCookies {
  constructor(directory, platforms, { encryptionKey = process.env.DATA_ENCRYPTION_KEY || '' } = {}) {
    this.directory = directory; this.platforms = platforms;
    this.cryptoKey = deriveCookieKey(encryptionKey);
    this.checkDirectory(false);
  }
  platform(id) {
    const platform = this.platforms.find(item => item.id === id);
    if (!platform) throw new Error('不支持的平台');
    return platform;
  }
  checkDirectory(create = false) {
    try { if (!lstatSync(this.directory).isDirectory() || lstatSync(this.directory).isSymbolicLink()) throw new Error('登录态目录必须是普通目录'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; if (create) mkdirSync(this.directory, { mode: 0o700 }); }
  }
  info(id) {
    this.platform(id); this.checkDirectory(false);
    try {
      const info = lstatSync(join(this.directory, `${id}.txt`));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('登录态文件必须是普通文件');
      return { configured: info.size > 0, updatedAt: info.mtimeMs };
    } catch (error) { if (error.code !== 'ENOENT') throw error; return { configured: false, updatedAt: null }; }
  }
  save(id, content) {
    const normalized = normalizeCookies(content, this.platform(id));
    this.checkDirectory(true); this.info(id);
    const temporary = join(this.directory, `${id}-${randomUUID()}.tmp`);
    try {
      const payload = encryptCookieText(normalized.text, this.cryptoKey);
      writeFileSync(temporary, payload, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, join(this.directory, `${id}.txt`));
    } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return { platform: id, ...this.info(id), count: normalized.count, ignored: normalized.ignored };
  }
  clear(id) {
    this.info(id);
    try { unlinkSync(join(this.directory, `${id}.txt`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { platform: id, configured: false, updatedAt: null };
  }
  read(id) {
    this.platform(id); this.checkDirectory(false);
    let fd;
    try {
      fd = openSync(join(this.directory, `${id}.txt`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > maxCookieBytes * 2) throw new Error('登录态文件无效或过大，请重新配置');
      return decryptCookieText(readFileSync(fd, 'utf8'), this.cryptoKey);
    } catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  snapshot(id, destination) {
    this.platform(id); this.checkDirectory(false);
    let fd;
    try {
      fd = openSync(join(this.directory, `${id}.txt`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > maxCookieBytes * 2) throw new Error('登录态文件无效或过大，请重新配置');
      if (!info.size) return '';
      const content = decryptCookieText(readFileSync(fd, 'utf8'), this.cryptoKey);
      writeFileSync(destination, content, { flag: 'wx', mode: 0o600 });
      return destination;
    } catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}

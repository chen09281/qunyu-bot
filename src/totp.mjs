import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0, value = 0, output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

export function totpUri({ secret, username, issuer = 'QunyuBot' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username || 'admin')}`;
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function totpCode(secret, { timestamp = Date.now(), step = 30, digits = 6 } = {}) {
  const key = base32Decode(secret);
  if (!key.length) throw new Error('无效的 TOTP 密钥');
  const counter = Math.floor(timestamp / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % (10 ** digits)).padStart(digits, '0');
}

export function verifyTotpCode(secret, code, { timestamp = Date.now(), step = 30, window = 1 } = {}) {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const inputBuf = Buffer.from(clean, 'utf8');
  let matched = false;
  for (let delta = -window; delta <= window; delta++) {
    const candidate = totpCode(secret, { timestamp: timestamp + delta * step * 1000, step });
    if (timingSafeEqual(inputBuf, Buffer.from(candidate, 'utf8'))) matched = true;
  }
  return matched;
}

export function hashRecoveryCode(code) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return createHash('sha256').update(`qqbot-recovery:${clean}`).digest('hex');
}

export function generateRecoveryCodes(count = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = [], hashes = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(8);
    let raw = '';
    for (let j = 0; j < 8; j++) raw += chars[bytes[j] % chars.length];
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    codes.push(formatted);
    hashes.push(hashRecoveryCode(formatted));
  }
  return { codes, hashes };
}

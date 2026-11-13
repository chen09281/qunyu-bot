// Ported from YueHen14/skyland-auto-sign src/SecuritySm.py (MIT).
// Fixed upstream revision and full license are recorded in notices/ below.
import { createHash, createCipheriv, createPublicKey, publicEncrypt, constants, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { CheckinError } from './http.mjs';

const md5 = value => createHash('md5').update(value).digest('hex');
const organization = 'UWXspnCCJN4sfYlNfqps';
const publicKey = createPublicKey({ format: 'der', type: 'spki', key: Buffer.from('MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCmxMNr7n8ZeT0tE1R9j/mPixoinPkeM+k4VGIn/s0k7N5rJAfnZ0eMER+QhwFvshzo0LNmeUkpR8uIlU/GEVr8mN28sKmwd2gpygqj0ePnBmOW4v0ZVwbSYK+izkhVFk2V/doLoMbWy6b+UnA8mkjvg0iYWRByfRsK2gdl7llqCwIDAQAB', 'base64') });
const rules = {
  appId: ['xx', 'uy7mzc4h'], box: ['jf'], canvas: ['yk', 'snrn887t'], clientSize: ['zx', 'cpmjjgsu'],
  organization: ['dp', '78moqjfc'], os: ['pj', 'je6vk6t4'], platform: ['gm', 'pakxhcd2'], plugins: ['kq', 'v51m3pzl'],
  pmf: ['vw', '2mdeslu3'], protocol: ['protocol'], referer: ['ab', 'y7bmrjlc'], res: ['hf', 'whxqm2a7'],
  rtype: ['lo', 'x8o2h2bl'], sdkver: ['sc', '9q3dcxp2'], status: ['an', '2jbrxxw4'], subVersion: ['ns', 'eo3i2puh'],
  svm: ['qr', 'fzj3kaeh'], time: ['nb', 'q2t3odsk'], timezone: ['as', '1uv05lj5'], tn: ['py', 'x9nzj1bp'],
  trees: ['pi', 'acfs0xo4'], ua: ['bj', 'k92crp1t'], url: ['cf', 'y95hjkoo'], version: ['version'], vpw: ['ca', 'r9924ab5'],
};
export function devicePayload(now = Date.now()) {
  const uid = randomUUID(), stamp = new Date(now).toISOString().replace(/\D/g, '').slice(0, 14);
  const base = stamp + md5(randomUUID()) + '00';
  const data = {
    plugins: 'MicrosoftEdgePDFPluginPortableDocumentFormatinternal-pdf-viewer1,MicrosoftEdgePDFViewermhjfbmdgcfjbbpaeojofohoefgiehjai1',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
    canvas: '259ffe69', timezone: -480, platform: 'Win32', url: 'https://www.skland.com/', referer: '',
    res: '1920_1080_24_1.25', clientSize: '0_0_1080_1920_1920_1080_1920_1080', status: '0011',
    vpw: randomUUID(), svm: now, trees: randomUUID(), pmf: now, protocol: 102, organization,
    appId: 'default', os: 'web', version: '3.0.0', sdkver: '3.0.0', box: '', rtype: 'all',
    smid: base + md5('smsk_web_' + base).slice(0, 14) + '0', subVersion: '1.0.0', time: 0,
  };
  data.tn = md5(Object.keys(data).sort().map(k => typeof data[k] === 'number' ? data[k] * 10000 : data[k]).join(''));
  const encoded = {};
  for (const [key, value] of Object.entries(data)) {
    const [name, secret] = rules[key] || [key];
    if (!secret) { encoded[name] = value; continue; }
    // Repeated 3DES keys reproduce upstream DES without OpenSSL's legacy provider.
    const cipher = createCipheriv('des-ede3', Buffer.from(secret.repeat(3)), null).setAutoPadding(false);
    const text = Buffer.from(String(value)), padded = Buffer.alloc(Math.floor(text.length / 8 + 1) * 8);
    text.copy(padded);
    encoded[name] = Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
  }
  const zipped = Buffer.from(gzipSync(Buffer.from(JSON.stringify(encoded)), { level: 2, mtime: 0 }).toString('base64'));
  const padded = Buffer.alloc(Math.floor(zipped.length / 16 + 1) * 16); zipped.copy(padded);
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(md5(uid).slice(0, 16)), Buffer.from('0102030405060708')).setAutoPadding(false);
  return { appId: 'default', compress: 2, data: Buffer.concat([cipher.update(padded), cipher.final()]).toString('hex'), encode: 5,
    ep: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(uid)).toString('base64'), organization, os: 'web' };
}
export async function sklandDevice(request, signal) {
  const data = await request('https://fp-it.portal101.cn/deviceprofile/v4', {
    method: 'POST', body: JSON.stringify(devicePayload()), headers: { 'Content-Type': 'application/json' }, signal,
  });
  const deviceId = data.detail?.deviceId;
  // The service returns standard Base64 (including +, / and trailing =), not just Base64url.
  // Preserve those bytes: the same dId is sent in the login headers and signed requests.
  if (data.code !== 1100 || typeof deviceId !== 'string' || !/^[a-zA-Z0-9+/_-]{1,200}={0,2}$/.test(deviceId)) throw new CheckinError('device');
  return 'B' + deviceId;
}

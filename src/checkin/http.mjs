import { setTimeout as sleep } from 'node:timers/promises';

export class CheckinError extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}
export const resultText = {
  success: '签到成功', already: '今日已签到', expired: '登录已失效，请重新绑定',
  verification: '需要在官方 App 完成验证后重试', network: '连接失败或超时，稍后可手动重试',
  device: '森空岛设备标识获取失败，请稍后重试；此错误无需等待 App 验证通知',
  failed: '平台接口返回异常', empty: '未找到支持的游戏角色', missing: '未提供社区签到所需的 stoken',
  first: '首次绑定，请先在官方 App 手动签到一次', cancelled: '任务已暂停',
};
export const errorKind = error => error instanceof CheckinError && Object.hasOwn(resultText, error.kind) ? error.kind : 'failed';
const hosts = new Set(['as.hypergryph.com', 'zonai.skland.com', 'fp-it.portal101.cn',
  'api-takumi.mihoyo.com', 'act-nap-api.mihoyo.com', 'bbs-api.miyoushe.com', 'api.kurobbs.com']);

// Credentials only go to these fixed HTTPS API origins; redirects are never followed.
export async function requestJSON(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !hosts.has(target.hostname) || target.port || target.username || target.password) throw new CheckinError('failed');
  try {
    const response = await fetch(target, { method, headers, ...(body === undefined ? {} : { body }), redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CheckinError(response.status === 429 ? 'verification' : 'network');
    }
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 1024 * 1024) throw new CheckinError('failed');
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CheckinError('failed');
    return data;
  } catch (error) {
    if (signal?.aborted) throw new CheckinError('cancelled');
    if (error instanceof CheckinError) throw error;
    throw new CheckinError('network');
  }
}
export function checkResponse(data, field, success, already = []) {
  const code = data?.[field];
  if (typeof code !== 'number') throw new CheckinError('failed');
  if (already.includes(code)) return 'already';
  if (code === success) return 'success';
  // Interpret upstream error text, but never echo or persist it (it can contain credentials).
  const message = String(data.message || data.msg || '');
  if ([1034, -3101].includes(code) || /验证|风控|captcha|risk/i.test(message)) throw new CheckinError('verification');
  if ([-100, 10001, 10002, 10003, 220].includes(code) || /登录|登陆|token|cred.*失效|cookie/i.test(message)) throw new CheckinError('expired');
  throw new CheckinError('failed');
}
export async function taskResult(label, action) {
  try { return { label, status: await action() }; }
  catch (error) { return { label, status: errorKind(error) }; }
}
export const pause = signal => sleep(400, undefined, { signal });
export function list(value) {
  if (!Array.isArray(value) || value.length > 50) throw new CheckinError('failed');
  return value;
}
export function field(value) {
  if (!['string', 'number'].includes(typeof value) || !/^[a-zA-Z0-9_-]{1,100}$/.test(String(value))) throw new CheckinError('failed');
  return String(value);
}

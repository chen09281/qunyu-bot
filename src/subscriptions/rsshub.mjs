// Internal RSSHub is a deployment-only trust decision, never an admin-form URL.
export function internalRsshubBase(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('RSSHUB_INTERNAL_URL 需为固定的 HTTP(S) 服务地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('RSSHUB_INTERNAL_URL 不允许凭据、查询参数或片段');
  }
  return url.href.replace(/\/+$/, '');
}
export const rsshubReadTimeout = 75;
export function rsshubRequest(settings, route) {
  if (!/^\/(?:bilibili\/user\/(?:video|dynamic)\/[1-9]\d{0,19}|douyin\/user\/MS4wLjABAAAA[A-Za-z0-9_-]{8,200})$/.test(route)) {
    throw new Error('RSSHub 路由不受支持');
  }
  const internal = internalRsshubBase(settings.rsshubInternalUrl);
  const url = `${internal || settings.rsshubUrl.replace(/\/+$/, '')}${route}`;
  return { url, timeout: rsshubReadTimeout, ...(internal ? { trustedUrl: url } : {}) };
}

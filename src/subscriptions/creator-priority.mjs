import { plainText } from './feeds.mjs';

const supported = entry => ['bilibili', 'douyin'].includes(entry.type);
export const creatorKey = value => String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

// RSSHub's Bilibili route adds a suffix; its Douyin route returns the nickname.
// Never infer identity from the administrator's arbitrary subscription label.
export function creatorName(entry) {
  if (!supported(entry)) return '';
  const title = plainText(entry.lastTitle, 120);
  const name = entry.type === 'bilibili'
    ? /^(.+?)\s*的\s*(?:bilibili|哔哩哔哩|b\s*站)\s*空间$/iu.exec(title)?.[1]?.trim() || '' : title;
  if (!name || name === entry.source || /^(?:抖音|douyin|bilibili|哔哩哔哩|b站|抖音作品|B站投稿)$/iu.test(name)) return '';
  return name;
}

export function creatorMatches(entry, entries) {
  const key = creatorKey(creatorName(entry));
  if (!key || !supported(entry) || entry.crossPlatformMatch === false) return [];
  return entries.filter(other => other !== entry && supported(other) && other.type !== entry.type
    && other.crossPlatformMatch !== false && creatorKey(creatorName(other)) === key
    && other.groups.some(group => entry.groups.includes(group)));
}

export function prioritySourceHealthy(entry, { now = Date.now(), intervalMinutes = 10 } = {}) {
  if (entry.lastReadFailed || entry.lastFailureStage === 'reading' || entry.lastError && !entry.lastFailureStage && !entry.lastReadAt) return false;
  const readAt = Date.parse(entry.lastReadAt || entry.lastSuccessAt || '');
  return Number.isFinite(readAt) && now - readAt <= Math.max(30, intervalMinutes * 3) * 60000;
}
export function preferredDouyin(entry, entries, group, options) {
  if (entry.type !== 'bilibili' || !entry.enabled) return null;
  return creatorMatches(entry, entries).find(other => other.type === 'douyin' && other.enabled && other.groups.includes(group) && prioritySourceHealthy(other, options)) || null;
}

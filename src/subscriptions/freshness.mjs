// Feed expansion, pinned posts and reader fallbacks can expose unseen historical
// IDs. Identity deduplication alone is not evidence of a new publication.
export const subscriptionMaxAgeMs = 24 * 60 * 60 * 1000;
export function staleSubscriptionReason(entry, item, now) {
  if (!['bilibili', 'douyin'].includes(entry.type)) return '';
  const published = Date.parse(item.publishedAt || '');
  if (!Number.isFinite(published) || published <= 0) return 'missing_date';
  if (published > now + 5 * 60 * 1000) return 'future_date';
  const initialized = Date.parse(entry.initializedAt || entry.createdAt || '');
  // Platform dates have second precision, while our baseline has milliseconds.
  const baseline = Number.isFinite(initialized) ? Math.floor(initialized / 1000) * 1000 : now;
  return published < Math.max(baseline, now - subscriptionMaxAgeMs) ? 'historical' : '';
}

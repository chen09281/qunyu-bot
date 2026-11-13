const groupId = value => String(typeof value === 'object' ? value?.id ?? '' : value ?? '');
const validGroup = value => /^\d{5,20}$/.test(value);

export function groupSubscriptions(entries = [], allowedGroups = [], { query = '', group = '' } = {}) {
  const buckets = new Map();
  for (const value of allowedGroups) {
    const id = groupId(value);
    if (validGroup(id) && !buckets.has(id)) buckets.set(id, { id, authorized: true, entries: [] });
  }
  for (const entry of entries) {
    for (const id of new Set((entry.groups || []).map(groupId).filter(validGroup))) {
      if (!buckets.has(id)) buckets.set(id, { id, authorized: false, entries: [] });
      buckets.get(id).entries.push(entry);
    }
  }
  const search = query.trim().toLocaleLowerCase();
  return [...buckets.values()].filter(bucket => !group || bucket.id === group).map(bucket => ({
    ...bucket, total: bucket.entries.length,
    entries: bucket.entries.filter(entry => !search || [bucket.id, entry.name, entry.lastTitle, entry.creatorName, entry.source]
      .some(value => String(value || '').toLocaleLowerCase().includes(search))),
  })).filter(bucket => !search || bucket.entries.length || bucket.id.includes(search))
    .sort((a, b) => Number(b.authorized) - Number(a.authorized) || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

// A source can serve several groups; removing one target must preserve the others.
export function removeGroupRequest(entry, group) {
  if (!entry.groups.includes(group)) return null;
  const groups = entry.groups.filter(id => id !== group);
  return groups.length
    ? { path: `subscriptions/${entry.id}`, method: 'PUT', body: { groups } }
    : { path: `subscriptions/${entry.id}/remove`, method: 'POST', body: {} };
}

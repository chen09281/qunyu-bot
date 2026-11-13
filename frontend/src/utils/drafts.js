// Compare JSON form values without cloning Vue's reactive proxies directly.
export const copyDraft = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const record = value => value && typeof value === 'object' && !Array.isArray(value);
export function sameDraft(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, i) => sameDraft(value, right[i]));
  if (record(left) && record(right)) return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && sameDraft(left[key], right[key]));
  return false;
}

// Three-way merge: accept server changes only where the user has not edited.
export function mergeDraft(current, baseline, saved) {
  if (sameDraft(current, baseline)) return copyDraft(saved);
  if (record(current) && record(baseline) && record(saved)) {
    return Object.fromEntries([...new Set([...Object.keys(current), ...Object.keys(saved)])]
      .map(key => [key, mergeDraft(current[key], baseline[key], saved[key])]).filter(([, value]) => value !== undefined));
  }
  return copyDraft(current);
}
export function draftConflicts(current, baseline, saved) {
  if (current == null || baseline == null) return false;
  if (sameDraft(current, baseline) || sameDraft(saved, baseline) || sameDraft(current, saved)) return false;
  if (record(current) && record(baseline) && record(saved)) {
    return Object.keys(saved).some(key => draftConflicts(current[key], baseline[key], saved[key]));
  }
  return true;
}
export function mergeGroupDraft(current, baseline, saved) {
  const before = new Map(baseline.map(rule => [rule.id, rule])), after = new Map(saved.map(rule => [rule.id, rule]));
  const result = current.flatMap(rule => {
    if (!before.has(rule.id)) return [copyDraft(rule)];
    if (!after.has(rule.id)) return sameDraft(rule, before.get(rule.id)) ? [] : [copyDraft(rule)];
    return [mergeDraft(rule, before.get(rule.id), after.get(rule.id))];
  });
  const existing = new Set(current.map(rule => rule.id));
  for (const rule of saved) if (!before.has(rule.id) && !existing.has(rule.id)) result.push(copyDraft(rule));
  return result;
}
export function mergePrivateDraft(current, baseline, saved) {
  const removed = new Set(baseline.filter(id => !current.includes(id)));
  return [...new Set([...saved.filter(id => !removed.has(id)), ...current.filter(id => !baseline.includes(id))])];
}

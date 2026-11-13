import { existsSync, mkdirSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteJson, quarantineCorruptFile } from '../security.mjs';

function safeFile(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error('酒馆情绪文件路径不能是符号链接');
  }
}

export const DEFAULT_EMOTION_STATE = Object.freeze({
  affection: 50,
  joy: 60,
  trust: 50,
  tension: 20,
  depression: 15,
  mood: '平静',
  reason: '初始状态'
});

export const EMOTION_METRICS = Object.freeze([
  { key: 'affection', label: '好感度', initial: 50, description: '衡量角色对当前会话对象的亲近与喜爱程度，决定关系阶段。' },
  { key: 'joy', label: '愉悦度', initial: 60, description: '当前心情的明朗程度。较高时语气轻快；较低时偏安静或强颜欢笑。' },
  { key: 'trust', label: '信任度', initial: 50, description: '角色是否愿意卸下防备、吐露秘密或内心真实想法。' },
  { key: 'tension', label: '紧张度', initial: 20, description: '当前感受到的压迫、戒备或危机感。较高时更容易触发防备或敏感反应。' },
  { key: 'depression', label: '抑郁值', initial: 15, description: '内心积压的失落、悲伤、孤独或自我否定倾向；被温暖安慰时会逐步回落。' }
]);

export function relationshipStage(affection = 50) {
  const val = Number(affection) || 0;
  if (val < 20) return '疏离戒备';
  if (val < 40) return '礼貌客套';
  if (val < 60) return '普通熟人';
  if (val < 80) return '亲近信赖';
  return '深度羁绊';
}

export function emotionScopeKey(scope = {}, mode = 'group') {
  if (!scope) return 'default';
  if (typeof scope === 'string') return scope;
  if (scope.isPrivate && scope.userId) return `private:${scope.userId}`;
  if (!scope.isPrivate && scope.groupId) {
    if (mode === 'group-member' && scope.userId) {
      return `group:${scope.groupId}:user:${scope.userId}`;
    }
    return `group:${scope.groupId}`;
  }
  return 'default';
}

function clampMetric(current, delta) {
  const numericDelta = Number(delta);
  const boundedDelta = Number.isFinite(numericDelta)
    ? Math.min(10, Math.max(-10, Math.round(numericDelta)))
    : 0;
  return Math.min(100, Math.max(0, Math.round(current) + boundedDelta));
}

export class EmotionManager {
  constructor(dataDir = 'data') {
    this.dataFile = join(dataDir, 'tavern', 'emotions.json');
    this.ensureFile();
    this.state = this.load();
  }

  ensureFile() {
    const dir = dirname(this.dataFile);
    safeFile(dir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    safeFile(this.dataFile);
    if (!existsSync(this.dataFile)) {
      atomicWriteJson(this.dataFile, { snapshots: {}, active: {} });
    }
  }

  load() {
    this.ensureFile();
    try {
      const parsed = JSON.parse(readFileSync(this.dataFile, 'utf8'));
      return {
        snapshots: parsed?.snapshots && typeof parsed.snapshots === 'object' ? parsed.snapshots : {},
        active: parsed?.active && typeof parsed.active === 'object' ? parsed.active : {}
      };
    } catch (error) {
      const backup = quarantineCorruptFile(this.dataFile);
      console.error(`[tavern-emotions] 情绪状态文件损坏，已隔离至 ${backup || this.dataFile}: ${error.message}`);
      const fallback = { snapshots: {}, active: {} };
      atomicWriteJson(this.dataFile, fallback);
      return fallback;
    }
  }

  save() {
    this.ensureFile();
    atomicWriteJson(this.dataFile, this.state);
  }

  decorate(record) {
    const base = { ...DEFAULT_EMOTION_STATE, ...(record || {}) };
    return {
      ...base,
      stage: relationshipStage(base.affection),
      updatedAt: base.updatedAt || null
    };
  }

  get(charId, scope = {}, mode = 'group') {
    const scopeKey = emotionScopeKey(scope, mode);
    const key = `${charId}:${scopeKey}`;
    return this.decorate(this.state.active[key]);
  }

  listByCharacter(charId) {
    const prefix = `${charId}:`;
    const rows = [];
    for (const [key, value] of Object.entries(this.state.active)) {
      if (!key.startsWith(prefix)) continue;
      const scopeKey = key.slice(prefix.length);
      const memberMatch = /^group:([^:]+):user:([^:]+)$/.exec(scopeKey);
      if (memberMatch) {
        rows.push({
          scopeKey,
          scopeType: 'group-member',
          groupId: memberMatch[1],
          userId: memberMatch[2],
          scopeId: `群 ${memberMatch[1]} · QQ ${memberMatch[2]}`,
          ...this.decorate(value)
        });
        continue;
      }
      const [scopeType, scopeId = ''] = scopeKey.split(':');
      rows.push({
        scopeKey,
        scopeType: scopeType === 'private' ? 'private' : scopeType === 'group' ? 'group' : 'default',
        scopeId,
        ...this.decorate(value)
      });
    }
    return rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  leaderboard(charId, groupId, limit = 10) {
    const memberPrefix = `${charId}:group:${groupId}:user:`;
    const entries = [];
    for (const [key, value] of Object.entries(this.state.active)) {
      if (!key.startsWith(memberPrefix)) continue;
      const userId = key.slice(memberPrefix.length);
      entries.push({ userId, ...this.decorate(value) });
    }
    if (!entries.length && this.state.active[`${charId}:group:${groupId}`]) {
      entries.push({ userId: '', isGroupShared: true, ...this.decorate(this.state.active[`${charId}:group:${groupId}`]) });
    }
    return entries.sort((a, b) => (b.affection - a.affection) || (b.trust - a.trust) || (b.joy - a.joy)).slice(0, limit);
  }

  apply(charId, scope = {}, delta = {}, mode = 'group') {
    const scopeKey = emotionScopeKey(scope, mode);
    const key = `${charId}:${scopeKey}`;
    const current = this.get(charId, scopeKey);

    if (!this.state.snapshots[key]) this.state.snapshots[key] = [];
    this.state.snapshots[key].push({
      affection: current.affection,
      joy: current.joy,
      trust: current.trust,
      tension: current.tension,
      depression: current.depression,
      mood: current.mood,
      reason: current.reason,
      updatedAt: current.updatedAt
    });
    if (this.state.snapshots[key].length > 10) this.state.snapshots[key].shift();

    const mood = typeof delta.mood === 'string' && delta.mood.trim()
      ? delta.mood.trim().slice(0, 24)
      : current.mood;
    const reason = typeof delta.reason === 'string' && delta.reason.trim()
      ? delta.reason.trim().slice(0, 120)
      : current.reason;

    const next = {
      affection: clampMetric(current.affection, delta.affection),
      joy: clampMetric(current.joy, delta.joy),
      trust: clampMetric(current.trust, delta.trust),
      tension: clampMetric(current.tension, delta.tension),
      depression: clampMetric(current.depression, delta.depression),
      mood,
      reason,
      updatedAt: new Date().toISOString()
    };

    this.state.active[key] = next;
    this.save();
    return this.decorate(next);
  }

  undo(charId, scope = {}, mode = 'group') {
    const scopeKey = emotionScopeKey(scope, mode);
    const key = `${charId}:${scopeKey}`;
    const stack = this.state.snapshots[key];
    if (!Array.isArray(stack) || !stack.length) return null;
    const previous = stack.pop();
    if (!previous.updatedAt) {
      delete this.state.active[key];
    } else {
      this.state.active[key] = previous;
    }
    if (!stack.length) delete this.state.snapshots[key];
    this.save();
    return this.get(charId, scopeKey);
  }

  reset(charId, scopeKey = '', mode = 'group') {
    if (scopeKey) {
      const resolvedKey = emotionScopeKey(scopeKey, mode);
      const key = `${charId}:${resolvedKey}`;
      const existed = Boolean(this.state.active[key] || this.state.snapshots[key]);
      delete this.state.active[key];
      delete this.state.snapshots[key];
      if (!String(scopeKey).includes(':') && typeof scopeKey === 'object' && !scopeKey.isPrivate && scopeKey.groupId) {
        // 群内切换角色卡重置时一并清理该群的个人好感度记录
        const memberPrefix = `${charId}:group:${scopeKey.groupId}:user:`;
        for (const k of Object.keys(this.state.active)) {
          if (k.startsWith(memberPrefix)) { delete this.state.active[k]; }
        }
        for (const k of Object.keys(this.state.snapshots)) {
          if (k.startsWith(memberPrefix)) { delete this.state.snapshots[k]; }
        }
        this.save();
        return this.get(charId, scopeKey, mode);
      }
      if (existed) this.save();
      return this.get(charId, resolvedKey);
    }
    const prefix = `${charId}:`;
    let changed = false;
    for (const key of Object.keys(this.state.active)) {
      if (key.startsWith(prefix)) { delete this.state.active[key]; changed = true; }
    }
    for (const key of Object.keys(this.state.snapshots)) {
      if (key.startsWith(prefix)) { delete this.state.snapshots[key]; changed = true; }
    }
    if (changed) this.save();
    return [];
  }
}

const VALID_METRICS = new Set(EMOTION_METRICS.map(m => m.key));

export const EMOTION_TRIGGER_TEMPLATES = Object.freeze([
  {
    name: '深度羁绊 · 专属口癖',
    metric: 'affection',
    operator: '>=',
    threshold: 80,
    promptHint: '当前好感度极高（深度羁绊），语气会明显更亲昵温柔，可以使用更亲近的称呼，偶尔流露偏爱与撒娇。',
    stickerCooldown: 3
  },
  {
    name: '隐藏心事 · 剧情彩蛋',
    metric: 'depression',
    operator: '>=',
    threshold: 60,
    promptHint: '当前内心积累了较多失落或抑郁情绪，表面或许仍试图掩饰或说反话，但会在细节里透出一点脆弱、疲惫或未说出口的心事。',
    stickerCooldown: 3
  },
  {
    name: '戒备防线 · 疏离反应',
    metric: 'tension',
    operator: '>=',
    threshold: 65,
    promptHint: '当前紧张或戒备度较高，回答会更简短谨慎、保持距离感，不再轻易交底或附和玩笑。',
    stickerCooldown: 3
  }
]);

export function normalizeEmotionTriggers(list = []) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of list.slice(0, 20)) {
    if (!raw || typeof raw !== 'object') continue;
    const metric = VALID_METRICS.has(raw.metric) ? raw.metric : 'affection';
    const operator = raw.operator === '<=' ? '<=' : '>=';
    const rawThreshold = Number(raw.threshold);
    const threshold = Number.isFinite(rawThreshold) ? Math.min(100, Math.max(0, Math.round(rawThreshold))) : 60;
    const idBase = typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(raw.id)
      ? raw.id
      : `trig_${result.length + 1}_${Date.now().toString(36)}`;
    let id = idBase;
    if (seen.has(id)) id = `${idBase}_${result.length + 1}`;
    seen.add(id);

    const cooldown = Number(raw.stickerCooldown);
    const stickerCooldown = Number.isFinite(cooldown) ? Math.min(20, Math.max(1, Math.round(cooldown))) : 3;
    const sticker = raw.sticker && typeof raw.sticker === 'object' && typeof raw.sticker.filename === 'string' && raw.sticker.filename.trim()
      ? { filename: raw.sticker.filename.trim(), mimeType: String(raw.sticker.mimeType || 'image/png') }
      : null;

    result.push({
      id,
      enabled: raw.enabled !== false,
      name: String(raw.name || '').trim().slice(0, 40) || '情绪触发规则',
      metric,
      operator,
      threshold,
      promptHint: String(raw.promptHint || '').trim().slice(0, 400),
      sticker,
      stickerCooldown
    });
  }
  return result;
}

export function matchEmotionTriggers(emotionState, triggers = []) {
  if (!emotionState || !Array.isArray(triggers) || !triggers.length) return [];
  const matched = [];
  for (const rule of triggers) {
    if (!rule || rule.enabled === false) continue;
    const value = Number(emotionState[rule.metric] ?? 0);
    const hit = rule.operator === '<=' ? value <= rule.threshold : value >= rule.threshold;
    if (hit) matched.push(rule);
  }
  return matched;
}

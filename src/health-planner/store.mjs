import { existsSync, lstatSync, mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { safeEqual } from '../config.mjs';
import { beijingDateParts, clamp } from './nutrition.mjs';

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const SLOT_KEYS = ['morningOverview', 'breakfast', 'lunch', 'dinner'];

export function defaultHealthPlannerSettings() {
  return {
    enabled: true,
    renderCard: true,
    aiMenuEnhance: true,
    aiFoodVision: true,
    pushSlots: {
      morningOverview: '07:30',
      breakfast: '',
      lunch: '11:30',
      dinner: '17:30'
    }
  };
}

function privateWrite(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, data, { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}

function pruneRecordByDay(record, cutoffDay) {
  if (!record || typeof record !== 'object') return {};
  const next = {};
  for (const [day, value] of Object.entries(record)) {
    if (day >= cutoffDay) next[day] = value;
  }
  return next;
}

export class HealthPlannerStore {
  constructor(dataDir, { now = Date.now } = {}) {
    this.now = now;
    const dir = join(dataDir, 'health-planner');
    for (const path of [dir, join(dir, 'key'), join(dir, 'accounts.enc')]) {
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error('健康饮食插件数据不能是符号链接');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.dir = dir;
    this.path = join(dir, 'accounts.enc');
    const keyPath = join(dir, 'key');
    if (!existsSync(keyPath)) {
      if (existsSync(this.path)) throw new Error('健康饮食插件密钥缺失，请恢复原密钥');
      writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    }
    chmodSync(keyPath, 0o600);
    this.key = readFileSync(keyPath);
    this.state = { version: 1, settings: defaultHealthPlannerSettings(), users: {} };

    if (existsSync(this.path)) {
      chmodSync(this.path, 0o600);
      try {
        const bytes = readFileSync(this.path);
        const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        const decoded = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
        if (decoded?.version !== 1 || !decoded.settings || !decoded.users) throw new Error('invalid');
        this.state = {
          version: 1,
          settings: {
            ...defaultHealthPlannerSettings(),
            ...decoded.settings,
            pushSlots: {
              ...defaultHealthPlannerSettings().pushSlots,
              ...(decoded.settings.pushSlots || {})
            }
          },
          users: decoded.users
        };
      } catch {
        throw new Error('健康饮食插件数据无法解密，请检查数据和密钥备份');
      }
    }
  }

  save() {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(this.state)), cipher.final()]);
    privateWrite(this.path, Buffer.concat([iv, cipher.getAuthTag(), bytes]));
  }

  getSettings() {
    return structuredClone(this.state.settings);
  }

  configure(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('健康饮食插件配置格式错误');
    }
    const allowedKeys = new Set(['enabled', 'renderCard', 'aiMenuEnhance', 'aiFoodVision', 'pushSlots']);
    for (const key of Object.keys(input)) {
      if (!allowedKeys.has(key)) throw new Error(`不支持的健康饮食配置项：${key}`);
    }
    const next = this.getSettings();
    for (const boolKey of ['enabled', 'renderCard', 'aiMenuEnhance', 'aiFoodVision']) {
      if (input[boolKey] !== undefined) {
        if (typeof input[boolKey] !== 'boolean') throw new Error(`${boolKey} 必须为布尔值`);
        next[boolKey] = input[boolKey];
      }
    }
    if (input.pushSlots !== undefined) {
      if (!input.pushSlots || typeof input.pushSlots !== 'object' || Array.isArray(input.pushSlots)) {
        throw new Error('推送时段配置格式错误');
      }
      for (const [slot, value] of Object.entries(input.pushSlots)) {
        if (!SLOT_KEYS.includes(slot)) throw new Error(`不支持的推送时段：${slot}`);
        const clean = typeof value === 'string' ? value.trim() : '';
        if (clean !== '' && !TIME_RE.test(clean)) {
          throw new Error(`推送时段 ${slot} 须为空或 HH:MM（24 小时制北京时间）`);
        }
        next.pushSlots[slot] = clean;
      }
    }
    const prev = this.state.settings;
    this.state.settings = next;
    try {
      this.save();
    } catch (error) {
      this.state.settings = prev;
      throw error;
    }
    return this.getSettings();
  }

  getUser(userId) {
    return this.state.users[String(userId)] || null;
  }

  ensureUser(userId, { userName = '', groupId = '' } = {}) {
    const uid = String(userId);
    if (!this.state.users[uid]) {
      if (Object.keys(this.state.users).length >= 500) {
        throw new Error('健康饮食档案数量已达上限（500 人），请联系管理员清理');
      }
      this.state.users[uid] = {
        userId: uid,
        userName: String(userName || '').slice(0, 60),
        groupId: String(groupId || ''),
        profile: null,
        push: { enabled: true, mode: 'all', channel: 'private', targetGroupId: String(groupId || '') },
        syncToken: randomBytes(24).toString('hex'),
        appleHealth: { days: {}, lastSyncAt: 0 },
        mealLogs: {},
        pendingAppleSync: [],
        pushedSlots: {},
        updatedAt: this.now()
      };
    }
    const user = this.state.users[uid];
    if (userName) user.userName = String(userName).slice(0, 60);
    if (groupId) user.groupId = String(groupId);
    return user;
  }

  upsertProfile(userId, { userName = '', groupId = '' }, profile) {
    const user = this.ensureUser(userId, { userName, groupId });
    user.profile = profile;
    user.updatedAt = this.now();
    this.save();
    return user;
  }

  updateUserPush(userId, patch) {
    const user = this.getUser(userId);
    if (!user) throw new Error('尚未录入健康档案');
    user.push = { ...user.push, ...patch };
    user.updatedAt = this.now();
    this.save();
    return user;
  }

  rotateSyncToken(userId, meta = {}) {
    const user = this.ensureUser(userId, meta);
    user.syncToken = randomBytes(24).toString('hex');
    user.updatedAt = this.now();
    this.save();
    return user.syncToken;
  }

  deleteUser(userId) {
    const uid = String(userId);
    if (!this.state.users[uid]) return false;
    delete this.state.users[uid];
    this.save();
    return true;
  }

  findUserByToken(token) {
    const candidate = String(token || '').trim();
    if (!candidate || candidate.length < 16 || candidate.length > 128) return null;
    let matched = null;
    for (const user of Object.values(this.state.users)) {
      if (user.syncToken && safeEqual(candidate, user.syncToken)) matched = user;
    }
    return matched;
  }

  pruneOldData(user) {
    const cutoff14 = beijingDateParts(this.now() - 14 * 86400000).day;
    const cutoff3 = beijingDateParts(this.now() - 3 * 86400000).day;
    if (user.appleHealth?.days) user.appleHealth.days = pruneRecordByDay(user.appleHealth.days, cutoff14);
    if (user.mealLogs) user.mealLogs = pruneRecordByDay(user.mealLogs, cutoff14);
    if (user.pushedSlots) {
      const kept = {};
      for (const [k, v] of Object.entries(user.pushedSlots)) {
        const day = k.split('|')[0];
        if (day >= cutoff3) kept[k] = v;
      }
      user.pushedSlots = kept;
    }
    if (Array.isArray(user.pendingAppleSync)) {
      user.pendingAppleSync = user.pendingAppleSync.filter(item => (item.day || cutoff14) >= cutoff14).slice(-100);
    }
  }

  recordAppleHealth(userId, day, payload) {
    const user = this.getUser(userId);
    if (!user) throw new Error('用户档案不存在');
    user.appleHealth ||= { days: {}, lastSyncAt: 0 };
    const existing = user.appleHealth.days[day] || {};
    const nextDay = { ...existing, updatedAt: this.now() };
    if (Number.isFinite(payload.steps) && payload.steps >= 0) nextDay.steps = Math.round(clamp(payload.steps, 0, 200000));
    if (Number.isFinite(payload.activeEnergyKcal) && payload.activeEnergyKcal >= 0) nextDay.activeEnergyKcal = Math.round(clamp(payload.activeEnergyKcal, 0, 15000));
    if (Number.isFinite(payload.restingEnergyKcal) && payload.restingEnergyKcal >= 0) nextDay.restingEnergyKcal = Math.round(clamp(payload.restingEnergyKcal, 0, 10000));
    if (Number.isFinite(payload.dietaryEnergyKcal) && payload.dietaryEnergyKcal >= 0) nextDay.dietaryEnergyKcal = Math.round(clamp(payload.dietaryEnergyKcal, 0, 20000));
    if (Number.isFinite(payload.proteinG) && payload.proteinG >= 0) nextDay.proteinG = Math.round(clamp(payload.proteinG, 0, 1000) * 10) / 10;
    if (Number.isFinite(payload.weightKg) && payload.weightKg >= 30 && payload.weightKg <= 250) {
      const w = Math.round(payload.weightKg * 10) / 10;
      nextDay.weightKg = w;
      if (user.profile) user.profile.weightKg = w;
    }
    user.appleHealth.days[day] = nextDay;
    user.appleHealth.lastSyncAt = this.now();
    this.pruneOldData(user);
    this.save();
    return nextDay;
  }

  addMealLog(userId, day, entry, queueApple = true) {
    const user = this.getUser(userId);
    if (!user) throw new Error('尚未录入健康档案');
    user.mealLogs ||= {};
    user.mealLogs[day] ||= [];
    const log = {
      id: randomUUID().slice(0, 8),
      mealType: entry.mealType || 'lunch',
      summary: String(entry.summary || '').slice(0, 140),
      items: Array.isArray(entry.items) ? entry.items.slice(0, 12) : [],
      calories: Math.max(0, Math.round(Number(entry.calories || 0))),
      proteinG: Math.max(0, Math.round(Number(entry.proteinG || 0) * 10) / 10),
      carbsG: Math.max(0, Math.round(Number(entry.carbsG || 0) * 10) / 10),
      fatG: Math.max(0, Math.round(Number(entry.fatG || 0) * 10) / 10),
      source: entry.source || 'text',
      loggedAt: this.now()
    };
    user.mealLogs[day].push(log);
    let appleSyncItem = null;
    if (queueApple && log.calories > 0) {
      appleSyncItem = {
        id: log.id,
        day,
        mealType: log.mealType,
        summary: log.summary,
        calories: log.calories,
        proteinG: log.proteinG,
        carbsG: log.carbsG,
        fatG: log.fatG,
        loggedAtIso: new Date(log.loggedAt).toISOString()
      };
      user.pendingAppleSync ||= [];
      user.pendingAppleSync.push(appleSyncItem);
    }
    this.pruneOldData(user);
    this.save();
    return { log, appleSyncItem };
  }

  undoLastMealLog(userId, day) {
    const user = this.getUser(userId);
    if (!user || !Array.isArray(user.mealLogs?.[day]) || !user.mealLogs[day].length) return null;
    const removed = user.mealLogs[day].pop();
    if (!user.mealLogs[day].length) delete user.mealLogs[day];
    if (Array.isArray(user.pendingAppleSync)) {
      user.pendingAppleSync = user.pendingAppleSync.filter(item => item.id !== removed.id);
    }
    this.save();
    return removed;
  }

  pullPendingAppleSync(userId) {
    const user = this.getUser(userId);
    if (!user) return [];
    return structuredClone(user.pendingAppleSync || []);
  }

  ackAppleSync(userId, ids) {
    const user = this.getUser(userId);
    if (!user) return 0;
    const removeSet = new Set((Array.isArray(ids) ? ids : []).map(id => String(id)));
    const before = (user.pendingAppleSync || []).length;
    user.pendingAppleSync = (user.pendingAppleSync || []).filter(item => !removeSet.has(String(item.id)));
    const removed = before - user.pendingAppleSync.length;
    if (removed > 0) this.save();
    return removed;
  }

  claimPushSlot(userId, day, slotKey) {
    const user = this.getUser(userId);
    if (!user) return false;
    const key = `${day}|${slotKey}`;
    user.pushedSlots ||= {};
    if (Object.hasOwn(user.pushedSlots, key)) return false;
    user.pushedSlots[key] = this.now();
    this.pruneOldData(user);
    this.save();
    return true;
  }

  publicSummary() {
    const today = beijingDateParts(this.now()).day;
    const users = Object.values(this.state.users);
    let withProfile = 0, appleBoundCount = 0, pushEnabledCount = 0, mealsLoggedToday = 0, pushesToday = 0, pendingAppleItems = 0;
    for (const u of users) {
      if (u.profile) withProfile++;
      if (u.appleHealth?.lastSyncAt > 0) appleBoundCount++;
      if (u.profile && u.push?.enabled !== false) pushEnabledCount++;
      mealsLoggedToday += (u.mealLogs?.[today] || []).length;
      pendingAppleItems += (u.pendingAppleSync || []).length;
      pushesToday += Object.keys(u.pushedSlots || {}).filter(k => k.startsWith(`${today}|`)).length;
    }
    return {
      settings: this.getSettings(),
      timezone: 'Asia/Shanghai',
      stats: {
        userCount: withProfile,
        appleBoundCount,
        pushEnabledCount,
        mealsLoggedToday,
        pushesToday,
        pendingAppleItems
      }
    };
  }
}

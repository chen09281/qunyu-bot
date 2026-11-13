import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCharacterCard, embedCardIntoPng, isPngBuffer } from './card-parser.mjs';
import { EmotionManager, normalizeEmotionTriggers } from './emotions.mjs';
import { rasterDimensions } from '../web-images.mjs';
import { atomicWriteBuffer, atomicWriteJson, quarantineCorruptFile } from '../security.mjs';

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;
function assertValidId(id, label = 'ID') {
  if (typeof id !== 'string' || !VALID_ID.test(id)) {
    throw new Error(`无效的${label}`);
  }
}

function detectImageFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { ext: 'png', mimeType: 'image/png' };
  const ascii6 = buffer.toString('ascii', 0, 6);
  if (ascii6 === 'GIF87a' || ascii6 === 'GIF89a') return { ext: 'gif', mimeType: 'image/gif' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return { ext: 'jpg', mimeType: 'image/jpeg' };
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mimeType: 'image/webp' };
  return null;
}

function safeFile(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error('酒馆文件路径不能是符号链接');
  }
}

export class TavernManager {
  constructor(dataDir = 'data') {
    this.dataDir = dataDir;
    this.baseDir = join(dataDir, 'tavern');
    this.charDir = join(this.baseDir, 'characters');
    this.avatarDir = join(this.baseDir, 'avatars');
    this.stickerDir = join(this.baseDir, 'stickers');
    this.configFile = join(this.baseDir, 'config.json');

    this.ensureDirs();
    this.state = this.loadConfig();
    this.emotions = new EmotionManager(dataDir);
  }

  ensureDirs() {
    for (const dir of [this.baseDir, this.charDir, this.avatarDir, this.stickerDir]) {
      safeFile(dir);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    }
  }

  loadConfig() {
    safeFile(this.configFile);
    const initial = {
      enabled: false,
      defaultCharacterId: '',
      emotionScopeMode: 'group',
      groupBindings: {}, // { [groupId]: characterId }
      userBindings: {},  // { [userId]: characterId }
      characterParams: {}, // { [charId]: { temperature, maxTokens } }
      pendingOocNotes: {} // { [scopeKey]: string }
    };
    if (!existsSync(this.configFile)) {
      this.saveConfig(initial);
      return initial;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.configFile, 'utf8'));
      return {
        ...initial,
        ...parsed,
        emotionScopeMode: parsed?.emotionScopeMode === 'group-member' ? 'group-member' : 'group',
        pendingOocNotes: parsed?.pendingOocNotes && typeof parsed.pendingOocNotes === 'object' && !Array.isArray(parsed.pendingOocNotes) ? parsed.pendingOocNotes : {}
      };
    } catch (error) {
      const backup = quarantineCorruptFile(this.configFile);
      console.error(`[tavern] 配置文件损坏，已隔离至 ${backup || this.configFile}: ${error.message}`);
      this.saveConfig(initial);
      return initial;
    }
  }

  saveConfig(newState = this.state) {
    this.ensureDirs();
    safeFile(this.configFile);
    const rawOoc = newState?.pendingOocNotes && typeof newState.pendingOocNotes === 'object' && !Array.isArray(newState.pendingOocNotes)
      ? Object.fromEntries(Object.entries(newState.pendingOocNotes)
        .filter(([k, v]) => typeof k === 'string' && k.length <= 120 && typeof v === 'string' && v.trim())
        .slice(0, 200)
        .map(([k, v]) => [k, v.trim().slice(0, 500)]))
      : {};
    const normalized = {
      enabled: Boolean(newState?.enabled),
      defaultCharacterId: typeof newState?.defaultCharacterId === 'string' && VALID_ID.test(newState.defaultCharacterId) ? newState.defaultCharacterId : '',
      emotionScopeMode: newState?.emotionScopeMode === 'group-member' ? 'group-member' : 'group',
      groupBindings: newState?.groupBindings && typeof newState.groupBindings === 'object' && !Array.isArray(newState.groupBindings) ? newState.groupBindings : {},
      userBindings: newState?.userBindings && typeof newState.userBindings === 'object' && !Array.isArray(newState.userBindings) ? newState.userBindings : {},
      characterParams: newState?.characterParams && typeof newState.characterParams === 'object' && !Array.isArray(newState.characterParams) ? newState.characterParams : {},
      pendingOocNotes: rawOoc
    };
    atomicWriteJson(this.configFile, normalized);
    this.state = normalized;
  }

  oocScopeKey(scope = {}) {
    if (scope && typeof scope === 'object' && scope.isPrivate && scope.userId) return `private:${scope.userId}`;
    if (scope && typeof scope === 'object' && !scope.isPrivate && scope.groupId) {
      return scope.userId ? `group:${scope.groupId}:user:${scope.userId}` : `group:${scope.groupId}`;
    }
    return typeof scope === 'string' && scope ? scope : 'default';
  }

  setPendingOoc(scope = {}, instruction = '') {
    const key = this.oocScopeKey(scope);
    const text = String(instruction || '').trim().slice(0, 500);
    const notes = { ...(this.state.pendingOocNotes || {}) };
    if (!text) delete notes[key];
    else notes[key] = text;
    this.saveConfig({ ...this.state, pendingOocNotes: notes });
    return text;
  }

  getPendingOoc(scope = {}) {
    const key = this.oocScopeKey(scope);
    const notes = this.state.pendingOocNotes || {};
    if (notes[key]) return notes[key];
    if (scope && typeof scope === 'object' && !scope.isPrivate && scope.groupId && notes[`group:${scope.groupId}`]) {
      return notes[`group:${scope.groupId}`];
    }
    return '';
  }

  clearPendingOoc(scope = {}) {
    const key = this.oocScopeKey(scope);
    const notes = { ...(this.state.pendingOocNotes || {}) };
    let changed = false;
    if (Object.hasOwn(notes, key)) { delete notes[key]; changed = true; }
    if (scope && typeof scope === 'object' && !scope.isPrivate && scope.groupId) {
      const groupKey = `group:${scope.groupId}`;
      if (Object.hasOwn(notes, groupKey)) { delete notes[groupKey]; changed = true; }
    }
    if (changed) this.saveConfig({ ...this.state, pendingOocNotes: notes });
    return changed;
  }

  /**
   * 列出所有角色
   */
  listCharacters() {
    this.ensureDirs();
    const files = readdirSync(this.charDir).filter(f => f.endsWith('.json'));
    const list = [];
    for (const file of files) {
      try {
        const fullPath = join(this.charDir, file);
        safeFile(fullPath);
        const card = JSON.parse(readFileSync(fullPath, 'utf8'));
        const id = file.replace(/\.json$/, '');
        const hasAvatar = existsSync(join(this.avatarDir, `${id}.png`));
        list.push({
          id,
          name: card.name || '未命名',
          description: card.description || '',
          personality: card.personality || '',
          scenario: card.scenario || '',
          first_mes: card.first_mes || '',
          tags: card.tags || [],
          creator: card.creator || '',
          hasAvatar,
          hasLorebook: Boolean(card.character_book?.entries?.length),
          isDefault: this.state.defaultCharacterId === id
        });
      } catch {
        // 跳过损坏的卡片
      }
    }
    return list;
  }

  /**
   * 获取指定角色卡详情
   */
  getCharacter(id) {
    if (!id || typeof id !== 'string' || !VALID_ID.test(id)) return null;
    const fullPath = join(this.charDir, `${id}.json`);
    safeFile(fullPath);
    if (!existsSync(fullPath)) return null;
    try {
      const card = JSON.parse(readFileSync(fullPath, 'utf8'));
      const hasAvatar = existsSync(join(this.avatarDir, `${id}.png`));
      return { ...card, id, hasAvatar };
    } catch {
      return null;
    }
  }

  /**
   * 获取角色头像（Buffer）
   */
  getAvatar(id) {
    if (!id || typeof id !== 'string' || !VALID_ID.test(id)) return null;
    const avatarPath = join(this.avatarDir, `${id}.png`);
    safeFile(avatarPath);
    if (existsSync(avatarPath)) {
      return readFileSync(avatarPath);
    }
    return null;
  }

  /**
   * 保存或更新角色
   */
  saveCharacter(id, cardData, avatarBuffer = null) {
    this.ensureDirs();
    if (id) assertValidId(id, '角色 ID');
    const charId = id || randomUUID();
    const fullPath = join(this.charDir, `${charId}.json`);
    safeFile(fullPath);
    atomicWriteJson(fullPath, cardData);

    if (avatarBuffer && Buffer.isBuffer(avatarBuffer)) {
      const avatarPath = join(this.avatarDir, `${charId}.png`);
      safeFile(avatarPath);
      atomicWriteBuffer(avatarPath, avatarBuffer);
    }

    // 若当前没有默认角色，则自动设为默认
    if (!this.state.defaultCharacterId) {
      this.state.defaultCharacterId = charId;
      this.saveConfig();
    }

    return this.getCharacter(charId);
  }

  /**
   * 从上传的 Buffer 导入角色卡 (PNG 或 JSON)
   */
  importCharacter(buffer, preferredName = '') {
    this.ensureDirs();
    const card = parseCharacterCard(buffer);
    const id = randomUUID();

    // 如果上传的是 PNG，则原图直接作为头像保存
    let avatarBuffer = null;
    if (isPngBuffer(buffer)) {
      avatarBuffer = buffer;
    }

    if (preferredName) {
      card.name = preferredName;
    }

    return this.saveCharacter(id, card, avatarBuffer);
  }

  /**
   * 删除角色卡
   */
  deleteCharacter(id) {
    if (!id || typeof id !== 'string' || !VALID_ID.test(id)) return false;
    const fullPath = join(this.charDir, `${id}.json`);
    const avatarPath = join(this.avatarDir, `${id}.png`);
    let deleted = false;
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
      deleted = true;
    }
    if (existsSync(avatarPath)) {
      unlinkSync(avatarPath);
    }

    // 清除绑定
    if (this.state.defaultCharacterId === id) {
      this.state.defaultCharacterId = '';
    }
    for (const [k, v] of Object.entries(this.state.groupBindings)) {
      if (v === id) delete this.state.groupBindings[k];
    }
    for (const [k, v] of Object.entries(this.state.userBindings)) {
      if (v === id) delete this.state.userBindings[k];
    }
    delete this.state.characterParams[id];
    this.emotions.reset(id);
    if (existsSync(this.stickerDir)) {
      for (const file of readdirSync(this.stickerDir)) {
        if (file.startsWith(`${id}-`)) {
          try { unlinkSync(join(this.stickerDir, file)); } catch {}
        }
      }
    }
    this.saveConfig();

    return deleted;
  }

  getEmotionTriggers(charId) {
    return normalizeEmotionTriggers(this.state.characterParams?.[charId]?.emotionTriggers || []);
  }

  setEmotionTriggers(charId, triggers = []) {
    assertValidId(charId, '角色 ID');
    if (!this.getCharacter(charId)) throw new Error('角色不存在');
    const normalized = normalizeEmotionTriggers(triggers);
    for (const rule of normalized) {
      if (rule.sticker?.filename && !rule.sticker.filename.startsWith(`${charId}-`)) {
        throw new Error('触发器表情包必须属于当前角色');
      }
    }
    if (!this.state.characterParams[charId] || typeof this.state.characterParams[charId] !== 'object') {
      this.state.characterParams[charId] = {};
    }
    this.state.characterParams[charId].emotionTriggers = normalized;
    this.saveConfig();
    if (existsSync(this.stickerDir)) {
      const referenced = new Set(normalized.map(rule => rule.sticker?.filename).filter(Boolean));
      for (const file of readdirSync(this.stickerDir)) {
        if (file.startsWith(`${charId}-`) && !referenced.has(file)) {
          try { unlinkSync(join(this.stickerDir, file)); } catch {}
        }
      }
    }
    return normalized;
  }

  saveTriggerSticker(charId, ruleId, buffer, _mimeType = 'image/png') {
    assertValidId(charId, '角色 ID');
    assertValidId(ruleId, '规则 ID');
    if (!this.getCharacter(charId)) throw new Error('角色不存在');
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('表情包图片不能为空');
    if (buffer.length > 4 * 1024 * 1024) throw new Error('表情包图片不能超过 4 MiB');
    const detected = detectImageFormat(buffer);
    const size = rasterDimensions(buffer);
    if (!detected || !size || !size.width || !size.height || size.width * size.height > 40_000_000) {
      throw new Error('表情包必须是有效的 PNG、JPEG、GIF 或 WebP 图片，且不超过 4000 万像素');
    }
    const { ext, mimeType } = detected;
    const safeRule = ruleId;
    const filename = `${charId}-${safeRule}.${ext}`;
    this.ensureDirs();
    const prefix = `${charId}-${safeRule}.`;
    for (const file of readdirSync(this.stickerDir)) {
      if (file.startsWith(prefix) && file !== filename) {
        try { unlinkSync(join(this.stickerDir, file)); } catch {}
      }
    }
    const target = join(this.stickerDir, filename);
    safeFile(target);
    atomicWriteBuffer(target, buffer);
    const triggers = this.getEmotionTriggers(charId);
    const idx = triggers.findIndex(t => t.id === safeRule);
    if (idx >= 0) {
      triggers[idx] = { ...triggers[idx], sticker: { filename, mimeType } };
      this.setEmotionTriggers(charId, triggers);
    }
    return { filename, mimeType };
  }

  deleteTriggerSticker(charId, ruleId) {
    const triggers = this.getEmotionTriggers(charId);
    const idx = triggers.findIndex(t => t.id === ruleId);
    if (idx < 0) return triggers;
    const oldFilename = triggers[idx].sticker?.filename;
    if (oldFilename && /^[a-zA-Z0-9_.-]+$/.test(oldFilename)) {
      const target = join(this.stickerDir, oldFilename);
      if (existsSync(target)) try { unlinkSync(target); } catch {}
    }
    triggers[idx] = { ...triggers[idx], sticker: null };
    return this.setEmotionTriggers(charId, triggers);
  }

  readTriggerSticker(filename) {
    if (!filename || !/^[a-zA-Z0-9_.-]+$/.test(filename)) return null;
    const target = join(this.stickerDir, filename);
    safeFile(target);
    if (!existsSync(target)) return null;
    return readFileSync(target);
  }

  /**
   * 根据当前会话获取激活的角色卡
   * @param {Object} scope { isPrivate: boolean, userId: string, groupId?: string }
   */
  getActiveCharacter(scope = {}) {
    let charId = '';
    if (scope.isPrivate && scope.userId && this.state.userBindings[String(scope.userId)]) {
      charId = this.state.userBindings[String(scope.userId)];
    } else if (!scope.isPrivate && scope.groupId && this.state.groupBindings[String(scope.groupId)]) {
      charId = this.state.groupBindings[String(scope.groupId)];
    } else {
      charId = this.state.defaultCharacterId;
    }

    if (charId) {
      const char = this.getCharacter(charId);
      if (char) return char;
    }

    // 兜底：若绑定失效，尝试返回列表中的第一个角色
    const all = this.listCharacters();
    if (all.length > 0) {
      return this.getCharacter(all[0].id);
    }

    return null;
  }

  /**
   * 绑定角色卡到指定会话
   */
  bindCharacter(scope = {}, characterId) {
    if (!characterId) return false;
    const char = this.getCharacter(characterId);
    if (!char) throw new Error(`未找到 ID 为 ${characterId} 的角色卡`);

    if (scope.isPrivate && scope.userId) {
      this.state.userBindings[String(scope.userId)] = characterId;
    } else if (!scope.isPrivate && scope.groupId) {
      this.state.groupBindings[String(scope.groupId)] = characterId;
    } else {
      this.state.defaultCharacterId = characterId;
    }
    this.saveConfig();
    return true;
  }

  /**
   * 重置/解绑会话角色卡
   */
  unbindCharacter(scope = {}) {
    if (scope.isPrivate && scope.userId) {
      delete this.state.userBindings[String(scope.userId)];
    } else if (!scope.isPrivate && scope.groupId) {
      delete this.state.groupBindings[String(scope.groupId)];
    }
    this.saveConfig();
  }
}

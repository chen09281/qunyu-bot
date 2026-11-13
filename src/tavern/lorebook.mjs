/**
 * 世界书（Lorebook / World Info）扫描与条目激活引擎
 */
export class LorebookEngine {
  /**
   * 规范化世界书条目列表
   */
  static normalizeEntries(entries = []) {
    if (!Array.isArray(entries)) return [];
    return entries.map((entry, idx) => ({
      id: String(entry.id || `entry_${idx}`),
      name: String(entry.name || `设定_${idx + 1}`),
      keys: Array.isArray(entry.keys)
        ? entry.keys.map(k => String(k || '').trim().toLowerCase()).filter(Boolean)
        : (typeof entry.keys === 'string' ? entry.keys.split(/[,，]/).map(k => k.trim().toLowerCase()).filter(Boolean) : []),
      secondaryKeys: Array.isArray(entry.secondaryKeys || entry.secondary_keys)
        ? (entry.secondaryKeys || entry.secondary_keys).map(k => String(k || '').trim().toLowerCase()).filter(Boolean)
        : (typeof (entry.secondaryKeys || entry.secondary_keys) === 'string'
          ? (entry.secondaryKeys || entry.secondary_keys).split(/[,，]/).map(k => k.trim().toLowerCase()).filter(Boolean)
          : []),
      content: String(entry.content || '').trim(),
      enabled: entry.enabled !== false,
      constant: Boolean(entry.constant),
      position: ['before_char', 'after_char', 'depth'].includes(entry.position) ? entry.position : 'before_char',
      order: Number.isFinite(entry.order ?? entry.insertion_order) ? Number(entry.order ?? entry.insertion_order) : (idx * 10)
    })).filter(e => e.content);
  }

  /**
   * 根据上下文扫描并激活条目
   * @param {Array} entries 条目列表
   * @param {Array<string>|string} contextInput 最近的对话文本或文本数组
   * @param {Object} options 扫描选项
   * @returns {Array} 激活的条目列表，已按 order 排序
   */
  static scanAndActivate(entries = [], contextInput = '', options = {}) {
    const list = this.normalizeEntries(entries);
    if (!list.length) return [];

    const fullText = (Array.isArray(contextInput) ? contextInput.join('\n') : String(contextInput || '')).toLowerCase();

    const activated = [];

    for (const entry of list) {
      if (!entry.enabled) continue;

      // 1. 常量设定：无条件激活
      if (entry.constant) {
        activated.push(entry);
        continue;
      }

      // 2. 检查主关键词（OR 关系）
      if (!entry.keys || !entry.keys.length) continue;
      const primaryHit = entry.keys.some(key => fullText.includes(key));
      if (!primaryHit) continue;

      // 3. 检查次级关键词（若存在，则需 AND 关系）
      if (entry.secondaryKeys && entry.secondaryKeys.length > 0) {
        const secondaryHit = entry.secondaryKeys.some(key => fullText.includes(key));
        if (!secondaryHit) continue;
      }

      activated.push(entry);
    }

    // 按 order 升序排序
    return activated.sort((a, b) => a.order - b.order);
  }

  /**
   * 将激活的条目整理为用于注入 Prompt 的格式文本
   * @param {Array} activatedEntries 激活的条目
   * @param {string} position 'before_char' | 'after_char' | 'all'
   */
  static formatForPrompt(activatedEntries = [], position = 'all') {
    const filtered = position === 'all'
      ? activatedEntries
      : activatedEntries.filter(e => e.position === position);

    if (!filtered.length) return '';

    return filtered.map(e => `[设定: ${e.name || '背景'}]\n${e.content}`).join('\n\n');
  }
}

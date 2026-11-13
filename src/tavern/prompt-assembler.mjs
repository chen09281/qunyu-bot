import { LorebookEngine } from './lorebook.mjs';
import { EMOTION_METRICS, matchEmotionTriggers } from './emotions.mjs';

/**
 * 酒馆 Prompt 组装与宏替换引擎
 */
export class PromptAssembler {
  /**
   * 执行文本宏替换
   * @param {string} text 待替换文本
   * @param {Object} context 变量上下文
   */
  static replaceMacros(text, context = {}) {
    if (typeof text !== 'string') return '';
    const charName = String(context.char || '角色').trim();
    const userName = String(context.user || '用户').trim();
    const input = String(context.input || '').trim();
    const scenario = String(context.scenario || '').trim();
    const personality = String(context.personality || '').trim();
    const description = String(context.description || '').trim();

    return text
      .replaceAll(/\{\{char\}\}/gi, charName)
      .replaceAll(/<BOT>/gi, charName)
      .replaceAll(/<CHAR>/gi, charName)
      .replaceAll(/\{\{user\}\}/gi, userName)
      .replaceAll(/<USER>/gi, userName)
      .replaceAll(/\{\{input\}\}/gi, input)
      .replaceAll(/\{\{scenario\}\}/gi, scenario)
      .replaceAll(/\{\{personality\}\}/gi, personality)
      .replaceAll(/\{\{description\}\}/gi, description);
  }

  /**
   * 组装完整的 messages 数组供给大模型
   * @param {Object} options
   * @param {Object} options.card 角色卡对象
   * @param {string} options.userName 当前说话的用户昵称
   * @param {string} options.prompt 本次用户输入
   * @param {Array} options.history 历史轮次 [{role, content}]
   * @param {Array} options.externalLorebook 外部独立世界书条目 (可选)
   * @param {string} options.systemNote 临时旁白或系统附加提示 (如 OOC 指导)
   */
  static assembleMessages({
    card,
    userName = '群友',
    prompt = '',
    history = [],
    externalLorebook = [],
    systemNote = '',
    emotionState = null,
    emotionTriggers = []
  }) {
    if (!card) throw new Error('必须提供有效的角色卡数据');

    const context = {
      char: card.name,
      user: userName,
      input: prompt,
      scenario: card.scenario,
      personality: card.personality,
      description: card.description
    };

    const macro = t => this.replaceMacros(t, context);

    // 1. 扫描与提取世界书（卡片内嵌 + 外部世界书）
    const allLorebookEntries = [
      ...(card.character_book?.entries || []),
      ...(externalLorebook || [])
    ];

    // 收集最近上下文文本以供世界书关键词扫描
    const recentContext = [
      prompt,
      ...history.slice(-6).map(h => h.content)
    ];
    const activatedLore = LorebookEngine.scanAndActivate(allLorebookEntries, recentContext);

    const loreBefore = macro(LorebookEngine.formatForPrompt(activatedLore, 'before_char'));
    const loreAfter = macro(LorebookEngine.formatForPrompt(activatedLore, 'after_char'));
    const loreGeneral = macro(LorebookEngine.formatForPrompt(activatedLore, 'all'));

    // 2. 构建 System Prompt 段落
    const systemParts = [];

    // 通用角色扮演指示
    systemParts.push(`【酒馆角色扮演核心协议】
你正在扮演角色「${card.name}」。你必须沉浸在该角色的身份、口吻、性格、生活习惯和世界观中与「${userName}」交流。
- 日常对话保持角色沉浸，不使用“作为人工智能”等机械套话；若用户直接认真询问你的真实身份或是否为 AI，可简短坦诚说明自己是虚拟角色扮演，然后再自然回到对话氛围。
- 遵循自然真实的聊天风格，根据情境和人设变化语气，不做刻板复读。
- 对话正文直接输出角色的回复，可酌情用括号描写简短神态或动作（如「（轻轻叹气）」「（递过一杯红茶）」），但不要写长篇旁白或越俎代庖替用户做决定。`);

    // 角色卡专属 System Prompt
    if (card.system_prompt) {
      systemParts.push(`【角色专属指令】\n${macro(card.system_prompt)}`);
    }

    // 情绪与关系状态
    if (emotionState) {
      const metrics = EMOTION_METRICS.map(m => `${m.label}: ${emotionState[m.key] || 0}`).join(' | ');
      systemParts.push(`【当前情绪与关系状态】
关系阶段: ${emotionState.stage}
${metrics}
心境: ${emotionState.mood}
最近波动: ${emotionState.reason}

【情绪状态更新输出协议】
在每次回复的最末尾，你必须输出一行如下格式的隐藏标签，用于更新情绪状态：
[[TAVERN_EMOTION:{"affection":0,"joy":0,"trust":0,"tension":0,"depression":0,"mood":"心境短语","reason":"一句话变化原因"}]]
数值为单轮增减量（-10至10），根据对话表现动态调整，mood 与 reason 为必要项。`);
      const triggered = matchEmotionTriggers(emotionState, emotionTriggers).filter(rule => rule.promptHint);
      if (triggered.length) {
        systemParts.push(
          `【已触发的情绪状态与彩蛋指令】\n` +
          triggered.map(rule => `- [${rule.name}] ${macro(rule.promptHint)}`).join('\n')
        );
      }
    }

    // 世界书：角色前设定
    if (loreBefore) {
      systemParts.push(`【世界观与前置设定】\n${loreBefore}`);
    }

    // 角色核心设定（Description, Personality, Scenario）
    const charDetails = [];
    if (card.description) charDetails.push(`【外貌与身份背景】\n${macro(card.description)}`);
    if (card.personality) charDetails.push(`【性格特征】\n${macro(card.personality)}`);
    if (card.scenario) charDetails.push(`【当前场景与剧情】\n${macro(card.scenario)}`);

    if (charDetails.length) {
      systemParts.push(charDetails.join('\n\n'));
    }

    // 世界书：角色后设定（若未分前后则包含整体）
    if (loreAfter) {
      systemParts.push(`【相关情境知识】\n${loreAfter}`);
    } else if (loreGeneral && !loreBefore) {
      systemParts.push(`【世界观背景与关联知识】\n${loreGeneral}`);
    }

    // 示例对话（Mes Example）
    if (card.mes_example) {
      systemParts.push(`【对话语气与风格参考示例】\n${macro(card.mes_example)}`);
    }

    // 临时导演指导或 OOC
    if (systemNote) {
      systemParts.push(`【当前场外导演要求 (OOC)】\n${macro(systemNote)}`);
    }

    const maxSystemChars = 32000;
    const boundedParts = [];
    let usedChars = 0;
    for (const part of systemParts) {
      if (!part) continue;
      const sep = boundedParts.length ? 2 : 0;
      const remaining = maxSystemChars - usedChars - sep;
      if (remaining <= 0) break;
      if (part.length <= remaining) {
        boundedParts.push(part);
        usedChars += sep + part.length;
      } else {
        boundedParts.push(part.slice(0, remaining));
        break;
      }
    }

    const messages = [
      { role: 'system', content: boundedParts.join('\n\n') }
    ];

    // 3. 历史对话注入
    // 如果历史记录中没有任何助手消息，且角色卡有开场白 first_mes，可将开场白作为第一条 assistant 消息注入
    const processedHistory = [];
    if (history.length === 0 && card.first_mes) {
      processedHistory.push({
        role: 'assistant',
        content: macro(card.first_mes)
      });
    }

    for (const item of history) {
      processedHistory.push({
        role: item.role,
        content: macro(item.content)
      });
    }

    messages.push(...processedHistory);

    // 4. 深度注入 (post_history_instructions / Author's Note)
    if (card.post_history_instructions) {
      messages.push({
        role: 'system',
        content: `【即时行文提醒】\n${macro(card.post_history_instructions).slice(0, 4000)}`
      });
    }

    return { messages, macro };
  }

  /**
   * 为定时主动问候生成保持酒馆人设的简短提示词
   */
  static assembleProactiveGreeting({ card, emotionState = null } = {}) {
    const context = {
      char: card?.name || '角色',
      user: '大家',
      scenario: card?.scenario || '',
      personality: card?.personality || '',
      description: card?.description || ''
    };
    const macro = t => this.replaceMacros(t, context);
    const parts = [
      `你正在扮演角色「${context.char}」，现在按北京时间计划主动向 QQ 群友打招呼，没有成员在提问。`,
      card?.personality ? `【性格特征】\n${macro(card.personality).slice(0, 600)}` : '',
      card?.description ? `【角色设定摘要】\n${macro(card.description).slice(0, 600)}` : '',
      emotionState ? `【当前心境】阶段：${emotionState.stage}，心情：${emotionState.mood}` : '',
      '要求：严格用你当前角色的身份、口吻和生活细节来说 1–2 句轻松有趣的问候，控制在 100 字以内。贴合当前时段（如午饭补给、下午摸鱼、晚饭委托等轻趣联想），可以点缀简短动作或颜文字，不要固定开场，不要输出情绪标记标签，不 @ 人、不编造新闻天气、不宣称做现实任务，只返回发往群里的正文。'
    ].filter(Boolean);
    return [{ role: 'system', content: parts.join('\n\n') }];
  }

  static assembleFeedMessages({ card, userName = '群友', item = '', emotionState = null } = {}) {
    const context = { char: card?.name || '角色', user: userName, personality: card?.personality || '', description: card?.description || '', scenario: card?.scenario || '' };
    const macro = t => this.replaceMacros(t, context);
    const metrics = emotionState ? EMOTION_METRICS.map(m => `${m.label}: ${emotionState[m.key] ?? 0}`).join(' | ') : '';
    const sys = [
      `你正在扮演角色「${context.char}」。群友「${userName}」向你投喂/赠送了一件物品或礼物：${item}。`,
      card?.personality ? `【性格特征】\n${macro(card.personality).slice(0, 800)}` : '',
      card?.description ? `【角色设定】\n${macro(card.description).slice(0, 800)}` : '',
      emotionState ? `【当前状态】关系阶段：${emotionState.stage}（${metrics}），心境：${emotionState.mood}` : '',
      '请根据角色喜好、性格与当前关系，用 1–3 句生动的角色台词加简短神态描写作出反应，并在末尾附上一行隐藏情绪更新标签（单轮增减 -10 到 10）：\n[[TAVERN_EMOTION:{"affection":2,"joy":2,"trust":1,"tension":-1,"depression":-1,"mood":"开心","reason":"收到喜欢的投喂"}]]'
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: sys }, { role: 'user', content: `（递给你一份「${item}」）` }];
  }

  static assembleTheaterMessages({ cardA, cardB, topic = '日常闲聊' } = {}) {
    const macroA = this.replaceMacros(cardA?.personality || cardA?.description || '', { char: cardA?.name, user: cardB?.name });
    const macroB = this.replaceMacros(cardB?.personality || cardB?.description || '', { char: cardB?.name, user: cardA?.name });
    return [
      {
        role: 'system',
        content: [
          '你是一位擅长二次元轻小说对话编剧的导演。请让以下两位角色围绕给定主题展开一段 4–6 个回合、自然幽默且高度贴合各自人设的对戏小剧场：',
          `【角色 A】${cardA?.name}\n${macroA.slice(0, 900)}`,
          `【角色 B】${cardB?.name}\n${macroB.slice(0, 900)}`,
          '输出格式要求：纯文本剧场对白，每行格式为「角色名：台词（可带简短括号动作）」，共 4–6 行，总字数控制在 450 字以内，有起承转合和可爱反差或梗点，不输出多余解释或标签。'
        ].join('\n\n')
      },
      { role: 'user', content: `小剧场主题：${topic}` }
    ];
  }

  static extractEmotionUpdate(text) {
    const raw = String(text || '');
    const fullRegex = /\s*\[\s*\[\s*TAVERN_EMOTION\s*:\s*(?:```(?:json)?\s*)?(\{[\s\S]*?\})(?:\s*```)?\s*\]\s*\]\s*/gi;
    let update = null;
    for (const match of raw.matchAll(fullRegex)) {
      try {
        update = JSON.parse(match[1]);
      } catch {}
    }
    if (!update) {
      const looseMatch = raw.match(/\[\s*\[?\s*TAVERN_EMOTION\s*:\s*(?:```(?:json)?\s*)?(\{[\s\S]*?\})/i);
      if (looseMatch) {
        try {
          update = JSON.parse(looseMatch[1]);
        } catch {}
      }
    }
    const cleaned = raw
      .replace(fullRegex, '\n')
      .replace(/\s*\[\s*\[?\s*TAVERN_EMOTION[\s\S]*?(?:\]\s*\]|$)/gi, '')
      .trim();
    return { text: cleaned, update };
  }
}

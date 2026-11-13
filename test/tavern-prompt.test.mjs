import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptAssembler } from '../src/tavern/prompt-assembler.mjs';

test('PromptAssembler 宏替换与多层消息组装', () => {
  const card = {
    name: '芙莉莲',
    description: '存活了千年以上的高等精灵魔法使。',
    personality: '沉着、对时间感知迟钝，有些随性。',
    scenario: '正在收集民间魔法的旅途中。',
    first_mes: '你好，{{user}}。今天有什么有趣的魔法吗？',
    mes_example: '<START>\n{{user}}: 芙莉莲，早安。\n{{char}}: 早。太阳才刚升起呢。',
    system_prompt: '请严格展现精灵看待漫长时光的淡然态度。',
    post_history_instructions: '回复不超过3句话。',
    character_book: {
      entries: [
        {
          name: '魔导书',
          keys: ['魔导书', '魔法书'],
          content: '民间魔导书里记录着变成刨冰或透视衣服等奇怪的魔法。'
        }
      ]
    }
  };

  const { messages } = PromptAssembler.assembleMessages({
    card,
    userName: '辛美尔',
    prompt: '你能看看这本魔导书吗？',
    history: [],
    systemNote: '当前请表现出稍微有点惊讶'
  });

  // 1. 验证第一条 system 包含设定、宏替换后的内容和世界书
  const systemMsg = messages[0];
  assert.equal(systemMsg.role, 'system');
  assert.ok(systemMsg.content.includes('芙莉莲'));
  assert.ok(systemMsg.content.includes('辛美尔'));
  assert.ok(systemMsg.content.includes('民间魔导书里记录着'));
  assert.ok(systemMsg.content.includes('当前请表现出稍微有点惊讶'));

  // 2. 验证开场白作为第一条 assistant 注入历史
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content, '你好，辛美尔。今天有什么有趣的魔法吗？');

  // 3. 验证 post_history_instructions 深度注入在最后
  const lastMsg = messages[messages.length - 1];
  assert.equal(lastMsg.role, 'system');
  assert.ok(lastMsg.content.includes('回复不超过3句话'));
});

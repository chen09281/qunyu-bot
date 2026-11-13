import test from 'node:test';
import assert from 'node:assert/strict';
import { LorebookEngine } from '../src/tavern/lorebook.mjs';

test('Lorebook 常量与关键词命中', () => {
  const entries = [
    {
      name: '世界观背景',
      constant: true,
      content: '这个世界充满了以太能量。',
      order: 1
    },
    {
      name: '圣剑',
      keys: ['圣剑', '誓约胜利之剑'],
      content: '黄金之剑，由精灵铸造。',
      order: 10
    },
    {
      name: '魔王城-宝库',
      keys: ['宝库'],
      secondaryKeys: ['魔王城', '钥匙'],
      content: '宝库位于魔王城最深处，需要特殊钥匙才能开启。',
      order: 20
    }
  ];

  // 1. 没有任何命中时，只激活常量
  const res1 = LorebookEngine.scanAndActivate(entries, '今天天气真好。');
  assert.equal(res1.length, 1);
  assert.equal(res1[0].name, '世界观背景');

  // 2. 命中圣剑
  const res2 = LorebookEngine.scanAndActivate(entries, '你听说过那柄圣剑吗？');
  assert.equal(res2.length, 2);
  assert.equal(res2[1].name, '圣剑');

  // 3. 次级关键词未满足（只有宝库，没有魔王城或钥匙）
  const res3 = LorebookEngine.scanAndActivate(entries, '我们去宝库看看吧。');
  assert.equal(res3.length, 1); // 只有常量

  // 4. 次级关键词满足（宝库 + 魔王城）
  const res4 = LorebookEngine.scanAndActivate(entries, '听说魔王城的宝库里有秘宝！');
  assert.equal(res4.length, 2);
  assert.equal(res4[1].name, '魔王城-宝库');

  // 5. 格式化输出
  const prompt = LorebookEngine.formatForPrompt(res4);
  assert.ok(prompt.includes('以太能量'));
  assert.ok(prompt.includes('魔王城最深处'));
});

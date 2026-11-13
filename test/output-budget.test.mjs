import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig, openStore, validatePatch } from '../src/config.mjs';
import { Bot } from '../src/bot.mjs';

test('输出预算接受 99999999 和无上限开关，拒绝越界、非整数及伪布尔值', () => {
  const config = defaultConfig();
  assert.equal(config.maxTokens, 99999999); assert.equal(config.maxTokensUnlimited, false);
  assert.equal(validatePatch(config, { maxTokens: 99999999 }).maxTokens, 99999999);
  assert.equal(validatePatch(config, { maxTokensUnlimited: true }).maxTokensUnlimited, true);
  for (const patch of [{ maxTokens: 100000000 }, { maxTokens: 63 }, { maxTokens: 64.5 }, { maxTokens: '99999999' }, { maxTokensUnlimited: 'true' }, { maxTokensUnlimited: 1 }]) assert.throws(() => validatePatch(config, patch));
});

test('旧配置一次迁移到实际 99999999，之后保留自行保存的数字与无上限模式', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-output-budget-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = { ...defaultConfig(), maxTokens: 8192, systemPrompt: '保留回复风格', deepseekKey: 'SYNTHETIC_PRESERVED_KEY', allowedGroups: ['10003'], scheduledChatTimes: ['09:30'] };
  delete legacy.maxTokensUnlimited; writeFileSync(join(dir, 'config.json'), JSON.stringify(legacy));
  const store = await openStore(dir);
  assert.equal(store.config.maxTokens, 99999999); assert.equal(store.config.maxTokensUnlimited, false);
  assert.equal(store.config.deepseekKey, legacy.deepseekKey); assert.equal(store.config.systemPrompt, legacy.systemPrompt); assert.deepEqual(store.config.scheduledChatTimes, ['09:30']);
  store.save({ maxTokens: 1024, maxTokensUnlimited: true });
  const reopened = await openStore(dir); assert.equal(reopened.config.maxTokens, 1024); assert.equal(reopened.config.maxTokensUnlimited, true);
  reopened.save({ maxTokensUnlimited: false }); assert.equal((await openStore(dir)).config.maxTokens, 1024);
});

test('数字模式按原值实际传给 API，无上限模式不传 Token 参数，切回后恢复数字', async t => {
  const config = { ...defaultConfig(), deepseekKey: 'SYNTHETIC_TEST_KEY', webSearchEnabled: false, documentGenerationEnabled: false };
  const bot = new Bot({ config }); t.after(() => bot.close()); const calls = [];
  bot.request = async (_url, body) => { calls.push(body); return { choices: [{ message: { content: '回答' } }] }; };
  await bot.completion('数字模式', config); assert.equal(calls.at(-1).max_tokens, 99999999);
  config.maxTokensUnlimited = true; await bot.completion('无上限模式', config);
  assert.equal(Object.hasOwn(calls.at(-1), 'max_tokens'), false); assert.equal(Object.hasOwn(calls.at(-1), 'max_completion_tokens'), false);
  config.maxTokensUnlimited = false; await bot.completion('恢复数字', config); assert.equal(calls.at(-1).max_tokens, 99999999);
  config.maxTokensUnlimited = true; await bot.completion('定时简短问候', config, {}, [], [], () => {}, [], '', 'proactive');
  assert.equal(calls.at(-1).max_tokens, 256); assert.equal(config.maxTokensUnlimited, true);
});

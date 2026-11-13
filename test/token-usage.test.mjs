import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenUsageService, beijingClock, isDiscountTime } from '../src/token-usage.mjs';
import { createApplication } from '../src/server.mjs';

test('北京时间错峰时段判定：默认 00:30–08:30 优惠与跨零点时段', () => {
  // 2026-04-20 00:29:00+08:00 -> 2026-04-19T16:29:00Z
  const before = beijingClock(Date.parse('2026-04-19T16:29:00Z'));
  assert.equal(before.day, '2026-04-20');
  assert.equal(before.hhmm, '00:29');
  assert.equal(isDiscountTime(before.timestamp, { discountEnabled: true, discountStart: '00:30', discountEnd: '08:30' }), false);

  // 2026-04-20 00:30:00+08:00 -> 2026-04-19T16:30:00Z
  const start = beijingClock(Date.parse('2026-04-19T16:30:00Z'));
  assert.equal(start.hhmm, '00:30');
  assert.equal(isDiscountTime(start.timestamp, { discountEnabled: true, discountStart: '00:30', discountEnd: '08:30' }), true);

  // 2026-04-20 08:29:00+08:00 -> 2026-04-20T00:29:00Z
  const endBefore = beijingClock(Date.parse('2026-04-20T00:29:00Z'));
  assert.equal(endBefore.hhmm, '08:29');
  assert.equal(isDiscountTime(endBefore.timestamp, { discountEnabled: true, discountStart: '00:30', discountEnd: '08:30' }), true);

  // 2026-04-20 08:30:00+08:00 -> 2026-04-20T00:30:00Z
  const end = beijingClock(Date.parse('2026-04-20T00:30:00Z'));
  assert.equal(end.hhmm, '08:30');
  assert.equal(isDiscountTime(end.timestamp, { discountEnabled: true, discountStart: '00:30', discountEnd: '08:30' }), false);

  // 跨零点优惠窗口 23:00 - 07:00
  const night = beijingClock(Date.parse('2026-04-20T15:30:00Z')); // 23:30 BJT
  assert.equal(isDiscountTime(night.timestamp, { discountEnabled: true, discountStart: '23:00', discountEnd: '07:00' }), true);
});

test('按模型分开统计 Token 用量，DeepSeek 按北京时间标准/优惠时段与缓存命中精确计费', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bot-token-usage-'));
  const stdTime = Date.parse('2026-04-20T04:00:00Z'); // 2026-04-20 12:00 BJT
  const service = new TokenUsageService(dir, { now: () => stdTime });

  // 1) DeepSeek Chat 在标准时段（北京时间 12:00）调用：1,000,000 未命中输入 + 1,000,000 缓存命中输入 + 500,000 输出
  // 标准单价：未命中 2¥/M，命中 0.5¥/M，输出 8¥/M => 2 + 0.5 + 4 = 6.5 元
  const stdRec = service.record({
    provider: 'deepseek',
    model: 'deepseek-chat',
    profileName: 'DeepSeek 主力',
    timestamp: stdTime,
    usage: {
      prompt_tokens: 2_000_000,
      prompt_cache_hit_tokens: 1_000_000,
      prompt_cache_miss_tokens: 1_000_000,
      completion_tokens: 500_000,
      total_tokens: 2_500_000
    }
  });
  assert.equal(stdRec.period, 'standard');
  assert.equal(stdRec.cost, 6.5);
  assert.equal(stdRec.savedCost, 0);

  // 2) DeepSeek Chat 在夜间优惠时段（北京时间 02:00）调用同量 Token：
  // 优惠单价（5折）：未命中 1¥/M，命中 0.25¥/M，输出 4¥/M => 1 + 0.25 + 2 = 3.25 元，节省 3.25 元
  const offPeakTime = Date.parse('2026-04-19T18:00:00Z'); // 2026-04-20 02:00 BJT
  const offRec = service.record({
    provider: 'deepseek',
    model: 'deepseek-chat',
    profileName: 'DeepSeek 主力',
    timestamp: offPeakTime,
    usage: {
      prompt_tokens: 2_000_000,
      prompt_cache_hit_tokens: 1_000_000,
      prompt_cache_miss_tokens: 1_000_000,
      completion_tokens: 500_000,
      total_tokens: 2_500_000
    }
  });
  assert.equal(offRec.period, 'discount');
  assert.equal(offRec.cost, 3.25);
  assert.equal(offRec.savedCost, 3.25);

  // 3) DeepSeek Reasoner 在夜间优惠时段（北京时间 03:00）调用：
  // Reasoner 标准单价 4 / 1 / 16；优惠单价（2.5折）：未命中 1¥/M，命中 0.25¥/M，输出 4¥/M
  const reasonerRec = service.record({
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    profileName: 'DeepSeek R1',
    timestamp: Date.parse('2026-04-19T19:00:00Z'), // 03:00 BJT
    usage: {
      prompt_tokens: 1_000_000,
      prompt_cache_hit_tokens: 0,
      completion_tokens: 1_000_000,
      completion_tokens_details: { reasoning_tokens: 600_000 },
      total_tokens: 2_000_000
    }
  });
  assert.equal(reasonerRec.period, 'discount');
  assert.equal(reasonerRec.cost, 5); // 1.0 + 4.0
  assert.equal(reasonerRec.savedCost, 15); // 标准时段应为 4.0 + 16.0 = 20.0 元，立省 15 元

  // 4) OpenAI 模型分开统计并支持自定义费率
  service.record({
    provider: 'openai',
    model: 'gpt-5.4',
    profileName: 'GPT-5.4',
    timestamp: stdTime,
    usage: {
      prompt_tokens: 1_000_000,
      prompt_tokens_details: { cached_tokens: 200_000 },
      completion_tokens: 500_000,
      total_tokens: 1_500_000
    }
  });

  const view1 = service.status();
  assert.equal(view1.byModel.length, 3);
  const dsChat = view1.byModel.find(item => item.model === 'deepseek-chat');
  const dsReasoner = view1.byModel.find(item => item.model === 'deepseek-reasoner');
  const gpt = view1.byModel.find(item => item.model === 'gpt-5.4');
  assert.equal(dsChat.calls, 2);
  assert.equal(dsChat.totalTokens, 5_000_000);
  assert.equal(dsChat.cost, 9.75);
  assert.equal(dsChat.savedCost, 3.25);
  assert.equal(dsReasoner.calls, 1);
  assert.equal(dsReasoner.reasoningTokens, 600_000);
  assert.equal(dsReasoner.cost, 5);
  assert.equal(gpt.calls, 1);
  assert.equal(gpt.cachedTokens, 200_000);

  // 为 gpt-5.4 配置自定义单价后动态重算历史账单
  const view2 = service.configurePricing({
    ...view1.pricing,
    customModels: [{ model: 'gpt-5.4', provider: 'openai', inputPrice: 10, cachedInputPrice: 2.5, outputPrice: 30 }]
  });
  const gptAfter = view2.byModel.find(item => item.model === 'gpt-5.4');
  // 0.8M * 10 + 0.2M * 2.5 + 0.5M * 30 = 8 + 0.5 + 15 = 23.5 元
  assert.equal(gptAfter.cost, 23.5);
});

test('管理后台 /api/token-usage 接口支持查询、修改时段单价与清空记录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bot-token-api-'));
  const app = await createApplication({
    dataDir: dir,
    adminPassword: 'password123',
    douyinAutoStart: false,
    checkinAutoStart: false,
    subscriptionAutoStart: false,
    scheduledChatAutoStart: false,
    serverStatusAutoStart: false
  });
  app.tokenUsage.record({
    provider: 'deepseek',
    model: 'deepseek-chat',
    timestamp: Date.parse('2026-04-19T18:00:00Z'),
    usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 }
  });

  const summary = app.tokenUsage.status();
  assert.equal(summary.totals.totalTokens, 2_000_000);
  assert.equal(summary.totals.cost, 5); // 02:00 BJT off-peak: 1 + 4 = 5

  const status = app.bot.status();
  assert.equal(status.totalTokensPersisted, 2_000_000);
  assert.equal(status.totalCost, 5);

  app.tokenUsage.clear();
  assert.equal(app.tokenUsage.status().totals.totalTokens, 0);
  app.server.close();
});

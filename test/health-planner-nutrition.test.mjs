import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMealPlan,
  calcBmr,
  computeDailyTargets,
  fallbackEstimateMealText,
  formatPlanText,
  parseProfileArgs
} from '../src/health-planner/nutrition.mjs';

test('parseProfileArgs 支持带单位自由顺序与无单位位置录入，并校验边界', () => {
  const p1 = parseProfileArgs('男 26岁 175cm 72kg 减脂 中度');
  assert.deepEqual(
    { sex: p1.sex, age: p1.age, heightCm: p1.heightCm, weightKg: p1.weightKg, goal: p1.goal, activityLevel: p1.activityLevel },
    { sex: 'male', age: 26, heightCm: 175, weightKg: 72, goal: 'cut', activityLevel: 'moderate' }
  );

  const p2 = parseProfileArgs('162cm 54.5kg 女 25岁 体脂21.5% 增肌 高度 外食');
  assert.equal(p2.sex, 'female');
  assert.equal(p2.age, 25);
  assert.equal(p2.heightCm, 162);
  assert.equal(p2.weightKg, 54.5);
  assert.equal(p2.bodyFatPct, 21.5);
  assert.equal(p2.goal, 'bulk');
  assert.equal(p2.activityLevel, 'active');
  assert.equal(p2.dietStyle, 'takeout');

  const p3 = parseProfileArgs('男 28 180 75 维持 轻度');
  assert.equal(p3.age, 28);
  assert.equal(p3.heightCm, 180);
  assert.equal(p3.weightKg, 75);

  assert.throws(() => parseProfileArgs('26 175 72'), /性别/);
  assert.throws(() => parseProfileArgs('男 5岁 175cm 72kg'), /年龄/);
});

test('computeDailyTargets 准确计算 BMR，并优先接入 Apple 健康实测活动能量与步数', () => {
  const profile = parseProfileArgs('男 26岁 175cm 72kg 减脂 中度');
  const bmr = calcBmr(profile);
  // 10*72 + 6.25*175 - 5*26 + 5 = 720 + 1093.75 - 130 + 5 = 1688.75 -> 1689
  assert.equal(bmr, 1689);

  const staticTargets = computeDailyTargets(profile, null);
  assert.equal(staticTargets.tdeeSource, 'profile_activity');
  assert.equal(staticTargets.tdee, Math.round(1689 * 1.55));
  assert.equal(staticTargets.targetCalories, Math.round(staticTargets.tdee * 0.82));
  assert.equal(staticTargets.proteinG, Math.round(72 * 1.8));

  const activeTargets = computeDailyTargets(profile, { activeEnergyKcal: 480, steps: 9200, weightKg: 71.5 });
  assert.equal(activeTargets.tdeeSource, 'apple_active_energy');
  const newBmr = calcBmr(profile, 71.5);
  assert.equal(activeTargets.bmr, newBmr);
  assert.equal(activeTargets.tdee, Math.round(newBmr * 1.2 + 480));

  const stepsTargets = computeDailyTargets(profile, { steps: 10000 });
  assert.equal(stepsTargets.tdeeSource, 'apple_steps');
  assert.equal(stepsTargets.tdee, Math.round(bmr * (1.2 + 0.35)));
});

test('buildMealPlan 按早中晚拆出精确克重且忌口过滤与已吃餐次动态重算生效', () => {
  const profile = {
    ...parseProfileArgs('男 26岁 175cm 72kg 减脂 中度'),
    dislikes: ['海鲜', '牛奶', '蛋']
  };
  const targets = computeDailyTargets(profile);
  const fullPlan = buildMealPlan(profile, targets, { day: '2026-11-13' });

  for (const slot of ['breakfast', 'lunch', 'dinner']) {
    const meal = fullPlan.meals[slot];
    assert.ok(meal.items.length >= 2, `${slot} 应包含主食与蛋白等具体条目`);
    const sumKcal = meal.items.reduce((s, it) => s + it.calories, 0);
    assert.equal(meal.actual.calories, sumKcal, '餐食总热量应与各条目之和严格一致');
    for (const item of meal.items) {
      assert.equal(/虾|鱼|牛奶|蛋/.test(item.name), false, `忌口食材不应出现：${item.name}`);
    }
  }

  // Simulate heavy lunch logged -> dinner budget should shrink compared to clean day
  const heavyPlan = buildMealPlan(profile, targets, {
    day: '2026-11-13',
    logsToday: [{ mealType: 'lunch', summary: '大份红烧肉盖饭', calories: 1350, proteinG: 42, carbsG: 145, fatG: 62 }]
  });
  assert.equal(heavyPlan.meals.lunch.status, 'logged');
  assert.equal(heavyPlan.rebalanced, true);
  assert.ok(heavyPlan.meals.dinner.budget.calories < fullPlan.meals.dinner.budget.calories);
  assert.match(formatPlanText('测试', heavyPlan), /已记录/);
});

test('fallbackEstimateMealText 支持直接热量与中文菜名估算', () => {
  const exact = fallbackEstimateMealText('午餐 650大卡 42g蛋白 70g碳水 18g脂肪');
  assert.equal(exact.mealType, 'lunch');
  assert.equal(exact.calories, 650);
  assert.equal(exact.proteinG, 42);

  const fuzzy = fallbackEstimateMealText('一碗牛肉面加一个鸡蛋', 'lunch');
  assert.ok(fuzzy.calories >= 450);
  assert.ok(fuzzy.proteinG >= 20);
});

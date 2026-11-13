export const ACTIVITY_LEVELS = Object.freeze({
  sedentary: { id: 'sedentary', label: '久坐（办公室/几乎不运动）', factor: 1.2 },
  light: { id: 'light', label: '轻度（每周 1–3 次散步或轻运动）', factor: 1.375 },
  moderate: { id: 'moderate', label: '中度（每周 3–5 次中等强度运动）', factor: 1.55 },
  active: { id: 'active', label: '高度（每周 6–7 次训练或体力工作）', factor: 1.725 },
  very_active: { id: 'very_active', label: '极高（高强度双练或重体力劳动）', factor: 1.9 }
});

export const GOALS = Object.freeze({
  cut: { id: 'cut', label: '减脂', calorieFactor: 0.82, proteinPerKg: 1.8, fatShare: 0.26, note: '温和热量缺口（约 -18%），高蛋白保肌肉' },
  maintain: { id: 'maintain', label: '维持', calorieFactor: 1.0, proteinPerKg: 1.4, fatShare: 0.28, note: '维持体重与日常精力' },
  bulk: { id: 'bulk', label: '增肌', calorieFactor: 1.12, proteinPerKg: 1.8, fatShare: 0.25, note: '温和热量盈余（约 +12%），保证碳水与蛋白' }
});

export const DIET_STYLES = Object.freeze({
  balanced: { id: 'balanced', label: '日常均衡', desc: '主食、优质蛋白、蔬菜与少油均衡搭配' },
  takeout: { id: 'takeout', label: '外食食堂', desc: '米饭/面食/肉菜克重直观对照，方便点餐' },
  high_protein: { id: 'high_protein', label: '高蛋白强化', desc: '略提高蛋白占比（最多 2.2g/kg）' },
  light_fasting: { id: 'light_fasting', label: '轻食控碳', desc: '优先杂粮/薯类与优质瘦肉蔬菜' }
});

export const DEFAULT_MEAL_RATIOS = Object.freeze({
  breakfast: 0.30,
  lunch: 0.40,
  dinner: 0.30
});

export const MEAL_LABELS = Object.freeze({
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐'
});

export const FOOD_DB = Object.freeze([
  // Staples
  { id: 'oats', name: '生燕麦片', category: 'staple', kcal: 377, protein: 13.5, carbs: 67.0, fat: 7.0, step: 5, min: 25, max: 90, unitName: '勺(约15g)', unitG: 15, meals: ['breakfast'], tags: ['grain'] },
  { id: 'whole_wheat_bread', name: '全麦吐司', category: 'staple', kcal: 246, protein: 9.5, carbs: 44.0, fat: 3.5, step: 10, min: 35, max: 140, unitName: '片(约35g)', unitG: 35, meals: ['breakfast'], tags: ['gluten'] },
  { id: 'sweet_potato', name: '蒸红薯／紫薯', category: 'staple', kcal: 86, protein: 1.6, carbs: 20.1, fat: 0.2, step: 20, min: 80, max: 320, unitName: '个(约150g)', unitG: 150, meals: ['breakfast', 'dinner'], tags: ['tuber'] },
  { id: 'corn', name: '煮甜玉米(去棒芯净重)', category: 'staple', kcal: 112, protein: 4.0, carbs: 22.8, fat: 1.2, step: 20, min: 80, max: 280, unitName: '根(约150g)', unitG: 150, meals: ['breakfast', 'dinner'], tags: ['grain'] },
  { id: 'multigrain_rice', name: '熟杂粮饭(米+糙米/藜麦)', category: 'staple', kcal: 118, protein: 3.4, carbs: 24.5, fat: 0.8, step: 10, min: 80, max: 360, unitName: '标准小碗(约150g)', unitG: 150, meals: ['lunch', 'dinner'], tags: ['rice'] },
  { id: 'cooked_rice', name: '熟白米饭', category: 'staple', kcal: 116, protein: 2.6, carbs: 25.9, fat: 0.3, step: 10, min: 80, max: 360, unitName: '标准小碗(约150g)', unitG: 150, meals: ['lunch', 'dinner'], tags: ['rice'] },
  { id: 'soba_noodles', name: '熟荞麦面', category: 'staple', kcal: 109, protein: 4.2, carbs: 22.0, fat: 0.5, step: 10, min: 100, max: 360, unitName: '小碗(约180g)', unitG: 180, meals: ['lunch', 'dinner'], tags: ['gluten'] },

  // Proteins
  { id: 'egg', name: '水煮蛋／蒸蛋', category: 'protein', kcal: 144, protein: 12.8, carbs: 0.7, fat: 9.8, step: 50, min: 50, max: 200, unitName: '个(约50g)', unitG: 50, meals: ['breakfast'], tags: ['egg', '鸡蛋'] },
  { id: 'chicken_breast', name: '鸡胸肉／去皮鸡腿肉(熟重约75%)', category: 'protein', kcal: 133, protein: 24.6, carbs: 0.5, fat: 3.2, step: 10, min: 60, max: 280, unitName: '掌心块(约100g)', unitG: 100, meals: ['lunch', 'dinner'], tags: ['meat', 'poultry', '鸡肉'] },
  { id: 'lean_beef', name: '瘦牛肉／卤牛腱(熟重)', category: 'protein', kcal: 150, protein: 25.0, carbs: 0.4, fat: 4.5, step: 10, min: 60, max: 260, unitName: '掌心份(约100g)', unitG: 100, meals: ['lunch', 'dinner'], tags: ['meat', 'beef', '牛肉'] },
  { id: 'shrimp', name: '白灼／清炒鲜虾仁', category: 'protein', kcal: 93, protein: 20.6, carbs: 0.2, fat: 0.8, step: 10, min: 80, max: 300, unitName: '份(100g约12只)', unitG: 100, meals: ['lunch', 'dinner'], tags: ['seafood', 'shrimp', '海鲜', '虾'] },
  { id: 'fish_fillet', name: '清蒸巴沙鱼／鲈鱼肉', category: 'protein', kcal: 98, protein: 18.5, carbs: 0.3, fat: 2.2, step: 10, min: 80, max: 300, unitName: '片鱼柳(约120g)', unitG: 120, meals: ['lunch', 'dinner'], tags: ['seafood', 'fish', '海鲜', '鱼'] },
  { id: 'firm_tofu', name: '北豆腐／老豆腐', category: 'protein', kcal: 98, protein: 12.2, carbs: 1.5, fat: 4.8, step: 20, min: 100, max: 360, unitName: '块(半盒约150g)', unitG: 150, meals: ['breakfast', 'lunch', 'dinner'], tags: ['soy', 'vegetarian', '豆制品', '豆腐'] },

  // Dairy / Breakfast drink
  { id: 'soy_milk', name: '无糖纯豆浆', category: 'dairy', kcal: 31, protein: 3.0, carbs: 1.2, fat: 1.6, step: 50, min: 200, max: 400, unitName: '杯(250ml)', unitG: 250, meals: ['breakfast'], tags: ['soy', 'vegetarian', '豆浆'] },
  { id: 'skim_milk', name: '低脂／脱脂纯牛奶', category: 'dairy', kcal: 42, protein: 3.4, carbs: 4.9, fat: 1.0, step: 50, min: 200, max: 350, unitName: '盒(250ml)', unitG: 250, meals: ['breakfast'], tags: ['dairy', '牛奶', '乳制品'] },

  // Vegetables
  { id: 'green_veg', name: '西兰花／油菜／生菜等时蔬', category: 'veg', kcal: 26, protein: 2.4, carbs: 4.3, fat: 0.3, step: 50, min: 150, max: 350, unitName: '捧(约100g)', unitG: 100, meals: ['lunch', 'dinner'], tags: ['veg'] },
  { id: 'tomato_cuke', name: '圣女果／黄瓜', category: 'veg', kcal: 18, protein: 1.0, carbs: 3.5, fat: 0.2, step: 50, min: 100, max: 250, unitName: '把(约100g)', unitG: 100, meals: ['breakfast', 'lunch', 'dinner'], tags: ['veg'] },

  // Healthy fats
  { id: 'cooking_oil', name: '烹调植物油(橄榄油/菜籽油)', category: 'fat', kcal: 899, protein: 0.0, carbs: 0.0, fat: 99.9, step: 1, min: 0, max: 18, unitName: '半汤匙(约5g)', unitG: 5, meals: ['lunch', 'dinner'], tags: ['oil'] },
  { id: 'nuts', name: '原味坚果(巴旦木/核桃)', category: 'fat', kcal: 607, protein: 20.0, carbs: 18.0, fat: 52.0, step: 5, min: 0, max: 30, unitName: '小把(10g)', unitG: 10, meals: ['breakfast'], tags: ['nuts', '坚果'] }
]);

const FOOD_BY_ID = new Map(FOOD_DB.map(item => [item.id, item]));

/** Returns current Beijing date/time parts cleanly shifted from UTC epoch ms. */
export function beijingDateParts(nowMs = Date.now()) {
  const shifted = new Date(nowMs + 8 * 3600000);
  const iso = shifted.toISOString();
  return {
    day: iso.slice(0, 10),
    time: iso.slice(11, 16),
    hour: Number(iso.slice(11, 13)),
    minute: Number(iso.slice(14, 16))
  };
}

export function dayOfYearBeijing(dayStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayStr || ''));
  if (!match) return 0;
  const current = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const start = Date.UTC(Number(match[1]), 0, 1);
  return Math.max(0, Math.floor((current - start) / 86400000));
}

export function roundTo(value, step = 1) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value / step) * step;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeDislikes(input) {
  if (!input) return [];
  const rawList = Array.isArray(input) ? input : String(input).split(/[、,，\s/]+/);
  return [...new Set(rawList.map(item => String(item || '').trim().slice(0, 20)).filter(Boolean))].slice(0, 16);
}

export function normalizeMealRatios(input) {
  if (!input || typeof input !== 'object') return { ...DEFAULT_MEAL_RATIOS };
  const b = Number(input.breakfast), l = Number(input.lunch), d = Number(input.dinner);
  if (![b, l, d].every(n => Number.isFinite(n) && n > 0)) return { ...DEFAULT_MEAL_RATIOS };
  const sum = b + l + d;
  const nb = Math.round((b / sum) * 100) / 100;
  const nl = Math.round((l / sum) * 100) / 100;
  const nd = Math.round((1 - nb - nl) * 100) / 100;
  if ([nb, nl, nd].some(v => v < 0.10 || v > 0.65)) throw new Error('早中晚热量比例每餐需在 10%–65% 之间');
  return { breakfast: nb, lunch: nl, dinner: nd };
}

export function parseActivityToken(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (['sedentary', '久坐', '不运动', '极轻'].includes(s)) return 'sedentary';
  if (['light', '轻', '轻度', '低'].includes(s)) return 'light';
  if (['moderate', '中', '中度', '中等', '适中'].includes(s)) return 'moderate';
  if (['active', '高', '高度', '较高', '经常运动'].includes(s)) return 'active';
  if (['very_active', '极高', '超高', '每天训练'].includes(s)) return 'very_active';
  return '';
}

export function parseGoalToken(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (['cut', '减脂', '减肥', '瘦身', '减重'].includes(s)) return 'cut';
  if (['maintain', '维持', '保持', '均衡'].includes(s)) return 'maintain';
  if (['bulk', '增肌', '增重', '增肥'].includes(s)) return 'bulk';
  return '';
}

export function parseDietStyleToken(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (['balanced', '均衡', '日常', '日常均衡', '正常'].includes(s)) return 'balanced';
  if (['takeout', '外食', '食堂', '外食食堂', '外卖'].includes(s)) return 'takeout';
  if (['high_protein', '高蛋白', '蛋白', '增肌餐'].includes(s)) return 'high_protein';
  if (['light_fasting', '轻食', '控碳', '16+8'].includes(s)) return 'light_fasting';
  return '';
}

export function parseMealType(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (['breakfast', '早', '早餐', '早饭', 'morning'].includes(s)) return 'breakfast';
  if (['lunch', '中', '中午', '午餐', '午饭', 'noon'].includes(s)) return 'lunch';
  if (['dinner', '晚', '晚上', '晚餐', '晚饭', 'evening', 'night'].includes(s)) return 'dinner';
  return '';
}

/**
 * Parse natural QQ input for health profile onboarding.
 * Supports free token order when units are provided (`男 26岁 175cm 72kg 减脂 中度`)
 * as well as positional order (`男 26 175 72 减脂 中度`).
 */
export function parseProfileArgs(text, existing = null) {
  const tokens = String(text || '').trim().split(/[\s,，;；]+/).filter(Boolean);
  if (!tokens.length) throw new Error('请填写基础健康信息，例如：/健康 录入 男 26 175 72 减脂 中度');

  const draft = {
    sex: existing?.sex || '',
    age: existing?.age ?? null,
    heightCm: existing?.heightCm ?? null,
    weightKg: existing?.weightKg ?? null,
    bodyFatPct: existing?.bodyFatPct ?? null,
    goal: existing?.goal || 'maintain',
    activityLevel: existing?.activityLevel || 'light',
    dietStyle: existing?.dietStyle || 'balanced',
    dislikes: existing?.dislikes ? [...existing.dislikes] : [],
    mealRatios: existing?.mealRatios ? { ...existing.mealRatios } : { ...DEFAULT_MEAL_RATIOS }
  };

  const bareNumbers = [];
  for (const raw of tokens) {
    const clean = raw.replace(/^(?:性别|年龄|身高|体重|体脂|体脂率|目标|活动|强度)[:：=]/, '');
    if (/^(男|male|m)$/i.test(clean)) { draft.sex = 'male'; continue; }
    if (/^(女|female|f)$/i.test(clean)) { draft.sex = 'female'; continue; }
    const goal = parseGoalToken(clean);
    if (goal) { draft.goal = goal; continue; }
    const activity = parseActivityToken(clean);
    if (activity) { draft.activityLevel = activity; continue; }
    const style = parseDietStyleToken(clean);
    if (style) { draft.dietStyle = style; continue; }

    let m;
    if ((m = /^(\d{2,3}(?:\.\d+)?)\s*(?:岁)$/i.exec(clean))) { draft.age = Math.round(Number(m[1])); continue; }
    if ((m = /^(\d{3}(?:\.\d+)?)\s*(?:cm|厘米|公分)$/i.exec(clean))) { draft.heightCm = Number(m[1]); continue; }
    if ((m = /^(\d+(?:\.\d+)?)\s*(?:m|米)$/i.exec(clean)) && Number(m[1]) >= 1 && Number(m[1]) <= 2.3) { draft.heightCm = Math.round(Number(m[1]) * 100); continue; }
    if ((m = /^(\d{2,3}(?:\.\d+)?)\s*(?:kg|公斤)$/i.exec(clean))) { draft.weightKg = Number(m[1]); continue; }
    if ((m = /^(\d{2,3}(?:\.\d+)?)\s*(?:斤)$/i.exec(clean))) { draft.weightKg = Math.round(Number(m[1]) * 5) / 10; continue; }
    if ((m = /^(?:体脂率?)?(\d{1,2}(?:\.\d+)?)\s*%$/i.exec(clean))) { draft.bodyFatPct = Number(m[1]); continue; }
    if (/^\d+(?:\.\d+)?$/.test(clean)) bareNumbers.push(Number(clean));
  }

  // Assign bare numbers heuristically when user omits units (order: age, heightCm, weightKg, bodyFatPct).
  if (bareNumbers.length && !existing) {
    if (bareNumbers.length >= 3) {
      draft.age = Math.round(bareNumbers[0]);
      draft.heightCm = bareNumbers[1];
      draft.weightKg = bareNumbers[2];
      if (bareNumbers[3] !== undefined) draft.bodyFatPct = bareNumbers[3];
    } else {
      for (const n of bareNumbers) {
        if (n >= 130 && n <= 230 && !draft.heightCm) draft.heightCm = n;
        else if (n >= 12 && n <= 90 && !draft.age) draft.age = Math.round(n);
        else if (n >= 30 && n <= 220 && !draft.weightKg) draft.weightKg = n;
      }
    }
  } else if (bareNumbers.length && existing) {
    // Allow updating single bare number via unitless guess only if unambiguous
    if (bareNumbers.length >= 3) {
      draft.age = Math.round(bareNumbers[0]);
      draft.heightCm = bareNumbers[1];
      draft.weightKg = bareNumbers[2];
      if (bareNumbers[3] !== undefined) draft.bodyFatPct = bareNumbers[3];
    }
  }

  return normalizeProfile(draft);
}

export function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('档案格式错误');
  if (!['male', 'female'].includes(raw.sex)) throw new Error('请指定性别（男 或 女）');
  const age = Math.round(Number(raw.age));
  const heightCm = Math.round(Number(raw.heightCm) * 10) / 10;
  const weightKg = Math.round(Number(raw.weightKg) * 10) / 10;
  if (!Number.isFinite(age) || age < 12 || age > 100) throw new Error('年龄需在 12–100 岁之间');
  if (!Number.isFinite(heightCm) || heightCm < 100 || heightCm > 230) throw new Error('身高需在 100–230 cm 之间');
  if (!Number.isFinite(weightKg) || weightKg < 30 || weightKg > 250) throw new Error('体重需在 30–250 kg 之间');

  let bodyFatPct = null;
  if (raw.bodyFatPct !== null && raw.bodyFatPct !== undefined && raw.bodyFatPct !== '') {
    const bf = Math.round(Number(raw.bodyFatPct) * 10) / 10;
    if (!Number.isFinite(bf) || bf < 3 || bf > 60) throw new Error('体脂率需在 3%–60% 之间');
    bodyFatPct = bf;
  }

  const goal = GOALS[raw.goal] ? raw.goal : 'maintain';
  const activityLevel = ACTIVITY_LEVELS[raw.activityLevel] ? raw.activityLevel : 'light';
  const dietStyle = DIET_STYLES[raw.dietStyle] ? raw.dietStyle : 'balanced';
  return {
    sex: raw.sex,
    age,
    heightCm,
    weightKg,
    bodyFatPct,
    goal,
    activityLevel,
    dietStyle,
    dislikes: normalizeDislikes(raw.dislikes),
    mealRatios: normalizeMealRatios(raw.mealRatios)
  };
}

/** Calculate BMR using Katch-McArdle (if body fat present) or Mifflin-St Jeor. */
export function calcBmr(profile, effectiveWeightKg = profile.weightKg) {
  const weight = Number(effectiveWeightKg) || profile.weightKg;
  if (Number.isFinite(profile.bodyFatPct) && profile.bodyFatPct > 0) {
    const leanMass = weight * (1 - profile.bodyFatPct / 100);
    return Math.round(370 + 21.6 * leanMass);
  }
  const base = 10 * weight + 6.25 * profile.heightCm - 5 * profile.age;
  return Math.round(profile.sex === 'male' ? base + 5 : base - 161);
}

/**
 * Compute daily energy and macro targets, incorporating Apple Health dynamic activity when synced.
 */
export function computeDailyTargets(profile, appleDay = null) {
  const weightKg = Number(appleDay?.weightKg) > 29 ? Number(appleDay.weightKg) : profile.weightKg;
  const bmr = calcBmr(profile, weightKg);
  const activityInfo = ACTIVITY_LEVELS[profile.activityLevel] || ACTIVITY_LEVELS.light;

  let tdee;
  let tdeeSource = 'profile_activity';
  let tdeeNote = `按录入活动强度（${activityInfo.label.split('（')[0]}）`;

  if (Number(appleDay?.activeEnergyKcal) > 0) {
    tdee = Math.round(bmr * 1.2 + Number(appleDay.activeEnergyKcal));
    tdeeSource = 'apple_active_energy';
    tdeeNote = `已接入 Apple 健康动态消耗（活动能量 ${Math.round(appleDay.activeEnergyKcal)} kcal）`;
  } else if (Number(appleDay?.steps) > 0) {
    const stepBonus = Math.min(0.65, (Number(appleDay.steps) / 10000) * 0.35);
    tdee = Math.round(bmr * (1.2 + stepBonus));
    tdeeSource = 'apple_steps';
    tdeeNote = `已接入 Apple 健康今日步数（${Math.round(appleDay.steps)} 步）`;
  } else {
    tdee = Math.round(bmr * activityInfo.factor);
  }

  const goalInfo = GOALS[profile.goal] || GOALS.maintain;
  const floorKcal = Math.min(tdee, profile.sex === 'female' ? 1200 : 1500);
  const rawGoalKcal = Math.round(tdee * goalInfo.calorieFactor);
  const targetCalories = profile.goal === 'cut' ? Math.max(floorKcal, rawGoalKcal) : rawGoalKcal;

  let proteinPerKg = goalInfo.proteinPerKg;
  if (profile.dietStyle === 'high_protein') proteinPerKg = Math.min(2.2, proteinPerKg + 0.2);
  let proteinG = Math.round(weightKg * proteinPerKg);
  const maxProteinG = Math.floor((targetCalories * 0.42) / 4);
  proteinG = Math.min(proteinG, maxProteinG);

  const minFatG = Math.max(32, Math.round(weightKg * 0.65));
  const targetFatG = Math.round((targetCalories * goalInfo.fatShare) / 9);
  const fatG = Math.max(minFatG, Math.min(targetFatG, Math.floor((targetCalories * 0.36) / 9)));

  const remainingForCarbs = Math.max(240, targetCalories - proteinG * 4 - fatG * 9);
  const carbsG = Math.round(remainingForCarbs / 4);

  return {
    weightKg: Math.round(weightKg * 10) / 10,
    bmr,
    tdee,
    tdeeSource,
    tdeeNote,
    goalLabel: goalInfo.label,
    goalNote: goalInfo.note,
    targetCalories,
    proteinG,
    carbsG,
    fatG,
    fiberG: Math.max(20, Math.round((targetCalories / 1000) * 14))
  };
}

function isDisliked(food, dislikes) {
  if (!dislikes.length) return false;
  const haystack = `${food.name} ${(food.tags || []).join(' ')}`.toLowerCase();
  return dislikes.some(term => {
    const clean = term.toLowerCase();
    if (clean === '海鲜') return (food.tags || []).includes('seafood');
    if (clean === '乳糖' || clean === '牛奶' || clean === '奶') return (food.tags || []).includes('dairy');
    if (clean === '蛋') return (food.tags || []).includes('egg');
    if (clean === '豆' || clean === '豆制品') return (food.tags || []).includes('soy');
    if (clean === '肉' || clean === '荤') return (food.tags || []).includes('meat');
    return haystack.includes(clean);
  });
}

function pickCandidate(category, mealType, dislikes, rotationIdx, preferredIds = []) {
  const available = FOOD_DB.filter(f => f.category === category && f.meals.includes(mealType) && !isDisliked(f, dislikes));
  if (preferredIds.length) {
    const preferred = available.filter(f => preferredIds.includes(f.id));
    if (preferred.length) return preferred[rotationIdx % preferred.length];
  }
  if (available.length) return available[rotationIdx % available.length];
  // Fallback ignoring meal restriction but keeping dislike filter
  const anyMeal = FOOD_DB.filter(f => f.category === category && !isDisliked(f, dislikes));
  return anyMeal.length ? anyMeal[rotationIdx % anyMeal.length] : null;
}

function formatPortionText(food, grams) {
  if (grams <= 0) return '';
  if (food.id === 'egg') {
    const count = Math.max(1, Math.round(grams / 50));
    return `${grams}g（约 ${count} 个）`;
  }
  if (food.id === 'whole_wheat_bread') {
    const slices = Math.max(1, Math.round(grams / 35));
    return `${grams}g（约 ${slices} 片）`;
  }
  if (food.unitG && grams >= food.unitG * 0.4) {
    const units = Math.round((grams / food.unitG) * 2) / 2;
    const unitDesc = food.unitName.replace(/\(.*?\)/, '');
    return `${grams}g（约 ${units} ${unitDesc}）`;
  }
  return `${grams}g`;
}

function calcItemMacros(food, grams) {
  const ratio = grams / 100;
  return {
    id: food.id,
    name: food.name,
    category: food.category,
    grams,
    portionText: formatPortionText(food, grams),
    calories: Math.round(food.kcal * ratio),
    proteinG: Math.round(food.protein * ratio * 10) / 10,
    carbsG: Math.round(food.carbs * ratio * 10) / 10,
    fatG: Math.round(food.fat * ratio * 10) / 10
  };
}

function composeSingleMeal(mealType, budget, profile, rotationSeed) {
  const dislikes = profile.dislikes || [];
  const rot = rotationSeed + (mealType === 'breakfast' ? 0 : mealType === 'lunch' ? 1 : 2);
  const preferredStaples = profile.dietStyle === 'takeout' && mealType !== 'breakfast'
    ? ['cooked_rice', 'soba_noodles']
    : profile.dietStyle === 'light_fasting' && mealType !== 'breakfast'
      ? ['multigrain_rice', 'sweet_potato', 'corn']
      : [];

  const items = [];
  const dairy = mealType === 'breakfast' ? pickCandidate('dairy', mealType, dislikes, rot) : null;
  const veg = mealType === 'breakfast'
    ? pickCandidate('veg', mealType, dislikes, rot, ['tomato_cuke'])
    : pickCandidate('veg', mealType, dislikes, rot, ['green_veg']);
  const proteinFood = pickCandidate('protein', mealType, dislikes, rot)
    || pickCandidate('protein', 'lunch', dislikes, rot);
  const stapleFood = pickCandidate('staple', mealType, dislikes, rot, preferredStaples);
  const fatFood = mealType === 'breakfast'
    ? pickCandidate('fat', mealType, dislikes, rot, ['nuts'])
    : profile.dietStyle === 'takeout'
      ? null
      : pickCandidate('fat', mealType, dislikes, rot, ['cooking_oil']);

  // Fixed baseline sides (veg + breakfast drink)
  let fixedP = 0, fixedC = 0, fixedF = 0;
  if (dairy) {
    const g = 250;
    const entry = calcItemMacros(dairy, g);
    items.push(entry);
    fixedP += entry.proteinG; fixedC += entry.carbsG; fixedF += entry.fatG;
  }
  if (veg) {
    const g = mealType === 'breakfast' ? 100 : mealType === 'lunch' ? 200 : 250;
    const entry = calcItemMacros(veg, g);
    items.push(entry);
    fixedP += entry.proteinG; fixedC += entry.carbsG; fixedF += entry.fatG;
  }

  // Primary protein (with vegetarian fallback to tofu/beans if no egg/meat available)
  let primaryProteinEntry = null;
  if (proteinFood) {
    const needP = Math.max(6, budget.proteinG - fixedP - 4); // ~4g trace protein from staple
    const rawG = (needP / Math.max(1, proteinFood.protein)) * 100;
    const grams = clamp(roundTo(rawG, proteinFood.step), proteinFood.min, proteinFood.max);
    primaryProteinEntry = calcItemMacros(proteinFood, grams);
    fixedP += primaryProteinEntry.proteinG; fixedC += primaryProteinEntry.carbsG; fixedF += primaryProteinEntry.fatG;
  }

  // Staple solved from remaining carb / calorie budget
  let stapleEntry = null;
  if (stapleFood) {
    const needC = Math.max(12, budget.carbsG - fixedC);
    const rawG = (needC / Math.max(1, stapleFood.carbs)) * 100;
    const grams = clamp(roundTo(rawG, stapleFood.step), stapleFood.min, stapleFood.max);
    stapleEntry = calcItemMacros(stapleFood, grams);
    fixedP += stapleEntry.proteinG; fixedC += stapleEntry.carbsG; fixedF += stapleEntry.fatG;
  }

  // Healthy fat filler (nuts at breakfast, cooking oil at lunch/dinner)
  let fatEntry = null;
  if (fatFood) {
    const currentKcal = Math.round(fixedP * 4 + fixedC * 4 + fixedF * 9);
    const needFatFromTarget = Math.max(0, budget.fatG - fixedF);
    const needFatFromKcal = Math.max(0, (budget.calories - currentKcal) / 9);
    const targetFat = Math.min(needFatFromTarget + 2, Math.max(needFatFromTarget * 0.85, needFatFromKcal));
    const rawG = (targetFat / Math.max(1, fatFood.fat)) * 100;
    const grams = clamp(roundTo(rawG, fatFood.step), fatFood.min, fatFood.max);
    if (grams > 0) fatEntry = calcItemMacros(fatFood, grams);
  }

  // Order nicely: Staple -> Primary Protein -> Dairy/Veg -> Healthy Fat
  const ordered = [stapleEntry, primaryProteinEntry, ...items, fatEntry].filter(Boolean);
  const actual = ordered.reduce((acc, item) => ({
    calories: acc.calories + item.calories,
    proteinG: Math.round((acc.proteinG + item.proteinG) * 10) / 10,
    carbsG: Math.round((acc.carbsG + item.carbsG) * 10) / 10,
    fatG: Math.round((acc.fatG + item.fatG) * 10) / 10
  }), { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 });

  const tip = mealType === 'lunch' && profile.dietStyle === 'takeout'
    ? '外食点餐可按对应瘦肉/鱼虾克重选择少油做法（清蒸/白灼/卤煮），过水去浮油。'
    : mealType === 'dinner'
      ? '晚餐建议清淡少油，优先保证绿叶蔬菜和易消化蛋白。'
      : '';

  return {
    mealType,
    label: MEAL_LABELS[mealType],
    ratio: budget.ratio,
    budget,
    actual,
    items: ordered,
    tip
  };
}

/**
 * Build breakfast/lunch/dinner meal plan, dynamically adjusting unlogged meals based on meals already eaten today.
 */
export function buildMealPlan(profile, dailyTargets, { day = '', logsToday = [], rotationOffset = 0 } = {}) {
  const ratios = normalizeMealRatios(profile.mealRatios);
  const seed = dayOfYearBeijing(day || beijingDateParts().day) + rotationOffset;
  const order = ['breakfast', 'lunch', 'dinner'];

  const loggedByMeal = { breakfast: [], lunch: [], dinner: [] };
  for (const log of logsToday) {
    const mt = parseMealType(log.mealType);
    if (mt) loggedByMeal[mt].push(log);
  }

  const eatenTotals = logsToday.reduce((acc, log) => ({
    calories: acc.calories + Number(log.calories || 0),
    proteinG: Math.round((acc.proteinG + Number(log.proteinG || 0)) * 10) / 10,
    carbsG: Math.round((acc.carbsG + Number(log.carbsG || 0)) * 10) / 10,
    fatG: Math.round((acc.fatG + Number(log.fatG || 0)) * 10) / 10
  }), { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 });

  const unlogged = order.filter(m => loggedByMeal[m].length === 0);
  const remainingRatioSum = unlogged.reduce((sum, m) => sum + ratios[m], 0);

  const remainingBudget = {
    calories: Math.max(0, dailyTargets.targetCalories - eatenTotals.calories),
    proteinG: Math.max(0, dailyTargets.proteinG - eatenTotals.proteinG),
    carbsG: Math.max(0, dailyTargets.carbsG - eatenTotals.carbsG),
    fatG: Math.max(0, dailyTargets.fatG - eatenTotals.fatG)
  };

  const rebalanced = logsToday.length > 0 && unlogged.length > 0;
  const meals = {};
  for (const mealType of order) {
    const ratio = ratios[mealType];
    const staticBudget = {
      ratio,
      calories: Math.round(dailyTargets.targetCalories * ratio),
      proteinG: Math.round(dailyTargets.proteinG * ratio),
      carbsG: Math.round(dailyTargets.carbsG * ratio),
      fatG: Math.round(dailyTargets.fatG * ratio)
    };
    const loggedList = loggedByMeal[mealType];
    if (loggedList.length > 0) {
      const mealEaten = loggedList.reduce((acc, l) => ({
        calories: acc.calories + Number(l.calories || 0),
        proteinG: Math.round((acc.proteinG + Number(l.proteinG || 0)) * 10) / 10,
        carbsG: Math.round((acc.carbsG + Number(l.carbsG || 0)) * 10) / 10,
        fatG: Math.round((acc.fatG + Number(l.fatG || 0)) * 10) / 10
      }), { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 });
      meals[mealType] = {
        ...composeSingleMeal(mealType, staticBudget, profile, seed),
        status: 'logged',
        logged: mealEaten,
        loggedItems: loggedList.map(l => l.summary).filter(Boolean)
      };
      continue;
    }

    const share = remainingRatioSum > 0 ? ratio / remainingRatioSum : 1 / Math.max(1, unlogged.length);
    const dynamicBudget = rebalanced ? {
      ratio,
      calories: Math.max(220, Math.round(remainingBudget.calories * share)),
      proteinG: Math.max(12, Math.round(remainingBudget.proteinG * share)),
      carbsG: Math.max(15, Math.round(remainingBudget.carbsG * share)),
      fatG: Math.max(6, Math.round(remainingBudget.fatG * share))
    } : staticBudget;

    meals[mealType] = {
      ...composeSingleMeal(mealType, dynamicBudget, profile, seed),
      status: 'planned',
      adjustedFromLogs: rebalanced && remainingBudget.calories < dailyTargets.targetCalories
    };
  }

  return {
    day: day || beijingDateParts().day,
    targets: dailyTargets,
    eatenTotals,
    remainingBudget,
    rebalanced,
    meals
  };
}

/** Deterministic fallback nutrition estimator when AI model is unconfigured for plain text meal logs. */
export function fallbackEstimateMealText(description, defaultMealType = 'lunch') {
  const text = String(description || '').trim();
  const mealType = parseMealType(text.split(/\s+/)[0]) || defaultMealType;
  let calories = 0, proteinG = 0, carbsG = 0, fatG = 0;

  // Allow direct numeric entry like `/记一餐 午餐 580大卡 35g蛋白` or `600kcal 40蛋白`
  const kcalMatch = /(\d{2,4}(?:\.\d+)?)\s*(?:千卡|大卡|kcal|卡路里)/i.exec(text);
  const protMatch = /(\d{1,3}(?:\.\d+)?)\s*(?:g|克)?\s*(?:蛋白|蛋白质|p)/i.exec(text) || /(?:蛋白|蛋白质)\s*(\d{1,3}(?:\.\d+)?)\s*(?:g|克)?/i.exec(text);
  const carbMatch = /(\d{1,3}(?:\.\d+)?)\s*(?:g|克)?\s*(?:碳水)/i.exec(text);
  const fatMatch = /(\d{1,3}(?:\.\d+)?)\s*(?:g|克)?\s*(?:脂肪|油)/i.exec(text);
  if (kcalMatch) {
    calories = Math.round(Number(kcalMatch[1]));
    proteinG = protMatch ? Math.round(Number(protMatch[1]) * 10) / 10 : Math.round((calories * 0.2) / 4);
    carbsG = carbMatch ? Math.round(Number(carbMatch[1]) * 10) / 10 : Math.round((calories * 0.5) / 4);
    fatG = fatMatch ? Math.round(Number(fatMatch[1]) * 10) / 10 : Math.round((calories * 0.3) / 9);
    return { mealType, summary: text, calories, proteinG, carbsG, fatG, items: [{ name: text.slice(0, 60), grams: 0, calories, proteinG }] };
  }

  const rules = [
    { re: /(鸡胸|鸡肉|鸡腿)/, kcal: 190, p: 32, c: 2, f: 5, name: '鸡肉一份' },
    { re: /(牛肉|牛腱|牛排)/, kcal: 220, p: 28, c: 2, f: 10, name: '牛肉一份' },
    { re: /(虾|鱼|三文鱼|海鲜)/, kcal: 160, p: 26, c: 2, f: 4, name: '鱼虾一份' },
    { re: /(鸡蛋|水煮蛋|荷包蛋)/, kcal: 75, p: 6.5, c: 0.5, f: 5, name: '鸡蛋(按个)' },
    { re: /(米饭|杂粮饭|盖浇饭)/, kcal: 210, p: 4.5, c: 46, f: 0.6, name: '米饭1碗' },
    { re: /(面|牛肉面|拌面|粉)/, kcal: 420, p: 16, c: 68, f: 9, name: '面食1碗' },
    { re: /(牛奶|拿铁|酸奶)/, kcal: 135, p: 8.5, c: 12, f: 5.5, name: '奶饮1杯' },
    { re: /(豆浆|豆腐)/, kcal: 110, p: 10, c: 4, f: 5, name: '豆制品1份' },
    { re: /(燕麦|全麦|面包|吐司)/, kcal: 180, p: 6.5, c: 32, f: 3, name: '谷物主食1份' },
    { re: /(青菜|西兰花|沙拉|蔬菜)/, kcal: 70, p: 3.5, c: 8, f: 2.5, name: '蔬菜1份' }
  ];
  const matched = [];
  for (const r of rules) {
    if (r.re.test(text)) {
      calories += r.kcal; proteinG += r.p; carbsG += r.c; fatG += r.f;
      matched.push({ name: r.name, grams: 0, calories: r.kcal, proteinG: r.p });
    }
  }
  if (!matched.length) {
    calories = mealType === 'breakfast' ? 380 : mealType === 'lunch' ? 620 : 520;
    proteinG = Math.round((calories * 0.22) / 4);
    carbsG = Math.round((calories * 0.48) / 4);
    fatG = Math.round((calories * 0.30) / 9);
    matched.push({ name: text.slice(0, 60) || MEAL_LABELS[mealType], grams: 0, calories, proteinG });
  }
  return {
    mealType,
    summary: text.slice(0, 120) || MEAL_LABELS[mealType],
    calories: Math.round(calories),
    proteinG: Math.round(proteinG * 10) / 10,
    carbsG: Math.round(carbsG * 10) / 10,
    fatG: Math.round(fatG * 10) / 10,
    items: matched
  };
}

export function inferCurrentMealSlot(hour) {
  if (hour < 10) return 'breakfast';
  if (hour < 15) return 'lunch';
  return 'dinner';
}

export function mealSourceLabel(source) {
  if (source === 'vision') return '图片识别估算';
  if (source === 'ai_text') return 'DeepSeek/AI 模型估算';
  return '文字录入/本地估算';
}

export function formatPlanText(userName, plan, singleMealType = '') {
  const t = plan.targets;
  const header = [
    `🥗 ${userName || '你'}的今日饮食方案（${plan.day}）`,
    `体征目标：体重 ${t.weightKg}kg · ${t.goalLabel} | BMR ${t.bmr} kcal → TDEE ${t.tdee} kcal`,
    `计算依据：${t.tdeeNote}`,
    `全天目标：${t.targetCalories} kcal ｜ 蛋白质 ${t.proteinG}g ｜ 碳水 ${t.carbsG}g ｜ 脂肪 ${t.fatG}g`
  ];
  if (plan.eatenTotals.calories > 0) {
    header.push(`今日已记：${plan.eatenTotals.calories} kcal（蛋白 ${plan.eatenTotals.proteinG}g）｜ 剩余额度：${plan.remainingBudget.calories} kcal（蛋白 ${plan.remainingBudget.proteinG}g）`);
  }

  const slots = singleMealType && plan.meals[singleMealType] ? [singleMealType] : ['breakfast', 'lunch', 'dinner'];
  const blocks = slots.map(key => {
    const m = plan.meals[key];
    const ratioPct = Math.round(m.ratio * 100);
    if (m.status === 'logged') {
      return [
        `✅ 【${m.label}（占比 ${ratioPct}% · 已记录）】`,
        `实记：${m.logged.calories} kcal（蛋白 ${m.logged.proteinG}g · 碳水 ${m.logged.carbsG}g · 脂肪 ${m.logged.fatG}g）`,
        ...(m.loggedItems?.length ? [`内容：${m.loggedItems.join('；')}`] : [])
      ].join('\n');
    }
    const foodLines = m.items.map(it => `  · ${it.name}：${it.portionText}（${it.calories} kcal / 蛋白 ${it.proteinG}g）`);
    return [
      `🍽️ 【${m.label}（占比 ${ratioPct}%${m.adjustedFromLogs ? ' · 已按今日已吃动态重算' : ''}）】`,
      `配额 ${m.budget.calories} kcal → 本组合约 ${m.actual.calories} kcal（蛋白 ${m.actual.proteinG}g · 碳水 ${m.actual.carbsG}g · 脂肪 ${m.actual.fatG}g）`,
      ...foodLines,
      ...(m.tip ? [`💡 ${m.tip}`] : [])
    ].join('\n');
  });

  return `${header.join('\n')}\n\n${blocks.join('\n\n')}`;
}

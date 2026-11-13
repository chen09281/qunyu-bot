import { escapeHtml } from '../card-renderer.mjs';

const CARD_CSP = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:">`;
const BASE_FONT = `-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", "Noto Color Emoji", sans-serif`;

function wrapHtml(title, css, body) {
  return `<!doctype html><html lang="zh-CN"><head>${CARD_CSP}<title>${escapeHtml(title)}</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:${BASE_FONT};background:#f0f7f4;color:#0f172a;-webkit-font-smoothing:antialiased;}${css}</style></head><body>${body}</body></html>`;
}

function mealAccent(mealType) {
  if (mealType === 'breakfast') return { accent: '#0ea5e9', soft: '#e0f2fe', tag: '早 餐 · 07:00–09:30' };
  if (mealType === 'lunch') return { accent: '#10b981', soft: '#d1fae5', tag: '午 餐 · 11:30–13:30' };
  return { accent: '#8b5cf6', soft: '#ede9fe', tag: '晚 餐 · 17:30–19:30' };
}

function renderMealColumn(meal) {
  const palette = mealAccent(meal.mealType);
  const ratioPct = Math.round(meal.ratio * 100);
  const isLogged = meal.status === 'logged';

  if (isLogged) {
    return `<section class="meal-card logged" style="border-top:4px solid ${palette.accent}">
      <div class="meal-head">
        <div>
          <span class="meal-tag" style="background:${palette.soft};color:${palette.accent}">${palette.tag}</span>
          <h2>${escapeHtml(meal.label)} · 已完成</h2>
        </div>
        <span class="ratio-pill">${ratioPct}% 配额</span>
      </div>
      <div class="macro-row">
        <div class="macro-big">${meal.logged.calories}<small> kcal</small></div>
        <div class="macro-chips">
          <span>蛋白 ${meal.logged.proteinG}g</span>
          <span>碳水 ${meal.logged.carbsG}g</span>
          <span>脂肪 ${meal.logged.fatG}g</span>
        </div>
      </div>
      <div class="logged-note">已记录内容：${escapeHtml((meal.loggedItems || []).join('；') || '本餐已打卡')}</div>
      <div class="meal-tip">后续未吃餐次已自动按剩余额度重算。</div>
    </section>`;
  }

  const itemsHtml = (meal.items || []).map(it => `<div class="food-row">
    <div class="food-main">
      <div class="food-name">${escapeHtml(it.name)}</div>
      <div class="food-portion">${escapeHtml(it.portionText)}</div>
    </div>
    <div class="food-nums">
      <b>${it.calories} kcal</b>
      <small>蛋白 ${it.proteinG}g</small>
    </div>
  </div>`).join('');

  return `<section class="meal-card" style="border-top:4px solid ${palette.accent}">
    <div class="meal-head">
      <div>
        <span class="meal-tag" style="background:${palette.soft};color:${palette.accent}">${palette.tag}</span>
        <h2>${escapeHtml(meal.label)}${meal.adjustedFromLogs ? ' · 动态调整' : ''}</h2>
      </div>
      <span class="ratio-pill">${ratioPct}% 配额</span>
    </div>
    <div class="macro-row">
      <div class="macro-big">${meal.actual.calories}<small> kcal</small></div>
      <div class="macro-chips">
        <span>蛋白 ${meal.actual.proteinG}g</span>
        <span>碳水 ${meal.actual.carbsG}g</span>
        <span>脂肪 ${meal.actual.fatG}g</span>
      </div>
    </div>
    <div class="food-list">${itemsHtml}</div>
    ${meal.tip ? `<div class="meal-tip">${escapeHtml(meal.tip)}</div>` : ''}
  </section>`;
}

export function buildMealPlanCardHtml({ userName = '群友', plan, appleDay = null, singleMealType = '', aiTip = '' } = {}) {
  const t = plan.targets;
  const single = singleMealType && plan.meals?.[singleMealType] ? [plan.meals[singleMealType]] : null;
  const cols = single || ['breakfast', 'lunch', 'dinner'].map(k => plan.meals[k]);
  const width = single ? 680 : 980;
  const height = single ? 520 : aiTip ? 730 : 660;

  const eatenPct = t.targetCalories > 0 ? Math.min(100, Math.round((plan.eatenTotals.calories / t.targetCalories) * 100)) : 0;
  const protPct = t.proteinG > 0 ? Math.min(100, Math.round((plan.eatenTotals.proteinG / t.proteinG) * 100)) : 0;

  const appleBadge = t.tdeeSource.startsWith('apple')
    ? `<span class="badge apple">${escapeHtml(t.tdeeNote)}</span>`
    : appleDay?.steps
      ? `<span class="badge apple">Apple 健康今日 ${Math.round(appleDay.steps)} 步</span>`
      : `<span class="badge normal">${escapeHtml(t.tdeeNote)}</span>`;

  const css = `
    body{width:${width}px;min-height:${height}px;background:linear-gradient(155deg,#ecf7f2 0%,#eef5fc 55%,#f6f1fc 100%);padding:24px;display:flex;align-items:stretch;justify-content:center;}
    .sheet{width:100%;background:rgba(255,255,255,0.92);border:1px solid #d5e5df;border-radius:24px;padding:24px 26px;display:flex;flex-direction:column;gap:18px;box-shadow:0 18px 44px rgba(15,23,42,0.08);}
    .top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;}
    .title-col h1{font-size:24px;font-weight:700;color:#0f172a;letter-spacing:.2px;}
    .sub{margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
    .badge{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;}
    .badge.goal{background:#dcfce7;color:#15803d;}
    .badge.apple{background:#e0f2fe;color:#0369a1;}
    .badge.normal{background:#f1f5f9;color:#475569;}
    .summary-bar{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:12px 14px;}
    .stat{display:flex;flex-direction:column;gap:2px;}
    .stat span{font-size:11px;color:#64748b;}
    .stat b{font-size:17px;color:#0f172a;}
    .progress-strip{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
    .p-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:8px 12px;}
    .p-meta{display:flex;justify-content:space-between;font-size:12px;color:#334155;margin-bottom:5px;}
    .p-track{height:8px;border-radius:999px;background:#e2e8f0;overflow:hidden;}
    .p-fill-kcal{height:100%;background:linear-gradient(90deg,#10b981,#0ea5e9);border-radius:999px;}
    .p-fill-prot{height:100%;background:linear-gradient(90deg,#8b5cf6,#ec4899);border-radius:999px;}
    .grid{display:grid;grid-template-columns:${single ? '1fr' : 'repeat(3,minmax(0,1fr))'};gap:14px;flex:1;}
    .meal-card{background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:14px 15px;display:flex;flex-direction:column;gap:10px;box-shadow:0 4px 14px rgba(15,23,42,0.03);}
    .meal-card.logged{background:#f8fafc;}
    .meal-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;}
    .meal-tag{display:inline-block;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;letter-spacing:.3px;margin-bottom:4px;}
    .meal-head h2{font-size:16px;font-weight:700;color:#0f172a;}
    .ratio-pill{padding:3px 8px;border-radius:999px;background:#f1f5f9;color:#475569;font-size:11px;font-weight:600;white-space:nowrap;}
    .macro-row{display:flex;flex-direction:column;gap:5px;padding-bottom:8px;border-bottom:1px dashed #e2e8f0;}
    .macro-big{font-size:21px;font-weight:700;color:#0f172a;}
    .macro-big small{font-size:12px;font-weight:500;color:#64748b;}
    .macro-chips{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:#475569;}
    .macro-chips span{background:#f1f5f9;padding:2px 7px;border-radius:6px;}
    .food-list{display:flex;flex-direction:column;gap:8px;flex:1;}
    .food-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;border-radius:10px;background:#f8fafc;}
    .food-main{min-width:0;flex:1;}
    .food-name{font-size:12.5px;font-weight:600;color:#0f172a;line-height:1.35;}
    .food-portion{font-size:11.5px;color:#047857;font-weight:600;margin-top:2px;}
    .food-nums{text-align:right;white-space:nowrap;display:flex;flex-direction:column;gap:1px;}
    .food-nums b{font-size:12px;color:#0f172a;}
    .food-nums small{font-size:10.5px;color:#64748b;}
    .logged-note{font-size:13px;color:#334155;line-height:1.6;padding:10px;background:#fff;border-radius:10px;border:1px solid #e2e8f0;}
    .meal-tip{font-size:11px;color:#64748b;line-height:1.5;margin-top:auto;}
    .ai-banner{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:10px 14px;font-size:12.5px;color:#166534;line-height:1.55;}
    .foot{display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;padding-top:4px;border-top:1px solid #eef2f6;}
  `;

  const body = `<div class="sheet">
    <div class="top">
      <div class="title-col">
        <h1>${escapeHtml(userName)} · ${single ? `${escapeHtml(cols[0].label)}食物建议` : '今日早 / 中 / 晚饮食方案'}</h1>
        <div class="sub">
          <span class="badge goal">${escapeHtml(t.goalLabel)} · 体重 ${t.weightKg}kg</span>
          <span class="badge normal">BMR ${t.bmr} → TDEE ${t.tdee} kcal</span>
          ${appleBadge}
        </div>
      </div>
      <div class="badge normal">${escapeHtml(plan.day)}</div>
    </div>

    <div class="summary-bar">
      <div class="stat"><span>全天目标热量</span><b>${t.targetCalories} kcal</b></div>
      <div class="stat"><span>目标蛋白质</span><b>${t.proteinG} g</b></div>
      <div class="stat"><span>目标碳水</span><b>${t.carbsG} g</b></div>
      <div class="stat"><span>目标脂肪</span><b>${t.fatG} g</b></div>
    </div>

    ${plan.eatenTotals.calories > 0 ? `<div class="progress-strip">
      <div class="p-box">
        <div class="p-meta"><span>今日已吃热量 ${plan.eatenTotals.calories} kcal</span><span>剩 ${plan.remainingBudget.calories} kcal</span></div>
        <div class="p-track"><div class="p-fill-kcal" style="width:${eatenPct}%"></div></div>
      </div>
      <div class="p-box">
        <div class="p-meta"><span>今日已吃蛋白 ${plan.eatenTotals.proteinG} g</span><span>剩 ${plan.remainingBudget.proteinG} g</span></div>
        <div class="p-track"><div class="p-fill-prot" style="width:${protPct}%"></div></div>
      </div>
    </div>` : ''}

    <div class="grid">${cols.map(renderMealColumn).join('')}</div>

    ${aiTip ? `<div class="ai-banner"><b>🥗 搭配贴士：</b>${escapeHtml(aiTip)}</div>` : ''}

    <div class="foot">
      <span>发食物图或描述「/记一餐」自动计算热量与蛋白，并进入 Apple 健康同步队列</span>
      <span>群屿 · 健康饮食管家</span>
    </div>
  </div>`;

  return { html: wrapHtml(`${userName} 今日饮食方案`, css, body), width, height };
}

export function buildHealthHelpHtml() {
  const css = `
    body{width:860px;min-height:600px;background:linear-gradient(155deg,#ecfdf5 0%,#eff6ff 100%);padding:26px;display:flex;align-items:center;justify-content:center;}
    .wrap{width:100%;background:#ffffff;border:1px solid #d1e3dc;border-radius:24px;padding:28px 30px;display:flex;flex-direction:column;gap:18px;box-shadow:0 20px 44px rgba(15,23,42,0.08);}
    h1{font-size:26px;color:#0f172a;}
    p.lead{font-size:13.5px;color:#475569;margin-top:4px;line-height:1.6;}
    .cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    .box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:16px 18px;display:flex;flex-direction:column;gap:8px;}
    .box h2{font-size:15px;color:#047857;margin-bottom:2px;}
    .row{font-size:12.5px;color:#1e293b;line-height:1.6;}
    code{background:#e2e8f0;color:#0f172a;padding:2px 6px;border-radius:6px;font-size:12px;}
    .foot{font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:12px;display:flex;justify-content:space-between;}
  `;
  const body = `<div class="wrap">
    <div>
      <h1>🥗 健康饮食管家 · 使用指南</h1>
      <p class="lead">先录入身体数据算清基础代谢，再按早 / 中 / 晚三餐拆分每日需要吃的具体食物与克重；支持拍照记一餐与 Apple 健康同步。</p>
    </div>
    <div class="cols">
      <div class="box">
        <h2>01 / 录入健康档案</h2>
        <div class="row"><code>/健康 录入 男 26岁 175cm 72kg 减脂 中度</code><br>参数支持带单位自由顺序；目标可选「减脂 / 维持 / 增肌」，活动度可选「久坐 / 轻度 / 中度 / 高度 / 极高」，可附加「体脂20%」。</div>
        <div class="row"><code>/健康 忌口 海鲜 牛奶</code> · 设置不吃的食材（发送「无」清空）</div>
        <div class="row"><code>/健康 偏好 外食</code> · 可选「日常均衡 / 外食食堂 / 高蛋白 / 轻食」</div>
        <div class="row"><code>/健康 比例 30 40 30</code> · 自定义早中晚三餐热量比例</div>
      </div>
      <div class="box">
        <h2>02 / 查看方案与拍照记一餐</h2>
        <div class="row"><code>/健康 方案</code> 或 <code>/吃什么 [早|中|晚]</code><br>生成当日早/中/晚推荐食物克重卡片。</div>
        <div class="row"><code>/记一餐 [早|中|晚] [食物描述]</code><br>可同时<b>附带或回复食物照片</b>，AI 自动估算大卡与蛋白质，并重算剩余餐次食谱、排入 Apple 健康写入队列。</div>
        <div class="row"><code>/健康 今日</code> / <code>/健康 撤销</code> · 查今日摄入缺口或撤销刚记错的一餐</div>
      </div>
      <div class="box">
        <h2>03 / 早中晚定时推送</h2>
        <div class="row"><code>/健康 推送 全部</code> · 早上推全天三餐总览 + 午晚饭前分餐动态提醒</div>
        <div class="row"><code>/健康 推送 早报</code> / <code>分餐</code> / <code>关闭</code> · 切换个人推送节奏</div>
        <div class="row"><code>/健康 推送 私聊</code> / <code>群聊</code> · 选择仅私聊（默认）或在当前群推送</div>
      </div>
      <div class="box">
        <h2>04 / 对接 Apple 健康（私聊操作）</h2>
        <div class="row">加好友后<b>私聊</b>发送 <code>/健康 同步</code> 获取个人同步令牌与接口地址。</div>
        <div class="row">用 iPhone 自带「快捷指令」定期把 Apple 健康的步数/活动消耗/体重传给机器人动态修正热量，并把 <code>/记一餐</code> 营养回写进 Apple 健康。</div>
      </div>
    </div>
    <div class="foot"><span>支持 / 与 # 指令前缀 · 个人健康档案 AES-256-GCM 加密存储</span><span>私聊发「/健康 删除数据」可一键清除全部个人记录</span></div>
  </div>`;
  return { html: wrapHtml('健康饮食管家指南', css, body), width: 860, height: 600 };
}

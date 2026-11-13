import { escapeHtml } from '../card-renderer.mjs';

const CARD_CSP = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:">`;
const BASE_FONT = `-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", "Noto Color Emoji", sans-serif`;

function wrapHtml(title, css, body) {
  return `<!doctype html><html lang="zh-CN"><head>${CARD_CSP}<title>${escapeHtml(title)}</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:${BASE_FONT};background:#0f172a;color:#f8fafc;-webkit-font-smoothing:antialiased;}${css}</style></head><body>${body}</body></html>`;
}

function radarSvg(values = [], labels = []) {
  const cx = 115, cy = 115, r = 76;
  const count = Math.max(3, values.length);
  const point = (index, ratio) => {
    const angle = (-Math.PI / 2) + (2 * Math.PI * index) / count;
    return [cx + Math.cos(angle) * r * ratio, cy + Math.sin(angle) * r * ratio];
  };
  const rings = [0.25, 0.5, 0.75, 1].map(ratio => {
    const pts = Array.from({ length: count }, (_, i) => point(i, ratio).map(n => n.toFixed(1)).join(',')).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="rgba(148,163,184,0.22)" stroke-width="1"/>`;
  }).join('');
  const axes = Array.from({ length: count }, (_, i) => {
    const [x, y] = point(i, 1);
    const [lx, ly] = point(i, 1.24);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(148,163,184,0.22)" stroke-width="1"/>`
      + `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" fill="#cbd5e1" font-size="11" font-weight="600">${escapeHtml(labels[i] || '')}</text>`;
  }).join('');
  const polyPts = values.map((v, i) => point(i, Math.max(0.06, Math.min(1, Number(v || 0) / 100))).map(n => n.toFixed(1)).join(',')).join(' ');
  return `<svg width="230" height="230" viewBox="0 0 230 230">${rings}${axes}<polygon points="${polyPts}" fill="rgba(244,114,182,0.28)" stroke="#f472b6" stroke-width="2.5"/></svg>`;
}

export function buildEmotionCardHtml({ characterName = '角色', emotion = {}, metrics = [], avatarDataUrl = '', scopeLabel = '' } = {}) {
  const colors = { affection: '#f472b6', joy: '#fbbf24', trust: '#34d399', tension: '#fb923c', depression: '#818cf8' };
  const barsHtml = metrics.map(m => {
    const val = Math.max(0, Math.min(100, Number(emotion[m.key] ?? m.initial ?? 50)));
    const barColor = colors[m.key] || '#60a5fa';
    return `<div class="bar-row"><div class="bar-meta"><span>${escapeHtml(m.label)}</span><strong>${val}</strong></div><div class="bar-track"><div class="bar-fill" style="width:${val}%;background:${barColor}"></div></div></div>`;
  }).join('');

  const radar = radarSvg(metrics.map(m => emotion[m.key] ?? 0), metrics.map(m => m.label));
  const avatarHtml = avatarDataUrl
    ? `<img src="${escapeHtml(avatarDataUrl)}" class="avatar" />`
    : `<div class="avatar placeholder">${escapeHtml(String(characterName).slice(0, 1))}</div>`;

  const css = `
    body{width:820px;height:520px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 52%,#31103f 100%);padding:24px;}
    .card{width:100%;height:100%;border-radius:24px;background:rgba(15,23,42,0.78);border:1px solid rgba(255,255,255,0.14);padding:26px 28px;display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 24px 60px rgba(0,0,0,0.45);}
    .head{display:flex;align-items:center;gap:18px;}
    .avatar{width:76px;height:76px;border-radius:18px;object-fit:cover;border:2px solid rgba(244,114,182,0.6);flex-shrink:0;}
    .placeholder{display:grid;place-items:center;font-size:32px;font-weight:700;background:linear-gradient(135deg,#ec4899,#8b5cf6);}
    .title-area{flex:1;min-width:0;}
    .title-area h1{font-size:26px;font-weight:700;letter-spacing:.3px;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .badges{display:flex;gap:8px;flex-wrap:wrap;}
    .pill{padding:5px 12px;border-radius:999px;font-size:13px;font-weight:600;}
    .pill-stage{background:rgba(244,114,182,0.2);color:#fbcfe8;border:1px solid rgba(244,114,182,0.45);}
    .pill-mood{background:rgba(56,189,248,0.18);color:#bae6fd;border:1px solid rgba(56,189,248,0.38);}
    .pill-scope{background:rgba(148,163,184,0.16);color:#cbd5e1;border:1px solid rgba(148,163,184,0.3);}
    .main{display:grid;grid-template-columns:230px 1fr;gap:26px;align-items:center;}
    .radar-box{display:flex;align-items:center;justify-content:center;background:rgba(30,41,59,0.55);border-radius:18px;padding:6px;}
    .bars{display:flex;flex-direction:column;gap:13px;}
    .bar-meta{display:flex;justify-content:space-between;font-size:14px;color:#e2e8f0;margin-bottom:5px;}
    .bar-track{height:10px;border-radius:999px;background:rgba(255,255,255,0.1);overflow:hidden;}
    .bar-fill{height:100%;border-radius:999px;}
    .foot{padding-top:12px;border-top:1px solid rgba(255,255,255,0.1);display:flex;justify-content:space-between;align-items:center;gap:16px;font-size:13px;color:#cbd5e1;}
    .reason{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .brand{color:#94a3b8;font-size:12px;font-weight:600;white-space:nowrap;}
  `;
  const body = `<div class="card">
    <div class="head">${avatarHtml}<div class="title-area"><h1>${escapeHtml(characterName)} · 羁绊档案</h1><div class="badges"><span class="pill pill-stage">${escapeHtml(emotion.stage || '普通熟人')}</span><span class="pill pill-mood">心境：${escapeHtml(emotion.mood || '平静')}</span>${scopeLabel ? `<span class="pill pill-scope">${escapeHtml(scopeLabel)}</span>` : ''}</div></div></div>
    <div class="main"><div class="radar-box">${radar}</div><div class="bars">${barsHtml}</div></div>
    <div class="foot"><div class="reason">最近波动：${escapeHtml(emotion.reason || '初始状态')}</div><div class="brand">群屿酒馆 · 情绪羁绊系统</div></div>
  </div>`;
  return wrapHtml(`${characterName} 羁绊档案`, css, body);
}

export function buildFortuneCardHtml({ userName = '群友', avatarDataUrl = '', dateText = '', tier = '大吉', badgeColor = '#f43f5e', verse = '', goodItems = [], badItems = [], luckyColor = '', luckyGame = '', comment = '' } = {}) {
  const avatarHtml = avatarDataUrl
    ? `<img src="${escapeHtml(avatarDataUrl)}" class="avatar" />`
    : `<div class="avatar placeholder">${escapeHtml(String(userName).slice(0, 1))}</div>`;
  const css = `
    body{width:780px;height:600px;background:linear-gradient(145deg,#fff8f0 0%,#fde8e8 50%,#f3e8ff 100%);color:#1e293b;padding:24px;display:flex;align-items:center;justify-content:center;}
    .card{width:100%;height:100%;background:rgba(255,255,255,0.92);border-radius:26px;border:2px solid rgba(244,63,94,0.18);padding:28px 32px;display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 20px 50px rgba(15,23,42,0.12);}
    .top{display:flex;justify-content:space-between;align-items:center;gap:16px;}
    .user{display:flex;align-items:center;gap:14px;}
    .avatar{width:62px;height:62px;border-radius:50%;object-fit:cover;border:2px solid rgba(244,63,94,0.35);}
    .placeholder{display:grid;place-items:center;font-size:24px;font-weight:700;background:#ffe4e6;color:#be123c;}
    .user h2{font-size:21px;font-weight:700;color:#0f172a;}
    .user p{font-size:13px;color:#64748b;margin-top:4px;}
    .tier{padding:10px 26px;border-radius:16px;background:${escapeHtml(badgeColor)};color:#fff;font-size:32px;font-weight:800;letter-spacing:4px;box-shadow:0 10px 22px rgba(0,0,0,0.14);}
    .verse-box{background:linear-gradient(135deg,#fff1f2,#faf5ff);border-left:5px solid ${escapeHtml(badgeColor)};border-radius:14px;padding:18px 22px;}
    .verse-label{font-size:12px;font-weight:700;color:#64748b;letter-spacing:1.2px;margin-bottom:6px;}
    .verse{font-size:20px;font-weight:700;color:#1e293b;line-height:1.5;}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    .col{border-radius:16px;padding:16px 18px;border:1px solid rgba(148,163,184,0.2);}
    .good{background:#f0fdf4;border-color:#bbf7d0;}
    .bad{background:#fef2f2;border-color:#fecaca;}
    .col h3{font-size:15px;font-weight:800;margin-bottom:10px;}
    .good h3{color:#15803d;}
    .bad h3{color:#b91c1c;}
    .tag-row{display:flex;flex-wrap:wrap;gap:8px;}
    .chip{padding:6px 12px;border-radius:10px;background:#fff;font-size:14px;font-weight:600;color:#334155;box-shadow:0 1px 4px rgba(0,0,0,0.05);}
    .bottom{display:flex;justify-content:space-between;align-items:center;border-top:1px dashed #cbd5e1;padding-top:14px;font-size:14px;color:#475569;gap:12px;}
    .comment{flex:1;font-style:italic;color:#334155;}
    .meta{font-weight:600;color:#64748b;white-space:nowrap;}
  `;
  const body = `<div class="card">
    <div class="top"><div class="user">${avatarHtml}<div><h2>${escapeHtml(userName)} 的今日运势签</h2><p>${escapeHtml(dateText)} · 群屿祈愿神社</p></div></div><div class="tier">${escapeHtml(tier)}</div></div>
    <div class="verse-box"><div class="verse-label">【签文指引】</div><div class="verse">${escapeHtml(verse)}</div></div>
    <div class="grid">
      <div class="col good"><h3>今日宜</h3><div class="tag-row">${goodItems.map(i => `<span class="chip">${escapeHtml(i)}</span>`).join('')}</div></div>
      <div class="col bad"><h3>今日忌</h3><div class="tag-row">${badItems.map(i => `<span class="chip">${escapeHtml(i)}</span>`).join('')}</div></div>
    </div>
    <div class="bottom"><div class="comment">✨ ${escapeHtml(comment)}</div><div class="meta">幸运色：${escapeHtml(luckyColor)} · 宜玩：${escapeHtml(luckyGame)}</div></div>
  </div>`;
  return wrapHtml('今日运势签', css, body);
}

export function buildQuoteCardHtml({ text = '', authorName = '群友', authorQq = '', avatarDataUrl = '', groupId = '', dateText = '' } = {}) {
  const safeText = String(text || '').slice(0, 220);
  const avatarHtml = avatarDataUrl
    ? `<img src="${escapeHtml(avatarDataUrl)}" class="avatar" />`
    : `<div class="avatar placeholder">${escapeHtml(String(authorName).slice(0, 1))}</div>`;
  const css = `
    body{width:900px;height:480px;background:radial-gradient(circle at 20% 20%,#1e293b 0%,#090d16 70%);display:flex;align-items:center;justify-content:center;padding:28px;}
    .frame{width:100%;height:100%;border-radius:24px;border:1px solid rgba(255,255,255,0.14);background:linear-gradient(155deg,rgba(30,41,59,0.75),rgba(9,13,22,0.95));padding:36px 42px;display:flex;flex-direction:column;justify-content:space-between;position:relative;}
    .mark{font-size:74px;line-height:1;color:rgba(244,114,182,0.32);font-family:Georgia,serif;position:absolute;top:22px;left:32px;}
    .quote{flex:1;display:flex;align-items:center;justify-content:center;text-align:center;padding:20px 28px;font-size:${safeText.length > 70 ? 25 : safeText.length > 35 ? 30 : 35}px;font-weight:700;line-height:1.5;color:#f8fafc;word-break:break-word;}
    .author-bar{display:flex;align-items:center;justify-content:space-between;border-top:1px solid rgba(255,255,255,0.12);padding-top:18px;}
    .author{display:flex;align-items:center;gap:14px;}
    .avatar{width:54px;height:54px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,0.4);}
    .placeholder{display:grid;place-items:center;font-size:22px;font-weight:700;background:#334155;}
    .name{font-size:18px;font-weight:700;color:#f1f5f9;}
    .sub{font-size:13px;color:#94a3b8;margin-top:3px;}
    .stamp{padding:6px 14px;border-radius:10px;border:1px solid rgba(244,114,182,0.45);color:#f9a8d4;font-size:13px;font-weight:700;letter-spacing:1.2px;}
  `;
  const body = `<div class="frame"><div class="mark">“</div><div class="quote">${escapeHtml(safeText)}</div><div class="author-bar"><div class="author">${avatarHtml}<div><div class="name">—— ${escapeHtml(authorName)}</div><div class="sub">${authorQq ? `QQ ${escapeHtml(authorQq)} · ` : ''}${groupId ? `群 ${escapeHtml(groupId)} · ` : ''}${escapeHtml(dateText)}</div></div></div><div class="stamp">群史名场面</div></div></div>`;
  return wrapHtml('群聊名场面语录', css, body);
}

export function buildMemeCardHtml({ mode = 'xi_bao', topText = '', bottomText = '', text = '', imageDataUrl = '', width = 840, height = 540, avatarDataUrl = '', charName = '看板娘' } = {}) {
  if (mode === 'caption' && imageDataUrl) {
    const css = `
      body{width:${width}px;height:${height}px;background:#0b0f19;display:flex;flex-direction:column;justify-content:center;align-items:center;}
      .meme{position:relative;width:100%;height:100%;display:flex;flex-direction:column;background:#111827;}
      .img-wrap{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;}
      .img-wrap img{max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;}
      .cap{position:absolute;left:16px;right:16px;text-align:center;font-weight:900;font-size:38px;line-height:1.2;color:#ffffff;text-shadow:-2px -2px 0 #000,2px -2px 0 #000,-2px 2px 0 #000,2px 2px 0 #000,0 4px 10px rgba(0,0,0,0.85);word-break:break-word;}
      .top{top:16px;}.bottom{bottom:16px;}
    `;
    const body = `<div class="meme"><div class="img-wrap"><img src="${escapeHtml(imageDataUrl)}" />${topText ? `<div class="cap top">${escapeHtml(topText)}</div>` : ''}${bottomText ? `<div class="cap bottom">${escapeHtml(bottomText)}</div>` : ''}</div></div>`;
    return wrapHtml('梗图加字', css, body);
  }
  if (mode === 'signboard') {
    const avatarHtml = avatarDataUrl
      ? `<img src="${escapeHtml(avatarDataUrl)}" class="mascot" />`
      : `<div class="mascot mascot-fallback">${escapeHtml(charName.slice(0, 1))}</div>`;
    const css = `
      body{width:760px;height:600px;background:linear-gradient(160deg,#fdf2f8,#eef2ff);display:flex;align-items:center;justify-content:center;padding:26px;}
      .stage{width:100%;height:100%;background:#ffffff;border-radius:26px;border:2px solid #e2e8f0;padding:28px;display:flex;flex-direction:column;align-items:center;justify-content:space-between;box-shadow:0 20px 50px rgba(30,41,59,0.12);}
      .char{display:flex;align-items:center;gap:16px;align-self:flex-start;}
      .mascot{width:96px;height:96px;border-radius:22px;object-fit:cover;border:3px solid #f472b6;}
      .mascot-fallback{display:grid;place-items:center;font-size:40px;font-weight:800;background:#fbcfe8;color:#9d174d;}
      .name{font-size:22px;font-weight:800;color:#1e293b;}
      .tag{font-size:13px;color:#64748b;margin-top:4px;}
      .board{width:100%;flex:1;margin-top:18px;border:6px solid #334155;border-radius:18px;background:#fffbeb;display:flex;align-items:center;justify-content:center;padding:24px 28px;text-align:center;color:#0f172a;font-size:${String(text).length > 40 ? 28 : 36}px;font-weight:900;line-height:1.45;word-break:break-word;box-shadow:inset 0 0 0 4px #fde68a;}
    `;
    const body = `<div class="stage"><div class="char">${avatarHtml}<div><div class="name">${escapeHtml(charName)} 正在举牌：</div><div class="tag">群屿梗图工坊</div></div></div><div class="board">${escapeHtml(text)}</div></div>`;
    return wrapHtml('举牌海报', css, body);
  }
  const isBei = mode === 'bei_bao';
  const css = isBei ? `
    body{width:840px;height:540px;background:repeating-linear-gradient(135deg,#18181b,#18181b 24px,#27272a 24px,#27272a 48px);padding:24px;display:flex;align-items:center;justify-content:center;}
    .poster{width:100%;height:100%;background:linear-gradient(180deg,#27272a 0%,#09090b 100%);border:10px solid #a1a1aa;outline:4px solid #3f3f46;border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:34px 44px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,0.6);}
    .head{font-size:74px;font-weight:900;letter-spacing:18px;color:#e4e4e7;margin-bottom:22px;text-shadow:0 4px 12px rgba(0,0,0,0.8);}
    .msg{font-size:${String(text).length > 32 ? 32 : 42}px;font-weight:800;line-height:1.45;color:#fafafa;word-break:break-word;}
  ` : `
    body{width:840px;height:540px;background:radial-gradient(circle,#fde047 0%,#dc2626 68%,#991b1b 100%);padding:24px;display:flex;align-items:center;justify-content:center;}
    .poster{width:100%;height:100%;background:linear-gradient(180deg,#ef4444 0%,#b91c1c 100%);border:12px solid #facc15;outline:4px solid #7f1d1d;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:34px 44px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,0.45);}
    .head{font-size:76px;font-weight:900;letter-spacing:18px;color:#fef08a;margin-bottom:22px;text-shadow:0 4px 0 #7f1d1d,0 8px 18px rgba(0,0,0,0.45);}
    .msg{font-size:${String(text).length > 32 ? 32 : 42}px;font-weight:900;line-height:1.45;color:#fffbeb;text-shadow:0 3px 0 #7f1d1d;word-break:break-word;}
  `;
  const body = `<div class="poster"><div class="head">${isBei ? '悲报' : '喜报'}</div><div class="msg">${escapeHtml(text)}</div></div>`;
  return wrapHtml(isBei ? '悲报' : '喜报', css, body);
}

export function buildGachaCardHtml({ gameName = '', gameColor = '#38bdf8', pulls = [], pityAfter = 0, pityLimit = 80, totalPulls = 0, totalGold = 0, userName = '旅行者' } = {}) {
  const cards = pulls.map(item => {
    const cls = item.rarity >= 5 ? 'gold' : item.rarity === 4 ? 'purple' : 'blue';
    const stars = '★'.repeat(item.rarity);
    return `<div class="slot ${cls}"><div class="stars">${stars}</div><div class="iname">${escapeHtml(item.name)}</div><div class="itag">${escapeHtml(item.tag || '')}</div></div>`;
  }).join('');
  const css = `
    body{width:960px;height:620px;background:linear-gradient(135deg,#090d16,#172554);padding:26px;display:flex;flex-direction:column;justify-content:space-between;}
    .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;}
    .title{display:flex;align-items:center;gap:12px;}
    .dot{width:14px;height:14px;border-radius:50%;background:${escapeHtml(gameColor)};box-shadow:0 0 14px ${escapeHtml(gameColor)};}
    h1{font-size:24px;font-weight:800;}
    .meta{font-size:14px;color:#cbd5e1;background:rgba(255,255,255,0.08);padding:7px 14px;border-radius:999px;}
    .grid{flex:1;display:grid;grid-template-columns:repeat(5,1fr);grid-template-rows:repeat(2,1fr);gap:14px;}
    .slot{border-radius:16px;padding:14px 12px;display:flex;flex-direction:column;justify-content:space-between;border:1px solid rgba(255,255,255,0.12);position:relative;overflow:hidden;}
    .gold{background:linear-gradient(160deg,rgba(250,204,21,0.34),rgba(180,83,9,0.65));border-color:#fde047;box-shadow:0 0 22px rgba(250,204,21,0.35);}
    .purple{background:linear-gradient(160deg,rgba(168,85,247,0.28),rgba(88,28,135,0.58));border-color:#d8b4fe;}
    .blue{background:linear-gradient(160deg,rgba(56,189,248,0.16),rgba(15,23,42,0.75));border-color:rgba(148,163,184,0.28);}
    .stars{font-size:13px;font-weight:800;letter-spacing:1px;}
    .gold .stars{color:#fef08a;}.purple .stars{color:#e9d5ff;}.blue .stars{color:#7dd3fc;}
    .iname{font-size:18px;font-weight:800;line-height:1.3;word-break:break-word;}
    .itag{font-size:12px;color:rgba(255,255,255,0.78);}
    .foot{margin-top:16px;display:flex;justify-content:space-between;font-size:13px;color:#94a3b8;}
  `;
  const body = `<div class="top"><div class="title"><span class="dot"></span><h1>${escapeHtml(gameName)} · 十连唤取结果</h1></div><div class="meta">唤取人：${escapeHtml(userName)} · 垫抽水位 ${pityAfter}/${pityLimit}</div></div><div class="grid">${cards}</div><div class="foot"><span>累计模拟抽数：${totalPulls} · 累计出金：${totalGold}</span><span>群屿游戏娱乐 · 仅供娱乐参考真实概率请以游戏为准</span></div>`;
  return wrapHtml(`${gameName} 十连模拟`, css, body);
}

export function buildDailyReportCardHtml({ groupId = '', dateText = '', totalMessages = 0, activeMembers = 0, topTalkers = [], nightOwls = [], hotWords = [], aiSummary = '' } = {}) {
  const talkRows = topTalkers.map((m, i) => `<div class="rank-row"><span class="idx">#${i + 1}</span><span class="rname">${escapeHtml(m.name || `QQ ${m.userId}`)}</span><strong>${m.count} 条</strong></div>`).join('') || '<div class="empty">今日暂无发言统计</div>';
  const owlRows = nightOwls.map((m, i) => `<div class="rank-row"><span class="idx">#${i + 1}</span><span class="rname">${escapeHtml(m.name || `QQ ${m.userId}`)}</span><strong>深夜 ${m.nightCount} 条</strong></div>`).join('') || '<div class="empty">大家作息很规律～</div>';
  const chips = hotWords.map(w => `<span class="wchip">${escapeHtml(w.word)} <em>${w.count}</em></span>`).join('') || '<span class="wchip">今天风平浪静</span>';
  const css = `
    body{width:900px;height:760px;background:linear-gradient(145deg,#0f172a,#1e293b);padding:26px;display:flex;flex-direction:column;justify-content:space-between;}
    .head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid rgba(255,255,255,0.12);padding-bottom:16px;}
    .head h1{font-size:28px;font-weight:800;}
    .head p{font-size:13px;color:#94a3b8;margin-top:4px;}
    .kpis{display:flex;gap:14px;}
    .kpi{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:10px 18px;text-align:right;}
    .kpi span{display:block;font-size:11px;color:#94a3b8;}.kpi strong{font-size:22px;color:#38bdf8;}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px;}
    .panel{background:rgba(15,23,42,0.72);border:1px solid rgba(255,255,255,0.1);border-radius:18px;padding:18px 20px;}
    .panel h2{font-size:16px;font-weight:700;color:#e2e8f0;margin-bottom:12px;}
    .rank-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px dashed rgba(255,255,255,0.08);font-size:14px;}
    .idx{width:34px;font-weight:800;color:#fbbf24;}
    .rname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:10px;}
    .words{display:flex;flex-wrap:wrap;gap:8px;}
    .wchip{padding:6px 12px;border-radius:999px;background:rgba(56,189,248,0.15);border:1px solid rgba(56,189,248,0.3);font-size:13px;color:#e0f2fe;}
    .wchip em{font-style:normal;color:#7dd3fc;margin-left:4px;font-weight:700;}
    .summary{margin-top:16px;background:linear-gradient(135deg,rgba(236,72,153,0.14),rgba(99,102,241,0.14));border:1px solid rgba(244,114,182,0.28);border-radius:18px;padding:18px 22px;}
    .summary h2{font-size:15px;color:#fbcfe8;margin-bottom:8px;}
    .summary p{font-size:15px;line-height:1.6;color:#f1f5f9;}
    .empty{font-size:13px;color:#64748b;}
    .foot{margin-top:12px;text-align:right;font-size:12px;color:#64748b;}
  `;
  const body = `<div>
    <div class="head"><div><h1>群聊今日风向日报</h1><p>群 ${escapeHtml(groupId)} · ${escapeHtml(dateText)}</p></div><div class="kpis"><div class="kpi"><span>统计消息数</span><strong>${totalMessages}</strong></div><div class="kpi"><span>活跃群友</span><strong>${activeMembers}</strong></div></div></div>
    <div class="grid"><div class="panel"><h2>🏆 话痨龙王榜</h2>${talkRows}</div><div class="panel"><h2>🦉 深夜修仙榜 (00:00-05:00)</h2>${owlRows}</div></div>
    <div class="panel" style="margin-top:16px;"><h2>🔥 今日高频关键词</h2><div class="words">${chips}</div></div>
    ${aiSummary ? `<div class="summary"><h2>💬 群屿观察员锐评</h2><p>${escapeHtml(aiSummary)}</p></div>` : ''}
  </div><div class="foot">群屿群聊洞察 · 仅做匿名频次与词频统计，不保留完整聊天正文</div>`;
  return wrapHtml('群聊日报', css, body);
}

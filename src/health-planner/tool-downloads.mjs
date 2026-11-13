import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const shortcutsDir = join(moduleDir, 'shortcuts');
const assetsDir = join(moduleDir, 'tool');

const VERSION = '1.0.0';

export const SHORTCUT_ITEMS = [
  {
    name: 'health-quick-log-meal.shortcut',
    qqFilename: '桌面一键记一餐.shortcut',
    title: '桌面一键记一餐',
    tag: 'RECOMMENDED · 复制即识别',
    featured: true,
    summary: '支持直接识别剪贴板中复制的菜名/外卖文字或截图，也支持粘贴修改、拍照与相册选图，直连 DeepSeek / 识图并写回 Apple 健康。',
    pills: ['识别剪贴板文字/截图', '自动写回健康', '剩余预算通知'],
    detail: '默认置顶「识别剪贴板内容」，复制文字或截图后点一下即可识别入账并弹出今日剩余预算；亦可直接让 QQ Bot 发到私聊或群内导入。'
  },
  {
    name: 'health-sync-apple-to-bot.shortcut',
    qqFilename: '同步Apple健康到Bot.shortcut',
    title: '同步 Apple 健康到 Bot',
    tag: 'APPLE HEALTH → BOT',
    featured: false,
    summary: '读取手机今日步数、活动能量与最新体重，上传后自动按真实运动消耗动态修正每日热量目标。',
    pills: ['今日步数', '活动能量', '最新体重'],
    detail: '建议在「快捷指令 → 自动化」新建一个每日定时个人自动化（如 11:15 / 17:15 / 22:00）静默同步。'
  },
  {
    name: 'health-meals-bot-to-apple.shortcut',
    qqFilename: 'Bot记餐写回Apple健康.shortcut',
    title: 'Bot 记餐写回 Apple 健康',
    tag: 'BOT → APPLE HEALTH',
    featured: false,
    summary: '如果你平时在 QQ 里发 /记一餐，这个指令可以把待写入队列的膳食能量与蛋白批量补写入 Apple 健康并出队。',
    pills: ['膳食能量 kcal', '蛋白质 / 碳水 / 脂肪', '批量出队确认'],
    detail: '使用「桌面一键记一餐」时会自动当场写回 Apple 健康；在 QQ 里发的记录用本指令定期同步即可。'
  }
];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readAsset(filename) {
  return readFileSync(join(assetsDir, filename));
}

function readShortcutBinary(name) {
  const fullPath = join(shortcutsDir, name);
  if (!existsSync(fullPath)) return null;
  try {
    const stat = lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 32 || stat.size > 2 * 1024 * 1024) return null;
    return readFileSync(fullPath);
  } catch {
    return null;
  }
}

/** Return the validated, Apple-signed .shortcut installers available for QQ or HTTP delivery. */
export function listShortcutInstallers() {
  const result = [];
  for (const item of SHORTCUT_ITEMS) {
    const bytes = readShortcutBinary(item.name);
    if (bytes) {
      result.push({
        name: item.name,
        qqFilename: item.qqFilename || item.name,
        title: item.title,
        path: join(shortcutsDir, item.name),
        bytes
      });
    }
  }
  return result;
}

function formatBytes(bytes) {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function renderPage({ publicUrl = '' } = {}) {
  const configured = String(publicUrl || '').trim().replace(/\/+$/, '');
  const fallbackDisplay = configured || '将自动识别当前网页地址';

  const cardsHtml = SHORTCUT_ITEMS.map(item => {
    const bytes = readShortcutBinary(item.name);
    const metaText = bytes
      ? `${item.name} · ${formatBytes(bytes.length)} · Apple 已签名`
      : '快捷指令文件暂未构建';
    const actionHtml = bytes
      ? `<a class="button ${item.featured ? 'button-mint' : 'button-light'}" href="/downloads/${item.name}">一键添加到 iPhone 快捷指令</a>`
      : `<span class="button button-light" aria-disabled="true">暂未就绪</span>`;
    return `
      <article class="card${item.featured ? ' card-featured' : ''}">
        <div class="card-top">
          <span class="badge">${item.tag}</span>
        </div>
        <h3>${item.title}</h3>
        <p class="card-desc">${item.summary}</p>
        <div class="pill-row">${item.pills.map(p => `<span>${p}</span>`).join('')}</div>
        <p class="card-detail">${item.detail}</p>
        <div class="card-action">
          ${actionHtml}
          <p class="meta">${metaText}</p>
        </div>
      </article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#f6f7f2">
  <meta name="description" content="一键安装 QQ Bot 健康饮食管家所需的 Apple 快捷指令：桌面一键记一餐、Apple 健康与 Bot 双向同步。">
  <title>Apple 健康快捷指令安装中心 · 健康饮食管家</title>
  <link rel="stylesheet" href="/tools/health/health.css">
</head>
<body>
<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="/tools/health/">
      <span class="brand-mark" aria-hidden="true">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.5-9-9.2C1.4 8 3.8 4.5 7.4 4.5c2 0 3.7 1 4.6 2.5.9-1.5 2.6-2.5 4.6-2.5C20.2 4.5 22.6 8 21 11.8 19 16.5 12 21 12 21Z"/></svg>
      </span>
      <span>健康快捷指令中心<small>APPLE HEALTH × QQ BOT</small></span>
    </a>
    <nav aria-label="页面导航">
      <a href="#shortcuts">一键安装</a>
      <a href="#steps">三步配置</a>
      <a href="#faq">常见问题</a>
    </nav>
    <span class="version"><span class="dot"></span>v${VERSION}</span>
  </div>
</header>

<main>
  <section class="hero container">
    <div>
      <p class="eyebrow"><span class="dot"></span>Apple 官方签名 · 无需 macOS 应用 · 剪贴板复制即识别</p>
      <h1>QQ 领文件，iPhone 点一下，<br><span>复制截图/文字就记一餐。</span></h1>
      <p class="hero-desc">无需安装任何电脑端或 macOS 应用。直接在 QQ 私聊发 <code>/健康 同步</code>（或在群聊发 <code>/健康 快捷指令</code>），机器人会把 3 个已签名 <code>.shortcut</code> 直接发到你手机；也可在本页用 iPhone Safari 备用下载。装好「桌面一键记一餐」后，默认优先识别手机剪贴板里的文字或食物截图。</p>
    </div>
    <div class="server-box">
      <p class="server-box-kicker">STEP 0 / 先复制你的服务器地址</p>
      <h2>安装弹窗第一步会问「服务器地址」</h2>
      <div class="server-url-row">
        <code id="server-url-code" class="server-url-code" data-configured="${escapeHtml(configured)}">${escapeHtml(fallbackDisplay)}</code>
        <button id="copy-server-url" class="button button-dark" type="button">复制服务器地址</button>
      </div>
      <p id="copy-status" class="copy-status" role="status"></p>
      <p class="server-note">个人同步 Token 请回到 QQ 私聊发送 <code>/健康 同步</code> 获取，本页面不会收集或保存你的个人 Token。</p>
    </div>
  </section>

  <section class="downloads-section container" id="shortcuts">
    <div class="section-heading">
      <div>
        <p class="section-kicker">01 / ONE-TAP INSTALL</p>
        <h2>选择需要安装的快捷指令</h2>
      </div>
      <p>推荐 3 个全部添加，日常主要点第一个桌面记餐图标即可</p>
    </div>
    <div class="download-grid">${cardsHtml}</div>
  </section>

  <section class="guide-section container" id="steps">
    <div class="section-heading">
      <div>
        <p class="section-kicker">02 / SETUP GUIDE</p>
        <h2>iPhone 安装与权限只需 3 步</h2>
      </div>
      <p>全程在苹果系统「快捷指令」App 内完成</p>
    </div>
    <div class="steps-grid">
      <article class="step-card">
        <p class="step-num">STEP 01</p>
        <h3>QQ 直接收文件或复制地址</h3>
        <p>推荐在 QQ 私聊机器人发 <code>/健康 同步</code>，Bot 会把 3 个 <code>.shortcut</code> 文件、服务器地址和个人 Token 一并发给你；若从本页 Safari 下载，先点上方「复制服务器地址」再发 <code>/健康 同步</code> 拷 Token。</p>
      </article>
      <article class="step-card">
        <p class="step-num">STEP 02</p>
        <h3>打开文件并在弹窗粘入配置</h3>
        <p>在 iPhone QQ 点开文件选择「用其他应用打开 → 快捷指令」（或 Safari 下载后点开），点「设置此快捷指令」，依次粘入服务器地址和个人 Token。</p>
      </article>
      <article class="step-card">
        <p class="step-num">STEP 03</p>
        <h3>复制即识别 &amp; 放上桌面</h3>
        <p>把「桌面一键记一餐」添加到主屏幕。以后看到外卖清单或美食截图先「复制/拷贝」，点一下快捷指令，第一项就会自动识别剪贴板内容并入账。</p>
      </article>
    </div>
  </section>

  <section class="faq-section container" id="faq">
    <div class="section-heading">
      <div>
        <p class="section-kicker">03 / FAQ</p>
        <h2>常见问题</h2>
      </div>
    </div>
    <div class="faq-list">
      <details>
        <summary>下载的文件为什么打不开，或提示无法在非 Safari 浏览器导入？</summary>
        <p>无需安装任何电脑端或 macOS 应用。建议直接在 QQ 发 <code>/健康 同步</code>（私聊）或 <code>/健康 快捷指令</code> 接收 <code>.shortcut</code> 文件后，在 iPhone 上点「用其他应用打开 → 快捷指令」；若从网页下载，请点击右上角切换为 iPhone 自带 <b>Safari</b>，或下载到「文件」App 后点击导入。</p>
      </details>
      <details>
        <summary>运行时提示「TLS 错误导致安全连接失败」怎么解决？</summary>
        <p>说明快捷指令里填的服务器地址用了 <code>https://</code>，而当前服务端监听的是 <code>http://</code> 端口（例如 <code>http://你的IP:3080</code>）。在「快捷指令」App 点开对应指令右上角「…」，把最顶部第 1 格「文本」改回 <code>http://...</code> 即可（也可直接在 QQ 私聊发 <code>/健康 同步</code>，长按复制单独发给你的那条纯地址消息）。</p>
      </details>
      <details>
        <summary>安装时如果漏填了服务器地址或 Token，还能修改吗？</summary>
        <p>可以。在「快捷指令」App 里点开对应指令右上角「…」，把最顶部两个「文本」动作里的内容分别改成你的服务器地址（注意保留正确的 <code>http://</code> 或 <code>https://</code>）和个人同步 Token 即可，无需重装。</p>
      </details>
      <details>
        <summary>需要设置 iPhone 自动后台同步健康数据吗？</summary>
        <p>强烈建议为「同步 Apple 健康到 Bot」添加 2～3 个个人自动化（如每天 11:15、17:15、22:00 选择「立即运行」并关闭「运行时通知」）。这样 Bot 在午/晚饭前推送前就会拿到你当天的最新活动消耗并自动重算预算。</p>
      </details>
      <details>
        <summary>我的个人 Token 会不会泄露给服务器上的其他人？</summary>
        <p>不会。3 个 <code>.shortcut</code> 安装包均为空白模板（只含签名后的指令逻辑，不含任何密钥或私人地址）；Token 只通过 Apple 原生「导入提问」保存在你自己的 iPhone 本地。如果怀疑泄露，在 QQ 私聊发送 <code>/健康 同步 重置</code> 即可立刻作废旧 Token。</p>
      </details>
    </div>
  </section>
</main>

<footer class="site-footer container">
  <span>健康饮食管家 · Apple Shortcuts 安装中心 v${VERSION}</span>
  <span>安装包经 macOS Apple 签名认证 · 不含任何个人凭据</span>
  <a href="/tools/health/manifest.json">查看文件 SHA-256 校验清单</a>
</footer>

<script src="/tools/health/health.js"></script>
</body>
</html>
`;
}

/**
 * Serve the public Apple Shortcuts landing page, manifest, and signed .shortcut installers.
 */
export function healthToolResponse(path, method, { publicUrl = '' } = {}) {
  if (!path.startsWith('/tools/health') && !path.startsWith('/downloads/health-')) return null;
  const json = (status, value, extraHeaders = {}) => ({
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
    body: Buffer.from(JSON.stringify(value))
  });

  const shortcutRoutes = new Map(SHORTCUT_ITEMS.map(item => [`/downloads/${item.name}`, item]));
  const staticRoutes = new Set([
    '/tools/health',
    '/tools/health/',
    '/tools/health/health.css',
    '/tools/health/health.js',
    '/tools/health/manifest.json'
  ]);

  if (!staticRoutes.has(path) && !shortcutRoutes.has(path)) {
    return json(404, { error: '快捷指令资源不存在' });
  }
  if (!['GET', 'HEAD'].includes(method)) {
    return json(405, { error: '此地址只提供快捷指令与说明下载' }, { Allow: 'GET, HEAD' });
  }
  if (path === '/tools/health') {
    return { status: 302, headers: { Location: '/tools/health/' }, body: Buffer.alloc(0) };
  }

  if (path === '/tools/health/manifest.json') {
    const files = SHORTCUT_ITEMS.map(item => {
      const bytes = readShortcutBinary(item.name);
      return {
        name: item.name,
        title: item.title,
        url: `/downloads/${item.name}`,
        available: Boolean(bytes),
        bytes: bytes ? bytes.length : 0,
        sha256: bytes ? sha256(bytes) : null
      };
    });
    return json(200, { version: VERSION, files });
  }

  let body;
  let contentType;
  const extraHeaders = {};

  if (shortcutRoutes.has(path)) {
    const item = shortcutRoutes.get(path);
    const bytes = readShortcutBinary(item.name);
    if (!bytes) return json(503, { error: '快捷指令安装包尚未生成，请联系管理员' });
    body = bytes;
    contentType = 'application/octet-stream';
    extraHeaders['Content-Disposition'] = `attachment; filename="${item.name}"`;
  } else if (path === '/tools/health/') {
    body = Buffer.from(renderPage({ publicUrl }));
    contentType = 'text/html; charset=utf-8';
  } else if (path === '/tools/health/health.css') {
    body = readAsset('health.css');
    contentType = 'text/css; charset=utf-8';
  } else {
    body = readAsset('health.js');
    contentType = 'text/javascript; charset=utf-8';
  }

  return {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      ETag: `"${sha256(body)}"`,
      ...extraHeaders
    },
    body
  };
}

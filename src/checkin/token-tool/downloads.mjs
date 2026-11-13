import {readFileSync,lstatSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {downloadIcon as icon} from './download-icons.mjs';

const files = ['kuro_token.py','desktop.html','启动.bat','启动.command','kuro-token-ios.js','README.md'];
const escape = value => value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const file = name => readFileSync(new URL('./'+name,import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let zip;
function archive() {
  if (zip) return zip;
  const code = `import io,json,pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1]); stream=io.BytesIO()
with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as output:
 for name in json.loads(sys.argv[2]):
  data=(root/name).read_bytes()
  if len(data)>256*1024: raise ValueError('source too large')
  info=zipfile.ZipInfo('kuro-token-tool/'+name,(2026,10,23,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED
  info.create_system=3; info.external_attr=(0o100755 if name.endswith('.command') else 0o100644)<<16
  output.writestr(info,data)
sys.stdout.buffer.write(stream.getvalue())`;
  const result=spawnSync(process.env.LINK_PYTHON||'python3',['-I','-c',code,fileURLToPath(new URL('.',import.meta.url)),JSON.stringify(files)],{maxBuffer:1024*1024,timeout:10000});
  if(result.status!==0 || !result.stdout?.subarray(0,4).equals(Buffer.from('504b0304','hex'))) throw Error('工具下载包生成失败');
  zip=result.stdout; return zip;
}
function androidApk(path) {
  if(!path)return null;
  try {
    const stat=lstatSync(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size<4||stat.size>10*1024*1024)return null;
    const bytes=readFileSync(path);
    return bytes.subarray(0,4).equals(Buffer.from('504b0304','hex'))?bytes:null;
  } catch {return null;}
}
function page(androidReady) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#f6f7f2">
  <meta name="description" content="下载库街区 Token 工具，在安卓、电脑或 iOS 本机获取凭据，生成 QQ 私聊绑定命令。">
  <title>库街区 Token 工具下载</title>
  <link rel="stylesheet" href="/tools/kuro/download.css">
</head>
<body>
<a class="skip-link" href="#downloads">跳到工具下载</a>
<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="/tools/kuro/" aria-label="库街区工具首页"><span class="brand-mark" aria-hidden="true">${icon('link')}</span><span>库街区工具<small>账号绑定助手</small></span></a>
    <nav aria-label="页面导航"><a href="#downloads">下载工具</a><a href="#guide">使用指南</a><a href="#questions">常见问题</a></nav>
    <span class="version"><span></span>v1.1.0</span>
  </div>
</header>
<main>
  <section class="hero container" aria-labelledby="hero-title">
    <div class="hero-copy">
      <p class="eyebrow"><span class="status-dot"></span>更轻松地连接你的账号</p>
      <h1 id="hero-title">从登录到绑定，<br><span>只差一条指令。</span></h1>
      <p class="hero-description">选择适合你的设备，获取库街区 Token。<br>复制生成的命令，私聊机器人完成绑定。</p>
      <div class="hero-actions"><a class="button button-dark" href="#downloads">选择我的设备 ${icon('arrow-down')}</a><a class="text-link" href="#guide">查看使用指南 ${icon('arrow-up-right')}</a></div>
      <p class="hero-note">${icon('shield')}验证码直连库街区官方接口，下载页不接收账号数据。</p>
    </div>
    <div class="hero-art" aria-hidden="true">
      <div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div><div class="art-dot dot-one"></div><div class="art-dot dot-two"></div>
      <span class="art-caption">YOUR ACCOUNT. YOUR DEVICE.</span>
      <div class="preview-window">
        <div class="preview-toolbar"><span class="window-dots"><i></i><i></i><i></i></span><span>库街区 Token 工具</span><span class="preview-mini-icon">${icon('shield')}</span></div>
        <div class="preview-content"><span class="ready-icon">${icon('check')}</span><p class="preview-eyebrow">READY TO CONNECT</p><p class="preview-title">绑定命令已就绪</p><p class="preview-description">下一步，只需发送到机器人私聊。</p><div class="preview-command"><span>QQ / PRIVATE MESSAGE</span><code>/签到 绑定 库街区 {...}</code></div><span class="preview-copy">${icon('copy')}复制绑定命令</span></div>
      </div>
      <span class="floating-chip">${icon('device')}在本机处理<span class="chip-dot"></span></span>
      <span class="art-bottom-caption">01 获取<span>—</span>02 复制<span>—</span>03 绑定</span>
    </div>
  </section>

  <section class="downloads-section container" id="downloads" aria-labelledby="download-title">
    <div class="section-heading"><div><p class="section-kicker">01 / 工具下载</p><h2 id="download-title">为你的设备而准备</h2></div><p>一个目的，三种打开方式。</p></div>
    <div class="download-grid">
      <article class="download-card card-featured">
        <div class="card-top"><span class="platform-icon">${icon('android')}</span><span class="platform-tag">ANDROID</span></div>
        <h3>安卓 App</h3><p class="card-description">即装即用，直接在手机上获取。</p>
        <div class="platform-requirements"><span>Android 8.0+</span><span>原生应用</span></div>
        <p class="card-detail">无需 Python 或额外脚本 App。<br>获取、提取、复制，在手机上完成。</p>
        <div class="card-action">${androidReady?`<a class="button button-mint" href="/downloads/kuro-token-android.apk">下载安卓 APK ${icon('download')}</a>`:'<span class="button button-unavailable" aria-disabled="true">安装包暂未就绪</span>'}<p class="download-meta">${androidReady?'APK 安装包 · 版本 1.1.0':'安卓安装包尚未构建，请联系管理员。'}</p></div>
      </article>
      <article class="download-card">
        <div class="card-top"><span class="platform-icon">${icon('desktop')}</span><span class="platform-tag">DESKTOP</span></div>
        <h3>电脑本机版</h3><p class="card-description">在熟悉的浏览器中，完成本机操作。</p>
        <div class="platform-requirements"><span>Windows</span><span>macOS</span><span>Linux</span></div>
        <p class="card-detail">需要 Python 3.10+，无需 pip 安装依赖。<br>源码工具包，并非免安装 EXE。</p>
        <div class="card-action"><a class="button button-light" href="/downloads/kuro-token-tool.zip">下载电脑工具 ZIP ${icon('download')}</a><p class="download-meta">ZIP 源码包 · 版本 1.1.0</p></div>
      </article>
      <article class="download-card">
        <div class="card-top"><span class="platform-icon">${icon('phone')}</span><span class="platform-tag">iOS / iPadOS</span></div>
        <h3>iPhone 与 iPad</h3><p class="card-description">通过 Scriptable，轻松生成绑定命令。</p>
        <div class="platform-requirements"><span>iPhone</span><span>iPad</span></div>
        <p class="card-detail">先安装 <a href="https://scriptable.app/" target="_blank" rel="noreferrer">Scriptable ${icon('arrow-up-right')}</a>，再添加脚本。<br>无需安装抓包证书或描述文件。</p>
        <div class="card-action"><a class="button button-light" href="/downloads/kuro-token-ios.js">下载 iOS 脚本 ${icon('download')}</a><p class="download-meta">JavaScript 脚本 · 版本 1.1.0</p></div>
      </article>
    </div>
    <div class="feature-strip"><p>${icon('shield')}<span><strong>账号数据在本机处理</strong><small>获取时直连库街区官方 HTTPS</small></span></p><p>${icon('copy')}<span><strong>一条命令完成绑定</strong><small>复制后，只发送给机器人私聊</small></span></p><p>${icon('file')}<span><strong>已有响应也可提取</strong><small>本地解析，不额外请求网络</small></span></p></div>
  </section>

  <section class="guide-section container" id="guide" aria-labelledby="guide-title">
    <div class="guide-intro"><p class="section-kicker">02 / 使用指南</p><h2 id="guide-title">几步就能开始。</h2><p>按你的设备展开步骤，<br>从下载到绑定，一步一步来。</p><a class="text-link" href="/downloads/kuro-token-readme.txt">下载完整使用说明 ${icon('arrow-up-right')}</a><div class="guide-tip">${icon('message')}<p>需要完整账号绑定教程？<br>向机器人发送 <code>/签到 文档</code></p></div></div>
    <div class="guides">
      <details class="guide-item" id="android" open>
        <summary><span class="guide-device-icon">${icon('android')}</span><span><strong>安卓怎么用</strong><small>原生 App，安装后直接开始</small></span><span class="expand-icon">${icon('plus')}</span></summary>
        <div class="guide-body"><ol class="steps"><li><strong>下载并安装 App</strong><p>下载上方 APK，按系统提示允许当前浏览器安装此应用，再打开“库街区 Token 工具”。</p></li><li><strong>在官网手动领取短信</strong><p>点“打开库街区官网”，在浏览器中完成人机验证并领取短信。<b>收到后不要点官网登录</b>，返回工具 App。</p></li><li><strong>获取并生成命令</strong><p>输入同一手机号与验证码，勾选新登录提示，再点获取。新登录可能使库街区 App 的旧会话失效。</p></li><li><strong>复制，私聊，完成绑定</strong><p>点“复制绑定命令”，只粘贴到机器人的 QQ 私聊，等待“绑定成功”。</p></li></ol><p class="guide-footnote">已有 token 或 App 登录响应，也可直接在 App 下方离线提取。App 不读取短信、不保存凭据；复制后命令会进入系统剪贴板。</p></div>
      </details>
      <details class="guide-item" id="desktop">
        <summary><span class="guide-device-icon">${icon('desktop')}</span><span><strong>电脑怎么用</strong><small>Windows、macOS 与 Linux</small></span><span class="expand-icon">${icon('plus')}</span></summary>
        <div class="guide-body"><ol class="steps"><li><strong>准备 Python 并解压</strong><p>安装 Python 3.10+，解压整个 ZIP，不要只打开压缩包中的单个文件。</p></li><li><strong>启动本机工具</strong><p>Windows 双击 <code>启动.bat</code>；macOS / Linux 在解压目录执行 <code>python3 kuro_token.py</code>。浏览器会打开本机页面。</p></li><li><strong>领取短信后返回工具</strong><p>点“打开库街区官网”，手动完成人机验证并领取短信。<b>收到后不要点官网登录</b>，回本机工具输入同一手机号和验证码，确认新登录提示后获取。</p></li><li><strong>复制命令并私聊绑定</strong><p>将完整命令只发到机器人的 QQ 私聊，以“绑定成功”回执为准。退出时在终端按 Ctrl+C。</p></li></ol></div>
      </details>
      <details class="guide-item" id="ios">
        <summary><span class="guide-device-icon">${icon('phone')}</span><span><strong>iOS 怎么获取</strong><small>在 Scriptable 内运行本地脚本</small></span><span class="expand-icon">${icon('plus')}</span></summary>
        <div class="guide-body"><ol class="steps"><li><strong>安装 Scriptable 并添加脚本</strong><p>从 App Store 安装 <a href="https://scriptable.app/" target="_blank" rel="noreferrer">Scriptable</a>。在 Safari 下载 iOS 脚本，或展开下方源码，全选复制；在 Scriptable 点加号新建脚本，粘贴完整源码并保存。</p></li><li><strong>在 App 内运行脚本</strong><p>选择“用官网短信验证码获取”。不要在小组件里运行。</p></li><li><strong>领取短信并返回脚本</strong><p>在打开的官网手动完成人机验证并领取短信。<b>收到后不要点官网登录</b>，点“完成”回到工具。</p></li><li><strong>生成并复制绑定命令</strong><p>输入同一手机号和验证码，确认登录。成功后点“复制绑定命令”，到 QQ 私聊机器人粘贴。</p></li></ol><details class="source-code"><summary>完整 iOS 脚本源码 <span>可全选复制 ${icon('code')}</span></summary><p>复制文本框里的全部内容，再粘贴到 Scriptable 新脚本中。</p><textarea readonly aria-label="完整 iOS 脚本源码" spellcheck="false">${escape(file('kuro-token-ios.js').toString('utf8'))}</textarea></details></div>
      </details>
    </div>
  </section>

  <section class="questions-section container" id="questions" aria-labelledby="questions-title">
    <div class="section-heading"><div><p class="section-kicker">03 / 常见问题</p><h2 id="questions-title">开始之前，你可能想知道</h2></div><p>少一点摸索，多一点清晰。</p></div>
    <div class="faq-list">
      <details><summary>已经有 token，还需要重新登录吗？<span class="expand-icon">${icon('plus')}</span></summary><div><p>不需要。安卓和电脑工具可以直接粘贴自己的 App 登录响应 JSON 或原始 token；iOS 先复制自己的响应，再选“从剪贴板中的响应提取”。提取只在本地解析，不请求网络，也不验证登录是否仍有效，以机器人绑定回执为准。</p></div></details>
      <details><summary>验证码过期或获取被拦截，怎么办？<span class="expand-icon">${icon('plus')}</span></summary><div><p>回官网重新领取验证码，收到后不要先点官网登录。如果官网短信与 App 通道不再兼容，或被官方风控拦截，请停止重试，改用自己已取得的 App 登录响应。本工具不会自动发送短信或通过人机验证。</p></div></details>
      <details><summary>哪些内容不能当作库街区 App token？<span class="expand-icon">${icon('plus')}</span></summary><div><p>游戏 UID、抽卡记录链接、鸣潮游戏登录 token 和 refreshToken 都不能代替 App token。若自行通过 HTTPS 调试取得响应，只查看库街区 <code>api.kurobbs.com/user/sdkLogin</code> 的 <code>data.token</code> 或官方请求头中的 <code>token</code>。App 若禁止解密，则无法保证取得。</p></div></details>
      <details><summary>生成命令后，是不是就已经绑定成功？<span class="expand-icon">${icon('plus')}</span></summary><div><p>还需要把完整命令发送给机器人私聊，并等待“绑定成功”。不要把 token 或命令发到群里。登录和换设备可能使旧 token 失效，届时请重新获取并绑定。</p></div></details>
    </div>
  </section>

  <section class="closing-note container"><span class="closing-mark">${icon('link')}</span><div><h2>准备好，让账号连接起来。</h2><p>获取后发送 <code>/签到 绑定 库街区 {...}</code>，详细教程发送 <code>/签到 文档</code>。</p></div><a class="text-link" href="#downloads">返回工具下载 ${icon('arrow-up-right')}</a></section>
</main>
<footer class="site-footer container"><a class="footer-brand" href="/tools/kuro/">库街区 Token 工具<span>v1.1.0</span></a><p>工具在本机运行 · 下载页不接收账号凭据</p><a href="/tools/kuro/manifest.json">版本与 SHA256 校验值 ${icon('arrow-up-right')}</a></footer>
</body>
</html>
`;
}
export function tokenToolResponse(path,method,{androidApkPath}={}) {
  if(!path.startsWith('/tools/kuro') && !path.startsWith('/downloads/kuro-token-'))return null;
  const json=(status,value)=>({status,headers:{'Content-Type':'application/json; charset=utf-8'},body:Buffer.from(JSON.stringify(value))});
  const routes=new Set(['/tools/kuro','/tools/kuro/','/tools/kuro/download.css','/tools/kuro/manifest.json','/downloads/kuro-token-tool.zip','/downloads/kuro-token-ios.js','/downloads/kuro-token-readme.txt','/downloads/kuro-token-android.apk']);
  if(!routes.has(path))return json(404,{error:'下载资源不存在'});
  if(!['GET','HEAD'].includes(method))return {...json(405,{error:'此地址只提供下载，不接收账号信息'}),headers:{'Content-Type':'application/json; charset=utf-8',Allow:'GET, HEAD'}};
  if(path==='/tools/kuro')return {status:302,headers:{Location:'/tools/kuro/'},body:Buffer.alloc(0)};
  const apk=['/tools/kuro/','/tools/kuro/manifest.json','/downloads/kuro-token-android.apk'].includes(path)?androidApk(androidApkPath):null;
  if(path.endsWith('.apk')&&!apk)return json(503,{error:'安卓安装包尚未构建，请联系管理员'});
  if(path==='/tools/kuro/manifest.json') {
    const entries=[['kuro-token-tool.zip',archive()],['kuro-token-ios.js',file('kuro-token-ios.js')],['kuro-token-readme.txt',file('README.md')],...(apk?[['kuro-token-android.apk',apk]]:[])];
    return json(200,{version:'1.1.0',android:{available:Boolean(apk),minVersion:'8.0'},files:entries.map(([name,bytes])=>({name,url:'/downloads/'+name,bytes:bytes.length,sha256:sha(bytes)}))});
  }
  const body=path==='/tools/kuro/'?Buffer.from(page(Boolean(apk))):path.endsWith('.apk')?apk:path.endsWith('.css')?file('download.css'):path.endsWith('.zip')?archive():path.endsWith('.js')?file('kuro-token-ios.js'):file('README.md');
  const type=path.endsWith('.apk')?'application/vnd.android.package-archive':path.endsWith('.zip')?'application/zip':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.txt')?'text/plain; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8';
  const headers={'Content-Type':type,'Content-Length':String(body.length),ETag:'"'+sha(body)+'"'};
  if(path.startsWith('/downloads/'))headers['Content-Disposition']='attachment; filename="'+path.split('/').at(-1)+'"';
  return {status:200,headers,body};
}

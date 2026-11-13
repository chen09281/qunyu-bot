// 库街区 Token 工具 1.1.0 · 在 iOS Scriptable 中运行。
// 不读写文件或账号存储；手机号、验证码只发送到库街区官方 HTTPS 接口。
// 不自动发短信、不自动解验证码；复制按钮只在你确认后写入剪贴板。
const TOOL_VERSION = '1.1.0';
const KURO_LOGIN_URL = 'https://www.kurobbs.com/mc/home/';
function validateToken(value, name = 'token') {
  if (typeof value !== 'string' || value.length < 8 || value.length > 8192 || !/^[\x21-\x7e]+$/.test(value)) throw Error(name + '格式不正确，请复制完整值。');
  return value;
}
function extractCredential(raw, device) {
  if (typeof raw !== 'string' || raw.length > 24000) throw Error('请提供完整登录响应或原始 token，最多 24000 字符。');
  let outer, data; raw = raw.trim();
  if (raw.startsWith('{')) {
    try { outer = JSON.parse(raw); } catch { throw Error('JSON 不完整，请复制完整响应。'); }
    if (!outer || typeof outer !== 'object' || Array.isArray(outer)) throw Error('请提供 JSON 对象。');
    if (Object.prototype.hasOwnProperty.call(outer, 'code') && (outer.code !== 200 || outer.success === false)) throw Error('这是失败响应，没有可用 token。');
    data = outer.data && typeof outer.data === 'object' && !Array.isArray(outer.data) ? outer.data : outer;
  } else outer = data = {token:raw};
  const result = {token:validateToken(data.token)};
  if (data.userId !== undefined) {
    if (!['string','number'].includes(typeof data.userId) || !/^\d{1,30}$/.test(String(data.userId))) throw Error('userId 应为库街区社区用户 ID。');
    result.userId = String(data.userId);
  }
  const devCode = device || data.devCode || outer.devCode;
  if (devCode !== undefined) {
    if (typeof devCode !== 'string' || devCode.length > 256) throw Error('devCode 格式不正确。');
    result.devCode = validateToken(devCode, 'devCode');
  }
  return result;
}
function loginSpec(mobile, code, devCode, distinctId) {
  if (!/^1[3-9]\d{9}$/.test(mobile)) throw Error('请填写中国大陆手机号。');
  if (!/^\d{4,8}$/.test(code)) throw Error('请填写刚收到的短信验证码。');
  const fields = {mobile,code,devCode,gameList:''};
  return {url:'https://api.kurobbs.com/user/sdkLogin',headers:{
    'Content-Type':'application/x-www-form-urlencoded',devCode,distinct_id:distinctId,
    source:'android',version:'2.2.1',versionCode:'2210',osVersion:'Android',countryCode:'CN',model:'23127PN0CC',lang:'zh-Hans',channelId:'2','User-Agent':'okhttp/3.11.0',
  },body:Object.entries(fields).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&')};
}
function parseLoginResponse(data, device) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('官方响应格式异常。');
  if (data.code !== 200 || data.success === false) {
    if (data.code === -130) throw Error('验证码错误或已过期，请回官网重新领取；领取后不要先点官网登录。');
    if ([220,1034].includes(data.code)) throw Error('官方要求安全验证，请回官网手动完成验证；仍被拦截时改用已有响应提取。');
    throw Error('官方未完成登录。请检查验证码、网络，或改用已有响应提取。');
  }
  const result = extractCredential(JSON.stringify(data), device);
  if (!result.userId) throw Error('登录响应缺少社区用户 ID，已停止输出。');
  return result;
}
async function showMessage(title, message) {
  const alert = new Alert(); alert.title = title; alert.message = message; alert.addAction('好'); await alert.presentAlert();
}
async function runKuroTool() {
  const menu = new Alert(); menu.title = '库街区 Token 工具';
  menu.message = '短信方式可能使库街区 App 旧会话失效；已有 App 登录响应可直接提取。凭据只在本机处理。';
  menu.addAction('用官网短信验证码获取'); menu.addAction('从剪贴板中的响应提取'); menu.addCancelAction('取消');
  const mode = await menu.presentAlert(); if (mode < 0) return;
  let credential;
  if (mode === 1) {
    credential = extractCredential(Pasteboard.pasteString() || '');
  } else {
    const start = new Alert(); start.title = '先去官网领取验证码';
    start.message = '在官网打开登录，手动完成人机验证并领取短信。收到后不要点官网登录，点左上角完成回到本工具。';
    start.addAction('打开库街区官网'); start.addAction('已收到验证码'); start.addCancelAction('取消');
    const selected = await start.presentAlert(); if (selected < 0) return;
    if (selected === 0) await Safari.openInApp(KURO_LOGIN_URL, true);
    const form = new Alert(); form.title = '输入自己的手机号和验证码';
    form.message = '将直连库街区官方 HTTPS 接口；VPS 不接收这些内容。继续会创建新的 App 登录会话。';
    form.addTextField('中国大陆手机号'); form.addSecureTextField('短信验证码'); form.addAction('确认登录并获取'); form.addCancelAction('取消');
    if (await form.presentAlert() < 0) return;
    const mobile = form.textFieldValue(0).trim(), code = form.textFieldValue(1).trim();
    const devCode = UUID.string().replace(/-/g,''), spec = loginSpec(mobile,code,devCode,UUID.string());
    const request = new Request(spec.url); request.method = 'POST'; request.headers = spec.headers; request.body = spec.body;
    request.timeoutInterval = 20; request.allowInsecureRequest = false; request.onRedirect = () => null;
    let data;
    try { data = await request.loadJSON(); } catch { throw Error('无法连接官方接口或返回格式异常，请检查网络。'); }
    if (request.response?.statusCode !== 200) throw Error('官方接口限制访问或暂不可用，请稍后重试。');
    credential = parseLoginResponse(data,devCode);
  }
  const command = '/签到 绑定 库街区 ' + JSON.stringify(credential);
  const done = new Alert(); done.title = '绑定命令已生成';
  done.message = '复制后只发送到机器人的私聊。以机器人回复“绑定成功”为准；本工具不会保存凭据。';
  done.addAction('复制绑定命令'); done.addCancelAction('取消');
  if (await done.presentAlert() === 0) { Pasteboard.copyString(command); await showMessage('已复制', '现在可私聊机器人粘贴命令。请勿粘贴到群里。'); }
}
// Scriptable entry
try { await runKuroTool(); } catch (error) { await showMessage('未完成', error.message || '操作未完成，请稍后重试。'); }
Script.complete();

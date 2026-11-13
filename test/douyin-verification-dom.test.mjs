import test from 'node:test';
import assert from 'node:assert/strict';
import { DouyinBrowser, chromiumPath } from '../src/douyin-browser.mjs';

test('真实浏览器：身份验证只操作顶层弹窗，选择短信方式、填写和提交均不触碰背景登录表单', {
  skip: process.env.QQBOT_BROWSER_TEST !== '1' || !chromiumPath(), timeout: 20000,
}, async t => {
  const browser = new DouyinBrowser();
  t.after(() => browser.close());
  // The fixture stays offline; no platform account or real OTP is used.
  const call = browser.call.bind(browser);
  let ignoredMouseEvents = 0, ignoredTextEvents = 0;
  browser.call = (method, params, sessionId) => {
    // Reproduce the VPS failure: CDP acknowledges coordinate clicks without
    // delivering DOM mouse events. Named verification actions must still work.
    if (method === 'Input.dispatchMouseEvent') { ignoredMouseEvents++; return Promise.resolve({}); }
    if (method === 'Input.insertText') { ignoredTextEvents++; return Promise.resolve({}); }
    return call(method, method === 'Page.navigate' ? { url: 'about:blank' } : params, sessionId);
  };
  browser.waitQr = async () => {};
  await browser.start('', { login: true });
  const { frameTree } = await browser.call('Page.getFrameTree');
  await browser.call('Page.setDocumentContent', { frameId: frameTree.frame.id, html: `<!doctype html><html><body>
    <style>#background{position:absolute;left:920px;top:350px}#uc-second-verify{position:absolute;top:3000px;width:100%;height:0}#mask{position:fixed;inset:0;background:#0005}
    article{position:absolute;left:300px;top:200px;width:500px;height:400px;background:white;padding:20px}</style>
    <div id="background"><input id="other-code" placeholder="请输入验证码"><button onclick="window.wrong=true">获取验证码</button></div>
    <div id="uc-second-verify"><div id="mask"><article><h1>身份验证</h1>
      <div id="method" onclick="window.methodClicked=true;document.querySelector('#sms-form').hidden=false;this.hidden=true">接收短信验证码</div>
      <div id="sms-form" hidden><p>接收短信验证码</p><input id="identity-code" oninput="window.inputReceived=true" type="tel" maxlength="6" autocomplete="off">
        <button id="sms" onclick="window.smsClicked=true">获取验证码</button>
        <button id="submit" onclick="window.submitClicked=true">确认</button></div>
    </article></div></div></body></html>` });
  assert.equal(await browser.evaluate(`document.querySelector('#uc-second-verify').getBoundingClientRect().height`), 0);
  browser.state = 'verification_required';
  // Only the official-origin guard is substituted for an offline HTML fixture.
  browser.verificationViewport = async () => ({ width: 1280, height: 900 });
  await assert.rejects(browser.verificationInteract({ type: 'code', code: '123456' }), /未找到当前身份验证弹窗/);
  await assert.rejects(browser.verificationInteract({ type: 'sms' }), /官方可能已自动发送/);
  const selected = await browser.verificationInteract({ type: 'sms-method' });
  assert.match(selected.detail, /自动发送/);
  await browser.verificationInteract({ type: 'sms-method' }); // Idempotent after the form opens.
  await browser.verificationInteract({ type: 'sms' });
  await browser.evaluate(`document.querySelector('#other-code').focus()`);
  await browser.verificationInteract({ type: 'code', code: '123456' });
  await browser.verificationInteract({ type: 'submit' });
  assert.deepEqual(await browser.evaluate(`({method:window.methodClicked,sms:window.smsClicked,submit:window.submitClicked,
    backgroundUntouched:!window.wrong&&document.querySelector('#other-code').value==='',
    filled:document.querySelector('#identity-code').value==='123456',inputReceived:window.inputReceived===true})`),
  { method: true, sms: true, submit: true, backgroundUntouched: true, filled: true, inputReceived: true });
  assert.equal(ignoredMouseEvents, 0);
  assert.equal(ignoredTextEvents, 1);
  await browser.evaluate(`document.querySelector('#submit').classList.add('disabled-test');window.submitClicked=false`);
  await assert.rejects(browser.verificationInteract({ type: 'submit' }), /验证按钮尚不可用/);
  assert.equal(await browser.evaluate(`window.submitClicked`), false);
  // A DOM input still exists but is covered: reject it rather than accepting a
  // silent insertion into another field or claiming that filling succeeded.
  await browser.evaluate(`document.querySelector('#sms-form').hidden=true`);
  await assert.rejects(browser.verificationInteract({ type: 'code', code: '654321' }), /未找到当前身份验证弹窗/);
  await browser.evaluate(`const method=document.querySelector('#method');method.hidden=false;method.onclick=()=>{window.noopClicked=true}`);
  await assert.rejects(browser.verificationInteract({ type: 'sms-method' }), /尚未切换到短信输入框/);
  assert.equal(await browser.evaluate(`window.noopClicked`), true);
});

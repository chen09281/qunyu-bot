<script setup>
import { inject } from 'vue';
import { consoleKey } from '../composables/useConsole';
const c = inject(consoleKey);
</script>

<template>
  <div id="login-view" class="login-wrap">
    <form id="login-form" class="login-card" autocomplete="off" @submit.prevent="c.login">
      <img src="/favicon.svg" alt="" width="52" height="52"><span class="eyebrow">QUNYU / BOT CONSOLE</span>
      <h1>让每一次 @，<br>都有回应。</h1><p class="muted">登录群屿，管理你的 QQ 群聊助手。</p>
      <label v-if="!c.state.loginRequiresTotp">用户名<input id="login-username" v-model="c.state.loginUsername" type="text" autocomplete="off" required maxlength="64" placeholder="username" autofocus></label>
      <label v-if="!c.state.loginRequiresTotp">管理密码<input id="login-password" v-model="c.state.loginPassword" type="password" autocomplete="off" required placeholder="password" maxlength="256"></label>
      <label v-if="!c.state.loginRequiresTotp" class="remember-login"><input v-model="c.state.loginRemember" type="checkbox" name="rememberMe"><span>保持登录 30 天<small>保存此浏览器的登录状态，下次打开自动进入后台。共用设备可取消勾选。</small></span></label>
      <template v-else>
        <p class="muted">账号 {{ c.state.loginUsername }} 已开启两步验证，请输入身份验证器中的 6 位动态验证码或一次性恢复码。</p>
        <label>动态验证码 / 恢复码<input id="login-totp" v-model="c.state.loginTotpCode" type="text" inputmode="numeric" autocomplete="one-time-code" required maxlength="32" placeholder="6 位数字或恢复码" autofocus></label>
        <button class="text-button" type="button" @click="c.cancelTotpLogin">← 返回修改账号密码</button>
      </template>
      <p id="login-error" class="error-text" role="alert">{{ c.state.loginError }}</p>
      <button class="primary wide" type="submit" :disabled="c.state.busy.login">{{ c.state.busy.login ? '验证中…' : (c.state.loginRequiresTotp ? '完成登录' : '进入控制台') }} <span>↗</span></button>
      <div class="login-help">使用首次配置时创建的管理员账号。<br>忘记密码时，请由服务器管理员按维护文档重置。</div>
    </form><span class="login-footer">只在被需要时出现。 Powered by DeepSeek.</span>
  </div>
</template>

<style scoped>
.login-card .remember-login { display: flex; align-items: flex-start; gap: 10px; margin: 20px 0 8px; font-weight: 400; cursor: pointer; }
.remember-login input { flex: 0 0 17px; width: 17px; height: 17px; margin: 1px 0 0; padding: 0; accent-color: var(--green); }
.remember-login span { font-size: 12px; line-height: 1.6; }.remember-login small { margin-top: 6px; }
</style>

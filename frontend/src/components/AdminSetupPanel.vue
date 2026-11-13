<script setup>
import { inject } from 'vue';
import { consoleKey } from '../composables/useConsole';
const c = inject(consoleKey);
</script>

<template>
  <div id="admin-setup-view" class="login-wrap">
    <form class="login-card" autocomplete="off" @submit.prevent="c.createAdmin">
      <img src="/favicon.svg" alt="" width="52" height="52"><span class="eyebrow">WELCOME TO QUNYU</span>
      <h1>创建你的<br>管理员账号。</h1>
      <p class="muted">首次使用，请设置后台登录账号和密码。完成后继续配置 API Key 和 QQ 连接。</p>
      <label>登录账号<input id="setup-username" v-model="c.state.adminSetup.username" name="username" autocomplete="username" required minlength="3" maxlength="64" placeholder="设置登录账号" autofocus><small>3–64 个字符，支持文字、数字、下划线、点、@ 和短横线。</small></label>
      <label>登录密码<input id="setup-password" v-model="c.state.adminSetup.password" type="password" name="password" autocomplete="new-password" required minlength="8" maxlength="256" placeholder="至少 8 个字符"></label>
      <label>确认密码<input id="setup-confirm" v-model="c.state.adminSetup.confirmPassword" type="password" name="confirmPassword" autocomplete="new-password" required minlength="8" maxlength="256" placeholder="再次输入密码"></label>
      <p class="error-text" role="alert">{{ c.state.adminSetupError }}</p>
      <button class="primary wide" type="submit" :disabled="c.state.busy.adminSetup">{{ c.state.busy.adminSetup ? '正在创建…' : '创建账号并继续' }}<span>↗</span></button>
      <div class="login-help">账号仅在首次使用时创建，设置会保存在当前服务的数据目录中。</div>
    </form>
    <span class="login-footer">群屿 · QQ Bot 控制台</span>
  </div>
</template>

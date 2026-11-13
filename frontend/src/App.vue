<script setup>
import { nextTick, provide, ref, watch } from 'vue';
import { consoleKey, pageNames, useConsole } from './composables/useConsole';
import AdminSetupPanel from './components/AdminSetupPanel.vue';
import LoginPanel from './components/LoginPanel.vue';
import OverviewPanel from './components/OverviewPanel.vue';
import ConnectionPanel from './components/ConnectionPanel.vue';
import ModelPanel from './components/ModelPanel.vue';
import TavernPanel from './components/TavernPanel.vue';
import WhitelistPanel from './components/WhitelistPanel.vue';
import LiveTasksPanel from './components/LiveTasksPanel.vue';
import LogsPanel from './components/LogsPanel.vue';
import ChatsPanel from './components/ChatsPanel.vue';
import SecurityPanel from './components/SecurityPanel.vue';
import PluginsPanel from './components/PluginsPanel.vue';
import WorkspaceIcon from './components/WorkspaceIcon.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';

const c = useConsole();
provide(consoleKey, c);
const menuOpen = ref(false), menuButton = ref(null);
function closeMenu(restoreFocus = false) {
  menuOpen.value = false;
  if (restoreFocus) nextTick(() => menuButton.value?.focus());
}
function navigate(page) {
  c.navigate(page);
  closeMenu(menuOpen.value);
}
watch(() => [c.state.page, c.state.authenticated], () => closeMenu());
const pluginNames = { music: '音乐点播', links: '链接解析', checkin: '每日签到', subscriptions: '订阅推送', 'scheduled-chat': '定时聊天', 'game-calendar': '游戏兑换码与日历', fun: '群聊娱乐工坊', tavern: '酒馆 (SillyTavern)' };
const navigation = ['overview', 'connection', 'model', 'tavern', 'live', 'whitelist', 'plugins', 'chats', 'logs'];
</script>

<template>
  <div v-if="!c.state.ready" class="login-wrap" role="status">正在载入控制台…</div>
  <AdminSetupPanel v-else-if="c.state.adminSetupRequired" />
  <LoginPanel v-else-if="!c.state.authenticated" />
  <div v-else id="app-view" class="shell">
    <aside class="sidebar" :class="{ 'menu-open': menuOpen }" @keydown.esc="closeMenu(true)">
      <div class="sidebar-heading">
        <a class="brand" href="/#overview"><img src="/favicon.svg" alt="" width="40" height="40"><span>群屿 <small>QQ BOT CONSOLE</small></span></a>
        <button ref="menuButton" class="mobile-menu secondary" type="button" :aria-expanded="menuOpen" aria-controls="workspace-navigation" @click="menuOpen = !menuOpen"><WorkspaceIcon :name="menuOpen ? 'close' : 'menu'" />{{ menuOpen ? '收起' : '菜单' }}</button>
      </div>
      <div id="workspace-navigation" class="workspace-navigation">
        <button class="workspace-status" @click="navigate('overview')"><span class="workspace-status-dot" :class="{ running: c.state.config.enabled }"></span><span><b>{{ c.state.config.enabled ? '机器人已启用' : '机器人已暂停' }}</b><small>{{ c.state.config.enabled ? '响应已授权的群聊与私聊' : '前往概览，准备下一次回应' }}</small></span><WorkspaceIcon name="arrow" /></button>
        <div class="nav-label">工作空间</div>
        <nav aria-label="主导航">
          <button v-for="page in navigation" :key="page" class="nav-item" :class="{ active: c.state.page === page }" :aria-current="c.state.page === page ? 'page' : undefined" @click="navigate(page)">
            <WorkspaceIcon :name="page" />{{ pageNames[page] }}<span v-if="c.state.page === page" class="nav-active-mark" aria-hidden="true"></span>
          </button>
        </nav>
        <div class="sidebar-bottom">
          <div class="mini-note"><span class="dot"></span> 独立部署 · 数据自持</div>
          <button class="nav-item" :class="{ active: c.state.page === 'security' }" @click="navigate('security')"><WorkspaceIcon name="security" />账号安全</button>
          <button id="logout" class="nav-item" :disabled="c.state.busy.logout" @click="c.logout"><WorkspaceIcon name="logout" />退出登录</button>
        </div>
      </div>
    </aside>
    <main>
      <header class="topbar"><div class="breadcrumbs"><span class="breadcrumb">工作空间</span><span class="slash">/</span><button v-if="c.state.pluginDetail" class="breadcrumb-link" @click="navigate('plugins')">插件</button><span v-else class="current-page">{{ c.pageTitle }}</span><template v-if="c.state.pluginDetail"><span class="slash">/</span><span class="current-page">{{ pluginNames[c.state.pluginDetail] }}</span></template></div><div class="topbar-right"><button class="connection-pill" :class="{ online: c.state.napcat?.qq?.state === 'online' }" :title="c.state.napcat?.qq?.detail" @click="c.navigate('connection')"><span class="connection-indicator" aria-hidden="true"></span>{{ c.state.napcat?.qq?.label || '正在检测 QQ' }}</button><span class="refresh-status">{{ c.state.refreshMessage }}</span><button class="account-button" aria-label="管理账号安全" @click="c.navigate('security')"><span class="avatar">{{ Array.from(c.state.adminUsername || '管')[0].toUpperCase() }}</span><span>{{ c.state.adminUsername || '管理员' }}<small>管理员</small></span></button></div></header>
      <div class="content">
        <OverviewPanel v-if="c.state.page === 'overview'" />
        <ConnectionPanel v-else-if="c.state.page === 'connection'" />
        <ModelPanel v-else-if="c.state.page === 'model'" />
        <TavernPanel v-else-if="c.state.page === 'tavern'" />
        <WhitelistPanel v-else-if="c.state.page === 'whitelist'" />
        <LiveTasksPanel v-else-if="c.state.page === 'live'" />
        <PluginsPanel v-else-if="c.state.page === 'plugins'" />
        <LogsPanel v-else-if="c.state.page === 'logs'" />
        <ChatsPanel v-else-if="c.state.page === 'chats'" />
        <SecurityPanel v-else-if="c.state.page === 'security'" />
      </div>
      <footer><b>群屿</b><span>·</span>少一点打扰，多一点帮助。<span class="footer-right">QUNYU WORKSPACE</span></footer>
    </main>
  </div>
  <div v-if="c.state.toast" id="toast" class="toast" :class="{ error: c.state.toast.error }" role="status">{{ c.state.toast.message }}</div>
  <ConfirmDialog v-if="c.state.confirmation" />
</template>

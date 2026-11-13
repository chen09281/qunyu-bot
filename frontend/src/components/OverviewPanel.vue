<script setup>
import { inject } from 'vue';
import { consoleKey, timeText } from '../composables/useConsole';
import WorkspaceIcon from './WorkspaceIcon.vue';
import AemeathArtwork from './AemeathArtwork.vue';
import ServerStatusPanel from './ServerStatusPanel.vue';
import HealthCenterPanel from './HealthCenterPanel.vue';
const c = inject(consoleKey);
const stats = [{ key: 'triggered', title: '收到的模型请求', icon: 'chats', note: '通过规则筛选的请求' }, { key: 'replied', title: '成功回复', icon: 'check', note: '已发送到 QQ 会话' }, { key: 'failed', title: '回复失败', icon: 'alert', note: '详情可在运行日志查看' }, { key: 'tokens', title: 'Token 用量', icon: 'model', note: '群聊、私聊与连接测试返回的用量' }];
const shortCost = value => {
  const num = Math.max(0, Number(value) || 0);
  if (num === 0) return '0.00';
  if (num < 0.01) return num.toFixed(4);
  return (Math.floor((num + 1e-9) * 100) / 100).toFixed(2);
};
</script>

<template>
  <section id="page-overview" class="page">
    <div class="page-heading"><div><span class="eyebrow">WELCOME TO YOUR LITTLE WORLD</span><h1>今天也请多多指教<span class="title-dot">.</span></h1><p class="muted">群聊、私聊与连接状态，一眼掌握。</p></div><button class="secondary" @click="c.refresh"><WorkspaceIcon name="refresh" />刷新状态</button></div>
    <div v-if="!c.state.config.modelApiKeyConfigured" class="callout"><b>模型尚未配置</b><p>可先使用 QQ 连接、链接解析、签到与订阅。需要模型聊天时，再绑定 API 密钥。</p><button type="button" class="text-button" @click="c.navigate('model')">配置模型与密钥 ↗</button></div>
    <div class="hero card">
      <div class="hero-copy"><span id="bot-pill" class="pill" :class="{ on: c.state.config.enabled }"><span></span>{{ c.state.config.enabled ? '机器人已启用' : '机器人已暂停' }}</span><h2>{{ c.heroTitle }}</h2><p>{{ c.heroDescription }}</p><div class="hero-actions"><button id="toggle-bot" class="primary" :disabled="c.state.busy.toggle" @click="c.toggle"><WorkspaceIcon :name="c.state.config.enabled ? 'pause' : 'power'" />{{ c.state.busy.toggle ? '处理中…' : c.state.config.enabled ? '暂停机器人' : '启用机器人' }}</button><button class="text-button" @click="c.navigate('connection')">查看连接配置<WorkspaceIcon name="arrow" /></button></div></div>
      <div class="hero-visual" aria-hidden="true"><AemeathArtwork /><span class="mascot-caption">爱弥斯 · 长航的星辉</span></div>
      <div class="hero-summary"><div><span>聊天回复模型</span><b>{{ c.state.config.activeModel || '尚未配置' }}</b></div><button @click="c.navigate('groups')"><span>授权群聊</span><b>{{ c.state.config.allowedGroups?.length || 0 }} 个群<WorkspaceIcon name="arrow" /></b></button><div><span>独立聊天记忆</span><b>{{ c.state.config.memoryEnabled ? '已开启' : '已关闭' }}</b></div></div>
    </div>
    <div class="stats-grid"><article v-for="item in stats" :key="item.key" class="card stat"><span>{{ item.title }} <b><WorkspaceIcon :name="item.icon" /></b></span><strong>{{ Number((item.key === 'tokens' ? (c.state.status.totalTokensPersisted ?? c.state.status.tokens) : c.state.status[item.key]) || 0).toLocaleString() }}</strong><small v-if="item.key === 'tokens'">API 账单 ¥{{ Number(c.state.status.billingCost ?? c.state.status.totalCost ?? 0).toFixed(2) }}<template v-if="c.state.status.billingCostUSD ?? c.state.status.totalCostUSD"> + US${{ Number(c.state.status.billingCostUSD ?? c.state.status.totalCostUSD).toFixed(2) }}</template> · <button type="button" class="text-button inline-link-btn" @click="c.navigate('model/usage')">API 账单 ↗</button></small><small v-else>{{ item.note }}</small></article></div>
    <ServerStatusPanel />
    <HealthCenterPanel />
    <div class="two-columns overview-bottom">
      <article class="card panel"><div class="panel-heading"><h2>连接状态</h2><span class="subtle-tag">HTTP / OneBot v11</span></div>
        <div class="connection-row"><span class="service-icon qq">Q</span><div><b>{{ c.state.napcat?.account?.nickname || 'QQ 账号' }}</b><small>{{ c.state.napcat?.account?.userId ? `QQ ${c.state.napcat.account.userId}` : '登录后显示 QQ 号与昵称' }}</small></div><span class="status-label" :class="{ ready: c.state.napcat?.qq?.state === 'online' }">{{ c.state.napcat?.qq?.label || '正在检查…' }}</span></div>
        <div class="connection-row"><span class="service-icon qq">N</span><div><b>NapCat / OneBot</b><small>{{ c.state.napcat?.webui?.authenticated ? '管理接口已连接' : c.state.napcat?.webui?.recovering ? '管理接口正在重启' : '管理接口未连接' }} · {{ c.state.napcat?.onebot?.reachable ? '消息接口已连接' : '消息接口未连接' }}</small></div><button class="text-button" @click="c.navigate('connection')">管理 ↗</button></div>
        <div class="connection-row"><span class="service-icon ds">{{ ({ openai: 'O', kimi: 'K', deepseek: 'D' })[c.state.config.activeProvider || c.state.config.apiProvider] }}</span><div><b>{{ ({ openai: 'OpenAI API', kimi: 'Kimi API', deepseek: 'DeepSeek API' })[c.state.config.activeProvider || c.state.config.apiProvider] }}</b><small>{{ c.state.config.activeModel || '—' }}</small></div><span class="status-label" :class="{ ready: c.state.config.modelApiKeyConfigured }">{{ c.state.config.modelApiKeyConfigured ? '密钥已配置' : '未配置' }}</span></div>
        <div class="panel-foot"><span>{{ c.state.status.active || 0 }} 个处理中 · {{ c.state.status.queued || 0 }} 个排队中</span><span>运行 {{ c.uptime }} 分钟</span></div>
      </article>
      <article class="card panel"><div class="panel-heading"><h2>最近动态</h2><button class="text-button" @click="c.navigate('logs')">全部日志 ↗</button></div><div class="recent-logs"><div v-if="!c.recentLogs.length" class="empty">暂无运行记录<br><small>连接成功后，在授权群 @ 或通过白名单私聊提问</small></div><div v-for="log in c.recentLogs" :key="log.id" class="recent-item"><span class="log-dot" :class="log.level"></span><p>{{ log.message }}</p><time>{{ timeText(log.time) }}</time></div></div></article>
    </div>
    <p class="footnote">统计与日志从本次服务启动开始计算。{{ c.state.status.lastEventAt ? `最近事件上报 ${timeText(c.state.status.lastEventAt)}。` : '尚未收到事件上报。' }}私聊与各群聊天记忆按提问者隔离；链接解析单独统计，不写入模型聊天记忆。</p>
  </section>
</template>

<style scoped>
.inline-link-btn { padding: 0; min-height: auto; font-size: inherit; }
</style>

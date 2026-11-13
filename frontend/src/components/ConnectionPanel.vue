<script setup>
import { inject } from 'vue';
import { consoleKey } from '../composables/useConsole';
import OperationsPanel from './OperationsPanel.vue';
import NapcatPanel from './NapcatPanel.vue';
const c = inject(consoleKey);
</script>

<template>
  <section id="page-connection" class="page">
    <div class="page-heading"><div><span class="eyebrow">CONNECT YOUR QQ</span><h1>把助手带进群聊<span class="title-dot">.</span></h1><p class="muted">管理 NapCat、扫码登录 QQ，实时查看账号状态。</p></div></div>
    <NapcatPanel />
    <OperationsPanel />
    <div class="two-columns settings-columns">
      <form @submit.prevent="c.saveConnection" id="connection-form" class="card panel form-panel"><div class="panel-heading"><h2>NapCat 管理连接</h2><span class="subtle-tag">扫码登录与账号状态</span></div>
        <label>NapCat WebUI 地址<input v-model="c.state.connection.napcatUrl" name="napcatUrl" type="url" required placeholder="http://127.0.0.1:6099"><small>填写管理接口基础地址，不要附加 /webui 或 /api。一体化 Docker 部署会自动配置。</small></label>
        <label>NapCat WebUI Token<input v-model="c.state.connection.napcatToken" name="napcatToken" type="password" autocomplete="new-password" placeholder="留空保持已保存的 Token"><small>{{ c.state.config.napcatTokenConfigured ? '已保存 Token；仅由后端用于连接 NapCat。' : '一体化部署自动生成；接入已有 NapCat 时填写 WebUI Token。' }}</small></label>
        <div class="panel-heading connection-divider"><h2>OneBot 消息连接</h2><span class="subtle-tag">发送群消息</span></div>
        <label>NapCat HTTP 服务端地址<input v-model="c.state.connection.onebotUrl" name="onebotUrl" type="url" required placeholder="http://127.0.0.1:3000"><small>这是 OneBot API 地址，不是 NapCat 的 6099 管理页面。</small></label>
        <label>OneBot Access Token<input v-model="c.state.connection.onebotToken" name="onebotToken" type="password" autocomplete="new-password" placeholder="留空保持现有密钥"><small id="onebot-key-state">{{ c.state.config.onebotTokenConfigured ? '已保存密钥，留空保持不变。' : '尚未保存 Token，请与 NapCat HTTP 服务端保持一致。' }}</small></label>
        <label>机器人 QQ 号 <span class="optional">可选</span><input v-model="c.state.connection.botId" name="botId" inputmode="numeric" pattern="[0-9]{5,20}" placeholder="默认从上报事件 self_id 自动识别"><small>填写后，只处理这个 QQ 号的事件。</small></label>
        <div class="form-actions"><button class="primary" type="submit" :disabled="c.state.busy.connection">{{ c.state.busy.connection ? '保存中…' : '保存连接' }}</button><button id="test-onebot" @click="c.testOnebot" :disabled="c.state.busy.onebotTest" type="button" class="secondary">测试已保存的连接</button></div><p id="onebot-result" class="result-text" :class="{ 'error-text': c.state.onebotError }" role="status">{{ c.state.onebotResult }}</p>
      </form>
      <article class="card panel form-panel"><div class="panel-heading"><h2>事件上报</h2><span class="subtle-tag">02 / 接收消息</span></div>
        <p class="muted intro">在 NapCat 网络配置中添加「HTTP 客户端」，将群消息推送到这里。</p>
        <label>上报地址<input id="webhook-url" :value="c.webhookUrl" readonly aria-label="事件上报地址"><small>地址必须能被 NapCat 访问。跨设备或 Docker 部署请参照下方说明替换主机地址。</small></label>
        <label>上报 Token<div class="input-action"><input id="webhook-token" :value="c.state.webhookToken" :type="c.state.webhookToken ? 'text' : 'password'" readonly placeholder="点击查看并复制"><button id="reveal-token" @click="c.revealToken" :disabled="c.state.busy.reveal" class="secondary" type="button">查看</button></div><small>填入 NapCat「HTTP 客户端」的 Token 字段。</small></label>
        <div class="callout"><b>建议的上报设置</b><p>消息格式：array<br>上报自身消息：关闭<br>保存时启用：开启</p></div>
      </article>
    </div>
    <article class="card panel guide"><div class="panel-heading"><h2>一体化部署与登录</h2><a href="https://napneko.github.io/config/basic" target="_blank" rel="noreferrer">NapCat 配置文档 ↗</a></div><div class="steps"><div><span>1</span><b>启动 Docker 一体化服务</b><p>先安装并启动 <a href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noreferrer">Docker Desktop</a>，在项目目录运行 <code>npm run deploy</code>。会自动接管本机后台、生成密钥并连接 NapCat。</p></div><div><span>2</span><b>在这里扫码登录</b><p>点击「获取二维码」，用手机 QQ 扫码确认。登录成功后自动显示 QQ 号、昵称与在线状态。</p></div><div><span>3</span><b>填密钥，启用并 @</b><p>保存 DeepSeek API Key，在概览启用机器人。下次继续使用时无需再执行 npm start。</p></div></div><div class="callout neutral"><b>接入已有 NapCat</b><p>填写可达的 WebUI 地址与 Token，管理接口一般为 6099，OneBot API 一般为 3000。它们使用独立 Token。一体化部署会自动处理服务地址、消息上报和 Token 配对。</p></div></article>
  </section>
</template>

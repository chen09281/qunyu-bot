<script setup>
import { computed, inject, nextTick, ref, watch } from 'vue';
import { consoleKey } from '../composables/useConsole';
import { chatTime, chatDateTime, chatTimeline } from '../utils/chatTimeline';
const c = inject(consoleKey), messages = ref(null);
const mobileChatOpen = ref(false), backButton = ref(null), selectedButton = ref(null);
async function openConversation(item, event) {
  selectedButton.value = event.currentTarget;
  mobileChatOpen.value = true;
  const request = c.selectConversation(item);
  await nextTick();
  if (window.matchMedia('(max-width: 800px)').matches) backButton.value?.focus();
  await request;
}
async function backToList() {
  mobileChatOpen.value = false;
  await nextTick(); selectedButton.value?.focus();
}
const session = computed(() => c.state.conversation?.session);
const turns = computed(() => c.state.conversation?.turns || []);
const timeline = computed(() => chatTimeline(turns.value));
const members = computed(() => c.state.conversation?.members || []);
const memberId = ref('');
const selectedMember = computed(() => members.value.find(member => member.id === memberId.value));
watch(members, value => {
  if (!value.some(member => member.id === memberId.value)) memberId.value = turns.value.at(-1)?.conversationId || value[0]?.id || '';
});
const labels = { generating: '正在生成回复…', sending: '正在发送…', sent: '已发送', cancelled: '已取消，未发送',
  skipped: '本次保持安静，未发送', failed: '调用失败', send_failed: '发送失败或未确认', interrupted: '服务中断，发送结果未确认' };
const isPrivate = item => item?.groupId === 'private';
const typeClass = item => isPrivate(item) ? 'private-chat' : 'group-chat';
const title = item => isPrivate(item) ? item.userName || item.userId : `群 ${item.groupId}`;
const author = turn => turn.userName || turn.userId;
watch(() => [c.state.conversationId, timeline.value.at(-1)?.key, timeline.value.at(-1)?.at, timeline.value.at(-1)?.turn.status], async (value, old) => {
  const panel = messages.value;
  const shouldScroll = value[0] !== old?.[0] || !panel || panel.scrollHeight - panel.scrollTop - panel.clientHeight < 120;
  await nextTick(); if (shouldScroll && messages.value) messages.value.scrollTop = messages.value.scrollHeight;
});
async function older() {
  const panel = messages.value, height = panel?.scrollHeight || 0, top = panel?.scrollTop || 0;
  await c.loadConversation(true); await nextTick();
  if (panel) panel.scrollTop = top + panel.scrollHeight - height;
}
</script>

<template>
  <section id="page-chats" class="page">
    <div class="page-heading"><div><span class="eyebrow">EVERY CONVERSATION MATTERS</span><h1>记得上一次，也接住下一句<span class="title-dot">.</span></h1><p class="muted">同一群的对话汇总在一个窗口，私聊按好友查看。时间统一显示为北京时间，记录重启后仍保留。</p></div></div>
    <div class="card chats-layout" :class="{ 'mobile-chat-open': mobileChatOpen }">
      <aside class="chat-sidebar" aria-label="群聊与私聊列表">
        <form class="chat-search" @submit.prevent="c.searchConversations()"><label for="chat-search">查找群聊或好友</label><div><input id="chat-search" v-model="c.state.chatSearch" maxlength="80" placeholder="群号、成员昵称或 QQ"><button class="secondary" type="submit">查找</button></div></form>
        <div class="chat-legend"><span class="group-chat scope-badge">群聊</span><span class="private-chat scope-badge">私聊</span><span>共 {{ c.state.conversationsTotal }} 个会话</span></div>
        <details class="chat-prune-box">
          <summary>清理历史记录 ▾</summary>
          <form class="chat-prune-form" @submit.prevent="c.pruneConversations">
            <label>清理方式
              <select v-model="c.state.chatPrune.mode">
                <option value="days">清理 N 天前的消息</option>
                <option value="group">按群号删除全部记录</option>
                <option value="user">按 QQ 号删除全部记录</option>
              </select>
            </label>
            <label v-if="c.state.chatPrune.mode === 'days'">保留最近天数<input v-model="c.state.chatPrune.days" type="number" min="1" max="3650" required placeholder="例如 30"></label>
            <label v-else-if="c.state.chatPrune.mode === 'group'">群号<input v-model="c.state.chatPrune.groupId" maxlength="20" required placeholder="5–20 位群号或 private"></label>
            <label v-else>QQ 号<input v-model="c.state.chatPrune.userId" maxlength="20" required placeholder="5–20 位 QQ 号"></label>
            <button class="secondary danger-btn" type="submit" :disabled="c.state.busy.chatPrune">{{ c.state.busy.chatPrune ? '清理中…' : '执行清理' }}</button>
          </form>
        </details>
        <p v-if="c.state.chatListError" class="chat-error" role="alert">{{ c.state.chatListError }}</p>
        <div class="session-list">
          <button v-for="item in c.state.conversations" :key="item.id" class="session-item" :class="[typeClass(item), { selected: c.state.conversationId === item.id }]" :aria-pressed="c.state.conversationId === item.id" @click="openConversation(item, $event)">
            <span class="session-avatar">{{ isPrivate(item) ? (item.userName || item.userId).slice(0, 1) : '群' }}</span>
            <span class="session-copy"><strong>{{ title(item) }}</strong><small><span class="scope-badge">{{ isPrivate(item) ? '私聊' : '群聊' }}</span> {{ isPrivate(item) ? `QQ ${item.userId}` : `${item.memberCount} 位提问者` }}</small><span>{{ isPrivate(item) ? '' : `${item.lastUserName || item.lastUserId}：` }}{{ item.lastMessage }}</span><time :datetime="chatDateTime(item.updatedAt)" title="最近提问 · 北京时间">{{ chatTime(item.updatedAt) }}</time></span>
          </button>
          <p v-if="!c.state.conversations.length" class="empty">{{ c.state.conversationListLoading ? '正在加载…' : '暂无会话，授权群内 @ 或白名单私聊后会自动创建。' }}</p>
          <button v-if="c.state.conversationsHasMore" class="text-button more-sessions" :disabled="c.state.conversationListLoading" @click="c.loadConversations(true)">加载更多会话</button>
        </div>
      </aside>
      <div class="chat-main" :class="typeClass(session)">
        <button ref="backButton" type="button" class="chat-back text-button" @click="backToList">← 返回会话列表</button>
        <template v-if="session">
          <header class="chat-header"><div><span class="scope-badge">{{ isPrivate(session) ? '私聊' : '群聊' }}</span><h2>{{ title(session) }}</h2><p>{{ isPrivate(session) ? `QQ ${session.userId}` : `${session.memberCount} 位提问者 · 全群对话` }} · 机器人 {{ session.botId }}<br>北京时间 · UTC+8</p></div>
            <div class="topic-actions"><label v-if="!isPrivate(session)" for="chat-member">为成员开启新话题<select id="chat-member" v-model="memberId"><option v-for="member in members" :key="member.id" :value="member.id">{{ member.userName || member.userId }} · {{ member.userId }}</option></select></label><div class="topic-buttons"><button class="secondary" :disabled="c.state.busy.chatReset || !selectedMember" title="仅重置所选成员在当前会话的上下文，保留历史记录" @click="c.resetConversation(memberId)">新话题 ↗</button><button class="secondary danger-btn" type="button" :disabled="c.state.busy.chatDelete" title="彻底删除当前会话的所有历史消息" @click="c.deleteConversation(session)">删除会话</button></div></div>
          </header>
          <p v-if="c.state.chatError" class="chat-error" role="alert">{{ c.state.chatError }}</p>
          <div ref="messages" class="chat-messages" aria-label="当前会话聊天记录">
            <button v-if="c.state.conversation.hasMore" class="text-button older-messages" :disabled="c.state.chatLoading" @click="older">查看更早的消息</button>
            <template v-for="message in timeline" :key="message.key">
              <article v-if="message.kind === 'user'" class="chat-message user-message"><div class="bubble-label"><b>{{ author(message.turn) }}</b><span>QQ {{ message.turn.userId }}</span><span v-if="message.turn.epoch > 0">话题 {{ message.turn.epoch + 1 }}</span><time :datetime="chatDateTime(message.at)">{{ chatTime(message.at) }}</time></div><div class="chat-bubble">{{ message.turn.prompt }}</div></article>
              <article v-else class="chat-message bot-message"><div class="bubble-label"><b>群屿</b><span>{{ message.turn.model }}</span><time :datetime="chatDateTime(message.at)">{{ chatTime(message.at) }}</time></div><p v-if="!isPrivate(session)" class="reply-target">回复 {{ author(message.turn) }} · {{ message.turn.userId }}</p><div v-if="message.turn.reply" class="chat-bubble">{{ message.turn.reply }}</div><p v-else class="reply-placeholder">{{ labels[message.turn.status] || '暂无回复' }}</p><small class="turn-status" :class="{ failed: ['failed', 'send_failed', 'interrupted'].includes(message.turn.status) }">{{ labels[message.turn.status] || message.turn.status }}<template v-if="message.turn.tokens != null"> · {{ message.turn.tokens }} Tokens</template><template v-if="message.turn.error"> · {{ message.turn.error }}</template></small></article>
            </template>
            <p v-if="selectedMember && selectedMember.epoch > (selectedMember.lastTurnEpoch ?? -1)" class="topic-separator">{{ selectedMember.userName || selectedMember.userId }} 的新话题已开启，等待下一次提问。历史记录仍保留。</p>
          </div>
          <div class="chat-footer">{{ isPrivate(session) ? '请私聊机器人继续对话。' : '群聊汇总展示，每位成员的模型记忆仍独立。' }}{{ c.state.config.memoryEnabled ? `每人最多携带最近 ${c.state.config.contextTurns} 轮成功对话，上下文总长不超过 24,000 字符。` : '当前已关闭上下文携带，聊天记录继续保存。' }}</div>
        </template>
        <div v-else class="chat-welcome"><span>☏</span><h2>{{ c.state.chatLoading ? '正在打开会话…' : '选择一个群聊或私聊' }}</h2><p>{{ c.state.chatError || '从左侧选择会话，按时间查看成员提问和机器人回复。' }}</p><small>蓝色代表群聊，紫色代表私聊。</small></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat-back { display: none; }
.chats-layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); min-height: 620px; overflow: hidden; }
.chat-sidebar { border-right: 1px solid var(--line); background: #f8faff; }
.chat-search { padding: 22px 18px 10px; }
.chat-search label { font-size: 11px; color: var(--muted); }
.chat-search>div { display: flex; gap: 6px; align-items: stretch; margin-top: 8px; }
.chat-search input { margin: 0; min-width: 0; font-size: 11px; }
.chat-search button { padding: 8px 10px; white-space: nowrap; }
.chat-count { margin: 4px 18px 14px; font-size: 10px; color: var(--muted); }
.session-list { max-height: 620px; overflow: auto; padding: 0 10px 12px; }
.session-item { width: 100%; display: flex; align-items: flex-start; gap: 11px; padding: 16px 10px; border: 0; border-radius: 10px; background: transparent; text-align: left; color: var(--ink); }
.session-item:hover { background: #f0f5ee; }.session-item.selected { background: #e8f1e5; }
.session-avatar { width: 34px; height: 34px; border-radius: 11px; flex-shrink: 0; background: #e1ebdc; color: var(--green); display: grid; place-items: center; font-size: 14px; }
.session-copy { min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.session-copy strong { font-size: 12px; font-weight: 550; }.session-copy small { font-size: 9px; color: var(--muted); }
.session-copy>span { font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: #7e8b7b; }
.more-sessions { width: 100%; margin: 14px 0; }.chat-main { display: flex; flex-direction: column; min-width: 0; }
.chat-header { padding: 22px 26px; display: flex; justify-content: space-between; align-items: center; gap: 16px; border-bottom: 1px solid var(--line); }
.chat-header h2 { font-size: 17px; }.chat-header p { font-size: 10px; margin: 8px 0 0; color: var(--muted); overflow-wrap: anywhere; }.chat-header button { white-space: nowrap; }
.chat-messages { padding: 26px; flex: 1; min-height: 360px; height: 480px; max-height: 70vh; overflow: auto; }
.chat-message { margin-bottom: 24px; max-width: 90%; }.user-message { margin-left: auto; }.bot-message { margin-right: auto; }
.bubble-label { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; font-size: 10px; color: #7f907c; margin: 0 3px 9px; }.user-message .bubble-label { justify-content: flex-end; }.bubble-label time,.bubble-label>span { font-size: 9px; color: #9da89b; }
.chat-bubble { padding: 15px 18px; border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.9; font-size: 12px; background: var(--soft); color: var(--ink); }.user-message .chat-bubble { background: #e4f0e0; border-top-right-radius: 3px; }.bot-message .chat-bubble { border-top-left-radius: 3px; }
.turn-status { display: block; margin: 8px 3px 0; font-size: 9px; color: var(--muted); line-height: 1.8; }.turn-status.failed,.chat-error { color: var(--red); }.chat-error { padding: 10px 18px; font-size: 11px; margin: 0; }
.reply-placeholder { color: var(--muted); font-size: 12px; }.topic-separator { text-align: center; font-size: 10px; color: var(--muted); margin: 22px 0; }
.chat-footer { border-top: 1px solid var(--line); padding: 17px 26px; font-size: 10px; color: var(--muted); line-height: 1.9; background: #fcfdfb; }
.chat-welcome { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; padding: 45px; text-align: center; color: var(--muted); }.chat-welcome>span { font-size: 48px; color: #b4c9ad; margin-bottom: 20px; }.chat-welcome h2 { color: #70866a; }.chat-welcome p { font-size: 12px; margin: 16px 0; }.chat-welcome small { font-size: 10px; }
.older-messages { display: block; margin: 0 auto 24px; }
.group-chat { --chat-color: #285d9f; --chat-soft: #eaf2fd; --chat-border: #ccddf3; }
.private-chat { --chat-color: #765092; --chat-soft: #f3ecfa; --chat-border: #e0d0ee; }
.chat-legend { display: flex; align-items: center; gap: 8px; margin: 6px 18px 14px; color: var(--muted); font-size: 11px; }
.scope-badge { display: inline-block; padding: 3px 7px; border-radius: 5px; background: var(--chat-soft); color: var(--chat-color); font-size: 10px; font-weight: 600; line-height: 1.3; }
.session-item { border-left: 3px solid transparent; }
.session-item:hover,.session-item.selected { background: var(--chat-soft); }
.session-item.selected { border-left-color: var(--chat-color); }
.session-avatar { color: var(--chat-color); background: var(--chat-soft); border: 1px solid var(--chat-border); }
.session-copy { flex: 1; }.session-copy strong { overflow-wrap: anywhere; }
.session-copy time { font-size: 10px; color: #687567; }
.chat-header { border-top: 3px solid var(--chat-color); }
.chat-header h2 { margin: 8px 0 0; }.chat-header p { line-height: 1.8; }
.topic-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-width: 240px; }
.topic-actions label { font-size: 10px; color: var(--muted); width: 100%; }
.topic-actions select { width: 100%; min-width: 0; font-size: 11px; margin: 5px 0 0; }
.topic-buttons { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.chat-prune-box { margin: 10px 16px 6px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: #fbfcfa; font-size: 11px; }
.chat-prune-box summary { cursor: pointer; font-weight: 600; color: var(--muted); user-select: none; }
.chat-prune-form { display: grid; gap: 8px; margin-top: 10px; }
.chat-prune-form label { display: grid; gap: 4px; font-size: 10px; color: var(--muted); margin: 0; }
.chat-prune-form input,.chat-prune-form select { padding: 7px 9px; font-size: 11px; margin: 0; }
.danger-btn { color: var(--red); border-color: #e6c6c6; }
.danger-btn:hover { background: #fdf3f3; }
.bubble-label b { font-weight: 600; color: var(--chat-color); }
.bubble-label time,.bubble-label>span { color: #6a7767; font-size: 10px; }
.bubble-label time { white-space: nowrap; }
.user-message .chat-bubble { background: var(--chat-soft); border: 1px solid var(--chat-border); }
.bot-message .chat-bubble { background: #f8f9fd; border: 1px solid var(--line); }
.reply-target { font-size: 10px; line-height: 1.6; color: var(--chat-color); margin: -2px 3px 8px; overflow-wrap: anywhere; }
@media (max-width: 1100px) { .chats-layout { grid-template-columns: 230px minmax(0, 1fr); }.chat-header,.chat-messages { padding: 20px; } }
@media (max-width: 800px) { .chats-layout { grid-template-columns: 1fr; }.chat-sidebar { border-right: 0; border-bottom: 1px solid var(--line); }.session-list { max-height: 200px; }.chat-welcome { min-height: 280px; }.chat-header { padding: 18px; }.chat-messages { padding: 18px; min-height: 320px; }.chat-message { max-width: 96%; }.chat-footer { padding: 16px 18px; } }
@media (max-width: 800px) {
  .chats-layout { min-height: 0; }
  .chat-main { display: none; }
  .mobile-chat-open .chat-main { display: flex; }
  .mobile-chat-open .chat-sidebar { display: none; }
  .chat-back { display: block; align-self: flex-start; margin: 6px 18px; min-height: 44px; font-size: 13px; }
  .session-list { max-height: min(65dvh, 620px); }
  .session-copy strong { font-size: 14px; }.session-copy small { font-size: 11px; }.session-copy>span { font-size: 12px; }
  .session-copy { flex: 1; }.chat-search input { font-size: 16px; }
  .chat-count, .chat-search label { font-size: 12px; }
  .chat-header { align-items: flex-start; gap: 10px; }
  .chat-header { flex-wrap: wrap; }.topic-actions { max-width: 100%; width: 100%; flex-direction: row; align-items: flex-end; }.topic-actions label { flex: 1; min-width: 0; }.topic-actions button { flex-shrink: 0; }.topic-actions select { font-size: 16px; }
  .chat-header>div { min-width: 0; }.chat-header h2 { overflow-wrap: anywhere; }
  .chat-header p { font-size: 11px; }.chat-header button { padding-inline: 12px; }
  .chat-messages { height: 55dvh; min-height: 240px; max-height: 620px; overscroll-behavior: contain; }
  .chat-bubble { font-size: 14px; padding: 13px 14px; }
  .bubble-label, .bubble-label time, .bubble-label>span, .turn-status, .chat-footer { font-size: 11px; overflow-wrap: anywhere; }
}
</style>

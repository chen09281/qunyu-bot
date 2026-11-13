import { messageSegments } from './images.mjs';
import { scheduledChatGroups } from './config.mjs';

export const followupWindowMs = 5 * 60 * 1000;
export const followupIdleMs = 60 * 1000;
export const implicitChatCooldownMs = 10000;
const groupKey = event => `${event.self_id}:${event.group_id}:`;
const userKey = event => groupKey(event) + event.user_id;
const put = (map, key, value) => {
  map.delete(key); map.set(key, value);
  while (map.size > 5000) map.delete(map.keys().next().value);
};

// 只保留本次进程的成功回复窗口，不缓存旁观者的群聊内容，不恢复过期会话。
export class GroupChat {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.windows = new Map(); this.replies = new Map(); this.invitations = new Map();
    this.accepted = new Map(); this.sessions = new Map(); this.sequence = 0;
  }
  sync(config, allowed = () => true) {
    const now = this.now(), targets = new Set(scheduledChatGroups(config));
    for (const [key, session] of this.sessions) if ((!session.pending && session.until <= now) || !config.enabled || config.proactiveChatEnabled === false || config.groupFollowupEnabled === false || !targets.has(key.split(':')[1]) || !allowed(key.split(':')[1])) this.sessions.delete(key);
    for (const map of [this.windows, this.replies, this.invitations]) {
      for (const [key, record] of map) {
        const session = this.sessions.get(key.split(':').slice(0, 2).join(':') + ':');
        if (!session || session.id !== record.sessionId || (map !== this.windows && record.until <= now)) map.delete(key);
      }
    }
    for (const [key, at] of this.accepted) if (now - at > followupWindowMs) this.accepted.delete(key);
  }
  route(event, config, hasLinks) {
    if (config.proactiveChatEnabled === false || !scheduledChatGroups(config).includes(String(event.group_id))) return null;
    const segments = messageSegments(event.message), key = groupKey(event), now = this.now();
    const session = this.sessions.get(key);
    if (!session || (!session.pending && session.until <= now)) return null;
    const text = segments.filter(s => s.type === 'text').map(s => s.data?.text || '').join('').trim();
    // 群命令、平台链接、@ 他人及引用他人的消息继续走各自的原有入口。
    if (hasLinks || /^[!！/／]/u.test(text) || /https?:\/\/|www\./i.test(text) || segments.some(s => s.type === 'at')) return null;
    const quoted = segments.filter(s => s.type === 'reply');
    const ownReply = quoted.length === 1 ? this.replies.get(key + quoted[0].data?.id) : null;
    if (quoted.length && (!ownReply || ownReply.until <= now)) return null;
    const invite = this.invitations.get(key);
    if (config.groupFollowupEnabled !== false && (this.windows.get(userKey(event))?.sessionId === session.id || ownReply?.sessionId === session.id || (invite?.sessionId === session.id && invite.until > now))) {
      if (!text && !segments.some(s => s.type === 'image')) return null;
      return { mode: 'followup', seed: ownReply?.text || invite?.text || '', sessionId: session.id };
    }
    return null;
  }
  cooling(event) { return this.now() - (this.accepted.get(groupKey(event)) ?? -Infinity) < implicitChatCooldownMs; }
  current(event, chat) {
    const session = this.sessions.get(groupKey(event));
    return Boolean(session && session.id === chat?.sessionId && (session.pending || session.until > this.now()));
  }
  queued(event, chat) {
    put(this.accepted, groupKey(event), this.now());
    this.invitations.delete(groupKey(event));
    const session = this.sessions.get(groupKey(event));
    if (session && session.id === chat?.sessionId) session.pending++;
  }
  settled(event, chat) {
    const session = this.sessions.get(groupKey(event));
    if (session && session.id === chat?.sessionId) session.pending = Math.max(0, session.pending - 1);
  }
  replied(event, config, text, messageId, mode, sessionId) {
    if (event.message_type !== 'group') return;
    put(this.accepted, groupKey(event), this.now());
    // 仅定时消息可以开启入口；之后只让该入口接收的免 @ 回复续期。
    // 普通 @ 问答不能创建用户窗口，也不能将普通回复加入可免 @ 引用的缓存。
    if (config.proactiveChatEnabled === false || config.groupFollowupEnabled === false || !scheduledChatGroups(config).includes(String(event.group_id)) || !['scheduled', 'followup'].includes(mode)) return;
    const key = groupKey(event), now = this.now();
    if (mode === 'scheduled') {
      for (const map of [this.windows, this.replies, this.invitations]) for (const k of map.keys()) if (k.startsWith(key)) map.delete(k);
      put(this.sessions, key, { id: ++this.sequence, firstUntil: now + followupWindowMs, until: now + followupWindowMs, pending: 0 });
    }
    const session = this.sessions.get(key);
    if (!session || (mode === 'followup' && (session.id !== sessionId || (!session.pending && session.until <= now)))) return;
    // 前五分钟以定时消息为起点；后续只按成功回复后的闲置一分钟延续。
    if (mode === 'followup') session.until = Math.max(session.firstUntil, now + followupIdleMs);
    const until = session.until;
    if (event.user_id != null) put(this.windows, userKey(event), { until, sessionId: session.id });
    if (messageId != null) put(this.replies, key + messageId, { until, sessionId: session.id, text: text.slice(0, 3000) });
    this.invitations.delete(key);
    if (mode === 'scheduled') put(this.invitations, key, { until, sessionId: session.id, text: text.slice(0, 3000) });
  }
  clear() { for (const map of [this.windows, this.replies, this.invitations, this.accepted, this.sessions]) map.clear(); }
}

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultScheduledChatTimes, scheduledChatGroups, writePrivate } from './config.mjs';
import { modelConfig } from './model-provider.mjs';
import { cleanGroupReply } from './reply.mjs';
import { quarantineCorruptFile } from './security.mjs';

export const scheduledChatTimes = defaultScheduledChatTimes;
export function scheduledChatSlot(now, times = scheduledChatTimes) {
  const local = new Date(now + 8 * 3600000).toISOString();
  const time = local.slice(11, 16);
  return times.includes(time) ? { day: local.slice(0, 10), time, key: local.slice(0, 16) } : null;
}
const groups = scheduledChatGroups;
const enabled = config => config.enabled && config.proactiveChatEnabled !== false && Boolean(modelConfig(config).deepseekKey);

export class ScheduledChat {
  constructor(dataDir, store, bot, { now = () => Date.now() } = {}) {
    this.store = store; this.bot = bot; this.now = now; this.closed = false; this.busy = false;
    this.path = join(dataDir, 'scheduled-chat.json');
    if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) throw Error('定时聊天记录不能是符号链接');
    this.attempts = {};
    if (existsSync(this.path)) {
      try {
        const saved = JSON.parse(readFileSync(this.path, 'utf8'));
        if (saved.version !== 1 || !saved.attempts || Array.isArray(saved.attempts) || typeof saved.attempts !== 'object') {
          throw Error('format_invalid');
        }
        this.attempts = saved.attempts;
      } catch (error) {
        const backup = quarantineCorruptFile(this.path);
        this.corruptBackup = backup;
        console.error(`[scheduled-chat] 定时记录文件损坏，已隔离至 ${backup || this.path}: ${error.message}`);
        this.bot?.log?.('warn', `定时记录文件损坏，已隔离至 ${backup || this.path}`);
        this.attempts = {};
      }
    }
  }
  async tick() {
    const config = modelConfig(this.store.config), current = scheduledChatSlot(this.now(), config.scheduledChatTimes ?? scheduledChatTimes);
    if (this.closed || this.bot.closed || !enabled(config)) { this.pending = null; return; }
    if (this.busy) return;
    if (current) this.pending = current;
    const slot = this.pending;
    if (!slot) return;
    if (!(config.scheduledChatTimes ?? scheduledChatTimes).includes(slot.time)) { this.pending = null; return; }
    if (this.now() - Date.parse(`${slot.key}:00+08:00`) >= 5 * 60000) {
      this.pending = null; this.bot.log('warn', '模型持续繁忙，已跳过本时点的定时发言', { source: 'scheduled_chat', schedule: slot.key }); return;
    }
    const targets = groups(config).filter(group => !Object.hasOwn(this.attempts, `${slot.key}|${group}`));
    if (!targets.length) { this.pending = null; return; }
    if (this.bot.active >= 2 || this.bot.queue.length) return;
    this.pending = null;
    this.busy = true; this.bot.active++;
    let entry;
    try {
      // 先落盘认领整个时点，QQ 超时或中途重启也不会重复发。保留近两天记录。
      const cutoff = this.now() - 2 * 86400000;
      const next = Object.fromEntries(Object.entries(this.attempts).filter(([, at]) => Number.isFinite(at) && at >= cutoff));
      for (const group of targets) next[`${slot.key}|${group}`] = this.now();
      writePrivate(this.path, { version: 1, attempts: next }); this.attempts = next;
      const allowed = group => !this.closed && !this.bot.closed && enabled(this.store.config) && (this.store.config.scheduledChatTimes ?? scheduledChatTimes).includes(slot.time) && groups(this.store.config).includes(group);
      const tavernEnabled = Boolean(this.bot.tavernManager?.state?.enabled);
      const batches = [];
      if (!tavernEnabled) {
        batches.push({ batchTargets: targets, proactiveScope: null });
      } else {
        const byChar = new Map();
        for (const group of targets) {
          const cid = this.bot.tavernManager.getActiveCharacter?.({ isPrivate: false, groupId: group })?.id || '';
          const key = String(cid);
          if (!byChar.has(key)) byChar.set(key, []);
          byChar.get(key).push(group);
        }
        for (const batchTargets of byChar.values()) {
          batches.push({ batchTargets, proactiveScope: { isPrivate: false, groupId: batchTargets[0] } });
        }
      }
      const selfCheck = () => String(config.botId || this.bot.selfId || '');
      let resolvedSelf = '';
      for (const { batchTargets, proactiveScope } of batches) {
        const ensure = () => {
          if (!batchTargets.some(allowed)) throw Object.assign(Error('定时聊天已暂停或群授权已撤销'), { cancelled: true });
        };
        ensure();
        entry = this.bot.log('info', '正在生成定时发言', { source: 'scheduled_chat', schedule: slot.key });
        if (proactiveScope) entry.proactiveScope = proactiveScope;
        try {
          const answer = await this.bot.completion(`现在是北京时间 ${slot.day} ${slot.time}，请给群友发一条这个时段的简短问候。`, config, entry, [], [], ensure, [], '', 'proactive');
          ensure();
          const text = cleanGroupReply(answer.text || '').slice(0, Math.min(180, config.maxReplyLength));
          if (answer.skipped || !text) throw Error('定时发言未生成有效正文');
          if (!resolvedSelf) {
            resolvedSelf = selfCheck() || String((await this.bot.onebot('get_login_info', {}, config)).user_id);
          }
          if (!/^\d{5,20}$/.test(resolvedSelf)) throw Error('无法确认机器人 QQ 号');
          for (const group of batchTargets) {
            if (!allowed(group)) continue;
            const details = { messageType: 'group', receivedMessage: `[北京时间定时发言 ${slot.key}]`, user: '', userName: '', model: config.model, replyMessage: text, replyMention: '', replyStatus: 'sending' };
            const log = this.bot.log('info', '正在发送定时发言', { group, source: 'scheduled_chat', schedule: slot.key, deepseekCalled: false, tokens: 0 }, details);
            try {
              const sent = await this.bot.onebot('send_group_msg', { group_id: group, message: [{ type: 'text', data: { text } }] }, config);
              details.replyStatus = 'sent'; Object.assign(log, { level: 'success', message: '定时发言已发送' });
              this.bot.stats.replied++;
              if (allowed(group)) this.bot.groupChat.replied({ message_type: 'group', self_id: resolvedSelf, group_id: group }, this.store.config, text, sent?.message_id, 'scheduled');
            } catch {
              details.replyStatus = 'send_failed'; Object.assign(log, { level: 'error', message: '定时发言发送失败或未确认，本时点不重复发送' });
              this.bot.stats.failed++;
            }
          }
          Object.assign(entry, { level: 'success', message: '本时点定时发言已处理' });
        } catch (error) {
          if (!error.cancelled) this.bot.stats.failed++;
          Object.assign(entry, { level: error.cancelled ? 'warn' : 'error', message: error.cancelled ? '定时发言已取消' : '定时发言未完成，本时点不重复发送' });
        }
        entry = null;
      }
    } catch (error) {
      if (entry && !error.cancelled) this.bot.stats.failed++;
      if (entry) Object.assign(entry, { level: error.cancelled ? 'warn' : 'error', message: error.cancelled ? '定时发言已取消' : '定时发言未完成，本时点不重复发送' });
      else if (!error.handled) this.bot.log('error', '定时聊天记录保存失败，未发送消息', { source: 'scheduled_chat' });
    } finally {
      this.bot.active--; this.busy = false; this.bot.drain();
    }
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.tick().catch(() => this.bot.log('error', '定时聊天任务未完成')), 10000);
    this.timer.unref(); void this.tick();
  }
  close() { this.closed = true; this.pending = null; clearInterval(this.timer); }
}

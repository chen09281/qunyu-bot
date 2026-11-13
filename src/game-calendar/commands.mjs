import { groupRule, privateAllowed } from '../bot.mjs';
import { messageSegments } from '../images.mjs';
import { games, gameInfo } from '../subscriptions/games.mjs';

const qq = value => /^\d{5,20}$/.test(String(value));

export function gameCalendarCommand(event) {
  const segments = messageSegments(event.message);
  if (segments.some(s => s.type === 'at' && ![String(event.self_id), ''].includes(String(s.data?.qq || '')) || !['text', 'at', 'reply'].includes(s.type))) return null;
  const text = segments.filter(s => s.type === 'text').map(s => s.data?.text || '').join('').trim();
  const match = /^[/#]?(兑换码|礼包码|活动日历|日历|活动|卡池)(?=$|\s)([\s\S]*)$/.exec(text);
  if (!match) return null;
  const keyword = match[1];
  const arg = match[2].trim();
  if (arg === '帮助' || arg.toLowerCase() === 'help') return { mode: 'help', keyword, arg: '' };
  const mode = ['兑换码', '礼包码'].includes(keyword) ? 'codes' : 'calendar';
  return { mode, keyword, arg };
}

export class GameCalendarCommands {
  constructor(store, service, { onebot, log = () => {}, now = Date.now } = {}) {
    Object.assign(this, { store, service, onebot, log, now });
    this.jobs = new Set();
    this.active = new Set();
    this.seen = new Map();
    this.cooldowns = new Map();
    this.controllers = new Set();
    this.closed = false;
  }
  canSend(event) {
    return !this.closed && this.store.config.enabled && this.service.state.settings.enabled !== false && (event.message_type === 'group'
      ? groupRule(this.store.config, event.group_id).allowed
      : privateAllowed(this.store.config, event.user_id));
  }
  async replyText(event, text) {
    if (!this.canSend(event)) return;
    const group = event.message_type === 'group';
    await this.onebot(group ? 'send_group_msg' : 'send_private_msg', {
      ...(group ? { group_id: event.group_id } : { user_id: event.user_id }),
      message: [...(group ? [{ type: 'at', data: { qq: String(event.user_id) } }] : []), { type: 'text', data: { text: group ? ` ${text}` : text } }]
    }, this.store.config, 30);
  }
  async replyImage(event, file) {
    if (!this.canSend(event)) return;
    const group = event.message_type === 'group';
    await this.onebot(group ? 'send_group_msg' : 'send_private_msg', {
      ...(group ? { group_id: event.group_id } : { user_id: event.user_id }),
      message: [{ type: 'image', data: { file } }]
    }, this.store.config, 120);
  }
  receive(event) {
    const parsed = gameCalendarCommand(event);
    if (!parsed) return null;
    const group = event.message_type === 'group', config = this.store.config;
    if (event.post_type !== 'message' || !['group', 'private'].includes(event.message_type) || !qq(event.self_id) || !qq(event.user_id)
      || String(event.user_id) === String(event.self_id) || (config.botId && String(event.self_id) !== config.botId) || event.message_id == null
      || (group && !qq(event.group_id)) || !this.canSend(event)) {
      return { ignored: 'game_calendar_unauthorized' };
    }
    const now = this.now(), key = group ? `group:${event.group_id}` : `private:${event.user_id}`;
    const id = `${event.self_id}:${key}:${event.message_id}`;
    for (const map of [this.seen, this.cooldowns]) for (const [k, at] of map) if (now - at > 600000) map.delete(k);
    if (this.seen.has(id)) return { ignored: 'duplicate' };
    if (this.active.has(key) || this.active.size >= 3 || (this.cooldowns.has(key) && now - this.cooldowns.get(key) < 2000)) {
      return { ignored: 'game_calendar_busy' };
    }
    this.seen.set(id, now);
    this.cooldowns.set(key, now);
    this.active.add(key);
    const job = this.handle(event, parsed).catch(() => this.log('warn', '游戏日历／兑换码指令处理失败', { source: 'game_calendar' }))
      .finally(() => { this.active.delete(key); this.jobs.delete(job); });
    this.jobs.add(job);
    return { accepted: true, plugin: 'game-calendar' };
  }
  async handle(event, { mode, arg }) {
    if (mode === 'help') {
      const names = games.map(g => `${g.name}（${g.aliases[0]}）`).join('、');
      return this.replyText(event, [
        '游戏兑换码与活动日历指令：',
        '• /兑换码 — 查看全部启用游戏的有效兑换码卡片',
        '• /兑换码 鸣潮 — 查看指定游戏的兑换码',
        '• /日历 或 /活动 — 查看各游戏当前活动与卡池倒计时卡片',
        '• /日历 绝区零 — 查看指定游戏的活动日历',
        `支持游戏：${names}`
      ].join('\n'));
    }
    let gameFilter = '';
    if (arg) {
      const matched = gameInfo(arg);
      if (!matched) {
        return this.replyText(event, `未识别游戏「${arg.slice(0, 20)}」。支持：${games.map(g => g.name).join('、')}。\n示例：「/兑换码 鸣潮」「/日历 zzz」`);
      }
      gameFilter = matched.id;
    }
    const view = this.service.buildView(mode, gameFilter);
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      if (this.service.state.settings.renderCard !== false) {
        try {
          const rendered = await this.service.renderCardImage(view, { signal: controller.signal });
          if (!this.canSend(event)) return;
          await this.replyImage(event, rendered.file);
          this.log('success', `已发送${view.title}卡片`, {
            ...(event.message_type === 'group' ? { group: String(event.group_id) } : { messageType: 'private', user: String(event.user_id) }),
            source: 'game_calendar',
            deepseekCalled: false,
            promptTokens: 0,
            completionTokens: 0,
            tokens: 0
          });
          return;
        } catch {
          // Fall back to plain text when Pillow or card upload fails
        }
      }
      await this.replyText(event, view.text);
      this.log('success', `已发送${view.title}`, {
        ...(event.message_type === 'group' ? { group: String(event.group_id) } : { messageType: 'private', user: String(event.user_id) }),
        source: 'game_calendar',
        deepseekCalled: false,
        promptTokens: 0,
        completionTokens: 0,
        tokens: 0
      });
    } finally {
      this.controllers.delete(controller);
    }
  }
  close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
  }
}

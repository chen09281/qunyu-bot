const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
export const chatTime = value => Number.isFinite(value) ? formatter.format(new Date(value)) : '时间未知';
export const chatDateTime = value => Number.isFinite(value) ? new Date(value).toISOString() : undefined;

// Replies may complete out of order when different group members ask concurrently.
export function chatTimeline(turns) {
  return turns.flatMap(turn => [
    { key: `${turn.id}-user`, kind: 'user', at: turn.createdAt, turn },
    { key: `${turn.id}-bot`, kind: 'bot', at: turn.updatedAt, turn }
  ]).sort((a, b) => a.at - b.at || a.turn.id - b.turn.id || (a.kind === 'user' ? -1 : 1));
}

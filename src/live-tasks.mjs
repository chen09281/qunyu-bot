import { randomUUID } from 'node:crypto';
const cap = (text, max) => typeof text === 'string' ? text.slice(0, max) : '';
export class LiveTasks {
  constructor() { this.tasks = new Map(); }
  begin(input) {
    const id = input.id || randomUUID(), at = Date.now();
    const task = { id, question: cap(input.question, 20000), user: cap(input.user, 20), userName: cap(input.userName, 100), group: cap(input.group, 20),
      messageType: input.messageType || 'system', model: cap(input.model, 100), source: input.source || 'chat', stage: 'queued', startedAt: at, updatedAt: at,
      reasoning: '', answer: '', reasoningTruncated: false, answerTruncated: false, streaming: null, endedAt: null };
    this.tasks.set(id, task); this.prune(); return id;
  }
  prune() {
    const ended = [...this.tasks.values()].filter(task => task.endedAt).sort((a, b) => a.endedAt - b.endedAt);
    while (this.tasks.size > 30 && ended.length) this.tasks.delete(ended.shift().id);
    while (this.tasks.size > 30) this.tasks.delete(this.tasks.keys().next().value);
  }
  update(id, patch) {
    const task = this.tasks.get(id); if (!task) return;
    for (const key of ['stage', 'streaming', 'model', 'tokens', 'provider', 'modelProfileName']) if (Object.hasOwn(patch, key)) task[key] = patch[key];
    if (typeof patch.answer === 'string') { task.answer = cap(patch.answer, 20000); task.answerTruncated = patch.answer.length > 20000; }
    task.updatedAt = Date.now();
  }
  delta(id, delta) {
    const task = this.tasks.get(id); if (!task || task.endedAt) return;
    for (const [key, max] of [['reasoning', 30000], ['answer', 20000]]) {
      const text = delta[key === 'answer' ? 'content' : key];
      if (text) { task[key + 'Truncated'] ||= task[key].length + text.length > max; task[key] = (task[key] + text).slice(0, max); }
    }
    if (delta.tool) task.stage = 'drafting'; else if (delta.content) task.stage = 'answering'; else if (delta.reasoning) task.stage = 'thinking';
    task.updatedAt = Date.now();
  }
  finish(id, stage) { const task = this.tasks.get(id); if (task) { task.stage = stage; task.updatedAt = task.endedAt = Date.now(); this.prune(); } }
  status(id) {
    const tasks = [...this.tasks.values()].reverse().sort((a, b) => Number(Boolean(a.endedAt)) - Number(Boolean(b.endedAt)) || b.startedAt - a.startedAt);
    const selected = this.tasks.get(id) || tasks[0];
    return { tasks: tasks.map(({ reasoning, answer, ...task }) => ({ ...task, question: task.question.slice(0, 200) })), selected: selected ? { ...selected } : null };
  }
  close() { this.tasks.clear(); }
}

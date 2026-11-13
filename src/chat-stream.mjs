// Aggregate provider SSE deltas while publishing only the fields used by the live monitor.
// Bound retained data, not cumulative SSE traffic: repeated envelopes and already
// consumed reasoning/heartbeats must not exhaust the final answer's budget.
const eventLimit = 2 * 1024 * 1024;
const messageLimit = 8 * 1024 * 1024;
const jsonLimit = 16 * 1024 * 1024;

export async function readChatResponse(response, { onDelta = () => {}, ensure = () => {} } = {}) {
  const streaming = /text\/event-stream/i.test(response.headers.get('content-type') || '');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, pending = '', event = [], eventBytes = 0, messageBytes = 0, ended = false, finished = false, usage;
  let content = '', role = 'assistant', finishReason = null;
  const tools = new Map(), chunks = [];
  function retain(text) {
    if (typeof text !== 'string') return '';
    messageBytes += Buffer.byteLength(text);
    if (messageBytes > messageLimit) throw Error('上游回答或工具参数超过 8 MiB，已停止接收');
    return text;
  }
  function checkEvent(bytes) {
    if (bytes > eventLimit) throw Error('上游单个流式事件超过 2 MiB，已停止接收');
  }
  function dispatch() {
    eventBytes = 0;
    if (!event.length) return;
    const data = event.join('\n'); event = [];
    if (data.trim() === '[DONE]') { ended = true; return; }
    let packet; try { packet = JSON.parse(data); } catch { throw Error('上游流式响应格式错误'); }
    if (!packet || typeof packet !== 'object' || packet.error) throw Error('上游流式响应失败');
    if (packet.usage) usage = packet.usage;
    const choice = packet.choices?.find(item => (item.index ?? 0) === 0);
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.role === 'string') role = delta.role;
    content += retain(delta.content);
    for (const tool of delta.tool_calls || []) {
      if (!Number.isInteger(tool.index) || tool.index < 0 || tool.index > 10) throw Error('上游工具调用格式错误');
      const previous = tools.get(tool.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      previous.id += retain(tool.id);
      if (typeof tool.type === 'string') previous.type = tool.type;
      previous.function.name += retain(tool.function?.name);
      previous.function.arguments += retain(tool.function?.arguments);
      tools.set(tool.index, previous);
    }
    if (choice.finish_reason) { finishReason = choice.finish_reason; finished = true; }
    onDelta({ reasoning: typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '', content: typeof delta.content === 'string' ? delta.content : '', tool: Boolean(delta.tool_calls?.length) });
  }
  function line(value) {
    checkEvent(eventBytes + Buffer.byteLength(value));
    if (!value) dispatch();
    else if (value.startsWith('data:')) { event.push(value.slice(5).replace(/^ /, '')); eventBytes += Buffer.byteLength(value) + 1; checkEvent(eventBytes); }
  }
  try {
    while (true) {
      ensure(); const { value, done } = await reader.read(); ensure(); if (done) break;
      if (!streaming) {
        size += value.length; if (size > jsonLimit) throw Error('上游非流式响应超过 16 MiB，已停止接收');
        chunks.push(value); continue;
      }
      pending += decoder.decode(value, { stream: true });
      let at, start = 0;
      while (!ended && (at = pending.indexOf('\n', start)) !== -1) { line(pending.slice(start, at).replace(/\r$/, '')); start = at + 1; }
      if (ended) { pending = ''; await reader.cancel(); break; }
      pending = pending.slice(start); checkEvent(eventBytes + Buffer.byteLength(pending));
    }
    if (!streaming) {
      let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('上游未返回有效 JSON'); }
      const message = data.choices?.[0]?.message;
      onDelta({ reasoning: typeof message?.reasoning_content === 'string' ? message.reasoning_content : '', content: typeof message?.content === 'string' ? message.content : '', tool: Boolean(message?.tool_calls?.length) });
      return data;
    }
    pending += decoder.decode(); if (pending) line(pending.replace(/\r$/, '')); dispatch();
    if (!ended && !finished) throw Error('上游流式响应中断，未收到完成标记');
    return { choices: [{ message: { role, content: content || null, ...(tools.size ? { tool_calls: [...tools.entries()].sort(([a], [b]) => a - b).map(([, value]) => value) } : {}) }, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

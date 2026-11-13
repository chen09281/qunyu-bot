import { publicImageUrl } from './images.mjs';
// Translate Responses API output into the chat shape used by the document and reply pipeline.
export function normalizeResponses(data) {
  if (!data || data.error || ['failed', 'cancelled'].includes(data.status)) throw Error('上游 Responses 请求失败');
  if (!['completed', 'incomplete'].includes(data.status) || !Array.isArray(data.output)) throw Error('上游 Responses 未返回完整结果');
  let content = ''; const tool_calls = [], sources = new Map(); let searches = 0;
  const source = value => { const url = publicImageUrl(value.url); if (url && url.length <= 2048 && sources.size < 20) sources.set(url, { url, title: String(value.title || new URL(url).hostname).replace(/[\r\n]/g, ' ').slice(0, 120) }); };
  for (const item of data.output) {
    if (item.type === 'web_search_call' && item.status === 'completed') { searches++; for (const row of item.action?.sources || []) source(row); }
    if (item.type === 'message') for (const part of item.content || []) {
      if (part.type === 'output_text') { content += part.text || ''; for (const annotation of part.annotations || []) if (annotation.type === 'url_citation') source(annotation); }
      if (part.type === 'refusal') content += part.refusal || '';
    }
    if (item.type === 'function_call') tool_calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
  }
  if (Buffer.byteLength(content + JSON.stringify(tool_calls)) > 8 * 1024 * 1024) throw Error('上游回答或工具参数超过 8 MiB，已停止接收');
  if (data.status === 'incomplete' && data.incomplete_details?.reason !== 'max_output_tokens') throw Error('上游 Responses 生成未完成');
  return { ...(searches || sources.size ? { webSearch: { calls: searches, sources: [...sources.values()] } } : {}), choices: [{ message: { role: 'assistant', content, ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: data.status === 'incomplete' ? 'length' : tool_calls.length ? 'tool_calls' : 'stop' }],
    ...(data.usage ? { usage: { prompt_tokens: data.usage.input_tokens, completion_tokens: data.usage.output_tokens, total_tokens: data.usage.total_tokens, prompt_tokens_details: data.usage.input_tokens_details, completion_tokens_details: data.usage.output_tokens_details } } : {}) };
}
export async function readResponsesResponse(response, { onDelta = () => {}, ensure = () => {} } = {}) {
  const stream = /text\/event-stream/i.test(response.headers.get('content-type') || '');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', lines = [], bytes = 0, retained = 0, result, sawText = false; const chunks = [];
  const limit = value => { if (value > 2 * 1024 * 1024) throw Error('上游单个流式事件超过 2 MiB，已停止接收'); };
  function dispatch() {
    bytes = 0; if (!lines.length) return;
    const raw = lines.join('\n'); lines = []; if (raw === '[DONE]') return;
    let event; try { event = JSON.parse(raw); } catch { throw Error('上游流式响应格式错误'); }
    if (event.type === 'error' || event.type === 'response.failed') throw Error('上游 Responses 请求失败');
    if (['response.output_text.delta', 'response.refusal.delta', 'response.function_call_arguments.delta'].includes(event.type)) {
      if (typeof event.delta !== 'string') throw Error('上游流式响应格式错误');
      retained += Buffer.byteLength(event.delta); if (retained > 8 * 1024 * 1024) throw Error('上游回答或工具参数超过 8 MiB，已停止接收');
      const tool = event.type === 'response.function_call_arguments.delta';
      if (!tool) sawText = true;
      onDelta({ content: tool ? '' : event.delta, tool });
    }
    if (event.type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') onDelta({ reasoning: event.delta });
    if (['response.completed', 'response.incomplete'].includes(event.type)) result = normalizeResponses(event.response);
  }
  function line(text) {
    limit(bytes + Buffer.byteLength(text));
    if (!text) dispatch();
    else if (text.startsWith('data:')) { lines.push(text.slice(5).replace(/^ /, '')); bytes += Buffer.byteLength(text); }
  }
  try {
    while (!result) {
      ensure(); const { done, value } = await reader.read(); ensure(); if (done) break;
      if (!stream) { bytes += value.length; if (bytes > 16 * 1024 * 1024) throw Error('上游非流式响应超过 16 MiB'); chunks.push(value); continue; }
      pending += decoder.decode(value, { stream: true }); let at;
      while (!result && (at = pending.indexOf('\n')) !== -1) { line(pending.slice(0, at).replace(/\r$/, '')); pending = pending.slice(at + 1); }
      if (!result) limit(bytes + Buffer.byteLength(pending));
    }
    if (!stream) {
      let raw; try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('上游未返回有效 JSON'); }
      result = normalizeResponses(raw);
    } else if (!result) { pending += decoder.decode(); if (pending) line(pending.replace(/\r$/, '')); dispatch(); }
    if (!result) throw Error('上游流式响应中断，未收到完成标记');
    if (!sawText) onDelta({ content: result.choices[0].message.content, tool: Boolean(result.choices[0].message.tool_calls?.length) });
    await reader.cancel(); return result;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

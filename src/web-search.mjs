export function webSearchProvider(config) {
  if (!config.webSearchEnabled) return { kind: 'disabled' };
  if (config.apiProvider === 'deepseek') return { kind: 'deepseek', url: config.deepseekUrl, key: config.deepseekKey };
  if (config.apiProvider === 'kimi' && /^https:\/\/api\.moonshot\.(?:cn|ai)(?:\/|$)/.test(config.deepseekUrl)) return { kind: 'kimi', url: config.deepseekUrl, key: config.deepseekKey };
  if (config.apiProvider === 'openai' && config.modelProtocol === 'responses') return { kind: 'responses' };
  if (config.webSearchFallbackKey) return { kind: 'deepseek', url: config.webSearchFallbackUrl, key: config.webSearchFallbackKey };
  return { kind: 'disabled' };
}

export async function searchWeb(bot, provider, query, count, needContent, timeout, scope = null) {
  const base = provider.url.replace(/\/v1\/?$/, '');
  const body = provider.kind === 'kimi' ? { text_query: query, limit: count, include_content: needContent } : { query, count, need_content: needContent };
  const data = await bot.request(`${base}/v1/tools/search`, body, provider.key, timeout);
  if (provider.kind === 'deepseek') bot.tokenUsage?.recordTool('search', undefined, scope);
  const rows = data.results || data.search_results || [];
  if (!Array.isArray(rows)) throw Error('搜索接口未返回有效结果');
  return { ...data, results: rows.map(row => ({ ...row, summary: row.summary || row.description || row.snippet || row.text || '', content: row.content || row.text || row.description || row.snippet || '' })) };
}

export async function fetchSearchPage(bot, provider, url, timeout, scope = null) {
  const base = provider.url.replace(/\/v1\/?$/, '');
  const data = await bot.request(`${base}/v1/tools/fetch`, { url }, provider.key, timeout);
  if (provider.kind === 'deepseek') bot.tokenUsage?.recordTool('fetch', undefined, scope);
  return provider.kind === 'kimi' ? { ...data, content: data.markdown || data.content || '' } : data;
}

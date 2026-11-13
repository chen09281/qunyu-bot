import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
// Only public, fixed official documentation URLs are fetched. Never send model keys.
export const priceSources = [
  { id: 'deepseek', label: 'DeepSeek', url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/' },
  { id: 'kimi', label: 'Kimi', url: 'https://platform.kimi.com/docs/pricing/chat' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', url: 'https://developers.openai.com/api/docs/models/gpt-6-sol.md' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', url: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol.md' }
];

const text = html => html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').trim();
const amount = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw Error('官方单价格式不正确');
  return n;
};

export function parseOfficialPrices(id, body) {
  const source = priceSources.find(item => item.id === id);
  if (!source) throw Error('未知价格来源');
  const base = { sourceId: id, sourceUrl: source.url.replace(/\.md$/, ''), currency: id.startsWith('gpt-') ? 'USD' : 'CNY' };
  if (id.startsWith('gpt-')) {
    if (!body.includes(`Model ID: \`${id}\``)) throw Error('官方模型 ID 已变化');
    const section = body.split('### Text tokens')[1]?.split('## Endpoints')[0] || '';
    const price = name => {
      const match = section.match(new RegExp(`\\| ${name} \\| \\$([\\d.]+) \\| 1M tokens \\|`));
      if (!match) throw Error('官方价格表结构已变化');
      return amount(match[1]);
    };
    return [{ ...base, provider: 'openai', model: id, inputPrice: price('Input'), cachedInputPrice: price('Cached input'),
      outputPrice: price('Output'), cacheWritePrice: price('Cache writes'),
      note: 'Standard 标准短上下文价。长上下文、Fast、缓存写入、工具调用和地区附加费未计入参考估算。' }];
  }
  if (id === 'deepseek') {
    const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(match =>
      [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(cell => text(cell[1])));
    if (!rows.some(row => row[0] === '模型' && row[1]?.startsWith('deepseek-flash') && row[2] === 'deepseek-v4-pro')) throw Error('DeepSeek 模型列已变化');
    const start = rows.findIndex(row => row.some(cell => /百万tokens输入.*缓存命中/.test(cell)));
    const table = rows.slice(start, start + 6);
    if (start < 0 || table.length !== 6 || !table.every((row, i) => row.includes(i % 2 ? '高峰时段' : '空闲时段'))
      || !table[2].some(cell => cell.includes('缓存未命中')) || !table[4].some(cell => cell.includes('百万tokens输出'))) throw Error('DeepSeek 价格表结构已变化');
    const rates = table.map(row => row.slice(-2).map(cell => {
      if (!/^[\d.]+元$/.test(cell)) throw Error('DeepSeek 单价单位已变化');
      return amount(cell.slice(0, -1));
    }));
    return ['deepseek-flash', 'deepseek-v4-pro'].map((model, i) => ({ ...base, provider: 'deepseek', model,
      aliases: i ? [] : ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
      inputPrice: rates[3][i], cachedInputPrice: rates[1][i], outputPrice: rates[5][i],
      offPeak: { inputPrice: rates[2][i], cachedInputPrice: rates[0][i], outputPrice: rates[4][i] },
      note: '新调用按北京时间高峰／谷时计价，历史导出保持实际金额。官方高峰为北京时间工作日 9–12 点、14–18 点（法定节假日除外）；其他时段按空闲价。搜索与抓取另计。' }));
  }
  // Mintlify embeds the dynamic table in its document payload. Parse data, never execute it.
  const marker = 'rows:[[_jsx';
  const start = body.indexOf(marker);
  const section = body.slice(start, start + 1700);
  const header = body.slice(body.lastIndexOf('columns:[', start), start);
  const columns = [...header.matchAll(/(?:title|children):`(输入|输出|缓存命中|缓存写入（5min）|缓存写入（1h）)`/g)].map(m => m[1]);
  if (columns.join(',') !== '输入,输出,缓存命中,缓存写入（5min）,缓存写入（1h）') throw Error('Kimi 表头已变化');
  const result = [];
  for (const match of section.matchAll(/children:`(kimi-k3(?:\.1-pro(?:-highspeed)?)?)`\}\),((?:`¥[\d.]+ \/ MTok`,?){5})/g)) {
    const values = [...match[2].matchAll(/¥([\d.]+)/g)].map(m => amount(m[1]));
    result.push({ ...base, provider: 'kimi', model: match[1], ...(match[1] === 'kimi-k3.1-pro' ? { aliases: ['k3.1-pro'] } : {}),
      inputPrice: values[0], outputPrice: values[1], cachedInputPrice: values[2],
      cacheWritePrice: values[3], cacheWriteHourPrice: values[4], note: '标准按量价格；缓存写入（5 分钟／1 小时）、工具调用费用未计入参考估算。' });
  }
  if (result.length !== 3 || new Set(result.map(row => row.model)).size !== 3) throw Error('Kimi 动态价格表结构已变化');
  return result;
}

export async function fetchOfficialPrices(source, { fetchImpl = fetch, signal } = {}) {
  if (!priceSources.some(item => item.id === source.id && item.url === source.url)) throw Error('未知价格来源');
  signal ||= AbortSignal.timeout(20000);
  const response = await fetchImpl(source.url, { signal, redirect: 'error',
    headers: { Accept: 'text/html, text/markdown, text/plain', 'User-Agent': 'QQBot-PriceSync/1.0' } });
  if (response.status === 403 && fetchImpl === fetch && source.id.startsWith('gpt-')) {
    await response.body?.cancel();
    // Some documentation edges reject Node's TLS client. Reuse the application's
    // Python runtime to read the same public URL, with the same bounds and no redirects.
    const { stdout } = await run(process.env.LINK_PYTHON || 'python3', ['-I', fileURLToPath(new URL('./fetch-price.py', import.meta.url)), source.url],
      { signal, timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
    return parseOfficialPrices(source.id, stdout);
  }
  if (!response.ok) throw Error(`官方来源 HTTP ${response.status}`);
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw Error('官方价格页面过大');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return parseOfficialPrices(source.id, Buffer.concat(chunks).toString('utf8'));
}

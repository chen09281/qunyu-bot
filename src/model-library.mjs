import { createHash, randomUUID } from 'node:crypto';

export const modelPurposes = { chat: '聊天回复', image: '图片识别', video: '视频内容总结', document: '文档生成' };
export const emptyModelRoutes = () => ({ chat: '', image: '', video: '', document: '' });
const fields = ['id', 'name', 'provider', 'baseUrl', 'apiKey', 'model', 'protocol', 'vision', 'tools', 'search', 'effort', 'maxTokens', 'unlimited'];
const error = message => { throw new Error(message); };
export function validateModelProfiles(profiles, previous = []) {
  if (!Array.isArray(profiles) || profiles.length > 30) error('模型库最多保存 30 个模型');
  const ids = new Set();
  return profiles.map(p => {
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !fields.includes(k))) error('模型配置格式错误');
    for (const key of ['id', 'name', 'provider', 'baseUrl', 'model', 'protocol', 'effort']) if (typeof p[key] !== 'string' || !p[key].trim()) error('请填写完整的模型配置');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(p.id) || ids.has(p.id)) error('模型编号重复或无效'); ids.add(p.id);
    if (p.name.length > 80 || p.model.length > 100 || /[\r\n]/.test(p.name + p.model)) error('模型名称过长或包含换行');
    if (!['deepseek', 'openai', 'kimi'].includes(p.provider) || !['chat', 'responses'].includes(p.protocol) || p.provider !== 'openai' && p.protocol !== 'chat') error('模型服务商或调用协议无效');
    let url; try { url = new URL(p.baseUrl); } catch { error('API 基础地址无效'); }
    if (p.baseUrl.length > 2048 || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) error('API 地址必须使用 HTTPS（本机测试除外），不能包含账号或查询参数');
    if (/\/(chat\/completions|responses|models)\/?$/.test(url.pathname)) error('请填写 API 基础地址，不要附加调用路径');
    if (['api.openai.com', 'api.moonshot.cn', 'api.moonshot.ai'].includes(url.hostname) && url.pathname === '/') url.pathname = '/v1';
    const baseUrl = url.href.replace(/\/+$/, ''), old = previous.find(item => item.id === p.id);
    if (p.apiKey !== undefined && (typeof p.apiKey !== 'string' || p.apiKey.length > 2048 || /[\r\n]/.test(p.apiKey))) error('API Key 格式错误');
    const apiKey = p.apiKey?.trim() || old?.apiKey || '';
    if (old?.apiKey && (old.baseUrl !== baseUrl || old.provider !== p.provider) && !p.apiKey?.trim()) error('更换服务商或 API 地址时，请重新填写该接口的密钥');
    if (!apiKey) error('请填写 API Key 后保存模型');
    for (const key of ['vision', 'tools', 'unlimited']) if (typeof p[key] !== 'boolean') error('模型能力开关格式错误');
    if (p.search !== undefined && typeof p.search !== 'boolean') error('联网搜索开关格式错误');
    if (!Number.isInteger(p.maxTokens) || p.maxTokens < 64 || p.maxTokens > 99999999) error('输出预算应为 64–99,999,999 的整数');
    const efforts = p.provider === 'deepseek' ? ['auto', 'off', 'low', 'high', 'max'] : p.provider === 'kimi' ? ['auto', 'low', 'high', 'max'] : ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (!efforts.includes(p.effort)) error('该服务不支持所选思考强度');
    if (p.provider === 'openai' && /^gpt-6(?:[.-]|$)/.test(p.model) && (p.protocol !== 'responses' || ['none', 'minimal'].includes(p.effort))) error('GPT-6 系列请使用 Responses 协议，思考强度选择默认或 low 以上');
    return { ...Object.fromEntries(fields.filter(k => k !== 'apiKey').map(k => [k, typeof p[k] === 'string' ? p[k].trim() : p[k]])), search: p.search !== false, baseUrl, apiKey };
  });
}
export function validateModelRoutes(routes, profiles) {
  if (!routes || typeof routes !== 'object' || Array.isArray(routes) || Object.keys(routes).some(k => !Object.hasOwn(modelPurposes, k))) error('功能模型分配格式错误');
  const result = { ...emptyModelRoutes(), ...routes };
  for (const [purpose, id] of Object.entries(result)) {
    if (typeof id !== 'string') error('请选择已保存的模型');
    if (!id) continue;
    const profile = profiles.find(p => p.id === id);
    if (!profile) error(`${modelPurposes[purpose]}引用的模型不存在，请先更改分配再删除`);
    if (['image', 'video'].includes(purpose) && !profile.vision) error(`${modelPurposes[purpose]}需要支持图片输入的模型`);
    if (purpose === 'document' && !profile.tools) error('文档生成需要支持工具调用的模型');
  }
  return result;
}
export const libraryRevision = config => createHash('sha256').update(JSON.stringify([config.modelProfiles || [], config.modelRoutes || emptyModelRoutes(), config.modelFallbackEnabled !== false, config.modelFallbackProfileId || ''])).digest('hex');
export function publicModelLibrary(config) {
  return {
    revision: libraryRevision(config),
    profiles: (config.modelProfiles || []).map(({ apiKey, ...p }) => ({ ...p, keyConfigured: Boolean(apiKey) })),
    routes: { ...emptyModelRoutes(), ...config.modelRoutes },
    fallbackEnabled: config.modelFallbackEnabled !== false,
    fallbackProfileId: config.modelFallbackProfileId || ''
  };
}
export function importLegacyModels(config) {
  const profiles = [...(config.modelProfiles || [])];
  for (const provider of ['deepseek', 'openai']) {
    const openai = provider === 'openai', key = openai ? config.openaiKey : config.deepseekKey;
    if (!key) continue;
    const model = openai ? config.openaiModel : config.model, vision = openai ? config.openaiVisionModel || model : config.visionModel;
    for (const id of new Set([model, vision])) {
      const baseUrl = openai ? config.openaiUrl : config.deepseekUrl;
      if (profiles.some(p => p.provider === provider && p.model === id && p.baseUrl === baseUrl)) continue;
      profiles.push({ id: randomUUID(), name: `${openai ? 'OpenAI' : 'DeepSeek'} · ${id}`, provider, baseUrl, apiKey: key, model: id,
        protocol: openai && /^gpt-6(?:[.-]|$)/.test(id) ? 'responses' : 'chat', vision: true, tools: true,
        effort: openai ? 'auto' : config.thinkingEnabled ? config.reasoningEffort : 'off',
        maxTokens: openai ? config.openaiMaxTokens : config.maxTokens, unlimited: openai ? config.openaiMaxTokensUnlimited : config.maxTokensUnlimited });
    }
  }
  return profiles;
}

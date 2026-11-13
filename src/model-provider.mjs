// Resolve per job. The original immutable config keeps credentials/routes stable while queued.
const resolved = Symbol('resolved-model-provider'), original = Symbol('original-model-config');
export function modelConfig(config, purpose) {
  if (config[resolved] && (!purpose || purpose === config.modelPurpose)) return config;
  const raw = config[original] || config;
  purpose ||= 'chat';
  const id = raw.modelRoutes?.[purpose] || raw.modelRoutes?.chat;
  const profile = id && raw.modelProfiles?.find(p => p.id === id);
  if (id && !profile) throw Error('所选功能模型已不存在，请重新保存模型分配');
  if (profile) return {
    ...raw, [resolved]: true, [original]: raw, modelPurpose: purpose, modelProfileId: profile.id, modelProfileName: profile.name,
    apiProvider: profile.provider, deepseekUrl: profile.baseUrl, deepseekKey: profile.apiKey,
    model: profile.model, visionModel: profile.model, modelProtocol: profile.protocol,
    modelSupportsVision: profile.vision, modelSupportsTools: profile.tools,
    thinkingEnabled: profile.provider === 'kimi' || !['off', 'none', 'auto'].includes(profile.effort),
    reasoningEffort: profile.effort === 'auto' ? 'high' : profile.effort, openaiReasoningEffort: profile.effort,
    kimiReasoningEffort: profile.effort,
    webSearchEnabled: raw.webSearchEnabled && profile.search !== false,
    webSearchFallbackUrl: raw.deepseekUrl, webSearchFallbackKey: raw.deepseekKey,
    maxTokens: profile.maxTokens, maxTokensUnlimited: profile.unlimited
  };
  const legacy = raw.apiProvider !== 'openai' ? { ...raw } : {
    ...raw, deepseekUrl: raw.openaiUrl, deepseekKey: raw.openaiKey,
    model: raw.openaiModel, visionModel: raw.openaiVisionModel || raw.openaiModel,
    thinkingEnabled: !['auto', 'none'].includes(raw.openaiReasoningEffort || 'auto'),
    webSearchEnabled: raw.webSearchEnabled, maxTokens: raw.openaiMaxTokens, maxTokensUnlimited: raw.openaiMaxTokensUnlimited,
    webSearchFallbackUrl: raw.deepseekUrl, webSearchFallbackKey: raw.deepseekKey
  };
  return { ...legacy, [resolved]: true, [original]: raw, modelPurpose: purpose };
}
export function profileConfig(config, id) {
  if (!config.modelProfiles?.some(p => p.id === id)) throw Object.assign(Error('模型不存在'), { status: 404 });
  return modelConfig({ ...config, modelRoutes: { ...config.modelRoutes, chat: id } });
}
export function completionOptions(config) {
  if (config.apiProvider === 'kimi') return {
    ...(config.kimiReasoningEffort && config.kimiReasoningEffort !== 'auto' ? { reasoning_effort: config.kimiReasoningEffort } : {}),
    ...(config.maxTokensUnlimited ? {} : { max_tokens: config.maxTokens })
  };
  if (config.apiProvider === 'openai') return {
    ...(config.openaiReasoningEffort && config.openaiReasoningEffort !== 'auto' ? { reasoning_effort: config.openaiReasoningEffort } : {}),
    ...(config.maxTokensUnlimited ? {} : { max_completion_tokens: config.maxTokens })
  };
  return {
    thinking: { type: config.thinkingEnabled ? 'enabled' : 'disabled' },
    ...(config.thinkingEnabled ? { reasoning_effort: config.reasoningEffort || 'high' } : {}),
    ...(config.maxTokensUnlimited ? {} : { max_tokens: config.maxTokens })
  };
}
export function completionRequest(config, messages, tools = [], stream = true) {
  if (config.apiProvider === 'kimi') messages = messages.map(message => ({ ...message, content: Array.isArray(message.content) ? message.content.map(part => {
    if (part.type !== 'image_url') return part;
    if (!/^data:image\//.test(part.image_url?.url || '')) throw Error('Kimi 图片需要先下载到本地，当前图片读取失败，请重新发送原图');
    return { type: 'image_url', image_url: { url: part.image_url.url } };
  }) : message.content }));
  if (config.modelProtocol !== 'responses') return { path: '/chat/completions', body: {
    model: config.model, messages, ...completionOptions(config), stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools.length ? { tools, tool_choice: 'auto' } : {})
  } };
  return { path: '/responses', body: {
    model: config.model, store: false, stream,
    input: messages.map(message => ({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.map(part =>
      part.type === 'text' ? { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
        : { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail || 'high' }) })),
    ...(config.openaiReasoningEffort && config.openaiReasoningEffort !== 'auto' ? { reasoning: { effort: config.openaiReasoningEffort } } : {}),
    ...(config.maxTokensUnlimited ? {} : { max_output_tokens: config.maxTokens }),
    ...((config.nativeWebSearch || tools.length) ? { tools: [...(config.nativeWebSearch ? [{ type: 'web_search' }] : []), ...tools.map(tool => ({ type: 'function', ...tool.function, strict: false }))], tool_choice: 'auto' } : {})
  } };
}

export function fallbackConfig(config, { images = false, tools = false } = {}) {
  const raw = config[original] || config;
  if (raw.modelFallbackEnabled === false) return null;
  const current = modelConfig(config);
  const candidates = (raw.modelProfiles || []).filter(p => p.apiKey && (!images || p.vision) && (!tools || p.tools)
    && !(p.provider === current.apiProvider && p.baseUrl === current.deepseekUrl && p.model === current.model));
  const profile = raw.modelFallbackProfileId ? candidates.find(p => p.id === raw.modelFallbackProfileId) : candidates.find(p => p.provider !== current.apiProvider);
  return profile ? modelConfig({ ...raw, modelRoutes: { ...raw.modelRoutes, [current.modelPurpose || 'chat']: profile.id } }, current.modelPurpose || 'chat') : null;
}
export const retryableModelError = error => !error.cancelled && (error.retryable === true || /上游 HTTP (429|5\d\d)|上游请求超时|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT/.test(error.message || ''));

<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { consoleKey } from '../composables/useConsole';
const c = inject(consoleKey);
const library = ref(null), routes = ref({}), editor = ref(null), editorOpen = ref(false), selected = ref(''), busy = ref(false), error = ref(''), notice = ref(''), remoteModels = ref([]), deleteArmed = ref(false), testResults = ref({});
const editorPanel = ref(null);
const customProvider = ref(false);
const customProviderName = ref('');
const names = { deepseek: 'DeepSeek', openai: 'OpenAI / 兼容服务', kimi: 'Kimi' };
const providerOptions = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'kimi', name: 'Kimi' },
  { id: 'custom', name: '+ 添加新的服务商接口（OpenAI 兼容）' }
];
const purposes = [
  { id: 'chat', name: '聊天回复', note: '群聊、私聊、定时问候和人格试聊的默认模型。' },
  { id: 'image', name: '图片识别', note: '收到 QQ 图片时使用，也用于人格头像核对。' },
  { id: 'video', name: '视频内容总结', note: '分析现有流程取得的抽帧、字幕和视频资料。' },
  { id: 'document', name: '文档生成', note: '撰写 DOCX、PDF、Markdown、TXT 正文，需要工具调用。' }
];
const presets = { deepseek: ['deepseek-flash', 'deepseek-v4-pro'], openai: ['gpt-6.1-sol', 'gpt-4.1-mini'], kimi: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed'] };
const saved = computed(() => library.value?.profiles.find(p => p.id === editor.value?.id));
const editorTestResult = computed(() => saved.value ? null : testResults.value[editor.value?.id]);
const listBusy = ref(false);
const models = computed(() => [...new Set([...(presets[editor.value?.provider] || []), ...remoteModels.value.map(m => m.id), ...(saved.value ? [saved.value.model] : [])])]);
const custom = ref(false);
const modelChoice = computed({ get: () => !custom.value && models.value.includes(editor.value?.model) ? editor.value.model : '__custom', set: value => { custom.value = value === '__custom'; if (!custom.value) editor.value.model = value; } });
const effortOptions = computed(() => editor.value?.provider === 'deepseek' ? ['auto', 'off', 'low', 'high', 'max'] : editor.value?.provider === 'kimi' ? ['auto', 'low', 'high', 'max'] : ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const fallbackEnabled = ref(true), fallbackProfileId = ref('');
const routeDirty = computed(() => fallbackEnabled.value !== library.value?.fallbackEnabled || fallbackProfileId.value !== library.value?.fallbackProfileId || JSON.stringify(routes.value) !== JSON.stringify(library.value?.routes));
const usedBy = computed(() => purposes.filter(p => library.value?.routes[p.id] === selected.value).map(p => p.name));
const profilePurposes = id => purposes.filter(p => library.value?.routes[p.id] === id).map(p => p.name);
let disposed = false, controller, session = 0;
const copy = value => JSON.parse(JSON.stringify(value));
function blank(provider = 'kimi') {
  return { id: `model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, name: '', provider,
    baseUrl: provider === 'kimi' ? 'https://api.moonshot.cn/v1' : provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.deepseek.com', apiKey: '', model: presets[provider][0], protocol: provider === 'openai' ? 'responses' : 'chat', vision: true, tools: true, search: true, effort: provider === 'kimi' ? 'low' : 'auto', maxTokens: 8192, unlimited: true };
}
const writable = p => { const { keyConfigured, ...value } = p; return value; };
function edit(id) {
  selected.value = id; remoteModels.value = []; custom.value = false; deleteArmed.value = false; editorOpen.value = true;
  if (id) {
    const item = copy(writable(library.value.profiles.find(p => p.id === id)));
    editor.value = { ...item, apiKey: '' };
    customProvider.value = item.provider === 'openai' && !/^https:\/\/api\.openai\.com(\/v1)?\/?$/i.test(item.baseUrl || '');
    customProviderName.value = customProvider.value && item.name?.includes(' · ') ? item.name.split(' · ')[0] : '';
  } else {
    editor.value = blank();
    customProvider.value = false;
    customProviderName.value = '';
  }
  nextTick(() => editorPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
}
const providerChoice = computed({
  get: () => customProvider.value ? 'custom' : (editor.value?.provider || 'kimi'),
  set: value => {
    if (!editor.value) return;
    if (value === 'custom') {
      customProvider.value = true;
      customProviderName.value = '';
      editor.value.provider = 'openai';
      Object.assign(editor.value, { baseUrl: '', model: '', protocol: 'chat', effort: 'auto', apiKey: '' });
      remoteModels.value = []; custom.value = true;
    } else {
      customProvider.value = false;
      customProviderName.value = '';
      editor.value.provider = value;
      const next = blank(value);
      Object.assign(editor.value, { baseUrl: next.baseUrl, model: next.model, protocol: next.protocol, effort: next.effort, apiKey: '' });
      remoteModels.value = []; custom.value = false;
    }
  }
});
async function request(path = '', method = 'GET', payload) {
  const started = session;
  controller = new AbortController(); const timer = setTimeout(() => controller.abort(), path.endsWith('/test') ? 70000 : 30000);
  try {
    const response = await fetch('/api/model-library' + path, { method, credentials: 'same-origin', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    const result = await response.json();
    if (disposed || started !== session) throw Object.assign(Error('会话已结束'), { name: 'StaleSession' });
    if (!response.ok) throw Error(result.error || '请求失败'); return result;
  } finally { clearTimeout(timer); }
}
async function act(fn) {
  const started = session;
  if (busy.value) return; busy.value = true; error.value = ''; notice.value = '';
  try { await fn(); } catch (e) { if (!disposed && started === session && e.name !== 'StaleSession') error.value = e.name === 'AbortError' ? '请求超时，请刷新确认保存状态后重试' : e.message; }
  finally { if (!disposed) busy.value = false; }
}
function accept(result, resetRoutes = false) {
  if (disposed) return;
  library.value = result;
  if (c.state.config) {
    c.state.config.modelProfiles = copy(result.profiles || []);
    c.state.config.modelRoutes = copy(result.routes || {});
  }
  if (resetRoutes) {
    routes.value = copy(result.routes);
    fallbackEnabled.value = result.fallbackEnabled;
    fallbackProfileId.value = result.fallbackProfileId;
  }
}
async function refresh() {
  await act(async () => { const result = await request(); if (disposed) return; accept(result, true); selected.value = result.profiles[0]?.id || ''; editor.value = null; editorOpen.value = false; });
}
function resolveProfileName(input) {
  if (input.name.trim()) return input.name.trim();
  const prefix = customProvider.value && customProviderName.value.trim() ? customProviderName.value.trim() : names[input.provider];
  return `${prefix} · ${input.model}`;
}
async function saveProfile() {
  await act(async () => {
    const input = copy(editor.value); input.name = resolveProfileName(input);
    const profiles = library.value.profiles.filter(p => p.id !== input.id).map(writable); profiles.push(input);
    const result = await request('', 'PUT', { revision: library.value.revision, profiles, routes: library.value.routes });
    if (disposed) return; accept(result); edit(input.id); notice.value = '模型已保存，现在可以在上方下拉框中分配给各项功能。';
  });
}
async function saveRoutes() {
  await act(async () => { const result = await request('', 'PUT', { revision: library.value.revision, profiles: library.value.profiles.map(writable), routes: routes.value, fallbackEnabled: fallbackEnabled.value, fallbackProfileId: fallbackProfileId.value }); accept(result, true); if (!disposed) notice.value = '功能分配已保存，对新请求生效。'; });
}
async function importExisting() {
  await act(async () => { const result = await request('/import', 'POST', { revision: library.value.revision }); accept(result); if (!disposed) { edit(result.profiles[0]?.id || ''); notice.value = '已有接口已导入，重复模型自动跳过；功能分配可在上方选择。'; } });
}
async function remove() {
  if (!deleteArmed.value) { deleteArmed.value = true; return; }
  await act(async () => {
    const result = await request('', 'PUT', { revision: library.value.revision, profiles: library.value.profiles.filter(p => p.id !== selected.value).map(writable), routes: library.value.routes });
    accept(result); if (!disposed) { edit(''); notice.value = '模型已删除。'; }
  });
}
function profilePayload() {
  const profile = copy(editor.value);
  profile.name = resolveProfileName(profile);
  return profile;
}
async function loadModels() {
  if (busy.value || listBusy.value || !editor.value) return;
  listBusy.value = true;
  await act(async () => {
    const isSaved = Boolean(saved.value);
    const path = isSaved ? `/${editor.value.id}/models` : '/models';
    const result = await request(path, 'POST', isSaved ? {} : { profile: profilePayload() });
    if (!disposed) { remoteModels.value = result.models; notice.value = `已获取 ${result.models.length} 个模型，请在模型下拉框选择后保存。`; }
  });
  listBusy.value = false;
}
async function runModelTest(id, isSaved, profile) {
  if (busy.value) return;
  testResults.value = { ...testResults.value, [id]: { status: 'pending', text: '正在请求模型（会产生少量 API 用量）…' } };
  await act(async () => {
    try {
      const result = await request(isSaved ? `/${id}/test` : '/test', 'POST', isSaved ? {} : { profile });
      if (!disposed) testResults.value = { ...testResults.value, [id]: { status: 'success', text: `已测试模型 ${result.model}：${result.text}` } };
    } catch (e) {
      if (!disposed && e.name !== 'StaleSession') testResults.value = { ...testResults.value, [id]: { status: 'error', text: e.name === 'AbortError' ? '请求超时，请稍后重试' : e.message } };
    }
  });
}
async function testModel() {
  if (!editor.value) return;
  const isSaved = Boolean(saved.value);
  await runModelTest(editor.value.id, isSaved, isSaved ? null : profilePayload());
}
async function testSavedModel(id) { await runModelTest(id, true, null); }
function allowed(profile, purpose) { return !(['image', 'video'].includes(purpose) && !profile.vision || purpose === 'document' && !profile.tools); }
watch(() => c.state.authenticated, value => { if (!value) { session++; controller?.abort(); library.value = null; editor.value = null; routes.value = {}; error.value = ''; notice.value = ''; testResults.value = {}; } else refresh(); });
onMounted(refresh); onBeforeUnmount(() => { disposed = true; controller?.abort(); });
</script>
<template>
  <div class="library-page">
    <p class="library-intro">在这里统一保存接口与模型，再将它们分配给各项功能。同一个模型可供多处复用，密钥只需在保存时填写。</p>
    <p v-if="error" class="library-alert error-text" role="alert">{{ error }} <button type="button" :disabled="busy" @click="refresh">重新载入已保存配置</button></p>
    <p v-if="notice" class="library-alert" role="status">{{ notice }}</p>
    <p v-if="!library && !error" role="status">正在读取模型库…</p>
    <template v-if="library">
      <form class="card panel form-panel" @submit.prevent="saveRoutes">
        <div class="panel-heading"><div><h2>功能模型分配</h2><p class="muted">先保存模型，再从下拉框中选择。</p></div><span class="subtle-tag">{{ library.profiles.length }} 个已保存模型</span></div>
        <fieldset :disabled="busy" class="library-fields">
          <div class="library-routes"><label v-for="purpose in purposes" :key="purpose.id">{{ purpose.name }}
            <select v-model="routes[purpose.id]" :aria-label="purpose.name + '使用的模型'">
              <option value="">{{ purpose.id === 'chat' ? '沿用原有接口设置' : '跟随聊天模型' }}</option>
              <option v-for="profile in library.profiles" :key="profile.id" :value="profile.id" :disabled="!allowed(profile, purpose.id)">{{ profile.name }} · {{ profile.model }}{{ allowed(profile, purpose.id) ? '' : '（能力不匹配）' }}</option>
            </select><small>{{ purpose.note }}</small>
          </label></div>
          <label class="library-check"><input v-model="fallbackEnabled" type="checkbox">API 超时、429 或 5xx 时自动切换一次备用模型</label>
          <label>备用模型<select v-model="fallbackProfileId"><option value="">自动选择其他服务商的可用模型</option><option v-for="profile in library.profiles" :key="profile.id" :value="profile.id">{{profile.name}} · {{profile.model}}</option></select></label>
          <p class="library-note">只切换一次；图片和文档请求会检查备用模型能力。取消、权限错误及参数错误不会触发切换。备用模型费用单独按实际渠道计入。</p>
          <p class="library-note">图片／视频同时要求生成文件时，使用“文档生成”模型，该模型还需支持图片输入。沿用原有接口时，含图片的请求仍使用原识图模型。功能开关继续在“能力开关”中管理。</p>
          <div class="library-actions"><span class="muted">{{ routeDirty ? '功能分配有未保存修改' : '当前分配已保存' }}</span><button class="primary" type="submit" :disabled="!routeDirty">保存功能分配</button></div>
        </fieldset>
      </form>
      <details class="card panel saved-models-panel" open>
        <summary class="saved-models-summary"><span><strong>已保存的模型</strong><small>点击折叠或展开，编辑和测试可直接在对应模型上操作。</small></span><span class="subtle-tag">{{ library.profiles.length }} 个</span></summary>
        <p v-if="!library.profiles.length" class="empty">还没有保存的模型，请在下方新增或导入原有接口。</p>
        <div v-else class="saved-model-list"><article v-for="profile in library.profiles" :key="profile.id" class="saved-model-item" :class="{ selected: selected === profile.id }">
          <div class="saved-model-main"><div class="saved-model-title"><strong>{{ profile.name }}</strong><code>{{ profile.model }}</code></div>
            <p>{{ names[profile.provider] }} · {{ profile.protocol === 'responses' ? 'Responses' : 'Chat Completions' }}</p>
            <div class="saved-model-tags"><span>{{ profile.vision ? '支持图片输入' : '仅文本' }}</span><span>{{ profile.tools ? '支持工具调用' : '无工具调用' }}</span><span v-if="profile.keyConfigured">密钥已保存</span><span v-if="profilePurposes(profile.id).length">用于：{{ profilePurposes(profile.id).join('、') }}</span><span v-else>未直接分配</span></div>
          </div>
          <div class="saved-model-actions"><button type="button" class="secondary" :disabled="busy" @click="edit(profile.id)">编辑</button><button type="button" class="secondary" :disabled="busy" @click="testSavedModel(profile.id)">{{ testResults[profile.id]?.status === 'pending' ? '测试中…' : '测试' }}</button></div>
          <p v-if="testResults[profile.id]" class="saved-model-result" :class="{ 'error-text': testResults[profile.id].status === 'error' }" :role="testResults[profile.id].status === 'error' ? 'alert' : 'status'">{{ testResults[profile.id].text }}</p>
        </article></div>
        <div class="saved-models-footer"><button type="button" class="secondary" :disabled="busy" @click="edit('')">+ 添加新模型 / 服务商接口</button></div>
      </details>
      <article ref="editorPanel" class="card panel form-panel">
        <div class="panel-heading"><h2>编辑或新增模型</h2><div class="library-actions"><button type="button" class="text-button" :disabled="busy" @click="importExisting">导入原有接口</button><button type="button" class="secondary" :disabled="busy" @click="edit('')">+ 新增模型 / 服务商</button></div></div>
        <form v-if="editor && editorOpen" @submit.prevent="saveProfile">
          <fieldset :disabled="busy" class="library-fields">
            <div class="library-routes">
              <label>配置名称<input v-model="editor.name" maxlength="80" placeholder="例如：Gemini · 聊天 / Kimi · 视频总结"><small>用于功能下拉框，可区分同一家服务的多个模型。</small></label>
              <label>接口服务商<select v-model="providerChoice"><option v-for="opt in providerOptions" :key="opt.id" :value="opt.id">{{ opt.name }}</option></select><input v-if="customProvider" v-model="customProviderName" aria-label="新服务商名称" maxlength="40" placeholder="输入新服务商名称（如 Gemini、OpenRouter、硅基流动）"><small>{{ customProvider ? '支持任何 OpenAI 兼容格式的新服务商，填写名称后在下方输入接口地址与密钥。' : '选择内置服务商，或选最后一项添加自定义服务商接口。' }}</small></label>
              <label>API 基础地址<input v-model="editor.baseUrl" type="url" required maxlength="2048" :placeholder="customProvider ? 'https://your-api.example.com/v1' : ''"><small>填写基础地址，不附加 /chat/completions 或 /responses。</small></label>
              <label>API Key<input v-model="editor.apiKey" type="password" :required="!saved?.keyConfigured" maxlength="2048" autocomplete="new-password" :placeholder="saved?.keyConfigured ? '已配置，留空保留原密钥' : '填写此接口的密钥'"><small>不会回显。更换服务商或地址后需重新填写。</small></label>
              <label>模型<select v-model="modelChoice"><option v-for="id in models" :key="id" :value="id">{{ id }}</option><option value="__custom">自定义模型 ID…</option></select><input v-if="modelChoice === '__custom'" v-model="editor.model" aria-label="自定义模型 ID" required maxlength="100" placeholder="填写服务商提供的模型 ID"><small>预设不代表账号已获权限；可先获取接口模型列表，也可填写模型 ID 后直接测试。</small></label>
              <label>调用协议<select v-model="editor.protocol" :disabled="editor.provider !== 'openai'"><option value="chat">Chat Completions</option><option v-if="editor.provider === 'openai'" value="responses">Responses（GPT-6.1 Sol 推荐）</option></select><small>GPT-6 系列工具调用使用 Responses。</small></label>
              <label>思考强度<select v-model="editor.effort"><option v-for="effort in effortOptions" :key="effort" :value="effort">{{ ({ auto: '模型默认', off: '关闭', none: '关闭', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高' })[effort] }}</option></select><small>{{ editor.provider === 'kimi' ? 'K3.1 Pro 始终思考，可选择低、高、最高。' : '选择该模型支持的强度；不确定时使用模型默认。' }}</small></label>
              <label>最大输出 Token<input v-model.number="editor.maxTokens" type="number" min="64" max="99999999" :disabled="editor.unlimited" :required="!editor.unlimited"><span class="library-check"><input v-model="editor.unlimited" type="checkbox">使用接口默认上限</span><small>勾选后不传预算参数，仍受模型自身上限约束。</small></label>
            </div>
            <div class="library-capabilities"><label class="library-check"><input v-model="editor.vision" type="checkbox">此模型支持图片输入</label><label class="library-check"><input v-model="editor.tools" type="checkbox">此模型支持工具调用／文档生成</label><label class="library-check"><input v-model="editor.search" type="checkbox">允许此模型联网搜索</label></div>
            <p class="library-note">能力以实际接口支持为准。视频总结沿用抽帧与字幕。每套模型的思考与 Token 设置独立生效，其余回复规则共用。联网搜索还受“能力开关”总开关和服务商支持范围限制：OpenAI Responses 使用原生 web_search，Kimi 官方接口使用 tools/search，其他兼容服务可回退到已保存的 DeepSeek 搜索接口。</p>
            <div class="library-actions"><button type="button" class="secondary" :disabled="busy || listBusy" @click="loadModels">{{ listBusy ? '获取中…' : saved ? '获取已保存接口的模型列表' : '获取模型列表' }}</button><button type="button" class="secondary" :disabled="busy" @click="testModel()">{{ editorTestResult?.status === 'pending' ? '测试中…' : saved ? '测试已保存模型' : '测试模型' }}</button><button class="primary" type="submit">{{ busy ? '处理中…' : '保存模型' }}</button></div>
            <p v-if="editorTestResult" class="library-alert editor-test-result" :class="{ 'error-text': editorTestResult.status === 'error' }" :role="editorTestResult.status === 'error' ? 'alert' : 'status'">{{ editorTestResult.text }}</p>
            <div v-if="selected" class="library-actions"><small>{{ usedBy.length ? `当前用于：${usedBy.join('、')}。删除前请先更改功能分配。` : '此模型暂未被功能直接引用。' }}</small><button type="button" class="text-button" :disabled="usedBy.length > 0" @click="remove">{{ deleteArmed ? '确认删除这个模型' : '删除模型' }}</button></div>
          </fieldset>
        </form>
      </article>
      <div v-if="!editorOpen" class="saved-models-footer"><button type="button" class="primary" :disabled="busy" @click="edit('')">+ 添加新模型 / 服务商接口</button></div>
    </template>
  </div>
</template>
<style scoped>
.library-page { display:grid;gap:20px; }.library-intro,.library-note { color:var(--muted);font-size:13px;line-height:1.8;margin:0; }.library-note { margin:14px 0; }.library-fields { border:0;padding:0;margin:0;min-width:0; }.library-routes { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 24px; }.library-routes label { min-width:0; }.library-routes select,.library-picker select { width:100%;text-overflow:ellipsis; }.library-actions,.library-capabilities { display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:18px; }.library-actions .primary { margin-left:auto; }.library-check { display:flex!important;align-items:center;gap:8px;font-size:13px;margin:10px 0!important; }.library-check input { width:16px!important;height:16px;flex-shrink:0; }.library-picker { display:flex;gap:16px;align-items:center; }.library-picker label { flex:1;min-width:0; }.library-alert { margin:0;padding:14px 18px;border-radius:12px;background:var(--soft);overflow-wrap:anywhere;line-height:1.7; }.library-alert button { margin-left:8px; }.library-page small { line-height:1.7; }.library-page .panel-heading { gap:16px;flex-wrap:wrap; }
.saved-models-summary { display:flex;align-items:center;gap:16px;cursor:pointer;list-style:none; }.saved-models-summary::marker { content:""; }.saved-models-summary::-webkit-details-marker { display:none; }.saved-models-summary>.subtle-tag { flex:0 0 auto;white-space:nowrap; }.saved-models-summary>span:first-child { flex:1;min-width:0;display:flex;flex-direction:column;gap:5px; }.saved-models-summary strong { font-size:17px; }.saved-models-summary small { color:var(--muted);font-size:12px; }.saved-models-summary::after { flex:0 0 auto;content:'⌄';color:var(--accent);font-size:20px;transition:transform .15s; }.saved-models-panel:not([open]) .saved-models-summary::after { transform:rotate(-90deg); }.saved-models-panel[open] .saved-models-summary { margin-bottom:20px; }
.saved-model-list { display:grid;gap:12px; }.saved-model-item { display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:18px;padding:16px 18px;border:1px solid var(--line);border-radius:12px;background:var(--surface); }.saved-model-item.selected { border-color:var(--accent);background:var(--soft); }.saved-model-main { min-width:0; }.saved-model-title { display:flex;align-items:baseline;gap:10px;flex-wrap:wrap; }.saved-model-title strong { font-size:15px;overflow-wrap:anywhere; }.saved-model-title code { color:var(--accent);font-size:12px;overflow-wrap:anywhere; }.saved-model-main p { margin:6px 0 10px;color:var(--muted);font-size:12px; }.saved-model-tags { display:flex;gap:6px 12px;flex-wrap:wrap;color:var(--muted);font-size:11px; }.saved-model-tags span { padding:3px 7px;border-radius:6px;background:var(--soft); }.saved-model-actions { display:flex;gap:8px;flex-shrink:0; }
.saved-model-result { grid-column:1/-1;margin:0;padding-top:12px;border-top:1px solid var(--line);font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere; }.saved-models-footer { display:flex;justify-content:center;margin-top:16px;padding-top:16px;border-top:1px solid var(--line); }.editor-test-result { margin-top:14px;white-space:pre-wrap; }
@media(max-width:750px) { .saved-model-item { align-items:flex-start;grid-template-columns:minmax(0,1fr); }.saved-model-result { grid-column:1; }.saved-model-actions { width:100%; }.saved-model-actions button { flex:1; } }
@media(max-width:750px) { .library-routes { grid-template-columns:1fr; }.library-actions .primary { margin-left:0; }.library-picker { align-items:flex-end; }.library-actions button { flex:1; }.library-page .form-panel { padding:20px; } }
</style>

<script setup>
import { computed, inject, nextTick, ref, watch } from 'vue';
import ModelLibraryPanel from './ModelLibraryPanel.vue';
import ApiBillingPanel from './ApiBillingPanel.vue';
import { consoleKey, configPatch } from '../composables/useConsole';
const c = inject(consoleKey);
const view = computed({
  get: () => {
    const current = c.state.modelTab || 'library';
    return current === 'basic' ? 'library' : current;
  },
  set: value => { c.state.modelTab = value; }
});
const tabs = { library: '模型库与分配', capabilities: '能力开关', rules: '响应规则', usage: '用量与计费' };
const editableKeys = ['webSearchEnabled', 'imageRecognitionEnabled', 'documentGenerationEnabled', 'memoryEnabled', 'contextTurns', 'cooldownSeconds', 'timeoutSeconds', 'timeoutUnlimited', 'maxPromptLength', 'maxReplyLength'];
const effectiveRoutes = computed(() => {
  const cfg = c.state.config || {};
  const profiles = cfg.modelProfiles || [];
  const routes = cfg.modelRoutes || {};
  const chatProfile = routes.chat ? profiles.find(p => p.id === routes.chat) : null;
  const legacyIsOpenAI = cfg.apiProvider === 'openai';
  const legacyChatModel = (legacyIsOpenAI ? cfg.openaiModel : cfg.model) || '未配置';
  const legacyVisionModel = (legacyIsOpenAI ? (cfg.openaiVisionModel || cfg.openaiModel) : cfg.visionModel) || legacyChatModel;
  const items = [
    { key: 'chat', label: '聊天回复', legacyModel: legacyChatModel },
    { key: 'image', label: '图片识别', legacyModel: legacyVisionModel },
    { key: 'video', label: '视频总结', legacyModel: legacyChatModel },
    { key: 'document', label: '文档生成', legacyModel: legacyChatModel }
  ];
  return items.map(item => {
    const directId = routes[item.key];
    const directProfile = directId ? profiles.find(p => p.id === directId) : null;
    const active = directProfile || chatProfile;
    if (active) {
      return {
        key: item.key,
        label: item.label,
        model: active.model,
        name: active.name,
        source: directProfile ? '模型库' : '跟随聊天',
        isLibrary: true
      };
    }
    return {
      key: item.key,
      label: item.label,
      model: item.legacyModel,
      name: legacyIsOpenAI ? 'OpenAI 兼容' : 'DeepSeek',
      source: '兼容接口',
      isLibrary: false
    };
  });
});
const dirtyCount = computed(() => Object.entries(configPatch(c.state.model, editableKeys)).filter(([key, value]) => value !== (c.state.config[key] ?? '')).length);
const dirty = computed(() => dirtyCount.value > 0);
async function resetModel() {
  if (!await c.askConfirmation({ title: '撤销全部模型修改？', description: '将恢复为当前已保存的全局能力与响应规则。', detail: `本页有 ${dirtyCount.value} 项未保存修改，撤销后将无法恢复。`, confirmText: '撤销全部修改', tone: 'danger' })) return;
  for (const key of editableKeys) c.state.model[key] = c.state.config[key] ?? '';
}
const modelSettings = ref(null);
async function revealInvalid(event) {
  const form = event.target.form;
  if (form?.querySelector(':invalid') !== event.target) return;
  view.value = event.target.closest('[data-model-section]')?.dataset.modelSection || 'capabilities';
  await nextTick(); event.target.focus();
}
function toggleTimeout() {
  if (!Number.isInteger(c.state.model.timeoutSeconds) || c.state.model.timeoutSeconds < 5 || c.state.model.timeoutSeconds > 180) c.state.model.timeoutSeconds = 180;
  c.state.model.timeoutUnlimited = !c.state.model.timeoutUnlimited;
}
</script>

<template>
  <section id="page-model" class="page">
    <div class="page-heading"><div><span class="eyebrow">MAKE IT YOURS</span><h1>设定它的回答方式<span class="title-dot">.</span></h1><p class="muted">模型分配、全局能力开关与响应规则，在这里分层管理。</p></div></div>
    <div class="effective-banner" aria-label="当前生效模型总览">
      <div v-for="item in effectiveRoutes" :key="item.key" class="effective-chip" :class="{ library: item.isLibrary }">
        <span class="effective-label">{{ item.label }}</span>
        <strong class="effective-model">{{ item.model }}</strong>
        <span class="effective-source">{{ item.source }}</span>
      </div>
    </div>
    <nav class="section-tabs" aria-label="模型设置分类"><button v-for="(name, key) in tabs" :key="key" type="button" :aria-pressed="view === key" @click="view = key">{{ name }}</button></nav>
    <ModelLibraryPanel v-show="view === 'library'" />
    <ApiBillingPanel v-if="view === 'usage'" />
    <form v-show="view !== 'library' && view !== 'usage'" @submit.prevent="c.saveModel" @invalid.capture="revealInvalid" id="model-form">
      <article ref="modelSettings" class="card model-picker">
        <div class="model-settings">
        <div v-show="view === 'capabilities'" data-model-section="capabilities">
        <div class="panel-heading"><h2>全局能力开关</h2><span class="subtle-tag">对所有模型统一生效</span></div>
        <p class="scope-notice">这里控制机器人的全局功能权限。单模型的思考强度、最大输出 Token 与协议请在「模型库与分配」的对应模型档案中单独调整。</p>
        <div class="vision-settings">
          <label class="capability-toggle"><input v-model="c.state.model.webSearchEnabled" name="webSearchEnabled" type="checkbox"><span>联网搜索与找图<small>结合最多 5 条搜索结果回答；群内 @机器人或在授权私聊说「找一张…的图片」可读取最多 3 个网页并发送相关图片，每次最多 3 张、单张最多 6 MiB。同时受所选模型档案是否允许联网的限制；这是搜索已有图片，非 AI 绘图。</small></span></label>
        </div>
        <div class="vision-settings">
          <label class="capability-toggle"><input v-model="c.state.model.imageRecognitionEnabled" name="imageRecognitionEnabled" type="checkbox"><span>图片识别<small>群内 @机器人并附图或引用图片；授权私聊直接附图或引用图片。每次最多 4 张，优先读取 QQ 原图；大图自动附加无损细节切片，便于识别小字。支持 JPEG、PNG、GIF、WebP。具体使用的识图模型请在「模型库与分配」指定。</small></span></label>
        </div>
        <div class="vision-settings"><label class="capability-toggle"><input v-model="c.state.model.documentGenerationEnabled" name="documentGenerationEnabled" type="checkbox"><span>文档生成<small>群内 @机器人或在授权私聊说「生成一份 Word 文档」「把上面的内容导出为 PDF」，由当前分配的文档模型撰写并发送文件。支持 DOCX、PDF、Markdown、TXT，可一次导出多个格式。单份最多 10 MiB，不受聊天回复字数限制；需要支持工具调用的模型；群聊还需群文件上传权限。</small></span></label></div>
        <div class="vision-settings">
          <label class="capability-toggle"><input v-model="c.state.model.memoryEnabled" name="memoryEnabled" type="checkbox"><span>携带聊天上下文<small>每位 QQ 用户的私聊、各群对话拥有独立记忆，只引用成功发送的对话。聊天记录重启后保留；携带历史会增加输入 Token。</small></span></label>
          <label v-if="c.state.model.memoryEnabled" class="reasoning-field">最多携带的历史轮数<input v-model.number="c.state.model.contextTurns" name="contextTurns" type="number" min="1" max="50" required><small>默认 10 轮，历史上下文总长最多 24,000 字符；「聊天记录」可为某位用户开启新话题，历史记录保留。</small></label>
        </div>
        </div><section v-show="view === 'rules'" data-model-section="rules" class="response-rules" aria-labelledby="response-rules-title"><div class="panel-heading"><h2 id="response-rules-title">响应规则</h2><span class="subtle-tag">群聊 @ · 白名单私聊 · 全局生效</span></div>
          <div class="field-grid"><label><span class="rule-field-title">用户冷却时间 / 秒</span><input v-model.number="c.state.model.cooldownSeconds" name="cooldownSeconds" type="number" min="0" max="3600" required></label>
            <div class="token-budget"><div class="token-heading"><label for="api-timeout">API 超时 / 秒</label><button type="button" class="unlimited-button" :class="{ selected: c.state.model.timeoutUnlimited }" :aria-pressed="Boolean(c.state.model.timeoutUnlimited)" aria-label="API 超时无上限" @click="toggleTimeout">无上限</button></div><input id="api-timeout" v-model.number="c.state.model.timeoutSeconds" name="timeoutSeconds" type="number" min="5" max="180" :disabled="c.state.model.timeoutUnlimited" :required="!c.state.model.timeoutUnlimited"><small>{{ c.state.model.timeoutUnlimited ? '不设置模型请求的本地超时，暂停机器人或撤销授权仍会取消请求；接口与网络自身的超时仍有效。' : '模型请求超过此秒数后取消；可点击无上限取消本地计时器。' }}</small></div>
            <label><span class="rule-field-title">问题最大字数</span><input v-model.number="c.state.model.maxPromptLength" name="maxPromptLength" type="number" min="1" max="20000" required></label>
            <label><span class="rule-field-title">回复最大字数</span><input v-model.number="c.state.model.maxReplyLength" name="maxReplyLength" type="number" min="100" max="10000" required><small>QQ 消息超出此长度时截断；单模型的输出 Token 上限请在「模型库与分配」调整。</small></label>
          </div>
          <div class="group-auth"><div><span>群聊白名单</span><small>{{ c.state.config.allowedGroups?.length ? `已授权 ${c.state.config.allowedGroups.length} 个群，可逐群设置模型与视频开关。` : '尚未授权任何群，机器人不会响应任何群消息。' }}</small></div><button type="button" class="text-button" @click="c.navigate('groups')">管理群聊授权 ↗</button></div>
          <div class="group-auth"><div><span>私聊白名单</span><small>已授权 {{ c.state.config.allowedPrivateUsers?.length || 0 }} 个 QQ，直接私聊即可调用模型，无需 @。</small></div><button type="button" class="text-button" @click="c.navigate('private')">管理私聊授权 ↗</button></div>
          <div class="callout"><b>保持简单，减少打扰</b><p>模型记录授权群中的 @、实际接话与续聊，以及白名单私聊，上下文按会话和用户隔离。群命令和未 @ 的平台链接继续由插件处理；@ 他人或引用他人的消息不触发续聊。暂停或关闭群内 DS 会停止自主聊天。</p></div>
        </section>

        </div>
      </article>
      <div class="save-bar model-save-bar"><span class="muted"><b v-if="dirty" class="draft-marker">有 {{ dirtyCount }} 项未保存修改</b><template v-else>设置已保存</template> · 对新请求生效</span><div><button v-if="dirty" type="button" class="text-button" :disabled="c.state.busy.model" @click="resetModel">撤销修改</button><button class="primary" type="submit" :disabled="c.state.busy.model || !dirty">{{ c.state.busy.model ? '保存中…' : '保存配置 ↗' }}</button></div></div>
    </form>
  </section>
</template>

<style scoped>
.effective-banner { display: grid; grid-template-columns: repeat(auto-fit, minmax(175px, 1fr)); gap: 10px; margin-bottom: 18px; }
.effective-chip { display: flex; flex-direction: column; gap: 4px; padding: 11px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface, #fff); min-width: 0; }
.effective-chip.library { border-color: rgba(109, 153, 112, 0.45); background: rgba(109, 153, 112, 0.06); }
.effective-label { font-size: 11px; color: var(--muted); }
.effective-model { font-size: 13px; font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.effective-source { font-size: 10px; color: var(--green); }
.effective-chip:not(.library) .effective-source { color: var(--muted); }
.scope-notice { margin: 12px 0 18px; padding: 11px 14px; border-radius: 9px; background: var(--soft); color: var(--muted); font-size: 12px; line-height: 1.65; }
.legacy-params { border-top: 1px solid var(--line); margin-top: 26px; padding-top: 22px; }
.legacy-params .panel-heading h3 { margin: 0; font-size: 15px; }
.legacy-cap-grid { border-top: 0; padding-top: 0; margin-top: 16px; }
.api-provider { margin-bottom: 24px; }.api-provider .field-grid { margin-top: 18px; }
.model-picker { margin-bottom: 24px; }
.model-summary { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 24px 28px; cursor: pointer; list-style: none; }
.model-summary::-webkit-details-marker { display: none; }.model-summary:focus-visible { outline: 2px solid var(--green); outline-offset: -3px; border-radius: 16px; }
.summary-copy { min-width: 0; }.summary-title { display: block; font-size: 16px; font-weight: 650; margin-bottom: 10px; }
.summary-saved { display: flex; align-items: baseline; flex-wrap: wrap; gap: 7px 14px; font-size: 10px; color: var(--muted); }.summary-saved strong { font-size: 13px; font-weight: 550; color: var(--green); }.summary-saved code { font-size: 10px; overflow-wrap: anywhere; }
.disclosure { display: flex; align-items: center; gap: 10px; white-space: nowrap; color: var(--green); font-size: 11px; }.chevron { font-size: 20px; }
.when-open { display: none; }.model-picker[open] .when-open { display: inline; }.model-picker[open] .when-closed { display: none; }.model-picker[open] .chevron { transform: rotate(180deg); }
.model-settings { border-top: 1px solid var(--line); padding: 26px 28px; }.model-settings .panel-heading { margin-bottom: 16px; }
.advanced-endpoint { margin-top: 20px; color: var(--muted); font-size: 11px; }.advanced-endpoint>summary { cursor: pointer; }.advanced-endpoint label { display: block; margin-top: 18px; color: var(--ink); }
.model-settings small { display: block; color: var(--muted); font-size: 10px; line-height: 1.8; margin-top: 6px; font-weight: 400; }
.model-option code { font-size: 11px; overflow-wrap: anywhere; }
.model-list-note { font-size: 11px; color: var(--muted); margin: 18px 0; }
.model-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
.model-option { display: flex; align-items: center; gap: 10px; padding: 16px; border: 1px solid var(--line); border-radius: 9px; cursor: pointer; }
.model-option.selected { border-color: #6d9970; background: var(--soft); }
.model-option input { width: 16px; height: 16px; margin: 0; flex-shrink: 0; accent-color: var(--green); }
.model-option strong { display: block; font-size: 13px; font-weight: 550; }
.model-option code, .model-option small { display: block; margin-top: 7px; color: var(--muted); font-size: 10px; }
.saved-tag { margin-left: auto; font-size: 9px; color: var(--green); white-space: nowrap; }
.custom-model { display: block; margin-top: 20px; font-size: 12px; }
.group-auth { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 22px 0; padding: 16px 18px; border: 1px solid var(--line); border-radius: 9px; background: #fbfcff; }
.group-auth span { display: block; font-size: 12px; font-weight: 550; }
.group-auth small { margin-top: 6px; }
.model-picker-footer { display: flex; align-items: center; justify-content: space-between; gap: 15px; margin-top: 20px; font-size: 11px; color: var(--muted); }
.response-rules { border-top:1px solid var(--line); padding-top:24px; margin-top:24px; }.token-budget { margin:18px 0; min-width:0; }.token-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:36px; margin-bottom:8px; }.token-heading label { margin:0; }.unlimited-button { border:1px solid var(--line); background:#fff; color:var(--green); border-radius:7px; padding:7px 12px; font-size:11px; white-space:nowrap; min-height:36px; }.unlimited-button.selected { background:var(--soft); border-color:var(--green); }.token-budget input:disabled { color:var(--muted); background:#f2f4f0; }.response-rules .field-grid { align-items:start; }
.rule-field-title { display:flex; align-items:center; min-height:36px; margin-bottom:8px; }
@media(max-width:650px) { .model-options { grid-template-columns: 1fr; } .model-picker-footer { align-items: flex-start; flex-direction: column; } }
.model-capabilities { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; border-top: 1px solid var(--line); padding-top: 24px; margin-top: 24px; }
.vision-settings { border-top: 1px solid var(--line); padding-top: 24px; margin-top: 24px; }.vision-settings .reasoning-field { max-width: 720px; }
.capability-toggle { display: flex; align-items: flex-start; gap: 10px; font-size: 12px; font-weight: 550; }
.form-panel .capability-toggle { display: flex; }.reasoning-field { display: block; font-size: 12px; margin: 18px 0 0 26px; }.memory-settings { border-top: 1px solid var(--line); margin-top: 22px; }
.capability-toggle input { width: 16px; height: 16px; margin: 2px 0 0; flex-shrink: 0; accent-color: var(--green); }
.capability-toggle span { line-height: 1.6; }
.capability-toggle small { margin-top: 4px; }
@media(max-width:650px) { .model-summary { padding: 20px; gap: 12px; }.model-settings { padding: 20px; }.model-capabilities { grid-template-columns: 1fr; }.disclosure { font-size: 10px; gap: 5px; } }
@media(max-width:650px) {
  .model-option { padding: 14px 12px; }.model-option>span { min-width: 0; }
  .model-option strong, .model-option small { overflow-wrap: anywhere; }
  .model-settings small, .model-list-note { font-size: 11px; }
  .model-picker-footer { align-items: stretch; }.model-picker-footer>button { width: 100%; }
  .model-summary { align-items: flex-start; }.disclosure { padding-top: 2px; }
  .group-auth { flex-wrap: wrap; }.capability-toggle { min-height: 44px; }
}
</style>

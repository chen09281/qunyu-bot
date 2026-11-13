<script setup>
import { ref, onMounted, inject } from 'vue';
import { consoleKey } from '../composables/useConsole';
import WorkspaceIcon from './WorkspaceIcon.vue';

const c = inject(consoleKey);

const loading = ref(false);
const config = ref({
  enabled: false,
  defaultCharacterId: '',
  emotionScopeMode: 'group',
  groupBindings: {},
  userBindings: {}
});
const bindGroupId = ref('');
const bindGroupCharId = ref('');
const bindUserId = ref('');
const bindUserCharId = ref('');
const characters = ref([]);
const selectedChar = ref(null);
const modalTab = ref('settings');
const emotionsData = ref(null);
const emotionsLoading = ref(false);
const triggersDraft = ref([]);
const triggersSaving = ref(false);
const stickerInput = ref(null);
const stickerTargetRuleId = ref('');
const fileInput = ref(null);
const uploadError = ref('');
const saving = ref(false);

async function loadData() {
  loading.value = true;
  try {
    const [cfg, chars] = await Promise.all([
      c.api('tavern/config'),
      c.api('tavern/characters')
    ]);
    config.value = cfg;
    characters.value = chars.characters || [];
  } catch (err) {
    c.notify(err.message, true);
  } finally {
    loading.value = false;
  }
}

async function toggleEnabled() {
  config.value.enabled = !config.value.enabled;
  await saveConfig();
}

async function saveConfig() {
  try {
    const updated = await c.api('tavern/config', {
      method: 'PUT',
      body: JSON.stringify(config.value)
    });
    config.value = { emotionScopeMode: 'group', ...updated };
    c.notify('酒馆配置已保存');
  } catch (err) {
    c.notify(err.message, true);
  }
}

function charNameById(id) {
  return characters.value.find(ch => ch.id === id)?.name || id;
}

async function addGroupBinding() {
  const gid = bindGroupId.value.trim();
  const cid = bindGroupCharId.value || characters.value[0]?.id || '';
  if (!/^\d{5,20}$/.test(gid)) { c.notify('请输入有效的 5-20 位群号', true); return; }
  if (!cid) { c.notify('请先选择角色卡', true); return; }
  config.value.groupBindings = { ...(config.value.groupBindings || {}), [gid]: cid };
  await saveConfig();
  bindGroupId.value = '';
}

async function removeGroupBinding(gid) {
  const next = { ...(config.value.groupBindings || {}) };
  delete next[gid];
  config.value.groupBindings = next;
  await saveConfig();
}

async function addUserBinding() {
  const uid = bindUserId.value.trim();
  const cid = bindUserCharId.value || characters.value[0]?.id || '';
  if (!/^\d{5,20}$/.test(uid)) { c.notify('请输入有效的 5-20 位 QQ 号', true); return; }
  if (!cid) { c.notify('请先选择角色卡', true); return; }
  config.value.userBindings = { ...(config.value.userBindings || {}), [uid]: cid };
  await saveConfig();
  bindUserId.value = '';
}

async function removeUserBinding(uid) {
  const next = { ...(config.value.userBindings || {}) };
  delete next[uid];
  config.value.userBindings = next;
  await saveConfig();
}

async function setDefault(id) {
  config.value.defaultCharacterId = id;
  await saveConfig();
  await loadData();
}

async function loadEmotions(id) {
  emotionsLoading.value = true;
  try {
    emotionsData.value = await c.api(`tavern/characters/${id}/emotions`);
    triggersDraft.value = JSON.parse(JSON.stringify(emotionsData.value?.triggers || []));
  } catch (err) {
    c.notify(err.message, true);
  } finally {
    emotionsLoading.value = false;
  }
}

function addTriggerRule(template = null) {
  const id = `trig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  triggersDraft.value.push({
    id,
    enabled: true,
    name: template?.name || '新情绪触发规则',
    metric: template?.metric || 'affection',
    operator: template?.operator || '>=',
    threshold: template?.threshold ?? 80,
    promptHint: template?.promptHint || '',
    sticker: null,
    stickerCooldown: template?.stickerCooldown ?? 3
  });
}

function applyTriggerTemplates() {
  const templates = emotionsData.value?.triggerTemplates || [];
  for (const tpl of templates) {
    if (!triggersDraft.value.some(t => t.name === tpl.name && t.metric === tpl.metric)) {
      addTriggerRule(tpl);
    }
  }
}

function removeTriggerRule(idx) {
  triggersDraft.value.splice(idx, 1);
}

async function saveTriggers(quiet = false) {
  if (!selectedChar.value) return;
  triggersSaving.value = true;
  try {
    const res = await c.api(`tavern/characters/${selectedChar.value.id}/triggers`, {
      method: 'PUT',
      body: JSON.stringify({ triggers: triggersDraft.value })
    });
    triggersDraft.value = JSON.parse(JSON.stringify(res.triggers || []));
    if (emotionsData.value) emotionsData.value.triggers = res.triggers || [];
    if (!quiet) c.notify('情绪触发规则已保存');
  } catch (err) {
    c.notify(err.message, true);
  } finally {
    triggersSaving.value = false;
  }
}

async function chooseSticker(ruleId) {
  if (!selectedChar.value) return;
  await saveTriggers(true);
  stickerTargetRuleId.value = ruleId;
  stickerInput.value?.click();
}

function handleStickerFile(e) {
  const file = e.target.files?.[0];
  const ruleId = stickerTargetRuleId.value;
  if (!file || !ruleId || !selectedChar.value) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const base64 = reader.result.split(',')[1];
      const res = await c.api(`tavern/characters/${selectedChar.value.id}/triggers/${ruleId}/sticker`, {
        method: 'POST',
        body: JSON.stringify({ base64, mimeType: file.type || 'image/png' })
      });
      triggersDraft.value = JSON.parse(JSON.stringify(res.triggers || []));
      if (emotionsData.value) emotionsData.value.triggers = res.triggers || [];
      c.notify('触发表情包已上传');
    } catch (err) {
      c.notify(err.message, true);
    } finally {
      if (stickerInput.value) stickerInput.value.value = '';
    }
  };
  reader.readAsDataURL(file);
}

async function removeSticker(ruleId) {
  if (!selectedChar.value) return;
  try {
    const res = await c.api(`tavern/characters/${selectedChar.value.id}/triggers/${ruleId}/sticker`, {
      method: 'DELETE'
    });
    triggersDraft.value = JSON.parse(JSON.stringify(res.triggers || []));
    if (emotionsData.value) emotionsData.value.triggers = res.triggers || [];
    c.notify('已移除触发表情包');
  } catch (err) {
    c.notify(err.message, true);
  }
}

async function resetEmotions(scopeKey = '') {
  if (!selectedChar.value) return;
  const label = scopeKey ? `会话 ${scopeKey}` : '全部会话';
  if (!confirm(`确定要重置角色「${selectedChar.value.name}」在${label}的情绪指标吗？`)) return;
  try {
    const res = await c.api(`tavern/characters/${selectedChar.value.id}/emotions/reset`, {
      method: 'POST',
      body: JSON.stringify({ scopeKey })
    });
    if (emotionsData.value) emotionsData.value.sessions = res.sessions || [];
    c.notify(`已重置${label}的情绪指标`);
  } catch (err) {
    c.notify(err.message, true);
  }
}

async function openDetails(id, tab = 'settings') {
  try {
    modalTab.value = tab;
    emotionsData.value = null;
    selectedChar.value = await c.api(`tavern/characters/${id}`);
    void loadEmotions(id);
  } catch (err) {
    c.notify(err.message, true);
  }
}

function closeDetails() {
  selectedChar.value = null;
  emotionsData.value = null;
}

async function saveSelectedChar() {
  if (!selectedChar.value) return;
  saving.value = true;
  try {
    await c.api(`tavern/characters/${selectedChar.value.id}`, {
      method: 'PUT',
      body: JSON.stringify(selectedChar.value)
    });
    c.notify(`角色「${selectedChar.value.name}」已更新`);
    closeDetails();
    await loadData();
  } catch (err) {
    c.notify(err.message, true);
  } finally {
    saving.value = false;
  }
}

async function deleteChar(id, name) {
  if (!confirm(`确定要删除角色「${name}」吗？`)) return;
  try {
    await c.api(`tavern/characters/${id}`, { method: 'DELETE' });
    c.notify(`角色「${name}」已删除`);
    if (selectedChar.value?.id === id) closeDetails();
    await loadData();
  } catch (err) {
    c.notify(err.message, true);
  }
}

function triggerUpload() {
  fileInput.value?.click();
}

async function handleFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  uploadError.value = '';

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const base64 = reader.result.split(',')[1];
      const res = await c.api('tavern/characters/upload', {
        method: 'POST',
        body: JSON.stringify({ base64 })
      });
      c.notify(`成功导入角色「${res.name}」！`);
      await loadData();
    } catch (err) {
      uploadError.value = err.message;
      c.notify(err.message, true);
    } finally {
      if (fileInput.value) fileInput.value.value = '';
    }
  };
  reader.readAsDataURL(file);
}

onMounted(() => {
  loadData();
});
</script>

<template>
  <div class="panel tavern-panel">
    <div class="panel-header flex-between">
      <div>
        <h2>酒馆（SillyTavern）角色扮演</h2>
        <p class="subtitle">导入社区 TavernAI / SillyTavern 角色卡与世界书，沉浸式互动</p>
      </div>
      <div class="header-actions">
        <button class="primary" @click="triggerUpload">
          <WorkspaceIcon name="upload" /> 导入角色卡 (PNG / JSON)
        </button>
        <input ref="fileInput" type="file" accept=".png,.json" class="hidden-file-input" @change="handleFile" />
      </div>
    </div>

    <!-- 全局状态栏 -->
    <div class="card status-bar flex-between">
      <div class="status-left">
        <span class="status-indicator" :class="{ active: config.enabled }"></span>
        <span>酒馆功能模式：<b>{{ config.enabled ? '已启用' : '已停用' }}</b></span>
        <span class="tip-text">（启用后将优先以酒馆设定的角色和提示词回应消息）</span>
      </div>
      <div class="status-right">
        <select v-model="config.emotionScopeMode" aria-label="群聊好感度计算方式" class="scope-mode-select" @change="saveConfig">
          <option value="group">好感度：全群共享</option>
          <option value="group-member">好感度：群友个人独立</option>
        </select>
        <button class="secondary" @click="toggleEnabled">
          {{ config.enabled ? '停用酒馆模式' : '启用酒馆模式' }}
        </button>
      </div>
    </div>

    <div v-if="characters.length" class="card bindings-card">
      <div class="bindings-grid">
        <div class="binding-col">
          <h4>分群专属角色绑定</h4>
          <div class="binding-form">
            <input v-model="bindGroupId" type="text" placeholder="输入群号" />
            <select v-model="bindGroupCharId">
              <option value="">选择角色（默认首位）</option>
              <option v-for="ch in characters" :key="ch.id" :value="ch.id">{{ ch.name }}</option>
            </select>
            <button type="button" class="secondary" @click="addGroupBinding">绑定</button>
          </div>
          <div class="binding-tags">
            <span v-for="(cid, gid) in (config.groupBindings || {})" :key="gid" class="binding-chip">
              群 {{ gid }} → {{ charNameById(cid) }}
              <button type="button" aria-label="移除群绑定" @click="removeGroupBinding(gid)">×</button>
            </span>
            <small v-if="!Object.keys(config.groupBindings || {}).length" class="tip-text">未配置时使用全局默认角色</small>
          </div>
        </div>
        <div class="binding-col">
          <h4>私聊专属角色绑定</h4>
          <div class="binding-form">
            <input v-model="bindUserId" type="text" placeholder="输入用户 QQ" />
            <select v-model="bindUserCharId">
              <option value="">选择角色（默认首位）</option>
              <option v-for="ch in characters" :key="ch.id" :value="ch.id">{{ ch.name }}</option>
            </select>
            <button type="button" class="secondary" @click="addUserBinding">绑定</button>
          </div>
          <div class="binding-tags">
            <span v-for="(cid, uid) in (config.userBindings || {})" :key="uid" class="binding-chip">
              QQ {{ uid }} → {{ charNameById(cid) }}
              <button type="button" aria-label="移除私聊绑定" @click="removeUserBinding(uid)">×</button>
            </span>
            <small v-if="!Object.keys(config.userBindings || {}).length" class="tip-text">未配置时使用全局默认角色</small>
          </div>
        </div>
      </div>
    </div>

    <div v-if="uploadError" class="alert error-alert">
      {{ uploadError }}
    </div>

    <!-- 角色卡画廊 -->
    <div class="section-title">
      <h3>已安装角色卡 ({{ characters.length }})</h3>
      <span class="help-text">在 QQ 聊天中发送 <code>/酒馆 帮助</code> 查看指令海报，<code>/酒馆 切换 &lt;角色名&gt;</code> 可直接切换</span>
    </div>

    <div v-if="loading" class="empty-hint">正在加载角色库...</div>
    <div v-else-if="!characters.length" class="empty-card">
      <p>目前还没有导入任何酒馆角色卡。</p>
      <button class="primary" @click="triggerUpload">立即导入首张角色卡</button>
    </div>

    <div v-else class="character-grid">
      <div
        v-for="char in characters"
        :key="char.id"
        class="card char-card"
        :class="{ 'is-default': char.isDefault }"
      >
        <div class="char-header">
          <div class="char-avatar-wrap">
            <img
              v-if="char.hasAvatar"
              :src="`/api/tavern/characters/${char.id}/avatar`"
              :alt="char.name"
              class="char-avatar"
            />
            <div v-else class="char-avatar char-placeholder">
              {{ char.name.slice(0, 1) }}
            </div>
            <span v-if="char.isDefault" class="badge-default">默认角色</span>
          </div>
          <div class="char-info">
            <h4 class="char-name">{{ char.name }}</h4>
            <div class="char-tags">
              <span v-for="tag in char.tags" :key="tag" class="tag">{{ tag }}</span>
              <span v-if="char.hasLorebook" class="tag tag-lorebook">包含世界书</span>
            </div>
          </div>
        </div>

        <p class="char-desc">{{ char.description || '暂无描述信息' }}</p>

        <div class="char-actions">
          <button v-if="!char.isDefault" class="btn-text" @click="setDefault(char.id)">
            设为默认
          </button>
          <button class="btn-text" @click="openDetails(char.id, 'emotions')">
            情绪指标
          </button>
          <button class="btn-text" @click="openDetails(char.id, 'settings')">
            详细设定
          </button>
          <button class="btn-text danger" @click="deleteChar(char.id, char.name)">
            删除
          </button>
        </div>
      </div>
    </div>

    <!-- 角色卡编辑详情弹窗 -->
    <div v-if="selectedChar" class="modal-backdrop" @click.self="closeDetails">
      <div class="modal-content">
        <div class="modal-header flex-between">
          <div>
            <h3>{{ selectedChar.name }}</h3>
            <div class="modal-tabs">
              <button type="button" :class="{ active: modalTab === 'settings' }" @click="modalTab = 'settings'">角色设定</button>
              <button type="button" :class="{ active: modalTab === 'emotions' }" @click="modalTab = 'emotions'">情绪与关系指标</button>
            </div>
          </div>
          <button class="btn-close" @click="closeDetails">×</button>
        </div>

        <div v-if="modalTab === 'settings'" class="modal-body form-grid">
          <div class="form-group">
            <label>角色名称 (&#123;&#123;char&#125;&#125;)</label>
            <input v-model="selectedChar.name" type="text" class="input" />
          </div>

          <div class="form-group">
            <label>角色开场白 (First Message)</label>
            <textarea v-model="selectedChar.first_mes" rows="3" class="input"></textarea>
            <small>切换角色或发送 /酒馆 重置（/char reset）时自动触发发送，支持 &#123;&#123;user&#125;&#125; 宏</small>
          </div>

          <div class="form-group">
            <label>外貌与背景简介 (Description)</label>
            <textarea v-model="selectedChar.description" rows="3" class="input"></textarea>
          </div>

          <div class="form-group">
            <label>性格特征 (Personality)</label>
            <textarea v-model="selectedChar.personality" rows="2" class="input"></textarea>
          </div>

          <div class="form-group">
            <label>剧情背景与场景 (Scenario)</label>
            <textarea v-model="selectedChar.scenario" rows="2" class="input"></textarea>
          </div>

          <div class="form-group">
            <label>对话风格示例 (Example Dialogue)</label>
            <textarea v-model="selectedChar.mes_example" rows="3" class="input"></textarea>
          </div>

          <div class="form-group">
            <label>专属系统提示词 (System Prompt)</label>
            <textarea v-model="selectedChar.system_prompt" rows="2" class="input"></textarea>
          </div>

          <div class="form-group">
            <label>即时后置指令 (Post-history Instructions)</label>
            <textarea v-model="selectedChar.post_history_instructions" rows="2" class="input"></textarea>
            <small>在每轮回复前置于历史对话最底部，指导当前句式的长度和口吻</small>
          </div>
        </div>

        <div v-else class="modal-body emotions-body">
          <div class="emotion-explain">
            <div class="explain-head">
              <h4>五项情绪与关系指标（0–100）</h4>
              <span class="rule-pill">单轮 ±10 限幅 · 后台静默更新</span>
            </div>
            <p class="emotion-note">日常对话时系统在后台自动追踪以下数值并调节角色口吻，<b>不会直接出现在 QQ 回复正文中</b>；仅当群友发送 <code>/情绪</code> 或 <code>/酒馆 状态</code> 指令时才会展示。</p>
            <div v-if="emotionsData?.metrics" class="emotion-metric-grid">
              <div v-for="m in emotionsData.metrics" :key="m.key" class="metric-card">
                <div class="metric-card-top">
                  <span class="metric-title"><i class="metric-dot" :class="m.key" />{{ m.label }}</span>
                  <span class="metric-init">初始 {{ m.initial }}</span>
                </div>
                <div class="bar-track"><div class="bar-fill" :class="m.key" :style="{ width: `${m.initial}%` }" /></div>
                <p class="metric-desc">{{ m.description }}</p>
              </div>
            </div>
            <div class="stage-scale">
              <span>好感度阶段：</span>
              <span class="scale-item">0–19 疏离戒备</span>
              <span class="scale-item">20–39 礼貌客套</span>
              <span class="scale-item">40–59 普通熟人</span>
              <span class="scale-item">60–79 亲近信赖</span>
              <span class="scale-item">80–100 深度羁绊</span>
            </div>
          </div>

          <div class="emotion-sessions-head">
            <h4>各会话实时状态</h4>
            <div class="emotion-actions">
              <button type="button" class="btn-text" :disabled="emotionsLoading" @click="loadEmotions(selectedChar.id)">刷新</button>
              <button v-if="emotionsData?.sessions?.length" type="button" class="btn-text danger" @click="resetEmotions('')">全部重置</button>
            </div>
          </div>

          <div v-if="emotionsLoading" class="empty-hint">正在加载情绪记录…</div>
          <div v-else-if="!emotionsData?.sessions?.length" class="emotion-session-card">
            <div class="session-card-head">
              <div>
                <strong>暂无活跃对话记录（当前显示默认初始值）</strong>
                <span class="stage-badge">普通熟人</span>
                <span class="mood-badge">平静</span>
              </div>
            </div>
            <div v-if="emotionsData?.metrics" class="emotion-bars">
              <div v-for="m in emotionsData.metrics" :key="m.key" class="emotion-bar-row">
                <span class="bar-label">{{ m.label }}</span>
                <div class="bar-track"><div class="bar-fill" :class="m.key" :style="{ width: `${m.initial}%` }" /></div>
                <span class="bar-val">{{ m.initial }}</span>
              </div>
            </div>
          </div>
          <div v-else class="emotion-session-list">
            <div v-for="s in emotionsData.sessions" :key="s.scopeKey" class="emotion-session-card">
              <div class="session-card-head">
                <div>
                  <strong>{{ s.scopeType === 'group' ? `群聊 ${s.scopeId}` : s.scopeType === 'private' ? `私聊 ${s.scopeId}` : s.scopeKey }}</strong>
                  <span class="stage-badge">{{ s.stage }}</span>
                  <span class="mood-badge">{{ s.mood }}</span>
                </div>
                <button type="button" class="btn-text danger" @click="resetEmotions(s.scopeKey)">重置</button>
              </div>
              <div class="emotion-bars">
                <div v-for="m in emotionsData.metrics" :key="m.key" class="emotion-bar-row">
                  <span class="bar-label">{{ m.label }}</span>
                  <div class="bar-track"><div class="bar-fill" :class="m.key" :style="{ width: `${s[m.key] ?? m.initial}%` }" /></div>
                  <span class="bar-val">{{ s[m.key] ?? m.initial }}</span>
                </div>
              </div>
              <p class="session-reason">最近波动：{{ s.reason || '暂无' }}<span v-if="s.updatedAt"> · {{ new Date(s.updatedAt).toLocaleString() }}</span></p>
            </div>
          </div>

          <div class="emotion-sessions-head trigger-head">
            <div>
              <h4>情绪阈值触发规则（特殊口癖 / 表情包 / 剧情彩蛋）</h4>
              <p class="trigger-sub">当角色情绪达到设定阈值时，自动向提示词注入专属口癖/彩蛋设定，并可附带发送表情包图片。</p>
            </div>
            <div class="emotion-actions">
              <button type="button" class="btn-text" @click="applyTriggerTemplates">导入常用模板</button>
              <button type="button" class="btn-text" @click="addTriggerRule()">+ 添加规则</button>
              <button type="button" class="secondary trigger-save-btn" :disabled="triggersSaving" @click="saveTriggers(false)">
                {{ triggersSaving ? '保存中…' : '保存触发规则' }}
              </button>
            </div>
          </div>
          <input ref="stickerInput" type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="hidden-file-input" @change="handleStickerFile" />

          <div v-if="!triggersDraft.length" class="empty-hint">暂未配置情绪触发规则，可点击「导入常用模板」或「+ 添加规则」。</div>
          <div v-else class="trigger-list">
            <div v-for="(rule, idx) in triggersDraft" :key="rule.id" class="trigger-card">
              <div class="trigger-card-top">
                <label class="trigger-enable">
                  <input v-model="rule.enabled" type="checkbox" />
                  <span>启用</span>
                </label>
                <input v-model="rule.name" type="text" maxlength="40" class="trigger-name-input" placeholder="规则名称（如：深度羁绊口癖）" />
                <button type="button" class="btn-text danger" @click="removeTriggerRule(idx)">删除</button>
              </div>
              <div class="trigger-cond-row">
                <span>当</span>
                <select v-model="rule.metric">
                  <option v-for="m in (emotionsData?.metrics || [])" :key="m.key" :value="m.key">{{ m.label }}</option>
                </select>
                <select v-model="rule.operator">
                  <option value=">=">≥ (达到或高于)</option>
                  <option value="<=">≤ (低于或等于)</option>
                </select>
                <input v-model.number="rule.threshold" type="number" min="0" max="100" class="trigger-num" />
                <span class="trigger-cool-label">表情冷却</span>
                <input v-model.number="rule.stickerCooldown" type="number" min="1" max="20" class="trigger-num" />
                <span>轮</span>
              </div>
              <textarea
                v-model="rule.promptHint"
                rows="2"
                maxlength="400"
                class="trigger-prompt"
                placeholder="触发后注入的特殊口癖、语气变化或剧情彩蛋指示（留空则仅发送表情包）"
              />
              <div class="trigger-sticker-row">
                <template v-if="rule.sticker?.filename">
                  <img :src="`/api/tavern/stickers/${rule.sticker.filename}`" class="sticker-thumb" alt="触发表情包" />
                  <span class="trigger-sticker-name">已绑定表情包</span>
                  <button type="button" class="btn-text" @click="chooseSticker(rule.id)">更换</button>
                  <button type="button" class="btn-text danger" @click="removeSticker(rule.id)">移除表情包</button>
                </template>
                <template v-else>
                  <button type="button" class="btn-text" @click="chooseSticker(rule.id)">+ 上传触发表情包（可选）</button>
                </template>
              </div>
            </div>
          </div>
        </div>

        <div class="modal-footer flex-end">
          <button class="secondary" @click="closeDetails">{{ modalTab === 'settings' ? '取消' : '关闭' }}</button>
          <button v-if="modalTab === 'settings'" class="primary" :disabled="saving" @click="saveSelectedChar">
            {{ saving ? '保存中...' : '保存更改' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tavern-panel {
  padding: 0;
}

.panel-header {
  gap: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.panel-header h2 {
  font-size: 22px;
  font-weight: 650;
  color: var(--ink, #283751);
  margin: 0;
}

.flex-between {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.flex-end {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.subtitle {
  color: var(--muted, #65738b);
  font-size: 13px;
  margin-top: 6px;
  margin-bottom: 0;
}

.status-bar {
  margin: 20px 0;
  padding: 16px 20px;
  background: var(--panel, #fff);
  border: 1px solid var(--line, #e0e6f1);
  border-radius: var(--radius, 16px);
  box-shadow: var(--panel-shadow, 0 4px 24px #3e5d9510);
  gap: 16px;
}

.status-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--ink, #283751);
  font-size: 14px;
}

.status-indicator {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--red, #b34b63);
  flex-shrink: 0;
}

.status-indicator.active {
  background: #34776c;
  box-shadow: 0 0 0 4px rgba(52, 119, 108, 0.16);
}

.tip-text {
  color: var(--muted, #65738b);
  font-size: 12px;
}

.error-alert {
  margin: 0 0 18px;
  padding: 12px 16px;
  border-radius: 10px;
  background: #fdf1f4;
  border: 1px solid #f2cfd8;
  color: var(--red, #b34b63);
  font-size: 13px;
}

.section-title {
  margin: 24px 0 14px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
}

.section-title h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--ink, #283751);
}

.help-text {
  font-size: 12px;
  color: var(--muted, #65738b);
}

.help-text code {
  background: var(--soft, #eef2fc);
  color: var(--accent, #4669ac);
  padding: 2px 7px;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.empty-hint {
  color: var(--muted, #65738b);
  padding: 24px 0;
  font-size: 13px;
}

.character-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 18px;
}

.char-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background: var(--panel, #fff);
  border: 1px solid var(--line, #e0e6f1);
  border-radius: var(--radius, 16px);
  box-shadow: var(--panel-shadow, 0 4px 24px #3e5d9510);
  padding: 18px 20px;
  transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s;
}

.char-card:hover {
  border-color: #a9bce2;
  transform: translateY(-2px);
}

.char-card.is-default {
  border-color: #34776c;
  background: linear-gradient(180deg, #f8fcfb 0%, #ffffff 100%);
}

.char-header {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.char-avatar-wrap {
  position: relative;
  width: 60px;
  height: 60px;
  flex-shrink: 0;
}

.char-avatar {
  width: 100%;
  height: 100%;
  border-radius: 12px;
  object-fit: cover;
  border: 1px solid var(--line, #e0e6f1);
}

.char-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--soft, #eef2fc);
  color: var(--accent, #4669ac);
  font-size: 22px;
  font-weight: 700;
}

.badge-default {
  position: absolute;
  bottom: -5px;
  right: -5px;
  background: #34776c;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 6px;
  box-shadow: 0 2px 6px rgba(52, 119, 108, 0.25);
}

.char-info {
  flex: 1;
  min-width: 0;
}

.char-name {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--ink, #283751);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.char-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.tag {
  font-size: 11px;
  background: var(--soft, #eef2fc);
  color: var(--accent, #4669ac);
  padding: 2px 8px;
  border-radius: 6px;
}

.tag-lorebook {
  background: #f1ecfb;
  color: var(--lavender, #8570ba);
}

.char-desc {
  margin: 14px 0;
  font-size: 13px;
  color: var(--muted, #65738b);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.char-actions {
  display: flex;
  justify-content: flex-end;
  gap: 14px;
  border-top: 1px solid var(--line, #e0e6f1);
  padding-top: 12px;
}

.btn-text {
  background: none;
  border: none;
  color: var(--accent, #4669ac);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  padding: 2px 0;
}

.btn-text:hover {
  text-decoration: underline;
}

.btn-text.danger {
  color: var(--red, #b34b63);
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(32, 47, 74, 0.42);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 1000;
}

.modal-content {
  background: var(--panel, #fff);
  border: 1px solid var(--line, #e0e6f1);
  border-radius: var(--radius, 16px);
  box-shadow: 0 20px 50px rgba(32, 47, 74, 0.18);
  width: 100%;
  max-width: 780px;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  color: var(--ink, #283751);
}

.modal-header,
.modal-footer {
  padding: 16px 22px;
  border-bottom: 1px solid var(--line, #e0e6f1);
}

.modal-header h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--ink, #283751);
}

.modal-footer {
  border-bottom: none;
  border-top: 1px solid var(--line, #e0e6f1);
}

.modal-body {
  padding: 20px 22px;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.btn-close {
  background: none;
  border: none;
  font-size: 22px;
  line-height: 1;
  color: var(--muted, #65738b);
  cursor: pointer;
  padding: 4px;
}

.btn-close:hover {
  color: var(--ink, #283751);
}

.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink, #283751);
  margin: 0 0 6px;
}

.form-group small {
  display: block;
  font-size: 11px;
  color: var(--muted, #65738b);
  margin-top: 6px;
}

.input, textarea.input {
  width: 100%;
  box-sizing: border-box;
  background: #f8fafd;
  border: 1px solid var(--line, #e0e6f1);
  color: var(--ink, #283751);
  padding: 9px 12px;
  border-radius: 9px;
  font-size: 13px;
  margin-top: 0;
}

.input:focus {
  border-color: var(--accent, #4669ac);
  background: #fff;
  outline: none;
}

.empty-card {
  text-align: center;
  padding: 48px 24px;
  background: var(--panel, #fff);
  border: 1px dashed #c8d3e8;
  border-radius: var(--radius, 16px);
  color: var(--muted, #65738b);
}

.empty-card p {
  margin: 0 0 18px;
  font-size: 14px;
}

.modal-tabs { display: flex; gap: 8px; margin-top: 10px; }
.modal-tabs button { padding: 6px 14px; border: 1px solid var(--line, #dbe2ef); border-radius: 999px; background: #fff; font-size: 12px; color: var(--muted, #65738b); cursor: pointer; }
.modal-tabs button.active { background: var(--soft, #eef2fc); border-color: var(--accent, #4669ac); color: var(--accent, #4669ac); font-weight: 600; }
.emotions-body { gap: 18px; }
.explain-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.emotion-explain h4, .emotion-sessions-head h4 { margin: 0; font-size: 14px; color: var(--ink, #283751); }
.rule-pill { font-size: 11px; padding: 2px 9px; border-radius: 999px; background: #eef4ff; color: var(--accent, #4669ac); font-weight: 500; }
.emotion-note { margin: 0 0 12px; font-size: 12px; line-height: 1.7; color: var(--muted, #65738b); overflow-wrap: anywhere; }
.emotion-note code { background: var(--soft, #eef2fc); padding: 1px 6px; border-radius: 5px; font-size: 11px; }
.emotion-metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.metric-card { border: 1px solid var(--line, #e5ebf5); border-radius: 10px; padding: 11px 12px; background: #fbfcff; display: grid; gap: 7px; min-width: 0; }
.metric-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; }
.metric-title { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--ink, #283751); }
.metric-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent, #4669ac); display: inline-block; }
.metric-dot.affection, .bar-fill.affection { background: #d96b8a; }
.metric-dot.joy, .bar-fill.joy { background: #e3a33b; }
.metric-dot.trust, .bar-fill.trust { background: #3b8d7c; }
.metric-dot.tension, .bar-fill.tension { background: #7b6cc7; }
.metric-dot.depression, .bar-fill.depression { background: #607290; }
.metric-init { font-size: 11px; color: var(--muted, #65738b); font-variant-numeric: tabular-nums; }
.metric-desc { margin: 0; font-size: 11.5px; line-height: 1.55; color: var(--muted, #65738b); overflow-wrap: anywhere; }
.stage-scale { margin-top: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 11px; color: var(--muted, #65738b); }
.scale-item { background: #f3f6fc; border: 1px solid var(--line, #e5ebf5); padding: 2px 8px; border-radius: 999px; color: var(--ink, #283751); }
.emotion-sessions-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.emotion-actions { display: flex; gap: 12px; }
.emotion-session-list { display: grid; gap: 12px; }
.emotion-session-card { border: 1px solid var(--line, #e5ebf5); border-radius: 12px; padding: 14px; background: #fbfcff; display: grid; gap: 10px; min-width: 0; }
.session-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.session-card-head > div { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.stage-badge, .mood-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--soft, #eef2fc); color: var(--accent, #4669ac); }
.mood-badge { background: #edf7f4; color: #2b6f63; }
.emotion-bars { display: grid; gap: 8px; }
.emotion-bar-row { display: grid; grid-template-columns: 56px 1fr 34px; align-items: center; gap: 10px; font-size: 12px; }
.bar-label { color: var(--ink, #283751); font-weight: 500; }
.bar-track { height: 8px; background: #e9eef7; border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 999px; background: var(--accent, #4669ac); transition: width .2s; }
.bar-val { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted, #65738b); }
.session-reason { margin: 0; font-size: 12px; color: var(--muted, #65738b); overflow-wrap: anywhere; }

.trigger-head { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line, #dce3ef); align-items: flex-start; gap: 10px; flex-wrap: wrap; }
.trigger-sub { margin: 4px 0 0; font-size: 12px; color: var(--muted, #65738b); }
.trigger-save-btn { padding: 5px 12px; font-size: 12px; }
.trigger-list { display: flex; flex-direction: column; gap: 12px; }
.trigger-card { border: 1px solid var(--line, #dce3ef); border-radius: 10px; padding: 12px 14px; background: #fafcff; display: flex; flex-direction: column; gap: 10px; }
.trigger-card-top { display: flex; align-items: center; gap: 10px; }
.trigger-enable { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink, #283751); white-space: nowrap; }
.trigger-enable input { width: 15px; height: 15px; margin: 0; }
.trigger-name-input { flex: 1; min-width: 0; padding: 6px 10px; border: 1px solid var(--line, #dce3ef); border-radius: 7px; font-size: 13px; background: #fff; }
.trigger-cond-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--muted, #65738b); }
.trigger-cond-row select { padding: 5px 8px; border: 1px solid var(--line, #dce3ef); border-radius: 7px; font-size: 12px; background: #fff; }
.trigger-num { width: 64px; padding: 5px 8px; border: 1px solid var(--line, #dce3ef); border-radius: 7px; font-size: 12px; background: #fff; }
.trigger-cool-label { margin-left: 8px; }
.trigger-prompt { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--line, #dce3ef); border-radius: 7px; font-size: 12px; resize: vertical; background: #fff; }
.trigger-sticker-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sticker-thumb { width: 42px; height: 42px; object-fit: cover; border-radius: 8px; border: 1px solid var(--line, #dce3ef); background: #fff; }
.trigger-sticker-name { font-size: 12px; color: var(--ink, #283751); }

.hidden-file-input { display: none; }
.status-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.scope-mode-select { padding: 7px 12px; border: 1px solid var(--line, #dbe2ef); border-radius: 10px; background: #fff; font-size: 13px; color: var(--ink, #283751); }
.bindings-card { margin: 14px 0 18px; padding: 16px 20px; border: 1px solid var(--line, #dbe2ef); border-radius: 14px; background: #fff; }
.bindings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 18px; }
.binding-col h4 { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: var(--ink, #283751); }
.binding-form { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.binding-form input { width: 130px; }
.binding-form select { flex: 1; min-width: 130px; padding: 7px 10px; border: 1px solid var(--line, #dbe2ef); border-radius: 9px; background: #fff; font-size: 12px; }
.binding-tags { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.binding-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: var(--soft, #eef2fc); color: var(--ink, #283751); font-size: 12px; }
.binding-chip button { border: 0; background: transparent; color: var(--muted, #65738b); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px; }

@media (max-width: 650px) {
  .panel-header,
  .status-bar {
    flex-direction: column;
    align-items: flex-start;
  }

  .status-right,
  .header-actions {
    width: 100%;
  }

  .status-right .secondary,
  .header-actions .primary {
    width: 100%;
  }
}
</style>

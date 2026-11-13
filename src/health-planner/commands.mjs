import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { groupRule, privateAllowed } from '../bot.mjs';
import { messageSegments, resolveMessageImages } from '../images.mjs';
import {
  ACTIVITY_LEVELS,
  DIET_STYLES,
  GOALS,
  MEAL_LABELS,
  beijingDateParts,
  mealSourceLabel,
  parseDietStyleToken,
  parseMealType
} from './nutrition.mjs';
import { listShortcutInstallers } from './tool-downloads.mjs';

const qq = value => /^\d{5,20}$/.test(String(value));

function extractText(segments, selfId) {
  return segments
    .filter(s => s?.type === 'text' || (s?.type === 'at' && String(s.data?.qq) === String(selfId)))
    .map(s => (s.type === 'text' ? String(s.data?.text || '') : ' '))
    .join('')
    .trim();
}

export function parseHealthCommand(event) {
  const segments = messageSegments(event?.message);
  if (segments.some(s => !['text', 'at', 'reply', 'image'].includes(s.type))) return null;
  const text = extractText(segments, event?.self_id);
  if (!text) return null;

  const match = /^[/#](健康|饮食|吃什么|记一餐)(?=$|\s)([\s\S]*)$/.exec(text);
  if (!match) return null;

  const root = match[1];
  const rest = String(match[2] || '').trim();
  const hasMedia = segments.some(s => s.type === 'image' || s.type === 'reply');

  if (root === '吃什么') {
    const mealType = parseMealType(rest);
    return { type: 'plan', mealType, raw: rest, hasMedia };
  }
  if (root === '记一餐') {
    const parts = rest.split(/\s+/).filter(Boolean);
    const maybeMeal = parts.length ? parseMealType(parts[0]) : '';
    const desc = maybeMeal ? parts.slice(1).join(' ') : rest;
    return { type: 'log_meal', mealType: maybeMeal, description: desc, hasMedia };
  }

  if (!rest) return { type: 'help', raw: '', hasMedia };
  const [sub = '', ...tailParts] = rest.split(/\s+/);
  const tail = rest.slice(sub.length).trim();

  if (['帮助', '指南', '说明', 'help'].includes(sub.toLowerCase())) return { type: 'help', raw: tail, hasMedia };
  if (['录入', '设置', '绑定档案', '建档'].includes(sub)) return { type: 'onboard', args: tail, hasMedia };
  if (['档案', '我的', '资料', '信息'].includes(sub)) return { type: 'profile', hasMedia };
  if (['忌口', '不吃', '过敏'].includes(sub)) return { type: 'dislikes', text: tail, hasMedia };
  if (['偏好', '风格', '模式'].includes(sub)) return { type: 'style', text: tail, hasMedia };
  if (['比例', '配比'].includes(sub)) return { type: 'ratios', args: tailParts, hasMedia };
  if (['方案', '食谱', '菜单', '计划'].includes(sub)) return { type: 'plan', mealType: parseMealType(tail), raw: tail, hasMedia };
  if (['记录', '记一餐', '打卡', '吃了'].includes(sub)) {
    const maybeMeal = tailParts.length ? parseMealType(tailParts[0]) : '';
    const desc = maybeMeal ? tailParts.slice(1).join(' ') : tail;
    return { type: 'log_meal', mealType: maybeMeal, description: desc, hasMedia };
  }
  if (['今日', '缺口', '统计', '进度'].includes(sub)) return { type: 'today', hasMedia };
  if (['撤销', '删除记录', '撤回'].includes(sub)) return { type: 'undo', hasMedia };
  if (['推送', '提醒', '定时'].includes(sub)) return { type: 'push', args: tail, hasMedia };
  if (['同步', '苹果', 'apple', 'health', '令牌', 'token'].includes(sub.toLowerCase())) {
    return { type: 'sync', reset: /重置|刷新|reset/i.test(tail), hasMedia };
  }
  if (['快捷指令', '快捷', '苹果指令', 'shortcut', 'shortcuts'].includes(sub.toLowerCase())) {
    return { type: 'shortcuts', hasMedia };
  }
  if (['删除数据', '清空档案', '注销'].includes(sub)) return { type: 'delete_data', confirm: /确认/.test(tail), hasMedia };

  // Treat `/健康 早` / `/健康 午餐` as quick meal query
  const quickMeal = parseMealType(sub);
  if (quickMeal) return { type: 'plan', mealType: quickMeal, raw: tail, hasMedia };

  return { type: 'help', raw: rest, hasMedia };
}

export function healthHelpText() {
  return [
    '🥗 健康饮食管家 · 常用指令：',
    '1️⃣ 录入健康数据：',
    '   /健康 录入 男 26岁 175cm 72kg 减脂 中度',
    '   （目标支持 减脂/维持/增肌；活动度 久坐/轻度/中度/高度/极高；可加 体脂20%）',
    '2️⃣ 查看早/中/晚推荐食物量：',
    '   /健康 方案 ｜ /吃什么 [早|中|晚]',
    '3️⃣ 拍照或文字记一餐（自动估算热量与蛋白并重算余量）：',
    '   /记一餐 [早|中|晚] [菜品描述]（可同时附带食物图片或回复带图消息）',
    '   /健康 今日 ｜ /健康 撤销',
    '4️⃣ 个性调整与定时推送：',
    '   /健康 忌口 海鲜 牛奶 ｜ /健康 偏好 外食 ｜ /健康 比例 30 40 30',
    '   /健康 推送 全部|早报|分餐|关闭|私聊|群聊',
    '5️⃣ 对接 Apple 健康（QQ 直接收快捷指令，无需 macOS 应用）：',
    '   私聊发送 /健康 同步 获取个人 Token 与 iPhone 快捷指令文件；或发送 /健康 快捷指令 直接发送安装包'
  ].join('\n');
}

export class HealthPlannerCommands {
  constructor(configStore, service, { onebot, log = () => {}, now = Date.now, dataDir = '', napcatMediaDir = process.env.NAPCAT_MEDIA_DIR ?? '' } = {}) {
    this.store = configStore;
    this.service = service;
    this.onebot = onebot;
    this.log = log;
    this.now = now;
    this.dataDir = dataDir || (service?.plannerStore?.dir ? dirname(service.plannerStore.dir) : '');
    this.napcatMediaDir = napcatMediaDir;
    this.seen = new Map();
    this.cooldowns = new Map();
    this.active = new Set();
    this.jobs = new Set();
    this.closed = false;
  }

  /**
   * Stage Apple-signed .shortcut files in shared media dir and push directly via QQ file transfer.
   */
  async sendShortcutFiles(event, { isGroup }) {
    const installers = listShortcutInstallers();
    if (!installers.length || !this.dataDir) {
      return { total: installers.length, uploaded: 0, failed: installers.length };
    }
    const mediaRoot = join(this.dataDir, 'media');
    let mediaStat = null;
    try {
      mediaStat = lstatSync(mediaRoot);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (mediaStat?.isSymbolicLink()) {
      throw new Error('媒体共享目录不能是符号链接');
    }
    mkdirSync(mediaRoot, { recursive: true, mode: 0o755 });
    if (lstatSync(mediaRoot).isSymbolicLink()) {
      throw new Error('媒体共享目录不能是符号链接');
    }
    chmodSync(mediaRoot, 0o755);

    const jobId = randomUUID();
    const stageDir = join(mediaRoot, jobId);
    mkdirSync(stageDir, { mode: 0o755 });
    chmodSync(stageDir, 0o755);

    let uploaded = 0;
    let failed = 0;
    const action = isGroup ? 'upload_group_file' : 'upload_private_file';
    const target = isGroup ? { group_id: event.group_id } : { user_id: event.user_id };
    const cleanup = () => {
      try {
        rmSync(stageDir, { recursive: true, force: true });
      } catch {}
    };

    try {
      for (const item of installers) {
        const localFile = join(stageDir, item.name);
        writeFileSync(localFile, item.bytes, { flag: 'wx', mode: 0o644 });
        chmodSync(localFile, 0o644);
        const uploadPath = this.napcatMediaDir ? join(this.napcatMediaDir, jobId, item.name) : localFile;
        try {
          await this.onebot(action, {
            ...target,
            file: uploadPath,
            name: item.qqFilename
          }, this.store.config, 120);
          uploaded += 1;
        } catch (error) {
          failed += 1;
          this.log('warn', `QQ 发送快捷指令文件 ${item.qqFilename} 失败：${error?.message || error}`, {
            source: 'health_planner',
            userId: String(event.user_id || '')
          });
        }
      }
    } finally {
      if (failed > 0) setTimeout(cleanup, 300000).unref();
      else cleanup();
    }
    return { total: installers.length, uploaded, failed };
  }

  canHandle(event) {
    if (this.closed || !this.store.config.enabled) return false;
    const isGroup = event.message_type === 'group';
    if (isGroup) return groupRule(this.store.config, event.group_id).allowed;
    if (privateAllowed(this.store.config, event.user_id)) return true;
    const existing = this.service.plannerStore.getUser(event.user_id);
    return Boolean(existing?.groupId && groupRule(this.store.config, existing.groupId).allowed);
  }

  async sendReply(event, text, imageBuffer = null, alwaysIncludeText = false) {
    if (this.closed) return;
    const isGroup = event.message_type === 'group';
    if (isGroup && !groupRule(this.store.config, event.group_id).allowed) return;
    const target = isGroup ? { group_id: event.group_id } : { user_id: event.user_id };
    const mention = isGroup ? [{ type: 'at', data: { qq: String(event.user_id) } }, { type: 'text', data: { text: '\n' } }] : [];

    if (imageBuffer && Buffer.isBuffer(imageBuffer)) {
      const msg = [...mention];
      if (alwaysIncludeText && text) msg.push({ type: 'text', data: { text: `${text}\n` } });
      msg.push({ type: 'image', data: { file: `base64://${imageBuffer.toString('base64')}` } });
      await this.onebot(isGroup ? 'send_group_msg' : 'send_private_msg', { ...target, message: msg }, this.store.config, 120);
      return;
    }

    await this.onebot(isGroup ? 'send_group_msg' : 'send_private_msg', {
      ...target,
      message: [...mention, { type: 'text', data: { text } }]
    }, this.store.config, 45);
  }

  receive(event) {
    const parsed = parseHealthCommand(event);
    if (!parsed) return null;

    const config = this.store.config;
    const isGroup = event.message_type === 'group';
    const userId = String(event.user_id || '');
    if (
      this.closed ||
      event.post_type !== 'message' ||
      !['group', 'private'].includes(event.message_type) ||
      !qq(event.self_id) ||
      !qq(userId) ||
      String(event.self_id) === userId ||
      (config.botId && String(event.self_id) !== config.botId) ||
      event.message_id == null ||
      (isGroup && !qq(event.group_id)) ||
      !this.canHandle(event)
    ) {
      return { ignored: 'health_planner_unauthorized' };
    }

    const now = this.now();
    for (const map of [this.seen, this.cooldowns]) {
      for (const [k, at] of map) if (now - at > 600000) map.delete(k);
    }
    const id = `${event.self_id}:${event.message_type}:${event.group_id || ''}:${event.message_id}`;
    if (this.seen.has(id)) return { ignored: 'duplicate' };
    if (this.active.has(userId) || this.active.size >= 4 || (this.cooldowns.has(userId) && now - this.cooldowns.get(userId) < 1500)) {
      return { ignored: 'health_planner_busy' };
    }
    this.seen.set(id, now);
    this.cooldowns.set(userId, now);
    this.active.add(userId);

    const job = this.execute(event, parsed)
      .catch(error => {
        this.log('error', `健康饮食指令处理失败：${error.message}`, { source: 'health_planner', userId });
      })
      .finally(() => {
        this.active.delete(userId);
        this.jobs.delete(job);
      });
    this.jobs.add(job);
    return { accepted: true, plugin: 'health_planner', type: parsed.type };
  }

  async execute(event, parsed) {
    const isGroup = event.message_type === 'group';
    const userId = String(event.user_id);
    const userName = String(event.sender?.card || event.sender?.nickname || `QQ ${userId}`).slice(0, 60);
    const groupId = isGroup ? String(event.group_id) : '';

    // Allow users to delete personal encrypted health data even when plugin is paused.
    if (parsed.type === 'delete_data') {
      if (isGroup) return this.sendReply(event, '删除个人健康档案请先在私聊中发送「/健康 删除数据 确认」。');
      if (!parsed.confirm) return this.sendReply(event, '将永久清除你的健康档案、饮食记录与 Apple 同步令牌。\n如确定删除，请发送：/健康 删除数据 确认');
      const deleted = this.service.plannerStore.deleteUser(userId);
      return this.sendReply(event, deleted ? '已彻底删除你的全部健康档案、饮食记录及同步令牌。' : '未找到你的健康记录。');
    }

    if (!this.store.config.enabled || !this.service.settings.enabled) {
      return this.sendReply(event, '健康饮食插件已暂停，请联系管理员开启。');
    }

    if (parsed.type === 'help') {
      if (this.service.settings.renderCard) {
        try {
          const file = await this.service.helpImage.create();
          if (file) {
            await this.onebot(isGroup ? 'send_group_msg' : 'send_private_msg', {
              ...(isGroup ? { group_id: event.group_id } : { user_id: event.user_id }),
              message: [
                ...(isGroup ? [{ type: 'at', data: { qq: userId } }, { type: 'text', data: { text: '\n' } }] : []),
                { type: 'image', data: { file } }
              ]
            }, this.store.config, 120);
            return;
          }
        } catch {
          // Fall back to text help if rendering fails.
        }
      }
      return this.sendReply(event, healthHelpText());
    }

    if (parsed.type === 'shortcuts') {
      const base = String(this.store.config.consolePublicUrl || '').trim().replace(/\/+$/, '') || 'http://你的服务器地址:端口';
      const upload = await this.sendShortcutFiles(event, { isGroup }).catch(() => ({ total: 3, uploaded: 0, failed: 3 }));
      const lines = [
        upload.uploaded > 0
          ? `📱 已通过 QQ 发送 ${upload.uploaded} 个 iPhone 快捷指令文件（无需安装任何 macOS 应用，手机 QQ 点开文件 →「用其他应用打开 / 快捷指令」即可直接导入）：`
          : `📱 QQ 文件发送暂未确认成功，请加机器人好友后私聊「/健康 同步」，或用 iPhone Safari 打开：${base}/tools/health/`,
        `   • 桌面一键记一餐.shortcut（第 1 项「识别剪贴板内容」可直接识别复制的菜名文字或截图）`,
        `   • 同步Apple健康到Bot.shortcut（上传今日步数/活动能量/体重）`,
        `   • Bot记餐写回Apple健康.shortcut（同步 QQ /记一餐 待写入记录）`,
        isGroup
          ? `⚠️ 导入时需要的个人 Token 请加好友后在**私聊**发送「/健康 同步」领取（不在群内发送私密令牌）。`
          : `🔑 如还未复制服务器地址与个人 Token，可继续发送「/健康 同步」查看。`
      ];
      return this.sendReply(event, lines.join('\n'));
    }

    if (parsed.type === 'sync') {
      if (isGroup) {
        return this.sendReply(event, '⚠️ Apple 健康同步令牌属于个人敏感凭据，请加机器人好友后在**私聊**中发送「/健康 同步」领取（Bot 会直接发给你快捷指令文件与 Token）；群里也可先发「/健康 快捷指令」领取空白快捷指令文件。');
      }
      const user = parsed.reset
        ? (() => {
            const token = this.service.plannerStore.rotateSyncToken(userId, { userName, groupId });
            return { user: this.service.plannerStore.getUser(userId), token };
          })()
        : (() => {
            const u = this.service.plannerStore.ensureUser(userId, { userName, groupId });
            this.service.plannerStore.save();
            return { user: u, token: u.syncToken };
          })();
      const base = String(this.store.config.consolePublicUrl || '').trim().replace(/\/+$/, '') || 'http://你的服务器地址:端口';
      const upload = await this.sendShortcutFiles(event, { isGroup: false }).catch(() => ({ total: 3, uploaded: 0, failed: 3 }));
      const deliveryLine = upload.uploaded > 0
        ? `📲 已通过 QQ 发送 ${upload.uploaded} 个 iPhone 快捷指令文件（无需 macOS 应用，不用打开浏览器；手机 QQ 点开文件 →「用其他应用打开 / 快捷指令」导入）：`
        : `📲 QQ 快捷指令文件暂未发送成功，请用 iPhone Safari 打开安装页下载：`;
      const lines = [
        `🍎 Apple 健康同步配置（仅你自己可见）：`,
        `服务器地址：${base}`,
        `个人同步 Token：${user.token}`,
        `（发送「/健康 同步 重置」可立即作废旧 Token 并换新）`,
        ``,
        deliveryLine,
        `   1. 桌面一键记一餐.shortcut —— 复制外卖清单/菜名文字或截图后点「识别剪贴板内容」，即刻走 DeepSeek/识图记餐并写入 Apple 健康`,
        `   2. 同步Apple健康到Bot.shortcut —— 传步数/活动消耗/体重给 Bot 重算预算`,
        `   3. Bot记餐写回Apple健康.shortcut —— 把 QQ 记餐写回 Apple 健康`,
        `   （备用网页安装页：${base}/tools/health/）`,
        ``,
        `🔗 高级接口列表：`,
        `   1. 上传步数/活动/体重：POST ${base}/bridge/health/sync`,
        `   2. 拉取待写回营养队列：GET ${base}/bridge/health/pending`,
        `   3. 确认写回出队：POST ${base}/bridge/health/ack（JSON {"ids": [...]}）`,
        `   4. 桌面一键记一餐：POST ${base}/bridge/health/log`,
        `   鉴权请求头均为：Authorization: Bearer ${user.token}`
      ];
      return this.sendReply(event, lines.join('\n'));
    }

    if (parsed.type === 'onboard') {
      try {
        const user = this.service.onboardUser(userId, { userName, groupId }, parsed.args);
        const payload = await this.service.buildPlanPayload(userId, { includeAiTip: true });
        const pushNote = `✅ 档案已保存！默认每日 ${this.service.settings.pushSlots.morningOverview || '07:30'} 私聊推送全天方案，并会在午/晚饭前提醒。`;
        if (payload.imageBuffer) {
          return this.sendReply(event, `${pushNote}\n目标：${payload.plan.targets.goalLabel} ${payload.plan.targets.targetCalories} kcal · 蛋白 ${payload.plan.targets.proteinG}g`, payload.imageBuffer, true);
        }
        return this.sendReply(event, `${pushNote}\n\n${payload.text}`);
      } catch (error) {
        return this.sendReply(event, `录入未完成：${error.message}\n示例：/健康 录入 男 26岁 175cm 72kg 减脂 中度`);
      }
    }

    const user = this.service.plannerStore.getUser(userId);
    if (!user?.profile) {
      return this.sendReply(event, '你还没有录入基础健康档案。请先发送示例：\n/健康 录入 男 26岁 175cm 72kg 减脂 中度');
    }

    if (parsed.type === 'profile') {
      const p = user.profile;
      const today = beijingDateParts(this.now()).day;
      const appleDay = user.appleHealth?.days?.[today];
      const pushLabel = user.push?.enabled === false
        ? '已关闭'
        : `${({ all: '早报+午晚餐提醒', morning: '仅早报', meals: '早中晚分餐提醒' })[user.push?.mode || 'all']}（${user.push?.channel === 'group' ? `群 ${user.push.targetGroupId}` : '私聊'}）`;
      const ratios = p.mealRatios || { breakfast: 0.3, lunch: 0.4, dinner: 0.3 };
      const lines = [
        `📋 ${user.userName || userId} 的健康档案`,
        `基础：${p.sex === 'male' ? '男' : '女'} · ${p.age} 岁 · ${p.heightCm} cm · ${p.weightKg} kg${p.bodyFatPct ? ` · 体脂 ${p.bodyFatPct}%` : ''}`,
        `目标：${GOALS[p.goal]?.label || p.goal} · 活动度：${ACTIVITY_LEVELS[p.activityLevel]?.label?.split('（')[0] || p.activityLevel}`,
        `风格：${DIET_STYLES[p.dietStyle]?.label || p.dietStyle} · 忌口：${p.dislikes?.length ? p.dislikes.join('、') : '无'}`,
        `分餐比：早 ${Math.round(ratios.breakfast * 100)}% / 中 ${Math.round(ratios.lunch * 100)}% / 晚 ${Math.round(ratios.dinner * 100)}%`,
        `定时推送：${pushLabel}`,
        `Apple 健康：${appleDay ? `今日已同步（步数 ${appleDay.steps ?? '-'} · 活动消耗 ${appleDay.activeEnergyKcal ?? '-'} kcal）` : user.appleHealth?.lastSyncAt ? '历史已绑定，今日暂未同步' : '未同步（私聊发 /健康 同步 配置）'}`
      ];
      return this.sendReply(event, lines.join('\n'));
    }

    if (parsed.type === 'dislikes') {
      const updated = this.service.updateUserDislikes(userId, parsed.text);
      return this.sendReply(event, updated.profile.dislikes.length
        ? `已更新忌口清单：${updated.profile.dislikes.join('、')}。后续方案将自动避开这些食材。`
        : '已清空忌口清单。');
    }

    if (parsed.type === 'style') {
      const styleId = parseDietStyleToken(parsed.text);
      if (!styleId) {
        return this.sendReply(event, '可选饮食偏好：均衡、外食（食堂方便对照）、高蛋白、轻食。示例：/健康 偏好 外食');
      }
      this.service.updateUserStyle(userId, styleId);
      return this.sendReply(event, `已切换饮食风格为「${DIET_STYLES[styleId].label}」：${DIET_STYLES[styleId].desc}`);
    }

    if (parsed.type === 'ratios') {
      try {
        const nums = parsed.args.map(n => Number(String(n).replace(/%$/, '')));
        const updated = this.service.updateUserRatios(userId, nums);
        const r = updated.profile.mealRatios;
        return this.sendReply(event, `已调整早中晚热量分配：早餐 ${Math.round(r.breakfast * 100)}% / 午餐 ${Math.round(r.lunch * 100)}% / 晚餐 ${Math.round(r.dinner * 100)}%。`);
      } catch (error) {
        return this.sendReply(event, error.message);
      }
    }

    if (parsed.type === 'push') {
      const arg = String(parsed.args || '').trim();
      const next = { ...user.push };
      if (!arg) {
        return this.sendReply(event, '推送设置用法：/健康 推送 全部 | 早报 | 分餐 | 开启 | 关闭 | 私聊 | 群聊');
      }
      if (/关|停|off/i.test(arg)) next.enabled = false;
      else if (/开|启|on/i.test(arg)) next.enabled = true;
      if (/仅早报|早报/.test(arg)) { next.enabled = true; next.mode = 'morning'; }
      else if (/分餐/.test(arg)) { next.enabled = true; next.mode = 'meals'; }
      else if (/全部|都要|全/.test(arg)) { next.enabled = true; next.mode = 'all'; }
      if (/私聊/.test(arg)) { next.channel = 'private'; }
      else if (/群聊|当前群|本群/.test(arg)) {
        if (!isGroup) return this.sendReply(event, '请在需要接收推送的授权群内发送「/健康 推送 群聊」。');
        next.channel = 'group';
        next.targetGroupId = groupId;
      }
      this.service.plannerStore.updateUserPush(userId, next);
      return this.sendReply(event, `已更新推送偏好：${next.enabled ? '开启' : '关闭'} · 模式=${({ all: '早报+午晚餐提醒', morning: '仅早报', meals: '早中晚分餐' })[next.mode || 'all']} · 通道=${next.channel === 'group' ? `群 ${next.targetGroupId}` : '私聊'}`);
    }

    if (parsed.type === 'plan') {
      const payload = await this.service.buildPlanPayload(userId, {
        singleMealType: parsed.mealType,
        includeAiTip: !parsed.mealType
      });
      if (payload.imageBuffer) {
        return this.sendReply(event, '', payload.imageBuffer, false);
      }
      return this.sendReply(event, payload.text);
    }

    if (parsed.type === 'log_meal') {
      try {
        let imageUrls = [];
        if (parsed.hasMedia) {
          const resolved = await resolveMessageImages(event, this.store.config, (...args) => this.onebot(...args), parsed.description);
          imageUrls = resolved.urls || [];
        }
        if (!imageUrls.length && !parsed.description) {
          return this.sendReply(event, '请附上食物照片或写上菜品描述，例如：/记一餐 午餐 鸡胸肉沙拉 450大卡 35g蛋白（或直接带图发送 /记一餐）');
        }
        const { log, updatedPlan } = await this.service.estimateAndLogMeal({
          event,
          userId,
          mealTypeHint: parsed.mealType,
          textDescription: parsed.description,
          imageUrls
        });
        const rem = updatedPlan.plan.remainingBudget;
        const lines = [
          `🍽️ 已记录【${MEAL_LABELS[log.mealType]}】(${mealSourceLabel(log.source)})`,
          `内容：${log.summary}`,
          `摄入：${log.calories} kcal ｜ 蛋白质 ${log.proteinG}g ｜ 碳水 ${log.carbsG}g ｜ 脂肪 ${log.fatG}g`,
          `今日剩余预算：${rem.calories} kcal ｜ 剩余蛋白 ${rem.proteinG}g`,
          `🍎 已加入 Apple 健康待写入队列（编号 ${log.id}，发 /健康 撤销 可撤销，发 /健康 方案 查看重算后的后续食谱）`
        ];
        return this.sendReply(event, lines.join('\n'));
      } catch (error) {
        return this.sendReply(event, `记餐未完成：${error.message}`);
      }
    }

    if (parsed.type === 'undo') {
      const today = beijingDateParts(this.now()).day;
      const removed = this.service.plannerStore.undoLastMealLog(userId, today);
      if (!removed) return this.sendReply(event, '今天还没有记录过餐食。');
      return this.sendReply(event, `已撤销今天最近一条${MEAL_LABELS[removed.mealType]}记录：「${removed.summary}」（${removed.calories} kcal / 蛋白 ${removed.proteinG}g），并从 Apple 健康待写入队列移除。`);
    }

    if (parsed.type === 'today') {
      const computed = this.service.computeUserPlan(userId);
      const { plan, appleDay } = computed;
      const t = plan.targets;
      const eaten = plan.eatenTotals;
      const logsToday = user.mealLogs?.[plan.day] || [];
      const netBurn = t.tdee - eaten.calories;
      const lines = [
        `📊 今日健康与营养进度（${plan.day}）`,
        `目标总预算：${t.targetCalories} kcal ｜ 蛋白 ${t.proteinG}g ｜ 碳水 ${t.carbsG}g ｜ 脂肪 ${t.fatG}g`,
        `已记录摄入：${eaten.calories} kcal ｜ 蛋白 ${eaten.proteinG}g ｜ 碳水 ${eaten.carbsG}g ｜ 脂肪 ${eaten.fatG}g（共 ${logsToday.length} 笔）`,
        `今日剩余额度：${plan.remainingBudget.calories} kcal ｜ 蛋白 ${plan.remainingBudget.proteinG}g`,
        `TDEE 估算：${t.tdee} kcal（${t.tdeeNote}）｜ 预计热量差：${netBurn >= 0 ? `缺口 ${netBurn}` : `盈余 ${-netBurn}`} kcal`,
        `待同步 Apple 健康队列：${(user.pendingAppleSync || []).length} 条`,
        ...(logsToday.length ? ['', '已记明细：', ...logsToday.map((l, idx) => `${idx + 1}. [${MEAL_LABELS[l.mealType]}] ${l.summary}：${l.calories} kcal / 蛋白 ${l.proteinG}g`)] : [])
      ];
      if (appleDay?.dietaryEnergyKcal) {
        lines.push(`Apple 健康已汇报膳食能量：${appleDay.dietaryEnergyKcal} kcal${appleDay.proteinG ? ` / 蛋白 ${appleDay.proteinG}g` : ''}`);
      }
      return this.sendReply(event, lines.join('\n'));
    }

    return this.sendReply(event, healthHelpText());
  }
}

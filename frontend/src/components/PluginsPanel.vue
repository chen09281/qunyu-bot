<script setup>
import { inject } from 'vue';
import { consoleKey } from '../composables/useConsole';
import PluginDetailPanel from './PluginDetailPanel.vue';
import AemeathArtwork from './AemeathArtwork.vue';
import WorkspaceIcon from './WorkspaceIcon.vue';
const c = inject(consoleKey);
</script>

<template>
  <PluginDetailPanel v-if="c.state.pluginDetail" />
  <section v-else id="page-plugins" class="page">
    <div class="page-heading"><div><span class="eyebrow">MAKE IT YOURS</span><h1>让群聊多一点可能<span class="title-dot">.</span></h1><p class="muted">按需启用插件，选择插件，管理它的运行方式。</p></div></div>
    <div class="workspace-welcome"><div><span class="eyebrow">LITTLE HELPERS, BIG POSSIBILITIES</span><h2>给日常加一点魔法</h2><p>按需开启，安静陪伴。插件开关立即生效，更多选项在各自的设置页。</p></div><AemeathArtwork /></div>
    <div class="plugin-grid">
      <article class="plugin-card" :class="{ enabled: c.state.config.musicEnabled !== false }" aria-labelledby="music-plugin-title">
        <button type="button" class="plugin-open" aria-label="打开音乐点播设置" @click="c.navigate('plugins/music')">
          <span class="plugin-icon"><WorkspaceIcon name="music" /></span><span id="music-plugin-title" class="plugin-title">音乐点播</span>
          <span class="plugin-description">按歌手查看歌曲，支持中文、英文歌名和自然点歌。把喜欢的旋律带到群聊。</span>
          <span class="plugin-tags"><span>@ 点歌</span><span>按歌手分类</span><span>语音播放</span></span>
          <span class="plugin-footer"><span>{{ c.state.config.musicEnabled !== false ? '已开启 · 支持播放、演奏、来一首' : '已关闭' }}</span><span class="plugin-more">歌曲列表 ↗</span></span>
        </button>
        <button type="button" class="plugin-toggle" role="switch" :aria-checked="c.state.config.musicEnabled !== false" aria-label="音乐点播开关" :disabled="c.state.busy.music" @click="c.toggleMusic"><span class="toggle-label">{{ c.state.config.musicEnabled !== false ? '已开启' : '已关闭' }}</span><span class="toggle-track" aria-hidden="true"><span /></span></button>
      </article>

      <article class="plugin-card" :class="{ enabled: c.state.config.linkParsingEnabled }" aria-labelledby="links-plugin-title">
        <button type="button" class="plugin-open" aria-label="打开链接解析详细设置" @click="c.navigate('plugins/links')">
          <span class="plugin-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 1)" /></svg></span>
          <span id="links-plugin-title" class="plugin-title">链接解析</span>
          <span class="plugin-description">把分享变成看得见的内容。自动识别社交平台链接，将图文与视频带回群聊。</span>
          <span class="plugin-tags"><span>无需 @</span><span>视频直发</span><span>多图合并</span></span>
          <span class="plugin-footer"><span>{{ c.state.config.linkParsingEnabled ? (c.state.config.enabled ? '已开启 · 在授权群内生效' : '已开启 · 等待机器人启用') : '已关闭 · 暂停自动解析' }}</span><span class="plugin-more">详细设置 ↗</span></span>
        </button>
        <button type="button" class="plugin-toggle" role="switch" :aria-checked="Boolean(c.state.config.linkParsingEnabled)" aria-label="链接解析开关" :disabled="c.state.busy.links" :aria-busy="Boolean(c.state.busy.links)" @click="c.toggleLinks">
          <span class="toggle-label">{{ c.state.busy.links ? '保存中' : c.state.config.linkParsingEnabled ? '已开启' : '已关闭' }}</span><span class="toggle-track" aria-hidden="true"><span /></span>
        </button>
      </article>
      <article class="plugin-card" :class="{ enabled: c.state.config.proactiveChatEnabled !== false }" aria-labelledby="scheduled-chat-plugin-title">
        <button type="button" class="plugin-open" aria-label="打开定时聊天设置" @click="c.navigate('plugins/scheduled-chat')">
          <span class="plugin-icon" aria-hidden="true"><WorkspaceIcon name="scheduledChat" /></span>
          <span id="scheduled-chat-plugin-title" class="plugin-title">定时聊天</span>
          <span class="plugin-description">按你设定的时刻，当前角色准时来问好。自动同步白名单群聊，逐群选择是否冒泡与接话。</span>
          <span class="plugin-tags"><span>自定义时间</span><span>逐群开关</span><span>1 分钟连续接话</span></span>
          <span class="plugin-footer"><span>{{ c.state.config.proactiveChatEnabled !== false ? (c.state.config.enabled ? !c.state.config.modelApiKeyConfigured ? '已开启 · 等待模型密钥' : `已开启 · 每天 ${(c.state.config.scheduledChatTimes || []).length} 个时点` : '已开启 · 等待机器人启用') : '已关闭 · 暂停定时与续聊' }}</span><span class="plugin-more">详细设置 ↗</span></span>
        </button>
        <button type="button" class="plugin-toggle" role="switch" :aria-checked="c.state.config.proactiveChatEnabled !== false" aria-label="定时聊天开关" :disabled="c.state.busy.scheduledChat" :aria-busy="Boolean(c.state.busy.scheduledChat)" @click="c.toggleScheduledChat">
          <span class="toggle-label">{{ c.state.busy.scheduledChat ? '保存中' : c.state.config.proactiveChatEnabled !== false ? '已开启' : '已关闭' }}</span><span class="toggle-track" aria-hidden="true"><span /></span>
        </button>
      </article>
      <article class="plugin-card" aria-labelledby="checkin-plugin-title">
        <button type="button" class="plugin-open" aria-label="打开每日签到设置" @click="c.navigate('plugins/checkin')">
          <span class="plugin-icon" aria-hidden="true"><WorkspaceIcon name="checkin" /></span>
          <span id="checkin-plugin-title" class="plugin-title">每日签到</span>
          <span class="plugin-description">森空岛、米游社与库街区。群成员私聊绑定自己的账号，每天领取签到奖励。</span>
          <span class="plugin-tags"><span>成员独立绑定</span><span>定时签到</span><span>私聊回执</span></span>
          <span class="plugin-footer"><span>{{ c.state.checkin?.settings.enabled ? (c.state.config.enabled ? '已开启 · 北京时间 ' + c.state.checkin.settings.time : '已开启 · 等待机器人启用') : '已关闭 · 等待开启' }}</span><span class="plugin-more">详细设置 ↗</span></span>
        </button>
        <button type="button" class="plugin-toggle" role="switch" :aria-checked="Boolean(c.state.checkin?.settings.enabled)" aria-label="每日签到开关" :disabled="!c.state.checkin || c.state.busy.checkin" @click="c.saveCheckin(true)">
          <span class="toggle-label">{{ c.state.busy.checkin ? '保存中' : c.state.checkin?.settings.enabled ? '已开启' : '已关闭' }}</span><span class="toggle-track" aria-hidden="true"><span /></span>
        </button>
      </article>
      <article class="plugin-card" aria-labelledby="subscriptions-plugin-title">
        <button type="button" class="plugin-open" aria-label="打开订阅推送设置" @click="c.navigate('plugins/subscriptions')">
          <span class="plugin-icon" aria-hidden="true"><WorkspaceIcon name="subscriptions" /></span>
          <span id="subscriptions-plugin-title" class="plugin-title">订阅推送</span>
          <span class="plugin-description">订阅博主、网站更新，以及明日方舟、绝区零、终末地、鸣潮的活动与版本前瞻。</span>
          <span class="plugin-tags"><span>定时检查</span><span>关键词过滤</span><span>历史去重</span></span>
          <span class="plugin-footer"><span>{{ c.state.subscriptions?.settings.enabled ? (c.state.config.enabled ? `已开启 · ${c.state.subscriptions.entries.length} 条订阅` : '已开启 · 等待机器人启用') : '已关闭 · 等待开启' }}</span><span class="plugin-more">详细设置 ↗</span></span>
        </button>
        <button type="button" class="plugin-toggle" role="switch" :aria-checked="Boolean(c.state.subscriptions?.settings.enabled)" aria-label="订阅推送开关" :disabled="!c.state.subscriptions || c.state.busy.subscriptionSettings" @click="c.saveSubscriptionSettings(true)">
          <span class="toggle-label">{{ c.state.busy.subscriptionSettings ? '保存中' : c.state.subscriptions?.settings.enabled ? '已开启' : '已关闭' }}</span><span class="toggle-track" aria-hidden="true"><span /></span>
        </button>
      </article>
      <article class="plugin-card" :class="{ enabled: c.state.gameCalendar?.settings?.enabled }" aria-labelledby="game-calendar-plugin-title">
        <button type="button" class="plugin-open" aria-label="打开游戏兑换码与日历设置" @click="c.navigate('plugins/game-calendar')">
          <span class="plugin-icon" aria-hidden="true"><WorkspaceIcon name="gameCalendar" /></span>
          <span id="game-calendar-plugin-title" class="plugin-title">游戏兑换码与日历</span>
          <span class="plugin-description">群内发送 /兑换码、/日历、/活动，一键查询鸣潮、方舟、绝区零、终末地有效礼包码与活动倒计时高清卡片。</span>
          <span class="plugin-tags"><span>/兑换码</span><span>/日历卡片</span><span>官方公告同步</span></span>
          <span class="plugin-footer"><span>{{ c.state.gameCalendar?.settings?.enabled ? (c.state.config.enabled ? `已开启 · ${c.state.gameCalendar?.summary?.activeCodes ?? 0} 个有效码 · ${c.state.gameCalendar?.summary?.activeActivities ?? 0} 项活动` : '已开启 · 等待机器人启用') : '已关闭 · 等待开启' }}</span><span class="plugin-more">详细设置 ↗</span></span>
        </button>
        <button type="button" class="plugin-toggle" role="switch" :aria-checked="Boolean(c.state.gameCalendar?.settings?.enabled)" aria-label="游戏兑换码与日历开关" :disabled="!c.state.gameCalendar || c.state.busy.gameCalendarSettings" @click="c.saveGameCalendarSettings(true)">
          <span class="toggle-label">{{ c.state.busy.gameCalendarSettings ? '保存中' : c.state.gameCalendar?.settings?.enabled ? '已开启' : '已关闭' }}</span><span class="toggle-track" aria-hidden="true"><span /></span>
        </button>
      </article>
      <article class="plugin-card" :class="{ enabled: c.state.fun?.settings?.enabled !== false }" aria-labelledby="fun-plugin-title">
        <button type="button" class="plugin-open" aria-label="打开群聊娱乐工坊设置" @click="c.navigate('plugins/fun')">
          <span class="plugin-icon" aria-hidden="true"><WorkspaceIcon name="fun" /></span>
          <span id="fun-plugin-title" class="plugin-title">群聊娱乐工坊</span>
          <span class="plugin-description">今日运势卡片、群名场面语录、喜报悲报与图片加字、群聊日报、游戏十连模拟、跑团骰娘与海龟汤 / 谁是卧底。</span>
          <span class="plugin-tags"><span>/今日运势 · /语录</span><span>/群日报 · /十连</span><span>跑团骰 · 派对桌游</span></span>
          <span class="plugin-footer"><span>{{ c.state.fun?.settings?.enabled !== false ? `已开启 · ${c.state.fun?.quotesCount ?? 0} 条群语录` : '已关闭 · 等待开启' }}</span><span class="plugin-more">详细设置 ↗</span></span>
        </button>
        <button type="button" class="plugin-toggle" role="switch" :aria-checked="Boolean(c.state.fun?.settings?.enabled)" aria-label="群聊娱乐工坊开关" :disabled="!c.state.fun || c.state.busy.funSettings" @click="c.saveFunSettings(true)">
          <span class="toggle-label">{{ c.state.busy.funSettings ? '保存中' : c.state.fun?.settings?.enabled ? '已开启' : '已关闭' }}</span><span class="toggle-track" aria-hidden="true"><span /></span>
        </button>
      </article>
    </div>
    <p class="plugin-note">插件遵循群聊白名单。暂停机器人时，链接解析、每日签到、订阅推送、音乐点播与定时聊天都会暂停。</p>
  </section>
</template>

<style scoped>
.plugin-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
.plugin-card { position: relative; border: 1px solid var(--line); border-radius: 18px; background: white; transition: border-color .18s, box-shadow .18s; }
.plugin-card:hover { border-color: #acbee0; box-shadow: 0 10px 28px #264f3b09; }
.plugin-open { display: flex; flex-direction: column; width: 100%; height: 100%; padding: 28px; border: 0; border-radius: inherit; background: transparent; text-align: left; color: var(--ink); font: inherit; cursor: pointer; }
.plugin-open:focus-visible { outline: 3px solid #93a8d7; outline-offset: 4px; }
.plugin-icon { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 14px; color: var(--green); background: var(--soft); margin-bottom: 22px; }
.plugin-icon svg { width: 25px; height: 25px; }
.plugin-title { font-size: 20px; font-weight: 600; }
.plugin-description { margin-top: 12px; font-size: 13px; line-height: 1.9; color: var(--muted); }
.plugin-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; margin-bottom: 26px; }
.plugin-tags > span { padding: 5px 9px; border: 1px solid var(--line); border-radius: 6px; color: #7c8f7f; font-size: 10px; }
.plugin-footer { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; width: 100%; border-top: 1px solid var(--line); margin-top: auto; padding-top: 20px; color: var(--muted); font-size: 11px; }
.plugin-more { color: var(--green); }
.plugin-toggle { position: absolute; right: 24px; top: 26px; display: flex; align-items: center; gap: 10px; min-height: 44px; background: transparent; border: 0; border-radius: 8px; padding: 5px; cursor: pointer; }
.toggle-label { font-size: 11px; color: var(--muted); }
.toggle-track { width: 40px; height: 24px; padding: 3px; background: #d9e0f0; border-radius: 20px; transition: background .18s; }
.toggle-track > span { display: block; width: 18px; height: 18px; background: white; border-radius: 50%; box-shadow: 0 1px 3px #0002; transition: transform .18s; }
[aria-checked="true"] .toggle-track { background: var(--green); }
[aria-checked="true"] .toggle-track > span { transform: translateX(16px); }
.plugin-toggle:focus-visible { outline: 3px solid #93a8d7; outline-offset: 2px; }
.plugin-toggle:disabled { opacity: .6; cursor: wait; }
.plugin-note { margin-top: 24px; font-size: 12px; line-height: 1.9; color: var(--muted); }
@media(max-width:1180px) { .plugin-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media(max-width:650px) { .plugin-grid { grid-template-columns: minmax(0, 1fr); }.plugin-open { padding: 22px; }.plugin-toggle { right: 18px; top: 20px; }.plugin-description { font-size: 14px; }.plugin-footer { font-size: 12px; } }
@media(prefers-reduced-motion:reduce) { .plugin-card, .toggle-track, .toggle-track > span { transition: none; } }
</style>

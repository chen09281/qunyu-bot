<script setup>
import { computed, inject, nextTick, ref, watch } from 'vue';
import { consoleKey } from '../composables/useConsole';
import MusicPanel from './MusicPanel.vue';
import LinksPanel from './LinksPanel.vue';
import CheckinPanel from './CheckinPanel.vue';
import CheckinRecordsPanel from './CheckinRecordsPanel.vue';
import SubscriptionsPanel from './SubscriptionsPanel.vue';
import ScheduledChatPanel from './ScheduledChatPanel.vue';
import GameCalendarPanel from './GameCalendarPanel.vue';
import FunPluginPanel from './FunPluginPanel.vue';
import HealthPlannerPanel from './HealthPlannerPanel.vue';
const c = inject(consoleKey), heading = ref(null);
const records = computed(() => c.state.pluginDetail === 'checkin' && c.state.checkinView === 'records');
const title = computed(() => records.value ? '成员签到记录' : ({ music: '音乐点播', links: '链接解析', checkin: '每日签到', subscriptions: '订阅推送', 'scheduled-chat': '定时聊天', 'game-calendar': '游戏兑换码与日历', fun: '群聊娱乐工坊', 'health-planner': '健康饮食管家' })[c.state.pluginDetail]);
watch(() => [c.state.pluginDetail, records.value], async () => {
  await nextTick(); heading.value?.focus({ preventScroll: true });
}, { immediate: true });
</script>

<template>
  <section class="page plugin-detail-page" aria-labelledby="plugin-detail-title">
    <button class="text-button detail-back" type="button" @click="c.navigate(records ? 'plugins/checkin' : 'plugins')">← {{ records ? '返回签到设置' : '返回插件' }}</button>
    <div class="page-heading"><div><span class="eyebrow">PLUGIN WORKSPACE</span><h1 id="plugin-detail-title" ref="heading" tabindex="-1">{{ title }}<span class="title-dot">.</span></h1><p class="muted">{{ records ? '查看成员的签到结果与账号状态。' : '在这里管理设置，照顾好每一次群聊互动。' }}</p></div></div>
    <CheckinRecordsPanel v-if="records" />
    <CheckinPanel v-else-if="c.state.pluginDetail === 'checkin'" />
    <SubscriptionsPanel v-else-if="c.state.pluginDetail === 'subscriptions'" />
    <ScheduledChatPanel v-else-if="c.state.pluginDetail === 'scheduled-chat'" />
    <MusicPanel v-else-if="c.state.pluginDetail === 'music'" />
    <GameCalendarPanel v-else-if="c.state.pluginDetail === 'game-calendar'" />
    <FunPluginPanel v-else-if="c.state.pluginDetail === 'fun'" />
    <HealthPlannerPanel v-else-if="c.state.pluginDetail === 'health-planner'" />
    <LinksPanel v-else embedded />
  </section>
</template>

<style scoped>
.detail-back { margin:0 0 16px; padding:0; min-height:36px; }
#plugin-detail-title:focus { outline:none; }
</style>

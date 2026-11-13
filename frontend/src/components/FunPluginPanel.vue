<script setup>
import { computed, inject, onMounted, reactive } from 'vue';
import { consoleKey } from '../composables/useConsole';
import WorkspaceIcon from './WorkspaceIcon.vue';

const c = inject(consoleKey);

const filter = reactive({
  groupId: '',
  keyword: ''
});

const settings = computed(() => c.state.funSettings || c.state.fun?.settings || {
  enabled: true,
  fortuneEnabled: true,
  memeEnabled: true,
  gamesEnabled: true,
  gachaEnabled: true,
  quotesEnabled: true,
  dailyReportEnabled: true,
  diceTavernComment: true
});

const toggleItems = [
  { key: 'enabled', title: '启用群聊娱乐工坊', desc: '关闭后群内和私聊将停止响应娱乐、桌游、十连和语录指令。' },
  { key: 'fortuneEnabled', title: '今日运势 / 抽签', desc: '支持 /今日运势、/抽签 生成带 QQ 头像的个人运势签卡片。' },
  { key: 'memeEnabled', title: '梗图工坊（喜报/悲报/举牌/加字）', desc: '支持 /喜报、/悲报、/举牌 及回复图片发 /加字 上句|下句。' },
  { key: 'quotesEnabled', title: '群聊名场面语录库', desc: '支持回复消息发送 /存语录，以及 /语录 随机生成黑底海报卡片。' },
  { key: 'dailyReportEnabled', title: '群聊每日风向日报', desc: '仅保存匿名发言次数与脱敏短词频次（不存原文，保留 7 天），支持 /群日报。' },
  { key: 'gachaEnabled', title: '游戏十连抽卡模拟', desc: '支持 /十连 鸣潮|绝区零|方舟|终末地 及本群 /欧非榜 统计。' },
  { key: 'gamesEnabled', title: '派对桌游与跑团骰娘', desc: '包含 .r/.ra/.rh 跑团骰娘、/海龟汤（AI 裁判）以及 /卧底 谁是卧底。' },
  { key: 'diceTavernComment', title: '跑团骰点酒馆联动吐槽', desc: '开启酒馆模式时，掷骰后由当前角色简短吐槽 1 句话。' }
];

function refreshQuotes() {
  void c.loadFunQuotes({ groupId: filter.groupId.trim(), keyword: filter.keyword.trim() });
}

onMounted(() => {
  void c.loadFun();
  refreshQuotes();
});
</script>

<template>
  <div class="fun-workspace">
    <article class="card panel">
      <div class="panel-heading">
        <div>
          <h2>功能开关与隐私说明</h2>
          <p class="muted">娱乐指令仅在群聊与私聊白名单内生效；群日报仅记录匿名计数与关键词。</p>
        </div>
        <button type="button" class="primary" :disabled="!c.state.fun || c.state.busy.funSettings" @click="c.saveFunSettings(false)">
          <WorkspaceIcon name="check" />
          {{ c.state.busy.funSettings ? '保存中…' : '保存设置' }}
        </button>
      </div>

      <p v-if="c.state.funError" class="error-inline">{{ c.state.funError }}</p>

      <div class="toggle-grid">
        <label v-for="item in toggleItems" :key="item.key" class="toggle-item">
          <div class="toggle-copy">
            <b>{{ item.title }}</b>
            <small>{{ item.desc }}</small>
          </div>
          <input v-model="settings[item.key]" type="checkbox" :disabled="item.key !== 'enabled' && !settings.enabled" />
        </label>
      </div>

      <div class="callout command-callout">
        <b>常用 QQ 指令速查</b>
        <p><code>/玩法</code> 查看完整帮助 ｜ <code>/今日运势</code> ｜ <code>/喜报 文案</code> ｜ <code>/悲报 文案</code> ｜ <code>/举牌 文案</code> ｜ 回复图片发 <code>/加字 上|下</code></p>
        <p>回复群友发 <code>/存语录</code> ｜ <code>/语录 [关键词]</code> ｜ <code>/群日报</code> ｜ <code>/十连 [鸣潮/绝区零/方舟/终末地]</code> ｜ <code>/欧非榜</code></p>
        <p><code>.r 1d100</code> · <code>.ra 侦查 65</code> · <code>.rh</code>（暗骰）｜ <code>/海龟汤 开局 [主题]</code> · <code>/汤 问题</code> ｜ <code>/卧底 开局</code> · <code>/加入</code> · <code>/开始</code> · <code>/投票 @某人</code></p>
      </div>
    </article>

    <article class="card panel">
      <div class="panel-heading">
        <div>
          <h2>名场面语录管理</h2>
          <p class="muted">共收录 {{ c.state.fun?.quotesCount ?? c.state.funQuotes.length }} 条语录，支持按群号或关键词检索清理。</p>
        </div>
        <div class="quote-filter">
          <input v-model="filter.groupId" type="text" placeholder="筛选群号" @keydown.enter.prevent="refreshQuotes" />
          <input v-model="filter.keyword" type="text" placeholder="搜索语录或作者" @keydown.enter.prevent="refreshQuotes" />
          <button type="button" class="secondary" :disabled="c.state.funQuotesLoading" @click="refreshQuotes">
            <WorkspaceIcon name="refresh" />
            {{ c.state.funQuotesLoading ? '加载中…' : '查询' }}
          </button>
        </div>
      </div>

      <div v-if="!c.state.funQuotes.length" class="empty">暂无符合条件的语录，在授权群内回复群友消息发送 /存语录 即可收录。</div>
      <div v-else class="quote-list">
        <div v-for="q in c.state.funQuotes" :key="q.id" class="quote-row">
          <div class="quote-body">
            <p class="quote-text">「{{ q.text }}」</p>
            <small class="muted">作者：{{ q.authorName }}{{ q.authorQq ? `（${q.authorQq}）` : '' }} · 群 {{ q.groupId }} · 编号 {{ q.id }}</small>
          </div>
          <button type="button" class="text-button danger-text" @click="c.deleteFunQuote(q.id)">删除</button>
        </div>
      </div>
    </article>
  </div>
</template>

<style scoped>
.fun-workspace { display: flex; flex-direction: column; gap: 24px; }
.toggle-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px; margin-top: 8px; }
.toggle-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: #fbfcff; cursor: pointer; }
.toggle-copy { display: flex; flex-direction: column; gap: 4px; }
.toggle-copy b { font-size: 13px; color: var(--ink); }
.toggle-copy small { font-size: 12px; line-height: 1.55; color: var(--muted); }
.toggle-item input { width: 18px; height: 18px; margin-top: 2px; flex-shrink: 0; }
.command-callout { margin-top: 18px; }
.command-callout p { margin: 6px 0 0; font-size: 12px; line-height: 1.75; }
.quote-filter { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.quote-filter input { width: 150px; }
.quote-list { display: flex; flex-direction: column; gap: 10px; max-height: 460px; overflow-y: auto; }
.quote-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: #fbfcff; }
.quote-body { flex: 1; min-width: 0; }
.quote-text { margin: 0 0 6px; font-size: 14px; font-weight: 600; color: var(--ink); word-break: break-word; }
.error-inline { color: #b42318; font-size: 13px; margin: 8px 0; }
.danger-text { color: #b42318; }
</style>

<script setup>
import { computed, inject, onMounted, onBeforeUnmount, ref } from 'vue';
import { consoleKey } from '../composables/useConsole';
import WorkspaceIcon from './WorkspaceIcon.vue';
const c = inject(consoleKey), data = ref(null), busy = ref(false), error = ref(''), query = ref(''), artistId = ref(''), searchTerm = ref(''), searchResults = ref([]), searchBusy = ref(false), notice = ref('');
let controller, disposed = false;
const groups = computed(() => (data.value?.artists || []).filter(a => !artistId.value || a.id === artistId.value).map(a => ({ ...a, tracks: a.tracks.filter(t => [a.name, t.title, ...t.aliases].join(' ').toLowerCase().includes(query.value.trim().toLowerCase())) })).filter(a => a.tracks.length));
async function load(check = false) {
  if (busy.value) return; busy.value = true; error.value = ''; controller = new AbortController(); const timer = setTimeout(() => controller.abort(), check ? 100000 : 15000);
  try {
    const response = await fetch('/api/music' + (check ? '/check' : ''), { method: check ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'X-Admin-Request': '1' }, signal: controller.signal });
    const result = await response.json(); if (!response.ok) throw Error(result.error || '读取歌曲失败'); if (!disposed) data.value = result;
  } catch (e) { if (!disposed) error.value = e.name === 'AbortError' ? '音源读取超时，请稍后重试' : e.message; }
  finally { clearTimeout(timer); if (!disposed) busy.value = false; }
}
const stateText = track => track.local ? '本地音源' : track.lastCheck?.state === 'ready' ? '最近播放正常' : track.online ? '已匹配在线音源' : track.lastCheck?.state === 'missing' ? '暂无在线音源' : track.lastCheck?.state === 'failed' ? '读取失败' : '待检测';
const isAdded = title => (data.value?.artists || []).some(artist => artist.tracks.some(track => track.title === title));
async function searchMusic() {
  if (searchBusy.value || !searchTerm.value.trim()) return; searchBusy.value = true; error.value = ''; notice.value = '';
  try {
    const response = await fetch('/api/music/search', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }, body: JSON.stringify({ term: searchTerm.value.trim() }) });
    const result = await response.json(); if (!response.ok) throw Error(result.error || '搜索失败'); searchResults.value = result.tracks || [];
    if (!searchResults.value.length) notice.value = '没有找到带公开预览的歌曲，可换一个关键词。';
  } catch (e) { error.value = e.message; } finally { searchBusy.value = false; }
}
async function addTrack(track) {
  if (busy.value || isAdded(track.title)) return; busy.value = true; error.value = ''; notice.value = '';
  try {
    const response = await fetch('/api/music/tracks', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }, body: JSON.stringify(track) });
    const result = await response.json(); if (!response.ok) throw Error(result.error || '添加失败'); data.value = result; notice.value = `已加入《${track.title}》的点播目录。`;
  } catch (e) { error.value = e.message; } finally { busy.value = false; }
}
async function removeTrack(title) {
  if (busy.value) return; busy.value = true; error.value = ''; notice.value = '';
  try {
    const response = await fetch('/api/music/tracks/remove', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }, body: JSON.stringify({ title }) });
    const result = await response.json(); if (!response.ok) throw Error(result.error || '移除失败'); data.value = result; notice.value = `已将《${title}》移出自定义目录。`;
  } catch (e) { error.value = e.message; } finally { busy.value = false; }
}
onMounted(() => load()); onBeforeUnmount(() => { disposed = true; controller?.abort(); });
</script>
<template>
  <div class="music-panel">
    <article class="card panel music-intro"><div><span class="eyebrow">GROUP RADIO</span><h2>让喜欢的旋律响起来</h2><p>在授权群 @机器人，发送“播放”“演奏”“来一首”“想听”加歌名。也可发送“来一首飞行雪绒的歌”随机播放。</p></div><WorkspaceIcon name="music" /></article>
    <div class="music-toolbar"><button type="button" class="secondary" role="switch" :aria-checked="c.state.config.musicEnabled !== false" :disabled="c.state.busy.music" @click="c.toggleMusic">音乐点播{{ c.state.config.musicEnabled !== false ? '已开启' : '已关闭' }}</button><button class="secondary" type="button" :disabled="busy" @click="load(true)">{{ busy ? '读取中…' : '检测全部音源' }}</button></div>
    <form class="card panel music-search" @submit.prevent="searchMusic"><div class="panel-heading"><div><h2>搜索音乐平台</h2><p class="muted">搜索任意歌曲或歌手，将带公开预览的结果加入点播目录。</p></div></div><div class="music-search-row"><input v-model="searchTerm" type="search" required maxlength="100" placeholder="例如：纸飞机、鸣潮、周杰伦"><button class="primary" type="submit" :disabled="searchBusy || !searchTerm.trim()">{{ searchBusy ? '搜索中…' : '搜索' }}</button></div></form>
    <p v-if="notice" class="muted" role="status">{{ notice }}</p>
    <div v-if="searchResults.length" class="music-search-results"><section v-for="track in searchResults" :key="track.previewUrl" class="music-track"><div class="music-track-heading"><h3>{{ track.title }}</h3><button type="button" class="secondary" :disabled="busy || isAdded(track.title)" @click="addTrack(track)">{{ isAdded(track.title) ? '已加入' : '加入目录' }}</button></div><p>{{ track.artistName }}</p><code>公开预览音源</code></section></div>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="!data && !error" role="status">正在载入音乐列表…</p>
    <div v-if="data" class="music-filters"><label>歌手<select v-model="artistId"><option value="">全部歌手</option><option v-for="artist in data.artists" :key="artist.id" :value="artist.id">{{ artist.name }}</option></select></label><label>查找歌曲<input v-model="query" type="search" placeholder="中文歌名、英文名或歌手" maxlength="100"></label></div>
    <article v-for="artist in groups" :key="artist.id" class="card panel artist-group"><div class="panel-heading"><div><h2>{{ artist.name }}</h2><small>{{ artist.aliases[0] }}</small></div><span class="subtle-tag">{{ artist.tracks.length }} 个点播入口</span></div>
      <div class="music-tracks"><section v-for="track in artist.tracks" :key="track.title" class="music-track"><div class="music-track-heading"><h3>{{ track.title }}</h3><span class="subtle-tag">{{ stateText(track) }}</span><button v-if="artist.id === 'custom'" type="button" class="text-button" :disabled="busy" @click="removeTrack(track.title)">移除</button></div><p>{{ track.aliases.join(' · ') }}</p><p v-if="track.album" class="muted">专辑入口，默认播放《小小奇迹》；有同名本地音源时优先使用。</p><p v-if="track.lastCheck?.error" class="error-text">{{ track.lastCheck.error }}</p><code>@机器人 演奏 {{ track.title }}</code></section></div>
    </article>
    <p v-if="data && !groups.length" class="muted">没有匹配的歌曲或歌手。</p>
    <aside class="card panel music-notes"><h3>使用说明</h3><p>发送“飞行雪绒歌曲列表”查看群内歌单。支持中英文标题与常见别名，机器人回复歌名后发送 QQ 语音。</p><p>音源检测只读取目录，不向群聊发消息；“已匹配在线音源”表示找到来源，实际下载仍取决于网络。优先使用本地文件，可在 data/music/tracks/ 下按歌名放置 mp3、m4a、wav、flac 或 ogg 音源。</p><p>当前歌单按歌手分类；飞行雪绒曲目与自定义添加的歌曲均可点播。M4A 音源不再重复转码，其他格式转为 192k 立体声 AAC，保留更高语音质量。点歌继续受机器人总开关、群白名单及群回复开关控制。</p></aside>
  </div>
</template>
<style scoped>
.music-panel{display:grid;gap:22px;font-size:13px;line-height:1.8}.music-intro{display:flex;align-items:center;justify-content:space-between;gap:24px;background:linear-gradient(115deg,#edf1ff,#faf5ff)}.music-intro h2{font-size:24px;margin:10px 0}.music-intro p,.music-notes p{color:var(--muted);max-width:720px}.music-intro svg{width:64px;height:64px;color:var(--accent)}.music-toolbar{display:flex;gap:12px;flex-wrap:wrap}.music-filters{display:grid;grid-template-columns:1fr 2fr;gap:22px}.music-filters label{margin:0}.music-tracks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:20px}.music-track{padding:18px;border:1px solid var(--line);border-radius:12px;min-width:0}.music-track-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.music-track h3{margin:0;font-size:16px}.music-track p{font-size:12px;overflow-wrap:anywhere;color:var(--muted)}.music-track code{display:block;padding:9px 12px;border-radius:8px;background:var(--soft);color:var(--accent);overflow-wrap:anywhere}.artist-group small{color:var(--muted)}.music-search-row{display:flex;gap:12px}.music-search-row input{flex:1;min-width:0}.music-search-results{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.music-search-results .music-track-heading button{flex-shrink:0}@media(max-width:700px){.music-tracks,.music-filters,.music-search-results{grid-template-columns:1fr}.music-search-row{flex-direction:column}.music-search-row button{width:100%}.music-intro svg{width:40px;height:40px;flex-shrink:0}.music-intro h2{font-size:20px}.music-panel>.panel{padding:20px}}
</style>

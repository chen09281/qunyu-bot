export const musicArtists = [{ id: 'fleet-snowfluff', name: '飞行雪绒', aliases: ['Fleet Snowfluff', 'Fleet SnowFluff'] }];
export const musicTracks = [
  { title: '星轨消逝之夜', aliases: ['The Night the Stars Left No Trail'], album: true, onlineTitle: '小小奇迹' },
  { title: '碎花', aliases: ['Fallen Petals'] },
  { title: '纸飞机', aliases: ['Paper Plane'] },
  { title: '靛青宇宙', aliases: ['Indigo Universe'] },
  { title: 'Deadline Disco', aliases: ['极限迪斯科', 'Deadline Disco (极限迪斯科)'] },
  { title: 'Brand New Sky', aliases: ['新世界的天空', 'Brand New Sky (新世界的天空)'] },
  { title: '星炬不熄', aliases: ['星炬不息', 'Unwavering Startorch'] },
  { title: '小小奇迹', aliases: ['A Small Miracle'] },
  { title: '停泊的舟', aliases: ['The Moored Boat'] },
  { title: '远航星的告别', aliases: [], sourceUrl: 'https://www.bilibili.com/video/BV17oFezGECV/' },
  { title: '那颗星梦见的春日', aliases: [] },
  { title: '自无垠处归航之星', aliases: [], sourceUrl: 'https://www.bilibili.com/video/BV18o98BNEcb/' }
].map(track => ({ ...track, artistId: 'fleet-snowfluff', artist: '飞行雪绒' }));
export const musicCatalog = musicTracks.map(track => track.title);
export const normalizeMusic = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
const actions = '播放|演奏|点播|放一下|放一首|放首|放个|来一首|来首|听一下|听听|想听|我要听|听一首|唱一首|唱首|唱一下|唱唱|放';
export function fullMusicRequested(prompt) {
  const text = normalizeMusic(prompt);
  return /完整版|整首|完整播放|播放完整|从头到尾/.test(text) && !/(?:不要|不用|不需要|别)(?:播放)?(?:完整版|整首|完整播放|播放完整)/.test(text);
}
export function musicRequest(prompt) {
  const text = normalizeMusic(prompt);
  if (new RegExp(`(?:不要|别|不想|停止|取消|不用|不需要|不)(?:再|继续)?(?:${actions})`).test(text)) return null;
  const artist = musicArtists.find(a => [a.name, ...a.aliases].some(name => text.includes(normalizeMusic(name))));
  if ((artist || /音乐|点歌/.test(text)) && /歌单|歌曲列表|哪些歌|音乐列表/.test(text)) return { type: 'catalog' };
  if (!new RegExp(actions).test(text)) return null;
  const found = musicTracks.find(track => [track.title, ...track.aliases].some(name => text.includes(normalizeMusic(name))));
  const mode = fullMusicRequested(prompt) ? { full: true } : {};
  if (found) return { type: 'song', title: found.title, ...mode };
  return artist ? { type: 'random', ...mode } : null;
}

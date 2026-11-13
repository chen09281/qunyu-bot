// Public catalog shared by the console and subscription resolver; no account credentials.
export const games = [
  { id: 'arknights', name: '明日方舟', aliases: ['方舟', 'ak'], website: 'https://ak.hypergryph.com/news', bilibili: '161775300', color: '#bd981c' },
  { id: 'zzz', name: '绝区零', aliases: ['绝区零', 'zenless'], website: 'https://zzz.mihoyo.com/news', bilibili: '1636034895', color: '#bb6523' },
  { id: 'endfield', name: '明日方舟：终末地', aliases: ['终末地', '明日方舟终末地', 'zmd'], website: 'https://endfield.hypergryph.com/news', bilibili: '1265652806', color: '#748e2a' },
  { id: 'wuwa', name: '鸣潮', aliases: ['mc', 'wutheringwaves'], website: 'https://mc.kurogames.com/main/news', bilibili: '1955897084', color: '#547f98' },
];
export function gameInfo(value) {
  const key = String(value || '').trim().toLowerCase();
  return games.find(game => [game.id, game.name, ...game.aliases].some(alias => alias.toLowerCase() === key));
}
export function normalizeGame(value) {
  const game = gameInfo(value);
  if (!game) throw new Error('请选择明日方舟、绝区零（zzz）、终末地（zmd）或鸣潮，例如「/订阅 游戏 终末地」');
  return game.id;
}
export const gameKinds = { activity: '活动／版本更新', livestream: '前瞻／直播资讯' };

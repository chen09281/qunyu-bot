import { gameInfo } from '../subscriptions/games.mjs';

const POOLS = {
  wuwa: {
    id: 'wuwa',
    name: '鸣潮',
    color: '#547f98',
    hardPity: 80,
    softPityStart: 66,
    baseFiveRate: 0.008,
    softStep: 0.06,
    baseFourRate: 0.06,
    starLabel: { high: 5, mid: 4, low: 3 },
    upPool: ['守岸人', '今汐', '椿', '珂莱塔', '菲比', '赞妮'],
    stdPool: ['维里奈', '安可', '卡卡罗', '鉴心', '凌阳'],
    fourPool: ['散华', '莫特斐', '丹瑾', '白芷', '秋水', '渊武', '灯灯'],
    threePool: ['远行者长刃', '制式迅刀', '源能测距仪', '守护音感仪', '鸣动臂铠']
  },
  zzz: {
    id: 'zzz',
    name: '绝区零',
    color: '#bb6523',
    hardPity: 90,
    softPityStart: 74,
    baseFiveRate: 0.006,
    softStep: 0.06,
    baseFourRate: 0.072,
    starLabel: { high: 5, mid: 4, low: 3 },
    upPool: ['星见雅', '耀嘉音', '伊芙琳', '简·杜', '月城柳', '朱鸢'],
    stdPool: ['莱卡恩', '丽娜', '格莉丝', '11号', '珂蕾妲', '猫又'],
    fourPool: ['妮可', '安比', '比利', '露西', '派派', '苍角', '赛斯'],
    threePool: ['月相-望', '激流-矢型', '灰烬-钴蓝', '湍流-斧型', '残响-Ⅲ型']
  },
  arknights: {
    id: 'arknights',
    name: '明日方舟',
    color: '#bd981c',
    hardPity: 99,
    softPityStart: 51,
    baseFiveRate: 0.02,
    softStep: 0.02,
    baseFourRate: 0.08,
    starLabel: { high: 6, mid: 5, low: 4 },
    upPool: ['维什戴尔', 'Logos', '玛恩纳', '佩佩', '乌尔比安', '妮芙'],
    stdPool: ['银灰', '艾雅法拉', '能天使', '塞雷娅', '伊内丝', '煌'],
    fourPool: ['白面鸮', '德克萨斯', '拉普兰德', '阿米娅', '桃金娘(精锐)', '华法琳'],
    threePool: ['桃金娘', '砾', '蛇屠箱', '调香师', '红豆', '卡达']
  },
  endfield: {
    id: 'endfield',
    name: '明日方舟：终末地',
    color: '#748e2a',
    hardPity: 80,
    softPityStart: 66,
    baseFiveRate: 0.008,
    softStep: 0.06,
    baseFourRate: 0.06,
    starLabel: { high: 6, mid: 5, low: 4 },
    upPool: ['佩丽卡', '莱万汀', '伊冯', '黎风', '洁尔佩塔', '陈千语'],
    stdPool: ['狼卫', '余烬', '艾尔黛拉', '骏卫', '别礼'],
    fourPool: ['埃特拉', '秋栗', '昼雪', '大潘', '弧光', '卡契尔'],
    threePool: ['协议配剑', '工业脉冲枪', '勘探法杖', '重型源石锤', '协议手炮']
  }
};

function pick(list, random = Math.random) {
  return list[Math.floor(random() * list.length)];
}

export function resolveGachaGame(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return POOLS.wuwa;
  const info = gameInfo(raw);
  if (info && POOLS[info.id]) return POOLS[info.id];
  if (raw.includes('鸣潮') || raw === 'ww') return POOLS.wuwa;
  if (raw.includes('绝区') || raw === 'zzz') return POOLS.zzz;
  if (raw.includes('终末') || raw === 'zmd') return POOLS.endfield;
  if (raw.includes('方舟') || raw === 'ak') return POOLS.arknights;
  return null;
}

export function simulateTenPull(gameId, prevStats = {}, { random = Math.random } = {}) {
  const pool = POOLS[gameId] || POOLS.wuwa;
  let pity = Number(prevStats.pity || 0);
  let guaranteed = Boolean(prevStats.guaranteed);
  let totalPulls = Number(prevStats.totalPulls || 0);
  let fiveStars = Number(prevStats.fiveStars || 0);
  let fourStars = Number(prevStats.fourStars || 0);
  let doubleGoldCount = Number(prevStats.doubleGoldCount || 0);

  let fourPity = 0;
  let goldThisTen = 0;
  const pulls = [];

  for (let i = 0; i < 10; i++) {
    pity += 1;
    fourPity += 1;
    totalPulls += 1;
    const highRate = pity >= pool.hardPity
      ? 1
      : pity >= pool.softPityStart
        ? Math.min(1, pool.baseFiveRate + (pity - pool.softPityStart + 1) * pool.softStep)
        : pool.baseFiveRate;
    const roll = random();
    if (roll < highRate) {
      const hitUp = guaranteed || random() < 0.5;
      const name = pick(hitUp ? pool.upPool : pool.stdPool, random);
      const tag = hitUp ? (guaranteed ? '大保底 UP' : 'UP 命中') : '常驻歪了';
      pulls.push({ name, rarity: 5, displayStars: pool.starLabel.high, tag, isUp: hitUp, pityCost: pity });
      pity = 0;
      fourPity = 0;
      guaranteed = !hitUp;
      fiveStars += 1;
      goldThisTen += 1;
    } else if (roll < highRate + pool.baseFourRate || fourPity >= 10) {
      pulls.push({ name: pick(pool.fourPool, random), rarity: 4, displayStars: pool.starLabel.mid, tag: pool.starLabel.mid === 5 ? '5★' : '4★', isUp: false });
      fourPity = 0;
      fourStars += 1;
    } else {
      pulls.push({ name: pick(pool.threePool, random), rarity: 3, displayStars: pool.starLabel.low, tag: pool.starLabel.low === 4 ? '4★' : '3★', isUp: false });
    }
  }

  if (goldThisTen >= 2) doubleGoldCount += 1;

  const nextStats = { pity, guaranteed, totalPulls, fiveStars, fourStars, doubleGoldCount };
  return { pool, pulls, goldThisTen, stats: nextStats };
}

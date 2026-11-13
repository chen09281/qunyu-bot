import { randomInt } from 'node:crypto';

export function parseDiceCommand(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/^[.。](rh|ra|r)(?:\s+(.*)|(\d*d\d+.*))?$/i);
  if (!match) return null;
  const cmd = match[1].toLowerCase();
  const rest = (match[2] ?? match[3] ?? '').trim();
  return { cmd, rest };
}

export function rollDiceExpr(exprInput = '1d100', { randInt = (min, max) => randomInt(min, max + 1) } = {}) {
  const clean = String(exprInput || '').trim() || '1d100';
  const m = clean.match(/^(\d{0,2})d(\d{1,4})(?:\s*([+-])\s*(\d{1,5}))?(?:\s+(.*))?$/i);
  let count = 1, sides = 100, mod = 0, reason = '';
  if (m) {
    count = m[1] ? Number(m[1]) : 1;
    sides = Number(m[2]);
    if (m[3] && m[4]) mod = (m[3] === '-' ? -1 : 1) * Number(m[4]);
    reason = String(m[5] || '').trim().slice(0, 40);
  } else {
    // `.r 原因` -> 1d100 with reason
    reason = clean.slice(0, 40);
  }
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error('骰子数量需在 1 到 20 之间（例如 3d6）');
  }
  if (!Number.isInteger(sides) || sides < 2 || sides > 1000) {
    throw new Error('骰子面数需在 2 到 1000 之间（例如 1d100）');
  }
  if (!Number.isInteger(mod) || Math.abs(mod) > 10000) {
    throw new Error('修正值范围过大');
  }
  const rolls = [];
  for (let i = 0; i < count; i++) rolls.push(randInt(1, sides));
  const sum = rolls.reduce((a, b) => a + b, 0);
  const total = sum + mod;
  const exprText = `${count}d${sides}${mod > 0 ? `+${mod}` : mod < 0 ? `${mod}` : ''}`;
  const detail = rolls.length > 1 || mod !== 0
    ? `[${rolls.join('+')}]${mod > 0 ? `+${mod}` : mod < 0 ? `${mod}` : ''} = ${total}`
    : `${total}`;
  return { count, sides, mod, rolls, sum, total, reason, exprText, detail };
}

export function rollSkillCheck(rest, { randInt = (min, max) => randomInt(min, max + 1) } = {}) {
  const raw = String(rest || '').trim();
  const match = raw.match(/^(?:(.+?)\s+)?(\d{1,3})$/);
  if (!match) throw new Error('格式：.ra [技能名] 目标值（例如：.ra 侦查 65）');
  const skill = (match[1] || '技能检定').trim().slice(0, 24);
  const target = Number(match[2]);
  if (!Number.isInteger(target) || target < 1 || target > 100) {
    throw new Error('检定目标值需在 1 到 100 之间');
  }
  const roll = randInt(1, 100);
  let outcome = '失败';
  let tier = 'fail';
  if (roll === 1 || (roll <= 5 && roll <= target)) {
    outcome = '大成功';
    tier = 'critical_success';
  } else if (roll === 100 || (target < 50 && roll >= 96)) {
    outcome = '大失败';
    tier = 'critical_fail';
  } else if (roll <= Math.floor(target / 5)) {
    outcome = '极难成功';
    tier = 'extreme_success';
  } else if (roll <= Math.floor(target / 2)) {
    outcome = '困难成功';
    tier = 'hard_success';
  } else if (roll <= target) {
    outcome = '成功';
    tier = 'success';
  }
  return { skill, target, roll, outcome, tier };
}

export const UNDERCOVER_PAIRS = [
  ['豆浆', '豆腐脑'], ['麦当劳', '肯德基'], ['空调', '电风扇'], ['微信', 'QQ'],
  ['牛奶', '酸奶'], ['火锅', '麻辣烫'], ['可乐', '雪碧'], ['吉他', '尤克里里'],
  ['动漫', '漫画'], ['原声带', '主题曲'], ['手办', '景品'], ['咖啡', '奶茶'],
  ['薯片', '锅巴'], ['饺子', '馄饨'], ['烤冷面', '手抓饼'], ['熬夜', '失眠'],
  ['地铁', '公交'], ['键盘', '鼠标'], ['耳机', '音箱'], ['抽奖', '保底'],
  ['团本', '深渊'], ['单机', '网游'], ['立绘', '建模'], ['同人', '二创'],
  ['羽毛球', '乒乓球'], ['草莓', '车厘子'], ['月亮', '路灯'], ['魔术', '魔法'],
  ['日记', '备忘录'], ['蝴蝶', '飞蛾'], ['西瓜', '哈密瓜'], ['包子', '馒头']
];

export class UndercoverManager {
  constructor({ now = () => Date.now(), random = Math.random } = {}) {
    this.now = now;
    this.random = random;
    this.rooms = new Map();
  }

  cleanupExpired() {
    const cutoff = this.now() - 30 * 60000;
    for (const [gid, room] of this.rooms.entries()) {
      if (room.updatedAt < cutoff) this.rooms.delete(gid);
    }
  }

  getRoom(groupId) {
    this.cleanupExpired();
    return this.rooms.get(String(groupId)) || null;
  }

  openRoom(groupId, userId, userName) {
    this.cleanupExpired();
    const gid = String(groupId);
    const existing = this.rooms.get(gid);
    if (existing) {
      throw new Error(`本群已有进行中的「谁是卧底」（当前状态：${existing.phase === 'waiting' ? '报名中' : '游戏中'}，发送「/卧底 结束」可终止）`);
    }
    const room = {
      groupId: gid,
      phase: 'waiting',
      hostId: String(userId),
      players: [{ userId: String(userId), name: userName || `QQ ${userId}`, alive: true }],
      round: 0,
      words: null,
      undercoverIds: new Set(),
      votes: new Map(),
      updatedAt: this.now()
    };
    this.rooms.set(gid, room);
    return room;
  }

  joinRoom(groupId, userId, userName) {
    const room = this.getRoom(groupId);
    if (!room) throw new Error('本群还没有「谁是卧底」房间，先发送「/卧底 开局」创建吧');
    if (room.phase !== 'waiting') throw new Error('游戏已经开始啦，请等下一局再加入');
    const uid = String(userId);
    if (room.players.some(p => p.userId === uid)) {
      return { room, alreadyJoined: true };
    }
    if (room.players.length >= 10) throw new Error('房间已满 10 人，可以直接「/开始」了');
    room.players.push({ userId: uid, name: userName || `QQ ${uid}`, alive: true });
    room.updatedAt = this.now();
    return { room, alreadyJoined: false };
  }

  startGame(groupId, userId) {
    const room = this.getRoom(groupId);
    if (!room) throw new Error('本群还没有「谁是卧底」房间');
    if (room.phase !== 'waiting') throw new Error('游戏已经在进行中了');
    if (room.players.length < 3) {
      throw new Error(`当前只有 ${room.players.length} 人，至少需要 3 人发送「/加入」才能开局`);
    }
    const pair = UNDERCOVER_PAIRS[Math.floor(this.random() * UNDERCOVER_PAIRS.length)];
    const flip = this.random() < 0.5;
    const civilianWord = flip ? pair[0] : pair[1];
    const undercoverWord = flip ? pair[1] : pair[0];
    const shuffled = [...room.players];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const undercoverCount = room.players.length >= 7 ? 2 : 1;
    const undercovers = new Set(shuffled.slice(0, undercoverCount).map(p => p.userId));
    room.phase = 'playing';
    room.round = 1;
    room.words = { civilian: civilianWord, undercover: undercoverWord };
    room.undercoverIds = undercovers;
    room.votes.clear();
    room.updatedAt = this.now();
    return {
      room,
      assignments: room.players.map(p => ({
        userId: p.userId,
        name: p.name,
        isUndercover: undercovers.has(p.userId),
        word: undercovers.has(p.userId) ? undercoverWord : civilianWord
      }))
    };
  }

  castVote(groupId, voterId, targetId) {
    const room = this.getRoom(groupId);
    if (!room || room.phase !== 'playing') throw new Error('本群当前没有进行中的「谁是卧底」对局');
    const vid = String(voterId);
    const tid = String(targetId);
    const voter = room.players.find(p => p.userId === vid);
    if (!voter) throw new Error('你未参与本局游戏');
    if (!voter.alive) throw new Error('你已被淘汰，本局请专心观战');
    const target = room.players.find(p => p.userId === tid);
    if (!target || !target.alive) throw new Error('投票目标必须是仍在场上的存活玩家');
    room.votes.set(vid, tid);
    room.updatedAt = this.now();

    const alivePlayers = room.players.filter(p => p.alive);
    if (room.votes.size < alivePlayers.length) {
      return {
        room,
        settled: false,
        voter,
        target,
        votedCount: room.votes.size,
        neededCount: alivePlayers.length
      };
    }

    // Tally votes
    const tally = new Map();
    for (const votedId of room.votes.values()) {
      tally.set(votedId, (tally.get(votedId) || 0) + 1);
    }
    const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const topVotes = sorted[0][1];
    const topCandidates = sorted.filter(([, count]) => count === topVotes).map(([id]) => id);
    room.votes.clear();

    if (topCandidates.length > 1) {
      room.round += 1;
      const tieNames = topCandidates.map(id => room.players.find(p => p.userId === id)?.name || id);
      return { room, settled: true, tie: true, tieNames, winner: null };
    }

    const eliminated = room.players.find(p => p.userId === topCandidates[0]);
    eliminated.alive = false;
    const eliminatedWasUndercover = room.undercoverIds.has(eliminated.userId);
    const remaining = room.players.filter(p => p.alive);
    const aliveUndercovers = remaining.filter(p => room.undercoverIds.has(p.userId)).length;
    const aliveCivilians = remaining.length - aliveUndercovers;

    let winner = null;
    if (aliveUndercovers === 0) winner = 'civilian';
    else if (aliveUndercovers >= aliveCivilians || remaining.length <= 2) winner = 'undercover';

    if (winner) {
      this.rooms.delete(room.groupId);
    } else {
      room.round += 1;
    }

    return {
      room,
      settled: true,
      tie: false,
      eliminated,
      eliminatedWasUndercover,
      topVotes,
      winner,
      remaining
    };
  }

  endRoom(groupId) {
    const gid = String(groupId);
    const room = this.rooms.get(gid) || null;
    this.rooms.delete(gid);
    return room;
  }
}

export const BUILT_IN_SOUPS = [
  {
    title: '夜班末班车',
    surface: '深夜两点，阿明终于赶上了最后一班夜班公交。他刷卡上车后只看了一眼车厢，却立刻让司机停在下一个路口，独自下了车。明明外面还下着大雨，为什么？',
    bottom: '阿明刷卡后听见扣费提示成了“跨市景区夜间专线价”，抬头一看车厢里其他乘客全背着登山包、穿着冲锋衣——原来他平时坐的那条市内末班车已经收班，他上错了同站台发往五十公里外山脚下的徒步专车，再不下车今晚就只能去山顶看日出了。',
    hints: ['和车辆本身的行驶路线或乘客去向有关。', '车里并不危险，只是去向与他想去的回家方向完全不同。']
  },
  {
    title: '海鲜餐厅的哭声',
    surface: '一位水手多年后终于回到陆地，在海边餐厅点了一道清蒸海龟汤。他刚喝了一口，就放下勺子痛哭失声，当晚离开了这座城市。为什么？',
    bottom: '多年以前，这名水手流落荒岛，同伴为了救虚弱的他，每天煮一种叫做“海龟汤”的肉汤给他喝。水手一直以为那是真正的海龟肉；直到几年后在餐厅里，他喝到了真正海龟汤的味道——发现完全不同，瞬间明白当年荒岛上其实根本没有海龟，同伴是割下自己身上的肉或用最后绝望的代价喂活了他。',
    hints: ['关键在于“真正的海龟汤”和他在别处喝过的口感不一样。', '他并不是第一次自以为自己喝过海龟汤。']
  },
  {
    title: '半截火柴',
    surface: '沙漠正中央停着一个破损的热气球，周围零星散落着行李，一名男子静静躺在沙地上，手里紧紧攥着半截折断的火柴。发生了什么？',
    bottom: '几个人乘热气球穿越沙漠，中途发现负载过重即将坠毁。大家抛弃了所有行李后依然超重，必须有一人跳下去保住其余同伴。于是几人抽火柴签决定命运，这名男子不幸抽中了最短的半截火柴，为了同伴主动跳出了吊篮。',
    hints: ['这名男子是从高处落下的，他并非独自乘坐交通工具。', '半截火柴是一种决定顺序或命运的工具。']
  },
  {
    title: '满屋木屑',
    surface: '深夜，一位在马戏团工作了一辈子的盲人演员结束了一天的工作，手抚过自己随身手杖和地上散落的木屑，长叹了一口气，默默收拾行李告别了剧团。为什么？',
    bottom: '老人是一位以“全团最矮”作为招牌演出的盲人侏儒演员，平时每天用一根齐肩高的手杖当作“身高标尺”摸索确认身高。心怀嫉妒的后辈偷偷一点点锯短他的手杖，老人每天发现手杖相比自己变“矮”了，以为自己上了年纪居然又开始长高，即将失去维持生计的演出资格，于是绝望地收拾行李离开了舞台，直到看见地上木屑才醒悟真相。',
    hints: ['老人依赖身边的某样木制品来感知自己的身高。', '有人趁他不注意偷偷锯短了他的工具。']
  },
  {
    title: '敲不响的钟',
    surface: '老旧公寓晚上突然漆黑一片，住在顶楼的程序员却半夜在楼道里拼命按电梯按钮，还一遍遍敲邻居家没反应的大门，第二天却长舒一口气去上班了。为什么？',
    bottom: '大楼物业白天下发了“今晚九点全楼断电模拟消防疏散”的通知，但程序员一直戴着主动降噪耳机写代码并小睡到半夜，错过了所有广播和敲门提醒。醒来后房间漆黑、电梯断电、走廊寂静无声，他一度吓坏以为突发灾难或邻居全消失了；直到摸出单元门看到楼下亮着路灯、保安解释完演练早就结束，才发现只是虚惊一场。',
    hints: ['当晚大楼有预先通知的集体安排，并不只是意外断电。', '他在房间里错过了关键的声音提醒。']
  },
  {
    title: '咖啡里的盐',
    surface: '咖啡店里，男生紧张地向暗恋的女生递上一杯拿铁，顺口说了句“我平时喝美式喜欢加盐”。女生笑了笑，立刻决定以后再也不躲着他了。为什么？',
    bottom: '男生以前有一次和女生拼桌时太紧张，把盐包当成了糖包拆进咖啡里还硬着头皮喝光，怕女生觉得自己笨，当时就嘴硬说“我喝咖啡就爱加盐”。今天女生其实早就听说或看穿他每次都偷偷把糖包藏起来、为了找话题才这么说，彻底被这份笨拙的喜欢逗笑并原谅了过去的误会。',
    hints: ['“加盐”是一句笨拙却有来历的圆场话。', '女生早已知道过去发生过那次小乌龙。']
  },
  {
    title: '两张电影票',
    surface: '周五晚上，小琳买好了两张同一场热门电影连座票却只发了一条朋友圈：“今天包场成功！”结果当晚不仅没被当成放鸽子，还被一群朋友点赞祝福。为什么？',
    bottom: '那部动画电影刚好是小琳最喜欢的本命角色纪念重映场，而且当晚零点场几乎全被粉丝订满，她抢到的是最后两张相连座位，打算一张坐自己、另一张用来放等身周边立牌和应援痛包一起看电影（俗称给推买票，防止旁边坐陌生人打扰应援），同好朋友们一看座位图和立牌合照就秒懂点赞了。',
    hints: ['另外那张票的“座位”上放的不是另一个真人。', '这是一场二次元同好之间心照不宣的仪式感。']
  }
];

export class SoupManager {
  constructor({ now = () => Date.now(), random = Math.random } = {}) {
    this.now = now;
    this.random = random;
    this.games = new Map();
  }

  cleanupExpired() {
    const cutoff = this.now() - 45 * 60000;
    for (const [gid, game] of this.games.entries()) {
      if (game.updatedAt < cutoff) this.games.delete(gid);
    }
  }

  getGame(groupId) {
    this.cleanupExpired();
    return this.games.get(String(groupId)) || null;
  }

  startGame(groupId, customPuzzle = null) {
    this.cleanupExpired();
    const gid = String(groupId);
    if (this.games.has(gid)) {
      throw new Error('本群正在喝一碗海龟汤呢，发送「/海龟汤 揭晓」或「/海龟汤 结束」后再开新锅');
    }
    const picked = customPuzzle || BUILT_IN_SOUPS[Math.floor(this.random() * BUILT_IN_SOUPS.length)];
    const state = {
      groupId: gid,
      title: picked.title,
      surface: picked.surface,
      bottom: picked.bottom,
      hints: Array.isArray(picked.hints) ? picked.hints : [],
      hintIndex: 0,
      askCount: 0,
      updatedAt: this.now()
    };
    this.games.set(gid, state);
    return state;
  }

  nextHint(groupId) {
    const game = this.getGame(groupId);
    if (!game) throw new Error('当前群没有进行中的海龟汤，发送「/海龟汤 开局」即可开题');
    game.updatedAt = this.now();
    if (game.hintIndex < game.hints.length) {
      const hint = game.hints[game.hintIndex];
      game.hintIndex += 1;
      return { game, hint, exhausted: false };
    }
    return { game, hint: '预设提示已经全部发完啦，试着从人物动机或物品用途发问，或发送「/海龟汤 揭晓」查看汤底！', exhausted: true };
  }

  reveal(groupId) {
    const gid = String(groupId);
    const game = this.games.get(gid) || null;
    this.games.delete(gid);
    return game;
  }
}

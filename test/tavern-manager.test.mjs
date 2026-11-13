import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TavernManager } from '../src/tavern/tavern-manager.mjs';

test('TavernManager 角色创建、绑定与查询', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tavern-test-'));
  try {
    const mgr = new TavernManager(tmp);

    // 初始应为空
    assert.equal(mgr.listCharacters().length, 0);

    // 保存角色
    const card1 = {
      name: '测试角色A',
      description: '角色A描述',
      first_mes: '你好！'
    };
    const saved1 = mgr.saveCharacter(null, card1);
    assert.ok(saved1.id);
    assert.equal(saved1.name, '测试角色A');
    assert.equal(mgr.listCharacters().length, 1);
    assert.equal(mgr.state.defaultCharacterId, saved1.id);

    // 默认绑定测试
    const active1 = mgr.getActiveCharacter({ isPrivate: true, userId: '123' });
    assert.equal(active1.id, saved1.id);

    // 添加第二个角色并指定给群
    const card2 = {
      name: '测试角色B',
      description: '角色B描述'
    };
    const saved2 = mgr.saveCharacter(null, card2);
    mgr.bindCharacter({ isPrivate: false, groupId: '99999' }, saved2.id);

    const activeGroup = mgr.getActiveCharacter({ isPrivate: false, groupId: '99999' });
    assert.equal(activeGroup.id, saved2.id);

    // 其他群仍获得默认角色
    const activeOtherGroup = mgr.getActiveCharacter({ isPrivate: false, groupId: '88888' });
    assert.equal(activeOtherGroup.id, saved1.id);

    // 删除角色
    mgr.deleteCharacter(saved2.id);
    assert.equal(mgr.getCharacter(saved2.id), null);
    // 绑定应被清理，回退到默认
    const activeGroupAfter = mgr.getActiveCharacter({ isPrivate: false, groupId: '99999' });
    assert.equal(activeGroupAfter.id, saved1.id);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('EmotionManager 情绪初始值、限幅更新、撤回与重置', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tavern-emotion-test-'));
  try {
    const mgr = new TavernManager(tmp);
    const saved = mgr.saveCharacter(null, { name: '达妮娅' });
    const scope = { isPrivate: false, groupId: '10001' };

    const initial = mgr.emotions.get(saved.id, scope);
    assert.equal(initial.affection, 50);
    assert.equal(initial.joy, 60);
    assert.equal(initial.trust, 50);
    assert.equal(initial.tension, 20);
    assert.equal(initial.depression, 15);
    assert.equal(initial.stage, '普通熟人');

    // 单轮增减应严格限制在 [-10, +10]
    const updated = mgr.emotions.apply(saved.id, scope, {
      affection: 35,
      joy: -25,
      trust: 5,
      tension: 12,
      depression: 8,
      mood: '强撑微笑',
      reason: '提到过往经历'
    });
    assert.equal(updated.affection, 60);
    assert.equal(updated.joy, 50);
    assert.equal(updated.trust, 55);
    assert.equal(updated.tension, 30);
    assert.equal(updated.depression, 23);
    assert.equal(updated.stage, '亲近信赖');
    assert.equal(updated.mood, '强撑微笑');

    // 列表查询
    const rows = mgr.emotions.listByCharacter(saved.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scopeKey, 'group:10001');
    assert.equal(rows[0].depression, 23);

    // 撤回上一轮
    const undone = mgr.emotions.undo(saved.id, scope);
    assert.equal(undone.affection, 50);
    assert.equal(undone.depression, 15);

    // 再次更新并重置
    mgr.emotions.apply(saved.id, scope, { depression: 10, mood: '低落' });
    mgr.emotions.reset(saved.id, 'group:10001');
    const afterReset = mgr.emotions.get(saved.id, scope);
    assert.equal(afterReset.depression, 15);
    assert.equal(afterReset.mood, '平静');

    // 群内个人独立好感模式与排行榜
    const s1 = { isPrivate: false, groupId: '10001', userId: '2001' };
    const s2 = { isPrivate: false, groupId: '10001', userId: '2002' };
    mgr.emotions.apply(saved.id, s1, { affection: 8 }, 'group-member');
    mgr.emotions.apply(saved.id, s2, { affection: 2 }, 'group-member');
    const board = mgr.emotions.leaderboard(saved.id, '10001', 10);
    assert.equal(board.length, 2);
    assert.equal(board[0].userId, '2001');
    assert.equal(board[0].affection, 58);
    assert.equal(board[1].userId, '2002');
    assert.equal(board[1].affection, 52);

    mgr.setPendingOoc(scope, '温柔安慰对方');
    assert.equal(mgr.getPendingOoc(scope), '温柔安慰对方');
    mgr.clearPendingOoc(scope);
    assert.equal(mgr.getPendingOoc(scope), '');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

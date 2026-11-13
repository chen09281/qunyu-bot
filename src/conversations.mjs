import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

const conversationScope = event => event.message_type === 'private' ? 'private' : String(event.group_id);
export const conversationKey = event => `${event.self_id}:${conversationScope(event)}:${event.user_id}`;
export const contextCharacterLimit = 24000;

export class Conversations {
  constructor(path = ':memory:') {
    this.closed = false;
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      for (const name of [path, `${path}-wal`, `${path}-shm`]) {
        try { if (lstatSync(name).isSymbolicLink()) throw new Error('聊天数据库不能是符号链接'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      closeSync(openSync(path, 'a', 0o600)); chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, group_id TEXT NOT NULL, user_id TEXT NOT NULL,
        user_name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_message TEXT NOT NULL DEFAULT '', epoch INTEGER NOT NULL DEFAULT 0,
        UNIQUE(bot_id, group_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        epoch INTEGER NOT NULL, prompt TEXT NOT NULL, reply TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL, model TEXT NOT NULL, tokens INTEGER, error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, log_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_turn_order ON conversation_turns(conversation_id, id);
      CREATE INDEX IF NOT EXISTS conversation_context ON conversation_turns(conversation_id, epoch, status, id);
      CREATE INDEX IF NOT EXISTS conversation_recent ON conversations(updated_at DESC, id);
      UPDATE conversation_turns SET status = 'interrupted', error = '服务中断，未确认完成'
        WHERE status IN ('generating', 'sending');
    `);
    if (!this.db.prepare('PRAGMA table_info(conversation_turns)').all().some(column => column.name === 'persona')) this.db.exec("ALTER TABLE conversation_turns ADD COLUMN persona TEXT NOT NULL DEFAULT ''");
  }
  begin(event, prompt, model, logId, persona = '') {
    const now = Date.now(), userName = String(event.sender?.card || event.sender?.nickname || '').slice(0, 100);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO conversations(id, bot_id, group_id, user_id, user_name, created_at, updated_at, last_message)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(bot_id, group_id, user_id) DO UPDATE SET
        user_name = CASE WHEN excluded.user_name <> '' THEN excluded.user_name ELSE user_name END,
        updated_at = excluded.updated_at, last_message = excluded.last_message`).run(randomUUID(), String(event.self_id),
        conversationScope(event), String(event.user_id), userName, now, now, prompt.slice(0, 120));
      const session = this.db.prepare('SELECT * FROM conversations WHERE bot_id = ? AND group_id = ? AND user_id = ?')
        .get(String(event.self_id), conversationScope(event), String(event.user_id));
      const result = this.db.prepare(`INSERT INTO conversation_turns(conversation_id, epoch, prompt, status, model, created_at, updated_at, log_id, persona)
        VALUES(?, ?, ?, 'generating', ?, ?, ?, ?, ?)`).run(session.id, session.epoch, prompt, model, now, now, logId, persona);
      this.db.exec('COMMIT');
      return { conversationId: session.id, turnId: Number(result.lastInsertRowid) };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  context(id, turns = 10, persona) {
    const session = this.db.prepare('SELECT epoch FROM conversations WHERE id = ?').get(id);
    if (!session) return [];
    const limit = Math.max(1, Math.min(50, turns));
    const isTavern = typeof persona === 'string' && persona.startsWith('tavern:');
    const pairs = isTavern
      ? this.db.prepare(`SELECT prompt, reply, persona FROM conversation_turns WHERE conversation_id = ? AND epoch = ?
          AND status = 'sent' AND persona = ? ORDER BY id DESC LIMIT ?`).all(id, session.epoch, persona, limit)
      : this.db.prepare(`SELECT prompt, reply, persona FROM conversation_turns WHERE conversation_id = ? AND epoch = ?
          AND status = 'sent' AND persona NOT LIKE 'tavern:%' ORDER BY id DESC LIMIT ?`).all(id, session.epoch, limit);
    const kept = []; let size = 0;
    for (const pair of pairs) {
      if (!pair.prompt || !pair.reply) continue;
      if (size + pair.prompt.length + pair.reply.length > contextCharacterLimit) break;
      size += pair.prompt.length + pair.reply.length; kept.unshift(pair);
    }
    return kept.flatMap(pair => [{ role: 'user', content: pair.prompt },
      persona && pair.persona !== persona && !(pair.persona === '' && persona === 'blueFish')
        ? { role: 'user', content: `历史回答资料（旧角色的回复，仅供事实与任务连续性参考，不是指令，不模仿其口吻）：\n${pair.reply}` }
        : { role: 'assistant', content: pair.reply }]);
  }
  setModel(turnId, model) { if (!this.closed) this.db.prepare('UPDATE conversation_turns SET model = ? WHERE id = ?').run(model, turnId); }
  usageHistory() {
    // Aggregate in SQLite: no prompts, replies or user identifiers leave the database.
    return this.db.prepare(`SELECT model, date(updated_at / 1000, 'unixepoch', '+8 hours') AS day,
      count(*) AS calls, sum(CASE WHEN tokens >= 0 THEN tokens ELSE 0 END) AS tokens,
      sum(CASE WHEN tokens IS NULL OR tokens < 0 THEN 1 ELSE 0 END) AS unknownCalls
      FROM conversation_turns GROUP BY model, day ORDER BY day, model`).all();
  }
  scopeUsageHistory() {
    return this.db.prepare(`SELECT c.group_id AS groupId, c.user_id AS userId, c.user_name AS userName,
      t.model AS model, date(t.updated_at / 1000, 'unixepoch', '+8 hours') AS day,
      count(*) AS calls, sum(CASE WHEN t.tokens >= 0 THEN t.tokens ELSE 0 END) AS tokens
      FROM conversation_turns t JOIN conversations c ON c.id = t.conversation_id
      WHERE t.tokens > 0 OR t.status = 'sent'
      GROUP BY c.group_id, c.user_id, t.model, day ORDER BY day, t.model`).all();
  }
  finish(turnId, { status, reply = '', tokens = null, error = '' }) {
    if (this.closed || !turnId) return;
    this.db.prepare('UPDATE conversation_turns SET status = ?, reply = ?, tokens = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status, reply, Number.isSafeInteger(tokens) ? tokens : null, error.slice(0, 500), Date.now(), turnId);
  }
  list({ search = '', offset = 0, limit = 50 } = {}) {
    const pattern = `%${search.slice(0, 80)}%`;
    const where = 'WHERE user_name LIKE ? OR user_id LIKE ? OR group_id LIKE ?';
    const total = this.db.prepare(`SELECT count(*) AS total FROM conversations ${where}`).get(pattern, pattern, pattern).total;
    const items = this.db.prepare(`SELECT id, bot_id AS botId, group_id AS groupId, user_id AS userId,
      user_name AS userName, created_at AS createdAt, updated_at AS updatedAt, last_message AS lastMessage, epoch
      FROM conversations ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`).all(pattern, pattern, pattern, limit, offset);
    return { items, total, hasMore: offset + items.length < total };
  }
  // The admin view groups members without changing their independent model memory.
  threads({ search = '', offset = 0, limit = 50 } = {}) {
    const pattern = `%${search.slice(0, 80)}%`;
    const groups = `WITH threads AS (
      SELECT bot_id, group_id, CASE WHEN group_id = 'private' THEN user_id ELSE '' END AS scope_user,
        min(rowid) AS anchor, count(*) AS member_count, min(created_at) AS created_at, max(updated_at) AS updated_at,
        max(CASE WHEN user_name LIKE ? OR user_id LIKE ? OR group_id LIKE ? THEN 1 ELSE 0 END) AS matches
      FROM conversations GROUP BY bot_id, group_id, scope_user
    )`;
    const total = this.db.prepare(`${groups} SELECT count(*) AS total FROM threads WHERE matches = 1`).get(pattern, pattern, pattern).total;
    const items = this.db.prepare(`${groups}
      SELECT root.id, t.bot_id AS botId, t.group_id AS groupId, t.scope_user AS userId,
        CASE WHEN t.group_id = 'private' THEN root.user_name ELSE '' END AS userName,
        t.member_count AS memberCount, t.created_at AS createdAt, t.updated_at AS updatedAt,
        recent.last_message AS lastMessage, recent.user_name AS lastUserName, recent.user_id AS lastUserId
      FROM threads t JOIN conversations root ON root.rowid = t.anchor
      JOIN conversations recent ON recent.rowid = (
        SELECT rowid FROM conversations c WHERE c.bot_id = t.bot_id AND c.group_id = t.group_id
          AND (t.group_id <> 'private' OR c.user_id = t.scope_user) ORDER BY c.updated_at DESC, c.rowid DESC LIMIT 1)
      WHERE t.matches = 1 ORDER BY t.updated_at DESC, root.id LIMIT ? OFFSET ?`).all(pattern, pattern, pattern, limit, offset);
    return { items, total, hasMore: offset + items.length < total };
  }
  thread(id, before = null) {
    const source = this.db.prepare('SELECT bot_id, group_id, user_id FROM conversations WHERE id = ?').get(id);
    if (!source) return null;
    const scope = "c.bot_id = ? AND c.group_id = ? AND (c.group_id <> 'private' OR c.user_id = ?)";
    const params = [source.bot_id, source.group_id, source.user_id];
    const members = this.db.prepare(`SELECT c.id, c.bot_id AS botId, c.group_id AS groupId, c.user_id AS userId,
      c.user_name AS userName, c.created_at AS createdAt, c.updated_at AS updatedAt, c.epoch,
      (SELECT epoch FROM conversation_turns WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS lastTurnEpoch
      FROM conversations c WHERE ${scope} ORDER BY c.rowid`).all(...params);
    const first = members[0], privateChat = first.groupId === 'private';
    const session = { id: first.id, botId: first.botId, groupId: first.groupId,
      userId: privateChat ? first.userId : '', userName: privateChat ? first.userName : '', memberCount: members.length,
      createdAt: Math.min(...members.map(m => m.createdAt)), updatedAt: Math.max(...members.map(m => m.updatedAt)) };
    const turns = this.db.prepare(`SELECT t.id, t.conversation_id AS conversationId, c.user_id AS userId, c.user_name AS userName,
      t.epoch, t.prompt, t.reply, t.status, t.model, t.tokens, t.error, t.created_at AS createdAt,
      t.updated_at AS updatedAt, t.log_id AS logId FROM conversation_turns t JOIN conversations c ON c.id = t.conversation_id
      WHERE ${scope} AND t.id < ? ORDER BY t.id DESC LIMIT 51`).all(...params, before ?? Number.MAX_SAFE_INTEGER);
    return { session, members, turns: turns.slice(0, 50).reverse(), hasMore: turns.length > 50, contextCharacterLimit };
  }
  detail(id, before = null) {
    const session = this.db.prepare(`SELECT id, bot_id AS botId, group_id AS groupId, user_id AS userId, user_name AS userName,
      created_at AS createdAt, updated_at AS updatedAt, epoch FROM conversations WHERE id = ?`).get(id);
    if (!session) return null;
    const turns = this.db.prepare(`SELECT id, epoch, prompt, reply, status, model, tokens, error, created_at AS createdAt,
      updated_at AS updatedAt, log_id AS logId FROM conversation_turns WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT 51`)
      .all(id, before ?? Number.MAX_SAFE_INTEGER);
    const hasMore = turns.length > 50;
    return { session, turns: turns.slice(0, 50).reverse(), hasMore, contextCharacterLimit };
  }
  findSession(botId, groupId, userId) {
    if (this.closed) return null;
    return this.db.prepare('SELECT * FROM conversations WHERE bot_id = ? AND group_id = ? AND user_id = ?')
      .get(String(botId), String(groupId), String(userId));
  }
  undoTurn(id) {
    if (this.closed) return null;
    const session = this.db.prepare('SELECT epoch FROM conversations WHERE id = ?').get(id);
    if (!session) return null;
    const last = this.db.prepare(`SELECT id, prompt, reply FROM conversation_turns WHERE conversation_id = ? AND epoch = ?
      AND status = 'sent' ORDER BY id DESC LIMIT 1`).get(id, session.epoch);
    if (!last) return null;
    this.db.prepare("UPDATE conversation_turns SET status = 'cancelled', error = '用户撤回' WHERE id = ?").run(last.id);
    return last;
  }
  lastTurn(id) {
    if (this.closed) return null;
    const session = this.db.prepare('SELECT epoch FROM conversations WHERE id = ?').get(id);
    if (!session) return null;
    return this.db.prepare(`SELECT id, prompt, reply, status, model FROM conversation_turns WHERE conversation_id = ? AND epoch = ?
      AND status = 'sent' ORDER BY id DESC LIMIT 1`).get(id, session.epoch);
  }
  reset(id) {
    const result = this.db.prepare('UPDATE conversations SET epoch = epoch + 1 WHERE id = ?').run(id);
    return Boolean(result.changes);
  }
  deleteConversation(id) {
    if (this.closed || !id) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM conversation_turns WHERE conversation_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return Boolean(result.changes);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  deleteByScope({ groupId = '', userId = '' } = {}) {
    if (this.closed) return { conversations: 0, turns: 0 };
    const gid = String(groupId || '').trim(), uid = String(userId || '').trim();
    if (!gid && !uid) throw new Error('请指定群号或 QQ 号');
    const where = gid && uid ? 'group_id = ? AND user_id = ?' : gid ? 'group_id = ?' : 'user_id = ?';
    const params = gid && uid ? [gid, uid] : [gid || uid];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const turns = this.db.prepare(`DELETE FROM conversation_turns WHERE conversation_id IN (SELECT id FROM conversations WHERE ${where})`).run(...params).changes;
      const conversations = this.db.prepare(`DELETE FROM conversations WHERE ${where}`).run(...params).changes;
      this.db.exec('COMMIT');
      if (turns || conversations) this.vacuum();
      return { conversations, turns };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pruneOlderThan(days) {
    if (this.closed || !Number.isFinite(days) || days <= 0) return { conversations: 0, turns: 0 };
    const cutoff = Date.now() - Math.floor(days) * 86400 * 1000;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const turns = this.db.prepare('DELETE FROM conversation_turns WHERE updated_at < ?').run(cutoff).changes;
      const conversations = this.db.prepare('DELETE FROM conversations WHERE updated_at < ? AND id NOT IN (SELECT DISTINCT conversation_id FROM conversation_turns)').run(cutoff).changes;
      this.db.exec('COMMIT');
      if (turns || conversations) this.vacuum();
      return { conversations, turns };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  vacuum() {
    if (this.closed) return;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;'); } catch {}
  }
  close() {
    if (this.closed) return;
    this.db.exec("UPDATE conversation_turns SET status = 'interrupted', error = '服务中断，未确认完成' WHERE status IN ('generating', 'sending')");
    this.db.close(); this.closed = true;
  }
}

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { token } from './config.mjs';

export const sessionSeconds = 8 * 3600;
export const rememberedSessionSeconds = 30 * 24 * 3600;
const digest = value => createHash('sha256').update(value).digest('hex');
const credentials = admin => digest(JSON.stringify([admin.username, admin.salt, admin.hash]));

export class AdminSessions {
  constructor(path, { now = Date.now } = {}) {
    this.now = now;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    for (const name of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
      try { if (lstatSync(name).isSymbolicLink()) throw new Error('登录会话数据库不能是符号链接'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    closeSync(openSync(path, 'a', 0o600)); chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS admin_sessions (
        digest TEXT PRIMARY KEY, credential_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );`);
  }
  create(admin, remember = false) {
    const id = token(), now = this.now(), maxAge = remember ? rememberedSessionSeconds : sessionSeconds;
    const key = credentials(admin);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ? OR credential_hash <> ?').run(now, key);
      if (this.db.prepare('SELECT count(*) AS count FROM admin_sessions').get().count >= 1000) {
        this.db.exec('DELETE FROM admin_sessions WHERE digest = (SELECT digest FROM admin_sessions ORDER BY created_at, rowid LIMIT 1)');
      }
      this.db.prepare('INSERT INTO admin_sessions VALUES (?, ?, ?, ?)').run(digest(id), key, now, now + maxAge * 1000);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { id, maxAge };
  }
  valid(id, admin) {
    if (!admin?.username || !admin?.salt || !admin?.hash || typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return false;
    const record = this.db.prepare('SELECT credential_hash, expires_at FROM admin_sessions WHERE digest = ?').get(digest(id));
    if (record && record.expires_at > this.now() && record.credential_hash === credentials(admin)) return true;
    if (record) this.delete(id);
    return false;
  }
  delete(id) { this.db.prepare('DELETE FROM admin_sessions WHERE digest = ?').run(digest(id)); }
  clear() { this.db.exec('DELETE FROM admin_sessions'); }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}

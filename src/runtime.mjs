import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivate } from './config.mjs';

export function registerRuntime(dataDir, port, instanceId) {
  const path = join(dataDir, 'runtime.json');
  const record = { pid: process.pid, port, instanceId, mode: process.env.RUNTIME_MODE || 'local' };
  writePrivate(path, record);
  return () => {
    try { if (JSON.parse(readFileSync(path, 'utf8')).instanceId === instanceId) unlinkSync(path); } catch { /* Another instance may have replaced the record. */ }
  };
}
export async function stopLocalRuntime(dataDir, port) {
  const path = join(dataDir, 'runtime.json');
  if (!existsSync(path)) return false;
  let record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; }
  if (record.mode !== 'local' || record.port !== port || !Number.isInteger(record.pid) || record.pid <= 1 || record.pid === process.pid) return false;
  let health;
  try { health = await (await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'error', signal: AbortSignal.timeout(2000) })).json(); }
  catch { return false; }
  if (health.app !== 'qq-deepseek-bot' || health.instanceId !== record.instanceId) return false;
  process.kill(record.pid, 'SIGTERM');
  return true;
}

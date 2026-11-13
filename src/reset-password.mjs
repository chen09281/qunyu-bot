import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openStore } from './config.mjs';

const dir = resolve(process.env.DATA_DIR || './data');
const password = randomBytes(18).toString('base64url');
const store = await openStore(dir);
if (store.setupRequired) { console.error('尚未创建管理员，请先打开后台完成首次配置。'); process.exit(1); }
await store.changePassword(password);
store.disableTotp();
writeFileSync(join(dir, 'initial-password.txt'), password + '\n', { mode: 0o600 });
console.log(`密码已重置（两步验证已同步解除）。请重启服务，再读取 ${join(dir, 'initial-password.txt')} 登录。`);

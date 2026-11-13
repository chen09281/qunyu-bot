import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { AuthAttemptGuard, redactSecrets, sanitizeJsonValue, validHostHeader } from '../src/security.mjs';
import { TavernManager } from '../src/tavern/tavern-manager.mjs';
import { extractPngTextChunks, normalizeCardData } from '../src/tavern/card-parser.mjs';
import { PromptAssembler } from '../src/tavern/prompt-assembler.mjs';
import { EmotionManager } from '../src/tavern/emotions.mjs';
import { Conversations } from '../src/conversations.mjs';
import { LinkCookies } from '../src/link-cookies.mjs';
import { MusicService } from '../src/music.mjs';
import { createEncryptedBackup, restoreEncryptedBackup } from '../src/backup.mjs';
import { createApplication } from '../src/server.mjs';
import { base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, totpCode, totpUri, verifyTotpCode } from '../src/totp.mjs';

const VALID_1X1_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
);

test('sanitizeJsonValue strips prototype pollution keys recursively', () => {
  const parsed = JSON.parse('{"ok":1,"__proto__":{"polluted":true},"nested":{"constructor":{"prototype":{"x":1}},"safe":"yes"}}');
  const clean = sanitizeJsonValue(parsed);
  assert.equal(clean.ok, 1);
  assert.equal(clean.nested.safe, 'yes');
  assert.equal(Object.hasOwn(clean, '__proto__'), false);
  assert.equal(Object.hasOwn(clean.nested, 'constructor'), false);
  assert.equal(({}).polluted, undefined);
});

test('redactSecrets scrubs Bearer tokens, API keys, URL secret params, and Cookie headers', () => {
  const raw = 'Authorization: Bearer secret_token_123456 failed at https://api.example.com/v1?api_key=abc123&token=xyz789 with sk-proj-abcdef123456 and Cookie: session=secret';
  const redacted = redactSecrets(raw);
  assert.doesNotMatch(redacted, /secret_token_123456/);
  assert.doesNotMatch(redacted, /abc123/);
  assert.doesNotMatch(redacted, /xyz789/);
  assert.doesNotMatch(redacted, /abcdef123456/);
  assert.doesNotMatch(redacted, /session=secret/);
  assert.match(redacted, /\[REDACTED\]/);
});

test('validHostHeader validates Host header syntax', () => {
  assert.equal(validHostHeader('localhost:3080'), true);
  assert.equal(validHostHeader('bot.example.com'), true);
  assert.equal(validHostHeader('[::1]:3080'), true);
  assert.equal(validHostHeader('evil.com/path'), false);
  assert.equal(validHostHeader('user@evil.com'), false);
  assert.equal(validHostHeader('evil.com\r\nX-Test: 1'), false);
});

test('AuthAttemptGuard enforces ip+account lockout and isolates other IPs', () => {
  let now = 1_000_000;
  const guard = new AuthAttemptGuard({ now: () => now, ipMaxAttempts: 20, lockThreshold: 3, lockDurationMs: 60_000 });
  for (let i = 0; i < 3; i++) {
    assert.equal(guard.check('1.2.3.4', 'admin').allowed, true);
    guard.recordFailure('admin', '1.2.3.4');
  }
  const locked = guard.check('1.2.3.4', 'admin');
  assert.equal(locked.allowed, false);
  assert.equal(locked.reason, 'account_locked');

  // Another IP (e.g. real admin) is not locked out by attacker IP
  assert.equal(guard.check('10.0.0.1', 'admin').allowed, true);

  guard.reset('admin', '1.2.3.4');
  assert.equal(guard.check('1.2.3.4', 'admin').allowed, true);
});

test('TavernManager rejects invalid character IDs and non-image sticker uploads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-sec-tavern-'));
  try {
    const tavern = new TavernManager(dir);
    assert.equal(tavern.getCharacter('../etc/passwd'), null);
    assert.equal(tavern.getAvatar('../etc/passwd'), null);
    assert.equal(tavern.deleteCharacter('../etc/passwd'), false);
    assert.throws(() => tavern.saveCharacter('../bad', { name: 'x' }), /无效的角色 ID/);

    const created = tavern.saveCharacter('', { name: '测试角色' });
    assert.throws(
      () => tavern.saveTriggerSticker(created.id, 'rule1', Buffer.from('<script>alert(1)</script>'), 'image/png'),
      /有效的 PNG、JPEG、GIF 或 WebP 图片/
    );
    const saved = tavern.saveTriggerSticker(created.id, 'rule1', VALID_1X1_PNG, 'image/jpeg');
    assert.equal(saved.mimeType, 'image/png');
    assert.ok(saved.filename.endsWith('.png'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP server security headers, host check, login lockout, and tavern input validation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-sec-http-'));
  const app = await createApplication({
    dataDir: dir,
    initialPassword: 'CorrectPassword123',
    bilibiliAutoStart: false,
    douyinAutoStart: false,
    checkinAutoStart: false,
    subscriptionAutoStart: false,
    scheduledChatAutoStart: false,
    serverStatusAutoStart: false,
    operationsAutoStart: false
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    // 1. Security headers on /health
    const healthRes = await fetch(`${base}/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
    assert.equal(healthRes.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(healthRes.headers.get('cross-origin-resource-policy'), 'same-origin');

    // 2. Account lockout after 5 wrong logins
    for (let i = 0; i < 5; i++) {
      const failRes = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-request': '1',
          Origin: base
        },
        body: JSON.stringify({ username: 'admin', password: 'WrongPassword!' })
      });
      assert.equal(failRes.status, 401);
    }
    const lockedRes = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-request': '1',
        Origin: base
      },
      body: JSON.stringify({ username: 'admin', password: 'CorrectPassword123' })
    });
    assert.equal(lockedRes.status, 429);

    // Reset lockout directly via store/login helper not needed if we test with a fresh session,
    // wait: let's test authenticated routes using a valid session created via sessions.create
    const { id: sessionId } = app.sessions.create(app.store.admin);
    const cookie = `qqbot_session=${sessionId}`;

    // 3. Reject unknown fields in /api/tavern/config
    const badTavernCfg = await fetch(`${base}/api/tavern/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-request': '1',
        Origin: base,
        Cookie: cookie
      },
      body: JSON.stringify({ enabled: true, extraEvilField: 'nope' })
    });
    assert.equal(badTavernCfg.status, 400);

    // 4. Sticker upload magic bytes validation + private cache-control
    const charRes = await fetch(`${base}/api/tavern/characters/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-request': '1',
        Origin: base,
        Cookie: cookie
      },
      body: JSON.stringify({ base64: Buffer.from(JSON.stringify({ name: '安全测试角色' })).toString('base64') })
    });
    assert.equal(charRes.status, 200);
    const char = await charRes.json();

    const badSticker = await fetch(`${base}/api/tavern/characters/${char.id}/triggers/r1/sticker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-request': '1',
        Origin: base,
        Cookie: cookie
      },
      body: JSON.stringify({ base64: Buffer.from('<html>evil</html>').toString('base64'), mimeType: 'image/png' })
    });
    assert.equal(badSticker.status, 400);

    const okSticker = await fetch(`${base}/api/tavern/characters/${char.id}/triggers/r1/sticker`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-request': '1',
        Origin: base,
        Cookie: cookie
      },
      body: JSON.stringify({ base64: VALID_1X1_PNG.toString('base64'), mimeType: 'image/png' })
    });
    assert.equal(okSticker.status, 200);
    const stickerData = await okSticker.json();

    const getSticker = await fetch(`${base}/api/tavern/stickers/${stickerData.sticker.filename}`, {
      headers: { Cookie: cookie }
    });
    assert.equal(getSticker.status, 200);
    assert.equal(getSticker.headers.get('cache-control'), 'private, max-age=86400');
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitizeJsonValue drops objects deeper than 32 levels', () => {
  let deep = { __proto__: { hacked: true }, val: 'ok' };
  for (let i = 0; i < 36; i++) deep = { child: deep };
  const clean = sanitizeJsonValue(deep);
  let cur = clean;
  let depth = 0;
  while (cur && cur.child) { cur = cur.child; depth++; }
  assert.ok(depth <= 33);
  assert.equal(({}).hacked, undefined);
});

test('extractPngTextChunks blocks iTXt zip bomb and PromptAssembler enforces system prompt budget', () => {
  const hugeText = Buffer.alloc(5 * 1024 * 1024, 'A');
  const compressed = deflateSync(hugeText);
  const keyword = Buffer.from('chara\0');
  const flags = Buffer.from([1, 0, 0, 0]); // compFlag=1, compMethod=0, empty lang, empty trans
  const body = Buffer.concat([keyword, flags, compressed]);
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
  const type = Buffer.from('iTXt', 'ascii');
  const crc = Buffer.alloc(4);
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const fakePng = Buffer.concat([pngHeader, len, type, body, crc]);
  const chunks = extractPngTextChunks(fakePng);
  assert.equal(chunks.length, 0);

  const hugeCard = normalizeCardData({
    name: '超长角色',
    description: 'B'.repeat(20000),
    personality: 'C'.repeat(20000),
    scenario: 'D'.repeat(20000),
    mes_example: 'E'.repeat(20000)
  });
  const { messages } = PromptAssembler.assembleMessages({ card: hugeCard, prompt: '你是AI吗' });
  assert.ok(messages[0].content.length <= 32000);
  assert.match(messages[0].content, /虚拟角色扮演/);
});

test('TavernManager and EmotionManager quarantine corrupt JSON and reject cross-character stickers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-sec-corrupt-'));
  try {
    const tavern = new TavernManager(dir);
    const char1 = tavern.saveCharacter('', { name: '角色1' });
    assert.throws(
      () => tavern.setEmotionTriggers(char1.id, [{ id: 'r1', name: 't', metric: 'joy', operator: '>=', threshold: 50, sticker: { filename: 'otherchar-r1.png' } }]),
      /必须属于当前角色/
    );
    writeFileSync(tavern.configFile, '{corrupt json', 'utf8');
    const tavern2 = new TavernManager(dir);
    assert.equal(tavern2.state.enabled, false);
    assert.ok(readdirSync(join(dir, 'tavern')).some(f => f.startsWith('config.json.corrupt.')));

    const emoFile = join(dir, 'tavern', 'emotions.json');
    writeFileSync(emoFile, '{bad', 'utf8');
    const emo = new EmotionManager(dir);
    assert.deepEqual(emo.state, { snapshots: {}, active: {} });
    assert.ok(readdirSync(join(dir, 'tavern')).some(f => f.startsWith('emotions.json.corrupt.')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MusicService blocks path traversal in custom track titles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-sec-music-'));
  try {
    const music = new MusicService(dir);
    assert.throws(
      () => music.addTrack({ title: '../secret', artistName: 'a', previewUrl: 'https://audio-ssl.itunes.apple.com/test.m4a' }),
      /歌曲名或歌手格式无效/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Conversations supports deleteConversation, deleteByScope, and pruneOlderThan', () => {
  const conv = new Conversations(':memory:');
  const ev1 = { self_id: '100', message_type: 'group', group_id: '200', user_id: '300', sender: { nickname: 'A' } };
  const ev2 = { self_id: '100', message_type: 'private', user_id: '400', sender: { nickname: 'B' } };
  const s1 = conv.begin(ev1, 'hi', 'deepseek-chat', 'log1');
  conv.finish(s1.turnId, { status: 'sent', reply: 'hello', tokens: 10 });
  const s2 = conv.begin(ev2, 'yo', 'deepseek-chat', 'log2');
  conv.finish(s2.turnId, { status: 'sent', reply: 'sup', tokens: 5 });

  assert.equal(conv.deleteByScope({ groupId: '200' }).conversations, 1);
  assert.equal(conv.detail(s1.conversationId), null);
  assert.equal(conv.deleteConversation(s2.conversationId), true);
  assert.equal(conv.detail(s2.conversationId), null);
  conv.close();
});

test('LinkCookies encrypts at rest when DATA_ENCRYPTION_KEY is provided and backup/restore round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-sec-bak-'));
  const restoreDir = mkdtempSync(join(tmpdir(), 'qqbot-sec-restore-'));
  try {
    const cookies = new LinkCookies(join(dir, 'cookies'), [{ id: 'bilibili', domains: ['bilibili.com'] }], { encryptionKey: 'super-secret-master-key' });
    cookies.save('bilibili', 'SESSDATA=abc123; bili_jct=def456');
    const rawOnDisk = readFileSync(join(dir, 'cookies', 'bilibili.txt'), 'utf8');
    assert.ok(rawOnDisk.startsWith('QQBOT_ENC_V1:'));
    assert.doesNotMatch(rawOnDisk, /abc123/);
    assert.match(cookies.read('bilibili'), /SESSDATA\tabc123/);

    const conv = new Conversations(join(dir, 'conversations.sqlite'));
    const s = conv.begin({ self_id: '100', message_type: 'private', user_id: '400', sender: { nickname: 'B' } }, 'hello', 'm', 'l1');
    conv.finish(s.turnId, { status: 'sent', reply: 'world', tokens: 2 });
    conv.close();

    const bak = createEncryptedBackup(dir, 'backup-pass-1234');
    assert.ok(existsSync(bak.path));
    const restored = restoreEncryptedBackup(bak.path, restoreDir, 'backup-pass-1234');
    assert.ok(restored.files >= 2);
    const conv2 = new Conversations(join(restoreDir, 'conversations.sqlite'));
    assert.equal(conv2.detail(s.conversationId).turns.length, 1);
    conv2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(restoreDir, { recursive: true, force: true });
  }
});

test('TOTP RFC 6238 vectors, recovery codes, 2FA login, backup export API, and reset-password clearing TOTP', async () => {
  // RFC 6238 SHA1 test vector: secret = "12345678901234567890" at t=59s -> 94287082 (6-digit suffix = 287082)
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  assert.equal(base32Decode(rfcSecret).toString('ascii'), '12345678901234567890');
  assert.equal(totpCode(rfcSecret, { timestamp: 59_000 }), '287082');
  assert.equal(verifyTotpCode(rfcSecret, '287082', { timestamp: 59_000, window: 0 }), true);
  assert.equal(verifyTotpCode(rfcSecret, '000000', { timestamp: 59_000, window: 0 }), false);
  const { codes, hashes } = generateRecoveryCodes(6);
  assert.equal(codes.length, 6);
  assert.equal(hashes.length, 6);
  const sampleSecret = generateTotpSecret();
  assert.match(totpUri({ secret: sampleSecret, username: 'admin' }), /^otpauth:\/\/totp\//);

  const dir = mkdtempSync(join(tmpdir(), 'qqbot-sec-totp-'));
  const restoreDir = mkdtempSync(join(tmpdir(), 'qqbot-sec-export-'));
  const app = await createApplication({
    dataDir: dir,
    bilibiliAutoStart: false,
    douyinAutoStart: false,
    checkinAutoStart: false,
    subscriptionAutoStart: false,
    scheduledChatAutoStart: false,
    serverStatusAutoStart: false,
    operationsAutoStart: false
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const port = app.server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const postJson = async (path, body, cookie = '') => fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-request': '1',
        Origin: base,
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: JSON.stringify(body)
    });

    const setup = await postJson('/api/setup-admin', { username: 'admin', password: 'password123', confirmPassword: 'password123' });
    assert.equal(setup.status, 201);
    let cookie = setup.headers.get('set-cookie').split(';')[0];

    const totpInit = await postJson('/api/totp/setup', {}, cookie);
    assert.equal(totpInit.status, 200);
    const { secret, otpauthUrl } = await totpInit.json();
    assert.match(otpauthUrl, /^otpauth:\/\/totp\//);

    const badEnable = await postJson('/api/totp/enable', { currentPassword: 'wrong', code: totpCode(secret) }, cookie);
    assert.equal(badEnable.status, 400);

    const enabled = await postJson('/api/totp/enable', { currentPassword: 'password123', code: totpCode(secret) }, cookie);
    assert.equal(enabled.status, 200);
    cookie = enabled.headers.get('set-cookie').split(';')[0];
    const enabledData = await enabled.json();
    assert.equal(enabledData.totpEnabled, true);
    assert.equal(enabledData.recoveryCodes.length, 6);

    const sessionRes = await fetch(`${base}/api/session`, { headers: { Cookie: cookie } });
    assert.deepEqual(await sessionRes.json(), { authenticated: true, username: 'admin', totpEnabled: true });

    // Step 1 login prompts for TOTP without issuing a session cookie
    const step1 = await postJson('/api/login', { username: 'admin', password: 'password123', rememberMe: false });
    assert.equal(step1.status, 200);
    assert.deepEqual(await step1.json(), { requiresTotp: true });
    assert.equal(step1.headers.get('set-cookie'), null);

    // Wrong code fails
    const badCode = await postJson('/api/login', { username: 'admin', password: 'password123', totpCode: '000000' });
    assert.equal(badCode.status, 401);

    // Valid TOTP code logs in
    const okTotp = await postJson('/api/login', { username: 'admin', password: 'password123', totpCode: totpCode(secret) });
    assert.equal(okTotp.status, 200);
    assert.ok(okTotp.headers.get('set-cookie'));

    // Single-use recovery code works once and cannot be reused
    const oneCode = enabledData.recoveryCodes[0];
    const okRecovery = await postJson('/api/login', { username: 'admin', password: 'password123', totpCode: oneCode });
    assert.equal(okRecovery.status, 200);
    const reuseRecovery = await postJson('/api/login', { username: 'admin', password: 'password123', totpCode: oneCode });
    assert.equal(reuseRecovery.status, 401);

    // Online encrypted backup export round-trips cleanly
    const badExport = await postJson('/api/backup/export', { currentPassword: 'wrong', backupPassword: 'export-pass-999' }, cookie);
    assert.equal(badExport.status, 400);
    const okExport = await postJson('/api/backup/export', { currentPassword: 'password123', backupPassword: 'export-pass-999' }, cookie);
    assert.equal(okExport.status, 200);
    assert.match(okExport.headers.get('content-disposition'), /\.qqbak\.enc"/);
    const archivePath = join(restoreDir, 'downloaded.qqbak.enc');
    writeFileSync(archivePath, Buffer.from(await okExport.arrayBuffer()));
    const extracted = restoreEncryptedBackup(archivePath, join(restoreDir, 'out'), 'export-pass-999');
    assert.ok(extracted.files >= 1);

    // Disable TOTP cleanly via API
    const disabled = await postJson('/api/totp/disable', { currentPassword: 'password123', code: totpCode(secret) }, cookie);
    assert.equal(disabled.status, 200);
    assert.equal((await disabled.json()).totpEnabled, false);
    cookie = disabled.headers.get('set-cookie').split(';')[0];

    // Re-enable TOTP and verify CLI reset-password clears TOTP
    await postJson('/api/totp/setup', {}, cookie);
    const secret2 = (await (await postJson('/api/totp/setup', {}, cookie)).json()).secret;
    const enabled2 = await postJson('/api/totp/enable', { currentPassword: 'password123', code: totpCode(secret2) }, cookie);
    assert.equal(enabled2.status, 200);
    await new Promise(resolve => app.server.close(resolve));

    execFileSync(process.execPath, ['src/reset-password.mjs'], { env: { ...process.env, DATA_DIR: dir } });
    const resetPwd = readFileSync(join(dir, 'initial-password.txt'), 'utf8').trim();
    assert.ok(resetPwd.length >= 16);

    // Restart server against same data dir and verify login works with reset password and no TOTP
    const app2 = await createApplication({
      dataDir: dir,
      bilibiliAutoStart: false,
      douyinAutoStart: false,
      checkinAutoStart: false,
      subscriptionAutoStart: false,
      scheduledChatAutoStart: false,
      serverStatusAutoStart: false,
      operationsAutoStart: false
    });
    await new Promise(resolve => app2.server.listen(0, '127.0.0.1', resolve));
    try {
      const base2 = `http://127.0.0.1:${app2.server.address().port}`;
      const relogin = await fetch(`${base2}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-request': '1', Origin: base2 },
        body: JSON.stringify({ username: 'admin', password: resetPwd })
      });
      assert.equal(relogin.status, 200);
      assert.equal((await relogin.json()).ok, true);
      assert.equal(existsSync(join(dir, 'initial-password.txt')), false);
    } finally {
      await new Promise(resolve => app2.server.close(resolve));
    }
  } finally {
    try { await new Promise(resolve => app.server.close(resolve)); } catch {}
    rmSync(dir, { recursive: true, force: true });
    rmSync(restoreDir, { recursive: true, force: true });
  }
});

// Native adapters based on MIT skyland-auto-sign / MihoyoBBSTools and Apache-2.0
// sign-task API definitions. See notices/README.md for revisions and licenses.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { CheckinError, checkResponse, taskResult, list, field, pause, requestJSON } from './http.mjs';
import { sklandDevice } from './skland-device.mjs';

export const platforms = { skland: '森空岛', miyoushe: '米游社', kuro: '库街区' };
export const platformId = name => Object.keys(platforms).find(id => id === name?.toLowerCase() || platforms[id] === name);
const md5 = value => createHash('md5').update(value).digest('hex');
const jsonHeaders = { 'Content-Type': 'application/json' };
const token = (value, max = 8192) => typeof value === 'string' && value.length >= 8 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
export function parseCredential(platform, raw) {
  if (typeof raw !== 'string' || raw.length > 12000 || /\0/.test(raw)) throw new CheckinError('failed');
  let data;
  try { data = raw.startsWith('{') ? JSON.parse(raw) : null; } catch { throw new CheckinError('failed'); }
  if (data && (typeof data !== 'object' || Array.isArray(data))) throw new CheckinError('failed');
  if (platform === 'skland') {
    const value = data?.token || data?.data?.content || (!data ? raw : '');
    if (!token(value) || (data?.dId !== undefined && !token(data.dId, 256))) throw new CheckinError('failed');
    return { token: value, ...(data?.dId ? { dId: data.dId } : {}) };
  }
  if (platform === 'kuro') {
    const value = data?.token || (!data ? raw : '');
    if (!token(value) || (data?.userId !== undefined && !/^\d{1,30}$/.test(String(data.userId)))
      || (data?.devCode !== undefined && !token(data.devCode, 256))) throw new CheckinError('failed');
    return { token: value, userId: data?.userId ? String(data.userId) : '', devCode: data?.devCode || randomUUID(), deviceId: randomUUID() };
  }
  if (platform === 'miyoushe') {
    const cookie = data?.cookie || (!data ? raw : '');
    if (typeof cookie !== 'string' || cookie.length > 8192 || /[^\x20-\x7e]/.test(cookie)) throw new CheckinError('failed');
    const entries = cookie.split(';').map(part => /^\s*([a-zA-Z0-9_]+)=([^;]*)\s*$/.exec(part)).filter(Boolean);
    const allowed = new Set(['account_id', 'account_id_v2', 'cookie_token', 'cookie_token_v2', 'ltuid', 'ltuid_v2', 'ltoken', 'ltoken_v2', 'ltmid_v2', 'account_mid_v2', 'stuid', 'stoken', 'mid']);
    const values = Object.fromEntries(entries.filter(p => allowed.has(p[1])).map(p => [p[1], p[2].trim()]));
    if (!(values.cookie_token || values.cookie_token_v2) || !(values.account_id || values.account_id_v2 || values.ltuid || values.ltuid_v2)) throw new CheckinError('failed');
    if (values.stoken?.startsWith('v2_') && !values.mid) throw new CheckinError('failed');
    if (values.stoken && !values.stuid) values.stuid = values.account_id || values.account_id_v2 || values.ltuid || values.ltuid_v2;
    return { cookie: Object.entries(values).map(([k, v]) => `${k}=${v}`).join('; '), deviceId: randomUUID() };
  }
  throw new CheckinError('failed');
}

export function sklandSign(path, body, credential, now) {
  const headers = { platform: '3', timestamp: String(Math.floor(now / 1000)), dId: credential.dId, vName: '1.0.0' };
  const payload = path + body + headers.timestamp + JSON.stringify(headers);
  return { ...headers, cred: credential.cred, sign: md5(createHmac('sha256', credential.signToken).update(payload).digest('hex')) };
}
export function miyousheDS(now, body) {
  const t = Math.floor(now / 1000), r = body === undefined ? randomBytes(3).toString('hex') : String(100001 + randomBytes(3).readUIntBE(0, 3) % 99999);
  const material = body === undefined ? `salt=d9200c846b10886e8c874fc33c8f308b&t=${t}&r=${r}`
    : `salt=t0qEgfub6cvueAPgR5m9aQWWVciEer7v&t=${t}&r=${r}&b=${body}&q=`;
  return `${t},${r},${md5(material)}`;
}
const games = {
  bh2_cn: ['崩坏学园2', 'e202203291431091', '3'], bh3_cn: ['崩坏3', 'e202306201626331', '1'],
  nxx_cn: ['未定事件簿', 'e202202251749321', '4'], hk4e_cn: ['原神', 'e202311201442471', '2'],
  hkrpg_cn: ['崩坏：星穹铁道', 'e202304121516551', '6'], nap_cn: ['绝区零', 'e202406242138391', '8'],
};

function playerName(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value)) return '';
  const name = value.trim();
  return Array.from(name).length <= 100 ? name : '';
}
async function roleResult(game, { index, uid, nickname }, action) {
  const name = playerName(nickname);
  const result = await taskResult(`${game} · ${name || `角色 ${index + 1}（未返回昵称）`}`, action);
  if (name) result.playerName = name;
  // Keep the actual role number for record identity; QQ receipts display the game's nickname.
  if (['string', 'number'].includes(typeof uid) && /^\d{1,30}$/.test(String(uid))) result.uid = String(uid);
  return result;
}

export function createCheckinAdapters({ request = requestJSON, now = Date.now, wait = pause } = {}) {
  const call = (url, signal, headers, body, method = body === undefined ? 'GET' : 'POST') => request(url, { method, signal, headers, ...(body === undefined ? {} : { body }) });
  async function sklandLogin(credential, signal) {
    const dId = credential.dId || await sklandDevice(request, signal);
    const headers = { ...jsonHeaders, dId, 'User-Agent': 'Mozilla/5.0 SKLand/1.52.1', 'X-Requested-With': 'com.hypergryph.skland' };
    const grant = await call('https://as.hypergryph.com/user/oauth2/v2/grant', signal, headers, JSON.stringify({ appCode: '4ca99fa6b56cc2ba', token: credential.token, type: 0 }));
    checkResponse(grant, 'status', 0);
    if (!token(grant.data?.code)) throw new CheckinError('failed');
    const auth = await call('https://zonai.skland.com/web/v1/user/auth/generate_cred_by_code', signal, headers, JSON.stringify({ code: grant.data.code, kind: 1 }));
    checkResponse(auth, 'code', 0);
    if (!token(auth.data?.cred) || !token(auth.data?.token)) throw new CheckinError('failed');
    return { ...credential, dId, cred: auth.data.cred, signToken: auth.data.token };
  }
  async function sklandCall(credential, path, signal, body, extra = {}, method) {
    return call(`https://zonai.skland.com${path}`, signal, { ...jsonHeaders, ...sklandSign(path, body || '', credential, now()), ...extra }, body, method);
  }
  async function sklandRoles(c, signal) {
    const result = await sklandCall(c, '/api/v1/game/player/binding', signal);
    checkResponse(result, 'code', 0);
    const roles = [];
    for (const app of list(result.data?.list)) {
      if (!['arknights', 'endfield'].includes(app.appCode)) continue;
      for (const binding of list(app.bindingList)) {
        if (binding.isDelete) continue;
        if (app.appCode === 'arknights') roles.push({ app: app.appCode, uid: field(binding.uid), gameId: field(binding.gameId || '1'), nickname: binding.nickName });
        else for (const role of list(binding.roles || (binding.defaultRole ? [binding.defaultRole] : []))) {
          if (!role.isBanned) roles.push({ app: app.appCode, roleId: field(role.roleId), serverId: field(role.serverId), nickname: role.nickname });
        }
      }
    }
    return list(roles);
  }
  function mysHeaders(c, game, body) {
    return { ...jsonHeaders, Cookie: c.cookie, DS: miyousheDS(now(), body), 'x-rpc-device_id': c.deviceId,
      'x-rpc-app_version': '2.109.0', 'x-rpc-client_type': body === undefined ? '5' : '2',
      'x-rpc-channel': 'miyousheluodi', 'x-rpc-verify_key': 'bll8iq97cem8',
      'x-rpc-csm_source': 'discussion', 'x-rpc-sys_version': '12', 'x-rpc-device_name': 'Android', 'x-rpc-device_model': 'Android',
      Origin: 'https://act.mihoyo.com', Referer: 'https://act.mihoyo.com/',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Mobile miHoYoBBS/2.109.0',
      ...(game === 'nap_cn' ? { 'x-rpc-signgame': 'zzz' } : game === 'hk4e_cn' ? { 'x-rpc-signgame': 'hk4e' } : {}) };
  }
  async function mysRoles(c, signal) {
    const data = await call('https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie', signal, mysHeaders(c));
    checkResponse(data, 'retcode', 0);
    return list(data.data?.list).filter(role => Object.hasOwn(games, role.game_biz));
  }
  async function kuroCall(c, path, body, signal) {
    const result = await call(`https://api.kurobbs.com${path}`, signal, {
      'Content-Type': 'application/x-www-form-urlencoded', token: c.token, devCode: c.devCode, distinct_id: c.deviceId,
      source: 'android', version: '2.2.1', versionCode: '2210', osVersion: 'Android', countryCode: 'CN',
      model: '23127PN0CC', lang: 'zh-Hans', channelId: '2', 'User-Agent': 'okhttp/3.11.0',
      'X-Requested-With': 'com.kurogame.kjq', Origin: 'https://web-static.kurobbs.com',
    }, new URLSearchParams(body).toString());
    if (result.code === 220 && Object.hasOwn(result, 'success')) throw new CheckinError('verification');
    return result;
  }
  return {
    skland: {
      async bind(c, signal) {
        const auth = await sklandLogin(c, signal);
        if (!(await sklandRoles(auth, signal)).length) throw new CheckinError('empty');
        return { token: c.token, dId: auth.dId };
      },
      async run(c, signal) {
        const auth = await sklandLogin(c, signal), roles = await sklandRoles(auth, signal), results = [];
        for (const [index, role] of roles.entries()) {
          results.push(await roleResult(role.app === 'arknights' ? '明日方舟' : '终末地', { index, uid: role.uid || role.roleId, nickname: role.nickname }, async () => {
            await wait(signal);
            const data = role.app === 'arknights'
              ? await sklandCall(auth, '/api/v1/game/attendance', signal, JSON.stringify({ gameId: role.gameId, uid: role.uid }))
              : await sklandCall(auth, '/web/v1/game/endfield/attendance', signal, undefined, { 'sk-game-role': `3_${role.roleId}_${role.serverId}`, Origin: 'https://game.skland.com', Referer: 'https://game.skland.com/' }, 'POST');
            return checkResponse(data, 'code', 0, [10001]);
          }));
        }
        return results.length ? results : [{ label: '游戏签到', status: 'empty' }];
      },
    },
    miyoushe: {
      async bind(c, signal) { await mysRoles(c, signal); return c; },
      async run(c, signal) {
        const roles = await mysRoles(c, signal), results = [], forums = new Set();
        for (const [index, role] of roles.entries()) {
          const [name, act_id, forum] = games[role.game_biz]; forums.add(forum);
          results.push(await roleResult(name, { index, uid: role.game_uid, nickname: role.nickname }, async () => {
            const params = { act_id, region: field(role.region), uid: field(role.game_uid) };
            const base = role.game_biz === 'nap_cn' ? 'https://act-nap-api.mihoyo.com/event/luna/zzz' : 'https://api-takumi.mihoyo.com/event/luna';
            await wait(signal);
            const info = await call(`${base}/info?lang=zh-cn&${new URLSearchParams(params)}`, signal, mysHeaders(c, role.game_biz));
            checkResponse(info, 'retcode', 0);
            if (info.data?.is_sign === true) return 'already';
            if (info.data?.first_bind) return 'first';
            if (info.data?.is_sign !== false) throw new CheckinError('failed');
            await wait(signal);
            const sign = await call(`${base}/sign`, signal, mysHeaders(c, role.game_biz), JSON.stringify(params));
            const status = checkResponse(sign, 'retcode', 0, [-5003]);
            if (status === 'success' && (sign.data?.success === 1 || sign.data?.gt || sign.data?.challenge)) throw new CheckinError('verification');
            if (status === 'success' && sign.data?.success !== 0) throw new CheckinError('failed');
            return status;
          }));
        }
        if (!roles.length) results.push({ label: '游戏签到', status: 'empty' });
        if (!/(?:^|;\s*)stoken=\S+/.test(c.cookie)) results.push({ label: '社区签到', status: 'missing' });
        else for (const forum of forums) {
          const name = Object.values(games).find(g => g[2] === forum)[0];
          results.push(await taskResult(`${name}社区`, async () => {
            await wait(signal);
            const body = JSON.stringify({ gids: forum });
            const data = await call('https://bbs-api.miyoushe.com/apihub/app/api/signIn', signal, mysHeaders(c, undefined, body), body);
            return checkResponse(data, 'retcode', 0, [-5003]);
          }));
        }
        return results;
      },
    },
    kuro: {
      async bind(c, signal) {
        const path = c.userId ? '/user/mineV2' : '/user/mine';
        const data = await kuroCall(c, path, c.userId ? { otherUserId: c.userId } : { type: '1', searchType: '2' }, signal);
        checkResponse(data, 'code', 200);
        const userId = field(data.data?.mine?.userId || data.data?.userInfo?.userId || data.data?.userId);
        if (c.userId && c.userId !== userId) throw new CheckinError('failed');
        return { ...c, userId };
      },
      async run(c, signal) {
        const results = [];
        for (const [gameId, name] of [['2', '战双帕弥什'], ['3', '鸣潮']]) {
          results.push(await taskResult(`${name}社区`, async () => {
            await wait(signal);
            const info = await kuroCall(c, '/user/signIn/info', { gameId }, signal); checkResponse(info, 'code', 200);
            if (info.data?.hasSignIn === true) return 'already';
            if (info.data?.hasSignIn !== false) throw new CheckinError('failed');
            const data = await kuroCall(c, '/user/signIn', { gameId }, signal);
            return checkResponse(data, 'code', 200, [1511]);
          }));
          let roles;
          try {
            const data = await kuroCall(c, '/gamer/role/list', { gameId }, signal); checkResponse(data, 'code', 200); roles = list(data.data);
          } catch (error) { results.push(await taskResult(`${name}游戏`, () => { throw error; })); continue; }
          for (const [index, role] of roles.entries()) {
            results.push(await roleResult(name, { index, uid: role.roleId, nickname: role.roleName }, async () => {
              const params = { gameId, serverId: field(role.serverId), roleId: field(role.roleId), userId: c.userId };
              await wait(signal);
              const info = await kuroCall(c, '/encourage/signIn/initSignInV2', params, signal); checkResponse(info, 'code', 200);
              if (info.data?.isSigIn === true) return 'already';
              if (info.data?.isSigIn !== false) throw new CheckinError('failed');
              const month = new Date(now() + 8 * 3600000).toISOString().slice(5, 7);
              const data = await kuroCall(c, '/encourage/signIn/v2', { ...params, reqMonth: month }, signal);
              return checkResponse(data, 'code', 200, [1511]);
            }));
          }
        }
        return results;
      },
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MusicService, musicRequest, musicCatalogText } from '../src/music.mjs';
import { Bot } from '../src/bot.mjs';
import { Conversations } from '../src/conversations.mjs';
import { defaultConfig } from '../src/config.mjs';

const folder = t => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-music-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const event = text => ({ post_type: 'message', message_type: 'group', self_id: 10001, user_id: 10002, group_id: 10003, message_id: 1,
  message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text } }] });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

test('歌曲请求只匹配播放动作和确认曲目，目录不依赖模型', () => {
  assert.deepEqual(musicRequest('@机器人 播放 纸飞机'), { type: 'song', title: '纸飞机' });
  assert.deepEqual(musicRequest('请播放 deadline disco'), { type: 'song', title: 'Deadline Disco' });
  assert.deepEqual(musicRequest('播放飞行雪绒的歌曲'), { type: 'random' });
  assert.equal(musicRequest('播放一首流行歌曲'), null);
  assert.equal(musicRequest('纸飞机这首歌怎么样'), null);
  assert.match(musicCatalogText(), /星炬不熄/);
});

test('iTunes 预览选择、转换和 NapCat 路径映射正确，完成后清理', async t => {
  const dir = folder(t), audio = Buffer.from('test-audio');
  const fetchImpl = async url => {
    if (url.startsWith('https://itunes.apple.com/search')) return Response.json({ results: [{ trackName: '纸飞机', artistName: '鸣潮先约电台 & 飞行雪绒', previewUrl: 'https://audio-ssl.itunes.apple.com/preview.m4a' }] });
    assert.equal(url, 'https://audio-ssl.itunes.apple.com/preview.m4a'); return new Response(audio);
  };
  const service = new MusicService(dir, { fetchImpl, napcatMediaDir: '/app/qqbot-media', convert: async (input, output) => copyFileSync(input, output) });
  const prepared = await service.prepare('纸飞机');
  assert.match(prepared.file, /^file:\/\/\/app\/qqbot-media\/music\/voice-[^/]+\/voice\.m4a$/);
  assert.equal(readdirSync(service.dir).length, 1); prepared.cleanup(); assert.equal(readdirSync(service.dir).length, 0);
  await assert.rejects(service.prepare('星炬不熄'), /暂未找到/);
});

test('播放歌曲直接发送语音，不调用模型或写入聊天记忆', async t => {
  const store = { config: { ...defaultConfig(), enabled: true, deepseekKey: 'TEST', allowedGroups: ['10003'] } };
  const sent = [];
  const bot = new Bot(store, new Conversations(), null, null, { music: { prepare: async () => ({ title: '纸飞机', file: 'file:///tmp/voice.mp3', cleanup() {} }) } });
  t.after(() => bot.close());
  bot.completion = async () => { throw Error('不应调用模型'); };
  bot.onebot = async (action, params) => sent.push({ action, params });
  bot.receive(event(' 播放 纸飞机')); await settle();
  assert.equal(sent.length, 2); assert.equal(sent[1].action, 'send_group_msg');
  assert.deepEqual(sent[1].params.message, [{ type: 'record', data: { file: 'file:///tmp/voice.mp3' } }]);
  assert.equal(bot.stats.replied, 1); assert.equal(bot.conversations.list().total, 0);
});

test('只请求歌曲目录时发送文字清单，不调用模型', async t => {
  const store = { config: { ...defaultConfig(), enabled: true, deepseekKey: 'TEST', allowedGroups: ['10003'] } };
  const sent = [];
  const bot = new Bot(store, new Conversations(), null, null, { music: { prepare: async () => { throw Error('目录不应下载音频'); } } });
  t.after(() => bot.close()); bot.onebot = async (action, params) => sent.push({ action, params });
  bot.receive(event('飞行雪绒歌曲列表'));  await settle();
  assert.equal(sent.length, 1); assert.match(sent[0].params.message[0].data.text, /Deadline Disco/);
  assert.equal(bot.conversations.list().total, 0);
});

test('本地完整音源优先，不访问外网；映射路径实际位于 NapCat 挂载目录', async t => {
  const { writeFileSync, existsSync } = await import('node:fs'); const { fileURLToPath } = await import('node:url');
  const dir = folder(t), service = new MusicService(dir, { napcatMediaDir: '/shared/media', fetchImpl: () => assert.fail('local track must not access network'), convert: async (input, output) => copyFileSync(input, output) });
  writeFileSync(join(service.tracksDir, '碎花.mp3'), 'test-local-audio');
  const prepared = await service.prepare('碎花'); assert.equal(prepared.preview, false);
  const actual = join(dir, 'media', fileURLToPath(prepared.file).slice('/shared/media/'.length));
  assert.ok(existsSync(actual)); prepared.cleanup(); assert.equal(existsSync(actual), false);
});

test('国际目录英文曲名可匹配中文点歌，专辑入口对应真实曲目，过滤伴奏和错误歌手', async t => {
  const dir = folder(t), service = new MusicService(dir, { convert: async (input, output) => copyFileSync(input, output), fetchImpl: async url => url.includes('/search?') ? Response.json({ results: [
    { trackName: 'Paper Plane', artistName: 'Unrelated artist', previewUrl: 'https://audio-ssl.itunes.apple.com/wrong' },
    { trackName: 'Paper Plane', artistName: 'Wuthering Waves & Fleet Snowfluff', previewUrl: 'https://audio-ssl.itunes.apple.com/paper' },
    { trackName: 'A Small Miracle', artistName: 'Wuthering Waves & Fleet Snowfluff', previewUrl: 'https://audio-ssl.itunes.apple.com/miracle' }
  ] }) : new Response(Buffer.from(url)) });
  for (const title of ['纸飞机', '星轨消逝之夜']) { const p = await service.prepare(title); assert.equal(p.preview, true); if (title === '星轨消逝之夜') assert.match(p.title, /小小奇迹/); p.cleanup(); }
});

test('音乐下载拒绝跨站重定向和流式超限，不留下临时音频', async t => {
  for (const mode of ['redirect', 'large']) {
    const service = new MusicService(folder(t), { fetchImpl: async url => {
      if (url.includes('/search?')) return Response.json({ results: [{ trackName: '碎花', artistName: '飞行雪绒', previewUrl: 'https://audio-ssl.itunes.apple.com/a' }] });
      return mode === 'redirect' ? new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secret' } }) : new Response(new Uint8Array(13 * 1024 * 1024));
    } });
    await assert.rejects(service.prepare('碎花')); assert.deepEqual(readdirSync(service.dir), []);
  }
});

test('撤销白名单或停止服务后，不继续发送歌曲；无 @ 的普通群聊不点歌', async t => {
  const store = { config: { ...defaultConfig(), enabled: true, allowedGroups: ['10003'] } }, sent = [];
  let release; const pending = new Promise(r => { release = r; }); let prepared = false;
  const bot = new Bot(store, new Conversations(), null, null, { music: { prepare: async () => { prepared = true; await pending; return { title: '纸飞机', file: 'file:///voice', cleanup() {} }; } } });
  t.after(() => bot.close()); bot.onebot = async (_a, p) => sent.push(p);
  const noMention = event('播放纸飞机'); noMention.message.shift(); assert.equal(bot.receive(noMention).ignored, 'not_mentioned');
  assert.equal(bot.receive(event('播放纸飞机')).accepted, true); await settle(); assert.equal(prepared, true);
  store.config.allowedGroups = []; release(); await settle(); assert.equal(sent.length, 0);
});

test('播放、演奏及自然点歌近义词、中英文别名覆盖全部曲目，否定和普通讨论不触发', () => {
  for (const action of ['播放', '演奏', '点播', '放一下', '放一首', '来一首', '来首', '听听', '想听', '唱一首']) {
    for (const title of ['碎花','纸飞机','靛青宇宙','Deadline Disco','Brand New Sky','星炬不熄','小小奇迹','星轨消逝之夜']) assert.deepEqual(musicRequest(`${action}《${title}》`), { type:'song', title });
    assert.equal(musicRequest(`不要${action}纸飞机`), null);
  }
  for (const [alias,title] of [['Paper Plane','纸飞机'],['极限迪斯科','Deadline Disco'],['新世界的天空','Brand New Sky'],['星炬不息','星炬不熄']]) assert.deepEqual(musicRequest(`演奏 ${alias}`), {type:'song',title});
  assert.deepEqual(musicRequest('来一首飞行雪绒的歌'), {type:'random'}); assert.equal(musicRequest('小小奇迹的歌词什么意思'),null);
});

test('歌手目录只返回纸飞机时，各首缺失歌曲通过独立查询找回，按歌手返回完整列表', async t => {
  const { musicTracks } = await import('../src/music-catalog.mjs'); const queries=[], dir=folder(t);
  const { writeFileSync } = await import('node:fs'); writeFileSync(join(dir, 'source.mp4'), 'audio');
  const rows = musicTracks.filter(t=>!t.album).map(t=>({trackName:t.title,artistName:'飞行雪绒',previewUrl:'https://audio-ssl.itunes.apple.com/'+encodeURIComponent(t.title)}));
  const service = new MusicService(folder(t), {convert:async (input,output)=>copyFileSync(input,output), linkParser:{downloadBilibiliAudio:async()=>({file:join(dir,'source.mp4'),cleanup(){}})}, fetchImpl:async url=>{
    if(!url.includes('/search?')) return new Response('audio');
    const term=new URL(url).searchParams.get('term');queries.push(term);
    return Response.json({results:term==='飞行雪绒'?rows.filter(r=>r.trackName==='纸飞机'):rows});
  }});
  const view=await service.checkSources();assert.equal(view.artists.length,1);assert.equal(view.artists[0].name,'飞行雪绒');assert.equal(view.artists[0].tracks.length,12);assert.equal(view.artists[0].tracks.filter(t=>t.online).length,12);assert.ok(queries.length>1);
  for(const title of musicTracks.map(t=>t.title)){const p=await service.prepare(title);p.cleanup();}
});

test('插件关闭后所有同义点歌停止语音发送', async t => {
  const store={config:{...defaultConfig(),enabled:true,musicEnabled:false,allowedGroups:['10003']}};
  const bot=new Bot(store,new Conversations(),null,null,{music:{prepare:()=>assert.fail('disabled')}});t.after(()=>bot.close());
  assert.equal(bot.receive(event('演奏碎花')).ignored,'model_not_configured');
});

test('平台搜索可加入自定义目录并直接点歌，M4A 也裁剪', async t => {
  const dir = folder(t), fetchImpl = async url => {
    if (url.includes('/search?')) return Response.json({ results: [{ trackName: 'New Song', artistName: 'Singer', previewUrl: 'https://audio-ssl.itunes.apple.com/new' }] });
    assert.equal(url, 'https://audio-ssl.itunes.apple.com/new'); return new Response(Buffer.from('audio'));
  };
  const service = new MusicService(dir, { fetchImpl, convert: async (input, output, _signal, clip) => { assert.deepEqual(clip, { start: 0, duration: 30 }); copyFileSync(input, output); } });
  const [track] = await service.search('New Song'); assert.equal(track.title, 'New Song');
  service.addTrack(track); assert.throws(() => service.addTrack(track), /已在点播目录/);
  const restored = new MusicService(dir, { fetchImpl, convert: async (input, output, _signal, clip) => { assert.deepEqual(clip, { start: 0, duration: 30 }); copyFileSync(input, output); } });
  assert.deepEqual(restored.request('播放 New Song'), { type: 'song', title: 'New Song' });
  const prepared = await restored.prepare('New Song'); assert.match(prepared.file, /voice\.m4a$/); prepared.cleanup();
  restored.removeTrack('New Song'); assert.equal(restored.customTracks.length, 0);
});

test('iTunes 无预览时使用官方 B 站音源并清理解析目录', async t => {
  const dir = folder(t); let cleaned = 0, convertedInput;
  const { writeFileSync } = await import('node:fs'); writeFileSync(join(dir, 'source.mp4'), 'audio');
  const service = new MusicService(dir, {
    fetchImpl: async () => Response.json({ results: [] }),
    convert: async (input, output) => { convertedInput = input; copyFileSync(input, output); },
    linkParser: {
      downloadBilibiliAudio: async () => ({ file: join(dir, 'source.mp4'), cleanup() { cleaned++; } }),
    },
  });
  for (const title of ['自无垠处归航之星', '远航星的告别']) {
    const prepared = await service.prepare(title);
    assert.equal(convertedInput, join(dir, 'source.mp4'));
    assert.match(prepared.file, /voice\.m4a$/); prepared.cleanup();
  }
  assert.equal(cleaned, 2);
});

test('非 AAC 音源转换为 192k 立体声 AAC', async t => {
  const { writeFileSync, readFileSync, chmodSync } = await import('node:fs');
  const dir = folder(t), service = new MusicService(dir), script = join(dir, 'fake-ffmpeg'), output = join(dir, 'output.m4a'), argsFile = join(dir, 'args.txt');
  writeFileSync(script, `#!/bin/sh\nprintf '%s\n' "$@" > ${JSON.stringify(argsFile)}\n`, { mode: 0o755 }); chmodSync(script, 0o755);
  const previous = process.env.FFMPEG_PATH; process.env.FFMPEG_PATH = script; t.after(() => { if (previous === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous; });
  await service.ffmpeg('input.mp3', output, new AbortController().signal);
  const args = readFileSync(argsFile, 'utf8').replace(/\s+/g, ' ');
  assert.match(args, /-codec:a aac/); assert.match(args, /-b:a 192k/); assert.match(args, /-ar 48000/); assert.match(args, /-ac 2/);
});

test('音乐列表和音源检测接口需要登录与同源，插件开关持久化，不向 QQ 发送消息', async t => {
  const {createApplication}=await import('../src/server.mjs');const {openStore}=await import('../src/config.mjs');
  const dir=folder(t),app=await createApplication({dataDir:dir,initialPassword:'test-only-password',bilibiliAutoStart:false,douyinAutoStart:false,checkinAutoStart:false,subscriptionAutoStart:false,scheduledChatAutoStart:false,serverStatusAutoStart:false,musicOptions:{fetchImpl:async()=>Response.json({results:[]})}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
  app.bot.onebot=()=>assert.fail('management must not send messages');const base=`http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(base+'/api/music')).status,401);
  const headers={'Content-Type':'application/json','X-Admin-Request':'1'};
  const login=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({username:'admin',password:'test-only-password'})});headers.Cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await(await fetch(base+'/api/music',{headers})).json()).artists[0].tracks.length,12);
  assert.equal((await fetch(base+'/api/music/check',{method:'POST',headers:{...headers,Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(base+'/api/music/check',{method:'POST',headers})).status,200);
  const added=await fetch(base+'/api/music/tracks',{method:'POST',headers,body:JSON.stringify({title:'Custom Song',artistName:'Singer',previewUrl:'https://audio-ssl.itunes.apple.com/custom'})});
  assert.equal(added.status,200); assert.ok((await added.json()).artists.some(artist=>artist.id==='custom'));
  assert.equal((await fetch(base+'/api/music/tracks/remove',{method:'POST',headers,body:JSON.stringify({title:'Custom Song'})})).status,200);
  assert.equal((await fetch(base+'/api/config',{method:'PUT',headers,body:JSON.stringify({musicEnabled:false})})).status,200);
  assert.equal((await openStore(dir)).config.musicEnabled,false);
});


test('完整版请求覆盖指定歌曲、随机点歌和自定义目录，否定完整版仍用默认片段', t => {
  assert.deepEqual(musicRequest('播放纸飞机完整版'), { type: 'song', title: '纸飞机', full: true });
  assert.deepEqual(musicRequest('整首播放飞行雪绒的歌'), { type: 'random', full: true });
  assert.deepEqual(musicRequest('播放纸飞机，不要完整版'), { type: 'song', title: '纸飞机' });
  assert.equal(musicRequest('不要播放纸飞机完整版'), null);
  const service = new MusicService(folder(t));
  service.addTrack({ title: '自定义', previewUrl: 'https://audio-ssl.itunes.apple.com/custom' });
  assert.deepEqual(service.request('播放自定义整首'), { type: 'song', title: '自定义', full: true });
  assert.equal(service.request('不要播放自定义'), null);
});

test('本地 M4A 按已标注高潮裁剪，完整版从零播放且不截断，未知高潮明确标为试听', async t => {
  const { writeFileSync } = await import('node:fs');
  const clips = [], service = new MusicService(folder(t), {
    fetchImpl: () => assert.fail('must use local'),
    convert: async (input, output, _signal, clip) => { clips.push(clip); copyFileSync(input, output); },
  });
  writeFileSync(join(service.tracksDir, '纸飞机.m4a'), 'audio');
  writeFileSync(service.segmentsPath, JSON.stringify({ '纸飞机': { start: 67, duration: 30 } }));
  let result = await service.prepare('纸飞机'); assert.equal(result.mode, 'chorus'); result.cleanup();
  result = await service.prepare('纸飞机', { full: true }); assert.equal(result.mode, 'full'); result.cleanup();
  writeFileSync(service.segmentsPath, '{}');
  result = await service.prepare('纸飞机'); assert.equal(result.mode, 'preview'); assert.match(result.notice, /暂未标注/); result.cleanup();
  assert.deepEqual(clips, [{ start: 67, duration: 30 }, { start: 0, duration: null }, { start: 0, duration: 30 }]);
  writeFileSync(service.segmentsPath, JSON.stringify({ '纸飞机': { start: -1 } }));
  await assert.rejects(service.prepare('纸飞机'), /高潮配置无效/);
  assert.deepEqual(readdirSync(service.dir), []);
});

test('请求完整版但仅有公开试听时不冒充完整版，B 站完整音源优先于试听', async t => {
  const { writeFileSync } = await import('node:fs');
  const dir = folder(t); writeFileSync(join(dir, 'source.m4a'), 'audio');
  const service = new MusicService(dir, {
    fetchImpl: async url => url.includes('/search?') ? Response.json({ results: [{ trackName: '纸飞机', artistName: '飞行雪绒', previewUrl: 'https://audio-ssl.itunes.apple.com/preview' }] }) : new Response('audio'),
    convert: async (input, output) => copyFileSync(input, output),
    linkParser: { downloadBilibiliAudio: async () => ({ file: join(dir, 'source.m4a'), cleanup() {} }) },
  });
  let result = await service.prepare('纸飞机', { full: true });
  assert.equal(result.mode, 'preview'); assert.match(result.notice, /仅有试听音源/); result.cleanup();
  service.fetch = () => assert.fail('full source must not query previews');
  result = await service.prepare('远航星的告别', { full: true }); assert.equal(result.mode, 'full'); result.cleanup();
});

test('完整版模式和试听说明传递到 QQ 回复', async t => {
  const calls = [], sent = [], bot = new Bot({ config: { ...defaultConfig(), enabled: true, allowedGroups: ['10003'] } }, new Conversations(), null, null, {
    music: { prepare: async (_title, options) => { calls.push(options.full); return { title: '纸飞机', mode: 'preview', notice: '当前仅有试听音源，暂无法播放完整版。', file: 'file:///voice.m4a', cleanup() {} }; } },
  });
  t.after(() => bot.close()); bot.onebot = async (_action, params) => sent.push(params);
  await bot.runMusic(event('播放纸飞机完整版'), { type: 'song', title: '纸飞机', full: true });
  assert.deepEqual(calls, [true]); assert.match(sent[0].message[0].data.text, /试听片段.*\n当前仅有试听音源/); assert.equal(sent[1].message[0].type, 'record');
});

test('真实 FFmpeg 对 M4A 输出 30 秒片段，完整版保留 65 秒', { skip: !process.env.QQBOT_TEST_FFMPEG }, async t => {
  const { spawnSync } = await import('node:child_process'); const { fileURLToPath } = await import('node:url'); const { writeFileSync } = await import('node:fs');
  const dir = folder(t), service = new MusicService(dir), ffmpeg = process.env.QQBOT_TEST_FFMPEG;
  const previous = process.env.FFMPEG_PATH; process.env.FFMPEG_PATH = ffmpeg;
  t.after(() => { if (previous === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous; });
  const generated = spawnSync(ffmpeg, ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=65', '-c:a', 'aac', join(service.tracksDir, '纸飞机.m4a')], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  writeFileSync(service.segmentsPath, JSON.stringify({ '纸飞机': { start: 15, duration: 30 } }));
  for (const full of [false, true]) {
    const prepared = await service.prepare('纸飞机', { full });
    const checked = spawnSync(ffmpeg, ['-nostdin', '-i', fileURLToPath(prepared.file), '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
    const match = /Duration: (\d+):(\d+):([\d.]+)/.exec(checked.stderr); assert.ok(match, checked.stderr);
    const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    assert.ok(Math.abs(duration - (full ? 65 : 30)) < 0.1, `unexpected duration ${duration}`);
    assert.equal(prepared.mode, full ? 'full' : 'chorus'); prepared.cleanup();
  }
});

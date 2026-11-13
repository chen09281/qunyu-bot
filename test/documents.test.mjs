import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bot } from '../src/bot.mjs';
import { defaultConfig, validatePatch } from '../src/config.mjs';
import { documentPlan, documentSpec, documentFilename, DocumentGenerator } from '../src/documents.mjs';

const config = () => ({ ...defaultConfig(), enabled: true, allowedGroups: ['10003'], deepseekKey: 'test-key', webSearchEnabled: false, cooldownSeconds: 0, maxReplyLength: 100 });
const spec = () => ({ title: '中文验收报告', content: '# 验收报告\n\n正文内容。\n\n| 项目 | 结果 |\n| --- | --- |\n| 识图 | 正常 |' });
const toolMessage = (value = spec()) => ({ content: null, tool_calls: [{ id: 'call-doc', type: 'function', function: { name: 'create_document', arguments: JSON.stringify(value) } }] });
const result = () => ({ choices: [{ message: toolMessage(), finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
const event = (prompt = '生成一份 Word 和 PDF 验收文档', fields = {}) => ({ self_id: 10001, user_id: 10002, group_id: 10003, message_id: 1,
  post_type: 'message', message_type: 'group', message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: prompt } }], ...fields });
const wait = async check => { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('任务未结束'); };
function fixture(t, worker) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-docs-'));
  const generator = new DocumentGenerator(dir, { worker, napcatMediaDir: '/app/qqbot-media' });
  t.after(() => { generator.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, generator };
}
function writeDocuments(input) {
  const files = input.formats.map(format => `document.${format}`);
  for (const file of files) writeFileSync(join(input.directory, file), file.endsWith('.docx') ? Buffer.from('PK\x03\x04TEST') : file.endsWith('.pdf') ? '%PDF-1.7\nTEST' : '中文正文');
  return { files };
}

test('生成意图支持格式、默认 Word 和上下文导出；普通问答、找图及拒绝文件不触发', () => {
  for (const prompt of ['帮我生成一份文档', '写一份需求文档', '把内容导出为 Word 文件']) assert.deepEqual(documentPlan(prompt).formats, ['docx']);
  assert.deepEqual(documentPlan('生成一份 Word 和 PDF 报告').formats, ['docx', 'pdf']);
  assert.deepEqual(documentPlan('保存为 Markdown 和 TXT 文件').formats, ['md', 'txt']);
  assert.deepEqual(documentPlan('发出来', [{ role: 'user', content: '生成一份 PDF 文档' }]).formats, ['pdf']);
  assert.deepEqual(documentPlan('把上面总结导出成 PDF').formats, ['pdf']);
  assert.equal(documentPlan('生成一份 Word 文档，说明如何使用机器人').wanted, true);
  for (const prompt of ['如何生成 PDF 文档？', '是否支持 Word 文件？', '不要生成文件，只发文字', '找一张图片', '解释一下这个词']) assert.equal(documentPlan(prompt).wanted, false, prompt);
  assert.equal(documentPlan('发出来', [{ role: 'user', content: '找一张立绘' }]).wanted, false);
  assert.equal(documentPlan('生成一个 Excel 文件').unsupported, true);
});

test('工具只接受完整的文档数据，不允许模型指定路径、脚本或任意工具', () => {
  assert.deepEqual(documentSpec(toolMessage(), { wanted: true }), spec());
  assert.throws(() => documentSpec(toolMessage(), { wanted: false }), /未授权/);
  for (const value of [{ ...spec(), filename: '/etc/passwd' }, { ...spec(), code: 'exec()' }, { title: '空文档', content: '' }, { ...spec(), content: 'x'.repeat(60001) }]) {
    assert.throws(() => documentSpec(toolMessage(value), { wanted: true }), /正文|文档/);
  }
  assert.throws(() => documentSpec(toolMessage(), { wanted: true }, 'length'), /Token/);
  const invalid = toolMessage(); invalid.tool_calls[0].function.arguments = '{"title":';
  assert.throws(() => documentSpec(invalid, { wanted: true }), /不完整/);
  assert.equal(documentFilename('../验收/报告:草稿.docx', 'pdf'), '_验收_报告_草稿.pdf');
  assert.equal(documentFilename('CON', 'txt'), '文档_CON.txt');
});

test('只有文档请求向 DS 提供工具，思考模式使用 auto，工具结果无需文字回复且正确计费', async () => {
  const bot = new Bot({ config: config() }), requests = [], trace = {};
  bot.request = async (_url, body) => { requests.push(body); return result(); };
  const answer = await bot.completion('生成一份 Word 文档，说明验收流程', config(), trace);
  assert.equal(requests[0].tools[0].function.name, 'create_document'); assert.equal(requests[0].tool_choice, 'auto');
  assert.equal(requests[0].thinking.type, 'enabled'); assert.deepEqual(answer.document.formats, ['docx']);
  assert.equal(answer.document.content, spec().content); assert.equal(trace.tokens, 150);
  bot.request = async (_url, body) => { requests.push(body); return { choices: [{ message: { content: '普通文字回复' } }] }; };
  await bot.completion('你好', config()); assert.equal(requests[1].tools, undefined);
  await bot.completion('生成一份 PDF 文档', { ...config(), documentGenerationEnabled: false }, trace);
  assert.equal(requests[2].tools, undefined); assert.equal(trace.documentStatus, 'disabled');
  assert.throws(() => validatePatch(defaultConfig(), { documentGenerationEnabled: 'true' }), /布尔/);
  bot.close();
});

test('文件生成只接受实际固定输出，跨容器路径正确，上传前可读且清理后不存在', async t => {
  let input;
  const { dir, generator } = fixture(t, async value => { input = value; return writeDocuments(value); });
  const docs = await generator.create(spec(), ['docx', 'pdf']);
  assert.equal(docs.files[0].name, '中文验收报告.docx');
  assert.match(docs.files[0].uploadPath, /^\/app\/qqbot-media\/[a-f0-9-]+\/document\.docx$/);
  assert.equal(existsSync(docs.files[0].path), true); assert.equal(input.content, spec().content);
  docs.cleanup(); assert.deepEqual(readdirSync(join(dir, 'media')), []);
});

test('伪造文件、越界路径、符号链接、超限或缺失输出均失败，并清理任务目录', async t => {
  for (const mode of ['path', 'symlink', 'size', 'signature', 'count', 'error']) {
    let directory;
    const { generator } = fixture(t, async input => {
      directory = input.directory;
      if (mode === 'error') throw Error('渲染失败');
      if (mode === 'path') return { files: ['../secret.docx'] };
      if (mode === 'count') return { files: [] };
      const path = join(directory, 'document.docx');
      if (mode === 'symlink') { writeFileSync(join(directory, 'other.docx'), 'private'); symlinkSync(join(directory, 'other.docx'), path); }
      else { writeFileSync(path, 'invalid'); if (mode === 'size') truncateSync(path, 11 * 1024 * 1024); }
      return { files: ['document.docx'] };
    });
    await assert.rejects(generator.create(spec(), ['docx'])); assert.equal(existsSync(directory), false);
  }
});

test('群聊生成完整文件后上传，成功才确认，正文不受回复长度截断并进入本人文本记忆', async t => {
  const { dir, generator } = fixture(t, async input => writeDocuments(input));
  const bot = new Bot({ config: config() }, undefined, null, generator); t.after(() => bot.close());
  const calls = []; bot.request = async () => result();
  bot.onebot = async (action, params, _config, timeout) => {
    calls.push({ action, params, timeout });
    if (action === 'upload_group_file') assert.equal(readdirSync(join(dir, 'media')).length, 1);
  };
  bot.receive(event()); await wait(() => bot.active === 0);
  assert.deepEqual(calls.map(call => call.action), ['upload_group_file', 'upload_group_file', 'send_group_msg']);
  assert.equal(calls[0].params.group_id, 10003); assert.equal(calls[0].timeout, 120);
  assert.match(calls[2].params.message[1].data.text, /已上传群文件/);
  assert.equal(bot.logs[0].documentStatus, 'sent'); assert.equal(bot.logs[0].documentCount, 2); assert.equal(bot.logs[0].tokens, 150);
  assert.deepEqual(readdirSync(join(dir, 'media')), []);
  const record = bot.conversations.detail(bot.conversations.list().items[0].id);
  assert.match(record.turns[0].reply, /文档正文/); assert.match(record.turns[0].reply, /识图/);
  assert.equal(JSON.stringify(bot.logDetail(bot.logs[0].id)).includes('/app/qqbot-media'), false);
});

test('群文件上传失败不会发送成功确认，保留失败状态与短暂文件宽限期', async t => {
  let cleaned = 0;
  const generator = { create: async () => ({ files: [{ name: '报告.pdf', uploadPath: '/test/document.pdf', format: 'pdf', bytes: 100 }], cleanup: () => cleaned++ }), close() {} };
  const bot = new Bot({ config: config() }, undefined, null, generator); t.after(() => bot.close());
  bot.request = async () => result(); let calls = 0;
  bot.onebot = async action => { calls++; assert.equal(action, 'upload_group_file'); throw Error('群文件无权限'); };
  bot.receive(event('生成一份 PDF 文档')); await wait(() => bot.active === 0);
  assert.equal(calls, 1); assert.equal(cleaned, 0); assert.equal(bot.stats.replied, 0);
  assert.equal(bot.logs[0].documentStatus, 'upload_failed'); assert.match(bot.logs[0].message, /群文件上传失败/);
});

test('文档生成中暂停或关闭权限，停止上传并清理文件；生成器关闭会取消子任务', async t => {
  for (const key of ['enabled', 'documentGenerationEnabled']) {
    const s = { config: config() }; let finish;
    const { dir, generator } = fixture(t, input => new Promise(resolve => { finish = () => resolve(writeDocuments(input)); }));
    const bot = new Bot(s, undefined, null, generator); t.after(() => bot.close());
    bot.request = async () => result(); bot.onebot = async () => { throw Error('不得上传或发消息'); };
    bot.receive(event()); await wait(() => finish); s.config[key] = false; finish();
    await wait(() => bot.active === 0);
    assert.equal(bot.logs[0].documentStatus, 'cancelled'); assert.deepEqual(readdirSync(join(dir, 'media')), []);
  }
  const { generator } = fixture(t, (_input, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('已取消')))));
  const work = generator.create(spec(), ['txt']); generator.close(); await assert.rejects(work, /已取消/);
});

test('真实 Python 文档解析与导出回归', () => {
  const path = fileURLToPath(new URL('./document-worker-test.py', import.meta.url));
  const result = spawnSync('python3', ['-B', path], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

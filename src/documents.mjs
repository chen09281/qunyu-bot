import { spawn } from 'node:child_process';
import { mkdirSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromiumPath } from './douyin-browser.mjs';

export const documentFormats = ['docx', 'pdf', 'md', 'txt'];
export const documentTool = { type: 'function', function: {
  name: 'create_document', description: '生成用户请求的文档并发送到当前 QQ 会话，支持群文件与私聊文件。仅提交文档标题和完整 Markdown 正文，程序负责格式转换与上传；不执行代码，不提供虚构的下载链接。',
  parameters: { type: 'object', properties: { title: { type: 'string', description: '简短、准确的文档标题，不包含路径或扩展名' },
    content: { type: 'string', description: '完整文档正文，使用 Markdown 标题、段落、列表、表格和代码块；不要包含生成过程、发送承诺或沙箱下载链接。' } },
    required: ['title', 'content'], additionalProperties: false }
} };

export function documentPlan(prompt, history = []) {
  const previous = [...history].reverse().find(item => item.role === 'user')?.content || '';
  const formatWords = /\b(?:docx?|word|pdf|markdown|md|txt)\b|文档|文件/i;
  const action = /生成|制作|创建|导出|输出|保存|整理成|整理为|写成|做成|转成|转换成|转为|发(?:给我|出来|一下|到群)|给我|帮我(?:写|做)|写一份/;
  const howto = /怎么|如何|能不能|是否|可以吗|支持吗|为什么/;
  const negated = /(?:不要|不用|无需|别).{0,8}(?:生成|制作|创建|导出|发送|发|文档|文件)|只(?:要|用|发)文字/;
  const questionIndex = prompt.search(howto), actionIndex = prompt.search(action);
  if (negated.test(prompt) || (questionIndex >= 0 && (actionIndex < 0 || questionIndex < actionIndex)
    && !/帮我|给我|请(?:你)?(?:生成|制作|导出)|直接(?:生成|做|导出)/.test(prompt))) return { wanted: false, formats: [] };
  const direct = formatWords.test(prompt) && action.test(prompt);
  const followup = prompt.length < 100 && /导出|转成|改成|发出来|发给我|再生成|重新生成/.test(prompt)
    && /\b(?:docx?|word|pdf|markdown|md|txt)\b|文档|文件/i.test(previous);
  if (!direct && !followup) return { wanted: false, formats: [] };
  const formatsFrom = text => documentFormats.filter(format => ({ docx: /\b(?:docx?|word)\b/i, pdf: /\bpdf\b/i,
    md: /\b(?:markdown|md)\b/i, txt: /\btxt\b|纯文本(?:文件|格式)/i })[format].test(text));
  let formats = formatsFrom(prompt);
  if (!formats.length && /\b(?:xlsx?|excel|pptx?|powerpoint|html|csv)\b/i.test(prompt)) return { wanted: true, formats: [], unsupported: true };
  if (!formats.length && followup) formats = formatsFrom(previous);
  return { wanted: true, formats: formats.length ? formats : ['docx'] };
}

export function documentSpec(message, plan, finishReason) {
  const calls = message?.tool_calls || [];
  if (!calls.length) return null;
  if (!plan.wanted || calls.length !== 1 || calls[0]?.type !== 'function' || calls[0].function?.name !== 'create_document') throw new Error('模型返回未授权的工具调用');
  if (finishReason === 'length') throw new Error('文档内容超过输出 Token 限制，请提高最大输出 Token 或缩短文档要求');
  const raw = calls[0].function.arguments;
  if (typeof raw !== 'string' || raw.length > 250000) throw new Error('文档工具参数无效或过长');
  let spec; try { spec = JSON.parse(raw); } catch { throw new Error('模型返回的文档参数不完整，请重试或提高最大输出 Token'); }
  return validateDocument(spec);
}

export function validateDocument(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || Object.keys(spec).some(key => !['title', 'content'].includes(key))
    || typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 150
    || typeof spec.content !== 'string' || !spec.content.trim() || spec.content.length > 60000
    || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(spec.title + spec.content)) throw new Error('文档需有标题和完整正文，正文最多 60,000 字符');
  return { title: spec.title.trim(), content: spec.content.trim() };
}

export function documentFilename(title, format) {
  const base = title.replace(/\.(?:docx?|pdf|md|txt)$/i, '').replace(/[<>:"/\\|?*\x00-\x1f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  return `${/^(?:con|prn|aux|nul|com\d|lpt\d)$/i.test(base) ? '文档_' : ''}${Array.from(base || '文档').slice(0, 70).join('')}.${format}`;
}

const errors = { dependencies: '文档导出依赖未安装，请安装 requirements-parser.txt 并检查 Chromium',
  render: '文档导出失败，请检查正文格式和导出依赖', size: '文档超过大小限制（单份 10 MiB，总计 20 MiB）',
  output: '文档生成器未返回有效文件', timeout: '文档导出超时，请减少文档内容后重试', cancelled: '文档生成已取消' };
const workerPath = fileURLToPath(new URL('./document-worker.py', import.meta.url));
export function runDocumentWorker(input, { signal, timeout = 90, python = process.env.DOCUMENT_PYTHON || process.env.LINK_PYTHON || 'python3' } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, ['-I', workerPath], { cwd: input.directory, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8' } });
    let output = '', failure, killTimer;
    const stop = code => {
      failure ||= code;
      const kill = signal => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
      kill('SIGTERM'); killTimer ||= setTimeout(() => kill('SIGKILL'), 1000); killTimer.unref();
    };
    const abort = () => stop('cancelled'); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop('timeout'), timeout * 1000); timer.unref();
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 65536) stop('output'); });
    child.stdin.on('error', () => {});
    child.once('error', () => { cleanup(); reject(new Error(errors.dependencies)); });
    child.once('close', code => {
      cleanup(); if (failure) return reject(new Error(errors[failure]));
      let result; try { result = JSON.parse(output); } catch { return reject(new Error(errors.output)); }
      if (code !== 0 || result.error) return reject(new Error(errors[result.error] || errors.render));
      resolvePromise(result);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export class DocumentGenerator {
  constructor(dataDir, options = {}) {
    this.mediaDir = resolve(dataDir, 'media'); this.controllers = new Set(); this.worker = options.worker || runDocumentWorker;
    this.napcatMediaDir = options.napcatMediaDir ?? process.env.NAPCAT_MEDIA_DIR ?? '';
    mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });
    if (lstatSync(this.mediaDir).isSymbolicLink()) throw new Error('文档缓存目录不能是符号链接');
  }
  async create(spec, formats) {
    spec = validateDocument(spec);
    if (!Array.isArray(formats) || !formats.length || formats.length > 4 || new Set(formats).size !== formats.length
      || formats.some(format => !documentFormats.includes(format))) throw new Error('文档仅支持 DOCX、PDF、Markdown 和 TXT');
    const id = randomUUID(), directory = join(this.mediaDir, id), controller = new AbortController();
    mkdirSync(directory, { mode: 0o700 }); this.controllers.add(controller);
    const cleanup = () => { try { rmSync(directory, { recursive: true, force: true }); } catch {} };
    try {
      const result = await this.worker({ ...spec, formats, directory, chromium: process.env.DOCUMENT_CHROMIUM || chromiumPath() }, { signal: controller.signal });
      if (!Array.isArray(result.files) || result.files.length !== formats.length) throw new Error(errors.output);
      let total = 0;
      const files = result.files.map((file, index) => {
        const format = formats[index];
        if (file !== `document.${format}`) throw new Error(errors.output);
        const path = join(directory, file), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error(errors.output);
        total += stat.size;
        if (stat.size > 10 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new Error(errors.size);
        const header = readFileSync(path).subarray(0, 5).toString('latin1');
        if ((format === 'pdf' && header !== '%PDF-') || (format === 'docx' && !header.startsWith('PK\x03\x04'))) throw new Error(errors.output);
        return { name: documentFilename(spec.title, format), format, bytes: stat.size,
          path, uploadPath: this.napcatMediaDir ? join(this.napcatMediaDir, id, file) : path };
      });
      return { files, cleanup };
    } catch (error) { cleanup(); throw error; }
    finally { this.controllers.delete(controller); }
  }
  cancel() { for (const controller of this.controllers) controller.abort(); }
  close() { this.cancel(); }
}

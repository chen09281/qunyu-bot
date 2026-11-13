import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadVisionImage } from './web-images.mjs';

const workerPath = fileURLToPath(new URL('./vision-worker.py', import.meta.url));
let pendingWorker = Promise.resolve();
export function runVisionWorker(input, options = {}) {
  const task = pendingWorker.then(() => { options.signal?.throwIfAborted(); return invokeWorker(input, options); });
  pendingWorker = task.catch(() => {}); return task;
}
function invokeWorker(input, { signal, timeout = 25, python = process.env.VISION_PYTHON || process.env.LINK_PYTHON || 'python3' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', failure = false;
    const stop = () => { failure = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, timeout * 1000); timer.unref();
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.stdout.on('data', data => { output += data.toString(); if (output.length > 36 * 1024 * 1024) stop(); });
    child.stderr.on('data', () => {}); child.stdin.on('error', () => {});
    child.once('error', () => { cleanup(); reject(new Error('图片细节处理组件不可用')); });
    child.once('close', code => {
      cleanup();
      if (failure || code !== 0) return reject(new Error('图片细节处理失败或已取消'));
      try { const result = JSON.parse(output); if (result.error) throw Error(); resolve(result); }
      catch { reject(new Error('图片细节处理失败')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function prepareVisionImages(urls, { signal, download = downloadVisionImage, worker = runVisionWorker } = {}) {
  const images = [], notes = [], sizes = [];
  let crops = 0, fallback = 0, limited = false, partial = false, originalBytes = 0;
  for (const [index, url] of urls.entries()) {
    signal?.throwIfAborted();
    try {
      const original = await download(url, { signal, timeout: 15 }); signal?.throwIfAborted();
      originalBytes += original.buffer.length;
      if (originalBytes > 40 * 1024 * 1024) throw Object.assign(new Error('多张原图合计超过 40 MiB，请减少图片后重试'), { visionLimit: true });
      const result = await worker({ data: original.buffer.toString('base64'), maxCrops: Math.min(8, Math.floor(8 / urls.length)), maxBytes: Math.floor(24 * 1024 * 1024 / urls.length) }, { signal });
      signal?.throwIfAborted();
      images.push(result.overview ? `data:${result.overview.mime};base64,${result.overview.data}` : url);
      sizes.push(`${result.width}×${result.height}`);
      notes.push(`第${index + 1}张用户图片：${result.width}×${result.height}，先给整图，再给${result.crops.length}张局部；局部均为按从上到下、从左到右顺序直接裁剪的无损 PNG，没有缩小像素。`);
      for (const crop of result.crops) images.push(`data:image/png;base64,${crop.data}`);
      if (result.crops.length) notes.push(`第${index + 1}张的局部坐标（左、上、右、下）：${result.crops.map(crop => crop.box.join(',')).join('；')}。相邻局部有重叠，不要重复计数或误当成多张独立图片。`);
      if (result.limited) notes.push('此图受切片数量限制，局部仍可能被模型缩放；若细字依然不可读，请只指出确实不可读的位置，不要猜测。');
      if (result.partial) notes.push('此图因大小或尺寸限制未能提供全部局部细节。不要声称已经逐项读完；必要时请用户单独发送关注区域。');
      crops += result.crops.length; limited ||= result.limited; partial ||= result.partial;
    } catch (error) {
      if (error.visionLimit) throw error;
      signal?.throwIfAborted(); images.push(url); sizes.push('未能读取'); fallback++;
      notes.push(`第${index + 1}张图片只传入原图链接，未能在服务器生成细节切片；请根据实际可见内容回答，不要编造小字。`);
    }
  }
  return { images, notes: notes.join('\n'), stats: { imageSizes: sizes.join('、'), imageOriginalBytes: originalBytes, imageDetailCrops: crops, imageModelInputs: images.length, imagePreparationFallbacks: fallback, imageDetailLimited: limited, imageDetailPartial: partial } };
}

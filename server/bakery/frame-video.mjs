import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { opaqueFrame } from './frame-video-worker.mjs';

/**
 * worker 线程的脚本。本模块在预渲染进程里是被 Vite 打进配置包里加载的(`import.meta.url` 指到仓库根上的临时配置文件),
 * 直接 import 时(测试、脚本)才指到本目录:两处都找一找,都没有回 null(退回主线程做)。
 */
function workerScript() {
  const candidates = [];
  try { candidates.push(fileURLToPath(new URL('./frame-video-worker.mjs', import.meta.url))); } catch { /* 不是文件地址 */ }
  try { candidates.push(fileURLToPath(new URL('./server/bakery/frame-video-worker.mjs', import.meta.url))); } catch { /* 同上 */ }
  candidates.push(path.join(process.cwd(), 'server', 'bakery', 'frame-video-worker.mjs'));
  return candidates.find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } }) ?? null;
}

/** 每个进程只记一次用的是哪条路(排障:看得出 worker 起没起来) */
let modeNoted = false;
function noteMode(mode, fields = {}) {
  if (modeNoted) return;
  modeNoted = true;
  try { console.info(`[frame-video] converter.${mode} ${JSON.stringify(fields)}`); } catch { /* 日志出错不影响 */ }
}

/**
 * 把一帧 PNG 压成不透明 PNG 的活交给一个 worker 线程(`frame-video-worker.mjs`),主线程只转交字节。
 * 起不了 worker、或 worker 中途出错,就退回在主线程上做(同一个函数,结果相同),不让这一趟失败。
 */
export function createConverter() {
  let worker = null;
  let broken = false;
  let seq = 0;
  /** id → { buffer(原帧,退回主线程时用), resolve, reject } */
  const waiting = new Map();
  const inline = (buffer) => Promise.resolve().then(() => opaqueFrame(buffer));
  const fallBack = () => {
    broken = true;
    worker = null;
    for (const [id, w] of waiting) { waiting.delete(id); inline(w.buffer).then(w.resolve, w.reject); }
  };
  const ensure = () => {
    if (worker || broken) return worker;
    const file = workerScript();
    if (!file) { broken = true; noteMode('inline', { reason: 'no-script' }); return null; }
    try {
      worker = new Worker(file);
      noteMode('worker');
      worker.unref();
      worker.on('message', ({ id, data, error }) => {
        const w = waiting.get(id);
        if (!w) return;
        waiting.delete(id);
        if (error !== undefined) inline(w.buffer).then(w.resolve, w.reject);
        else w.resolve(Buffer.from(data));
      });
      worker.on('error', fallBack);
      worker.on('exit', () => { if (waiting.size) fallBack(); worker = null; });
    } catch (error) {
      broken = true;
      worker = null;
      noteMode('inline', { reason: String(error?.message ?? error).slice(0, 160) });
    }
    return worker;
  };
  return {
    convert(buffer) {
      const w = ensure();
      if (!w) return inline(buffer);
      const id = ++seq;
      // 拷进一块独立的 ArrayBuffer 再转交(调用方的 Buffer 可能落在共享池里;原帧留着,worker 出错时退回主线程用)
      const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
      return new Promise((resolve, reject) => {
        waiting.set(id, { buffer, resolve, reject });
        try { w.postMessage({ id, data }, [data]); } catch { fallBack(); }
      });
    },
    /** 诊断:'worker' 在用 worker 线程、'inline' 退回了主线程、null 还没转过 */
    get mode() { return worker ? 'worker' : broken ? 'inline' : null; },
    close() {
      const w = worker;
      worker = null;
      broken = true;
      return w ? w.terminate().then(() => {}, () => {}) : Promise.resolve();
    },
  };
}

/** PNG pipe with backpressure; a video is published only after ffmpeg exits successfully. */
export function frameVideo(ffmpeg, file, fps) {
  const process = spawn(ffmpeg, ['-y', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(fps), '-i', 'pipe:0',
    '-an', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file],
  { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '', error;
  process.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  process.stdin.on('error', e => { error = e; });
  const done = new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve() : reject(error || new Error(`ffmpeg ${code}: ${stderr}`)));
  });
  done.catch(() => {});
  // H.264 has no alpha. Use the same transparency checker as Agent images, at native resolution.
  // 解码、合成、编码在 worker 线程里做(`frame-video-worker.mjs`),不占预渲染进程的主线程
  const converter = createConverter();
  return {
    async write(buffer) {
      if (error) throw error;
      const opaque = await converter.convert(buffer);
      await new Promise((resolve, reject) => process.stdin.write(opaque, e => e ? reject(e) : resolve()));
    },
    async finish() { await converter.close(); process.stdin.end(); await done; },
    async abort() { await converter.close(); process.kill(); await done.catch(() => {}); },
  };
}

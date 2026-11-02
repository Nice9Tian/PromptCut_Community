import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { opaqueFrame } from './frame-video-worker.mjs';

/**
 * Script for the worker thread. In the prerender process, this module is bundled by Vite into a
 * config bundle and loaded (`import.meta.url` points to a temporary config file at the repository
 * root); only direct imports (tests, scripts) point to this directory: check both locations, and
 * return null if neither is found (falls back to running on the main thread).
 */
function workerScript() {
  const candidates = [];
  try { candidates.push(fileURLToPath(new URL('./frame-video-worker.mjs', import.meta.url))); } catch { /* Not a file URL */ }
  try { candidates.push(fileURLToPath(new URL('./server/bakery/frame-video-worker.mjs', import.meta.url))); } catch { /* Same as above */ }
  candidates.push(path.join(process.cwd(), 'server', 'bakery', 'frame-video-worker.mjs'));
  return candidates.find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } }) ?? null;
}

/**
 * Log which path is used only once per process (troubleshooting: reveals whether worker started).
 */
let modeNoted = false;
function noteMode(mode, fields = {}) {
  if (modeNoted) return;
  modeNoted = true;
  try { console.info(`[frame-video] converter.${mode} ${JSON.stringify(fields)}`); } catch { /* Logging errors do not affect execution */ }
}

/**
 * Delegates flattening a PNG frame into an opaque PNG to a worker thread
 * (`frame-video-worker.mjs`), with the main thread only transferring bytes. If the worker cannot
 * be spawned or errors midway, falls back to running on the main thread (same function, identical
 * result) so this pass does not fail.
 */
export function createConverter() {
  let worker = null;
  let broken = false;
  let seq = 0;
  /** id → { buffer (original frame, used when falling back to main thread), resolve, reject } */
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
      // Copy into an independent ArrayBuffer before transfer (caller's Buffer might reside in a shared
      // pool; keep original frame for falling back to main thread if worker errors)
      const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
      return new Promise((resolve, reject) => {
        waiting.set(id, { buffer, resolve, reject });
        try { w.postMessage({ id, data }, [data]); } catch { fallBack(); }
      });
    },
    /**
     * Diagnostics: 'worker' using worker thread, 'inline' fell back to main thread, null not yet
     * converted.
     */
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
  // Decoding, compositing, and encoding run in a worker thread (`frame-video-worker.mjs`),
  // without occupying the prerender process main thread.
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

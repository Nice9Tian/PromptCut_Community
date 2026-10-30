/**
 * 多项目模式的两支逐帧比对探针共用的测试项目与比对（`multi-project-expand-probe.mjs`：看画面那一路；`multi-project-stream-probe.mjs`：产流那一路）。
 * 不是探针本身，不单独跑。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { exportUnified } from '../../server/bakery/export-unified.mjs';
import { findFfmpeg } from '../../server/bakery/index.mjs';

export const mediaDirOf = () => process.env.PC_FRAME_MEDIA_DIR || path.resolve('out/media');
export const W = 640, H = 360, FPS = 30;

export async function makeMedia(stamp = Date.now(), mediaDir = mediaDirOf()) {
  await fs.mkdir(mediaDir, { recursive: true });
  const ffmpeg = await findFfmpeg();
  const v1 = `mpe-${stamp}-a.webm`, v2 = `mpe-${stamp}-b.webm`, img = `mpe-${stamp}-c.png`;
  const run = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true });
  run(['-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=${FPS}:d=6`, '-c:v', 'libvpx-vp9', '-y', path.join(mediaDir, v1)]);
  run(['-f', 'lavfi', '-i', `smptebars=s=${W}x${H}:r=${FPS}:d=6`, '-c:v', 'libvpx-vp9', '-y', path.join(mediaDir, v2)]);
  run(['-f', 'lavfi', '-i', `mandelbrot=s=${W}x${H}`, '-frames:v', '1', '-y', path.join(mediaDir, img)]);
  return { v1, v2, img };
}

export function testProject({ v1, v2, img }) {
  return {
    version: 1, id: 'mpe-probe', name: 'multi-project expand probe', width: W, height: H, fps: FPS, duration: 12, themeId: 'dark',
    media: [
      { id: 'va', kind: 'video', name: v1, url: `/@media/${v1}`, duration: 6 },
      { id: 'vb', kind: 'video', name: v2, url: `/@media/${v2}`, duration: 6 },
      { id: 'im', kind: 'image', name: img, url: `/@media/${img}` },
    ],
    filters: [{ id: 'f-blur', name: 'blur', kind: 'blur', params: {} }],
    transitions: [{ id: 'x1', kind: 'crossfade', aId: 'clip-va', bId: 'clip-vb', dur: 1 }],
    // tracks[0] 是最上层（kernel/project.ts「序列」）：卡在上、剪辑段其次、素材在最下
    tracks: [
      { id: 't-cards-1', name: 'cards 1', clips: [
        { id: 'c-odo', cardId: 'odometer', start: 0, end: 3, params: {} },
        { id: 'c-particles', cardId: 'particles', start: 4, end: 8, params: {} },
        { id: 'c-ticker', cardId: 'mu-number-ticker', start: 8.2, end: 11, params: {} },
      ] },
      { id: 't-cards-2', name: 'cards 2', clips: [
        { id: 'c-blur', cardId: 'blur-text', start: 1, end: 5, params: {} },
        { id: 'c-lottie', cardId: 'lottie', start: 5.5, end: 8.5, params: {} },
        { id: 'c-pill', cardId: 'punch-pill', start: 9.5, end: 12, params: { text: 'Expand' } },
      ] },
      { id: 't-seg', name: 'segment', clips: [{ id: 'seg-b', cardId: '', cutId: 'cut-b', start: 7, end: 11, cutOffset: 1, params: {} }] },
      { id: 't-video-a', name: 'video a', clips: [{ id: 'clip-va', cardId: '', mediaId: 'va', start: 0, end: 4, params: {}, fadeOut: 1 }] },
      { id: 't-video-b', name: 'video b', clips: [{ id: 'clip-vb', cardId: '', mediaId: 'vb', start: 3, end: 7, params: {}, fadeIn: 1, mediaOffset: 0.5 }] },
      { id: 't-image', name: 'image', clips: [{ id: 'clip-im', cardId: '', mediaId: 'im', start: 6.5, end: 9, params: {} }] },
      { id: 't-hidden', name: 'hidden', hidden: true, clips: [{ id: 'hid', cardId: 'punch-pill', start: 0, end: 12, params: { text: 'HIDDEN' } }] },
    ],
    cuts: [
      { id: 'cut-main', name: 'main' },
      { id: 'cut-b', name: 'nested', duration: 6, t: 0, tracks: [{ id: 'b-cards', name: 'b', clips: [
        { id: 'b-ring', cardId: 'ring-metric', start: 0, end: 3, params: {} },
        { id: 'b-check', cardId: 'checklist', start: 2.5, end: 6, params: {} },
      ] }] },
    ],
    activeCutId: 'cut-main',
  };
}

/** 把一份项目交给导出页，取这几帧（项目帧号）的 PNG */
export async function renderFrames(origin, project, frames, dir) {
  const url = `${origin}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(project)))}`;
  const out = await exportUnified(project, { url, out: dir, targetFrames: frames, noVideo: true });
  const map = new Map();
  for (const f of frames) map.set(f, await fs.readFile(path.join(out.framesDir, `${String(f).padStart(6, '0')}.png`)));
  return map;
}

export function comparePng(a, b) {
  const A = PNG.sync.read(a), B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) return { size: false, pixels: A.width * A.height, total: A.width * A.height };
  let diff = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    if (A.data[i] !== B.data[i] || A.data[i + 1] !== B.data[i + 1] || A.data[i + 2] !== B.data[i + 2] || A.data[i + 3] !== B.data[i + 3]) diff += 1;
  }
  return { size: true, pixels: diff, total: A.width * A.height, opaque: (() => { let n = 0; for (let i = 3; i < A.data.length; i += 4) if (A.data[i] > 0) n += 1; return n; })() };
}

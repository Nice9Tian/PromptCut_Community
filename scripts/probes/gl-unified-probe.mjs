/*
 * R9 M4 / M5:canvas 卡迁进共享渲染器之后,「导出」和「生成快照 → 重放」对得上。
 *
 * 照 `scripts/verify-unified-frames.mjs` 的骨架,把卡换成两张 `scene-3d`(一张带贴图),不带视频:
 *   1. 预渲染页逐帧生成 HTML 快照(`bakeFrames({ snapshotOnly })`):gl 平面由 `rasterizeCanvas` 换成 `<img>`,
 *      每一帧都要等 GL 的 `done` —— 没等到就是 `lossy`,`bake.mjs` 当场抛错(这条路本身就是验收);
 *   2. 快照 HTML 里 three 卡是非空的 `<img>`(PNG data URL);
 *   3. `captureSnapshot` 重放第 8 帧,和 `exportUnified` 导出的第 8 帧比:M5 的口径(非边缘像素差 ≤ 1/255);
 *   4. 同一帧重放两次逐字节相同。
 *
 *   PC_FRAME_TEST_URL=http://127.0.0.1:5240 node scripts/probes/gl-unified-probe.mjs
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { bakeFrames } from '../../server/bakery/index.mjs';
import { exportUnified } from '../../server/bakery/export-unified.mjs';
import { captureSnapshot } from '../../server/bakery/capture-snapshot.mjs';
import { devOrigin } from './probe-connect.mjs';

const origin = process.env.PC_FRAME_TEST_URL || devOrigin();
const root = path.resolve('out', `gl-unified-${Date.now()}`);
await fs.mkdir(root, { recursive: true });
const params = { shape: 'knot', color: '#8ab4ff', metal: 0.6, rough: 0.25, size: 0.55, spinY: 0.5, spinX: 0, tilt: -18, light: 'studio', fov: 0, wire: 'no', texture: '' };
const project = { id: 'gl-unified', width: 480, height: 270, fps: 10, duration: 1, media: [], tracks: [
  { id: 'a', clips: [{ id: 'knot', cardId: 'scene-3d', start: 0, end: 1, params, frame: { x: 0, y: 0, w: 240, h: 270 } }] },
  { id: 'b', clips: [{ id: 'ball', cardId: 'scene-3d', start: 0, end: 1, params: { ...params, shape: 'sphere', texture: '/@media/gl-migrate-texture.png' }, frame: { x: 240, y: 0, w: 240, h: 270 } }] },
] };

const EDGE_GRAD = 16;
function m5(a, b) {
  const W = a.width, H = a.height;
  const px = (d, x, y, c) => d[(y * W + x) * 4 + c];
  const edge = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let g = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      for (let c = 0; c < 4; c++) g = Math.max(g, Math.abs(px(a.data, x, y, c) - px(a.data, nx, ny, c)));
    }
    if (g > EDGE_GRAD) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) edge[ny * W + nx] = 1;
    }
  }
  let same = 0, edgeDiff = 0, flatBad = 0, flatMax = 0;
  for (let i = 0; i < W * H; i++) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i * 4 + c] - b.data[i * 4 + c]));
    if (!d) same++; else if (edge[i]) edgeDiff++; else { flatMax = Math.max(flatMax, d); if (d > 1) flatBad++; }
  }
  return { pixels: W * H, same, edgeDiff, flatBad, flatMax };
}

const service = new FramePipeline({ root, origin: () => origin });
let bakery;
try {
  bakery = await service.bakery(project);
  const snapshots = new Map();
  await bakeFrames(bakery, { out: root, frames: '0-9', snapshotOnly: true, onSnapshot: (n, html) => snapshots.set(n, html) });
  assert.equal(snapshots.size, 10, '每一帧都生成了快照(lossy 的帧 bake.mjs 会当场抛错)');
  const html8 = snapshots.get(8);
  const imgs = (html8.match(/<img[^>]*src="data:image\/png;base64,[A-Za-z0-9+/=]{200,}/g) || []).length;
  assert.ok(imgs >= 2, `第 8 帧快照里两张 three 卡都是非空 <img>(实际 ${imgs})`);
  const replay = await captureSnapshot(bakery, html8);
  await fs.writeFile(path.join(root, 'replay-8.png'), replay);
  const again = await captureSnapshot(bakery, html8);
  assert.ok(PNG.sync.read(replay).data.equals(PNG.sync.read(again).data), '同一帧重放两次逐字节相同');
  await bakery.close(); bakery = null;
  const exportUrl = `${origin}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(project)))}`;
  const exported = await exportUnified(project, { url: exportUrl, out: path.join(root, 'exported'), targetFrames: [8] });
  const exportedPng = await fs.readFile(path.join(exported.framesDir, '000008.png'));
  await fs.writeFile(path.join(root, 'export-8.png'), exportedPng);
  const cmp = m5(PNG.sync.read(exportedPng), PNG.sync.read(replay));
  console.log('export vs 快照重放(第 8 帧):', JSON.stringify(cmp));
  assert.equal(cmp.flatBad, 0, '导出与快照重放:非边缘像素差 ≤ 1/255');
  console.log(`PASS: 10 帧快照都等到了 GL 的 done(没有 lossy);快照里 three 卡是非空 <img>(${imgs} 张);重放确定;导出与重放按 M5 口径一致(逐像素相同 ${cmp.same}/${cmp.pixels})。`);
  console.log('Artifacts:', root);
} finally {
  await bakery?.close(); await service.close();
}

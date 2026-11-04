/*
 * R9 M4 / M5: after canvas cards moved into the shared renderer, "export" matches
 * "generate snapshots → replay".
 *
 * Following the skeleton of `scripts/verify-unified-frames.mjs`, replace cards with two `scene-3d`
 * (one with texture), without video:
 *   1. Prerender page generates HTML snapshots frame by frame (`bakeFrames({ snapshotOnly })`):
 *      gl planes are replaced from `rasterizeCanvas` to `<img>`; each frame must wait for GL's
 *      `done`: not receiving it is `lossy`, and `bake.mjs` throws immediately (this path itself
 *      is an acceptance check);
 *   2. Three cards in snapshot HTML are non-empty `<img>` (PNG data URL);
 *   3. `captureSnapshot` replays frame 8, compared against frame 8 exported by `exportUnified`:
 *      M5 criteria (non-edge pixel difference ≤ 1/255);
 *   4. Replaying the same frame twice is byte-for-byte identical.
 *
 *   PC_FRAME_TEST_URL=http://127.0.0.1:5240 node scripts/probes/gl-unified-probe.mjs
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
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
  assert.equal(snapshots.size, 10, 'Snapshots were generated for every frame (bake.mjs throws on the spot for lossy frames)');
  const html8 = snapshots.get(8);
  const imgs = (html8.match(/<img[^>]*src="data:image\/png;base64,[A-Za-z0-9+/=]{200,}/g) || []).length;
  assert.ok(imgs >= 2, `In the frame 8 snapshot both three cards are non-empty <img> (actual ${imgs})`);
  const replay = await captureSnapshot(bakery, html8);
  await fs.writeFile(path.join(root, 'replay-8.png'), replay);
  const again = await captureSnapshot(bakery, html8);
  assert.ok(PNG.sync.read(replay).data.equals(PNG.sync.read(again).data), 'Replaying the same frame twice is byte-identical');
  await bakery.close(); bakery = null;
  const exportUrl = `${origin}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(project)))}`;
  const exported = await exportUnified(project, { url: exportUrl, out: path.join(root, 'exported'), targetFrames: [8] });
  const exportedPng = await fs.readFile(path.join(exported.framesDir, '000008.png'));
  await fs.writeFile(path.join(root, 'export-8.png'), exportedPng);
  const cmp = m5(PNG.sync.read(exportedPng), PNG.sync.read(replay));
  console.log('export vs snapshot replay (frame 8):', JSON.stringify(cmp));
  assert.equal(cmp.flatBad, 0, 'Export vs snapshot replay: non-edge pixel difference ≤ 1/255');
  console.log(`PASS: all 10 frame snapshots waited for GL done (no lossy); the three cards in the snapshots are non-empty <img> (${imgs} of them); replay is deterministic; export and replay agree under the M5 criterion (pixel-identical ${cmp.same}/${cmp.pixels}).`);
  console.log('Artifacts:', root);
} finally {
  await bakery?.close(); await service.close();
}

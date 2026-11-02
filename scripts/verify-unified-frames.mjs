import './lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { FramePipeline } from '../server/frame-pipeline.mjs';
import { bakeFrames, findFfmpeg } from '../server/bakery/index.mjs';
import { exportUnified } from '../server/bakery/export-unified.mjs';
import { captureSnapshot } from '../server/bakery/capture-snapshot.mjs';
import { devOrigin } from './probes/probe-connect.mjs';

// If PC_FRAME_TEST_URL is not provided, hit dev-test (verification env) in .claude/launch.json,
// same source as scripts/probes/.
// The originally hardcoded 5192 is the stage port for the user's resident editor (5190); do not touch it
const origin = process.env.PC_FRAME_TEST_URL || devOrigin();
const root = path.resolve('out', `frame-verification-${Date.now()}`);
const isolatedMedia = process.env.PC_FRAME_MEDIA_DIR || path.resolve('out/media');
await fs.mkdir(isolatedMedia, { recursive: true });
const name = `frame-verification-${Date.now()}.webm`;
const media = path.join(isolatedMedia, name);
const ffmpeg = await findFfmpeg();
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=2', '-c:v', 'libvpx-vp9', '-y', media], { windowsHide: true });
const project = { id: 'verification', width: 320, height: 180, fps: 10, duration: 1, media: [{ id: 'video', kind: 'video', name, url: '/@media/' + name }], tracks: [
  { id: 'top', clips: [{ id: 'card', cardId: 'punch-pill', start: 0, end: 1, params: { text: 'Unified' } }] },
  { id: 'bottom', clips: [{ id: 'v1', mediaId: 'video', start: 0, end: 1, mediaOffset: .4, params: {} }] },
] };
const service = new FramePipeline({ root, origin: () => origin });
let bakery;
try {
  bakery = await service.bakery(project);
  const requests = [];
  bakery.page.on('request', req => { if (req.url().includes(name)) requests.push(req.url()); });
  const snapshots = new Map();
  await bakeFrames(bakery, { out: root, frames: '0-9', snapshotOnly: true, onSnapshot: (n, html) => snapshots.set(n, html) });
  assert.equal(requests.length, 0, 'B must not load any video');
  assert.equal(snapshots.size, 10, 'B must record every frame');
  const late = await captureSnapshot(bakery, snapshots.get(8));
  await fs.writeFile(path.join(root, 'direct.png'), late);
  const first = await captureSnapshot(bakery, snapshots.get(0));
  assert.ok(requests.length > 0, 'capture must load the target video');
  assert.notDeepEqual(PNG.sync.read(first).data, PNG.sync.read(late).data, 'video must seek to different frames');
  assert.deepEqual(PNG.sync.read(late).data, PNG.sync.read(await captureSnapshot(bakery, snapshots.get(8))).data, 'random replay must be deterministic');
  await bakery.close(); bakery = null;
  const entry = await service.entry(project);
  entry.html = snapshots; await service.save(entry);
  const frames = await service.see_frames(project, [.8, 0]);
  assert.equal(frames.get(8).source, 'html');
  const aFrame = PNG.sync.read(frames.get(8).buf).data;
  const direct = PNG.sync.read(late).data;
  assert.ok(aFrame.every((v, i) => Math.abs(v - direct[i]) <= 2), "track bitmap round-trip differs by at most two channel levels");
  // Fetching the same frame a second time is a cache hit. After whole-frame cache switched from
  // cumulative PNG to MOV (8774613), the hit source is called 'mov';
  // 'rendered' only remains for the backward-compatible path reading legacy PNG caches.
  assert.equal((await service.see_frames(project, [.8])).get(8).source, 'mov');
  await service.preload(project); await service.background;
  assert.equal(entry.status, 'ready', entry.error);
  const prerendered = (await service.see_frames(project, [.8])).get(8).buf;
  assert.ok(PNG.sync.read(prerendered).data.equals(aFrame), 'C must exactly match the A pipeline');
  // Artifacts of that background pass cover all 10 frames: the whole-scene frame-by-frame PNG table
  // (queried first in readFramesCore) and frames/ copied out in pass C.
  // Starting from legacy whole-frame channel plan B (AGENT-maint-3), preview.mp4 and whole-scene
  // mov/full.mov are no longer encoded; here we assert that they are indeed gone.
  const exists = file => fs.access(file).then(() => true, () => false);
  assert.deepEqual([...Array(10).keys()].filter(n => !entry.mov.has(n)), [], 'full-scene PNG table must hold every frame');
  const rastered = (await fs.readdir(path.join(entry.dir, 'frames'))).filter(n => /^\d{6}\.png$/.test(n));
  assert.equal(rastered.length, 10, 'C must raster every frame into frames/');
  assert.equal(await exists(path.join(entry.dir, 'preview.mp4')), false, 'preview.mp4 is no longer produced');
  assert.equal(await exists(path.join(entry.dir, 'mov', 'full.mov')), false, 'full-scene full.mov is no longer produced');
  assert.equal(await exists(path.join(root, 'controls-html')), false, 'controls-html is no longer produced');
  assert.equal(await exists(path.join(root, 'controls-local')), false, 'controls-local is no longer produced');
  // The export page itself does not know which project to render, which must be passed in via ?timeline=
  // (same as verify-export-frame-content.mjs); without it, it renders the page default project,
  // which does not match the 320×180 here.
  const exportUrl = `${origin}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(project)))}`;
  const exported = await exportUnified(project, { url: exportUrl, out: path.join(root, 'exported'), targetFrames: [8] });
  const exportedFrame = PNG.sync.read(await fs.readFile(path.join(exported.framesDir, '000008.png'))).data;
  assert.ok(exportedFrame.equals(aFrame), 'export must exactly match see_frames');
  console.log('PASS: no video during B; all HTML frames; exact video seek; random replay; cache hits; cumulative C equals A; PNG table and frames/ hold all 10 frames; no preview.mp4 / full.mov.');
  console.log('Artifacts:', root);
} finally {
  await bakery?.close(); await service.close();
  await fs.rm(media, { force: true });
}

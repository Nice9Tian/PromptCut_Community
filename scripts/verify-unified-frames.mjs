import './lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
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

// 不给 PC_FRAME_TEST_URL 就打 .claude/launch.json 里的 dev-test(验证环境),和 scripts/probes/ 同一个来源。
// 原来写死的 5192 是用户常驻编辑台(5190)的舞台端口,别碰
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
  // 第二次取同一帧是缓存命中。整帧缓存从累积 PNG 换成 MOV 之后(8774613),命中的来源叫 'mov';
  // 'rendered' 只剩读旧 PNG 缓存那条兼容路。
  assert.equal((await service.see_frames(project, [.8])).get(8).source, 'mov');
  await service.preload(project); await service.background;
  assert.equal(entry.status, 'ready', entry.error);
  const prerendered = (await service.see_frames(project, [.8])).get(8).buf;
  assert.ok(PNG.sync.read(prerendered).data.equals(aFrame), 'C must exactly match the A pipeline');
  // 后台那一趟的产物覆盖全部 10 帧:整场景逐帧 PNG 表(readFramesCore 第一步查的)与 C 趟抄出的 frames/。
  // legacy 整帧通道方案 B(AGENT-maint-3)起不再编 preview.mp4 与整场景的 mov/full.mov,这里断言它们确实没了。
  const exists = file => fs.access(file).then(() => true, () => false);
  assert.deepEqual([...Array(10).keys()].filter(n => !entry.mov.has(n)), [], 'full-scene PNG table must hold every frame');
  const rastered = (await fs.readdir(path.join(entry.dir, 'frames'))).filter(n => /^\d{6}\.png$/.test(n));
  assert.equal(rastered.length, 10, 'C must raster every frame into frames/');
  assert.equal(await exists(path.join(entry.dir, 'preview.mp4')), false, 'preview.mp4 is no longer produced');
  assert.equal(await exists(path.join(entry.dir, 'mov', 'full.mov')), false, 'full-scene full.mov is no longer produced');
  assert.equal(await exists(path.join(root, 'controls-html')), false, 'controls-html is no longer produced');
  assert.equal(await exists(path.join(root, 'controls-local')), false, 'controls-local is no longer produced');
  // 导出页自己不知道要渲哪个项目,得经 ?timeline= 带进去(同 verify-export-frame-content.mjs);
  // 不带的话它渲的是页面默认项目,和这里的 320×180 对不上。
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

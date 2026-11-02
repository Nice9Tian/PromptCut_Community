/**
 * Legacy full-frame channel Plan B (item 1 of AGENT-maint-3): only delete unused artifacts.
 *
 * - Whole-scene `mov/full.mov` (encoded by `fillMov` / `writeMov`) is no longer produced:
 *   whole-scene `MovFrameStore` is created with `movie: false`, `start()` does not launch ffmpeg,
 *   deletes `full.mov` left by older versions on load, frame-by-frame PNG table remains as before.
 * - `prerender()` no longer encodes `tracks/<prefix>/preview.mp4` and `<key>/preview.mp4`, deleting
 *   old ones in passing; PNGs rasterized by prefix and copies in `<key>/frames/` remain as before
 *   (they have consumers).
 * - Standalone card copy (`card-cache.mjs`, default `movie: true`) remains unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { MovFrameStore } from '../frame-mov.mjs';
import { FramePipeline } from '../frame-pipeline.mjs';

const exists = file => fs.access(file).then(() => true, () => false);
const png = (r = 255) => { const p = new PNG({ width: 2, height: 2 }); for (let i = 0; i < p.data.length; i += 4) { p.data[i] = r; p.data[i + 3] = 255; } return PNG.sync.write(p); };
const tmp = async t => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mnt3-b-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; };

test('MNT3-B-1 whole-scene store with movie:false: even when a full contiguous prefix is written, no ffmpeg is started and no full.mov is produced; the PNG table is unchanged', async t => {
  const dir = await tmp(t);
  const store = new MovFrameStore({ dir, fps: 30, movie: false });
  let factoryCalls = 0;
  const factory = () => { factoryCalls++; return { write: async () => {}, finish: async () => {}, abort: async () => {} }; };
  await store.start('fake', factory);
  for (const n of [0, 1, 2]) await store.put(n, png(n * 40 + 10));
  await store.start('fake', factory);
  await store.finish();
  assert.equal(factoryCalls, 0, 'No encoding stream is started');
  assert.equal(store.writer, null);
  assert.equal(await exists(store.movieFile), false, 'full.mov is not produced');
  assert.deepEqual([0, 1, 2].map(n => store.has(n)), [true, true, true]);
  for (const n of [0, 1, 2]) assert.ok(await exists(path.join(dir, 'mov', 'frames', `${String(n).padStart(6, '0')}.png`)));
  const table = JSON.parse(await fs.readFile(path.join(dir, 'mov', 'frames.json'), 'utf8'));
  assert.deepEqual(table.frames, [0, 1, 2]);
  assert.equal(table.movie, null, 'The index no longer points to a movie');
});

test('MNT3-B-2 movie:false deletes the full.mov left by older versions on load; the default (the standalone card copy) does not delete it and still encodes as before', async t => {
  const dir = await tmp(t);
  await fs.mkdir(path.join(dir, 'scene', 'mov'), { recursive: true });
  await fs.writeFile(path.join(dir, 'scene', 'mov', 'full.mov'), 'old movie');
  const scene = new MovFrameStore({ dir: path.join(dir, 'scene'), movie: false });
  await scene.ready;
  assert.equal(await exists(path.join(dir, 'scene', 'mov', 'full.mov')), false);

  await fs.mkdir(path.join(dir, 'card', 'mov'), { recursive: true });
  await fs.writeFile(path.join(dir, 'card', 'mov', 'full.mov'), 'card movie');
  const card = new MovFrameStore({ dir: path.join(dir, 'card') });
  await card.ready;
  assert.equal(await fs.readFile(path.join(dir, 'card', 'mov', 'full.mov'), 'utf8'), 'card movie', 'The default leaves it alone');

  const fresh = new MovFrameStore({ dir: path.join(dir, 'card2') });
  const written = [];
  await fresh.start('fake', () => ({ write: async b => { written.push(b); }, finish: async () => {}, abort: async () => {} }));
  await fs.mkdir(path.join(dir, 'card2', 'mov'), { recursive: true });
  // Mock encoder writes temp file out: renames to full.mov on finish
  const origFinish = fresh.writer.finish;
  fresh.writer.finish = async () => { await origFinish(); await fs.writeFile(fresh.tempMovie, 'movie'); };
  await fresh.put(0, png());
  await fresh.finish();
  assert.equal(written.length, 1, 'The default still feeds frames into the encoding stream as before');
  assert.equal(await fs.readFile(path.join(dir, 'card2', 'mov', 'full.mov'), 'utf8'), 'movie');
});

test('MNT3-B-3 the whole-scene store built by the pipeline is movie:false; even writing frame 0 in order with writeMov starts no encoding stream', async t => {
  const root = await tmp(t);
  const service = new FramePipeline({ root, origin: () => '' });
  t.after(() => service.close?.().catch?.(() => {}));
  const project = { id: 'mnt3', width: 2, height: 2, fps: 30, duration: 2 / 30, tracks: [] };
  const entry = await service.entry(project);
  await entry.mov.ready;
  assert.equal(entry.mov.movie, false);
  entry.stage = 'required';
  await service.writeMov(entry, 0, png(), null);
  await service.writeMov(entry, 1, png(20), null);
  assert.equal(entry.mov.writer, null);
  assert.equal(entry.mov.writerError, null);
  assert.equal(await exists(path.join(entry.dir, 'mov', 'full.mov')), false);
  assert.deepEqual([entry.mov.has(0), entry.mov.has(1)], [true, true]);
});

test('MNT3-B-4 fillMov no longer judges "already done" by full.mov: every pass is handed to renderMovFrames (which skips existing frames itself)', async t => {
  const root = await tmp(t);
  const service = new FramePipeline({ root, origin: () => '' });
  const project = { id: 'mnt3-fill', width: 2, height: 2, fps: 30, duration: 3 / 30, tracks: [] };
  const entry = await service.entry(project);
  await entry.mov.ready;
  // Older versions left full.mov on disk: previously returned directly here
  await fs.mkdir(path.join(entry.dir, 'mov'), { recursive: true });
  await fs.writeFile(path.join(entry.dir, 'mov', 'full.mov'), 'stale');
  const calls = [];
  service.renderMovFrames = async (_entry, frames) => { calls.push(frames); for (const n of frames) await entry.mov.put(n, png(n + 1)); };
  await service.fillMov(entry, new AbortController().signal, {});
  assert.deepEqual(calls, [[0, 1, 2]]);
  assert.deepEqual([0, 1, 2].map(n => entry.mov.has(n)), [true, true, true]);
  assert.equal(entry.mov.writer, null);
});

test('MNT3-B-5 prerender only rasterizes and copies frames/: it does not encode preview.mp4, and an old preview.mp4 is deleted along the way', async t => {
  const root = await tmp(t);
  const service = new FramePipeline({ root, origin: () => '' });
  const entry = { key: 'k1', dir: path.join(root, 'k1'), project: { fps: 30 }, html: new Map([[0, 'a'], [1, 'b']]) };
  const prefixes = [{ key: 'p1', trackIds: ['t1'] }, { key: 'p2', trackId: 't2' }];
  service.prefixes = () => prefixes;
  const rastered = [];
  service.rasterPrefix = async (_entry, _bakery, frame, i) => {
    rastered.push([i, frame]);
    const buf = png(i * 100 + frame + 1);
    await fs.mkdir(path.join(root, 'tracks', prefixes[i].key), { recursive: true });
    await fs.writeFile(path.join(root, 'tracks', prefixes[i].key, `${String(frame).padStart(6, '0')}.png`), buf);
    return buf;
  };
  for (const p of prefixes) { await fs.mkdir(path.join(root, 'tracks', p.key), { recursive: true }); await fs.writeFile(path.join(root, 'tracks', p.key, 'preview.mp4'), 'old'); }
  await fs.mkdir(entry.dir, { recursive: true });
  await fs.writeFile(path.join(entry.dir, 'preview.mp4'), 'old');

  await service.prerender(entry, {}, new AbortController().signal);
  assert.deepEqual(rastered, [[0, 0], [0, 1], [1, 0], [1, 1]], 'Every prefix and every frame is rasterized (on a cache hit, rasterPrefix only reads the file itself)');
  for (const frame of [0, 1]) {
    const name = `${String(frame).padStart(6, '0')}.png`;
    assert.deepEqual(await fs.readFile(path.join(entry.dir, 'frames', name)), await fs.readFile(path.join(root, 'tracks', 'p2', name)), 'The last prefix is copied into frames/');
  }
  for (const p of prefixes) assert.equal(await exists(path.join(root, 'tracks', p.key, 'preview.mp4')), false);
  assert.equal(await exists(path.join(entry.dir, 'preview.mp4')), false);
  const leftovers = (await fs.readdir(entry.dir)).filter(n => n.endsWith('.mp4'));
  assert.deepEqual(leftovers, [], 'No temporary mp4');
});

test('MNT3-B-6 canceling prerender midway still throws Cancelled', async t => {
  const root = await tmp(t);
  const service = new FramePipeline({ root, origin: () => '' });
  const controller = new AbortController();
  const entry = { key: 'k2', dir: path.join(root, 'k2'), project: { fps: 30 }, html: new Map([[0, 'a'], [1, 'b']]) };
  service.prefixes = () => [{ key: 'p', trackIds: [] }];
  service.rasterPrefix = async () => { controller.abort(); return png(); };
  await assert.rejects(service.prerender(entry, {}, controller.signal), /Cancelled/);
});

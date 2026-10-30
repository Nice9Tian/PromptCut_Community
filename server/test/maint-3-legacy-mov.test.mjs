/**
 * legacy 整帧通道方案 B(AGENT-maint-3 第 1 项):只删没人用的产物。
 *
 * - 整场景的 `mov/full.mov`(`fillMov` / `writeMov` 编的)不再产:整场景的 `MovFrameStore` 以 `movie: false` 建,
 *   `start()` 不起 ffmpeg,载入时删掉旧版本留下的 `full.mov`,逐帧 PNG 表照旧。
 * - `prerender()` 不再编 `tracks/<前缀>/preview.mp4` 与 `<键>/preview.mp4`,旧的顺手删;
 *   按前缀栅格化的 PNG 与抄进 `<键>/frames/` 的那一份照旧(它们有消费方)。
 * - 独立卡的那一份(`card-cache.mjs`,缺省 `movie: true`)不变。
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

test('MNT3-B-1 movie:false 的整场景存储:写满连续前缀也不起 ffmpeg、不产 full.mov,PNG 表照旧', async t => {
  const dir = await tmp(t);
  const store = new MovFrameStore({ dir, fps: 30, movie: false });
  let factoryCalls = 0;
  const factory = () => { factoryCalls++; return { write: async () => {}, finish: async () => {}, abort: async () => {} }; };
  await store.start('fake', factory);
  for (const n of [0, 1, 2]) await store.put(n, png(n * 40 + 10));
  await store.start('fake', factory);
  await store.finish();
  assert.equal(factoryCalls, 0, '不起编码流');
  assert.equal(store.writer, null);
  assert.equal(await exists(store.movieFile), false, '不产 full.mov');
  assert.deepEqual([0, 1, 2].map(n => store.has(n)), [true, true, true]);
  for (const n of [0, 1, 2]) assert.ok(await exists(path.join(dir, 'mov', 'frames', `${String(n).padStart(6, '0')}.png`)));
  const table = JSON.parse(await fs.readFile(path.join(dir, 'mov', 'frames.json'), 'utf8'));
  assert.deepEqual(table.frames, [0, 1, 2]);
  assert.equal(table.movie, null, '索引里不再指向影片');
});

test('MNT3-B-2 movie:false 载入时删掉旧版本留下的 full.mov;缺省(独立卡那一份)不删、照旧编', async t => {
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
  assert.equal(await fs.readFile(path.join(dir, 'card', 'mov', 'full.mov'), 'utf8'), 'card movie', '缺省不动');

  const fresh = new MovFrameStore({ dir: path.join(dir, 'card2') });
  const written = [];
  await fresh.start('fake', () => ({ write: async b => { written.push(b); }, finish: async () => {}, abort: async () => {} }));
  await fs.mkdir(path.join(dir, 'card2', 'mov'), { recursive: true });
  // 模拟编码器把临时文件写出来:finish 时改名成 full.mov
  const origFinish = fresh.writer.finish;
  fresh.writer.finish = async () => { await origFinish(); await fs.writeFile(fresh.tempMovie, 'movie'); };
  await fresh.put(0, png());
  await fresh.finish();
  assert.equal(written.length, 1, '缺省照旧把帧送进编码流');
  assert.equal(await fs.readFile(path.join(dir, 'card2', 'mov', 'full.mov'), 'utf8'), 'movie');
});

test('MNT3-B-3 管线建的整场景存储是 movie:false;writeMov 按顺序写第 0 帧也不起编码流', async t => {
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

test('MNT3-B-4 fillMov 不再以 full.mov 判「做过了」:每趟都交给 renderMovFrames(它自己跳过已有的帧)', async t => {
  const root = await tmp(t);
  const service = new FramePipeline({ root, origin: () => '' });
  const project = { id: 'mnt3-fill', width: 2, height: 2, fps: 30, duration: 3 / 30, tracks: [] };
  const entry = await service.entry(project);
  await entry.mov.ready;
  // 旧版本在磁盘上留过 full.mov:以前这里就直接返回了
  await fs.mkdir(path.join(entry.dir, 'mov'), { recursive: true });
  await fs.writeFile(path.join(entry.dir, 'mov', 'full.mov'), 'stale');
  const calls = [];
  service.renderMovFrames = async (_entry, frames) => { calls.push(frames); for (const n of frames) await entry.mov.put(n, png(n + 1)); };
  await service.fillMov(entry, new AbortController().signal, {});
  assert.deepEqual(calls, [[0, 1, 2]]);
  assert.deepEqual([0, 1, 2].map(n => entry.mov.has(n)), [true, true, true]);
  assert.equal(entry.mov.writer, null);
});

test('MNT3-B-5 prerender 只栅格化、抄 frames/:不编 preview.mp4,旧的 preview.mp4 顺手删', async t => {
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
  assert.deepEqual(rastered, [[0, 0], [0, 1], [1, 0], [1, 1]], '每个前缀、每一帧都栅格化(缓存命中时 rasterPrefix 自己只读文件)');
  for (const frame of [0, 1]) {
    const name = `${String(frame).padStart(6, '0')}.png`;
    assert.deepEqual(await fs.readFile(path.join(entry.dir, 'frames', name)), await fs.readFile(path.join(root, 'tracks', 'p2', name)), '最后一个前缀抄进 frames/');
  }
  for (const p of prefixes) assert.equal(await exists(path.join(root, 'tracks', p.key, 'preview.mp4')), false);
  assert.equal(await exists(path.join(entry.dir, 'preview.mp4')), false);
  const leftovers = (await fs.readdir(entry.dir)).filter(n => n.endsWith('.mp4'));
  assert.deepEqual(leftovers, [], '没有临时 mp4');
});

test('MNT3-B-6 prerender 中途取消照旧抛 Cancelled', async t => {
  const root = await tmp(t);
  const service = new FramePipeline({ root, origin: () => '' });
  const controller = new AbortController();
  const entry = { key: 'k2', dir: path.join(root, 'k2'), project: { fps: 30 }, html: new Map([[0, 'a'], [1, 'b']]) };
  service.prefixes = () => [{ key: 'p', trackIds: [] }];
  service.rasterPrefix = async () => { controller.abort(); return png(); };
  await assert.rejects(service.prerender(entry, {}, controller.signal), /Cancelled/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { packFrames, unpackFrames, unpackFrameArchive, LazyFrameStore } from '../frame-archive.mjs';
import { frameIdentity, trackPrefixes } from '../frame-identity.mjs';
import { FramePipeline } from '../frame-pipeline.mjs';
import { MovFrameStore } from '../frame-mov.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('frame archive round trips sparse, empty, repeated and unicode HTML as one base64 field', () => {
  const frames = new Map([[0, '<div>你好🙂</div>'], [1, '<div>你好🙂</div>'], [3, ''], [100, '<svg id="x"/>']]);
  const block = packFrames('key', frames);
  assert.match(block, /^[A-Za-z0-9+/=]+$/);
  assert.deepEqual(unpackFrames(block, 'key'), frames);
  assert.throws(() => unpackFrames(block, 'old-key'));
  assert.throws(() => unpackFrames('broken', 'key'));
});
test('deltas compress repeated computed styles without expanding proc JSON', () => {
  const common = 'color:rgb(1,2,3);'.repeat(1000);
  const frames = new Map(Array.from({ length: 100 }, (_, n) => [n, `<div style="${common}">${n}</div>`]));
  const block = packFrames('key', frames);
  assert.ok(block.length < 4000);
  assert.deepEqual(unpackFrames(block, 'key'), frames);
});
test('v2 stores independent 60 second blocks with 10 second checkpoints and lazy random access', () => {
  const fps = 1;
  const frames = new Map(Array.from({ length: 125 }, (_, n) => [n, `<div data-frame="${n}">${'x'.repeat(80)}</div>`]));
  const controls = new Map([
    ['clip-a', new Map([[0, '<span>A0</span>'], [10, '<span>A10</span>'], [11, '<span>A11</span>']])],
    ['clip-b', new Map([[0, '<span>B0</span>'], [60, '<span>B60</span>']])],
  ]);
  const block = packFrames('key', frames, controls, { fps });
  const archive = unpackFrameArchive(block, 'key');
  assert.equal(archive.version, 2);
  assert.ok(archive.frames instanceof LazyFrameStore);
  assert.equal(archive.frames.blocks.length, 3);
  assert.equal(archive.frames.get(10), frames.get(10));
  assert.equal(archive.frames.get(119), frames.get(119));
  assert.equal(archive.controls.get('clip-a').get(11), '<span>A11</span>');
  assert.equal(archive.controls.get('clip-b').get(60), '<span>B60</span>');
  assert.deepEqual(unpackFrames(block, 'key'), frames);
  archive.frames.set(119, '<div data-frame="119">edited</div>');
  const edited = unpackFrameArchive(packFrames('key', archive.frames, archive.controls, { fps }), 'key');
  assert.equal(edited.frames.get(119), '<div data-frame="119">edited</div>');
  assert.equal(edited.frames.get(10), frames.get(10));
});
test('v1 archives remain readable', () => {
  const legacy = gzipSync(Buffer.from(JSON.stringify({ version: 1, key: 'legacy', deltas: [[0, 0, 0, '<p>x</p>'], [1, 3, 0, 'y</p>']], controls: [] }))).toString('base64');
  assert.deepEqual(unpackFrames(legacy, 'legacy'), new Map([[0, '<p>x</p>'], [1, '<p>y</p>']]));
});

test('large frozen HTML is split by bytes and remains editable across repeated saves', () => {
  const frames = new Map(Array.from({ length: 12 }, (_, n) => [n, String.fromCharCode(65 + n).repeat(2 * 1024 * 1024)]));
  let archive = unpackFrameArchive(packFrames('large', frames), 'large');
  assert.ok(archive.frames.blocks.length >= 3);
  for (const block of archive.frames.blocks) {
    const gzip = Buffer.from(block.data, 'base64');
    assert.ok(gzip.readUInt32LE(gzip.length - 4) <= 8 * 1024 * 1024);
  }
  archive.frames.set(6, 'edited');
  archive = unpackFrameArchive(packFrames('large', archive.frames), 'large');
  assert.equal(archive.frames.get(6), 'edited');
  assert.equal(archive.frames.get(11), frames.get(11));
});
test('lazy HTML expansions spill to disk and recover after the memory window is evicted', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptcut-html-spill-'));
  try {
    const frames = new Map(Array.from({ length: 24 }, (_, n) => [n, `<article data-frame="${n}">${'x'.repeat(100)}</article>`]));
    const archive = unpackFrameArchive(packFrames('spill', frames, new Map([
      ['control-a', new Map(Array.from({ length: 20 }, (_, n) => [n, `<span>${n}</span>`]))],
    ])), 'spill', { spillDir: dir });
    for (let n = 0; n < 24; n++) assert.equal(archive.frames.get(n), frames.get(n));
    const stageFiles = await fs.readdir(archive.frames.spillDir);
    assert.ok(stageFiles.length > 0, 'evicted stage frames should be persisted');
    archive.frames.cache.clear();
    assert.equal(archive.frames.get(0), frames.get(0));
    for (let n = 0; n < 20; n++) assert.equal(archive.controls.get('control-a').get(n), `<span>${n}</span>`);
    const controlDir = archive.controls.get('control-a').spillDir;
    assert.ok((await fs.readdir(controlDir)).length > 0, 'control frames should have their own spill directory');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('set invalidates a stale spilled expansion', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptcut-html-spill-edit-'));
  try {
    const archive = unpackFrameArchive(packFrames('edit', new Map(Array.from({ length: 18 }, (_, n) => [n, `old-${n}`]))), 'edit', { spillDir: dir });
    for (let n = 0; n < 18; n++) archive.frames.get(n);
    archive.frames.set(0, 'new-0');
    archive.frames.cache.clear();
    assert.equal(archive.frames.get(0), 'new-0');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('reopening an archive cannot delete another live archive pending spill files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptcut-html-live-'));
  const block = packFrames('live', new Map([[0, 'original']]));
  const first = unpackFrameArchive(block, 'live', { spillDir: dir });
  let second;
  try {
    const expected = new Map(Array.from({ length: 40 }, (_, n) => [n, `pending-${n}`]));
    for (const [n, html] of expected) first.frames.set(n, html);
    second = unpackFrameArchive(packFrames('live', new Map([[0, 'other']])), 'live', { spillDir: dir });
    assert.notEqual(first.frames.spillDir, second.frames.spillDir);
    assert.deepEqual(unpackFrames(packFrames('live', first.frames), 'live'), expected);
    second.dispose();
    assert.deepEqual(unpackFrames(packFrames('live', first.frames), 'live'), expected);
  } finally { first.dispose(); second?.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('unsaved HTML samples survive the memory window without a writable spill directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptcut-html-spill-fail-'));
  try {
    const blocked = path.join(dir, 'not-a-directory');
    await fs.writeFile(blocked, 'occupied');
    const expected = new Map(Array.from({ length: 40 }, (_, n) => [n, `sample-${n}`]));
    for (const spillDir of [null, blocked]) {
      const store = new LazyFrameStore([], { spillDir });
      for (const [frame, html] of expected) store.set(frame, html);
      assert.deepEqual(store.materialize(), expected);
      assert.deepEqual(unpackFrames(packFrames('pending', store), 'pending'), expected);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('spilled pending HTML survives archive save, and missing pending files cannot be silently dropped', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptcut-html-pending-'));
  try {
    const store = new LazyFrameStore([], { spillDir: dir });
    const expected = new Map(Array.from({ length: 40 }, (_, n) => [n, `sample-${n}`]));
    for (const [frame, html] of expected) store.set(frame, html);
    assert.equal(store.overlay.size, 16);
    assert.deepEqual(unpackFrames(packFrames('pending', store), 'pending'), expected);
    await fs.rm(store.spillPath(0));
    assert.throws(() => packFrames('pending', store), /missing or unreadable/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('MOV frame table adopts PNGs and serves random frames without decoding the movie', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptcut-mov-'));
  try {
    await fs.mkdir(path.join(dir, 'mov', 'frames'), { recursive: true });
    await fs.writeFile(path.join(dir, 'mov', 'frames', '000003.png'), Buffer.from('png3'));
    const store = new MovFrameStore({ dir, fps: 30 });
    await store.ready;
    assert.equal(store.has(3), true);
    assert.deepEqual(await store.get(3), Buffer.from('png3'));
    assert.equal(await store.get(2), undefined);
    await store.close();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('MOV writer streams only a contiguous frame prefix and publishes on finish', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptcut-mov-stream-'));
  const writes = [];
  const writerFactory = (_ffmpeg, temp) => ({
    write: async buffer => writes.push(Buffer.from(buffer)),
    finish: async () => fs.writeFile(temp, Buffer.from('movie')),
    abort: async () => {},
  });
  try {
    const store = new MovFrameStore({ dir, fps: 30 });
    await store.ready;
    await store.start('fake', writerFactory);
    await store.put(1, Buffer.from('one'));
    assert.deepEqual(writes, []);
    await store.put(0, Buffer.from('zero'));
    assert.deepEqual(writes, [Buffer.from('zero'), Buffer.from('one')]);
    await store.finish();
    assert.equal(await fs.readFile(path.join(dir, 'mov', 'full.mov'), 'utf8'), 'movie');
    assert.equal(store.has(1), true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
const project = { id: 'p', width: 320, height: 180, fps: 10, duration: 1, media: [], tracks: [
  { id: 'top', clips: [{ id: 'a', cardId: 'a', start: 0, end: 1, params: {} }] },
  { id: 'bottom', clips: [{ id: 'b', cardId: 'b', start: 0, end: 1, params: {} }] },
] };
test('upper track edits preserve lower cumulative cache, lower edits invalidate every dependent prefix', () => {
  const before = trackPrefixes(project, 'code');
  const upper = structuredClone(project); upper.tracks[0].clips[0].params.title = 'changed';
  const after = trackPrefixes(upper, 'code');
  assert.equal(before[0].key, after[0].key);
  assert.notEqual(before[1].key, after[1].key);
  const lower = structuredClone(project); lower.tracks[1].clips[0].params.title = 'changed';
  assert.ok(trackPrefixes(lower, 'code').every((p, i) => p.key !== before[i].key));
  assert.notEqual(frameIdentity(project, 'code'), frameIdentity(project, 'new code'));
});
test('see_frames coalesces concurrent callers, deduplicates and sorts one forward pass', async () => {
  const service = new FramePipeline({ root: '.', origin: () => '' });
  const entry = { key: 'same' };
  service.entry = async () => entry;
  const passes = [];
  service.readFrames = async (_entry, frames) => { passes.push(frames); return new Map(frames.map(n => [n, n])); };
  const [a, b] = await Promise.all([service.see_frames(project, [0.8, 0.2]), service.see_frames(project, [0.4, 0.2])]);
  assert.deepEqual(passes, [[2, 4, 8]]);
  assert.deepEqual([...a.keys()], [8, 2]); assert.deepEqual([...b.keys()], [4, 2]);
  await service.close();
});
test('a cancelled caller does not cancel another caller in the same batch', async () => {
  const service = new FramePipeline({ root: '.', origin: () => '' }); service.entry = async () => ({ key: 'same' });
  service.readFrames = async (_entry, frames) => new Map(frames.map(n => [n, n]));
  const controller = new AbortController(); controller.abort();
  const [a, b] = await Promise.allSettled([service.see_frames(project, [0], { signal: controller.signal }), service.see_frames(project, [0.2])]);
  assert.equal(a.status, 'rejected'); assert.equal(b.status, 'fulfilled');
  await service.close();
});

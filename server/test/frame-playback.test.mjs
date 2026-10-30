import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PNG } from 'pngjs';
import { PlaybackMovStore } from '../frame-mov.mjs';
import { FramePlayback, planPlaybackBatch } from '../frame-playback.mjs';
import { FramePipeline } from '../frame-pipeline.mjs';

const png = n => { const p = new PNG({ width: 16, height: 8 }); p.data.fill(n); return PNG.sync.write(p); };
test('sparse MOV starts transparent at full duration and publishes only complete immutable samples', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-playback-'));
  const movie = new PlaybackMovStore({ dir, width: 16, height: 8, fps: 30, count: 60 });
  try {
    await movie.ready;
    const initial = await fs.readFile(movie.movieFile);
    assert.equal(movie.index(0, 59).frames.length, 0);
    assert.ok(PNG.sync.read(initial.subarray(movie.placeholder.offset)).data.every(n => n === 0));
    for (let i = 0; i < 60; i++) {
      assert.equal(initial.readUInt32BE(movie.sizeTable + 4 * i), movie.placeholder.size);
      assert.equal(Number(initial.readBigUInt64BE(movie.offsetTable + 8 * i)), movie.placeholder.offset);
    }
    const reads = [];
    await Promise.all(Array.from({ length: 60 }, (_, i) => 59 - i).map(async n => {
      const expected = png(n);
      await movie.put(n, expected);
      // Read through independent handles WHILE other appends/table patches run.
      const sample = movie.samples.get(n);
      reads.push((async () => {
        const file = await fs.open(movie.movieFile, 'r');
        try {
          const result = Buffer.alloc(sample.size);
          await file.read(result, 0, result.length, sample.offset);
          assert.deepEqual(result, expected); PNG.sync.read(result);
        } finally { await file.close(); }
      })());
    }));
    await Promise.all(reads);
    assert.equal(movie.samples.size, 60);
    const sample = movie.samples.get(3);
    await movie.put(3, png(99));
    assert.deepEqual(movie.samples.get(3), sample, 'duplicate producers must not replace committed samples');
    const final = await fs.readFile(movie.movieFile);
    assert.equal(final.readUInt32BE(movie.sizeTable + 3 * 4), sample.size);
    assert.equal(Number(final.readBigUInt64BE(movie.offsetTable + 3 * 8)), sample.offset);
  } finally { await movie.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('deadline forecast accounts for rate, skips reservations and captures every frame when capacity permits', () => {
  const input = { frame: 30, fps: 30, count: 900, firstMs: 30, frameMs: 5, jitterMs: 0 };
  const fast = planPlaybackBatch(input);
  assert.equal(fast.stride, 1);
  assert.deepEqual(fast.frames.slice(0, 3), [fast.frames[0], fast.frames[0] + 1, fast.frames[0] + 2]);
  const second = planPlaybackBatch({ ...input, reserved: new Set(fast.frames) });
  assert.ok(second.frames.every(n => !fast.frames.includes(n)));
  const slow = planPlaybackBatch({ ...input, firstMs: 600, frameMs: 120 });
  const double = planPlaybackBatch({ ...input, firstMs: 600, frameMs: 120, rate: 2 });
  assert.ok(slow.stride > 1); assert.ok(double.lead > slow.lead); assert.ok(double.stride >= slow.stride);
  assert.ok(planPlaybackBatch({ ...input, ready: () => true }).frames.length === 0);
});

function fixture(options = {}) {
  let now = 0;
  const committed = new Map();
  const movie = { has: n => committed.has(n), put: async (n, b) => committed.set(n, b), index: () => ({}) };
  const jobs = [];
  const playback = new FramePlayback({ entry: { project: { fps: 30, duration: 20 } }, movie,
    render: (times, opts) => new Promise(resolve => jobs.push({ times, opts, resolve })),
    cached: async () => null, stop: async () => {}, clock: () => now, ...options });
  return { playback, jobs, committed, time: n => { now = n; } };
}

test('each worker meets every batch deadline at measured 1080p cost', () => {
  const reserved = new Set(), plans = [];
  const input = { frame: 300, fps: 30, count: 2661, workers: 3, firstMs: 1700, frameMs: 550, deliveryMs: 250 };
  for (let worker = 0; worker < input.workers; worker++) {
    const plan = planPlaybackBatch({ ...input, reserved }); plans.push(plan);
    plan.frames.forEach((n, i) => {
      assert.ok((n - input.frame) * 1000 / input.fps >= input.firstMs + i * input.frameMs + input.deliveryMs);
      assert.ok(!reserved.has(n)); reserved.add(n);
    });
  }
  const ordered = [...reserved].sort((a, b) => a - b);
  assert.ok(ordered.slice(1).every((n, i) => n - ordered[i] === plans[0].stride));
});

test('tail batches shed impossible outside-timeline debt, and cache holes cannot stretch replay history', () => {
  const tail = planPlaybackBatch({ frame: 2400, count: 2661, fps: 30, firstMs: 3000, frameMs: 2300 });
  assert.ok(tail.frames.length > 0 && tail.frames.length < 6);
  assert.ok(tail.frames.every(n => n < 2661));
  const sparse = planPlaybackBatch({ frame: 0, count: 3000, fps: 30, firstMs: 100, frameMs: 20, ready: n => n % 10 !== 0 });
  assert.ok(!sparse.frames.length || sparse.frames.at(-1) - sparse.frames[0] <= 5 * sparse.stride);
});
test('playback streams batch frames early, bounds workers, and ignores cancelled generation callbacks', async () => {
  const { playback, jobs, committed, time } = fixture();
  try {
    playback.update({ sequence: 1, t: 0, playing: true });
    await playback.pump();
    assert.equal(jobs.length, 3);
    assert.equal(new Set(jobs.flatMap(j => j.times)).size, jobs.reduce((sum, j) => sum + j.times.length, 0));
    time(100);
    await jobs[0].opts.onFrame(30, { source: 'live', buf: 'early' });
    assert.equal(committed.get(30), 'early', 'sample is available before batch resolves');
    playback.update({ sequence: 2, t: 10, playing: true });
    assert.ok(jobs.every(j => j.opts.signal.aborted));
    await jobs[1].opts.onFrame(31, { source: 'live', buf: 'stale' });
    assert.equal(committed.has(31), false);
    assert.equal(playback.update({ sequence: 1, t: 0, playing: false }), false);
    assert.equal(playback.playing, true);
  } finally { playback.cancel(); jobs.forEach(j => j.resolve()); }
});
test('cache-only playback launches no renderers and does not learn bogus render costs; lost heartbeat stops work', async () => {
  let stopped = 0;
  const { playback, jobs, time } = fixture({ cached: async n => `cached-${n}`, stop: async () => { stopped++; } });
  try {
    playback.update({ sequence: 1, t: 0, playing: true });
    await playback.pump();
    assert.equal(jobs.length, 0);
    assert.ok(playback.cacheHits >= 90);
    assert.equal(playback.firstMs, 1000);
    time(6000); await playback.pump();
    assert.equal(stopped, 1); assert.equal(playback.playing, false);
    assert.ok(jobs.every(j => j.opts.signal.aborted));
  } finally { playback.cancel(); jobs.forEach(j => j.resolve()); }
});

test('transport delay does not turn an ordinary playback heartbeat into a seek', () => {
  const { playback, time } = fixture({ wallClock: () => 10000 });
  try {
    playback.update({ sequence: 1, t: 0, playing: true, sentAt: 10000 });
    const epoch = playback.epoch;
    time(1200);
    playback.wallClock = () => 11200;
    playback.update({ sequence: 2, t: 0.4, playing: true, sentAt: 10400 });
    assert.equal(playback.epoch, epoch);
    assert.ok(Math.abs(playback.position() - 36) < 1e-9);
    playback.update({ sequence: 3, t: 10, playing: true, sentAt: 11200 });
    assert.equal(playback.epoch, epoch + 1);
  } finally { playback.cancel(); }
});

test('playback owner replacement rejects late heartbeats and only borrows the confirmed slot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-playback-owner-'));
  const pipeline = new FramePipeline({ root: dir, origin: () => '' });
  const project = { id: 'owner-test', width: 16, height: 8, fps: 10, duration: 1, tracks: [], media: [] };
  try {
    await pipeline.updatePlayback(project, { owner: 'old', sequence: 1, t: 0, playing: false });
    await pipeline.updatePlayback(project, { owner: 'new', sequence: 1, t: 0, playing: true }, { borrow: async () => true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pipeline.userPoolSize, 3);
    const stale = await pipeline.updatePlayback(project, { owner: 'old', sequence: 20, t: 0, playing: true });
    assert.equal(stale.closed, true); assert.equal(pipeline.playback.owner, 'new');
    await pipeline.updatePlayback(project, { owner: 'new', sequence: 2, t: 0, playing: true }, { borrow: async () => false });
    assert.equal(pipeline.userPoolSize, 2);
    await pipeline.updatePlayback(project, { owner: 'new', sequence: 3, t: 0, playing: false });
    assert.equal(pipeline.playback.playing, false);
    assert.equal(pipeline.backgroundLeaseUntil, 0);
  } finally { await pipeline.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('saving one batch cannot drop snapshots arriving from another batch during disk IO', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-playback-save-'));
  const pipeline = new FramePipeline({ root: dir, origin: () => '' });
  try {
    const entry = await pipeline.entry({ width: 16, height: 8, fps: 10, duration: 1, tracks: [], media: [] });
    pipeline.record(entry, 0, '<div>first</div>');
    const saving = pipeline.saveNow(entry);
    pipeline.record(entry, 1, '<div>concurrent</div>');
    await saving;
    assert.equal(entry.html.get(1), '<div>concurrent</div>');
    await pipeline.save(entry);
    assert.equal(entry.html.get(1), '<div>concurrent</div>');
  } finally { await pipeline.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('yield closes only background Chrome, keeps Agent, and expired/old owners cannot release a new lease', async () => {
  const pipeline = new FramePipeline({ root: '.', origin: () => '' });
  const closed = [];
  pipeline.lanes.set('background', { bakery: { close: async () => closed.push('background') } });
  pipeline.lanes.set('agent', { bakery: { close: async () => closed.push('agent') } });
  try {
    await pipeline.yieldBackground('old'); await pipeline.yieldBackground('new');
    await pipeline.resumeBackground('old');
    assert.deepEqual(closed, ['background']);
    assert.ok(pipeline.backgroundLeaseUntil > Date.now());
    await pipeline.resumeBackground('new'); assert.equal(pipeline.backgroundLeaseUntil, 0);
  } finally { await pipeline.close(); }
});

test('a release racing slow Chrome shutdown cannot resume work under a renewed lease', async () => {
  const pipeline = new FramePipeline({ root: '.', origin: () => '' });
  let finishClose;
  pipeline.lanes.set('background', { bakery: { close: () => new Promise(resolve => { finishClose = resolve; }) } });
  try {
    const first = pipeline.yieldBackground('same');
    const release = pipeline.resumeBackground('same');
    const renewal = pipeline.yieldBackground('same');
    finishClose(); await Promise.all([first, release, renewal]);
    assert.ok(pipeline.backgroundLeaseUntil > Date.now());
    await pipeline.resumeBackground('same'); assert.equal(pipeline.backgroundLeaseUntil, 0);
  } finally { await pipeline.close(); }
});

test('isolated card project keeps same-track sibling source clips hidden and preserves their fields', () => {
  const pipeline = new FramePipeline({ root: '.', origin: () => '' });
  const project = { width: 100, height: 50, fps: 30, tracks: [
    { id: 'track', clips: [
      { id: 'target', cardId: 'graph-card', nodeId: 'graph-node', start: 2.01, end: 3, params: { mode: 'mix' } },
      { id: 'input-a', mediaId: 'a', start: 0, end: 8, mediaOffset: 1.25, customSourceFlag: 'keep' },
      { id: 'input-b', cardId: 'other-card', start: 1, end: 4, params: { input: true } },
    ] },
    { id: 'below', clips: [{ id: 'input-c', mediaId: 'c', start: 0, end: 8, mediaOffset: 2 }] },
  ] };
  const isolated = pipeline.isolatedCardProject(project, { clipId: 'target', start: 2.01, end: 3,
    count: 30, sampling: { phase: { numerator: '1', denominator: '100' } } });
  const visible = isolated.tracks.find(track => !track.hidden);
  assert.deepEqual(visible.clips.map(clip => clip.id), ['target']);
  assert.equal(visible.clips[0].start, -0.01);
  const siblingTrack = isolated.tracks.find(track => track.sourceOnly && track.clips.some(clip => clip.id === 'input-a'));
  assert.ok(siblingTrack && siblingTrack.hidden);
  assert.notEqual(siblingTrack.id, 'track');
  assert.deepEqual(siblingTrack.clips.map(clip => clip.id), ['input-a', 'input-b']);
  assert.equal(siblingTrack.clips[0].mediaOffset, 1.25);
  assert.equal(siblingTrack.clips[0].customSourceFlag, 'keep');
  assert.ok(isolated.tracks.find(track => track.id === 'below' && track.hidden && track.sourceOnly));
});

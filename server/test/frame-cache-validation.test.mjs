import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { MovFrameStore, PlaybackMovStore, signatureMatches } from '../frame-mov.mjs';
import { readRenderRecord, withRenderRecord } from '../png-record.mjs';
import { CardFrameCache } from '../card-cache.mjs';
import { FramePlayback } from '../frame-playback.mjs';
import { pngIntegrityError } from '../bakery/png-integrity.mjs';
import { isFullyTransparentPng } from '../frame-validity.mjs';

const image = alpha => {
  const png = new PNG({ width: 8, height: 8 });
  png.data.fill(0);
  if (alpha) for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 200; png.data[i + 3] = alpha; }
  return PNG.sync.write(png);
};
const empty = image(0), painted = image(255), repainted = image(128);
const pixels = buffer => PNG.sync.read(buffer).data;
const samePixels = (actual, expected) => {
  assert.ok(actual, 'expected a frame, got none');
  assert.deepEqual(pixels(actual), pixels(expected));
};
const sig = (capture = 'c1', cards = 'k1', scale = 1) => ({ capture, scale, cards });
const exists = file => fs.access(file).then(() => true, () => false);
const withDir = async (name, fn) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), name));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
};

test('signatures compare only what the expectation specifies, and cards only when both are known', () => {
  assert.equal(signatureMatches(sig(), sig()), true);
  assert.equal(signatureMatches(sig('c1'), sig('c2')), false);
  assert.equal(signatureMatches(sig('c1', 'k1', 1), sig('c1', 'k1', 2)), false);
  assert.equal(signatureMatches(sig('c1', 'k1'), sig('c1', 'k2')), false);
  assert.equal(signatureMatches(sig('c1', null), sig('c1', 'k2')), true);
  assert.equal(signatureMatches(sig('c1', 'k1'), { cards: 'k1' }), true);
  assert.equal(signatureMatches(null, sig()), false);
  assert.equal(signatureMatches(null, null), true);
});

test('a render record embedded in a PNG keeps it valid, decodable and single', () => {
  const record = { signature: sig(), clear: false, renders: 1 };
  const stamped = withRenderRecord(painted, record);
  assert.equal(pngIntegrityError(stamped), null);
  samePixels(stamped, painted);
  assert.deepEqual(readRenderRecord(stamped), record);
  assert.deepEqual(readRenderRecord(stamped.subarray(0, 200)), record, 'readable from the first bytes');
  const restamped = withRenderRecord(stamped, { ...record, renders: 2 });
  assert.equal(restamped.length, stamped.length);
  assert.equal(readRenderRecord(restamped).renders, 2);
  assert.equal(isFullyTransparentPng(withRenderRecord(empty, record)), true);
  assert.equal(readRenderRecord(painted), null);
  assert.equal(withRenderRecord(Buffer.from('png'), record).toString(), 'png');
});

test('an empty render waits for a confirming render; a painted render replaces it', () => withDir('pc-clear-', async dir => {
  const store = new MovFrameStore({ dir, fps: 30 });
  await store.ready;
  await store.put(0, empty, sig());
  assert.equal(store.valid(0, sig()), false);
  assert.equal(store.unconfirmedClear(0), true);
  assert.equal(await store.lookup(0, sig()), undefined);
  await store.put(0, empty, sig());
  assert.equal(store.valid(0, sig()), true);
  samePixels(await store.lookup(0, sig()), empty);

  await store.put(1, empty, sig());
  await store.put(1, painted, sig());
  assert.equal(store.unconfirmedClear(1), false);
  samePixels(await store.lookup(1, sig()), painted);
  // A valid painted frame is kept: the first valid write wins.
  await store.put(1, repainted, sig());
  samePixels(await store.lookup(1, sig()), painted);
  await store.close();
}));

test('a frame produced by other code is removed from the table, the PNG and the movie', () => withDir('pc-evict-', async dir => {
  const store = new MovFrameStore({ dir, fps: 30 });
  await store.ready;
  await store.put(2, painted, sig('c1'));
  await fs.writeFile(store.movieFile, 'published movie');
  const evicted = [];
  store.onEvict = frame => { evicted.push(frame); };
  assert.equal(await store.lookup(2, sig('c2')), undefined);
  assert.deepEqual(evicted, [2]);
  assert.equal(store.has(2), false);
  assert.equal(await exists(path.join(store.frameDir, '000002.png')), false);
  assert.equal(await exists(store.movieFile), false);
  // Re-rendered by the current code, it is accepted again.
  await store.put(2, repainted, sig('c2'));
  samePixels(await store.lookup(2, sig('c2')), repainted);
  // Unknown card keys on either side do not discard a frame.
  await store.put(3, painted, sig('c2', null));
  samePixels(await store.lookup(3, sig('c2', 'k9')), painted);
  await store.close();
}));

test('a PNG without a render record is re-rendered, not deleted, and records survive a reload', () => withDir('pc-legacy-', async dir => {
  await fs.mkdir(path.join(dir, 'mov', 'frames'), { recursive: true });
  await fs.writeFile(path.join(dir, 'mov', 'frames', '000004.png'), painted);
  const store = new MovFrameStore({ dir, fps: 30 });
  await store.ready;
  assert.equal(await store.lookup(4, sig()), undefined);
  assert.equal(await exists(path.join(dir, 'mov', 'frames', '000004.png')), true);
  await store.put(4, repainted, sig());
  samePixels(await store.lookup(4, sig()), repainted);
  await store.put(5, empty, sig());
  await store.put(6, empty, sig()); await store.put(6, empty, sig());
  await store.close();

  const reopened = new MovFrameStore({ dir, fps: 30 });
  await reopened.hydrate([4, 5, 6]);
  assert.equal(reopened.valid(4, sig()), true);
  assert.equal(reopened.valid(4, sig('other')), false);
  assert.equal(reopened.unconfirmedClear(5), true);
  assert.equal(reopened.valid(6, sig()), true);
  await reopened.close();
}));

test('frames written by another process sharing the cache are recognised', () => withDir('pc-shared-', async dir => {
  // The editor server and the prerender worker each hold their own store.
  const editor = new MovFrameStore({ dir, fps: 30 });
  const worker = new MovFrameStore({ dir, fps: 30 });
  await Promise.all([editor.ready, worker.ready]);
  await worker.put(7, painted, sig());
  await worker.put(8, empty, sig()); await worker.put(8, empty, sig());
  await worker.close();
  samePixels(await editor.lookup(7, sig()), painted);
  assert.equal(await editor.lookup(7, sig('other-capture')), undefined, 'still verified against its record');
  await editor.hydrate([8, 9]);
  assert.equal(editor.valid(8, sig()), true, 'a confirmed empty frame stays confirmed across processes');
  assert.equal(editor.has(9), false);
  await editor.close();
}));

test('a rename refused while another process holds the file is retried', t => withDir('pc-eperm-', async dir => {
  const store = new MovFrameStore({ dir, fps: 30 });
  await store.ready;
  const rename = fs.rename;
  let refused = 0;
  t.mock.method(fs, 'rename', async (...args) => {
    if (refused < 2) { refused++; throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); }
    return rename(...args);
  });
  await store.put(0, painted, sig());
  assert.equal(refused, 2);
  samePixels(await store.lookup(0, sig()), painted);
  await store.close();
}));

test('a failed write does not reject the puts after it', () => withDir('pc-chain-', async dir => {
  const store = new MovFrameStore({ dir, fps: 30 });
  await store.ready;
  await assert.rejects(store.put(0, { not: 'a buffer' }, sig()));
  await store.put(1, painted, sig());
  samePixels(await store.lookup(1, sig()), painted);
  await store.close();
}));

test('a movie reset while startNow replays PNGs leaves the stream restartable', () => withDir('pc-flush-', async dir => {
  const store = new MovFrameStore({ dir, fps: 30 });
  await store.ready;
  for (let n = 0; n < 3; n++) await store.put(n, painted, sig('old'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  const factory = () => ({
    write: async () => { writes.push(writes.length); if (writes.length === 2) await gate; },
    finish: async () => {},
    abort: async () => {},
  });
  const starting = store.start('fake', factory);
  while (writes.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  // Frame 0 is re-rendered by other capture code while the replay is blocked.
  const replacing = store.put(0, repainted, sig('new'));
  await new Promise(resolve => setTimeout(resolve, 5));
  release();
  await starting;
  await replacing;
  assert.equal(store.writerError, null, 'a superseded stream must not disable the movie');
  assert.equal(store.writer, null);
  assert.equal(store.nextFrame, 0);
  assert.deepEqual([...store.pending].sort(), [0, 1, 2]);
  await store.close();
}));

test('a frame kept on disk is streamed from disk, not from the discarded screenshot', () => withDir('pc-kept-', async dir => {
  const editor = new MovFrameStore({ dir, fps: 30 });
  await editor.ready;
  const worker = new MovFrameStore({ dir, fps: 30 });
  await worker.ready;
  await worker.put(0, painted, sig());
  await worker.close();
  const writes = [];
  await editor.start('fake', () => ({ write: async buf => { writes.push(buf); }, finish: async () => {}, abort: async () => {} }));
  // A flaky empty render of a frame another process already painted keeps the PNG,
  // so the movie must take the PNG too.
  await editor.put(0, empty, sig());
  assert.equal(writes.length, 1);
  samePixels(writes[0], painted);
  await editor.close();
}));

test('records cached in memory yield to what another process wrote since', () => withDir('pc-stale-', async dir => {
  const editor = new MovFrameStore({ dir, fps: 30 });
  const worker = new MovFrameStore({ dir, fps: 30 });
  await Promise.all([editor.ready, worker.ready]);
  await editor.put(11, painted, sig('c1'));
  samePixels(await editor.lookup(11, sig('c1')), painted);
  // Other capture code replaces it with an unconfirmed empty render: the editor
  // validates the bytes it reads, not the painted record it remembers.
  await worker.put(11, empty, sig('c2'));
  assert.equal(await editor.lookup(11, sig('c1')), undefined);

  // The worker saw frame 12 as a legacy PNG; the editor then records a painted
  // render. The worker's flaky empty render must not overwrite it.
  await fs.writeFile(path.join(dir, 'mov', 'frames', '000012.png'), painted);
  assert.equal(await worker.lookup(12, sig()), undefined);
  await editor.put(12, repainted, sig());
  await worker.put(12, empty, sig());
  samePixels(await editor.lookup(12, sig()), repainted);
  samePixels(await worker.lookup(12, sig()), repainted);
  await Promise.all([editor.close(), worker.close()]);
}));

test('the playback movie can put a published sample back to the transparent placeholder', () => withDir('pc-playback-evict-', async dir => {
  const movie = new PlaybackMovStore({ dir, width: 8, height: 8, fps: 30, count: 4 });
  await movie.ready;
  await movie.put(1, painted);
  assert.equal(movie.has(1), true);
  await movie.evict(1);
  assert.equal(movie.has(1), false);
  assert.deepEqual(movie.index(0, 3).frames, []);
  const bytes = await fs.readFile(movie.movieFile);
  assert.equal(bytes.readUInt32BE(movie.sizeTable + 4), movie.placeholder.size);
  assert.equal(Number(bytes.readBigUInt64BE(movie.offsetTable + 8)), movie.placeholder.offset);
  await movie.put(1, repainted);
  const sample = movie.index(1, 1).frames[0];
  assert.deepEqual((await fs.readFile(movie.movieFile)).subarray(sample.offset, sample.offset + sample.size), repainted);
  await movie.close();
}));

test('card samples from other capture code, or unconfirmed empty samples, are reported missing', () => withDir('pc-card-', async root => {
  let code = 'v1';
  const cache = new CardFrameCache({ root, project: { fps: 30, width: 8, height: 8 }, capture: () => code });
  const control = { key: 'card-key', clipId: 'clip', start: 0, end: 1, count: 30, cacheable: true, needPrerendering: true,
    sampling: { firstFrame: 0, phase: { numerator: 0, denominator: 1 } } };
  await cache.put('card-key', 0, empty);
  await cache.put('card-key', 1, painted);
  let state = await cache.renderState([control], [0, 1]);
  assert.deepEqual(state.missing[0], ['clip']);
  assert.ok(state.frames.clip[1]);
  assert.equal(await cache.hasComplete({ ...control, count: 2 }), false);
  code = 'v2';
  state = await cache.renderState([control], [1]);
  assert.deepEqual(state.missing[1], ['clip']);
  assert.equal(state.frames.clip, undefined);
  await cache.close();
}));

test('playback does not publish an unconfirmed empty render', async () => {
  const puts = [];
  const movie = { has: () => false, put: async frame => { puts.push(frame); }, index: () => ({ frames: [] }) };
  const playback = new FramePlayback({ entry: { key: 'k', project: { fps: 30, duration: 1 } }, movie,
    render: async (_times, { onFrame }) => { await onFrame(0, { buf: empty, source: 'live', unconfirmedClear: true }); },
    cached: async () => null, stop: async () => {}, clock: () => 0 });
  playback.frame = 0; playback.at = 0; playback.rate = 1;
  await playback.run({ controller: new AbortController(), frames: [0] }, playback.epoch);
  assert.deepEqual(puts, []);
  assert.equal(playback.incomplete.has(0), true);
  assert.equal(playback.status().preview, null);
});

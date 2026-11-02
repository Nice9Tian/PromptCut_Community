/**
 * Unit tests for J3 snapshot source interface. Run: node --test src/render/snapshotSource.test.mjs
 *
 * This layer is the sole outlet for "how pages fetch snapshots", so pin down three error-prone
 * items:
 * 1. The `key` in the local tier comes with a slash; URLs must be encoded **segment by segment**
 *    (encoding the whole string turns it into %2F, causing routing mismatches);
 * 2. `layer` has full semantics: replace the whole layer when applying to page tables, never merge
 *    with old intervals;
 * 3. LRU limit is 64 entries; evict the least recently used one.
 *
 * This file does not run `HttpSnapshotSource` SSE (browser API), testing only pure functions and
 * caches; the end-to-end half is in `scripts/probes/ready-index-probe.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReadyMessage, layerOf, snapshotPath, RECONNECT_BACKOFF_MS, SNAPSHOT_CACHE_MAX } from './snapshotSource.ts';

test('snapshotPath encodes per segment so the local key keeps its slash', () => {
  assert.equal(snapshotPath('html', 'abc123', 7), '/api/frames/snapshot/html/abc123/7');
  // Local tier: `<entry.key>/<shared-key>`, that slash is a path delimiter, not part of the key
  assert.equal(snapshotPath('local', 'ENTRY/SHARED', 0), '/api/frames/snapshot/local/ENTRY/SHARED/0');
  assert.notEqual(snapshotPath('local', 'ENTRY/SHARED', 0), '/api/frames/snapshot/local/ENTRY%2FSHARED/0');
  // Encode properly even when segments contain unusual characters
  assert.equal(snapshotPath('local', 'a b/c#d', 1), '/api/frames/snapshot/local/a%20b/c%23d/1');
});

test('applyReadyMessage: reset clears, layer replaces the whole table', () => {
  const index = new Map();
  applyReadyMessage(index, { type: 'layer', clipId: 'a', kind: 'html', key: 'K1', ranges: [[0, 3]] });
  applyReadyMessage(index, { type: 'layer', clipId: 'a', kind: 'stream', key: 'S1', ranges: [[0, 1]] });
  // Two tables coexist for the same card without overwriting each other
  assert.deepEqual(layerOf(index, 'a', 'html'), { clipId: 'a', kind: 'html', key: 'K1', ranges: [[0, 3]] });
  assert.deepEqual(layerOf(index, 'a', 'stream'), { clipId: 'a', kind: 'stream', key: 'S1', ranges: [[0, 1]] });
  // Full semantics: old intervals must not persist after changing keys
  applyReadyMessage(index, { type: 'layer', clipId: 'a', kind: 'html', key: 'K2', ranges: [[9, 9]] });
  assert.deepEqual(layerOf(index, 'a', 'html'), { clipId: 'a', kind: 'html', key: 'K2', ranges: [[9, 9]] });
  assert.equal(layerOf(index, 'b', 'html'), null);
  applyReadyMessage(index, { type: 'reset', localRev: 3 });
  assert.equal(index.size, 0);
  // Unrecognized messages do not modify the table
  applyReadyMessage(index, { type: 'done', localRev: 3 });
  assert.equal(index.size, 0);
});

test('fetchSnapshot caches by kind/key/frame, dedupes in-flight, and evicts LRU at 64', async () => {
  const { HttpSnapshotSource } = await import('./snapshotSource.ts');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, text: async () => `<i>${url}</i>` };
  };
  try {
    const source = new HttpSnapshotSource(async () => 'http://127.0.0.1:1234');
    const first = await source.fetchSnapshot('html', 'K', 0);
    assert.equal(first, '<i>http://127.0.0.1:1234/api/frames/snapshot/html/K/0</i>');
    await source.fetchSnapshot('html', 'K', 0);
    assert.equal(calls.length, 1, 'a cache hit does not fetch again');
    // Flies only once when the same frame is requested by two places simultaneously
    calls.length = 0;
    await Promise.all([source.fetchSnapshot('html', 'K', 1), source.fetchSnapshot('html', 'K', 1)]);
    assert.equal(calls.length, 1);
    // Upper limit of 64: once full, the oldest entry is evicted
    for (let n = 0; n < SNAPSHOT_CACHE_MAX + 4; n++) await source.fetchSnapshot('local', 'E/K', n);
    assert.equal(source.cacheSize, SNAPSHOT_CACHE_MAX);
    calls.length = 0;
    await source.fetchSnapshot('local', 'E/K', 0);
    assert.equal(calls.length, 1, 'the evicted entry must be fetched again');
    // Throws on missing frame rather than returning empty string: that layer treats it as missing input
    globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
    await assert.rejects(source.fetchSnapshot('html', 'MISSING', 0), /not ready yet/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('reconnect backoff is 1s / 2s / 4s / 8s and stays capped at 8s', () => {
  assert.deepEqual(RECONNECT_BACKOFF_MS, [1000, 2000, 4000, 8000]);
  const at = n => RECONNECT_BACKOFF_MS[Math.min(n, RECONNECT_BACKOFF_MS.length - 1)];
  assert.deepEqual([0, 1, 2, 3, 4, 20].map(at), [1000, 2000, 4000, 8000, 8000, 8000]);
});

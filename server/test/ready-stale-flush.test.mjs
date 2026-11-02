/**
 * Concern F: After the page switches to the next version, the batch accumulated by the
 * **old entry** only finishes submitting: if sent as is, right after the page cleared its table,
 * it receives layers with old keys again, and the new layer for the same clipId is replaced
 * entirely by the old layer (C3 has full semantics).
 * After Item 4, the `publishLayer` gate blocks this uniformly: only sessions whose current version
 * is precisely this entry are admitted.
 * Run: node --test server/test/ready-stale-flush.test.mjs
 *
 * Real: `ready-index.mjs` hub, `adoptSession` / `adoptCardPlan` / `recordCardPlan` /
 * `claimSessions` / `publishLayer` / `flushSnapshots` on `FramePipeline.prototype`.
 * Fake: snapshot store batches (`close()` directly returns an index), touching neither Chrome
 * nor disk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePipeline } from '../frame-pipeline.mjs';
import { createReadyHub } from '../ready-index.mjs';

const control = (clipId, snapshotKey) => ({ clipId, snapshotKey, tier: 'shared', capabilities: { frameMode: 'stateful', compositing: 'independent' } });
const fakeBatch = (clipId, key) => ({ clipId, key, tier: 'shared', entryKey: undefined, written: true, close: async () => ({ frames: [[0, 9]] }) });

function pipeline() {
  const p = Object.create(FramePipeline.prototype);
  p.ready = createReadyHub();
  p.root = undefined;
  return p;
}

test('after the project switches to a new version, the batch accumulated by the old entry is no longer published to the ready index', async () => {
  const p = pipeline();
  const seen = [];
  p.ready.subscribe('s', (m) => seen.push(m));

  // First version: shared key KA for card h; background is accumulating a batch
  const entryA = { key: 'E1', project: { fps: 30 } };
  p.adoptSession('s', entryA, 1);
  p.adoptCardPlan(entryA, [control('h', 'KA')]);
  entryA.snapshotPending = new Map([['a', fakeBatch('h', 'KA')]]);

  // User changed card parameters: version 2, h's shared key became KB; page clears table and receives new layer
  const entryB = { key: 'E2', project: { fps: 30 } };
  p.adoptSession('s', entryB, 2);
  p.adoptCardPlan(entryB, [control('h', 'KB')]);
  p.publishLayer(entryB, control('h', 'KB'), 'shared', [[0, 4]]);
  seen.length = 0;

  // That batch from the old entry only finishes submitting now
  await p.flushSnapshots(entryA);
  const stale = seen.filter((m) => m.type === 'layer' && m.key === 'KA');
  assert.deepEqual(stale, [], `layers of the old version must not be sent out again after reset: ${JSON.stringify(seen)}`);
  assert.equal(p.ready.peek('s').index.list().find((l) => l.clipId === 'h')?.key, 'KB', 'in the ready index, h still has the new version\'s key');
});

test('the current version\'s own batch is published as usual', async () => {
  const p = pipeline();
  const entry = { key: 'E1', project: { fps: 30 } };
  p.adoptSession('s', entry, 1);
  p.adoptCardPlan(entry, [control('h', 'KA')]);
  entry.snapshotPending = new Map([['a', fakeBatch('h', 'KA')]]);
  await p.flushSnapshots(entry);
  assert.deepEqual(p.ready.peek('s').index.list().find((l) => l.clipId === 'h')?.ranges, [[0, 9]]);
});

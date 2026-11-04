/**
 * Unit test for C3 ready index. Run: node --test server/test/ready-index.test.mjs
 *
 * Message shape is the only external contract at this layer (the page builds `readyIndex`
 * from it), so fields of all three message types are nailed down verbatim; "always send full
 * updates, never deltas" is also preserved here: if sent as deltas, losing a message means that
 * table on the page is permanently missing a segment, and SSE has no retransmission mechanism.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadyIndex, kindOfTier, READY_KINDS, wireSnapshotKey } from '../ready-index.mjs';

const collect = index => { const seen = []; const off = index.subscribe(m => seen.push(m)); return { seen, off }; };

test('tier names map onto the wire kinds (three-way synonym)', () => {
  assert.equal(kindOfTier('shared'), 'html');
  assert.equal(kindOfTier('local'), 'local');
  assert.equal(kindOfTier('none'), null);
  assert.equal(kindOfTier(undefined), null);
  // 'stream' is for R8, just reserving a slot in the type is sufficient
  assert.deepEqual(READY_KINDS, ['html', 'local', 'stream']);
  // Key on the wire: shared tier is the shared key; local tier comes with a slash (`<entry.key>/<shared key>`)
  assert.equal(wireSnapshotKey('shared', 'ENTRY', 'KEY'), 'KEY');
  assert.equal(wireSnapshotKey('local', 'ENTRY', 'KEY'), 'ENTRY/KEY');
  assert.equal(wireSnapshotKey('local', undefined, 'KEY'), null);
  assert.equal(wireSnapshotKey('none', 'ENTRY', 'KEY'), null);
});

test('a new subscriber gets reset first, then one full layer message per layer', () => {
  const index = createReadyIndex();
  index.localRev = 7;
  index.addFrames({ clipId: 'a', kind: 'html', key: 'KA', frames: [[0, 3]] });
  index.addFrames({ clipId: 'b', kind: 'local', key: 'KB', frames: [0] });
  const { seen } = collect(index);
  assert.equal(seen[0].type, 'reset');
  assert.equal(seen[0].localRev, 7);
  assert.deepEqual(seen.slice(1).map(m => m.type), ['layer', 'layer'], 'reset first, then layer');
  assert.deepEqual(seen[1], { type: 'layer', clipId: 'a', kind: 'html', key: 'KA', ranges: [[0, 3]] });
  assert.deepEqual(seen[2], { type: 'layer', clipId: 'b', kind: 'local', key: 'KB', ranges: [[0, 0]] });
});

test('layer messages are always the full range table, and ranges grow as frames land', () => {
  const index = createReadyIndex();
  const { seen } = collect(index);
  index.addFrames({ clipId: 'a', kind: 'html', key: 'KA', frames: [0, 1, 2, 3] });
  index.addFrames({ clipId: 'a', kind: 'html', key: 'KA', frames: [4, 5, 6, 7] });
  // The second message is not "added 4~7", but "now has 0~7":
  // losing the first one will not leave a segment permanently missing
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'a', kind: 'html', key: 'KA', ranges: [[0, 7]] });
  index.addFrames({ clipId: 'a', kind: 'html', key: 'KA', frames: [[12, 13]] });
  assert.deepEqual(seen.at(-1).ranges, [[0, 7], [12, 13]], 'real gaps are kept');
  // The stream table and html table for the same card coexist without overwriting each other
  index.addFrames({ clipId: 'a', kind: 'stream', key: 'SA', frames: [[0, 2]] });
  assert.deepEqual(index.list().map(l => `${l.clipId}/${l.kind}`).sort(), ['a/html', 'a/stream']);
  // If the key changes (card parameters changed), record from scratch;
  // do not append intervals from the old key
  index.addFrames({ clipId: 'a', kind: 'html', key: 'KA2', frames: [[0, 1]] });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'a', kind: 'html', key: 'KA2', ranges: [[0, 1]] });
});

test('reset clears the table and tells the page to clear its own; done is sent once', () => {
  const index = createReadyIndex();
  index.addFrames({ clipId: 'a', kind: 'html', key: 'KA', frames: [[0, 3]] });
  const { seen } = collect(index);
  seen.length = 0;
  index.reset(9);
  assert.deepEqual(seen, [{ type: 'reset', localRev: 9 }]);
  assert.deepEqual(index.list(), []);
  index.markDone();
  index.markDone();
  assert.deepEqual(seen.at(-1), { type: 'done', localRev: 9 });
  assert.equal(seen.filter(m => m.type === 'done').length, 1);
  // After reset, done is rearmed
  index.reset(10);
  index.markDone();
  assert.deepEqual(seen.at(-1), { type: 'done', localRev: 10 });
});

test('F5: disk scan stages key → ranges, and nothing is published until the card plan lands', () => {
  const index = createReadyIndex();
  const { seen } = collect(index);
  seen.length = 0;
  // Disk scan only yields "key -> interval": directory name is the shared key stripped of clipId
  index.stageByKey({ kind: 'html', key: 'SHARED-KEY', ranges: [[0, 40]] });
  index.stageByKey({ kind: 'local', key: 'ENTRY/BLUR-KEY', ranges: [[0, 4], [9, 9]] });
  assert.deepEqual(seen, [], 'no layer is sent before the project arrives');
  assert.deepEqual(index.list(), []);
  // Project in place -> recalculate card plan -> reverse lookup using control.clipId ↔ control.snapshotKey
  const claimed = index.claim([
    { clipId: 'clip-1', kind: 'html', key: 'SHARED-KEY' },
    { clipId: 'clip-2', kind: 'local', key: wireSnapshotKey('local', 'ENTRY', 'BLUR-KEY') },
    { clipId: 'clip-3', kind: 'html', key: 'NOT-ON-DISK' },
    { clipId: 'clip-4', kind: null, key: 'SHARED-KEY' },
  ], 12);
  assert.equal(claimed, 2, 'keys not on disk and tiers that produce no snapshots are not claimed');
  // First send a reset, then send a full layer for each layer
  // (C3 already has full-state semantics, without adding new endpoints)
  assert.deepEqual(seen[0], { type: 'reset', localRev: 12 });
  assert.deepEqual(seen.slice(1), [
    { type: 'layer', clipId: 'clip-1', kind: 'html', key: 'SHARED-KEY', ranges: [[0, 40]] },
    { type: 'layer', clipId: 'clip-2', kind: 'local', key: 'ENTRY/BLUR-KEY', ranges: [[0, 4], [9, 9]] },
  ]);
  // Later newly connected pages directly receive the rebuilt copy
  const later = collect(index);
  assert.deepEqual(later.seen.map(m => m.type), ['reset', 'layer', 'layer']);
});

test('setLayer publishes a whole table (the group-stream shape carries groupClipIds)', () => {
  const index = createReadyIndex();
  const { seen } = collect(index);
  index.setLayer({ clipId: 'a', kind: 'stream', key: 'S1', ranges: [3, [0, 1]], groupClipIds: ['a', 'b'] });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'a', kind: 'stream', key: 'S1', ranges: [[0, 1], [3, 3]], groupClipIds: ['a', 'b'] });
  assert.equal(index.addFrames({ clipId: '', kind: 'html', key: 'K', frames: [0] }), null);
  assert.equal(index.addFrames({ clipId: 'a', kind: 'nope', key: 'K', frames: [0] }), null);
  assert.equal(index.addFrames({ clipId: 'a', kind: 'html', key: '', frames: [0] }), null);
});

test('unsubscribing stops delivery and a throwing subscriber cannot block the others', () => {
  const index = createReadyIndex();
  const good = [];
  index.subscribe(() => { throw new Error('this subscriber is broken'); });
  const off = index.subscribe(m => good.push(m));
  index.addFrames({ clipId: 'a', kind: 'html', key: 'K', frames: [0] });
  assert.equal(good.at(-1).type, 'layer');
  off();
  index.addFrames({ clipId: 'a', kind: 'html', key: 'K', frames: [1] });
  assert.equal(good.at(-1).ranges.length, 1);
  assert.deepEqual(good.at(-1).ranges, [[0, 0]], 'nothing is received after unsubscribing');
});

test('the layer of a stream that depends on the layer below is sent out carrying streamKind and inputSig; other layers and other tiers do not carry them; when a claim carries none, the original layer with the same key keeps its own', () => {
  const index = createReadyIndex();
  const { seen } = collect(index);
  // Publish layer: all four ports are passed through as-is
  index.setLayer({ clipId: 'g', kind: 'stream', key: 'B1', ranges: [[0, 2]], originFrame: 55, streamKind: 'below', inputSig: 's1-abc' });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'g', kind: 'stream', key: 'B1', ranges: [[0, 2]], originFrame: 55, streamKind: 'below', inputSig: 's1-abc' });
  index.addFrames({ clipId: 'g', kind: 'stream', key: 'B1', frames: [3], originFrame: 55, streamKind: 'below', inputSig: 's1-abc' });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'g', kind: 'stream', key: 'B1', ranges: [[0, 3]], originFrame: 55, streamKind: 'below', inputSig: 's1-abc' });
  // Those without signatures only carry kind; unknown kinds and tiers that are not streams are excluded
  index.setLayer({ clipId: 'h', kind: 'stream', key: 'B2', ranges: [[0, 0]], originFrame: 0, streamKind: 'below' });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'h', kind: 'stream', key: 'B2', ranges: [[0, 0]], originFrame: 0, streamKind: 'below' });
  index.setLayer({ clipId: 'c', kind: 'stream', key: 'C1', ranges: [[0, 0]], originFrame: 0, streamKind: 'card', inputSig: 's1-zzz' });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'c', kind: 'stream', key: 'C1', ranges: [[0, 0]], originFrame: 0 });
  index.setLayer({ clipId: 'g', kind: 'html', key: 'H1', ranges: [[0, 0]], streamKind: 'below', inputSig: 's1-abc' });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'g', kind: 'html', key: 'H1', ranges: [[0, 0]] });

  // Claim (the non-reset kind): use the claim table's if provided; if not provided and key has not
  // changed, keep the original; if signature changed, treat as changed and resend
  index.stageByKey({ kind: 'stream', key: 'B1', ranges: [[0, 5]] });
  const before = seen.length;
  assert.equal(index.absorb([{ clipId: 'g', kind: 'stream', key: 'B1', originFrame: 55 }]), 1);
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'g', kind: 'stream', key: 'B1', ranges: [[0, 5]], originFrame: 55, streamKind: 'below', inputSig: 's1-abc' });
  assert.equal(index.absorb([{ clipId: 'g', kind: 'stream', key: 'B1', originFrame: 55, streamKind: 'below', inputSig: 's1-abc' }]), 0, 'nothing changed: not resent');
  assert.equal(index.absorb([{ clipId: 'g', kind: 'stream', key: 'B1', originFrame: 55, streamKind: 'below', inputSig: 's1-new' }]), 1);
  assert.equal(seen.at(-1).inputSig, 's1-new');
  assert.equal(seen.length, before + 2);

  // Claim (the kind that resets first)
  const fresh = createReadyIndex();
  fresh.stageByKey({ kind: 'stream', key: 'B1', ranges: [[0, 1]] });
  const got = collect(fresh);
  assert.equal(fresh.claim([{ clipId: 'g', kind: 'stream', key: 'B1', originFrame: 55, streamKind: 'below', inputSig: 's1-abc' }]), 1);
  assert.deepEqual(got.seen.at(-1), { type: 'layer', clipId: 'g', kind: 'stream', key: 'B1', ranges: [[0, 1]], originFrame: 55, streamKind: 'below', inputSig: 's1-abc' });
});

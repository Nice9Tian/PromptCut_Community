/**
 * On-screen track stream budget (`src/render/streamBudget.mjs`): pixel counting metric, whether client
 * page and server use the same formula, and how group streams merge under the new budget.
 * Run: npm test -- server/test/stream-budget.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STREAM_PIXEL_RATE_BUDGET, STREAM_COUNT_BUDGET, STREAM_FREE_COUNT, STREAM_BUDGET_MIN_FPS, STREAM_DEFAULT_PIXELS, STREAM_BUDGET_HALF_PAD, STREAM_BUDGET_OVERFLOW_PX,
  streamCodedPixels, stageStreamPixels, localStreamBoundSize, localStreamPixels, streamCost, streamBudgetOf, withinStreamBudget,
  peakConcurrency, peakCost, groupStreams,
} from '../../src/render/streamBudget.mjs';
import * as server from '../frame-stream.mjs';
import { planStreams, localPlacement, LOCAL_OVERFLOW_PX, STREAM_DECODER_BUDGET } from '../frame-stream.mjs';
import { STREAM_HALF_PAD, packedSize } from '../../src/render/streamEncode.ts';
import { planesWithinBudget, DECODER_BUDGET } from '../../src/render/streamPlayer.ts';
import { localPlacement as pageLocalPlacement, PAGE_STREAM_DECODER_BUDGET, PAGE_LOCAL_OVERFLOW_PX } from '../../src/online/pageStreamPlan.ts';

const FULL = 1920 * 2176;        // Encoding aspect ratio of a 1920×1080 full-screen card
const SMALL = 704 * 864;         // Small 640×360 card (32-pixel overflow on all four sides)

test('Budget numbers: the pixel budget is "6 full-screen cards at 60 fps", the stream count cap is 32; the stream count cap exported in three places is the same number', () => {
  assert.equal(STREAM_PIXEL_RATE_BUDGET, 6 * FULL * 60);
  assert.equal(STREAM_PIXEL_RATE_BUDGET, 1_504_051_200);
  assert.equal(STREAM_COUNT_BUDGET, 32);
  assert.equal(STREAM_FREE_COUNT, 6, 'the original count budget: up to 6 streams ignore pixels');
  assert.equal(STREAM_DECODER_BUDGET, STREAM_COUNT_BUDGET);
  assert.equal(DECODER_BUDGET, STREAM_COUNT_BUDGET);
  assert.equal(PAGE_STREAM_DECODER_BUDGET, STREAM_COUNT_BUDGET);
  assert.equal(STREAM_DEFAULT_PIXELS, FULL);
  // Gatekeeper for identical values: black bar row count, single-card stream expansion pixels
  assert.equal(STREAM_BUDGET_HALF_PAD, STREAM_HALF_PAD);
  assert.equal(STREAM_BUDGET_OVERFLOW_PX, LOCAL_OVERFLOW_PX);
  assert.equal(STREAM_BUDGET_OVERFLOW_PX, PAGE_LOCAL_OVERFLOW_PX);
  // Only one merge function: the server exports the shared one
  assert.equal(server.groupStreams, groupStreams);
  assert.equal(server.peakConcurrency, peakConcurrency);
});

test('Encoded frame size: width × (2 × height + 16), matching packedSize on the encoding side; the rectangle upper bounds for the whole-frame stream and the single-card stream', () => {
  assert.equal(streamCodedPixels(1920, 1080), FULL);
  assert.equal(streamCodedPixels(704, 424), SMALL);
  for (const [w, h] of [[1920, 1080], [704, 424], [612, 450], [2, 2]]) {
    const p = packedSize(w, h);
    assert.equal(streamCodedPixels(w, h), p.width * p.height, `${w}×${h}`);
  }
  assert.equal(streamCodedPixels(0, 100), 0);
  assert.equal(stageStreamPixels({ width: 1920, height: 1080 }), FULL);
  assert.equal(stageStreamPixels({ width: 1281, height: 721 }), 1282 * (2 * 722 + 16), 'width and height are rounded outward to even numbers');
  assert.equal(localStreamPixels({ w: 640, h: 360 }, { width: 1920, height: 1080 }), SMALL);
  assert.equal(localStreamPixels(undefined, { width: 1920, height: 1080 }), FULL, 'no frame = fills the stage');
});

test('Width and height of the single-card stream rectangle\'s upper bound: identical, size by size, to the server\'s and the online page\'s localPlacement', () => {
  const stages = [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 1080, height: 1920 }, { width: 640, height: 360 }];
  const frames = [undefined, {}, { w: 640, h: 360 }, { w: 641, h: 361 }, { w: 1, h: 1 }, { w: 1900, h: 1070 }, { w: 1920, h: 1080 }, { w: 2400, h: 1300 },
    { w: 333.3, h: 77.7 }, { w: 1857, h: 1017 }, { w: 1859, h: 1019 }, { w: 100 }, { h: 100 }, { w: 1919, h: 3 }];
  for (const stage of stages) for (const frame of frames) {
    const want = localPlacement({ frame }, stage).bound;
    const page = pageLocalPlacement({ frame }, stage).bound;
    const got = localStreamBoundSize(frame, stage);
    assert.deepEqual(got, { w: want.w, h: want.h }, `server ${JSON.stringify(frame)} @ ${stage.width}×${stage.height}`);
    assert.deepEqual(got, { w: page.w, h: page.h }, `online page ${JSON.stringify(frame)} @ ${stage.width}×${stage.height}`);
  }
});

test('Cost of one stream: encoded frame size × frame rate; a frame rate below 30 counts as 30; an unknown frame size is treated as a full-screen card', () => {
  assert.equal(streamCost(FULL, 60), FULL * 60);
  assert.equal(streamCost(FULL, 30), FULL * 30);
  assert.equal(streamCost(FULL, 24), FULL * STREAM_BUDGET_MIN_FPS);
  assert.equal(streamCost(undefined, 30), FULL * 30);
  assert.equal(streamCost(0, 30), FULL * 30);
  assert.equal(streamCost(SMALL, 0), SMALL * 30);
});

test('How many fit: full-screen cards fit 6 streams at 60 fps and 12 at 30 fps; small cards hit the stream count cap first; ones that do not fit are skipped, and later small ones are still placed', () => {
  const fits = (px, fps, n = 100) => withinStreamBudget(Array.from({ length: n }, () => streamCost(px, fps))).length;
  assert.equal(fits(FULL, 60), 6);
  assert.equal(fits(FULL, 30), 12);
  assert.equal(fits(FULL, 24), 12);
  assert.equal(fits(SMALL, 30), STREAM_COUNT_BUDGET);
  assert.equal(fits(SMALL, 60), STREAM_COUNT_BUDGET);
  assert.equal(Math.floor(STREAM_PIXEL_RATE_BUDGET / streamCost(SMALL, 60)), 41, 'by pixels alone, 41 small cards fit at 60 fps');
  // After 5 full-screen cards (60 frames): one more full-screen fits, 7th does not, subsequent small
  // cards also do not fit (pixels exhausted)
  const full = streamCost(FULL, 60), small = streamCost(SMALL, 60);
  assert.deepEqual(withinStreamBudget([full, full, full, full, full, full, full, small]), [0, 1, 2, 3, 4, 5]);
  // When margin remains: large cards that do not fit are skipped, subsequent small cards still placed
  assert.deepEqual(withinStreamBudget([full, full, full, full, full, small, full, small]), [0, 1, 2, 3, 4, 5, 7]);
  assert.deepEqual(withinStreamBudget([small, small, small], 2), [0, 1], 'passing a single number = changes only the stream count cap');
  assert.deepEqual(withinStreamBudget([10, 10, 10], { pixelRate: 25, free: 0 }), [0, 1]);
  assert.deepEqual(withinStreamBudget([10, 10, 10], { pixelRate: 25 }), [0, 1, 2], 'up to 6 streams ignore pixels');
  assert.deepEqual(withinStreamBudget([10, 10, 10, 10], { pixelRate: 25, free: 2 }), [0, 1], 'the first two streams ignore pixels, from the third on pixels count');
  assert.deepEqual(streamBudgetOf(), { count: 32, pixelRate: STREAM_PIXEL_RATE_BUDGET, free: 6 });
  assert.deepEqual(streamBudgetOf(1), { count: 1, pixelRate: STREAM_PIXEL_RATE_BUDGET, free: 1 }, 'the number of streams exempt from the pixel check never exceeds the stream count cap');
  assert.deepEqual(streamBudgetOf({ count: 0, pixelRate: -1 }), { count: 32, pixelRate: STREAM_PIXEL_RATE_BUDGET, free: 6 }, 'nonsensical values are not accepted');
});

test('The page\'s planesWithinBudget uses the same basis: the encoded frame size handed over by the parent page times the frame rate', () => {
  const planes = Array.from({ length: 40 }, (_, i) => ({ clipIds: [`c${i}`], key: `K${i}`, ranges: [[0, 9]], originFrame: 0 }));
  assert.equal(planesWithinBudget(planes, 60, () => FULL).length, 6);
  assert.equal(planesWithinBudget(planes, 30, () => FULL).length, 12);
  assert.equal(planesWithinBudget(planes, 30, () => SMALL).length, 32);
  assert.equal(planesWithinBudget(planes, 30).length, 12, 'no frame size given: treated as a full-screen card');
  // Track 3 is full-screen, the rest are small cards (60 frames): after 5 full-screen cards, the 6th
  // is still placed, beyond that neither full-screen nor small cards fit
  const mixed = planesWithinBudget(planes.slice(0, 9), 60, (p) => (p.clipIds[0] === 'c8' ? SMALL : FULL));
  assert.deepEqual(mixed.map((p) => p.clipIds[0]), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  // Those marked over are excluded and do not count toward the budget
  const marked = planes.slice(0, 13).map((p, i) => (i < 2 ? { ...p, over: true } : p));
  assert.deepEqual(planesWithinBudget(marked, 60, () => FULL).map((p) => p.clipIds[0]), ['c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
});

test('peakCost: the peak of the summed cost on the same frame; entries without a cost do not count', () => {
  assert.deepEqual(peakCost([{ from: 0, to: 9, cost: 5 }, { from: 5, to: 20, cost: 7 }, { from: 21, to: 30, cost: 9 }]), { peak: 12, at: 5, count: 2 });
  // Only inspect frames with >1 stream on screen: the stream at frames 21-30 is costliest (9), but only
  // 1 stream there, skipped
  assert.deepEqual(peakCost([{ from: 0, to: 9, cost: 5 }, { from: 5, to: 20, cost: 7 }, { from: 21, to: 30, cost: 20 }], null, 1), { peak: 12, at: 5, count: 2 });
  assert.deepEqual(peakCost([{ from: 0, to: 9, cost: 5 }, { from: 5, to: 20, cost: 7 }], null, 2), { peak: 0, at: 0, count: 0 });
  assert.deepEqual(peakCost([{ from: 0, to: 9, cost: 5 }, { from: 5, to: 20, cost: 7 }], new Set([5])), { peak: 7, at: 10, count: 1 }, 'skip frame 5: of the remaining frames the most expensive is frame 10 (only the second entry is left)');
  assert.deepEqual(peakCost([{ from: 0, to: 9 }]), { peak: 0, at: 0, count: 0 });
});

test('groupStreams counts pixels (this test sets the pixel-exempt count to 0, covering only the pixel half): merges only when the pixel budget is exceeded, and only merges a pair for which merging "lowers the cost of this frame"; with no cost supplied it behaves exactly as before', () => {
  const layers = ['a', 'b', 'c', 'd'].map((id, i) => ({ clipId: id, order: i + 1, from: 0, to: 99 }));
  const of = (costs) => ['a', 'b', 'c', 'd'].map((id, i) => ({ clipIds: [id], order: i + 1, from: 0, to: 99, cost: costs[i] }));
  const ids = (list) => list.map((s) => s.clipIds);
  // Four streams at 10 each, pixel budget 25, group stream overhead 10: merge once (a+b) is 30, still
  // over; merge again is 20, fits
  assert.deepEqual(ids(groupStreams(of([10, 10, 10, 10]), layers, { pixelRate: 25, free: 0 }, [], 10)), [['a', 'b', 'c'], ['d']]);
  // Not over budget: do not merge
  assert.deepEqual(ids(groupStreams(of([10, 10, 10, 10]), layers, { pixelRate: 40, free: 0 }, [], 10)), [['a'], ['b'], ['c'], ['d']]);
  // Small cards: two together cost less than a group stream, merging is costlier: do not merge (even
  // if over, excess layers show placeholders on the page)
  assert.deepEqual(ids(groupStreams(of([4, 4, 4, 4]), layers, { pixelRate: 12, free: 0 }, [], 10)), [['a'], ['b'], ['c'], ['d']]);
  // Mixed sizes: a and b small, c and d large. Only merging c+d decreases the total
  assert.deepEqual(ids(groupStreams(of([4, 4, 10, 10]), layers, { pixelRate: 20, free: 0 }, [], 10)), [['a'], ['b'], ['c', 'd']]);
  // Stream count exceeded: merge starting from foremost pair in painter's order as before, ignoring
  // pixels
  assert.deepEqual(ids(groupStreams(of([4, 4, 4, 4]), layers, { count: 3, pixelRate: 1000 }, [], 10)), [['a', 'b'], ['c'], ['d']]);
  // Streams not participating in merge also consume pixels
  const fixed = [{ from: 0, to: 99, cost: 10 }];
  assert.deepEqual(ids(groupStreams(of([10, 10, 0, 0]).slice(0, 2), layers.slice(0, 2), { pixelRate: 25, free: 0 }, fixed, 10)), [['a', 'b']]);
  // Stream count threshold ignoring pixels: no merge if count on screen does not exceed it, regardless
  // of pixel overrun; merge a pair to bring it back when over by 1, even if no pixels saved
  assert.deepEqual(ids(groupStreams(of([10, 10, 10, 10]), layers, { pixelRate: 1, free: 4 }, [], 10)), [['a'], ['b'], ['c'], ['d']]);
  assert.deepEqual(ids(groupStreams(of([4, 4, 4, 4]), layers, { pixelRate: 1, free: 3 }, [], 10)), [['a', 'b'], ['c'], ['d']]);
  // No overhead specified: only check stream count
  const plain = ['a', 'b', 'c'].map((id, i) => ({ clipIds: [id], order: i + 1, from: 0, to: 99 }));
  assert.equal(groupStreams(plain, layers, 6).length, 3);
  assert.deepEqual(ids(groupStreams(plain, layers, 2)), [['a', 'b'], ['c']]);
});

/* ------------------------------------------------------------------ planStreams results under new budget */

const ENV_FP = '0123456789abcdef';
const control = (clipId, start, end, fps) => ({
  clipId, key: `K-${clipId}`, snapshotKey: `S-${clipId}`, capabilities: { compositing: 'independent', frameMode: 'stateful' }, compositing: 'independent',
  start, end, count: Math.ceil((end - start) * fps), sampling: { firstFrame: Math.ceil(start * fps), fps: { numerator: String(fps), denominator: '1' }, phase: { numerator: '0', denominator: '1' } },
});
/** n stacked standalone cards, one track each; full-screen if `frame` omitted */
function stacked(n, { fps = 30, frame = undefined } = {}) {
  const tracks = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, clips: [{ id: `c${i}`, cardId: 'x', start: 0, end: 4, ...(frame ? { frame } : {}) }] }));
  const project = { width: 1920, height: 1080, fps, duration: 4, media: [], tracks };
  return { key: 'E', project, cardPlan: Array.from({ length: n }, (_, i) => control(`c${i}`, 0, 4, fps)) };
}
const kinds = (specs) => specs.map((s) => `${s.kind}:${s.clipIds.length}`).sort();

test('planStreams: full-screen cards at 30 fps, up to 12 on screen each get one single-card stream (previously more than 6 were merged); with 13, two are merged', () => {
  for (const n of [1, 6, 7, 12]) {
    const specs = planStreams(stacked(n), { envFingerprint: ENV_FP });
    assert.deepEqual(kinds(specs), Array.from({ length: n }, () => 'card:1'), `${n} cards`);
  }
  // 13 cards: 13 × full-screen > budget; after merging a pair into a group stream (also full frame),
  // it is 12 streams, fits just right
  const specs = planStreams(stacked(13), { envFingerprint: ENV_FP });
  assert.deepEqual(kinds(specs), [...Array.from({ length: 11 }, () => 'card:1'), 'group:2']);
});

test('planStreams: full-screen cards at 60 fps, 6 cards get one stream each; 8 cards are merged into 6 streams (same result as the original count budget)', () => {
  assert.deepEqual(kinds(planStreams(stacked(6, { fps: 60 }), { envFingerprint: ENV_FP })), Array.from({ length: 6 }, () => 'card:1'));
  const specs = planStreams(stacked(8, { fps: 60 }), { envFingerprint: ENV_FP });
  assert.deepEqual(kinds(specs), ['card:1', 'card:1', 'card:1', 'card:1', 'card:1', 'group:3']);
  // Previous "6 on screen" results: setting budget to 6 (changing only stream count limit) yields the
  // same merge pattern
  const old = planStreams(stacked(8, { fps: 60 }), { envFingerprint: ENV_FP, budget: 6 });
  assert.deepEqual(specs.map((s) => s.streamKey).sort(), old.map((s) => s.streamKey).sort());
});

test('planStreams: small cards (640×360), 30 on screen get one single-card stream each; 33 exceed the stream count cap and only then are merged', () => {
  const frame = { x: 0, y: 0, w: 640, h: 360 };
  for (const fps of [30, 60]) {
    const specs = planStreams(stacked(30, { fps, frame }), { envFingerprint: ENV_FP });
    assert.deepEqual(kinds(specs), Array.from({ length: 30 }, () => 'card:1'), `${fps} fps`);
  }
  const specs = planStreams(stacked(33, { frame }), { envFingerprint: ENV_FP });
  assert.equal(specs.length, 32);
  assert.deepEqual(kinds(specs).filter((k) => k !== 'card:1'), ['group:2']);
});

test('planStreams: after the budget changes the single-card stream keys stay the same (the key does not contain the budget); cards that used to be merged into group streams now each produce a single-card stream', () => {
  const entry = stacked(8);
  const now = planStreams(entry, { envFingerprint: ENV_FP });
  const before = planStreams(entry, { envFingerprint: ENV_FP, budget: 6 });     // Previous: 6 on screen
  assert.deepEqual(kinds(now), Array.from({ length: 8 }, () => 'card:1'));
  assert.deepEqual(kinds(before), ['card:1', 'card:1', 'card:1', 'card:1', 'card:1', 'group:3']);
  const keyOf = (specs) => new Map(specs.filter((s) => s.kind === 'card').map((s) => [s.clipIds[0], s.streamKey]));
  const a = keyOf(now), b = keyOf(before);
  for (const [clipId, key] of b) assert.equal(a.get(clipId), key, `${clipId}: was already a single-card stream, key unchanged`);
  assert.equal([...a.keys()].filter((id) => !b.has(id)).length, 3, 'the three cards that used to be merged into group streams now each have a single-card stream (newly produced)');
});

/* ------------------------------------------------------------------ What passed previously still passes now (pixels ignored within 6 on screen) */

function stackedOn(n, { width, height, fps }) {
  const entry = stacked(n, { fps });
  return { ...entry, project: { ...entry.project, width, height } };
}

test('Projects larger than 1080p or above 60 fps: up to 6 streams on screen are not merged, same as before (2 cards at 4K 60 fps, 4 cards at 4K 30 fps, 4 cards at 2560×1440 60 fps, 4 cards at 1080p 120 fps)', () => {
  const cases = [
    ['2 cards at 4K 60 fps', 2, { width: 3840, height: 2160, fps: 60 }],
    ['4 cards at 4K 30 fps', 4, { width: 3840, height: 2160, fps: 30 }],
    ['4 cards at 2560×1440 60 fps', 4, { width: 2560, height: 1440, fps: 60 }],
    ['4 cards at 1080p 120 fps', 4, { width: 1920, height: 1080, fps: 120 }],
    ['6 cards at 4K 60 fps', 6, { width: 3840, height: 2160, fps: 60 }],
  ];
  for (const [label, n, size] of cases) {
    const entry = stackedOn(n, size);
    const specs = planStreams(entry, { envFingerprint: ENV_FP });
    assert.deepEqual(kinds(specs), Array.from({ length: n }, () => 'card:1'), `${label}: one single-card stream each, not merged`);
    // Item-by-item identical to previous "6 on screen" results
    const before = planStreams(entry, { envFingerprint: ENV_FP, budget: { count: 6, free: 6 } });
    assert.deepEqual(specs.map((s) => s.streamKey).sort(), before.map((s) => s.streamKey).sort(), label);
    // Page side: all these streams pass through, none exceeding budget (hence no placeholders)
    const px = stageStreamPixels(size);
    assert.ok(px * size.fps * n > STREAM_PIXEL_RATE_BUDGET, `${label}: over the budget by pixels alone`);
    const planes = specs.map((s) => ({ clipIds: s.clipIds, key: s.streamKey, ranges: [[0, 9]], originFrame: 0 }));
    assert.equal(planesWithinBudget(planes, size.fps, () => px).length, n, `${label}: the page lets all through`);
  }
});

test('Two below-dependent streams at 4K 60 fps (cannot be merged): the page lets both through and produces no placeholder; pixels are only checked from the 7th stream on', () => {
  const px = stageStreamPixels({ width: 3840, height: 2160 });
  const planes = Array.from({ length: 8 }, (_, i) => ({ clipIds: [`g${i}`], key: `B${i}`, ranges: [[0, 9]], originFrame: 0, plane: 'stage' }));
  assert.ok(streamCost(px, 60) * 2 > STREAM_PIXEL_RATE_BUDGET, 'two streams already exceed the pixel budget');
  assert.deepEqual(planesWithinBudget(planes.slice(0, 2), 60, () => px).map((p) => p.key), ['B0', 'B1']);
  assert.equal(planesWithinBudget(planes.slice(0, 6), 60, () => px).length, 6, 'up to 6 streams ignore pixels');
  assert.equal(planesWithinBudget(planes, 60, () => px).length, 6, 'pixels are checked from the 7th stream on: cannot be added');
  // Partitioning side: 2 non-mergeable streams (fixed) on screen, adjacent standalone cards are not
  // merged because of them
  const layers = [{ clipId: 'a', order: 1, from: 0, to: 99 }, { clipId: 'b', order: 2, from: 0, to: 99 }];
  const cost = streamCost(px, 60);
  const singles = layers.map((l) => ({ clipIds: [l.clipId], order: l.order, from: 0, to: 99, cost }));
  const fixed = [{ from: 0, to: 99, cost }, { from: 0, to: 99, cost }];
  assert.deepEqual(groupStreams(singles, layers, undefined, fixed, cost).map((s) => s.clipIds), [['a'], ['b']]);
});

test('7 full-screen cards at 1080p 60 fps: still merged as before (the 7th stream exceeds the pixel budget)', () => {
  const specs = planStreams(stacked(7, { fps: 60 }), { envFingerprint: ENV_FP });
  assert.deepEqual(kinds(specs), ['card:1', 'card:1', 'card:1', 'card:1', 'card:1', 'group:2']);
  const before = planStreams(stacked(7, { fps: 60 }), { envFingerprint: ENV_FP, budget: { count: 6, free: 6 } });
  assert.deepEqual(specs.map((s) => s.streamKey).sort(), before.map((s) => s.streamKey).sort(), 'same merging as before');
  // Seven 4K 60-frame cards: similarly merged into 6 streams (merging one brings it back within the
  // pixel-ignoring count)
  const big = planStreams(stackedOn(7, { width: 3840, height: 2160, fps: 60 }), { envFingerprint: ENV_FP });
  assert.deepEqual(kinds(big), ['card:1', 'card:1', 'card:1', 'card:1', 'card:1', 'group:2']);
});

/**
 * Contract alignment on delivery side after revoking snapshots (`snapshotFeed.ts`):
 *   - After each card's HTML snapshot is invalidated, deliverSnapshots clears settled during playback
 *     and returns 0, without dispatching snapshot patches to stage;
 *   - During playback, heavy cards are fully taken over by suppressed suppression, topDownOrder
 *     maintains layer order, setBeatSwap / beatSwapDebug retain compatibility signatures without
 *     null pointers.
 * Run: node --experimental-test-module-mocks --test src/editor/c10-beat-feed.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let plan = { segments: [] };
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => plan } });
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: () => {} } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const { deliverSnapshots, setSnapshotSource, syncSnapshotSubscription, resetSnapshotFeed, setBeatSwap, beatSwapDebug, topDownOrder, noteSettled, suppressedAt, SNAPSHOT_THROTTLE_MS } = feed;

let now = 1000;
performance.now = () => now;
const settle = () => new Promise((r) => setImmediate(r));
const FPS = 30;
const card = (id, start, end) => ({ id, cardId: "c", start, end, params: {} });
// First track is on top; within the same track, subsequent clips cover earlier ones
const project = (tracks) => ({ version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks });

let src;
function fakeSource() {
  const s = { push: null, subscribeReady(_a, _b, on) { s.push = on; return () => {}; }, async fetchSnapshot(kind, key, f) { return `html:${kind}/${key}/${f}`; } };
  return s;
}
function fakeStage() {
  const st = { calls: [] };
  st.setSnapshots = async (patch, opts) => { st.calls.push({ patch, opts }); };
  return st;
}
beforeEach(() => {
  resetSnapshotFeed();
  src = fakeSource();
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  now += 10_000;
});

test("C10-BF-01 After snapshots are withdrawn, delivery during playback returns 0 and clears settled; no snapshot RPC is dispatched", async () => {
  const p = project([{ id: "t", name: "t", clips: [card("h", 0, 10)] }]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["h"]), light: new Set() }] };
  const stage = fakeStage();
  setBeatSwap(true, { swapMs: 3, occupied: () => 0 });
  assert.equal(beatSwapDebug().on, true);
  noteSettled("front", ["h"]);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), []);
  const delivered = await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
  assert.equal(delivered, 0, "After snapshots are withdrawn, deliverSnapshots returns 0");
  assert.equal(stage.calls.length, 0, "After snapshots are withdrawn, no snapshot RPC is dispatched to the stage");
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), ["h"], "settled is cleared during playback");
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: true }), ["h"], "Heavy cards are in suppressed during playback");
  setBeatSwap(false);
  assert.equal(beatSwapDebug().on, false);
  assert.equal(SNAPSHOT_THROTTLE_MS, 33);
});

test("C10-BF-02 After snapshots are withdrawn, suppressed takes over in top-to-bottom layer order; deliverSnapshots returns 0", async () => {
  // Three heavy cards: a on track top, b and c on track mid (c is after b, covering b)
  const p = project([
    { id: "top", name: "top", clips: [card("a", 0, 10)] },
    { id: "mid", name: "mid", clips: [card("b", 0, 10), card("c", 0, 10)] },
  ]);
  assert.deepEqual(topDownOrder(p, ["b", "c", "a"]), ["a", "c", "b"]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["a", "b", "c"]), light: new Set() }] };
  const stage = fakeStage();
  setBeatSwap(true, { swapMs: 3, occupied: () => 23.333333 - 6 });
  const ret = await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
  assert.equal(ret, 0, "deliverSnapshots returns 0");
  assert.equal(stage.calls.length, 0, "No snapshot RPC is dispatched");
  const sup = suppressedAt({ project: p, t: 1, playing: true });
  assert.deepEqual(sup, ["a", "b", "c"], "All heavy cards are placed under suppression (suppressed)");
  const d = beatSwapDebug();
  assert.equal(d.last, null, "After snapshots are withdrawn, last is null, with no null-pointer error");
});

/* ---------------------------------------------------------------- Frame-swap cost of each layer (swap-tuning task A) */

test("ST-A-08 The host supplies per-layer cost (by card kind): setBeatSwap stays signature-compatible; after snapshots are withdrawn, heavy cards are fully suppressed during playback", async () => {
  const p = project([
    { id: "top", name: "top", clips: [card("a", 0, 10)] },
    { id: "mid", name: "mid", clips: [card("b", 0, 10), card("c", 0, 10)] },
  ]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["a", "b", "c"]), light: new Set() }] };
  const stage = fakeStage();
  const kindCost = { a: 6, b: 20, c: 2 };
  setBeatSwap(true, { swapMs: 3, occupied: () => 23.333333 - 10, costOf: (_p, id) => kindCost[id] });
  const ret = await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
  assert.equal(ret, 0);
  assert.equal(stage.calls.length, 0);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: true }), ["a", "b", "c"]);
  assert.equal(beatSwapDebug().on, true);
});

test("ST-A-09 After snapshots are withdrawn, packing by size no longer happens; beatSwapDebug keeps a compatible signature with no null-pointer risk", async () => {
  const { SWAP_COST_MODEL, swapCostOfSize } = await import("../render/beatSwap.mjs");
  const big = "<div>" + "x".repeat(400 * 1024) + "</div>";                        // Approx. 400 KB text
  const bmp = '<img src="data:image/webp;base64,' + "A".repeat(400 * 1024) + '">'; // Approx. 400 KB bitmap
  const p = project([{ id: "t1", name: "t1", clips: [card("m", 0, 10)] }, { id: "t2", name: "t2", clips: [card("t", 0, 10)] }]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["m", "t"]), light: new Set() }] };
  const stage = fakeStage();
  setBeatSwap(true, { swapMs: 3, occupied: () => 23.333333 - 10, costOf: () => 3 });
  await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
  assert.equal(beatSwapDebug().knownSizes, 0, "After snapshots are withdrawn, snapshot sizes are not recorded");
  const mMs = swapCostOfSize({ bytes: bmp.length, bitmap: true });
  const tMs = swapCostOfSize({ bytes: big.length, bitmap: false });
  assert.ok(Math.abs(mMs - (SWAP_COST_MODEL.baseMs + SWAP_COST_MODEL.bitmapMsPerKB * bmp.length / 1024)) < 1e-9);
  assert.ok(tMs > mMs * 3, `At the same size, text is much more expensive than bitmaps: ${tMs} vs ${mMs}`);
  const d = beatSwapDebug();
  assert.equal(d.last, null, "After snapshots are withdrawn, last is null");
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: true }), ["m", "t"]);
  setBeatSwap(false);
  assert.equal(beatSwapDebug().on, false);
  assert.equal(swapCostOfSize({ bytes: 0 }), null);
  assert.equal(swapCostOfSize(undefined), null);
});

/**
 * Unit test for parent page snapshot / suppression delivery (`snapshotFeed.ts`, consumer of
 * C4 / C5 / A3c / K6). Run:
 *   node --experimental-test-module-mocks --test src/editor/snapshotFeed.test.mjs
 *
 * Ready index and byte fetching are replaced with fake snapshot source; dispatch table and mirror
 * key replaced with fakes; frame picking (`snapshotPick.mjs`) and ready index merging
 * (`snapshotSource.ts`) use real ones. Pins down:
 *   - Only active cards classified as heavy enter heavy, picking frames by backtracking the ready
 *     index, reporting wanted for missing ones (at most 8 items);
 *   - K6 downgrade cards live render as usual before dead asset covers "min(fps, remaining frames)
 *     from playhead";
 *   - Delivery baseline: delta, detach, 33 ms throttle, reset not throttled and carries reset, 2 MB
 *     chunking, carries reset next time after failure;
 *   - `pickForSetTime` synchronously returns bytes in hand, `awaiting` only counts cards "with
 *     table but without snapshot";
 *   - settled deletes card from baseline, redelivers next time on the same frame;
 *   - Suppression set only exists during playback, unioned with additional suppression from K3(b).
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let plan = { segments: [] };
const wantedPushed = [];

mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => plan } });
mock.module(srcUrl("render/dataMirror.ts"), {
  exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: (w) => wantedPushed.push(w) },
});

const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const {
  planFeed, pickForSetTime, deliverSnapshots, noteSettled, markBaselineReset, markPendingDemote, pendingDemotes,
  setExtraSuppressed, suppressedAt, setSnapshotSource, syncSnapshotSubscription, resetSnapshotFeed, setSnapshotArrive,
  MAX_WANTED, SNAPSHOT_THROTTLE_MS, SNAPSHOT_DELIVERY_MAX_BYTES,
} = feed;

/* ---------------------------------------------------------------- Mock environment */

let now = 1000;
performance.now = () => now;

/**
 * Fake snapshot source: manually push ready messages; fetching bytes returns `html:<id>`, can
 * specify content for certain ids
 */
function fakeSource() {
  const src = {
    push: null,
    bodies: new Map(),
    fetched: [],
    subscribeReady(_session, _rev, onMessage) { src.push = onMessage; return () => { src.push = null; }; },
    async fetchSnapshot(kind, key, localFrame) {
      const id = `${kind}/${key}/${localFrame}`;
      src.fetched.push(id);
      return src.bodies.get(id) ?? `html:${id}`;
    },
  };
  return src;
}

/** Fake stage client: records each setSnapshots, can make it fail */
function fakeStage() {
  const st = { calls: [], fail: false };
  st.setSnapshots = async (patch, opts) => {
    if (st.fail) throw new Error("iframe gone");
    st.calls.push({ patch, opts });
  };
  return st;
}

const FPS = 30;
const card = (id, start, end) => ({ id, cardId: "c", start, end, params: {} });
const project = (clips) => ({ version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: "t", name: "t", clips }] });
const heavyEverywhere = (...ids) => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(ids) }] });
const layer = (clipId, ranges, kind = "html", key = `k-${clipId}`) => ({ type: "layer", clipId, kind, key, ranges });
const settle = () => new Promise((r) => setImmediate(r));

let src;
beforeEach(() => {
  resetSnapshotFeed();
  src = fakeSource();
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  setExtraSuppressed([]);
  plan = { segments: [] };
  wantedPushed.length = 0;
  now += 10_000;
});

/* ---------------------------------------------------------------- Frame selection */

test("Only cards classified as heavy and currently mounted enter heavy; light cards and cards not present do not", () => {
  const p = project([card("h", 0, 10), card("l", 0, 10), card("gone", 12, 15)]);
  plan = heavyEverywhere("h", "gone");
  assert.deepEqual(planFeed({ project: p, t: 1, playing: false }).heavy, ["h"]);
});

test("Snapshots retired: planFeed no longer picks frames, picks is always empty, wanted is always empty", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 20]]));
  const f = planFeed({ project: p, t: 1, playing: false });
  assert.equal(f.picks.size, 0);
  assert.deepEqual(f.wanted, []);

  src.push(layer("h", [[0, 40]]));
  const g = planFeed({ project: p, t: 1, playing: false });
  assert.equal(g.picks.size, 0);
  assert.deepEqual(g.wanted, []);
});

test("html and local snapshots retired: no frames are picked, no gaps are reported", () => {
  const p = project([card("h", 0, 10), card("g", 0, 10)]);
  plan = heavyEverywhere("h", "g");
  src.push(layer("h", [[0, 100]], "local"));
  const f = planFeed({ project: p, t: 1, playing: false });
  assert.equal(f.picks.size, 0);
  assert.deepEqual(f.wanted, []);
});

test("Gap reporting is retired: wanted is always an empty array", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `h${String(i).padStart(2, "0")}`);
  plan = heavyEverywhere(...ids);
  const f = planFeed({ project: project(ids.map((id) => card(id, 0, 10))), t: 1, playing: false });
  assert.equal(f.heavy.length, 12);
  assert.equal(f.wanted.length, 0);
});

/* ---------------------------------------------------------------- K6 */

test("K6: before the dead asset of a downgraded card is ready, live render as usual and do not enter heavy", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  markPendingDemote("h");
  // Playhead at frame 30: must cover [30, 59] (one second, i.e. segments 2 and 3) to count as ready
  const streamLayer = (ranges, originFrame = 0) => ({ ...layer("h", ranges, "stream"), originFrame });
  src.push(streamLayer([[0, 1]]));
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, []);
  assert.ok(pendingDemotes().has("h"));
  src.push(streamLayer([[0, 3]]));
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, ["h"]);
  assert.equal(pendingDemotes().has("h"), false, "Removed from pending once ready");
});

test("K6: when less than a second of the clip remains, covering up to the end of the clip counts as ready; a stream counts only if its segments cover the second starting from the current position (root cause D)", () => {
  const p = project([card("h", 0, 10)]);   // 300 frames, local 0..299
  plan = heavyEverywhere("h");
  markPendingDemote("h");
  const streamLayer = (ranges, originFrame = 0) => ({ ...layer("h", ranges, "stream"), originFrame });
  src.push(streamLayer([[19, 19]]));
  assert.deepEqual(planFeed({ project: p, t: 290 / FPS, playing: true }).heavy, ["h"]);

  resetSnapshotFeed();
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  markPendingDemote("h");
  // Stream layer carries the stream's own first frame (clip starts from frame 0, so 0); segments
  // count from it
  src.push(streamLayer([[0, 0]]));
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, [], "Other segments in the stream table do not count: there is no data at the current position");
  // Second 1 = frame 30; one second to frame 59 = segments 2 and 3
  src.push(streamLayer([[2, 3]]));
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, ["h"]);
  // Layer without first frame (sent by producer before segment rule change) cannot convert: treated
  // as no stream
  src.push(layer("h", [[2, 3]], "stream"));
  markPendingDemote("h");
  assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, [], "A stream layer without its first frame is not ready");
});

/* ---------------------------------------------------------------- Delivery */

/* ---------------------------------------------------------------- Delivery */

test("pickForSetTime: after snapshots retire it always returns empty snapshots and empty awaiting, and starts no byte fetch", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 100]]));
  const head = { project: p, t: 1, playing: false };
  const first = pickForSetTime(head);
  assert.deepEqual(first, { snapshots: {}, awaiting: [] });
  assert.deepEqual(src.fetched, []);
});

test("pickForSetTime: a heavy-classified card without a table is not put in awaiting (it would never arrive anyway)", () => {
  plan = heavyEverywhere("h");
  assert.deepEqual(pickForSetTime({ project: project([card("h", 0, 10)]), t: 1, playing: false }).awaiting, []);
});

test("deliverSnapshots: returns 0 after snapshots retire and no longer dispatches snapshot patches to the stage", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[0, 100]]));
  const stage = fakeStage();
  const head = { project: p, t: 1, playing: true };
  assert.equal(await deliverSnapshots(stage, "front", head), 0);
  assert.equal(stage.calls.length, 0);
});

test("deliverSnapshots: delivery during playback clears settled", async () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  const stage = fakeStage();
  noteSettled("front", ["h"]);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), []);
  await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), ["h"]);
});

test("markBaselineReset: kept as a backward-compatible interface", () => {
  markBaselineReset("front");
  markBaselineReset("back");
});

test("The settled state affects suppressedAt and scrub", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  const head = { project: p, t: 1, playing: false };
  assert.deepEqual(suppressedAt(head), ["h"]);
  noteSettled("front", ["h"]);
  assert.deepEqual(suppressedAt(head), []);
  pickForSetTime(head);
  assert.deepEqual(suppressedAt(head), ["h"]);
});

/*
 * c10a contract section 17 "Catch up current frame on stop" (under "only one stage" since
 * 2026-10-22): on stop, stage catches up this current frame layer by layer once in visible stage;
 * rendered layers receive `settled`, and like dual stage, no longer suppressed during pause;
 * next setTime / playback enters suppression as usual.
 */
test("Single stage: a layer that has caught up and drawn a frame after stopping (settled) is no longer suppressed while paused; the next setTime enters suppression as usual", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  const head = { project: p, t: 1, playing: false, single: true, sparseOnly: true };
  assert.deepEqual(suppressedAt(head), ["h"]);
  noteSettled("front", ["h"]);
  assert.deepEqual(suppressedAt(head), []);
  pickForSetTime(head);
  assert.deepEqual(suppressedAt(head), ["h"]);
});

/* ---------------------------------------------------------------- Suppression */

test("Heavy-card suppression set: during playback it is heavy plus the extra suppression of K3(b); when paused, cards not yet settled enter scrub", () => {
  const p = project([card("h", 0, 10), card("l", 0, 10)]);
  plan = heavyEverywhere("h");
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: true }), ["h"]);
  setExtraSuppressed(["l", "h"]);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: true }), ["h", "l"]);
  // Heavy cards not settled during pause enter scrub placeholder
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), ["h"]);
  // No longer suppressed during pause after settled
  noteSettled("front", ["h"]);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), []);
});

test("After snapshots retire, wanted gaps are no longer reported to the prerender process", () => {
  plan = heavyEverywhere("h");
  pickForSetTime({ project: project([card("h", 0, 10)]), t: 1, playing: false });
  assert.deepEqual(wantedPushed, []);
});

test("Lowest tier: small-size snapshots retired, picks is always empty, and heavy cards not yet ready enter scrub for a placeholder when paused", () => {
  const p = project([card("h", 0, 10)]);
  plan = heavyEverywhere("h");
  src.push(layer("h", [[1, 27], [32, 119]]));
  const f = planFeed({ project: p, t: 1, playing: false, single: true, sparseOnly: true });
  assert.equal(f.picks.size, 0);
  assert.deepEqual(f.scrub, ["h"]);
});

/* ---------------------------------------------------------------- C10 section 9: online user cards, media effect cards */

test("Online browser mode: user cards and media effect cards (including synced ones) are all treated as heavy cards; \"already exact\" is not honored once stopped; desktop unchanged (C10 contract, section 9, 2026-09-29)", async () => {
  const registry = await import(srcUrl("kernel/registry.ts"));
  const host = await import(srcUrl("render/placeholderHost.ts"));
  registry.registerCards([{ id: "graphish", card: () => null, params: {} }]);
  registry.setUserCardSources({ "mine.tsx": "" }, { mine: "mine.tsx" });
  registry.setSyncedUserCards([{ id: "synced", name: "Synced card" }]);
  const clips = [
    { ...card("u", 0, 10), cardId: "mine" },
    { ...card("g", 0, 10), cardId: "graphish" },
    { ...card("s", 0, 10), cardId: "synced" },
    card("b", 0, 10),
  ];
  const p = project(clips);
  // Dispatch table only classifies u, g, b as heavy: synced card s is not classified as heavy in
  // table (this machine cannot test it)
  plan = heavyEverywhere("u", "g", "b");
  for (const id of ["u", "g", "s", "b"]) src.push(layer(id, [[0, 299]]));
  try {
    // Desktop: according to dispatch table, sync table has no effect
    host.setOnlineBrowserMode(false);
    assert.deepEqual(planFeed({ project: p, t: 1, playing: true }).heavy, ["b", "g", "u"]);
    // Online: all four cards are treated as heavy cards
    host.setOnlineBrowserMode(true);
    resetSnapshotFeed(); src = fakeSource(); setSnapshotSource(src); syncSnapshotSubscription(() => {});
    for (const id of ["u", "g", "s", "b"]) src.push(layer(id, [[0, 100]]));
    const got = planFeed({ project: p, t: 5, playing: true });
    assert.deepEqual(got.heavy, ["b", "g", "s", "u"]);
    assert.equal(got.picks.size, 0, "Snapshots are retired");
    assert.deepEqual(got.wanted, [], "Gaps are no longer reported");
    assert.deepEqual(suppressedAt({ project: p, t: 5, playing: true }), ["b", "g", "s", "u"], "Always suppressed while playing");
    const stage = fakeStage();
    await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
    await settle();
    assert.equal(src.fetched.length, 0, "Snapshot bytes are no longer fetched");
    // Paused state: built-in cards that stage reported settled (caught up to precision on stop) are
    // no longer suppressed; cards that cannot run on this machine do not catch up on stop, staying in
    // scrub placeholder
    noteSettled("front", ["b", "u", "s"]);
    const paused = planFeed({ project: p, t: 1, playing: false });
    assert.deepEqual(paused.scrub.sort(), ["g", "s", "u"]);
  } finally {
    host.setOnlineBrowserMode(false);
    registry.setSyncedUserCards([]);
    registry.setUserCardSources({}, {});
  }
});

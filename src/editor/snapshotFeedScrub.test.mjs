/**
 * Unit test for "stream pasting during pause and scrub" on the parent page side (`snapshotFeed.ts`;
 * task brief "Ji-3").
 * Run: npm test -- src/editor/snapshotFeedScrub.test.mjs
 *
 * Pin:
 *   - When not playing, heavy cards that have a stream for this frame still emit stream planes and
 *     are suppressed (`FeedPlan.scrub`);
 *   - **Do not read snapshots when streams exist**: even if the snapshot table covers this frame,
 *     it does not select frames, fetch bytes, name `awaiting`, or report gaps;
 *   - Cards whose segment for this frame is not ready or that have no stream at all fall back to
 *     snapshots (current behavior) and are not suppressed;
 *   - Cards caught up to precise live render (`settled`) are no longer suppressed, but stream
 *     planes are still emitted as usual (decoding this frame under the playhead first); next
 *     `setTime` and playback start proceed as usual;
 *   - Group streams are evaluated as a whole; layers exceeding decoder budget remain suppressed and
 *     fall back to snapshots; lowest tier (only one stage) does not emit stream planes while paused,
 *     following current behavior;
 *   - Clip does not start at a multiple-of-15 frame: converted based on this stream's own first frame.
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
let plan = null;
const wantedPushed = [];
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => plan } });
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: (w) => wantedPushed.push(w) } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const { planFeed, pickForSetTime, deliverSnapshots, noteSettled, markAllSettled, suppressedAt, streamPlanesAt, setSnapshotSource, syncSnapshotSubscription, resetSnapshotFeed } = feed;
// Budget for streams on the same screen counts pixels (`render/streamBudget.mjs`). Cards in this
// test are all full-frame, project is 30 frames per second:
// The count that fits on screen is computed from budget (1.504 billion ÷ (1920 × 2176 × 30) = 12),
// still called DECODER_BUDGET below
const { STREAM_PIXEL_RATE_BUDGET, streamCost, stageStreamPixels } = await import(srcUrl("render/streamBudget.mjs"));
const DECODER_BUDGET = Math.floor(STREAM_PIXEL_RATE_BUDGET / streamCost(stageStreamPixels({ width: 1920, height: 1080 }), 30));

let now = 1000;
performance.now = () => now;

const FPS = 30;
const card = (id, start = 0, end = 10) => ({ id, cardId: "c", start, end, params: {} });
const project = (clips) => ({ version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: "t", name: "t", clips }] });
const heavyEverywhere = (...ids) => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(ids) }] });
const html = (clipId, ranges, key = `k-${clipId}`) => ({ type: "layer", clipId, kind: "html", key, ranges });
const stream = (clipId, ranges, extra = {}) => ({ type: "layer", clipId, kind: "stream", key: `s-${clipId}`, ranges, originFrame: 0, ...extra });
const at = (frame) => frame / FPS + 1e-4;

let src;
beforeEach(() => {
  resetSnapshotFeed();
  src = { push: null, fetched: [],
    subscribeReady(_s, _r, cb) { src.push = cb; return () => {}; },
    async fetchSnapshot(kind, key, f) { src.fetched.push(`${kind}/${key}/${f}`); return `html:${key}/${f}`; } };
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  plan = { segments: [] };
  wantedPushed.length = 0;
  now += 10_000;
});

test("Pause / scrub: a heavy card with a stream at this frame sends a stream plane and is suppressed; with a stream no snapshot is read (no frame picked, no bytes fetched, no waiting, no gaps reported)", async () => {
  const p = project([card("h"), card("l")]);
  plan = heavyEverywhere("h");
  src.push(html("h", [[0, 299]]));               // Snapshot table covers every frame
  src.push(stream("h", [[0, 19]]));
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.deepEqual(f.heavy, ["h"]);
  assert.deepEqual(f.streamPlanes, [{ clipIds: ["h"], key: "s-h", ranges: [[0, 19]], originFrame: 0 }]);
  assert.deepEqual(f.scrub, ["h"]);
  assert.equal(f.picks.size, 0, "With a stream, snapshots are not read");
  assert.deepEqual(f.wanted, []);
  assert.deepEqual(suppressedAt(head), ["h"]);
  assert.deepEqual(streamPlanesAt(head), f.streamPlanes);
  const set = pickForSetTime(head);
  assert.deepEqual(set, { snapshots: {}, awaiting: [] }, "setTime carries no snapshots and names none to wait for");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(src.fetched, [], "None of the snapshot bytes are fetched");
  assert.deepEqual(wantedPushed, []);
  const calls = [];
  await deliverSnapshots({ setSnapshots: async (patch) => { calls.push(patch); } }, "front", head);
  assert.deepEqual(calls, [], "Nor delivered");
});

test("The stream of the segment containing this frame is not ready, or this card has no stream at all: the heavy card enters scrub for a placeholder and no snapshot is picked", () => {
  const p = project([card("h"), card("n")]);
  plan = heavyEverywhere("h", "n");
  src.push(html("h", [[0, 299]]));
  src.push(html("n", [[0, 299]]));
  src.push(stream("h", [[0, 1]]));                // Only the first two segments (frames 0-29)
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.deepEqual(f.streamPlanes, []);
  assert.deepEqual(f.scrub, ["h", "n"]);
  assert.equal(f.picks.size, 0, "Snapshots retired, no snapshot is picked");
  assert.deepEqual(suppressedAt(head), ["h", "n"]);
  assert.deepEqual(pickForSetTime(head), { snapshots: {}, awaiting: [] });
  // Scrub back to the segment with a stream: h pastes stream, n holds placeholder in scrub as usual
  const back = planFeed({ ...head, t: at(20) });
  assert.deepEqual(back.streamPlanes.map((s) => s.clipIds[0]), ["h"]);
  assert.deepEqual(back.scrub, ["h", "n"]);
  assert.equal(back.picks.size, 0);
});

test("A card that has caught up to exact live render (settled) is no longer suppressed and its stream plane is still sent (to decode this frame first); the next setTime pastes the stream again; starting playback suppresses as usual", () => {
  const p = project([card("h")]);
  plan = heavyEverywhere("h");
  src.push(stream("h", [[0, 19]]));
  const head = { project: p, t: at(37), playing: false };
  pickForSetTime(head);
  assert.deepEqual(suppressedAt(head), ["h"]);
  noteSettled("front", ["h"]);
  const settled = planFeed(head);
  assert.deepEqual(settled.scrub, [], "On stopping, the fallback is withdrawn: cards that have caught up are not covered again");
  assert.equal(settled.streamPlanes.length, 1, "The stream plane stays: the stage uses it to decode the frame under the playhead first");
  assert.equal(settled.picks.size, 0);
  // Start playback: same plane as the one decoded first while paused (stage does not need to rebuild
  // decoder), suppressed only at this point
  const playing = { ...head, playing: true };
  assert.deepEqual(streamPlanesAt(playing), settled.streamPlanes);
  assert.deepEqual(suppressedAt(playing), ["h"]);
  // Scrub again: previous "precise" is invalidated
  pickForSetTime({ ...head, t: at(52) });
  assert.deepEqual(suppressedAt({ ...head, t: at(52) }), ["h"]);
});

test("After a swap in paused state, the whole stage is exact (markAllSettled): no card is suppressed and the stream planes are still sent", () => {
  const p = project([card("a"), card("b")]);
  plan = heavyEverywhere("a", "b");
  src.push(stream("a", [[0, 19]]));
  src.push(stream("b", [[0, 19]]));
  const head = { project: p, t: at(37), playing: false };
  assert.deepEqual(suppressedAt(head), ["a", "b"]);
  markAllSettled("front");
  assert.deepEqual(suppressedAt(head), []);
  assert.equal(streamPlanesAt(head).length, 2);
});

test("Group stream is judged as a whole: if any member has not caught up, the whole group stays suppressed; it is released only when all have caught up", () => {
  const p = project([card("a"), card("b")]);
  plan = heavyEverywhere("a", "b");
  src.push(stream("b", [[0, 19]], { key: "g", groupClipIds: ["a", "b"] }));
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.deepEqual(f.streamPlanes, [{ clipIds: ["a", "b"], key: "g", ranges: [[0, 19]], originFrame: 0 }]);
  assert.deepEqual(f.scrub, ["a", "b"]);
  noteSettled("front", ["a"]);
  assert.deepEqual(planFeed(head).scrub, ["a", "b"], "a catches up first: b is still in the group, so the whole group is not released");
  noteSettled("front", ["b"]);
  assert.deepEqual(planFeed(head).scrub, []);
  // One card in the group is not classified as heavy at this moment: this group is not pasted (each
  // goes its own way)
  plan = heavyEverywhere("a");
  pickForSetTime(head);
  assert.deepEqual(planFeed(head).streamPlanes, []);
  assert.deepEqual(planFeed(head).scrub, ["a"], "a has no stream but is still a heavy card not yet settled, so it enters scrub for a placeholder");
  noteSettled("front", ["a"]);
  assert.deepEqual(planFeed(head).scrub, [], "a is no longer suppressed after settled");
});

test("Over the decoder budget on one screen: stream planes are cut to the budget; the ones that go over are also suppressed (placeholder) and no snapshot is picked", () => {
  const ids = Array.from({ length: DECODER_BUDGET + 2 }, (_, i) => `c${i}`);
  const p = project(ids.map((id) => card(id)));
  plan = heavyEverywhere(...ids);
  for (const id of ids) { src.push(html(id, [[0, 299]])); src.push(stream(id, [[0, 19]])); }
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.equal(f.streamPlanes.length, DECODER_BUDGET);
  assert.deepEqual(f.scrub, [...ids].sort());
  assert.equal(f.picks.size, 0, "Snapshots retired, no snapshot is picked");
  assert.equal(f.overPlanes.length, 2, "Those over budget are marked over");
});

test("Projects larger than 1080p or above 60 fps: with up to 6 streams on screen the pixels are not checked, all send stream planes, and no layer is over budget (what was let through before is still let through)", () => {
  const ids = ["a", "b", "c", "d"];
  for (const size of [{ width: 3840, height: 2160, fps: 60 }, { width: 3840, height: 2160, fps: 30 }, { width: 2560, height: 1440, fps: 60 }, { width: 1920, height: 1080, fps: 120 }]) {
    const p = { ...project(ids.map((id) => card(id))), ...size };
    plan = heavyEverywhere(...ids);
    for (const id of ids) src.push(stream(id, [[0, 39]]));
    for (const playing of [true, false]) {
      const f = planFeed({ project: p, t: 1, playing });
      assert.equal(f.streamPlanes.length, 4, `${size.width}×${size.height}@${size.fps} playing=${playing}`);
      assert.deepEqual(f.overPlanes, []);
      assert.equal(f.picks.size, 0, "All are covered by streams, so no snapshot is read");
    }
  }
});

test("Lowest tier: playback, pause and scrub all send stream planes, each carrying first (decode only the first frame of the segment); snapshots are retired, so no small size is picked", () => {
  const p = project([card("h"), card("n")]);
  plan = heavyEverywhere("h", "n");
  src.push(html("h", [[0, 299]]));
  src.push(html("n", [[0, 299]]));
  src.push(stream("h", [[0, 19]]));
  for (const playing of [false, true]) {
    const f = planFeed({ project: p, t: at(37), playing, single: true, sparseOnly: true });
    assert.deepEqual(f.streamPlanes, [{ clipIds: ["h"], key: "s-h", ranges: [[0, 19]], originFrame: 0, first: true }], `playing=${playing}`);
    assert.deepEqual(f.overPlanes, []);
    assert.equal(f.picks.size, 0, "Small-size snapshots retired");
  }
  // Stream planes of other tiers do not carry first (decoded frame by frame as usual)
  assert.deepEqual(planFeed({ project: p, t: at(37), playing: true }).streamPlanes, [{ clipIds: ["h"], key: "s-h", ranges: [[0, 19]], originFrame: 0 }]);
  // Stream for the segment containing this frame is not ready yet (only segments 0 and 1, playhead is
  // at segment 2): do not emit stream plane, do not select small size
  src.push(stream("h", [[0, 1]]));
  const late = planFeed({ project: p, t: at(37), playing: false, single: true, sparseOnly: true });
  assert.deepEqual(late.streamPlanes, []);
  assert.equal(late.picks.size, 0);
  assert.deepEqual(late.scrub, ["h", "n"]);
});

test("Lowest-tier budget: only 4 small cards on screen (decoder count), only 2 full-screen cards (sum of frame sizes); the excess is marked over; other tiers fit the same cards", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const head = (p, extra = {}) => ({ project: p, t: at(37), playing: true, ...extra });
  // Six small cards (box 320×240)
  const small = project(ids.map((id) => ({ ...card(id), frame: { x: 0, y: 0, w: 320, h: 240 } })));
  plan = heavyEverywhere(...ids);
  for (const id of ids) { src.push(html(id, [[0, 299]])); src.push(stream(id, [[0, 19]])); }
  const s = planFeed(head(small, { single: true, sparseOnly: true }));
  assert.deepEqual(s.streamPlanes.map((x) => x.clipIds[0]), ["a", "b", "c", "d"]);
  assert.ok(s.streamPlanes.every((x) => x.first === true));
  assert.deepEqual(s.overPlanes.map((x) => [x.clipIds[0], x.over, "first" in x]), [["e", true, false], ["f", true, false]]);
  assert.equal(s.picks.size, 0, "Small-size snapshots retired");
  assert.equal(streamPlanesAt(head(small, { single: true, sparseOnly: true })).length, 6, "What is sent to the stage is the 4 admitted planes plus the 2 over budget (only to lay out placeholders)");
  assert.equal(planFeed(head(small)).streamPlanes.length, 6, "Other tiers: all 6 are admitted");
  // Six full-screen cards: lowest tier allows 2; 60 fps projects are also 2 (overhead is not multiplied
  // by project frame rate)
  for (const fps of [30, 60]) {
    const full = { ...project(ids.map((id) => card(id))), fps };
    const f = planFeed({ project: full, t: 1, playing: true, single: true, sparseOnly: true });
    assert.deepEqual(f.streamPlanes.map((x) => x.clipIds[0]), ["a", "b"], `fps ${fps}`);
    assert.equal(f.overPlanes.length, 4);
    assert.equal(planFeed({ project: full, t: 1, playing: true }).streamPlanes.length, 6, "Other tiers: up to 6 streams, pixels are not checked");
  }
});

test("The clip starts at frame 100 (not a multiple of 15): while paused, judge whether this frame has a stream by the stream's own first frame", () => {
  const p = project([card("d", 100 / FPS + 1e-3, 250 / FPS)]);
  plan = heavyEverywhere("d");
  src.push(stream("d", [[1, 2]], { originFrame: 101 }));   // Frames 116-145
  const streamAt = (frame) => planFeed({ project: p, t: at(frame), playing: false }).streamPlanes.length;
  assert.equal(streamAt(115), 0, "Frame 115 is in segment 0, not ready");
  assert.equal(streamAt(116), 1);
  assert.equal(streamAt(145), 1);
  assert.equal(streamAt(146), 0, "Frame 146 is segment 3");
});

test("A card this device cannot run (online browser mode) does not catch up when stopped: \"already exact\" does not hold for it, and it keeps pasting the stream while paused", async () => {
  const registry = await import(srcUrl("kernel/registry.ts"));
  const host = await import(srcUrl("render/placeholderHost.ts"));
  registry.setSyncedUserCards([{ id: "synced", name: "Synced card" }]);
  const p = project([{ ...card("s"), cardId: "synced" }, card("b")]);
  plan = heavyEverywhere("b");
  try {
    host.setOnlineBrowserMode(true);
    resetSnapshotFeed(); setSnapshotSource(src); syncSnapshotSubscription(() => {});
    src.push(stream("s", [[0, 19]]));
    src.push(stream("b", [[0, 19]]));
    const head = { project: p, t: at(37), playing: false };
    assert.deepEqual(planFeed(head).scrub, ["b", "s"]);
    noteSettled("front", ["b", "s"]);
    assert.deepEqual(planFeed(head).scrub, ["s"]);
    markAllSettled("front");
    assert.deepEqual(planFeed(head).scrub, ["s"]);
  } finally {
    host.setOnlineBrowserMode(false);
    registry.setSyncedUserCards([]);
  }
});

test("A pure remotion heavy card without a stream does not enter scrub when paused / scrubbing (the live component is exposed and renders directly)", async () => {
  const registry = await import(srcUrl("kernel/registry.ts"));
  registry.registerCards([
    { id: "pure-remotion", name: "Pure Remotion", frameMode: "direct", Component: () => null },
  ]);
  const p = project([{ id: "r", cardId: "pure-remotion", start: 0, end: 10, params: {} }]);
  plan = heavyEverywhere("r");
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.ok(f.heavy.includes("r"), "Classified as heavy by the dispatch table");
  assert.equal(f.streamPlanes.length, 0, "No stream");
  assert.deepEqual(f.scrub, [], "A pure remotion heavy card does not enter scrub; the live component is exposed and renders directly");
});

test("Without a stream, a heavy card with parts or a motion heavy card enters scrub for a placeholder (must not be misjudged as direct)", async () => {
  const registry = await import(srcUrl("kernel/registry.ts"));
  registry.registerCards([
    { id: "motion-card", name: "Motion Card", frameMode: "stateful", Component: () => null },
    { id: "direct-composite", name: "Direct Composite", frameMode: "direct", Component: () => null },
  ]);
  // 1. motion heavy card (frameMode: stateful)
  // 2. Composite clip declaring direct but with parts (clipFrameMode classified as stateful)
  const p = project([
    { id: "m", cardId: "motion-card", start: 0, end: 10, params: {} },
    { id: "c_parts", cardId: "direct-composite", start: 0, end: 10, params: {}, parts: [{ id: "p1" }] },
  ]);
  plan = heavyEverywhere("m", "c_parts");
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.deepEqual(f.streamPlanes, []);
  assert.deepEqual(f.scrub, ["c_parts", "m"], "A heavy card with parts or stateful enters scrub for a placeholder");
});

test("A non-remotion heavy card without a stream does not enter scrub when there is no cost record or in single-stage vtOk=false (prevents getting stuck on the placeholder)", () => {
  const p = project([card("unmeasured"), card("single_vtfail")]);
  plan = heavyEverywhere("unmeasured", "single_vtfail");
  feed.setCostResolver(
    (_proj, clipId) => {
      if (clipId === "single_vtfail") return { identityKey: "k2", fps: 30, stepMs: 25, vtOk: false };
      return undefined; // unmeasured has no cost record
    },
    () => false // single stage mode
  );
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.deepEqual(f.scrub, [], "Unmeasured or single-stage vtOk=false is not locked into scrub");
});

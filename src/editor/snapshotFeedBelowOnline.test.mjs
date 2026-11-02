/**
 * Unit test for "below-dependent card pasting its track stream" on the online page side: real
 * online source (`OnlineSnapshotSource` in `render/snapshotSource.ts`, reading rows with
 * `kind: below` in the layer table) connects to real parent page frame selection
 * (`snapshotFeed.ts`). Fourth block of "Wu-2" (lower layer 4) in task brief
 * `render-refactor-task.md`.
 * Run: npm test -- src/editor/snapshotFeedBelowOnline.test.mjs
 *
 * The parent-page half of the rules (suppression, not reading snapshots when streams exist,
 * withdrawing after catching up to precise live render, expiration, consuming budget) was pinned
 * by ready messages in `snapshotFeedBelow.test.mjs`; what is pinned here is that "the layer read
 * by online source from the layer table follows the same setup when reaching the parent page":
 *   - Playback, pause, and scrub all emit stream planes, with planes carrying `plane: "stage"`;
 *     this card is suppressed; does not read snapshots (even if the snapshot layer for the same
 *     card in the layer table is ready, it is not selected);
 *   - Once stopped and caught up to precise live render, it is no longer suppressed, and stream
 *     planes are sent as usual;
 *   - Lower layer changed: parent page stops sending on the spot (compares the project in store
 *     with the signature carried by that layer table row, without waiting for online source to
 *     receive the new project); online source withdraws that layer after receiving the new
 *     project; once layer table switches to a new row (new key, new signature), it pastes again;
 *   - Consumes decoder budget: counted together with other streams.
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

globalThis.window = globalThis;
let plan = null;
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => plan } });
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: () => {} } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const { planFeed, pickForSetTime, noteSettled, suppressedAt, streamPlanesAt, snapshotFeedDebug, setSnapshotSource, syncSnapshotSubscription, resetSnapshotFeed } = feed;
const { OnlineSnapshotSource, LAYER_MAP_PREFIX, LAYER_MAP_POLL_MS } = await import(srcUrl("render/snapshotSource.ts"));
const { SEGMENT_FRAMES } = await import(srcUrl("render/streamPlayer.ts"));
// Budget for streams on the same screen counts pixels (`render/streamBudget.mjs`). Cards in this
// test are all full-frame, project is 30 frames per second:
// The count that fits on screen is computed from budget (1.504 billion ÷ (1920 × 2176 × 30) = 12),
// still called DECODER_BUDGET below
const { STREAM_PIXEL_RATE_BUDGET, streamCost, stageStreamPixels } = await import(srcUrl("render/streamBudget.mjs"));
const DECODER_BUDGET = Math.floor(STREAM_PIXEL_RATE_BUDGET / streamCost(stageStreamPixels({ width: 1920, height: 1080 }), 30));
const { streamInputSig } = await import(srcUrl("render/streamInputSig.mjs"));

let now = 1000;
performance.now = () => now;

const FPS = 30;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const RK = (n) => n.toString(16).padStart(64, "0");
const bytesOf = (text) => new TextEncoder().encode(text);
const card = (id, start, end, extra = {}) => ({ id, cardId: "c", start, end, params: {}, ...extra });
const GLASS_START = 40 / FPS;   // Starting from frame 40, not a multiple of 15
function project(edit = (p) => p) {
  return edit({
    id: "p1", version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [],
    tracks: [
      { id: "top", name: "top", clips: [card("title", 0, 10, { params: { text: "Title" } })] },
      { id: "mid", name: "mid", clips: [card("glass", GLASS_START, GLASS_START + 4, { frame: { x: 100, y: 100, w: 600, h: 300 } })] },
      { id: "low", name: "low", clips: [card("mover", 0, 10, { params: { speed: 1 } })] },
    ],
  });
}
const sigOf = (p) => streamInputSig(p, { clipIds: ["glass"], kind: "below" });
const heavy = (...ids) => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(ids) }] });
const at = (frame) => frame / FPS + 1e-4;
/**
 * When the playhead is at frame 77 (segment 2 of this stream), online source fetches segments for
 * this page: one segment back, a few seconds forward (only fetching near the playhead).
 */
const READY = [[1, 6]];

/** Fake content store + fake asset service */
function world() {
  const w = { content: new Map(), bytes: new Map(), clock: 1_000_000 };
  w.deps = {
    async request(msg) {
      if (!w.content.has(msg.key)) return { type: "content.item", kind: msg.kind, key: msg.key, missing: true };
      return { type: "content.item", kind: msg.kind, key: msg.key, body: structuredClone(w.content.get(msg.key)), hash: "x" };
    },
    assetBase: () => "https://h.example/media/api/asset/",
    authHeaders: async () => ({ Authorization: "Bearer T" }),
    async fetch(url) {
      const b = w.bytes.get(url.split("/").pop());
      if (!b) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, headers: { get: () => "video/mp4" }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    },
    now: () => w.clock, setTimer: () => 0, clearTimer: () => {},
  };
  /** Manifest of a stream (segments 0-7) and its bytes */
  w.putStream = (rk, { clipIds, kind, plane }) => {
    const initBytes = bytesOf(`init ${rk}`), initHash = sha(initBytes), id = initHash.slice(0, 16);
    w.bytes.set(initHash, initBytes);
    const segments = {};
    for (let n = 0; n <= 7; n++) {
      const body = bytesOf(`seg ${rk} ${n}`), hash = sha(body);
      w.bytes.set(hash, body);
      segments[n] = { hash, bytes: body.length, init: id, stride: 1, samples: SEGMENT_FRAMES, sig: null, encoder: "libx264" };
    }
    w.content.set(`${rk}:0-7`, { v: 1, kind: "stream", resultKey: rk, range: { from: 0, to: 7 },
      header: { kind, plane, clipIds, fps: FPS, bound: { x: 0, y: 0, w: 1920, h: 1080 }, offset: { x: 0, y: 0 }, tight: { x: 96, y: 96, w: 608, h: 308 } },
      inits: { [id]: { hash: initHash, bytes: initBytes.length, codec: "avc1.640028", width: 608, height: 616, timescale: 15360, rect: { x: 96, y: 96, w: 608, h: 308 }, encoder: "libx264" } },
      segments });
  };
  w.putMap = (streams, layers = []) => w.content.set(`${LAYER_MAP_PREFIX}p1`, { v: 3, kind: "layer-map", projectId: "p1", entryKey: "e", fps: FPS, span: 60, at: 1, layers, streams });
  w.settle = async (src) => { await src.tickNow(); await src.idle(); await src.tickNow(); await src.idle(); };
  return w;
}
const belowRow = (p, rk, over = {}) => ({ topClipId: "glass", clipIds: ["glass"], kind: "below", plane: "stage", contentKey: `ck-${rk.slice(-2)}`,
  candidates: [{ envFingerprint: "fp-host", resultKey: rk }], originFrame: 40, lastSegment: 7, segmentsPerTask: 8, inputSig: sigOf(p), ...over });
const cardRow = (id, rk) => ({ topClipId: id, clipIds: [id], kind: "card", plane: "local", contentKey: `ck-${id}`,
  candidates: [{ envFingerprint: "fp-host", resultKey: rk }], originFrame: 0, lastSegment: 7, segmentsPerTask: 8 });

let w, src;
beforeEach(() => {
  resetSnapshotFeed();
  w = world();
  src = new OnlineSnapshotSource(w.deps, { tier: "original" });
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  plan = { segments: [] };
  now += 10_000;
});

test("Online source reads out a below-dependent stream: playback, pause and scrub all send a stream plane with plane: stage and are suppressed, with no snapshot read; once caught up, no suppression and the plane is still sent", async () => {
  const p = project();
  const rk = RK(0xb1);
  plan = heavy("glass");
  w.putStream(rk, { clipIds: ["glass"], kind: "below", plane: "stage" });
  // Layer table has another ready snapshot layer for this card (local tier): not read if a stream exists
  const snap = sha(bytesOf("<div>snap</div>"));
  w.bytes.set(snap, bytesOf("<div>snap</div>"));
  w.content.set("r-glass:0-59", { v: 1, kind: "snapshot", tier: "shared", resultKey: "r-glass", dirKey: "r-glass", range: { from: 0, to: 59 }, frames: [[37, snap, 10]] });
  w.putMap([belowRow(p, rk)], [{ clipId: "glass", kind: "html", key: "k-glass", tier: "shared", resultKey: "r-glass", dirKey: "r-glass", entryKey: null, firstFrame: 40, count: 120,
    contentKey: "ck-snap", envFingerprint: "fp-host", candidates: [{ envFingerprint: "fp-host", resultKey: "r-glass", key: "k-glass", dirKey: "r-glass" }] }]);
  src.setProject("p1");
  src.setInputs(p);
  src.focus(at(77), FPS);
  await w.settle(src);
  const want = [{ clipIds: ["glass"], key: rk, ranges: READY, originFrame: 40, plane: "stage" }];
  assert.deepEqual(snapshotFeedDebug({ project: p, t: at(77), playing: false }).ready.find((r) => r.clipId === "glass").kinds.map((k) => k.kind).sort(), ["html", "stream"], "Both the snapshot layer and the stream layer are ready");
  for (const playing of [true, false]) {
    const head = { project: p, t: at(77), playing };
    const f = planFeed(head);
    assert.deepEqual(f.heavy, ["glass"]);
    assert.deepEqual(f.streamPlanes, want, `playing=${playing}`);
    assert.deepEqual(suppressedAt(head), ["glass"]);
    assert.equal(f.picks.size, 0, "With a stream, snapshots are not read");
  }
  for (const frame of [55, 69, 70, 100, 144]) {   // First frame of segment, last frame, first frame of next segment, middle, last frame of ready range
    const head = { project: p, t: at(frame), playing: false };
    assert.deepEqual(streamPlanesAt(head), want, `Scrubbed to frame ${frame}`);
    assert.deepEqual(pickForSetTime(head).snapshots, {});
    assert.deepEqual(suppressedAt(head), ["glass"]);
  }
  // Manifest for the stage: kind below, in stage coordinates (`StreamPlaneSender` carries it along
  // with the stream plane; player uses this to check that the plane is attached under the stage root)
  const plane = src.streamPlane(rk);
  assert.equal(plane.manifest.kind, "below");
  assert.equal(plane.manifest.plane, "stage");
  assert.deepEqual(plane.manifest.tight, { x: 96, y: 96, w: 608, h: 308 });
  // Stopped and caught up to precise live render: no longer suppressed, stream plane is kept
  const head = { project: p, t: at(100), playing: false };
  pickForSetTime(head);
  noteSettled("front", ["glass"]);
  assert.deepEqual(suppressedAt(head), []);
  assert.deepEqual(streamPlanesAt(head), want);
  src.stop();
});

test("The online page changed the lower layer: the parent page stops sending the old stream on the spot; the online source receives the new project and drops that layer; once the layer table is replaced with a new row, it is pasted again", async () => {
  const p0 = project();
  const rk0 = RK(0xb1), rk1 = RK(0xb2);
  plan = heavy("glass");
  w.putStream(rk0, { clipIds: ["glass"], kind: "below", plane: "stage" });
  w.putMap([belowRow(p0, rk0)]);
  src.setProject("p1");
  src.setInputs(p0);
  src.focus(at(77), FPS);
  await w.settle(src);
  assert.equal(streamPlanesAt({ project: p0, t: at(77), playing: false }).length, 1);
  // Modify a lower-layer parameter. Parent page gets the new project in store; online source has not
  // received it yet (`setInputs` not called): parent page compares signatures itself, old stream is
  // not sent on the spot
  const p1 = project((q) => { q.tracks[2].clips[0].params = { speed: 2 }; return q; });
  assert.notEqual(sigOf(p1), sigOf(p0));
  for (const playing of [false, true]) {
    const head = { project: p1, t: at(77), playing };
    assert.deepEqual(planFeed(head).streamPlanes, [], `playing=${playing}`);
    assert.deepEqual(suppressedAt(head), ["glass"], "Handled like a heavy card without a stream: when paused and not settled it enters scrub, during playback it enters heavy");
    assert.deepEqual(snapshotFeedDebug(head).staleBelow, ["glass"]);
  }
  // Online source receives new project: that layer is withdrawn (ready range emits empty), manifest is
  // no longer provided
  src.setInputs(p1);
  assert.equal(src.streamPlane(rk0), null);
  assert.deepEqual(src.debug().staleStreams, ["glass"]);
  assert.deepEqual(planFeed({ project: p1, t: at(77), playing: true }).streamPlanes, []);
  // Changes to upper layers do not count: revert to p0's lower layer and only change title, old stream
  // is still pasted
  const p2 = project((q) => { q.tracks[0].clips[0].params = { text: "Changed title" }; return q; });
  src.setInputs(p2);
  assert.equal(streamPlanesAt({ project: p2, t: at(77), playing: true }).length, 1);
  // Splitter re-produces for the new version: layer table switches to a new row (new key, new signature)
  src.setInputs(p1);
  w.putStream(rk1, { clipIds: ["glass"], kind: "below", plane: "stage" });
  w.putMap([belowRow(p1, rk1)]);
  w.clock += LAYER_MAP_POLL_MS;
  await w.settle(src);
  assert.deepEqual(streamPlanesAt({ project: p1, t: at(77), playing: false }), [{ clipIds: ["glass"], key: rk1, ranges: READY, originFrame: 40, plane: "stage" }]);
  assert.deepEqual(suppressedAt({ project: p1, t: at(77), playing: false }), ["glass"]);
  src.stop();
});

test("Takes up decoder budget: six other single-card streams in the layer table rank ahead, so this card's stream exceeds the budget, no plane is sent and it stays suppressed as before", async () => {
  const extra = Array.from({ length: DECODER_BUDGET }, (_, i) => `x${i}`);
  const p = project((q) => { for (const id of extra) q.tracks.push({ id: `t-${id}`, name: id, clips: [card(id, 0, 10)] }); return q; });
  plan = heavy("glass", ...extra);
  const rk = RK(0xb1);
  extra.forEach((id, i) => w.putStream(RK(0xc0 + i), { clipIds: [id], kind: "card", plane: "local" }));
  w.putStream(rk, { clipIds: ["glass"], kind: "below", plane: "stage" });
  w.putMap([...extra.map((id, i) => cardRow(id, RK(0xc0 + i))), belowRow(p, rk)]);
  src.setProject("p1");
  src.setInputs(p);
  src.focus(at(77), FPS);
  await w.settle(src);
  const f = planFeed({ project: p, t: at(77), playing: false });
  assert.equal(f.streamPlanes.length, DECODER_BUDGET);
  assert.equal(f.streamPlanes.some((x) => x.clipIds[0] === "glass"), false);
  assert.ok(f.scrub.includes("glass"), "Has a stream, just over budget: still suppressed as before");
  // One fewer other stream: this card's enters the budget, carrying plane: stage
  plan = heavy("glass", ...extra.slice(1));
  const g = planFeed({ project: p, t: at(77), playing: false });
  assert.deepEqual(g.streamPlanes.find((x) => x.clipIds[0] === "glass"), { clipIds: ["glass"], key: rk, ranges: READY, originFrame: 40, plane: "stage" });
  src.stop();
});

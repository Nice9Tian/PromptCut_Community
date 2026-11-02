/**
 * Page side of browser node executing stream tasks (`docs/plan/browser-stream-task.md` parts 3 and 4):
 *
 *   BSN-01  Frame number conversion (`streamTaskFrames`): segment counts from first frame of this
 *     stream; project frame minus firstFrame; frames outside card range are sent fully transparent;
 *     last segment ends at last frame of this stream
 *   BSN-02  Capability bit streams reported by host; stream tasks claimed only if reported; once
 *     claimed, entire segment handed to host bakeStream, manifest expanded into task.complete
 *   BSN-03  Yield: host asks yielding() before each frame, releases once if returning { yielded }
 *     without counting as failure; yield after all done completes as usual
 *   BSN-04  Abort and lost claim: release immediately and abort on page hide; abort on lost claim,
 *     discard late results
 *   BSN-05  Host producing no stream (no bakeStream provided / streams falsy): capability bit is falsy,
 *     does not claim; identical to original node
 *   BSN-06  Parent page guard: pixels (bitmap + rectangle) in bake-frame event accepted by shape,
 *     dropped entirely if shape does not match
 *   BSN-07  Pixel-requesting rectangle (`pixelRect`) and patch-extracting SVG (`pixelsSvg`): no scaling,
 *     translated to top-left corner of rectangle; small-size SVG is verbatim identical to original
 *
 * Manifest shape and desktop adoption are in `server/test/browser-stream-manifest.test.mjs`; splitting
 * and filtering are in `server/test/browser-stream-split.test.mjs`.
 * Run: node --test src/online/browserStream.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserNode, streamTaskFrames, streamInputOf, YIELD_FRAME_MAX_MS, STREAM_SEGMENT_FRAMES } from "./browserNode.ts";
import { sanitizeStageEvent, STAGE_MESSAGE_LIMITS } from "./stageMessageGuard.ts";
import { pixelRect, pixelsSvg, smallSvg, PIXELS_MAX_SIDE } from "../render/bakeSmall.ts";
import { SEGMENT_FRAMES } from "../render/streamPlayer.ts";

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const FP = "aaaaaaaaaaaaaaaa";
const BOUND = { x: -32, y: -32, w: 464, h: 304 };
const streamInput = (extra = {}) => ({ kind: "card", plane: "local", clipIds: ["c"], fps: 30, bound: BOUND, offset: { x: 760, y: 420 }, firstFrame: 45, count: 120, total: 300, originFrame: 45, lastFrame: 164, ...extra });
const streamTask = ({ from = 3, to = 4, stream = {} } = {}) => ({
  id: `stream:rk:${from}-${to}`, kind: "stream", resultKey: "rk", range: { unit: "segment", from, to },
  source: { projectId: "p1", projectRev: 7, userId: "u@d" },
  input: { clipId: "c", cardId: "punch-pill", entryKey: null, contentKey: "ck", canvasHeavy: false, compositing: "independent",
    bake: { start: 1.5, end: 5.5, count: 120, sampling: { firstFrame: 45, phase: { numerator: 0, denominator: 1 } } }, stream: streamInput(stream) },
  weight: { class: "medium", frames: (to - from + 1) * 15 },
  requires: { envFingerprint: FP, codeVersion: "cv", cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false, capabilities: { streams: true } },
});

test("BSN-01 frame number conversion: segments count from the first frame of this stream; project frame minus firstFrame gives the local frame; a frame outside the card range is null (sent fully transparent); the last segment ends at the last frame of this stream", () => {
  assert.equal(STREAM_SEGMENT_FRAMES, SEGMENT_FRAMES, "segment frame count is the same number as the player's");
  // Card occupies project frames 45-164 (local 0-119), first frame of stream is 45: segment 0 =
  // project frames 45-59 = local 0-14
  const head = streamTaskFrames(streamTask({ from: 0, to: 1 }));
  assert.deepEqual(head.segments.map((s) => s.index), [0, 1]);
  assert.deepEqual(head.segments[0].frames, Array.from({ length: 15 }, (_, i) => i));
  assert.deepEqual(head.segments[1].frames, Array.from({ length: 15 }, (_, i) => 15 + i));
  assert.equal(head.frames, 30);
  // Segments 3 and 4 = project frames 90-119 = local 45-74 (when previously segmented by project
  // frame numbers, segment 3 was project frames 45-59)
  const mid = streamTaskFrames(streamTask({ from: 3, to: 4 }));
  assert.deepEqual(mid.segments.map((s) => s.index), [3, 4]);
  assert.deepEqual(mid.segments[0].frames, Array.from({ length: 15 }, (_, i) => 45 + i));
  assert.deepEqual(mid.segments[1].frames, Array.from({ length: 15 }, (_, i) => 60 + i));
  // Clip does not start on a frame multiple of 15, duration is not a multiple of 15: frames 100-149
  // total 50 frames → segments 0-3, every frame is within card range, final segment 5 frames
  const odd = streamTaskFrames(streamTask({ from: 0, to: 3, stream: { firstFrame: 100, originFrame: 100, count: 50, lastFrame: 149 } }));
  assert.deepEqual(odd.segments.map((s) => s.frames.length), [15, 15, 15, 5]);
  assert.deepEqual(odd.segments.flatMap((s) => s.frames), Array.from({ length: 50 }, (_, i) => i), "local frames 0-49, not one more and not one fewer, no fully transparent filler frames");
  assert.equal(odd.frames, 50);
  // First frame of stream is earlier than first frame of card (both are identical in single-card
  // streams; here only guarding "subtract as usual"): first 5 frames are not within card range
  const pad = streamTaskFrames(streamTask({ from: 0, to: 0, stream: { firstFrame: 50, originFrame: 45 } }));
  assert.deepEqual(pad.segments[0].frames, [null, null, null, null, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // Card has fewer frames than stream: local frames only go up to count - 1, followed by full transparency
  const tail = streamTaskFrames(streamTask({ from: 7, to: 7, stream: { count: 110 } }));   // Segment 7 = project frames 150-164 = local 105-119
  assert.deepEqual(tail.segments[0].frames, [105, 106, 107, 108, 109, null, null, null, null, null, null, null, null, null, null]);
  // Last frame of stream: last segment is not full (ends at frame 154 → segment 7 is project frames
  // 150-154, 5 frames total); project length has no effect
  const last = streamTaskFrames(streamTask({ from: 6, to: 7, stream: { lastFrame: 154, total: 9999 } }));
  assert.deepEqual(last.segments.map((s) => s.frames.length), [15, 5]);
  assert.deepEqual(last.segments[1].frames, [105, 106, 107, 108, 109]);
  assert.equal(last.frames, 20);
  // Task mismatch: whole segment is after last frame of this stream, not a browser-shaped stream
  // task, or range is incorrect
  assert.equal(streamTaskFrames(streamTask({ from: 8, to: 8 })), null);
  assert.equal(streamTaskFrames({ ...streamTask(), input: { clipId: "c" } }), null);
  assert.equal(streamTaskFrames({ ...streamTask(), range: null }), null);
  for (const bad of [{ kind: "group" }, { plane: "stage" }, { clipIds: ["a", "b"] }, { bound: { x: 0, y: 0, w: 463, h: 304 } }, { bound: null }, { fps: 0 }, { count: 0 }, { firstFrame: 1.5 }, { total: undefined }, { offset: null },
    // Missing first frame / last frame of this stream (task produced by splitter before segmentation
    // rule change): skip, do not guess using project frame 0
    { originFrame: undefined }, { originFrame: -1 }, { originFrame: 1.5 }, { lastFrame: undefined }, { lastFrame: 44 }]) {
    assert.equal(streamInputOf({ input: { stream: streamInput(bad) } }), null, JSON.stringify(bad));
  }
  // Negative firstFrame (card in point is before project start): first frame of stream is frame 0,
  // subtract as usual
  const neg = streamTaskFrames(streamTask({ from: 0, to: 0, stream: { firstFrame: -3, count: 10, originFrame: 0, lastFrame: 6 } }));
  assert.deepEqual(neg.segments[0].frames, [3, 4, 5, 6, 7, 8, 9]);
});

/**
 * One node + mock host. `streams`: whether the host currently reports it can encode streams;
 * each `bakeStream` call is recorded in `jobs`, and the test case determines what to return and when
 */
async function rig({ streams = true, withStream = true, task = streamTask() } = {}) {
  let t = 1_000_000;
  const sent = [], jobs = [], finished = [], ended = [];
  const state = { streams };
  const node = createBrowserNode({
    nodeId: "n", projectId: "p1", userId: "u@d", codeVersion: "cv", environment: { platform: "", userAgent: "", renderer: "", vendor: "" },
    now: () => t, isIdle: () => true, send: (m) => { sent.push(JSON.parse(JSON.stringify(m))); return true; },
    keptProject: () => ({ rev: 7 }), fetchSnapshot: async () => null,
    bakeFrame: async () => { throw new Error("a stream task must not take the per-frame generate snapshots path"); },
    finishTask: async () => { throw new Error("a stream task must not take the snapshot finishTask"); },
    streams: () => state.streams,
    ...(withStream ? {
      bakeStream: (job) => new Promise((resolve, reject) => jobs.push({ job, resolve, reject })),
      finishStream: async ({ task: tk, manifest }) => { finished.push({ id: tk.id, manifest }); return manifest; },
    } : {}),
    onTaskEnd: (tk, outcome) => ended.push(outcome),
  });
  node.start();
  node.receive({ type: "node.welcome", nodeId: "n", resumed: [], lost: [], envFingerprint: FP });
  node.receive({ type: "queue.snapshot", tasks: [{ ...task, state: "open", version: 1 }] });
  node.tick();
  const of = (type) => sent.filter((m) => m.type === type);
  const claim = async () => {
    node.receive({ type: "task.claimed", id: task.id, token: 5, version: 2, task: { ...task, state: "claimed", version: 2 } });
    await flush();
  };
  return { node, sent, jobs, finished, ended, state, task, of, claim, advance: (ms) => { t += ms; } };
}
const MANIFEST = { v: 1, kind: "stream", resultKey: "rk", range: { from: 3, to: 4 }, header: { kind: "card", plane: "local", clipIds: ["c"], fps: 30, originFrame: 45, bound: BOUND, offset: { x: 760, y: 420 }, tight: null },
  inits: { ["0".repeat(16)]: { hash: "0".repeat(64) } }, segments: { 3: { hash: "1".repeat(64) }, 4: { hash: "2".repeat(64) } } };

test("BSN-02 claims a stream task only if the host reports it can encode streams; hands the whole segment to bakeStream, reports progress per frame, and expands the manifest into task.complete", async () => {
  const r = await rig();
  assert.equal(r.node.debug().streams, true, "capability flag streams is true");
  assert.equal(r.of("node.hello")[0].capabilities.streams, true, "check-in carries the current capability flags");
  assert.equal(r.of("task.claim").length, 1, "claimed the stream task");
  await r.claim();
  assert.equal(r.jobs.length, 1, "bakeStream handed to the host");
  const { job } = r.jobs[0];
  assert.equal(job.task.id, r.task.id);
  assert.deepEqual(job.project, { rev: 7 }, "the project at that task's revision");
  assert.equal(job.yielding(), false);
  assert.equal(r.node.debug().state, "baking");
  assert.deepEqual(r.node.debug().holding.map((h) => [h.done, h.of]), [[0, 30]], "progress by frame count: 30 frames across two segments");
  job.progress(0);   // Host reports starting point before starting work (no segment left from previous claim)
  job.progress(7);
  job.progress(16);
  await flush();
  // When switching phases, arrangement reports an extra step with original frame count (work count),
  // so adjacent duplicates do not count: frame count will only be 0 → 7 → 16
  const reported = r.of("task.progress").map((m) => m.done).filter((d, i, a) => i === 0 || d !== a[i - 1]);
  assert.deepEqual(reported, [0, 7, 16], "reports 0 first, then follows the frame counts the host reports");
  assert.deepEqual(r.node.debug().holding.map((h) => [h.done, h.of]), [[16, 30]]);
  r.jobs[0].resolve({ manifest: MANIFEST });
  await flush();
  assert.deepEqual(r.finished.map((f) => f.id), [r.task.id], "write to the content store once all segments are in (finishStream)");
  const done = r.of("task.complete");
  assert.equal(done.length, 1);
  assert.equal(done[0].id, r.task.id);
  assert.equal(done[0].token, 5);
  const result = done[0].result ?? done[0];
  assert.equal(result.kind, "stream", `manifest expanded into the completion message: ${JSON.stringify(done[0]).slice(0, 300)}`);
  assert.deepEqual(result.header, MANIFEST.header);
  assert.deepEqual(Object.keys(result.segments), ["3", "4"]);
  assert.equal(r.of("task.fail").length + r.of("task.release").length, 0);
  assert.deepEqual(r.ended, ["completed"]);
  const c = r.node.debug().counters;
  assert.deepEqual([c.completed, c.streamTasks, c.streamFrames, c.bakedFrames], [1, 1, 16, 0]);
});

test("BSN-03 yield: when the host finishes the current frame it returns { yielded }, the node releases once without counting a failure; a yield that arrives after completion finishes as usual", async () => {
  for (const cause of ["play", "drag", "urgent"]) {
    const r = await rig();
    await r.claim();
    r.node.yieldFor(cause);
    assert.equal(r.jobs[0].job.yielding(), true, "the host learns it must yield before each frame");
    assert.equal(r.of("task.release").length, 0, "release only after the current frame is done");
    r.jobs[0].job.progress(4);
    r.jobs[0].resolve({ yielded: true });
    await flush();
    const rel = r.of("task.release");
    assert.equal(rel.length, 1, cause);
    assert.deepEqual([rel[0].id, rel[0].token, rel[0].reason], [r.task.id, 5, `yield-${cause}`]);
    assert.equal(r.of("task.fail").length + r.of("task.complete").length, 0);
    assert.deepEqual(r.node.debug().counters.released, { [`yield-${cause}`]: 1 });
    assert.equal(r.finished.length, 0);
  }
  // Host delays response after yield (this frame blocked in stage): aborts and releases immediately
  // when reaching the limit, same as snapshot tasks
  const stuck = await rig();
  await stuck.claim();
  stuck.node.yieldFor("play");
  stuck.advance(YIELD_FRAME_MAX_MS + 1);
  stuck.node.tick();
  await flush();
  assert.equal(stuck.of("task.release").length, 1);
  assert.equal(stuck.jobs[0].job.signal.aborted, true, "abort this segment on the host");
  stuck.jobs[0].resolve({ manifest: MANIFEST });
  await flush();
  assert.equal(stuck.of("task.complete").length, 0, "late results are dropped");
  // Host has actually finished everything when yield is requested: completes as usual (releasing
  // would only make the next claimer redo it)
  const late = await rig();
  await late.claim();
  late.node.yieldFor("play");
  late.jobs[0].resolve({ manifest: MANIFEST });
  await flush();
  assert.equal(late.of("task.complete").length, 1);
  assert.equal(late.of("task.release").length, 0);
});

test("BSN-04 page hidden: do not wait for the current frame, abort and release immediately; claim lost: abort, late results are dropped; host error: hand back as a retryable failure", async () => {
  const hidden = await rig();
  await hidden.claim();
  hidden.node.yieldFor("hidden");
  await flush();
  assert.deepEqual(hidden.of("task.release").map((m) => m.reason), ["yield-hidden"]);
  assert.equal(hidden.jobs[0].job.signal.aborted, true);
  hidden.jobs[0].resolve({ manifest: MANIFEST });
  await flush();
  assert.equal(hidden.of("task.complete").length, 0);

  const lost = await rig();
  await lost.claim();
  lost.node.receive({ type: "task.lease-lost", id: lost.task.id, token: 5, reason: "superseded" });
  await flush();
  assert.equal(lost.jobs[0].job.signal.aborted, true, "claim lost: abort this segment");
  lost.jobs[0].resolve({ manifest: MANIFEST });
  await flush();
  assert.equal(lost.of("task.complete").length + lost.of("task.release").length + lost.of("task.fail").length, 0, "claim lost, nothing more is sent");
  assert.equal(lost.node.debug().counters.lost, 1);

  const broken = await rig();
  await broken.claim();
  broken.jobs[0].reject(Object.assign(new Error("pushing segment returned 503"), { retryable: true }));
  await flush();
  const fail = broken.of("task.fail");
  assert.equal(fail.length, 1);
  assert.equal(fail[0].retryable, true);
  const final = await rig();
  await final.claim();
  final.jobs[0].reject(Object.assign(new Error("task has no input.stream"), { retryable: false }));
  await flush();
  assert.equal(final.of("task.fail")[0].retryable, false);
});

test("BSN-05 host that does not produce streams: capability flag is false, does not claim stream tasks; claims only after an encoder is probed", async () => {
  const none = await rig({ withStream: false });
  assert.equal(none.node.debug().streams, false, "no bakeStream given: does not produce streams");
  assert.equal(none.of("node.hello")[0].capabilities.streams, false);
  assert.equal(none.of("task.claim").length, 0);
  assert.deepEqual(none.node.debug().counters.blocked, { "2:streams": 1 }, "blocked by node-side filter rule 2");

  const later = await rig({ streams: false });
  assert.equal(later.of("task.claim").length, 0, "host has not probed an encoder yet");
  later.state.streams = true;
  later.advance(5000);
  later.node.tick();
  assert.equal(later.node.debug().streams, true);
  assert.equal(later.of("task.claim").length, 1, "probed: claims on the next beat");
});

/* ------------------------------------------------------------------ Parent page guard */

test("BSN-06 parent page guard: bake-frame pixels are accepted by shape (a real bitmap, size matches the rect, rect is integers and width and height are even); an event with the wrong shape is dropped entirely", () => {
  const HASH = "a".repeat(64);
  const base = { type: "bake-frame", session: "s1", clipId: "c1", localFrame: 3, hash: HASH, bytes: 100 };
  const had = globalThis.ImageBitmap;
  class FakeBitmap { constructor(w, h) { this.width = w; this.height = h; } }
  try {
    globalThis.ImageBitmap = FakeBitmap;
    const bitmap = new FakeBitmap(464, 304);
    const clean = sanitizeStageEvent({ ...base, pixels: { rect: BOUND, bitmap, extra: 1 } });
    assert.ok(clean, "the right shape is accepted");
    assert.equal(clean.pixels.bitmap, bitmap, "bitmap is passed to the caller as is");
    assert.deepEqual(clean.pixels.rect, BOUND);
    assert.deepEqual(Object.keys(clean.pixels).sort(), ["bitmap", "rect"], "keeps only recognized fields");
    assert.equal("htmlGz" in clean || "htmlRaw" in clean, false, "an event that needs only pixels may omit the HTML bytes");
    assert.equal(sanitizeStageEvent({ ...base, pixels: null }).pixels, null);
    assert.equal("pixels" in sanitizeStageEvent(base), false, "an event without pixels is the same as before");
    const bad = [
      { rect: BOUND, bitmap: { width: 464, height: 304 } },                    // Not a bitmap
      { rect: BOUND, bitmap: new FakeBitmap(464, 300) },                       // Size does not match rectangle
      { rect: { ...BOUND, w: 463 }, bitmap: new FakeBitmap(463, 304) },        // Width is not even
      { rect: { ...BOUND, x: 0.5 }, bitmap },                                  // Not an integer
      { rect: { ...BOUND, x: -1e9 }, bitmap },                                 // Invalid coordinates
      { rect: { x: 0, y: 0, w: STAGE_MESSAGE_LIMITS.maxPixelSide + 2, h: 304 }, bitmap: new FakeBitmap(STAGE_MESSAGE_LIMITS.maxPixelSide + 2, 304) },
      { rect: null, bitmap },
      { bitmap },
      "pixels",
    ];
    for (const pixels of bad) assert.equal(sanitizeStageEvent({ ...base, pixels }), null, JSON.stringify(pixels)?.slice(0, 80));
  } finally {
    if (had === undefined) delete globalThis.ImageBitmap; else globalThis.ImageBitmap = had;
  }
  // No ImageBitmap in runtime environment (Node): events with pixels are rejected without exception
  if (typeof globalThis.ImageBitmap === "undefined") assert.equal(sanitizeStageEvent({ ...base, pixels: { rect: BOUND, bitmap: {} } }), null);
});

/* ------------------------------------------------------------------ Pixel-requesting rectangle and SVG */

test("BSN-07 pixel rect: integers, even width and height, within the limit; a cropped SVG is not scaled and is translated to the rect's top-left; a small SVG is unchanged verbatim", () => {
  assert.deepEqual(pixelRect(BOUND), BOUND);
  assert.notEqual(pixelRect(BOUND), BOUND, "returns a new object");
  assert.deepEqual(pixelRect({ x: 0, y: 0, w: 1920, h: 1080, more: 1 }), { x: 0, y: 0, w: 1920, h: 1080 });
  for (const bad of [null, "r", {}, { ...BOUND, w: 463 }, { ...BOUND, h: 0 }, { ...BOUND, x: 1.5 }, { ...BOUND, w: PIXELS_MAX_SIDE + 2 }, { ...BOUND, y: -PIXELS_MAX_SIDE - 1 }, { ...BOUND, w: "464" }]) {
    assert.equal(pixelRect(bad), null, JSON.stringify(bad));
  }
  assert.equal(PIXELS_MAX_SIDE, STAGE_MESSAGE_LIMITS.maxPixelSide, "the stage and the parent page guard use the same limit");
  // SVG construction requires DOM (template, XMLSerializer): provide a bare-minimum stand-in
  const had = globalThis.XMLSerializer;
  globalThis.XMLSerializer = class { serializeToString(n) { return n.text; } };
  const doc = { createElement: () => ({ set innerHTML(v) { this.html = v; }, get content() { const html = this.html; return { querySelectorAll: () => [], childNodes: [{ text: html }] }; } }) };
  try {
    const svg = pixelsSvg(doc, { html: "<b>x</b>", boxWidth: 400, boxHeight: 240, rect: BOUND, css: ".a{}" });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="464" height="304">/, "image size = rect size");
    assert.match(svg, /left:32px;top:32px;width:400px;height:240px;transform:scale\(1\)/, "box moves to (-x, -y), no scaling");
    assert.match(svg, /<style><!\[CDATA\[\.a\{\}\]\]><\/style>/, "inlines the page stylesheet");
    const flush0 = pixelsSvg(doc, { html: "<b>x</b>", boxWidth: 1920, boxHeight: 1080, rect: { x: 0, y: 0, w: 1920, h: 1080 } });
    assert.match(flush0, /left:0;top:0;width:1920px;height:1080px;transform:scale\(1\)/, "rect starts at the origin: no translation");
    // Small size: verbatim identical to construction before change (box always at top-left)
    const small = smallSvg(doc, { html: "<b>x</b>", boxWidth: 400, boxHeight: 240, scale: 0.5, width: 200, height: 120, css: "" });
    assert.equal(small, '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><foreignObject x="0" y="0" width="200" height="120">'
      + '<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:200px;height:120px;overflow:hidden">'
      + '<div style="position:absolute;left:0;top:0;width:400px;height:240px;transform:scale(0.5);transform-origin:0 0;isolation:isolate;overflow:visible">'
      + '<div style="position:absolute;inset:0"><b>x</b></div></div></div></foreignObject></svg>');
  } finally {
    if (had === undefined) delete globalThis.XMLSerializer; else globalThis.XMLSerializer = had;
  }
});

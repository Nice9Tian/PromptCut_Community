/**
 * Online browser export is split into "quick export" and "full export" (semantics
 * `docs/semantics/product/platforms.md` "Export" under "Online browser"): pure logic on the page side.
 * Run: node --test src/export/exportModes.test.mjs
 *
 *   XM-01 How each card is produced (`cardLayers.planCardLayers`): full export ignores streams;
 *         cards executable on this page use live render, cards not executed on this page all request
 *         render nodes; quick export only recognizes full-density segments: for cards with streams
 *         across the entire segment, the export page does not mount components; for cards with
 *         streams in only a portion, live render as usual and paste streams on frames that have
 *         streams; for cards not executed on this page, fetch streams on frames with streams, and
 *         request render nodes for the rest
 *   XM-02 Which one to pick for this frame (`layerChoiceAt`): stream → bitmap → live render; sparse
 *         segments are not picked
 *   XM-03 Manifest plan only for export (`exportFrames.exportPlanTask`): queue inbound validation
 *         accepts it; it is not the same task as the usual manifest plan
 *   XM-04 Request render nodes and wait until all arrive (`requestExportFrames`): report "no nodes"
 *         when claimed by nobody; fetch manifest once index arrives; return only when all have
 *         arrived; fetch PNG frame by frame
 *   XM-05 Node says it cannot produce, task failed, or rendered version is not this version: each
 *         throws an explanatory error, producing nothing half-done
 *   XM-06 Compositing top and bottom halves of a stream frame (`streamFrames.composeHalves`): clamp
 *         premultiplied color within opacity and divide back; zero out fully transparent pixels
 *   XM-07 How to read stream manifest (`readStreamManifest`): only accept segments within range and
 *         with matching shape
 *   XM-08 Rules for pasting into snapshots (`frameCompositor.pasteLayer`) are verified by probes in
 *         a real browser (no DOM here)
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInbound, isClipsPlan } from "../../server/render-queue/messages.mjs";

const L = await import(srcUrl("export/cardLayers.ts"));
const F = await import(srcUrl("export/exportFrames.ts"));
const S = await import(srcUrl("export/streamFrames.ts"));
const P = await import(srcUrl("online/planPublisher.ts"));
const T = await import(srcUrl("export/text.ts"));
const R = await import(srcUrl("kernel/registry.ts"));

const FPS = 30;
/** Full-density segment table: segment number → sample count */
const dense = (...segs) => new Map(segs.map((n) => [n, 15]));
const clip = (id, start, end, cardId = "card") => ({ id, start, end, cardId });

test("XM-01 How each card is produced", () => {
  // a: frames 12~71 (60 frames, 4 segments); b and s have the same length
  const clips = [clip("a", 0.4, 2.4), clip("b", 0.4, 2.4), clip("s", 0.4, 2.4), clip("light", 0, 3), { id: "video", start: 0, end: 3 }];
  assert.deepEqual(L.clipFrameWindow(clips[0], FPS, 90), { first: 12, last: 71 });
  const streams = [
    { clipId: "a", plane: "local", resultKey: "ka", originFrame: 12, dense: dense(0, 1, 2, 3) },
    { clipId: "b", plane: "local", resultKey: "kb", originFrame: 12, dense: dense(0, 2) },          // Segments 1 and 3 only have sparse versions
    { clipId: "s", plane: "local", resultKey: "ks", originFrame: 12, dense: dense(0, 1) },
    { clipId: "s", plane: "local", resultKey: "ks-other", originFrame: 12, dense: dense(0) },        // Another one with fewer full-density segments: not selected
  ];
  const nonRunnable = new Set(["s"]);
  const full = L.planCardLayers({ clips, fps: FPS, total: 90, mode: "full", nonRunnable, streams });
  assert.equal(full.streamOf.size, 0, "Full export does not fetch streams");
  assert.deepEqual(full.wrapperOnly, ["s"]);
  assert.deepEqual(full.needFrames, ["s"]);
  assert.equal(full.nodeFrames, 60);
  const fast = L.planCardLayers({ clips, fps: FPS, total: 90, mode: "fast", nonRunnable, streams });
  assert.deepEqual([...fast.streamOf.keys()].sort(), ["a", "b", "s"]);
  assert.equal(fast.streamOf.get("s").resultKey, "ks");
  assert.deepEqual(fast.wrapperOnly.sort(), ["a", "s"], "For a card with a full-density stream over its whole range, the export page does not mount the component; for one with a stream over only part of it, live render continues as before");
  assert.deepEqual(fast.needFrames, ["s"], "A card this page does not execute that is not fully covered by a full-density stream: ask a render node");
  assert.equal(fast.streamFrames, 60 + 30 + 30);
  assert.equal(fast.nodeFrames, 30);
  // Cards not executed on this page have full-density streams across the whole segment: no need to request render nodes
  const covered = L.planCardLayers({ clips: [clips[2]], fps: FPS, total: 90, mode: "fast", nonRunnable, streams: [{ ...streams[2], dense: dense(0, 1, 2, 3) }] });
  assert.deepEqual(covered.needFrames, []);
  assert.deepEqual(covered.wrapperOnly, ["s"]);
  // Last segment has fewer than 15 frames: frames beyond sample count do not count as covered
  const short = { clipId: "a", plane: "local", resultKey: "ka", originFrame: 12, dense: new Map([[0, 15], [1, 5]]) };
  assert.equal(L.streamCovers(short, 31), true);
  assert.equal(L.streamCovers(short, 32), false);
  assert.equal(L.streamCovers(short, 11), false, "Before the first frame of this stream");
});

test("XM-02 Which source this frame takes", () => {
  const clips = [clip("b", 0.4, 2.4), clip("s", 0.4, 2.4)];
  const nonRunnable = new Set(["s"]);
  const streams = [
    { clipId: "b", plane: "local", resultKey: "kb", originFrame: 12, dense: dense(0, 2) },
    { clipId: "s", plane: "local", resultKey: "ks", originFrame: 12, dense: dense(0, 1) },
  ];
  const plan = L.planCardLayers({ clips, fps: FPS, total: 90, mode: "fast", nonRunnable, streams });
  const frames = new Map([["s", { clipId: "s", plane: "local", rect: { x: 0, y: 0, w: 4, h: 4 }, frames: new Set(Array.from({ length: 60 }, (_, i) => 12 + i)) }]]);
  assert.equal(L.layerChoiceAt(plan, "b", 12, frames, nonRunnable).from, "stream");
  assert.equal(L.layerChoiceAt(plan, "b", 27, frames, nonRunnable).from, "live", "This range has only the sparse version: this page renders frame by frame and does not substitute the sparse version");
  assert.equal(L.layerChoiceAt(plan, "b", 42, frames, nonRunnable).from, "stream", "At the junction: the next range has full density, so take the stream again");
  assert.equal(L.layerChoiceAt(plan, "s", 41, frames, nonRunnable).from, "stream");
  assert.equal(L.layerChoiceAt(plan, "s", 42, frames, nonRunnable).from, "frames", "For a frame of a card this page does not execute that has no stream, take the render node's bitmap");
  assert.equal(L.layerChoiceAt(plan, "s", 80, frames, nonRunnable).from, "missing");
  assert.equal(L.layerChoiceAt(plan, "other", 20, frames, nonRunnable).from, "live");
});

test("XM-03 Export-only manifest plan: the queue accepts it, and it is not the same task as the usual one", () => {
  const task = F.exportPlanTask({ projectId: "proj-1", projectRev: 7, clips: ["c2", "c1", "c2"], codeVersion: "cv-1" });
  assert.deepEqual(task.input, { clips: ["c1", "c2"], exportOnly: true });
  assert.deepEqual(task.requires, { codeVersion: "cv-1" });
  assert.equal(task.priority, 70, "Ranked ahead of all fine-grained tasks (the integer rank is still the normal tier)");
  const parsed = parseInbound({ type: "task.publish", tasks: [task] });
  assert.equal(parsed.ok, true, parsed.detail);
  assert.equal(parsed.body.tasks[0].input.exportOnly, true);
  assert.ok(isClipsPlan(parsed.body.tasks[0]));
  const normal = P.clipsPlanTask({ projectId: "proj-1", projectRev: 7, clips: ["c1", "c2"], codeVersion: "cv-1" });
  assert.notEqual(task.id, normal.id, "One extra segment in the signature: the same manifest is also a different task");
  assert.equal(F.exportPlanTask({ projectId: "proj-1", projectRev: 7, clips: ["c1", "c2"] }).id, F.exportPlanTask({ projectId: "proj-1", projectRev: 7, clips: ["c2", "c1"] }).id);
});

const RK = "a".repeat(64);
const hashOf = (n) => n.toString(16).padStart(64, "0");
/** A mock document service + asset service: queue events are pushed manually by tests */
function fakeService({ project }) {
  const listeners = new Set();
  const manifests = new Map();
  const log = [];
  let state = "open";
  const deps = {
    publisherId: "page-test",
    codeVersion: null,
    async request(msg) {
      log.push(msg.type === "content.get" ? `get ${msg.key}` : msg.type);
      if (msg.type === "publisher.hello") return { type: "publisher.welcome" };
      if (msg.type === "task.publish") return { type: "task.published", results: [{ id: msg.tasks[0].id, state }] };
      if (msg.type === "content.get") { const body = manifests.get(msg.key); return body ? { type: "content.item", body } : { type: "content.item", missing: true }; }
      return { type: "error" };
    },
    subscribeQueue(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    assetBase: () => "https://asset.test/api/asset",
    authHeaders: async () => ({ Authorization: "Bearer t" }),
    fetch: async (url) => {
      log.push(`fetch ${String(url).split("/").pop().slice(-4)}`);
      return new Response(new Uint8Array([137, 80, 78, 71, Number.parseInt(String(url).slice(-2), 16)]));
    },
    sleep: async (_ms, signal) => { if (signal.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true }); await new Promise((r) => setImmediate(r)); await hooks.onSleep?.(); },
  };
  const hooks = { onSleep: null };
  return { deps, log, manifests, hooks, emit: (msg) => { for (const l of [...listeners]) l(msg); }, setState: (s) => { state = s; }, project, listeners };
}
const manifestOf = (from, to, origin, last) => {
  const frames = [];
  for (let f = origin + from * 15; f <= Math.min(last, origin + (to + 1) * 15 - 1); f++) frames.push([f, hashOf(f), 100]);
  return { v: 1, kind: "export-frames", resultKey: RK, range: { from, to }, header: {}, frames };
};
const indexOf = (over = {}) => ({ v: 1, projectRev: 7, unsupported: [], streams: [{ clipId: "s", kind: "card", plane: "local", resultKey: RK, envFingerprint: "f".repeat(16),
  originFrame: 12, lastFrame: 143, lastSegment: 8, segmentsPerTask: 8, fps: 30, rect: { x: -32, y: -32, w: 704, h: 424 }, offset: { x: 0, y: 0 }, inputSig: "s1-abc" }], ...over });

test("XM-04 Ask render nodes, wait until everything arrives, fetch by frame", async () => {
  F.resetExportRetry();
  const svc = fakeService({ project: {} });
  const statuses = [];
  const task = F.exportPlanTask({ projectId: "p1", projectRev: 7, clips: ["s"] });
  let step = 0;
  svc.hooks.onSleep = async () => {
    step++;
    // Round 1: claimed by nobody. Round 2: node accepted. Round 3: plan completed (index arrived),
    // manifest not yet. Round 4: first manifest arrives. Round 5: second arrives
    if (step === 1) svc.setState("claimed");
    if (step === 2) { svc.setState("done"); svc.emit({ type: "task.done", id: task.id, result: { ranges: null, derived: [], exportIndex: indexOf() } }); }
    if (step === 3) svc.manifests.set(`${RK}:0-7`, manifestOf(0, 7, 12, 143));
    if (step === 4) svc.manifests.set(`${RK}:8-8`, manifestOf(8, 8, 12, 143));
  };
  const got = await F.requestExportFrames({ projectId: "p1", projectRev: 7, project: {}, clips: ["s"], deps: svc.deps, signal: new AbortController().signal, onStatus: (s) => statuses.push(s) });
  assert.deepEqual(statuses.map((s) => s.phase), ["publishing", "no-node", "planning", "rendering", "rendering"]);
  assert.deepEqual(statuses[3], { phase: "rendering", clips: 1, done: 0, total: 132 });
  assert.deepEqual(statuses[4], { phase: "rendering", clips: 1, done: 120, total: 132 });
  const cov = got.coverage.get("s");
  assert.equal(cov.frames.size, 132);
  assert.deepEqual(cov.rect, { x: -32, y: -32, w: 704, h: 424 });
  assert.equal(cov.plane, "local");
  const url = await got.dataUrl("s", 20);
  assert.match(url, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(url.split(",")[1], "base64")[4], 0x14, "Fetched the piece for frame 20");
  assert.equal(got.stats.fetched, 1);
  await assert.rejects(got.dataUrl("s", 200));
  assert.equal(svc.listeners.size, 0, "Unsubscribed from queue events");
  assert.equal(svc.log.filter((x) => x === "publisher.hello").length, 1);
  assert.equal(svc.log.filter((x) => x === "task.publish").length, 2, "If the index has not arrived, republish after a short wait: ask for the status and request the completion notice again");
});

test("XM-05 Cannot be produced, failed, not this version: each stops and explains why", async () => {
  const run = async (prepare) => {
    F.resetExportRetry();
    const svc = fakeService({ project: {} });
    const task = F.exportPlanTask({ projectId: "p1", projectRev: 7, clips: ["s"] });
    let step = 0;
    svc.hooks.onSleep = async () => { step++; await prepare(svc, task, step); };
    return F.requestExportFrames({ projectId: "p1", projectRev: 7, project: svc.project, clips: ["s"], deps: svc.deps, signal: new AbortController().signal });
  };
  const done = (svc, task, index) => svc.emit({ type: "task.done", id: task.id, result: { exportIndex: index } });
  // Node says this card cannot be produced
  await assert.rejects(run((svc, task, step) => { if (step === 1) done(svc, task, { v: 1, streams: [], unsupported: [{ clipId: "s", reason: "no-card" }] }); }),
    (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeCannot(1, "no-card") && /does not have the code for this card/.test(e.message));
  // Plan itself failed
  await assert.rejects(run((svc, task, step) => { if (step === 1) svc.emit({ type: "task.failed", id: task.id, error: "bad-snapshot" }); }),
    (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeFailed("bad-snapshot"));
  // A certain segment's bitmap task completely failed
  await assert.rejects(run((svc, task, step) => {
    if (step === 1) done(svc, task, indexOf());
    if (step === 2) svc.emit({ type: "task.failed", id: `stream:${RK}:0-7`, error: "export-frames-failed" });
  }), (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeFailed("export-frames-failed"));
  // Project moved forward; this content was invalidated
  await assert.rejects(run((svc, task, step) => {
    if (step === 1) done(svc, task, indexOf());
    if (step === 2) svc.emit({ type: "task.failed", id: `stream:${RK}:8-8`, error: "superseded" });
  }), (e) => e.message === T.ONLINE_EXPORT_TEXT.projectChanged);
  // Ignore failures of other stream tasks (not requested by this export)
  const ok = await run((svc, task, step) => {
    if (step === 1) { done(svc, task, indexOf({ streams: [{ ...indexOf().streams[0], lastFrame: 20, lastSegment: 0 }] })); svc.emit({ type: "task.failed", id: `stream:${"b".repeat(64)}:0-7`, error: "x" }); }
    if (step === 2) svc.manifests.set(`${RK}:0-0`, manifestOf(0, 0, 12, 20));
  });
  assert.equal(ok.coverage.get("s").frames.size, 9);
  // Cancel
  F.resetExportRetry();
  const svc = fakeService({ project: {} });
  const ac = new AbortController();
  svc.hooks.onSleep = async () => { ac.abort(); };
  await assert.rejects(F.requestExportFrames({ projectId: "p1", projectRev: 7, project: {}, clips: ["s"], deps: svc.deps, signal: ac.signal }), (e) => e.cancelled === true);
  // Skip entries with incorrect index shapes
  assert.equal(F.parseExportIndex({ streams: [{ clipId: "s" }, indexOf().streams[0]], unsupported: [{ clipId: "x" }] }).streams.length, 1);
  assert.equal(F.parseExportIndex(null), null);
  assert.deepEqual(F.exportSpans({ lastSegment: 8, segmentsPerTask: 8 }), [[0, 7], [8, 8]]);
});

test("XM-06 A stream frame composed from its top and bottom halves", () => {
  // Width 2, color half-region height 2; full frame height = 2 × 2 + 16 = 20; opacity starts from row 2 + 8 = 10
  const w = 2, h = 2, total = 2 * h + 16;
  const raw = new Uint8ClampedArray(w * total * 4);
  const px = (x, y, r, g, b) => { const o = (y * w + x) * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255; };
  px(0, 0, 100, 50, 0); px(0, 10, 200, 200, 200);    // Premultiplied (100, 50, 0), opacity 200 → straight (128, 64, 0)
  px(1, 0, 255, 10, 10); px(1, 10, 40, 40, 40);      // Color greater than opacity (encoding noise): clamp to 40 first → (255, 64, 64)
  px(0, 1, 90, 90, 90); px(0, 11, 0, 0, 0);          // Fully transparent: zero out
  px(1, 1, 255, 255, 255); px(1, 11, 255, 255, 255); // Opaque white
  const out = S.composeHalves(raw, w, total, h);
  assert.deepEqual([...out.subarray(0, 4)], [128, 64, 0, 200]);
  assert.deepEqual([...out.subarray(4, 8)], [255, 64, 64, 40]);
  assert.deepEqual([...out.subarray(8, 12)], [0, 0, 0, 0]);
  assert.deepEqual([...out.subarray(12, 16)], [255, 255, 255, 255]);
  assert.throws(() => S.composeHalves(raw, w, 10, h), /cannot fit two halves/);
  assert.equal(S.HALF_GAP_ROWS, 8);
});

test("XM-07 How stream manifests are read", () => {
  const init = "0123456789abcdef";
  const body = { kind: "stream", resultKey: RK, header: { fps: 30 },
    inits: { [init]: { hash: hashOf(1), rect: { x: 0, y: 0, w: 64, h: 32 } }, bad: { hash: "x", rect: null } },
    segments: { 0: { hash: hashOf(2), init, stride: 1, samples: 15 }, 1: { hash: hashOf(3), init, stride: 15, samples: 15 }, 2: { hash: hashOf(4), init: "missing", stride: 1, samples: 15 },
      9: { hash: hashOf(5), init, stride: 1, samples: 15 } } };
  const got = S.readStreamManifest(body, RK, [0, 7]);
  assert.equal(got.fps, 30);
  assert.deepEqual([...got.segments.keys()], [0, 1], "Those out of range and those whose head file is missing are not accepted");
  assert.equal(got.segments.get(1).stride, 15);
  assert.deepEqual(got.inits.get(init).rect, { x: 0, y: 0, w: 64, h: 32 });
  assert.equal(S.readStreamManifest({ ...body, resultKey: "other" }, RK, [0, 7]), null);
  assert.equal(S.readStreamManifest({ ...body, kind: "export-frames" }, RK, [0, 7]), null);
  assert.equal(S.readStreamManifest(null, RK, [0, 7]), null);
});

test("XM-08 Online export runnable-card check and nonRunnableClips: ready synced cards render live, cards in an error state wait for a node", () => {
  R.resetRuntimeCardsForTest();
  R.registerCards([{ id: "builtin-card", name: "Builtin Card" }]);
  // Simulate synced card
  R.setSyncedUserCards([
    { id: "synced-ready", name: "Ready Card" },
    { id: "synced-bad", name: "Bad Card" },
  ]);
  R.setCardRunStates({
    "synced-ready": { state: "ready" },
    "synced-bad": { state: "unsupported-syntax", detail: "SyntaxError" },
  });
  assert.equal(L.isCardRunnable("builtin-card"), true, "Built-in cards are always runnable");
  assert.equal(L.isCardRunnable("synced-ready"), true, "A synced user card whose run state is ready is runnable");
  assert.equal(L.isCardRunnable("synced-bad"), false, "One whose run state is unsupported-syntax is not runnable");
  assert.equal(L.isCardRunnable("unknown-card"), false, "An unknown card is not runnable");

  const p = {
    width: 1280, height: 720, fps: 30, duration: 3,
    tracks: [
      { id: "t1", clips: [
        { id: "c1", cardId: "builtin-card", start: 0, end: 1 },
        { id: "c2", cardId: "synced-ready", start: 1, end: 2 },
        { id: "c3", cardId: "synced-bad", start: 2, end: 3 },
        { id: "c4", cardId: "unknown-card", start: 0, end: 2 },
        { id: "c5", start: 0, end: 3 }, // Media clip (no cardId)
      ] },
    ],
  };
  const nonRunnable = L.nonRunnableClips(p);
  assert.deepEqual(nonRunnable.sort(), ["c3", "c4"].sort(), "Only cards that truly cannot run in the browser go into nonRunnableClips");
  R.resetRuntimeCardsForTest();
  R.resetCards();
});


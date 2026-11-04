/**
 * Stream production arrangement for this page (`pageStreams.ts`, task brief
 * `docs/plan/render-refactor-task.md` "Jia-2"): when it is this page's turn to produce, check first,
 * yield, stop, layer table.
 *
 *   PS-01  Plan sent and unclaimed: wait full PAGE_STREAM_WAIT_MS before acting; check first,
 *          write own row into layer table, then produce; tell host to recognize result key once done
 *   PS-02  Node capable of splitting takes the job (plan is claimed / done): do not produce; stop
 *          querying queue once done
 *   PS-03  Check first: own key already exists → do not produce; another playable stream already
 *          in layer table (same content key, or different content key with unexpired input signature)
 *          → do not produce, recognize candidate's key; rows with expired input signatures (streams
 *          with old parameters) do not count
 *   PS-04  Yield: playback, scrub, more urgent jobs: stop after finishing current frame, resume when
 *          idle; abort immediately on page hide; abort if current frame takes > 1s after yielding
 *   PS-05  Splitter takes job midway through production: stop after current frame, do not start anew
 *   PS-06  Produced elsewhere midway through production: stop, switch to existing output
 *   PS-07  Do not start unless idle; do nothing if not a node (cannot produce); abort in-progress
 *          work immediately when plan is updated
 *   PS-08  Layer table: write before starting; rewrite if this page's row is overwritten by others;
 *          stop writing after a splitter takes the job
 *   PS-09  Entry point: number of passes and density of each pass defined by passes (when sparse then
 *          full density, complete the sparse pass for every stream first)
 *   PS-10  Failure: retry after backoff, abandon this segment after consecutive failures; stop querying
 *          queue when no jobs remain
 *   PS-11  When this page's row is overwritten by another layer table writer that finished producing
 *          entirely: do not write back (avoid overwriting back and forth)
 *   PS-12  Default two passes: sparse then full density; sparse tasks are sparse stream tasks (id ends
 *          with `:sparse`); full density starts only after sparse settles (full density waits while
 *          sparse is in backoff); check first recognizes density for current pass (sparse pass accepts
 *          either version, full density pass requires full density)
 *   PS-13  Produce sparse version during measurement (`measure()`): do not wait for manifest plan,
 *          do not check for splitters; check first, write layer table, produce, recognize; do not
 *          produce if already exists; run only sparse pass
 *   PS-14  Overlay waits for sparse version at most MEASURE_SPARSE_MAX_MS: counted from first call
 *          this round, returns immediately upon timeout, in-production work stops after current frame
 *          (abort if delayed), subsequent calls this round return immediately; clock resets on new round
 *   PS-15  Measurement accounting is retained until manifest plan is issued; replaced with plan once
 *          issued, sparse version produced during measurement is found and not re-produced, followed
 *          by catching up full density
 *   PS-16  This page not yet a node during measurement: wait MEASURE_READY_WAIT_MS, produce normally
 *          if ready, return incapable (treated as idle) if not
 *   PS-17  isConfigSupported passes when only producing sparse version for this page (mobile identity,
 *          only one stage): produce sparse version only, not full density
 *   PS-18  isConfigSupported returns unsupported when only producing sparse version for this page:
 *          stop production and roll back
 *   PS-19  Three consecutive encoding errors when only producing sparse version for this page:
 *          stop production and roll back
 *
 * Run: npm test -- src/online/pageStreams.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPageStreams, PAGE_STREAM_WAIT_MS, PAGE_STREAM_POLL_MS, PAGE_STREAM_RECHECK_MS, PAGE_STREAM_ROWS_MS, PAGE_STREAM_ATTEMPTS,
  PAGE_STREAM_PASSES, MEASURE_SPARSE_MAX_MS, MEASURE_READY_WAIT_MS } from "./pageStreams.ts";
import { YIELD_FRAME_MAX_MS } from "./browserNode.ts";

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const FP = "2222222222222222";
const PROJECT = { id: "proj", fps: 30, width: 1920, height: 1080, tracks: [{ id: "t", clips: [{ id: "clip-a", cardId: "punch-pill", start: 0, end: 4 }, { id: "clip-b", cardId: "focus-card", start: 4, end: 5 }] }] };
/**
 * Plan for a single-card stream: clip starts from frame `startFrame` of the project, with
 * `segments` full segments in total. Segments count from the first frame of this stream itself
 * (`originFrame` = `startFrame`), so `firstSegment` is always 0, `lastSegment` = `segments - 1`.
 */
const specOf = (clipId, contentKey, startFrame, segments) => ({
  kind: "card", plane: "local", clipIds: [clipId], topClipId: clipId, cardId: "punch-pill", contentKey, streamKey: `rk-${contentKey}`, envFingerprint: FP,
  fps: 30, stage: { width: 1920, height: 1080 }, total: 300, firstFrame: startFrame, lastFrame: startFrame + segments * 15 - 1, originFrame: startFrame, firstSegment: 0, lastSegment: segments - 1,
  offset: { x: 0, y: 0 }, bound: { x: 0, y: 0, w: 640, h: 360 }, compositing: "independent",
  bake: { start: startFrame / 30, end: (startFrame + segments * 15) / 30, count: segments * 15, sampling: { firstFrame: startFrame, fps: { numerator: "30", denominator: "1" }, phase: { numerator: "0", denominator: "1" } } },
});
const PLAN = { id: "plan:proj@7#clips:x", projectId: "proj", projectRev: 7, clips: ["clip-a", "clip-b"], at: 1000 };

/** A fake host: fake clock, queue state, content store (layer table and manifest), jobs to produce a segment */
function rig(over = {}) {
  const w = {
    now: 1000, idle: true, capable: true, plan: PLAN, state: "open",
    specs: [specOf("clip-a", "ka", 0, 10), specOf("clip-b", "kb", 120, 2)],
    /** Result key → range of existing manifests (`from-to`) */
    present: new Set(), layerMap: null, written: [], alive: [], produced: [], probes: 0, specCalls: 0,
    /** Segment in production: manually released in tests */
    current: null, readFails: false, lookups: [],
  };
  const has = (key, need) => w.present.has(key) || (need?.dense === false && w.present.has(`${key}#sparse`));
  const deps = {
    // Older items (PS-01 to PS-11) only consider full-density pass; order of the two passes is covered in PS-09 and PS-12
    passes: [{ name: "dense", stride: 1 }],
    now: () => w.now,
    capable: () => w.capable,
    isIdle: () => w.idle,
    plan: () => w.plan,
    planState: async () => { w.probes++; return w.state; },
    codeVersion: "cv",
    specs: async () => { w.specCalls++; return { specs: w.specs, skipped: { other: "canvas" }, project: PROJECT }; },
    // In `present`, `<key>:<start>-<end>` is a full-density manifest, while an added `#sparse` is a
    // manifest with only sparse version; sparse pass accepts both
    lookupOwn: async (task, need) => { w.lookups.push({ id: task.id, dense: need?.dense }); return has(`${task.resultKey}:${task.range.from}-${task.range.to}`, need); },
    lookupOther: async (resultKey, range, need) => has(`${resultKey}:${range.from}-${range.to}`, need),
    readLayerMap: async () => { if (w.readFails) throw new Error("broken"); return w.layerMap; },
    writeLayerMap: async (_project, body) => { w.layerMap = body; w.written.push(body); },
    produce: (job) => new Promise((resolve, reject) => {
      w.produced.push({ id: job.task.id, stride: job.stride });
      w.current = { job, resolve, reject };
      job.signal.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { retryable: true })), { once: true });
    }),
    onAlive: (key) => w.alive.push(key),
    ...over,
  };
  const pages = createPageStreams(deps);
  /** Advance ms milliseconds, one tick every 250 ms (host ticks) */
  const run = async (ms) => { for (let t = 0; t < ms; t += 250) { w.now += 250; pages.tick(); await flush(); } };
  /** Complete this segment in production (manifest enters content store) */
  const finish = async () => {
    const c = w.current;
    w.current = null;
    w.present.add(`${c.job.task.resultKey}:${c.job.task.range.from}-${c.job.task.range.to}${c.job.stride > 1 ? "#sparse" : ""}`);
    c.resolve("done");
    await flush();
  };
  /** Stop this segment in production due to yielding */
  const yielded = async () => { const c = w.current; w.current = null; c.resolve("yielded"); await flush(); };
  return { w, pages, run, finish, yielded };
}

test("PS-01 nobody claims: wait the full wait time before acting; first look up, write the layer table, then produce; after producing, claim this result key", async () => {
  const { w, pages, run, finish } = rig();
  pages.tick();
  await flush();
  assert.equal(pages.debug().state, "waiting");
  await run(PAGE_STREAM_WAIT_MS - 500);
  assert.equal(w.produced.length, 0, "does not act before the wait is over");
  assert.equal(pages.debug().planState, "open");
  await run(1000);
  assert.equal(w.produced.length, 1, "starts work once the wait is over");
  assert.deepEqual(w.produced[0], { id: "stream:rk-ka:0-9", stride: 1 }, "the task id uses the same formula as the one the splitter produces for the browser; full density");
  // Layer table already has this page's row before starting work
  assert.equal(w.written.length, 1);
  assert.equal(w.written[0].kind, "layer-map");
  assert.deepEqual(w.written[0].streams.map((r) => [r.topClipId, r.contentKey, r.candidates[0].resultKey, r.originFrame, r.lastSegment, r.segmentsPerTask, "firstSegment" in r]), [["clip-a", "ka", "rk-ka", 0, 9, 8, false]]);
  assert.equal(pages.running(), true);
  assert.equal(pages.debug().state, "producing");
  await finish();
  assert.deepEqual(w.alive, ["rk-ka"]);
  // Continue with next stream (clip-a is a motion card under 30s done in one go; next stream is clip-b)
  await run(500);
  assert.equal(w.produced[1].id, "stream:rk-kb:0-1");
  await finish();
  await run(500);
  const d = pages.debug();
  assert.equal(d.state, "done");
  assert.equal(d.counters.produced, 2);
  assert.deepEqual(d.jobs.map((j) => j.state), ["produced", "produced"]);
  assert.deepEqual(w.layerMap.streams.map((r) => r.topClipId).sort(), ["clip-a", "clip-b"]);
  assert.deepEqual(d.skipped, { other: "canvas" });
  assert.equal(w.specCalls, 1, "this version's stream is computed only once");
});

test("PS-02 a node able to split took the job: do not produce; after done, stop querying the queue", async () => {
  for (const state of ["claimed", "done"]) {
    const { w, pages, run } = rig();
    w.state = state;
    await run(PAGE_STREAM_WAIT_MS + 6000);
    assert.equal(w.produced.length, 0, state);
    assert.equal(w.written.length, 0, "the layer table belongs to the splitter, do not write");
    assert.equal(pages.debug().state, "taken");
    if (state === "done") assert.equal(w.probes, 1, "done is a terminal state, query only once");
    else assert.ok(w.probes > 2, "claimed keeps querying (the splitter may put it back)");
  }
  // Claimed node was released (became open again): after wait time elapsed, produce on its own as usual
  const { w, run } = rig();
  w.state = "claimed";
  await run(PAGE_STREAM_WAIT_MS + 2000);
  w.state = "open";
  await run(PAGE_STREAM_POLL_MS + 1000);
  assert.equal(w.produced.length, 1);
});

test("PS-03 look up first: if our own key exists or another candidate exists, produce nothing", async () => {
  // Its own key: both segments have it
  const own = rig();
  for (const k of ["rk-ka:0-9", "rk-kb:0-1"]) own.w.present.add(k);
  await own.run(PAGE_STREAM_WAIT_MS + 3000);
  assert.equal(own.w.produced.length, 0);
  assert.equal(own.pages.debug().counters.have, 2);
  assert.equal(own.pages.debug().state, "done");
  assert.deepEqual([...new Set(own.w.alive)].sort(), ["rk-ka", "rk-kb"]);
  assert.ok(own.w.written.length >= 1, "our own key exists, so the layer map must have this page's row");
  // Other candidates (produced on desktop): row for this card and content key in layer table lists its key
  const other = rig();
  other.w.specs = [specOf("clip-a", "ka", 0, 8)];
  other.w.layerMap = { v: 3, kind: "layer-map", projectId: "proj", layers: [], streams: [
    { topClipId: "clip-a", clipIds: ["clip-a"], kind: "card", plane: "local", contentKey: "ka", candidates: [{ envFingerprint: "desktop", resultKey: "rk-desktop" }], originFrame: 0, lastSegment: 7, segmentsPerTask: 8 }] };
  other.w.present.add("rk-desktop:0-7");
  await other.run(PAGE_STREAM_WAIT_MS + 2000);
  assert.equal(other.w.produced.length, 0, "use what the desktop app already produced");
  assert.deepEqual(other.w.alive, ["rk-desktop"], "claims that candidate's key");
  assert.equal(other.w.written.length, 0, "for someone else's stream, this page does not add its own candidate to the layer map");
  assert.equal(other.pages.debug().jobs[0].state, "elsewhere");
  // Rows with different content keys and unexpired input signatures (same stream produced by other
  // environment with its own key: different code version, different font): also used directly;
  // its manifest is portioned according to the range of its row
  const foreign = rig();
  foreign.w.specs = [specOf("clip-a", "ka", 0, 10)];
  foreign.w.layerMap = { ...other.w.layerMap, streams: [{ ...other.w.layerMap.streams[0], contentKey: "their-ka", lastSegment: 9, segmentsPerTask: 4 }] };
  for (const k of ["rk-desktop:0-3", "rk-desktop:4-7", "rk-desktop:8-9"]) foreign.w.present.add(k);
  await foreign.run(PAGE_STREAM_WAIT_MS + 3000);
  assert.equal(foreign.w.produced.length, 0);
  assert.deepEqual(foreign.pages.debug().jobs.map((j) => [j.state, j.via]), [["elsewhere", "rk-desktop"]]);
  // Only produced part of it (missing the 8-9 portion): this page produces the whole card (0-9)
  // on its own, because motion cards are split at 30s minimum, and under 30s the whole card is produced
  const partly = rig();
  partly.w.specs = [specOf("clip-a", "ka", 0, 10)];
  partly.w.layerMap = structuredClone(foreign.w.layerMap);
  for (const k of ["rk-desktop:0-3", "rk-desktop:4-7"]) partly.w.present.add(k);
  await partly.run(PAGE_STREAM_WAIT_MS + 3000);
  assert.deepEqual(partly.w.produced.map((x) => x.id), ["stream:rk-ka:0-9"]);
  // Rows with expired input signatures (streams with old parameters) do not count
  const stale = rig();
  stale.w.specs = [specOf("clip-a", "ka", 0, 8)];
  stale.w.layerMap = { ...other.w.layerMap, streams: [{ ...other.w.layerMap.streams[0], contentKey: "old", inputSig: "s1-0000000000000000" }] };
  stale.w.present.add("rk-desktop:0-7");
  await stale.run(PAGE_STREAM_WAIT_MS + 2000);
  assert.equal(stale.w.produced.length, 1);
  assert.deepEqual(stale.w.layerMap.streams.map((r) => r.contentKey), ["ka"], "the expired row is replaced with this page's row");
});

test("PS-04 yield: playback and dragging stop after the current frame and resume when idle; hiding aborts immediately; abort if the current frame takes over 1 second", async () => {
  const { w, pages, run, yielded } = rig();
  await run(PAGE_STREAM_WAIT_MS + 500);
  assert.equal(w.produced.length, 1);
  const first = w.current.job;
  assert.equal(first.yielding(), false);
  // Playback starts: do not abort, wait for current frame
  w.idle = false;
  pages.yieldFor("play");
  assert.equal(first.yielding(), true, "asked to yield before each frame");
  assert.equal(first.signal.aborted, false, "stop after the current frame finishes, do not abort");
  await yielded();
  assert.equal(pages.running(), false);
  assert.equal(pages.debug().counters.yields.play, 1);
  // Do not start work during playback
  await run(3000);
  assert.equal(w.produced.length, 1, "nothing produced during playback");
  // Stopped, idle: continue on same segment (segments already pushed are kept by host by task id)
  w.idle = true;
  await run(500);
  assert.equal(w.produced.length, 2);
  assert.equal(w.produced[1].id, w.produced[0].id, "resume the same segment");
  // Scrub: likewise wait for current frame; abort if not finished within 1 second
  const second = w.current.job;
  w.idle = false;
  pages.yieldFor("drag");
  assert.equal(second.signal.aborted, false);
  await run(YIELD_FRAME_MAX_MS + 250);
  assert.equal(second.signal.aborted, true, "current frame takes too long: abort");
  await flush();
  assert.equal(pages.running(), false);
  assert.equal(pages.debug().counters.yields.drag, 1);
  assert.equal(pages.debug().counters.aborts, 1);
  // Page hidden: do not wait for current frame
  w.idle = true;
  await run(500);
  const third = w.current.job;
  pages.yieldFor("hidden");
  assert.equal(third.signal.aborted, true, "hiding aborts immediately");
  await flush();
  assert.equal(pages.debug().counters.yields.hidden, 1);
  // Yielding does not count as failure
  assert.deepEqual(pages.debug().jobs.map((j) => j.fails), [0, 0]);
});

test("PS-05 a splitter takes over the job midway: stop after the current frame, do not start more work", async () => {
  const { w, pages, run, yielded } = rig();
  await run(PAGE_STREAM_WAIT_MS + 500);
  const job = w.current.job;
  w.state = "claimed";
  await run(PAGE_STREAM_POLL_MS + 500);
  assert.equal(job.yielding(), true);
  assert.equal(job.signal.aborted, false);
  await yielded();
  assert.equal(pages.debug().counters.stops.splitter, 1);
  await run(8000);
  assert.equal(w.produced.length, 1, "no longer produce on our own");
  assert.equal(pages.debug().state, "taken");
});

test("PS-06 produced elsewhere midway: stop and use the ready-made one", async () => {
  const { w, pages, run, yielded } = rig();
  w.specs = [specOf("clip-a", "ka", 0, 8)];
  await run(PAGE_STREAM_WAIT_MS + 500);
  const job = w.current.job;
  // Desktop connects, finishes producing, and writes its candidate into layer table
  w.layerMap = { ...w.layerMap, streams: [{ ...w.layerMap.streams[0], candidates: [{ envFingerprint: "desktop", resultKey: "rk-desktop" }, ...w.layerMap.streams[0].candidates] }] };
  w.present.add("rk-desktop:0-7");
  await run(PAGE_STREAM_RECHECK_MS + 500);
  assert.equal(job.yielding(), true, "found it already exists elsewhere: stop after the current frame");
  await yielded();
  const d = pages.debug();
  assert.equal(d.counters.stops.elsewhere, 1);
  assert.equal(d.jobs[0].state, "elsewhere");
  assert.equal(d.jobs[0].via, "rk-desktop");
  assert.deepEqual(w.alive, ["rk-desktop"]);
  await run(3000);
  assert.equal(w.produced.length, 1, "do not produce again");
});

test("PS-07 not idle, no work; when unable to produce, do nothing; after a plan version change, the old version's in-progress production aborts immediately", async () => {
  const busy = rig();
  busy.w.idle = false;
  await busy.run(PAGE_STREAM_WAIT_MS + 5000);
  assert.equal(busy.w.produced.length, 0);
  assert.equal(busy.pages.debug().state, "idle-wait");
  assert.equal(busy.w.written.length, 0, "work not started, do not write the layer map");
  const off = rig();
  off.w.capable = false;
  await off.run(PAGE_STREAM_WAIT_MS + 3000);
  assert.equal(off.w.specCalls, 0);
  assert.equal(off.w.probes, 0, "not a node: send no messages at all");
  assert.equal(off.pages.debug().state, "off");
  const none = rig();
  none.w.plan = null;
  await none.run(3000);
  assert.equal(none.w.probes, 0);
  // Switched to a new version
  const { w, pages, run } = rig();
  await run(PAGE_STREAM_WAIT_MS + 500);
  const job = w.current.job;
  w.plan = { ...PLAN, id: "plan:proj@8#clips:x", projectRev: 8, at: w.now };
  w.specs = [specOf("clip-a", "ka2", 0, 8)];
  await run(250);
  assert.equal(job.signal.aborted, true, "old version's in-progress production stops immediately");
  assert.equal(pages.debug().counters.stops["plan-changed"], 1);
  await run(PAGE_STREAM_WAIT_MS + 1000);
  assert.equal(w.produced.at(-1).id, "stream:rk-ka2:0-7", "after the new version's wait is full, produce the new key");
  // Goes offline
  pages.stop("offline");
  assert.equal(pages.running() && !w.current.job.signal.aborted, false);
  assert.equal(pages.debug().state, "off");
});

test("PS-08 layer map: rewrite after this page's row is overwritten by someone else; stop writing once a splitter takes over the job", async () => {
  const { w, pages, run, finish } = rig();
  w.specs = [specOf("clip-a", "ka", 0, 8)];
  await run(PAGE_STREAM_WAIT_MS + 500);
  await finish();
  await run(500);
  const writes = w.written.length;
  assert.ok(writes >= 1);
  // No change: do not write even after verifying
  await run(PAGE_STREAM_ROWS_MS + 1000);
  assert.equal(w.written.length, writes);
  // Another page wrote later, overwriting this page's row
  w.layerMap = { v: 3, kind: "layer-map", projectId: "proj", layers: [], streams: [{ topClipId: "clip-z", clipIds: ["clip-z"], kind: "card", plane: "local", contentKey: "z", candidates: [{ envFingerprint: "x", resultKey: "rz" }], firstSegment: 0, lastSegment: 0, segmentsPerTask: 8 }] };
  await run(PAGE_STREAM_ROWS_MS + 1000);
  assert.equal(w.written.length, writes + 1, "rewrite");
  assert.deepEqual(w.layerMap.streams.map((r) => r.topClipId).sort(), ["clip-a", "clip-z"], "keep other pages' rows");
  // Cannot read layer table: do not write, retry on next tick
  assert.equal(pages.debug().counters.rowsFailed, 0);
});

test("PS-09 hook: the number of passes and the density of each pass are set by passes", async () => {
  const { w, run, finish } = rig({ passes: [{ name: "sparse", stride: 15 }, { name: "dense", stride: 1 }] });
  w.specs = [specOf("clip-a", "ka", 0, 8), specOf("clip-b", "kb", 120, 2)];
  // Its own key not found (must do every pass): here make "check first" always miss
  w.present = { has: () => false, add: () => {} };
  await run(PAGE_STREAM_WAIT_MS + 500);
  for (let i = 0; i < 4; i++) { await finish(); await run(500); }
  assert.deepEqual(w.produced.slice(0, 4), [
    { id: "stream:rk-ka:0-7:sparse", stride: 15 }, { id: "stream:rk-kb:0-1:sparse", stride: 15 },
    { id: "stream:rk-ka:0-7", stride: 1 }, { id: "stream:rk-kb:0-1", stride: 1 },
  ], "finish the sparse pass of each stream first, then fill up to full density");
});

test("PS-10 production fails: retry after backoff, give up this segment after consecutive failures; with no work left, stop polling the queue", async () => {
  const { w, pages, run } = rig();
  w.specs = [specOf("clip-a", "ka", 0, 8)];
  await run(PAGE_STREAM_WAIT_MS + 500);
  for (let i = 1; i <= PAGE_STREAM_ATTEMPTS; i++) {
    assert.equal(w.produced.length, i, `attempt ${i}`);
    const c = w.current;
    w.current = null;
    c.reject(Object.assign(new Error("The stage did not hand over the pixels of this frame"), { retryable: true }));
    await flush();
    await run(2000 * i + 500);
  }
  const d = pages.debug();
  assert.equal(d.jobs[0].state, "failed");
  assert.equal(d.counters.failed, 1);
  assert.match(d.lastError, /pixel/);
  const probes = w.probes;
  await run(10_000);
  assert.equal(w.produced.length, PAGE_STREAM_ATTEMPTS, "no more retries");
  assert.equal(w.probes, probes, "with no work left, do not poll the queue");
});

test("PS-11 this page's row was overwritten by another layer-map writer, and its whole stream is already produced: do not write it back", async () => {
  const { w, pages, run, finish } = rig();
  w.specs = [specOf("clip-a", "ka", 0, 8)];
  await run(PAGE_STREAM_WAIT_MS + 500);
  await finish();
  await run(500);
  const writes = w.written.length;
  // Another peer (such as desktop with different code version) produced the entire stream
  // using its own key, and overwrote this page's layer table with its own
  w.layerMap = { v: 3, kind: "layer-map", projectId: "proj", layers: [], streams: [
    { topClipId: "clip-a", clipIds: ["clip-a"], kind: "card", plane: "local", contentKey: "their-ka", candidates: [{ envFingerprint: "desktop", resultKey: "rk-desktop" }], originFrame: 0, lastSegment: 7, segmentsPerTask: 8 }] };
  w.present.add("rk-desktop:0-7");
  await run(PAGE_STREAM_ROWS_MS + 1000);
  await run(PAGE_STREAM_ROWS_MS + 1000);
  assert.equal(w.written.length, writes, "do not write back");
  assert.equal(pages.debug().counters.rowsYielded, 1);
  assert.deepEqual(w.layerMap.streams.map((r) => r.contentKey), ["their-ka"]);
  // Control: the peer that overwrote this page's row did not finish producing (manifest missing): write back
  const again = rig();
  again.w.specs = [specOf("clip-a", "ka", 0, 8)];
  await again.run(PAGE_STREAM_WAIT_MS + 500);
  await again.finish();
  await again.run(500);
  const n = again.w.written.length;
  again.w.layerMap = structuredClone(w.layerMap);
  await again.run(PAGE_STREAM_ROWS_MS + 1000);
  assert.equal(again.w.written.length, n + 1);
  assert.deepEqual(again.w.layerMap.streams.map((r) => r.contentKey), ["ka", "their-ka"], "this page's row comes first, the other's unexpired row stays behind it");
});

test("PS-12 default two passes: full density starts only after all sparse ones settle; lookup first, claiming by this pass's density", async () => {
  assert.deepEqual(PAGE_STREAM_PASSES.map((p) => p.stride), [15, 1], "default is sparse first (one segment's frame count), then full density");
  const { w, pages, run, finish } = rig({ passes: undefined });
  w.specs = [specOf("clip-a", "ka", 0, 8), specOf("clip-b", "kb", 120, 2)];
  await run(PAGE_STREAM_WAIT_MS + 500);
  assert.deepEqual(w.produced[0], { id: "stream:rk-ka:0-7:sparse", stride: 15 }, "do the sparse pass first; the job is a sparse stream job");
  assert.deepEqual(w.lookups[0], { id: "stream:rk-ka:0-7:sparse", dense: false }, "the sparse pass looks up first without requiring full density");
  await finish();
  await run(500);
  assert.equal(w.produced[1].id, "stream:rk-kb:0-1:sparse");
  // Sparse pass of second stream failed (backing off): full density not allowed to start work first
  const c = w.current;
  w.current = null;
  c.reject(Object.assign(new Error("The stage did not hand over the pixels of this frame"), { retryable: true }));
  await run(1500);
  assert.equal(w.produced.length, 2, "the sparse one is backing off, the full-density one waits");
  assert.equal(pages.debug().jobs.filter((j) => j.pass === "dense").every((j) => j.state === "todo"), true);
  await run(1000);
  assert.equal(w.produced[2].id, "stream:rk-kb:0-1:sparse", "after backoff, the retried one is still the sparse segment");
  await finish();
  await run(500);
  assert.deepEqual(w.produced[3], { id: "stream:rk-ka:0-7", stride: 1 }, "fill up to full density only once all sparse ones are complete");
  assert.equal(w.lookups.find((l) => l.id === "stream:rk-ka:0-7").dense, true, "the full-density pass looks up requiring full density: a sparse-only version does not count as existing");
  await finish();
  await run(500);
  await finish();
  await run(500);
  assert.equal(pages.debug().state, "done");
  assert.deepEqual(pages.debug().jobs.map((j) => [j.pass, j.state]), [["sparse", "produced"], ["sparse", "produced"], ["dense", "produced"], ["dense", "produced"]]);
});

const REQ = { round: 1, projectId: "proj", projectRev: 7, clips: ["clip-a"], heavy: ["clip-a", "clip-b"] };

test("PS-13 produce the sparse version at measurement time: do not wait for the plan, do not ask the splitter, do not check idleness; lookup, write the layer map, produce, claim; do not produce what already exists", async () => {
  const { w, pages, run, finish } = rig({ passes: undefined });
  w.plan = null;        // Measurement has not settled yet, manifest plan not sent
  w.state = "claimed";  // Produce anyway even if there is a splitter (it manages the manifest plan)
  w.idle = false;       // The idle gate does not govern this pass during measurement
  w.specs = [specOf("clip-a", "ka", 0, 10), specOf("clip-b", "kb", 120, 2)];
  let out = null;
  void pages.measure(REQ).then((o) => { out = o; });
  await flush();
  assert.deepEqual(w.produced, [{ id: "stream:rk-ka:0-9:sparse", stride: 15 }], "produce only the card just measured; the sparse pass");
  assert.equal(pages.running(), true);
  assert.equal(w.written.length, 1, "this page's row in the layer map was written before work started");
  assert.deepEqual(w.written[0].streams.map((r) => r.topClipId), ["clip-a"]);
  assert.equal(out, null, "the mask waits until production finishes");
  await finish();
  assert.deepEqual(out, { result: "ok", produced: 1, have: 0, elsewhere: 0, left: 0 });
  assert.deepEqual([...new Set(w.alive)], ["rk-ka"], "tell the host to claim this result key (this page uses its own production first)");
  assert.equal(w.produced.length, 1, "the full-density pass is not done at measurement time");
  assert.equal(w.probes, 0, "do not poll the queue");
  // Ticks proceed as usual when there is no plan: this bookkeeping entry is kept, not cleared as "no plan"
  await run(2000);
  assert.equal(pages.debug().state, "measuring");
  assert.equal(pages.debug().streams.length, 1);
  // Next card: if asset service already has sparse version (produced by others or last open), use directly
  w.present.add("rk-kb:0-1#sparse");
  const second = await pages.measure({ ...REQ, clips: ["clip-b"] });
  assert.deepEqual(second, { result: "ok", produced: 0, have: 1, elsewhere: 0, left: 0 });
  assert.equal(w.produced.length, 1, "do not re-produce what already exists");
  assert.deepEqual(pages.debug().measure.results, { ok: 2 });
  // Cards classified as light and cards this page cannot produce: have no stream
  const none = await pages.measure({ ...REQ, clips: ["clip-x"] });
  assert.equal(none.result, "none");
});

test("PS-14 the overlay waits for the sparse version for at most MEASURE_SPARSE_MAX_MS: on timeout it replies on the spot and the producer stops; this round then replies right away; start over with a new round", async () => {
  assert.equal(MEASURE_SPARSE_MAX_MS, 50_000);
  const { w, pages, run } = rig({ passes: undefined });
  w.plan = null;
  w.specs = [specOf("clip-a", "ka", 0, 10), specOf("clip-b", "kb", 120, 2)];
  let out = null;
  const t0 = w.now;
  void pages.measure(REQ).then((o) => { out = o; });
  await flush();
  assert.equal(w.produced.length, 1);
  await run(MEASURE_SPARSE_MAX_MS - 500);
  assert.equal(out, null, "The overlay keeps waiting before the deadline");
  assert.equal(w.current.job.yielding(), false);
  await run(500);
  assert.equal(out?.result, "deadline", "Replies on the spot at 50 s (the editor opens however long this card drags on)");
  assert.equal(out.left, 1);
  assert.equal(w.now - t0, MEASURE_SPARSE_MAX_MS);
  assert.equal(w.current.job.yielding(), true, "The producer stops after finishing the current frame");
  assert.equal(w.current.job.signal.aborted, false);
  // Current frame takes too long to finish: abort according to yield time limit
  await run(YIELD_FRAME_MAX_MS + 250);
  assert.equal(pages.running(), false);
  assert.equal(pages.debug().counters.stops.deadline, 1);
  // Called after this round: return immediately, do not produce
  const again = await pages.measure({ ...REQ, clips: ["clip-b"] });
  assert.equal(again.result, "deadline");
  assert.equal(w.produced.length, 1);
  // Clock counts from the first call of this round: the second card starts late,
  // and wait time only extends to the same instant
  const two = rig({ passes: undefined });
  two.w.plan = null;
  two.w.specs = w.specs;
  void two.pages.measure(REQ).then(() => {});
  await flush();
  await two.run(30_000);
  await two.finish();
  let late = null;
  void two.pages.measure({ ...REQ, clips: ["clip-b"] }).then((o) => { late = o; });
  await flush();
  await two.run(19_500);
  assert.equal(late, null);
  await two.run(500);
  assert.equal(late?.result, "deadline", "The second card only waits until second 50 of this round");
  // New round (switched frame rate, overlay reappears): clock restarts
  await two.run(YIELD_FRAME_MAX_MS + 250);
  let next = null;
  void two.pages.measure({ ...REQ, round: 2, clips: ["clip-b"] }).then((o) => { next = o; });
  await flush();
  assert.equal(next, null, "The new round produces as usual");
  assert.equal(two.pages.running(), true);
  two.pages.stop();
  await flush();
  assert.equal(next?.result, "stopped", "On going offline, the pending wait replies on the spot and does not leave the overlay hanging");
});

test("PS-15 once the plan is published it is replaced by the plan's own copy: the sparse version produced during measurement is found and not produced again; density is filled in afterwards", async () => {
  const { w, pages, run, finish } = rig({ passes: undefined });
  w.plan = null;
  w.specs = [specOf("clip-a", "ka", 0, 8), specOf("clip-b", "kb", 120, 2)];
  void pages.measure(REQ);
  await flush();
  await finish();
  assert.equal(w.produced.length, 1);
  // Measurement settles, manifest plan sent (sent timestamp is later than measurement)
  w.plan = { ...PLAN, at: w.now + 250 };
  await run(PAGE_STREAM_WAIT_MS + 1000);
  assert.equal(pages.debug().planId, PLAN.id);
  assert.equal(pages.debug().jobs.find((j) => j.id === "stream:rk-ka:0-7:sparse").state, "have", "The segment produced during measurement: lookup finds it first, no re-production");
  assert.equal(w.produced[1].id, "stream:rk-kb:0-1:sparse", "The sparse version of unmeasured cards keeps being produced when idle");
  await finish();
  await run(500);
  assert.equal(w.produced[2].id, "stream:rk-ka:0-7", "fill up to full density only once all sparse ones are complete");
  // Old plan (entry sent earlier than measurement) does not replace measurement entry:
  // when switching frame rate and re-entering overlay, previous plan version is retained
  const old = rig({ passes: undefined });
  old.w.specs = w.specs;
  old.w.plan = { ...PLAN, at: old.w.now - 5000 };
  old.w.idle = false;
  await old.run(1000);
  assert.equal(old.pages.debug().planId, PLAN.id);
  void old.pages.measure(REQ);
  await flush();
  await old.run(1000);
  assert.equal(old.pages.debug().planId, "measure:proj@7");
  assert.equal(old.pages.running(), true);
});

test("PS-16 during measurement this page is not yet a node: wait a while, produce as usual if it becomes one, reply incapable if not", async () => {
  const { w, pages, run } = rig({ passes: undefined });
  w.plan = null;
  w.capable = false;
  let out = null;
  void pages.measure(REQ).then((o) => { out = o; });
  await run(MEASURE_READY_WAIT_MS - 500);
  assert.equal(out, null);
  w.capable = true;
  await run(500);
  assert.equal(w.produced.length, 1, "Fingerprint obtained and encoder probed: produce as usual");
  pages.stop();
  await flush();
  const never = rig({ passes: undefined });
  never.w.plan = null;
  never.w.capable = false;
  let got = null;
  void never.pages.measure(REQ).then((o) => { got = o; });
  await never.run(MEASURE_READY_WAIT_MS + 250);
  assert.equal(got?.result, "incapable");
  assert.equal(never.w.produced.length, 0);
});

test("PS-17 when producing only the sparse version for this page, isConfigSupported passes: only the sparse version is produced, not the full-density version", async () => {
  let checkedConfig = null;
  const { w, pages, run, finish } = rig({
    sparseOnly: true,
    passes: undefined,
    isConfigSupported: async (cfg) => { checkedConfig = cfg; return true; },
  });
  w.specs = [specOf("clip-a", "ka", 0, 8), specOf("clip-b", "kb", 120, 2)];
  await run(PAGE_STREAM_WAIT_MS + 1000);
  assert.ok(checkedConfig, "isConfigSupported was called to check the config before starting work");
  assert.equal(checkedConfig.codec, "avc1.64001f");
  assert.equal(w.produced.length, 1);
  assert.equal(w.produced[0].id, "stream:rk-ka:0-7:sparse", "The first segment produced is the sparse version");
  assert.equal(w.produced[0].stride, 15);
  await finish();
  await run(500);
  assert.equal(w.produced.length, 2);
  assert.equal(w.produced[1].id, "stream:rk-kb:0-1:sparse", "The second segment is also the sparse version");
  assert.equal(w.produced[1].stride, 15);
  await finish();
  await run(1000);
  assert.equal(w.produced.length, 2, "Never produces the full-density version (will not start dense)");
  const dbg = pages.debug();
  assert.equal(dbg.state, "done");
  assert.ok(dbg.jobs.every((j) => j.pass === "sparse"), "Only the sparse version is produced for this page: the job manifest contains only sparse versions");
});

test("PS-18 when producing only the sparse version for this page, isConfigSupported returns unsupported: stop producing and fall back", async () => {
  const { w, pages, run } = rig({
    sparseOnly: true,
    passes: undefined,
    isConfigSupported: async () => false,
  });
  w.specs = [specOf("clip-a", "ka", 0, 8)];
  // 1. Idle stream production entry point for this page
  await run(PAGE_STREAM_WAIT_MS + 1000);
  assert.equal(w.produced.length, 0, "No stream is produced when unsupported");
  const dbg = pages.debug();
  assert.equal(dbg.jobs[0].state, "failed");
  assert.equal(dbg.counters.failed, 1);
  pages.stop();

  // 2. Measurement pass entry point
  const measureRig = rig({
    sparseOnly: true,
    passes: undefined,
    isConfigSupported: async () => false,
  });
  measureRig.w.specs = [specOf("clip-a", "ka", 0, 8)];
  const out = await measureRig.pages.measure({ round: 1, projectId: "proj", projectRev: 7, clips: ["clip-a"], heavy: ["clip-a"] });
  assert.equal(out.result, "failed", "Replies failed and exits when the measurement pass is unsupported");
  assert.equal(measureRig.w.produced.length, 0, "No stream is produced when the measurement pass is unsupported");
});

test("PS-19 when producing only the sparse version for this page, 3 consecutive encoding errors: stop producing and fall back", async () => {
  let produceCalls = 0;
  const { w, pages, run } = rig({
    sparseOnly: true,
    passes: undefined,
    isConfigSupported: async () => true,
    produce: () => {
      produceCalls++;
      return Promise.reject(new Error("Encoder crashed"));
    },
  });
  w.specs = [specOf("clip-a", "ka", 0, 8)];
  // Run repeatedly until failing after 3 backoff retries
  await run(PAGE_STREAM_WAIT_MS + 20_000);
  assert.equal(produceCalls, 3, "Tried 3 times in a row");
  const dbg = pages.debug();
  assert.equal(dbg.jobs[0].state, "failed");
  assert.equal(dbg.counters.failed, 1);
  assert.equal(dbg.state, "done");
  assert.equal(w.current, null);

  // 3 consecutive failures during measurement pass stop production and return failed
  let measureProduceCalls = 0;
  const measureRig = rig({
    sparseOnly: true,
    passes: undefined,
    isConfigSupported: async () => true,
    produce: () => {
      measureProduceCalls++;
      return Promise.reject(new Error("Encoder crashed"));
    },
  });
  measureRig.w.specs = [specOf("clip-a", "ka", 0, 8)];
  const out = await measureRig.pages.measure({ round: 1, projectId: "proj", projectRev: 7, clips: ["clip-a"], heavy: ["clip-a"] });
  assert.equal(out.result, "failed");
  assert.equal(measureProduceCalls, 1);
});

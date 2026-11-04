/**
 * Task F (`claude/queue-maint`): snapshot generation follows background position during stage swap:
 * dedicated swap script (M7 contract section 4.3, D8; item 4 of "What wasn't done" in
 * `docs/archive/agent-reports/AGENT-rq-m7-node.md`). Does not launch browser:
 *
 *   - Real: node arrangement `src/online/browserNode.ts`, single-flight queue `stageJobs.ts`, stage
 *     registry `stageBridge.ts` (including filtering events by role, swap of `swapStageClients`,
 *     push baseline tracked per client), snapshot generation job `stageBake.ts` (first half of a
 *     host frame);
 *   - Fake: stage (deterministically outputs HTML based on "fed-in project + local frame"; returns
 *     `role` if not background; returns `cancelled` if role changes while a frame is in flight,
 *     same as `StageView.tsx`), queue (claim, release, and completion of a task).
 *
 *   QM-F-01 Baseline: no swap, one background stage finishes 10 frames
 *   QM-F-02 Contract swap flow: catch-up run queues in while frame 4 is in flight → current frame
 *           finishes and is released (yield-urgent, 5 completed frames remain on this page) →
 *           catch-up run executes on the old background → swap → after re-claiming, first re-feed
 *           the entire isolated single-card project on the new background and resume from frame 5 →
 *           10 frames byte-for-byte identical to baseline
 *   QM-F-03 Background position switched between two frames (no catch-up run beforehand: iframe
 *           reload, or the narrow window where a job started right after catch-up run finished):
 *           switch detected before the next frame → switch to new background, re-feed first then
 *           run; next frame sent ahead on old stage is invalidated; no release, no failure;
 *           byte-for-byte identical to baseline
 *   QM-F-04 Background position switched mid-frame (defect found by script, fixed): old stage
 *           returns cancelled, or finishes but event arrives after swap and is filtered by role:
 *           re-feed and redo this frame on new background, not counted as failure; byte-for-byte
 *           identical to baseline. When background position has not switched, cancelled is returned
 *           as retryable failure as usual
 *   QM-F-05 Bake job launched from single-flight queue right after catch-up run finished and before
 *           swap (job recorded old background): switch detected before frame 1, frames only come
 *           from new background, and isolated single-card project is fed only to new background;
 *           old background (new foreground) ends up in front role
 *
 * Run: node --test src/editor/stageBake.test.mjs
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const bridge = await import("./stageBridge.ts");
const jobs = await import("./stageJobs.ts");
const { createStageBaker } = await import("./stageBake.ts");
const { createBrowserNode } = await import("../online/browserNode.ts");

const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const FP = "aaaaaaaaaaaaaaaa";
const FRAMES = 10;

/* ------------------------------------------------------------------ Project and task */

const PROJECT = {
  id: "p", fps: 30, duration: 10, width: 1280, height: 720,
  tracks: [
    { id: "t1", clips: [{ id: "c", cardId: "punch-pill", start: 2, end: 2 + FRAMES / 30, props: { text: "hi" } }] },
    { id: "t2", clips: [{ id: "d", cardId: "bg", start: 0, end: 10 }] },
  ],
};
const TASK = {
  id: "snapshot:rk:0-9", kind: "snapshot", tier: "shared", resultKey: "rk", range: { unit: "localFrame", from: 0, to: FRAMES - 1 },
  source: { projectId: "p1", projectRev: 7, userId: "u@d" },
  input: { clipId: "c", compositing: "independent", canvasHeavy: false,
    bake: { start: 2, end: 2 + FRAMES / 30, count: FRAMES, sampling: { firstFrame: 60, phase: { numerator: 0, denominator: 1 } } } },
  weight: { class: "light" }, requires: { envFingerprint: FP, codeVersion: "cv", cardSources: {}, transcode: false, userCards: false, graphCards: false },
};

/* ------------------------------------------------------------------ Fake stage */

/**
 * A stage (an RPC client for an iframe). The output of `bakeFrame` is determined solely by the
 * "project fed in at this moment" and the local frame: when feeding the isolated single-card
 * project, the target clip starts from 0 and project duration is this card's; when feeding the
 * whole project (catch-up run), the clip starts from 2 s: without re-feeding, different bytes are
 * produced.
 */
function fakeStage(name, role) {
  const handlers = new Set();
  const s = {
    name, role, disposed: false, project: null, gen: 0,
    calls: [],          // [['setRole', role, job] | ['setProject', reset, visibleClip] | ['bakeFrame', frame] | ['bakeCancel']]
    hold: null,         // (frame) => boolean: pause this frame first and wait for release(frame)
    lateEvent: null,    // (frame) => boolean: events for this frame are emitted only when flushLate() is called
    waiting: new Map(), late: [],
    onEvent(h) { handlers.add(h); return () => handlers.delete(h); },
    emit(e) { for (const h of [...handlers]) h(e); },
    async setRole(r, opts) { s.role = r; s.calls.push(["setRole", r, opts?.job ?? null]); return { ok: true }; },
    async setProject(project, opts) {
      s.project = project; s.gen++;
      const vis = project.tracks.filter((t) => !t.hidden).flatMap((t) => t.clips).map((c) => c.id).join(",");
      s.calls.push(["setProject", !!opts?.reset, vis]);
      return { ok: true };
    },
    async bakeCancel() { s.gen++; s.calls.push(["bakeCancel"]); return { ok: true }; },
    async bakeFrame(req) {
      s.calls.push(["bakeFrame", req.localFrame]);
      if (s.role !== "back") return { ok: false, reason: "role" };
      const p = s.project;
      if (!p) return { ok: false, reason: "no-project" };
      const gen = ++s.gen;
      if (s.hold?.(req.localFrame)) await new Promise((r) => s.waiting.set(req.localFrame, r));
      else await new Promise((r) => setImmediate(r));
      // Same as StageView: when role changes while a frame is in flight, is invalidated (new frame,
      // bakeCancel), or project changes, all return cancelled without emitting events
      if (s.role !== "back" || gen !== s.gen || s.project !== p) return { ok: false, reason: "cancelled" };
      const clip = p.tracks.filter((t) => !t.hidden).flatMap((t) => t.clips).find((c) => c.id === req.clipId);
      if (!clip) return { ok: false, reason: "no-clip" };
      const local = req.localFrame / p.fps - clip.start;
      const html = `<div data-pc-clip="${clip.id}" data-t="${local.toFixed(5)}" data-dur="${p.duration}">${JSON.stringify(clip.props ?? {})}</div>`;
      const bytes = new TextEncoder().encode(html);
      const hash = sha256(bytes);
      const event = { type: "bake-frame", session: req.session, clipId: req.clipId, localFrame: req.localFrame, hash, bytes: bytes.length, htmlRaw: bytes.buffer, small: null };
      // Events and responses travel on the same postMessage channel with events first: when events arrive
      // late, responses follow behind them (flushLate emits events first, then releases responses)
      if (s.lateEvent?.(req.localFrame)) await new Promise((r) => s.late.push({ event, r })); else s.emit(event);
      return { ok: true, localFrame: req.localFrame, hash, bytes: bytes.length, small: null, ms: 1, pausedMs: 0, remounted: false, smallMs: 0, readyMs: 0 };
    },
    release(frame) { const r = s.waiting.get(frame); s.waiting.delete(frame); r?.(); },
    flushLate() { for (const { event, r } of s.late.splice(0)) { s.emit(event); r(); } },
    bakedFrames() { return s.calls.filter((c) => c[0] === "bakeFrame").map((c) => c[1]); },
  };
  return s;
}

/**
 * K5 swap (first few steps of `swapAndDress` in `stageSwap.ts`): swap registries, then change roles
 * of both stages
 */
async function swap(newFront, newBack) {
  bridge.swapStageClients({ client: newFront }, { client: newBack });
  await newBack.setRole("back");
  await newFront.setRole("front");
}

/* ------------------------------------------------------------------ Fake queue + node */

function rig({ stages, afterFrame = null }) {
  const log = [];
  let token = 0, version = 1, state = "open", result = null;
  const htmlOf = new Map();
  const bakedOn = new Map();
  let node = null;
  const view = () => ({ ...TASK, state, version });
  const reply = (m) => queueMicrotask(() => node.receive(m));
  const handle = (m) => {
    switch (m.type) {
      case "node.hello": reply({ type: "node.welcome", nodeId: "n", envFingerprint: FP, resumed: [], lost: [] }); break;
      case "queue.watch": reply({ type: "queue.snapshot", tasks: state === "open" ? [view()] : [] }); break;
      case "task.claim":
        if (state !== "open" || m.expectVersion !== version) { reply({ type: "task.claim-rejected", id: m.id, reason: "stale", state, version }); break; }
        state = "claimed"; version++; token++;
        reply({ type: "task.claimed", id: TASK.id, token, version, leaseUntil: Infinity, task: view() });
        break;
      case "task.progress": reply({ type: "task.renewed", id: m.id, token: m.token, leaseUntil: Infinity }); break;
      case "task.release":
        state = "open"; version++;
        reply({ type: "task.released", id: m.id });
        reply({ type: "task.opened", task: view() });
        break;
      case "task.complete": state = "done"; result = m.result; reply({ type: "task.completed", id: m.id }); break;
      case "task.fail": state = "open"; version++; reply({ type: "task.fail-ack", id: m.id, state: "open" }); reply({ type: "task.opened", task: view() }); break;
      default: break;
    }
  };
  const idle = () => jobs.urgentBackJobs() === 0;
  const baker = createStageBaker({
    runBackJob: (kind, run) => jobs.runBackJob(kind, run), backStage: bridge.backStage, pushProject: bridge.pushProject, onStageEvent: bridge.onStageEvent,
    onUrgent: () => node.yieldFor("urgent"), isIdle: idle, mode: "seq", small: false,
  });
  node = createBrowserNode({
    nodeId: "n", projectId: "p1", userId: "u@d", codeVersion: "cv", environment: { platform: "", userAgent: "", renderer: "", vendor: "" },
    now: () => 1_000_000, isIdle: idle,
    send: (m) => { log.push(JSON.parse(JSON.stringify(m))); queueMicrotask(() => handle(m)); return true; },
    keptProject: () => PROJECT, fetchSnapshot: async () => null,
    bakeFrame: async (job) => {
      const { event, stage } = await baker.bakeFrame(job);
      htmlOf.set(job.localFrame, new TextDecoder().decode(new Uint8Array(event.htmlRaw)));
      bakedOn.set(job.localFrame, stage.name);
      // Latter half of a host frame (decompressing, pushing to asset service, entering in-page snapshot
      // store): script can pause here, creating "between two frames"
      if (afterFrame) await afterFrame(job.localFrame);
      return { hash: event.hash, bytes: event.bytes, small: null };
    },
    finishTask: async ({ frames }) => ({ frames: frames.map((f) => [f.localFrame, f.hash, f.bytes]) }),
    onTaskEnd: () => baker.close(),
  });
  node.start();
  return {
    node, baker, log, stages, htmlOf, bakedOn,
    get result() { return result; },
    of: (type) => log.filter((m) => m.type === type),
    /** Node ticks (host once every 250 ms) until until condition holds */
    async run(until, max = 300) {
      for (let i = 0; i < max; i++) { node.tick(); await flush(); if (until()) return; }
      throw new Error(`The script did not run to the end: ${JSON.stringify(log.map((m) => m.type))}`);
    },
  };
}

beforeEach(() => {
  jobs.resetStageJobs();
  bridge.resetStageBridge();
});

/** Run once without swapping, using each frame's HTML as baseline */
async function baseline() {
  jobs.resetStageJobs();
  bridge.resetStageBridge();
  const A = fakeStage("A", "front"), B = fakeStage("B", "back");
  bridge.setStageClient("front", A);
  bridge.setStageClient("back", B);
  const r = rig({ stages: { A, B } });
  await r.run(() => r.result !== null);
  const html = [...r.htmlOf.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h);
  jobs.resetStageJobs();
  bridge.resetStageBridge();
  return { r, html, frames: r.result.frames };
}

test("QM-F-01 Baseline: no swap, one background stage bakes all 10 frames (push an isolated single-card project once, every frame comes only from the background)", async () => {
  const { r, html, frames } = await baseline();
  assert.equal(frames.length, FRAMES);
  assert.deepEqual(frames.map((f) => f[0]), [...Array(FRAMES).keys()]);
  assert.equal(r.stages.B.calls.filter((c) => c[0] === "setProject").length, 1);
  assert.deepEqual(r.stages.B.calls.find((c) => c[0] === "setProject"), ["setProject", true, "c"], "Whole project re-pushed, only the target clip is visible");
  assert.equal(r.stages.A.bakedFrames().length, 0, "The visible stage bakes no frames");
  assert.ok(html[0].includes('data-t="0.00000"'), "In the isolated single-card project, local frame 0 is the clip start");
  assert.equal(r.of("task.release").length + r.of("task.fail").length, 0);
});

test("QM-F-02 The contract's swap flow: while frame 4 is in flight a catch-up run is queued → the current frame finishes, release → catch-up run → swap → re-push on the new background stage and continue from frame 5; byte-for-byte identical to the baseline", async () => {
  const base = await baseline();
  const A = fakeStage("A", "front"), B = fakeStage("B", "back");
  bridge.setStageClient("front", A);
  bridge.setStageClient("back", B);
  B.hold = (f) => f === 4;
  const r = rig({ stages: { A, B } });
  await r.run(() => B.waiting.has(4));
  assert.deepEqual(B.bakedFrames(), [0, 1, 2, 3, 4], "Frames 0~3 are done, frame 4 is in flight (the frame sent ahead during the sequential run)");

  // Catch-up run (more urgent) queues in: single-flight queue aborts snapshot generation job, node
  // requests yield
  const catchupOrder = [];
  const catchup = jobs.runBackJob("catchup", async (ctx) => {
    catchupOrder.push(["catchup-start", ctx.stage.name, r.of("task.release").length]);
    await bridge.pushProject("back", PROJECT, { reset: true });
  });
  await flush();
  assert.equal(r.of("task.release").length, 0, "The current frame is not finished yet: do not release");
  assert.equal(catchupOrder.length, 0, "The catch-up run does not start until the generate-snapshots job has been handed back (single-flight)");
  B.release(4);
  await catchup;
  const release = r.of("task.release");
  assert.equal(release.length, 1);
  assert.equal(release[0].reason, "yield-urgent");
  const lastProgressBefore = r.log.slice(0, r.log.indexOf(r.log.find((m) => m.type === "task.release"))).filter((m) => m.type === "task.progress").at(-1);
  assert.equal(lastProgressBefore.done, 5, "Release only after the current frame (frame 4) is finished and 5 frames have been reported");
  assert.deepEqual(catchupOrder, [["catchup-start", "B", 1]], "The catch-up run starts on the old background B only after the release");
  assert.deepEqual(B.bakedFrames(), [0, 1, 2, 3, 4], "After yielding, the old background no longer sends the next frame ahead");

  // K5: after catch-up run finishes, B switches to foreground, A takes over background
  await swap(B, A);
  assert.equal(bridge.backStage(), A);
  await r.run(() => r.result !== null);

  assert.deepEqual(A.bakedFrames(), [5, 6, 7, 8, 9], "The new background continues after the frames that were kept, without redoing 0~4");
  assert.deepEqual(B.bakedFrames(), [0, 1, 2, 3, 4], "After the swap, the old background (now the front) bakes no frames");
  const aFirstBake = A.calls.findIndex((c) => c[0] === "bakeFrame");
  const aPush = A.calls.findIndex((c) => c[0] === "setProject");
  assert.ok(aPush >= 0 && aPush < aFirstBake, `The new background first re-pushes the whole isolated single-card project and then bakes frames: ${JSON.stringify(A.calls)}`);
  assert.deepEqual(A.calls[aPush], ["setProject", true, "c"]);
  assert.ok(A.calls.some((c) => c[0] === "setRole" && c[1] === "back" && c[2] === "bake"), "The single-flight queue sent the bake work item to the new background");
  assert.deepEqual(r.result.frames, base.frames, "The manifest (frame numbers, hashes, byte counts) is the same as without a swap");
  const html = [...r.htmlOf.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h);
  assert.deepEqual(html, base.html, "Each frame's HTML is byte-for-byte identical to the one without a swap");
  assert.deepEqual([...r.bakedOn.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s), ["B", "B", "B", "B", "B", "A", "A", "A", "A", "A"]);
  assert.equal(r.of("task.fail").length, 0);
  assert.equal(r.of("task.claim").length, 2, "Claimed once again");
});

test("QM-F-03 The background slot changes hands between two frames (no catch-up run ahead of it): the change is detected before the next frame → switch to the new background, re-push first and then bake; the frame sent ahead is invalidated; no release and no failure", async () => {
  const base = await baseline();
  const A = fakeStage("A", "front"), B = fakeStage("B", "back");
  bridge.setStageClient("front", A);
  bridge.setStageClient("back", B);
  B.hold = (f) => f === 3;
  // While frame 2 is still pushing to asset service (latter half of a host frame), frame 3 sent ahead
  // via speculative push is already on B: swap at this point: node is not waiting for any frame at
  // this moment
  let pushDone;
  const pushing = new Promise((res) => { pushDone = res; });
  const r = rig({ stages: { A, B }, afterFrame: (f) => (f === 2 ? pushing : undefined) });
  await r.run(() => B.waiting.has(3) && r.htmlOf.has(2));
  await swap(B, A);
  B.release(3);
  await flush();
  pushDone();
  await r.run(() => r.result !== null);
  assert.equal(r.baker.diag().redos, 0, "Change of hands between two frames: relies on checking the slot before each frame, not on a mid-frame redo");
  assert.deepEqual(B.bakedFrames(), [0, 1, 2, 3], "B has only the frames from before the swap; frame 3 sent ahead (answered with cancelled) is invalidated");
  assert.deepEqual(A.bakedFrames(), [3, 4, 5, 6, 7, 8, 9], "From frame 3 on, baking happens on the new background");
  const aPush = A.calls.findIndex((c) => c[0] === "setProject");
  assert.ok(aPush >= 0 && aPush < A.calls.findIndex((c) => c[0] === "bakeFrame"), "Re-push first, then bake frames");
  assert.equal(r.baker.diag().restages, 1, "Check the background slot before each frame: a change of hands is detected once");
  assert.equal(r.of("task.release").length + r.of("task.fail").length, 0, "No release, no failure");
  assert.deepEqual(r.result.frames, base.frames);
  assert.deepEqual([...r.htmlOf.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h), base.html, "byte-for-byte identical");
});

for (const variant of ["cancelled", "late-event"]) {
  test(`QM-F-04 The background slot changes hands in the middle of a frame (${variant === "cancelled" ? "The old stage replies cancelled" : "The old stage finished, but its event arrived after the swap and was filtered out by role"}): re-push and redo this frame on the new background, not counted as a failure; byte-for-byte identical`, async () => {
    const base = await baseline();
    const A = fakeStage("A", "front"), B = fakeStage("B", "back");
    bridge.setStageClient("front", A);
    bridge.setStageClient("back", B);
    const r = rig({ stages: { A, B } });
    // Control with ticks: frame 5 is requested by node directly (first block the frame sent ahead via
    // speculative push: swap before it returns)
    if (variant === "cancelled") {
      B.hold = (f) => f === 5;
      await r.run(() => B.waiting.has(5));
      // Wait until node is actually waiting for frame 5 (frame 4 already recorded)
      await r.run(() => r.htmlOf.has(4));
      await swap(B, A);
      B.release(5);
    } else {
      B.hold = (f) => f === 5;
      B.lateEvent = (f) => f === 5;
      await r.run(() => B.waiting.has(5));
      await r.run(() => r.htmlOf.has(4));
      // Old stage finishes frame 5; swap while events and response are still in transit: when events reach
      // parent page, B is already foreground and filtered out by registry by role, response ok follows
      // behind
      B.release(5);
      await r.run(() => B.late.length === 1, 50);
      await swap(B, A);
      B.flushLate();
    }
    await r.run(() => r.result !== null);
    assert.equal(r.of("task.fail").length, 0, "Not counted as a failure");
    assert.equal(r.of("task.release").length, 0);
    assert.ok(A.bakedFrames().includes(5), `Frame 5 redone on the new background: A ${JSON.stringify(A.bakedFrames())}`);
    assert.ok(r.baker.diag().redos >= 1, JSON.stringify(r.baker.diag()));
    assert.equal(r.bakedOn.get(5), "A");
    assert.deepEqual(r.result.frames, base.frames);
    assert.deepEqual([...r.htmlOf.entries()].sort((a, b) => a[0] - b[0]).map(([, h]) => h), base.html, "byte-for-byte identical");
  });
}

test("QM-F-04b When the background slot has not changed hands, a stage reply of cancelled is still handed back as a retryable failure (behavior unchanged)", async () => {
  const A = fakeStage("A", "front"), B = fakeStage("B", "back");
  bridge.setStageClient("front", A);
  bridge.setStageClient("back", B);
  // Both the speculatively sent attempt for frame 2 and the attempt requested directly by the node
  // return cancelled (background has always been B)
  let n2 = 0;
  const orig = B.bakeFrame;
  B.bakeFrame = async (req) => {
    if (req.localFrame === 2 && n2++ < 2) { B.calls.push(["bakeFrame", 2]); return { ok: false, reason: "cancelled" }; }
    return orig(req);
  };
  const r = rig({ stages: { A, B } });
  await r.run(() => r.of("task.fail").length > 0 || r.result !== null);
  assert.equal(r.of("task.fail").length, 1, "Handed back as a failure");
  const f = r.of("task.fail")[0];
  assert.equal(f.retryable, true);
  assert.match(String(f.error), /cancelled/);
  assert.equal(r.baker.diag().redos, 0, "No change of hands, no redo");
});

test("QM-F-05 A bake job opened just after a catch-up run finished and before the swap: frames come only from the background after the swap; the new front ends up in the front role", async () => {
  const base = await baseline();
  const A = fakeStage("A", "front"), B = fakeStage("B", "back");
  bridge.setStageClient("front", A);
  bridge.setStageClient("back", B);
  // Catch-up run occupies single-flight queue first
  let finishCatchup;
  const gate = new Promise((res) => { finishCatchup = res; });
  const catchup = jobs.runBackJob("catchup", async () => { await bridge.pushProject("back", PROJECT, { reset: true }); await gate; });
  await flush();
  // Node does not claim during catch-up run (not idle); here queue its job directly behind catch-up
  // run: simulating that upon claim it is still fetching project (prep) when catch-up run arrives
  const r = rig({ stages: { A, B } });
  await flush();
  assert.equal(r.of("task.claim").length, 0, "The catch-up run is running: the node is not idle and does not claim");
  // Claim once (bypass idle check, simulating already claimed and still in prep before catch-up run
  // arrives)
  r.node.receive({ type: "task.claimed", id: TASK.id, token: 1, version: 2, leaseUntil: Infinity, task: { ...TASK, state: "claimed", version: 2 } });
  await flush();
  // Catch-up run finishes, immediately followed by swap (runSettleSwap: swapAndDress after await
  // catchUpBack)
  finishCatchup();
  await catchup;
  await swap(B, A);
  await r.run(() => r.result !== null || r.of("task.fail").length > 0);
  assert.equal(r.of("task.fail").length, 0, JSON.stringify(r.of("task.fail")));
  assert.deepEqual(B.bakedFrames(), [], `Frames do not come from the old background (now the front): ${JSON.stringify(B.calls)}`);
  assert.deepEqual(A.bakedFrames(), [...Array(FRAMES).keys()]);
  assert.equal(B.role, "front", `The new front's final role: ${JSON.stringify(B.calls)}`);
  // What the script sees: bake job was spawned from single-flight queue before swap, job recorded
  // stage as old background B; when checking position before frame 1, switched to A and re-fed on A
  assert.equal(r.baker.diag().restages, 1, "The job was opened on the old background, and the change of hands is detected before the first frame");
  assert.equal(B.calls.filter((c) => c[0] === "setProject").length, 1, "B received only the whole-scene project of the catch-up run, not the isolated single-card project");
  assert.deepEqual(r.result.frames, base.frames);
});

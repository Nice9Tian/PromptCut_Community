/**
 * Online export requesting render nodes has a bounded wait (added after review; see "how to wait"
 * in the file header of `src/export/exportFrames.ts`).
 * Run: node --test src/export/exportRetry.test.mjs
 *
 *   XR-01 Plan already failed: report `failed` in the response as failure, not as "no render nodes
 *         online"
 *   XR-02 Plan completed without index: report failure after waiting one round, instead of staying
 *         at "preparing" forever
 *   XR-03 Task already failed while waiting for manifest (page never received notification): response
 *         is `failed` when checking task, report failure
 *   XR-04 Task is gone while waiting for manifest (deleted after page disconnected too long):
 *         republish as is, queue rebuilds, node resumes, export arrives as usual
 *   XR-05 Node exits right after switching plan: report failure with explanation when time limit is
 *         reached with no progress; being claimed by a node is not considered no progress
 *   XR-06 Click export again after failure: plan carries new identifier (new plan id,
 *         `input.exportSalt`); never-failed ones do not carry it; queue inbound validation accepts it
 *   XR-07 Do not use those without input signature: clips without signatures in the index report
 *         failure; streams without signatures in the layer table are not fetched during export
 *   XR-08 Decoded width does not match rectangle in manifest: report error, do not crop
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInbound } from "../../server/render-queue/messages.mjs";

const F = await import(srcUrl("export/exportFrames.ts"));
const S = await import(srcUrl("export/streamFrames.ts"));
const T = await import(srcUrl("export/text.ts"));

const RK = "a".repeat(64);
const hashOf = (n) => n.toString(16).padStart(64, "0");
const derived = (from, to) => ({ id: `stream:${RK}:${from}-${to}`, kind: "stream", resultKey: RK, range: { unit: "segment", from, to },
  source: { projectId: "p1", projectRev: 7, derivedFrom: "plan:x" }, input: { clipId: "s", exportFrames: true, exportKey: "k" }, weight: { class: "medium" }, requires: {}, priority: 60 });
const indexOf = (over = {}) => ({ v: 1, projectRev: 7, unsupported: [], streams: [{ clipId: "s", kind: "card", plane: "local", resultKey: RK, envFingerprint: "f".repeat(16),
  originFrame: 12, lastFrame: 20, lastSegment: 0, segmentsPerTask: 8, fps: 30, rect: { x: 0, y: 0, w: 64, h: 32 }, offset: { x: 0, y: 0 }, inputSig: "s1-abc", tasks: [derived(0, 0)], ...over }] });
const manifest = () => ({ v: 1, kind: "export-frames", resultKey: RK, range: { from: 0, to: 0 }, header: {}, frames: Array.from({ length: 9 }, (_, i) => [12 + i, hashOf(12 + i), 10]) });

/** Mock document service: `states` is task id → status in response (function or string); `clock` advances `tick` ms on each sleep */
function service({ tick = 1000 } = {}) {
  const listeners = new Set();
  const manifests = new Map();
  const published = [];
  const states = new Map();
  let t = 0;
  const hooks = { onSleep: null };
  const deps = {
    publisherId: "page-test", codeVersion: null, now: () => t,
    async request(msg) {
      if (msg.type === "publisher.hello") return { type: "publisher.welcome" };
      if (msg.type === "task.publish") {
        published.push(msg.tasks.map((x) => x.id));
        return { type: "task.published", results: msg.tasks.map((x) => { const s = states.get(x.id); return { id: x.id, state: typeof s === "function" ? s() : s ?? "open" }; }) };
      }
      if (msg.type === "content.get") { const body = manifests.get(msg.key); return body ? { type: "content.item", body } : { type: "content.item", missing: true }; }
      return { type: "error" };
    },
    subscribeQueue(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    assetBase: () => "https://asset.test", authHeaders: async () => ({}),
    sleep: async (ms, signal) => { if (signal.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true }); t += tick ?? ms; await new Promise((r) => setImmediate(r)); await hooks.onSleep?.(); },
  };
  return { deps, manifests, published, states, hooks, emit: (m) => { for (const l of [...listeners]) l(m); } };
}
const request = (svc, over = {}) => F.requestExportFrames({ projectId: "p1", projectRev: 7, project: {}, clips: ["s"], deps: svc.deps, signal: new AbortController().signal, ...over });
const planOf = () => F.exportPlanTask({ projectId: "p1", projectRev: 7, clips: ["s"], salt: F.exportRetrySalt() });
/** Plan completed, index arrives with `task.done` */
const finishPlan = (svc, index = indexOf()) => { const plan = planOf(); svc.states.set(plan.id, "done"); svc.emit({ type: "task.done", id: plan.id, result: { exportIndex: index } }); };

test("XR-01 The plan has already failed: report the failure, do not treat it as \"no render node online\"", async () => {
  F.resetExportRetry();
  const svc = service();
  svc.states.set(planOf().id, "failed");
  const statuses = [];
  await assert.rejects(request(svc, { onStatus: (s) => statuses.push(s.phase) }), (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeFailed("plan-failed"));
  assert.deepEqual(statuses, ["publishing"], "\"No render node online\" was never shown");
  assert.ok(F.exportRetrySalt(), "The next one carries a new identifier");
});

test("XR-02 The plan finished but carries no index: report failure after waiting one round", async () => {
  F.resetExportRetry();
  const svc = service();
  svc.states.set(planOf().id, "done");
  await assert.rejects(request(svc), (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeFailed("no-index"));
  assert.equal(svc.published.length, 2);
});

test("XR-03 The task had already failed while waiting for the manifest and the page never received a notice: report the failure when checking the task", async () => {
  F.resetExportRetry();
  const svc = service();
  svc.states.set(`stream:${RK}:0-0`, "failed");
  svc.hooks.onSleep = async () => { if (svc.published.length === 1) finishPlan(svc); };
  await assert.rejects(request(svc), (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeFailed("task-failed"));
  assert.deepEqual(svc.published.at(-1), [`stream:${RK}:0-0`], "Republished the task that had not arrived, unchanged");
});

test("XR-04 The task is gone while waiting for the manifest: republish it unchanged (queue rebuilt), after which everything arrives as usual", async () => {
  F.resetExportRetry();
  const svc = service();
  let rounds = 0;
  svc.hooks.onSleep = async () => {
    rounds++;
    if (rounds === 1) finishPlan(svc);
    // Node only resumes and finishes after the task is republished
    if (svc.published.some((ids) => ids[0] === `stream:${RK}:0-0`) && rounds >= 3) svc.manifests.set(`${RK}:0-0`, manifest());
  };
  const got = await request(svc);
  assert.equal(got.coverage.get("s").frames.size, 9);
  const reposts = svc.published.filter((ids) => ids[0] === `stream:${RK}:0-0`);
  assert.ok(reposts.length >= 1);
  const sent = parseInbound({ type: "task.publish", tasks: [derived(0, 0)] });
  assert.equal(sent.ok, true, "The task carried in the index can be sent out unchanged (the queue's inbound validation accepts it)");
  assert.equal(F.exportRetrySalt(), null, "No identifier if it never failed");
});

test("XR-05 The node has exited: report failure once the no-progress time limit is reached; it does not count while a node has claimed it", async () => {
  F.resetExportRetry();
  // Task stays open (nobody accepts): advances 1 second per sleep, 5-second timeout
  const svc = service({ tick: 1000 });
  svc.hooks.onSleep = async () => { if (svc.published.length === 1) finishPlan(svc); };
  const statuses = [];
  await assert.rejects(request({ ...svc, deps: { ...svc.deps, stallMs: 5000, taskCheckMs: 2000 } }, { onStatus: (s) => statuses.push(s.phase) }),
    (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeStalled(5000) && /no progress for 5 s/.test(e.message));
  assert.ok(statuses.filter((p) => p === "rendering").length >= 4, "Until the time limit, it keeps showing as rendering");
  assert.match(T.ONLINE_EXPORT_TEXT.nodeStalled(F.EXPORT_STALL_MS), /no progress for 3 min/);
  // Claimed by a node: no error even after twice the timeout, complete once manifest arrives
  F.resetExportRetry();
  const busy = service({ tick: 1000 });
  busy.states.set(`stream:${RK}:0-0`, "claimed");
  let rounds = 0;
  busy.hooks.onSleep = async () => { rounds++; if (rounds === 1) finishPlan(busy); if (rounds === 12) busy.manifests.set(`${RK}:0-0`, manifest()); };
  const got = await request({ ...busy, deps: { ...busy.deps, stallMs: 5000, taskCheckMs: 2000 } });
  assert.equal(got.coverage.get("s").frames.size, 9);
});

test("XR-06 Clicking export again after a failure: the plan carries a new identifier", async () => {
  F.resetExportRetry();
  const plain = F.exportPlanTask({ projectId: "p1", projectRev: 7, clips: ["s"] });
  assert.equal(plain.input.exportSalt, undefined);
  const svc = service();
  svc.states.set(plain.id, "failed");
  await assert.rejects(request(svc));
  const salt = F.exportRetrySalt();
  assert.match(salt, /^[0-9a-z]{1,32}$/);
  // Next time: new plan id, with identifier; queue accepts it
  const again = service();
  let seen = null;
  again.hooks.onSleep = async () => { seen = again.published[0][0]; finishPlan(again); again.manifests.set(`${RK}:0-0`, manifest()); };
  await request(again);
  const retry = F.exportPlanTask({ projectId: "p1", projectRev: 7, clips: ["s"], salt });
  assert.equal(seen, retry.id);
  assert.notEqual(retry.id, plain.id);
  assert.equal(retry.input.exportSalt, salt);
  assert.equal(parseInbound({ type: "task.publish", tasks: [retry] }).ok, true);
  assert.equal(parseInbound({ type: "task.publish", tasks: [retry] }).body.tasks[0].input.exportSalt, salt);
  assert.equal(F.exportPlanTask({ projectId: "p1", projectRev: 7, clips: ["s"], salt: "Bad Salt!" }).id, plain.id, "a malformed identifier is treated as not provided");
});

test("XR-07 Those without an input signature are not used", async () => {
  F.resetExportRetry();
  const svc = service();
  svc.hooks.onSleep = async () => { if (svc.published.length === 1) finishPlan(svc, indexOf({ inputSig: undefined })); };
  await assert.rejects(request(svc), (e) => e.message === T.ONLINE_EXPORT_TEXT.nodeFailed("no-input-signature"));
  // Streams in layer table: rows without signatures are not fetched during export
  const init = "0123456789abcdef";
  const row = (extra) => ({ clipIds: ["a"], topClipId: "a", kind: "card", plane: "local", contentKey: "ck", candidates: [{ envFingerprint: "f".repeat(16), resultKey: RK }], originFrame: 12, lastSegment: 0, segmentsPerTask: 8, ...extra });
  const deps = (streams) => ({
    assetBase: () => null, authHeaders: async () => ({}),
    async request(msg) {
      if (msg.key === "layers:proj") return { type: "content.item", body: { v: 3, kind: "layer-map", layers: [], streams } };
      if (msg.key === `${RK}:0-0`) return { type: "content.item", body: { kind: "stream", resultKey: RK, header: { fps: 30 }, inits: { [init]: { hash: hashOf(1), rect: { x: 0, y: 0, w: 64, h: 32 } } }, segments: { 0: { hash: hashOf(2), init, stride: 1, samples: 9 } } } };
      return { type: "content.item", missing: true };
    },
  });
  assert.equal((await S.loadReadableStreams("proj", {}, deps([row({})]))).length, 0, "No signature: not fetched");
  const signed = await S.loadReadableStreams("proj", {}, deps([row({ inputSig: "s1-abc" })]));
  assert.equal(signed.length, 1);
  assert.equal(signed[0].dense.get(0), 9);
});

test("XR-08 The decoded width does not match the rectangle in the manifest: report an error, do not crop", () => {
  assert.equal(S.frameWidthOf(64, { x: 0, y: 0, w: 64, h: 32 }, 12), 64);
  assert.throws(() => S.frameWidthOf(48, { x: 0, y: 0, w: 64, h: 32 }, 12), /does not match the segment/);
  assert.throws(() => S.frameWidthOf(80, { x: 0, y: 0, w: 64, h: 32 }, 12), /does not match the segment/);
});

test("XR-09 Concurrency and throttling for export-only plans: concurrent runs from the same publisher on the same project are rejected while one is in progress", async () => {
  F.resetExportRetry();
  const svc = service();
  let release = null;
  const holding = new Promise((r) => { release = r; });
  svc.hooks.onSleep = async () => {
    // Simulate executing/waiting for node upon entering sleep for the first time
    if (release) await holding;
  };
  const firstP = request(svc);
  // Wait for it to enter execution
  await new Promise((r) => setImmediate(r));
  // Concurrently initiate a second request at this point: must be blocked by rate limiting
  await assert.rejects(
    request(svc),
    (err) => err.throttled === true && /already has an export plan waiting or running/.test(err.message)
  );
  // Release the first request to let it end in failure
  const rel = release;
  release = null;
  svc.states.set(planOf().id, "failed");
  rel();
  await assert.rejects(firstP);
  // Rate limiting state cleared after resetExportRetry
  F.resetExportRetry();
  const state = F.exportPlanThrottleState("p1", svc.deps.publisherId);
  assert.equal(state, null, "resetExportRetry clears the throttle state");
});


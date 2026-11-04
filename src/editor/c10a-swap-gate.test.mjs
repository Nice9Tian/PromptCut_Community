/**
 * C10a capability gate: when there is only one stage, do not catch up live render via background
 * stage and do not start background stage tasks (`docs/plan/c10a-contract.md` section 8 "Do not
 * catch up live render", "Do not open background stage", section 12 "Capability gate"; starting
 * 2026-10-22, gate is changed from revoked old tiers to "only one stage": stage gate level 1, lowest
 * tier, fallback on handshake failure).
 * Run: node --experimental-test-module-mocks --test src/editor/c10a-swap-gate.test.mjs
 *
 * Follows `stageSwap.test.mjs`: store, stage bridge, background task queue, dispatch table, identity
 * table, and snapshot delivery are all mocked to create a scenario that is guaranteed to take
 * "background catch-up run then swap" under dual stage (classify as heavy, `vtOk = false`), then
 * enable "only one stage":
 * `runSettleSwap` / `runPlayingSwap` must do nothing: do not schedule background tasks (`runBackJob`),
 * do not feed project or `render` to background stage, do not swap.
 *
 * Where the gate comes from: hypothesis K3 (after integration reconciliation), `stageSwap.ts` asks
 * host `SwapHost.singleStage()` (filled by `singleStageSwapHost`).
 * Skip entire suite when `src/online/onlineTier.ts` is absent.
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { exists, skipIf, TIER_FILE, singleStageSwapHost } from "../../server/test/c10a-kit.mjs";

const missing = !exists(TIER_FILE);
const skip = skipIf(missing, `${TIER_FILE} (the single-stage gate of stageSwap comes with it)`);
const it = (name, fn) => test(name, { skip }, fn);

globalThis.window = globalThis;

const log = [];
const state = { project: null, t: 0, playing: false };
let plan = { segments: [] };
let costs = [];
let identityKeys = {};
const listeners = new Set();
const emit = (e) => { for (const l of [...listeners]) l(e); };
let front = null;
let back = null;

let swap = null;
if (!missing) {
  mock.module(srcUrl("online/mode.ts"), { exports: { ONLINE: true } });
  mock.module(srcUrl("store/project.ts"), { exports: { getState: () => state } });
  mock.module(srcUrl("editor/stageBridge.ts"), {
    exports: {
      frontStage: () => front,
      backStage: () => back,
      onStageEvent: (l) => { listeners.add(l); return () => listeners.delete(l); },
      pushProject: async (role) => { log.push(["pushProject", role]); },
      syncProject: async (role) => { log.push(["syncProject", role]); },
    },
  });
  mock.module(srcUrl("editor/stageJobs.ts"), {
    exports: {
      runBackJob: async (kind, run) => { log.push(["runBackJob", kind]); return run({ stage: back, signal: new AbortController().signal }); },
    },
  });
  mock.module(srcUrl("editor/planDispatch.ts"), {
    exports: {
      currentPlan: () => plan,
      currentCosts: () => costs,
      currentTuning: () => undefined,
      sendPlanTo: async (role, opts) => { log.push(["sendPlanTo", role, opts]); },
    },
  });
  mock.module(srcUrl("editor/costIdentity.ts"), { exports: { clipIdentityOf: () => ({ identityKeys, frameModes: {} }) } });
  mock.module(srcUrl("editor/snapshotFeed.ts"), {
    exports: {
      clearSettled: () => {},
      deliverSnapshots: async () => 0,
      markBaselineReset: () => {},
      markAllSettled: () => {},
      setExtraSuppressed: (ids) => log.push(["setExtraSuppressed", [...ids]]),
      suppressedAt: () => [],
      streamPlanesAt: () => [],
    },
  });
  mock.module(srcUrl("editor/demote.ts"), { exports: { onStageDemote: async (id) => ({ ok: true, clipId: id }) } });
  swap = await import(srcUrl("editor/stageSwap.ts"));
}

function fakeStage(name) {
  const st = { name };
  const rec = (method) => async (...args) => { log.push([name, method, ...args]); return { ok: true }; };
  for (const m of ["setRole", "setLocalHashes", "setSuppressed", "setStreamPlanes", "setSnapshots", "setPlaying", "setScrubbing", "setProxy", "play", "render"]) st[m] = rec(m);
  st.setMediaT = async (sec) => { log.push([name, "setMediaT", sec]); emit({ type: "mediaReady" }); return { ok: true }; };
  st.pause = async (opts) => { log.push([name, "pause", opts]); queueMicrotask(() => emit({ type: "frame", sec: opts.atSec })); return { ok: true, passed: false }; };
  return st;
}

const FPS = 30;
const card = (id, start, end) => ({ id, cardId: "c", start, end, params: {} });
const project = (clips) => ({ version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: "t", name: "t", clips }] });
const withRecord = (clipId, record) => {
  identityKeys[clipId] = `k-${clipId}`;
  costs.push({ identityKey: `k-${clipId}`, device: "d", ...record });
};

beforeEach(() => {
  if (!swap) return;
  swap.resetStageSwap();
  log.length = 0;
  listeners.clear();
  costs = [];
  identityKeys = {};
  front = fakeStage("A");
  back = fakeStage("B");
  // Integration reconciliation (K3): single-stage gate is on SwapHost.singleStage()
  swap.setSwapHost(singleStageSwapHost({
    swapRoles() { log.push(["swapRoles"]); [front, back] = [back, front]; return { front, back }; },
    proxy: () => true,
    localHashes: () => ["h1"],
  }));
});

/** Under dual stage, these two scenarios will definitely trigger catch-up run (same dataset as "paused-state swap" and "playing-state swap" in stageSwap.test.mjs) */
const TOUCHES_BACK = (e) => e[0] === "runBackJob" || e[0] === "swapRoles" || (e[0] === "pushProject" && e[1] === "back") || (e[0] === "B" && (e[1] === "render" || e[1] === "setMediaT"));

it("C10A-GT-05 After a pause, no catch-up to live render: when heavy cards and cards with vtOk = false are present and there is only one stage, runSettleSwap does nothing", async () => {
  Object.assign(state, { project: project([card("h", 0, 10)]), t: 1, playing: false });
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["h"]) }] };
  withRecord("h", { vtOk: false });
  assert.equal(await swap.runSettleSwap(1), false);
  assert.deepEqual(log.filter(TOUCHES_BACK), [], `The background stage must not be touched: ${JSON.stringify(log)}`);
  assert.equal(front.name, "A", "No swap");
  assert.equal(swap.swapInFlight(), false);
});

it("C10A-GT-06 No catch-up during playback either: when cards classified as light and tier (b) cards are present and there is only one stage, runPlayingSwap does nothing", async () => {
  Object.assign(state, { project: project([card("b", 0, 10)]), t: 1, playing: true });
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set() }] };
  withRecord("b", { vtOk: false, stepMs: 2, stepMaxMs: 3, catchUpMs: 200 });
  assert.equal(await swap.runPlayingSwap(["b"]), false);
  assert.deepEqual(log.filter(TOUCHES_BACK), [], `The background stage must not be touched: ${JSON.stringify(log)}`);
  assert.equal(front.name, "A");
});

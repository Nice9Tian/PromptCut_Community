/**
 * Regression test for root cause A: user modified timeline (deleted clip) during K5 path 2
 * catch-up run; after swap, the new front must not stay on the old project. Run:
 *   node --experimental-test-module-mocks --test src/editor/stageSwapBaseline.test.mjs
 *
 * Previously Preview's `swapRoles` used `markPushed("front", getState().project)` to record the new
 * front's baseline as the latest project, whereas it actually held `pushProject("back", oldProject)`
 * from when the catch-up run started: afterwards `syncProject` was not sent because baselines were
 * identical, or only sent a delta applied onto the old project, leaving deleted clips permanently
 * on stage.
 *
 * Now: baseline is recorded by iframe (client), following the client during swap
 * (`swapStageClients`); after swap, `swapAndDress` pushes an extra `syncProject` delta. Both swap
 * paths, pause state (`runSettleSwap`) and playing state (`runPlayingSwap`), are covered.
 *
 * Real modules: stageSwap.ts, stageBridge.ts, changedClips.mjs (`applyProjectPatch` simulates
 * stage-side merge).
 * Fakes: store, background queue, dispatch table, identity table, snapshot delivery, K6.
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;

const state = { project: null, t: 1, playing: false };
let costs = [];
let identityKeys = {};
mock.module(srcUrl("store/project.ts"), { exports: { getState: () => state } });
mock.module(srcUrl("editor/stageJobs.ts"), { exports: { runBackJob: async (_k, run) => run({ stage: bridge.backStage(), signal: new AbortController().signal }) } });
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["h"]) }] }), currentCosts: () => costs, currentTuning: () => undefined, sendPlanTo: async () => {} } });
mock.module(srcUrl("editor/costIdentity.ts"), { exports: { clipIdentityOf: () => ({ identityKeys, frameModes: {} }) } });
mock.module(srcUrl("editor/snapshotFeed.ts"), { exports: { clearSettled: () => {}, deliverSnapshots: async () => 0, markBaselineReset: () => {}, markAllSettled: () => {}, setExtraSuppressed: () => {}, suppressedAt: () => [], streamPlanesAt: () => [] } });
mock.module(srcUrl("editor/demote.ts"), { exports: { onStageDemote: async () => ({ ok: true }) } });

const bridge = await import(srcUrl("editor/stageBridge.ts"));
const swap = await import(srcUrl("editor/stageSwap.ts"));
const { applyProjectPatch } = await import(srcUrl("render/changedClips.mjs"));

/**
 * Fake stage: setProject merges according to StageView rules (full replacement / delta
 * applyProjectPatch), recording what was received each time
 */
function fakeStage(name) {
  const st = { name, disposed: false, project: null, gate: null, received: [], listener: null };
  st.setProject = async (next, opts = {}) => {
    st.received.push(next.kind === "tracks" ? "patch" : opts.reset ? "full+reset" : "full");
    st.project = next.kind === "full" ? next.project : next.kind === "tracks" ? applyProjectPatch(st.project, next) : next;
    return { ok: true };
  };
  for (const m of ["setRole", "setLocalHashes", "setSuppressed", "setStreamPlanes", "setSnapshots", "setPlaying", "setScrubbing", "setProxy", "play"]) st[m] = async () => ({ ok: true });
  st.render = async () => { if (st.gate) await st.gate; return { ok: true }; };
  st.setMediaT = async () => { queueMicrotask(() => st.listener?.({ type: "mediaReady" })); return { ok: true }; };
  st.pause = async ({ atSec }) => { queueMicrotask(() => st.listener?.({ type: "frame", sec: atSec })); return { ok: true, stoppedAt: atSec }; };
  st.onEvent = (l) => { st.listener = l; return () => { st.listener = null; }; };
  return st;
}

const card = (id, params = {}) => ({ id, cardId: "c", start: 0, end: 10, params });
const P0 = { version: 1, fps: 30, width: 1920, height: 1080, duration: 20, media: [], tracks: [{ id: "t", clips: [card("h"), card("gone")] }] };
const idsOf = (p) => p.tracks[0].clips.map((c) => c.id);

let rpc;
let frontId;
beforeEach(async () => {
  bridge.resetStageBridge();
  swap.resetStageSwap();
  identityKeys = { h: "k-h" };
  costs = [{ identityKey: "k-h", device: "d", vtOk: false, stepMs: 2, stepMaxMs: 3, catchUpMs: 200 }];
  Object.assign(state, { project: P0, t: 1, playing: false });
  rpc = { A: fakeStage("A"), B: fakeStage("B") };
  frontId = "A";
  bridge.setStageClient("front", rpc.A);
  bridge.setStageClient("back", rpc.B);
  await bridge.syncProject("front", P0);
  // host.swapRoles and Preview.tsx's swapRoles use the same approach: only swap clients, baseline moves with client
  swap.setSwapHost({
    swapRoles() {
      const cur = frontId, nextId = cur === "A" ? "B" : "A";
      frontId = nextId;
      bridge.swapStageClients({ client: rpc[nextId] }, { client: rpc[cur] });
      return { front: rpc[nextId], back: rpc[cur] };
    },
    proxy: () => false, localHashes: () => [],
  });
});

test("Paused state: clip deleted during the catch-up run → after the swap the new front no longer contains the deleted clip, and it was brought up to date with a delta", async () => {
  let release; rpc.B.gate = new Promise((r) => { release = r; });
  const running = swap.runSettleSwap(1);
  await new Promise((r) => setTimeout(r, 10));
  // During catch-up run, user deletes "gone" on timeline (t did not move, not playing)
  const P1 = { ...P0, tracks: [{ id: "t", clips: [card("h")] }] };
  state.project = P1;
  await bridge.syncProject("front", P1);   // Preview project effect: only pushed to front (A) at that time
  release();
  assert.equal(await running, true, "the swap happened");

  const front = bridge.frontStage();
  assert.equal(front.name, "B");
  assert.deepEqual(idsOf(front.project), ["h"], "the new front no longer contains the deleted clip (a catch-up push was sent after the swap)");
  assert.equal(front.received.at(-1), "patch", "the catch-up push is a delta, not a full reload (that would cut off the tick loop that just started)");
  assert.equal(bridge.pushedProject("front"), P1);

  // Modify once more afterwards: delta is applied onto the correct base
  const P2 = { ...P1, tracks: [{ id: "t", clips: [card("h", { text: "x" })] }] };
  state.project = P2;
  await bridge.syncProject("front", P2);
  assert.deepEqual(idsOf(front.project), ["h"]);
  assert.equal(front.project.tracks[0].clips[0].params.text, "x");
  // Old front (A) is now back, its baseline is still P1 that it actually holds
  assert.equal(bridge.pushedProject("back"), P1);
});

test("Playing state: clip deleted during the catch-up run → the new front is brought up to date the same way after the swap", async () => {
  state.playing = true;
  let release; rpc.B.gate = new Promise((r) => { release = r; });
  const running = swap.runPlayingSwap(["h"]);
  await new Promise((r) => setTimeout(r, 10));
  const P1 = { ...P0, tracks: [{ id: "t", clips: [card("h")] }] };
  state.project = P1;
  await bridge.syncProject("front", P1);
  release();
  assert.equal(await running, true, "the swap happened");
  const front = bridge.frontStage();
  assert.equal(front.name, "B");
  assert.deepEqual(idsOf(front.project), ["h"]);
  assert.equal(front.received.at(-1), "patch");
});

test("A swap with no edits sends nothing extra: the new front's baseline is the one it already holds, and the catch-up push sends nothing", async () => {
  const running = swap.runSettleSwap(1);
  assert.equal(await running, true);
  const front = bridge.frontStage();
  assert.equal(front.name, "B");
  assert.deepEqual(front.received, ["full+reset"], "only the single full load at the start of the catch-up run");
});

test("The baseline follows the client: when the same client moves to another position, the baseline is not lost", async () => {
  bridge.swapStageClients({ client: rpc.B }, { client: rpc.A });
  assert.equal(bridge.pushedProject("back"), P0, "A's baseline followed A to back");
  assert.equal(bridge.pushedProject("front"), null, "B never received the project");
});

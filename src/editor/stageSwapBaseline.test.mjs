/**
 * 根因 A 的回归测试:K5 第二路补跑期间用户改了时间轴(删片段),互换之后新 front 不能停在旧项目上。
 * 跑:node --experimental-test-module-mocks --test src/editor/stageSwapBaseline.test.mjs
 *
 * 以前 Preview 的 `swapRoles` 用 `markPushed("front", getState().project)` 把新 front 的基线记成最新项目,
 * 而它手里其实是补跑开始时 `pushProject("back", 旧项目)` 那一份 —— 之后 `syncProject` 因为基线相同不发,
 * 或者只发一个增量打在旧项目上,被删的片段永远留在舞台上。
 *
 * 现在:基线按 iframe(客户端)记,互换时跟着客户端走(`swapStageClients`);互换之后 `swapAndDress`
 * 补推一次 `syncProject` 增量。暂停态(`runSettleSwap`)和播放态(`runPlayingSwap`)两条互换路都覆盖。
 *
 * 真模块:stageSwap.ts、stageBridge.ts、changedClips.mjs(`applyProjectPatch` 模拟舞台侧合并)。
 * 假的:store、后台队列、分派表、身份表、快照投递、K6。
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

/** 假舞台:setProject 按 StageView 的规则合并(full 替换 / 增量 applyProjectPatch),记下每次收到的是什么 */
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
  // host.swapRoles 和 Preview.tsx 的 swapRoles 同一个做法:只对调客户端,基线跟着客户端走
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

test("暂停态:补跑期间删片段 → 互换后新 front 不含被删片段,而且是增量补上的", async () => {
  let release; rpc.B.gate = new Promise((r) => { release = r; });
  const running = swap.runSettleSwap(1);
  await new Promise((r) => setTimeout(r, 10));
  // 补跑期间用户在时间轴上删掉 "gone"(t 没动、没在播放)
  const P1 = { ...P0, tracks: [{ id: "t", clips: [card("h")] }] };
  state.project = P1;
  await bridge.syncProject("front", P1);   // Preview 的项目 effect:只推给当时的 front(A)
  release();
  assert.equal(await running, true, "互换发生了");

  const front = bridge.frontStage();
  assert.equal(front.name, "B");
  assert.deepEqual(idsOf(front.project), ["h"], "新 front 已经不含被删片段(互换后补推了一次)");
  assert.equal(front.received.at(-1), "patch", "补推的是增量,不是整份重灌(那会掐掉刚起的节拍)");
  assert.equal(bridge.pushedProject("front"), P1);

  // 之后再改一次:增量打在正确的底子上
  const P2 = { ...P1, tracks: [{ id: "t", clips: [card("h", { text: "x" })] }] };
  state.project = P2;
  await bridge.syncProject("front", P2);
  assert.deepEqual(idsOf(front.project), ["h"]);
  assert.equal(front.project.tracks[0].clips[0].params.text, "x");
  // 旧 front(A)现在是 back,它的基线还是它自己真正拿着的 P1
  assert.equal(bridge.pushedProject("back"), P1);
});

test("播放态:补跑期间删片段 → 互换后新 front 同样补齐", async () => {
  state.playing = true;
  let release; rpc.B.gate = new Promise((r) => { release = r; });
  const running = swap.runPlayingSwap(["h"]);
  await new Promise((r) => setTimeout(r, 10));
  const P1 = { ...P0, tracks: [{ id: "t", clips: [card("h")] }] };
  state.project = P1;
  await bridge.syncProject("front", P1);
  release();
  assert.equal(await running, true, "互换发生了");
  const front = bridge.frontStage();
  assert.equal(front.name, "B");
  assert.deepEqual(idsOf(front.project), ["h"]);
  assert.equal(front.received.at(-1), "patch");
});

test("没有编辑时互换不多发:新 front 的基线就是它拿着的那份,补推什么都不发", async () => {
  const running = swap.runSettleSwap(1);
  assert.equal(await running, true);
  const front = bridge.frontStage();
  assert.equal(front.name, "B");
  assert.deepEqual(front.received, ["full+reset"], "只有补跑开始时那一次整份灌入");
});

test("基线跟着客户端走:同一个客户端换到另一个位置,基线不丢", async () => {
  bridge.swapStageClients({ client: rpc.B }, { client: rpc.A });
  assert.equal(bridge.pushedProject("back"), P0, "A 的基线跟着 A 到了 back");
  assert.equal(bridge.pushedProject("front"), null, "B 从没收到过项目");
});

/**
 * 撤快照后投递一侧契约对齐(`snapshotFeed.ts`):
 *   - 每张卡的 HTML 快照作废后,deliverSnapshots 在播放中清空 settled 并返回 0,不向舞台派发快照补丁;
 *   - 播放中重卡全量由 suppressed 抑制接管,topDownOrder 保持层序,setBeatSwap / beatSwapDebug 保留兼容签名且无空指针。
 * 跑:node --experimental-test-module-mocks --test src/editor/c10-beat-feed.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

let plan = { segments: [] };
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => plan } });
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: () => {} } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const { deliverSnapshots, setSnapshotSource, syncSnapshotSubscription, resetSnapshotFeed, setBeatSwap, beatSwapDebug, topDownOrder, noteSettled, suppressedAt, SNAPSHOT_THROTTLE_MS } = feed;

let now = 1000;
performance.now = () => now;
const settle = () => new Promise((r) => setImmediate(r));
const FPS = 30;
const card = (id, start, end) => ({ id, cardId: "c", start, end, params: {} });
// 第一条轨道在最上面;同一轨道里后面的片段盖在前面的上面
const project = (tracks) => ({ version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks });

let src;
function fakeSource() {
  const s = { push: null, subscribeReady(_a, _b, on) { s.push = on; return () => {}; }, async fetchSnapshot(kind, key, f) { return `html:${kind}/${key}/${f}`; } };
  return s;
}
function fakeStage() {
  const st = { calls: [] };
  st.setSnapshots = async (patch, opts) => { st.calls.push({ patch, opts }); };
  return st;
}
beforeEach(() => {
  resetSnapshotFeed();
  src = fakeSource();
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  now += 10_000;
});

test("C10-BF-01 撤快照后播放中投递返回 0 并清空 settled;不派发快照 RPC", async () => {
  const p = project([{ id: "t", name: "t", clips: [card("h", 0, 10)] }]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["h"]), light: new Set() }] };
  const stage = fakeStage();
  setBeatSwap(true, { swapMs: 3, occupied: () => 0 });
  assert.equal(beatSwapDebug().on, true);
  noteSettled("front", ["h"]);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), []);
  const delivered = await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
  assert.equal(delivered, 0, "撤快照后 deliverSnapshots 返回 0");
  assert.equal(stage.calls.length, 0, "撤快照后不向舞台派发快照 RPC");
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: false }), ["h"], "播放中清空 settled");
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: true }), ["h"], "播放中重卡在 suppressed 中");
  setBeatSwap(false);
  assert.equal(beatSwapDebug().on, false);
  assert.equal(SNAPSHOT_THROTTLE_MS, 33);
});

test("C10-BF-02 撤快照后按从上到下的层序由 suppressed 接管;deliverSnapshots 返回 0", async () => {
  // 三张重卡:轨道 top 上的 a、轨道 mid 上的 b、c(c 在 b 后面,盖在 b 上面)
  const p = project([
    { id: "top", name: "top", clips: [card("a", 0, 10)] },
    { id: "mid", name: "mid", clips: [card("b", 0, 10), card("c", 0, 10)] },
  ]);
  assert.deepEqual(topDownOrder(p, ["b", "c", "a"]), ["a", "c", "b"]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["a", "b", "c"]), light: new Set() }] };
  const stage = fakeStage();
  setBeatSwap(true, { swapMs: 3, occupied: () => 23.333333 - 6 });
  const ret = await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
  assert.equal(ret, 0, "deliverSnapshots 返回 0");
  assert.equal(stage.calls.length, 0, "不派发快照 RPC");
  const sup = suppressedAt({ project: p, t: 1, playing: true });
  assert.deepEqual(sup, ["a", "b", "c"], "重卡全部进入 suppressed 抑制");
  const d = beatSwapDebug();
  assert.equal(d.last, null, "撤快照后 last 为 null,无空指针");
});

/* ---------------------------------------------------------------- 每层的换帧成本(swap-tuning 任务 A) */

test("ST-A-08 宿主给了每层成本(按卡种):setBeatSwap 保持签名兼容;撤快照后播放中重卡全量抑制", async () => {
  const p = project([
    { id: "top", name: "top", clips: [card("a", 0, 10)] },
    { id: "mid", name: "mid", clips: [card("b", 0, 10), card("c", 0, 10)] },
  ]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["a", "b", "c"]), light: new Set() }] };
  const stage = fakeStage();
  const kindCost = { a: 6, b: 20, c: 2 };
  setBeatSwap(true, { swapMs: 3, occupied: () => 23.333333 - 10, costOf: (_p, id) => kindCost[id] });
  const ret = await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
  assert.equal(ret, 0);
  assert.equal(stage.calls.length, 0);
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: true }), ["a", "b", "c"]);
  assert.equal(beatSwapDebug().on, true);
});

test("ST-A-09 撤快照后不再按大小装箱;beatSwapDebug 保持兼容签名且无空指针隐患", async () => {
  const { SWAP_COST_MODEL, swapCostOfSize } = await import("../render/beatSwap.mjs");
  const big = "<div>" + "x".repeat(400 * 1024) + "</div>";                        // 约 400 KB 文本
  const bmp = '<img src="data:image/webp;base64,' + "A".repeat(400 * 1024) + '">'; // 约 400 KB 位图
  const p = project([{ id: "t1", name: "t1", clips: [card("m", 0, 10)] }, { id: "t2", name: "t2", clips: [card("t", 0, 10)] }]);
  plan = { segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["m", "t"]), light: new Set() }] };
  const stage = fakeStage();
  setBeatSwap(true, { swapMs: 3, occupied: () => 23.333333 - 10, costOf: () => 3 });
  await deliverSnapshots(stage, "front", { project: p, t: 1, playing: true });
  assert.equal(beatSwapDebug().knownSizes, 0, "撤快照后不记录快照大小");
  const mMs = swapCostOfSize({ bytes: bmp.length, bitmap: true });
  const tMs = swapCostOfSize({ bytes: big.length, bitmap: false });
  assert.ok(Math.abs(mMs - (SWAP_COST_MODEL.baseMs + SWAP_COST_MODEL.bitmapMsPerKB * bmp.length / 1024)) < 1e-9);
  assert.ok(tMs > mMs * 3, `同样大小,文本比位图贵得多:${tMs} vs ${mMs}`);
  const d = beatSwapDebug();
  assert.equal(d.last, null, "撤快照后 last 为 null");
  assert.deepEqual(suppressedAt({ project: p, t: 1, playing: true }), ["m", "t"]);
  setBeatSwap(false);
  assert.equal(beatSwapDebug().on, false);
  assert.equal(swapCostOfSize({ bytes: 0 }), null);
  assert.equal(swapCostOfSize(undefined), null);
});

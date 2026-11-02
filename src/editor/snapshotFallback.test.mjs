/**
 * 根因 D 的回归测试 + 兜底顺序在父页一侧的排程(`snapshotFeed.ts`)。
 * 跑:npm test -- src/editor/snapshotFallback.test.mjs
 *
 *  (C) 每张卡的 HTML 快照作废（2026-10-13 用户定）：有流就贴流，不选帧、不取字节、不投递。
 *      流这一拍画不出来由舞台留着上一张、到时占位符(`streamPlayer.ts`)，不再靠垫在下面的「海报」快照。
 *      超出解码器预算的层当「无流」，不进流平面；暂停态进入 scrub 待占位符。
 *  (D) K6 降级卡就绪看流表：从当前位置起 min(fps, 剩余帧数) 都有轨道流覆盖。
 *  快照投递已退役：deliverSnapshots 为空操作返回 0。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
let heavyIds = ["h", "d"];
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: () => {} } });
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(heavyIds) }] }) } });
const feed = await import(srcUrl("editor/snapshotFeed.ts"));
// 同屏流的预算是数像素的(`render/streamBudget.mjs`)。这份测试里的卡都是整幅的、项目 30 帧每秒:
// 同屏放得下的条数由预算算出来(15.04 亿 ÷ (1920 × 2176 × 30) = 12),下面仍叫它 DECODER_BUDGET
const { STREAM_PIXEL_RATE_BUDGET, streamCost, stageStreamPixels } = await import(srcUrl("render/streamBudget.mjs"));
const DECODER_BUDGET = Math.floor(STREAM_PIXEL_RATE_BUDGET / streamCost(stageStreamPixels({ width: 1920, height: 1080 }), 30));

let now = 1000;
performance.now = () => now;

let push = null;
const bodies = new Map();
const card = (id, start = 0, end = 10) => ({ id, cardId: "c", start, end, params: {} });
const projectOf = (ids) => ({ fps: 30, tracks: [{ id: "t", clips: ids.map((id) => card(id)) }] });
const project = projectOf(["h", "d"]);

beforeEach(() => {
  feed.resetSnapshotFeed();
  heavyIds = ["h", "d"];
  bodies.clear();
  feed.setSnapshotSource({
    subscribeReady: (_s, _r, cb) => { push = cb; return () => {}; },
    fetchSnapshot: async (kind, key, f) => bodies.get(`${key}@${f}`) ?? `<div>${key}@${f}</div>`,
  });
  feed.syncSnapshotSubscription(() => {});
});

const settle = () => new Promise((r) => setTimeout(r, 0));
function fakeStage() {
  const st = { calls: [] };
  st.setSnapshots = async (patch, opts) => { st.calls.push({ patch, opts }); return { ok: true }; };
  return st;
}

test("(C) When a stream covers this segment: neither playback nor pause picks a snapshot or asks the prerender process to backfill frames; only a segment without a stream picks one", () => {
  push({ type: "layer", clipId: "h", kind: "html", key: "K", ranges: [[0, 299]] });
  push({ type: "layer", clipId: "h", kind: "stream", key: "S", ranges: [[0, 9]], originFrame: 0 });
  for (const playing of [true, false]) {
    const f = feed.planFeed({ project, t: 1, playing });
    assert.ok(f.heavy.includes("h"));
    assert.equal(f.streamPlanes.length, 1, `playing=${playing}: this frame sends a stream plane`);
    assert.ok(!f.picks.has("h"), `playing=${playing}: with a stream, the snapshot is not read`);
    assert.ok(!f.wanted.some((w) => w.clipId === "h"), "A layer with a stream does not ask the prerender process to backfill exact frames");
  }
  // 第 19 段(第 285 帧起)的流还没产出来:没有流平面，也不选快照
  const beyond = feed.planFeed({ project, t: 9.5, playing: true });
  assert.equal(beyond.streamPlanes.length, 0);
  assert.equal(beyond.picks.size, 0, "Snapshots have been removed, so no snapshot is picked");
  const pausedBeyond = feed.planFeed({ project, t: 9.5, playing: false });
  assert.ok(pausedBeyond.scrub.includes("h"), "A heavy card without a stream enters scrub for a placeholder when paused");
});

test("(D) K6: the current segment has no stream and no snapshot → do not switch into suppression, live render as usual", () => {
  feed.markPendingDemote("d");
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[15, 19]], originFrame: 0 });   // 只有第 7.5 秒以后
  const f = feed.planFeed({ project, t: 1, playing: true });                            // 播放头在第 1 秒 = 第 2 段
  assert.ok(!f.heavy.includes("d"), "Live render as usual before ready");
  assert.ok(feed.pendingDemotes().has("d"));
});

test("(D) K6: ready only when the segments covering the 1 second from the current position all have streams", () => {
  feed.markPendingDemote("d");
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[2, 2]], originFrame: 0 });   // 第 30~44 帧
  assert.ok(!feed.planFeed({ project, t: 1, playing: true }).heavy.includes("d"), "30 frames from second 1 need to reach frame 59, and segment 3 (45~59) has none → not enough");
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[2, 3]], originFrame: 0 });
  assert.ok(feed.planFeed({ project, t: 1, playing: true }).heavy.includes("d"), "Segments 2~3 cover frames 30~59");
  assert.ok(!feed.pendingDemotes().has("d"));
});

test("Stream segments are counted from the stream's own first frame: a clip starts at frame 100, and the parent page uses the per-layer originFrame to convert frame numbers into segment numbers", () => {
  // 片段 d 占第 100～249 帧(不从 15 的倍数帧开始);它的流的第 0 段是第 100～114 帧,第 1 段是第 115～129 帧……
  const p = { fps: 30, tracks: [{ id: "t", clips: [card("h"), card("d", 100 / 30, 250 / 30)] }] };
  heavyIds = ["h", "d"];
  const planesAt = (frame) => feed.streamPlanesAt({ project: p, t: frame / 30 + 1e-4, playing: true }).filter((x) => x.clipIds[0] === "d");
  push({ type: "layer", clipId: "d", kind: "html", key: "D", ranges: [[0, 149]] });
  // 只有第 1 段(第 115～129 帧)就绪
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[1, 1]], originFrame: 100 });
  assert.equal(planesAt(100).length, 0, "Frame 100 is in segment 0, not ready");
  assert.equal(planesAt(114).length, 0);
  assert.deepEqual(planesAt(115), [{ clipIds: ["d"], key: "SD", ranges: [[1, 1]], originFrame: 100 }], "From frame 115 it is segment 1; the stream plane is handed to the stage with its first frame");
  assert.equal(planesAt(129).length, 1);
  assert.equal(planesAt(130).length, 0, "Frame 130 is segment 2");
  // 按项目帧号算(原来的做法)第 115 帧是第 7 段:只有第 7 段就绪时这一帧没有流
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[7, 7]], originFrame: 100 });
  assert.equal(planesAt(115).length, 0);
  assert.equal(planesAt(100 + 7 * 15).length, 1, "Segment 7 is frames 205~219");
  // 没带第一帧的层(改分段规则之前的生产者发的):没法换算,当作没有流
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[0, 19]] });   // 故意不带 originFrame
  assert.equal(planesAt(115).length, 0);
  const pf = feed.planFeed({ project: p, t: 115 / 30 + 1e-4, playing: true });
  assert.equal(pf.streamPlanes.length, 0);
  assert.equal(pf.picks.size, 0, "Handled like a layer without a stream: snapshots have been removed, so no snapshot is picked");
  // K6 的就绪:从第 115 帧起 1 秒(到第 144 帧)要第 1、2 段都在
  feed.markPendingDemote("d");
  push({ type: "layer", clipId: "d", kind: "html", key: "D", ranges: [] });
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[1, 1]], originFrame: 100 });
  assert.ok(!feed.planFeed({ project: p, t: 115 / 30 + 1e-4, playing: true }).heavy.includes("d"), "Segment 2 (frames 130~144) has none: not enough");
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[1, 2]], originFrame: 100 });
  assert.ok(feed.planFeed({ project: p, t: 115 / 30 + 1e-4, playing: true }).heavy.includes("d"), "Segments 1~2 cover frames 115~144");
});

test("A layer over the decoder budget is treated as \"no stream\": it does not enter the stream plane, is marked over, and enters scrub for a placeholder when paused", () => {
  const ids = Array.from({ length: DECODER_BUDGET + 1 }, (_, i) => `h${i}`);
  heavyIds = ids;
  const p = projectOf(ids);
  for (const id of ids) {
    push({ type: "layer", clipId: id, kind: "html", key: `K${id}`, ranges: [[0, 299]] });
    push({ type: "layer", clipId: id, kind: "stream", key: `S${id}`, ranges: [[0, 19]], originFrame: 0 });
  }
  const head = { project: p, t: 1, playing: true };
  const planes = feed.streamPlanesAt(head);
  assert.equal(planes.filter((p) => !p.over).length, DECODER_BUDGET, "The stream planes the parent page sends to the stage are also cut to the budget");
  // 超出预算的那一条也发给舞台,带着 over:舞台不为它建解码器,只取清单、照这一帧所在分段的位置矩形摆占位符
  assert.deepEqual(planes.filter((p) => p.over).map((p) => p.clipIds), [[ids.at(-1)]]);
  const f = feed.planFeed(head);
  assert.deepEqual(f.overPlanes.map((p) => [p.key, p.over]), [[`S${ids.at(-1)}`, true]]);
  const last = ids.at(-1);
  assert.equal(f.picks.size, 0, "Snapshots have been removed, so no snapshot is read");
  // 暂停 / 拖动同样按预算截;超出的那一张也抑制着(进 scrub 待占位符),不露出没推到位的活组件
  const paused = feed.planFeed({ ...head, playing: false });
  assert.equal(paused.streamPlanes.length, DECODER_BUDGET);
  assert.deepEqual(paused.scrub, [...ids].sort());
  assert.equal(paused.picks.size, 0);
  assert.deepEqual(feed.pickForSetTime({ ...head, playing: false }).awaiting, [], "A card under suppression does not wait for a snapshot");
});

test("Snapshot delivery is retired: deliverSnapshots returns 0, fetches no bytes and delivers no snapshot", async () => {
  push({ type: "layer", clipId: "h", kind: "html", key: "K", ranges: [[0, 299]] });
  push({ type: "layer", clipId: "h", kind: "stream", key: "S", ranges: [[0, 19]], originFrame: 0 });
  push({ type: "layer", clipId: "d", kind: "html", key: "D", ranges: [[0, 299]] });
  const fetched = [];
  feed.setSnapshotSource({ subscribeReady: () => () => {}, fetchSnapshot: async (kind, key, f) => { fetched.push(`${key}@${f}`); return `<div>${key}@${f}</div>`; } });
  const stage = fakeStage();
  const delivered = await feed.deliverSnapshots(stage, "front", { project, t: 1, playing: true });
  assert.equal(delivered, 0);
  assert.equal(stage.calls.length, 0, "stage.setSnapshots is not called");
  assert.equal(fetched.length, 0, "No snapshot bytes are fetched");
});

test("Snapshot delivery is retired: no matter how many cards there are or whether the budget is exceeded, deliverSnapshots always returns 0 and starts no delivery", async () => {
  const ids = [...Array.from({ length: DECODER_BUDGET }, (_, i) => `s${i}`), "over", "none"];
  heavyIds = ids;
  const p = projectOf(ids);
  for (const id of ids) {
    push({ type: "layer", clipId: id, kind: "html", key: `K${id}`, ranges: [[0, 299]] });
    if (id !== "none") push({ type: "layer", clipId: id, kind: "stream", key: `S${id}`, ranges: [[0, 19]], originFrame: 0 });
  }
  const head = { project: p, t: 1, playing: true };
  const stage = fakeStage();
  const delivered = await feed.deliverSnapshots(stage, "front", head);
  assert.equal(delivered, 0);
  assert.equal(stage.calls.length, 0, "Snapshots are retired, no setSnapshots delivery is started");
});

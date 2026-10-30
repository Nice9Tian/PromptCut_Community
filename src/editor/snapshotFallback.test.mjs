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

test("(C) 流盖着这一段:播放、暂停都不选快照,不催预渲染进程补帧;这一段没有流的才选", () => {
  push({ type: "layer", clipId: "h", kind: "html", key: "K", ranges: [[0, 299]] });
  push({ type: "layer", clipId: "h", kind: "stream", key: "S", ranges: [[0, 9]], originFrame: 0 });
  for (const playing of [true, false]) {
    const f = feed.planFeed({ project, t: 1, playing });
    assert.ok(f.heavy.includes("h"));
    assert.equal(f.streamPlanes.length, 1, `playing=${playing}:这一帧发流平面`);
    assert.ok(!f.picks.has("h"), `playing=${playing}:有流不读快照`);
    assert.ok(!f.wanted.some((w) => w.clipId === "h"), "有流的层不催预渲染进程补精确帧");
  }
  // 第 19 段(第 285 帧起)的流还没产出来:没有流平面，也不选快照
  const beyond = feed.planFeed({ project, t: 9.5, playing: true });
  assert.equal(beyond.streamPlanes.length, 0);
  assert.equal(beyond.picks.size, 0, "快照已撤掉，不选快照");
  const pausedBeyond = feed.planFeed({ project, t: 9.5, playing: false });
  assert.ok(pausedBeyond.scrub.includes("h"), "无流的重卡暂停态进 scrub 待占位符");
});

test("(D) K6:当前段没有流、也没有快照 → 不切进抑制,照常活渲", () => {
  feed.markPendingDemote("d");
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[15, 19]], originFrame: 0 });   // 只有第 7.5 秒以后
  const f = feed.planFeed({ project, t: 1, playing: true });                            // 播放头在第 1 秒 = 第 2 段
  assert.ok(!f.heavy.includes("d"), "就绪前照常活渲");
  assert.ok(feed.pendingDemotes().has("d"));
});

test("(D) K6:从当前位置起 1 秒的分段都有流才算就绪", () => {
  feed.markPendingDemote("d");
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[2, 2]], originFrame: 0 });   // 第 30~44 帧
  assert.ok(!feed.planFeed({ project, t: 1, playing: true }).heavy.includes("d"), "第 1 秒起 30 帧要到第 59 帧,第 3 段(45~59)没有 → 不够");
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[2, 3]], originFrame: 0 });
  assert.ok(feed.planFeed({ project, t: 1, playing: true }).heavy.includes("d"), "第 2~3 段盖住了第 30~59 帧");
  assert.ok(!feed.pendingDemotes().has("d"));
});

test("流的分段从它自己的第一帧起数:片段从第 100 帧开始,父页按层带来的 originFrame 把帧号换成分段号", () => {
  // 片段 d 占第 100～249 帧(不从 15 的倍数帧开始);它的流的第 0 段是第 100～114 帧,第 1 段是第 115～129 帧……
  const p = { fps: 30, tracks: [{ id: "t", clips: [card("h"), card("d", 100 / 30, 250 / 30)] }] };
  heavyIds = ["h", "d"];
  const planesAt = (frame) => feed.streamPlanesAt({ project: p, t: frame / 30 + 1e-4, playing: true }).filter((x) => x.clipIds[0] === "d");
  push({ type: "layer", clipId: "d", kind: "html", key: "D", ranges: [[0, 149]] });
  // 只有第 1 段(第 115～129 帧)就绪
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[1, 1]], originFrame: 100 });
  assert.equal(planesAt(100).length, 0, "第 100 帧在第 0 段,没就绪");
  assert.equal(planesAt(114).length, 0);
  assert.deepEqual(planesAt(115), [{ clipIds: ["d"], key: "SD", ranges: [[1, 1]], originFrame: 100 }], "第 115 帧起是第 1 段;流平面带着第一帧交给舞台");
  assert.equal(planesAt(129).length, 1);
  assert.equal(planesAt(130).length, 0, "第 130 帧是第 2 段");
  // 按项目帧号算(原来的做法)第 115 帧是第 7 段:只有第 7 段就绪时这一帧没有流
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[7, 7]], originFrame: 100 });
  assert.equal(planesAt(115).length, 0);
  assert.equal(planesAt(100 + 7 * 15).length, 1, "第 7 段是第 205～219 帧");
  // 没带第一帧的层(改分段规则之前的生产者发的):没法换算,当作没有流
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[0, 19]] });   // 故意不带 originFrame
  assert.equal(planesAt(115).length, 0);
  const pf = feed.planFeed({ project: p, t: 115 / 30 + 1e-4, playing: true });
  assert.equal(pf.streamPlanes.length, 0);
  assert.equal(pf.picks.size, 0, "照没有流的层处理:快照已撤掉，不选快照");
  // K6 的就绪:从第 115 帧起 1 秒(到第 144 帧)要第 1、2 段都在
  feed.markPendingDemote("d");
  push({ type: "layer", clipId: "d", kind: "html", key: "D", ranges: [] });
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[1, 1]], originFrame: 100 });
  assert.ok(!feed.planFeed({ project: p, t: 115 / 30 + 1e-4, playing: true }).heavy.includes("d"), "第 2 段(第 130～144 帧)没有:不够");
  push({ type: "layer", clipId: "d", kind: "stream", key: "SD", ranges: [[1, 2]], originFrame: 100 });
  assert.ok(feed.planFeed({ project: p, t: 115 / 30 + 1e-4, playing: true }).heavy.includes("d"), "第 1～2 段盖住了第 115～144 帧");
});

test("超出解码器预算的层当「无流」:不进流平面,标记 over，暂停态进 scrub 待占位符", () => {
  const ids = Array.from({ length: DECODER_BUDGET + 1 }, (_, i) => `h${i}`);
  heavyIds = ids;
  const p = projectOf(ids);
  for (const id of ids) {
    push({ type: "layer", clipId: id, kind: "html", key: `K${id}`, ranges: [[0, 299]] });
    push({ type: "layer", clipId: id, kind: "stream", key: `S${id}`, ranges: [[0, 19]], originFrame: 0 });
  }
  const head = { project: p, t: 1, playing: true };
  const planes = feed.streamPlanesAt(head);
  assert.equal(planes.filter((p) => !p.over).length, DECODER_BUDGET, "父页发给舞台的流平面也按预算截");
  // 超出预算的那一条也发给舞台,带着 over:舞台不为它建解码器,只取清单、照这一帧所在分段的位置矩形摆占位符
  assert.deepEqual(planes.filter((p) => p.over).map((p) => p.clipIds), [[ids.at(-1)]]);
  const f = feed.planFeed(head);
  assert.deepEqual(f.overPlanes.map((p) => [p.key, p.over]), [[`S${ids.at(-1)}`, true]]);
  const last = ids.at(-1);
  assert.equal(f.picks.size, 0, "快照已撤掉，不读快照");
  // 暂停 / 拖动同样按预算截;超出的那一张也抑制着(进 scrub 待占位符),不露出没推到位的活组件
  const paused = feed.planFeed({ ...head, playing: false });
  assert.equal(paused.streamPlanes.length, DECODER_BUDGET);
  assert.deepEqual(paused.scrub, [...ids].sort());
  assert.equal(paused.picks.size, 0);
  assert.deepEqual(feed.pickForSetTime({ ...head, playing: false }).awaiting, [], "被抑制着的卡不等快照");
});

test("快照投递已退役：deliverSnapshots 返回 0，不取字节、不投快照", async () => {
  push({ type: "layer", clipId: "h", kind: "html", key: "K", ranges: [[0, 299]] });
  push({ type: "layer", clipId: "h", kind: "stream", key: "S", ranges: [[0, 19]], originFrame: 0 });
  push({ type: "layer", clipId: "d", kind: "html", key: "D", ranges: [[0, 299]] });
  const fetched = [];
  feed.setSnapshotSource({ subscribeReady: () => () => {}, fetchSnapshot: async (kind, key, f) => { fetched.push(`${key}@${f}`); return `<div>${key}@${f}</div>`; } });
  const stage = fakeStage();
  const delivered = await feed.deliverSnapshots(stage, "front", { project, t: 1, playing: true });
  assert.equal(delivered, 0);
  assert.equal(stage.calls.length, 0, "不调用 stage.setSnapshots");
  assert.equal(fetched.length, 0, "不取快照字节");
});

test("快照投递已退役：无论多少卡或是否超预算，deliverSnapshots 恒返回 0 且不发起投递", async () => {
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
  assert.equal(stage.calls.length, 0, "快照已退役，不发起 setSnapshots 投递");
});

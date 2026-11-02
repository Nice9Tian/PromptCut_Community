/**
 * 父页一侧「暂停和拖动贴流」的单测(`snapshotFeed.ts`;任务书「己三」)。
 * 跑:npm test -- src/editor/snapshotFeedScrub.test.mjs
 *
 * 钉住:
 *   - 不在播放时,这一帧有流的重卡照样发流平面,并且被抑制(`FeedPlan.scrub`);
 *   - **有流不读快照**:就算快照表盖着这一帧,也不选帧、不取字节、不点名 `awaiting`、不报缺口;
 *   - 这一帧所在分段没就绪 / 根本没有流的卡,落回快照这条路(现状),不抑制;
 *   - 追到精确活渲(`settled`)的卡不再抑制,但流平面照发(把播放头下这一帧先解好);下一次 `setTime`、起播照常;
 *   - 组流整条判;超出解码器预算的层抑制着、落到快照;最低一档(只有一个舞台)暂停着照现状不发流平面;
 *   - 片段不从 15 的倍数帧开始:按这条流自己的第一帧换算。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
let plan = null;
const wantedPushed = [];
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => plan } });
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: (w) => wantedPushed.push(w) } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const { planFeed, pickForSetTime, deliverSnapshots, noteSettled, markAllSettled, suppressedAt, streamPlanesAt, setSnapshotSource, syncSnapshotSubscription, resetSnapshotFeed } = feed;
// 同屏流的预算是数像素的(`render/streamBudget.mjs`)。这份测试里的卡都是整幅的、项目 30 帧每秒:
// 同屏放得下的条数由预算算出来(15.04 亿 ÷ (1920 × 2176 × 30) = 12),下面仍叫它 DECODER_BUDGET
const { STREAM_PIXEL_RATE_BUDGET, streamCost, stageStreamPixels } = await import(srcUrl("render/streamBudget.mjs"));
const DECODER_BUDGET = Math.floor(STREAM_PIXEL_RATE_BUDGET / streamCost(stageStreamPixels({ width: 1920, height: 1080 }), 30));

let now = 1000;
performance.now = () => now;

const FPS = 30;
const card = (id, start = 0, end = 10) => ({ id, cardId: "c", start, end, params: {} });
const project = (clips) => ({ version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [], tracks: [{ id: "t", name: "t", clips }] });
const heavyEverywhere = (...ids) => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(ids) }] });
const html = (clipId, ranges, key = `k-${clipId}`) => ({ type: "layer", clipId, kind: "html", key, ranges });
const stream = (clipId, ranges, extra = {}) => ({ type: "layer", clipId, kind: "stream", key: `s-${clipId}`, ranges, originFrame: 0, ...extra });
const at = (frame) => frame / FPS + 1e-4;

let src;
beforeEach(() => {
  resetSnapshotFeed();
  src = { push: null, fetched: [],
    subscribeReady(_s, _r, cb) { src.push = cb; return () => {}; },
    async fetchSnapshot(kind, key, f) { src.fetched.push(`${kind}/${key}/${f}`); return `html:${key}/${f}`; } };
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  plan = { segments: [] };
  wantedPushed.length = 0;
  now += 10_000;
});

test("Pause / scrub: a heavy card with a stream at this frame sends a stream plane and is suppressed; with a stream no snapshot is read (no frame picked, no bytes fetched, no waiting, no gaps reported)", async () => {
  const p = project([card("h"), card("l")]);
  plan = heavyEverywhere("h");
  src.push(html("h", [[0, 299]]));               // 快照表盖着每一帧
  src.push(stream("h", [[0, 19]]));
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.deepEqual(f.heavy, ["h"]);
  assert.deepEqual(f.streamPlanes, [{ clipIds: ["h"], key: "s-h", ranges: [[0, 19]], originFrame: 0 }]);
  assert.deepEqual(f.scrub, ["h"]);
  assert.equal(f.picks.size, 0, "With a stream, snapshots are not read");
  assert.deepEqual(f.wanted, []);
  assert.deepEqual(suppressedAt(head), ["h"]);
  assert.deepEqual(streamPlanesAt(head), f.streamPlanes);
  const set = pickForSetTime(head);
  assert.deepEqual(set, { snapshots: {}, awaiting: [] }, "setTime carries no snapshots and names none to wait for");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(src.fetched, [], "None of the snapshot bytes are fetched");
  assert.deepEqual(wantedPushed, []);
  const calls = [];
  await deliverSnapshots({ setSnapshots: async (patch) => { calls.push(patch); } }, "front", head);
  assert.deepEqual(calls, [], "Nor delivered");
});

test("The stream of the segment containing this frame is not ready, or this card has no stream at all: the heavy card enters scrub for a placeholder and no snapshot is picked", () => {
  const p = project([card("h"), card("n")]);
  plan = heavyEverywhere("h", "n");
  src.push(html("h", [[0, 299]]));
  src.push(html("n", [[0, 299]]));
  src.push(stream("h", [[0, 1]]));                // 只有头两个分段(第 0～29 帧)
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.deepEqual(f.streamPlanes, []);
  assert.deepEqual(f.scrub, ["h", "n"]);
  assert.equal(f.picks.size, 0, "Snapshots retired, no snapshot is picked");
  assert.deepEqual(suppressedAt(head), ["h", "n"]);
  assert.deepEqual(pickForSetTime(head), { snapshots: {}, awaiting: [] });
  // 拖回有流的那一段:h 贴流,n 照旧在 scrub 占位
  const back = planFeed({ ...head, t: at(20) });
  assert.deepEqual(back.streamPlanes.map((s) => s.clipIds[0]), ["h"]);
  assert.deepEqual(back.scrub, ["h", "n"]);
  assert.equal(back.picks.size, 0);
});

test("A card that has caught up to exact live render (settled) is no longer suppressed and its stream plane is still sent (to decode this frame first); the next setTime pastes the stream again; starting playback suppresses as usual", () => {
  const p = project([card("h")]);
  plan = heavyEverywhere("h");
  src.push(stream("h", [[0, 19]]));
  const head = { project: p, t: at(37), playing: false };
  pickForSetTime(head);
  assert.deepEqual(suppressedAt(head), ["h"]);
  noteSettled("front", ["h"]);
  const settled = planFeed(head);
  assert.deepEqual(settled.scrub, [], "On stopping, the fallback is withdrawn: cards that have caught up are not covered again");
  assert.equal(settled.streamPlanes.length, 1, "The stream plane stays: the stage uses it to decode the frame under the playhead first");
  assert.equal(settled.picks.size, 0);
  // 起播:和暂停着先解好的是同一条平面(舞台不用重建解码器),这时才抑制
  const playing = { ...head, playing: true };
  assert.deepEqual(streamPlanesAt(playing), settled.streamPlanes);
  assert.deepEqual(suppressedAt(playing), ["h"]);
  // 再拖一下:上一次的「已精确」作废
  pickForSetTime({ ...head, t: at(52) });
  assert.deepEqual(suppressedAt({ ...head, t: at(52) }), ["h"]);
});

test("After a swap in paused state, the whole stage is exact (markAllSettled): no card is suppressed and the stream planes are still sent", () => {
  const p = project([card("a"), card("b")]);
  plan = heavyEverywhere("a", "b");
  src.push(stream("a", [[0, 19]]));
  src.push(stream("b", [[0, 19]]));
  const head = { project: p, t: at(37), playing: false };
  assert.deepEqual(suppressedAt(head), ["a", "b"]);
  markAllSettled("front");
  assert.deepEqual(suppressedAt(head), []);
  assert.equal(streamPlanesAt(head).length, 2);
});

test("Group stream is judged as a whole: if any member has not caught up, the whole group stays suppressed; it is released only when all have caught up", () => {
  const p = project([card("a"), card("b")]);
  plan = heavyEverywhere("a", "b");
  src.push(stream("b", [[0, 19]], { key: "g", groupClipIds: ["a", "b"] }));
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.deepEqual(f.streamPlanes, [{ clipIds: ["a", "b"], key: "g", ranges: [[0, 19]], originFrame: 0 }]);
  assert.deepEqual(f.scrub, ["a", "b"]);
  noteSettled("front", ["a"]);
  assert.deepEqual(planFeed(head).scrub, ["a", "b"], "a catches up first: b is still in the group, so the whole group is not released");
  noteSettled("front", ["b"]);
  assert.deepEqual(planFeed(head).scrub, []);
  // 组里有一张这一刻不判重:这一组不贴(各走各的)
  plan = heavyEverywhere("a");
  pickForSetTime(head);
  assert.deepEqual(planFeed(head).streamPlanes, []);
  assert.deepEqual(planFeed(head).scrub, ["a"], "a has no stream but is still a heavy card not yet settled, so it enters scrub for a placeholder");
  noteSettled("front", ["a"]);
  assert.deepEqual(planFeed(head).scrub, [], "a is no longer suppressed after settled");
});

test("Over the decoder budget on one screen: stream planes are cut to the budget; the ones that go over are also suppressed (placeholder) and no snapshot is picked", () => {
  const ids = Array.from({ length: DECODER_BUDGET + 2 }, (_, i) => `c${i}`);
  const p = project(ids.map((id) => card(id)));
  plan = heavyEverywhere(...ids);
  for (const id of ids) { src.push(html(id, [[0, 299]])); src.push(stream(id, [[0, 19]])); }
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.equal(f.streamPlanes.length, DECODER_BUDGET);
  assert.deepEqual(f.scrub, [...ids].sort());
  assert.equal(f.picks.size, 0, "Snapshots retired, no snapshot is picked");
  assert.equal(f.overPlanes.length, 2, "Those over budget are marked over");
});

test("Projects larger than 1080p or above 60 fps: with up to 6 streams on screen the pixels are not checked, all send stream planes, and no layer is over budget (what was let through before is still let through)", () => {
  const ids = ["a", "b", "c", "d"];
  for (const size of [{ width: 3840, height: 2160, fps: 60 }, { width: 3840, height: 2160, fps: 30 }, { width: 2560, height: 1440, fps: 60 }, { width: 1920, height: 1080, fps: 120 }]) {
    const p = { ...project(ids.map((id) => card(id))), ...size };
    plan = heavyEverywhere(...ids);
    for (const id of ids) src.push(stream(id, [[0, 39]]));
    for (const playing of [true, false]) {
      const f = planFeed({ project: p, t: 1, playing });
      assert.equal(f.streamPlanes.length, 4, `${size.width}×${size.height}@${size.fps} playing=${playing}`);
      assert.deepEqual(f.overPlanes, []);
      assert.equal(f.picks.size, 0, "All are covered by streams, so no snapshot is read");
    }
  }
});

test("Lowest tier: playback, pause and scrub all send stream planes, each carrying first (decode only the first frame of the segment); snapshots are retired, so no small size is picked", () => {
  const p = project([card("h"), card("n")]);
  plan = heavyEverywhere("h", "n");
  src.push(html("h", [[0, 299]]));
  src.push(html("n", [[0, 299]]));
  src.push(stream("h", [[0, 19]]));
  for (const playing of [false, true]) {
    const f = planFeed({ project: p, t: at(37), playing, single: true, sparseOnly: true });
    assert.deepEqual(f.streamPlanes, [{ clipIds: ["h"], key: "s-h", ranges: [[0, 19]], originFrame: 0, first: true }], `playing=${playing}`);
    assert.deepEqual(f.overPlanes, []);
    assert.equal(f.picks.size, 0, "Small-size snapshots retired");
  }
  // 别的档的流平面不带 first(照常逐帧解)
  assert.deepEqual(planFeed({ project: p, t: at(37), playing: true }).streamPlanes, [{ clipIds: ["h"], key: "s-h", ranges: [[0, 19]], originFrame: 0 }]);
  // 这一帧所在分段的流还没就绪(只有第 0、1 段,播放头在第 2 段):不发流平面,不选小尺寸
  src.push(stream("h", [[0, 1]]));
  const late = planFeed({ project: p, t: at(37), playing: false, single: true, sparseOnly: true });
  assert.deepEqual(late.streamPlanes, []);
  assert.equal(late.picks.size, 0);
  assert.deepEqual(late.scrub, ["h", "n"]);
});

test("Lowest-tier budget: only 4 small cards on screen (decoder count), only 2 full-screen cards (sum of frame sizes); the excess is marked over; other tiers fit the same cards", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const head = (p, extra = {}) => ({ project: p, t: at(37), playing: true, ...extra });
  // 六张小卡(框 320×240)
  const small = project(ids.map((id) => ({ ...card(id), frame: { x: 0, y: 0, w: 320, h: 240 } })));
  plan = heavyEverywhere(...ids);
  for (const id of ids) { src.push(html(id, [[0, 299]])); src.push(stream(id, [[0, 19]])); }
  const s = planFeed(head(small, { single: true, sparseOnly: true }));
  assert.deepEqual(s.streamPlanes.map((x) => x.clipIds[0]), ["a", "b", "c", "d"]);
  assert.ok(s.streamPlanes.every((x) => x.first === true));
  assert.deepEqual(s.overPlanes.map((x) => [x.clipIds[0], x.over, "first" in x]), [["e", true, false], ["f", true, false]]);
  assert.equal(s.picks.size, 0, "Small-size snapshots retired");
  assert.equal(streamPlanesAt(head(small, { single: true, sparseOnly: true })).length, 6, "What is sent to the stage is the 4 admitted planes plus the 2 over budget (only to lay out placeholders)");
  assert.equal(planFeed(head(small)).streamPlanes.length, 6, "Other tiers: all 6 are admitted");
  // 六张满屏卡:最低一档放 2 条;60 帧每秒的项目也是 2 条(开销不乘项目帧率)
  for (const fps of [30, 60]) {
    const full = { ...project(ids.map((id) => card(id))), fps };
    const f = planFeed({ project: full, t: 1, playing: true, single: true, sparseOnly: true });
    assert.deepEqual(f.streamPlanes.map((x) => x.clipIds[0]), ["a", "b"], `fps ${fps}`);
    assert.equal(f.overPlanes.length, 4);
    assert.equal(planFeed({ project: full, t: 1, playing: true }).streamPlanes.length, 6, "Other tiers: up to 6 streams, pixels are not checked");
  }
});

test("The clip starts at frame 100 (not a multiple of 15): while paused, judge whether this frame has a stream by the stream's own first frame", () => {
  const p = project([card("d", 100 / FPS + 1e-3, 250 / FPS)]);
  plan = heavyEverywhere("d");
  src.push(stream("d", [[1, 2]], { originFrame: 101 }));   // 第 116～145 帧
  const streamAt = (frame) => planFeed({ project: p, t: at(frame), playing: false }).streamPlanes.length;
  assert.equal(streamAt(115), 0, "Frame 115 is in segment 0, not ready");
  assert.equal(streamAt(116), 1);
  assert.equal(streamAt(145), 1);
  assert.equal(streamAt(146), 0, "Frame 146 is segment 3");
});

test("A card this device cannot run (online browser mode) does not catch up when stopped: \"already exact\" does not hold for it, and it keeps pasting the stream while paused", async () => {
  const registry = await import(srcUrl("kernel/registry.ts"));
  const host = await import(srcUrl("render/placeholderHost.ts"));
  registry.setSyncedUserCards([{ id: "synced", name: "Synced card" }]);
  const p = project([{ ...card("s"), cardId: "synced" }, card("b")]);
  plan = heavyEverywhere("b");
  try {
    host.setOnlineBrowserMode(true);
    resetSnapshotFeed(); setSnapshotSource(src); syncSnapshotSubscription(() => {});
    src.push(stream("s", [[0, 19]]));
    src.push(stream("b", [[0, 19]]));
    const head = { project: p, t: at(37), playing: false };
    assert.deepEqual(planFeed(head).scrub, ["b", "s"]);
    noteSettled("front", ["b", "s"]);
    assert.deepEqual(planFeed(head).scrub, ["s"]);
    markAllSettled("front");
    assert.deepEqual(planFeed(head).scrub, ["s"]);
  } finally {
    host.setOnlineBrowserMode(false);
    registry.setSyncedUserCards([]);
  }
});

test("A pure remotion heavy card without a stream does not enter scrub when paused / scrubbing (the live component is exposed and renders directly)", async () => {
  const registry = await import(srcUrl("kernel/registry.ts"));
  registry.registerCards([
    { id: "pure-remotion", name: "Pure Remotion", frameMode: "direct", Component: () => null },
  ]);
  const p = project([{ id: "r", cardId: "pure-remotion", start: 0, end: 10, params: {} }]);
  plan = heavyEverywhere("r");
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.ok(f.heavy.includes("r"), "Classified as heavy by the dispatch table");
  assert.equal(f.streamPlanes.length, 0, "No stream");
  assert.deepEqual(f.scrub, [], "A pure remotion heavy card does not enter scrub; the live component is exposed and renders directly");
});

test("Without a stream, a heavy card with parts or a motion heavy card enters scrub for a placeholder (must not be misjudged as direct)", async () => {
  const registry = await import(srcUrl("kernel/registry.ts"));
  registry.registerCards([
    { id: "motion-card", name: "Motion Card", frameMode: "stateful", Component: () => null },
    { id: "direct-composite", name: "Direct Composite", frameMode: "direct", Component: () => null },
  ]);
  // 1. motion 重卡 (frameMode: stateful)
  // 2. 声明 direct 但带 parts 的组合片段 (clipFrameMode 判为 stateful)
  const p = project([
    { id: "m", cardId: "motion-card", start: 0, end: 10, params: {} },
    { id: "c_parts", cardId: "direct-composite", start: 0, end: 10, params: {}, parts: [{ id: "p1" }] },
  ]);
  plan = heavyEverywhere("m", "c_parts");
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.deepEqual(f.streamPlanes, []);
  assert.deepEqual(f.scrub, ["c_parts", "m"], "A heavy card with parts or stateful enters scrub for a placeholder");
});

test("A non-remotion heavy card without a stream does not enter scrub when there is no cost record or in single-stage vtOk=false (prevents getting stuck on the placeholder)", () => {
  const p = project([card("unmeasured"), card("single_vtfail")]);
  plan = heavyEverywhere("unmeasured", "single_vtfail");
  feed.setCostResolver(
    (_proj, clipId) => {
      if (clipId === "single_vtfail") return { identityKey: "k2", fps: 30, stepMs: 25, vtOk: false };
      return undefined; // unmeasured has no cost record
    },
    () => false // single stage mode
  );
  const head = { project: p, t: at(37), playing: false };
  const f = planFeed(head);
  assert.deepEqual(f.scrub, [], "Unmeasured or single-stage vtOk=false is not locked into scrub");
});

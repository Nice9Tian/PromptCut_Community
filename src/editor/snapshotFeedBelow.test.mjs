/**
 * 父页一侧「依赖下层的卡贴它的轨道流」的单测(`snapshotFeed.ts`;任务书 `render-refactor-task.md`「戊二」的第三块)。
 * 跑:npm test -- src/editor/snapshotFeedBelow.test.mjs
 *
 * 钉住:
 *   - 就绪索引里带 `streamKind: "below"` 的那一层,播放、暂停、拖动都发流平面,平面带 `plane: "stage"`(舞台把画布挂在舞台根下);
 *     抑制、「有流不读快照」、追到精确活渲以后怎么撤,和别的重卡同一套;
 *   - **过期**:那一层带的输入签名和按当前项目算的对不上(下层改了参数、位置、时间、顺序,或者下层多了少了一层;目标卡自己改了也算),
 *     这条流当作没有 —— 不发平面、不抑制,落到快照,再没有就什么都不贴;上面的层怎么改都不算过期;
 *   - 重产以后(新的一层带着新签名)又贴;那一层没带签名的不比(照贴);
 *   - 片段不从 15 的倍数帧开始;占解码器预算(和别的流一起数)。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
let plan = null;
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => plan } });
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: () => {} } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const { planFeed, pickForSetTime, noteSettled, suppressedAt, streamPlanesAt, snapshotFeedDebug, setSnapshotSource, syncSnapshotSubscription, resetSnapshotFeed } = feed;
// 同屏流的预算是数像素的(`render/streamBudget.mjs`)。这份测试里的卡都是整幅的、项目 30 帧每秒:
// 同屏放得下的条数由预算算出来(15.04 亿 ÷ (1920 × 2176 × 30) = 12),下面仍叫它 DECODER_BUDGET
const { STREAM_PIXEL_RATE_BUDGET, streamCost, stageStreamPixels } = await import(srcUrl("render/streamBudget.mjs"));
const DECODER_BUDGET = Math.floor(STREAM_PIXEL_RATE_BUDGET / streamCost(stageStreamPixels({ width: 1920, height: 1080 }), 30));
const { streamInputSig } = await import(srcUrl("render/streamInputSig.mjs"));

let now = 1000;
performance.now = () => now;

const FPS = 30;
const card = (id, start, end, extra = {}) => ({ id, cardId: "c", start, end, params: {}, ...extra });
/**
 * 三条序列(第一条在最上面):上面一张标题,中间是毛玻璃卡 `glass`(第 40 帧起,不是 15 的倍数),下面一张会动的卡。
 * `edit(project)` 回一份改过的新项目(不原地改)。
 */
const GLASS_START = 40 / FPS;
function project(edit = (p) => p) {
  const base = {
    version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [],
    tracks: [
      { id: "top", name: "top", clips: [card("title", 0, 10, { params: { text: "Title" } })] },
      { id: "mid", name: "mid", clips: [card("glass", GLASS_START, GLASS_START + 4, { frame: { x: 100, y: 100, w: 600, h: 300 } })] },
      { id: "low", name: "low", clips: [card("mover", 0, 10, { params: { speed: 1 } })] },
    ],
  };
  return edit(structuredClone(base));
}
const sigOf = (p) => streamInputSig(p, { clipIds: ["glass"], kind: "below" });
const heavy = (...ids) => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(ids) }] });
const below = (p, ranges, extra = {}) => ({ type: "layer", clipId: "glass", kind: "stream", key: "s-glass", ranges, originFrame: 40, streamKind: "below", inputSig: sigOf(p), ...extra });
const local = (clipId, ranges) => ({ type: "layer", clipId, kind: "local", key: `E/k-${clipId}`, ranges });
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
  now += 10_000;
});

test("Below-dependent stream: playback, pause and scrub all send a stream plane (with plane: stage) and are suppressed; with a stream, snapshots are not read; once caught up, no suppression and the plane is still sent", () => {
  const p = project();
  plan = heavy("glass");
  src.push(local("glass", [[0, 119]]));             // 本地档快照盖着每一帧
  src.push(below(p, [[0, 7]]));                     // 8 个分段:第 40～159 帧
  const want = [{ clipIds: ["glass"], key: "s-glass", ranges: [[0, 7]], originFrame: 40, plane: "stage" }];
  for (const playing of [true, false]) {
    const head = { project: p, t: at(77), playing };
    const f = planFeed(head);
    assert.deepEqual(f.heavy, ["glass"]);
    assert.deepEqual(f.streamPlanes, want, `playing=${playing}`);
    assert.deepEqual(streamPlanesAt(head), want);
    assert.deepEqual(suppressedAt(head), ["glass"]);
    assert.equal(f.picks.size, 0, "With a stream, snapshots are not read");
    assert.deepEqual(f.wanted, []);
  }
  // 拖到别的帧(分段中间、分段的第一帧、上一段的最后一帧)
  for (const frame of [41, 54, 55, 100, 159]) {
    const head = { project: p, t: at(frame), playing: false };
    assert.deepEqual(streamPlanesAt(head), want, `Frame ${frame}`);
    assert.deepEqual(pickForSetTime(head), { snapshots: {}, awaiting: [] });
    assert.deepEqual(suppressedAt(head), ["glass"]);
  }
  // 停下追到精确活渲:不再抑制,流平面留着(舞台拿它把这一帧先解好)
  const head = { project: p, t: at(100), playing: false };
  pickForSetTime(head);
  noteSettled("front", ["glass"]);
  assert.deepEqual(suppressedAt(head), []);
  assert.deepEqual(streamPlanesAt(head), want);
  assert.deepEqual(snapshotFeedDebug(head).staleBelow, []);
});

test("The segment containing this frame is not ready: no plane is sent, heavy cards enter scrub for a placeholder, and no snapshot is picked", () => {
  const p = project();
  plan = heavy("glass");
  src.push(local("glass", [[0, 119]]));
  src.push(below(p, [[0, 1]]));                      // 只有第 40～69 帧
  const f = planFeed({ project: p, t: at(77), playing: false });
  assert.deepEqual(f.streamPlanes, []);
  assert.deepEqual(f.scrub, ["glass"]);
  assert.equal(f.picks.size, 0);
  // 第 39 帧(片段挂载了、流还没开始)也没有
  assert.deepEqual(planFeed({ project: p, t: at(39), playing: true }).streamPlanes, []);
});

const EDITS = {
  "The lower-layer card had a parameter changed": (p) => { p.tracks[2].clips[0].params.speed = 2; return p; },
  "The lower-layer card was moved": (p) => { p.tracks[2].clips[0].frame = { x: 10, y: 0, w: 1920, h: 1080 }; return p; },
  "The lower-layer card's opacity was changed": (p) => { p.tracks[2].clips[0].opacity = 0.5; return p; },
  "The lower-layer card was moved on the timeline": (p) => { p.tracks[2].clips[0].start = 0.5; return p; },
  "A layer was added below": (p) => { p.tracks.push({ id: "bg", name: "bg", clips: [card("bg", 0, 10)] }); return p; },
  "A layer was removed below": (p) => { p.tracks.pop(); return p; },
  "The track below was hidden": (p) => { p.tracks[2].hidden = true; return p; },
  "The target card itself was moved": (p) => { p.tracks[1].clips[0].frame.x = 300; return p; },
  "The target card itself had a parameter changed": (p) => { p.tracks[1].clips[0].params.blur = 20; return p; },
};
for (const [what, edit] of Object.entries(EDITS)) {
  test(`Stale: ${what}. The old stream is not pasted (no plane is sent, no suppression) and falls back to the snapshot; it is pasted again after re-production`, () => {
    const p0 = project();
    plan = heavy("glass");
    src.push(local("glass", [[0, 119]]));
    src.push(below(p0, [[0, 7]]));
    const head0 = { project: p0, t: at(77), playing: false };
    assert.equal(streamPlanesAt(head0).length, 1);

    const p1 = project(edit);
    assert.notEqual(sigOf(p1), sigOf(p0), "This change went into the input signature");
    for (const playing of [false, true]) {
      const head = { project: p1, t: at(77), playing };
      const f = planFeed(head);
      assert.deepEqual(f.streamPlanes, [], `The old stream is not sent (playing=${playing})`);
      assert.deepEqual(f.scrub, playing ? [] : ["glass"]);
      assert.equal(f.picks.size, 0, "Snapshots are retired");
      // 播放中重卡照旧抑制(播放中 heavy: ["glass"]);暂停、拖动时未 settled 的重卡进 scrub (["glass"])
      assert.deepEqual(suppressedAt(head), ["glass"]);
      assert.deepEqual(snapshotFeedDebug(head).staleBelow, ["glass"]);
    }
    // 回到原来那一版(撤销):签名又对上,原来的流照贴
    assert.equal(streamPlanesAt(head0).length, 1);
    // 预渲染进程换了版本、重产出来:新的一层带着新键、新签名
    src.push(below(p1, [[0, 3]], { key: "s-glass-2" }));
    const again = planFeed({ project: p1, t: at(77), playing: false });
    assert.deepEqual(again.streamPlanes, [{ clipIds: ["glass"], key: "s-glass-2", ranges: [[0, 3]], originFrame: 40, plane: "stage" }]);
    assert.deepEqual(again.scrub, ["glass"]);
    assert.equal(again.picks.size, 0);
  });
}

test("No change to the layers above counts as stale: the old stream is still pasted", () => {
  const p0 = project();
  plan = heavy("glass");
  src.push(below(p0, [[0, 7]]));
  const edits = [
    (p) => { p.tracks[0].clips[0].params.text = "Changed title"; return p; },
    (p) => { p.tracks[0].clips[0].frame = { x: 0, y: 0, w: 500, h: 100 }; return p; },
    (p) => { p.tracks.unshift({ id: "over", name: "over", clips: [card("over", 0, 10)] }); return p; },
    (p) => { p.tracks.shift(); return p; },
  ];
  for (const edit of edits) {
    const p1 = project(edit);
    assert.equal(sigOf(p1), sigOf(p0));
    assert.equal(streamPlanesAt({ project: p1, t: at(77), playing: true }).length, 1);
  }
});

test("A layer without a signature (old producer, alias): not compared, pasted as is; a stream without streamKind is an ordinary single-card stream, and its plane carries no plane field", () => {
  const p0 = project();
  plan = heavy("glass");
  src.push(below(p0, [[0, 7]], { inputSig: undefined }));
  const p1 = project(EDITS["The lower-layer card had a parameter changed"]);
  assert.deepEqual(streamPlanesAt({ project: p1, t: at(77), playing: true }), [{ clipIds: ["glass"], key: "s-glass", ranges: [[0, 7]], originFrame: 40, plane: "stage" }]);
  src.push({ type: "layer", clipId: "glass", kind: "stream", key: "s-card", ranges: [[0, 7]], originFrame: 40 });
  assert.deepEqual(streamPlanesAt({ project: p1, t: at(77), playing: true }), [{ clipIds: ["glass"], key: "s-card", ranges: [[0, 7]], originFrame: 40 }]);
});

test("Takes up decoder budget: counted together with the other streams; the one that goes over is suppressed and falls back to the snapshot", () => {
  const extra = Array.from({ length: DECODER_BUDGET }, (_, i) => `x${i}`);
  const p = project((q) => { q.tracks.unshift({ id: "many", name: "many", clips: [] }); for (const id of extra) q.tracks.push({ id: `t-${id}`, name: id, clips: [card(id, 0, 10)] }); return q; });
  plan = heavy("glass", ...extra);
  for (const id of extra) src.push({ type: "layer", clipId: id, kind: "stream", key: `s-${id}`, ranges: [[0, 19]], originFrame: 0 });
  // 这张卡的层最后到(就绪索引按到达的先后排):排在预算之外
  src.push(local("glass", [[0, 119]]));
  src.push(below(p, [[0, 7]]));
  const head = { project: p, t: at(77), playing: false };
  const f = planFeed(head);
  assert.equal(f.streamPlanes.length, DECODER_BUDGET);
  assert.equal(f.streamPlanes.some((x) => x.clipIds[0] === "glass"), false);
  assert.ok(f.scrub.includes("glass"), "Has a stream, just over budget: still suppressed as before");
  assert.equal(f.picks.size, 0, "Snapshots retired");
  assert.equal(f.overPlanes.some((x) => x.clipIds[0] === "glass"), true);
});

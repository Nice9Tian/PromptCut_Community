/**
 * 浏览器节点执行流任务(`docs/plan/browser-stream-task.md` 第三、四处)的页面一侧:
 *
 *   BSN-01  帧号换算(`streamTaskFrames`):分段从这条流的第一帧起数;项目帧减 firstFrame;不在卡范围里的帧送全透明;最后一段到这条流的最后一帧为止
 *   BSN-02  能力位 streams 由宿主报;报了才认领流任务;认领后整段交给宿主的 bakeStream,清单展开进 task.complete
 *   BSN-03  让路:宿主每帧前问 yielding(),回 { yielded } 就放回一次、不计失败;全部做完之后的让路照常完成
 *   BSN-04  中止与丢认领:页面隐藏立即放回并中止;丢认领中止、迟到的结果丢掉
 *   BSN-05  不产流的宿主(没给 bakeStream / streams 为假):能力位为假,不认领;与原来的节点相同
 *   BSN-06  父页守卫:bake-frame 事件里的像素(位图 + 矩形)按形状收,不合形状整条丢
 *   BSN-07  要像素的矩形(`pixelRect`)与取一块的 SVG(`pixelsSvg`):不缩放、平移到矩形左上角;小尺寸的 SVG 与原来逐字相同
 *
 * 清单形状、桌面采纳在 `server/test/browser-stream-manifest.test.mjs`;切分与过滤在 `server/test/browser-stream-split.test.mjs`。
 * 跑:node --test src/online/browserStream.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserNode, streamTaskFrames, streamInputOf, YIELD_FRAME_MAX_MS, STREAM_SEGMENT_FRAMES } from "./browserNode.ts";
import { sanitizeStageEvent, STAGE_MESSAGE_LIMITS } from "./stageMessageGuard.ts";
import { pixelRect, pixelsSvg, smallSvg, PIXELS_MAX_SIDE } from "../render/bakeSmall.ts";
import { SEGMENT_FRAMES } from "../render/streamPlayer.ts";

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const FP = "aaaaaaaaaaaaaaaa";
const BOUND = { x: -32, y: -32, w: 464, h: 304 };
const streamInput = (extra = {}) => ({ kind: "card", plane: "local", clipIds: ["c"], fps: 30, bound: BOUND, offset: { x: 760, y: 420 }, firstFrame: 45, count: 120, total: 300, originFrame: 45, lastFrame: 164, ...extra });
const streamTask = ({ from = 3, to = 4, stream = {} } = {}) => ({
  id: `stream:rk:${from}-${to}`, kind: "stream", resultKey: "rk", range: { unit: "segment", from, to },
  source: { projectId: "p1", projectRev: 7, userId: "u@d" },
  input: { clipId: "c", cardId: "punch-pill", entryKey: null, contentKey: "ck", canvasHeavy: false, compositing: "independent",
    bake: { start: 1.5, end: 5.5, count: 120, sampling: { firstFrame: 45, phase: { numerator: 0, denominator: 1 } } }, stream: streamInput(stream) },
  weight: { class: "medium", frames: (to - from + 1) * 15 },
  requires: { envFingerprint: FP, codeVersion: "cv", cardSources: {}, transcode: false, userCards: false, graphCards: false, belowDependent: false, capabilities: { streams: true } },
});

test("BSN-01 frame number conversion: segments count from the first frame of this stream; project frame minus firstFrame gives the local frame; a frame outside the card range is null (sent fully transparent); the last segment ends at the last frame of this stream", () => {
  assert.equal(STREAM_SEGMENT_FRAMES, SEGMENT_FRAMES, "segment frame count is the same number as the player's");
  // 卡占项目帧 45～164(本地 0～119),流的第一帧就是 45:分段 0 = 项目帧 45～59 = 本地 0～14
  const head = streamTaskFrames(streamTask({ from: 0, to: 1 }));
  assert.deepEqual(head.segments.map((s) => s.index), [0, 1]);
  assert.deepEqual(head.segments[0].frames, Array.from({ length: 15 }, (_, i) => i));
  assert.deepEqual(head.segments[1].frames, Array.from({ length: 15 }, (_, i) => 15 + i));
  assert.equal(head.frames, 30);
  // 分段 3、4 = 项目帧 90～119 = 本地 45～74(原来按项目帧号分段时,分段 3 是项目帧 45～59)
  const mid = streamTaskFrames(streamTask({ from: 3, to: 4 }));
  assert.deepEqual(mid.segments.map((s) => s.index), [3, 4]);
  assert.deepEqual(mid.segments[0].frames, Array.from({ length: 15 }, (_, i) => 45 + i));
  assert.deepEqual(mid.segments[1].frames, Array.from({ length: 15 }, (_, i) => 60 + i));
  // 片段不从 15 的倍数帧开始、时长不是 15 的倍数:第 100～149 帧共 50 帧 → 分段 0～3,每一帧都在卡的范围里,末段 5 帧
  const odd = streamTaskFrames(streamTask({ from: 0, to: 3, stream: { firstFrame: 100, originFrame: 100, count: 50, lastFrame: 149 } }));
  assert.deepEqual(odd.segments.map((s) => s.frames.length), [15, 15, 15, 5]);
  assert.deepEqual(odd.segments.flatMap((s) => s.frames), Array.from({ length: 50 }, (_, i) => i), "local frames 0-49, not one more and not one fewer, no fully transparent filler frames");
  assert.equal(odd.frames, 50);
  // 流的第一帧早于卡的第一帧(单卡流里两者相同,这里只守「照样减」):前 5 帧不在卡的范围里
  const pad = streamTaskFrames(streamTask({ from: 0, to: 0, stream: { firstFrame: 50, originFrame: 45 } }));
  assert.deepEqual(pad.segments[0].frames, [null, null, null, null, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // 卡的帧数比流短:本地帧只到 count - 1,之后是全透明
  const tail = streamTaskFrames(streamTask({ from: 7, to: 7, stream: { count: 110 } }));   // 分段 7 = 项目帧 150～164 = 本地 105～119
  assert.deepEqual(tail.segments[0].frames, [105, 106, 107, 108, 109, null, null, null, null, null, null, null, null, null, null]);
  // 流的最后一帧:最后一个分段不满(到第 154 帧为止 → 分段 7 是项目帧 150～154 共 5 帧);项目有多长不影响
  const last = streamTaskFrames(streamTask({ from: 6, to: 7, stream: { lastFrame: 154, total: 9999 } }));
  assert.deepEqual(last.segments.map((s) => s.frames.length), [15, 5]);
  assert.deepEqual(last.segments[1].frames, [105, 106, 107, 108, 109]);
  assert.equal(last.frames, 20);
  // 任务对不上:整段在这条流的最后一帧之后、不是浏览器形状的流任务、范围不对
  assert.equal(streamTaskFrames(streamTask({ from: 8, to: 8 })), null);
  assert.equal(streamTaskFrames({ ...streamTask(), input: { clipId: "c" } }), null);
  assert.equal(streamTaskFrames({ ...streamTask(), range: null }), null);
  for (const bad of [{ kind: "group" }, { plane: "stage" }, { clipIds: ["a", "b"] }, { bound: { x: 0, y: 0, w: 463, h: 304 } }, { bound: null }, { fps: 0 }, { count: 0 }, { firstFrame: 1.5 }, { total: undefined }, { offset: null },
    // 没带这条流的第一帧 / 最后一帧(改分段规则之前的切分方出的任务):不做,不拿项目的第 0 帧去猜
    { originFrame: undefined }, { originFrame: -1 }, { originFrame: 1.5 }, { lastFrame: undefined }, { lastFrame: 44 }]) {
    assert.equal(streamInputOf({ input: { stream: streamInput(bad) } }), null, JSON.stringify(bad));
  }
  // 负的 firstFrame(卡的入点在项目开头之前):流的第一帧是第 0 帧,照样减
  const neg = streamTaskFrames(streamTask({ from: 0, to: 0, stream: { firstFrame: -3, count: 10, originFrame: 0, lastFrame: 6 } }));
  assert.deepEqual(neg.segments[0].frames, [3, 4, 5, 6, 7, 8, 9]);
});

/** 一个节点 + 假宿主。`streams`:宿主此刻报的能不能压流;`bakeStream` 的每次调用记在 `jobs` 里,由用例决定何时回什么 */
async function rig({ streams = true, withStream = true, task = streamTask() } = {}) {
  let t = 1_000_000;
  const sent = [], jobs = [], finished = [], ended = [];
  const state = { streams };
  const node = createBrowserNode({
    nodeId: "n", projectId: "p1", userId: "u@d", codeVersion: "cv", environment: { platform: "", userAgent: "", renderer: "", vendor: "" },
    now: () => t, isIdle: () => true, send: (m) => { sent.push(JSON.parse(JSON.stringify(m))); return true; },
    keptProject: () => ({ rev: 7 }), fetchSnapshot: async () => null,
    bakeFrame: async () => { throw new Error("a stream task must not take the per-frame generate snapshots path"); },
    finishTask: async () => { throw new Error("a stream task must not take the snapshot finishTask"); },
    streams: () => state.streams,
    ...(withStream ? {
      bakeStream: (job) => new Promise((resolve, reject) => jobs.push({ job, resolve, reject })),
      finishStream: async ({ task: tk, manifest }) => { finished.push({ id: tk.id, manifest }); return manifest; },
    } : {}),
    onTaskEnd: (tk, outcome) => ended.push(outcome),
  });
  node.start();
  node.receive({ type: "node.welcome", nodeId: "n", resumed: [], lost: [], envFingerprint: FP });
  node.receive({ type: "queue.snapshot", tasks: [{ ...task, state: "open", version: 1 }] });
  node.tick();
  const of = (type) => sent.filter((m) => m.type === type);
  const claim = async () => {
    node.receive({ type: "task.claimed", id: task.id, token: 5, version: 2, task: { ...task, state: "claimed", version: 2 } });
    await flush();
  };
  return { node, sent, jobs, finished, ended, state, task, of, claim, advance: (ms) => { t += ms; } };
}
const MANIFEST = { v: 1, kind: "stream", resultKey: "rk", range: { from: 3, to: 4 }, header: { kind: "card", plane: "local", clipIds: ["c"], fps: 30, originFrame: 45, bound: BOUND, offset: { x: 760, y: 420 }, tight: null },
  inits: { ["0".repeat(16)]: { hash: "0".repeat(64) } }, segments: { 3: { hash: "1".repeat(64) }, 4: { hash: "2".repeat(64) } } };

test("BSN-02 claims a stream task only if the host reports it can encode streams; hands the whole segment to bakeStream, reports progress per frame, and expands the manifest into task.complete", async () => {
  const r = await rig();
  assert.equal(r.node.debug().streams, true, "capability flag streams is true");
  assert.equal(r.of("node.hello")[0].capabilities.streams, true, "check-in carries the current capability flags");
  assert.equal(r.of("task.claim").length, 1, "claimed the stream task");
  await r.claim();
  assert.equal(r.jobs.length, 1, "bakeStream handed to the host");
  const { job } = r.jobs[0];
  assert.equal(job.task.id, r.task.id);
  assert.deepEqual(job.project, { rev: 7 }, "the project at that task's revision");
  assert.equal(job.yielding(), false);
  assert.equal(r.node.debug().state, "baking");
  assert.deepEqual(r.node.debug().holding.map((h) => [h.done, h.of]), [[0, 30]], "progress by frame count: 30 frames across two segments");
  job.progress(0);   // 宿主开工先报起点(没有上一次认领留下的分段)
  job.progress(7);
  job.progress(16);
  await flush();
  // 换阶段时编排会按原帧数再报一步(工作计数),所以相邻重复的不算:帧数只会是 0 → 7 → 16
  const reported = r.of("task.progress").map((m) => m.done).filter((d, i, a) => i === 0 || d !== a[i - 1]);
  assert.deepEqual(reported, [0, 7, 16], "reports 0 first, then follows the frame counts the host reports");
  assert.deepEqual(r.node.debug().holding.map((h) => [h.done, h.of]), [[16, 30]]);
  r.jobs[0].resolve({ manifest: MANIFEST });
  await flush();
  assert.deepEqual(r.finished.map((f) => f.id), [r.task.id], "write to the content store once all segments are in (finishStream)");
  const done = r.of("task.complete");
  assert.equal(done.length, 1);
  assert.equal(done[0].id, r.task.id);
  assert.equal(done[0].token, 5);
  const result = done[0].result ?? done[0];
  assert.equal(result.kind, "stream", `manifest expanded into the completion message: ${JSON.stringify(done[0]).slice(0, 300)}`);
  assert.deepEqual(result.header, MANIFEST.header);
  assert.deepEqual(Object.keys(result.segments), ["3", "4"]);
  assert.equal(r.of("task.fail").length + r.of("task.release").length, 0);
  assert.deepEqual(r.ended, ["completed"]);
  const c = r.node.debug().counters;
  assert.deepEqual([c.completed, c.streamTasks, c.streamFrames, c.bakedFrames], [1, 1, 16, 0]);
});

test("BSN-03 yield: when the host finishes the current frame it returns { yielded }, the node releases once without counting a failure; a yield that arrives after completion finishes as usual", async () => {
  for (const cause of ["play", "drag", "urgent"]) {
    const r = await rig();
    await r.claim();
    r.node.yieldFor(cause);
    assert.equal(r.jobs[0].job.yielding(), true, "the host learns it must yield before each frame");
    assert.equal(r.of("task.release").length, 0, "release only after the current frame is done");
    r.jobs[0].job.progress(4);
    r.jobs[0].resolve({ yielded: true });
    await flush();
    const rel = r.of("task.release");
    assert.equal(rel.length, 1, cause);
    assert.deepEqual([rel[0].id, rel[0].token, rel[0].reason], [r.task.id, 5, `yield-${cause}`]);
    assert.equal(r.of("task.fail").length + r.of("task.complete").length, 0);
    assert.deepEqual(r.node.debug().counters.released, { [`yield-${cause}`]: 1 });
    assert.equal(r.finished.length, 0);
  }
  // 让路之后宿主迟迟不回(这一帧在舞台里被挡住):上限到了中止并立即放回,同快照任务
  const stuck = await rig();
  await stuck.claim();
  stuck.node.yieldFor("play");
  stuck.advance(YIELD_FRAME_MAX_MS + 1);
  stuck.node.tick();
  await flush();
  assert.equal(stuck.of("task.release").length, 1);
  assert.equal(stuck.jobs[0].job.signal.aborted, true, "abort this segment on the host");
  stuck.jobs[0].resolve({ manifest: MANIFEST });
  await flush();
  assert.equal(stuck.of("task.complete").length, 0, "late results are dropped");
  // 要求让路时宿主其实已经全部做完:照常完成(放回只会让下一个认领者重做)
  const late = await rig();
  await late.claim();
  late.node.yieldFor("play");
  late.jobs[0].resolve({ manifest: MANIFEST });
  await flush();
  assert.equal(late.of("task.complete").length, 1);
  assert.equal(late.of("task.release").length, 0);
});

test("BSN-04 page hidden: do not wait for the current frame, abort and release immediately; claim lost: abort, late results are dropped; host error: hand back as a retryable failure", async () => {
  const hidden = await rig();
  await hidden.claim();
  hidden.node.yieldFor("hidden");
  await flush();
  assert.deepEqual(hidden.of("task.release").map((m) => m.reason), ["yield-hidden"]);
  assert.equal(hidden.jobs[0].job.signal.aborted, true);
  hidden.jobs[0].resolve({ manifest: MANIFEST });
  await flush();
  assert.equal(hidden.of("task.complete").length, 0);

  const lost = await rig();
  await lost.claim();
  lost.node.receive({ type: "task.lease-lost", id: lost.task.id, token: 5, reason: "superseded" });
  await flush();
  assert.equal(lost.jobs[0].job.signal.aborted, true, "claim lost: abort this segment");
  lost.jobs[0].resolve({ manifest: MANIFEST });
  await flush();
  assert.equal(lost.of("task.complete").length + lost.of("task.release").length + lost.of("task.fail").length, 0, "claim lost, nothing more is sent");
  assert.equal(lost.node.debug().counters.lost, 1);

  const broken = await rig();
  await broken.claim();
  broken.jobs[0].reject(Object.assign(new Error("pushing segment returned 503"), { retryable: true }));
  await flush();
  const fail = broken.of("task.fail");
  assert.equal(fail.length, 1);
  assert.equal(fail[0].retryable, true);
  const final = await rig();
  await final.claim();
  final.jobs[0].reject(Object.assign(new Error("task has no input.stream"), { retryable: false }));
  await flush();
  assert.equal(final.of("task.fail")[0].retryable, false);
});

test("BSN-05 host that does not produce streams: capability flag is false, does not claim stream tasks; claims only after an encoder is probed", async () => {
  const none = await rig({ withStream: false });
  assert.equal(none.node.debug().streams, false, "no bakeStream given: does not produce streams");
  assert.equal(none.of("node.hello")[0].capabilities.streams, false);
  assert.equal(none.of("task.claim").length, 0);
  assert.deepEqual(none.node.debug().counters.blocked, { "2:streams": 1 }, "blocked by node-side filter rule 2");

  const later = await rig({ streams: false });
  assert.equal(later.of("task.claim").length, 0, "host has not probed an encoder yet");
  later.state.streams = true;
  later.advance(5000);
  later.node.tick();
  assert.equal(later.node.debug().streams, true);
  assert.equal(later.of("task.claim").length, 1, "probed: claims on the next beat");
});

/* ------------------------------------------------------------------ 父页守卫 */

test("BSN-06 parent page guard: bake-frame pixels are accepted by shape (a real bitmap, size matches the rect, rect is integers and width and height are even); an event with the wrong shape is dropped entirely", () => {
  const HASH = "a".repeat(64);
  const base = { type: "bake-frame", session: "s1", clipId: "c1", localFrame: 3, hash: HASH, bytes: 100 };
  const had = globalThis.ImageBitmap;
  class FakeBitmap { constructor(w, h) { this.width = w; this.height = h; } }
  try {
    globalThis.ImageBitmap = FakeBitmap;
    const bitmap = new FakeBitmap(464, 304);
    const clean = sanitizeStageEvent({ ...base, pixels: { rect: BOUND, bitmap, extra: 1 } });
    assert.ok(clean, "the right shape is accepted");
    assert.equal(clean.pixels.bitmap, bitmap, "bitmap is passed to the caller as is");
    assert.deepEqual(clean.pixels.rect, BOUND);
    assert.deepEqual(Object.keys(clean.pixels).sort(), ["bitmap", "rect"], "keeps only recognized fields");
    assert.equal("htmlGz" in clean || "htmlRaw" in clean, false, "an event that needs only pixels may omit the HTML bytes");
    assert.equal(sanitizeStageEvent({ ...base, pixels: null }).pixels, null);
    assert.equal("pixels" in sanitizeStageEvent(base), false, "an event without pixels is the same as before");
    const bad = [
      { rect: BOUND, bitmap: { width: 464, height: 304 } },                    // 不是位图
      { rect: BOUND, bitmap: new FakeBitmap(464, 300) },                       // 大小与矩形不一致
      { rect: { ...BOUND, w: 463 }, bitmap: new FakeBitmap(463, 304) },        // 宽不是偶数
      { rect: { ...BOUND, x: 0.5 }, bitmap },                                  // 不是整数
      { rect: { ...BOUND, x: -1e9 }, bitmap },                                 // 坐标离谱
      { rect: { x: 0, y: 0, w: STAGE_MESSAGE_LIMITS.maxPixelSide + 2, h: 304 }, bitmap: new FakeBitmap(STAGE_MESSAGE_LIMITS.maxPixelSide + 2, 304) },
      { rect: null, bitmap },
      { bitmap },
      "pixels",
    ];
    for (const pixels of bad) assert.equal(sanitizeStageEvent({ ...base, pixels }), null, JSON.stringify(pixels)?.slice(0, 80));
  } finally {
    if (had === undefined) delete globalThis.ImageBitmap; else globalThis.ImageBitmap = had;
  }
  // 运行环境里没有 ImageBitmap(Node):带像素的事件一律不收
  if (typeof globalThis.ImageBitmap === "undefined") assert.equal(sanitizeStageEvent({ ...base, pixels: { rect: BOUND, bitmap: {} } }), null);
});

/* ------------------------------------------------------------------ 要像素的矩形与 SVG */

test("BSN-07 pixel rect: integers, even width and height, within the limit; a cropped SVG is not scaled and is translated to the rect's top-left; a small SVG is unchanged verbatim", () => {
  assert.deepEqual(pixelRect(BOUND), BOUND);
  assert.notEqual(pixelRect(BOUND), BOUND, "returns a new object");
  assert.deepEqual(pixelRect({ x: 0, y: 0, w: 1920, h: 1080, more: 1 }), { x: 0, y: 0, w: 1920, h: 1080 });
  for (const bad of [null, "r", {}, { ...BOUND, w: 463 }, { ...BOUND, h: 0 }, { ...BOUND, x: 1.5 }, { ...BOUND, w: PIXELS_MAX_SIDE + 2 }, { ...BOUND, y: -PIXELS_MAX_SIDE - 1 }, { ...BOUND, w: "464" }]) {
    assert.equal(pixelRect(bad), null, JSON.stringify(bad));
  }
  assert.equal(PIXELS_MAX_SIDE, STAGE_MESSAGE_LIMITS.maxPixelSide, "the stage and the parent page guard use the same limit");
  // SVG 的拼法要 DOM(template、XMLSerializer):给一个只够用的替身
  const had = globalThis.XMLSerializer;
  globalThis.XMLSerializer = class { serializeToString(n) { return n.text; } };
  const doc = { createElement: () => ({ set innerHTML(v) { this.html = v; }, get content() { const html = this.html; return { querySelectorAll: () => [], childNodes: [{ text: html }] }; } }) };
  try {
    const svg = pixelsSvg(doc, { html: "<b>x</b>", boxWidth: 400, boxHeight: 240, rect: BOUND, css: ".a{}" });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="464" height="304">/, "image size = rect size");
    assert.match(svg, /left:32px;top:32px;width:400px;height:240px;transform:scale\(1\)/, "box moves to (-x, -y), no scaling");
    assert.match(svg, /<style><!\[CDATA\[\.a\{\}\]\]><\/style>/, "inlines the page stylesheet");
    const flush0 = pixelsSvg(doc, { html: "<b>x</b>", boxWidth: 1920, boxHeight: 1080, rect: { x: 0, y: 0, w: 1920, h: 1080 } });
    assert.match(flush0, /left:0;top:0;width:1920px;height:1080px;transform:scale\(1\)/, "rect starts at the origin: no translation");
    // 小尺寸:与改动前的拼法逐字相同(盒子恒在左上角)
    const small = smallSvg(doc, { html: "<b>x</b>", boxWidth: 400, boxHeight: 240, scale: 0.5, width: 200, height: 120, css: "" });
    assert.equal(small, '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><foreignObject x="0" y="0" width="200" height="120">'
      + '<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:200px;height:120px;overflow:hidden">'
      + '<div style="position:absolute;left:0;top:0;width:400px;height:240px;transform:scale(0.5);transform-origin:0 0;isolation:isolate;overflow:visible">'
      + '<div style="position:absolute;inset:0"><b>x</b></div></div></div></foreignObject></svg>');
  } finally {
    if (had === undefined) delete globalThis.XMLSerializer; else globalThis.XMLSerializer = had;
  }
});

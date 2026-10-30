/**
 * 在线页面一侧「依赖下层的卡贴它的轨道流」的单测:真的在线来源(`render/snapshotSource.ts` 的 `OnlineSnapshotSource`,
 * 读层表里 `kind: below` 的行)接上真的父页选帧(`snapshotFeed.ts`)。任务书 `render-refactor-task.md`「戊二」的第四块(下层四)。
 * 跑:npm test -- src/editor/snapshotFeedBelowOnline.test.mjs
 *
 * 父页那一半的规矩(抑制、有流不读快照、追到精确活渲以后撤、过期、占预算)在 `snapshotFeedBelow.test.mjs` 里按就绪消息钉过;
 * 这里钉的是「在线来源读层表读出来的那一层,走到父页就是同一套」:
 *   - 播放、暂停、拖动都发流平面,平面带 `plane: "stage"`;这张卡被抑制;不读快照(层表里同一张卡的快照层就绪着也不选);
 *   - 停下追到精确活渲以后不再抑制,流平面照发;
 *   - 下层改了:父页当场不再发(用 store 里的项目比层表那一行带的签名,不等在线来源收到新项目);在线来源收到新项目以后撤掉那一层;
 *     层表换成新的一行(新键、新签名)以后又贴;
 *   - 占解码器预算:和别的流一起数。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

globalThis.window = globalThis;
let plan = null;
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => plan } });
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => ({ session: "s", localRev: 1 }), pushWanted: () => {} } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));
const { planFeed, pickForSetTime, noteSettled, suppressedAt, streamPlanesAt, snapshotFeedDebug, setSnapshotSource, syncSnapshotSubscription, resetSnapshotFeed } = feed;
const { OnlineSnapshotSource, LAYER_MAP_PREFIX, LAYER_MAP_POLL_MS } = await import(srcUrl("render/snapshotSource.ts"));
const { SEGMENT_FRAMES } = await import(srcUrl("render/streamPlayer.ts"));
// 同屏流的预算是数像素的(`render/streamBudget.mjs`)。这份测试里的卡都是整幅的、项目 30 帧每秒:
// 同屏放得下的条数由预算算出来(15.04 亿 ÷ (1920 × 2176 × 30) = 12),下面仍叫它 DECODER_BUDGET
const { STREAM_PIXEL_RATE_BUDGET, streamCost, stageStreamPixels } = await import(srcUrl("render/streamBudget.mjs"));
const DECODER_BUDGET = Math.floor(STREAM_PIXEL_RATE_BUDGET / streamCost(stageStreamPixels({ width: 1920, height: 1080 }), 30));
const { streamInputSig } = await import(srcUrl("render/streamInputSig.mjs"));

let now = 1000;
performance.now = () => now;

const FPS = 30;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const RK = (n) => n.toString(16).padStart(64, "0");
const bytesOf = (text) => new TextEncoder().encode(text);
const card = (id, start, end, extra = {}) => ({ id, cardId: "c", start, end, params: {}, ...extra });
const GLASS_START = 40 / FPS;   // 第 40 帧起,不是 15 的倍数
function project(edit = (p) => p) {
  return edit({
    id: "p1", version: 1, name: "p", width: 1920, height: 1080, fps: FPS, duration: 20, media: [],
    tracks: [
      { id: "top", name: "top", clips: [card("title", 0, 10, { params: { text: "标题" } })] },
      { id: "mid", name: "mid", clips: [card("glass", GLASS_START, GLASS_START + 4, { frame: { x: 100, y: 100, w: 600, h: 300 } })] },
      { id: "low", name: "low", clips: [card("mover", 0, 10, { params: { speed: 1 } })] },
    ],
  });
}
const sigOf = (p) => streamInputSig(p, { clipIds: ["glass"], kind: "below" });
const heavy = (...ids) => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(ids) }] });
const at = (frame) => frame / FPS + 1e-4;
/** 播放头在第 77 帧(这条流的第 2 段)时在线来源取到本页的分段:往回一段、往前几秒(只取播放头附近的) */
const READY = [[1, 6]];

/** 假内容库 + 假素材服务 */
function world() {
  const w = { content: new Map(), bytes: new Map(), clock: 1_000_000 };
  w.deps = {
    async request(msg) {
      if (!w.content.has(msg.key)) return { type: "content.item", kind: msg.kind, key: msg.key, missing: true };
      return { type: "content.item", kind: msg.kind, key: msg.key, body: structuredClone(w.content.get(msg.key)), hash: "x" };
    },
    assetBase: () => "https://h.example/media/api/asset/",
    authHeaders: async () => ({ Authorization: "Bearer T" }),
    async fetch(url) {
      const b = w.bytes.get(url.split("/").pop());
      if (!b) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, headers: { get: () => "video/mp4" }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    },
    now: () => w.clock, setTimer: () => 0, clearTimer: () => {},
  };
  /** 一条流的清单(分段 0～7)和它的字节 */
  w.putStream = (rk, { clipIds, kind, plane }) => {
    const initBytes = bytesOf(`init ${rk}`), initHash = sha(initBytes), id = initHash.slice(0, 16);
    w.bytes.set(initHash, initBytes);
    const segments = {};
    for (let n = 0; n <= 7; n++) {
      const body = bytesOf(`seg ${rk} ${n}`), hash = sha(body);
      w.bytes.set(hash, body);
      segments[n] = { hash, bytes: body.length, init: id, stride: 1, samples: SEGMENT_FRAMES, sig: null, encoder: "libx264" };
    }
    w.content.set(`${rk}:0-7`, { v: 1, kind: "stream", resultKey: rk, range: { from: 0, to: 7 },
      header: { kind, plane, clipIds, fps: FPS, bound: { x: 0, y: 0, w: 1920, h: 1080 }, offset: { x: 0, y: 0 }, tight: { x: 96, y: 96, w: 608, h: 308 } },
      inits: { [id]: { hash: initHash, bytes: initBytes.length, codec: "avc1.640028", width: 608, height: 616, timescale: 15360, rect: { x: 96, y: 96, w: 608, h: 308 }, encoder: "libx264" } },
      segments });
  };
  w.putMap = (streams, layers = []) => w.content.set(`${LAYER_MAP_PREFIX}p1`, { v: 3, kind: "layer-map", projectId: "p1", entryKey: "e", fps: FPS, span: 60, at: 1, layers, streams });
  w.settle = async (src) => { await src.tickNow(); await src.idle(); await src.tickNow(); await src.idle(); };
  return w;
}
const belowRow = (p, rk, over = {}) => ({ topClipId: "glass", clipIds: ["glass"], kind: "below", plane: "stage", contentKey: `ck-${rk.slice(-2)}`,
  candidates: [{ envFingerprint: "fp-host", resultKey: rk }], originFrame: 40, lastSegment: 7, segmentsPerTask: 8, inputSig: sigOf(p), ...over });
const cardRow = (id, rk) => ({ topClipId: id, clipIds: [id], kind: "card", plane: "local", contentKey: `ck-${id}`,
  candidates: [{ envFingerprint: "fp-host", resultKey: rk }], originFrame: 0, lastSegment: 7, segmentsPerTask: 8 });

let w, src;
beforeEach(() => {
  resetSnapshotFeed();
  w = world();
  src = new OnlineSnapshotSource(w.deps, { tier: "original" });
  setSnapshotSource(src);
  syncSnapshotSubscription(() => {});
  plan = { segments: [] };
  now += 10_000;
});

test("在线来源读出依赖下层的流:播放、暂停、拖动都发 plane: stage 的流平面、被抑制、不读快照;追上以后不抑制、平面照发", async () => {
  const p = project();
  const rk = RK(0xb1);
  plan = heavy("glass");
  w.putStream(rk, { clipIds: ["glass"], kind: "below", plane: "stage" });
  // 层表里这张卡另有一层就绪着的快照(本地档):有流就不读它
  const snap = sha(bytesOf("<div>snap</div>"));
  w.bytes.set(snap, bytesOf("<div>snap</div>"));
  w.content.set("r-glass:0-59", { v: 1, kind: "snapshot", tier: "shared", resultKey: "r-glass", dirKey: "r-glass", range: { from: 0, to: 59 }, frames: [[37, snap, 10]] });
  w.putMap([belowRow(p, rk)], [{ clipId: "glass", kind: "html", key: "k-glass", tier: "shared", resultKey: "r-glass", dirKey: "r-glass", entryKey: null, firstFrame: 40, count: 120,
    contentKey: "ck-snap", envFingerprint: "fp-host", candidates: [{ envFingerprint: "fp-host", resultKey: "r-glass", key: "k-glass", dirKey: "r-glass" }] }]);
  src.setProject("p1");
  src.setInputs(p);
  src.focus(at(77), FPS);
  await w.settle(src);
  const want = [{ clipIds: ["glass"], key: rk, ranges: READY, originFrame: 40, plane: "stage" }];
  assert.deepEqual(snapshotFeedDebug({ project: p, t: at(77), playing: false }).ready.find((r) => r.clipId === "glass").kinds.map((k) => k.kind).sort(), ["html", "stream"], "快照层和流的层都就绪着");
  for (const playing of [true, false]) {
    const head = { project: p, t: at(77), playing };
    const f = planFeed(head);
    assert.deepEqual(f.heavy, ["glass"]);
    assert.deepEqual(f.streamPlanes, want, `playing=${playing}`);
    assert.deepEqual(suppressedAt(head), ["glass"]);
    assert.equal(f.picks.size, 0, "有流不读快照");
  }
  for (const frame of [55, 69, 70, 100, 144]) {   // 分段的第一帧、最后一帧、下一段的第一帧、中间、就绪范围的最后一帧
    const head = { project: p, t: at(frame), playing: false };
    assert.deepEqual(streamPlanesAt(head), want, `拖到第 ${frame} 帧`);
    assert.deepEqual(pickForSetTime(head).snapshots, {});
    assert.deepEqual(suppressedAt(head), ["glass"]);
  }
  // 给舞台的清单:种类 below、按舞台坐标(`StreamPlaneSender` 把它随流平面带过去,播放器据此核对平面挂在舞台根下)
  const plane = src.streamPlane(rk);
  assert.equal(plane.manifest.kind, "below");
  assert.equal(plane.manifest.plane, "stage");
  assert.deepEqual(plane.manifest.tight, { x: 96, y: 96, w: 608, h: 308 });
  // 停下追到精确活渲:不再抑制,流平面留着
  const head = { project: p, t: at(100), playing: false };
  pickForSetTime(head);
  noteSettled("front", ["glass"]);
  assert.deepEqual(suppressedAt(head), []);
  assert.deepEqual(streamPlanesAt(head), want);
  src.stop();
});

test("在线页面改了下层:父页当场不再发旧流;在线来源收到新项目撤掉那一层;层表换成新的一行以后又贴", async () => {
  const p0 = project();
  const rk0 = RK(0xb1), rk1 = RK(0xb2);
  plan = heavy("glass");
  w.putStream(rk0, { clipIds: ["glass"], kind: "below", plane: "stage" });
  w.putMap([belowRow(p0, rk0)]);
  src.setProject("p1");
  src.setInputs(p0);
  src.focus(at(77), FPS);
  await w.settle(src);
  assert.equal(streamPlanesAt({ project: p0, t: at(77), playing: false }).length, 1);
  // 改下层的一个参数。父页拿到的是 store 里的新项目;在线来源此刻还没收到(`setInputs` 没调)—— 父页自己比签名,旧流当场不发
  const p1 = project((q) => { q.tracks[2].clips[0].params = { speed: 2 }; return q; });
  assert.notEqual(sigOf(p1), sigOf(p0));
  for (const playing of [false, true]) {
    const head = { project: p1, t: at(77), playing };
    assert.deepEqual(planFeed(head).streamPlanes, [], `playing=${playing}`);
    assert.deepEqual(suppressedAt(head), ["glass"], "照没有流的重卡办:未 settled 暂停进 scrub,播放进 heavy");
    assert.deepEqual(snapshotFeedDebug(head).staleBelow, ["glass"]);
  }
  // 在线来源收到新项目:那一层撤掉(就绪区间发空),清单也不再给
  src.setInputs(p1);
  assert.equal(src.streamPlane(rk0), null);
  assert.deepEqual(src.debug().staleStreams, ["glass"]);
  assert.deepEqual(planFeed({ project: p1, t: at(77), playing: true }).streamPlanes, []);
  // 上面的层改了不算:回到 p0 的下层、只改标题,旧流照贴
  const p2 = project((q) => { q.tracks[0].clips[0].params = { text: "换了标题" }; return q; });
  src.setInputs(p2);
  assert.equal(streamPlanesAt({ project: p2, t: at(77), playing: true }).length, 1);
  // 切分方按新的一版重产:层表换成新的一行(新键、新签名)
  src.setInputs(p1);
  w.putStream(rk1, { clipIds: ["glass"], kind: "below", plane: "stage" });
  w.putMap([belowRow(p1, rk1)]);
  w.clock += LAYER_MAP_POLL_MS;
  await w.settle(src);
  assert.deepEqual(streamPlanesAt({ project: p1, t: at(77), playing: false }), [{ clipIds: ["glass"], key: rk1, ranges: READY, originFrame: 40, plane: "stage" }]);
  assert.deepEqual(suppressedAt({ project: p1, t: at(77), playing: false }), ["glass"]);
  src.stop();
});

test("占解码器预算:层表里另有六条单卡流排在前面,这张卡的流超出预算,不发平面、照旧抑制着", async () => {
  const extra = Array.from({ length: DECODER_BUDGET }, (_, i) => `x${i}`);
  const p = project((q) => { for (const id of extra) q.tracks.push({ id: `t-${id}`, name: id, clips: [card(id, 0, 10)] }); return q; });
  plan = heavy("glass", ...extra);
  const rk = RK(0xb1);
  extra.forEach((id, i) => w.putStream(RK(0xc0 + i), { clipIds: [id], kind: "card", plane: "local" }));
  w.putStream(rk, { clipIds: ["glass"], kind: "below", plane: "stage" });
  w.putMap([...extra.map((id, i) => cardRow(id, RK(0xc0 + i))), belowRow(p, rk)]);
  src.setProject("p1");
  src.setInputs(p);
  src.focus(at(77), FPS);
  await w.settle(src);
  const f = planFeed({ project: p, t: at(77), playing: false });
  assert.equal(f.streamPlanes.length, DECODER_BUDGET);
  assert.equal(f.streamPlanes.some((x) => x.clipIds[0] === "glass"), false);
  assert.ok(f.scrub.includes("glass"), "有流、只是超了预算:照旧抑制着");
  // 少一条别的流:这张卡的进了预算,带着 plane: stage
  plan = heavy("glass", ...extra.slice(1));
  const g = planFeed({ project: p, t: at(77), playing: false });
  assert.deepEqual(g.streamPlanes.find((x) => x.clipIds[0] === "glass"), { clipIds: ["glass"], key: rk, ranges: READY, originFrame: 40, plane: "stage" });
  src.stop();
});

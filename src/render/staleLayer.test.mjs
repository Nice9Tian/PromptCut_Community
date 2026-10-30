/**
 * 在线来源认出旧参数的层(stale-layer;`snapshotSource.ts` 的 `OnlineSnapshotSource.setInputs`、层表的 `inputSig`):
 *   SL-1 改参数:旧层马上撤掉(就绪发空、取不到字节);结果在路上时不确认缺料(沙漏)、时间轴不出徽标;
 *        等满 STALE_AWAIT_MS 还没新层才确认(图标、徽标),并叫覆盖订阅方;新层表到了照常换上
 *   SL-2 改回原来的参数:原来那一层还在,照贴
 *   SL-3 旧层表(没有 inputSig)照旧贴,改参数也不撤(向后兼容);页面没给项目也不比
 *   SL-4 取原尺寸(层表 v 3 候选)同样撤;layerClipIds 不含过期的层;layerRefOf 带签名比对
 *   SL-5 导出(`originals.ts`):给了项目时,旧输入的层算缺
 * 跑:node --test src/render/staleLayer.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { OnlineSnapshotSource, LAYER_MAP_PREFIX, STALE_AWAIT_MS, applyReadyMessage, layerOf, layerRefOf } from "./snapshotSource.ts";
import { clipInputSig } from "./layerInputSig.mjs";

globalThis.window = globalThis;

const H = (n) => n.toString(16).padStart(64, "0");

function project(params = { title: "hello" }) {
  return { version: 1, id: "p1", name: "p", width: 1920, height: 1080, fps: 30, duration: 10, themeId: "midnight", media: [],
    tracks: [{ id: "t", name: "t", clips: [
      { id: "a", cardId: "user-card", start: 0, end: 2, params },
      { id: "b", cardId: "builtin-heavy", start: 0, end: 2, params: { k: 1 } },
    ] }] };
}

function world() {
  const content = new Map();
  const bytes = new Map();
  const deps = {
    async request(msg) {
      if (!content.has(msg.key)) return { type: "content.item", kind: msg.kind, key: msg.key, missing: true };
      return { type: "content.item", kind: msg.kind, key: msg.key, body: structuredClone(content.get(msg.key)), hash: "x" };
    },
    assetBase: () => "https://h.example/media/api/asset/",
    authHeaders: async () => ({}),
    async fetch(url) {
      const hash = url.split("/").pop();
      const b = bytes.get(hash);
      if (!b) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, headers: { get: () => "text/html" }, arrayBuffer: async () => b.buffer.slice(0) };
    },
    setTimer: () => 0,
    clearTimer: () => {},
  };
  const layerMap = (layers, v = 3) => content.set(`${LAYER_MAP_PREFIX}p1`, { v, kind: "layer-map", projectId: "p1", fps: 30, span: 60, at: 1, layers });
  const manifest = (resultKey, count, salt = 0) => {
    const frames = [], small = [];
    for (let f = 0; f < count; f++) {
      frames.push([f, H(1000 + f + salt), 10]);
      small.push([f, H(5000 + f + salt), 10]);
      bytes.set(H(1000 + f + salt), new TextEncoder().encode(`<div>${salt}:${f}</div>`));
      bytes.set(H(5000 + f + salt), new Uint8Array([82, 73, 70, 70]));
    }
    content.set(`${resultKey}:0-${count - 1}`, { v: 1, kind: "snapshot", resultKey, range: { from: 0, to: count - 1 }, frames, small });
  };
  return { deps, content, layerMap, manifest };
}

const layer = (clipId, key, sig, extra = {}) => ({ clipId, kind: "html", key, resultKey: key, firstFrame: 0, count: 60,
  contentKey: `ck-${key}`, envFingerprint: "f".repeat(16), ...(sig ? { inputSig: sig } : {}), ...extra });

async function setup({ tier = "small", layers, p = project() } = {}) {
  const w = world();
  w.layerMap(layers(p));
  for (const l of layers(p)) w.manifest(l.resultKey, 60);
  let now = 0;
  const src = new OnlineSnapshotSource({ ...w.deps, now: () => now }, { tier });
  const index = new Map();
  let coverageCalls = 0;
  src.subscribeCoverage(() => { coverageCalls++; });
  src.subscribeReady("s", 0, (m) => applyReadyMessage(index, m));
  src.setProject("p1");
  src.setInputs(p);
  src.focus(0, 30);
  await src.tickNow();
  return { w, src, index, advance: (ms) => { now += ms; }, coverageCalls: () => coverageCalls };
}

test("SL-1 改参数:旧层马上撤、在路上时沙漏(不确认)、过了等待期才确认;新层表到了换上", async () => {
  const p0 = project();
  const { w, src, index, advance, coverageCalls } = await setup({ p: p0, layers: (p) => [layer("a", "KA1", clipInputSig(p, "a")), layer("b", "KB1", clipInputSig(p, "b"))] });
  assert.deepEqual(layerOf(index, "a", "html").ranges, [[0, 59]], "改之前照贴");
  assert.equal(src.frameConfirmedMissing("a", 10), false);
  assert.equal(src.coverage("a"), "full");
  await assert.doesNotReject(src.fetchSnapshot("html", "KA1", 3));

  const p1 = project({ title: "world" });
  const before = coverageCalls();
  src.setInputs(p1);
  // 同步撤掉:不等下一轮轮询
  assert.deepEqual(layerOf(index, "a", "html"), { clipId: "a", kind: "html", key: "KA1", ranges: [] }, "旧层撤掉(就绪发空)");
  assert.deepEqual(layerOf(index, "b", "html").ranges, [[0, 59]], "没改的片段照贴");
  await assert.rejects(src.fetchSnapshot("html", "KA1", 3), /没有这一帧/, "旧层的字节不再给");
  assert.equal(src.frameConfirmedMissing("a", 10), false, "新结果在路上:不确认(沙漏)");
  assert.equal(src.coverage("a"), "unknown", "时间轴不出徽标");
  assert.ok(coverageCalls() > before, "覆盖订阅方被叫(父页重算图标)");
  assert.equal(src.layerClipIds().has("a"), false, "过期的层不算有产物");
  assert.equal(src.debug().stale[0].clipId, "a");

  // 等满等待期:确认缺料
  advance(STALE_AWAIT_MS + 1);
  const mid = coverageCalls();
  await src.tickNow();
  assert.equal(src.frameConfirmedMissing("a", 10), true, "等满还没新层:确认(图标)");
  assert.equal(src.coverage("a"), "none");
  assert.ok(coverageCalls() > mid, "到期时叫覆盖订阅方");

  // 渲染节点按新输入重写层表、渲完:照常换上
  w.layerMap([layer("a", "KA2", clipInputSig(p1, "a")), layer("b", "KB1", clipInputSig(p1, "b"))]);
  w.manifest("KA2", 60, 7);
  advance(10_000);
  await src.tickNow();
  assert.deepEqual(layerOf(index, "a", "html"), { clipId: "a", kind: "html", key: "KA2", ranges: [[0, 59]] }, "新结果换上");
  assert.equal(src.frameConfirmedMissing("a", 10), false);
  assert.equal(src.coverage("a"), "full");
  assert.deepEqual(src.debug().stale, []);
});

test("SL-2 改回原来的参数:原来那一层还在就照贴", async () => {
  const p0 = project();
  const { src, index } = await setup({ p: p0, layers: (p) => [layer("a", "KA1", clipInputSig(p, "a"))] });
  src.setInputs(project({ title: "world" }));
  assert.deepEqual(layerOf(index, "a", "html").ranges, []);
  src.setInputs(project({ title: "hello" })); // 新对象、同样的输入
  assert.deepEqual(layerOf(index, "a", "html"), { clipId: "a", kind: "html", key: "KA1", ranges: [[0, 59]] });
  assert.deepEqual(src.debug().stale, []);
});

test("SL-3 旧层表没有签名、页面没给项目:照旧贴(向后兼容)", async () => {
  const { src, index } = await setup({ layers: () => [layer("a", "KA1", null)] });
  src.setInputs(project({ title: "world" }));
  assert.deepEqual(layerOf(index, "a", "html").ranges, [[0, 59]], "层表没有 inputSig:不比");
  assert.equal(src.frameConfirmedMissing("a", 10), false);

  const w = world();
  const p0 = project();
  w.layerMap([layer("a", "KA1", clipInputSig(p0, "a"))]);
  w.manifest("KA1", 60);
  const src2 = new OnlineSnapshotSource(w.deps);
  const index2 = new Map();
  src2.subscribeReady("s", 0, (m) => applyReadyMessage(index2, m));
  src2.setProject("p1");
  await src2.tickNow();
  assert.deepEqual(layerOf(index2, "a", "html").ranges, [[0, 59]], "没给项目:不比");
});

test("SL-4 取原尺寸(v 3 候选)同样撤;layerRefOf 带签名比对", async () => {
  const p0 = project();
  const sigB = clipInputSig(p0, "b");
  const { src, index } = await setup({ tier: "original", p: p0, layers: (p) => [layer("b", "KB1", clipInputSig(p, "b"), {
    candidates: [{ envFingerprint: "f".repeat(16), resultKey: "KB1", key: "KB1" }] })] });
  assert.deepEqual(layerOf(index, "b", "html").ranges, [[0, 59]], "内置重卡:原尺寸照贴");
  const p1 = { ...p0, tracks: p0.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === "b" ? { ...c, params: { k: 2 } } : c)) })) };
  src.setInputs(p1);
  assert.deepEqual(layerOf(index, "b", "html").ranges, [], "内置重卡改了参数:旧层撤掉(播放占位、暂停活渲)");
  await assert.rejects(src.fetchSnapshot("html", "KB1", 0), /没有这一帧的预渲染原尺寸/);

  const table = { v: 3, kind: "layer-map", projectId: "p1", fps: 30, span: 60, layers: [layer("b", "KB1", sigB)] };
  assert.equal(layerRefOf(table, "b", { inputSig: sigB })?.key, "KB1");
  assert.equal(layerRefOf(table, "b", { inputSig: clipInputSig(p1, "b") }), null, "旧参数的层");
  assert.equal(layerRefOf(table, "b")?.key, "KB1", "不给签名:照旧");
});

test("SL-5 导出:给了项目时旧输入的层算缺,对得上的照取", async () => {
  const O = await import(srcUrl("export/originals.ts"));
  const p0 = project();
  const map = { v: 3, kind: "layer-map", projectId: "p1", fps: 30, span: 60, layers: [
    layer("a", "KA1", clipInputSig(p0, "a"), { count: 2 }), layer("b", "KB1", clipInputSig(p0, "b"), { count: 2 }),
  ] };
  const request = async (msg) => {
    if (msg.key === "layers:p1") return { type: "content.item", body: map };
    if (msg.key === "KA1:0-1" || msg.key === "KB1:0-1") return { type: "content.item", body: { frames: [[0, H(1)], [1, H(2)]] } };
    return { type: "content.item", missing: true };
  };
  const deps = { request, assetBase: () => "http://x/api/asset", authHeaders: async () => ({}) };
  const same = await O.loadOriginalsIndex("p1", deps, { project: p0 });
  assert.deepEqual(same.missing, []);
  const edited = await O.loadOriginalsIndex("p1", deps, { project: project({ title: "world" }) });
  assert.deepEqual(edited.missing, ["a"], "改了参数的卡:旧层不导出,算缺");
  assert.equal(edited.hashAt("a", 0), null);
  assert.equal(edited.hashAt("b", 0), H(1));
  const legacy = await O.loadOriginalsIndex("p1", deps);
  assert.deepEqual(legacy.missing, [], "不给项目:照旧");
});

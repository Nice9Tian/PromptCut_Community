/**
 * L3:在线页面按层表与清单取预渲染原尺寸进 L2(C10 契约第 5 节、第 18 节第 3 条),以及最低一档(`small`)的 L2 只存小尺寸(第 4 节)。
 *
 *   L3-1 层表:`original` 只认 v 2 且带 contentKey、envFingerprint 的层;最低一档 v 1、v 2 都认;不认得的 v 整张当没有
 *   L3-2 原尺寸:按清单的 frames 表凭只读票据拉 snap/<hash>,写进 L2 的 snapshots,ranges 写入即就绪;小尺寸请求 0
 *   L3-3 关掉再开(同一个 L2):已在库里的块不再请求,就绪照样出来
 *   L3-4 预取只拉播放头前后 2 秒;层表对不上(v 1)的层按「没有预渲染结果」处理,一个请求都不发
 *   L3-5 最低一档:小尺寸存进 L2(px/<hash>),重开后不再请求;库里没有 snap/
 * 跑:node --test src/render/c10-l3-source.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeIndexedDB } from "../testing/fakeIndexedDB.mjs";
import { OnlineSnapshotSource, parseLayerMap, layerRefOf, usableLayer, LAYER_MAP_PREFIX, applyReadyMessage, layerOf } from "./snapshotSource.ts";
import { openL2, L2_DB_NAME } from "../online/l2.ts";

const H = (n) => n.toString(16).padStart(64, "0");
const FP = "f1f1f1f1f1f1f1f1";

function world({ fps = 30 } = {}) {
  const content = new Map();
  const fetches = [];
  const blobs = new Map();
  const deps = {
    async request(msg) {
      if (msg.type !== "content.get") throw new Error("只认 content.get");
      if (!content.has(msg.key)) return { type: "content.item", kind: msg.kind, key: msg.key, missing: true };
      return { type: "content.item", kind: msg.kind, key: msg.key, body: structuredClone(content.get(msg.key)) };
    },
    assetBase: () => "https://h.example/media/api/asset",
    authHeaders: async () => ({ Authorization: "Bearer RT" }),
    async fetch(url, init) {
      const [ns, hash] = url.split("/").slice(-2);
      fetches.push({ ns, hash, auth: init?.headers?.Authorization });
      const b = blobs.get(`${ns}/${hash}`);
      if (!b) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, headers: { get: () => (ns === "px" ? "image/webp" : "text/html; charset=utf-8") }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    },
    setTimer: () => 0,
    clearTimer: () => {},
  };
  const layer = (clipId, extra = {}) => ({ clipId, kind: "html", key: `K-${clipId}`, resultKey: `R-${clipId}`, firstFrame: 0, count: 600, contentKey: `ck-${clipId}`, envFingerprint: FP, ...extra });
  const layerMap = (layers, v = 2) => content.set(`${LAYER_MAP_PREFIX}p1`, { v, kind: "layer-map", projectId: "p1", fps, span: 60, at: 1, layers });
  const manifest = (resultKey, from, to) => {
    const frames = [], small = [];
    for (let f = from; f <= to; f++) {
      const hs = H(1000 + f + resultKey.length * 7919), hp = H(900000 + f + resultKey.length * 7919);
      frames.push([f, hs, 30]);
      small.push([f, hp, 8]);
      blobs.set(`snap/${hs}`, new TextEncoder().encode(`<div data-f="${f}">${resultKey}</div>`));
      blobs.set(`px/${hp}`, new Uint8Array([82, 73, 70, 70, f & 255]));
    }
    content.set(`${resultKey}:${from}-${to}`, { v: 1, kind: "snapshot", resultKey, range: { from, to }, frames, small });
  };
  return { deps, content, fetches, layer, layerMap, manifest };
}

async function settle(src) {
  for (let i = 0; i < 6; i++) { await src.tickNow(); await src.idle(); await new Promise((r) => setTimeout(r, 5)); }
}

test("C10-L3-1 层表:`original` 只认 v 2 且两项齐的层;最低一档 v 1、v 2 都认;不认得的 v 整张当没有", () => {
  const v2 = parseLayerMap({ v: 2, kind: "layer-map", projectId: "p", fps: 30, span: 60, layers: [
    { clipId: "a", kind: "html", key: "K", resultKey: "R", firstFrame: 0, count: 10, contentKey: "ck", envFingerprint: FP },
    { clipId: "b", kind: "html", key: "K2", resultKey: "R2", firstFrame: 0, count: 10, contentKey: null, envFingerprint: FP },
    { clipId: "c", kind: "html", key: "K3", resultKey: "R3", firstFrame: 0, count: 10, contentKey: "ck3" },
  ] });
  assert.equal(v2.v, 2);
  assert.deepEqual(v2.layers.filter((l) => usableLayer(v2, l)).map((l) => l.clipId), ["a"]);
  assert.deepEqual(v2.layers.filter((l) => usableLayer(v2, l, { anyVersion: true })).map((l) => l.clipId), ["a", "b", "c"]);
  const v1 = parseLayerMap({ kind: "layer-map", projectId: "p", fps: 30, span: 60, layers: [{ clipId: "a", kind: "html", key: "K", resultKey: "R", firstFrame: 0, count: 10 }] });
  assert.equal(v1.v, 1);
  assert.equal(usableLayer(v1, v1.layers[0]), false, "`original` 不认 v 1");
  assert.equal(usableLayer(v1, v1.layers[0], { anyVersion: true }), true);
  assert.equal(parseLayerMap({ v: 9, kind: "layer-map", layers: [] }), null, "不认得的 v 整张当没有");
  // layerRefOf:对得上回带 contentKey / envFingerprint 的那一层;对不上回 null,不抛
  const body = { v: 2, kind: "layer-map", layers: [{ clipId: "a", kind: "html", key: "K", resultKey: "R", firstFrame: 0, count: 10, contentKey: "ck", envFingerprint: FP }] };
  assert.equal(layerRefOf(body, "a").contentKey, "ck");
  assert.equal(layerRefOf(body, "a").envFingerprint, FP);
  assert.equal(layerRefOf(body, "zz"), null);
  assert.equal(layerRefOf({ ...body, v: 1 }, "a"), null);
  assert.equal(layerRefOf(null, "a"), null);
  assert.equal(layerRefOf("garbage", "a"), null);
  assert.equal(layerRefOf(v2, "b"), null, "缺内容键");
});

test("C10-L3-2 原尺寸:撤快照后不自动预取;按需拉取 snap/<hash> 进 L2;小尺寸请求 0;一层只出自层表那一种环境", async () => {
  const w = world();
  w.layerMap([w.layer("a")]);
  w.manifest("R-a", 0, 59);
  w.manifest("R-a", 60, 119);
  const idb = createFakeIndexedDB();
  const l2 = await openL2({ indexedDB: idb });
  const src = new OnlineSnapshotSource(w.deps, { tier: "original", store: l2 });
  const index = new Map();
  const msgs = [];
  src.subscribeReady("x", 0, (m) => { msgs.push(m); applyReadyMessage(index, m); });
  src.setProject("p1");
  src.focus(1, 30);
  await settle(src);
  assert.equal(w.fetches.filter((f) => f.ns === "px").length, 0, "`original` 不拉小尺寸");
  assert.equal(w.fetches.filter((f) => f.ns === "snap").length, 0, "撤快照后不自动预取原尺寸快照块");
  // 按需拉取:凭只读票据拉取并写进 L2
  const html = await src.fetchSnapshot("html", "K-a", 5);
  assert.match(html, /data-f="5"/);
  const snaps = w.fetches.filter((f) => f.ns === "snap");
  assert.equal(snaps.length, 1, "按需拉取了一块");
  assert.equal(snaps[0].auth, "Bearer RT", "凭只读票据");
  await new Promise((r) => setTimeout(r, 20));
  const stored = idb.dump(L2_DB_NAME, "snapshots");
  assert.ok(stored.some((r) => r.key.startsWith("snap/")), "按需拉取的块进 L2 的 snapshots");
  assert.equal(src.debug().layers[0].envFingerprint, FP);
  src.stop();
  l2.close();
});

test("C10-L3-3 关掉再开:已在 L2 的块不再请求,就绪照样出来", async () => {
  const w = world();
  w.layerMap([w.layer("a")]);
  w.manifest("R-a", 0, 59);
  w.manifest("R-a", 60, 119);
  const idb = createFakeIndexedDB();
  const l2a = await openL2({ indexedDB: idb });
  const first = new OnlineSnapshotSource(w.deps, { tier: "original", store: l2a });
  first.subscribeReady("x", 0, () => {});
  first.setProject("p1");
  first.focus(1, 30);
  await settle(first);
  // 按需取一块进 L2(fetchSnapshot 自身会把该帧区间写进 L2)
  await first.fetchSnapshot("html", "K-a", 3);
  await new Promise((r) => setTimeout(r, 20));
  first.stop();
  l2a.close();
  const before = w.fetches.length;
  const l2b = await openL2({ indexedDB: idb });
  const again = new OnlineSnapshotSource(w.deps, { tier: "original", store: l2b });
  const index = new Map();
  again.subscribeReady("x", 0, (m) => applyReadyMessage(index, m));
  again.setProject("p1");
  again.focus(1, 30);
  await settle(again);
  assert.equal(w.fetches.length - before, 0, "重开之后一个块都没再请求");
  const ranges = layerOf(index, "a", "html")?.ranges;
  assert.ok(ranges && ranges.some(([lo, hi]) => lo <= 3 && hi >= 3), "就绪从 L2 的 ranges 读回来(含第 3 帧)");
  assert.match(await again.fetchSnapshot("html", "K-a", 3), /data-f="3"/);
  assert.equal(again.stats.snapFetches, 0);
  assert.ok(again.stats.l2Hits >= 1);
  again.stop();
});

test("C10-L3-4 撤快照后不自动预取原尺寸;v 1 层表的层 `original` 不认(一个请求都不发)", async () => {
  const w = world();
  w.layerMap([w.layer("a")]);
  for (let s = 0; s < 600; s += 60) w.manifest("R-a", s, s + 59);
  const src = new OnlineSnapshotSource(w.deps, { tier: "original", store: await openL2({ indexedDB: createFakeIndexedDB() }) });
  src.subscribeReady("x", 0, () => {});
  src.setProject("p1");
  src.focus(10, 30);                 // 全局帧 300,窗口 240..360
  await settle(src);
  assert.equal(w.fetches.filter((f) => f.ns === "snap").length, 0, "撤快照后不自动预取原尺寸快照块");
  src.stop();

  const w1 = world();
  w1.layerMap([{ clipId: "a", kind: "html", key: "K-a", resultKey: "R-a", firstFrame: 0, count: 120 }], 1);
  w1.manifest("R-a", 0, 59);
  const src1 = new OnlineSnapshotSource(w1.deps, { tier: "original", store: await openL2({ indexedDB: createFakeIndexedDB() }) });
  const idx = new Map();
  src1.subscribeReady("x", 0, (m) => applyReadyMessage(idx, m));
  src1.setProject("p1");
  src1.focus(0, 30);
  await settle(src1);
  assert.equal(w1.fetches.length, 0, "层表对不上:不拉");
  assert.equal(layerOf(idx, "a", "html"), null, "没有这一层的就绪(按没有预渲染结果处理)");
  assert.deepEqual(src1.debug().skipped, ["a"]);
  src1.stop();
});

test("C10-L3-5 最低一档:撤快照后不自动预取小尺寸;按需存进 L2(只存 px/),重开后不再请求", async () => {
  const w = world();
  w.layerMap([{ clipId: "a", kind: "html", key: "K-a", resultKey: "R-a", firstFrame: 0, count: 120 }], 1);
  w.manifest("R-a", 0, 59);
  const idb = createFakeIndexedDB();
  const l2 = await openL2({ indexedDB: idb });
  const src = new OnlineSnapshotSource(w.deps, { tier: "small", store: l2 });
  src.subscribeReady("x", 0, () => {});
  src.setProject("p1");
  src.focus(0, 30);
  await settle(src);
  assert.equal(w.fetches.filter((f) => f.ns === "px").length, 0, "撤快照后不自动预取小尺寸块");
  // 按需取一块进 L2
  const html = await src.fetchSnapshot("html", "K-a", 2);
  assert.match(html, /^<img /);
  assert.equal(w.fetches.filter((f) => f.ns === "px").length, 1, "按需拉取小尺寸图片");
  await new Promise((r) => setTimeout(r, 30));
  const stored = idb.dump(L2_DB_NAME, "snapshots");
  assert.ok(stored.length > 0 && stored.every((r) => r.key.startsWith("px/")), "L2 只存小尺寸");
  src.stop();
  l2.close();
  const before = w.fetches.length;
  const again = new OnlineSnapshotSource(w.deps, { tier: "small", store: await openL2({ indexedDB: idb }) });
  again.subscribeReady("x", 0, () => {});
  again.setProject("p1");
  again.focus(0, 30);
  await settle(again);
  assert.equal(w.fetches.length - before, 0, "重开之后不再请求");
  assert.match(await again.fetchSnapshot("html", "K-a", 2), /^<img /);
  assert.equal(w.fetches.length - before, 0, "命中缓存不再请求");
  again.stop();
});

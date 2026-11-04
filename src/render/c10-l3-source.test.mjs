/**
 * L3: Online pages fetch prerender original size into L2 based on layer table and manifest
 * (C10 contract Section 5, Section 18 Item 3), and L2 for the lowest tier (`small`) only stores
 * small size (Section 4).
 *
 *   L3-1 Layer table: `original` only recognizes v 2 layers with contentKey and envFingerprint;
 *        lowest tier recognizes both v 1 and v 2; unrecognized v treats the whole thing as missing
 *   L3-2 Original size: fetch snap/<hash> using read-only tickets according to manifest frames table,
 *        write into L2 snapshots, ready upon writing ranges; 0 small-size requests
 *   L3-3 Close and reopen (same L2): chunks already in the store are not requested again,
 *        ready states still appear
 *   L3-4 Prefetch only pulls 2 seconds before and after the playhead; layers mismatched with layer
 *        table (v 1) are treated as "no prerender output", not a single request is sent
 *   L3-5 Lowest tier: small size is stored into L2 (px/<hash>), no requests after reopening;
 *        no snap/ in store
 * Run: node --test src/render/c10-l3-source.test.mjs
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
      if (msg.type !== "content.get") throw new Error("only content.get is recognized");
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

test("C10-L3-1 layer map: `original` only accepts layers with v 2 and both fields present; the lowest tier accepts both v 1 and v 2; an unrecognized v makes the whole map count as absent", () => {
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
  assert.equal(usableLayer(v1, v1.layers[0]), false, "`original` does not accept v 1");
  assert.equal(usableLayer(v1, v1.layers[0], { anyVersion: true }), true);
  assert.equal(parseLayerMap({ v: 9, kind: "layer-map", layers: [] }), null, "an unrecognized v makes the whole map count as absent");
  // layerRefOf: returns the layer with contentKey / envFingerprint on match;
  // returns null on mismatch, without throwing
  const body = { v: 2, kind: "layer-map", layers: [{ clipId: "a", kind: "html", key: "K", resultKey: "R", firstFrame: 0, count: 10, contentKey: "ck", envFingerprint: FP }] };
  assert.equal(layerRefOf(body, "a").contentKey, "ck");
  assert.equal(layerRefOf(body, "a").envFingerprint, FP);
  assert.equal(layerRefOf(body, "zz"), null);
  assert.equal(layerRefOf({ ...body, v: 1 }, "a"), null);
  assert.equal(layerRefOf(null, "a"), null);
  assert.equal(layerRefOf("garbage", "a"), null);
  assert.equal(layerRefOf(v2, "b"), null, "missing content key");
});

test("C10-L3-2 original size: no automatic prefetch after snapshots are withdrawn; fetch snap/<hash> into L2 on demand; small-size requests are 0; a layer comes only from the single environment in the layer map", async () => {
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
  assert.equal(w.fetches.filter((f) => f.ns === "px").length, 0, "`original` does not fetch small sizes");
  assert.equal(w.fetches.filter((f) => f.ns === "snap").length, 0, "original-size snapshot chunks are not prefetched automatically after snapshots are withdrawn");
  // On-demand fetch: fetch using read-only ticket and write into L2
  const html = await src.fetchSnapshot("html", "K-a", 5);
  assert.match(html, /data-f="5"/);
  const snaps = w.fetches.filter((f) => f.ns === "snap");
  assert.equal(snaps.length, 1, "one chunk was fetched on demand");
  assert.equal(snaps[0].auth, "Bearer RT", "with the read-only ticket");
  await new Promise((r) => setTimeout(r, 20));
  const stored = idb.dump(L2_DB_NAME, "snapshots");
  assert.ok(stored.some((r) => r.key.startsWith("snap/")), "chunks fetched on demand go into the L2 snapshots");
  assert.equal(src.debug().layers[0].envFingerprint, FP);
  src.stop();
  l2.close();
});

test("C10-L3-3 turn off and on again: chunks already in L2 are not requested again, and readiness still comes out", async () => {
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
  // Fetch one chunk into L2 on demand (fetchSnapshot itself writes this frame range into L2)
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
  assert.equal(w.fetches.length - before, 0, "no chunk was requested again after reopening");
  const ranges = layerOf(index, "a", "html")?.ranges;
  assert.ok(ranges && ranges.some(([lo, hi]) => lo <= 3 && hi >= 3), "readiness is read back from the L2 ranges (including frame 3)");
  assert.match(await again.fetchSnapshot("html", "K-a", 3), /data-f="3"/);
  assert.equal(again.stats.snapFetches, 0);
  assert.ok(again.stats.l2Hits >= 1);
  again.stop();
});

test("C10-L3-4 after snapshot removal, original size is not prefetched automatically; the `original` layer of a v 1 layer table is not recognized (no request is sent at all)", async () => {
  const w = world();
  w.layerMap([w.layer("a")]);
  for (let s = 0; s < 600; s += 60) w.manifest("R-a", s, s + 59);
  const src = new OnlineSnapshotSource(w.deps, { tier: "original", store: await openL2({ indexedDB: createFakeIndexedDB() }) });
  src.subscribeReady("x", 0, () => {});
  src.setProject("p1");
  src.focus(10, 30);                 // Global frame 300, window 240..360
  await settle(src);
  assert.equal(w.fetches.filter((f) => f.ns === "snap").length, 0, "original-size snapshot chunks are not prefetched automatically after snapshots are withdrawn");
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
  assert.equal(w1.fetches.length, 0, "layer table mismatch: no fetch");
  assert.equal(layerOf(idx, "a", "html"), null, "this layer has no ready state (treated as no prerender output)");
  assert.deepEqual(src1.debug().skipped, ["a"]);
  src1.stop();
});

test("C10-L3-5 lowest tier: after snapshot removal, small size is not prefetched automatically; stored into L2 on demand (only px/), no more requests after reopening", async () => {
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
  assert.equal(w.fetches.filter((f) => f.ns === "px").length, 0, "after snapshot removal, small-size chunks are not prefetched automatically");
  // Fetch one chunk into L2 on demand
  const html = await src.fetchSnapshot("html", "K-a", 2);
  assert.match(html, /^<img /);
  assert.equal(w.fetches.filter((f) => f.ns === "px").length, 1, "small-size image fetched on demand");
  await new Promise((r) => setTimeout(r, 30));
  const stored = idb.dump(L2_DB_NAME, "snapshots");
  assert.ok(stored.length > 0 && stored.every((r) => r.key.startsWith("px/")), "L2 stores only small size");
  src.stop();
  l2.close();
  const before = w.fetches.length;
  const again = new OnlineSnapshotSource(w.deps, { tier: "small", store: await openL2({ indexedDB: idb }) });
  again.subscribeReady("x", 0, () => {});
  again.setProject("p1");
  again.focus(0, 30);
  await settle(again);
  assert.equal(w.fetches.length - before, 0, "no more requests after reopening");
  assert.match(await again.fetchSnapshot("html", "K-a", 2), /^<img /);
  assert.equal(w.fetches.length - before, 0, "cache hit, no more requests");
  again.stop();
});

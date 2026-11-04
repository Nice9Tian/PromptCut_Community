/**
 * Online source identifies layers with stale parameters (stale-layer;
 * `OnlineSnapshotSource.setInputs` in `snapshotSource.ts`, `inputSig` in layer table):
 *   SL-1 Change parameters: old layer is revoked immediately (ready emits empty, cannot fetch
 *        bytes); while results are in transit, do not confirm missing (hourglass), no badge on
 *        timeline; confirm (icon, badge) only after STALE_AWAIT_MS has fully elapsed without a new
 *        layer, and notify overlay subscribers; swap in as usual when new layer table arrives
 *   SL-2 Change back to original parameters: original layer is still there, paste as usual
 *   SL-3 Old layer table (without `inputSig`) pastes as before, not revoked even when parameters
 *        change (backward compatibility); do not compare if page provides no project
 *   SL-4 Fetching original size (layer table v 3 candidate) also revokes; `layerClipIds` does not
 *        contain expired layers; `layerRefOf` compares with signature
 *   SL-5 Export (`originals.ts`): when project is provided, layers with stale inputs count as
 *        missing
 * Run: node --test src/render/staleLayer.test.mjs
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

test("SL-1 parameter change: the old layer is removed immediately, shows an hourglass (unconfirmed) while the result is in transit, and is confirmed only after the grace period; the new layer table replaces it on arrival", async () => {
  const p0 = project();
  const { w, src, index, advance, coverageCalls } = await setup({ p: p0, layers: (p) => [layer("a", "KA1", clipInputSig(p, "a")), layer("b", "KB1", clipInputSig(p, "b"))] });
  assert.deepEqual(layerOf(index, "a", "html").ranges, [[0, 59]], "Still applied before the change");
  assert.equal(src.frameConfirmedMissing("a", 10), false);
  assert.equal(src.coverage("a"), "full");
  await assert.doesNotReject(src.fetchSnapshot("html", "KA1", 3));

  const p1 = project({ title: "world" });
  const before = coverageCalls();
  src.setInputs(p1);
  // Revoke synchronously: do not wait for the next polling round
  assert.deepEqual(layerOf(index, "a", "html"), { clipId: "a", kind: "html", key: "KA1", ranges: [] }, "Old layer removed (ready sends empty)");
  assert.deepEqual(layerOf(index, "b", "html").ranges, [[0, 59]], "Unchanged clips are still applied");
  await assert.rejects(src.fetchSnapshot("html", "KA1", 3), /No small-size prerender for this frame/, "Bytes of the old layer are no longer served");
  assert.equal(src.frameConfirmedMissing("a", 10), false, "New result in transit: unconfirmed (hourglass)");
  assert.equal(src.coverage("a"), "unknown", "The timeline shows no badge");
  assert.ok(coverageCalls() > before, "Coverage subscriber is called (parent page recomputes the icon)");
  assert.equal(src.layerClipIds().has("a"), false, "An expired layer does not count as having output");
  assert.equal(src.debug().stale[0].clipId, "a");

  // Wait out the full wait period: confirm missing
  advance(STALE_AWAIT_MS + 1);
  const mid = coverageCalls();
  await src.tickNow();
  assert.equal(src.frameConfirmedMissing("a", 10), true, "Waited the full period with no new layer: confirmed (icon)");
  assert.equal(src.coverage("a"), "none");
  assert.ok(coverageCalls() > mid, "Coverage subscriber is called on expiry");

  // Render node rewrites layer table according to new inputs, finishes rendering: swap in as usual
  w.layerMap([layer("a", "KA2", clipInputSig(p1, "a")), layer("b", "KB1", clipInputSig(p1, "b"))]);
  w.manifest("KA2", 60, 7);
  advance(10_000);
  await src.tickNow();
  assert.deepEqual(layerOf(index, "a", "html"), { clipId: "a", kind: "html", key: "KA2", ranges: [[0, 59]] }, "New result swapped in");
  assert.equal(src.frameConfirmedMissing("a", 10), false);
  assert.equal(src.coverage("a"), "full");
  assert.deepEqual(src.debug().stale, []);
});

test("SL-2 parameters changed back to the original: if the original layer is still there, it is applied", async () => {
  const p0 = project();
  const { src, index } = await setup({ p: p0, layers: (p) => [layer("a", "KA1", clipInputSig(p, "a"))] });
  src.setInputs(project({ title: "world" }));
  assert.deepEqual(layerOf(index, "a", "html").ranges, []);
  src.setInputs(project({ title: "hello" })); // New object, same inputs
  assert.deepEqual(layerOf(index, "a", "html"), { clipId: "a", kind: "html", key: "KA1", ranges: [[0, 59]] });
  assert.deepEqual(src.debug().stale, []);
});

test("SL-3 old layer table has no signature and the page gave no project: applied as before (backward compatible)", async () => {
  const { src, index } = await setup({ layers: () => [layer("a", "KA1", null)] });
  src.setInputs(project({ title: "world" }));
  assert.deepEqual(layerOf(index, "a", "html").ranges, [[0, 59]], "Layer table has no inputSig: no comparison");
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
  assert.deepEqual(layerOf(index2, "a", "html").ranges, [[0, 59]], "No project given: no comparison");
});

test("SL-4 fetching the original size (v 3 candidate) is likewise withdrawn; layerRefOf compares signatures", async () => {
  const p0 = project();
  const sigB = clipInputSig(p0, "b");
  const { src, index } = await setup({ tier: "original", p: p0, layers: (p) => [layer("b", "KB1", clipInputSig(p, "b"), {
    candidates: [{ envFingerprint: "f".repeat(16), resultKey: "KB1", key: "KB1" }] })] });
  assert.deepEqual(layerOf(index, "b", "html").ranges, [[0, 59]], "built-in heavy card: original size pasted as is");
  const p1 = { ...p0, tracks: p0.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((c) => (c.id === "b" ? { ...c, params: { k: 2 } } : c)) })) };
  src.setInputs(p1);
  assert.deepEqual(layerOf(index, "b", "html").ranges, [], "built-in heavy card had parameters changed: old layer withdrawn (playback placeholder, live render paused)");
  await assert.rejects(src.fetchSnapshot("html", "KB1", 0), /No full-size prerender for this frame/);

  const table = { v: 3, kind: "layer-map", projectId: "p1", fps: 30, span: 60, layers: [layer("b", "KB1", sigB)] };
  assert.equal(layerRefOf(table, "b", { inputSig: sigB })?.key, "KB1");
  assert.equal(layerRefOf(table, "b", { inputSig: clipInputSig(p1, "b") }), null, "layer with old parameters");
  assert.equal(layerRefOf(table, "b")?.key, "KB1", "no signature given: unchanged");
});

test("SL-5 export: when a project is given, layers with old input count as missing, matching ones are fetched as usual", async () => {
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
  assert.deepEqual(edited.missing, ["a"], "card with changed parameters: old layer not exported, counted as missing");
  assert.equal(edited.hashAt("a", 0), null);
  assert.equal(edited.hashAt("b", 0), H(1));
  const legacy = await O.loadOriginalsIndex("p1", deps);
  assert.deepEqual(legacy.missing, [], "no project given: unchanged");
});

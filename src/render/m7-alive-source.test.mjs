/**
 * M7 D12 page side: online source uses `task.done` (alive) and
 * `task.failed { error: 'superseded' }` (the invalidated one: the other one is alive) pushed by
 * the queue to determine which candidate in layer table v 3 is alive, replacing the entire layer
 * with that candidate (result key, fingerprint, and online key all come from the same candidate);
 * previously defaulted to the first candidate.
 * Run: node --test src/render/m7-alive-source.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OnlineSnapshotSource, LAYER_MAP_PREFIX, applyReadyMessage, layerOf } from "./snapshotSource.ts";

const H = (n) => n.toString(16).padStart(64, "0");

function world() {
  const content = new Map();
  const fetches = [];
  const deps = {
    async request(msg) {
      if (msg.type !== "content.get") throw new Error("only content.get is recognized");
      if (!content.has(msg.key)) return { type: "content.item", kind: msg.kind, key: msg.key, missing: true };
      return { type: "content.item", kind: msg.kind, key: msg.key, body: structuredClone(content.get(msg.key)) };
    },
    assetBase: () => "https://h.example/api/asset",
    authHeaders: async () => ({}),
    async fetch(url) {
      const [ns, hash] = url.split("/").slice(-2);
      fetches.push(`${ns}/${hash}`);
      const body = new TextEncoder().encode(`<i>${hash.slice(-4)}</i>`);
      return { ok: true, status: 200, headers: { get: () => "text/html" }, arrayBuffer: async () => body.buffer };
    },
    setTimer: () => 0,
    clearTimer: () => {},
  };
  const cand = (fp, rk) => ({ envFingerprint: fp, resultKey: rk, key: rk, dirKey: rk });
  content.set(`${LAYER_MAP_PREFIX}p1`, { v: 3, kind: "layer-map", projectId: "p1", fps: 30, span: 60, at: 1, layers: [
    { clipId: "a", kind: "html", tier: "shared", firstFrame: 0, count: 60, contentKey: "ck-a", key: "R-host", resultKey: "R-host", dirKey: "R-host", envFingerprint: "fp-host",
      candidates: [cand("fp-host", "R-host"), cand("fp-page", "R-page")] },
  ] });
  for (const rk of ["R-host", "R-page"]) {
    content.set(`${rk}:0-59`, { v: 1, kind: "snapshot", resultKey: rk, range: { from: 0, to: 59 },
      frames: Array.from({ length: 60 }, (_, f) => [f, H((rk === "R-host" ? 1000 : 5000) + f), 10]) });
  }
  return { deps, fetches };
}

async function settle(src) {
  for (let i = 0; i < 6; i++) { await src.tickNow(); await src.idle(); await new Promise((r) => setTimeout(r, 5)); }
}

test("M7-AS-01 With none designated, use the first candidate; after the browser's copy is task.done the whole layer switches to it; when the splitter's copy is superseded it also switches over", async () => {
  const w = world();
  const src = new OnlineSnapshotSource(w.deps, { tier: "original" });
  const index = new Map();
  src.subscribeReady("x", 0, (m) => applyReadyMessage(index, m));
  src.setProject("p1");
  src.focus(0, 30);
  await settle(src);
  assert.equal(layerOf(index, "a", "html")?.key, "R-host", "Default is the first candidate (the splitter's own)");
  src.noteQueueEvent({ type: "task.done", id: "snapshot:R-page:0-59", resultKey: "R-page" });
  await settle(src);
  assert.equal(layerOf(index, "a", "html")?.key, "R-page", "Browser's copy is alive: whole layer switches key");
  assert.equal(w.fetches.length, 0, "After a snapshot is revoked, per-card snapshot chunks are not prefetched automatically");
  await src.fetchSnapshot("html", "R-page", 0);
  assert.ok(w.fetches.some((f) => f === `snap/${H(5000)}`), "Fetch chunks according to the manifest of the live copy");
  assert.equal(src.debug().layers[0].envFingerprint, "fp-page");
  src.stop();

  const w2 = world();
  const s2 = new OnlineSnapshotSource(w2.deps, { tier: "original" });
  const idx2 = new Map();
  s2.subscribeReady("x", 0, (m) => applyReadyMessage(idx2, m));
  s2.setProject("p1");
  s2.focus(0, 30);
  await settle(s2);
  // task.failed with only an id (queue invalidation does not include resultKey): extract result key
  // from id
  s2.noteQueueEvent({ type: "task.failed", id: "snapshot:R-host:0-59", error: "superseded" });
  await settle(s2);
  assert.equal(layerOf(idx2, "a", "html")?.key, "R-page", "Splitter's copy invalidated = the other copy is alive");
  // Other failures do not count as invalidation
  s2.noteQueueEvent({ type: "task.failed", id: "snapshot:R-page:0-59", error: "sink-incomplete" });
  await settle(s2);
  assert.equal(layerOf(idx2, "a", "html")?.key, "R-page");
  s2.stop();
});

/**
 * M7 D12 页面侧:在线来源按队列推来的 `task.done`(活)与 `task.failed { error: 'superseded' }`(作废的那一份 —— 另一份活着)
 * 认定层表 v 3 的哪个候选活着,整层换成那个候选(结果键、指纹、线上键同出一个候选);之前默认第一个候选。
 * 跑:node --test src/render/m7-alive-source.test.mjs
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
      if (msg.type !== "content.get") throw new Error("只认 content.get");
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

test("M7-AS-01 没认定时用第一个候选;浏览器那份 task.done 之后整层换成它;切分方那份 superseded 也换过去", async () => {
  const w = world();
  const src = new OnlineSnapshotSource(w.deps, { tier: "original" });
  const index = new Map();
  src.subscribeReady("x", 0, (m) => applyReadyMessage(index, m));
  src.setProject("p1");
  src.focus(0, 30);
  await settle(src);
  assert.equal(layerOf(index, "a", "html")?.key, "R-host", "默认第一个候选(切分方自己的)");
  src.noteQueueEvent({ type: "task.done", id: "snapshot:R-page:0-59", resultKey: "R-page" });
  await settle(src);
  assert.equal(layerOf(index, "a", "html")?.key, "R-page", "浏览器那份活着:整层换键");
  assert.equal(w.fetches.length, 0, "撤快照后不自动预取每张卡快照块");
  await src.fetchSnapshot("html", "R-page", 0);
  assert.ok(w.fetches.some((f) => f === `snap/${H(5000)}`), "按活着那一份的清单取块");
  assert.equal(src.debug().layers[0].envFingerprint, "fp-page");
  src.stop();

  const w2 = world();
  const s2 = new OnlineSnapshotSource(w2.deps, { tier: "original" });
  const idx2 = new Map();
  s2.subscribeReady("x", 0, (m) => applyReadyMessage(idx2, m));
  s2.setProject("p1");
  s2.focus(0, 30);
  await settle(s2);
  // 只有 id 的 task.failed(队列作废时不带 resultKey):从 id 里取结果键
  s2.noteQueueEvent({ type: "task.failed", id: "snapshot:R-host:0-59", error: "superseded" });
  await settle(s2);
  assert.equal(layerOf(idx2, "a", "html")?.key, "R-page", "切分方那份作废 = 另一份活着");
  // 别的失败不算作废
  s2.noteQueueEvent({ type: "task.failed", id: "snapshot:R-page:0-59", error: "sink-incomplete" });
  await settle(s2);
  assert.equal(layerOf(idx2, "a", "html")?.key, "R-page");
  s2.stop();
});

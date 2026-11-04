/**
 * Dual stages on the online page (C10 contract Section 2): runtime config parsing, how many
 * stages to open, asset base URL for cross-origin stages, fallback for fetching runtime config.
 * Run: node --test src/online/stageOrigins.test.mjs
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseStageOrigins, stageLayout, stageAssetBase, loadStageConfig, onlineStageState, markStageHandshake, subscribeOnlineStages,
  resetOnlineStagesForTest, RUNTIME_CONFIG_FILE,
} from "./stageOrigins.ts";

beforeEach(() => resetOnlineStagesForTest());

test("C10-SO-01 Runtime config: only two distinct valid origins are accepted (array or {A,B}, object or JSON text); invalid input returns null without throwing", () => {
  const want = { A: "https://s1.x.io", B: "https://s2.x.io" };
  assert.deepEqual(parseStageOrigins({ stageOrigins: ["https://s1.x.io", "https://s2.x.io"] }), want);
  assert.deepEqual(parseStageOrigins(JSON.stringify({ v: 1, stageOrigins: ["https://s1.x.io/", "https://s2.x.io"] })), want);
  assert.deepEqual(parseStageOrigins({ stageOrigins: { A: "http://127.0.0.1:5421", B: "http://127.0.0.1:5422" } }), { A: "http://127.0.0.1:5421", B: "http://127.0.0.1:5422" });
  for (const bad of [null, undefined, "", "{", 42, {}, { stageOrigins: [] }, { stageOrigins: ["https://a.io"] }, { stageOrigins: ["https://a.io", "https://a.io"] },
    { stageOrigins: ["https://a.io/editor", "https://b.io"] }, { stageOrigins: ["ftp://a.io", "https://b.io"] }, { stageOrigins: ["a", "b"] }, { stageOrigins: ["https://a.io?x=1", "https://b.io"] }]) {
    assert.equal(parseStageOrigins(bad), null, JSON.stringify(bad));
  }
});

test("C10-SO-02 How many stages to open: stage gate stuck at the first level, no stage origin, handshake failed, or stage origin same as the editor page → single stage; otherwise dual stage", () => {
  const origins = { A: "https://s1.x.io", B: "https://s2.x.io" };
  assert.equal(stageLayout({ single: false, origins, handshake: "pending" }), "dual");
  assert.equal(stageLayout({ single: false, origins, handshake: "ok" }), "dual");
  assert.equal(stageLayout({ single: false, origins, handshake: "failed" }), "single");
  assert.equal(stageLayout({ single: false, origins, handshake: "interim" }), "single");
  assert.equal(stageLayout({ single: true, origins, handshake: "ok" }), "single");
  assert.equal(stageLayout({ single: false, origins: null, handshake: "ok" }), "single");
  assert.equal(stageLayout({ single: false, origins, handshake: "ok", pageOrigin: "https://s1.x.io" }), "single");
  assert.equal(stageLayout({ single: false, origins, handshake: "ok", pageOrigin: "https://x.io" }), "dual");
});

test("C10-SO-03 A cross-origin stage reads /media reverse-proxied on its own origin: an asset base on the same origin as the editor page is replaced with a path, other hosts are kept as is", () => {
  assert.equal(stageAssetBase("https://x.io/media/api/asset", "https://x.io"), "/media/api/asset");
  assert.equal(stageAssetBase("https://x.io/media/api/asset/", "https://x.io"), "/media/api/asset");
  assert.equal(stageAssetBase("https://cdn.y.io/media/api/asset", "https://x.io"), "https://cdn.y.io/media/api/asset");
  assert.equal(stageAssetBase("not a url", "https://x.io"), "not a url");
});

test("C10-SO-04 Fetch runtime config: fetch runtime-config.json by base (bypassing the cache); unreachable, timed out or invalid all count as no stage origin", async () => {
  const seen = [];
  let calls = 0;
  subscribeOnlineStages(() => calls++);
  const ok = await loadStageConfig({ base: "/editor/", fetchImpl: async (url, init) => { seen.push([url, init?.cache]); return { ok: true, text: async () => '{"v":1,"stageOrigins":["https://s1.x.io","https://s2.x.io"]}' }; } });
  assert.deepEqual(ok, { A: "https://s1.x.io", B: "https://s2.x.io" });
  assert.deepEqual(seen, [[`/editor/${RUNTIME_CONFIG_FILE}`, "no-store"]]);
  assert.equal(onlineStageState().config, "done");
  assert.ok(calls >= 2, "Subscribers are notified when the state changes");
  resetOnlineStagesForTest();
  assert.equal(await loadStageConfig({ fetchImpl: async () => ({ ok: false, text: async () => "" }) }), null);
  resetOnlineStagesForTest();
  assert.equal(await loadStageConfig({ fetchImpl: async () => { throw new Error("offline"); } }), null);
  resetOnlineStagesForTest();
  assert.equal(await loadStageConfig({ timeoutMs: 20, fetchImpl: (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("abort")))) }), null);
  assert.equal(onlineStageState().origins, null);
});

test("C10-SO-05 After a handshake failure, this page session never returns to dual stage", () => {
  markStageHandshake("failed", "B did not handshake");
  assert.equal(onlineStageState().handshake, "failed");
  markStageHandshake("ok");
  assert.equal(onlineStageState().handshake, "failed");
  assert.equal(onlineStageState().reason, "B did not handshake");
});

test("C10-SO-06 Master switch \"Run user cards and media effect cards online\" (the host can turn it off): only an explicit onlineCardExec: false means off; missing, any other value or an invalid config all use the default (on)", async () => {
  const { parseCardExecSwitch } = await import("./stageOrigins.ts");
  assert.equal(parseCardExecSwitch({ v: 1, stageOrigins: ["https://s1.x.io", "https://s2.x.io"], onlineCardExec: false }), false);
  assert.equal(parseCardExecSwitch('{"v":1,"onlineCardExec":false}'), false);
  for (const on of [{}, { onlineCardExec: true }, { onlineCardExec: "false" }, { onlineCardExec: 0 }, { onlineCardExec: null }, null, undefined, "", "{", 42, [], '{"v":1}']) {
    assert.equal(parseCardExecSwitch(on), true, JSON.stringify(on));
  }
});

test("C10-SO-07 The master switch is read together with the runtime config: when off it is recorded in this page's state (the stage origin is still recognized); missing or unreachable both mean on", async () => {
  assert.equal(onlineStageState().cardExec, true);
  const origins = await loadStageConfig({ fetchImpl: async () => ({ ok: true, text: async () => '{"v":1,"stageOrigins":["https://s1.x.io","https://s2.x.io"],"onlineCardExec":false}' }) });
  assert.deepEqual(origins, { A: "https://s1.x.io", B: "https://s2.x.io" });
  assert.equal(onlineStageState().cardExec, false);
  resetOnlineStagesForTest();
  await loadStageConfig({ fetchImpl: async () => ({ ok: true, text: async () => '{"v":1,"stageOrigins":["https://s1.x.io","https://s2.x.io"]}' }) });
  assert.equal(onlineStageState().cardExec, true);
  resetOnlineStagesForTest();
  await loadStageConfig({ fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(onlineStageState().cardExec, true);
  assert.equal(onlineStageState().origins, null, "When the config cannot be fetched there is no stage origin, so no stage is mounted and nothing is executed");
});

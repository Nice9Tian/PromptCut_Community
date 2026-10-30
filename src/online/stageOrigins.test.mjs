/**
 * 在线页面的两个舞台(C10 契约第 2 节):运行配置解析、开几个舞台、跨源舞台的素材基址、取运行配置的退回。
 * 跑:node --test src/online/stageOrigins.test.mjs
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseStageOrigins, stageLayout, stageAssetBase, loadStageConfig, onlineStageState, markStageHandshake, subscribeOnlineStages,
  resetOnlineStagesForTest, RUNTIME_CONFIG_FILE,
} from "./stageOrigins.ts";

beforeEach(() => resetOnlineStagesForTest());

test("C10-SO-01 运行配置:两个不同的合法源才认(数组或 {A,B},对象或 JSON 文本);不对回 null 不抛", () => {
  const want = { A: "https://s1.x.io", B: "https://s2.x.io" };
  assert.deepEqual(parseStageOrigins({ stageOrigins: ["https://s1.x.io", "https://s2.x.io"] }), want);
  assert.deepEqual(parseStageOrigins(JSON.stringify({ v: 1, stageOrigins: ["https://s1.x.io/", "https://s2.x.io"] })), want);
  assert.deepEqual(parseStageOrigins({ stageOrigins: { A: "http://127.0.0.1:5421", B: "http://127.0.0.1:5422" } }), { A: "http://127.0.0.1:5421", B: "http://127.0.0.1:5422" });
  for (const bad of [null, undefined, "", "{", 42, {}, { stageOrigins: [] }, { stageOrigins: ["https://a.io"] }, { stageOrigins: ["https://a.io", "https://a.io"] },
    { stageOrigins: ["https://a.io/editor", "https://b.io"] }, { stageOrigins: ["ftp://a.io", "https://b.io"] }, { stageOrigins: ["a", "b"] }, { stageOrigins: ["https://a.io?x=1", "https://b.io"] }]) {
    assert.equal(parseStageOrigins(bad), null, JSON.stringify(bad));
  }
});

test("C10-SO-02 开几个舞台:舞台闸门停在第一级、没有舞台源、握手失败、舞台源与编辑器页同源 → 单舞台;其余双舞台", () => {
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

test("C10-SO-03 跨源舞台读自己源上反代的 /media:与编辑器页同源的素材基址换成路径,别的主机原样", () => {
  assert.equal(stageAssetBase("https://x.io/media/api/asset", "https://x.io"), "/media/api/asset");
  assert.equal(stageAssetBase("https://x.io/media/api/asset/", "https://x.io"), "/media/api/asset");
  assert.equal(stageAssetBase("https://cdn.y.io/media/api/asset", "https://x.io"), "https://cdn.y.io/media/api/asset");
  assert.equal(stageAssetBase("not a url", "https://x.io"), "not a url");
});

test("C10-SO-04 取运行配置:按 base 取 runtime-config.json(不走缓存);取不到、超时、不合法都当没有舞台源", async () => {
  const seen = [];
  let calls = 0;
  subscribeOnlineStages(() => calls++);
  const ok = await loadStageConfig({ base: "/editor/", fetchImpl: async (url, init) => { seen.push([url, init?.cache]); return { ok: true, text: async () => '{"v":1,"stageOrigins":["https://s1.x.io","https://s2.x.io"]}' }; } });
  assert.deepEqual(ok, { A: "https://s1.x.io", B: "https://s2.x.io" });
  assert.deepEqual(seen, [[`/editor/${RUNTIME_CONFIG_FILE}`, "no-store"]]);
  assert.equal(onlineStageState().config, "done");
  assert.ok(calls >= 2, "状态变了通知订阅方");
  resetOnlineStagesForTest();
  assert.equal(await loadStageConfig({ fetchImpl: async () => ({ ok: false, text: async () => "" }) }), null);
  resetOnlineStagesForTest();
  assert.equal(await loadStageConfig({ fetchImpl: async () => { throw new Error("offline"); } }), null);
  resetOnlineStagesForTest();
  assert.equal(await loadStageConfig({ timeoutMs: 20, fetchImpl: (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("abort")))) }), null);
  assert.equal(onlineStageState().origins, null);
});

test("C10-SO-05 握手失败之后本页会话里不再回到双舞台", () => {
  markStageHandshake("failed", "B 没握手");
  assert.equal(onlineStageState().handshake, "failed");
  markStageHandshake("ok");
  assert.equal(onlineStageState().handshake, "failed");
  assert.equal(onlineStageState().reason, "B 没握手");
});

test("C10-SO-06 总开关「在线执行用户卡与素材效果卡」(托管方可关):只有明写 onlineCardExec: false 才是关,没写、写别的、配置不对都按缺省(开)", async () => {
  const { parseCardExecSwitch } = await import("./stageOrigins.ts");
  assert.equal(parseCardExecSwitch({ v: 1, stageOrigins: ["https://s1.x.io", "https://s2.x.io"], onlineCardExec: false }), false);
  assert.equal(parseCardExecSwitch('{"v":1,"onlineCardExec":false}'), false);
  for (const on of [{}, { onlineCardExec: true }, { onlineCardExec: "false" }, { onlineCardExec: 0 }, { onlineCardExec: null }, null, undefined, "", "{", 42, [], '{"v":1}']) {
    assert.equal(parseCardExecSwitch(on), true, JSON.stringify(on));
  }
});

test("C10-SO-07 取运行配置时一并读总开关:关了记进本页状态(舞台源照常认);缺省与取不到都是开", async () => {
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
  assert.equal(onlineStageState().origins, null, "取不到配置时没有舞台源,不挂载舞台、不执行");
});

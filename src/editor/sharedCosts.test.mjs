/**
 * 页面侧的共享成本记录与桌面转写(`sharedCosts.ts`;契约 `docs/plan/c10-contract.md` 第 3 节)。用例 SC-01～SC-07。
 * 对着真的共享项目组装跑(`server/test/auth-kit.mjs` 的托管端与证明握手),连接是测试自己的 WebSocket 客户端,
 * 按 `docRequest` 的形状包一层 `request(msg) → 回包`。
 * 跑:node --test src/editor/sharedCosts.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { hostFor, createProject, join } from "../../server/test/auth-kit.mjs";
import { describeEnvironment } from "../../server/render-node/fingerprint.mjs";
import { costDeviceString } from "../render/costDevice.mjs";

const S = await import(srcUrl("editor/sharedCosts.ts"));

const ENV = {
  platform: "Windows",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
  vendor: "Google Inc. (Intel)",
};
const FP = describeEnvironment({ platform: ENV.platform, renderer: ENV.renderer, vendor: ENV.vendor, chromeVersion: ENV.userAgent }).fingerprint;
const deviceHere = costDeviceString({ ua: ENV.userAgent, renderer: ENV.renderer, compact: false, offscreenGl: true, mode: "dev" });
const deviceOther = costDeviceString({ ua: "Mozilla/5.0 (Macintosh) Chrome/150.0.0.0", renderer: "Apple M2", compact: false, offscreenGl: true, mode: "dev" });
/** 同一台浏览器只有一个舞台时测的(舞台闸门第一级) */
const deviceSingle = costDeviceString({ ua: ENV.userAgent, renderer: ENV.renderer, compact: true, offscreenGl: false, mode: "build" });
const k1 = (identityKey, stepMs, extra = {}) => ({ identityKey, fps: 30, stepMs, inlineMs: 0, rasterMs: 0, serializeMs: 0, catchUpMs: 0, kind: "stepped", mode: "dev", measuredAt: 1_790_000_000_000, device: deviceHere, ...extra });

/** 测试的 WebSocket 客户端 → `docRequest` 的形状 */
let seq = 0;
function requestOf(c) {
  return async (msg, timeoutMs = 3000) => {
    const reqId = `sc-${++seq}`;
    c.send({ ...msg, reqId });
    return c.next((m) => m?.reqId === reqId, timeoutMs);
  };
}

async function member(t) {
  const env = await hostFor(t);
  const P = await createProject(env, { mode: "free" });
  const desk = await join(env, P, { username: "desk", remote: "198.51.100.7" });
  const phone = await join(env, P, { username: "phone", remote: "198.51.100.8" });
  return { env, P, desk: requestOf(desk), phone: requestOf(phone) };
}

test("SC-01 samplesOf / toSharedInput / measuredHere:形状转换与「是不是这台浏览器测的」", () => {
  assert.equal(S.samplesOf({ samples: 24 }), 24);
  assert.equal(S.samplesOf({ device: deviceHere }), 16, "没有 samples 取 device 串里的 stepN");
  assert.equal(S.samplesOf({}), 1);
  assert.deepEqual(S.toSharedInput(k1("abc", 4.25)), { identityKey: "abc", stepMs: 4.25, samples: 16, measuredAt: 1_790_000_000_000, mode: "dev" });
  assert.equal(S.toSharedInput({ identityKey: "abc" }), null);
  assert.equal(S.toSharedInput({ identityKey: "bad/key", stepMs: 1 }), null);
  assert.equal(S.toSharedInput(k1("x", 1, { measuredAt: undefined, mode: "build" }), () => 42).measuredAt, 42);
  assert.equal(S.measuredHere(k1("a", 1), ENV), true);
  assert.equal(S.measuredHere(k1("a", 1, { device: deviceOther }), ENV), false, "别的机器测的不转写");
  assert.equal(S.measuredHere(k1("a", 1, { device: deviceSingle }), ENV), true, "只有一个舞台时测的同样转写(所有在线浏览器测完都写,2026-10-07 用户定)");
  assert.equal(S.measuredHere(k1("a", 1, { device: "" }), ENV), false);
});

test("SC-02 publishSharedCosts 写进文档服务,listSharedCosts 由另一位成员读回;指纹由服务端按原始环境算", async (t) => {
  const { P, desk, phone } = await member(t);
  const w = await S.publishSharedCosts({ request: desk, projectId: P.projectId, environment: ENV, records: [S.toSharedInput(k1("cardA", 3)), S.toSharedInput(k1("cardB", 40))] });
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(w.added, 2);
  assert.equal(w.envFingerprint, FP);
  const phoneEnv = { platform: "iPhone", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/152.0.0.0 Mobile", renderer: "Apple GPU", vendor: "Apple Inc." };
  const l = await S.listSharedCosts({ request: phone, projectId: P.projectId, environment: phoneEnv });
  assert.deepEqual(l.records.map((r) => [r.identityKey, r.envFingerprint, r.stepMs]), [["cardA", FP, 3], ["cardB", FP, 40]]);
  assert.ok(/^[0-9a-f]{16}$/.test(l.envFingerprint) && l.envFingerprint !== FP, "手机的指纹与桌面不同");
});

test("SC-03 分批:超过一批(500 条)的分几次发,全部落下", async (t) => {
  const { P, desk, phone } = await member(t);
  const records = Array.from({ length: 1203 }, (_, i) => S.toSharedInput(k1(`card${i}`, i / 10)));
  const w = await S.publishSharedCosts({ request: desk, projectId: P.projectId, environment: ENV, records });
  assert.equal(w.ok, true);
  assert.equal(w.added, 1203);
  const l = await S.listSharedCosts({ request: phone, projectId: P.projectId, environment: ENV });
  assert.equal(l.records.length, 1203);
});

test("SC-04 被拒、连不上:publish 不抛、回 ok:false;list 抛错", async (t) => {
  const { P, desk } = await member(t);
  const w = await S.publishSharedCosts({ request: desk, projectId: "sp_zzzzzzzzzzzzzzzzzzzzzzzzzz", environment: ENV, records: [S.toSharedInput(k1("a", 1))] });
  assert.equal(w.ok, false);
  assert.match(w.error, /forbidden/);
  const dead = async () => { throw new Error("没连上文档服务"); };
  const w2 = await S.publishSharedCosts({ request: dead, projectId: P.projectId, environment: ENV, records: [S.toSharedInput(k1("a", 1))] });
  assert.equal(w2.ok, false);
  await assert.rejects(S.listSharedCosts({ request: dead, projectId: P.projectId, environment: ENV }), /没连上/);
});

test("SC-05 转写:连着共享项目时把本机测的(单舞台、双舞台都算)、当前项目用到的卡写进文档服务;别的机器、项目外的卡不写", async (t) => {
  const { P, desk, phone } = await member(t);
  const costs = [
    k1("cardA", 3), k1("cardB", 40, { measuredAt: 1_790_000_000_500 }),
    k1("cardA", 99, { device: deviceOther }),        // 别的机器
    k1("cardC", 5, { device: deviceSingle }),        // 同一台浏览器只有一个舞台时测的:照样写
    k1("notInProject", 7),                           // 项目里没用到
  ];
  const relay = new S.SharedCostRelay({
    request: desk, linkKey: () => "link-1", projectId: () => P.projectId, environment: () => ENV,
    costs: () => costs, identityKeys: () => new Set(["cardA", "cardB", "cardC"]),
  });
  assert.equal(await relay.sync(), 3);
  const l = await S.listSharedCosts({ request: phone, projectId: P.projectId, environment: ENV });
  assert.deepEqual(l.records.map((r) => [r.identityKey, r.stepMs, r.samples, r.mode]), [["cardA", 3, 16, "dev"], ["cardB", 40, 16, "dev"], ["cardC", 5, 16, "dev"]]);
  // 没变:不再写
  assert.equal(await relay.sync(), 0);
  // 本机又测了一次 cardA(新的测量时刻):只补这一条
  costs.push(k1("cardA", 3.5, { measuredAt: 1_790_000_009_000 }));
  assert.equal(await relay.sync(), 1);
  const l2 = await S.listSharedCosts({ request: phone, projectId: P.projectId, environment: ENV });
  assert.equal(l2.records.find((r) => r.identityKey === "cardA").stepMs, 3.5);
  // 换了连接(重连):从头补传,服务端按测量时刻留最新,重复无害
  let link = "link-1";
  const relay2 = new S.SharedCostRelay({ request: desk, linkKey: () => link, projectId: () => P.projectId, environment: () => ENV, costs: () => costs, identityKeys: () => new Set(["cardA", "cardB"]) });
  assert.equal(await relay2.sync(), 2);
  link = "link-2";
  assert.equal(await relay2.sync(), 2, "换了连接从头补传");
  const l3 = await S.listSharedCosts({ request: phone, projectId: P.projectId, environment: ENV });
  assert.equal(l3.records.find((r) => r.identityKey === "cardA").stepMs, 3.5, "补传的旧记录没盖掉新的");
});

test("SC-06 桌面转写:没连共享项目就不写、不报错", async () => {
  let called = 0;
  const relay = new S.SharedCostRelay({
    request: async () => { called++; return {}; }, linkKey: () => null, projectId: () => "p", environment: () => ENV,
    costs: () => [k1("cardA", 1)], identityKeys: () => new Set(["cardA"]),
  });
  assert.equal(await relay.sync(), 0);
  assert.equal(called, 0);
});

test("SC-07 桌面转写:写失败下一拍再试;同时只跑一次", async () => {
  let fail = true;
  let calls = 0;
  const relay = new S.SharedCostRelay({
    request: async (msg) => { calls++; await new Promise((r) => setTimeout(r, 20)); return fail ? { type: "error", reason: "forbidden" } : { type: "cost.stored", added: msg.records.length, updated: 0, ignored: 0 }; },
    linkKey: () => "l", projectId: () => "p", environment: () => ENV, costs: () => [k1("cardA", 1)], identityKeys: () => new Set(["cardA"]),
  });
  const [a, b] = await Promise.all([relay.sync(), relay.sync()]);
  assert.deepEqual([a, b], [0, 0]);
  assert.equal(calls, 1, "同时只跑一次");
  fail = false;
  assert.equal(await relay.sync(), 1, "失败的下一拍再试");
  assert.equal(relay.debug().log.length, 2);
});

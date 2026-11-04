/**
 * Shared cost records and desktop transcription on the page side (`sharedCosts.ts`; contract
 * `docs/plan/c10-contract.md` section 3). Test cases SC-01~SC-07.
 * Runs against real shared project assembly (hosted side and attestation handshake in
 * `server/test/auth-kit.mjs`); connection is the test's own WebSocket client, wrapping a layer of
 * `request(msg) → response` in the shape of `docRequest`.
 * Run: node --test src/editor/sharedCosts.test.mjs
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
/** Measured when there is only one stage in the same browser (stage gate level 1) */
const deviceSingle = costDeviceString({ ua: ENV.userAgent, renderer: ENV.renderer, compact: true, offscreenGl: false, mode: "build" });
const k1 = (identityKey, stepMs, extra = {}) => ({ identityKey, fps: 30, stepMs, inlineMs: 0, rasterMs: 0, serializeMs: 0, catchUpMs: 0, kind: "stepped", mode: "dev", measuredAt: 1_790_000_000_000, device: deviceHere, ...extra });

/** Test WebSocket client → shape of `docRequest` */
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

test("SC-01 samplesOf / toSharedInput / measuredHere: shape conversion and \"was it measured by this browser\"", () => {
  assert.equal(S.samplesOf({ samples: 24 }), 24);
  assert.equal(S.samplesOf({ device: deviceHere }), 16, "Without samples, take stepN from the device string");
  assert.equal(S.samplesOf({}), 1);
  assert.deepEqual(S.toSharedInput(k1("abc", 4.25)), { identityKey: "abc", stepMs: 4.25, samples: 16, measuredAt: 1_790_000_000_000, mode: "dev" });
  assert.equal(S.toSharedInput({ identityKey: "abc" }), null);
  assert.equal(S.toSharedInput({ identityKey: "bad/key", stepMs: 1 }), null);
  assert.equal(S.toSharedInput(k1("x", 1, { measuredAt: undefined, mode: "build" }), () => 42).measuredAt, 42);
  assert.equal(S.measuredHere(k1("a", 1), ENV), true);
  assert.equal(S.measuredHere(k1("a", 1, { device: deviceOther }), ENV), false, "Measurements taken on another machine are not relayed");
  assert.equal(S.measuredHere(k1("a", 1, { device: deviceSingle }), ENV), true, "Measurements taken with only one stage are relayed the same way (all online browsers write once measured; user decision, 2026-10-07)");
  assert.equal(S.measuredHere(k1("a", 1, { device: "" }), ENV), false);
});

test("SC-02 publishSharedCosts writes into the document service, listSharedCosts is read back by another member; the fingerprint is computed by the server from the original environment", async (t) => {
  const { P, desk, phone } = await member(t);
  const w = await S.publishSharedCosts({ request: desk, projectId: P.projectId, environment: ENV, records: [S.toSharedInput(k1("cardA", 3)), S.toSharedInput(k1("cardB", 40))] });
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(w.added, 2);
  assert.equal(w.envFingerprint, FP);
  const phoneEnv = { platform: "iPhone", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/152.0.0.0 Mobile", renderer: "Apple GPU", vendor: "Apple Inc." };
  const l = await S.listSharedCosts({ request: phone, projectId: P.projectId, environment: phoneEnv });
  assert.deepEqual(l.records.map((r) => [r.identityKey, r.envFingerprint, r.stepMs]), [["cardA", FP, 3], ["cardB", FP, 40]]);
  assert.ok(/^[0-9a-f]{16}$/.test(l.envFingerprint) && l.envFingerprint !== FP, "The mobile fingerprint differs from the desktop one");
});

test("SC-03 Batching: more than one batch (500 records) is sent in several requests, and all of it lands", async (t) => {
  const { P, desk, phone } = await member(t);
  const records = Array.from({ length: 1203 }, (_, i) => S.toSharedInput(k1(`card${i}`, i / 10)));
  const w = await S.publishSharedCosts({ request: desk, projectId: P.projectId, environment: ENV, records });
  assert.equal(w.ok, true);
  assert.equal(w.added, 1203);
  const l = await S.listSharedCosts({ request: phone, projectId: P.projectId, environment: ENV });
  assert.equal(l.records.length, 1203);
});

test("SC-04 Rejected or unreachable: publish does not throw and returns ok:false; list throws", async (t) => {
  const { P, desk } = await member(t);
  const w = await S.publishSharedCosts({ request: desk, projectId: "sp_zzzzzzzzzzzzzzzzzzzzzzzzzz", environment: ENV, records: [S.toSharedInput(k1("a", 1))] });
  assert.equal(w.ok, false);
  assert.match(w.error, /forbidden/);
  const dead = async () => { throw new Error("Not connected to the document service"); };
  const w2 = await S.publishSharedCosts({ request: dead, projectId: P.projectId, environment: ENV, records: [S.toSharedInput(k1("a", 1))] });
  assert.equal(w2.ok, false);
  await assert.rejects(S.listSharedCosts({ request: dead, projectId: P.projectId, environment: ENV }), /Not connected to the document service/);
});

test("SC-05 Relay: when connected to a shared project, write the costs measured on this machine (single-stage and dual-stage both count) for cards used by the current project into the document service; records from other machines and cards outside the project are not written", async (t) => {
  const { P, desk, phone } = await member(t);
  const costs = [
    k1("cardA", 3), k1("cardB", 40, { measuredAt: 1_790_000_000_500 }),
    k1("cardA", 99, { device: deviceOther }),        // Other machines
    k1("cardC", 5, { device: deviceSingle }),        // Measured when there is only one stage in the same browser: still write
    k1("notInProject", 7),                           // Not used in the project
  ];
  const relay = new S.SharedCostRelay({
    request: desk, linkKey: () => "link-1", projectId: () => P.projectId, environment: () => ENV,
    costs: () => costs, identityKeys: () => new Set(["cardA", "cardB", "cardC"]),
  });
  assert.equal(await relay.sync(), 3);
  const l = await S.listSharedCosts({ request: phone, projectId: P.projectId, environment: ENV });
  assert.deepEqual(l.records.map((r) => [r.identityKey, r.stepMs, r.samples, r.mode]), [["cardA", 3, 16, "dev"], ["cardB", 40, 16, "dev"], ["cardC", 5, 16, "dev"]]);
  // Unchanged: no longer write
  assert.equal(await relay.sync(), 0);
  // This machine measured cardA again (new measurement timestamp): only backfill this item
  costs.push(k1("cardA", 3.5, { measuredAt: 1_790_000_009_000 }));
  assert.equal(await relay.sync(), 1);
  const l2 = await S.listSharedCosts({ request: phone, projectId: P.projectId, environment: ENV });
  assert.equal(l2.records.find((r) => r.identityKey === "cardA").stepMs, 3.5);
  // Connection changed (reconnect): retransmit from the start, server keeps the latest by
  // measurement timestamp, duplicates are harmless
  let link = "link-1";
  const relay2 = new S.SharedCostRelay({ request: desk, linkKey: () => link, projectId: () => P.projectId, environment: () => ENV, costs: () => costs, identityKeys: () => new Set(["cardA", "cardB"]) });
  assert.equal(await relay2.sync(), 2);
  link = "link-2";
  assert.equal(await relay2.sync(), 2, "Switching connections re-uploads everything from the start");
  const l3 = await S.listSharedCosts({ request: phone, projectId: P.projectId, environment: ENV });
  assert.equal(l3.records.find((r) => r.identityKey === "cardA").stepMs, 3.5, "The re-uploaded old records did not overwrite the new one");
});

test("SC-06 Desktop relay: nothing is written and no error is raised when no shared project is connected", async () => {
  let called = 0;
  const relay = new S.SharedCostRelay({
    request: async () => { called++; return {}; }, linkKey: () => null, projectId: () => "p", environment: () => ENV,
    costs: () => [k1("cardA", 1)], identityKeys: () => new Set(["cardA"]),
  });
  assert.equal(await relay.sync(), 0);
  assert.equal(called, 0);
});

test("SC-07 Desktop relay: a failed write is retried on the next tick; only one run at a time", async () => {
  let fail = true;
  let calls = 0;
  const relay = new S.SharedCostRelay({
    request: async (msg) => { calls++; await new Promise((r) => setTimeout(r, 20)); return fail ? { type: "error", reason: "forbidden" } : { type: "cost.stored", added: msg.records.length, updated: 0, ignored: 0 }; },
    linkKey: () => "l", projectId: () => "p", environment: () => ENV, costs: () => [k1("cardA", 1)], identityKeys: () => new Set(["cardA"]),
  });
  const [a, b] = await Promise.all([relay.sync(), relay.sync()]);
  assert.deepEqual([a, b], [0, 0]);
  assert.equal(calls, 1, "Only one run at a time");
  fail = false;
  assert.equal(await relay.sync(), 1, "A failure is retried on the next tick");
  assert.equal(relay.debug().log.length, 2);
});

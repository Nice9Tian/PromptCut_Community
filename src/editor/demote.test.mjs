/**
 * K6 父页那一半(`demote.ts`)的单测。跑:
 *   node --experimental-test-module-mocks --test src/editor/demote.test.mjs
 *
 * 钉三件事:整条 PUT 带 `capped` + `demoted`、各测量值保留旧值;先并进手里的 costs、
 * 记进 pendingDemote(就绪前照常活渲);同一张卡本次会话只降一次,查不到身份或记录不 PUT。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

const calls = { merged: [], pending: [], fetches: [] };
let identityKeys = {};
let costs = [];
let fetchReply = { ok: true, status: 200 };

mock.module(srcUrl("store/project.ts"), { exports: { getState: () => ({ project: { tracks: [] } }) } });
mock.module(srcUrl("editor/costIdentity.ts"), { exports: { clipIdentityOf: () => ({ identityKeys }) } });
mock.module(srcUrl("editor/planDispatch.ts"), {
  exports: { currentCosts: () => costs, mergePlanCosts: (records) => calls.merged.push(records) },
});
mock.module(srcUrl("editor/snapshotFeed.ts"), { exports: { markPendingDemote: (id) => calls.pending.push(id) } });

globalThis.fetch = async (url, init) => {
  calls.fetches.push({ url, method: init.method, body: JSON.parse(init.body) });
  if (fetchReply instanceof Error) throw fetchReply;
  return fetchReply;
};

const { onStageDemote, demotedClips, resetDemote } = await import(srcUrl("editor/demote.ts"));

const OLD = { identityKey: "k1", device: "dev", stepMs: 4, catchUpMs: 90, vtOk: true };

beforeEach(() => {
  resetDemote();
  calls.merged = [];
  calls.pending = [];
  calls.fetches = [];
  identityKeys = { c1: "k1" };
  costs = [OLD];
  fetchReply = { ok: true, status: 200 };
});

test("整条 PUT:旧记录原样带上,只加 capped 和 demoted", async () => {
  const r = await onStageDemote("c1");
  assert.deepEqual(r, { ok: true, clipId: "c1", identityKey: "k1" });
  assert.equal(calls.fetches.length, 1);
  const { url, method, body } = calls.fetches[0];
  assert.equal(url, "/api/data/costs");
  assert.equal(method, "PUT");
  assert.deepEqual(body, { records: [{ ...OLD, capped: true, demoted: true }] });
  assert.equal("pinnedHeavy" in body.records[0], false, "只用 demoted 这一面旗");
});

test("先并进手里那份 costs,并记进 pendingDemote", async () => {
  await onStageDemote("c1");
  assert.deepEqual(calls.pending, ["c1"]);
  assert.deepEqual(calls.merged, [[{ ...OLD, capped: true, demoted: true }]]);
  assert.ok(demotedClips().has("c1"));
});

test("同一张卡本次会话只降一次", async () => {
  await onStageDemote("c1");
  const again = await onStageDemote("c1");
  assert.deepEqual(again, { ok: true, clipId: "c1", reason: "already" });
  assert.equal(calls.fetches.length, 1);
});

test("查不到身份或记录:不 PUT、不记 pending,之后还能再试", async () => {
  identityKeys = {};
  assert.equal((await onStageDemote("c1")).reason, "no-identity");
  identityKeys = { c1: "k1" };
  costs = [];
  assert.equal((await onStageDemote("c1")).reason, "no-record");
  assert.equal(calls.fetches.length, 0);
  assert.deepEqual(calls.pending, []);
  assert.equal(demotedClips().has("c1"), false);
});

test("PUT 失败照实回报,不抛", async () => {
  fetchReply = { ok: false, status: 400 };
  assert.deepEqual(await onStageDemote("c1"), { ok: false, clipId: "c1", identityKey: "k1", reason: "http 400" });
  resetDemote();
  fetchReply = new Error("offline");
  assert.deepEqual(await onStageDemote("c1"), { ok: false, clipId: "c1", identityKey: "k1", reason: "offline" });
});

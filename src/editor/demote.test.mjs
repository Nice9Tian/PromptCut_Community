/**
 * Unit test for the parent page half of K6 (`demote.ts`). Run:
 *   node --experimental-test-module-mocks --test src/editor/demote.test.mjs
 *
 * Lock down three things: entire PUT includes `capped` + `demoted`, keeping old values for each
 * measurement; merged into local costs first, recorded into pendingDemote (live render proceeds as
 * usual before ready); the same card is downgraded only once in this session; do not PUT if identity
 * or record cannot be found.
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

test("Whole-record PUT: the old record is carried over as is, only capped and demoted are added", async () => {
  const r = await onStageDemote("c1");
  assert.deepEqual(r, { ok: true, clipId: "c1", identityKey: "k1" });
  assert.equal(calls.fetches.length, 1);
  const { url, method, body } = calls.fetches[0];
  assert.equal(url, "/api/data/costs");
  assert.equal(method, "PUT");
  assert.deepEqual(body, { records: [{ ...OLD, capped: true, demoted: true }] });
  assert.equal("pinnedHeavy" in body.records[0], false, "Only the demoted flag is used");
});

test("First merge into the costs copy in hand and record it in pendingDemote", async () => {
  await onStageDemote("c1");
  assert.deepEqual(calls.pending, ["c1"]);
  assert.deepEqual(calls.merged, [[{ ...OLD, capped: true, demoted: true }]]);
  assert.ok(demotedClips().has("c1"));
});

test("The same card is demoted only once per session", async () => {
  await onStageDemote("c1");
  const again = await onStageDemote("c1");
  assert.deepEqual(again, { ok: true, clipId: "c1", reason: "already" });
  assert.equal(calls.fetches.length, 1);
});

test("When the identity or record cannot be found: no PUT, no pending record, and it can be tried again later", async () => {
  identityKeys = {};
  assert.equal((await onStageDemote("c1")).reason, "no-identity");
  identityKeys = { c1: "k1" };
  costs = [];
  assert.equal((await onStageDemote("c1")).reason, "no-record");
  assert.equal(calls.fetches.length, 0);
  assert.deepEqual(calls.pending, []);
  assert.equal(demotedClips().has("c1"), false);
});

test("A failed PUT is reported as is, without throwing", async () => {
  fetchReply = { ok: false, status: 400 };
  assert.deepEqual(await onStageDemote("c1"), { ok: false, clipId: "c1", identityKey: "k1", reason: "http 400" });
  resetDemote();
  fetchReply = new Error("offline");
  assert.deepEqual(await onStageDemote("c1"), { ok: false, clipId: "c1", identityKey: "k1", reason: "offline" });
});

/**
 * Regression test for Root Cause E: ready index subscription is keyed only by session; edits
 * (localRev + 1) do not reconnect or clear the table.
 * Run: node --experimental-test-module-mocks --test src/editor/snapshotSubscription.test.mjs
 *
 * Previously, `syncSnapshotSubscription` keyed on `session#localRev`: every edit with localRev + 1
 * cleared readyIndex and reconnected SSE, while server `/api/frames/ready` did not inspect session /
 * localRev at all (`vite-plugin-frames.ts`). During reconnection gaps, playing heavy cards were
 * uniformly transparent. Now: client no longer preemptively clears table, only listening to server
 * `reset` (sent when prerender process changes entry in `adoptCardPlan`).
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
let key = { session: "s", localRev: 1 };
mock.module(srcUrl("render/dataMirror.ts"), { exports: { mirrorKey: () => key, pushWanted: () => {} } });
mock.module(srcUrl("editor/planDispatch.ts"), { exports: { currentPlan: () => ({ segments: [{ fromSec: 0, toSec: 1000, heavy: new Set(["h"]) }] }) } });

const feed = await import(srcUrl("editor/snapshotFeed.ts"));

test("Editing does not reconnect or clear the table; only a server reset clears it; only a session change reconnects", () => {
  const subs = [];
  feed.setSnapshotSource({
    subscribeReady: (session, rev, cb) => { const sub = { session, rev, cb, closed: false }; subs.push(sub); return () => { sub.closed = true; }; },
    fetchSnapshot: async () => "<div/>",
  });
  feed.syncSnapshotSubscription(() => {});
  assert.equal(subs.length, 1);
  subs[0].cb({ type: "layer", clipId: "h", kind: "html", key: "K", ranges: [[0, 299]] });
  assert.ok(feed.currentReadyIndex().get("h"), "The layer has arrived");

  // User edits: localRev + 1, host calls once more as usual
  key = { session: "s", localRev: 2 };
  feed.syncSnapshotSubscription(() => {});
  assert.equal(subs.length, 1, "The same session does not reconnect");
  assert.equal(subs[0].closed, false);
  assert.ok(feed.currentReadyIndex().get("h"), "The client does not clear the table ahead of the server: the old layer stays in use until the server resets");

  // Server changed entry: reset + full layer
  subs[0].cb({ type: "reset", localRev: 2 });
  assert.equal(feed.currentReadyIndex().size, 0, "reset clears the table");
  subs[0].cb({ type: "layer", clipId: "h", kind: "html", key: "K2", ranges: [[0, 10]] });
  assert.equal(feed.currentReadyIndex().get("h").get("html").key, "K2");

  // Switch project (session changed): reconnect and clear table
  key = { session: "s2", localRev: 1 };
  feed.syncSnapshotSubscription(() => {});
  assert.equal(subs.length, 2);
  assert.equal(subs[0].closed, true);
  assert.equal(subs[1].session, "s2");
  assert.equal(feed.currentReadyIndex().size, 0);
});

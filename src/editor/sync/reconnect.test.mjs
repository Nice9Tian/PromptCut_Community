import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
const { SyncLink } = await import(srcUrl("editor/sync/link.ts"));
const { createEmptyProject } = await import(srcUrl("kernel/project.ts"));
const { parseSessionItem } = await import("../../../server/docservice/session.mjs");
const pause = ms => new Promise(r => setTimeout(r, ms));
function link(protocols, onProtocolError) {
  return new SyncLink({ url: "ws://isolated.invalid", projectId: "room", session: "probe", initial: createEmptyProject("saved-content"),
    protocols, onProtocolError, reconnect: { minMs: 1, maxMs: 3 } });
}
test("After the trusted endpoint explicitly rejects, terminate the connection instead of re-authenticating repeatedly as if it were a network failure", async () => {
  let attempts = 0, classified = 0;
  const c = link(async () => { attempts++; throw { status: 410 }; }, e => { classified++; assert.equal(e.status, 410); return true; });
  c.start(); await pause(60);
  assert.equal(attempts, 1); assert.equal(classified, 1); assert.equal(c.connected, false);
  c.start(); await pause(10); assert.equal(attempts, 1);
});
test("Keep retrying when the proof fetch fails temporarily; stop retrying after stop", async () => {
  let attempts = 0;
  const c = link(async () => { attempts++; throw new TypeError("network"); }, () => false);
  c.start(); await pause(90); c.stop(); const stoppedAt = attempts;
  assert.ok(stoppedAt > 1); await pause(20); assert.equal(attempts, stoppedAt);
});
test("A late proof-fetch error after leaving must not modify the new page", async () => {
  let reject, classified = 0;
  const c = link(() => new Promise((_r, no) => { reject = no; }), () => { classified++; return true; });
  c.start(); c.stop(); reject({ status: 410 }); await pause(10);
  assert.equal(classified, 0);
});

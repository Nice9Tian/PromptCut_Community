/**
 * Task D (`claude/queue-maint`) page side: pure browser node reports busy (`node.active`, M7 D2
 * supplementary [ruling]). Queue side (how lock idle is calculated, whether splitter takes over)
 * see `server/test/queue-maint-d2-busy.test.mjs`.
 *
 *   QM-D-P1 Old queue (welcome without activeIntervalMs): sends nothing even when busy, matching
 *     behavior before the change
 *   QM-D-P2 New queue, holding a claim (generating snapshots): reports busy 'bake' at intervals,
 *     no more frequent than the interval
 *   QM-D-P3 Holding no claim: reports only if host says background stage is busy ('stage'); does not
 *     report when idle (null); host throwing an error treated as not busy
 *   QM-D-P4 Going offline (stop), or after check-in rejected: no longer reports; after re-checking in,
 *     reports on next tick if busy
 *
 * Run: node --test src/online/browserNodeActive.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserNode } from "./browserNode.ts";

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const FP = "aaaaaaaaaaaaaaaa";
const EVERY = 10_000;
const TASK = {
  id: "snapshot:rk:0-2", kind: "snapshot", tier: "shared", resultKey: "rk", range: { unit: "localFrame", from: 0, to: 2 },
  source: { projectId: "p1", projectRev: 7, userId: "u@d" },
  input: { clipId: "c", compositing: "independent", canvasHeavy: false, bake: { start: 0, end: 0.1, count: 3, sampling: { phase: { numerator: 0, denominator: 1 } } } },
  weight: { class: "light" }, requires: { envFingerprint: FP, codeVersion: "cv", cardSources: {}, transcode: false, userCards: false, graphCards: false },
};

function rig({ welcome = { activeIntervalMs: EVERY }, busy } = {}) {
  let t = 1_000_000;
  const sent = [], bakes = [];
  const node = createBrowserNode({
    nodeId: "n", projectId: "p1", userId: "u@d", codeVersion: "cv", environment: { platform: "", userAgent: "", renderer: "", vendor: "" },
    now: () => t, isIdle: () => true, send: (m) => { sent.push(JSON.parse(JSON.stringify(m))); return true; },
    keptProject: () => ({ rev: 7 }), fetchSnapshot: async () => null,
    bakeFrame: (job) => new Promise((resolve) => bakes.push({ job, resolve })),
    finishTask: async () => ({ v: 1 }),
    ...(busy ? { busy } : {}),
  });
  node.start();
  if (welcome !== null) node.receive({ type: "node.welcome", nodeId: "n", resumed: [], lost: [], envFingerprint: FP, ...welcome });
  return {
    node, sent, bakes, advance: (ms) => { t += ms; },
    of: (type) => sent.filter((m) => m.type === type),
    async claim() {
      node.receive({ type: "queue.snapshot", tasks: [{ ...TASK, state: "open", version: 1 }] });
      node.tick();
      node.receive({ type: "task.claimed", id: TASK.id, token: 5, version: 2, task: { ...TASK, state: "claimed", version: 2 } });
      await flush();
    },
  };
}

test("QM-D-P1 old queue (node.welcome without activeIntervalMs): holds a claim and the host also says busy, yet not a single node.active is sent", async () => {
  const r = rig({ welcome: {}, busy: () => "stage" });
  await r.claim();
  assert.equal(r.bakes.length, 1, "Frame 0 is in progress");
  for (let i = 0; i < 5; i++) { r.advance(EVERY); r.node.tick(); }
  assert.equal(r.of("node.active").length, 0);
  assert.equal(r.node.debug().counters.active, 0);
});

test("QM-D-P2 new queue, holding a claim (generating snapshots): reports busy 'bake' per activeIntervalMs, no more often than the interval", async () => {
  const r = rig();
  await r.claim();
  assert.equal(r.of("node.active").length, 0, "Idle before the claim, no report");
  r.node.tick();
  const first = r.of("node.active");
  assert.deepEqual(first.map((m) => m.busy), ["bake"], "Reports on the next tick after the claim");
  r.advance(EVERY - 1);
  r.node.tick();
  assert.equal(r.of("node.active").length, 1, "no more reports within the interval");
  r.advance(1);
  r.node.tick();
  r.node.tick();
  assert.equal(r.of("node.active").length, 2, "reports once when the interval is reached, no duplicate at the same instant");
  assert.equal(r.node.debug().counters.active, 2);
  assert.deepEqual(Object.keys(r.of("node.active")[0]).sort(), ["busy", "type"], "carries only busy, not claim, fingerprint and the like");
});

test("QM-D-P3 no claim held: reports only when the host says the background stage is busy ('stage'); idle (null) does not report; a host that throws counts as not busy", () => {
  let state = null;
  const r = rig({ busy: () => { if (state === "throw") throw new Error("Broken"); return state; } });
  r.node.tick();
  assert.equal(r.of("node.active").length, 0, "idle does not report");
  state = "stage";
  r.node.tick();
  assert.deepEqual(r.of("node.active").map((m) => m.busy), ["stage"]);
  state = null;
  r.advance(EVERY * 3);
  r.node.tick();
  assert.equal(r.of("node.active").length, 1, "stops reporting once not busy (the lock still counts idle by output)");
  state = "throw";
  r.node.tick();
  assert.equal(r.of("node.active").length, 1);
  state = "x".repeat(80);
  r.node.tick();
  assert.equal(r.of("node.active").at(-1).busy.length, 32, "overlong values are truncated to 32 characters (the queue limit)");
});

test("QM-D-P4 no more reports after going offline (stop) or after check-in is refused; after re-checking in, a busy node reports on the next beat", async () => {
  const r = rig({ busy: () => "stage" });
  r.node.tick();
  assert.equal(r.of("node.active").length, 1);
  // Session disconnected and reconnected: does not wait for a full interval after welcome of the new session
  r.node.start();
  r.node.receive({ type: "node.welcome", nodeId: "n", resumed: [], lost: [], envFingerprint: FP, activeIntervalMs: EVERY });
  r.node.tick();
  assert.equal(r.of("node.active").length, 2, "reports on the next beat after re-checking in");
  r.node.stop();
  r.advance(EVERY * 2);
  r.node.tick();
  assert.equal(r.of("node.active").length, 2, "no reports after going offline");

  const refused = rig({ welcome: null, busy: () => "stage" });
  refused.node.receive({ type: "error", reason: "forbidden" });
  refused.advance(EVERY);
  refused.node.tick();
  assert.equal(refused.of("node.active").length, 0, "no report when check-in is refused");
});

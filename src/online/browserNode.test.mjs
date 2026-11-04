/**
 * Yield patch for in-page pure browser nodes (found by M7 acceptance check probes A5 / A6): during
 * playback and scrubbing, background live render gate is closed, and frame being worked on is blocked
 * in stage; "finish current frame before releasing" never completes: neither outputting frames nor
 * releasing. After yielding, if current frame cannot finish within `YIELD_FRAME_MAX_MS`, abort it and
 * release immediately just like on page hide (checked in tick `tick()`, clock is injected).
 * Run: node --test src/online/browserNode.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserNode, YIELD_FRAME_MAX_MS } from "./browserNode.ts";

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const FP = "aaaaaaaaaaaaaaaa";
const TASK = {
  id: "snapshot:rk:0-2", kind: "snapshot", tier: "shared", resultKey: "rk", range: { unit: "localFrame", from: 0, to: 2 },
  source: { projectId: "p1", projectRev: 7, userId: "u@d" },
  input: { clipId: "c", compositing: "independent", canvasHeavy: false, bake: { start: 0, end: 0.1, count: 3, sampling: { phase: { numerator: 0, denominator: 1 } } } },
  weight: { class: "light" }, requires: { envFingerprint: FP, codeVersion: "cv", cardSources: {}, transcode: false, userCards: false, graphCards: false },
};

async function rig() {
  let t = 1_000_000;
  const sent = [], bakes = [];
  const node = createBrowserNode({
    nodeId: "n", projectId: "p1", userId: "u@d", codeVersion: "cv", environment: { platform: "", userAgent: "", renderer: "", vendor: "" },
    now: () => t, isIdle: () => true, send: (m) => { sent.push(JSON.parse(JSON.stringify(m))); return true; },
    keptProject: () => ({ rev: 7 }), fetchSnapshot: async () => null,
    bakeFrame: (job) => new Promise((resolve) => bakes.push({ job, resolve })),
    finishTask: async () => ({ v: 1 }),
  });
  node.start();
  node.receive({ type: "node.welcome", nodeId: "n", resumed: [], lost: [], envFingerprint: FP });
  node.receive({ type: "queue.snapshot", tasks: [{ ...TASK, state: "open", version: 1 }] });
  node.tick();
  node.receive({ type: "task.claimed", id: TASK.id, token: 5, version: 2, task: { ...TASK, state: "claimed", version: 2 } });
  await flush();
  return { node, sent, bakes, advance: (ms) => { t += ms; }, of: (type) => sent.filter((m) => m.type === type) };
}

for (const cause of ["play", "drag", "urgent"]) {
  test(`After yielding (${cause}), the current frame is blocked and cannot finish within ${YIELD_FRAME_MAX_MS} ms: abort and release immediately once, drop the late frame`, async () => {
    const r = await rig();
    assert.equal(r.bakes.length, 1, "Frame 0 is in progress");
    r.node.yieldFor(cause);
    r.advance(YIELD_FRAME_MAX_MS - 1);
    r.node.tick();
    await flush();
    assert.equal(r.of("task.release").length, 0, "Within the limit, still wait for the current frame to finish");
    r.advance(2);
    r.node.tick();
    await flush();
    const rel = r.of("task.release");
    assert.equal(rel.length, 1, `Limit reached, released immediately: ${JSON.stringify(r.sent)}`);
    assert.deepEqual([rel[0].id, rel[0].token, rel[0].reason], [TASK.id, 5, `yield-${cause}`]);
    assert.equal(r.bakes[0].job.signal.aborted, true, "Abort this frame on the stage");
    const progress = r.of("task.progress").length;
    r.bakes[0].resolve({ hash: "0".repeat(64), bytes: 1 });
    await flush();
    assert.equal(r.of("task.progress").length, progress, "A late frame does not report progress");
    assert.equal(r.of("task.release").length, 1);
    assert.equal(r.of("task.complete").length + r.of("task.fail").length, 0);
  });
}

test("After yielding, the current frame finishes on time: still finish this frame and then release (no timeout path)", async () => {
  const r = await rig();
  r.node.yieldFor("play");
  r.advance(100);
  r.bakes[0].resolve({ hash: "0".repeat(64), bytes: 1 });
  await flush();
  const rel = r.of("task.release");
  assert.equal(rel.length, 1);
  assert.equal(rel[0].reason, "yield-play");
  assert.equal(r.bakes[0].job.signal.aborted, false, "The frame that finished was not aborted");
  r.advance(YIELD_FRAME_MAX_MS * 2);
  r.node.tick();
  await flush();
  assert.equal(r.of("task.release").length, 1, "No duplicate release");
});

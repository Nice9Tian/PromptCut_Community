/**
 * 页面纯浏览器节点的让路补丁(M7 验收探针 A5 / A6 查出):播放、拖动时后台活的门关了,正在做的那一帧在舞台里被挡住,
 * 「当前帧做完再放回」就一直等不到 —— 既不出帧也不放回。让路之后当前帧 `YIELD_FRAME_MAX_MS` 之内做不完,就像页面隐藏那样
 * 中止它、立即放回(节拍 `tick()` 里判,时钟是注入的)。
 * 跑:node --test src/online/browserNode.test.mjs
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
  test(`让路(${cause})之后当前帧被挡住、${YIELD_FRAME_MAX_MS} ms 内做不完:中止并立即放回一次,迟到的帧丢掉`, async () => {
    const r = await rig();
    assert.equal(r.bakes.length, 1, "第 0 帧在做");
    r.node.yieldFor(cause);
    r.advance(YIELD_FRAME_MAX_MS - 1);
    r.node.tick();
    await flush();
    assert.equal(r.of("task.release").length, 0, "上限之内照旧等当前帧做完");
    r.advance(2);
    r.node.tick();
    await flush();
    const rel = r.of("task.release");
    assert.equal(rel.length, 1, `上限到了立即放回:${JSON.stringify(r.sent)}`);
    assert.deepEqual([rel[0].id, rel[0].token, rel[0].reason], [TASK.id, 5, `yield-${cause}`]);
    assert.equal(r.bakes[0].job.signal.aborted, true, "中止舞台这一帧");
    const progress = r.of("task.progress").length;
    r.bakes[0].resolve({ hash: "0".repeat(64), bytes: 1 });
    await flush();
    assert.equal(r.of("task.progress").length, progress, "迟到的帧不报进度");
    assert.equal(r.of("task.release").length, 1);
    assert.equal(r.of("task.complete").length + r.of("task.fail").length, 0);
  });
}

test("让路之后当前帧按时做完:照旧做完这一帧再放回(不走超时)", async () => {
  const r = await rig();
  r.node.yieldFor("play");
  r.advance(100);
  r.bakes[0].resolve({ hash: "0".repeat(64), bytes: 1 });
  await flush();
  const rel = r.of("task.release");
  assert.equal(rel.length, 1);
  assert.equal(rel[0].reason, "yield-play");
  assert.equal(r.bakes[0].job.signal.aborted, false, "做完的那一帧没被中止");
  r.advance(YIELD_FRAME_MAX_MS * 2);
  r.node.tick();
  await flush();
  assert.equal(r.of("task.release").length, 1, "不重复放回");
});

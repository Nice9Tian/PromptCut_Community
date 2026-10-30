/**
 * 任务 D（`claude/queue-maint`）页面这一侧：纯浏览器节点报忙（`node.active`，M7 D2 补充〔裁〕）。
 * 队列一侧（锁闲置怎么算、切分方接不接手）见 `server/test/queue-maint-d2-busy.test.mjs`。
 *
 *   QM-D-P1 旧队列（welcome 不带 activeIntervalMs）：忙着也一条不发，行为同改动之前
 *   QM-D-P2 新队列、手里有认领（在生成快照）：按间隔报 busy 'bake'，不比间隔更勤
 *   QM-D-P3 手里没有认领：宿主说后台舞台在忙（'stage'）才报；闲着（null）不报；宿主抛错当不忙
 *   QM-D-P4 下线（stop）、报到被拒之后不再报；重新报到后忙着就在下一拍报
 *
 * 跑：node --test src/online/browserNodeActive.test.mjs
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

test("QM-D-P1 旧队列（node.welcome 不带 activeIntervalMs）：手里有认领、宿主也说忙，一条 node.active 都不发", async () => {
  const r = rig({ welcome: {}, busy: () => "stage" });
  await r.claim();
  assert.equal(r.bakes.length, 1, "第 0 帧在做");
  for (let i = 0; i < 5; i++) { r.advance(EVERY); r.node.tick(); }
  assert.equal(r.of("node.active").length, 0);
  assert.equal(r.node.debug().counters.active, 0);
});

test("QM-D-P2 新队列、手里有认领（在生成快照）：按 activeIntervalMs 报 busy 'bake'，不比间隔更勤", async () => {
  const r = rig();
  await r.claim();
  assert.equal(r.of("node.active").length, 0, "认领之前闲着，不报");
  r.node.tick();
  const first = r.of("node.active");
  assert.deepEqual(first.map((m) => m.busy), ["bake"], "认领之后下一拍就报");
  r.advance(EVERY - 1);
  r.node.tick();
  assert.equal(r.of("node.active").length, 1, "间隔之内不再报");
  r.advance(1);
  r.node.tick();
  r.node.tick();
  assert.equal(r.of("node.active").length, 2, "到了间隔报一次，同一刻不重复");
  assert.equal(r.node.debug().counters.active, 2);
  assert.deepEqual(Object.keys(r.of("node.active")[0]).sort(), ["busy", "type"], "只带 busy，不带认领、指纹之类");
});

test("QM-D-P3 手里没有认领：宿主说后台舞台在忙（'stage'）才报；闲着（null）不报；宿主抛错当不忙", () => {
  let state = null;
  const r = rig({ busy: () => { if (state === "throw") throw new Error("坏了"); return state; } });
  r.node.tick();
  assert.equal(r.of("node.active").length, 0, "闲着不报");
  state = "stage";
  r.node.tick();
  assert.deepEqual(r.of("node.active").map((m) => m.busy), ["stage"]);
  state = null;
  r.advance(EVERY * 3);
  r.node.tick();
  assert.equal(r.of("node.active").length, 1, "不忙了就停报（锁照旧按产出算闲置）");
  state = "throw";
  r.node.tick();
  assert.equal(r.of("node.active").length, 1);
  state = "x".repeat(80);
  r.node.tick();
  assert.equal(r.of("node.active").at(-1).busy.length, 32, "超长的截到 32 字（队列的上限）");
});

test("QM-D-P4 下线（stop）、报到被拒之后不再报；重新报到后忙着就在下一拍报", async () => {
  const r = rig({ busy: () => "stage" });
  r.node.tick();
  assert.equal(r.of("node.active").length, 1);
  // 会话断了重连：新会话的 welcome 之后不等满一个间隔
  r.node.start();
  r.node.receive({ type: "node.welcome", nodeId: "n", resumed: [], lost: [], envFingerprint: FP, activeIntervalMs: EVERY });
  r.node.tick();
  assert.equal(r.of("node.active").length, 2, "重新报到后下一拍就报");
  r.node.stop();
  r.advance(EVERY * 2);
  r.node.tick();
  assert.equal(r.of("node.active").length, 2, "下线之后不报");

  const refused = rig({ welcome: null, busy: () => "stage" });
  refused.node.receive({ type: "error", reason: "forbidden" });
  refused.advance(EVERY);
  refused.node.tick();
  assert.equal(refused.of("node.active").length, 0, "报到被拒不报");
});

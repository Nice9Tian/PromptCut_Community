/**
 * 后台舞台单飞队列的单测(D4 / E0)。跑:node --test src/editor/stageJobs.test.mjs
 *
 * 钉四件事:
 *   1. 真的单飞 —— 两个活不会同时在跑;
 *   2. 优先级 补跑 > 页面侧测量 > 探针,同一档按先来后到;
 *   3. 更急的活进来时,正在跑的那个收到 abort 通知(只是通知,不强杀);
 *   4. `renderAbortAction` 的五条规矩,尤其是 `'project'` 按工作项分岔那一条 ——
 *      它要是判错,三条规则就成环、`settled` 永远发不出去(E0 明写的那个死锁)。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const bridge = await import("./stageBridge.ts");
const jobs = await import("./stageJobs.ts");
const { runBackJob, renderAbortAction, currentBackJob, backJobQueueLength, resetStageJobs, MAX_PROJECT_RESENDS } = jobs;

function fakeClient() {
  return {
    disposed: false,
    roles: [],
    target: {},
    async setRole(role, opts) { this.roles.push(`${role}:${opts?.job ?? "-"}`); return { ok: true }; },
    onEvent() { return () => {}; },
    dispose() { this.disposed = true; },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetStageJobs();
  bridge.resetStageBridge();
});

test("单飞:两个活不会同时在跑", async () => {
  bridge.setStageClient("back", fakeClient());
  let live = 0;
  let maxLive = 0;
  const one = async () => { live++; maxLive = Math.max(maxLive, live); await tick(); live--; return live; };
  await Promise.all([runBackJob("probe", one), runBackJob("probe", one), runBackJob("measure", one)]);
  assert.equal(maxLive, 1);
});

test("优先级:补跑 > 页面侧测量 > 探针;同档按先来后到", async () => {
  bridge.setStageClient("back", fakeClient());
  const order = [];
  // 先占住队列,让后面三个都排上再开跑
  let release;
  const gate = new Promise((r) => { release = r; });
  const head = runBackJob("probe", async () => { order.push("head"); await gate; });
  await tick();

  const p1 = runBackJob("probe", async () => { order.push("probe1"); });
  const p2 = runBackJob("probe", async () => { order.push("probe2"); });
  const m = runBackJob("measure", async () => { order.push("measure"); });
  const c = runBackJob("catchup", async () => { order.push("catchup"); });
  release();
  await Promise.all([head, p1, p2, m, c]);
  assert.deepEqual(order, ["head", "catchup", "measure", "probe1", "probe2"]);
});

test("更急的活进来:正在跑的那个收到 abort 通知,但自己决定什么时候收摊", async () => {
  bridge.setStageClient("back", fakeClient());
  let sawAbort = false;
  let finished = false;
  const slow = runBackJob("probe", async ({ signal }) => {
    for (let i = 0; i < 50 && !signal.aborted; i++) await tick();
    sawAbort = signal.aborted;
    finished = true;
    return "done";
  });
  await tick();
  const quick = runBackJob("catchup", async () => "quick");
  assert.equal(await slow, "done", "abort 只是通知,活照常按自己的结果落定");
  assert.equal(sawAbort, true);
  assert.equal(finished, true);
  assert.equal(await quick, "quick");
});

test("开工前发 setRole,页面侧测量映射到 job: 'catchup';队列空了交还成 'probe'", async () => {
  const c = fakeClient();
  bridge.setStageClient("back", c);
  await runBackJob("measure", async ({ job }) => { assert.equal(job, "catchup"); });
  assert.deepEqual(c.roles, ["back:catchup", "back:probe"]);
  // 同一个工作项不重发:setRole('back') 每次都会清空快照 / 抑制集合
  c.roles.length = 0;
  await runBackJob("probe", async () => {});
  assert.deepEqual(c.roles, [], "队列交还时已经是 probe,不该再发一遍");
});

test("back 换了客户端(K5 互换 / iframe 重载)后,同一个工作项要对新客户端重发一次", async () => {
  const a = fakeClient();
  bridge.setStageClient("back", a);
  await runBackJob("probe", async () => {});
  assert.deepEqual(a.roles, ["back:probe"]);

  // K5 的互换:另一个 iframe 接任 back。新客户端的缺省角色是 front,从没收到过 setRole
  const b = fakeClient();
  bridge.setStageClient("back", b);
  await runBackJob("probe", async () => {});
  assert.deepEqual(b.roles, ["back:probe"], "工作项没变但换了人 —— 不重发的话新 back 会留在 front 角色上");
});

test("legacy 的单舞台(只有 front)不发 setRole —— 发了会把可见舞台的画面清掉", async () => {
  const c = fakeClient();
  bridge.setStageClient("front", c);
  const got = await runBackJob("measure", async ({ stage }) => stage);
  assert.equal(got, c, "backStage() 退回可见舞台");
  assert.deepEqual(c.roles, []);
});

test("舞台还没就绪时排的活,等到就绪才跑", async () => {
  let ran = false;
  const p = runBackJob("measure", async () => { ran = true; return 1; });
  await tick();
  assert.equal(ran, false);
  bridge.setStageClient("back", fakeClient());
  assert.equal(await p, 1);
});

test("run 抛出来的错原样传给调用方,队列照常往下走", async () => {
  bridge.setStageClient("back", fakeClient());
  await assert.rejects(runBackJob("probe", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await runBackJob("probe", async () => "ok"), "ok");
  assert.equal(backJobQueueLength(), 0);
  assert.equal(currentBackJob(), null);
});

test("currentBackJob 报的是正在跑的那个活的 RPC 工作项", async () => {
  bridge.setStageClient("back", fakeClient());
  const seen = [];
  await runBackJob("catchup", async () => { seen.push(currentBackJob()); });
  await runBackJob("probe", async () => { seen.push(currentBackJob()); });
  await runBackJob("measure", async () => { seen.push(currentBackJob()); });
  assert.deepEqual(seen, ["catchup", "probe", "catchup"]);
});

test("renderAbortAction:五种 reason 各一条规矩", () => {
  assert.equal(renderAbortAction("superseded", "probe"), "drop");
  assert.equal(renderAbortAction("superseded", "catchup"), "drop");
  assert.equal(renderAbortAction("timeout", "probe"), "ignore");
  assert.equal(renderAbortAction("role", "probe"), "error");
  assert.equal(renderAbortAction("role", null), "error");
  assert.equal(renderAbortAction("detached", "probe"), "rebind");
});

test("renderAbortAction:'project' 按工作项分岔 —— catchup 期间丢弃,否则重发", () => {
  // 探针被 setProject 掐掉:按当前目标重发
  assert.equal(renderAbortAction("project", "probe"), "resend");
  assert.equal(renderAbortAction("project", null), "resend");
  /*
   * 补跑 / 页面侧测量期间那份 setProject 是这个活自己灌的。重发探针会把补跑掐成
   * 'superseded',而 'superseded' 又不许重发 —— 三条规则成环,settled 永远发不出去。
   */
  assert.equal(renderAbortAction("project", "catchup"), "drop");
  assert.ok(MAX_PROJECT_RESENDS === 3);
});

/**
 * Unit tests for background stage single-flight queue (D4 / E0).
 * Run: node --test src/editor/stageJobs.test.mjs
 *
 * Pin down four things:
 *   1. Truly single-flight: two jobs will not run at the same time;
 *   2. Priority: catch-up run > page-side measurement > probe, within the same tier by FIFO;
 *   3. When a more urgent job arrives, the currently running one receives an abort notice (notice
 *      only, no hard kill);
 *   4. The five rules of `renderAbortAction`, especially the one branching `'project'` by work
 *      item: if it decides incorrectly, the three rules form a loop, and `settled` will never be
 *      sent (the deadlock explicitly described in E0).
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

test("Single-flight: two jobs never run at the same time", async () => {
  bridge.setStageClient("back", fakeClient());
  let live = 0;
  let maxLive = 0;
  const one = async () => { live++; maxLive = Math.max(maxLive, live); await tick(); live--; return live; };
  await Promise.all([runBackJob("probe", one), runBackJob("probe", one), runBackJob("measure", one)]);
  assert.equal(maxLive, 1);
});

test("Priority: catch-up run > page-side measurement > probe; within the same tier, first come, first served", async () => {
  bridge.setStageClient("back", fakeClient());
  const order = [];
  // Occupy the queue first so the next three all queue up before starting to run
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

test("A more urgent job comes in: the running one receives an abort notice but decides for itself when to wrap up", async () => {
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
  assert.equal(await slow, "done", "abort is only a notice; the job still settles with its own result as usual");
  assert.equal(sawAbort, true);
  assert.equal(finished, true);
  assert.equal(await quick, "quick");
});

test("Send setRole before starting; page-side measurement maps to job: 'catchup'; when the queue is empty it is handed back as 'probe'", async () => {
  const c = fakeClient();
  bridge.setStageClient("back", c);
  await runBackJob("measure", async ({ job }) => { assert.equal(job, "catchup"); });
  assert.deepEqual(c.roles, ["back:catchup", "back:probe"]);
  // Do not resend for the same work item: setRole('back') clears snapshots / suppression set every time
  c.roles.length = 0;
  await runBackJob("probe", async () => {});
  assert.deepEqual(c.roles, [], "When the queue hands back, the role is already probe and must not be sent again");
});

test("After back changes client (K5 swap / iframe reload), the same work item must be resent once to the new client", async () => {
  const a = fakeClient();
  bridge.setStageClient("back", a);
  await runBackJob("probe", async () => {});
  assert.deepEqual(a.roles, ["back:probe"]);

  // K5 swap: another iframe takes over back. New client's default role is front, never received setRole
  const b = fakeClient();
  bridge.setStageClient("back", b);
  await runBackJob("probe", async () => {});
  assert.deepEqual(b.roles, ["back:probe"], "The work item is unchanged but the occupant changed: without a resend the new back would stay in the front role");
});

test("A legacy single stage (front only) does not send setRole, because sending it would clear the visible stage's picture", async () => {
  const c = fakeClient();
  bridge.setStageClient("front", c);
  const got = await runBackJob("measure", async ({ stage }) => stage);
  assert.equal(got, c, "backStage() falls back to the visible stage");
  assert.deepEqual(c.roles, []);
});

test("A job queued while the stage is not ready yet runs only when it is ready", async () => {
  let ran = false;
  const p = runBackJob("measure", async () => { ran = true; return 1; });
  await tick();
  assert.equal(ran, false);
  bridge.setStageClient("back", fakeClient());
  assert.equal(await p, 1);
});

test("An error thrown by run is passed to the caller as is, and the queue carries on as usual", async () => {
  bridge.setStageClient("back", fakeClient());
  await assert.rejects(runBackJob("probe", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await runBackJob("probe", async () => "ok"), "ok");
  assert.equal(backJobQueueLength(), 0);
  assert.equal(currentBackJob(), null);
});

test("currentBackJob reports the RPC work item of the job that is running", async () => {
  bridge.setStageClient("back", fakeClient());
  const seen = [];
  await runBackJob("catchup", async () => { seen.push(currentBackJob()); });
  await runBackJob("probe", async () => { seen.push(currentBackJob()); });
  await runBackJob("measure", async () => { seen.push(currentBackJob()); });
  assert.deepEqual(seen, ["catchup", "probe", "catchup"]);
});

test("renderAbortAction: one rule for each of the five reasons", () => {
  assert.equal(renderAbortAction("superseded", "probe"), "drop");
  assert.equal(renderAbortAction("superseded", "catchup"), "drop");
  assert.equal(renderAbortAction("timeout", "probe"), "ignore");
  assert.equal(renderAbortAction("role", "probe"), "error");
  assert.equal(renderAbortAction("role", null), "error");
  assert.equal(renderAbortAction("detached", "probe"), "rebind");
});

test("renderAbortAction: 'project' branches by work item: discarded during catchup, otherwise resent", () => {
  // Probe aborted by setProject: resend for current target
  assert.equal(renderAbortAction("project", "probe"), "resend");
  assert.equal(renderAbortAction("project", null), "resend");
  /*
   * During catch-up run / page-side measurement, that setProject was fed by this job itself.
   * Resending probe cuts off the catch-up run into 'superseded', and 'superseded' is not allowed to
   * resend: the three rules form a loop, and settled is never sent.
   */
  assert.equal(renderAbortAction("project", "catchup"), "drop");
  assert.ok(MAX_PROJECT_RESENDS === 3);
});

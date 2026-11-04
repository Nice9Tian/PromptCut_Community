// Explicit .ts suffix: unit tests import these two modules directly in node (see stageJobs.test.mjs)
import { backRole, backStage, whenStageReady } from "./stageBridge.ts";
import type { BackJob, RenderAborted, StageRpcClient } from "../render/stageRpc.ts";

/**
 * The background stage's **single-flight queue** (D4 / E0).
 *
 * The background stage's project has three kinds of occupants, and there is only one stage:
 *   - **Catch-up run** (`catchup`): K5's second-path whole-scene catch-up run, and K3(b)'s retry path.
 *     The user has stopped and is waiting for the picture, so it is the most urgent;
 *   - **Page-side measurement** (`measure`): D4's `measureContentBoxes` -- the Agent or the right
 *     rail's positioning tool is waiting for a solid box, which is an interaction;
 *   - **Probe** (`probe`): K1's real measurement. It is background work and can be re-queued from
 *     the head of this card at any time.
 * The priority is exactly this order: **catch-up run > page-side measurement > probe**. Within the
 * same priority, first come, first served.
 *
 * M7 (contract section 4.3) adds a fourth, the least urgent: **generate snapshots** (`bake`) -- the
 * background stage of the online dual stage doubles as a browser-only node, generating snapshots
 * frame by frame for the snapshot tasks it has claimed (the job is the `'bake'` that J4 reserved
 * early). It queues behind the probe; when more urgent work arrives it still receives an abort
 * notification, and the browser-only node puts the task back after finishing the current frame (D8).
 *
 * Before each job starts, it first sends `setRole('back', { job })` to switch the background stage to
 * this job --
 * **E0's "no resend after cut off" exception is decided by job, not by the `settling` flag**: while
 * `job: 'catchup'`, any received `{ aborted: true, reason: 'project' }` is discarded (that
 * `setProject` was loaded by this very job), and only one received during `job: 'probe'` is resent
 * toward the current target. See `renderAbortAction` for the criteria.
 * When the queue empties, the job is handed back as `'probe'` (E0: "after `settled` or a catch-up run
 * abort, send `setRole('back', { job: 'probe' })`, and the probe re-queues from the head of the
 * current card").
 *
 * **R2 only puts in the queue itself**: the only thing queued is D4's page-side measurement. R4's
 * probe and R5's catch-up run will queue work into it later, without touching this module again.
 *
 * The legacy single stage has no real `back` (`backRole()` returns `'front'`), and then **`setRole` is
 * not sent** -- switching the visible stage to `back` would clear its snapshots / suppression set and
 * stop its beat loop, and the picture in front of the user would be gone.
 * The queue itself still serializes as usual, with the same behavior as today's "measure once on the
 * only stage directly".
 */

/** Work in the queue comes in three kinds; the smaller the number, the more urgent */
export type BackJobKind = "catchup" | "measure" | "probe" | "bake";

const PRIORITY: Record<BackJobKind, number> = { catchup: 0, measure: 1, probe: 2, bake: 3 };

/**
 * The three kinds of work in the queue map onto the RPC's job enum (J4: `'probe' | 'catchup' | 'bake'`).
 *
 * **Page-side measurement maps to `'catchup'` rather than opening a new enum value**: D4 states
 * explicitly "when a measurement starts, first `setRole('back', { job: 'catchup' })`", and E0's
 * exception also lists "D4's page-side measurement" alongside the catch-up run under `job: 'catchup'`.
 * A measurement wants exactly the catch-up run's semantics (the probe is suspended, and a
 * `'project'` cut off by its own loaded project is not resent), so there is no need to give the stage
 * a fourth enum value whose difference it cannot tell apart.
 * The queue side still has three tiers, because the **priority** must differ (catch-up run >
 * measurement).
 */
const RPC_JOB: Record<BackJobKind, BackJob> = { catchup: "catchup", measure: "catchup", probe: "probe", bake: "bake" };

/** Upper limit of resends toward the current target after a `'project'` cut-off (E0: beyond it, report an error, and the clip falls back to dispatch by declaration) */
export const MAX_PROJECT_RESENDS = 3;

/** What the parent page should do when it receives an abort reply for a `render` (E0 fixed the rules for the five reasons one by one) */
export type RenderAbortAction =
  /** Discard, do not resend -- resending would only cut off the new one again, or cut off itself */
  | "drop"
  /** Resend toward the current target (at most MAX_PROJECT_RESENDS times) */
  | "resend"
  /** Discard the reply, and resend the current target to the **new** client (the iframe was replaced) */
  | "rebind"
  /** Neither resend nor treat as an error: K1 probe's cap, the parent page extrapolates catchUpMs from the frames already pushed */
  | "ignore"
  /** Treat as an error, do not resend */
  | "error";

/**
 * @param reason `RenderAborted.reason`
 * @param job    the background stage's current job (`currentBackJob()`); null when nothing is running
 */
export function renderAbortAction(reason: RenderAborted["reason"], job: BackJob | null): RenderAbortAction {
  switch (reason) {
    case "superseded":
      // Cut off by the parent page's own new render; resending would cut off the new one again
      return "drop";
    case "project":
      /*
       * The only one that forks by job. While `job: 'catchup'`, that `setProject` was loaded by this job
       * itself (the catch-up run's full project / the measurement's full project); resending the probe
       * would cut it off as 'superseded', and 'superseded' is not allowed to resend -- the three rules form
       * a cycle, and `settled` can never be sent.
       */
      return job === "catchup" ? "drop" : "resend";
    case "timeout":
      // Truncated ≠ capped: capped is decided only by stepMs > B
      return "ignore";
    case "role":
      // The resend still uses the same role
      return "error";
    case "detached":
      return "rebind";
  }
}

export interface BackJobContext {
  /** Who to talk to this time. With the legacy single stage, it is the visible stage */
  stage: StageRpcClient;
  /** More urgent work has arrived: the one running wraps up on its own (not killed by force, so it can clean up its state) */
  signal: AbortSignal;
  kind: BackJobKind;
  /** The job sent to the stage this time; with the legacy single stage, setRole was never sent, so this is meaningless */
  job: BackJob;
}

interface QueueItem {
  kind: BackJobKind;
  seq: number;
  run: (ctx: BackJobContext) => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

let seqNo = 0;
const queue: QueueItem[] = [];
let running: { item: QueueItem; abort: AbortController } | null = null;
let pumping = false;

/** Which job the background stage is doing right now; null when nothing is running */
export function currentBackJob(): BackJob | null {
  return running ? RPC_JOB[running.item.kind] : null;
}

/** How many jobs are queued ahead (including the running one); for acceptance checks and debugging */
export function backJobQueueLength(): number {
  return queue.length + (running ? 1 : 0);
}

/**
 * How many jobs are more urgent than generate snapshots (queued plus running, not counting `bake`
 * itself). One of the criteria for a browser-only node being "idle" (M7 contract section 2):
 * when the single-flight queue holds a catch-up run, measurement, or probe, it does not claim new
 * tasks.
 */
export function urgentBackJobs(): number {
  let n = queue.filter((item) => item.kind !== "bake").length;
  if (running && running.item.kind !== "bake") n++;
  return n;
}

/** Take the next one to run: the earliest queued in the highest priority tier */
function takeNext(): QueueItem | null {
  if (!queue.length) return null;
  let best = 0;
  for (let i = 1; i < queue.length; i++) {
    const a = queue[i];
    const b = queue[best];
    if (PRIORITY[a.kind] < PRIORITY[b.kind] || (PRIORITY[a.kind] === PRIORITY[b.kind] && a.seq < b.seq)) best = i;
  }
  return queue.splice(best, 1)[0];
}

async function resolveStage(): Promise<StageRpcClient> {
  const now = backStage();
  if (now) return now;
  /*
   * No stage yet. Wait on both positions: after E1 the one that comes is `back`, the legacy single stage
   * only ever has `front`, and `backStage()` falls back to `front` for legacy. Use whichever is ready
   * first.
   */
  return await Promise.race([whenStageReady("back"), whenStageReady("front")]);
}

/**
 * Send the job to the background stage. **The same job on the same client is not resent** --
 * `setRole('back')` clears the snapshots / suppression / stream plane every time and aborts frame
 * catch-up (E0), so a redundant send is a redundant clear.
 * The legacy single stage is not sent to (see the file header).
 *
 * **What is recorded is "which client + which job", not just the job** (R7): the client at the `back`
 * position can change -- K5's swap lets the other iframe take over `back`, and an iframe reload also
 * brings a new client. If only the job were recorded, the new client has never received `setRole`
 * (its default role is `front`), yet here the send would be skipped because "the job hasn't changed",
 * so the new `back` would stay in the `front` role: it doesn't accept `render` (replies with
 * `reason: 'role'`) and doesn't follow `back`'s rules either, and the probe and catch-up run stall.
 * Once the client identity is included, a change of client is necessarily unequal to the previous
 * record, so it is always resent once.
 */
let lastSent: { client: StageRpcClient; job: BackJob } | null = null;
async function sendJob(stage: StageRpcClient | null, job: BackJob): Promise<void> {
  if (!stage) return;
  if (backRole() !== "back" && job !== "bake") return;
  if (lastSent && lastSent.client === stage && lastSent.job === job) return;
  try {
    await stage.setRole("back", { job });
    if (backRole() === "back") lastSent = { client: stage, job };
  } catch {
    // The iframe is being replaced: it will be resent when the next job starts
    lastSent = null;
  }
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const item = takeNext();
      if (!item) {
        /*
         * The queue is empty, hand the job back as 'probe' (E0): the probe re-queues from the head of the
         * current card.
         * Before R4 no probe was queued, so this line only puts the state back to the default tier and does
         * not actually start anything.
         * This step is an await, during which more work may be queued -- so the queue must be checked once
         * more before wrapping up.
         */
        await sendJob(backStage(), "probe");
        if (queue.length) continue;
        break;
      }
      const abort = new AbortController();
      running = { item, abort };
      try {
        const stage = await resolveStage();
        const job = RPC_JOB[item.kind];
        await sendJob(stage, job);
        item.resolve(await item.run({ stage, signal: abort.signal, kind: item.kind, job }));
      } catch (err) {
        item.reject(err);
      } finally {
        running = null;
      }
    }
  } finally {
    pumping = false;
  }
}

/**
 * Queue a job. Returns the return value of `run`; whatever `run` throws is thrown here.
 *
 * When more urgent work is queued, the running one receives an abort on `ctx.signal` -- **a
 * notification only, not a forced kill**:
 * `run` decides for itself when to wrap up (the probe exits in the `abort` callback of the next
 * `render`), and a job that ignores the signal still runs to completion, only making the ones behind
 * it wait a little longer.
 */
export function runBackJob<T>(kind: BackJobKind, run: (ctx: BackJobContext) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ kind, seq: seqNo++, run: run as (ctx: BackJobContext) => Promise<unknown>, resolve: resolve as (v: unknown) => void, reject });
    if (running && PRIORITY[kind] < PRIORITY[running.item.kind]) running.abort.abort();
    void pump();
  });
}

/** For tests: clear the queue (the running one receives abort, but its Promise settles as usual according to the result of run) */
export function resetStageJobs(): void {
  queue.length = 0;
  running?.abort.abort();
  seqNo = 0;
  lastSent = null;
}

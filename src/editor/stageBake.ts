/**
 * The "job" in which a browser-only node generates snapshots on the background stage, and the
 * per-frame stage round trip (M7 contract section 4.3; split out of `browserNodeHost.ts`,
 * `claude/queue-maint` task F: the good part is that Node can run the stage-swap script without
 * starting a browser, see `stageBake.test.mjs`).
 *
 * The first half of a frame on the host (`browserNodeHost.ts`) lives here:
 *
 *   - **Job (lease)**: for the first frame of a small task segment that has been claimed, queue a
 *     `bake` job in the single-flight queue (lowest priority: rerun > measurement > probe >
 *     generate snapshots). Work starts only once the background stage is acquired. When the segment
 *     ends (done, failed, released, or claim lost) the host calls `close()` to hand it back. When a
 *     more urgent job is queued, the single-flight queue aborts this job and this module forwards
 *     that to `onUrgent()`; the node releases the segment after finishing the current frame (D8).
 *   - **Check the background position before each frame**: after a stage swap (K5) or an iframe
 *     reload, someone else may occupy the background position (`backStage()` is no longer the one
 *     this job recorded). In that case, switch to the new background stage, reload the isolated
 *     single-card project of this segment onto it in full (`pushProject('back', …, { reset })`),
 *     and then send the frame. Which frames are done is recorded in the node (the done frames in
 *     `browserNode.ts`), so a reopened job only fills in the missing frames.
 *   - **Send the next frame first when advancing sequentially**: the network round trip that pushes
 *     to the asset service runs in parallel with the stage pushing the next frame. The reply for
 *     the next frame is used only if the node actually asks for it and the stage is still the same.
 *   - **Stage changed mid-frame** (added by this module, found by the task F script): a swap or
 *     reload happens while a frame is in flight, so the old stage is no longer the background and
 *     replies `cancelled` / `role`, or the frame finished but its `bake-frame` event arrived after
 *     the swap and was filtered out by role in `stageBridge`. Previously this segment was handed
 *     back as a retryable failure (counted as one failure, and three failures move it to failed).
 *     Now, whenever the background position really did change hands, the frame is reloaded and
 *     redone on the new background stage (at most `SWAP_REDO_MAX` times per frame) without counting
 *     a failure. If the background position did not change hands, it is handed back as a failure
 *     as before.
 *
 * The stage, the single-flight queue and the events are all injected through `deps` (the host
 * passes the real functions of `stageJobs` / `stageBridge`; the script passes the same real
 * functions with a fake stage).
 */
import { bakeFrameBase, bakeInputOf, isolatedBakeProject, type BakeInput } from "../online/bakeTask.ts";
import type { Project } from "../kernel/project";
import type { BakeFrameReply, StageEvent, StageRpcClient } from "../render/stageRpc.ts";
import type { NodeTask } from "../online/browserNode.ts";
import { tr } from "../i18n/index.ts";

export type BakeFrameEvent = Extract<StageEvent, { type: "bake-frame" }>;
export type BakeFrameOk = Extract<BakeFrameReply, { ok: true }>;

/** The maximum number of times to redo a frame on the new stage when the background position changes hands mid-frame (tier-3 number) */
export const SWAP_REDO_MAX = 2;

/** Reasons in the reply of generating snapshots that are not retryable: doing it again gives the same result */
const FINAL_REASONS = new Set(["lossy", "no-clip", "no-control", "frame-mismatch", "unsupported"]);
/** The reason replied when the old stage is no longer the background (`bakeFrame` of `StageView.tsx`): redo when the background position changes hands, not counted as a failure */
const SWAPPED_REASONS = new Set(["cancelled", "role", "no-project"]);

export interface StageBakerDeps {
  /** Single-flight queue (`runBackJob` of `stageJobs.ts`) */
  runBackJob: (kind: "bake", run: (ctx: { stage: StageRpcClient; signal: AbortSignal }) => Promise<void>) => Promise<unknown>;
  /** The current background stage (`backStage` of `stageBridge.ts`) */
  backStage: () => StageRpcClient | null;
  /** Push the project onto the background stage (`pushProject` of `stageBridge.ts`) */
  pushProject: (role: "back", project: Project, opts: { reset?: boolean }) => Promise<void>;
  /** Stage events (already filtered by role; `onStageEvent` of `stageBridge.ts`) */
  onStageEvent: (listener: (e: StageEvent) => void) => () => void;
  /** A more urgent background job has come (the single-flight queue aborted this job): the node releases it after finishing the current frame */
  onUrgent: () => void;
  /** Whether idle: send the next frame first only when idle */
  isIdle: () => boolean;
  /** Frame push basis */
  mode: "batch4" | "seq";
  /** Whether to produce the small prerender size (default yes) */
  small?: boolean;
  now?: () => number;
  /** Time breakdown per frame (opening the job and reseeding the project `lease`, stage round trip `rpc`) */
  notePhase?: (k: "lease" | "rpc", ms: number) => void;
  /** Reasons the stage replied "not ok" (diagnostic counts) */
  noteError?: (reason: string) => void;
}

export interface StageBakeResult {
  reply: BakeFrameOk;
  event: BakeFrameEvent;
  /** Which stage this frame actually came from */
  stage: StageRpcClient;
}

export interface StageBakerDiag {
  /** How many times this segment's job switched stages (found changed when checking before a frame, or changed mid-frame) */
  restages: number;
  /** Number of times a frame was redone on the new stage after someone swapped in mid-frame */
  redos: number;
  /** Number of times the isolated single-card project was reseeded */
  pushes: number;
}

export interface StageBaker {
  /** `ahead`: the frame sent to the stage first after this frame is done (local frame number); if not given it is the next frame, null means do not send ahead */
  bakeFrame(job: { task: NodeTask; project: unknown; localFrame: number; signal: AbortSignal; ahead?: number | null }): Promise<StageBakeResult>;
  /** Hand back this segment's job (stop the frame being pushed, clear the continuation point of sequential push) */
  close(): void;
  /** Unsubscribe from stage events (when the host unmounts) */
  dispose(): void;
  readonly leaseTaskId: string | null;
  diag(): StageBakerDiag;
}

/** The "job" of this segment: the `bake` job in the single-flight queue, handed back when the segment ends */
interface Lease {
  taskId: string;
  isolated: Project;
  input: BakeInput;
  /** For a card inside a cut segment: which project frame local frame 0 is (`bakeFrameBase`, [ruling] R02); null for a top-level card */
  frameBase: number | null;
  stage: StageRpcClient;
  /** Whether this stage has been reseeded with this segment's isolated single-card project */
  pushedTo: StageRpcClient | null;
  /** The next frame already sent to the stage ahead of time */
  ahead: { frame: number; stage: StageRpcClient; reply: Promise<BakeFrameReply> } | null;
  close: () => void;
}

const retryable = (message: string, value: boolean) => Object.assign(new Error(message), { retryable: value });

export function createStageBaker(deps: StageBakerDeps): StageBaker {
  const now = deps.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const small = deps.small !== false;
  let lease: Lease | null = null;
  const stats: StageBakerDiag = { restages: 0, redos: 0, pushes: 0 };
  /** `bake-frame` sent by the stage: session id + local frame → event */
  const bakeEvents = new Map<string, BakeFrameEvent>();
  const off = deps.onStageEvent((e) => {
    if (e.type !== "bake-frame") return;
    bakeEvents.set(`${e.session}#${e.localFrame}`, e);
    if (bakeEvents.size > 16) bakeEvents.delete(bakeEvents.keys().next().value as string);
  });

  const close = () => {
    const l = lease;
    lease = null;
    if (!l) return;
    try { void l.stage.bakeCancel().catch(() => {}); } catch { /* Stage swapped */ }
    l.close();
  };

  /** Open this segment's job: queue it in the single-flight queue (least urgent), and return only after getting the background stage */
  const openLease = (task: NodeTask, project: unknown): Promise<Lease> => {
    const input = bakeInputOf(task);
    if (!input) return Promise.reject(retryable(tr("Task has no input.bake / clipId (the splitter didn't pass the browser its share of the parameters)"), false));
    let isolated: Project;
    // Top-level card: isolated single-card project; card inside a cut segment: isolated project carrying the cut segment chain (`isolatedBakeProject`)
    try { isolated = isolatedBakeProject(project as Project, input) as Project; } catch (e) { return Promise.reject(Object.assign(e as Error, { retryable: false })); }
    const frameBase = bakeFrameBase(input);
    return new Promise<Lease>((resolve, reject) => {
      let got = false;
      void deps.runBackJob("bake", async (ctx) => {
        let release!: () => void;
        const done = new Promise<void>((r) => { release = r; });
        const l: Lease = { taskId: task.id, isolated, input, frameBase, stage: ctx.stage, pushedTo: null, ahead: null, close: () => release() };
        // A more urgent job has come (rerun, measurement, probe): release after the current frame is done (D8)
        ctx.signal.addEventListener("abort", () => { deps.onUrgent(); }, { once: true });
        got = true;
        resolve(l);
        await done;
      }).catch((e) => { if (!got) reject(e); });
    });
  };

  /** Check the background position before each frame: if someone else is there, switch to the new background stage (the isolated single-card project must be reseeded, and the frame sent ahead is void) */
  const followBack = (l: Lease) => {
    const cur = deps.backStage();
    if (cur && cur !== l.stage) { l.stage = cur; l.pushedTo = null; l.ahead = null; stats.restages++; }
  };

  async function bakeFrame({ task, localFrame, project, signal, ahead: aheadFrame }: { task: NodeTask; project: unknown; localFrame: number; signal: AbortSignal; ahead?: number | null }): Promise<StageBakeResult> {
    const t0 = now();
    if (!lease || lease.taskId !== task.id) {
      close();
      const l = await openLease(task, project);
      if (signal.aborted) { l.close(); throw retryable(tr("Aborted"), true); }
      lease = l;
    }
    const l = lease;
    const session = task.id;
    for (let redo = 0; ; redo++) {
      // After a stage swap or iframe reload, someone else is in the background position: reopen on the new background stage (which frame was done is recorded in the node)
      followBack(l);
      const stage = l.stage;
      if (l.pushedTo !== stage) {
        await deps.pushProject("back", l.isolated, { reset: true });
        l.pushedTo = stage;
        stats.pushes++;
      }
      const tRpc = now();
      if (redo === 0) deps.notePhase?.("lease", tRpc - t0);
      const onAbort = () => { void stage.bakeCancel().catch(() => {}); };
      signal.addEventListener("abort", onAbort, { once: true });
      // The frame already sent to the stage ahead of time when the previous frame pushed both tiers: just wait for its reply; if it does not match (frame skipped, stage changed), send as usual, and the new frame voids the one in flight
      const ahead = l.ahead;
      l.ahead = null;
      let reply: BakeFrameReply;
      try {
        reply = ahead && ahead.frame === localFrame && ahead.stage === stage
          ? await ahead.reply
          : await stage.bakeFrame({ session, clipId: l.input.clipId, localFrame, mode: deps.mode, small, ...(l.frameBase !== null ? { frameBase: l.frameBase } : {}) });
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      deps.notePhase?.("rpc", now() - tRpc);
      // Background position changed hands mid-frame: the old stage replies cancelled / role, or it finished but the event was filtered out by role: redo on the new stage, not counted as a failure
      const moved = () => { const cur = deps.backStage(); return !!cur && cur !== stage && lease === l && !signal.aborted; };
      if (!reply.ok && SWAPPED_REASONS.has(reply.reason) && redo < SWAP_REDO_MAX && moved()) { stats.redos++; continue; }
      /*
       * Send the next frame first (when pushing sequentially): pushing to the asset service is a network round trip
       * (on online sites at least one `GET chunks` per chunk), and the stage is in another process;
       * the two run in parallel, so the time per frame drops from "stage + round trip" to the larger of the two.
       * This frame still returns only after both tiers are pushed successfully (c10a section 9);
       * the reply of the next frame is used only when the node really asks for it. On yielding, releasing or losing
       * the claim, the `bakeCancel` of `close` stops it at a frame boundary.
       * Do not send ahead when not idle (must yield) or already aborted.
       */
      const range = task.range;
      // Which frame to send first: by default the next frame; if the caller gives `ahead`, follow it (a sparse pass takes only the first frame of each segment, so what is sent first is the first frame of the next segment; null = do not send ahead)
      const next = aheadFrame === undefined ? localFrame + 1 : aheadFrame;
      if (reply.ok && deps.mode === "seq" && range && next !== null && Number.isInteger(next) && next > localFrame && next <= range.to && !signal.aborted && deps.isIdle() && lease === l && !moved()) {
        const p = stage.bakeFrame({ session, clipId: l.input.clipId, localFrame: next, mode: deps.mode, small, ...(l.frameBase !== null ? { frameBase: l.frameBase } : {}) })
          .catch((e): BakeFrameReply => ({ ok: false, reason: "cancelled", detail: String((e as Error)?.message ?? e).slice(0, 200) }));
        l.ahead = { frame: next, stage, reply: p };
      }
      if (!reply.ok) {
        deps.noteError?.(reply.reason);
        // Not retryable: doing it again gives the same result. `not-ready` (readiness gate timeout) is handed back as retryable, same as how desktop waitFrameReady handles a thrown error
        if (reply.reason === "role" || reply.reason === "no-project") l.pushedTo = null;
        throw retryable(tr("Generate snapshots failed: {0}{1}", reply.reason, reply.detail ? `(${reply.detail})` : ""), !FINAL_REASONS.has(reply.reason));
      }
      const ev = bakeEvents.get(`${session}#${localFrame}`);
      bakeEvents.delete(`${session}#${localFrame}`);
      if (!ev || ev.hash !== reply.hash) {
        if (redo < SWAP_REDO_MAX && moved()) { l.ahead = null; stats.redos++; continue; }
        throw retryable(tr("Stage bake-frame event did not arrive"), true);
      }
      return { reply, event: ev, stage };
    }
  }

  return {
    bakeFrame,
    close,
    dispose: () => { close(); off(); },
    get leaseTaskId() { return lease?.taskId ?? null; },
    diag: () => ({ ...stats }),
  };
}

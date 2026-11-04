/**
 * Host of the pure-browser render node of the online page (M7 contract `docs/plan/m7-contract.md`,
 * sections 2, 4, 5 and 7): wires the arrangement in `src/online/browserNode.ts` to this page's
 * connection, stages, asset service, in-page snapshot store and UI state.
 *
 * # When to act as a node (section 2)
 *
 * Every `HOST_TICK_MS` it evaluates `browserNodeEligibility` (online build with an embedded code
 * version, identity is computer, not the lowest tier, both cross-origin stages have handshaken,
 * Chromium, connected to a cloud project as a member, measurement settled). When it holds, it opens
 * the render connection and acts as a node; when it does not (fell back to a single stage, left the
 * project, ...) it releases everything and ends the session.
 * A page whose identity is mobile, or that has only one stage, does not act as a queue node, but still
 * opens the render connection to check in and get the fingerprint, only to produce sparse versions
 * for this page (user decision, 2026-10-14); the lowest tier does neither.
 * After being kicked (4003), the project being deleted (4004), or a rejected check-in (`forbidden` /
 * `not-chromium` / `bad-message`), this page no longer acts as a node.
 *
 * # Render connection and ticket (section 5)
 *
 * The parent page opens it (not inside a stage: stages swap roles), at the same address as the page
 * connection. For every session it creates, it signs a fresh
 * `auth.ticket { kind: 'conn', role: 'render', owner: { kind: 'browser' } }` (2 minutes) on the page
 * connection, subprotocol `promptcut.ticket.<ticket>`;
 * session layer `createDocEndpoint`: if the transport drops within the retention period it resumes
 * without resending credentials; a new session checks in inside `onOpen` (the node's `start()`, with
 * the claims it holds).
 * The ticket never goes into addresses, logs or diagnostics.
 *
 * # Idle criteria and yielding (section 2, D8)
 *
 * `isIdle()` (decided by the parent page, not the stages): the gate for background work is open (page
 * visible, parent page rAF not stalled, parent page rIC calling back, `backWorkGate`), not playing,
 * not dragging, `INTERACTION_QUIET_MS` has passed since the last playback or drag, no more urgent
 * job in the single-flight queue (catch-up, measurement, probe), and a background stage exists.
 * Yielding: playback starts → `yieldFor('play')`, drag starts → `'drag'` (release after the current
 * frame is done); a more urgent background job arrives (the single-flight job that generates
 * snapshots receives abort) → `'urgent'`; page hidden or parent page rAF stalled → `'hidden'` (do not
 * wait for the current frame, release immediately).
 *
 * # Reporting busy (M7 D2 addendum [ruling], `claude/queue-maint`)
 *
 * When it holds no claim and the single-flight queue has a more urgent background job (catch-up,
 * measurement, probe), `busy()` returns `'stage'`, and the node accordingly sends `node.active` at
 * the interval given by the queue, so the cards it has locked are not taken over by another node just
 * because the page is busy. When the page is hidden or the parent page rAF is stalled it returns null
 * (background work is paused then, and the locks are still counted as idle by output).
 *
 * # One frame (sections 4.3 to 4.5, D3, D5, D7)
 *
 * On the first frame it is claimed, it opens a single-flight job `bake` (least urgent), loads the
 * isolated single-card project into the background stage with `pushProject('back', isolated
 * single-card project, { reset })` (through the baseline of stageBridge), then calls `bakeFrame`
 * frame by frame; the stage's `bake-frame` event brings back the baked HTML and a small WebP.
 * Parent page: decompress → push to the asset service (`snap`, `px`, D7 parent page pushes) → chunks
 * go into the in-page snapshot store (`snap/<hash>`, `px/<hash>`), and the `ranges` of this layer
 * record this frame (written means ready, notify the online source).
 * The two tiers are pushed in parallel; while pushing, it first sends the next frame to the stage
 * (sequential push, when still idle), and each frame's time is the larger of "one stage frame" and
 * "the network round trip of pushing both tiers", not their sum.
 * Once the whole range is complete it assembles the manifest (same shape as desktop
 * `collectSnapshotResult`), writes the content store (failure is only logged as a diagnostic), and
 * sends `task.complete { ranges, ...manifest }`.
 * When this range ends (done, failed, released, claim lost) it hands the background stage back.
 *
 * # A stream task (`docs/plan/browser-stream-task.md`, part 4)
 *
 * Whether it can produce streams: once, for the current project's aspect ratio and frame rate, it
 * asks the browser's built-in encoder (`probeStreamEncoder`, using the size of the whole composed
 * picture); only if it can compress does it report the capability bit as true; if the aspect ratio or
 * frame rate changes it asks again. A claimed stream task (the share of single-card streams that the
 * splitter gives to the browser) is done entirely in `bakeStream`:
 *
 *   the same single-flight job `bake` and the same isolated single-card project (`input.bake`) are
 *   loaded into the background stage → for every segment of 15 frames in the task range: global frame
 *   number minus `firstFrame` gives the local frame; for frames outside the card's range it sends a
 *   fully transparent canvas; for frames inside the range it asks the stage via `bakeFrame` for pixels
 *   (`pixels: { rect: bound }`, no HTML, no small version), feeds the bitmap into
 *   `openStreamEncoder` and closes it after use → it computes sha256 for the header file and for every
 *   full segment, and pushes the pixel kind (`px`) to the asset service →
 *   once all segments are complete it assembles the manifest (`streamManifest`, same shape as desktop
 *   `collectStreamResult`), writes the content store `render-manifest` (key
 *   `<result key>:<start>-<end>`), then reports completion.
 *
 * The stage round trip reuses the set of `stageBake.ts` (check the background position before every
 * frame, reload and redo if the stage changed hands midway, send the next frame first on sequential
 * push), with another instance that does not produce small versions, and a thin wrapper that adds
 * "ask for pixels" to the `bakeFrame` requests it sends; bitmaps are stored separately here and
 * closed after use or when this range ends.
 * Yielding: before every frame it checks whether the node should yield; if so, it flushes the
 * segments in the encoder that are already full (the unfilled one is dropped) and releases; segments
 * already pushed are kept by task id, and reclaiming the same range only fills in the missing
 * segments. On abort (page hidden, claim lost) it closes the encoder directly.
 *
 * # Page-produced streams (task brief `render-refactor-task.md`, "Part A2"; criteria and order in `src/online/pageStreams.ts`)
 *
 * When no splittable node online takes this page's manifest plan, this page itself produces the
 * single-card streams in the manifest that it can, without going through the task queue: the stream
 * plan is computed by `pageStreamPlan.ts` from the confirmed project of that version (the keys are
 * the same as those the splitter computes), each segment is assembled into a task in the shape of
 * such a stream task in the queue and handed to the same `bakeStream` above (the same job, the same
 * encoder, the same registry of "segments already pushed"), and the manifest is likewise written to
 * the content store; this page merges its own row of the layer table in. Checking first, yielding,
 * and stopping when a splitter takes the job are all in `pageStreams.ts`.
 * The two paths share the same job on the background stage: while this page is producing, the node
 * does not claim (one more condition in `isIdle`), and while the node holds a claim, this page does
 * not produce.
 * Each stream first produces a sparse pass (only the first frame of every segment is captured), and
 * density is filled in only after the sparse versions of all streams have settled.
 *
 * # Produce sparse versions during measurement (`docs/semantics/mechanism/rendering.md`, "Measurement"; order and the 50-second cap in `measure()` of `pageStreams.ts`)
 *
 * With the project open and under the loading mask, every time the measurer (`probeRunner.ts`)
 * finishes measuring a card, it calls the hook wired in here: if this card is judged duplicate and
 * this page can produce its stream alone, it produces the sparse version right away (checking the
 * asset service first, and using it directly if present). For this, the render connection is opened
 * **before measurement settles** and checks in as usual to get the fingerprint, but before
 * measurement settles the node does not claim and the page's idle path does not run (while `settled`
 * is false, `isIdle` is false on both sides); the intent of section 2, "act as a node only once
 * measurement settles", was that the background stage is not occupied by queue jobs during
 * measurement, and that has not changed [ruling].
 * Which project version to use: the confirmed version at this moment (`deps.confirmed()`), kept by
 * revision number; the clips judged duplicate are taken from `deps.heavyClips()` (the same source as
 * the manifest of the manifest plan).
 *
 * # Playback keep-alive
 *
 * During playback and dragging this page neither produces streams nor claims (idle criteria), and
 * the cards it has locked have no output. Then `busy()` returns `'play'`, and the node sends
 * `node.active { busy: 'play' }` at the interval given by the queue (10 seconds): from this the
 * queue does not judge the cards locked by this page as idle (when idle for over 30 seconds they are
 * taken over by the splitter, and the other copy is voided and produced again).
 * It is not sent when the page is hidden or the parent page rAF is stalled (same as the original
 * rule). Streams this page produces by itself without the queue have no lock and no claim; other
 * pages only check by output first, so there is no "takeover", and no keep-alive is needed.
 *
 * # Project versions (D6)
 *
 * Before the manifest plan is published (`onPublish` of `planPublisher`), the confirmed version at
 * that moment is kept in memory by revision number, at most `KEPT_REVISIONS` versions;
 * a fine-grained task uses the kept ones first, otherwise fetches via the render connection
 * `project.snapshot.get`, and if neither is available it releases (`no-snapshot`).
 *
 * # Diagnostics (section 7)
 *
 * `window.__pcBrowserNode()`: eligibility and reason, node state and counts (`debug()` of
 * `browserNode.ts`), how many chunks pushed / skipped / how many bytes, how many small-version
 * frames, per-frame stage time p50 / p95 and the time blocked by the gate, connection state, the last
 * error; `pageStreams` is the state and counts of page-produced streams.
 */
import { alphaBoxOf, browserNodeEligibility, createBrowserNode, isChromiumUserAgent, isSparseStreamTask, mergeStreamManifest, streamManifest, streamManifestBlocks, streamManifestCovers, streamManifestPuts, streamTaskFrames, streamTaskStride,
  BROWSER_STREAM_ENCODER,
  type BrowserNode, type EligibilityInput, type FrameRecord, type NodeTask, type StreamInitMeta, type StreamManifestOut, type StreamRectLike, type StreamSegmentMeta } from "../online/browserNode";
import { openStreamEncoder, probeStreamEncoder } from "../render/streamEncode";
import { manifestBlocks, manifestCovers, manifestKey, snapshotManifest } from "../online/bakeTask";
import { createSnapUploader, sha256Hex, type SnapUploader } from "../online/snapUploader";
import { pageL2 } from "../online/l2";
import { getNodeCardInfo, setNodeCardEnvFingerprint } from "../online/nodeCardInfo";
import { startNodeCardInfoLive } from "./nodeCardInfoLive";
import { pageEnvironment } from "./pageEnvironment.mjs";
import { backWorkDiag } from "./backWorkGate";
import { runBackJob, urgentBackJobs } from "./stageJobs";
import { backRole, backStage, frontStage, onStageEvent, pushProject } from "./stageBridge";
import { getState, subscribe } from "../store/project";
import { isScrubbing, subscribeScrub } from "./timeline/useScrub";
import { docRequest, remoteAssetBase } from "./media/assetTiers";
import { currentSharedUrl, me, pageSession } from "./sync/syncManager";
import type { Project } from "../kernel/project";
import { createStageBaker } from "./stageBake";
import type { BakeFrameRequest, StageEvent, StageRpcClient } from "../render/stageRpc";
import { createPageStreams, type MeasureOutcome, type PlanState, type PublishedPlan } from "../online/pageStreams";
import { setCardMeasuredHook, type CardMeasuredInfo } from "./probeRunner";
import { pageStreamCodes, planPageStreams, type PageCardPlanValue } from "../online/pageStreamPlan";
import { projectCardGraph } from "../kernel/cardGraph.mjs";
import { withMediaRates } from "../kernel/clipTime.mjs";
import { flatPlanProject, withFlatNodes } from "../kernel/cutFlatten.mjs";
import { getCard, unknownCardClipIds } from "../kernel/registry";
import { sourceVersionsOf } from "./costIdentity";
import { fontFingerprintOf } from "../render/fontFingerprint";
// @ts-expect-error untyped .mjs (shared by browser and Node, uses only WebSocket and timers)
import { createDocEndpoint as createDocEndpointUntyped } from "../../server/render-node/session-link.mjs";
import { tr } from "../i18n/index.ts";

/** How often to check eligibility and tick (claiming and renewal are throttled by the session itself at its own interval) */
export const HOST_TICK_MS = 250;
/** Minimum time since the last playback or drag before counting as idle (reuses the desktop node's 500 ms, `server/queue-idle.mjs`; third-level number) */
export const INTERACTION_QUIET_MS = 500;
/** Maximum number of confirmed versions kept at publish time (same as the executor's `PLAN_CACHE_SIZE`) */
export const KEPT_REVISIONS = 4;
/** Maximum time to wait when fetching the project snapshot */
export const SNAPSHOT_FETCH_MS = 30_000;
/** Backoff for rebuilding the render session after it fails to be created / after it ends */
const REDIAL_MIN_MS = 1000;
const REDIAL_MAX_MS = 30_000;
/** Frame push policy (contract section 4.3): push frame by frame sequentially (probe P2: for DOM standalone cards this is equivalent to desktop's 4-frame batches pushed from the start, and 4 to 7 times cheaper; canvas cards do not enter the browser) */
export const BAKE_MODE: "batch4" | "seq" = "seq";
/** How many tasks' worth of already-pushed stream-task segments to keep by task id (so that reclaiming the same range after yielding only fills in missing segments; same as the node's `RETAINED_TASKS`) */
const STREAM_KEPT_TASKS = 8;
/** Kicked, or project deleted: do not reconnect (HT-a) */
const FATAL_CLOSE = new Set([4003, 4004]);

type DocEndpoint = {
  send(message: object): boolean;
  onMessage(handler: (message: Record<string, unknown>) => void): void;
  onOpen(handler: () => void): void;
  onResume(handler: () => void): void;
  onClose(handler: (info: { code: number; reason: string }) => void): void;
  onConnectFail(handler: (info: { code: number; reason: string }) => void): void;
  close(): void;
  readonly connected: boolean;
  stats(): { transport: string | null; resumes: number; [k: string]: unknown };
};
const createDocEndpoint = createDocEndpointUntyped as (options: Record<string, unknown>) => DocEndpoint;

/* ------------------------------------------------------------------ module level: for the manifest plan and the online source */

/** Confirmed versions kept at publish time: revision number → project (read-only, never modified) */
const kept = new Map<number, Project>();
/** D6: keep this version before the manifest plan is published */
export function keepConfirmedProject(rev: number, project: Project | null): void {
  if (!Number.isSafeInteger(rev) || rev <= 0 || !project) return;
  kept.delete(rev);
  kept.set(rev, project);
  while (kept.size > KEPT_REVISIONS) kept.delete(kept.keys().next().value as number);
}

let readyState: "none" | "pending" | "ready" = "none";
const readyListeners = new Set<() => void>();
const setReady = (next: "none" | "pending" | "ready") => {
  if (next === readyState) return;
  readyState = next;
  for (const l of [...readyListeners]) { try { l(); } catch { /* The subscriber is broken */ } }
};
/** Whether this page's pure-browser node has checked in (the manifest plan waits on this, at most 3 s): not a node `none`, checking in `pending`, fingerprint obtained `ready` */
export function browserNodeReady(): "none" | "pending" | "ready" {
  return readyState;
}
export function subscribeBrowserNodeReady(cb: () => void): () => void {
  readyListeners.add(cb);
  return () => { readyListeners.delete(cb); };
}

/* ------------------------------------------------------------------ host */

export interface BrowserNodeHostDeps {
  /** Conditions for acting as a node at this moment (section 2) */
  eligibility: () => EligibilityInput;
  /** Id of the shared project currently connected */
  projectId: () => string | null;
  /** This page produced and finished this range: the online source treats this result key as alive (D12) */
  onAlive?: (resultKey: string) => void;
  /** Page-produced streams ("Part A2"): the latest version of the manifest plan this page has published (`current()` of `planPublisher.ts`); if not given, the page-produced stream path is not taken */
  pagePlan?: () => PublishedPlan | null;
  /** Page-produced streams: query the current state of the queue's version of the plan (`probe()` of `planPublisher.ts`); returns null if it cannot be queried */
  planState?: () => Promise<string | null>;
  /** Page-produced streams: this result key now has a usable stream (produced by this page, or found by the check-first lookup); the host tells the online source to accept it and re-fetch the layer table immediately */
  onPageStream?: (resultKey: string) => void;
  /** Produce sparse versions during measurement: the clips this page currently judges duplicate (same source as the manifest of the manifest plan); if not given, nothing is produced during measurement */
  heavyClips?: () => readonly string[];
  /** Produce sparse versions during measurement: the project version and revision number currently confirmed by the document service; returns null if there is none */
  confirmed?: () => { rev: number; project: Project } | null;
  /** With a single stage, restore foreground stage suppression and the stream plane after producing streams */
  restore?: () => void;
}

/**
 * Only produce sparse versions for this page, without acting as a queue node: identity is mobile
 * (semantics `product/platforms.md`, "Render node": mobile and tablet also produce sparse versions
 * for this page), or there is only one stage (no background stage that could double as a node).
 * The lowest tier does neither (it cannot even run the baseline card, so it does not produce streams
 * on this page).
 */
/** `stageLayout` being `pending` (opened as two stages, not both handshaken yet) does not count as having only one stage */
export function ownSparseOnly(e: Pick<EligibilityInput, "phone" | "lowest" | "stageLayout">): boolean {
  return !e.lowest && (e.phone || e.stageLayout === "single");
}

/**
 * Raw material of the page-side "card plan", same shape as the export page's
 * `window.__pcCardPlan()` (`src/ExportView.tsx`): the card graph, each card's source version, and
 * the environment.
 * The splitter's keys are computed from this copy of the export page; page-produced streams are
 * computed from this copy, so for the same project and the same code both sides get the same key.
 * The font fingerprint takes the fonts already loaded by this page's document (the export page takes
 * those of its own document); when the fonts loaded on the two sides differ, the keys differ, and the
 * splitter treats that stream as absent and produces another one under its own key.
 */
export function pageCardPlanValue(project: Project): PageCardPlanValue | null {
  try {
    const fonts = typeof document !== "undefined" ? (document.fonts as unknown as Iterable<{ family: string; status: string }>) : null;
    // Replace a cut segment with the cards inside it (`kernel/cutFlatten.mjs`), same as the export page's `__pcCardPlan`: both sides compute the same key
    const flat = flatPlanProject(project);
    return {
      // Add the rate to media nodes of variable-speed segments (withMediaRates in kernel/clipTime.mjs), same as the export page's `__pcCardPlan`
      graph: withFlatNodes(flat, withMediaRates(flat, projectCardGraph(flat, getCard))) as unknown as PageCardPlanValue["graph"],
      sourceVersions: sourceVersionsOf(),
      unknownClipIds: [...unknownCardClipIds(flat.tracks.flatMap((track) => track.clips))].sort(),
      environment: { width: project.width, height: project.height, fps: project.fps, theme: project.themeId, fontFingerprint: fontFingerprintOf(fonts) },
    };
  } catch {
    // The card graph cannot be computed (dangling input): this version is not produced
    return null;
  }
}

const quantile = (sorted: number[], p: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;

async function sha256HexText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gunzip(buf: ArrayBuffer): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw Object.assign(new Error(tr("The browser has no DecompressionStream")), { retryable: false });
  const stream = new Blob([buf]).stream().pipeThrough(new DS("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function startBrowserNodeHost(deps: BrowserNodeHostDeps): () => void {
  let stopped = false;
  let fatal: string | null = null;
  let node: BrowserNode | null = null;
  let nodeProject: string | null = null;
  let ep: DocEndpoint | null = null;
  let dialing = false;
  let redialAt = 0;
  let redialDelay = REDIAL_MIN_MS;
  let lastInteractionAt = -Infinity;
  let lastError: string | null = null;
  let eligibility: { ok: boolean; reason: string | null } = { ok: false, reason: "starting" };
  const nodeId = `browser-${pageSession()}`;
  const conn = { sessions: 0, opens: 0, closes: 0, resumes: 0, lastClose: null as { code: number; reason: string } | null };
  const stage = { frames: 0, ms: [] as number[], pausedMs: 0, remounts: 0, small: 0, smallMs: [] as number[], readyMs: [] as number[], errors: {} as Record<string, number> };
  /** Parent-page time breakdown per frame (milliseconds, last 200 frames): starting the job and loading the project, stage round trip, decompression, pushing both tiers, entering the in-page snapshot store */
  const PHASES = ["lease", "rpc", "gunzip", "snap", "px", "push", "l2", "total"] as const;
  const phases = Object.fromEntries(PHASES.map((k) => [k, [] as number[]])) as Record<(typeof PHASES)[number], number[]>;
  const notePhase = (k: (typeof PHASES)[number], ms: number) => { const a = phases[k]; a.push(ms); if (a.length > 200) a.splice(0, a.length - 200); };
  const manifestStats = { written: 0, failed: 0, lastError: null as string | null };

  /* ---------------- Ticket signing and uploader (D7: parent page pushes) ---------------- */

  let rw: { ticket: string; exp: number; issued: number } | null = null;
  /** The signing in progress: when both tiers push in parallel and ask for a ticket at the same time, only one is signed */
  let rwSigning: Promise<string | null> | null = null;
  const rwTicket = (force = false): Promise<string | null> => {
    const now = Date.now();
    if (!force && rw && now < rw.issued + ((rw.exp - rw.issued) * 2) / 3) return Promise.resolve(rw.ticket);
    if (rwSigning) return rwSigning;
    rwSigning = signRw().finally(() => { rwSigning = null; });
    return rwSigning;
  };
  const signRw = async (): Promise<string | null> => {
    const now = Date.now();
    try {
      const r = await docRequest({ type: "auth.ticket", kind: "asset", access: "rw" });
      if (r.type === "auth.ticket.ok" && typeof r.ticket === "string") {
        rw = { ticket: r.ticket, exp: Number(r.exp) || now + 15 * 60_000, issued: now };
        return rw.ticket;
      }
    } catch { /* Cannot sign: the upload returns 401, handed back as a retryable failure */ }
    return rw?.ticket ?? null;
  };
  const uploader: SnapUploader = createSnapUploader({ base: remoteAssetBase, ticket: rwTicket });
  const store = pageL2().catch(() => null);

  /* ---------------- The job that generates snapshots ---------------- */

  /**
   * The job and the per-frame stage round trip live in `stageBake.ts` (split out in task F): the
   * `bake` job in the single-flight queue, checking the background position before every frame
   * (reload if the stage changed hands), sending the next frame first on sequential push, and redoing
   * on the new stage if it changed hands midway through a frame. This code continues with the second
   * half of one frame: decompress, push to the asset service, enter the in-page snapshot store.
   */
  const baker = createStageBaker({
    runBackJob: (kind, run) => runBackJob(kind, run),
    backStage, pushProject, onStageEvent,
    onUrgent: () => { node?.yieldFor("urgent"); pages.yieldFor("urgent"); },
    isIdle: () => isIdle(),
    mode: BAKE_MODE,
    now: () => performance.now(),
    notePhase: (k, ms) => notePhase(k, ms),
    noteError: (reason) => { stage.errors[reason] = (stage.errors[reason] ?? 0) + 1; },
  });
  const closeLease = () => { baker.close(); closeStreamLease(); };

  const bakeFrame = async ({ task, project, localFrame, signal }: { task: NodeTask; project: unknown; localFrame: number; signal: AbortSignal }) => {
    const t0 = performance.now();
    const { reply, event: ev } = await baker.bakeFrame({ task, project, localFrame, signal });
    stage.frames++;
    stage.ms.push(reply.ms);
    stage.readyMs.push(reply.readyMs);
    if (stage.ms.length > 200) { stage.ms.splice(0, stage.ms.length - 200); stage.readyMs.splice(0, stage.readyMs.length - 200); }
    stage.pausedMs += reply.pausedMs;
    if (reply.remounted) stage.remounts++;
    let tp = performance.now();
    const bytes = ev.htmlGz ? await gunzip(ev.htmlGz) : new Uint8Array(ev.htmlRaw ?? new ArrayBuffer(0));
    notePhase("gunzip", performance.now() - tp);
    if (bytes.length !== ev.bytes) throw Object.assign(new Error(tr("Decompressed snapshot byte count does not match")), { retryable: true });
    // Push to the asset service: both tiers in parallel (each needs at least one network round trip, independent of each other); the frame counts as done only when both tiers are pushed successfully (c10a section 9)
    tp = performance.now();
    const timed = (k: "snap" | "px", work: Promise<unknown>) => work.then(() => notePhase(k, performance.now() - tp));
    const pushes = [timed("snap", uploader.put("snap", ev.hash, bytes, "html"))];
    if (ev.small) pushes.push(timed("px", uploader.put("px", ev.small.hash, new Uint8Array(ev.small.webp), "webp")));
    const settled = await Promise.allSettled(pushes);
    const bad = settled.find((x): x is PromiseRejectedResult => x.status === "rejected");
    if (bad) throw bad.reason;
    notePhase("push", performance.now() - tp);
    let small: { hash: string; bytes: number } | null = null;
    if (ev.small) {
      small = { hash: ev.small.hash, bytes: ev.small.bytes };
      stage.small++;
      stage.smallMs.push(reply.smallMs);
      if (stage.smallMs.length > 200) stage.smallMs.splice(0, stage.smallMs.length - 200);
    }
    // Self-produced chunks go into the in-page snapshot store; the `ranges` of this layer record this frame (written means ready, the online source swaps it in accordingly)
    tp = performance.now();
    const s = await store;
    if (s) {
      await s.putBlock(`snap/${ev.hash}`, bytes, "text/html").catch(() => {});
      if (ev.small) await s.putBlock(`px/${ev.small.hash}`, new Uint8Array(ev.small.webp), "image/webp").catch(() => {});
      await s.putRange(task.resultKey, localFrame, localFrame).catch(() => {});
    }
    notePhase("l2", performance.now() - tp);
    notePhase("total", performance.now() - t0);
    return { hash: ev.hash, bytes: bytes.length, small };
  };

  /* ---------------- Stream task (browser-stream-task.md, part 4) ---------------- */

  /** Whether it can produce streams: probe once for "composed picture size @ frame rate" and record the result; probe again if the aspect ratio or frame rate changes */
  const streamCap = { key: "", capable: false, probing: false, mode: null as string | null, reason: null as string | null };
  const probeStreams = () => {
    const p = getState().project;
    // The stream's rectangle does not exceed the whole picture (the bound of a single-card stream is clamped to the picture range), width and height rounded to even
    const w = Math.max(2, Math.floor(Number(p?.width) || 0) & ~1), h = Math.max(2, Math.floor(Number(p?.height) || 0) & ~1);
    const fps = Math.max(1, Number(p?.fps) || 30);
    const key = `${w}x${h}@${fps}`;
    if (key === streamCap.key || streamCap.probing) return;
    streamCap.probing = true;
    void probeStreamEncoder({ width: w, height: h, fps }).then(
      (r) => { Object.assign(streamCap, { key, capable: r.supported === true, mode: r.mode ?? null, reason: r.reason ?? null }); },
      (e) => { Object.assign(streamCap, { key, capable: false, mode: null, reason: String((e as Error)?.message ?? e).slice(0, 120) }); },
    ).finally(() => { streamCap.probing = false; });
  };
  const streamStats = { tasks: 0, encoders: 0, frames: 0, blank: 0, segments: 0, inits: 0, bytes: 0, yields: 0, resumedSegments: 0, pixelsMs: [] as number[], encodeMs: [] as number[], lastError: null as string | null };
  /** Segments already pushed: task id → this task's header file and segment registry (evicted in insertion order) */
  const streamKept = new Map<string, { inits: Record<string, StreamInitMeta>; segments: Record<number, StreamSegmentMeta> }>();
  /** Bitmaps delivered by the stage and not yet used: session number + local frame → bitmap (closed after use, or when this range ends) */
  const pixelStash = new Map<string, ImageBitmap>();
  const dropPixels = () => { for (const b of pixelStash.values()) { try { b.close(); } catch { /* Already closed */ } } pixelStash.clear(); };
  /** The rectangle this stream task asks the stage for (that is, the stream's bound); null when no stream task is running */
  let pixelRectNow: { x: number; y: number; w: number; h: number } | null = null;
  /** Stage client for stream tasks: adds "ask for pixels, no HTML, no small version" to the `bakeFrame` request. The same stage returns the same wrapper (the job identifies a stage by object) */
  const pixelStages = new WeakMap<StageRpcClient, StageRpcClient>();
  const withPixels = (s: StageRpcClient | null): StageRpcClient | null => {
    if (!s) return null;
    let w = pixelStages.get(s);
    if (!w) {
      w = new Proxy(s, {
        get(target, key) {
          if (key === "bakeFrame") return (req: BakeFrameRequest) => target.bakeFrame({ ...req, small: false, html: false, ...(pixelRectNow ? { pixels: { rect: pixelRectNow } } : {}) });
          const v = Reflect.get(target, key, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      pixelStages.set(s, w);
    }
    return w;
  };
  let singleStageBaking = false;
  const restoreFrontFromBake = async () => {
    if (!singleStageBaking && backRole() !== "front") return;
    singleStageBaking = false;
    const stage = frontStage();
    if (stage) {
      try { await stage.setRole("front"); } catch { /* ignore */ }
      try { await pushProject("front", getState().project, { reset: true }); } catch { /* ignore */ }
    }
    try { deps.restore?.(); } catch { /* ignore */ }
  };

  const streamBaker = createStageBaker({
    runBackJob: (kind, run) => runBackJob(kind, async (ctx) => {
      const single = backRole() === "front";
      if (single) {
        singleStageBaking = true;
        try { await ctx.stage.setRole("back", { job: "bake" }); } catch { /* ignore */ }
      }
      try {
        return await run({ ...ctx, stage: withPixels(ctx.stage)! });
      } finally {
        if (single) {
          await restoreFrontFromBake();
        }
      }
    }),
    backStage: () => withPixels(backStage()),
    pushProject,
    // Bitmaps do not go into the job's event table (it keeps at most 16 entries and does not close bitmaps): they are stored separately here, and the events handed to it carry no bitmap
    onStageEvent: (listener) => onStageEvent((e: StageEvent) => {
      if (e.type === "bake-frame" && e.pixels) {
        const key = `${e.session}#${e.localFrame}`;
        try { pixelStash.get(key)?.close(); } catch { /* Already closed */ }
        pixelStash.set(key, e.pixels.bitmap);
        listener({ ...e, pixels: null });
        return;
      }
      listener(e);
    }),
    onUrgent: () => { node?.yieldFor("urgent"); pages.yieldFor("urgent"); },
    isIdle: () => isIdle(),
    mode: BAKE_MODE,
    small: false,
    now: () => performance.now(),
    noteError: (reason) => { stage.errors[reason] = (stage.errors[reason] ?? 0) + 1; },
  });

  /** Hand back the job used by the stream task: stop the frame being pushed, close the bitmaps not yet used */
  const closeStreamLease = () => {
    streamBaker.close();
    dropPixels();
    pixelRectNow = null;
    if (singleStageBaking) {
      void restoreFrontFromBake();
    }
  };

  /**
   * `stride`: how many frames between each capture requested from the stage. When greater than 1, the
   * captured one is sent `stride` times in a row (the segment's sample count is unchanged), and this
   * `stride` is recorded for the segment in the manifest.
   * When not given, it follows the task's density (`streamTaskStride`): a claimed sparse stream task
   * (`input.density: 'sparse'`) uses the frame count of one segment (only the first frame of each
   * segment is captured); a full-density task uses 1. Page-produced streams (`pageStreams.ts`) supply
   * it themselves.
   * The sparse pass (`stride > 1`) additionally measures each segment's position rectangle (`box`, the
   * bounding box of the opaque pixels in the captured frame, in plane coordinates) and records it in
   * that segment's entry in the manifest.
   */
  const bakeStream = async ({ task, project, signal, progress, yielding, stride: strideIn }: {
    task: NodeTask; project: unknown; signal: AbortSignal; progress: (frames: number) => void; yielding: () => boolean; stride?: number;
  }): Promise<{ manifest: Record<string, unknown> } | { yielded: true }> => {
    const stride = Number.isInteger(strideIn) && (strideIn as number) >= 1 ? (strideIn as number) : streamTaskStride(task);
    const plan = streamTaskFrames(task);
    if (!plan) throw Object.assign(new Error(tr("Task has no input.stream (the splitter did not give the browser its share of the parameters)")), { retryable: false });
    const { input } = plan;
    let kept = streamKept.get(task.id);
    if (!kept) {
      kept = { inits: {}, segments: {} };
      streamKept.set(task.id, kept);
      while (streamKept.size > STREAM_KEPT_TASKS) streamKept.delete(streamKept.keys().next().value as string);
    }
    const parts = kept;
    const expected = new Map(plan.segments.map((s) => [s.index, s.frames.length]));
    const framesOf = (done: (n: number) => boolean) => plan.segments.reduce((sum, s) => sum + (done(s.index) ? s.frames.length : 0), 0);
    /** This range already has segments no sparser than this pass (pushed last time): not redone */
    const have = (n: number) => !!parts.segments[n] && parts.segments[n].stride <= stride;
    /** Segments pushed in the previous claim (coming back after being released for yielding): not redone */
    const before = framesOf(have);
    streamStats.resumedSegments += plan.segments.filter((s) => have(s.index)).length;
    let fed = 0;
    progress(before);
    // The stream task asks the stage for frames with its own copy of the "job": the range is given in the card's local frames (from which it decides whether to send the next frame first)
    const frameTask: NodeTask = { ...task, range: { unit: "localFrame", from: 0, to: input.count - 1 } };
    const session = task.id;
    pixelRectNow = { ...input.bound };
    const blank = new OffscreenCanvas(input.bound.w, input.bound.h);
    const timescale = Math.round(input.fps);
    /** Position rectangles measured in the sparse pass: segment number → box (plane coordinates) / null (that captured frame is fully transparent); ones that cannot be measured are not recorded */
    const boxes = new Map<number, StreamRectLike | null>();
    const measureBox = (bitmap: ImageBitmap): StreamRectLike | null | undefined => {
      try {
        const w = bitmap.width, h = bitmap.height;
        if (!(w > 0) || !(h > 0)) return undefined;
        const canvas = new OffscreenCanvas(w, h);
        const g = canvas.getContext("2d", { willReadFrequently: true });
        if (!g) return undefined;
        g.drawImage(bitmap, 0, 0);
        const local = alphaBoxOf(g.getImageData(0, 0, w, h).data, w, h);
        if (!local) return null;
        // The bitmap and the plane rectangle are usually the same size; if not (taken at a scale), convert back to plane coordinates, rounding outward
        const sx = input.bound.w / w, sy = input.bound.h / h;
        const x0 = Math.floor(local.x * sx), y0 = Math.floor(local.y * sy);
        const x1 = Math.min(input.bound.w, Math.ceil((local.x + local.w) * sx)), y1 = Math.min(input.bound.h, Math.ceil((local.y + local.h) * sy));
        return { x: input.bound.x + x0, y: input.bound.y + y0, w: x1 - x0, h: y1 - y0 };
      } catch { return undefined; }
    };
    // Group the missing segments into runs of consecutive ones: one encoder per group (each segment starts with a keyframe, groups are independent)
    const runs: (typeof plan.segments)[] = [];
    for (const s of plan.segments) {
      if (have(s.index)) continue;
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1].index === s.index - 1) last.push(s); else runs.push([s]);
    }
    /** In a sparse pass, the next local frame to request from the stage after sample number `at` of `seg` (within the same group; null if none) */
    const nextWanted = (seg: (typeof plan.segments)[number], at: number): number | null => {
      if (at + stride < seg.frames.length) return seg.frames[at + stride];
      for (const group of runs) {
        const i = group.indexOf(seg);
        if (i >= 0) return group[i + 1]?.frames[0] ?? null;
      }
      return null;
    };
    for (const group of runs) {
      let initId: string | null = null;
      streamStats.encoders++;
      const enc = await openStreamEncoder({
        width: input.bound.w, height: input.bound.h, fps: input.fps, firstSegment: group[0].index,
        onInit: async (init) => {
          const hash = await sha256Hex(init.bytes);
          await uploader.put("px", hash, init.bytes, "mp4");
          initId = hash.slice(0, 16);
          if (!parts.inits[initId]) { streamStats.inits++; streamStats.bytes += init.bytes.length; }
          parts.inits[initId] = { hash, bytes: init.bytes.length, codec: init.codec, width: init.width, height: init.height, timescale, rect: { ...input.bound }, encoder: BROWSER_STREAM_ENCODER };
        },
        onSegment: async (seg) => {
          // Drop a segment that did not fill up (flushed from the encoder when yielding): a segment must have exactly the number of samples it should have
          if (seg.samples !== expected.get(seg.index) || !initId) return;
          const hash = await sha256Hex(seg.bytes);
          await uploader.put("px", hash, seg.bytes, "m4s");
          parts.segments[seg.index] = { hash, bytes: seg.bytes.length, init: initId, stride, samples: seg.samples, sig: null, encoder: BROWSER_STREAM_ENCODER,
            ...(boxes.has(seg.index) ? { box: boxes.get(seg.index) ?? null } : {}) };
          streamStats.segments++;
          streamStats.bytes += seg.bytes.length;
        },
      });
      let finished = false;
      try {
        for (const seg of group) {
          for (let at = 0; at < seg.frames.length; at += stride) {
            const local = seg.frames[at];
            /** How many times in a row this frame is sent (1 at full density) */
            const repeat = Math.min(stride, seg.frames.length - at);
            if (signal.aborted) throw Object.assign(new Error(tr("Aborted")), { retryable: true });
            if (yielding()) {
              // Yield: flush the segments that are already full (they count only once pushed), drop the one that is not full
              finished = true;
              await enc.finish().catch(() => {});
              streamStats.yields++;
              return { yielded: true };
            }
            const t0 = performance.now();
            if (local === null) {
              streamStats.blank += repeat;
              if (stride > 1 && at === 0) boxes.set(seg.index, null);
              for (let k = 0; k < repeat; k++) await enc.add(blank);
            } else {
              // A sparse pass first sends the stage the next frame to capture (the first frame of the next segment), not the next frame
              const { reply } = await streamBaker.bakeFrame({ task: frameTask, project, localFrame: local, signal, ...(stride > 1 ? { ahead: nextWanted(seg, at) } : {}) });
              const key = `${session}#${local}`;
              const bitmap = pixelStash.get(key);
              pixelStash.delete(key);
              if (!bitmap) throw Object.assign(new Error(tr("The stage did not hand over the pixels of this frame")), { retryable: true });
              stage.frames++;
              stage.ms.push(reply.ms);
              stage.readyMs.push(reply.readyMs);
              if (stage.ms.length > 200) { stage.ms.splice(0, stage.ms.length - 200); stage.readyMs.splice(0, stage.readyMs.length - 200); }
              stage.pausedMs += reply.pausedMs;
              if (reply.remounted) stage.remounts++;
              streamStats.pixelsMs.push(reply.pixelsMs ?? 0);
              if (stride > 1 && at === 0) {
                const box = measureBox(bitmap);
                if (box !== undefined) boxes.set(seg.index, box);
              }
              const e0 = performance.now();
              try { for (let k = 0; k < repeat; k++) await enc.add(bitmap); } finally { try { bitmap.close(); } catch { /* Already closed */ } }
              streamStats.encodeMs.push(performance.now() - e0);
              if (streamStats.pixelsMs.length > 200) { streamStats.pixelsMs.splice(0, streamStats.pixelsMs.length - 200); streamStats.encodeMs.splice(0, Math.max(0, streamStats.encodeMs.length - 200)); }
            }
            notePhase("total", performance.now() - t0);
            fed += repeat;
            streamStats.frames += repeat;
            progress(before + fed);
          }
        }
        finished = true;
        await enc.finish();
      } catch (e) {
        if (!finished) enc.abort();
        streamStats.lastError = String((e as Error)?.message ?? e).slice(0, 200);
        throw e;
      }
    }
    for (const s of plan.segments) if (!have(s.index)) throw Object.assign(new Error(tr("Segment {0} is incomplete", s.index)), { retryable: true });
    streamStats.tasks++;
    return { manifest: streamManifest(task as Parameters<typeof streamManifest>[0], parts) as unknown as Record<string, unknown> };
  };

  /**
   * After all segments of a stream task are in: write the manifest to the content store (`render-manifest`,
   * key `<result key>:<start>-<end>`); a failure is only logged as a diagnostic (same as snapshots and the
   * desktop writeManifest).
   * Also write it per "8 segments per bucket" (`streamManifestPuts`: the bucket end is clamped to the last
   * segment of the whole stream, derived from the task's `input.stream.lastFrame`); the reader only looks up by bucket.
   * Each entry is first merged with the one already in the content store (`mergeStreamManifest`): no downgrade
   * (existing full-density segments are kept), segments that adjacent tasks write into the same bucket are combined,
   * and the position rectangles measured by a sparse pass are carried into the full-density manifest.
   * Returns true when all writes succeed.
   */
  const putStreamManifest = async (task: NodeTask, manifest: Record<string, unknown>): Promise<boolean> => {
    const puts = streamManifestPuts(task as Parameters<typeof streamManifestPuts>[0], manifest as unknown as StreamManifestOut);
    if (!puts.length) return false;
    let ok = true;
    for (const { key, body } of puts) {
      let merged: StreamManifestOut = body;
      try {
        const got = await docRequest({ type: "content.get", kind: "render-manifest", key });
        if (got.type === "content.item" && got.body) merged = mergeStreamManifest(got.body, body);
      } catch { /* If it cannot be read, write the new one as is */ }
      try {
        const r = await docRequest({ type: "content.put", kind: "render-manifest", key, body: merged });
        if (r.type === "content.stored") { manifestStats.written++; continue; }
        manifestStats.failed++;
        manifestStats.lastError = String(r.reason ?? r.type);
      } catch (e) {
        manifestStats.failed++;
        manifestStats.lastError = String((e as Error)?.message ?? e);
      }
      ok = false;
    }
    return ok;
  };
  const finishStream = async ({ task, manifest }: { task: NodeTask; manifest: Record<string, unknown> }) => {
    await putStreamManifest(task, manifest);
    streamKept.delete(task.id);
    return manifest;
  };

  const finishTask = async ({ task, frames }: { task: NodeTask; frames: FrameRecord[] }) => {
    const manifest = snapshotManifest(task as Parameters<typeof snapshotManifest>[0], frames);
    const key = manifestKey(task);
    try {
      const r = await docRequest({ type: "content.put", kind: "snapshot-manifest", key, body: manifest });
      if (r.type === "content.stored") manifestStats.written++;
      else { manifestStats.failed++; manifestStats.lastError = String(r.reason ?? r.type); }
    } catch (e) {
      // A content store write failure is only logged as a diagnostic (same as desktop writeManifest): the manifest is still handed to the subscriber with task.complete
      manifestStats.failed++;
      manifestStats.lastError = String((e as Error)?.message ?? e);
    }
    return manifest as unknown as Record<string, unknown>;
  };

  /** Dedup (section 4.1): the manifest is in the content store, covers the whole segment, both tiers are present, and every chunk is on the asset service */
  const lookupResult = async (task: NodeTask) => {
    const key = manifestKey(task);
    if (!key) return null;
    if (task.kind === "stream") {
      // Stream task: the stream manifest for this segment is in the content store, all segments in the task range are listed, and the head file and segments are on the asset service
      let found: unknown = null;
      try {
        const r = await docRequest({ type: "content.get", kind: "render-manifest", key });
        found = r.type === "content.item" ? r.body : null;
      } catch { return null; }
      // A full-density task needs every segment at full density; for a sparse stream task, one version per segment is enough
      if (!streamManifestCovers(found, task as Parameters<typeof streamManifestCovers>[1], { dense: !isSparseStreamTask(task) })) return null;
      for (const b of streamManifestBlocks(found)) if (!(await uploader.has(b.ns, b.hash))) return null;
      return found as unknown as Record<string, unknown>;
    }
    let body: unknown = null;
    try {
      const r = await docRequest({ type: "content.get", kind: "snapshot-manifest", key });
      body = r.type === "content.item" ? r.body : null;
    } catch { return null; }
    if (!manifestCovers(body, task as Parameters<typeof manifestCovers>[1])) return null;
    for (const b of manifestBlocks(body)) if (!(await uploader.has(b.ns, b.hash))) return null;
    return body as unknown as Record<string, unknown>;
  };

  /* ---------------- Fetch the project snapshot (via the render connection) ---------------- */

  const snapshotWaiters = new Map<string, (m: Record<string, unknown>) => void>();
  let snapSeq = 0;
  const fetchSnapshot = (rev: number): Promise<Project | null> => new Promise((resolve) => {
    const e = ep;
    const projectId = nodeProject;
    if (!e || !projectId) { resolve(null); return; }
    const reqId = `browser-snap-${++snapSeq}`;
    const parts: string[] = [];
    let count = -1;
    const finish = (p: Project | null) => { snapshotWaiters.delete(reqId); clearTimeout(timer); resolve(p); };
    const timer = setTimeout(() => finish(null), SNAPSHOT_FETCH_MS);
    snapshotWaiters.set(reqId, (m) => {
      if (m.type === "project.snapshot.part") {
        if (m.missing === true) { finish(null); return; }
        const i = Number(m.index);
        if (Number.isInteger(i) && typeof m.data === "string") { parts[i] = m.data; count = Number(m.count); }
      } else if (m.type === "project.snapshot.end") {
        const text = parts.join("");
        if (count >= 0 && parts.filter((x) => typeof x === "string").length !== count) { finish(null); return; }
        void sha256HexText(text).then((digest) => {
          if (digest !== m.digest) { finish(null); return; }
          try { finish(JSON.parse(text) as Project); } catch { finish(null); }
        }, () => finish(null));
      } else if (m.type === "error") {
        finish(null);
      }
    });
    if (!e.send({ type: "project.snapshot.get", projectId, projectRev: rev, reqId })) finish(null);
  });

  /* ---------------- Idle criteria and yielding ---------------- */

  const isIdle = (): boolean => {
    const bw = backWorkDiag();
    if (!bw.on) return false;
    if (getState().playing || isScrubbing()) return false;
    if (Date.now() - lastInteractionAt < INTERACTION_QUIET_MS) return false;
    if (urgentBackJobs() > 0) return false;
    if (!backStage()) return false;
    return true;
  };

  /**
   * Busy report (M7 D2 addendum): when holding no claim, whether the background stage has more urgent work
   * queued or running;
   * playback keep-alive: during playback and dragging this page neither produces nor claims and returns `'play'`,
   * so the queue does not judge a card locked by this page as idle ("playback keep-alive" in the file header).
   */
  const busy = (): string | null => {
    const bw = backWorkDiag();
    if (!bw.on && (bw.reason === "hidden" || bw.reason === "raf-gap")) return null;
    if (urgentBackJobs() > 0) return "stage";
    return getState().playing || isScrubbing() ? "play" : null;
  };
  /** Whether the measurement round for opening the project has settled (updated every tick by `loop`): until it settles the node does not claim and the page-idle path stays untouched */
  let settled = false;
  /** When all of the node's conditions except "measurement settled" hold (updated every tick by `loop`): the render connection is open */
  let connectable = false;

  /* ---------------- This-page stream production ("A2"; criteria and order are in pageStreams.ts) ---------------- */

  /** The manifest covers this segment and the chunks are on the asset service; `need.dense` (default: required): a segment counts only with one frame per image, a sparse pass does not require it */
  const streamRangePresent = async (resultKey: string, range: { from: number; to: number }, need: { dense: boolean } = { dense: true }): Promise<boolean> => {
    let found: unknown = null;
    try {
      const r = await docRequest({ type: "content.get", kind: "render-manifest", key: `${resultKey}:${range.from}-${range.to}` });
      found = r.type === "content.item" ? r.body : null;
    } catch { return false; }
    const ref = { resultKey, range };
    if (!streamManifestCovers(found, ref)) return false;
    if (need.dense) for (let n = range.from; n <= range.to; n++) if (found.segments[n]?.stride !== 1) return false;
    for (const b of streamManifestBlocks(found)) if (!(await uploader.has(b.ns, b.hash))) return false;
    return true;
  };
  /** Key of the layer table in the content store: `layers:<project id>` (the same key as the online source and the one the render node writes) */
  const layerMapKey = (project: unknown): string => {
    const id = (project as Project | null)?.id;
    if (typeof id !== "string" || !id) throw new Error(tr("The project has no id, cannot write the layer table"));
    return `layers:${id}`;
  };
  const pages = createPageStreams({
    now: Date.now,
    capable: () => !!deps.pagePlan && !!node && !!node.envFingerprint && readyState === "ready" && streamCap.capable && pageStreamCodes() !== null,
    isIdle: () => settled && isIdle() && !node?.working(),
    plan: () => {
      const p = deps.pagePlan?.() ?? null;
      return p && p.projectId === nodeProject ? p : null;
    },
    planState: async () => {
      const s = await deps.planState?.();
      return s === "open" || s === "claimed" || s === "done" || s === "failed" ? (s as PlanState) : "none";
    },
    codeVersion: deps.eligibility().codeVersion ?? null,
    sparseOnly: () => ownSparseOnly(deps.eligibility()),
    waitMs: ownSparseOnly(deps.eligibility()) ? 0 : undefined,
    specs: async (plan) => {
      const project = kept.get(plan.projectRev) ?? null;
      const fp = node?.envFingerprint ?? null;
      if (!project || !fp) return null;
      const value = pageCardPlanValue(project);
      if (!value) return { specs: [], skipped: {}, project };
      const out = await planPageStreams({ project: project as unknown as Record<string, unknown>, value, clips: plan.clips, codes: pageStreamCodes(), envFingerprint: fp });
      return { ...out, project };
    },
    lookupOwn: async (task, need) => !!task.range && streamRangePresent(task.resultKey, task.range, need),
    lookupOther: streamRangePresent,
    readLayerMap: async (project) => {
      const r = await docRequest({ type: "content.get", kind: "snapshot-manifest", key: layerMapKey(project) });
      if (r.type !== "content.item") throw new Error(tr("Fetch layer table: {0}", String(r.reason ?? r.type)));
      return r.missing ? null : (r.body ?? null);
    },
    writeLayerMap: async (project, body) => {
      const r = await docRequest({ type: "content.put", kind: "snapshot-manifest", key: layerMapKey(project), body });
      if (r.type !== "content.stored") throw new Error(tr("Write layer table: {0}", String(r.reason ?? r.type)));
    },
    produce: async ({ task, project, stride, signal, yielding }) => {
      try {
        const out = await bakeStream({ task, project, signal, progress: () => {}, yielding, stride });
        if (!("manifest" in out)) return "yielded";
        // If the manifest was not written to the content store, nobody else can find this segment: count it as not done (segments already pushed are kept, next time only the manifest write is missing)
        if (!(await putStreamManifest(task, out.manifest))) throw Object.assign(new Error(tr("Stream manifest was not written to the content store: {0}", manifestStats.lastError ?? "?")), { retryable: true });
        streamKept.delete(task.id);
        return "done";
      } finally {
        closeLease();
      }
    },
    onAlive: (resultKey) => {
      try { deps.onAlive?.(resultKey); } catch { /* The host is broken */ }
      try { deps.onPageStream?.(resultKey); } catch { /* The host is broken */ }
    },
  });
  /* ---------------- Produce the sparse version at measurement time (same-named section in the file header) ---------------- */

  const measureStats = { calls: 0, skipped: {} as Record<string, number>, last: null as (MeasureOutcome & { cardId: string; clips: string[]; ms: number }) | null };
  const onCardMeasured = async (info: CardMeasuredInfo): Promise<void> => {
    measureStats.calls++;
    const skip = (why: string) => { measureStats.skipped[why] = (measureStats.skipped[why] ?? 0) + 1; };
    // Pages that do not act as a node (mobile identity, fallback to a single stage, not Chromium, dev build) do not produce; without the this-page stream production path they do not produce either
    const projectId = deps.projectId();
    if (!connectable || !projectId || !deps.heavyClips || !deps.confirmed || !deps.pagePlan) { skip("no-node"); return; }
    const heavy = [...deps.heavyClips()];
    const clips = info.clipIds.filter((id) => heavy.includes(id));
    if (!clips.length) { skip("light"); return; }
    const at = deps.confirmed();
    if (!at || !Number.isSafeInteger(at.rev) || at.rev <= 0) { skip("no-confirmed"); return; }
    keepConfirmedProject(at.rev, at.project);
    const t0 = Date.now();
    const out = await pages.measure({ round: info.round, projectId, projectRev: at.rev, clips, heavy, stale: info.stale });
    measureStats.last = { ...out, cardId: info.cardId, clips, ms: Date.now() - t0 };
  };
  const offMeasured = setCardMeasuredHook(onCardMeasured);

  /** Yielding: claimed tasks follow the same rules as this-page stream production */
  const yieldAll = (cause: "play" | "drag" | "urgent" | "hidden") => { node?.yieldFor(cause); pages.yieldFor(cause); };

  let wasPlaying = !!getState().playing;
  const offStore = subscribe(() => {
    const playing = !!getState().playing;
    if (playing) lastInteractionAt = Date.now();
    if (playing && !wasPlaying) yieldAll("play");
    if (!playing && wasPlaying) lastInteractionAt = Date.now();
    wasPlaying = playing;
  });
  let wasScrubbing = isScrubbing();
  const offScrub = subscribeScrub(() => {
    const s = isScrubbing();
    lastInteractionAt = Date.now();
    if (s && !wasScrubbing) yieldAll("drag");
    wasScrubbing = s;
  });
  const onVisibility = () => { if (typeof document !== "undefined" && document.visibilityState === "hidden") yieldAll("hidden"); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  /*
   * Freeze (M7 probe P5): a freeze only happens after hiding, and D8 has already released; when the `freeze` event
   * arrives, release once more on a best-effort basis (it arrives about 2 s after switching away, and a message can still be sent).
   * When resuming from a freeze Chrome closes the WebSocket, and a claim held was already lost if the freeze
   * exceeded the lease: treat every `resume` as a reconnect: end this session, rebuild it right away, register again.
   */
  const onFreeze = () => { yieldAll("hidden"); };
  const onResume = () => {
    conn.resumes++;
    const e = ep;
    if (!e) return;
    ep = null;
    if (readyState === "ready") setReady("pending");
    for (const w of [...snapshotWaiters.values()]) w({ type: "error" });
    try { e.close(); } catch { /* Already closed */ }
    redialAt = 0;
    redialDelay = REDIAL_MIN_MS;
  };
  if (typeof document !== "undefined") { document.addEventListener("freeze", onFreeze); document.addEventListener("resume", onResume); }
  const onPageHide = () => teardown("pagehide");
  if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);

  /* ---------------- render connection ---------------- */

  const dial = async () => {
    if (stopped || fatal || dialing || ep || !node) return;
    const url = currentSharedUrl();
    if (!url) return;
    dialing = true;
    let ticket: string | null = null;
    try {
      const r = await docRequest({ type: "auth.ticket", kind: "conn", role: "render", owner: { kind: "browser" } });
      if (r.type === "auth.ticket.ok" && typeof r.ticket === "string") ticket = r.ticket;
      else lastError = tr("Signing render ticket was refused: {0}", String(r.reason ?? r.type));
    } catch (e) {
      lastError = tr("Signing render ticket failed: {0}", String((e as Error)?.message ?? e));
    }
    dialing = false;
    if (stopped || fatal || !node || !ticket) { scheduleRedial(); return; }
    const protocols = ["promptcut.v1", `promptcut.ticket.${ticket}`];
    let e: DocEndpoint;
    try {
      e = createDocEndpoint({ url, protocols: () => protocols, transport: "ws", renew: false, backoff: { baseMs: 500, factor: 2, maxMs: 5000, jitter: 0.2 } });
    } catch (err) {
      lastError = tr("Creating render session failed: {0}", String((err as Error)?.message ?? err));
      scheduleRedial();
      return;
    }
    ep = e;
    conn.sessions++;
    e.onOpen(() => {
      if (ep !== e || !node) return;
      conn.opens++;
      redialDelay = REDIAL_MIN_MS;
      node.start();
    });
    e.onMessage((m) => {
      if (ep !== e || !m || typeof m !== "object") return;
      const reqId = typeof m.reqId === "string" ? m.reqId : null;
      const w = reqId ? snapshotWaiters.get(reqId) : undefined;
      if (w) { w(m); return; }
      node?.receive(m);
      if (m.type === "node.welcome" && node?.envFingerprint) setReady("ready");
    });
    const gone = (info: { code: number; reason: string }) => {
      if (ep !== e) return;
      ep = null;
      conn.closes++;
      conn.lastClose = { code: info.code, reason: String(info.reason ?? "").slice(0, 80) };
      if (readyState === "ready") setReady("pending");
      for (const w of [...snapshotWaiters.values()]) w({ type: "error" });
      if (FATAL_CLOSE.has(info.code)) { fatal = `closed-${info.code}`; teardown(fatal); return; }
      scheduleRedial();
    };
    e.onClose(gone);
    e.onConnectFail(gone);
  };
  const scheduleRedial = () => {
    if (stopped || fatal) return;
    redialAt = Date.now() + redialDelay;
    redialDelay = Math.min(REDIAL_MAX_MS, redialDelay * 2);
  };

  const openNode = (projectId: string) => {
    nodeProject = projectId;
    setReady("pending");
    node = createBrowserNode({
      nodeId, projectId, userId: me().userId ?? "", codeVersion: deps.eligibility().codeVersion ?? null, environment: pageEnvironment(),
      // Do not claim while this page is producing a stream itself: both paths share the same work from the background stage
      // Do not claim before measurement settles (the connection is opened first so the sparse version can be produced at measurement time); a page that only produces the sparse version for itself (mobile, single stage) never acts as a queue node
      now: Date.now, isIdle: () => !ownSparseOnly(deps.eligibility()) && settled && isIdle() && !pages.running(), busy,
      send: (m) => ep?.send(m) ?? false,
      keptProject: (rev) => kept.get(rev) ?? null,
      fetchSnapshot, bakeFrame, finishTask, lookupResult,
      streams: () => streamCap.capable, bakeStream, finishStream,
      onTaskEnd: (task, outcome) => {
        closeLease();
        if (outcome === "completed" || outcome === "dedup") { try { deps.onAlive?.(task.resultKey); } catch { /* The host is broken */ } }
      },
      onFingerprint: () => setReady("ready"),
      // Block N: registration for when user cards and media effect cards can be executed (runtime version, capability bits, card code identity), together with the cardEnvFingerprint returned by the document service
      cardInfo: () => getNodeCardInfo(),
      onCardEnvFingerprint: (fp) => setNodeCardEnvFingerprint(fp),
      onRefused: (reason) => { fatal = `refused-${reason}`; lastError = tr("Check-in refused: {0}", reason); teardown(fatal); },
    });
    redialAt = 0;
    redialDelay = REDIAL_MIN_MS;
  };

  let lastStop: { reason: string; at: number; debug: ReturnType<BrowserNode["debug"]> } | null = null;
  /** Go offline: release everything, end the session (section 2 "Going offline") */
  function teardown(reason: string) {
    const n = node;
    node = null;
    nodeProject = null;
    if (n) { try { n.stop(); } catch { /* The connection is broken */ } lastStop = { reason, at: Date.now(), debug: n.debug() }; }
    pages.stop(reason);
    closeLease();
    setNodeCardEnvFingerprint(null);
    const e = ep;
    ep = null;
    // Send the release messages first, then close (the session layer's close sends session.close first)
    if (e) setTimeout(() => { try { e.close(); } catch { /* Already closed */ } }, 50);
    setReady("none");
  }

  /**
   * Projects whose measurement round for opening the project has settled (section 2 "Measurement for opening the
   * project has settled (loading mask removed)"). After that, a newly added card being measured in the background
   * stage does not go offline: that is more urgent work in the single-flight queue, which `isIdle()` lets go first,
   * so there is no need to end the session and reconnect.
   */
  const measuredProjects = new Set<string>();
  const loop = () => {
    if (stopped) return;
    const projectId = deps.projectId();
    const raw = deps.eligibility();
    if (raw.measured && projectId) measuredProjects.add(projectId);
    const input = projectId && measuredProjects.has(projectId) ? { ...raw, measured: true } : raw;
    eligibility = browserNodeEligibility(input);
    const sparseOnly = ownSparseOnly(raw);
    settled = eligibility.ok || (sparseOnly && !!raw.measured);
    const ownCanConnect = sparseOnly && !!raw.online && !!raw.codeVersion && !!raw.member && isChromiumUserAgent(raw.userAgent);
    // All other conditions hold and only measurement has not settled: open the connection first, register as usual to get the fingerprint (needed to produce the sparse version at measurement time), but do not claim (`settled` is false)
    // A page with mobile identity and only one stage that meets the online member condition may open the render connection and register to get the fingerprint, so it can compute the stream key and produce its own sparse version, but it does not claim queue tasks
    connectable = !fatal && !!projectId && (eligibility.ok || eligibility.reason === "measuring" || ownCanConnect);
    if (!connectable || !projectId) {
      if (node) teardown(fatal ?? eligibility.reason ?? "no-project");
      // Someone has to advance the clock for the one the measurer is still waiting on
      try { pages.tick(); } catch (e) { lastError = String((e as Error)?.message ?? e); }
      return;
    }
    if (node && nodeProject !== projectId) teardown("project-changed");
    if (!node) openNode(projectId);
    probeStreams();
    if (!ep && !dialing && Date.now() >= redialAt) void dial();
    // Page hidden, parent page rAF gap: do not wait for the current frame, release immediately (D8)
    const bw = backWorkDiag();
    if (!bw.on && (bw.reason === "hidden" || bw.reason === "raf-gap")) yieldAll("hidden");
    if (getState().playing || isScrubbing()) lastInteractionAt = Date.now();
    try { node?.tick(); } catch (e) { lastError = String((e as Error)?.message ?? e); }
    try { pages.tick(); } catch (e) { lastError = String((e as Error)?.message ?? e); }
  };
  const timer = setInterval(loop, HOST_TICK_MS);
  // Block N: registration of which user cards and media effect cards this page can run (updated with the registry, gate and graphics capability)
  const offCardInfo = startNodeCardInfoLive();
  loop();

  const w = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : null;
  if (w) {
    w.__pcBrowserNode = () => {
      const d = node?.debug() ?? null;
      const ms = [...stage.ms].sort((a, b) => a - b);
      const sm = [...stage.smallMs].sort((a, b) => a - b);
      const up = uploader.stats();
      return {
        eligibility, fatal, ready: readyState, nodeId,
        state: d?.state ?? "off", reason: d?.reason ?? (fatal ?? eligibility.reason),
        envFingerprint: d?.envFingerprint ?? null, codeVersion: d?.codeVersion ?? null, holding: d?.holding ?? [],
        cardEnvFingerprint: d?.cardEnvFingerprint ?? null, cards: d?.cards ?? null,
        counters: d?.counters ?? null,
        idle: node ? isIdle() : false,
        stage: {
          frames: stage.frames, remounts: stage.remounts, pausedMs: Math.round(stage.pausedMs), errors: { ...stage.errors },
          // How many times the background stage was replaced, how many times a frame was redone after a mid-frame switch, how many isolated single-card projects were loaded (stageBake.ts)
          restage: baker.diag(),
          frameMs: { p50: quantile(ms, 0.5), p95: quantile(ms, 0.95) },
          smallFrames: stage.small, smallMs: { p50: quantile(sm, 0.5), p95: quantile(sm, 0.95) },
          phases: Object.fromEntries(PHASES.map((k) => { const a = [...phases[k]].sort((x, y) => x - y); return [k, { n: a.length, p50: quantile(a, 0.5), p95: quantile(a, 0.95) }]; })),
        },
        upload: { pushed: up.pushed, skipped: up.skipped, bytes: up.pushedBytes, failed: up.failed, reauth: up.reauth, recheck: up.recheck, lastError: up.lastError, ms: up.ms },
        manifests: { ...manifestStats },
        // Stream task: whether it can compress (which kind of picture was probed, which bitrate mode is used), how many segment tasks were done, how many frames were sent (how many of them fully transparent), how many segments and head files were pushed, how many times it yielded
        streams: (() => {
          const px = [...streamStats.pixelsMs].sort((a, b) => a - b), en = [...streamStats.encodeMs].sort((a, b) => a - b);
          return { capable: streamCap.capable, probe: streamCap.key || null, mode: streamCap.mode, reason: streamCap.reason,
            // How many encoders were started (both paths combined; the "do not produce if already found" acceptance check looks at this)
            encoders: streamStats.encoders,
            tasks: streamStats.tasks, frames: streamStats.frames, blank: streamStats.blank, segments: streamStats.segments, inits: streamStats.inits, bytes: streamStats.bytes,
            yields: streamStats.yields, resumedSegments: streamStats.resumedSegments, kept: streamKept.size, restage: streamBaker.diag(),
            pixelsMs: { p50: quantile(px, 0.5), p95: quantile(px, 0.95) }, encodeMs: { p50: quantile(en, 0.5), p95: quantile(en, 0.95) }, lastError: streamStats.lastError };
        })(),
        // This-page stream production (not via the queue): state, the stream of this version and where each segment went, counters
        pageStreams: pages.debug(),
        // Produce the sparse version at measurement time: how many times the hook was called, the reasons it did not enter `measure()`, the latest result
        measureSparse: { calls: measureStats.calls, skipped: { ...measureStats.skipped }, last: measureStats.last, settled, connectable },
        connection: { connected: !!ep?.connected, transport: ep?.stats().transport ?? null, ...conn },
        kept: [...kept.keys()],
        lastError: d?.lastError ?? lastError,
        lastStop: lastStop && { reason: lastStop.reason, at: lastStop.at, counters: lastStop.debug.counters },
      };
    };
  }

  return () => {
    stopped = true;
    clearInterval(timer);
    offCardInfo();
    offMeasured();
    teardown("unmount");
    pages.stop("unmount");
    baker.dispose();
    streamBaker.dispose();
    dropPixels();
    offStore();
    offScrub();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
    }
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
    if (w) delete w.__pcBrowserNode;
  };
}

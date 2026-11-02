/**
 * Stage <-> parent page postMessage RPC (E0).
 *
 * - One client per iframe instance (`createStageRpc`); requests carry auto-incrementing ids and
 *   responses are matched by id; when an iframe changes (hot reload, unmount), switch to a new
 *   client, rejecting all requests pending on the old client with `detached`; likewise if the
 *   target window closes (iframe removed from DOM): checked when sending requests and polled every
 *   `CLOSED_POLL_MS` while requests are pending.
 * - **Time is always in seconds** (`setTime(tSec)`, `render(tSec)`, `play(fromSec)`,
 *   `setMediaT(tSec)`, `caughtUpAtSec` in responses, `sec` in events); stage converts to
 *   milliseconds internally (stageClock's `now` is in milliseconds).
 * - Stage → parent page has only seven events (`StageEvent`) besides `pc-stage-ready` handshake
 *   and RPC responses; parent page filters sources by `event.source`: `frame` / `ended` /
 *   `settled` / `demote` only recognize current `front`, while `mediaReady` / `probe` /
 *   `probe-frame` only recognize current `back` (takes effect in Step 4 E1 dual stage; in Step 3
 *   single stage, all come from the same iframe).
 * - Currently same-origin, cross-origin after Step 4 E1; protocol contains nothing dependent on
 *   same-origin (no passing functions, no passing DOM, only structured-cloneable values).
 */
import type { Project } from "../kernel/project";
import type { RectWithBounds, RectsWithBoundsOptions, StageHit } from "./solid";
import type { ProjectPatch } from "./changedClips.mjs";
import type { CardCostRecord } from "./cardCostKey.mjs";
import type { StreamPlaneRequest } from "./streamPlayer";
import { sanitizeRpcError, sanitizeRpcResult, sanitizeStageEvent } from "../online/stageMessageGuard.ts";
import { SETTLE_MAX_MS, SETTLE_RPC_CAP_MS } from "./settleFrame.ts";
import type { SettleResult } from "./settleFrame";
import type { CardRunState } from "../kernel/registry.ts";

export type { StreamPlaneRequest };

export type StageRole = "front" | "back";
export type BackJob = "probe" | "catchup" | "bake";

export interface HostCapabilities {
  /** Prerender process exists in local mode (notified by parent page via iframe src query string; stage does not detect on its own) */
  prerender: boolean;
  /** OffscreenCanvas webgl2 is available inside the Worker */
  offscreenGl: boolean;
  /**
   * Only one stage (online page stage gate stays at level 1, lowest tier, falls back to single
   * stage on handshake failure; parent page passes `compact=1` in src query string): canvas card
   * atlas uses smaller cap, and background role does not start a Worker when using Route 1.
   * Always false in desktop runtime environment.
   */
  compact: boolean;
  /**
   * Initial canvas render route (for online page, given by parent page via `gl=` in src query
   * string according to stage gate; when trying level 3, parent page switches via `setGlRoute`).
   * Omitted in desktop runtime environment, following project options (`project.glRoute`) and
   * defaults (one set each for Route 1).
   */
  glRoute: "perDocument" | "shared" | null;
  /**
   * Lowest tier (parent page passes `lowest=1` on online page): assets initially use only small
   * size without waiting for parent page's tier selection policy. Always false in desktop runtime
   * environment.
   */
  lowest: boolean;
  /**
   * This stage is accompanied by a background stage (dual stage, parent page passes `dual=1`
   * in src query string): able to measure card costs on background stage (Section 2 of C10 contract
   * "report host capability table truthfully"; online page also reports true if background stage
   * is enabled). False for single stage.
   */
  measure: boolean;
  /** Able to catch up to exact live render on background stage before swapping (K5 route 2); same conditions as `measure` */
  catchUp: boolean;
  /**
   * Stage id (`A` / `B`) passed by parent page in src query string. **Instance name only,
   * unrelated to role** (E1): roles are decided solely via `setRole`; either iframe can serve
   * as `front`, and they will swap midway through (K5).
   */
  stageId: string;
}

export interface StageReadyMessage {
  type: "pc-stage-ready";
  hostCapabilities: HostCapabilities;
}

/**
 * Three durations of snapshot generation (task brief 3.8): **accumulated** across each frame
 * pushed in a single `render` / `setTime`. None of the three enter heavy classification: heavy
 * classification only looks at live render `stepMs`.
 */
export interface SnapshotCost {
  /** Style inlining (including DOM cloning) */
  inlineMs: number;
  /** Canvas rasterization (0 for cards without canvas) */
  rasterMs: number;
  /** Asset layer placeholder + serialization */
  serializeMs: number;
}

/**
 * K1 probes are split into two passes (task brief K1, confirmed by user, 2026-09-22).
 * - `'time'` **timing pass**: advances only, does not generate snapshots, does not post
 *   `probe-frame`; capped by `PROBE_MAX_FRAMES` / `PROBE_MAX_MS` (**not truncated by single-tick
 *   budget**: the old approach caused all 61 frame-push cards to push only 1-10 frames);
 *   response carries `steps` (live render duration of each frame), `stepMs` takes its robust value,
 *   and `catchUpMs` takes its sum.
 * - `'snapshot'` **snapshot pass**: advances first for each frame, then generates snapshots and
 *   posts `probe-frame`, measuring the three snapshot durations; still constrained by single-tick
 *   budget, its truncation does not affect any classification.
 *
 * - `'booleans'` **two-pass boolean probe** (added in R4b): `vtOk` / `seekOk` / `seekMs`. The whole
 *   pass runs inside the stage (it requires `pinner.syncIn` to pin subtree virtual time, which
 *   parent page cannot reach), and response carries `booleans`. Each of the three passes first
 *   resets according to K3's "remount positioning recipe", capped at `PROBE_BOOL_FRAMES` frames
 *   or `PROBE_BOOL_MS` each; **generated snapshots never post `probe-frame`** (by definition they
 *   may differ from correct frames, and saving them would overwrite correct dead assets).
 *
 * `true` is equivalent to `'snapshot'` (for compatibility with legacy callers).
 */
export type ProbeMode = "time" | "snapshot" | "booleans";

/**
 * Results of two-pass boolean probe in K1 (pinned division axis 1 "how to distinguish SeekOK").
 *
 * - `vtOk`: whether it can be pushed using only **subtree virtual time** (`pinner.syncIn` +
 *   component-local `t`, global clock stationary). Determines which frame catch-up path
 *   K3(b) / K5 takes. Motion JS animations reading global frame loop timestamps cannot be
 *   advanced, yielding `false`.
 * - `seekOk`: whether it can be **pinned in one step** to target frame (without passing
 *   intermediate frames), yielding results identical to pushing to that frame frame by frame.
 *   **Looks only at result consistency, not cost**: cost is K2's concern.
 * - `seekMs`: wall-clock time (`__pcRealNow`) to pin directly from frame 0 to the last frame
 *   of the clip. Recorded as `null` (unknown) if exceeding `PROBE_BOOL_MS`: recording cap value
 *   followed by linear scaling yields an optimistic lower bound; K2 treats `null` according to
 *   frame-push card rules uniformly, conservative just like extrapolation criteria when
 *   `catchUpMs` is truncated.
 */
export interface ProbeBooleans {
  vtOk: boolean;
  seekOk: boolean;
  seekMs: number | null;
}

export interface RenderResult {
  remounted: boolean;
  caughtUpAtSec: number;
  elapsedMs: number;
  /**
   * **Live render duration**: `elapsedMs` minus time spent generating snapshots on this run (task
   * brief 3.3 / 3.8). Only this enters heavy classification (`capped = stepMs > B`). When `probe`
   * is omitted, = `elapsedMs`.
   */
  stepMs: number;
  /** First pass of probe: how many frames pushed, and whether truncated by the ceiling */
  frames?: number;
  truncated?: boolean;
  /** Present only during probe */
  snapshot?: SnapshotCost;
  /**
   * Present only when `probe: 'time'`: live render duration of **each frame** (measured by
   * `__pcRealNow`, excluding time yielded between frames and excluding snapshot generation).
   * `stepMs` takes its percentile (`robustStep`) rather than a single maximum: under a 2-core
   * limit, the worst single frame between two measurements of the same card can differ by more
   * than 10x; what crosses the line is sporadic stutter, not a stable cost.
   */
  steps?: number[];
  /**
   * Present only when `probe: 'snapshot'`: duration of those three stages of snapshot generation
   * for **each frame**.
   *
   * The `snapshot` for the same pass is the **accumulation** of these (used for "how long this pass
   * took"), whereas the cost record requires the **robust single-frame value** (`robustStep`, task
   * brief K1), and accumulated values cannot be converted back. Offline probes had to send `render`
   * once per frame (40 roundtrips) to get frame-by-frame numbers; resident probes run under the
   * loading overlay, where 40 × N roundtrips is too slow, so frame-by-frame samples are returned
   * here symmetrically with `steps`, needing only a single roundtrip.
   */
  snapshotSteps?: SnapshotCost[];
  /** Present only when `probe: 'booleans'` */
  booleans?: ProbeBooleans;
}
/**
 * Response when `render` is aborted / rejected. Parent page rules differ for each reason (E0):
 *   - `superseded`: aborted by parent page's own new `render`, **discard directly**, resending
 *     will only abort the new one again;
 *   - `project`: aborted by `setProject`, resend according to current target (up to 3 times);
 *     the **exception** is when `back` is currently in `job: 'catchup'` (catch-up run / project
 *     fed by page-side measurement itself), in which case discard unconditionally: the gate
 *     decides by work item, not by the `settling` flag (`renderAbortAction` in stageJobs.ts);
 *   - `timeout`: K1 probe cap, neither resend nor treat as error (truncated ≠ `capped`);
 *   - `role`: E1 role gate, received stage is not `back`. **Treat as error, do not resend**:
 *     resending will still have the same role;
 *   - `detached`: created by RPC client itself when iframe is replaced / unmounted. Discard the
 *     response and resend current target with new client.
 */
export interface RenderAborted {
  aborted: true;
  reason: "superseded" | "project" | "timeout" | "role" | "detached";
  elapsedMs?: number;
  stepMs?: number;
  frames?: number;
  truncated?: boolean;
  snapshot?: SnapshotCost;
  steps?: number[];
  snapshotSteps?: SnapshotCost[];
}
export type RenderReply = RenderResult | RenderAborted;

export interface SetTimeOptions {
  /** C4 snapshot delta, takes effect in the same commit as t (step 4) */
  snapshots?: Record<string, string | null>;
  /** Clips to add `.pc-awaiting` to this time (step 4) */
  awaiting?: string[];
  /** Start K5 paused live render (step 4) */
  settle?: true;
  /** K1 probe: takes seek path, waits for real rAF, generates snapshot for this control; response carries 4 numbers */
  probe?: true;
}
export interface SetTimeResult {
  /** Only present during probe: wall clock measured by `__pcRealNow` (includes wait for that real rAF) */
  elapsedMs?: number;
  /**
   * Only present during probe: **live render duration**, the only number used to classify as heavy
   * (task brief 3.3 / 3.8). Measures the span `clock.set` → `flushSync` → pin animations → `settle`,
   * **excluding** the wait for that one real rAF (which is at least one VSync, ~17 ms; see last item
   * of 3.8), and excluding generating snapshots.
   */
  stepMs?: number;
  /** Only present during probe: durations of the three stages of generating snapshots */
  snapshot?: SnapshotCost;
  /**
   * Only present during probe when canvas cards exist (R9 M4): per-card GPU time reported by GL
   * Worker (milliseconds, wall clock before and after `gl.finish()`). For diagnostics, not used to
   * classify as heavy: `stepMs` for classifying as heavy already includes `beat → done` round trip.
   */
  glGpuMs?: Record<string, number>;
  /** Path taken by this setTime, for acceptance check and debugging */
  path: "continuous" | "set";
}
/**
 * `setTime` with `probe: true` hits role gate (E1): received stage is not `back`. Same rule
 * as `render` `role`: parent page treats as error and does not resend. `setTime` without `probe`
 * is accepted by both roles (scrub sent to `front`, D4 page-side measurement sent to `back`), so
 * it will not reach here.
 */
export interface SetTimeAborted {
  aborted: true;
  reason: "role";
}
export type SetTimeReply = SetTimeResult | SetTimeAborted;

export interface RenderOptions {
  /** true = remount and advance from mountFrameOf to tSec; default = resume advance (no remount, advance from clock.now() to tSec) */
  jump?: boolean;
  maxCatchUp?: number;
  /** K1 probe pass type (see `ProbeMode`). `true` equals `'snapshot'`. */
  probe?: true | ProbeMode;
  /** Frame cap. If omitted for timing pass, `PROBE_MAX_FRAMES` is used. */
  maxFrames?: number;
}

export interface SetProjectOptions {
  /** Entire replacement of full project */
  reset?: boolean;
}
export interface SetRoleOptions {
  job?: BackJob;
}

/**
 * M7 snapshot generation for a single frame (contract `docs/plan/m7-contract.md` sections 4.3, 4.4;
 * runs in D3 background stage): parent page first feeds isolated single-card project into
 * background stage via `pushProject('back', isolated single-card project, { reset })`, then sends
 * this frame by frame. Stage advances to this frame, generates a snapshot, extracts HTML of this
 * control, computes sha256, compresses with gzip, and rasterizes to WebP via `foreignObject` when
 * small size is requested; bytes are transferred with message via `bake-frame` events, response
 * carries only digest.
 *
 * Frame-advancing criteria: `mode: 'seq'` (default): advances sequentially from previous frame,
 * advancing from the beginning only when continuity is lost (probe P2: equivalent to desktop 4
 * frames per batch for DOM standalone cards, 4-7x cheaper); `mode: 'batch4'`: consistent with
 * desktop prerender, aligning batch starts to 4 frames, advancing each batch from the beginning
 * (remount, advance from mount frame to this frame). Each frame passes readiness gate before
 * generating a snapshot (async control work, fonts, images, same as prerender `waitFrameReady`);
 * returns `not-ready` if not ready within 20 seconds (this segment fails, producing no blank
 * frame). Checks background work stop flag (`setBackWork`) between frames; duration blocked by gate
 * is recorded separately (`pausedMs`), not counted in duration.
 *
 * When pixels are requested (`pixels`, `docs/plan/browser-stream-task.md` third occurrence; used by
 * browser nodes producing track streams): after generating a snapshot, follows prerender small-size
 * path (`bakeSmall.ts`: wrap snapshot in SVG `foreignObject`, embed page stylesheet, draw onto
 * canvas) to render this `rect` block at **original size**, and transfers bitmap (`ImageBitmap`,
 * with transparency) to parent page via `bake-frame` event. `rect` is in wrapper layer's own
 * coordinates (origin at top-left of box, can be negative: outside box reserved for shadows and
 * strokes), which is the track stream's `bound`.
 */
export interface BakeFrameRequest {
  /** Session id of this segment (task id + token), returned as-is by `bake-frame` event */
  session: string;
  clipId: string;
  /** Local frame number (global frame number in an isolated single-card project) */
  localFrame: number;
  mode?: "batch4" | "seq";
  /** Whether to output prerender small size */
  small?: boolean;
  /** Request pixels: draw this rectangle (wrapper layer coordinates, integer, even width/height) at original size as bitmap, sent to parent page with event */
  pixels?: { rect: BakePixelRect };
  /** When `false`, event omits HTML bytes (saves compression and transfer for pixel-only callers); `hash` and `bytes` still sent. Default includes */
  html?: boolean;
  /**
   * Cards in cut segments (`clipId` is a flattened virtual clip, [ruling R02]): time in isolated
   * project is not translated, local frame n is project frame `frameBase + n` (`bakeFrameBase`
   * in `online/bakeTask.ts`). Omitted for top-level cards (local frame is global frame).
   */
  frameBase?: number;
}
/** Rectangle when `bakeFrame` requests pixels: wrapper layer coordinates (origin at box top-left), in project pixels */
export interface BakePixelRect { x: number; y: number; w: number; h: number }
export type BakeFrameReply =
  | { ok: true; localFrame: number; hash: string; bytes: number; small: { hash: string; bytes: number } | null; ms: number; pausedMs: number; remounted: boolean; smallMs: number; readyMs: number;
    /** When pixels are requested: time spent rendering this bitmap (milliseconds) */
    pixelsMs?: number }
  | { ok: false; reason: "unsupported" | "role" | "no-project" | "no-clip" | "cancelled" | "lossy" | "no-control" | "frame-mismatch" | "small-failed" | "not-ready" | "pixels-failed"; detail?: string };
export interface SetRoleReply {
  ok: boolean;
  reason?: "unsupported";
}
/**
 * Response shared by `play` / `pause` (K4). In step 3, inline response of `play` and `PauseReply`
 * were two shapes; R2 unified them into this one, with **`ok` required**: caller checks `ok`
 * before accessing other fields, without guessing default values.
 *
 * Three cases:
 *   - `{ ok: true, stoppedAt }`: stopped at this second (= `sec` of last tick). Returned for
 *     immediate stop without `atSec`, arrival of armed stop with `atSec`, and when loop was
 *     already stopped (after `ended` / repeated `pause()`);
 *   - `{ ok: true, passed: true }`: that tick of armed stop **has already posted** (current tick
 *     sequence number ≥ tick sequence number of `atSec`), does not stop: otherwise that tick
 *     would never be awaited and RPC would never respond;
 *   - `{ ok: false, reason }`: cannot perform. R2 stage does not yet have a tick loop (K4 is
 *     R5 work), so `play` / `pause` always returns `{ ok: false, reason: 'unsupported' }`.
 */
export type PlayReply =
  | { ok: true; stoppedAt: number; passed?: undefined }
  | { ok: true; stoppedAt?: undefined; passed: true }
  | { ok: false; reason: string };

/** Methods exposed by stage to parent page (all async, with request id) */
export interface StageRpcApi {
  setProject(project: Project | ProjectPatch, opts?: SetProjectOptions): Promise<{ ok: true }>;
  setTime(tSec: number, opts?: SetTimeOptions): Promise<SetTimeReply>;
  render(tSec: number, opts?: RenderOptions): Promise<RenderReply>;
  hitTest(x: number, y: number): Promise<StageHit | null>;
  rectsWithBounds(opts?: RectsWithBoundsOptions): Promise<RectWithBounds[]>;
  size(): Promise<{ width: number; height: number }>;
  setProxy(on: boolean): Promise<{ ok: true }>;
  setRole(role: StageRole, opts?: SetRoleOptions): Promise<SetRoleReply>;
  /** K2 dispatch table + K1 per-card records (used in step 4; stage only stores them in step 3) */
  setPlan(plan: { plan: unknown; costs: CardCostRecord[] }): Promise<{ ok: true }>;
  /** K4 (R5): R2 stage does not yet have a tick loop, both return { ok: false, reason: 'unsupported' } */
  play(fromSec: number): Promise<PlayReply>;
  pause(opts?: { atSec?: number }): Promise<PlayReply>;
  setSuppressed(clipIds: string[]): Promise<{ ok: true }>;
  /**
   * G1 / C3 stream planes (synthesized by parent page from layers with `kind: 'stream'` in ready
   * index). Element shape remains `{ clipIds }`; R8 added two optional fields: `key` (stream key)
   * and `ranges` (closed interval of ready segment numbers): `streamPlayer` in stage uses them
   * to pull segments; planes without `key` only act as placeholders and do not decode (callers
   * prior to R8 still send only `clipIds`).
   * Also carries `originFrame`: first frame of this stream itself (project frame number); segments
   * start from it at 15 frames per segment (`streamSegments.mjs`); stage uses it to convert frame
   * number of this tick into a segment number, and planes without it likewise only act as
   * placeholders and do not decode.
   * Below-dependent streams also carry `plane: "stage"`: only one target card, but produced in
   * stage coordinates; stage mounts its canvas under stage root (same as group stream), not inside
   * wrapper layer.
   */
  setStreamPlanes(planes: StreamPlaneRequest[]): Promise<{ ok: true }>;
  setScrubbing(on: boolean): Promise<{ ok: true }>;
  setPlaying(on: boolean): Promise<{ ok: true }>;
  setMediaT(tSec: number): Promise<{ ok: true }>;
  setLocalHashes(hashes: string[]): Promise<{ ok: true }>;
  /**
   * c10a section 8: stage-side tier selection policy (`setMediaTierPolicy` in `mediaTier.ts`). Sent
   * once by parent page after handshake, and sent again when ticket renewal or asset gate results
   * change (network speed fast/slow switch, decode ceiling lowered). Default (omitted) = desktop
   * runtime environment.
   */
  setMediaPolicy(policy: StageMediaPolicy): Promise<{ ok: true }>;
  /**
   * Online page: switch WebGL rendering route for canvas cards (parent page sends `perDocument`
   * when stage gate tests level three "one renderer set per stage for both stages"). Stage switches
   * in place (`glHost.setRoute`) without recreating stage. When responding, new route is already
   * effective. Not sent in desktop runtime environment (route follows project options).
   */
  setGlRoute(route: "perDocument" | "shared"): Promise<{ ok: true; route: "perDocument" | "shared"; mode: string }>;
  /**
   * C10 contract section 9 "Recognition": user cards recognized by online page from content store
   * card source code (this machine does not have their code, "known but cannot run locally").
   * Sent once by parent page after handshake, and sent again when table changes; stage writes into
   * its own registry (`registry.setSyncedUserCards`). Sent only by online page, not sent in desktop
   * runtime environment.
   */
  setSyncedUserCards(entries: { id: string; name: string; source?: string }[]): Promise<{ ok: true; changed: boolean }>;
  /**
   * Parent page's preview zoom factor at this moment (the number by which stage iframe is scaled to
   * preview box via CSS `scale`). Stage placeholders compensate using it (`placeholderFit.ts`):
   * hourglass maintains original size on screen (only cancels out preview zoom).
   * Sent once by parent page after handshake, and sent again when factor changes; sent by both
   * desktop and online.
   */
  setViewScale(scale: number): Promise<{ ok: true }>;
  /** A3c: patch is delta relative to previous delivery, null = detach; reset = clear all before applying */
  setSnapshots(patch: Record<string, string | null>, opts?: { reset?: boolean }): Promise<{ ok: true; bytes: number }>;
  /**
   * Single stage "stop and catch up to the current frame" (`settleFrame.ts`): when there is only one
   * stage, the parent page sends it after a pause, click, scrub release, or reaching the end of playback
   * (after `setTime`). The stage live-renders all cards for the current frame once (heavy cards are also
   * drawn); as each layer finishes rendering, it removes the fallback and swaps in the live render layer;
   * no timeout is set (`timeoutMs` is only for testing and diagnostics). The response is returned only
   * after everything has finished rendering. A new `setTime` / `play` / `setProject` / `setRole`
   * interrupts it (returning `ok: false, reason: 'superseded'`).
   */
  settleLayers(tSec: number, opts?: { timeoutMs?: number | null }): Promise<SettleResult>;
  /**
   * Start / stop of background work (C10 contract section 2 "Background Stage Placement and
   * Ticks"): background stage is stacked in place with `opacity: 0`; `requestIdleCallback` inside
   * stage is unreliable, so editor page determines idle state (page visible, parent page rAF
   * interval not continuously exceeding 500 ms, parent page's own rIC calling back) and sends
   * start / stop via this RPC. Stage advances frame by frame using `setTimeout(0)`, checking stop
   * flag between frames; waits while stopped, without dropping work.
   * Default (omitted) = on (desktop runtime environment).
   */
  setBackWork(on: boolean): Promise<{ ok: true }>;
  /** M7: snapshot generation frame (see `BakeFrameRequest`); only runs on online-build background stage, elsewhere returns `unsupported` */
  bakeFrame(req: BakeFrameRequest): Promise<BakeFrameReply>;
  /** M7: stop frame being advanced (stops at frame boundary; in-flight `bakeFrame` returns `cancelled`), clears sequential advance resume point */
  bakeCancel(): Promise<{ ok: true }>;
  /**
   * Online execution of synced user cards and media effect cards (`docs/plan/online-card-exec-contract.md`
   * sections 2 and 8): editor page sends transpiled bundle (full) to stage. Bundle contains only
   * transpiled output (`CardBundle` in `src/online/cardRuntime/protocol.ts`), **without any
   * credentials or tickets**. Stage records it first and executes only when its own execution gate
   * is open (`online/isolation/execGate.ts`; visual output does not require separate egress
   * interception); if gate opens late, it executes then; load results are reported back via
   * `card-states` event. `opts.sound`: this instance starts sound thread simultaneously (stage
   * instance B; threads follow instances, not roles), results reported back via `sound-state`
   * event. Desktop runtime environment and same-origin single stage return `{ ok: false }`.
   */
  loadUserCards(bundles: unknown[], opts?: { sound?: boolean }): Promise<LoadUserCardsReply>;
  /**
   * Audio for synced user cards and media effect cards (contract 3.5): request a sample chunk in
   * sound thread started on this stage. Request shape see `StageSoundRequest` in
   * `src/online/cardRuntime/stageSound.ts`. Throws error if there is no sound thread (not started,
   * gate closed).
   */
  synthCardAudio(request: StageSoundRpcRequest): Promise<Float32Array>;
}

export interface LoadUserCardsReply {
  ok: boolean;
  /** When `ok` is false: `unsupported` = document does not execute (desktop, same-origin single stage); `gate` = gate closed (bundle saved, auto-executes when open) */
  reason?: "unsupported" | "gate";
}

export interface StageSoundRpcRequest {
  projectKey: string;
  project?: unknown;
  nodeId: string;
  start: number;
  count: number;
  sampleRate: number;
}

/** Graphics capability of this stage (contract 4.3): `ok` can run media effect cards; others are insufficiency reasons; `unknown` = not evaluated yet (no media effect cards mounted yet) */
export type StageGraphCapability = "unknown" | "ok" | "no-webgl2" | "software" | "texture" | "context-lost";

export type StageEvent =
  | { type: "mediaReady"; sec: number }
  | { type: "frame"; sec: number }
  | { type: "ended"; sec: number }
  | { type: "settled"; sec: number; clipIds: string[] }
  /**
   * A score record for K1. Reports only **measurement values**: `device` / `measuredAt` / `mode` /
   * `demoted` are filled in by parent page before PUTting entire record (task brief 3.3). Four
   * numbers reported separately (3.8): `stepMs` is worst single frame of live render, the only
   * number used to classify as heavy; `inlineMs` / `rasterMs` / `serializeMs` are single-frame
   * worsts for each of the three snapshot generation stages, used only to schedule capacity. Old
   * `frameMs` (including single-frame worst of snapshot generation) has been deleted without
   * compatibility.
   */
  | { type: "probe"; identityKey: string; fps: number; stepMs: number; inlineMs: number; rasterMs: number; serializeMs: number; catchUpMs: number; capped?: boolean; kind: "random" | "stepped"; vtOk?: boolean; seekOk?: boolean; seekMs?: number | null }
  | { type: "demote"; clipId: string }
  /**
   * A frame advanced by K1 probe. Cross-origin online stage (C10 contract section 2 "Compress
   * Large Outputs into Transferable ArrayBuffers") does not transfer large strings directly:
   * `html` is empty string, gzip-compressed bytes provided in `htmlGz` instead (transferred
   * with postMessage without copying), parent page unpacks with `probeFrameHtml`.
   */
  | { type: "probe-frame"; clipId: string; localFrame: number; html: string; htmlGz?: ArrayBuffer }
  /**
   * One frame of M7 snapshot generation (`bakeFrame` output, contract section 4.3): `hash` is
   * sha256 of raw HTML bytes (computed via WebCrypto in stage), `htmlGz` is gzip-compressed HTML
   * (`htmlRaw` gives raw bytes when unable to compress), `small` is prerender small-size WebP;
   * all bytes transferred with message. When pixels requested (`BakeFrameRequest.pixels`), `pixels`
   * is also included: bitmap of `rect` area drawn at original size (transferred with message;
   * receiving party must call `close()` after use).
   */
  | { type: "bake-frame"; session: string; clipId: string; localFrame: number; hash: string; bytes: number; htmlGz?: ArrayBuffer; htmlRaw?: ArrayBuffer;
    small?: { hash: string; bytes: number; webp: ArrayBuffer } | null;
    pixels?: { rect: BakePixelRect; bitmap: ImageBitmap } | null }
  /**
   * Online execution of user cards and media effect cards: runtime status of each synced card in
   * this stage (entire set; card id → status, contract section 8), together with graphics capability
   * of this stage and "whether the visual half executes on this stage". Sent by both stages
   * (regardless of role); parent page accepts as untrusted input (`online/stageMessageGuard.ts`).
   */
  | { type: "card-states"; states: [string, CardRunState][]; graph: StageGraphCapability; visual: boolean }
  /**
   * Asset gate network speed (how fast assets are actually downloaded as seen by stage of online
   * page, `render/netSpeed.ts`): reported once when whether to fetch small size first or fetch
   * only original size changes; parent page records it into inspection port.
   */
  | { type: "net-speed"; mbps: number | null; samples: number; smallFirst: boolean }
  /** Sound thread status (shape matches `StageSoundState` in `src/online/cardRuntime/stageSound.ts`); `state: null` = this stage has no sound thread */
  | { type: "sound-state"; state: { ready: Record<string, string>; blocked: Record<string, string> } | null };

export const STAGE_EVENT_TYPES = new Set<StageEvent["type"]>(["mediaReady", "frame", "ended", "settled", "probe", "demote", "probe-frame", "bake-frame", "card-states", "sound-state"]);
/** Events sent by both stages regardless of role: parent page listens directly on each RPC client, bypassing role filtering in `stageBridge` */
export const STAGE_ANY_ROLE_EVENTS = new Set<StageEvent["type"]>(["card-states", "sound-state"]);

/**
 * Which role each event **only accepts** from (last item of E0: parent page filters source by
 * `event.source`).
 *
 * `frame` / `ended` / `settled` / `demote` belong to player stage, accepting only current `front`
 * iframe; `mediaReady` / `probe` / `probe-frame` belong to background stage, accepting only current
 * `back` iframe. **Without filtering, duplicate `tick`s occur**: during K5 role swap tick, both
 * stages may post (old `front` stops only after completing current tick, while new `front` has
 * already started reporting `frame`).
 *
 * Filtering takes place in `onStageEvent` of `stageBridge.ts`: only there knows both "which client"
 * and "what role it currently has". The `e.source !== target` check at `createStageRpc` layer
 * solves only the former.
 */
const FRONT_EVENT_TYPES = new Set<StageEvent["type"]>(["frame", "ended", "settled", "demote"]);

/** Which role's stage should emit this kind of event */
export function stageEventRole(type: StageEvent["type"]): StageRole {
  return FRONT_EVENT_TYPES.has(type) ? "front" : "back";
}

interface RpcRequest {
  type: "pc-rpc";
  id: number;
  method: keyof StageRpcApi;
  args: unknown[];
}
interface RpcReply {
  type: "pc-rpc-reply";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export const isRpcRequest = (d: unknown): d is RpcRequest => !!d && typeof d === "object" && (d as RpcRequest).type === "pc-rpc" && typeof (d as RpcRequest).id === "number";
export const isRpcReply = (d: unknown): d is RpcReply => !!d && typeof d === "object" && (d as RpcReply).type === "pc-rpc-reply" && typeof (d as RpcReply).id === "number";
export const isStageEvent = (d: unknown): d is StageEvent => !!d && typeof d === "object" && STAGE_EVENT_TYPES.has((d as StageEvent).type);

export interface StageRpcClient extends StageRpcApi {
  /** The iframe window bound to this client */
  readonly target: Window;
  /** Subscribe to stage events (only receives those sent by this iframe) */
  onEvent(listener: (e: StageEvent) => void): () => void;
  /** iframe replaced / unmounted: pending requests rejected as detached, stops receiving messages */
  dispose(): void;
  readonly disposed: boolean;
}

const METHODS: (keyof StageRpcApi)[] = ["setProject", "setTime", "render", "hitTest", "rectsWithBounds", "size", "setProxy", "setRole", "setPlan",
  "play", "pause", "setSuppressed", "setStreamPlanes", "setScrubbing", "setPlaying", "setMediaT", "setLocalHashes", "setSnapshots", "setMediaPolicy",
  "setSyncedUserCards", "setViewScale", "settleLayers", "setGlRoute", "setBackWork", "bakeFrame", "bakeCancel", "loadUserCards", "synthCardAudio"];

/**
 * When requests are pending, check whether the target window is still alive at this interval.
 *
 * **Why this is needed**: After an iframe is removed from the DOM, `postMessage` calls sent to it
 * are **silently discarded** by the browser, throwing no error and never returning a response;
 * meanwhile, `call()` generally sets no timeout (`render` / armed stop `pause` may wait a long
 * time to begin with, and a blanket timeout would kill them prematurely; see
 * STAGE_UPDATE_TIMEOUT_MS for exceptions). Previously, the only way out was waiting for the next
 * `pc-stage-ready` to `dispose()`: that time when the 3D page unmounted the stage iframe, `play()`
 * hung for a full minute like this, with the playhead not moving at all. Once a window is closed,
 * returning a response is impossible, so judging by "closed" is more accurate than judging by
 * duration: not a single living slow request is killed prematurely.
 */
export const CLOSED_POLL_MS = 1000;
/**
 * Exceptions: `setSnapshots` and `setTime` without `probe` are short updates completed
 * synchronously in the stage, and even an alive window may drop responses (when the stage iframe
 * reloads in place, `contentWindow` remains unchanged and `closed` stays false, but the new
 * document does not recognize the old request id). These two are judged by duration: if no response
 * arrives after this long, reject it, and the caller invalidates the delivery baseline and
 * redelivers (C10a). `setTime` with `probe` must wait for strict beats and task boundaries; heavy
 * cards on a busy machine may take a long time, so it still has no time limit.
 */
export const STAGE_UPDATE_TIMEOUT_MS = 8000;
/**
 * Calls with a time limit (`synthCardAudio`, `settleLayers` with a given time limit) are
 * guaranteed to receive a stage response within the limit; reloading an alive window in place
 * drops responses, so the parent page determines timeout by "its time limit + this amount".
 * A `settleLayers` without a time limit is judged by `SETTLE_RPC_CAP_MS`.
 */
export const STAGE_RPC_SLACK_MS = 3000;
/**
 * Maximum wait for a response when generating snapshots for a frame in M7: reloading an alive
 * window in place drops responses (same reason as `STAGE_UPDATE_TIMEOUT_MS`), and the parent page
 * must be able to let go. Time blocked by background live gates is also included, so it is given
 * generously; if it really times out, return it as a retryable failure.
 */
export const BAKE_FRAME_TIMEOUT_MS = 120_000;
/** How long to wait (in milliseconds) if this call determines timeout by duration; returns null if not judged by duration */
export function stageCallTimeoutMs(method: string, args: unknown[]): number | null {
  if (method === "bakeFrame") return BAKE_FRAME_TIMEOUT_MS;
  if (method === "loadUserCards") return STAGE_UPDATE_TIMEOUT_MS;
  if (method === "synthCardAudio") {
    // The sound thread has its own time limit (2 seconds wall clock per second of sound, minimum
    // 10 seconds, plus 20 seconds for loading cards); reloading an alive window in place will drop
    // responses, so the parent page determines timeout slightly more generously than its time limit
    const r = args[0] as { count?: unknown; sampleRate?: unknown } | undefined;
    const sec = Number(r?.count) / Math.max(1, Number(r?.sampleRate) || 48_000);
    return Math.max(10_000, Math.ceil((Number.isFinite(sec) ? sec : 0) * 2000)) + 20_000 + STAGE_RPC_SLACK_MS;
  }
  if (method === "settleLayers") {
    const ms = Number((args[1] as { timeoutMs?: unknown } | undefined)?.timeoutMs);
    return Number.isFinite(ms) && ms > 0 ? Math.min(ms, SETTLE_MAX_MS) + STAGE_RPC_SLACK_MS : SETTLE_RPC_CAP_MS;
  }
  if (method === "setGlRoute") return STAGE_UPDATE_TIMEOUT_MS;
  return isShortStageUpdate(method, args) ? STAGE_UPDATE_TIMEOUT_MS : null;
}
/** Calls judged by duration (see STAGE_UPDATE_TIMEOUT_MS) */
export function isShortStageUpdate(method: string, args: unknown[]): boolean {
  if (method === "setSnapshots") return true;
  if (method !== "setTime") return false;
  const opts = args[1] as { probe?: unknown } | undefined;
  return !opts?.probe;
}

/**
 * Parent page side: create an RPC client for a stage iframe.
 * `targetOrigin` is currently `location.origin` (same-origin); in Step 4 E1 cross-origin, pass
 * the origin of the stage port.
 *
 * `opts.untrusted` (online cross-origin stage, contract `online-card-exec-contract.md` Section 3.2):
 * user cards and media effect cards execute inside the stage, so treat everything it sends as
 * untrusted input: only accept messages where `event.origin` equals `targetOrigin`; validate events
 * and responses by shape, and clamp numbers to a reasonable range (`online/stageMessageGuard.ts`;
 * if `opts.maxSec` is provided, clamp timestamps in events to within it, typically the project
 * duration), discard malformed events, and reject responses as failures. If not provided (desktop
 * runtime environment, same-origin single stage), proceed as before without changing a single byte.
 */
export function createStageRpc(target: Window, targetOrigin: string = location.origin, opts: { untrusted?: boolean; maxSec?: () => number } = {}): StageRpcClient {
  const untrusted = opts.untrusted === true;
  let nextId = 1;
  let disposed = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string; timer?: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(e: StageEvent) => void>();
  const onMessage = (e: MessageEvent) => {
    if (e.source !== target) return;
    if (untrusted && e.origin !== targetOrigin) return;
    const d = e.data;
    if (isRpcReply(d)) {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (p.timer) clearTimeout(p.timer);
      if (untrusted) {
        if (d.ok !== true) { p.reject(new Error(sanitizeRpcError(d.error) || `stage rpc ${p.method} failed`)); return; }
        let result: unknown;
        try { result = sanitizeRpcResult(p.method, d.result); } catch (err) { p.reject(err instanceof Error ? err : new Error(String(err))); return; }
        p.resolve(result);
        return;
      }
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || `stage rpc ${p.method} failed`));
      return;
    }
    if (untrusted) {
      const clean = sanitizeStageEvent(d, { maxSec: opts.maxSec?.() }) as StageEvent | null;
      if (clean) for (const l of listeners) l(clean);
      return;
    }
    if (isStageEvent(d)) for (const l of listeners) l(d);
  };
  window.addEventListener("message", onMessage);
  /** Whether the window is closed. When `closed` cannot be read (very old hosts / test doubles), treat as still open and fall back to old behavior */
  const targetClosed = () => { try { return target.closed === true; } catch { return false; } };
  /** Polling check running only when requests are pending (see CLOSED_POLL_MS); tear down the entire client as detached once closed */
  let poll: ReturnType<typeof setInterval> | null = null;
  const stopPoll = () => { if (poll !== null) { clearInterval(poll); poll = null; } };
  const startPoll = () => {
    if (poll !== null) return;
    poll = setInterval(() => {
      if (!pending.size) stopPoll();
      else if (targetClosed()) client.dispose();
    }, CLOSED_POLL_MS);
  };
  const call = (method: keyof StageRpcApi, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      // Window is already closed: return the same response as after dispose; do not send requests into
      // a window that will never respond
      if (!disposed && targetClosed()) client.dispose();
      if (disposed) {
        if (method === "render") resolve({ aborted: true, reason: "detached" });
        else reject(new Error("stage rpc: detached"));
        return;
      }
      const id = nextId++;
      const waitMs = stageCallTimeoutMs(method, args);
      const timer = waitMs !== null ? setTimeout(() => {
        pending.delete(id);
        reject(new Error(`stage rpc ${method}: timed out`));
      }, waitMs) : undefined;
      pending.set(id, { resolve, reject, method, timer });
      const msg: RpcRequest = { type: "pc-rpc", id, method, args };
      try {
        target.postMessage(msg, targetOrigin);
      } catch (err) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      startPoll();
    });
  const client = {
    target,
    get disposed() { return disposed; },
    onEvent(listener: (e: StageEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopPoll();
      window.removeEventListener("message", onMessage);
      for (const [id, p] of pending) {
        pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        if (p.method === "render") p.resolve({ aborted: true, reason: "detached" });
        else p.reject(new Error("stage rpc: detached"));
      }
      listeners.clear();
    },
  } as StageRpcClient;
  for (const m of METHODS) (client as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => call(m, args);
  return client;
}

/**
 * Stage side: attach the method table to message. Each method can return a value or Promise;
 * on error, return `{ ok: false, error }`. Only accept requests sent by `window.parent`; send
 * responses back to `event.source` (which is the parent page).
 */
export function serveStageRpc(api: StageRpcApi, opts: { parentOrigin?: string } = {}): () => void {
  const onMessage = (e: MessageEvent) => {
    const d = e.data;
    if (!isRpcRequest(d)) return;
    if (e.source !== window.parent) return;
    const reply = (r: RpcReply) => {
      try {
        (e.source as Window | null)?.postMessage(r, opts.parentOrigin ?? (e.origin && e.origin !== "null" ? e.origin : "*"));
      } catch (err) {
        console.error("[stage rpc] reply failed", err);
      }
    };
    const fn = (api as unknown as Record<string, unknown>)[d.method];
    if (typeof fn !== "function") {
      reply({ type: "pc-rpc-reply", id: d.id, ok: false, error: `unknown method ${String(d.method)}` });
      return;
    }
    let out: unknown;
    try {
      out = (fn as (...a: unknown[]) => unknown).apply(api, d.args);
    } catch (err) {
      reply({ type: "pc-rpc-reply", id: d.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    Promise.resolve(out).then(
      (result) => reply({ type: "pc-rpc-reply", id: d.id, ok: true, result }),
      (err) => reply({ type: "pc-rpc-reply", id: d.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/** Stage side: send an event (one of seven types) to the parent page. ArrayBuffers in `transfer` are transferred with the message (not copied; cannot be used on this side after sending) */
export function postStageEvent(e: StageEvent, parentOrigin = "*", transfer: Transferable[] = []): void {
  if (transfer.length) window.parent?.postMessage(e, parentOrigin, transfer);
  else window.parent?.postMessage(e, parentOrigin);
}

/** Stage side: compress a one-frame HTML snapshot into transferable bytes (gzip); returns null when the browser lacks `CompressionStream` (caller passes string as before) */
export async function compressHtml(html: string): Promise<ArrayBuffer | null> {
  const CS = (globalThis as { CompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).CompressionStream;
  if (!CS || typeof Blob === "undefined") return null;
  try {
    const stream = new Blob([html]).stream().pipeThrough(new CS("gzip"));
    return await new Response(stream).arrayBuffer();
  } catch {
    return null;
  }
}

/** Parent page side: extract the HTML of `probe-frame` (decompress first if `htmlGz` is present) */
export async function probeFrameHtml(e: { html: string; htmlGz?: ArrayBuffer }): Promise<string> {
  if (!e.htmlGz) return e.html;
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) return e.html;
  const stream = new Blob([e.htmlGz]).stream().pipeThrough(new DS("gzip"));
  return await new Response(stream).text();
}

/** Stage side: handshake (with host capability table, J4) */
export function postStageReady(hostCapabilities: HostCapabilities, parentOrigin = "*"): void {
  const msg: StageReadyMessage = { type: "pc-stage-ready", hostCapabilities };
  window.parent?.postMessage(msg, parentOrigin);
}

/**
 * Stage side: after catching card hot reload and rerendering with the new card, inform the parent
 * page that "switched to version `stamp`" (C6.6 integration 3b, `editor/stageCards.ts`). Like
 * `pc-stage-ready`, this is a handshake-type message, not a `StageEvent`.
 */
export interface StageCardsMessage {
  type: "pc-stage-cards";
  stamp: number;
}
/**
 * Arguments for `setMediaPolicy`: asset gate results (lowest tier uses small size only, decoding
 * cap, slow network speed uses small size first then original size), remote asset service in
 * online browser mode (base URL and read-only ticket).
 *
 * Isolated cross-origin stage (contract `online-card-exec-contract.md` Section 4.1): `remote.base`
 * is `/media-s/<sid>` on the stage's own origin, and `remote.ticket` is always null (the ticket
 * is handed by the editor page to the stage origin server to exchange for an HttpOnly cookie,
 * never entering stage scripts); `cardExec` is true = parent page approval, allowing this instance
 * to execute user cards and media effect cards (the stage itself must also verify self-checks and
 * "this document has seen no ticket", `online/isolation/execGate.ts`). The old approach
 * (non-isolated stage) carries the ticket as before, without `cardExec`.
 */
export interface StageMediaPolicy {
  /** Lowest tier: video assets use small size only */
  smallOnly: boolean;
  /** Asset gate decoding cap (pixel count of width × height); video assets exceeding it use small size only. Omitted / null = unlimited */
  decodeMaxPixels?: number | null;
  /** Asset gate network speed: slow: pull small size first for display, then pull original size to replace */
  smallFirst?: boolean;
  remote: { base: string; ticket: string | null } | null;
  cardExec?: boolean;
}

export function postStageCards(stamp: number, parentOrigin = "*"): void {
  const msg: StageCardsMessage = { type: "pc-stage-cards", stamp };
  window.parent?.postMessage(msg, parentOrigin);
}

/**
 * Stage side: probe host capabilities per J4. `prerender` and `stageId` come from values written
 * by the parent page in the src query string. `online`: online browser mode (`ONLINE` in
 * `src/online/mode.ts`), passed by the caller: this file does not read compile-time constants,
 * which are absent in unit tests.
 */
export function detectHostCapabilities({ online = false }: { online?: boolean } = {}): HostCapabilities {
  const q = new URLSearchParams(location.search);
  const ua = navigator.userAgent;
  const safari = /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua);
  let offscreenGl = false;
  try {
    // Approximation on main thread: OffscreenCanvas webgl2 in Worker has the same origin and
    // capability as main thread (Safari had no WebGL in Workers prior to Safari 17).
    // What actually decides whether to use Worker is glHost actual measurement in Worker (R9 M2);
    // here it only provides the `device` string and helps the parent page choose a route.
    const probe = typeof OffscreenCanvas !== "undefined" && typeof Worker !== "undefined" ? new OffscreenCanvas(1, 1).getContext("webgl2") : null;
    offscreenGl = !!probe && !(safari && !/Version\/(1[7-9]|[2-9]\d)/.test(ua));
    // Release immediately after probing: acceptance check requires "0 live WebGL contexts on stage
    // main thread" (R9), so this one cannot be left waiting for GC
    probe?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    offscreenGl = false;
  }
  // `?glOffscreen=0`: force probe to false (R9 acceptance check "capability fallback"; glHost reads
  // the same switch to use the main thread)
  if (q.get("glOffscreen") === "0") offscreenGl = false;
  /*
   * Online page: the parent page provides the initial route (`gl=`), single stage only
   * (`compact=1`), and lowest tier (`lowest=1`) in src based on the stage gate. Cross-origin stages
   * cannot read the local storage of the editor page origin (crash records and gate results are
   * all over there), so follow what the parent page provides; desktop runtime environments ignore
   * these items.
   */
  const gl = q.get("gl");
  const glRoute = online && (gl === "perDocument" || gl === "shared") ? gl : null;
  const compact = online && q.get("compact") === "1";
  const lowest = online && q.get("lowest") === "1";
  // C10 contract Section 2: when background stage is enabled (parent page provides `dual=1`),
  // report truthfully that measurement and catching up live render are supported
  const backStage = q.get("dual") === "1";
  return {
    prerender: q.get("prerender") === "1",
    offscreenGl,
    compact,
    glRoute,
    lowest,
    measure: backStage,
    catchUp: backStage,
    // stageId **is only an instance name and has nothing to do with role** (E1): the two iframes are
    // `A` / `B`, and which is front / back is determined solely via setRole. Default to `A` rather
    // than `front` to avoid misinterpreting instance names as role names again.
    stageId: q.get("id") || "A",
  };
}

import fs from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { openBakery, bakeFrames } from './bakery/index.mjs';
// Import directly by filename, not via index: existing tests replace entire index with mock.module, and the mock lacks this export
import { probeBrowserEnvironment } from './bakery/environment.mjs';
import { captureSnapshot } from './bakery/capture-snapshot.mjs';
import { frameIdentity, trackPrefixes } from './frame-identity.mjs';
import { cardEntryCode } from './card-code.mjs';
import { packFrames, unpackFrameArchive, createFrameArchive, packFrameCache, unpackFrameCache } from './frame-archive.mjs';
import { MovFrameStore, PlaybackMovStore, atomic } from './frame-mov.mjs';
import { FramePlayback } from './frame-playback.mjs';
import { sweepFrameLibrary } from './storage-leftovers.mjs';
/** Frame store roots for which this process has already run startup cleanup */
const sweptRoots = new Set();
import { CardFrameCache } from './card-cache.mjs';
import { SnapshotStore, snapshotTier, rangeHas, rangeCount } from './snapshot-store.mjs';
import { createReadyHub, DEFAULT_READY_SESSION, READY_SESSION_IDLE_MS, kindOfTier, wireSnapshotKey } from './ready-index.mjs';
import { prerenderSetOfPlan } from './prerender-set.mjs';
import { createMediaStamper } from './media-stamp.mjs';
import { createHash } from 'node:crypto';
import { isFullyTransparentPng } from './frame-validity.mjs';
import { resolveFrameSize } from '../src/kernel/frameSize.mjs';
import { isolatedCardProject } from '../src/kernel/isolatedCard.mjs';
import { anchorFrames } from '../src/render/snapshotPick.mjs';
import { StreamProducer, STREAM_POOL_DEFAULT, STREAM_POOL_MAX, STREAM_CODE_VERSION, planStreams, planListStreams, queueStreamOf, streamDecoderBudget } from './frame-stream.mjs';
import { dirtyStreamLease } from './bakery/bake.mjs';
import { createCardLockStore, cardLockDecision, CARD_LOCK_IDLE_MS } from './card-lock.mjs';
import { QUEUE_DEFAULTS } from './render-queue/index.mjs';
import { applyResult, manifestKindOf, manifestKeyOf, manifestMatches, spansOf } from './artifact-transfer.mjs';

/** Max rechecks for postponed cards in the same revision (contract F.8 item 2), then wait for next revision */
export const CARD_LOCK_RETRY_MAX = 20;
import { resultKeyOf } from './render-node/fingerprint.mjs';
import { withInnerCards, isUserCardControl } from './render-node/split.mjs';
import { expandProject, streamNeed, subsetCardSources } from './render-node/expand.mjs';
import { createSmallRenderer, SMALL_SUFFIX } from './bakery/small-bitmap.mjs';
import { layerMapOf, streamCandidateKey, STREAM_CANDIDATE_PREFIX, layerMapKeyOf } from './artifact-transfer.mjs';
import { PRERENDER_MODE, parsePrerenderMode, lanesOfMode, modeRefusal, modeServesAgent, modeServesPrerender } from './prerender-mode.mjs';
import { exportSpecOf, exportStreamOf, shotToPng, storeExportFrame } from './export-frames.mjs';
import { streamInputSig } from '../src/render/streamInputSig.mjs';

/**
 * C6.4 Segment length used to split segments for push and cross-machine fetch: exactly matches
 * render queue splitting (`render-node/split.mjs`): snapshots are one segment per `SNAPSHOT_SPAN`
 * local frames (starting from 0), and streams are one segment per `STREAM_SEGMENTS` segments
 * (starting from this stream's `firstSegment`). Keys are therefore identical to the result keys
 * and ranges of fine-grained tasks (`manifest-contract.md` section 1).
 */
export const PUSH_SNAPSHOT_SPAN = QUEUE_DEFAULTS.SNAPSHOT_SPAN;
export const PUSH_STREAM_SEGMENTS = QUEUE_DEFAULTS.STREAM_SEGMENTS;
/** Max stream locks to track (`FramePipeline.streamLocks`: single-card streams produced elsewhere and fully pulled to this machine) */
export const STREAM_LOCKS_MAX = 2000;
/** c10a section 9: max frames not yet drawn as small bitmaps to accumulate (keep only newest when no page switch for a while) */
export const SMALL_PENDING_MAX = 480;
/** Push priority (`PUSH_PRIORITY` in `artifact-push.mjs`): 0 normal, 1 low. That module is not imported here; only numbers are used */
const PUSH_NORMAL = 0, PUSH_LOW = 1;
/** Number of manifest segments to query concurrently during cross-machine fetch */
const ADOPT_CONCURRENCY = 4;

const pad = n => String(n).padStart(6, '0');
const exists = file => fs.access(file).then(() => true, () => false);
// The interactive editor must never wait forever on a renderer that stopped
// answering.  Agent/background renders have their own (longer) budgets; this
// watchdog is only for the human preview lane.
// TODO: 10 seconds may be too aggressive for complex projects or a cold media
// decode. Keep this configurable until we have latency telemetry; raise it
// with PROMPTCUT_USER_RENDER_TIMEOUT_MS when the preview needs more headroom.
const USER_RENDER_TIMEOUT_MS = Math.max(1000, Number(process.env.PROMPTCUT_USER_RENDER_TIMEOUT_MS) || 10000);
// An open preview repeats its preload request every 2 s until the scene is
// ready (UnifiedPreview). An owner that has not asked for this long has gone
// away: its page was closed or reloaded, and a reloaded default project gets a
// new id. Its background pass must not keep the current project waiting.
export const PRELOAD_STALE_MS = 8000;
/** Close Agent lane Chrome after being idle this long, relaunch on next query (cloud-task.md I1) */
export const AGENT_IDLE_MS = 10 * 60 * 1000;
/**
 * After a dedicated Agent instance finishes an Agent task, stay idle at least this long before
 * taking normal prerenders (`kickAgentIdle`). A single Agent tool call often involves several
 * back-to-back tasks (e.g. scheduling "measure entity boxes" only after a batch of `see_frames`
 * finishes rendering); taking a card batch during the gap (which requires page switching and
 * pushing 4 frames, taking several seconds) would make the immediately following task wait a whole
 * batch for nothing. During this period, the dedicated instance accepts nothing and re-evaluates
 * when time is up.
 */
export const AGENT_GRACE_MS = 1000;
/**
 * When a dedicated instance is running a queue task and yields mid-flight to an Agent, report
 * "still working" at this interval (executor's `heartbeat` → session work count), preventing
 * the queue from reclaiming this item due to stall (`STALL_MS`, 120 s) when several consecutive
 * Agent tasks take a long time (AGENT-maint-3).
 */
export const AGENT_YIELD_BEAT_MS = 20_000;

const roundBox = b => ({ left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) });

/**
 * A media clip's `contentBox` **always equals its `frameCss` box** (D4(b)): not measured in
 * snapshots, but computed from project data. Uses the same formula as `frameBox` in
 * `src/kernel/layout.ts` (anchor at (x,y), top-left = (x,y) minus anchor offset), with width
 * and height resolved via `resolveFrameSize` in `src/kernel/frameSize.mjs`: the single copy
 * shared between stage and server.
 */
export function frameContentBox(frame, stage) {
  const { w, h } = resolveFrameSize(frame, stage);
  const anchor = frame?.anchor ?? [0, 0];
  return roundBox({ left: (frame?.x ?? 0) - (anchor[0] ?? 0) * w, top: (frame?.y ?? 0) - (anchor[1] ?? 0) * h, width: w, height: h });
}

/**
 * The **pure computation** part of the D4(b) response: clips are split into "media clips
 * (computed via frameBox)" and "cards (measured from generated snapshots)", then the measured
 * entity boxes are merged back. `measured` is the return value of
 * `window.__pcSolid.rectsWithBounds`; passing null indicates not yet measured (only requesting
 * the list). Omitting `clipIds` means all clips (cards + media clips).
 *
 * Takes `bounds ?? rect`, rounded to integers: verbatim identical to `measureContentBoxes`
 * on the page side.
 */
export function layoutClips(project, clipIds, measured = null, t = 0) {
  const stage = { width: Number(project?.width) > 0 ? project.width : 1920, height: Number(project?.height) > 0 ? project.height : 1080 };
  const byId = new Map();
  for (const track of project?.tracks || []) for (const clip of track?.clips || []) if (clip?.id && !byId.has(clip.id)) byId.set(clip.id, clip);
  const ids = clipIds?.length ? [...new Set(clipIds.map(String))] : [...byId.keys()];
  const clips = {};
  const cardIds = [];
  for (const id of ids) {
    const clip = byId.get(id);
    if (!clip) { clips[id] = { contentBox: null, contentNote: `clip ${id} not found` }; continue; }
    // Media clip: not measured in snapshots; box is determined by project data
    if (!clip.cardId) { clips[id] = { contentBox: frameContentBox(clip.frame, stage) }; continue; }
    cardIds.push(id);
    if (!measured) { clips[id] = { contentBox: null }; continue; }
    const hit = measured.find(m => m?.clipId === id);
    if (!hit) {
      clips[id] = { contentBox: null, contentNote: `This card is not on screen right now (t=${t}s is outside its ${clip.start}~${clip.end}s range); seek into its time range first, then read` };
      continue;
    }
    clips[id] = { contentBox: roundBox(hit.bounds ?? hit.rect) };
  }
  return { stage, clips, cardIds };
}

/**
 * D3: Solid rectangles attached to each frame in `see_frames` are measured in the `afterFonts` hook
 * of `captureSnapshot` (same hook location as `layoutNow`). Root passes
 * `#pc-frame-snapshot [data-pc-scene]`, calling
 * `window.__pcSolid.rectsWithBounds(root, { pixels: 'all' })`.
 *
 * Returns `Array<{ clipId, box: [x, y, w, h], solid: [x, y, w, h] | null }>`, in stage pixel
 * coordinates, rounded to integers: `box` = wrapper layer outer box, `solid` = solid extent,
 * **`null` = this card currently has no solid pixels**. When `bounds()` cannot measure a solid,
 * it falls back to the wrapper layer outer box (as a fallback for selection outlines), which cannot
 * be distinguished from "solid exactly fills wrapper layer". Therefore, following the same path
 * as `bounds()` (planes count as solid, elements with `isSolid` do not recurse deeper, group
 * stream planes are skipped, and `<img>` in snapshots is computed from `data-pc-painted-box`),
 * it first asks "is there any solid within the stage", returning `null` if not. Returns null
 * (not an empty array) when `__pcSolid` is not mounted on the page; callers use this to indicate
 * "failed to measure".
 */
export const measureEntityRects = page => page.evaluate(() => {
  const root = document.querySelector('#pc-frame-snapshot [data-pc-scene]');
  const api = window.__pcSolid;
  if (!root || typeof api?.rectsWithBounds !== 'function' || typeof api.isSolid !== 'function') return null;
  const origin = root.getBoundingClientRect();
  const r4 = b => [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
  const onStage = rc => rc.width > 0 && rc.height > 0 && rc.right > origin.left && rc.left < origin.right && rc.bottom > origin.top && rc.top < origin.bottom;
  // Like paintedBoxAttr + paintedBoxRect in solid.ts: canvas pixel coordinates scaled by <img>'s current outer box
  const paintedRect = el => {
    const n = (el.getAttribute('data-pc-painted-box') || '').split(',').map(Number);
    if (n.length !== 4 || n.some(v => !Number.isFinite(v))) return null;
    const rect = el.getBoundingClientRect();
    const w = Number(el.getAttribute('width')) || el.naturalWidth || rect.width;
    const h = Number(el.getAttribute('height')) || el.naturalHeight || rect.height;
    if (!(w > 0) || !(h > 0) || !(rect.width > 0) || !(rect.height > 0)) return null;
    const sx = rect.width / w, sy = rect.height / h;
    return new DOMRect(rect.left + n[0] * sx, rect.top + n[1] * sy, n[2] * sx, n[3] * sy);
  };
  const painted = el => {
    if (el.hasAttribute('data-pc-group-plane')) return false;
    if (el.hasAttribute('data-pc-proxy-plane') || el.hasAttribute('data-pc-snapshot-plane') || el.hasAttribute('data-pc-stream-plane')) return onStage(el.getBoundingClientRect());
    if (api.isSolid(el, root)) return onStage((el.tagName === 'IMG' && paintedRect(el)) || el.getBoundingClientRect());
    for (const c of el.children) if (painted(c)) return true;
    return false;
  };
  return api.rectsWithBounds(root, { pixels: 'all' }).map(({ clipId, rect, bounds }) => {
    const wrap = root.querySelector(`[data-pc-clip="${CSS.escape(clipId)}"]`);
    const solid = bounds && wrap && [...wrap.children].some(painted) ? r4(bounds) : null;
    return { clipId, box: r4(rect), solid };
  });
});

/** A foreground batch queue, B complete HTML sampling, C cumulative-track rasterization.
 * Each lane owns its Chrome; foreground never waits for a background bake to finish.
 */
/** C4: Playhead when mirror plugin is not connected (`frameService` injects the real one) */
const NO_PLAYHEAD = () => /** @type {{ t: number, playing: boolean, wanted?: { clipId: string, frame: number }[] } | null} */ (null);

/**
 * Content identity of a card in prerender retry registry (c10a contract section 17): shared tier
 * uses content key (independent of environment or locking party); local tier also includes the
 * whole scene's `entry.key`.
 * Cards without snapshot keys do not produce snapshots; return null.
 */
function backfillIdentity(entry, control) {
  if (!control?.clipId || !control.snapshotKey) return null;
  const tier = control.tier || snapshotTier(control.capabilities);
  const content = control.contentKey ?? control.snapshotKey;
  return `${control.clipId}\u0000${tier === 'local' ? `${entry?.key ?? ''}/${content}` : content}`;
}

/** Max cards to track for split candidates (M7 D12) */
const SPLIT_CANDIDATES_MAX = 4096;

export class FramePipeline {
  /**
   * `interactive` (D5): Whether this instance should maintain a warm Chrome pair for page
   * interactive frame requests.
   *
   *   Prerender process `interactive: true`: warm pool lives here, renamed to `streamPool` (used
   *     by G's segments and C2's anchor frames; size is an output parameter of G0-b, initial value 2);
   *   Editor process `interactive: false`: `user` / `playback` lane immediately rejects
   *     `USE_PRERENDER`, does not enter `acquireUser`, and does not call `prewarmUser` in either place.
   *
   * **R6 only adds parameters and code paths; defaults retain today's behavior** (both processes
   * are `true`); actually switching the editor process to `false` is R7's atomic switch. Playback
   * warm pool leasing/returning and `stopPlayback()` are still in use and not removed (plan 3.4
   * final item: the draft says "deleted", which is incorrect).
   *
   * `playhead`: Where C4 reads `wanted` from (`latestPlayhead()` in mirror plugin). Since
   * frame-pipeline is .mjs and mirror plugin is .ts, this is injected by `frameService()`.
   *
   * `mediaUrl(m)`: Absolute HTTP URL of this asset on the asset service (returns null if
   * unreachable), used when sending `HEAD` to stamp assets lacking content hashes
   * (`media-stamp.mjs`). Likewise injected by `frameService()` (`mediaSourceOf` in
   * `ffmpeg-frames.ts`, with base URL determined by `asset-client.ts`); omitting injection means
   * "asset service unreachable", and stamps for such assets are `'missing'`.
   *
   * `dataRoot`: Used to locate cost records and tunable coefficients (`card-costs.json` /
   * `pipeline-tuning.json`), with the same convention as `vite-plugin-costs`:
   * `costsDir(dataRoot)` in `costs-store.mjs` = `PROMPTCUT_DATA_DIR || <dataRoot>/out`.
   * `frameService()` passes Vite's root directory. **Cannot use `root`**: `root` is the frame
   * store directory; during development without `PROMPTCUT_DATA_DIR` set, it would read from
   * an unwritten `<frame-store>/out/card-costs.json`, and measured costs would never enter the
   * prerender set. Defaults to current working directory (matching scripts and probes run from
   * repository root).
   *
   * `environment` (M4, contract E.2): Environment used by this process for prerendering, with the
   * shape of `describeEnvironment` (at least having `fingerprint`). If provided, used directly
   * without detection (tests, and future standalone render hosts with known environments); if not
   * provided, detected once when the first prerender room starts up (`ensureEnvironment`).
   */
  constructor({ root, origin, code = () => '', cardSources = () => ({}), captureCode = () => undefined, interactive = true, playhead = NO_PLAYHEAD, mediaUrl = () => null, dataRoot = process.cwd(), environment = null, cardLockIdleMs = CARD_LOCK_IDLE_MS, pushQueue = null, mode = PRERENDER_MODE.FULL }) {
    this.root = root;
    /**
     * Storage plan part A: clean up temporary files left by dead processes in the frame store at
     * startup (`storage-leftovers.mjs` file header lists recognized types). Only performed for real
     * frame store roots (`<export-dir>/frame-library`), once per process per root; temporary roots
     * used in tests are untouched. Not awaited: cleanup runs in parallel with startup, deleting only
     * dead process remnants, and will not collide with writes from this process.
     */
    if (typeof root === 'string' && path.basename(root) === 'frame-library' && !sweptRoots.has(path.resolve(root))) {
      sweptRoots.add(path.resolve(root));
      this.leftoverSweep = sweepFrameLibrary(root, { log: message => console.log(message) }).catch(() => null);
    } else this.leftoverSweep = Promise.resolve(null);
    /**
     * Push queue for C6.4 (`createPushQueue` in `artifact-push.mjs`, mounts itself here after creation).
     * **Only when non-null** do push hooks for snapshots/streams and cross-machine fetch in `preload`
     * take effect; when null (default, including all existing tests and probes), per-path behavior
     * remains unchanged. The prerender process only creates it when both asset service and document
     * service are reachable (`vite-plugin-frames.ts`).
     */
    this.pushQueue = pushQueue;
    /**
     * Frame store usage index and eviction (`frame-library-storage.mjs`, storage footprint plan part B).
     * Connected only in prerender process (`attachPipeline`); when null, the three `this.usage?.`
     * calls below do nothing.
     */
    this.usage = null;
    /**
     * Environment fingerprint (M4): all result keys for card plans and track streams incorporate it.
     * Null before settling: at that point `CardFrameCache.plan()` throws, `planStreams` returns [],
     * and no keys are produced at all.
     */
    this.environment = environment && typeof environment === 'object' ? environment : null;
    this.environmentProbe = null;
    /**
     * Per-card fingerprint lock (contract F.3): for shared-tier snapshots, a card originates from only
     * one environment. The lock store resides at `<store-root>/controls-lock/` and begins reading from
     * disk during construction; call sites using locks must first `await this.ensureCardLocks()`.
     */
    this.cardLockStore = typeof root === 'string' && root ? createCardLockStore({ dir: path.join(root, 'controls-lock') }) : null;
    this.cardLocksLoading = this.cardLockStore ? this.cardLockStore.load().catch(() => {}) : Promise.resolve();
    /** Incremented when a lock changes a card's key (or changes `foreign`): `snapshotTargets` cache is invalidated accordingly */
    this.cardLockEpoch = 0;
    /**
     * How long a locking party can produce nothing before being considered idle (contract F.8 item 2):
     * used by `idleMs` in `cardLockDecision` and the timer for postponed rechecks.
     * Tests pass small values.
     */
    this.cardLockIdleMs = Number.isFinite(cardLockIdleMs) && cardLockIdleMs >= 0 ? cardLockIdleMs : CARD_LOCK_IDLE_MS;
    /** Pending timer for postponed rechecks (cleared uniformly by `close()`) */
    this.cardLockTimers = new Set();
    this.dataRoot = dataRoot;
    this.origin = origin;
    this.code = code;
    /**
     * Code identity `{ cardId: identity }` of custom cards (user cards, cards modified in overlay layer)
     * used in this revision (c66-host-cards, `server/card-code.mjs`). `code` is the global code version
     * and no longer covers user cards; whole-scene keys append these identities after it
     * (`cardEntryCode`); written as-is to `requires.cardSources` of fine-grained tasks during queue
     * splitting. Defaults to no custom cards (tests, probes, scripts).
     */
    this.cardSources = cardSources;
    this.captureCode = captureCode;
    this.interactive = interactive !== false;
    /**
     * Prerender process mode (`prerender-mode.mjs`; `mechanism/rendering.md` "Query rendering and
     * prerender process"): `'user'` does not create Agent lane, `'agent'` only creates Agent lane and
     * does not prerender, and `'full'` creates both (default, same as before modes were added).
     * Unrecognized values default to `'full'`. Only meaningful for `interactive: true` instances
     * (prerender process); the editor process does not have these lanes to begin with.
     */
    this.mode = parsePrerenderMode(mode) ?? PRERENDER_MODE.FULL;
    this.playhead = playhead;
    /**
     * Asset stamp (`_frameSourceStamp`, enters `frameIdentity`): uses hash if available, otherwise
     * queries the asset service with `HEAD`, without reading the asset service storage directory
     * (`media-stamp.mjs` file header). `/@export/<id>/media/` is export's own artifact directory and
     * uses local stat as usual.
     */
    this.mediaStamper = createMediaStamper({ mediaUrl, exportRoot: () => process.env.PROMPTCUT_EXPORT_DIR || path.dirname(this.root) });
    /**
     * C3 ready index, **sharded by page session** (Item 4). The SSE endpoint
     * (`GET /api/frames/ready?session=`) only subscribes to its own session; a session's current
     * revision is set solely by `preload`, and publishing always passes through the
     * `publishLayer(entry, …)` gate.
     */
    this.ready = createReadyHub();
    this.entries = new Map();
    /**
     * Single-card streams already produced in another environment and fully pulled to this machine
     * (task brief "Jia-2"): stream content key → environment fingerprint that produced it. Each
     * entry carries a reference to this table (`entry.streamLocks`), and local stream planning
     * produces keys based on it (`relockStreams` in `frame-stream.mjs`). Recorded by
     * `adoptForeignStreams` and persisted to `stream-locks.json` at store root (streams pulled back
     * are still used after restart, not re-produced).
     */
    this.streamLocks = this.loadStreamLocks();
    this.queue = [];
    // The human preview, Agent and background bake each own an independent
    // serialized queue.  A long Agent render must never hold the hot user Chrome.
    this.foreground = Promise.resolve();
    // Built by mode (`lanesOfMode`): `user` mode has no `'agent'`, `agent` mode only has `'agent'`
    this.laneChains = new Map(['user', 'agent', 'background'].filter(lane => lanesOfMode(this.mode).includes(lane)).map(lane => [lane, Promise.resolve()]));
    /**
     * Normal prerender queue (pending items in `'queue'` lane, see `runQueueTask`): ordered
     * sequentially; operation previews from AI panel are inserted ahead of all pending tasks.
     * `queueRunning` is the item currently running on `'queue'` prerender room (at most one).
     */
    this.queueTasks = [];
    this.queueRunning = null;
    /**
     * Dedicated Agent instance (`mechanism/rendering.md` "Agent priority is only queue jumping"):
     * `agentPending` is the number of Agent tasks queued into `runAgentTask` and not yet completed;
     * when it is 0, dedicated instances accept normal prerenders (`kickAgentIdle`), and `agentUnit`
     * is the item it currently borrowed to work on.
     */
    this.agentPending = 0;
    this.agentUnit = null;
    /** Dedicated-instance yield records during queue tasks (`scheduler.yields` diagnostics): batch yields, Agent tasks run, total yield duration, latest */
    this.agentYieldStats = { count: 0, tasks: 0, ms: 0, last: null };
    /** Timestamp of latest Agent task completion; dedicated instance accepts no prerenders within `agentGraceMs` (tests pass 0) */
    this.agentDoneAt = 0;
    this.agentGraceMs = AGENT_GRACE_MS;
    this.agentGraceTimer = null;
    /** Unstarted batch for the card being processed in background pass (`fillCardControls` `share`), taken here by idle dedicated Agent instances */
    this.cardBatchPool = null;
    this.background = Promise.resolve();
    this.generations = new Map();
    this.lanes = new Map();
    // Keep two independent renderer processes ready for the editor.  A stuck
    // renderer can be discarded while the other one takes the next request.
    this.userPool = [];
    this.userPoolSize = 2;
    this.userPrewarm = null;
    // The editor can emit many pointer events before the previous render
    // completes. Keep one generation only; stale user requests must never
    // accumulate pages or force both hot Chromes to restart.
    this.userGeneration = 0;
    this.userGenerationController = null;
    /**
     * R8 `streamPool` (D5): track stream's own bare bakery, **bypassing `acquireUser` and `laneChains`**,
     * without sharing sessions with legacy `userPool` warm pool. Count is decided by `StreamProducer`
     * (default 1, at most 2).
     */
    this.streamSessions = [];
  }
  /**
   * Name of the warm pool in prerender process (D5). R8 track streams lease and return it by segment
   * (`leaseStreamBakery()` / `returnStreamBakery()`, together with G4 lease `dirty` bit:
   * any non-`bakeStream` call sets `dirty` upon completion, and the next `bakeStream` seeing
   * `dirty` treats the lease as broken, paying for a full playback): those two methods belong
   * to R8, and only placeholders are kept here.
   */
  get streamPool() { return this.streamSessions; }
  /** Environment fingerprint of this process's prerender Chrome (16-char hex); null until settled */
  get envFingerprint() { return this.environment?.fingerprint ?? null; }
  /**
   * Settle the environment for this process (contract E.2). Only detected on real prerender rooms:
   * if either `bakery.browser` or `bakery.page` is missing (fake bakery in tests), detection is
   * skipped and `this.environment` is returned as-is.
   *
   * **Settled only once for the entire process**, and detection failure (`detected: false`) results
   * are settled as well. Rationale: fingerprint is a factor of result keys; changing fingerprint
   * mid-flight turns all snapshots, PNG caches, and streams previously written by this process
   * into orphans under another key, and layers already pasted on the page must be redone entirely;
   * meanwhile, all prerender rooms in the same process share the same startup arguments and the
   * same Chrome binary, so the environment does not change, and detecting again yields no new
   * information. Concurrent calls share the same detection pass.
   */
  async ensureEnvironment(bakery) {
    if (this.environment) return this.environment;
    if (!bakery?.browser || !bakery?.page) return this.environment;
    this.environmentProbe ||= probeBrowserEnvironment({ browser: bakery.browser, page: bakery.page }).then(environment => {
      /*
       * For testing only: `PROMPTCUT_TEST_ENV_FINGERPRINT` (16 lowercase hex chars) replaces this
       * process's environment fingerprint with the given value: creating a render node with
       * "different environment" on the same machine (C10-A5: local stand-in of standalone render host
       * claims manifest plan published by online page). Not set in production.
       */
      const fake = String(process.env.PROMPTCUT_TEST_ENV_FINGERPRINT ?? '');
      if (/^[0-9a-f]{16}$/.test(fake)) environment = { ...environment, fingerprint: fake, testOverride: true };
      this.environment ||= environment;
      return this.environment;
    });
    return this.environmentProbe;
  }
  /** Wait for lock store `load()` started at construction to settle (contract F.3). Disk read failure also counts as settled: treated as no locks */
  async ensureCardLocks() {
    await this.cardLocksLoading;
  }
  /**
   * Replaces keys of shared-tier controls in plan with locking party's keys per lock store
   * (contract F.3 `applyCardLocks`). **Modified in place**; repeated calls on the same plan yield
   * the same result. For each control where `tier === 'shared'` and has `contentKey`:
   *
   *   - When first seen, records its own key and fingerprint
   *     (`ownSnapshotKey` / `ownEnvFingerprint`);
   *   - Locked on another fingerprint: `snapshotKey = resultKeyOf(contentKey, lockFingerprint)`,
   *     `envFingerprint = lockFingerprint`, `cardLock = { envFingerprint, source, foreign: true }`;
   *   - Otherwise switches back to own key and fingerprint, with `cardLock` being the lock
   *     (`foreign: false`) or null.
   *
   * Submission, claiming, ready index, and disk-scan rebuild therefore automatically use the locking
   * party's key. `key` (PNG cache) and `contentKey` remain untouched.
   * Returns whether any control changed keys in this pass.
   */
  applyCardLocks(plan) {
    if (!Array.isArray(plan)) return false;
    const store = this.cardLockStore;
    let changed = false;
    for (const control of plan) {
      if (!control?.contentKey) continue;
      if ((control.tier || snapshotTier(control.capabilities)) !== 'shared') continue;
      if (!Object.hasOwn(control, 'ownSnapshotKey')) {
        control.ownSnapshotKey = control.snapshotKey;
        control.ownEnvFingerprint = control.envFingerprint;
      }
      const before = `${control.snapshotKey}\u0000${control.envFingerprint}\u0000${control.cardLock?.foreign === true}`;
      const lock = store?.get(control.contentKey) ?? null;
      if (lock && lock.envFingerprint !== control.ownEnvFingerprint) {
        control.snapshotKey = resultKeyOf(control.contentKey, lock.envFingerprint);
        control.envFingerprint = lock.envFingerprint;
        control.cardLock = { envFingerprint: lock.envFingerprint, source: lock.source, foreign: true };
      } else {
        control.snapshotKey = control.ownSnapshotKey;
        control.envFingerprint = control.ownEnvFingerprint;
        control.cardLock = lock ? { envFingerprint: lock.envFingerprint, source: lock.source, foreign: false } : null;
      }
      if (before !== `${control.snapshotKey}\u0000${control.envFingerprint}\u0000${control.cardLock?.foreign === true}`) changed = true;
    }
    if (changed) this.cardLockEpoch = (this.cardLockEpoch || 0) + 1;
    return changed;
  }
  /** After locks change, reorder entry's card plan (and caller's other control list) together per lock store */
  reapplyCardLocks(entry, controls = null) {
    let changed = this.applyCardLocks(entry?.cardPlan);
    if (Array.isArray(controls) && controls !== entry?.cardPlan) changed = this.applyCardLocks(controls) || changed;
    return changed;
  }
  /** Session index for callers without session (scripts, probes). Pages use `this.ready.subscribe(session, …)` */
  get readyIndex() { return this.ready.session(DEFAULT_READY_SESSION).index; }
  get streamPoolSize() { return this._streams?.pool ?? STREAM_POOL_DEFAULT; }
  set streamPoolSize(value) { if (this._streams) this._streams.pool = Math.max(1, Math.min(STREAM_POOL_MAX, Math.round(value) || 1)); }
  /**
   * Track stream producer (R8 / G4). **Only present in the instance handling interaction (prerender
   * process, `interactive: true`)**: the editor process does not produce streams; when the `streams`
   * toggle is off (`PROMPTCUT_STREAMS=0`), it is present, but does nothing.
   */
  streamProducer() {
    // `agent` mode does not produce streams (does not prerender)
    if (!this.interactive || this.closed || !modeServesPrerender(this.mode)) return null;
    return this._streams ||= new StreamProducer(this);
  }
  /**
   * Borrow a track stream session (G4 "where sessions come from"). Borrow an idle one first; if
   * none, open a new bare bakery (parked on an empty project page, with the isolated project
   * injected by the producer before the first `bakeStream`). Concurrently open sessions do not
   * exceed `STREAM_POOL_MAX`.
   */
  async leaseStreamBakery() {
    for (;;) {
      if (this.closed) throw Object.assign(new Error('Renderer closed'), { cancelled: true });
      const free = this.streamSessions.find(s => !s.busy && !s.dead && s.bakery);
      if (free) {
        free.busy = true;
        clearTimeout(free.idleTimer);
        return free.bakery;
      }
      if (this.streamSessions.filter(s => !s.dead).length < STREAM_POOL_MAX) {
        const session = { bakery: null, busy: true, dead: false, idleTimer: null };
        this.streamSessions.push(session);
        try {
          session.bakery = await openBakery({ url: this.emptyUrl() });
          session.bakery.streamLease = null;
          // M4: like `bakery()`, sets the fingerprint once started (these two places are the only
          // openBakery call sites in this process)
          await this.ensureEnvironment(session.bakery);
          return session.bakery;
        } catch (error) {
          session.dead = true;
          const at = this.streamSessions.indexOf(session);
          if (at >= 0) this.streamSessions.splice(at, 1);
          throw error;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  /**
   * Return a track stream session. `dirty`: borrowed to do something else (non-`bakeStream`): lease
   * is invalidated (D5). `dead`: session is broken, close it. Sessions idle for 60 seconds are also
   * closed (prerender process manages its own pool, no resident warm pool).
   */
  returnStreamBakery(bakery, { dirty = false, dead = false } = {}) {
    const session = this.streamSessions.find(s => s.bakery === bakery);
    if (!session) return;
    if (dirty) dirtyStreamLease(bakery);
    if (dead || this.closed) {
      session.dead = true;
      const at = this.streamSessions.indexOf(session);
      if (at >= 0) this.streamSessions.splice(at, 1);
      void bakery.close().catch(() => {});
      return;
    }
    session.busy = false;
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.busy || session.dead) return;
      session.dead = true;
      const at = this.streamSessions.indexOf(session);
      if (at >= 0) this.streamSessions.splice(at, 1);
      void bakery.close().catch(() => {});
    }, 60000);
    session.idleTimer.unref?.();
  }
  /**
   * Whether it is currently "busy" (G0-b conclusion 1: only produce when the machine is idle;
   * pause production and yield when the user is scrubbing or playing). Criterion: legacy playback
   * warm pool in use / background yield lease is active; mirror plugin reports playhead is
   * "playing" and has heard from it within 5 seconds (during playback the page sends a keepalive
   * `PLAYHEAD_KEEPALIVE_MS` every 2 seconds, additionally reports `wanted` throttled at 100 ms when
   * there are gaps, and also reports once when stopped); or recently moved within 800 ms (scrubbing).
   */
  streamBusy(now = Date.now()) {
    if (this.closed) return true;
    if (this.playback?.playing) return true;
    if (this.backgroundLeaseUntil > now) return true;
    let head = null;
    try { head = this.playhead(); } catch {}
    const at = Number(head?.at);
    if (Number.isFinite(at)) {
      if (head.playing && now - at < 5000) return true;
      if (now - at < 800) return true;
    }
    return false;
  }
  /**
   * Whether this instance accepts the page's interaction / playback lane (`interactive` in D5), as
   * well as the Agent lane.
   *
   * Instances with `interactive: false` (editor process) **have no Agent lane**: Agent queries
   * (`see_frames` agent batch, `layout`, `entityRects`, `/api/cards/dom`) only run in the prerender
   * process (`docs/semantics/mechanism/rendering.md` "Query Rendering and Prerender Process").
   * Reaching here in the editor process returns `503 NO_AGENT_LANE`, without launching Chrome on the
   * editor side.
   */
  laneRefused(lane) {
    // The prerender process rejects by mode (`modeRefusal`): `user` mode rejects Agent queries,
    // `agent` mode rejects prerender lanes
    if (this.interactive) return modeRefusal(this.mode, lane);
    if (lane === 'agent') return Object.assign(new Error('This process has no Agent lane: Agent queries only run in the prerender process.'), { status: 503, code: 'NO_AGENT_LANE', retryable: true });
    if (lane !== 'user' && lane !== 'playback') return null;
    return Object.assign(new Error('Send interactive frame requests directly to the prerender process.'), { status: 503, code: 'USE_PRERENDER' });
  }
  /**
   * **Sole enqueue entry point for Agent lane** (T1a review #12). `see_frames` agent batches,
   * `layout`, `entityRects`, and `/api/cards/dom` (`vite-plugin-cards.ts`) are all queued into the
   * same chain through it: each task "waits for previous → borrows bakery → works → returns", so at
   * any moment at most one task is driving that single page on the agent lane, and nothing can bypass
   * anything else.
   *
   * Previously `layout` / `entityRects` each did `laneChains.get('agent')` then `set` back, and
   * `/api/cards/dom` had a separate `domChain` and its own Chrome: it was possible for the latter to
   * drive the page concurrently with an in-flight `see_frames`.
   *
   * `work(lease)`: `lease(project)` borrows the bakery for the agent lane and resets the same page
   * according to `project` (can be borrowed multiple times within a task, e.g. when a batch has two
   * projects); `lease(project, { asIs: true })` does not reset and hands it over as-is (the caller
   * immediately calls `reset` itself, saving a page open). **Only return if borrowed, and returning
   * is handled centrally here**; the caller does not call `release('agent')`. See `release` for idle
   * closure.
   */
  runAgentTask(work) {
    const refused = this.laneRefused('agent');
    if (refused) return Promise.reject(refused);
    // When the dedicated instance is borrowed to do a normal prerender item (`kickAgentIdle`), this
    // task is queued after that item: it does not interrupt it; once done, it is this task's turn
    this.agentPending++;
    const queuedAt = Date.now();
    const body = async () => {
      this.noteSched('agent', 'agent', Date.now() - queuedAt);
      let leased = false;
      const lease = async (project, { asIs = false } = {}) => {
        leased = true;
        const current = this.lanes.get('agent');
        if (asIs && current) { clearTimeout(current.timer); current.expired = false; return current.bakery; }
        return this.acquire('agent', project);
      };
      try { return await work(lease); }
      finally { if (leased) this.release('agent'); }
    };
    /*
     * When the dedicated instance is borrowed to do an item from the normal prerender queue
     * (`source: 'queue'` fetched by `kickAgentIdle`), do not queue after its entire item: place it
     * into its inbox, and let it pause at the next batch boundary (4 frames) to execute it first
     * (`drainAgentInbox`), resuming its own work after completion (AGENT-maint-3). When that item's
     * work does not pause at batch boundaries (such as plans or previews), the inbox is drained once
     * before it starts and once after it finishes.
     */
    const unit = this.agentUnit;
    if (unit?.inbox && !unit.inboxClosed) {
      const task = new Promise((resolve, reject) => { unit.inbox.push({ body, resolve, reject }); unit.wake?.(); });
      task.catch(() => {}).finally(() => { this.agentPending--; this.agentDoneAt = Date.now(); this.kickAgentIdle(); });
      return task;
    }
    const task = (this.laneChains.get('agent') || Promise.resolve()).catch(() => {}).then(body);
    const settled = task.finally(() => { this.agentPending--; this.agentDoneAt = Date.now(); this.kickAgentIdle(); });
    this.laneChains.set('agent', settled.catch(() => {}));
    return task;
  }
  /**
   * **Enqueue entry point for normal prerender queue** (`'queue'` lane). Fine-grained tasks of the
   * queue executor (`prerender-executor.mjs`, contract J.4), operation previews of the AI panel
   * (`'preview'` batch of `see_frames`), and idle texture prefetches of the 3D view (`'prerender'`
   * batch) are all queued here; the `'queue'` lane has its own prerender room and processes one item
   * at a time (wait for previous → borrow → work → return), and `closeNow` will await it
   * (`queueSettled`).
   *
   * `work(lease)`: `lease(project)` borrows the prerender room and resets it according to `project`;
   * only returns if borrowed, and returning is handled here (closed after 30 seconds idle, same as
   * `'background'`). When its turn comes, if `signal` is already aborted or the pipeline is closed,
   * do not borrow and reject directly with `cancelled`.
   *
   * Options (`mechanism/rendering.md` "Query Rendering and Prerender Process", `product/rendering.md`
   * "Operation Previews in AI Panel Can Jump the Queue"):
   *   - `front`: insert before all pending items (after already queued jump items, preserving order
   *     among jump items). **Does not interrupt the currently running item**: once it finishes,
   *     the next is the jump item. Default queues at tail.
   *   - `agentOk`: whether the Agent dedicated instance can take this item on behalf of the `'queue'`
   *     prerender room when idle (`kickAgentIdle`). Default is `!front`: jump items are user-triggered,
   *     and **do not occupy the Agent dedicated instance**; normal prerender can.
   *   - `tag`: two items with the same `tag` do not run concurrently on two instances
   *     (`card:<control.key>` / `scene:<entry.key>`: the same card or the same version of a whole
   *     scene does not render concurrently). Default none, no limit.
   *   - `scaleLane`: which lane's scale to use when borrowing the prerender room (`scaleForLane`).
   *     Default `'queue'`; operation previews and texture prefetches pass 1x.
   *   - `kind`: for diagnostics only (`diagnostics().scheduler`): `'queue'` (fine-grained task) /
   *     `'preview'` / `'prerender'`.
   */
  runQueueTask(work, signal, { front = false, agentOk = !front, tag = null, scaleLane = 'queue', kind = 'queue' } = {}) {
    // `agent` mode does not prerender: queue tasks, operation previews, and texture prefetches all
    // immediately return `503 NO_PRERENDER` on the spot, without queuing or hanging
    const refused = this.laneRefused('queue');
    if (refused) return Promise.reject(refused);
    return new Promise((resolve, reject) => {
      const item = { work, signal, front, agentOk, tag, scaleLane, kind, resolve, reject, queuedAt: Date.now() };
      if (front) {
        const at = this.queueTasks.findIndex(other => !other.front);
        if (at < 0) this.queueTasks.push(item); else this.queueTasks.splice(at, 0, item);
      } else this.queueTasks.push(item);
      this.pumpQueue();
      this.kickAgentIdle();
    });
  }
  /**
   * When the `'queue'` prerender room is idle, fetch the next item: queue head first, skipping
   * items with the same `tag` as the one held by the Agent dedicated instance
   */
  pumpQueue() {
    if (this.queueRunning) return;
    const busy = this.agentUnit?.tag ?? null;
    const at = this.queueTasks.findIndex(item => !item.tag || item.tag !== busy);
    if (at < 0) return;
    const [item] = this.queueTasks.splice(at, 1);
    this.queueRunning = item;
    this.noteSched(item.kind, 'queue', Date.now() - item.queuedAt);
    item.run = this.runQueueItem(item, 'queue').then(item.resolve, item.reject)
      .finally(() => { this.queueRunning = null; this.pumpQueue(); this.kickAgentIdle(); });
  }
  /**
   * Run a normal prerender item on a specific instance. `worker`: `'queue'` borrows the prerender
   * room of the `'queue'` lane (returns only if borrowed); `'agent'` borrows the already open
   * prerender room of the Agent dedicated instance (`resetAgentFor`), does not return it, and does
   * not touch its idle timer: that timer only counts Agent's own tasks.
   */
  async runQueueItem(item, worker, unit = null) {
    if (this.closed || item.signal?.aborted) throw Object.assign(new Error('Queue task cancelled'), { cancelled: true });
    let leased = false, session = null;
    const lease = async project => {
      leased = true;
      if (worker !== 'agent') return this.acquire('queue', project, { scaleLane: item.scaleLane });
      const bakery = await this.resetAgentFor(project, item.scaleLane);
      session = this.lanes.get('agent') ?? null;
      return bakery;
    };
    /*
     * Second argument (AGENT-maint-3): which instance to run on, and the yield point on the dedicated
     * instance. Behavior is unchanged when `work` does not recognize it.
     *   `shouldYield()`  Agent tasks are currently waiting for this instance (inbox not empty);
     *   `yieldPoint({ heartbeat })`  Called at batch boundaries: if there are Agent tasks, finish them
     *                   first (finish consecutive arrivals all at once) before returning, returns true.
     *                   If the page was swapped by Agent tasks, the start of the next batch will
     *                   `reset` itself according to the queue task state. If the dedicated instance is
     *                   replaced while yielding (an Agent task restarted Chrome), throw `agentGone`,
     *                   and this item is handed back to the `'queue'` prerender room to continue
     *                   (submitted frames are not redone).
     */
    const ctx = worker === 'agent' && unit?.inbox ? {
      worker,
      shouldYield: () => unit.inbox.length > 0,
      yieldPoint: async ({ heartbeat } = {}) => {
        if (!unit.inbox.length) return false;
        await this.drainAgentInbox(unit, { heartbeat, reason: 'batch' });
        if (this.closed || item.signal?.aborted) throw Object.assign(new Error('Queue task cancelled'), { cancelled: true });
        if (session && this.lanes.get('agent') !== session) throw Object.assign(new Error('The dedicated Agent instance was replaced while yielding'), { agentGone: true });
        return true;
      },
    } : { worker, shouldYield: () => false, yieldPoint: async () => false };
    try { return await item.work(lease, ctx); }
    finally { if (leased && worker === 'queue') this.release('queue'); }
  }
  /**
   * Finish Agent tasks in the dedicated instance inbox in order (tasks arriving while executing
   * are also processed: "finish consecutive arrivals all at once before switching back"), calling
   * `heartbeat` every `AGENT_YIELD_BEAT_MS` during the process (queue task work count, so the lease
   * is not treated as stalled due to yielding). Recorded into `agentYieldStats`.
   * When yielding at batch boundaries, after emptying the inbox, wait for `agentGraceMs` (1 second)
   * to see if more follow immediately: an Agent tool call often consists of several tasks in quick
   * succession (`see_frames` finishes rendering before queuing "measure entity boxes"); without
   * waiting, it would switch back to the queue task once (a page swap plus a 4-frame chunk) before
   * reaching the next one [ruling].
   * `reason`: `'batch'` = queue task yields at batch boundary; `'start'` / `'end'` = drain inbox
   * before starting and after finishing that item. Returns how many were done.
   */
  async drainAgentInbox(unit, { heartbeat = null, reason = 'batch' } = {}) {
    if (!unit?.inbox?.length) return 0;
    const t0 = Date.now();
    let tasks = 0;
    const beat = () => { try { heartbeat?.(); } catch { /* Heartbeat errors do not affect yielding */ } };
    beat();
    const timer = heartbeat ? setInterval(beat, AGENT_YIELD_BEAT_MS) : null;
    timer?.unref?.();
    const grace = reason === 'batch' ? Math.max(0, Number(this.agentGraceMs) || 0) : 0;
    const next = () => new Promise(resolve => {
      if (unit.inbox.length || !grace || this.closed) return resolve();
      const timer = setTimeout(() => { unit.wake = null; resolve(); }, grace);
      unit.wake = () => { clearTimeout(timer); unit.wake = null; resolve(); };
    });
    try {
      for (;;) {
        while (unit.inbox.length) {
          const job = unit.inbox.shift();
          tasks++;
          try { job.resolve(await job.body()); } catch (error) { job.reject(error); }
        }
        await next();
        if (!unit.inbox.length) break;
      }
    } finally {
      if (timer) clearInterval(timer);
      beat();
    }
    const ms = Date.now() - t0;
    const stats = this.agentYieldStats;
    if (reason === 'batch') stats.count++;
    stats.tasks += tasks;
    stats.ms += ms;
    stats.last = { at: t0, ms, tasks, reason };
    return tasks;
  }
  /**
   * Reset the open prerender room of the Agent dedicated instance according to `project`, and hand
   * it over to a normal prerender item. If the dedicated instance is already closed or reset fails
   * (close it on failure; the next Agent task reopens it), throw `agentGone`: the caller hands this
   * item back to the `'queue'` prerender room.
   */
  async resetAgentFor(project, scaleLane = 'queue') {
    const session = this.lanes.get('agent');
    if (!session) throw Object.assign(new Error('The dedicated Agent instance is already closed'), { agentGone: true });
    try {
      await session.bakery.reset(project, this.emptyUrl(project), { deferCards: true });
      await session.bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: this.scaleForLane(scaleLane) });
      await session.bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      return session.bakery;
    } catch (error) {
      if (this.lanes.get('agent') === session) { clearTimeout(session.timer); this.lanes.delete('agent'); }
      await Promise.resolve(session.bakery.close?.()).catch(() => {});
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { agentGone: true });
    }
  }
  /**
   * **Agent dedicated instance takes normal prerender when idle** (`mechanism/rendering.md`
   * "Agent Priority Is Just Queue Jumping").
   *
   * Only takes an item when all conditions hold:
   *   - This instance has an Agent lane (`interactive`, the editor process does not);
   *   - Agent queue is empty (`agentPending === 0`), and it is not holding another prerender item
   *     (`agentUnit`);
   *   - The dedicated instance's prerender room is **already open and has not reached idle closure**
   *     (`lanes.get('agent')`, and not marked `expired`): does not launch Chrome just to take
   *     prerender, only takes it if Agent used it within `AGENT_IDLE_MS`;
   *   - Not during a playback yield period (same as the background pass);
   *   - More than `agentGraceMs` (`AGENT_GRACE_MS`) has passed since the latest Agent task finished:
   *     if not yet elapsed, set a timer to re-evaluate when due.
   *
   * Which item to take: first the earliest `agentOk` item in the normal prerender queue with a
   * different `tag` from the one held by the `'queue'` prerender room; if none, take a batch from the
   * card currently being processed in the background pass (`cardBatchPool`). **Only takes one item at
   * a time**, attached to the tail of the `laneChains.get('agent')` chain:
   *   - When it starts work, the Agent queue is empty, so it does not queue in front of any Agent
   *     task;
   *   - Agent tasks arriving after it starts are queued behind it: does not interrupt it, once it
   *     finishes it is Agent's turn;
   *   - Once it finishes, it returns here to re-evaluate; if the Agent queue is not empty, it will
   *     not take items (`agentPending > 0`), so Agent tasks are never queued behind queued prerender
   *     items.
   */
  kickAgentIdle() {
    if (this.closed || !this.interactive || this.agentPending > 0 || this.agentUnit) return;
    // Only `full` mode has both: `user` mode has no dedicated instance, and `agent` mode has no
    // prerender to take
    if (!modeServesAgent(this.mode) || !modeServesPrerender(this.mode)) return;
    const session = this.lanes.get('agent');
    if (!session || session.expired) return;
    if (this.backgroundYielding || this.backgroundLeaseUntil > Date.now()) return;
    const wait = this.agentDoneAt + this.agentGraceMs - Date.now();
    if (wait > 0) {
      if (!this.agentGraceTimer) {
        this.agentGraceTimer = setTimeout(() => { this.agentGraceTimer = null; this.kickAgentIdle(); }, wait);
        this.agentGraceTimer.unref?.();
      }
      return;
    }
    const unit = this.takeAgentUnit();
    if (!unit) return;
    this.agentUnit = unit;
    const run = (this.laneChains.get('agent') || Promise.resolve()).catch(() => {}).then(async () => {
      // Agent tasks arriving between enqueue and start are done first (they entered the inbox, not
      // queued after this item)
      await this.drainAgentInbox(unit, { reason: 'start' });
      const current = this.lanes.get('agent');
      if (!current || current !== session || this.closed) { unit.giveBack(); return; }
      current.unitRunning = true;
      try { await unit.run(current.bakery); }
      finally {
        current.unitRunning = false;
        // If the idle timer expires while it is working: close after finishing; if Agent tasks are queued
        // at that point, do not close, let them keep using it
        if (current.expired && this.agentPending === 0 && this.lanes.get('agent') === current) {
          this.lanes.delete('agent');
          void Promise.resolve(current.bakery.close?.()).catch(() => {});
        }
      }
    }).finally(async () => {
      // Release only after finishing remaining items in the inbox (those that arrived after the last
      // batch); close the inbox the moment it is empty, and subsequent arrivals queue up in the chain as usual
      try { await this.drainAgentInbox(unit, { reason: 'end' }); } finally {
        if (unit.inbox) unit.inboxClosed = true;
        this.agentUnit = null; this.pumpQueue(); this.kickAgentIdle();
      }
    });
    this.laneChains.set('agent', run.catch(() => {}));
  }
  /**
   * The item taken by `kickAgentIdle`, shape `{ tag, source, run(bakery), giveBack() }`. Removed
   * from its original place once taken; `giveBack` puts it back in place (dedicated instance closed
   * before it started). Returns null if nothing can be taken.
   */
  takeAgentUnit() {
    const busy = this.queueRunning?.tag ?? null;
    const at = this.queueTasks.findIndex(item => item.agentOk && (!item.tag || item.tag !== busy));
    if (at >= 0) {
      const [item] = this.queueTasks.splice(at, 1);
      this.noteSched(item.kind, 'agent', Date.now() - item.queuedAt);
      const giveBack = () => { this.queueTasks.splice(Math.min(at, this.queueTasks.length), 0, item); this.pumpQueue(); };
      const unit = {
        tag: item.tag, source: 'queue', giveBack,
        /**
         * Agent tasks waiting for this instance (placed in by `runAgentTask`, processed by
         * `drainAgentInbox`)
         */
        inbox: [],
        run: async () => {
          try { item.resolve(await this.runQueueItem(item, 'agent', unit)); }
          catch (error) {
            // Cannot borrow the dedicated instance's prerender room: this item was not executed, handed back
            // to the `'queue'` prerender room, not counted as failure
            if (error?.agentGone && !this.closed && !item.signal?.aborted) giveBack();
            else item.reject(error);
          }
        },
      };
      return unit;
    }
    const batch = this.cardBatchPool?.take() ?? null;
    if (batch) this.noteSched('card-batch', 'agent');
    return batch;
  }
  /**
   * **Claim gate for queue mode** (`mechanism/rendering.md` "Agent Priority Is Just Queue Jumping";
   * `AGENT-query-render.md` Section 7, Item 2): whether the Agent dedicated instance can take
   * another normal prerender item at this moment: the local render node uses this to claim an extra
   * snapshot task beyond `maxConcurrent` for it to execute.
   *
   * Conditions are identical to `kickAgentIdle` (`full` mode, dedicated instance open and not reached
   * idle closure, Agent queue empty, not holding a prerender item, not in playback yield), plus no
   * pending items in the normal prerender queue that it can take (if there are, it takes them itself,
   * no need to claim extra). **Does not check the 1-second grace window**: claiming takes a
   * round-trip, so by the time the task arrives the grace window has likely passed; if not,
   * `kickAgentIdle` will wait until it elapses before taking it. Returns false when the dedicated
   * instance is not open: does not launch a new instance just to take prerender.
   */
  agentSpareSlot() {
    if (this.closed || !this.interactive || !modeServesAgent(this.mode) || !modeServesPrerender(this.mode)) return false;
    if (this.agentPending > 0 || this.agentUnit) return false;
    const session = this.lanes.get('agent');
    if (!session || session.expired) return false;
    if (this.backgroundYielding || this.backgroundLeaseUntil > Date.now()) return false;
    const busy = this.queueRunning?.tag ?? null;
    return !this.queueTasks.some(item => item.agentOk && (!item.tag || item.tag !== busy));
  }
  /**
   * Scheduling record (for diagnostics only, `diagnostics().scheduler`): `kind` is which kind of work
   * (`'agent'` = Agent task, `'queue'` / `'preview'` / `'prerender'` = normal prerender queue item,
   * `'card-batch'` = a batch from the background pass), `worker` is which instance started work
   * (`'agent'` = Agent dedicated instance, `'queue'` = prerender room of `'queue'` lane), `waitMs` is
   * how long it waited from enqueue to start (Agent tasks wait for the item held by the dedicated
   * instance to finish; normal prerender waits for items ahead of it). Counts accumulate
   * continuously, details retain the latest 64 entries.
   */
  noteSched(kind, worker, waitMs = null) {
    const stats = (this.schedStats ||= { counts: {}, recent: [] });
    const key = `${kind}@${worker}`;
    stats.counts[key] = (stats.counts[key] ?? 0) + 1;
    stats.recent.push({ kind, worker, at: Date.now(), ...(waitMs === null ? {} : { waitMs }) });
    while (stats.recent.length > 64) stats.recent.shift();
  }
  /**
   * Normal prerender queue finished: pending items cleared, neither instance holds any of its items
   * (`closeNow` awaits it)
   */
  async queueSettled() {
    for (;;) {
      const running = [this.queueRunning?.run, this.agentUnit?.source === 'queue' ? this.laneChains.get('agent') : null].filter(Boolean);
      if (!running.length) {
        if (!this.queueTasks.length) return;
        this.pumpQueue();
        if (!this.queueRunning) return;
        continue;
      }
      await Promise.allSettled(running);
    }
  }
  /**
   * C4: current `wanted` in mirror plugin (page reports "which layers are currently missing near
   * playhead")
   */
  playheadWanted() {
    try { return this.playhead()?.wanted ?? []; } catch { return []; }
  }
  /**
   * C4: which batch `wanted` allowed to jump the queue. For diagnostics only, retains latest 32
   * entries
   */
  notePromotion(record) {
    (this.promotions ||= []).push({ ...record, at: Date.now() });
    while (this.promotions.length > 32) this.promotions.shift();
  }
  /**
   * Read endpoint for end-to-end probe: over-budget frames (A3c), `wanted` queue jumping (C4),
   * prerender set (pinned render 9)
   */
  diagnostics() {
    return { oversize: this._snapshots?.oversize ?? [], promotions: this.promotions ?? [], plans: this.planDiagnostics(),
      streams: this._streams?.status() ?? null, ready: this.ready.describe(), environment: this.environment,
      // Contract F.3: all locks currently in the local lock store
      cardLocks: this.cardLockStore?.list() ?? [],
      // Query rendering schedule (`noteSched`): which instance Agent tasks and normal prerenders start
      // on; current lengths of Agent queue and normal prerender queue
      scheduler: { ...(this.schedStats ?? { counts: {}, recent: [] }), agentPending: this.agentPending, queueWaiting: this.queueTasks.length,
        queueRunning: this.queueRunning?.kind ?? null, agentUnit: this.agentUnit?.source ?? null, agentOpen: this.lanes.has('agent'), agentSpare: this.agentSpareSlot(),
        // Dedicated instance yields to Agent when running queue tasks (AGENT-maint-3): batch boundary yield
        // count, number of Agent tasks executed, total yield duration, most recent
        yields: { ...this.agentYieldStats } },
      // Prerender process mode and the lanes it creates (`prerender-mode.mjs`); editor process
      // (`interactive: false`) has none of these lanes
      mode: { mode: this.mode, lanes: this.interactive ? lanesOfMode(this.mode) : [] },
      // C6.4: these two items are present only when push queue is configured (diagnostics shape is
      // unchanged when not configured)
      ...(this.pushQueue ? { push: this.pushQueue.stats?.() ?? null, adoption: this.lastAdoption ?? null } : {}),
      // Task brief "Jia-2": single-card streams produced in other environments, pulled back in full
      // locally and used by their keys (included only when present; diagnostics shape is unchanged
      // when absent)
      ...(this.streamLocks.size || this.lastForeignStreams ? { foreignStreams: { locks: [...this.streamLocks], last: this.lastForeignStreams ?? null } } : {}) };
  }
  /**
   * Each entry's current prerender set and its card plan summary: `ready-index-probe` relies on it
   * to prove that "cards classified as light at all positions do not produce snapshots", and
   * incidentally exposes `costKey` so the probe can PUT a cost record for a card (that key can only
   * be computed by `plan()` in `card-cache.mjs`). Read-only, does not modify state.
   */
  planDiagnostics() {
    const list = [];
    for (const entry of this.entries?.values?.() ?? []) {
      if (!entry?.cardPlan?.length) continue;
      list.push({
        key: entry.key,
        prerenderSet: entry.prerenderSet instanceof Set ? [...entry.prerenderSet].sort() : null,
        controls: entry.cardPlan.map(control => ({
          clipId: control.clipId, costKey: control.costKey, snapshotKey: control.snapshotKey,
          // M4: probe uses this to verify `snapshotKey === resultKeyOf(contentKey, envFingerprint)`
          contentKey: control.contentKey, envFingerprint: control.envFingerprint,
          // Contract F.3: who holds the lock (`foreign: true` = locking party is another environment, key
          // replaced with locking party's)
          cardLock: control.cardLock ?? null,
          frameMode: control.frameMode ?? control.capabilities?.frameMode ?? null,
          tier: control.snapshotKey ? (control.tier || snapshotTier(control.capabilities)) : 'none',
          picked: this.prerenderPicked(entry, control.clipId),
        })),
      });
    }
    return list;
  }
  /**
   * Whole-scene key for subset: `project` is expanded according to `need` (`render-node/expand.mjs`,
   * deterministic), then the key is computed using the same algorithm as `entry()` (card code
   * identity also only takes what is used in the subset). Synchronous: `project` must be the copy
   * already asset-stamped (`entry.project`). Returns the key for the whole project when `need` is
   * empty
   */
  subsetFrameKey(project, need) {
    const sub = need ? expandProject(project, need).project : project;
    let cardSources = {};
    try { cardSources = this.cardSources(sub) ?? {}; } catch { cardSources = {}; }
    return frameIdentity(sub, cardEntryCode(this.code(sub), cardSources));
  }
  async entry(project) {
    project = { ...project, media: await Promise.all((project.media || []).map(async media => {
      const stamp = await this.mediaStamper.stamp(media);
      return stamp === undefined ? media : { ...media, _frameSourceStamp: stamp };
    })) };
    // Identity computed once here and recorded on entry: whole-scene key and requires.cardSources at
    // split time must come from the same calculation
    let cardSources = {};
    try { cardSources = this.cardSources(project) ?? {}; } catch { cardSources = {}; }
    const code = cardEntryCode(this.code(project), cardSources);
    const key = frameIdentity(project, code);
    if (!this.entries.has(key)) {
      const entry = { key, code, cardSources, project: structuredClone(project), recordVersion: 0, html: new Map(), controls: new Map(), dir: path.join(this.root, key), status: 'idle', error: null };
      // Controls are content addressed independently of the full-scene entry;
      // a project edit that invalidates the scene can still reuse an unchanged
      // card MOV from <pipeline-root>/controls/<control-key>.
      entry.cardCache = new CardFrameCache({ root: this.root, project: entry.project,
        capture: () => this.captureCode(), scale: () => this.scaleForLane('background'),
        // Pass a function instead of a value: entry may be created before the first prerender room opens
        // and the fingerprint is determined
        envFingerprint: () => this.envFingerprint });
      const cold = createFrameArchive({ spillDir: path.join(entry.dir, 'html-cache') });
      entry.html = cold.frames; entry.controls = cold.controls;
      entry.createControl = cold.createControl; entry.disposeArchive = cold.dispose;
      entry.mov = new MovFrameStore({ dir: entry.dir, fps: project.fps || 30, movie: false });
      // A removed or replaced full-scene frame must not stay published in the
      // playback movie: put that sample back to transparent.
      entry.mov.onEvict = frame => entry.playbackMovie?.evict(frame);
      entry.streamLocks = this.streamLocks;
      // Whole-scene key calculated from the "subset expanded from these frames" (key criteria defined in
      // 0.7.19 multi-project mode: the key recognizes things that affect visuals of these frames, not the
      // entire project).
      // Used when below-dependent streams fall back to whole scene (`belowStreamSpecs` in
      // `frame-stream.mjs`); publisher and node use the same algorithm, so the same stream is byte-for-byte
      // identical on both sides
      entry.subsetKey = need => this.subsetFrameKey(entry.project, need);
      this.entries.set(key, entry);
      entry.loading = this.loadArchive(entry).then(archive => {
        try {
          entry.disposeArchive?.();
          entry.html = archive.frames;
          entry.controls = archive.controls;
          entry.createControl = archive.createControl;
          entry.disposeArchive = archive.dispose;
        } catch { /* Disposable cache. */ }
      }, () => {});
    }
    const entry = this.entries.get(key);
    await entry.loading;
    return entry;
  }
  async loadArchive(entry) {
    const options = { dir: entry.dir, spillDir: path.join(entry.dir, 'html-cache') };
    try { return unpackFrameCache(await fs.readFile(path.join(entry.dir, 'html-manifest.json'), 'utf8'), entry.key, options); }
    catch {
      const file = path.join(entry.dir, 'snapshots.base64');
      // Old monolithic local caches are disposable. Do not read a multi-GB
      // legacy file into memory just to discover that it cannot be opened.
      if ((await fs.stat(file)).size > 32 * 1024 * 1024) throw new Error('Legacy frame cache exceeds import budget');
      return unpackFrameArchive(await fs.readFile(file, 'utf8'), entry.key, options);
    }
  }
  async portableArchive(entry) {
    await this.save(entry);
    return packFrames(entry.key, entry.html, entry.controls, { fps: entry.project.fps || 30, maxBytes: 16 * 1024 * 1024 });
  }
  async bakery(project, lane = 'agent') {
    const empty = { ...project, tracks: [], media: [] };
    const url = this.origin() + '/?export=1&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty)));
    const bakery = await openBakery({ url });
    try {
      // M4: environment fingerprint of this process is determined once the first prerender room opens;
      // only then can keys be produced when computing card plan
      await this.ensureEnvironment(bakery);
      // c10a Section 9: before changing pages, finish drawing accumulated prerender small sizes on the
      // old page
      bakery.beforeReset = b => this.flushSmallOn(b);
      await bakery.loadProject(project, { deferCards: true });
      await bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: this.scaleForLane(lane) });
      await bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      return bakery;
    }
    catch (e) { await bakery.close(); throw e; }
  }
  scaleForLane(lane) {
    // J.4: `'queue'` lane produces the same kind of output as the background pass, using the same scale
    if (lane !== 'background' && lane !== 'queue') return 1;
    const value = Number(process.env.PROMPTCUT_PRERENDER_SCALE || 1);
    return Number.isFinite(value) && value > 0 ? Math.min(3, Math.max(0.5, value)) : 1;
  }
  /** What a full-scene frame must have been produced by to be served: the
   * capture code and the keys of the cards visible at that frame. The entry key
   * already covers the project; these are the inputs it does not. Card keys are
   * unknown (null) until a browser plan has been computed for this entry.
   *
   * The device scale is deliberately not part of it: with
   * PROMPTCUT_PRERENDER_SCALE set, the background lane and the 1x lanes would
   * evict each other's frames forever and full.mov would never complete. Mixed
   * scales in one store predate this check and remain as they were. */
  // eslint-disable-next-line no-unused-vars
  renderSignature(entry, frame, lane) {
    const fps = Number(entry.project.fps) || 30;
    let cards = null;
    if (Array.isArray(entry.cardPlan)) {
      const keys = entry.cardPlan.filter(control => frame >= control.sampling.firstFrame && frame / fps < control.end - 1e-9)
        .map(control => control.key).sort();
      cards = createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 32);
    }
    return { capture: this.captureCode() || undefined, cards };
  }
  /**
   * `scaleLane`: set viewport (`scaleForLane`) by which lane's scale, default is `lane`. When doing
   * AI panel operation previews or texture prefetches on `'queue'` lane, pass `'preview'` (1x, same as
   * their original scale on the Agent lane).
   */
  async acquire(lane, project, { scaleLane = lane } = {}) {
    // The mode does not accept this lane (`'background'` / `'queue'` in `agent` mode, `'agent'` in `user`
    // mode): reject immediately without opening Chrome.
    // `'background'` is also marked `cancelled`, and the background pass stops following "yield"
    // (cloud-task.md I1)
    const refused = this.interactive ? modeRefusal(this.mode, lane) : null;
    if (refused) throw Object.assign(refused, lane === 'background' ? { cancelled: true } : {});
    // Only the background pass yields to playback while borrowed for prerendering. The `'queue'` lane
    // does not yield here (M6c integration ruling, semantics in product/platforms.md "finish the batch
    // currently on hand"): queue tasks reaching here are already claimed on hand and run until
    // finished; not claiming new ones is governed by the idle gate of this machine's node
    // (`queue-idle.mjs`). In M5b, `'queue'` was also thrown here, and claimed tasks on hand would be
    // treated as retryable failures and released.
    if (lane === 'background' && (this.backgroundYielding || this.backgroundLeaseUntil > Date.now())) throw Object.assign(new Error('Background yielded to playback'), { cancelled: true });
    const previous = this.lanes.get(lane);
    clearTimeout(previous?.timer);
    // Agent dedicated instance: when borrowed to do a prerender, the idle timer expiring only records
    // `expired` (see `release`); if the Agent borrows it again, it is not considered expired
    if (previous) previous.expired = false;
    if (previous) {
      const empty = { ...project, tracks: [], media: [] };
      const url = this.origin() + '/?export=1&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty)));
      try {
        await previous.bakery.reset(project, url, { deferCards: true });
        await previous.bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: this.scaleForLane(scaleLane) });
        await previous.bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        return previous.bakery;
      } catch { await previous.bakery.close().catch(() => {}); this.lanes.delete(lane); }
    }
    const bakery = await this.bakery(project, scaleLane);
    if (lane === 'background' && (this.backgroundYielding || this.backgroundLeaseUntil > Date.now())) {
      await bakery.close();
      throw Object.assign(new Error('Background yielded to playback'), { cancelled: true });
    }
    this.lanes.set(lane, { bakery });
    return bakery;
  }
  emptyProject(project = {}) {
    return {
      width: Number(project.width) > 0 ? project.width : 1920,
      height: Number(project.height) > 0 ? project.height : 1080,
      fps: Number(project.fps) > 0 ? project.fps : 30,
      duration: 1,
      tracks: [],
      media: [],
    };
  }
  emptyUrl(project = {}) {
    const empty = this.emptyProject(project);
    return this.origin() + '/?export=1&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty)));
  }
  async prewarmUser(project = {}) {
    // D5: instances with `interactive: false` (editor process after R7) do not keep a warm Chrome;
    // `agent` mode also does not keep one warm (does not serve user interactive frames)
    if (!this.interactive || !modeServesPrerender(this.mode)) return;
    if (this.userPrewarm) return this.userPrewarm;
    this.userPrewarm = (async () => {
      while (!this.closed && this.userPool.filter(s => !s.dead).length < this.userPoolSize) {
        try {
          const bakery = await this.bakery(this.emptyProject(project), 'user');
          if (this.closed) { await bakery.close(); return; }
          this.userPool.push({ bakery, busy: false, dead: false });
        } catch (e) {
          // A missing browser should be reported by the first request with the
          // original error.  Do not make server startup fail just because the
          // optional hot pair could not be warmed yet.
          this.userPrewarm = null;
          return;
        }
      }
    })().finally(() => { this.userPrewarm = null; });
    return this.userPrewarm;
  }
  dropUserSession(session) {
    session.dead = true;
    const at = this.userPool.indexOf(session);
    if (at >= 0) this.userPool.splice(at, 1);
    void session.bakery?.close().catch(() => {});
  }
  async acquireUser(project, signal, onSession = () => {}) {
    if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
    await this.prewarmUser(project);
    const waitStart = Date.now();
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
      const session = this.userPool.find(s => !s.dead && !s.busy);
      if (session) {
        session.busy = true;
        onSession(session);
        try {
          await session.bakery.reset(project, this.emptyUrl(project), { deferCards: true });
          await session.bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: 1 });
          await session.bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
          if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
          return session;
        } catch (e) {
          if (e.cancelled) this.releaseUser(session);
          else this.dropUserSession(session);
          throw e;
        }
      }
      // The pair is intentionally bounded.  Waiting here is short in normal
      // use; a watchdog around readFrames will kill a renderer that does not
      // release its slot.
      if (Date.now() - waitStart > USER_RENDER_TIMEOUT_MS) {
        throw Object.assign(new Error(`User preview waited for Chrome for more than ${USER_RENDER_TIMEOUT_MS / 1000} seconds; this stale request was dropped.`), { status: 504, timedOut: true });
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  releaseUser(session) {
    if (!session || session.dead) return;
    session.busy = false;
    if (this.userPool.length > this.userPoolSize) this.dropUserSession(session);
  }
  /**
   * Returns the lane's bakery and starts the idle timer. `background` shuts down if unborrowed for 30
   * seconds; `agent` after 10 minutes (`docs/plan/cloud-task.md` I1: one Chrome, spun up on demand,
   * shut down after 10 minutes idle: previously `/api/cards/dom`'s own Chrome shut down after 90
   * seconds idle, and after merging into agent lane it is managed centrally here). The next `acquire`
   * clears the timer.
   */
  release(lane) {
    const session = this.lanes.get(lane);
    if (!session) return;
    if (lane === 'user') return;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (this.lanes.get(lane) !== session) return;
      // Agent dedicated instance is currently borrowed to do a normal prerender (`kickAgentIdle`): do
      // not shut it down from underneath it; record expiration, and let that side shut it down once done
      if (session.unitRunning) { session.expired = true; return; }
      this.lanes.delete(lane);
      void session.bakery.close().catch(() => {});
    }, lane === 'agent' ? AGENT_IDLE_MS : 30000);
    session.timer.unref?.();
  }
  /** Shared public entry point. Independent requests in the same turn merge into one forward pass. */
  async see_frames(project, times, { signal, lane = 'agent', onFrame } = {}) {
    // `inter_face` is the explicit name used by the interactive client. Keep
    // `user` as a backwards-compatible alias; both must use the two hot pages.
    //
    // `preview` / `prerender` (`mechanism/rendering.md` "Query rendering and prerender processes"): not
    // Agent requests, do not enter the Agent lane, and are queued into the normal prerender queue
    // (`runQueueTask`). `preview` = operation preview opened by the user in the AI panel, inserted
    // before all pending items without occupying the Agent dedicated instance; `prerender` = normal
    // prerender (idle texture prefetch for 3D views), placed at the tail of the queue, which the Agent
    // dedicated instance can take when idle.
    lane = lane === 'playback' ? lane : lane === 'inter_face' || lane === 'user' ? 'user' : lane === 'background' ? 'background'
      : lane === 'preview' || lane === 'prerender' ? lane : 'agent';
    // The mode does not accept this lane: return error immediately (Agent query in `user` mode →
    // NO_AGENT_LANE, prerender in `agent` mode → NO_PRERENDER), does not enter batch processing
    if (this.interactive) {
      const refused = modeRefusal(this.mode, lane);
      if (refused) throw refused;
    }
    const generation = lane === 'user' ? ++this.userGeneration : 0;
    const generationController = lane === 'user' ? new AbortController() : null;
    if (generationController) {
      this.userGenerationController?.abort();
      this.userGenerationController = generationController;
    }
    const renderSignal = generationController
      ? (signal ? AbortSignal.any([signal, generationController.signal]) : generationController.signal)
      : signal;
    const entry = await this.entry(project);
    const fps = project.fps || 30;
    const max = Math.max(0, Math.floor(project.duration * fps) - 1);
    if (!times.length || times.some(t => !Number.isFinite(t))) throw new Error('Frame times must be finite numbers');
    const frames = [...new Set(times.map(t => Math.max(0, Math.min(max, Math.round(t * fps)))))];
    // Playback reservations already bound concurrency and supersede by epoch.
    // They must not cancel one another like interactive pointer requests do.
    if (lane === 'playback') return this.readFrames(entry, frames.sort((a, b) => a - b), lane, signal, onFrame);
    return new Promise((resolve, reject) => {
      if (lane === 'user' && generation !== this.userGeneration) {
        reject(Object.assign(new Error('The interactive frame request expired; the stale request was skipped.'), { status: 499, cancelled: true, superseded: true }));
        return;
      }
      if (lane === 'user') {
        // Remove requests that reached the queue before this pointer event.
        // Agent/background queues are deliberately left untouched.
        const stale = this.queue.filter(r => r.lane === 'user');
        this.queue = this.queue.filter(r => r.lane !== 'user');
        stale.forEach(r => r.reject(Object.assign(new Error('The interactive frame request was superseded by a newer request.'), { status: 499, cancelled: true, superseded: true })));
      }
      this.queue.push({ entry, frames, signal: renderSignal, lane, generation, onFrame, resolve, reject });
      if (!this.timer) this.timer = setTimeout(() => {
        this.timer = null;
        const requests = this.queue.splice(0);
        for (const currentLane of ['user', 'agent', 'preview', 'prerender', 'background']) {
          const laneRequests = requests.filter(r => r.lane === currentLane);
          if (!laneRequests.length) continue;
          // User requests are independent: the two hot Chrome slots are
          // deliberately allowed to overlap.  Agent/background lanes remain
          // serialized for deterministic animation state.
          if (currentLane === 'user') {
            const task = this.flush(laneRequests, currentLane);
            this.foreground = task;
            task.catch(() => {});
          } else if (currentLane === 'agent') {
            // #12: agent batches are queued in the same line as layout / entityRects / DOM queries, with
            // bakery borrowed and released by runAgentTask
            this.runAgentTask(lease => this.flush(laneRequests, currentLane, lease))
              .catch(error => laneRequests.forEach(r => r.reject(error)));
          } else if (currentLane === 'preview' || currentLane === 'prerender') {
            // 1x scale (`scaleLane: 'preview'`), same as when they were originally rendered on the Agent lane
            this.runQueueTask(lease => this.flush(laneRequests, currentLane, lease), undefined, { front: currentLane === 'preview', scaleLane: 'preview', kind: currentLane })
              .catch(error => laneRequests.forEach(r => r.reject(error)));
          } else {
            const chain = (this.laneChains.get(currentLane) || Promise.resolve()).catch(() => {}).then(() => this.flush(laneRequests, currentLane));
            this.laneChains.set(currentLane, chain);
          }
        }
      }, 12);
    });
  }
  /** `lease`: bakery borrowing function passed in by `runAgentTask` for agent batches; other lanes
   * do not pass it and call `acquire` themselves as usual */
  async flush(requests, lane = 'agent', lease) {
    const groups = new Map();
    for (const request of requests) {
      if (request.signal?.aborted || (lane === 'user' && request.generation !== this.userGeneration)) {
        request.reject(Object.assign(new Error('The interactive frame request expired; the stale request was skipped.'), { status: 499, cancelled: true, superseded: true }));
        continue;
      }
      const list = groups.get(request.entry.key) || [];
      list.push(request); groups.set(request.entry.key, list);
    }
    for (const group of groups.values()) {
      const entry = group[0].entry;
      const frames = [...new Set(group.flatMap(r => r.frames))].sort((a, b) => a - b);
      try {
        const result = await this.readFrames(entry, frames, lane, group.find(r => !r.signal?.aborted)?.signal, async (frame, value) => {
          for (const request of group) if (!request.signal?.aborted && request.frames.includes(frame)) await request.onFrame?.(frame, value);
        }, lease);
        for (const request of group) {
          if (request.signal?.aborted || (lane === 'user' && request.generation !== this.userGeneration)) request.reject(Object.assign(new Error('The interactive frame request expired; the stale request was skipped.'), { status: 499, cancelled: true, superseded: true }));
          else request.resolve(new Map(request.frames.map(n => [n, result.get(n)])));
        }
      } catch (e) { group.forEach(r => r.reject(e)); }
    }
  }
  async readFrames(entry, frames, lane = 'agent', signal, onFrame, lease) {
    // D5: when `interactive: false`, these two lanes reject immediately without entering `acquireUser`
    const refused = this.laneRefused(lane);
    if (refused) throw refused;
    if (lane === 'user' || lane === 'playback') {
      const watchdog = new AbortController();
      const combined = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;
      let timer, ownedSession;
      let arm = () => {};
      const work = this.readFramesCore(entry, frames, lane, combined, session => { ownedSession = session; }, async (frame, value) => {
        if (lane === 'playback') arm(); // A healthy stream may run longer than ten seconds.
        await onFrame?.(frame, value);
      });
      let cancel;
      const cancelled = new Promise((_, reject) => {
        cancel = () => {
          if (ownedSession && !ownedSession.dead) this.dropUserSession(ownedSession);
          reject(Object.assign(new Error('Frame request cancelled'), { cancelled: true }));
        };
        if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
      });
      const timeout = new Promise((_, reject) => {
        arm = () => { clearTimeout(timer); timer = setTimeout(() => {
          watchdog.abort();
          // A stalled old request must not kill the other hot Chrome serving
          // the latest pointer position. Ownership begins before reset awaits.
          if (ownedSession && !ownedSession.dead) this.dropUserSession(ownedSession);
          void this.prewarmUser(entry.project).catch(() => {});
          reject(Object.assign(new Error(`User preview rendering took more than ${USER_RENDER_TIMEOUT_MS / 1000} seconds; Chrome was restarted.`), { status: 504, timedOut: true }));
        }, USER_RENDER_TIMEOUT_MS); };
        arm();
      });
      try { return await Promise.race([work, timeout, cancelled]); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); work.catch(() => {}); }
    }
    return this.readFramesCore(entry, frames, lane, signal, undefined, onFrame, lease);
  }
  /** `lease`: see `flush`. When passed, use it to borrow bakery and do not release itself
   * (`runAgentTask` releases centrally) */
  async readFramesCore(entry, frames, lane = 'agent', signal, onSession, onFrame, lease) {
    const result = new Map();
    const htmlFrames = [];
    const missing = [];
    await entry.mov?.ready;
    // MOV is the first lookup: it is already the full scene with media and is
    // the cheapest exact answer. HTML is the high-priority producer for a
    // missing MOV frame, so random access can still avoid loading media.
    for (const frame of frames) {
      if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
      const buf = await entry.mov?.lookup(frame, this.renderSignature(entry, frame, lane));
      if (buf) result.set(frame, { buf, source: 'mov' });
      else {
        // Compatibility with the pre-MOV cumulative PNG cache. It is still a
        // valid full-scene result and lets old projects avoid a re-render.
        // It has no render record, so an empty image there is not trusted.
        try {
          const legacy = await fs.readFile(path.join(entry.dir, 'frames', pad(frame) + '.png'));
          if (isFullyTransparentPng(legacy)) throw new Error('Empty legacy frame');
          result.set(frame, { buf: legacy, source: 'rendered' });
        }
        catch { if (entry.html?.has?.(frame)) htmlFrames.push(frame); else missing.push(frame); }
      }
      if (result.has(frame)) await onFrame?.(frame, result.get(frame));
    }
    if (!htmlFrames.length && !missing.length) return result;
    // While a required card is still being prerendered, the paused stage asks
    // for the same frame every 700 ms. Serve the placeholder already rendered
    // for exactly the cards still missing instead of rendering another one.
    if ((lane === 'user' || lane === 'playback') && entry.placeholders?.size && entry.cardPlan?.length) {
      const waiting = [...htmlFrames, ...missing].filter(frame => entry.placeholders.has(frame));
      const state = waiting.length ? await entry.cardCache.renderState(entry.cardPlan, waiting) : null;
      for (const frame of waiting) {
        const absent = state.missing[frame] || [];
        if (!absent.length || entry.placeholders.get(frame) !== absent.join('\n')) continue;
        const buf = await fs.readFile(path.join(entry.dir, 'preview-frames', pad(frame) + '.png')).catch(() => null);
        if (!buf) continue;
        const value = { buf, source: 'preview', incomplete: true, missing: absent };
        result.set(frame, value);
        await onFrame?.(frame, value);
      }
      for (const list of [htmlFrames, missing]) {
        for (let i = list.length - 1; i >= 0; i--) if (result.has(list[i])) list.splice(i, 1);
      }
      if (!htmlFrames.length && !missing.length) return result;
    }
    const userSession = lane === 'user' || lane === 'playback' ? await this.acquireUser(entry.project, signal, onSession) : null;
    const bakery = userSession?.bakery || await (lease ? lease(entry.project) : this.acquire(lane, entry.project));
    try {
      // The browser owns graph planning because it is the only place that can
      // prove a legacy Chrome card's capabilities.  Cache misses are supplied
      // only to interactive rendering; agent/final lanes keep the real Chrome
      // card so their result can never accidentally become a final placeholder.
      const cardRender = await this.cardRender(entry, bakery, frames, lane);
      const incompleteFor = frame => (lane === 'user' || lane === 'playback') ? (cardRender?.missing?.[frame] || []) : [];
      if (cardRender && (Object.keys(cardRender.frames).length || (lane === 'user' || lane === 'playback') && Object.keys(cardRender.missing).length)) {
        await this.installCardRender(bakery, entry.project, cardRender);
      }
      // The full-scene MOV lane owns the result returned by see_frames. It
      // still records HTML snapshots while it advances, so the next request
      // can replay without loading media. HTML is the higher-priority cache;
      // MOV only fills frames absent from its table.
      const htmlReplay = async frame => {
        if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
        const prefixes = this.prefixes(entry);
        let buf;
        for (let i = 0; i < prefixes.length; i++) buf = await this.rasterPrefix(entry, bakery, frame, i, prefixes);
        if (!incompleteFor(frame).length) await atomic(path.join(entry.dir, 'frames', pad(frame) + '.png'), buf);
        const absent = incompleteFor(frame);
        // A placeholder is a user-preview artifact.  It must never enter the
        // durable full-scene MOV or HTML/final raster cache.
        if (!absent.length) await this.writeMov(entry, frame, buf, this.renderSignature(entry, frame, lane));
        else {
          await atomic(path.join(entry.dir, 'preview-frames', pad(frame) + '.png'), buf);
          (entry.placeholders ||= new Map()).set(frame, absent.join('\n'));
        }
        const value = absent.length ? { buf, source: 'preview', incomplete: true, missing: absent }
          : { buf, source: 'html', ...(entry.mov?.unconfirmedClear(frame) ? { unconfirmedClear: true } : {}) };
        result.set(frame, value);
        await onFrame?.(frame, value);
      };
      for (const frame of htmlFrames) await htmlReplay(frame);
      if (!missing.length) return result;
      const transient = Object.keys(cardRender?.missing || {}).length ? new Map() : null;
      await this.renderMovFrames(entry, missing, bakery, signal, async (frame, value) => {
        const absent = incompleteFor(frame);
        if (absent.length) {
          await atomic(path.join(entry.dir, 'preview-frames', pad(frame) + '.png'), value.buf);
          (entry.placeholders ||= new Map()).set(frame, absent.join('\n'));
        }
        await onFrame?.(frame, absent.length ? { ...value, source: 'preview', incomplete: true, missing: absent } : value);
      }, transient, lane);
      for (const frame of missing) {
        const buf = transient?.get(frame) || await entry.mov.get(frame);
        const absent = incompleteFor(frame);
        if (!buf && !absent.length) throw new Error(`MOV frame ${frame} was not written`);
        if (absent.length) result.set(frame, { buf, source: 'preview', incomplete: true, missing: absent });
        else result.set(frame, { buf, source: 'mov', ...(entry.mov.unconfirmedClear(frame) ? { unconfirmedClear: true } : {}) });
      }
    } finally {
      if (userSession) this.releaseUser(userSession);
      else if (!lease) this.release(lane);
    }
    return result;
  }
  async browserCardPlan(bakery) {
    try {
      return await bakery.page.evaluate(() => typeof window.__pcCardPlan === 'function' ? window.__pcCardPlan() : null);
    } catch { return null; }
  }
  async cardRender(entry, bakery, frames, lane) {
    const browserPlan = await this.browserCardPlan(bakery);
    if (!browserPlan) return null;
    // Contract F.3: the lock store must be fully read before computing card plan (`recordCardPlan`
    // swaps keys based on locks)
    await this.ensureCardLocks();
    let plan;
    try { plan = entry.cardCache.plan(browserPlan); } catch { return null; }
    // Item 4: the entry here may be the version from an Agent query, export, or another session: only
    // record the plan on itself, without claiming or resetting any session's ready index (which is only
    // done by the page's preload)
    this.recordCardPlan(entry, plan);
    if (!plan.length) return null;
    const state = await entry.cardCache.renderState(plan, frames);
    // The final/agent path deliberately does not inject `missing`: an absent
    // control must fall through to the original Chrome implementation.  The
    // interactive path gets an explicit incomplete signal for its placeholder.
    if (lane !== 'user' && lane !== 'playback') state.missing = {};
    return state;
  }
  async installCardRender(bakery, project, cardRender) {
    const rendered = { ...project, _cardRender: cardRender };
    await bakery.loadProject(rendered, { deferCards: true });
    await bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: 1 });
  }
  async renderMovFrames(entry, frames, bakery, signal, onFrame, transient = null, lane = 'background') {
    // Every write and every "already rendered" decision is checked against
    // what would produce the frame now (see renderSignature). An empty image
    // stays "waiting to render" until a second render agrees with it.
    const signature = frame => this.renderSignature(entry, frame, lane);
    const flag = frame => !transient && entry.mov.unconfirmedClear(frame) ? { unconfirmedClear: true } : {};
    // Frames the other process (editor server / prerender worker) already rendered count.
    await entry.mov.hydrate(frames);
    // Reuse HTML-complete frames first. This is the background equivalent of
    // see_frames' HTML lookup and avoids loading media for frames already
    // frozen by the higher-priority lane.
    const htmlFrames = frames.filter(frame => !entry.mov.valid(frame, signature(frame)) && entry.html.has(frame));
    for (const frame of htmlFrames) {
      if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
      const prefixes = this.prefixes(entry);
      let buf;
      for (let i = 0; i < prefixes.length; i++) buf = await this.rasterPrefix(entry, bakery, frame, i, prefixes);
      if (!transient) await atomic(path.join(entry.dir, 'frames', pad(frame) + '.png'), buf);
      if (transient) transient.set(frame, buf); else await this.writeMov(entry, frame, buf, signature(frame));
      await onFrame?.(frame, { buf, source: 'html', ...flag(frame) });
    }
    const missing = frames.filter(frame => !entry.mov.valid(frame, signature(frame)));
    if (!missing.length) return;
    const requested = new Set(missing);
    await bakeFrames(bakery, {
      out: entry.dir, targetFrames: missing, snapshotOnly: false, fullFrame: true,
      snapshotFrames: new Set(missing),
      writeFrames: false, signal,
      onFrame: async (frame, buf) => {
        if (requested.has(frame)) {
          if (transient) transient.set(frame, buf); else await this.writeMov(entry, frame, buf, signature(frame));
          await onFrame?.(frame, { buf, source: 'live', ...flag(frame) });
        }
      },
      // MOV passes still record HTML for the same live state, but only when the
      // HTML lane did not already have that frame.
      onSnapshot: (n, html, controls) => !transient && !entry.html.has(n) && requested.has(n) && this.record(entry, n, html, controls),
    });
    if (!transient) await this.save(entry);
  }
  async writeMov(entry, frame, buf, signature = null) {
    if (!entry.mov) return;
    // The whole scene copy only stores frame-by-frame PNGs (the random-access side). Previously, ffmpeg
    // was spun up here along the way to encode contiguous prefixes into `mov/full.mov`; that file was
    // only ever checked for existence and nobody read its content, so it is no longer produced (legacy
    // full-frame channel Plan B).
    await entry.mov.put(frame, buf, signature);
  }
  /** `options.anchors`: frames recorded in the anchor frame pass (`fillAnchorSnapshots`). Only makes
   * a difference in queue mode, see `recordSnapshots` */
  record(entry, n, html, controls = [], options = undefined) {
    entry.recordVersion = (entry.recordVersion || 0) + 1;
    entry.html.set(n, html);
    for (const control of controls) {
      if (!entry.controls.has(control.id)) entry.controls.set(control.id, entry.createControl?.(control.id) || new Map());
      entry.controls.get(control.id).set(control.frame, control.html);
    }
  }
  /**
   * Cards whose snapshots are produced by queue fine-grained tasks in queue mode (Contract J.5):
   * cacheable cards in the shared tier (isolated single-card render) and local tier (whole-scene
   * render). Uncacheable cards in the shared tier (`sourceDependent`) do not enter the queue, and as
   * usual are only produced by the whole-scene path or pass B (Appendix Section 2). The queue gates
   * of `planForQueue` and `recordSnapshots` use the same criterion.
   */
  queueHandles(control) {
    if (!control?.snapshotKey || !control.clipId) return false;
    const caps = control?.capabilities ?? {};
    const tier = control.tier || snapshotTier(caps);
    if (tier === 'local' || (tier === 'shared' && control.cacheable === true)) return true;
    if (tier === 'none') {
      const stateful = control.frameMode === 'stateful' || caps.frameMode === 'stateful' || control.needPrerendering === true || caps.need_prerendering === true || caps.needPrerendering === true;
      const compositing = control.compositing ?? caps.compositing ?? 'unknown';
      return stateful && (compositing !== 'sourceDependent' || control.cacheable === true);
    }
    return false;
  }
  /** clipIds where `queueHandles` is true in this entry's card plan (cached by plan object) */
  queueHandledClips(entry) {
    const plan = entry?.cardPlan;
    if (!Array.isArray(plan)) return new Set();
    if (entry.queueHandledPlan !== plan) {
      entry.queueHandledPlan = plan;
      entry.queueHandledSet = new Set(plan.filter(control => this.queueHandles(control)).map(control => control.clipId));
    }
    return entry.queueHandledSet;
  }
  /**
   * pinned render 9: **Only prerender cards in the prerender set `plan.prerenderSet` (the union of
   * cards classified as heavy at any position)**: cards classified as light at all positions do not
   * produce snapshots and do not enter the ready index.
   *
   * The set is calculated by `adoptCardPlan` using the same `planPipelines` on both ends according to
   * measured `costs`; when there is no cost record at all, `prerenderSetOfPlan` falls back to
   * declarations (`declaredHeavy`) itself. When the set has not been computed at all (has not gone
   * through `adoptCardPlan`, such as callers manually constructing entries), it does not filter.
   */
  prerenderPicked(entry, clipId) {
    const set = entry?.prerenderSet;
    if (!(set instanceof Set)) return true;
    return set.has(clipId);
  }
  /**
   * Track streams are only provided for cards **classified as heavy on this machine**
   * (`basePrerenderSet`, excluding clips that entered via prerender retry): prerender retry plans
   * (the `backfill` tier of old pages; since 2026-10-07, online pages always send normal-priority
   * manifest plans, this tier has no new publishers and is kept only to recognize old pages during
   * deployment transitions) do not cut over to streams, and producing streams for light cards that
   * entered the set for it is just wasted effort. Falls back to `prerenderPicked` when there is no
   * base set.
   */
  streamPicked(entry, clipId) {
    const base = entry?.basePrerenderSet;
    if (!(base instanceof Set)) return this.prerenderPicked(entry, clipId);
    return base.has(clipId);
  }
  /**
   * Prerender retry (c10a Contract Section 17) (the `backfill` tier of old pages; since 2026-10-07,
   * online pages always send normal-priority manifest plans; this tier has no new publishers and is
   * kept only to recognize old pages during deployment transitions): for clips classified as heavy
   * and lacking output in the asset service, the page publishes a prerender retry plan task with a
   * clip manifest; the node claiming it records the clips from the manifest here as "this content of
   * this card needs to be produced", so they enter this version's prerender set (`prerenderPicked` is
   * true: fine-grained tasks can render them, they are listed in the layer table, and the online page
   * retrieves small size based on this).
   *
   * Recorded by "project id → clip + content identity", not by entry: the same version of a project
   * may have more than one entry on this machine (pushed by the page, fetched from the document
   * service); whichever writes the layer table must include prerender retry clips, otherwise the two
   * sides write alternately and they appear and disappear on the page. If the content identity
   * changes (this card's parameters were modified), it no longer counts: new content has no output,
   * and the page will send another prerender retry. Only recorded in memory, and invalidated with the
   * process just like the queue.
   * Returns the number of newly recorded clips.
   */
  addBackfill(entry, clipIds) {
    const projectId = entry?.project?.id;
    if (!projectId || !Array.isArray(entry.cardPlan)) return 0;
    const want = new Set((clipIds ?? []).filter(id => typeof id === 'string' && id));
    if (!want.size) return 0;
    this._backfill ??= new Map();
    let keys = this._backfill.get(projectId);
    if (!keys) this._backfill.set(projectId, (keys = new Set()));
    let added = 0;
    for (const control of entry.cardPlan) {
      if (!want.has(control?.clipId)) continue;
      const id = backfillIdentity(entry, control);
      if (id && !keys.has(id)) { keys.add(id); added++; }
    }
    if (!added) return 0;
    for (const other of this.entries?.values?.() ?? []) {
      if (other?.project?.id === projectId && Array.isArray(other.cardPlan)) this.applyBackfill(other);
    }
    this.publishLayerMap(entry);
    return added;
  }
  /** Merges clips into this entry's prerender set according to prerender retry registrations
   * (`basePrerenderSet` ∪ registered clips whose content identity matches) */
  applyBackfill(entry) {
    const base = entry?.basePrerenderSet;
    if (!(base instanceof Set)) return;
    const keys = this._backfill?.get(entry.project?.id);
    const extra = [];
    if (keys?.size) {
      for (const control of entry.cardPlan ?? []) {
        if (!control?.clipId || base.has(control.clipId)) continue;
        const id = backfillIdentity(entry, control);
        if (id && keys.has(id)) extra.push(control.clipId);
      }
    }
    const next = extra.length ? new Set([...base, ...extra].sort()) : base;
    const cur = entry.prerenderSet;
    if (cur instanceof Set && cur.size === next.size && [...next].every(id => cur.has(id))) return;
    entry.prerenderSet = next;
  }
  /** clipId → { tier, key }: which tier and which key the control subtree frozen by the whole-scene
   * path should land on. Only `plan` in `card-cache.mjs` holds the shared key (calculated by
   * `cardSnapshotIdentity`), so here we recognize `entry.cardPlan` (the copy saved in `preload`); if
   * unavailable, do not write to the snapshot store. Cards not in the prerender set are never given a
   * target: the whole-scene path (`recordSnapshots` / `renderLocalSnapshots`) therefore produces
   * nothing for them (pinned render 9). */
  snapshotTargets(entry) {
    const plan = entry.cardPlan;
    if (!plan?.length) return null;
    if (entry.snapshotPlan !== plan || entry.snapshotTargetSet !== entry.prerenderSet || entry.snapshotLockEpoch !== this.cardLockEpoch) {
      entry.snapshotPlan = plan;
      entry.snapshotTargetSet = entry.prerenderSet;
      entry.snapshotLockEpoch = this.cardLockEpoch;
      entry.snapshotTargetMap = new Map(plan
        // Contract F.3 "do not produce frames for the locking party": cards locked by other environments
        // are not given a target, and the whole-scene path (including the anchor frame pass) does not write
        // them
        .filter(control => control.clipId && control.snapshotKey && control.cardLock?.foreign !== true && this.prerenderPicked(entry, control.clipId))
        .map(control => [control.clipId, { tier: control.tier || snapshotTier(control.capabilities), key: control.snapshotKey, capabilities: control.capabilities,
          // Used to acquire the lock before writing frames: lock key of the shared tier and this machine's
          // own fingerprint
          contentKey: control.contentKey, envFingerprint: control.ownEnvFingerprint ?? control.envFingerprint }])
        .filter(([, target]) => target.tier === 'shared' || target.tier === 'local'));
    }
    return entry.snapshotTargetMap;
  }
  /**
   * This machine acquires the lock before writing frames for a shared-tier target (Contract F.3
   * "acquire lock before rendering"). If there is no lock store, it is not a shared tier, or there is
   * no content key or fingerprint, it is always treated as acquired (does not participate in
   * locking). If it cannot be acquired (the page just locked this card first), reorder the entry's
   * card plan according to the lock store and return false: the caller will no longer write HTML
   * snapshots for this card on this pass.
   */
  acquireCardLock(entry, target, controls = null) {
    const store = this.cardLockStore;
    if (!store || target?.tier !== 'shared' || !target.contentKey || !target.envFingerprint) return true;
    let granted = true;
    try { granted = store.acquire(target.contentKey, target.envFingerprint, 'prerender').granted; } catch { return true; }
    // If not acquired: reorder by lock store. If lock was just created: record `cardLock` on control
    // (visible in diagnostics), key unchanged
    const unmarked = list => Array.isArray(list) && list.some(control => control?.contentKey === target.contentKey && !control.cardLock);
    if (!granted || unmarked(entry?.cardPlan) || unmarked(controls)) this.reapplyCardLocks(entry, controls);
    return granted;
  }
  /**
   * The control HTML frozen by the whole-scene path (C2) is simultaneously written into the A3a
   * snapshot store (`<root>/controls-html/<shared key>/` and
   * `<root>/controls-local/<entry.key>/<shared key>/`).
   *
   * The legacy `entry.controls` → `html-manifest.json` is **retained as well**: today's playback and
   * export still read from that manifest (`renderState` / `unpackFrameCache`), and pulling it now
   * would directly cause missing material. While both coexist, the snapshot store is the
   * "destination" and the manifest is the "current state"; the read side switches only after step 4.
   *
   * `belowDependent` (frosted glass) can only be produced by this whole-scene path: its result is
   * affected by lower layers and cannot be drawn in an isolated project. Its local tier key in this
   * version falls back to the whole project's `entry.key` according to A3a first (coarser: any change
   * in the project changes `entry.key` and invalidates the entire local tier); `localSceneKey` and
   * "shared key + position of active controls in lower layers" are matters for later.
   */
  recordSnapshots(entry, controls, options = undefined) {
    let targets = this.snapshotTargets(entry);
    if (!targets?.size || !controls?.length) return;
    /*
     * Queue mode (Contract J.5: "no longer run the snapshot portion of the original background pass;
     * anchor frames, streams, and whole scene are produced by preload as before"): for cards produced
     * by queue fine-grained tasks (`queueHandles`), the whole-scene path (pass B, the MOV pass, frames
     * recorded along with Agent queries) only records full-frame HTML and no longer writes their
     * snapshots along the way; the anchor frame pass still writes as usual. `entry.queueSnapshots` is
     * only set by preload in queue mode; when not set (switch is off, and all existing callers),
     * nothing is skipped here.
     */
    const handled = entry.queueSnapshots === true && options?.anchors !== true ? this.queueHandledClips(entry) : null;
    for (const control of controls) {
      if (handled?.has(control.id)) continue;
      const target = targets.get(control.id);
      if (!target || !Number.isInteger(control.frame)) continue;
      // Contract F.3 "acquire lock before rendering": acquire lock before each frame enters the batch for
      // shared tier; if cannot be acquired (page just locked this card), do not write this frame; card
      // plan has been reordered by lock store, and after re-fetching target this card no longer has a
      // target
      if (this.acquireCardLock && !this.acquireCardLock(entry, target)) {
        targets = this.snapshotTargets(entry) ?? new Map();
        continue;
      }
      const entryKey = target.tier === 'local' ? entry.key : undefined;
      const batches = (entry.snapshotPending ||= new Map());
      const id = `${target.tier}\u0000${entryKey ?? ''}\u0000${target.key}`;
      // #9: writing frames, checking size, and merging index are done together by the snapshot store's
      // `batch` (committed once 4 frames accumulate). A3c's general fallback remains as usual: the
      // oversized frame is **written to disk as usual**, but does not enter the ready index and is not
      // delivered: that layer is treated as missing material (paste an earlier qualified snapshot, or
      // transparent if none), and records a diagnostic; R6-14: frame number is recorded in index.json's
      // `oversize`, skipped on the next pass.
      if (!batches.has(id)) batches.set(id, this.snapshots().batch({ tier: target.tier, entryKey, key: target.key, clipId: control.id, capabilities: target.capabilities }));
      const batch = batches.get(id);
      const html = control.html;
      entry.snapshotChain = (entry.snapshotChain || Promise.resolve()).then(async () => {
        // The snapshot store is a side path: write failures must not bring down the entire prerender
        // pipeline (the old manifest was still written successfully).
        try { await batch.add(control.frame, html); } catch {}
      });
    }
  }
  /** Wait for this batch of frames to commit (writing files + merging index, done together by
   * snapshot store's `batch`), then send all ready ranges for this layer at this moment according to
   * C3 (full semantics). Batches with all oversized frames still write index (R6-14), just without
   * sending `layer`. */
  async flushSnapshots(entry) {
    try { await entry.snapshotChain; } catch {}
    const batches = entry.snapshotPending;
    if (!batches?.size) return;
    entry.snapshotPending = new Map();
    for (const batch of batches.values()) {
      try {
        const index = await batch.close();
        /*
         * Question F (`server/test/ready-stale-flush.test.mjs`): the page has already switched to the next
         * version before this batch of the old entry finishes committing. The batch is written to disk as
         * usual (the snapshot store is content-addressed, so other versions can still use it); whether it
         * is published is determined by the gate in `publishLayer`: only enters sessions whose current
         * version is precisely this entry.
         */
        // Contract F.3: this card is currently locked on another environment (layer has been swapped to the
        // locking party's key), so this machine no longer sends layers for this batch to avoid swapping the
        // layer back
        const lockedAway = batch.tier === 'shared' && (entry.cardPlan ?? []).some(control =>
          control?.clipId === batch.clipId && control.cardLock?.foreign === true && control.snapshotKey !== batch.key);
        if (index && batch.written && !lockedAway) this.publishLayer(entry, { clipId: batch.clipId, snapshotKey: batch.key }, batch.tier, index.frames);
      } catch {}
    }
  }
  async save(entry) {
    const work = (entry.saveChain || Promise.resolve()).catch(() => {}).then(() => this.saveNow(entry)).then(() => this.flushSnapshots(entry));
    entry.saveChain = work;
    return work;
  }
  async saveNow(entry) {
    const version = entry.recordVersion;
    if (entry.savedVersion !== undefined && entry.savedVersion === version) return;
    const encoded = packFrameCache(entry.dir, entry.key, entry.html, entry.controls, {
      fps: entry.project.fps || 30,
    });
    await atomic(path.join(entry.dir, 'html-manifest.json'), encoded);
    entry.savedVersion = version;
    if (entry.recordVersion !== version) return;
    // Re-open our own archive so the hot pipeline keeps compressed blocks and
    // only a small expanded window, rather than every full HTML string.
    const archive = unpackFrameCache(encoded, entry.key, { dir: entry.dir, spillDir: path.join(entry.dir, 'html-cache') });
    // Concurrent playback batches may record new frames during the disk write.
    // Do not replace their live map with the older archive snapshot.
    if (entry.recordVersion === version) {
      const dispose = entry.disposeArchive;
      entry.html = archive.frames;
      entry.controls = archive.controls;
      entry.createControl = archive.createControl;
      entry.disposeArchive = archive.dispose;
      dispose?.();
    }
  }
  /** Abort the background generations of owners that stopped asking (PRELOAD_STALE_MS).
   * Background passes run one after another, so a generation nobody waits
   * for would otherwise hold every later project behind its whole pipeline. */
  retireStalePreloads(owner, now = Date.now()) {
    for (const [other, generation] of this.generations) {
      if (other === owner || now - generation.seenAt <= PRELOAD_STALE_MS) continue;
      // A generation that has finished running has no work to kill: keep it, otherwise its owner's next
      // keepalive preload will rerun the entire background pass (two tabs killing each other, each
      // rerunning every 30 seconds, Item 4 review #1). A new session visiting for the first time will
      // still rerun a pass (mostly hitting cache), and thereafter takes "return directly for the same
      // entry". Only delete those unqueried for a long time to avoid staying resident
      if (this.entries.get(generation.key)?.status === 'ready' && now - generation.seenAt <= READY_SESSION_IDLE_MS) continue;
      generation.controller.abort();
      this.generations.delete(other);
    }
  }
  /**
   * Background prerender for this version of the page. **Sole source of session "current version"**
   * (Item 4 business decision 2): `session` is the session of the page mirror (brought from the body
   * by HTTP `/preload`; if omitted by scripts, it is the default session), `localRev` is the page's
   * revision number. `adopt: false` (those rescheduled after yielding) only queues work without
   * touching any session's version.
   *
   * `queue` (Contract J.5): `true` = passed by `/preload` route in queue mode, `false` = fallback to
   * this machine producing on its own (when unable to connect to document service); if omitted
   * (default, all existing callers), leaves the mode recorded on entry untouched.
   * Ji-2: after removing HTML snapshots for each card, anchor frames are directly marked ready,
   * streams update as usual, and writing PNG/MOV for whole scene and legacy full-frame channel
   * remains as before.
   *
   * @param {any} project
   * @param {{ session?: string, localRev?: unknown, adopt?: boolean, owner?: string, ticket?: number, queue?: boolean }} [options]
   */
  async preload(project, { session = DEFAULT_READY_SESSION, localRev, adopt = true, owner: as = undefined, ticket: issued = undefined, queue = undefined } = {}) {
    // `agent` mode does not prerender (cloud-task.md I1): queue nothing, return `{ skipped: 'agent' }`,
    // and route returns to caller as usual
    if (this.interactive && !modeServesPrerender(this.mode)) return { skipped: this.mode };
    session = typeof session === 'string' ? session : DEFAULT_READY_SESSION;
    // `ticket`: the HTTP entry point took a ticket for it before waiting for the mirror (by arrival
    // order, not by completion order, review #6)
    const ticket = adopt ? (issued ?? this.ready.request(session)) : undefined;
    const entry = await this.entry(project);
    // Storage usage: keys used by this opened version are marked in-use (record whole scene and local
    // tier first when the plan has not been computed, then `recordCardPlan` records all after computed)
    this.usage?.touchEntry(entry);
    if (queue !== undefined) entry.queueSnapshots = queue === true;
    if (adopt) {
      // During the phase computing entry, a newer preload arrives for the same session: this request is
      // invalidated: do not claim, and do not schedule background work (scheduling would kill the
      // background generation just started for the newer version)
      if (this.ready.stale(session, ticket, localRev)) return entry;
      // The same content key can be reused by a new session; the old session's full-frame MOV / video may
      // still occupy the background queue.
      // When the card plan is already on hand, recalculate the set by latest costs first and revoke old
      // layers for cards classified as light, so pipeline decisions for the new session do not take
      // effect only after the entire video finishes. Background still fills missing frames per this set.
      if (entry.cardPlan?.length) this.adoptCardPlan(entry, entry.cardPlan);
      this.adoptSession(session, entry, localRev, ticket);
      // c10a Section 9: when switching back to a version whose plan is already computed (undo, switching
      // back and forth), the layer table also switches back to this version
      if (entry.cardPlan?.length) this.publishLayerMap(entry);
    }
    // Background generation is partitioned by session (two tabs each have one generation and do not
    // kill each other); default session uses project id as before
    const owner = as ?? (session !== DEFAULT_READY_SESSION ? `session:${session}` : (project.id || 'active'));
    const now = Date.now();
    this.retireStalePreloads(owner, now);
    const previous = this.generations.get(owner);
    if (previous?.key === entry.key && !previous.controller.signal.aborted && !['error', 'cancelled', 'partial'].includes(entry.status)) {
      previous.seenAt = now;
      return entry;
    }
    previous?.controller.abort();
    const controller = new AbortController();
    this.generations.set(owner, { key: entry.key, controller, seenAt: now });
    entry.status = 'queued';
    this.background = this.background.catch(() => {}).then(async () => {
      if (controller.signal.aborted) return;
      let bakery;
      // Contract F.8 Item 2: cards deferred during this pass and still fresh when judged again at the end
      // are periodically re-evaluated when the pass ends
      const deferredCards = [];
      try {
        entry.status = 'html';
        const count = Math.max(1, Math.floor(project.duration * (project.fps || 30)));
        bakery = await this.acquire('background', entry.project);
        const browserPlan = await this.browserCardPlan(bakery);
        await this.ensureCardLocks();
        let cardPlan = [];
        try { cardPlan = browserPlan ? entry.cardCache.plan(browserPlan) : []; } catch {}
        if (browserPlan) this.adoptCardPlan(entry, cardPlan);
        // c10a Section 9: this version's layer table is written to the content store, from which the online
        // page pulls prerender small size by manifest
        if (browserPlan && !controller.signal.aborted) this.publishLayerMap(entry);
        // C6.4 Section 5: when a push queue is configured (can connect to asset service and document
        // service), check the manifest in content store by this version's card plan first, pull segments
        // already produced by other machines, then start the background pass: segments pulled will not be
        // rendered again on this machine. Does nothing here if not configured
        if (browserPlan && this.pushQueue && !controller.signal.aborted) {
          try { await this.adoptFromManifests(entry, this.pushQueue.content, this.pushQueue.client, { signal: controller.signal }); } catch {}
          // Task brief "Jia-2": another environment (produced by online page itself) already has the full
          // single-card stream; pull it back and use its key, this machine does not re-produce
          try { await this.adoptForeignStreams(entry, this.pushQueue.content, this.pushQueue.client, { signal: controller.signal }); } catch {}
        }
        entry.stage = 'required';
        if (!controller.signal.aborted) {
          entry.anchorsReady = true;
          this.ready.markDone(entry.key);
        }
        // R8 / G4: start track stream production. It has its own session (`streamPool`), does not occupy
        // this lane, nor wait for it: here it merely hands this version's stream to the producer
        if (!controller.signal.aborted) void this.streamProducer()?.update(entry).catch(() => {});
        // Ji-2: retain the branch in fillCardControls that writes controls/<key> PNG/MOV for legacy
        // full-frame channel
        deferredCards.push(...(await this.fillCardControls(entry, bakery, controller.signal, cardPlan.filter(c => c.cacheable && c.needPrerendering), { share: true })) ?? []);
        // Ji-2: remove local tier snapshot pass renderLocalSnapshots
        await this.fillRequiredScene(entry, bakery, controller.signal, cardPlan);
        if (this.playback?.playing) { entry.status = 'partial'; return; }
        entry.stage = 'direct';
        deferredCards.push(...(await this.fillCardControls(entry, bakery, controller.signal, cardPlan.filter(c => c.cacheable && !c.needPrerendering), { share: true })) ?? []);
        // `size === count` is not enough for a sparse archive: a foreground
        // request can contain exactly `count` entries while still missing one
        // frame and containing an out-of-range index.  C must only start after
        // B has every frame in the canonical 0..count-1 range.
        const complete = entry.html.size === count && [...Array(count).keys()].every(n => entry.html.has(n));
        if (!complete) {
          const blockFrames = Math.max(1, Math.min(16, Math.round(project.fps || 30)));
          await bakeFrames(bakery, { out: entry.dir, frames: `0-${count - 1}`, snapshotOnly: true,
            signal: controller.signal, onSnapshot: async (n, html, controls) => {
              this.record(entry, n, html, controls);
              // Publish small increments: a 60-second batch of frozen 1080p
              // HTML can take seconds to compress even when spills bound RAM.
              if ((n + 1) % blockFrames === 0) await this.save(entry);
            } });
          await this.save(entry);
        }
        entry.status = 'mov';
        // MOV must contain the full scene, including media. Its pass shares
        // the already warm background Chrome but deliberately uses the live
        // full-frame capture path; HTML snapshots have media removed.
        await this.fillMov(entry, controller.signal, bakery);
        entry.status = 'video';
        await this.prerender(entry, bakery, controller.signal);
        entry.status = 'ready';
        entry.stage = 'ready';
      } catch (e) {
        entry.status = controller.signal.aborted ? 'cancelled' : 'error';
        entry.error = controller.signal.aborted ? null : String(e.message || e);
        // A cancelled MOV pass leaves its stream open; closing the pipeline
        // later would publish that prefix as the whole movie. Drop the stream;
        // the next pass replays the PNGs.
        if (controller.signal.aborted) await entry.mov?.suspend().catch(() => {});
      } finally {
        if (entry.stage !== 'ready') entry.stage = undefined;
        if (bakery && this.lanes.get('background')?.bakery === bakery) this.release('background');
        if (deferredCards.length && !controller.signal.aborted) this.scheduleCardLockRetry(entry, deferredCards, controller.signal);
        // Storage usage: record once more after this pass finishes (track stream is only available then);
        // when a tick arrives, check once whether eviction is needed
        this.usage?.touchEntry(entry);
        this.usage?.afterBatch();
      }
    });
    return entry;
  }
  /**
   * Whole-scene frame-by-frame PNG backfill (including full frames of assets, which is what
   * `readFramesCore` checks in step 1). Previously used whether `mov/full.mov` existed to determine
   * "already done" and encoded PNGs into that file; as of Plan B, it is no longer encoded, and
   * `renderMovFrames` itself skips frames that already exist and are valid in the table, so the second
   * pass only reads frame output records once without re-rendering.
   */
  async fillMov(entry, signal, bakery) {
    if (!entry.mov) return;
    const fps = entry.project.fps || 30;
    const count = Math.max(1, Math.floor(entry.project.duration * fps));
    if (signal?.aborted) throw new Error('Cancelled');
    await this.renderMovFrames(entry, Array.from({ length: count }, (_, i) => i), bakery, signal);
    await entry.mov.finish();
  }
  async fillRequiredScene(entry, bakery, signal, controls) {
    const fps = Number(entry.project.fps) || 30, wanted = new Set();
    for (const control of controls) if (control.needPrerendering && !control.cacheable) {
      for (let frame = control.sampling.firstFrame; frame / fps < control.end - 1e-9; frame++) wanted.add(frame);
    }
    if (wanted.size) await this.renderMovFrames(entry, [...wanted].sort((a, b) => a - b), bakery, signal);
  }
  /** A3a HTML snapshot store (<root>/controls-html, <root>/controls-local). Coexists with
   * `entry.cardCache` (PNG/MOV, used by legacy full-frame channel and export): the latter will be
   * deleted together with the legacy channel, and before then is written as usual, otherwise export
   * and the legacy playback path will lack material. */
  snapshots() {
    if (this._snapshots) return this._snapshots;
    const store = new SnapshotStore(this.root);
    /*
     * Snapshot hook in C6.4 Section 4: each time `commitSnapshots` (which `batch` also goes through)
     * finishes writing a batch, each segment covered by this batch enters the push queue. When no push
     * queue is configured and small size is not enabled, return `commitSnapshots`'s own promise as is:
     * no extra tick, no extra writes.
     */
    const commit = store.commitSnapshots.bind(store);
    store.commitSnapshots = args => {
      const done = commit(args);
      // Standalone render host: has no push queue, but small size is enabled (`enableSmallTier`), so
      // still record this batch's small sizes
      if (!this.pushQueue && !this.smallTierEnabled()) return done;
      return done.then(index => {
        if (this.pushQueue) { try { this.enqueueSnapshotPush(args); } catch {} }
        // c10a Section 9: prerender small sizes for the same batch of frames (only when push queue is
        // configured and this process already has a running prerender Chrome; does not block this batch)
        try { this.scheduleSmallSnapshots(args); } catch {}
        return index;
      });
    };
    return this._snapshots = store;
  }
  /**
   * Shared key / local tier directory key → corresponding control in card plan (push hook needs
   * its `count`, `contentKey`, and capabilities).
   * Local tier is only looked up in that entry's plan; shared tier is looked up across all active
   * entries (keys are content-addressed, so any entry is the same).
   */
  controlForSnapshotKey(tier, entryKey, key) {
    const match = control => control && (control.snapshotKey === key) && (control.tier || snapshotTier(control.capabilities)) === tier;
    if (tier === 'local') return (this.entries.get(entryKey)?.cardPlan ?? []).find(match) ?? null;
    for (const entry of this.entries.values()) {
      const hit = (entry.cardPlan ?? []).find(match);
      if (hit) return hit;
    }
    return null;
  }
  /**
   * Card-level push priority (A5): `canvasHeavy`, media effect card, `unknown`, `belowDependent`
   * (and `context`, which is also below-dependent), or local tier → 1 `low`;
   * Remaining shared tiers → 0 `normal`. Chunk-level (over half `data:image`, oversized frames)
   * is computed by the push queue when it reaches this segment, taking the lower one.
   */
  cardPushPriority(control, tier, capabilities) {
    if (tier === 'local') return PUSH_LOW;
    const caps = capabilities ?? control?.capabilities ?? {};
    if (caps.canvasHeavy === true || control?.capabilities?.canvasHeavy === true) return PUSH_LOW;
    const compositing = caps.compositing ?? control?.compositing ?? control?.capabilities?.compositing;
    // Shared tier by definition only has independent / sourceDependent; here only explicitly written
    // below-dependent values are recognized, unwritten does not count (no guessing)
    if (compositing === 'unknown' || compositing === 'belowDependent' || compositing === 'context') return PUSH_LOW;
    if (this.isGraphCardControl(control)) return PUSH_LOW;
    return PUSH_NORMAL;
  }
  /**
   * Whether this card is a media effect card (H). The server-side card plan currently has no field
   * to determine it (`isGraphCard` in `split.mjs` is also injected by caller, defaulting to false),
   * so it returns false by default; only recognizes `graphCard: true` explicitly written on control.
   * Recorded as questionable in the report.
   */
  isGraphCardControl(control) {
    return control?.graphCard === true || control?.capabilities?.graphCard === true;
  }
  /**
   * Body of snapshot hook: which segments this batch of frames from `commitSnapshots` falls into;
   * each segment enters the push queue once (the queue deduplicates itself).
   * Segments use the same slicing method as `split.mjs`: starting from local frame 0, one segment
   * every `PUSH_SNAPSHOT_SPAN` frames, with the last segment up to `count - 1` (when this card
   * cannot be found in card plan, `count` is unknown, so calculate by full segment span).
   *
   *   Shared tier: `resultKey = sharedKey` (directory key);
   *   Local tier: `resultKey = resultKeyOf("<entryKey>/<contentKey>", fingerprint)`,
   *           `dirKey` is on-disk directory key (E.9). Local tier must find this card in card
   *           plan to compute result key; if not found, it does not enter the queue.
   *
   * Frames pulled from asset service (`applyResult` with `adopted: true`) do not enter the queue:
   * they are already on the asset service.
   */
  enqueueSnapshotPush(args) {
    const queue = this.pushQueue;
    if (!queue || !args || args.adopted === true) return 0;
    const { tier, key } = args;
    if ((tier !== 'shared' && tier !== 'local') || !key) return 0;
    const frames = (args.items ?? []).map(item => item?.localFrame).filter(frame => Number.isInteger(frame) && frame >= 0);
    if (!frames.length) return 0;
    const entryKey = tier === 'local' ? args.entryKey : null;
    if (tier === 'local' && !entryKey) return 0;
    const control = this.controlForSnapshotKey(tier, entryKey, key);
    let resultKey = key;
    if (tier === 'local') {
      const fp = control?.envFingerprint ?? this.envFingerprint;
      if (!control || !fp) return 0;
      resultKey = resultKeyOf(`${entryKey}/${control.contentKey ?? control.snapshotKey}`, fp);
    }
    const span = PUSH_SNAPSHOT_SPAN;
    const count = Number.isInteger(control?.count) && control.count > 0 ? control.count : null;
    const priority = this.cardPushPriority(control, tier, args.capabilities);
    const canvasHeavy = args.capabilities?.canvasHeavy === true || control?.capabilities?.canvasHeavy === true;
    let queued = 0;
    for (const from of new Set(frames.map(frame => frame - (frame % span)))) {
      const to = count !== null && from < count ? Math.min(count - 1, from + span - 1) : from + span - 1;
      // Contract Section 9 Item 1: enqueue takes effect synchronously; returned promise is write to
      // disk; hook does not wait for it
      void Promise.resolve(queue.enqueue({ kind: 'snapshot', tier, resultKey, dirKey: key, entryKey, range: { from, to }, canvasHeavy }, priority)).catch(() => {});
      queued++;
    }
    return queued;
  }
  /**
   * Body of stream hook (called every time `StreamProducer.storeSegment` finishes writing a segment):
   * enqueues the segment it belongs to into the push queue; streams are all treated as 1 `low`.
   * Segments start from this stream's `firstSegment`, with one segment every `PUSH_STREAM_SEGMENTS`
   * segments, and the last segment up to `lastSegment` (same as `split.mjs`).
   */
  /*
   * ---------------------------------------------------------------- Prerender small size (c10a Section 9)
   *
   * After render node produces a batch of HTML snapshots (after `commitSnapshots` finishes writing),
   * on the **same prerender room** (before it changes page, when old page is idle, `flushSmallOn`),
   * captures each frame of this batch into a small WebP bitmap (`bakery/small-bitmap.mjs`: content
   * inside clip box, scaled into 800×600 per project aspect ratio), and writes it to
   * `<localFrame>.small.webp` in the same directory as snapshots (`index.json` and
   * `<localFrame>.html` remain completely untouched). Once written, the segment containing this
   * batch is enqueued once more into the push queue: small bitmaps are pushed along with the segment
   * to the asset service (`px`), with the manifest containing a `small` table
   * (`artifact-transfer.mjs`).
   *
   * Ji-2 (contract, 2026-10-13): prerender small size has been discontinued, two tiers changed to one
   * tier, smallTierEnabled is always false.
   */
  smallTierEnabled() {
    return false;
  }
  /**
   * Standalone render host (`startHostNode` in `vite-plugin-frames.ts`) has no push queue, and
   * artifacts are pushed by sinks on each project node: it is also a render node, and per
   * `product/rendering.md` "two tiers" and c10a Section 9 ("generated together by render nodes
   * (queue nodes in desktop app, standalone render hosts)"), it likewise needs to produce small size:
   * call here to enable before starting node. Once enabled, `commitSnapshots` still records small
   * sizes for each batch and draws them upon page change; sink completion condition still requires
   * two tiers (`docs/archive/agent-reports/AGENT-xnode-dedup.md`: when host only pushes
   * original size, other nodes claiming segments it completed can only backfill small sizes,
   * unable to deduplicate).
   */
  enableSmallTier() {
    this.smallTierForced = true;
  }
  /**
   * This batch needs small sizes generated: record them (without waiting, without launching Chrome),
   * and when next time a prerender room changes page, draw them on **the page to be discarded**
   * (`flushSmallOn`). Why not open another page on the spot: opening a second controlled page
   * concurrently in Chrome with frame control (`--enable-begin-frame-control`) was empirically
   * measured to freeze ready waiting on that prerender room page ("export page not ready after 60s");
   * whereas a prerender room originally needs to `reset` and switch to a new page before each batch
   * starts work, and the old page is idle at this time.
   * Returns whether it was recorded. If too many accumulate (this process has not changed page for
   * a long time), only keep the newest `SMALL_PENDING_MAX` frames.
   */
  scheduleSmallSnapshots(args) {
    if (!this.smallTierEnabled() || !args || args.adopted === true) return false;
    const { tier, key } = args;
    if ((tier !== 'shared' && tier !== 'local') || !key) return false;
    const items = (args.items ?? []).filter(item => Number.isInteger(item?.localFrame) && item.localFrame >= 0 && typeof item.html === 'string');
    if (!items.length) return false;
    const pending = this.smallPending ??= [];
    pending.push({ ...args, items });
    let frames = pending.reduce((n, job) => n + job.items.length, 0);
    while (frames > SMALL_PENDING_MAX && pending.length > 1) { frames -= pending.shift().items.length; this.smallStats.dropped++; }
    return true;
  }
  /**
   * All currently generating prerender small sizes settle (awaited before `collectSnapshotResult`
   * lists manifest; if none are generating, resolves immediately without rendering)
   */
  whenSmallSettled() {
    return (this.smallChain ?? Promise.resolve()).catch(() => {});
  }
  get smallStats() {
    return this._smallStats ??= { written: 0, skipped: 0, failed: 0, dropped: 0, lastError: null };
  }
  /**
   * Prerender room is about to change page (`beforeReset` called at start of `reset` / `resetWith`
   * in `chrome.mjs`): finish drawing recorded small sizes on this page.
   * This page will be closed immediately; changing viewport or hiding root node on it will not
   * affect subsequent rendering.
   */
  flushSmallOn(bakery) {
    const jobs = this.smallPending?.splice(0) ?? [];
    if (!jobs.length || this.closed || !this.smallTierEnabled()) return this.whenSmallSettled();
    this.smallChain = (this.smallChain || Promise.resolve()).catch(() => {}).then(async () => {
      const started = Date.now();
      const renderer = createSmallRenderer(bakery);
      for (const job of jobs) {
        try { await this.writeSmallSnapshots(job, renderer); }
        catch (error) { this.smallStats.failed++; this.smallStats.lastError = String(error?.message ?? error); break; }
      }
      // Diagnostic (does not alter behavior): cumulative time spent drawing small sizes (needed by
      // segment duration in queue fine-grained tasks)
      this.smallStats.ms = (this.smallStats.ms ?? 0) + (Date.now() - started);
    });
    return this.smallChain;
  }
  /** Writes this batch of small bitmaps to snapshot directory; skips existing. Returns count written */
  async writeSmallSnapshots(args, renderer) {
    if (this.closed || !renderer) return 0;
    const { tier, key } = args;
    const entryKey = tier === 'local' ? args.entryKey : null;
    const control = this.controlForSnapshotKey(tier, entryKey, key);
    const width = Number(control?.appearance?.width), height = Number(control?.appearance?.height);
    if (!control || !(width > 0) || !(height > 0)) { this.smallStats.skipped += args.items.length; return 0; }
    const box = resolveFrameSize(control.appearance?.frame, { width, height });
    const dir = this.snapshots().dir({ tier, entryKey, key });
    await fs.mkdir(dir, { recursive: true });
    let written = 0;
    for (const item of args.items) {
      if (this.closed) break;
      const file = path.join(dir, `${item.localFrame}${SMALL_SUFFIX}`);
      if (await exists(file)) continue;
      const webp = await renderer.renderHtml({ html: item.html, projectWidth: width, projectHeight: height, boxWidth: Number(box.w) || width, boxHeight: Number(box.h) || height });
      await atomic(file, webp);
      written++;
    }
    this.smallStats.written += written;
    // Small bitmaps are pushed along with the segment (push queue deduplicates by segment; segments
    // currently pushing are pushed once more after finishing)
    if (written) { try { this.enqueueSnapshotPush({ ...args, adopted: false }); } catch {} }
    return written;
  }
  /**
   * The generation half of queue fine-grained task "considered complete only after both tiers are
   * pushed successfully" (c10a Section 9): for frames in this segment that **already have original
   * size but lack small size**, read HTML back from frame store, record into pending small sizes to
   * draw (`scheduleSmallSnapshots`), and draw them during upcoming page change (`flushPendingSmall`).
   *
   * Where these frames come from: produced before this process configured a push queue (e.g., the
   * batch of anchor frames and playhead rendered before shared config was written and before
   * prerender process restart: this is how the 5 frames missing from 295/300 occurred in Alibaba
   * Cloud demo 2026-09-27), dropped after accumulating too many, failed in previous generation, or
   * exited process after recording without drawing. When scheduling small sizes only by newly
   * produced frames, segments containing these frames have complete original sizes but will
   * permanently miss those few small size frames.
   * Returns how many frames were scheduled. Ji-2: prerender small size has been discontinued,
   * smallTierEnabled() always returns false, reading no files.
   */
  async scheduleMissingSmall(entry, control, range) {
    if (!this.smallTierEnabled() || !control?.snapshotKey || !range) return 0;
    const tier = control.tier || snapshotTier(control.capabilities);
    if (tier !== 'shared' && tier !== 'local') return 0;
    const entryKey = tier === 'local' ? entry?.key : undefined;
    if (tier === 'local' && !entryKey) return 0;
    const target = { tier, entryKey, key: control.snapshotKey };
    const store = this.snapshots();
    const index = await store.snapshotIndex(target);
    const dir = store.dir(target);
    const last = Number.isInteger(control.count) ? Math.min(range.to, control.count - 1) : range.to;
    const items = [];
    for (let frame = Math.max(0, range.from); frame <= last; frame++) {
      if (!rangeHas(index.frames, frame) && !rangeHas(index.oversize, frame)) continue;
      if (await exists(path.join(dir, `${frame}${SMALL_SUFFIX}`))) continue;
      let html;
      try { html = await fs.readFile(path.join(dir, `${frame}.html`), 'utf8'); } catch { continue; }
      items.push({ localFrame: frame, html });
    }
    if (!items.length) return 0;
    const scheduled = this.scheduleSmallSnapshots({ tier, ...(entryKey ? { entryKey } : {}), key: control.snapshotKey, clipId: control.clipId, capabilities: control.capabilities, items });
    return scheduled ? items.length : 0;
  }
  /**
   * Queue fine-grained task finalization: if there are still recorded undrawn small sizes, change
   * page once on this prerender room to draw them (pre-navigation hook `flushSmallOn`), and restore
   * page to a clean empty project (matching its state when borrowed via `acquire`). After task
   * returns, sink immediately lists manifest, and small sizes cannot be left to "next time someone
   * changes page": that local-tier pass, as well as a segment where the whole segment already has
   * original sizes and only lacks small sizes, might never have anyone change page again.
   * If there is nothing pending to draw, do nothing.
   */
  async flushPendingSmall(bakery, project, lane = 'queue') {
    if (!bakery || !this.smallPending?.length || this.closed) return false;
    await bakery.reset(project, this.emptyUrl(project), { deferCards: true });
    await bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: this.scaleForLane(lane) });
    await bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    return true;
  }
  /**
   * c10a Section 9 "online page pulls by manifest": online pages have no prerender process and
   * cannot compute keys for each heavy card (the key contains render node's environment fingerprint
   * and snapshot code hash). When acknowledging the next version of card plan, the render node
   * writes "clip → layer key, manifest result key, sample window" into the content store
   * (`layerMapOf` in `artifact-transfer.mjs`); the page fetches manifests segment by segment based
   * on it and pulls small bitmaps according to manifest's `small` table. Only written when push queue
   * is configured.
   */
  publishLayerMap(entry) {
    const queue = this.pushQueue;
    const projectId = entry?.project?.id;
    if (!queue || typeof queue.putLayerMap !== 'function' || !projectId || !Array.isArray(entry.cardPlan)) return false;
    try {
      const body = layerMapOf(entry, {
        picked: clipId => this.prerenderPicked(entry, clipId),
        fingerprint: this.envFingerprint,
        candidatesOf: control => this.splitCandidatesFor(control?.contentKey),
        ...this.layerMapStreamOptions(entry),
      });
      return queue.putLayerMap(projectId, body);
    } catch { return false; }
  }
  /**
   * Two things required by `streams` table in layer table (`layerStreamsOf` in
   * `artifact-transfer.mjs`; fifth location in `docs/plan/browser-stream-task.md`): streams of this
   * version, and the fingerprint that actually produced the key in the most recent split for each
   * stream. The online page looks up stream manifests per this table. Streams come from two sources:
   *
   *   1. Those to be produced by this machine itself for this version (`planStreams` with the same
   *      parameters as producer and queue split, so stream keys match): omitted when this machine
   *      has no producer or switch is off (`PROMPTCUT_STREAMS=0`). Encoders are not probed here
   *      (that is asynchronous): for streams listed but produced by no one, the page cannot fetch
   *      the manifest and switches snapshots every tick as usual. Render nodes on host produce
   *      streams according to project's "generate track stream" (task brief "Jia-3"): when project
   *      belonging to this version is currently not producing streams, executor records
   *      `ownStreamsOff` on entry (`plan` in `prerender-executor.mjs`), and this part is likewise
   *      omitted;
   *   2. Single-card streams where keys were issued to other fingerprints during split, and not
   *      produced by this machine itself (`issuedStreamSpecs`): manifest plan for online page only
   *      issues one stream task to browser (`listStreamSpecs`); when this machine has no producer,
   *      has stream switch off, or this card is not classified as heavy locally, it is absent from
   *      part 1, and omitting it would prevent other online pages from finding stream produced by
   *      browser. **Below-dependent streams** split out by manifest plan (issued only under
   *      splitter's own fingerprint and produced by splitter itself) are likewise listed here:
   *      cards in manifest are mostly not classified as heavy locally, and are absent from part 1.
   *
   * When both parts are empty, returns empty object, with no `streams` in layer table (verbatim
   * identical to before); when only part 1 exists, results are also verbatim identical to before.
   * Both places writing layer table (local push queue, standalone render host) pass through here.
   */
  layerMapStreamOptions(entry) {
    if (!entry) return {};
    const producer = this.streamProducer();
    let own = [];
    if (producer?.enabled && entry.ownStreamsOff !== true) {
      try {
        own = planStreams(entry, { picked: clipId => this.streamPicked(entry, clipId), budget: producer.budget,
          codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: this.envFingerprint });
      } catch { own = []; }
    }
    const issued = this.issuedStreamSpecs(entry, own);
    const streams = issued.length ? [...own, ...issued] : own;
    if (!streams.length) return {};
    return { streams, streamCandidatesOf: spec => this.splitCandidatesFor(streamCandidateKey(spec?.contentKey)) };
  }
  /**
   * Single-card streams where keys were issued to other fingerprints during split, but absent from
   * `own` (streams to be produced by this machine itself in this version). Criterion is split
   * candidate records (`recordSplitCandidates`, recorded by executor after each split completion
   * based on stream tasks that were ultimately published successfully, key
   * `stream:<streamContentKey>`): if the content key of a single-card stream for a card in this
   * version is in records, it means "someone was dispatched this stream". Content key of a
   * single-card stream is determined solely by this card's content, sample window, frame rate, aspect
   * ratio, and code version, regardless of what other cards are in the same version; therefore,
   * they are not merged here by decoder budget (budget set to infinity), and single-card streams are
   * computed card by card to match against records; group streams are never dispatched to browsers
   * and will not match, so they are not listed. Below-dependent streams likewise match against
   * records (task brief "Wu-2", "lower layer four"): its content key is determined solely by target
   * card and layers beneath it; as long as manifest plan split out a task for it, list it; its
   * candidates are fingerprints in records (the splitter's own).
   *
   * Only considers cards in prerender set (clips from manifest plan are merged into set via
   * `addBackfill`, and layer table's `layers` contains its snapshot layer); cards that are already
   * members of an `own` stream are not listed again. Each item is tagged `ownCandidate: false`: this
   * machine does not produce it, and candidates in layer table only list fingerprints from records.
   * When there are no streams at all in records, directly returns empty (no stream plan calculated).
   */
  issuedStreamSpecs(entry, own = []) {
    let any = false;
    for (const key of this.loadSplitCandidates().keys()) if (key.startsWith(STREAM_CANDIDATE_PREFIX)) { any = true; break; }
    if (!any) return [];
    const covered = new Set(own.flatMap(spec => spec?.clipIds ?? []));
    let singles = [];
    try {
      singles = planStreams(entry, { picked: clipId => !covered.has(clipId) && this.prerenderPicked(entry, clipId), budget: Infinity,
        codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: this.envFingerprint });
    } catch { singles = []; }
    return singles
      .filter(spec => (spec.kind === 'card' || spec.kind === 'below') && this.splitCandidatesFor(streamCandidateKey(spec.contentKey))?.length)
      .map(spec => ({ ...spec, ownCandidate: false }));
  }
  /**
   * M7 contract D12: after queue split completes, record the fingerprint that actually produced
   * the key for each shared tier card (`splitCandidatesOf` in `artifact-transfer.mjs`, content key →
   * fingerprint table, splitter's own first), and subsequent layer table writes (written by local
   * push queue, written by standalone render host) all list candidates according to it. Later entries
   * overwrite earlier ones; at most SPLIT_CANDIDATES_MAX cards are retained (evicted in recording
   * order). Persisted to `split-candidates.json` at store root (rewritten in full), still listing
   * candidates according to it after process restart: otherwise the first layer table write after
   * restart (preload, prerender retry registration) would leave only itself as candidate, and page
   * could not find the layer produced by itself (discovered by M7 acceptance check probe). Read/write
   * failures are simply treated as no records.
   */
  splitCandidatesPath() {
    return typeof this.root === 'string' && this.root ? path.join(this.root, 'split-candidates.json') : null;
  }
  loadSplitCandidates() {
    if (this._splitCandidates) return this._splitCandidates;
    this._splitCandidates = new Map();
    const file = this.splitCandidatesPath();
    if (!file) return this._splitCandidates;
    try {
      const body = JSON.parse(readFileSync(file, 'utf8'));
      for (const [contentKey, fps] of Array.isArray(body?.entries) ? body.entries : []) {
        if (typeof contentKey === 'string' && contentKey && Array.isArray(fps) && fps.every(fp => typeof fp === 'string' && fp)) this._splitCandidates.set(contentKey, [...fps]);
      }
    } catch { /* Missing or corrupted: treat as no records */ }
    return this._splitCandidates;
  }
  recordSplitCandidates(candidates) {
    if (!(candidates instanceof Map)) return 0;
    this.loadSplitCandidates();
    let n = 0;
    for (const [contentKey, fps] of candidates) {
      if (typeof contentKey !== 'string' || !contentKey || !Array.isArray(fps) || !fps.length) continue;
      this._splitCandidates.delete(contentKey);
      this._splitCandidates.set(contentKey, [...fps]);
      n++;
    }
    while (this._splitCandidates.size > SPLIT_CANDIDATES_MAX) this._splitCandidates.delete(this._splitCandidates.keys().next().value);
    const file = n > 0 ? this.splitCandidatesPath() : null;
    if (file) {
      try {
        writeFileSync(`${file}.tmp`, JSON.stringify({ v: 1, entries: [...this._splitCandidates.entries()] }));
        renameSync(`${file}.tmp`, file);
      } catch { /* Cannot persist to disk: still list from memory in this process */ }
    }
    return n;
  }
  /**
   * The fingerprint that actually produced the key in the most recent split for this card
   * (shared tier content key); returns null if unrecorded
   */
  splitCandidatesFor(contentKey) {
    const list = typeof contentKey === 'string' ? this.loadSplitCandidates().get(contentKey) : undefined;
    return list ? [...list] : null;
  }
  enqueueStreamPush(spec, segment) {
    const queue = this.pushQueue;
    if (!queue || !spec?.streamKey || !Number.isInteger(segment) || segment < 0) return false;
    const first = Number.isInteger(spec.firstSegment) && spec.firstSegment <= segment ? spec.firstSegment : 0;
    const span = PUSH_STREAM_SEGMENTS;
    const from = first + Math.floor((segment - first) / span) * span;
    const last = Number.isInteger(spec.lastSegment) && spec.lastSegment >= from ? spec.lastSegment : null;
    const to = last !== null ? Math.min(last, from + span - 1) : from + span - 1;
    // Contract Section 9 Item 1: enqueue takes effect synchronously; returned promise is write to
    // disk; hook does not wait for it
    void Promise.resolve(queue.enqueue({ kind: 'stream', resultKey: spec.streamKey, range: { from, to } }, PUSH_LOW)).catch(() => {});
    return true;
  }
  streamLocksPath() {
    return typeof this.root === 'string' && this.root ? path.join(this.root, 'stream-locks.json') : null;
  }
  loadStreamLocks() {
    const locks = new Map();
    const file = this.streamLocksPath();
    if (!file) return locks;
    try {
      const body = JSON.parse(readFileSync(file, 'utf8'));
      for (const [contentKey, fingerprint] of Array.isArray(body?.entries) ? body.entries : []) {
        if (typeof contentKey === 'string' && contentKey && typeof fingerprint === 'string' && fingerprint) locks.set(contentKey, fingerprint);
      }
    } catch { /* No records or unreadable: treat as no lock */ }
    return locks;
  }
  saveStreamLocks() {
    const file = this.streamLocksPath();
    if (!file) return;
    try {
      // Only keep the most recently recorded STREAM_LOCKS_MAX entries (Map insertion order)
      while (this.streamLocks.size > STREAM_LOCKS_MAX) this.streamLocks.delete(this.streamLocks.keys().next().value);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, entries: [...this.streamLocks] }));
      renameSync(tmp, file);
    } catch { /* Cannot persist to disk: still use from memory in this process */ }
  }
  /**
   * Desktop side of "query first, produce only if absent" (task brief `render-refactor-task.md`
   * "Jia-2"): for single-card streams of this version that already have a **complete full density**
   * stream on asset service from another environment (produced by online page itself when there is no
   * split node, or other desktops), pull back to local stream store, and lock this stream to that
   * fingerprint (`streamLocks`: content key → fingerprint). Afterwards, local stream plan issues keys
   * per locks (`relockStreams`): producer does not re-produce, stage plays the pulled-back stream,
   * and candidate in layer table is that fingerprint; during split, only one copy is issued per lock
   * (`planForQueue` merges locks into `cardLocks`).
   *
   *   - Where candidates come from: layer table for this project in content store (fingerprints
   *     listed in rows with matching content key in `streams` table of `layers:<projectId>`), plus
   *     local split candidate records;
   *   - If this machine's own key already has the full stream, do not check or lock; if another
   *     candidate only has a partial stream, do not lock (produce under own key as usual);
   *   - Previously recorded locks are re-verified every time: if the pulled-back stream is incomplete
   *     in local stream store (e.g. purged), unlock and revert to own key.
   *
   * Returns `{ checked, locked, unlocked }` (how many streams checked, newly locked, unlocked);
   * errors are only recorded in `this.lastForeignStreams` without throwing.
   */
  async adoptForeignStreams(entry, content, client, { signal } = {}) {
    const report = { checked: 0, locked: 0, unlocked: 0, at: Date.now(), error: null };
    const own = this.envFingerprint;
    const producer = this.streamProducer();
    const projectId = entry?.project?.id;
    if (!own || !producer || !entry || !content || typeof content.get !== 'function' || !client) return report;
    let singles = [];
    try {
      // Calculated per this machine's own fingerprint (without locks); budget set to infinity: only
      // inspects single-card streams, one for each card eligible to enter a stream
      singles = planStreams({ ...entry, streamLocks: null }, { budget: Infinity, codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: own })
        .filter(spec => spec.kind === 'card');
    } catch { singles = []; }
    if (!singles.length) return report;
    /** Whether the stream for this key is complete and full density in the local stream store */
    const complete = async (streamKey, spec) => {
      let manifest = null;
      try { manifest = producer.streams?.get(streamKey)?.manifest ?? await producer.store?.load(streamKey); } catch { manifest = null; }
      if (!manifest) return false;
      for (let n = spec.firstSegment; n <= spec.lastSegment; n++) if (!(manifest.segments?.[n]?.stride === 1)) return false;
      return true;
    };
    let changed = false;
    try {
      // Re-verify existing locks
      for (const spec of singles) {
        const fingerprint = this.streamLocks.get(spec.contentKey);
        if (!fingerprint || await complete(resultKeyOf(spec.contentKey, fingerprint), spec)) continue;
        this.streamLocks.delete(spec.contentKey);
        report.unlocked++;
        changed = true;
      }
      let rows = null;
      for (const spec of singles) {
        if (signal?.aborted || this.closed) break;
        if (this.streamLocks.has(spec.contentKey) || await complete(spec.streamKey, spec)) continue;
        if (rows === null) {
          rows = [];
          const key = layerMapKeyOf(projectId);
          if (key) {
            const body = (await content.get('snapshot-manifest', key))?.body;
            if (Array.isArray(body?.streams)) rows = body.streams;
          }
        }
        const listed = rows.filter(row => row?.kind === 'card' && row.contentKey === spec.contentKey).flatMap(row => (Array.isArray(row.candidates) ? row.candidates : []).map(c => c?.envFingerprint));
        const fingerprints = [...new Set([...listed, ...(this.splitCandidatesFor(streamCandidateKey(spec.contentKey)) ?? [])])].filter(fp => typeof fp === 'string' && fp && fp !== own);
        if (!fingerprints.length) continue;
        report.checked++;
        for (const fingerprint of fingerprints) {
          const resultKey = resultKeyOf(spec.contentKey, fingerprint);
          if (!await complete(resultKey, spec)) {
            // Pull the full stream only when every manifest exists, covers its segment, and is entirely full
            // density; discard this candidate if any is missing
            const bodies = [];
            for (const [from, to] of spansOf(spec.firstSegment, spec.lastSegment, PUSH_STREAM_SEGMENTS)) {
              const ref = { kind: 'stream', resultKey, range: { from, to } };
              const body = (await content.get('render-manifest', manifestKeyOf(ref)))?.body;
              let full = !!body && manifestMatches(body, ref);
              for (let n = from; full && n <= to; n++) if (!(body.segments?.[n]?.stride === 1)) full = false;
              if (!full) { bodies.length = 0; break; }
              bodies.push(body);
            }
            if (!bodies.length) continue;
            for (const body of bodies) await applyResult(this, client, body);
            if (!await complete(resultKey, spec)) continue;
          }
          this.streamLocks.set(spec.contentKey, fingerprint);
          report.locked++;
          changed = true;
          break;
        }
      }
    } catch (error) {
      report.error = String(error?.message ?? error).slice(0, 200);
    }
    if (changed) this.saveStreamLocks();
    this.lastForeignStreams = report;
    return report;
  }
  /**
   * C6.4 Section 5: cross-machine adoption. Given an active entry (card plan of a session's current
   * version), compute segment keys for each of its shared tier and local tier controls, as well as
   * each stream (same slicing method as push and queue fine-grained tasks), and fetch manifests
   * segment by segment via `content.get`; found items are handed to C6.2 `applyResult` to pull,
   * persist to disk, and publish. Segments already present locally are skipped, and segments not
   * found are also skipped (prerendered as usual by this machine).
   *
   * Returns `{ manifests, fetched, written }`: number of manifests found and submitted for pulling,
   * number of downloaded chunks (counting init), and actual number of frames / segments written to
   * disk. A failure pulling one segment is only recorded (`this.lastAdoption.failed`), without
   * affecting other segments; if content store disconnects, stop, and remaining segments are no
   * longer queried.
   */
  async adoptFromManifests(entry, content, client, { signal } = {}) {
    const out = { manifests: 0, fetched: 0, written: 0 };
    const report = { ...out, skipped: 0, missing: 0, failed: 0, at: Date.now() };
    if (!entry || !content || typeof content.get !== 'function' || !client) return out;
    const jobs = new Map();
    const add = job => {
      const kind = manifestKindOf(job.kind);
      const key = manifestKeyOf(job);
      if (kind && key && !jobs.has(`${kind}\u0000${key}`)) jobs.set(`${kind}\u0000${key}`, { ...job, manifestKind: kind, manifestKey: key });
    };
    const producer = this.streamProducer();
    if (producer?.enabled) {
      let specs = [];
      try {
        specs = planStreams(entry, { picked: clipId => this.streamPicked(entry, clipId), budget: producer.budget,
          codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: this.envFingerprint });
      } catch { specs = []; }
      for (const spec of specs) {
        if (!spec?.streamKey) continue;
        for (const [from, to] of spansOf(spec.firstSegment, spec.lastSegment, PUSH_STREAM_SEGMENTS)) add({ kind: 'stream', resultKey: spec.streamKey, range: { from, to } });
      }
    }
    const store = this.snapshots();
    /** Whether this machine already has the complete segment */
    const haveLocally = async job => {
      const { from, to } = job.range;
      if (job.kind === 'snapshot') {
        const index = await store.snapshotIndex({ tier: job.tier, entryKey: job.entryKey ?? undefined, key: job.dirKey });
        for (let f = from; f <= to; f++) if (!rangeHas(index.frames, f) && !rangeHas(index.oversize, f)) return false;
        return true;
      }
      const manifest = producer?.streams?.get(job.resultKey)?.manifest ?? await producer?.store?.load(job.resultKey);
      if (!manifest) return false;
      for (let n = from; n <= to; n++) if (!manifest.segments?.[n]) return false;
      return true;
    };
    let offline = false;
    const list = [...jobs.values()];
    let next = 0;
    const lane = async () => {
      for (;;) {
        const job = list[next++];
        if (!job || offline || signal?.aborted || this.closed) return;
        try {
          if (await haveLocally(job)) { report.skipped++; continue; }
        } catch { /* Treat as not present locally */ }
        let item;
        try { item = await content.get(job.manifestKind, job.manifestKey); }
        catch (error) {
          if (error?.code === 'disconnected') offline = true;
          report.failed++;
          continue;
        }
        const body = item?.body;
        if (!body) { report.missing++; continue; }
        const sameTarget = job.kind !== 'snapshot' || (body.tier === job.tier && body.dirKey === job.dirKey && (job.tier !== 'local' || body.entryKey === job.entryKey));
        if (!manifestMatches(body, job) || !sameTarget) { report.missing++; continue; }
        out.manifests++;
        try {
          const applied = await applyResult(this, client, body);
          out.fetched += applied.fetched;
          out.written += applied.written;
        } catch {
          report.failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ADOPT_CONCURRENCY, list.length) }, lane));
    this.lastAdoption = { ...report, ...out, jobs: list.length, offline };
    return out;
  }
  /**
   * C6.2 (Contract Section 6): a segment of results produced by another node has landed in local
   * frame store; publish it into ready index.
   *
   *   - Snapshots: per the written `index.json`, attach wire key
   *     (`wireSnapshotKey(tier, entryKey, dirKey)`) into `stageByKey`, then perform a claim once for
   *     each entry (`claimSessions`): any entry whose card plan uses this key and currently has a
   *     session on this version receives `layer`. No need to know `clipId`: keys are
   *     content-addressed, and claiming maps keys back to clips according to card plan.
   *   - Track streams: published by `streamProducer().adoptSegments`; does nothing here.
   *
   * Returns `{ kind, key, ranges, claimed }` (`ranges` is ranges on disk for this key at this
   * moment, `claimed` is how many layers were merged).
   */
  async adoptResult(result) {
    if (!result || typeof result !== 'object' || result.v !== 1) throw new Error('Unknown artifact result');
    if (result.kind === 'stream') return { kind: 'stream', key: result.resultKey ?? null, ranges: null, claimed: 0 };
    if (result.kind !== 'snapshot') throw new Error(`Unknown artifact result kind ${result.kind}`);
    const { tier, dirKey } = result;
    const entryKey = tier === 'local' ? result.entryKey : null;
    const kind = kindOfTier(tier);
    const key = wireSnapshotKey(tier, entryKey, dirKey);
    if (!kind || !key) throw new Error('Snapshot result has no usable key');
    const index = await this.snapshots().snapshotIndex({ tier, entryKey, key: dirKey });
    if (index.frames.length) this.ready.stageByKey({ kind, key, ranges: index.frames });
    let claimed = 0;
    for (const entry of this.entries.values()) claimed += this.claimSessions(entry);
    return { kind, key, ranges: index.frames, claimed };
  }
  /**
   * F5 recovery after prerender process restart: on startup, first scan
   * `controls-html/<sharedKey>/index.json` and `controls-local/<entry.key>/<sharedKey>/index.json`
   * to rebuild C3 ready index.
   *
   * **Scanning disk yields only "key → range"**: directory names are shared keys with clipId
   * stripped off, so here they are only attached to keys (`stageByKey`, shared across all sessions)
   * without emitting `layer`; once the page's `preload` restores session version and recalculates
   * card plan, it reverse-looks up via `control.clipId` <-> `control.snapshotKey` and
   * merges into that session's index (`claimSessions`).
   *
   * The manifest for track streams (R8), `<storeRoot>/streams/<streamKey>/stream.json`, is likewise
   * scanned and attached to key (`kind: 'stream'`).
   */
  async rescanSnapshots() {
    // Contract F.3: finish reading lock store first: for cards locked by other environments,
    // claiming recognizes the locking party's key (`applyCardLocks`)
    await this.ensureCardLocks();
    let found = 0;
    try { found += (await this.streamProducer()?.rescan()) ?? 0; } catch {}
    return found;
  }
  /**
   * Card plan for this page version is in place (**called only by background pass of `preload`**,
   * Item 4): record plan + claim. Scanning disk yields only "key → range", whereas `layer` and the
   * page's `readyIndex` are indexed by clipId: therefore, we must wait for card plan to
   * reverse-lookup via `control.clipId` <-> `control.snapshotKey`. Table clearing is not done here:
   * `adoptSession` already reset when session switched versions. Other lanes only call
   * `recordCardPlan`.
   *
   * Incidentally records "which cards to produce" on entry (narrow interface of `prerenderSetOf`).
   * This set is the **consumer**: `prerenderPicked` wires it into `snapshotTargets` /
   * `missingSnapshotFrames` / `fillCardControls` / ready index claiming, so cards classified as light
   * across all positions produce nothing (pinned render 9).
   */
  adoptCardPlan(entry, plan) {
    this.recordCardPlan(entry, plan);
    // After recalculating with new costs, the set shrunk (cards were classified as light): their old
    // layers in session must be revoked. There is no "delete one layer" on wire, so we can only reset
    // and backfill in full: `staged` has all ranges emitted for this version and can backfill (Item 4)
    const claimed = entry.claimedSet;
    if (claimed instanceof Set && [...claimed].some(clipId => !this.prerenderPicked(entry, clipId))) {
      this.ready.resetOn(entry.key);
      if (entry.anchorsReady) this.ready.markDone(entry.key);
    }
    this.claimSessions(entry);
    // Claiming only backfills ranges attached from disk scan; group stream `groupClipIds` is not in
    // claim table: re-emitted once by producer per manifest (also passes the gate)
    this._streams?.republish();
    return plan;
  }
  /**
   * "Record plan on entry" (the split front half of Item 4): `entry.cardPlan` and prerender set.
   * **Can be called by any lane**, touching only this entry itself and not touching any session's
   * ready index: `cardRender` (Agent query, export, interactive frames) only performs this step.
   */
  recordCardPlan(entry, plan) {
    // Contract F.3: shared tier cards locked by other environments are replaced with the locking
    // party's key: subsequent delivery, claiming, and disk scan reconstruction all recognize this key
    this.applyCardLocks(plan);
    entry.cardPlan = plan;
    // K2 / K6: Actually compute from the planPipelines table (costs / tuning forwarded by the editor
    // process, landing in the local copy)
    entry.basePrerenderSet = prerenderSetOfPlan(plan, { fps: Number(entry.project?.fps) || 30, root: this.dataRoot, project: entry.project });
    entry.prerenderSet = entry.basePrerenderSet;
    // c10a contract section 17: Merge in clips registered for prerender retry (`addBackfill`)
    this.applyBackfill(entry);
    // Storage usage: Any lane using this version's plan has its keys recorded as in use
    this.usage?.touchEntry(entry);
    return plan;
  }
  /**
   * "Claim" (the second half of the split): Merges intervals attached to disk scans / track streams
   * into sessions whose **current version is exactly this entry**.
   * Does not reset (clearing the table is only done by `adoptSession` when a session switches
   * versions); other sessions are left untouched. Returns how many layers were merged in.
   */
  claimSessions(entry) {
    if (!entry?.cardPlan || !this.ready.sessionsOn(entry.key).length) return 0;
    const layers = [];
    for (const control of entry.cardPlan ?? []) {
      // pinned render 9: Cards classified as light at all positions do not enter the ready index
      if (!this.prerenderPicked(entry, control.clipId)) continue;
      const tier = control.snapshotKey ? (control.tier || snapshotTier(control.capabilities)) : 'none';
      const kind = kindOfTier(tier);
      const key = wireSnapshotKey(tier, entry.key, control.snapshotKey);
      if (kind && key && control.clipId) layers.push({ clipId: control.clipId, kind, key });
    }
    // R8: Streams belonging to this version held by producers are claimed together (stream keys
    // attached from F5 disk scans are also claimed here); cards classified as light are likewise
    // not claimed
    for (const layer of this._streams?.claimLayers(entry.key) ?? []) if (this.prerenderPicked(entry, layer.clipId)) layers.push(layer);
    // Record which set was used for this claim: If the set shrinks later, `adoptCardPlan` revokes
    // layers accordingly
    entry.claimedSet = entry.prerenderSet instanceof Set ? new Set(entry.prerenderSet) : undefined;
    try { return this.ready.claim(entry.key, layers); } catch { return 0; }
  }
  /**
   * Sets the page session's current version (**only called by `preload`**, Item 4 business decision 2).
   * When the version changes, the hub resets this session first (the page clears its table); if this
   * version's plan has already been computed (Agent query / another session rendered it first), claim
   * once immediately, without waiting for the background pass to be scheduled. `ticket` is the number
   * received upon entering preload; expired ones are not accepted.
   */
  adoptSession(session, entry, localRev, ticket) {
    let changed = false;
    // If this version's plan has not been computed yet, do not clear the page's table for now (`defer`):
    // Wait until the background pass computes the plan and claims, then reset + backfill layers
    try { changed = this.ready.adopt(session, entry.key, localRev, ticket, { defer: !entry.cardPlan }); } catch { return false; }
    if (changed && entry.cardPlan) {
      this.claimSessions(entry);
      if (this._streams?.entryKey === entry.key) this._streams.republish();
    }
    // Anchor frames for this version are already complete (run by another session first): Sessions
    // switching to it should likewise receive `done`
    if (changed && entry.anchorsReady) this.ready.markDone(entry.key);
    return changed;
  }
  /**
   * C3: Sends all currently ready intervals for a layer (full semantics, `ready-index.mjs`).
   * **All layer dispatches go through this single portal** (Item 4): Includes the `entry` it belongs
   * to, and only enters sessions whose current version is exactly this entry; late-arriving batches
   * from old versions and other versions rendered by Agent / export are all discarded. Returns how
   * many sessions were written to.
   */
  publishLayer(entry, control, tier, ranges) {
    // Cost records may reclassify a card as light while an old background batch is still in flight;
    // an old batch cannot restore revoked layers.
    if (!this.prerenderPicked(entry, control?.clipId)) return 0;
    const kind = kindOfTier(tier);
    const key = wireSnapshotKey(tier, entry?.key, control?.snapshotKey);
    if (!entry?.key || !kind || !key || !control?.clipId) return 0;
    return this.ready.publish(entry.key, { clipId: control.clipId, kind, key, ranges });
  }
  /**
   * Whole-layer key swap after the lock changes owner (contract F.3): Send a `layer` for each
   * shared-tier clip with the same content key, where the key is its current `snapshotKey` (from the
   * new locking party), and intervals are what currently exists under the new key (may be empty).
   * `setLayer` overwrites the entire entry by (clipId, kind), and the page drops frames from the old
   * environment accordingly. `control` itself is sent first.
   */
  publishRelocked(entry, controls, control, ranges) {
    const seen = new Set();
    for (const item of [control, ...(entry?.cardPlan ?? []), ...(Array.isArray(controls) ? controls : [])]) {
      if (!item?.clipId || seen.has(item.clipId) || item.contentKey !== control.contentKey) continue;
      if ((item.tier || snapshotTier(item.capabilities)) !== 'shared' || !item.snapshotKey || !this.prerenderPicked(entry, item.clipId)) continue;
      seen.add(item.clipId);
      this.publishLayer(entry, item, 'shared', ranges);
    }
  }
  /**
   * Scheduling point for C4: Which local frame this batch should start from.
   *
   * When the mirror plugin has `wanted` reported by the page (missing layers near the playhead),
   * the batch containing it runs first; otherwise it falls back to sequential batches.
   * **Do not interrupt the currently running batch**: This function is only called between batches.
   */
  nextBatchStart(pending, control) {
    const ordered = [...pending].sort((a, b) => a - b);
    for (const item of this.playheadWanted()) {
      if (item?.clipId !== control.clipId) continue;
      const local = Number(item.frame) - control.sampling.firstFrame;
      if (!Number.isInteger(local) || local < 0 || local >= control.count) continue;
      const start = local - (local % 4);
      if (!pending.has(start) || start === ordered[0]) continue;
      console.log(`[frames] wanted: batches ${start}~${Math.min(start + 3, control.count - 1)} of clip ${control.clipId} moved up (sequential batch was ${ordered[0]})`);
      // Prerender process stdout was captured by the editor process (`vite-plugin-prerender`'s `keep`),
      // and the end-to-end probe cannot see the line above; so log an entry for the same event as well,
      // read via `/api/frames/diagnostics`.
      this.notePromotion({ clipId: control.clipId, start, instead: ordered[0], frame: Number(item.frame) });
      return start;
    }
    return ordered[0];
  }
  /**
   * C2's local-tier pass: **A single whole-scene render pass serves all local-tier cards on that
   * frame** (not one pass per card).
   *
   * Why isolated single-card cannot be used: `isolatedCardProject` strips away lower-layer scenes,
   * leaving frosted glass with no background to sample; likewise, `unknown` cards (custom cards,
   * composite card clips with parts) cannot get their required context.
   *
   * Why the existing callback in `renderMovFrames` cannot be reused: Its `requested` only contains
   * frames missing in MOV, `onSnapshot` is also blocked by `!entry.html.has(n)`, and the `htmlFrames`
   * replay path never enters `bakeFrames` at all.
   *
   * Parameters are pinned strictly per C2: `targetFrames: frames`, `fullFrame: true` (without it,
   * frame window planning at `bake.mjs:69` does not take effect), `snapshotOnly: false` (guard at
   * `bake.mjs:281`; changing to `true` turns off frame window planning and skips `prepareFrameMedia`
   * in `shoot`, whereas local-tier cards are precisely frosted glass / `unknown` cards: If the asset
   * layer is not prepared, snapshots capture the wrong visual), `writeFrames: false`,
   * `snapshotFrames: new Set(frames)`. **As a result, an extra unconsumed PNG is captured per frame;
   * this is a known cost.**
   *
   * `frames` = Union of **global** frames missing from any local-tier card in the local-tier index.
   */
  /**
   * `options.shouldStop` (AGENT-maint-3, only passed for queue fine-grained tasks running on Agent
   * dedicated instances): Queried once every 4 committed frames; if true, stops after this frame,
   * finalizes accumulated batches and dispatches layers as usual, and returns the stopped frame
   * (global frame number); returns undefined if not stopped.
   */
  async renderLocalSnapshots(entry, frames, bakery, signal, { shouldStop = null } = {}) {
    const targets = this.snapshotTargets(entry);
    if (!targets?.size) return;
    const locals = new Map([...targets].filter(([, target]) => target.tier === 'local'));
    const list = [...new Set(frames ?? [])].filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
    if (!locals.size || !list.length) return;
    const capabilities = new Map((entry.cardPlan ?? []).map(control => [control.clipId, control.capabilities]));
    /**
     * clipId → snapshot store batched write (#9: Write frames + check size + merge index in one step,
     * A3c / R6-14 oversize frames recorded into `oversize`)
     */
    const batches = new Map();
    const stop = shouldStop ? new AbortController() : null;
    let stoppedAfter, seen = 0;
    try {
    await bakeFrames(bakery, {
      out: entry.dir, targetFrames: list, snapshotOnly: false, fullFrame: true, writeFrames: false, signal: stop ? AbortSignal.any([signal, stop.signal].filter(Boolean)) : signal,
      snapshotFrames: new Set(list),
      // Each item in the `__pcCreateSnapshot` output has only id (= clipId) / frame / html, and
      // **does not contain a shared key**: Keys are reverse-looked up using the card plan's
      // `control.clipId` ↔ `control.snapshotKey`.
      onSnapshot: async (_frame, _html, produced) => {
        if (signal?.aborted) return;
        for (const item of produced ?? []) {
          const target = locals.get(item.id);
          if (!target || !Number.isInteger(item.frame)) continue;
          if (!batches.has(item.id)) batches.set(item.id, this.snapshots().batch({ tier: 'local', entryKey: entry.key, key: target.key, clipId: item.id, capabilities: capabilities.get(item.id) }));
          try { await batches.get(item.id).add(item.frame, item.html); }
          catch { continue; }
        }
        seen++;
        if (stop && seen % 4 === 0 && _frame < list[list.length - 1] && shouldStop()) { stoppedAfter = _frame; stop.abort(); }
      },
    });
    } catch (error) {
      if (!(stop?.signal.aborted && !signal?.aborted && stoppedAfter !== undefined)) throw error;
    }
    // Cancelled midway: Batches already committed are in the index (disk state matches index);
    // uncommitted frames are discarded and backfilled in the next pass
    if (signal?.aborted) return;
    for (const [clipId, batch] of batches) {
      const index = await batch.close();
      if (index && batch.written) this.publishLayer(entry, { clipId, snapshotKey: batch.key }, 'local', index.frames);
    }
    return stoppedAfter;
  }
  /**
   * Which **global** frames the whole-scene path needs to render: If a card in a given tier is still
   * missing a snapshot at this frame, this frame must be rendered (union: A single whole-scene render
   * pass serves all cards of the same tier on that frame). Also dispatches existing intervals as
   * `layer` (C3).
   *
   *   `tiers`      Only inspect these tiers (the local-tier pass passes `['local']`, the anchor-frame
   *                pass needs both tiers);
   *   `restrictTo` Only pick among these global frames (the anchor-frame pass passes the anchor frame
   *                set; omitted = all).
   */
  async missingSnapshotFrames(entry, { tiers = ['local'], restrictTo = null } = {}) {
    const plan = entry.cardPlan;
    if (!plan?.length) return [];
    const fps = Number(entry.project.fps) || 30;
    const only = restrictTo ? new Set(restrictTo) : null;
    const wanted = new Set();
    for (const control of plan) {
      // pinned render 9: Cards not in the prerender set do not produce snapshots, so there are no
      // "missing frames" to speak of
      if (!this.prerenderPicked(entry, control.clipId)) continue;
      const tier = control.snapshotKey ? (control.tier || snapshotTier(control.capabilities)) : 'none';
      if (!tiers.includes(tier)) continue;
      const entryKey = tier === 'local' ? entry.key : undefined;
      const index = await this.snapshots().snapshotIndex({ tier, entryKey, key: control.snapshotKey });
      if (index.count) this.publishLayer(entry, control, tier, index.frames);
      // Contract F.3 "do not produce frames for the locking party": Cards locked by other environments
      // dispatch their existing intervals as usual (the line above, with the locking party's key),
      // but their frames are not considered "missing": The whole-scene path does not render for them
      if (control.cardLock?.foreign === true) continue;
      // R6-14: Frames discarded due to being oversize are not considered "missing": They have already
      // been rendered once and classified as oversize once
      if (index.count + rangeCount(index.oversize) >= control.count) continue;
      for (let local = 0; local < control.count; local++) {
        if (rangeHas(index.frames, local) || rangeHas(index.oversize, local)) continue;
        const global = local + control.sampling.firstFrame;
        if (global / fps >= control.end - 1e-9) break;
        if (!only || only.has(global)) wanted.add(global);
      }
    }
    return [...wanted].sort((a, b) => a - b);
  }
  /**
   * C2 **Prerender anchor frames first**: Do not start remaining background prerendering until
   * all anchor frames are ready.
   *
   * Anchor frame set = each clip's `mountFrameOf`, `clipFrameSpan`'s `last + 1`, and frame 0
   * (last sentence of C1; formulas are in `src/render/snapshotPick.mjs`, identical on both sides).
   * This pass takes the whole-scene path, so shared-tier and local-tier cards are produced together:
   * C4's "backtracking within the same interval" relies on that exact clip start frame being ready
   * early, so that scrubbing a cold cache to frame 1000 has something to paste.
   */
  async fillAnchorSnapshots(entry, bakery, signal) {
    const fps = Number(entry.project.fps) || 30;
    const count = Math.max(1, Math.floor(entry.project.duration * fps));
    const clips = (entry.project.tracks || []).flatMap(track => track.clips || []);
    const anchors = anchorFrames(clips, fps).filter(frame => frame >= 0 && frame < count);
    const frames = await this.missingSnapshotFrames(entry, { tiers: ['shared', 'local'], restrictTo: anchors });
    if (!frames.length) { entry.anchorsReady = true; return this.ready.markDone(entry.key); }
    await bakeFrames(bakery, {
      out: entry.dir, targetFrames: frames, snapshotOnly: false, fullFrame: true, writeFrames: false, signal,
      snapshotFrames: new Set(frames),
      // `anchors`: In queue mode, anchor frames are still produced by this pass (J.5), see `recordSnapshots`
      onSnapshot: (n, html, controls) => this.record(entry, n, html, controls, { anchors: true }),
    });
    await this.flushSnapshots(entry);
    if (!signal?.aborted) { entry.anchorsReady = true; this.ready.markDone(entry.key); }
  }
  /**
   * For the card currently being processed by the background pass, hand unstarted batches (head of
   * batch in `pending`) to the Agent dedicated instance to borrow when idle (`takeAgentUnit`).
   * Only one batch (4 frames) is borrowed at a time, taking the rearmost batch: The background pass
   * itself works from front to back (the C4 `wanted` batch is still done by the background pass
   * first), so neither side competes for the same batch.
   * Borrowed batches run the same `runBatch` on the Agent dedicated instance's own prerender bakery;
   * storing snapshots (`commitSnapshots` serialized per key) and PNG caching (`MovFrameStore.put`
   * serialized per store) already accommodate concurrent writes for different frames of the same card.
   * Finalizing this card (`cardCache.finish`, spawning ffmpeg to encode MOV) is only done by the
   * background pass, and only after borrowed batches have settled: So two places will never finalize
   * the same card concurrently.
   * If a borrowed batch errors (not aborted), it is returned to `pending` for the background pass
   * to redo.
   */
  openCardBatchPool({ control, pending, stolen, signal, runBatch }) {
    const pool = {
      tag: `card:${control.key}`,
      take: () => {
        if (this.cardBatchPool !== pool || signal?.aborted || !pending.size) return null;
        const first = Math.max(...pending);
        pending.delete(first);
        let settle;
        const item = { first, done: new Promise(resolve => { settle = resolve; }) };
        stolen.add(item);
        const finish = () => { stolen.delete(item); settle(); };
        return {
          tag: pool.tag, source: 'card-batch',
          giveBack: () => { if (!signal?.aborted) pending.add(first); finish(); },
          run: async agentBakery => {
            try { await runBatch(agentBakery, first, first); }
            catch {
              if (!signal?.aborted) {
                pending.add(first);
                // The dedicated instance's prerender bakery might be broken: Close it (reopened by the next Agent
                // task) to avoid repeatedly borrowing it when idle and repeatedly failing
                this.dropAgentSession(agentBakery);
              }
            }
            finally { finish(); }
          },
        };
      },
    };
    this.cardBatchPool = pool;
    this.kickAgentIdle();
    return pool;
  }
  closeCardBatchPool(pool) {
    if (this.cardBatchPool === pool) this.cardBatchPool = null;
  }
  /**
   * Close that prerender bakery of the Agent dedicated instance (only while it is still `bakery`);
   * reopened when the next Agent task calls `acquire`
   */
  dropAgentSession(bakery) {
    const session = this.lanes.get('agent');
    if (!session || session.bakery !== bakery) return;
    clearTimeout(session.timer);
    this.lanes.delete('agent');
    void Promise.resolve(session.bakery.close?.()).catch(() => {});
  }
  /**
   * 5th parameter (contract J.4, only passed by the queue executor's `renderCardSnapshotRange`;
   * preload never passes it):
   *   `range`   `{ from, to }` closed interval of local frames: Batches only start from batches
   *             covering this interval (start point aligned to 4 frames), and frames for generating
   *             snapshots only take those missing within the interval; the PNG branch, lock checks,
   *             and frames within the batch remain as before;
   *   `onBatch` Called once after each batch is committed with
   *             `({ control, first, frames, snapshotFrames })` (used for progress).
   *   `share`   Passed as `true` by the background pass: Allows unstarted batches for each card to be
   *             borrowed by the Agent dedicated instance when idle (`openCardBatchPool`, "Ordinary
   *             prerender tasks accepted when Agent queue is empty" under "Agent priority is merely
   *             queue jumping" in `mechanism/rendering.md`). When no dedicated instance is open and
   *             idle, nobody borrows, behaving identically to omitting it. Not used with `range`.
   *   `yieldPoint` / `shouldYield`  Provided by `runQueueItem` when a queue fine-grained task runs
   *             on an Agent dedicated instance (AGENT-maint-3): At batch boundaries (4 frames), queries
   *             `shouldYield()`, and if an Agent task is waiting, `await yieldPoint()` to let it run
   *             first. When running batch-by-batch, this occurs between two batches; during a single-pass
   *             forward run (`singlePass`), stops this pass after committing a 4-frame block
   *             (cancellation only takes effect between two frames, so the page is not in midway),
   *             and after yielding, resumes forward execution from the next unrendered batch: Start
   *             point remains aligned to 4 frames, exactly identical to batches run batch-by-batch,
   *             without redoing already committed frames.
   * When omitted, behavior is byte-for-byte identical to the original.
   */
  async fillCardControls(entry, bakery, signal, controls = null, { range = null, onBatch = null, timing = null, singlePass = false, share = false, yieldPoint = null, shouldYield = null } = {}) {
    // Diagnostics (no behavior change): If `timing` is provided, accumulate time spent on page
    // switching, frame pushing, and storing (segmented duration of queue fine-grained tasks,
    // recorded into executor.render by `prerender-executor.mjs`)
    const clock = timing ? () => Date.now() : null;
    const add = (k, ms) => { if (timing) timing[k] = (timing[k] ?? 0) + ms; };
    if (!controls) {
      const browserPlan = await this.browserCardPlan(bakery);
      if (!browserPlan) return [];
      try { controls = entry.cardCache.plan(browserPlan); } catch { return []; }
    }
    // Contract F.3: Locks may have changed after card plan was recorded (page just saved measurement
    // frames); reorder according to the lock store before starting work
    this.reapplyCardLocks(entry, controls);
    const store = this.cardLockStore;
    /*
     * Defer list (contract F.3's `'defer'`): Cards the locking party may still be producing are moved
     * to the end first and evaluated once more after remaining cards are finished (`lastChance`);
     * if still `'defer'`, skip this pass, put into `skipped`, and return to caller: At the end of the
     * background pass, schedule a re-evaluation after `cardLockIdleMs` accordingly (contract F.8
     * clause 2, `scheduleCardLockRetry`).
     */
    const skipped = [];
    const work = controls.filter(control => control.cacheable).map(control => ({ control, lastChance: false }));
    for (let at = 0; at < work.length; at++) {
      const { control, lastChance } = work[at];
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      // Which tier to take is determined by review table capabilities, not by `cacheable`:
      // Shared tier = independent / sourceDependent and stateful; other stateful
      // (including belowDependent and unknown) are local tier; non-stateful do not produce snapshots.
      // Local tier can only appear here on explicitly passed controls: On regular paths,
      // snapshots for belowDependent / unknown are produced by C2's whole-scene path (`renderLocalSnapshots`).
      // Without a shared key, addressing is impossible (manually constructed control, and callers
      // not yet wired to a key), so snapshots are not written.
      // pinned render 9: Cards not in the prerender set use `target = null`: Do not write snapshots,
      // do not update index.json, do not dispatch `layer`. The PNG branch (legacy full-frame channel
      // and data for `renderState`) remains as usual; otherwise `?preview=legacy` will lack data.
      const tier = control.snapshotKey && this.prerenderPicked(entry, control.clipId)
        ? (control.tier || snapshotTier(control.capabilities)) : 'none';
      const entryKey = tier === 'local' ? entry.key : undefined;
      let target = tier === 'none' ? null : { tier, entryKey, key: control.snapshotKey };
      // C2: The HTML side has an additional completeness criterion: `count` in `index.json` is
      // **existing frame count** (`rangeCount` in `snapshot-store.mjs`), and complete =
      // `index.count === control.count`. `hasComplete` on the PNG side cannot govern it: Within the
      // same pass, PNG may be complete while snapshots are missing a section.
      let index = target ? await this.snapshots().snapshotIndex(target) : { count: 0, frames: [], oversize: [] };
      let published = false;
      /*
       * Contract F.3 "do not produce frames for the locking party": This card is locked on another
       * environment (key is already the locking party's, and `index` also checks the locking party's key).
       *   'reuse'    Locking party is complete: Dispatch its layer, HTML branch does not produce
       *              (`target` treated as null), PNG branch remains as usual;
       *   'defer'    Locking party is still fresh: Move to the end and evaluate once more; if still fresh,
       *              skip this pass;
       *   'takeover' Locking party is idle and incomplete: Transfer lock to this machine, switch all
       *              controls with the same content key back to own key, first dispatch layer with
       *              intervals currently existing under own key (may be empty): Over the wire this is a
       *              whole-layer key swap, page drops frames from the old environment: Then produce as usual.
       */
      if (target && tier === 'shared' && control.cardLock?.foreign === true && store && control.contentKey) {
        const ownFingerprint = control.ownEnvFingerprint ?? null;
        const complete = index.count + rangeCount(index.oversize) >= control.count;
        const decision = cardLockDecision({ lock: store.get(control.contentKey), ownFingerprint, complete, now: Date.now(), idleMs: this.cardLockIdleMs ?? CARD_LOCK_IDLE_MS });
        if (decision === 'defer') {
          if (!lastChance) {
            if (index.count) this.publishLayer(entry, control, tier, index.frames);
            work.push({ control, lastChance: true });
          } else skipped.push(control);
          continue;
        }
        if (decision === 'reuse') {
          if (index.count) this.publishLayer(entry, control, tier, index.frames);
          published = true;
          target = null;
        } else {
          if (decision === 'takeover' && ownFingerprint) store.takeover(control.contentKey, ownFingerprint, 'prerender');
          this.reapplyCardLocks(entry, controls);
          target = { tier, entryKey, key: control.snapshotKey };
          index = await this.snapshots().snapshotIndex(target);
          if (decision === 'takeover') {
            this.publishRelocked(entry, controls, control, index.frames);
            published = true;
          }
        }
      }
      // R6-14: Frames discarded due to being oversize count as "already processed": Otherwise
      // `htmlComplete` would always be false, re-rendering the whole card every pass, re-evaluating
      // oversize, and discarding again.
      let htmlComplete = !target || index.count + rangeCount(index.oversize) >= control.count;
      /*
       * Contract F.3 "must acquire lock before rendering" + F.8 clause 1 "must acquire lock even if
       * this machine already has results": When encountering a shared-tier card, acquire lock with the
       * local fingerprint, regardless of whether this machine is already complete: To prevent cards
       * that this machine already finished producing but lack a lock file (cache predating lock store)
       * from being preempted by the page's measurement frames. If lock cannot be acquired (page just
       * preemptively locked it), this card will no longer write HTML snapshots in this pass; card plan
       * has been reordered according to the lock store.
       */
      if (target && tier === 'shared'
        && !this.acquireCardLock(entry, { tier, contentKey: control.contentKey, envFingerprint: control.ownEnvFingerprint ?? control.envFingerprint }, controls)) {
        target = null;
        htmlComplete = true;
      }
      if (target && index.count && !published) this.publishLayer(entry, control, tier, index.frames);
      if (htmlComplete && await entry.cardCache.hasComplete(control)) continue;
      const isolated = this.isolatedCardProject(entry.project, control);
      // A small batch retains Chrome state inside a stateful card, while every
      // batch boundary remains cancellable/schedulable.  `fullFrame` is vital:
      // the cache image is a full transparent stage, never a crop to be framed
      // again during composition.
      //
      // C4: Batch boundaries are schedulable points: Before each batch begins, read
      // `latestPlayhead().wanted` from the mirror plugin; the batch containing it runs first, then
      // returns to sequential batches (`nextBatchStart`).
      const pending = new Set();
      if (range) {
        // J.4: Only run batches covering [from, to]; batch start points are still aligned to 4 frames,
        // exactly identical to batches when rendering the whole card in one pass
        const last = Math.min(range.to, control.count - 1);
        for (let first = Math.max(0, range.from - (range.from % 4)); first <= last; first += 4) pending.add(first);
      } else for (let first = 0; first < control.count; first += 4) pending.add(first);
      const inRange = range ? n => n >= range.from && n <= range.to : () => true;
      /*
       * A range (`range`) of a queue fine-grained task run as a single pass (`singlePass`, determined by
       * `renderCardSnapshotRange` according to `queueSinglePass`):
       * Batches originally to be run for this range are merged into one batch: The frame set is identical
       * to the union of running batch-by-batch, switching pages only once and replaying from the mount
       * frame only once. When running batch-by-batch, each batch must switch to a new page (the prerender
       * bakery refetches hundreds of modules) and replay from the mount frame to the start of the batch;
       * across a 60-frame range, page switching accounts for more than half the time
       * (`docs/archive/agent-reports/AGENT-uc-latency.md`). A single-pass forward run and pushing from the
       * start batch-by-batch produce identical pixels for DOM cards (M7 probe P2,
       * `docs/archive/agent-reports/AGENT-m7-probe.md`); canvas cards are not equivalent and do not take
       * this path (see `queueSinglePass`). Storing is committed every 4 frames as usual (granularity for
       * progress and layer dispatching remains unchanged).
       */
      const oneBatch = !!(range && singlePass && pending.size > 1);
      if (timing) timing.singlePass = oneBatch;
      /*
       * A batch (or an entire range for `oneBatch`) is completed on a given prerender bakery: Switch
       * pages, push frames, store, and dispatch layers. During the background pass (`share`), an idle
       * Agent dedicated instance can borrow unstarted batches (`openCardBatchPool`) and run the same
       * function on its own prerender bakery.
       */
      /**
       * A single-pass forward run stops after committing this frame (yielding to the Agent);
       * null = did not stop
       */
      let stoppedAfter = null;
      const runBatch = async (bkr, first, lastFirst, stop = null) => {
        const localFrames = Array.from({ length: Math.min(lastFirst + 4, control.count) - first }, (_, n) => first + n);
        // C2: Frame set narrowed down to **frames missing for this card** (subtracted based on existing
        // intervals in `index.json` for that key). The PNG branch still requires all frames as usual
        // (`targetFrames` left untouched); only the snapshot generation branch is narrowed down.
        // R6-14: Frames already classified as oversize are also subtracted, avoiding rendering them again
        // for nothing
        const missing = target ? localFrames.filter(n => inRange(n) && !rangeHas(index.frames, n) && !rangeHas(index.oversize, n)) : [];
        const t0 = clock?.();
        const small0 = timing ? (this.smallStats.ms ?? 0) : 0;
        await bkr.reset(isolated, this.emptyUrl(isolated), { deferCards: true });
        await bkr.page.setViewport({ width: isolated.width, height: isolated.height, deviceScaleFactor: this.scaleForLane('background') });
        const t1 = clock?.();
        if (timing) { add('resetMs', t1 - t0); add('smallMs', (this.smallStats.ms ?? 0) - small0); timing.batches = (timing.batches ?? 0) + 1; timing.resetMaxMs = Math.max(timing.resetMaxMs ?? 0, t1 - t0); }
        const produced = [];
        // Committed once per batch (4 frames) rather than per frame: Writing frame files, checking size,
        // and merging index.json are done in one step by the snapshot store (#9).
        // A3c: Oversize frames are written to disk as usual, but do not enter the ready index and are
        // not delivered (diagnostics recorded in the snapshot store); R6-14: Frame numbers are recorded into
        // `oversize`, skipped on the next pass. When a key has thousands of frames, read-modify-write on
        // a small JSON cannot match batch amortization.
        const commitProduced = async () => {
          if (!produced.length || signal?.aborted || !this.prerenderPicked(entry, control.clipId)) return;
          const c0 = clock?.();
          index = await this.snapshots().commitSnapshots({ ...target, clipId: control.clipId, capabilities: control.capabilities, items: produced.splice(0) });
          // C3: When this layer's interval grows, dispatch a full `layer`
          if (index.written.length) this.publishLayer(entry, control, tier, index.frames);
          if (timing) add('commitMs', clock() - c0);
        };
        // During a single-pass forward run (`oneBatch`), commit once and report progress once every 4
        // frames as usual: Commit as soon as 4 captured frames accumulate (snapshots for this frame
        // were already generated before capturing)
        const shotChunk = [];
        const flushChunk = async () => {
          await commitProduced();
          const frames = shotChunk.splice(0);
          if (frames.length && onBatch && !signal?.aborted) onBatch({ control, first: frames[0], frames, snapshotFrames: frames.filter(n => missing.includes(n)) });
          // Yield to the Agent: After committing this block, stop this pass if there are still frames
          // remaining (frame pushing will not proceed at the start of the next frame)
          if (stop && frames.length && frames[frames.length - 1] < localFrames[localFrames.length - 1] && shouldYield?.()) {
            stoppedAfter = frames[frames.length - 1];
            stop.abort();
          }
        };
        const bakeSignal = stop ? AbortSignal.any([signal, stop.signal].filter(Boolean)) : signal;
        let baked;
        try {
          baked = await bakeFrames(bkr, { out: path.join(this.root, 'controls', control.key), targetFrames: localFrames,
          snapshotOnly: false, fullFrame: true, writeFrames: false, signal: bakeSignal,
          snapshotFrames: new Set(missing),
          onFrame: async (frame, png) => {
            const put = await entry.cardCache.put(control.key, frame, png, () => !signal?.aborted);
            if (oneBatch) { shotChunk.push(frame); if (shotChunk.length >= 4) await flushChunk(); }
            return put;
          },
          // In an isolated project, the target clip is the only visible output, so matching `control.clipId`
          // in this frame's control list identifies this card's subtree. `data-pc-local-frame` is the
          // card's own local frame, consistent with the isolated project's frame number (clip is translated
          // to -phase), but the one carried in the snapshot result still prevails: Directories are
          // addressed by local frames.
          onSnapshot: async (frame, html, items) => {
            if (!target || signal?.aborted || !this.prerenderPicked(entry, control.clipId)) return;
            const own = (items || []).find(item => item.id === control.clipId);
            if (!own || !Number.isInteger(own.frame)) return;
            produced.push({ localFrame: own.frame, html: own.html });
          } });
        } catch (error) {
          // A pass stopped for yielding: Committed blocks are all in the store; no frames were pushed after
          // the moment of stopping (cancellation only takes effect between two frames)
          if (stop?.signal.aborted && !signal?.aborted && stoppedAfter !== null) { produced.length = 0; shotChunk.length = 0; return; }
          throw error;
        }
        const t2 = clock?.();
        if (timing) { add('bakeMs', t2 - t1); add('advancedFrames', Number(baked?.advancedFrames) || 0); add('shotFrames', localFrames.length); }
        if (oneBatch) await flushChunk();
        else {
          await commitProduced();
          if (onBatch && !signal?.aborted) onBatch({ control, first, frames: localFrames, snapshotFrames: missing });
        }
      };
      // Batches borrowed by the Agent dedicated instance and not yet completed (only present during `share`):
      // Must wait for them before finalizing (`finish`) this card
      const stolen = new Set();
      const pool = share && !range && !oneBatch ? this.openCardBatchPool({ control, pending, stolen, signal, runBatch }) : null;
      try {
        while (pending.size || stolen.size) {
          if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
          // The remaining batches are all held by the Agent dedicated instance: wait for one of them to settle
          // (batches that error while borrowed are returned to `pending`, and work resumes here)
          if (!pending.size) { await Promise.race([...stolen].map(item => item.done)); continue; }
          // Batch boundary: if an Agent task is waiting for this instance, let it run first (only queue
          // fine-grained tasks running on a dedicated instance have a `yieldPoint`)
          if (yieldPoint && shouldYield?.()) {
            const y0 = clock?.();
            await yieldPoint();
            if (timing) { add('yieldMs', clock() - y0); timing.yields = (timing.yields ?? 0) + 1; }
            if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
          }
          const first = oneBatch ? Math.min(...pending) : this.nextBatchStart(pending, control);
          const lastFirst = oneBatch ? Math.max(...pending) : first;
          const all = oneBatch ? [...pending] : null;
          if (oneBatch) pending.clear(); else pending.delete(first);
          stoppedAfter = null;
          await runBatch(bakery, first, lastFirst, oneBatch && yieldPoint ? new AbortController() : null);
          // Sequential push stops to yield: unexecuted batches (start point after the stopped frame) are
          // released back, and the next round yields first before resuming sequential push from them
          if (stoppedAfter !== null) for (const f of all) if (f > stoppedAfter) pending.add(f);
        }
      } finally {
        if (pool) this.closeCardBatchPool(pool);
        // Even if this pass is aborted, wait for borrowed batches to stop (they watch the same signal),
        // to avoid anything still writing to this card after finalization
        if (stolen.size) await Promise.allSettled([...stolen].map(item => item.done));
      }
      if (!signal?.aborted) {
        const f0 = clock?.();
        await entry.cardCache.finish(control);
        if (timing) add('finishMs', clock() - f0);
      }
    }
    // `fillCardControls` shares the background Chrome with the mandatory
    // complete-scene pass. Restore its normal project before snapshot/MOV.
    const r0 = clock?.();
    await bakery.reset(entry.project, this.emptyUrl(entry.project), { deferCards: true });
    await bakery.page.setViewport({ width: entry.project.width, height: entry.project.height, deviceScaleFactor: this.scaleForLane('background') });
    if (timing) add('restoreMs', clock() - r0);
    return skipped;
  }
  /**
   * Re-evaluate deferred cards once (Contract F.8 item 2; `mechanism/rendering.md`: local takes over
   * after the locking party has been stopped for a period of time).
   *
   * If there are still `'defer'` cards (`controls`, tracked by `clipId`) when the background pass
   * finishes, set a one-time `unref` timer that triggers after `cardLockIdleMs`. When triggered, all
   * three conditions must be satisfied simultaneously: this version's `signal` has not aborted, there
   * are still sessions whose current version is this entry, and these cards are still in the
   * prerender set: only then schedule a mini pass into the `this.background` serial chain: borrow
   * the `'background'` prerender room and run `fillCardControls` only for these cards (same
   * `signal`). Upon re-evaluation: deliver if the locking party is complete, take over if it has
   * become idle, and schedule once more if still fresh; the same version (the same entry) is
   * scheduled at most `CARD_LOCK_RETRY_MAX` times, then waits for the next version.
   *
   * The timer is cleared when `signal` aborts (this version is replaced) or on `close()`, so it will
   * not hang the process.
   */
  scheduleCardLockRetry(entry, controls, signal) {
    const clipIds = [...new Set((controls ?? []).map(control => control?.clipId).filter(Boolean))];
    if (!clipIds.length || this.closed || signal?.aborted || !entry) return false;
    const state = (entry.cardLockRetry ||= { count: 0, timer: null });
    if (state.count >= CARD_LOCK_RETRY_MAX) return false;
    state.count++;
    if (state.timer) { clearTimeout(state.timer); this.cardLockTimers?.delete(state.timer); }
    const onAbort = () => {
      if (!state.timer) return;
      clearTimeout(state.timer);
      this.cardLockTimers?.delete(state.timer);
      state.timer = null;
    };
    const timer = setTimeout(() => {
      this.cardLockTimers?.delete(timer);
      if (state.timer === timer) state.timer = null;
      signal?.removeEventListener?.('abort', onAbort);
      this.retryDeferredCards(entry, clipIds, signal);
    }, this.cardLockIdleMs ?? CARD_LOCK_IDLE_MS);
    timer.unref?.();
    state.timer = timer;
    this.cardLockTimers?.add(timer);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    return true;
  }
  /**
   * Timer triggers: schedule that mini pass only if all three conditions are met (see
   * `scheduleCardLockRetry`). Returns the Promise for the scheduled pass, or null if not scheduled.
   */
  retryDeferredCards(entry, clipIds, signal) {
    if (this.closed || signal?.aborted) return null;
    if (!this.ready.sessionsOn(entry.key).length) return null;
    const wanted = new Set(clipIds);
    const pick = () => (entry.cardPlan ?? []).filter(control => wanted.has(control?.clipId) && control.cacheable && this.prerenderPicked(entry, control.clipId));
    if (!pick().length) return null;
    const pass = this.background.catch(() => {}).then(async () => {
      if (this.closed || signal?.aborted) return;
      // During queuing, the card plan may have been recomputed (a new object): re-fetch from the current
      // plan by clipId
      const controls = pick();
      if (!controls.length) return;
      let bakery, skipped = controls;
      try {
        bakery = await this.acquire('background', entry.project);
        skipped = await this.fillCardControls(entry, bakery, signal, controls);
      } catch {
        // Yielded to playback, or unable to borrow a prerender room: these cards remain pending evaluation
        // and are still rescheduled (counted as usual)
        if (signal?.aborted) return;
      } finally {
        if (bakery && this.lanes.get('background')?.bakery === bakery) this.release('background');
      }
      if (skipped?.length) this.scheduleCardLockRetry(entry, skipped, signal);
    });
    this.background = pass;
    return pass;
  }
  /**
   * Frames pushed during page measurement are stored as shared snapshots (Contract F.3; semantics
   * `mechanism/rendering.md` "Reuse of prerender output"). All decisions for route
   * `PUT /api/frames/snapshot` are here. `control` is that item in entry's card plan, and the route
   * has already confirmed it is a shared-tier card marked `independent` in the review table. In
   * order:
   *
   *   1. Wait for lock store read to finish;
   *   2. Page fingerprint is not 16 lowercase hex characters → `ENV_MISSING`, do not write;
   *   3. Acquire lock by page fingerprint; if unavailable (locked on another environment) →
   *      `CARD_LOCKED`, with `lockedBy`;
   *   4. Write under page's own key `resultKeyOf(contentKey, pageFingerprint)`; if not even a single
   *      frame was indexed (over limit) → `OVER_LIMIT`;
   *   5. Rearrange card plan according to lock store (replace this card with page's key), emit
   *      layers;
   *   6. Return `{ ok, stored, indexed, count, envFingerprint, key }`.
   *
   * When the page fingerprint happens to match the local prerender fingerprint, step 3 acquires the
   * lock with the same fingerprint, step 4's key is local's own key, and results from both sides are
   * combined.
   */
  async acceptMeasuredSnapshot(entry, control, { envFingerprint, localFrame, html } = {}) {
    await this.ensureCardLocks();
    if (typeof envFingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(envFingerprint)) return { ok: true, stored: false, reason: 'ENV_MISSING' };
    const contentKey = control?.contentKey;
    // Without a content key, there is no lock key, nor can the page key be computed (old shape of
    // card plan); do not store, let the prerender process produce it itself
    if (typeof contentKey !== 'string' || !/^[0-9a-f]{64}$/.test(contentKey) || !this.cardLockStore) return { ok: true, stored: false, reason: 'NO_CONTENT_KEY' };
    const { granted, lock } = this.cardLockStore.acquire(contentKey, envFingerprint, 'page');
    if (!granted) return { ok: true, stored: false, reason: 'CARD_LOCKED', lockedBy: lock?.envFingerprint ?? null };
    const key = resultKeyOf(contentKey, envFingerprint);
    const index = await this.snapshots().commitSnapshots({ tier: 'shared', key, clipId: control.clipId, capabilities: control.capabilities,
      items: [{ localFrame, html }] });
    if (!index.written.length) return { ok: true, stored: true, indexed: false, reason: 'OVER_LIMIT', envFingerprint, key };
    this.reapplyCardLocks(entry);
    this.publishLayer(entry, { clipId: control.clipId, snapshotKey: key }, 'shared', index.frames);
    // Other clips with the same content key (the same card placed multiple times) are also locked to
    // the page; their layers are switched to the page key together
    for (const item of entry?.cardPlan ?? []) {
      if (item?.clipId && item.clipId !== control.clipId && item.contentKey === contentKey && item.snapshotKey === key && this.prerenderPicked(entry, item.clipId)) {
        this.publishLayer(entry, item, 'shared', index.frames);
      }
    }
    return { ok: true, stored: true, indexed: true, count: index.count, envFingerprint, key };
  }
  /**
   * Queue executor's `plan` (Contract J.4, design appendix section 2). `project` has already passed
   * `renderProject`, doing the same thing as the `/preload` route does to mirrors, so the same JSON
   * computes the same `entry.key`.
   *
   *   1. `entry = this.entry(project)`;
   *   2. Open a prerender room on the `'queue'` lane, fetch the browser's card plan
   *      (`browserCardPlan`, no page session needed);
   *   3. When `entry.cardPlan` is not yet an array, `recordCardPlan` (do not call `adoptCardPlan`: it
   *      claims the session);
   *   4. Determine `cardLocks` / `takeover` for shared-tier cards based on the local lock store
   *      (`cardLockDecision`): `reuse` / `defer` generate keys based on the locking party's
   *      fingerprint; `takeover` first takes over in the local lock store (same approach as
   *      `fillCardControls`, clips with the same content key switch keys and emit layers together),
   *      then lets splitting generate keys based on the local fingerprint, with tasks carrying
   *      `takeover`;
   *   5. Keep only cards with `queueHandles`, filling in inner cards' `cardId` / `cardIds`
   *      (`withInnerCards` in `split.mjs`: controls in the card plan only have `nodeId`; when clips
   *      have attached emphasis or filters, the output node is the outer layer, so follow inputs to
   *      find the inner card);
   *   6. Track streams (M6c X1): when local can produce streams (`queueStreamSpecs`: switch is on,
   *      encoder detected), compute all streams for this version and put them into `context.streams`
   *      (`splitPlan` splits stream tasks based on it); otherwise empty, same as M5b.
   *
   * Returns `{ entry, context, streamSpecs }`, where `context` is the PlanContext passed to
   * `splitPlan`; `streamSpecs` is the complete result of `planStreams` (the executor uses it to match
   * stream tasks back to this version's streams).
   */
  async planForQueue(project, { signal } = {}) {
    const entry = await this.entry(project);
    const browserPlan = await this.runQueueTask(async lease => {
      const bakery = await lease(entry.project);
      if (signal?.aborted) throw Object.assign(new Error('Queue task cancelled'), { cancelled: true });
      return this.browserCardPlan(bakery);
    }, signal);
    if (!browserPlan) throw Object.assign(new Error('The prerender page did not provide a card plan (window.__pcCardPlan)'), { code: 'no-card-plan', retryable: true });
    await this.ensureCardLocks();
    if (!Array.isArray(entry.cardPlan)) {
      let plan;
      try { plan = entry.cardCache.plan(browserPlan); }
      catch (error) { throw Object.assign(new Error(`Could not compute the card plan: ${error?.message || error}`), { code: 'no-card-plan', retryable: true }); }
      this.recordCardPlan(entry, plan);
    }
    // The lock may have changed after card plan was recorded (page just stored measurement frames):
    // re-sort according to the lock store
    this.reapplyCardLocks(entry);
    const fps = Number(entry.project.fps) || 30;
    const count = Math.max(1, Math.floor(Number(entry.project.duration) * fps));
    const graph = browserPlan?.graph || browserPlan;
    const sourceVersions = browserPlan?.sourceVersions ?? {};
    const store = this.cardLockStore;
    const own = this.envFingerprint;
    const cardLocks = new Map();
    const takeover = new Set();
    for (const control of entry.cardPlan) {
      if (!this.queueHandles(control) || !this.prerenderPicked(entry, control.clipId)) continue;
      if ((control.tier || snapshotTier(control.capabilities)) !== 'shared' || !control.contentKey || !store) continue;
      const lock = store.get(control.contentKey);
      const ownFingerprint = control.ownEnvFingerprint ?? own;
      if (!lock || lock.envFingerprint === ownFingerprint) continue;
      const lockKey = `snapshot:${control.contentKey}`;
      const foreign = await this.snapshots().snapshotIndex({ tier: 'shared', key: resultKeyOf(control.contentKey, lock.envFingerprint) });
      const complete = foreign.count + rangeCount(foreign.oversize) >= control.count;
      const decision = cardLockDecision({ lock, ownFingerprint, complete, now: Date.now(), idleMs: this.cardLockIdleMs ?? CARD_LOCK_IDLE_MS });
      // Locks on the queue side are mostly held by the locking party as well: generate keys based on its
      // fingerprint, or with `takeover` generate keys based on the local fingerprint (Contract F.2)
      cardLocks.set(lockKey, lock.envFingerprint);
      if (decision !== 'takeover' || !ownFingerprint) continue;
      store.takeover(control.contentKey, ownFingerprint, 'prerender');
      this.reapplyCardLocks(entry);
      const index = await this.snapshots().snapshotIndex({ tier: 'shared', key: control.snapshotKey });
      this.publishRelocked(entry, null, control, index.frames);
      takeover.add(lockKey);
    }
    const cardPlan = withInnerCards(entry.cardPlan.filter(control => this.queueHandles(control)), graph);
    const clips = (entry.project.tracks || []).flatMap(track => track.clips || []);
    // Task brief "Jia-2": check first, produce only if missing. If another environment already has the
    // complete stream for this version's single-card stream (produced by the online page itself when
    // there was no split node), pull it back locally first and record the lock;
    // Subsequent stream planning and splitting both generate keys according to the lock: this stream
    // produces only one copy under that fingerprint; local does not produce its own copy or re-produce
    if (this.pushQueue) { try { await this.adoptForeignStreams(entry, this.pushQueue.content, this.pushQueue.client, { signal }); } catch {} }
    for (const [contentKey, fingerprint] of this.streamLocks) cardLocks.set(`stream:${contentKey}`, fingerprint);
    const streamSpecs = await this.queueStreamSpecs(entry);
    const ownListStreams = await this.streamCapable();
    const context = {
      entryKey: entry.key,
      // Normal plans only split cards classified as heavy by local; clips entering the set via prerender
      // retry are only split by prerender retry plan tasks (tagged backfill, scheduled after tasks
      // classified as heavy by local, c10a contract section 17)
      prerenderSet: entry.basePrerenderSet instanceof Set ? new Set(entry.basePrerenderSet)
        : entry.prerenderSet instanceof Set ? new Set(entry.prerenderSet) : undefined,
      cardPlan,
      // Each stream along with its shape (`queueStreamOf`): needed when splitting the single-card stream
      // portion for the browser (browser-stream-task.md, first occurrence)
      streams: streamSpecs.map(queueStreamOf),
      // Used by online page manifest plans (`listPlanOverrides` in `local-node.mjs`): compute streams
      // based on clips in the manifest. The browser portion does not check whether local classified as
      // heavy, or whether local can produce streams (the two gates in `queueStreamSpecs` only govern the
      // splitter's own produced portion)
      browserStreamsFor: clips => this.listStreamSpecs(entry, clips).map(queueStreamOf),
      // Used only for export manifest plans (`listPlanOverrides` in `local-node.mjs`): how export bitmaps
      // are generated for each clip in the manifest, and which ones cannot be generated
      exportStreamsFor: (clips, salt) => { const { specs, unsupported } = this.exportStreamSpecs(entry, clips, salt); return { streams: specs.map(exportStreamOf), unsupported }; },
      // Task brief "Jia-3": whether the splitter's own portion in the manifest plan is produced depends
      // on whether local can produce streams at this moment (has a producer, switch enabled, encoder
      // detected: the same criterion as `capabilities.streams` reported by `node.hello`). Host render
      // nodes additionally check "Generate track streams" for this project (the executor tightens once
      // more by project). Whether local classified as heavy is not checked: the manifest is determined
      // by the publisher, and when stream tasks return, the executor matches them back to this version
      // based on clips in the manifest (`matchStream` in `prerender-executor.mjs`)
      ownListStreams,
      anchorFrames: anchorFrames(clips, fps).filter(frame => frame >= 0 && frame < count),
      // c66-host-cards: global code version (`frameCode`) no longer covers user cards and overlay layers;
      // code identities of custom cards used in this version are written into requires.cardSources by
      // splitting (shared tier writes only this card's; local tier and streams write all), and nodes that
      // do not hold this code will not claim the task
      cardSourceVersions: { ...(entry.cardSources ?? {}) },
      // Stream tasks (single-card streams, below-dependent streams, export bitmaps) only require the code
      // pieces used in the subset expanded from this stream (0.7.19: keys and requirements are both
      // computed by subset; `streamNeed` / `subsetCardSources` in `render-node/expand.mjs`, and nodes
      // producing streams build isolated projects from the same subset)
      streamCardSources: stream => subsetCardSources(entry.project, streamNeed(stream), entry.cardSources ?? {}),
      weightOf: control => ({ class: this.queueWeightClass(control), estMs: null }),
      // Counts if any card inside the clip is a user card (for clips with attached emphasis or filters,
      // look at the inner card); when uncertain about the inside, counts if this version has user cards
      isUserCard: control => isUserCardControl(control, sourceVersions),
      isGraphCard: control => this.isGraphCardControl(control),
      cardLocks,
      takeover,
    };
    return { entry, context, streamSpecs };
  }
  /**
   * M6c X1: Track streams to be produced via the queue in this version (the complete result of
   * `planStreams`, using the same algorithm and parameter set as `StreamProducer.update`, so stream
   * keys are identical). When local has no producer (`interactive: false`), the switch is off
   * (`PROMPTCUT_STREAMS=0`), or no encoder is detected (`capable()`), returns `[]`: in this case no
   * stream tasks are published, behaving the same as M5b.
   */
  async queueStreamSpecs(entry) {
    const producer = this.streamProducer();
    if (!producer?.enabled || !(await producer.capable())) return [];
    try {
      return planStreams(entry, { picked: clipId => this.streamPicked(entry, clipId), budget: producer.budget,
        codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: this.envFingerprint });
    } catch {
      return [];
    }
  }
  /**
   * Respective streams for clips in the manifest plan (uses the same parameter set as
   * `queueStreamSpecs`, so content keys for single-card streams are identical); returns `[]` if it
   * cannot be computed. Used during splitting (`browserStreamsFor` in `planForQueue`), and the
   * executor also uses it to match tasks back to this version when stream tasks return: the
   * splitter's own portion in the manifest plan only produces single-card streams and below-dependent
   * streams (`listPlanOverrides` in `local-node.mjs`), and content keys for these two stream types do
   * not depend on which other clips are in the manifest, so giving only one clip still computes the
   * same stream.
   */
  listStreamSpecs(entry, clips) {
    try {
      return planListStreams(entry, clips, { budget: this.streamProducer()?.budget ?? streamDecoderBudget(),
        codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: this.envFingerprint });
    } catch {
      return [];
    }
  }
  /**
   * Frame-by-frame bitmaps dedicated to export (`export-frames.mjs`; visuals of cards not executed
   * on this page during online browser export): plans one stream for each clip in the manifest (same
   * parameters as `listStreamSpecs`, so the content key is identical to this card's track stream),
   * without merging by decoder budget: one copy per card. Planar standalone cards, source-dependent
   * cards, and 3D bounding box cards output in the single-card stream shape (wrapper layer
   * coordinates); below-dependent cards output in the below-dependent stream shape (stage coordinates,
   * differential layer extraction). Returns `{ specs, unsupported }`: `specs` is the result of
   * `exportSpecOf` (also carrying this version's project input signature `inputSig`); `unsupported`
   * lists clips that cannot be produced and their reasons: `no-card` (not in this version's card
   * plan: nodes do not have this card's code, or the clip no longer exists), `no-stream` (this card
   * has no stream shape of any kind, e.g. below-dependent with a 3D bounding box). When local has no
   * environment fingerprint yet, all count as `no-fingerprint`.
   */
  exportStreamSpecs(entry, clips, salt = '') {
    const wanted = [...new Set((Array.isArray(clips) ? clips : [...(clips ?? [])]).filter(id => typeof id === 'string' && id))];
    const own = this.envFingerprint;
    if (!own) return { specs: [], unsupported: wanted.map(clipId => ({ clipId, reason: 'no-fingerprint' })) };
    const listed = new Set(wanted);
    let planned = [];
    try {
      planned = planStreams(entry, { picked: clipId => listed.has(clipId), budget: Infinity,
        codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: own });
    } catch { planned = []; }
    const controls = new Set((entry?.cardPlan ?? []).map(control => control?.clipId));
    const specs = [], unsupported = [];
    for (const clipId of wanted) {
      const hit = planned.find(spec => Array.isArray(spec?.clipIds) && spec.clipIds.length === 1 && spec.clipIds[0] === clipId);
      let inputSig = null;
      try { inputSig = hit ? streamInputSig(entry.project, { clipIds: [clipId], kind: hit.kind }) : null; } catch { inputSig = null; }
      const spec = hit ? exportSpecOf({ ...hit, ...(inputSig ? { inputSig } : {}) }, own, salt) : null;
      if (spec) specs.push(spec);
      else unsupported.push({ clipId, reason: controls.has(clipId) ? 'no-stream' : 'no-card' });
    }
    return { specs, unsupported };
  }
  /**
   * A segment of an export bitmap task (`[from, to]` are segment numbers): fetched frame by frame
   * and saved as PNGs under `<store-root>/export-frames/<result-key>/` (`storeExportFrame`), then the
   * artifact store side pushes to the asset service, writes the manifest, and deletes local frames
   * (`createExportFramesSink`). Returns `null`.
   */
  async renderExportFrames(entry, spec, range, { signal, progress } = {}) {
    const producer = this.streamProducer();
    if (!producer) throw Object.assign(new Error('This prerender instance has no track stream producer, so it cannot fetch export bitmaps'), { code: 'no-stream-producer', retryable: false });
    await producer.produceExportRange(entry, spec, range, { signal, progress,
      onFrame: async (frame, shot) => { await storeExportFrame(this.root, spec.exportResultKey, frame, shotToPng(shot)); } });
    return null;
  }
  /**
   * M6c X1: Local node `node.hello`'s `capabilities.streams`: true only if there is a producer, the
   * switch is on, and an encoder is detected (probed only once per process). Editor processes
   * (`interactive: false`) have no producer and return false.
   */
  async streamCapable() {
    const producer = this.streamProducer();
    return !!producer && producer.enabled === true && (await producer.capable()) === true;
  }
  /**
   * M6c X1: A segment of a stream task (`[from, to]` are segment numbers): handed to the track
   * stream producer to produce by segment (`StreamProducer.produceRange`), returning only after each
   * segment is persisted to disk and layers are emitted. Returns `null`: outputs are in the stream
   * store, and the sink reads them itself (`collectStreamResult`).
   */
  async renderStreamRange(entry, spec, range, { signal, progress, density = null } = {}) {
    const producer = this.streamProducer();
    if (!producer) throw Object.assign(new Error('This prerender instance has no track stream producer'), { code: 'no-stream-producer', retryable: false });
    await producer.produceRange(entry, spec, range, { signal, progress, density });
    return null;
  }
  /**
   * Heaviness of fine-grained tasks (appendix section 2): `canvasHeavy`, `belowDependent`, `context`,
   * `unknown`, and local tier are marked `heavy`, the rest `medium`.
   */
  queueWeightClass(control) {
    const caps = control?.capabilities ?? {};
    const compositing = control?.compositing ?? caps.compositing;
    if (control?.tier === 'local' || caps.canvasHeavy === true || control?.innerCanvasHeavy === true || compositing === 'belowDependent' || compositing === 'context' || compositing === 'unknown') return 'heavy';
    return 'medium';
  }
  /**
   * A segment of a shared-tier snapshot task (Contract J.4, appendix section 3): runs
   * `fillCardControls` for this card on the `'queue'` lane, running only batches covering `range`.
   * `control` is that item in `entry.cardPlan` (lock status is recorded on it). If this card is
   * locked by another environment (lock seized by the page before starting or mid-render), throws
   * `card-locked-local` (non-retryable). `progress(done)` reports the number of local frames already
   * delivered in this segment. Returns `null`: outputs are in the frame store, sink reads them itself.
   */
  /**
   * Whether a segment of a queue fine-grained task can be pushed forward in a single pass
   * (`singlePass` in `fillCardControls`, `docs/archive/agent-reports/AGENT-uc-latency.md`):
   *   - Skip when `PROMPTCUT_QUEUE_SINGLE_PASS=0` or `queueSinglePassOff = true` on the instance (used
   *     for control probe);
   *   - Skip for canvas heavy cards (`canvasHeavy` in review table): for asynchronously loaded canvas
   *     cards, sequential pushing is not equivalent to pushing from scratch batch by batch (M7 probe
   *     P2);
   *   - When the page reports that the playhead currently wants frames of this card in this segment
   *     (C4 `wanted`), run batch by batch as usual, producing the batch containing the playhead first.
   */
  queueSinglePass(control, range) {
    if (this.queueSinglePassOff === true || process.env.PROMPTCUT_QUEUE_SINGLE_PASS === '0') return false;
    if (!range || control?.capabilities?.canvasHeavy === true) return false;
    const firstFrame = Number(control?.sampling?.firstFrame) || 0;
    for (const item of this.playheadWanted()) {
      if (item?.clipId !== control?.clipId) continue;
      const local = Number(item.frame) - firstFrame;
      if (Number.isInteger(local) && local >= range.from - (range.from % 4) && local <= range.to) return false;
    }
    return true;
  }
  /**
   * `heartbeat`: called periodically while dedicated instances yield to the Agent (executor phase
   * callback → session work count, so the lease is not considered stalled).
   */
  async renderCardSnapshotRange(entry, control, range, { signal, progress, timing = null, heartbeat = null } = {}) {
    const locked = () => Object.assign(new Error(`The card of clip ${control.clipId} is locked to a different environment`), { code: 'card-locked-local', retryable: false });
    if (control.cardLock?.foreign === true) throw locked();
    let done = 0;
    // Diagnostic (does not change behavior): if `timing` is provided, record elapsed time for each step
    // (queuing for lane, borrowing prerender room, frame-push items, drawing small size at finalize)
    const queuedAt = Date.now();
    await this.runQueueTask(async (lease, ctx) => {
      if (timing) timing.laneWaitMs = Date.now() - queuedAt;
      if (timing && ctx?.worker) timing.worker = ctx.worker;
      // c10a section 9: note down frames in this segment that have original size but lack small size;
      // page switching from lending prerender rooms and across batches will paint them
      try { await this.scheduleMissingSmall(entry, control, range); } catch { /* Cannot read frame store: will be caught at the completion condition gate */ }
      const l0 = Date.now();
      const bakery = await lease(entry.project);
      if (timing) timing.leaseMs = Date.now() - l0;
      await this.fillCardControls(entry, bakery, signal, [control], {
        range,
        timing,
        singlePass: this.queueSinglePass(control, range),
        ...(ctx?.worker === 'agent' ? { shouldYield: ctx.shouldYield, yieldPoint: () => ctx.yieldPoint({ heartbeat }) } : {}),
        onBatch: ({ frames }) => {
          done += frames.filter(n => n >= range.from && n <= range.to).length;
          try { progress?.(done); } catch { /* Errors in progress callback do not affect rendering */ }
        },
      });
      const s0 = Date.now();
      if (!signal?.aborted) await this.flushPendingSmall(bakery, entry.project);
      if (timing) timing.flushSmallMs = Date.now() - s0;
    }, signal, { tag: `card:${control.key}` });
    if (signal?.aborted) throw Object.assign(new Error('Queue task cancelled'), { cancelled: true });
    if (control.cardLock?.foreign === true) throw locked();
    return null;
  }
  /**
   * A segment of a local-tier snapshot task (Contract J.4, appendix section 3): convert local frames
   * to global frames, pick frames missing for this card in this segment according to
   * `missingSnapshotFrames` conditions, and hand them to `renderLocalSnapshots` (one pass of the whole
   * scene serves all local-tier cards on that frame). Returns `null`.
   */
  async renderSceneSnapshotRange(entry, control, range, { signal, progress, heartbeat = null } = {}) {
    const fps = Number(entry.project.fps) || 30;
    const index = await this.snapshots().snapshotIndex({ tier: 'local', entryKey: entry.key, key: control.snapshotKey });
    const frames = [];
    for (let local = range.from; local <= range.to && local < control.count; local++) {
      if (rangeHas(index.frames, local) || rangeHas(index.oversize, local)) continue;
      const global = local + control.sampling.firstFrame;
      if (global / fps >= control.end - 1e-9) break;
      frames.push(global);
    }
    // c10a section 9: frames with original size but missing small size must also be filled in during
    // this pass (see `scheduleMissingSmall`)
    let missingSmall = 0;
    try { missingSmall = await this.scheduleMissingSmall(entry, control, range); } catch { /* Caught by the completion condition gate */ }
    if (frames.length || missingSmall) {
      await this.runQueueTask(async (lease, ctx) => {
        let bakery = await lease(entry.project);
        // When running on an Agent dedicated instance, ask whether to yield every 4 frames (AGENT-maint-3):
        // stop, let the Agent run first, then reset the page to this version, and resume from unexecuted
        // frames (`renderLocalSnapshots` natively accepts arbitrary frame sets; starting mid-way replays
        // from the mount frame)
        const yielding = ctx?.worker === 'agent' ? ctx : null;
        let rest = frames;
        while (rest.length) {
          const stopped = await this.renderLocalSnapshots(entry, rest, bakery, signal, yielding ? { shouldStop: ctx.shouldYield } : undefined);
          if (stopped == null || signal?.aborted) break;
          rest = rest.filter(n => n > stopped);
          if (!rest.length) break;
          await yielding.yieldPoint({ heartbeat });
          bakery = await lease(entry.project);
        }
        if (!signal?.aborted) await this.flushPendingSmall(bakery, entry.project);
      }, signal, { tag: `scene:${entry.key}` });
    }
    if (signal?.aborted) throw Object.assign(new Error('Queue task cancelled'), { cancelled: true });
    try { progress?.(range.to - range.from + 1); } catch { /* Same as above */ }
    return null;
  }
  /**
   * Cannot connect to document service (Contract J.5 "Cannot connect to document service mid-way"):
   * entries in queue mode all fall back to being produced locally. Background generations for these
   * entries are aborted and rescheduled (`adopt: false`, leaving session version untouched); the pass
   * that has already finished must also be rescheduled: it skipped the snapshot steps. In this
   * rescheduled pass, pass B is skipped because full-frame HTML is already complete, and snapshots
   * are backfilled by `fillCardControls` / `renderLocalSnapshots`. Do not reschedule if no session is
   * parked on this version. Returns the number rescheduled.
   */
  /**
   * M6c X1 gap (integration ruling): under queue mode, local streams belong to the queue
   * (`StreamProducer.queueOwned`), and stream tasks are split out by the node splitting the plan
   * according to its own capabilities. When the splitter has streams disabled (or detects no
   * encoder), this version has zero stream tasks, leaving local streams unproduced. When the
   * publisher sees no stream tasks in its plan's `task.done`, it calls here: return streams for this
   * version (`entryKey`) to local automatic production (bypassing the queue), while snapshots still
   * go through the queue as before. If local itself cannot produce streams, do nothing. Returns how
   * many entries were returned (0 or 1).
   */
  releaseQueueStreams(entryKey) {
    const entry = this.entries.get(entryKey);
    if (!entry || entry.queueSnapshots !== true || entry.queueStreamsLocal === true) return 0;
    const producer = this.streamProducer();
    if (!producer?.enabled) return 0;
    entry.queueStreamsLocal = true;
    producer.kick();
    return 1;
  }
  leaveQueueMode() {
    const rerun = [];
    for (const [owner, generation] of this.generations) {
      const entry = this.entries.get(generation.key);
      if (entry?.queueSnapshots !== true) continue;
      generation.controller.abort();
      rerun.push([owner, entry]);
    }
    for (const entry of this.entries.values()) if (entry.queueSnapshots === true) entry.queueSnapshots = false;
    let count = 0;
    if (!this.closed) for (const [owner, entry] of rerun) {
      if (!this.ready.sessionsOn(entry.key).length) continue;
      void this.preload(entry.project, { adopt: false, owner }).catch(() => {});
      count++;
    }
    return count;
  }
  /**
   * Isolated single-card project: shares `src/kernel/isolatedCard.mjs` with browser-only nodes of
   * online pages (M7 contract section 4.3), behavior unchanged.
   */
  isolatedCardProject(project, control) {
    return isolatedCardProject(project, control);
  }
  prefixes(entry) {
    const prefixes = trackPrefixes(entry.project, entry.code);
    if (!prefixes.length) prefixes.push({ key: entry.key, trackIds: [] });
    return prefixes;
  }
  async rasterPrefix(entry, bakery, frame, i, prefixes) {
    const prefix = prefixes[i];
    const dir = path.join(this.root, 'tracks', prefix.key);
    const file = path.join(dir, pad(frame) + '.png');
    try { return await fs.readFile(file); } catch {}
    // A lower cumulative track is a single lossless bitmap under the upper HTML.
    const base = i ? await fs.readFile(path.join(this.root, 'tracks', prefixes[i - 1].key, `${pad(frame)}.png`)) : null;
    const html = await bakery.page.evaluate(({ html, ids, base }) => {
      const template = document.createElement('template'); template.innerHTML = html;
      const tracks = [...template.content.querySelectorAll('[data-pc-track]')];
      for (const track of tracks) if (!ids.includes(track.getAttribute('data-pc-track'))) track.remove();
      if (base) {
        const img = document.createElement('img'); img.src = 'data:image/png;base64,' + base;
        img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
        template.content.firstElementChild.prepend(img);
      }
      return template.innerHTML;
    }, { html: entry.html.get(frame), ids: i ? [prefix.trackId] : prefix.trackIds, base: base?.toString('base64') || null });
    const buf = await captureSnapshot(bakery, html);
    await atomic(path.join(dir, `${pad(frame)}.png`), buf);
    return buf;
  }
  /**
   * D4(b) `/api/cards/layout`: Agent's `get_layout`: entity boxes of the **whole scene** at time t,
   * running in the prerender process (pinned architecture 4: Agent queries go through prerender,
   * while user-interactive queries go through their own offscreen stage).
   *
   * Renders only **once** per request, regardless of how many clipIds were asked: if `entry.html` has
   * this frame, take it directly; otherwise `bakeFrames` this frame and `record` (hits next time).
   * **MOV/PNG hits cannot short-circuit**: entity boxes require the DOM, which pixels cannot answer;
   * therefore only check `entry.html`, not `entry.mov`.
   *
   * Measurement method: inject snapshot HTML into `#pc-frame-snapshot` (the same `captureSnapshot`
   * path as `rasterPrefix`), and call `window.__pcSolid.rectsWithBounds({ pixels: 'none' })` on
   * `#pc-frame-snapshot [data-pc-scene]` after `document.fonts.ready` and before `prepareFrameMedia`:
   * canvas in snapshots is already replaced with `<img>` carrying `data-pc-painted-box`, so pixels do
   * not need to be (and cannot be) read. `screenshot: false` avoids paying for an unneeded 1080p PNG
   * in this pass.
   *
   * Agent lane serialization: Agent batches through `runAgentTask` and `see_frames`, `entityRects`,
   * and DOM queries all queue in the same line (#12).
   */
  async layout(project, options = {}) {
    return this.runAgentTask(lease => this.layoutNow(project, options, lease));
  }
  /**
   * When `lease` is omitted, `acquire` / `release` on its own; when entering via `layout`, borrowed
   * and returned by `runAgentTask`.
   */
  async layoutNow(project, { t = 0, clipIds = null, signal } = {}, lease = null) {
    const lane = 'agent';
    const entry = await this.entry(project);
    const fps = Number(entry.project.fps) > 0 ? entry.project.fps : 30;
    const max = Math.max(0, Math.floor((Number(entry.project.duration) || 0) * fps) - 1);
    const frame = Math.max(0, Math.min(max, Math.round((Number(t) || 0) * fps)));
    const at = frame / fps;
    const { cardIds } = layoutClips(entry.project, clipIds, null, at);
    let baked = false;
    let measured = [];
    // When only querying media clips (or none of the queried clips exist), no browser needs to be
    // opened: their boxes are determined entirely by project data
    if (!cardIds.length) {
      const { stage, clips } = layoutClips(entry.project, clipIds, [], at);
      return { stage, t: at, frame, clips, baked };
    }
    const bakery = await (lease ? lease(entry.project) : this.acquire(lane, entry.project));
    try {
      if (!entry.html?.has?.(frame)) {
        baked = true;
        await bakeFrames(bakery, {
          out: entry.dir, targetFrames: [frame], snapshotOnly: true, writeFrames: false,
          snapshotFrames: new Set([frame]), signal,
          onSnapshot: (n, html, controls) => { if (n === frame) this.record(entry, n, html, controls); },
        });
        await this.save(entry);
      }
      const html = entry.html?.get?.(frame);
      if (typeof html !== 'string' || !html) throw new Error(`Frame ${frame} has no generated snapshot, so the entity box cannot be measured`);
      measured = await captureSnapshot(bakery, html, undefined, {
        screenshot: false,
        afterFonts: page => page.evaluate(ids => {
          const root = document.querySelector('#pc-frame-snapshot [data-pc-scene]');
          if (!root || typeof window.__pcSolid?.rectsWithBounds !== 'function') return [];
          return window.__pcSolid.rectsWithBounds(root, { pixels: 'none', ...(ids ? { clipIds: ids } : null) });
        }, cardIds.length ? cardIds : null),
      }) || [];
    } finally { if (!lease) this.release(lane); }
    const { stage, clips } = layoutClips(entry.project, clipIds, measured, at);
    return { stage, t: at, frame, clips, baked };
  }
  /**
   * D3: Each of the frames rendered by `see_frames` is attached with an entity rectangle
   * (`measureEntityRects`). Returns `Map<frameNumber, rectArray | null>`.
   *
   * Same reasoning as `layoutNow`: pixel hits (MOV / PNG) cannot answer entity boxes, only look at
   * `entry.html`. Frames just rendered by `see_frames` have mostly already been recorded via `record`
   * (the MOV pass records snapshots while pushing), so inject them back directly to measure; missing
   * ones are filled in via a single `bakeFrames` run (only generate snapshots, no PNGs produced).
   * Each frame injects a snapshot only once, with `screenshot: false`, without loading assets.
   * Runs through `runAgentTask` on the same queue in the agent lane (#12).
   */
  async entityRects(project, times, options = {}) {
    return this.runAgentTask(lease => this.entityRectsNow(project, times, options, lease));
  }
  async entityRectsNow(project, times, { signal } = {}, lease = null) {
    const lane = 'agent';
    const entry = await this.entry(project);
    const fps = Number(entry.project.fps) > 0 ? entry.project.fps : 30;
    const max = Math.max(0, Math.floor((Number(entry.project.duration) || 0) * fps) - 1);
    const frames = [...new Set(times.map(t => Math.max(0, Math.min(max, Math.round((Number(t) || 0) * fps)))))].sort((a, b) => a - b);
    const out = new Map();
    if (!frames.length) return out;
    const bakery = await (lease ? lease(entry.project) : this.acquire(lane, entry.project));
    try {
      const missing = frames.filter(frame => !entry.html?.has?.(frame));
      if (missing.length) {
        const wanted = new Set(missing);
        await bakeFrames(bakery, {
          out: entry.dir, targetFrames: missing, snapshotOnly: true, writeFrames: false,
          snapshotFrames: wanted, signal,
          onSnapshot: (n, html, controls) => { if (wanted.has(n) && !entry.html.has(n)) this.record(entry, n, html, controls); },
        });
        await this.save(entry);
      }
      for (const frame of frames) {
        if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
        const html = entry.html?.get?.(frame);
        out.set(frame, typeof html === 'string' && html
          ? (await captureSnapshot(bakery, html, undefined, { screenshot: false, afterFonts: measureEntityRects })) ?? null
          : null);
      }
    } finally { if (!lease) this.release(lane); }
    return out;
  }
  /**
   * Final step of the background pass: rasterize frame by frame by track prefix
   * (`tracks/<prefix>/NNNNNN.png`, cache for `rasterPrefix`), copy the results of the last prefix
   * into `<key>/frames/` (`readFramesCore` compatibility reading and playback warm frames both read it).
   *
   * Legacy full-frame channel Plan B (AGENT-maint-3): previously each prefix also encoded a
   * `preview.mp4` and copied another copy for the whole scene, it has no consumers and is no longer
   * produced; files left behind by older versions are deleted here as well.
   */
  async prerender(entry, bakery, signal) {
    const prefixes = this.prefixes(entry);
    const frames = [...entry.html.keys()].sort((a, b) => a - b);
    for (let i = 0; i < prefixes.length; i++) {
      if (signal.aborted) throw new Error('Cancelled');
      const prefix = prefixes[i];
      const dir = path.join(this.root, 'tracks', prefix.key);
      const final = i === prefixes.length - 1;
      await fs.rm(path.join(dir, 'preview.mp4'), { force: true }).catch(() => {});
      for (const frame of frames) {
        if (signal.aborted) throw new Error('Cancelled');
        await this.rasterPrefix(entry, bakery, frame, i, prefixes);
      }
      if (final) {
        for (const frame of frames) {
          await atomic(path.join(entry.dir, 'frames', `${pad(frame)}.png`), await fs.readFile(path.join(dir, `${pad(frame)}.png`)));
        }
        await fs.rm(path.join(entry.dir, 'preview.mp4'), { force: true }).catch(() => {});
      }
    }
  }
  /** Revoke only speculative B/MOV work; Agent renders keep their own lane. */
  async yieldBackground(owner, ttl = 5000) {
    const already = this.backgroundLeaseUntil > Date.now();
    this.backgroundLeaseVersion = (this.backgroundLeaseVersion || 0) + 1;
    this.backgroundLeaseOwner = owner;
    this.backgroundLeaseUntil = Date.now() + ttl;
    clearTimeout(this.backgroundLeaseTimer);
    this.backgroundLeaseTimer = setTimeout(() => { void this.resumeBackground(owner); }, ttl);
    this.backgroundLeaseTimer.unref?.();
    if (already || this.backgroundYielding) return this.yielding;
    this.backgroundYielding = true;
    this.yielding = (async () => {
      this.pausedPreloads ||= new Map();
      const requiredActive = [...this.generations.values()].some(generation => this.entries.get(generation.key)?.stage === 'required');
      for (const [id, generation] of this.generations) {
        const entry = this.entries.get(generation.key);
        if (entry && entry.status !== 'ready') this.pausedPreloads.set(id, entry);
        // Required work is allowed to finish while playback starts. Direct
        // control/HTML/MOV work observes this abort at its four-frame boundary.
        if (entry?.stage !== 'required') generation.controller.abort();
      }
      const session = this.lanes.get('background');
      if (session && !requiredActive) { clearTimeout(session.timer); this.lanes.delete('background'); await session.bakery.close().catch(() => {}); }
      await Promise.allSettled([...this.entries.values()].map(entry => entry.mov?.suspend()));
      await this.background.catch(() => {});
      await Promise.allSettled([...this.entries.values()].filter(entry => entry.html.size).map(entry => this.save(entry)));
    })().finally(() => { this.backgroundYielding = false; });
    return this.yielding;
  }
  async resumeBackground(owner) {
    if (owner !== this.backgroundLeaseOwner) return;
    const version = this.backgroundLeaseVersion;
    clearTimeout(this.backgroundLeaseTimer);
    await this.yielding?.catch(() => {});
    if (owner !== this.backgroundLeaseOwner || version !== this.backgroundLeaseVersion) return;
    clearTimeout(this.backgroundLeaseTimer); this.backgroundLeaseUntil = 0;
    const paused = [...(this.pausedPreloads?.entries() || [])]; this.pausedPreloads?.clear();
    // Only reschedule the work and reconnect to the original owner: session versions cannot be
    // claimed here (Item 4).
    // If no session stayed on this version during yield (page switched to another version), do not
    // reschedule: the page's next preload will schedule a new one (review #4)
    // During playback yield, the Agent dedicated instance does not accept prerenders
    // (`kickAgentIdle`); once yield ends, it takes them if idle
    this.kickAgentIdle();
    if (!this.closed) for (const [owner, entry] of paused) {
      if (!this.ready.sessionsOn(entry.key).length) continue;
      await this.preload(entry.project, { adopt: false, owner });
    }
  }
  async updatePlayback(project, input, { borrow = async () => false, release = async () => {} } = {}) {
    // `agent` mode does not serve user playback: returns NO_PRERENDER immediately
    if (this.interactive) {
      const refused = modeRefusal(this.mode, 'playback');
      if (refused) throw refused;
    }
    const work = (this.playbackChain || Promise.resolve()).catch(() => {}).then(() => this.updatePlaybackNow(project, input, { borrow, release }));
    this.playbackChain = work;
    return work;
  }
  async updatePlaybackNow(project, input, { borrow, release }) {
    if (this.closed) return { closed: true };
    this.retiredPlaybackOwners ||= new Set();
    if (this.retiredPlaybackOwners.has(input.owner)) return { closed: true };
    const entry = await this.entry(project);
    // A delayed cleanup from a previous project/tab cannot release its successor.
    if (input.close) {
      if (this.playback?.owner === input.owner && input.sequence > this.playback.sequence) {
        this.playback.sequence = input.sequence; await this.stopPlayback();
        this.retiredPlaybackOwners.add(input.owner);
        // Session ended: playback MOV is only for transit, deleted immediately after use (storage plan Part A)
        await this.disposePlaybackMovie(this.playback.entry);
      }
      return { closed: true };
    }
    if (!entry.playbackMovie) entry.playbackMovie = new PlaybackMovStore({ dir: entry.dir, width: project.width, height: project.height,
      fps: project.fps || 30, count: Math.max(1, Math.floor(project.duration * (project.fps || 30))) });
    await entry.playbackMovie.ready;
    if (!this.playback || this.playback.owner !== input.owner || this.playback.entry !== entry) {
      if (this.playback && this.playback.owner !== input.owner) this.retiredPlaybackOwners.add(this.playback.owner);
      const previous = this.playback?.entry;
      await this.stopPlayback();
      // Version switched (another entry): previous version's playback MOV is no longer read, delete it
      if (previous && previous !== entry) await this.disposePlaybackMovie(previous);
      this.playback = new FramePlayback({ entry, movie: entry.playbackMovie,
        render: (times, options) => this.see_frames(entry.project, times, options),
        // Warm frames are verified like see_frames lookups; an empty legacy
        // raster is not trusted and goes back to the render queue instead.
        cached: async frame => await entry.mov.lookup(frame, this.renderSignature(entry, frame, 'playback'))
          || await fs.readFile(path.join(entry.dir, 'frames', pad(frame) + '.png')).then(buf => isFullyTransparentPng(buf) ? null : buf, () => null),
        stop: () => this.stopPlayback(), workers: 2 });
      this.playback.owner = input.owner;
    }
    const playback = this.playback;
    if (!playback.update(input)) return { ...playback.status(), key: entry.key, movie: `/api/frames/${entry.key}/mov/${entry.playbackMovie.name}` };
    if (input.playing) {
      playback.preparing = true;
      playback.release = release;
      // Playback must answer this heartbeat immediately. Yielding a low lane,
      // borrowing a remote slot and adopting its snapshots are background
      // housekeeping, never a prerequisite for the hot two local renderers.
      playback.setWorkers(2); this.userPoolSize = 2; playback.preparing = false;
      void this.yieldBackground(input.owner).catch(() => {});
      void (async () => {
        const wasBorrowed = playback.borrowed;
        const borrowed = await borrow(input.owner);
        if (this.playback !== playback || !playback.playing) { if (borrowed) await release(input.owner); return; }
        playback.borrowed = borrowed;
        playback.setWorkers(borrowed ? 3 : 2); this.userPoolSize = playback.workers;
        if (borrowed && !wasBorrowed) await this.refreshSnapshots(entry);
      })().catch(() => {});
    } else {
      this.userPoolSize = 2;
      for (const session of [...this.userPool].reverse()) if (!session.busy && this.userPool.length > 2) this.dropUserSession(session);
      await this.resumeBackground(input.owner); await release(input.owner);
    }
    return { ...playback.status(), key: entry.key, movie: `/api/frames/${entry.key}/mov/${entry.playbackMovie.name}` };
  }
  /** Close and delete an entry's playback MOV; recreate it next time this version is played (frames backfilled from PNGs cached by MOV). */
  async disposePlaybackMovie(entry) {
    const movie = entry?.playbackMovie;
    if (!movie) return;
    entry.playbackMovie = null;
    await movie.dispose().catch(() => {});
  }
  async stopPlayback() {
    const playback = this.playback;
    if (!playback) return;
    playback.playing = false; playback.cancel();
    this.userPoolSize = 2;
    await this.resumeBackground(playback.owner); await playback.release?.(playback.owner);
    for (const session of [...this.userPool].reverse()) if (!session.busy && this.userPool.length > 2) this.dropUserSession(session);
  }
  async refreshSnapshots(entry) {
    // The separate background process flushes B before acknowledging yield.
    // Adopt those compressed blocks while preserving newer local samples.
    try {
      const archive = await this.loadArchive(entry);
      for (const frame of entry.html.keys()) if (!archive.frames.has(frame)) archive.frames.set(frame, entry.html.get(frame));
      for (const [id, frames] of entry.controls) {
        if (!archive.controls.has(id)) archive.controls.set(id, archive.createControl(id));
        for (const frame of frames.keys()) if (!archive.controls.get(id).has(frame)) archive.controls.get(id).set(frame, frames.get(frame));
      }
      const dispose = entry.disposeArchive;
      entry.html = archive.frames; entry.controls = archive.controls; entry.disposeArchive = archive.dispose;
      entry.createControl = archive.createControl;
      entry.recordVersion = (entry.recordVersion || 0) + 1;
      dispose?.();
    } catch { /* A missing/corrupt disposable archive cannot block playback. */ }
  }
  async close() {
    this.closing ||= this.closeNow();
    return this.closing;
  }
  async closeNow() {
    this.closed = true;
    await this.playbackChain?.catch(() => {});
    await this.stopPlayback();
    clearTimeout(this.backgroundLeaseTimer);
    clearTimeout(this.timer);
    clearTimeout(this.agentGraceTimer);
    for (const timer of this.cardLockTimers ?? []) clearTimeout(timer);
    this.cardLockTimers?.clear();
    this.userGenerationController?.abort();
    this.userGenerationController = null;
    await this.userPrewarm;
    for (const r of this.queue.splice(0)) r.reject(new Error('Renderer closed'));
    for (const generation of this.generations.values()) generation.controller.abort();
    await Promise.allSettled([this.foreground, this.background, ...this.laneChains.values(), this.queueSettled()]);
    await this._streams?.close();
    // C6.4: Push queue stops dispatching new work (unfinished push segments remain in queue file, resumed on next startup)
    if (this.pushQueue) { try { await this.pushQueue.stop?.(); } catch {} }
    // c10a Section 9: Small-size page (browser closes along with the lane)
    this.smallPending = [];
    await this.smallChain?.catch(() => {});
    await Promise.allSettled(this.streamSessions.splice(0).map(session => { clearTimeout(session.idleTimer); return session.bakery?.close(); }));
    await Promise.allSettled([...this.lanes.values()].map(session => { clearTimeout(session.timer); return session.bakery.close(); }));
    this.lanes.clear();
    await Promise.allSettled(this.userPool.map(session => session.bakery.close()));
    this.userPool.length = 0;
    await Promise.allSettled([...this.entries.values()].flatMap(entry => [entry.mov?.close(), this.disposePlaybackMovie(entry), entry.cardCache?.close()]));
    for (const entry of this.entries.values()) entry.disposeArchive?.();
  }
}

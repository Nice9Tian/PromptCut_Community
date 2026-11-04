import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Stage, type StreamPlaneGroup } from "./render/Stage";
import { FrameScene } from "./render/FrameScene";
import { flattenOverlay, type Project } from "./kernel/project";
import { projectCardGraph } from "./kernel/cardGraph.mjs";
import { withMediaRates } from "./kernel/clipTime.mjs";
import { cardsStamp, cardsVersion, getCard, onCardsUpdated, onRuntimeCardsChanged, runtimeCardsGen, setSyncedUserCards, syncedUserCardsGen, cardsRegistryGen } from "./kernel/registry";
import { installStageClock } from "./render/stageClock";
import { cardMountedAt, mountFrameOf } from "./render/frameWindow.mjs";
import { createAnimationPinner } from "./render/pinAnimations";
import { createSnapshot } from "./render/createSnapshot";
import { flatClipOf, isFlatClipId } from "./kernel/cutFlatten.mjs";
import { clipWrapper, hitTest as solidHitTest, rectsWithBounds as solidRectsWithBounds } from "./render/solid";
import { applyProjectPatch, type ProjectPatch } from "./render/changedClips.mjs";
import {
  detectHostCapabilities,
  postStageEvent,
  compressHtml,
  postStageReady,
  serveStageRpc,
  postStageCards,
  type BackJob,
  type BakeFrameReply,
  type PlayReply,
  type ProbeBooleans,
  type RenderReply,
  type SetTimeReply,
  type SnapshotCost,
  type StageRole,
  type StageRpcApi,
} from "./render/stageRpc";
import { PROBE_BOOL_FRAMES, PROBE_BOOL_MS, PROBE_MAX_FRAMES, PROBE_MAX_MS } from "./render/pipelineTuning.mjs";
import { compareSnapshotHtml } from "./render/snapshotCompare.mjs";
import { budgetOf, CATCHUP_STEPS_PER_BEAT, clipWeight, pipelineAt } from "./render/pipelinePlan.mjs";
import { beatAt, createK6State, noteK6Beat, scheduleNextBeat } from "./render/beatLoop.mjs";
import { reviveStagePlan, type StagePlan, type WirePlan } from "./render/wirePlan";
import { ensureProxyStyle, proxyAllowed, proxyOf, resetInk, sampleAll } from "./render/solidMode";
import { PushedStreamSource, StreamPlayer } from "./render/streamPlayer";
import {
  applyPlaceholders, hideAllPlaceholders, localOnlyClipIds, onlineBrowserMode, setPlaceholderViewScale, noteInkBox, removePlaceholderStyle, PLACEHOLDER_SLOT_ATTR, placeholdersEnabled, placeholderWanted,
  resetPlaceholderGeometry, setCatchingUpClips, setOnlineBrowserMode, setPlaceholdersEnabled, keepTopOfGroups, setOverBoxSource, setStreamBoxSource, shownPlaceholders, stageBoxToLocal, shownSince,
  unsupportedHere,
} from "./render/placeholderHost";

/*
 * Online browser mode (product/platforms.md, "Online browser mode"): always on in the online build
 * (`ONLINE`); on desktop it is turned on explicitly by `platform=browser` in the stage address
 * (for screenshots and probes; the editor page's parameter of the same name is forwarded through
 * `stageSrc`). When on, cards this device cannot run (user cards, media effect cards) do not mount
 * their component but get the prerender output pasted instead, and only if nothing can be pasted
 * is an `unsupported` placeholder shown (C10 contract, section 9).
 */
try { setOnlineBrowserMode(ONLINE || new URLSearchParams(location.search).get("platform") === "browser"); } catch { /* No location: export / unit tests */ }
import { PLACEHOLDER_SHOW_DELAY_MS } from "./render/placeholder/contract";
import { measureLocalContentBox, type CanvasPixels } from "./render/contentBox";
import { createGlHost } from "./render/gl/glHost";
import { glPlanes } from "./render/gl/planes";
import { resolveGlRoute } from "./render/costDevice.mjs";
import { themeStyle } from "./themes";
import { ONLINE } from "./online/mode";
import { mediaTierPolicy, setMediaTierPolicy } from "./render/mediaTier";
import { netSpeedState, startNetSpeed } from "./render/netSpeed";
import { cardExecGate as stageExecGate, cardVisualExecAllowed, noteMediaPolicy, subscribeCardExecGate as subscribeStageExecGate } from "./online/isolation/execGate";
import type { StageCardRuntime } from "./online/cardRuntime/stageRuntime";
import type { StageSound } from "./online/cardRuntime/stageSound";
import type { CardBundle } from "./online/cardRuntime/protocol";
import { announceStageIsolation } from "./online/isolation/stageGuard";
import { clampSettleTimeout, runSettle, settleKindOf, type DrawOutcome, type SettleItem, type SettleResult } from "./render/settleFrame";
import { cardCapabilities, clipFrameMode } from "./kernel/frameMode.mjs";
import { resolveFrameSize } from "./kernel/frameSize.mjs";
import { frameWorkStatus, waitForFrameWork } from "./kernel/frameReady";
import { pixelRect, renderSmallWebp, renderSnapshotBitmap } from "./render/bakeSmall";
import "./cards";
import { tr as trText } from "./i18n/index.ts";

/**
 * The render surface (?stage=1). The editor puts it in an iframe and only sends down "which second
 * of the timeline it is now"; the surface renders the picture of that second. It does not play by
 * the wall clock: time is taken over by stageClock, and the card's Motion frame loop and rAF are
 * both advanced explicitly here, so
 *   - dragging the playhead into the middle of a clip = directly produces the picture of that
 *     moment (the entrance animation is not replayed from the start)
 *   - playing = the editor sends a new t every frame, and this advances one frame
 * It is the same approach and the same card code as the export view (?export=1), so what the
 * preview shows = what the export gives.
 *
 * **It talks to the parent page only through postMessage RPC (E0, see render/stageRpc.ts), and
 * time is always in seconds.**
 * The role (`front` / `back`) is runtime state (J4): same code, `front` is the visible player
 * stage, and `back` is the background stage used for probes / catch-up runs. **`id=A` / `id=B` in
 * the query string are only instance names, not roles** (E1); the default role is `front`, and
 * right after the handshake the parent page uses `setRole` to put the two instances in place.
 * `render` and `setTime` with `probe: true` have a **role gate**: if the role is not `back` they
 * reply `{ aborted: true, reason: 'role' }`, and the parent page treats it as an error and does
 * not resend.
 *
 * Two paths:
 *   - `setTime(t)`: sent by the parent page when pausing / dragging. **No remount, no increment of
 *     playToken**: the clock is moved over, React commits, animations are pinned; any dt behaves
 *     the same (the only exception: moving forward by less than half a second, which advances a
 *     few frames synchronously as continuous playback).
 *     After a stateful card is dragged backward / jumps far, its component state is wrong, and
 *     step 4 covers it with the snapshot plane (C3 / C4);
 *     direct cards, the media layer, `data-pc-local-frame` and hit testing all follow it.
 *   - `render(t, { jump })`: only for the background stage (K1 probe): remount, then advance frame
 *     by frame from the mount frame to t; the Promise resolves only after the advance is done; when
 *     cut off by a new render / setProject it replies `superseded` / `project`.
 *
 * `?preview=legacy`: keeps the old path (setProject recomputes this frame immediately by jump), for
 * comparison and fallback.
 */

const isStageRoute = typeof window !== "undefined" && new URLSearchParams(location.search).has("stage");
const LEGACY = typeof window !== "undefined" && new URLSearchParams(location.search).get("preview") === "legacy";
/**
 * Which path the stage content takes (R3). **`?preview=stage` is written into the iframe's src by
 * the parent page** (`stageSrc` in `editor/previewMode.ts`), and is only included when dual stages
 * are really on.
 *
 * Included = render the **live variant** of `FrameScene`: the media layer is in the stage (E7,
 * item 1), and the six plane props take effect.
 * Not included (the default, the editor in users' hands today) = render only `Stage` as before,
 * not a single word changed.
 */
const LIVE = typeof window !== "undefined" && new URLSearchParams(location.search).get("preview") === "stage";

/**
 * When a heavy card is named for suppression and its track stream has not yet drawn the first
 * frame, do not hide its original picture yet; wait at most this long (mechanism/rendering.md,
 * "Fallback order": "on the first beat after playback starts or a jump, do not hide the card's
 * original picture before the stream's first frame is drawn"). If there is still nothing by then,
 * hide it as usual, and this layer falls back to the placeholder.
 * The stream's first frame measured 80-130 ms (fetching the manifest, fetching segments, building
 * the decoder; measured by the prototype `claude/scrub-streams`).
 */
const STREAM_FIRST_WAIT_MS = 500;

/**
 * The K4 beats are scheduled by **absolute time**: `nextDue = playStart + n × 1000 / fps`. Start
 * working once it is `nextDue − this value`: real rAF has the granularity of one vertical sync
 * (16.6 ms at 60 Hz), and being short by this little should not wait a whole extra frame.
 */
const BEAT_SLACK_MS = 1;

/**
 * Fallback for the armed stop (`pause({ atSec })`) (real wall clock, E4b). Normally the armed beat
 * arrives within tens of milliseconds, but if the loop gets stuck for some other reason, the RPC
 * must not never reply: on timeout it replies with "where the loop is stopped right now".
 */
const ARM_TIMEOUT_MS = 5000;

/** Per-clip frame catch-up yields a macrotask every this many steps (E4 calling convention) */
const CATCHUP_YIELD_STEPS = 8;

/** E3: backward re-advance during dragging is throttled to at most once per 100 ms, keeping the previous state in between */
const SCRUB_REPUSH_MS = 100;
// Time must be taken over before any card mounts
const clock = isStageRoute ? installStageClock() : null;
const pinner = createAnimationPinner();

/** If the time difference is below this value (seconds) and moves forward, treat it as continuous playback: only advance, no remount */
const CONTINUOUS_MAX = 0.5;

/** How long to wait after parameter edits stop before recomputing this frame (milliseconds); only used on the legacy path */
const SETTLE_MS = 200;

/** What "this frame looks like" depends only on these; only when they change is a remount and rerun needed, and changing card parameters does not count (legacy path) */
function layoutKeyOf(p: Project): string {
  const clips = flattenOverlay(p).clips.map((c) => `${c.id}:${c.cardId}:${c.start}:${c.end}`).join("|");
  return `${p.width}x${p.height}#${p.themeId}#${clips}`;
}

/** Real wall clock: after the takeover performance.now is stage time, so to measure elapsed time use the copy that stageClock left behind */
const realNow = () => (window.__pcRealNow ?? (() => Date.now()))();
/** The probe only needs to cross one real task boundary to let async DOM updates land; the real rAF of a background iframe may be throttled to once per second. */
const probeTaskBoundary = () => new Promise<void>((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
  channel.port2.postMessage(null);
});
/**
 * Wait for one real frame, but **never wait forever** (used by the K4 beat loop).
 *
 * When a cross-origin iframe is judged "invisible" by the browser (scrolled out of the viewport,
 * fully covered, window moved off screen), rAF is throttled to zero: measured in
 * `editor-preview-smoke --stage`, the visible stage finishes its first beat and then never gets
 * another frame, and the beat loop hangs here forever: `pause()` cannot reply, `play()` cannot
 * wait for the previous round to wrap up, K5's armed stop cannot wait for `frame(T)`, and the
 * whole chain freezes together. The overall rule is "never wait forever", so on timeout we treat
 * this frame as already drawn and the loop carries on as usual (a frame that cannot be rendered in
 * time is an acceptable degradation; a dead loop is not).
 */
const realRafOrAfter = (ms: number) => new Promise<boolean>((resolve) => {
  let done = false;
  const finish = (painted: boolean) => { if (done) return; done = true; resolve(painted); };
  (window.__pcRealRaf ?? window.requestAnimationFrame)(() => finish(true));
  (window.__pcRealSetTimeout ?? window.setTimeout.bind(window))(() => finish(false), ms);
});

/** If this many beats in a row cannot get a real frame, conclude that this iframe is throttled, and stop waiting for it from then on */
const RAF_MISS_GIVEUP = 3;
/** After it is judged throttled, each beat only yields one macrotask nominally (Motion needs a task boundary to parse keyframes) */
const RAF_GIVEUP_MS = 4;
/**
 * **The stage's own wall-clock timers always use the real ones** (E4b). `window.setTimeout` has
 * been replaced by `stageClock` with a fake timer registered on the virtual clock: the virtual
 * clock does not move while paused, so if it were used, the 500 ms fallback of `.pc-awaiting` would
 * never fire and the card would stay invisible forever; the legacy `SETTLE_MS` debounce would
 * likewise never trigger.
 * Virtual timer ids start from 1e9, so after the takeover `clearTimeout` hands real ids back on its
 * own; just use it directly.
 */
const realSetTimeout = (cb: () => void, ms: number): number =>
  (window.__pcRealSetTimeout ?? window.setTimeout.bind(window))(cb, ms);

const isProjectPatch = (v: unknown): v is ProjectPatch =>
  !!v && typeof v === "object" && (((v as ProjectPatch).kind === "full" && "project" in (v as object)) || ((v as ProjectPatch).kind === "tracks" && "order" in (v as object)));

/**
 * The card clips that changed between two projects (compared by object reference: the store updates
 * immutably, and the reference of an untouched clip does not change). Added / deleted ones count
 * as changed too. Only card clips are looked at: media clips are drawn by the video layer and have
 * nothing to do with the stage. (Used by the legacy path)
 */
function changedCardClips(prev: Project | null, next: Project): { id: string; start: number; end: number }[] {
  const before = new Map<string, unknown>();
  if (prev) for (const tr of prev.tracks) for (const c of tr.clips) if (c.cardId) before.set(c.id, c);
  const out: { id: string; start: number; end: number }[] = [];
  const seen = new Set<string>();
  for (const tr of next.tracks) {
    for (const c of tr.clips) {
      if (!c.cardId) continue;
      seen.add(c.id);
      if (before.get(c.id) !== c) out.push({ id: c.id, start: c.start, end: c.end });
    }
  }
  for (const [id, c] of before) if (!seen.has(id)) out.push({ id, start: (c as { start: number }).start, end: (c as { end: number }).end });
  return out;
}

interface PendingRender {
  gen: number;
  startedAt: number;
  frames: () => number;
  resolve: (r: RenderReply) => void;
}

export default function StageView() {
  const [project, setProject] = useState<Project | null>(null);
  const [t, setT] = useState(0);
  const [token, setToken] = useState(1);
  /*
   * Solid mode switch. Only the ?stage=1&proxy=1 path can turn it on (see render/solidMode.ts), and
   * the export page ?export=1 cannot get it: the direction of degradation must be "slow but correct".
   */
  const [proxy, setProxy] = useState(false);
  /** Scene root: the relative div with data-pc-scene. Every query of the solid geometry (solid.ts) starts from it */
  const rootRef = useRef<HTMLDivElement>(null);
  const ref = useRef({
    project: null as Project | null,
    t: 0,
    layoutKey: "",
    settle: 0,
    proxy: false,
    role: "front" as StageRole,
    job: undefined as BackJob | undefined,
    wantedSettle: false,
    /** The K2 dispatch table (already backfilled into a `Set`) + the K1 per-card record. Queries go through `pipelineOf` below */
    plan: null as StagePlan | null,
    /*
     * The sets below are **always replaced as a whole, never mutated in place**: `Stage` relies on "the
     * suppressed set of the last render" to decide "who just entered suppression"; if it is mutated
     * in place, the before and after copies it sees are the same object, and it can never detect a
     * change.
     */
    snapshots: new Map<string, string>() as ReadonlyMap<string, string>,
    /**
     * The suppressed set actually in effect = what the parent page sent (`parentSuppressed`) minus what
     * the single-stage settle catch-up is drawing / has drawn (`settleLive`). Every place that reads
     * suppression (rendering, placeholders, who to skip when pinning animations) reads this one copy;
     * when either of the two sources changes, `applySuppressed` recomputes it.
     */
    suppressed: new Set<string>() as ReadonlySet<string>,
    /** The copy the parent page sent via `setSuppressed` (as is) */
    parentSuppressed: new Set<string>() as ReadonlySet<string>,
    /**
     * Single-stage settle catch-up to the current frame (`settleLayers`, `render/settleFrame.ts`): the
     * layers being drawn and already drawn. They are no longer hidden by the parent page's suppression;
     * cleared by the next `setTime` / `play` / `setRole` (the next playback returns to how it looks
     * during playback). Those that are not drawn (interrupted) are removed from here and go back to
     * suppression (fallback).
     */
    settleLive: new Set<string>() as ReadonlySet<string>,
    /** The result of the last settle catch-up (diagnostics: `__pcStageDiag().lastSettle`) */
    lastSettle: null as SettleResult | null,
    streamPlanes: [] as readonly StreamPlaneGroup[],
    /**
     * For a card that the parent page named for suppression, that has a stream plane attached, but
     * whose stream has not yet drawn the first frame → since when it has been waiting (real
     * milliseconds). During this time **its original picture is not hidden** (hiding it would leave
     * that layer empty); hide it once the stream is drawn (`onShowingChange` of `StreamPlayer`) or
     * `STREAM_FIRST_WAIT_MS` is reached.
     */
    streamWaiting: new Map<string, number>() as ReadonlyMap<string, number>,
    streamWaitTimer: 0,
    /** Cards whose settle catch-up was postponed by the item above: start once the stream's first frame is drawn (or on timeout); until then, what is shown is the picture from the moment before the jump */
    deferredSettle: new Map<string, { target: number; fps: number; gen: number }>(),
    /** Members of a group stream that catch up first: kept in `settling` (invisible, time pinned at the target frame), and revealed together once everything in the same group that is present now has caught up */
    settledHeld: new Set<string>() as ReadonlySet<string>,
    /** Clips whose snapshot for this frame has not arrived yet and are hidden while waiting (`setTime({ awaiting })` of E0) */
    awaiting: new Set<string>() as ReadonlySet<string>,
    /** Clips currently doing frame catch-up with subtree virtual time → their current global stage milliseconds (K5 first path, only filled in R5) */
    settling: new Map<string, number>() as ReadonlyMap<string, number>,
    /** K3: the generation of per-clip remounts (when the table is empty, `Stage` falls back to the whole-stage playToken) */
    remountGen: new Map<string, number>() as ReadonlyMap<string, number>,
    /** Per-clip frame catch-up currently running (K3(a) / K3(b) / K5 first path share one driver) */
    catchUps: new Map<string, { clipId: string; stageMs: number; targetMs: number; stepMs: number; announce: boolean; gen: number }>(),
    /** The previous target frame number of this clip (K3(a′): a smaller target frame = a backward jump, which must first take the remount-and-locate recipe) */
    lastTargetFrame: new Map<string, number>(),
    /** The real time of this clip's previous re-advance (E3: backward re-advance during dragging is throttled to at most once per 100 ms) */
    repushAt: new Map<string, number>(),
    /** The cards active on the previous beat (K3(b): which card the playhead **just entered**) */
    lastActive: new Set<string>() as ReadonlySet<string>,
    scrubbing: false,
    playing: false,
    mediaT: 0,
    localHashes: [] as readonly string[],
    /** Whether the K4 beat loop is stopped (`setRole('back')` / `pause()` must be able to stop it) */
    beatPaused: true,
    /** Whether the loop is really still running (after `pause()` sets `beatPaused`, the current beat still has to finish) */
    beatRunning: false,
    /** The `sec` of the last beat: the `stoppedAt` in the `pause()` reply */
    beatLastSec: 0,
    /** The **frame number** of the last beat (the armed stop compares by it, not by floating point) */
    beatLastFrame: -1,
    /** Armed stop (`pause({ atSec })`): stop once this beat has been posted */
    beatArmed: null as { frame: number; atSec: number; resolve: (r: PlayReply) => void; timer: number } | null,
    /** The `pause()` calls waiting for the loop to stop */
    beatWaiters: [] as ((r: PlayReply) => void)[],
    /** The K6 one-second window: the total time of each beat and the time of each card (all using `__pcRealNow`) */
    k6: createK6State(),
    /** The React render time of each card on this beat (reported by `<Profiler>`, cleared every beat) */
    cardCost: new Map<string, number>(),
    pending: null as PendingRender | null,
  });
  /**
   * Poke it whenever plane state (snapshot / suppression / stream / awaiting / catch-up) changes, so
   * this frame re-renders. The source of truth lives in `ref.current`: RPC methods must be able to
   * read the latest value **synchronously**, which React state cannot do; rendering only needs a
   * "changed" signal, and still reads `ref.current`.
   */
  const [, bumpPlanes] = useReducer((n: number) => n + 1, 0);
  /**
   * The generation of the first-path catch-up (K5): `setRole('back')` and any new `setTime` / `play` /
   * `setProject` all increment it, aborting the subtree catch-up in progress in the visible stage.
   * When R5 fills in the implementation, this place does not need to be touched again.
   */
  const catchUpGen = useRef(0);
  /** The generation of the settle follow-up shot: when another frame is rendered, the follow-up shot left pending last time is invalidated (see the notes on settle) */
  const settleGen = useRef(0);
  /** The render generation: when another render comes in / the project is switched, the async catch-up run still in flight from last time is invalidated; it corresponds one to one with RPC requests */
  const renderGen = useRef(0);
  /**
   * How many times the project has been switched. The two-pass boolean probe branch does not go
   * through `abortPending` (it `return`s on its own, rather than resolving the pending one that is
   * hanging), so something else is needed to tell apart "cut off by `setProject`" from "cut off by a
   * new `render`": their resend rules differ (E0: `'project'` is resent, `'superseded'` is dropped).
   */
  const projectGen = useRef(0);

  /*
   * Card graph (H3): the inputs of media effect cards are resolved here. projectCardGraph throws on a
   * dangling input (deleting a clip does not clean up cardNodes), so wrap it in try: one bad card must
   * not unmount the whole stage. Placed before `if (!project) return null`: hooks cannot be called
   * conditionally.
   */
  /*
   * Card code changed (hot reload is caught in `cards/index.ts`, which reinstalled the whole set of cards,
   * C6.6 integration 3b): this component is not on the hot-reload chain, so it re-renders on this version
   * number, the cards are mounted again with the new definitions, and the card graph is re-resolved with
   * the new definitions too. Project, time and RPC stay untouched.
   */
  const cardsGen = useSyncExternalStore(onCardsUpdated, cardsVersion, cardsVersion);
  // After the re-render for the new cards is committed, tell the parent page which version we switched to
  // (the parent page waits for both stages to report in before scheduling the re-measurement,
  // `editor/stageCards.ts`)
  useEffect(() => {
    if (cardsGen > 0) postStageCards(cardsStamp());
  }, [cardsGen]);
  // The user cards and media effect cards loaded at runtime in the online stage changed
  // (`online/cardRuntime/stageRuntime.ts`): the card graph is re-resolved with the new definitions.
  // In the desktop runtime this number is always 0
  const runtimeGen = useSyncExternalStore(onRuntimeCardsChanged, runtimeCardsGen, runtimeCardsGen);
  const graph = useMemo(() => {
    if (!project) return undefined;
    try {
      // Add the rate to media nodes of speed-change segments (withMediaRates in kernel/clipTime.mjs;
      // unchanged when there are no speed-change segments)
      return withMediaRates(project, projectCardGraph(project, getCard));
    } catch {
      return undefined;
    }
    // cardsGen: card definitions changed, so the graph must be re-resolved; runtimeGen: the cards loaded at
    // runtime in the online stage changed (always 0 on desktop)
  }, [project, cardsGen, runtimeGen]);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.overflow = "hidden";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
  }, []);

  /**
   * Who to skip when pinning animations globally (K5 path 1 / E7 item 5): clips that are doing frame
   * catch-up with subtree virtual time (`.pc-settling`) and clips that are suppressed (`.pc-suppressed`).
   * Their animations must not be set back by the global clock. What is collected is the **wrapper layer**
   * (`[data-pc-clip]`); for each animation, `pinner.sync` looks up the nearest one above the target element.
   */
  const skipWrappers = useCallback((): ReadonlySet<Element> | undefined => {
    const { settling, suppressed } = ref.current;
    if (!settling.size && !suppressed.size) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    const out = new Set<Element>();
    for (const id of [...settling.keys(), ...suppressed]) {
      const el = clipWrapper(root, id);
      if (el) out.add(el);
    }
    return out.size ? out : undefined;
  }, []);

  /**
   * The media layer has drawn a frame (K5 step (4)). **Only `back` reports it**: what the parent page needs
   * is the single fact "the media of the background stage is also in place, so the stages can be swapped".
   * The visible stage gets a new video frame every frame during playback, so reporting each one would mean
   * dozens of postMessage calls per second. The parent page only accepts a `mediaReady` sent by the current
   * `back` according to `event.source`, and here we filter at the source once more.
   */
  const onMediaFrame = useCallback(() => {
    if (ref.current.role !== "back") return;
    postStageEvent({ type: "mediaReady", sec: ref.current.mediaT });
  }, []);

  /**
   * How many milliseconds this card took in this tick (K6). The live path of `FrameScene` wraps every clip
   * in a `<Profiler>`, and the same clip may commit more than once within a tick, so the values are
   * accumulated; they are cleared at the start of each tick.
   */
  const onCardCost = useCallback((clipId: string, ms: number) => {
    const cur = ref.current.cardCost;
    cur.set(clipId, (cur.get(clipId) ?? 0) + ms);
  }, []);

  useEffect(() => {
    if (!clock) return;

    /*
     * Decoding and compositing of track streams (R8 / G5). **Only works in the `front` role**: `setRole('back')`
     * stops it and `close()`s all `VideoFrame`s; `back` does not receive `streamPlanes`, so it builds no
     * decoder and draws nothing (K5). It draws onto the `[data-pc-stream-plane]` / `[data-pc-group-plane]`
     * elements that `Stage` has already rendered.
     */
    /*
     * Where bytes come from: on desktop, a direct connection to the prerender process (the default byte
     * source); the online page has no prerender process, and the manifest and bytes are pushed by the parent
     * page along with the stream plane (reason in `streamPlayer.ts`, "Online page: manifest and bytes are
     * pushed by the parent page"). Here we provide a source that only recognizes pushed chunks; a plane
     * without a manifest (the parent page has not fetched it yet) gets nothing from it, and it never requests
     * a prerender process that does not exist.
     */
    /** Whether the picture of a stream changed (first frame decoded asynchronously, cleared when the time limit passes); implemented below, wired up once all the functions it uses are defined */
    let onStreamShowing: () => void = () => {};
    const player = new StreamPlayer({ root: () => rootRef.current, ...(ONLINE ? { source: new PushedStreamSource() } : {}), onShowingChange: () => onStreamShowing(),
      // The position rectangle of an over-budget layer changed (the manifest arrived, or the playhead entered
      // the next segment): the placeholder geometry is read at render time, so commit once to make it read again
      onBoxChange: () => onStreamBoxes() });
    let onStreamBoxes: () => void = () => {};
    /*
     * The placeholder geometry prefers the rectangle in the stream manifest (mechanism/rendering.md, "Heavy
     * pipeline: prerender"; `geometryFor` of `placeholderHost`). An over-budget layer takes the position
     * rectangle of the segment this frame falls in: for a single-card stream it is the coordinates of the
     * wrapper layer itself, used directly; for a group stream or a stream that depends on lower layers it is
     * in stage coordinates, converted using the wrapper layer position measured on screen (null is returned
     * when conversion is impossible, and positioning falls back to the old way). This rectangle only applies
     * to this frame and is provided separately from the box of an in-budget stream (that kind is recorded
     * for later use, this kind is not recorded).
     */
    setStreamBoxSource((clipId) => player.boxOf(clipId));
    setOverBoxSource((clipId) => {
      const own = player.overBoxOf(clipId);
      if (own) return own;
      const staged = player.stageBoxOf(clipId);
      const wrap = staged ? rootRef.current?.querySelector<HTMLElement>(`[data-pc-clip="${CSS.escape(clipId)}"]`) : null;
      const ref = (wrap?.offsetParent ?? null) as HTMLElement | null;
      if (!staged || !wrap || !ref || !(ref.offsetWidth > 0) || !(wrap.offsetWidth > 0)) return null;
      return stageBoxToLocal(staged, { ref: ref.getBoundingClientRect(), refWidth: ref.offsetWidth, wrap: wrap.getBoundingClientRect(), wrapWidth: wrap.offsetWidth,
        transform: getComputedStyle(wrap).transform });
    });

    /*
     * The shared WebGL renderer for canvas cards (R9 M2). `stageId` is the instance name (`A` / `B`),
     * **independent of the role**: it does not change when the roles are swapped, and the atlas region of this
     * stage in the Worker follows the instance, not the role. The route is first built from the default of the
     * host capability, and once the project arrives it is changed to the effective value of `project.glRoute`
     * (`setProject`). The port for route 2 is handed over by the parent page via `{ type: 'gl-port' }` after
     * the handshake and before any RPC (the listener below).
     */
    const caps = detectHostCapabilities({ online: ONLINE });
    // At the lowest tier (the parent page gives `lowest=1` in src), start by using only small sizes; the base
    // URL and ticket of the remote asset service, the result of the asset gate, etc. are sent down by the
    // parent page via `setMediaPolicy`
    setMediaTierPolicy({ smallOnly: caps.lowest, online: ONLINE });
    /*
     * The main-thread canvas lost its WebGL context: the graphics capability of media effect cards is counted
     * as insufficient because "a context was lost while running" (`cardRuntime`, contract 4.3). It is no longer
     * used to judge the performance of the whole device (the earlier "overall downgrade while running" was
     * revoked by user decision, 2026-10-07), and is only hooked up on the online page. The event does not
     * bubble, so it is caught in the capture phase on document; a context lost by an OffscreenCanvas in the
     * Worker does not come through here (glHost has its own fallback).
     */
    const onContextLost = () => { cardExec.runtime?.noteContextLost(); };
    if (ONLINE) document.addEventListener("webglcontextlost", onContextLost, true);
    /*
     * Network speed of the asset gate (`render/netSpeed.ts`): it watches how fast assets actually download;
     * if slow, it first pulls the small size and then pulls the original size to replace it, and if fast, it
     * pulls only the original size; it can switch at any time during use. Assets are read by this stage
     * itself, so we watch it in the stage and write it into this stage's tier policy; when it switches, the
     * parent page is notified (viewing port). Online page only.
     */
    const stopNetSpeed = ONLINE ? startNetSpeed((st) => {
      setMediaTierPolicy({ smallFirst: st.smallFirst });
      commitPlanes();
      postStageEvent({ type: "net-speed", mbps: st.mbps, samples: st.samples, smallFirst: st.smallFirst });
    }) : () => {};
    /*
     * Execute the user cards and media effect cards synced over (`docs/plan/online-card-exec-contract.md`,
     * sections 2, 3, 4 and 8). The editor page sends the transpiled bundle via `loadUserCards`; here it is
     * executed only when **this document's own execution gate** is open (`online/isolation/execGate.ts`: it is
     * a cross-origin stage entry, the self-check passed, the parent page gave its approval, no ticket has ever
     * been seen, and no hardening block has occurred):
     *   - the visual half also requires that this document's egress is blocked by the browser
     *     (`cardVisualExecAllowed`; [ruling: lead session 2026-10-06] visuals are not executed in a browser
     *     that relies only on script hardening);
     *   - the audio half runs in a background thread started on this machine (the thread is bootstrapped from
     *     a blob URL and inherits this document's policy), and only the one the parent page names (instance B)
     *     starts it.
     * When the gate opens late: the bundle is remembered first and executed once it opens; when the gate
     * closes (a hardening block occurred): everything already loaded is taken down. The loader and the audio
     * host are both loaded on demand, and the whole section is cut out of desktop builds.
     */
    const cardExec: { bundles: CardBundle[] | null; sound: boolean; runtime: StageCardRuntime | null; soundHost: StageSound | null; seq: number; stopped: boolean } =
      { bundles: null, sound: false, runtime: null, soundHost: null, seq: 0, stopped: false };
    const applyCardBundles = async (): Promise<void> => {
      if (import.meta.env.VITE_PC_ONLINE !== "1" || cardExec.stopped) return;
      const seq = ++cardExec.seq;
      const stale = () => seq !== cardExec.seq || cardExec.stopped;
      const bundles = cardExec.bundles;
      if (!stageExecGate().allowed || !bundles) {
        const had = !!cardExec.runtime || !!cardExec.soundHost;
        cardExec.runtime?.dispose(); cardExec.runtime = null;
        cardExec.soundHost?.dispose(); cardExec.soundHost = null;
        if (had) {
          postStageEvent({ type: "card-states", states: [], graph: "unknown", visual: false });
          postStageEvent({ type: "sound-state", state: null });
          commitPlanes();
        }
        return;
      }
      try {
        if (cardVisualExecAllowed()) {
          if (!cardExec.runtime) {
            const m = await import("./online/cardRuntime/stageRuntime");
            if (stale() || !cardVisualExecAllowed()) return;
            cardExec.runtime ??= m.createStageCardRuntime({
              longSide: () => Math.max(ref.current.project?.width ?? 1920, ref.current.project?.height ?? 1080),
              onStates: (states, graph) => {
                postStageEvent({ type: "card-states", states, graph, visual: true });
                // The set of runnable cards changed: re-render once (live components mounted / unmounted, placeholders
                // recomputed)
                commitPlanes();
              },
            });
          }
          await cardExec.runtime.setBundles(bundles);
          if (stale()) return;
        } else {
          cardExec.runtime?.dispose(); cardExec.runtime = null;
          postStageEvent({ type: "card-states", states: [], graph: "unknown", visual: false });
        }
        // With no synced cards, no audio thread is started (and no audio status is reported): when the project
        // has no user cards or media effect cards, this machine is as silent as before
        if (cardExec.sound && (bundles.length > 0 || cardExec.soundHost)) {
          if (!cardExec.soundHost) {
            const [m, sp] = await Promise.all([import("./online/cardRuntime/stageSound"), import("./online/cardRuntime/soundSpawn")]);
            if (stale() || !stageExecGate().allowed) return;
            cardExec.soundHost ??= m.createStageSound({ spawn: sp.spawnSoundWorker, onState: (state) => postStageEvent({ type: "sound-state", state }) });
          }
          await cardExec.soundHost.setBundles(bundles);
        } else if (cardExec.soundHost) {
          cardExec.soundHost.dispose(); cardExec.soundHost = null;
          postStageEvent({ type: "sound-state", state: null });
        }
      } catch (err) {
        console.warn("[stage] error loading synced cards", err);
      }
    };
    const offCardExecGate = ONLINE ? subscribeStageExecGate(() => { void applyCardBundles(); }) : () => {};
    /*
     * On the online page the route is decided by the parent page according to the stage gate (it starts from
     * `gl=` in src, and switches via `setGlRoute` when trying the third tier), not by project options;
     * the desktop runtime still follows the project options (`resolveGlRoute(project.glRoute)` in
     * `setProject`), with route 1 as the default.
     */
    let onlineGlRoute: "perDocument" | "shared" = caps.glRoute ?? "perDocument";
    const gl = createGlHost({ stageId: caps.stageId, compact: caps.compact, route: ONLINE ? onlineGlRoute : resolveGlRoute(null) });
    const onGlPort = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      const d = e.data as { type?: string; port?: MessagePort | null } | null;
      if (d?.type !== "gl-port") return;
      gl.acceptPort(d.port ?? e.ports[0] ?? null);
    };
    window.addEventListener("message", onGlPort);
    /** A strict tick: probes, generate snapshots and the settle catch-up all wait for it (returns `undefined` when there is no gl plane, so as not to cost an extra microtask) */
    const glStrict = (sec: number) => gl.beat({ strict: true, t: sec }) ?? undefined;
    const presentStreams = (sec: number) => {
      // This must also run when there is no stream plane but there are over-budget layers: their position
      // rectangles change with the playhead
      if (ref.current.role !== "front" || (!ref.current.streamPlanes.length && !player.hasOver)) return;
      player.present(sec);
    };

    /*
     * Add one more tick of "settle". **At the moment the synchronous catch-up finishes, Motion has not yet
     * written the new values back to the DOM.**
     *
     * Motion's JS animations (things like transform) are indeed hooked on the rAF that we took over: a manual
     * tick can drive them, and the values they produce are bit-for-bit identical to export. But resolving the
     * keyframes **crosses a task boundary**: in practice, no number of extra ticks within the same JS task
     * helps, while after yielding one microtask a single extra tick is enough. The jump path, however, runs to
     * completion as one synchronous block, so when the catch-up ends the card is still stuck on the initial
     * frame.
     *
     * Measured on frame 9 of chapter-bar: export gives translateY(-8.65515px), preview gives
     * translateY(-120px): the whole entrance bar hangs outside the picture, with no error reported. After
     * adding this tick, both sides are bit-for-bit identical. Export does not need this: every one of its
     * frames is a real browser frame, so the task boundary comes for free.
     *
     * Time does not move (it is still target), so this tick only lets the write-back happen and does not make
     * the animation advance further.
     */
    const settle = (target: number) => {
      const gen = ++settleGen.current;
      queueMicrotask(() => {
        if (gen !== settleGen.current || !clock) return;
        const ms = Math.max(0, target) * 1000;
        clock.tick(ms);
        pinner.sync(ms, skipWrappers());
      });
    };

    /*
     * Sample the ink color once after a real render (the solid mode color blocks need it).
     *
     * "Every real render is a sampling opportunity": the longer it is used, the more accurate solid mode
     * gets: when the user changes the main color or swaps the copy, the blocks follow. During playback it is
     * solid mode and never gets here, so playback is not slowed down. It is debounced because continuously
     * dragging the playhead produces one setTime per frame, while sampling has to walk all the elements of
     * every card and read computed style.
     */
    let sampleTimer = 0;
    let inkTimer = 0;
    /**
     * The second geometry source for the placeholder: the ink box of this card at its last live render
     * (`measureContentBox`, relative to the wrapper layer). It is measured once, debounced, after things stop
     * (not during playback / dragging: that is exactly when the placeholder has to step in, and what would be
     * measured is the fallback picture). Card subtrees that are suppressed / waiting for a snapshot / doing
     * frame catch-up are hidden and skipped. Anything that cannot be measured is not recorded (`noteInkBox`
     * drops null), and the geometry falls back to the badge.
     */
    /** Measure the ink box of every card that is live-rendering right now, on the spot (subtrees that are suppressed / waiting for a snapshot / doing frame catch-up are hidden and skipped) */
    const measureInkBoxesNow = () => {
      const root = rootRef.current;
      if (!root) return;
      const cache = new Map<HTMLCanvasElement, CanvasPixels | null>();
      for (const el of root.querySelectorAll<HTMLElement>("[data-pc-clip]:not([data-pc-media])")) {
        const id = el.getAttribute("data-pc-clip");
        if (!id || el.classList.contains("pc-suppressed") || el.classList.contains("pc-awaiting") || el.classList.contains("pc-settling")) continue;
        noteInkBox(id, measureLocalContentBox(el, cache));
      }
    };
    const scheduleInkBoxes = () => {
      if (!placeholdersEnabled()) return;
      window.clearTimeout(inkTimer);
      inkTimer = realSetTimeout(() => {
        if (ref.current.beatRunning || ref.current.scrubbing || !placeholdersEnabled()) return;
        measureInkBoxesNow();
      }, 300);
    };
    const scheduleSample = () => {
      scheduleInkBoxes();
      if (!proxyAllowed() || ref.current.proxy) return;
      window.clearTimeout(sampleTimer);
      sampleTimer = realSetTimeout(() => {
        const root = rootRef.current;
        if (root && !ref.current.proxy) sampleAll(root);
      }, 120);
    };

    /** The placeholder slot inside the wrapper layer of this card (mounted by `Stage`; null if not mounted) */
    /** Slot reference cache (P4 performance fix): running querySelector every tick is too expensive; if it is still under the original wrapper layer, use it directly */
    const slotCache = new Map<string, HTMLElement>();
    const slotOf = (clipId: string): HTMLElement | null => {
      const hit = slotCache.get(clipId);
      if (hit && hit.isConnected && (hit.parentElement?.getAttribute("data-pc-clip") === clipId || hit.parentElement?.getAttribute("data-pc-flat-clip") === clipId)) return hit;
      // A card inside a cut segment (the virtual clip of `kernel/cutFlatten.mjs`): in a nested scene the
      // wrapper layer carries `data-pc-flat-clip`
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-pc-clip="${CSS.escape(clipId)}"] > [${PLACEHOLDER_SLOT_ATTR}]`)
        ?? rootRef.current?.querySelector<HTMLElement>(`[data-pc-flat-clip="${CSS.escape(clipId)}"] > [${PLACEHOLDER_SLOT_ATTR}]`) ?? null;
      if (el) slotCache.set(clipId, el);
      else slotCache.delete(clipId);
      if (slotCache.size > 512) slotCache.clear();
      return el;
    };
    const NO_CLIPS: ReadonlySet<string> = new Set();
    /**
     * The clips in this project that this device cannot run (user cards and media effect cards in online
     * browser mode; `localOnlyClipIds`). Memoized by the project reference and the generations of the registry
     * and the sync table; when the mode is off (desktop) it is always the empty set, so there is no extra
     * traversal.
     */
    let localOnlyMemo: { project: unknown; reg: number; synced: number; ids: ReadonlySet<string> } | null = null;
    const localOnlyAll = (): ReadonlySet<string> => {
      const p = ref.current.project;
      if (!p) return NO_CLIPS;
      const reg = cardsRegistryGen(), synced = syncedUserCardsGen();
      if (localOnlyMemo && localOnlyMemo.project === p && localOnlyMemo.reg === reg && localOnlyMemo.synced === synced) return localOnlyMemo.ids;
      const ids = localOnlyClipIds(p.tracks.flatMap((tr) => tr.clips as { id: string; cardId?: string }[]));
      localOnlyMemo = { project: p, reg, synced, ids };
      return ids;
    };
    /** The ones present right now (same criterion as `Stage`: includes LEAD) */
    const localOnlyAt = (sec: number): ReadonlySet<string> => {
      const all = localOnlyAll();
      if (!all.size) return NO_CLIPS;
      const out = new Set<string>();
      for (const id of all) {
        const c = clipById(id);
        if (c && cardMountedAt(c, sec)) out.add(id);
      }
      return out;
    };
    /**
     * Switch placeholders according to the state of this tick (product/rendering.md, "Fallback order"; the
     * criteria for T1~T4 are in `placeholderHost.placeholderWanted`). **Only toggles the slot's `hidden`,
     * without going through a React commit**; showing only after a full 120 ms is handled by the CSS of the
     * placeholder component. The "stream is blank this tick" of T1 is read from `player.showingClips()` for
     * the current tick, so call this after `presentStreams` every tick. A card this device cannot run
     * (`localOnlyAt`) shows `unsupported` when it cannot be attached to a snapshot / stream. When there is no
     * late layer and no placeholder on display, not a single DOM query is made.
     */
    const refreshPlaceholders = (): void => {
      if (!placeholdersEnabled()) return;
      const { suppressed, snapshots, awaiting, settling } = ref.current;
      const unsupported = localOnlyAt(ref.current.t);
      if (!suppressed.size && !awaiting.size && !settling.size && !unsupported.size && !shownPlaceholders().size) return;
      const streamShowing = ref.current.streamPlanes.length ? player.showingClips() : NO_CLIPS;
      // While stopped for frame catch-up, the stream plane of this card is still being drawn: it does not count
      // as catching up "invisibly" (T3), and no placeholder is shown
      let settlingBlank = settling;
      if (settling.size && streamShowing.size) settlingBlank = new Map([...settling].filter(([id]) => !streamShowing.has(id)));
      const wanted = placeholderWanted({ suppressed, snapshots, awaiting, settling: settlingBlank, streamShowing, unsupported });
      /*
       * Over-budget group stream: the whole group has just one position rectangle (the union of its members),
       * and the placeholder of every member would be laid over it. Keep only the topmost one among the members
       * that want a placeholder this tick (the last one in painter's order), and do not show the rest. When this
       * group has no position rectangle this frame, do nothing (each is positioned the old way on its own).
       */
      if (wanted.size > 1 && player.hasOver) keepTopOfGroups(wanted, player.overGroups());
      applyPlaceholders(wanted, slotOf);
    };

    /**
     * Per-tick record for the acceptance probe (`scripts/probes/preview-fallback-probe.mjs`): when
     * `window.__pcFallbackTrace` is an array, each tick records which level of the fallback order every
     * suppressed card landed on, and how many milliseconds the main thread worked in this tick. When it is
     * not an array, it does nothing.
     */
    const traceFallback = (sec: number, workMs: number): void => {
      const log = (window as unknown as { __pcFallbackTrace?: unknown[] }).__pcFallbackTrace;
      if (!Array.isArray(log)) return;
      const streams = player.levels();
      const now = realNow();
      const levels: Record<string, string> = {};
      for (const id of ref.current.suppressed) {
        const stream = streams.get(id);
        if (stream) levels[id] = stream;
        else if (ref.current.snapshots.has(id)) levels[id] = "snapshot";
        else if (shownPlaceholders().has(id)) levels[id] = now - (shownSince(id) ?? now) < PLACEHOLDER_SHOW_DELAY_MS ? "placeholder-delay" : "placeholder";
        else levels[id] = "transparent";
      }
      log.push({ sec, workMs, levels, snapshots: ref.current.snapshots.size, planes: ref.current.streamPlanes.length });
      if (log.length > 20000) log.splice(0, log.length - 20000);
    };

    /** The plane state changed: sync one React commit so that this frame already carries the new classes and planes; placeholders switch with the state of this commit */
    const commitPlanes = () => {
      flushSync(() => bumpPlanes());
      refreshPlaceholders();
    };
    onStreamBoxes = () => { if (ref.current.role === "front") commitPlanes(); };

    /** Cut off the render still in flight: the reply is given by reason, and silently dropping it is not allowed */
    const abortPending = (reason: "superseded" | "project") => {
      const p = ref.current.pending;
      if (!p) return;
      ref.current.pending = null;
      p.resolve({ aborted: true, reason, elapsedMs: realNow() - p.startedAt, frames: p.frames() });
    };

    /**
     * The earliest mount frame (in seconds) among the currently active cards.
     *
     * **The mount time must land on the frame grid**: otherwise "what you see in preview = what you get in
     * export" breaks once at every card entry point.
     *
     * Export advances frame by frame: a card mounts on the first **frame** >= start-LEAD, and the time origin
     * is that frame, not start-LEAD itself. The mount frame is given uniformly by mountFrameOf in
     * frameWindow.mjs (the same formula for preview, export and sharding). Clamp it: when target itself is
     * not on the frame grid, the aligned value may overshoot it.
     */
    const mountSecOf = (target: number, fps: number): number => {
      const p = ref.current.project;
      const active = p ? flattenOverlay(p).clips.filter((c) => cardMountedAt(c, target)) : [];
      return active.length
        ? Math.min(Math.min(...active.map((c) => mountFrameOf(c, fps))) / fps, Math.max(0, target))
        : Math.max(0, target);
    };

    /**
     * Remount positioning: remount all currently active cards, set the clock to the earliest mount frame among
     * them, and idle-run two ticks. Returns the second from which to advance. Used by render(jump); the legacy
     * setProject also goes through it.
     */
    const remountAt = (target: number, fps: number): number => {
      const from = mountSecOf(target, fps);
      pinner.reset();
      clock.set(from * 1000);
      flushSync(() => {
        setToken((n) => n + 1);
        setT(from);
      });
      /*
       * **Idle-running two ticks at the moment `from` is not a typo.**
       *
       * The first tick runs the rAF callbacks the cards registered themselves: only there are the animations
       * built (the useSpring of the number roll calls .set() in this tick). Motion makes its first advance only
       * on the **next tick** after building an animation, so if only one tick is run, the first step of the
       * catch-up is taken as the animation's starting line, and the whole animation ends up one frame slower
       * than export.
       *
       * Export gets this for free: in the warm-up phase it first idle-runs one frame at the mount point (the
       * step(0) right after __pcRestartCards in warmUp), so by the time the real frame 0 is rendered the
       * animation is already loaded and ready. Adding the same tick here makes the starting lines on both sides
       * match. The two ticks are at the same moment, with delta 0, so the animation does not advance further:
       * it only separates "build" from "advance".
       */
      clock.tick(from * 1000);
      clock.tick(from * 1000);
      pinner.sync(from * 1000, skipWrappers());
      return from;
    };

    /**
     * Jump rendering for the legacy path (?preview=legacy): remount + asynchronous frame-by-frame catch-up to
     * target, with no reply. Same as renderAt before step 3; the new path does not use it.
     */
    const legacyJump = (target: number) => {
      const p = ref.current.project;
      if (!p) return;
      const fps = Math.max(1, p.fps || 30);
      remountAt(target, fps);
      const gen = ++renderGen.current;
      void (async () => {
        await clock.advanceToAsync(Math.max(0, target) * 1000, {
          step: 1000 / fps,
          abort: () => gen !== renderGen.current,
          onFrame: (ms) => flushSync(() => setT(ms / 1000)),
          afterFrame: (ms) => pinner.sync(ms, skipWrappers()),
        });
        if (gen !== renderGen.current) return;
        flushSync(() => setT(target));
        clock.tick(Math.max(0, target) * 1000);
        pinner.sync(Math.max(0, target) * 1000, skipWrappers());
        settle(target);
        scheduleSample();
      })();
    };

    /* ------------------------------------------ K3 / K5 path 1: per-clip subtree virtual-time frame catch-up */

    /** This clip in the project (in point, out point) */
    const clipById = (clipId: string): { id: string; start: number; end: number } | null => {
      const p = ref.current.project;
      if (!p) return null;
      for (const tr of p.tracks) for (const c of tr.clips) if (c.id === clipId) return c;
      return null;
    };

    /** The wrapper layer of this card (the `[data-pc-clip]` mounted by `Stage`) */
    const wrapOf = (clipId: string): Element | null => {
      const root = rootRef.current;
      return root ? clipWrapper(root, clipId) : null;
    };

    /**
     * The effective suppressed set = the one sent by the parent page, minus those that the single stage is
     * drawing / has already drawn with a stop-and-catch-up frame (`settleLive`), minus those whose stream has
     * not yet drawn its first frame and are not hidden for now (`streamWaiting`). It only changes
     * `ref.current` and does not commit; the commit the caller makes right afterwards (`commitPlanes` /
     * `flushSync`) takes effect together. The whole set is replaced with a new one (`Stage` compares by
     * reference).
     */
    const applySuppressed = (): void => {
      const parent = ref.current.parentSuppressed;
      const live = ref.current.settleLive;
      const waiting = ref.current.streamWaiting;
      ref.current.suppressed = live.size || waiting.size ? new Set([...parent].filter((id) => !live.has(id) && !waiting.has(id))) : parent;
    };

    /* ------------------------------------------ Heavy card attached to a track stream: wait for the first frame, lift suppression after catching up */

    /** The stream plane this card currently has mounted (its own single-card stream, or the group stream it belongs to); null if none */
    const planeOf = (clipId: string): StreamPlaneGroup | null => {
      for (const g of ref.current.streamPlanes) if (g.clipIds.includes(clipId)) return g;
      return null;
    };
    /** Replace `streamWaiting` (the whole set), and schedule a real timer by the earliest deadline: even if a stream never gets drawn, the original picture must not stay exposed forever */
    const setStreamWaiting = (next: ReadonlyMap<string, number>): void => {
      ref.current.streamWaiting = next;
      window.clearTimeout(ref.current.streamWaitTimer);
      ref.current.streamWaitTimer = 0;
      if (!next.size) return;
      const earliest = Math.min(...next.values());
      ref.current.streamWaitTimer = realSetTimeout(() => {
        ref.current.streamWaitTimer = 0;
        const now = realNow();
        // The time limit passed and the stream still has no picture: hide it as the parent page said, and this
        // layer falls to the placeholder (the end of the fallback order)
        endStreamWaiting([...ref.current.streamWaiting].filter(([, since]) => now - since >= STREAM_FIRST_WAIT_MS - 1).map(([id]) => id));
        if (ref.current.streamWaiting.size) setStreamWaiting(ref.current.streamWaiting);
      }, Math.max(1, earliest + STREAM_FIRST_WAIT_MS - realNow()));
    };
    /**
     * These cards no longer wait for the first frame of the stream (the stream was drawn, time ran out, or the
     * stream plane was removed): now really hide them (the ones the parent page still names), and in the same
     * commit the picture switches from the original to the stream. The stop-and-catch-up that was postponed
     * (`deferredSettle`) starts at this point.
     */
    const endStreamWaiting = (ids: readonly string[]): void => {
      const rest = new Map(ref.current.streamWaiting);
      let changed = false;
      for (const id of ids) if (rest.delete(id)) changed = true;
      if (!changed) return;
      setStreamWaiting(rest);
      applySuppressed();
      commitPlanes();
      let started = false;
      for (const id of ids) {
        const d = ref.current.deferredSettle.get(id);
        if (!d) continue;
        ref.current.deferredSettle.delete(id);
        if (d.gen !== catchUpGen.current || !ref.current.parentSuppressed.has(id)) continue;
        const task = startCatchUp(id, d.target * 1000, d.fps, true);
        if (task) { started = true; void runCatchUpAsync(task); }
      }
      // The start of the catch-up remounted the wrapper layer, and the stream's canvas was replaced: redraw the
      // picture on the spot (`redraw` of `streamPlayer`)
      if (started) { presentStreams(ref.current.t); refreshPlaceholders(); }
    };
    /** These cards are no longer suppressed (the stage lifts it itself: they caught up to the exact live render). Only changes `ref.current`; the caller commits */
    const unsuppress = (ids: readonly string[]): void => {
      const parent = new Set(ref.current.parentSuppressed);
      let changed = false;
      for (const id of ids) if (parent.delete(id)) changed = true;
      if (changed) ref.current.parentSuppressed = parent;
      if (ids.some((id) => ref.current.streamWaiting.has(id))) {
        const rest = new Map(ref.current.streamWaiting);
        for (const id of ids) rest.delete(id);
        setStreamWaiting(rest);
      }
      applySuppressed();
    };
    /**
     * This card caught up to the exact live render: its suppression is lifted by the stage itself, in the same
     * commit that removes `.pc-settling` (if it waited for the parent page to lift it after receiving
     * `settled`, then during the round trip in between it would first fall back to `.pc-suppressed`, the
     * subtree would have no layout box, and the state just caught up would be wasted). The stream plane is not
     * removed: the stream plane of a card that is not suppressed is hidden (`Stage`), and keeping it lets the
     * frame under the playhead be decoded first, so it is ready the moment the playhead is pressed down; the
     * parent page keeps sending it as before. Returns the cards that should report `settled` this time.
     *
     * **A group stream is lifted as a whole group**: the appearance of the cards in the group is drawn in the
     * same stream, so lifting just one is not allowed. A member that catches up first stays in the
     * `.pc-settling` state (invisible, has a layout box, time pinned to the target frame), and when everyone
     * in the group present right now has caught up, they are revealed together and report together. Layers
     * that were drawn with a single-stage stop-and-catch-up frame are managed separately by `settleLive`, and
     * the parent page's copy is left untouched.
     */
    const releaseSettled = (clipId: string, targetMs: number): string[] => {
      if (ref.current.settleLive.has(clipId) || !ref.current.parentSuppressed.has(clipId)) return [clipId];
      const plane = planeOf(clipId);
      if (plane && plane.clipIds.length > 1) {
        const held = new Set(ref.current.settledHeld);
        held.add(clipId);
        const active = new Set(cardClipsAt(ref.current.t).map((c) => c.id));
        const members = plane.clipIds.filter((id) => active.has(id));
        if (!members.every((id) => held.has(id))) {
          ref.current.settledHeld = held;
          setSettlingAt(clipId, targetMs);
          return [];
        }
        for (const id of members) { held.delete(id); setSettlingAt(id, null); }
        ref.current.settledHeld = held;
        unsuppress(members);
        return members;
      }
      unsuppress([clipId]);
      return [clipId];
    };
    onStreamShowing = () => {
      if (ref.current.role !== "front") return;
      // Among the waiting cards, the ones whose stream has been drawn: now really hide the original picture
      // (swap to the stream in the same task, with no gap in between)
      if (ref.current.streamWaiting.size) {
        const showing = player.showingClips();
        const done = [...ref.current.streamWaiting.keys()].filter((id) => showing.has(id));
        if (done.length) { endStreamWaiting(done); return; }
      }
      // The picture changed, and the placeholder switches with it: while paused there is no next tick to
      // refresh it (frames are decoded asynchronously)
      refreshPlaceholders();
    };
    const setSettleLive = (next: ReadonlySet<string>): void => {
      ref.current.settleLive = next;
      applySuppressed();
    };
    /** On the next jump / playback / switch to background: all layers drawn with a stop-and-catch-up frame go back to the parent page's suppression (attached to the prerender output). Returns whether anything changed */
    const clearSettleLive = (): boolean => {
      if (!ref.current.settleLive.size) return false;
      setSettleLive(new Set());
      return true;
    };

    /** `settling` means the whole set is swapped for a new one (`Stage` judges "who just changed" by reference) */
    const setSettlingAt = (clipId: string, stageMs: number | null): void => {
      const next = new Map(ref.current.settling);
      if (stageMs === null) next.delete(clipId);
      else next.set(clipId, stageMs);
      ref.current.settling = next;
    };

    /**
     * **Remount-and-pin recipe**, per clip (K3; K3(a') backward jumps, K3(a) re-stepping and the start of
     * K5 path one all use it). Not a single step may be skipped:
     *
     *   `resetIn(wrapper)` → remount (`remountGen` increments) + `flushSync`
     *   → `clock.tick(clock.now())` **twice** → `pinner.syncIn(wrapper, mountMs)`
     *
     * `tick` gets the **current global milliseconds**, not `mountMs`: `tick(ms)` sets `now = ms` first and
     * then drains the rAF queue. Passing `mountMs` would wind the visible stage's global clock back to the
     * mount frame, nobody restores it after settle ends, and the first beat of the next `play` would have
     * to catch up 6000 ms synchronously. With the current value the clock does not move, the queue is
     * only drained: the first beat runs the rAFs the card registered itself to build the animation, and
     * the second beat lets Motion make its first advance.
     *
     * Finally pin the **mount frame** anchor once: `patchAnimate` makes a new animation `pause()` and set
     * `currentTime = 0` as soon as it is born. Without this anchor, the target milliseconds would be
     * recorded and the picture would stop at frame 0.
     *
     * **The recipe ends at pinning the mount frame anchor**; what happens afterwards is up to the caller.
     */
    const remountClipRecipe = (clipId: string, mountMs: number): Element | null => {
      const before = wrapOf(clipId);
      if (before) pinner.resetIn(before);
      // This time the component must render at the **mount frame** (`localTOf` in `Stage` reads `settling`), so write the table first, then commit
      setSettlingAt(clipId, mountMs);
      const next = new Map(ref.current.remountGen);
      next.set(clipId, (next.get(clipId) ?? 0) + 1);
      ref.current.remountGen = next;
      flushSync(() => bumpPlanes());
      clock.tick(clock.now());
      clock.tick(clock.now());
      const after = wrapOf(clipId);
      if (after) pinner.syncIn(after, mountMs);
      return after;
    };

    /** A per-clip frame catch-up */
    interface CatchUpTask {
      clipId: string;
      /** Global stage milliseconds already stepped to */
      stageMs: number;
      targetMs: number;
      stepMs: number;
      /** After catching up, post `{ type: 'settled', clipIds: [clipId] }` (needed for K5 path one / heavy cards) */
      announce: boolean;
      gen: number;
      /** The canvas card has caught up and is waiting for this beat's `done` (R9 M3): until then, do not remove `.pc-settling` */
      finishing?: boolean;
      /** Called on wrap-up (single stage stops to catch up one frame: layers that did not catch up go back to suppression in the same commit) */
      onEnd?: (caughtUp: boolean) => void;
    }

    /** Frame catch-up aborted / finished: remove `.pc-settling` */
    const endCatchUp = (task: CatchUpTask, caughtUp: boolean): void => {
      // First let the caller update the suppression set (`settleLive`), in the same commit as removing `.pc-settling`: layers that did not catch up never expose a frame of the stale live component
      const onEnd = task.onEnd;
      task.onEnd = undefined;
      try { onEnd?.(caughtUp); } catch { /* An error in the wrap-up callback does not affect the wrap-up */ }
      task.finishing = false;
      /*
       * This frame catch-up has already wrapped up, or was superseded by a later one for the same card:
       * do not touch that table entry or `.pc-settling` again.
       * Two consecutive "stops" lead here (right after a pause the parent page often sends two `setTime`
       * calls with settle within a millisecond or two): the earlier loop was wrapped up by
       * `abortCatchUps`, and when the macrotask it yielded wakes up and finds the generation changed, it
       * wraps up again. Before, that removed the later one's table entry and `.pc-settling` together, so
       * that card's subtree dropped its layout box for a beat (back to `display: none` of
       * `.pc-suppressed`), the CSS animation was cancelled and restarted from that step, and the picture
       * shown after catching up lagged several frames (step 3 of `scrub-stream-probe` measured a lag of
       * 10 frames).
       */
      if (ref.current.catchUps.get(task.clipId) !== task) return;
      ref.current.catchUps.delete(task.clipId);
      setSettlingAt(task.clipId, null);
      let announce: string[] = [];
      if (caughtUp && task.announce) {
        // Cards attached to a stream: the stage itself also lifts suppression (group streams wait for the whole group), in the same commit
        announce = releaseSettled(task.clipId, task.targetMs);
      }
      commitPlanes();
      if (announce.length) postStageEvent({ type: "settled", sec: ref.current.t, clipIds: announce });
    };

    /**
     * Step forward a few steps. **Only advances the local time of its subtree**: each step does
     * `stageMs += 1000 / fps`, `pinner.syncIn(wrapper, stageMs)`, gives that component
     * `t = stageMs / 1000` (the `settling` table) and `flushSync`.
     * **The global clock does not move**; the global `pinner.sync(nowMs, skip)` skips `.pc-settling`
     * subtrees (`skipWrappers`).
     *
     * Returns `true` when caught up (or aborted); the caller should wrap up.
     */
    const advanceCatchUp = (task: CatchUpTask, steps: number): boolean => {
      if (task.gen !== catchUpGen.current) {
        endCatchUp(task, false);
        return true;
      }
      if (task.finishing) return true;
      const wrap = wrapOf(task.clipId);
      for (let i = 0; i < steps && task.stageMs < task.targetMs; i++) {
        task.stageMs = Math.min(task.targetMs, task.stageMs + task.stepMs);
        if (wrap) pinner.syncIn(wrap, task.stageMs);
        setSettlingAt(task.clipId, task.stageMs);
        flushSync(() => bumpPlanes());
      }
      if (task.stageMs < task.targetMs) return false;
      /*
       * At the target step: the anchor is already on the global base, so handing back to the global
       * `pinner.sync` is naturally continuous and needs no extra action: once `.pc-settling` is removed,
       * it is exactly the live component.
       *
       * **A canvas card must first wait for this beat's `done`** (R9 M3): intermediate catch-up steps send
       * no `beat` (they are hidden by `.pc-settling`); the step that catches up sends one beat, waits for
       * the bitmap to be applied, and only then removes `.pc-settling`. Otherwise the stale bitmap of the
       * previous beat gets exposed.
       */
      if (glPlanes.has(task.clipId)) {
        const pending = gl.beat({ strict: true, t: task.targetMs / 1000 });
        if (pending) {
          task.finishing = true;
          void pending.then(() => {
            if (!task.finishing || ref.current.catchUps.get(task.clipId) !== task) return;
            if (task.gen !== catchUpGen.current) { endCatchUp(task, false); return; }
            endCatchUp(task, true);
          });
          return true;
        }
      }
      endCatchUp(task, true);
      return true;
    };

    /**
     * Step all the way through, **yielding a macrotask every 8 steps** (E4; the yield point checks
     * `catchUpGen`). Used by K3(b) jumps / drags and the paused-state frame catch-up of K5 path one.
     */
    const runCatchUpAsync = async (task: CatchUpTask): Promise<void> => {
      const breathe = () => new Promise<void>((r) => realSetTimeout(r, 0));
      for (;;) {
        if (advanceCatchUp(task, CATCHUP_YIELD_STEPS)) return;
        await breathe();
      }
    };

    /**
     * Step everything within one beat (K3(a)): between frames yield **only microtasks**, never
     * macrotasks. The browser does not paint between microtasks, so no intermediate state can be drawn.
     * `catchUpMs` is an estimate, so this comes with a **wall-clock fallback**: if the accumulated time
     * exceeds `1000 / fps` before finishing, switch to (b) (K3: do not let a misestimated card hog the
     * main thread for long).
     */
    const runCatchUpSync = async (task: CatchUpTask, budgetMs: number): Promise<void> => {
      const started = realNow();
      for (;;) {
        if (advanceCatchUp(task, 1)) return;
        if (realNow() - started > budgetMs) {
          // Switch to (b): the remaining steps yield a macrotask every 8 steps, and the picture stays hidden by `.pc-settling`
          void runCatchUpAsync(task);
          return;
        }
        await Promise.resolve();
      }
    };

    /** Register a frame catch-up task: run the remount-and-pin recipe first, then step from the mount frame */
    const startCatchUp = (clipId: string, targetMs: number, fps: number, announce: boolean): CatchUpTask | null => {
      const clip = clipById(clipId);
      if (!clip) return null;
      const mountMs = (mountFrameOf(clip, fps) / fps) * 1000;
      if (mountMs >= targetMs) return null;
      const old = ref.current.catchUps.get(clipId);
      if (old) endCatchUp(old, false);
      remountClipRecipe(clipId, mountMs);
      const task: CatchUpTask = { clipId, stageMs: mountMs, targetMs, stepMs: 1000 / fps, announce, gen: catchUpGen.current };
      ref.current.catchUps.set(clipId, task);
      return task;
    };

    /**
     * One layer of the single-stage stop-and-catch-up-a-frame (`render/settleFrame.ts`): release it from
     * suppression and draw it invisibly under `.pc-settling` up to `targetMs` (direct pinning is done in
     * one step, frame-stepping cards step frame by frame from the entry point), and once drawn, remove
     * the fallback (`endCatchUp(true)`: post `settled`).
     * While drawing, the fallback is still displayed as usual (governed by T3 of the placeholder).
     * Without a time limit, `deadline` is `Infinity`; with a time limit (tests, diagnostics), if it is
     * not drawn by then: this layer goes back to suppression (showing the prerender output or the
     * placeholder) until the next stop.
     */
    const drawSettleLayer = async (item: SettleItem, deadline: number, targetMs: number, fps: number): Promise<DrawOutcome> => {
      const { clipId } = item;
      const gen = catchUpGen.current;
      let ended: boolean | null = null;
      let timedOut = false;
      const onEnd = (caughtUp: boolean) => {
        ended = caughtUp;
        // Layers not drawn (time limit reached / interrupted) return to the parent page's suppression; drawn ones stay in settleLive until the next jump or playback
        if (!caughtUp && ref.current.settleLive.has(clipId)) {
          const rest = new Set(ref.current.settleLive);
          rest.delete(clipId);
          setSettleLive(rest);
        }
      };
      setSettleLive(new Set([...ref.current.settleLive, clipId]));
      let task: CatchUpTask | null = null;
      if (item.kind === "catchup") {
        // Frame-stepping card: remount-and-pin recipe + step frame by frame from the entry point (same as K5 path one), yielding a macrotask every 8 steps
        task = startCatchUp(clipId, targetMs, fps, true);
      }
      if (!task) {
        // Direct pinning: pin invisibly to the target, drawn in a single commit
        const old = ref.current.catchUps.get(clipId);
        if (old) endCatchUp(old, false);
        setSettlingAt(clipId, targetMs);
        flushSync(() => bumpPlanes());
        const wrap = wrapOf(clipId);
        if (wrap) pinner.syncIn(wrap, targetMs);
        task = { clipId, stageMs: targetMs, targetMs, stepMs: 1000 / fps, announce: true, gen };
        ref.current.catchUps.set(clipId, task);
      }
      task.onEnd = onEnd;
      // While drawing, the fallback is still displayed as usual: while paused there is no next beat to refresh the placeholder, so refresh it once here (T3: layers that catch up invisibly and have
      // no snapshot or stream drawing show the placeholder; "after stopping, show the placeholder first ... replace layer by layer as each is rendered", the lowest tier in `product/platforms.md`)
      refreshPlaceholders();
      const breathe = () => new Promise<void>((r) => realSetTimeout(r, 0));
      for (;;) {
        if (ended !== null) return ended ? "drawn" : timedOut ? "timeout" : "aborted";
        if (task.gen !== catchUpGen.current) { endCatchUp(task, false); continue; }
        if (realNow() >= deadline) {
          timedOut = true;
          endCatchUp(task, false);
          continue;
        }
        // At the catch-up step the canvas card must wait for this beat's `done` (`finishing`); while waiting, still check the time limit
        advanceCatchUp(task, CATCHUP_YIELD_STEPS);
        if (ended !== null) continue;
        await breathe();
      }
    };

    /** Abort everything (a new `setTime` / `play` / `setProject` / `setRole` / `setSuppressed` all go through it) */
    const abortCatchUps = (): void => {
      // Those pushed back and not yet started, and those in a group stream that caught up first and wait for their group, are all voided (the latter go back to suppression: the stream is still attached)
      ref.current.deferredSettle.clear();
      if (ref.current.settledHeld.size) {
        for (const id of ref.current.settledHeld) setSettlingAt(id, null);
        ref.current.settledHeld = new Set();
        if (!ref.current.catchUps.size) commitPlanes();
      }
      if (!ref.current.catchUps.size) return;
      for (const task of [...ref.current.catchUps.values()]) endCatchUp(task, false);
    };

    /**
     * K4 steps a few extra steps per beat (playing-state frame catch-up of K3(b)): besides that beat's
     * own frame, at most `CATCHUP_STEPS_PER_BEAT` more steps of local time per beat (i.e. up to 5x
     * speed). The catch-up cost of each beat is counted in K6's one-second window by measurement: if
     * catch-up blows the window, K6 downgrades the most expensive card.
     */
    const stepCatchUps = (fps: number): void => {
      if (!ref.current.catchUps.size) return;
      const nowMs = ref.current.t * 1000;
      for (const task of [...ref.current.catchUps.values()]) {
        // During playback the target follows the playhead: otherwise it would already be behind at the moment of catching up
        task.targetMs = Math.max(task.targetMs, nowMs);
        task.stepMs = 1000 / fps;
        advanceCatchUp(task, CATCHUP_STEPS_PER_BEAT);
      }
    };

    /* ------------------------------------------------ K3: three jump paths */

    /** **Card** clips active at this moment (same scope as `Stage`: includes LEAD) */
    const cardClipsAt = (sec: number): { id: string; start: number; end: number }[] => {
      const p = ref.current.project;
      if (!p) return [];
      return flattenOverlay(p).clips
        .filter((c) => (c as { cardId?: string; nodeId?: string }).cardId || (c as { nodeId?: string }).nodeId)
        .filter((c) => cardMountedAt(c, sec));
    };

    const mountMsOf = (clip: { start: number; end: number }, fps: number): number => (mountFrameOf(clip, fps) / fps) * 1000;

    /**
     * Which tier this card takes: uses K2's `clipWeight`, **the same pure function as the parent page
     * and the prerender process** (`tuning` comes down together with `setPlan`, so the coefficients on
     * both sides match).
     * `tier`: `direct` / `seek`(a') / `catchup-a`(a) / `catchup-b`(b) / `capped` / `over-catchup` /
     * declared fallback.
     */
    const tierOf = (clipId: string, fps: number) => {
      const sp = ref.current.plan;
      const record = sp?.byClip.get(clipId);
      return { tier: clipWeight(record, sp?.frameModes.get(clipId), fps, sp?.tuning).tier as string, record };
    };

    /** Throttle for backward re-stepping while dragging (E3): a card stepped just now keeps its previous state */
    const repushAllowed = (clipId: string, now: number): boolean => {
      if (!ref.current.scrubbing) return true;
      const last = ref.current.repushAt.get(clipId);
      if (last !== undefined && now - last < SCRUB_REPUSH_MS) return false;
      ref.current.repushAt.set(clipId, now);
      return true;
    };

    /**
     * Start of K5 path one: after `setTime(t, { settle: true })`, **heavy cards** with `vtOk` catch up to
     * the exact live render in the visible stage using subtree virtual time. Cards with `vtOk = false`
     * take path two via the parent page (the whole scene is run in the background, then swapped), and
     * the stage does nothing here.
     */
    const routeSettle = (target: number, fps: number, onlySuppressed = false): void => {
      const plan = ref.current.plan?.plan ?? null;
      const localOnly = localOnlyAll();
      const immediateSettled: string[] = [];
      const targetMs = target * 1000;
      for (const clip of cardClipsAt(target)) {
        if (onlySuppressed && (!ref.current.suppressed.has(clip.id) || ref.current.catchUps.has(clip.id))) continue;
        if (pipelineAt(plan, clip.id, target) !== "heavy") continue;
        // A card this device cannot run does not catch up on stop (no component to catch up); the snapshot stays attached
        if (localOnly.has(clip.id)) continue;
        const { record } = tierOf(clip.id, fps);
        if (record?.vtOk !== true) continue;
        // Its stream has not drawn the first frame and the old picture is still showing: once catch-up starts the subtree becomes invisible, so wait for the stream's first frame to be drawn (or the time limit) and then catch up (`endStreamWaiting`)
        if (ref.current.streamWaiting.has(clip.id)) {
          ref.current.deferredSettle.set(clip.id, { target, fps, gen: catchUpGen.current });
          continue;
        }
        const mountMs = mountMsOf(clip, fps);
        if (mountMs >= targetMs) {
          // Stopped on the mount frame (e.g. t = 0 or a clip's start): this moment is already the exact initial frame, so no catch-up is needed; lift suppression immediately and report settled
          const announced = releaseSettled(clip.id, targetMs);
          immediateSettled.push(...announced);
          continue;
        }
        const task = startCatchUp(clip.id, targetMs, fps, true);
        if (task) void runCatchUpAsync(task);
      }
      if (immediateSettled.length) {
        commitPlanes();
        postStageEvent({ type: "settled", sec: target, clipIds: [...new Set(immediateSettled)] });
      }
    };

    /**
     * K3's three jump paths (the far-jump / backward branch; the continuous path for forward jumps with
     * `dt < CONTINUOUS_MAX` has already been completed by the global `advanceTo` inside `setTime`).
     * **The stepping process is never visible in the visible stage.**
     *
     * - **(a') `seekOk` and `seekMs ≤ B`**: pin directly. Forward needs nothing (the global
     *   `pinner.sync` has already pinned); **backward** must first run the remount-and-pin recipe:
     *   animations past the end were collected by `finish()` and are skipped forever after, so without
     *   a remount it would stay at the final state.
     * - **(a) `catchUpMs ≤ B`**: remount per clip + step frame by frame from `mountFrameOf`, between
     *   frames yield **only microtasks** (no intermediate state can be drawn), with a wall-clock
     *   fallback; if exceeded, switch to (b).
     * - **(b)**: cards with `vtOk` catch up in the visible stage using subtree virtual time (yield a
     *   macrotask every 8 steps, remove `.pc-settling` once caught up); those with `vtOk = false` take
     *   K5 path two (the parent page's job).
     */
    const routeJump = (target: number, fps: number): void => {
      const targetMs = target * 1000;
      const targetFrame = Math.round(target * fps);
      const now = realNow();
      const plan = ref.current.plan?.plan ?? null;
      for (const clip of cardClipsAt(target)) {
        const prevFrame = ref.current.lastTargetFrame.get(clip.id);
        const backwards = prevFrame !== undefined && targetFrame < prevFrame;
        ref.current.lastTargetFrame.set(clip.id, targetFrame);
        // Heavy cards attach a snapshot during a jump; catching up to the live render is the job of `settle` (routeSettle)
        if (pipelineAt(plan, clip.id, target) === "heavy") continue;
        const { tier, record } = tierOf(clip.id, fps);
        if (tier === "direct" || tier === "declared-light") continue;   // Random access: follows setTime
        if (tier === "seek") {
          if (!backwards) continue;
          if (!repushAllowed(clip.id, now)) continue;
          const wrap = remountClipRecipe(clip.id, mountMsOf(clip, fps));
          // One step: pin the target milliseconds, hand the component's `t` back to global (remove it from `settling`)
          setSettlingAt(clip.id, null);
          if (wrap) pinner.syncIn(wrap, targetMs);
          commitPlanes();
          continue;
        }
        if (tier === "catchup-a") {
          if (!repushAllowed(clip.id, now)) continue;
          const task = startCatchUp(clip.id, targetMs, fps, false);
          if (task) void runCatchUpSync(task, 1000 / fps);
          continue;
        }
        if (tier === "catchup-b") {
          if (record?.vtOk !== true) continue;   // Path two is initiated by the parent page
          if (!repushAllowed(clip.id, now)) continue;
          const task = startCatchUp(clip.id, targetMs, fps, false);
          if (task) void runCatchUpAsync(task);
        }
      }
    };

    /**
     * The playhead has **just entered** a tier (b) `vtOk` light card: make it catch up from
     * `mountFrameOf` (K3(b)). This layer is transparent until it catches up: light cards have no
     * snapshot plane, and `.pc-settling` is `visibility: hidden`.
     */
    const enterCatchUps = (sec: number, fps: number): void => {
      const plan = ref.current.plan?.plan ?? null;
      const active = new Set<string>();
      for (const clip of cardClipsAt(sec)) {
        active.add(clip.id);
        if (ref.current.lastActive.has(clip.id)) continue;
        if (ref.current.catchUps.has(clip.id)) continue;
        if (pipelineAt(plan, clip.id, sec) !== "light") continue;
        const { tier, record } = tierOf(clip.id, fps);
        if (tier !== "catchup-b" || record?.vtOk !== true) continue;
        startCatchUp(clip.id, sec * 1000, fps, false);
      }
      ref.current.lastActive = active;
    };

    /* ------------------------------------------------ K1's two-pass boolean probe (vtOk / seekOk / seekMs) */

    /**
     * The wrapper of this card (`[data-pc-clip]` mounted by `Stage.tsx`).
     *
     * The probe **only runs on a shrunken project** (K1: one clip per track), so the stage has exactly
     * one card subtree, and the first match is the outermost wrapper: the part wrappers of a composite
     * card are nested inside it, and `getAnimations({ subtree: true })` covers them all. `:not([data-pc-media])`
     * excludes the media layer (the media layer of `FrameScene` also carries `data-pc-clip`).
     */
    const probeWrap = (): Element | null =>
      rootRef.current?.querySelector("[data-pc-clip]:not([data-pc-media])") ?? null;

    /**
     * **K3's "remount-and-pin recipe", per clip** (used to reset K1's two-pass boolean probe; K3(a')
     * backward jumps and the start of K5 path one are R5's business and use the same code). Not a single
     * step may be skipped:
     *
     *   `resetIn(wrapper)` → remount (`remountGen` / here it is `playToken`)
     *   → `clock.tick(clock.now())` **twice** → `pinner.syncIn(wrapper, mountMs)`
     *
     * Why reset: the timing pass has already stepped this card to the clip's last frame, and animations
     * past the end were collected by `pinAnimations`' `finish()` and are skipped forever after. Without
     * a reset the comparison runs on a final-state instance, and both booleans would necessarily be
     * recorded as `false`.
     *
     * Why `tick` gets `clock.now()` and not `mountMs`: `tick(ms)` sets `now = ms` first and then drains
     * the rAF queue, so passing anything else amounts to winding the global clock away. Here the
     * previous line just did `clock.set(mountMs)`, so the two are exactly equal; writing `clock.now()`
     * keeps it consistent with the "current global milliseconds" rule in K3.
     *
     * Why pin the mount frame anchor at the end: `patchAnimate` makes a new animation `pause()` and set
     * `currentTime = 0` as soon as it is born. Without this, the anchor would be recorded as the target
     * milliseconds of the first `syncIn`, and the picture would stop at frame 0.
     */
    const remountClipAt = (mountSec: number): Element | null => {
      const before = probeWrap();
      // The probe's shrunken project holds only this one card; when there is no wrapper (not mounted yet), fall back to a full rebuild
      if (before) pinner.resetIn(before);
      else pinner.reset();
      clock.set(mountSec * 1000);
      flushSync(() => {
        setToken((n) => n + 1);
        setT(mountSec);
      });
      clock.tick(clock.now());
      clock.tick(clock.now());
      const after = probeWrap();
      if (after) pinner.syncIn(after, mountSec * 1000);
      return after;
    };

    /**
     * The control HTML of this card right now (the one being compared). Returns null when `lossy > 0`:
     * a WebGL canvas cannot read back pixels and both passes are empty canvases, so the comparison is
     * meaningless; K1 states explicitly that in this case both booleans are always recorded as `false`.
     * A composite card has several controls, joined in document order and compared together (both
     * passes serialize the same tree, so the order is consistent).
     * The separator is an HTML comment: the lexer of `compareSnapshotHtml` treats it as one comment
     * token and compares it verbatim; it is present on both sides at the same position, so it does not
     * affect the verdict. This is less trouble than a non-printable character (leaving non-printable
     * characters in source makes git treat the whole file as binary, and R3 is editing this file at the
     * same time).
     */
    const probeControlHtml = (): string | null => {
      const root = rootRef.current;
      if (!root) return null;
      const snap = createSnapshot(root);
      if (snap.lossy > 0) return null;
      return snap.controls.map((c) => c.html).join("<!--pc-next-control-->");
    };

    /**
     * Two-pass boolean probe (K1 / pinned partition axis one "how to tell SeekOK"). Four passes, each
     * running the reset recipe first:
     *
     *   1. **Baseline pass**: the global clock steps 8 frames from the mount frame, and the control HTML
     *      of frame 8 is kept **in memory** (K1: does not depend on the parent page sending it back).
     *      The stepping is verbatim the same as the timing / snapshot passes: the same
     *      `advanceToAsync`, the same `onFrame` / `afterFrame`, otherwise it would not be comparing the
     *      same thing.
     *   2. **`vtOk` pass**: **does not move the global clock**, only `pinner.syncIn(wrapper, global
     *      stage milliseconds of that frame)` + gives the component a local `t`, 8 frames. Nobody drains
     *      the global rAF queue, so Motion JS animations that read the global frame loop timestamp
     *      cannot advance: this is exactly the kind `vtOk = false` is meant to catch.
     *      Between frames it likewise yields only microtasks (same as `advanceToAsync` in the baseline
     *      pass), no more and no less.
     *   3. **`seekOk` pass**: pin to frame 8 in one step (skipping frames 1-7), then compare.
     *   4. **`seekMs`**: pin directly from frame 0 to the clip's last frame, and `__pcRealNow` measures
     *      the wall clock of this run.
     *
     * "Give the component a local `t`" here is `setT`: the shrunken project has only this one card, so
     * the stage's global `t` is its local time base. Only when R5 does the same on a **single** card in
     * the whole project is the `settling` prop of `Stage` needed (K5 path one); the probe does not need
     * it, so this step does not touch `Stage.tsx`.
     *
     * Each pass is capped at `PROBE_BOOL_FRAMES` frames or `PROBE_BOOL_MS` milliseconds; a comparison
     * pass that exceeds it records `false`, and the pass that measures `seekMs` records `null` when
     * exceeded. **Generated snapshots never post `probe-frame`** (K1).
     */
    const runBooleanProbe = async (lastSec: number, fps: number, gen: number): Promise<{ booleans?: ProbeBooleans; aborted?: true }> => {
      const step = 1000 / fps;
      const mountSec = mountSecOf(lastSec, fps);
      const mountMs = mountSec * 1000;
      const frames = PROBE_BOOL_FRAMES;
      const stale = () => gen !== renderGen.current;
      /**
       * Yield a macrotask between frames: so the parent page's RPC messages and the iframe's own resize
       * have a chance to get in (used between passes).
       * When background work is paused (section 2 of the C10 contract), wait between passes, not in the
       * middle of one (the wall clock of a pass is the number being measured).
       */
      const breathe = async () => {
        await new Promise<void>((r) => (window.__pcRealSetTimeout ?? window.setTimeout)(r, 0));
        const g = backGate(stale);
        if (g) await g;
      };

      /* ---- 1. Baseline pass: global clock steps 8 frames ---- */
      { const g = backGate(stale); if (g) await g; }
      if (stale()) return { aborted: true };
      remountClipAt(mountSec);
      let pushed = 0;
      const baseStarted = realNow();
      await clock.advanceToAsync(mountMs + frames * step, {
        step,
        maxCatchUp: Infinity,
        abort: () => stale() || pushed >= frames || realNow() - baseStarted > PROBE_BOOL_MS,
        onFrame: (ms) => flushSync(() => setT(ms / 1000)),
        afterFrame: (ms) => {
          pinner.sync(ms);
          pushed++;
        },
      });
      if (stale()) return { aborted: true };
      // canvas card: before comparing, this frame's bitmap must be applied (R9 M3: every frame of the K1 probe's snapshot generation sends a beat)
      await glStrict(clock.now() / 1000);
      // A card truncated before frame 8 has no baseline: both booleans are always recorded as false, no comparison (K1)
      const baseline = pushed >= frames ? probeControlHtml() : null;

      /* ---- 2. vtOk pass: only steps subtree virtual time ---- */
      await breathe();
      if (stale()) return { aborted: true };
      let vtHtml: string | null = null;
      if (baseline !== null) {
        const wrap = remountClipAt(mountSec);
        const vtStarted = realNow();
        let done = 0;
        for (let k = 1; k <= frames; k++) {
          // Same as advanceToAsync in the baseline pass: between frames only yield microtasks (Motion needs a boundary to resolve keyframes)
          await Promise.resolve();
          if (stale()) return { aborted: true };
          if (realNow() - vtStarted > PROBE_BOOL_MS) break;
          const ms = mountMs + k * step;
          if (wrap) pinner.syncIn(wrap, ms);
          flushSync(() => setT(ms / 1000));
          done++;
        }
        if (done >= frames) {
          await glStrict(ref.current.t);
          vtHtml = probeControlHtml();
        }
      }
      const vtOk = baseline !== null && vtHtml !== null && compareSnapshotHtml(baseline, vtHtml).same;

      /* ---- 3. seekOk pass: pin to frame 8 in one step ---- */
      await breathe();
      if (stale()) return { aborted: true };
      let seekHtml: string | null = null;
      if (baseline !== null) {
        const wrap = remountClipAt(mountSec);
        const seekStarted = realNow();
        const ms = mountMs + frames * step;
        if (wrap) pinner.syncIn(wrap, ms);
        flushSync(() => setT(ms / 1000));
        await glStrict(ms / 1000);
        if (realNow() - seekStarted <= PROBE_BOOL_MS) seekHtml = probeControlHtml();
      }
      const seekOk = baseline !== null && seekHtml !== null && compareSnapshotHtml(baseline, seekHtml).same;

      /* ---- 4. seekMs: wall clock of pinning from frame 0 straight to the last frame ---- */
      await breathe();
      if (stale()) return { aborted: true };
      const wrap = remountClipAt(mountSec);
      const lastMs = Math.max(mountMs, lastSec * 1000);
      const seekStarted = realNow();
      if (wrap) pinner.syncIn(wrap, lastMs);
      flushSync(() => setT(lastMs / 1000));
      const elapsed = realNow() - seekStarted;
      ref.current.t = lastMs / 1000;

      return { booleans: { vtOk, seekOk, seekMs: elapsed > PROBE_BOOL_MS ? null : elapsed } };
    };

    /* ------------------------------------------------------------------ K4 metronome */

    /**
     * The accounting for this beat (K6's one-second window), also deciding whether to downgrade
     * (**downgrade only, never upgrade**). Each card's elapsed time comes from `<Profiler>` (one per clip
     * on the live path of `FrameScene`, E7) and is cleared every beat.
     *
     * How overtime is computed, why `pendingDemote` cards are not counted, and which card is downgraded
     * are all in `noteK6Beat` of `beatLoop.mjs`. After downgrading one card, post
     * `{ type: 'demote', clipId }`, and the parent page looks up the old record and PUTs the whole
     * `{ ...old record, capped: true, demoted: true }`. "Most expensive" is by measurement, not by the
     * probe's `stepMs`.
     */
    const noteBeat = (beatCost: number, fps: number, sec: number): void => {
      const worst = noteK6Beat(ref.current.k6, {
        at: realNow(),
        beatCost,
        byClip: ref.current.cardCost,
        fps,
        sec,
        plan: ref.current.plan?.plan ?? null,
      });
      if (worst) postStageEvent({ type: "demote", clipId: worst });
    };

    /**
     * Stop the beat loop and settle the waiting `pause()` replies.
     *
     * **Three entry points**: `pause()` (stop immediately), an armed stop being reached, and
     * `setRole('back')` / playback reaching the end.
     * Whichever way we got here, pending RPCs must be answered: once the loop stops, nobody is left to
     * resolve them.
     */
    const settleBeatWaiters = (): void => {
      const armed = ref.current.beatArmed;
      const waiters = ref.current.beatWaiters;
      ref.current.beatArmed = null;
      ref.current.beatWaiters = [];
      const stoppedAt = ref.current.beatLastSec;
      if (armed) {
        window.clearTimeout(armed.timer);
        armed.resolve({ ok: true, stoppedAt });
      }
      for (const resolve of waiters) resolve({ ok: true, stoppedAt });
    };

    /** Stop the loop (`setRole('back')`, `pause()` and playback reaching the end all go through it) */
    const stopBeat = (): void => {
      ref.current.beatPaused = true;
      if (!ref.current.beatRunning) settleBeatWaiters();
    };

    /**
     * Beat loop (K4). **Only `front` runs it**. Each beat:
     *
     *   `t += 1 / fps` → `clock.advanceTo(t × 1000, { step: 1000 / fps })` advances light cards and commits
     *   → attach planes (plane state lives in a `ref`, committed together with `setT`) → wait for a **real** frame
     *   → one extra settle beat (`clock.tick` + `pinner.sync`, so Motion writes the new values back to the DOM)
     *   → post `{ type: 'frame', sec }` → next beat.
     *
     * **Beats are scheduled on absolute time**: `nextDue = playStart + n × 1000 / fps` (`__pcRealNow`).
     * After a beat's work is done, `await __pcRealRaf()` until `__pcRealNow() ≥ nextDue − 1 ms`.
     * On a 60 Hz screen one rAF is only 16.6 ms, so at 30 fps a single wait does not fill a beat, hence
     * the loop; 24 / 25 fps naturally settle into an alternating 2 / 3 frame pattern, and the average is
     * still 1000 / fps.
     *
     * **A slow frame waits**: only when **the beat's own work** overruns `nextDue` is the whole timeline
     * shifted back (`playStart += overrun`). No catching up, no frame skipping, no rushing ahead, so the
     * `sec` difference between two consecutive `frame` messages is always 1/fps. Overshoot caused by the
     * granularity of waiting for rAF does **not** shift: if every beat shifted a little, any frame rate
     * other than 30 fps would be pushed along to "a whole number of vsyncs per beat", and the average
     * would no longer be 1000/fps.
     */
    const runBeatLoop = async (fromSec: number): Promise<void> => {
      const p = ref.current.project;
      if (!p) return;
      const fps = Math.max(1, p.fps || 30);
      const period = 1000 / fps;
      const duration = Math.max(0, Number(p.duration) || 0);
      /** Upper bound for normally waiting on a real frame: one beat, at least 20 ms */
      const rafBudget = Math.max(20, period);
      /** How many beats in a row got no real frame (a throttled iframe never gets one) */
      let rafMisses = 0;
      // The beat index counts frame slots and `sec` is always `frame number / fps`: accumulating floats drifts
      const fromFrame = Math.round(fromSec * fps);
      let playStart = realNow();
      ref.current.beatRunning = true;
      try {
        for (let n = 1; ; n++) {
          // Check `paused` / role at the start of each beat (E0)
          if (ref.current.beatPaused || ref.current.role !== "front") break;
          const { sec, frame, ended } = beatAt(fromFrame, n, fps, duration);
          const beatStarted = realNow();

          /* ---- One beat's work ---- */
          ref.current.t = sec;
          ref.current.cardCost.clear();
          flushSync(() => setT(sec));
          clock.advanceTo(sec * 1000, { step: period, onFrame: (ms) => pinner.sync(ms, skipWrappers()) });
          // Attach heavy cards to the stream (K5 / G5): if the frame for this beat is at hand, draw it now; otherwise keep the previous one or leave it transparent. Never wait for it
          presentStreams(sec);
          // K3(b) frame catch-up in play state: besides this beat's own frame, push its local time a few more steps
          enterCatchUps(sec, fps);
          stepCatchUps(fps);
          // End of the fallback order (T1~T4): a layer whose stream is blank this beat and has no snapshot attached shows a placeholder; decided in the same beat, without waiting for the next dispatch
          refreshPlaceholders();
          traceFallback(sec, realNow() - beatStarted);
          /*
           * Canvas card (R9 M3, the order within a beat is fixed): DOM commit done → `beat` → **`await done`
           * (a slow frame waits here)** → bitmaps attached to the planes (done inside `glHost`) → wait for a
           * real frame → post `frame`. `done` occasionally spikes by tens of milliseconds; waiting for it is
           * K4's "a slow frame waits": this beat gets longer, the beat scheduling below shifts the whole
           * timeline back, and no frame is skipped. If the Worker is truly stuck, `glHost` lets go after
           * 1 second, the planes keep the previous bitmap, and the loop does not hang.
           */
          const glBeat = gl.beat({ t: sec });
          if (glBeat) await glBeat;
          /*
           * Wait for a real frame, **with a timeout** (see `realRafOrAfter`). If no real frame arrives for
           * several beats in a row, conclude that the browser has throttled this iframe: nothing is being
           * repainted anyway, and waiting for it would only stretch the beat to the throttle period.
           * Switch to yielding a single macrotask (Motion needs a task boundary to resolve keyframes, not a
           * real frame).
           */
          const painted = await realRafOrAfter(rafMisses >= RAF_MISS_GIVEUP ? RAF_GIVEUP_MS : rafBudget);
          rafMisses = painted ? 0 : rafMisses + 1;
          /*
           * One extra settle beat. `settle()` schedules a microtask, and we are already right after an `await`
           * here, so just do it synchronously and, while at it, invalidate the one still pending (another
           * frame was rendered, so the previous extra beat does not count).
           */
          settleGen.current++;
          clock.tick(sec * 1000);
          pinner.sync(sec * 1000, skipWrappers());
          const beatCost = realNow() - beatStarted;

          // Check the role once more before posting `frame` (E0): on the beat of a swap, the new `back` must not still report
          if (ref.current.role !== "front") break;
          ref.current.beatLastSec = sec;
          ref.current.beatLastFrame = frame;
          if (ended) {
            postStageEvent({ type: "ended", sec: duration });
            break;
          }
          postStageEvent({ type: "frame", sec });
          noteBeat(beatCost, fps, sec);

          // Armed stop (E0): stop on the very frame where `frame(atSec)` was just posted; the planes are not removed
          const armed = ref.current.beatArmed;
          if (armed && ref.current.beatLastFrame >= armed.frame) break;

          /* ---- Wait for the absolute time of the next beat ---- */
          const next = scheduleNextBeat(playStart, n, period, realNow());
          playStart = next.playStart;
          const { nextDue } = next;
          if (!next.late) {
            while (realNow() < nextDue - BEAT_SLACK_MS) {
              await realRafOrAfter(Math.max(BEAT_SLACK_MS, nextDue - realNow()));
              if (ref.current.beatPaused || ref.current.role !== "front") break;
            }
          }
        }
      } finally {
        ref.current.beatRunning = false;
        ref.current.beatPaused = true;
        settleBeatWaiters();
      }
    };

    /*
     * Start / stop of background work (C10 contract section 2): the editor page decides it is idle and sends it via
     * `setBackWork`. While stopped, background work waits between frames (no pushing, no dropping) and
     * resumes pushing when restarted; being cut off by a new render / setProject (`stale`) also ends the wait.
     * The desktop runtime never sends it, so it is always on.
     */
    const backWork = { on: true, waiters: new Set<() => void>() };
    const backGate = (stale: () => boolean): Promise<void> | undefined => {
      if (backWork.on || ref.current.role !== "back") return undefined;
      return new Promise<void>((resolve) => {
        const done = () => { backWork.waiters.delete(done); clearInterval(poll); resolve(); };
        // Also release when cut off (new render, setProject) or when the role changed, otherwise the RPC is never answered
        const poll = (window.__pcRealSetInterval ?? window.setInterval.bind(window))(() => {
          if (backWork.on || stale() || ref.current.role !== "back") done();
        }, 50) as unknown as number;
        backWork.waiters.add(done);
      });
    };


    /*
     * M7 generate snapshots (`bakeFrame`, contract section 4.3): the generation (`bakeCancel`; a new frame
     * invalidates the one in flight) and the resume point of forward pushing (which frame the previous
     * frame was pushed to, and on which project; if the project changed to another object it cannot
     * resume, so push from the start).
     */
    let bakeGen = 0;
    let bakeCursor: { project: Project; clipId: string; frame: number } | null = null;
    /** While settling, check whether the stage's DOM changed in this round (only attached inside `bakeSettle`) */
    let bakeMutations: MutationObserver | null = null;
    /** Maximum number of settle rounds (same as `settleDom` on the export page) */
    const BAKE_SETTLE_ROUNDS = 4;
    /**
     * Commit the React updates that are already scheduled but not yet committed (done for every frame
     * pushed by `bakeFrame`, see `frameEnd` there).
     *
     * Cards change state in each frame's callback (progress value, how many characters have been typed,
     * which word is current), and Motion swaps elements in the animation-end callback. React does not
     * commit any of these on the spot; it leaves them to the scheduler to run in a later macrotask. If
     * left alone, which frame the commit lands on depends on how much time passed between two frames:
     * when pushing in order the snapshot holds the previous frame's values, and when pushing from the
     * start it holds this frame's. The frame at which a swapped-in element starts to animate is also off
     * by one (`docs/reports/AGENT-rr-a1-verify.md`, "Cause 3"). The export page drains every frame
     * (`settleDom` in `snapshotSettle.ts`); this is the same thing.
     *
     * One round has two steps:
     *   1. Yield one macrotask. The state change is often hidden behind a chain of Promise callbacks
     *      (Motion's "all exit animations finished"), and it only really happens once the microtask
     *      chain has run through; the boundary of one macrotask drains that chain.
     *   2. Commit synchronously once (`flushSync` with one real state change). This render also does the
     *      other updates queued on the same tree, and the effects after the commit (where Motion starts
     *      new animations) also run to completion right there. **It does not rely on waiting for the
     *      scheduler**: which message its task is queued behind, and whether the browser paints a frame
     *      before running the effects after the commit, are not under our control here; a synchronous
     *      commit is decided only here and always lands at this frame's time.
     * If the DOM changed in this round, do another round (an effect may change state again); if it did
     * not change, that is enough. At most `BAKE_SETTLE_ROUNDS` rounds.
     * The yield uses MessageChannel instead of timers: chained timers wait at least 4 ms each, and the
     * browser also throttles timers in background pages.
     */
    const bakeSettle = async (): Promise<void> => {
      const root = rootRef.current;
      if (root) {
        bakeMutations ??= new MutationObserver(() => {});
        bakeMutations.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      try {
        for (let round = 0; round < BAKE_SETTLE_ROUNDS; round++) {
          await probeTaskBoundary();
          flushSync(() => bumpPlanes());
          if (!root || !bakeMutations?.takeRecords().length) return;
        }
      } finally {
        bakeMutations?.disconnect();
      }
    };
    /**
     * Generate-snapshots diagnostics on the stage side (contract section 7, "Stage",
     * `__pcStageDiag().bake`): per-frame time (excluding time blocked by the gate), time blocked by the
     * gate recorded separately, the number of pushes from the start, and counts of failure reasons.
     */
    const bakeStats = { frames: 0, ms: [] as number[], pausedMs: 0, remounts: 0, smallMs: [] as number[], errors: {} as Record<string, number> };
    const bakeFail = <R extends { ok: false; reason: string }>(r: R): R => { bakeStats.errors[r.reason] = (bakeStats.errors[r.reason] ?? 0) + 1; return r; };
    const q = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10; };
    /** Upper bound of the readiness gate (follows prerender `waitFrameReady`: snapshots are generated only once control async work, fonts and images are all ready) */
    const BAKE_READY_MAX_MS = 20_000;
    /**
     * Readiness gate before generating each frame's snapshot (ruled by the lead session after M7 probe
     * P2, following `waitFrameReady` in prerender `server/bakery/frame-ready.mjs`): snapshots are generated
     * only once control async work, fonts and images are all ready. While waiting, beats at the same
     * moment are still issued (time is not pushed; controls loaded via rAF need beats to make progress).
     * If a control reports an error, or is not ready within `BAKE_READY_MAX_MS`, report not ready:
     * this segment is `fail`, and no blank frame is produced.
     */
    const bakeReady = async (stale: () => boolean): Promise<{ ok: true } | { ok: false; detail: string }> => {
      const t0 = realNow();
      let failure: string | null = null;
      let done = false;
      const gate = (async () => {
        do {
          await waitForFrameWork();
          // Lay out once first, so newly attached text starts loading its fonts
          document.documentElement.getBoundingClientRect();
          await document.fonts.ready;
          await Promise.all([...document.images].filter((img) => img.getAttribute("src") || img.getAttribute("srcset")).map((img) => img.decode().catch(() => {})));
          // A finished load may attach another control during the React commit
        } while (frameWorkStatus().length > 0 || document.fonts.status !== "loaded");
      })().catch((e) => { failure = String((e as Error)?.message ?? e); }).finally(() => { done = true; });
      while (!done) {
        await Promise.race([gate, new Promise<void>((r) => realSetTimeout(r, 4))]);
        if (done || stale()) break;
        if (realNow() - t0 > BAKE_READY_MAX_MS) {
          return { ok: false, detail: trText("Controls, fonts or images not ready within {0} seconds: {1}", Math.round(BAKE_READY_MAX_MS / 1000), frameWorkStatus().map((w) => w.label).join(trText(", ")) || (document.fonts.status !== "loaded" ? trText("fonts") : trText("Images"))) };
        }
        clock?.tick(clock.now());
      }
      if (failure) return { ok: false, detail: failure };
      return { ok: true };
    };
    const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");

    const api: StageRpcApi = {
      /**
       * Swap the project document. A patch reuses A7's changedClips structure, and when merging it
       * **keeps the object references of unchanged clips** (which is what applyProjectPatch does); full
       * comes with reset.
       * Neither role **recomputes** this frame on a jump any more: front only updates the project (step 4,
       * D5 hooks up "re-look up the index for layers changed per changedClips"); back, when its in-flight
       * probe push is cut off, replies { aborted, reason: 'project' }.
       */
      async setProject(next, opts = {}) {
        const prev = ref.current.project;
        let full: Project;
        if (isProjectPatch(next)) {
          if (next.kind === "full") full = next.project;
          else {
            if (!prev) throw new Error(trText("setProject: received an incremental patch but the stage has no project yet (send a full one first)"));
            full = applyProjectPatch(prev, next);
          }
        } else {
          full = next;
        }
        if (opts.reset || full !== prev) {
          // clipId is reused across projects; if not cleared, things get mixed up
          if (full !== prev) { resetInk(); resetPlaceholderGeometry(); }
        }
        const prevKey = ref.current.layoutKey;
        const nextKey = layoutKeyOf(full);
        ref.current.project = full;
        ref.current.layoutKey = nextKey;
        // R9: route of the project options (effective value; on a switch, rebuild the connection on the glHost side, M2 / constraint 1). The online page's route follows the stage gate, not the project options
        gl.setRoute(ONLINE ? onlineGlRoute : resolveGlRoute(full.glRoute));
        flushSync(() => setProject(full));
        // The aspect ratio may have changed: re-judge the graphics capability of media effect cards (the max texture size rule) against the new long edge
        if (!prev || prev.width !== full.width || prev.height !== full.height) cardExec.runtime?.refreshGraph();
        window.clearTimeout(ref.current.settle);
        // The project changed, so the in-flight catch-up run is invalidated: the probe will resend against the new project
        renderGen.current++;
        projectGen.current++;
        abortPending("project");
        // Changing the project also aborts the first-path frame catch-up (K5: each of the five RPCs increments once)
        catchUpGen.current++;
        abortCatchUps();
        if (LEGACY) {
          if (prevKey !== nextKey) {
            legacyJump(ref.current.t);
          } else {
            const changed = changedCardClips(prev, full);
            const tt = ref.current.t;
            if (changed.length && changed.some((c) => cardMountedAt(c, tt))) {
              ref.current.settle = realSetTimeout(() => legacyJump(ref.current.t), SETTLE_MS);
            }
          }
        }
        return { ok: true as const };
      },

      /**
       * Seek to tSec (the only entry point for pause / drag). A separate path that does not reuse render:
       *   clock.set → flushSync(setT) → pinner.sync → settle. It does not increment playToken, and the component instances stay the same.
       * The only exception: when going forward by less than CONTINUOUS_MAX seconds, push a few frames
       * synchronously with advanceTo as in continuous playback (≤ 30 steps).
       * Far jumps or going backward never use advanceTo (it would spin through hundreds of ticks synchronously).
       * probe: always takes the jump path (what is measured must be a single frame), generates control
       * snapshots after crossing a task boundary, and the reply carries elapsedMs.
       *
       * **`snapshots` / `awaiting` take effect in the same React commit as `t`** (E0): when dragging past
       * the in-point of a stateful card, the newly mounted component and its snapshot plane appear in the
       * same frame, with no flash of the initial state. So both are written into `ref.current`
       * **before** `flushSync(setT)`, since rendering reads from there. `settle` is K5's paused-state live render (R5).
       */
      async setTime(tSec, opts = {}) {
        /*
         * Role gate (E1). The branch with `probe: true` measures K1's results, and only the background stage
         * can take it: the visible stage is playing the picture for the user, so running a probe on it would
         * neither measure accurately (it would compete with the user's interaction for the main thread) nor
         * seek the picture to the probe's time. A `setTime` without `probe` is accepted by both roles
         * (dragging is sent to `front`, D4's page-side measurement is sent to `back`), so the gate only blocks `probe`.
         */
        if (opts.probe && ref.current.role !== "back") return { aborted: true, reason: "role" as const };
        // Background work is stopped (C10 contract section 2): this frame of the probe waits until it resumes before measuring (the waiting time is not counted in the elapsed time)
        if (opts.probe) { const g = backGate(() => ref.current.role !== "back"); if (g) await g; }
        const target = Math.max(0, Number(tSec) || 0);
        const started = realNow();
        const p = ref.current.project;
        const prev = ref.current.t;
        const dt = target - prev;
        ref.current.t = target;
        ref.current.wantedSettle = !!opts.settle;
        if (!p) return { path: "set" } satisfies SetTimeReply;
        // When a setTime arrives during pause / drag, there is no such thing as an "in-flight catch-up run"
        renderGen.current++;
        abortPending("superseded");
        // A new setTime aborts the first-path frame catch-up in progress (K5: each of the five RPCs increments once)
        catchUpGen.current++;
        // Single stage: layers drawn at the last stop go back to suppressed (on drag and jump, attach the prerender output; on stop, the parent page sends settleLayers again)
        clearSettleLive();
        abortCatchUps();
        const fps = Math.max(1, p.fps || 30);

        if (!opts.probe && dt >= 0 && dt < CONTINUOUS_MAX) {
          // Continuous playback: just keep running a frame or two (≤ 30 steps, synchronous). Light cards follow the global clock, so K3 needs no further path split
          flushSync(() => setT(target));
          clock.advanceTo(target * 1000, { step: 1000 / fps, maxCatchUp: CONTINUOUS_MAX * 1000, onFrame: (ms) => pinner.sync(ms, skipWrappers()) });
          for (const clip of cardClipsAt(target)) ref.current.lastTargetFrame.set(clip.id, Math.round(target * fps));
          settle(target);
          scheduleSample();
          if (opts.settle) routeSettle(target, fps);
          presentStreams(target);
          refreshPlaceholders();
          // A synchronous advanceTo does not send beats step by step; it sends one only after it finishes, carrying the end t (K3(a) / M3)
          void gl.beat({ t: target });
          return { path: "continuous" } satisfies SetTimeReply;
        }

        clock.set(target * 1000);
        flushSync(() => setT(target));
        pinner.sync(target * 1000, skipWrappers());
        settle(target);
        scheduleSample();
        if (!opts.probe) {
          // K3's three jump paths; with `settle: true`, start K5's first path afterwards
          routeJump(target, fps);
          if (opts.settle) routeSettle(target, fps);
          presentStreams(target);
          refreshPlaceholders();
          // Send one beat on the frame where `setTime` settles (M3; clicking the timeline once sends only this one beat)
          void gl.beat({ t: target });
        }
        if (opts.probe) {
          /*
           * K1's four numbers (task brief 3.8). `stepMs` is taken before the task boundary; async commits and
           * the waiting for generating snapshots are not part of the single-frame cost of live render.
           */
          // The canvas card's `stepMs` includes the `beat → done` round trip (M4): the two routes differ in magnitude, so the route goes into `device`
          const glDone = await (gl.beat({ strict: true, measure: true, t: target }) ?? undefined);
          const stepMs = realNow() - started;
          // Reading computed style for a snapshot flushes styles synchronously; the GL bitmap has already been awaited by the strict beat.
          // A real rAF in a hidden background stage may arrive only once per second, and waiting per sample would stretch 16 frames into 16 seconds.
          await probeTaskBoundary();
          const root = rootRef.current;
          const snap = root ? createSnapshot(root).timing : { inlineMs: 0, rasterMs: 0, serializeMs: 0 };
          return { path: "set", elapsedMs: realNow() - started, stepMs,
            snapshot: { inlineMs: snap.inlineMs, rasterMs: snap.rasterMs, serializeMs: snap.serializeMs },
            ...(glDone?.gpuMs ? { glGpuMs: glDone.gpuMs } : {}) } satisfies SetTimeReply;
        }
        return { path: "set" } satisfies SetTimeReply;
      },

      /**
       * Catch-up run on the background stage (K1 probe / K3(b) continued push).
       *   jump: true  - remount and push from mountFrameOf to tSec;
       *                 `probe: 'snapshot'` (or `true`) generates control snapshots after each pushed frame and posts `probe-frame`,
       *                 and truncates once maxFrames is reached or the accumulated wall clock exceeds B (1000/fps×70%);
       *                 `probe: 'time'` only advances, with no snapshots and no post, capped by PROBE_MAX_FRAMES /
       *                 PROBE_MAX_MS, and the reply carries the per-frame live render time `steps` (K1's timing pass).
       *                 Every truncation replies { aborted: true, reason: 'timeout', elapsedMs, frames, truncated: true }.
       *   jump omitted - continued push: no remount, no touching playToken, push from clock.now() to tSec;
       *                 if tSec is before the current time, reply { aborted, reason: 'superseded' } directly.
       * The Promise resolves only after the push finishes; being cut off by a new render replies 'superseded', and by setProject replies 'project'.
       */
      async render(tSec, opts = {}) {
        /*
         * Role gate (E1). `render` remounts the whole show and pushes through it frame by frame; landing on
         * the visible stage, that would replay the picture in front of the user from the in-point. The
         * parent page only ever sends to `back` anyway, so this gate is a **fallback**: on the beat of a role
         * swap (K5), the parent page's idea of "who is back" may lag the stage by one step, and we would
         * rather reply `{ aborted: true, reason: 'role' }` and let the parent page treat it as an error than
         * let the visible stage start pushing frames. The parent page does not resend on `role`: resending
         * would hit the same role anyway.
         */
        if (ref.current.role !== "back") return { aborted: true, reason: "role" } satisfies RenderReply;
        const target = Math.max(0, Number(tSec) || 0);
        const started = realNow();
        const p = ref.current.project;
        if (!p) return { aborted: true, reason: "project", elapsedMs: 0 } satisfies RenderReply;
        const fps = Math.max(1, p.fps || 30);
        const probeMode = opts.probe === true ? "time" : opts.probe || null;
        const timing = probeMode === "time";
        const maxFrames = opts.maxFrames ?? (timing ? PROBE_MAX_FRAMES : Infinity);

        const gen = ++renderGen.current;
        abortPending("superseded");
        window.clearTimeout(ref.current.settle);

        /*
         * The two-pass boolean probe takes its own branch: it is not "push to tSec" but four passes, each
         * reset and then compared (K1). `tSec` here means the **clip's last frame** and is only used to
         * measure `seekMs`. Cutting off is judged by `renderGen` like the other probes, replying
         * `superseded` / `project`.
         */
        if (probeMode === "booleans") {
          const pg = projectGen.current;
          const out = await runBooleanProbe(target, fps, gen);
          const elapsedMs = realNow() - started;
          if (out.aborted || gen !== renderGen.current) {
            // Same as the other paths: cut off by setProject replies 'project', cut off by a new render replies 'superseded'
            return { aborted: true, reason: projectGen.current !== pg ? "project" : "superseded", elapsedMs } satisfies RenderReply;
          }
          scheduleSample();
          return { remounted: true, caughtUpAtSec: clock.now() / 1000, elapsedMs, stepMs: elapsedMs,
            booleans: out.booleans } satisfies RenderReply;
        }

        let remounted = false;
        if (opts.jump) {
          remountAt(target, fps);
          remounted = true;
        } else if (target * 1000 < clock.now()) {
          // Continued push does not support going backward
          return { aborted: true, reason: "superseded", elapsedMs: realNow() - started } satisfies RenderReply;
        }

        let frames = 0;
        let truncated = false;
        /* Timing pass: per-frame live render time (commit React → run rAF callbacks → pin animations); time yielded between frames is not counted */
        const steps: number[] = [];
        let frameStarted = 0;
        /*
         * Time while background work is stopped (C10 contract section 2): not counted in the probe's cap or
         * elapsed time. The online background stage yields one macrotask per frame (`setTimeout(0)`) and
         * checks the stop flag between frames; the desktop app still yields once every 8 frames and never stops.
         */
        let pausedMs = 0;
        const wall = () => realNow() - started - pausedMs;
        const gate = () => {
          const g = backGate(() => gen !== renderGen.current);
          if (!g) return undefined;
          const t0 = realNow();
          return g.then(() => { pausedMs += realNow() - t0; });
        };
        return await new Promise<RenderReply>((resolve) => {
          ref.current.pending = { gen, startedAt: started, frames: () => frames, resolve };
          void (async () => {
            await clock.advanceToAsync(target * 1000, {
              step: 1000 / fps,
              maxCatchUp: opts.maxCatchUp,
              yieldEvery: ONLINE ? 1 : 8,
              gate,
              abort: () => {
                if (gen !== renderGen.current) return true;
                /*
                 * The timing pass **is not truncated by the one-beat budget** (task brief K1): otherwise all 61
                 * frame-pushing cards would push only 1-10 frames, and catchUpMs, extrapolated from the first few
                 * frames that include mount cost, would come out 1.7-3.6 times too high. The cap here is kept only
                 * for long clips; the remaining frames are extrapolated by the parent page as "first-frame
                 * measurement + median of the other frames × remaining frame count".
                 */
                if (timing) {
                  if (frames >= maxFrames || wall() > PROBE_MAX_MS) {
                    truncated = true;
                    return true;
                  }
                  return false;
                }
                return false;
              },
              onFrame: (ms) => {
                if (timing) frameStarted = realNow();
                flushSync(() => setT(ms / 1000));
              },
              afterFrame: (ms) => {
                pinner.sync(ms, skipWrappers());
                if (!timing) return;
                frames++;
                /*
                 * Canvas card (R9 M3 / M4): every frame of the K1 probe sends a beat and waits for done, so the
                 * per-frame time of the timing pass includes this round trip (the definition of `stepMs`).
                 * When there is no gl plane, `glStrict` returns `undefined`, and this frame completes synchronously
                 * exactly as before.
                 */
                const glDone = glStrict(ms / 1000);
                if (glDone) return glDone.then(() => { steps.push(realNow() - frameStarted); });
                steps.push(realNow() - frameStarted);
              },
            });
            if (gen !== renderGen.current) return; // Already answered by abortPending according to reason
            ref.current.pending = null;
            const elapsedMs = wall();
            if (truncated) {
              resolve({ aborted: true, reason: "timeout", elapsedMs, stepMs: elapsedMs, frames, truncated: true, steps });
              return;
            }
            flushSync(() => setT(target));
            clock.tick(target * 1000);
            pinner.sync(target * 1000, skipWrappers());
            settle(target);
            scheduleSample();
            ref.current.t = target;
            // The frame where K5's second-path catch-up run reaches the target (intermediate frames are not sent, same as the synchronous advanceTo exemption): attach the bitmaps, then reply
            if (!timing) {
              await glStrict(target);
              if (gen !== renderGen.current) return;
              /*
               * When the catch-up run reaches the target beat, the whole show is exactly in precise live render:
               * take the chance to measure the ink boxes (Item 7). After a swap this stage becomes the front one,
               * and the placeholder's solid box is already in hand, with no need to wait for a measurement after
               * the promotion; cards that are suppressed / invisible at that moment will not fall back to a badge either.
               */
              measureInkBoxesNow();
            }
            resolve({ remounted, caughtUpAtSec: clock.now() / 1000, elapsedMs, stepMs: elapsedMs,
              ...(timing ? { frames, truncated: false, steps } : {}) });
          })();
        });
      },

      async hitTest(x, y) {
        const root = rootRef.current;
        return root ? solidHitTest(root, x, y) : null;
      },
      async rectsWithBounds(opts = { pixels: "none" }) {
        const root = rootRef.current;
        return root ? solidRectsWithBounds(root, opts) : [];
      },
      async size() {
        const p = ref.current.project;
        return { width: p?.width ?? 1920, height: p?.height ?? 1080 };
      },
      async setProxy(on) {
        // Only pages that explicitly carry ?proxy=1 are allowed to turn this on. The export page can never reach this branch.
        if (!proxyAllowed()) return { ok: true as const };
        const want = !!on;
        if (want === ref.current.proxy) return { ok: true as const };
        ref.current.proxy = want;
        if (want) ensureProxyStyle();
        /*
         * Sample at the moment of switching from solid back to real rendering, not when switching into solid:
         * in solid mode the picture holds only color blocks, and measuring it would just copy the previous
         * conclusion and degrade it.
         * Sampling is scheduled after this frame's commit (the real card has already been drawn), so it goes after flushSync.
         */
        flushSync(() => setProxy(want));
        // While solid mode is on, `.pc-proxy` hides the stream planes too: stop decoding, and do not use up the decoded-frame budget (E7 item 4)
        player.setProxy(want);
        if (!want) {
          const root = rootRef.current;
          if (root) sampleAll(root);
        }
        return { ok: true as const };
      },
      /**
       * The role is runtime state (J4). On receiving `back` the stage turns into a background stage in
       * place, **without remounting the component**: the swap (K5) relies on exactly "the same tree
       * taking a different identity", and remounting would throw away all the state it spent so long
       * catching up.
       *
       * The full cleanup set (the `setRole` entry in E0; neither swap path lists them one by one again):
       *   1. Stop the K4 beat loop (the loop checks `beatPaused` / the role at the start of every beat
       *      and before posting `frame`);
       *   2. Clear `suppressed` / `snapshots` / `streamPlanes`: `back` never accepts non-empty sets
       *      of them;
       *   3. Stop `streamPlayer` and `close()` all `VideoFrame`s (R8 track streams);
       *   4. Remove all planes and classes (snapshot / suppressed / waiting / frame catch-up);
       *   5. Abort the first frame catch-up path running in the visible stage (`catchUpGen` increments)
       *      and clear `settling` / `awaiting`.
       * R3 wires items 2, 4 and 5 to real state (the planes themselves already exist); the loop itself
       * (item 1) lands in R5, and `streamPlayer` (item 3) in R8.
       *
       * `bake` is not supported in local mode (the prerender process does the prerendering); it replies
       * `unsupported` and does not throw.
       */
      async setRole(role, opts = {}) {
        // `bake`: not supported in local mode (the prerender process does the prerendering); the background stage of the online build doubles as a pure-browser node (M7 contract D3)
        if (role === "back" && opts.job === "bake" && !ONLINE) return { ok: false, reason: "unsupported" as const };
        /*
         * K5 (6): a stage **promoted from `back`** must report `settled` once (`clipIds` is an empty array).
         *
         * The criterion is "was it `back` a moment ago", **not the job**: after the single-flight queue
         * finishes the catch-up run, it hands the job back as `'probe'` (`pump` in `stageJobs`), and that
         * `setRole('back', { job: 'probe' })` and the swap's `setRole('front')` are two parallel RPCs with
         * no guarantee which arrives first. If we judged by job, whenever the hand-back arrives first
         * `settled` would never be reported, and the parent page would wait until timeout.
         */
        const wasBack = ref.current.role === "back";
        ref.current.role = role;
        ref.current.job = role === "back" ? opts.job ?? "probe" : undefined;
        gl.setRole(role);
        if (role === "back") {
          ref.current.wantedSettle = false;
          // 1. Stop the K4 beat loop (any pending pause() reply is settled along with it)
          stopBeat();
          // R9: release this stageId's atlas in the Worker (stageId does not change on swap, only this one is cleared)
          gl.release();
          ref.current.snapshots = new Map();
          ref.current.suppressed = new Set();
          ref.current.parentSuppressed = new Set();
          ref.current.settleLive = new Set();
          setStreamWaiting(new Map());
          ref.current.deferredSettle.clear();
          ref.current.settledHeld = new Set();
          ref.current.streamPlanes = [];
          // 3. Stop `streamPlayer` and `close()` all `VideoFrame`s (R8)
          player.stop();
          ref.current.settling = new Map();
          ref.current.catchUps.clear();
          ref.current.lastActive = new Set();
          catchUpGen.current++;
          // The background stage never has a placeholder (product/rendering.md "Fallback order"): take it down first, then close it; the slots are removed together in this one commit
          hideAllPlaceholders(slotOf);
          setPlaceholdersEnabled(false);
          removePlaceholderStyle();
          setCatchingUpClips([]);
          // Remove all planes and classes in the same commit: on the swap beat, the new `back` must not still cover the old picture
          commitPlanes();
        } else {
          // Only previews a person looks at (the live stage page, `front`) mount the placeholder plane; the export page / prerender page do not go through here and never have one
          if (LIVE && !placeholdersEnabled()) {
            setPlaceholdersEnabled(true);
            commitPlanes();
          }
          // Each stage measures its own ink box: the one just promoted (K5 swap) has none, so measure once while it is an exact live render
          scheduleInkBoxes();
          // K5 (6): the new `front` posts `{ type: 'settled', sec, clipIds: [] }` once
          if (wasBack) postStageEvent({ type: "settled", sec: ref.current.t, clipIds: [] });
        }
        return { ok: true };
      },
      /**
       * K2's dispatch table + K1's per-card records (E0). The parent page computes and sends them when
       * `costs` / the project / `tuning` change; **sets are arrays on the wire** (`wirePlan.ts`) and are
       * restored to `Set`s here, so the consuming side still uses `pipelineAt` as usual.
       *
       * `back` can accept it too (it only stores it without using it): when the role is promoted
       * (K5 (5) / K3(b) (5)), the parent page first resends it once in the same batch after
       * `setRole('front')`, and that is when it comes in handy.
       *
       * Its consumers are K3 / K5 (R5): `pipelineAt(plan, clipId, t)` decides whether this beat is a live
       * render or a pasted static media, and `vtOk` / `seekOk` / `catchUpMs` in `costs` decide between
       * (a′) / (a) / (b) and K5's two paths. This step only stores the table and sets up the query hook.
       */
      async setPlan(plan) {
        const wire = (plan?.plan ?? null) as WirePlan | null;
        ref.current.plan = reviveStagePlan(wire, Array.isArray(plan?.costs) ? plan.costs : []);
        if (ref.current.role === "front" && ref.current.wantedSettle && !ref.current.playing && !ref.current.scrubbing && ref.current.suppressed.size > 0) {
          const p = ref.current.project;
          const fps = Math.max(1, p?.fps || 30);
          routeSettle(ref.current.t, fps, true);
        }
        return { ok: true as const };
      },
      /**
       * K4: the visible stage is the metronome. `play(fromSec)` only **starts** the loop: it replies
       * immediately without waiting for the first beat, and the parent page takes its reply time as the
       * starting point of "the arrival interval between two adjacent `frame`s" (`mediaStalled`).
       *
       * Only `front` runs: `back` is either doing a probe or a catch-up run, and starting a loop would
       * keep pushing its clock forward.
       */
      async play(fromSec) {
        if (ref.current.role !== "front") return { ok: false, reason: "role" };
        ref.current.wantedSettle = false;
        const p = ref.current.project;
        if (!p) return { ok: false, reason: "no-project" };
        const from = Math.max(0, Number(fromSec) || 0);
        // Two `play`s in a row: let the previous round wrap up first, or the two loops would each push their own clock
        if (ref.current.beatRunning) {
          ref.current.beatPaused = true;
          await new Promise<PlayReply>((resolve) => { ref.current.beatWaiters.push(resolve); });
        }
        const fps = Math.max(1, p.fps || 30);
        ref.current.beatLastSec = from;
        ref.current.beatLastFrame = Math.round(from * fps);
        ref.current.k6.beats = [];
        ref.current.lastActive = new Set();
        ref.current.beatPaused = false;
        // Pressing play likewise aborts the first frame catch-up path (K5: each of the five RPCs increments once)
        catchUpGen.current++;
        // Single stage: the next playback returns to how it looked during playback (the lowest tier only pastes the prerender output)
        const hadLive = clearSettleLive();
        abortCatchUps();
        if (hadLive) commitPlanes();
        void runBeatLoop(from);
        return { ok: true, stoppedAt: from };
      },
      /**
       * `pause()` stops immediately: it stops **after this beat finishes and its `frame` is posted**,
       * and replies `{ stoppedAt }` (= the `sec` of the last beat). If the loop is already stopped (after
       * `ended`, or a repeated `pause()`), it replies with the last beat immediately.
       *
       * `pause({ atSec })` is an **armed stop** (used by K3(b)'s swap during playback): it stops on the
       * beat right after `frame(atSec)` is posted, staying on that frame with the planes kept, and
       * replies `{ stoppedAt: atSec }`. If that beat has **already been posted** (the current beat index
       * ≥ the beat index of `atSec`, **equality counts as passed**), it does not stop and replies
       * `{ passed: true }`; otherwise the beat would never come and the RPC would never reply. Beat
       * indexes are compared by frame number, not by floats.
       */
      async pause(opts = {}) {
        const atSec = opts?.atSec;
        const fps = Math.max(1, ref.current.project?.fps || 30);
        if (!ref.current.beatRunning) return { ok: true, stoppedAt: ref.current.beatLastSec };
        if (typeof atSec === "number" && Number.isFinite(atSec)) {
          const frame = Math.round(atSec * fps);
          if (ref.current.beatLastFrame >= frame) return { ok: true, passed: true };
          // Keep only the last armed stop: the previous one is voided (reply with `passed`, telling the parent page to stop waiting for it)
          const prev = ref.current.beatArmed;
          if (prev) {
            window.clearTimeout(prev.timer);
            ref.current.beatArmed = null;
            prev.resolve({ ok: true, passed: true });
          }
          return await new Promise<PlayReply>((resolve) => {
            // The fallback uses a **real** setTimeout (E4b): if the loop gets stuck, the RPC must not go without a reply forever
            const timer = realSetTimeout(() => {
              if (ref.current.beatArmed?.timer !== timer) return;
              ref.current.beatArmed = null;
              resolve({ ok: true, stoppedAt: ref.current.beatLastSec });
            }, ARM_TIMEOUT_MS);
            ref.current.beatArmed = { frame, atSec, resolve, timer };
          });
        }
        return await new Promise<PlayReply>((resolve) => {
          ref.current.beatWaiters.push(resolve);
          stopBeat();
        });
      },
      /**
       * Cards judged as duplicates during playback (E7 item 5): `Stage` adds `.pc-suppressed` to the
       * wrapper and hides the subtree, and the `t` passed to the component is frozen at the moment
       * suppression began; the wrapper stays in the layout tree with its geometry unchanged, so
       * `rects()` / `hitTest` can still hit it as usual.
       *
       * **`.pc-suppressed` and `.pc-settling` are mutually exclusive**: this is the path K6 takes when it
       * downgrades a card to heavy in the middle of a frame catch-up, so here we first delete it from
       * `settling` and increment `catchUpGen` to abort that catch-up path, then add suppression in the
       * same commit; the two classes never coexist in the same frame.
       */
      async setSuppressed(clipIds) {
        const before = ref.current.suppressed;
        ref.current.parentSuppressed = new Set(clipIds);
        /*
         * A card **newly** named this time that has a stream plane mounted while the stream has not yet
         * drawn its first frame: do not hide its original picture yet (`streamWaiting`), and hide it once
         * the stream is drawn (starting playback, seeking and the start of a drag all go through here; the
         * parent page sends the stream plane first, then the suppression). Cards already hidden, or whose
         * stream already has a picture (decoded in advance while paused), are hidden on the spot as usual.
         * Cards without a stream plane (no stream, over the decoder budget, or light cards waiting for the
         * background catch-up run to swap) do not wait.
         * **With only one stage, do not wait** (compact mode and the lowest tier: devices whose startup
         * test gate did not reach dual stage, in the same batch as "paste the sparse version only" and the
         * former low-memory tier): heavy cards are never live-rendered during playback or dragging (this
         * device cannot keep up; during the waiting beats the live components keep running and must be
         * computed on every beat, so the stream's decoded output ends up queued behind and cannot come
         * out). Until the stream's first frame arrives, this layer stays empty (the placeholder shows only
         * after 120 ms). See `compact` in the stage capability table (only one stage); the lowest tier
         * additionally looks at `smallOnly` in the tier policy.
         */
        {
          const showing = ref.current.streamPlanes.length ? player.showingClips() : NO_CLIPS;
          const lowestHere = ONLINE && (caps.compact || mediaTierPolicy().smallOnly);
          const waiting = new Map<string, number>();
          const now = realNow();
          for (const id of ref.current.parentSuppressed) {
            if (showing.has(id) || !planeOf(id)) continue;
            const since = ref.current.streamWaiting.get(id);
            if (since !== undefined) waiting.set(id, since);
            else if (!lowestHere && !before.has(id) && !ref.current.settling.has(id)) waiting.set(id, now);
          }
          if (waiting.size || ref.current.streamWaiting.size) setStreamWaiting(waiting);
        }
        // Single stage, stopping to catch up one frame: layers being drawn / already drawn are not hidden by the parent page's suppression; below, judge by the one in effect
        applySuppressed();
        const next = ref.current.suppressed;
        // T4: a suppressed card judged light at this moment is waiting for the background catch-up run to swap (used for the placeholder's reason; the show/hide criterion does not look at it)
        {
          const plan = ref.current.plan?.plan ?? null;
          setCatchingUpClips([...next].filter((id) => pipelineAt(plan, id, ref.current.t) === "light"));
        }
        /*
         * K6: being switched into `suppressed` means the static media is ready, so remove it from
         * `pendingDemote`: from then on it is a heavy card and does not take part in K6's judgment anyway.
         */
        if (ref.current.k6.pending.size) {
          const rest = new Set(ref.current.k6.pending);
          for (const id of next) rest.delete(id);
          if (rest.size !== ref.current.k6.pending.size) ref.current.k6.pending = rest;
        }
        if (ref.current.settling.size) {
          const rest = new Map(ref.current.settling);
          let changed = false;
          /*
           * What gets interrupted is the frame catch-up of light cards (K6 downgrades a light card in
           * frame catch-up to heavy). Heavy cards that chase an exact live render after stopping (the kind
           * from `announce`) are not interrupted: they already stick to the stream and are named, and the
           * parent page resending the suppression set (another card changed; or the `settled` of its last
           * catch-up arrived late and the parent page names it again by the new position) must not make it
           * stop on the stream; when it catches up, `releaseSettled` lifts the suppression as usual. The
           * same goes for members that catch up first in a group stream and wait for their group mates.
           */
          for (const id of next) {
            if (ref.current.catchUps.get(id)?.announce || ref.current.settledHeld.has(id)) continue;
            if (rest.delete(id)) changed = true;
          }
          if (changed) {
            ref.current.settling = rest;
            catchUpGen.current++;
          }
        }
        commitPlanes();
        return { ok: true as const };
      },
      /**
       * Single stage stops to catch up the current frame (the pure part is in `render/settleFrame.ts`).
       * The parent page sends it after the `setTime` on pause, on click or drag release, and when
       * playback reaches the end. All cards of the current frame (heavy cards are drawn too) are live
       * rendered layer by layer, "direct-seek ones first, and among frame-pushing cards the ones needing
       * fewer pushed frames first"; each time a layer is drawn, its fallback is removed and the live
       * render swapped in; there is no time limit (`timeoutMs` is only for tests and diagnostics). User
       * cards and media effect cards that this page cannot run are not caught up: if a prerender output
       * exists for this frame it is pasted, otherwise an `unsupported` placeholder is shown (semantics
       * changed by the user, 2026-09-29). A new `setTime` / `play` / `setProject` / `setRole`
       * increments `catchUpGen`, and this run wraps up accordingly and replies `ok: false`.
       */
      async settleLayers(tSec, opts = {}) {
        const timeoutMs = clampSettleTimeout(opts?.timeoutMs);
        const sec = Math.max(0, Number(tSec) || 0);
        const empty = (reason: SettleResult["reason"]): SettleResult =>
          ({ ok: false, reason, sec, timeoutMs, ms: 0, drawn: [], timedOut: [], skipped: [] });
        if (ref.current.role !== "front") return empty("role");
        const p = ref.current.project;
        if (!p) return empty("no-project");
        // The parent page had just done `setTime` to this second before sending it; if it no longer matches (seeked away again) or playback is running, do not catch up
        if (ref.current.beatRunning || Math.abs(ref.current.t - sec) > 1e-6) return empty("superseded");
        const fps = Math.max(1, p.fps || 30);
        const targetMs = sec * 1000;
        const targetFrame = Math.round(sec * fps);
        const gen = catchUpGen.current;
        const items: SettleItem[] = [];
        for (const clip of cardClipsAt(sec)) {
          const c = clip as { id: string; start: number; end: number; cardId?: string; parts?: unknown[]; params?: unknown };
          const def = c.cardId ? getCard(c.cardId) : undefined;
          // Cards this device cannot run (user cards, media effect cards) are not caught up: paste the prerender output of this frame if there is one, otherwise it is an `unsupported` placeholder
          const unsupported = unsupportedHere(c.cardId, def);
          const mountFrame = mountFrameOf(clip, fps);
          const frameMode = def ? clipFrameMode(c as never, def) : undefined;
          const kind = settleKindOf({ unsupported, frameMode, mountFrame, targetFrame });
          items.push({ clipId: c.id, kind, frames: Math.max(0, targetFrame - mountFrame) });
        }
        const result = await runSettle({
          sec, items, timeoutMs, now: realNow,
          aborted: () => gen !== catchUpGen.current,
          draw: (item, deadline) => drawSettleLayer(item, deadline, targetMs, fps),
        });
        ref.current.lastSettle = result;
        refreshPlaceholders();
        return result;
      },
      /**
       * G1's stream plane groups; the render position is in `Stage` (inside the wrapper / under the stage
       * root), and decoding and compositing are in `streamPlayer`. Each entry carries a stream key `key`
       * and the ready segment numbers `ranges` (C3's `stream` table); entries without `key` only hold
       * a place and do not decode.
       * **`back` does not accept non-empty sets** (K5: the three sets are sent only to `front`); if it
       * receives them, it only clears.
       */
      async setStreamPlanes(planes) {
        if (ref.current.role !== "front") {
          ref.current.streamPlanes = [];
          player.stop();
          commitPlanes();
          return { ok: true as const };
        }
        const sent = (Array.isArray(planes) ? planes : []).filter((g) => Array.isArray(g?.clipIds) && g.clipIds.length);
        // Those the parent page marked `over` exceed the budget on this beat: no stream plane is mounted and no decoder built; they are only handed to the player to fetch the manifest (the placeholder is placed by the position rectangle in the manifest)
        const incoming = sent.filter((g) => !g.over);
        const over = sent.filter((g) => g.over).map((g) => ({
          clipIds: g.clipIds.map(String),
          ...(typeof g.key === "string" && g.key ? { key: g.key } : {}),
          ...(Number.isInteger(g.originFrame) && (g.originFrame as number) >= 0 ? { originFrame: g.originFrame as number } : {}),
          ...(g.plane === "stage" ? { plane: "stage" as const } : {}),
          ...(g.manifest && typeof g.manifest === "object" && g.manifest.segments ? { manifest: g.manifest } : {}),
          over: true as const,
        }));
        const groupsOf = (list: readonly { clipIds: readonly string[]; plane?: string }[]) => list.map((g) => `${g.clipIds.join(",")}${g.plane === "stage" ? "@stage" : ""}`).join("|");
        const before = groupsOf(ref.current.streamPlanes);
        ref.current.streamPlanes = incoming.map((g) => ({
          clipIds: g.clipIds.map(String),
          ...(typeof g.key === "string" && g.key ? { key: g.key } : {}),
          ...(Array.isArray(g.ranges) ? { ranges: g.ranges.map((r) => [Number(r[0]), Number(r[1])] as [number, number]) } : {}),
          // This stream's own first frame: the player uses it to convert frame numbers into segment numbers (`render/streamSegments.mjs`); planes without it are not accepted by the player
          ...(Number.isInteger(g.originFrame) && (g.originFrame as number) >= 0 ? { originFrame: g.originFrame as number } : {}),
          // A stream that depends on a lower layer: produced in stage coordinates, with the canvas mounted under the stage root (`[data-pc-group-plane]` of `Stage`), not inside the wrapper
          ...(g.plane === "stage" ? { plane: "stage" as const } : {}),
        }));
        /*
         * The stream plane of an online page additionally carries the manifest and bytes (`PushedStreamSource` in
         * `streamPlayer.ts`), and arrives once per fetched segment during playback; `Stage` only looks at
         * each plane's `clipIds`, and if the grouping did not change it does not do an extra React commit
         * for it (the placeholder's show/hide is still recomputed on the spot below). The desktop app
         * still commits every time.
         */
        if (!ONLINE || groupsOf(ref.current.streamPlanes) !== before) commitPlanes();
        const fps = Math.max(1, ref.current.project?.fps || 30);
        // The manifest and bytes go only to the player, not into `ref.current.streamPlanes` (that copy goes into React's props)
        player.setPlanes(ref.current.streamPlanes.map((p, i) => {
          const g = incoming[i];
          const manifest = g.manifest && typeof g.manifest === "object" && g.manifest.bound && g.manifest.segments && g.manifest.inits ? g.manifest : null;
          // Lowest tier: the `first` the parent page carries (decode only the first frame of each segment) goes only to the player, and like the manifest and bytes does not go into React's props
          const base = g.first === true ? { ...p, first: true as const } : p;
          return manifest ? { ...base, manifest, ...(g.blocks && typeof g.blocks === "object" ? { blocks: g.blocks } : {}) } : base;
        }), fps, over);
        // Cards waiting for the stream to draw its first frame, whose stream plane was removed: stop waiting (those the parent page still names are hidden on the spot, falling back to the snapshot / placeholder)
        if (ref.current.streamWaiting.size) {
          const gone = [...ref.current.streamWaiting.keys()].filter((id) => !planeOf(id));
          if (gone.length) endStreamWaiting(gone);
        }
        // The canvas was just mounted with this commit: draw once on the spot, without waiting for the next beat
        presentStreams(ref.current.t);
        refreshPlaceholders();
        return { ok: true as const };
      },
      /** Dragging the playhead by hand: the media layer's seek is made sparser (`SCRUB_SEEK_MIN_MS` of `mediaSync`) */
      async setScrubbing(on) {
        ref.current.scrubbing = !!on;
        if (on) ref.current.wantedSettle = false;
        commitPlanes();
        return { ok: true as const };
      },
      /** **Governs the media layer only** (`playing` of `VideoTrack`): it does not touch K4's beat loop, which is started and stopped only by play / pause / setRole */
      async setPlaying(on) {
        ref.current.playing = !!on;
        if (on) ref.current.wantedSettle = false;
        commitPlanes();
        return { ok: true as const };
      },
      /**
       * The moment the media layer follows. Normally equal to `t`; during K5's second-path catch-up run,
       * the parent page sends `back` the target beat separately:
       * when `VideoTrack` sees the deviation exceed `PAUSED_SEEK_SEC` it registers rVFC once more and
       * posts `mediaReady` as soon as the picture appears, with no need to wait out the full 300 ms
       * fallback.
       */
      async setMediaT(tSec) {
        ref.current.mediaT = Number(tSec) || 0;
        commitPlanes();
        return { ok: true as const };
      },
      /**
       * A1's tier-switch set: the hashes that the currently connected asset service reports as `complete`
       * (C6.6, sent down by the parent page after polling every 2 seconds).
       * When it changes, re-render once on the spot: tiers must switch even while paused (the double
       * buffering of `VideoTrack`).
       */
      async setBackWork(on) {
        backWork.on = !!on;
        if (backWork.on) for (const w of [...backWork.waiters]) w();
        return { ok: true as const };
      },
      /**
       * One frame of M7 generate snapshots (contract sections 4.3 and 4.4; for the protocol see
       * `BakeFrameRequest` in `stageRpc.ts`). The project is an isolated single-card project fed in by
       * the parent page via `pushProject('back', …)`, the target clip is the only visible output, and
       * local frame n is global frame n.
       *
       * Frame pushing: `seq` (the default) continues pushing from the previous frame and pushes from the
       * start only when it cannot continue. Probe P2 proved that for DOM-independent cards (including
       * Motion) this is equivalent to the desktop app's 4-frames-per-batch push from the start, and 4-7x
       * cheaper (canvas cards are not equivalent, and neither the node side nor the splitting lets them
       * into the browser); `batch4` batch starts are aligned to 4 frames and every batch pushes from the
       * start (same as the desktop app's `fillCardControls`). Between frames it yields one macrotask and
       * checks the background job's stop flag (stopped time is recorded in `pausedMs` and not counted as
       * elapsed time); it is not cut off by a beat budget. On reaching this frame it first passes the
       * readiness gate, then generates the snapshot and takes this control's HTML: if there is a canvas
       * whose pixels cannot be read (`lossy`), it replies `lossy` (the parent page hands it back as a
       * non-retryable failure, same as `server/bakery/bake.mjs`).
       *
       * **Continuation** (`prerender-products-contract.md` section 2.3): if the previous frame is not
       * later than this one, it continues pushing (when taking one frame every few frames, the frames in
       * between are only pushed and no snapshot is generated); asking for the same frame again does not
       * push again; if the stage clock is not at the previous frame's time (someone seeked it), or the
       * project or clip changed, it pushes from the start. `batch4` additionally requires the two frames
       * to be in the same batch.
       *
       * **Continuing and pushing from the start yield the same frame**: every frame pushed by either path
       * (the mount frame too) goes through the same `frameEnd`: commit the React updates queued by this
       * frame (`bakeSettle`) → pin animations (deliver end callbacks on the spot when seeked to the end,
       * `pinAnimations.ts`) → if any animation ended, commit once more (swap in the end callback, write
       * back the final value) → wait for the GL bitmap. When a frame is done, no uncommitted update is
       * left hanging, so how long passes between two frames (continuing spans the snapshot generation and
       * one RPC round trip, pushing from the start spans only one macrotask) does not affect the result;
       * each frame's time is computed directly from the frame number by the stage clock (`frameGrid` in
       * `stageClock.ts`), so it is the same number no matter which frame the push starts from.
       *
       * **Remotion-style cards are not replayed** (same contract section 4.2): when the only card in the
       * isolated project is declared remotion-style (the picture is determined by time and parameters
       * only), it seeks the clock directly to this frame, commits, and runs one beat of this frame,
       * without remounting or pushing frame by frame from the mount frame; `remounted` in the reply is
       * always `false`.
       *
       * For pixels (`req.pixels`, used by browser nodes to produce track streams): after generating the
       * snapshot, follow the small-size path and draw the rectangle region at the original size into a
       * bitmap (`renderSnapshotBitmap` in `bakeSmall.ts`), transferred to the parent page with the
       * `bake-frame` event; if it cannot be drawn, reply `pixels-failed`. When `req.html === false`, the
       * event carries no HTML bytes.
       *
       * **Cards inside a cut segment** (the clip id is a flattened virtual clip, [ruling] R02: the online
       * browser also produces streams for heavy cards inside cut segments): what is fed in is an isolated
       * project carrying the cut segment chain (`isolatedBakeProject` in `online/bakeTask.ts`), and time
       * is not shifted, so local frame n is project frame `req.frameBase + n`; the top level has only that
       * cut segment, and always pushes frame by frame from the mount frame (cards in a nested scene mount
       * by the segment's pre-roll and do not seek directly to that branch); the snapshot takes this
       * card's wrapper in the nested scene (`[data-pc-flat-clip]`, `flatControls` of `createSnapshot`).
       * The wrapper's local frame is computed from the card's own start (the reveal window may be cut at
       * the head), and when verifying, the expected value is computed with the same formula, allowing
       * one frame of difference (the floating-point order differs on the two sides). Top-level cards are
       * unchanged by a single character.
       */
      async bakeFrame(req) {
        if (!ONLINE || !clock) return { ok: false, reason: "unsupported" } satisfies BakeFrameReply;
        if (ref.current.role !== "back") return { ok: false, reason: "role" } satisfies BakeFrameReply;
        const p = ref.current.project;
        if (!p) return { ok: false, reason: "no-project" } satisfies BakeFrameReply;
        const flat = isFlatClipId(req.clipId);
        const clip = flat
          ? (flatClipOf(p, req.clipId)?.clip as Project["tracks"][number]["clips"][number] | undefined)
          : p.tracks.filter((tr) => !tr.hidden).flatMap((tr) => tr.clips).find((c) => c.id === req.clipId);
        if (!clip) return { ok: false, reason: "no-clip" } satisfies BakeFrameReply;
        const fps = Math.max(1, p.fps || 30);
        const n = Math.max(0, Math.floor(Number(req.localFrame) || 0));
        // Card inside a cut segment: local frame 0 is the project's frame `frameBase`; a top-level card is 0 (local frame is global frame)
        const base = flat ? Math.max(0, Math.floor(Number(req.frameBase) || 0)) : 0;
        const g = n + base;
        const sec = g / fps;
        const gen = ++bakeGen;
        const started = realNow();
        let pausedMs = 0;
        const stale = () => gen !== bakeGen || ref.current.role !== "back" || ref.current.project !== p;
        const cur = bakeCursor;
        bakeCursor = null;
        const targetMs = sec * 1000;
        // The only card in the isolated project is remotion-style: the picture is determined by time and parameters only, so seek directly to this frame.
        // The criterion is the same as the one the prerender process uses to decide whether a stream "needs replay" (`streamNeedsReplay` in `server/frame-stream.mjs`):
        // use the notation in the capability table of the fetched card; cards declared to need prerender, and cards that cannot be recognized, are always treated as stateful (better to push too much than to draw wrong)
        const def = clip.cardId ? getCard(clip.cardId) : undefined;
        const caps = def && !unsupportedHere(clip.cardId, def) ? cardCapabilities(def as never, { ...def.defaults, ...clip.params }, clip.parts as never) : null;
        const direct = !flat && !!caps && caps.frameMode === "direct" && caps.need_prerendering !== true
          && p.tracks.filter((tr) => !tr.hidden).flatMap((tr) => tr.clips).length === 1;
        // Can continue: the stage still mounts this clip of this project and the clock stops at the previous frame's time (the continuation point records the global frame; for a top-level card the global frame is the local frame)
        const held = !!cur && cur.project === p && cur.clipId === req.clipId && Math.abs(clock.now() - (cur.frame / fps) * 1000) < 1e-6;
        const continuing = !direct && held && cur.frame <= g
          && (req.mode !== "batch4" || (g % 4 !== 0 && Math.floor(cur.frame / 4) === Math.floor(g / 4)));
        /**
         * Frame wrap-up (the mount frame, every pushed frame and the directly seeked frame all go through
         * it, the two paths alike): after this frame's callbacks finish run,
         * commit the queued React updates → pin animations and deliver end callbacks on the spot → if any
         * animation ended in this frame, commit once more → wait for the GL bitmap.
         * Same order as one frame of the export page (`createStepper` in `server/bakery/bake.mjs`: drain →
         * pin animations → drain). If invalidated midway, stop and do not pin the animations of the new frame.
         */
        const frameEnd = async (ms: number): Promise<void> => {
          await bakeSettle();
          if (stale()) return;
          pinner.sync(ms, skipWrappers());
          if (pinner.endedInLastSync() > 0) await bakeSettle();
          if (stale()) return;
          const g = glStrict(ms / 1000);
          if (g) await g;
        };
        if (direct) {
          if (!held) {
            renderGen.current++;
            abortPending("superseded");
          }
          clock.set(targetMs);
          flushSync(() => setT(sec));
          clock.tick(targetMs);
          await frameEnd(targetMs);
        } else {
          if (!continuing) {
            // Push from the start: other in-flight catch-up runs / probes are invalidated (the single-flight queue never lets them coexist anyway, this is a safety net)
            renderGen.current++;
            abortPending("superseded");
            await frameEnd(remountAt(sec, fps) * 1000);
          }
          if (!stale()) await clock.advanceToAsync(targetMs, {
            step: 1000 / fps,
            fps,
            // Push from the mount frame to this frame without dropping a frame: if not passed, the default 6-second catch-up cap would trim off the start (that is for the visible stage's seek, "just don't stutter"),
            // and what is generated would not be the state this frame should have. Measurement, swap and whole-scene catch-up runs likewise pass Infinity
            maxCatchUp: Infinity,
            yieldEvery: 1,
            gate: () => {
              const g = backGate(stale);
              if (!g) return undefined;
              const t0 = realNow();
              return g.then(() => { pausedMs += realNow() - t0; });
            },
            abort: stale,
            onFrame: (ms) => { flushSync(() => setT(ms / 1000)); },
            afterFrame: frameEnd,
          });
        }
        if (stale()) return { ok: false, reason: "cancelled" } satisfies BakeFrameReply;
        // The clock did not land on this frame (should not happen: every step is computed by frame number, and the last step is this frame's time): do not pass off a picture from another time, hand it back as retryable
        if (Math.abs(clock.now() - targetMs) > 1e-6) return bakeFail({ ok: false, reason: "cancelled", detail: trText("Stage clock is at {0} ms, this frame is at {1} ms", clock.now(), targetMs) } satisfies BakeFrameReply);
        ref.current.t = sec;
        const t0 = realNow();
        const ready = await bakeReady(stale);
        if (stale()) return { ok: false, reason: "cancelled" } satisfies BakeFrameReply;
        if (!ready.ok) return bakeFail({ ok: false, reason: "not-ready", detail: ready.detail.slice(0, 300) } satisfies BakeFrameReply);
        const readyMs = realNow() - t0;
        const root = rootRef.current;
        const snap = createSnapshot(root, flat ? { flatControls: true } : undefined);
        if (snap.lossy) return bakeFail({ ok: false, reason: "lossy", detail: trText("{0} canvases with unreadable pixels", snap.lossy) } satisfies BakeFrameReply);
        const own = snap.controls.find((c) => c.id === req.clipId);
        if (!own) return bakeFail({ ok: false, reason: "no-control" } satisfies BakeFrameReply);
        // Card inside a cut segment: the wrapper's local frame is computed from the card's own start = this moment − (reveal start − the cut-off portion)
        const wantFrame = flat ? Math.round((sec - (clip.start - (Number((clip as { flat?: { lead?: number } }).flat?.lead) || 0))) * fps) : n;
        if (flat ? Math.abs(own.frame - wantFrame) > 1 : own.frame !== n) return bakeFail({ ok: false, reason: "frame-mismatch", detail: trText("The local frame of the generate snapshots step is {0}, expected {1}", own.frame, wantFrame) } satisfies BakeFrameReply);
        const bytes = new TextEncoder().encode(own.html);
        const hash = await sha256Hex(bytes);
        const wantHtml = req.html !== false;
        const gz = wantHtml ? await compressHtml(own.html) : null;
        let pixels: { rect: { x: number; y: number; w: number; h: number }; bitmap: ImageBitmap } | null = null;
        let pixelsMs = 0;
        if (req.pixels) {
          const rect = pixelRect(req.pixels.rect);
          if (!rect) return bakeFail({ ok: false, reason: "pixels-failed", detail: trText("Invalid rectangle for pixels (must be integers, with even width and height)") } satisfies BakeFrameReply);
          const p0 = realNow();
          const box = resolveFrameSize(clip.frame, p);
          try {
            const bitmap = await renderSnapshotBitmap({ html: own.html, boxWidth: Number(box.w) || p.width, boxHeight: Number(box.h) || p.height, rect });
            pixels = { rect, bitmap };
          } catch (e) {
            return bakeFail({ ok: false, reason: "pixels-failed", detail: String((e as Error)?.message ?? e).slice(0, 200) } satisfies BakeFrameReply);
          }
          pixelsMs = realNow() - p0;
        }
        /** This frame is not handed in (invalidated, or the small size did not succeed): the bitmap has not been transferred away yet, so close it */
        const dropPixels = () => { try { pixels?.bitmap.close(); } catch { /* Already closed */ } };
        let small: { hash: string; bytes: number; webp: ArrayBuffer } | null = null;
        let smallMs = 0;
        if (req.small) {
          const s0 = realNow();
          const box = resolveFrameSize(clip.frame, p);
          let webp: ArrayBuffer | null = null;
          try {
            webp = await renderSmallWebp({ html: own.html, projectWidth: p.width, projectHeight: p.height, boxWidth: Number(box.w) || p.width, boxHeight: Number(box.h) || p.height });
          } catch (e) {
            dropPixels();
            return { ok: false, reason: "small-failed", detail: String((e as Error)?.message ?? e).slice(0, 200) } satisfies BakeFrameReply;
          }
          if (!webp) { dropPixels(); return { ok: false, reason: "small-failed", detail: trText("The browser cannot produce WebP") } satisfies BakeFrameReply; }
          small = { hash: await sha256Hex(new Uint8Array(webp)), bytes: webp.byteLength, webp };
          smallMs = realNow() - s0;
        }
        if (stale()) { dropPixels(); return { ok: false, reason: "cancelled" } satisfies BakeFrameReply; }
        const transfer: Transferable[] = [];
        const event = { type: "bake-frame" as const, session: req.session, clipId: req.clipId, localFrame: n, hash, bytes: bytes.length,
          ...(!wantHtml ? {} : gz ? { htmlGz: gz } : { htmlRaw: bytes.buffer as ArrayBuffer }), small, ...(pixels ? { pixels } : {}) };
        if (wantHtml) transfer.push(gz ?? (bytes.buffer as ArrayBuffer));
        if (small) transfer.push(small.webp);
        if (pixels) transfer.push(pixels.bitmap);
        postStageEvent(event, "*", transfer);
        bakeCursor = { project: p, clipId: req.clipId, frame: g };
        bakeStats.frames++;
        bakeStats.ms.push(realNow() - started - pausedMs);
        bakeStats.pausedMs += pausedMs;
        if (!continuing && !direct) bakeStats.remounts++;
        if (req.small) bakeStats.smallMs.push(smallMs);
        if (bakeStats.ms.length > 200) { bakeStats.ms.splice(0, bakeStats.ms.length - 200); bakeStats.smallMs.splice(0, Math.max(0, bakeStats.smallMs.length - 200)); }
        return { ok: true, localFrame: n, hash, bytes: bytes.length, small: small ? { hash: small.hash, bytes: small.bytes } : null,
          ms: realNow() - started - pausedMs, pausedMs, remounted: !continuing && !direct, smallMs, readyMs, ...(pixels ? { pixelsMs } : {}) } satisfies BakeFrameReply;
      },
      async bakeCancel() {
        bakeGen++;
        bakeCursor = null;
        return { ok: true as const };
      },
      /** User cards and media effect cards synced by online execution: accept the bundle sent by the editor page (full set); whether to execute is decided by this document's own gate (see `applyCardBundles` above) */
      async loadUserCards(bundles, opts = {}) {
        if (import.meta.env.VITE_PC_ONLINE !== "1") return { ok: false, reason: "unsupported" as const };
        const gate = stageExecGate();
        // A document that is not a cross-origin stage entry (same-origin single stage, editor page): do not record, do not execute
        if (gate.reason === "not-stage") return { ok: false, reason: "unsupported" as const };
        cardExec.bundles = Array.isArray(bundles) ? (bundles as CardBundle[]) : [];
        cardExec.sound = opts?.sound === true;
        void applyCardBundles();
        return gate.allowed ? { ok: true } : { ok: false, reason: "gate" as const };
      },
      async synthCardAudio(request) {
        if (!cardExec.soundHost || !stageExecGate().allowed) throw new Error(trText("This stage has no sound thread"));
        return cardExec.soundHost.render(request);
      },
      /**
       * User cards "known but not runnable on this machine" that the online page learned by reading the
       * card source in the content store (C10 contract section 9 "Recognition"). The stage is a separate
       * document; the parent page sends a copy over into this page's registry; when it changes, re-render
       * once (these clips switch to mounting snapshot / stream planes and `unsupported` placeholders).
       */
      async setSyncedUserCards(entries) {
        const changed = setSyncedUserCards(Array.isArray(entries) ? entries : []);
        if (changed) commitPlanes();
        return { ok: true as const, changed };
      },
      /**
       * Preview zoom factor from the parent page (sent by both desktop and online): the placeholder
       * compensates by it so it stays legible on screen (`placeholderFit.ts`: the hourglass only cancels
       * the preview zoom). On change, re-render once (`Stage` gives the placeholder component a new `fit`).
       * The placeholder is mounted only in the preview people look at (not in export, prerender or the
       * background stage), so this only changes the preview.
       */
      async setViewScale(scale) {
        if (setPlaceholderViewScale(scale) && placeholdersEnabled()) commitPlanes();
        return { ok: true as const };
      },
      async setMediaPolicy(next) {
        // The lowest tier is enter-only: the initial `lowest=1` is not overwritten by the parent page's false
        // Execution gate (contract `online-card-exec-contract.md`, section 3.1): a policy carrying a ticket makes this document never run user cards; tickets arriving after the gate has opened are rejected
        const gate = ONLINE ? noteMediaPolicy({ ticket: next?.remote?.ticket ?? null, cardExec: next?.cardExec }) : { acceptTicket: true };
        const remote = next?.remote && !gate.acceptTicket && next.remote.ticket ? { ...next.remote, ticket: null } : next?.remote ?? null;
        const decode = typeof next?.decodeMaxPixels === "number" && Number.isFinite(next.decodeMaxPixels) && next.decodeMaxPixels > 0 ? next.decodeMaxPixels : null;
        // Network speed (`smallFirst`) is judged by this machine itself (`netSpeed.ts`); the parent page does not supply it; if one is given (tests), use that
        setMediaTierPolicy({ smallOnly: caps.lowest || next?.smallOnly === true, decodeMaxPixels: decode, smallFirst: typeof next?.smallFirst === "boolean" ? next.smallFirst : netSpeedState().smallFirst, remote });
        commitPlanes();
        return { ok: true as const };
      },
      /**
       * The online page switches the render route of canvas cards (the parent page sends `perDocument` when the stage gate tries the third level; semantics: `mechanism/platforms.md`, "Stage gate steps").
       * Switched in place (`glHost.setRoute` tears down the old connection and reconnects with the new route on the next tick), without rebuilding the stage or reloading the project. The route of the desktop runtime follows the project options, so it is not accepted here.
       */
      async setGlRoute(route) {
        if (!ONLINE || (route !== "perDocument" && route !== "shared")) return { ok: true as const, route: onlineGlRoute, mode: gl.diag().mode };
        onlineGlRoute = route;
        gl.setRoute(route);
        commitPlanes();
        return { ok: true as const, route: onlineGlRoute, mode: gl.diag().mode };
      },
      async setLocalHashes(hashes) {
        const next = [...hashes];
        const prev = ref.current.localHashes;
        if (prev.length === next.length && prev.every((h, i) => h === next[i])) return { ok: true as const };
        ref.current.localHashes = next;
        commitPlanes();
        return { ok: true as const };
      },
      /**
       * The HTML snapshot has been removed by Jier; this is left as an empty stub for compatibility with the old interface.
       */
      async setSnapshots(_patch, _opts = {}) {
        return { ok: true as const, bytes: 0 };
      },
    };

    const stopRpc = serveStageRpc(api);
    window.__pcStage = api;
    // The K1 probe / L1 / probe-frame generate snapshots all call it on the stage page; the export page mounts the same createSnapshot (J1).
    // The scene root is the [data-pc-scene] div that rootRef points to (not via document.querySelector: on the prerender page #root is just display:none).
    window.__pcCreateSnapshot = () => {
      const root = rootRef.current;
      if (!root) throw new Error(trText("stage: there is no project yet, nothing to generate snapshots for"));
      return createSnapshot(root);
    };
    /*
     * Query hook for the K2 table. K3 / K5 of R5 read `ref.current.plan` directly inside the stage;
     * this copy on window is for the acceptance probe and puppeteer to look at (whether the table has
     * arrived, whether this moment is judged light or heavy).
     * With no table, `pipelineAt` returns `'heavy'`: the conservative side, the same direction as
     * "no record falls back to the declaration".
     */
    window.__pcStagePlan = () => ref.current.plan;
    /*
     * Observation hook for the acceptance probe (K4 / K3 / K5 / K6): the iframe's document cannot be
     * reached cross-origin, so "the current internal state" is flattened into a structured-cloneable
     * object, which the probe reads in the stage context via CDP.
     * Read-only, no side effects.
     */
    window.__pcStageDiag = () => ({
      role: ref.current.role,
      job: ref.current.job ?? null,
      t: ref.current.t,
      beatRunning: ref.current.beatRunning,
      beatPaused: ref.current.beatPaused,
      beatLastSec: ref.current.beatLastSec,
      beatLastFrame: ref.current.beatLastFrame,
      armedFrame: ref.current.beatArmed?.frame ?? null,
      settling: [...ref.current.settling.keys()],
      suppressed: [...ref.current.suppressed],
      /** Single stage stops to catch up one frame: the layer being drawn / already drawn, and the last result */
      settleLive: [...ref.current.settleLive],
      lastSettle: ref.current.lastSettle,
      snapshots: [...ref.current.snapshots.keys()],
      awaiting: [...ref.current.awaiting],
      remountGen: [...ref.current.remountGen.entries()],
      catchUps: [...ref.current.catchUps.values()].map((c) => ({ clipId: c.clipId, stageMs: c.stageMs, targetMs: c.targetMs })),
      pendingDemote: [...ref.current.k6.pending],
      k6Beats: ref.current.k6.beats.length,
      k6Over: ref.current.k6.beats.reduce((n, b) => n + b.over, 0),
      /** Time spent by each card in the last tick (reported by `<Profiler>`); K6 picks "the most expensive one" by it */
      cardCost: [...ref.current.cardCost.entries()],
      /** R8: state of the stream plane and decoder (frames / bytes held, frames drawn per stream, current variant, ...) */
      streamPlanes: ref.current.streamPlanes.map((g) => ({ clipIds: g.clipIds, key: g.key ?? null, ranges: g.ranges ?? null, originFrame: g.originFrame ?? null, plane: g.plane ?? null })),
      /** Cards attached to a track stream: suppressed by name by the parent page, the stream has not drawn its first frame yet, and the original picture has not been hidden; frame catch-up that was deferred; within a group stream, the card that catches up first waits for the rest of its group */
      parentSuppressed: [...ref.current.parentSuppressed],
      streamWaiting: [...ref.current.streamWaiting.keys()],
      deferredSettle: [...ref.current.deferredSettle.keys()],
      settledHeld: [...ref.current.settledHeld],
      streams: player.diag(),
      /** R9: state on the shared WebGL renderer side (route, connection type, round-trip time, timeout count, ...) */
      gl: gl.diag(),
      /** End of the fallback order: the card currently showing a placeholder */
      placeholders: [...shownPlaceholders()],
      /** M7 generate snapshots (contract section 7, "Stage"): per-frame time excludes time blocked by the gate, which is recorded separately */
      bake: {
        frames: bakeStats.frames, frameMs: { p50: q(bakeStats.ms, 0.5), p95: q(bakeStats.ms, 0.95) }, pausedMs: Math.round(bakeStats.pausedMs),
        remounts: bakeStats.remounts, smallMs: { p50: q(bakeStats.smallMs, 0.5), p95: q(bakeStats.smallMs, 0.95) }, errors: { ...bakeStats.errors },
        cursor: bakeCursor ? { clipId: bakeCursor.clipId, frame: bakeCursor.frame } : null,
      },
    });
    // For the probe: ask the Worker for its own side's diagnostics (context count, texture upload count, atlas size)
    (window as unknown as Record<string, unknown>).__pcGlWorkerDiag = () => gl.workerDiag();
    window.__pcStagePipelineAt = (clipId: string, tSec: number) => pipelineAt(ref.current.plan?.plan ?? null, clipId, tSec);
    postStageReady(caps);
    // The self-check result of the cross-origin stage is sent after the handshake (`online/isolation/stageGuard.ts`); other documents send nothing
    if (ONLINE) announceStageIsolation();
    return () => {
      stopRpc();
      cardExec.stopped = true;
      offCardExecGate();
      cardExec.runtime?.dispose(); cardExec.runtime = null;
      cardExec.soundHost?.dispose(); cardExec.soundHost = null;
      player.stop();
      window.removeEventListener("message", onGlPort);
      if (ONLINE) document.removeEventListener("webglcontextlost", onContextLost, true);
      stopNetSpeed();
      gl.dispose();
      delete (window as unknown as Record<string, unknown>).__pcGlWorkerDiag;
      window.clearTimeout(ref.current.settle);
      window.clearTimeout(ref.current.streamWaitTimer);
      window.clearTimeout(sampleTimer);
      window.clearTimeout(inkTimer);
      setPlaceholdersEnabled(false);
      if (window.__pcStage === api) delete window.__pcStage;
      delete window.__pcStagePlan;
      delete window.__pcStageDiag;
      delete window.__pcStagePipelineAt;
    };
  }, [skipWrappers]);

  if (!project) return null;
  const timeline = flattenOverlay(project, graph);
  /*
   * The group stream plane is attached at the layer of **the topmost card currently active** in the group (G1).
   * On the live path each clip gets a single-clip `Stage`, so only here is it known which card is
   * present right now; `timeline.clips` is already in painter's order (the last one is on top).
   */
  const streamPlanes = ref.current.streamPlanes.some((g) => g.clipIds.length > 1)
    ? ref.current.streamPlanes.map((g) => {
      if (g.clipIds.length < 2) return g;
      const members = new Set(g.clipIds);
      const live = timeline.clips.filter((c) => members.has(c.id) && cardMountedAt(c, t));
      const host = live.length ? live[live.length - 1].id : g.clipIds[g.clipIds.length - 1];
      return g.host === host ? g : { ...g, host };
    })
    : ref.current.streamPlanes;

  return (
    <div
      ref={rootRef}
      data-pc-scene=""
      style={{
        position: "relative",
        width: project.width,
        height: project.height,
        overflow: "hidden",
        background: "transparent",
        // Reads from the same place as ExportView (Timeline), not each reading the project separately; see the note on Timeline.themeId
        ...themeStyle(timeline.themeId),
        /*
         * The 3D perspective is **not here**. Between this cell and the card there are still two layers of
         * div, the Stage root and AnimClock, and CSS perspective only affects direct children, so setting
         * it here is the same as not setting it
         * (measured: the card height does not budge, rotateY is left as a mere affine stretch, and no error is reported).
         * It is set in render/Stage.tsx on the card's direct parent, shared by preview and export.
         */
      }}
    >
      {LIVE ? (
        /*
         * E7: the stage page renders the **live playback variant** of `FrameScene`: the media layer is inside
         * the stage (item 1), card activity is judged by `cardMountedAt` (item 2), and the six plane props
         * are passed through as is (items 3-5).
         * `graph` is the `useMemo` above: **if it is not passed**, `graphVisualNode` is always false,
         * the media clip is drawn on two layers, and `timeline.graph` is empty so the media effect card
         * cannot resolve its input; the compiler will not catch it.
         */
        <FrameScene
          project={project}
          graph={graph}
          t={t}
          directT={t}
          mediaT={ref.current.mediaT}
          playToken={token}
          mediaMode="live"
          proxy={proxy ? proxyOf : undefined}
          scrubbing={ref.current.scrubbing}
          playing={ref.current.playing}
          suppressed={ref.current.suppressed}
          streamPlanes={streamPlanes}
          snapshots={ref.current.snapshots}
          remountGen={ref.current.remountGen}
          settling={ref.current.settling}
          awaiting={ref.current.awaiting}
          localHashes={ref.current.localHashes}
          onMediaFrame={onMediaFrame}
          onCardCost={onCardCost}
        />
      ) : (
        <Stage timeline={timeline} t={t} playToken={token} proxy={proxy ? proxyOf : undefined} />
      )}
    </div>
  );
}

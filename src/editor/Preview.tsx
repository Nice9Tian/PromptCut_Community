import { UnifiedPreview } from "./preview/UnifiedPreview";
import { flatPlanProject } from "../kernel/cutFlatten.mjs";
import { usePrerenderPreload } from "./preview/usePrerenderPreload";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isScrubbing, subscribeScrub } from "./timeline/useScrub";
import { MediaLayers } from "./preview/MediaLayers";
import { Scene3DView } from "./preview/Scene3DView";
import { themeStyle } from "../themes";
import { actions, getState, useStore } from "../store/project";
import { activeCutKind, findClip, type Project } from "../kernel/project";
import { nudgeFrame } from "../kernel/layout";
import { createStageRpc, type HostCapabilities, type StageGraphCapability, type StageMediaPolicy, type StageRpcClient } from "../render/stageRpc";
import { frontStage, onStageEvent, pushProject, releaseStageClient, setBeforeFullStagePush, setStageClient, swapStageClients, syncProject, whenStageReady } from "./stageBridge";
import { alignMirrorForStageMedia } from "../render/dataMirror";
import { bindStageCards, noteStageCards, noteStageFresh } from "./stageCards";
import { INITIAL_ROLE_OF, STAGE_IDS, dualStage, interimStage, liveStage, singleLiveStage, stageOrigins, stageSrc, stageTargetOrigin, type StageId } from "./previewMode";
import { ControlBar } from "./preview/ControlBar";
import { ToolBar, ToolType } from "./preview/ToolBar";
import { useMemberReadOnly } from "./readOnly";
import { PreviewContextMenu } from "./preview/PreviewContextMenu";
import { cardRunState, getCard, onCardRunStatesChanged, onSyncedUserCardsChanged, setCardRunStates, syncedUserCards, type CardRunState } from "../kernel/registry";
import { fitView, frameOrigin, framedFitView, framedPanBy, framedZoomAt, framedZoomPercent, isFramedFitted, panBy, resizeFramedView, wheelZoomFactor, zoomAt, type Size, type View2D } from "./preview/viewport2d";
import "./preview/preview.css";
import { atFrameGrid } from "../render/frameGrid";
import { contentStartOf } from "./timeline/utils";
import { startAssetTiers, tierHashes, useTierHashes } from "./media/assetTiers";
import { startTierBackfill } from "./io/mediaUpload";
import { backfillHooks } from "./sync/backfillUpload";
import { clearSettled, currentReadyIndex, localOnlyOf, markBaselineReset, noteSettled, pendingDemotes, setCostResolver, setSnapshotArrive, setSnapshotSource, snapshotFeedDebug, stopSnapshotFeed, streamPlanesAt, suppressedAt, syncSnapshotSubscription } from "./snapshotFeed";
import { OnlineSnapshotSource, activeOnlineSource, applyReadyMessage, setActiveOnlineSource } from "../render/snapshotSource";
import { StreamPlaneSender } from "../render/streamPlayer";
import { notePlayFrame, notePlayRunStart, playingSwapTargets, runPlayingSwap, runSettleSwap, setSwapHost, stageSwapDebug, stageSwapPlayingDebug, stageSwapTrace, swapInFlight } from "./stageSwap";
import { demotedClips, onStageDemote } from "./demote";
import { flushSync } from "react-dom";
import { useUserEditing } from "./userEditing";
import { createSharedGl, type SharedGl } from "../render/gl/glParent";
import { resolveGlRoute } from "../render/costDevice.mjs";
import { ONLINE } from "../online/mode";
import { lowestTier, phoneIdentity, setBenchmark, subscribeTier, tierGlRoute, tierState } from "../online/onlineTier";
import { stageGate } from "../online/stageGate";
import { MEDIA_MARK_MS, decodeLimit, originalLoadSignature, subscribeDecodeLimit } from "../online/mediaGate";
import { TierBubble } from "./TierBubble";
import { GateViewer, gateViewerWanted } from "./GateViewer";
import { setMediaTierPolicy, type MediaTierPolicy } from "../render/mediaTier";
import { assetAuthHeaders, docRequest, hasDocLink, remoteAccountProjectId, remoteAssetBase, remoteAssetTicket, remoteAssetTicketInfo, setNoEditorProcess, subscribeRemoteAssets } from "./media/assetTiers";
import { currentDocProjectId, currentSharedLink, getSyncView, pageSession, pushToast, subscribeQueueEvents } from "./sync/syncManager";
import { hostedStreamsOn } from "./sync/hostedServices";
import { needsLocalPc, onlineBrowserMode, setOnlineBrowserMode } from "../render/placeholderHost";
import { OnlineCardSources, CARD_SOURCE_POLL_MS } from "./sync/onlineCardSources";
import { editorRunStates } from "./sync/cardRunStates";
import { exportWantedClips } from "../export/exportWanted";
import { cardExecAvailable, cardExecBlockedDetail, cardVisualExecAvailable, setCardExecGate, subscribeCardExecGate } from "../online/cardRuntime/gate";
import type { BundleResult, CardBundle } from "../online/cardRuntime/protocol";
import { setNodeGraphCapable } from "../online/nodeCardInfo";
import { createIsolatedSoundLink, type IsolatedSoundLink } from "./io/isolatedSound";
import { holdMeasureForCardSources, measureGateDiag, measureGateOpen, releaseMeasureGate, setMeasureGateLink } from "./measureGate";
import { setCoverageSource } from "./onlineCoverage";
import { currentCosts, currentPlan, judgedPlan, lightCostAt, onPlanUpdated, planSearch, planSearchLight, searchJudged, sendPlanTo, setPlanDeadMs, setPlanForcedHeavy, setPlanLowest, setPlanSearch, setPlanSearchLight } from "./planDispatch";
import { benchmarkVerdict, costSearchMeasuring, costSearchState, holdCostSearchMask, measureNewCards, reclassify, releaseCostSearchMask, runBenchmark, runCostSearch, type BenchmarkOutcome, type CostSearchOutcome } from "./costSearch";
import { runBackJob } from "./stageJobs";
import { CostSearchGate } from "./CostSearchGate";
import { SHARED_COST_RELAY_MS, SharedCostRelay, listSharedCosts, publishSharedCosts, toSharedInput, type SharedCostInput } from "./sharedCosts";
import { clipIdentityOf } from "./costIdentity";
import { pageEnvironment } from "./pageEnvironment.mjs";
import { createMemoryCostStore, type CostStore } from "../render/boundarySearch.mjs";
import { beatSwapDebug, setBeatSwap } from "./snapshotFeed";
import { SWAP_MS } from "../render/beatSwap.mjs";
import { layerSwapMs } from "./swapCost";
import { markStageHandshake, onlineStageState, stageAssetBase, subscribeOnlineStages } from "../online/stageOrigins";
import { STAGE_SANDBOX, onlineCardExec, pageStageIsolation, sanitizeBreach, sanitizeIsolationReport, subscribeOnlineCardExec, type StageSidScope } from "../online/stageIsolation";
import { sanitizeHostCapabilities } from "../online/stageMessageGuard";
import { MEDIA_PROXY_BASE } from "../online/stagePolicy.mjs";
import type { IsolationReport } from "../online/isolation/isolationCheck";
import { createStageHandshake, type StageHandshake } from "../online/stageHandshake";

/** How long the cover stays at most when switching back to dual stages ([ruling 2026-09-30] `claude/stage-handshake`) */
const STAGE_HANDOVER_MAX_MS = 3000;
/** After the new visible stage's first `setTime` reply (or its first reported beat), wait this long before removing the cover, so it can draw this frame onto the screen */
const STAGE_HANDOVER_SETTLE_MS = 150;
import { createStageWatch, type StageWatch } from "../online/stageWatch";
import { builtinCardSourceFiles } from "../render/cardSourceFiles.mjs";
import { builtinSourceExports } from "../cards/builtinSourceExports";
import { pageL2 } from "../online/l2";
import { l2CostBackend } from "../online/l2Costs";
import { createPlanPublisher, type PlanPublisher } from "../online/planPublisher";
import { CODE_VERSION } from "../online/boot";
import { backWorkDiag, startBackWorkGate } from "./backWorkGate";
import { backStage } from "./stageBridge";
import { holdProbe, onCostRecords, onProbeProgress, probeFrameDiag, probeProgress, probeRunDiag, probeSettledFor, releaseProbe, runCardMeasuredHook, setCostBackend, setProbeMeasureHooks } from "./probeRunner";
import { browserNodeReady, keepConfirmedProject, startBrowserNodeHost, subscribeBrowserNodeReady } from "./browserNodeHost";
import type { SettleResult } from "../render/settleFrame";
import { tr as trText } from "../i18n/index.ts";

setCostResolver((proj, clipId) => {
  const key = clipIdentityOf(proj).identityKeys[clipId];
  return key ? currentCosts().find((r) => r.identityKey === key) : undefined;
}, () => dualStage());
setBeforeFullStagePush(alignMirrorForStageMedia);

/**
 * Local reuse for single-stage boundary search ("card identity + this machine's environment fingerprint" → single-frame time measured on this machine; `boundarySearch.mjs`).
 * Defaults to page memory; the online page connects it through `setSearchCostStore` to the `costs` table of the in-page snapshot store L2 (same method names `getCost` / `putCost`).
 */
let searchCostStore: CostStore = createMemoryCostStore();
export function setSearchCostStore(store: CostStore): void {
  searchCostStore = store;
}

/**
 * Local reuse for boundary search is connected to the `costs` table of the in-page snapshot store L2 (C10 integration: handoff file section 2.2, item 3). Key shape `<identityKey>|<envFingerprint>`
 * (`localCostKey` in `boundarySearch.mjs`), which does not collide with the key of the background stage K1 records (`<identityKey>\n<device>`, `l2Costs.ts`);
 * these records have no `device`, so they are filtered out when reading K1 records. When L2 cannot be opened (no IndexedDB, or rejected by the browser) it falls back to page memory.
 */
/**
 * The card clips the page itself judges heavy at this moment (the prerender set): the manifest of the manifest plan and the objects that produce sparse streams during measurement both take it.
 * Lists card clips only (media clips produce no prerender output). During export, it must be merged with the synchronous card clips at the original prerender size (when judged light they are not in the prerender set, `export/exportWanted.ts`)
 */
function heavyCardClips(): string[] {
  const plan = currentPlan();
  if (!plan) return [];
  // Cards inside cut segments (the virtual clips of `kernel/cutFlatten.mjs`) are in it too: each produces its own single-card stream, produced only by the render service of the desktop app and the hosted side
  const p = flatPlanProject(getState().project);
  const byId = new Map(p.tracks.flatMap((tr) => tr.clips).map((c) => [c.id, c] as const));
  return [...new Set([...plan.prerenderSet, ...exportWantedClips()])].filter((id) => !!byId.get(id)?.cardId);
}

/** Before and after boundary search and the baseline card measures each card: the on-demand render gate leaves a crash record (`online/stageGate.ts`; a card whose measurement crashed is treated as a heavy card next time) */
const searchMeasureHooks = {
  before: (key: string, cardId: string): void => { stageGate()?.measureStart(key, cardId); },
  after: (_key: string): void => { stageGate()?.measureEnd(); },
};

/** Cards whose measurement crashed (identityKey; from the crash record, unchanged during this use) */
function crashedCards(): ReadonlySet<string> {
  return stageGate()?.heavyCards() ?? new Set();
}

/**
 * Which stages are mounted at this moment: desktop has two (when the port did not come up, legacy has only A and does not go through here); the online page mounts none when it cannot read the stage origin,
 * two for dual stages, and only the cross-origin A when there is only one stage (first level of the stage gate, lowest tier, fallback after a failed handshake).
 */
function mountedStageIds(): StageId[] {
  if (!ONLINE) return [...STAGE_IDS];
  if (!stageOrigins()) return [];
  return dualStage() ? [...STAGE_IDS] : ["A"];
}

/**
 * Scope of the stage's media path IDs (`setScope` in `online/stageIsolation.ts`): path IDs follow the project the media connection is attached to (the cookie holds that project's ticket);
 * `codeProjectId` is the project open at this moment (the card code to send to the stage belongs to it). When the page switches projects in place, the project switches first and the media connection second,
 * and during the stretch in between the two differ: this page does not approve execution, and the new project's card code does not enter a stage document that holds the previous project's path IDs.
 */
function stageSidScope(): StageSidScope {
  const codeProjectId = currentDocProjectId() || null;
  return { accountId: getSyncView().shared?.accountId || null, projectId: remoteAccountProjectId() || codeProjectId, codeProjectId };
}

/** Which stage the audio thread starts on: instance B of dual stages (the background stage, the thread follows the instance), and only A with a single stage */
function soundStageId(): StageId {
  return ONLINE && !dualStage() ? "A" : "B";
}

/** Whether the measurement for the open project has settled: with only one stage, look at boundary search; with two stages, look at the background stage's resident probe */
function measurementSettled(): boolean {
  return planSearch() ? searchJudged() : probeSettledFor(getState().project);
}

/**
 * The media gate result goes to the tier selection policy (`render/mediaTier.ts`): in the lowest tier, video media uses only the small size; video media beyond the decode limit (`online/mediaGate.ts`, measured once at open) uses
 * only the small size. Network speed (pull the small size first, or only the original size) is judged by the stage itself (`render/netSpeed.ts`); the parent page does not supply it.
 */
function mediaGatePolicy(lowest: boolean): Pick<MediaTierPolicy, "smallOnly" | "decodeMaxPixels" | "smallFirst"> {
  return { smallOnly: lowest, decodeMaxPixels: decodeLimit()?.maxPixels ?? null, smallFirst: true };
}

/** Network speed reported by each stage (for the inspection hook) */
const netSpeedByStage: Partial<Record<StageId, { mbps: number | null; samples: number; smallFirst: boolean; at: number }>> = {};

/** Inspection hook: the media gate result */
function mediaGateSnapshot(): unknown {
  return { decode: decodeLimit(), net: { ...netSpeedByStage } };
}

function l2SearchCostStore(): CostStore {
  const fallback = createMemoryCostStore();
  const l2 = () => pageL2().catch(() => null);
  return {
    async getCost(key: string) {
      const s = await l2();
      return s ? s.getCost(key) : fallback.getCost(key);
    },
    async putCost(key: string, rec) {
      const s = await l2();
      if (s) await s.putCost(key, rec);
      else fallback.putCost(key, rec);
    },
  };
}

/*
 * The parent page's online browser mode switch (C10 contract section 9): the same criterion as the stage `StageView` (an online build, or `platform=browser` in the editor page address,
 * which is passed to the stage through `stageSrc`). When on, cards this device cannot run (user cards, media effect cards) are all treated as heavy cards and get prerender output attached
 * (`localOnlyOf` of `snapshotFeed`; `costIdentity.ts` gives them no identity), and when it cannot be attached it is an hourglass, waiting for the render node's result
 * (since 2026-10-21 there is no "local PC assisted render" icon or badge).
 */
try { setOnlineBrowserMode(ONLINE || new URLSearchParams(location.search).get("platform") === "browser"); } catch { /* No location */ }

/*
 * A1's `localHashes`: the set of hashes the **currently connected asset service** reports as `complete`; the tier switch criterion looks only at it
 * (chooseTier in `src/render/mediaTier.ts`; `docs/semantics/mechanism/asset-service.md` "Sync state is asked only of the asset service").
 * It comes from the main document polling `GET media/<hash>/chunks` every 2 seconds (C6.6, `./media/assetTiers.ts`):
 * polling runs while the preview is mounted, and when the set changes it is pushed to both stages (`setLocalHashes`) and read directly by the main document's audio layer.
 */

/**
 * Central preview: video layer + motion graphics render surface, scaled to the container. The playback loop is here too (rAF advances store.t).
 *
 * Motion graphics do not play in this document: they run in the ?stage=1 iframe below (the render surface), whose time is taken over.
 * This side only sends down "which second of the timeline it is now", and the render surface renders that frame. So dragging the playhead to the middle of a clip
 * shows the picture that belongs at that moment, rather than replaying the entrance animation from the start. See src/StageView.tsx for details.
 *
 * Video layer: find the media clip that should be playing with videoClipAt, switch the source when src changes, and seek when the time is off (>0.2s).
 */
export function Preview(props: { variant?: "mobile" | "framed" } = {}) {
  /**
   * `mobile` (`src/mobile/`, `ChatSidePanel.tsx`) and `framed` (Vibe mode `DetailEdit.tsx`) both mount only the
   * picture without Classic mode's 2D/3D tabs, tool row or playback bar (`compact`).
   * `mobile` stays fitted without hijacking wheel scrolling; `framed` enables bounded [100%, 800%] zoom,
   * four-edge-clamped pan, and the top-right percentage + "Fit" control (issue #15).
   */
  const mobile = props.variant === "mobile";
  const framed = props.variant === "framed";
  const compact = mobile || framed;

  const project = useStore((s) => s.project);
  // C6.6: the tier-switch set of the two-tier media (while the preview is mounted, ask the current asset service every 2 seconds)
  const tierList = useTierHashes();
  // The online page has no local editor process or local asset service (c10a section 2: it does not request `/api/*`); tell the polling first, then start it
  useEffect(() => { setNoEditorProcess(ONLINE); return startAssetTiers(); }, []);
  // C6.6 design draft section 9, item 2: when a project is opened, videos whose media exists only at small size
  // but has the original size locally are transcoded in the background
  // Online pages have no local transcoding (the C6.6 transcode runs in the editor process), so skip it
  // At the same time, old media without a hash are added to the library; those the local machine can't fetch are
  // marked "(missing)", and those whose hash is filled in when moved to the cloud go to the upload queue (backfillUpload.ts)
  useEffect(() => (ONLINE ? undefined : startTierBackfill(backfillHooks)), []);
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const playToken = useStore((s) => s.playToken);
  const volume = useStore((s) => s.volume);
  const muted = useStore((s) => s.muted);
  const selection = useStore((s) => s.selection);
  const boxRef = useRef<HTMLDivElement>(null);
  /**
   * The two stage iframes (E1). `A` / `B` **are only instance names, unrelated to roles**: initially A is the
   * visible stage and B is the background stage (`INITIAL_ROLE_OF`). Roles are set only through `setRole`,
   * and after the K5 swap they are reversed.
   * In legacy mode (the default) only A is mounted, same-origin, exactly as it is today.
   */
  const frameARef = useRef<HTMLIFrameElement>(null);
  const frameBRef = useRef<HTMLIFrameElement>(null);
  /*
   * The two stages of the online dual stage (C10 contract section 2): the stage origins come from the runtime config
   * (fetched at page load, `src/online/boot.ts`); if the handshake fails, fall back to a same-origin single stage.
   * Re-render when the state changes (`dualStage()` reads this copy). Until the runtime config has been fetched, do not
   * mount the stage iframes, so they are not first mounted same-origin and then reloaded with a different origin.
   */
  const onlineStages = useSyncExternalStore(subscribeOnlineStages, onlineStageState, onlineStageState);
  /*
   * The tier of this online browser (`src/online/onlineTier.ts`): the stage gate is decided at page load
   * (`online/stageGate.ts`, opened by `boot.ts`). Until it is decided (asking other tabs, reading the crash record),
   * do not mount the stages, the same as when the runtime config has not been fetched yet.
   */
  const tierNow = useSyncExternalStore(subscribeTier, tierState, tierState);
  const stagesPending = ONLINE && (onlineStages.config !== "done" || !tierNow.online);
  const dual = dualStage();
  /**
   * Interim period of the first handshake (`interim` in `stageHandshake.ts`, [ruling 2026-09-30 `claude/stage-handshake`]):
   * if visible stage A has been mounted for 20 seconds without completing the handshake, show the picture from a
   * same-origin single stage first (`dual` is false, the same path as falling back to a single stage). The two original
   * cross-origin iframes are not torn down; they become hidden warm-up iframes and keep loading.
   * Once both complete the handshake, switch back to the dual stage (only once).
   */
  const interim = interimStage();
  /** The first handshake round is still in progress (dual stage waiting for the handshake, or the interim period): the timer is not rebuilt across "dual stage → interim → switch back to dual stage" */
  const handshakeRound = dual || interim;
  /**
   * Picture handover when switching back to the dual stage [ruling]: the same-origin single stage of the interim period
   * stays in place as a cover (no longer connected over RPC, stopped on the last frame), and the new visible stage is
   * not revealed yet. Once it has drawn the current frame for the new project (a short while after the first `setTime`
   * reply, or when the first beat is reported during playback), switch over in one go,
   * waiting at most `STAGE_HANDOVER_MAX_MS`.
   */
  const [handoverDone, setHandoverDone] = useState(false);
  const handover = ONLINE && dual && onlineStages.interimAt !== null && !handoverDone;
  const handoverRef = useRef(handover);
  handoverRef.current = handover;
  /**
   * The visible stage renders the live variant: the dual stage, or the same-origin single stage of an online page
   * (`docs/plan/c10a-contract.md` section 8.1).
   * The playhead following the stage's `frame`, snapshots / suppression delivered over RPC, and the media layer living
   * in the stage are all decided by `live`;
   * only what concerns background stage B (swap, re-run, page-triggered prerender) is still decided by `dual`.
   */
  const live = liveStage();
  const online = singleLiveStage();
  /**
   * The tier of this online browser (`src/online/onlineTier.ts`; semantics `product/platforms.md` "Online browser"):
   * - `single`: only one stage (the stage gate stopped at the first level, the lowest tier, or the handshake failed and
   *   fell back): light/heavy is decided by bounded search (measured on the visible stage),
   *   and when playback stops the visible stage catches up one frame layer by layer;
   * - `lowest`: the lowest tier: no on-demand render during playback (all display tables are judged heavy), media uses
   *   only the small size, and track streams use only the sparse version.
   * Always false on desktop.
   */
  const lowest = ONLINE && lowestTier(tierNow);
  const lowestRef = useRef(lowest);
  lowestRef.current = lowest;
  const single = ONLINE && online && !dual && !stagesPending;
  const singleRef = useRef(single);
  singleRef.current = single;
  /**
   * How to view this canvas: how much it is zoomed, where it is panned, and whether it still auto-fits the window.
   * See preview/viewport2d.ts for the conversion.
   *
   * `scale` is still used in seven or eight places below (hit testing, drag conversion, outline boxes), so a value
   * with the same name is derived here and none of those places needs a single character changed:
   * all they care about is "how many screen pixels one picture pixel takes".
   */
  const [cam, setCam] = useState<View2D>({ scale: 0.4, tx: 0, ty: 0, auto: true });
  const scale = cam.scale;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const camRef = useRef(cam);
  camRef.current = cam;
  /**
   * How large the preview window is. **We compute where the frame sits ourselves**, so this size must always be at hand.
   *
   * We originally wanted to avoid it: the outer element is grid + place-items:center, so the picture is centered by
   * itself, and we would only need to stack a "offset relative to the center" on top.
   * **Testing showed this does not work**: once the frame is taller than the window, the browser no longer centers it
   * and pins the top edge to 0 (grid's safe alignment, to keep content from overflowing out of reach).
   * We tried `align-items: unsafe center` to force true centering: the computed style did change, but the frame still
   * stuck to the top.
   * And "the frame is larger than the window" is exactly the normal state after zooming in, and exactly when dragging
   * is needed most.
   * So we changed it: the frame is absolutely positioned at the top left, its position is computed entirely from
   * frameOrigin, and the browser stays out of it.
   */
  const [boxSize, setBoxSize] = useState<{ width: number; height: number } | null>(null);
  /**
   * The **generation** of render-surface readiness, not a boolean. 0 = not ready yet, then +1 each time a new render
   * surface replaces the old one.
   *
   * Why it can't be a boolean: when the render surface inside the iframe is replaced (hot update reloading the whole
   * page during development, iframe remounted), it is empty and has to receive the project and the time again.
   * But `setStageReady(true)` does not change state when it is already true, so the two effects below (sending the
   * project, sending the time) would not rerun: the picture stays blank until you touch the timeline so that `t`
   * changes. (It was first hit when switching to 3D and back; now the 3D page no longer unmounts 2D, but hot reload
   * is still "a new render surface + an old true".)
   *
   * With a generation, every `pc-stage-ready` brings a new value, so both effects are sure to rerun.
   *
   * `!stageReady` still holds for 0, so the checks below need not change at all.
   */
  const [stageReady, setStageReady] = useState(0);
  /** Rebuild generation of each stage iframe: +1 when the project is replaced in place (`plan.reload`), so React unmounts the old iframe and mounts a brand-new browsing context (clearing the session history) */
  const [stageFrameGen, setStageFrameGen] = useState<{ A: number; B: number }>({ A: 0, B: 0 });
  const tRef = useRef(t);
  tRef.current = t;
  /** Whether play has been sent to the stage since the last wrap-up (pause): at wrap-up, the stage's `stoppedAt` reply is trusted only if playback was really stopped */
  const playedRef = useRef(false);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  /*
   * The preview has two pages. 2D is the final video (what the preview shows = what the export gives), and 3D is "how
   * these things are arranged in space".
   * Each page answers its own question, and they must not accommodate each other: a proxy color block showing up in
   * 2D breaks its contract.
   */
  const [view, setView] = useState<"2d" | "3d">("2d");
  const is3DCut = activeCutKind(project) === "3d";
  useEffect(() => {
    setView("2d");
  }, [project.activeCutId]);
  const show3DScene = is3DCut || view === "3d";
  const scene3DMode: "camera" | "space" = is3DCut && view === "2d" ? "camera" : "space";
  const [pickedTool, setTool] = useState<ToolType>("select");
  // This project was given read-only permission (guest): moving and editing text are writes, so the tool always falls back to "select" (click to select and view parameters only); the two on the toolbar are also grayed out
  const readOnlyProject = useMemberReadOnly();
  const tool: ToolType = readOnlyProject ? "select" : pickedTool;
  const [rects, setRects] = useState<{ clipId: string; left: number; top: number; width: number; height: number }[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clipId: string; cardId: string } | null>(null);
  const [editingText, setEditingText] = useState<{ clipId: string; key: string; value: string; x: number; y: number } | null>(null);
  
  // Records the displacement preview state while using the drag tool
  const [dragPreview, setDragPreview] = useState<{ clipId: string; dx: number; dy: number } | null>(null);
  // While dragging / editing text on the stage: tell the Agent the user is editing this card (A2)
  useUserEditing("stage-move", dragPreview?.clipId ?? null, "drag");
  useUserEditing("stage-text", editingText?.clipId ?? null, "text");

  /**
   * The stage's RPC client (E0): one per iframe instance; when the `pc-stage-ready` handshake arrives, switch to a new
   * one and dispose the old one.
   * Between the main document and the stage there is only postMessage; no more reaching into window.__pcStage inside
   * the iframe.
   * The positioning tool in the right rail gets the same client through stageBridge (D4 page side), and it is
   * registered again each time it is replaced here.
   */
  const rpcRef = useRef<Record<StageId, StageRpcClient | null>>({ A: null, B: null });
  const hostCapsRef = useRef<Record<StageId, HostCapabilities | null>>({ A: null, B: null });
  /** The stages that completed the handshake in this round of the online dual stage (C10 contract section 2: it counts only when both complete; a timeout counts as failure and falls back to the same-origin single stage) */
  const handshookRef = useRef(new Set<StageId>());
  /** The watcher after the online dual-stage handshake (heartbeat lost → reload that stage → if the reload cannot handshake either, fall back to the single stage; `src/online/stageWatch.ts`) */
  const stageWatchRef = useRef<StageWatch | null>(null);
  /** The first-handshake timer of the online dual stage (each stage counts from its own iframe `load`, plus an overall limit; `src/online/stageHandshake.ts`) */
  const handshakeRef = useRef<StageHandshake | null>(null);
  /**
   * Online dual stage: background stage B is mounted only after the iframe `load` of visible stage A [ruling 2026-09-30
   * `claude/stage-handshake`].
   * The two stages each sit on their own origin and each download the main script once; downloading at the same time
   * splits the bandwidth in half. On a slow network, let A take the bandwidth alone first so the user sees a picture
   * first; B's handshake deadline counts from B's own `load`, so it loses nothing.
   * Desktop (local) is not affected and mounts both together as before.
   */
  const [backStageMount, setBackStageMount] = useState(false);
  /** The two cross-origin iframes warmed up during the interim period (the same elements; when switching back to the dual stage they take over as A / B directly, without reloading) */
  const warmRef = useRef<Record<StageId, HTMLIFrameElement | null>>({ A: null, B: null });
  const warmRefOf = useMemo(() => ({
    A: (el: HTMLIFrameElement | null) => { warmRef.current.A = el; },
    B: (el: HTMLIFrameElement | null) => { warmRef.current.B = el; },
  }), []);
  /** The latest `pc-stage-ready` of each stage window (handshakes received during warm-up; when switching back to the dual stage, the handshake is redone from it) */
  const readyByWinRef = useRef(new WeakMap<object, { origin: string; caps: HostCapabilities | null }>());
  /** The handshake handler itself (built in the message effect; the handshake redone when switching back to the dual stage goes through it too) */
  const processReadyRef = useRef<(id: StageId, win: Window, origin: string, caps: HostCapabilities | null) => void>(() => {});
  /**
   * The pile below (dragging, hit testing, heartbeat, beat) all asks about the **visible stage**.
   *
   * It starts as A, but **after the K5 role swap it is no longer** so ask `stageBridge` for "who is `front` right
   * now"; do not hardcode `rpcRef.current.A`. The legacy single stage still works (it registers only one `front`).
   */
  const stage = useCallback((): StageRpcClient | null => frontStage(), []);
  /**
   * The ref of the stage iframe. **The moment it is unmounted, dispose its client and remove it from stageBridge.**
   *
   * Previously the old client was replaced only at the next `pc-stage-ready`, and in between `frontStage()` kept
   * handing out a client pointing at a closed window: requests sent to it were silently dropped by the browser and
   * never answered (this is how 3D page playback got stuck).
   * After removal, `stage()` returns null, and the existing "no stage, don't send yet" branches take over.
   *
   * The callback must be **stable** (built only once with useMemo): if a new function is created on every render,
   * React first calls the old one with null, which would dispose once per render.
   */
  const frameRefOf = useMemo(() => {
    const bind = (id: StageId, holder: React.RefObject<HTMLIFrameElement | null>) => (el: HTMLIFrameElement | null) => {
      holder.current = el;
      if (el) return;
      const client = rpcRef.current[id];
      if (!client) return;
      rpcRef.current[id] = null;
      hostCapsRef.current[id] = null;
      releaseStageClient(client);
      client.dispose();
    };
    return { A: bind("A", frameARef), B: bind("B", frameBRef) };
  }, []);
  /*
   * R9 route 2 (`shared`): the editor document opens **one** GL Worker, and the two stages share it through their own
   * `MessageChannel`.
   * Built lazily: only when the effective route really is `shared`. The ports are handed over after the handshake and
   * before any RPC (see the `pc-stage-ready` part below).
   */
  const sharedGlRef = useRef<SharedGl | null>(null);
  /*
   * The page side of the user cards and media effect cards synced for online execution
   * (`docs/plan/online-card-exec-contract.md` sections 2 and 8): the transpiled bundle, the run state and graphics
   * capabilities reported back by each stage, and the connection to the audio thread.
   * The editor page only transpiles, sends bundles and receives state, and **executes no card code**; the bundle holds
   * only transpiled results, with no credentials or tickets.
   */
  const cardBundlesRef = useRef<BundleResult[]>([]);
  const stageCardStatesRef = useRef<Partial<Record<StageId, Map<string, CardRunState>>>>({});
  const stageGraphRef = useRef<Partial<Record<StageId, StageGraphCapability>>>({});
  const refreshRunStatesRef = useRef<() => void>(() => {});
  const soundLinkRef = useRef<IsolatedSoundLink | null>(null);
  /** Sends the current bundle to one (or both) stages. When this page cannot execute, an empty table is sent (the stage removes what it has loaded). The audio thread starts on only one stage (instance B for the dual stage, A for the single stage): the thread follows the instance, not the role */
  const pushCardBundles = useCallback((only?: StageId) => {
    if (!ONLINE) return;
    // First recompute the scope from the project currently open: when the project changed but the media connection has not switched over yet (or the path ID is about to change), the isolation session immediately rules it non-executable, and the empty table is sent below
    pageStageIsolation(() => onlineStageState().cardExec).setScope(stageSidScope());
    const list: CardBundle[] = cardExecAvailable() ? cardBundlesRef.current.filter((b): b is Extract<BundleResult, { ok: true }> => b.ok).map((b) => b.bundle) : [];
    for (const id of STAGE_IDS) {
      if (only && only !== id) continue;
      const c = rpcRef.current[id];
      if (c) void c.loadUserCards(list, { sound: id === soundStageId() }).catch(() => { /* The iframe is being replaced: the next handshake will resend */ });
    }
  }, []);
  const pushCardBundlesRef = useRef(pushCardBundles);
  pushCardBundlesRef.current = pushCardBundles;
  /*
   * The page-side execution preconditions (`cardRuntime/gate.ts`) are established by the isolation session: the site
   * master switch, the dual-stage handshake, the self-checks of both stages, and the ticket handover
   * (`online/stageIsolation.ts`).
   * The picture half additionally requires that the egress of both stages is blocked by the browser
   * (`egress: "allowlist"`; [ruling, lead session 2026-10-06] on a browser hardened only by scripts the picture does
   * not execute, while the audio thread works as usual).
   */
  useEffect(() => {
    if (!ONLINE) return;
    const sync = () => {
      const s = onlineCardExec();
      setCardExecGate({ site: onlineStageState().cardExec, isolated: s.enabled, reason: s.enabled ? null : s.reason, visual: true });
    };
    const offs = [subscribeOnlineCardExec(sync), subscribeOnlineStages(sync)];
    sync();
    return () => { for (const off of offs) off(); setCardExecGate({ isolated: false, reason: "page unload", visual: true }); };
  }, []);
  /** How many times the tier-selection policy of each stage has been sent (the self-check and ticket handover are asynchronous, and a late older round must not overwrite a newer one) */
  const policySeqRef = useRef<Partial<Record<StageId, number>>>({});
  /** Self-check results sent by each stage window (including warmed-up ones): cleared at handshake, stored when a result arrives; when switching back to the dual stage, they are handed to the isolation session again */
  const isoByWinRef = useRef(new WeakMap<object, IsolationReport | null>());
  const glPortTo = useCallback((id: StageId, win: Window, caps: HostCapabilities | null) => {
    // The route of an online page follows the stage gate (`tierGlRoute`); desktop follows the project options
    if ((ONLINE ? tierGlRoute() : resolveGlRoute(getState().project.glRoute)) !== "shared") return;
    sharedGlRef.current ??= createSharedGl({ compact: !!caps?.compact });
    sharedGlRef.current.connect(win, stageTargetOrigin(id), id);
    if (typeof window !== "undefined") (window as unknown as Record<string, unknown>).__pcSharedGlDiag = () => sharedGlRef.current?.diag() ?? Promise.resolve(null);
  }, []);
  /*
   * c10a section 8: the tier-selection policy (the result of the media gate + the remote asset service of the online
   * page). The main document's own audio layer reads the module-level copy;
   * the stage is another document and gets it through `setMediaPolicy`. **Sent only in online mode**: the desktop
   * runtime uses the defaults on both sides, not a byte changed.
   */
  const pushMediaPolicy = useCallback(async (): Promise<void> => {
    if (!ONLINE) return;
    const base = remoteAssetBase();
    let ticket: string | null = null;
    // While waiting for the ticket, the media connection or the open project changed (A → B): A's ticket must not be handed over under the path ID computed for B, so this round is void (changing the connection or the scope pushes again)
    const scopeKey = () => JSON.stringify([remoteAssetBase(), stageSidScope()]);
    const scopeBefore = scopeKey();
    if (base) { try { ticket = await remoteAssetTicket(); } catch { ticket = null; } }
    if (scopeKey() !== scopeBefore) return;
    const policy: MediaTierPolicy = { ...mediaGatePolicy(lowestRef.current), online: true, remote: base ? { base, ticket } : null };
    setMediaTierPolicy(policy);
    /*
     * Cross-origin stages (C10 contract section 2 "Stage reads media"): always use relative addresses to read the reverse
     * proxy **on their own origin**, and never read the asset service directly across origins
     * (that relies on CORS, and drawing the media into a canvas would taint it).
     *
     * How the ticket is given (contract `online-card-exec-contract.md` section 4.1, `online/stageIsolation.ts`): if this
     * stage passes its self-check and the ticket handover succeeds →
     * the stage reads `/media-s/<sid>/media/<hash>`, the ticket does not go through RPC (the stage origin's server swaps it
     * for an HttpOnly cookie); otherwise as before: the base address is changed to the `/media` path,
     * the ticket is sent over RPC and goes via `?t=` (a stage document like this does not execute user cards). When the
     * asset service is not at `/media/api/asset` on the editor page's origin (another host, another path), there is no
     * such reverse proxy, so as before.
     */
    const iso = pageStageIsolation(() => onlineStageState().cardExec);
    iso.setStages(mountedStageIds());
    iso.setScope(stageSidScope());
    const origins = stageOrigins();
    const stageBase = base ? stageAssetBase(base, location.origin) : null;
    await Promise.all(STAGE_IDS.map(async (id) => {
      const c = rpcRef.current[id];
      if (!c) return;
      const seq = (policySeqRef.current[id] = (policySeqRef.current[id] ?? 0) + 1);
      let stagePolicy: StageMediaPolicy = { smallOnly: policy.smallOnly, decodeMaxPixels: policy.decodeMaxPixels, remote: policy.remote };
      if (base && stageBase) {
        const plan = stageBase === MEDIA_PROXY_BASE && origins
          ? await iso.plan(id, { active: mountedStageIds().includes(id), stageOrigin: origins[id], ticket })
          : { mode: "legacy" as const, base: null, ticket, cardExec: false };
        // While waiting for the self-check and handover, this stage was replaced, or a newer update was started: this round is void
        if (rpcRef.current[id] !== c || policySeqRef.current[id] !== seq) return;
        if (plan.reload) {
          // The stage already took the previous project's path ID: rebuild the iframe element of this slot (new browsing context, clearing session history entries and window.name)
          releaseStageClient(c);
          c.dispose();
          rpcRef.current[id] = null;
          hostCapsRef.current[id] = null;
          setStageFrameGen((prev) => ({ ...prev, [id]: prev[id] + 1 }));
          return;
        }
        stagePolicy = plan.mode === "cookie"
          ? { smallOnly: policy.smallOnly, decodeMaxPixels: policy.decodeMaxPixels, remote: { base: plan.base!, ticket: null }, cardExec: plan.cardExec }
          : { smallOnly: policy.smallOnly, decodeMaxPixels: policy.decodeMaxPixels, remote: { base: stageBase, ticket: plan.ticket } };
      }
      void c.setMediaPolicy(stagePolicy).catch(() => { /* The iframe is being replaced: the next handshake will resend */ });
    }));
  }, []);
  // Whether this page can execute user cards changed (the other stage is also isolated, or a hardening block event occurred): resend the tier-selection policy of both stages
  useEffect(() => {
    if (!ONLINE) return;
    return pageStageIsolation(() => onlineStageState().cardExec).subscribe(() => { void pushMediaPolicyRef.current(); });
  }, []);
  const pushMediaPolicyRef = useRef(pushMediaPolicy);
  pushMediaPolicyRef.current = pushMediaPolicy;
  // The layout changed (handshake failed, fell back to a single stage): the isolation session recomputes executability from the stages currently mounted (a single stage is also isolated cross-origin and still executes user cards)
  useEffect(() => {
    if (ONLINE) pageStageIsolation(() => onlineStageState().cardExec).setStages(mountedStageIds());
  }, [dual, stagesPending]);
  useEffect(() => {
    if (!ONLINE) return;
    void pushMediaPolicy();
    // Resend when the remote asset service changes (entering / leaving a shared project). The ticket is renewed by its own
    // lifetime: resend once when half is left (a 15-minute ticket about every 7 minutes;
    // when a test shortens the ticket lifetime it speeds up accordingly, C10 contract section 12), at most once every 5 minutes
    const off = subscribeRemoteAssets(() => { void pushMediaPolicy(); });
    // The decode limit has been measured (measured once at open): resend once, and video media over the limit switches to the small size
    const offDecode = subscribeDecodeLimit(() => { void pushMediaPolicy(); });
    let timer = 0;
    let alive = true;
    const loop = async () => {
      if (!alive) return;
      await pushMediaPolicy();
      const info = await remoteAssetTicketInfo(false);
      const left = info ? info.exp - Date.now() : 5 * 60_000;
      if (alive) timer = window.setTimeout(() => { void loop(); }, Math.max(1000, Math.min(5 * 60_000, left / 2)));
    };
    timer = window.setTimeout(() => { void loop(); }, 1000);
    return () => { alive = false; off(); offDecode(); window.clearTimeout(timer); };
  }, [lowest, pushMediaPolicy]);
  /*
   * Media gate: leave a crash record before loading the original size (`mechanism/platforms.md` "Media gate"). When the
   * batch of videos in the project that need the original size loaded (not over the decode limit) changes
   * (project opened, new media imported), record "loading media original size" and return to the previous step after
   * `MEDIA_MARK_MS`; if the page crashes during this time, the decode limit is lowered one level at the next load.
   * The lowest tier does not pull the original size and does not record.
   */
  const mediaSigRef = useRef("");
  const decodeReady = useSyncExternalStore(subscribeDecodeLimit, () => decodeLimit() !== null, () => false);
  const mediaMarkTimerRef = useRef(0);
  useEffect(() => {
    // Record only after the stage gate has finished and the baseline card has been measured (so this step does not overwrite the stage gate's steps, and a crash is not attributed to the wrong place)
    if (!ONLINE || lowest || !stageReady || tierNow.gate !== "done" || tierNow.benchmark === "pending") return;
    const g = stageGate();
    const lim = decodeLimit();
    if (!g || !lim) return;
    const sig = originalLoadSignature(project.media ?? [], lim.maxPixels);
    if (!sig || sig === mediaSigRef.current) return;
    mediaSigRef.current = sig;
    g.mediaStart(lim.index);
    window.clearTimeout(mediaMarkTimerRef.current);
    mediaMarkTimerRef.current = window.setTimeout(() => stageGate()?.mediaEnd(), MEDIA_MARK_MS);
  }, [project.media, lowest, stageReady, tierNow.gate, tierNow.benchmark, decodeReady]);
  useEffect(() => () => window.clearTimeout(mediaMarkTimerRef.current), []);
  /*
   * With only one stage, light/heavy is decided by the shared cost record plus bounded search (the effect below); the
   * lowest tier does no on-demand render during playback (all display tables are judged heavy).
   * The judged table decides which clips the manifest plan sends and who renders locally at export (semantics
   * `product/platforms.md` "Online browser", "Light/heavy decision" and "Lowest tier").
   */
  /** Two stages, and the project has records measured by other machines: at open, decide by bounded search (measuring only a few cards in the background stage), and once the resident probe finishes measuring, switch to the cost record (the effect below) */
  const [dualSearch, setDualSearch] = useState(false);
  useEffect(() => {
    setPlanSearch(single || dualSearch);
    return () => setPlanSearch(false);
  }, [single, dualSearch]);
  useEffect(() => {
    setPlanLowest(lowest);
    return () => setPlanLowest(false);
  }, [lowest]);
  /*
   * L4 (C10 contract section 6, section 18 item 1): the per-beat frame-swap cost of heavy layers on an online page goes
   * into the per-beat budget, and at dispatch the fixed per-beat cost of each heavy card is also replaced by it
   * (the same budget on both sides). The lowest tier does not do live render during playback and does not use this set.
   */
  useEffect(() => {
    const on = ONLINE && !lowest;
    // The frame-swap cost of each layer is taken by card kind (measured by swap-tuning, `SWAP_MS_BY_KIND` in `beatSwap.mjs`); an unrecognized card kind uses the default `SWAP_MS`
    setBeatSwap(on, { swapMs: SWAP_MS, occupied: lightCostAt, costOf: on ? layerSwapMs : null });
    setPlanDeadMs(on ? SWAP_MS : null, on ? layerSwapMs : null);
    return () => { setBeatSwap(false, { costOf: null }); setPlanDeadMs(null); };
  }, [lowest]);
  /* C10 contract section 3: the cost records measured by the background stage of an online page are stored in the `costs` table of L2 (`mode=build`, not remeasured after closing and reopening) */
  useEffect(() => {
    if (!ONLINE) return;
    setCostBackend({ ...l2CostBackend(pageL2()), forwardFrames: false });
    /*
     * After measuring, write to the document service (contract section 3, section 18 item 7; handover file section 2.2
     * item 2): when connected to a shared project, relay once on the spot after each card is measured.
     * The `SharedCostRelay` below also backfills from the dispatch table every 5 seconds (those measured before joining
     * the shared project, whose send did not happen here), and using both paths is harmless:
     * the document service keeps the latest by measurement time.
     */
    const diag = { calls: 0, ok: 0, failed: 0, records: 0, lastError: null as string | null };
    const off = onCostRecords((records) => {
      if (!hasDocLink() || !currentSharedLink()) return;
      const projectId = currentDocProjectId();
      if (!projectId) return;
      const input = records.map((r) => toSharedInput(r)).filter((r): r is SharedCostInput => !!r);
      if (!input.length) return;
      diag.calls++;
      void publishSharedCosts({ request: docRequest, projectId, environment: pageEnvironment(), records: input })
        .then((r) => { if (r.ok) { diag.ok++; diag.records += input.length; } else { diag.failed++; diag.lastError = r.error ?? null; } })
        .catch((e) => { diag.failed++; diag.lastError = String(e); });
    });
    const w = window as unknown as Record<string, unknown>;
    w.__pcCostPublish = () => ({ ...diag });
    return () => { off(); setCostBackend(null); delete w.__pcCostPublish; };
  }, []);
  /* When the lowest tier goes to the background, stop the preview (adoption of c10a contract section 13 Q2: background timers and rAF are not guaranteed to continue, and on return it resumes from where it stopped) */
  useEffect(() => {
    if (!ONLINE || !lowest) return;
    const onHide = () => { if (document.visibilityState === "hidden" && getState().playing) actions.pause(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => { document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", onHide); };
  }, [lowest]);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  /*
   * The playback loop. **The playhead stops only on frames the final video really has.**
   *
   * It used to advance continuously by wall clock: on a 60Hz display it pushed 60 values of t per second, while the
   * final video has fps frames, so half of the t values did not exist in the final video at all. This is
   * imperceptible in 2D alone, but it shows as soon as you switch to 3D:
   * there the displayed picture is a prerendered whole frame, the two views could differ by half a frame for the same
   * playhead, and the entrance animation is steepest exactly in that stretch.
   * After quantization, 2D playback shows the very frame the export would write, and 3D pastes the same frame.
   *
   * The accumulator acc must stay unquantized, otherwise the small remainder dropped each frame accumulates and
   * playback gets slower and slower.
   *
   * Playback range = the earliest card ~ the latest card (project.duration is synced by the timeline from the end of
   * the content).
   * If the playhead is not in this range when play is pressed (before the first card, or already played to the end),
   * playback starts from the earliest card.
   */
  const contentStart = contentStartOf(project.tracks);
  /** The stage-side `playing` effect has only three dependencies (see the note there), and the playback start point is read from here */
  const contentStartRef = useRef(contentStart);
  contentStartRef.current = contentStart;
  useEffect(() => {
    /*
     * E6: **this loop does not start when not in legacy mode**: the playhead is advanced by K4's `frame`
     * events (the visible stage ticks per frame on its own and reports after each tick finishes
     * rendering). The wall-clock loop is kept only for `?preview=legacy`.
     */
    if (live) return;
    if (!playing) return;
    const fps = Math.max(1, project.fps || 30);
    let raf = 0;
    let last = performance.now();
    let acc = tRef.current;      // Where playback has actually advanced to (not quantized)
    if (acc < contentStart || acc >= project.duration - 0.5 / fps) {
      acc = contentStart;
      actions.seek(contentStart);
    }
    let wrote = atFrameGrid(acc, fps);  // The frame time handed out last time
    const tick = (now: number) => {
      /*
       * During playback something outside may also seek (clicking the timeline, dragging the playhead);
       * in that case the outside value wins. The criterion is "differs by more than one frame", not
       * "not equal": tRef is only assigned during render, so after quantization the store's t may be one
       * frame behind this one. That is not a seek; treating it as one would make playback step back one
       * frame every few frames.
       */
      if (Math.abs(tRef.current - wrote) > 1.5 / fps) acc = tRef.current;
      acc += (now - last) / 1000;
      last = now;
      if (acc >= project.duration) {
        actions.pause();
        actions.seek(project.duration);
        return;
      }
      wrote = atFrameGrid(acc, fps);
      actions.tick(wrote);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // contentStart is not in the dependencies: moving the first card during playback must not pull the playhead back
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, playing, project.duration, project.fps]);

  /*
   * Measure the window size once and, if "auto fit" is still on, recompute the zoom ratio.
   *
   * Both need doing, for different reasons:
   *   - The window size **must always be tracked**, because we compute where the frame sits
   *     ourselves (see frameOrigin below), and the formula uses the window width and height;
   *   - The zoom ratio is recomputed only in auto mode. It used to be recomputed unconditionally,
   *     which did not matter when there was no manual zoom. Now it does: the user zooms to 200% to
   *     adjust the position of one character, drags the sidebar width (the ResizeObserver fires),
   *     and the view snaps back to fit the window, losing the spot they had just found.
   *
   * useLayoutEffect instead of useEffect: on the first render the window size is not known yet, so
   * the frame is first placed at the top left. Layout effects run synchronously **before** the
   * browser paints and trigger a re-render, so the user never sees that frame.
   */
  const prevFramedLayoutRef = useRef<{ project: Size; box: Size } | null>(null);

  const measureStageBox = (el: HTMLElement, entryRect?: DOMRectReadOnly) => {
    const r = el.getBoundingClientRect();
    if (entryRect && entryRect.width >= 1 && entryRect.height >= 1) {
      return { width: entryRect.width, height: entryRect.height, rect: r };
    }
    // Ancestor entrance animations (e.g. `.ps-detail`'s `scale(0.97)`) shrink `getBoundingClientRect()` without
    // re-firing ResizeObserver when the animation finishes; fall back to unscaled clientWidth/Height when skewed.
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const skewed = cw >= 1 && ch >= 1 && (Math.abs(r.width - cw) > 1 || Math.abs(r.height - ch) > 1);
    return {
      width: skewed ? cw : r.width,
      height: skewed ? ch : r.height,
      rect: r,
    };
  };

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const applyBox = (b: { width: number; height: number }) => {
      if (b.width < 1 || b.height < 1) return;
      const nextBox = { width: b.width, height: b.height };
      const projSize = { width: project.width, height: project.height };
      setBoxSize(nextBox);
      if (framed) {
        const nextCam = resizeFramedView(camRef.current, projSize, prevFramedLayoutRef.current, nextBox);
        prevFramedLayoutRef.current = { project: projSize, box: nextBox };
        camRef.current = nextCam;
        setCam(nextCam);
      } else if (camRef.current.auto) {
        const nextCam = fitView(projSize, nextBox, compact ? 0 : undefined);
        camRef.current = nextCam;
        setCam(nextCam);
      }
    };
    applyBox(measureStageBox(el));
    const ro = new ResizeObserver((entries) => applyBox(measureStageBox(el, entries[0]?.contentRect)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height, view, framed, compact]);

  /** Go back to "fit window". Clicking that badge in the tool row or the top-right framed pill comes here */
  const fitToWindow = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const b = measureStageBox(el);
    if (b.width < 1 || b.height < 1) return;
    const nextBox = { width: b.width, height: b.height };
    const projSize = { width: project.width, height: project.height };
    const nextCam = framed ? framedFitView(projSize, nextBox) : fitView(projSize, nextBox, compact ? 0 : undefined);
    if (framed) prevFramedLayoutRef.current = { project: projSize, box: nextBox };
    camRef.current = nextCam;
    setCam(nextCam);
  }, [project.width, project.height, framed, compact]);

  /*
   * Wheel zoom + drag to pan.
   *
   * Why not React's onWheel: since React 17 the wheel is bound as a **passive** listener, so calling
   * preventDefault inside it not only has no effect but also logs a console warning:
   * the wheel then scrolls the whole panel while it zooms the view. We have to call
   * addEventListener ourselves and explicitly turn passive off.
   *
   * `mobile` (phone editor + side-panel thumbnail) skips wheel/pan binding so scrolling the side panel works
   * normally; `framed` (Vibe DetailEdit) clamps zoom to [100%, 800%] and allows both middle-drag and
   * zoomed-in left-drag panning while keeping all four video edges covering the frame.
   */
  useEffect(() => {
    if (mobile) return;
    const el = boxRef.current;
    if (!el) return;
    const size = { width: project.width, height: project.height };

    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-pc="preview-zoom"]')) return;
      e.preventDefault();
      const m = measureStageBox(el);
      if (m.width < 1 || m.height < 1) return;
      const factor = wheelZoomFactor(e.deltaY, e.deltaMode);
      if (factor === 1) return;
      const sx = m.rect.width > 0 ? m.width / m.rect.width : 1;
      const sy = m.rect.height > 0 ? m.height / m.rect.height : 1;
      const cursor = { x: (e.clientX - m.rect.left) * sx, y: (e.clientY - m.rect.top) * sy };
      const nextBox = { width: m.width, height: m.height };
      const cur = camRef.current;
      const nextCam = framed
        ? framedZoomAt(cur, size, nextBox, cursor, cur.scale * factor)
        : zoomAt(cur, size, nextBox, cursor, cur.scale * factor);
      if (nextCam !== cur) {
        camRef.current = nextCam;
        setCam(nextCam);
      }
    };

    /*
     * Middle-button drag: hold and drag to move the canvas in both Classic and framed modes.
     * In framed mode (`DetailEdit`), where Classic's move/text toolbar is absent, left-button drag (>= 4px)
     * also pans whenever zoomed above 100%, while clicks (< 4px) still select/deselect stage cards.
     */
    const PAN_DRAG_PX = 4;
    let panning = false;
    let leftPending = false;
    let panPointerId = -1;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-pc="preview-zoom"]')) return;
      if (e.button === 1) {
        // On many browsers the middle button means "autoscroll"; if not intercepted, that round scroll cursor pops up
        e.preventDefault();
        panning = true;
        leftPending = false;
        panPointerId = e.pointerId;
        lastX = e.clientX;
        lastY = e.clientY;
        // Capture the pointer so the drag keeps following even outside the preview area
        try { el.setPointerCapture(e.pointerId); } catch { /* Already released */ }
        el.style.cursor = "grabbing";
        return;
      }
      if (framed && e.button === 0) {
        const m = measureStageBox(el);
        if (m.width < 1 || m.height < 1) return;
        if (isFramedFitted(camRef.current, size, { width: m.width, height: m.height })) return;
        leftPending = true;
        panPointerId = e.pointerId;
        startX = lastX = e.clientX;
        startY = lastY = e.clientY;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== panPointerId) return;
      if (leftPending) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < PAN_DRAG_PX) return;
        leftPending = false;
        panning = true;
        try { el.setPointerCapture(e.pointerId); } catch { /* Already released */ }
        el.style.cursor = "grabbing";
      }
      if (!panning) return;
      const m = measureStageBox(el);
      if (m.width < 1 || m.height < 1) return;
      const sx = m.rect.width > 0 ? m.width / m.rect.width : 1;
      const sy = m.rect.height > 0 ? m.height / m.rect.height : 1;
      const dx = (e.clientX - lastX) * sx;
      const dy = (e.clientY - lastY) * sy;
      lastX = e.clientX;
      lastY = e.clientY;
      const nextBox = { width: m.width, height: m.height };
      const cur = camRef.current;
      const nextCam = framed
        ? framedPanBy(cur, size, nextBox, dx, dy)
        : panBy(cur, size, nextBox, dx, dy);
      if (nextCam !== cur) {
        camRef.current = nextCam;
        setCam(nextCam);
      }
    };
    const stopPan = (e: PointerEvent) => {
      if (e.pointerId !== panPointerId) return;
      leftPending = false;
      panPointerId = -1;
      if (!panning) return;
      panning = false;
      try { if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); } catch { /* Already released */ }
      el.style.cursor = "";
    };
    // Middle-button press starts autoscroll by default; auxclick must be intercepted too, or it still fires on release
    const onAux = (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", stopPan);
    el.addEventListener("pointercancel", stopPan);
    el.addEventListener("auxclick", onAux);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", stopPan);
      el.removeEventListener("pointercancel", stopPan);
      el.removeEventListener("auxclick", onAux);
    };
  }, [project.width, project.height, view, mobile, framed]);

  /*
   * Render surface ready: once mounted it posts a message over (carrying J4's host capability table);
   * each time one arrives, create a new RPC client for **that one instance**. When cross-origin,
   * `targetOrigin` must name the stage's origin explicitly (`location.origin` can no longer be used).
   *
   * Right after the handshake, send `setRole` once to match the instance with its role: the stage's
   * own default role is `front`, so if the B iframe does not send it, it receives probes under the
   * identity of `front` (the role gate would block them, but that is a fallback, not the design).
   */
  useEffect(() => {
    const frames: Record<StageId, React.RefObject<HTMLIFrameElement | null>> = { A: frameARef, B: frameBRef };
    /*
     * Online cross-origin stage (contract `online-card-exec-contract.md`, section 3.2): only accept
     * messages whose `event.origin` is the stage origin in the runtime config.
     * The same-origin single stage and the desktop runtime are unchanged and skip this check (there
     * `event.source` is the guard).
     */
    const originOk = (id: StageId, origin: string, crossOrigin: boolean): boolean => {
      if (!ONLINE || !crossOrigin) return true;
      const o = stageOrigins();
      return !!o && origin === o[id];
    };
    const onMessage = (e: MessageEvent) => {
      const type = (e.data as { type?: string } | null)?.type;
      if (type === "pc-stage-isolation") {
        // Self-check results from the cross-origin stage, or hardening blocking something (`online/isolation/stageGuard.ts`): honored only in online mode, and only from the cross-origin stage we mounted ourselves
        if (!ONLINE || !e.source) return;
        const iso = pageStageIsolation(() => onlineStageState().cardExec);
        for (const id of STAGE_IDS) {
          const warm = warmRef.current[id]?.contentWindow;
          const live = mountedStageIds().includes(id) ? frames[id].current?.contentWindow : null;
          if (e.source !== warm && e.source !== live) continue;
          if (!originOk(id, e.origin, true)) return;
          const d = e.data as { report?: unknown; breach?: unknown };
          const breach = sanitizeBreach(d.breach);
          if (breach) { iso.breach(breach); return; }
          const report = sanitizeIsolationReport(d.report);
          isoByWinRef.current.set(e.source, report);
          if (e.source === live && rpcRef.current[id]) iso.report(id, report);
          return;
        }
        return;
      }
      if (type === "pc-stage-cards") {
        // The stage finished re-rendering for the new cards (C6.6 integration 3b, `stageCards.ts`)
        for (const id of STAGE_IDS) if (e.source === frames[id].current?.contentWindow) noteStageCards(id, Number((e.data as { stamp?: number }).stamp) || 0);
        return;
      }
      if (type !== "pc-stage-ready") return;
      const rawCaps = (e.data as { hostCapabilities?: HostCapabilities }).hostCapabilities ?? null;
      // Online page: validate the capability table by shape (messages from the cross-origin stage are untrusted input); the desktop runtime takes it as is
      const readyCaps = ONLINE ? (sanitizeHostCapabilities(rawCaps) as HostCapabilities | null) : rawCaps;
      if (e.source && !ONLINE) readyByWinRef.current.set(e.source, { origin: e.origin, caps: readyCaps });
      // The cross-origin stage prewarmed during the transition period completed its handshake: only record it in the first-handshake timing (no RPC is built; the handshake is completed when switching back to dual stage)
      for (const id of STAGE_IDS) {
        const warm = warmRef.current[id]?.contentWindow;
        if (warm && e.source === warm) {
          if (!originOk(id, e.origin, true)) return;
          readyByWinRef.current.set(warm, { origin: e.origin, caps: readyCaps });
          isoByWinRef.current.delete(warm); // New document: the old self-check results are void
          handshakeRef.current?.ready(id);
          return;
        }
      }
      for (const id of STAGE_IDS) {
        const win = frames[id].current?.contentWindow;
        if (!win || e.source !== win) continue;
        if (!originOk(id, e.origin, dualRef.current || ONLINE)) return;
        readyByWinRef.current.set(win, { origin: e.origin, caps: readyCaps });
        isoByWinRef.current.delete(win);
        processReadyRef.current(id, win, e.origin, readyCaps);
        return;
      }
    };
    processReadyRef.current = (id, win, origin, caps) => {
      {
        /*
         * What role this instance should have right now. **It must not always follow `INITIAL_ROLE_OF`**:
         * after K5's swap, A may already be the background one, and one hot reload would bring it back
         * as `front` and knock out the real visible stage.
         */
        const role = frontIdRef.current === id ? "front" : "back";
        // The newly loaded stage has the latest card code
        noteStageFresh(id);
        rpcRef.current[id]?.dispose();
        // Send the reply to the origin this iframe actually has right now (during the transition period of an origin-switch reload, `stageTargetOrigin` may already be a different one)
        const targetOrigin = origin && origin !== "null" ? origin : stageTargetOrigin(id);
        // Online cross-origin stage: validate replies and events as untrusted input (`online/stageMessageGuard.ts`); the same-origin single stage and the desktop runtime are unchanged
        const untrusted = ONLINE && targetOrigin !== location.origin;
        const client = createStageRpc(win, targetOrigin, { untrusted, maxSec: () => getState().project.duration });
        if (ONLINE) {
          /*
           * Track stream (`docs/plan/browser-stream-task.md`, item 7): the stage on the online page does not fetch stream bytes itself; when the parent page sends the stream plane, it brings along the manifest and the chunks this stage does not have yet (`StreamPlaneSender` / `PushedStreamSource` in `streamPlayer.ts`; for why the stage does not fetch them itself, see the explanation there).
           * It hooks into this stage's RPC client: everything that sends the stream plane (`pumpFeed` below, and the one time at the handover in `stageSwap.ts`) goes through it, so none of them needs changing separately.
           * One ledger per stage; if a call fails (the stage is being swapped), clear the ledger and resend everything next time.
           */
          const sender = new StreamPlaneSender((key) => activeOnlineSource()?.streamPlane(key) ?? null);
          const sendPlanes = client.setStreamPlanes.bind(client);
          client.setStreamPlanes = (planes) => sendPlanes(sender.decorate(planes)).catch((err: unknown) => { sender.reset(); throw err; });
        }
        if (ONLINE) {
          // Isolated session: this one is a new document, so first clear the old self-check results and the fetch strategy; if its results have already arrived (during prewarm), hand them in now
          const iso = pageStageIsolation(() => onlineStageState().cardExec);
          iso.setStages(mountedStageIds());
          iso.handshake(id);
          const stored = isoByWinRef.current.get(win);
          if (mountedStageIds().includes(id) && stored !== undefined) iso.report(id, stored);
        }
        handshookRef.current.add(id);
        // The same-origin single-stage handshake during the transition period does not count as the first handshake (that is another iframe of A)
        if (dualRef.current) handshakeRef.current?.ready(id);
        if (ONLINE && dualRef.current && handshookRef.current.has("A") && handshookRef.current.has("B")) markStageHandshake("ok");
        stageWatchRef.current?.ready(id);
        rpcRef.current[id] = client;
        hostCapsRef.current[id] = caps;
        if (ONLINE) {
          // New document: the runtime status, graphics capabilities and audio thread this one reported before are void; wait for it to report again after it reloads
          delete stageCardStatesRef.current[id];
          delete stageGraphRef.current[id];
          if (id === soundStageId()) soundLinkRef.current?.setState(null);
          refreshRunStatesRef.current();
          client.onEvent((e) => {
            if (rpcRef.current[id] !== client) return;
            if (e.type === "card-states") {
              // When the visual half does not run on this one (`visual: false`) there is no status to speak of: treat it as not reported
              if (e.visual) stageCardStatesRef.current[id] = new Map(e.states); else delete stageCardStatesRef.current[id];
              stageGraphRef.current[id] = e.graph;
              setNodeGraphCapable(STAGE_IDS.every((s) => stageGraphRef.current[s] === "ok"));
              refreshRunStatesRef.current();
            } else if (e.type === "net-speed") {
              netSpeedByStage[id] = { mbps: e.mbps, samples: e.samples, smallFirst: e.smallFirst, at: Date.now() };
            } else if (e.type === "sound-state" && id === soundStageId()) {
              soundLinkRef.current?.setState(e.state);
            }
          });
        }
        // R9 port handover protocol: under route 2, after the handshake and before sending any RPC (including setRole below), hand the GL port over first
        glPortTo(id, win, caps);
        // Register the capability table together: K1's device string needs compact / offscreenGl, and it must be the copy probed by the **stage**
        setStageClient(role, client, caps);
        void client.setRole(role).catch(() => { /* The iframe changed again; the next handshake will resend */ });
        // c10a section 8: the online page hands the fetch policy (the result of the asset gate, the remote asset service) to this stage; the desktop runtime does not send it, and the stage uses its defaults
        if (ONLINE) void pushMediaPolicyRef.current();
        // C10 contract section 9: user cards synced from the content store (which cannot run on this machine) are handed to this stage; the desktop runtime does not send them
        if (ONLINE) void client.setSyncedUserCards([...syncedUserCards().values()]).catch(() => { /* The iframe changed again; the next handshake will resend */ });
        // Online execution: hand the transpiled bundle to this one (queued after the sync table: the stage uses the sync table to spread entry points onto card ids); for a stage whose gate is not open, just remember it for now
        if (ONLINE) pushCardBundlesRef.current(id);
        // Hand the preview zoom factor to the stage: the placeholder (hourglass) compensates by it so it is clearly visible on screen; sent by both desktop and online
        void client.setViewScale(scaleRef.current).catch(() => { /* Same as above */ });
        // +1 each time one arrives: assigning the same value again does not trigger a re-render, while a newly mounted iframe needs to receive project and time again
        if (role === "front") setStageReady((n) => n + 1);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const id of STAGE_IDS) {
        rpcRef.current[id]?.dispose();
        rpcRef.current[id] = null;
        setStageClient(INITIAL_ROLE_OF[id], null);
      }
      sharedGlRef.current?.dispose();
      sharedGlRef.current = null;
    };
  }, [glPortTo]);

  /*
   * First handshake (C10 contract section 2; [ruling 2026-09-30] `claude/stage-handshake`): each stage's 20 seconds
   * count from the `load` of that stage's iframe (on a slow network the stage page alone takes tens of seconds to download, which no longer counts as handshake failure), and there is also an overall cap counted from mounting; when time is up and not all have completed the handshake, fall back to the same-origin single stage as before.
   */
  useEffect(() => {
    if (!ONLINE || !handshakeRound) return;
    // This round only starts timing from `pending` (not rebuilt during the transition period or after switching back; getting here for real means the layout was interrupted for some other reason, so end it as a failure)
    if (onlineStageState().handshake !== "pending") {
      if (onlineStageState().handshake === "interim") markStageHandshake("failed", trText("Handshake timer interrupted during the first handshake in the transition period"));
      return;
    }
    handshookRef.current = new Set();
    const hs = createStageHandshake({
      ids: STAGE_IDS,
      fail: (reason) => {
        console.warn(`[preview] ${reason}, falling back to the same-origin single stage`);
        markStageHandshake("failed", reason);
      },
      ok: () => markStageHandshake("ok"),
      interim: (reason) => {
        console.warn(`[preview] ${reason}`);
        markStageHandshake("interim", reason);
      },
    });
    handshakeRef.current = hs;
    // Stages that already completed the handshake this round (when the effect runs later than the handshake) are recorded all the same
    for (const id of STAGE_IDS) if (rpcRef.current[id]) hs.ready(id);
    const w = window as unknown as { __pcStageHandshake?: () => unknown };
    w.__pcStageHandshake = () => hs.status();
    return () => {
      hs.dispose();
      if (handshakeRef.current === hs) handshakeRef.current = null;
      // Keep the observation port after falling back or switching back (the probe checks the reason and the moment)
      if (hs.phase !== "failed" && hs.phase !== "ok") delete w.__pcStageHandshake;
    };
  }, [handshakeRound]);
  /** `load` of the cross-origin stage iframe (fires for cross-origin too; during prewarm it is this one as well): the first handshake counts from it; B is mounted only after A finishes loading */
  const onStageFrameLoad = useCallback((id: StageId) => {
    handshakeRef.current?.loaded(id);
    // On the online page the background stage is mounted by the stage gate (only after the visible stage is ready and the project is loaded does it try the background stage, in the effect below); desktop mounts it as before once A finishes loading
    if (id === "A" && !ONLINE) setBackStageMount(true);
  }, []);
  /*
   * On-demand render gate (semantics `product/platforms.md` "on-demand render gate"; implementation `mechanism/platforms.md` "on-demand render gate"):
   * - Leave a crash record before measuring each card (the background stage's resident probe and the single stage's bound search both go through here); a card that crashed during measurement is not measured again and is treated directly as a heavy card;
   * - After the stage gate finishes, measure the baseline card first: if even that cannot run, drop to the lowest tier (no on-demand render at all during playback). The lowest tier (not even one stage can hold up) is not measured.
   */
  useEffect(() => {
    if (!ONLINE) return;
    setProbeMeasureHooks({
      before: (key, cardId) => stageGate()?.measureStart(key, cardId),
      after: () => stageGate()?.measureEnd(),
      skip: (key) => crashedCards().has(key),
    });
    setPlanForcedHeavy(crashedCards());
    return () => { setProbeMeasureHooks(null); setPlanForcedHeavy([]); };
  }, [tierNow.online]);
  /*
   * The stages are mounted at this level (the stage gate driver below has finished). For cases within the guard, crashed, or Android under 8 GB (`fixed`), `gate` is `done` as soon as it opens, but the stages are not mounted yet:
   * the baseline card has to wait for them, otherwise measuring before the background stage is up gives no result (semantics "on-demand render gate": after the stage gate finishes, measure the baseline card first).
   */
  const [gateDriven, setGateDriven] = useState(false);
  const benchmarkRunRef = useRef(false);
  const [benchmarkInfo, setBenchmarkInfo] = useState<BenchmarkOutcome | null>(null);
  useEffect(() => {
    if (!ONLINE || benchmarkRunRef.current || !stageReady || tierNow.gate !== "done" || !gateDriven) return;
    benchmarkRunRef.current = true;
    if (tierNow.lowest) { setBenchmark("skipped"); return; }
    const borrow = !dualRef.current;
    void (async () => {
      let out: BenchmarkOutcome;
      if (borrow) {
        out = await runBenchmark({
          borrow: true, stage: frontStage, pushProject: (p) => pushProject("front", p, { reset: true }), currentProject: () => getState().project,
          restore: () => { suppressedRef.current = ""; streamPlanesRef.current = "[]"; markBaselineReset("front"); setStageReady((n) => n + 1); },
          beforeMeasure: searchMeasureHooks.before, afterMeasure: searchMeasureHooks.after,
        });
      } else {
        out = await runBackJob("measure", (ctx) => runBenchmark({
          borrow: false, stage: () => ctx.stage, pushProject: (p) => pushProject("back", p, { reset: true }), currentProject: () => getState().project,
          restore: () => {}, beforeMeasure: searchMeasureHooks.before, afterMeasure: searchMeasureHooks.after,
        })).catch(() => benchmarkVerdict(null));
      }
      setBenchmarkInfo(out);
      if (out.verdict === "slow") stageGate()?.benchmarkSlow();
      setBenchmark(out.verdict === "slow" ? "slow" : out.verdict === "ok" ? "ok" : "skipped");
    })();
  }, [stageReady, tierNow.gate, tierNow.lowest, gateDriven]);

  /*
   * Stage gate (semantics `product/platforms.md` "online browser"; implementation `mechanism/platforms.md` "stage gate steps", items 2-5):
   * visible stage completes the handshake and loads the project → record "visible stage ready"; to try the second level, record "start trying background stage" and then mount B, and once both stages have completed the handshake and loaded the project, record "dual stage loaded";
   * to try the third level, record "start trying one renderer set per stage", switch both in place to route 1 (`setGlRoute`, stages not rebuilt), and record it after the replies; after it finishes, stay
   * at the level reached for the rest of this session. For cases within the guard, crashed, or Android under 8 GB (`fixed`), do not try; just mount the stages at that level. The record of each step is written into the crash record (`stageGate.ts`).
   * Handshake fault tolerance (cannot handshake, or handshakes and then drops, so fall back to a single stage) only covers the current run and leaves no crash record (another effect below).
   */
  const gateRunRef = useRef(false);
  const [gateDiag, setGateDiag] = useState<string>("");
  useEffect(() => {
    if (!ONLINE || !stageReady || gateRunRef.current) return;
    const g = stageGate();
    if (!g) return;
    gateRunRef.current = true;
    const trying = !g.decision.fixed;
    /*
     * `?gateHold=<step>` is for acceptance checks only (`scripts/probes/stage-gate-probe.mjs`): after recording this step, stop and do not go on; meanwhile the probe kills the page process,
     * to verify "crash at this step, reload stops at the next level", or, after slowing the stage down, calls `__pcGateRelease()` to let it through. Without it, everything is as usual.
     */
    const hold = (() => { try { return new URLSearchParams(location.search).get("gateHold"); } catch { return null; } })();
    const mark = async (what: Parameters<typeof g.stage>[0]) => {
      if (!trying) return;
      g.stage(what);
      // Hold until the probe calls `window.__pcGateRelease()` (if it never calls, hold forever: the scenarios that kill the page process)
      if (hold === what) await new Promise<void>((resolve) => { (window as unknown as Record<string, unknown>).__pcGateRelease = resolve; });
    };
    void (async () => {
      try {
        if (trying && hold === "open-visible") await new Promise<never>(() => {});
        await syncProject("front", getState().project);
        await mark("visible-ready");
        g.reached(1);
        if (tierState().target < 2 || !dualRef.current) { g.done(); return; }
        await mark("try-back");
        setBackStageMount(true);
        const back = await whenStageReady("back");
        if (!dualRef.current) return; // The handshake failed and fell back to the single stage (the effect below wraps up)
        await syncProject("back", getState().project);
        await mark("dual-loaded");
        g.reached(2);
        if (tierState().target < 3) { g.done(); return; }
        await mark("try-separate");
        const front = frontStage();
        const results = await Promise.all([front, back].map((c) => c?.setGlRoute("perDocument").catch(() => null) ?? Promise.resolve(null)));
        if (!dualRef.current) return;
        if (results.some((r) => !r)) { g.done(); return; } // Cannot switch over (the stage is being swapped): stay at the second level this time
        await mark("separate-ready");
        g.reached(3);
        // The one shared Worker has no users anymore: release it (at the third level each stage has its own set)
        sharedGlRef.current?.dispose();
        sharedGlRef.current = null;
        g.done();
      } catch (e) {
        setGateDiag(String((e as Error)?.message ?? e).slice(0, 200));
        stageGate()?.done();
      } finally {
        setGateDriven(true);
      }
    })();
  }, [stageReady]);
  /* Handshake fault tolerance: cannot handshake, or handshakes and then drops, so fall back to the single stage (only covers the current run, no crash record; the handshake fault tolerance of semantics "three gates" is unchanged) */
  useEffect(() => {
    if (!ONLINE || onlineStages.handshake !== "failed") return;
    const g = stageGate();
    if (g && tierState().target !== 1) g.fallback(1);
  }, [onlineStages.handshake]);
  /* Viewing port and probe: the results of each gate and the crash records right now (no credentials; the `?gates=1` panel reads the same copy) */
  useEffect(() => {
    if (!ONLINE) return;
    const w = window as unknown as Record<string, unknown>;
    w.__pcGates = () => ({ ...(stageGate()?.snapshot() ?? null), media: mediaGateSnapshot(), benchmark: benchmarkInfo, driverError: gateDiag || null });
    return () => { delete w.__pcGates; };
  }, [gateDiag, benchmarkInfo]);

  /*
   * Switch back to dual stage after the transition period (only once): the two prewarmed iframes have already taken over as A / B (the same elements, not reloaded); complete the handshake again
   * from the `pc-stage-ready` they sent during prewarm (build the RPC, set the role, load the project); the same-origin single stage stays as a cover until the new visible stage has drawn the current frame.
   */
  const handoverTimerRef = useRef<number | null>(null);
  /** Diagnostics: from which moment the switch-back started, why the cover was removed (`setTime` / `frame` / `cap`), and how long after the start it was removed */
  const handoverInfoRef = useRef<{ startedAt: number | null; by: string | null; ms: number | null }>({ startedAt: null, by: null, ms: null });
  const endHandover = useCallback((by: string) => {
    const info = handoverInfoRef.current;
    if (info.by === null && info.startedAt !== null) handoverInfoRef.current = { ...info, by, ms: Math.round(performance.now() - info.startedAt) };
    setHandoverDone(true);
  }, []);
  const finishHandover = useCallback((delayMs: number, by: string) => {
    if (!handoverRef.current || handoverTimerRef.current !== null) return;
    handoverTimerRef.current = window.setTimeout(() => { handoverTimerRef.current = null; endHandover(by); }, delayMs);
  }, [endHandover]);
  useEffect(() => {
    if (!handover) return;
    for (const id of STAGE_IDS) {
      const win = (id === "A" ? frameARef : frameBRef).current?.contentWindow;
      const msg = win ? readyByWinRef.current.get(win) : undefined;
      if (win && msg && !rpcRef.current[id]) processReadyRef.current(id, win, msg.origin, msg.caps);
    }
    handoverInfoRef.current = { startedAt: performance.now(), by: null, ms: null };
    const cap = window.setTimeout(() => endHandover("cap"), STAGE_HANDOVER_MAX_MS);
    return () => window.clearTimeout(cap);
  }, [handover, endHandover]);

  /*
   * Drop after the handshake (C10 contract section 2 "drop after the handshake" [ruling]): the heartbeat of a stage that had handshaken stopped (frozen, or the render process of the cross-origin iframe crashed),
   * first reload that one whole page as before; if it does not handshake back within 20 seconds after the reload (or keeps dropping), take the same path as a first handshake failure and fall back to the same-origin single stage,
   * after falling back the watchdog is void and no more reloads happen (after `markStageHandshake("failed")`, `dual` turns false and this effect wraps up).
   */
  useEffect(() => {
    if (!ONLINE || !dual) return;
    const frames: Record<StageId, React.RefObject<HTMLIFrameElement | null>> = { A: frameARef, B: frameBRef };
    const watch = createStageWatch({
      ids: STAGE_IDS,
      ping: (id) => rpcRef.current[id]?.size() ?? null,
      reload: (id, reason) => {
        const frame = frames[id].current;
        const client = rpcRef.current[id];
        if (client) {
          releaseStageClient(client);
          client.dispose();
          rpcRef.current[id] = null;
          hostCapsRef.current[id] = null;
        }
        console.warn(`[preview] stage ${id} disconnected (${reason}), reloading the whole page for it`);
        if (frame) frame.src = frame.src;
      },
      fallback: (reason) => {
        console.warn(`[preview] ${reason}, falling back to the same-origin single stage`);
        markStageHandshake("failed", reason);
      },
      hidden: () => typeof document !== "undefined" && document.hidden,
    });
    stageWatchRef.current = watch;
    // Stages that already completed the handshake this round (when the effect runs later than the handshake) are watched all the same
    for (const id of STAGE_IDS) if (rpcRef.current[id]) watch.ready(id);
    const w = window as unknown as { __pcStageWatch?: () => unknown };
    w.__pcStageWatch = () => ({ A: watch.status("A"), B: watch.status("B"), reloads: watch.reloads, fellBack: watch.fellBack, handshake: onlineStageState().handshake, reason: onlineStageState().reason });
    return () => {
      watch.dispose();
      if (stageWatchRef.current === watch) stageWatchRef.current = null;
      // Keep the observation port after falling back (the probe checks "no more reloads after falling back"), and only swap the watchdog for the voided one
      if (!watch.fellBack) delete w.__pcStageWatch;
    };
  }, [dual]);

  /*
   * A change of card code generally does not reload the stage (C6.6 integration 3b). It used to be that editing a card bubbled the hot update up to this component, Fast Refresh reran the handshake effect above,
   * cleared the stage's RPC client, and the stage stayed on the old picture, so both iframes had to be fully reloaded every time (`b25f482`). Now the hot update is caught in `cards/index.ts`
   * and does not bubble up here; the stage itself also receives the same hot update, reinstalls the cards and re-renders in the stage, then sends `pc-stage-cards` to report in.
   * Only a stage that has not reported in after the time limit (its code is truly stale) gets that one fully reloaded here (`whenStagesHaveCards` in `stageCards.ts`).
   */
  useEffect(() => {
    const ids: StageId[] = dual ? [...STAGE_IDS] : ["A"];
    return bindStageCards(ids, (id) => {
      const frame = (id === "A" ? frameARef : frameBRef).current;
      if (!frame) return;
      const client = rpcRef.current[id];
      if (client) {
        releaseStageClient(client);
        client.dispose();
        rpcRef.current[id] = null;
        hostCapsRef.current[id] = null;
      }
      console.warn(`[preview] stage ${id} did not pick up the new card code, reloading the whole page for it`);
      frame.src = frame.src;
    });
  }, [dual]);

  /*
   * The project option switched `glRoute` (R9 constraint item 1): when switching to `shared`, hand the port to the stages that already handshook;
   * when switching back to `perDocument` nothing needs sending: on receiving the new project the stage rebuilds the `glHost` side of the connection by the effective route.
   * Re-running the `ProbeGate` overlay (`device` changed) is not here; see the R9 report.
   */
  const glRoute = project.glRoute;
  const glRouteSeen = useRef(glRoute);
  useEffect(() => {
    if (glRouteSeen.current === glRoute) return;
    glRouteSeen.current = glRoute;
    const frames: Record<StageId, React.RefObject<HTMLIFrameElement | null>> = { A: frameARef, B: frameBRef };
    for (const id of STAGE_IDS) {
      const win = frames[id].current?.contentWindow;
      if (win && rpcRef.current[id]) glPortTo(id, win, hostCapsRef.current[id]);
    }
  }, [glRoute, glPortTo]);

  /**
   * Media and audio play by wall clock: when **a tick runs this much slower than its nominal duration**, pause them
   * (K4 / pinned architecture 10; same value as `IN_SYNC_SEC` in `mediaSync.ts`).
   * When the next tick arrives on time they are resumed: this is the "small hitch" the user can feel.
   *
   * The threshold is pinned at a fixed 40 milliseconds, not computed in frames; **what is measured is the "stall", not the
   * total interval between two `frame` events**: a tick naturally takes `1000/fps` milliseconds, and counting that as a hitch treats the normal cadence as a stall.
   * This is especially visible at 24 / 25 fps: on a 60 Hz screen a tick of 41.7 / 40 ms does not fit into 16.7 ms slots,
   * so the actual arrivals alternate 33 / 50 (the tick loop in `StageView.tsx` says so itself),
   * and if judged by the total interval, every other tick would be misjudged as a hitch and the audio would pause and resume every ~80 ms.
   * Judge by "how much it exceeds the nominal tick length": a 50 ms tick at 24 fps exceeds it by only 8.3 ms, and 60 fps dropping one vsync
   * exceeds it by only 16.7 ms, neither reaching 40 ms; while a real hitch (say 300 ms) is still detected on the spot.
   */
  const MEDIA_STALL_MS = 40;
  /** E6: during playback `refreshRects` becomes a timer, so it does not make a round trip every tick */
  const RECTS_POLL_MS = 500;

  /**
   * Whether the media layer / audio is being choked during playback (K4's `mediaStalled`).
   *
   * **Channel hard-wired**: the `playing` prop of `MediaLayers` is changed to `playing && !mediaStalled`, and the stage side syncs via
   * `setPlaying(false)`. Calling `pause()` directly on the element is useless: in every branch of the playing state `planSync`
   * returns `play: paused`, and the next tick gets it `play()`ed back.
   */
  const [mediaStalled, setMediaStalled] = useState(false);
  const stalledRef = useRef(false);
  /** The **actual** arrival moment of the previous `frame` (for the first tick, the starting point is the moment the `play()` reply arrived) */
  const lastFrameAtRef = useRef(0);
  /** Acceptance check port: how many hitches this round of playback judged, and the largest one's excess over the nominal tick length in milliseconds */
  const stallCountRef = useRef(0);
  const gapMaxRef = useRef(0);
  /*
   * "Audio follows the beat" (`mechanism/rendering.md`) requires audio to follow the stage's beat.
   * There used to be two leaks that let sound run ahead:
   *
   * 1. **Between start of playback and the first beat**: as soon as `playing` flips, the main document's
   *    audio starts at once, while the playhead only moves after the stage has received the project,
   *    answered with `play` and rendered the first beat. When the stage starts slowly (project just
   *    opened, heavy cards), sound plays a few hundred milliseconds early, and the drift passes the hard
   *    seek threshold and gets pulled back, replaying it.
   *    `firstBeatRef`: audio is released only once the first beat of this playback run has arrived. It
   *    only governs the main document's audio and does not touch the media layers inside the stage.
   * 2. **Stalls were judged only on arrival**: a late beat was recognized as late only when it arrived,
   *    and audio kept playing through the few hundred stalled milliseconds.
   *    Watchdog: if no next beat shows up within "nominal beat length + 40 ms" after the previous beat
   *    (or the `play` reply), it is treated as a stall on the spot and audio is held;
   *    the criterion is the same as the one on arrival (exceeding the nominal beat length by 40 ms),
   *    it just does not wait for the beat to arrive.
   */
  const firstBeatRef = useRef(false);
  const [, setFirstBeatSeen] = useState(0);
  if (!playing) firstBeatRef.current = false;
  const stallWatchRef = useRef(0);
  const armStallWatch = useCallback(() => {
    window.clearTimeout(stallWatchRef.current);
    if (!playingRef.current) return;
    const beat = 1000 / Math.max(1, getState().project.fps || 30);
    stallWatchRef.current = window.setTimeout(() => {
      if (!playingRef.current || stalledRef.current || !lastFrameAtRef.current) return;
      stallCountRef.current++;
      stalledRef.current = true;
      setMediaStalled(true);
      void frontStage()?.setPlaying(false).catch(() => {});
    }, beat + MEDIA_STALL_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(stallWatchRef.current), []);

  /*
   * Delivery of stream plane / suppression / snapshots (C4, C5, A3c; scheduling is in `snapshotFeed.ts`).
   *
   * Called: after each `frame` is received per beat (while playing), after `setTime` is sent (paused /
   * dragging), before playback starts, after the stage reports `settled`, after the project changes,
   * and after snapshot bytes / newly ready layers arrive. The 33 ms throttle lives in
   * `deliverSnapshots`, so it is safe to call this several times.
   */
  const dualRef = useRef(dual);
  dualRef.current = dual;
  const liveRef = useRef(live);
  liveRef.current = live;
  /** The suppression set last sent (compared as one joined string, to skip sending when unchanged) */
  const suppressedRef = useRef("");
  /** The stream plane last sent (R8; also compared as a string) */
  const streamPlanesRef = useRef("[]");
  /** Which stage the last stream plane was sent to (online page: after a switch it must be resent, since the new stage has no manifest or bytes) */
  const streamPlanesStageRef = useRef<StageRpcClient | null>(null);
  /**
   * Send the stream plane and the suppression set once each (nothing if unchanged), **stream plane
   * first, suppression second**: heavy cards are pasted from the track stream, whether playing, paused
   * or dragging (mechanism/rendering.md "Heavy pipeline: prerender"). When the stage receives
   * suppression, a card whose stream has not drawn its first frame yet does not hide its previous
   * picture (`streamWaiting` in `StageView`), so the stream plane has to arrive first. In the reverse
   * order that layer would be empty for a moment.
   *
   *   - Playing: all heavy cards are suppressed, and the stream plane is sent for those with a stream
   *     for this frame.
   *   - Paused / dragging: heavy cards that have a stream for this frame but have not caught up to the
   *     exact live render are suppressed and pasted from the stream; those already caught up are not
   *     suppressed, and the stream plane is still sent, so the stage can decode the frame under the
   *     playhead first (the first beat after starting playback is ready at once). Heavy cards without
   *     a stream go to the scrub pending placeholder (pure remotion cards that can be rendered live are
   *     rendered live directly).
   *   - **Exception when there is only one stage** (no background stage to catch up to exact and then
   *     swap): when paused or dragging, heavy cards are always suppressed: the subtree is hidden, not
   *     rendered live, and the track stream is pasted (the lowest tier pastes the first frame of each
   *     segment, and `snapshotFeed` gives the stream plane a `first`); with no stream the stage shows
   *     a placeholder; after stopping, the stage catches up layer by layer to an exact live render
   *     (`settleLayersAt`), and layers already drawn are no longer hidden by suppression.
   */
  const syncPlanes = useCallback((s: StageRpcClient, head: { project: ReturnType<typeof getState>["project"]; t: number; playing: boolean; single: boolean; sparseOnly: boolean }) => {
    const planes = streamPlanesAt(head);
    /*
     * Online page: stream manifests and bytes are sent to the stage along with the stream plane (see
     * `StreamPlaneSender` at the handshake). When there is a stream plane, the online source's
     * `streamRev` is also included in the comparison key: when the same segment switches files (a sparse
     * segment replaced by a full-density one) the ready ranges do not change at all, so comparing ranges
     * alone would not resend; it must also be resent when the visible stage is swapped for another one.
     */
    const pushed = ONLINE && planes.length > 0;
    const planesKey = JSON.stringify(planes) + (pushed ? `#${activeOnlineSource()?.streamRev ?? 0}` : "");
    if (planesKey !== streamPlanesRef.current || (pushed && streamPlanesStageRef.current !== s)) {
      streamPlanesRef.current = planesKey;
      streamPlanesStageRef.current = s;
      void s.setStreamPlanes(planes).catch(() => {});
    }
    const want = (!head.playing && head.single ? suppressedAt({ ...head, playing: true }) : suppressedAt(head)).join("|");
    if (want !== suppressedRef.current) {
      suppressedRef.current = want;
      void s.setSuppressed(want ? want.split("|") : []).catch(() => {});
    }
  }, []);
  /** `at`: instead of the store's current playhead, deliver once for the given time and play state (before playback starts: at the start second, treated as playing) */
  const pumpFeed = useCallback(async (at?: { t: number; playing: boolean }) => {
    // The bound search is occupying the only stage for measurement: no snapshots delivered, no suppression sent (restore redelivers after measuring)
    if (!liveRef.current || costSearchMeasuring()) return;
    const s = frontStage();
    if (!s) return;
    const head = { project: getState().project, t: at?.t ?? tRef.current, playing: at?.playing ?? playingRef.current, single: singleRef.current, sparseOnly: singleRef.current };
    if (head.playing) clearSettled("front", "playing");
    /*
     * The second paused-state path (swap after the background stage re-runs the whole scene) is running:
     * this time suppression and the stream plane are left alone. At the swap step the new visible stage
     * is already an exact live render, while "the whole stage is exact" (`markAllSettled`) is only
     * recorded a few replies later. Resending in between as "not yet exact" would overwrite the new
     * visible stage with the stream plane.
     * If the user drags again meanwhile, `sendSetTime` still sends as usual (it does not go through here).
     */
    const holdForSwap = !head.playing && !head.single && swapInFlight();
    if (!holdForSwap) syncPlanes(s, head);
  }, [syncPlanes]);
  const pumpRef = useRef(pumpFeed);
  pumpRef.current = pumpFeed;

  /*
   * The ready index of C3: the SSE connection from the page directly to the prerender process
   * (`snapshotSource.ts`).
   *
   * **Edits do not reconnect or clear the table** (root cause E): each time the project changes, this
   * only checks the session (the mirror may have just started, or the project was switched), and does
   * nothing for the same session. The cleanup function used to hang on the effect that depends on
   * `project`: every edit first called `stopSnapshotFeed()`, wiping the ready index, byte cache and
   * delivery baseline, then reconnected, and in the gap during reconnection heavy cards that were
   * playing turned fully transparent.
   * Split into two: the session check runs with `project`, and the teardown only runs when `dual`
   * changes / on unmount.
   */
  // The online page has no prerender process (no SSE ready index): with two stages the snapshot source is still the online implementation below
  useEffect(() => {
    if (!dual || ONLINE) return;
    syncSnapshotSubscription(() => { void pumpRef.current(); });
  }, [dual, project]);
  useEffect(() => {
    if (!dual || ONLINE) return;
    return () => stopSnapshotFeed();
  }, [dual]);

  /*
   * c10a section 9 "Online page pull": the online page has no prerender process, and the picture of
   * heavy layers is the prerender output (track stream) that render nodes push to the asset service.
   * The snapshot source is replaced with the online implementation (`OnlineSnapshotSource` in
   * `snapshotSource.ts`: using the content store's layer table and manifest, it fetches `px/<hash>`
   * with a read-only ticket); the C3 messages it emits merge straight into the ready index of
   * `snapshotFeed`, so the whole consumption path of frame selection, fallback and delivery needs not
   * a single line changed.
   * Once the small bitmaps arrive it redelivers by itself (the arrival callback of `snapshotFeed` is
   * only attached on the SSE path).
   */
  const onlineSourceRef = useRef<OnlineSnapshotSource | null>(null);
  /** This page's manifest plan publisher (this page's stream production asks it "has this version of the plan been sent out, and is any node picking it up"; task brief "A2") */
  const planPublisherRef = useRef<PlanPublisher | null>(null);
  useEffect(() => {
    if (!online) return;
    /*
     * C10 contract sections 4 and 5: fetch the prerender at original size (`snap/<hash>`, by layer table
     * v 2 and the manifest) into the in-page snapshot store L2; with only one stage (lean mode, lowest
     * tier) it opens by `small` (the track stream is pasted only as the sparse version and fewer stream
     * bytes are kept in memory; `snapshotSource.ts` file header item 7; `mechanism/platforms.md` "Three
     * gates").
     */
    const src = new OnlineSnapshotSource({
      request: docRequest, assetBase: remoteAssetBase, authHeaders: assetAuthHeaders,
      /*
       * Layers of user cards and media effect cards fetch manifests and bytes just like built-in cards
       * (C10 contract section 9, no longer exempt since 2026-09-29); in addition, manifests of whole
       * segments are all fetched, from which the timeline judges "does the prerender output cover the
       * whole segment" (badge).
       */
      coverageLayer: (clipId) => localOnlyOf(getState().project).has(clipId),
    }, { tier: singleRef.current ? "small" : "original", store: pageL2() });
    onlineSourceRef.current = src;
    setActiveOnlineSource(src);
    setCoverageSource(src);
    setSnapshotSource(src);
    // After the frame that was missing at delivery time is fetched, deliver again (a paused page has no other event that would deliver)
    setSnapshotArrive(() => { void pumpRef.current(); });
    src.onFetched = () => { void pumpRef.current(); };
    const off = src.subscribeReady("online", 0, (m) => {
      applyReadyMessage(currentReadyIndex(), m);
      if (m.type !== "done") void pumpRef.current();
    });
    src.setProject(getState().project.id || null);
    src.setInputs(getState().project);
    src.focus(tRef.current, getState().project.fps || 30);
    const resume = () => {
      if (document.visibilityState === "visible") src.focus(tRef.current, getState().project.fps || 30);
    };
    document.addEventListener("visibilitychange", resume);
    if (typeof window !== "undefined") (window as unknown as Record<string, unknown>).__pcOnlineSnapshots = () => src.debug();
    return () => {
      off();
      document.removeEventListener("visibilitychange", resume);
      src.stop();
      onlineSourceRef.current = null;
      setActiveOnlineSource(null);
      setCoverageSource(null);
      stopSnapshotFeed();
    };
  }, [online, single]);
  /*
   * stale-layer: each time the project changes (changed on this page, or synced over after another
   * member changed it), hand it to the online source. The source computes each clip's input signature
   * from it and compares with the `inputSig` recorded for each layer in the layer table: old-parameter
   * layers that do not match are withdrawn immediately (ready ranges sent empty, so the next delivery
   * no longer pastes them; user cards and media effect cards show an hourglass, built-in heavy cards
   * follow the online page's fallback), and after render nodes rewrite the layer table for the new
   * input, the new result is swapped in as usual; if parameters are changed back and the original
   * layer is still there, it is pasted again.
   * Placed after the effect that builds the source: in the same commit the source is built first and
   * then the project is handed over.
   */
  useEffect(() => {
    if (!online) return;
    onlineSourceRef.current?.setInputs(project);
  }, [online, single, project]);
  /*
   * C10 contract section 9 "Identification": the online page reads this project's content store card
   * source (`card-source`, key prefix `src/cards/user/`) through the same document service connection,
   * parses out each card's id and name, and enters them in the registry as "known but cannot run on
   * this machine" entries (`sync/onlineCardSources.ts`). It refetches periodically; when the
   * connection changes (reconnect, project switch) the table is cleared and refetched. When the table
   * changes it is sent to both stages (a stage is a separate document with its own registry).
   */
  useEffect(() => {
    if (!online) return;
    /*
     * Measurement starts only after the card source has synced for the first time (`measureGate.ts`):
     * before that, synced cards are treated as unknown ids, and the background stage might measure one
     * once. The gate opens once the first sync has a result (success or failure); it waits at most
     * `MEASURE_GATE_MAX_MS`. The desktop app does not close this gate.
     */
    const linkKey = () => (hasDocLink() ? currentSharedLink() : null);
    // The gate is per connection: after a project / connection switch it closes again when queried, waiting for the new connection's card source to finish syncing (`measureGate.ts`)
    setMeasureGateLink(linkKey);
    holdMeasureForCardSources();
    const sources = new OnlineCardSources({
      request: docRequest, linkKey,
      // Controls and defaults that user card source imports from built-in modules: use the copy the page itself carries (`src/cards/builtinSourceExports.ts`)
      builtins: builtinSourceExports, sourceFiles: builtinCardSourceFiles,
      onFirstSettled: (ok, link) => releaseMeasureGate(ok, link),
      /*
       * Online execution of synced user cards and media effect cards (`docs/plan/online-card-exec-contract.md`
       * sections 1 and 8): when this page can execute (`cardRuntime/gate.ts`, raised by the stage's
       * isolation self-check), transpile the source into a bundle. The transpiler is loaded on demand, and
       * pages that cannot execute do not fetch it. Editor pages only transpile and do not execute.
       */
      bundling: {
        enabled: cardExecAvailable,
        // Decided at compile time: in desktop builds this whole line is cut, so the transpiler block does not enter the desktop output
        run: (job) => (import.meta.env.VITE_PC_ONLINE === "1" ? import("../online/cardRuntime/transpile.browser").then((m) => m.bundleCards(job)) : Promise.resolve([])),
        onBundles: (results) => { bundles = results; cardBundlesRef.current = results; refreshRunStates(); pushCardBundlesRef.current(); },
      },
    });
    let bundles: BundleResult[] = [];
    /*
     * Run state of each synced card on this page (the parameters panel, badges and light/heavy
     * classification read `registry.cardRunState`): what the page itself knows (no isolated environment,
     * transpile failed) merged with what the attached stages report back (loaded successfully, load
     * error, insufficient graphics capability, media cannot be decoded, runtime error). A card counts as
     * runnable only if all attached stages report it can run (two for dual stages, one for a single stage).
     */
    const refreshRunStates = () => {
      setCardRunStates(editorRunStates({
        cards: syncedUserCards().values(), available: cardVisualExecAvailable(), blockedDetail: cardExecBlockedDetail(), bundles,
        stages: mountedStageIds().map((id) => stageCardStatesRef.current[id]), stageCount: Math.max(1, mountedStageIds().length),
      }));
    };
    refreshRunStatesRef.current = refreshRunStates;
    // The audio thread (a dedicated background thread started by instance B in dual-stage mode, or by A in single-stage mode) is connected as the isolated host of `cardAudio.ts`; it counts as connected only once the stage has reported audio state
    const soundLink = createIsolatedSoundLink({
      render: (request) => {
        const c = rpcRef.current[soundStageId()];
        return c ? c.synthCardAudio(request) : Promise.reject(new Error(trText("The stage that started the audio thread is gone")));
      },
    });
    soundLinkRef.current = soundLink;
    const offGate = subscribeCardExecGate(() => {
      // This page can no longer execute (hardening blocked something, or the site was shut down): the state reported by stages and the audio thread are void
      if (!cardExecAvailable()) { stageCardStatesRef.current = {}; stageGraphRef.current = {}; setNodeGraphCapable(false); soundLink.setState(null); }
      refreshRunStates();
      pushCardBundlesRef.current();
      void sources.sync();
    });
    const offStates = onSyncedUserCardsChanged(refreshRunStates);
    const push = () => {
      const entries = [...syncedUserCards().values()];
      for (const id of STAGE_IDS) {
        const c = rpcRef.current[id];
        if (c) void c.setSyncedUserCards(entries).catch(() => { /* The iframe is being replaced: the next handshake will resend */ });
      }
    };
    const offChange = onSyncedUserCardsChanged(push);
    const timer = window.setInterval(() => { void sources.sync(); }, CARD_SOURCE_POLL_MS);
    void sources.sync();
    const w = window as unknown as Record<string, unknown>;
    w.__pcCardSources = () => sources.debug();
    w.__pcCardSourcesSync = () => sources.sync();
    w.__pcCardExecDiag = () => ({
      available: cardExecAvailable(), visual: cardVisualExecAvailable(),
      run: Object.fromEntries([...syncedUserCards().values()].map((c) => [c.id, cardRunState(c.id) ?? null])),
      bundles: bundles.map((b) => ({ entry: b.entry, ok: b.ok, state: b.ok ? null : b.state.state })),
      stages: Object.fromEntries(STAGE_IDS.map((id) => [id, { graph: stageGraphRef.current[id] ?? null, states: [...(stageCardStatesRef.current[id] ?? [])] }])),
    });
    return () => {
      window.clearInterval(timer); offChange(); offGate(); offStates(); sources.stop(); setCardRunStates([]);
      refreshRunStatesRef.current = () => {}; soundLinkRef.current = null; soundLink.dispose(); cardBundlesRef.current = []; stageCardStatesRef.current = {}; stageGraphRef.current = {};
      setNodeGraphCapable(false);
      delete w.__pcCardSources; delete w.__pcCardSourcesSync; delete w.__pcCardExecDiag;
    };
  }, [online]);
  /*
   * The preview zoom factor changed, sent to both stages (placeholders compensate accordingly: the
   * hourglass keeps its original size on screen).
   * Sent once more at handshake (see the `pc-stage-ready` part). Sent on both desktop and online.
   */
  useEffect(() => {
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (c) void c.setViewScale(scale).catch(() => { /* The iframe is being replaced: the next handshake will resend */ });
    }
  }, [scale]);
  useEffect(() => {
    if (!onlineBrowserMode()) return;
    const refresh = () => {
      // planDispatch recomputes currentPlan with queueMicrotask within the same batch of notifications; redeliver the stream plane and suppression set once after it,
      // so synced user cards that have just become ready are unsuppressed on the spot (no need to wait for the user to click play or drag the timeline)
      queueMicrotask(() => { void pumpRef.current(); });
    };
    const offSynced = onSyncedUserCardsChanged(refresh);
    const offRun = onCardRunStatesChanged(refresh);
    return () => { offSynced(); offRun(); };
  }, [online]);
  /*
   * C10 contract section 7: the queue reports task.done (the manifest plan published by this page, or the subtasks split from it, finished): refetch the layer table and manifest at once, and the new snapshot is swapped in on the next beat.
   * M7 D12: the result key of task.done is deemed alive, and task.failed { error: 'superseded' } means another copy is alive (not a failure); the online source uses this to choose candidates of layer table v 3.
   */
  useEffect(() => {
    if (!online) return;
    return subscribeQueueEvents((m) => {
      if (m.type !== "task.done" && m.type !== "task.failed") return;
      onlineSourceRef.current?.noteQueueEvent(m);
      if (m.type === "task.done") onlineSourceRef.current?.refresh();
    });
  }, [online]);
  /*
   * M7 (contract section 2): for an online page whose identity is computer, the background stage doubles as a pure-browser render node when idle. Whether to act as a node is judged by the host on every beat from conditions
   * (online build with the code version embedded, identity is computer, not the lowest tier, both cross-origin stages have handshaken, Chromium, connected to the cloud project as a member, measurement settled).
   * A page whose identity is phone and which has only one stage does not act as a node, and only produces the sparse version for this page (`ownSparseOnly` in `browserNodeHost.ts`).
   */
  useEffect(() => {
    if (!online) return;
    return startBrowserNodeHost({
      eligibility: () => ({
        online: ONLINE,
        codeVersion: CODE_VERSION,
        phone: phoneIdentity(),
        lowest: lowestRef.current,
        // Opened with two stages but not all handshaken yet (the stage gate is still trying the background stage) is `pending`: not acting as a node, and not counted as having one stage either (otherwise this page's stream production would assume it only produces the sparse version and not wait for the plan)
        stageLayout: !dualRef.current ? "single" : onlineStageState().handshake === "ok" ? "dual" : "pending",
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
        member: !!currentSharedLink() && hasDocLink(),
        measured: measurementSettled(),
      }),
      projectId: () => (currentSharedLink() ? currentDocProjectId() || null : null),
      onAlive: (resultKey) => onlineSourceRef.current?.markAlive(resultKey),
      // This page's stream production (task brief "A2"): when no splittable node online picks up this page's manifest plan, this page itself produces single-card streams (the criterion is in `online/pageStreams.ts`)
      pagePlan: () => planPublisherRef.current?.current() ?? null,
      planState: () => planPublisherRef.current?.probe() ?? Promise.resolve(null),
      // This stream now exists (produced by this page, or found on a first check): do not wait for the next polling round, refetch the layer table and manifest at once
      onPageStream: () => onlineSourceRef.current?.refresh(),
      // Produce the sparse version at measurement time: the clips classified as heavy right now (same algorithm as the manifest plan's manifest), and the currently confirmed version
      heavyClips: () => (singleRef.current ? [...(judgedPlan()?.prerenderSet ?? [])].sort() : heavyCardClips()),
      confirmed: () => {
        const ds = currentSharedLink()?.ds;
        return ds?.confirmedProject && typeof ds.rev === "number" ? { rev: ds.rev, project: ds.confirmedProject } : null;
      },
      restore: () => {
        suppressedRef.current = "";
        streamPlanesRef.current = "[]";
        markBaselineReset("front");
        setStageReady((n) => n + 1);
      },
    });
  }, [online]);
  /*
   * C10 contract section 7, section 18 item 9: the online page publishes its own manifest plan (sent at every tier, always with normal priority; the former `backfill` priority 2026-10-07 "for prerender tasks on weak devices" was revoked)
   * --- sent after measurement settles, debounced, and resent on every project change (the version confirmed by the document service changed) or manifest change; the manifest is the clips this page classified as heavy (the prerender set). User cards and media effect cards that this device cannot run are always classified as heavy (`costIdentity.ts`),
   * and still enter the manifest, to be claimed by render nodes such as the desktop app (C10 contract section 9, no longer removed since 2026-09-29). No error is reported if nobody claims them.
   */
  useEffect(() => {
    if (!online) return;
    const clips = heavyCardClips;
    // The hosted-side render node's "generate track stream" (task brief "A3"): when this page sees it turned on, the manifest plan carries this item (it is a different plan); when it goes from off to on, resend at once,
    // so the render node splits again and produces its own stream task, without waiting for the next project change
    const streamsOn = () => { const v = getSyncView(); return hostedStreamsOn(v.shared?.where, v.hosted); };
    let lastStreams = streamsOn();
    const publisher = createPlanPublisher({
      request: docRequest, publisherId: `page-${pageSession()}`, clips, codeVersion: CODE_VERSION, streams: streamsOn,
      // M7: when this page acts as a pure-browser node, this version of the manifest plan is sent only after the node finishes reporting in (gets its fingerprint), for at most 3 s (contract section 3.3)
      nodeReady: browserNodeReady,
      // M7 D6: before sending, keep this version of the confirmed project in memory by version number, and use the version of the task's projectRev when executing subtasks
      onPublish: () => {
        const ds = currentSharedLink()?.ds;
        if (ds) keepConfirmedProject(ds.rev, ds.confirmedProject);
      },
    });
    planPublisherRef.current = publisher;
    const offNodeReady = subscribeBrowserNodeReady(() => publisher.nodeChanged());
    let link: unknown = null;
    let lastKey = "";
    const version = () => ({ projectId: currentDocProjectId() || null, projectRev: currentSharedLink()?.ds.rev ?? null });
    const check = () => {
      const shared = currentSharedLink();
      if (shared !== link) { link = shared; publisher.reset(); }
      if (!shared || !measurementSettled()) return;
      const v = version();
      const key = `${v.projectId}@${v.projectRev}|${clips().sort().join(",")}`;
      const streamsNow = streamsOn();
      const turnedOn = streamsNow && !lastStreams;
      lastStreams = streamsNow;
      if (key === lastKey) { if (turnedOn) publisher.streamsOn(); return; }
      const first = !lastKey;
      lastKey = key;
      if (first) publisher.measured(v);
      else publisher.changed(v);
    };
    const offProbe = onProbeProgress(() => check());
    const timer = window.setInterval(check, 1000);
    check();
    const w = window as unknown as Record<string, unknown>;
    w.__pcPlanPublisher = () => publisher.debug();
    return () => { offProbe(); offNodeReady(); window.clearInterval(timer); publisher.dispose(); if (planPublisherRef.current === publisher) planPublisherRef.current = null; delete w.__pcPlanPublisher; };
  }, [online]);
  useEffect(() => { onlineSourceRef.current?.setProject(project.id || null); }, [project.id]);

  /*
   * Light/heavy classification with two stages (on-demand render gate; semantics `product/platforms.md` "Light/heavy classification": when the project already has timings measured by another machine, sort by them and use binary search to measure only a few cards to draw the line):
   * when a project opens, the resident probe waits first (`holdProbe`). After the benchmark card is measured, card source has synced and the shared project is connected, read this project's cost records:
   * - Not a single one matches the cards in the project: the resident probe measures card by card under the mask as before (`releaseProbe({ blocking: true })`);
   * - There are records: the bound search measures only a few cards in the background stage (under the mask, `borrow: false`, queued in the background stage's single-flight queue), and once the line is drawn, light/heavy is judged by it; among the measured cards, those classified as heavy
   *   keep the mask up as before and get their sparse version produced right away (the same hook as the resident probe, `runCardMeasuredHook`; `mechanism/rendering.md` "Measurement"), while those not measured (classified as heavy by the line from records)
   *   are produced when idle; the resident probe then finishes measuring the remaining cards in the background (not blocking the UI; it fills in the records that K3/K5 need), and once done the dispatch table switches to judging by cost records.
   * If the records cannot be read (not connected, rejected), retry after one beat; after 40 beats the resident probe measures card by card as before.
   */
  const dualSearchRef = useRef<"idle" | "deciding" | "searched" | "probe">("idle");
  useEffect(() => {
    if (!online || !dual || lowest) return;
    if (dualSearchRef.current !== "idle") return;
    dualSearchRef.current = "deciding";
    holdProbe();
    let disposed = false;
    let waited = 0;
    const release = (blocking: boolean, next: "searched" | "probe") => { dualSearchRef.current = next; releaseProbe({ blocking }); };
    const tick = async () => {
      if (disposed || dualSearchRef.current !== "deciding") return;
      if (++waited > 40 && waited < 1000) { waited = 1000; release(true, "probe"); return; }
      const t = tierState();
      if (t.gate !== "done" || t.benchmark === "pending" || !measureGateOpen()) return;
      if (t.lowest) { release(true, "probe"); return; }
      const shared = currentSharedLink();
      const projectId = currentDocProjectId();
      if (!shared || !hasDocLink() || !projectId || !((shared.ds?.rev ?? 0) > 0) || !backStage()) return;
      dualSearchRef.current = "searched"; // This beat is working; other beats cannot enter
      const project = getState().project;
      const identity = clipIdentityOf(project);
      let listed: Awaited<ReturnType<typeof listSharedCosts>>;
      try { listed = await listSharedCosts({ request: docRequest, projectId, environment: pageEnvironment() }); }
      catch { dualSearchRef.current = "deciding"; return; }
      const keys = new Set(Object.values(identity.identityKeys));
      if (!listed.records.some((r) => keys.has(r.identityKey))) { release(true, "probe"); return; }
      const crashed = crashedCards();
      const unsupported = (clip: { id?: string; cardId?: string }) => needsLocalPc(clip.cardId, clip.cardId ? getCard(clip.cardId) : undefined)
        || (!!clip.id && crashed.has(identity.identityKeys[clip.id] ?? ""));
      setSearchCostStore(l2SearchCostStore());
      setDualSearch(true);
      try {
        const outcome = await runBackJob("measure", (ctx) => runCostSearch({
          request: docRequest, projectId, project, environment: pageEnvironment(), identityKeys: identity.identityKeys, capabilities: identity.capabilities, unsupported,
          stage: () => ctx.stage, borrow: false, pushProject: (p) => pushProject("back", p, { reset: true }), currentProject: () => getState().project, restore: () => {},
          store: searchCostStore, mode: import.meta.env.DEV ? "dev" : "build",
          beforeMeasure: searchMeasureHooks.before, afterMeasure: searchMeasureHooks.after,
          publish: (records) => publishSharedCosts({ request: docRequest, projectId, environment: pageEnvironment(), records }),
        }));
        if (disposed) return;
        const latest = getState().project;
        setPlanSearchLight(latest === project ? outcome.light : reclassify(outcome, latest, clipIdentityOf(latest).identityKeys, unsupported));
        // Measured cards: those classified as heavy get their sparse version produced right away (the mask stays up as before; whether to classify as heavy, whether to produce and how long to wait is decided by the receiving side, the same set as the resident probe's round)
        const measured = [...outcome.result.measured.entries()].filter(([, v]) => !v.cached && !v.failed).map(([k]) => k);
        const sparse: string[] = [];
        try {
          for (const [i, key] of measured.entries()) {
            if (disposed || getState().project !== project) break;
            const clipIds = Object.keys(identity.identityKeys).filter((id) => identity.identityKeys[id] === key);
            const cardId = project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipIds[0])?.cardId ?? null;
            if (!clipIds.length || !cardId) continue;
            holdCostSearchMask(cardId, i, measured.length);
            sparse.push(cardId);
            await runCardMeasuredHook({ project, clipIds, cardId, identityKey: key, stale: () => disposed || getState().project !== project });
          }
        } finally {
          releaseCostSearchMask();
        }
        (window as unknown as Record<string, unknown>).__pcDualSearch = () => ({ keys: outcome.keys, light: [...outcome.light].sort(), measurements: outcome.result.measurements, records: outcome.records.length, boundary: outcome.result.boundary, sparseAfter: sparse });
        release(false, "searched");
      } catch {
        setDualSearch(false);
        release(true, "probe");
      }
    };
    const timer = window.setInterval(() => { void tick(); }, 1000);
    void tick();
    return () => { disposed = true; window.clearInterval(timer); if (dualSearchRef.current === "deciding") release(true, "probe"); };
  }, [online, dual, lowest]);
  /* The resident probe has finished measuring the remaining cards in the background: the dispatch table now judges by cost records (the two-stage bound search only covers the moment of opening) */
  useEffect(() => {
    if (!dualSearch) return;
    const check = () => { if (!probeProgress().running && probeSettledFor(getState().project)) setDualSearch(false); };
    const off = onProbeProgress(check);
    check();
    return off;
  }, [dualSearch]);

  /*
   * Light/heavy classification with only one stage (on-demand render gate): shared cost records plus bound search (`costSearch.ts`; semantics `mechanism/rendering.md` "Bound search and cost records").
   * After the shared project is connected, the project has arrived and the stage is ready, search once per shared project (with records, binary search measures only a few cards; without records, measure card by card); after that, when the project changes (a card added, parameters changed):
   * new cards without records get those few measured, and the rest are judged by the existing bound. If records cannot be fetched (not connected, rejected), retry after one beat; when measuring is really needed, `CostSearchGate` puts up the mask.
   * The lowest tier does not measure: no on-demand render at all during playback, and the judgment table is entirely heavy (the manifest plan sends all clips by the table used for display).
   */
  const stageReadyRef = useRef(stageReady);
  stageReadyRef.current = stageReady;
  const searchRef = useRef<{ projectId: string; outcome: CostSearchOutcome | null; running: boolean; waited: number } | null>(null);
  useEffect(() => {
    if (!online || !single) return;
    if (lowest) { setPlanSearchLight([]); return; }
    // Local reuse connects to L2 (must be connected before the first bound search, otherwise that round uses the page's memory)
    setSearchCostStore(l2SearchCostStore());
    let disposed = false;
    // Cards this page cannot run (user cards and media effect cards that failed to load) and cards that crashed during measurement are not measured and always classified as heavy (`forcedHeavy` of the bound search)
    const crashed = crashedCards();
    const unsupported = (clip: { id?: string; cardId?: string }) => needsLocalPc(clip.cardId, clip.cardId ? getCard(clip.cardId) : undefined)
      || (!!clip.id && crashed.has(clipIdentityOf(getState().project).identityKeys[clip.id] ?? ""));
    const stageDeps = {
      stage: frontStage,
      pushProject: (p: Project) => pushProject("front", p, { reset: true }),
      currentProject: () => getState().project,
      restore: () => {
        // The stage returned to being the visible stage: the whole project has been reloaded; suppression, stream plane and snapshot baseline are void, and stageReady +1 makes time and delivery start over
        suppressedRef.current = "";
        streamPlanesRef.current = "[]";
        markBaselineReset("front");
        setStageReady((n) => n + 1);
      },
      store: searchCostStore,
      mode: (import.meta.env.DEV ? "dev" : "build") as "dev" | "build",
      beforeMeasure: (key: string, cardId: string) => searchMeasureHooks.before(key, cardId),
      afterMeasure: (key: string) => searchMeasureHooks.after(key),
      publish: (records: SharedCostInput[]) => {
        const projectId = currentDocProjectId();
        if (!projectId || !hasDocLink() || !currentSharedLink()) return;
        return publishSharedCosts({ request: docRequest, projectId, environment: pageEnvironment(), records });
      },
    };
    const tick = async () => {
      if (disposed) return;
      // Measurement waits for the card source's first sync to finish (`measureGate.ts`): before that, synced cards have unknown ids and must not be measured as ordinary cards
      if (!measureGateOpen()) return;
      // Wait for the benchmark card to finish measuring first (it also borrows this one stage; if it cannot run, go to the lowest tier and no measuring is done here)
      if (tierState().benchmark === "pending") return;
      const shared = currentSharedLink();
      const projectId = currentDocProjectId();
      const s = frontStage();
      if (!shared || !hasDocLink() || !projectId || !s || !stageReadyRef.current || !((shared.ds?.rev ?? 0) > 0)) return;
      if (getState().playing) return;
      const project = getState().project;
      const cur = searchRef.current;
      if (cur && cur.projectId === projectId) {
        if (cur.running || !cur.outcome) return;
        const identity = clipIdentityOf(project);
        // The project changed: new cards with no records and never measured get measured (updating the relevant measurements as the project changes), and the rest are judged by the existing bound
        cur.running = true;
        try {
          const next = await measureNewCards(cur.outcome, { ...stageDeps, project, identityKeys: identity.identityKeys, capabilities: identity.capabilities, unsupported });
          if (disposed) return;
          cur.outcome = next;
        } catch { /* Come back on the next beat */ } finally { cur.running = false; }
        const latest = getState().project;
        setPlanSearchLight(reclassify(cur.outcome, latest, clipIdentityOf(latest).identityKeys, unsupported));
        return;
      }
      const identity = clipIdentityOf(project);
      const cardClips = project.tracks.some((tr) => tr.clips.some((c) => !!c.cardId || !!c.nodeId));
      // Card identity is not computed yet (the card registry is still loading): wait a few more beats, and start anyway after 10 beats (cards whose identity cannot be computed are treated as heavy cards)
      const waitKey = `${projectId}#wait`;
      const waited = cur?.projectId === waitKey ? cur.waited : 0;
      if (cardClips && !Object.keys(identity.identityKeys).length && waited < 10) {
        searchRef.current = { projectId: waitKey, outcome: null, running: false, waited: waited + 1 };
        return;
      }
      searchRef.current = { projectId, outcome: null, running: true, waited };
      try {
        const outcome = await runCostSearch({
          ...stageDeps,
          request: docRequest,
          projectId,
          project,
          environment: pageEnvironment(),
          identityKeys: identity.identityKeys,
          capabilities: identity.capabilities,
          unsupported,
        });
        if (disposed) return;
        searchRef.current = { projectId, outcome, running: false, waited };
        // The project may have changed again during the search: judge once more by the latest project
        const latest = getState().project;
        setPlanSearchLight(latest === project ? outcome.light : reclassify(outcome, latest, clipIdentityOf(latest).identityKeys, unsupported));
        const ds = currentSharedLink()?.ds;
        if (ds?.confirmedProject && typeof ds.rev === "number") keepConfirmedProject(ds.rev, ds.confirmedProject);
      } catch {
        // Records cannot be fetched: retry on the next beat
        if (searchRef.current?.projectId === projectId) searchRef.current = null;
      }
    };
    const timer = window.setInterval(() => { void tick(); }, 1000);
    void tick();
    const w = window as unknown as Record<string, unknown>;
    w.__pcCostSearch = () => {
      const cur = searchRef.current;
      const o = cur?.outcome ?? null;
      return {
        projectId: cur?.projectId ?? null,
        running: cur?.running ?? false,
        state: costSearchState(),
        light: [...(planSearchLight() ?? [])].sort(),
        judgedHeavyClips: [...(judgedPlan()?.prerenderSet ?? [])].sort(),
        outcome: o && {
          keys: o.keys, forcedHeavy: o.forcedHeavy, records: o.records.length, envFingerprint: o.envFingerprint, elapsedMs: o.elapsedMs,
          measurements: o.result.measurements, searchMeasurements: o.result.searchMeasurements, boundary: o.result.boundary,
          threshold: o.result.threshold, order: o.result.order, trace: o.result.trace, budgetMs: o.result.budgetMs,
          heavy: [...o.result.heavy].sort(), light: [...o.light].sort(), unrecorded: o.result.unrecorded,
          measured: [...o.result.measured.entries()].map(([key, v]) => ({ key, ms: Number.isFinite(v.ms) ? v.ms : null, cached: v.cached, failed: v.failed })),
        },
      };
    };
    return () => {
      disposed = true;
      window.clearInterval(timer);
      delete w.__pcCostSearch;
      searchRef.current = null;
    };
  }, [online, single, lowest]);

  /*
   * When the desktop app and online browsers are connected to a shared project, the cost records measured by this machine's background stage are copied over to the document service (`sharedCosts.ts`;
   * semantics `mechanism/document-service.md` "Cost records": every online browser writes after measuring). Nothing is written and no error is reported when not connected; only the cards that this browser measured
   * and that the current project uses are copied. With only one stage, what the bound search measures is written directly by `costSearch.ts` once measured.
   */
  useEffect(() => {
    const relay = new SharedCostRelay({
      request: docRequest,
      linkKey: () => (hasDocLink() ? currentSharedLink() : null),
      projectId: () => (currentSharedLink() ? currentDocProjectId() || null : null),
      environment: pageEnvironment,
      costs: currentCosts,
      identityKeys: () => new Set(Object.values(clipIdentityOf(getState().project).identityKeys)),
    });
    const timer = window.setInterval(() => { void relay.sync().catch(() => 0); }, SHARED_COST_RELAY_MS);
    void relay.sync().catch(() => 0);
    const w = window as unknown as Record<string, unknown>;
    w.__pcSharedCosts = () => relay.debug();
    w.__pcSharedCostsSync = () => relay.sync();
    return () => { window.clearInterval(timer); delete w.__pcSharedCosts; delete w.__pcSharedCostsSync; };
  }, []);

  useEffect(() => { onlineSourceRef.current?.focus(t, project.fps || 30); }, [t, project.fps]);

  /* The iframe was replaced: that delivery baseline is void, and the next one carries `reset` (A3c) */
  useEffect(() => {
    if (!live || !stageReady) return;
    markBaselineReset("front");
    suppressedRef.current = "";
    // The stream plane is also sent while paused: after a stage swap, this record likewise starts from zero (the new stage has none)
    streamPlanesRef.current = "[]";
    /*
     * Online page: the small-size prerender is often fetched before the stage handshake (when fetched, `frontStage()` is still empty, and that delivery falls through).
     * A paused page has no other event that would deliver afterwards, so heavy cards stay as placeholders forever --- deliver once as soon as the stage handshakes (measured in c10a-demo-probe).
     */
    if (onlineSourceRef.current) void pumpRef.current();
  }, [live, stageReady]);
  /*
   * The project changed (the store swapped in a new project object): recompute the stream plane and suppression for the new project once. A stream of a card that depends on lower layers is only valid for the version of the lower layers at the time it was produced ---
   * once a lower layer changes, the input signature carried by that layer no longer matches (`streamLayers` in `snapshotFeed.ts`), and the old stream must be withdrawn on the spot, not wait for the next `setTime`:
   * when paused with the hand held still on the ruler, after a lower layer is edited no other event will come to deliver. While playing, the next beat delivers by itself, so one extra delivery here does no harm; unchanged ones are not resent
   * (`syncPlanes` compares by content, and the snapshot half has a 33 ms throttle).
   */
  useEffect(() => {
    if (!live || !stageReady) return;
    void pumpRef.current();
  }, [live, stageReady, project]);

  /*
   * K5 (4) role swap. **A / B are only instance names**; which one is `front` is decided by this
   * state: A starts as front, and after a swap it flips. Two things must be done in **one React
   * commit**: swap the visibility of the two iframes, and switch the "current front" pointer over
   * (the `stageBridge` registration).
   *
   * The background one can only be hidden with `opacity: 0; pointer-events: none`: `display: none` /
   * `visibility: hidden` takes the whole OOPIF out of the render tree, `requestVideoFrameCallback`
   * stops firing, and the `mediaReady` of K5 (3) can only wait until it times out (see the note on
   * K5 (4)).
   */
  const [frontId, setFrontId] = useState<StageId>("A");
  const frontIdRef = useRef<StageId>("A");
  frontIdRef.current = frontId;
  const swapRoles = useCallback(() => {
    const cur = frontIdRef.current;
    const nextId: StageId = cur === "A" ? "B" : "A";
    const nextFront = rpcRef.current[nextId];
    if (!nextFront) return null;
    const nextBack = rpcRef.current[cur];
    frontIdRef.current = nextId;
    flushSync(() => setFrontId(nextId));
    /*
     * The baseline follows the client (root cause A): the new front holds the copy that was loaded when
     * the catch-up run started, **not** the latest project right now. Before, this did
     * `markPushed(role, getState().project)`, so edits made during the catch-up run (deleting a clip)
     * could never be made up; now `swapAndDress` pushes `syncProject` once more after the swap and
     * computes the delta against the copy it actually holds.
     */
    swapStageClients({ client: nextFront, caps: hostCapsRef.current[nextId] }, { client: nextBack, caps: hostCapsRef.current[cur] });
    // The new front's suppressed set and stream plane both start from zero (when swapping while paused, the old front still holds the stream plane and the new front has none)
    suppressedRef.current = "";
    streamPlanesRef.current = "[]";
    return { front: nextFront, back: nextBack };
  }, []);
  /* Falling back to a single stage (handshake failed): the visible stage returns to A (B is already unmounted) */
  useEffect(() => {
    if (!dual && frontIdRef.current !== "A") { frontIdRef.current = "A"; setFrontId("A"); }
  }, [dual]);
  /*
   * C10 contract section 2, "Placement and pacing of the background stage": for the online dual stage,
   * this page decides when the background work is idle (page visible, rAF interval not persistently
   * above 500 ms, parent page rIC calling back), and sends start / stop through RPC. The desktop app
   * runtime does not send it (unchanged).
   */
  useEffect(() => {
    if (!dual || !ONLINE) return;
    return startBackWorkGate({ back: () => { const b = backStage(); return b && b !== frontStage() ? b : null; } });
  }, [dual]);
  useEffect(() => {
    if (!dual) return;
    setSwapHost({
      swapRoles,
      // The 2D preview **does not add proxy=1** (see the comment on the iframe below), so what is resent after a swap is false too
      proxy: () => false,
      // A1 tier switch: the stage's VideoTrack / pixel map assets pick their tier by it (T1a review #5); see LOCAL_HASHES for the source
      localHashes: () => [...tierHashes()],
      // With only one stage, after pausing it does not go through the background stage to catch up the live render (with the dual stage this cannot be a single stage, this is just a safety net)
      singleStage: () => singleRef.current,
    });
    return () => setSwapHost(null);
  }, [dual, swapRoles]);

  /** For which cards this round of playback has already started a swap (do not send it on every tick) */
  const swapTriedRef = useRef(new Set<string>());

  /* Observation port for the acceptance-check probe: state on the parent page side (which iframe is front, whether the assets are frozen, which step it downgraded to) */
  useEffect(() => {
    if (!live) return;
    const w = window as unknown as { __pcPreviewDiag?: () => unknown };
    w.__pcPreviewDiag = () => ({
      frontId: frontIdRef.current,
      mediaStalled: stalledRef.current,
      // K4 / pinned architecture 10: how many stalls were detected in this round of playback (normal playback should be 0)
      mediaStallCount: stallCountRef.current,
      mediaGapMaxMs: gapMaxRef.current,
      suppressed: suppressedRef.current ? suppressedRef.current.split("|") : [],
      // The last stream plane sent to the visible stage (also set on pause / drag)
      streamPlanes: streamPlanesRef.current,
      pendingDemote: [...pendingDemotes()],
      demoted: [...demotedClips()],
      swapInFlight: swapInFlight(),
      swapLog: stageSwapDebug(),
      swapTrace: stageSwapTrace(),
      // Decision to start a swap in the playing state (whole-scene time estimate / cannot catch up means no start), and the count of yields when stopping
      swapPlaying: stageSwapPlayingDebug(),
      setTimeLog: setTimeLogRef.current.slice(),
      setTimeError: setTimeErrorRef.current,
      // The tier of this time (`onlineTier.ts`) and the last result of the single-stage stop-and-catch-up-one-frame
      tier: ONLINE ? { ...tierState() } : null,
      single: singleRef.current,
      lowest: lowestRef.current,
      lastSettle: settleResultRef.current,
      // C10: online dual stage, snapshot swap per tick, background live render switch, transferable bytes of the probe frame
      dual: dualRef.current,
      onlineStages: onlineStageState(),
      // Online execution of user cards and media effect cards: whether this page can execute right now, why not, and the path number (fixed per account plus project, kept secret from stages of other projects; the ticket is not here)
      cardExec: ONLINE ? { ...onlineCardExec(), sid: pageStageIsolation().sid } : null,
      // The moment of switching back to the dual stage after the first handshake transition period (why the cover overlay was up and how long until it came down)
      handover: { ...handoverInfoRef.current },
      beatSwap: beatSwapDebug(),
      backWork: backWorkDiag(),
      probeFrames: probeFrameDiag(),
      // Which clips the resident probe has measured, and when the measurement gate opened (online-user-cards-probe checks that a sync card was never measured)
      probeRun: probeRunDiag(),
      measureGate: measureGateDiag(),
      hostCaps: { ...hostCapsRef.current },
      snapshotFeed: snapshotFeedDebug({ project: getState().project, t: tRef.current, playing: playingRef.current, single: singleRef.current, sparseOnly: singleRef.current }),
    });
    return () => { delete w.__pcPreviewDiag; };
  }, [live]);

  /*
   * Dispatch of stage events (the seven of E0; source filtering is already done by role in
   * stageBridge).
   *
   * The listener is registered only once, so everything read inside is always a ref / store, never
   * state from the closure.
   */
  useEffect(() => onStageEvent((e) => {
    switch (e.type) {
      case "frame": {
        // K4: the visible stage reports t once after each tick it finishes rendering, and the playhead follows it (the Preview rAF loop does not start then)
        if (handoverRef.current) finishHandover(STAGE_HANDOVER_SETTLE_MS, "frame");
        const now = performance.now();
        const prev = lastFrameAtRef.current;
        lastFrameAtRef.current = now;
        armStallWatch();
        if (!firstBeatRef.current && playingRef.current) { firstBeatRef.current = true; setFirstBeatSeen((n) => n + 1); }
        actions.tick(e.sec);
        // The suppressed set and snapshots of this tick (C5: during playback send setSuppressed(H(t)) + setSnapshots)
        void pumpRef.current();
        /*
         * Light cards with `vtOk = false` from K3(b): when the playhead has just entered one, the whole scene
         * is caught up in the background and then swapped.
         * Each card starts only once per round of playback: a catch-up run takes a few hundred
         * milliseconds, and sending one every tick would only make them pin each other down.
         * Only for cards that playback starts in the middle of: those that this round of playback walks
         * through the mount frame tick by tick and enters naturally do not start (`playingSwapTargets`).
         * Record the tick number first (consecutive, repeated or broken), then compute the target.
         */
        notePlayFrame(e.sec);
        // Only the dual stage has a background stage to swap with; the single stage of an online page does not go through it; at the lowest tier, playback does no live render and does not go through it either
        if (dualRef.current && !lowestRef.current && !swapInFlight()) {
          const targets = playingSwapTargets(getState().project, e.sec).filter((id) => !swapTriedRef.current.has(id));
          if (targets.length) {
            for (const id of targets) swapTriedRef.current.add(id);
            void runPlayingSwap(targets);
          }
        }
        if (!prev) break;
        // How much slower than the nominal duration of one tick (see the comment above MEDIA_STALL_MS)
        const overBeat = now - prev - 1000 / Math.max(1, getState().project.fps || 30);
        if (overBeat > gapMaxRef.current) gapMaxRef.current = overBeat;
        const stalled = overBeat > MEDIA_STALL_MS;
        if (stalled === stalledRef.current) break;
        if (stalled) stallCountRef.current++;
        stalledRef.current = stalled;
        setMediaStalled(stalled);
        // The stage-side media layer is frozen / released in sync; the audio of the main document is managed by the playing prop of MediaLayers
        void frontStage()?.setPlaying(!stalled && playingRef.current).catch(() => {});
        break;
      }
      case "ended":
        /*
         * K4 playback reached the end: write the store (`pause()` + `seek(duration)`). The remaining three
         * steps (`setPlaying(false)`, `pause()` to get `stoppedAt`,
         * `setTime(stoppedAt, { settle: true })`) are **the same wrap-up as pressing pause**: after
         * `playing` flips to false, the effect below does it uniformly. Without the last step, the heavy
         * cards of the last frame would stay in the suppressed state forever (pinned architecture 9).
         */
        actions.pause();
        actions.seek(e.sec);
        break;
      case "settled": {
        /*
         * After the stage catches up, it removes the suppression of these cards by itself (in the same commit
         * as revealing the live component, `releaseSettled` of `StageView`): the "last sent suppressed set"
         * recorded by the parent page is no longer trustworthy, and the next send resends it as things stand.
         * The entry for a swap that became official (`clipIds` empty) is not handled here: there
         * `swapRoles` clears the record and `markAllSettled` marks the whole stage as exact.
         */
        const named = e.clipIds.length > 0;
        if (named) suppressedRef.current = "\u0000";
        // Only the second of this stop counts: late ones (the user dragged away again, and the stage already put them back into suppression in the new jump) do not count as exact.
        // Cards attached to the stream compare against the store's current playhead (`tRef` only updates on the next render, so right after a pause it lags one step); the single stage's layer-by-layer catch-up of one frame still compares against `tRef` as before
        const stale = singleRef.current ? Math.abs(e.sec - tRef.current) > 1e-6 : named && Math.abs(e.sec - getState().t) > 1e-6;
        if (stale) {
          if (named) void pumpRef.current();
          break;
        }
        // K5: live render ready in the paused state: remove these cards from the delivery baseline (A3c), and the flat stage removed them by itself
        noteSettled("front", e.clipIds);
        if (named) void pumpRef.current();
        break;
      }
      case "demote":
        // K6: this card is downgraded, and the parent page PUTs the whole record { ...old record, capped: true, demoted: true }
        void onStageDemote(e.clipId);
        break;
      case "probe":
      case "probe-frame":
        // K1 (R4): the probe's results and the dead assets it incidentally derived (consumed in probeRunner)
        break;
      case "mediaReady":
        // K5 step (4): the background stage's media layer drew a frame (consumed in catchUp.ts, which subscribes by itself)
        break;
    }
  }), []);

  /**
   * Outer frame for the selection outline: do not use the wrapper layer (every card fills the whole
   * screen), use the clip's entity extent: the outline of a captions card hugs the captions
   * themselves instead of going around the screen. An old render surface without bounds falls back to
   * the wrapper layer.
   */
  /*
   * R7 (D3 step 4 / D5): the `mediaRects` of the main document has been removed.
   *
   * Media clips are now drawn by the stage itself (E7 item 1, landed in R3), and `data-pc-clip` is
   * written on the displayed video slot and image layer, so the stage's `rects()` / `hitTest` already
   * recognize them: adding another copy in the main document would make the same clipId appear twice,
   * and a hit would pick the wrong one. Hit testing and entity frames **all go through the stage's**
   * `hitTest` / `rectsWithBounds`.
   */

  /**
   * One round trip fetches the outer frames + entity extents of all active clips (rectsWithBounds,
   * which merged the N+1 of the former rects() followed by bounds() one by one).
   * The heartbeat only carries pixels: 'selected': only the selected card has its canvas pixels
   * scanned (the selection outline does not fall back to the whole canvas); unselected cards use the
   * element rectangle: their frames only go into the rects list and no outline is drawn. 'all' is
   * used only at the moment of a user click.
   * When replies arrive out of order, the old one must not overwrite the new one, guarded by a
   * generation counter.
   */
  const rectsGen = useRef(0);
  const refreshRects = useCallback(async (pixels: "selected" | "all" = "selected") => {
    const s = stage();
    const gen = ++rectsGen.current;
    let cards: { clipId: string; left: number; top: number; width: number; height: number }[] = [];
    if (s) {
      try {
        const list = await s.rectsWithBounds(pixels === "selected" ? { pixels, clipIds: selectionRef.current } : { pixels });
        cards = list.map((r) => ({ clipId: r.clipId, ...(r.bounds ?? r.rect) }));
      } catch {
        // The iframe is being swapped (detached): this round is void, and the new ready will refresh once more
        return;
      }
    }
    if (gen !== rectsGen.current) return;
    // R7: media clips are in the stage now too (E7 item 1), and `rectsWithBounds` brings back both cards and media clips in one go
    setRects(cards);
  }, [stage]);

  /** The clip just clicked: the outline flashes so the user can see clearly which one was hit */
  const [flash, setFlash] = useState<{ clipId: string; token: number } | null>(null);
  const flashClip = (clipId: string) => setFlash({ clipId, token: Date.now() });

  /**
   * Entity hit: ask the render surface which clip the first "drawn" element, from the top layer
   * down, at this point belongs to. Transparent containers are passed through: a captions card on the
   * top layer does not block the cards below. An old render surface without hitTest falls back to
   * finding the topmost one by wrapper layer outer frame.
   */
  const hitAt = async (e: { clientX: number; clientY: number; currentTarget: EventTarget & Element }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const s = stage();
    /*
     * R7: cards and media clips are all in the stage, and one `hitTest` round trip is the final answer
     * (D3). The main document falls back to the previous round's `rects` only when there is **no stage
     * at all** (handshake not done yet / iframe being swapped).
     */
    let card: { clipId: string; left: number; top: number; width: number; height: number } | null = null;
    if (s) {
      try { card = await s.hitTest(x, y); } catch { card = null; }
    }
    const inside = (r: { left: number; top: number; width: number; height: number }) =>
      x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    const hit = card ?? (s ? null : [...rects].reverse().find(inside)) ?? null;
    return { hit, overlayRect: rect };
  };

  // Send the project document when it changes: through stageBridge only the changed clips are sent (two-level diff), and the whole copy + reset when there is no baseline
  useEffect(() => {
    // During bound search measurement the stage holds a shrunken project: do not push (after measuring, reload the whole copy, stageReady +1 and go again)
    if (!stageReady || costSearchMeasuring()) return;
    void syncProject("front", project).then(() => refreshRects(), () => {});
  }, [stageReady, project, refreshRects]);

  // Send down when time changes. During playback it advances continuously; dragging the playhead / jump / replay (playToken changes) are all handled as a jump:
  // remount + catch up from the in-point to that moment. Both are merged in one effect, so one seek renders only one frame.
  /*
   * Only recognize "time really changed": the references of the stage / refreshRects callbacks change
   * along with the project and zoom. Before, this effect reran whenever they changed, so every time the
   * Agent wrote the project there was an extra jump render: remount the active cards and catch up
   * frame by frame from the in-point to the playhead, measured at 230~350 ms of main thread each time
   * with the playhead at 60 seconds. Whether a project change needs a catch-up run is already judged
   * by setProject (StageView) by "which card changed, and whether it is on screen".
   */
  /*
   * E0: pause and drag only send setTime (no remount, no playToken increment: the clock is moved over,
   * React commits, animations are pinned); the parent page **no longer** sends render(jump) to the
   * visible stage.
   *
   * **E6: this effect is split into two halves.** The half that sends `setTime(t)` **does not run
   * during playback** (K4 is advanced by the stage itself on its frame ticks, and the parent page
   * sending it too would be two people fighting over the steering wheel); the `refreshRects()` half
   * becomes a timer that fires every 500 ms during playback (see the effect below), and stale results
   * are discarded by request number (`rectsGen` in `refreshRects`).
   * Sync the project first and then move the time; the order of the two RPCs must not be reversed
   * (setTime needs to compute the active cards on the new project).
   */
  const scrubbing = useSyncExternalStore(subscribeScrub, isScrubbing, isScrubbing);
  /*
   * In dual stage mode the page triggers the prerender (shared hook; the legacy path uses the same one
   * in `UnifiedPreview`): when an edit push succeeds (`frameRequest` does `alignMirror` first) and it
   * is idle (not playing, not dragging), send `preload` with debounce, and keep asking if it is not ready.
   */
  usePrerenderPreload(project, { enabled: dual && !ONLINE, idle: !playing && !scrubbing, waitForProbe: true });
  /** Diagnostics: the last few setTime calls and the last failure (for the probe to investigate why the live render was not caught up after pausing) */
  const setTimeLogRef = useRef<{ at: number; sec: number; settle: boolean }[]>([]);
  const setTimeErrorRef = useRef<{ at: number; sec: number; error: string } | null>(null);
  const scrubbingRef = useRef(scrubbing);
  scrubbingRef.current = scrubbing;
  const lastRenderKey = useRef("");
  /**
   * Move the time of the visible stage once. **The only entry for pause and drag** (playback goes
   * through K4).
   *
   * `settle: true` starts the paused-state live render of K5: clicking the timeline, releasing a drag,
   * pressing pause, and playback reaching the end all carry it, and
   * **it is not carried during a drag** (E3).
   */
  /**
   * Generation of the `setTime` sent to the visible stage (+1 on each send). The single stage's
   * stop-and-catch-up-one-frame dedupes by "the latest setTime right now + the second": at the moment
   * of pausing, the parent page sends setTime several times in a row (the pause, and the t rewritten
   * by the stage's last tick), and each one's catch-up of one frame may be sent only after the last
   * setTime; two catch-ups of one frame at the same second run concurrently in the stage, and the
   * later one would interrupt the layers the earlier one had drawn into "not drawn", and the drawn
   * layers would go back to suppression (measured by the single-stage online probe G3).
   */
  const setTimeEpochRef = useRef(0);
  const settleKeyRef = useRef<string | null>(null);
  const sendSetTime = useCallback(async (sec: number, opts: { settle?: true } = {}) => {
    setTimeLogRef.current.push({ at: Math.round(performance.now()), sec, settle: !!opts.settle });
    if (setTimeLogRef.current.length > 12) setTimeLogRef.current.shift();
    const s = stage();
    if (!s || costSearchMeasuring()) return;
    try {
      await syncProject("front", getState().project);
      if (liveRef.current) {
        clearSettled("front", `setTime ${sec}`);
        syncPlanes(s, { project: getState().project, t: sec, playing: false, single: singleRef.current, sparseOnly: singleRef.current });
      }
      // With only one stage, stop-and-catch-up-one-frame goes through `settleLayers` instead (below), and the stage's first path of K5 does not start
      const { settle: _settle, ...stageOpts } = opts;
      setTimeEpochRef.current++;
      await s.setTime(sec, singleRef.current ? stageOpts : opts);
    } catch (e) {
      // The iframe is being swapped (detached): the new ready will resend
      setTimeErrorRef.current = { at: Math.round(performance.now()), sec, error: String((e as Error)?.message ?? e).slice(0, 120) };
      markBaselineReset("front");
      return;
    }
    // Handoff for switching back to the dual stage: the new visible stage has settled this frame on the new project, wait a moment for it to reach the screen before removing the cover overlay
    if (handoverRef.current && s === stage()) finishHandover(STAGE_HANDOVER_SETTLE_MS, "setTime");
    void refreshRects();
    void pumpRef.current();
    /*
     * K5 second path: as long as at this moment there is a card judged heavy with `vtOk = false`, make the
     * background stage catch up the whole scene and, once done, swap into an exact live render. Those
     * with `vtOk` already catch up by themselves in the visible stage (K5 first path, stage side).
     */
    // Deliver once more after the swap is done: the new visible stage holds no stream plane, so first decode the frame under the playhead (during the swap `pumpFeed` does not touch the stream plane)
    if (dualRef.current && opts.settle && !singleRef.current) void runSettleSwap(sec).then((swapped) => { if (swapped) void pumpRef.current(); }, () => { /* The background stage is being swapped: the next setTime will start over */ });
    /*
     * With only one stage, stop and catch up the current frame: on this pause, click or drag release, or
     * playback reaching the end, the stage live-renders all cards of the current frame once in the
     * visible stage;
     * until drawn they are shown in fallback order (the prerender output is pasted on if there is one,
     * a placeholder if not), and each layer replaces the previous one as it is drawn, with no time limit
     * (lowest tier, "after stopping ... no time limit").
     */
    if (liveRef.current && opts.settle && singleRef.current) void settleLayersAt(s, sec);
  }, [stage, refreshRects, syncPlanes]);
  /** Generation of the single-stage stop-and-catch-up-one-frame (stopped again / moved again: the old result is not recorded) and the last result (diagnostics) */
  const settleGenRef = useRef(0);
  const settleResultRef = useRef<(SettleResult & { at: number }) | null>(null);
  const settleLayersAt = useCallback(async (s: StageRpcClient, sec: number): Promise<void> => {
    // After the same setTime the same second is already being caught up: do not send a second time (see setTimeEpochRef)
    const key = `${setTimeEpochRef.current}|${sec}`;
    if (settleKeyRef.current === key) return;
    settleKeyRef.current = key;
    const gen = ++settleGenRef.current;
    let result: SettleResult;
    try {
      result = await s.settleLayers(sec);
    } catch {
      result = { ok: false, reason: "rpc", sec, timeoutMs: null, ms: 0, drawn: [], timedOut: [], skipped: [] };
    }
    if (gen !== settleGenRef.current) return;
    settleResultRef.current = { ...result, at: Date.now() };
    // The drawn layers have already received `settled`; deliver once more to align the baseline with how the stage looks right now
    void pumpRef.current();
  }, []);
  /** The start / stop tick of K4 only recognizes `playing`, so that effect reads this copy and does not put `sendSetTime` in its dependencies */
  const sendSetTimeRef = useRef(sendSetTime);
  sendSetTimeRef.current = sendSetTime;
  /** The `playing` this effect saw last time: the "just flipped from playing to paused" occasion must be left to the wrap-up effect */
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    if (!stageReady) return;
    // K4: during playback the playhead is driven by the stage's `frame`, and the parent page sends nothing on any tick
    if (live && playing) { wasPlayingRef.current = true; return; }
    /*
     * **The occasion of just pausing is not sent here** (E0 / R5-4). The wrap-up is the job of the effect
     * below, which sends by the `stoppedAt` in the `pause()` reply; here we only have `store.t`, which
     * may lag the stage by one tick, and rushing to send once would take the backward-jump path (remount
     * of all stateful cards in the whole scene, a flash of `.pc-settling`), and would also start the
     * catch-up / swap of K5 in vain. Playback reaching the end (`ended`) goes through the same path.
     */
    const justPaused = live && wasPlayingRef.current;
    wasPlayingRef.current = false;
    if (justPaused) return;
    /*
     * **`scrubbing` also goes into the key** (E3 / pinned architecture 9). On releasing a drag or
     * clicking once on the timeline, `t` may not have changed at all (the release coordinate equals the
     * position of the last flush; on a click, `seek` and `beginScrub` are batched into one render in the
     * same React event, and `scrubbing` is already true at that render).
     * Without this bit in the key, after a drag / click ends the `settle: true` one is never made up,
     * and the cards judged heavy stay on the snapshot: exactly the "after clicking the timeline or
     * releasing a drag, the live render is not exact" case.
     * Under legacy `dual` is false and the suffix is constant, so nothing extra is sent.
     */
    const key = `${stageReady}|${t}|${playToken}|${live && scrubbing ? "scrub" : "settle"}`;
    if (key === lastRenderKey.current) return;
    lastRenderKey.current = key;
    // The single stage carries settle too: on stop, catch up the current frame layer by layer; not carried during a drag
    void sendSetTime(t, live && !scrubbingRef.current ? { settle: true } : {});
  }, [stageReady, live, playing, t, playToken, scrubbing, sendSetTime]);

  /*
   * After a sync card's run state becomes ready, or measurement results arrive and the dispatch table
   * is recomputed, the stopped stage redelivers the suppression and settles the current frame:
   * when a project has just been opened the sync card is not ready yet, so the first
   * setTime(t, { settle: true }) records it into the suppression per localOnly (showing an hourglass),
   * and swapTrace only records that one unmeasured occasion; after that the card becomes ready and
   * measurement completes, and if settling is not triggered again while paused it stays on the hourglass forever.
   */
  useEffect(() => {
    if (!live) return;
    let queued = false;
    const settlePaused = () => {
      queued = false;
      if (!liveRef.current || !stageReadyRef.current || playingRef.current || scrubbingRef.current || costSearchMeasuring()) return;
      void sendPlanTo("front");
      void pumpRef.current();
      if (!probeProgress().running) {
        void sendSetTimeRef.current(tRef.current, { settle: true });
      }
    };
    const trigger = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(settlePaused);
    };
    const offPlan = onPlanUpdated(trigger);
    const offRunStates = onCardRunStatesChanged(trigger);
    let wasRunning = probeProgress().running;
    const offProbe = onProbeProgress((p) => {
      const finished = wasRunning && !p.running;
      wasRunning = p.running;
      if (finished) trigger();
    });
    return () => { offPlan(); offRunStates(); offProbe(); };
  }, [live]);

  /* E6: during playback `refreshRects` becomes a timer, one round trip, and stale results are discarded by sequence number */
  useEffect(() => {
    if (!live || !stageReady || !playing) return;
    const id = window.setInterval(() => { void refreshRects(); }, RECTS_POLL_MS);
    return () => window.clearInterval(id);
  }, [live, stageReady, playing, refreshRects]);

  /*
   * Parent-page side of K4: when `playing` flips to true, call `play(t)` to start the tick loop; when it
   * flips to false, run the wrap-up
   * (`setPlaying(false)` → `pause()` to get `stoppedAt` → `setTime(stoppedAt, { settle: true })`).
   *
   * **Use the `t` of the stage's last tick, not `store.t`** (E0): the store's `t` can lag the stage by
   * one tick, and sending it would take the backward-jump path and remount every stateful card.
   * Reaching the end of playback (`ended`) goes through the same code: that side only writes the store,
   * and after `playing` flips to false it lands here.
   *
   * For the start position see `playStartOf`: if the playhead is outside the content range, go back to
   * the earliest card (the same rule as the legacy loop).
   */
  /**
   * The second from which this playback run starts. It is word for word the same rule as the legacy
   * wall-clock loop (`:155-158`): if the playhead is before the first card, or has already reached the
   * end, replay from the earliest card.
   *
   * After R7 made the stage the default, this rule was missed: pressing play after reaching the end hit
   * `rawSec >= duration` on the stage's first tick and posted `ended` immediately, so pressing play did
   * nothing (the R7-11 regression).
   */
  const playStartOf = useCallback((): number => {
    const project = getState().project;
    const fps = Math.max(1, project.fps || 30);
    const start = contentStartRef.current;
    const from = tRef.current;
    if (from >= start && from < project.duration - 0.5 / fps) return from;
    // The store must also go back to the start: the timeline, the media layer and the settle after `ended` all follow store.t
    actions.seek(start);
    return start;
  }, []);
  useEffect(() => {
    if (!live || !stageReady) return;
    let alive = true;
    const s = stage();
    if (!s) return;
    if (playing) {
      playedRef.current = true;
      lastFrameAtRef.current = 0;
      stalledRef.current = false;
      stallCountRef.current = 0;
      gapMaxRef.current = 0;
      setMediaStalled(false);
      swapTriedRef.current = new Set();
      void (async () => {
        try {
          /*
           * **First wait for the project to reach this stage, then start the tick loop.**
           *
           * After a new iframe handshake `stageReady` is incremented; the effect above sends `syncProject` and
           * this one sends `play`. But `syncProject` goes through stageBridge's serial chain (`chain.then`), so
           * the real postMessage is one microtask later, while `play` is sent synchronously. So when "swapping
           * the iframe while `playing`" (switching back to 2D, stage hot reload), the stage receives `play`
           * first, has no project yet and replies `no-project`; there is no retry here, so the button shows
           * "Pause" and the picture does not move.
           * Chaining on the same line and waiting for it to settle pins the order down. When the baseline is
           * unchanged `syncProject` sends nothing, so there is no extra round trip.
           */
          await syncProject("front", getState().project);
          if (!alive) return;
          const from = playStartOf();
          // Start of this playback run: cards already mounted at the moment playback starts count as "starting mid-way", and those mounted tick by tick afterwards count as natural entrances (the playing-state swap only applies to the former)
          notePlayRunStart(from);
          /*
           * Before playback starts, set up this second's stream plane, suppression and snapshots first (before,
           * this was sent only when the first tick's `frame` arrived: heavy cards on the first tick are live
           * rendered, which is slow and can fail to join up with the stream).
           * While paused the stage has already decoded the frame under the playhead; once suppressed here, the
           * first tick shows the stream's picture. If the stream has not drawn yet, the stage does not hide its
           * original picture first.
           * Do not wait for replies: the several messages arrive in the order they were sent, before the `play` below.
           */
          void pumpRef.current({ t: from, playing: true });
          const reply = await s.play(from);
          if (!alive) return;
          // The first tick's arrival interval starts from the moment the `play()` reply arrives (K4)
          if (reply.ok) { lastFrameAtRef.current = performance.now(); armStallWatch(); }
          /*
           * The stage says it cannot start (no project, wrong role): **flip the store back to paused too**, so
           * the UI does not stay stuck on "playing".
           * After flipping back, the branch below wraps up as usual (`pause()` to get `stoppedAt` →
           * `setTime(settle)`), aligning the picture and playhead to the frame the stage is really stopped on;
           * when the user presses play again it is a clean start.
           */
          else if (getState().playing) actions.pause();
        } catch { /* The iframe is being swapped: the new handshake will rerun this effect with playing */ }
      })();
    } else {
      void (async () => {
        // **Clear lastRenderKey synchronously at the one place that sends pause()** (E6), otherwise the next setTime is swallowed by dedup
        lastRenderKey.current = "";
        window.clearTimeout(stallWatchRef.current);
        stalledRef.current = false;
        setMediaStalled(false);
        let stoppedAt = tRef.current;
        /*
         * Only when "just stopped from playing" is the stage's `stoppedAt` authoritative. A new render surface
         * swapped in while paused (`stageReady` +1: the whole stage page reloads after card code is installed,
         * hot update, iframe remount) also reaches this branch: the new stage is still at 0, and updating the
         * store from it would wash the user-set playhead back to 0 (C6.6 T9: after a member joined a shared
         * project and installed a user card, the playhead went from 2.5 s back to 0).
         * In that case the store's `t` is authoritative, and it is only sent to the new stage.
         */
        const fromPlay = playedRef.current;
        playedRef.current = false;
        try {
          const reply = await s.pause();
          if (fromPlay && reply.ok && typeof reply.stoppedAt === "number") stoppedAt = reply.stoppedAt;
        } catch { /* The iframe is being swapped */ }
        if (!alive) return;
        if (Math.abs(getState().t - stoppedAt) > 1e-6) actions.tick(stoppedAt);
        await sendSetTimeRef.current(stoppedAt, { settle: true });
      })();
    }
    return () => { alive = false; };
    /*
     * **Only three dependencies.** `t` changes every tick, and the identities of `stage` / `sendSetTime`
     * change along with it: if they were in the dependencies this effect would rerun every tick, stopping
     * and restarting the tick loop just started during playback, and while paused the branch's
     * `actions.tick(stoppedAt)` would trigger itself again (infinite updates).
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, stageReady, playing]);

  /*
   * R3's minimal wiring: outside legacy the media layer lives **in the stage** (E7 item 1), and it needs
   * three things to run: `mediaT` (which moment to follow), `scrubbing` (seek more sparsely) and
   * `playing` (only drives the media layer, does not touch K4's tick loop).
   *
   * **Send to both stages** (E3: "media layer `mediaT = t`, same for both roles"): before K5's second
   * swap, the media of `back` must already be at the target tick, otherwise after the swap the drift
   * exceeds `HARD_SEEK_SEC` and a hard seek must be paid.
   * Under legacy none of these is sent: there the media layer is still in the main document.
   *
   * `playing` carries `mediaStalled` (K4): the stage's media layer is paused and resumed together with
   * the main document's audio.
   */
  useEffect(() => {
    if (!live || !stageReady) return;
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (!c) continue;
      void c.setScrubbing(scrubbing).catch(() => {});
      void c.setPlaying(playing && !mediaStalled).catch(() => {});
    }
  }, [live, stageReady, scrubbing, playing, mediaStalled]);
  useEffect(() => {
    if (!live || !stageReady) return;
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (!c) continue;
      void c.setMediaT(t).catch(() => {});
    }
  }, [live, stageReady, t]);
  // C6.6: when the tier-switch set changes, send it to both stages (E3: media layer is the same for both roles)
  useEffect(() => {
    if (!live || !stageReady) return;
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (!c) continue;
      void c.setLocalHashes([...tierList]).catch(() => {});
    }
  }, [live, stageReady, tierList]);

  // Both the picture layer and the sound layer are managed by MediaLayers: several pictures can be present at once (overlap + fade = crossfade), and audio clips sound on their own

  // Hit-test and drag logic
  /**
   * A hit is an async round trip (the stage is in an iframe), but **the start point must not be lost**:
   * on pointerdown, synchronously capture the pointer and record the start point first, then await
   * hitTest; pointermove / pointerup events arriving during the await accumulate first, and once the hit
   * result returns we decide whether to select or start dragging.
   * The first few move events of "click the canvas and drag at once" are not missed, and releasing
   * before the reply arrives will not leave a state that drags forever.
   */
  const handleOverlayPointerDown = async (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const overlay = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    if (framed && !isFramedFitted(camRef.current, project, boxSize ?? { width: project.width, height: project.height })) {
      // While zoomed in framed mode, dragging >= 4px pans on `boxRef`; do not steal pointer capture or fire selection on a pan drag.
      const panned = await new Promise<boolean>((resolve) => {
        const cleanup = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onEnd);
          window.removeEventListener("pointercancel", onEnd);
        };
        const onMove = (ev: PointerEvent) => {
          if (ev.pointerId !== pointerId) return;
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) >= 4) { cleanup(); resolve(true); }
        };
        const onEnd = (ev: PointerEvent) => {
          if (ev.pointerId !== pointerId) return;
          cleanup();
          resolve(Math.hypot(ev.clientX - startX, ev.clientY - startY) >= 4);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onEnd);
        window.addEventListener("pointercancel", onEnd);
      });
      if (panned) return;
    } else {
      try { overlay.setPointerCapture(pointerId); } catch { /* The pointer is already gone, but the hit can still be computed */ }
    }

    // Events during the await are recorded first
    let lastX = startX;
    let lastY = startY;
    let released = false;
    const onEarlyMove = (ev: PointerEvent) => { if (ev.pointerId === pointerId) { lastX = ev.clientX; lastY = ev.clientY; } };
    const onEarlyUp = (ev: PointerEvent) => { if (ev.pointerId === pointerId) released = true; };
    window.addEventListener("pointermove", onEarlyMove);
    window.addEventListener("pointerup", onEarlyUp);
    window.addEventListener("pointercancel", onEarlyUp);

    const { hit: targetRect } = await hitAt({ clientX: startX, clientY: startY, currentTarget: overlay });

    window.removeEventListener("pointermove", onEarlyMove);
    window.removeEventListener("pointerup", onEarlyUp);
    window.removeEventListener("pointercancel", onEarlyUp);

    const release = () => { try { if (overlay.hasPointerCapture(pointerId)) overlay.releasePointerCapture(pointerId); } catch { /* Already released */ } };

    if (tool === "select") {
      release();
      // Select tool: clicking an entity selects it and flashes its outline; clicking blank space (or nothing under a transparent area) deselects
      if (targetRect) {
        actions.select([targetRect.clipId]);
        flashClip(targetRect.clipId);
        // Use 'all' for this click: the outline of a newly selected canvas card follows the pixel box, and does not fall back to the whole canvas
        void refreshRects("all");
      } else {
        actions.select([]);
      }
    } else if (tool === "move") {
      // Move tool: press to start dragging, update the local drag state while moving, and only write to the store on release to record undo
      if (!targetRect) { release(); return; }
      actions.select([targetRect.clipId]);
      flashClip(targetRect.clipId);
      const clipId = targetRect.clipId;

      let currentDx = 0;
      let currentDy = 0;
      const applyMove = (cx: number, cy: number) => {
        // The overlay is displayed scaled by scale; convert the displacement back to stage pixels, the same units frame uses
        currentDx = (cx - startX) / scale;
        currentDy = (cy - startY) / scale;
        setDragPreview({ clipId, dx: currentDx, dy: currentDy });
      };
      const onMove = (ev: PointerEvent) => { if (ev.pointerId === pointerId) applyMove(ev.clientX, ev.clientY); };
      const onUp = () => {
        setDragPreview(null);
        release();
        if (Math.abs(currentDx) > 0.5 || Math.abs(currentDy) > 0.5) {
          /*
           * Dragging changes the clip's frame (the position box), not the card parameters: cards have no x / y
           * parameters, and writing x / y into params used to change nothing: the outline followed the mouse for
           * a while and then snapped back on release.
           * It goes through nudgeFrame, the same path as the Agent's nudge / set_position: for a card without a
           * frame, first compute the current position as if it filled the stage, then add the displacement; it
           * writes only once on release, so one drag = one undo step.
           */
          const hit = findClip(getState().project, clipId);
          if (hit) {
            const stageSize = { width: getState().project.width, height: getState().project.height };
            actions.setClipFrame(clipId, nudgeFrame({ dx: Math.round(currentDx), dy: Math.round(currentDy) }, hit.clip.frame, stageSize));
          }
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };

      // If it already moved / was released before the reply arrived, catch up now
      if (lastX !== startX || lastY !== startY) applyMove(lastX, lastY);
      if (released) { onUp(); return; }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    } else {
      release();
    }
  };

  // Text tool logic
  const handleOverlayDoubleClick = async (e: React.MouseEvent) => {
    if (tool !== "text") return;
    const { hit: targetRect, overlayRect: rect } = await hitAt(e);
    if (!targetRect) return;
    flashClip(targetRect.clipId);

    const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === targetRect.clipId);
    if (!clip) return;
    const def = getCard(clip.cardId);
    if (!def) return;
    const textControl = def.controls.find((c) => c.type === "text");
    if (!textControl) return;

    const val = (clip.params[textControl.key] as string) ?? def.defaults[textControl.key] ?? "";
    
    // Position the input box at the card's top-left corner (converted from the hit target's rectangle)
    const inputX = targetRect.left * scale + rect.left;
    const inputY = targetRect.top * scale + rect.top;

    setEditingText({
      clipId: clip.id,
      key: textControl.key,
      value: val,
      x: inputX,
      y: inputY,
    });
  };

  const handleOverlayContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const { clientX, clientY, currentTarget } = e;
    const { hit: targetRect } = await hitAt({ clientX, clientY, currentTarget });
    if (targetRect) {
      const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === targetRect.clipId);
      if (clip) {
        actions.select([clip.id]);
        flashClip(clip.id);
        setContextMenu({ x: clientX, y: clientY, clipId: clip.id, cardId: clip.cardId });
      }
    }
  };

  const submitTextEdit = () => {
    if (editingText) {
      actions.setClipParams(editingText.clipId, { [editingText.key]: editingText.value }, { merge: true });
    }
    setEditingText(null);
  };

  /** Where in the window the frame's top-left corner should go. Not placed until the window size is measured (that frame passes before paint) */
  const frameXY = boxSize ? frameOrigin(cam, project, boxSize) : null;
  const effectiveBox = boxSize ?? { width: project.width, height: project.height };
  const framedFitted = framed ? isFramedFitted(cam, project, effectiveBox) : true;
  const framedPct = framed ? framedZoomPercent(cam, project, effectiveBox) : 100;

  return (
    <div className={compact ? (framed ? "pc-pv pc-pv--mobile pc-pv--framed" : "pc-pv pc-pv--mobile") : "pc-pv"} data-pc="preview">
      {!compact && <div className="pc-pv-tabs" data-pc="preview-tabs">
        {([["2d", is3DCut ? trText("Camera") : "2D"], ["3d", is3DCut ? trText("Space") : "3D"]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            data-pc-view={is3DCut ? (id === "2d" ? "camera" : "space") : id}
            className={view === id ? "is-on" : undefined}
            onClick={() => setView(id)}
            title={
              id === "2d"
                ? (is3DCut ? trText("Camera view: live output camera frame of this 3D cut") : trText("Final video preview: what you see is what you export"))
                : (is3DCut ? trText("Space view: orbit freely in 3D space with the live output camera frustum") : trText("3D view: orbit around like in Blender to see how these cards are arranged in space"))
            }
          >
            {label}
          </button>
        ))}
      </div>}
      {online && <CostSearchGate />}
      {online && gateViewerWanted() && <GateViewer />}

      {!show3DScene && !compact && <ToolBar tool={tool} onToolChange={setTool} zoom={cam.scale} fitted={cam.auto} onFit={fitToWindow} />}

      {/*
        * **The 2D page resides permanently under the 3D page; it is only hidden, not unmounted.**
        *
        * Previously it was `view === "3d" ? <3D/> : <2D/>`; switching to 3D unmounted the stage iframe
        * along with the audio layer of the main document. But the playhead **follows the stage**
        * (docs/semantics/product/rendering.md "Playhead follows stage", K4: under non-legacy, only the
        * `frame` event of the visible stage advances `t`): once the stage is gone, pressing play on the
        * 3D page moves nothing and audio is gone too. Now the stage runs continuously, the 3D page still
        * reads the same `t`, and the playback timeline and audio are identical to the 2D page.
        *
        * The only way to hide it is `opacity: 0` + ignoring pointer events (same reason as the background
        * stage; see comments on iframe B): `display: none` stops rAF and `<video>` inside the iframe, while
        * `visibility: hidden` causes `isSolid` to misclassify the entity box. `inert` additionally blocks
        * keyboard focus from falling into the invisible page.
        * The hidden page covers the same area with `inset: 0`; the window size is unchanged, so switching
        * back to 2D requires no zoom re-adaptation.
        */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* Tier bubble: shown once above the preview window after the stage gate finishes and the editor is entered, and disappears automatically after a few seconds (`TierBubble.tsx`) */}
      {online && <TierBubble ready={stageReady > 0} />}
      {show3DScene && (
        <div className="pc-pv-stage" style={{ position: "relative" }}>
          <Scene3DView
            project={project}
            t={t}
            mode={scene3DMode}
            onSelectCamera={(id) => (actions as any).selectCamera?.(id)}
          />
        </div>
      )}
      <div
        ref={boxRef}
        className="pc-pv-stage"
        data-pc="preview-2d"
        data-zoomed={framed && !framedFitted ? "true" : undefined}
        aria-hidden={show3DScene || undefined}
        inert={show3DScene}
        style={show3DScene ? { position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" } : undefined}
      >
        <div
          className="pc-pv-frame pc-checker"
          style={{
            width: project.width * scale,
            height: project.height * scale,
            /*
             * The position is computed entirely by ourselves (see the note at boxSize: relying on the browser's
             * centering becomes inaccurate after zooming in).
             * Absolutely positioned at the top-left corner, then moved to where it should be with transform:
             * transform does not trigger reflow, and it is changed on every frame while dragging, whereas
             * left/top would reflow all the way.
             */
            position: "absolute",
            left: 0,
            top: 0,
            transform: frameXY ? `translate(${frameXY.x}px, ${frameXY.y}px)` : undefined,
            /*
             * The transparent checkerboard has moved to .pc-checker (see preview/preview.css).
             *
             * It used to be written inline here with a different, darker set of values, on the grounds of "color
             * spec item 04: transparent cells must be darker and weaker than the surrounding canvas".
             * That rule is not wrong in itself, but it conflicts with the question this background really has to
             * answer: **is there nothing here?**
             * Once the background is dark, a dark card looks exactly like "nothing drawn": see_frames and the 3D
             * view have both been bitten by this. Also, the 2D and 3D tabs each used their own values, so the same
             * project looked "transparent" differently on the two tabs. So it is unified onto the mid-gray set,
             * aligned value by value with see_frames.
             */
          }}
        >
          <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0", position: "absolute", left: 0, top: 0, ...themeStyle(project.themeId) }}>
            <div style={{ position: "relative", width: project.width, height: project.height }}>
              {/* K4's `mediaStalled`: when a stage tick comes more than 40 ms later than its due time, the audio pauses along with it; audio does not start before the first tick of this playback run arrives */}
              <MediaLayers project={project} t={t} playing={playing && !mediaStalled && (!live || firstBeatRef.current)} masterVolume={muted ? 0 : volume} audioOnly localHashes={tierList} />
              {/*
                * Stage iframes are mounted by slot: single stage (`single`, first level of the stage gate, lowest
                * tier, fallback on handshake failure, all are cross-origin A), cross-origin A (`dualA`),
                * cross-origin B (`dualB`), in fixed order, keyed by slot.
                * Online mode always uses cross-origin isolation: when the stage origin cannot be read, it no longer
                * falls back to a same-origin single stage, but simply does not mount the stage iframe
                * (user decision, 2026-10-14); handshake failure falls back to cross-origin single stage A
                * (only applies to the current run, leaving no crash records; `mechanism/platforms.md` "Three gates").
                */}
              {!stagesPending && !(ONLINE && !stageOrigins()) && (() => {
                const base = {
                  position: "absolute" as const,
                  inset: 0,
                  width: project.width,
                  height: project.height,
                  border: 0,
                  display: "block",
                  background: "transparent",
                  colorScheme: "normal" as const,
                };
                const hidden = { opacity: 0, pointerEvents: "none" as const };
                const out: React.ReactNode[] = [];
                const showSingle = !dual || handover;
                if (showSingle) {
                  const cover = dual && handover;
                  out.push(<iframe
                    key={`single-${stageFrameGen.A}`}
                    ref={cover ? undefined : frameRefOf.A}
                    data-pc={cover ? "stage-frame-cover" : "stage-frame"}
                    title={trText("Preview stage")}
                    sandbox={ONLINE ? STAGE_SANDBOX : undefined}
                    onLoad={() => onStageFrameLoad("A")}
                    /*
                     * **Do not add proxy=1** here: the 2D preview's contract is "what the preview shows = what the export
                     * gives", and swapping in color blocks during playback breaks it: when the user presses play they
                     * want to see what the final video looks like, not a composition sketch. The proxy lives only in the
                     * 3D view, and only as a transition while the prerender has not caught up.
                     */
                    src={stageSrc("A", { dual: false })}
                    style={{
                      ...base,
                      /*
                       * R7: **the stage is exposed** (D5). The visible one is no longer fully transparent: what the user
                       * sees is the stage iframe itself, no longer the full-frame `<img>` in the main document.
                       *
                       * The criterion is `live`: the online page's same-origin single stage also renders the live variant
                       * (`stageSrc` carries `&preview=stage`).
                       * When the desktop app falls back to the same-origin single stage because a port is taken, that one
                       * still has placeholder content, and exposing it would show a picture without media: in that case
                       * keep using `UnifiedPreview`'s full frame.
                       * The cover when switching back to dual stage stays exposed as well (stopped on the last frame) and
                       * blocks the pointer.
                       */
                      ...(cover ? { opacity: 1, pointerEvents: "none" as const } : { opacity: live ? 1 : 0 }),
                    }}
                  />);
                }
                if (dual || interim) {
                  const warm = !dual;
                  out.push(<iframe
                    key={`dualA-${stageFrameGen.A}`}
                    ref={warm ? warmRefOf.A : frameRefOf.A}
                    data-pc={warm ? "stage-frame-warm" : "stage-frame"}
                    title={warm ? trText("Warm-up stage") : trText("Preview stage")}
                    /*
                     * The online cross-origin stage carries a sandbox (contract `online-card-exec-contract.md`, section
                     * 3.3): only two flags are enabled, scripts and keeping its own origin; no popups, top-level
                     * navigation, forms, modals or downloads. The stage is a cross-origin address, and
                     * `allow-same-origin` only lets it keep its own origin (it needs that to read media on its own
                     * origin); it does not become the editor page's origin. The desktop runtime does not carry it.
                     */
                    sandbox={ONLINE ? STAGE_SANDBOX : undefined}
                    src={stageSrc("A", { dual: true })}
                    onLoad={() => onStageFrameLoad("A")}
                    style={{
                      ...base,
                      // The background one must also block the pointer: after the K5 swap, A may be the background one; do not expose it during the handoff when switching back to dual stage
                      ...(!warm && live && frontId === "A" && !handover ? { opacity: 1 } : hidden),
                    }}
                  />);
                  if (!ONLINE || backStageMount) {
                    out.push(<iframe
                      key={`dualB-${stageFrameGen.B}`}
                      ref={warm ? warmRefOf.B : frameRefOf.B}
                      data-pc={warm ? "stage-frame-warm" : "stage-frame-back"}
                      title={warm ? trText("Warm-up stage") : trText("Background stage")}
                      sandbox={ONLINE ? STAGE_SANDBOX : undefined}
                      src={stageSrc("B", { dual: true })}
                      onLoad={() => onStageFrameLoad("B")}
                      style={{
                        ...base,
                        /*
                         * The background stage **can only be hidden this way** (K5 (4)): `display: none` would stop the
                         * `<video>` and rAF inside it and zero out the whole layout, so the caught-up picture would not match
                         * the visible stage;
                         * `visibility: hidden` would make `isSolid` in `solid.ts` judge it not a solid, and the measured solid
                         * box would fall back to the full screen. `opacity: 0` keeps layout and rendering, it just cannot be seen.
                         *
                         * R7: after the swap B may be the visible one, and then it is exposed along with it.
                         */
                        ...(!warm && frontId === "B" && !handover ? { opacity: 1 } : hidden),
                      }}
                    />);
                  }
                }
                return out;
              })()}
              {/*
                * R7(D5): full-frame `<img>` / `MovPlayer` canvas **remains only in the legacy branch**.
                * Drawing another full frame after revealing the stage amounts to covering the stage, and that layer
                * must wait for HTTP: the rule "paused scrubbing updates in the same frame without waiting for HTTP"
                * would be lost.
                */}
              {!live && <UnifiedPreview project={project} t={t} playing={playing} />}
            </div>
          </div>
          
          {/* Corner marks: one 16-square L shape at each corner of the design frame, hinting that this is an editable canvas */}
          <span className="pc-pv-corner tl" aria-hidden="true" />
          <span className="pc-pv-corner tr" aria-hidden="true" />
          <span className="pc-pv-corner bl" aria-hidden="true" />
          <span className="pc-pv-corner br" aria-hidden="true" />

          {/* Canvas overlay, handles hit-testing and drag drawing */}
          <div
            style={{ position: "absolute", inset: 0, zIndex: 10 }}
            onPointerDown={handleOverlayPointerDown}
            onDoubleClick={handleOverlayDoubleClick}
            onContextMenu={handleOverlayContextMenu}
          >
            {rects.map((r) => {
              const isSelected = selection.includes(r.clipId);
              if (!isSelected) return null;
              const dragDx = (dragPreview?.clipId === r.clipId) ? dragPreview.dx : 0;
              const dragDy = (dragPreview?.clipId === r.clipId) ? dragPreview.dy : 0;

              // The outline hugs the entity's extent; the one just hit carries a token in its key, so the pulse animation reruns on every click
              const pulsing = flash?.clipId === r.clipId;
              return (
                <div
                  key={pulsing ? `${r.clipId}:${flash!.token}` : r.clipId}
                  className={`pc-pv-hit${pulsing ? " is-pulse" : ""}`}
                  style={{
                    left: (r.left + dragDx) * scale,
                    top: (r.top + dragDy) * scale,
                    width: r.width * scale,
                    height: r.height * scale,
                  }}
                />
              );
            })}
          </div>
        </div>
        {framed && (
          <div className="pc-pv-zoom-bar" data-pc="preview-zoom" role="group" aria-label={trText("Zoom")}>
            <span className="pc-pv-zoom-pct" data-pc="preview-zoom-pct">{`${framedPct}%`}</span>
            <button
              type="button"
              className="pc-pv-zoom-fit"
              data-pc="preview-zoom-fit"
              disabled={framedFitted}
              onClick={fitToWindow}
              title={trText("Fit window")}
            >
              {trText("Fit")}
            </button>
          </div>
        )}
      </div>
      </div>

      {!compact && <ControlBar />}
      
      {contextMenu && (
        <PreviewContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          clipId={contextMenu.clipId}
          cardId={contextMenu.cardId}
          onClose={() => setContextMenu(null)}
        />
      )}
      
      {editingText && (
        <div style={{ position: "fixed", left: editingText.x, top: editingText.y, zIndex: 9999 }}>
          <input
            autoFocus
            type="text"
            value={editingText.value}
            onChange={(e) => setEditingText({ ...editingText, value: e.target.value })}
            onBlur={submitTextEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitTextEdit();
              if (e.key === "Escape") setEditingText(null);
            }}
            style={{
              padding: "4px 8px",
              border: "1px solid var(--ui-accent)",
              borderRadius: 4,
              background: "var(--ui-panel-2)",
              color: "var(--ui-fg)",
              outline: "none",
              fontSize: 14,
            }}
          />
        </div>
      )}
    </div>
  );
}

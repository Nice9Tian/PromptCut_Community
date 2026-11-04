/**
 * Clock.
 * Preview: performance.now() drives rAF to run by itself.
 * Export: the export script explicitly sends window.__pcExportMs on every frame; the page clock cannot
 *      be trusted (Chrome's virtual time quietly fast-forwards while resources load). Any code that needs
 *      "what time it is now" goes through clockNow().
 */
declare global {
  interface Window {
    __pcExportMs?: number;
    __pcClockRate?: number;
    __pcSetT?: (sec: number, directSec?: number) => void;
    __pcReady?: boolean;
    __pcTimeline?: unknown;
    __pcCardPlan?: () => unknown;
    /** Export: remount all cards (playToken+1) */
    __pcRestartCards?: () => void;
    /** Export: after advancing virtual time on each frame, pin the currentTime of all Web Animations to the export time */
    __pcSyncAnims?: () => void;
    /** Export: clear the animation anchors (called once before frames are formally counted) */
    __pcResetAnims?: () => void;
    /** Export: the assets of this frame (video seek and so on) are ready */
    __pcFrameReady?: () => Promise<void>;
    __pcFrameWorkStatus?: () => { label: string; error?: string }[];
    /**
     * Export: how many times rAF wrapped by exportClock has been registered.
     * A rAF-driven JS animation (Motion's MotionValue) re-registers the next frame on every frame and stops
     * registering once it stops, so "the count did not increase within this step" is equivalent to "no JS
     * animation is running". document.getAnimations() cannot see this kind of animation.
     */
    __pcRafCount?: number;
    /**
     * Export: the original rAF that is not counted. The export script uses it to wait for frames itself, so it
     * does not push up __pcRafCount.
     */
    __pcRealRaf?: (cb: FrameRequestCallback) => number;
    /** Stage: performance.now from before it was taken over (used to time probes / RPC; stage time is virtual) */
    __pcRealNow?: () => number;
    /** Stage: the real setTimeout (the virtual clock does not move while paused, and fallback timing relies on it) */
    __pcRealSetTimeout?: (cb: () => void, ms?: number) => number;
    /** Stage: the real setInterval (after E4b, window.setInterval is registered on the virtual clock) */
    __pcRealSetInterval?: (cb: () => void, ms?: number) => number;
    /** Stage / export page: Date.now from before it was pinned by pinEntropy (E4b) */
    __pcRealDateNow?: () => number;
    /**
     * Export page / prerender snapshot page: the export surface of entity geometry (see render/solid.ts), for
     * page.evaluate on the puppeteer side
     */
    __pcSolid?: import('../render/solid').SolidApi;
    /** Export page: the entity box of the canvas (canvas pixel coordinates), same as __pcSolid.canvasPaintedBox */
    __pcCanvasBox?: import('../render/solid').SolidApi['canvasPaintedBox'];
    /**
     * Stage page: RPC method table (the parent page goes through postMessage; this is attached only for test
     * pages / puppeteer to call directly)
     */
    __pcStage?: import('../render/stageRpc').StageRpcApi;
    /**
     * Stage page: the K2 dispatch table accepted by `setPlan` (sets backfilled) + per-card records
     * from K1, with the shape of `StagePlan` from `src/render/wirePlan.ts` (written as `unknown` here
     * to avoid adding another reverse edge from kernel → render; see allowlist in
     * `src/layering.test.mjs`). Consumed by K3 / K5 (R5); attached here for acceptance probes to inspect
     * "whether the table has arrived and whether the calculated result is light or heavy".
     */
    __pcStagePlan?: () => unknown;
    /**
     * Stage page: flattened internal state at this moment (roles, ticks, four sets, frame catch-up
     * tasks, K6 window). **Read-only, no side effects**, for acceptance probes: cross-origin cannot
     * access the iframe's `document`, so the stage must hand over its state itself (shape written as
     * `unknown`, for the same reason as `__pcStagePlan`).
     */
    __pcStageDiag?: () => unknown;
    /** Stage page: check which pipeline this clip takes at this moment per K2's table (`pipelineAt`). Always `'heavy'` without a table. */
    __pcStagePipelineAt?: (clipId: string, tSec: number) => 'light' | 'heavy';
    /**
     * Export: DOM mutation count. The primary basis for static frame determination: Motion's JS
     * animations bypass the replaced rAF, but they must write new values back to style / text nodes
     * every frame, which cannot be avoided. See exportClock.ts for details.
     */
    __pcMutationCount?: number;
    /** Export: whether this frame is static (only reuse the previous frame's screenshot when static) */
    __pcStaticProbe?: () => { anims: number; finished: number; raf: number; mut: number; video: boolean; canvas: boolean };
    /** Export: reset Math.random seed back to start (called on each card remount) to make random effects reproducible */
    __pcResetRandom?: (seed?: number) => void;
    /** Export: switch projects in place without re-navigating. Used when resident prerender processes reuse the same page. */
    __pcLoadProject?: (raw: unknown, options?: { deferCards?: boolean }) => Promise<void>;
    /** Restrict a sparse render to target-frame cards and seek before mounting. */
    __pcSetFrameWindow?: (clipIds: string[] | null, startTime: number, directTime?: number) => void;
    __pcPlanFrameWindow?: (frames: number[], fps: number) => import('../render/frameWindow.mjs').FrameWindow;
    /** Parallel export: every card clip with its frame mode, for choosing safe shard cuts. */
    __pcClipFrameModes?: () => { id: string; start: number; end: number; mode: string | undefined }[];
    /** Export: remove media layer src (load no media while advancing animations) */
    __pcHideFrameMedia?: () => void;
    /** Export: restore this frame's media per data-pc-media-* and seek into place */
    __pcPrepareFrameMedia?: () => Promise<void>;
    /** Export: drain pending macrotasks until the DOM stops changing (see render/snapshotSettle.ts) */
    __bfSettle?: () => Promise<void>;
    /** Export / stage: generate a self-contained HTML snapshot of [data-pc-scene] at this moment (see render/createSnapshot.ts) */
    __pcCreateSnapshot?: () => import('../render/createSnapshot').SceneSnapshot;
  }
}

export function isExportMode(): boolean {
  return typeof window.__pcExportMs === "number";
}

export function clockNow(): number {
  const t = window.__pcExportMs;
  return typeof t === "number" ? t : performance.now();
}

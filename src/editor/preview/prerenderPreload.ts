/**
 * Scheduling for the page to trigger prerender (`preload`): after an edit push succeeds and the
 * system is idle, send once with debounce, and keep asking if not ready.
 *
 * Why the page has to send it: the prerender process starts a background prerender for this version
 * of the project only on receiving `POST /api/frames/preload` (anchor frames, control snapshots,
 * local tier, track streams). Previously only the legacy preview (`UnifiedPreview`) sent it, and in
 * dual-stage mode nobody did:
 * heavy cards in real use never got prerender output, and the fallback order often went all the way
 * down to the placeholder.
 *
 * "Edit push succeeded" is guaranteed by `frameRequest`: it first calls `alignMirror()` (pushes
 * unpushed changes and waits for them to land), then sends the request with
 * `{ session, localRev }`; when the mirror is missing a key (409), it re-pushes the whole thing
 * once. "Idle" = not playing and not dragging (supplied by the caller):
 * the background lane yields to playback anyway, and the version interrupted during playback stays
 * at `partial`; sending again after idle picks up where it left off.
 *
 * The scheduling itself is pure logic (timers are injectable); the unit test is in
 * `prerenderPreload.test.mjs`; the React layer is in `usePrerenderPreload.ts`.
 */

/** After an edit, send only once there have been no new changes for this long (debounce) */
export const PRELOAD_DEBOUNCE_MS = 800;
/** How long to wait before asking again when not ready yet */
export const PRELOAD_POLL_MS = 2000;
/** How long to wait before retrying after a request fails (prerender process restart, etc.) */
export const PRELOAD_RETRY_MS = 4000;
/** Release the single-flight slot when a background request doesn't settle; a normal full prerender can take several minutes */
export const PRELOAD_REQUEST_TIMEOUT_MS = 6 * 60_000;

export interface PreloadStatus {
  status?: string;
  sampled?: number;
}

export interface PreloadDeps {
  /** Send one preload (the caller uses `frameRequest("preload", …, { target: "prerender", lane: "background" })`) */
  request(signal: AbortSignal): Promise<PreloadStatus>;
  /** Notified after every response (the legacy preview uses it to archive sampled frames) */
  onStatus?(status: PreloadStatus): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface PreloadScheduler {
  /** The project changed (a new version has to be pushed to the prerender process) */
  edited(): void;
  /** Whether idle (not playing, not dragging) */
  setIdle(idle: boolean): void;
  dispose(): void;
}

export function createPreloadScheduler(deps: PreloadDeps): PreloadScheduler {
  let idle = false;
  /** There is a version not yet sent (edited, or needs one recheck after idle) */
  let dirty = true;
  let done = false;
  let inFlight = false;
  let disposed = false;
  let timer: unknown = null;
  let requestGeneration = 0;
  let activeAbort: AbortController | null = null;
  let activeWatchdog: unknown = null;

  const clear = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };
  const arm = (ms: number) => {
    clear();
    timer = deps.setTimer(() => { timer = null; void run(); }, ms);
  };

  const run = async (): Promise<void> => {
    if (disposed || !idle || inFlight) return;
    inFlight = true;
    dirty = false;
    const generation = ++requestGeneration;
    const controller = new AbortController();
    activeAbort = controller;
    const watchdog = deps.setTimer(() => {
      activeWatchdog = null;
      if (disposed || generation !== requestGeneration) return;
      requestGeneration++;
      controller.abort();
      activeAbort = null;
      inFlight = false;
      if (idle) arm(PRELOAD_RETRY_MS);
    }, PRELOAD_REQUEST_TIMEOUT_MS);
    activeWatchdog = watchdog;
    let status: PreloadStatus | null = null;
    try {
      status = await deps.request(controller.signal);
    } catch {
      deps.clearTimer(watchdog);
      if (activeWatchdog === watchdog) activeWatchdog = null;
      if (generation !== requestGeneration) return;
      inFlight = false;
      activeAbort = null;
      if (!disposed && idle) arm(PRELOAD_RETRY_MS);
      return;
    }
    deps.clearTimer(watchdog);
    if (activeWatchdog === watchdog) activeWatchdog = null;
    if (generation !== requestGeneration) return;
    inFlight = false;
    activeAbort = null;
    if (disposed) return;
    try { deps.onStatus?.(status); } catch { /* An error in the notifier doesn't affect scheduling */ }
    done = status?.status === "ready";
    if (!idle) return;
    // Edited while a request is in flight: send again with debounce; otherwise keep asking if not ready
    if (dirty) arm(PRELOAD_DEBOUNCE_MS);
    else if (!done) arm(PRELOAD_POLL_MS);
  };

  return {
    edited() {
      if (disposed) return;
      dirty = true;
      done = false;
      if (idle && !inFlight) arm(PRELOAD_DEBOUNCE_MS);
    },
    setIdle(next) {
      if (disposed || next === idle) return;
      idle = next;
      if (!idle) { clear(); return; }
      // Idle: the background version may have stopped at `partial` during playback, so recheck once (also debounced, so it doesn't jump in right after a drag is released)
      if (!done) dirty = true;
      if (dirty && !inFlight) arm(PRELOAD_DEBOUNCE_MS);
    },
    dispose() {
      disposed = true;
      requestGeneration++;
      activeAbort?.abort();
      activeAbort = null;
      if (activeWatchdog !== null) deps.clearTimer(activeWatchdog);
      activeWatchdog = null;
      clear();
    },
  };
}

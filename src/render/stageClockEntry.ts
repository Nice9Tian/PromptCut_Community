/**
 * Installation entry point for render plane clock. **Must be the first import in main.tsx.**
 *
 * Motion captures requestAnimationFrame into its frame loop during its own module initialization
 * (createRenderBatcher(requestAnimationFrame, ...)), so patches installed after it have no effect
 * on it: cards would still play against the wall clock, and scrubbing the playhead would turn back
 * into "replaying from the start". Therefore, this file must come before all imports that bring
 * in motion.
 *
 * Only install in the render plane with ?stage=1; do not install in editor main document,
 * otherwise its own UI animations will be frozen along with it.
 *
 * The same applies to random numbers and the wall clock: third-party libraries capture Math.random
 * when modules load (lottie-web's `BMMath.random = Math.random`), so pinEntropy must also be
 * installed here before all imports: installed in both export view (?export=1) and render plane
 * (?stage=1). In export view, performance.now / rAF are still installed by installExportClock in
 * ExportView with timing unchanged (installing early would replace Motion's timestamp source).
 * proto-main.tsx also places this file on the first line, equally covering the export entry of
 * proto.html.
 */
import { installStageClock } from "./stageClock";
import { installPinnedEntropy } from "../kernel/pinEntropy";

/**
 * Export pages for browser frame-by-frame export (C10a, `src/export/frameCompositor.ts`) carry
 * `?export=1&rafControl=1`: there is no CDP beginFrame here, and if real rAF ran as usual,
 * Motion's frame loop (which captured rAF during module evaluation) would advance one tick every
 * real vsync, pushing at least 1 ms per tick; compositing a frame takes hundreds of milliseconds,
 * so spring-like animations would run faster and faster. Therefore, before Motion runs, rAF is
 * replaced with a manual queue: callbacks run one round only when exporter calls
 * `window.__pcBrowserBeginFrame()` (one tick = one beginFrame in desktop export). Fallback: if
 * callbacks are queued and no one advances them for 5 seconds (something in the page is waiting
 * for rAF), advance one tick automatically and record it in `__pcRafFallbacks` to prevent export
 * from hanging; in normal exports it should be 0 (surfaced in browser export stats). Desktop
 * export and prerender do not carry `rafControl`, left unchanged byte for byte.
 */
function installManualRaf(): void {
  const w = window as Window & { __pcBrowserBeginFrame?: () => number; __pcRafFallbacks?: number };
  let queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  let fallback: ReturnType<typeof setTimeout> | null = null;
  w.__pcRafFallbacks = 0;
  const beginFrame = (): number => {
    if (fallback !== null) { clearTimeout(fallback); fallback = null; }
    const due = queue;
    queue = new Map();
    const ts = performance.now();
    for (const cb of due.values()) { try { cb(ts); } catch (e) { console.error(e); } }
    return due.size;
  };
  w.__pcBrowserBeginFrame = beginFrame;
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId++;
    queue.set(id, cb);
    fallback ??= setTimeout(() => { fallback = null; w.__pcRafFallbacks = (w.__pcRafFallbacks ?? 0) + 1; beginFrame(); }, 5000);
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => { queue.delete(id); };
}

if (typeof window !== "undefined") {
  const q = new URLSearchParams(location.search);
  if (q.has("stage")) {
    installStageClock();
    installPinnedEntropy(); // After stage clock: Date must be able to read stage time
  } else if (q.has("export")) {
    if (q.get("rafControl") === "1") installManualRaf();
    installPinnedEntropy();
  }
}

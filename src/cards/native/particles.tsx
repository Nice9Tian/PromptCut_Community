import { useEffect, useRef } from "react";
import { beginFrameWork } from "../../kernel/frameReady";
import { tsParticles, setRandom, EventType, type Container } from "@tsparticles/engine";
import { loadSlim } from "@tsparticles/slim";
import type { CardDef, CardProps } from "../../kernel/types";
import { assetOptions } from "../catalogAssets";


/**
 * Particle background: floating particles drawn by tsParticles (MIT) on a canvas, with optional connecting lines.
 *
 * This is the first canvas card. It gets into export thanks to three things, and none can be missing:
 *   1. Random numbers: tsParticles grabs Math.random and stores it when the module loads (the `_random` in
 *      engine/Utils/MathUtils.js), so the pinning of Math.random in the export page cannot reach it. So every mount
 *      calls setRandom to connect it back to the global Math.random "at call time" (in the export page that one is
 *      seeded, and every remount rewinds it to the starting point).
 *   2. Frame loop: it uses requestAnimationFrame at call time, which goes through the layer wrapped by exportClock,
 *      with timestamps pinned to the export milliseconds. Several ticks in the same frame have the same timestamp →
 *      delta is 0 → nothing moves; across frames delta is exactly one step.
 *   3. Screenshot window: during the screenshot the export script turns off script execution, so the particles do not
 *      take a few more steps in the freely running virtual time of that period.
 * The probe that skips static frames does not judge a page with a visible canvas as still, so this card is really
 * captured on every frame.
 */

interface Params {
  config: string;
  color: string;
  quantity: number;
  speed: number;
  size: number;
  links: string;
  seed: number;
}

/** The engine plugins are installed only once and shared by all particle cards */
let engineReady: Promise<void> | null = null;

/*
 * # Container loading is queued across the whole module, one at a time
 *
 * The engine is global, and two things are shared by all containers:
 *   1. **There is only one random source**: `setRandom` replaces the one function inside the engine module, and whoever
 *      calls it last wins;
 *   2. **Containers replace each other by id**: when `Engine.load` finds an old container with the same name it
 *      destroys it first. When no id is passed it takes `element.id`; our div has no id, so all containers are named
 *      "" and the particle card installed later destroys the container of the one installed earlier.
 * And installing a container is asynchronous (`load` → `start` → `init`, a dozen awaits), and **destroying does not
 * stop it**: `Container.init()` checks `destroyed` only once at the entrance, so a destroyed container still lays out
 * all its particles and still draws numbers from the random source "of that moment".
 *
 * Trouble comes when two loads interleave. Measured (paused, clicking backwards on the timeline): the stage first
 * hands the backwards t to the old component, and the old component starts to reinstall (first load in flight); in
 * the same synchronous block the stage remounts this card per clip, and the new component seeds and starts to install
 * (second load). The second load destroys the first one's container as having the same name, but the first one's init
 * is still running and takes the first 840 numbers from the random numbers the new component has just seeded, so the
 * new container gets the numbers from the 841st on. The particle layout then has nothing to do with this moment
 * (compared with the same frame reached going forward, it differs as much as two unrelated frames), and it is
 * consistently wrong in the same way every time.
 *
 * So:
 *   - Loads are queued: the next one starts only after the previous one has **finished laying out its particles** (or
 *     failed), and during a load the random source belongs only to it;
 *   - A queued load that is invalidated before it starts (unmount, config changed) is skipped, not a word of it is
 *     installed; one that has already started is destroyed after it finishes laying out;
 *   - Each container gets an id of its own, so they do not replace each other;
 *   - Each container has its own random stream, swapped in while advancing and, when done, the source is given back to
 *     the load in progress (`stepTo`): several particle cards on the same screen each go their own way.
 * For a single card, the order of drawing random numbers is the same one by one as before: seed → draw at load → draw
 * at advance, all from the same stream (naming never drew random numbers to begin with: it takes `element.id`).
 */
interface LoadJob {
  el: HTMLElement;
  opts: Record<string, any>;
  rand: () => number;
  cancelled: boolean;
  resolve: (c: Container | null) => void;
  reject: (e: unknown) => void;
}
const loadQueue: LoadJob[] = [];
/** The load in progress (the random source belongs to it right now) */
let loading: LoadJob | null = null;
let pumpQueued = false;
let containerSeq = 0;

/**
 * Queue one load. The returned Promise: resolves to the container once the particles are laid out; to null if it was
 * invalidated; rejects if it cannot be installed. `cancel` invalidates this load
 */
function requestLoad(el: HTMLElement, opts: Record<string, any>, rand: () => number): { promise: Promise<Container | null>; cancel: () => void } {
  let resolve!: (c: Container | null) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Container | null>((res, rej) => { resolve = res; reject = rej; });
  const job: LoadJob = { el, opts, rand, cancelled: false, resolve, reject };
  loadQueue.push(job);
  schedulePump();
  return { promise, cancel: () => { job.cancelled = true; } };
}

/**
 * Start one microtask later: a load that is queued and then invalidated in the same synchronous block (scrubbing back
 * followed at once by a stage remount) gets the chance to be skipped
 */
function schedulePump(): void {
  if (pumpQueued) return;
  pumpQueued = true;
  queueMicrotask(() => { pumpQueued = false; pumpLoads(); });
}

function pumpLoads(): void {
  if (loading) return;
  let job = loadQueue.shift();
  while (job && job.cancelled) { job.resolve(null); job = loadQueue.shift(); }
  if (!job) return;
  const current = job;
  loading = current;
  // The initial layout of the particles is decided by the seed: the random numbers used in the load are the ones seeded
  // this time
  setRandom(current.rand);
  withRealCanvas(() => {}); // Make sure the short circuit is installed (idempotent)
  const id = `pc-particles-${++containerSeq}`;
  const setUp = whenSetUp((k) => k.id.description === id);
  let finished = false;
  const finish = (c: Container | null, error?: unknown) => {
    if (finished) return;
    finished = true;
    setUp.dispose();
    loading = null;
    if (c && current.cancelled) { c.destroy(); current.resolve(null); }
    else if (c) current.resolve(c);
    else if (current.cancelled) current.resolve(null);
    else current.reject(error ?? new Error("粒子容器没有装起来"));
    schedulePump();
  };
  void setUp.promise.then((c) => finish(c));
  // Do not wait for the Promise of load() to report success (see whenSetUp); only handle its failure and "returned
  // without laying out particles"
  tsParticles.load({ id, element: current.el, options: forceOurs(current.opts) }).then(() => finish(null), (e) => finish(null, e));
}

/**
 * Whatever the config says, these items always follow ours: laid out inside the card layer, no mouse response, no DPR
 * scaling, transparent background
 */
function forceOurs(opts: Record<string, any>): Record<string, any> {
  return {
    ...opts,
    fullScreen: { enable: false },
    detectRetina: false,
    // By default the engine pauses "when the window loses focus / the canvas is not in the viewport": the preview iframe,
    // the headless export page and a collapsed Browser panel all count as unfocused, so the canvas stays blank (measured:
    // the canvas is there, the particle count is there, not one pixel is drawn). Turn both off in all cases; whether to
    // draw is decided by our clock
    pauseOnBlur: false,
    /*
     * **The resize on the root node must be turned off too**, not only the one inside interactivity.
     *
     * By default the engine has `resize.enable = true` and `delay = 0.5` (see Options/Classes/ResizeEvent.js), so it
     * installs a ResizeObserver on the canvas by itself, and the callback sets a **500 ms real-time timer** that, when it
     * fires, goes to windowResize() → setDensity() and adds or removes particles. Adding or removing particles consumes
     * the seeded random numbers we injected; once the random stream is misaligned, the particles of every later frame are
     * all different. **This path does not go through drawParticles at all**, so "the advance sequence is identical step by
     * step" cannot stop it.
     *
     * Why it only bites on some paths: it is a real-time timer. Pushing frame by frame takes several hundred milliseconds
     * of real time, so the timer lands **in the middle** of the advance sequence; pushing all at once takes only a few
     * milliseconds, so the timer lands **after the end** and has no effect on this frame. Preview jumps and export are
     * exactly these two. Measured at the same t=1.8s, the two paths differ by 129,000 pixels.
     * The canvas size is decided by our layout; the engine does not need to watch it by itself.
     */
    resize: { enable: false },
    /*
     * The engine's own frame loop is never turned on: the `play()` at the end of `start()` returns immediately on the
     * first start with autoPlay=false, and stop() in refresh() resets the "first start", so it does not turn on either
     * when reopening after scrubbing back. The picture is advanced by stepTo only.
     */
    autoPlay: false,
    pauseOnOutsideViewport: false,
    background: { ...(opts.background || {}), color: "transparent" },
    interactivity: {
      ...(opts.interactivity || {}),
      events: { ...((opts.interactivity && opts.interactivity.events) || {}), onHover: { enable: false }, onClick: { enable: false }, resize: { enable: false } },
    },
  };
}

function simpleOptions(params: Params): Record<string, any> {
  return {
    fpsLimit: 60,
    particles: {
      number: { value: Math.max(0, params.quantity | 0), density: { enable: false } },
      color: { value: params.color },
      opacity: { value: 0.8 },
      size: { value: Math.max(0.5, params.size) },
      move: { enable: true, speed: Math.max(0, params.speed), outModes: { default: "out" } },
      links: { enable: params.links === "yes", color: params.color, distance: 160, opacity: 0.45, width: 1.5 },
    },
  };
}

/**
 * config parameter: if it starts with { it is inline JSON, otherwise it is fetched as a URL; an empty string uses the
 * simple parameters above
 */
async function resolveOptions(params: Params): Promise<Record<string, any>> {
  const c = params.config.trim();
  if (!c) return simpleOptions(params);
  if (c.startsWith("{")) return JSON.parse(c);
  const r = await fetch(c);
  if (!r.ok) throw new Error(`拉取粒子配置失败 ${r.status}: ${c}`);
  return r.json();
}

/**
 * Render core: given a "get config" function and a random seed, draw the particles into the card layer, **driven by
 * the timeline's t**.
 *
 * Why not let the engine run by itself: the frame loop of tsParticles 4 relies on requestAnimationFrame, but the rAF
 * in the preview iframe and the export page is a virtual clock (kernel/exportClock.ts) that does not advance by
 * itself; it also calls transferControlToOffscreen on the canvas and draws on an offscreen bitmap, so not a single
 * pixel comes out in the preview (measured: the container is alive, all 200 particles are there, the bitmap is
 * entirely empty).
 * So here:
 *   1. At load, short-circuit transferControlToOffscreen to "just use this canvas", drawing on the visible canvas;
 *   2. Right after loading, pause() cuts off its own loop, and whenever t changes, drawParticles is called step by
 *      step at 1/60 s until t is reached;
 *   3. Random numbers come from a PRNG seeded by seed; when the playhead is scrubbed back, everything is reloaded and
 *      advanced again: the same seed and the same t draw the same frame in the editor, the preview and the export.
 *      This is the same idea as goToAndStop of the Lottie card.
 * `depsKey` is the identity of the config: the engine is reinstalled only when it changes. The media wrapper card
 * (src/cards/assets) uses it to write the translated knobs back into the original config before rendering, and the
 * generic particle card uses it to render the three sources: URL / inline JSON / simple parameters.
 */
export function ParticlesView({ resolve, seed, depsKey, t = 0 }: { resolve: () => Promise<Record<string, any>>; seed: number; depsKey: string; t?: number }) {
  const box = useRef<HTMLDivElement>(null);
  /** Engine container + the millisecond it has been advanced to; replaced entirely on reinstall */
  const state = useRef<StepState & { gen: number }>({ container: null, atMs: 0, gen: 0 });
  const wantT = useRef(t);
  wantT.current = t;

  useEffect(() => {
    let dead = false;
    const st = state.current;
    const gen = ++st.gen;
    st.container?.destroy();
    st.container = null;
    st.atMs = 0;
    st.rand = undefined;
    st.reloading = false;
    st.pendingT = undefined;
    st.reload = undefined;

    // When HMR reruns this module the engine has already been loaded and registering the plugins again would throw;
    // swallow it, the plugins are there already
    engineReady ??= loadSlim(tsParticles).catch(() => {});
    const ready = beginFrameWork('particles');
    /** Invalidate this component's load that has not finished yet (unmount, config changed) */
    let cancelLoad = () => {};

    /**
     * Queue one load and return once the particles are laid out (together with its random stream). First mount and
     * scrubbing back both go through this one path, and the random streams on both sides are identical one by one.
     * Do not wait for the Promise of load(): it has to wait for the setTimeout in the engine's start(), which never fires
     * on a paused stage (see whenSetUp).
     * For why it is queued and why the random stream follows the container, see the comment above `requestLoad`.
     */
    const mount = (opts: Record<string, any>): Promise<Loaded | null> | null => {
      const el = box.current;
      if (dead || !el) return null;
      cancelLoad();
      const rand = seededRandom(seed);
      const req = requestLoad(el, opts, rand);
      cancelLoad = req.cancel;
      return req.promise.then((c) => (c ? { c, rand } : null));
    };
    /** Installed: cut off the engine's own frame loop; from now on only we advance it, by t */
    const adopt = ({ c, rand }: Loaded): boolean => {
      if (dead || gen !== st.gen) { c.destroy(); return false; }
      c.pause();
      st.container = c;
      st.rand = rand;
      st.atMs = 0;
      return true;
    };

    Promise.all([engineReady, resolve()])
      .then(([, opts]) => {
        /*
         * Scrubbing back: destroy the whole container, reinstall along the same path, and advance from 0 again (a particle
         * system has no rewind).
         *
         * **Do not use container.refresh().** refresh and the first load() do not take the same path: particle ids and the
         * object pool are not reset to zero. Measured: stop at 3s, jump to 5s, jump back to 3s, and the picture rearranged by
         * refresh differs from the first one.
         * Reinstalling a fresh container makes the two runs have identical random numbers and identical step order, one by one.
         */
        st.reload = (tSec: number) => {
          st.reloading = true;
          st.pendingT = tSec;
          st.container?.destroy();
          st.container = null;
          st.atMs = 0;
          const p = mount(opts);
          if (!p) { st.reloading = false; return; }
          p.then((got) => {
            // This reinstall no longer belongs to this component (unmount, config changed): destroy what was installed, and do not
            // touch the state of the new round
            if (dead || gen !== st.gen) { got?.c.destroy(); return; }
            st.reloading = false;
            if (got && adopt(got)) stepTo(st, seed, st.pendingT ?? tSec);
          }).catch(() => { if (!dead && gen === st.gen) st.reloading = false; });
        };
        return mount(opts);
      })
      .then((got) => {
        if (!got) { ready.dispose(); return; }
        if (!adopt(got)) return;
        stepTo(st, seed, wantT.current);
        ready.ready();
      })
      .catch((e) => { ready.fail(e); console.warn("[particles] 启动失败:", e); });

    return () => {
      dead = true;
      cancelLoad();
      ready.dispose();
      st.reload = undefined;
      st.container?.destroy();
      st.container = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey, seed]);

  // When t changes, advance to t; when scrubbing back, reinstall and then advance (a particle system has no rewind)
  useEffect(() => {
    stepTo(state.current, seed, t);
  }, [t, seed]);

  return <div ref={box} className="absolute inset-0" />;
}

/**
 * Step length: advance at 60 fps, consistent with the engine's default fpsLimit, so the physics does not blow up
 * because a step is too long
 */
const STEP_MS = 1000 / 60;
/** Maximum steps to advance at once: 20 seconds; even longer clips won't freeze the main thread */
const MAX_STEPS = 60 * 20;

/**
 * Advancement state: engine container, millisecond advanced to.
 * When scrubbing back, reload a new container; while reloading, reloading is true, the latest t is
 * recorded in pendingT, and everything is advanced together once loaded.
 */
interface StepState { container: Container | null; atMs: number; rand?: () => number; reloading?: boolean; pendingT?: number; reload?: (tSec: number) => void }
/** A loaded container, along with its own seeded random number stream */
interface Loaded { c: Container; rand: () => number }

function stepTo(st: StepState, seed: number, tSec: number) {
  // Reload triggered by scrubbing back is not ready yet: record latest t, advance all once loaded
  if (st.reloading) { st.pendingT = tSec; return; }
  const c = st.container;
  if (!c || c.destroyed) return;
  const target = Math.max(0, tSec) * 1000;
  if (target < st.atMs - 0.5) {
    st.reload?.(tSec);
    return;
  }
  // Random numbers taken when advancing come from this container's own copy (see above `requestLoad`);
  // return the source to the one currently loading once advancement is done
  if (st.rand) setRandom(st.rand);
  try {
    advance(st, c, target);
  } finally {
    if (loading) setRandom(loading.rand);
  }
}

function advance(st: StepState, c: Container, target: number) {
  const render = c.canvas.render;
  let steps = 0;
  if (st.atMs === 0) {
    /*
     * Initial frame: draw only, do not advance. **Must draw this frame regardless of target.**
     *
     * Previously it was written as "only draw when target is near 0", so the side that "advances
     * straight to t in one go" skipped it. But the side that advances frame by frame (export)
     * definitely draws once at t=0: a single drawParticles consumes random numbers; missing one
     * draw offsets the random number streams by one step, and particles diverge from then on.
     *
     * Both invocation patterns exist in practice: export is called once per frame; on a preview
     * seek, the engine finishes loading asynchronously, and the catch-up run has long completed,
     * leaving only the final t. In testing, particles-life at t=1.8s differed by 3.18% of pixels,
     * with a maximum channel difference of 164.
     */
    render.drawParticles({ value: 0, factor: 0 } as any);
    // Record that "the initial frame has already been drawn". Without this, pausing at t≈0 then advancing
    // draws value=0 once more than jumping directly to t: scrubbing back (recursively returning to t=0
    // after refresh) takes this exact path. Use a tiny placeholder without affecting advancing by full
    // steps below.
    st.atMs = 1e-9;
    if (target <= 0.5) return;
  }
  /*
   * **Only advance by full steps; keep any remainder smaller than a step.**
   *
   * Previously it was `d = min(STEP_MS, target - atMs)`: each call used a short step to consume
   * the remainder completely. As a result, the outcome of "advancing to t" depended on **how many
   * times it was called along the way**: calling frame by frame (+33.33ms each time) alternated
   * between 16.667 / 16.666, while calling all the way in one shot was a series of 16.667.
   * Different step sizes → different factors → accumulated over 100+ steps, the particles drifted apart.
   *
   * Preview and export happen to be these two calling patterns: export calls frame by frame;
   * on preview seek, the engine is loaded asynchronously, and the catch-up run has already
   * finished synchronously, leaving only the final t, so it advances all at once. In testing,
   * particles-life at t=1.8s differed by 3.18% of pixels, with a maximum channel difference of 164.
   *
   * After switching to full steps only, advancing to the same t has an **identically matching step
   * sequence**, independent of intermediate calls. The trade-off is that visual output lags by less
   * than a full step (16.7ms) at most, but both sides lag identically: exactly what is needed.
   */
  while (st.atMs + STEP_MS <= target + 1e-6 && steps++ < MAX_STEPS) {
    render.drawParticles({ value: STEP_MS, factor: 1 } as any);
    st.atMs += STEP_MS;
  }
}

/**
 * Wait for a container to have "particles arranged" (the particlesSetup event emitted by the engine
 * at the end of init()), **do not wait for the load() / refresh() Promise**.
 *
 * Why we cannot wait for those two Promises: the engine's Container.start() after init() still
 * does `await new Promise(r => setTimeout(r, delay))` before resolving (delay defaults to 0).
 * The preview stage (?stage=1, render/stageClock.ts) replaces setTimeout with a timer registered
 * on the virtual clock, settling only when the clock ticks: **when paused, the stage does not
 * tick, so this 0ms timer never fires**, load() never resolves, stepTo never runs even once, and
 * the canvas stays as it was cleared at init: canvas is present, 80 particles are arranged, but not
 * a single pixel has been drawn. When scrubbing forward the stage ticks and the timer fires,
 * leading to "visual output when scrubbing forward, but completely transparent when stopped or
 * scrubbing back".
 *
 * What happens after that timer (attaching listeners, plugin start, emitting containerStarted,
 * play()) has no effect on the visuals: play() returns directly on initial startup when
 * autoPlay=false (see forceOurs), and interaction plugin mouse events are disabled. So once
 * particles are arranged, we can start advancing by t; whenever the timer fires makes no difference.
 * Events are engine-global and shared by multiple particle cards; use match to identify its container.
 */
function whenSetUp(match: (c: Container) => boolean): { promise: Promise<Container>; dispose: () => void } {
  let handler: ((e: any) => void) | null = null;
  const dispose = () => { if (handler) tsParticles.removeEventListener(EventType.particlesSetup, handler); handler = null; };
  const promise = new Promise<Container>((resolve) => {
    handler = (e: any) => {
      const k = e?.container as Container | undefined;
      if (!k || !match(k)) return;
      dispose();
      resolve(k);
    };
    tsParticles.addEventListener(EventType.particlesSetup, handler);
  });
  return { promise, dispose };
}

/** PRNG seeded by seed (mulberry32): the same seed always produces the same sequence of numbers */
function seededRandom(seed: number): () => number {
  let a = (seed | 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Make tsParticles draw directly on the visible canvas.
 * Engine 4.x always calls canvas.transferControlToOffscreen() and draws to an offscreen bitmap;
 * inside the preview iframe, offscreen bitmaps are never committed to the screen. Short-circuiting
 * this method to return the canvas itself ensures getContext / width / height obtained by the
 * engine all belong to the real canvas. Installed only once globally; nothing else in this project
 * uses OffscreenCanvas.
 */
let realCanvasPatched = false;
function withRealCanvas(fn: () => void) {
  if (!realCanvasPatched && typeof HTMLCanvasElement !== "undefined") {
    (HTMLCanvasElement.prototype as any).transferControlToOffscreen = function () { return this; };
    realCanvasPatched = true;
  }
  fn();
}

function ParticlesCard({ params, t = 0 }: CardProps<Params>) {
  const depsKey = [params.config, params.color, params.quantity, params.speed, params.size, params.links].join("\u0000");
  return <ParticlesView resolve={() => resolveOptions(params)} seed={params.seed} depsKey={depsKey} t={t} />;
}

export const particlesCard: CardDef<Params> = {
  id: "particles",
  name: "Particle background",
  description: "Floating particles, optionally linked by lines, filling the whole frame",
  useWhen: "Use when the whole stretch of video needs a dynamic tech / starry-sky texture layer, usually on the bottom layer covering the full duration. Two modes: without config, use the simple color/count/speed parameters; for ready-made effects such as snowflakes, starry sky, bubbles or confetti, pick a URL from the options of the config control and put it into config (the app ships with 50+), in which case the simple parameters have no effect. Particle positions are determined by seed, and the same seed gives the same result on every export; change the seed for a different layout. It is a background, not the focus, so do not expect it to convey information; to emphasize numbers or text, overlay another card on top.",
  tags: ["particles", "background", "tech", "starry sky", "snowflake", "canvas"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: { config: "", color: "#8ab4ff", quantity: 80, speed: 1.2, size: 3, links: "yes", seed: 1 },
  controls: [
    { key: "config", label: "Preset config", type: "asset", kind: "particles", options: assetOptions("particles"), hint: "Pick one from the media catalog (a URL in options), or enter another URL / inline JSON; when set, it is used and the color/count/speed below have no effect" },
    { key: "color", label: "Color", type: "color" },
    { key: "quantity", label: "Count", type: "number", min: 0, max: 400, step: 10 },
    { key: "speed", label: "Speed", type: "number", min: 0, max: 10, step: 0.2 },
    { key: "size", label: "Size (px)", type: "number", min: 0.5, max: 20, step: 0.5 },
    { key: "links", label: "Links", type: "select", options: [{ value: "yes", label: "present" }, { value: "no", label: "none" }] },
    { key: "seed", label: "Random seed", type: "number", min: 1, max: 99999, step: 1, hint: "A different number gives a different layout; the same number gives the same result on every export" },
  ],
  parts: [{ id: "particles", label: "particles", role: "media", params: ["config", "color", "quantity", "speed", "size", "links", "seed"] }],
  lifecycle: { after: "evolve", exit: ["fade"] },
  /*
   * The fourth contract of R9 M1, `dom2d`: **does not enter the shared renderer Worker**.
   * `tsParticles.load({ element })` requires a DOM element, configuration is an async fetch,
   * and 53 particle cards share this single copy: so it still draws on the main thread using a real
   * canvas (retaining the `transferControlToOffscreen` short-circuit in `withRealCanvas` above),
   * and `Stage` does not render a gl plane for it; it is a 2D context, not a WebGL context.
   * Long particle clips go through the track stream when classified as heavy (R8 G1).
   */
  canvas: { kind: "dom2d" },
  Component: ParticlesCard,
};

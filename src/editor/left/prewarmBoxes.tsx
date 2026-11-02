import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { allCards } from "../../kernel/registry";
import { allParts } from "../../kernel/partRegistry";
import { assetCardKind } from "../../cards/assets";
import { AnimClock } from "../../kernel/AnimClock";
import { PartTree } from "../../render/PartTree";
import { themeStyle } from "../../themes";
import { getState } from "../../store/project";
import type { CardDef, PartInstance } from "../../kernel/types";
import type { PartDef } from "../../kernel/partTypes";
import { measureAcrossTime, unionBox, type Box } from "../../render/contentBox";
import { knownKeys, rememberBox, dumpBoxes } from "./previewBoxes";

/**
 * Background measuring: the first time the card tab opens, render every card / part missing from
 * the static table off-screen, one after another, measure the bounding box and store it
 * (previewBoxes.ts). Whatever is done is ready in one step on the next hover, with no waiting for
 * measurement.
 *
 * A few self-imposed rules:
 *   - **Render only one at a time**, and only in idle time (requestIdleCallback), so it never
 *     competes with user actions for the main thread;
 *   - **Back off right after user activity**: within QUIET_MS after a click, key press or wheel,
 *     mount no new card and do no second measurement; if the user acts after mounting but before
 *     the first measurement, unmount the card and put it back at the end of the queue. Mounting a
 *     3D card alone takes a hundred-plus milliseconds (building the WebGL scene, compiling
 *     shaders), and one measurement reads the whole canvas back from the GPU. If that lands just
 *     as the user opens a group or collapses a panel, the animation freezes -- that was why
 *     everything stuttered for half a minute after opening "built-in cards";
 *   - **Off-screen, not display:none**: hidden elements have no layout and no animation, so there
 *     is nothing to measure;
 *   - **Particle cards are not queued**: all 53 are canvas engines, igniting them one by one in
 *     the background costs too much, and they fill the whole frame anyway, so the measurement
 *     comes out null. The pixel scan on hover (canvasBox in contentBox) is enough for them.
 */
const SETTLE_MS = 80;
const MAX_MEASURE_MS = 4000;
const GAP_MS = 120;
/** Upper limit for waiting until parts that follow real time (typewriter, Lottie) have grown in */
const SETTLED_WAIT_MS = 1800;
/** After the user's last click / key press / wheel, stay quiet at least this long before the next step */
const QUIET_MS = 1500;
/** A card yields to the user at most this many times (interrupted right after mounting, put back at the end of the queue); after that it is measured regardless, so it never starves */
const MAX_YIELDS = 3;

interface Job {
  key: string;
  /** t: the part's timeline position in seconds (unused for cards) */
  node: (t: number) => React.ReactElement;
  animMs: number;
  /** How many times it has already yielded to the user */
  yields?: number;
}

let started = false;
let pending = 0;
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let lastInput = 0;
let watching = false;

function idle(fn: () => void, timeout = 2000) {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout });
  else window.setTimeout(fn, GAP_MS);
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * Records the time of the user's last action. Capture phase + passive, so nobody's event handling
 * is affected. click counts as its own kind: pressing a button with Enter / Space on the keyboard,
 * or el.click() in a script, produces no pointerdown.
 */
function watchInput() {
  if (watching) return;
  watching = true;
  const mark = () => {
    lastInput = performance.now();
  };
  for (const type of ["pointerdown", "click", "keydown", "wheel"]) {
    window.addEventListener(type, mark, { capture: true, passive: true });
  }
}

/** Wait until "the user has been quiet for QUIET_MS" and the browser has given an idle callback; if the user acts again while the idle callback is queued, wait another round */
function whenQuiet(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const left = QUIET_MS - (performance.now() - lastInput);
      if (left > 0) {
        window.setTimeout(check, left);
        return;
      }
      idle(() => {
        if (performance.now() - lastInput < QUIET_MS) check();
        else resolve();
      });
    };
    check();
  });
}

function cardAnimMs(def: CardDef<any>): number {
  try {
    const dyn = def.timing?.(def.defaults)?.settleMs;
    if (typeof dyn === "number" && Number.isFinite(dyn)) return dyn;
  } catch { /* If the computation blows up, use the static value */ }
  const st = def.lifecycle?.settleMs;
  return typeof st === "number" && Number.isFinite(st) ? st : 1500;
}

function partAnimMs(def: PartDef<any>): number {
  try {
    const v = def.settleMs?.(def.defaults);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  } catch { /* Same as above */ }
  return 1500;
}

function ensureStage(w: number, h: number, themeId: string): HTMLElement {
  if (!container) {
    container = document.createElement("div");
    container.setAttribute("data-pc", "prewarm");
    container.setAttribute("aria-hidden", "true");
    document.body.appendChild(container);
  }
  container.style.cssText = `position:fixed;left:-20000px;top:0;width:${w}px;height:${h}px;overflow:hidden;pointer-events:none;z-index:-1;`;
  // The theme is a set of CSS custom properties, so setProperty has to be called one by one
  for (const [k, v] of Object.entries(themeStyle(themeId) as Record<string, string>)) {
    if (k.startsWith("--")) container.style.setProperty(k, String(v));
  }
  if (!root) root = createRoot(container);
  return container;
}

/** @returns false = the user acted right after mounting, this one was not measured and must go back to the end of the queue */
async function runJob(job: Job, w: number, h: number, themeId: string): Promise<boolean> {
  // Mounting the card is the heaviest part of a step, so wait for the user to be quiet before it.
  // flushSync finishes the mount on the spot -- if React schedules it itself, the real mount lands
  // in some later task, when the user may already be clicking
  await whenQuiet();
  const host = ensureStage(w, h, themeId);
  const total = Math.min(MAX_MEASURE_MS, Math.max(400, job.animMs) + 300);
  const inputAtMount = lastInput;
  flushSync(() => {
    root!.render(
      <div className="pc-stage" style={{ position: "relative", width: "100%", height: "100%" }}>
        <AnimClock speed={1}>{job.node(total / 1000)}</AnimClock>
      </div>,
    );
  });
  let box: Box | null = null;
  const sample = () => {
    const stage = host.querySelector<HTMLElement>(".pc-stage");
    if (!stage) return;
    try {
      box = unionBox(box, measureAcrossTime(stage, total));
    } catch {
      // No card whose render blows up should bring down the whole queue
    }
  };
  // Measure twice: right after mounting (the stretch where the entrance flies in from off-screen is
  // captured by scrubbing Web Animations), then after letting it run for a while (typewriter,
  // Lottie and other things that follow real time cannot be scrubbed, so we can only wait for the
  // content to grow in itself).
  await wait(SETTLE_MS);
  // The first measurement must not be delayed: once the entrance animation finishes it can no
  // longer be scrubbed. If the user acts during this short stretch after mounting, reading the
  // canvas would collide with their animation -- skip this measurement, unmount the whole card and
  // put it back at the end of the queue to retry
  if (lastInput !== inputAtMount && (job.yields ?? 0) < MAX_YIELDS) {
    root!.render(null);
    job.yields = (job.yields ?? 0) + 1;
    return false;
  }
  sample();
  // The second measurement captures the grown-in look. A mounted card keeps rendering (AnimClock's
  // rAF, the 3D card's WebGL), so it cannot sit there waiting for the user to stop: if the user is
  // still acting when the time comes, unmount and put it back at the end of the queue, as in the
  // first measurement; once it has yielded enough, measure regardless
  await wait(Math.min(total, SETTLED_WAIT_MS));
  if (performance.now() - lastInput < QUIET_MS && (job.yields ?? 0) < MAX_YIELDS) {
    root!.render(null);
    job.yields = (job.yields ?? 0) + 1;
    return false;
  }
  sample();
  rememberBox(job.key, w, h, box);
  root!.render(null);
  await wait(30);
  return true;
}

function buildQueue(w: number, h: number, force: boolean): Job[] {
  // force (generate the static table) = ignore the static table but honor the local cache, so it can resume measuring after a reload
  const known = knownKeys(w, h, force);
  const jobs: Job[] = [];
  for (const def of allCards()) {
    // Particle cards are not queued: see the note above
    if (assetCardKind(def) === "particles") continue;
    // Media effect cards have no React component, so the bounding box cannot be measured off-screen -- the library only shows a static placeholder for them anyway, no need to warm up
    const Component = def.Component;
    if (typeof Component !== "function") continue;
    const key = `card:${def.id}`;
    if (known.has(key)) continue;
    jobs.push({ key, animMs: cardAnimMs(def), node: () => <Component params={def.defaults} playToken={1} /> });
  }
  for (const def of allParts()) {
    const key = `part:${def.id}`;
    if (known.has(key)) continue;
    const parts: PartInstance[] = [
      { id: "preview", partId: def.id, params: { ...def.defaults }, ...(def.defaultFrame ? { frame: { ...def.defaultFrame } } : {}) },
    ];
    jobs.push({ key, animMs: partAnimMs(def), node: (t: number) => <PartTree parts={parts} size={{ width: w, height: h }} t={t} playToken={1} /> });
  }
  return jobs;
}

/**
 * Starts background measuring. Repeated calls have no side effects; a headless instance (the page
 * the agent uses) does not do this.
 * `force` is only for scripts/preview-boxes.mjs: re-measure everything in the static table.
 */
export function startPrewarm(force = false): void {
  if ((started && !force) || typeof document === "undefined") return;
  try {
    if (new URLSearchParams(location.search).has("headless")) return;
  } catch { /* If it cannot be obtained, treat it as a normal page */ }
  started = true;
  watchInput();
  // Background measuring is kicked off by the user opening a card group, and that click happened before the listeners were installed: count the start time as a user action, so no card is mounted right after
  lastInput = performance.now();
  const { width, height, themeId } = getState().project;
  const queue = buildQueue(width, height, force);
  pending = queue.length;
  const next = () => {
    const job = queue.shift();
    if (!job) {
      pending = 0;
      root?.render(null);
      return;
    }
    // The wait for idle time + a quiet user is in runJob (whenQuiet)
    void runJob(job, width, height, themeId)
      .then((done) => {
        if (!done) queue.push(job);
      })
      .finally(() => {
        pending = queue.length;
        next();
      });
  };
  next();
}

/** For scripts/preview-boxes.mjs: nudge it along, see how many are left, take the results away */
if (typeof window !== "undefined") {
  (window as unknown as { __pcPreviewBoxes?: unknown }).__pcPreviewBoxes = {
    start: (force?: boolean) => startPrewarm(force === true),
    get pending() {
      return pending;
    },
    get started() {
      return started;
    },
    dump: () => {
      const { width, height } = getState().project;
      return dumpBoxes(width, height);
    },
  };
}

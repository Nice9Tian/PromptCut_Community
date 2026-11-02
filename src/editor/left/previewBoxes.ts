import type { Box } from "../../render/contentBox";
import staticFile from "../../cards/preview-boxes.json";

/**
 * Three layers of storage for preview card bounding boxes: static table → local cache → measured in this session.
 *
 * Why store them: measuring means playing the motion graphics through from start to finish (dozens of
 * steps), so the first hover shows a brief black screen. A card's default parameters are fixed, so its box
 * is fixed too, and there is no need to re-measure on every machine and every launch:
 *
 *   1. **Static table** (`src/cards/preview-boxes.json`, generated offline with `npm run preview-boxes` and
 *      committed): ships with the package, works out of the box, one step;
 *   2. **Local cache** (localStorage): for what the static table lacks (cards built on the fly by users / AI,
 *      newly added parts); measured once in the background and remembered, still there on the next launch;
 *   3. **Memory**: what was measured in this session, also written to the local cache along the way.
 *
 * Boxes are in stage coordinates (project pixels), so they are bucketed by stage size: a box measured at
 * 1920×1080 cannot be used for a portrait project.
 */
export type BoxTuple = [number, number, number, number];

/**
 * The static table's type is written to match **what a JSON import looks like**, not what we would like:
 * TS infers arrays in json as `number[]`, not fixed-length tuples, and asserting to a tuple is rejected
 * (TS2352). The fixed length is guaranteed on the generating script's side (scripts/preview-boxes.mjs);
 * this side only reads, so `number[]` is enough.
 */
interface StaticFile {
  /** Which version of the table this was measured with. It changes on regeneration, and the local cache is invalidated with it (it was measured by old code) */
  rev?: number;
  stage: number[];
  boxes: Record<string, number[] | null>;
}

const LS_KEY = "pc.previewBoxes.v1";
const statics: StaticFile = staticFile;

/** Key of the stage bucket */
function bucket(w: number, h: number): string {
  return `${Math.round(w)}x${Math.round(h)}`;
}

function toBox(t: readonly number[] | null | undefined): Box | null {
  return t ? { l: t[0], t: t[1], r: t[2], b: t[3] } : null;
}

function toTuple(b: Box | null): BoxTuple | null {
  return b ? [Math.round(b.l), Math.round(b.t), Math.round(b.r), Math.round(b.b)] : null;
}

/** Local cache: { "1920x1080": { "card:xxx": [l,t,r,b] | null } } */
type Store = Record<string, Record<string, BoxTuple | null>>;

let mem: Store | null = null;

function load(): Store {
  if (mem) return mem;
  mem = {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    // Only trust what was measured under the same version of the static table: if the table was regenerated
    // (a card changed its animation / default parameters), this local copy is an old conclusion, so drop it entirely
    if (parsed && typeof parsed === "object" && parsed.rev === (statics.rev ?? 0) && parsed.buckets) {
      mem = parsed.buckets as Store;
    }
  } catch {
    // Corrupted or disabled storage does not matter, at worst we measure again
  }
  return mem;
}

let saveTimer: number | null = null;
function saveSoon() {
  if (saveTimer !== null) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ rev: statics.rev ?? 0, buckets: mem ?? {} }));
    } catch {
      // Full / private mode: never mind, this is a cache, not data
    }
  }, 800);
}

/**
 * Look up a box. `has` false means it was never measured (go measure it); `has` true with `box` null
 * means **it was measured and the conclusion is "the content fills the whole frame"**, so just show the
 * whole frame and do not measure again for nothing.
 */
export function lookupBox(key: string, stageW: number, stageH: number): { has: boolean; box: Box | null } {
  const b = bucket(stageW, stageH);
  const local = load()[b];
  if (local && key in local) return { has: true, box: toBox(local[key]) };
  // The static table only counts when the stage size matches
  if (b === bucket(statics.stage?.[0] ?? 0, statics.stage?.[1] ?? 0) && key in (statics.boxes ?? {})) {
    return { has: true, box: toBox(statics.boxes[key]) };
  }
  return { has: false, box: null };
}

export function rememberBox(key: string, stageW: number, stageH: number, box: Box | null): void {
  const b = bucket(stageW, stageH);
  const store = load();
  (store[b] ??= {})[key] = toTuple(box);
  saveSoon();
}

/**
 * Keys that exist in the static table / local cache (for background measuring: those already present do not
 * need to queue).
 * `ignoreStatic` is for the script that generates the static table: at that point the static table is exactly
 * what is being recomputed, so it cannot count as "already present", but the local cache is honored: if the
 * page gets reloaded midway, just continue measuring, no need to start over.
 */
export function knownKeys(stageW: number, stageH: number, ignoreStatic = false): Set<string> {
  const b = bucket(stageW, stageH);
  const out = new Set<string>(Object.keys(load()[b] ?? {}));
  if (!ignoreStatic && b === bucket(statics.stage?.[0] ?? 0, statics.stage?.[1] ?? 0)) {
    for (const k of Object.keys(statics.boxes ?? {})) out.add(k);
  }
  return out;
}

/** When a card's source changes or parameter defaults change, the measured boxes go stale, so let people drop them manually */
export function forgetBoxes(stageW?: number, stageH?: number): void {
  if (stageW && stageH) {
    const store = load();
    delete store[bucket(stageW, stageH)];
  } else {
    mem = {};
  }
  saveSoon();
}

/** Export everything measured in this session, for scripts/preview-boxes.mjs to generate the static table */
export function dumpBoxes(stageW: number, stageH: number): StaticFile {
  return { stage: [Math.round(stageW), Math.round(stageH)], boxes: { ...(load()[bucket(stageW, stageH)] ?? {}) } };
}

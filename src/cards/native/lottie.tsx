import { useEffect, useRef } from "react";
import lottie, { type AnimationItem } from "lottie-web";
import type { CardDef, CardProps } from "../../kernel/types";
import { assetOptions } from "../catalogAssets";
import { isExportMode } from "../../kernel/clock";
import { beginFrameWork } from "../../kernel/frameReady";
import { withSeededRandom } from "../../kernel/pinEntropy";

/**
 * Lottie card: puts a Lottie animation (JSON exported from After Effects) on the stage and positions
 * it frame by frame along the timeline.
 *
 * This card is remotion-style (`frameMode: "direct"`, user decision, 2026-10-10, the render refactor
 * "Gui" landed in code): lottie-web's goToAndStop(frame, true) means "jump to a frame number and
 * render", and does not advance by itself on any clock. So this card **reads t**, converts t into a
 * frame number every frame and jumps straight there; autoplay is not used, and on the export page
 * lottie's rAF loop is frozen as well (it only serves autoplay animations, and there are none here).
 * That alone is still not enough for "every frame is determined only by the asset, the parameters and
 * the frame number": the player library has random numbers, and there is one place where property
 * values keep stale numbers. The section below, "the picture is determined only by the asset, the
 * parameters and the frame number", pins them down, and it is on by default.
 *
 * **Creating instances and jumping frames always go through `loadLottie` and the `goTo` it gives**;
 * do not bypass it and call the player library's `loadAnimation` or `goToAndStop` directly: if
 * bypassed, expressions each use their own string of random numbers and property values also keep
 * stale numbers, so advancing in order and jumping directly could differ. Other files that need to
 * place a Lottie use `LottieView` (the part `src/parts/lib/media-lottie.tsx` and the media wrapper
 * cards `src/cards/assets/index.ts` both do).
 * The probe `scripts/probes/lottie-seed-probe.mjs` checks that nothing in `src/` other than this file
 * imports the player library.
 *
 * **Before upgrading the player library (`lottie-web`, currently 5.13.0), rerun the two probes**:
 * `scripts/probes/lottie-seed-probe.mjs` and `scripts/probes/lottie-seed-extra-probe.mjs`. The
 * approach below relies on several internal details of the player library (how expressions are
 * compiled, the entry point for creating properties, the names of the functions that compute text
 * layout), and a version change may silently break it; when it breaks, the console shows a warning
 * starting with `[lottie]`, and the probe counts warnings as failures.
 *
 * The data has two sources: json (inline JSON text, takes priority) or src (a URL). Inline needs no
 * network and is the most stable for export; src goes through fetch, and the export script's
 * pauseIfNetworkFetchesPending waits for it to finish loading before advancing virtual time.
 *
 * Asset licenses: lottie-web itself is MIT, but each animation file on LottieFiles has its own
 * license, so check them one by one before use.
 */

interface Params {
  json: string;
  src: string;
  speed: number;
  loop: string;
  fit: string;
}

/**
 * The built-in demo animation: a rounded square slides from left to right, rotates once and fades
 * in. Handwritten, so there is no third-party asset license issue.
 */
const DEMO_JSON = JSON.stringify({
  v: "5.7.4", fr: 30, ip: 0, op: 60, w: 1920, h: 1080, nm: "demo", ddd: 0, assets: [],
  layers: [{
    ddd: 0, ind: 1, ty: 4, nm: "box", sr: 1, ao: 0, ip: 0, op: 60, st: 0, bm: 0,
    ks: {
      o: { a: 1, k: [{ t: 0, s: [0], e: [100], i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] } }, { t: 20, s: [100] }] },
      r: { a: 1, k: [{ t: 0, s: [0], e: [360], i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] } }, { t: 60, s: [360] }] },
      p: { a: 1, k: [{ t: 0, s: [400, 540, 0], e: [1520, 540, 0], i: { x: 0.4, y: 1 }, o: { x: 0.6, y: 0 } }, { t: 60, s: [1520, 540, 0] }] },
      a: { a: 0, k: [0, 0, 0] },
      s: { a: 0, k: [100, 100, 100] },
    },
    shapes: [{
      ty: "gr",
      it: [
        { ty: "rc", d: 1, s: { a: 0, k: [240, 240] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 40 } },
        { ty: "fl", c: { a: 0, k: [0.37, 0.55, 1, 1] }, o: { a: 0, k: 100 } },
        { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
      ],
    }],
  }],
});

/*
 * ── The picture depends only on the asset, the parameters and the frame number (three independent switches) ──
 *
 * What we want: pushing forward from the start to frame N, and creating a fresh instance and jumping straight to
 * frame N, must give the same picture, regardless of how many times other cards on the page have drawn random numbers.
 * The player library (lottie-web 5.13.0) has three places that prevent this. The first two are random numbers;
 * switch 1 and switch 3 are two ways to deal with them (you can turn on just one, or both); the third has nothing
 * to do with random numbers and belongs to switch 2.
 *
 * **The set used in production is on by default** (user decision, 2026-10-12): switch 3 (replace the random functions
 * in expressions), the outer layer, and switch 2 (no stale property values).
 * Switch 1 is off by default and kept only for probe comparison. The stage, the export page and the online page use
 * the same code and the same defaults, so preview and export draw the same sequence of numbers.
 * Turn them off only for probe comparison: put `lottieExpr=0` / `lottieExact=0` in the page address, or set
 * `window.__pcLottieExpr` / `__pcLottieExact` to false before creating an instance.
 * For measurements and numbers see `scripts/probes/lottie-seed-probe.mjs`,
 * `scripts/probes/lottie-seed-extra-probe.mjs` and
 * `docs/plan/render-standard.md` "Lottie motion graphics".
 *
 * One known issue is not handled; it is a bug the player library has today: when an expression throws on its first
 * evaluation, that frame is aborted halfway through, and from then on the property is locked and never evaluated again;
 * which frame the error lands on depends on how the frame was reached, so an asset with a bad expression can still
 * render differently depending on how it was reached.
 *
 * ── Switch 1: override the random seed (user, 2026-10-12: "I think we can override the random seed.") ──
 *
 * The player library's expressions have their own sequence of random numbers (called `BMMath.random` in its source),
 * **shared by every Lottie on the page**. As long as no expression on the page has seeded it, it is the page-wide
 * `Math.random` (the sequence pinned by kernel/pinEntropy.ts); after the first seeding it is replaced by the player
 * library's own generator and never goes back. Both ways of drawing numbers from this sequence depend on "what
 * happened before":
 *
 *   1. Every property with an expression draws one `randSeed` from this sequence **when the layer is built**
 *      (whether or not the expression uses random). An expression that contains the word `random` re-seeds with
 *      `randSeed + time` before each evaluation, so the value of such an expression depends only on randSeed and the
 *      frame number, but randSeed itself depends on "where the sequence had got to when this instance was built":
 *      how many times other cards on the page called `Math.random`, and which frames other Lottie instances pushed.
 *   2. An expression that has **only `wiggle()` and not the word `random`** is not re-seeded before evaluation and
 *      keeps drawing from this sequence. What it gets depends on which frames were pushed before and what other
 *      Lottie instances pushed: the same instance gives different results when pushed forward than when jumped.
 *
 * Approach:
 *   - Seed = hash of the asset content (`lottieSeedOf`). The same JSON gives the same seed no matter which address it
 *     comes from, which machine it runs on, or which line ending it uses.
 *     Speed, loop and fit are not part of the seed: they only decide "which frame t maps to" and how things are laid
 *     out, and must not change the content of any frame.
 *   - Before building layers, re-seed the player library's sequence with "seed + build" (`BMMath.seedrandom`): each
 *     property's randSeed is drawn from here in the fixed layer-building order (with `progressiveLoad: false` the
 *     player library builds all layers, including those inside nested compositions, in one go at the moment loading
 *     completes, not on first use). When fonts or external data have not all arrived, layer building happens in the
 *     player library's own timer callback, so this instance's `checkLoaded` is wrapped too.
 *   - Before each frame is drawn, re-seed with "seed + frame number". That way the wiggle in item 2 gets numbers that
 *     depend only on the frame number. The draw the player library does by itself at the moment loading completes uses
 *     what was left over from layer building, so the frame is redrawn right after, by frame number.
 *   - Each of the above is also wrapped in "the outer layer" (see below; shared by switch 1 and switch 3).
 *   - The player library does not export `BMMath`. Expression code is evaluated in its scope and can see it (under the
 *     name `Math`) and `globalData`, so we build a throwaway animation with a single empty layer, have its expression
 *     hang `Math` on `globalData`, take it out, and destroy the animation. This is done once per page.
 *     If it cannot be obtained (the player library changed version, or expressions are disabled), only the outer layer
 *     remains, and a message goes to the console: that layer only controls expressions while the player library's
 *     sequence has not yet been seeded.
 *
 * ── Switch 3: replace the random functions in expressions (user, 2026-10-12: "Can we override by replacement, e.g.
 * replace random with random_in_card()?") ──
 *
 * Do not touch the player library's sequence; make expressions not use it at all. Before handing the asset to the
 * player library, rewrite the source text of every expression in it, wrapping it in a function that shadows the names
 * `random`, `seedRandom`, `wiggle` and `Math` with the card's own (`wrapLottieExpression`, `lottieExprRuntime`).
 * After the rewrite no expression reads the player library's internal sequence, so this switch neither draws from it
 * nor seeds it. Randomness outside expressions belongs to the outer layer.
 * The look stays exactly as the player library has it today (principle, user decision 2026-10-12; see the notes on
 * `lottieExprRuntime`): on the card side, too, "all expressions within one frame share one sequence and keep drawing in
 * evaluation order"; wiggle still jumps frame by frame, seedRandom still ignores its second argument, and several
 * copies of the same composition still move independently. The only thing changed is that the starting point of this
 * sequence for each frame is set by (asset, frame number) and no longer continues from what the previous frame left.
 * Compared with switch 1: it does not need the player library's internal random source and does not seed it.
 *
 * ── The outer layer (present as soon as switch 1 or switch 3 is on; user, 2026-10-12: "Please also cover it on the
 * outside, and fix the player library's random numbers too.") ──
 *
 * It covers the places where the player library calls the page-wide `Math.random()` directly, not through expressions:
 *   - Building an instance, loading completion (including the callback of asynchronous loading) and every frame jump
 *     are all wrapped in `withSeededRandom`. Layer building gets one sequence (asset seed), drawing frame N gets one
 *     (asset seed, N). The page-wide sequence is not moved by Lottie.
 *   - The "random order" of text layers is fixed separately by (asset, layer, text content) (`hookTextOrder`). It is
 *     computed once per piece of content, at no fixed frame, so seeding by frame number alone would make pushing
 *     forward and jumping directly differ.
 * Every place in the player library that draws random numbers, and which layer covers each, is listed in
 * docs/reports/AGENT-lottie-seed.md "Random sources in the player library".
 *
 * ── Switch 2: property values keep no stale numbers (found while checking the 0.0036% pixel difference in the
 * built-in asset happy2016; user, 2026-10-12: "No pixel differences.") ──
 *
 *   3. When the player library updates a property's value, it does **not** update if the new value differs from the old
 *      one in hand by less than 0.00001 (`setVValue`). When pushing forward, the value changes a little at a time and
 *      the last few steps each fall below this threshold, so it stops slightly short of the end point; jumping
 *      straight there gets the exact end point. The two differ by less than 0.00001, but in the transform matrix that
 *      becomes `1.0000001192092896` versus `1`, and rasterizing gives dozens of different edge pixels.
 *      It has nothing to do with random numbers; switch 1 cannot reach it.
 *
 * Approach: the player library itself adds expressions to properties by swapping out `PropertyFactory.getProp`; here
 * we wrap one more layer on the same hook (`lottie.__getFactory`): when building a property for an instance that has
 * this switch on, its `setVValue` is replaced by "update if not equal". Other instances are unaffected.
 *
 * ── The browser does not repaint nested masks (found while keeping a reference copy on 2026-10-13; unrelated to the
 * player library, it is a browser bug) ──
 *
 *   4. The player library draws layer masks as SVG `<mask>`. When a mask has another level nested inside it (a `<g>`
 *      whose paths in turn carry other clipping) and the inner level changes, Chrome (measured on 152) does not repaint
 *      the layer that uses this mask: the DOM is right, the screen keeps the old picture, until some other change
 *      happens to make it repaint. In the built-in `navidad`, when pushing forward, the patch of base color on the face
 *      never appears in frames 51 to 81 (up to 170,000 pixels), while jumping straight to those frames is correct.
 *      Screenshots, preview and export all go through this one browser paint, so all are hit.
 *
 * Approach: after loading completes, find the masks that have something nested in them (containing `<g>` or `<use>`,
 * or carrying a clip, mask or filter), and on every frame jump take the first child of each, remove it and put it back
 * in place. The serialized DOM does not change by a single character, but the browser repaints the layers that use it
 * from the new content; measured, the result is pixel-identical to jumping directly. Only these few masks are
 * touched; the whole SVG is not forced to reflow (that would make the edge pixels differ slightly from not forcing it).
 */

/**
 * Read a switch: if `window[key]` is a boolean, use it; otherwise look at the same-named parameter in the page address
 * (1 on, 0 off); if neither exists, use the default
 */
function flagOf(key: "__pcLottieSeed" | "__pcLottieExact" | "__pcLottieExpr" | "__pcLottieRepaint", query: string, dflt: boolean): boolean {
  if (typeof window === "undefined") return dflt;
  const flag = (window as unknown as Record<string, unknown>)[key];
  if (typeof flag === "boolean") return flag;
  try {
    const q = new URLSearchParams(window.location.search).get(query);
    return q === "1" ? true : q === "0" ? false : dflt;
  } catch { return dflt; }
}

/**
 * Switch 1: off by default, only for probe comparison. To turn it on: put `lottieSeed=1` in the page address, or set
 * `window.__pcLottieSeed = true` before creating an instance (setting it to false overrides the address)
 */
export function lottieSeedEnabled(): boolean {
  return flagOf("__pcLottieSeed", "lottieSeed", false);
}

/**
 * Switch 2: **on by default**. Turn it off only for probe comparison: put `lottieExact=0` in the page address, or set
 * `window.__pcLottieExact = false` before creating an instance
 */
export function lottieExactEnabled(): boolean {
  return flagOf("__pcLottieExact", "lottieExact", true);
}

/**
 * Switch 3: **on by default**. Turn it off only for probe comparison: put `lottieExpr=0` in the page address, or set
 * `window.__pcLottieExpr = false` before creating an instance
 */
export function lottieExprEnabled(): boolean {
  return flagOf("__pcLottieExpr", "lottieExpr", true);
}

/**
 * Remind the browser to repaint nested masks on every frame (see "The browser does not repaint nested masks" below):
 * **on by default**.
 * Turn it off only for probe comparison: put `lottieRepaint=0` in the page address, or set
 * `window.__pcLottieRepaint = false` before creating an instance
 */
export function lottieRepaintEnabled(): boolean {
  return flagOf("__pcLottieRepaint", "lottieRepaint", true);
}

/**
 * Asset content → 32-bit seed (FNV-1a). Compute it **before** handing the data to the player library, because the
 * player library modifies the data in place
 */
export function lottieSeedOf(data: unknown): number {
  const text = typeof data === "string" ? data : JSON.stringify(data) ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

interface LottieMath { seedrandom(seed: string): unknown }
let lottieMath: LottieMath | null | undefined;

/**
 * Get the player library's internal random source (see above). Done once per page; the randSeed drawn by our own
 * expression is not counted in the page-wide sequence
 */
function captureLottieMath(): LottieMath | null {
  if (lottieMath !== undefined) return lottieMath;
  lottieMath = null;
  try {
    withSeededRandom(0, () => {
      const a = lottie.loadAnimation({
        container: document.createElement("div"),
        renderer: "svg",
        loop: false,
        autoplay: false,
        animationData: {
          v: "5.7.4", fr: 30, ip: 0, op: 1, w: 1, h: 1, nm: "pc-seed", ddd: 0, assets: [],
          layers: [{
            ddd: 0, ind: 1, ty: 3, nm: "pc-seed", sr: 1, ao: 0, ip: 0, op: 1, st: 0, bm: 0,
            ks: {
              o: { a: 0, k: 100, x: "var $bm_rt;\nglobalData.__pcLottieMath = Math;\n$bm_rt = value;" },
              r: { a: 0, k: 0 }, p: { a: 0, k: [0, 0, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] },
            },
          }],
        },
        rendererSettings: { progressiveLoad: false },
      });
      a.goToAndStop(0, true);
      const g = (a as unknown as { renderer?: { globalData?: { __pcLottieMath?: LottieMath } } }).renderer?.globalData;
      if (g?.__pcLottieMath && typeof g.__pcLottieMath.seedrandom === "function") lottieMath = g.__pcLottieMath;
      a.destroy();
    });
  } catch { /* If it cannot be obtained, treat it as not obtained */ }
  if (!lottieMath) console.warn("[lottie] 取不到播放库内部的随机源:只有 wiggle() 的表达式仍会和推帧路径有关");
  return lottieMath;
}

/** The members of a player library property object that this prototype uses */
interface LottieProp { propType?: string; mult: number; v: number | number[] | Float32Array; _mdf: boolean; setVValue?: (val: any) => void }

/**
 * The "update if not equal" version of the player library's setVValue: the original skips the update when the
 * difference is under 0.00001 (see item 3 above)
 */
function setVValueExact(this: LottieProp, val: any): void {
  if (this.propType === "unidimensional") {
    const next = val * this.mult;
    if (this.v !== next) { this.v = next; this._mdf = true; }
    return;
  }
  const v = this.v as number[] | Float32Array;
  for (let i = 0; i < v.length; i++) {
    const next = val[i] * this.mult;
    if (v[i] !== next) { v[i] = next; this._mdf = true; }
  }
}

/**
 * Whether the instance being built has switch 2 on. True only during the synchronous code that builds properties
 */
let exactBuilding = false;
let propertyFactoryHooked: boolean | undefined;

/**
 * Wrap the hook where the player library builds properties (see above). Wrapped once per page; when `exactBuilding`
 * is false it passes through unchanged
 */
function hookPropertyFactory(): boolean {
  if (propertyFactoryHooked !== undefined) return propertyFactoryHooked;
  propertyFactoryHooked = false;
  try {
    const factory = (lottie as unknown as { __getFactory?: (name: string) => { getProp?: (...args: unknown[]) => LottieProp } | null }).__getFactory?.("propertyFactory");
    const inner = factory?.getProp;
    if (factory && typeof inner === "function") {
      factory.getProp = function getPropExact(this: unknown, ...args: unknown[]) {
        const prop = inner.apply(this, args);
        if (exactBuilding && prop && typeof prop.setVValue === "function") prop.setVValue = setVValueExact;
        return prop;
      };
      propertyFactoryHooked = true;
    }
  } catch { /* If it cannot be wrapped, treat it as not wrapped */ }
  if (!propertyFactoryHooked) console.warn("[lottie] 包不上播放库建属性的口子:属性值仍会留旧数,顺着推和直接跳可能差一点");
  return propertyFactoryHooked;
}

// ── Switch 3: replace the random functions in expressions ──

/** mulberry32: the same algorithm as kernel/pinEntropy.ts; here every call needs a sequence of its own */
function streamOf(state: number): () => number {
  let s = state | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix several 32-bit integers into one seed */
function mixSeed(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h = Math.imul(h ^ (p | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h | 0;
}

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
/**
 * Split the 64 bits of a number (a time, a seedRandom argument) as they are into two integers: no rounding, no
 * conversion to a string; the same number always gives the same pair
 */
function bitsOf(x: number): [number, number] {
  f64[0] = x;
  return [u32[0], u32[1]];
}

/** Purpose id of each sequence, mixed into the seed so that numbers for different purposes are independent */
const STREAM_EVAL = 1, STREAM_SEEDED = 3, STREAM_MATH_SEEDED = 5, STREAM_FRAME = 6;

/** Where a random sequence has got to now. The next inside it is replaced wholesale (re-seeding) */
interface ExprStream { next: () => number }

/**
 * "The sequence shared by all expressions within one frame". Non-null only inside the synchronous code that wraps an
 * instance with switch 3 on (building the instance, loading completion, frame jumps);
 * at the start of that code `loadLottie` sets its starting point from (asset seed, frame number), and at the end it
 * restores the previous value, so two instances drawing frames alternately do not affect each other.
 */
let exprShared: ExprStream | null = null;

/**
 * Called once per evaluation of a rewritten expression; returns the four things used this time: random, seedRandom,
 * wiggle, and the Math with random replaced.
 *
 * Principle (user decision, 2026-10-12): fixing the random numbers is only meant to make every result identical, not
 * to change the original look. So this follows what the player library does today: **all expressions share one
 * sequence of random numbers and keep drawing in evaluation order within a frame**; only the starting point of this
 * sequence for each frame is fixed:
 *
 *   Start of this frame   Set when a frame starts drawing, from (asset seed, frame number) (in `loadLottie`). The
 *                         player library today continues from what the previous frame left, so it depends on what
 *                         was drawn before; this is the only place that is changed.
 *   Before evaluation     If the expression source contains the letters `random`, replace the shared sequence with
 *                         one set by (asset, expression number, time). This corresponds to the player library's
 *                         `_needsRandom` and `seedRandom(randSeed + time)`. Expressions without them do not replace
 *                         it and keep drawing after the previous expression.
 *   random                Call forms follow the player library: no argument gives 0 to 1; one argument is the upper
 *                         bound; two arguments are the lower and upper bounds; when the argument is an array, all
 *                         components share one random number.
 *   wiggle                The algorithm follows the player library: frequency hard-coded to 5, accumulate
 *                         floor(time×5) groups of random numbers, then add the next group multiplied by the
 *                         fractional part. "Time" is the `time` at the moment of the call (changed if the expression
 *                         called posterizeTime first), same as the player library.
 *   seedRandom            Following today's rule in the player library, the second argument is ignored: replace the
 *                         shared sequence with one set by (asset, expression number, argument), without time.
 *   Math                  `Math.random()` also draws from the shared sequence; `Math.seedrandom(x)` (the player
 *                         library hangs its seeding function on Math too) likewise replaces this sequence.
 * random, wiggle and Math.random all keep drawing at the **current position** of the shared sequence. So, as with the
 * player library today: an expression that only writes wiggle and is evaluated after another expression's seedRandom
 * keeps drawing the numbers without time, which look continuous; one that comes first, with nobody having seeded before
 * it, draws from this frame's starting point and jumps frame by frame; if an expression, halfway through evaluation,
 * reads another property that has a random expression, the latter replaces this sequence midway, and the former keeps
 * drawing from the replaced one.
 * The player library has no `gaussRandom` and none is added here: if an expression uses it, it fails, as it does now,
 * in the player library's way.
 *
 * "The order of evaluation within one frame" depends only on the asset and the frame number (each frame the player
 * library goes from the last layer to the front, computes only layers that are present, and each expression is
 * evaluated only once per frame), so the picture depends only on the asset and the frame number.
 *
 * Should an expression be evaluated outside that synchronous code (`exprShared` is null: someone bypassed the goTo
 * given by `loadLottie` and called the player library's `goToAndStop`, `resize`, `updateDocumentData` and the like
 * directly), fall back to a sequence per expression (asset, expression number, time): the result is still the same
 * every time, only that "a wiggle evaluated after someone else's seedRandom" is no longer continuous. The card itself
 * never gets here.
 *
 * value is the original property value the expression receives. The player library's wiggle uses `this.pv`: for a
 * property with keyframes the two are the same object; for a multi-dimensional property without keyframes `pv` is the
 * original value stored in single precision, so here the value is first taken to single precision and then computed,
 * and the result is bit-identical to using `pv` (verified by probes).
 */
function lottieExprRuntime(seed: number, id: number, time: number, value: any, math: object, now?: () => number, needsRandom?: unknown): unknown[] {
  const [t0, t1] = bitsOf(Number(time) || 0);
  const own = () => streamOf(mixSeed(seed, id, STREAM_EVAL, t0, t1));
  const stream: ExprStream = exprShared ?? { next: own() };
  if (exprShared && needsRandom) stream.next = own();
  const rnd = () => stream.next();
  const random = (min?: any, max?: any) => {
    if (max === undefined) {
      if (min === undefined) { min = 0; max = 1; } else { max = min; min = undefined; }
    }
    if (max.length) {
      const len = max.length;
      if (!min) min = new Float32Array(len);
      const arr = new Float32Array(len);
      const r = rnd();
      for (let i = 0; i < len; i++) arr[i] = min[i] + r * (max[i] - min[i]);
      return arr;
    }
    if (min === undefined) min = 0;
    return min + rnd() * (max - min);
  };
  const seedRandom = (offset?: any) => {
    const [o0, o1] = bitsOf(Number(offset) || 0);
    stream.next = streamOf(mixSeed(seed, id, STREAM_SEEDED, o0, o1));
  };
  const wiggle = (_freq: number, amp: number) => {
    const len = (value && value.length) || 1;
    const added = new Float32Array(len);
    const periods = (Number(now ? now() : time) || 0) * 5;
    const iterations = Math.floor(periods);
    for (let i = 0; i < iterations; i++) for (let j = 0; j < len; j++) added[j] += -amp + amp * 2 * rnd();
    const perc = periods - iterations;
    if (len > 1) {
      const arr = new Float32Array(len);
      for (let j = 0; j < len; j++) arr[j] = Math.fround(value[j]) + added[j] + (-amp + amp * 2 * rnd()) * perc;
      return arr;
    }
    return value + added[0] + (-amp + amp * 2 * rnd()) * perc;
  };
  const shadowMath = Object.create(math) as { random: () => number; seedrandom: (s?: unknown) => void };
  shadowMath.random = rnd;
  shadowMath.seedrandom = (s?: unknown) => { stream.next = streamOf(mixSeed(seed, id, STREAM_MATH_SEEDED, lottieSeedOf(String(s)))); };
  return [random, seedRandom, wiggle, shadowMath];
}

/**
 * Rewritten expressions find the function above through this global name. Each page (stage, export page) installs it
 * once
 */
const EXPR_RUNTIME = "__pcLottieFn";
function installLottieExprRuntime(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g[EXPR_RUNTIME] !== "function") g[EXPR_RUNTIME] = lottieExprRuntime;
}

/** A rewritten expression starts with it, which is how "already rewritten" is recognized */
const EXPR_MARK = "/*pc-expr*/";

/**
 * Wrap a piece of expression source: the source is put unchanged into a function body whose parameters are named
 * random, seedRandom, wiggle and Math, shadowing the same-named things in the player library's scope; the arguments
 * are evaluated in the outer layer, so they can reach the player library's `time`, `value` and `Math`.
 * No call sites are looked up and replaced (a regex would hit strings, property names and other identifiers); if the
 * source itself declares a variable or function of the same name, it shadows the parameter as usual, without error.
 *
 * The first parameter is the identifier random, except that the letter a is written as a Unicode escape, so the word
 * does not appear in the text: the player library looks for these six letters in the expression text to decide
 * whether to seed its own sequence before evaluation (`_needsRandom`); this way its decision after wrapping is the
 * same as before, and we do not disturb it more than necessary.
 * A newline comes before `return` after the source: if the last line of the source is a `//` comment, the return is
 * not commented out with it.
 * The second-to-last argument is "the current time": calling posterizeTime in an expression changes `time`, and
 * wiggle has to read the changed one.
 * The last argument is whether the source contains the letters `random` (decided the same way as the player library's
 * `_needsRandom`, case-sensitive): if so, the sequence is replaced before evaluation.
 */
function wrapLottieExpression(source: string, seed: number, id: number): string {
  return `${EXPR_MARK}var $bm_rt = (function (r\\u0061ndom, seedRandom, wiggle, Math) {\nvar $bm_rt;\n${source}\n;return $bm_rt;\n}).apply(null, ${EXPR_RUNTIME}(${seed}, ${id}, time, value, Math, function () { return time; }, ${source.indexOf("random") !== -1 ? 1 : 0}));`;
}

/**
 * Whether this expression source might draw random numbers (it mentions random or wiggle by name, or uses Math)
 */
const MAY_DRAW = /random|wiggle|math/i;

/**
 * Rewrite all expressions in the asset data (in place; do it after computing the seed and before handing the data to
 * the player library). Returns how many were rewritten.
 * An expression = the string `x` on a property object that has `k`. The number = a hash of its position in the
 * asset, unchanged across pages and machines.
 *
 * When a nested composition is referenced several times (the same composition placed in several copies): the player
 * library today draws a separate `randSeed` for the expressions in each copy, so the copies move independently.
 * To keep that, a composition with random expressions is copied each time it is referenced, each copy is rewritten
 * separately, and the number includes "which layer it was entered from"; the original copy, once nobody references
 * it, is removed. Compositions without random expressions are not copied.
 */
export function rewriteLottieExpressions(data: unknown, seed: number): number {
  let count = 0;
  const wrapIn = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) wrapIn(node[i], `${path}/${i}`);
      return;
    }
    const o = node as Record<string, unknown>;
    if (typeof o.x === "string" && "k" in o && !o.x.startsWith(EXPR_MARK)) {
      o.x = wrapLottieExpression(o.x, seed, lottieSeedOf(path));
      count++;
    }
    for (const key of Object.keys(o)) wrapIn(o[key], `${path}/${key}`);
  };
  type Comp = { id: string; layers: Array<Record<string, unknown>> };
  const root = data as { layers?: Array<Record<string, unknown>>; assets?: unknown[]; chars?: unknown } | null;
  if (root && typeof root === "object" && Array.isArray(root.layers) && Array.isArray(root.assets)) {
    const comps = new Map<string, Comp>();
    for (const a of root.assets as Comp[]) if (a && typeof a.id === "string" && Array.isArray(a.layers)) comps.set(a.id, a);
    const drawsInside = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      if (Array.isArray(node)) return node.some(drawsInside);
      const o = node as Record<string, unknown>;
      if (typeof o.x === "string" && "k" in o && MAY_DRAW.test(o.x)) return true;
      return Object.keys(o).some((key) => drawsInside(o[key]));
    };
    // Whether this composition (including the ones nested in it) has expressions that might draw random numbers
    const memo = new Map<string, boolean>();
    const draws = (id: string): boolean => {
      const known = memo.get(id);
      if (known !== undefined) return known;
      memo.set(id, false); // Do not loop when a composition nests itself
      const comp = comps.get(id);
      const yes = !!comp && (drawsInside(comp.layers) || comp.layers.some((l) => l && typeof l.refId === "string" && draws(l.refId)));
      memo.set(id, yes);
      return yes;
    };
    const copied = new Set<string>();
    let copies = 0;
    const visit = (layers: Array<Record<string, unknown>>, from: string): void => {
      layers.forEach((layer, i) => {
        if (!layer || typeof layer !== "object") return;
        const here = `${from}/${i}`;
        wrapIn(layer, here);
        const ref = layer.refId;
        if (layer.ty === 0 && typeof ref === "string" && comps.has(ref) && draws(ref)) {
          const copy = JSON.parse(JSON.stringify(comps.get(ref))) as Comp;
          copy.id = `${ref}~pc${copies++}`;
          root.assets!.push(copy);
          layer.refId = copy.id;
          copied.add(ref);
          visit(copy.layers, here);
        }
      });
    };
    visit(root.layers, "");
    // The original of a copied composition: remove it unless something else (a glyph) still references it
    const stillUsed = JSON.stringify(root.chars ?? null);
    root.assets = root.assets.filter((a) => !(a && typeof a === "object" && copied.has((a as Comp).id) && !stillUsed.includes(JSON.stringify((a as Comp).id))));
  }
  // The rest (compositions that were not copied, glyphs, other places): numbered by their path in the JSON
  wrapIn(data, "");
  return count;
}

// ── The outer layer: where the player library draws random numbers directly (shared by switch 1 and switch 3) ──

/** Purpose ids of the sequences of the outer layer */
const OUTER_BUILD = 11, OUTER_FRAME = 12, OUTER_TEXT = 13;

/**
 * Which asset the text layer "random order" animator is computing for. Non-null only inside the synchronous code that
 * wraps an instance; when null (another Lottie with no switch on), the player library computes as usual.
 */
let textSeedNow: number | null = null;
/**
 * Whether the expression of a text content is computed with the "keep no stale content" method (see the second
 * paragraph of `hookTextOrder`). True only inside the synchronous code that wraps an instance with the outer layer on.
 */
let textFreshNow = false;
let textOrderHooked: boolean | undefined;

/** Whether the asset has a text layer whose text content carries an expression (`t.d.x`) */
function hasTextExpression(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasTextExpression);
  const o = node as Record<string, unknown>;
  const doc = (o.ty === 5 ? (o.t as { d?: { x?: unknown } } | undefined)?.d : undefined);
  if (doc && typeof doc.x === "string") return true;
  return Object.keys(o).some((key) => hasTextExpression(o[key]));
}

/** Whether the asset has a "random order" text animator (`rn: 1` on the selector) */
function hasRandomTextOrder(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasRandomTextOrder);
  const o = node as Record<string, unknown>;
  if (o.rn === 1) return true;
  return Object.keys(o).some((key) => hasRandomTextOrder(o[key]));
}

/**
 * The "random order" of text layers: when the player library "computes the layout of one piece of text content"
 * (`TextProperty.completeTextData`) it calls `Math.random()` directly to shuffle the character order; each piece of
 * text content is computed only once, and the result is remembered. When it is computed is not fixed: text without
 * keyframes is computed when the layer is built; for text with keyframes, each keyframe's content is computed on the
 * frame where it is **first drawn**. So seeding the outer layer by frame number alone is not enough: pushing forward
 * computes it on the keyframe's frame, jumping directly computes it on the frame jumped to, and the shuffle results
 * differ.
 *
 * Here this one place is fixed separately: whichever piece is being computed is seeded by (asset seed, layer, text
 * content), independent of which frame it is computed on and of what was computed before.
 * `TextProperty` is not exported, so we build a throwaway animation with a single text layer, take the prototype from
 * it, and wrap `completeTextData`. Wrapped once per page; nothing is done when the asset has no random-order text and
 * no text content with expressions.
 *
 * One more wrap on the same prototype, unrelated to random numbers (found on 2026-10-13 when testing "an expression
 * changes the text content, combined with random order"): when the text content carries an expression, each frame the
 * player library first rewrites the text in the layout result it holds to the original text on the keyframe, then
 * compares it with the text the expression computes, and if they are the same it **keeps the one it holds as it is**
 * (`getExpressionValue`). If the one in hand is the layout of another piece of text that the expression swapped in on
 * the previous frame, and this frame the expression is back to the original, what is drawn is still the previous text:
 * pushing forward and jumping directly then differ. Here this is changed to ignore the one in hand: if the expression
 * computes the original text, use the keyframe's own layout; if it computes something else, start a new one from the
 * keyframe's layout. It only takes effect for instances inside the wrapped section; others (without the outer layer
 * on) are unchanged.
 */
function hookTextOrder(): boolean {
  if (textOrderHooked !== undefined) return textOrderHooked;
  textOrderHooked = false;
  let why = "没取到文字图层的原型";
  try {
    withSeededRandom(0, () => {
      const zero = { a: 0, k: 0 }, origin = { a: 0, k: [0, 0, 0] };
      const a = lottie.loadAnimation({
        container: document.createElement("div"),
        renderer: "svg",
        loop: false,
        autoplay: false,
        animationData: {
          v: "5.7.4", fr: 30, ip: 0, op: 1, w: 1, h: 1, nm: "pc-text", ddd: 0, assets: [],
          fonts: { list: [{ fName: "PcText", fFamily: "PcText", fStyle: "Regular", ascent: 0 }] },
          // Leave an empty group for the glyph: when the player library tidies the data it adds a transform to
          // shapes[0].it
          chars: [{ ch: "A", size: 1, style: "Regular", w: 1, fFamily: "PcText", data: { shapes: [{ ty: "gr", it: [] }] } }],
          // The layer's in point is outside the animation: build it but do not draw it
          layers: [{
            ddd: 0, ind: 1, ty: 5, nm: "pc-text", sr: 1, ao: 0, ip: 5, op: 6, st: 0, bm: 0,
            ks: { o: { a: 0, k: 100 }, r: zero, p: origin, a: origin, s: { a: 0, k: [100, 100, 100] } },
            t: { d: { k: [{ s: { s: 1, f: "PcText", t: "A", j: 0, tr: 0, lh: 1, ls: 0, fc: [0, 0, 0] }, t: 0 }] }, p: {}, m: { g: 1, a: { a: 0, k: [0, 0] } }, a: [] },
          }],
        },
        rendererSettings: { progressiveLoad: false },
      });
      type TextDoc = { t?: unknown; __complete?: boolean };
      type TextProp = {
        completeTextData?: (doc: TextDoc) => unknown;
        getExpressionValue?: (current: TextDoc, text: unknown) => TextDoc;
        calculateExpression?: (text: unknown) => unknown;
        copyData?: (into: TextDoc, from: TextDoc) => TextDoc;
        keysIndex?: number;
        data?: { d?: { k?: Array<{ s: TextDoc }> } };
        elem?: { data?: { ind?: unknown }; comp?: { data?: { refId?: unknown } } };
      };
      const text = (a as unknown as { renderer?: { elements?: Array<{ textProperty?: TextProp }> } }).renderer?.elements?.[0]?.textProperty;
      const proto = text ? (Object.getPrototypeOf(text) as TextProp) : null;
      const original = proto?.completeTextData;
      if (proto && typeof original === "function") {
        proto.completeTextData = function completeTextDataKeyed(this: TextProp, doc: { t?: unknown }) {
          if (textSeedNow === null) return original.call(this, doc);
          // Layer = the composition it is in (a nested composition uses the refId in the asset) plus its index within the
          // composition
          const layer = lottieSeedOf(`${String(this.elem?.comp?.data?.refId ?? "")}/${String(this.elem?.data?.ind ?? "")}`);
          return withSeededRandom(mixSeed(textSeedNow, OUTER_TEXT, layer, lottieSeedOf(String(doc?.t ?? ""))), () => original.call(this, doc));
        };
        textOrderHooked = true;
        // Expressions of text content: keep no stale content (see the second paragraph above). When the player library does
        // not have this function (a build with expressions disabled), it is not wrapped, and that is not a failure
        const originalValue = proto.getExpressionValue;
        if (typeof originalValue === "function") {
          proto.getExpressionValue = function getExpressionValueFresh(this: TextProp, current: TextDoc, text: unknown) {
            const key = this.data?.d?.k?.[this.keysIndex ?? 0]?.s;
            if (!textFreshNow || !key || typeof this.calculateExpression !== "function" || typeof this.copyData !== "function") return originalValue.call(this, current, text);
            const next = this.calculateExpression(text);
            if (key.t === next) return key;
            const doc: TextDoc = {};
            this.copyData(doc, key);
            doc.t = String(next);
            doc.__complete = false;
            return doc;
          };
        }
      }
      a.destroy();
    });
  } catch (e) { why = String((e as Error)?.message ?? e); }
  if (!textOrderHooked) console.warn(`[lottie] 包不上播放库算文字排版的地方:随机顺序的文字仍可能和推帧路径有关(${why})`);
  return textOrderHooked;
}

/**
 * Whether each of the three switches is on (omit expr to mean off); repaint is "remind the browser every frame to
 * repaint nested masks", and when omitted it follows `lottieRepaintEnabled()`.
 * debug is only for probe comparison: "no-outer" leaves out the outer layer; "no-text-key" keeps the outer layer seeding
 * by frame as usual but does not fix the random order of text separately.
 */
export interface LottieMode { seed: boolean; exact: boolean; expr?: boolean; repaint?: boolean; debug?: "no-outer" | "no-text-key" }

/**
 * A built animation: every frame jump goes through goTo. seed is the asset seed; null when neither switch 1 nor
 * switch 3 is on
 */
export interface LottieHandle {
  anim: AnimationItem;
  seed: number | null;
  exact: boolean;
  /** How many expressions were rewritten when switch 3 is on; null when it is off */
  rewritten: number | null;
  goTo(frame: number): void;
}

/**
 * Build one animation instance. The default (no mode passed) is the production set: switch 3, the outer layer and
 * switch 2 on, switch 1 off; do as the description above says.
 * Switch 3 rewrites the expressions in data in place. With all three switches off it is just the original two
 * statements: `lottie.loadAnimation` and `goToAndStop(frame, true)`.
 */
export function loadLottie(container: HTMLElement, data: any, fit: string, mode: LottieMode = { seed: lottieSeedEnabled(), exact: lottieExactEnabled(), expr: lottieExprEnabled() }): LottieHandle {
  const seed = mode.seed || mode.expr ? lottieSeedOf(data) : null;
  const exact = mode.exact && hookPropertyFactory();
  let rewritten: number | null = null;
  if (mode.expr && seed !== null) {
    installLottieExprRuntime();
    rewritten = rewriteLottieExpressions(data, seed);
  }
  const build = () => lottie.loadAnimation({
    container,
    // Draw on SVG, not on canvas (user decision, 2026-10-10): the built-in asset that has a mask layer is drawn wrong on
    // canvas, and SVG has better compatibility; when pixels are needed, the SVG is turned straight into pixels, which is
    // fast enough. For measurements see docs/plan/render-standard.md "Lottie motion graphics"
    renderer: "svg",
    loop: false,
    autoplay: false,
    animationData: data,
    rendererSettings: {
      preserveAspectRatio: fit === "cover" ? "xMidYMid slice" : "xMidYMid meet",
      progressiveLoad: false,
    },
  });
  if (seed === null && !exact) {
    const anim = build();
    return { anim, seed, exact, rewritten, goTo: (frame) => anim.goToAndStop(frame, true) };
  }
  // The player library's internal random source is used only by switch 1; with only switch 3 on, do not fetch it or
  // seed it
  const math = mode.seed ? captureLottieMath() : null;
  /**
   * The built instance. Still null before it is built (inside the synchronous build section); the player library draws
   * frame 0 at that time
   */
  let built: AnimationItem | null = null;
  // The outer layer (present with both switch 1 and switch 3): where the player library calls the page-wide
  // `Math.random()` directly
  const outerOn = seed !== null && mode.debug !== "no-outer";
  const randomText = hasRandomTextOrder(data);
  const textHooked = outerOn && (randomText || hasTextExpression(data)) && hookTextOrder();
  const textKeyed = textHooked && randomText && mode.debug !== "no-text-key";
  /**
   * All the synchronous code in the player library that may build layers or draw a frame goes through here: building the
   * instance, loading completion (including the callback of asynchronous loading), frame jumps.
   * key says which sequence this section uses: layer building uses "build", drawing a frame uses its frame number.
   *   - The outer layer: within this section the page-wide `Math.random` is replaced by the (asset seed, key) sequence and
   *     put back as it was afterwards. The random numbers the player library draws directly while drawing frame N depend
   *     only on the asset and N, and the page-wide sequence is not moved by Lottie either.
   *   - The random order of text is fixed separately by (asset, layer, text content), see `hookTextOrder`.
   *   - Switch 1 also seeds the player library's internal sequence by the same key.
   *   - Switch 3 also sets the starting point of "the sequence shared by all expressions within one frame" (see
   *     `lottieExprRuntime`).
   */
  const guarded = <T,>(key: "build" | number, fn: () => T): T => {
    const outerExact = exactBuilding, outerText = textSeedNow, outerFresh = textFreshNow, outerShared = exprShared;
    exactBuilding = exact;
    textSeedNow = textKeyed ? seed : null;
    textFreshNow = textHooked;
    // Switch 3: the sequence shared by all expressions within this frame, starting point = (asset seed, frame number). In
    // the section of building the instance / loading completion the player library draws the current frame by itself once
    // (building layers does not itself evaluate expressions), so that section also uses the current frame number. The
    // outer layer uses the layer-building sequence in that section though, so after loading completes the frame must be
    // redrawn by frame number (see redraw)
    const frame = key === "build" ? Number((built as unknown as { currentRawFrame?: number } | null)?.currentRawFrame) || 0 : key;
    exprShared = mode.expr && seed !== null ? { next: streamOf(mixSeed(seed, STREAM_FRAME, ...bitsOf(frame))) } : null;
    try {
      if (seed === null) return fn();
      math?.seedrandom(`${seed}:${key}`);
      if (!outerOn) return fn();
      return withSeededRandom(key === "build" ? mixSeed(seed, OUTER_BUILD) : mixSeed(seed, OUTER_FRAME, ...bitsOf(key)), fn);
    } finally {
      exactBuilding = outerExact;
      textSeedNow = outerText;
      textFreshNow = outerFresh;
      exprShared = outerShared;
    }
  };
  /**
   * At the moment loading completes the player library draws the current frame once by itself, and that draw happens in
   * the "layer building" section: the page-wide `Math.random` uses the layer-building sequence (and the first few numbers
   * have been taken by the expressions' randSeed, and how many were taken also depends on whether another Lottie on the
   * page had seeded before), and with switch 1 the player library's internal sequence is also what layer building left
   * over. Later, when jumping back to this frame, the "seed + frame number" sequence is used, so the picture may differ.
   * So after loading completes the frame is redrawn in place by frame number (`renderFrame(null)` is how the player
   * library writes "draw the current frame again"), taking the same path as a later jump to this frame.
   * For an asset with only switch 3 on whose expressions use random / wiggle properly, the two draws are identical
   * anyway (the starting point of the sequence shared by expressions in that section is already the current frame); the
   * difference shows up in assets whose expressions bypass that and use the global `Math.random` or `crypto` directly
   * (found in the supplementary test of 2026-10-13), so the redraw is done in all cases.
   */
  const redraw = () => {
    if (mode.seed || outerOn) {
      const item = anim as unknown as { currentRawFrame: number; renderer?: { renderFrame?: (frame: number | null) => void } };
      guarded(Number(item.currentRawFrame) || 0, () => item.renderer?.renderFrame?.(null));
    }
    repaintMasks();
  };
  /**
   * The browser does not repaint nested masks (see item 4 in the file header): the masks of this instance that need a
   * per-frame reminder. Layers are fully built only after loading completes, so they are looked up then
   */
  const repaintOn = mode.repaint ?? lottieRepaintEnabled();
  let nestedMasks: Element[] | null = null;
  const repaintMasks = () => {
    if (!repaintOn) return;
    if (nestedMasks === null) {
      if (!built?.isLoaded) return;
      nestedMasks = Array.from(container.querySelectorAll("mask")).filter((m) => m.querySelector("g, use, [clip-path], [mask], [filter]"));
    }
    for (const m of nestedMasks) {
      const first = m.firstChild;
      if (!first) continue;
      m.removeChild(first);
      m.insertBefore(first, m.firstChild);
    }
  };
  const anim: AnimationItem = guarded("build", build);
  built = anim;
  if (anim.isLoaded) redraw();
  else {
    // Fonts / external data not all arrived: layer building and the first draw both happen in the player library's timer
    // callback, so this instance's checkLoaded is wrapped in
    const item = anim as unknown as { checkLoaded: () => void; isLoaded: boolean };
    const original = item.checkLoaded;
    item.checkLoaded = function checkLoadedGuarded(this: unknown) {
      const was = item.isLoaded;
      guarded("build", () => original.call(this));
      if (!was && item.isLoaded) redraw();
    };
  }
  return { anim, seed, exact, rewritten, goTo: (frame) => { guarded(frame, () => anim.goToAndStop(frame, true)); repaintMasks(); } };
}

/**
 * LottieView input: same names as the card parameters; the media wrapper card (src/cards/assets) also uses it after
 * fixing src
 */
export interface LottieViewProps {
  json: string;
  src: string;
  speed: number;
  loop: string;
  fit: string;
  t?: number;
}

/**
 * Render core: given a data source and t, position the animation at the corresponding frame. This is the product of
 * the "function translation" layer: every Lottie file in the asset catalog becomes a wrapper card through it, and the
 * cards differ only in src.
 */
export function LottieView(params: LottieViewProps) {
  const t = params.t ?? 0;
  const box = useRef<HTMLDivElement>(null);
  const anim = useRef<LottieHandle | null>(null);
  const meta = useRef({ fr: 30, total: 0 });
  /**
   * The latest t. Loading is asynchronous (src has to be fetched), and when it finishes we must know "which frame to
   * stop on now"
   */
  const wantT = useRef(t);
  wantT.current = t;

  /** t → frame number. Needed both when loading completes and when t changes, so it is written in one place only */
  const frameAt = (sec: number) => {
    const { fr, total } = meta.current;
    const f = sec * fr * (params.speed > 0 ? params.speed : 1);
    return params.loop === "yes" ? f % total : Math.min(f, total - 1);
  };

  // Load / change asset
  useEffect(() => {
    let dead = false;
    const ready = beginFrameWork('lottie');
    const mount = (data: any) => {
      if (dead || !box.current) return;
      anim.current?.anim.destroy();
      box.current.innerHTML = "";
      // Building the instance and frame jumps both go through loadLottie (see the file header): random numbers and
      // property values are fixed there
      const handle = loadLottie(box.current, data, params.fit);
      const a = handle.anim;
      meta.current = { fr: Number(data.fr) || 30, total: Math.max(0, (Number(data.op) || 0) - (Number(data.ip) || 0)) };
      anim.current = handle;
      /*
       * **Stop at the current t, not at frame 0.**
       *
       * Loading is asynchronous (src has to be fetched), while the "jump the frame when t changes" effect below only runs
       * when t really changes. If loading finishes after the last change of t, the effect will never be triggered again:
       * the animation is stuck on frame 0 from then on, and no error is reported. Measured with lottie-adrock at t=3.0s:
       * export shows the last frame with the character standing still, while preview shows only the background and the
       * shadow.
       * Export does not hit this pit: the virtual clock waits for pending network requests
       * (pauseIfNetworkFetchesPending), so the JSON is always in place before frames are pushed.
       */
      handle.goTo(meta.current.total ? frameAt(wantT.current) : 0);
      const finish = () => {
        if (dead) return;
        handle.goTo(meta.current.total ? frameAt(wantT.current) : 0);
        ready.ready();
      };
      if (a.isLoaded) finish();
      else a.addEventListener('DOMLoaded', finish);
      a.addEventListener('data_failed', () => ready.fail(new Error('Lottie data failed to load')));
      // In the export page lottie's own rAF loop only spins idle (an animation without autoplay); freeze it so that every
      // frame is not judged as "changing"
      // freeze() is a public lottie-web API, just missing from the type declarations
      if (isExportMode()) (lottie as unknown as { freeze?: () => void }).freeze?.();
    };
    const inline = params.json.trim();
    if (inline) {
      try { mount(JSON.parse(inline)); } catch (e) { ready.fail(e); console.warn("[lottie] json 参数不是合法的 Lottie JSON:", e); }
    } else if (params.src.trim()) {
      fetch(params.src.trim()).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(mount).catch((e) => { ready.fail(e); console.warn("[lottie] 加载失败:", params.src, e); });
    } else ready.ready();
    return () => {
      dead = true;
      ready.dispose();
      anim.current?.anim.destroy();
      anim.current = null;
    };
  }, [params.json, params.src, params.fit]);

  // Follow the timeline: t → frame number
  useEffect(() => {
    const a = anim.current;
    if (!a || !meta.current.total) return;
    a.goTo(frameAt(t));
  }, [t, params.speed, params.loop]);

  return <div ref={box} className="absolute inset-0" />;
}

function LottieCard({ params, t = 0 }: CardProps<Params>) {
  return <LottieView json={params.json} src={params.src} speed={params.speed} loop={params.loop} fit={params.fit} t={t} />;
}

export const lottieCard: CardDef<Params> = {
  id: "lottie",
  name: "Lottie animation",
  description: "Plays a Lottie animation (JSON exported from AE), stepping frame by frame with the timeline",
  useWhen: "Use this to place a ready-made Lottie animation. The app ships with a few media items (title logos, character reveals, holiday decorations, etc.), listed in the options of the src control: just fill that URL into src. You can also use any other Lottie file directly (downloaded from LottieFiles, or exported from AE by a designer). Paste the JSON text into the json parameter, or give a URL. It does not \"play\" by itself; it is positioned frame by frame by clip time: the animation runs as long as the clip, speed adjusts how fast, and loop decides whether it loops at the end or stays on the last frame. Not suitable for drawing motion graphics from scratch: use another card for that. You must check the license of the media files yourself.",
  tags: ["lottie", "animation file", "AE", "media"],
  source: "native",
  // Frame mode: remotion-style (render refactor "Gui"). Each frame is computed directly from the asset, the parameters
  // and the frame number, without pushing forward from the mount frame; the places where random numbers and property
  // values keep stale numbers are fixed in loadLottie (see the file header), so pushing forward and jumping directly
  // give the same picture.
  frameMode: "direct",
  defaults: { json: DEMO_JSON, src: "", speed: 1, loop: "no", fit: "contain" },
  controls: [
    { key: "json", label: "Lottie JSON text (preferred)", type: "text", hint: "Contents of the whole .json file; leave empty to use src" },
    { key: "src", label: "Or media / URL", type: "asset", kind: "lottie", options: assetOptions("lottie"), hint: "Pick one from the media catalog (a URL in options), or enter another JSON URL; only used when the json parameter is empty" },
    { key: "speed", label: "Speed multiplier", type: "number", min: 0.1, max: 8, step: 0.1 },
    { key: "loop", label: "At the end", type: "select", options: [{ value: "no", label: "Hold last frame" }, { value: "yes", label: "Loop" }] },
    { key: "fit", label: "Fit", type: "select", options: [{ value: "contain", label: "Show in full" }, { value: "cover", label: "Fill and crop" }] },
  ],
  parts: [{ id: "animation", label: "Animation", role: "media", params: ["json", "src", "speed", "loop", "fit"] }],
  lifecycle: { after: "hold", exit: ["fade"] },
  timing: (p) => ({ after: p.loop === "yes" ? "loop" : "hold" }),
  Component: LottieCard,
};

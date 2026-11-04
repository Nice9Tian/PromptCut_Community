/**
 * Step 2 of generate snapshots: **style inlining** (task brief 3.8; comparison baseline is draft A2(8)).
 *
 * Reads computed styles of live elements and writes them into the clone's `style` attribute based on
 * "if omitted, replay will change". The bottleneck is **element count × property count**: for cards
 * with 2000+ nodes like lottie, high `inlineMs` comes from this step.
 *
 * This file **does not import `rasterizeCanvas`** (constraint named in task brief 3.8); the link
 * between the two steps is written in `createSnapshot.ts`: when replacing canvas with `<img>`, a
 * separate style string must be calculated based on IMG's baseline, so here `styleAs(el, tag)` is
 * handed off as part of the result and passed by `createSnapshot` to `rasterizeCanvas`. Neither side
 * knows the other.
 *
 * # Three criteria categories (draft A2(8))
 *
 *   (1) **Inherited properties** (`snapshotStyleProps.mjs`'s `INHERITED_PROPS`, plus all `--*`):
 *       compared against the **parent element's computed value**, omitted only when equal.
 *       **Cannot be compared with the same-tag baseline**: when an inherited property's value happens
 *       to equal the baseline but does not equal the parent value, omitting it will cause replay to
 *       inherit the parent value, resulting in wrong visuals. Top-level snapshot elements
 *       (the scene root of whole-scene html, direct children of a control wrapper layer) always have
 *       inherited properties fully inlined as before: during replay, their parent element is another
 *       tree, and inherited values are outside our control.
 *   (2) **Layout used value properties** (`LAYOUT_USED_VALUE_PROPS`) are always inlined as before and
 *       do not participate in omission: `getComputedStyle` provides **used values** (`width: auto`
 *       measures as `823.5px`), and accidental equality with baseline does not mean they will still
 *       match when relaid out during replay.
 *   (3) Remaining non-inherited properties are compared against the **same-tag baseline**. Baseline =
 *       computed style of a clean element (no class, no inline styles) with the same `namespaceURI` +
 *       `tagName` mounted under the scene root of the same snapshot page (= UA default + theme global
 *       styles), cached by `namespaceURI + tagName + themeId`.
 *
 * The trailing `animation:none !important;transition:none !important;` is still **written on every
 * element**: once injected, there must be no running clocks remaining.
 *
 * # Two required fallbacks
 *
 * The premise "cascade at replay = cascade when generating snapshots" has two gaps:
 *   1. **Properties written in the element's own `style` attribute**: we replace the entire `style`
 *      with our own string, so original inline declarations are lost. Motion is driven by inline
 *      `style`; if `opacity` moves to 1 which happens to equal the baseline, omitting it causes
 *      replay to fall back to `opacity: 0` in class rules.
 *   2. **Properties overridden by animations / transitions**: we hardcode
 *      `animation:none !important`, so at replay `@keyframes` no longer apply and properties fall
 *      back to declared values. If an entrance animation `opacity: 0 → 1` stops at 1 (= baseline)
 *      and is omitted, replay will be 0.
 * Both are resolved via "forced inlining": the former reads `el.style`, and the latter reads
 * keyframe property names from `root.getAnimations({ subtree: true })` once.
 *
 * # Four places that do not copy computed values verbatim (replay must match live render byte-for-byte)
 *
 * Source is `docs/archive/restructure_planning/reports/replay-mismatch-report.md`: the first two are
 * round 2 (§12), and the last two are round 3 (§13).
 *
 *   1. **Compositing layer**: during live render, elements where relevant animations (current or in
 *      effect, see `isRelevantAnimation`) override opacity / transform / filter are promoted to a
 *      separate layer by Chrome; snapshots hardcode `animation:none`, so this layer disappears and
 *      `filter: blur()` takes an alternate rasterization path that can differ by hundreds of levels.
 *      Therefore, add a `will-change` (`COMPOSITED_ANIMATION_PROPS`) to these elements. Round 2
 *      checked current only; round 3 changed to relevant based on real tests.
 *   2. **1/64 px**: `getComputedStyle` only gives 6 significant digits, losing one increment when
 *      layout values are fed back; px values in `LAYOUT_UNIT_PROPS` are snapped back to 1/64
 *      increments before writing (`snapLayoutUnits`).
 *   3. **Transforms**: `getComputedStyle` collapses transforms into a matrix with 6 significant
 *      digits: large translations lose precision down to 0.01 px, rotation cos / sin down to 1e-6,
 *      and `rotate(-90deg)` leaves residual 1e-17 and is no longer axis-aligned. Switched to reading
 *      components via Typed OM and writing back at full precision in function form (`exactTransform`
 *      → `serializeTransformList`), falling back to matrix only when reading fails.
 *   4. **SVG presentation attributes**: values written in SVG attributes such as `d` / `cx` /
 *      `stroke-dasharray` also have only 6 significant digits in computed styles, while **inline
 *      styles take precedence over attributes**; writing them in overwrites the full-precision
 *      original text on the clone (curves in growth-curve, stroke endpoints in ring-metric, paths
 *      in lottie). Attributes on SVG inner elements that are provided by their own attributes and
 *      not overridden by inline styles or animations are not inlined (`presentationProps`), and are
 *      still provided by those attributes during replay. This is the only exception to "(2) Layout
 *      used values are always inlined": `width` / `height` on SVG inner elements are not layout
 *      values.
 * All four only change what is written in snapshots without touching live render: whole-frame export
 * does not generate snapshots, so byte-for-byte baselines are unaffected.
 */

import {
  INHERITED_PROPS, LAYOUT_USED_VALUE_PROPS, LAYOUT_UNIT_PROPS, COMPOSITED_ANIMATION_PROPS, snapLayoutUnits, isRelevantAnimation,
  serializeTransformList,
} from "./snapshotStyleProps.mjs";

export const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
/** The line written at the end of every element: once injected, there must be no running clocks remaining */
export const STOP_CLOCKS = "animation:none !important;transition:none !important;";

type Baseline = Map<string, string>;
type BaselineSet = { themeKey: string; byTag: Map<string, Baseline> };

/**
 * Baseline cache is attached to the **scene root** (not global): other hosts may exist in the same
 * document, and theme is written on the scene root's inline `style` (`StageView.tsx` / `ExportView.tsx`
 * both spread `themeStyle(themeId)`), so that string is used as version number: re-measure whenever
 * theme changes (this is that `themeId` in the baseline specification).
 */
const baselineCache = new WeakMap<Element, BaselineSet>();

const tagKey = (ns: string, tag: string) => ns + "|" + tag;
const keyOf = (el: Element) => tagKey(el.namespaceURI || HTML_NS, el.tagName);
const isInherited = (prop: string) =>
  prop.charCodeAt(0) === 45 && prop.charCodeAt(1) === 45 ? true : INHERITED_PROPS.has(prop);

/** Wrapper layer? control snapshot = its innerHTML, so its direct children are top-level elements of the snapshot */
function isClipWrapper(el: Element | null): boolean {
  return !!el && el.hasAttribute("data-pc-clip") && el.hasAttribute("data-pc-local-frame") && !el.hasAttribute("data-pc-media");
}

/**
 * Wrapper layer of a card in a cut segment inside a nested scene (`data-pc-flat-clip`; `flatControls`
 * of `createSnapshot`, [ruling] R02). Its direct children are also top-level elements of the control
 * snapshot: control snapshots only take the inside of the wrapper layer, and during replay there are
 * no nested scene ancestor layers, so inherited properties (font, line-height, color...) must all be
 * inlined; otherwise replay reverts font to default and text positions become wrong. Unrecognized by
 * default (whole-scene snapshots and other callers remain unchanged byte-for-byte).
 */
function isFlatClipWrapper(el: Element | null): boolean {
  return !!el && el.hasAttribute("data-pc-flat-clip") && el.hasAttribute("data-pc-local-frame");
}

/**
 * Measure baseline: one clean element per (namespace, tag) mounted under scene root and measured once,
 * **mount once, read once, remove once** (do not repeatedly enter and exit live DOM in element loops:
 * each roundtrip is a forced reflow).
 *
 * - SVG elements are created with `createElementNS` and placed inside a real `<svg>`: `createElement`
 *   produces `HTMLUnknownElement`, where initial values of `fill` / `stroke` / `display` are all wrong
 *   (the five lottie cards and `growth-curve` are precisely SVG).
 * - The probe is enclosed entirely in a zero-size, absolutely positioned container moved outside the
 *   viewport to avoid distorting scene root layout.
 */
function ensureBaselines(root: Element, needed: Map<string, { ns: string; tag: string }>): Map<string, Baseline> {
  const themeKey = root.getAttribute("style") || "";
  let entry = baselineCache.get(root);
  if (!entry || entry.themeKey !== themeKey) {
    entry = { themeKey, byTag: new Map() };
    baselineCache.set(root, entry);
  }
  const missing: Array<[string, { ns: string; tag: string }]> = [];
  for (const item of needed) if (!entry.byTag.has(item[0])) missing.push(item);
  if (!missing.length) return entry.byTag;

  const holder = document.createElement("div");
  holder.setAttribute("data-pc-snapshot-baseline", "");
  holder.setAttribute("style", "position:absolute!important;left:-99999px!important;top:0!important;width:0!important;height:0!important;overflow:hidden!important;pointer-events:none!important;visibility:visible!important");
  const probes: Array<[string, Element]> = [];
  for (const [key, { ns, tag }] of missing) {
    let probe: Element | null = null;
    try {
      if (ns === SVG_NS) {
        const svg = document.createElementNS(SVG_NS, "svg");
        probe = tag.toLowerCase() === "svg" ? svg : document.createElementNS(SVG_NS, tag);
        if (probe !== svg) svg.appendChild(probe);
        holder.appendChild(svg);
      } else if (ns && ns !== HTML_NS) {
        probe = document.createElementNS(ns, tag);
        holder.appendChild(probe);
      } else {
        probe = document.createElement(tag);
        holder.appendChild(probe);
      }
    } catch {
      probe = null;   // If creation fails (strange tag names), there is no baseline: fully inline that category of elements, safe
    }
    if (probe) probes.push([key, probe]);
    else entry.byTag.set(key, new Map());
  }
  root.appendChild(holder);
  for (const [key, probe] of probes) {
    const cs = getComputedStyle(probe);
    const map: Baseline = new Map();
    for (let i = 0; i < cs.length; i++) {
      const prop = cs.item(i);
      map.set(prop, cs.getPropertyValue(prop));
    }
    entry.byTag.set(key, map);
  }
  holder.remove();
  return entry.byTag;
}

const DASH = /[A-Z]/g;
const dashed = (name: string) => (name.startsWith("--") ? name : name.replace(DASH, (c) => "-" + c.toLowerCase()));
const KEYFRAME_META = new Set(["offset", "computedOffset", "easing", "composite"]);

interface AnimatedProps {
  /** Properties overridden by animations / transitions: always force-inlined (item 2 of "Two required fallbacks" in file header) */
  written: Map<Element, Set<string>>;
  /**
   * Properties promoted to a separate layer by Chrome due to relevant animations (those in
   * `COMPOSITED_ANIMATION_PROPS`). Snapshots hardcode `animation:none`, so this layer disappears
   * in replay pages and must be supplemented as `will-change`, see `buildStyle`.
   */
  promoted: Map<Element, Set<string>>;
}

/**
 * Which properties of which elements are being overridden by animations / transitions. Single
 * `getAnimations` across the entire tree instead of querying per element (for cards with thousands
 * of nodes like lottie, querying per element would consume all style inlining time).
 */
function animatedProps(root: Element): AnimatedProps {
  const out: AnimatedProps = { written: new Map(), promoted: new Map() };
  let list: Animation[];
  try {
    list = root.getAnimations({ subtree: true });
  } catch {
    return out;
  }
  for (const anim of list) {
    const effect = anim.effect as KeyframeEffect | null;
    const target = effect && (effect as unknown as { target?: Element }).target;
    if (!target || typeof (effect as unknown as { getKeyframes?: unknown }).getKeyframes !== "function") continue;
    let set = out.written.get(target);
    if (!set) out.written.set(target, (set = new Set()));
    let frames: Keyframe[] = [];
    try {
      frames = effect!.getKeyframes();
    } catch { /* Some implementations throw on effects without keyframes */ }
    const names = new Set<string>();
    for (const frame of frames) for (const name in frame) if (!KEYFRAME_META.has(name)) names.add(dashed(name));
    for (const name of names) set.add(name);
    // Animations on pseudo-elements promote pseudo-element layers; inline styles cannot reach them, do not supplement
    if (effect!.pseudoElement || !isRelevantAnimation(effect!.getComputedTiming(), anim.playbackRate, anim.playState)) continue;
    for (const name of names) {
      if (!COMPOSITED_ANIMATION_PROPS.has(name)) continue;
      let promoted = out.promoted.get(target);
      if (!promoted) out.promoted.set(target, (promoted = new Set()));
      promoted.add(name);
    }
  }
  return out;
}

/** Element's own inline style properties + properties overridden by animation: both categories are always force-inlined, see file header */
function forcedProps(el: Element, animated: AnimatedProps): Set<string> | null {
  const inline = (el as HTMLElement).style;
  const fromAnim = animated.written.get(el);
  const count = inline ? inline.length : 0;
  if (!count && !fromAnim) return null;
  const out = fromAnim ? new Set(fromAnim) : new Set<string>();
  for (let i = 0; i < count; i++) out.add(inline.item(i));
  return out;
}

type BuiltStyle = { text: string; inherited: Record<string, string> | null };

/** SVG inner elements (parent is also SVG). Outermost `<svg>` is a CSS box itself and does not count */
const isSvgInner = (el: Element) => el.namespaceURI === SVG_NS && el.parentElement?.namespaceURI === SVG_NS;

/**
 * Whether geometry values of this element can be snapped to 1/64 px (`snapLayoutUnits`, specification
 * in `LAYOUT_UNIT_PROPS`). Only boxes laid out via CSS are on the LayoutUnit grid:
 *   - `width` / `height` of SVG inner elements are floating-point geometry; snapping would shift
 *     graphics, so do not snap; outermost `<svg>` is a CSS box itself and snaps as usual;
 *   - In subtrees where `zoom` is not 1, computed styles provide pre-zoom values where grid is no
 *     longer 1/64; keep as is.
 */
function onLayoutGrid(el: Element, cs: CSSStyleDeclaration, parentZoomed: boolean): { snap: boolean; zoomed: boolean } {
  const zoomed = parentZoomed || (cs.zoom !== "" && cs.zoom !== "1");
  return { snap: !zoomed && !isSvgInner(el), zoomed };
}

/**
 * Properties on SVG inner elements **provided by their own presentation attributes**: not inlined
 * (item 4 in file header).
 *
 * The clone carries these attributes as is, and the cascade at replay is identical to when
 * generating snapshots (see header of `snapshotStyleProps.mjs`), so omitting them still preserves
 * that value at full-precision original text from the attribute; writing them would instead
 * overwrite it with 6-significant-digit computed values. Properties written in the element's own
 * inline style or overridden by animations / transitions (`forced`) are not included: values for
 * those two categories do not come from attributes and are force-inlined as before.
 *
 * Collected by attribute name: SVG presentation attributes share names with CSS properties.
 * Collected names that are not CSS properties (`class`, `id`, `offset`...) never match property
 * names from `getComputedStyle` and have no effect; properties that are CSS properties but not
 * presentation attributes on this element (`x` on `<text>`) have computed values equal to initial
 * values, which match the baseline anyway and won't be written.
 */
function presentationProps(el: Element, forced: Set<string> | null): Set<string> | null {
  if (!el.attributes.length || !isSvgInner(el)) return null;
  let out: Set<string> | null = null;
  for (const attr of el.attributes) {
    if (forced && forced.has(attr.name)) continue;
    (out ??= new Set()).add(attr.name);
  }
  return out;
}

/**
 * Write back transforms by Typed OM components (item 3 in the file header,
 * `serializeTransformList`); if unavailable, return null and fall back to the computed value.
 * Only call on elements whose computed value is not `none`: `computedStyleMap()` creates a new
 * map every time.
 */
function exactTransform(el: Element): string | null {
  let value: CSSStyleValue | undefined;
  try {
    value = el.computedStyleMap().get("transform");
  } catch {
    return null;
  }
  return value instanceof CSSTransformValue ? serializeTransformList(value) : null;
}

/**
 * Assemble an element's style string according to three criteria categories, while retaining
 * its own inherited property values for comparison by child elements.
 *
 * The returned `inherited` **directly reuses the parent element's object** when "none changed",
 * without creating a new one: a lottie card has thousands of elements, and storing a record of
 * over a hundred entries for each element would exhaust memory.
 *
 * Four other places do not "copy computed values verbatim" (all to make replay byte-for-byte
 * identical to live render; see file header):
 *   - `snap`: snap px values in `LAYOUT_UNIT_PROPS` back to the 1/64 grid, recovering the
 *     fraction lost to 6 significant digits;
 *   - `transform`: write back at full precision by Typed OM components (`exactTransform`);
 *     only use computed values if unreadable;
 *   - `fromAttr`: do not write properties given by an SVG inner element's own attributes
 *     (`presentationProps`), while still recording inherited properties into the copy used for
 *     child comparisons;
 *   - `promote`: add a `will-change` declaration for elements with relevant animations to reclaim
 *     the composited layer from live render. If the element already specified `will-change`,
 *     merge into one rather than adding a new one that overrides it.
 */
function buildStyle(
  el: Element,
  cs: CSSStyleDeclaration,
  isTop: boolean,
  parentInherited: Record<string, string> | null,
  forced: Set<string> | null,
  baseline: Baseline | undefined,
  snap: boolean,
  promote: Set<string> | undefined,
  fromAttr: Set<string> | null,
): BuiltStyle {
  const compareParent = !isTop && parentInherited;
  let inherited: Record<string, string> | null = compareParent ? parentInherited : null;
  let own: Record<string, string> | null = null;
  const ensureOwn = () => {
    if (!own) {
      own = compareParent ? Object.assign(Object.create(null), parentInherited) : Object.create(null);
      inherited = own;
    }
    return own!;
  };
  // X6: first collect into "property name → value", then sort by property name at the end
  // before assembling (`serializeDeclarations`), instead of writing in the browser's
  // enumeration order
  const decls: Array<[string, string]> = [];
  for (let k = 0; k < cs.length; k++) {
    const prop = cs.item(k);
    if (promote && prop === "will-change") continue;   // Written merged after the loop
    let value = snap && LAYOUT_UNIT_PROPS.has(prop) ? snapLayoutUnits(cs.getPropertyValue(prop)) : cs.getPropertyValue(prop);
    if (fromAttr && fromAttr.has(prop)) {
      // SVG presentation attributes: do not write; provided by cloned attributes during replay.
      // Inherited property values are still retained for child comparisons
      if (isInherited(prop) && !(compareParent && parentInherited![prop] === value)) ensureOwn()[prop] = value;
      continue;
    }
    if (prop === "transform" && value !== "none") value = exactTransform(el) ?? value;
    if (isInherited(prop)) {
      // ① Inherited properties: compare against the parent element's computed value. Top-level
      // elements have no trusted parent element, so always inline them.
      if (compareParent && parentInherited![prop] === value && !(forced && forced.has(prop))) continue;
      decls.push([prop, value]);
      ensureOwn()[prop] = value;
      continue;
    }
    // ② Layout resolved values are inlined in full as before; the two forced-inlining fallback
    // categories follow the same rule
    if (LAYOUT_USED_VALUE_PROPS.has(prop) || (forced && forced.has(prop))) { decls.push([prop, value]); continue; }
    // ③ Remaining non-inherited properties are compared against the same-tag baseline
    if (!baseline || baseline.get(prop) !== value) decls.push([prop, value]);
  }
  if (promote) {
    const own = cs.getPropertyValue("will-change");
    const list = own && own !== "auto" ? own.split(",").map((s) => s.trim()) : [];
    for (const prop of promote) if (!list.includes(prop)) list.push(prop);
    decls.push(["will-change", list.join(", ")]);
  }
  return { text: serializeDeclarations(decls), inherited };
}

/**
 * X6(`docs/plan/m6c-contract.md`): declarations are assembled into a style string in a
 * deterministic order by **property name**.
 *
 * The enumeration order of `getComputedStyle` is determined by the browser. Content-independent
 * factors (such as the order of the custom property `--*` section) can cause two processes to
 * assemble byte-differing snapshots for the same content; mismatched chunk hashes then defeat
 * cross-node deduplication and reuse.
 *
 * The order is "split into three groups first, then by name within each group": unprefixed
 * standard properties, vendor-prefixed properties like `-webkit-`, and custom properties `--*`.
 * Grouping avoids altering the cascade: Chrome 152 testing (section X6 of this branch report)
 * shows its own enumeration consists of three segments: "standard properties alphabetically,
 * prefixed properties alphabetically, custom properties", and within the same block of
 * declarations, several pairs follow "the latter wins": the shorthand `mask-position` expands to
 * `-webkit-mask-position-x/y`, and `writing-mode` versus `-webkit-writing-mode` are two names for
 * the same value. Sorting the entire string by name would move prefixed properties before standard
 * properties, reversing the relative order of these pairs; sorting by group keeps the original
 * Chrome ordering, and only determines the order of the custom properties segment (as well as the
 * single merged `will-change` declaration).
 *
 * Comparison uses UTF-16 code unit order (`<`), not `localeCompare`: the latter varies by locale,
 * which is precisely the non-determinism to eliminate. Sorts the caller's array (in place).
 */
const declGroup = (name: string) => (name.charCodeAt(0) !== 45 ? 0 : name.charCodeAt(1) === 45 ? 2 : 1);
export function serializeDeclarations(decls: Array<[string, string]>): string {
  decls.sort((a, b) => declGroup(a[0]) - declGroup(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let text = "";
  for (const [prop, value] of decls) text += prop + ":" + value + ";";
  return text;
}

export interface InlineStylesResult {
  /**
   * Recompute a live element's style string against the baseline of **another tag** (including
   * `STOP_CLOCKS` at the end).
   * Used by `rasterizeCanvas`: after canvas is replaced with `<img>`, IMG-specific `overflow: clip` /
   * replaced element default sizing rules differ from CANVAS, so reusing the diff string from CANVAS
   * would miss properties.
   * Any tag to be used must first be written into `extraBaselineTags` of `inlineDOMStyles`;
   * otherwise, with no baseline here, it degrades to full inlining (only adds a few bytes, will not
   * render incorrectly).
   */
  styleAs(el: Element, tag: string, ns?: string): string;
}

/**
 * Write diff styles into the clone element by element.
 *
 * @param root  Live scene root (`[data-pc-scene]`). Baseline probe is mounted under it.
 * @param orig  Array of live elements, `[root, ...root.querySelectorAll('*')]`
 * @param copy  Array of clone elements in 1:1 correspondence with `orig`
 * @param extraBaselineTags  Which baselines to warm up in addition to tags in the tree (HTML namespace)
 */
export function inlineDOMStyles(
  root: Element,
  orig: Element[],
  copy: Element[],
  extraBaselineTags: string[] = [],
  opts: { flatWrappers?: boolean } = {},
): InlineStylesResult {
  const wrapperOf = opts.flatWrappers ? (el: Element | null) => isClipWrapper(el) || isFlatClipWrapper(el) : isClipWrapper;
  const needed = new Map<string, { ns: string; tag: string }>();
  for (const el of orig) {
    const key = keyOf(el);
    if (!needed.has(key)) needed.set(key, { ns: el.namespaceURI || HTML_NS, tag: el.tagName });
  }
  for (const tag of extraBaselineTags) needed.set(tagKey(HTML_NS, tag), { ns: HTML_NS, tag });
  const baselines = ensureBaselines(root, needed);
  const animated = animatedProps(root);

  const inheritedOf = new Map<Element, Record<string, string> | null>();
  const topOf = new Map<Element, boolean>();
  const zoomedOf = new Map<Element, boolean>();
  const snapOf = new Map<Element, boolean>();
  for (let i = 0; i < orig.length; i++) {
    const from = orig[i];
    const cs = getComputedStyle(from);
    const parent = from.parentElement;
    // Top-level = scene root of the whole scene HTML, or a direct child node of the wrapper layer
    // in a control snapshot
    const isTop = from === root || wrapperOf(parent);
    const parentInherited = isTop || !parent ? null : inheritedOf.get(parent) ?? null;
    const grid = onLayoutGrid(from, cs, !!parent && (zoomedOf.get(parent) ?? false));
    const forced = forcedProps(from, animated);
    const built = buildStyle(from, cs, isTop, parentInherited, forced, baselines.get(keyOf(from)),
      grid.snap, animated.promoted.get(from), isTop ? null : presentationProps(from, forced));
    inheritedOf.set(from, built.inherited);
    topOf.set(from, isTop);
    zoomedOf.set(from, grid.zoomed);
    snapOf.set(from, grid.snap);
    copy[i].setAttribute("style", built.text + STOP_CLOCKS);
  }

  return {
    styleAs(el, tag, ns = HTML_NS) {
      const parent = el.parentElement;
      const isTop = topOf.get(el) ?? (el === root || wrapperOf(parent));
      const parentInherited = isTop || !parent ? null : inheritedOf.get(parent) ?? null;
      const cs = getComputedStyle(el);
      const snap = snapOf.get(el) ?? onLayoutGrid(el, cs, !!parent && (zoomedOf.get(parent) ?? false)).snap;
      // What was swapped in is an HTML element (canvas → img); SVG presentation attributes do not apply
      const built = buildStyle(el, cs, isTop, parentInherited, forcedProps(el, animated), baselines.get(tagKey(ns, tag)),
        snap, animated.promoted.get(el), null);
      return built.text + STOP_CLOCKS;
    },
  };
}

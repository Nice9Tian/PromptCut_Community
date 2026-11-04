/**
 * Property tables and pure functions for diff style inlining (used by `inlineDOMStyles` in
 * `snapshot/inlineStyles.ts`). The first two tables (inherited / layout resolved values)
 * determine **which properties to omit**, see below; the subsequent `LAYOUT_UNIT_PROPS` /
 * `snapLayoutUnits` / `serializeTransformList` / `COMPOSITED_ANIMATION_PROPS` /
 * `isRelevantAnimation` determine **how values must be written so replay is byte-for-byte
 * identical to live render**, each with sources cited in their respective comments.
 *
 * Standalone file for two reasons:
 *   1. It is **pure data and pure functions**, directly imported by
 *      `server/test/snapshot-style-props.test.mjs` for reconciliation (`npm test` runs
 *      `node --test` and cannot enter `.ts`);
 *   2. Changing any item here is equivalent to modifying snapshot content, so `SNAPSHOT_FILES` in
 *      `server/frame-code.mjs` includes this file: modifying it alters `snapshotCode` and
 *      invalidates old snapshots.
 *
 * # Three categories of properties (draft A2(8))
 *
 * `inlineDOMStyles` inlines only properties for each element whose omission would alter replay,
 * categorized by three criteria:
 *
 *   ① **Inherited properties** (`INHERITED_PROPS` in this file, plus all `--*` custom properties):
 *      compared against the **parent element's computed value**, omitted only when equal.
 *      **Cannot be compared against the same-tag baseline**: if an inherited property value
 *      happens to match the baseline but differs from the parent value, omitting it causes replay
 *      to inherit the parent value, producing an incorrect visual. Top-level elements of snapshots
 *      (the scene root of whole-scene HTML, direct children of the wrapper layer in control) are
 *      always inlined in full: during replay, their parent element is a different tree, and
 *      inherited values are outside our control.
 *
 *   ② **Layout resolved value properties** (`LAYOUT_USED_VALUE_PROPS`): always inlined in full as
 *      before, excluded from omission. `getComputedStyle` returns **used values** (`width: auto`
 *      measures as `823.5px`), and coincidental equality with the baseline does not guarantee
 *      equality after reflow during replay.
 *
 *   ③ Remaining non-inherited properties are compared against the **same-tag baseline** (baseline
 *      = computed style measured from a clean element with matching `namespaceURI` + `tagName`
 *      mounted under the scene root of the same snapshot page = UA default + theme global styles).
 *
 * # Why errors in these two tables **will not render incorrectly** (only affecting size)
 *
 * The replay page loads the same bundle and theme styles, and element classes/attributes are cloned
 * verbatim, so **cascade at replay = cascade at snapshot generation**, with only two differences:
 * we replaced the element's own `style` attribute, and hardcoded `animation:none / transition:none`.
 * `inlineDOMStyles` provides a fallback for each of these two issues (forcing inlining of
 * "properties written in the element's own inline style" and "properties mutated by
 * animations/transitions").
 * Besides this:
 *   - Genuine inherited property misclassified as non-inherited → compared against baseline,
 *     omitted only when equal; after omission, replay inherits from parent, whose computed value is
 *     guaranteed unchanged by the level above, thus still obtaining original value: safe;
 *   - Genuine non-inherited property misclassified as inherited → compared against parent value,
 *     omitted only when equal; after omission, replay follows the cascade, which remains identical
 *     to snapshot generation: safe.
 * The only truly critical rule is **inlining top-level elements in full** (their parent element
 * is replaced during replay). Therefore, these two tables err on the side of being overly broad:
 * broader tables only add a few bytes, whereas narrower tables merely omit less.
 */

/**
 * Inherited properties. The list is based on Chrome testing:
 * `scripts/probes/inherited-props-probe.mjs` uses two clean parent-child element layers to verify
 * property by property "whether child follows when parent sets a non-initial value", and
 * `server/test/snapshot-style-props.test.mjs` reconciles against the probe output.
 * In addition, all `--*` custom properties (inherited by default) are evaluated separately by
 * `isInheritedProp` rather than listed in this table.
 */
export const INHERITED_PROPS = new Set([
  // Color and font
  'color', 'caret-color', 'accent-color', 'color-scheme',
  'font-family', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style', 'font-weight',
  'font-feature-settings', 'font-kerning', 'font-language-override', 'font-optical-sizing',
  'font-palette', 'font-synthesis-small-caps', 'font-synthesis-style', 'font-synthesis-weight',
  'font-variant', 'font-variant-alternates', 'font-variant-caps', 'font-variant-east-asian',
  'font-variant-emoji', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-position',
  'font-variation-settings', '-webkit-font-smoothing', '-webkit-locale',
  // Typography
  'letter-spacing', 'line-height', 'word-spacing', 'text-align', 'text-align-last',
  'text-indent', 'text-transform', 'text-shadow', 'text-rendering', 'text-size-adjust',
  '-webkit-text-size-adjust', 'text-justify',
  'text-underline-position', 'text-underline-offset', 'text-decoration-skip-ink',
  'text-emphasis-color', 'text-emphasis-position', 'text-emphasis-style',
  '-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-text-stroke-width',
  'white-space', 'white-space-collapse', 'text-wrap', 'text-wrap-mode', 'text-wrap-style',
  'word-break', 'line-break', 'overflow-wrap', 'word-wrap',
  'hyphens', 'hyphenate-character', 'hyphenate-limit-chars',
  'tab-size', 'orphans', 'widows', 'quotes',
  'direction', 'writing-mode', 'text-orientation', 'text-combine-upright', 'unicode-bidi',
  'ruby-align', 'ruby-position',
  // Interaction and presentation
  'visibility', 'cursor', 'pointer-events', 'image-rendering', 'image-orientation',
  'print-color-adjust', 'forced-color-adjust', 'scrollbar-color',
  'caret-animation', 'caret-shape', 'math-depth', 'ruby-overhang', 'speak', 'app-region',
  '-webkit-text-security', '-webkit-writing-mode',
  'list-style-image', 'list-style-position', 'list-style-type',
  'border-collapse', 'border-spacing', 'caption-side', 'empty-cells',
  '-webkit-border-horizontal-spacing', '-webkit-border-vertical-spacing',
  '-webkit-tap-highlight-color', '-webkit-user-select', 'user-select',
  // SVG
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-opacity', 'stroke-width',
  'marker-start', 'marker-mid', 'marker-end', 'paint-order',
  'text-anchor', 'dominant-baseline', 'shape-rendering', 'clip-rule',
  'color-interpolation', 'color-interpolation-filters', 'color-rendering', 'glyph-orientation-vertical',
]);

/**
 * Layout resolved value properties: `getComputedStyle` returns **used values**, inlined as before
 * without exception. The group named in task brief A2(8), plus `inline-size` / `block-size`
 * (in Chrome's computed styles, they are used values just like `width` / `height`; omitting them
 * causes errors when writing mode is not horizontal-tb).
 */
export const LAYOUT_USED_VALUE_PROPS = new Set([
  'width', 'height', 'inline-size', 'block-size',
  'top', 'right', 'bottom', 'left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'transform', 'transform-origin', 'perspective-origin',
  'grid-template-rows', 'grid-template-columns',
]);

/**
 * Those among layout resolved values that **fall on the LayoutUnit grid**: `inlineDOMStyles` snaps
 * px numbers back to the 1/64 grid before writing into snapshots (`snapLayoutUnits`).
 *
 * Chrome layout uses LayoutUnit (1/64 px fixed-point numbers), so used values of these properties
 * are always n/64; but `getComputedStyle` serializes to **6 significant digits** (`316.15625px` →
 * `316.156px`), and during replay Chrome **truncates** 316.156 × 64 = 20233.98 to 20233, which is
 * 1/64 px less than original value. Hard-edged elements show no visible difference, but
 * `filter: blur()` can differ by dozens of levels as a result
 * (`docs/archive/restructure_planning/reports/replay-mismatch-report.md` §6).
 *
 * Why snapping back is guaranteed to restore the original value: within 10000 px, the rounding
 * error of 6 significant digits is ≤ 0.005 px, which is less than half a grid cell (1/128 ≈ 0.0078
 * px), so the nearest grid cell can only be the original value; and the decimal representation of
 * n/64 is a terminating decimal (at most 6 decimal places), written out verbatim so nothing is lost
 * again on replay. Values exceeding 10000 px are snapped to the nearest cell, which is still no
 * worse than truncation.
 *
 * Includes logical property forms (`inset-*` / `margin-block-*` …) beyond
 * `LAYOUT_USED_VALUE_PROPS`: they map to the same values as physical properties, and both forms
 * appear in snapshots; snapping only one side would allow the later-written rule to overwrite the
 * snapped one. Does not include `transform` / `transform-origin` / `perspective-origin`: these are
 * floating-point numbers not on the grid, and snapping to 1/64 would undesirably alter values.
 * Precision for `transform` is handled separately; see `serializeTransformList`.
 */
export const LAYOUT_UNIT_PROPS = new Set([
  'width', 'height', 'inline-size', 'block-size',
  'top', 'right', 'bottom', 'left',
  'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'margin-block-start', 'margin-block-end', 'margin-inline-start', 'margin-inline-end',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-block-start', 'padding-block-end', 'padding-inline-start', 'padding-inline-end',
  'grid-template-rows', 'grid-template-columns',
]);

const PX_NUMBER = /(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)px/gi;

/**
 * Snaps every `<number>px` in a computed style value to the nearest 1/64 px, leaving the rest unchanged.
 * `'316.156px'` → `'316.15625px'`, `'105.5px 210.656px'` → `'105.5px 210.65625px'`, `'auto'` unchanged.
 */
export function snapLayoutUnits(value) {
  // Integer px (vast majority: `0px`, `320px`) is already on the grid, skip regex:
  // a lottie card has thousands of elements × dozens of properties
  if (!value.includes('.')) return value;
  return value.replace(PX_NUMBER, (_, n) => {
    const snapped = Math.round(Number(n) * 64) / 64;
    return (snapped === 0 ? 0 : snapped) + 'px';   // Write -0 as 0 while we're at it
  });
}

/**
 * Writes the computed transform read from Typed OM (`el.computedStyleMap().get('transform')`, a
 * `CSSTransformValue`) back component by component into `transform` text: **function form
 * preserved, numbers at full precision**. If any component or number is unrecognized, returns
 * `null`, and the caller falls back to the `getComputedStyle` matrix.
 *
 * Why not use the `getComputedStyle` matrix (`replay-mismatch-report.md` §13):
 *   - It rounds numbers to **6 significant digits**. A 4-digit displacement is left with only two
 *     decimal places: the odometer roller's real displacement is `-2156.501953125px`; writing it
 *     as `-2156.5` lands right on the other side of the pixel rounding boundary, shifting the whole
 *     glyph off by one slot (3139 channels, max 233); cos / sin of 3D rotations are lost down to
 *     1e-6 (terminal-3d); a nearly stopped spring `scale(1.00047…)` suffers the same (versus-card,
 *     punch-pill).
 *   - It collapses the entire transform chain **into a single matrix**: `rotate(-90deg)` becomes
 *     `matrix(6.12323e-17, -1, 1, 6.12323e-17, 0, 0)`, and the leftover 1e-17 makes it no longer
 *     an axis-aligned transform; `translateZ(0)` collapses into a 2D identity matrix, losing that
 *     compositing layer. Writing back the original functions lets Chrome use the exact same
 *     algorithm during replay as in live render.
 *
 * Values are taken directly from the number stored in Blink's computed values (the odometer's
 * `-2156.501953125` is precisely the value of length stored as a float), written back as-is via
 * `String(n)`;
 * Percentages are kept as-is: during replay, they are re-resolved against the same reference box
 * (with inlined dimensions), matching live render.
 * Dispatch is based on constructor name (`CSSTranslate` …); unit tests use classes with the same
 * names to create objects of the same shape.
 */
export function serializeTransformList(list) {
  const parts = [];
  for (const component of list) {
    const text = transformComponentText(component);
    if (text === null) return null;
    parts.push(text);
  }
  return parts.length ? parts.join(' ') : null;
}

/** `CSSUnitValue` → `12.5px` / `-50%` / `0.8`; returns null if not a single number (`calc()`, keywords) */
function unitText(v) {
  if (!v || typeof v.value !== 'number' || typeof v.unit !== 'string' || !Number.isFinite(v.value)) return null;
  const unit = v.unit === 'number' ? '' : v.unit === 'percent' ? '%' : v.unit;
  return String(v.value) + unit;
}

function argsText(...values) {
  const out = values.map(unitText);
  return out.includes(null) ? null : out.join(', ');
}

/** Writes 3D rotations around axes back to rotateX / rotateY / rotateZ, matching common source code */
function rotateText(c) {
  if (c.is2D) {
    const a = argsText(c.angle);
    return a && `rotate(${a})`;
  }
  const axis = [c.x, c.y, c.z].map((v) => (v && typeof v.value === 'number' ? v.value : NaN));
  const angle = argsText(c.angle);
  if (angle === null) return null;
  if (axis[0] === 1 && axis[1] === 0 && axis[2] === 0) return `rotateX(${angle})`;
  if (axis[0] === 0 && axis[1] === 1 && axis[2] === 0) return `rotateY(${angle})`;
  if (axis[0] === 0 && axis[1] === 0 && axis[2] === 1) return `rotateZ(${angle})`;
  const a = argsText(c.x, c.y, c.z, c.angle);
  return a && `rotate3d(${a})`;
}

function matrixText(m) {
  if (!m) return null;
  const values = m.is2D
    ? [m.a, m.b, m.c, m.d, m.e, m.f]
    : [m.m11, m.m12, m.m13, m.m14, m.m21, m.m22, m.m23, m.m24, m.m31, m.m32, m.m33, m.m34, m.m41, m.m42, m.m43, m.m44];
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return `${m.is2D ? 'matrix' : 'matrix3d'}(${values.map(String).join(', ')})`;
}

function transformComponentText(c) {
  let a;
  switch (c && c.constructor && c.constructor.name) {
    case 'CSSTranslate':
      a = c.is2D ? argsText(c.x, c.y) : argsText(c.x, c.y, c.z);
      return a && `${c.is2D ? 'translate' : 'translate3d'}(${a})`;
    case 'CSSScale':
      a = c.is2D ? argsText(c.x, c.y) : argsText(c.x, c.y, c.z);
      return a && `${c.is2D ? 'scale' : 'scale3d'}(${a})`;
    case 'CSSRotate':
      return rotateText(c);
    case 'CSSSkew':
      a = argsText(c.ax, c.ay);
      return a && `skew(${a})`;
    case 'CSSSkewX':
      a = argsText(c.ax);
      return a && `skewX(${a})`;
    case 'CSSSkewY':
      a = argsText(c.ay);
      return a && `skewY(${a})`;
    case 'CSSPerspective':
      a = argsText(c.length);
      return a && `perspective(${a})`;
    case 'CSSMatrixComponent':
      return matrixText(c.matrix);
    default:
      return null;
  }
}

/**
 * Properties whose current animations cause Chrome to **promote a separate compositing layer**
 * (Blink's compositing reasons: `ActiveOpacityAnimation` / `ActiveTransformAnimation` /
 * `ActiveFilterAnimation` / `ActiveBackdropFilterAnimation`, with `translate` / `rotate` / `scale`
 * grouped under transforms).
 *
 * Snapshots hardcode `animation:none`; with no animations on the replay page, this layer is lost:
 * the element is instead drawn into the parent layer, and `filter: blur()` takes a different
 * rasterization path, differing from live render by over a hundred levels (on the same punch-pill,
 * the glow layer's `LayerTree.compositingReasons` in live render was measured to be
 * `ActiveOpacityAnimation`). Therefore, `inlineDOMStyles` adds `will-change: <these properties>` to
 * elements that "currently have relevant animations modifying these properties"
 * (`isRelevantAnimation`): it is the only way in CSS to get the same compositing layer in the
 * absence of animations.
 */
export const COMPOSITED_ANIMATION_PROPS = new Set([
  'opacity', 'transform', 'translate', 'rotate', 'scale', 'filter', 'backdrop-filter',
]);

/**
 * Whether an animation is currently **relevant** (current or in effect) as defined by Web Animations:
 * this is Blink's criterion for the compositing reasons above, **not just current**.
 *
 * Measured on Chrome 152 on 2026-09-23 (`replay-mismatch-report.md` §13.5, pausing an opacity
 * animation with delay 400 / duration 800 at various points and reading
 * `LayerTree.compositingReasons`):
 *
 * | fill | In delay | Active interval | At end | After end |
 * |---|---|---|---|---|
 * | `both` | Promoted | Promoted | Promoted | Promoted (also after `finish()`) |
 * | `forwards` | Promoted | — | — | Promoted |
 * | `backwards` | Promoted | — | — | Not promoted |
 * | `none` | Promoted | Promoted | Not promoted | Not promoted |
 *
 * Judging solely by current (the second-round implementation) misses the case of "finished
 * playing and staying in the final state via `fill`": at frame 12 of stat-proof, an animation with
 * `delay 0.4 + duration 0.8` is pinned at 1200 ms by `__pcSyncAnims` (in JS,
 * `1200 < 1200.0000000000002`, so not `finish()`ed), yet `localTime` reads back equal to
 * `endTime`, which is after the end according to the spec; Blink promotes the layer regardless.
 *
 * in effect simply means `getComputedTiming().progress` is not null. Pure function, does not touch
 * DOM, easy to unit test in Node. Parameters are taken from `effect.getComputedTiming()` (in
 * milliseconds), `animation.playbackRate`, and `animation.playState`.
 */
export function isRelevantAnimation(timing, playbackRate, playState) {
  return timing.progress != null || isCurrentAnimation(timing, playbackRate, playState);
}

/**
 * Whether an animation is currently **current** as defined by Web Animations (half of
 * `isRelevantAnimation`). current =
 *   - In the active interval and not yet finished (paused animations count: animations pinned by
 *     `__pcSyncAnims` are all paused);
 *   - Or playing forwards and still before the start (in delay);
 *   - Or playing backwards and still after the end.
 * Interval boundaries follow the spec: which interval the two boundary points `before-active` /
 * `active-after` belong to depends on playback direction.
 */
export function isCurrentAnimation(timing, playbackRate, playState) {
  if (timing.localTime == null) return false;
  const local = Number(timing.localTime), end = Number(timing.endTime), delay = Number(timing.delay ?? 0);
  const beforeActive = Math.max(Math.min(delay, end), 0);
  const activeAfter = Math.max(Math.min(delay + Number(timing.activeDuration), end), 0);
  if (local < beforeActive || (playbackRate < 0 && local === beforeActive)) return playbackRate > 0;
  if (local > activeAfter || (playbackRate >= 0 && local === activeAfter)) return playbackRate < 0;
  return playState !== 'finished';
}

/** `--*` custom properties inherit by default; not stored in table, checked by prefix */
export function isInheritedProp(prop) {
  return prop.charCodeAt(0) === 45 && prop.charCodeAt(1) === 45 ? true : INHERITED_PROPS.has(prop);
}

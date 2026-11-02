/**
 * Property table reconciliation for differential style inlining (draft A2(8)) (task brief: "The
 * manifest is based on Chrome actual measurements: verify property by property with two clean
 * parent-child layers 'whether the child follows when parent sets a non-initial value', and fail
 * if it does not match the manifest").
 *
 * That actual measurement step runs in `scripts/probes/inherited-props-probe.mjs` (requires real
 * Chrome; `npm test` has no DOM and should not launch a browser in unit tests). What is reconciled
 * here is **the results produced from that pass**:
 * The two tables below are raw text run on Chrome 152 on 2026-09-19 (`inherited` / `notInherited`
 * in `out/inherited-props.json`, with layout resolved value properties excluded: setting width on
 * parent element causes block-level child's **used value** to change with it; that is layout, not
 * inheritance).
 *
 * Anyone modifying `INHERITED_PROPS` must either keep it satisfying these two conditions, or rerun
 * the probe and replace both tables here together.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INHERITED_PROPS, LAYOUT_USED_VALUE_PROPS, LAYOUT_UNIT_PROPS, COMPOSITED_ANIMATION_PROPS,
  isInheritedProp, snapLayoutUnits, isCurrentAnimation, isRelevantAnimation, serializeTransformList,
} from '../../src/render/snapshot/snapshotStyleProps.mjs';

/** Chrome 152 measured "truly inherited" properties (excluding width / inline-size out of 103) */
const CHROME_INHERITED = [
  '-webkit-border-horizontal-spacing', '-webkit-border-vertical-spacing', '-webkit-font-smoothing',
  '-webkit-locale', '-webkit-tap-highlight-color', '-webkit-text-fill-color', '-webkit-text-security',
  '-webkit-text-stroke-color', '-webkit-text-stroke-width', '-webkit-writing-mode', 'accent-color',
  'app-region', 'border-collapse', 'caret-animation', 'caret-color', 'caret-shape', 'clip-rule', 'color',
  'color-interpolation', 'color-interpolation-filters', 'color-rendering', 'color-scheme', 'cursor',
  'direction', 'dominant-baseline', 'fill', 'fill-opacity', 'fill-rule', 'font-family', 'font-kerning',
  'font-optical-sizing', 'font-palette', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style',
  'font-synthesis-small-caps', 'font-synthesis-style', 'font-synthesis-weight', 'font-variant',
  'font-variant-caps', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-position',
  'font-weight', 'forced-color-adjust', 'hyphenate-character', 'hyphenate-limit-chars', 'hyphens',
  'image-orientation', 'letter-spacing', 'line-break', 'line-height', 'list-style-image', 'list-style-type',
  'marker-end', 'marker-mid', 'marker-start', 'math-depth', 'orphans', 'overflow-wrap', 'paint-order',
  'pointer-events', 'quotes', 'ruby-align', 'ruby-overhang', 'ruby-position', 'shape-rendering', 'speak',
  'stroke', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-opacity', 'stroke-width', 'tab-size', 'text-align', 'text-align-last', 'text-anchor',
  'text-decoration-skip-ink', 'text-emphasis-color', 'text-emphasis-position', 'text-emphasis-style',
  'text-indent', 'text-justify', 'text-rendering', 'text-shadow', 'text-size-adjust', 'text-transform',
  'text-underline-offset', 'text-underline-position', 'text-wrap-mode', 'text-wrap-style', 'user-select',
  'visibility', 'widows', 'word-break', 'word-spacing', 'writing-mode',
];

/**
 * Properties in the same pass that "truly do not inherit". Only categories prone to being
 * mistakenly written into the table are kept here as a reverse check.
 */
const CHROME_NOT_INHERITED = [
  'align-items', 'animation-name', 'appearance', 'backdrop-filter', 'background-color', 'background-image',
  'border-bottom-color', 'border-bottom-style', 'border-top-left-radius', 'box-shadow', 'clip-path',
  'column-gap', 'content', 'display', 'filter', 'flex-grow', 'float', 'justify-content', 'mask-image',
  'max-height', 'max-width', 'min-height', 'min-width', 'object-fit', 'object-position', 'opacity', 'order',
  'outline-color', 'outline-style', 'outline-width', 'overflow-x', 'overflow-y', 'perspective',
  'row-gap', 'scale', 'scrollbar-gutter', 'scrollbar-width', 'stop-color', 'stop-opacity',
  'text-decoration-color', 'text-decoration-thickness', 'touch-action', 'transition-property', 'translate',
  'vertical-align', 'view-transition-name', 'will-change', 'z-index', 'zoom',
];

test('No entry in the table is one that Chrome measures as "not inherited"', () => {
  const wrong = CHROME_NOT_INHERITED.filter((p) => INHERITED_PROPS.has(p));
  assert.deepEqual(wrong, [], `Chrome says these properties are not inherited; putting them in INHERITED_PROPS would compare them with the parent value: ${wrong.join(', ')}`);
});

test('No property that Chrome measures as inherited is missing: if one is missing, the top-level element misses inlining', () => {
  const missing = CHROME_INHERITED.filter((p) => !INHERITED_PROPS.has(p));
  assert.deepEqual(missing, [], `The snapshot top-level element uses this table to decide which inherited properties to inline; if one is missing, on replay it will inherit from someone else: ${missing.join(', ')}`);
});

test('The two tables do not overlap: layout-resolved-value properties are always fully inlined, and must not also be judged as inherited properties', () => {
  const both = [...LAYOUT_USED_VALUE_PROPS].filter((p) => INHERITED_PROPS.has(p));
  assert.deepEqual(both, []);
});

test('The table has no shorthands, no uppercase, no duplicates', () => {
  const list = [...INHERITED_PROPS];
  assert.equal(new Set(list).size, list.length);
  for (const prop of list) assert.equal(prop, prop.toLowerCase(), `${prop} must be written in the lowercase hyphenated form that getComputedStyle gives`);
  // Common shorthands are never written into the table: getComputedStyle enumerates longhands;
  // shorthands will never match
  for (const shorthand of ['font', 'list-style', 'text-emphasis', 'border', 'margin', 'padding', 'background'])
    assert.equal(INHERITED_PROPS.has(shorthand), false, `${shorthand} is a shorthand`);
});

test('Custom properties are treated as inherited', () => {
  assert.equal(isInheritedProp('--pc-accent'), true);
  assert.equal(isInheritedProp('color'), true);
  assert.equal(isInheritedProp('display'), false);
});

/*
 * The items below reconcile those places where "replay equals live render byte-for-byte"
 * (docs/archive/restructure_planning/reports/replay-mismatch-report.md Round 2 §12, Round 3 §13):
 * geometry aligned to 1/64 px, adding will-change for composite layers kept alive by animations,
 * and writing back transforms at full precision.
 */

test('1/64 alignment: the bit lost by 6 significant digits is restored to the original value', () => {
  // Three measured widths: 316.15625 / 484.65625 / 381.3125, getComputedStyle gives 316.156 /
  // 484.656 / 381.312 respectively
  assert.equal(snapLayoutUnits('316.156px'), '316.15625px');
  assert.equal(snapLayoutUnits('484.656px'), '484.65625px');
  assert.equal(snapLayoutUnits('381.312px'), '381.3125px');
  // Those already on the grid are left untouched
  assert.equal(snapLayoutUnits('352.125px'), '352.125px');
  assert.equal(snapLayoutUnits('0px'), '0px');
  assert.equal(snapLayoutUnits('-16.0625px'), '-16.0625px');
});

test('1/64 alignment: within 10000 px every step can be recovered from 6 significant digits', () => {
  const sig6 = (v) => String(Number(v.toPrecision(6)));
  for (let n = 0; n < 64 * 10000; n += 997) {
    const exact = n / 64;
    assert.equal(snapLayoutUnits(sig6(exact) + 'px'), exact + 'px', `${exact} → ${sig6(exact)}`);
    if (exact) assert.equal(snapLayoutUnits('-' + sig6(exact) + 'px'), -exact + 'px');   // Chrome will not produce -0px
  }
});

test('1/64 snapping: only the px values change, everything else stays as is', () => {
  assert.equal(snapLayoutUnits('auto'), 'auto');
  assert.equal(snapLayoutUnits('none'), 'none');
  assert.equal(snapLayoutUnits('50%'), '50%');
  // Used value of grid-template-* is a series of tracks, aligned one by one
  assert.equal(snapLayoutUnits('105.5px 210.656px'), '105.5px 210.65625px');
  assert.equal(snapLayoutUnits('[a] 10.047px [b] 20px'), '[a] 10.046875px [b] 20px');
  assert.equal(snapLayoutUnits('-0.001px'), '0px');
});

test('Snapped properties are all layout-resolved values and exclude the floating-point transform family', () => {
  for (const prop of ['transform', 'transform-origin', 'perspective-origin'])
    assert.equal(LAYOUT_UNIT_PROPS.has(prop), false, `${prop} is floating point, not on the LayoutUnit grid`);
  // Physical properties are all in LAYOUT_USED_VALUE_PROPS (logical properties supplemented additionally)
  const physical = [...LAYOUT_UNIT_PROPS].filter((p) => !/-(block|inline)(-|$)/.test(p));
  for (const prop of physical) assert.ok(LAYOUT_USED_VALUE_PROPS.has(prop), `${prop}`);
  // Inherited properties will not enter (inherited properties are compared with parent values;
  // alignment would distort the comparison)
  assert.deepEqual([...LAYOUT_UNIT_PROPS].filter((p) => INHERITED_PROPS.has(p)), []);
});

test('Animated properties that promote a compositing layer: opacity, the transform family, filter', () => {
  for (const prop of ['opacity', 'transform', 'translate', 'rotate', 'scale', 'filter', 'backdrop-filter'])
    assert.ok(COMPOSITED_ANIMATION_PROPS.has(prop), prop);
  for (const prop of ['color', 'width', 'background-color', 'clip-path'])
    assert.equal(COMPOSITED_ANIMATION_PROPS.has(prop), false, prop);
});

test('current animation: true within the active phase (paused ones count too), false once finished', () => {
  const t = (localTime, extra = {}) => ({ localTime, endTime: 1000, delay: 0, activeDuration: 1000, ...extra });
  // Animation pinned by __pcSyncAnims: paused in the middle of active phase
  assert.equal(isCurrentAnimation(t(500), 1, 'paused'), true);
  assert.equal(isCurrentAnimation(t(0), 1, 'paused'), true);
  // Reached the end point: in forward playback the end point belongs to after phase, does not count
  assert.equal(isCurrentAnimation(t(1000), 1, 'paused'), false);
  assert.equal(isCurrentAnimation(t(1000), 1, 'finished'), false);
  assert.equal(isCurrentAnimation(t(1500), 1, 'paused'), false);
  // In the active phase but already finished (should not happen; if it does, according to the spec
  // it is not considered playing)
  assert.equal(isCurrentAnimation(t(500), 1, 'finished'), false);
  // No time (idle)
  assert.equal(isCurrentAnimation(t(null), 1, 'idle'), false);
});

test('current animation: during the delay phase it depends on the playback direction, an infinite loop is always current', () => {
  const delayed = { localTime: 100, endTime: 1500, delay: 500, activeDuration: 1000 };
  assert.equal(isCurrentAnimation(delayed, 1, 'paused'), true);   // Forward, not yet started: current
  assert.equal(isCurrentAnimation(delayed, -1, 'paused'), false); // Reverse, before start: no
  // Reverse playback is current after ending
  assert.equal(isCurrentAnimation({ localTime: 1200, endTime: 1000, delay: 0, activeDuration: 1000 }, -1, 'running'), true);
  // In reverse playback, the before-active boundary point belongs to the before phase
  assert.equal(isCurrentAnimation({ localTime: 0, endTime: 1000, delay: 0, activeDuration: 1000 }, -1, 'running'), false);
  assert.equal(isCurrentAnimation({ localTime: 1e9, endTime: Infinity, delay: 0, activeDuration: Infinity }, 1, 'paused'), true);
});

/*
 * In the page, serializeTransformList consumes Typed OM objects (`computedStyleMap().get('transform')`),
 * dispatched by constructor name. Node has no Typed OM, so classes of the same name create objects
 * with the same shape here.
 */
class CSSUnitValue { constructor(value, unit) { this.value = value; this.unit = unit; } }
class CSSMathSum { constructor(...values) { this.values = values; this.operator = 'sum'; } }
const px = (v) => new CSSUnitValue(v, 'px'), deg = (v) => new CSSUnitValue(v, 'deg'), num = (v) => new CSSUnitValue(v, 'number');
class CSSTranslate { constructor(x, y, z) { this.x = x; this.y = y; this.z = z ?? px(0); this.is2D = z === undefined; } }
class CSSRotate { constructor(x, y, z, angle) { if (angle === undefined) { this.x = num(0); this.y = num(0); this.z = num(1); this.angle = x; this.is2D = true; } else { this.x = x; this.y = y; this.z = z; this.angle = angle; this.is2D = false; } } }
class CSSScale { constructor(x, y, z) { this.x = x; this.y = y; this.z = z ?? num(1); this.is2D = z === undefined; } }
class CSSSkew { constructor(ax, ay) { this.ax = ax; this.ay = ay; this.is2D = true; } }
class CSSSkewX { constructor(ax) { this.ax = ax; this.is2D = true; } }
class CSSPerspective { constructor(length) { this.length = length; this.is2D = false; } }
class CSSMatrixComponent { constructor(matrix) { this.matrix = matrix; this.is2D = matrix.is2D; } }

test('Transform: values are written back at full precision, no longer folded into a matrix of 6 significant digits', () => {
  // odometer frame 9: getComputedStyle gives matrix(1, 0, 0, 1, 0, -2156.5), actual value is -2156.501953125
  assert.equal(serializeTransformList([new CSSTranslate(px(0), px(-2156.501953125))]), 'translate(0px, -2156.501953125px)');
  // Spring value of punch-pill frame 5
  assert.equal(serializeTransformList([new CSSScale(num(1.0004741549491882), num(1.0004741549491882))]),
    'scale(1.0004741549491882, 1.0004741549491882)');
  // Percentages are preserved as is: resolved again against the same (already inlined) box during replay
  assert.equal(serializeTransformList([new CSSTranslate(new CSSUnitValue(-50, 'percent'), new CSSUnitValue(-50, 'percent')), new CSSScale(num(0.8), num(0.8))]),
    'translate(-50%, -50%) scale(0.8, 0.8)');
});

test('Transform: keep the function form. Rotations by integer multiples of 90° and around a coordinate axis are not folded into a matrix', () => {
  // Collapsing into a matrix yields matrix(6.12323e-17, -1, 1, 6.12323e-17, 0, 0): leaves a residual
  // 1e-17, no longer an axis-aligned transform
  assert.equal(serializeTransformList([new CSSRotate(deg(-90))]), 'rotate(-90deg)');
  // terminal-3d rotateY(-8deg): collapsing into a matrix yields 6 significant digits of cos / sin
  assert.equal(serializeTransformList([new CSSRotate(num(0), num(1), num(0), deg(-8))]), 'rotateY(-8deg)');
  assert.equal(serializeTransformList([new CSSRotate(num(1), num(0), num(0), deg(30))]), 'rotateX(30deg)');
  assert.equal(serializeTransformList([new CSSRotate(num(0), num(0), num(1), deg(30))]), 'rotateZ(30deg)');
  assert.equal(serializeTransformList([new CSSRotate(num(1), num(1), num(0), deg(30))]), 'rotate3d(1, 1, 0, 30deg)');
  // 3D translation / scale stays 3D: collapsing translateZ(0) into a matrix produces a 2D identity
  // matrix, losing that compositing layer
  assert.equal(serializeTransformList([new CSSTranslate(px(0), px(0), px(0))]), 'translate3d(0px, 0px, 0px)');
  assert.equal(serializeTransformList([new CSSScale(num(1), num(1), num(2))]), 'scale3d(1, 1, 2)');
  assert.equal(serializeTransformList([new CSSSkew(deg(10), deg(0)), new CSSSkewX(deg(5))]), 'skew(10deg, 0deg) skewX(5deg)');
  assert.equal(serializeTransformList([new CSSPerspective(px(800)), new CSSRotate(num(0), num(1), num(0), deg(45))]), 'perspective(800px) rotateY(45deg)');
});

test('Transform: matrix components are written as 2D / 3D', () => {
  const m2 = { is2D: true, a: 1, b: 0.5, c: -0.5, d: 1, e: 10.25, f: -3.125 };
  assert.equal(serializeTransformList([new CSSMatrixComponent(m2)]), 'matrix(1, 0.5, -0.5, 1, 10.25, -3.125)');
  const m3 = { is2D: false };
  for (let i = 1; i <= 4; i++) for (let j = 1; j <= 4; j++) m3[`m${i}${j}`] = i === j ? 1 : 0;
  m3.m34 = -0.00125;
  assert.equal(serializeTransformList([new CSSMatrixComponent(m3)]), 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -0.00125, 0, 0, 0, 1)');
});

test('Transform: any unrecognized component or value returns null and the caller falls back to the computed value', () => {
  // Things like calc() are not a single numerical value
  assert.equal(serializeTransformList([new CSSTranslate(new CSSMathSum(px(10), new CSSUnitValue(50, 'percent')), px(0))]), null);
  // Unrecognized component
  class CSSSomethingNew { constructor() { this.is2D = true; } }
  assert.equal(serializeTransformList([new CSSTranslate(px(1), px(2)), new CSSSomethingNew()]), null);
  // perspective(none)
  assert.equal(serializeTransformList([new CSSPerspective({ value: 'none' })]), null);
  // Non-finite number
  assert.equal(serializeTransformList([new CSSTranslate(px(NaN), px(0))]), null);
  assert.equal(serializeTransformList([]), null);
});

test('relevant animation (Blink\'s criterion for promoting a compositing layer): per the Chrome 152 measured table, current or in effect both count', () => {
  // Opacity animation with delay 400 / duration 800 paused at various points in time; progress is
  // the value returned by getComputedTiming() under various fill options
  const t = (localTime, progress) => ({ localTime, endTime: 1200.0000000000002, delay: 400, activeDuration: 800, progress });
  const end = 1200.0000000000002;
  // fill: both: promotes layer during delay, active phase, end, and after end
  assert.equal(isRelevantAnimation(t(100, 0), 1, 'paused'), true);
  assert.equal(isRelevantAnimation(t(800, 0.5), 1, 'paused'), true);
  assert.equal(isRelevantAnimation(t(end, 1), 1, 'paused'), true);   // stat-proof frame 12 is exactly this case
  assert.equal(isRelevantAnimation(t(1500, 1), 1, 'paused'), true);
  assert.equal(isRelevantAnimation(t(end, 1), 1, 'finished'), true);  // Still promoted after finish()
  // fill: none: promoted during delay (forward playback, current); not promoted at end or after end
  assert.equal(isRelevantAnimation(t(100, null), 1, 'paused'), true);
  assert.equal(isRelevantAnimation(t(end, null), 1, 'paused'), false);
  assert.equal(isRelevantAnimation(t(1500, null), 1, 'paused'), false);
  // fill: backwards: not promoted after end; fill: forwards: promoted after end
  assert.equal(isRelevantAnimation(t(1500, null), 1, 'paused'), false);
  assert.equal(isRelevantAnimation(t(1500, 1), 1, 'paused'), true);
  // Looking only at current misses precisely "playback finished, staying at end state via fill"
  assert.equal(isCurrentAnimation(t(end, 1), 1, 'paused'), false);
});

/**
 * 差异样式内联的属性表对账(底稿 A2(8))(任务书:「清单以 Chrome 实测为准:用父子两层干净元素逐个属性验
 * 『父设了非初始值、子跟不跟』,与清单不符就失败」)。
 *
 * 实测那一步在 `scripts/probes/inherited-props-probe.mjs` 里跑(要真 Chrome,`npm test`
 * 没有 DOM、也不该在单测里起浏览器)。这里对的是**那一趟跑出来的结果**:
 * 下面两张表是 2026-09-19 在 Chrome 152 上跑出来的原文
 * (`out/inherited-props.json` 的 `inherited` / `notInherited`,已排掉布局解析值属性 ——
 *  给父元素设 width、块级子元素的**使用值**跟着变,那是布局不是继承)。
 *
 * 改 `INHERITED_PROPS` 的人要么让它继续满足这两条,要么重跑探针、把这里的两张表一起换掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INHERITED_PROPS, LAYOUT_USED_VALUE_PROPS, LAYOUT_UNIT_PROPS, COMPOSITED_ANIMATION_PROPS,
  isInheritedProp, snapLayoutUnits, isCurrentAnimation, isRelevantAnimation, serializeTransformList,
} from '../../src/render/snapshot/snapshotStyleProps.mjs';

/** Chrome 152 实测「确实继承」的属性(103 个里排掉 width / inline-size 两个布局解析值) */
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

/** 同一趟实测里「确实不继承」的属性。只抽了会被误写进表的那几类留在这里做反向卡口。 */
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

test('表里的每一项都不是 Chrome 实测的「不继承」', () => {
  const wrong = CHROME_NOT_INHERITED.filter((p) => INHERITED_PROPS.has(p));
  assert.deepEqual(wrong, [], `这些属性 Chrome 说不继承,写进 INHERITED_PROPS 会拿它们和父值比:${wrong.join(', ')}`);
});

test('Chrome 实测继承的属性一个不缺 —— 缺了顶层元素就漏内联', () => {
  const missing = CHROME_INHERITED.filter((p) => !INHERITED_PROPS.has(p));
  assert.deepEqual(missing, [], `快照顶层元素靠这张表决定内联哪些继承属性,缺一项重放时就会从别人那里继承:${missing.join(', ')}`);
});

test('两张表不重叠:布局解析值属性一律全内联,不该同时按继承属性判', () => {
  const both = [...LAYOUT_USED_VALUE_PROPS].filter((p) => INHERITED_PROPS.has(p));
  assert.deepEqual(both, []);
});

test('表里没有简写、没有大写、没有重复', () => {
  const list = [...INHERITED_PROPS];
  assert.equal(new Set(list).size, list.length);
  for (const prop of list) assert.equal(prop, prop.toLowerCase(), `${prop} 要写成 getComputedStyle 给的小写连字符形式`);
  // 常见简写一律不写进表:getComputedStyle 枚举的是 longhand,写简写永远命不中
  for (const shorthand of ['font', 'list-style', 'text-emphasis', 'border', 'margin', 'padding', 'background'])
    assert.equal(INHERITED_PROPS.has(shorthand), false, `${shorthand} 是简写`);
});

test('自定义属性按继承处理', () => {
  assert.equal(isInheritedProp('--pc-accent'), true);
  assert.equal(isInheritedProp('color'), true);
  assert.equal(isInheritedProp('display'), false);
});

/*
 * 下面几条对的是「重放逐字节等于活渲」那几处(docs/archive/restructure_planning/reports/replay-mismatch-report.md
 * 第二轮 §12、第三轮 §13):几何按 1/64 px 对齐、动画撑起的合成层补 will-change、变换全精度写回。
 */

test('1/64 对齐:6 位有效数字丢掉的那一点补回原值', () => {
  // 实测的三个宽度:316.15625 / 484.65625 / 381.3125,getComputedStyle 分别给 316.156 / 484.656 / 381.312
  assert.equal(snapLayoutUnits('316.156px'), '316.15625px');
  assert.equal(snapLayoutUnits('484.656px'), '484.65625px');
  assert.equal(snapLayoutUnits('381.312px'), '381.3125px');
  // 本来就在网格上的原样不动
  assert.equal(snapLayoutUnits('352.125px'), '352.125px');
  assert.equal(snapLayoutUnits('0px'), '0px');
  assert.equal(snapLayoutUnits('-16.0625px'), '-16.0625px');
});

test('1/64 对齐:10000 px 以内每一格都能从 6 位有效数字还原回来', () => {
  const sig6 = (v) => String(Number(v.toPrecision(6)));
  for (let n = 0; n < 64 * 10000; n += 997) {
    const exact = n / 64;
    assert.equal(snapLayoutUnits(sig6(exact) + 'px'), exact + 'px', `${exact} → ${sig6(exact)}`);
    if (exact) assert.equal(snapLayoutUnits('-' + sig6(exact) + 'px'), -exact + 'px');   // Chrome 不会给出 -0px
  }
});

test('1/64 对齐:只改 px 数,别的原样', () => {
  assert.equal(snapLayoutUnits('auto'), 'auto');
  assert.equal(snapLayoutUnits('none'), 'none');
  assert.equal(snapLayoutUnits('50%'), '50%');
  // grid-template-* 的使用值是一串轨道,逐个对齐
  assert.equal(snapLayoutUnits('105.5px 210.656px'), '105.5px 210.65625px');
  assert.equal(snapLayoutUnits('[a] 10.047px [b] 20px'), '[a] 10.046875px [b] 20px');
  assert.equal(snapLayoutUnits('-0.001px'), '0px');
});

test('对齐的属性都是布局解析值,不含浮点的 transform 一族', () => {
  for (const prop of ['transform', 'transform-origin', 'perspective-origin'])
    assert.equal(LAYOUT_UNIT_PROPS.has(prop), false, `${prop} 是浮点,不在 LayoutUnit 网格上`);
  // 物理写法全在 LAYOUT_USED_VALUE_PROPS 里(逻辑写法是额外补的)
  const physical = [...LAYOUT_UNIT_PROPS].filter((p) => !/-(block|inline)(-|$)/.test(p));
  for (const prop of physical) assert.ok(LAYOUT_USED_VALUE_PROPS.has(prop), `${prop}`);
  // 继承属性不会进来(继承属性和父值比,对齐会让比较失真)
  assert.deepEqual([...LAYOUT_UNIT_PROPS].filter((p) => INHERITED_PROPS.has(p)), []);
});

test('会提合成层的动画属性:透明度、变换一族、滤镜', () => {
  for (const prop of ['opacity', 'transform', 'translate', 'rotate', 'scale', 'filter', 'backdrop-filter'])
    assert.ok(COMPOSITED_ANIMATION_PROPS.has(prop), prop);
  for (const prop of ['color', 'width', 'background-color', 'clip-path'])
    assert.equal(COMPOSITED_ANIMATION_PROPS.has(prop), false, prop);
});

test('current 动画:活跃段里(暂停的也算)是,放完的不是', () => {
  const t = (localTime, extra = {}) => ({ localTime, endTime: 1000, delay: 0, activeDuration: 1000, ...extra });
  // __pcSyncAnims 钉住的动画:暂停在活跃段中间
  assert.equal(isCurrentAnimation(t(500), 1, 'paused'), true);
  assert.equal(isCurrentAnimation(t(0), 1, 'paused'), true);
  // 到了终点:正向播放时终点归 after 段,不算
  assert.equal(isCurrentAnimation(t(1000), 1, 'paused'), false);
  assert.equal(isCurrentAnimation(t(1000), 1, 'finished'), false);
  assert.equal(isCurrentAnimation(t(1500), 1, 'paused'), false);
  // 活跃段里但已经 finished(不该出现,出现了也按规范不算在播)
  assert.equal(isCurrentAnimation(t(500), 1, 'finished'), false);
  // 没有时间(idle)
  assert.equal(isCurrentAnimation(t(null), 1, 'idle'), false);
});

test('current 动画:delay 里看播放方向,无限循环一直是', () => {
  const delayed = { localTime: 100, endTime: 1500, delay: 500, activeDuration: 1000 };
  assert.equal(isCurrentAnimation(delayed, 1, 'paused'), true);   // 正向、还没开始:current
  assert.equal(isCurrentAnimation(delayed, -1, 'paused'), false); // 反向、在开始前:不是
  // 反向播放在结束后是 current
  assert.equal(isCurrentAnimation({ localTime: 1200, endTime: 1000, delay: 0, activeDuration: 1000 }, -1, 'running'), true);
  // 反向播放时 before-active 边界点归 before 段
  assert.equal(isCurrentAnimation({ localTime: 0, endTime: 1000, delay: 0, activeDuration: 1000 }, -1, 'running'), false);
  assert.equal(isCurrentAnimation({ localTime: 1e9, endTime: Infinity, delay: 0, activeDuration: Infinity }, 1, 'paused'), true);
});

/*
 * serializeTransformList 在页面里吃的是 Typed OM 的对象(`computedStyleMap().get('transform')`),
 * 按构造函数名分派。Node 里没有 Typed OM,这里用同名的类造一样形状的对象。
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

test('变换:数值全精度写回,不再折成 6 位有效数字的矩阵', () => {
  // odometer 第 9 帧:getComputedStyle 给 matrix(1, 0, 0, 1, 0, -2156.5),真实值是 -2156.501953125
  assert.equal(serializeTransformList([new CSSTranslate(px(0), px(-2156.501953125))]), 'translate(0px, -2156.501953125px)');
  // punch-pill 第 5 帧的弹簧值
  assert.equal(serializeTransformList([new CSSScale(num(1.0004741549491882), num(1.0004741549491882))]),
    'scale(1.0004741549491882, 1.0004741549491882)');
  // 百分比原样留着:重放时对着同一个(已内联)的盒子再解析一遍
  assert.equal(serializeTransformList([new CSSTranslate(new CSSUnitValue(-50, 'percent'), new CSSUnitValue(-50, 'percent')), new CSSScale(num(0.8), num(0.8))]),
    'translate(-50%, -50%) scale(0.8, 0.8)');
});

test('变换:保留函数形式 —— 90° 的整数倍、绕坐标轴的旋转不折成矩阵', () => {
  // 折成矩阵是 matrix(6.12323e-17, -1, 1, 6.12323e-17, 0, 0):残下 1e-17,不再是轴对齐变换
  assert.equal(serializeTransformList([new CSSRotate(deg(-90))]), 'rotate(-90deg)');
  // terminal-3d 的 rotateY(-8deg):折成矩阵是 cos / sin 的 6 位有效数字
  assert.equal(serializeTransformList([new CSSRotate(num(0), num(1), num(0), deg(-8))]), 'rotateY(-8deg)');
  assert.equal(serializeTransformList([new CSSRotate(num(1), num(0), num(0), deg(30))]), 'rotateX(30deg)');
  assert.equal(serializeTransformList([new CSSRotate(num(0), num(0), num(1), deg(30))]), 'rotateZ(30deg)');
  assert.equal(serializeTransformList([new CSSRotate(num(1), num(1), num(0), deg(30))]), 'rotate3d(1, 1, 0, 30deg)');
  // 3D 的平移 / 缩放保持 3D:translateZ(0) 折成矩阵是 2D 的单位阵,那一层合成层就没了
  assert.equal(serializeTransformList([new CSSTranslate(px(0), px(0), px(0))]), 'translate3d(0px, 0px, 0px)');
  assert.equal(serializeTransformList([new CSSScale(num(1), num(1), num(2))]), 'scale3d(1, 1, 2)');
  assert.equal(serializeTransformList([new CSSSkew(deg(10), deg(0)), new CSSSkewX(deg(5))]), 'skew(10deg, 0deg) skewX(5deg)');
  assert.equal(serializeTransformList([new CSSPerspective(px(800)), new CSSRotate(num(0), num(1), num(0), deg(45))]), 'perspective(800px) rotateY(45deg)');
});

test('变换:矩阵分量按 2D / 3D 写', () => {
  const m2 = { is2D: true, a: 1, b: 0.5, c: -0.5, d: 1, e: 10.25, f: -3.125 };
  assert.equal(serializeTransformList([new CSSMatrixComponent(m2)]), 'matrix(1, 0.5, -0.5, 1, 10.25, -3.125)');
  const m3 = { is2D: false };
  for (let i = 1; i <= 4; i++) for (let j = 1; j <= 4; j++) m3[`m${i}${j}`] = i === j ? 1 : 0;
  m3.m34 = -0.00125;
  assert.equal(serializeTransformList([new CSSMatrixComponent(m3)]), 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -0.00125, 0, 0, 0, 1)');
});

test('变换:认不出的分量或数值一律返回 null,调用方退回计算值', () => {
  // calc() 这类不是单一数值
  assert.equal(serializeTransformList([new CSSTranslate(new CSSMathSum(px(10), new CSSUnitValue(50, 'percent')), px(0))]), null);
  // 不认识的分量
  class CSSSomethingNew { constructor() { this.is2D = true; } }
  assert.equal(serializeTransformList([new CSSTranslate(px(1), px(2)), new CSSSomethingNew()]), null);
  // perspective(none)
  assert.equal(serializeTransformList([new CSSPerspective({ value: 'none' })]), null);
  // 非有限数
  assert.equal(serializeTransformList([new CSSTranslate(px(NaN), px(0))]), null);
  assert.equal(serializeTransformList([]), null);
});

test('relevant 动画(Blink 提合成层的判据):照 Chrome 152 实测表,current 或 in effect 都算', () => {
  // delay 400 / duration 800 的透明度动画暂停在各个时刻;progress 是 getComputedTiming() 在各种 fill 下给的值
  const t = (localTime, progress) => ({ localTime, endTime: 1200.0000000000002, delay: 400, activeDuration: 800, progress });
  const end = 1200.0000000000002;
  // fill: both —— delay 里、活跃段、结尾、结尾之后都提层
  assert.equal(isRelevantAnimation(t(100, 0), 1, 'paused'), true);
  assert.equal(isRelevantAnimation(t(800, 0.5), 1, 'paused'), true);
  assert.equal(isRelevantAnimation(t(end, 1), 1, 'paused'), true);   // stat-proof 第 12 帧就是这一格
  assert.equal(isRelevantAnimation(t(1500, 1), 1, 'paused'), true);
  assert.equal(isRelevantAnimation(t(end, 1), 1, 'finished'), true);  // finish() 之后仍提
  // fill: none —— delay 里(正向播放,current)提;结尾、结尾之后不提
  assert.equal(isRelevantAnimation(t(100, null), 1, 'paused'), true);
  assert.equal(isRelevantAnimation(t(end, null), 1, 'paused'), false);
  assert.equal(isRelevantAnimation(t(1500, null), 1, 'paused'), false);
  // fill: backwards —— 结尾之后不提;fill: forwards —— 结尾之后提
  assert.equal(isRelevantAnimation(t(1500, null), 1, 'paused'), false);
  assert.equal(isRelevantAnimation(t(1500, 1), 1, 'paused'), true);
  // 只看 current 会漏掉的正是「放完了、靠 fill 停在终态」
  assert.equal(isCurrentAnimation(t(end, 1), 1, 'paused'), false);
});

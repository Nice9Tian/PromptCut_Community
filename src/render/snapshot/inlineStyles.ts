/**
 * 生成快照的第二步:**样式内联**(任务书 3.8;比对口径是底稿 A2(8))。
 *
 * 读 live 元素的计算样式,按「省掉以后重放会变」的口径写进克隆体的 `style` 属性。
 * 瓶颈是**元素数 × 属性数**:lottie 那种两千多节点的卡,`inlineMs` 高就是这一步。
 *
 * 本文件**不 import `rasterizeCanvas`**(任务书 3.8 点名的约束),两步的衔接写在
 * `createSnapshot.ts` 里 —— canvas 换 `<img>` 时要按 IMG 的基线另算一份样式串,
 * 所以这里把 `styleAs(el, tag)` 作为结果的一部分交出去,由 `createSnapshot` 转给
 * `rasterizeCanvas`。两边谁也不认识谁。
 *
 * # 三类判据(底稿 A2(8))
 *
 *   ① **继承属性**(`snapshotStyleProps.mjs` 的 `INHERITED_PROPS`,外加所有 `--*`)——
 *      和**父元素的计算值**比,相等才省。**不能和同标签基线比**:一个继承属性的值恰好
 *      等于基线、却不等于父值时,省掉后重放会继承到父值,画面就错。快照的顶层元素
 *      (整场景 html 的场景根、control 的包裹层直接子节点)继承属性一律照旧全内联 ——
 *      重放时它们的父元素是另一棵树,继承进来的东西不受我们控制。
 *   ② **布局解析值属性**(`LAYOUT_USED_VALUE_PROPS`)一律照旧内联、不参与省略:
 *      `getComputedStyle` 给的是**使用值**(`width: auto` 量出来是 `823.5px`),
 *      和基线偶然相等不代表重放时重新排版还相等。
 *   ③ 其余非继承属性和**同标签基线**比。基线 = 同 `namespaceURI` + `tagName` 的一个
 *      干净元素(无 class、无内联样式)挂在同一张快照页的场景根下量到的计算样式
 *      (= UA 默认 + 主题全局样式),按 `namespaceURI + tagName + themeId` 缓存。
 *
 * 末尾的 `animation:none !important;transition:none !important;` 照旧**每个元素都写** ——
 * 注入后不能再有任何还在走的钟。
 *
 * # 两条必须有的兜底
 *
 * 「重放时的层叠 = 生成快照时的层叠」这个前提有两个缺口:
 *   1. **元素自己 `style` 属性里写过的属性**:我们把整个 `style` 换成自己的串,原来的
 *      内联声明就没了。Motion 就是靠内联 `style` 驱动的,`opacity` 动到 1 恰好等于基线的话,
 *      省掉之后重放会掉回类规则里的 `opacity: 0`。
 *   2. **被动画 / 过渡改写的属性**:我们写死了 `animation:none !important`,重放时
 *      `@keyframes` 不再生效、属性掉回声明值。入场动画 `opacity: 0 → 1` 停在 1(= 基线)时
 *      省掉,重放就是 0。
 * 两条都靠「强制内联」解决:前者读 `el.style`,后者读一次 `root.getAnimations({ subtree: true })`
 * 的关键帧属性名。
 *
 * # 四处不照抄计算值(重放要和活渲逐字节相同)
 *
 * 出处是 `docs/archive/restructure_planning/reports/replay-mismatch-report.md`:前两条是第二轮(§12),
 * 后两条是第三轮(§13)。
 *
 *   1. **合成层**:活渲时,有 relevant 动画(current 或 in effect,见 `isRelevantAnimation`)改写
 *      opacity / transform / filter 的元素会被 Chrome 单独提一层;快照写死了 `animation:none`,这层就没了,
 *      `filter: blur()` 换一条栅格化路径,能差出上百级。所以给这些元素补一条 `will-change`
 *      (`COMPOSITED_ANIMATION_PROPS`)。第二轮只按 current 判,第三轮按实测改成 relevant。
 *   2. **1/64 px**:`getComputedStyle` 只给 6 位有效数字,排版值回灌时掉一格;
 *      `LAYOUT_UNIT_PROPS` 里的 px 数写之前对齐回 1/64 格(`snapLayoutUnits`)。
 *   3. **变换**:`getComputedStyle` 把变换折成一个 6 位有效数字的矩阵 —— 大位移丢到 0.01 px、
 *      旋转的 cos / sin 丢到 1e-6、`rotate(-90deg)` 残下 1e-17 不再轴对齐。改用 Typed OM 读分量,
 *      按函数形式全精度写回(`exactTransform` → `serializeTransformList`),读不出来才退回矩阵。
 *   4. **SVG 表现属性**:`d` / `cx` / `stroke-dasharray` 这类写在 SVG 属性上的值,计算值同样只有
 *      6 位有效数字,而**内联样式的优先级高于属性**,写进去就把克隆体上全精度的原文盖掉
 *      (growth-curve 的曲线、ring-metric 的描边端点、lottie 的路径)。SVG 内部元素上由它自己的属性
 *      给出、又没被内联样式和动画改写的属性不内联(`presentationProps`),重放时照样由那个属性给出。
 *      这是「② 布局解析值一律内联」唯一的例外:SVG 内部元素的 `width` / `height` 不是排版值。
 * 四条都只改快照里写什么,不碰活渲 —— 整帧导出不生成快照,逐字节基线不受影响。
 */

import {
  INHERITED_PROPS, LAYOUT_USED_VALUE_PROPS, LAYOUT_UNIT_PROPS, COMPOSITED_ANIMATION_PROPS, snapLayoutUnits, isRelevantAnimation,
  serializeTransformList,
} from "./snapshotStyleProps.mjs";

export const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
/** 每个元素末尾都写的那一条:注入后不能再有任何还在走的钟 */
export const STOP_CLOCKS = "animation:none !important;transition:none !important;";

type Baseline = Map<string, string>;
type BaselineSet = { themeKey: string; byTag: Map<string, Baseline> };

/**
 * 基线缓存挂在**场景根**上(不是全局):同一个文档里可能有别的宿主,而主题是写在场景根的
 * 内联 `style` 上的(`StageView.tsx` / `ExportView.tsx` 都 spread `themeStyle(themeId)`),
 * 所以拿那一串当版本号 —— 换主题就重量一遍(这就是口径里那个 `themeId`)。
 */
const baselineCache = new WeakMap<Element, BaselineSet>();

const tagKey = (ns: string, tag: string) => ns + "|" + tag;
const keyOf = (el: Element) => tagKey(el.namespaceURI || HTML_NS, el.tagName);
const isInherited = (prop: string) =>
  prop.charCodeAt(0) === 45 && prop.charCodeAt(1) === 45 ? true : INHERITED_PROPS.has(prop);

/** 包裹层?control 快照 = 它的 innerHTML,所以它的直接子节点就是快照的顶层元素 */
function isClipWrapper(el: Element | null): boolean {
  return !!el && el.hasAttribute("data-pc-clip") && el.hasAttribute("data-pc-local-frame") && !el.hasAttribute("data-pc-media");
}

/**
 * 剪辑段里的卡在嵌套场景里的包裹层(`data-pc-flat-clip`;`createSnapshot` 的 `flatControls`,〔裁〕R02)。它的直接子节点也是
 * control 快照的顶层:control 快照只取包裹层里面,重放时没有嵌套场景那几层祖先,继承属性(字体、行高、颜色……)要一律内联,
 * 不然重放出来字体退回缺省、字的位置都不对。缺省不认它(整场景快照与别的调用方逐字节不变)。
 */
function isFlatClipWrapper(el: Element | null): boolean {
  return !!el && el.hasAttribute("data-pc-flat-clip") && el.hasAttribute("data-pc-local-frame");
}

/**
 * 量基线:每个 (命名空间, 标签) 一个干净元素挂在场景根下量一次,**一次挂、一次读、一次摘**
 * (别在逐元素循环里反复进出 live DOM —— 每进出一次就是一次强制重排)。
 *
 * - SVG 元素用 `createElementNS` 造并塞进一个真 `<svg>` 里:`createElement` 造出来的是
 *   `HTMLUnknownElement`,`fill` / `stroke` / `display` 的初始值全不对(lottie 五张和
 *   `growth-curve` 正是 SVG)。
 * - 探针整体装在一个挪到视口外、零尺寸、绝对定位的容器里,免得把场景根的布局顶歪。
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
      probe = null;   // 造不出来(奇怪的标签名)就没有基线:那一类元素全内联,安全
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
  /** 被动画 / 过渡改写的属性:一律强制内联(文件头「两条必须有的兜底」第 2 条) */
  written: Map<Element, Set<string>>;
  /**
   * 因为有 relevant 动画而被 Chrome 单独提层的属性(`COMPOSITED_ANIMATION_PROPS` 里的那些)。
   * 快照写死了 `animation:none`,这层在重放页里就没了,所以要补成 `will-change`,见 `buildStyle`。
   */
  promoted: Map<Element, Set<string>>;
}

/**
 * 哪些元素的哪些属性正被动画 / 过渡改写。整棵树一次 `getAnimations`,不逐元素问
 * (lottie 那种几千节点的卡逐元素问会把样式内联的时间吃掉)。
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
    } catch { /* 有些实现对没有关键帧的效果会抛 */ }
    const names = new Set<string>();
    for (const frame of frames) for (const name in frame) if (!KEYFRAME_META.has(name)) names.add(dashed(name));
    for (const name of names) set.add(name);
    // 伪元素上的动画提的是伪元素的层,内联样式够不着,不补
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

/** 元素自带的内联样式属性 + 动画改写的属性 —— 这两类一律强制内联,见文件头 */
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

/** SVG 内部元素(父元素也是 SVG)。最外层 `<svg>` 自己是 CSS 盒子,不算 */
const isSvgInner = (el: Element) => el.namespaceURI === SVG_NS && el.parentElement?.namespaceURI === SVG_NS;

/**
 * 这个元素的几何值能不能按 1/64 px 对齐(`snapLayoutUnits`,口径见 `LAYOUT_UNIT_PROPS`)。
 * 只有走 CSS 排版的盒子才在 LayoutUnit 网格上:
 *   - SVG 内部元素的 `width` / `height` 是浮点几何,对齐会挪动图形,不对齐;
 *     最外层 `<svg>` 自己是 CSS 盒子,照常对齐;
 *   - `zoom` 不为 1 的子树里,计算样式给的是缩放前的值,网格不再是 1/64,保持原样。
 */
function onLayoutGrid(el: Element, cs: CSSStyleDeclaration, parentZoomed: boolean): { snap: boolean; zoomed: boolean } {
  const zoomed = parentZoomed || (cs.zoom !== "" && cs.zoom !== "1");
  return { snap: !zoomed && !isSvgInner(el), zoomed };
}

/**
 * SVG 内部元素上**由它自己的表现属性(presentation attribute)给出**的那些属性:不内联(文件头第 4 条)。
 *
 * 克隆体原样带着这些属性,重放时的层叠又和生成快照时相同(见 `snapshotStyleProps.mjs` 文件头),
 * 所以不写也还是那个值,而且是属性里的全精度原文;写了反而用 6 位有效数字的计算值把它盖掉。
 * 元素自己内联样式里写过的、被动画 / 过渡改写的(`forced`)不在此列:那两类的值不来自属性,
 * 照旧强制内联。
 *
 * 按属性名收:SVG 的表现属性和 CSS 属性同名。收进来的名字里不是 CSS 属性的(`class`、`id`、`offset`…)
 * 永远对不上 `getComputedStyle` 的属性名,不起作用;是 CSS 属性、但在这个元素上不是表现属性的
 * (`<text>` 的 `x`)计算值就是初始值,本来也和基线相同、不会写。
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
 * 变换按 Typed OM 的分量写回(文件头第 3 条,`serializeTransformList`);拿不到就返回 null、退回计算值。
 * 只对计算值不是 `none` 的元素调 —— `computedStyleMap()` 每次都新建一个映射。
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
 * 按三类判据拼一个元素的样式串,同时把它自己的继承属性值留给子元素做比对。
 *
 * 返回的 `inherited` 在「一个都没变」时**直接复用父元素那个对象**,不新建 —— lottie 一张卡
 * 几千个元素,每个都存一份上百项的记录会把内存吃光。
 *
 * 另有四处不是「照抄计算值」(都是为了让重放逐字节等于活渲,见文件头):
 *   - `snap`:`LAYOUT_UNIT_PROPS` 里的 px 数对齐回 1/64 格,补回 6 位有效数字丢掉的那一点;
 *   - `transform`:按 Typed OM 的分量全精度写回(`exactTransform`),读不出来才用计算值;
 *   - `fromAttr`:SVG 内部元素上由自己的属性给出的属性不写(`presentationProps`),
 *     继承属性照样记进给子元素比对的那一份;
 *   - `promote`:有 relevant 动画的元素补一条 `will-change`,要回活渲时的合成层。
 *     元素自己本来就写了 `will-change` 的,合并成一条,不另起一条去盖它。
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
  // X6:先收成「属性名 → 值」,末尾按属性名排序再拼(`serializeDeclarations`),不照浏览器的枚举顺序写
  const decls: Array<[string, string]> = [];
  for (let k = 0; k < cs.length; k++) {
    const prop = cs.item(k);
    if (promote && prop === "will-change") continue;   // 循环后合并着写
    let value = snap && LAYOUT_UNIT_PROPS.has(prop) ? snapLayoutUnits(cs.getPropertyValue(prop)) : cs.getPropertyValue(prop);
    if (fromAttr && fromAttr.has(prop)) {
      // SVG 表现属性:不写,重放时由克隆下来的属性给出。继承属性的值照样留给子元素比
      if (isInherited(prop) && !(compareParent && parentInherited![prop] === value)) ensureOwn()[prop] = value;
      continue;
    }
    if (prop === "transform" && value !== "none") value = exactTransform(el) ?? value;
    if (isInherited(prop)) {
      // ① 继承属性:和父元素的计算值比。顶层元素没有可信的父元素,一律内联。
      if (compareParent && parentInherited![prop] === value && !(forced && forced.has(prop))) continue;
      decls.push([prop, value]);
      ensureOwn()[prop] = value;
      continue;
    }
    // ② 布局解析值照旧全内联;强制内联的两类兜底同此
    if (LAYOUT_USED_VALUE_PROPS.has(prop) || (forced && forced.has(prop))) { decls.push([prop, value]); continue; }
    // ③ 其余非继承属性和同标签基线比
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
 * X6(`docs/plan/m6c-contract.md`):声明按**属性名**的确定顺序拼成样式串。
 *
 * `getComputedStyle` 的枚举顺序由浏览器定,与内容无关的因素(自定义属性 `--*` 那一段的顺序等)
 * 可能让两个进程对同样的内容拼出字节不同的快照,块哈希对不上,跨节点去重与复用就落空。
 *
 * 顺序是「先分三组、组内按名字」:无前缀的标准属性、`-webkit-` 这类带厂商前缀的、自定义属性 `--*`。
 * 分组是为了不改层叠:Chrome 152 实测(本分支报告 X6 一节)它自己的枚举就是「标准属性按字母、
 * 前缀属性按字母、自定义属性」三段,而同一块声明里有几对是「后写的赢」—— `mask-position` 这个
 * 简写展开成 `-webkit-mask-position-x/y`,`writing-mode` 与 `-webkit-writing-mode` 这类是同一个值的
 * 两个名字。整串按名字排会把前缀属性挪到标准属性前面,让这几对的先后反过来;分组排则与 Chrome
 * 原来的先后一致,只把自定义属性那一段(以及 `will-change` 合并后那一条)排定。
 *
 * 比较用 UTF-16 码元序(`<`),不用 `localeCompare`:后者随区域设置变,正是要消掉的那种不确定。
 * 排的是调用方的数组(原地)。
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
   * 按**另一个标签**的基线重算某个 live 元素的样式串(含末尾的 `STOP_CLOCKS`)。
   * 给 `rasterizeCanvas` 用:canvas 换成 `<img>` 之后,IMG 独有的 `overflow: clip` /
   * 替换元素默认尺寸规则和 CANVAS 不一样,复用 CANVAS 的差异串会漏属性。
   * 要用到的标签得先写进 `inlineDOMStyles` 的 `extraBaselineTags`,否则这里没有基线、
   * 退化成整份内联(只多几个字节,不会画错)。
   */
  styleAs(el: Element, tag: string, ns?: string): string;
}

/**
 * 逐元素把差异样式写进克隆体。
 *
 * @param root  live 场景根(`[data-pc-scene]`)。基线探针挂在它下面。
 * @param orig  live 元素数组,`[root, ...root.querySelectorAll('*')]`
 * @param copy  和 `orig` 一一对应的克隆体元素数组
 * @param extraBaselineTags  除了树里出现过的标签,还要预热哪些基线(HTML 命名空间)
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
    // 顶层 = 整场景 html 的场景根,或 control 快照里包裹层的直接子节点
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
      // 换上来的是 HTML 元素(canvas → img),没有 SVG 表现属性这一说
      const built = buildStyle(el, cs, isTop, parentInherited, forcedProps(el, animated), baselines.get(tagKey(ns, tag)),
        snap, animated.promoted.get(el), null);
      return built.text + STOP_CLOCKS;
    },
  };
}

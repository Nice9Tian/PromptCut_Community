/**
 * 量一段已经渲染出来的卡片内容的包围盒(舞台坐标)。
 *
 * 卡片没有静态的「我画在哪」:没有 frame 就铺满整个画幅,内容多半只在中间一小块。
 * 预览卡按整个画幅等比缩,1920×1080 塞进 130px 的方块,标题卡里的字就成了一粒芝麻。
 * 所以真的去量:把舞台里**看得见的东西**(文字、图片、svg、canvas、带底色 / 描边的盒子)
 * 的矩形并起来,预览按这个盒子缩放。铺满整个舞台的元素(背景、居中用的外层容器)不算,
 * 否则并出来永远是整幅画面。
 *
 * 文字用 Range 量:一个 block 元素的矩形是整行宽,Range 给的是字本身的框。
 * canvas 扫像素量:DOM 只知道画布多大,不知道里面画了什么。
 */
import { isPlaceholderNode } from "./placeholderHost.ts";

export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

/**
 * 一张卡的「墨色」:实体模式(低保真预览)拿它给代理色块上色。
 *
 * 两个数,缺一个都不行:
 *   - `rgb` 是**按 alpha 加权**的平均颜色 —— 只统计真画了东西的地方。
 *     直接对整个盒子求平均的话,标题卡里九成是透明的,所有文字卡都会被稀释成同一坨灰。
 *   - `cover` 是这张卡有多「实」(0~1):画了东西的面积占盒子的比例。
 *     满底的面板卡接近 1,只有几个字的标题卡是零点几。
 *
 * 代理平面用 `rgba(rgb, cover)` 画,于是面板卡和标题卡在实体模式下**长得不一样** ——
 * 而「这一块压上去是不是太重了」正是浏览时要判断的东西。按 ID 哈希出来的颜色给不了这个。
 */
export interface Ink {
  rgb: [number, number, number];
  cover: number;
}

const REPLACED = new Set(["IMG", "SVG", "CANVAS", "VIDEO", "PICTURE"]);
/** canvas 扫像素时每边最多取样多少档;再大就跳着取,几万个点足够定边界 */
const CANVAS_SAMPLES = 200;
/** 透明度低于这个数的像素当没画 */
const ALPHA_MIN = 8;

function hasOwnText(el: Element): boolean {
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim()) return true;
  }
  return false;
}

function paintsItself(el: Element): boolean {
  const cs = getComputedStyle(el);
  if (cs.backgroundImage !== "none") return true;
  const bg = cs.backgroundColor;
  if (bg && bg !== "transparent" && !/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(bg)) return true;
  if ((parseFloat(cs.borderTopWidth) || 0) > 0 || (parseFloat(cs.borderLeftWidth) || 0) > 0) return true;
  if (cs.boxShadow && cs.boxShadow !== "none") return true;
  return false;
}

function textRect(el: Element): DOMRect | null {
  const range = document.createRange();
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const n of el.childNodes) {
    if (n.nodeType !== Node.TEXT_NODE || !(n.textContent ?? "").trim()) continue;
    range.selectNodeContents(n);
    const rc = range.getBoundingClientRect();
    if (rc.width <= 0 || rc.height <= 0) continue;
    l = Math.min(l, rc.left); t = Math.min(t, rc.top); r = Math.max(r, rc.right); b = Math.max(b, rc.bottom);
  }
  range.detach();
  return r > l && b > t ? new DOMRect(l, t, r - l, b - t) : null;
}

/**
 * canvas 里画了什么,DOM 是看不见的:元素矩形永远是整块画布,于是粒子背景、图表这类卡
 * 一律被判成「铺满整幅」,预览只能退回整幅缩放。这里直接读像素,把真正画到东西的那块框出来。
 *
 * 2D 和 WebGL 画布都支持(靠 drawImage 到离屏画布,见下面的说明)。被跨域图片污染过的
 * 画布读像素会抛 —— 那种情况返回 null,调用方退回元素矩形。返回的是**屏幕坐标**,
 * 和其他几种量法口径一致。
 */
export function canvasBox(el: HTMLCanvasElement): DOMRect | null {
  return canvasRect(el, canvasPixels(el));
}

/** 画布里画了东西的那块,按画布像素记;step 是取样步长。null = 整块空白或读不到像素 */
export interface CanvasPixels {
  l: number;
  t: number;
  r: number;
  b: number;
  step: number;
  w: number;
  h: number;
}

/**
 * 读一遍画布像素,框出画了东西的范围(画布像素坐标)。
 *
 * 这是整个测量里最贵的一步:一张 1920×1080 的画布要 drawImage + getImageData 读回八百万字节,
 * 一次十几毫秒。measureAcrossTime 一趟要拨几十档,档档都读的话一张三维卡就是几百毫秒的长任务。
 * 所以拆成「读像素」和「换算到屏幕」两半:同一趟里画布内容不会变(拨 Web Animations 不跑 JS,
 * 画布只在 requestAnimationFrame 里重画),像素范围读一次就够,每档只重新取元素矩形。
 */
/**
 * 读像素用的离屏画布只留**一张**,按需放大、每次先清空。
 * 每次都 createElement 一张 1920×1080 的话,连续几次读(选框心跳、生成快照、探针)之间 GC 来不及回收,
 * Chrome 的画布内存预算一到,getContext("2d") 就开始回 null —— 实测第三次生成快照起 canvas 的实体框就量不到了,
 * 而且不报错(只是退回整块画布)。
 */
let scratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
function scratchContext(w: number, h: number): CanvasRenderingContext2D | null {
  if (!scratch) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    scratch = { canvas, ctx };
  }
  const { canvas, ctx } = scratch;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;   // 改尺寸本身就清空了画布
    canvas.height = h;
  } else {
    ctx.clearRect(0, 0, w, h);
  }
  return ctx;
}

export function canvasPixels(el: HTMLCanvasElement): CanvasPixels | null {
  const w = el.width, h = el.height;
  if (!w || !h) return null;
  let data: Uint8ClampedArray;
  try {
    /*
     * 不能用 `el.getContext("2d")`:**一个画布只能有一种上下文**,WebGL 画布上它返回 null,
     * 于是三维卡(scene-3d)会退回「元素矩形」= 整块画布 —— 而它多半铺满全屏、四周全透明。
     * 后果是 get_layout 的 contentBox 报「这张卡占满 1920×1080」,而工具描述明写
     * 「判断会不会盖住人看 contentBox」,Agent 会以为无处可放,去挪本来不用挪的东西。
     *
     * `drawImage` 到一张离屏 2D 画布上则两种上下文都通(WebGL 那边靠
     * scene-3d 建渲染器时的 preserveDrawingBuffer:true 保证读得到内容)。
     */
    const ctx = scratchContext(w, h);
    if (!ctx) return null;
    ctx.drawImage(el, 0, 0);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
  const step = Math.max(1, Math.ceil(Math.max(w, h) / CANVAS_SAMPLES));
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (let y = 0; y < h; y += step) {
    const row = y * w * 4;
    for (let x = 0; x < w; x += step) {
      if (data[row + x * 4 + 3] < ALPHA_MIN) continue;
      if (x < l) l = x;
      if (x > r) r = x;
      if (y < t) t = y;
      if (y > b) b = y;
    }
  }
  if (r < l || b < t) return null; // 整块空白
  return { l, t, r, b, step, w, h };
}

/** 像素范围换算到屏幕坐标:取样是跳着走的,边界各外扩一格免得把内容切掉 */
function canvasRect(el: HTMLCanvasElement, px: CanvasPixels | null): DOMRect | null {
  if (!px) return null;
  const { l, t, r, b, step, w, h } = px;
  const rect = el.getBoundingClientRect();
  const sx = rect.width / w, sy = rect.height / h;
  const x0 = Math.max(0, l - step), y0 = Math.max(0, t - step);
  const x1 = Math.min(w, r + step), y1 = Math.min(h, b + step);
  return new DOMRect(rect.left + x0 * sx, rect.top + y0 * sy, (x1 - x0) * sx, (y1 - y0) * sy);
}

/**
 * @param stage  舞台元素(.pc-stage),它的屏幕矩形就是舞台坐标系的原点和比例
 * @param canvasCache  同一趟连续量好几档时传同一个 Map:每张画布的像素只读一次(见 canvasPixels)
 * @returns 舞台坐标下的包围盒;什么都没量到、或者内容本来就铺满舞台时返回 null
 *
 * 比例不从外面传:舞台正在被 transform 过渡的时候,样式里写的目标比例和屏幕上
 * 此刻画出来的比例不是一个数,拿目标比例去除会把坐标算歪。屏幕矩形 / 布局宽度
 * 就是此刻真实的比例,和元素矩形同一瞬间取的,永远对得上。
 */
export function measureContentBox(stage: HTMLElement, canvasCache?: Map<HTMLCanvasElement, CanvasPixels | null>): Box | null {
  const sr = stage.getBoundingClientRect();
  const scale = stage.offsetWidth > 0 ? sr.width / stage.offsetWidth : 0;
  if (sr.width <= 0 || sr.height <= 0 || scale <= 0) return null;
  const stageArea = sr.width * sr.height;
  let box: Box | null = null;
  const add = (r: DOMRect) => {
    if (r.width <= 0 || r.height <= 0) return;
    // 铺满舞台的算背景,不算内容
    if ((r.width * r.height) / stageArea >= 0.9) return;
    const l = Math.max(0, (r.left - sr.left) / scale);
    const t = Math.max(0, (r.top - sr.top) / scale);
    const rr = Math.min(sr.width / scale, (r.right - sr.left) / scale);
    const bb = Math.min(sr.height / scale, (r.bottom - sr.top) / scale);
    if (rr <= l || bb <= t) return;
    box = box ? { l: Math.min(box.l, l), t: Math.min(box.t, t), r: Math.max(box.r, rr), b: Math.max(box.b, bb) } : { l, t, r: rr, b: bb };
  };
  for (const el of stage.querySelectorAll<HTMLElement>("*")) {
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    // 占位平面不是卡片画的东西(product/rendering.md「兜底顺序」):量它就把占位框当成了墨迹框
    if (isPlaceholderNode(el)) continue;
    // svg 内部的子元素不用逐个量,整棵 svg 一个框就够
    if (el.namespaceURI === "http://www.w3.org/2000/svg" && el.tagName !== "svg") continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
    if (REPLACED.has(el.tagName.toUpperCase())) {
      // canvas 先扫像素:画布多半铺满整幅,真正画了东西的只是其中一块
      let painted: DOMRect | null = null;
      if (el.tagName.toUpperCase() === "CANVAS") {
        const cv = el as HTMLCanvasElement;
        let px = canvasCache?.get(cv);
        if (px === undefined) {
          px = canvasPixels(cv);
          canvasCache?.set(cv, px);
        }
        painted = canvasRect(cv, px);
      }
      add(painted ?? el.getBoundingClientRect());
      continue;
    }
    if (hasOwnText(el)) {
      const tr = textRect(el);
      if (tr) add(tr);
    }
    if (paintsItself(el)) add(el.getBoundingClientRect());
  }
  if (!box) return null;
  const b: Box = box;
  const stageW = sr.width / scale;
  const stageH = sr.height / scale;
  // 并出来还是几乎整幅画面,那就按整幅来,不用切
  if (((b.r - b.l) * (b.b - b.t)) / (stageW * stageH) >= 0.85) return null;
  return b;
}

/** 解析 computed style 的颜色。拿不准就返回 null,让调用方跳过这一处而不是记一个瞎猜的颜色 */
function parseColor(v: string): { rgb: [number, number, number]; a: number } | null {
  if (!v || v === "transparent" || v === "none") return null;
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return null;
  const a = p.length >= 4 ? p[3] : 1;
  if (a <= 0) return null;
  return { rgb: [p[0], p[1], p[2]], a };
}

/**
 * canvas 的墨色:直接读像素。
 *
 * 走 `drawImage` 到一张小的离屏 2D 画布上,而不是对原画布 `getContext("2d")` ——
 * 后者对 WebGL 画布返回 null(一个画布只能有一种上下文),三维卡就永远取不到色。
 * 顺带把取样降到 64×64,几千个点足够定一个平均色,还省掉大画布的读回开销。
 *
 * 取不到就返回 null:画布被跨域图片污染过会抛,WebGL 没开 preserveDrawingBuffer 时
 * 拿到的可能是一张空图 —— 两种都不该记成「这张卡是透明的」。
 */
function canvasInk(el: HTMLCanvasElement): { sum: [number, number, number]; weight: number; samples: number } | null {
  const w = el.width, h = el.height;
  if (!w || !h) return null;
  const n = 64;
  try {
    const off = document.createElement("canvas");
    off.width = Math.min(n, w);
    off.height = Math.min(n, h);
    const ctx = off.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(el, 0, 0, off.width, off.height);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    const sum: [number, number, number] = [0, 0, 0];
    let weight = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      if (d[i + 3] < ALPHA_MIN) continue;
      sum[0] += d[i] * a; sum[1] += d[i + 1] * a; sum[2] += d[i + 2] * a;
      weight += a;
    }
    return weight > 0 ? { sum, weight, samples: (d.length / 4) || 1 } : null;
  } catch {
    return null;
  }
}

/**
 * 量这张卡的墨色。走的元素和 measureContentBox **同一套筛子**,只是那边并矩形、这边攒颜色。
 *
 * 颜色不从像素来(DOM 读不到自己的像素),从 computed style 来:
 * 底色取 `background-color`、文字取 `color`,各自按「面积 × alpha」加权。
 * `getComputedStyle` 给的是解析后的最终值,`--pc-glass-bg` 那些变量自动落成具体颜色,
 * **卡片一张都不用改**。canvas 例外,那个真读像素。
 *
 * 嵌套的盒子会被重复计入(外层底色 + 内层底色都算一遍),所以 cover 夹到 1 ——
 * 它要表达的是「这块有多实」,不是精确的覆盖率,重复计入只会让实的更实,方向是对的。
 */
export function measureInk(stage: HTMLElement, box: Box | null): Ink | null {
  const sr = stage.getBoundingClientRect();
  const scale = stage.offsetWidth > 0 ? sr.width / stage.offsetWidth : 0;
  if (sr.width <= 0 || scale <= 0) return null;
  // 参照面积:有内容框就用它,没有就用整个舞台(铺满型的卡)
  const refArea = box ? Math.max(1, (box.r - box.l) * (box.b - box.t)) : (sr.width / scale) * (sr.height / scale);
  const stageArea = sr.width * sr.height;

  const sum: [number, number, number] = [0, 0, 0];
  let weight = 0;

  /** 记一处:颜色 + 它铺了多大(屏幕面积,换算回舞台面积) */
  const add = (c: { rgb: [number, number, number]; a: number }, screenArea: number, opacity: number) => {
    if (screenArea <= 0) return;
    // 铺满舞台的算背景,不算内容 —— 和 measureContentBox 同一条规矩
    if (screenArea / stageArea >= 0.9) return;
    const w = (screenArea / (scale * scale)) * c.a * opacity;
    if (w <= 0) return;
    sum[0] += c.rgb[0] * w; sum[1] += c.rgb[1] * w; sum[2] += c.rgb[2] * w;
    weight += w;
  };

  for (const el of stage.querySelectorAll<HTMLElement>("*")) {
    if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    if (isPlaceholderNode(el)) continue;
    if (el.namespaceURI === "http://www.w3.org/2000/svg" && el.tagName !== "svg") continue;
    const cs = getComputedStyle(el);
    const op = parseFloat(cs.opacity);
    if (cs.display === "none" || cs.visibility === "hidden" || op === 0) continue;

    if (el.tagName.toUpperCase() === "CANVAS") {
      const ink = canvasInk(el as HTMLCanvasElement);
      const rect = el.getBoundingClientRect();
      if (ink && rect.width > 0) {
        // 画布上「画了东西」的那一份面积:有效像素占比 × 画布在屏幕上的面积
        const painted = (ink.weight / ink.samples) * rect.width * rect.height;
        add({ rgb: [ink.sum[0] / ink.weight, ink.sum[1] / ink.weight, ink.sum[2] / ink.weight], a: 1 }, painted, op);
      }
      continue;
    }
    if (REPLACED.has(el.tagName.toUpperCase())) {
      // 图片 / 视频读不到平均色(跨域会污染画布),按中性灰记一笔,只是为了让 cover 反映"这儿有东西"
      const r = el.getBoundingClientRect();
      add({ rgb: [128, 128, 128], a: 1 }, r.width * r.height, op);
      continue;
    }
    if (hasOwnText(el)) {
      const tr = textRect(el);
      const c = parseColor(cs.color);
      // 字不是实心的,一个字框里大概三成是笔画 —— 不打这个折,一行字会比一整块底色还重
      if (tr && c) add(c, tr.width * tr.height * 0.3, op);
    }
    const bg = parseColor(cs.backgroundColor);
    if (bg) {
      const r = el.getBoundingClientRect();
      add(bg, r.width * r.height, op);
    }
  }

  if (weight <= 0) return null;
  return {
    rgb: [Math.round(sum[0] / weight), Math.round(sum[1] / weight), Math.round(sum[2] / weight)],
    cover: Math.min(1, weight / refArea),
  };
}

/**
 * 和 `measureContentBox` 同一套量法,但结果换算到**包裹层自己的局部坐标**(未经旋转 / 缩放的布局像素),
 * 给占位平面摆框用(product/rendering.md「兜底顺序」:占位符在实体框上,继承包裹层的旋转和缩放)。
 *
 * `measureContentBox` 按「屏幕矩形 ÷ 缩放」换算,包裹层带旋转时那是外接矩形,摆回局部坐标就歪了。
 * 这里先还原成屏幕上的外接矩形,再按包裹层的旋转角和等比缩放反解:中心点逆旋转、宽高解一个 2×2 方程
 * (局部轴对齐的矩形转过 θ 之后,外接矩形宽 = w|cos| + h|sin|、高 = w|sin| + h|cos|)。
 * 接近 45° 时方程病态,退回外接矩形的尺寸(偏大、不偏小)。结果夹回包裹层内;量不到回 null。
 */
export function measureLocalContentBox(wrap: HTMLElement, canvasCache?: Map<HTMLCanvasElement, CanvasPixels | null>): { left: number; top: number; width: number; height: number } | null {
  /*
   * 精确路(Item 7):同一个任务里把包裹层**自己的** transform 暂时压成 `none !important`,量完立刻还原 ——
   * 量的时候包裹层没有旋转 / 斜切 / 非等比缩放,`measureContentBox` 的「屏幕矩形 ÷ 等效缩放」正好就是局部坐标;
   * 同步读写之间浏览器不绘制,用户看不到。`!important` 压得住包裹层上的动画;还压不住(计算值仍不是 none)就走下面的反解。
   */
  const exact = measureWithoutOwnTransform(wrap, canvasCache);
  if (exact !== undefined) return exact;
  return measureLocalByInversion(wrap, canvasCache);
}

/** 暂时去掉包裹层自己的 transform 再量;去不掉回 `undefined`(调用方退回反解) */
function measureWithoutOwnTransform(wrap: HTMLElement, canvasCache?: Map<HTMLCanvasElement, CanvasPixels | null>): { left: number; top: number; width: number; height: number } | null | undefined {
  const before = getComputedStyle(wrap).transform;
  if (!before || before === "none") return clampLocal(wrap, measureContentBox(wrap, canvasCache));
  const value = wrap.style.getPropertyValue("transform");
  const priority = wrap.style.getPropertyPriority("transform");
  wrap.style.setProperty("transform", "none", "important");
  try {
    if (getComputedStyle(wrap).transform !== "none") return undefined;
    return clampLocal(wrap, measureContentBox(wrap, canvasCache));
  } finally {
    if (value) wrap.style.setProperty("transform", value, priority);
    else wrap.style.removeProperty("transform");
  }
}

/** `measureContentBox` 的结果(包裹层没有自身变换时就是局部坐标)夹回包裹层内 */
function clampLocal(wrap: HTMLElement, b: Box | null): { left: number; top: number; width: number; height: number } | null {
  if (!b) return null;
  const w = wrap.offsetWidth, h = wrap.offsetHeight;
  if (!(w > 0) || !(h > 0)) return null;
  const left = Math.max(0, b.l), top = Math.max(0, b.t);
  const right = Math.min(w, b.r), bottom = Math.min(h, b.b);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** 退路:按包裹层的旋转角和等比缩放反解(原来的算法;接近 45° 退回外接矩形) */
function measureLocalByInversion(wrap: HTMLElement, canvasCache?: Map<HTMLCanvasElement, CanvasPixels | null>): { left: number; top: number; width: number; height: number } | null {
  const b = measureContentBox(wrap, canvasCache);
  if (!b) return null;
  const sr = wrap.getBoundingClientRect();
  const w = wrap.offsetWidth, h = wrap.offsetHeight;
  if (!(w > 0) || !(h > 0) || !(sr.width > 0)) return null;
  const k = sr.width / w;
  // 还原成屏幕上的外接矩形(measureContentBox 的逆换算)
  const u = { l: sr.left + b.l * k, t: sr.top + b.t * k, r: sr.left + b.r * k, b: sr.top + b.b * k };
  const raw = getComputedStyle(wrap).transform;
  let theta = 0;
  try { if (raw && raw !== "none") { const m = new DOMMatrixReadOnly(raw); theta = Math.atan2(m.b, m.a); } } catch { theta = 0; }
  const c = Math.abs(Math.cos(theta)), s = Math.abs(Math.sin(theta));
  // 包裹层的等效缩放(含祖先):外接矩形宽 = S × (w|cos| + h|sin|)
  const S = sr.width / (w * c + h * s);
  if (!(S > 0)) return null;
  const uw = (u.r - u.l) / S, uh = (u.b - u.t) / S;
  const det = c * c - s * s;
  let cw = uw, ch = uh;
  if (Math.abs(det) > 0.2) {
    cw = (c * uw - s * uh) / det;
    ch = (c * uh - s * uw) / det;
    if (!(cw > 0) || !(ch > 0)) { cw = uw; ch = uh; }
  }
  // 中心点:相对包裹层外接矩形中心的屏幕偏移,逆旋转、除以缩放,再挪回局部坐标
  const dx = (u.l + u.r) / 2 - (sr.left + sr.right) / 2;
  const dy = (u.t + u.b) / 2 - (sr.top + sr.bottom) / 2;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const cx = (cos * dx + sin * dy) / S + w / 2;
  const cy = (-sin * dx + cos * dy) / S + h / 2;
  const left = Math.max(0, cx - cw / 2), top = Math.max(0, cy - ch / 2);
  const right = Math.min(w, cx + cw / 2), bottom = Math.min(h, cy + ch / 2);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return { l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) };
}

/**
 * 把舞台里的动画从头拨到尾,每一档量一次包围盒取并集 —— 动效整段占过的最大范围。
 *
 * 用 Web Animations 的 currentTime 同步拨,不靠 requestAnimationFrame:窗口在后台、
 * 动画被浏览器节流时照样量得出来,而且一次调用就出结果,不用真等它播完。拨不动的部分
 * (跟 t 走的 Lottie、打字机)按当前这一帧算。量完把动画拨回 0。
 */
export function measureAcrossTime(stage: HTMLElement, totalMs: number, stepMs = 100): Box | null {
  const anims = stage.getAnimations({ subtree: true });
  const seek = (t: number) => {
    for (const a of anims) {
      try {
        a.pause();
        a.currentTime = t;
      } catch {
        // 已经结束 / 只读的动画不让改,跳过
      }
    }
  };
  let union: Box | null = null;
  // 画布像素这一趟只读一次:拨动画不会让画布重画(见 canvasPixels),每档只重取元素矩形
  const canvasCache = new Map<HTMLCanvasElement, CanvasPixels | null>();
  for (let t = 0; t <= totalMs; t += stepMs) {
    seek(t);
    union = unionBox(union, measureContentBox(stage, canvasCache));
  }
  seek(0);
  return union;
}

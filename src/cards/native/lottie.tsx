import { useEffect, useRef } from "react";
import lottie, { type AnimationItem } from "lottie-web";
import type { CardDef, CardProps } from "../../kernel/types";
import { assetOptions } from "../catalogAssets";
import { isExportMode } from "../../kernel/clock";
import { beginFrameWork } from "../../kernel/frameReady";
import { withSeededRandom } from "../../kernel/pinEntropy";

/**
 * Lottie 卡:把一段 Lottie 动画(After Effects 导出的 JSON)放到舞台上,按时间轴逐帧定位。
 *
 * 这张卡是 remotion 式的(`frameMode: "direct"`,2026-10-10 用户定,渲染重构「癸」落到代码上):lottie-web 的
 * goToAndStop(frame, true) 是「跳到第几帧并渲染」,不靠任何时钟自己往前走。所以这张卡**读 t**,每帧把 t 换算成帧号
 * 直接跳过去;不用 autoplay,导出页里再把 lottie 的 rAF 循环冻住(它只服务 autoplay 的动画,这里没有)。
 * 光这样还不够「每一帧只由素材、参数、帧号决定」:播放库里有随机数,还有一处属性值会留旧数。下面
 * 「画面只由素材、参数、帧号决定」那一段把它们固定住,缺省就开着。
 *
 * **建实例和跳帧一律走 `loadLottie` 和它给的 `goTo`**,不要绕过去直接调播放库的 `loadAnimation`、`goToAndStop`:
 * 绕过去的话表达式各用各的一串随机数,属性值也会留旧数,顺着推和直接跳就可能不同。别的文件要放 Lottie 用
 * `LottieView`(部件 `src/parts/lib/media-lottie.tsx`、素材封装卡 `src/cards/assets/index.ts` 都是)。
 * 探针 `scripts/probes/lottie-seed-probe.mjs` 会查 `src/` 里除本文件外没有别处引播放库。
 *
 * **升级播放库(`lottie-web`,现在 5.13.0)之前先重跑两个探针**:`scripts/probes/lottie-seed-probe.mjs` 和
 * `scripts/probes/lottie-seed-extra-probe.mjs`。下面的做法靠着播放库的几处内部细节(表达式怎么编译、建属性的口子、
 * 算文字排版的函数名),换版本可能悄悄失效;失效时控制台会有 `[lottie]` 开头的警告,探针把警告算失败。
 *
 * 数据两个来源:json(内联的 JSON 文本,优先)或 src(URL)。内联的没有网络,导出最稳;
 * src 走 fetch,导出脚本的 pauseIfNetworkFetchesPending 会等它加载完再推进虚拟时间。
 *
 * 素材许可证:lottie-web 本身是 MIT,但 LottieFiles 上的动画文件各有各的许可,用之前逐个看。
 */

interface Params {
  json: string;
  src: string;
  speed: number;
  loop: string;
  fit: string;
}

/** 内置的演示动画:一个圆角方块从左滑到右、转一圈、淡入。手写的,没有第三方素材许可问题。 */
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
 * ── 画面只由素材、参数、帧号决定(三个开关,互相独立)──
 *
 * 要的是:从头顺着推到第 N 帧,和新建一份直接跳到第 N 帧,画面相同;和页面里别的卡取过几次随机数无关。
 * 播放库(lottie-web 5.13.0)里有三处让它做不到。前两处是随机数,开关一和开关三是对付它的两种办法(可以只开一个,
 * 也可以都开);第三处和随机数无关,归开关二。
 *
 * **正式用的一组缺省就开着**(2026-10-12 用户定):开关三(换掉表达式里的随机函数)、外面那一层、开关二(属性值不留旧数)。
 * 开关一缺省关,只留着给探针做对照。舞台、导出页、在线页面用的是同一份代码、同一个缺省,所以预览和导出取到的是同一串数。
 * 关掉只为探针对照:页面地址带 `lottieExpr=0` / `lottieExact=0`,或建实例之前把 `window.__pcLottieExpr` / `__pcLottieExact` 设成 false。
 * 实测与数字见 `scripts/probes/lottie-seed-probe.mjs`、`scripts/probes/lottie-seed-extra-probe.mjs` 和
 * `docs/plan/render-standard.md`「Lottie 动效」。
 *
 * 已知而没处理的一处,是播放库现在就有的毛病:表达式第一次求值就抛错时,那一帧画到一半中止,之后这个属性被锁住不再求值;
 * 错落在哪一帧取决于怎么到达,所以带坏表达式的素材画面仍可能随到达方式变。
 *
 * ── 开关一:覆盖随机数种子(2026-10-12 用户:「我觉得可以覆盖随机数种子。」)──
 *
 * 播放库的表达式有自己的一串随机数(源码里叫 `BMMath.random`),**全页所有 Lottie 共用一串**。页面里还没有任何表达式
 * 给它播过种时,它就是全页共用的 `Math.random`(kernel/pinEntropy.ts 钉住的那一串);第一次播种之后换成播放库自带的
 * 发生器,再不回头。两处从这一串里取数的方式都和「之前发生过什么」有关:
 *
 *   1. 每个带表达式的属性在**建图层时**从这一串里取一个 `randSeed`(不管表达式里用没用随机)。表达式里出现 `random`
 *      这个词的,每次求值先按 `randSeed + 时间` 重新播种,所以这类表达式的值只跟 randSeed 和帧号有关——但 randSeed
 *      本身跟「这份实例建的时候那一串走到哪了」有关:页面里别的卡取过几次 `Math.random`、别的 Lottie 推过哪些帧。
 *   2. 表达式里**只有 `wiggle()`、没有 `random` 这个词**的,求值前不重新播种,直接从这一串里接着取。
 *      取到什么跟之前推过哪些帧、别的 Lottie 推过什么有关——同一份实例顺着推和跳着推都不一样。
 *
 * 做法:
 *   - 种子 = 素材内容的散列(`lottieSeedOf`)。同一份 JSON 无论从哪个地址来、在哪台机器上、换行符是哪种,种子相同。
 *     速度、循环、适配不进种子:它们只决定「t 对应第几帧」和怎么摆,不该改变某一帧的内容。
 *   - 建图层之前把播放库那一串按「种子 + build」重新播种(`BMMath.seedrandom`):各属性的 randSeed 从这里起按建图层的
 *     固定顺序取完(`progressiveLoad: false` 时播放库在装载完成那一下把所有图层、连同嵌套合成里的一次建好,不是用到才建)。
 *     字体或外部数据没到齐时,建图层发生在播放库自己的定时器回调里,所以把这份实例的 `checkLoaded` 也包进去。
 *   - 每画一帧之前按「种子 + 帧号」重新播种。这样第 2 条里的 wiggle 拿到的数只跟帧号有关。装载完成那一下播放库
 *     自己画的那一次用的是建图层取剩的数,所以紧接着按帧号重画一遍。
 *   - 以上每一段都再包在「外面那一层」里(见下,开关一和开关三共用)。
 *   - `BMMath` 播放库没有导出。表达式的代码是在它的作用域里求值的,能看到它(名字是 `Math`)和 `globalData`,
 *     所以建一份只有一个空图层的一次性动画,让它的表达式把 `Math` 挂到 `globalData` 上,取出来就销毁。
 *     全页只取一次。取不到(播放库换了版本、关了表达式)就只剩外面那一层,并在控制台说一声:
 *     那一层只在播放库那一串还没被播过种时管得到表达式。
 *
 * ── 开关三:替换表达式里的随机函数(2026-10-12 用户:「能不能用替换方式直接覆盖,比如替换 random 为 random_in_card()」)──
 *
 * 不去碰播放库那一串,而是让表达式根本不用它:交给播放库之前改写素材里每个表达式的原文,包一层函数,把
 * `random`、`seedRandom`、`wiggle`、`Math` 这几个名字遮成卡片自己的(`wrapLottieExpression`、`lottieExprRuntime`)。
 * 改写以后没有任何表达式再读播放库内部那一串,所以这个开关不取它、不给它播种。表达式以外的随机归外面那一层。
 * 观感照播放库现在的不变(2026-10-12 用户定的原则,见 `lottieExprRuntime` 的说明):卡片这边同样是「同一帧里各表达式
 * 共用一串、按求值先后接着取」,wiggle 照旧逐帧跳,seedRandom 照旧不看第二个参数,同一个合成放几份照旧各动各的;
 * 改掉的只有一处:这一串每一帧的起点由(素材、帧号)定,不再接着上一帧剩下的取。
 * 和开关一比:不用取播放库内部的随机源、不用给它播种。
 *
 * ── 外面那一层(开关一、开关三只要开了一个就有;2026-10-12 用户:「你帮我在外面也兜住,把播放库的随机数也固定。」)──
 *
 * 管的是播放库自己直接调全页 `Math.random()` 的地方,不经过表达式:
 *   - 建实例、装载完成(含异步装载的那个回调)、每次跳帧,都包在 `withSeededRandom` 里。建图层一串(素材种子),
 *     画第 N 帧一串(素材种子、N)。全页共用的那一串不被 Lottie 挪动。
 *   - 文字图层的「随机顺序」单独按(素材、图层、文字内容)固定(`hookTextOrder`)。它每份内容只算一次、在哪一帧算不固定,
 *     只按帧号播种反而会让顺着推和直接跳不同。
 * 播放库里所有取随机数的地方、各归哪一层管,列在 docs/reports/AGENT-lottie-seed.md「播放库里的随机来源」。
 *
 * ── 开关二:属性值不留旧数(查自带素材 happy2016 那 0.0036% 的像素差时找到的;2026-10-12 用户:「不要差像素。」)──
 *
 *   3. 播放库更新一个属性的值时,新值和手里的旧值差不到 0.00001 就**不更新**(`setVValue`)。顺着推时值一点点变,
 *      最后几步每步都不到这个门槛,就停在离终点差一点的地方;直接跳过去拿到的是准确的终点。两边差不到 0.00001,
 *      但落到变换矩阵上是 `1.0000001192092896` 对 `1`,光栅化出来有几十个边缘像素不同。和随机数无关,开关一管不到。
 *
 * 做法:播放库自己就是靠换掉 `PropertyFactory.getProp` 来给属性加表达式的,这里用同一个口子(`lottie.__getFactory`)
 * 再包一层:本开关开着的实例在建属性时,把它的 `setVValue` 换成「不相等就更新」。别的实例不受影响。
 *
 * ── 浏览器不重画嵌套的蒙版(2026-10-13 留底时查到;和播放库无关,是浏览器的毛病)──
 *
 *   4. 播放库把图层蒙版画成 SVG 的 `<mask>`。蒙版里面再套一层(`<g>`,里面的路径又挂着别的裁剪)时,里面那一层变了,
 *      Chrome(152 实测)不重画用这张蒙版的图层:DOM 是对的,屏幕上留着旧画面,直到别的改动碰巧让它重画。
 *      自带的 `navidad` 顺着推时第 51～81 帧脸上那块底色一直不出来(最多 17 万个像素),直接跳到这些帧却是对的。
 *      截图、预览、导出走的都是浏览器这一次绘制,所以都中招。
 *
 * 做法:装载完成后找出里面套了东西的蒙版(含 `<g>`、`<use>`,或挂着裁剪、蒙版、滤镜的),每跳一帧把它们各自的第一个子节点
 * 摘下来再原位放回去。DOM 序列化出来一个字不变,浏览器却会照新内容重画用它的图层;实测画出来的和直接跳的逐像素相同。
 * 只动这几张蒙版,不逼整棵 SVG 重排(那样画出来的边缘像素会和不逼时差一点)。
 */

/** 读一个开关:`window[key]` 是布尔就用它,否则看页面地址里的同名参数(1 开、0 关),都没有就用缺省 */
function flagOf(key: "__pcLottieSeed" | "__pcLottieExact" | "__pcLottieExpr" | "__pcLottieRepaint", query: string, dflt: boolean): boolean {
  if (typeof window === "undefined") return dflt;
  const flag = (window as unknown as Record<string, unknown>)[key];
  if (typeof flag === "boolean") return flag;
  try {
    const q = new URLSearchParams(window.location.search).get(query);
    return q === "1" ? true : q === "0" ? false : dflt;
  } catch { return dflt; }
}

/** 开关一:缺省关,只给探针对照用。开法:页面地址带 `lottieSeed=1`,或在建实例之前设 `window.__pcLottieSeed = true`(设成 false 压过地址) */
export function lottieSeedEnabled(): boolean {
  return flagOf("__pcLottieSeed", "lottieSeed", false);
}

/** 开关二:**缺省开**。关掉只为探针对照:页面地址带 `lottieExact=0`,或在建实例之前设 `window.__pcLottieExact = false` */
export function lottieExactEnabled(): boolean {
  return flagOf("__pcLottieExact", "lottieExact", true);
}

/** 开关三:**缺省开**。关掉只为探针对照:页面地址带 `lottieExpr=0`,或在建实例之前设 `window.__pcLottieExpr = false` */
export function lottieExprEnabled(): boolean {
  return flagOf("__pcLottieExpr", "lottieExpr", true);
}

/**
 * 逐帧提醒浏览器重画嵌套的蒙版(见下「浏览器不重画嵌套的蒙版」):**缺省开**。
 * 关掉只为探针对照:页面地址带 `lottieRepaint=0`,或在建实例之前设 `window.__pcLottieRepaint = false`
 */
export function lottieRepaintEnabled(): boolean {
  return flagOf("__pcLottieRepaint", "lottieRepaint", true);
}

/** 素材内容 → 32 位种子(FNV-1a)。要在交给播放库**之前**算:播放库会原地改这份数据 */
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

/** 取播放库内部的随机源(见上)。全页只做一次;自己那一个表达式取的 randSeed 不算进全页那一串 */
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
  } catch { /* 取不到按没取到办 */ }
  if (!lottieMath) console.warn("[lottie] 取不到播放库内部的随机源:只有 wiggle() 的表达式仍会和推帧路径有关");
  return lottieMath;
}

/** 播放库里一个属性对象上本原型用到的那几样 */
interface LottieProp { propType?: string; mult: number; v: number | number[] | Float32Array; _mdf: boolean; setVValue?: (val: any) => void }

/** 播放库 setVValue 的「不相等就更新」版:原版是差不到 0.00001 就不更新(见上第 3 条) */
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

/** 正在建的这份实例开没开开关二。只在建属性的那一段同步代码里为 true */
let exactBuilding = false;
let propertyFactoryHooked: boolean | undefined;

/** 在播放库建属性的口子上包一层(见上)。全页只包一次;`exactBuilding` 为 false 时原样放行 */
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
  } catch { /* 包不上按没包上办 */ }
  if (!propertyFactoryHooked) console.warn("[lottie] 包不上播放库建属性的口子:属性值仍会留旧数,顺着推和直接跳可能差一点");
  return propertyFactoryHooked;
}

// ── 开关三:替换表达式里的随机函数 ──

/** mulberry32:和 kernel/pinEntropy.ts 同一个算法,这里每次要一串自己的 */
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

/** 把几个 32 位整数搅成一个种子 */
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
/** 一个数(时间、seedRandom 的参数)的 64 位原样拆成两个整数:不取整、不转字符串,同一个数永远得到同一对 */
function bitsOf(x: number): [number, number] {
  f64[0] = x;
  return [u32[0], u32[1]];
}

/** 各串的用途号,进种子:不同用途的随机数互不相干 */
const STREAM_EVAL = 1, STREAM_SEEDED = 3, STREAM_MATH_SEEDED = 5, STREAM_FRAME = 6;

/** 一串随机数现在走到哪了。里面的 next 会被整个换掉(重新播种) */
interface ExprStream { next: () => number }

/**
 * 「这一帧里各表达式共用的那一串」。只在某份开了开关三的实例被包住的那一段同步代码里(建实例、装载完成、跳帧)不为 null;
 * 那一段开头由 `loadLottie` 按(素材种子、帧号)定好起点,结束时放回原来的值,所以两份实例交替画帧互不相干。
 */
let exprShared: ExprStream | null = null;

/**
 * 改写后的表达式每次求值调一次,拿到这一次用的四样东西:random、seedRandom、wiggle、换掉了 random 的 Math。
 *
 * 原则(2026-10-12 用户定):固定随机数只为让每次结果一致,不改变原来的观感。所以这里照着播放库现在的样子做——
 * 播放库里**所有表达式共用一串随机数,同一帧里按求值的先后接着取**——只把这一串每一帧的起点固定住:
 *
 *   这一帧的起点   开始画一帧时由(素材种子、帧号)定(`loadLottie` 里)。播放库现在是接着上一帧剩下的取,
 *                  所以和之前画过什么有关;这是唯一改掉的地方。
 *   求值之前       表达式原文里有 `random` 这几个字母的,把共用的这一串换成由(素材、表达式编号、时间)定的一串。
 *                  对应播放库的 `_needsRandom` 和 `seedRandom(randSeed + time)`。原文里没有的不换,接着前一个表达式留下的取。
 *   random       调用形式照播放库的:无参 0～1;一个参数是上限;两个参数是下限上限;参数是数组时各分量共用一个随机数。
 *   wiggle       算法照播放库的:频率写死成 5,累加 floor(时间×5) 组随机数,再加下一组乘以小数部分。
 *                「时间」读的是调用那一刻的 `time`(表达式里先调过 posterizeTime 的话是改过的),和播放库一样。
 *   seedRandom   照播放库现在的规矩,不看第二个参数:把共用的这一串换成由(素材、表达式编号、参数)定的一串,不带时间。
 *   Math         `Math.random()` 也从共用的这一串取;`Math.seedrandom(x)`(播放库把它的播种函数也挂在 Math 上)同样换这一串。
 * random、wiggle、Math.random 都从共用的这一串**当前的位置**接着取。于是和播放库现在一样:只写了 wiggle、排在别人的
 * seedRandom 后面求值的表达式,接着那一串不带时间的数取,看起来是连续的;排在最前面、前面没人播过种的,从这一帧的起点取,
 * 逐帧跳;一个表达式求值到一半去读另一个带随机表达式的属性,后者中途换掉这一串,前者接着换过的取。
 * 播放库没有 `gaussRandom`,这里也不补:表达式里用了,和现在一样按播放库的方式失败。
 *
 * 「同一帧里求值的先后」只跟素材和帧号有关(播放库每帧从最后一层往前、只算在场的图层,每个表达式一帧只算一次),
 * 所以画面只跟素材和帧号有关。
 *
 * 万一表达式在那一段同步代码之外被求值(`exprShared` 为 null:有人绕过 `loadLottie` 给的 goTo 直接调播放库的
 * `goToAndStop`、`resize`、`updateDocumentData` 之类),退回每个表达式自己的一串(素材、表达式编号、时间):
 * 仍然每次一致,只是「排在别人的 seedRandom 后面的 wiggle」不再连续。卡片自己不会走到这里。
 *
 * value 是表达式拿到的属性原值。播放库的 wiggle 用的是 `this.pv`:带关键帧的属性两者是同一个对象;不带关键帧的多维属性
 * `pv` 是原值存成单精度的样子,所以这里先取单精度再算,结果和用 `pv` 逐位相同(探针核对过)。
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

/** 改写后的表达式靠这个全局名字找到上面那个函数。每个页面(舞台、导出页)各自装一次 */
const EXPR_RUNTIME = "__pcLottieFn";
function installLottieExprRuntime(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g[EXPR_RUNTIME] !== "function") g[EXPR_RUNTIME] = lottieExprRuntime;
}

/** 改写过的表达式以它开头,用来认出「已经改写过」 */
const EXPR_MARK = "/*pc-expr*/";

/**
 * 把一段表达式原文包一层:原文原样放进一个函数体,函数的形参叫 random、seedRandom、wiggle、Math,
 * 把播放库作用域里的同名东西遮住;实参在外层求值,所以拿得到播放库的 `time`、`value`、`Math`。
 * 不去找调用点替换(正则会误伤字符串、属性名、别的标识符);原文里自己再声明同名变量或函数照常遮住形参,不出错。
 *
 * 第一个形参就是标识符 random,只是把其中的字母 a 写成了 Unicode 转义,文本里不出现这个词:播放库看表达式文本里有没有
 * 这六个字母来决定求值前要不要给它自己那一串播种(`_needsRandom`),这样包完以后它的判断和包之前一样,我们不多惊动它。
 * 原文后面先换行再接 `return`:原文最后一行是 `//` 注释时不会把 return 一起注释掉。
 * 倒数第二个实参是「现在的 time」:表达式里调 posterizeTime 会改 `time`,wiggle 要读改过以后的。
 * 最后一个实参是原文里有没有 `random` 这几个字母(和播放库的 `_needsRandom` 同一个判法,区分大小写):有的求值前先换一串。
 */
function wrapLottieExpression(source: string, seed: number, id: number): string {
  return `${EXPR_MARK}var $bm_rt = (function (r\\u0061ndom, seedRandom, wiggle, Math) {\nvar $bm_rt;\n${source}\n;return $bm_rt;\n}).apply(null, ${EXPR_RUNTIME}(${seed}, ${id}, time, value, Math, function () { return time; }, ${source.indexOf("random") !== -1 ? 1 : 0}));`;
}

/** 这段表达式原文里有没有可能取随机数(名字里带 random、wiggle,或者用到 Math) */
const MAY_DRAW = /random|wiggle|math/i;

/**
 * 改写素材数据里所有表达式(原地改;要在交给播放库之前、算完种子之后做)。返回改写了几处。
 * 表达式 = 带 `k` 的属性对象上那个字符串 `x`。编号 = 它在素材里的位置的散列,换个页面、换台机器不变。
 *
 * 嵌套合成被引用多次时(同一个合成放了几份):播放库现在给每一份里的表达式各取一个 `randSeed`,几份各动各的。
 * 为了保住这一点,带随机表达式的合成每被引用一次就复制一份、各自改写,编号里带上「是从哪个图层进来的」;
 * 原来那份没人引用了就拿掉。不带随机表达式的合成不复制。
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
    // 这个合成(连同它里面嵌的)有没有可能取随机数的表达式
    const memo = new Map<string, boolean>();
    const draws = (id: string): boolean => {
      const known = memo.get(id);
      if (known !== undefined) return known;
      memo.set(id, false); // 自己嵌自己时不绕圈
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
    // 复制过的原件:除非别处(字形)还引用它,否则拿掉
    const stillUsed = JSON.stringify(root.chars ?? null);
    root.assets = root.assets.filter((a) => !(a && typeof a === "object" && copied.has((a as Comp).id) && !stillUsed.includes(JSON.stringify((a as Comp).id))));
  }
  // 其余的(没复制的合成、字形、别处):按它在 JSON 里的路径编号
  wrapIn(data, "");
  return count;
}

// ── 外面那一层:播放库自己直接取随机数的地方(开关一、开关三共用)──

/** 外面那一层各串的用途号 */
const OUTER_BUILD = 11, OUTER_FRAME = 12, OUTER_TEXT = 13;

/**
 * 文字图层「随机顺序」动画器正在给哪份素材算。只在某份实例被包住的那一段同步代码里不为 null;
 * 为 null 时(别的没开开关的 Lottie)播放库照原样算。
 */
let textSeedNow: number | null = null;
/**
 * 文字内容的表达式要不要照「不留旧内容」的办法算(见 `hookTextOrder` 第二段)。只在某份开着外面那一层的实例被包住的
 * 那一段同步代码里为 true。
 */
let textFreshNow = false;
let textOrderHooked: boolean | undefined;

/** 素材里有没有文字内容带表达式的文字图层(`t.d.x`) */
function hasTextExpression(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasTextExpression);
  const o = node as Record<string, unknown>;
  const doc = (o.ty === 5 ? (o.t as { d?: { x?: unknown } } | undefined)?.d : undefined);
  if (doc && typeof doc.x === "string") return true;
  return Object.keys(o).some((key) => hasTextExpression(o[key]));
}

/** 素材里有没有「随机顺序」的文字动画器(选择器上 `rn: 1`) */
function hasRandomTextOrder(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasRandomTextOrder);
  const o = node as Record<string, unknown>;
  if (o.rn === 1) return true;
  return Object.keys(o).some((key) => hasRandomTextOrder(o[key]));
}

/**
 * 文字图层的「随机顺序」:播放库在「算一份文字内容的排版」时(`TextProperty.completeTextData`)直接调 `Math.random()`
 * 打乱字符顺序,每份文字内容只算一次、算完记住。什么时候算不固定:不带关键帧的文字在建图层时算;带关键帧的,
 * 每个关键帧的内容在**第一次画到它**的那一帧才算。所以只按帧号给外面那一层播种不够——顺着推是在关键帧那一帧算的,
 * 直接跳是在跳到的那一帧算的,打乱的结果就不同。
 *
 * 这里把这一处单独固定:算哪一份,就用(素材种子、图层、文字内容)播种,和在哪一帧算、之前算过什么都无关。
 * `TextProperty` 没有导出,所以建一份只有一个文字图层的一次性动画,从它身上取到原型,包住 `completeTextData`。
 * 全页只包一次;素材里没有随机顺序的文字、也没有带表达式的文字内容时不做。
 *
 * 同一个原型上另包一处,和随机数无关(2026-10-13 补测「表达式改了文字内容再配随机顺序」时查到的):文字内容带表达式时,
 * 播放库每帧先把手里那份排版结果的文字改写成关键帧上的原文,再拿它和表达式算出的文字比,一样就**原样留用手里那份**
 * (`getExpressionValue`)。手里那份要是上一帧表达式换出来的另一段文字的排版,这一帧表达式又回到了原文,画出来的仍是
 * 上一段文字——顺着推和直接跳就不同。这里改成不看手里那份:表达式算出原文就用关键帧自己那份排版,算出别的就从关键帧
 * 那份另起一份。只对包住的那一段里的实例生效,别的(没开外面那一层的)照原样。
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
          // 字形留一个空的组:播放库整理数据时会往 shapes[0].it 里补一项变换
          chars: [{ ch: "A", size: 1, style: "Regular", w: 1, fFamily: "PcText", data: { shapes: [{ ty: "gr", it: [] }] } }],
          // 图层的入点在动画之外:只建不画
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
          // 图层 = 它所在的合成(嵌套合成用素材里的 refId)加上它在合成里的序号
          const layer = lottieSeedOf(`${String(this.elem?.comp?.data?.refId ?? "")}/${String(this.elem?.data?.ind ?? "")}`);
          return withSeededRandom(mixSeed(textSeedNow, OUTER_TEXT, layer, lottieSeedOf(String(doc?.t ?? ""))), () => original.call(this, doc));
        };
        textOrderHooked = true;
        // 文字内容的表达式:不留旧内容(见上第二段)。播放库没有这个函数(关了表达式的构建)时不包,也不算失败
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
 * 三个开关各开没开(expr 不写当关);repaint 是「逐帧提醒浏览器重画嵌套的蒙版」,不写时看 `lottieRepaintEnabled()`。
 * debug 只给探针对照用:"no-outer" 不要外面那一层;"no-text-key" 外面那一层照旧按帧播种,但不单独固定文字的随机顺序。
 */
export interface LottieMode { seed: boolean; exact: boolean; expr?: boolean; repaint?: boolean; debug?: "no-outer" | "no-text-key" }

/** 一份建好的动画:跳帧一律走 goTo。seed 是素材种子,开关一、开关三都没开时为 null */
export interface LottieHandle {
  anim: AnimationItem;
  seed: number | null;
  exact: boolean;
  /** 开关三开着时改写了几个表达式;没开为 null */
  rewritten: number | null;
  goTo(frame: number): void;
}

/**
 * 建一份动画实例。缺省(不传 mode)是正式的一组:开关三、外面那一层、开关二开着,开关一关着;照上面那段说明办。
 * 开关三会原地改写 data 里的表达式。三个开关都关着时就是原来那两句:`lottie.loadAnimation` 和 `goToAndStop(frame, true)`。
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
    // 画在 SVG 上,不用画布(2026-10-10 用户定):自带素材里带遮罩层的那一个用画布画出来是错的,SVG 兼容性更好;
    // 要像素时把 SVG 直接变成像素,速度够用。实测见 docs/plan/render-standard.md「Lottie 动效」
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
  // 播放库内部的随机源只有开关一用;只开开关三时不取它、不给它播种
  const math = mode.seed ? captureLottieMath() : null;
  /** 建好的实例。建之前(同步建的那一段里)还是 null,那时播放库画的是第 0 帧 */
  let built: AnimationItem | null = null;
  // 外面那一层(开关一、开关三都有):播放库直接调全页 `Math.random()` 的地方
  const outerOn = seed !== null && mode.debug !== "no-outer";
  const randomText = hasRandomTextOrder(data);
  const textHooked = outerOn && (randomText || hasTextExpression(data)) && hookTextOrder();
  const textKeyed = textHooked && randomText && mode.debug !== "no-text-key";
  /**
   * 播放库里可能建图层、可能画一帧的同步代码都从这里过:建实例、装载完成(含异步装载的那个回调)、跳帧。
   * key 是这一段用哪一串:建图层用 "build",画一帧用它的帧号。
   *   - 外面那一层:全页的 `Math.random` 在这一段里换成(素材种子、key)那一串,出来放回原样。画第 N 帧时播放库直接取到的
   *     随机数只跟素材和 N 有关,全页那一串也不被 Lottie 挪动。
   *   - 文字的随机顺序另按(素材、图层、文字内容)固定,见 `hookTextOrder`。
   *   - 开关一另外给播放库内部那一串按同一个 key 播种。
   *   - 开关三另外定好「这一帧里各表达式共用的那一串」的起点(见 `lottieExprRuntime`)。
   */
  const guarded = <T,>(key: "build" | number, fn: () => T): T => {
    const outerExact = exactBuilding, outerText = textSeedNow, outerFresh = textFreshNow, outerShared = exprShared;
    exactBuilding = exact;
    textSeedNow = textKeyed ? seed : null;
    textFreshNow = textHooked;
    // 开关三:这一帧里各表达式共用的那一串,起点 =(素材种子、帧号)。建实例 / 装载完成那一段里播放库会自己画一次当前帧
    // (建图层本身不求值表达式),所以那一段用的也是当前帧的帧号。外面那一层在那一段里用的却是建图层那一串,所以装载完成后
    // 还要按帧号重画一遍(见 redraw)
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
   * 装载完成那一下播放库会自己画一次当前帧,那一次是在「建图层」那一段里画的:全页的 `Math.random` 用的是建图层那一串
   * (而且前面被各表达式的 randSeed 取走几个,取走几个还跟页面里之前有没有别的 Lottie 播过种有关),开关一下播放库内部那一串
   * 也是建图层取剩的。以后再跳回这一帧,用的是「种子 + 帧号」那一串,画出来就可能不一样。所以装载完成后按帧号原地重画一遍
   * (`renderFrame(null)` 是播放库里「当前帧再画一次」的写法),和以后跳到这一帧走同一条路。
   * 只开开关三、表达式又规规矩矩用 random / wiggle 的素材,两次画出来本来就一样(那一段里表达式共用的那一串起点已经是当前帧);
   * 差别出在表达式绕过去直接用全局的 `Math.random`、`crypto` 的素材上(2026-10-13 补测时查到),所以一律重画。
   */
  const redraw = () => {
    if (mode.seed || outerOn) {
      const item = anim as unknown as { currentRawFrame: number; renderer?: { renderFrame?: (frame: number | null) => void } };
      guarded(Number(item.currentRawFrame) || 0, () => item.renderer?.renderFrame?.(null));
    }
    repaintMasks();
  };
  /** 浏览器不重画嵌套的蒙版(见文件头第 4 条):这份实例里要逐帧提醒的那几张。装载完成以后图层才建全,那时才找 */
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
    // 字体 / 外部数据没到齐:建图层和第一次画都在播放库的定时器回调里,把这份实例的 checkLoaded 包进来
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

/** LottieView 的输入:和卡片参数同名,素材封装卡(src/cards/assets)把 src 固定后也用它 */
export interface LottieViewProps {
  json: string;
  src: string;
  speed: number;
  loop: string;
  fit: string;
  t?: number;
}

/**
 * 渲染核心:给定数据来源和 t,把动画定位到对应帧。这是「函数翻译」那一层的产物 ——
 * 素材目录里的每个 Lottie 文件都通过它变成一张封装卡,卡片之间只差 src。
 */
export function LottieView(params: LottieViewProps) {
  const t = params.t ?? 0;
  const box = useRef<HTMLDivElement>(null);
  const anim = useRef<LottieHandle | null>(null);
  const meta = useRef({ fr: 30, total: 0 });
  /** 最新的 t。装载是异步的(src 要 fetch),装完那一刻得知道「现在该停在哪一帧」 */
  const wantT = useRef(t);
  wantT.current = t;

  /** t → 帧号。装载完成时和 t 变化时都要算,所以只写一处 */
  const frameAt = (sec: number) => {
    const { fr, total } = meta.current;
    const f = sec * fr * (params.speed > 0 ? params.speed : 1);
    return params.loop === "yes" ? f % total : Math.min(f, total - 1);
  };

  // 加载 / 换素材
  useEffect(() => {
    let dead = false;
    const ready = beginFrameWork('lottie');
    const mount = (data: any) => {
      if (dead || !box.current) return;
      anim.current?.anim.destroy();
      box.current.innerHTML = "";
      // 建实例和跳帧都经 loadLottie(见文件头):随机数和属性值在那里固定住
      const handle = loadLottie(box.current, data, params.fit);
      const a = handle.anim;
      meta.current = { fr: Number(data.fr) || 30, total: Math.max(0, (Number(data.op) || 0) - (Number(data.ip) || 0)) };
      anim.current = handle;
      /*
       * **停在当前 t,不是第 0 帧。**
       *
       * 装载是异步的(src 要 fetch),而下面那个「t 变了就跳帧」的 effect 只在 t 真的变的时候跑。
       * 装完得比最后一次 t 变化还晚,它就再也不会被触发 —— 动画从此钉死在第 0 帧,
       * 而且不报错。实测 lottie-adrock 在 t=3.0s:导出是角色站定的最后一帧,预览只剩背景和影子。
       * 导出那边踩不到这个坑:虚拟时钟会等挂着的网络请求(pauseIfNetworkFetchesPending),
       * JSON 一定在推帧之前就位。
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
      // 导出页里 lottie 自己的 rAF 循环只会空转(没有 autoplay 的动画),冻住它省得每帧都被判成「在变」
      // freeze() 是 lottie-web 公开 API,只是类型声明里漏了
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

  // 跟着时间轴走:t → 帧号
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
  name: "Lottie 动画",
  description: "播放一段 Lottie(AE 导出的 JSON)动画,跟着时间轴逐帧走",
  useWhen: "要放一段现成的 Lottie 动画时用。软件自带几段素材(片头字标、角色亮相、节日装饰等),列在 src 控件的 options 里,把那个 URL 填进 src 就行;手上有别的 Lottie 文件(LottieFiles 下载的、设计师用 AE 导出的)也可以直接用。把 JSON 文本贴进 json 参数,或者给一个 URL。它不会自己「播」,是按 clip 时间逐帧定位:clip 多长动画就走多长,speed 调快慢,loop 决定到头了循环还是停在最后一帧。不适合自己从零画动效 —— 那用别的卡。素材文件的许可证要自己核对。",
  tags: ["lottie", "动画文件", "AE", "素材"],
  source: "native",
  // 帧模式:remotion 式(渲染重构「癸」)。每一帧由素材、参数、帧号直接算出,不用从挂载帧推过来;
  // 随机数和属性值留旧数那几处在 loadLottie 里固定住了(见文件头),所以顺着推和直接跳是同一个画面。
  frameMode: "direct",
  defaults: { json: DEMO_JSON, src: "", speed: 1, loop: "no", fit: "contain" },
  controls: [
    { key: "json", label: "Lottie JSON 文本(优先)", type: "text", hint: "整个 .json 文件的内容;留空则用 src" },
    { key: "src", label: "或素材 / URL", type: "asset", kind: "lottie", options: assetOptions("lottie"), hint: "从素材目录里挑一个(options 里的 URL),或填别的 JSON URL;json 参数留空时才用它" },
    { key: "speed", label: "速度倍率", type: "number", min: 0.1, max: 8, step: 0.1 },
    { key: "loop", label: "到头后", type: "select", options: [{ value: "no", label: "停在最后一帧" }, { value: "yes", label: "循环" }] },
    { key: "fit", label: "适配", type: "select", options: [{ value: "contain", label: "完整显示" }, { value: "cover", label: "铺满裁切" }] },
  ],
  parts: [{ id: "animation", label: "动画", role: "media", params: ["json", "src", "speed", "loop", "fit"] }],
  lifecycle: { after: "hold", exit: ["fade"] },
  timing: (p) => ({ after: p.loop === "yes" ? "loop" : "hold" }),
  Component: LottieCard,
};

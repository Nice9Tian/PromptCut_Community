import { useEffect, useRef } from "react";
import { beginFrameWork } from "../../kernel/frameReady";
import { tsParticles, setRandom, EventType, type Container } from "@tsparticles/engine";
import { loadSlim } from "@tsparticles/slim";
import type { CardDef, CardProps } from "../../kernel/types";
import { assetOptions } from "../catalogAssets";


/**
 * 粒子背景:tsParticles(MIT)画在 canvas 上的漂浮粒子,可选连线。
 *
 * 这是第一张 canvas 卡,它能进导出靠的是三件事,缺一个都不行:
 *   1. 随机数:tsParticles 在模块加载时就把 Math.random 抓走存起来了(engine/Utils/MathUtils.js
 *      的 _random),导出页里对 Math.random 的钉死够不着它。所以每次挂载都调 setRandom 把它
 *      接回「调用时的」全局 Math.random —— 导出页里那是带种子的,每次重挂载拨回起点。
 *   2. 帧循环:它用调用时的 requestAnimationFrame,走的是 exportClock 包过的那层,时间戳被钉到
 *      导出毫秒。同一帧里多次 tick 时间戳相同 → delta 为 0 → 不动;跨帧 delta 恰好一格。
 *   3. 截图窗口:导出脚本截图期间关掉脚本执行,那段自由跑的虚拟时间里粒子不会再多走几步。
 * 静态跳过的探针看到可见的 canvas 就不判静止,所以这张卡每帧都真截。
 */

interface Params {
  config: string;
  color: string;
  quantity: number;
  speed: number;
  size: number;
  links: string;
  seed: number;
}

/** 引擎插件只装一次,多张粒子卡共用 */
let engineReady: Promise<void> | null = null;

/*
 * # 装容器全模块排队,一次只装一个
 *
 * 引擎是全局的,有两样东西所有容器共用:
 *   1. **随机数源只有一个**:`setRandom` 换的是引擎模块里的那一个函数,谁后调谁生效;
 *   2. **容器按 id 互相顶替**:`Engine.load` 发现同名的旧容器就先销毁它。不传 id 时取 `element.id`,我们的 div 没有 id,
 *      于是所有容器都叫 "" —— 后装的那张粒子卡会把先装的那张的容器销毁掉。
 * 而装一个容器是异步的(`load` → `start` → `init`,十几个 await),**销毁不会让它停下**:`Container.init()` 只在入口查一次
 * `destroyed`,被销毁的容器照样把粒子排完,照样从「此刻的」随机数源里取数。
 *
 * 两次装载交错时就出事。实测(暂停着在时间轴上往回点):舞台先把往回的 t 交给旧组件,旧组件开始重装(第一次 load 在飞);
 * 同一个同步块里舞台又按片段重挂载了这张卡,新组件播种、开始装(第二次 load)。第二次 load 把第一次的容器当同名销毁,
 * 可第一次的 init 还在走,从新组件刚播好种的随机数里取走了前 840 个,新容器拿到的是第 841 个起 —— 粒子排布和这一刻的
 * 毫不相干(与往前到达的同一帧比,差得和两个不相干的帧一样大),而且每次都稳定地错成同一张。
 *
 * 所以:
 *   - 装载排队:前一次**排完粒子**(或失败)之后才开始下一次,随机数源在一次装载期间只属于它;
 *   - 排上了还没开工就被作废的(卸载、配置换了)直接跳过,一个字都不装;已经开工的等它排完再销毁;
 *   - 每个容器一个自己的 id,互不顶替;
 *   - 每个容器一份自己的随机数流,推进时换上,推完把源还给正在装的那一次(`stepTo`)—— 几张粒子卡同屏时各走各的。
 * 单张卡取随机数的次序和以前逐个相同:播种 → 装载时取 → 推进时取,用的是同一份(起名本来就不取随机数:取的是 `element.id`)。
 */
interface LoadJob {
  el: HTMLElement;
  opts: Record<string, any>;
  rand: () => number;
  cancelled: boolean;
  resolve: (c: Container | null) => void;
  reject: (e: unknown) => void;
}
const loadQueue: LoadJob[] = [];
/** 正在装的那一次(随机数源此刻属于它) */
let loading: LoadJob | null = null;
let pumpQueued = false;
let containerSeq = 0;

/** 排一次装载。回的 Promise:粒子排布好了给容器;被作废了给 null;装不成就 reject。`cancel` 作废这一次 */
function requestLoad(el: HTMLElement, opts: Record<string, any>, rand: () => number): { promise: Promise<Container | null>; cancel: () => void } {
  let resolve!: (c: Container | null) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Container | null>((res, rej) => { resolve = res; reject = rej; });
  const job: LoadJob = { el, opts, rand, cancelled: false, resolve, reject };
  loadQueue.push(job);
  schedulePump();
  return { promise, cancel: () => { job.cancelled = true; } };
}

/** 晚一个微任务开工:同一个同步块里刚排上就被作废的那一次(往回拖紧接着被舞台重挂载)来得及跳过 */
function schedulePump(): void {
  if (pumpQueued) return;
  pumpQueued = true;
  queueMicrotask(() => { pumpQueued = false; pumpLoads(); });
}

function pumpLoads(): void {
  if (loading) return;
  let job = loadQueue.shift();
  while (job && job.cancelled) { job.resolve(null); job = loadQueue.shift(); }
  if (!job) return;
  const current = job;
  loading = current;
  // 粒子的初始排布由种子决定:装载这一段用的随机数就是这一次播种过的
  setRandom(current.rand);
  withRealCanvas(() => {}); // 确保短路已装上(幂等)
  const id = `pc-particles-${++containerSeq}`;
  const setUp = whenSetUp((k) => k.id.description === id);
  let finished = false;
  const finish = (c: Container | null, error?: unknown) => {
    if (finished) return;
    finished = true;
    setUp.dispose();
    loading = null;
    if (c && current.cancelled) { c.destroy(); current.resolve(null); }
    else if (c) current.resolve(c);
    else if (current.cancelled) current.resolve(null);
    else current.reject(error ?? new Error("粒子容器没有装起来"));
    schedulePump();
  };
  void setUp.promise.then((c) => finish(c));
  // 不等 load() 的 Promise 报喜(见 whenSetUp),只接它的失败和「没排粒子就回来了」
  tsParticles.load({ id, element: current.el, options: forceOurs(current.opts) }).then(() => finish(null), (e) => finish(null, e));
}

/** 不管配置怎么写,这几项一律按我们的来:铺在卡片层里、不响应鼠标、不按 DPR 放大、透明底 */
function forceOurs(opts: Record<string, any>): Record<string, any> {
  return {
    ...opts,
    fullScreen: { enable: false },
    detectRetina: false,
    // 引擎默认「窗口失焦 / 画布不在视口里就暂停」:预览 iframe、无头导出页、Browser 面板收起时都算失焦,
    // 结果是画布一直空白(实测:canvas 在、粒子数在,一像素都没画)。这两项一律关掉,画不画由我们的时钟说了算
    pauseOnBlur: false,
    /*
     * **根节点这个 resize 也要关**,不是只关 interactivity 里那个。
     *
     * 引擎默认 `resize.enable = true`、`delay = 0.5`(见 Options/Classes/ResizeEvent.js),
     * 于是它自己给画布装一个 ResizeObserver,回调里挂一个 **500ms 的真实时间定时器**,
     * 到点走 windowResize() → setDensity() 增删粒子。而增删粒子会消耗我们注入的种子随机数,
     * 随机流一错位,后面每一帧的粒子就都不一样了 —— **这条路根本不经过 drawParticles**,
     * 所以「推进序列逐步相同」也拦不住它。
     *
     * 它为什么只在某些路径上咬人:那是个真实时间的定时器。逐帧推过去要花几百毫秒真实时间,
     * 定时器就落在推进序列**中间**;一口气推完只要几毫秒,定时器落在**结束之后**,对这一帧没影响。
     * 预览跳转和导出恰好就是这两种。实测同一个 t=1.8s,两条路差 12.9 万个像素。
     * 画布尺寸由我们的布局说了算,引擎不需要自己盯着。
     */
    resize: { enable: false },
    /*
     * 引擎自己的帧循环一律不开:`start()` 末尾那次 `play()` 在 autoPlay=false 的首次启动时直接返回,
     * refresh() 里 stop() 会把「首次启动」复位,所以往回拖重开时同样不开。画面只由 stepTo 推。
     */
    autoPlay: false,
    pauseOnOutsideViewport: false,
    background: { ...(opts.background || {}), color: "transparent" },
    interactivity: {
      ...(opts.interactivity || {}),
      events: { ...((opts.interactivity && opts.interactivity.events) || {}), onHover: { enable: false }, onClick: { enable: false }, resize: { enable: false } },
    },
  };
}

function simpleOptions(params: Params): Record<string, any> {
  return {
    fpsLimit: 60,
    particles: {
      number: { value: Math.max(0, params.quantity | 0), density: { enable: false } },
      color: { value: params.color },
      opacity: { value: 0.8 },
      size: { value: Math.max(0.5, params.size) },
      move: { enable: true, speed: Math.max(0, params.speed), outModes: { default: "out" } },
      links: { enable: params.links === "yes", color: params.color, distance: 160, opacity: 0.45, width: 1.5 },
    },
  };
}

/** config 参数:以 { 开头就是内联 JSON,否则当 URL 去取;空串就用上面几个简单参数 */
async function resolveOptions(params: Params): Promise<Record<string, any>> {
  const c = params.config.trim();
  if (!c) return simpleOptions(params);
  if (c.startsWith("{")) return JSON.parse(c);
  const r = await fetch(c);
  if (!r.ok) throw new Error(`拉取粒子配置失败 ${r.status}: ${c}`);
  return r.json();
}

/**
 * 渲染核心:给一个「取配置」的函数和随机种子,把粒子画进卡片层,**由时间轴的 t 驱动**。
 *
 * 为什么不让引擎自己跑:tsParticles 4 的帧循环靠 requestAnimationFrame,而预览 iframe 和导出页的
 * rAF 是虚拟时钟(kernel/exportClock.ts),不会自己跳;它还会把画布 transferControlToOffscreen,
 * 画在离屏位图上,预览里一个像素都出不来(实测:容器活着、200 个粒子都在、位图全空)。
 * 所以这里:
 *   1. 装载时把 transferControlToOffscreen 短路成「就用这张画布」,画到看得见的 canvas 上;
 *   2. 装好立刻 pause() 掐掉它自己的循环,每次 t 变了按 1/60 秒一步步 drawParticles 推到 t;
 *   3. 随机数用按 seed 播种的 PRNG,往回拖播放头就重开一遍再推 —— 同一个 seed、同一个 t,
 *      在编辑器、预览、导出里画出来的是同一帧。这和 Lottie 卡 goToAndStop 是一个思路。
 * `depsKey` 是配置的身份 —— 它变了才重新装引擎;素材封装卡(src/cards/assets)用它把翻译后的旋钮
 * 写回原配置再渲染,通用粒子卡用它渲染 URL / 内联 JSON / 简单参数三种来源。
 */
export function ParticlesView({ resolve, seed, depsKey, t = 0 }: { resolve: () => Promise<Record<string, any>>; seed: number; depsKey: string; t?: number }) {
  const box = useRef<HTMLDivElement>(null);
  /** 引擎容器 + 已经推到了第几毫秒;重装时整个换掉 */
  const state = useRef<StepState & { gen: number }>({ container: null, atMs: 0, gen: 0 });
  const wantT = useRef(t);
  wantT.current = t;

  useEffect(() => {
    let dead = false;
    const st = state.current;
    const gen = ++st.gen;
    st.container?.destroy();
    st.container = null;
    st.atMs = 0;
    st.rand = undefined;
    st.reloading = false;
    st.pendingT = undefined;
    st.reload = undefined;

    // HMR 重跑这个模块时引擎已经 load 过,再注册插件会抛错;吞掉,插件本来就在
    engineReady ??= loadSlim(tsParticles).catch(() => {});
    const ready = beginFrameWork('particles');
    /** 作废这个组件还没装完的那一次装载(卸载、配置换了) */
    let cancelLoad = () => {};

    /**
     * 排一次装载,粒子排布好就回(连同它那份随机数流)。首次挂载和往回拖都走这一条,两边的随机数流逐个相同。
     * 不等 load() 的 Promise:它要等引擎 start() 里那个 setTimeout,暂停的舞台上它永远不响(见 whenSetUp)。
     * 为什么排队、为什么随机数流跟着容器走,见 `requestLoad` 上面那段。
     */
    const mount = (opts: Record<string, any>): Promise<Loaded | null> | null => {
      const el = box.current;
      if (dead || !el) return null;
      cancelLoad();
      const rand = seededRandom(seed);
      const req = requestLoad(el, opts, rand);
      cancelLoad = req.cancel;
      return req.promise.then((c) => (c ? { c, rand } : null));
    };
    /** 装好了:掐掉引擎自己的帧循环,从现在起只有我们按 t 推它 */
    const adopt = ({ c, rand }: Loaded): boolean => {
      if (dead || gen !== st.gen) { c.destroy(); return false; }
      c.pause();
      st.container = c;
      st.rand = rand;
      st.atMs = 0;
      return true;
    };

    Promise.all([engineReady, resolve()])
      .then(([, opts]) => {
        /*
         * 往回拖:整个容器销毁、按同一条路重装,再从 0 推过来(粒子系统没有倒带)。
         *
         * **不用 container.refresh()。** refresh 和首次 load() 走的不是同一条路:粒子编号、对象池不归零。
         * 实测停在 3s、跳到 5s、再跳回 3s,refresh 重排出来的画面和第一次不同。
         * 重装一个新容器,两次就是逐个相同的随机数、逐个相同的步序。
         */
        st.reload = (tSec: number) => {
          st.reloading = true;
          st.pendingT = tSec;
          st.container?.destroy();
          st.container = null;
          st.atMs = 0;
          const p = mount(opts);
          if (!p) { st.reloading = false; return; }
          p.then((got) => {
            // 这一次重装已经不归这个组件管了(卸载、配置换了):装出来的东西销毁,别动新一轮的状态
            if (dead || gen !== st.gen) { got?.c.destroy(); return; }
            st.reloading = false;
            if (got && adopt(got)) stepTo(st, seed, st.pendingT ?? tSec);
          }).catch(() => { if (!dead && gen === st.gen) st.reloading = false; });
        };
        return mount(opts);
      })
      .then((got) => {
        if (!got) { ready.dispose(); return; }
        if (!adopt(got)) return;
        stepTo(st, seed, wantT.current);
        ready.ready();
      })
      .catch((e) => { ready.fail(e); console.warn("[particles] 启动失败:", e); });

    return () => {
      dead = true;
      cancelLoad();
      ready.dispose();
      st.reload = undefined;
      st.container?.destroy();
      st.container = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey, seed]);

  // t 变了就推到 t;往回拖就重装一遍再推(粒子系统没有倒带)
  useEffect(() => {
    stepTo(state.current, seed, t);
  }, [t, seed]);

  return <div ref={box} className="absolute inset-0" />;
}

/** 一步多长:按 60fps 推,和引擎默认的 fpsLimit 一致,物理不会因为一步太长而炸 */
const STEP_MS = 1000 / 60;
/** 单次最多推多少步:20 秒;再长的 clip 也不至于一次卡死主线程 */
const MAX_STEPS = 60 * 20;

/**
 * 推进状态:引擎容器、已经推到第几毫秒。
 * 往回拖时 reload 重装一个新容器;重装期间 reloading 为真,最新的 t 记在 pendingT,装好了一并推。
 */
interface StepState { container: Container | null; atMs: number; rand?: () => number; reloading?: boolean; pendingT?: number; reload?: (tSec: number) => void }
/** 装好的一个容器,连同它自己那份播过种的随机数流 */
interface Loaded { c: Container; rand: () => number }

function stepTo(st: StepState, seed: number, tSec: number) {
  // 往回拖触发的重装还没好:记下最新的 t,装好了一并推
  if (st.reloading) { st.pendingT = tSec; return; }
  const c = st.container;
  if (!c || c.destroyed) return;
  const target = Math.max(0, tSec) * 1000;
  if (target < st.atMs - 0.5) {
    st.reload?.(tSec);
    return;
  }
  // 推进时取的随机数来自这个容器自己那一份(见 `requestLoad` 上面那段);推完把源还给正在装的那一次
  if (st.rand) setRandom(st.rand);
  try {
    advance(st, c, target);
  } finally {
    if (loading) setRandom(loading.rand);
  }
}

function advance(st: StepState, c: Container, target: number) {
  const render = c.canvas.render;
  let steps = 0;
  if (st.atMs === 0) {
    /*
     * 初始那一帧:只画,不推进。**target 是多少都要画这一下。**
     *
     * 以前写的是「target 也在 0 附近才画」,于是「一口气推到 t」的那一边把它跳过了。
     * 而逐帧推的那一边(导出)必然在 t=0 上画过一次 —— 一次 drawParticles 会消耗随机数,
     * 少画一次,两边的随机数流就此错开一格,粒子从此各走各的。
     *
     * 两种叫法是真实存在的:导出每帧叫一次;预览跳转时引擎是异步装好的,装完补跑早跑完了,
     * 只剩最后一个 t。实测 particles-life 在 t=1.8s 上差 3.18% 的像素、最大通道差 164。
     */
    render.drawParticles({ value: 0, factor: 0 } as any);
    // 记下「初始那一帧已经画过了」。不记的话,先停在 t≈0 再往前推,会比直接跳到 t 多画一次 value=0 ——
    // 往回拖(refresh 之后递归回到 t=0)正好会走这条路。用一个极小的量占位,不影响下面按整格推进。
    st.atMs = 1e-9;
    if (target <= 0.5) return;
  }
  /*
   * **只走整格,不足一格的余数留着。**
   *
   * 以前是 `d = min(STEP_MS, target - atMs)`:每次调用都拿一个短步把余数吃干净。
   * 那样一来「推到 t」的结果就和**中途被叫过几次**有关 —— 逐帧叫(每次 +33.33ms)走的是
   * 16.667 / 16.666 交替,一口气叫到底走的是一连串 16.667。步长不同 → factor 不同 →
   * 一百多步累下来粒子就飘开了。
   *
   * 而预览和导出恰好就是这两种叫法:导出逐帧叫;预览跳转时引擎是异步装好的,装完时
   * 补跑早就同步跑完了,只剩最后一个 t,于是一口气推。实测 particles-life 在 t=1.8s 上
   * 差 3.18% 的像素、最大通道差 164。
   *
   * 只走整格之后,推到同一个 t 的**步序逐步相同**,和中途叫了几次无关。代价是画面最多
   * 落后不到一格(16.7ms),但两边落后得一模一样 —— 这正是要的。
   */
  while (st.atMs + STEP_MS <= target + 1e-6 && steps++ < MAX_STEPS) {
    render.drawParticles({ value: STEP_MS, factor: 1 } as any);
    st.atMs += STEP_MS;
  }
}

/**
 * 等某个容器「粒子排布好了」(引擎在 init() 末尾发的 particlesSetup 事件),**不等 load() / refresh() 的 Promise**。
 *
 * 为什么不能等那两个 Promise:引擎的 Container.start() 在 init() 之后还要
 * `await new Promise(r => setTimeout(r, delay))` 才 resolve(delay 缺省 0)。而预览舞台(?stage=1,
 * render/stageClock.ts)把 setTimeout 换成了登记在虚拟时钟上的定时器,只在时钟 tick 时结算 ——
 * **暂停时舞台不 tick,这个 0ms 定时器就永远不响**,load() 永远不 resolve,stepTo 一次都没跑,
 * 画布停在 init 时清空的样子:canvas 在、80 个粒子都排好了,一个像素都没画。往前拖时舞台会 tick,
 * 定时器才响,所以「往前拖有画面、停住或往回拖全透明」。
 *
 * 那个定时器之后做的事(挂监听、插件 start、发 containerStarted、play())对画面没有影响:
 * play() 在 autoPlay=false 的首次启动时直接返回(见 forceOurs),交互插件的鼠标事件也关了。
 * 所以粒子排布好就可以开始按 t 推;定时器哪天响都一样。
 * 事件是引擎全局的,多张粒子卡共用,用 match 认自己的容器。
 */
function whenSetUp(match: (c: Container) => boolean): { promise: Promise<Container>; dispose: () => void } {
  let handler: ((e: any) => void) | null = null;
  const dispose = () => { if (handler) tsParticles.removeEventListener(EventType.particlesSetup, handler); handler = null; };
  const promise = new Promise<Container>((resolve) => {
    handler = (e: any) => {
      const k = e?.container as Container | undefined;
      if (!k || !match(k)) return;
      dispose();
      resolve(k);
    };
    tsParticles.addEventListener(EventType.particlesSetup, handler);
  });
  return { promise, dispose };
}

/** 按 seed 播种的 PRNG(mulberry32):同一个 seed 永远是同一串数 */
function seededRandom(seed: number): () => number {
  let a = (seed | 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 让 tsParticles 直接画在看得见的 canvas 上。
 * 引擎 4.x 一律 canvas.transferControlToOffscreen() 再画到离屏位图;预览 iframe 里离屏位图
 * 从不提交到屏幕。把这个方法短路成返回画布自己,引擎拿到的 getContext / width / height 都是真画布的。
 * 全局只装一次;这个项目里没有别的东西用 OffscreenCanvas。
 */
let realCanvasPatched = false;
function withRealCanvas(fn: () => void) {
  if (!realCanvasPatched && typeof HTMLCanvasElement !== "undefined") {
    (HTMLCanvasElement.prototype as any).transferControlToOffscreen = function () { return this; };
    realCanvasPatched = true;
  }
  fn();
}

function ParticlesCard({ params, t = 0 }: CardProps<Params>) {
  const depsKey = [params.config, params.color, params.quantity, params.speed, params.size, params.links].join("\u0000");
  return <ParticlesView resolve={() => resolveOptions(params)} seed={params.seed} depsKey={depsKey} t={t} />;
}

export const particlesCard: CardDef<Params> = {
  id: "particles",
  name: "粒子背景",
  description: "漂浮的粒子,可带连线,铺满整个画面",
  useWhen: "整段画面需要一层动态的科技感 / 星空感底纹时用,通常放最底层、盖住整段时长。两种用法:不填 config 就用颜色/数量/速度几个简单参数;要雪花、星空、气泡、彩带这类现成效果,从 config 控件的 options 里挑一个 URL 填进 config(软件自带 50 多种),此时简单参数不起作用。粒子位置由 seed 决定,同一个 seed 每次导出都一样;想换一种排布就换 seed。它是背景不是主角,别指望它传达信息;要强调数字或文字用别的卡叠在上面。",
  tags: ["粒子", "背景", "科技", "星空", "雪花", "canvas"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: { config: "", color: "#8ab4ff", quantity: 80, speed: 1.2, size: 3, links: "yes", seed: 1 },
  controls: [
    { key: "config", label: "现成配置", type: "asset", kind: "particles", options: assetOptions("particles"), hint: "从素材目录里挑一个(options 里的 URL),或填别的 URL / 内联 JSON;填了就用它,下面的颜色/数量/速度不起作用" },
    { key: "color", label: "颜色", type: "color" },
    { key: "quantity", label: "数量", type: "number", min: 0, max: 400, step: 10 },
    { key: "speed", label: "速度", type: "number", min: 0, max: 10, step: 0.2 },
    { key: "size", label: "大小(px)", type: "number", min: 0.5, max: 20, step: 0.5 },
    { key: "links", label: "连线", type: "select", options: [{ value: "yes", label: "有" }, { value: "no", label: "无" }] },
    { key: "seed", label: "随机种子", type: "number", min: 1, max: 99999, step: 1, hint: "换一个数就换一种排布;同一个数每次导出都一样" },
  ],
  parts: [{ id: "particles", label: "粒子", role: "media", params: ["config", "color", "quantity", "speed", "size", "links", "seed"] }],
  lifecycle: { after: "evolve", exit: ["fade"] },
  /*
   * R9 M1 的第四种契约 `dom2d`:**不进共享渲染器的 Worker**。`tsParticles.load({ element })` 要 DOM 元素、
   * 配置是异步 fetch,53 张粒子卡共用这一份 —— 所以仍在主线程用真画布画(上面 `withRealCanvas` 的
   * `transferControlToOffscreen` 短路保留),`Stage` 不为它渲 gl 平面;它是 2D 上下文,不算 WebGL 上下文。
   * 长的粒子片段判重时走轨道流(R8 G1)。
   */
  canvas: { kind: "dom2d" },
  Component: ParticlesCard,
};

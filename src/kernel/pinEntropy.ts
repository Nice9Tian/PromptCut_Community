/**
 * 把卡片(包括第三方库)能读到的「系统时间」和「真随机」全部钉死。
 *
 * # 为什么要有它
 *
 * exportClock 早就钉了 performance.now / rAF / Math.random,但留了三个口子:
 *   1. `Date.now()` / `new Date()` —— 读的是墙上时钟,每次导出都不一样;
 *   2. `crypto.getRandomValues` / `crypto.randomUUID` —— 真随机;
 *   3. `Math.random` 在时间轴就位前回落到真随机,而且它是在 ExportView 模块**函数体**里装的 ——
 *      ESM 先把所有 import 求值完,`import "./cards"` 早已把第三方库加载好了,
 *      库在模块加载时抓走的是**原始的** Math.random。
 *
 * 实测踩中的是 lottie-web:它在模块加载时 `BMMath.random = Math.random`(lottie.js:202),
 * 又用 `crypto.getRandomValues` + `+new Date()` 给自带的 seedrandom 自动播种(13967~13978 行)。
 * AE 表达式里的 `wiggle()` / `random()` 走的就是它 —— 一个 wiggle 方块 + 一个 random 方块的
 * Lottie,现在的导出管线连导两遍 **89/90、90/90 帧不同**。卡片自己写的粒子不受影响
 * (particles.tsx 用参数里的 seed 自己播种),受影响的是这类「在库里偷偷取随机」的东西。
 *
 * # 钉成什么
 *
 * - `Math.random` —— 带种子的 mulberry32,**从安装那一刻起**就是它(不再等时间轴就位)。
 *   初始状态和算法与原来 exportClock 里那份完全相同,`__pcResetRandom(1)` 之后的序列一个数都没变,
 *   所以重挂载之后的画面和旧基线一致;变的只是重挂载**之前**(模块加载期)那几次调用。
 * - `Date.now()`、不带参数的 `new Date()` / `Date()` —— 固定纪元 + 当前帧的毫秒数
 *   (导出页取 `__pcExportMs`,渲染面取舞台时钟;时钟还没就位时就是固定纪元本身)。
 *   带参数的 `new Date(x)`、`Date.parse`、`Date.UTC` 原样不动 —— 那些是计算,不是读时钟。
 *   时间跟着帧走而不是彻底冻住:有的库拿 `Date.now()` 算超时(lottie 的字体加载轮询),冻住的话
 *   它会一直等下去。
 * - `crypto.getRandomValues` / `crypto.randomUUID` —— 用同一个种子流填字节。
 *
 * # 为什么必须最先装
 *
 * 库在模块加载时抓引用,晚于它装的补丁它看不见。所以由 render/stageClockEntry.ts 调用,
 * 那个文件是 main.tsx / proto-main.tsx 的**第一个** import。
 *
 * 只钉随机和墙上时钟,**不碰 performance.now 和 rAF**:那两个提前装会连带换掉 Motion 拿到的
 * 时间戳来源(见 exportClock.ts「DOM 变动计数」那段),是另一回事。
 *
 * 只在导出视图和渲染面里装。编辑器主文档不能装 —— 它自己的 id、时间戳要真的。
 *
 * # 带着指定种子执行一段函数(`withSeededRandom`,原型,2026-10-12)
 *
 * 全页共用一个状态,意味着「谁先取、取了几次」会挪动后面所有人拿到的数。`withSeededRandom(seed, fn)`
 * 让 fn 在一串**自己的**随机数里跑(从 seed 起),跑完把全页的状态放回 fn 开始前的样子:fn 里取了几次,
 * 外面一次都看不到。只管同步执行的那一段;fn 里排出去的定时器、Promise 回调不在里面。
 *
 * 用它的是 `src/cards/native/lottie.tsx`(开关缺省关)。注意它**只是那边的第二层**:Lottie 播放库的表达式用的是
 * 它自己内部的一串(上面说的 `BMMath.random`),只有页面里还没有任何表达式给那一串播过种时,那一串才等于这里的
 * `Math.random`。所以那边真正起作用的是直接给播放库内部那一串播种;这里管的是「页面里第一个 Lottie 建图层时
 * 从全页这一串里取走的数」和播放库里直接调 `Math.random()` 的少数地方。
 */

/** 固定纪元。任何「现在几点」的读数都从这里起算;取一个整点,不为别的,只为好认 */
export const PINNED_EPOCH_MS = Date.UTC(2026, 0, 1);

/** 要被钉住的那几样东西所在的对象。浏览器里就是 window;单测传一个沙箱进来 */
export interface EntropyHost {
  Math: Math;
  Date: DateConstructor;
  crypto?: { getRandomValues: <T extends ArrayBufferView | null>(a: T) => T; randomUUID?: () => string };
  __pcExportMs?: number;
  __pcStageClock?: { now(): number };
  __pcResetRandom?: (seed?: number) => void;
  /** 带着指定种子执行 fn,执行完把全页的随机状态放回 fn 开始前的样子(见文件头) */
  __pcWithRandomSeed?: <T>(seed: number, fn: () => T) => T;
  __pcEntropyPinned?: boolean;
  /** 接管前的真 `Date.now`(E4b 的口子;舞台那边 stageClock 会更早存一次,这里不覆盖) */
  __pcRealDateNow?: () => number;
}

export function installPinnedEntropy(host: EntropyHost = window as unknown as EntropyHost): void {
  if (host.__pcEntropyPinned) return;
  host.__pcEntropyPinned = true;

  // ── Math.random:mulberry32,和原来 exportClock 里那份逐位相同 ──
  let rngState = 1;
  const seeded = () => {
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  host.__pcResetRandom = (seed = 1) => {
    rngState = seed | 0;
  };
  host.__pcWithRandomSeed = <T>(seed: number, fn: () => T): T => {
    const saved = rngState;
    rngState = seed | 0;
    try {
      return fn();
    } finally {
      rngState = saved;
    }
  };
  host.Math.random = seeded;

  // ── 墙上时钟:固定纪元 + 当前帧毫秒 ──
  const pageMs = () => {
    if (typeof host.__pcExportMs === "number") return host.__pcExportMs;
    if (host.__pcStageClock) return host.__pcStageClock.now();
    return 0;
  };
  const pinnedNow = () => PINNED_EPOCH_MS + Math.round(pageMs());
  const RealDate = host.Date;
  // E4b 的口子:接管之后 Date.now() 是虚拟时间,量真墙钟的地方要拿得到原来那份
  host.__pcRealDateNow ??= RealDate.now.bind(RealDate);
  // 共用原型:`x instanceof Date`、`Date.prototype` 上的方法都照旧
  function PinnedDate(this: unknown, ...args: unknown[]) {
    if (!new.target) return new RealDate(pinnedNow()).toString();          // Date() 当函数调 = 读时钟
    if (args.length === 0) return new RealDate(pinnedNow());                // new Date() = 读时钟
    return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args); // 带参数 = 计算,原样
  }
  PinnedDate.prototype = RealDate.prototype;
  const P = PinnedDate as unknown as DateConstructor & { now: () => number };
  P.now = pinnedNow;
  P.parse = RealDate.parse;
  P.UTC = RealDate.UTC;
  host.Date = P;

  // ── crypto:和 Math.random 同一个种子流 ──
  const c = host.crypto;
  if (c) {
    const fill = (u8: Uint8Array) => {
      for (let i = 0; i < u8.length; i++) u8[i] = Math.floor(seeded() * 256);
    };
    c.getRandomValues = <T extends ArrayBufferView | null>(a: T): T => {
      if (a) fill(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
      return a;
    };
    c.randomUUID = () => {
      const b = new Uint8Array(16);
      fill(b);
      b[6] = (b[6] & 0x0f) | 0x40; // 版本 4
      b[8] = (b[8] & 0x3f) | 0x80; // 变体 10
      const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };
  }
}

/**
 * 带着指定种子执行 fn:fn 里的 `Math.random`(钉住的页面里还有 `crypto.getRandomValues`)从 seed 起出数,
 * 执行完把随机状态放回 fn 开始前的样子,fn 取了几次对外面没有影响。可以嵌套。
 *
 * 钉住的页面(导出视图、渲染面)里换的是那一个共用状态;没钉的页面(编辑器主文档)里临时把 `Math.random`
 * 换成同一个算法的带种子版本,出来就换回原来那个真随机。
 *
 * 只罩同步执行的那一段(见文件头)。
 */
export function withSeededRandom<T>(seed: number, fn: () => T, host: EntropyHost = globalThis as unknown as EntropyHost): T {
  if (host.__pcWithRandomSeed) return host.__pcWithRandomSeed(seed, fn);
  const real = host.Math.random;
  let state = seed | 0;
  host.Math.random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return fn();
  } finally {
    host.Math.random = real;
  }
}

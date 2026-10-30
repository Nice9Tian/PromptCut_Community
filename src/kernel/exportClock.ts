import { installPinnedEntropy } from "./pinEntropy";

/**
 * 导出模式的页面时钟量化。
 *
 * 导出脚本每帧推进一格虚拟时间,但 React 提交、rAF 回调落在这一格里的哪个位置,
 * 取决于页面加载时消耗了多少虚拟时间,两次导出不一样。凡是读 performance.now() 或
 * rAF 时间戳的动画(Motion 的帧循环、第三方 rAF 循环)就会跟着差出零点几帧。
 *
 * 这里把两者都钉到当前帧的导出毫秒 window.__pcExportMs:同一帧里不管回调何时跑,
 * 读到的时间都一样,于是逐帧确定。Web Animations / CSS 动画不走这条路,由
 * ExportView 的 __pcSyncAnims 每帧显式钉 currentTime。
 *
 * ⚠ 页面上其实有**三个**时钟,第三个一直没写进文档,是一批确定性 bug 的来源:
 *   1. performance.now() —— 被这里钉到 __pcExportMs,每趟从 0 起。
 *   2. CDP 虚拟时间 —— 导出脚本每帧推一格。
 *   3. document.timeline.currentTime —— WAAPI 自己的时间线,**单调递增、从不归零**,
 *      而且 server/bakery/bake.mjs 的 shoot() 里那段不带预算的 policy:'advance' 会让它在页面
 *      静止的帧上一口气涨十几亿毫秒(实测一趟累计 26 亿 ≈ 33 天)。
 * Motion 建 WAAPI 动画时把 startTime 写成 time.now(),也就是 1 号时钟的读数(导出毫秒),
 * 而 WAAPI 按 3 号时钟解读它 —— 两个坐标系对不上,动画一出生就可能越过 endTime 直接
 * finished,__pcSyncAnims 又显式跳过 finished,卡片当场渲成终态。下面 patchAnimate() 就是
 * 断掉 3 号时钟对画面的影响。
 *
 * 只在导出视图里装;__pcExportMs 还没就位(时间轴加载前)时回落到真实时钟。
 */
export function installExportClock(): void {
  const w = window as Window & { __pcExportClockInstalled?: boolean };
  if (w.__pcExportClockInstalled) return;
  w.__pcExportClockInstalled = true;

  const realNow = performance.now.bind(performance);
  performance.now = () => (typeof window.__pcExportMs === "number" ? window.__pcExportMs : realNow());

  const realRaf = window.requestAnimationFrame.bind(window);
  // 原始 rAF 留一份给导出脚本:它每帧要等一次 rAF,走包过的那层会把 __pcRafCount 顶起来,
  // 静态判定就永远为假。
  window.__pcRealRaf = realRaf;
  window.__pcRafCount = 0;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    // 计数用于静态帧判定:见 clock.ts 里 __pcRafCount 的说明。
    window.__pcRafCount = (window.__pcRafCount ?? 0) + 1;
    return realRaf((ts) => cb(typeof window.__pcExportMs === "number" ? window.__pcExportMs : ts));
  };
  /*
   * 关于截图窗口里 rAF 多跑几次的问题 —— 结论:**不用管**,别再往这里加东西。
   * 截图那一小段虚拟时间是自由跑的,rAF 会按真实节奏多触发几次。曾担心 canvas 粒子这类循环
   * 会因此多走步,试过两种堵法,都错了:
   *   - CDP Emulation.setScriptExecutionDisabled:把 pending 的 rAF 回调整个丢掉,Motion 的帧循环
   *     就此死掉,动画从第 5 帧起全冻住 —— 三趟冻得一模一样,逐字节比对看不出来,只有比同一趟里
   *     第 10 帧和第 30 帧才发现。
   *   - 在这层包装里把回调按住、截完再发:改变了回调落在哪个 vsync 上,word-rotate 换词那一帧
   *     出现 1/5 的抖动;不按住是 0/5。
   * 而实测不堵也是确定的:时间戳被钉住,同一帧里多出来的 tick 对读时间的循环(Motion、word-rotate)
   * 算出同一个数,对按 delta 走的循环(tsParticles)delta 为 0 就是空转 —— particles 6 趟 0 差异。
   */

  /*
   * DOM 变动计数 —— 静态帧判定的主力。
   *
   * 上面那个 rAF 计数抓不到 Motion 的 JS 动画:motion-dom 的 frameloop 在**模块求值时**就把
   * 原始 requestAnimationFrame 存进了批处理器(frameloop/frame.mjs),而 ESM 的 import 求值
   * 早于本函数被调用,替换永远够不着它。把安装时机提前倒是能罩住,但那会连带换掉 Motion 拿到的
   * 时间戳来源 —— 为一个启发式去动确定性的根基,不划算。
   *
   * 换个抓法:JS 动画再怎么绕过 rAF,每帧总要把新值写回 style 或文本节点,这个躲不掉。
   * 于是盯 DOM 变动。它同时还罩住了卡片重挂载那几帧(getAnimations() 那时还是空的,
   * 因为 Motion 要到下一帧才建动画,而画面已经在变了)。
   */
  patchAnimate();

  /*
   * 随机数 / 墙上时钟 / crypto 钉死:搬到了 pinEntropy.ts。
   * 正常情况下它已经由 render/stageClockEntry.ts 在所有 import 之前装好了(第三方库在模块加载时
   * 就抓走 Math.random,晚装够不着);这里再调一次只是兜底,重复调用是空操作。
   * 以前这里的 Math.random 在时间轴就位前回落到真随机 —— lottie 的表达式随机正是从那个口子漏进来的,
   * 见 pinEntropy.ts 文件头。__pcResetRandom 由它提供,__pcRestartCards 照旧调它把种子拨回起点。
   */
  installPinnedEntropy();

  window.__pcMutationCount = 0;
  new MutationObserver((records) => {
    window.__pcMutationCount = (window.__pcMutationCount ?? 0) + records.length;
  }).observe(document.documentElement, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
}

/**
 * 让 WAAPI 动画一出生就停在 0,时间此后由 __pcSyncAnims 独占。
 *
 * 为什么要这么做:Motion 建 WAAPI 动画时会把 startTime 写成 time.now()(= 被钉住的
 * performance.now,也就是导出毫秒,每趟从 0 起),而 WAAPI 按 document.timeline.currentTime
 * 解读 startTime —— 后者单调递增从不归零,渲一趟就能涨到十几亿(见文件头「三个时钟」)。
 * 于是「开渲那一刻 timeline 已经是多少」直接决定了新建的动画会不会一出生就 finished:
 *   - 复用同一个 document 连渲两次:第二趟 timeline 已到 164 亿,全部动画出生即 finished,
 *     __pcSyncAnims 又跳过 finished,卡片直接渲成终态 —— rank-bars 差 26 帧、growth-curve 差 65 帧。
 *   - 就算每趟都开全新的页面也不安全:开渲那一刻 timeline 是 590 还是 650ms 取决于这次加载
 *     花了多久,endTime 落在这个区间里的动画(rank-bars 第一行:delay 0 / dur 500)就随机
 *     出生即 finished。实测两个全新浏览器渲同一张 rank-bars 差 16 帧(第 0~11 帧整行入场没播),
 *     也就是说**现有的一次性导出路径本来就不是确定的**,只是掷硬币两次常常掷到同一面。
 *
 * 修法:把动画一建出来就 pause 并钉到 0,并把这个实例的 startTime 这个 JS setter 吞掉
 * (Motion 自己在 NativeAnimationExtended 的注释里就写了「给 paused 的 WAAPI 动画设
 * startTime 会把它 unpause」)。此后动画时间完全来自 __pcSyncAnims 的锚点,和 timeline 无关。
 * 实测(90 帧 / 1920x1080 / 30fps / PNG 逐字节比):复用 bakery 连渲两次 rank-bars 26 → 0 帧;
 * 两个全新浏览器之间 rank-bars 16 → 0 帧;odometer / ring-metric / type-shift 本来就 0,没被带坏。
 * growth-curve 的 65 帧也没了,但它另有一类每帧固定 23 个像素的残差(玻璃板圆角的抗锯齿,
 * 新鲜 vs 新鲜同样发生,和这条修法无关),见 server/bakery/chrome.mjs 的文件头注释。
 *
 * ⚠ 这一改必须和 server/bakery/bake.mjs 里每帧的 settle()(排空 React 挂起的提交)配套:动画真的
 * 会播之后,「卡片挂载提交落在哪一帧」才开始影响画面,而那件事以前是在截图窗口里和截图抢跑的。
 * 只加这一层、不加 settle,demo 时间轴上 npm run verify 会在卡片切换处红 12 帧;两个都在则 90/90。
 *
 * ⚠ 约定:导出页里 animation.startTime 恒为 null,不要拿它做算术。a.finish() 走的是规范内部
 * 逻辑、不经过这个访问器,照常收束到 endTime。
 * ⚠ 导出产物会变(变对了):endTime 小于「开渲那一刻 timeline」的动画以前从来没播过入场,
 * 现在会正常淡入。任何逐像素基线快照都要重新生成。
 *
 * 渲染面(?stage=1,render/stageClock.ts)也装这一层,理由完全相同:那边 performance.now
 * 同样被接管成从 0 起的舞台时间,而 document.timeline 照样是真实时间。实测拖到 t=0.1s 时
 * 导出页 20 个动画全部 paused 在 100ms,预览页 20 个全部 finished(currentTime 1440)——
 * 入场动画在预览里一律直接跳终态,和导出对不上;装上之后预览与导出的差异回到抗锯齿水平。
 */
export function patchAnimate(): void {
  const w = window as Window & { __pcAnimatePatched?: boolean };
  if (w.__pcAnimatePatched) return;
  w.__pcAnimatePatched = true;
  const realAnimate = Element.prototype.animate;
  Element.prototype.animate = function (
    this: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ): Animation {
    const a = realAnimate.call(this, keyframes, options);
    try {
      a.pause();
      a.currentTime = 0;
      Object.defineProperty(a, "startTime", { get: () => null, set: () => {}, configurable: true });
    } catch {
      // 异常实现放过:宁可这条动画不确定,也不能让导出页整个崩掉
    }
    return a;
  };
}

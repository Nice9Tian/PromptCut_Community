/**
 * 驱动式时钟(渲染面 ?stage=1 专用)。
 *
 * 预览窗口不该「按墙上时钟自己播」——它要显示的是时间轴 t 那一帧。
 * 所以在渲染面这个独立文档里把时间接管掉:performance.now() 读我们给的值,
 * requestAnimationFrame 不再由浏览器触发,而是排进队列、由 tick() 显式跑。
 * Motion 的帧循环、卡片自己的 rAF 循环都读这两个,于是「现在是第几帧」完全由我们说了算。
 *
 * 和导出内核(kernel/exportClock.ts)是同一个思路:那边的时间由 CDP 虚拟时间推,
 * 这边由编辑器下发的 t 推。卡片代码两边一模一样,所以预览所见 = 导出所得。
 *
 * 但只接管 performance.now 和 rAF 还不够。页面上还有第三个时钟 document.timeline.currentTime
 * (WAAPI 自己的,真实时间、从不归零),Motion 建 WAAPI 动画时把 startTime 写成被接管的
 * performance.now(舞台时间,从 0 起),WAAPI 却按第三个时钟解读它 —— 于是动画一出生
 * currentTime 就是「页面已经打开了多久」,越过 endTime 直接 finished,pinAnimations 又按约定
 * 跳过 finished,入场动画在预览里一律直接跳到终态。实测拖到 t=0.1s:导出页 20 个动画 paused
 * 在 100ms,预览页 20 个全部 finished。exportClock 的 patchAnimate 就是治这个的,这里同样要装。
 *
 * 只能装在渲染面的 iframe 里。装到编辑器主文档上会把编辑器自己的 UI 动画一起冻住。
 *
 * # 四种计时方式(E4b)
 *
 * 光接管 performance.now / rAF 不够:卡片还能用 `setTimeout` / `setInterval` 计时
 * (打字机、interval 推进的数字)。它们在虚拟时间下按墙钟乱跑 —— 探针量到的是一张跟着
 * 真实时间走的卡,补跑出来的状态和导出对不上。所以这里把四个函数换成登记在虚拟时钟上的
 * fake timers,`tick` 推进 `now` 时按到期顺序触发(同一 `now` 内按登记顺序),
 * `advanceTo` / `advanceToAsync` 每步都结算。
 *
 * **`set(ms)` 的跳转和 `maxCatchUp` 削起点时不结算**:跳过的那段时间里的定时器不触发、
 * 每个挂起定时器的剩余时间保持(相当于跳转期间时钟停了),所以 `setTime` 不会一口气跑
 * 几百个 `setInterval` 回调。靠定时器累积状态的卡本来就是 `vtOk = false`,它的正确状态由
 * 后台舞台逐步补跑(每步结算)得到,可见舞台的跳转只求不卡。
 *
 * **舞台自身的墙钟定时器一律用真实的**:RPC 超时、`pause({ atSec })` 武装超时、
 * `mediaReady` 的 300 ms、`.pc-awaiting` 的 500 ms 兜底(暂停态虚拟时钟不动,用虚拟定时器
 * 它永远不响、卡片永久隐身)、素材层。口子是 `__pcRealSetTimeout` / `__pcRealSetInterval`;
 * 虚拟定时器的 id 从 `1e9` 起编号,所以 `clearTimeout(真 id)` 照样落到真的那份上。
 *
 * 第四样(`Date.now()` / 无参 `new Date()`)**不在这个文件里**:`kernel/pinEntropy.ts` 已经把它
 * 钉成「固定纪元 + 当前帧毫秒」,而且读的正是这个时钟(`__pcStageClock.now()`),导出页同一份。
 * 这里只负责在接管之前把真的那份存进 `__pcRealDateNow`。
 */
import { patchAnimate } from "../kernel/exportClock";
import { createVirtualTimers } from "./virtualTimers";

export interface StageClock {
  now(): number;
  /** 直接把时钟拨到某毫秒,不跑帧(用于重挂载前设定时间原点) */
  set(ms: number): void;
  /**
   * 跑一帧:时钟拨到 ms,执行这一帧排队的 rAF 回调。**返回跑了几个回调。**
   *
   * 这个数是「这一帧有没有卡片在自己动」的判据:卡片自带的循环、Motion 的帧循环都靠 rAF,
   * 一个都没有就说明这一帧没人会改自己的状态。调用方拿它决定要不要提交 React ——
   * 补跑几百帧时,大部分帧其实什么都没发生,不必每帧都渲一遍。
   */
  tick(ms: number): number;
  /**
   * 眼下还挂着几个虚拟定时器(单测 / 探针用:`clearInterval` 到底有没有摘掉)。
   */
  pendingTimers(): number;
  /**
   * 从当前时刻推进到 target,分步跑帧。
   * 一定要分步:Motion 的帧循环会把单帧 delta 夹到 40ms 上限(防切回标签页时跳变),
   * 一步跨几秒的话动画只会前进 40ms。
   *
   * **每一步落在帧格上,时刻用帧号直接算,不逐步累加**(见 `frameGrid`):从哪一帧起推,第 k 帧的时刻都是同一个数。
   * 起点不在帧格上(`set` 拨过、被 `maxCatchUp` 削过)时,第一步走到下一个帧格;`target` 不在帧格上时,最后一步走到 `target`。
   * `fps`:工程的帧率,给了就照它排帧格;没给从 `step` 认。
   */
  advanceTo(target: number, opts?: { step?: number; fps?: number; maxCatchUp?: number; onFrame?: (ms: number, ran: number) => void }): void;
  /**
   * 和 advanceTo 一样地补跑,但**每帧之间让出一个微任务**。
   *
   * 为什么需要这个:同步补跑跑出来的画面和「一帧一帧推过去」不一样,而导出永远是后者。
   * 实测同一个预览页、同一个 t=1.8s,跳过去和逐帧推过去,particles 差 12.9 万个像素、
   * word-rotate 差 2.2 万个 —— 差的是那些**跨不过同步块的东西**:Motion 解析关键帧、
   * AnimatePresence 换人、粒子引擎异步装载,它们都要一个任务边界才推得动。
   *
   * 让出微任务而不是真帧:微任务在同一个任务里排干,不用等 vsync,几百帧也就几十毫秒;
   * 等真帧的话跳 6 秒要等 180 个 vsync = 3 秒,没法用。
   *
   * `abort` 让新的一次渲染能把上一次还在飞的补跑掐掉(快速拖播放头时会发生)。
   */
  advanceToAsync(target: number, opts?: {
    step?: number;
    /** 工程的帧率。给了就照它排帧格;没给从 `step` 认(见 `frameGrid`) */
    fps?: number;
    maxCatchUp?: number;
    /** **跑这一帧之前**调:提交 React。和导出的 step 同序 —— 那边也是先 __pcSetT 再推虚拟时间 */
    onFrame?: (ms: number) => void;
    /**
     * 跑完这一帧的 rAF 回调之后调:钉动画(这一帧里新建的动画要在这时候才拿得到)。
     * **回 Promise 就等它**(R9 M3:探针生成快照的每一帧要等 GL Worker 的 `done`);回 `void` 不多让一次微任务。
     */
    afterFrame?: (ms: number) => void | Promise<void>;
    abort?: () => boolean;
    /**
     * 每推这么多帧就让出一个**宏任务**(真 setTimeout 0),不只是微任务。
     * 后台舞台的探针(K1)用它:一张卡推几百帧时主线程不能一直被占着,
     * 父页的 RPC 消息、iframe 自己的 resize 都得有机会进来。缺省不让(只让微任务)。
     */
    yieldEvery?: number;
    /**
     * 帧与帧之间查一次的「停止标志」(C10 契约第 2 节:后台活由编辑器页经 RPC 发开始 / 停止)。回 Promise 就等它落定
     * (停着的时候不推、不丢,恢复了接着推);回 `void` 照常推。只在帧之间调,不改变推出来的任何一帧。缺省没有。
     */
    gate?: () => void | Promise<void>;
  }): Promise<void>;
}

const DEFAULT_STEP = 1000 / 60;

/**
 * 推帧用的帧格:第 k 帧的时刻,以及从某个时刻起下一步该走到第几帧。
 *
 * **时刻用帧号直接算,不逐帧累加。** 30 帧/秒时一步是 33.333… 毫秒,不是能精确表示的数,逐帧加出来的时刻和直接算的差最后几位:
 * 从头推到第 60 帧得到 1999.9999999999982,调用方拿「帧号 ÷ 帧率 × 1000」算的目标是 2000。卡片按时刻判「到没到」
 * (整秒换一个词的卡取「过了多少毫秒 ÷ 1000」的整数部分)就晚一帧;接着上一帧推一步时,「上一帧的时刻 + 一步」有时比目标小最后一位,
 * 这一帧里还要再补一拍。实测与拆解见 `docs/reports/AGENT-rr-a1-verify.md`「原因二」。
 *
 *   - 知道帧率时,第 k 帧 = `k / fps * 1000`。这和调用方算目标时刻(`帧号 / fps` 得到秒,再 `* 1000`)是同一个式子、
 *     同一个运算顺序,落点逐位相同。换一种写法(例如 `k * 步长`)最后一位仍可能不同。
 *     帧率由调用方给(`fps`);没给时从步长认:步长正好是整数帧率的一帧(`1000 / fps`,调用方都是这样给的)就认得出来。
 *   - 认不出帧率的步长,用 `k * 步长`:同样不累加,只是不保证和调用方的目标逐位相同(最后一步照旧直接走到目标本身)。
 *
 * `after(ms)`:严格晚于 `ms` 的第一个帧号。`ms` 本身在帧格上、或只差浮点尾数(百万分之一帧以内)时算在这一帧上,
 * 下一步走到它后面那一帧 —— 不为一个尾数多跑一拍。`reaches(k, target)`:第 k 帧是不是已经到了 `target`(同样的容差),
 * 到了就由调用方直接走到 `target` 本身。
 */
export function frameGrid(step: number, fps?: number): { at(k: number): number; after(ms: number): number; reaches(k: number, target: number): boolean } {
  const perSec = 1000 / step;
  const rounded = Math.round(perSec);
  // 调用方给的帧率要和步长对得上才用(对不上按步长走,不猜)
  const rate = fps && Math.abs(perSec - fps) < 1e-9 * fps ? fps : rounded >= 1 && Math.abs(perSec - rounded) < 1e-9 * rounded ? rounded : 0;
  const at = rate ? (k: number) => (k / rate) * 1000 : (k: number) => k * step;
  const slack = step * 1e-6;
  return {
    at,
    after: (ms) => Math.floor((ms + slack) / step) + 1,
    reaches: (k, target) => at(k) >= target - slack,
  };
}
/** 补跑上限(ms):落后超过这么多就先把时钟直接拨到 target-上限,再分步跑完最后这段 */
const DEFAULT_MAX_CATCH_UP = 6000;

export function installStageClock(): StageClock {
  const w = window as Window & { __pcStageClock?: StageClock };
  if (w.__pcStageClock) return w.__pcStageClock;

  // WAAPI 动画一出生就停在 0,时间此后完全由 pinAnimations 的锚点决定(见文件头「第三个时钟」)
  patchAnimate();

  let now = 0;
  let nextId = 1;
  let queue: { id: number; cb: FrameRequestCallback }[] = [];

  /*
   * 真墙钟留一份(J4 / K1):接管之后 performance.now 恒等于舞台时间,量探针耗时、
   * RPC 回包里的 elapsedMs、K4 的拍长都不能再用它。setTimeout 同理留一份真的(E4b:
   * 暂停态虚拟时钟不动,.pc-awaiting 的 500 ms 兜底要靠真时钟)。
   */
  window.__pcRealNow = performance.now.bind(performance);
  window.__pcRealSetTimeout = window.setTimeout.bind(window);
  window.__pcRealSetInterval = window.setInterval.bind(window);
  // Date.now 由 pinEntropy 接管(它读的就是这个时钟);这里只在接管前把真的那份留下来
  window.__pcRealDateNow ??= Date.now.bind(Date);
  performance.now = () => now;
  /*
   * 原始 rAF 留一份。**接管之后页面里就再没有「等浏览器画一帧」的办法了** —— 而有些活儿
   * 非等不可:Motion 解析关键帧要跨一个任务边界,跳转那一下的补跑是同步跑完的,它来不及,
   * 卡片就停在 initial 那一帧(见 StageView 里 settle 的说明)。
   * 和 exportClock 挂同一个名字,两边取法一致。
   */
  window.__pcRealRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = (id: number) => {
    queue = queue.filter((e) => e.id !== id);
  };

  /* ── E4b:setTimeout / setInterval 换成登记在虚拟时钟上的 fake timers ── */

  const realClearTimeout = window.clearTimeout.bind(window);
  const realClearInterval = window.clearInterval.bind(window);
  const timers = createVirtualTimers();

  /**
   * 拨钟但**不结算**(`set` 的跳转、`maxCatchUp` 削起点)。
   * 每个挂起定时器的剩余时间保持 —— 相当于跳过的那段时间里时钟停了。
   */
  const jumpTo = (ms: number): void => {
    timers.shift(ms - now);
    now = ms;
  };

  window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
    timers.set(handler, ms, args, false, now)) as typeof window.setTimeout;
  window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
    timers.set(handler, ms, args, true, now)) as typeof window.setInterval;
  // 真 id(舞台自己的墙钟定时器)转交给真的那份:两边的 id 空间靠 VIRTUAL_TIMER_BASE 分开
  window.clearTimeout = ((id?: number) => { if (!timers.clear(id) && typeof id === "number") realClearTimeout(id); }) as typeof window.clearTimeout;
  window.clearInterval = ((id?: number) => { if (!timers.clear(id) && typeof id === "number") realClearInterval(id); }) as typeof window.clearInterval;

  const tick = (ms: number): number => {
    now = ms;
    // 时间先到,定时器先响:同一拍里 rAF 回调读到的状态就是定时器推过之后的
    timers.settle(now);
    // 先取走再跑:回调里重新注册的 rAF 属于下一帧,不然会在同一帧里无限自我调用
    const due = queue;
    queue = [];
    for (const e of due) {
      try {
        e.cb(ms);
      } catch (err) {
        console.error("[stageClock] rAF 回调抛错", err);
      }
    }
    return due.length;
  };

  const clock: StageClock = {
    now: () => now,
    set: (ms) => {
      // E4b:跳转不结算定时器,每个挂起定时器的剩余时间保持
      jumpTo(ms);
    },
    tick,
    pendingTimers: () => timers.size(),
    advanceTo(target, opts = {}) {
      const step = opts.step ?? DEFAULT_STEP;
      const maxCatchUp = opts.maxCatchUp ?? DEFAULT_MAX_CATCH_UP;
      if (target < now) {
        // 往回走:调用方负责重挂载,这里只把时钟拨过去(E4b:倒退是跳转,不结算定时器)
        jumpTo(target);
        opts.onFrame?.(target, tick(target));
        return;
      }
      // 削起点同样是跳转:被削掉那一段里的定时器不触发(E4b)
      if (target - now > maxCatchUp) jumpTo(target - maxCatchUp);
      // 每一步落在帧格上(时刻用帧号直接算,不累加);最后一步走到 target 本身
      const grid = frameGrid(step, opts.fps);
      let ms = now;
      for (let k = grid.after(ms); ms < target; k++) {
        ms = grid.reaches(k, target) ? target : grid.at(k);
        opts.onFrame?.(ms, tick(ms));
      }
      if (now !== target) {
        opts.onFrame?.(target, tick(target));
      }
    },
    async advanceToAsync(target, opts = {}) {
      const step = opts.step ?? DEFAULT_STEP;
      const maxCatchUp = opts.maxCatchUp ?? DEFAULT_MAX_CATCH_UP;
      if (target < now) {
        jumpTo(target);
        opts.onFrame?.(target);
        tick(target);
        const back = opts.afterFrame?.(target);
        if (back) await back;
        return;
      }
      if (target - now > maxCatchUp) jumpTo(target - maxCatchUp);
      /*
       * 一帧里的顺序:**让出微任务 → 拨时钟 → 提交 React → 跑 rAF 回调 → 钉动画**。
       *
       * 和导出的 step() 逐步对齐:那边 `__pcSetT(sec)` 里先写 `__pcExportMs` 再 flushSync 提交,
       * 然后 `advance(budget)` 推一格虚拟时间跑这一帧,最后 `__pcSyncAnims()` 钉动画。
       * 少了「先拨时钟」这一步,React 渲染时读到的 performance.now 还是上一帧的;顺序反过来的话,
       * 凡是要**量布局**
       * 的东西就会比导出差一帧 —— 实测 chapter-bar 里 layoutId 那块高亮,预览被投影补了
       * translateY(-13.442px),而导出是 none,那 13.44 正好是父元素一帧的位移量。
       *
       * 让出微任务是给跨不过同步块的东西留口子(Motion 解析关键帧、粒子引擎异步装载)。
       */
      let ms = now;
      let ran = 0;
      const realTimeout = window.__pcRealSetTimeout ?? window.setTimeout.bind(window);
      // 每一步落在帧格上(时刻用帧号直接算,不累加);最后一步走到 target 本身
      const grid = frameGrid(step, opts.fps);
      for (let k = grid.after(ms); ms < target; k++) {
        if (opts.yieldEvery && ran > 0 && ran % opts.yieldEvery === 0) await new Promise<void>((r) => realTimeout(r, 0));
        else await Promise.resolve();
        if (opts.gate && ran > 0) { const g = opts.gate(); if (g) await g; }
        if (opts.abort?.()) return;
        ran++;
        ms = grid.reaches(k, target) ? target : grid.at(k);
        now = ms;                 // 先拨时钟:React 渲染时读到的就是这一帧
        opts.onFrame?.(ms);       // 提交
        tick(ms);                 // 跑这一帧的 rAF 回调
        const after = opts.afterFrame?.(ms);    // 钉动画
        if (after) await after;   // (canvas 卡:等这一帧的 done)
      }
      await Promise.resolve();
      if (opts.abort?.()) return;
      if (now !== target) {
        now = target; opts.onFrame?.(target); tick(target);
        const last = opts.afterFrame?.(target);
        if (last) await last;
      }
    },
  };

  w.__pcStageClock = clock;
  return clock;
}

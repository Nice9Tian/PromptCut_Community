/**
 * 常驻渲染 worker 池(每个 worker 背后守着一个 Chrome)。从 server/vite-plugin-vision.ts 逐字搬来。
 *
 * **这份模块状态只有这里能写**:`renderWorkers`(池子)、`renderJobSeq`(请求号)、
 * `lastRenderOrigin`(预热要的回连地址,ui-renderer 通过 `setLastRenderOrigin` 写)。
 *
 * 依赖方向:worker-pool → render-queue(只取 `cancelError`),单向。队列管「有没有位子」,
 * 这里管「位子上那个 Chrome 是不是热的」—— 将来做 Agent 专用 Chrome 优先通道,改的是
 * `pickWorker` / `spawnWorker` 这两处,不用动队列。
 */
import { fork, spawn } from "node:child_process";
import path from "node:path";
import { cancelError } from "./render-queue";

/** 单次渲染的墙钟上限:起 Chrome + 预热 + 一帧,超了就是卡住了 */
export const RENDER_TIMEOUT_MS = 120000;
/**
 * 叫 worker 取消之后等它回话的上限。它停在两帧之间(一帧约 20~30 ms)或者开完页就停,
 * 正常几十毫秒;冷启动 Chrome 最慢约 6 秒。超过这个数就当它卡死了,整台杀掉。
 */
export const CANCEL_GRACE_MS = 15000;

/** 一趟预渲染要告诉渲染进程的全部东西。字段名和 server/bakery 的 opts 一致 */
export interface RenderJobOpts {
  url: string;
  out: string;
  frames: string;
  fps: number;
  /** 只截这几帧(离散取样)。不给就是 frames 那个连续区间 */
  targetFrames?: number[];
}

/**
 * # 常驻渲染 worker 池
 *
 * 以前每渲一次就 spawn 一个 node、起一个 Chrome、渲完整个进程退掉。**这笔固定开销比预渲染本身
 * 大一个数量级**,实测(1920×1080,只要第 0 帧,vite 和 Chrome 都已经热着):
 *
 * ```
 *   162ms  Launching Puppeteer...        ← 进程启动 + import puppeteer 只要 155ms
 *   643ms  Warm-up 3 frames...
 *  1109ms  Export finished in 0.4s.      ← 活儿到这里就干完了
 *  4030ms  进程退出                       ← 剩下的 2.9 秒全是 browser.close() 在等 Chrome 收摊
 * ```
 *
 * 也就是说四秒里只有一秒在干活,**将近三秒是在等一个 Chrome 关机** —— 而且这三秒结结实实
 * 压在用户身上:runExport 是 `child.on("close")` 才 resolve 的。
 *
 * 换成常驻之后,同一份活实测 **4030ms → 810ms**(首趟 1261ms,含起 Chrome)。省下的既不是
 * 起进程也不是加载页面,就是那个「开机 + 关机」。
 *
 * ## 复用的确定性靠什么保证
 *
 * 不是这里保证的,是 server/bakery/chrome.mjs 里 `bakery.reset()` 保证的:每趟开一个**全新的 page**
 * (全新 renderer,从没被启用过虚拟时间,和全新起一个浏览器等价),旧 page 立刻关掉。
 * 那边有逐字节比对过的实测数据(复用渲的 vs 全新起浏览器渲的,四趟两两 6/6 全 0 帧)。
 * 这里只负责**别把一个可疑的 worker 继续用下去**:超时、崩了、报过错的一律杀掉重开
 * (worker 自己那边还有一层,见 render-worker.mjs 的「三条自保规矩」)。
 *
 * ## 为什么 worker 数不用另算一遍
 *
 * 并发上限由 `enqueue` 那个池子把着(见 maxConcurrentRenders),走到这里的活本来就不会超过它。
 * 所以这里只要「有空闲的就用,没有就再开一个」,不必再算一次 —— 两处各算各的,迟早会
 * 出现「池子说能跑 7 个,worker 只有 3 个」这种对不上账的事。多出来的 worker 由它自己的
 * 闲置超时收掉。
 */
export interface RenderWorker {
  child: import("node:child_process").ChildProcess;
  busy: boolean;
  /** 这个 worker 上还没回来的活:请求 id → 结果回调。`started` 是它有没有真的开跑 */
  pending: Map<number, { ok: (result?: any) => void; fail: (e: Error) => void; timer: NodeJS.Timeout | null; started: boolean }>;
  /**
   * 手上有一张备好的空页(worker 回过 hot):下一趟来活只需把项目灌进去,约 3~4 ms 就能开渲。
   * 界面那对热备渲染器按它挑「谁是热的」(docs/archive/topics/decoupling-plan.md 第 3.2 节)。
   */
  hot: boolean;
  /** 忙着的时候收到的 hot:收尾放掉 busy 时再算热(hot 常和 done 同一轮到达,见 spawnWorker) */
  hotPending?: boolean;
  /** 收到过几次 hot、最近一次什么时候(热备状态的明细,排查用) */
  hotMsgs?: number;
  lastHotAt?: number;
  /** 最近一次被热备巡检催着预热是什么时候(同一台 5 秒内不重复催) */
  warmingAt?: number;
  /** 变热时的回调(热备调度用来派待办) */
  onHot?: () => void;
  /** stdout/stderr 的最后几行,出错时当错误信息用 */
  tail: string[];
  /** 已经不能再派活了(超时杀掉 / 自己退了) */
  dead: boolean;
  /**
   * 前台专用。**后台的活一律不许碰它。**
   *
   * 池子按并发上限分配槽位本来就给前台留了一格,但那只解决「有没有位子」,解决不了
   * 「位子上那个 Chrome 是不是热的」:后台预渲染会把所有已有的 worker 占满,于是用户
   * 松手要图时只能现开一个 —— 又是一次开机。留一个专属的、预热好的、永不闲置退出的,
   * 用户拖到哪儿松手都有人立刻接住。
   */
  reserved: boolean;
}

export const renderWorkers: RenderWorker[] = [];
let renderJobSeq = 0;
/**
 * 最近一次渲染用的源地址。预热要一个能打开的导出页地址,而预热发生在「还没有活」的时候,
 * 手上没有任何 opts.url 可用 —— 记一个下来就够,反正整个开发服务器只有一个源。
 */
let lastRenderOrigin: string | null = null;

/** 从池子里摘掉一个 worker 并杀掉它;它身上没回来的活全部判失败 */
export function killWorker(w: RenderWorker, why: Error) {
  if (w.dead) return;
  w.dead = true;
  const at = renderWorkers.indexOf(w);
  if (at >= 0) renderWorkers.splice(at, 1);
  for (const p of w.pending.values()) { clearTimeout(p.timer); p.fail(why); }
  w.pending.clear();
  // 渲染进程自己还拉着一个 Chrome,只杀它会留孤儿
  if (process.platform === "win32" && w.child.pid) spawn("taskkill", ["/PID", String(w.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else w.child.kill("SIGKILL");
}

export function spawnWorker(root: string, reserved = false): RenderWorker {
  const child = fork(path.resolve(root, "scripts/render-worker.mjs"), [], {
    cwd: root,
    // stdout/stderr 留着当错误信息;协议走第四条 ipc 通道,不和日志混在一起
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    // 父进程没有控制台时（例如被 vite 脱离控制台起的渲染主机），不加这个会在 Windows 上新开一个可见的控制台窗口
    windowsHide: true,
    // 前台那个常驻不许闲置退出(0 = 永不),否则用户去改会儿参数回来又要等一次开机
    env: reserved ? { ...process.env, PROMPTCUT_WORKER_IDLE_MS: "0" } : process.env,
  });
  const w: RenderWorker = { child, busy: false, pending: new Map(), tail: [], dead: false, reserved, hot: false };
  const keep = (chunk: Buffer) => { w.tail.push(chunk.toString()); if (w.tail.length > 20) w.tail.shift(); };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("message", (msg: any) => {
    if (msg?.type === "hot") {
      w.hotMsgs = (w.hotMsgs ?? 0) + 1;
      w.lastHotAt = Date.now();
      /*
       * worker 只在手上没活时才报 hot。但它往往紧跟着「done」一起到:两条消息同一轮连着派发,
       * 这时 runOnWorker 还没来得及把 busy 放掉。忙着的时候先记下来,收尾放掉 busy 时再算热
       * (见 runOnWorker)—— 直接丢掉的话,「热」就一直停在 0。
       */
      if (w.busy) {
        w.hotPending = true;
        return;
      }
      w.hot = true;
      w.onHot?.();
      return;
    }
    const p = msg ? w.pending.get(msg.id) : undefined;
    if (!p) return;
    if (msg.type === "started") { p.started = true; return; }
    if (msg.type !== "done" && msg.type !== "error") return;
    w.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    // busy 由派活的那一方在整趟(渲染 + 后处理)结束后放掉,见 runOnWorker
    if (msg.type === "done") p.ok(msg.result);
    else {
      /*
       * worker 报错时它自己已经把那个 bakery 丢掉了(见 render-worker 的第 1 条规矩),
       * 进程本身还是干净的,所以**不杀**,下一趟它会重新开一个浏览器。
       * 被取消的(cancelled)连 bakery 都没丢,只是换一张页。
       */
      p.fail(Object.assign(new Error(String(msg.message || "渲染失败")), { cancelled: !!msg.cancelled }));
    }
  });
  const bury = (code: number | null) => {
    if (w.dead) return;
    const msg = w.tail.join("").trim().slice(-600);
    killWorker(w, new Error(code === 3221225794
      ? "渲染进程启动失败(0xC0000142)。同时开着的浏览器实例太多,等导出跑完再看图。"
      : `渲染进程异常退出(代码 ${code})${msg ? `:${msg}` : ""}`));
  };
  child.on("error", (e) => { if (!w.dead) killWorker(w, e instanceof Error ? e : new Error(String(e))); });
  child.on("exit", bury);
  renderWorkers.push(w);
  // 前台那个一生下来就把 Chrome 开起来 —— 等用户松手才开机,他就要多等约 1.3 秒
  if (reserved && lastRenderOrigin) child.send({ type: "prewarm", url: `${lastRenderOrigin}/?export=1` });
  return w;
}

/**
 * 挑一个 worker 干活。**前台和后台走两条路。**
 *
 *   前台(用户松手正等着看的那一张)—— 只用 reserved 那个:它是热的、专属的、永不闲置退出,
 *     后台再忙也占不到它。派走之后**立刻再备一个热的**,免得用户连着拖两次时第二次没人接。
 *   后台(空闲预渲染)—— 只用非 reserved 的,没有空闲的就再开一个。
 *     **绝不碰 reserved**:预渲染一个活五六秒,占住它这套东西就白做了。
 *
 * 池子的并发上限(见 pumpRenderQueue)管的是「有没有位子」,这里管的是
 * 「位子上那个 Chrome 是不是热的」—— 两件事,缺一个用户都得干等一次开机。
 */
function pickWorker(root: string, priority: number): RenderWorker {
  if (priority > 0) {
    const w = renderWorkers.find((x) => x.reserved && !x.busy && !x.dead) ?? spawnWorker(root, true);
    w.busy = true;
    ensureSpareWorker(root);
    return w;
  }
  const w = renderWorkers.find((x) => !x.reserved && !x.busy && !x.dead) ?? spawnWorker(root, false);
  w.busy = true;
  return w;
}

/** 手上没有空闲的前台 worker 了就再开一个并预热 —— 「开渲之后立刻备一个」的落点 */
function ensureSpareWorker(root: string) {
  if (renderWorkers.some((x) => x.reserved && !x.busy && !x.dead)) return;
  spawnWorker(root, true);
}

/**
 * 跑一趟预渲染。单张和批量共用同一套超时 / 报错处理。
 *
 * 超时的处理和以前一样是**杀进程**,但杀的是整个 worker(连它守着的 Chrome)——
 * 卡住的页面留着比重开一个贵:下一趟在它上面渲出来的东西不可信,而且不报错。
 */
/** 一帧交出去之前的像素活,由渲染 worker 做(server/png-post.mjs 的 postFrame) */
export interface PostItem {
  cards: string;
  layers?: string[];
  out: string;
  bg?: string | null;
  stats?: boolean;
  shrink?: boolean;
}

/**
 * 一趟渲染活:先渲帧(opts),再可选地做后处理(post 在渲帧结束后才调,那时素材层也抽好了)。
 * post 返回 null = 什么都不用做,调用方直接读帧文件。
 */
export interface RenderJob2 {
  opts: RenderJobOpts;
  post?: () => Promise<PostItem[] | null>;
}

/** 谁来跑一趟活:渲染池(runExport)或界面那对热备渲染器(uiRenderer.run) */
export type Runner = (job: RenderJob2, signal?: AbortSignal) => Promise<any[] | null>;

/**
 * 给一个 worker 发一条消息,等它回话。超时就连 worker 带 Chrome 一起杀掉
 * (卡住的页面留着比重开一个贵:下一趟在它上面渲出来的东西不可信,而且不报错)。
 *
 * `signal` 拨了就不等了:渲帧那一种顺手叫 worker 停下(它在两帧之间停,只换页不换浏览器),
 * 这边立刻返回「已取消」。worker 那边随后回来的那条 error 找不到等它的人,直接丢掉。
 */
function callWorker(
  w: RenderWorker,
  msg: { type: string; id: number; [k: string]: any },
  timeoutMs: number,
  signal?: AbortSignal,
  entry: { ok: (r?: any) => void; fail: (e: Error) => void; timer: NodeJS.Timeout | null; started: boolean } =
    { ok: () => {}, fail: () => {}, timer: null, started: false },
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = msg.id;
    entry.ok = resolve;
    entry.fail = reject;
    entry.timer = setTimeout(() => {
      w.pending.delete(id);
      killWorker(w, new Error(`渲染超时(${timeoutMs / 1000} 秒)。`));
      reject(new Error(`渲染超时(${timeoutMs / 1000} 秒)。`));
    }, timeoutMs);
    w.pending.set(id, entry);
    if (signal?.aborted) {
      // 还没发出去就不要了:干脆不发,也不发 cancel(发了 worker 那边会记一个永远用不上的 id)
      w.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      return reject(cancelError());
    }
    /*
     * 取消:叫 worker 停下,但**不在这里放手** —— 要等它回话(它停在两帧之间,或者开完页一看已取消),
     * 这台 worker 才真的空出来。以前这里立刻 reject,busy 马上变 false:渲染池的在跑计数偏小、Chrome 超发,
     * 下一趟活派到同一台上还得排在旧活后面,热备的「打断」也腾不出真正空闲的那台。
     * 后处理(post)很快,不取消,让它做完。worker 迟迟不回话就当它卡死了,整台杀掉。
     */
    const onAbort = () => {
      if (!w.pending.has(id) || msg.type !== "bake") return;
      w.child.send({ type: "cancel", id }, () => {});
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        if (!w.pending.has(id)) return;
        w.pending.delete(id);
        killWorker(w, new Error(`取消之后 ${CANCEL_GRACE_MS / 1000} 秒 worker 还没停下`));
        reject(cancelError());
      }, CANCEL_GRACE_MS);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    w.child.send(msg, (e) => {
      if (!e) return;
      w.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      killWorker(w, e);
      reject(e);
    });
  });
}

/**
 * 在这个 worker 上跑完一整趟:渲帧,然后(需要的话)后处理。**同一个 worker 做两步**:
 * 帧文件就在它刚写的目录里,而且整趟算一个槽位,调度那边不用拆开记账。
 * 结束时放掉 busy —— 不管成功、失败还是取消。
 */
export async function runOnWorker(w: RenderWorker, job: RenderJob2, signal?: AbortSignal): Promise<any[] | null> {
  w.hot = false;
  w.hotPending = false;
  try {
    const entry = { ok: () => {}, fail: () => {}, timer: null, started: false };
    try {
      await callWorker(w, { type: "bake", id: ++renderJobSeq, opts: job.opts }, RENDER_TIMEOUT_MS, signal, entry);
    } catch (e: any) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { notStarted: !entry.started });
    }
    if (!job.post) return null;
    // 渲完帧才发现调用方已经不要了:后处理就不做了
    if (signal?.aborted) throw cancelError();
    const items = await job.post();
    if (!items || !items.length) return null;
    return await callWorker(w, { type: "post", id: ++renderJobSeq, items }, RENDER_TIMEOUT_MS, signal);
  } finally {
    w.busy = false;
    // 忙着的时候 worker 已经报过 hot(备用页好了、手上没活):现在放手了,补上
    if (w.hotPending && !w.dead) {
      w.hotPending = false;
      w.hot = true;
      w.onHot?.();
    }
  }
}

/**
 * 在渲染池里跑一趟。单张和批量共用同一套超时 / 报错处理。
 */
export async function runExport(root: string, job: RenderJob2, priority = 0, signal?: AbortSignal, retry = true): Promise<any[] | null> {
  try { lastRenderOrigin = new URL(job.opts.url).origin; } catch { /* 地址不合法就不记,预热那一步自然跳过 */ }
  const w = pickWorker(root, priority);
  try {
    return await runOnWorker(w, job, signal);
  } catch (e: any) {
    /*
     * **没开跑的活重发一次。** 只有一种成因:派活的那一刻这个 worker 正好闲置超时自己退了
     * (IPC 是异步的,谁也拦不住这个瞬间)。不重试的话,用户每隔一阵子就会随机撞上一次
     * 「渲染进程异常退出」,而下一次点又好了 —— 最难查的那种偶发。
     *
     * 开跑之后失败的**不**重发:那时候可能已经落了一半的盘,而 worker 那边已经把出过错的
     * bakery 丢掉了,下一趟本来就是干净的。被取消的当然也不重发。
     */
    if (retry && e?.notStarted && !e?.cancelled) return await runExport(root, job, priority, signal, false);
    throw e;
  }
}


/**
 * `lastRenderOrigin` 的极薄 setter。原来 createUiRenderer 直接给这个模块级变量赋值,
 * 拆出去之后 ESM 的导入绑定是只读的 —— 状态仍然只有这一份,只是写它要走这里。
 */
export function setLastRenderOrigin(origin: string) {
  lastRenderOrigin = origin;
}

/** 卡片源码一变,告诉本进程所有渲染 worker 扔掉备用页(里面是旧模块) */
export function invalidateWorkers() {
  for (const w of renderWorkers) {
    if (w.dead) continue;
    w.hot = false;
    try { w.child.send({ type: "invalidate" }, () => {}); } catch { /* 送不到的 worker 下一趟本来就会重开 */ }
  }
}

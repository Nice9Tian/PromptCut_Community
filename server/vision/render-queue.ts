/**
 * 渲染并发队列(优先级 + 槽位)。从 server/vite-plugin-vision.ts 逐字搬来。
 *
 * **这份模块状态只有这里能写**:`renderWaiting`(排队中的活)和 `renderRunning`(在跑几个)。
 * 别的模块只通过 `enqueue` 派活、读 `renderRunning` 看账 —— 复制成两份就等于两套并发上限。
 *
 * 这里不认识 Chrome:它只知道「一个活是一个返回 promise 的函数」。worker 池反过来 import
 * 本模块的 `cancelError`,方向是 worker-pool → render-queue,单向、无环。
 */
import os from "node:os";
import { exportsRunning, onPoolChange } from "../render-pool-state.mjs";

/**
 * 渲染池:**并行跑几个,但有上限**,而且分两档优先级。
 *
 * # 为什么有上限,而不是敞开跑
 *
 * 每次渲染都要起一个 Chrome。这台机器上吃过一个亏:导出时并发的浏览器实例一多,渲染进程
 * 直接以 **0xC0000142**(STATUS_DLL_INIT_FAILED)退出 —— 连 DLL 都没加载起来,
 * 报不出任何有用的信息(vite-plugin-export.ts 里还留着专门解释这个错误码的提示)。
 * 所以这里的上限不是保守,是**踩过的坑**:敞开跑换来的不是快,是一批莫名其妙失败的渲染。
 *
 * 上限按机器定(见 maxConcurrentRenders),可以用 `PROMPTCUT_RENDER_CONCURRENCY` 覆盖。
 *
 * # 为什么分优先级
 *
 * 原来这里是一条 promise 链,严格先来后到 —— 那时候队里只有用户自己触发的请求,先来后到
 * 就是对的。有了空闲预渲染之后队里长期排着一堆没人等的活,用户一拖进度条,他正盯着的那张
 * 就得排在它们后面:实测跳到一个新位置要 **19.5 秒**才出画面,而单张只要 4 秒。
 *
 * 插队只插**还没开始**的:正在跑的那几个 Chrome 不打断(打断等于白烧几秒)。
 * 所以前台最坏等一个槽位空出来,而不是等整条队。
 */
interface RenderJob { run: () => Promise<any>; ok: (v: any) => void; fail: (e: any) => void; priority: number; queueTimer?: NodeJS.Timeout }
const renderWaiting: RenderJob[] = [];
export let renderRunning = 0;

/**
 * 同时能跑几个渲染。
 *
 * 每个渲染 = 一个 node + 一个 Chrome,既吃核也吃内存(实测一个约 300~500MB)。
 * 所以两头都要卡:按核心数算一份,按**空闲内存**再算一份,取小的。
 * 上限 8 是人为的天花板 —— 再多的收益已经很小,而 0xC0000142 的风险是随实例数涨的。
 */
export function maxConcurrentRenders(): number {
  const override = Number(process.env.PROMPTCUT_RENDER_CONCURRENCY);
  if (Number.isFinite(override) && override >= 1) return Math.min(16, Math.floor(override));
  const byCpu = Math.floor((os.cpus()?.length || 4) / 4);
  // 给每个实例留 700MB 余量,并且始终给系统留 2GB
  const byMem = Math.floor((os.freemem() - 2 * 1024 ** 3) / (700 * 1024 * 1024));
  return Math.max(1, Math.min(8, byCpu, Number.isFinite(byMem) ? byMem : 8));
}

/**
 * **永远给前台留一个槽位。**
 *
 * 插队(priority)只解决「谁先排」,解决不了「有没有位子」:空闲预渲染会把池子填满,
 * 于是用户改完一张卡、正盯着屏幕等的那一张,得先等某个没人等的活跑完才有槽位。
 * 实测过一次 13.6 秒 —— 插队是生效的,可它前面那 7 个都已经在跑了,插队插不进正在跑的。
 *
 * 所以后台(priority 0)最多只能用到 `max - 1`,剩下那个槽位专门空着等前台。
 * 代价是吞吐少了 1/7,换来的是**用户永远不用等一个没人等的活**。
 *
 * 只有一个槽位的机器留不出来(留了就没人干活了),那时退化成原来的行为。
 */
function pumpRenderQueue() {
  const max = maxConcurrentRenders();
  /*
   * 导出也占槽位(它自己起 Chrome,不走这个队列,见 render-pool-state.mjs)。
   * 按计划 3.3 节:导出期间**空闲预渲染整个暂停** —— 预渲染是给 3D 视图猜着先渲的,导出时用户多半
   * 不在看;Agent 的活照常,还能用上导出之外的全部槽位(导出最多占 max - 1 个,默认按资源自动分片)。
   */
  const exporting = exportsRunning();
  while (renderWaiting.length) {
    // 队列是按优先级插好序的,队头就是下一个最该跑的
    const next = renderWaiting[0];
    if (next.priority <= 0 && exporting > 0) break;
    const limit = next.priority > 0 ? max : Math.max(1, max - 1);
    if (renderRunning + exporting >= limit) break;
    const item = renderWaiting.shift()!;
    // 排队看门狗只管排队那一段;真开跑了就归 runExport 的 RENDER_TIMEOUT_MS 管
    if (item.queueTimer) clearTimeout(item.queueTimer);
    renderRunning++;
    Promise.resolve()
      .then(item.run)
      .then(item.ok, item.fail)
      .finally(() => { renderRunning--; pumpRenderQueue(); });
  }
}

/**
 * priority 越大越先跑。前台(用户正等着看的)传 1,空闲预渲染用默认的 0。
 *
 * `queueTimeoutMs`:**排队等太久就别等了。**
 *
 * runExport 的 `RENDER_TIMEOUT_MS` 是从「派活那一刻」起算的,盖不住前面排队的那一段。
 * 于是一个活可以在队列里躺任意久而没有任何看门狗上膛 —— 上层(见 mcp-tools.mjs 里
 * see_frames 的 timeoutMs)先到点放弃等待,回一句「超过 N 秒没有返回」,而这句话
 * 什么都没解释:到底是渲染卡住了,还是压根没轮到它?两者的下一步完全不同。
 * 给排队单独上一个看门狗,超时就把它从队里摘掉并说清是**排队**排掉的。
 */
/** 调用方不要了(连接断开 / 被取消)时抛的错。带 cancelled,调用方据此不当成渲染失败 */
export function cancelError(): Error {
  return Object.assign(new Error("请求方已经不要这张图了,渲染已取消"), { cancelled: true });
}

// 导出一结束,被暂停的预渲染接着派
onPoolChange(() => pumpRenderQueue());

/**
 * `signal`:调用方断开连接(或者 Agent 那边已经放弃等待)就拨它。
 * 还在排队的直接摘掉;已经开跑的由 job 自己看同一个 signal 去叫停 worker(见 runOnWorker)。
 * 以前服务端从不看断开:页面那边掐了请求,活照样留在队里、照样渲完,白占一个 Chrome。
 */
export function enqueue<T>(job: () => Promise<T>, priority = 0, queueTimeoutMs = 0, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((ok, fail) => {
    if (signal?.aborted) return fail(cancelError());
    const item: RenderJob = { run: job, ok, fail, priority };
    signal?.addEventListener("abort", () => {
      const at = renderWaiting.indexOf(item);
      if (at < 0) return; // 已经开跑了,交给 job 自己停
      renderWaiting.splice(at, 1);
      if (item.queueTimer) clearTimeout(item.queueTimer);
      fail(cancelError());
    }, { once: true });
    if (queueTimeoutMs > 0) {
      item.queueTimer = setTimeout(() => {
        const at = renderWaiting.indexOf(item);
        if (at < 0) return; // 已经开跑了,轮不到这里管
        renderWaiting.splice(at, 1);
        fail(new Error(
          `排队等渲染超过 ${Math.round(queueTimeoutMs / 1000)} 秒还没轮到(前面有 ${renderRunning} 个正在渲)。`
          + `不是这张卡的问题 —— 过一会儿再看,或者等手上的导出 / 预渲染跑完。`,
        ));
      }, queueTimeoutMs);
    }
    // 插在所有优先级不低于它的之后 —— 同级之间仍然先来后到
    const at = renderWaiting.findIndex((w) => w.priority < priority);
    if (at < 0) renderWaiting.push(item); else renderWaiting.splice(at, 0, item);
    pumpRenderQueue();
  });
}

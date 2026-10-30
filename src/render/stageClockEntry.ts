/**
 * 渲染面时钟的安装入口。**必须是 main.tsx 的第一个 import。**
 *
 * Motion 在自己的模块初始化时就把 requestAnimationFrame 抓进了帧循环里
 * (createRenderBatcher(requestAnimationFrame, ...)),晚于它安装的补丁对它无效——
 * 那样卡片还是按墙上时钟播,拖播放头就又变成「从头重播一遍」。
 * 所以这个文件要排在所有会牵出 motion 的 import 之前。
 *
 * 只在 ?stage=1 的渲染面里装;编辑器主文档不能装,不然它自己的界面动画会被一起冻住。
 *
 * 同一个道理也管随机数和墙上时钟:第三方库在模块加载时就抓走 Math.random(lottie-web 的
 * `BMMath.random = Math.random`),所以 pinEntropy 也要在这里、赶在所有 import 之前装上 ——
 * 导出视图(?export=1)和渲染面(?stage=1)都装。导出视图的 performance.now / rAF 仍由
 * ExportView 里的 installExportClock 装,时机不变(提前装会换掉 Motion 的时间戳来源)。
 * proto-main.tsx 也把这个文件放在第一行,proto.html 的导出入口同样罩得住。
 */
import { installStageClock } from "./stageClock";
import { installPinnedEntropy } from "../kernel/pinEntropy";

/**
 * 浏览器逐帧导出(C10a,`src/export/frameCompositor.ts`)的导出页带 `?export=1&rafControl=1`:这里没有 CDP 的 beginFrame,
 * 若照常跑真 rAF,Motion 的帧循环(模块求值时就抓走了 rAF)每个真 vsync 都走一拍、每拍至少推 1 ms,
 * 合成一帧要几百毫秒,弹簧类动画就越走越快。所以赶在 Motion 之前把 rAF 换成手动队列:
 * 回调只在导出方调 `window.__pcBrowserBeginFrame()` 时跑一轮(一拍 = 桌面导出的一次 beginFrame)。
 * 兜底:有回调在排队而 5 秒没人推(页面里有东西在等 rAF),自己推一拍并记进 `__pcRafFallbacks`,不让导出挂死;
 * 正常导出里它应为 0(浏览器导出的统计里带出来)。
 * 桌面导出、预渲染不带 `rafControl`,一个字节不变。
 */
function installManualRaf(): void {
  const w = window as Window & { __pcBrowserBeginFrame?: () => number; __pcRafFallbacks?: number };
  let queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  let fallback: ReturnType<typeof setTimeout> | null = null;
  w.__pcRafFallbacks = 0;
  const beginFrame = (): number => {
    if (fallback !== null) { clearTimeout(fallback); fallback = null; }
    const due = queue;
    queue = new Map();
    const ts = performance.now();
    for (const cb of due.values()) { try { cb(ts); } catch (e) { console.error(e); } }
    return due.size;
  };
  w.__pcBrowserBeginFrame = beginFrame;
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId++;
    queue.set(id, cb);
    fallback ??= setTimeout(() => { fallback = null; w.__pcRafFallbacks = (w.__pcRafFallbacks ?? 0) + 1; beginFrame(); }, 5000);
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => { queue.delete(id); };
}

if (typeof window !== "undefined") {
  const q = new URLSearchParams(location.search);
  if (q.has("stage")) {
    installStageClock();
    installPinnedEntropy(); // 在舞台时钟之后:Date 要读得到舞台时间
  } else if (q.has("export")) {
    if (q.get("rafControl") === "1") installManualRaf();
    installPinnedEntropy();
  }
}

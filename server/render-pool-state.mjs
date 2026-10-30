/**
 * 预渲染进程里「渲染池之外、但也占着槽位」的活:目前只有完整导出。
 *
 * 导出是一整趟长任务,不走渲染池的队列(它自己 spawn scripts/export-frames.mjs),但它同样起一个 Chrome、
 * 同样吃核。所以池子算「还剩几个槽位」时要把它算进去,而且按计划 3.3 节:
 *
 *   - 导出优先级最低,最多占「池子总数 − 1」个槽位,永远给 Agent 留一个;
 *   - 导出期间**暂停空闲预渲染** —— 预渲染是给 3D 视图猜着先渲的,这时用户多半不在看,
 *     让它和导出正常排,导出反而要排在一堆投机性的活后面。
 *
 * 两个插件(vite-plugin-export 记账,vite-plugin-vision 查账)在同一个进程里,共用这一份模块状态。
 */
let exporting = 0;
const listeners = new Set();

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch { /* 一个监听者出错不该拖垮记账 */ }
  }
}

/** 一趟导出开始了 */
export function exportBegin() {
  exporting++;
  emit();
}

/** 一趟导出结束了(成功、失败、被取消都要调) */
export function exportEnd() {
  exporting = Math.max(0, exporting - 1);
  emit();
}

/** 此刻有几趟导出在跑 */
export function exportsRunning() {
  return exporting;
}

/** 导出开始 / 结束时通知(渲染池靠它在导出结束后接着派被暂停的预渲染) */
export function onPoolChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

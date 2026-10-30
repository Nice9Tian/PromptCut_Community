/**
 * 让挂着的宏任务跑完,直到 DOM 不再变。
 *
 * React 经 Scheduler 的 MessageChannel 排的提交、`v.on("change", setState)` 那条异步渲染都在这里落地;
 * 不排空的话它们会落到哪一帧取决于运气。控件、字体、图片就绪由 waitFrameReady 等待,超时明确失败。
 *
 * 原来写在 `scripts/export-frames.mjs`(引擎现为 `server/bakery/chrome.mjs`)的 `PAGE_PRELUDE` 里(由 `evaluateOnNewDocument` 注入),
 * 现在是页面 bundle 的一部分 —— 它读的 `__pcMutationCount` 本来就在 bundle 里
 * (`src/kernel/exportClock.ts`)。挂上 `window.__bfSettle` 的地方见 `ExportView.tsx`。
 */
export async function settleDom(): Promise<void> {
  for (let k = 0; k < 4; k++) {
    const b = window.__pcMutationCount ?? 0;
    await new Promise((r) => setTimeout(r, 0));
    if ((window.__pcMutationCount ?? 0) === b) return;
  }
}

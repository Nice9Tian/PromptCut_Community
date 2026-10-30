/**
 * Node 侧:等这一帧的素材就绪。
 *
 * 页面侧的 `__pcHideFrameMedia` / `__pcPrepareFrameMedia` 已经搬进页面 bundle
 * (`src/render/frameMedia.ts`,由 ExportView 在 React 之前装好);这里只剩下驱动它的那一半 ——
 * 名字和语义不变,`capture-snapshot.mjs` 照旧 import 这个文件。
 */
export async function prepareFrameMedia(bakery) {
  // The decoder can need compositor ticks to deliver loadeddata/seeked in headless-shell.
  let done = false;
  let failure;
  const pending = bakery.page.evaluate(() => window.__pcPrepareFrameMedia?.())
    .catch(e => { failure = e; }).finally(() => { done = true; });
  while (!done) {
    await bakery.beginFrame();
    if (!done) await new Promise(r => setTimeout(r, 4));
  }
  await pending;
  if (failure) throw failure;
  // Every video's frame has been presented; commit it before the screenshot.
  await bakery.beginFrame();
}

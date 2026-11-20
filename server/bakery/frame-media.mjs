/**
 * Node side: wait for this frame's assets to be ready.
 *
 * The page side's `__pcHideFrameMedia` / `__pcPrepareFrameMedia` have moved into the page bundle
 * (`src/render/frameMedia.ts`, installed by ExportView before React); only the driver half remains
 * here: names and semantics are unchanged, and `capture-snapshot.mjs` imports this file as before.
 */
export async function prepareFrameMedia(bakery) {
  // The decoder can need compositor ticks to deliver loadeddata/seeked in headless-shell.
  let done = false;
  let failure;
  let hasMedia = true;
  const pending = bakery.page.evaluate(async () => {
    const scope = document.getElementById('pc-frame-snapshot') || document;
    const any = !!scope.querySelector('video[data-pc-media-src], img[data-pc-media-src]');
    await window.__pcPrepareFrameMedia?.();
    return any;
  }).then(v => { hasMedia = v !== false; }).catch(e => { failure = e; }).finally(() => { done = true; });
  await Promise.race([pending, new Promise(r => setTimeout(r, 1))]);
  while (!done) {
    await bakery.beginFrame();
    if (!done) await Promise.race([pending, new Promise(r => setTimeout(r, 1))]);
  }
  await pending;
  if (failure) throw failure;
  if (!hasMedia) return false;
  // Every video's frame has been presented; commit it before the screenshot.
  await bakery.beginFrame();
  return true;
}

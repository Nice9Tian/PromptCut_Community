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

/** Keep compositor callbacks moving while async controls/fonts/images load,
 * without advancing the timeline. Never turn a readiness timeout into success.
 */
export async function waitFrameReady(bakery, signal) {
  let done = false, failure;
  const task = bakery.page.evaluate(async () => {
    do {
      await window.__bfSettle?.();
      await window.__pcFrameReady?.();
      // Force layout first so newly mounted text initiates font loading.
      document.documentElement.getBoundingClientRect();
      await document.fonts.ready;
      await Promise.all([...document.images].filter(img => img.getAttribute('src') || img.getAttribute('srcset'))
        .map(img => img.decode().catch(() => {})));
      await window.__bfSettle?.();
      // Finishing one loader can mount another control in the React commit.
    } while ((window.__pcFrameWorkStatus?.().length || 0) > 0 || document.fonts.status !== 'loaded');
  }).catch(e => { failure = e; }).finally(() => { done = true; });
  const start = Date.now();
  while (!done) {
    // Usually the gate completes without an extra tick. Async loaders that
    // depend on rAF must get ticks while their promise is pending.
    await Promise.race([task, new Promise(resolve => setTimeout(resolve, 4))]);
    if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
    if (!done) {
      if (Date.now() - start > 20000) throw new Error('控件、字体或图片在 20 秒内未就绪，已停止截图');
      await bakery.beginFrame();
    }
  }
  await task;
  if (failure) throw failure;
  await bakery.waitNet?.();
}

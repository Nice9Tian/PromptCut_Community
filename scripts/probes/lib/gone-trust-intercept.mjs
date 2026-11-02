/**
 * Shared across probes: makes pages in the probe-launched browser see the "gone" proof trust
 * table as containing several test issuers.
 *
 * In production code, the trust table has only the single one distributed with the software
 * (`TRUSTED_GONE_AUTHORITIES` in `server/recovery/gone-proof.mjs`), with no environment variables,
 * configuration files, or page hooks to extend it. When a probe needs to point a page to its own
 * mock document service, it intercepts the page's request for that module inside the **browser it
 * launched**, swaps the table contents, and hands it to the page. Interception is handled via the
 * browser debugging protocol; this path does not exist in installed desktop apps.
 *
 *   await interceptGoneTrust(page, [{ authorityId, origin, services: [...], keys: { kid: publicKey } }]);   // before page.goto
 */
const MODULE = /\/server\/recovery\/gone-proof\.mjs(?:\?|$)/;
const ANCHOR = 'export const TRUSTED_GONE_AUTHORITIES = deepFreeze([';

export async function interceptGoneTrust(page, authorities) {
  const state = { served: 0 };
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    if (request.isInterceptResolutionHandled()) return;
    if (!MODULE.test(request.url())) { request.continue().catch(() => {}); return; }
    try {
      const original = await (await fetch(request.url())).text();
      if (!original.includes(ANCHOR)) throw new Error('The trust table\'s form changed, the probe\'s intercept must be updated to match');
      const body = original.replace(ANCHOR, `${ANCHOR}...${JSON.stringify(authorities)},`);
      state.served++;
      await request.respond({ status: 200, contentType: 'text/javascript', headers: { 'cache-control': 'no-store' }, body });
    } catch (error) { state.error = String(error?.message ?? error); request.abort().catch(() => {}); }
  });
  return state;
}

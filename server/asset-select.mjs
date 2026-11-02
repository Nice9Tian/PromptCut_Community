/**
 * Which asset service to use for push and pull in the prerender process (contract
 * `docs/plan/render-queue-contract.md` J.13, base URL chosen per D7). Originally in
 * `vite-plugin-frames.ts`, moved here to enable unit tests
 * (`docs/archive/agent-reports/AGENT-push-scope.md`).
 *
 * Order:
 *   1. `PROMPTCUT_ASSET_URL` (formatted like `http://192.168.50.96:5460/api/asset`);
 *   2. Asset service base URL provided by the page (automated render node; fetched dynamically,
 *      switches on the next call if the page changes the base URL);
 *   3. `asset` on other machines in the service address registry (`foreignAssetEndpoints`), taking
 *      the first URL of the first entry; when the registry changes, create a new client to swap in,
 *      while in-flight requests continue using the old one (returns a proxy that retrieves the
 *      current client on each call);
 *   4. Local `assetServiceOrigin()` plus `/api/asset`.
 *
 * **Wait for registry before first call** (handoff document `HANDOFF-2026-09-29.md` section 4,
 * item 3, question 2): when neither 1 nor 2 is present, it relies on the registry to know where to
 * push, but the registry only responds after connecting to the document service and subscribing.
 * Previously, a client was created based on local first and swapped once registry arrived; thus
 * during startup (segments left unpushed in the queue file last time, segments freshly written to the
 * frame store), they were pushed to the local asset service first. Now, methods on the proxy wait
 * before "settling": wait until receiving the first registry (even if empty), or the page provides
 * a base URL, or `settleMs` elapses (cannot connect to document service, default 10 s), then proceed
 * with the choice at that time. Once settled, it behaves as before. `ready` is the promise for this
 * moment (caller can wait for it before starting the queue).
 *
 * Reads and writes carry asset tickets (M6a, `docs/plan/auth-contract.md` sections 8 and 11): for
 * entries via shared projects, caller supplies `ticket`; local identity carries no ticket. Each
 * time the base URL switches, log a line `push.asset-base { source, base }`; once settled, log a
 * line `push.asset-ready { source, base, waitedMs }`, neither containing tickets.
 */
import os from 'node:os';

/**
 * When there is no explicit base URL, wait at most this long for the registry on the first
 * push or pull
 */
export const ASSET_SETTLE_MS = 10_000;

/**
 * Identity used when registering the asset service locally (default identity in
 * `asset-announce.mjs`)
 */
export const selfAnnouncerId = (hostname = os.hostname()) => `asset:${String(hostname || 'host').replace(/[^A-Za-z0-9._:-]/g, '-') || 'host'}`.slice(0, 128);

/**
 * Asset services of **other machines** in the service address registry (J.6 asset fallback and J.13
 * push base URL share this single criterion): exclude those registered by this machine:
 * `announcerId` is the local identity, or the address shares the host with the local asset service.
 * Sorted lexicographically by `announcerId`; keep only non-local addresses for each entry, and drop
 * the entire entry if no addresses remain.
 * @param {any[]} list
 * @param {string | null} origin
 * @param {{ self?: string }} [options]
 * @returns {{ announcerId: string, urls: string[] }[]}
 */
export function foreignAssetEndpoints(list, origin, { self = selfAnnouncerId() } = {}) {
  let selfHost = '';
  try { selfHost = origin ? new URL(origin).host : ''; } catch { /* If absent, do not sort by address */ }
  const out = [];
  for (const item of list ?? []) {
    if (item?.kind !== 'asset' || typeof item.announcerId !== 'string' || item.announcerId === self) continue;
    const urls = [];
    for (const url of item.urls ?? []) {
      try { if (new URL(url).host === selfHost) continue; } catch { continue; }
      urls.push(String(url));
    }
    if (urls.length) out.push({ announcerId: item.announcerId, urls });
  }
  return out.sort((a, b) => (a.announcerId < b.announcerId ? -1 : a.announcerId > b.announcerId ? 1 : 0));
}

/**
 * @param {object} options
 * @param {{ watchServiceEndpoints(endpoint: any, kinds: string[], onChange: (list: any[]) => void): () => void }} options.node
 * @param {any} options.endpoint
 * @param {string} options.origin  Origin of the local asset service
 * @param {((opts?: { refresh?: boolean }) => Promise<string | null>) | null} options.ticket
 * @param {(opts: { base: string, ticket: any }) => any} options.createAssetClient
 * @param {string} options.owner  `for` in logs
 * @param {() => string | null} [options.preferred]  Asset service base URL currently used by the page
 * @param {string} [options.envBase]  Reads `PROMPTCUT_ASSET_URL` by default
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {number} [options.settleMs]
 * @param {() => number} [options.now]
 * @param {string} [options.self]  Local registration identity (for testing)
 */
export function selectAssetClient({ node, endpoint, origin, ticket, createAssetClient, owner, preferred, envBase: envOpt, log = () => {},
  settleMs = ASSET_SETTLE_MS, now = Date.now, self } = /** @type {any} */ ({})) {
  const say = (event, fields) => { try { log(event, fields); } catch { /* Logging errors do not affect pushing */ } };
  const localBase = `${origin}/api/asset`;
  /** @type {any} */
  let current = null;
  /** @type {string | null} */
  let currentBase = null;
  let currentSource = null;
  const use = (base, source) => {
    if (base === currentBase && current) return;
    let next;
    try { next = createAssetClient({ base, ticket }); }
    catch (error) { say('push.asset-base-error', { source, base, for: owner, message: String(/** @type {any} */ (error)?.message ?? error) }); return; }
    current = next;
    currentBase = base;
    currentSource = source;
    say('push.asset-base', { source, base, for: owner });
  };
  const envBase = String(envOpt ?? process.env.PROMPTCUT_ASSET_URL ?? '').trim().replace(/\/+$/, '');
  const pagePick = () => { try { return preferred?.() ?? null; } catch { return null; } };
  const startedAt = now();
  let settled = false;
  /** @type {(v?: any) => void} */
  let settleResolve = () => {};
  const ready = new Promise(resolve => { settleResolve = resolve; });
  let settleTimer = null;
  const settle = (why) => {
    if (settled) return;
    settled = true;
    if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
    say('push.asset-ready', { source: currentSource, base: currentBase, for: owner, why, waitedMs: Math.max(0, now() - startedAt) });
    settleResolve();
  };
  let stop = () => {};
  if (envBase) use(envBase, 'env');
  if (!current && pagePick()) use(/** @type {string} */ (pagePick()), 'page');
  // If a base URL was explicitly provided and successfully created, use only that; otherwise
  // (including when no page base URL was given), fall back to local and switch based on registry
  const envOk = !!envBase && currentBase === envBase;
  if (current) settle(envOk ? 'env' : 'page');
  if (!envOk) {
    if (!current) use(localBase, 'local');
    stop = node.watchServiceEndpoints(endpoint, ['asset'], (list) => {
      if (pagePick()) { if (!settled) { use(/** @type {string} */ (pagePick()), 'page'); settle('page'); } return; }
      const url = foreignAssetEndpoints(list, origin, self ? { self } : undefined)[0]?.urls[0];
      if (url) use(url.replace(/\/+$/, ''), 'announced');
      else use(localBase, 'local');
      settle('announced');
    });
    if (!settled) {
      settleTimer = setTimeout(() => {
        settleTimer = null;
        const p = pagePick();
        if (p) use(p, 'page');
        settle(p ? 'page' : 'timeout');
      }, Math.max(0, Number(settleMs) || 0));
      settleTimer?.unref?.();
    }
  }
  /**
   * Client to use at this moment (if page provided it later or changed asset base URL:
   * swapped in on this invocation)
   */
  const pick = () => {
    if (!envOk) {
      const p = pagePick();
      if (p && p !== currentBase) use(p, 'page');
      if (p && !settled) settle('page');
    }
    return current;
  };
  const client = new Proxy({}, { get: (_target, key) => {
    const now0 = pick();
    const value = now0?.[key];
    if (typeof value !== 'function') return value;
    if (settled) return value.bind(now0);
    // Not settled yet: wait until settled, then call per the choice at that time (all methods are async)
    return (...args) => ready.then(() => { const c = pick(); return c[key](...args); });
  } });
  return {
    client,
    ready,
    settled: () => settled,
    stop: () => { if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; } try { stop(); } catch { /* Already stopped */ } settle('stopped'); },
    base: () => currentBase,
  };
}

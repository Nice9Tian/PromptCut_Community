/**
 * The part of `asset-lan-probe.mjs` that finds the asset service address, split out for unit testing
 * (`server/test/asset-lan-discover.test.mjs`).
 *
 * Local projects: the asset service address is returned via LAN discovery (`asset` field in
 * `server/lan/discovery.mjs` response), and does not enter the control plane's `service.endpoints`
 * (`vite-plugin-media.ts` registers only when `PROMPTCUT_DOCSERVICE_URL` is set).
 * The probe previously always waited for `service.endpoints`, which timed out for local projects.
 * Now it first searches for this project via LAN discovery, using the address in the response if
 * found; if not found (cloud projects, or not on the same subnet), it waits for `service.endpoints`
 * as before.
 *
 * Uses only Node built-in modules and repository modules that do not depend on `node_modules` (the
 * probe needs to run on laptops without installed dependencies).
 */

/** LAN discovery timeout (matches `ROUTE_DEFAULTS.LAN_TIMEOUT_MS` in `server/auth/route.mjs`) */
export const LAN_DISCOVER_TIMEOUT_MS = 3_000;

const nameKey = (name) => String(name).normalize('NFC').toLowerCase();

/**
 * Hosts belonging to this project in discovery results → candidates (ordered by first seen,
 * deduplicated by asset address).
 * Matched by projectId when projectId is present; matched by name when only name is present
 * (case-insensitive, matching `nameKey` in `discovery.mjs`).
 * @param {Array<{ projectId: string, name: string, asset: string, docservice: string, hostDeviceName?: string, firstSeenMs?: number }>} hosts
 * @param {{ projectId?: string | null, name?: string | null }} want
 * @returns {{ asset: string, docservice: string, hostDeviceName: string | null, firstSeenMs: number | null }[]}
 */
export function lanCandidates(hosts, { projectId = null, name = null } = {}) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(hosts) ? hosts.slice() : [];
  list.sort((a, b) => (a?.firstSeenMs ?? Infinity) - (b?.firstSeenMs ?? Infinity));
  for (const h of list) {
    if (!h || typeof h.asset !== 'string' || h.asset === '') continue;
    if (projectId) { if (h.projectId !== projectId) continue; }
    else if (name) { if (typeof h.name !== 'string' || nameKey(h.name) !== nameKey(name)) continue; }
    else continue;
    const asset = h.asset.replace(/\/+$/, '');
    if (seen.has(asset)) continue;
    seen.add(asset);
    out.push({ asset, docservice: h.docservice ?? null, hostDeviceName: h.hostDeviceName ?? null, firstSeenMs: Number.isFinite(h.firstSeenMs) ? h.firstSeenMs : null });
  }
  return out;
}

/**
 * Finds this project via LAN discovery. Returns `{ candidates, ms, errors }`, does not throw
 * (socket open failures and missing network interfaces all go into errors).
 * @param {{ projectId?: string | null, name?: string | null }} want
 * @param {{ discover?: Function, timeoutMs?: number, discoverOptions?: object }} [opts]
 *   `discover` defaults to `discoverLan` in `server/lan/discovery.mjs`; unit tests inject loopback
 *   interface and port via `discoverOptions`
 */
export async function discoverLanAsset(want, { discover, timeoutMs = LAN_DISCOVER_TIMEOUT_MS, discoverOptions = {} } = {}) {
  const t0 = Date.now();
  let fn = discover;
  try {
    fn ??= (await import(new URL('../../server/lan/discovery.mjs', import.meta.url))).discoverLan;
    // When only name is present, let discovery filter by name; when projectId is present, do not pass
    // name (name might have changed), matching by projectId after receiving results
    const r = await fn({ ...(want?.projectId ? {} : want?.name ? { name: want.name } : {}), timeoutMs, ...discoverOptions });
    const hosts = Array.isArray(r) ? r : r?.hosts ?? [];
    const errors = Array.isArray(r?.errors) ? r.errors.slice(0, 3) : [];
    return { candidates: lanCandidates(hosts, want ?? {}), ms: Date.now() - t0, errors };
  } catch (err) {
    return { candidates: [], ms: Date.now() - t0, errors: [{ reason: 'discover', message: String(err?.message ?? err) }] };
  }
}

/**
 * Tries candidate addresses in order: first one where `GET <base>/media/<nonexistent hash>/chunks`
 * with ticket returns 200. Returns null if none succeed.
 * @param {string[]} bases
 * @param {{ ticket: string, missingHash: string, fetch?: typeof fetch, timeoutMs?: number }} o
 */
export async function firstReachableAsset(bases, { ticket, missingHash, fetch: f = globalThis.fetch, timeoutMs = 3000 }) {
  for (const u of bases) {
    const base = String(u).replace(/\/+$/, '');
    try {
      const r = await f(`${base}/media/${missingHash}/chunks`, { headers: { Authorization: `Bearer ${ticket}` }, signal: AbortSignal.timeout(timeoutMs) });
      await r.arrayBuffer().catch(() => {});
      if (r.status === 200) return base;
    } catch { /* Next */ }
  }
  return null;
}

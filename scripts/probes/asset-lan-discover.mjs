/**
 * `asset-lan-probe.mjs` 找素材服务地址的那一段，拆出来好单测（`server/test/asset-lan-discover.test.mjs`）。
 *
 * 放本机的项目：素材服务地址经局域网发现带回（`server/lan/discovery.mjs` 的应答里 `asset` 字段），
 * 不进控制面的 `service.endpoints`（`vite-plugin-media.ts` 只在设了 `PROMPTCUT_DOCSERVICE_URL` 时登记）。
 * 探针以前一律等 `service.endpoints`，对放本机的项目会超时。现在先按局域网发现找这个项目，找到就用应答里的地址；
 * 找不到（放云端的项目，或者不在同一网段）再照旧等 `service.endpoints`。
 *
 * 只用 Node 内置模块和仓库里不依赖 `node_modules` 的模块（探针要在没装依赖的笔记本上跑）。
 */

/** 局域网发现的时限（同 `server/auth/route.mjs` 的 `ROUTE_DEFAULTS.LAN_TIMEOUT_MS`） */
export const LAN_DISCOVER_TIMEOUT_MS = 3_000;

const nameKey = (name) => String(name).normalize('NFC').toLowerCase();

/**
 * 发现结果里属于这个项目的主机 → 候选（按首次见到的先后，按素材地址去重）。
 * 有 projectId 按 projectId 认；只有名字时按名字认（不分大小写，同 `discovery.mjs` 的 `nameKey`）。
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
 * 按局域网发现找这个项目。回 `{ candidates, ms, errors }`，不抛（套接字打不开、没有网卡都进 errors）。
 * @param {{ projectId?: string | null, name?: string | null }} want
 * @param {{ discover?: Function, timeoutMs?: number, discoverOptions?: object }} [opts]
 *   `discover` 缺省是 `server/lan/discovery.mjs` 的 `discoverLan`；单测注入回环网卡与端口走 `discoverOptions`
 */
export async function discoverLanAsset(want, { discover, timeoutMs = LAN_DISCOVER_TIMEOUT_MS, discoverOptions = {} } = {}) {
  const t0 = Date.now();
  let fn = discover;
  try {
    fn ??= (await import(new URL('../../server/lan/discovery.mjs', import.meta.url))).discoverLan;
    // 只有名字时让发现按名字过滤；有 projectId 时不传名字（名字可能改过），收回来再按 projectId 认
    const r = await fn({ ...(want?.projectId ? {} : want?.name ? { name: want.name } : {}), timeoutMs, ...discoverOptions });
    const hosts = Array.isArray(r) ? r : r?.hosts ?? [];
    const errors = Array.isArray(r?.errors) ? r.errors.slice(0, 3) : [];
    return { candidates: lanCandidates(hosts, want ?? {}), ms: Date.now() - t0, errors };
  } catch (err) {
    return { candidates: [], ms: Date.now() - t0, errors: [{ reason: 'discover', message: String(err?.message ?? err) }] };
  }
}

/**
 * 按顺序试候选地址：带票据 `GET <base>/media/<不存在的哈希>/chunks` 回 200 的第一个。都不通回 null。
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
    } catch { /* 下一个 */ }
  }
  return null;
}

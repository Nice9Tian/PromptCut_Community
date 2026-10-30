/**
 * 预渲染进程里推送、拉取用哪一个素材服务(契约 `docs/plan/render-queue-contract.md` J.13,按 D7 选基址)。
 * 原在 `vite-plugin-frames.ts` 里,为了能单测搬到这里(`docs/archive/agent-reports/AGENT-push-scope.md`)。
 *
 * 顺序:
 *   1. `PROMPTCUT_ASSET_URL`(形如 `http://192.168.50.96:5460/api/asset`);
 *   2. 页面交来的素材服务基址(自动渲染节点;现取,页面换了基址下一次调用就换);
 *   3. 服务地址登记里别的机器的 `asset`(`foreignAssetEndpoints`),取第一个的第一个地址;登记变了就新建一个
 *      client 换上,在飞的请求照旧用旧的(回的是一个代理,每次调用时才取当前的 client);
 *   4. 本机的 `assetServiceOrigin()` 加 `/api/asset`。
 *
 * **第一次调用前先等登记**(交接文件 `HANDOFF-2026-09-29.md` 第 4 节第三条的第二问):1、2 都没有时,要靠登记才知道
 * 该推到哪里,而登记要连上文档服务、订阅之后才回。原来先按本机建 client、登记到了再换,于是起步那一阵
 * (队列文件里上次没推完的段、刚写进帧库的段)先推到了本机素材服务。现在代理上的方法在「定下来」之前先等:
 * 收到第一份登记(哪怕是空的),或页面交来了基址,或等满 `settleMs`(连不上文档服务,缺省 10 s)就按那时的选择走。
 * 定下来之后与原来相同。`ready` 是这一刻的 promise(调用方可以等它再起队列)。
 *
 * 读写带素材票据(M6a,`docs/plan/auth-contract.md` 第 8、11 节):凭共享项目进入的由调用方给 `ticket`;本机身份不带票据。
 * 每换一次基址记一行 `push.asset-base { source, base }`,定下来记一行 `push.asset-ready { source, base, waitedMs }`,都不含票据。
 */
import os from 'node:os';

/** 没有显式基址时,第一次推送、拉取最多等登记这么久 */
export const ASSET_SETTLE_MS = 10_000;

/** 本机登记素材服务时用的身份(`asset-announce.mjs` 的缺省身份) */
export const selfAnnouncerId = (hostname = os.hostname()) => `asset:${String(hostname || 'host').replace(/[^A-Za-z0-9._:-]/g, '-') || 'host'}`.slice(0, 128);

/**
 * 服务地址登记里**别的机器**的素材服务(J.6 素材回退与 J.13 推送基址共用这一个判据):本机登记的排除 ——
 * `announcerId` 是本机身份,或者地址与本机素材服务同 host。按 `announcerId` 的字典序排,每项只留不是本机的地址,
 * 留不下地址的整项去掉。
 * @param {any[]} list
 * @param {string | null} origin
 * @param {{ self?: string }} [options]
 * @returns {{ announcerId: string, urls: string[] }[]}
 */
export function foreignAssetEndpoints(list, origin, { self = selfAnnouncerId() } = {}) {
  let selfHost = '';
  try { selfHost = origin ? new URL(origin).host : ''; } catch { /* 没有就不按地址排 */ }
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
 * @param {string} options.origin  本机素材服务的源
 * @param {((opts?: { refresh?: boolean }) => Promise<string | null>) | null} options.ticket
 * @param {(opts: { base: string, ticket: any }) => any} options.createAssetClient
 * @param {string} options.owner  日志里的 `for`
 * @param {() => string | null} [options.preferred]  页面此刻用的素材服务基址
 * @param {string} [options.envBase]  缺省读 `PROMPTCUT_ASSET_URL`
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {number} [options.settleMs]
 * @param {() => number} [options.now]
 * @param {string} [options.self]  本机的登记身份(测试用)
 */
export function selectAssetClient({ node, endpoint, origin, ticket, createAssetClient, owner, preferred, envBase: envOpt, log = () => {},
  settleMs = ASSET_SETTLE_MS, now = Date.now, self } = /** @type {any} */ ({})) {
  const say = (event, fields) => { try { log(event, fields); } catch { /* 日志出错不影响推送 */ } };
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
  // 显式给了基址并且建成了就只用它;否则(含没给页面基址时)本机兜底,按登记换
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
  /** 此刻该用的 client(页面后来才给、或换了素材基址:这一次调用就换上) */
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
    // 还没定下来:等定下来再按那时的选择调(方法都是异步的)
    return (...args) => ready.then(() => { const c = pick(); return c[key](...args); });
  } });
  return {
    client,
    ready,
    settled: () => settled,
    stop: () => { if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; } try { stop(); } catch { /* 已经停了 */ } settle('stopped'); },
    base: () => currentBase,
  };
}

/**
 * 新建与打开共享项目时的路由（契约 `docs/plan/shared-project-contract.md` 第 3 节、验收 SP5）。
 *
 * 浏览器与 Node 通用：只引 `client.mjs`（WebCrypto、`fetch`）与 `hosted-default.mjs`，不引任何 Node 模块。
 * 浏览器不能发 UDP，所以**局域网发现由调用方注入**：Node 侧传 `lan.discover`（`server/lan/discovery.mjs` 的 `discoverLan`），
 * 浏览器侧不传，只走手填地址 `lan.manual` 与托管端（C10）。
 *
 * - `findSharedProject({ name, hostedUrl, lan: { discover, manual, timeoutMs }, fetch })`
 *   回 `{ candidates: [{ where: 'lan' | 'hosted', base, projectId, name, mode, hostDeviceName?, asset?, via? }], errors: [{ where, reason, … }] }`：
 *   - 局域网发现限时 3 s；托管端 `GET shared/lookup?name=`；手填地址直接 `GET /docservice/shared/lookup?name=`。
 *     三路同时进行（契约写「先……再……」，两边的结果都列出、谁也不挑，同时进行只是省时间，结果相同）；
 *   - 两边都有就都列出，谁也不挑；局域网里同名的多个主机并列，带主机设备名，由用户挑；
 *   - 托管端连不上、局域网发现超时（谁也没应答），都进 `errors`，不抛异常；托管端 404 不算错误，只是没有候选；
 *   - `hostedUrl`：不给（`undefined`）按覆盖顺序取（`resolveHostedUrl`：界面值 → `PROMPTCUT_HOSTED_URL` → 缺省）；
 *     给 `null` 或 `false` 表示这一次不问托管端（局域网模式的探针用它保证全程不连托管端）；
 *   - `base` 统一写成文档服务的 http 地址、以 `/` 结尾（契约第 11 节裁定）：局域网 `http://<ip>:<端口>/docservice/`，
 *     托管端 `http://<主机>:<端口>/`。`client.mjs` 的 `buildAuthProtocols({ base })` 直接收；要连 WebSocket 时用 `wsBaseOf(base)`；
 *   - 手填与发现到的局域网候选按 `base` 去重（同一地址只列一次，发现的在前）；同一项目经几块网卡被发现时，
 *     发现这一路自己只列一次（按 `projectId`，保留先见到的）。
 * - `pickRoute(result)`：只有一个候选 → `{ action: 'enter', candidate }`；多个 → `{ action: 'choose', candidates }`；
 *   没有 → `{ action: 'not-found', errors }`（「找不到」由调用方说）。
 * - `createSharedProject({ where: 'hosted' | 'lan', … })`：托管端向托管地址 `POST shared/create`；
 *   局域网向本机编辑器的文档服务 `POST /docservice/shared/create`（只有本机回环能建，M6a）。
 *   建成后编辑器开始广播（`vite-plugin-docservice.ts`，第 4 节），这里不管广播。
 */
import { lookupProject, createSharedProject as createOn } from './client.mjs';
import { resolveHostedUrl } from './hosted-default.mjs';

export const ROUTE_DEFAULTS = Object.freeze({
  /** 局域网发现的时限（契约第 3 节） */
  LAN_TIMEOUT_MS: 3_000,
  /** 托管端与手填地址查名字的时限 */
  LOOKUP_TIMEOUT_MS: 5_000,
});

const LAN_DOC_PATH = '/docservice';

/** 地址 → 文档服务的 WebSocket 地址：`http:` 换 `ws:`、`https:` 换 `wss:`，路径保留、去掉末尾斜杠 */
export function wsBaseOf(url) {
  const u = new URL(url);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new TypeError('地址必须是 http(s):// 或 ws(s)://');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * 手填的局域网地址 → 文档服务地址。收 `http://192.168.x.y:port`（编辑器地址，补 `/docservice`）、
 * 带路径的 `http://…/docservice`、`ws://…/docservice`，以及不带协议的 `192.168.x.y:port`。
 */
export function manualBaseOf(address) {
  let text = String(address ?? '').trim();
  if (text === '') throw new TypeError('手填地址是空的');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  const base = wsBaseOf(text);
  const u = new URL(base);
  return u.pathname === '' || u.pathname === '/' ? `${u.protocol}//${u.host}${LAN_DOC_PATH}` : base;
}

/**
 * 候选的 `base`（契约第 11 节裁定）：文档服务的 http(s) 地址，路径保留、以 `/` 结尾。
 * `ws://192.168.1.5:5190/docservice` → `http://192.168.1.5:5190/docservice/`；`http://h:8787` → `http://h:8787/`。
 */
export function candidateBaseOf(url) {
  const u = new URL(wsBaseOf(url));
  const protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}/`;
}

const nameKey = (name) => String(name).normalize('NFC').toLowerCase();

/** 给 `client.mjs` 用的 fetch：每个请求带时限 */
function timedFetch(fetchImpl, ms) {
  const f = fetchImpl ?? globalThis.fetch;
  return (url, init = {}) => f(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** `lookupProject` 的失败 → `{ reason, status? }`；404 回 null（没有这个项目，不算错误） */
function lookupFailure(err) {
  if (err?.status === 404) return null;
  if (Number.isInteger(err?.status)) return { reason: `http-${err.status}`, status: err.status };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.cause?.name === 'TimeoutError') return { reason: 'timeout' };
  return { reason: 'unreachable' };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); }),
  ]);
}
const TIMED_OUT = Symbol('timeout');

/**
 * @param {object} options
 * @param {string} options.name 项目名（不分大小写，与服务端相同按 NFC 小写比）
 * @param {string | null | false} [options.hostedUrl]
 * @param {string | null} [options.uiHostedUrl] 界面上改过的托管地址（`hostedUrl` 不给时参与覆盖顺序）
 * @param {object} [options.lan]
 * @param {(o: { name: string, timeoutMs: number }) => Promise<Array<object> | { hosts: object[], errors?: object[] }>} [options.lan.discover]
 * @param {string[]} [options.lan.manual]
 * @param {number} [options.lan.timeoutMs] 缺省 3000
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {number} [options.lookupTimeoutMs] 缺省 5000
 */
export async function findSharedProject({
  name, hostedUrl, uiHostedUrl, lan = {}, fetch, lookupTimeoutMs = ROUTE_DEFAULTS.LOOKUP_TIMEOUT_MS,
} = {}) {
  if (typeof name !== 'string' || name.trim() === '') throw new TypeError('findSharedProject: name 不能为空');
  const wanted = nameKey(name);
  const lanTimeout = Number.isFinite(lan?.timeoutMs) ? lan.timeoutMs : ROUTE_DEFAULTS.LAN_TIMEOUT_MS;
  const errors = [];
  const f = timedFetch(fetch, lookupTimeoutMs);

  const discovered = (async () => {
    if (typeof lan?.discover !== 'function') return [];
    let r;
    try {
      r = await withTimeout(Promise.resolve(lan.discover({ name, timeoutMs: lanTimeout })), lanTimeout + 1_000);
    } catch (err) {
      errors.push({ where: 'lan', reason: 'discover-failed', message: String(err?.message ?? err) });
      return [];
    }
    if (r === TIMED_OUT) {
      errors.push({ where: 'lan', reason: 'timeout' });
      return [];
    }
    const hosts = Array.isArray(r) ? r : Array.isArray(r?.hosts) ? r.hosts : [];
    let fatal = false;
    for (const e of (Array.isArray(r?.errors) ? r.errors : [])) {
      if (e?.reason === 'no-interface' || e?.reason === 'socket') {
        fatal = true;
        errors.push({ where: 'lan', reason: e.reason, ...(e.message ? { message: e.message } : {}) });
      }
    }
    const matched = hosts.filter((h) => h && typeof h.name === 'string' && nameKey(h.name) === wanted && typeof h.docservice === 'string');
    if (hosts.length === 0 && !fatal) errors.push({ where: 'lan', reason: 'timeout' });
    // 同一项目经几块网卡被发现：只列一次，保留先见到的（发现这一路自己的合并）
    const byProject = new Set();
    const once = [];
    for (const h of matched) {
      let base;
      try { base = candidateBaseOf(h.docservice); } catch { continue; }
      if (byProject.has(h.projectId)) continue;
      byProject.add(h.projectId);
      once.push({ h, base });
    }
    return once.map(({ h, base }) => ({
      where: 'lan', base, projectId: h.projectId, name: h.name, mode: h.mode,
      hostDeviceName: h.hostDeviceName, ...(h.asset ? { asset: h.asset } : {}), via: 'discover',
      ...(Number.isFinite(h.firstSeenMs) ? { firstSeenMs: h.firstSeenMs } : {}),
    }));
  })();

  const manual = Promise.all((Array.isArray(lan?.manual) ? lan.manual : []).map(async (address) => {
    let base;
    try {
      base = manualBaseOf(address);
    } catch {
      errors.push({ where: 'lan', reason: 'bad-address', address: String(address) });
      return null;
    }
    try {
      const p = await lookupProject({ base, name, fetch: f });
      return { where: 'lan', base: candidateBaseOf(base), projectId: p.projectId, name: p.name, mode: p.mode, via: 'manual' };
    } catch (err) {
      const fail = lookupFailure(err);
      if (fail) errors.push({ where: 'lan', address: base, ...fail });
      return null;
    }
  }));

  const hosted = (async () => {
    if (hostedUrl === null || hostedUrl === false) return null;
    let url;
    try {
      url = typeof hostedUrl === 'string' && hostedUrl.trim() !== '' ? hostedUrl.trim() : resolveHostedUrl({ ui: uiHostedUrl });
      if (!url) return null; // 这一版没有托管端，也没人填过地址：不找
      url = wsBaseOf(url);
    } catch (err) {
      errors.push({ where: 'hosted', reason: 'bad-address', message: String(err?.message ?? err) });
      return null;
    }
    try {
      const p = await lookupProject({ base: url, name, fetch: f });
      return { where: 'hosted', base: candidateBaseOf(url), projectId: p.projectId, name: p.name, mode: p.mode };
    } catch (err) {
      const fail = lookupFailure(err);
      if (fail) errors.push({ where: 'hosted', ...fail });
      return null;
    }
  })();

  const [lanFound, manualFound, hostedFound] = await Promise.all([discovered, manual, hosted]);
  const candidates = [];
  const seen = new Set();
  // 手填与发现按 base 去重（契约第 11 节裁定），发现的在前
  for (const c of [...lanFound, ...manualFound.filter(Boolean)]) {
    if (seen.has(c.base)) continue;
    seen.add(c.base);
    candidates.push(c);
  }
  if (hostedFound) candidates.push(hostedFound);
  // 手填地址查到了，局域网发现的「超时」就不算数了（发现被防火墙或 AP 隔离挡住是手填存在的理由）
  const lanOk = candidates.some((c) => c.where === 'lan');
  return { candidates, errors: lanOk ? errors.filter((e) => !(e.where === 'lan' && e.reason === 'timeout')) : errors };
}

/**
 * 打开时怎么走（SP5）：只有局域网有、只有托管有 → 直接进；两边都有（或局域网里同名多个）→ 并列供挑；都没有 → 找不到。
 * @param {{ candidates: object[], errors?: object[] }} result
 */
export function pickRoute(result) {
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  if (candidates.length === 0) return { action: 'not-found', errors: Array.isArray(result?.errors) ? result.errors : [] };
  if (candidates.length === 1) return { action: 'enter', candidate: candidates[0] };
  return { action: 'choose', candidates };
}

/** 浏览器里本机编辑器的文档服务地址；Node 里没有 `location`，回 null */
function localEditorBase() {
  const loc = globalThis.location;
  if (!loc || typeof loc.origin !== 'string' || !/^https?:/.test(loc.origin)) return null;
  return `${loc.origin}${LAN_DOC_PATH}`;
}

/**
 * 新建共享项目。
 * @param {object} options
 * @param {'hosted' | 'lan'} options.where
 * @param {string} options.name
 * @param {'free' | 'restricted'} options.mode
 * @param {{ username: string, password: string }} options.creator
 * @param {string} [options.password] 自由进入的项目口令
 * @param {Array<{ username: string, password: string }>} [options.list] 限定进入的名单
 * @param {object} [options.kdf]
 * @param {string} [options.hostedUrl] 托管端地址；不给按覆盖顺序取
 * @param {string | null} [options.uiHostedUrl]
 * @param {string} [options.lanBase] 本机编辑器的文档服务地址（Node 里必给，如 `ws://127.0.0.1:5190/docservice`；浏览器缺省当前页面的源）
 * @param {typeof globalThis.fetch} [options.fetch]
 * @returns {Promise<{ where, base, projectId, name, mode }>} 失败抛出 `client.mjs` 的错误（带 `status`、`reason`，如 409 `name-taken`）
 */
export async function createSharedProject({ where, hostedUrl, uiHostedUrl, lanBase, ...rest } = {}) {
  let base;
  if (where === 'hosted') {
    base = typeof hostedUrl === 'string' && hostedUrl.trim() !== '' ? hostedUrl.trim() : resolveHostedUrl({ ui: uiHostedUrl });
    if (!base) throw new TypeError('createSharedProject: 这一版没有托管端，要给 hostedUrl');
  } else if (where === 'lan') {
    base = lanBase ?? localEditorBase();
    if (!base) throw new TypeError('createSharedProject: 局域网模式要给 lanBase（本机编辑器的文档服务地址）');
  } else {
    throw new TypeError("createSharedProject: where 只能是 'hosted' 或 'lan'");
  }
  const ws = wsBaseOf(base);
  const r = await createOn({ ...rest, base: ws });
  return { where, base: candidateBaseOf(ws), projectId: r.projectId, name: r.name, mode: r.mode };
}

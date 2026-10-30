/**
 * 文档服务端点解析与服务地址订阅（分布式预渲染 M5a，契约 `docs/plan/render-queue-contract.md` G.7；
 * M5b 按 J.3 加了编辑器里挂的文档服务）。
 *
 * resolveDocservice      按顺序探活（远端 → 编辑器 → 本机回环），定下节点接哪个文档服务，或者回落本机（offline）
 * watchServiceEndpoints  经一条 `createWsEndpoint` 端点订阅服务地址登记（G.6 的 `service.watch`）
 *
 * 不读文件系统、不引任何模块；环境变量和 `fetch` 都由调用方注入（缺省取 `process.env`、全局 `fetch`）。
 */
import { PROTOCOL } from './ws-transport.mjs';

const DEFAULT_PORT = 8787;

/** 编辑器里挂的文档服务的路径与健康检查路由（`docservice-contract.md` 第 5 节） */
const EDITOR_WS_PATH = '/docservice';
const EDITOR_HEALTH_PATH = '/api/docservice/healthz';

/** 独立文档服务的候选：协议换成 http: / https:，`/healthz` 取在源站根上（G.11）；不是 ws: / wss: 回 null */
function healthUrlOfWs(wsUrl) {
  try {
    const parsed = new URL(wsUrl);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    const http = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    return `${http}//${parsed.host}/healthz`;
  } catch {
    return null;
  }
}

/**
 * 编辑器里挂的文档服务（J.3、C6.4 第 9 节第 10 条）：从编辑器地址（`http:` / `https:`）推出
 * `ws(s)://<编辑器源>/docservice`，探活用 `GET <编辑器源>/api/docservice/healthz`。
 * 编辑器地址只取源站，带的路径忽略。不是 http: / https: 回 null。
 */
function editorCandidateOf(editorUrl) {
  try {
    const parsed = new URL(editorUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const ws = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return { url: `${ws}//${parsed.host}${EDITOR_WS_PATH}`, healthUrl: `${parsed.protocol}//${parsed.host}${EDITOR_HEALTH_PATH}` };
  } catch {
    return null;
  }
}

/**
 * 单个候选的探活：GET 健康检查地址，超时 `timeoutMs`；`ok === true` 且 `protocol === 'promptcut.v1'` 才算可用。
 * @returns {Promise<{ ok: true, health: object } | { ok: false, reason: string }>}
 */
async function probe(target, fetchImpl, timeoutMs) {
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no-fetch' };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(target, { method: 'GET', signal: controller.signal, headers: { accept: 'application/json' }, cache: 'no-store' });
    } catch {
      return { ok: false, reason: timedOut ? 'timeout' : 'unreachable' };
    }
    if (!res || !res.ok) return { ok: false, reason: `http-${res?.status ?? 0}` };
    let health;
    try {
      health = await res.json();
    } catch {
      return { ok: false, reason: timedOut ? 'timeout' : 'bad-json' };
    }
    if (health === null || typeof health !== 'object' || health.ok !== true) return { ok: false, reason: 'not-ok' };
    if (health.protocol !== PROTOCOL) return { ok: false, reason: 'protocol-mismatch' };
    return { ok: true, health };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 定下节点接哪个文档服务。顺序（G.7，M5b 按 J.3 加了第 2 项）：
 *   1. `PROMPTCUT_DOCSERVICE_URL`（`ws://` 或 `wss://`），可用 → `remote`；
 *   2. 编辑器里挂的文档服务：由 `PROMPTCUT_EDITOR_URL`（`http://` 或 `https://`）推出
 *      `ws(s)://<编辑器源>/docservice`，探活 `GET <编辑器源>/api/docservice/healthz`，可用 → `editor`；
 *   3. `ws://127.0.0.1:${PROMPTCUT_DOCSERVICE_PORT ?? 8787}`，可用 → `local`；
 *   4. 都不行 → `offline`，调用方回落本机 preload 路径。
 * 第 1、2 项没设（或是空串）就不试，`tried` 里也没有它；设了但地址不合法的记 `bad-url`，继续试下一项。
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]  缺省 `process.env`
 * @param {typeof fetch} [options.fetch]  缺省全局 `fetch`
 * @param {number} [options.timeoutMs]  每个候选的探活超时，缺省 3000
 * @returns {Promise<{ mode: 'remote' | 'editor' | 'local' | 'offline', url?: string, health?: object, tried: { url: string, ok: boolean, reason?: string }[] }>}
 */
export async function resolveDocservice({
  env = globalThis.process?.env ?? {},
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 3000,
} = {}) {
  /** @type {{ url: string, healthUrl: string | null, mode: 'remote' | 'editor' | 'local' }[]} */
  const candidates = [];
  const configured = env.PROMPTCUT_DOCSERVICE_URL;
  if (typeof configured === 'string' && configured !== '') {
    candidates.push({ url: configured, healthUrl: healthUrlOfWs(configured), mode: 'remote' });
  }
  const editor = env.PROMPTCUT_EDITOR_URL;
  if (typeof editor === 'string' && editor !== '') {
    const c = editorCandidateOf(editor);
    candidates.push(c ? { ...c, mode: 'editor' } : { url: editor, healthUrl: null, mode: 'editor' });
  }
  const loopback = `ws://127.0.0.1:${env.PROMPTCUT_DOCSERVICE_PORT ?? DEFAULT_PORT}`;
  candidates.push({ url: loopback, healthUrl: healthUrlOfWs(loopback), mode: 'local' });

  const tried = [];
  for (const { url, healthUrl, mode } of candidates) {
    const result = healthUrl === null ? { ok: false, reason: 'bad-url' } : await probe(healthUrl, fetchImpl, timeoutMs);
    if (result.ok) {
      tried.push({ url, ok: true });
      return { mode, url, health: result.health, tried };
    }
    tried.push({ url, ok: false, reason: result.reason });
  }
  return { mode: 'offline', tried };
}

/**
 * 订阅服务地址登记：每次 `onOpen` 发一次 `service.watch { kinds }`；收到 `service.endpoints` 就调
 * `onChange(endpoints)`（G.6：推送一律是全量）。
 * 调用时端点已经连上的，立刻补发一次 `service.watch`（否则要等到下次重连才订阅上）。
 *
 * @param {{ send: (message: object) => boolean, onMessage: (h: (m: object) => void) => void, onOpen: (h: () => void) => void, connected?: boolean }} wsEndpoint
 * @param {string[] | 'all'} kinds
 * @param {(endpoints: { announcerId: string, kind: string, urls: string[], meta: any, since: number }[]) => void} onChange
 * @returns {() => void} stop：之后不再发订阅、不再调 `onChange`（端点没有撤销处理器的接口，这里靠标志位）
 */
export function watchServiceEndpoints(wsEndpoint, kinds, onChange) {
  if (kinds !== 'all' && !(Array.isArray(kinds) && kinds.every((k) => typeof k === 'string'))) {
    throw new TypeError("watchServiceEndpoints：kinds 必须是字符串数组或 'all'");
  }
  if (typeof onChange !== 'function') throw new TypeError('watchServiceEndpoints：onChange 必须是函数');
  const watchKinds = kinds === 'all' ? 'all' : [...kinds];
  let stopped = false;

  const subscribe = () => {
    if (!stopped) wsEndpoint.send({ type: 'service.watch', kinds: watchKinds });
  };
  wsEndpoint.onOpen(subscribe);
  wsEndpoint.onMessage((message) => {
    if (stopped || message?.type !== 'service.endpoints' || !Array.isArray(message.endpoints)) return;
    onChange(message.endpoints);
  });
  if (wsEndpoint.connected === true) subscribe();

  return () => { stopped = true; };
}

/**
 * Document service endpoint resolution and service address subscription (distributed prerender M5a,
 * contract `docs/plan/render-queue-contract.md` G.7; M5b added the document service mounted in the
 * editor per J.3).
 *
 * resolveDocservice      Probes in order (remote → editor → local loopback) to determine which
 *                        document service the node connects to, or falls back to local (offline)
 * watchServiceEndpoints  Subscribes to service address registrations via a `createWsEndpoint`
 *                        endpoint (`service.watch` in G.6)
 *
 * Does not read the file system or import any modules; environment variables and `fetch` are
 * injected by the caller (defaults to `process.env` and global `fetch`).
 */
import { PROTOCOL } from './ws-transport.mjs';

const DEFAULT_PORT = 8787;

/** Path and health-check route for document service mounted in the editor (`docservice-contract.md` Section 5) */
const EDITOR_WS_PATH = '/docservice';
const EDITOR_HEALTH_PATH = '/api/docservice/healthz';

/** Candidate for standalone doc service: protocol changed to http: / https:, `/healthz` at origin root (G.11); null if not ws: / wss: */
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
 * Document service mounted in the editor (J.3, C6.4 Section 9, item 10): derives
 * `ws(s)://<editor-origin>/docservice` from editor address (`http:` / `https:`), and probes with
 * `GET <editor-origin>/api/docservice/healthz`.
 * Only the origin is taken from the editor address; any included path is ignored. Returns null if
 * not http: / https:.
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
 * Liveness probe for a single candidate: GET health-check URL with timeout `timeoutMs`; considered
 * available only when `ok === true` and `protocol === 'promptcut.v1'`.
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
 * Determines which document service the node connects to. Order (G.7; M5b added item 2 per J.3):
 *   1. `PROMPTCUT_DOCSERVICE_URL` (`ws://` or `wss://`), available → `remote`;
 *   2. Document service mounted in the editor: derives `ws(s)://<editor-origin>/docservice` from
 *      `PROMPTCUT_EDITOR_URL` (`http://` or `https://`), probes
 *      `GET <editor-origin>/api/docservice/healthz`, available → `editor`;
 *   3. `ws://127.0.0.1:${PROMPTCUT_DOCSERVICE_PORT ?? 8787}`, available → `local`;
 *   4. None work → `offline`; caller falls back to local preload path.
 * If items 1 or 2 are unset (or empty strings), they are not tried and not included in `tried`; if
 * set but invalid, recorded as `bad-url`, and continues to the next item.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]  Defaults to `process.env`
 * @param {typeof fetch} [options.fetch]  Defaults to global `fetch`
 * @param {number} [options.timeoutMs]  Liveness probe timeout for each candidate, defaults to 3000
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
 * Subscribes to service address registrations: sends `service.watch { kinds }` on each `onOpen`;
 * calls `onChange(endpoints)` upon receiving `service.endpoints` (G.6: pushes are always full).
 * If the endpoint is already connected when called, immediately re-sends `service.watch` (otherwise
 * subscription waits until next reconnect).
 *
 * @param {{ send: (message: object) => boolean, onMessage: (h: (m: object) => void) => void, onOpen: (h: () => void) => void, connected?: boolean }} wsEndpoint
 * @param {string[] | 'all'} kinds
 * @param {(endpoints: { announcerId: string, kind: string, urls: string[], meta: any, since: number }[]) => void} onChange
 * @returns {() => void} stop: no further subscriptions sent and `onChange` no longer called
 *   (endpoints lack an API to remove handlers; uses a flag here)
 */
export function watchServiceEndpoints(wsEndpoint, kinds, onChange) {
  if (kinds !== 'all' && !(Array.isArray(kinds) && kinds.every((k) => typeof k === 'string'))) {
    throw new TypeError("watchServiceEndpoints: kinds must be a string array or 'all'");
  }
  if (typeof onChange !== 'function') throw new TypeError('watchServiceEndpoints: onChange must be a function');
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

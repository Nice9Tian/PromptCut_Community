/**
 * WebSocket endpoint from node to document service (distributed prerender M5a, contract
 * `docs/plan/render-queue-contract.md` G.7).
 *
 * Starting from HT-a (`docs/plan/http-transport-contract.md` section 9), business callers switch to
 * `createDocEndpoint` in `session-link.mjs` (session: sequence numbers and acknowledgements,
 * resume on broken transport, no message loss); this module is kept as the foundation where
 * "one transport is one connection": token connection for management interface
 * (`asset-announce`), and developer enforcement and testing using only one transport.
 *
 * Satisfies the D.2 `endpoint` shape (`send`, `onMessage`) and can be passed directly to
 * `createLocalNode`.
 * Additionally responsible for:
 *   - Subprotocols (M6a, `docs/plan/auth-contract.md` sections 5 and 11):
 *     - `protocols`: A function (can be async), **called once before each (re)connection**,
 *       returning the array of subprotocols to send in this handshake. The nonce in proof of
 *       shared project can only be used once, so it cannot be cached; if unavailable (throws,
 *       rejects), treat as connection failure and back off to reconnect as usual;
 *     - `token`: Cluster token, used only by management interface (`asset-announce` registered
 *       address): `['promptcut.v1', 'promptcut.token.<token>']`. Cluster token grants no
 *       permissions to the data plane; connections for the data plane must not include it;
 *     - Neither provided: `['promptcut.v1']` (local identity when connecting to local loopback).
 *       `protocols` and `token` cannot both be provided;
 *   - Automatic exponential backoff reconnect after disconnection or connection failure; for the
 *     n-th attempt (from 0), wait
 *     `min(maxMs, baseMs × factor^n) × (1 + jitter × (2·random() − 1))`; n resets to 0 after
 *     connecting, and reconnect stops after `close()`;
 *   - Messages `send` during disconnection are always dropped (no buffering or replay) and counted
 *     in `stats().dropped`. Correctness relies on `hello.resume` / `queue.snapshot` after
 *     reconnecting and `sink.has` before starting D.2 fine-grained tasks (G.7).
 *
 * This module has no knowledge of `local-node`; wiring is caller's responsibility (G.7 convention):
 *   ep.onOpen(() => node.start(node.session.held().map(({ id, token }) => ({ id, token }))));
 *
 * Imports no modules: uses only global `WebSocket` (built-in since Node 22, same name in browser);
 * M7 pure browser nodes can reuse it as is. `WebSocket`, `setTimeout`, `clearTimeout`, and `random`
 * can all be injected, so tests do not need to start real services or wait in real time.
 * Tokens go only into subprotocols, never into URLs, logs, or any error messages.
 */

export const PROTOCOL = 'promptcut.v1';
const TOKEN_PREFIX = 'promptcut.token.';

export const BACKOFF_DEFAULTS = Object.freeze({ baseMs: 500, factor: 2, maxMs: 15_000, jitter: 0.2 });

/** WebSocket.readyState OPEN (same in browser and Node) */
const OPEN = 1;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Wait time (in milliseconds) before the n-th reconnect (from 0), G.7 formula.
 * @param {number} n
 * @param {{ baseMs: number, factor: number, maxMs: number, jitter: number }} backoff
 * @param {() => number} random
 */
export function backoffDelay(n, backoff, random) {
  const { baseMs, factor, maxMs, jitter } = backoff;
  return Math.min(maxMs, baseMs * factor ** n) * (1 + jitter * (2 * random() - 1));
}

/**
 * @typedef {object} WsEndpoint
 * @property {(message: object) => boolean} send  Dropped when disconnected, returns false, counted in `stats().dropped`
 * @property {(handler: (message: object) => void) => void} onMessage  All handlers invoked in registration order
 * @property {(handler: () => void) => void} onOpen  Called on every (re)connection
 * @property {(handler: (info: { code: number, reason: string }) => void) => void} onClose  Called on every disconnect
 * @property {() => void} close  Close connection and stop reconnecting; `closed` becomes true
 * @property {boolean} connected
 * @property {boolean} closed
 * @property {() => { opens: number, closes: number, sent: number, received: number, dropped: number, badFrames: number }} stats
 */

/**
 * @param {object} options
 * @param {string} options.url  `ws://` or `wss://`
 * @param {() => (string[] | Promise<string[]>)} [options.protocols]  Fetches subprotocols before each connection (shared project proof, connection ticket)
 * @param {string} [options.token]  Cluster token, used only for management interface; if omitted, includes only `promptcut.v1`
 * @param {any} [options.WebSocket]  Defaults to global `WebSocket`
 * @param {(fn: () => void, ms: number) => any} [options.setTimeout]
 * @param {(handle: any) => void} [options.clearTimeout]
 * @param {() => number} [options.random]  [0, 1), used for jitter
 * @param {Partial<typeof BACKOFF_DEFAULTS>} [options.backoff]  Merged with `BACKOFF_DEFAULTS`
 * @param {(event: string, fields: object) => void} [options.log]
 * @returns {WsEndpoint}
 */
export function createWsEndpoint({
  url,
  token,
  protocols: protocolsOf,
  WebSocket: WebSocketImpl = globalThis.WebSocket,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  random = Math.random,
  backoff,
  log = () => {},
} = /** @type {any} */ ({})) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('createWsEndpoint: url is not a valid address');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new TypeError('createWsEndpoint: url must be ws:// or wss://');
  }
  if (typeof WebSocketImpl !== 'function') throw new TypeError('createWsEndpoint: no WebSocket available');
  if (token !== undefined && token !== null && (typeof token !== 'string' || token === '')) {
    throw new TypeError('createWsEndpoint: token must be a non-empty string');
  }
  if (protocolsOf !== undefined && protocolsOf !== null) {
    if (typeof protocolsOf !== 'function') throw new TypeError('createWsEndpoint: protocols must be a function');
    if (token) throw new TypeError('createWsEndpoint: protocols and token cannot both be given');
  }

  const policy = { ...BACKOFF_DEFAULTS, ...(backoff ?? {}) };
  const fixedProtocols = token ? [PROTOCOL, TOKEN_PREFIX + token] : [PROTOCOL];
  /** Log only token-free URLs (tokens are not in URL anyway; here only strip potential username/password and query strings) */
  const safeUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;

  const messageHandlers = [];
  const openHandlers = [];
  const closeHandlers = [];
  const counters = { opens: 0, closes: 0, sent: 0, received: 0, dropped: 0, badFrames: 0 };

  /** Current socket (connecting or connected); late events from old sockets are always ignored */
  let ws = null;
  let connected = false;
  let closed = false;
  /** n used for next reconnect (from 0), reset to 0 once connected */
  let attempt = 0;
  let retryTimer = null;
  /** Fetching subprotocols (`protocols()` has not returned yet) */
  let pending = false;

  function emit(handlers, arg, what) {
    for (const handler of [...handlers]) {
      try {
        handler(arg);
      } catch (error) {
        log('ws.handler-error', { url: safeUrl, handler: what, message: String(error?.message ?? error) });
      }
    }
  }

  function listen(socket, type, fn) {
    if (typeof socket.addEventListener === 'function') socket.addEventListener(type, fn);
    else socket[`on${type}`] = fn;
  }

  /** Subprotocols for this handshake: fetch on the fly if `protocols` is given, otherwise use a fixed set */
  function connect() {
    retryTimer = null;
    if (closed) return;
    if (typeof protocolsOf !== 'function') return open(fixedProtocols);
    let got;
    try {
      got = protocolsOf();
    } catch (error) {
      log('ws.error', { url: safeUrl, stage: 'protocols', message: String(error?.message ?? error) });
      scheduleRetry();
      return;
    }
    pending = true;
    Promise.resolve(got).then((list) => {
      pending = false;
      if (closed) return;
      if (!Array.isArray(list) || list.some((p) => typeof p !== 'string')) throw new TypeError('protocols() must return an array of strings');
      open(list);
    }).catch((error) => {
      pending = false;
      // Logs only record reasons, not subprotocols (which contain proofs or tickets)
      log('ws.error', { url: safeUrl, stage: 'protocols', message: String(error?.message ?? error) });
      scheduleRetry();
    });
  }

  function open(protocols) {
    if (closed) return;
    let socket;
    try {
      socket = new WebSocketImpl(url, protocols);
    } catch (error) {
      log('ws.error', { url: safeUrl, stage: 'construct', message: String(error?.message ?? error) });
      scheduleRetry();
      return;
    }
    ws = socket;
    let opened = false;
    let ended = false;

    listen(socket, 'open', () => {
      if (ws !== socket || ended) return;
      if (closed) {
        // open arriving late after close(): close immediately, not counted as connected
        try { socket.close(1000, 'closed'); } catch { /* Already closing */ }
        return;
      }
      opened = true;
      connected = true;
      attempt = 0;
      counters.opens++;
      log('ws.open', { url: safeUrl, protocol: typeof socket.protocol === 'string' ? socket.protocol : null });
      emit(openHandlers, undefined, 'open');
    });

    listen(socket, 'message', (event) => {
      if (ws !== socket || !opened) return;
      const data = event?.data;
      let message;
      if (typeof data === 'string') {
        try {
          message = JSON.parse(data);
        } catch {
          message = undefined;
        }
      }
      if (!isObj(message)) {
        counters.badFrames++;
        return;
      }
      counters.received++;
      emit(messageHandlers, message, 'message');
    });

    listen(socket, 'error', (event) => {
      if (ws !== socket || ended) return;
      log('ws.error', { url: safeUrl, stage: opened ? 'open' : 'connect', message: String(event?.message ?? event?.error?.message ?? 'error') });
    });

    listen(socket, 'close', (event) => {
      if (ended) return;
      ended = true;
      if (ws === socket) ws = null;
      // Closures initiated by local close() always report { code: 1000, reason: 'closed' } (contract G.11):
      // reason in remote close frame may be an empty string and is not passed through; other
      // disconnections pass through underlying code and reason as usual
      const code = closed ? 1000 : typeof event?.code === 'number' ? event.code : 1006;
      const reason = closed ? 'closed' : typeof event?.reason === 'string' ? event.reason : '';
      if (opened) {
        connected = false;
        counters.closes++;
        log('ws.close', { url: safeUrl, code, reason });
        emit(closeHandlers, { code, reason }, 'close');
      } else {
        log('ws.connect-failed', { url: safeUrl, code });
      }
      scheduleRetry();
    });
  }

  function scheduleRetry() {
    if (closed || retryTimer !== null || pending) return;
    const n = attempt++;
    const delayMs = backoffDelay(n, policy, random);
    log('ws.retry', { url: safeUrl, attempt: n, delayMs });
    retryTimer = setTimer(connect, delayMs);
  }

  function send(message) {
    if (!connected || !ws || (typeof ws.readyState === 'number' && ws.readyState !== OPEN)) {
      counters.dropped++;
      return false;
    }
    let text;
    try {
      text = JSON.stringify(message);
    } catch {
      counters.dropped++;
      return false;
    }
    try {
      ws.send(text);
    } catch {
      counters.dropped++;
      return false;
    }
    counters.sent++;
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
    const socket = ws;
    // connected becomes false immediately: send after close() is dropped; onClose is called
    // when socket actually closes
    connected = false;
    if (socket) {
      try { socket.close(1000, 'closed'); } catch { /* Already closing */ }
    }
    log('ws.closed', { url: safeUrl });
  }

  connect();

  return {
    send,
    onMessage(handler) { messageHandlers.push(handler); },
    onOpen(handler) { openHandlers.push(handler); },
    onClose(handler) { closeHandlers.push(handler); },
    close,
    get connected() { return connected; },
    get closed() { return closed; },
    stats() { return { ...counters }; },
  };
}

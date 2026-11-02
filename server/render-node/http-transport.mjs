/**
 * Node-to-document-service HTTP long polling endpoint (section 8 of contract
 * `docs/plan/http-transport-contract.md`).
 *
 * Used for nodes whose egress permits only 443 HTTPS and does not support WebSocket upgrades
 * (cloud dev containers via outbound proxy). Two components:
 *
 * - `HttpWebSocket` / `httpWebSocketClass(deps)`: WebSocket-like class
 *   (`new HttpWebSocket(url, protocols)`, `readyState`, `protocol`, `bufferedAmount`, `send`,
 *   `close`, `addEventListener`, and `on*`), speaking the protocol of the four endpoints in server
 *   `server/docservice/http-transport.mjs`. Injected into callers that directly do `new WebSocket`
 *   such as `doc-link`.
 *   - Connection: `POST /lp/open`, with the subprotocol list in `X-Promptcut-Protocols` (same list
 *     as WebSocket, containing credentials and tickets);
 *   - Sending: `send` enqueues, only one `POST /lp/send` in flight at a time, batching small frames
 *     (request body does not exceed single-frame limit + 64 KiB), batch numbers starting at 1;
 *     retries the same batch if no response is received (server deduplicates by batch number);
 *   - Receiving: keeps a pending `GET /lp/recv?ack=&wait=`, advances `ack` only after actually
 *     receiving a response, deduplicating by frame sequence number;
 *   - Transient errors (network error, timeout, 5xx, 429) are not immediately treated as disconnect:
 *     retries the same request with short backoff (starts at 250 ms, doubles, caps at 5 s) within
 *     `idleMs / 2`; only closes with 1006 once exceeded. 404 (session not found) and 410 (session
 *     ended) are treated as disconnect immediately (410 carries server close code);
 *   - `sid` is a bearer token: placed only in `Authorization` header, never in URLs, logs, or
 *     error messages.
 * - `createHttpEndpoint(options)`: Same shape and options with identical names and semantics as
 *   `createWsEndpoint` (backoff reconnect, `protocols()` fetched fresh each time, `send` drops during
 *   disconnect counted in `stats().dropped`), simply wrapping `createWsEndpoint` over `HttpWebSocket`;
 *   also accepts `fetch`, `waitMs`. `url` accepts `http(s)://` or `ws(s)://`, pointing to
 *   document service base URL.
 *
 * Uses only global `fetch`, `AbortController`, `TextEncoder`, and timers (all injectable), imports
 * no packages, and can be used as-is in browsers.
 * Proxies: not handled by this module directly. Running on Node 24.5+ with `NODE_USE_ENV_PROXY=1`
 * (or `--use-env-proxy`) plus `HTTPS_PROXY` routes global `fetch` through proxies via CONNECT tunnels;
 * inject `fetch` with `dispatcher` when explicit control is needed.
 */
import { createWsEndpoint } from './ws-transport.mjs';

export const HTTP_CLIENT_DEFAULTS = Object.freeze({
  /** How long to ask the server to hold (min of server value and its `waitMs`) */
  waitMs: 25_000,
  /**
   * Max wait time for a single request (including pending GET); 15 s longer than hold duration
   * (contract section 11: client timeout 35-40 s)
   */
  requestSlackMs: 15_000,
  /**
   * Session idle duration used when omitted by server (determines max retry time for transient
   * errors: half of it)
   */
  idleMs: 60_000,
  retryBaseMs: 250,
  retryMaxMs: 5_000,
  /**
   * Max wait time for `close()` (sending remaining frames, `POST /lp/close`); reports closed
   * directly if exceeded
   */
  closeTimeoutMs: 5_000,
  /** Single-frame limit used when omitted by server */
  maxFrameBytes: 1024 * 1024,
  /** Margin by which a batch request body can exceed the single-frame limit (matches server) */
  bodySlackBytes: 64 * 1024,
});

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const encoder = new TextEncoder();
const byteLen = (text) => encoder.encode(text).byteLength;

/**
 * Document service address → http(s) base URL (`ws:` → `http:`, `wss:` → `https:`, path
 * preserved, trailing slashes and query strings stripped)
 */
export function httpBaseOf(url) {
  const u = new URL(url);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  else if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError('The document service address must be http(s):// or ws(s)://');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * In reverse: http(s) → ws(s) (`createWsEndpoint` only accepts ws(s); used to pass address when
 * wrapping `HttpWebSocket`)
 */
function wsUrlOf(url) {
  const u = new URL(url);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new TypeError('The document service address must be http(s):// or ws(s)://');
  return u.toString();
}

/** Transient errors: network errors (status 0), timeouts, gateway and server errors, rate limiting */
const transient = (status) => status === 0 || status === 408 || status === 429 || status >= 500;

/**
 * Returns the `HttpWebSocket` class bound with dependencies.
 * @param {object} [deps]
 * @param {typeof globalThis.fetch} [deps.fetch]  Global `fetch` used by default
 * @param {number} [deps.waitMs]  How long to ask the server to hold, default 25 000
 * @param {number} [deps.requestTimeoutMs]  Single-request limit, default `waitMs + 15 000`
 * @param {(fn: () => void, ms: number) => any} [deps.setTimeout]
 * @param {(handle: any) => void} [deps.clearTimeout]
 * @param {() => number} [deps.now]  Used to calculate retry deadline
 * @param {(event: string, fields: object) => void} [deps.log]
 */
export function httpWebSocketClass(deps = {}) {
  const {
    fetch: fetchImpl,
    waitMs = HTTP_CLIENT_DEFAULTS.waitMs,
    requestTimeoutMs,
    setTimeout: setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: clearTimer = (h) => globalThis.clearTimeout(h),
    now = () => Date.now(),
    log = () => {},
  } = deps;
  const say = (event, fields) => { try { log(event, fields); } catch { /* Logging errors do not affect the connection */ } };
  const doFetch = (url, init) => {
    const f = fetchImpl ?? globalThis.fetch;
    if (typeof f !== 'function') throw new TypeError('HttpWebSocket: no fetch available');
    return f(url, init);
  };

  class HttpWebSocket {
    static CONNECTING = CONNECTING;
    static OPEN = OPEN;
    static CLOSING = CLOSING;
    static CLOSED = CLOSED;
    CONNECTING = CONNECTING;
    OPEN = OPEN;
    CLOSING = CLOSING;
    CLOSED = CLOSED;

    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    protocol = '';
    extensions = '';
    binaryType = 'blob';

    #url;
    #base;
    #safe;
    #protocols;
    #state = CONNECTING;
    #listeners = new Map();
    #sid = null;
    #waitMs = waitMs;
    #idleMs = HTTP_CLIENT_DEFAULTS.idleMs;
    #maxFrame = HTTP_CLIENT_DEFAULTS.maxFrameBytes;
    /** Pending frames to send and their byte counts; in-flight batch byte count is tracked separately */
    #queue = [];
    #queuedBytes = 0;
    #inflightBytes = 0;
    #sendSeq = 0;
    #sending = null;
    #lastSeq = 0;
    /** Abort controllers for in-flight requests, retry timers: cleared together upon close */
    #aborters = new Set();
    #timers = new Set();
    #closeWanted = null;

    /**
     * @param {string} url  Document service base URL: `http(s)://` or `ws(s)://`
     * @param {string | string[]} [protocols]  Same subprotocol list as WebSocket
     */
    constructor(url, protocols = []) {
      this.#url = String(url);
      this.#base = httpBaseOf(this.#url);
      const u = new URL(this.#base);
      this.#safe = `${u.protocol}//${u.host}${u.pathname}`;
      this.#protocols = (Array.isArray(protocols) ? protocols : [protocols]).map(String).filter((p) => p !== '');
      queueMicrotask(() => { void this.#open(); });
    }

    get url() { return this.#url; }
    get readyState() { return this.#state; }
    get bufferedAmount() { return this.#queuedBytes + this.#inflightBytes; }

    addEventListener(type, fn, options) {
      if (typeof fn !== 'function' && !(fn && typeof fn.handleEvent === 'function')) return;
      let list = this.#listeners.get(type);
      if (!list) this.#listeners.set(type, (list = []));
      if (list.some((l) => l.fn === fn)) return;
      list.push({ fn, once: !!(isObj(options) && options.once) });
    }

    removeEventListener(type, fn) {
      const list = this.#listeners.get(type);
      if (!list) return;
      const i = list.findIndex((l) => l.fn === fn);
      if (i >= 0) list.splice(i, 1);
    }

    /**
     * Sends a text message. Throws if called while connecting (matches WebSocket); drops if closing
     * or closed
     */
    send(data) {
      if (this.#state === CONNECTING) throw new Error('InvalidStateError: HttpWebSocket is not connected yet');
      if (this.#state !== OPEN) return;
      const text = typeof data === 'string' ? data : String(data);
      const bytes = byteLen(text);
      this.#queue.push({ text, bytes });
      this.#queuedBytes += bytes;
      this.#kickSend();
    }

    /**
     * Close: finishes sending enqueued frames first, then `POST /lp/close`, and reports `close`.
     * Waits up to `closeTimeoutMs`
     */
    close(code = 1000, reason = '') {
      if (this.#state === CLOSING || this.#state === CLOSED) return;
      if (this.#state === CONNECTING) {
        // Matches WebSocket: if closed before connected, reports 1006; once connection response returns,
        // immediately closes server side too
        this.#closeWanted = { code, reason };
        this.#state = CLOSING;
        return;
      }
      this.#state = CLOSING;
      void this.#closeOpen(code, typeof reason === 'string' ? reason : '');
    }

    // ---------- Internal ----------

    #emit(type, event) {
      const handler = this[`on${type}`];
      const list = [...(this.#listeners.get(type) ?? [])];
      const ev = { type, target: this, currentTarget: this, ...event };
      if (typeof handler === 'function') {
        try { handler.call(this, ev); } catch (err) { say('http.handler-error', { url: this.#safe, handler: type, message: String(err?.message ?? err) }); }
      }
      for (const l of list) {
        if (l.once) this.removeEventListener(type, l.fn);
        try {
          if (typeof l.fn === 'function') l.fn.call(this, ev);
          else l.fn.handleEvent(ev);
        } catch (err) {
          say('http.handler-error', { url: this.#safe, handler: type, message: String(err?.message ?? err) });
        }
      }
    }

    #sleep(ms) {
      return new Promise((resolve) => {
        const h = setTimer(() => { this.#timers.delete(h); resolve(); }, ms);
        this.#timers.add(h);
      });
    }

    /**
     * Sends a single request; returns `{ status, body }`, or `{ status: 0, error }` on network error
     * or timeout (does not throw)
     */
    async #request(method, route, { headers = {}, body, timeoutMs, query = '' } = {}) {
      const ac = new AbortController();
      this.#aborters.add(ac);
      const limit = timeoutMs ?? requestTimeoutMs ?? this.#waitMs + HTTP_CLIENT_DEFAULTS.requestSlackMs;
      const timer = setTimer(() => ac.abort(), limit);
      try {
        const init = { method, headers: { ...headers }, signal: ac.signal };
        if (this.#sid) init.headers.authorization = `Bearer ${this.#sid}`;
        if (body !== undefined) {
          init.headers['content-type'] = 'application/json';
          init.body = body;
        }
        const res = await doFetch(`${this.#base}/lp/${route}${query}`, init);
        let parsed = null;
        try { parsed = await res.json(); } catch { parsed = null; }
        return { status: res.status, body: parsed };
      } catch (error) {
        return { status: 0, error: ac.signal.aborted ? 'timeout' : String(error?.message ?? error) };
      } finally {
        clearTimer(timer);
        this.#aborters.delete(ac);
      }
    }

    /**
     * Retryable request: retries the same request with backoff on transient errors within `idleMs / 2`.
     * Returns the final `{ status, body }`; returns null if this end is already closed; returns
     * `{ status: 0, exhausted: true }` when retries are exhausted.
     */
    async #reliable(stage, method, route, opts, alive) {
      let delay = HTTP_CLIENT_DEFAULTS.retryBaseMs;
      let firstFail = null;
      for (;;) {
        if (!alive()) return null;
        const r = await this.#request(method, route, typeof opts === 'function' ? opts() : opts);
        if (!alive()) return null;
        if (!transient(r.status)) return r;
        firstFail ??= now();
        if (now() - firstFail >= this.#idleMs / 2) {
          say('http.error', { url: this.#safe, stage, status: r.status, message: r.error ?? null, gaveUp: true });
          return { status: 0, exhausted: true };
        }
        say('http.retry', { url: this.#safe, stage, status: r.status, message: r.error ?? null, delayMs: delay });
        await this.#sleep(delay);
        delay = Math.min(delay * 2, HTTP_CLIENT_DEFAULTS.retryMaxMs);
      }
    }

    async #open() {
      const r = await this.#request('POST', 'open', {
        headers: { 'x-promptcut-protocols': this.#protocols.join(', ') },
        body: '{}',
      });
      const ok = r.status === 200 && isObj(r.body) && r.body.ok === true && typeof r.body.sid === 'string';
      if (this.#closeWanted || this.#state === CLOSED) {
        if (ok) {
          this.#sid = r.body.sid;
          void this.#request('POST', 'close', { body: JSON.stringify(this.#closeWanted ?? { code: 1000 }), timeoutMs: HTTP_CLIENT_DEFAULTS.closeTimeoutMs });
        }
        this.#finish(1006, '', false);
        return;
      }
      if (!ok) {
        // Matches WebSocket handshake failure: emit error then close 1006 without disclosing reason (401,
        // 503, network failure are all the same)
        this.#state = CLOSED;
        this.#emit('error', { message: r.status ? `open ${r.status}` : `open failed: ${r.error ?? 'network'}` });
        this.#emit('close', { code: 1006, reason: '', wasClean: false });
        return;
      }
      const b = r.body;
      this.#sid = b.sid;
      this.protocol = typeof b.protocol === 'string' ? b.protocol : '';
      if (Number.isFinite(b.waitMs) && b.waitMs >= 0) this.#waitMs = Math.min(this.#waitMs, b.waitMs);
      if (Number.isFinite(b.idleMs) && b.idleMs > 0) this.#idleMs = b.idleMs;
      if (Number.isFinite(b.maxFrameBytes) && b.maxFrameBytes > 0) this.#maxFrame = b.maxFrameBytes;
      this.#state = OPEN;
      this.#emit('open', {});
      if (this.#state === OPEN) void this.#recvLoop();
    }

    async #recvLoop() {
      const alive = () => this.#state === OPEN;
      while (alive()) {
        const r = await this.#reliable('recv', 'GET', 'recv', () => ({ query: `?ack=${this.#lastSeq}&wait=${this.#waitMs}` }), alive);
        if (r === null) return;
        if (r.exhausted) return this.#finish(1006, '', false);
        if (r.status === 200 && isObj(r.body) && r.body.ok === true) {
          const frames = Array.isArray(r.body.frames) ? r.body.frames : [];
          for (const f of frames) {
            if (!isObj(f) || !Number.isSafeInteger(f.seq) || f.seq <= this.#lastSeq) continue;
            this.#lastSeq = f.seq;
            if (typeof f.data === 'string') this.#emit('message', { data: f.data });
            if (!alive()) return;
          }
          if (isObj(r.body.closed)) {
            const { code, reason } = r.body.closed;
            return this.#finish(Number.isInteger(code) ? code : 1006, typeof reason === 'string' ? reason : '', true);
          }
          continue;
        }
        return this.#failFrom(r);
      }
    }

    /** Non-retryable responses: 404 / 410 / 409 / 413 etc., treated as disconnect */
    #failFrom(r) {
      const b = isObj(r.body) ? r.body : {};
      if (r.status === 410) return this.#finish(Number.isInteger(b.code) ? b.code : 1006, typeof b.reason === 'string' ? b.reason : '', false);
      if (r.status === 413) return this.#finish(1009, 'too-large', false);
      say('http.error', { url: this.#safe, status: r.status, error: typeof b.error === 'string' ? b.error : null });
      return this.#finish(1006, '', false);
    }

    #kickSend() {
      if (this.#sending || this.#queue.length === 0) return;
      this.#sending = new Promise((resolve) => queueMicrotask(resolve)).then(() => this.#sendLoop()).finally(() => {
        this.#sending = null;
        if (this.#state === OPEN && this.#queue.length > 0) this.#kickSend();
      });
    }

    /** Sends in batches until queue is empty; only one POST in flight at a time */
    async #sendLoop() {
      const alive = () => this.#state === OPEN || this.#state === CLOSING;
      const budget = this.#maxFrame + HTTP_CLIENT_DEFAULTS.bodySlackBytes - 64;
      while (alive() && this.#queue.length > 0) {
        const frames = [];
        let size = 0;
        let raw = 0;
        while (this.#queue.length > 0) {
          const next = this.#queue[0];
          // Each frame in the request body is an escaped JSON string plus a comma; carries at least one frame
          // (server returns 413 for oversized single frames)
          const escaped = byteLen(JSON.stringify(next.text)) + 1;
          if (frames.length > 0 && size + escaped > budget) break;
          size += escaped;
          frames.push(next.text);
          raw += next.bytes;
          this.#queue.shift();
        }
        this.#queuedBytes -= raw;
        this.#inflightBytes = raw;
        const seq = ++this.#sendSeq;
        const body = JSON.stringify({ seq, frames });
        const r = await this.#reliable('send', 'POST', 'send', { body }, alive);
        this.#inflightBytes = 0;
        if (r === null) return;
        if (r.exhausted) return this.#finish(1006, '', false);
        if (r.status !== 200 || !isObj(r.body) || r.body.ok !== true) return this.#failFrom(r);
      }
    }

    async #closeOpen(code, reason) {
      let timedOut = false;
      const deadline = new Promise((resolve) => {
        const h = setTimer(() => { timedOut = true; resolve(); }, HTTP_CLIENT_DEFAULTS.closeTimeoutMs);
        this.#timers.add(h);
      });
      // Discard pending GET; wait for in-flight sends to return, then finish sending the rest
      const work = (async () => {
        if (this.#sending) await this.#sending;
        if (this.#state === CLOSING && this.#queue.length > 0) await this.#sendLoop();
        if (this.#state === CLOSING) await this.#request('POST', 'close', { body: JSON.stringify({ code, reason }), timeoutMs: HTTP_CLIENT_DEFAULTS.closeTimeoutMs });
      })();
      await Promise.race([work, deadline]);
      if (timedOut) say('http.close-timeout', { url: this.#safe });
      this.#finish(code, reason, !timedOut);
    }

    /** Reports closed (only once): aborts in-flight requests, clears timers, clears queue */
    #finish(code, reason, wasClean) {
      if (this.#state === CLOSED) return;
      this.#state = CLOSED;
      for (const ac of this.#aborters) { try { ac.abort(); } catch { /* Aborted */ } }
      this.#aborters.clear();
      for (const h of this.#timers) clearTimer(h);
      this.#timers.clear();
      this.#queue = [];
      this.#queuedBytes = 0;
      this.#emit('close', { code, reason, wasClean });
    }
  }

  return HttpWebSocket;
}

/** `HttpWebSocket` using global `fetch` and timers */
export const HttpWebSocket = httpWebSocketClass();

/**
 * Endpoint of the same shape as `createWsEndpoint`, backed by HTTP long polling (section 8 of the
 * contract).
 * Options have identical names and semantics: `url` (http(s) or ws(s)), `protocols`, `token`,
 * `setTimeout`, `clearTimeout`, `random`, `backoff`, `log`.
 * Like the WebSocket endpoint, `setTimeout` / `clearTimeout` only handle reconnect backoff;
 * single-request timeouts and transient error retry intervals are injected separately via
 * `httpTimers: { setTimeout, clearTimeout }` (defaults to global timers) to avoid mixing the two
 * timer types.
 * Also accepts `fetch` (defaults to global `fetch`), `waitMs` (defaults to 25 000),
 * `requestTimeoutMs`, `now`.
 * @param {object} options
 * @returns {import('./ws-transport.mjs').WsEndpoint}
 */
export function createHttpEndpoint(options = /** @type {any} */ ({})) {
  const { url, fetch, waitMs, requestTimeoutMs, now, httpTimers, WebSocket: _ignored, ...rest } = options ?? {};
  let wsUrl;
  try {
    wsUrl = wsUrlOf(url);
  } catch {
    throw new TypeError('createHttpEndpoint: url must be http(s):// or ws(s)://');
  }
  const WebSocketImpl = httpWebSocketClass({
    fetch,
    ...(waitMs !== undefined ? { waitMs } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(httpTimers?.setTimeout ? { setTimeout: httpTimers.setTimeout } : {}),
    ...(httpTimers?.clearTimeout ? { clearTimeout: httpTimers.clearTimeout } : {}),
    ...(now ? { now } : {}),
    ...(rest.log ? { log: rest.log } : {}),
  });
  return createWsEndpoint({ ...rest, url: wsUrl, WebSocket: WebSocketImpl });
}

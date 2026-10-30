/**
 * 节点到文档服务的 HTTP 长轮询端点（契约 `docs/plan/http-transport-contract.md` 第 8 节）。
 *
 * 给出口只放行 443 HTTPS、不支持 WebSocket 升级的节点用（云端开发容器经出站代理）。两样东西：
 *
 * - `HttpWebSocket` / `httpWebSocketClass(deps)`：仿 WebSocket 的类（`new HttpWebSocket(url, protocols)`，
 *   `readyState`、`protocol`、`bufferedAmount`、`send`、`close`、`addEventListener` 与 `on*`），协议是服务端
 *   `server/docservice/http-transport.mjs` 的四个端点。给 `doc-link` 这类直接 `new WebSocket` 的调用方注入。
 *   - 建连 `POST /lp/open`，子协议列表放 `X-Promptcut-Protocols`（与 WebSocket 同一个列表，证明、票据都在里面）；
 *   - 发送：`send` 进队，同一时刻只有一个 `POST /lp/send` 在途，小帧攒成一批（请求体不超过单帧上限 + 64 KiB），
 *     批次号从 1 起；没收到回包就重发同一批（服务端按批次号去重）；
 *   - 接收：一直挂一个 `GET /lp/recv?ack=&wait=`，只在确实收到回包后才推进 `ack`，按帧序号去重；
 *   - 临时错误（网络错误、超时、5xx、429）不立刻算断线：在 `idleMs / 2` 之内按短退避（250 ms 起，翻倍，封顶 5 s）
 *     重试同一请求；超过才以 1006 关闭。404（会话不存在）、410（会话已结束）立刻按断开处理（410 带服务端的关闭码）；
 *   - `sid` 是 bearer 凭证：只放 `Authorization` 头，不进 URL、日志、错误信息。
 * - `createHttpEndpoint(options)`：与 `createWsEndpoint` 同一个形状、同名同义的选项（退避重连、`protocols()` 每次现取、
 *   断线期间 `send` 丢弃计入 `stats().dropped`），就是 `createWsEndpoint` 套上 `HttpWebSocket`；另有 `fetch`、`waitMs`。
 *   `url` 收 `http(s)://` 或 `ws(s)://`，指文档服务基址。
 *
 * 只用全局 `fetch`、`AbortController`、`TextEncoder` 与计时器（都可注入），不引任何包，浏览器可以原样用。
 * 代理：本模块不自己处理。Node 24.5 起以 `NODE_USE_ENV_PROXY=1`（或 `--use-env-proxy`）加 `HTTPS_PROXY` 运行，
 * 全局 `fetch` 就经 CONNECT 隧道走代理；要显式控制时注入带 `dispatcher` 的 `fetch`。
 */
import { createWsEndpoint } from './ws-transport.mjs';

export const HTTP_CLIENT_DEFAULTS = Object.freeze({
  /** 请服务端挂多久（服务端与它的 `waitMs` 取小） */
  waitMs: 25_000,
  /** 一次请求（含挂起的 GET）最多等多久；比挂起时长多 15 s（契约第 11 节：客户端超时 35～40 s） */
  requestSlackMs: 15_000,
  /** 服务端没说时用的会话空闲期（决定临时错误最多重试多久：它的一半） */
  idleMs: 60_000,
  retryBaseMs: 250,
  retryMaxMs: 5_000,
  /** `close()` 最多等多久（发完剩下的、`POST /lp/close`），过了直接报关闭 */
  closeTimeoutMs: 5_000,
  /** 服务端没说时用的单帧上限 */
  maxFrameBytes: 1024 * 1024,
  /** 一批的请求体比单帧上限多出的余量（与服务端一致） */
  bodySlackBytes: 64 * 1024,
});

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const encoder = new TextEncoder();
const byteLen = (text) => encoder.encode(text).byteLength;

/** 文档服务地址 → http(s) 基址（`ws:` → `http:`、`wss:` → `https:`，路径保留、去掉结尾斜杠与查询串） */
export function httpBaseOf(url) {
  const u = new URL(url);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  else if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError('文档服务地址必须是 http(s):// 或 ws(s)://');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/** 反过来：http(s) → ws(s)（`createWsEndpoint` 只收 ws(s)，套 `HttpWebSocket` 时用它传地址） */
function wsUrlOf(url) {
  const u = new URL(url);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new TypeError('文档服务地址必须是 http(s):// 或 ws(s)://');
  return u.toString();
}

/** 临时错误：网络错误（status 0）、超时、网关与服务端错误、限流 */
const transient = (status) => status === 0 || status === 408 || status === 429 || status >= 500;

/**
 * 返回绑好依赖的 `HttpWebSocket` 类。
 * @param {object} [deps]
 * @param {typeof globalThis.fetch} [deps.fetch]  缺省调用时的全局 `fetch`
 * @param {number} [deps.waitMs]  请服务端挂多久，缺省 25 000
 * @param {number} [deps.requestTimeoutMs]  单次请求上限，缺省 `waitMs + 15 000`
 * @param {(fn: () => void, ms: number) => any} [deps.setTimeout]
 * @param {(handle: any) => void} [deps.clearTimeout]
 * @param {() => number} [deps.now]  重试期限按它算
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
  const say = (event, fields) => { try { log(event, fields); } catch { /* 日志出错不影响连接 */ } };
  const doFetch = (url, init) => {
    const f = fetchImpl ?? globalThis.fetch;
    if (typeof f !== 'function') throw new TypeError('HttpWebSocket：没有可用的 fetch');
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
    /** 待发的帧与它们的字节数；在途那一批的字节数另记 */
    #queue = [];
    #queuedBytes = 0;
    #inflightBytes = 0;
    #sendSeq = 0;
    #sending = null;
    #lastSeq = 0;
    /** 在途请求的中止器、重试的计时器：关闭时一起清掉 */
    #aborters = new Set();
    #timers = new Set();
    #closeWanted = null;

    /**
     * @param {string} url  文档服务基址：`http(s)://` 或 `ws(s)://`
     * @param {string | string[]} [protocols]  与 WebSocket 同一个子协议列表
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

    /** 发一条文本。连接中调用抛错（同 WebSocket）；已在关闭或已关闭时丢弃 */
    send(data) {
      if (this.#state === CONNECTING) throw new Error('InvalidStateError: HttpWebSocket 还没连上');
      if (this.#state !== OPEN) return;
      const text = typeof data === 'string' ? data : String(data);
      const bytes = byteLen(text);
      this.#queue.push({ text, bytes });
      this.#queuedBytes += bytes;
      this.#kickSend();
    }

    /** 关闭：先把已进队的发完，再 `POST /lp/close`，然后报 `close`。最多等 `closeTimeoutMs` */
    close(code = 1000, reason = '') {
      if (this.#state === CLOSING || this.#state === CLOSED) return;
      if (this.#state === CONNECTING) {
        // 同 WebSocket：连上之前就关，报 1006；建连回来了也立刻关掉服务端那头
        this.#closeWanted = { code, reason };
        this.#state = CLOSING;
        return;
      }
      this.#state = CLOSING;
      void this.#closeOpen(code, typeof reason === 'string' ? reason : '');
    }

    // ---------- 内部 ----------

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

    /** 发一次请求；回 `{ status, body }`，网络错误或超时回 `{ status: 0, error }`（不抛） */
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
     * 可重试的请求：临时错误在 `idleMs / 2` 之内按退避重试同一请求。回最后的 `{ status, body }`；
     * 本端已关闭回 null；重试用完回 `{ status: 0, exhausted: true }`。
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
        // 同 WebSocket 握手失败：先 error 再 close 1006，不说原因（401、503、网络不通都一样）
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

    /** 不可重试的回包：404 / 410 / 409 / 413 等，按断开处理 */
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

    /** 一批一批地发，直到队空；同一时刻只有一个 POST 在途 */
    async #sendLoop() {
      const alive = () => this.#state === OPEN || this.#state === CLOSING;
      const budget = this.#maxFrame + HTTP_CLIENT_DEFAULTS.bodySlackBytes - 64;
      while (alive() && this.#queue.length > 0) {
        const frames = [];
        let size = 0;
        let raw = 0;
        while (this.#queue.length > 0) {
          const next = this.#queue[0];
          // 请求体里每帧是转义后的 JSON 字符串加一个逗号；至少带一帧（超限的单帧由服务端回 413）
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
      // 挂着的 GET 不要了；在途的发送等它回来，剩下的发完
      const work = (async () => {
        if (this.#sending) await this.#sending;
        if (this.#state === CLOSING && this.#queue.length > 0) await this.#sendLoop();
        if (this.#state === CLOSING) await this.#request('POST', 'close', { body: JSON.stringify({ code, reason }), timeoutMs: HTTP_CLIENT_DEFAULTS.closeTimeoutMs });
      })();
      await Promise.race([work, deadline]);
      if (timedOut) say('http.close-timeout', { url: this.#safe });
      this.#finish(code, reason, !timedOut);
    }

    /** 报关闭（只一次）：中止在途请求、清计时器、清队列 */
    #finish(code, reason, wasClean) {
      if (this.#state === CLOSED) return;
      this.#state = CLOSED;
      for (const ac of this.#aborters) { try { ac.abort(); } catch { /* 已中止 */ } }
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

/** 用全局 `fetch` 与计时器的 `HttpWebSocket` */
export const HttpWebSocket = httpWebSocketClass();

/**
 * 与 `createWsEndpoint` 同一个形状的端点，底下是 HTTP 长轮询（契约第 8 节）。
 * 选项同名同义：`url`（http(s) 或 ws(s)）、`protocols`、`token`、`setTimeout`、`clearTimeout`、`random`、`backoff`、`log`。
 * `setTimeout` / `clearTimeout` 与 WebSocket 端点一样只管重连退避；单次请求的超时、临时错误的重试间隔另由
 * `httpTimers: { setTimeout, clearTimeout }` 注入（缺省全局计时器），免得两种计时器混在一起。
 * 另有 `fetch`（缺省全局 `fetch`）、`waitMs`（缺省 25 000）、`requestTimeoutMs`、`now`。
 * @param {object} options
 * @returns {import('./ws-transport.mjs').WsEndpoint}
 */
export function createHttpEndpoint(options = /** @type {any} */ ({})) {
  const { url, fetch, waitMs, requestTimeoutMs, now, httpTimers, WebSocket: _ignored, ...rest } = options ?? {};
  let wsUrl;
  try {
    wsUrl = wsUrlOf(url);
  } catch {
    throw new TypeError('createHttpEndpoint：url 必须是 http(s):// 或 ws(s)://');
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

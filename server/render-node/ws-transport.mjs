/**
 * 节点到文档服务的 WebSocket 端点（分布式预渲染 M5a，契约 `docs/plan/render-queue-contract.md` G.7）。
 *
 * HT-a 起（`docs/plan/http-transport-contract.md` 第 9 节）业务调用方改用 `session-link.mjs` 的 `createDocEndpoint`
 * （会话：序号与确认、传输断了接续、不丢消息）；本模块留作「一条传输就是一个连接」的底座：管理接口的令牌连接
 * （`asset-announce`）、只走一种传输的开发者强制与测试。
 *
 * 满足 D.2 的 `endpoint` 形状（`send`、`onMessage`），可以直接交给 `createLocalNode`。
 * 另外负责：
 *   - 子协议（M6a，`docs/plan/auth-contract.md` 第 5、11 节）：
 *     - `protocols`：一个函数（可以是 async），**每次（重）连之前调一次**，回这一次握手要带的子协议数组。
 *       共享项目的证明里的 nonce 只能用一次，所以不能缓存；取不到（抛错、reject）按连不上处理，照常退避重连；
 *     - `token`：集群令牌，只给管理接口用（`asset-announce` 登记地址）：`['promptcut.v1', 'promptcut.token.<令牌>']`。
 *       集群令牌不给数据面任何权限，数据面的连接不要带它；
 *     - 都不给：`['promptcut.v1']`（连本机回环时是本机身份）。`protocols` 与 `token` 不能同时给；
 *   - 断线或连不上之后按指数退避自动重连，第 n 次（从 0 起）等
 *     `min(maxMs, baseMs × factor^n) × (1 + jitter × (2·random() − 1))`，连上后 n 清零，`close()` 之后不再重连；
 *   - 断线期间 `send` 的消息一律丢弃（不缓存重放），计入 `stats().dropped`。正确性靠重连后的
 *     `hello.resume` / `queue.snapshot` 和 D.2 细任务开工前的 `sink.has`（G.7）。
 *
 * 本模块不认识 `local-node`，接法由调用方负责（G.7 约定写法）：
 *   ep.onOpen(() => node.start(node.session.held().map(({ id, token }) => ({ id, token }))));
 *
 * 不引任何模块：只用全局的 `WebSocket`（Node 22 起内置、浏览器同名），M7 的纯浏览器节点可以原样复用。
 * `WebSocket`、`setTimeout`、`clearTimeout`、`random` 都可注入，测试不必起真服务、不必真等。
 * 令牌只进子协议，不进 URL、日志和任何错误信息。
 */

export const PROTOCOL = 'promptcut.v1';
const TOKEN_PREFIX = 'promptcut.token.';

export const BACKOFF_DEFAULTS = Object.freeze({ baseMs: 500, factor: 2, maxMs: 15_000, jitter: 0.2 });

/** WebSocket.readyState 的 OPEN（浏览器与 Node 相同） */
const OPEN = 1;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 第 n 次（从 0 起）重连前的等待（毫秒），G.7 公式。
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
 * @property {(message: object) => boolean} send  未连上时丢弃、回 false、计入 `stats().dropped`
 * @property {(handler: (message: object) => void) => void} onMessage  多个处理器按注册顺序都调
 * @property {(handler: () => void) => void} onOpen  每次（重）连上都调
 * @property {(handler: (info: { code: number, reason: string }) => void) => void} onClose  每次断开都调
 * @property {() => void} close  关连接、停止重连，`closed` 变 true
 * @property {boolean} connected
 * @property {boolean} closed
 * @property {() => { opens: number, closes: number, sent: number, received: number, dropped: number, badFrames: number }} stats
 */

/**
 * @param {object} options
 * @param {string} options.url  `ws://` 或 `wss://`
 * @param {() => (string[] | Promise<string[]>)} [options.protocols]  每次连之前取子协议（共享项目的证明、连接票据）
 * @param {string} [options.token]  集群令牌，只给管理接口用；不设就只带 `promptcut.v1`
 * @param {any} [options.WebSocket]  缺省全局 `WebSocket`
 * @param {(fn: () => void, ms: number) => any} [options.setTimeout]
 * @param {(handle: any) => void} [options.clearTimeout]
 * @param {() => number} [options.random]  [0, 1)，抖动用
 * @param {Partial<typeof BACKOFF_DEFAULTS>} [options.backoff]  与 `BACKOFF_DEFAULTS` 合并
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
    throw new TypeError('createWsEndpoint：url 不是合法地址');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new TypeError('createWsEndpoint：url 必须是 ws:// 或 wss://');
  }
  if (typeof WebSocketImpl !== 'function') throw new TypeError('createWsEndpoint：没有可用的 WebSocket');
  if (token !== undefined && token !== null && (typeof token !== 'string' || token === '')) {
    throw new TypeError('createWsEndpoint：token 必须是非空字符串');
  }
  if (protocolsOf !== undefined && protocolsOf !== null) {
    if (typeof protocolsOf !== 'function') throw new TypeError('createWsEndpoint：protocols 必须是函数');
    if (token) throw new TypeError('createWsEndpoint：protocols 与 token 不能同时给');
  }

  const policy = { ...BACKOFF_DEFAULTS, ...(backoff ?? {}) };
  const fixedProtocols = token ? [PROTOCOL, TOKEN_PREFIX + token] : [PROTOCOL];
  /** 日志里只写不含令牌的地址（令牌本来就不在 URL 里，这里只去掉可能的用户名密码与查询串） */
  const safeUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;

  const messageHandlers = [];
  const openHandlers = [];
  const closeHandlers = [];
  const counters = { opens: 0, closes: 0, sent: 0, received: 0, dropped: 0, badFrames: 0 };

  /** 当前这一条 socket（连接中或已连上）；旧 socket 的迟到事件一律忽略 */
  let ws = null;
  let connected = false;
  let closed = false;
  /** 下一次重连用的 n（从 0 起），连上后清零 */
  let attempt = 0;
  let retryTimer = null;
  /** 正在取子协议（`protocols()` 还没回） */
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

  /** 这一次握手的子协议：给了 `protocols` 就现取，否则用固定的一组 */
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
      if (!Array.isArray(list) || list.some((p) => typeof p !== 'string')) throw new TypeError('protocols() 必须回字符串数组');
      open(list);
    }).catch((error) => {
      pending = false;
      // 日志只记原因，不记子协议（里面有证明或票据）
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
        // close() 之后才迟到的 open：直接关掉，不算连上
        try { socket.close(1000, 'closed'); } catch { /* 已经在关 */ }
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
      // 本端 close() 发起的关闭一律报 { code: 1000, reason: 'closed' }（契约 G.11）：
      // 对端回的关闭帧里 reason 可能是空串，不透传；其余断开照旧透传底层的 code 和 reason
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
    // connected 立刻变 false：close() 之后的 send 一律丢弃；onClose 等 socket 真正关上时再调
    connected = false;
    if (socket) {
      try { socket.close(1000, 'closed'); } catch { /* 已经在关 */ }
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

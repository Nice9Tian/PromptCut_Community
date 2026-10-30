/**
 * 客户端会话层：到文档服务的一条**会话**（契约 `docs/plan/http-transport-contract.md` 第 3、4、9、16 节；
 * 语义 `docs/semantics/product/document-service.md` 与 `docs/semantics/mechanism/document-service.md` 的「会话与传输」）。
 *
 * `createDocEndpoint` 返回值与 `createWsEndpoint` 同形状（`send`、`onMessage`、`onOpen`、`onClose`、`close`、
 * `connected`、`closed`、`stats()`），另加 `onResume`，可以直接交给 `createLocalNode`、`createContentClient` 等。
 *
 * 会话与传输：
 *   - 建会话：握手的子协议是 `protocols()` 现取的鉴权列表加 `promptcut.session.new`；服务端的第一条消息是
 *     `session.welcome { sid, resumed, ack, retainMs, transport }`，收到它才算建成，调 `onOpen`（节点在这里发
 *     `hello.resume`，页面在这里重新订阅）。
 *   - 序号与确认：出站业务消息带 `seq`（本会话里从 1 起），顺带 `ack`（已按序收全的服务端最大 `seq`）；入站按 `seq`
 *     收，摘掉 `seq` / `ack` 再交 `onMessage`，重发丢弃，跳号或越界的 `ack` 按会话已坏结束（1002）。没有顺带机会时，
 *     收满 `ackEvery` 条（32）、或收下的消息原文满 `ackBytes`（64 KiB，〔裁〕2026-09-27）就立刻、否则 `ackDelayMs`（1 s）内
 *     单发 `{ type: 'session.ack', ack }`。`session.*` 控制消息不带 `seq`、不交上层。
 *   - 传输断开只让会话**脱开**：未确认的出站留着，`send` 照收；按退避接续，接续的子协议只有
 *     `promptcut.v1` 与 `promptcut.session.<sid>.<ack>`（不再调 `protocols()`）。接续成功调 `onResume`（不调
 *     `onOpen`），按 `welcome.ack` 释放、其余按原 `seq` 依次补发。传输的断开与接续只进日志与 `stats()`。
 *   - 会话结束才调 `onClose { code, reason }`：服务端以非「传输故障」的关闭码关（4003、4004、1013、1001、1002 等）；
 *     接续被拒（服务端先接受升级再以 4404 会话不存在 / 4410 会话已结束关，契约第 16 节第 1 条）；脱开超过
 *     `welcome.retainMs` 还没接续上；本端发现跳号（1002）或未确认的出站超过 `maxPendingBytes`（1013）。
 *     4410 的 `reason` 里带着原关闭码；原码属于「连着时收到也不会重连」的 `FINAL_CLOSE`（4003、4004）时，报给
 *     `onClose` 的是原关闭码与原因（脱开期间项目被删，上层照样看到 4004），其余报 4410（〔裁〕2026-09-27，契约第 17 节）。
 *     结束后未确认的消息丢弃（计入 `stats().dropped`），之后 `send` 丢弃并计数，按退避重新取凭证建新会话。
 *   - `close()`：先发 `{ type: 'session.close', code: 1000, reason: 'closed' }` 再关传输，服务端立刻结束会话；不再重连。
 *
 * 选传输（第 4.3 节）：HT-a 只走 WebSocket。`url` 收 `ws(s)://` 或 `http(s)://`，一律换成 WebSocket 地址。
 * `transport` 选项（浏览器由调用方给）或 Node 的 `PROMPTCUT_TRANSPORT`：`ws` 强制 WebSocket；`auto`（缺省）
 * 在 HT-a 等同 `ws`；`http` 在 HT-a 未启用，构造时抛 `code: 'transport-unavailable'`。HTTP 长轮询回落、
 * `X-Promptcut-Fallback` 与 `fetch` 留给 HT-b：`fallbackAfter()` 是接口位置，HT-a 永远回 null（每次重连仍从
 * WebSocket 开始，`stats().fallbacks` 恒为 0）。
 *
 * 契约之外的两处（报告 `docs/archive/agent-reports/AGENT-ht-client.md` 写明）：
 *   - **旧服务端**：服务端还没有会话层时（握手成功、第一条消息不是 `session.welcome`），退化为「一条传输就是一个会话」：
 *     消息不带 `seq` / `ack`，传输一断会话就结束，行为与 `createWsEndpoint` 相同（`stats().legacy` 为真）。为了
 *     尽快分辨，握手后 `legacyProbeMs` 内没收到任何消息，就发一条无害的 `{ type: 'session.ack', ack: 0 }`：新服务端
 *     早已发了 welcome，旧服务端回 `error unsupported`（这条回包不交上层）。
 *   - `onConnectFail(handler)`：建新会话没成（握手失败、没等到 welcome、`protocols()` 失败）时调，给页面分辨
 *     「口令错被拒」用；`renew: false` 时端点只跑一个会话，建不成或结束后自己关掉，由调用方决定要不要再建。
 *     `dropTransport()`：开发与测试用，只断当前传输（会话脱开后接续），不结束会话。
 *
 * 只用全局的 `WebSocket` 与计时器（都可注入），浏览器与 Node 通用；不自己处理代理（Node 22.22 起加
 * `NODE_USE_ENV_PROXY=1`）。会话号与凭证不进地址、日志与任何错误信息。
 */
import { PROTOCOL, BACKOFF_DEFAULTS, backoffDelay } from './ws-transport.mjs';

export const SESSION_NEW = 'promptcut.session.new';
export const SESSION_PREFIX = 'promptcut.session.';
const TOKEN_PREFIX = 'promptcut.token.';

export const SESSION_DEFAULTS = Object.freeze({
  /** 收到的消息里还没确认的满这么多条就单发 `session.ack`（第 3.3 节） */
  ackEvery: 32,
  /** 收到消息后这么久内没有顺带的机会就单发 `session.ack`（第 3.3 节） */
  ackDelayMs: 1000,
  /**
   * 收到的还没确认的消息原文满这么多字节就立刻单发 `session.ack`（〔裁〕2026-09-27 主会话，两端同一条，契约第 17 节补）：
   * 快照分片这类大消息只按条数与 1 s 确认的话，对方一秒内能攒下超过 1 MiB 未确认，把自己的会话以 1013 结束
   */
  ackBytes: 64 * 1024,
  /** 客户端未确认的出站字节上限，超了以 1013 结束会话（第 3.4 节） */
  maxPendingBytes: 1024 * 1024,
  /** welcome 没带 `retainMs` 时按这个算（第 4.2 节缺省） */
  retainMs: 60_000,
  /** 握手成功后等 `session.welcome` 的上限，超了按这次握手失败处理 */
  welcomeTimeoutMs: 10_000,
  /** 握手成功后这么久一条消息都没收到，就发一条探测，分辨旧服务端 */
  legacyProbeMs: 250,
});

/** 会话结束时的关闭码：接续失败（契约第 16 节第 1 条） */
export const CLOSE_NO_SESSION = 4404;
export const CLOSE_SESSION_ENDED = 4410;
/**
 * 传输故障：这些关闭码只让会话脱开、接着接续；其余关闭码（1000、1001、1002、1013、4003、4004、4009 等）都是
 * 服务端结束了会话，不接续（第 4.2 节「服务端主动关」）。
 */
const TRANSPORT_FAULT = new Set([1005, 1006, 1011, 1012, 1014, 1015]);
/**
 * 「连着时收到也不会重连」的关闭码：创建者操作的结果，4003 踢人 / 移出（`kicked` / `removed`）、4004 删项目（`deleted`），
 * `auth-contract.md` 第 7 节；页面 `SyncLink` 的 `FATAL_CLOSE` 与它一致。脱开期间会话因这些码结束时，接续得到的 4410
 * 按原关闭码报给上层、不重建，使上层与连着时收到该码一样（〔裁〕2026-09-27 主会话，契约第 17 节）。
 */
export const FINAL_CLOSE = new Set([4003, 4004]);

/**
 * 4410 的 `reason`（服务端写法 `session-closed <原关闭码>[ <原原因>]`，契约第 4.1 节）里取出原关闭码与原因；
 * 不是这个写法回 null。
 */
export function closedCodeOf(reason) {
  const m = /^session-closed (\d{4})(?: ([\s\S]*))?$/.exec(typeof reason === 'string' ? reason : '');
  return m ? { code: Number(m[1]), reason: m[2] ?? '' } : null;
}

/** HT-b 用的降级原因（第 4.3 节第 5 条）；HT-a 不降级 */
export const FALLBACK_REASONS = Object.freeze(['ws-error', 'ws-timeout', 'ws-closed']);

const OPEN = 1;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 字符串按 UTF-8 编码的字节数（不分配缓冲） */
export function utf8Length(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** `ws(s)://` 或 `http(s)://` → WebSocket 地址 */
export function wsUrlOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new TypeError('createDocEndpoint：url 不是合法地址');
  }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new TypeError('createDocEndpoint：url 必须是 ws(s):// 或 http(s)://');
  return u.toString();
}

/** `ws(s)://` 或 `http(s)://` → HTTP 地址（HT-b 的长轮询基址用） */
export function httpUrlOf(url) {
  const u = new URL(wsUrlOf(url));
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  return u.toString();
}

/**
 * 定传输：选项优先，其次 Node 的 `PROMPTCUT_TRANSPORT`，都没有是 `auto`。回 `'auto' | 'ws'`。
 * `http` 在 HT-a 未启用：抛 `code: 'transport-unavailable'`；别的取值抛 TypeError。
 */
export function transportOf(option, env = globalThis.process?.env?.PROMPTCUT_TRANSPORT) {
  const raw = option ?? env;
  const v = raw === undefined || raw === null ? 'auto' : String(raw).trim().toLowerCase() || 'auto';
  if (v === 'auto' || v === 'ws') return v;
  if (v === 'http') {
    throw Object.assign(new Error('HTTP 长轮询传输在本版（HT-a）未启用，只能走 WebSocket：去掉 PROMPTCUT_TRANSPORT=http（或 --transport http），或改成 ws'), { code: 'transport-unavailable' });
  }
  throw new TypeError(`传输只能是 auto、ws 或 http：${JSON.stringify(String(raw)).slice(0, 40)}`);
}

/**
 * @param {object} options
 * @param {string} options.url  `ws(s)://` 或 `http(s)://`
 * @param {() => (string[] | Promise<string[]>)} [options.protocols]  每次**建会话**前现取鉴权列表（含 `promptcut.v1`，不含会话项）
 * @param {() => (string[] | Promise<string[]>)} [options.resumeProtocols] 中继接续时另取网关路由能力；会话秘密不变，失败保留会话退避重试
 * @param {string} [options.token]  集群令牌（管理接口用）；与 `protocols` 互斥；都不给就只带 `promptcut.v1`
 * @param {'auto' | 'ws' | 'http'} [options.transport]  缺省读 Node 的 `PROMPTCUT_TRANSPORT`，再缺省 `auto`
 * @param {typeof fetch} [options.fetch]  HT-b 的 HTTP 长轮询用；HT-a 不调
 * @param {number} [options.waitMs]  HT-b 的挂起时长；HT-a 不用
 * @param {any} [options.WebSocket]
 * @param {(fn: () => void, ms: number) => any} [options.setTimeout]
 * @param {(handle: any) => void} [options.clearTimeout]
 * @param {() => number} [options.random]
 * @param {Partial<typeof BACKOFF_DEFAULTS>} [options.backoff]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.maxPendingBytes]  未确认出站的上限，缺省 1 MiB（第 3.4 节）
 * @param {boolean} [options.renew]  缺省 true：会话结束后自动建新会话；false：只跑一个会话
 */
export function createDocEndpoint({
  url,
  protocols: protocolsOf,
  resumeProtocols: resumeProtocolsOf,
  token,
  transport,
  // eslint-disable-next-line no-unused-vars
  fetch: fetchImpl = globalThis.fetch,
  // eslint-disable-next-line no-unused-vars
  waitMs,
  WebSocket: WebSocketImpl = globalThis.WebSocket,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
  random = Math.random,
  backoff,
  log = () => {},
  now = Date.now,
  maxPendingBytes = SESSION_DEFAULTS.maxPendingBytes,
  ackEvery = SESSION_DEFAULTS.ackEvery,
  ackDelayMs = SESSION_DEFAULTS.ackDelayMs,
  ackBytes = SESSION_DEFAULTS.ackBytes,
  welcomeTimeoutMs = SESSION_DEFAULTS.welcomeTimeoutMs,
  legacyProbeMs = SESSION_DEFAULTS.legacyProbeMs,
  renew = true,
} = /** @type {any} */ ({})) {
  const mode = transportOf(transport);
  const wsUrl = wsUrlOf(url);
  if (typeof WebSocketImpl !== 'function') throw new TypeError('createDocEndpoint：没有可用的 WebSocket');
  if (token !== undefined && token !== null && (typeof token !== 'string' || token === '')) {
    throw new TypeError('createDocEndpoint：token 必须是非空字符串');
  }
  if (protocolsOf !== undefined && protocolsOf !== null) {
    if (typeof protocolsOf !== 'function') throw new TypeError('createDocEndpoint：protocols 必须是函数');
    if (token) throw new TypeError('createDocEndpoint：protocols 与 token 不能同时给');
  }
  const policy = { ...BACKOFF_DEFAULTS, ...(backoff ?? {}) };
  const fixedProtocols = token ? [PROTOCOL, TOKEN_PREFIX + token] : [PROTOCOL];
  const parsed = new URL(wsUrl);
  /** 日志里只写不含凭证的地址 */
  const safeUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;

  const messageHandlers = [];
  const openHandlers = [];
  const resumeHandlers = [];
  const closeHandlers = [];
  const connectFailHandlers = [];
  /**
   * 计数（`stats()` 原样给出，节点诊断从这里取，混沌测试靠它判「接续了几次、丢了几次、是否重建会话」）：
   *   opens 建成的会话数（含重建）；renews 其中在前一个会话结束之后建的（重建）；resumes 接续成功；detaches 传输断开、
   *   会话脱开；lost 接续被服务端拒（4404 / 4410）；expired 本端判出脱开超过保留期；connectFails 建新会话没成；
   *   closes 会话结束；dropped 丢弃的出站消息（会话结束时未确认的、没有会话时 `send` 的）。
   */
  const counters = { opens: 0, closes: 0, sent: 0, received: 0, dropped: 0, badFrames: 0, duplicates: 0, resumes: 0, detaches: 0, fallbacks: 0,
    renews: 0, lost: 0, expired: 0, connectFails: 0 };
  /** 最后一次会话结束 `{ code, reason, at }` 与最后一次脱开 `{ code, at }`；reason 截到 120 字符（服务端的关闭原因不含凭证） */
  let lastClose = null;
  let lastDetach = null;
  /** 有过会话（下一次建成的算重建） */
  let hadSession = false;

  let closed = false;
  /**
   * 当前会话；null = 没有会话（还没建成、或已结束）。
   * { sid, legacy, retainMs, outSeq, outBuf: [{ seq, body, bytes }], pendingBytes, inAck, inUnacked, ackTimer, detachedAt }
   */
  let sess = null;
  /** 当前这一条传输（握手中、等 welcome、或已挂上）；旧传输的迟到事件一律忽略 */
  let cur = null;
  let attempt = 0;
  let retryTimer = null;
  /** 正在取鉴权列表（`protocols()` 还没回） */
  let pendingProtocols = false;

  const say = (event, fields = {}) => {
    try { log(event, { url: safeUrl, ...fields }); } catch { /* 日志失败不影响连接 */ }
  };

  function emit(handlers, arg, what) {
    for (const handler of [...handlers]) {
      try {
        handler(arg);
      } catch (error) {
        say('session.handler-error', { handler: what, message: String(error?.message ?? error) });
      }
    }
  }

  function listen(socket, type, fn) {
    if (typeof socket.addEventListener === 'function') socket.addEventListener(type, fn);
    else socket[`on${type}`] = fn;
  }

  const attached = () => cur !== null && cur.stage === 'attached';

  function rawSend(rec, message) {
    if (!rec || rec.ended || (typeof rec.socket.readyState === 'number' && rec.socket.readyState !== OPEN)) return false;
    try {
      rec.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function clearRecTimers(rec) {
    if (rec.welcomeTimer !== null) { clearTimer(rec.welcomeTimer); rec.welcomeTimer = null; }
    if (rec.probeTimer !== null) { clearTimer(rec.probeTimer); rec.probeTimer = null; }
  }

  function clearAckTimer(s) {
    if (s && s.ackTimer !== null) { clearTimer(s.ackTimer); s.ackTimer = null; }
  }

  // ------------------------------------------------------------------ 建会话、接续

  function connect() {
    retryTimer = null;
    if (closed || cur !== null) return;
    if (sess && !sess.legacy) {
      if (now() - sess.detachedAt >= sess.retainMs) {
        counters.expired++;
        say('session.expired', { retainMs: sess.retainMs });
        endSession(1006, 'retain-expired', { notify: false });
        return;
      }
      if (typeof resumeProtocolsOf !== 'function') {
        dial([PROTOCOL, `${SESSION_PREFIX}${sess.sid}.${sess.inAck}`], 'resume');
        return;
      }
      // 会话秘密仍由原服务核验；中继网关另需当前路由能力，不能因接续省略它。
      const saved = sess;
      pendingProtocols = true;
      Promise.resolve().then(() => resumeProtocolsOf()).then(list => {
        pendingProtocols = false;
        if (closed || sess !== saved || cur !== null) return;
        if (!Array.isArray(list) || list.some(p => typeof p !== 'string')) throw new TypeError('resumeProtocols() 必须回字符串数组');
        dial([PROTOCOL, `${SESSION_PREFIX}${saved.sid}.${saved.inAck}`, ...list.filter(p => p !== PROTOCOL && p !== SESSION_NEW && !p.startsWith(SESSION_PREFIX))], 'resume');
      }).catch(() => {
        pendingProtocols = false;
        if (closed || sess !== saved) return;
        say('session.resume-protocols-failed');
        scheduleRetry();
      });
      return;
    }
    if (typeof protocolsOf !== 'function') {
      dial([...fixedProtocols, SESSION_NEW], 'new');
      return;
    }
    let got;
    try {
      got = protocolsOf();
    } catch (error) {
      protocolsFailed(error);
      return;
    }
    pendingProtocols = true;
    Promise.resolve(got).then((list) => {
      pendingProtocols = false;
      if (closed) return;
      if (!Array.isArray(list) || list.some((p) => typeof p !== 'string')) throw new TypeError('protocols() 必须回字符串数组');
      dial([...list.filter((p) => p !== SESSION_NEW && !p.startsWith(SESSION_PREFIX)), SESSION_NEW], 'new');
    }).catch((error) => {
      pendingProtocols = false;
      if (closed) return;
      protocolsFailed(error);
    });
  }

  function protocolsFailed(error) {
    // 日志只记原因，不记子协议（里面有证明或票据）
    say('session.error', { stage: 'protocols', message: String(error?.message ?? error) });
    newSessionFailed({ code: 0, reason: 'protocols' });
  }

  /** 建新会话没成：告诉调用方；`renew: false` 时就此关掉，否则退避再建 */
  function newSessionFailed(info) {
    emit(connectFailHandlers, info, 'connect-fail');
    if (closed) return;
    if (!renew) {
      shutdown();
      return;
    }
    scheduleRetry();
  }

  /**
   * HT-b 的接口位置：WebSocket 握手失败后转哪种传输（第 4.3 节第 3 条）。HT-a 不接 HTTP 长轮询，永远回 null，
   * 下一次仍从 WebSocket 开始；`mode === 'ws'`（强制）时本来也不降级。
   */
  function fallbackAfter(/* rec, reason */) {
    if (mode === 'ws') return null;
    return null;
  }

  function dial(list, kind) {
    if (closed) return;
    const rec = { socket: null, kind, stage: 'connecting', ended: false, dropping: false, welcomeTimer: null, probeTimer: null, probeSent: false, probeSwallowed: false };
    cur = rec;
    let socket;
    try {
      socket = new WebSocketImpl(wsUrl, list);
    } catch (error) {
      say('session.error', { stage: 'construct', message: String(error?.message ?? error) });
      onSocketGone(rec, 1006, 'construct');
      return;
    }
    rec.socket = socket;
    listen(socket, 'open', () => onSocketOpen(rec));
    listen(socket, 'message', (event) => onSocketMessage(rec, event));
    listen(socket, 'error', (event) => {
      // 握手失败时 Node 的实现可能只有 error、没有 close（2026-09-27 云端实测）：error 就当这条传输没了
      if (rec.ended) return;
      say('session.transport-error', { stage: rec.stage, message: String(event?.message ?? event?.error?.message ?? 'error') });
      onSocketGone(rec, 1006, '');
    });
    listen(socket, 'close', (event) => {
      onSocketGone(rec, typeof event?.code === 'number' ? event.code : 1006, typeof event?.reason === 'string' ? event.reason : '');
    });
  }

  function onSocketOpen(rec) {
    if (cur !== rec || rec.ended) return;
    if (closed) {
      try { rec.socket.close(1000, 'closed'); } catch { /* 已经在关 */ }
      return;
    }
    rec.stage = 'open';
    rec.welcomeTimer = setTimer(() => {
      rec.welcomeTimer = null;
      if (cur !== rec || rec.stage !== 'open') return;
      say('session.welcome-timeout', { kind: rec.kind, timeoutMs: welcomeTimeoutMs });
      abortSocket(rec, 1006, 'welcome-timeout');
    }, welcomeTimeoutMs);
    if (rec.kind === 'new' && legacyProbeMs >= 0) {
      rec.probeTimer = setTimer(() => {
        rec.probeTimer = null;
        if (cur !== rec || rec.stage !== 'open') return;
        rec.probeSent = rawSend(rec, { type: 'session.ack', ack: 0 });
      }, legacyProbeMs);
    }
  }

  /** 本端放弃这条传输（等 welcome 超时等）：关掉并按传输没了处理 */
  function abortSocket(rec, code, reason) {
    try { rec.socket.close(1000, reason); } catch { /* 已经在关 */ }
    onSocketGone(rec, code, reason);
  }

  function onSocketMessage(rec, event) {
    if (cur !== rec || rec.ended || rec.stage === 'connecting') return;
    const data = event?.data;
    let msg;
    if (typeof data === 'string') {
      try { msg = JSON.parse(data); } catch { msg = undefined; }
    }
    if (!isObj(msg) || typeof msg.type !== 'string') {
      counters.badFrames++;
      return;
    }
    if (rec.stage === 'open') {
      if (msg.type === 'session.welcome') {
        onWelcome(rec, msg);
        return;
      }
      if (rec.kind !== 'new') {
        say('session.bad-welcome', { kind: rec.kind, type: msg.type.slice(0, 40) });
        abortSocket(rec, 1006, 'bad-welcome');
        return;
      }
      enterLegacy(rec);
      if (cur !== rec || closed) return;
    }
    counters.received++;
    const s = sess;
    if (!s) return;
    if (s.legacy) {
      // 探测的回包（旧服务端不认 `session.ack`）不交上层
      if (rec.probeSent && !rec.probeSwallowed && msg.type === 'error' && msg.reqId === undefined && msg.reason === 'unsupported') {
        rec.probeSwallowed = true;
        return;
      }
      emit(messageHandlers, msg, 'message');
      return;
    }
    if (msg.type.startsWith('session.')) {
      if (msg.type === 'session.ack') onPeerAck(msg.ack);
      return;
    }
    if (msg.ack !== undefined && !onPeerAck(msg.ack)) return;
    const seq = msg.seq;
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > s.inAck + 1) {
      say('session.bad-seq', { got: Number.isSafeInteger(seq) ? seq : null, expected: s.inAck + 1 });
      endSession(1002, 'bad-seq', { notify: true });
      return;
    }
    if (seq <= s.inAck) {
      counters.duplicates++;
      return;
    }
    s.inAck = seq;
    noteInbound(s, utf8Length(data));
    const { seq: _seq, ack: _ack, ...body } = msg;
    emit(messageHandlers, body, 'message');
  }

  function enterLegacy(rec) {
    clearRecTimers(rec);
    rec.stage = 'attached';
    attempt = 0;
    sess = { legacy: true, sid: null, retainMs: 0, outSeq: 0, outBuf: [], pendingBytes: 0, inAck: 0, inUnacked: 0, inUnackedBytes: 0, ackTimer: null, detachedAt: null };
    noteOpen();
    say('session.open', { transport: 'ws', legacy: true, protocol: typeof rec.socket.protocol === 'string' ? rec.socket.protocol : null });
    emit(openHandlers, undefined, 'open');
  }

  /** 建成一个会话：计数；回是不是重建 */
  function noteOpen() {
    counters.opens++;
    const renewed = hadSession;
    if (renewed) counters.renews++;
    hadSession = true;
    return renewed;
  }

  function onWelcome(rec, msg) {
    clearRecTimers(rec);
    const sid = msg.sid;
    if (typeof sid !== 'string' || sid === '') {
      say('session.bad-welcome', { kind: rec.kind, reason: 'no-sid' });
      abortSocket(rec, 1006, 'bad-welcome');
      return;
    }
    const retainMs = Number.isFinite(msg.retainMs) && msg.retainMs >= 0 ? msg.retainMs : SESSION_DEFAULTS.retainMs;
    if (rec.kind === 'new') {
      rec.stage = 'attached';
      attempt = 0;
      sess = { legacy: false, sid, retainMs, outSeq: 0, outBuf: [], pendingBytes: 0, inAck: 0, inUnacked: 0, inUnackedBytes: 0, ackTimer: null, detachedAt: null };
      const renewed = noteOpen();
      say('session.open', { transport: 'ws', retainMs, ...(renewed ? { renew: true } : {}) });
      emit(openHandlers, undefined, 'open');
      return;
    }
    const s = sess;
    if (!s || s.legacy || sid !== s.sid) {
      say('session.bad-welcome', { kind: rec.kind, reason: 'sid-mismatch' });
      abortSocket(rec, 1006, 'bad-welcome');
      return;
    }
    rec.stage = 'attached';
    attempt = 0;
    s.retainMs = retainMs;
    if (!onPeerAck(msg.ack ?? 0)) return;
    // 接续项里已带上本端的 ack
    s.inUnacked = 0;
    s.inUnackedBytes = 0;
    clearAckTimer(s);
    const gapMs = s.detachedAt === null ? 0 : now() - s.detachedAt;
    s.detachedAt = null;
    counters.resumes++;
    say('session.resume', { transport: 'ws', gapMs, resend: s.outBuf.length });
    for (const entry of [...s.outBuf]) {
      if (sess !== s || !attached()) break;
      writeEntry(s, entry);
    }
    if (sess !== s) return;
    emit(resumeHandlers, undefined, 'resume');
  }

  // ------------------------------------------------------------------ 确认

  /** 对方的 `ack`：释放已确认的出站；越界按会话已坏结束。回 false = 会话已结束 */
  function onPeerAck(value) {
    const s = sess;
    if (!s) return false;
    if (!Number.isSafeInteger(value) || value < 0 || value > s.outSeq) {
      say('session.bad-ack', { got: Number.isSafeInteger(value) ? value : null, max: s.outSeq });
      endSession(1002, 'bad-seq', { notify: true });
      return false;
    }
    while (s.outBuf.length > 0 && s.outBuf[0].seq <= value) s.pendingBytes -= s.outBuf.shift().bytes;
    if (s.outBuf.length === 0) s.pendingBytes = 0;
    return true;
  }

  /** 收下一条业务消息（`bytes` 是它的原文字节数）：满条数或满字节就立刻确认，否则 `ackDelayMs` 内确认 */
  function noteInbound(s, bytes) {
    s.inUnacked++;
    s.inUnackedBytes += bytes;
    if (s.inUnacked >= ackEvery || s.inUnackedBytes >= ackBytes) {
      sendAck(s);
      return;
    }
    if (s.ackTimer === null) {
      s.ackTimer = setTimer(() => {
        s.ackTimer = null;
        if (sess === s && s.inUnacked > 0) sendAck(s);
      }, ackDelayMs);
      s.ackTimer?.unref?.();
    }
  }

  function sendAck(s) {
    if (sess !== s || !attached()) return;
    if (rawSend(cur, { type: 'session.ack', ack: s.inAck })) {
      s.inUnacked = 0;
      s.inUnackedBytes = 0;
      clearAckTimer(s);
    }
  }

  function writeEntry(s, entry) {
    if (!attached()) return;
    const message = s.inAck > 0 ? { ...entry.body, ack: s.inAck } : entry.body;
    if (rawSend(cur, message) && s.inAck > 0) {
      s.inUnacked = 0;
      s.inUnackedBytes = 0;
      clearAckTimer(s);
    }
  }

  // ------------------------------------------------------------------ 传输没了、会话结束

  function onSocketGone(rec, code, reason) {
    if (rec.ended) return;
    rec.ended = true;
    clearRecTimers(rec);
    if (cur !== rec) return;
    cur = null;
    if (closed) return;
    if (rec.stage !== 'attached') {
      // 这次握手没成
      if (rec.kind === 'resume') {
        if (code === CLOSE_NO_SESSION || code === CLOSE_SESSION_ENDED) {
          // 脱开期间会话因「连着时收到也不会重连」的码结束（例如项目被删）：按原关闭码报，上层与连着时收到一样
          const orig = code === CLOSE_SESSION_ENDED ? closedCodeOf(reason) : null;
          counters.lost++;
          if (orig && FINAL_CLOSE.has(orig.code)) {
            say('session.lost', { code, closedCode: orig.code });
            endSession(orig.code, orig.reason, { notify: false });
            return;
          }
          say('session.lost', { code, closedCode: orig ? orig.code : null });
          endSession(code, reason || (code === CLOSE_NO_SESSION ? 'no-session' : 'session-closed'), { notify: false });
          return;
        }
        say('session.resume-failed', { code });
        scheduleRetry();
        return;
      }
      counters.connectFails++;
      say('session.connect-failed', { code });
      fallbackAfter(rec, 'ws-error');
      newSessionFailed({ code, reason });
      return;
    }
    const s = sess;
    if (!s) return;
    if (s.legacy) {
      endSession(code, reason, { notify: false });
      return;
    }
    if (rec.dropping || TRANSPORT_FAULT.has(code)) {
      s.detachedAt = now();
      counters.detaches++;
      lastDetach = { code, at: s.detachedAt };
      say('session.detach', { code, pendingBytes: s.pendingBytes });
      scheduleRetry();
      return;
    }
    endSession(code, reason, { notify: false });
  }

  /**
   * 结束会话：未确认的丢弃并计数，`notify` 时先发 `session.close` 让服务端立刻结束，关掉当前传输，报 `onClose`；
   * 之后按 `renew` 建新会话或关掉端点。
   */
  function endSession(code, reason, { notify }) {
    const s = sess;
    if (!s) return;
    sess = null;
    clearAckTimer(s);
    counters.dropped += s.outBuf.length;
    s.outBuf = [];
    s.pendingBytes = 0;
    const rec = cur;
    if (rec) {
      cur = null;
      if (notify && !s.legacy && rec.stage === 'attached') rawSend(rec, { type: 'session.close', code, reason });
      rec.ended = true;
      clearRecTimers(rec);
      try { rec.socket.close(1000, String(reason).slice(0, 100)); } catch { /* 已经在关 */ }
    }
    counters.closes++;
    lastClose = { code, reason: String(reason ?? '').slice(0, 120), at: now() };
    say('session.close', { code, reason, legacy: s.legacy });
    emit(closeHandlers, { code, reason }, 'close');
    if (closed) return;
    if (!renew) {
      shutdown();
      return;
    }
    scheduleRetry();
  }

  function scheduleRetry() {
    if (closed || retryTimer !== null || pendingProtocols || cur !== null) return;
    const n = attempt++;
    const delayMs = backoffDelay(n, policy, random);
    say('session.retry', { attempt: n, delayMs, resume: !!(sess && !sess.legacy) });
    retryTimer = setTimer(connect, delayMs);
  }

  /** 端点自己关掉（`renew: false` 的会话结束）：不发 session.close、不再重连 */
  function shutdown() {
    closed = true;
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  // ------------------------------------------------------------------ 对外

  function send(message) {
    if (!isObj(message) || closed || !sess) {
      counters.dropped++;
      return false;
    }
    const s = sess;
    if (s.legacy) {
      if (!attached() || !rawSend(cur, message)) {
        counters.dropped++;
        return false;
      }
      counters.sent++;
      return true;
    }
    const seq = s.outSeq + 1;
    const body = { ...message, seq };
    delete body.ack;
    let text;
    try {
      text = JSON.stringify(body);
    } catch {
      counters.dropped++;
      return false;
    }
    const bytes = utf8Length(text);
    if (s.pendingBytes + bytes > maxPendingBytes) {
      counters.dropped++;
      say('session.backpressure', { pendingBytes: s.pendingBytes, bytes, maxPendingBytes });
      endSession(1013, 'backpressure', { notify: true });
      return false;
    }
    s.outSeq = seq;
    const entry = { seq, body, bytes };
    s.outBuf.push(entry);
    s.pendingBytes += bytes;
    counters.sent++;
    writeEntry(s, entry);
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
    const s = sess;
    const rec = cur;
    cur = null;
    sess = null;
    if (rec) {
      if (s && !s.legacy && rec.stage === 'attached') rawSend(rec, { type: 'session.close', code: 1000, reason: 'closed' });
      rec.ended = true;
      clearRecTimers(rec);
      try { rec.socket.close(1000, 'closed'); } catch { /* 已经在关 */ }
    }
    if (s) {
      clearAckTimer(s);
      counters.dropped += s.outBuf.length;
      counters.closes++;
      lastClose = { code: 1000, reason: 'closed', at: now() };
      say('session.close', { code: 1000, reason: 'closed', legacy: s.legacy });
      emit(closeHandlers, { code: 1000, reason: 'closed' }, 'close');
    }
    say('session.closed');
  }

  /** 开发与测试用：只断当前传输，会话脱开后接续（旧服务端上等于断线）。回有没有断 */
  function dropTransport() {
    const rec = cur;
    if (!rec || rec.stage !== 'attached' || closed) return false;
    rec.dropping = true;
    try { rec.socket.close(1000, 'drop'); } catch { /* 已经在关 */ }
    onSocketGone(rec, 1006, 'drop');
    return true;
  }

  connect();

  return {
    send,
    onMessage(handler) { messageHandlers.push(handler); },
    onOpen(handler) { openHandlers.push(handler); },
    onResume(handler) { resumeHandlers.push(handler); },
    onClose(handler) { closeHandlers.push(handler); },
    onConnectFail(handler) { connectFailHandlers.push(handler); },
    close,
    dropTransport,
    /** 会话在（含脱开中，这时 `send` 进缓冲、接续后补发） */
    get connected() { return !closed && sess !== null; },
    get closed() { return closed; },
    stats() {
      const s = sess;
      return {
        ...counters,
        transport: attached() ? 'ws' : null,
        pendingBytes: s ? s.pendingBytes : 0,
        legacy: !!s?.legacy,
        detached: !!(s && !s.legacy && s.detachedAt !== null),
        lastClose: lastClose ? { ...lastClose } : null,
        lastDetach: lastDetach ? { ...lastDetach } : null,
        mode,
      };
    },
  };
}

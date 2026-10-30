/**
 * 文档服务的第二种传输：HTTP 长轮询（契约 `docs/plan/http-transport-contract.md` 第 6 节），接在会话层（`session.mjs`）下面。
 *
 * **本阶段不接线**（契约文件头「2026-09-27 拆分」：HT-a 只做会话模型与 WebSocket，HTTP 长轮询是 HT-b）：`service.mjs` 不引本文件，
 * 文档服务不答 `/lp/…`。HT-b 接线时，组装层照这样接：
 *   const http = createHttpTransport({ sessions, authenticate, canOpen, remoteOf, normalizePrincipal, … });
 *   独立模式的 HTTP 处理里先 `if (http.handle(req, res)) return;`；心跳每轮 `http.sweep()`；关停时 `http.shutdown()`。
 * 挂载模式（vite 里的本地文档服务）不接（语义「内嵌模式」）。
 *
 * 给出口只放行 443 HTTPS、不支持 WebSocket 升级的节点用。会话、序号、确认、保留、补发都在会话层，本文件只搬运：
 * - `POST /lp/open`：请求头 `X-Promptcut-Protocols` 就是 WebSocket 的子协议列表，含会话项（第 4.1 节）；可选 `X-Promptcut-Fallback`
 *   （降级原因，第 4.3 节第 5 条）。新会话把列表当作 `sec-websocket-protocol` 交给**同一个** `authenticate(req)`（证明、票据、
 *   本机声明、限速、回环信任全照旧；`req.socket` 仍是真实 socket）；接续只按会话号查，不再鉴权。回包带会话号与 welcome 的字段；
 * - `POST /lp/send`：`Authorization: Bearer <sid>`，体 `{ frames: ["<带 seq 的消息文本>", …] }`，逐帧交会话层（按 seq 去重、跳号 1002）；
 *   同一会话同一时刻只一个 POST 在途（再来的回 409 `busy`）；回服务端已收全的 `ack`；
 * - `GET /lp/recv?ack=&wait=`：先按 `ack` 释放，再回还没被确认的帧（纯文本，带 seq；一次最多 1 MiB）；没有就挂着
 *   （一个会话只一个挂起的 GET，新的替换旧的，旧的回 `superseded: true`）；会话结束时先回完剩下的帧、再带 `closed`；
 * - `POST /lp/close`：客户端主动结束会话。
 *
 * 传输断开（第 6.5 节）：`waitMs + 15 s` 内既没有挂着的 GET、也没来过请求，`sweep()` 判这条传输断开，会话脱开、进保留期
 * （不再是第 1 版的「过期即断线」）；墓碑只在会话结束时由会话层立。
 * `sid` 与请求头里的凭证不进日志、不进 URL。只引 Node 内置模块与同目录的 `session.mjs`。
 */
import { parseSessionItem } from './session.mjs';

export const HTTP_TRANSPORT_DEFAULTS = Object.freeze({
  /** 挂起的 GET 最多等多久（客户端的 `wait` 与它取小） */
  WAIT_MS: 25_000,
  /** `waitMs` 的上限：常见代理与负载均衡的空闲超时是 30～60 s */
  MAX_WAIT_MS: 30_000,
  /** 既没有挂着的 GET、也没来过请求，过了 `waitMs` 再加这么久，算传输断开（第 6.5 节） */
  IDLE_SLACK_MS: 15_000,
  /** 会话结束后，还没来取剩余帧与 `closed` 的传输留多久 */
  CLOSED_KEEP_MS: 120_000,
  /** 一次 POST /lp/send 的请求体比单帧上限多出的余量 */
  BODY_SLACK_BYTES: 64 * 1024,
  /** 一次 GET 回包里帧的总字节数上限（至少一帧） */
  RECV_MAX_BYTES: 1024 * 1024,
  /** open / close 的请求体上限（本来就只是空或很小的 JSON） */
  SMALL_BODY_BYTES: 4096,
});

export const PROTOCOLS_HEADER = 'x-promptcut-protocols';
export const FALLBACK_HEADER = 'x-promptcut-fallback';
/** 降级原因（第 4.3 节第 5 条）；别的值不记 */
export const FALLBACK_REASONS = Object.freeze(['ws-error', 'ws-timeout', 'ws-closed']);

const JSON_TYPE = 'application/json; charset=utf-8';
const CORS_METHODS = 'GET, POST, OPTIONS';
const CORS_HEADERS = 'Authorization, Content-Type, X-Promptcut-Protocols, X-Promptcut-Fallback';
const CORS_MAX_AGE = '600';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byteLen = (text) => Buffer.byteLength(text, 'utf8');
const positive = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/** 请求头里的子协议列表（逗号分隔、去空白、去空项；多个同名头拼起来） */
function protocolList(raw) {
  if (raw === undefined) return [];
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  return text.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** `Authorization: Bearer <sid>` 里的 sid；没有或格式不对回 null */
function bearerOf(req) {
  const m = /^Bearer[ \t]+([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization ?? '').trim());
  return m ? m[1] : null;
}

function fallbackOf(req) {
  const v = String(req.headers[FALLBACK_HEADER] ?? '').trim();
  return FALLBACK_REASONS.includes(v) ? v : null;
}

/**
 * 读请求体，最多 `limit` 字节。超了回 `{ tooLarge: true }`（剩下的字节丢弃，不再累积）。
 * 客户端中途断开回 `{ aborted: true }`。
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve({ tooLarge: true });
      return;
    }
    const chunks = [];
    let size = 0;
    let over = false;
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        settle({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(over ? { tooLarge: true } : { text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => settle({ aborted: true }));
    req.on('aborted', () => settle({ aborted: true }));
  });
}

/**
 * @param {object} options
 * @param {ReturnType<import('./session.mjs').createSessionLayer>} options.sessions 会话层
 * @param {(req: object) => object | null} options.authenticate 与 WebSocket 握手同一个
 * @param {() => null | 'closing' | 'full'} [options.canOpen] 能不能建新会话（关停中、会话数满），缺省总能
 * @param {(req: object) => string | null} [options.remoteOf] 来源地址，缺省 socket 对端
 * @param {(principal: object) => object} [options.normalizePrincipal] 规整鉴权给的 principal（组装层的同名函数），缺省原样
 * @param {string} [options.prefix] 基址的路径部分（不带结尾斜杠；根路径是空串）。端点是 `<prefix>/lp/<名>`
 * @param {string} [options.protocol] 列表里必须有它，而且是第一项；缺省 `promptcut.v1`
 * @param {number} [options.retainMs] 回包里的 `retainMs`（与会话层同一个值）
 * @param {number} [options.maxFrameBytes] 单帧上限（= WebSocket 的 `maxPayload`）
 * @param {number} [options.waitMs]
 * @param {string[]} [options.corsOrigins] 允许跨源的 Origin，缺省空：不回任何 CORS 头
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function createHttpTransport({
  sessions,
  authenticate,
  admissionRefusal = () => false,
  completeAdmission = () => {},
  principalOf = () => null,
  dispatchInvocation = (_input, next) => next(),
  needsInvocation = () => false,
  internalTransport = () => false,
  transportConnected,
  canOpen = () => null,
  remoteOf = (req) => req?.socket?.remoteAddress ?? null,
  normalizePrincipal = (p) => p,
  prefix = '',
  protocol = 'promptcut.v1',
  retainMs = 60_000,
  maxFrameBytes = 1024 * 1024,
  waitMs,
  corsOrigins = [],
  now = Date.now,
  log = () => {},
} = /** @type {any} */ ({})) {
  if (!sessions || typeof sessions.openSession !== 'function') throw new TypeError('createHttpTransport: 要给会话层 sessions');
  if (typeof authenticate !== 'function') throw new TypeError('createHttpTransport: authenticate 必须是函数');
  const base = String(prefix).replace(/\/+$/, '');
  const lpRoot = `${base}/lp/`;
  const waitCap = Math.min(positive(waitMs, HTTP_TRANSPORT_DEFAULTS.WAIT_MS), HTTP_TRANSPORT_DEFAULTS.MAX_WAIT_MS);
  const idleMs = waitCap + HTTP_TRANSPORT_DEFAULTS.IDLE_SLACK_MS;
  const maxFrame = positive(maxFrameBytes, 1024 * 1024);
  const maxSendBody = maxFrame + HTTP_TRANSPORT_DEFAULTS.BODY_SLACK_BYTES;
  const corsSet = new Set(Array.isArray(corsOrigins) ? corsOrigins.filter((o) => typeof o === 'string' && o !== '') : []);
  const say = (event, fields) => { try { log(event, fields); } catch { /* 日志出错不影响传输 */ } };

  /** sid → 本传输的传输对象（最近一次经 HTTP 接上的；会话结束后留到剩余帧被取走） */
  const bySid = new Map();
  // Active request/response pairs, including superseded transports. finish does
  // not remove an owner: both actual close events must have happened.
  const ownedRequests = new Set();
  // A response close can follow finish while its keep-alive TCP socket remains
  // open. Keep each associated socket until the actual socket close event.
  const ownedSockets = new Set();
  const fencedConns = new Set();
  const counters = { superseded: 0 };
  let shuttingDown = false;

  function track(t, req, res) {
    const record = { t, req, res, socket: req.socket };
    const closed = target => target?.closed === true;
    const actualClose = target => closed(target) ? Promise.resolve() : new Promise(resolve => target.once('close', resolve));
    record.done = Promise.all([actualClose(req), actualClose(res)]);
    ownedRequests.add(record);
    record.done.then(() => ownedRequests.delete(record));
    if (req.socket && ![...ownedSockets].some(owner => owner.t === t && owner.socket === req.socket)) {
      const owner = { t, socket: req.socket, done: actualClose(req.socket) };
      ownedSockets.add(owner);
      owner.done.then(() => ownedSockets.delete(owner));
    }
    if (fencedConns.has(t.connId)) {
      t.fenced = true; t.closed = { code: 4003, reason: 'access-revoked' }; t.rest = []; t.dead = true;
      if (bySid.get(t.sid) === t) bySid.delete(t.sid);
      res.destroy(); req.destroy(); req.socket?.destroy();
    }
  }

  // ---------- 回包 ----------

  function corsFor(req) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !corsSet.has(origin)) return null;
    return { 'access-control-allow-origin': origin, vary: 'Origin' };
  }

  function sendJson(res, status, body, cors) {
    if (res.headersSent || res.writableEnded) return;
    const headers = { 'content-type': JSON_TYPE, 'cache-control': 'no-store', ...(cors ?? {}) };
    if (shuttingDown) headers.connection = 'close';
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  // ---------- 传输对象 ----------

  /**
   * 一条 HTTP 传输（一次 `open` 接上的）。会话层看到的形状：`kind`、`send`、`control`、`close`。
   * - `send`：有新帧，叫醒挂着的 GET（帧由 GET 向会话层 `pull`，所以这里不存帧）；
   * - `control`：不用（welcome 在 open 的回包里，确认在 send 的回包里）；
   * - `close(code, reason, rest)`：4009 是被别的传输替换（挂着的 GET 回 `superseded`）；别的码是会话结束，
   *   记下 `closed` 与剩下的帧，挂着的 GET 立刻回。
   */
  function newTransport(sid) {
    const t = {
      kind: 'http',
      sid,
      connId: null,
      waiter: null,
      wakeQueued: false,
      /** 会话结束：{ code, reason }；剩下的帧在 `rest` */
      closed: null,
      rest: [],
      closedAt: 0,
      superseded: false,
      /** 已判断开（sweep）或被替换：之后的请求不再算这条传输的 */
      dead: false,
      sending: false,
      lastSeen: now(),
      send() { wake(t); },
      control() {},
      close(code, reason, rest) {
        if (code === 4009) {
          t.superseded = true;
          t.dead = true;
          const w = clearWaiter(t);
          if (w) {
            counters.superseded += 1;
            sendJson(w.res, 200, { ok: true, frames: [], closed: null, superseded: true }, w.cors);
          }
          return;
        }
        t.closed = { code, reason };
        t.rest = Array.isArray(rest) ? rest : [];
        t.closedAt = now();
        wake(t, true);
      },
    };
    return t;
  }

  function clearWaiter(t) {
    const w = t.waiter;
    if (!w) return null;
    t.waiter = null;
    clearTimeout(w.timer);
    return w;
  }

  /** 立即回一次 recv：会话还开着就向会话层取帧；已结束就回剩下的帧，都回完了带 `closed` 并忘掉这条传输 */
  function respondRecv(t, res, cors, lease) {
    if (lease) return Promise.resolve().then(() => lease.check()).then(() => {
      if (t.fenced || t.dead || t.superseded || !t.closed && !sessions.isCurrent(t.connId, t))
        throw Object.assign(Error('superseded'), { status: 409, code: 'superseded' });
      return respondRecv(t, res, cors);
    }).catch(error => sendJson(res, error?.status ?? 503,
      { ok: false, error: error?.code ?? 'instance-invocation-forbidden' }, cors));
    t.lastSeen = now();
    if (t.closed) {
      const frames = [];
      let size = 0;
      while (t.rest.length > 0) {
        const bytes = byteLen(t.rest[0]);
        if (frames.length > 0 && size + bytes > HTTP_TRANSPORT_DEFAULTS.RECV_MAX_BYTES) break;
        frames.push(t.rest.shift());
        size += bytes;
      }
      const done = t.rest.length === 0;
      sendJson(res, 200, { ok: true, frames, closed: done ? t.closed : null }, cors);
      if (done && bySid.get(t.sid) === t) bySid.delete(t.sid);
      return;
    }
    const frames = sessions.pull(t.connId, HTTP_TRANSPORT_DEFAULTS.RECV_MAX_BYTES);
    sendJson(res, 200, { ok: true, frames, closed: null }, cors);
  }

  /** 有新帧或会话结束了：叫醒挂着的 GET。同一轮里连写几条时攒成一次回包 */
  function wake(t, immediate = false) {
    if (!t.waiter) return;
    if (immediate) {
      const w = clearWaiter(t);
      respondRecv(t, w.res, w.cors, w.lease);
      return;
    }
    if (t.wakeQueued) return;
    t.wakeQueued = true;
    setImmediate(() => {
      t.wakeQueued = false;
      const w = clearWaiter(t);
      if (w) respondRecv(t, w.res, w.cors, w.lease);
    });
  }

  /**
   * 按 `Authorization` 找这条会话的 HTTP 传输；找不到时已经回了 404 / 410 / 409，返回 null。
   * 会话已被别的传输接走（例如客户端改走了 WebSocket）回 409 `superseded`。
   */
  function transportOf(req, res, cors) {
    const sid = bearerOf(req);
    const t = sid ? bySid.get(sid) : undefined;
    if (t && !t.superseded) return t;
    if (t?.superseded) {
      sendJson(res, 409, { ok: false, error: 'superseded' }, cors);
      return null;
    }
    const tomb = sid ? sessions.tombOf(sid) : null;
    if (tomb) {
      sendJson(res, 410, { ok: false, error: 'session-closed', code: tomb.code, reason: tomb.reason }, cors);
      return null;
    }
    if (sid && sessions.connIdOf(sid)) {
      // 会话在，但挂着的不是 HTTP：要先经 open 接续
      sendJson(res, 409, { ok: false, error: 'superseded' }, cors);
      return null;
    }
    sendJson(res, 404, { ok: false, error: 'no-session' }, cors);
    return null;
  }

  /** 会话结束之后还拿着这条传输来发、来关：回 410 */
  function closedReply(t, res, cors) {
    sendJson(res, 410, { ok: false, error: 'session-closed', code: t.closed.code, reason: t.closed.reason }, cors);
  }

  // ---------- 端点 ----------

  const openReply = (welcome) => ({
    ok: true,
    sid: welcome.sid,
    resumed: welcome.resumed,
    ack: welcome.ack,
    retainMs: welcome.retainMs ?? retainMs,
    waitMs: waitCap,
    maxFrameBytes: maxFrame,
    protocol,
    transport: 'http',
    ...(welcome.connId ? { connId: welcome.connId } : {}),
  });

  function invoke(t, req, res, cors, kind, bodyText, next, extra = {}) {
    if (!needsInvocation(t.principal, req)) return next();
    return Promise.resolve().then(() => dispatchInvocation({ connId: t.connId, principal: t.principal,
      kind, bodyText, ...extra, transport: { kind: 'http', req, res, socket: req.socket,
        internal: internalTransport(req) } }, next)).catch(error => {
      sendJson(res, error?.status ?? 503, { ok: false, error: error?.code ?? 'instance-invocation-forbidden' }, cors);
      throw error;
    });
  }

  // Only Agent instance dispatch is asynchronous. Recheck the exact transport
  // after that await before mutating a session which may have been resumed.
  function requireCurrentInvocation(t) {
    if (needsInvocation(t.principal) && (t.fenced || t.dead || t.superseded || !sessions.isCurrent(t.connId, t)))
      throw Object.assign(Error('superseded'), { status: 409, code: 'superseded' });
  }

  async function onOpen(req, res, cors) {
    if (canOpen() === 'closing') return sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
    const offered = protocolList(req.headers[PROTOCOLS_HEADER]);
    if (offered.length === 0 || offered[0] !== protocol) return sendJson(res, 400, { ok: false, error: 'bad-protocols' }, cors);
    const item = parseSessionItem(offered, protocol);
    // 长轮询没有旧客户端：列表里必须有会话项
    if (item.kind === 'bad' || item.kind === 'legacy') return sendJson(res, 400, { ok: false, error: 'bad-protocols' }, cors);
    const body = await readBody(req, HTTP_TRANSPORT_DEFAULTS.SMALL_BODY_BYTES);
    if (body.aborted) return undefined;
    if (body.tooLarge) return sendJson(res, 413, { ok: false, error: 'too-large' }, cors);
    const fallback = fallbackOf(req);

    if (item.kind === 'resume') {
      // 接续项在鉴权之前按 sid 查（第 14 节「open 的判定顺序」另加的一条）
      if (canOpen() === 'closing') return sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
      const t = newTransport(item.sid);
      t.isUsable = () => !shuttingDown && !res.destroyed && !res.writableEnded && !req.aborted;
      t.connId = sessions.connIdOf(item.sid);
      t.principal = principalOf(t.connId);
      if (t.connId) track(t, req, res);
      const r = await invoke(t, req, res, cors, 'resume', body.text,
        () => sessions.resume({ sid: item.sid, ack: item.ack, transport: t, fallback }),
        { sessionItem: { sid: item.sid, ack: item.ack } });
      if (!r.ok) {
        if (r.status === 404) return sendJson(res, 404, { ok: false, error: 'no-session' }, cors);
        if (r.status === 503) return sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
        return sendJson(res, 410, { ok: false, error: 'session-closed', code: r.closedCode ?? r.code, reason: r.closedReason ?? r.reason }, cors);
      }
      t.connId = r.connId;
      t.principal = principalOf(r.connId);
      const old = bySid.get(item.sid);
      if (old && old !== t) old.dead = true;
      bySid.set(item.sid, t);
      if (!ownedRequests.size || ![...ownedRequests].some(record => record.req === req && record.res === res)) track(t, req, res);
      return sendJson(res, 200, openReply(r.welcome), cors);
    }

    // 读请求体期间可能开始关停或会话数满了
    if (canOpen() !== null) return sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
    // 同一个请求对象，只把子协议列表放进 WebSocket 握手的那个头；socket、url、其余头都不变
    const headers = { ...req.headers, 'sec-websocket-protocol': offered.join(', ') };
    const authReq = Object.create(req, { headers: { value: headers, enumerable: true, writable: true, configurable: true },
      transportBodyText: { value: body.text }, transportProtocolHeaders: { value: req.headers } });
    let principal;
    try {
    try { principal = await authenticate(authReq); }
    catch (error) {
      return sendJson(res, error?.status === 503 ? 503 : 401,
        { ok: false, error: error?.status === 503 ? 'unavailable' : 'unauthorized' }, cors);
    }
    if (!principal || typeof principal.userId !== 'string') return sendJson(res, 401, { ok: false, error: 'unauthorized' }, cors);
    if (admissionRefusal(principal)) return sendJson(res, 401, { ok: false, error: 'unauthorized' }, cors);
    // No await between this check and openSession: a peer finishing auth meanwhile
    // cannot consume the last slot behind our back.
    if (canOpen() !== null || res.destroyed || res.writableEnded || req.aborted)
      return sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
    let remote = null;
    try {
      remote = remoteOf(authReq) ?? req.socket?.remoteAddress ?? null;
    } catch {
      remote = req.socket?.remoteAddress ?? null;
    }
    const t = newTransport(null);
    t.principal = normalizePrincipal(principal);
    let opened;
    try {
      opened = sessions.openSession({ principal: normalizePrincipal(principal), remote, transport: t, fallback });
    } catch (err) {
      say('http.error', { stage: 'open', message: String(err?.message ?? err) });
      return sendJson(res, 500, { ok: false, error: 'internal' }, cors);
    }
    t.sid = opened.sid;
    t.connId = opened.connId;
    transportConnected?.({ connId: t.connId, principal: t.principal, req });
    bySid.set(opened.sid, t);
    track(t, req, res);
    return sendJson(res, 200, openReply(opened.welcome), cors);
    } finally { completeAdmission(authReq); }
  }

  async function onSend(req, res, cors) {
    const t = transportOf(req, res, cors);
    if (!t) return undefined;
    const scoped = needsInvocation(t.principal, req);
    if (!scoped) { track(t, req, res); t.lastSeen = now(); }
    if (!scoped && t.closed) { req.resume(); return closedReply(t, res, cors); }
    if (!scoped && t.sending) { req.resume(); return sendJson(res, 409, { ok: false, error: 'busy' }, cors); }
    if (!scoped) t.sending = true;
    try {
      const body = await readBody(req, maxSendBody);
      if (body.aborted) return undefined;
      if (!scoped) t.lastSeen = now();
      if (body.tooLarge) {
        sendJson(res, 413, { ok: false, error: 'too-large' }, cors);
        // A SID locates a session; unverified input cannot close an Agent session.
        if (!scoped) sessions.close(t.connId, 1009, 'too-large');
        return undefined;
      }
      if (!scoped && t.closed) return closedReply(t, res, cors);
      let msg;
      try { msg = JSON.parse(body.text); } catch { msg = null; }
      if (!isObj(msg) || !Array.isArray(msg.frames) || msg.frames.some(f => typeof f !== 'string'))
        return sendJson(res, 400, { ok: false, error: 'bad-request' }, cors);
      if (msg.frames.some(f => byteLen(f) > maxFrame)) {
        sendJson(res, 413, { ok: false, error: 'too-large' }, cors);
        if (!scoped) sessions.close(t.connId, 1009, 'too-large');
        return undefined;
      }
      if (scoped && msg.frames.length === 0) return sendJson(res, 400, { ok: false, error: 'empty-frames' }, cors);
      if (scoped) return await invoke(t, req, res, cors, 'message', body.text, async firstFrame => {
        requireCurrentInvocation(t);
        if (t.sending) return sendJson(res, 409, { ok: false, error: 'busy' }, cors);
        // Complete input and its first proof are verified before claiming a
        // session slot, idle clock or resource lease. Partial input owns itself.
        track(t, req, res); t.lastSeen = now(); t.sending = true;
        try {
          await sessions.receive(t.connId, firstFrame);
          for (let frameIndex = 1; frameIndex < msg.frames.length; frameIndex++) {
            requireCurrentInvocation(t);
            await invoke(t, req, res, cors, 'message', body.text, frame => {
              requireCurrentInvocation(t); return sessions.receive(t.connId, frame);
            }, { text: msg.frames[frameIndex], frameIndex, frameCount: msg.frames.length });
          }
          requireCurrentInvocation(t);
          return sendJson(res, 200, { ok: true, ack: sessions.takeAck(t.connId) }, cors);
        } finally { t.sending = false; }
      }, { text: msg.frames[0], frameIndex: 0, frameCount: msg.frames.length });
      for (const text of msg.frames) {
        if (t.closed || !sessions.isCurrent(t.connId, t)) break;
        sessions.receive(t.connId, text);
      }
      if (t.closed) return closedReply(t, res, cors);
      return sendJson(res, 200, { ok: true, ack: sessions.takeAck(t.connId) }, cors);
    } finally { if (!scoped) t.sending = false; }
  }
  function onRecv(req, res, cors, url) {
    const t = transportOf(req, res, cors);
    if (!t) return;
    if (needsInvocation(t.principal, req)) return invoke(t, req, res, cors, 'recv', '', (_frame, check) => {
      if (typeof check !== 'function') throw Object.assign(Error('instance-read-lease-required'),
        { status: 503, code: 'instance-read-lease-required' });
      requireCurrentInvocation(t); track(t, req, res);
      return receiveAllowed(t, req, res, cors, url, { check });
    });
    track(t, req, res);
    return receiveAllowed(t, req, res, cors, url);
  }

  function receiveAllowed(t, req, res, cors, url, lease) {
    // This runs after signature/current-run checks, before ACK or waiter changes.
    requireCurrentInvocation(t);
    // A signed read invocation stays live until this response actually finishes
    // or closes. Its fresh check is used again immediately before pulling bytes.
    const replied = lease ? new Promise(resolve => { res.once('finish', resolve); res.once('close', resolve); }) : undefined;
    t.lastSeen = now();
    const rawWait = Number(url.searchParams.get('wait') ?? waitCap);
    const wait = Number.isFinite(rawWait) && rawWait >= 0 ? Math.min(rawWait, waitCap) : waitCap;

    // 新的 GET 替换旧的（客户端超时重连后旧请求可能还挂在这里）
    const old = clearWaiter(t);
    if (old) {
      counters.superseded += 1;
      sendJson(old.res, 200, { ok: true, frames: [], closed: null, superseded: true }, old.cors);
    }

    if (!t.closed) {
      const ack = Number(url.searchParams.get('ack') ?? 0);
      const last = sessions.lastSeq(t.connId);
      if (!Number.isSafeInteger(ack) || ack < 0 || ack > last) {
        // 越界的 ack：会话已坏（第 3.5 节），会话层以 1002 结束它
        sessions.ack(t.connId, ack);
        sendJson(res, 400, { ok: false, error: 'bad-ack', last }, cors);
        return replied;
      }
      sessions.ack(t.connId, ack);
    }

    if (t.closed || wait === 0 || sessions.hasPending(t.connId)) {
      respondRecv(t, res, cors, lease);
      return replied;
    }
    const w = { res, cors, timer: null, lease };
    w.timer = setTimeout(() => {
      if (t.waiter !== w) return;
      t.waiter = null;
      respondRecv(t, res, cors, lease);
    }, wait);
    w.timer.unref?.();
    t.waiter = w;
    res.on('close', () => {
      if (t.waiter !== w) return;
      clearWaiter(t);
      t.lastSeen = now();
    });
    return replied;
  }

  async function onClose(req, res, cors) {
    const t = transportOf(req, res, cors);
    if (!t) return undefined;
    const scoped = needsInvocation(t.principal, req);
    const body = await readBody(req, HTTP_TRANSPORT_DEFAULTS.SMALL_BODY_BYTES);
    if (body.aborted) return undefined;
    if (body.tooLarge) return sendJson(res, 413, { ok: false, error: 'too-large' }, cors);
    if (scoped && body.text.length === 0) return sendJson(res, 400, { ok: false, error: 'bad-request' }, cors);
    let msg = null;
    if (body.text) {
      try { msg = JSON.parse(body.text); } catch { msg = null; }
    }
    if (!scoped) track(t, req, res);
    return invoke(t, req, res, cors, 'close', body.text, () => {
      requireCurrentInvocation(t);
      if (needsInvocation(t.principal, req)) track(t, req, res);
      if (!t.closed) sessions.end(t.connId, isObj(msg) ? msg.code : undefined, isObj(msg) ? msg.reason : '');
      // 客户端自己关的：剩下的帧它不要了
      if (bySid.get(t.sid) === t) bySid.delete(t.sid);
      sendJson(res, 200, { ok: true }, cors);
      return undefined;
    });
  }

  /**
   * 处理一个 HTTP 请求。是 `<prefix>/lp/…` 的就接手并回 true，别的回 false、什么都不动。
   */
  function handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    if (!url.pathname.startsWith(lpRoot)) return false;
    const cors = corsFor(req);
    const name = url.pathname.slice(lpRoot.length);
    if (req.method === 'OPTIONS') {
      // 预检不做任何会话操作；名单为空（或 Origin 不在名单里）时不回任何 CORS 头
      const headers = { 'cache-control': 'no-store', ...(cors ?? {}) };
      if (cors) {
        headers['access-control-allow-methods'] = CORS_METHODS;
        headers['access-control-allow-headers'] = CORS_HEADERS;
        headers['access-control-max-age'] = CORS_MAX_AGE;
      }
      res.writeHead(204, headers);
      res.end();
      return true;
    }
    const routes = { open: 'POST', send: 'POST', recv: 'GET', close: 'POST' };
    if (!Object.hasOwn(routes, name)) {
      sendJson(res, 404, { ok: false, error: 'not-found' }, cors);
      return true;
    }
    if (req.method !== routes[name]) {
      sendJson(res, 405, { ok: false, error: 'method' }, cors);
      return true;
    }
    if (shuttingDown && name === 'open') {
      sendJson(res, 503, { ok: false, error: 'unavailable' }, cors);
      return true;
    }
    const fail = (err) => {
      say('http.error', { stage: name, message: String(err?.message ?? err) });
      sendJson(res, 500, { ok: false, error: 'internal' }, cors);
    };
    try {
      let r;
      if (name === 'open') r = onOpen(req, res, cors);
      else if (name === 'send') r = onSend(req, res, cors);
      else if (name === 'recv') r = onRecv(req, res, cors, url);
      else r = onClose(req, res, cors);
      if (r && typeof r.then === 'function') r.then(undefined, fail);
    } catch (err) {
      fail(err);
    }
    return true;
  }

  return {
    handle,
    connectionIdsMatching(predicate) {
      return [...new Set([...bySid.values(), ...[...ownedRequests].map(record => record.t), ...[...ownedSockets].map(owner => owner.t)]
        .filter(t => predicate(t.principal)).map(t => t.connId))];
    },

    /** Dedicated revocation never serves ordinary close's remaining frames. */
    async fenceConn(connId, code = 4003, reason = 'access-revoked') {
      fencedConns.add(connId);
      const records = [...ownedRequests].filter(record => record.t.connId === connId);
      const socketOwners = [...ownedSockets].filter(owner => owner.t.connId === connId);
      const transports = new Set([...bySid.values(), ...records.map(record => record.t), ...socketOwners.map(owner => owner.t)]);
      for (const t of transports) {
        if (t.connId !== connId) continue;
        t.closed = { code, reason }; t.fenced = true; t.rest = []; t.dead = true;
        clearWaiter(t);
        if (bySid.get(t.sid) === t) bySid.delete(t.sid);
      }
      const sockets = new Set([...records.map(record => record.socket), ...socketOwners.map(owner => owner.socket)].filter(Boolean));
      const actualSockets = [...sockets].map(socket => socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve)));
      for (const record of records) { record.res.destroy(); record.req.destroy(); }
      for (const socket of sockets) socket.destroy();
      await Promise.all([...records.map(record => record.done), ...actualSockets]);
      return { actualClosed: true, closedHttp: records.length };
    },

    /**
     * 组装层的心跳每轮调：`waitMs + 15 s` 内既没有挂着的 GET、也没来过请求的传输判断开，会话脱开（会话层进保留期）；
     * 会话已结束而客户端一直不来取剩余帧的，过一阵忘掉。
     */
    sweep() {
      const t0 = now();
      for (const [sid, t] of [...bySid]) {
        if (t.closed) {
          if (!t.waiter && t0 - t.closedAt >= HTTP_TRANSPORT_DEFAULTS.CLOSED_KEEP_MS) bySid.delete(sid);
          continue;
        }
        if (t.dead) {
          bySid.delete(sid);
          continue;
        }
        if (t.waiter || t.sending || t0 - t.lastSeen < idleMs) continue;
        t.dead = true;
        bySid.delete(sid);
        sessions.transportClosed(t.connId, t, { why: 'http-idle' });
      }
    },

    /** 关停：不再建会话；挂着的 GET 由会话层结束会话时回 `closed`（组装层先 `sessions.closeAll`） */
    shutdown() {
      shuttingDown = true;
    },

    /** 诊断：HTTP 上挂着的传输数与被替换的 GET 数（会话的统计在会话层） */
    stats() {
      return { transports: [...bySid.values()].filter((t) => !t.closed && !t.dead).length, superseded: counters.superseded };
    },
  };
}

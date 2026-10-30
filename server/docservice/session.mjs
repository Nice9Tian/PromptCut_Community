/**
 * 文档服务的会话层（组装层的一部分，契约 `docs/plan/http-transport-contract.md` 第 3、4、5、7、8 节与第 16 节）。
 *
 * 语义见 `docs/semantics/product/document-service.md` 与 `docs/semantics/mechanism/document-service.md` 的「会话与传输」：
 * 文档服务与每一方之间是一个会话，会话内的消息双向有序、带序号，接收方确认；传输（WebSocket、HTTP 长轮询）只是搬运方式，
 * 单次传输中断不结束会话，超过保留时限才算断线。
 *
 * 核心（`router.mjs`）只看见一条连接（`connId`）：会话建立时 `router.connect`，会话结束时 `router.disconnect`；
 * 传输的断开与接续都不经过核心，模块感觉不到。核心的四个钩子接到这里（第 7 节）：
 * - `write(connId, text)`：补上 `seq`、`ack`，放进未确认缓冲；挂着传输就写出去，脱开时只留着；
 * - `buffered(connId)`：未确认的字节数（已交给套接字的也算），所以客户端不确认时积压一直涨，涨过上限核心以 1013 结束会话；
 * - `close(connId, code, reason)`：结束会话（不保留），关掉当前传输；`router.disconnect` 与 `conn.close` 推迟到下一轮事件循环；
 * - `router.drained(connId)`：对方的 `ack` 推进、未确认字节下降后调一次。
 *
 * 旧客户端（握手里不带会话项，第 3.6 节）也登记在这里，标 `legacy`：消息不加 `seq` / `ack`、原样交给核心，
 * 积压按套接字算，传输一断会话就结束（保留时限相当于 0），与会话层出现之前的行为相同。
 *
 * 传输对象由组装层（WebSocket，`service.mjs`）或长轮询（`http-transport.mjs`，HT-b 接线）建，形状：
 * `{ kind: 'ws' | 'http', send(wireText), control(obj), close(code, reason), bufferedAmount? }`。
 * - `send`：一条带 `seq` 的业务消息（WebSocket 立即写；长轮询只叫醒挂着的 GET，帧由 `pull` 取）；
 * - `control`：会话控制消息（`session.welcome`、`session.ack`）。长轮询不用它：欢迎信息在 `POST /lp/open` 的回包里，
 *   确认在 `POST /lp/send` 的回包里。
 *
 * 会话号 `sid` 是 32 字节 CSPRNG 的 base64url，是会话的 bearer 凭证：只在握手请求头与 `session.welcome` 里出现，
 * 不进日志、`describe()`、`/healthz`。只引 Node 内置模块。
 */
import { randomBytes } from 'node:crypto';

export const SESSION_DEFAULTS = Object.freeze({
  /** 传输断开后会话保留多久（第 4.2 节） */
  RETAIN_MS: 60_000,
  /** 结束的会话留墓碑多久：这段时间里拿它接续得 4410（第 4.2 节、第 16 节） */
  TOMBSTONE_MS: 120_000,
  /** 收到的消息里还没确认的满这么多条就单发 `session.ack`（第 3.3 节） */
  ACK_EVERY: 32,
  /** 收到消息后这么久没有顺带确认的机会就单发 `session.ack`（第 3.3 节） */
  ACK_DELAY_MS: 1000,
  /**
   * 收到的、还没确认的字节满这么多也单发（本实现的补充〔裁〕）：对方的未确认缓冲有上限（1 MiB），
   * 大消息连发时只按条数与 1 s 确认，对方可能在 1 s 内就涨过上限而结束会话
   */
  ACK_BYTES: 64 * 1024,
});

/** 会话项（第 4.1 节） */
export const SESSION_ITEM_NEW = 'promptcut.session.new';
export const SESSION_ITEM_PREFIX = 'promptcut.session.';
/** 会话控制消息的类型前缀：核心保留，模块不得认领（第 3.2 节） */
export const SESSION_TYPE_PREFIX = 'session.';

/** 会话层用到的关闭码 */
export const SESSION_CLOSE = Object.freeze({
  /** 跳号、越界的 ack（第 3.5 节） */
  BAD_SEQ: 1002,
  /** 同一会话的新传输接上，旧的关掉（第 3.1 节） */
  SUPERSEDED: 4009,
  /** WebSocket 上接续：会话不存在（第 16 节，对应 HTTP 的 404 `no-session`） */
  NO_SESSION: 4404,
  /** WebSocket 上接续：会话已结束（第 16 节，对应 HTTP 的 410 `session-closed`） */
  SESSION_CLOSED: 4410,
});

/**
 * 传输关闭时带这些码的，结束会话而不是脱开：是这条传输上出了协议错误（`ws.mjs` 的协议错、二进制帧、坏 UTF-8、超长），
 * 接续后重发同一条只会再错一次。
 */
const END_ON_TRANSPORT_CODES = new Set([1002, 1003, 1007, 1009]);

const RESUME_RE = /^promptcut\.session\.([A-Za-z0-9_-]{43})\.(0|[1-9][0-9]{0,15})$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byteLen = (text) => Buffer.byteLength(text, 'utf8');
const positive = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/** 关闭原因截到 123 字节以内（WebSocket 关闭帧的上限） */
export function clipReason(v) {
  if (typeof v !== 'string') return '';
  let s = v;
  while (byteLen(s) > 123) s = s.slice(0, -1);
  return s;
}

/** 客户端给的关闭码：只认 1000 与 3000～4999（应用可用的范围），别的记 1000 */
export function clientCloseCode(v) {
  return Number.isInteger(v) && (v === 1000 || (v >= 3000 && v <= 4999)) ? v : 1000;
}

/**
 * 从握手的子协议列表里认会话项（第 4.1 节）：
 * - `{ kind: 'legacy' }`：没有会话项，旧客户端（第 3.6 节）；
 * - `{ kind: 'new' }`：`promptcut.session.new`，与鉴权项一起给；
 * - `{ kind: 'resume', sid, ack }`：`promptcut.session.<sid>.<ack>`；列表里只能有 `promptcut.v1` 与它（接续项与鉴权项互斥）；
 * - `{ kind: 'bad' }`：会话项不止一个、写法不对、接续项旁边还有别的项、没有 `promptcut.v1`。握手回 400。
 */
export function parseSessionItem(offered, protocol = 'promptcut.v1') {
  const list = Array.isArray(offered) ? offered : [];
  const items = list.filter((p) => p.startsWith(SESSION_ITEM_PREFIX));
  if (items.length === 0) return { kind: 'legacy' };
  if (items.length > 1 || !list.includes(protocol)) return { kind: 'bad' };
  if (items[0] === SESSION_ITEM_NEW) return { kind: 'new' };
  const m = RESUME_RE.exec(items[0]);
  if (!m) return { kind: 'bad' };
  if (list.some((p) => p !== protocol && p !== items[0])) return { kind: 'bad' };
  const ack = Number(m[2]);
  if (!Number.isSafeInteger(ack)) return { kind: 'bad' };
  return { kind: 'resume', sid: m[1], ack };
}

/**
 * 把一条核心写出的消息文本补上 `seq`、`ack`：追加在对象末尾（同名字段以后出现的为准，模块自己写的 `seq` / `ack` 被盖掉）。
 * 核心写出的一律是 `JSON.stringify(对象)`；不是对象文本的原样返回（带不了序号，只可能是调用方的错）。
 */
function withSeq(text, seq, ack) {
  if (text.length < 2 || text[0] !== '{' || text[text.length - 1] !== '}') return text;
  const tail = `"seq":${seq},"ack":${ack}}`;
  return text.length === 2 ? `{${tail}` : `${text.slice(0, -1)},${tail}`;
}

/**
 * @param {object} options
 * @param {object} options.router 核心（`createRouter` 的返回值）；用它的 `connect`、`disconnect`、`dispatch`、`drained`
 * @param {() => string} options.nextConnId 与别的连接同一个编号序列
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {number} [options.retainMs] 缺省 60 000
 * @param {number} [options.tombstoneMs] 缺省 120 000
 * @param {(principal: object) => string | null} [options.resumeGate] 接续前重新核对持久权限状态
 */
export function createSessionLayer({
  router,
  nextConnId,
  now = Date.now,
  log = () => {},
  retainMs,
  tombstoneMs,
  resumeGate,
} = /** @type {any} */ ({})) {
  if (!router || typeof router.connect !== 'function') throw new TypeError('createSessionLayer: 要给 router');
  if (typeof nextConnId !== 'function') throw new TypeError('createSessionLayer: 要给 nextConnId');
  const retain = positive(retainMs, SESSION_DEFAULTS.RETAIN_MS);
  const tombTtl = positive(tombstoneMs, SESSION_DEFAULTS.TOMBSTONE_MS);
  const say = (event, fields) => { try { log(event, fields); } catch { /* 日志出错不影响会话 */ } };

  /** connId → 会话（含旧客户端） */
  const byConn = new Map();
  /** sid → 会话（只有讲会话的） */
  const bySid = new Map();
  /** sid → { code, reason, until }：结束的会话 */
  const tombs = new Map();
  const counters = { opened: 0, resumed: 0, expired: 0, fallbacks: 0 };

  function newSid() {
    let sid;
    do sid = randomBytes(32).toString('base64url'); while (bySid.has(sid) || tombs.has(sid));
    return sid;
  }

  function record(connId, { legacy, principal, remote, transport, fallback }) {
    const s = {
      connId,
      sid: legacy ? null : newSid(),
      legacy,
      principal,
      remote,
      transport,
      lastTransport: transport.kind,
      fallback: fallback ?? null,
      ended: false,
      gone: null,
      resolveGone: null,
      // 出站：已编号的消息，`frames[head..]` 是还没被确认的；`acked` 是对方确认到的最大 seq
      outSeq: 0,
      acked: 0,
      frames: [],
      head: 0,
      unackedBytes: 0,
      // 入站：按序收全的最大 seq；`ackSent` 是已经告诉对方的；`inBytes` 是这之后收到的字节数
      inSeq: 0,
      ackSent: 0,
      inBytes: 0,
      ackTimer: null,
      // 脱开
      detachedAt: 0,
      retainTimer: null,
      resumes: 0,
    };
    if (legacy) s.gone = new Promise((resolve) => { s.resolveGone = resolve; });
    return s;
  }

  const welcomeOf = (s, resumed) => ({
    type: 'session.welcome', sid: s.sid, resumed, ack: s.inSeq, retainMs: retain, transport: s.transport?.kind ?? s.lastTransport,
    ...(s.principal?.realm === 'account' && s.principal?.role === 'agent' ? { connId: s.connId } : {}),
  });

  function noteFallback(s, fallback) {
    if (typeof fallback !== 'string' || fallback === '') return;
    s.fallback = fallback;
    counters.fallbacks += 1;
    say('session.fallback', { connId: s.connId, reason: fallback });
  }

  // ---------- 确认 ----------

  function clearAckTimer(s) {
    if (s.ackTimer) clearTimeout(s.ackTimer);
    s.ackTimer = null;
  }

  /** 已经把 `inSeq` 告诉对方了（顺带或单发） */
  function markAcked(s) {
    s.ackSent = s.inSeq;
    s.inBytes = 0;
    clearAckTimer(s);
  }

  /** 单发 `session.ack`。脱开时不发：接续时 welcome 里带着 */
  function sendAck(s) {
    clearAckTimer(s);
    if (s.ended || !s.transport || s.inSeq <= s.ackSent) return;
    try {
      s.transport.control({ type: 'session.ack', ack: s.inSeq });
    } catch { /* 传输坏了，等它报关闭 */ }
    markAcked(s);
  }

  /** 收下一条业务消息之后：满条数或字节立刻确认，否则 1 s 内没有顺带的机会再单发 */
  function noteReceived(s, bytes) {
    if (s.ended) return;
    s.inBytes += bytes;
    if (s.inSeq <= s.ackSent) return;
    if (s.inSeq - s.ackSent >= SESSION_DEFAULTS.ACK_EVERY || s.inBytes >= SESSION_DEFAULTS.ACK_BYTES) {
      sendAck(s);
      return;
    }
    if (!s.ackTimer) {
      s.ackTimer = setTimeout(() => { s.ackTimer = null; sendAck(s); }, SESSION_DEFAULTS.ACK_DELAY_MS);
      s.ackTimer.unref?.();
    }
  }

  /** 丢掉对方已确认的帧；有下降就让核心接着写积压的消息。`ack` 越界回 false（会话已以 1002 结束） */
  function applyAck(s, ack) {
    if (!Number.isSafeInteger(ack) || ack < 0 || ack > s.outSeq) {
      badSeq(s);
      return false;
    }
    if (!release(s, ack)) return true;
    try {
      router.drained(s.connId);
    } catch (err) {
      say('conn.error', { connId: s.connId, message: String(err?.message ?? err) });
    }
    return !s.ended;
  }

  /** 丢掉 seq ≤ ack 的帧；回有没有丢（不叫核心） */
  function release(s, ack) {
    if (ack <= s.acked) return false;
    s.acked = ack;
    while (s.head < s.frames.length && s.frames[s.head].seq <= ack) {
      s.unackedBytes -= s.frames[s.head].bytes;
      s.head += 1;
    }
    if (s.head === s.frames.length) {
      s.frames = [];
      s.head = 0;
    } else if (s.head > 1024 && s.head * 2 > s.frames.length) {
      s.frames = s.frames.slice(s.head);
      s.head = 0;
    }
    return true;
  }

  function badSeq(s) {
    say('session.bad-seq', { connId: s.connId });
    endSession(s, SESSION_CLOSE.BAD_SEQ, 'bad-seq');
  }

  // ---------- 生命周期 ----------

  /**
   * 结束会话：不保留。立墓碑（讲会话的）、关掉当前传输；下一轮事件循环再 `router.disconnect` 与打 `conn.close`
   * （模块的 `ctx.close` 可能正处在它自己的处理函数里）。回注销完成的 Promise。
   */
  function endSession(s, code, reason, { closeTransport = true, discard = false } = {}) {
    if (s.ended) return s.gone;
    s.ended = true;
    clearAckTimer(s);
    if (s.retainTimer) clearTimeout(s.retainTimer);
    s.retainTimer = null;
    if (s.sid) {
      bySid.delete(s.sid);
      tombs.set(s.sid, { code, reason, until: now() + tombTtl });
    }
    const t = s.transport;
    s.transport = null;
    // 还没被确认的帧交给要关的传输：长轮询在带 `closed` 之前先回完它们（第 6.3 节）；WebSocket 早已写出，不用
    const rest = !discard && t && closeTransport && t.kind !== 'ws' ? s.frames.slice(s.head).map((f) => withSeq(f.text, f.seq, s.inSeq)) : [];
    s.frames = [];
    s.head = 0;
    s.unackedBytes = 0;
    if (t && closeTransport) {
      try { t.close(code, reason, rest); } catch { /* 已关 */ }
    }
    s.gone = new Promise((resolve) => {
      setImmediate(() => {
        if (byConn.get(s.connId) === s) byConn.delete(s.connId);
        try {
          router.disconnect(s.connId);
        } catch (err) {
          say('conn.error', { connId: s.connId, message: String(err?.message ?? err) });
        }
        say('conn.close', { connId: s.connId, code, reason, transport: s.lastTransport });
        s.resolveGone?.();
        resolve();
      });
    });
    return s.gone;
  }

  /** 传输断开：会话脱开，保留 `retainMs`，期满结束（第 4.2 节） */
  function detach(s, info = {}) {
    const t = s.transport;
    s.transport = null;
    s.detachedAt = now();
    clearAckTimer(s);
    say('session.detach', { connId: s.connId, transport: t?.kind ?? s.lastTransport, ...(info.code !== undefined ? { code: info.code } : {}), ...(info.why ? { why: info.why } : {}) });
    if (s.retainTimer) clearTimeout(s.retainTimer);
    s.retainTimer = setTimeout(() => {
      s.retainTimer = null;
      if (s.ended || s.transport) return;
      counters.expired += 1;
      say('conn.timeout', { connId: s.connId, transport: s.lastTransport });
      endSession(s, 1006, 'timeout');
    }, retain);
    s.retainTimer.unref?.();
  }

  function sendFrame(s, f) {
    try {
      s.transport.send(withSeq(f.text, f.seq, s.inSeq));
    } catch { /* 传输坏了，等它报关闭 */ }
    markAcked(s);
  }

  function tombOf(sid) {
    const tomb = tombs.get(sid);
    if (!tomb) return null;
    if (tomb.until <= now()) {
      tombs.delete(sid);
      return null;
    }
    return tomb;
  }

  const live = () => [...byConn.values()].filter((s) => !s.ended);

  return {
    /**
     * 旧客户端（不带会话项）：一条传输就是一个会话。登记进核心，回 connId。
     * `principal` 已规整；`transport.close` 之后组装层要调 `transportClosed`。
     */
    openLegacy({ principal, remote, transport }) {
      const connId = nextConnId();
      const s = record(connId, { legacy: true, principal, remote, transport });
      byConn.set(connId, s);
      counters.opened += 1;
      say('conn.open', { connId, remote, userId: principal.userId, ...(principal.role ? { role: principal.role } : {}), transport: transport.kind, legacy: true });
      router.connect(connId, principal, { remote, connectedAt: now() });
      return connId;
    },

    /**
     * 建新会话：先经这条传输发 `session.welcome`（第一条出站消息），再登记进核心（模块的 `connect` 可能立刻发消息）。
     * 回 `{ connId, sid, welcome }`；长轮询把 `welcome` 的字段放进 `POST /lp/open` 的回包。
     */
    openSession({ principal, remote, transport, fallback }) {
      const connId = nextConnId();
      const s = record(connId, { legacy: false, principal, remote, transport });
      byConn.set(connId, s);
      bySid.set(s.sid, s);
      counters.opened += 1;
      noteFallback(s, fallback);
      const welcome = welcomeOf(s, false);
      try { transport.control(welcome); } catch { /* 传输坏了，等它报关闭 */ }
      say('conn.open', { connId, remote, userId: principal.userId, ...(principal.role ? { role: principal.role } : {}), transport: transport.kind });
      router.connect(connId, principal, { remote, connectedAt: now() });
      return { connId, sid: s.sid, welcome };
    },

    /**
     * 接续（第 4.1 节）：会话号即凭证，不再鉴权。成功回 `{ ok: true, connId, welcome }`：旧传输（半开的）以 4009 关掉，
     * 发 welcome（带服务端已收全的客户端最大 seq），再按原 seq 补发对方还没确认的消息。
     * 失败回 `{ ok: false, code, reason, status }`：
     * - 会话不存在 4404 `no-session`（HTTP 404）；
     * - 已结束（墓碑还在）4410，`reason` 是 `session-closed <原关闭码>[ <原原因>]`（HTTP 410）；
     * - `ack` 大于服务端发出过的最大 seq：会话以 1002 `bad-seq` 结束，回同样的码（HTTP 410）。
     */
    resume({ sid, ack, transport, fallback }) {
      const s = bySid.get(sid);
      if (!s || s.ended) {
        const tomb = tombOf(sid);
        if (tomb) {
          return {
            ok: false, status: 410, code: SESSION_CLOSE.SESSION_CLOSED, closedCode: tomb.code, closedReason: tomb.reason,
            reason: clipReason(`session-closed ${tomb.code}${tomb.reason ? ` ${tomb.reason}` : ''}`),
          };
        }
        return { ok: false, status: 404, code: SESSION_CLOSE.NO_SESSION, reason: 'no-session' };
      }
      const resumeAllowed = (reason) => {
        if (s.ended) return { ok: false, status: 410, code: SESSION_CLOSE.SESSION_CLOSED, reason: 'session-closed' };
        if (typeof transport.isUsable === 'function' && !transport.isUsable())
          return { ok: false, status: 503, code: 1012, reason: 'transport-unavailable' };
        if (typeof reason === 'string') {
          endSession(s, 1012, reason);
          return { ok: false, status: 503, code: 1012, closedCode: 1012, closedReason: reason, reason };
        }
      if (!Number.isSafeInteger(ack) || ack < 0 || ack > s.outSeq) {
        badSeq(s);
        return { ok: false, status: 410, code: SESSION_CLOSE.BAD_SEQ, closedCode: SESSION_CLOSE.BAD_SEQ, closedReason: 'bad-seq', reason: 'bad-seq' };
      }
      const old = s.transport;
      if (old) {
        s.transport = null;
        try { old.close(SESSION_CLOSE.SUPERSEDED, 'superseded'); } catch { /* 已关 */ }
      }
      if (s.retainTimer) clearTimeout(s.retainTimer);
      s.retainTimer = null;
      const gapMs = s.detachedAt ? Math.max(0, now() - s.detachedAt) : 0;
      s.detachedAt = 0;
      s.transport = transport;
      s.lastTransport = transport.kind;
      s.resumes += 1;
      counters.resumed += 1;
      noteFallback(s, fallback);
      const welcome = welcomeOf(s, true);
      try { transport.control(welcome); } catch { /* 传输坏了，等它报关闭 */ }
      markAcked(s);
      say('session.resume', { connId: s.connId, transport: transport.kind, gapMs });
      // 先按接续项里的 ack 释放，补发剩下的（原 seq、按序），最后才让核心接着写积压的消息：
      // 反过来的话新消息会先于补发的旧消息写出，对方看到的就是跳号
      const released = release(s, ack);
      if (s.transport === transport) {
        for (let i = s.head; i < s.frames.length && s.transport === transport; i++) sendFrame(s, s.frames[i]);
      }
      if (released) {
        try {
          router.drained(s.connId);
        } catch (err) {
          say('conn.error', { connId: s.connId, message: String(err?.message ?? err) });
        }
      }
      return { ok: true, connId: s.connId, welcome };
      };
      if (typeof resumeGate !== 'function') return resumeAllowed(null);
      try {
        const reason = resumeGate(s.principal);
        return reason && typeof reason.then === 'function' ? reason.then(resumeAllowed, () => resumeAllowed('forbidden')) : resumeAllowed(reason);
      } catch { return resumeAllowed('forbidden'); }
    },

    /** 传输收到一条文本（第 3.3 节）。旧客户端原样交给核心 */
    receive(connId, text) {
      const s = byConn.get(connId);
      if (!s || s.ended) return;
      if (s.legacy) {
        return router.dispatch(connId, text);
      }
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        msg = undefined;
      }
      // 不是带 type 的对象：交给核心回 bad-message（核心的回包照样编号）
      if (!isObj(msg) || typeof msg.type !== 'string') {
        return router.dispatch(connId, text);
      }
      if (msg.type.startsWith(SESSION_TYPE_PREFIX)) {
        if (msg.type === 'session.ack') applyAck(s, msg.ack);
        else if (msg.type === 'session.close') endSession(s, clientCloseCode(msg.code), clipReason(msg.reason));
        // 别的控制消息（客户端不该发）忽略
        return;
      }
      if (Object.hasOwn(msg, 'ack') && !applyAck(s, msg.ack)) return;
      const seq = msg.seq;
      if (!Number.isSafeInteger(seq) || seq < 1 || seq > s.inSeq + 1) {
        badSeq(s);
        return;
      }
      if (seq <= s.inSeq) return; // 重发，丢弃
      s.inSeq = seq;
      const body = { ...msg };
      delete body.seq;
      delete body.ack;
      const dispatched = router.dispatch(connId, JSON.stringify(body));
      noteReceived(s, byteLen(text));
      return dispatched;
    },

    /**
     * 传输关了（WebSocket 的 close 事件；长轮询判定传输断开）。不是这个会话当前的传输（已被替换）就不管。
     * 旧客户端：会话随之结束，立刻 `router.disconnect`（与会话层出现之前一样同步）。
     * 讲会话的：脱开，保留 `retainMs`；传输上出了协议错误的（1002、1003、1007、1009）直接结束。
     */
    transportClosed(connId, transport, { code, reason, why } = {}) {
      const s = byConn.get(connId);
      if (!s || s.ended || s.transport !== transport) return;
      if (s.legacy) {
        s.ended = true;
        s.transport = null;
        byConn.delete(connId);
        router.disconnect(connId);
        say('conn.close', { connId, code, reason, transport: transport.kind });
        s.resolveGone?.();
        return;
      }
      if (END_ON_TRANSPORT_CODES.has(code)) {
        endSession(s, code, typeof reason === 'string' ? reason : '', { closeTransport: false });
        return;
      }
      detach(s, { code, why });
    },

    // ---------- 核心的钩子 ----------

    write(connId, text) {
      const s = byConn.get(connId);
      if (!s || s.ended) return;
      if (s.legacy) {
        s.transport?.send(text);
        return;
      }
      const f = { seq: ++s.outSeq, text, bytes: byteLen(text) };
      s.frames.push(f);
      s.unackedBytes += f.bytes;
      if (s.transport) sendFrame(s, f);
    },

    buffered(connId) {
      const s = byConn.get(connId);
      if (!s || s.ended) return 0;
      if (s.legacy) return Number(s.transport?.bufferedAmount ?? 0) || 0;
      return s.unackedBytes;
    },

    /** 核心的 `close` 与组装层的 `closeConn`：服务端主动关，会话立刻结束、不保留（第 4.2 节）。会话不在回 false */
    close(connId, code, reason) {
      const s = byConn.get(connId);
      if (!s || s.ended) return false;
      if (s.legacy) {
        try { s.transport?.close(code, reason); } catch { /* 已关 */ }
        return true;
      }
      endSession(s, code, reason);
      return true;
    },

    /** Security fence is separate from normal close/tail replay. The caller owns
     * actual transport closure; this synchronously kills SID and outbound caches. */
    fence(connId, code = 4003, reason = 'access-revoked') {
      const s = byConn.get(connId);
      if (!s) return { sid: null, gone: Promise.resolve(), existed: false };
      const sid = s.sid;
      // Even an ordinary-close session still waiting for router disconnect cannot
      // leave its logical cache available through a dedicated security fence.
      s.frames = []; s.head = 0; s.unackedBytes = 0;
      const gone = endSession(s, code, reason, { closeTransport: false, discard: true });
      return { sid, gone: gone ?? Promise.resolve(), existed: true };
    },

    // ---------- 长轮询用（HT-b 接线） ----------

    /** 按会话号找开着的会话的 connId；不在回 null */
    connIdOf(sid) {
      const s = bySid.get(sid);
      return s && !s.ended ? s.connId : null;
    },

    /** 结束的会话的墓碑 `{ code, reason }`；没有回 null */
    tombOf(sid) {
      const tomb = tombOf(sid);
      return tomb ? { code: tomb.code, reason: tomb.reason } : null;
    },

    /** 对方经长轮询报的确认；越界回 false（会话已以 1002 结束） */
    ack(connId, ack) {
      const s = byConn.get(connId);
      if (!s || s.ended || s.legacy) return false;
      return applyAck(s, ack);
    },

    /** 服务端已按序收全的对方最大 seq，同时算作已告诉对方（长轮询在 `POST /lp/send` 的回包里带它） */
    takeAck(connId) {
      const s = byConn.get(connId);
      if (!s || s.legacy) return 0;
      if (!s.ended) markAcked(s);
      return s.inSeq;
    },

    /** 客户端主动结束（长轮询的 `POST /lp/close`，同 `session.close`，第 4.2 节）；会话不在回 false */
    end(connId, code, reason) {
      const s = byConn.get(connId);
      if (!s || s.ended || s.legacy) return false;
      endSession(s, clientCloseCode(code), clipReason(reason));
      return true;
    },

    /** 服务端发出过的最大 seq */
    lastSeq(connId) {
      return byConn.get(connId)?.outSeq ?? 0;
    },

    /**
     * 长轮询的 GET 取帧：还没被确认的业务消息（带 seq 与当前 ack 的文本），从最早的起，总字节不超过 `maxBytes`（至少一帧）。
     * 帧留在缓冲里，直到对方确认；同一帧可能在两次 GET 里各出现一次，对方按 seq 去重。
     */
    pull(connId, maxBytes) {
      const s = byConn.get(connId);
      if (!s || s.ended || s.legacy) return [];
      const out = [];
      let size = 0;
      for (let i = s.head; i < s.frames.length; i++) {
        const f = s.frames[i];
        if (out.length > 0 && size + f.bytes > maxBytes) break;
        out.push(withSeq(f.text, f.seq, s.inSeq));
        size += f.bytes;
      }
      if (out.length > 0) markAcked(s);
      return out;
    },

    /** 有没有还没被确认的业务消息（长轮询判断 GET 要不要挂着） */
    hasPending(connId) {
      const s = byConn.get(connId);
      return !!s && !s.ended && !s.legacy && s.head < s.frames.length;
    },

    /** 这个会话当前挂着的是不是这条传输 */
    isCurrent(connId, transport) {
      const s = byConn.get(connId);
      return !!s && !s.ended && s.transport === transport;
    },

    // ---------- 组装层 ----------

    has(connId) {
      const s = byConn.get(connId);
      return !!s && !s.ended;
    },

    /** 开着的会话数（含脱开的与旧客户端），计入 `maxConnections` */
    size() {
      return live().length;
    },

    connIds() {
      return live().map((s) => s.connId);
    },

    /** `describe().conns[i]` 的组装层字段（第 8 节） */
    describeConn(connId) {
      const s = byConn.get(connId);
      if (!s) return null;
      return { transport: s.transport?.kind ?? null, fallback: s.fallback, detached: !s.legacy && !s.ended && !s.transport, resumes: s.resumes };
    },

    /** `/healthz` 的 `sessions`（第 8 节）：不含身份、地址与会话号 */
    stats() {
      const list = live().map((s) => ({
        connId: s.connId,
        transport: s.transport?.kind ?? null,
        fallback: s.fallback,
        detached: !s.legacy && !s.transport,
        legacy: s.legacy,
      }));
      return {
        total: list.length,
        ws: list.filter((i) => i.transport === 'ws').length,
        http: list.filter((i) => i.transport === 'http').length,
        detached: list.filter((i) => i.detached).length,
        legacy: list.filter((i) => i.legacy).length,
        opened: counters.opened,
        resumed: counters.resumed,
        expired: counters.expired,
        fallbacks: counters.fallbacks,
        list,
      };
    },

    /** 删掉过期的墓碑（组装层的心跳每轮调） */
    sweep() {
      const t = now();
      for (const [sid, tomb] of tombs) {
        if (tomb.until <= t) tombs.delete(sid);
      }
    },

    /**
     * 关停：所有会话以 `code` 结束（脱开的也结束），旧客户端关掉它的传输。回全部注销完成的 Promise。
     */
    closeSpace(space, code, reason) {
      for (const s of [...byConn.values()]) if (s.principal?.tenantId === space) endSession(s, code, reason);
    },
    closeAll(code, reason) {
      const waits = [];
      for (const s of [...byConn.values()]) {
        if (s.ended) {
          if (s.gone) waits.push(s.gone);
          continue;
        }
        if (s.legacy) {
          waits.push(s.gone);
          try { s.transport?.close(code, reason); } catch { /* 已关 */ }
          continue;
        }
        waits.push(endSession(s, code, reason));
      }
      return Promise.all(waits).then(() => {});
    },
  };
}

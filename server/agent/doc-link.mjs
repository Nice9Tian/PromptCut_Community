/**
 * Agent server-side connection to document service and project replica (C6.5 design draft
 * `docs/plan/c65-design.md` section 5, `cloud-task.md` D1).
 *
 * - **One connection per chat**: write identity (`actor`) only takes the connection principal
 *   (`auth-contract.md` section 6), and chat number is fixed during handshake, so to record
 *   writes from each chat as "agent + its own chat number", each chat must have its own `agent`
 *   role connection. Credentials are provided by caller per chat number (`protocolsFor(n)`):
 *   local `local` space uses `promptcut.role.agent.<n>`, on a LAN host the creator's own projects
 *   append `promptcut.tenant.<projectId>`, and shared projects (hosted side, LAN members) use
 *   connection tickets issued by the page.
 * - **One replica**: all chats read the same project replica (design draft section 5). The first
 *   connected chat connection doubles as "subscription": sends `project.open`, receives
 *   `project.state` and others' `project.ops`; each chat's own commits are handed to the replica
 *   by the executor after receiving `project.op.ok`. The two paths (broadcasts on subscription
 *   connection, ok on each chat connection) may arrive interleaved; replica queues by `rev`,
 *   applies only when contiguous, and discards duplicates; if gaps exceed `gapTimeoutMs` or apply
 *   fails, reopens with `project.open`.
 * - Applying operations uses the same engine as document service (`../docservice/json-ops.mjs`);
 *   replica is byte-for-byte identical to document service truth.
 *
 * - Each connection is a **session** (`createDocEndpoint` in `../render-node/session-link.mjs`,
 *   HT-a contract `docs/plan/http-transport-contract.md` section 9): if transport drops, it
 *   resumes within the retention window; unacknowledged requests and responses are not lost and
 *   remain invisible here; only session termination counts as a disconnection (request failure,
 *   subscription connection reconnect).
 *
 * Depends only on Node built-ins and this repository's `json-ops.mjs` and `session-link.mjs`;
 * WebSocket implementation is injectable (defaults to global `WebSocket`).
 */
import { applyOps } from '../docservice/json-ops.mjs';
import { createDocEndpoint } from '../render-node/session-link.mjs';

export const AGENT_LINK_DEFAULTS = Object.freeze({
  /** Upper limit for waiting for a response to a request (commit, event, content store) */
  requestTimeoutMs: 15_000,
  /** Max time to wait when replica versions have a gap; reopens if still not contiguous */
  gapTimeoutMs: 2_000,
  /** Reconnect backoff intervals after subscription connection drops (capped at the last entry) */
  reconnectMs: [200, 500, 1000, 2000, 5000],
  /** How many recent commit summaries (opId, write identity) the replica keeps for page-side tool write attribution */
  historyKeep: 1000,
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function linkError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * Project replica: applies operations in `rev` order.
 * State: `hasState` (received `project.state`), `hasBody` (project has true body in document
 * service), `rev`, `project`.
 */
class Replica {
  constructor({ gapTimeoutMs, historyKeep, onResync, log, onApplied = null }) {
    this.onApplied = onApplied;
    this.gapTimeoutMs = gapTimeoutMs;
    this.historyKeep = historyKeep;
    this.onResync = onResync;
    this.log = log;
    this.hasState = false;
    this.hasBody = false;
    this.rev = 0;
    this.project = null;
    /** rev → { ops, meta }: newer than current version and not yet contiguous */
    this.buffered = new Map();
    /** Recent commit summary: { rev, opId, actor, session } */
    this.history = [];
    this.gapTimer = null;
    this.waiters = new Set();
    this.resyncing = false;
  }

  /** Replace entirely with content provided by `project.state` */
  setState(rev, project) {
    this.hasState = true;
    this.resyncing = false;
    this.hasBody = project !== null && project !== undefined;
    this.project = this.hasBody ? project : null;
    this.rev = rev;
    for (const r of [...this.buffered.keys()]) if (r <= rev) this.buffered.delete(r);
    this.drain();
    this.notify();
  }

  /** A commit landed (broadcast or own ok); null `ops` means no operations (large root replacement), reopen needed */
  offer(rev, ops, meta = {}) {
    if (!Number.isSafeInteger(rev)) return;
    if (this.hasState && rev <= this.rev) return;
    if (!this.buffered.has(rev)) this.buffered.set(rev, { ops, meta });
    if (!this.hasState || this.resyncing) return;
    this.drain();
    this.notify();
  }

  drain() {
    while (this.buffered.has(this.rev + 1)) {
      const next = this.rev + 1;
      const { ops, meta } = this.buffered.get(next);
      this.buffered.delete(next);
      if (!Array.isArray(ops)) return this.resync('The remote commit carried no operations (large root replace)');
      let root;
      try {
        root = applyOps(this.project, ops).root;
      } catch (err) {
        return this.resync(`Remote operation could not be applied to the replica: ${err?.message ?? err}`);
      }
      const before = this.project;
      this.project = root;
      this.hasBody = true;
      this.rev = next;
      this.history.push({ rev: next, opId: meta.opId ?? null, actor: meta.actor ?? null, session: meta.session ?? meta.actor?.session ?? null });
      if (this.history.length > this.historyKeep) this.history.splice(0, this.history.length - this.historyKeep);
      // Commit stream (feeds A3 bulletin board change records): each version includes write identity and before/after projects
      if (typeof this.onApplied === 'function') {
        try { this.onApplied({ rev: next, opId: meta.opId ?? null, actor: meta.actor ?? null, ops, before, after: root }); } catch (err) { this.log('agent.replica.commit-listener-error', { message: String(err?.message ?? err) }); }
      }
    }
    clearTimeout(this.gapTimer);
    this.gapTimer = null;
    if (this.buffered.size > 0) {
      this.gapTimer = setTimeout(() => {
        this.gapTimer = null;
        if (this.buffered.size > 0) this.resync(`Version gap: the replica is at ${this.rev}, received ${[...this.buffered.keys()].sort((a, b) => a - b).join(', ')}`);
      }, this.gapTimeoutMs);
      this.gapTimer.unref?.();
    }
  }

  resync(reason) {
    this.log('agent.replica.resync', { reason, rev: this.rev });
    this.resyncing = true;
    clearTimeout(this.gapTimer);
    this.gapTimer = null;
    this.onResync(reason);
  }

  /** Resolves when version reaches `rev` (or higher); resolves false on timeout */
  waitRev(rev, timeoutMs) {
    if (this.hasState && this.rev >= rev) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = {
        check: () => {
          if (this.hasState && this.rev >= rev) {
            clearTimeout(w.timer);
            this.waiters.delete(w);
            resolve(true);
          }
        },
        timer: setTimeout(() => {
          this.waiters.delete(w);
          resolve(false);
        }, timeoutMs),
      };
      w.timer.unref?.();
      this.waiters.add(w);
    });
  }

  notify() {
    for (const w of [...this.waiters]) w.check();
  }

  /** Version where this opId landed; returns null if not in replica */
  revOfOpId(opId) {
    for (let i = this.history.length - 1; i >= 0; i -= 1) if (this.history[i].opId === opId) return this.history[i].rev;
    return null;
  }

  /** Summary of each version in (from, to]; returns null if missing (too old) */
  between(from, to) {
    const out = this.history.filter((h) => h.rev > from && h.rev <= to);
    return out.length === to - from ? out : null;
  }

  dispose() {
    clearTimeout(this.gapTimer);
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters.clear();
  }
}

/**
 * @param {object} options
 * @param {string | ((conversation: number) => string)} options.url Document service WebSocket URL
 *   (or provided per chat number)
 * @param {string} options.projectId
 * @param {(conversation: number) => Promise<string[]> | string[]} options.protocolsFor
 *   Subprotocols used by this chat's connection (includes `promptcut.v1`)
 * @param {typeof WebSocket} [options.WebSocketImpl]
 * @param {(event: string, fields?: object) => void} [options.log]
 */
export function createAgentLink({
  url,
  projectId,
  protocolsFor,
  WebSocketImpl = globalThis.WebSocket,
  log = () => {},
  requestTimeoutMs = AGENT_LINK_DEFAULTS.requestTimeoutMs,
  gapTimeoutMs = AGENT_LINK_DEFAULTS.gapTimeoutMs,
  reconnectMs = AGENT_LINK_DEFAULTS.reconnectMs,
  historyKeep = AGENT_LINK_DEFAULTS.historyKeep,
  /**
   * Optional (provided in hosted tier): when document service closes a connection with a close code
   * meaning "will not allow reconnect" (4003: toggle turned off, kicked, removed; 4004: project
   * deleted), calls `onFinalClose(chatNumber, { code, reason })`, and **does not reconnect
   * automatically**: this is revocation, not a transient drop (contract cloud-agent-contract.md
   * section 4.5).
   * If omitted, behaves as before (always reconnects with backoff on disconnection).
   */
  onFinalClose = null,
} = {}) {
  // url can also be provided per chat number (tests supply write identity via query string; in production all chats share address)
  if (typeof url !== 'function' && (typeof url !== 'string' || !url)) throw new TypeError('createAgentLink: url must be a string or a function');
  const urlFor = (n) => (typeof url === 'function' ? url(n) : url);
  if (typeof projectId !== 'string' || !projectId) throw new TypeError('createAgentLink: projectId must be a string');
  if (typeof protocolsFor !== 'function') throw new TypeError('createAgentLink: protocolsFor must be a function');
  if (typeof WebSocketImpl !== 'function') throw new TypeError('createAgentLink: no WebSocket implementation available');
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failures do not affect the connection */ } };

  let closed = false;
  /** Chat number → connection */
  const conns = new Map();
  /** Chat number of the connection that doubles as subscription */
  let feedConv = null;
  let reqSeq = 0;
  const listeners = new Set();
  const commitListeners = new Set();
  /** project.state currently being received in chunks */
  let partial = null;
  let stateWaiters = [];

  const replica = new Replica({
    gapTimeoutMs,
    historyKeep,
    log: say,
    onResync: () => openFeed(),
    onApplied: (commit) => {
      for (const cb of [...commitListeners]) {
        try { cb(commit); } catch (err) { say('agent.link.commit-listener-error', { message: String(err?.message ?? err) }); }
      }
    },
  });

  function emit(message, conversation) {
    for (const cb of [...listeners]) {
      try { cb(message, conversation); } catch (err) { say('agent.link.listener-error', { message: String(err?.message ?? err) }); }
    }
  }

  function resolveStateWaiters() {
    const ws = stateWaiters;
    stateWaiters = [];
    for (const w of ws) { clearTimeout(w.timer); w.resolve(); }
  }

  function onFeedMessage(msg) {
    switch (msg.type) {
      case 'project.state':
        if (msg.projectId !== undefined && msg.projectId !== projectId) return;
        if (msg.project === undefined && Number.isSafeInteger(msg.parts)) {
          partial = { rev: msg.rev, count: msg.parts, chunks: [] };
          return;
        }
        partial = null;
        replica.setState(msg.rev, msg.project ?? null);
        resolveStateWaiters();
        return;
      case 'project.state.part':
        if (partial && msg.rev === partial.rev) partial.chunks[msg.index] = msg.data;
        return;
      case 'project.state.end': {
        const part = partial;
        if (!part || msg.rev !== part.rev) return;
        partial = null;
        let project;
        try {
          if (part.chunks.length !== part.count || part.chunks.some((c) => typeof c !== 'string')) throw new Error('Incomplete chunks');
          project = JSON.parse(part.chunks.join(''));
        } catch (err) {
          say('agent.replica.state-broken', { message: String(err?.message ?? err) });
          openFeed();
          return;
        }
        replica.setState(part.rev, project);
        resolveStateWaiters();
        return;
      }
      case 'project.ops':
        if (msg.projectId !== undefined && msg.projectId !== projectId) return;
        replica.offer(msg.rev, msg.resync ? null : (Array.isArray(msg.ops) ? msg.ops : null), { opId: msg.opId, actor: msg.actor, session: msg.session });
        return;
      default:
    }
  }

  function openFeed() {
    if (closed || feedConv === null) return;
    const conn = conns.get(feedConv);
    if (!conn || conn.state !== 'open') return;
    partial = null;
    conn.sendRaw({ type: 'project.open', projectId });
  }

  function makeConn(n) {
    const conn = {
      n,
      state: 'idle',
      /** Current session endpoint for this connection (`createDocEndpoint`, one session per endpoint) */
      ep: null,
      opening: null,
      waiters: new Map(),
      retry: 0,
      retryTimer: null,
      sendRaw(message) {
        if (conn.state !== 'open' || !conn.ep) return false;
        try {
          return conn.ep.send(message) !== false;
        } catch {
          return false;
        }
      },
    };

    const retryFeed = () => {
      if (feedConv !== n || closed || conn.state === 'closed' || conn.retryTimer) return;
      replica.hasState = false;
      const wait = reconnectMs[Math.min(conn.retry, reconnectMs.length - 1)]; conn.retry++;
      conn.retryTimer = setTimeout(() => { conn.retryTimer = null; conn.open().catch(() => {}); }, wait);
      conn.retryTimer.unref?.();
    };
    conn.open = () => {
      if (closed) return Promise.reject(linkError('closed', 'The connection to the document service is closed'));
      if (conn.state === 'open') return Promise.resolve();
      if (conn.opening) return conn.opening;
      conn.state = 'connecting';
      conn.opening = (async () => {
        let protocols;
        try {
          protocols = await protocolsFor(n);
        } catch (err) {
          conn.state = 'idle';
          conn.opening = null;
          throw linkError('no-credential', `Chat ${n} cannot get a credential to connect to the document service: ${err?.message ?? err}`);
        }
        await new Promise((resolve, reject) => {
          // One endpoint per session (`renew: false`): transport drops resume within the session layer,
          // invisible here; only session termination counts as a disconnection.
          // How to reconnect after disconnection (subscription connection backoff reconnect, other chats
          // reconnect when needed) is still decided by this file, same as before using the session layer.
          let ep;
          try {
            ep = createDocEndpoint({
              url: urlFor(n),
              protocols: () => protocols,
              resumeProtocols: async () => {
                // The gateway cannot route a bare retained session. Renew a
                // page-delegated ticket without giving the Agent the user's K.
                const url = new URL(urlFor(n));
                if (!/^\/hosting\/relay\/sp_[a-z2-7]{26}\/doc\/?$/.test(url.pathname)) return [];
                return (await protocolsFor(n)).filter(p => p.startsWith('promptcut.ticket.'));
              },
              WebSocket: WebSocketImpl,
              renew: false,
              log: (event, fields) => {
                if (event === 'session.detach' || event === 'session.resume') say(`agent.link.${event.slice('session.'.length)}`, { conversation: n, ...(fields.gapMs !== undefined ? { gapMs: fields.gapMs } : {}) });
              },
            });
          } catch (err) {
            reject(linkError('connect-failed', `Cannot connect to the document service: ${err?.message ?? err}`));
            return;
          }
          conn.ep = ep;
          let opened = false;
          ep.onOpen(() => {
            if (conn.ep !== ep) return;
            opened = true;
            conn.state = 'open';
            conn.retry = 0;
            say('agent.link.open', { conversation: n });
            resolve();
            if (feedConv === n) openFeed();
          });
          ep.onMessage((msg) => {
            if (conn.ep !== ep) return;
            if (!isObj(msg)) return;
            const waiter = msg.reqId !== undefined ? conn.waiters.get(msg.reqId) : undefined;
            if (waiter && waiter.accept(msg)) {
              conn.waiters.delete(msg.reqId);
              clearTimeout(waiter.timer);
              waiter.resolve(msg);
              return;
            }
            if (feedConv === n) onFeedMessage(msg);
            emit(msg, n);
          });
          const down = (info) => {
            if (conn.ep !== ep) return;
            const finalClose = typeof onFinalClose === 'function' && (info?.code === 4003 || info?.code === 4004);
            conn.ep = null;
            try { ep.close(); } catch { /* Already closed */ }
            conn.state = 'idle';
            conn.opening = null;
            for (const [reqId, w] of conn.waiters) {
              clearTimeout(w.timer);
              w.reject(linkError('disconnected', 'The connection to the document service dropped'));
              conn.waiters.delete(reqId);
            }
            if (finalClose) {
              say('agent.link.final-close', { conversation: n, code: info.code, reason: String(info.reason ?? '').slice(0, 40) });
              if (!opened) reject(linkError('revoked', `The document service rejected this connection (${info.code} ${info.reason ?? ''})`));
              try { onFinalClose(n, { code: info.code, reason: String(info.reason ?? '') }); } catch { /* Host responsibility */ }
              return;
            }
            if (!opened) {
              reject(linkError('connect-failed', 'Cannot connect to the document service (handshake rejected or network unreachable)'));
              return;
            }
            say('agent.link.close', { conversation: n });
            retryFeed();
          };
          // Session ended (server closed, resume failed), or initial creation failed (handshake rejected, network unreachable)
          ep.onClose(down);
          ep.onConnectFail(down);
        });
        conn.opening = null;
      })();
      // A retry may itself fail before opening (page not ready to sign, or the
      // host still starting). Keep the subscription's automatic retry alive.
      conn.opening.catch(() => { conn.opening = null; retryFeed(); });
      return conn.opening;
    };

    /**
     * Send a request and wait for a response with the same `reqId`. `accept(msg)` determines whether
     * this is its terminating response (by default, any message with the same reqId qualifies).
     */
    conn.request = async (message, accept = () => true) => {
      await conn.open();
      const reqId = `agent${n}#${++reqSeq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          conn.waiters.delete(reqId);
          reject(linkError('timeout', `${message.type} got no reply within ${requestTimeoutMs} ms`));
        }, requestTimeoutMs);
        timer.unref?.();
        conn.waiters.set(reqId, { resolve, reject, timer, accept });
        if (!conn.sendRaw({ ...message, reqId })) {
          clearTimeout(timer);
          conn.waiters.delete(reqId);
          reject(linkError('disconnected', 'The connection to the document service is not ready'));
        }
      });
    };

    conn.close = () => {
      clearTimeout(conn.retryTimer);
      const ep = conn.ep;
      conn.ep = null;
      conn.state = 'closed';
      for (const w of conn.waiters.values()) { clearTimeout(w.timer); w.reject(linkError('closed', 'Connection closed')); }
      conn.waiters.clear();
      try { ep?.close(); } catch { /* Already disconnected */ }
    };
    return conn;
  }

  function conversation(n) {
    if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('The chat number must be a positive integer');
    let conn = conns.get(n);
    if (!conn) {
      conn = makeConn(n);
      conns.set(n, conn);
      if (feedConv === null) feedConv = n;
    }
    return conn;
  }

  return {
    projectId,
    url,
    replica,

    /** Get connection for a chat (created on demand, connected only when used) */
    conversation,

    /**
     * Wait for replica readiness (having received `project.state`). Before replica is ready,
     * subscription connection must connect first.
     * Throws `code: 'not-ready'` on timeout.
     */
    async ready(timeoutMs = requestTimeoutMs) {
      if (closed) throw linkError('closed', 'The connection to the document service is closed');
      if (feedConv === null) throw linkError('not-ready', 'No chat connection yet');
      if (replica.hasState && !replica.resyncing) return;
      await conns.get(feedConv).open();
      if (replica.hasState && !replica.resyncing) return;
      await new Promise((resolve, reject) => {
        const w = { resolve, timer: setTimeout(() => {
          stateWaiters = stateWaiters.filter((x) => x !== w);
          reject(linkError('not-ready', `Did not get the content of project ${projectId} within ${timeoutMs} ms`));
        }, timeoutMs) };
        w.timer.unref?.();
        stateWaiters.push(w);
      });
    },

    /** Subscribe to non-response messages on connections (`project.overwritten`, etc.); returns unsubscribe fn */
    onMessage(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    /**
     * Subscribe to commit stream: replica invokes callback `{ rev, opId, actor, ops, before, after }`
     * each time a version is applied (both others' broadcasts and own ok count; `project.state` full
     * content replacements do not count). Returns unsubscribe function.
     */
    onCommit(cb) {
      commitListeners.add(cb);
      return () => commitListeners.delete(cb);
    },

    /** Diagnostics */
    describe() {
      return {
        url, projectId, feedConv,
        conversations: [...conns.values()].map((c) => ({ conversation: c.n, state: c.state })),
        replica: { hasState: replica.hasState, hasBody: replica.hasBody, rev: replica.rev, buffered: replica.buffered.size },
      };
    },

    close() {
      if (closed) return;
      closed = true;
      for (const conn of conns.values()) conn.close();
      conns.clear();
      replica.dispose();
      for (const w of stateWaiters) clearTimeout(w.timer);
      stateWaiters = [];
    },
  };
}

/** Test-only: independently verify replica queuing and reopening */
export { Replica as AgentReplica };

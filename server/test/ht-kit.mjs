/**
 * For testing only; must not be referenced by production code.
 *
 * Common utilities for HT-a (document service session model + sequence number acknowledgement +
 * WebSocket transport to session layer + local trust toggle) tests (`ht*.test.mjs`).
 * Based solely on `docs/plan/http-transport-contract.md` version 2 (including file header
 * "2026-09-27 split"), and "Sessions and transport" in semantics
 * `docs/semantics/product/document-service.md` and `docs/semantics/mechanism/document-service.md`;
 * the test author did not inspect implementation (`claude/http-transport`, `claude/ht-client`).
 * HTTP long polling is HT-b; this test suite tests none of it.
 *
 * Module paths, option names, and response shapes not fixed by the contract are all centralized
 * in this file; reconcile only here during integration.
 * Each assumption is labeled as "Assumption H<n>", and the report
 * `docs/archive/agent-reports/AGENT-ht-tests.md` lists them under the same numbering.
 *
 *   H1  Server session layer is in `server/docservice/session.mjs` (named in Sections 2 and 15 of
 *       the contract). This test suite does not call its exports directly, but tests entirely via
 *       `createDocService`: **whether this file exists** is the probe for "whether the server
 *       session layer is in place"; if it exists but behaves incorrectly, the test case throws an
 *       error.
 *   H2  `createDocService` adds option `retainMs` (retention limit, default 60 000, Section 4.2 of
 *       the contract); `session.welcome.retainMs` equals it. Remaining options (`heartbeatMs`,
 *       `maxPendingBytes`, `highWaterBytes`, `log`, `authenticate`) keep their existing names.
 *   H3  Session items (Section 4.1 of the contract): new session `promptcut.session.new`, listed
 *       alongside authentication items; resume `promptcut.session.<sid>.<ack>`, with only
 *       `promptcut.v1` and itself in the list. Session items are handled by the session layer:
 *       new sessions call `authenticate(req)` as usual; **resumes do not call** `authenticate`
 *       (the session id is the credential, reusing identity from session creation).
 *   H4  First outbound message after successful session creation / resume:
 *       `{ type: 'session.welcome', sid, resumed, ack, retainMs, transport: 'ws' }`; `sid` is 32
 *       bytes of base64url (43 characters, without padding).
 *   H5  Resume failure (Section 16 item 1 of the contract modified Section 4.1): server first
 *       accepts upgrade (101), then immediately notifies via close code: session does not exist
 *       4404 `no-session`, closed (within 2-minute tombstone) 4410
 *       `session-closed <original close code>[ <original reason>]`. `resumeStatus` converts 4404
 *       to 404 and 4410 to 410; handshakes rejected directly return status codes as before, so
 *       test criteria (does not exist → 404, closed → 410) remain unchanged.
 *       [integration reconcile 2026-09-27: originally wrote "return 404 / 410 in handshake",
 *       written before Section 16, updated to match implementation]
 *   H6  Close codes and reasons: skipped sequence number / out-of-bounds ack → 1002 `bad-seq`
 *       (Section 3.5); half-open old connection replaced → 4009 `superseded` (Section 3.1);
 *       backpressure → 1013 `backpressure` (as-is from H.2).
 *   H7  `/healthz.sessions` (Section 8): keys
 *       `total ws http detached legacy opened resumed expired fallbacks list`; `list[i]` has
 *       exactly the five keys `connId transport fallback detached legacy`; when detached,
 *       `transport: null`. Tests read according to the example in the contract:
 *       `total === list.length`, `ws` = count of `transport === 'ws'` in list (legacy clients also
 *       use ws and are counted), `detached` = count of `detached` in list, `legacy` = count of
 *       `legacy` in list. The `transports` field from version 1 is no longer present.
 *       [integration reconcile 2026-09-27: consistent with implementation; `opened` in
 *       implementation accumulates legacy clients as well (legacy clients are also sessions)]
 *   H8  `describe().conns[i]` gains `transport`, `fallback`, `detached`, `resumes` (Section 8).
 *   H9  Logs are output via `log(event, fields)` of `createDocService`: `session.detach`,
 *       `session.resume { connId, transport, gapMs }`, and `conn.timeout` on retention expiry
 *       (Sections 4.2, 8); session ids never enter any logs.
 *   H10 Client session layer `server/render-node/session-link.mjs` exports `createDocEndpoint`
 *       (Section 9); `server/render-node/index.mjs` re-exports under the same name. **Whether
 *       this file exists** is the probe for "whether the client session layer is in place"; if
 *       the file exists but lacks this export, the test case throws an error. Options (Section 9):
 *       `url`, `protocols` (function returning auth list, **excluding** session items, session
 *       items added by endpoint itself), `WebSocket`, `fetch`, `setTimeout`, `clearTimeout`,
 *       `random`, `backoff` (same keys as `BACKOFF_DEFAULTS`), `log`, `now`; also recognizes
 *       `transport: 'ws' | 'http'` (Section 9 "browser passes transport from caller"). Return
 *       values: `send`, `onMessage`, `onOpen`, `onResume`, `onClose`, `close`, `connected`,
 *       `closed`, `stats()`; `stats()` has at least `transport`, `fallbacks`, `resumes`,
 *       `pendingBytes`, `dropped`.
 *   H11 Clients in HT-a cannot read WebSocket handshake status codes (neither browsers nor Node
 *       built-in `WebSocket` can read them, Section 4.3 note), so when a resume fails to
 *       handshake it cannot distinguish 404 / 410 from network failures: **if resume has not
 *       succeeded after `welcome.retainMs` since detach, treat session as closed**, report
 *       `onClose`, and recreate session next time (re-invoking `protocols()`). If the
 *       implementation has a faster method (for example, server first accepts upgrade then
 *       notifies via close code), this test suite still passes: it only requires "recreation
 *       within retention limit plus a few seconds". [integration reconcile 2026-09-27:
 *       implementation does both: immediately rebuild upon receiving 4404 / 4410 (H5); also
 *       rebuild when detached longer than `welcome.retainMs` if handshake fails]
 *   H12 The endpoint's `close()` sends `{ type: 'session.close', … }` before closing (Section 4.2
 *       "active close" initiated by client).
 *   H13 Local trust toggle (Section 10): `server/hosted/main.mjs` reads
 *       `PROMPTCUT_TRUST_LOOPBACK`; when `0` and lacking a cluster token, refuse startup, log
 *       `config.error { reason: 'cluster-token-required' }`, exit code 1. Probe: presence of the
 *       name `PROMPTCUT_TRUST_LOOPBACK` in `.mjs` files under `server/hosted/` counts as in place
 *       (only checks name presence, not implementation style).
 *   H14 Probe: `scripts/probes/shared-project-probe.mjs` member role only uses WebSocket under
 *       `PROMPTCUT_TRANSPORT=ws` and `--transport ws`, and automatic when omitted (Section 4.3
 *       item 6, Section 14 "Probe's --transport"); when ws is forced, `session.fallback` does not
 *       appear in the output.
 *
 * Only imports Node built-in modules and `fake-ws-kit.mjs`, `fake-raw-ws.mjs` from the same
 * directory.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { wsClient, rawHandshake, waitFor, sleep } from './fake-ws-kit.mjs';

export { wsClient, rawHandshake, waitFor, sleep };

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const PROTOCOL = 'promptcut.v1';
export const SESSION_NEW = 'promptcut.session.new';
export const resumeItem = (sid, ack) => `promptcut.session.${sid}.${ack}`;
/** 32-byte base64url: 43 characters */
export const SID_RE = /^[A-Za-z0-9_-]{43}$/;

// ================================================================== In-place probes (H1, H10, H13)

const exists = (rel) => existsSync(path.join(ROOT, rel));

export const HAS_SERVER_SESSION = exists('server/docservice/session.mjs');
export const HAS_CLIENT_SESSION = exists('server/render-node/session-link.mjs');
export const HAS_TRUST_SWITCH = (() => {
  const dir = path.join(ROOT, 'cloud', 'server', 'hosted');
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.mjs')).some((f) => readFileSync(path.join(dir, f), 'utf8').includes('PROMPTCUT_TRUST_LOOPBACK'));
  } catch {
    return false;
  }
})();

/** For `test(name, { skip }, fn)`: false if in place (actually run), string stating reason if not */
export const SKIP_SERVER = HAS_SERVER_SESSION ? false : 'server session layer not in place: server/docservice/session.mjs does not exist (switches to a real run automatically once HT-a is integrated, assumption H1)';
export const SKIP_CLIENT = HAS_CLIENT_SESSION ? false : 'client session layer not in place: server/render-node/session-link.mjs does not exist (switches to a real run automatically once HT-a is integrated, assumption H10)';
export const SKIP_BOTH = SKIP_SERVER || SKIP_CLIENT;
export const SKIP_TRUST = HAS_TRUST_SWITCH ? false : 'local trust switch not in place: PROMPTCUT_TRUST_LOOPBACK is not in server/hosted/*.mjs (switches to a real run automatically once HT-a is integrated, assumption H13)';

// ================================================================== Server

/**
 * Test authentication: `promptcut.user.<id>` in list means this user, `promptcut.user.deny` denies,
 * neither means `u-default`.
 * Ignores session items and other items entirely (handled by session layer, H3). `calls` tracks
 * how many times it was called.
 */
export function testAuth() {
  const auth = {
    calls: 0,
    authenticate(req) {
      auth.calls += 1;
      const raw = String(req?.headers?.['sec-websocket-protocol'] ?? '');
      const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const u = items.find((p) => p.startsWith('promptcut.user.'));
      const user = u ? u.slice('promptcut.user.'.length) : 'u-default';
      if (user === 'deny') return null;
      return { userId: user, tenantId: 't-ht' };
    },
  };
  return auth;
}

/**
 * Test module `ht`: claims `ht.` prefix.
 *   ht.echo { n }                  → returns { type: 'ht.echoed', n }
 *   ht.sink                        → does not return (used to test sending session.ack alone when
 *                                    "no piggybacking opportunity")
 *   ht.burst { count, size, key? } → sends count consecutive { type: 'ht.blob', i, pad }, includes
 *                                    merge key if key provided
 * `seen` records messages seen by module in arrival order (as-is, used to assert no seq / ack);
 * `connects` / `disconnects` record lifecycle; `ctx` is context provided by core (used by tests
 * to send messages to connection from outside).
 */
export function htModule() {
  const mod = {
    name: 'ht',
    types: ['ht.'],
    seen: [],
    connects: [],
    disconnects: [],
    ctx: null,
    connect(ctx, connId, principal) { mod.ctx = ctx; mod.connects.push({ connId, principal, at: Date.now() }); },
    disconnect(ctx, connId) { mod.ctx = ctx; mod.disconnects.push({ connId, at: Date.now() }); },
    handle(ctx, connId, msg) {
      mod.ctx = ctx;
      mod.seen.push({ connId, msg });
      if (msg.type === 'ht.echo') ctx.send(connId, { type: 'ht.echoed', n: msg.n });
      else if (msg.type === 'ht.burst') {
        const pad = 'x'.repeat(msg.size ?? 1024);
        for (let i = 0; i < (msg.count ?? 1); i++) {
          ctx.send(connId, { type: 'ht.blob', i, pad }, typeof msg.key === 'string' ? { coalesceKey: msg.key } : undefined);
        }
      }
    },
  };
  return mod;
}

/**
 * Start service in standalone mode (port 0, bind loopback only, `autoTick: false`), logs collected
 * into `logs`.
 * `opts` passed as-is to `createDocService` (`retainMs` see H2).
 */
export async function startService({ modules, ...opts } = {}) {
  const { createDocService } = await import(pathToFileURL(path.join(ROOT, 'server', 'docservice', 'service.mjs')).href);
  const logs = [];
  const auth = testAuth();
  const mod = htModule();
  const service = createDocService({
    log: (event, fields) => logs.push({ event, ...fields }),
    autoTick: false,
    authenticate: auth.authenticate,
    modules: modules ?? [mod],
    ...opts,
  });
  const { port } = await service.listen(0, '127.0.0.1');
  const clients = [];
  let closed = false;
  const env = {
    service, port, logs, auth, mod,
    url: `ws://127.0.0.1:${port}/`,
    health: async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json(),
    track(c) { clients.push(c); return c; },
    async cleanup() {
      if (closed) return;
      closed = true;
      for (const c of clients) { try { c.close(); } catch { /* Closed */ } }
      await service.close();
    },
  };
  return env;
}

/**
 * Session-aware test client (Node built-in WebSocket):
 *   - New session: list `[promptcut.v1, promptcut.user.<user>, promptcut.session.new]`;
 *   - Resume: `[promptcut.v1, promptcut.session.<sid>.<ack>]` (H3).
 * Waits until `session.welcome` before returning. Returned object extends `wsClient` with:
 *   `welcome`, `sid`, `sendSeq(msg)` (auto-assigns seq starting from `startSeq + 1`),
 *   `sendRaw(msg)`, `bizSeqs()` (seqs of received business messages), `ackOf()` (maximum
 *   contiguous server seq received in order), `closeEvent` (Promise → { code, reason }).
 * This client does not auto-acknowledge or auto-retransmit: tests control each message individually.
 */
export async function openSession(env, { user = 'alice', resume = null, startSeq = 0, extraProtocols = [] } = {}) {
  const protocols = resume
    ? [PROTOCOL, resumeItem(resume.sid, resume.ack ?? 0), ...extraProtocols]
    : [PROTOCOL, `promptcut.user.${user}`, SESSION_NEW, ...extraProtocols];
  const c = env.track(wsClient(env.url, protocols));
  try {
    await c.opened;
  } catch (err) {
    throw new Error(`session handshake failed (${resume ? 'resumed' : 'new'}): ${err.message}`);
  }
  const welcome = await c.next((m) => m?.type === 'session.welcome', 3000);
  return decorate(c, welcome, startSeq);
}

function decorate(c, welcome, startSeq) {
  let seq = startSeq;
  c.welcome = welcome;
  c.sid = welcome?.sid;
  c.sendSeq = (msg) => { seq += 1; c.send({ ...msg, seq }); return seq; };
  c.sendRaw = (msg) => c.send(msg);
  c.setSeq = (n) => { seq = n; };
  c.bizSeqs = () => c.all.filter((m) => typeof m?.type === 'string' && !m.type.startsWith('session.')).map((m) => m.seq);
  c.ackOf = () => {
    const got = new Set(c.bizSeqs().filter((n) => Number.isInteger(n)));
    let n = 0;
    while (got.has(n + 1)) n += 1;
    return n;
  };
  addEnded(c);
  return c;
}

/** `c.ended(ms)`: wait for this connection to close, return { code, reason }; timeout throws error (to avoid hanging test cases) */
function addEnded(c) {
  c.closeEvent = c.closed.then((e) => ({ code: e.code, reason: e.reason }));
  c.ended = (ms = 3000) => Promise.race([
    c.closeEvent,
    new Promise((_, reject) => { setTimeout(() => reject(new Error(`timed out waiting for the connection to close (${ms} ms)`)), ms).unref?.(); }),
  ]);
}

/** Legacy client: without session items (Section 3.6 of the contract) */
export async function openLegacy(env, { user = 'alice' } = {}) {
  const c = env.track(wsClient(env.url, [PROTOCOL, `promptcut.user.${user}`]));
  await c.opened;
  addEnded(c);
  return c;
}

/** Status codes converted from resume failure (H5): 4404 → 404, 4410 → 410, actual resume → 101; rejected handshakes return status codes directly. Leaves no connection */
export async function resumeStatus(env, sid, ack = 0) {
  const { rawWsClient } = await import('./fake-raw-ws.mjs');
  let c;
  try {
    c = await rawWsClient(env.port, { protocols: [PROTOCOL, resumeItem(sid, ack)] });
  } catch (err) {
    const m = /HTTP\/1\.1 (\d{3})/.exec(String(err?.message));
    return m ? Number(m[1]) : -1;
  }
  // Handshake succeeded: wait for server close frame (Section 16 item 1 of the contract); if not closed within 3 s, it is truly resumed
  const ended = await Promise.race([c.ended, new Promise((r) => { setTimeout(() => r(null), 3000).unref?.(); })]);
  c.destroy();
  const code = ended?.closeFrame?.code ?? c.closeFrame?.code;
  return code === 4404 ? 404 : code === 4410 ? 410 : 101;
}

/** Shape of `/healthz.sessions` (H7), returns sessions */
export function checkSessionsShape(h) {
  assert.ok(h && typeof h.sessions === 'object' && h.sessions !== null, `/healthz must have a sessions field: ${JSON.stringify(h).slice(0, 600)}`);
  assert.ok(!Object.hasOwn(h, 'transports'), 'the transports field from version 1 no longer exists (contract section 8, section 14)');
  const s = h.sessions;
  for (const k of ['total', 'ws', 'http', 'detached', 'legacy', 'opened', 'resumed', 'expired', 'fallbacks']) {
    assert.ok(Number.isInteger(s[k]) && s[k] >= 0, `sessions.${k} must be a non-negative integer: ${JSON.stringify(s)}`);
  }
  assert.ok(Array.isArray(s.list), `sessions.list must be an array: ${JSON.stringify(s)}`);
  for (const item of s.list) {
    assert.deepEqual(Object.keys(item).sort(), ['connId', 'detached', 'fallback', 'legacy', 'transport'],
      `each sessions.list item has exactly five keys (no identity, address or session ID): ${JSON.stringify(item)}`);
    assert.ok(item.transport === 'ws' || item.transport === 'http' || item.transport === null, `transport value: ${JSON.stringify(item)}`);
    if (item.detached) assert.equal(item.transport, null, `transport is null when detached: ${JSON.stringify(item)}`);
  }
  assert.equal(s.total, s.list.length, `total equals the number of entries in list: ${JSON.stringify(s)}`);
  assert.equal(s.ws, s.list.filter((i) => i.transport === 'ws').length, `ws matches list: ${JSON.stringify(s)}`);
  assert.equal(s.http, s.list.filter((i) => i.transport === 'http').length, `http matches list: ${JSON.stringify(s)}`);
  assert.equal(s.detached, s.list.filter((i) => i.detached).length, `detached matches list: ${JSON.stringify(s)}`);
  assert.equal(s.legacy, s.list.filter((i) => i.legacy).length, `legacy matches list: ${JSON.stringify(s)}`);
  return s;
}

/** Assert that a text contains no session id */
export function assertNoSid(text, sid, where) {
  assert.ok(typeof sid === 'string' && sid.length > 10, 'session ID must be a string');
  assert.ok(!String(text).includes(sid), `session ID must not appear in ${where}`);
}

// ================================================================== Client (H10)

let clientMod = null;
/** Load `session-link.mjs` to get `createDocEndpoint`; fails if file exists but export is incorrect (does not skip) */
export async function loadDocEndpoint() {
  if (clientMod) return clientMod;
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(ROOT, 'server', 'render-node', 'session-link.mjs')).href);
  } catch (err) {
    assert.fail(`cannot load server/render-node/session-link.mjs: ${err?.message ?? err}`);
  }
  assert.equal(typeof mod.createDocEndpoint, 'function', `session-link.mjs must export createDocEndpoint; actual exports: ${Object.keys(mod).join(', ')}`);
  clientMod = mod;
  return mod;
}

/** Always-failing fetch ("cannot connect via HTTP either"): HT-a does not use HTTP; if implementation attempts it, it only gets network errors */
export function refusingFetch() {
  const f = async () => { f.calls += 1; throw new TypeError('fetch failed (ht-kit: HTTP always fails to connect in tests)'); };
  f.calls = 0;
  return f;
}

/** Temporarily set (or delete) an entry in environment variables, returning a restore function */
export function withEnv(name, value) {
  const had = Object.hasOwn(process.env, name);
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (had) process.env[name] = old;
    else delete process.env[name];
  };
}

/**
 * Controllable fake WebSocket (shape of browser / Node built-in `WebSocket`:
 * `new WebSocket(url, protocols)`, `readyState`, `protocol`, `send`, `close`, supporting both
 * `addEventListener` and `on<event>` listeners). Each construction recorded into `sockets`.
 *
 * Test-side controls (on socket):
 *   accept(welcome?)    trigger open; if welcome provided, immediately send `session.welcome`
 *                       (missing fields filled with defaults)
 *   push(msg)           server sends a message (object, sent as JSON)
 *   fail({ errorOnly }) handshake failure: trigger error; when errorOnly is true, do **not**
 *                       trigger close (Node behavior measured on the cloud, 2026-09-27)
 *   drop(code, reason)  server disconnect: trigger close
 *   sent                messages sent by client (parsed objects)
 */
export function fakeWebSocketEnv() {
  const sockets = [];
  const waiters = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url, protocols) {
      this.url = String(url);
      this.protocols = protocols === undefined ? [] : [].concat(protocols);
      this.readyState = 0;
      this.protocol = '';
      this.bufferedAmount = 0;
      this.sent = [];
      this.listeners = { open: [], message: [], error: [], close: [] };
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      this.closedByClient = null;
      sockets.push(this);
      for (const w of waiters.splice(0)) w();
    }
    addEventListener(type, fn) { this.listeners[type]?.push(fn); }
    removeEventListener(type, fn) { const l = this.listeners[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }
    emit(type, event) {
      for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
      const prop = this[`on${type}`];
      if (typeof prop === 'function') prop.call(this, event);
    }
    send(text) {
      if (this.readyState !== 1) throw new Error('InvalidStateError: not open');
      let msg;
      try { msg = JSON.parse(text); } catch { msg = { __raw: String(text) }; }
      this.sent.push(msg);
    }
    close(code = 1000, reason = '') {
      if (this.readyState >= 2) return;
      const wasOpen = this.readyState === 1;
      this.readyState = 2;
      this.closedByClient = { code, reason };
      setImmediate(() => {
        this.readyState = 3;
        this.emit('close', { type: 'close', code: wasOpen ? code : 1006, reason: wasOpen ? reason : '', wasClean: wasOpen });
      });
    }
    // ---- Test-side control
    accept(welcome) {
      this.readyState = 1;
      this.protocol = 'promptcut.v1';
      this.emit('open', { type: 'open' });
      if (welcome) this.push({ type: 'session.welcome', sid: 'S'.repeat(43), resumed: false, ack: 0, retainMs: 60_000, transport: 'ws', ...welcome });
    }
    push(msg) {
      if (this.readyState !== 1) return;
      this.emit('message', { type: 'message', data: JSON.stringify(msg) });
    }
    fail({ errorOnly = false } = {}) {
      this.emit('error', { type: 'error', message: 'Unexpected server response: 401' });
      if (!errorOnly) {
        this.readyState = 3;
        this.emit('close', { type: 'close', code: 1006, reason: '', wasClean: false });
      }
    }
    drop(code = 1006, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close', { type: 'close', code, reason, wasClean: code !== 1006 });
    }
    /** Business messages sent by client (excluding session.* control messages) */
    biz() { return this.sent.filter((m) => typeof m?.type === 'string' && !m.type.startsWith('session.')); }
    control(type) { return this.sent.filter((m) => m?.type === type); }
  }
  return {
    WebSocket: FakeWebSocket,
    sockets,
    last: () => sockets.at(-1),
    /** Wait for the nth (1-based) socket to be constructed */
    async nth(n, ms = 3000) {
      const until = Date.now() + ms;
      while (sockets.length < n) {
        if (Date.now() > until) throw new Error(`timed out waiting for WebSocket construction #${n} (${ms} ms), ${sockets.length} so far`);
        await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 20); });
      }
      return sockets[n - 1];
    },
  };
}

/** Whether list is new session / resume (H3) */
export const isNewSessionList = (list) => list[0] === PROTOCOL && list.includes(SESSION_NEW);
export const resumeOf = (list) => {
  const item = list.find((p) => p.startsWith('promptcut.session.') && p !== SESSION_NEW);
  if (!item) return null;
  const rest = item.slice('promptcut.session.'.length);
  const i = rest.lastIndexOf('.');
  return { sid: rest.slice(0, i), ack: Number(rest.slice(i + 1)) };
};

/**
 * Create an endpoint: uses fake WebSocket by default, always-failing fetch, very short backoff
 * (jitter 0). `overrides` override options.
 * `protocolsCalls` tracks how many times `protocols()` was called; returns
 * `[promptcut.v1, promptcut.user.alice, promptcut.nonce.<n>]` each time.
 */
export async function makeEndpoint(overrides = {}) {
  const { createDocEndpoint } = await loadDocEndpoint();
  const fake = fakeWebSocketEnv();
  const fetchImpl = refusingFetch();
  const calls = { protocols: 0 };
  const opened = [];
  const resumed = [];
  const closes = [];
  const messages = [];
  const ep = createDocEndpoint({
    url: 'ws://doc.test/hosted',
    protocols: () => { calls.protocols += 1; return [PROTOCOL, 'promptcut.user.alice', `promptcut.nonce.${calls.protocols}`]; },
    WebSocket: fake.WebSocket,
    fetch: fetchImpl,
    backoff: { baseMs: 10, factor: 2, maxMs: 40, jitter: 0 },
    random: () => 0.5,
    log: () => {},
    ...overrides,
  });
  ep.onOpen(() => opened.push(Date.now()));
  if (typeof ep.onResume === 'function') ep.onResume(() => resumed.push(Date.now()));
  ep.onClose((info) => closes.push(info));
  ep.onMessage((m) => messages.push(m));
  return { ep, fake, fetch: fetchImpl, calls, opened, resumed, closes, messages };
}

// ================================================================== Hosted combined subprocess (HT6, HT7)

/** Start main.mjs: wait for `listen` line (returns port) or exit (returns exit code and output). PROMPTCUT_* uses only those provided here */
export function runHostedMain(t, env) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('PROMPTCUT_')) delete base[k];
  const child = spawn(process.execPath, [path.join(ROOT, 'cloud', 'server', 'hosted', 'main.mjs')], {
    env: { ...base, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_ASSET_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => { try { child.kill(); } catch { /* Already exited */ } });
  let out = '';
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: 'timeout', out }), 20_000);
    const onData = (d) => {
      out += d;
      for (const line of out.split('\n')) {
        if (!line.startsWith('{')) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.event === 'listen') {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          resolve({ code: null, out, child, doc: j.docservice?.port, asset: j.asset?.port, listen: j });
          return;
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}


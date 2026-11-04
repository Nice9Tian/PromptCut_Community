/**
 * Card source sync endpoint in account cloud projects (`server/account-card-link.mjs`): only
 * presents ticket when creating new sessions, and switches sessions upon ticket expiration.
 * Session endpoint uses a mock (real one runs against real service in `account-card-sync.test.mjs`).
 * Report `docs/reports/AGENT-v18-cardsync.md`.
 *
 *   ACL-01 Subprotocol: `promptcut.v1` + `promptcut.account.<ticket>`; throw if ticket is invalid;
 *     do not supply subprotocol for resume (resume carries no ticket)
 *   ACL-02 Switch ahead of time per ticket expiresAt after session established: close old (upper
 *     layer receives close), start new with new ticket (upper layer receives open)
 *   ACL-03 Ticket only has a few seconds left: use for at least minSessionMs; follow fallbackLifeMs
 *     if no expiresAt
 *   ACL-04 On receiving credential-revoked / authorization-expired error: pass message to upper
 *     layer as usual, then switch immediately; do not switch for other errors
 *   ACL-05 Session ended by server: cancel timer, pass close to upper layer; endpoint resets timer
 *     after re-establishing itself
 *   ACL-06 No more switches or timers after close
 *   ACL-07 cardSyncConnect: account projects use this endpoint, others match defaults (unmodified
 *     protocols, logs prefixed with doc.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountCardEndpoint, accountCardProtocols, cardSyncConnect } from '../account-card-link.mjs';

const T = (n) => `${'t'.repeat(42)}${n}`;

function harness({ tickets, ...options } = {}) {
  let nowMs = 1_000_000;
  const timers = [];
  const endpoints = [];
  let asked = 0;
  const defaultTicket = (n) => ({ ticket: T(n % 10), expiresAt: nowMs + 120_000 });
  const getTicket = async () => {
    const next = (tickets ?? defaultTicket)(++asked, nowMs);
    if (next instanceof Error) throw next;
    return next;
  };
  const createEndpoint = (o) => {
    const h = { open: [], close: [], message: [], resume: [] };
    const ep = {
      o, closed: false, sent: [], protocolsSeen: null, session: false,
      onOpen: (f) => h.open.push(f), onClose: (f) => h.close.push(f), onMessage: (f) => h.message.push(f), onResume: (f) => h.resume.push(f),
      send(m) { this.sent.push(m); return true; },
      close() {
        if (this.closed) return;
        this.closed = true;
        if (this.session) { this.session = false; for (const f of h.close) f({ code: 1000, reason: 'closed' }); }
      },
      stats: () => ({ transport: 'ws', resumes: 0 }),
      /** Mock: runs through "fetch subprotocol → establish session" */
      async open() { this.protocolsSeen = await o.protocols(); this.session = true; for (const f of h.open) f(); },
      serverClose(code = 4003) { this.session = false; for (const f of h.close) f({ code, reason: 'access-revoked' }); },
      push(m) { for (const f of h.message) f(m); },
    };
    endpoints.push(ep);
    return ep;
  };
  const events = [];
  const link = accountCardEndpoint({
    url: 'wss://doc.example/hosted/', getTicket, createEndpoint, now: () => nowMs,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false, fired: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    ...options,
  });
  link.onOpen(() => events.push('open'));
  link.onClose((info) => events.push(`close:${info?.code}`));
  link.onMessage((m) => events.push(`msg:${m.type}:${m.reason ?? ''}`));
  const fire = (t) => { assert.equal(t.cleared, false, 'timer already cancelled'); t.fired = true; t.fn(); };
  const live = () => timers.filter((t) => !t.cleared && !t.fired);
  return { link, endpoints, timers, events, fire, live, advance: (ms) => { nowMs += ms; }, asked: () => asked };
}

test('ACL-01 the subprotocol presents the ticket only when creating a new session; throws if the ticket is invalid', async () => {
  const h = harness();
  await h.endpoints[0].open();
  assert.deepEqual(h.endpoints[0].protocolsSeen, ['promptcut.v1', `promptcut.account.${T(1)}`]);
  assert.equal(h.endpoints[0].o.resumeProtocols, undefined, 'a resume carries no ticket (the document service handshake returns 400 if it does)');
  assert.equal(h.endpoints[0].o.url, 'wss://doc.example/hosted/');
  const bad = harness({ tickets: () => ({ ticket: 'short', expiresAt: 1 }) });
  await assert.rejects(bad.endpoints[0].open(), /Invalid account connection ticket/);
  const p = accountCardProtocols(async () => ({ ticket: T(7), expiresAt: 5 }));
  assert.deepEqual(await p(), ['promptcut.v1', `promptcut.account.${T(7)}`]);
});

test('ACL-02 replace the session early based on the ticket\'s expiresAt: the upper layer gets close, then open, and the new session uses the new ticket', async () => {
  const h = harness();
  await h.endpoints[0].open();
  assert.deepEqual(h.events, ['open']);
  assert.equal(h.live().length, 1);
  assert.equal(h.live()[0].ms, 112_000, 'a 120 s ticket is replaced 8 s early');
  h.advance(112_000);
  h.fire(h.live()[0]);
  assert.equal(h.endpoints.length, 2);
  assert.equal(h.endpoints[0].closed, true);
  assert.deepEqual(h.events, ['open', 'close:1000']);
  await h.endpoints[1].open();
  assert.deepEqual(h.endpoints[1].protocolsSeen, ['promptcut.v1', `promptcut.account.${T(2)}`]);
  assert.deepEqual(h.events, ['open', 'close:1000', 'open']);
  assert.equal(h.link.stats().accountRenews, 1);
  // Send via the current endpoint
  h.link.send({ type: 'content.list' });
  assert.equal(h.endpoints[0].sent.length, 0);
  assert.equal(h.endpoints[1].sent.length, 1);
});

test('ACL-03 even if the ticket has only a few seconds left, the session is used for at least minSessionMs; with no expiry time, fallbackLifeMs applies', async () => {
  const short = harness({ tickets: (n, now) => ({ ticket: T(n), expiresAt: now + 4_000 }) });
  await short.endpoints[0].open();
  assert.equal(short.live()[0].ms, 3_000);
  const plain = harness({ tickets: (n) => T(n) });
  await plain.endpoints[0].open();
  assert.equal(plain.live()[0].ms, 60_000);
});

test('ACL-04 the gate replies credential-revoked / authorization-expired: the message is still passed to the upper layer, then the session is replaced immediately; other errors do not trigger a replacement', async () => {
  for (const reason of ['credential-revoked', 'authorization-expired']) {
    const h = harness();
    await h.endpoints[0].open();
    h.endpoints[0].push({ type: 'error', reason, reqId: 'cards#1' });
    assert.deepEqual(h.events, ['open', `msg:error:${reason}`, 'close:1000'], reason);
    assert.equal(h.endpoints.length, 2);
    assert.equal(h.live().length, 0, 'the old session\'s timer is cancelled');
    // A late second error on the same old connection will not trigger again
    h.endpoints[0].push({ type: 'error', reason });
    assert.equal(h.endpoints.length, 2);
  }
  const h = harness();
  await h.endpoints[0].open();
  h.endpoints[0].push({ type: 'error', reason: 'not-listed' });
  h.endpoints[0].push({ type: 'content.changed', kind: 'card-source' });
  assert.equal(h.endpoints.length, 1, 'a read-only rejection is not a connection expiry');
  assert.deepEqual(h.events, ['open', 'msg:error:not-listed', 'msg:content.changed:']);
});

test('ACL-05 the session is ended by the server: cancel the timer and pass close to the upper layer; after the endpoint is rebuilt, fetch a ticket again and set the timer again', async () => {
  const h = harness();
  await h.endpoints[0].open();
  h.endpoints[0].serverClose(4003);
  assert.deepEqual(h.events, ['open', 'close:4003']);
  assert.equal(h.live().length, 0);
  assert.equal(h.endpoints.length, 1, 'the session endpoint rebuilds itself with backoff');
  h.advance(5_000);
  await h.endpoints[0].open();
  assert.equal(h.asked(), 2);
  assert.equal(h.live().length, 1);
  assert.equal(h.live()[0].ms, 112_000);
});

test('ACL-06 after close, no more replacement, no more timers, no more sends', async () => {
  const h = harness();
  await h.endpoints[0].open();
  const timer = h.live()[0];
  h.link.close();
  assert.equal(timer.cleared, true);
  assert.equal(h.endpoints[0].closed, true);
  h.endpoints[0].push({ type: 'error', reason: 'credential-revoked' });
  assert.equal(h.endpoints.length, 1);
  assert.equal(h.link.send({ type: 'x' }), false);
});

test('ACL-07 cardSyncConnect: account projects use this endpoint, everything else is handed unchanged to the default session endpoint', async () => {
  const logged = [];
  /** Unconnectable WebSocket mock (no network in tests) */
  class DeadSocket {
    constructor() { queueMicrotask(() => this.onerror?.({ message: 'no network in test' })); }
    addEventListener(type, fn) { this[`on${type}`] = fn; }
    close() {}
  }
  const connect = cardSyncConnect((event, fields) => logged.push([event, fields]), { WebSocket: DeadSocket });
  let asked = 0;
  const account = connect({ url: 'wss://doc.example/hosted/', protocols: accountCardProtocols(async () => { asked++; return { ticket: T(1), expiresAt: Date.now() + 60_000 }; }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked, 1, 'account project: the endpoint fetches the ticket itself');
  assert.equal(typeof account.stats()?.accountRenews, 'number');
  account.close();
  let plain = 0;
  const legacy = connect({ url: 'ws://127.0.0.1:1/docservice', protocols: () => { plain++; return ['promptcut.v1']; } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(plain, 1);
  assert.equal(legacy.stats().accountRenews, undefined, 'other spaces use the default session endpoint');
  legacy.close();
  assert.ok(logged.length > 0 && logged.every(([event]) => event.startsWith('doc.')));
});

test('ACL-08 the bound address of an account project can only be the account cloud\'s document service; probes and integration testing must explicitly allow other origins', async () => {
  const { accountDocUrlAllowed } = await import('../account-card-link.mjs');
  const opened = { PROMPTCUT_ACCOUNT_CLOUD_ORIGIN: 'https://accounts.example' };
  assert.equal(accountDocUrlAllowed('wss://accounts.example/hosted/', opened), true);
  for (const bad of ['wss://attacker.invalid/hosted/', 'ws://accounts.example/hosted/', 'wss://accounts.example.attacker.invalid/hosted/', 'wss://accounts.example:8443/hosted/',
    'wss://user@accounts.example/hosted/', 'wss://accounts.example/hosted/?x=1', 'wss://accounts.example/other/', 'wss://accounts.example/hosted', 'https://accounts.example/hosted/', '', null, 'not a url']) {
    assert.equal(accountDocUrlAllowed(bad, opened), false, String(bad));
  }
  const env = { PROMPTCUT_ACCOUNT_CLOUD_ORIGIN: 'https://127.0.0.1:28656, http://insecure.example' };
  assert.equal(accountDocUrlAllowed('wss://127.0.0.1:28656/hosted/', env), true);
  assert.equal(accountDocUrlAllowed('wss://127.0.0.1:28657/hosted/', env), false);
  assert.equal(accountDocUrlAllowed('wss://insecure.example/hosted/', env), false, 'an http origin in the allow list does not count');
});

test('ACL-09 requests arriving via the stage port are recognized (card code in a stage window must not touch the endpoints that fetch tickets or change bindings)', async () => {
  const { viaStagePort, STAGE_CLIENT_HEADER, originOk } = await import('../http-guard.mjs');
  // Same-origin request sent by stage window: Origin and Host are both stage ports, originOk cannot
  // block it; identifiable by headers written by proxy
  const stage = { headers: { origin: 'http://127.0.0.1:5191', host: '127.0.0.1:5191', [STAGE_CLIENT_HEADER]: '127.0.0.1' } };
  assert.equal(originOk(stage), true);
  assert.equal(viaStagePort(stage), true);
  assert.equal(viaStagePort({ headers: { origin: 'http://127.0.0.1:5190', host: '127.0.0.1:5190' } }), false);
  assert.equal(viaStagePort({ headers: { [STAGE_CLIENT_HEADER]: '' } }), true, 'an empty string written by the proxy counts too');
});

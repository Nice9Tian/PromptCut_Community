/**
 * Content store client (contract `docs/plan/manifest-contract.md` section 2, section 6 cases
 * Q1-Q3).
 * Run: node --test server/test/content-client.test.mjs
 *
 * Written strictly to the contract, without looking at the implementation.
 *
 * Conventions:
 *   - Real document service: standalone mode, port 0, `autoTick: false`, mounting C6.3's content
 *     store module (memory storage); connection uses M5a's `createWsEndpoint`, client
 *     `createContentClient(endpoint, { timeoutMs })` (see `fake-manifest-env.mjs`).
 *   - "Server does not respond": mount a mock module that swallows `content.*` (no response), or
 *     use a mock endpoint (only records sent messages; tests decide when, in what order to respond,
 *     and when to disconnect). Mock endpoint only satisfies the shape of `WsEndpoint`:
 *     `send` / `onMessage` / `onOpen` / `onClose` / `connected` / `closed` / `close` / `stats`.
 *   - Response shape follows C6.3 contract section 2: `content.stored` / `content.item`
 *     (`missing: true`) / `content.listing` / `error { reason }`.
 *
 * When `server/render-node/content-client.mjs` does not yet exist, each test case fails
 * individually and reports the reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  loadContentClient, startContentService, connectContent, connectEndpoint, until,
} from './fake-manifest-env.mjs';

const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

/** Module that swallows content.*: responds to nothing received (simulating "server does not respond") */
const silentModule = () => ({ name: 'silent-content', types: ['content.'], channels: [], handle() {} });

/** Mock endpoint: satisfies WsEndpoint shape; tests manual responses, disconnection, reconnection */
function fakeEndpoint() {
  const handlers = { message: [], open: [], close: [] };
  const sent = [];
  let connected = true;
  let closed = false;
  return {
    sent,
    send(message) {
      if (!connected) return false;
      sent.push(JSON.parse(JSON.stringify(message)));
      return true;
    },
    onMessage(h) { handlers.message.push(h); },
    onOpen(h) { handlers.open.push(h); },
    onClose(h) { handlers.close.push(h); },
    close() { closed = true; connected = false; },
    get connected() { return connected; },
    get closed() { return closed; },
    stats: () => ({ opens: 1, closes: 0, sent: sent.length, received: 0, dropped: 0, badFrames: 0 }),
    deliver(message) { for (const h of [...handlers.message]) h(JSON.parse(JSON.stringify(message))); },
    drop() { connected = false; for (const h of [...handlers.close]) h({ code: 1006, reason: '' }); },
    reopen() { connected = true; for (const h of [...handlers.open]) h(); },
  };
}

/** Wait for a promise to settle, returns { ok, value | error, ms } */
async function settleOf(promise) {
  const t0 = Date.now();
  try { return { ok: true, value: await promise, ms: Date.now() - t0 }; } catch (error) { return { ok: false, error, ms: Date.now() - t0 }; }
}

/* ------------------------------------------------------------------ Q1 */

test('Q1 get after put returns the same body; missing returns null; list filters by prefix and sorts by key ascending; an error reply carries reason and is thrown', async (t) => {
  const env = await startContentService();
  t.after(env.cleanup);
  const { content } = await connectContent(env);

  const rk = 'a'.repeat(64);
  const body = { v: 1, kind: 'snapshot', tier: 'shared', resultKey: rk, dirKey: rk, entryKey: null, range: { from: 0, to: 59 }, canvasHeavy: false,
    frames: [[0, 'b'.repeat(64), 123], [1, 'c'.repeat(64), 456]] };
  const stored = await content.put('snapshot-manifest', `${rk}:0-59`, body);
  assert.equal(stored.hash, hashOf(body), 'hash returned by put = sha256(JSON.stringify(body))');
  assert.equal(stored.rev, undefined, 'Manifest kinds have no rev');

  const got = await content.get('snapshot-manifest', `${rk}:0-59`);
  assert.ok(got, 'get finds it');
  assert.deepEqual(got.body, body, 'Body is returned unchanged');
  assert.equal(got.hash, stored.hash);

  assert.equal(await content.get('snapshot-manifest', `${rk}:60-119`), null, 'A missing key returns null');
  assert.equal(await content.get('render-manifest', `${rk}:0-59`), null, 'Not present under another kind');

  // card-source includes rev
  const r1 = await content.put('card-source', 'card/x', { src: 1 });
  const r2 = await content.put('card-source', 'card/x', { src: 1 });
  assert.deepEqual([r1.rev, r2.rev], [1, 2], 'rev of card-source passes through');
  assert.equal((await content.get('card-source', 'card/x')).rev, 2);

  // list by prefix, ascending
  const other = 'd'.repeat(64);
  for (const key of [`${rk}:120-129`, `${other}:0-59`, `${rk}:60-119`]) await content.put('snapshot-manifest', key, { k: key });
  const listed = await content.list('snapshot-manifest', `${rk}:`);
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.items.map((i) => i.key), [`${rk}:0-59`, `${rk}:120-129`, `${rk}:60-119`], 'Filtered by prefix, sorted by key ascending');
  assert.equal(listed.items[0].hash, stored.hash, 'items carry hash');
  const all = await content.list('snapshot-manifest');
  assert.equal(all.items.length, 4, 'Without a prefix, lists everything');

  // Server returns error: throws by reqId, with reason
  const tooBig = await settleOf(content.put('snapshot-manifest', 'big', { blob: 'x'.repeat(300 * 1024) }));
  assert.equal(tooBig.ok, false, 'Body over 256 KiB is rejected');
  assert.equal(tooBig.error.reason, 'too-large', `Error carries reason: ${tooBig.error?.message}`);
  const badKind = await settleOf(content.get('no-such-kind', 'k'));
  assert.equal(badKind.ok, false);
  assert.equal(badKind.error.reason, 'bad-message');
  // Client remains usable as usual after an error
  assert.deepEqual((await content.get('snapshot-manifest', `${rk}:0-59`)).body, body);

  // render-node/index.mjs must also re-export (contract section 7 "Additions")
  const idx = await import('../render-node/index.mjs');
  assert.equal(idx.createContentClient, (await loadContentClient()).createContentClient, 'render-node/index.mjs re-exports createContentClient');
});

/* ------------------------------------------------------------------ Q2 */

test('Q2 20 concurrent requests: each carries a unique reqId and is matched by reqId, results don\'t get crossed (real service)', async (t) => {
  const env = await startContentService();
  t.after(env.cleanup);
  const { createContentClient } = await loadContentClient();
  const endpoint = await connectEndpoint(env.url('node-a'), { env });
  const sent = [];
  const rawSend = endpoint.send.bind(endpoint);
  // Wrap send once to count requests (wrapped before creating client, so client gets the wrapped one)
  const counted = { ...endpoint, send: (m) => { sent.push(m); return rawSend(m); }, onMessage: endpoint.onMessage, onOpen: endpoint.onOpen, onClose: endpoint.onClose,
    close: endpoint.close, stats: endpoint.stats, get connected() { return endpoint.connected; }, get closed() { return endpoint.closed; } };
  const content = createContentClient(counted);

  const keys = Array.from({ length: 20 }, (_, i) => `seg-${String(i).padStart(2, '0')}`);
  const bodies = keys.map((k, i) => ({ key: k, n: i, pad: 'z'.repeat(i * 97) }));
  const stored = await Promise.all(keys.map((k, i) => content.put('render-manifest', k, bodies[i])));
  stored.forEach((s, i) => assert.equal(s.hash, hashOf(bodies[i]), `Reply to put #${i} matches its own body`));

  // 20 get and 20 put / list mixed concurrently
  const ops = [];
  for (let i = 0; i < 20; i++) {
    ops.push(content.get('render-manifest', keys[i]).then((r) => ['get', i, r]));
    if (i % 5 === 0) ops.push(content.list('render-manifest', keys[i]).then((r) => ['list', i, r]));
    if (i % 4 === 0) ops.push(content.get('render-manifest', `missing-${i}`).then((r) => ['miss', i, r]));
  }
  for (const [op, i, r] of await Promise.all(ops)) {
    if (op === 'get') assert.deepEqual(r?.body, bodies[i], `get ${keys[i]} returns its own body`);
    else if (op === 'list') assert.deepEqual(r.items.map((x) => x.key), [keys[i]], `list ${keys[i]} lists only itself`);
    else assert.equal(r, null, `missing-${i} returns null`);
  }
  const reqIds = sent.map((m) => m.reqId);
  assert.ok(reqIds.every((id) => id !== undefined && id !== null), 'Every request carries a reqId');
  assert.equal(new Set(reqIds).size, reqIds.length, `reqIds are all distinct (${reqIds.length} requests)`);
  assert.ok(sent.every((m) => typeof m.type === 'string' && m.type.startsWith('content.')), 'Sends content.* messages');
});

test('Q2 replies out of order and interleaved with unrelated messages: still matched by reqId (fake endpoint)', async () => {
  const { createContentClient } = await loadContentClient();
  const ep = fakeEndpoint();
  const content = createContentClient(ep, { timeoutMs: 5000 });
  const N = 20;
  const pending = [];
  for (let i = 0; i < N; i++) pending.push(i % 2 ? content.get('snapshot-manifest', `k${i}`) : content.put('snapshot-manifest', `k${i}`, { i }));
  await until(() => ep.sent.length === N, { timeoutMs: 2000, what: () => `Only ${ep.sent.length} requests were sent` });
  assert.equal(new Set(ep.sent.map((m) => m.reqId)).size, N, 'reqId is unique');

  // Irrelevant messages: pushes from other modules, without reqId, or with unfamiliar reqId
  ep.deliver({ type: 'queue.snapshot', tasks: [] });
  ep.deliver({ type: 'content.changed', kind: 'snapshot-manifest', key: 'k0', hash: 'f'.repeat(64) });
  ep.deliver({ type: 'content.item', kind: 'snapshot-manifest', key: 'k1', body: { wrong: true }, hash: 'e'.repeat(64), reqId: 'not-mine' });
  // Responses in reverse order
  for (const m of [...ep.sent].reverse()) {
    const i = Number(m.key.slice(1));
    if (m.type === 'content.put') ep.deliver({ type: 'content.stored', kind: m.kind, key: m.key, hash: hashOf(m.body), reqId: m.reqId });
    else if (i % 4 === 1) ep.deliver({ type: 'content.item', kind: m.kind, key: m.key, missing: true, reqId: m.reqId });
    else ep.deliver({ type: 'content.item', kind: m.kind, key: m.key, body: { i }, hash: hashOf({ i }), reqId: m.reqId });
  }
  const results = await Promise.all(pending);
  results.forEach((r, i) => {
    if (i % 2 === 0) assert.equal(r.hash, hashOf({ i }), `put k${i}`);
    else if (i % 4 === 1) assert.equal(r, null, `get k${i} missing → null`);
    else assert.deepEqual(r?.body, { i }, `get k${i}`);
  });
});

/* ------------------------------------------------------------------ Q3 */

test('Q3 server does not reply: times out with code: timeout (real service, with a module mounted that never replies)', async (t) => {
  const env = await startContentService({ modules: [silentModule()] });
  t.after(env.cleanup);
  const { content } = await connectContent(env, { timeoutMs: 300 });
  const r = await settleOf(content.get('snapshot-manifest', 'k'));
  assert.equal(r.ok, false, 'No reply means failure');
  assert.equal(r.error.code, 'timeout', `Error carries code: timeout: ${r.error?.message}`);
  assert.ok(r.ms >= 250 && r.ms < 3000, `Timed by timeoutMs: ${r.ms} ms`);
  const p = await settleOf(content.put('snapshot-manifest', 'k', { a: 1 }));
  assert.equal(p.error?.code, 'timeout', 'put times out the same way');
});

test('Q3 disconnect: in-flight requests fail immediately with code: disconnected instead of waiting for the timeout (real service)', async (t) => {
  const env = await startContentService({ modules: [silentModule()] });
  t.after(env.cleanup);
  const { endpoint, content } = await connectContent(env, { timeoutMs: 20_000 });
  const inflight = [content.get('snapshot-manifest', 'a'), content.put('snapshot-manifest', 'b', { b: 1 }), content.list('snapshot-manifest', '')].map(settleOf);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const closedSeen = new Promise((resolve) => endpoint.onClose(resolve));
  await env.service.close(); // Server disconnects all connections
  await closedSeen;
  const t0 = Date.now();
  const results = await Promise.all(inflight);
  assert.ok(Date.now() - t0 < 2000, 'Fails immediately after disconnect, without waiting for the 20 s timeout');
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'disconnected', `Error carries code: disconnected: ${r.error?.message}`);
  }
});

test('Q3 no replay after disconnect: in-flight requests are not resent after reconnecting; a reply that arrives after the timeout is ignored (fake endpoint)', async () => {
  const { createContentClient } = await loadContentClient();
  const ep = fakeEndpoint();
  const content = createContentClient(ep, { timeoutMs: 150 });

  // Timeout, then late response: does not throw, does not affect subsequent requests
  const late = settleOf(content.get('snapshot-manifest', 'late'));
  await until(() => ep.sent.length === 1);
  const lateReq = ep.sent[0];
  const r0 = await late;
  assert.equal(r0.error?.code, 'timeout');
  ep.deliver({ type: 'content.item', kind: 'snapshot-manifest', key: 'late', body: { x: 1 }, hash: hashOf({ x: 1 }), reqId: lateReq.reqId });

  // 3 in flight, disconnected: all immediately disconnected
  const inflight = [content.get('snapshot-manifest', 'a'), content.put('snapshot-manifest', 'b', { b: 1 }), content.list('render-manifest')].map(settleOf);
  await until(() => ep.sent.length === 4);
  ep.drop();
  const results = await Promise.all(inflight);
  for (const r of results) assert.equal(r.error?.code, 'disconnected', `In-flight request disconnected: ${r.error?.message}`);
  ep.reopen();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ep.sent.length, 4, 'Requests from before the disconnect are not replayed after reconnecting');

  // New requests after reconnection pair as usual
  const next = content.get('snapshot-manifest', 'c');
  await until(() => ep.sent.length === 5);
  const m = ep.sent[4];
  ep.deliver({ type: 'content.item', kind: m.kind, key: m.key, missing: true, reqId: m.reqId });
  assert.equal(await next, null);
});

test('Q3 endpoint is unreachable from the start: requests fail instead of hanging (real service is shut down)', async (t) => {
  const env = await startContentService();
  const url = env.url('node-a');
  const ep = await connectEndpoint(url, { env });
  t.after(env.cleanup);
  const { createContentClient } = await loadContentClient();
  const content = createContentClient(ep, { timeoutMs: 1000 });
  const closedSeen = new Promise((resolve) => ep.onClose(resolve));
  await env.service.close();
  await closedSeen;
  const r = await settleOf(content.get('snapshot-manifest', 'x'));
  assert.equal(r.ok, false, 'Sending a request while disconnected: fails');
  assert.ok(['disconnected', 'timeout'].includes(r.error?.code), `Error carries code (disconnected or timeout): ${r.error?.code} ${r.error?.message}`);
  assert.ok(r.ms < 3000, `Does not hang: ${r.ms} ms`);
});

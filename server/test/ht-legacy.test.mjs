/**
 * HT common acceptance check: legacy client (without session items in handshake) behavior remains
 * unchanged (contract `docs/plan/http-transport-contract.md` Section 3.6, Section 11 "General").
 * Run: node --test server/test/ht-legacy.test.mjs
 *
 * This test suite does not depend on session layer being in place: must pass both before and after
 * merging the session layer (before merging, they describe the current status).
 * Written solely according to contract without inspecting implementation; common utilities in
 * `ht-kit.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startService, openLegacy, waitFor, sleep, PROTOCOL } from './ht-kit.mjs';
import { createWsEndpoint } from '../render-node/ws-transport.mjs';

test('HT-legacy-1 a handshake without session items works as before: 101, echoes only promptcut.v1, no session.welcome, and messages carry no seq / ack in either direction', async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openLegacy(env);
  assert.equal(c.ws.protocol, PROTOCOL);
  c.send({ type: 'ht.echo', n: 1 });
  c.send({ type: 'ht.echo', n: 2 });
  await c.next((m) => m.type === 'ht.echoed' && m.n === 2);
  await sleep(1300); // Even after the 1 s where session layer sends ack alone, legacy clients should not receive session.ack
  assert.equal(c.all.filter((m) => String(m?.type).startsWith('session.')).length, 0, `old clients receive no session.* control messages: ${JSON.stringify(c.all)}`);
  for (const m of c.all) {
    assert.ok(!('seq' in m) && !('ack' in m), `messages received by old clients carry no seq / ack: ${JSON.stringify(m)}`);
  }
  assert.deepEqual(env.mod.seen.map((s) => s.msg), [{ type: 'ht.echo', n: 1 }, { type: 'ht.echo', n: 2 }], 'messages without seq are handed to the module as usual, unchanged');
  env.service.send(env.mod.connects[0].connId, { type: 'ht.pushed' });
  const pushed = await c.next((m) => m.type === 'ht.pushed');
  assert.deepEqual(pushed, { type: 'ht.pushed' });
});

test('HT-legacy-2 for an old client, the session ends as soon as the transport drops (retention limit effectively 0): the module sees the disconnect immediately', async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openLegacy(env);
  assert.equal(env.mod.connects.length, 1);
  c.close();
  await c.ended();
  await waitFor(() => env.mod.disconnects.length === 1, 1500, 'old client disconnects immediately');
  assert.ok(env.logs.some((l) => l.event === 'conn.close'), 'conn.close log unchanged');
});

test('HT-legacy-3 the existing createWsEndpoint (the pre-upgrade desktop app and probes) still connects, sends and receives, and reconnects after a drop', async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const ep = createWsEndpoint({ url: env.url, backoff: { baseMs: 20, maxMs: 50, jitter: 0 } });
  t.after(() => ep.close());
  const got = [];
  ep.onMessage((m) => got.push(m));
  let opens = 0;
  ep.onOpen(() => { opens += 1; });
  await waitFor(() => opens === 1, 3000, 'Connected');
  ep.send({ type: 'ht.echo', n: 7 });
  await waitFor(() => got.some((m) => m.type === 'ht.echoed'), 2000, 'reply');
  assert.deepEqual(got.find((m) => m.type === 'ht.echoed'), { type: 'ht.echoed', n: 7 }, 'reply carries no seq / ack');
  assert.equal(got.filter((m) => String(m?.type).startsWith('session.')).length, 0);
  // Server disconnects it: legacy endpoint reconnects as before (new connection), module sees one disconnect and two connects
  assert.equal(env.service.closeConn(env.mod.connects[0].connId, 1011, 'test'), true);
  await waitFor(() => opens === 2, 3000, 'reconnect');
  assert.equal(env.mod.disconnects.length, 1);
  assert.equal(env.mod.connects.length, 2);
});

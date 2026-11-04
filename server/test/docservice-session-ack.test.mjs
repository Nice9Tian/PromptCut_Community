/**
 * Server session layer byte acknowledgment ([ruling] 2026-09-27 lead session, contract
 * `docs/plan/http-transport-contract.md` section 3.3):
 * When received, unconfirmed raw business messages reach 64 KiB, immediately send `session.ack`
 * individually, without waiting for 32 messages or 1 s. The same rule on client side is tested
 * by SL-ack-bytes in `session-link.test.mjs`.
 * Run: node --test server/test/docservice-session-ack.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startService, openSession, sleep } from './ht-kit.mjs';
import { SESSION_DEFAULTS } from '../docservice/session.mjs';

test('DS-ack-bytes once the unacknowledged raw text received reaches 64 KiB: session.ack is sent immediately on its own; when it is not full, it waits 1 s as before', async (t) => {
  assert.equal(SESSION_DEFAULTS.ACK_BYTES, 64 * 1024);
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  const pad = 'p'.repeat(40 * 1024);

  c.sendSeq({ type: 'ht.sink', pad });
  await sleep(300);
  assert.equal(c.all.filter((m) => m?.type === 'session.ack').length, 0, '40 KiB: below 64 KiB and below 1 s, not sent on its own');

  const t0 = Date.now();
  c.sendSeq({ type: 'ht.sink', pad });
  const a = await c.next((m) => m.type === 'session.ack', 2500);
  assert.equal(a.ack, 2, 'accumulated past 64 KiB: acknowledged up to 2');
  assert.ok(Date.now() - t0 < 500, `does not wait for the 1 s timer (actual ${Date.now() - t0} ms)`);

  // Count recalculates from acknowledgment point: a small message is not acknowledged immediately,
  // only sent individually around 1 s
  const t1 = Date.now();
  c.sendSeq({ type: 'ht.sink' });
  const b = await c.next((m) => m.type === 'session.ack' && m.ack === 3, 2500);
  assert.ok(Date.now() - t1 >= 700, `a small message is sent on its own on the 1 s timer (actual ${Date.now() - t1} ms)`);
  assert.equal(b.ack, 3);
});

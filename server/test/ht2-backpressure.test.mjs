/**
 * HT2：背压接到会话层（契约 `docs/plan/http-transport-contract.md` 第 3.4 节、第 7 节；H.2、H.3 原样）。
 * 跑：node --test server/test/ht2-backpressure.test.mjs
 *
 * `buffered(connId)` 改为「这个会话里已写出、未确认的消息的字节数」：客户端不确认，积压就一直涨，
 * 与套接字读得快不快无关；传输断着的保留期里同样涨。只照契约写，没看实现；假设见 `ht-kit.mjs`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_SERVER, startService, openSession, openLegacy, resumeStatus, waitFor, sleep } from './ht-kit.mjs';

const T = { skip: SKIP_SERVER };
const KB = 1024;

test('HT2-no-ack the client keeps reading but never acknowledges: once unacknowledged bytes grow past maxPendingBytes, the core ends the session with 1013 backpressure (no retention)', T, async (t) => {
  const env = await startService({ highWaterBytes: 64 * KB, maxPendingBytes: 256 * KB, retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  // 分十批、每批 40 KiB，批间停一下：套接字早就读空了，涨的只是「未确认」
  for (let i = 0; i < 10; i++) {
    c.sendSeq({ type: 'ht.burst', count: 10, size: 4 * KB });
    await sleep(40);
    if (env.mod.disconnects.length) break;
  }
  const ev = await c.ended(5000);
  assert.deepEqual(ev, { code: 1013, reason: 'backpressure' });
  await waitFor(() => env.mod.disconnects.length === 1, 1500, 'the session ends immediately');
  assert.equal(await resumeStatus(env, c.sid, 0), 410, 'a backpressure end is not retained');
  const h = await env.health();
  assert.equal(h.backpressureCloses, 1);
});

test('HT2-legacy-compare comparison: the same traffic from an old client is not closed by backpressure (its backlog counts only what is in the socket)', async (t) => {
  const env = await startService({ highWaterBytes: 64 * KB, maxPendingBytes: 256 * KB, retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openLegacy(env);
  for (let i = 0; i < 10; i++) {
    c.send({ type: 'ht.burst', count: 10, size: 4 * KB });
    await sleep(40);
  }
  await waitFor(() => c.all.filter((m) => m.type === 'ht.blob').length === 100, 5000, 'all 100 received');
  assert.equal(env.mod.disconnects.length, 0);
  assert.equal((await env.health()).backpressureCloses, 0);
});

test('HT2-ack-releases the client acknowledges on time: the same volume does not trigger backpressure', T, async (t) => {
  const env = await startService({ highWaterBytes: 64 * KB, maxPendingBytes: 256 * KB, retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  for (let i = 0; i < 10; i++) {
    c.sendSeq({ type: 'ht.burst', count: 10, size: 4 * KB });
    await waitFor(() => c.all.filter((m) => m.type === 'ht.blob').length === (i + 1) * 10, 3000, `batch ${i + 1} fully received`);
    c.sendRaw({ type: 'session.ack', ack: c.ackOf() });
    await sleep(20);
  }
  assert.equal(env.mod.disconnects.length, 0, 'released once acknowledged');
  assert.equal((await env.health()).backpressureCloses, 0);
});

test('HT2-detached within the retention period the transport stays down while the server keeps writing: unacknowledged bytes growing past the limit likewise end the session with 1013, and a later resume gets 410', T, async (t) => {
  const env = await startService({ highWaterBytes: 64 * KB, maxPendingBytes: 256 * KB, retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  const connId = env.mod.connects[0].connId;
  c.close();
  await c.ended();
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 2000, 'detached');
  const pad = 'y'.repeat(4 * KB);
  for (let i = 0; i < 100 && env.mod.disconnects.length === 0; i++) env.mod.ctx.send(connId, { type: 'ht.blob', i, pad });
  await waitFor(() => env.mod.disconnects.length === 1, 1500, 'ended by backpressure within the retention period, without waiting for it to expire');
  assert.ok(env.logs.some((l) => l.event === 'conn.backpressure'), 'conn.backpressure log');
  assert.equal(await resumeStatus(env, c.sid, 0), 410);
  assert.equal((await env.health()).backpressureCloses, 1);
});

test('HT2-coalesce coalescing keys work as before: while unacknowledged bytes are above the high-water mark, messages with the same key entering the core\'s outbound queue keep only the last one; they are written out once acknowledgment advances (drained)', T, async (t) => {
  const env = await startService({ highWaterBytes: 10 * KB, maxPendingBytes: 1024 * KB, retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  c.sendSeq({ type: 'ht.burst', count: 3, size: 4 * KB }); // 前两条写出时还在 10 KiB 高水位以下，三条写完 12 KiB 未确认，过了高水位
  await waitFor(() => c.all.filter((m) => m.type === 'ht.blob').length === 3, 2000, 'first three written out');
  c.sendSeq({ type: 'ht.burst', count: 5, size: 100, key: 'k' });
  await sleep(200);
  assert.equal(c.all.filter((m) => m.type === 'ht.blob').length, 3, 'above the high-water mark: several same-key messages are queued and not yet written out');
  assert.equal((await env.health()).coalesced, 4, 'four of the five same-key messages are coalesced away');
  c.sendRaw({ type: 'session.ack', ack: c.ackOf() });
  await waitFor(() => c.all.filter((m) => m.type === 'ht.blob').length === 4, 2000, 'the remaining one is written out once acknowledgment advances');
  const last = c.all.filter((m) => m.type === 'ht.blob').at(-1);
  assert.equal(last.i, 4, 'the one kept is the last');
  assert.equal(last.seq, 4, `seq is assigned at write-out time: ${JSON.stringify({ i: last.i, seq: last.seq })}`);
});

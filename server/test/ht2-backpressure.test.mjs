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

test('HT2-no-ack 客户端一直读、但从不确认：未确认字节涨过 maxPendingBytes，核心以 1013 backpressure 结束会话（不保留）', T, async (t) => {
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
  await waitFor(() => env.mod.disconnects.length === 1, 1500, '会话立即结束');
  assert.equal(await resumeStatus(env, c.sid, 0), 410, '背压结束不保留');
  const h = await env.health();
  assert.equal(h.backpressureCloses, 1);
});

test('HT2-legacy-compare 对照：旧客户端同样的收发不会被背压关掉（它的积压只算套接字里的）', async (t) => {
  const env = await startService({ highWaterBytes: 64 * KB, maxPendingBytes: 256 * KB, retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openLegacy(env);
  for (let i = 0; i < 10; i++) {
    c.send({ type: 'ht.burst', count: 10, size: 4 * KB });
    await sleep(40);
  }
  await waitFor(() => c.all.filter((m) => m.type === 'ht.blob').length === 100, 5000, '100 条都收到');
  assert.equal(env.mod.disconnects.length, 0);
  assert.equal((await env.health()).backpressureCloses, 0);
});

test('HT2-ack-releases 客户端按时确认：同样的量不触发背压', T, async (t) => {
  const env = await startService({ highWaterBytes: 64 * KB, maxPendingBytes: 256 * KB, retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  for (let i = 0; i < 10; i++) {
    c.sendSeq({ type: 'ht.burst', count: 10, size: 4 * KB });
    await waitFor(() => c.all.filter((m) => m.type === 'ht.blob').length === (i + 1) * 10, 3000, `第 ${i + 1} 批收齐`);
    c.sendRaw({ type: 'session.ack', ack: c.ackOf() });
    await sleep(20);
  }
  assert.equal(env.mod.disconnects.length, 0, '确认了就释放');
  assert.equal((await env.health()).backpressureCloses, 0);
});

test('HT2-detached 保留期内传输断着，服务端继续写：未确认字节涨过上限同样以 1013 结束会话，之后接续 410', T, async (t) => {
  const env = await startService({ highWaterBytes: 64 * KB, maxPendingBytes: 256 * KB, retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  const connId = env.mod.connects[0].connId;
  c.close();
  await c.ended();
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 2000, '脱开');
  const pad = 'y'.repeat(4 * KB);
  for (let i = 0; i < 100 && env.mod.disconnects.length === 0; i++) env.mod.ctx.send(connId, { type: 'ht.blob', i, pad });
  await waitFor(() => env.mod.disconnects.length === 1, 1500, '保留期内因背压结束，不等保留期满');
  assert.ok(env.logs.some((l) => l.event === 'conn.backpressure'), '日志 conn.backpressure');
  assert.equal(await resumeStatus(env, c.sid, 0), 410);
  assert.equal((await env.health()).backpressureCloses, 1);
});

test('HT2-coalesce 合并键照常：未确认字节在高水位以上时进核心出站队列的同键消息只留最后一条；确认推进后写出（drained）', T, async (t) => {
  const env = await startService({ highWaterBytes: 10 * KB, maxPendingBytes: 1024 * KB, retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  c.sendSeq({ type: 'ht.burst', count: 3, size: 4 * KB }); // 前两条写出时还在 10 KiB 高水位以下，三条写完 12 KiB 未确认，过了高水位
  await waitFor(() => c.all.filter((m) => m.type === 'ht.blob').length === 3, 2000, '前三条写出');
  c.sendSeq({ type: 'ht.burst', count: 5, size: 100, key: 'k' });
  await sleep(200);
  assert.equal(c.all.filter((m) => m.type === 'ht.blob').length, 3, '高水位以上：同键的几条进队、还没写出');
  assert.equal((await env.health()).coalesced, 4, '五条同键合并掉四条');
  c.sendRaw({ type: 'session.ack', ack: c.ackOf() });
  await waitFor(() => c.all.filter((m) => m.type === 'ht.blob').length === 4, 2000, '确认推进后写出剩下的一条');
  const last = c.all.filter((m) => m.type === 'ht.blob').at(-1);
  assert.equal(last.i, 4, '留下的是最后一条');
  assert.equal(last.seq, 4, `seq 在写出时编：${JSON.stringify({ i: last.i, seq: last.seq })}`);
});

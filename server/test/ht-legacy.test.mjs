/**
 * HT 通用验收：旧客户端（握手里不带会话项）行为不变（契约 `docs/plan/http-transport-contract.md` 第 3.6 节、第 11 节「通用」）。
 * 跑：node --test server/test/ht-legacy.test.mjs
 *
 * 这组用例不依赖会话层到位：会话层合入前后都要通过（合入前它们描述的就是现状）。
 * 只照契约写，没看实现；公共件在 `ht-kit.mjs`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startService, openLegacy, waitFor, sleep, PROTOCOL } from './ht-kit.mjs';
import { createWsEndpoint } from '../render-node/ws-transport.mjs';

test('HT-legacy-1 不带会话项的握手照旧：101、只回显 promptcut.v1、没有 session.welcome，消息两个方向都不带 seq / ack', async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openLegacy(env);
  assert.equal(c.ws.protocol, PROTOCOL);
  c.send({ type: 'ht.echo', n: 1 });
  c.send({ type: 'ht.echo', n: 2 });
  await c.next((m) => m.type === 'ht.echoed' && m.n === 2);
  await sleep(1300); // 过了会话层单发确认的 1 s，旧客户端也不该收到 session.ack
  assert.equal(c.all.filter((m) => String(m?.type).startsWith('session.')).length, 0, `旧客户端收不到任何 session.* 控制消息：${JSON.stringify(c.all)}`);
  for (const m of c.all) {
    assert.ok(!('seq' in m) && !('ack' in m), `旧客户端收到的消息不带 seq / ack：${JSON.stringify(m)}`);
  }
  assert.deepEqual(env.mod.seen.map((s) => s.msg), [{ type: 'ht.echo', n: 1 }, { type: 'ht.echo', n: 2 }], '不带 seq 的消息照常交给模块、原样');
  env.service.send(env.mod.connects[0].connId, { type: 'ht.pushed' });
  const pushed = await c.next((m) => m.type === 'ht.pushed');
  assert.deepEqual(pushed, { type: 'ht.pushed' });
});

test('HT-legacy-2 旧客户端的传输一断会话就结束（保留时限相当于 0）：模块立即见断开', async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openLegacy(env);
  assert.equal(env.mod.connects.length, 1);
  c.close();
  await c.ended();
  await waitFor(() => env.mod.disconnects.length === 1, 1500, '旧客户端断开立即断线');
  assert.ok(env.logs.some((l) => l.event === 'conn.close'), '日志 conn.close 照旧');
});

test('HT-legacy-3 现有的 createWsEndpoint（升级前的桌面版与探针）照常连上、收发、断线重连', async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const ep = createWsEndpoint({ url: env.url, backoff: { baseMs: 20, maxMs: 50, jitter: 0 } });
  t.after(() => ep.close());
  const got = [];
  ep.onMessage((m) => got.push(m));
  let opens = 0;
  ep.onOpen(() => { opens += 1; });
  await waitFor(() => opens === 1, 3000, '连上');
  ep.send({ type: 'ht.echo', n: 7 });
  await waitFor(() => got.some((m) => m.type === 'ht.echoed'), 2000, '回包');
  assert.deepEqual(got.find((m) => m.type === 'ht.echoed'), { type: 'ht.echoed', n: 7 }, '回包不带 seq / ack');
  assert.equal(got.filter((m) => String(m?.type).startsWith('session.')).length, 0);
  // 服务端断它：旧端点照旧重连（新连接），模块见一次断开、两次 connect
  assert.equal(env.service.closeConn(env.mod.connects[0].connId, 1011, 'test'), true);
  await waitFor(() => opens === 2, 3000, '重连');
  assert.equal(env.mod.disconnects.length, 1);
  assert.equal(env.mod.connects.length, 2);
});

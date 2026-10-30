/**
 * 服务端会话层按字节确认（〔裁〕2026-09-27 主会话，契约 `docs/plan/http-transport-contract.md` 第 3.3 节）：
 * 收下的、还没确认的业务消息原文满 64 KiB 就立刻单发 `session.ack`，不等 32 条、也不等 1 s。客户端一侧的同一条规则
 * 由 `session-link.test.mjs` 的 SL-ack-bytes 测。
 * 跑：node --test server/test/docservice-session-ack.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startService, openSession, sleep } from './ht-kit.mjs';
import { SESSION_DEFAULTS } from '../docservice/session.mjs';

test('DS-ack-bytes 收下的未确认原文满 64 KiB：立刻单发 session.ack；不满时照旧等 1 s', async (t) => {
  assert.equal(SESSION_DEFAULTS.ACK_BYTES, 64 * 1024);
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  const pad = 'p'.repeat(40 * 1024);

  c.sendSeq({ type: 'ht.sink', pad });
  await sleep(300);
  assert.equal(c.all.filter((m) => m?.type === 'session.ack').length, 0, '40 KiB：不到 64 KiB、不到 1 s，不单发');

  const t0 = Date.now();
  c.sendSeq({ type: 'ht.sink', pad });
  const a = await c.next((m) => m.type === 'session.ack', 2500);
  assert.equal(a.ack, 2, '累计过 64 KiB：确认到 2');
  assert.ok(Date.now() - t0 < 500, `不等 1 s 计时（实际 ${Date.now() - t0} ms）`);

  // 计数从确认处重新算：一条小消息不立刻确认，1 s 左右才单发
  const t1 = Date.now();
  c.sendSeq({ type: 'ht.sink' });
  const b = await c.next((m) => m.type === 'session.ack' && m.ack === 3, 2500);
  assert.ok(Date.now() - t1 >= 700, `小消息按 1 s 计时单发（实际 ${Date.now() - t1} ms）`);
  assert.equal(b.ack, 3);
});

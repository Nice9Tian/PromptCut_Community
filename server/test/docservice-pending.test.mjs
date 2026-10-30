/**
 * 文档服务核心给模块的积压读数，以及项目快照取回按积压节流（契约 `docs/plan/render-queue-contract.md` J.11，用例 C8、C9）。
 * 跑：node --test server/test/docservice-pending.test.mjs
 *
 * 端口一律 0。慢连接用 `fake-raw-ws.mjs` 的原始 TCP 客户端：它能停读 socket，服务端的发送缓冲才会真的积压。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDocService } from '../docservice/service.mjs';
import { projectModule } from '../docservice/modules/project.mjs';
import { createMemoryStore } from '../docservice/store/index.mjs';
import { createWsEndpoint, createProjectClient } from '../render-node/index.mjs';
import { sleep, waitFor } from './fake-ws-kit.mjs';
import { rawWsClient } from './fake-raw-ws.mjs';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

async function startService(options) {
  const logs = [];
  const service = createDocService({ autoTick: false, log: (event, fields) => logs.push({ event, ...fields }), ...options });
  const { port } = await service.listen(0, '127.0.0.1');
  return { service, port, logs, backpressure: () => logs.filter((l) => l.event === 'conn.backpressure') };
}

test('C8 ctx.pendingBytes：积压时增加、排空后归零；连接不存在回 0；ctx.maxPendingBytes 是配置的上限', { timeout: 30_000 }, async (t) => {
  const MAX = 64 * 1024 * 1024;
  const PART = 'x'.repeat(256 * 1024);
  const N = 64;   // 共 16 MiB：本机回环的内核缓冲吞不下，停读时一定积压在服务端
  let ctxRef = null;
  let connRef = null;
  const probe = {
    name: 'pending-probe',
    types: ['pp.'],
    handle(ctx, connId, msg) {
      ctxRef = ctx;
      connRef = connId;
      if (msg.type === 'pp.flood') for (let i = 0; i < N; i += 1) ctx.send(connId, { type: 'pp.part', i, data: PART });
    },
  };
  const env = await startService({ modules: [probe], maxPendingBytes: MAX });
  t.after(() => env.service.close());

  const slow = await rawWsClient(env.port, { keep: false });
  t.after(() => slow.destroy());
  slow.send({ type: 'pp.hello' });
  await waitFor(() => ctxRef !== null, 3000, '模块收到第一条消息');

  assert.equal(ctxRef.maxPendingBytes, MAX, 'ctx.maxPendingBytes 是配置的上限');
  assert.equal(ctxRef.pendingBytes('no-such-conn'), 0, '连接不存在回 0');
  assert.equal(ctxRef.pendingBytes(connRef), 0, '空闲时积压为 0');

  slow.pause();
  slow.send({ type: 'pp.flood' });
  await waitFor(() => ctxRef.pendingBytes(connRef) > 0, 3000, '发出后积压增加');
  await sleep(300);
  const stuck = ctxRef.pendingBytes(connRef);
  assert.ok(stuck > 1024 * 1024, `停读期间积压保持在高位：${stuck} 字节`);
  assert.deepEqual(env.backpressure(), [], '上限给得够大，不会被 1013 断开');

  slow.resume();
  await waitFor(() => slow.stats.messages >= N, 20_000, `收齐 ${N} 条`);
  await waitFor(() => ctxRef.pendingBytes(connRef) === 0, 5000, '排空后积压归零');
  assert.equal(slow.closeFrame, null);
});

test('C9 慢消费者取回 5 MiB 快照：按积压节流，不被 1013 断开，完整收到', { timeout: 60_000 }, async (t) => {
  const env = await startService({ modules: [projectModule({ store: createMemoryStore() })] });   // maxPendingBytes 取缺省 1 MiB
  t.after(() => env.service.close());

  // 5 MiB 的项目 JSON，带中文与需要转义的字符
  const tracks = [];
  let text = '';
  for (let i = 0; Buffer.byteLength(text, 'utf8') < 5 * 1024 * 1024; i += 1) {
    for (let k = 0; k < 500; k += 1) tracks.push({ id: `t${tracks.length}`, name: `轨道 "${tracks.length}" \\ 中文`, pad: 'lorem ipsum '.repeat(8) });
    text = JSON.stringify({ id: 'c9', tracks });
  }
  const digest = sha256(text);

  // 上传方：正常速度的节点客户端
  const ep = createWsEndpoint({ url: `ws://127.0.0.1:${env.port}/`, log: () => {} });
  t.after(() => ep.close());
  await waitFor(() => ep.connected, 3000, '上传方连上');
  const client = createProjectClient(ep);
  const { projectRev } = await client.announce('c9', digest);
  await client.putSnapshot('c9', projectRev, digest, text);

  // 慢消费者：每读到一块就停读，按约 0.8 MiB/s 的速率再恢复
  const RATE = 0.8 * 1024 * 1024;
  const slow = await rawWsClient(env.port, { keep: true });
  t.after(() => slow.destroy());
  slow.sock.on('data', (chunk) => {
    slow.pause();
    setTimeout(() => slow.resume(), Math.ceil((chunk.length / RATE) * 1000));
  });
  const started = Date.now();
  slow.send({ type: 'project.snapshot.get', projectId: 'c9', projectRev, reqId: 'g' });
  let closed = false;
  slow.ended.then(() => { closed = true; });
  const isEnd = (m) => m?.type === 'project.snapshot.end' && m.reqId === 'g';
  await waitFor(() => closed || slow.inbox.some(isEnd), 50_000, '收到 end 或连接关闭');
  const outcome = slow.inbox.some(isEnd) ? 'end' : 'closed';
  const elapsed = Date.now() - started;

  assert.equal(outcome, 'end', `连接在收齐前被关：${JSON.stringify(slow.closeFrame)}`);
  assert.equal(slow.closeFrame, null, '没有收到关闭帧');
  assert.deepEqual(env.backpressure(), [], '没有背压断开');
  assert.ok(elapsed > 2000, `确实是慢消费者（用了 ${elapsed} ms）`);
  const parts = slow.inbox.filter((m) => m?.type === 'project.snapshot.part' && m.reqId === 'g');
  assert.ok(parts.length > 1, `分成多片：${parts.length}`);
  parts.forEach((p, i) => {
    assert.equal(p.index, i, '按 index 升序');
    assert.equal(p.count, parts.length, 'count 一致');
  });
  const joined = parts.map((p) => p.data).join('');
  assert.equal(joined.length, text.length);
  assert.ok(joined === text, '拼起来与原文逐字相同');
  assert.equal(sha256(joined), digest);
});

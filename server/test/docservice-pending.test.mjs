/**
 * Document service core backlog readings to modules, and project snapshot retrieval throttled by
 * backlog (contract `docs/plan/render-queue-contract.md` J.11, test cases C8, C9).
 * Run: node --test server/test/docservice-pending.test.mjs
 *
 * Ports are always 0. Slow connections use the raw TCP client from `fake-raw-ws.mjs`: it can stop
 * reading socket, so server send buffer truly backs up.
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

test('C8 ctx.pendingBytes: increases when a backlog builds and returns to zero once drained; returns 0 for a nonexistent connection; ctx.maxPendingBytes is the configured limit', { timeout: 30_000 }, async (t) => {
  const MAX = 64 * 1024 * 1024;
  const PART = 'x'.repeat(256 * 1024);
  const N = 64;   // 16 MiB total: local loopback kernel buffer cannot hold it; when reading stops, it definitely backs up on the server
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
  await waitFor(() => ctxRef !== null, 3000, 'the module received its first message');

  assert.equal(ctxRef.maxPendingBytes, MAX, 'ctx.maxPendingBytes is the configured limit');
  assert.equal(ctxRef.pendingBytes('no-such-conn'), 0, 'a nonexistent connection returns 0');
  assert.equal(ctxRef.pendingBytes(connRef), 0, 'backlog is 0 when idle');

  slow.pause();
  slow.send({ type: 'pp.flood' });
  await waitFor(() => ctxRef.pendingBytes(connRef) > 0, 3000, 'backlog increases after sending');
  await sleep(300);
  const stuck = ctxRef.pendingBytes(connRef);
  assert.ok(stuck > 1024 * 1024, `the backlog stays high while reading is paused: ${stuck} bytes`);
  assert.deepEqual(env.backpressure(), [], 'the limit is set high enough that the connection is not dropped with 1013');

  slow.resume();
  await waitFor(() => slow.stats.messages >= N, 20_000, `received all ${N} messages`);
  await waitFor(() => ctxRef.pendingBytes(connRef) === 0, 5000, 'backlog returns to zero after draining');
  assert.equal(slow.closeFrame, null);
});

test('C9 a slow consumer fetches a 5 MiB snapshot: throttled by backlog, not dropped with 1013, received in full', { timeout: 60_000 }, async (t) => {
  const env = await startService({ modules: [projectModule({ store: createMemoryStore() })] });   // maxPendingBytes takes default 1 MiB
  t.after(() => env.service.close());

  // 5 MiB project JSON, containing Chinese and characters that need escaping
  const tracks = [];
  let text = '';
  for (let i = 0; Buffer.byteLength(text, 'utf8') < 5 * 1024 * 1024; i += 1) {
    for (let k = 0; k < 500; k += 1) tracks.push({ id: `t${tracks.length}`, name: `轨道 "${tracks.length}" \\ 中文`, pad: 'lorem ipsum '.repeat(8) });
    text = JSON.stringify({ id: 'c9', tracks });
  }
  const digest = sha256(text);

  // Uploader: normal-speed node client
  const ep = createWsEndpoint({ url: `ws://127.0.0.1:${env.port}/`, log: () => {} });
  t.after(() => ep.close());
  await waitFor(() => ep.connected, 3000, 'the uploader connected');
  const client = createProjectClient(ep);
  const { projectRev } = await client.announce('c9', digest);
  await client.putSnapshot('c9', projectRev, digest, text);

  // Slow consumer: pauses reading after each chunk read, resumes at a rate of about 0.8 MiB/s
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
  await waitFor(() => closed || slow.inbox.some(isEnd), 50_000, 'received end or the connection closed');
  const outcome = slow.inbox.some(isEnd) ? 'end' : 'closed';
  const elapsed = Date.now() - started;

  assert.equal(outcome, 'end', `the connection was closed before everything was received: ${JSON.stringify(slow.closeFrame)}`);
  assert.equal(slow.closeFrame, null, 'no close frame received');
  assert.deepEqual(env.backpressure(), [], 'no backpressure disconnect');
  assert.ok(elapsed > 2000, `it really was a slow consumer (took ${elapsed} ms)`);
  const parts = slow.inbox.filter((m) => m?.type === 'project.snapshot.part' && m.reqId === 'g');
  assert.ok(parts.length > 1, `split into multiple parts: ${parts.length}`);
  parts.forEach((p, i) => {
    assert.equal(p.index, i, 'ascending by index');
    assert.equal(p.count, parts.length, 'count is consistent');
  });
  const joined = parts.map((p) => p.data).join('');
  assert.equal(joined.length, text.length);
  assert.ok(joined === text, 'the joined text is identical to the original, character for character');
  assert.equal(sha256(joined), digest);
});

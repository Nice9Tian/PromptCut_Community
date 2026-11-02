/**
 * HT3: Equivalence (contract `docs/plan/http-transport-contract.md` section 11 HT3; HT-a runs only
 * "WebSocket-only" and "disconnect mid-way then resume").
 * Run: node --test server/test/ht3-equivalence.test.mjs
 *
 * Run the same business script twice: once with transport never disconnecting; once cutting
 * transport before and after each step (controllable TCP proxy `cutAll()`) to let the session
 * resume. Business results recorded across both runs (excluding fields that vary each time, such as
 * timestamps, lease expiration times, and epoch) must match item-by-item. Covers: render-queue
 * claim, complete, and release on disconnect; project commit and stale; content put and watch.
 * Client is `createDocEndpoint` (assumption H10), and server is `createDocService` mounted with
 * real modules; runs only when session layers on both sides are in place. Written strictly to the
 * contract without looking at the implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SKIP_BOTH, ROOT, PROTOCOL, startService, loadDocEndpoint, waitFor, sleep } from './ht-kit.mjs';
import { createTcpProxy, snapshotTaskInput } from './fake-ws-kit.mjs';

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && Object.hasOwn(o, k)).map((k) => [k, o[k]]));

async function client(url, user, createDocEndpoint) {
  const got = [];
  const ep = createDocEndpoint({
    url,
    protocols: () => [PROTOCOL, `promptcut.user.${user}`],
    backoff: { baseMs: 20, factor: 2, maxMs: 100, jitter: 0 },
    transport: 'ws',
  });
  let opens = 0;
  ep.onOpen(() => { opens += 1; });
  ep.onMessage((m) => got.push(m));
  await waitFor(() => opens === 1, 4000, `${user} creates a session`);
  let n = 0;
  return {
    ep,
    got,
    /** Send a request with reqId and wait for a response with the same reqId */
    async rpc(msg, ms = 5000) {
      const reqId = `${user}-${++n}`;
      ep.send({ ...msg, reqId });
      return waitFor(() => got.find((m) => m.reqId === reqId), ms, `reply to ${msg.type}`);
    },
    wait: (pred, what, ms = 5000) => waitFor(() => got.find(pred), ms, what),
  };
}

async function runScenario(t, mode) {
  const [{ projectModule }, { contentModule }, { createMemoryStore }, { createRenderQueue }] = await Promise.all([
    imp('server/docservice/modules/project.mjs'), imp('server/docservice/modules/content.mjs'),
    imp('server/docservice/store/index.mjs'), imp('server/render-queue/index.mjs'),
  ]);
  const env = await startService({
    retainMs: 60_000,
    modules: [projectModule({ store: createMemoryStore(), now: Date.now }), contentModule({ store: createMemoryStore(), now: Date.now })],
  });
  t.after(env.cleanup);
  const queue = createRenderQueue({ now: Date.now, send: env.service.send, constants: { RECONNECT_GRACE_MS: 0 } });
  env.service.mountRenderQueue(queue);
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const { createDocEndpoint } = await loadDocEndpoint();
  const url = `ws://127.0.0.1:${proxy.port}/`;
  const A = await client(url, 'alice', createDocEndpoint); // Publisher + page
  const N = await client(url, 'nora', createDocEndpoint); // Render node
  const B = await client(url, 'bob', createDocEndpoint); // Second node (watch-only) + page
  t.after(() => { for (const c of [A, N, B]) c.ep.close(); });

  let cuts = 0;
  const cut = async () => {
    if (mode !== 'resume') return;
    cuts += 1;
    proxy.cutAll();
    await sleep(5);
  };
  const out = [];
  const rec = (label, value) => out.push([label, value]);

  // ---- render-queue: check in, publish
  rec('node.welcome', pick(await N.rpc({ type: 'node.hello', nodeId: 'n1', profile: 'pc' }), ['type', 'nodeId', 'resumed', 'lost']));
  rec('queue.snapshot', (await N.rpc({ type: 'queue.watch', projects: 'all' })).tasks?.map((x) => x.id));
  await B.rpc({ type: 'node.hello', nodeId: 'n2', profile: 'pc' });
  await B.rpc({ type: 'queue.watch', projects: 'all' });
  rec('publisher.welcome', pick(await A.rpc({ type: 'publisher.hello', publisherId: 'p1' }), ['type', 'publisherId']));
  const t1 = snapshotTaskInput({ resultKey: 'ht3-a', projectId: 'proj', projectRev: 1 });
  const t2 = snapshotTaskInput({ resultKey: 'ht3-b', projectId: 'proj', projectRev: 1 });
  await cut();
  rec('task.published', (await A.rpc({ type: 'task.publish', tasks: [t1, t2] })).results);
  await N.wait((m) => m.type === 'task.opened' && m.task?.id === t2.id, 'N sees task.opened');
  rec('opened@N', N.got.filter((m) => m.type === 'task.opened').map((m) => m.task.id).sort());

  // ---- Claim, complete
  await cut();
  const c1 = await N.rpc({ type: 'task.claim', id: t1.id, expectVersion: 1 });
  rec('task.claimed', { ...pick(c1, ['type', 'id', 'token', 'version']), state: c1.task?.state });
  await cut();
  rec('task.completed', pick(await N.rpc({ type: 'task.complete', id: t1.id, token: c1.token, result: { ranges: [[0, 29]] } }), ['type', 'id']));
  await cut();
  const done = await A.wait((m) => m.type === 'task.done' && m.id === t1.id, 'A receives task.done');
  rec('task.done@A', pick(done, ['id', 'resultKey', 'projectId', 'projectRev', 'result']));
  rec('taken@B', pick(await B.wait((m) => m.type === 'task.taken' && m.id === t1.id, 'B sees task.taken'), ['id', 'version']));
  rec('closed@B', pick(await B.wait((m) => m.type === 'task.closed' && m.id === t1.id, 'B sees task.closed'), ['id', 'state']));

  // ---- Release on disconnect: transport disconnect does not release; release only when session ends
  const c2 = await N.rpc({ type: 'task.claim', id: t2.id, expectVersion: 1 });
  rec('task.claimed#2', pick(c2, ['type', 'id', 'token', 'version']));
  await cut();
  await sleep(30);
  env.service.tick();
  await sleep(50);
  rec('still-claimed-after-transport-cut', !B.got.some((m) => m.type === 'task.opened' && m.task?.id === t2.id && m.task?.version > 2));
  const openedBefore = B.got.length;
  N.ep.close();
  await waitFor(() => env.service.describe().conns.length === 2, 3000, 'N\'s session ends');
  await sleep(10);
  env.service.tick();
  const back = await waitFor(() => B.got.slice(openedBefore).find((m) => m.type === 'task.opened' && m.task?.id === t2.id), 3000, 'B sees t2 put back');
  rec('reopened@B', pick(back.task, ['id', 'state', 'version', 'attempts']));

  // ---- project: commit and stale
  rec('project.state@A', pick(await A.rpc({ type: 'project.open', projectId: 'proj' }), ['type', 'projectId', 'rev']));
  rec('project.state@B', pick(await B.rpc({ type: 'project.open', projectId: 'proj' }), ['type', 'projectId', 'rev']));
  await cut();
  rec('project.op.ok', pick(await A.rpc({ type: 'project.op', projectId: 'proj', opId: 'o1', expectRev: 0, ops: [{ op: 'set', path: '', value: { a: 1 } }] }), ['type', 'rev']));
  await cut();
  rec('project.ops@B', pick(await B.wait((m) => m.type === 'project.ops' && m.rev === 1, 'B receives project.ops'), ['type', 'rev', 'ops']));
  const stale = await B.rpc({ type: 'project.op', projectId: 'proj', opId: 'o2', expectRev: 0, ops: [{ op: 'set', path: '/a', value: 2 }] });
  rec('project.op.rejected', pick(stale, ['type', 'reason']));

  // ---- content: watch and put
  rec('content.watching', pick(await B.rpc({ type: 'content.watch', kinds: ['card-source'] }), ['type', 'kinds']));
  await cut();
  rec('content.stored', pick(await A.rpc({ type: 'content.put', kind: 'card-source', key: 'cards/x', body: { v: 1 } }), ['type', 'kind', 'key', 'rev', 'hash']));
  await cut();
  rec('content.changed@B', pick(await B.wait((m) => m.type === 'content.changed' && m.key === 'cards/x', 'B receives content.changed'), ['type', 'kind', 'key', 'rev', 'hash']));
  rec('content.item', pick(await B.rpc({ type: 'content.get', kind: 'card-source', key: 'cards/x' }), ['type', 'body', 'rev']));

  // Business messages have neither seq / ack nor error on either side
  for (const c of [A, N, B]) {
    for (const m of c.got) assert.ok(!('seq' in m) && !('ack' in m), `the upper layer cannot see seq / ack: ${JSON.stringify(m)}`);
    assert.deepEqual(c.got.filter((m) => m.type === 'error'), [], 'no error replies');
  }
  const stats = { A: A.ep.stats(), B: B.ep.stats() };
  const health = await env.health();
  return { out, cuts, stats, health };
}

test('HT3-ws-vs-resume the same sequence of operations (queue claim / completion / put back on disconnect, project commit and stale, content store put and watch): over WebSocket only versus with mid-run disconnects and resumes, the results are identical item by item', { skip: SKIP_BOTH, timeout: 60_000 }, async (t) => {
  const plain = await runScenario(t, 'ws');
  const resumed = await runScenario(t, 'resume');
  assert.equal(plain.cuts, 0);
  assert.ok(resumed.cuts >= 8, `the disconnect-and-resume run did drop multiple times (${resumed.cuts})`);
  assert.ok(resumed.stats.A.resumes >= 1 && resumed.stats.B.resumes >= 1, `the endpoints did resume: ${JSON.stringify(resumed.stats)}`);
  assert.ok(resumed.health.sessions.resumed >= 2, `the server recorded the resumes: ${JSON.stringify(resumed.health.sessions)}`);
  assert.equal(plain.health.sessions.resumed, 0);
  assert.deepEqual(resumed.out, plain.out, 'the results of the two runs are identical item by item');
  // Release was indeed caused by session termination, not transport disconnection
  assert.deepEqual(plain.out.find(([k]) => k === 'still-claimed-after-transport-cut')[1], true);
});

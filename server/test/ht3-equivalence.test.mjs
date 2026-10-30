/**
 * HT3：等价性（契约 `docs/plan/http-transport-contract.md` 第 11 节 HT3；HT-a 只跑「只走 WebSocket」与「中途断开再接续」两种）。
 * 跑：node --test server/test/ht3-equivalence.test.mjs
 *
 * 同一段业务脚本跑两遍：一遍传输从不断；一遍在每一步前后把传输掐断（可控 TCP 代理 `cutAll()`），让会话接续。
 * 两遍记下的业务结果（去掉时间戳、租约到期时刻、epoch 这类每次都变的字段）必须逐项相同。覆盖：
 * render-queue 的认领、完成、断线放回；project 的提交与 stale；content 的 put 与 watch。
 * 客户端是 `createDocEndpoint`（假设 H10），服务端是 `createDocService` 挂真模块；两边会话层都到位才跑。
 * 只照契约写，没看实现。
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
  await waitFor(() => opens === 1, 4000, `${user} 建会话`);
  let n = 0;
  return {
    ep,
    got,
    /** 发一条带 reqId 的请求，等带同一 reqId 的回包 */
    async rpc(msg, ms = 5000) {
      const reqId = `${user}-${++n}`;
      ep.send({ ...msg, reqId });
      return waitFor(() => got.find((m) => m.reqId === reqId), ms, `${msg.type} 的回包`);
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
  const A = await client(url, 'alice', createDocEndpoint); // 发布方 + 页面
  const N = await client(url, 'nora', createDocEndpoint); // 渲染节点
  const B = await client(url, 'bob', createDocEndpoint); // 第二个节点（只看）+ 页面
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

  // ---- render-queue：报到、发布
  rec('node.welcome', pick(await N.rpc({ type: 'node.hello', nodeId: 'n1', profile: 'pc' }), ['type', 'nodeId', 'resumed', 'lost']));
  rec('queue.snapshot', (await N.rpc({ type: 'queue.watch', projects: 'all' })).tasks?.map((x) => x.id));
  await B.rpc({ type: 'node.hello', nodeId: 'n2', profile: 'pc' });
  await B.rpc({ type: 'queue.watch', projects: 'all' });
  rec('publisher.welcome', pick(await A.rpc({ type: 'publisher.hello', publisherId: 'p1' }), ['type', 'publisherId']));
  const t1 = snapshotTaskInput({ resultKey: 'ht3-a', projectId: 'proj', projectRev: 1 });
  const t2 = snapshotTaskInput({ resultKey: 'ht3-b', projectId: 'proj', projectRev: 1 });
  await cut();
  rec('task.published', (await A.rpc({ type: 'task.publish', tasks: [t1, t2] })).results);
  await N.wait((m) => m.type === 'task.opened' && m.task?.id === t2.id, 'N 看到 task.opened');
  rec('opened@N', N.got.filter((m) => m.type === 'task.opened').map((m) => m.task.id).sort());

  // ---- 认领、完成
  await cut();
  const c1 = await N.rpc({ type: 'task.claim', id: t1.id, expectVersion: 1 });
  rec('task.claimed', { ...pick(c1, ['type', 'id', 'token', 'version']), state: c1.task?.state });
  await cut();
  rec('task.completed', pick(await N.rpc({ type: 'task.complete', id: t1.id, token: c1.token, result: { ranges: [[0, 29]] } }), ['type', 'id']));
  await cut();
  const done = await A.wait((m) => m.type === 'task.done' && m.id === t1.id, 'A 收到 task.done');
  rec('task.done@A', pick(done, ['id', 'resultKey', 'projectId', 'projectRev', 'result']));
  rec('taken@B', pick(await B.wait((m) => m.type === 'task.taken' && m.id === t1.id, 'B 看到 task.taken'), ['id', 'version']));
  rec('closed@B', pick(await B.wait((m) => m.type === 'task.closed' && m.id === t1.id, 'B 看到 task.closed'), ['id', 'state']));

  // ---- 断线放回：传输断不放回；会话结束才放回
  const c2 = await N.rpc({ type: 'task.claim', id: t2.id, expectVersion: 1 });
  rec('task.claimed#2', pick(c2, ['type', 'id', 'token', 'version']));
  await cut();
  await sleep(30);
  env.service.tick();
  await sleep(50);
  rec('still-claimed-after-transport-cut', !B.got.some((m) => m.type === 'task.opened' && m.task?.id === t2.id && m.task?.version > 2));
  const openedBefore = B.got.length;
  N.ep.close();
  await waitFor(() => env.service.describe().conns.length === 2, 3000, 'N 的会话结束');
  await sleep(10);
  env.service.tick();
  const back = await waitFor(() => B.got.slice(openedBefore).find((m) => m.type === 'task.opened' && m.task?.id === t2.id), 3000, 'B 看到 t2 放回');
  rec('reopened@B', pick(back.task, ['id', 'state', 'version', 'attempts']));

  // ---- project：提交与 stale
  rec('project.state@A', pick(await A.rpc({ type: 'project.open', projectId: 'proj' }), ['type', 'projectId', 'rev']));
  rec('project.state@B', pick(await B.rpc({ type: 'project.open', projectId: 'proj' }), ['type', 'projectId', 'rev']));
  await cut();
  rec('project.op.ok', pick(await A.rpc({ type: 'project.op', projectId: 'proj', opId: 'o1', expectRev: 0, ops: [{ op: 'set', path: '', value: { a: 1 } }] }), ['type', 'rev']));
  await cut();
  rec('project.ops@B', pick(await B.wait((m) => m.type === 'project.ops' && m.rev === 1, 'B 收到 project.ops'), ['type', 'rev', 'ops']));
  const stale = await B.rpc({ type: 'project.op', projectId: 'proj', opId: 'o2', expectRev: 0, ops: [{ op: 'set', path: '/a', value: 2 }] });
  rec('project.op.rejected', pick(stale, ['type', 'reason']));

  // ---- content：watch 与 put
  rec('content.watching', pick(await B.rpc({ type: 'content.watch', kinds: ['card-source'] }), ['type', 'kinds']));
  await cut();
  rec('content.stored', pick(await A.rpc({ type: 'content.put', kind: 'card-source', key: 'cards/x', body: { v: 1 } }), ['type', 'kind', 'key', 'rev', 'hash']));
  await cut();
  rec('content.changed@B', pick(await B.wait((m) => m.type === 'content.changed' && m.key === 'cards/x', 'B 收到 content.changed'), ['type', 'kind', 'key', 'rev', 'hash']));
  rec('content.item', pick(await B.rpc({ type: 'content.get', kind: 'card-source', key: 'cards/x' }), ['type', 'body', 'rev']));

  // 业务消息两边都没有 seq / ack，也没有 error
  for (const c of [A, N, B]) {
    for (const m of c.got) assert.ok(!('seq' in m) && !('ack' in m), `上层看不到 seq / ack：${JSON.stringify(m)}`);
    assert.deepEqual(c.got.filter((m) => m.type === 'error'), [], '没有 error 回包');
  }
  const stats = { A: A.ep.stats(), B: B.ep.stats() };
  const health = await env.health();
  return { out, cuts, stats, health };
}

test('HT3-ws-vs-resume 同一段业务（队列认领 / 完成 / 断线放回、项目提交与 stale、内容库 put 与 watch）：只走 WebSocket 与中途断开再接续，结果逐项相同', { skip: SKIP_BOTH, timeout: 60_000 }, async (t) => {
  const plain = await runScenario(t, 'ws');
  const resumed = await runScenario(t, 'resume');
  assert.equal(plain.cuts, 0);
  assert.ok(resumed.cuts >= 8, `断开再接续那一遍确实断了多次（${resumed.cuts}）`);
  assert.ok(resumed.stats.A.resumes >= 1 && resumed.stats.B.resumes >= 1, `端点确实接续过：${JSON.stringify(resumed.stats)}`);
  assert.ok(resumed.health.sessions.resumed >= 2, `服务端记了接续：${JSON.stringify(resumed.health.sessions)}`);
  assert.equal(plain.health.sessions.resumed, 0);
  assert.deepEqual(resumed.out, plain.out, '两遍的业务结果逐项相同');
  // 放回确实是会话结束引起的，不是传输断开引起的
  assert.deepEqual(plain.out.find(([k]) => k === 'still-claimed-after-transport-cut')[1], true);
});

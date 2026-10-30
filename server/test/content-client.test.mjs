/**
 * 内容库客户端（契约 `docs/plan/manifest-contract.md` 第 2 节，第 6 节用例 Q1～Q3）。
 * 跑：node --test server/test/content-client.test.mjs
 *
 * 只照契约写，不看实现。
 *
 * 约定：
 *   - 真文档服务：独立模式、端口 0、`autoTick: false`，挂 C6.3 的内容库模块（memory 存储）；
 *     连接用 M5a 的 `createWsEndpoint`，客户端 `createContentClient(endpoint, { timeoutMs })`（见 `fake-manifest-env.mjs`）。
 *   - 「服务端不回」：挂一个吞掉 `content.*` 的假模块（不回包），或者用一个假端点（只记下发出的消息，
 *     由测试决定何时、按什么顺序回包、何时断线）。假端点只满足 `WsEndpoint` 的形状：
 *     `send` / `onMessage` / `onOpen` / `onClose` / `connected` / `closed` / `close` / `stats`。
 *   - 回包形状照 C6.3 契约第 2 节：`content.stored` / `content.item`（`missing: true`）/ `content.listing` / `error { reason }`。
 *
 * `server/render-node/content-client.mjs` 还不存在时每条用例各自失败、报原因。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  loadContentClient, startContentService, connectContent, connectEndpoint, until,
} from './fake-manifest-env.mjs';

const hashOf = (body) => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

/** 吞掉 content.* 的模块：收到什么都不回（模拟「服务端不回」） */
const silentModule = () => ({ name: 'silent-content', types: ['content.'], channels: [], handle() {} });

/** 假端点：满足 WsEndpoint 的形状，测试手动回包、断线、重连 */
function fakeEndpoint() {
  const handlers = { message: [], open: [], close: [] };
  const sent = [];
  let connected = true;
  let closed = false;
  return {
    sent,
    send(message) {
      if (!connected) return false;
      sent.push(JSON.parse(JSON.stringify(message)));
      return true;
    },
    onMessage(h) { handlers.message.push(h); },
    onOpen(h) { handlers.open.push(h); },
    onClose(h) { handlers.close.push(h); },
    close() { closed = true; connected = false; },
    get connected() { return connected; },
    get closed() { return closed; },
    stats: () => ({ opens: 1, closes: 0, sent: sent.length, received: 0, dropped: 0, badFrames: 0 }),
    deliver(message) { for (const h of [...handlers.message]) h(JSON.parse(JSON.stringify(message))); },
    drop() { connected = false; for (const h of [...handlers.close]) h({ code: 1006, reason: '' }); },
    reopen() { connected = true; for (const h of [...handlers.open]) h(); },
  };
}

/** 等一个 promise 落定，回 { ok, value | error, ms } */
async function settleOf(promise) {
  const t0 = Date.now();
  try { return { ok: true, value: await promise, ms: Date.now() - t0 }; } catch (error) { return { ok: false, error, ms: Date.now() - t0 }; }
}

/* ------------------------------------------------------------------ Q1 */

test('Q1 put 后 get 取回相同的正文；missing 回 null；list 按前缀、按 key 升序；错误回包带 reason 抛出', async (t) => {
  const env = await startContentService();
  t.after(env.cleanup);
  const { content } = await connectContent(env);

  const rk = 'a'.repeat(64);
  const body = { v: 1, kind: 'snapshot', tier: 'shared', resultKey: rk, dirKey: rk, entryKey: null, range: { from: 0, to: 59 }, canvasHeavy: false,
    frames: [[0, 'b'.repeat(64), 123], [1, 'c'.repeat(64), 456]] };
  const stored = await content.put('snapshot-manifest', `${rk}:0-59`, body);
  assert.equal(stored.hash, hashOf(body), 'put 回的 hash = sha256(JSON.stringify(body))');
  assert.equal(stored.rev, undefined, '清单类没有 rev');

  const got = await content.get('snapshot-manifest', `${rk}:0-59`);
  assert.ok(got, 'get 取得到');
  assert.deepEqual(got.body, body, '正文原样取回');
  assert.equal(got.hash, stored.hash);

  assert.equal(await content.get('snapshot-manifest', `${rk}:60-119`), null, '没有的键回 null');
  assert.equal(await content.get('render-manifest', `${rk}:0-59`), null, '别的 kind 下没有');

  // card-source 带 rev
  const r1 = await content.put('card-source', 'card/x', { src: 1 });
  const r2 = await content.put('card-source', 'card/x', { src: 1 });
  assert.deepEqual([r1.rev, r2.rev], [1, 2], 'card-source 的 rev 透传');
  assert.equal((await content.get('card-source', 'card/x')).rev, 2);

  // list 按前缀、升序
  const other = 'd'.repeat(64);
  for (const key of [`${rk}:120-129`, `${other}:0-59`, `${rk}:60-119`]) await content.put('snapshot-manifest', key, { k: key });
  const listed = await content.list('snapshot-manifest', `${rk}:`);
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.items.map((i) => i.key), [`${rk}:0-59`, `${rk}:120-129`, `${rk}:60-119`], '按前缀过滤、按 key 升序');
  assert.equal(listed.items[0].hash, stored.hash, 'items 带 hash');
  const all = await content.list('snapshot-manifest');
  assert.equal(all.items.length, 4, '不给前缀列全部');

  // 服务端回 error：按 reqId 抛出，带 reason
  const tooBig = await settleOf(content.put('snapshot-manifest', 'big', { blob: 'x'.repeat(300 * 1024) }));
  assert.equal(tooBig.ok, false, '超过 256 KiB 的正文被拒');
  assert.equal(tooBig.error.reason, 'too-large', `错误带 reason：${tooBig.error?.message}`);
  const badKind = await settleOf(content.get('no-such-kind', 'k'));
  assert.equal(badKind.ok, false);
  assert.equal(badKind.error.reason, 'bad-message');
  // 错误之后客户端照常可用
  assert.deepEqual((await content.get('snapshot-manifest', `${rk}:0-59`)).body, body);

  // render-node/index.mjs 也要转出（契约第 7 节「加出」）
  const idx = await import('../render-node/index.mjs');
  assert.equal(idx.createContentClient, (await loadContentClient()).createContentClient, 'render-node/index.mjs 转出 createContentClient');
});

/* ------------------------------------------------------------------ Q2 */

test('Q2 并发 20 个请求：每个带唯一 reqId、按 reqId 配对，结果不串（真服务）', async (t) => {
  const env = await startContentService();
  t.after(env.cleanup);
  const { createContentClient } = await loadContentClient();
  const endpoint = await connectEndpoint(env.url('node-a'), { env });
  const sent = [];
  const rawSend = endpoint.send.bind(endpoint);
  // 包一层 send 数请求（在建客户端之前包，客户端拿到的就是包过的）
  const counted = { ...endpoint, send: (m) => { sent.push(m); return rawSend(m); }, onMessage: endpoint.onMessage, onOpen: endpoint.onOpen, onClose: endpoint.onClose,
    close: endpoint.close, stats: endpoint.stats, get connected() { return endpoint.connected; }, get closed() { return endpoint.closed; } };
  const content = createContentClient(counted);

  const keys = Array.from({ length: 20 }, (_, i) => `seg-${String(i).padStart(2, '0')}`);
  const bodies = keys.map((k, i) => ({ key: k, n: i, pad: 'z'.repeat(i * 97) }));
  const stored = await Promise.all(keys.map((k, i) => content.put('render-manifest', k, bodies[i])));
  stored.forEach((s, i) => assert.equal(s.hash, hashOf(bodies[i]), `第 ${i} 个 put 的回包对得上自己的正文`));

  // 20 个 get 与 20 个 put / list 混在一起并发
  const ops = [];
  for (let i = 0; i < 20; i++) {
    ops.push(content.get('render-manifest', keys[i]).then((r) => ['get', i, r]));
    if (i % 5 === 0) ops.push(content.list('render-manifest', keys[i]).then((r) => ['list', i, r]));
    if (i % 4 === 0) ops.push(content.get('render-manifest', `missing-${i}`).then((r) => ['miss', i, r]));
  }
  for (const [op, i, r] of await Promise.all(ops)) {
    if (op === 'get') assert.deepEqual(r?.body, bodies[i], `get ${keys[i]} 取回自己的正文`);
    else if (op === 'list') assert.deepEqual(r.items.map((x) => x.key), [keys[i]], `list ${keys[i]} 只列自己`);
    else assert.equal(r, null, `missing-${i} 回 null`);
  }
  const reqIds = sent.map((m) => m.reqId);
  assert.ok(reqIds.every((id) => id !== undefined && id !== null), '每个请求都带 reqId');
  assert.equal(new Set(reqIds).size, reqIds.length, `reqId 互不相同（${reqIds.length} 个请求）`);
  assert.ok(sent.every((m) => typeof m.type === 'string' && m.type.startsWith('content.')), '发的是 content.* 消息');
});

test('Q2 回包乱序、夹着无关消息：仍按 reqId 配对（假端点）', async () => {
  const { createContentClient } = await loadContentClient();
  const ep = fakeEndpoint();
  const content = createContentClient(ep, { timeoutMs: 5000 });
  const N = 20;
  const pending = [];
  for (let i = 0; i < N; i++) pending.push(i % 2 ? content.get('snapshot-manifest', `k${i}`) : content.put('snapshot-manifest', `k${i}`, { i }));
  await until(() => ep.sent.length === N, { timeoutMs: 2000, what: () => `只发出 ${ep.sent.length} 个请求` });
  assert.equal(new Set(ep.sent.map((m) => m.reqId)).size, N, 'reqId 唯一');

  // 无关消息：别的模块的推送、没带 reqId 的、带陌生 reqId 的
  ep.deliver({ type: 'queue.snapshot', tasks: [] });
  ep.deliver({ type: 'content.changed', kind: 'snapshot-manifest', key: 'k0', hash: 'f'.repeat(64) });
  ep.deliver({ type: 'content.item', kind: 'snapshot-manifest', key: 'k1', body: { wrong: true }, hash: 'e'.repeat(64), reqId: 'not-mine' });
  // 倒序回包
  for (const m of [...ep.sent].reverse()) {
    const i = Number(m.key.slice(1));
    if (m.type === 'content.put') ep.deliver({ type: 'content.stored', kind: m.kind, key: m.key, hash: hashOf(m.body), reqId: m.reqId });
    else if (i % 4 === 1) ep.deliver({ type: 'content.item', kind: m.kind, key: m.key, missing: true, reqId: m.reqId });
    else ep.deliver({ type: 'content.item', kind: m.kind, key: m.key, body: { i }, hash: hashOf({ i }), reqId: m.reqId });
  }
  const results = await Promise.all(pending);
  results.forEach((r, i) => {
    if (i % 2 === 0) assert.equal(r.hash, hashOf({ i }), `put k${i}`);
    else if (i % 4 === 1) assert.equal(r, null, `get k${i} missing → null`);
    else assert.deepEqual(r?.body, { i }, `get k${i}`);
  });
});

/* ------------------------------------------------------------------ Q3 */

test('Q3 服务端不回：超时抛 code: timeout（真服务，挂一个不回包的模块）', async (t) => {
  const env = await startContentService({ modules: [silentModule()] });
  t.after(env.cleanup);
  const { content } = await connectContent(env, { timeoutMs: 300 });
  const r = await settleOf(content.get('snapshot-manifest', 'k'));
  assert.equal(r.ok, false, '不回包就失败');
  assert.equal(r.error.code, 'timeout', `错误带 code: timeout：${r.error?.message}`);
  assert.ok(r.ms >= 250 && r.ms < 3000, `按 timeoutMs 计时：${r.ms} ms`);
  const p = await settleOf(content.put('snapshot-manifest', 'k', { a: 1 }));
  assert.equal(p.error?.code, 'timeout', 'put 同样超时');
});

test('Q3 断线：在途请求立即以 code: disconnected 失败，不等超时（真服务）', async (t) => {
  const env = await startContentService({ modules: [silentModule()] });
  t.after(env.cleanup);
  const { endpoint, content } = await connectContent(env, { timeoutMs: 20_000 });
  const inflight = [content.get('snapshot-manifest', 'a'), content.put('snapshot-manifest', 'b', { b: 1 }), content.list('snapshot-manifest', '')].map(settleOf);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const closedSeen = new Promise((resolve) => endpoint.onClose(resolve));
  await env.service.close(); // 服务端断开全部连接
  await closedSeen;
  const t0 = Date.now();
  const results = await Promise.all(inflight);
  assert.ok(Date.now() - t0 < 2000, '断线后立即失败，不等 20 s 的超时');
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'disconnected', `错误带 code: disconnected：${r.error?.message}`);
  }
});

test('Q3 断线不重放：重连之后不重发在途请求；超时后迟到的回包被忽略（假端点）', async () => {
  const { createContentClient } = await loadContentClient();
  const ep = fakeEndpoint();
  const content = createContentClient(ep, { timeoutMs: 150 });

  // 超时，然后回包迟到：不抛、不影响后面的请求
  const late = settleOf(content.get('snapshot-manifest', 'late'));
  await until(() => ep.sent.length === 1);
  const lateReq = ep.sent[0];
  const r0 = await late;
  assert.equal(r0.error?.code, 'timeout');
  ep.deliver({ type: 'content.item', kind: 'snapshot-manifest', key: 'late', body: { x: 1 }, hash: hashOf({ x: 1 }), reqId: lateReq.reqId });

  // 在途 3 个，断线：全部立即 disconnected
  const inflight = [content.get('snapshot-manifest', 'a'), content.put('snapshot-manifest', 'b', { b: 1 }), content.list('render-manifest')].map(settleOf);
  await until(() => ep.sent.length === 4);
  ep.drop();
  const results = await Promise.all(inflight);
  for (const r of results) assert.equal(r.error?.code, 'disconnected', `在途请求 disconnected：${r.error?.message}`);
  ep.reopen();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ep.sent.length, 4, '重连后不重放断线前的请求');

  // 重连之后的新请求照常配对
  const next = content.get('snapshot-manifest', 'c');
  await until(() => ep.sent.length === 5);
  const m = ep.sent[4];
  ep.deliver({ type: 'content.item', kind: m.kind, key: m.key, missing: true, reqId: m.reqId });
  assert.equal(await next, null);
});

test('Q3 端点从一开始就连不上：请求失败，不挂起（真服务已关）', async (t) => {
  const env = await startContentService();
  const url = env.url('node-a');
  const ep = await connectEndpoint(url, { env });
  t.after(env.cleanup);
  const { createContentClient } = await loadContentClient();
  const content = createContentClient(ep, { timeoutMs: 1000 });
  const closedSeen = new Promise((resolve) => ep.onClose(resolve));
  await env.service.close();
  await closedSeen;
  const r = await settleOf(content.get('snapshot-manifest', 'x'));
  assert.equal(r.ok, false, '断线状态下发请求：失败');
  assert.ok(['disconnected', 'timeout'].includes(r.error?.code), `错误带 code（disconnected 或 timeout）：${r.error?.code} ${r.error?.message}`);
  assert.ok(r.ms < 3000, `不挂起：${r.ms} ms`);
});

/**
 * 文档服务通用化：核心路由与模块挂载（契约 `docs/plan/render-queue-contract.md` G.1～G.4，用例 R1、R2、R3、R5、R6、R7）。
 * R4（`docservice.test.mjs` 一字不改全过）由 `npm test` 覆盖，这里不重复写。
 * 跑：node --test server/test/docservice-router.test.mjs
 *
 * 只照契约写，不看实现。被测模块用动态 import 取，模块缺失时每条用例各自失败、原因写清楚。
 * 端口一律由系统分配；需要节拍的用 `autoTick: false` 加手动 `service.tick()`（G.4）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDocService } from '../docservice/service.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { wsClient, byReq, sleep, waitFor } from './fake-ws-kit.mjs';

const routerPath = new URL('../docservice/router.mjs', import.meta.url);
const wsPath = new URL('../docservice/ws.mjs', import.meta.url);

async function loadRouter() {
  return import('../docservice/router.mjs');
}

/** 起一个服务（端口 0），日志收进数组。mount=true 时挂真队列。 */
async function startService({ mount = false, ...options } = {}) {
  const logs = [];
  const service = createDocService({ log: (event, fields) => logs.push({ event, ...fields }), autoTick: false, ...options });
  let queue = null;
  if (mount) {
    queue = createRenderQueue({ now: Date.now, send: service.send });
    service.mountRenderQueue(queue);
  }
  const { port } = await service.listen(0, '127.0.0.1');
  return { service, queue, port, logs, url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
}

/**
 * 与渲染无关的示例模块 `text.`（G.9 R1）：`text.count { text }` → `text.counted { lines, chars }`。
 * `seen` 记下它处理过的全部消息类型，`calls` 记 connect / disconnect。
 */
function textModule({ name = 'text', types = ['text.'] } = {}) {
  const conns = new Set();
  const seen = [];
  const calls = [];
  let counted = 0;
  return {
    name,
    types,
    seen,
    calls,
    connect(ctx, connId, principal) { conns.add(connId); calls.push(['connect', connId, principal]); },
    disconnect(ctx, connId) { conns.delete(connId); calls.push(['disconnect', connId]); },
    handle(ctx, connId, message) {
      seen.push(message.type);
      if (message.type !== 'text.count') {
        ctx.send(connId, { type: 'text.error', reqId: message.reqId });
        return;
      }
      counted += 1;
      const text = String(message.text ?? '');
      ctx.send(connId, {
        type: 'text.counted', reqId: message.reqId,
        lines: text === '' ? 0 : text.split('\n').length, chars: [...text].length,
      });
    },
    describeConn: (connId) => ({ textSeen: conns.has(connId) }),
    health: () => ({ textCounted: counted }),
    describe: () => ({ counted }),
  };
}

/** 最小模块：只认 types，handle 回 `<name>.ok`。 */
function bareModule(name, types, extra = {}) {
  return {
    name, types,
    handle(ctx, connId, message) { ctx.send(connId, { type: `${name}.ok`, reqId: message.reqId, got: message.type }); },
    ...extra,
  };
}

// ------------------------------------------------------------------ R1

test('R1 示例模块 text. 与队列同时在线：两边消息互不串门，同一连接交替发两种消息各自正确', async (t) => {
  const text = textModule();
  const { service, url, queue } = await startService({ mount: true, modules: [text] });
  t.after(() => service.close());

  const c1 = wsClient(url);
  const c2 = wsClient(url);
  t.after(() => { c1.close(); c2.close(); });
  await Promise.all([c1.opened, c2.opened]);

  c1.send({ type: 'publisher.hello', reqId: 'p1', publisherId: 'page-1' });
  const pw = await c1.next(byReq('p1'));
  assert.equal(pw.type, 'publisher.welcome');
  assert.equal(pw.epoch, queue.epoch, '队列的出站消息由队列自己补 epoch');

  c1.send({ type: 'text.count', reqId: 't1', text: 'ab\ncd\n中' });
  const tc1 = await c1.next(byReq('t1'));
  assert.equal(tc1.type, 'text.counted');
  assert.equal(tc1.lines, 3);
  assert.equal(tc1.chars, 7);
  assert.ok(!('epoch' in tc1), '核心不给模块的出站消息补任何字段（G.3）');

  c1.send({ type: 'node.hello', reqId: 'n1', nodeId: 'node-1', profile: 'host' });
  const nw = await c1.next(byReq('n1'));
  assert.equal(nw.type, 'node.welcome');

  c1.send({ type: 'text.count', reqId: 't2', text: '' });
  const tc2 = await c1.next(byReq('t2'));
  assert.deepEqual([tc2.type, tc2.lines, tc2.chars], ['text.counted', 0, 0]);

  // 第二条连接只用文本模块
  c2.send({ type: 'text.count', reqId: 'u1', text: 'x' });
  const tu = await c2.next(byReq('u1'));
  assert.deepEqual([tu.type, tu.lines, tu.chars], ['text.counted', 1, 1]);

  // 文本模块只见过自己的类型；队列不知道文本消息
  assert.ok(text.seen.length === 3 && text.seen.every((ty) => ty === 'text.count'), `文本模块收到了：${text.seen}`);
  const qd = queue.describe();
  assert.deepEqual(qd.publishers.map((p) => p.publisherId), ['page-1']);
  assert.deepEqual(qd.nodes.map((n) => n.nodeId), ['node-1']);
  // c2 没收到任何队列消息
  assert.ok(c2.all.every((m) => m.type === 'text.counted'), `c2 收到了：${JSON.stringify(c2.all)}`);

  // describe：角色字段来自队列模块，textSeen 来自文本模块
  const d = service.describe();
  const conn1 = d.conns.find((c) => c.publisherId === 'page-1');
  assert.ok(conn1, JSON.stringify(d.conns));
  assert.deepEqual(conn1.roles, ['publisher', 'node']);
  assert.equal(conn1.textSeen, true);
});

test('R1 路由核心单独用：createRouter 分派到模块、ctx.send 经 write 发出、给已断开的连接静默丢弃', async () => {
  const { createRouter } = await loadRouter();
  const writes = [];
  const router = createRouter({ now: () => 5000, log: () => {}, write: (connId, text) => writes.push([connId, JSON.parse(text)]) });
  const text = textModule();
  router.mount(text);
  router.connect('c1', { userId: 'u', tenantId: null }, { remote: '127.0.0.1', connectedAt: 5000 });
  assert.deepEqual(text.calls[0], ['connect', 'c1', { userId: 'u', tenantId: null }]);
  router.dispatch('c1', JSON.stringify({ type: 'text.count', reqId: 1, text: 'a\nb' }));
  assert.deepEqual(writes, [['c1', { type: 'text.counted', reqId: 1, lines: 2, chars: 3 }]]);
  assert.deepEqual(router.modules(), ['text']);
  assert.equal(router.describeConn('c1').textSeen, true);
  assert.equal(router.health().textCounted, 1);

  router.disconnect('c1');
  assert.deepEqual(text.calls.at(-1), ['disconnect', 'c1']);
  writes.length = 0;
  router.send('c1', { type: 'late' });
  assert.deepEqual(writes, [], '发给已断开的连接静默丢弃');
});

// ------------------------------------------------------------------ R2

test('R2 守门：router.mjs、ws.mjs 的源码里没有业务词', () => {
  const banned = ['render-queue', 'modules/', 'task.', 'node.hello', 'publisher', 'queue'];
  for (const file of [routerPath, wsPath]) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch (err) {
      assert.fail(`读不到 ${fileURLToPath(file)}：${err.code}`);
    }
    const hits = banned.filter((w) => src.includes(w));
    assert.deepEqual(hits, [], `${fileURLToPath(file)} 里出现了业务词：${hits.join('、')}`);
  }
});

// ------------------------------------------------------------------ R3

test('R3 类型冲突的三种情形都在挂载时抛错，已挂的模块不受影响（路由核心）', async () => {
  const { createRouter } = await loadRouter();
  const writes = [];
  const router = createRouter({ now: () => 0, log: () => {}, write: (connId, text) => writes.push(JSON.parse(text)) });
  router.mount(bareModule('a', ['a.x']));
  router.mount(bareModule('p', ['p.']));
  router.mount(bareModule('q', ['q.z']));
  router.mount(bareModule('r', ['r.a.']));

  // 1. 精确名相同
  assert.throws(() => router.mount(bareModule('b', ['a.x'])), '精确名相同');
  // 2. 一方的精确名以另一方的前缀开头（两个方向）
  assert.throws(() => router.mount(bareModule('c', ['p.y'])), '新精确名落在已挂前缀里');
  assert.throws(() => router.mount(bareModule('d', ['q.'])), '新前缀覆盖已挂精确名');
  // 3. 两个前缀里有一个以另一个开头（两个方向）
  assert.throws(() => router.mount(bareModule('e', ['p.sub.'])), '新前缀在已挂前缀里');
  assert.throws(() => router.mount(bareModule('f', ['r.'])), '新前缀包住已挂前缀');
  // 模块名重复
  assert.throws(() => router.mount(bareModule('a', ['zz.'])), '模块名重复');
  // 一个模块里只要有一个冲突就整个不挂
  assert.throws(() => router.mount(bareModule('g', ['g.ok', 'a.x'])));

  assert.deepEqual(router.modules(), ['a', 'p', 'q', 'r']);
  router.connect('c', { userId: 'u', tenantId: null }, { remote: null, connectedAt: 0 });
  for (const type of ['a.x', 'p.y', 'q.z', 'r.a.b']) router.dispatch('c', JSON.stringify({ type, reqId: type }));
  assert.deepEqual(writes.map((m) => [m.type, m.got]), [['a.ok', 'a.x'], ['p.ok', 'p.y'], ['q.ok', 'q.z'], ['r.ok', 'r.a.b']]);
  writes.length = 0;
  router.dispatch('c', JSON.stringify({ type: 'g.ok', reqId: 'g' }));
  assert.deepEqual(writes.map((m) => [m.type, m.reason, m.reqId]), [['error', 'unsupported', 'g']], '没挂上的模块的类型回 unsupported');
});

test('R3 字段冲突在挂载时抛错（与核心字段、与已挂模块），已挂的模块照常（组装层）', async (t) => {
  const text = textModule();
  const { service, url, queue } = await startService({ mount: true, modules: [text] });
  t.after(() => service.close());

  // describeConn 与核心字段重名
  assert.throws(() => service.mount(bareModule('dc1', ['dc1.'], { describeConn: () => ({ connId: 'x' }) })));
  assert.throws(() => service.mount(bareModule('dc2', ['dc2.'], { describeConn: () => ({ principal: null }) })));
  // health 与核心字段重名
  assert.throws(() => service.mount(bareModule('h1', ['h1.'], { health: () => ({ ok: false }) })));
  assert.throws(() => service.mount(bareModule('h2', ['h2.'], { health: () => ({ modules: [] }) })));
  // 与已挂模块的字段重名：文本模块的 textSeen / textCounted；队列模块的 roles / epoch
  assert.throws(() => service.mount(bareModule('h3', ['h3.'], { health: () => ({ textCounted: 0 }) })));
  assert.throws(() => service.mount(bareModule('dc3', ['dc3.'], { describeConn: () => ({ textSeen: false }) })));
  assert.throws(() => service.mount(bareModule('dc4', ['dc4.'], { describeConn: () => ({ roles: [] }) })));
  assert.throws(() => service.mount(bareModule('h4', ['h4.'], { health: () => ({ epoch: 'x' }) })));
  // 与队列类型冲突
  assert.throws(() => service.mount(bareModule('tq', ['task.'])));
  assert.throws(() => service.mount(bareModule('nh', ['node.hello'])));

  const c = wsClient(url);
  t.after(() => c.close());
  await c.opened;
  c.send({ type: 'text.count', reqId: 1, text: 'hi' });
  assert.equal((await c.next(byReq(1))).type, 'text.counted');
  c.send({ type: 'publisher.hello', reqId: 2, publisherId: 'pg' });
  const w = await c.next(byReq(2));
  assert.deepEqual([w.type, w.epoch], ['publisher.welcome', queue.epoch]);
  for (const type of ['dc1.a', 'h1.a', 'h3.a', 'tq.a']) {
    c.send({ type, reqId: type });
    const e = await c.next(byReq(type));
    assert.deepEqual([e.type, e.reason], ['error', 'unsupported'], `挂载失败的模块的 ${type}`);
  }
  const health = await (await fetch(`http://127.0.0.1:${new URL(url).port}/healthz`)).json();
  assert.deepEqual([...health.modules].filter((m) => /^(dc|h)\d|^tq$|^nh$/.test(m)), [], `挂载失败的模块不该出现在 modules：${health.modules}`);
});

// ------------------------------------------------------------------ R5

test('R5 模块 handle 同步抛出、返回被拒绝的 Promise：回 internal（带原 reqId），连接不断，别的模块照常', async (t) => {
  const text = textModule();
  const boom = {
    name: 'boom',
    types: ['boom.'],
    handle(ctx, connId, message) {
      if (message.type === 'boom.sync') throw new Error('kaput-sync');
      if (message.type === 'boom.async') return Promise.reject(new Error('kaput-async'));
      ctx.send(connId, { type: 'boom.fine', reqId: message.reqId });
      return undefined;
    },
  };
  const { service, url, logs } = await startService({ mount: true, modules: [text, boom] });
  t.after(() => service.close());
  const c = wsClient(url);
  t.after(() => c.close());
  await c.opened;

  c.send({ type: 'boom.sync', reqId: 'b1', secret: 'payload-text-xyz' });
  const e1 = await c.next(byReq('b1'));
  assert.deepEqual([e1.type, e1.reason], ['error', 'internal']);
  assert.equal(typeof e1.detail, 'string');
  assert.ok(!e1.detail.includes('payload-text-xyz'), 'detail 不含消息原文');

  c.send({ type: 'boom.async', reqId: 7 });
  const e2 = await c.next(byReq(7));
  assert.deepEqual([e2.type, e2.reason, e2.reqId], ['error', 'internal', 7]);

  // 同一连接照常：同模块的正常消息、别的模块、队列
  c.send({ type: 'boom.other', reqId: 'b3' });
  assert.equal((await c.next(byReq('b3'))).type, 'boom.fine');
  c.send({ type: 'text.count', reqId: 't', text: 'q' });
  assert.equal((await c.next(byReq('t'))).type, 'text.counted');
  c.send({ type: 'publisher.hello', reqId: 'p', publisherId: 'pg' });
  assert.equal((await c.next(byReq('p'))).type, 'publisher.welcome');
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  assert.equal(service.describe().connections, 1);

  const errs = logs.filter((l) => l.event === 'module.error');
  assert.ok(errs.some((l) => l.module === 'boom' && l.type === 'boom.sync' && l.message === 'kaput-sync'), JSON.stringify(errs));
  assert.ok(errs.some((l) => l.module === 'boom' && l.type === 'boom.async' && l.message === 'kaput-async'), JSON.stringify(errs));
});

// ------------------------------------------------------------------ R6

test('R6 卸载后这些类型回 unsupported；挂卸时对已有连接调 connect / disconnect', async (t) => {
  const { service, url } = await startService();
  t.after(() => service.close());
  const c = wsClient(url);
  t.after(() => c.close());
  await c.opened;

  c.send({ type: 'text.count', reqId: 'before', text: 'x' });
  const e0 = await c.next(byReq('before'));
  assert.deepEqual([e0.type, e0.reason], ['error', 'unsupported']);

  const text = textModule();
  const unmount = service.mount(text);
  assert.equal(typeof unmount, 'function');
  const connId = service.describe().conns[0].connId;
  assert.deepEqual(text.calls[0], ['connect', connId, { userId: 'anonymous', tenantId: null }], '挂载时对已有连接调 connect');

  c.send({ type: 'text.count', reqId: 'mid', text: 'x' });
  assert.equal((await c.next(byReq('mid'))).type, 'text.counted');

  unmount();
  assert.deepEqual(text.calls.at(-1), ['disconnect', connId], '卸载时对已有连接调 disconnect');
  c.send({ type: 'text.count', reqId: 'after', text: 'x' });
  const e1 = await c.next(byReq('after'));
  assert.deepEqual([e1.type, e1.reason, e1.reqId], ['error', 'unsupported', 'after']);
  assert.ok(!(await (await fetch(`http://127.0.0.1:${new URL(url).port}/healthz`)).json()).modules.includes('text'));

  // 卸载后可以再挂
  const again = textModule();
  service.mount(again);
  c.send({ type: 'text.count', reqId: 'again', text: 'x' });
  assert.equal((await c.next(byReq('again'))).type, 'text.counted');
});

test('R6 mountRenderQueue 的卸载函数卸下之后回 queue-unavailable，角色清空，可以再挂', async (t) => {
  const { service, url } = await startService();
  t.after(() => service.close());
  const c = wsClient(url);
  t.after(() => c.close());
  await c.opened;

  c.send({ type: 'node.hello', reqId: 'h0', nodeId: 'n1', profile: 'pc' });
  const e0 = await c.next(byReq('h0'));
  assert.deepEqual([e0.type, e0.reason], ['error', 'queue-unavailable']);

  const q1 = createRenderQueue({ now: Date.now, send: service.send });
  const unmount = service.mountRenderQueue(q1);
  c.send({ type: 'node.hello', reqId: 'h1', nodeId: 'n1', profile: 'pc' });
  const w1 = await c.next(byReq('h1'));
  assert.deepEqual([w1.type, w1.epoch], ['node.welcome', q1.epoch]);
  assert.deepEqual(service.describe().conns[0].roles, ['node']);

  unmount();
  for (const [reqId, msg] of [['h2', { type: 'node.hello', nodeId: 'n1', profile: 'pc' }], ['w2', { type: 'queue.watch', projects: 'all' }], ['p2', { type: 'task.publish', tasks: [] }]]) {
    c.send({ ...msg, reqId });
    const e = await c.next(byReq(reqId));
    assert.deepEqual([e.type, e.reason], ['error', 'queue-unavailable'], `卸下后 ${msg.type}`);
  }
  const conn = service.describe().conns[0];
  assert.deepEqual(conn.roles, []);
  assert.equal(conn.publisherId, null);
  assert.equal(conn.node, null);
  const h = await (await fetch(`http://127.0.0.1:${new URL(url).port}/healthz`)).json();
  assert.deepEqual([h.queue, h.publishers, h.nodes], [false, 0, 0]);

  const q2 = createRenderQueue({ now: Date.now, send: service.send });
  service.mountRenderQueue(q2);
  c.send({ type: 'node.hello', reqId: 'h3', nodeId: 'n1', profile: 'pc' });
  const w3 = await c.next(byReq('h3'));
  assert.deepEqual([w3.type, w3.epoch], ['node.welcome', q2.epoch]);
});

// ------------------------------------------------------------------ R7

test('R7 /healthz：有 protocol、modules，旧字段不变，挂上队列后有 epoch', async (t) => {
  const text = textModule();
  const { service, http, url } = await startService({ modules: [text] });
  t.after(() => service.close());

  const h0 = await (await fetch(`${http}/healthz`)).json();
  assert.equal(h0.ok, true);
  assert.equal(h0.service, 'promptcut-docservice');
  assert.equal(typeof h0.uptimeMs, 'number');
  assert.equal(h0.connections, 0);
  assert.equal(h0.protocol, 'promptcut.v1');
  assert.ok(Array.isArray(h0.modules) && h0.modules.includes('text'), `modules：${JSON.stringify(h0.modules)}`);
  assert.deepEqual([h0.queue, h0.publishers, h0.nodes], [false, 0, 0], '没挂队列时占位模块给出的旧字段');
  assert.equal(h0.textCounted, 0, '模块的 health 字段平铺合入');

  const queue = createRenderQueue({ now: Date.now, send: service.send });
  service.mountRenderQueue(queue);
  const c = wsClient(url);
  t.after(() => c.close());
  await c.opened;
  c.send({ type: 'publisher.hello', reqId: 1, publisherId: 'pg' });
  await c.next(byReq(1));
  c.send({ type: 'node.hello', reqId: 2, nodeId: 'nd', profile: 'host' });
  await c.next(byReq(2));
  c.send({ type: 'text.count', reqId: 3, text: 'z' });
  await c.next(byReq(3));

  const h1 = await (await fetch(`${http}/healthz`)).json();
  assert.equal(h1.queue, true);
  assert.equal(h1.epoch, queue.epoch);
  assert.equal(h1.connections, 1);
  assert.equal(h1.publishers, 1);
  assert.equal(h1.nodes, 1);
  assert.equal(h1.textCounted, 1);
  assert.equal(h1.protocol, 'promptcut.v1');
  assert.ok(h1.modules.includes('text'));
});

test('R7 describe()：conns[i] 含核心字段与队列模块的 roles / publisherId / node，modules 含各模块 describe', async (t) => {
  const text = textModule();
  const nodesc = bareModule('nodesc', ['nodesc.']);
  const { service, url, queue } = await startService({ mount: true, modules: [text, nodesc] });
  t.after(() => service.close());
  const c = wsClient(url);
  t.after(() => c.close());
  await c.opened;
  c.send({ type: 'node.hello', reqId: 1, nodeId: 'nd', profile: 'host', capabilities: { transcode: true } });
  await c.next(byReq(1));
  c.send({ type: 'text.count', reqId: 2, text: 'z' });
  await c.next(byReq(2));

  const d = service.describe();
  assert.equal(d.conns.length, 1);
  const conn = d.conns[0];
  for (const k of ['connId', 'remote', 'principal', 'connectedAt', 'roles', 'publisherId', 'node', 'textSeen']) {
    assert.ok(k in conn, `conns[0] 缺 ${k}：${JSON.stringify(conn)}`);
  }
  assert.deepEqual(conn.principal, { userId: 'anonymous', tenantId: null });
  assert.deepEqual(conn.roles, ['node']);
  assert.equal(conn.publisherId, null);
  assert.equal(conn.node.nodeId, 'nd');
  assert.deepEqual(conn.node.capabilities, { transcode: true });
  assert.equal(conn.textSeen, true);

  assert.ok(d.modules && typeof d.modules === 'object', 'describe() 带 modules');
  assert.deepEqual(d.modules.text, { counted: 1 });
  assert.equal(d.modules.nodesc, null, '没有 describe 的模块记 null');
  const h = await (await fetch(`http://127.0.0.1:${new URL(url).port}/healthz`)).json();
  assert.deepEqual(Object.keys(d.modules).sort(), [...h.modules].sort(), 'describe().modules 的键就是已挂模块');
  assert.equal(queue.describe().nodes[0].nodeId, 'nd');
});

test('R7 组装层节拍：autoTick=false 不起计时器，service.tick(name?) 手动驱动；autoTick 缺省按 tickMs 起', async (t) => {
  let ticks = 0;
  let other = 0;
  const ticker = { name: 'ticker', types: ['ticker.'], handle() {}, tick: () => { ticks += 1; }, tickMs: 5 };
  const second = { name: 'second', types: ['second.'], handle() {}, tick: () => { other += 1; }, tickMs: 5 };
  const { service } = await startService({ modules: [ticker, second] });
  t.after(() => service.close());
  await sleep(60);
  assert.deepEqual([ticks, other], [0, 0], 'autoTick=false 时不起模块计时器');
  service.tick('ticker');
  assert.deepEqual([ticks, other], [1, 0], 'tick(name) 只调这一个模块');
  service.tick();
  assert.deepEqual([ticks, other], [2, 1], 'tick() 调全部模块');

  let auto = 0;
  const service2 = createDocService({ log: () => {}, modules: [{ name: 'auto', types: ['auto.'], handle() {}, tick: () => { auto += 1; }, tickMs: 5 }] });
  await service2.listen(0, '127.0.0.1');
  t.after(() => service2.close());
  await waitFor(() => auto >= 2, 2000, '自动节拍');
});

test('R6 路由核心：不是 JSON、没有 type → bad-message；没人认领 → unsupported；卸载后回 unsupported', async () => {
  const { createRouter } = await loadRouter();
  const writes = [];
  const router = createRouter({ now: () => 0, log: () => {}, write: (connId, text) => writes.push(JSON.parse(text)) });
  router.connect('c', { userId: 'u', tenantId: null }, { remote: null, connectedAt: 0 });
  router.dispatch('c', '{oops');
  router.dispatch('c', JSON.stringify({ reqId: 'r2', hello: 1 }));
  router.dispatch('c', JSON.stringify([1, 2]));
  router.dispatch('c', JSON.stringify({ type: 'text.count', reqId: 'r4' }));
  assert.deepEqual(writes.map((m) => [m.type, m.reason]), [
    ['error', 'bad-message'], ['error', 'bad-message'], ['error', 'bad-message'], ['error', 'unsupported'],
  ]);
  assert.equal(writes[3].reqId, 'r4');
  writes.length = 0;
  const unmount = router.mount(textModule());
  router.dispatch('c', JSON.stringify({ type: 'text.count', reqId: 'r5', text: 'a' }));
  unmount();
  router.dispatch('c', JSON.stringify({ type: 'text.count', reqId: 'r6', text: 'a' }));
  assert.deepEqual(writes.map((m) => [m.type, m.reqId]), [['text.counted', 'r5'], ['error', 'r6']]);
  assert.equal(writes[1].reason, 'unsupported');
  assert.deepEqual(router.modules(), []);
});


/**
 * 文档服务的 HTTP 长轮询传输，服务端一侧（契约 `docs/plan/http-transport-contract.md` 第 2 版第 6 节）。
 * 跑：node --test server/test/docservice-http-transport.test.mjs
 *
 * 本阶段（HT-a）长轮询不接线：`createDocService` 不答 `/lp/…`。这里自己搭一个最小组装——核心 `createRouter`、会话层
 * `createSessionLayer`、`createHttpTransport`、一台只绑回环的 http 服务器（端口 0）——验证传输按第 6 节接在会话层下面，
 * 给 HT-b 接线时用。直接打四个端点（`fake-transport-kit.mjs` 的 `lp`），不经节点端的客户端。
 * HT1 / HT2 的 WebSocket 部分在 `ht1-session.test.mjs`、`ht2-backpressure.test.mjs`（测试方 `claude/ht-tests`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRouter } from '../docservice/router.mjs';
import { createSessionLayer } from '../docservice/session.mjs';
import { createHttpTransport } from '../docservice/http-transport.mjs';
import { lp, recvUntil, authByProtocols } from './fake-transport-kit.mjs';
import { sleep, waitFor } from './fake-ws-kit.mjs';

const SID_RE = /^[A-Za-z0-9_-]{43}$/;
const NEW = 'promptcut.session.new';

/** 测试模块：`t.echo { n }` 回 `t.echoed`，`t.sink` 不回 */
function echoModule() {
  const mod = {
    name: 't', types: ['t.'], seen: [], connects: [], disconnects: [], ctx: null,
    connect(ctx, connId, principal) { mod.ctx = ctx; mod.connects.push({ connId, principal }); },
    disconnect(ctx, connId) { mod.disconnects.push(connId); },
    handle(ctx, connId, msg) {
      mod.seen.push(msg);
      if (msg.type === 't.echo') ctx.send(connId, { type: 't.echoed', n: msg.n });
    },
  };
  return mod;
}

async function startLp(t, { retainMs = 60_000, waitMs = 2000, highWaterBytes, maxPendingBytes, corsOrigins, maxFrameBytes } = {}) {
  const logs = [];
  const log = (event, fields) => logs.push({ event, ...fields });
  let n = 0;
  let sessions = null;
  const router = createRouter({
    log,
    write: (id, text) => sessions.write(id, text),
    buffered: (id) => sessions.buffered(id),
    close: (id, code, reason) => { sessions.close(id, code, reason); },
    highWaterBytes,
    maxPendingBytes,
  });
  sessions = createSessionLayer({ router, nextConnId: () => `conn-${++n}`, log, retainMs });
  const mod = echoModule();
  router.mount(mod);
  // 传输的时钟可拨（空闲判据是 waitMs + 15 s，测试不真等）
  const clock = { offset: 0 };
  const transport = createHttpTransport({
    sessions, authenticate: authByProtocols, retainMs, waitMs, corsOrigins, maxFrameBytes, log, now: () => Date.now() + clock.offset,
  });
  const server = http.createServer((req, res) => {
    if (!transport.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await sessions.closeAll(1001, 'test done');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return { router, sessions, transport, mod, logs, base, c: lp(base), server, clock };
}

const openNew = async (env, user = 'alice', headers = {}) => {
  const r = await env.c.open(['promptcut.v1', `x-user.${user}`, NEW], headers);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

test('LP-open 建会话：回 sid、resumed false、ack 0、retainMs、waitMs、maxFrameBytes、protocol、transport http；缺头、第一项不是 v1、没有会话项 400；鉴权不过 401', async (t) => {
  const env = await startLp(t, { retainMs: 45_000, waitMs: 5000 });
  const o = await openNew(env);
  assert.match(o.sid, SID_RE);
  assert.deepEqual({ ...o, sid: 'x' }, { ok: true, sid: 'x', resumed: false, ack: 0, retainMs: 45_000, waitMs: 5000, maxFrameBytes: 1024 * 1024, protocol: 'promptcut.v1', transport: 'http' });
  assert.equal(env.mod.connects.length, 1);
  assert.equal(env.mod.connects[0].principal.userId, 'alice');
  assert.equal((await env.c.open(null)).status, 400, '缺 X-Promptcut-Protocols');
  assert.equal((await env.c.open(['x-user.bob', 'promptcut.v1', NEW])).status, 400, '第一项不是 promptcut.v1');
  assert.equal((await env.c.open(['promptcut.v1', 'x-user.bob'])).status, 400, '长轮询没有旧客户端：要有会话项');
  assert.equal((await env.c.open(['promptcut.v1', 'x-user.deny', NEW])).status, 401);
  const s = env.sessions.stats();
  assert.deepEqual({ total: s.total, http: s.http, ws: s.ws }, { total: 1, http: 1, ws: 0 });
  assert.ok(!JSON.stringify(env.logs).includes(o.sid), '会话号不进日志');
});

test('LP-send-recv 帧带 seq：模块看不到 seq / ack；回包按序、带 seq 与 ack；POST 回服务端已收全的 ack；重发丢弃；跳号 1002 结束会话，之后 410', async (t) => {
  const env = await startLp(t);
  const { sid } = await openNew(env);
  const s1 = await env.c.send(sid, [{ type: 't.echo', n: 1, seq: 1 }, { type: 't.echo', n: 2, seq: 2 }]);
  assert.deepEqual(s1.body, { ok: true, ack: 2 });
  const got = await recvUntil(env.c, sid, (m) => m.n === 2);
  assert.deepEqual(got.frames.map((m) => [m.type, m.n, m.seq, m.ack]), [['t.echoed', 1, 1, 2], ['t.echoed', 2, 2, 2]]);
  assert.deepEqual(env.mod.seen, [{ type: 't.echo', n: 1 }, { type: 't.echo', n: 2 }], '模块看不到 seq / ack');
  // 重发同一批：丢弃，照样回 ack
  assert.deepEqual((await env.c.send(sid, [{ type: 't.echo', n: 2, seq: 2 }])).body, { ok: true, ack: 2 });
  assert.equal(env.mod.seen.length, 2);
  // 跳号
  const bad = await env.c.send(sid, [{ type: 't.echo', n: 9, seq: 9 }]);
  assert.equal(bad.status, 410);
  assert.equal(bad.body.code, 1002);
  await waitFor(() => env.mod.disconnects.length === 1, 1000, '会话结束');
  const after = await env.c.recv(sid, 2, 0);
  assert.equal(after.status, 200, '剩下的帧与 closed 先回给客户端');
  assert.deepEqual(after.body.closed, { code: 1002, reason: 'bad-seq' });
  const gone = await env.c.recv(sid, 2, 0);
  assert.equal(gone.status, 410);
  assert.equal(gone.body.error, 'session-closed');
});

test('LP-recv 没帧就挂着、到 wait 回空；有新帧立刻回；新的 GET 替换旧的（旧的回 superseded）；ack 释放后 drained', async (t) => {
  const env = await startLp(t);
  const { sid } = await openNew(env);
  const t0 = Date.now();
  const empty = await env.c.recv(sid, 0, 200);
  assert.deepEqual(empty.body, { ok: true, frames: [], closed: null });
  assert.ok(Date.now() - t0 >= 150, '挂满 wait');
  const hanging = env.c.recv(sid, 0, 1500);
  await sleep(50);
  const connId = env.mod.connects[0].connId;
  env.mod.ctx.send(connId, { type: 't.pushed' });
  const woke = await hanging;
  assert.equal(woke.body.frames.length, 1);
  assert.equal(JSON.parse(woke.body.frames[0]).seq, 1);
  // 替换
  const first = env.c.recv(sid, 1, 1500);
  await sleep(50);
  const second = env.c.recv(sid, 1, 100);
  assert.equal((await first).body.superseded, true);
  assert.equal((await second).status, 200);
  assert.equal(env.sessions.buffered(connId), 0, 'ack 1 已释放');
});

test('LP-resume 经 open 接续：不再鉴权，resumed true、ack 是服务端已收全的；补发还没确认的帧（原 seq）；越界 ack 的接续 410', async (t) => {
  const env = await startLp(t);
  const { sid } = await openNew(env);
  await env.c.send(sid, [{ type: 't.echo', n: 1, seq: 1 }, { type: 't.echo', n: 2, seq: 2 }]);
  await recvUntil(env.c, sid, (m) => m.n === 2);
  // 客户端只确认到 1，然后当传输坏了、重新 open 接续
  const r = await env.c.open(['promptcut.v1', `promptcut.session.${sid}.1`], { 'x-promptcut-fallback': 'ws-error' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual({ sid: r.body.sid, resumed: r.body.resumed, ack: r.body.ack }, { sid, resumed: true, ack: 2 });
  const again = await env.c.recv(sid, 1, 0);
  assert.deepEqual(again.body.frames.map((f) => JSON.parse(f).seq), [2], '补发 seq 2');
  const s = env.sessions.stats();
  assert.equal(s.resumed, 1);
  assert.equal(s.fallbacks, 1);
  assert.equal(s.list[0].fallback, 'ws-error');
  assert.equal(env.mod.connects.length, 1, '模块只见一次 connect');
  // 接续项与鉴权项同给 400；会话不存在 404
  assert.equal((await env.c.open(['promptcut.v1', 'x-user.alice', `promptcut.session.${sid}.2`])).status, 400);
  assert.equal((await env.c.open(['promptcut.v1', `promptcut.session.${'A'.repeat(43)}.0`])).status, 404);
  // 越界的 ack：会话以 1002 结束，回 410
  const over = await env.c.open(['promptcut.v1', `promptcut.session.${sid}.99`]);
  assert.equal(over.status, 410);
  assert.equal(over.body.code, 1002);
  await waitFor(() => env.mod.disconnects.length === 1, 1000, '会话结束');
});

test('LP-close 客户端 POST /lp/close：会话立刻结束（模块见断开），之后 410；服务端关（4003）时挂着的 GET 先回剩下的帧再带 closed', async (t) => {
  const env = await startLp(t);
  const a = await openNew(env, 'alice');
  assert.equal((await env.c.close(a.sid, { code: 1000, reason: 'bye' })).status, 200);
  await waitFor(() => env.mod.disconnects.length === 1, 1000, '立刻断线');
  const r = await env.c.recv(a.sid, 0, 0);
  assert.equal(r.status, 410);
  assert.deepEqual({ code: r.body.code, reason: r.body.reason }, { code: 1000, reason: 'bye' });

  const b = await openNew(env, 'bob');
  const connId = env.mod.connects[1].connId;
  env.mod.ctx.send(connId, { type: 't.pushed', k: 1 });
  const hanging = env.c.recv(b.sid, 0, 1500);
  await sleep(30);
  // 刚才那条已经被这个 GET 取走（未确认）；再来一条后服务端踢人
  const waitAll = hanging.then(async (first) => {
    const rest = await env.c.recv(b.sid, 0, 1500);
    return [first, rest];
  });
  env.mod.ctx.send(connId, { type: 't.pushed', k: 2 });
  env.mod.ctx.close(connId, 4003, 'kicked');
  const [, rest] = await waitAll;
  assert.equal(rest.status, 200);
  assert.deepEqual(rest.body.frames.map((f) => JSON.parse(f).k), [1, 2], '会话结束前没确认的帧都先回');
  assert.deepEqual(rest.body.closed, { code: 4003, reason: 'kicked' });
  assert.equal((await env.c.recv(b.sid, 0, 0)).status, 410);
});

test('LP-idle 既没有挂着的 GET、也没来过请求：sweep 判传输断开，会话只脱开（模块不见断开），之后经 open 接续', async (t) => {
  const env = await startLp(t, { waitMs: 50, retainMs: 60_000 });
  const { sid } = await openNew(env);
  env.transport.sweep();
  assert.equal(env.sessions.stats().detached, 0, '还没到空闲时限');
  // 空闲判据是 waitMs + 15 s：把传输的时钟往后拨
  env.clock.offset = 20_000;
  env.transport.sweep();
  env.clock.offset = 0;
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 1000, '脱开');
  assert.equal(env.sessions.stats().detached, 1);
  assert.equal(env.mod.disconnects.length, 0);
  assert.equal((await env.c.recv(sid, 0, 0)).status, 409, '断开的传输要先经 open 接续');
  const r = await env.c.open(['promptcut.v1', `promptcut.session.${sid}.0`]);
  assert.equal(r.body.resumed, true);
  assert.equal(env.sessions.stats().detached, 0);
});

test('LP-413 单帧超过 maxFrameBytes：413，会话以 1009 结束', async (t) => {
  const env = await startLp(t, { maxFrameBytes: 1000 });
  const { sid } = await openNew(env);
  const r = await env.c.send(sid, [{ type: 't.echo', n: 1, seq: 1, pad: 'x'.repeat(2000) }]);
  assert.equal(r.status, 413);
  await waitFor(() => env.mod.disconnects.length === 1, 1000, '会话结束');
  const after = await env.c.recv(sid, 0, 0);
  assert.equal(after.body.closed?.code ?? after.body.code, 1009);
});

test('LP-busy 同一会话同一时刻只一个 POST /lp/send 在途：第二个回 409 busy', async (t) => {
  const env = await startLp(t);
  const { sid } = await openNew(env);
  const url = new URL(`${env.base}/lp/send`);
  // 第一个 POST 只发请求头、不发完请求体，一直占着
  const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { authorization: `Bearer ${sid}`, 'content-type': 'application/json', 'content-length': '100' } });
  req.on('error', () => {});
  req.write('{"frames":');
  await sleep(100);
  const second = await env.c.send(sid, [{ type: 't.echo', n: 1, seq: 1 }]);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'busy');
  req.destroy();
});

test('LP-backpressure 客户端不来取：未确认字节涨过 maxPendingBytes，核心以 1013 结束会话，下一次 GET 拿到 closed', async (t) => {
  const env = await startLp(t, { highWaterBytes: 4 * 1024, maxPendingBytes: 16 * 1024 });
  const { sid } = await openNew(env);
  const connId = env.mod.connects[0].connId;
  const pad = 'y'.repeat(1024);
  for (let i = 0; i < 40 && env.mod.disconnects.length === 0; i++) env.mod.ctx.send(connId, { type: 't.blob', i, pad });
  await waitFor(() => env.mod.disconnects.length === 1, 1000, '背压结束');
  const r = await env.c.recv(sid, 0, 0);
  assert.equal(r.status, 200);
  let closed = r.body.closed;
  while (!closed) closed = (await env.c.recv(sid, 0, 0)).body.closed;
  assert.equal(closed.code, 1013);
});

test('LP-cors 名单里的 Origin 回 ACAO 与 Vary；预检 204 带允许的方法与头（含 X-Promptcut-Fallback）；名单空不回 CORS 头', async (t) => {
  const env = await startLp(t, { corsOrigins: ['https://ok.example'] });
  const pre = await env.c.options('open', { origin: 'https://ok.example' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://ok.example');
  assert.match(pre.headers.get('access-control-allow-headers'), /X-Promptcut-Fallback/);
  const bad = await env.c.options('open', { origin: 'https://evil.example' });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const o = await env.c.open(['promptcut.v1', 'x-user.a', NEW], { origin: 'https://ok.example' });
  assert.equal(o.headers.get('access-control-allow-origin'), 'https://ok.example');
  assert.equal(o.headers.get('vary'), 'Origin');
});

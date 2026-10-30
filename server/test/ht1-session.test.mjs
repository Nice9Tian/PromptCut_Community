/**
 * HT1：服务端会话层（契约 `docs/plan/http-transport-contract.md` 第 3、4、5、7、8 节，第 11 节 HT1 的 WebSocket 部分）。
 * 跑：node --test server/test/ht1-session.test.mjs
 *
 * 只照契约写，没看实现。假设集中在 `ht-kit.mjs`（H1～H9）。服务端会话层没到位时（`server/docservice/session.mjs`
 * 不存在）整组跳过，写明原因；到位后自动真跑。
 * HT1 里经 HTTP 的几项（WebSocket 断后经 HTTP 接续、HTTP 断后经 WebSocket 接续、open 的鉴权、send / recv）属 HT-b，不在这里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SKIP_SERVER, SID_RE, PROTOCOL, SESSION_NEW, resumeItem,
  startService, openSession, resumeStatus, checkSessionsShape, assertNoSid, rawHandshake, waitFor, sleep,
} from './ht-kit.mjs';
import { rawWsClient } from './fake-raw-ws.mjs';

const T = { skip: SKIP_SERVER };
const biz = (c) => c.all.filter((m) => typeof m?.type === 'string' && !m.type.startsWith('session.'));

// ------------------------------------------------------------------ 建会话

test('HT1-open 建会话：第一条出站是 session.welcome（sid 256 位 base64url、resumed false、ack 0、retainMs、transport ws），回显只有 promptcut.v1', T, async (t) => {
  const env = await startService({ retainMs: 45_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  assert.equal(c.all[0]?.type, 'session.welcome', `第一条出站就是 welcome：${JSON.stringify(c.all[0])}`);
  const w = c.welcome;
  assert.match(w.sid, SID_RE, 'sid 是 32 字节 CSPRNG 的 base64url');
  assert.deepEqual({ resumed: w.resumed, ack: w.ack, retainMs: w.retainMs, transport: w.transport }, { resumed: false, ack: 0, retainMs: 45_000, transport: 'ws' });
  assert.ok(!('seq' in w), '控制消息不带 seq');
  assert.equal(c.ws.protocol, PROTOCOL, '握手只回显 promptcut.v1，不回显会话项');
  assert.equal(env.auth.calls, 1, '建会话照常鉴权一次');
  assert.equal(env.mod.connects.length, 1, '核心看见一条连接');
  assert.equal(env.mod.connects[0].principal.userId, 'alice');

  // 两个 sid 不同
  const c2 = await openSession(env, { user: 'bob' });
  assert.notEqual(c2.sid, c.sid);
});

test('HT1-default-retain 不给 retainMs 时保留时限缺省 60 000 ms', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  assert.equal(c.welcome.retainMs, 60_000);
});

test('HT1-seq 业务消息两个方向都带 seq：服务端从 1 起逐条加一；会话层交给模块前摘掉 seq、ack；回包顺带 ack', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  for (let n = 1; n <= 3; n++) c.sendSeq({ type: 'ht.echo', n });
  for (let n = 1; n <= 3; n++) await c.next((m) => m.type === 'ht.echoed' && m.n === n);
  const replies = biz(c);
  assert.deepEqual(replies.map((m) => m.seq), [1, 2, 3], `服务端业务消息的 seq 从 1 起：${JSON.stringify(replies)}`);
  assert.equal(replies.at(-1).ack, 3, `最后一条回包顺带 ack = 3（已按序收全客户端的第 3 条）：${JSON.stringify(replies.at(-1))}`);
  for (const r of replies) assert.ok(Number.isInteger(r.ack) && r.ack >= 1 && r.ack <= 3, `回包的 ack 在 1～3：${JSON.stringify(r)}`);
  assert.deepEqual(env.mod.seen.map((s) => s.msg.n), [1, 2, 3], '模块按序收到');
  for (const s of env.mod.seen) {
    assert.ok(!('seq' in s.msg) && !('ack' in s.msg), `模块看不到 seq / ack：${JSON.stringify(s.msg)}`);
  }
  // 模块之外的发送入口同样补 seq
  env.service.send(env.mod.connects[0].connId, { type: 'ht.pushed' });
  const pushed = await c.next((m) => m.type === 'ht.pushed');
  assert.equal(pushed.seq, 4);
});

test('HT1-control session.* 控制消息不进核心；模块不得认领 session. 前缀', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  c.sendSeq({ type: 'ht.echo', n: 1 });
  await c.next((m) => m.type === 'ht.echoed');
  c.sendRaw({ type: 'session.ack', ack: 1 });
  await sleep(150);
  assert.deepEqual(env.mod.seen.map((s) => s.msg.type), ['ht.echo'], '控制消息不交给模块');
  assert.equal(biz(c).filter((m) => m.type === 'error').length, 0, `控制消息不回 unsupported：${JSON.stringify(c.all)}`);
  assert.throws(() => env.service.mount({ name: 'thief', types: ['session.'], handle() {} }), '挂认领 session. 前缀的模块要抛错');
  assert.throws(() => env.service.mount({ name: 'thief2', types: ['session.ack'], handle() {} }), '认领某一条 session.* 也不行');
});

test('HT1-ack-batch 收到的消息没有顺带机会时 1 s 内单发 session.ack；未确认满 32 条立刻单发', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  const t0 = Date.now();
  c.sendSeq({ type: 'ht.sink' });
  const a1 = await c.next((m) => m.type === 'session.ack', 2500);
  assert.equal(a1.ack, 1);
  assert.ok(!('seq' in a1), 'session.ack 不带 seq');
  assert.ok(Date.now() - t0 < 1800, `1 s 左右单发（实际 ${Date.now() - t0} ms）`);

  const t1 = Date.now();
  for (let i = 0; i < 32; i++) c.sendSeq({ type: 'ht.sink' });
  const a2 = await c.next((m) => m.type === 'session.ack' && m.ack === 33, 2500);
  assert.ok(Date.now() - t1 < 700, `满 32 条不等 1 s 计时（实际 ${Date.now() - t1} ms）`);
  assert.equal(a2.ack, 33);
});

// ------------------------------------------------------------------ 接续

test('HT1-resume WebSocket 断后经 WebSocket 接续：不再鉴权、connId 不变、模块不见断开；welcome 带服务端已收全的 ack；补发未确认的服务端消息（原 seq、按序）', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  const connId = env.mod.connects[0].connId;
  for (let n = 1; n <= 3; n++) c.sendSeq({ type: 'ht.echo', n });
  for (let n = 1; n <= 3; n++) await c.next((m) => m.type === 'ht.echoed' && m.n === n);
  // 客户端只确认到 1，然后断
  c.sendRaw({ type: 'session.ack', ack: 1 });
  await sleep(50);
  c.close();
  await c.ended();
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 2000, 'session.detach 日志');
  // 脱开期间服务端又写了一条
  env.service.send(connId, { type: 'ht.pushed', k: 'during-detach' });
  await sleep(50);
  assert.equal(env.mod.disconnects.length, 0, '传输断开只让会话脱开，核心不见断开');

  const authBefore = env.auth.calls;
  const r = await openSession(env, { resume: { sid: c.sid, ack: 1 }, startSeq: 3 });
  assert.equal(env.auth.calls, authBefore, '接续不再调 authenticate（会话号就是凭证）');
  assert.deepEqual({ resumed: r.welcome.resumed, ack: r.welcome.ack, transport: r.welcome.transport, sid: r.welcome.sid },
    { resumed: true, ack: 3, transport: 'ws', sid: c.sid }, 'welcome：resumed、服务端已收全客户端的第 3 条');
  assert.equal(r.all[0]?.type, 'session.welcome', 'welcome 先于补发');
  await r.next((m) => m.type === 'ht.pushed');
  const resent = biz(r);
  assert.deepEqual(resent.map((m) => [m.type, m.seq]), [['ht.echoed', 2], ['ht.echoed', 3], ['ht.pushed', 4]], `补发 ack 之后的全部，原 seq、按序：${JSON.stringify(resent)}`);
  assert.equal(env.mod.connects.length, 1, '模块只见过一次 connect');
  assert.equal(env.mod.disconnects.length, 0);

  // 接续后照常收发，身份不变
  r.sendSeq({ type: 'ht.echo', n: 9 });
  const e9 = await r.next((m) => m.type === 'ht.echoed' && m.n === 9);
  assert.equal(e9.seq, 5);
  assert.equal(env.mod.seen.at(-1).connId, connId);
  const d = env.service.describe();
  const conn = d.conns.find((x) => x.connId === connId);
  assert.ok(conn, `describe 里还是同一条连接 ${connId}：${JSON.stringify(d.conns.map((x) => x.connId))}`);
  assert.equal(conn.principal.userId, 'alice', '身份是建会话时的');
  assert.equal(conn.resumes, 1, `describe().conns[i].resumes：${JSON.stringify(conn)}`);
  assert.equal(conn.transport, 'ws');
  assert.equal(conn.detached, false);

  const resumeLog = env.logs.find((l) => l.event === 'session.resume');
  assert.ok(resumeLog, '日志 session.resume');
  assert.equal(resumeLog.connId, connId);
  assert.equal(resumeLog.transport, 'ws');
  assert.ok(Number.isFinite(resumeLog.gapMs) && resumeLog.gapMs >= 0, `gapMs：${JSON.stringify(resumeLog)}`);
  const h = await env.health();
  assert.ok(h.sessions.resumed >= 1, `sessions.resumed 计数：${JSON.stringify(h.sessions)}`);
});

test('HT1-dedup 补发与去重：客户端重发服务端已收过的 seq 一律丢弃，模块每条只见一次；接续后客户端按 welcome.ack 补发的照常进', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  c.sendSeq({ type: 'ht.echo', n: 1 });
  c.sendSeq({ type: 'ht.echo', n: 2 });
  await c.next((m) => m.type === 'ht.echoed' && m.n === 2);
  // 同一条传输上重发
  c.sendRaw({ type: 'ht.echo', n: 2, seq: 2 });
  c.sendRaw({ type: 'ht.echo', n: 1, seq: 1 });
  await sleep(100);
  assert.deepEqual(env.mod.seen.map((s) => s.msg.n), [1, 2], '同一传输上的重发丢弃');
  c.close();
  await c.ended();
  const r = await openSession(env, { resume: { sid: c.sid, ack: c.ackOf() } });
  assert.equal(r.welcome.ack, 2);
  // 客户端不看 welcome.ack、全部重发，再加一条新的
  r.sendRaw({ type: 'ht.echo', n: 1, seq: 1 });
  r.sendRaw({ type: 'ht.echo', n: 2, seq: 2 });
  r.sendRaw({ type: 'ht.echo', n: 3, seq: 3 });
  await r.next((m) => m.type === 'ht.echoed' && m.n === 3);
  await sleep(100);
  assert.deepEqual(env.mod.seen.map((s) => s.msg.n), [1, 2, 3], '跨传输的重发也丢弃，新的照常进');
  assert.equal(biz(r).filter((m) => m.type === 'error').length, 0, '重发不回错误');
});

test('HT1-superseded 接续时会话还挂着半开的旧 WebSocket：旧的以 4009 superseded 关掉，新的照常用', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  c.sendSeq({ type: 'ht.echo', n: 1 });
  await c.next((m) => m.type === 'ht.echoed');
  const r = await openSession(env, { resume: { sid: c.sid, ack: 1 }, startSeq: 1 });
  assert.equal(r.welcome.resumed, true);
  const ev = await c.ended();
  assert.deepEqual(ev, { code: 4009, reason: 'superseded' }, '旧传输 4009 superseded');
  r.sendSeq({ type: 'ht.echo', n: 2 });
  assert.equal((await r.next((m) => m.type === 'ht.echoed')).n, 2);
  assert.equal(env.mod.connects.length, 1);
  assert.equal(env.mod.disconnects.length, 0, '替换传输不结束会话');
  const h = await env.health();
  assert.equal(checkSessionsShape(h).total, 1, '仍是一个会话');
});

test('HT1-resume-exclusive 接续项与鉴权项互斥：两者同给握手不成功', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  const r = await rawHandshake(env.port, { protocols: [PROTOCOL, 'promptcut.user.alice', resumeItem(c.sid, 0)] });
  r.sock.destroy();
  assert.notEqual(r.status, 101, `给了接续项还带鉴权项：握手不成功（实际 ${r.status}）`);
  const r2 = await rawHandshake(env.port, { protocols: [PROTOCOL, 'promptcut.user.alice', SESSION_NEW, resumeItem(c.sid, 0)] });
  r2.sock.destroy();
  assert.notEqual(r2.status, 101, `新会话项与接续项同给：握手不成功（实际 ${r2.status}）`);
});

test('HT1-resume-fail 接续失败：会话不存在 404；已结束 410', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  assert.equal(await resumeStatus(env, 'A'.repeat(43), 0), 404, '不存在的会话号 404');
  const c = await openSession(env);
  c.sendRaw({ type: 'session.close', code: 1000, reason: 'bye' });
  await c.ended();
  assert.equal(await resumeStatus(env, c.sid, 0), 410, '主动结束之后 410');
});

// ------------------------------------------------------------------ 出错

test('HT1-bad-seq 跳号：服务端以 1002 bad-seq 结束会话，不保留（模块立即见断开，之后接续 410）', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  c.sendRaw({ type: 'ht.echo', n: 1, seq: 1 });
  await c.next((m) => m.type === 'ht.echoed');
  c.sendRaw({ type: 'ht.echo', n: 3, seq: 3 });
  assert.deepEqual(await c.ended(), { code: 1002, reason: 'bad-seq' });
  await waitFor(() => env.mod.disconnects.length === 1, 1000, '模块见断开');
  assert.deepEqual(env.mod.seen.map((s) => s.msg.n), [1], '跳号那条不交给模块');
  assert.equal(await resumeStatus(env, c.sid, 1), 410);
});

test('HT1-bad-ack ack 大于服务端发出过的最大 seq：1002 bad-seq', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  c.sendSeq({ type: 'ht.echo', n: 1 });
  await c.next((m) => m.type === 'ht.echoed');
  c.sendRaw({ type: 'session.ack', ack: 5 });
  assert.deepEqual(await c.ended(), { code: 1002, reason: 'bad-seq' });
  await waitFor(() => env.mod.disconnects.length === 1, 1000, '模块见断开');
  // 业务消息里顺带越界 ack 同样
  const c2 = await openSession(env, { user: 'bob' });
  c2.sendRaw({ type: 'ht.echo', n: 1, seq: 1, ack: 7 });
  assert.deepEqual(await c2.ended(), { code: 1002, reason: 'bad-seq' });
});

test('HT1-bad-resume-ack 接续项里的 ack 大于服务端发出过的最大 seq：不接续（握手不成功或以 1002 结束）', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  c.sendSeq({ type: 'ht.echo', n: 1 });
  await c.next((m) => m.type === 'ht.echoed');
  c.close();
  await c.ended();
  const r = await rawHandshake(env.port, { protocols: [PROTOCOL, resumeItem(c.sid, 9)] });
  if (r.status === 101) {
    // 接受了升级：随后应以 1002 关掉
    const ended = await new Promise((resolve) => { r.sock.once('close', () => resolve(true)); setTimeout(() => resolve(false), 2000); });
    assert.ok(ended, '接受升级后要立即以 1002 结束');
  }
  r.sock.destroy();
  await waitFor(() => env.mod.disconnects.length === 1, 2000, '会话结束，模块见断开');
});

// ------------------------------------------------------------------ 保留与结束

test('HT1-retain 保留期满结束：期内模块不见断开；期满 disconnect、日志 conn.timeout、sessions.expired 加一；之后接续 410', T, async (t) => {
  const env = await startService({ retainMs: 400 });
  t.after(env.cleanup);
  const c = await openSession(env);
  const connId = env.mod.connects[0].connId;
  c.close();
  await c.ended();
  const t0 = Date.now();
  await sleep(200);
  assert.equal(env.mod.disconnects.length, 0, '保留期内不断线');
  const h1 = checkSessionsShape(await env.health());
  assert.deepEqual({ total: h1.total, detached: h1.detached }, { total: 1, detached: 1 }, '脱开的会话在 /healthz 里');
  assert.equal(h1.list[0].transport, null);
  await waitFor(() => env.mod.disconnects.length === 1, 3000, '保留期满断线');
  assert.ok(Date.now() - t0 >= 350, `不早于保留时限（${Date.now() - t0} ms）`);
  assert.equal(env.mod.disconnects[0].connId, connId);
  const to = env.logs.find((l) => l.event === 'conn.timeout' && l.connId === connId);
  assert.ok(to, `日志 conn.timeout：${JSON.stringify(env.logs.map((l) => l.event))}`);
  const h2 = checkSessionsShape(await env.health());
  assert.equal(h2.total, 0);
  assert.equal(h2.expired, 1);
  assert.equal(await resumeStatus(env, c.sid, 0), 410, '过期后墓碑：410');
});

test('HT1-close 主动结束：客户端发 session.close，服务端立刻 disconnect，不等保留期', T, async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  const t0 = Date.now();
  c.sendRaw({ type: 'session.close', code: 1000, reason: 'done' });
  await waitFor(() => env.mod.disconnects.length === 1, 1500, '立刻断线');
  assert.ok(Date.now() - t0 < 1500);
  await c.ended();
  const h = checkSessionsShape(await env.health());
  assert.equal(h.total, 0);
  assert.equal(await resumeStatus(env, c.sid, 0), 410);
});

for (const [code, reason] of [[4003, 'kicked'], [4004, 'project-deleted']]) {
  test(`HT1-server-close-${code} 服务端主动关（${code}）：会话立刻结束、不保留，客户端收到 ${code}，接续 410`, T, async (t) => {
    const env = await startService({ retainMs: 60_000 });
    t.after(env.cleanup);
    const c = await openSession(env);
    const connId = env.mod.connects[0].connId;
    // 模块经核心关（踢人、删项目走这条，auth-contract 第 7 节）
    assert.equal(env.mod.ctx.close(connId, code, reason), true);
    const ev = await c.ended();
    assert.equal(ev.code, code);
    await waitFor(() => env.mod.disconnects.length === 1, 1500, '立刻断线');
    assert.equal(await resumeStatus(env, c.sid, 0), 410);
    assert.equal(checkSessionsShape(await env.health()).total, 0);
  });
}

test('HT1-server-close-closeConn 组装层 closeConn 同样结束会话、不保留', T, async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  const connId = env.mod.connects[0].connId;
  assert.equal(env.service.closeConn(connId, 4003, 'kicked'), true);
  assert.equal((await c.ended()).code, 4003);
  await waitFor(() => env.mod.disconnects.length === 1, 1500, '立刻断线');
  assert.equal(await resumeStatus(env, c.sid, 0), 410);
});

test('HT1-server-close-1001 关停：客户端收到 1001，会话立刻结束（模块在关停时见断开），脱开的会话同样结束', T, async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  const d = await openSession(env, { user: 'bob' });
  d.close();
  await d.ended();
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 2000, 'bob 脱开');
  const closing = env.cleanup();
  assert.equal((await c.ended()).code, 1001);
  await closing;
  await waitFor(() => env.mod.disconnects.length === 2, 1500, '两条会话都结束');
});

test('HT1-heartbeat 一轮 ping 没等到 pong：关掉这条传输，会话只脱开、不结束，之后能接续', T, async (t) => {
  const env = await startService({ heartbeatMs: 80, retainMs: 60_000 });
  t.after(env.cleanup);
  const raw = await rawWsClient(env.port, { protocols: [PROTOCOL, 'promptcut.user.alice', SESSION_NEW] });
  t.after(() => raw.destroy());
  const welcome = await raw.next((m) => m.type === 'session.welcome');
  raw.pause(); // 不读 socket：收不到 ping，也就不回 pong
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 3000, '心跳超时后脱开');
  await sleep(100);
  assert.equal(env.mod.disconnects.length, 0, '只脱开，不结束');
  raw.destroy();
  const r = await openSession(env, { resume: { sid: welcome.sid, ack: 0 } });
  assert.equal(r.welcome.resumed, true);
  assert.equal(env.mod.connects.length, 1);
});

// ------------------------------------------------------------------ 诊断

test('HT1-healthz /healthz 的 sessions：总数、按传输、脱开、旧客户端、累计计数与 list（每项五个键，脱开 transport null）', T, async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const a = await openSession(env, { user: 'alice' });
  const b = await openSession(env, { user: 'bob' });
  const { openLegacy } = await import('./ht-kit.mjs');
  await openLegacy(env, { user: 'carol' });
  b.close();
  await b.ended();
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 2000, 'bob 脱开');
  const h = await env.health();
  const s = checkSessionsShape(h);
  assert.equal(s.total, 3, JSON.stringify(s));
  assert.equal(s.detached, 1, JSON.stringify(s));
  assert.equal(s.legacy, 1, JSON.stringify(s));
  assert.equal(s.ws, 2, `alice 与旧客户端 carol 在 ws 上：${JSON.stringify(s)}`);
  assert.equal(s.http, 0);
  assert.equal(s.fallbacks, 0);
  assert.ok(s.opened >= 2, `opened 累计：${JSON.stringify(s)}`);
  const conns = env.service.describe().conns;
  assert.equal(conns.length, 3, 'describe 里三条（脱开的也在）');
  for (const conn of conns) {
    for (const k of ['transport', 'fallback', 'detached', 'resumes']) assert.ok(Object.hasOwn(conn, k), `describe().conns[i].${k}：${JSON.stringify(conn)}`);
  }
  const bobConn = conns.find((x) => x.principal.userId === 'bob');
  assert.deepEqual({ transport: bobConn.transport, detached: bobConn.detached }, { transport: null, detached: true });
  // 会话号不进 /healthz、describe()、日志
  for (const sid of [a.sid, b.sid]) {
    assertNoSid(JSON.stringify(h), sid, '/healthz');
    assertNoSid(JSON.stringify(env.service.describe()), sid, 'describe()');
    assertNoSid(JSON.stringify(env.logs), sid, '日志');
  }
});

test('HT1-no-sid-in-logs 接续、过期全程会话号不进日志；conn.open / conn.close 带 transport', T, async (t) => {
  const env = await startService({ retainMs: 200 });
  t.after(env.cleanup);
  const c = await openSession(env);
  c.close();
  await c.ended();
  const r = await openSession(env, { resume: { sid: c.sid, ack: 0 } });
  r.close();
  await r.ended();
  await waitFor(() => env.mod.disconnects.length === 1, 3000, '过期');
  assertNoSid(JSON.stringify(env.logs), c.sid, '日志');
  const open = env.logs.find((l) => l.event === 'conn.open');
  assert.equal(open?.transport, 'ws', `conn.open 带 transport：${JSON.stringify(open)}`);
  const timeout = env.logs.find((l) => l.event === 'conn.timeout');
  assert.ok(timeout && Object.hasOwn(timeout, 'transport'), `conn.timeout 带 transport：${JSON.stringify(timeout)}`);
});

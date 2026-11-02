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

test('HT1-open session creation: the first outbound message is session.welcome (sid is 256-bit base64url, resumed false, ack 0, retainMs, transport ws), and the echo is only promptcut.v1', T, async (t) => {
  const env = await startService({ retainMs: 45_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  assert.equal(c.all[0]?.type, 'session.welcome', `the first outbound message is welcome: ${JSON.stringify(c.all[0])}`);
  const w = c.welcome;
  assert.match(w.sid, SID_RE, 'sid is base64url of 32 bytes from a CSPRNG');
  assert.deepEqual({ resumed: w.resumed, ack: w.ack, retainMs: w.retainMs, transport: w.transport }, { resumed: false, ack: 0, retainMs: 45_000, transport: 'ws' });
  assert.ok(!('seq' in w), 'control messages carry no seq');
  assert.equal(c.ws.protocol, PROTOCOL, 'the handshake echoes only promptcut.v1, not the session items');
  assert.equal(env.auth.calls, 1, 'session creation authenticates once, as usual');
  assert.equal(env.mod.connects.length, 1, 'the core sees one connection');
  assert.equal(env.mod.connects[0].principal.userId, 'alice');

  // 两个 sid 不同
  const c2 = await openSession(env, { user: 'bob' });
  assert.notEqual(c2.sid, c.sid);
});

test('HT1-default-retain without retainMs, the retention limit defaults to 60 000 ms', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  assert.equal(c.welcome.retainMs, 60_000);
});

test('HT1-seq application messages carry seq in both directions: the server counts up by one from 1; the session layer strips seq and ack before handing messages to the module; replies piggyback ack', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  for (let n = 1; n <= 3; n++) c.sendSeq({ type: 'ht.echo', n });
  for (let n = 1; n <= 3; n++) await c.next((m) => m.type === 'ht.echoed' && m.n === n);
  const replies = biz(c);
  assert.deepEqual(replies.map((m) => m.seq), [1, 2, 3], `seq of server application messages starts at 1: ${JSON.stringify(replies)}`);
  assert.equal(replies.at(-1).ack, 3, `the last reply piggybacks ack = 3 (everything up to the client's 3rd message was received in order): ${JSON.stringify(replies.at(-1))}`);
  for (const r of replies) assert.ok(Number.isInteger(r.ack) && r.ack >= 1 && r.ack <= 3, `ack of the replies is between 1 and 3: ${JSON.stringify(r)}`);
  assert.deepEqual(env.mod.seen.map((s) => s.msg.n), [1, 2, 3], 'the module receives them in order');
  for (const s of env.mod.seen) {
    assert.ok(!('seq' in s.msg) && !('ack' in s.msg), `the module cannot see seq / ack: ${JSON.stringify(s.msg)}`);
  }
  // 模块之外的发送入口同样补 seq
  env.service.send(env.mod.connects[0].connId, { type: 'ht.pushed' });
  const pushed = await c.next((m) => m.type === 'ht.pushed');
  assert.equal(pushed.seq, 4);
});

test('HT1-control session.* control messages do not enter the core; modules may not claim the session. prefix', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  c.sendSeq({ type: 'ht.echo', n: 1 });
  await c.next((m) => m.type === 'ht.echoed');
  c.sendRaw({ type: 'session.ack', ack: 1 });
  await sleep(150);
  assert.deepEqual(env.mod.seen.map((s) => s.msg.type), ['ht.echo'], 'control messages are not handed to the module');
  assert.equal(biz(c).filter((m) => m.type === 'error').length, 0, `control messages do not get an unsupported reply: ${JSON.stringify(c.all)}`);
  assert.throws(() => env.service.mount({ name: 'thief', types: ['session.'], handle() {} }), 'mounting a module that claims the session. prefix must throw');
  assert.throws(() => env.service.mount({ name: 'thief2', types: ['session.ack'], handle() {} }), 'claiming a single session.* type is not allowed either');
});

test('HT1-ack-batch when received messages have no chance to piggyback, session.ack is sent on its own within 1 s; once 32 are unacknowledged it is sent on its own immediately', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  const t0 = Date.now();
  c.sendSeq({ type: 'ht.sink' });
  const a1 = await c.next((m) => m.type === 'session.ack', 2500);
  assert.equal(a1.ack, 1);
  assert.ok(!('seq' in a1), 'session.ack carries no seq');
  assert.ok(Date.now() - t0 < 1800, `sent on its own after about 1 s (actual ${Date.now() - t0} ms)`);

  const t1 = Date.now();
  for (let i = 0; i < 32; i++) c.sendSeq({ type: 'ht.sink' });
  const a2 = await c.next((m) => m.type === 'session.ack' && m.ack === 33, 2500);
  assert.ok(Date.now() - t1 < 700, `at 32 messages it does not wait for the 1 s timer (actual ${Date.now() - t1} ms)`);
  assert.equal(a2.ack, 33);
});

// ------------------------------------------------------------------ 接续

test('HT1-resume after a WebSocket drop, resume over WebSocket: no re-authentication, connId unchanged, the module sees no disconnect; welcome carries the ack for everything the server has fully received; unacknowledged server messages are resent (original seq, in order)', T, async (t) => {
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
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 2000, 'session.detach log');
  // 脱开期间服务端又写了一条
  env.service.send(connId, { type: 'ht.pushed', k: 'during-detach' });
  await sleep(50);
  assert.equal(env.mod.disconnects.length, 0, 'a transport drop only detaches the session; the core sees no disconnect');

  const authBefore = env.auth.calls;
  const r = await openSession(env, { resume: { sid: c.sid, ack: 1 }, startSeq: 3 });
  assert.equal(env.auth.calls, authBefore, 'resume no longer calls authenticate (the session ID is the credential)');
  assert.deepEqual({ resumed: r.welcome.resumed, ack: r.welcome.ack, transport: r.welcome.transport, sid: r.welcome.sid },
    { resumed: true, ack: 3, transport: 'ws', sid: c.sid }, 'welcome: resumed, the server has received the client\'s messages through the 3rd');
  assert.equal(r.all[0]?.type, 'session.welcome', 'welcome comes before the resend');
  await r.next((m) => m.type === 'ht.pushed');
  const resent = biz(r);
  assert.deepEqual(resent.map((m) => [m.type, m.seq]), [['ht.echoed', 2], ['ht.echoed', 3], ['ht.pushed', 4]], `everything after the ack is resent, original seq, in order: ${JSON.stringify(resent)}`);
  assert.equal(env.mod.connects.length, 1, 'the module saw connect only once');
  assert.equal(env.mod.disconnects.length, 0);

  // 接续后照常收发，身份不变
  r.sendSeq({ type: 'ht.echo', n: 9 });
  const e9 = await r.next((m) => m.type === 'ht.echoed' && m.n === 9);
  assert.equal(e9.seq, 5);
  assert.equal(env.mod.seen.at(-1).connId, connId);
  const d = env.service.describe();
  const conn = d.conns.find((x) => x.connId === connId);
  assert.ok(conn, `describe still shows the same connection ${connId}: ${JSON.stringify(d.conns.map((x) => x.connId))}`);
  assert.equal(conn.principal.userId, 'alice', 'the identity is the one from when the session was created');
  assert.equal(conn.resumes, 1, `describe().conns[i].resumes: ${JSON.stringify(conn)}`);
  assert.equal(conn.transport, 'ws');
  assert.equal(conn.detached, false);

  const resumeLog = env.logs.find((l) => l.event === 'session.resume');
  assert.ok(resumeLog, 'session.resume log');
  assert.equal(resumeLog.connId, connId);
  assert.equal(resumeLog.transport, 'ws');
  assert.ok(Number.isFinite(resumeLog.gapMs) && resumeLog.gapMs >= 0, `gapMs: ${JSON.stringify(resumeLog)}`);
  const h = await env.health();
  assert.ok(h.sessions.resumed >= 1, `sessions.resumed count: ${JSON.stringify(h.sessions)}`);
});

test('HT1-dedup resend and deduplication: any seq the client resends that the server has already received is discarded, so the module sees each message only once; messages the client resends after resuming according to welcome.ack go through as usual', T, async (t) => {
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
  assert.deepEqual(env.mod.seen.map((s) => s.msg.n), [1, 2], 'resends on the same transport are discarded');
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
  assert.deepEqual(env.mod.seen.map((s) => s.msg.n), [1, 2, 3], 'resends across transports are also discarded; new messages go through as usual');
  assert.equal(biz(r).filter((m) => m.type === 'error').length, 0, 'a resend does not produce an error reply');
});

test('HT1-superseded when resuming while the session still has a half-open old WebSocket attached: the old one is closed with 4009 superseded and the new one is used as usual', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  c.sendSeq({ type: 'ht.echo', n: 1 });
  await c.next((m) => m.type === 'ht.echoed');
  const r = await openSession(env, { resume: { sid: c.sid, ack: 1 }, startSeq: 1 });
  assert.equal(r.welcome.resumed, true);
  const ev = await c.ended();
  assert.deepEqual(ev, { code: 4009, reason: 'superseded' }, 'old transport 4009 superseded');
  r.sendSeq({ type: 'ht.echo', n: 2 });
  assert.equal((await r.next((m) => m.type === 'ht.echoed')).n, 2);
  assert.equal(env.mod.connects.length, 1);
  assert.equal(env.mod.disconnects.length, 0, 'replacing the transport does not end the session');
  const h = await env.health();
  assert.equal(checkSessionsShape(h).total, 1, 'still one session');
});

test('HT1-resume-exclusive the resume item and the auth item are mutually exclusive: giving both fails the handshake', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  const r = await rawHandshake(env.port, { protocols: [PROTOCOL, 'promptcut.user.alice', resumeItem(c.sid, 0)] });
  r.sock.destroy();
  assert.notEqual(r.status, 101, `resume item given together with an auth item: the handshake fails (actual ${r.status})`);
  const r2 = await rawHandshake(env.port, { protocols: [PROTOCOL, 'promptcut.user.alice', SESSION_NEW, resumeItem(c.sid, 0)] });
  r2.sock.destroy();
  assert.notEqual(r2.status, 101, `new-session item given together with a resume item: the handshake fails (actual ${r2.status})`);
});

test('HT1-resume-fail resume failure: session does not exist 404; already ended 410', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  assert.equal(await resumeStatus(env, 'A'.repeat(43), 0), 404, 'nonexistent session ID 404');
  const c = await openSession(env);
  c.sendRaw({ type: 'session.close', code: 1000, reason: 'bye' });
  await c.ended();
  assert.equal(await resumeStatus(env, c.sid, 0), 410, '410 after an explicit close');
});

// ------------------------------------------------------------------ 出错

test('HT1-bad-seq seq gap: the server ends the session with 1002 bad-seq and does not retain it (the module sees the disconnect immediately, and a later resume gets 410)', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  c.sendRaw({ type: 'ht.echo', n: 1, seq: 1 });
  await c.next((m) => m.type === 'ht.echoed');
  c.sendRaw({ type: 'ht.echo', n: 3, seq: 3 });
  assert.deepEqual(await c.ended(), { code: 1002, reason: 'bad-seq' });
  await waitFor(() => env.mod.disconnects.length === 1, 1000, 'the module sees the disconnect');
  assert.deepEqual(env.mod.seen.map((s) => s.msg.n), [1], 'the message with the gap is not handed to the module');
  assert.equal(await resumeStatus(env, c.sid, 1), 410);
});

test('HT1-bad-ack ack greater than the largest seq the server has sent: 1002 bad-seq', T, async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const c = await openSession(env);
  c.sendSeq({ type: 'ht.echo', n: 1 });
  await c.next((m) => m.type === 'ht.echoed');
  c.sendRaw({ type: 'session.ack', ack: 5 });
  assert.deepEqual(await c.ended(), { code: 1002, reason: 'bad-seq' });
  await waitFor(() => env.mod.disconnects.length === 1, 1000, 'the module sees the disconnect');
  // 业务消息里顺带越界 ack 同样
  const c2 = await openSession(env, { user: 'bob' });
  c2.sendRaw({ type: 'ht.echo', n: 1, seq: 1, ack: 7 });
  assert.deepEqual(await c2.ended(), { code: 1002, reason: 'bad-seq' });
});

test('HT1-bad-resume-ack the ack in the resume item is greater than the largest seq the server has sent: no resume (the handshake fails or ends with 1002)', T, async (t) => {
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
    assert.ok(ended, 'after accepting the upgrade, it must end immediately with 1002');
  }
  r.sock.destroy();
  await waitFor(() => env.mod.disconnects.length === 1, 2000, 'the session ends, the module sees the disconnect');
});

// ------------------------------------------------------------------ 保留与结束

test('HT1-retain end on retention period expiry: the module sees no disconnect during the period; at expiry disconnect fires, the conn.timeout log is written and sessions.expired goes up by one; a later resume gets 410', T, async (t) => {
  const env = await startService({ retainMs: 400 });
  t.after(env.cleanup);
  const c = await openSession(env);
  const connId = env.mod.connects[0].connId;
  c.close();
  await c.ended();
  const t0 = Date.now();
  await sleep(200);
  assert.equal(env.mod.disconnects.length, 0, 'no disconnect within the retention period');
  const h1 = checkSessionsShape(await env.health());
  assert.deepEqual({ total: h1.total, detached: h1.detached }, { total: 1, detached: 1 }, 'the detached session shows up in /healthz');
  assert.equal(h1.list[0].transport, null);
  await waitFor(() => env.mod.disconnects.length === 1, 3000, 'disconnect when the retention period expires');
  assert.ok(Date.now() - t0 >= 350, `not earlier than the retention limit (${Date.now() - t0} ms)`);
  assert.equal(env.mod.disconnects[0].connId, connId);
  const to = env.logs.find((l) => l.event === 'conn.timeout' && l.connId === connId);
  assert.ok(to, `conn.timeout log: ${JSON.stringify(env.logs.map((l) => l.event))}`);
  const h2 = checkSessionsShape(await env.health());
  assert.equal(h2.total, 0);
  assert.equal(h2.expired, 1);
  assert.equal(await resumeStatus(env, c.sid, 0), 410, 'tombstone after expiry: 410');
});

test('HT1-close explicit close: the client sends session.close, the server disconnects immediately without waiting for the retention period', T, async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  const t0 = Date.now();
  c.sendRaw({ type: 'session.close', code: 1000, reason: 'done' });
  await waitFor(() => env.mod.disconnects.length === 1, 1500, 'disconnects immediately');
  assert.ok(Date.now() - t0 < 1500);
  await c.ended();
  const h = checkSessionsShape(await env.health());
  assert.equal(h.total, 0);
  assert.equal(await resumeStatus(env, c.sid, 0), 410);
});

for (const [code, reason] of [[4003, 'kicked'], [4004, 'project-deleted']]) {
  test(`HT1-server-close-${code} server-initiated close (${code}): the session ends immediately without retention, the client receives ${code}, and a resume gets 410`, T, async (t) => {
    const env = await startService({ retainMs: 60_000 });
    t.after(env.cleanup);
    const c = await openSession(env);
    const connId = env.mod.connects[0].connId;
    // 模块经核心关（踢人、删项目走这条，auth-contract 第 7 节）
    assert.equal(env.mod.ctx.close(connId, code, reason), true);
    const ev = await c.ended();
    assert.equal(ev.code, code);
    await waitFor(() => env.mod.disconnects.length === 1, 1500, 'disconnects immediately');
    assert.equal(await resumeStatus(env, c.sid, 0), 410);
    assert.equal(checkSessionsShape(await env.health()).total, 0);
  });
}

test('HT1-server-close-closeConn closeConn in the assembly layer likewise ends the session without retention', T, async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  const connId = env.mod.connects[0].connId;
  assert.equal(env.service.closeConn(connId, 4003, 'kicked'), true);
  assert.equal((await c.ended()).code, 4003);
  await waitFor(() => env.mod.disconnects.length === 1, 1500, 'disconnects immediately');
  assert.equal(await resumeStatus(env, c.sid, 0), 410);
});

test('HT1-server-close-1001 shutdown: the client receives 1001, the session ends immediately (the module sees the disconnect at shutdown), and detached sessions end the same way', T, async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const c = await openSession(env);
  const d = await openSession(env, { user: 'bob' });
  d.close();
  await d.ended();
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 2000, 'bob detached');
  const closing = env.cleanup();
  assert.equal((await c.ended()).code, 1001);
  await closing;
  await waitFor(() => env.mod.disconnects.length === 2, 1500, 'both sessions ended');
});

test('HT1-heartbeat when a ping round gets no pong: the transport is closed, the session is only detached and not ended, and it can be resumed later', T, async (t) => {
  const env = await startService({ heartbeatMs: 80, retainMs: 60_000 });
  t.after(env.cleanup);
  const raw = await rawWsClient(env.port, { protocols: [PROTOCOL, 'promptcut.user.alice', SESSION_NEW] });
  t.after(() => raw.destroy());
  const welcome = await raw.next((m) => m.type === 'session.welcome');
  raw.pause(); // 不读 socket：收不到 ping，也就不回 pong
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 3000, 'detached after heartbeat timeout');
  await sleep(100);
  assert.equal(env.mod.disconnects.length, 0, 'only detached, not ended');
  raw.destroy();
  const r = await openSession(env, { resume: { sid: welcome.sid, ack: 0 } });
  assert.equal(r.welcome.resumed, true);
  assert.equal(env.mod.connects.length, 1);
});

// ------------------------------------------------------------------ 诊断

test('HT1-healthz sessions in /healthz: total, per transport, detached, old clients, cumulative counters and list (five keys per item, transport null when detached)', T, async (t) => {
  const env = await startService({ retainMs: 60_000 });
  t.after(env.cleanup);
  const a = await openSession(env, { user: 'alice' });
  const b = await openSession(env, { user: 'bob' });
  const { openLegacy } = await import('./ht-kit.mjs');
  await openLegacy(env, { user: 'carol' });
  b.close();
  await b.ended();
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 2000, 'bob detached');
  const h = await env.health();
  const s = checkSessionsShape(h);
  assert.equal(s.total, 3, JSON.stringify(s));
  assert.equal(s.detached, 1, JSON.stringify(s));
  assert.equal(s.legacy, 1, JSON.stringify(s));
  assert.equal(s.ws, 2, `alice and the old client carol are on ws: ${JSON.stringify(s)}`);
  assert.equal(s.http, 0);
  assert.equal(s.fallbacks, 0);
  assert.ok(s.opened >= 2, `opened (cumulative): ${JSON.stringify(s)}`);
  const conns = env.service.describe().conns;
  assert.equal(conns.length, 3, 'three in describe (detached ones included)');
  for (const conn of conns) {
    for (const k of ['transport', 'fallback', 'detached', 'resumes']) assert.ok(Object.hasOwn(conn, k), `describe().conns[i].${k}: ${JSON.stringify(conn)}`);
  }
  const bobConn = conns.find((x) => x.principal.userId === 'bob');
  assert.deepEqual({ transport: bobConn.transport, detached: bobConn.detached }, { transport: null, detached: true });
  // 会话号不进 /healthz、describe()、日志
  for (const sid of [a.sid, b.sid]) {
    assertNoSid(JSON.stringify(h), sid, '/healthz');
    assertNoSid(JSON.stringify(env.service.describe()), sid, 'describe()');
    assertNoSid(JSON.stringify(env.logs), sid, 'logs');
  }
});

test('HT1-no-sid-in-logs throughout resume and expiry the session ID never enters the logs; conn.open / conn.close carry transport', T, async (t) => {
  const env = await startService({ retainMs: 200 });
  t.after(env.cleanup);
  const c = await openSession(env);
  c.close();
  await c.ended();
  const r = await openSession(env, { resume: { sid: c.sid, ack: 0 } });
  r.close();
  await r.ended();
  await waitFor(() => env.mod.disconnects.length === 1, 3000, 'expired');
  assertNoSid(JSON.stringify(env.logs), c.sid, 'logs');
  const open = env.logs.find((l) => l.event === 'conn.open');
  assert.equal(open?.transport, 'ws', `conn.open carries transport: ${JSON.stringify(open)}`);
  const timeout = env.logs.find((l) => l.event === 'conn.timeout');
  assert.ok(timeout && Object.hasOwn(timeout, 'transport'), `conn.timeout carries transport: ${JSON.stringify(timeout)}`);
});

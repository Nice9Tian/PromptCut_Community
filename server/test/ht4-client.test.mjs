/**
 * HT4：客户端会话层 `createDocEndpoint`（契约 `docs/plan/http-transport-contract.md` 第 3、4.1～4.4、9 节，第 11 节 HT4
 * 的 WebSocket 部分）。跑：node --test server/test/ht4-client.test.mjs
 *
 * 前半用假 WebSocket（`ht-kit.mjs` 的 `fakeWebSocketEnv`）逐步驱动；后半（`HT4-real-*`）对着真的文档服务、经可控 TCP 代理断线。
 * 只照契约写，没看实现；假设见 `ht-kit.mjs`（H10～H12）。客户端会话层没到位时（`server/render-node/session-link.mjs`
 * 不存在）整组跳过；到位后自动真跑。
 * HT-b 的部分（失败转 HTTP、沿用同一份列表、HTTP 临时错误重试不报断开、HTTP 回 404 / 410 重建）不在这里：
 * 这里给的 `fetch` 一律失败，只要求「每次都先试 WebSocket」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SKIP_CLIENT, SKIP_BOTH, PROTOCOL, SESSION_NEW, ROOT,
  makeEndpoint, loadDocEndpoint, withEnv, isNewSessionList, resumeOf, waitFor, sleep, startService,
} from './ht-kit.mjs';
import { createTcpProxy } from './fake-ws-kit.mjs';

const T = { skip: SKIP_CLIENT };
const SID = 'S'.repeat(43);

async function openedEndpoint(overrides) {
  const h = await makeEndpoint(overrides);
  const s1 = await h.fake.nth(1);
  s1.accept({ sid: SID, retainMs: 60_000 });
  await waitFor(() => h.opened.length === 1, 2000, 'onOpen');
  return { ...h, s1 };
}

test('HT4-first try WebSocket first: http(s):// becomes ws(s)://; the list = the auth items freshly fetched from protocols() + promptcut.session.new; onOpen is called once established', T, async (t) => {
  const h = await makeEndpoint({ url: 'http://doc.test/hosted' });
  t.after(() => h.ep.close());
  const s1 = await h.fake.nth(1);
  const u = new URL(s1.url);
  assert.equal(u.protocol, 'ws:');
  assert.equal(u.host, 'doc.test');
  assert.equal(u.pathname.replace(/\/+$/, ''), '/hosted');
  assert.equal(s1.protocols[0], PROTOCOL);
  for (const p of ['promptcut.user.alice', 'promptcut.nonce.1', SESSION_NEW]) assert.ok(s1.protocols.includes(p), `the list contains ${p}: ${JSON.stringify(s1.protocols)}`);
  assert.equal(resumeOf(s1.protocols), null, 'a new session carries no resume item');
  assert.equal(h.calls.protocols, 1);
  assert.equal(h.opened.length, 0, 'not counted as established until the handshake succeeds and welcome arrives');
  s1.accept({ sid: SID });
  await waitFor(() => h.opened.length === 1, 2000, 'onOpen');
  assert.equal(h.ep.connected, true);
  assert.equal(h.resumed.length, 0);

  const h2 = await makeEndpoint({ url: 'https://doc.test/hosted/' });
  t.after(() => h2.ep.close());
  assert.equal(new URL((await h2.fake.nth(1)).url).protocol, 'wss:', 'https → wss');
  const h3 = await makeEndpoint({ url: 'wss://doc.test/hosted' });
  t.after(() => h3.ep.close());
  assert.equal(new URL((await h3.fake.nth(1)).url).protocol, 'wss:', 'wss kept as is');
});

test('HT4-seq outbound application messages carry seq (from 1) and piggyback ack; inbound messages are received by seq: seq / ack are stripped before onMessage, resends are discarded, and session.* is not handed to the upper layer', T, async (t) => {
  const h = await openedEndpoint();
  t.after(() => h.ep.close());
  h.ep.send({ type: 'a', n: 1 });
  h.ep.send({ type: 'a', n: 2 });
  assert.deepEqual(h.s1.biz().map((m) => [m.n, m.seq]), [[1, 1], [2, 2]]);
  h.s1.push({ type: 'x', k: 1, seq: 1 });
  h.s1.push({ type: 'x', k: 2, seq: 2, ack: 2 });
  h.s1.push({ type: 'x', k: 2, seq: 2 }); // 重发
  h.s1.push({ type: 'session.ack', ack: 2 });
  await sleep(20);
  assert.deepEqual(h.messages, [{ type: 'x', k: 1 }, { type: 'x', k: 2 }], `onMessage received the two messages with seq / ack stripped: ${JSON.stringify(h.messages)}`);
  h.ep.send({ type: 'a', n: 3 });
  const third = h.s1.biz().at(-1);
  assert.equal(third.seq, 3);
  assert.equal(third.ack, 2, `the outbound message piggybacks ack: ${JSON.stringify(third)}`);
});

test('HT4-ack-timer messages are received but there is no chance to send outbound: session.ack is sent on its own within 1 s', T, async (t) => {
  const h = await openedEndpoint();
  t.after(() => h.ep.close());
  h.s1.push({ type: 'x', seq: 1 });
  await waitFor(() => h.s1.control('session.ack').some((m) => m.ack === 1), 1800, 'standalone session.ack');
  assert.ok(!('seq' in h.s1.control('session.ack')[0]), 'control messages carry no seq');
});

test('HT4-resume when the transport drops: the resume item carries the ack for everything received, no auth item, and protocols() is not called again; resume calls onResume, not onOpen; sends made during the disconnect are not lost and are resent in order (only those after welcome.ack)', T, async (t) => {
  const h = await openedEndpoint();
  t.after(() => h.ep.close());
  h.ep.send({ type: 'a', n: 1 });
  h.ep.send({ type: 'a', n: 2 });
  h.s1.push({ type: 'x', seq: 1, ack: 1 });
  await sleep(10);
  h.s1.drop(1006);
  await sleep(5);
  h.ep.send({ type: 'a', n: 3 }); // 脱开期间
  assert.ok(h.ep.stats().pendingBytes > 0, `unacknowledged outbound messages are in the buffer: ${JSON.stringify(h.ep.stats())}`);
  const s2 = await h.fake.nth(2);
  assert.deepEqual(resumeOf(s2.protocols), { sid: SID, ack: 1 }, `resume item: ${JSON.stringify(s2.protocols)}`);
  assert.equal(s2.protocols[0], PROTOCOL);
  assert.ok(!s2.protocols.some((p) => p.startsWith('promptcut.user.') || p.startsWith('promptcut.nonce.')), 'the resume item and the auth item are mutually exclusive');
  assert.ok(!s2.protocols.includes(SESSION_NEW));
  assert.equal(h.calls.protocols, 1, 'resume does not fetch a new one-time credential');
  assert.equal(h.closes.length, 0, 'a transport drop does not report onClose');
  s2.accept({ sid: SID, resumed: true, ack: 1 });
  await waitFor(() => h.resumed.length === 1, 2000, 'onResume');
  assert.equal(h.opened.length, 1, 'resume does not call onOpen');
  await waitFor(() => s2.biz().length >= 2, 2000, 'resend');
  assert.deepEqual(s2.biz().map((m) => [m.n, m.seq]), [[2, 2], [3, 3]], `only those after welcome.ack are resent, in order, with the original seq: ${JSON.stringify(s2.biz())}`);
  assert.equal(h.ep.stats().resumes, 1);
  assert.equal(h.ep.stats().transport, 'ws');
  // 接续后服务端接着编号
  s2.push({ type: 'x', seq: 2, ack: 3 });
  await sleep(10);
  assert.equal(h.messages.length, 2);
  assert.equal(h.ep.stats().pendingBytes, 0, 'released after ack advances');
});

test('HT4-error-only on handshake failure there is only error and no close (Node behavior measured in the cloud on 2026-09-27): backoff retry still happens', T, async (t) => {
  const h = await makeEndpoint();
  t.after(() => h.ep.close());
  (await h.fake.nth(1)).fail({ errorOnly: true });
  const s2 = await h.fake.nth(2, 2000);
  assert.ok(isNewSessionList(s2.protocols), 'no session has been established yet: the retry is still a new session');
  assert.equal(h.calls.protocols, 2, 'creating a new session fetches a one-time credential again');
  // 已建成的会话断开后，接续的握手同样只报 error：照样再试
  s2.accept({ sid: SID });
  await waitFor(() => h.opened.length === 1, 2000, 'onOpen');
  s2.drop(1006);
  const s3 = await h.fake.nth(3, 2000);
  assert.deepEqual(resumeOf(s3.protocols), { sid: SID, ack: 0 });
  s3.fail({ errorOnly: true });
  const s4 = await h.fake.nth(4, 2000);
  assert.deepEqual(resumeOf(s4.protocols), { sid: SID, ack: 0 }, 'keeps trying to resume within the retention period');
});

test('HT4-ws-first-every-time every reconnect starts with WebSocket (HT-a: the same when HTTP never connects)', T, async (t) => {
  const h = await makeEndpoint();
  t.after(() => h.ep.close());
  for (let n = 1; n <= 4; n++) {
    const s = await h.fake.nth(n, 3000);
    assert.ok(isNewSessionList(s.protocols), `attempt ${n} still creates a new session over WebSocket`);
    s.fail();
  }
});

test('HT4-forced-ws PROMPTCUT_TRANSPORT=ws (or the option transport: \'ws\'): only WebSocket is used, and a failure does not touch HTTP either', T, async (t) => {
  const restore = withEnv('PROMPTCUT_TRANSPORT', 'ws');
  let h;
  try {
    h = await makeEndpoint();
  } finally {
    restore();
  }
  t.after(() => h.ep.close());
  for (let n = 1; n <= 3; n++) (await h.fake.nth(n, 3000)).fail();
  await h.fake.nth(4, 3000);
  assert.equal(h.fetch.calls, 0, 'no HTTP request is sent when ws is forced');

  const restore2 = withEnv('PROMPTCUT_TRANSPORT', undefined);
  let h2;
  try {
    h2 = await makeEndpoint({ transport: 'ws' });
  } finally {
    restore2();
  }
  t.after(() => h2.ep.close());
  for (let n = 1; n <= 3; n++) (await h2.fake.nth(n, 3000)).fail();
  await h2.fake.nth(4, 3000);
  assert.equal(h2.fetch.calls, 0, 'the option transport: ws behaves the same');
});

for (const code of [4003, 4004, 1013, 1001, 1002]) {
  test(`HT4-server-end-${code} the server ends the session with ${code}: onClose { code } is reported, no resume, and the next attempt creates a new session; sends after the session ends are discarded and counted, and the old session's unacknowledged messages are not carried into the new session`, T, async (t) => {
    const h = await openedEndpoint();
    t.after(() => h.ep.close());
    h.ep.send({ type: 'a', n: 1 }); // 未确认
    h.s1.drop(code, 'server-ended');
    await waitFor(() => h.closes.length === 1, 2000, 'onClose');
    assert.equal(h.closes[0].code, code);
    const dropped0 = h.ep.stats().dropped;
    h.ep.send({ type: 'a', n: 2 });
    assert.equal(h.ep.stats().dropped, dropped0 + 1, 'send after the session ends is discarded and counted in dropped');
    const s2 = await h.fake.nth(2, 20_000);
    assert.ok(isNewSessionList(s2.protocols), `no resume, create a new session: ${JSON.stringify(s2.protocols)}`);
    assert.equal(h.calls.protocols, 2);
    s2.accept({ sid: 'T'.repeat(43) });
    await waitFor(() => h.opened.length === 2, 2000, 'new session onOpen');
    await sleep(30);
    assert.deepEqual(s2.biz(), [], 'neither the old session\'s unacknowledged messages nor those discarded after the end enter the new session');
    h.ep.send({ type: 'a', n: 3 });
    assert.equal(s2.biz()[0].seq, 1, 'the new session renumbers from 1');
  });
}

test('HT4-bad-seq seq gap in a server message: the client ends the session (onClose 1002) and creates a new session', T, async (t) => {
  const h = await openedEndpoint();
  t.after(() => h.ep.close());
  h.s1.push({ type: 'x', seq: 1 });
  h.s1.push({ type: 'x', seq: 3 });
  await waitFor(() => h.closes.length === 1, 2000, 'onClose');
  assert.equal(h.closes[0].code, 1002);
  assert.deepEqual(h.messages, [{ type: 'x' }], 'the message with the gap is not handed to the upper layer');
  const s2 = await h.fake.nth(2, 3000);
  assert.ok(isNewSessionList(s2.protocols));
});

test('HT4-bad-ack the server\'s ack is greater than the largest seq the client has sent: the session is ended the same way (1002)', T, async (t) => {
  const h = await openedEndpoint();
  t.after(() => h.ep.close());
  h.ep.send({ type: 'a', n: 1 });
  h.s1.push({ type: 'session.ack', ack: 5 });
  await waitFor(() => h.closes.length === 1, 2000, 'onClose');
  assert.equal(h.closes[0].code, 1002);
});

test('HT4-pending-cap the client\'s unacknowledged outbound exceeds 1 MiB: the session ends, onClose { code: 1013 }', T, async (t) => {
  const h = await openedEndpoint();
  t.after(() => h.ep.close());
  h.s1.drop(1006);
  await sleep(5);
  const pad = 'z'.repeat(100 * 1024);
  for (let i = 0; i < 12 && h.closes.length === 0; i++) h.ep.send({ type: 'a', i, pad });
  await waitFor(() => h.closes.length === 1, 2000, 'onClose');
  assert.equal(h.closes[0].code, 1013);
});

test('HT4-retain-expiry resume never gets through the handshake: once welcome.retainMs has passed, the session is treated as ended (onClose), and a new session is created with freshly fetched credentials (404 / 410 cannot be read in HT-a, assumption H11)', T, async (t) => {
  const h = await makeEndpoint();
  t.after(() => h.ep.close());
  const s1 = await h.fake.nth(1);
  s1.accept({ sid: SID, retainMs: 300 });
  await waitFor(() => h.opened.length === 1, 2000, 'onOpen');
  h.ep.send({ type: 'a', n: 1 });
  const t0 = Date.now();
  s1.drop(1006);
  let n = 2;
  let fresh = null;
  while (!fresh) {
    const s = await h.fake.nth(n, 4000);
    n += 1;
    if (isNewSessionList(s.protocols)) fresh = s;
    else { assert.deepEqual(resumeOf(s.protocols)?.sid, SID); s.fail(); }
  }
  const took = Date.now() - t0;
  assert.ok(took >= 250, `gives up no earlier than the retention limit (${took} ms)`);
  assert.ok(took < 3300, `rebuilt within a few seconds after the retention limit (${took} ms)`);
  assert.equal(h.closes.length, 1, 'onClose is reported once when resume is abandoned');
  assert.equal(h.calls.protocols, 2, 'rebuilding the session fetches a one-time credential again');
  fresh.accept({ sid: 'T'.repeat(43) });
  await waitFor(() => h.opened.length === 2, 2000, 'new session onOpen');
  assert.deepEqual(fresh.biz(), [], 'the old session\'s messages do not enter the new session');
});

test('HT4-close close(): sends session.close first and then closes, does not reconnect afterwards, closed is true, and send is discarded', T, async (t) => {
  const h = await openedEndpoint();
  h.ep.close();
  assert.equal(h.s1.control('session.close').length, 1, `session.close was sent: ${JSON.stringify(h.s1.sent)}`);
  assert.ok(!('seq' in h.s1.control('session.close')[0]), 'control messages carry no seq');
  await sleep(150);
  assert.equal(h.fake.sockets.length, 1, 'no reconnect after close()');
  assert.equal(h.ep.closed, true);
  assert.equal(h.ep.connected, false);
  const d = h.ep.stats().dropped;
  h.ep.send({ type: 'a' });
  assert.equal(h.ep.stats().dropped, d + 1);
});

test('HT4-stats stats() also has transport, fallbacks, resumes and pendingBytes; ack releases pendingBytes', T, async (t) => {
  const h = await openedEndpoint();
  t.after(() => h.ep.close());
  const s = h.ep.stats();
  for (const k of ['transport', 'fallbacks', 'resumes', 'pendingBytes', 'dropped']) assert.ok(Object.hasOwn(s, k), `stats().${k}: ${JSON.stringify(s)}`);
  assert.deepEqual({ transport: s.transport, fallbacks: s.fallbacks, resumes: s.resumes, pendingBytes: s.pendingBytes }, { transport: 'ws', fallbacks: 0, resumes: 0, pendingBytes: 0 });
  h.ep.send({ type: 'a', pad: 'q'.repeat(1000) });
  assert.ok(h.ep.stats().pendingBytes >= 1000);
  h.s1.push({ type: 'session.ack', ack: 1 });
  await sleep(10);
  assert.equal(h.ep.stats().pendingBytes, 0);
  assert.equal(typeof h.ep.onResume, 'function');
});

test('HT4-index server/render-node/index.mjs exports createDocEndpoint', T, async () => {
  const { createDocEndpoint } = await loadDocEndpoint();
  const index = await import(pathToFileURL(path.join(ROOT, 'server', 'render-node', 'index.mjs')).href);
  assert.equal(index.createDocEndpoint, createDocEndpoint);
});

// ------------------------------------------------------------------ 对着真的文档服务

async function realPair(t, serviceOpts = {}) {
  const env = await startService({ retainMs: 60_000, ...serviceOpts });
  t.after(env.cleanup);
  const proxy = await createTcpProxy({ target: env.port });
  t.after(() => proxy.close());
  const { createDocEndpoint } = await loadDocEndpoint();
  const got = [];
  const ev = { opens: 0, resumes: 0, closes: [] };
  const ep = createDocEndpoint({
    url: `ws://127.0.0.1:${proxy.port}/`,
    protocols: () => [PROTOCOL, 'promptcut.user.alice'],
    backoff: { baseMs: 20, factor: 2, maxMs: 100, jitter: 0 },
    transport: 'ws',
  });
  t.after(() => ep.close());
  ep.onMessage((m) => got.push(m));
  ep.onOpen(() => { ev.opens += 1; });
  ep.onResume(() => { ev.resumes += 1; });
  ep.onClose((info) => ev.closes.push(info));
  await waitFor(() => ev.opens === 1, 3000, 'session created');
  return { env, proxy, ep, got, ev };
}

test('HT4-real-resume real service: after the transport is cut it resumes automatically; what both sides sent during the disconnect arrives in order, once each; the core sees no disconnect', SKIP_BOTH ? { skip: SKIP_BOTH } : {}, async (t) => {
  const { env, proxy, ep, got, ev } = await realPair(t);
  ep.send({ type: 'ht.echo', n: 1 });
  await waitFor(() => got.some((m) => m.n === 1), 2000, 'reply 1');
  proxy.cutAll();
  ep.send({ type: 'ht.echo', n: 2 });
  ep.send({ type: 'ht.echo', n: 3 });
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 2000, 'server detached');
  env.service.send(env.mod.connects[0].connId, { type: 'ht.pushed' });
  await waitFor(() => got.filter((m) => m.type === 'ht.echoed').length === 3 && got.some((m) => m.type === 'ht.pushed'), 5000, 'everything arrives after the resume');
  assert.equal(ev.resumes, 1);
  assert.equal(ev.opens, 1);
  assert.deepEqual(ev.closes, []);
  assert.deepEqual(env.mod.seen.map((s) => s.msg.n), [1, 2, 3], 'the server module sees each message once, in order');
  assert.deepEqual(got.filter((m) => m.type === 'ht.echoed').map((m) => m.n), [1, 2, 3]);
  for (const m of got) assert.ok(!('seq' in m) && !('ack' in m));
  assert.equal(env.mod.disconnects.length, 0);
  assert.equal(env.mod.connects.length, 1);
});

test('HT4-real-410 real service: when the session has already expired on the server (410), the client re-creates the session (onClose once, onOpen a second time)', SKIP_BOTH ? { skip: SKIP_BOTH } : {}, async (t) => {
  const { env, proxy, ev } = await realPair(t, { retainMs: 300 });
  proxy.mode = 'reject';
  proxy.cutAll();
  await waitFor(() => env.mod.disconnects.length === 1, 3000, 'server retention period expired');
  proxy.mode = 'pass';
  await waitFor(() => ev.opens === 2, 5000, 'session rebuilt');
  assert.equal(ev.closes.length, 1);
  assert.equal(env.mod.connects.length, 2);
  const h = await env.health();
  assert.ok(h.sessions.opened >= 2);
});

test('HT4-real-404 real service: when the server has been replaced by another one (session does not exist, 404), the client re-creates the session', SKIP_BOTH ? { skip: SKIP_BOTH } : {}, async (t) => {
  const { proxy, ev } = await realPair(t, { retainMs: 300 });
  const other = await startService({ retainMs: 60_000 });
  t.after(other.cleanup);
  proxy.retarget(other.port);
  proxy.cutAll();
  await waitFor(() => ev.opens === 2, 5000, 'session rebuilt on the new service');
  assert.equal(ev.closes.length, 1);
  assert.equal(other.mod.connects.length, 1);
});

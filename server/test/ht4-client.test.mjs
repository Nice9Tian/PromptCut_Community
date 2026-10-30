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

test('HT4-first 先试 WebSocket：http(s):// 换成 ws(s)://；列表 = protocols() 现取的鉴权项 + promptcut.session.new；建成调 onOpen', T, async (t) => {
  const h = await makeEndpoint({ url: 'http://doc.test/hosted' });
  t.after(() => h.ep.close());
  const s1 = await h.fake.nth(1);
  const u = new URL(s1.url);
  assert.equal(u.protocol, 'ws:');
  assert.equal(u.host, 'doc.test');
  assert.equal(u.pathname.replace(/\/+$/, ''), '/hosted');
  assert.equal(s1.protocols[0], PROTOCOL);
  for (const p of ['promptcut.user.alice', 'promptcut.nonce.1', SESSION_NEW]) assert.ok(s1.protocols.includes(p), `列表里有 ${p}：${JSON.stringify(s1.protocols)}`);
  assert.equal(resumeOf(s1.protocols), null, '新会话不带接续项');
  assert.equal(h.calls.protocols, 1);
  assert.equal(h.opened.length, 0, '握手没成、没 welcome 之前不算建成');
  s1.accept({ sid: SID });
  await waitFor(() => h.opened.length === 1, 2000, 'onOpen');
  assert.equal(h.ep.connected, true);
  assert.equal(h.resumed.length, 0);

  const h2 = await makeEndpoint({ url: 'https://doc.test/hosted/' });
  t.after(() => h2.ep.close());
  assert.equal(new URL((await h2.fake.nth(1)).url).protocol, 'wss:', 'https → wss');
  const h3 = await makeEndpoint({ url: 'wss://doc.test/hosted' });
  t.after(() => h3.ep.close());
  assert.equal(new URL((await h3.fake.nth(1)).url).protocol, 'wss:', 'wss 原样');
});

test('HT4-seq 出站业务消息带 seq（从 1 起）并顺带 ack；入站按 seq 收：摘掉 seq / ack 再交 onMessage、重发丢弃、session.* 不交上层', T, async (t) => {
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
  assert.deepEqual(h.messages, [{ type: 'x', k: 1 }, { type: 'x', k: 2 }], `onMessage 收到摘掉 seq / ack 的两条：${JSON.stringify(h.messages)}`);
  h.ep.send({ type: 'a', n: 3 });
  const third = h.s1.biz().at(-1);
  assert.equal(third.seq, 3);
  assert.equal(third.ack, 2, `出站消息顺带 ack：${JSON.stringify(third)}`);
});

test('HT4-ack-timer 收到消息而没有出站的机会：1 s 内单发 session.ack', T, async (t) => {
  const h = await openedEndpoint();
  t.after(() => h.ep.close());
  h.s1.push({ type: 'x', seq: 1 });
  await waitFor(() => h.s1.control('session.ack').some((m) => m.ack === 1), 1800, '单发 session.ack');
  assert.ok(!('seq' in h.s1.control('session.ack')[0]), '控制消息不带 seq');
});

test('HT4-resume 传输断了：接续项带已收全的 ack、不带鉴权项、不再调 protocols()；接续调 onResume 不调 onOpen；断开期间的 send 不丢，按序补发（只补 welcome.ack 之后的）', T, async (t) => {
  const h = await openedEndpoint();
  t.after(() => h.ep.close());
  h.ep.send({ type: 'a', n: 1 });
  h.ep.send({ type: 'a', n: 2 });
  h.s1.push({ type: 'x', seq: 1, ack: 1 });
  await sleep(10);
  h.s1.drop(1006);
  await sleep(5);
  h.ep.send({ type: 'a', n: 3 }); // 脱开期间
  assert.ok(h.ep.stats().pendingBytes > 0, `未确认的出站在缓冲里：${JSON.stringify(h.ep.stats())}`);
  const s2 = await h.fake.nth(2);
  assert.deepEqual(resumeOf(s2.protocols), { sid: SID, ack: 1 }, `接续项：${JSON.stringify(s2.protocols)}`);
  assert.equal(s2.protocols[0], PROTOCOL);
  assert.ok(!s2.protocols.some((p) => p.startsWith('promptcut.user.') || p.startsWith('promptcut.nonce.')), '接续项与鉴权项互斥');
  assert.ok(!s2.protocols.includes(SESSION_NEW));
  assert.equal(h.calls.protocols, 1, '接续不取新的一次性凭证');
  assert.equal(h.closes.length, 0, '传输断开不报 onClose');
  s2.accept({ sid: SID, resumed: true, ack: 1 });
  await waitFor(() => h.resumed.length === 1, 2000, 'onResume');
  assert.equal(h.opened.length, 1, '接续不调 onOpen');
  await waitFor(() => s2.biz().length >= 2, 2000, '补发');
  assert.deepEqual(s2.biz().map((m) => [m.n, m.seq]), [[2, 2], [3, 3]], `只补 welcome.ack 之后的、按序、原 seq：${JSON.stringify(s2.biz())}`);
  assert.equal(h.ep.stats().resumes, 1);
  assert.equal(h.ep.stats().transport, 'ws');
  // 接续后服务端接着编号
  s2.push({ type: 'x', seq: 2, ack: 3 });
  await sleep(10);
  assert.equal(h.messages.length, 2);
  assert.equal(h.ep.stats().pendingBytes, 0, 'ack 推进后释放');
});

test('HT4-error-only 握手失败时只有 error、没有 close（2026-09-27 云端实测的 Node 行为）：照样退避重试', T, async (t) => {
  const h = await makeEndpoint();
  t.after(() => h.ep.close());
  (await h.fake.nth(1)).fail({ errorOnly: true });
  const s2 = await h.fake.nth(2, 2000);
  assert.ok(isNewSessionList(s2.protocols), '还没建成过会话：重试仍是新会话');
  assert.equal(h.calls.protocols, 2, '重新建会话重新取一次性凭证');
  // 已建成的会话断开后，接续的握手同样只报 error：照样再试
  s2.accept({ sid: SID });
  await waitFor(() => h.opened.length === 1, 2000, 'onOpen');
  s2.drop(1006);
  const s3 = await h.fake.nth(3, 2000);
  assert.deepEqual(resumeOf(s3.protocols), { sid: SID, ack: 0 });
  s3.fail({ errorOnly: true });
  const s4 = await h.fake.nth(4, 2000);
  assert.deepEqual(resumeOf(s4.protocols), { sid: SID, ack: 0 }, '保留期内接着试接续');
});

test('HT4-ws-first-every-time 每次重连都从 WebSocket 开始（HT-a：HTTP 一律连不上时也一样）', T, async (t) => {
  const h = await makeEndpoint();
  t.after(() => h.ep.close());
  for (let n = 1; n <= 4; n++) {
    const s = await h.fake.nth(n, 3000);
    assert.ok(isNewSessionList(s.protocols), `第 ${n} 次仍是 WebSocket 建新会话`);
    s.fail();
  }
});

test('HT4-forced-ws PROMPTCUT_TRANSPORT=ws（或选项 transport: \'ws\'）：只用 WebSocket，失败也不碰 HTTP', T, async (t) => {
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
  assert.equal(h.fetch.calls, 0, '强制 ws 时不发任何 HTTP 请求');

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
  assert.equal(h2.fetch.calls, 0, '选项 transport: ws 同样');
});

for (const code of [4003, 4004, 1013, 1001, 1002]) {
  test(`HT4-server-end-${code} 服务端以 ${code} 结束会话：报 onClose { code }、不接续、下一次建新会话；会话结束后的 send 丢弃并计数，旧会话未确认的不带进新会话`, T, async (t) => {
    const h = await openedEndpoint();
    t.after(() => h.ep.close());
    h.ep.send({ type: 'a', n: 1 }); // 未确认
    h.s1.drop(code, 'server-ended');
    await waitFor(() => h.closes.length === 1, 2000, 'onClose');
    assert.equal(h.closes[0].code, code);
    const dropped0 = h.ep.stats().dropped;
    h.ep.send({ type: 'a', n: 2 });
    assert.equal(h.ep.stats().dropped, dropped0 + 1, '会话结束后 send 丢弃、计入 dropped');
    const s2 = await h.fake.nth(2, 20_000);
    assert.ok(isNewSessionList(s2.protocols), `不接续，建新会话：${JSON.stringify(s2.protocols)}`);
    assert.equal(h.calls.protocols, 2);
    s2.accept({ sid: 'T'.repeat(43) });
    await waitFor(() => h.opened.length === 2, 2000, '新会话 onOpen');
    await sleep(30);
    assert.deepEqual(s2.biz(), [], '旧会话的未确认消息与结束后丢弃的都不进新会话');
    h.ep.send({ type: 'a', n: 3 });
    assert.equal(s2.biz()[0].seq, 1, '新会话从 1 重新编号');
  });
}

test('HT4-bad-seq 服务端消息跳号：客户端结束会话（onClose 1002），重新建会话', T, async (t) => {
  const h = await openedEndpoint();
  t.after(() => h.ep.close());
  h.s1.push({ type: 'x', seq: 1 });
  h.s1.push({ type: 'x', seq: 3 });
  await waitFor(() => h.closes.length === 1, 2000, 'onClose');
  assert.equal(h.closes[0].code, 1002);
  assert.deepEqual(h.messages, [{ type: 'x' }], '跳号那条不交上层');
  const s2 = await h.fake.nth(2, 3000);
  assert.ok(isNewSessionList(s2.protocols));
});

test('HT4-bad-ack 服务端的 ack 大于客户端发出过的最大 seq：同样结束会话（1002）', T, async (t) => {
  const h = await openedEndpoint();
  t.after(() => h.ep.close());
  h.ep.send({ type: 'a', n: 1 });
  h.s1.push({ type: 'session.ack', ack: 5 });
  await waitFor(() => h.closes.length === 1, 2000, 'onClose');
  assert.equal(h.closes[0].code, 1002);
});

test('HT4-pending-cap 客户端未确认的出站超过 1 MiB：结束会话，onClose { code: 1013 }', T, async (t) => {
  const h = await openedEndpoint();
  t.after(() => h.ep.close());
  h.s1.drop(1006);
  await sleep(5);
  const pad = 'z'.repeat(100 * 1024);
  for (let i = 0; i < 12 && h.closes.length === 0; i++) h.ep.send({ type: 'a', i, pad });
  await waitFor(() => h.closes.length === 1, 2000, 'onClose');
  assert.equal(h.closes[0].code, 1013);
});

test('HT4-retain-expiry 接续一直握不上：过了 welcome.retainMs 就当会话已结束（onClose），重新取凭证建新会话（HT-a 里 404 / 410 读不到，假设 H11）', T, async (t) => {
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
  assert.ok(took >= 250, `不早于保留时限就放弃（${took} ms）`);
  assert.ok(took < 3300, `保留时限加几秒之内重建（${took} ms）`);
  assert.equal(h.closes.length, 1, '放弃接续时报一次 onClose');
  assert.equal(h.calls.protocols, 2, '重建会话重新取一次性凭证');
  fresh.accept({ sid: 'T'.repeat(43) });
  await waitFor(() => h.opened.length === 2, 2000, '新会话 onOpen');
  assert.deepEqual(fresh.biz(), [], '旧会话的消息不进新会话');
});

test('HT4-close close()：先发 session.close 再关，之后不再重连，closed 为真，send 丢弃', T, async (t) => {
  const h = await openedEndpoint();
  h.ep.close();
  assert.equal(h.s1.control('session.close').length, 1, `发了 session.close：${JSON.stringify(h.s1.sent)}`);
  assert.ok(!('seq' in h.s1.control('session.close')[0]), '控制消息不带 seq');
  await sleep(150);
  assert.equal(h.fake.sockets.length, 1, 'close() 之后不重连');
  assert.equal(h.ep.closed, true);
  assert.equal(h.ep.connected, false);
  const d = h.ep.stats().dropped;
  h.ep.send({ type: 'a' });
  assert.equal(h.ep.stats().dropped, d + 1);
});

test('HT4-stats stats() 另有 transport、fallbacks、resumes、pendingBytes；ack 释放 pendingBytes', T, async (t) => {
  const h = await openedEndpoint();
  t.after(() => h.ep.close());
  const s = h.ep.stats();
  for (const k of ['transport', 'fallbacks', 'resumes', 'pendingBytes', 'dropped']) assert.ok(Object.hasOwn(s, k), `stats().${k}：${JSON.stringify(s)}`);
  assert.deepEqual({ transport: s.transport, fallbacks: s.fallbacks, resumes: s.resumes, pendingBytes: s.pendingBytes }, { transport: 'ws', fallbacks: 0, resumes: 0, pendingBytes: 0 });
  h.ep.send({ type: 'a', pad: 'q'.repeat(1000) });
  assert.ok(h.ep.stats().pendingBytes >= 1000);
  h.s1.push({ type: 'session.ack', ack: 1 });
  await sleep(10);
  assert.equal(h.ep.stats().pendingBytes, 0);
  assert.equal(typeof h.ep.onResume, 'function');
});

test('HT4-index server/render-node/index.mjs 导出 createDocEndpoint', T, async () => {
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
  await waitFor(() => ev.opens === 1, 3000, '建会话');
  return { env, proxy, ep, got, ev };
}

test('HT4-real-resume 真服务：传输被掐断后自动接续，断开期间两边发的都按序到、各一次；核心不见断开', SKIP_BOTH ? { skip: SKIP_BOTH } : {}, async (t) => {
  const { env, proxy, ep, got, ev } = await realPair(t);
  ep.send({ type: 'ht.echo', n: 1 });
  await waitFor(() => got.some((m) => m.n === 1), 2000, '第 1 条回包');
  proxy.cutAll();
  ep.send({ type: 'ht.echo', n: 2 });
  ep.send({ type: 'ht.echo', n: 3 });
  await waitFor(() => env.logs.some((l) => l.event === 'session.detach'), 2000, '服务端脱开');
  env.service.send(env.mod.connects[0].connId, { type: 'ht.pushed' });
  await waitFor(() => got.filter((m) => m.type === 'ht.echoed').length === 3 && got.some((m) => m.type === 'ht.pushed'), 5000, '接续后全部到齐');
  assert.equal(ev.resumes, 1);
  assert.equal(ev.opens, 1);
  assert.deepEqual(ev.closes, []);
  assert.deepEqual(env.mod.seen.map((s) => s.msg.n), [1, 2, 3], '服务端模块每条一次、按序');
  assert.deepEqual(got.filter((m) => m.type === 'ht.echoed').map((m) => m.n), [1, 2, 3]);
  for (const m of got) assert.ok(!('seq' in m) && !('ack' in m));
  assert.equal(env.mod.disconnects.length, 0);
  assert.equal(env.mod.connects.length, 1);
});

test('HT4-real-410 真服务：会话在服务端已过期（410）时客户端重建会话（onClose 一次、onOpen 第二次）', SKIP_BOTH ? { skip: SKIP_BOTH } : {}, async (t) => {
  const { env, proxy, ev } = await realPair(t, { retainMs: 300 });
  proxy.mode = 'reject';
  proxy.cutAll();
  await waitFor(() => env.mod.disconnects.length === 1, 3000, '服务端保留期满');
  proxy.mode = 'pass';
  await waitFor(() => ev.opens === 2, 5000, '重建会话');
  assert.equal(ev.closes.length, 1);
  assert.equal(env.mod.connects.length, 2);
  const h = await env.health();
  assert.ok(h.sessions.opened >= 2);
});

test('HT4-real-404 真服务：服务端换了一个（会话不存在，404）时客户端重建会话', SKIP_BOTH ? { skip: SKIP_BOTH } : {}, async (t) => {
  const { proxy, ev } = await realPair(t, { retainMs: 300 });
  const other = await startService({ retainMs: 60_000 });
  t.after(other.cleanup);
  proxy.retarget(other.port);
  proxy.cutAll();
  await waitFor(() => ev.opens === 2, 5000, '在新服务上重建会话');
  assert.equal(ev.closes.length, 1);
  assert.equal(other.mod.connects.length, 1);
});

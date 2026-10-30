/**
 * 账号云端项目里卡片源码同步的端点(`server/account-card-link.mjs`):只在建新会话时出示票据、按票据到期换会话。
 * 会话端点用替身(真的在 `account-card-sync.test.mjs` 里对着真服务跑)。报告 `docs/reports/AGENT-v18-cardsync.md`。
 *
 *   ACL-01 子协议:`promptcut.v1` + `promptcut.account.<票据>`;票据不合法就抛;不给接续用的子协议(接续不带票据)
 *   ACL-02 建成会话后按票据的 expiresAt 提前换:关旧的(上层收到 close)、凭新票据起新的(上层收到 open)
 *   ACL-03 票据只剩几秒:至少用满 minSessionMs;没有 expiresAt 按 fallbackLifeMs
 *   ACL-04 收到 credential-revoked / authorization-expired 的 error:消息照交上层,然后立刻换;别的 error 不换
 *   ACL-05 会话被服务端结束:定时撤掉,close 交上层;端点自己重建成后重新定时
 *   ACL-06 close 之后不再换、不再定时
 *   ACL-07 cardSyncConnect:账号项目用本端点,别的与缺省相同(原样的 protocols,日志加 doc. 前缀)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountCardEndpoint, accountCardProtocols, cardSyncConnect } from '../account-card-link.mjs';

const T = (n) => `${'t'.repeat(42)}${n}`;

function harness({ tickets, ...options } = {}) {
  let nowMs = 1_000_000;
  const timers = [];
  const endpoints = [];
  let asked = 0;
  const defaultTicket = (n) => ({ ticket: T(n % 10), expiresAt: nowMs + 120_000 });
  const getTicket = async () => {
    const next = (tickets ?? defaultTicket)(++asked, nowMs);
    if (next instanceof Error) throw next;
    return next;
  };
  const createEndpoint = (o) => {
    const h = { open: [], close: [], message: [], resume: [] };
    const ep = {
      o, closed: false, sent: [], protocolsSeen: null, session: false,
      onOpen: (f) => h.open.push(f), onClose: (f) => h.close.push(f), onMessage: (f) => h.message.push(f), onResume: (f) => h.resume.push(f),
      send(m) { this.sent.push(m); return true; },
      close() {
        if (this.closed) return;
        this.closed = true;
        if (this.session) { this.session = false; for (const f of h.close) f({ code: 1000, reason: 'closed' }); }
      },
      stats: () => ({ transport: 'ws', resumes: 0 }),
      /** 替身:走一遍「取子协议 → 建成会话」 */
      async open() { this.protocolsSeen = await o.protocols(); this.session = true; for (const f of h.open) f(); },
      serverClose(code = 4003) { this.session = false; for (const f of h.close) f({ code, reason: 'access-revoked' }); },
      push(m) { for (const f of h.message) f(m); },
    };
    endpoints.push(ep);
    return ep;
  };
  const events = [];
  const link = accountCardEndpoint({
    url: 'wss://doc.example/hosted/', getTicket, createEndpoint, now: () => nowMs,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false, fired: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    ...options,
  });
  link.onOpen(() => events.push('open'));
  link.onClose((info) => events.push(`close:${info?.code}`));
  link.onMessage((m) => events.push(`msg:${m.type}:${m.reason ?? ''}`));
  const fire = (t) => { assert.equal(t.cleared, false, '定时已撤'); t.fired = true; t.fn(); };
  const live = () => timers.filter((t) => !t.cleared && !t.fired);
  return { link, endpoints, timers, events, fire, live, advance: (ms) => { nowMs += ms; }, asked: () => asked };
}

test('ACL-01 子协议只在建新会话时出示票据;票据不合法就抛', async () => {
  const h = harness();
  await h.endpoints[0].open();
  assert.deepEqual(h.endpoints[0].protocolsSeen, ['promptcut.v1', `promptcut.account.${T(1)}`]);
  assert.equal(h.endpoints[0].o.resumeProtocols, undefined, '接续不带票据(带了文档服务握手回 400)');
  assert.equal(h.endpoints[0].o.url, 'wss://doc.example/hosted/');
  const bad = harness({ tickets: () => ({ ticket: 'short', expiresAt: 1 }) });
  await assert.rejects(bad.endpoints[0].open(), /票据不合法/);
  const p = accountCardProtocols(async () => ({ ticket: T(7), expiresAt: 5 }));
  assert.deepEqual(await p(), ['promptcut.v1', `promptcut.account.${T(7)}`]);
});

test('ACL-02 按票据的 expiresAt 提前换会话:上层收到 close 再 open,新会话用新票据', async () => {
  const h = harness();
  await h.endpoints[0].open();
  assert.deepEqual(h.events, ['open']);
  assert.equal(h.live().length, 1);
  assert.equal(h.live()[0].ms, 112_000, '120 秒的票据提前 8 秒换');
  h.advance(112_000);
  h.fire(h.live()[0]);
  assert.equal(h.endpoints.length, 2);
  assert.equal(h.endpoints[0].closed, true);
  assert.deepEqual(h.events, ['open', 'close:1000']);
  await h.endpoints[1].open();
  assert.deepEqual(h.endpoints[1].protocolsSeen, ['promptcut.v1', `promptcut.account.${T(2)}`]);
  assert.deepEqual(h.events, ['open', 'close:1000', 'open']);
  assert.equal(h.link.stats().accountRenews, 1);
  // 发送走当前的端点
  h.link.send({ type: 'content.list' });
  assert.equal(h.endpoints[0].sent.length, 0);
  assert.equal(h.endpoints[1].sent.length, 1);
});

test('ACL-03 票据只剩几秒也至少用满 minSessionMs;没有到期时刻按 fallbackLifeMs', async () => {
  const short = harness({ tickets: (n, now) => ({ ticket: T(n), expiresAt: now + 4_000 }) });
  await short.endpoints[0].open();
  assert.equal(short.live()[0].ms, 3_000);
  const plain = harness({ tickets: (n) => T(n) });
  await plain.endpoints[0].open();
  assert.equal(plain.live()[0].ms, 60_000);
});

test('ACL-04 闸回 credential-revoked / authorization-expired:消息照交上层,然后立刻换;别的 error 不换', async () => {
  for (const reason of ['credential-revoked', 'authorization-expired']) {
    const h = harness();
    await h.endpoints[0].open();
    h.endpoints[0].push({ type: 'error', reason, reqId: 'cards#1' });
    assert.deepEqual(h.events, ['open', `msg:error:${reason}`, 'close:1000'], reason);
    assert.equal(h.endpoints.length, 2);
    assert.equal(h.live().length, 0, '旧会话的定时撤了');
    // 同一条旧连接上迟到的第二个 error 不再触发
    h.endpoints[0].push({ type: 'error', reason });
    assert.equal(h.endpoints.length, 2);
  }
  const h = harness();
  await h.endpoints[0].open();
  h.endpoints[0].push({ type: 'error', reason: 'not-listed' });
  h.endpoints[0].push({ type: 'content.changed', kind: 'card-source' });
  assert.equal(h.endpoints.length, 1, '只读被拒不是连接到期');
  assert.deepEqual(h.events, ['open', 'msg:error:not-listed', 'msg:content.changed:']);
});

test('ACL-05 会话被服务端结束:撤定时、close 交上层;端点重建成后重新取票据、重新定时', async () => {
  const h = harness();
  await h.endpoints[0].open();
  h.endpoints[0].serverClose(4003);
  assert.deepEqual(h.events, ['open', 'close:4003']);
  assert.equal(h.live().length, 0);
  assert.equal(h.endpoints.length, 1, '重建由会话端点自己退避着做');
  h.advance(5_000);
  await h.endpoints[0].open();
  assert.equal(h.asked(), 2);
  assert.equal(h.live().length, 1);
  assert.equal(h.live()[0].ms, 112_000);
});

test('ACL-06 close 之后不再换、不再定时、不再发', async () => {
  const h = harness();
  await h.endpoints[0].open();
  const timer = h.live()[0];
  h.link.close();
  assert.equal(timer.cleared, true);
  assert.equal(h.endpoints[0].closed, true);
  h.endpoints[0].push({ type: 'error', reason: 'credential-revoked' });
  assert.equal(h.endpoints.length, 1);
  assert.equal(h.link.send({ type: 'x' }), false);
});

test('ACL-07 cardSyncConnect:账号项目用本端点,别的原样交给缺省的会话端点', async () => {
  const logged = [];
  /** 连不上的 WebSocket 替身(测试里没有网络) */
  class DeadSocket {
    constructor() { queueMicrotask(() => this.onerror?.({ message: 'no network in test' })); }
    addEventListener(type, fn) { this[`on${type}`] = fn; }
    close() {}
  }
  const connect = cardSyncConnect((event, fields) => logged.push([event, fields]), { WebSocket: DeadSocket });
  let asked = 0;
  const account = connect({ url: 'wss://doc.example/hosted/', protocols: accountCardProtocols(async () => { asked++; return { ticket: T(1), expiresAt: Date.now() + 60_000 }; }) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked, 1, '账号项目:端点自己取票据');
  assert.equal(typeof account.stats()?.accountRenews, 'number');
  account.close();
  let plain = 0;
  const legacy = connect({ url: 'ws://127.0.0.1:1/docservice', protocols: () => { plain++; return ['promptcut.v1']; } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(plain, 1);
  assert.equal(legacy.stats().accountRenews, undefined, '别的空间是缺省的会话端点');
  legacy.close();
  assert.ok(logged.length > 0 && logged.every(([event]) => event.startsWith('doc.')));
});

test('ACL-08 账号项目的绑定地址只能是账号云端的文档服务;探针与联调要显式放行别的源', async () => {
  const { accountDocUrlAllowed } = await import('../account-card-link.mjs');
  const opened = { PROMPTCUT_ACCOUNT_CLOUD_ORIGIN: 'https://accounts.example' };
  assert.equal(accountDocUrlAllowed('wss://accounts.example/hosted/', opened), true);
  for (const bad of ['wss://attacker.invalid/hosted/', 'ws://accounts.example/hosted/', 'wss://accounts.example.attacker.invalid/hosted/', 'wss://accounts.example:8443/hosted/',
    'wss://user@accounts.example/hosted/', 'wss://accounts.example/hosted/?x=1', 'wss://accounts.example/other/', 'wss://accounts.example/hosted', 'https://accounts.example/hosted/', '', null, 'not a url']) {
    assert.equal(accountDocUrlAllowed(bad, opened), false, String(bad));
  }
  const env = { PROMPTCUT_ACCOUNT_CLOUD_ORIGIN: 'https://127.0.0.1:28656, http://insecure.example' };
  assert.equal(accountDocUrlAllowed('wss://127.0.0.1:28656/hosted/', env), true);
  assert.equal(accountDocUrlAllowed('wss://127.0.0.1:28657/hosted/', env), false);
  assert.equal(accountDocUrlAllowed('wss://insecure.example/hosted/', env), false, '放行名单里的 http 源不算');
});

test('ACL-09 经舞台端口来的请求认得出(舞台窗口里的卡片代码不许碰取票据、改绑定的接口)', async () => {
  const { viaStagePort, STAGE_CLIENT_HEADER, originOk } = await import('../http-guard.mjs');
  // 舞台窗口发的同源请求:Origin 与 Host 都是舞台端口,originOk 拦不住;代理写上的头认得出
  const stage = { headers: { origin: 'http://127.0.0.1:5191', host: '127.0.0.1:5191', [STAGE_CLIENT_HEADER]: '127.0.0.1' } };
  assert.equal(originOk(stage), true);
  assert.equal(viaStagePort(stage), true);
  assert.equal(viaStagePort({ headers: { origin: 'http://127.0.0.1:5190', host: '127.0.0.1:5190' } }), false);
  assert.equal(viaStagePort({ headers: { [STAGE_CLIENT_HEADER]: '' } }), true, '代理写的是空串也算');
});

/**
 * 服务地址登记模块（契约 `docs/plan/render-queue-contract.md` G.6，用例 E1～E8）。
 * 跑：node --test server/test/docservice-endpoints.test.mjs
 *
 * 只照契约写，不看实现。时钟用 `now` 注入加 `autoTick: false`、手动 `service.tick()`（G.4）。
 *
 * 工厂照契约 G.12：`endpointsModule(options?)`，选项平铺（`graceMs`、`maxAnnouncers`、`maxUrls`、
 * `maxMetaBytes`、`tickMs`），缺省取 `ENDPOINT_DEFAULTS`。没带 `meta` 的登记，`meta` 为 `null`；
 * 宽限期内从新连接再登记，`urls` 与 `meta` 都没变才不推送（G.12 第 6 条）。
 * 回包是否带 `reqId` 契约没写，测试不依赖它，按消息类型等。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocService } from '../docservice/service.mjs';
import { wsClient, byType, waitFor } from './fake-ws-kit.mjs';

const T0 = 1_000_000;

async function loadEndpoints(options) {
  const mod = await import('../docservice/modules/endpoints.mjs');
  const isModule = (v) => v && typeof v === 'object' && Array.isArray(v.types) && typeof v.handle === 'function';
  assert.equal(typeof mod.endpointsModule, 'function', `modules/endpoints.mjs 要导出 endpointsModule；导出：${Object.keys(mod).join(', ')}`);
  const make = (o) => (o === undefined ? mod.endpointsModule() : mod.endpointsModule(o));
  const defaults = mod.ENDPOINT_DEFAULTS;
  assert.ok(defaults, 'modules/endpoints.mjs 要导出 ENDPOINT_DEFAULTS');
  assert.deepEqual(
    { GRACE_MS: defaults.GRACE_MS, MAX_ANNOUNCERS: defaults.MAX_ANNOUNCERS, MAX_URLS: defaults.MAX_URLS, MAX_META_BYTES: defaults.MAX_META_BYTES, TICK_MS: defaults.TICK_MS },
    { GRACE_MS: 10_000, MAX_ANNOUNCERS: 64, MAX_URLS: 8, MAX_META_BYTES: 4096, TICK_MS: 1000 },
  );
  const module = make(options);
  assert.ok(isModule(module), '工厂要返回模块对象');
  assert.equal(module.tickMs, options?.tickMs ?? defaults.TICK_MS, 'tickMs 取选项或 TICK_MS');
  assert.deepEqual(module.types, ['service.']);
  return { module, defaults };
}

async function startService(options) {
  const { module, defaults } = await loadEndpoints(options);
  const clock = { t: T0 };
  const service = createDocService({ log: () => {}, now: () => clock.t, autoTick: false, modules: [module] });
  const { port } = await service.listen(0, '127.0.0.1');
  const url = `ws://127.0.0.1:${port}`;
  const clients = [];
  const connect = async () => {
    const c = wsClient(url);
    clients.push(c);
    await c.opened;
    return c;
  };
  const health = async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  const cleanup = async () => { for (const c of clients) c.close(); await service.close(); };
  return { service, clock, url, connect, health, cleanup, defaults, module };
}

/** 订阅并取回包（全量） */
async function watch(c, kinds) {
  c.send({ type: 'service.watch', kinds });
  const m = await c.next(byType('service.endpoints'));
  return m.endpoints;
}

/** 登记，等 service.announced 或 error */
async function announce(c, fields) {
  c.send({ type: 'service.announce', ...fields });
  return c.next((m) => m.type === 'service.announced' || m.type === 'error');
}

async function withdraw(c, fields) {
  c.send({ type: 'service.withdraw', ...fields });
  return c.next((m) => m.type === 'service.withdrawn' || m.type === 'error');
}

const pushes = (c) => c.quiet(byType('service.endpoints'), 150);

/** 断开一条连接，等服务端记下 */
async function drop(env, c) {
  const before = env.service.describe().connections;
  c.close();
  await c.closed;
  await waitFor(() => env.service.describe().connections === before - 1, 2000, '服务端记下断开');
}

const pick = (list) => list.map(({ announcerId, kind, urls }) => ({ announcerId, kind, urls })).sort((a, b) => (a.announcerId + a.kind).localeCompare(b.announcerId + b.kind));

// ------------------------------------------------------------------ E1

test('E1 登记后，订阅了该 kind 的连接收到一条全量 service.endpoints，没订阅的收不到', async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const a = await env.connect();
  const w = await env.connect();
  const other = await env.connect();
  assert.deepEqual(await watch(w, ['asset']), []);
  assert.deepEqual(await watch(other, ['render']), []);

  env.clock.t = T0 + 42;
  const ack = await announce(a, { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'], meta: { v: 1 } });
  assert.deepEqual({ type: ack.type, announcerId: ack.announcerId, kind: ack.kind, urls: ack.urls },
    { type: 'service.announced', announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] });

  const push = await w.next(byType('service.endpoints'));
  assert.equal(push.endpoints.length, 1);
  assert.deepEqual(push.endpoints[0], { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'], meta: { v: 1 }, since: T0 + 42 });
  assert.deepEqual(await pushes(w), [], '只推一条');
  assert.deepEqual(await pushes(other), [], '没订阅 asset 的收不到');
  assert.deepEqual(a.inbox.filter(byType('service.endpoints')), [], '登记方没订阅也收不到');
  assert.equal((await env.health()).endpoints, 1);
});

// ------------------------------------------------------------------ E2

test('E2 service.watch 的回包是当前可见的全量；kinds 过滤正确，all 看到全部', async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const a = await env.connect();
  assert.equal((await announce(a, { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] })).type, 'service.announced');
  assert.equal((await announce(a, { announcerId: 'pc-1', kind: 'render', urls: ['https://pc-1.lan/'] })).type, 'service.announced');
  assert.equal((await announce(a, { announcerId: 'host-1', kind: 'asset', urls: ['http://host-1.lan:9000/'] })).type, 'service.announced');

  const w1 = await env.connect();
  assert.deepEqual(pick(await watch(w1, ['asset'])), [
    { announcerId: 'host-1', kind: 'asset', urls: ['http://host-1.lan:9000/'] },
    { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] },
  ]);
  const w2 = await env.connect();
  assert.equal((await watch(w2, 'all')).length, 3);
  const w3 = await env.connect();
  assert.equal((await watch(w3, ['asset', 'render'])).length, 3);
  const w4 = await env.connect();
  assert.deepEqual(await watch(w4, ['nothing-here']), []);
  const w5 = await env.connect();
  const renderOnly = await watch(w5, ['render']);
  assert.deepEqual(pick(renderOnly), [{ announcerId: 'pc-1', kind: 'render', urls: ['https://pc-1.lan/'] }]);
  assert.equal(renderOnly[0].meta, null, '没带 meta 的登记，meta 为 null（G.12）');
  assert.equal(renderOnly[0].since, T0);

  // 此后的推送也按各自的 kinds 过滤、并且是全量
  await announce(a, { announcerId: 'host-1', kind: 'render', urls: ['http://host-1.lan:9001/'] });
  const p5 = await w5.next(byType('service.endpoints'));
  assert.deepEqual(pick(p5.endpoints).map((e) => e.announcerId), ['host-1', 'pc-1']);
  const p2 = await w2.next(byType('service.endpoints'));
  assert.equal(p2.endpoints.length, 4);
  assert.deepEqual(await pushes(w1), [], '只订阅 asset 的不因 render 变化收到推送');
  assert.deepEqual(await pushes(w4), []);
});

// ------------------------------------------------------------------ E3

test('E3 同一 (announcerId, kind) 再登记：替换，不新增', async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const a = await env.connect();
  const w = await env.connect();
  await watch(w, 'all');
  await announce(a, { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] });
  await w.next(byType('service.endpoints'));
  const ack = await announce(a, { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.3:8790/', 'http://pc-1.lan:8790/'], meta: { n: 2 } });
  assert.equal(ack.type, 'service.announced');
  assert.deepEqual(ack.urls, ['http://10.0.0.3:8790/', 'http://pc-1.lan:8790/']);
  const push = await w.next(byType('service.endpoints'));
  assert.equal(push.endpoints.length, 1);
  assert.deepEqual(push.endpoints[0].urls, ['http://10.0.0.3:8790/', 'http://pc-1.lan:8790/']);
  assert.deepEqual(push.endpoints[0].meta, { n: 2 });
  assert.equal((await env.health()).endpoints, 1);

  // 同一 announcerId、不同 kind 是另一条
  await announce(a, { announcerId: 'pc-1', kind: 'render', urls: ['http://10.0.0.3:8791/'] });
  assert.equal((await w.next(byType('service.endpoints'))).endpoints.length, 2);
  assert.equal((await env.health()).endpoints, 2);
});

// ------------------------------------------------------------------ E4

test('E4 service.withdraw：登记所在的连接能撤回，别的连接撤回回 removed: false', async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const a = await env.connect();
  const b = await env.connect();
  const w = await env.connect();
  await watch(w, ['asset']);
  await announce(a, { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] });
  await w.next(byType('service.endpoints'));

  const r1 = await withdraw(b, { announcerId: 'pc-1', kind: 'asset' });
  assert.deepEqual({ type: r1.type, announcerId: r1.announcerId, kind: r1.kind, removed: r1.removed },
    { type: 'service.withdrawn', announcerId: 'pc-1', kind: 'asset', removed: false });
  assert.deepEqual(await pushes(w), [], '没删就不推送');
  assert.equal((await env.health()).endpoints, 1);

  const r2 = await withdraw(a, { announcerId: 'pc-1', kind: 'asset' });
  assert.deepEqual([r2.type, r2.removed], ['service.withdrawn', true]);
  const push = await w.next(byType('service.endpoints'));
  assert.deepEqual(push.endpoints, []);
  assert.equal((await env.health()).endpoints, 0);

  const r3 = await withdraw(a, { announcerId: 'pc-1', kind: 'asset' });
  assert.deepEqual([r3.type, r3.removed], ['service.withdrawn', false], '已经没有了');
});

// ------------------------------------------------------------------ E5

test('E5 登记所在的连接断开：宽限期内仍可见；正好等于 GRACE_MS 时不删；之后的 tick 删除并推送', async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const GRACE = env.defaults.GRACE_MS;
  const a = await env.connect();
  const w = await env.connect();
  await watch(w, ['asset']);
  await announce(a, { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] });
  await w.next(byType('service.endpoints'));

  const tDown = T0 + 500;
  env.clock.t = tDown;
  await drop(env, a);
  assert.deepEqual(await pushes(w), [], '断开本身不推送');

  env.clock.t = tDown + GRACE / 2;
  env.service.tick();
  const x = await env.connect();
  assert.equal((await watch(x, 'all')).length, 1, '宽限期内仍可见');

  env.clock.t = tDown + GRACE;
  env.service.tick();
  assert.deepEqual(await pushes(w), [], '正好等于 GRACE_MS 不删');
  assert.equal((await env.health()).endpoints, 1);

  env.clock.t = tDown + GRACE + 1;
  env.service.tick();
  const push = await w.next(byType('service.endpoints'));
  assert.deepEqual(push.endpoints, []);
  assert.equal((await env.health()).endpoints, 0);
  const y = await env.connect();
  assert.deepEqual(await watch(y, 'all'), []);
});

// ------------------------------------------------------------------ E6

test('E6 宽限期内从新连接以相同 urls 再登记：不推送撤回，也不推送；过了宽限也不删', async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const GRACE = env.defaults.GRACE_MS;
  const w = await env.connect();
  await watch(w, 'all');
  const a = await env.connect();
  await announce(a, { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] });
  await w.next(byType('service.endpoints'));

  const tDown = T0 + 1000;
  env.clock.t = tDown;
  await drop(env, a);
  env.clock.t = tDown + GRACE / 2;
  const a2 = await env.connect();
  const ack = await announce(a2, { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] });
  assert.equal(ack.type, 'service.announced');
  assert.deepEqual(await pushes(w), [], 'urls 没变：不推送');

  env.clock.t = tDown + GRACE * 3;
  env.service.tick();
  assert.deepEqual(await pushes(w), [], '已改绑到新连接，过了原宽限也不删');
  assert.equal((await env.health()).endpoints, 1);

  // 改绑后只有新连接能撤回
  const r = await withdraw(a2, { announcerId: 'pc-1', kind: 'asset' });
  assert.equal(r.removed, true);
});

test('E6 宽限期内从新连接以不同 urls 再登记：推送一次（新地址），不推送撤回', async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const GRACE = env.defaults.GRACE_MS;
  const w = await env.connect();
  await watch(w, ['asset']);
  const b = await env.connect();
  await announce(b, { announcerId: 'host-1', kind: 'asset', urls: ['http://10.0.0.9:8790/'] });
  await w.next(byType('service.endpoints'));

  const tDown = T0 + 2000;
  env.clock.t = tDown;
  await drop(env, b);
  env.clock.t = tDown + 100;
  const b2 = await env.connect();
  await announce(b2, { announcerId: 'host-1', kind: 'asset', urls: ['http://10.0.0.10:8790/'] });
  const push = await w.next(byType('service.endpoints'));
  assert.deepEqual(pick(push.endpoints), [{ announcerId: 'host-1', kind: 'asset', urls: ['http://10.0.0.10:8790/'] }]);
  assert.deepEqual(await pushes(w), [], '只推一次');

  env.clock.t = tDown + GRACE + 1;
  env.service.tick();
  assert.deepEqual(await pushes(w), [], '改绑后不再按旧连接的宽限删除');
});

test('E6 宽限期内从新连接以相同 urls、不同 meta 再登记：推送一次（G.12：urls 与 meta 都没变才不推送）', async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const w = await env.connect();
  await watch(w, 'all');
  const a = await env.connect();
  await announce(a, { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'], meta: { gen: 1 } });
  await w.next(byType('service.endpoints'));
  env.clock.t = T0 + 100;
  await drop(env, a);
  env.clock.t = T0 + 200;
  const a2 = await env.connect();
  await announce(a2, { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'], meta: { gen: 2 } });
  const push = await w.next(byType('service.endpoints'));
  assert.deepEqual(push.endpoints.map((e) => e.meta), [{ gen: 2 }]);
  assert.deepEqual(await pushes(w), [], '只推一次');
});

test('E5 选项平铺：endpointsModule({ graceMs }) 改宽限（G.12）', async (t) => {
  const env = await startService({ graceMs: 100 });
  t.after(env.cleanup);
  const a = await env.connect();
  const w = await env.connect();
  await watch(w, 'all');
  await announce(a, { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] });
  await w.next(byType('service.endpoints'));
  env.clock.t = T0 + 1000;
  await drop(env, a);
  env.clock.t = T0 + 1100;
  env.service.tick();
  assert.deepEqual(await pushes(w), [], '正好等于 graceMs 不删');
  env.clock.t = T0 + 1101;
  env.service.tick();
  assert.deepEqual((await w.next(byType('service.endpoints'))).endpoints, []);
});

// ------------------------------------------------------------------ E7

test('E7 校验：ftp:、带用户名密码、超过 8 个地址、kind 不合法、meta 过大等 → bad-message，状态不变', async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const a = await env.connect();
  const w = await env.connect();
  await watch(w, 'all');
  const good = { announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] };
  assert.equal((await announce(a, good)).type, 'service.announced');
  await w.next(byType('service.endpoints'));

  const urlN = (n) => Array.from({ length: n }, (_, i) => `http://10.0.0.${i + 1}:8790/`);
  const bad = [
    ['ftp: 地址', { ...good, urls: ['ftp://10.0.0.2/'] }],
    ['ws: 地址', { ...good, urls: ['ws://10.0.0.2/'] }],
    ['带用户名密码', { ...good, urls: ['http://user:pass@10.0.0.2:8790/'] }],
    ['只带用户名', { ...good, urls: ['http://user@10.0.0.2:8790/'] }],
    ['超过 8 个地址', { ...good, urls: urlN(9) }],
    ['0 个地址', { ...good, urls: [] }],
    ['urls 不是数组', { ...good, urls: 'http://10.0.0.2/' }],
    ['解析不了的地址', { ...good, urls: ['not a url'] }],
    ['地址过长', { ...good, urls: [`http://10.0.0.2/${'a'.repeat(2100)}`] }],
    ['kind 大写', { ...good, kind: 'Asset' }],
    ['kind 数字开头', { ...good, kind: '1asset' }],
    ['kind 过长', { ...good, kind: `a${'b'.repeat(32)}` }],
    ['kind 空', { ...good, kind: '' }],
    ['announcerId 带空格', { ...good, announcerId: 'pc 1' }],
    ['announcerId 过长', { ...good, announcerId: 'a'.repeat(129) }],
    ['announcerId 缺', { kind: good.kind, urls: good.urls }],
    ['meta 过大', { ...good, meta: { blob: 'x'.repeat(5000) } }],
    ['同键替换成非法地址', { ...good, urls: ['ftp://10.0.0.2/'] }],
  ];
  for (const [what, fields] of bad) {
    const r = await announce(a, fields);
    assert.deepEqual([r.type, r.reason], ['error', 'bad-message'], what);
  }
  const bw = await withdraw(a, { announcerId: 'pc 1', kind: 'asset' });
  assert.deepEqual([bw.type, bw.reason], ['error', 'bad-message'], 'withdraw 的字段同样校验');
  const x = await env.connect();
  x.send({ type: 'service.watch', kinds: 42 });
  const bx = await x.next((m) => m.type === 'error' || m.type === 'service.endpoints');
  assert.deepEqual([bx.type, bx.reason], ['error', 'bad-message'], 'watch 的 kinds 不是数组也不是 all');

  assert.deepEqual(await pushes(w), [], '非法登记不推送');
  const y = await env.connect();
  assert.deepEqual(pick(await watch(y, 'all')), [{ announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] }], '状态不变');

  // 边界上的合法值
  const edge = [
    { announcerId: 'a'.repeat(128), kind: `a${'b'.repeat(31)}`, urls: urlN(8) },
    { announcerId: 'x.y_z:w-1', kind: 'k-9', urls: ['https://example.lan/'], meta: { blob: 'x'.repeat(3000) } },
  ];
  for (const fields of edge) assert.equal((await announce(a, fields)).type, 'service.announced', JSON.stringify(fields).slice(0, 80));
});

// ------------------------------------------------------------------ E8

test('E8 第 65 个登记回 limit；到上限后替换已有的照常', async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const MAX = env.defaults.MAX_ANNOUNCERS;
  const a = await env.connect();
  for (let i = 0; i < MAX; i++) {
    const r = await announce(a, { announcerId: `n-${i}`, kind: 'asset', urls: [`http://10.0.1.${i % 250}:8790/`] });
    assert.equal(r.type, 'service.announced', `第 ${i + 1} 个`);
  }
  const over = await announce(a, { announcerId: `n-${MAX}`, kind: 'asset', urls: ['http://10.0.2.1:8790/'] });
  assert.deepEqual([over.type, over.reason], ['error', 'limit']);
  assert.equal((await env.health()).endpoints, MAX);
  const w = await env.connect();
  assert.equal((await watch(w, 'all')).length, MAX);

  const replace = await announce(a, { announcerId: 'n-0', kind: 'asset', urls: ['http://10.0.3.1:8790/'] });
  assert.equal(replace.type, 'service.announced', '替换不增加总数');
  assert.equal((await env.health()).endpoints, MAX);
});

test('E8 选项平铺：maxAnnouncers、maxUrls、maxMetaBytes 可改（G.12）', async (t) => {
  const env = await startService({ maxAnnouncers: 3, maxUrls: 2, maxMetaBytes: 64 });
  t.after(env.cleanup);
  const a = await env.connect();
  for (let i = 0; i < 3; i++) assert.equal((await announce(a, { announcerId: `n-${i}`, kind: 'asset', urls: ['http://10.0.0.1/'] })).type, 'service.announced');
  const over = await announce(a, { announcerId: 'n-3', kind: 'asset', urls: ['http://10.0.0.1/'] });
  assert.deepEqual([over.type, over.reason], ['error', 'limit']);
  const tooMany = await announce(a, { announcerId: 'n-0', kind: 'asset', urls: ['http://10.0.0.1/', 'http://10.0.0.2/', 'http://10.0.0.3/'] });
  assert.deepEqual([tooMany.type, tooMany.reason], ['error', 'bad-message']);
  const bigMeta = await announce(a, { announcerId: 'n-0', kind: 'asset', urls: ['http://10.0.0.1/'], meta: { blob: 'x'.repeat(80) } });
  assert.deepEqual([bigMeta.type, bigMeta.reason], ['error', 'bad-message']);
});

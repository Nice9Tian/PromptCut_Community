/**
 * Service address registration module (contract `docs/plan/render-queue-contract.md` G.6,
 * test cases E1-E8).
 * Run: node --test server/test/docservice-endpoints.test.mjs
 *
 * Written strictly against the contract, ignoring implementation. Clock uses `now` injection plus
 * `autoTick: false`, manual `service.tick()` (G.4).
 *
 * Factory follows contract G.12: `endpointsModule(options?)`, flattened options (`graceMs`,
 * `maxAnnouncers`, `maxUrls`, `maxMetaBytes`, `tickMs`), defaulting to `ENDPOINT_DEFAULTS`.
 * Registrations without `meta` have `meta` as `null`; re-registering from a new connection within
 * grace period does not push only if both `urls` and `meta` are unchanged (G.12 item 6).
 * Whether responses include `reqId` is not specified in the contract; tests do not depend on it,
 * waiting by message type.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocService } from '../docservice/service.mjs';
import { wsClient, byType, waitFor } from './fake-ws-kit.mjs';

const T0 = 1_000_000;

async function loadEndpoints(options) {
  const mod = await import('../docservice/modules/endpoints.mjs');
  const isModule = (v) => v && typeof v === 'object' && Array.isArray(v.types) && typeof v.handle === 'function';
  assert.equal(typeof mod.endpointsModule, 'function', `modules/endpoints.mjs must export endpointsModule; exports: ${Object.keys(mod).join(', ')}`);
  const make = (o) => (o === undefined ? mod.endpointsModule() : mod.endpointsModule(o));
  const defaults = mod.ENDPOINT_DEFAULTS;
  assert.ok(defaults, 'modules/endpoints.mjs must export ENDPOINT_DEFAULTS');
  assert.deepEqual(
    { GRACE_MS: defaults.GRACE_MS, MAX_ANNOUNCERS: defaults.MAX_ANNOUNCERS, MAX_URLS: defaults.MAX_URLS, MAX_META_BYTES: defaults.MAX_META_BYTES, TICK_MS: defaults.TICK_MS },
    { GRACE_MS: 10_000, MAX_ANNOUNCERS: 64, MAX_URLS: 8, MAX_META_BYTES: 4096, TICK_MS: 1000 },
  );
  const module = make(options);
  assert.ok(isModule(module), 'the factory must return a module object');
  assert.equal(module.tickMs, options?.tickMs ?? defaults.TICK_MS, 'tickMs takes the option or TICK_MS');
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

/** Subscribe and get response (full) */
async function watch(c, kinds) {
  c.send({ type: 'service.watch', kinds });
  const m = await c.next(byType('service.endpoints'));
  return m.endpoints;
}

/** Register, wait for service.announced or error */
async function announce(c, fields) {
  c.send({ type: 'service.announce', ...fields });
  return c.next((m) => m.type === 'service.announced' || m.type === 'error');
}

async function withdraw(c, fields) {
  c.send({ type: 'service.withdraw', ...fields });
  return c.next((m) => m.type === 'service.withdrawn' || m.type === 'error');
}

const pushes = (c) => c.quiet(byType('service.endpoints'), 150);

/** Disconnect a connection, wait for server to record */
async function drop(env, c) {
  const before = env.service.describe().connections;
  c.close();
  await c.closed;
  await waitFor(() => env.service.describe().connections === before - 1, 2000, 'the server records the disconnect');
}

const pick = (list) => list.map(({ announcerId, kind, urls }) => ({ announcerId, kind, urls })).sort((a, b) => (a.announcerId + a.kind).localeCompare(b.announcerId + b.kind));

// ------------------------------------------------------------------ E1

test('E1 after registration, connections subscribed to that kind receive one full service.endpoints message, and unsubscribed ones receive nothing', async (t) => {
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
  assert.deepEqual(await pushes(w), [], 'only one message is pushed');
  assert.deepEqual(await pushes(other), [], 'a connection not subscribed to asset receives nothing');
  assert.deepEqual(a.inbox.filter(byType('service.endpoints')), [], 'the registrant receives nothing either when not subscribed');
  assert.equal((await env.health()).endpoints, 1);
});

// ------------------------------------------------------------------ E2

test('E2 the service.watch reply is the full list currently visible; kinds filtering is correct, all sees everything', async (t) => {
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
  assert.equal(renderOnly[0].meta, null, 'a registration without meta has meta null (G.12)');
  assert.equal(renderOnly[0].since, T0);

  // Subsequent pushes are also filtered by their respective kinds, and are full
  await announce(a, { announcerId: 'host-1', kind: 'render', urls: ['http://host-1.lan:9001/'] });
  const p5 = await w5.next(byType('service.endpoints'));
  assert.deepEqual(pick(p5.endpoints).map((e) => e.announcerId), ['host-1', 'pc-1']);
  const p2 = await w2.next(byType('service.endpoints'));
  assert.equal(p2.endpoints.length, 4);
  assert.deepEqual(await pushes(w1), [], 'a connection subscribed only to asset gets no push for render changes');
  assert.deepEqual(await pushes(w4), []);
});

// ------------------------------------------------------------------ E3

test('E3 registering the same (announcerId, kind) again: replaces, does not add', async (t) => {
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

  // Same announcerId with different kind is a separate entry
  await announce(a, { announcerId: 'pc-1', kind: 'render', urls: ['http://10.0.0.3:8791/'] });
  assert.equal((await w.next(byType('service.endpoints'))).endpoints.length, 2);
  assert.equal((await env.health()).endpoints, 2);
});

// ------------------------------------------------------------------ E4

test('E4 service.withdraw: the connection holding the registration can withdraw it, while withdrawing from another connection replies removed: false', async (t) => {
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
  assert.deepEqual(await pushes(w), [], 'no push when nothing was removed');
  assert.equal((await env.health()).endpoints, 1);

  const r2 = await withdraw(a, { announcerId: 'pc-1', kind: 'asset' });
  assert.deepEqual([r2.type, r2.removed], ['service.withdrawn', true]);
  const push = await w.next(byType('service.endpoints'));
  assert.deepEqual(push.endpoints, []);
  assert.equal((await env.health()).endpoints, 0);

  const r3 = await withdraw(a, { announcerId: 'pc-1', kind: 'asset' });
  assert.deepEqual([r3.type, r3.removed], ['service.withdrawn', false], 'already gone');
});

// ------------------------------------------------------------------ E5

test('E5 the connection holding a registration disconnects: still visible within the grace period; not removed at exactly GRACE_MS; removed and pushed on the tick after that', async (t) => {
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
  assert.deepEqual(await pushes(w), [], 'the disconnect itself pushes nothing');

  env.clock.t = tDown + GRACE / 2;
  env.service.tick();
  const x = await env.connect();
  assert.equal((await watch(x, 'all')).length, 1, 'still visible within the grace period');

  env.clock.t = tDown + GRACE;
  env.service.tick();
  assert.deepEqual(await pushes(w), [], 'not removed at exactly GRACE_MS');
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

test('E6 re-registering with the same urls from a new connection within the grace period: no withdrawal is pushed and nothing else is pushed either; it is not removed after the grace period either', async (t) => {
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
  assert.deepEqual(await pushes(w), [], 'urls unchanged: no push');

  env.clock.t = tDown + GRACE * 3;
  env.service.tick();
  assert.deepEqual(await pushes(w), [], 'rebound to the new connection, so it is not removed even after the original grace period');
  assert.equal((await env.health()).endpoints, 1);

  // After rebinding, only the new connection can revoke
  const r = await withdraw(a2, { announcerId: 'pc-1', kind: 'asset' });
  assert.equal(r.removed, true);
});

test('E6 re-registering with different urls from a new connection within the grace period: one push (the new addresses), no withdrawal push', async (t) => {
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
  assert.deepEqual(await pushes(w), [], 'pushed only once');

  env.clock.t = tDown + GRACE + 1;
  env.service.tick();
  assert.deepEqual(await pushes(w), [], 'after rebinding, it is no longer removed by the grace period of the old connection');
});

test('E6 re-registering with the same urls but different meta from a new connection within the grace period: one push (G.12: no push only when both urls and meta are unchanged)', async (t) => {
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
  assert.deepEqual(await pushes(w), [], 'pushed only once');
});

test('E5 flat options: endpointsModule({ graceMs }) changes the grace period (G.12)', async (t) => {
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
  assert.deepEqual(await pushes(w), [], 'not removed at exactly graceMs');
  env.clock.t = T0 + 1101;
  env.service.tick();
  assert.deepEqual((await w.next(byType('service.endpoints'))).endpoints, []);
});

// ------------------------------------------------------------------ E7

test('E7 validation: ftp:, with username and password, more than 8 addresses, invalid kind, oversized meta, etc. → bad-message, state unchanged', async (t) => {
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
    ['ftp: address', { ...good, urls: ['ftp://10.0.0.2/'] }],
    ['ws: address', { ...good, urls: ['ws://10.0.0.2/'] }],
    ['with username and password', { ...good, urls: ['http://user:pass@10.0.0.2:8790/'] }],
    ['with username only', { ...good, urls: ['http://user@10.0.0.2:8790/'] }],
    ['more than 8 addresses', { ...good, urls: urlN(9) }],
    ['0 addresses', { ...good, urls: [] }],
    ['urls is not an array', { ...good, urls: 'http://10.0.0.2/' }],
    ['unparseable address', { ...good, urls: ['not a url'] }],
    ['address too long', { ...good, urls: [`http://10.0.0.2/${'a'.repeat(2100)}`] }],
    ['uppercase kind', { ...good, kind: 'Asset' }],
    ['kind starting with a digit', { ...good, kind: '1asset' }],
    ['kind too long', { ...good, kind: `a${'b'.repeat(32)}` }],
    ['empty kind', { ...good, kind: '' }],
    ['announcerId with a space', { ...good, announcerId: 'pc 1' }],
    ['announcerId too long', { ...good, announcerId: 'a'.repeat(129) }],
    ['announcerId missing', { kind: good.kind, urls: good.urls }],
    ['meta too large', { ...good, meta: { blob: 'x'.repeat(5000) } }],
    ['replacing the same key with an invalid address', { ...good, urls: ['ftp://10.0.0.2/'] }],
  ];
  for (const [what, fields] of bad) {
    const r = await announce(a, fields);
    assert.deepEqual([r.type, r.reason], ['error', 'bad-message'], what);
  }
  const bw = await withdraw(a, { announcerId: 'pc 1', kind: 'asset' });
  assert.deepEqual([bw.type, bw.reason], ['error', 'bad-message'], 'the fields of withdraw are validated the same way');
  const x = await env.connect();
  x.send({ type: 'service.watch', kinds: 42 });
  const bx = await x.next((m) => m.type === 'error' || m.type === 'service.endpoints');
  assert.deepEqual([bx.type, bx.reason], ['error', 'bad-message'], 'watch kinds is neither an array nor all');

  assert.deepEqual(await pushes(w), [], 'an invalid registration pushes nothing');
  const y = await env.connect();
  assert.deepEqual(pick(await watch(y, 'all')), [{ announcerId: 'pc-1', kind: 'asset', urls: ['http://10.0.0.2:8790/'] }], 'state unchanged');

  // Valid value on the boundary
  const edge = [
    { announcerId: 'a'.repeat(128), kind: `a${'b'.repeat(31)}`, urls: urlN(8) },
    { announcerId: 'x.y_z:w-1', kind: 'k-9', urls: ['https://example.lan/'], meta: { blob: 'x'.repeat(3000) } },
  ];
  for (const fields of edge) assert.equal((await announce(a, fields)).type, 'service.announced', JSON.stringify(fields).slice(0, 80));
});

// ------------------------------------------------------------------ E8

test('E8 the 65th registration replies limit; once the limit is reached, replacing an existing one still works as usual', async (t) => {
  const env = await startService();
  t.after(env.cleanup);
  const MAX = env.defaults.MAX_ANNOUNCERS;
  const a = await env.connect();
  for (let i = 0; i < MAX; i++) {
    const r = await announce(a, { announcerId: `n-${i}`, kind: 'asset', urls: [`http://10.0.1.${i % 250}:8790/`] });
    assert.equal(r.type, 'service.announced', `Item ${i + 1}`);
  }
  const over = await announce(a, { announcerId: `n-${MAX}`, kind: 'asset', urls: ['http://10.0.2.1:8790/'] });
  assert.deepEqual([over.type, over.reason], ['error', 'limit']);
  assert.equal((await env.health()).endpoints, MAX);
  const w = await env.connect();
  assert.equal((await watch(w, 'all')).length, MAX);

  const replace = await announce(a, { announcerId: 'n-0', kind: 'asset', urls: ['http://10.0.3.1:8790/'] });
  assert.equal(replace.type, 'service.announced', 'replacing does not increase the total');
  assert.equal((await env.health()).endpoints, MAX);
});

test('E8 flat options: maxAnnouncers, maxUrls, maxMetaBytes are configurable (G.12)', async (t) => {
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

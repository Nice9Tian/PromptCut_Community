/**
 * Document service core channels and outbound backpressure (contract
 * `docs/plan/render-queue-contract.md` H.1, H.2, H.4, test cases C1-C7).
 * Run: node --test server/test/docservice-channels.test.mjs
 *
 * Written strictly against the contract, ignoring implementation. Core unit tests: directly call
 * `createRouter`, inject fake `write` / `buffered` / `close`, no network started.
 * The assembly layer half of `/healthz` and `describe()` (C7 assembly layer) is in
 * `docservice-backpressure.test.mjs`, which starts real services.
 *
 * Byte counts uniformly use pure ASCII messages; character count equals UTF-8 byte count, so
 * either calculation yields the same result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

async function loadRouter() {
  return import('../docservice/router.mjs');
}

const PRINCIPAL = Object.freeze({ userId: 'u', tenantId: null });

/**
 * Fake transport:
 *   writes.get(connId)   written text (in order)
 *   setBuffered(c, n)    sets return value of buffered(c)
 *   when grow = true, each write adds text byte count to this connection's buffered (simulating
 *                        underlying backlog)
 *   closes               call records of close(connId, code, reason)
 *   logs                 { event, ...fields }
 */
async function harness({ highWaterBytes, maxPendingBytes, grow = false } = {}) {
  const { createRouter, CORE_DEFAULTS } = await loadRouter();
  const writes = new Map();
  const buffered = new Map();
  const closes = [];
  const logs = [];
  const h = {
    grow,
    writes,
    closes,
    logs,
    CORE_DEFAULTS,
    texts: (connId) => writes.get(connId) ?? [],
    msgs: (connId) => (writes.get(connId) ?? []).map((t) => JSON.parse(t)),
    setBuffered: (connId, n) => buffered.set(connId, n),
  };
  const options = {
    now: () => 1000,
    log: (event, fields) => logs.push({ event, ...fields }),
    write(connId, text) {
      assert.equal(typeof text, 'string', 'What write receives must be already-serialized text');
      if (!writes.has(connId)) writes.set(connId, []);
      writes.get(connId).push(text);
      if (h.grow) buffered.set(connId, (buffered.get(connId) ?? 0) + Buffer.byteLength(text));
    },
    buffered: (connId) => buffered.get(connId) ?? 0,
    close(connId, code, reason) { closes.push([connId, code, reason]); },
  };
  if (highWaterBytes !== undefined) options.highWaterBytes = highWaterBytes;
  if (maxPendingBytes !== undefined) options.maxPendingBytes = maxPendingBytes;
  h.router = createRouter(options);
  return h;
}

/** Module declaring channel prefix; obtained ctx is stored on `mod.ctx` (retrieved in connect hook) */
function chanModule(name, { channels = [name], types = [`${name}.`], ...extra } = {}) {
  const mod = {
    name,
    types,
    channels,
    ctx: null,
    connect(ctx) { mod.ctx = ctx; },
    handle(ctx) { mod.ctx = ctx; },
    ...extra,
  };
  return mod;
}

/** Fixed-length pure ASCII message: i is padded to two digits, serialized length is independent of i */
const seqMsg = (i) => ({ type: 'seq.m', i: String(i).padStart(2, '0'), pad: 'xxxxxxxxxxxxxxxxxxxx' });
const SEQ_LEN = Buffer.byteLength(JSON.stringify(seqMsg(0)));

// ------------------------------------------------------------------ C1

test('C1 subscribe / unsubscribe / publish: only subscribers receive, the return value equals the delivery count, and a repeated subscription returns false', async () => {
  const h = await harness();
  const { router } = h;
  const room = chanModule('room');
  router.mount(room);
  for (const c of ['c1', 'c2', 'c3']) router.connect(c, PRINCIPAL, { remote: '127.0.0.1', connectedAt: 1000 });
  const { ctx } = room;
  assert.ok(ctx, 'The module\'s connect hook should get ctx');
  for (const fn of ['subscribe', 'unsubscribe', 'publish']) assert.equal(typeof ctx[fn], 'function', `ctx.${fn} should be a function (H.1)`);

  assert.equal(ctx.subscribe('c1', 'room:a'), true, 'The first subscription returns true');
  assert.equal(ctx.subscribe('c1', 'room:a'), false, 'A repeated subscription returns false');
  assert.equal(ctx.subscribe('ghost', 'room:a'), false, 'A nonexistent connection returns false');
  assert.equal(ctx.subscribe('c2', 'room:a'), true);
  assert.equal(ctx.subscribe('c3', 'room:b'), true);

  const message = { type: 'room.said', text: 'hi', n: 1 };
  assert.equal(ctx.publish('room:a', message), 2, 'Delivered to the two connections c1 and c2');
  assert.deepEqual(h.msgs('c1'), [message], 'Subscribers receive the message as is, and the core adds no fields');
  assert.deepEqual(h.msgs('c2'), [message]);
  assert.deepEqual(h.msgs('c3'), [], 'Subscribers of room:b do not receive messages of room:a');
  assert.equal(h.texts('c1')[0], h.texts('c2')[0], 'The text sent by the same publish is identical (serialized once)');

  assert.equal(ctx.publish('room:b', { type: 'room.said', n: 2 }), 1);
  assert.deepEqual(h.msgs('c3').map((m) => m.n), [2]);
  assert.equal(h.msgs('c1').length, 1, 'c1 is not subscribed to room:b');

  assert.equal(ctx.publish('room:nobody', { type: 'room.said', n: 3 }), 0, 'A channel with no subscribers has a delivery count of 0');

  assert.equal(ctx.unsubscribe('c2', 'room:a'), true, 'Unsubscribing a subscribed one returns true');
  assert.equal(ctx.unsubscribe('c2', 'room:a'), false, 'A repeated unsubscribe returns false');
  assert.equal(ctx.unsubscribe('ghost', 'room:a'), false, 'A nonexistent connection returns false');
  assert.equal(ctx.publish('room:a', { type: 'room.said', n: 4 }), 1, 'Only c1 remains after unsubscribing');
  assert.deepEqual(h.msgs('c1').map((m) => m.n), [1, 4]);
  assert.deepEqual(h.msgs('c2').map((m) => m.n), [1], 'Nothing is received after unsubscribing');

  assert.equal(ctx.subscribe('c2', 'room:a'), true, 'Can subscribe again after unsubscribing');
  assert.equal(ctx.publish('room:a', { type: 'room.said', n: 5 }), 2);
});

// ------------------------------------------------------------------ C2

test('C2 prefix ownership: publishing to or subscribing to another module\'s prefix throws; two modules declaring the same prefix makes mount throw, and the already-mounted module is unaffected', async () => {
  const h = await harness();
  const { router } = h;
  const room = chanModule('room');
  const chat = chanModule('chat');
  const plain = chanModule('plain');
  delete plain.channels;
  router.mount(room);
  router.mount(chat);
  router.mount(plain);
  router.connect('c1', PRINCIPAL, {});
  assert.ok(room.ctx && chat.ctx && plain.ctx);

  assert.throws(() => room.ctx.publish('chat:x', { type: 'x' }), Error, 'Publishing to another module\'s prefix');
  assert.throws(() => room.ctx.subscribe('c1', 'chat:x'), Error, 'Subscribing to another module\'s prefix');
  assert.throws(() => room.ctx.publish('roomy:x', { type: 'x' }), Error, 'Prefixes are compared by whole segment, so roomy does not belong to room');
  assert.throws(() => room.ctx.subscribe('c1', 'roomy:x'), Error);
  assert.throws(() => plain.ctx.publish('plain:x', { type: 'x' }), Error, 'A module that does not declare channels has no channels at all');
  assert.throws(() => plain.ctx.subscribe('c1', 'room:a'), Error);
  assert.deepEqual(h.msgs('c1'), [], 'The out-of-bounds calls sent nothing');

  // Own prefix remains usable as usual
  assert.equal(chat.ctx.subscribe('c1', 'chat:x'), true);
  assert.equal(chat.ctx.publish('chat:x', { type: 'chat.m' }), 1);

  // Second module with same prefix: mount throws error and is not mounted
  const dup = chanModule('room2', { channels: ['room'], types: ['room2.'] });
  assert.throws(() => router.mount(dup), Error, 'Two modules declaring the same prefix');
  assert.ok(!router.modules().includes('room2'), 'Not mounted after the throw');
  const dupMany = chanModule('mixed', { channels: ['fresh', 'chat'], types: ['mixed.'] });
  assert.throws(() => router.mount(dupMany), Error, 'A duplicate of any prefix in the declaration throws');
  assert.ok(!router.modules().includes('mixed'));

  // Already mounted modules are unaffected after error is thrown
  assert.equal(room.ctx.subscribe('c1', 'room:a'), true);
  assert.equal(room.ctx.publish('room:a', { type: 'room.m' }), 1);
  assert.equal(chat.ctx.publish('chat:x', { type: 'chat.m' }), 1);
  assert.deepEqual(router.modules(), ['room', 'chat', 'plain']);

  // Prefix is released after unmount; other modules can declare it
  const h2 = await harness();
  const a = chanModule('a', { channels: ['shared'] });
  const unmountA = h2.router.mount(a);
  unmountA();
  const b = chanModule('b', { channels: ['shared'] });
  h2.router.mount(b);
  h2.router.connect('c1', PRINCIPAL, {});
  assert.equal(b.ctx.subscribe('c1', 'shared:1'), true);
});

// ------------------------------------------------------------------ C3

test('C3 after a disconnect the subscriptions are cleared and publish no longer delivers to it; a reconnect with the same id does not inherit old subscriptions', async () => {
  const h = await harness();
  const { router } = h;
  const room = chanModule('room');
  router.mount(room);
  router.connect('c1', PRINCIPAL, {});
  router.connect('c2', PRINCIPAL, {});
  const { ctx } = room;
  ctx.subscribe('c1', 'room:a');
  ctx.subscribe('c1', 'room:b');
  ctx.subscribe('c2', 'room:a');
  assert.equal(ctx.publish('room:a', { type: 'room.m', n: 1 }), 2);

  router.disconnect('c1');
  assert.equal(ctx.publish('room:a', { type: 'room.m', n: 2 }), 1, 'A dropped connection no longer counts as a subscriber');
  assert.equal(ctx.publish('room:b', { type: 'room.m', n: 3 }), 0, 'All of c1\'s subscriptions were cleared');
  assert.deepEqual(h.msgs('c1').map((m) => m.n), [1], 'Nothing was written to it after the disconnect');
  assert.equal(ctx.unsubscribe('c1', 'room:a'), false, 'The connection no longer exists');

  const health = router.health();
  assert.equal(health.subscriptions, 1, 'The total subscriptions are down to c2\'s single one');
  assert.equal(health.channels, 1, 'Only room:a still has subscribers');

  router.connect('c1', PRINCIPAL, {});
  assert.equal(ctx.publish('room:b', { type: 'room.m', n: 4 }), 0, 'A reconnect with the same id does not bring back old subscriptions');
  assert.equal(ctx.subscribe('c1', 'room:b'), true, 'A subscription after reconnecting counts as a new subscription');
  assert.equal(ctx.publish('room:b', { type: 'room.m', n: 5 }), 1);
  assert.deepEqual(h.msgs('c1').map((m) => m.n), [1, 5]);
});

// ------------------------------------------------------------------ C4

test('C4 during a backlog, messages with the same key keep only the latest one, placed at the tail of the queue; keyless messages are not coalesced; those already written do not take part in coalescing; the coalesced count is correct', async () => {
  const h = await harness({ highWaterBytes: 1000, maxPendingBytes: 1_000_000 });
  const { router } = h;
  const room = chanModule('room');
  router.mount(room);
  router.connect('c1', PRINCIPAL, {});
  router.connect('c2', PRINCIPAL, {});
  const { ctx } = room;
  ctx.subscribe('c1', 'room:a');

  // No backlog: write directly
  ctx.send('c1', { type: 'room.m', tag: 'X', v: 0 }, { coalesceKey: 'k1' });
  assert.deepEqual(h.msgs('c1').map((m) => m.tag), ['X'], 'Queue empty and buffered < highWater: write directly');

  h.setBuffered('c1', 5000);
  ctx.send('c1', { type: 'room.m', tag: 'A', v: 1 }, { coalesceKey: 'k1' });   // Enqueue, does not merge with already written X
  ctx.send('c1', { type: 'room.m', tag: 'B' });                                 // No key
  ctx.send('c1', { type: 'room.m', tag: 'C', v: 2 }, { coalesceKey: 'k1' });   // Merge away A
  ctx.send('c1', { type: 'room.m', tag: 'D' });                                 // No key
  ctx.send('c1', { type: 'room.m', tag: 'D' });                                 // Same as previous one, still does not merge
  ctx.send('c1', { type: 'room.m', tag: 'E' }, { coalesceKey: 'k2' });
  assert.equal(ctx.publish('room:a', { type: 'room.m', tag: 'P', v: 1 }, { coalesceKey: 'p' }), 1);
  assert.equal(ctx.publish('room:a', { type: 'room.m', tag: 'P', v: 2 }, { coalesceKey: 'p' }), 1, 'A publish that was coalesced also counts as delivered'); // Merge away P1
  ctx.send('c1', { type: 'room.m', tag: 'F', v: 3 }, { coalesceKey: 'k1' });   // Merge away C, append to queue tail

  assert.deepEqual(h.msgs('c1').map((m) => m.tag), ['X'], 'Nothing was written during the backlog');
  assert.equal(router.health().coalesced, 3, 'A, P1 and C were each coalesced once');

  // Same key on other connections does not merge across connections
  h.setBuffered('c2', 5000);
  ctx.send('c2', { type: 'room.m', tag: 'Z' }, { coalesceKey: 'k1' });
  assert.equal(router.health().coalesced, 3, 'Coalescing happens only within the queue of the same connection');

  h.setBuffered('c1', 0);
  router.drained('c1');
  const got = h.msgs('c1');
  assert.deepEqual(got.map((m) => m.tag), ['X', 'B', 'D', 'D', 'E', 'P', 'F'], 'Same key keeps only the latest one at the tail of the queue, and the rest keep their order');
  assert.equal(got.find((m) => m.tag === 'P').v, 2, 'The one kept is the latest P');
  assert.equal(got.at(-1).v, 3, 'The one kept is the latest k1');
  assert.deepEqual(h.msgs('c2'), [], 'c2 is still backed up');

  // Backlog again after draining: new round of merging proceeds as usual
  h.setBuffered('c1', 5000);
  ctx.send('c1', { type: 'room.m', tag: 'G', v: 1 }, { coalesceKey: 'k1' });
  ctx.send('c1', { type: 'room.m', tag: 'G', v: 2 }, { coalesceKey: 'k1' });
  assert.equal(router.health().coalesced, 4);
  h.setBuffered('c1', 0);
  router.drained('c1');
  assert.deepEqual(h.msgs('c1').slice(7).map((m) => [m.tag, m.v]), [['G', 2]]);
});

// ------------------------------------------------------------------ C5

test('C5 drained empties the queue in order until buffered is full again; while the queue is non-empty, new messages are also queued, and the order stays intact', async () => {
  const L = SEQ_LEN;
  const hw = Math.floor(2.5 * L);
  const h = await harness({ highWaterBytes: hw, maxPendingBytes: 1_000_000 });
  const { router } = h;
  const seq = chanModule('seq');
  router.mount(seq);
  router.connect('c1', PRINCIPAL, {});
  const { ctx } = seq;
  const idx = () => h.msgs('c1').map((m) => Number(m.i));

  h.setBuffered('c1', 10 * L);
  for (let i = 0; i < 6; i++) ctx.send('c1', seqMsg(i));
  assert.deepEqual(idx(), [], 'buffered reached highWater: everything is queued');

  // Underlying layer drains once; each subsequent write increases buffered
  h.grow = true;
  h.setBuffered('c1', 0);
  router.drained('c1');
  assert.deepEqual(idx(), [0, 1, 2], `Written until buffered >= highWater (${hw}): 3 × ${L} bytes`);
  router.drained('c1');   // Underlying layer may send duplicate drain (H.7 item 4): buffered still full, writes nothing
  assert.deepEqual(idx(), [0, 1, 2], 'A repeated drained writes nothing extra and keeps the order');

  // Underlying layer drains again, but new message arrives first: queue non-empty, must queue behind 3, 4, 5
  h.setBuffered('c1', 0);
  ctx.send('c1', seqMsg(6));
  assert.deepEqual(idx(), [0, 1, 2], 'While the outbound queue is non-empty, new messages do not jump the queue by writing directly');

  router.drained('c1');
  assert.deepEqual(idx(), [0, 1, 2, 3, 4, 5]);
  h.setBuffered('c1', 0);
  router.drained('c1');
  router.drained('c1');   // Called twice in a row: queue is already empty the second time
  assert.deepEqual(idx(), [0, 1, 2, 3, 4, 5, 6], 'Everything is written in send order, and a repeated drained changes neither order nor content');
  assert.deepEqual(h.msgs('c1').map((m) => m.pad), Array(7).fill(seqMsg(0).pad));

  // drained does nothing when queue is empty; resumes direct writing afterwards
  h.setBuffered('c1', 0);
  router.drained('c1');
  assert.equal(idx().length, 7);
  ctx.send('c1', seqMsg(7));
  assert.deepEqual(idx(), [0, 1, 2, 3, 4, 5, 6, 7], 'Queue empty and buffered < highWater: write directly');

  // drained on unknown connection does not throw
  assert.doesNotThrow(() => router.drained('ghost'));
});

// ------------------------------------------------------------------ C6

test('C6 exceeding maxPendingBytes: close(connId, 1013, backpressure), the queue is cleared, later sends are discarded, and backpressureCloses increases by one', async () => {
  const L = SEQ_LEN;
  const max = Math.floor(3.5 * L);
  const h = await harness({ highWaterBytes: 10, maxPendingBytes: max });
  const { router } = h;
  const seq = chanModule('seq');
  router.mount(seq);
  router.connect('c1', PRINCIPAL, {});
  router.connect('c2', PRINCIPAL, {});
  const { ctx } = seq;
  ctx.subscribe('c1', 'seq:all');
  assert.equal(router.health().backpressureCloses, 0);

  h.setBuffered('c1', L);
  ctx.send('c1', seqMsg(0));
  ctx.send('c1', seqMsg(1));
  assert.deepEqual(h.closes, [], `Queued 2 × ${L} + buffered ${L} = ${3 * L} <= ${max}: do not close`);
  ctx.send('c1', seqMsg(2));
  assert.deepEqual(h.closes, [['c1', 1013, 'backpressure']], `${4 * L} > ${max}: close with 1013`);
  assert.equal(router.health().backpressureCloses, 1);

  const logged = h.logs.filter((l) => l.event === 'conn.backpressure');
  assert.equal(logged.length, 1, 'Logs one conn.backpressure');
  assert.equal(logged[0].connId, 'c1');
  assert.equal(logged[0].pendingBytes, 4 * L, 'pendingBytes = bytes in the queue + buffered');

  // Subsequent sends are all dropped, queue cleared: draining writes nothing out
  ctx.send('c1', seqMsg(3));
  ctx.publish('seq:all', seqMsg(4));
  h.setBuffered('c1', 0);
  router.drained('c1');
  ctx.send('c1', seqMsg(5));
  router.send('c1', seqMsg(6));
  assert.deepEqual(h.texts('c1'), [], 'nothing is written after closing');
  assert.equal(h.closes.length, 1, 'does not close again');
  assert.equal(router.health().backpressureCloses, 1);

  // Other connections are unaffected
  ctx.send('c2', seqMsg(9));
  assert.deepEqual(h.msgs('c2').map((m) => m.i), ['09']);

  // After assembly layer reports disconnect, new connection with same id works as usual, count does not regress
  router.disconnect('c1');
  router.connect('c1', PRINCIPAL, {});
  ctx.send('c1', seqMsg(7));
  assert.deepEqual(h.msgs('c1').map((m) => m.i), ['07'], 'a new connection gets a fresh queue');
  assert.equal(router.health().backpressureCloses, 1);
});

test('C6 default limits: CORE_DEFAULTS is 64 KiB / 1 MiB, and with no options passed the connection is closed by these limits', async () => {
  const h = await harness();
  assert.deepEqual(
    { HIGH_WATER_BYTES: h.CORE_DEFAULTS?.HIGH_WATER_BYTES, MAX_PENDING_BYTES: h.CORE_DEFAULTS?.MAX_PENDING_BYTES },
    { HIGH_WATER_BYTES: 64 * 1024, MAX_PENDING_BYTES: 1024 * 1024 },
  );
  const { router } = h;
  const seq = chanModule('seq');
  router.mount(seq);
  router.connect('c1', PRINCIPAL, {});
  const { ctx } = seq;
  const pad = 'y'.repeat(100 * 1024);
  h.setBuffered('c1', 64 * 1024);           // Exactly reaches highWater: enqueued
  for (let i = 0; i < 9; i++) ctx.send('c1', { type: 'seq.big', i, pad });
  assert.deepEqual(h.closes, [], '64 KiB + 9 × ~100 KiB < 1 MiB: not closed');
  assert.deepEqual(h.texts('c1'), [], 'buffered exactly equal to highWater also counts as full (only < writes directly)');
  ctx.send('c1', { type: 'seq.big', i: 9, pad });
  assert.deepEqual(h.closes, [['c1', 1013, 'backpressure']], 'one more arrives, exceeding 1 MiB');
});

// ------------------------------------------------------------------ C7

test('C7 core H.4 fields: health() channels / subscriptions / pendingBytesMax / coalesced / backpressureCloses, describeConn pendingBytes / subscriptions', async () => {
  const L = SEQ_LEN;
  const h = await harness({ highWaterBytes: 100, maxPendingBytes: 1_000_000 });
  const { router } = h;
  const room = chanModule('room');
  const seq = chanModule('seq');
  router.mount(room);
  router.mount(seq);
  router.connect('c1', PRINCIPAL, {});
  router.connect('c2', PRINCIPAL, {});
  router.connect('c3', PRINCIPAL, {});

  let health = router.health();
  for (const f of ['channels', 'subscriptions', 'pendingBytesMax', 'coalesced', 'backpressureCloses']) {
    assert.equal(health[f], 0, `initial ${f} is 0`);
  }
  assert.equal(health.connections, 3, 'existing core fields unchanged');

  room.ctx.subscribe('c1', 'room:a');
  room.ctx.subscribe('c1', 'room:b');
  room.ctx.subscribe('c2', 'room:a');
  seq.ctx.subscribe('c2', 'seq:x');
  health = router.health();
  assert.equal(health.channels, 3, 'room:a, room:b, seq:x have subscribers');
  assert.equal(health.subscriptions, 4);

  const d1 = router.describeConn('c1');
  assert.deepEqual([...d1.subscriptions].sort(), ['room:a', 'room:b']);
  assert.deepEqual([...router.describeConn('c2').subscriptions].sort(), ['room:a', 'seq:x']);
  assert.deepEqual(router.describeConn('c3').subscriptions, []);
  assert.equal(d1.pendingBytes, 0);

  // Backlog: c1 buffered 500, 2 in queue (one was merged); c2 buffered 50 does not enqueue
  h.setBuffered('c1', 500);
  h.setBuffered('c2', 50);
  seq.ctx.send('c1', seqMsg(1), { coalesceKey: 'k' });
  seq.ctx.send('c1', seqMsg(2), { coalesceKey: 'k' });
  seq.ctx.send('c1', seqMsg(3));
  seq.ctx.send('c2', seqMsg(4));
  assert.equal(router.describeConn('c1').pendingBytes, 500 + 2 * L, 'pendingBytes = outbound queue + buffered');
  assert.equal(router.describeConn('c2').pendingBytes, 50, 'c2 is written directly and not queued: pendingBytes is just buffered');
  health = router.health();
  assert.equal(health.pendingBytesMax, 500 + 2 * L, 'maximum pendingBytes across all connections');
  assert.equal(health.coalesced, 1);

  // Channels with no subscribers are no longer counted after unsubscribe
  room.ctx.unsubscribe('c1', 'room:b');
  health = router.health();
  assert.equal(health.channels, 2);
  assert.equal(health.subscriptions, 3);

  // pendingBytes drops back after drain
  h.setBuffered('c1', 0);
  router.drained('c1');
  assert.equal(router.describeConn('c1').pendingBytes, 0);
});

test('C7 mounting throws when a module takes a new field name, and already-mounted modules are unaffected', async () => {
  const h = await harness();
  const { router } = h;
  const keep = chanModule('keep', { health: () => ({ keepN: 1 }), describeConn: () => ({ keepC: true }) });
  router.mount(keep);
  router.connect('c1', PRINCIPAL, {});

  for (const f of ['channels', 'subscriptions', 'pendingBytesMax', 'coalesced', 'backpressureCloses']) {
    const bad = { name: `h-${f}`, types: [`h${f.toLowerCase()}.`], handle() {}, health: () => ({ [f]: 0 }) };
    assert.throws(() => router.mount(bad), Error, `health field ${f} is a core reserved field`);
  }
  for (const f of ['pendingBytes', 'subscriptions']) {
    const bad = { name: `c-${f}`, types: [`c${f.toLowerCase()}.`], handle() {}, describeConn: () => ({ [f]: 0 }) };
    assert.throws(() => router.mount(bad), Error, `describeConn field ${f} is a core reserved field`);
  }
  assert.deepEqual(router.modules(), ['keep'], 'none of the modules that threw were mounted');
  assert.equal(router.health().keepN, 1);
  const d = router.describeConn('c1');
  assert.equal(d.keepC, true);
  assert.deepEqual(d.subscriptions, []);
  assert.equal(d.pendingBytes, 0);
});

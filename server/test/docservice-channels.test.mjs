/**
 * 文档服务核心的频道与出站背压（契约 `docs/plan/render-queue-contract.md` H.1、H.2、H.4，用例 C1～C7）。
 * 跑：node --test server/test/docservice-channels.test.mjs
 *
 * 只照契约写，不看实现。核心单元测试：直接 `createRouter`，注入假的 `write` / `buffered` / `close`，不起网络。
 * `/healthz` 与 `describe()` 在组装层的那一半（C7 组装层）在 `docservice-backpressure.test.mjs` 里，那边起真服务。
 *
 * 字节数一律用纯 ASCII 消息，字符数与 UTF-8 字节数相同，实现按哪一种算都一样。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

async function loadRouter() {
  return import('../docservice/router.mjs');
}

const PRINCIPAL = Object.freeze({ userId: 'u', tenantId: null });

/**
 * 假传输：
 *   writes.get(connId)   写出去的文本（按顺序）
 *   setBuffered(c, n)    设定 buffered(c) 的返回值
 *   grow = true 时，每次 write 都把文本字节数加到这条连接的 buffered 上（模拟底层积压）
 *   closes               close(connId, code, reason) 的调用记录
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
      assert.equal(typeof text, 'string', 'write 收到的必须是已序列化的文本');
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

/** 声明频道前缀的模块；拿到的 ctx 存在 `mod.ctx` 上（connect 钩子里取） */
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

/** 固定长度的纯 ASCII 消息：i 补成两位，序列化后长度与 i 无关 */
const seqMsg = (i) => ({ type: 'seq.m', i: String(i).padStart(2, '0'), pad: 'xxxxxxxxxxxxxxxxxxxx' });
const SEQ_LEN = Buffer.byteLength(JSON.stringify(seqMsg(0)));

// ------------------------------------------------------------------ C1

test('C1 subscribe / unsubscribe / publish：只有订阅者收到，返回值等于投递数，重复订阅回 false', async () => {
  const h = await harness();
  const { router } = h;
  const room = chanModule('room');
  router.mount(room);
  for (const c of ['c1', 'c2', 'c3']) router.connect(c, PRINCIPAL, { remote: '127.0.0.1', connectedAt: 1000 });
  const { ctx } = room;
  assert.ok(ctx, '模块的 connect 钩子应拿到 ctx');
  for (const fn of ['subscribe', 'unsubscribe', 'publish']) assert.equal(typeof ctx[fn], 'function', `ctx.${fn} 应是函数（H.1）`);

  assert.equal(ctx.subscribe('c1', 'room:a'), true, '首次订阅回 true');
  assert.equal(ctx.subscribe('c1', 'room:a'), false, '重复订阅回 false');
  assert.equal(ctx.subscribe('ghost', 'room:a'), false, '连接不存在回 false');
  assert.equal(ctx.subscribe('c2', 'room:a'), true);
  assert.equal(ctx.subscribe('c3', 'room:b'), true);

  const message = { type: 'room.said', text: 'hi', n: 1 };
  assert.equal(ctx.publish('room:a', message), 2, '投递给了 c1、c2 两条连接');
  assert.deepEqual(h.msgs('c1'), [message], '订阅者收到原样的消息，核心不补字段');
  assert.deepEqual(h.msgs('c2'), [message]);
  assert.deepEqual(h.msgs('c3'), [], 'room:b 的订阅者收不到 room:a 的消息');
  assert.equal(h.texts('c1')[0], h.texts('c2')[0], '同一次 publish 发出的文本相同（序列化一次）');

  assert.equal(ctx.publish('room:b', { type: 'room.said', n: 2 }), 1);
  assert.deepEqual(h.msgs('c3').map((m) => m.n), [2]);
  assert.equal(h.msgs('c1').length, 1, 'c1 没订阅 room:b');

  assert.equal(ctx.publish('room:nobody', { type: 'room.said', n: 3 }), 0, '没有订阅者的频道投递数为 0');

  assert.equal(ctx.unsubscribe('c2', 'room:a'), true, '退订已订阅的回 true');
  assert.equal(ctx.unsubscribe('c2', 'room:a'), false, '重复退订回 false');
  assert.equal(ctx.unsubscribe('ghost', 'room:a'), false, '连接不存在回 false');
  assert.equal(ctx.publish('room:a', { type: 'room.said', n: 4 }), 1, '退订后只剩 c1');
  assert.deepEqual(h.msgs('c1').map((m) => m.n), [1, 4]);
  assert.deepEqual(h.msgs('c2').map((m) => m.n), [1], '退订后收不到');

  assert.equal(ctx.subscribe('c2', 'room:a'), true, '退订后可以再订阅');
  assert.equal(ctx.publish('room:a', { type: 'room.said', n: 5 }), 2);
});

// ------------------------------------------------------------------ C2

test('C2 前缀归属：发布、订阅别的前缀抛错；两个模块声明同一前缀，挂载抛错且已挂模块不受影响', async () => {
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

  assert.throws(() => room.ctx.publish('chat:x', { type: 'x' }), Error, '发布别的模块的前缀');
  assert.throws(() => room.ctx.subscribe('c1', 'chat:x'), Error, '订阅别的模块的前缀');
  assert.throws(() => room.ctx.publish('roomy:x', { type: 'x' }), Error, '前缀按整段比较，roomy 不属于 room');
  assert.throws(() => room.ctx.subscribe('c1', 'roomy:x'), Error);
  assert.throws(() => plain.ctx.publish('plain:x', { type: 'x' }), Error, '没声明 channels 的模块没有任何频道');
  assert.throws(() => plain.ctx.subscribe('c1', 'room:a'), Error);
  assert.deepEqual(h.msgs('c1'), [], '越界的调用什么也没发出去');

  // 自己的前缀照常可用
  assert.equal(chat.ctx.subscribe('c1', 'chat:x'), true);
  assert.equal(chat.ctx.publish('chat:x', { type: 'chat.m' }), 1);

  // 同一前缀的第二个模块：挂载抛错、不挂
  const dup = chanModule('room2', { channels: ['room'], types: ['room2.'] });
  assert.throws(() => router.mount(dup), Error, '两个模块声明同一前缀');
  assert.ok(!router.modules().includes('room2'), '抛错后没挂上');
  const dupMany = chanModule('mixed', { channels: ['fresh', 'chat'], types: ['mixed.'] });
  assert.throws(() => router.mount(dupMany), Error, '声明里任意一个前缀重复都抛错');
  assert.ok(!router.modules().includes('mixed'));

  // 抛错后已挂的模块不受影响
  assert.equal(room.ctx.subscribe('c1', 'room:a'), true);
  assert.equal(room.ctx.publish('room:a', { type: 'room.m' }), 1);
  assert.equal(chat.ctx.publish('chat:x', { type: 'chat.m' }), 1);
  assert.deepEqual(router.modules(), ['room', 'chat', 'plain']);

  // 卸载后前缀放出来，别的模块可以声明
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

test('C3 断开后订阅清空，publish 不再投给它；同 id 重连不继承旧订阅', async () => {
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
  assert.equal(ctx.publish('room:a', { type: 'room.m', n: 2 }), 1, '断开的连接不再算订阅者');
  assert.equal(ctx.publish('room:b', { type: 'room.m', n: 3 }), 0, 'c1 的全部订阅都清掉了');
  assert.deepEqual(h.msgs('c1').map((m) => m.n), [1], '断开后一条也没写给它');
  assert.equal(ctx.unsubscribe('c1', 'room:a'), false, '连接已不存在');

  const health = router.health();
  assert.equal(health.subscriptions, 1, '订阅总数只剩 c2 的一个');
  assert.equal(health.channels, 1, '只剩 room:a 有订阅者');

  router.connect('c1', PRINCIPAL, {});
  assert.equal(ctx.publish('room:b', { type: 'room.m', n: 4 }), 0, '同 id 重连后不带回旧订阅');
  assert.equal(ctx.subscribe('c1', 'room:b'), true, '重连后订阅算新订阅');
  assert.equal(ctx.publish('room:b', { type: 'room.m', n: 5 }), 1);
  assert.deepEqual(h.msgs('c1').map((m) => m.n), [1, 5]);
});

// ------------------------------------------------------------------ C4

test('C4 积压时同键消息只留最新一条且排在队尾；无键消息不合并；已写出的不参与合并；coalesced 计数正确', async () => {
  const h = await harness({ highWaterBytes: 1000, maxPendingBytes: 1_000_000 });
  const { router } = h;
  const room = chanModule('room');
  router.mount(room);
  router.connect('c1', PRINCIPAL, {});
  router.connect('c2', PRINCIPAL, {});
  const { ctx } = room;
  ctx.subscribe('c1', 'room:a');

  // 不积压：直接写
  ctx.send('c1', { type: 'room.m', tag: 'X', v: 0 }, { coalesceKey: 'k1' });
  assert.deepEqual(h.msgs('c1').map((m) => m.tag), ['X'], '队列空且 buffered < highWater：直接写');

  h.setBuffered('c1', 5000);
  ctx.send('c1', { type: 'room.m', tag: 'A', v: 1 }, { coalesceKey: 'k1' });   // 进队，不与已写出的 X 合并
  ctx.send('c1', { type: 'room.m', tag: 'B' });                                 // 无键
  ctx.send('c1', { type: 'room.m', tag: 'C', v: 2 }, { coalesceKey: 'k1' });   // 合并掉 A
  ctx.send('c1', { type: 'room.m', tag: 'D' });                                 // 无键
  ctx.send('c1', { type: 'room.m', tag: 'D' });                                 // 与上一条相同，仍不合并
  ctx.send('c1', { type: 'room.m', tag: 'E' }, { coalesceKey: 'k2' });
  assert.equal(ctx.publish('room:a', { type: 'room.m', tag: 'P', v: 1 }, { coalesceKey: 'p' }), 1);
  assert.equal(ctx.publish('room:a', { type: 'room.m', tag: 'P', v: 2 }, { coalesceKey: 'p' }), 1, '合并后的 publish 也算投递'); // 合并掉 P1
  ctx.send('c1', { type: 'room.m', tag: 'F', v: 3 }, { coalesceKey: 'k1' });   // 合并掉 C，排到队尾

  assert.deepEqual(h.msgs('c1').map((m) => m.tag), ['X'], '积压期间一条也没写');
  assert.equal(router.health().coalesced, 3, 'A、P1、C 各被合并一次');

  // 别的连接同键不跨连接合并
  h.setBuffered('c2', 5000);
  ctx.send('c2', { type: 'room.m', tag: 'Z' }, { coalesceKey: 'k1' });
  assert.equal(router.health().coalesced, 3, '合并只在同一条连接的队列里');

  h.setBuffered('c1', 0);
  router.drained('c1');
  const got = h.msgs('c1');
  assert.deepEqual(got.map((m) => m.tag), ['X', 'B', 'D', 'D', 'E', 'P', 'F'], '同键只留最新一条并排在队尾，其余保持顺序');
  assert.equal(got.find((m) => m.tag === 'P').v, 2, '留下的是最新的 P');
  assert.equal(got.at(-1).v, 3, '留下的是最新的 k1');
  assert.deepEqual(h.msgs('c2'), [], 'c2 仍在积压');

  // 排空后再积压：新一轮合并照常
  h.setBuffered('c1', 5000);
  ctx.send('c1', { type: 'room.m', tag: 'G', v: 1 }, { coalesceKey: 'k1' });
  ctx.send('c1', { type: 'room.m', tag: 'G', v: 2 }, { coalesceKey: 'k1' });
  assert.equal(router.health().coalesced, 4);
  h.setBuffered('c1', 0);
  router.drained('c1');
  assert.deepEqual(h.msgs('c1').slice(7).map((m) => [m.tag, m.v]), [['G', 2]]);
});

// ------------------------------------------------------------------ C5

test('C5 drained 按顺序排空，排到 buffered 又满为止；队列非空时新消息也进队，顺序不乱', async () => {
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
  assert.deepEqual(idx(), [], 'buffered 到了 highWater：全部进队');

  // 底层排空一次；之后每次 write 都会让 buffered 涨上去
  h.grow = true;
  h.setBuffered('c1', 0);
  router.drained('c1');
  assert.deepEqual(idx(), [0, 1, 2], `写到 buffered >= highWater（${hw}）为止：3 × ${L} 字节`);
  router.drained('c1');   // 底层可能重复发 drain（H.7 第 4 条）：buffered 仍满，什么也不写
  assert.deepEqual(idx(), [0, 1, 2], '重复的 drained 不多写、不乱序');

  // 底层又排空，但先来一条新消息：队列非空，它必须排在 3、4、5 后面
  h.setBuffered('c1', 0);
  ctx.send('c1', seqMsg(6));
  assert.deepEqual(idx(), [0, 1, 2], '出站队列非空时，新消息不插队直接写');

  router.drained('c1');
  assert.deepEqual(idx(), [0, 1, 2, 3, 4, 5]);
  h.setBuffered('c1', 0);
  router.drained('c1');
  router.drained('c1');   // 连调两次：第二次队已空
  assert.deepEqual(idx(), [0, 1, 2, 3, 4, 5, 6], '全部按发送顺序写出，重复的 drained 不改变顺序与内容');
  assert.deepEqual(h.msgs('c1').map((m) => m.pad), Array(7).fill(seqMsg(0).pad));

  // 队空时 drained 什么也不做；之后恢复直接写
  h.setBuffered('c1', 0);
  router.drained('c1');
  assert.equal(idx().length, 7);
  ctx.send('c1', seqMsg(7));
  assert.deepEqual(idx(), [0, 1, 2, 3, 4, 5, 6, 7], '队空且 buffered < highWater：直接写');

  // 未知连接的 drained 不抛
  assert.doesNotThrow(() => router.drained('ghost'));
});

// ------------------------------------------------------------------ C6

test('C6 超过 maxPendingBytes：close(connId, 1013, backpressure)、队列清空、之后的发送丢弃、backpressureCloses 加一', async () => {
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
  assert.deepEqual(h.closes, [], `队里 2 × ${L} + buffered ${L} = ${3 * L} <= ${max}：不关`);
  ctx.send('c1', seqMsg(2));
  assert.deepEqual(h.closes, [['c1', 1013, 'backpressure']], `${4 * L} > ${max}：按 1013 关闭`);
  assert.equal(router.health().backpressureCloses, 1);

  const logged = h.logs.filter((l) => l.event === 'conn.backpressure');
  assert.equal(logged.length, 1, '记一条 conn.backpressure');
  assert.equal(logged[0].connId, 'c1');
  assert.equal(logged[0].pendingBytes, 4 * L, 'pendingBytes = 队里的字节数 + buffered');

  // 之后的发送一律丢弃，队列已清空：排空也写不出任何东西
  ctx.send('c1', seqMsg(3));
  ctx.publish('seq:all', seqMsg(4));
  h.setBuffered('c1', 0);
  router.drained('c1');
  ctx.send('c1', seqMsg(5));
  router.send('c1', seqMsg(6));
  assert.deepEqual(h.texts('c1'), [], '关闭之后什么也不写');
  assert.equal(h.closes.length, 1, '不重复关闭');
  assert.equal(router.health().backpressureCloses, 1);

  // 别的连接不受影响
  ctx.send('c2', seqMsg(9));
  assert.deepEqual(h.msgs('c2').map((m) => m.i), ['09']);

  // 组装层报断开之后，同 id 的新连接照常工作，计数不回退
  router.disconnect('c1');
  router.connect('c1', PRINCIPAL, {});
  ctx.send('c1', seqMsg(7));
  assert.deepEqual(h.msgs('c1').map((m) => m.i), ['07'], '新连接的队列是新的');
  assert.equal(router.health().backpressureCloses, 1);
});

test('C6 缺省上限：CORE_DEFAULTS 是 64 KiB / 1 MiB，不传选项时按它关闭', async () => {
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
  h.setBuffered('c1', 64 * 1024);           // 恰好到 highWater：进队
  for (let i = 0; i < 9; i++) ctx.send('c1', { type: 'seq.big', i, pad });
  assert.deepEqual(h.closes, [], '64 KiB + 9 × ~100 KiB < 1 MiB：不关');
  assert.deepEqual(h.texts('c1'), [], 'buffered 恰好等于 highWater 也算满（< 才直接写）');
  ctx.send('c1', { type: 'seq.big', i: 9, pad });
  assert.deepEqual(h.closes, [['c1', 1013, 'backpressure']], '再来一条超过 1 MiB');
});

// ------------------------------------------------------------------ C7

test('C7 核心的 H.4 字段：health() 的 channels / subscriptions / pendingBytesMax / coalesced / backpressureCloses，describeConn 的 pendingBytes / subscriptions', async () => {
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
    assert.equal(health[f], 0, `初始 ${f} 为 0`);
  }
  assert.equal(health.connections, 3, '原有核心字段照旧');

  room.ctx.subscribe('c1', 'room:a');
  room.ctx.subscribe('c1', 'room:b');
  room.ctx.subscribe('c2', 'room:a');
  seq.ctx.subscribe('c2', 'seq:x');
  health = router.health();
  assert.equal(health.channels, 3, 'room:a、room:b、seq:x 有订阅者');
  assert.equal(health.subscriptions, 4);

  const d1 = router.describeConn('c1');
  assert.deepEqual([...d1.subscriptions].sort(), ['room:a', 'room:b']);
  assert.deepEqual([...router.describeConn('c2').subscriptions].sort(), ['room:a', 'seq:x']);
  assert.deepEqual(router.describeConn('c3').subscriptions, []);
  assert.equal(d1.pendingBytes, 0);

  // 积压：c1 buffered 500，队里 2 条（其中一条被合并）；c2 buffered 50 不进队
  h.setBuffered('c1', 500);
  h.setBuffered('c2', 50);
  seq.ctx.send('c1', seqMsg(1), { coalesceKey: 'k' });
  seq.ctx.send('c1', seqMsg(2), { coalesceKey: 'k' });
  seq.ctx.send('c1', seqMsg(3));
  seq.ctx.send('c2', seqMsg(4));
  assert.equal(router.describeConn('c1').pendingBytes, 500 + 2 * L, 'pendingBytes = 出站队列 + buffered');
  assert.equal(router.describeConn('c2').pendingBytes, 50, 'c2 直接写出、没进队：pendingBytes 就是 buffered');
  health = router.health();
  assert.equal(health.pendingBytesMax, 500 + 2 * L, '各连接 pendingBytes 的最大值');
  assert.equal(health.coalesced, 1);

  // 退订后没人订阅的频道不再计数
  room.ctx.unsubscribe('c1', 'room:b');
  health = router.health();
  assert.equal(health.channels, 2);
  assert.equal(health.subscriptions, 3);

  // 排空后 pendingBytes 回落
  h.setBuffered('c1', 0);
  router.drained('c1');
  assert.equal(router.describeConn('c1').pendingBytes, 0);
});

test('C7 新字段名被模块占用时挂载抛错，已挂模块不受影响', async () => {
  const h = await harness();
  const { router } = h;
  const keep = chanModule('keep', { health: () => ({ keepN: 1 }), describeConn: () => ({ keepC: true }) });
  router.mount(keep);
  router.connect('c1', PRINCIPAL, {});

  for (const f of ['channels', 'subscriptions', 'pendingBytesMax', 'coalesced', 'backpressureCloses']) {
    const bad = { name: `h-${f}`, types: [`h${f.toLowerCase()}.`], handle() {}, health: () => ({ [f]: 0 }) };
    assert.throws(() => router.mount(bad), Error, `health 字段 ${f} 是核心保留字段`);
  }
  for (const f of ['pendingBytes', 'subscriptions']) {
    const bad = { name: `c-${f}`, types: [`c${f.toLowerCase()}.`], handle() {}, describeConn: () => ({ [f]: 0 }) };
    assert.throws(() => router.mount(bad), Error, `describeConn 字段 ${f} 是核心保留字段`);
  }
  assert.deepEqual(router.modules(), ['keep'], '抛错的一个也没挂上');
  assert.equal(router.health().keepN, 1);
  const d = router.describeConn('c1');
  assert.equal(d.keepC, true);
  assert.deepEqual(d.subscriptions, []);
  assert.equal(d.pendingBytes, 0);
});

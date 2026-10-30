/**
 * 文档服务骨架（server/docservice/）：WebSocket 帧层、消息解析、连接身份记录、渲染任务队列挂载点。
 * 跑：node --test server/test/docservice.test.mjs
 *
 * 用真实的 createRenderQueue 核对 hello 的回包形状（契约 `docs/plan/render-queue-contract.md` A.6）；
 * 帧层的异常情形（分片、无掩码、超限、心跳）用原始 TCP 手搓帧来测。端口一律由系统分配。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect as netConnect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createDocService } from '../docservice/service.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';

const quiet = () => {};

async function startService({ mount = true, ...options } = {}) {
  const service = createDocService({ log: quiet, ...options });
  let queue = null;
  if (mount) {
    queue = createRenderQueue({ now: Date.now, send: service.send });
    service.mountRenderQueue(queue);
  }
  const { port } = await service.listen(0, '127.0.0.1');
  return { service, queue, port, url: `ws://127.0.0.1:${port}` };
}

/** 用 Node 内置的 WebSocket 客户端连上，收到的消息排进队列，按条件等 */
function wsClient(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('连接失败')), { once: true });
  });
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e), { once: true }));
  return {
    ws, opened, closed,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(match = () => true, ms = 2000) {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) { waiters.splice(k, 1); reject(new Error('等消息超时')); }
        }, ms);
      });
    },
  };
}

const byReq = (reqId) => (m) => m.reqId === reqId;

/** 原始 TCP 客户端：自己握手、自己组帧，用来测帧层 */
async function rawClient(port, { path = '/' } = {}) {
  const sock = netConnect(port, '127.0.0.1');
  await new Promise((resolve) => sock.once('connect', resolve));
  let buf = Buffer.alloc(0);
  const listeners = new Set();
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); for (const l of listeners) l(); });
  const closed = new Promise((resolve) => sock.once('close', resolve));
  sock.on('error', () => {});
  function waitFor(pred, ms = 2000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const r = pred();
        if (r !== undefined) { listeners.delete(check); clearTimeout(t); resolve(r); }
      };
      const t = setTimeout(() => { listeners.delete(check); reject(new Error('等数据超时')); }, ms);
      listeners.add(check);
      check();
    });
  }
  const key = randomBytes(16).toString('base64');
  sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
    + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const status = await waitFor(() => {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return undefined;
    const head = buf.subarray(0, end).toString();
    buf = buf.subarray(end + 4);
    return Number(head.split(' ')[1]);
  });
  /** 读一帧（服务端帧不带掩码） */
  function readFrame() {
    if (buf.length < 2) return undefined;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) return undefined; len = buf.readUInt16BE(2); off = 4; }
    if (buf.length < off + len) return undefined;
    const frame = { opcode: buf[0] & 0x0f, payload: buf.subarray(off, off + len) };
    buf = buf.subarray(off + len);
    return frame;
  }
  return {
    status, sock, closed,
    /** 组一帧发出去；mask=false 用来造违规帧 */
    frame(opcode, payload, { fin = true, mask = true } = {}) {
      const data = Buffer.from(payload);
      const len = data.length;
      const ext = len < 126 ? Buffer.alloc(0) : Buffer.alloc(len < 65536 ? 2 : 8);
      if (len >= 126 && len < 65536) ext.writeUInt16BE(len);
      if (len >= 65536) ext.writeBigUInt64BE(BigInt(len));
      const head = Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | (len < 126 ? len : len < 65536 ? 126 : 127)]);
      const parts = [head, ext];
      if (mask) {
        const m = randomBytes(4);
        const masked = Buffer.from(data);
        for (let i = 0; i < len; i++) masked[i] ^= m[i & 3];
        parts.push(m, masked);
      } else {
        parts.push(data);
      }
      sock.write(Buffer.concat(parts));
    },
    readFrame: (ms) => waitFor(readFrame, ms),
  };
}

test('GET /healthz 报告服务状态', async (t) => {
  const { service, port } = await startService();
  t.after(() => service.close());
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.queue, true);
  assert.equal(body.connections, 0);
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
});

test('node.hello 收到队列的 node.welcome，连接记为渲染节点', async (t) => {
  const { service, url, queue } = await startService();
  t.after(() => service.close());
  const c = wsClient(url);
  await c.opened;
  c.send({ type: 'node.hello', reqId: 'h1', nodeId: 'node-A', profile: 'host', capabilities: { transcode: true } });
  const welcome = await c.next(byReq('h1'));
  assert.equal(welcome.type, 'node.welcome');
  assert.equal(welcome.nodeId, 'node-A');
  assert.deepEqual(welcome.resumed, []);
  assert.deepEqual(welcome.lost, []);
  assert.equal(welcome.epoch, queue.epoch);
  const [conn] = service.describe().conns;
  assert.deepEqual(conn.roles, ['node']);
  assert.equal(conn.node.nodeId, 'node-A');
  assert.equal(conn.node.profile, 'host');
  assert.deepEqual(conn.node.capabilities, { transcode: true });
  assert.equal(conn.publisherId, null);
  assert.deepEqual(conn.principal, { userId: 'anonymous', tenantId: null });
  c.ws.close();
});

test('publisher.hello 记为发布方；同一连接可以既是发布方又是节点', async (t) => {
  const { service, url } = await startService();
  t.after(() => service.close());
  const c = wsClient(url);
  await c.opened;
  c.send({ type: 'publisher.hello', reqId: 1, publisherId: 'page-1' });
  const w = await c.next(byReq(1));
  assert.equal(w.type, 'publisher.welcome');
  assert.equal(w.publisherId, 'page-1');
  assert.deepEqual(service.describe().conns[0].roles, ['publisher']);
  c.send({ type: 'node.hello', reqId: 2, nodeId: 'pc-1', profile: 'pc' });
  assert.equal((await c.next(byReq(2))).type, 'node.welcome');
  const d = service.describe();
  assert.deepEqual(d.conns[0].roles, ['publisher', 'node']);
  assert.equal(d.publishers, 1);
  assert.equal(d.nodes, 1);
  c.ws.close();
});

test('两条连接各自的身份分开记', async (t) => {
  const { service, url } = await startService();
  t.after(() => service.close());
  const page = wsClient(url);
  const node = wsClient(url);
  await Promise.all([page.opened, node.opened]);
  page.send({ type: 'publisher.hello', reqId: 'p', publisherId: 'page-1' });
  node.send({ type: 'node.hello', reqId: 'n', nodeId: 'host-1', profile: 'host' });
  await Promise.all([page.next(byReq('p')), node.next(byReq('n'))]);
  const roles = service.describe().conns.map((c) => [c.publisherId, c.node?.nodeId ?? null]);
  assert.deepEqual(roles.sort(), [['page-1', null], [null, 'host-1']].sort());
  page.ws.close();
  node.ws.close();
});

test('格式不对的 hello 由队列回 bad-message，不记角色', async (t) => {
  const { service, url } = await startService();
  t.after(() => service.close());
  const c = wsClient(url);
  await c.opened;
  c.send({ type: 'node.hello', reqId: 'x', nodeId: 'n', profile: 'toaster' });
  const e = await c.next(byReq('x'));
  assert.equal(e.type, 'error');
  assert.equal(e.reason, 'bad-message');
  assert.deepEqual(service.describe().conns[0].roles, []);
  c.ws.close();
});

test('不是 JSON、没有 type、未知 type 各回对应的 error', async (t) => {
  const { service, url } = await startService();
  t.after(() => service.close());
  const c = wsClient(url);
  await c.opened;
  c.ws.send('{oops');
  const e1 = await c.next();
  assert.deepEqual([e1.type, e1.reason], ['error', 'bad-message']);
  c.send({ reqId: 'r2', hello: 1 });
  const e2 = await c.next(byReq('r2'));
  assert.deepEqual([e2.type, e2.reason], ['error', 'bad-message']);
  c.send({ type: 'op.submit', reqId: 'r3' });
  const e3 = await c.next(byReq('r3'));
  assert.deepEqual([e3.type, e3.reason], ['error', 'unsupported']);
  c.ws.close();
});

test('没挂队列时队列消息回 queue-unavailable、不记角色；挂上后已有连接按 principal 接进队列', async (t) => {
  const { service, url } = await startService({ mount: false, authenticate: () => ({ userId: 'u1', tenantId: 't1' }) });
  t.after(() => service.close());
  const c = wsClient(url);
  await c.opened;
  c.send({ type: 'node.hello', reqId: 'a', nodeId: 'n1', profile: 'pc' });
  const e = await c.next(byReq('a'));
  assert.deepEqual([e.type, e.reason], ['error', 'queue-unavailable']);
  assert.deepEqual(service.describe().conns[0].roles, []);

  const calls = [];
  const fake = {
    connect: (id, p) => calls.push(['connect', id, p]),
    disconnect: (id) => calls.push(['disconnect', id]),
    handle: (id, m) => { calls.push(['handle', id, m.type]); service.send(id, { type: 'fake.ack', reqId: m.reqId }); },
    tick: () => {},
  };
  const unmount = service.mountRenderQueue(fake);
  const connId = service.describe().conns[0].connId;
  assert.deepEqual(calls[0], ['connect', connId, { userId: 'u1', tenantId: 't1' }]);
  assert.throws(() => service.mountRenderQueue(fake), /已经挂上/);

  c.send({ type: 'node.hello', reqId: 'b', nodeId: 'n1', profile: 'pc' });
  assert.equal((await c.next(byReq('b'))).type, 'fake.ack');
  assert.deepEqual(service.describe().conns[0].roles, ['node']);

  unmount();
  assert.deepEqual(calls.at(-1), ['disconnect', connId]);
  assert.deepEqual(service.describe().conns[0].roles, []);
  c.ws.close();
});

test('mountRenderQueue 拒绝缺方法的接口', async (t) => {
  const { service } = await startService({ mount: false });
  t.after(() => service.close());
  assert.throws(() => service.mountRenderQueue({ connect() {}, handle() {} }), TypeError);
});

test('连接断开时通知队列 disconnect', async (t) => {
  const { service, url } = await startService({ mount: false });
  t.after(() => service.close());
  const events = [];
  let gone;
  const disconnected = new Promise((resolve) => { gone = resolve; });
  service.mountRenderQueue({
    connect: (id) => events.push(['connect', id]),
    disconnect: (id) => { events.push(['disconnect', id]); gone(); },
    handle() {}, tick() {},
  });
  const c = wsClient(url);
  await c.opened;
  c.ws.close();
  await disconnected;
  assert.equal(events.length, 2);
  assert.equal(events[0][1], events[1][1]);
  assert.equal(service.describe().connections, 0);
});

test('authenticate 返回 null 时握手回 401', async (t) => {
  const { service, port } = await startService({ authenticate: () => null });
  t.after(() => service.close());
  const r = await rawClient(port);
  assert.equal(r.status, 401);
});

test('路径不对回 404', async (t) => {
  const { service, port } = await startService();
  t.after(() => service.close());
  const r = await rawClient(port, { path: '/other' });
  assert.equal(r.status, 404);
});

test('帧层：分片文本消息拼起来再处理，ping 回 pong', async (t) => {
  const { service, port } = await startService();
  t.after(() => service.close());
  const r = await rawClient(port);
  assert.equal(r.status, 101);
  const text = JSON.stringify({ type: 'publisher.hello', reqId: 'f', publisherId: 'p'.repeat(300) });
  r.frame(0x1, text.slice(0, 100), { fin: false });
  r.frame(0x9, 'hi');
  r.frame(0x0, text.slice(100, 200), { fin: false });
  r.frame(0x0, text.slice(200));
  const pong = await r.readFrame();
  assert.equal(pong.opcode, 0xa);
  assert.equal(pong.payload.toString(), 'hi');
  const reply = await r.readFrame();
  assert.equal(reply.opcode, 0x1);
  const msg = JSON.parse(reply.payload.toString());
  assert.equal(msg.type, 'publisher.welcome');
  assert.equal(msg.publisherId, 'p'.repeat(300));
  r.sock.destroy();
});

test('帧层：不带掩码的帧以 1002 关闭', async (t) => {
  const { service, port } = await startService();
  t.after(() => service.close());
  const r = await rawClient(port);
  r.frame(0x1, '{}', { mask: false });
  const f = await r.readFrame();
  assert.equal(f.opcode, 0x8);
  assert.equal(f.payload.readUInt16BE(0), 1002);
  await r.closed;
});

test('帧层：超过上限的消息以 1009 关闭；二进制帧以 1003 关闭', async (t) => {
  const { service, port } = await startService({ maxPayload: 1000 });
  t.after(() => service.close());
  const big = await rawClient(port);
  big.frame(0x1, 'x'.repeat(1001));
  const f1 = await big.readFrame();
  assert.equal(f1.payload.readUInt16BE(0), 1009);
  await big.closed;
  const bin = await rawClient(port);
  bin.frame(0x2, Buffer.from([1, 2, 3]));
  const f2 = await bin.readFrame();
  assert.equal(f2.payload.readUInt16BE(0), 1003);
  await bin.closed;
});

test('帧层：不合法的 UTF-8 以 1007 关闭', async (t) => {
  const { service, port } = await startService();
  t.after(() => service.close());
  const r = await rawClient(port);
  r.frame(0x1, Buffer.from([0xff, 0xfe]));
  const f = await r.readFrame();
  assert.equal(f.payload.readUInt16BE(0), 1007);
  await r.closed;
});

test('心跳：不回 pong 的连接被断开，并通知队列', async (t) => {
  const { service, port } = await startService({ mount: false, heartbeatMs: 40 });
  t.after(() => service.close());
  const gone = [];
  let notified;
  const disconnected = new Promise((resolve) => { notified = resolve; });
  service.mountRenderQueue({ connect() {}, disconnect: (id) => { gone.push(id); notified(); }, handle() {}, tick() {} });
  const r = await rawClient(port);
  assert.equal(r.status, 101);
  await Promise.all([r.closed, disconnected]);
  assert.equal(gone.length, 1);
  assert.equal(service.describe().connections, 0);
});

test('客户端发起关闭：服务端回关闭帧、连接记录清掉', async (t) => {
  const { service, url } = await startService();
  t.after(() => service.close());
  const c = wsClient(url);
  await c.opened;
  assert.equal(service.describe().connections, 1);
  c.ws.close(1000, 'bye');
  const e = await c.closed;
  assert.equal(e.code, 1000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(service.describe().connections, 0);
});

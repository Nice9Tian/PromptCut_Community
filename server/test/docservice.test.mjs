/**
 * Document service skeleton (server/docservice/): WebSocket frame layer, message parsing, connection
 * identity recording, render queue mount point.
 * Run: node --test server/test/docservice.test.mjs
 *
 * Check hello response shape with real createRenderQueue (contract
 * `docs/plan/render-queue-contract.md` A.6); frame layer exceptional cases (fragmentation, unmasked,
 * over limit, heartbeat) are tested using handcrafted frames over raw TCP. Ports are always
 * system-allocated.
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

/** Connect with Node's built-in WebSocket client, enqueue received messages, wait by condition */
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
    ws.addEventListener('error', () => reject(new Error('Connection failed')), { once: true });
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
          if (k >= 0) { waiters.splice(k, 1); reject(new Error('Timed out waiting for a message')); }
        }, ms);
      });
    },
  };
}

const byReq = (reqId) => (m) => m.reqId === reqId;

/** Raw TCP client: handshakes and frames on its own, used to test frame layer */
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
      const t = setTimeout(() => { listeners.delete(check); reject(new Error('timed out waiting for data')); }, ms);
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
  /** Read one frame (server frames have no mask) */
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
    /** Assemble a frame and send it out; mask=false is used to create non-compliant frames */
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

test('GET /healthz reports the service status', async (t) => {
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

test('node.hello receives node.welcome from the queue, and the connection is recorded as a render node', async (t) => {
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

test('publisher.hello is recorded as a publisher; one connection can be both a publisher and a node', async (t) => {
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

test('the identities of two connections are recorded separately', async (t) => {
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

test('a malformed hello gets bad-message from the queue and no role is recorded', async (t) => {
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

test('not JSON, no type, and an unknown type each reply with the corresponding error', async (t) => {
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

test('queue messages reply queue-unavailable and no role is recorded when no queue is mounted; once mounted, existing connections are attached to the queue by principal', async (t) => {
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
  assert.throws(() => service.mountRenderQueue(fake), /already attached/);

  c.send({ type: 'node.hello', reqId: 'b', nodeId: 'n1', profile: 'pc' });
  assert.equal((await c.next(byReq('b'))).type, 'fake.ack');
  assert.deepEqual(service.describe().conns[0].roles, ['node']);

  unmount();
  assert.deepEqual(calls.at(-1), ['disconnect', connId]);
  assert.deepEqual(service.describe().conns[0].roles, []);
  c.ws.close();
});

test('mountRenderQueue rejects an interface with missing methods', async (t) => {
  const { service } = await startService({ mount: false });
  t.after(() => service.close());
  assert.throws(() => service.mountRenderQueue({ connect() {}, handle() {} }), TypeError);
});

test('the queue is notified with disconnect when a connection drops', async (t) => {
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

test('the handshake replies 401 when authenticate returns null', async (t) => {
  const { service, port } = await startService({ authenticate: () => null });
  t.after(() => service.close());
  const r = await rawClient(port);
  assert.equal(r.status, 401);
});

test('a wrong path replies 404', async (t) => {
  const { service, port } = await startService();
  t.after(() => service.close());
  const r = await rawClient(port, { path: '/other' });
  assert.equal(r.status, 404);
});

test('frame layer: fragmented text messages are reassembled before handling, ping gets pong', async (t) => {
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

test('frame layer: an unmasked frame closes with 1002', async (t) => {
  const { service, port } = await startService();
  t.after(() => service.close());
  const r = await rawClient(port);
  r.frame(0x1, '{}', { mask: false });
  const f = await r.readFrame();
  assert.equal(f.opcode, 0x8);
  assert.equal(f.payload.readUInt16BE(0), 1002);
  await r.closed;
});

test('frame layer: a message over the limit closes with 1009; a binary frame closes with 1003', async (t) => {
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

test('frame layer: invalid UTF-8 closes with 1007', async (t) => {
  const { service, port } = await startService();
  t.after(() => service.close());
  const r = await rawClient(port);
  r.frame(0x1, Buffer.from([0xff, 0xfe]));
  const f = await r.readFrame();
  assert.equal(f.payload.readUInt16BE(0), 1007);
  await r.closed;
});

test('heartbeat: a connection that does not reply pong is dropped and the queue is notified', async (t) => {
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

test('client-initiated close: the server replies with a close frame and the connection record is cleared', async (t) => {
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

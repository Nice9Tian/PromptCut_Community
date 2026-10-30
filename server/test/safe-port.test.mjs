/**
 * `server/safe-port.mjs`：坏端口表与测试全局准备的名单一致；`listenSafe` 拿到坏端口会重试。
 * 跑：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { UNSAFE_PORTS, isUnsafePort, listenSafe, LISTEN_SAFE_TRIES } from '../safe-port.mjs';
import { FETCH_BAD_PORTS } from './global-setup.mjs';

test('global-setup 的坏端口名单是 UNSAFE_PORTS 的子集，且正是其中 ≥ 1024 的部分', () => {
  for (const port of FETCH_BAD_PORTS) assert.ok(isUnsafePort(port), `端口 ${port}`);
  assert.deepEqual([...FETCH_BAD_PORTS].sort((a, b) => a - b), UNSAFE_PORTS.filter((p) => p >= 1024));
});

test('isUnsafePort：表内为真、邻号为假、字符串也认', () => {
  for (const port of [1, 22, 6000, 6665, 6669, 10080]) assert.equal(isUnsafePort(port), true, `端口 ${port}`);
  for (const port of [80, 443, 1024, 5190, 5520, 6001, 6670, 10081, 20000]) assert.equal(isUnsafePort(port), false, `端口 ${port}`);
  assert.equal(isUnsafePort('6000'), true);
  assert.equal(new Set(UNSAFE_PORTS).size, UNSAFE_PORTS.length, '表里没有重复');
});

/** 假 server：按给定顺序发端口，记下 listen / close 的次数 */
function fakeServer(ports) {
  const s = new EventEmitter();
  let i = 0;
  let current = null;
  s.listens = [];
  s.closes = 0;
  s.listen = (port, host) => {
    s.listens.push({ port, host });
    current = ports[Math.min(i++, ports.length - 1)];
    setImmediate(() => s.emit('listening'));
    return s;
  };
  s.address = () => ({ port: current, address: '127.0.0.1', family: 'IPv4' });
  s.close = (cb) => { s.closes++; current = null; setImmediate(() => cb?.()); return s; };
  return s;
}

test('listenSafe：前几次拿到坏端口就关掉重来，最后拿到好端口并保持监听', async () => {
  const s = fakeServer([6000, 6665, 10080, 5523]);
  const port = await listenSafe(s, '127.0.0.1');
  assert.equal(port, 5523);
  assert.equal(s.listens.length, 4);
  assert.ok(s.listens.every((l) => l.port === 0 && l.host === '127.0.0.1'));
  assert.equal(s.closes, 3, '三个坏端口各关一次，好端口不关');
});

test('listenSafe：一直拿到坏端口，试满次数后抛错', async () => {
  const s = fakeServer([1719]);
  await assert.rejects(listenSafe(s, '127.0.0.1'), /坏端口/);
  assert.equal(s.listens.length, LISTEN_SAFE_TRIES);
});

test('listenSafe：listen 出错时原样抛出', async () => {
  const s = fakeServer([5523]);
  s.listen = () => { setImmediate(() => s.emit('error', Object.assign(new Error('boom'), { code: 'EACCES' }))); return s; };
  await assert.rejects(listenSafe(s, '127.0.0.1'), { code: 'EACCES' });
});

test('listenSafe：真的 net.Server 拿到的端口不是坏端口，且能连上', async () => {
  const server = net.createServer((socket) => socket.end('hi'));
  const port = await listenSafe(server, '127.0.0.1');
  try {
    assert.equal(isUnsafePort(port), false);
    const text = await new Promise((resolve, reject) => {
      const c = net.connect(port, '127.0.0.1');
      let buf = '';
      c.on('data', (d) => { buf += d; });
      c.on('end', () => resolve(buf));
      c.on('error', reject);
    });
    assert.equal(text, 'hi');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

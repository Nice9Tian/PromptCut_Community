/**
 * `server/safe-port.mjs`: bad port table matches the list prepared globally for tests;
 * `listenSafe` retries when getting a bad port.
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { UNSAFE_PORTS, isUnsafePort, listenSafe, LISTEN_SAFE_TRIES } from '../safe-port.mjs';
import { FETCH_BAD_PORTS } from './global-setup.mjs';

test('The bad-port list in global-setup is a subset of UNSAFE_PORTS, and is exactly the part of it that is ≥ 1024', () => {
  for (const port of FETCH_BAD_PORTS) assert.ok(isUnsafePort(port), `Port ${port}`);
  assert.deepEqual([...FETCH_BAD_PORTS].sort((a, b) => a - b), UNSAFE_PORTS.filter((p) => p >= 1024));
});

test('isUnsafePort: true for entries in the table, false for neighboring numbers, and strings are accepted too', () => {
  for (const port of [1, 22, 6000, 6665, 6669, 10080]) assert.equal(isUnsafePort(port), true, `Port ${port}`);
  for (const port of [80, 443, 1024, 5190, 5520, 6001, 6670, 10081, 20000]) assert.equal(isUnsafePort(port), false, `Port ${port}`);
  assert.equal(isUnsafePort('6000'), true);
  assert.equal(new Set(UNSAFE_PORTS).size, UNSAFE_PORTS.length, 'No duplicates in the table');
});

/** Mock server: issues ports in given order, recording count of listen / close calls */
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

test('listenSafe: closes and retries when it gets a bad port the first few times, and finally gets a good port and keeps listening', async () => {
  const s = fakeServer([6000, 6665, 10080, 5523]);
  const port = await listenSafe(s, '127.0.0.1');
  assert.equal(port, 5523);
  assert.equal(s.listens.length, 4);
  assert.ok(s.listens.every((l) => l.port === 0 && l.host === '127.0.0.1'));
  assert.equal(s.closes, 3, 'Each of the three bad ports is closed once, the good port is not closed');
});

test('listenSafe: keeps getting bad ports and throws after using up all attempts', async () => {
  const s = fakeServer([1719]);
  await assert.rejects(listenSafe(s, '127.0.0.1'), /bad port/);
  assert.equal(s.listens.length, LISTEN_SAFE_TRIES);
});

test('listenSafe: when listen fails, the error is thrown as is', async () => {
  const s = fakeServer([5523]);
  s.listen = () => { setImmediate(() => s.emit('error', Object.assign(new Error('boom'), { code: 'EACCES' }))); return s; };
  await assert.rejects(listenSafe(s, '127.0.0.1'), { code: 'EACCES' });
});

test('listenSafe: a real net.Server gets a port that is not a bad port, and it can be connected to', async () => {
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

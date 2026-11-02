/**
 * Unit test for `server/lan-open.mjs`: the bits of info needed by "open on mobile" (semantics
 * `mechanism/platforms.md` "second screen on LAN"). Pure function, spawns no processes, touches no
 * network. Entering projects across devices goes through invite links, which the page constructs
 * itself; this module only answers "whether bound to LAN, and which addresses".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LAN_HOST_COMMAND, boundToLan, lanOpenInfo, linkOnLan } from '../lan-open.mjs';

test('LO1 Whether it is bound to the LAN is judged by the actual listening address', () => {
  for (const a of ['0.0.0.0', '::', '[::]', '', '192.168.1.23', '10.0.0.5', '::ffff:192.168.1.23']) {
    assert.equal(boundToLan(a), true, `${a} should count as reachable`);
  }
  for (const a of ['127.0.0.1', '127.0.0.53', '::1', '[::1]', 'localhost', '::ffff:127.0.0.1']) {
    assert.equal(boundToLan(a), false, `${a} should count as bound to loopback only`);
  }
  // If cannot determine, treat as unreachable
  assert.equal(boundToLan(undefined), false);
  assert.equal(boundToLan(null), false);
  assert.equal(boundToLan(5190), false);
});

test('LO2 When bound to loopback only, no address is given at all, only how to start it', () => {
  const info = lanOpenInfo({ bound: '127.0.0.1', port: 5190, nics: [{ name: 'Wi-Fi', address: '192.168.1.23' }] });
  assert.equal(info.lanHost, false);
  assert.deepEqual(info.addresses, [], 'When the editor is bound to loopback only, a phone cannot connect, so listing addresses is pointless');
  assert.equal(info.command, LAN_HOST_COMMAND);
});

test('LO3 Bound to the LAN: one address per network card, and the user picks the network segment', () => {
  const info = lanOpenInfo({
    bound: '0.0.0.0',
    port: 5190,
    nics: [{ name: 'Wi-Fi', address: '192.168.1.23' }, { name: 'Ethernet', address: '10.0.0.5' }],
  });
  assert.equal(info.lanHost, true);
  assert.equal(info.port, 5190);
  assert.deepEqual(info.addresses, [
    { name: 'Wi-Fi', address: '192.168.1.23' },
    { name: 'Ethernet', address: '10.0.0.5' },
  ]);
});

test('LO4 No address is given when the port is unavailable (the service is not listening yet)', () => {
  const info = lanOpenInfo({ bound: '0.0.0.0', port: null, nics: [{ name: 'Wi-Fi', address: '192.168.1.23' }] });
  assert.equal(info.port, null);
  assert.deepEqual(info.addresses, []);
});

test('LO5 Does not throw when the NIC list is empty, has missing addresses, or is not an array at all', () => {
  assert.deepEqual(lanOpenInfo({ bound: '0.0.0.0', port: 5190, nics: [] }).addresses, []);
  assert.deepEqual(lanOpenInfo({ bound: '0.0.0.0', port: 5190, nics: null }).addresses, []);
  assert.deepEqual(lanOpenInfo({ bound: '0.0.0.0', port: 5190, nics: [{ name: 'bad' }, { address: '' }] }).addresses, []);
  assert.deepEqual(lanOpenInfo().addresses, []);
});

test('LO6 Whether the invite link lands on a network card of this machine: the UI uses it to tell whether a phone can open it', () => {
  const addrs = [{ address: '192.168.1.23' }, { address: '10.0.0.5' }];
  assert.equal(linkOnLan('http://192.168.1.23:5190/editor#invite=abc', addrs), true);
  assert.equal(linkOnLan('http://10.0.0.5:5190/editor', addrs), true);
  assert.equal(linkOnLan('192.168.1.23', addrs), true, 'A bare hostname is accepted too');
  assert.equal(linkOnLan('http://127.0.0.1:5190/editor#invite=abc', addrs), false, 'A phone cannot open a loopback link');
  assert.equal(linkOnLan('http://192.168.9.9:5190/editor', addrs), false);
  assert.equal(linkOnLan('', addrs), false);
  assert.equal(linkOnLan(null, addrs), false);
  assert.equal(linkOnLan('http://192.168.1.23:5190/', []), false);
  assert.equal(linkOnLan('http://192.168.1.23:5190/'), false);
});

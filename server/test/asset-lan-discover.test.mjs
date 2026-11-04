/**
 * `scripts/probes/asset-lan-discover.mjs`: the part that locates the asset service address
 * when `asset-lan-probe` is not given `--asset`. For projects on this machine, the asset service
 * address is brought back via LAN discovery and does not enter `service.endpoints`; the probe
 * previously only waited for `service.endpoints` and would time out.
 *
 * What can be verified locally: the pure function for picking candidates, trying addresses
 * in order, and a local stand-in: a real `createLanHost` (loopback adapter, random UDP port)
 * announces a project, with the service port pointing to a fake asset service (only accepting
 * `GET …/chunks` with a ticket), found and tested via real `discoverLan`.
 * Cross-machine (two machines, multicast and subnet broadcast on real network cards) is not
 * covered here, pending cross-machine review.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { lanCandidates, discoverLanAsset, firstReachableAsset, LAN_DISCOVER_TIMEOUT_MS } from '../../scripts/probes/asset-lan-discover.mjs';
import { createLanHost } from '../lan/discovery.mjs';

const PID_A = 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const PID_B = 'sp_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const host = (over) => ({ projectId: PID_A, name: 'Demo', mode: 'free', hostDeviceName: 'Studio-PC', docservice: 'ws://192.168.1.5:5190/docservice', asset: 'http://192.168.1.5:5190/api/asset', ...over });

test('asset-lan-discover:lanCandidates matches by projectId, orders by first appearance, and dedupes by asset address', () => {
  const hosts = [
    host({ asset: 'http://10.0.0.2:5190/api/asset/', firstSeenMs: 300 }),
    host({ projectId: PID_B, asset: 'http://10.0.0.9:5190/api/asset', firstSeenMs: 10 }),
    host({ firstSeenMs: 100 }),
    host({ asset: 'http://10.0.0.2:5190/api/asset', firstSeenMs: 400 }),
  ];
  const got = lanCandidates(hosts, { projectId: PID_A, name: 'ignored' });
  assert.deepEqual(got.map((c) => c.asset), ['http://192.168.1.5:5190/api/asset', 'http://10.0.0.2:5190/api/asset']);
  assert.equal(got[0].docservice, 'ws://192.168.1.5:5190/docservice');
  assert.equal(got[0].hostDeviceName, 'Studio-PC');
});

test('asset-lan-discover:lanCandidates matches by name when only a name is given (case-insensitive); entries with neither, and malformed entries, are not matched', () => {
  const hosts = [host({ name: 'DEMO' }), host({ projectId: PID_B, name: 'other', asset: 'http://x/api/asset' }), null, host({ asset: '' }), host({ asset: 42 })];
  assert.deepEqual(lanCandidates(hosts, { name: 'demo' }).map((c) => c.asset), ['http://192.168.1.5:5190/api/asset']);
  assert.deepEqual(lanCandidates(hosts, {}), []);
  assert.deepEqual(lanCandidates(undefined, { projectId: PID_A }), []);
});

test('asset-lan-discover:discoverLanAsset does not filter by name when projectId is present, and does not throw when discovery fails', async () => {
  let seen;
  const r = await discoverLanAsset({ projectId: PID_A, name: 'Demo' }, { discover: async (o) => { seen = o; return { hosts: [host()], errors: [] }; } });
  assert.equal(seen.name, undefined, 'no name is passed when projectId is present');
  assert.equal(seen.timeoutMs, LAN_DISCOVER_TIMEOUT_MS);
  assert.equal(r.candidates.length, 1);
  const r2 = await discoverLanAsset({ name: 'Demo' }, { discover: async (o) => { seen = o; return { hosts: [], errors: [{ reason: 'no-interface' }] }; } });
  assert.equal(seen.name, 'Demo');
  assert.deepEqual(r2.candidates, []);
  assert.deepEqual(r2.errors, [{ reason: 'no-interface' }]);
  const r3 = await discoverLanAsset({ projectId: PID_A }, { discover: async () => { throw new Error('boom'); } });
  assert.deepEqual(r3.candidates, []);
  assert.equal(r3.errors[0].reason, 'discover');
});

/** Fake asset service: GET /api/asset/media/<hash>/chunks with Bearer returns 200, others 401 */
async function fakeAsset(t) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization ?? null });
    const ok = /^\/api\/asset\/media\/[0-9a-f]{64}\/chunks$/.test(req.url) && req.headers.authorization === 'Bearer tkt';
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(ok ? JSON.stringify({ complete: false, received: [] }) : '{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  return { port: srv.address().port, hits };
}

test('asset-lan-discover:firstReachableAsset tries in order and takes the first one that returns 200; returns null if none is reachable', async (t) => {
  const a = await fakeAsset(t);
  const missingHash = 'f'.repeat(64);
  const good = `http://127.0.0.1:${a.port}/api/asset`;
  const dead = 'http://127.0.0.1:9/api/asset';
  assert.equal(await firstReachableAsset([dead, `${good}/`, 'http://127.0.0.1:1/x'], { ticket: 'tkt', missingHash, timeoutMs: 2000 }), good);
  assert.equal(await firstReachableAsset([good], { ticket: 'wrong', missingHash, timeoutMs: 2000 }), null, 'a wrong ticket (401) does not count as reachable');
  assert.equal(await firstReachableAsset([], { ticket: 'tkt', missingHash }), null);
  assert.ok(a.hits.every((h) => h.url === `/api/asset/media/${missingHash}/chunks`));
});

test('asset-lan-discover: local stand-in; the real createLanHost announces a project kept on this machine, then the real discoverLan finds the asset service address and checks it is reachable', { timeout: 30_000 }, async (t) => {
  const a = await fakeAsset(t);
  const LOOP = { name: 'probe-test-lo', address: '127.0.0.1', netmask: '255.0.0.0', broadcast: '127.0.0.1' };
  const projects = [{ projectId: PID_A, name: 'Local-Demo', mode: 'restricted' }, { projectId: PID_B, name: 'Other', mode: 'free' }];
  const lanHost = createLanHost({ projects: () => projects, hostDeviceName: 'Studio-PC', servicePort: a.port, port: 0, interfaces: () => [LOOP], periodMs: 600_000 });
  await lanHost.start();
  t.after(() => lanHost.stop());
  const discoverOptions = { port: lanHost.port(), interfaces: () => [LOOP] };

  const r = await discoverLanAsset({ projectId: PID_A, name: 'Local-Demo' }, { discoverOptions });
  assert.deepEqual(r.candidates.map((c) => c.asset), [`http://127.0.0.1:${a.port}/api/asset`], JSON.stringify(r));
  assert.equal(r.candidates[0].docservice, `ws://127.0.0.1:${a.port}/docservice`);
  assert.ok(r.ms <= 5000, `discovery took ${r.ms} ms`);
  const base = await firstReachableAsset(r.candidates.map((c) => c.asset), { ticket: 'tkt', missingHash: 'e'.repeat(64) });
  assert.equal(base, `http://127.0.0.1:${a.port}/api/asset`);

  const byName = await discoverLanAsset({ name: 'local-demo' }, { discoverOptions });
  assert.equal(byName.candidates.length, 1, 'can be found by name alone');
  const none = await discoverLanAsset({ projectId: 'sp_cccccccccccccccccccccccccc' }, { discoverOptions });
  assert.deepEqual(none.candidates, [], 'other projects (kept in the cloud) are not found; the probe falls back to waiting for service.endpoints');
});

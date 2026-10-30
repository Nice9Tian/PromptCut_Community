/**
 * `scripts/probes/asset-lan-discover.mjs`：`asset-lan-probe` 不给 `--asset` 时找素材服务地址的那一段。
 * 放本机的项目，素材服务地址经局域网发现带回、不进 `service.endpoints`；探针以前只等 `service.endpoints`，会超时。
 *
 * 本机能验的：挑候选的纯函数、按顺序试地址、以及一台本机替身——真的 `createLanHost`（回环网卡、随机 UDP 端口）
 * 通告一个项目，服务端口指向一台假素材服务（只认带票据的 `GET …/chunks`），经真的 `discoverLan` 找到并试通。
 * 跨机（两台机器、真实网卡上的组播与子网广播）不在这里，待跨机复核。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { lanCandidates, discoverLanAsset, firstReachableAsset, LAN_DISCOVER_TIMEOUT_MS } from '../../scripts/probes/asset-lan-discover.mjs';
import { createLanHost } from '../lan/discovery.mjs';

const PID_A = 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const PID_B = 'sp_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const host = (over) => ({ projectId: PID_A, name: 'Demo', mode: 'free', hostDeviceName: 'Studio-PC', docservice: 'ws://192.168.1.5:5190/docservice', asset: 'http://192.168.1.5:5190/api/asset', ...over });

test('asset-lan-discover:lanCandidates 按 projectId 认,按首次见到的先后排,按素材地址去重', () => {
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

test('asset-lan-discover:lanCandidates 只有名字时按名字认(不分大小写);两样都没有、坏条目都不认', () => {
  const hosts = [host({ name: 'DEMO' }), host({ projectId: PID_B, name: 'other', asset: 'http://x/api/asset' }), null, host({ asset: '' }), host({ asset: 42 })];
  assert.deepEqual(lanCandidates(hosts, { name: 'demo' }).map((c) => c.asset), ['http://192.168.1.5:5190/api/asset']);
  assert.deepEqual(lanCandidates(hosts, {}), []);
  assert.deepEqual(lanCandidates(undefined, { projectId: PID_A }), []);
});

test('asset-lan-discover:discoverLanAsset 有 projectId 时不按名字过滤,发现出错不抛', async () => {
  let seen;
  const r = await discoverLanAsset({ projectId: PID_A, name: 'Demo' }, { discover: async (o) => { seen = o; return { hosts: [host()], errors: [] }; } });
  assert.equal(seen.name, undefined, '有 projectId 时不传名字');
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

/** 假素材服务:带 Bearer 的 GET /api/asset/media/<哈希>/chunks 回 200,其余 401 */
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

test('asset-lan-discover:firstReachableAsset 按顺序试,取第一个 200 的;都不通回 null', async (t) => {
  const a = await fakeAsset(t);
  const missingHash = 'f'.repeat(64);
  const good = `http://127.0.0.1:${a.port}/api/asset`;
  const dead = 'http://127.0.0.1:9/api/asset';
  assert.equal(await firstReachableAsset([dead, `${good}/`, 'http://127.0.0.1:1/x'], { ticket: 'tkt', missingHash, timeoutMs: 2000 }), good);
  assert.equal(await firstReachableAsset([good], { ticket: 'wrong', missingHash, timeoutMs: 2000 }), null, '票据不对(401)不算通');
  assert.equal(await firstReachableAsset([], { ticket: 'tkt', missingHash }), null);
  assert.ok(a.hits.every((h) => h.url === `/api/asset/media/${missingHash}/chunks`));
});

test('asset-lan-discover:本机替身——真 createLanHost 通告放本机的项目,经真 discoverLan 找到素材服务地址并试通', { timeout: 30_000 }, async (t) => {
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
  assert.ok(r.ms <= 5000, `发现用时 ${r.ms} ms`);
  const base = await firstReachableAsset(r.candidates.map((c) => c.asset), { ticket: 'tkt', missingHash: 'e'.repeat(64) });
  assert.equal(base, `http://127.0.0.1:${a.port}/api/asset`);

  const byName = await discoverLanAsset({ name: 'local-demo' }, { discoverOptions });
  assert.equal(byName.candidates.length, 1, '只有名字也能找到');
  const none = await discoverLanAsset({ projectId: 'sp_cccccccccccccccccccccccccc' }, { discoverOptions });
  assert.deepEqual(none.candidates, [], '别的项目(放云端的)找不到,探针退回等 service.endpoints');
});

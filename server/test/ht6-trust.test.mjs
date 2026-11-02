/**
 * HT6：本机信任开关 `PROMPTCUT_TRUST_LOOPBACK`（契约 `docs/plan/http-transport-contract.md` 第 10 节，第 11 节 HT6）。
 * 跑：node --test server/test/ht6-trust.test.mjs
 *
 * 起 `server/hosted/main.mjs` 子进程（两个端口都给 0、只绑 127.0.0.1，从 `listen` 日志行读实际端口），从本机回环去敲：
 *   - `=0`：回环不带凭证握手 401、不带票据读素材 401、不带令牌调管理接口 401；带对令牌的管理接口照常；
 *   - `=1`（与缺省）：行为不变（回环握手成功、读素材不要票据、管理接口不要令牌）；
 *   - 旧名 `PROMPTCUT_TEST_NO_LOOPBACK_TRUST=1` 不再生效；
 *   - `=0` 而没有集群令牌：拒绝启动，`config.error { reason: 'cluster-token-required' }`（假设 H13）。
 * 开关没到位时（`server/hosted/*.mjs` 里没有这个名字）整组跳过。只照契约写，没看实现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SKIP_TRUST, PROTOCOL, rawHandshake, runHostedMain as runMain } from './ht-kit.mjs';

const T = { skip: SKIP_TRUST, timeout: 60_000 };
const token = () => crypto.randomBytes(32).toString('base64url');
const HASH = 'ab'.repeat(32);

function tempData(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ht6-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return d;
}

const configErrorOf = (out) => out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.event === 'config.error');

async function probe(r, clusterToken) {
  const hs = await rawHandshake(r.doc, { protocols: [PROTOCOL] });
  hs.sock.destroy();
  const media = await fetch(`http://127.0.0.1:${r.asset}/api/asset/media/${HASH}`);
  const admin = await fetch(`http://127.0.0.1:${r.asset}/admin/inventory`);
  const adminBad = await fetch(`http://127.0.0.1:${r.asset}/admin/inventory`, { headers: { Authorization: `Bearer ${token()}` } });
  const adminOk = clusterToken ? await fetch(`http://127.0.0.1:${r.asset}/admin/inventory`, { headers: { Authorization: `Bearer ${clusterToken}` } }) : null;
  return { handshake: hs.status, media: media.status, admin: admin.status, adminBadToken: adminBad.status, adminToken: adminOk?.status ?? null };
}

test('HT6-off PROMPTCUT_TRUST_LOOPBACK=0: a loopback handshake without credentials gets 401, reading an asset without a ticket gets 401, calling the admin API without a token gets 401; the admin API with the right token gets 200', T, async (t) => {
  const tok = token();
  const r = await runMain(t, { PROMPTCUT_DATA_DIR: tempData(t), PROMPTCUT_TRUST_LOOPBACK: '0', PROMPTCUT_CLUSTER_TOKEN: tok });
  assert.equal(r.code, null, `starts up: ${r.out.slice(-1500)}`);
  const got = await probe(r, tok);
  assert.deepEqual(got, { handshake: 401, media: 401, admin: 401, adminBadToken: 401, adminToken: 200 });
  // 本机声明（promptcut.tenant.* / promptcut.role.*）同样不认
  const hs = await rawHandshake(r.doc, { protocols: [PROTOCOL, 'promptcut.tenant.local', 'promptcut.role.page'] });
  hs.sock.destroy();
  assert.equal(hs.status, 401, 'with =0 the claim of being local is not honored');
});

for (const [label, env] of [['=1', { PROMPTCUT_TRUST_LOOPBACK: '1' }], ['default', {}]]) {
  test(`HT6-on PROMPTCUT_TRUST_LOOPBACK ${label}: behavior unchanged (loopback handshake succeeds, reading an asset needs no ticket, the admin API needs no token)`, T, async (t) => {
    const tok = token();
    const r = await runMain(t, { PROMPTCUT_DATA_DIR: tempData(t), PROMPTCUT_CLUSTER_TOKEN: tok, ...env });
    assert.equal(r.code, null, `starts up: ${r.out.slice(-1500)}`);
    const got = await probe(r, tok);
    assert.equal(got.handshake, 101, 'loopback without credentials is still the local identity');
    assert.equal(got.media, 404, 'reading an asset over loopback needs no ticket (this hash does not exist, so it returns 404 rather than 401)');
    assert.equal(got.admin, 200, 'calling the admin API over loopback needs no token');
    assert.equal(got.adminToken, 200);
  });
}

test('HT6-old-name the old name PROMPTCUT_TEST_NO_LOOPBACK_TRUST=1 no longer takes effect: loopback is still trusted', T, async (t) => {
  const tok = token();
  const r = await runMain(t, { PROMPTCUT_DATA_DIR: tempData(t), PROMPTCUT_CLUSTER_TOKEN: tok, PROMPTCUT_TEST_NO_LOOPBACK_TRUST: '1' });
  assert.equal(r.code, null, `starts up: ${r.out.slice(-1500)}`);
  const got = await probe(r, tok);
  assert.deepEqual({ handshake: got.handshake, media: got.media, admin: got.admin }, { handshake: 101, media: 404, admin: 200 });
});

test('HT6-no-token PROMPTCUT_TRUST_LOOPBACK=0 without a cluster token: refuses to start, config.error cluster-token-required, exit code 1', T, async (t) => {
  const r = await runMain(t, { PROMPTCUT_DATA_DIR: tempData(t), PROMPTCUT_TRUST_LOOPBACK: '0' });
  assert.equal(r.code, 1, r.out.slice(-1500));
  assert.equal(configErrorOf(r.out)?.reason, 'cluster-token-required', r.out.slice(-1500));
});

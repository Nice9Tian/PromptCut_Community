/**
 * SP2 令牌的边界（契约 `docs/plan/shared-project-contract.md` 第 5 节、第 7 节 SP2；计划 SP2 的每一条）。
 * 跑：node --test server/test/sp-boundary.test.mjs
 *
 * 进程内起服务（M6a 已集成的 `createSharedDocService`，经 `auth-kit.mjs` 的 hostFor），非回环来源用 `__remote` 改对端地址。
 * 托管端的子进程版本在 `sp-hosted.test.mjs`（SPC2-1、SPC2-2）。
 *
 * 计划 SP2：`page`、`agent`、`render` 三种角色以及独立主机，都不带集群令牌，凭项目凭证进入：成功。凭证错：被拒。
 * 托管端的管理接口不带令牌：401。局域网主机的管理接口从局域网另一台机器访问：连不上；从本机访问，不带令牌：成功。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostFor, createProject, join, joinStatus, proofFor, ask, askOrNull, waitFor, PROTOCOL } from './auth-kit.mjs';
import { randomToken } from './fake-ws-kit.mjs';

const LAN_PEER = '192.168.31.77';
const NET_PEER = '203.0.113.9';
const ROLES = [['page', {}], ['agent', { c: 3 }], ['render', { o: { kind: 'user' } }]];

for (const attached of [false, true]) {
  const where = attached ? 'LAN host' : 'hosted side';
  const peer = attached ? LAN_PEER : NET_PEER;

  test(`SPC2-3 ${where}: the three roles page, agent and render all join successfully from a non-loopback source with project credentials and no cluster token`, async (t) => {
    const env = await hostFor(t, { attached, clusterToken: attached ? undefined : randomToken() });
    const proj = await createProject(env, { mode: 'free' });
    for (const [role, extra] of ROLES) {
      const c = await join(env, proj, { username: `u-${role}`, role, remote: peer, ...extra });
      const p = await waitFor(() => env.principals().find((x) => x?.username === `u-${role}` && x.role === role), 2000, `${role} principal`);
      assert.equal(p.scope, 'member');
      assert.equal(p.tenantId, proj.projectId);
      if (role === 'agent') assert.equal(p.conversation, 3);
      c.close();
    }
  });

  test(`SPC2-4 ${where}: a standalone host (render role, profile host) joins without a token and node.hello succeeds`, async (t) => {
    const env = await hostFor(t, { attached });
    const proj = await createProject(env, { mode: 'free' });
    const n = await join(env, proj, { username: 'rig', role: 'render', remote: peer });
    const w = await ask(n, { type: 'node.hello', nodeId: `sp-host-${attached}`, profile: 'host' }, 'node.welcome');
    assert.equal(w.type, 'node.welcome', JSON.stringify(w));
  });

  test(`SPC2-5 ${where}: wrong credentials are rejected (wrong passphrase, not on the list, proof plus token as two items)`, async (t) => {
    const token = attached ? undefined : randomToken();
    const env = await hostFor(t, { attached, clusterToken: token });
    const free = await createProject(env, { mode: 'free' });
    assert.equal(await joinStatus(env, free, { username: 'eve', password: 'wrong', remote: peer }), 401);
    const restricted = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }] });
    assert.equal(await joinStatus(env, restricted, { username: 'bob', remote: peer }), 101, 'on the list: succeeds');
    assert.equal(await joinStatus(env, restricted, { username: 'zed', password: 'any', remote: peer }), 401, 'not on the list: 401');
    if (token) {
      const p = await proofFor(env, free, { username: 'mallory', remote: peer });
      assert.equal((await env.handshake([...p.protocols, `promptcut.token.${token}`], peer)).status, 401, 'at most one auth item');
    }
  });
}

test('SPC2-6 the hosted side\'s admin endpoint without a token: 401 (when no token is set, any token also gets 401); the correct token from a non-loopback source succeeds', async (t) => {
  const token = randomToken();
  const env = await hostFor(t, { clusterToken: token });
  assert.equal((await env.handshake([PROTOCOL], NET_PEER)).status, 401, 'non-loopback with nothing attached: 401');
  assert.equal((await env.handshake([PROTOCOL, `promptcut.token.${randomToken()}`], NET_PEER)).status, 401, 'wrong token: 401');
  assert.equal((await env.handshake([PROTOCOL, `promptcut.token.${token}`], NET_PEER)).status, 101, 'correct token: 101');
  const admin = await env.open([PROTOCOL, `promptcut.token.${token}`], NET_PEER);
  const r = await ask(admin, { type: 'service.announce', announcerId: 'sp2-asset', kind: 'asset', urls: ['http://203.0.113.9:8788/api/asset'] });
  assert.equal(r.type, 'service.announced', JSON.stringify(r));

  const bare = await hostFor(t, {});
  assert.equal((await bare.handshake([PROTOCOL, `promptcut.token.${token}`], NET_PEER)).status, 401, 'no token set: all admin interfaces return 401');
  assert.equal((await bare.handshake([PROTOCOL, `promptcut.token.${token}`])).status, 401, 'loopback with a token also gets 401 (no token set)');
});

test('SPC2-7 the LAN host\'s admin endpoint: unreachable from another machine on the LAN (401 with or without a token); a member sending service.announce gets forbidden', async (t) => {
  const env = await hostFor(t, { attached: true });
  assert.equal((await env.handshake([PROTOCOL], LAN_PEER)).status, 401, 'LAN source with nothing attached: 401');
  assert.equal((await env.handshake([PROTOCOL, `promptcut.token.${randomToken()}`], LAN_PEER)).status, 401, 'LAN source with a token: 401');
  const proj = await createProject(env, { mode: 'free' });
  const m = await join(env, proj, { username: 'bob', remote: LAN_PEER });
  const r = await askOrNull(m, { type: 'service.announce', announcerId: 'sp2-member', kind: 'asset', urls: ['http://192.168.31.77:1/api/asset'] }, 1500);
  assert.ok(r, 'got a reply');
  assert.equal(r.type, 'error', JSON.stringify(r));
  assert.equal(r.reason ?? r.error, 'forbidden', JSON.stringify(r));
});

test('SPC2-8 the LAN host\'s admin endpoint: access from this machine over loopback succeeds without a token (service.announce / withdraw)', async (t) => {
  const env = await hostFor(t, { attached: true });
  const local = await env.open([PROTOCOL]);
  const p = await waitFor(() => env.principals().find((x) => x?.scope === 'local'), 2000, 'local identity');
  assert.equal(p.userId, 'local');
  const a = await ask(local, { type: 'service.announce', announcerId: 'sp2-local', kind: 'asset', urls: ['http://192.168.31.1:5173/api/asset'] });
  assert.equal(a.type, 'service.announced', JSON.stringify(a));
  const w = await ask(local, { type: 'service.withdraw', announcerId: 'sp2-local', kind: 'asset' });
  assert.notEqual(w.type, 'error', JSON.stringify(w));
});

/**
 * M6a 共享项目：空间隔离、本机声明、集群令牌（契约 `docs/plan/auth-contract.md` 第 5、6、10 节，用例 AU9、AU11）。
 * 跑：node --test server/test/auth-spaces.test.mjs
 *
 * 只照契约写，不看实现。起服务的接口是测试方的假设，集中在 `auth-kit.mjs` 文件头。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  hostFor, createProject, join, proofFor, newDevice, ask, askOrNull, members, waitFor, sleep, PROTOCOL, HOST_DEVICE,
} from './auth-kit.mjs';
import { snapshotTaskInput, randomToken, byType } from './fake-ws-kit.mjs';

const R = (i) => `198.51.100.${i}`;

async function watchAll(c) {
  const w = await ask(c, { type: 'content.watch', kinds: ['card-source', 'event-detail'] }, 'content.watching');
  assert.equal(w.type, 'content.watching', JSON.stringify(w));
  const o = await ask(c, { type: 'project.open', projectId: 'same-project' }, 'project.state');
  assert.equal(o.type, 'project.state', JSON.stringify(o));
  return o;
}

async function write(c, tag) {
  const s = await ask(c, { type: 'content.put', kind: 'card-source', key: 'same-key', body: { tag } }, 'content.stored');
  assert.equal(s.type, 'content.stored', JSON.stringify(s));
  const a = await ask(c, { type: 'project.announce', projectId: 'same-project', digest: createDigest(tag) }, 'project.announced');
  assert.equal(a.type, 'project.announced', JSON.stringify(a));
}

const createDigest = (tag) => Buffer.from(`digest-${tag}-padding-000000`).toString('hex').slice(0, 32);
const pushed = (c, ms = 300) => c.quiet((m) => m.type === 'content.changed' || m.type === 'project.rev', ms);

// ------------------------------------------------------------------ AU9

test('AU9 members of two shared projects each publish, subscribe and write to the content store: the other side receives 0 messages; same-name channels and same-name keys do not leak', async (t) => {
  const env = await hostFor(t);
  const P = await createProject(env, { mode: 'free' });
  const Q = await createProject(env, { mode: 'free' });
  const mp = await join(env, P, { username: 'pam', remote: R(1) });
  const mq = await join(env, Q, { username: 'quinn', remote: R(2) });
  const local = await env.open([PROTOCOL]);
  await watchAll(mp);
  await watchAll(mq);
  await watchAll(local);

  const quietQ = pushed(mq, 400);
  const quietL = pushed(local, 400);
  await write(mp, 'P');
  const gotP = await mp.next((m) => m.type === 'content.changed', 2000);
  assert.equal(gotP.key, 'same-key', 'its own space receives it');
  assert.deepEqual(await quietQ, [], 'the other shared project receives 0 messages');
  assert.deepEqual(await quietL, [], 'local space receives 0 messages');

  const quietP = pushed(mp, 400);
  await write(mq, 'Q');
  assert.deepEqual(await quietP, [], 'the reverse direction also receives 0 messages');

  // 同名键各是各的
  const gp = await ask(mp, { type: 'content.get', kind: 'card-source', key: 'same-key' }, 'content.item');
  const gq = await ask(mq, { type: 'content.get', kind: 'card-source', key: 'same-key' }, 'content.item');
  const gl = await ask(local, { type: 'content.get', kind: 'card-source', key: 'same-key' }, 'content.item');
  assert.deepEqual(gp.body, { tag: 'P' });
  assert.deepEqual(gq.body, { tag: 'Q' });
  assert.equal(gl.missing, true, 'local space cannot see what the shared space wrote');
  assert.equal(gp.rev, 1, 'rev starts from 1 in each');
  assert.equal(gq.rev, 1);
  // 同名项目各自的版本号
  const sp = await ask(mp, { type: 'project.open', projectId: 'same-project' }, 'project.state');
  const sq = await ask(mq, { type: 'project.open', projectId: 'same-project' }, 'project.state');
  assert.equal(sp.projectRev, 1);
  assert.equal(sq.projectRev, 1);
  assert.notEqual(sp.digest, sq.digest);

  // local 写的共享空间也看不到
  await write(local, 'L');
  const gp2 = await ask(mp, { type: 'content.get', kind: 'card-source', key: 'same-key' }, 'content.item');
  assert.deepEqual(gp2.body, { tag: 'P' });
  const lp = await ask(mp, { type: 'content.list', kind: 'card-source' }, 'content.listing');
  assert.deepEqual(lp.items.map((x) => x.key), ['same-key']);
});

test('AU9 storage: the space of a shared project lands under tenants/<projectId>/; the local space keeps using the data directory itself (standalone mode)', async (t) => {
  const env = await hostFor(t);
  const P = await createProject(env, { mode: 'free' });
  const mp = await join(env, P, { username: 'pam', remote: R(3) });
  await write(mp, 'P');
  const dir = path.join(env.dataDir, 'tenants', P.projectId);
  await waitFor(() => fs.existsSync(dir), 2000, `${dir} exists`);
  const local = await env.open([PROTOCOL]);
  await write(local, 'L');
  assert.equal(fs.existsSync(path.join(env.dataDir, 'tenants', 'local')), false, 'local space is not under tenants/');
});

test('AU9 render queue is isolated per space: nodes of another project cannot see or claim', async (t) => {
  const env = await hostFor(t);
  const P = await createProject(env, { mode: 'free' });
  const Q = await createProject(env, { mode: 'free' });
  const pub = await join(env, P, { username: 'pam', remote: R(4) });
  await ask(pub, { type: 'publisher.hello', publisherId: 'pub-same' }, 'publisher.welcome');
  const task = snapshotTaskInput({ resultKey: `rk-au9-${Date.now()}` });
  const r = await ask(pub, { type: 'task.publish', tasks: [task] }, 'task.published');
  assert.equal(r.type, 'task.published', JSON.stringify(r));

  const nodeQ = await join(env, Q, { username: 'quinn', role: 'render', remote: R(5) });
  await ask(nodeQ, { type: 'node.hello', nodeId: 'n-q', profile: 'host' }, 'node.welcome');
  // M6c X3：host 的 watch 'all' 只回摘要；这里要比对快照内容，改 watch 任务所在的项目（原为 'all'）
  const snap = await ask(nodeQ, { type: 'queue.watch', projects: [task.source.projectId] }, 'queue.snapshot');
  assert.equal(snap.type, 'queue.snapshot', JSON.stringify(snap));
  assert.ok(!JSON.stringify(snap).includes(task.id), `the snapshot of another space should not contain this task: ${JSON.stringify(snap).slice(0, 400)}`);
  const claim = await ask(nodeQ, { type: 'task.claim', id: task.id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.deepEqual([claim.type, claim.reason], ['task.claim-rejected', 'gone'], JSON.stringify(claim));

  const local = await env.open([PROTOCOL]);
  await ask(local, { type: 'node.hello', nodeId: 'n-local', profile: 'pc' }, 'node.welcome');
  const lc = await ask(local, { type: 'task.claim', id: task.id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.deepEqual([lc.type, lc.reason], ['task.claim-rejected', 'gone'], `local space: ${JSON.stringify(lc)}`);

  const nodeP = await join(env, P, { username: 'rig', role: 'render', remote: R(6) });
  await ask(nodeP, { type: 'node.hello', nodeId: 'n-p', profile: 'host' }, 'node.welcome');
  const ok = await ask(nodeP, { type: 'task.claim', id: task.id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(ok.type, 'task.claimed', `this space: ${JSON.stringify(ok)}`);
  // 任务的 source 取自连接的 principal
  const d = env.service.describe();
  void d;
});

test('AU9 LAN host: the creator page (local claim) and members land in the same space; a local claim is accepted only on loopback, a nonexistent project returns 401', async (t) => {
  const env = await hostFor(t, { attached: true });
  const P = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }] });
  const claim = [PROTOCOL, `promptcut.tenant.${P.projectId}`];
  const hs = await env.handshake(claim);
  assert.equal(hs.status, 101);
  assert.equal(hs.protocol, PROTOCOL, 'echoes only promptcut.v1');
  const creatorPage = await env.open(claim);
  const creatorRender = await env.open([...claim, 'promptcut.role.render']);
  const pr = await waitFor(() => env.principals().filter((p) => p?.userId === `local@${HOST_DEVICE.deviceId}`), 2000, 'connections made with the local claim');
  await waitFor(() => env.principals().filter((p) => p?.userId === `local@${HOST_DEVICE.deviceId}`).length === 2, 2000, 'two');
  const all = env.principals().filter((p) => p?.userId === `local@${HOST_DEVICE.deviceId}`);
  for (const p of all) {
    assert.equal(p.tenantId, P.projectId);
    assert.equal(p.creator, true);
    assert.equal(p.deviceId, HOST_DEVICE.deviceId);
    assert.equal(p.deviceName, HOST_DEVICE.deviceName);
  }
  assert.deepEqual(all.map((p) => p.role).sort(), ['page', 'render']);
  void pr;

  const bob = await join(env, P, { username: 'bob', remote: '192.168.1.60' });
  await ask(creatorPage, { type: 'content.watch', kinds: ['card-source'] }, 'content.watching');
  await ask(bob, { type: 'content.put', kind: 'card-source', key: 'x', body: 1 }, 'content.stored');
  const ch = await creatorPage.next((m) => m.type === 'content.changed' && m.key === 'x', 2000);
  assert.equal(ch.actor.userId.startsWith('bob@'), true, 'the creator page receives the write of a member');
  const list = await members(bob);
  const hostRow = list.find((d) => d.deviceId === HOST_DEVICE.deviceId);
  assert.ok(hostRow, `member list has the LAN host device: ${JSON.stringify(list)}`);
  assert.equal(hostRow.creator, true);
  assert.deepEqual(hostRow.tags.editing, true);
  void creatorRender;

  assert.equal((await env.handshake(claim, '192.168.1.61')).status, 401, 'local claim from a non-loopback source returns 401');
  assert.equal((await env.handshake([PROTOCOL, 'promptcut.tenant.sp_aaaaaaaaaaaaaaaaaaaaaaaaaa'])).status, 401, 'nonexistent project returns 401');
  assert.equal((await env.handshake([PROTOCOL, `promptcut.tenant.${P.projectId}`, 'promptcut.role.admin'])).status, 401, 'unknown role');
});

// ------------------------------------------------------------------ AU11

/** 管理身份发这些数据面消息，一律 forbidden */
const DATA_PLANE = [
  { type: 'node.hello', nodeId: 'n-admin', profile: 'host' },
  { type: 'publisher.hello', publisherId: 'pub-admin' },
  { type: 'queue.watch', projects: 'all' },
  { type: 'task.publish', tasks: [snapshotTaskInput({ resultKey: 'rk-admin' })] },
  { type: 'task.claim', id: 'x', expectVersion: 1 },
  { type: 'task.unsubscribe', ids: ['x'] },
  { type: 'card.lock', kind: 'bogus' },
  { type: 'project.open', projectId: 'p' },
  { type: 'project.announce', projectId: 'p', digest: '0123456789abcdef' },
  { type: 'project.snapshot.get', projectId: 'p', projectRev: 1 },
  { type: 'content.put', kind: 'card-source', key: 'k', body: 1 },
  { type: 'content.get', kind: 'card-source', key: 'k' },
  { type: 'content.list', kind: 'card-source' },
  { type: 'content.watch', kinds: ['card-source'] },
  { type: 'shared.members' },
  { type: 'shared.watch' },
  { type: 'shared.challenge' },
  { type: 'auth.ticket', kind: 'asset', access: 'r' },
];

test('AU11 cluster token: a connection with the token is an admin identity; sending any data-plane message returns forbidden; service.announce succeeds', async (t) => {
  const token = randomToken();
  const env = await hostFor(t, { clusterToken: token });
  const admin = await env.open([PROTOCOL, `promptcut.token.${token}`], '203.0.113.50');
  const pr = await waitFor(() => env.principals().find((p) => p?.userId === 'admin'), 2000, 'admin identity');
  assert.equal(pr.tenantId, null);
  assert.equal(pr.scope, 'admin');
  for (const msg of DATA_PLANE) {
    const r = await askOrNull(admin, msg, 1500);
    assert.ok(r, `${msg.type}: no reply`);
    assert.deepEqual([r.type, r.reason], ['error', 'forbidden'], `${msg.type}: ${JSON.stringify(r)}`);
  }
  const a = await ask(admin, { type: 'service.announce', announcerId: 'asset-1', kind: 'asset', urls: ['http://203.0.113.50:9000/'] }, 'service.announced');
  assert.equal(a.type, 'service.announced', JSON.stringify(a));
  const w = await ask(admin, { type: 'service.watch' }, 'service.endpoints');
  assert.equal(w.type, 'service.endpoints', JSON.stringify(w));

  // 成员：service.announce 回 forbidden；service.watch 能看到管理身份登记的地址
  const P = await createProject(env, { mode: 'free' });
  const m = await join(env, P, { username: 'zoe', remote: R(20) });
  const ma = await ask(m, { type: 'service.announce', announcerId: 'x', kind: 'asset', urls: ['http://10.0.0.2:1/'] }, 'service.announced');
  assert.deepEqual([ma.type, ma.reason], ['error', 'forbidden'], JSON.stringify(ma));
  const mw = await ask(m, { type: 'service.watch' }, 'service.endpoints');
  assert.equal(mw.type, 'service.endpoints');
  assert.ok(JSON.stringify(mw.endpoints).includes('203.0.113.50:9000'), `member can see the registered address: ${JSON.stringify(mw)}`);
  const mwd = await ask(m, { type: 'service.withdraw', announcerId: 'asset-1', kind: 'asset' }, 'service.withdrawn');
  assert.deepEqual([mwd.type, mwd.reason], ['error', 'forbidden'], `member withdraws: ${JSON.stringify(mwd)}`);

  // local 身份也能登记
  const local = await env.open([PROTOCOL]);
  const la = await ask(local, { type: 'service.announce', announcerId: 'asset-local', kind: 'asset', urls: ['http://127.0.0.1:9001/'] }, 'service.announced');
  assert.equal(la.type, 'service.announced', JSON.stringify(la));
  const wd = await ask(admin, { type: 'service.withdraw', announcerId: 'asset-1', kind: 'asset' }, 'service.withdrawn');
  assert.equal(wd.type, 'service.withdrawn', JSON.stringify(wd));
});

test('AU11 cluster token: wrong token returns 401; token + proof returns 401; in standalone mode with no token set, a handshake with a token returns 401', async (t) => {
  const token = randomToken();
  const env = await hostFor(t, { clusterToken: token });
  assert.equal((await env.handshake([PROTOCOL, `promptcut.token.${randomToken()}`], R(30))).status, 401, 'wrong token');
  const P = await createProject(env, { mode: 'free' });
  const p = await proofFor(env, P, { username: 'zoe', remote: R(31) });
  assert.equal((await env.handshake([...p.protocols, `promptcut.token.${token}`], R(31))).status, 401, 'token + proof');
  assert.equal((await env.handshake([PROTOCOL, `promptcut.token.${token}`, `promptcut.token.${token}`], R(32))).status, 401, 'two token items');

  const bare = await hostFor(t);
  assert.equal((await bare.handshake([PROTOCOL, `promptcut.token.${token}`], R(33))).status, 401, 'no token set: all admin interfaces return 401');
  assert.equal((await bare.handshake([PROTOCOL, `promptcut.token.${token}`])).status, 401, 'no token set: loopback with a token also returns 401');
});

test('AU11 mounted mode: a handshake from a non-loopback source with a cluster token returns 401 (the cluster token is never accepted in mounted mode)', async (t) => {
  const token = randomToken();
  const prev = process.env.PROMPTCUT_CLUSTER_TOKEN;
  process.env.PROMPTCUT_CLUSTER_TOKEN = token;
  t.after(() => { if (prev === undefined) delete process.env.PROMPTCUT_CLUSTER_TOKEN; else process.env.PROMPTCUT_CLUSTER_TOKEN = prev; });
  const env = await hostFor(t, { attached: true });
  for (const remote of ['192.168.1.70', '10.1.2.3', '203.0.113.9']) {
    assert.equal((await env.handshake([PROTOCOL, `promptcut.token.${token}`], remote)).status, 401, remote);
  }
  // 回环来源不带任何东西仍是本机身份，可登记地址
  const local = await env.open([PROTOCOL]);
  const la = await ask(local, { type: 'service.announce', announcerId: 'lan-asset', kind: 'asset', urls: ['http://192.168.1.10:5190/'] }, 'service.announced');
  assert.equal(la.type, 'service.announced', JSON.stringify(la));
  await sleep(10);
  void byType;
});

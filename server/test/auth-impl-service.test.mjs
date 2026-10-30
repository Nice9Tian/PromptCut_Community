/**
 * 带共享项目的文档服务，真端口（0）跑（实现方自测；契约 `docs/plan/auth-contract.md` 第 4～10 节）：
 * HTTP 端点、空间隔离、成员列表、创建者操作、票据、角色限制、管理接口限制、挂载模式。
 * 跑：node --test server/test/auth-impl-service.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startSharedService, createProject, join, deviceId as newDeviceId, FAST_KDF } from './fake-shared-env.mjs';
import { wsClient, byReq, byType, waitFor, rawHandshake, randomToken } from './fake-ws-kit.mjs';
import { deriveKey, adminProof, makeCredential, ticketProtocols, httpBaseOf, lookupProject, requestChallenge } from '../auth/client.mjs';
import { createAssetTicketVerifier } from '../auth/asset-tickets.mjs';

const post = (base, route, body, headers = {}) => fetch(`${httpBaseOf(base)}/shared/${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const cred = () => ({ salt: crypto.randomBytes(16).toString('base64url'), key: crypto.randomBytes(32).toString('base64url') });
const createBody = (name, extra = {}) => ({ name, mode: 'free', kdf: FAST_KDF, creator: { username: 'alice', ...cred() }, project: cred(), ...extra });

/** 在一条连接上做一次创建者操作：取挑战、按口令派生 K、算证明 */
async function adminOp(c, { projectId, creator = 'alice', password = 'creator-pw', op, fields = {}, reqId = `adm-${op}-${Math.random()}` }) {
  c.send({ type: 'shared.challenge', reqId: `${reqId}-ch` });
  const ch = await c.next(byReq(`${reqId}-ch`));
  assert.equal(ch.type, 'shared.challenge.ok', JSON.stringify(ch));
  const key = await deriveKey(password, ch.salt, ch.kdf);
  const m = await adminProof({ key, projectId, username: creator, op, nonce: ch.nonce });
  c.send({ type: 'shared.admin', reqId, op, proof: { nonce: ch.nonce, m }, ...fields });
  return c.next(byReq(reqId), 4000);
}

test('HTTP：create 两种模式、409 同名（大小写 / NFC）、400、lookup、challenge 的真盐与伪盐、404、预检、413、no-store', async (t) => {
  const s = await startSharedService({ mode: 'hosted' });
  t.after(() => s.close());
  const r1 = await post(s.base, 'create', createBody('Café'));
  assert.equal(r1.status, 201);
  assert.equal(r1.headers.get('cache-control'), 'no-store');
  assert.equal(r1.headers.get('access-control-allow-origin'), '*');
  const p1 = await r1.json();
  assert.equal(p1.ok, true);
  assert.equal(p1.mode, 'free');
  assert.equal((await post(s.base, 'create', createBody('CAFÉ'))).status, 409);
  const r2 = await post(s.base, 'create', { ...createBody('R'), mode: 'restricted', project: undefined, list: [{ username: 'bob', ...cred() }] });
  assert.equal(r2.status, 201);
  const p2 = await r2.json();
  for (const bad of [{}, { ...createBody('x'), kdf: { alg: 'pbkdf2-sha256', iter: 1 } }, { ...createBody('x'), project: undefined }, { ...createBody('x'), name: 'a/b' },
    { ...createBody('x'), creator: { username: 'alice', salt: 'x', key: 'y' } }, { ...createBody('x'), mode: 'restricted' }]) {
    const r = await post(s.base, 'create', bad);
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 80));
    assert.deepEqual(await r.json(), { ok: false, error: 'bad-request' });
  }
  assert.equal((await post(s.base, 'create', '{not json')).status, 400);
  assert.equal((await post(s.base, 'create', 'x'.repeat(70 * 1024))).status, 413);

  assert.deepEqual(await lookupProject({ base: s.base, name: 'café' }), { projectId: p1.projectId, name: 'Café', mode: 'free' });
  const miss = await fetch(`${httpBaseOf(s.base)}/shared/lookup?name=nope`);
  assert.equal(miss.status, 404);
  assert.deepEqual(await miss.json(), { ok: false, error: 'no-project' });

  const ch = await requestChallenge({ base: s.base, projectId: p2.projectId, username: 'bob', deviceId: newDeviceId('c') });
  assert.equal(Buffer.from(ch.nonce, 'base64url').length, 32);
  assert.equal(ch.salt, s.store.peek(p2.projectId).list[0].salt, '名单内：名单这一条的盐');
  const f1 = await requestChallenge({ base: s.base, projectId: p2.projectId, username: 'mallory', deviceId: newDeviceId('c') });
  const f2 = await requestChallenge({ base: s.base, projectId: p2.projectId, username: 'mallory', deviceId: newDeviceId('c') });
  assert.equal(f1.salt, f2.salt, '伪盐：同一用户名每次一样');
  assert.equal(Buffer.from(f1.salt, 'base64url').length, 16, '形状与真盐相同');
  assert.deepEqual(Object.keys(f1).sort(), Object.keys(ch).sort());
  const fc = await requestChallenge({ base: s.base, projectId: p1.projectId, username: 'bob', deviceId: newDeviceId('c'), as: 'creator' });
  assert.notEqual(fc.salt, s.store.peek(p1.projectId).creator.salt, '不是创建者：伪盐');
  assert.equal((await post(s.base, 'challenge', { projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', username: 'u', deviceId: newDeviceId('c'), as: 'member' })).status, 404);
  assert.equal((await post(s.base, 'challenge', { projectId: p1.projectId, username: 'u', deviceId: 'short', as: 'member' })).status, 400);

  const pre = await fetch(`${httpBaseOf(s.base)}/shared/create`, { method: 'OPTIONS', headers: { Origin: 'http://192.168.1.5:5190', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-headers'), /content-type/i);
});

test('HTTP：托管端同一来源每小时 10 个，第 11 次 429；整台服务上限；挑战在冷却期回 429', async (t) => {
  const s = await startSharedService({ mode: 'hosted', limits: { maxProjects: 12 } });
  t.after(() => s.close());
  for (let i = 0; i < 10; i++) assert.equal((await post(s.base, 'create', createBody(`n${i}`))).status, 201);
  const r = await post(s.base, 'create', createBody('n10'));
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { ok: false, error: 'rate-limited' });

  const s2 = await startSharedService({ mode: 'hosted', limits: { maxProjects: 2 } });
  t.after(() => s2.close());
  assert.equal((await post(s2.base, 'create', createBody('a'))).status, 201);
  assert.equal((await post(s2.base, 'create', createBody('b'))).status, 201);
  assert.equal((await post(s2.base, 'create', createBody('c'))).status, 429, '整台服务到上限');

  // 冷却：错 5 次之后挑战回 429
  const s3 = await startSharedService({ mode: 'hosted' });
  t.after(() => s3.close());
  const p = await createProject(s3.base, { password: 'right' });
  const dev = newDeviceId('rl');
  for (let i = 0; i < 5; i++) {
    const c = await join(s3.base, { projectId: p.projectId, username: 'bob', deviceId: dev, password: 'wrong' });
    await assert.rejects(c.opened);
  }
  const blocked = await post(s3.base, 'challenge', { projectId: p.projectId, username: 'bob', deviceId: dev, as: 'member' });
  assert.equal(blocked.status, 429);
});

test('挂载模式（局域网主机）：共享端点在 /docservice/shared/ 下；非回环建项目 403、回环 201；集群令牌一律不认', async (t) => {
  let loop = false;
  const token = randomToken();
  const s = await startSharedService({ mode: 'lan', isLoopback: () => loop, clusterToken: token });
  t.after(() => s.close());
  assert.equal(s.sharedPrefix, '/docservice/shared/');
  const r = await post(s.base, 'create', createBody('lan'));
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { ok: false, error: 'forbidden' });
  loop = true;
  assert.equal((await post(s.base, 'create', createBody('lan'))).status, 201);
  const hs = await rawHandshake(s.port, { protocols: ['promptcut.v1', `promptcut.token.${token}`], path: '/docservice' });
  hs.sock.destroy();
  assert.equal(hs.status, 401, '挂载模式不认令牌（回环也一样）');
  const local = await rawHandshake(s.port, { protocols: ['promptcut.v1'], path: '/docservice' });
  local.sock.destroy();
  assert.equal(local.status, 101, '回环什么都不带：本机身份');
  loop = false;
  const remote = await rawHandshake(s.port, { protocols: ['promptcut.v1'], path: '/docservice' });
  remote.sock.destroy();
  assert.equal(remote.status, 401, '局域网来的什么都不带：401');
  assert.equal(remote.rawHead.includes('no-credential'), false, '响应里不说原因');
});

test('空间隔离：两个项目的成员与本机空间，频道名相同也不串；存储在 tenants/<projectId>/ 下，local 沿用数据目录', async (t) => {
  let loop = false;
  const s = await startSharedService({ mode: 'hosted', isLoopback: () => loop });
  t.after(() => s.close());
  const a = await createProject(s.base, { password: 'pa' });
  const b = await createProject(s.base, { password: 'pb' });
  const ca = await join(s.base, { projectId: a.projectId, username: 'u', deviceId: newDeviceId('ia'), password: 'pa' });
  const cb = await join(s.base, { projectId: b.projectId, username: 'u', deviceId: newDeviceId('ib'), password: 'pb' });
  loop = true;
  const cl = wsClient(s.url, ['promptcut.v1']);
  t.after(() => { ca.close(); cb.close(); cl.close(); });
  await Promise.all([ca.opened, cb.opened, cl.opened]);
  for (const c of [ca, cb, cl]) {
    c.send({ type: 'content.watch', reqId: 'w', kinds: ['card-source'] });
    await c.next(byReq('w'));
    c.send({ type: 'project.open', reqId: 'o', projectId: 'same-id' });
    await c.next(byReq('o'));
  }
  ca.send({ type: 'content.put', reqId: 'p', kind: 'card-source', key: 'k', body: { from: 'a' } });
  await ca.next(byReq('p'));
  ca.send({ type: 'project.announce', reqId: 'an', projectId: 'same-id', digest: 'a'.repeat(64) });
  const ann = await ca.next(byReq('an'));
  assert.equal(ann.projectRev, 1);
  await ca.next(byType('content.changed'));
  assert.deepEqual(await cb.quiet(() => true, 200), [], 'b 收到 0 条');
  assert.deepEqual(await cl.quiet(() => true, 50), [], '本机空间收到 0 条');
  cb.send({ type: 'content.get', reqId: 'g', kind: 'card-source', key: 'k' });
  assert.equal((await cb.next(byReq('g'))).missing, true, 'b 看不到 a 的内容');
  cl.send({ type: 'project.announce', reqId: 'an2', projectId: 'same-id', digest: 'b'.repeat(64) });
  assert.equal((await cl.next(byReq('an2'))).projectRev, 1, '本机空间自己从 1 起');

  const dir = s.dir;
  assert.ok(fs.existsSync(path.join(dir, 'tenants', a.projectId, 'content')), '共享空间的存储');
  assert.ok(fs.existsSync(path.join(dir, 'projects')), 'local 空间沿用数据目录');
  assert.equal(fs.existsSync(path.join(dir, 'tenants', b.projectId, 'content')), false);
  const channels = Object.keys(s.service.describe().channels);
  assert.ok(channels.includes(`content:@${a.projectId}/card-source`), channels.join(','));
  assert.ok(channels.includes('content:card-source'), 'local 频道名不变');
});

test('成员列表：按用户名 + 设备聚合，同名不同设备都带设备名；一台走后恢复；watch 收到变化；标签', async (t) => {
  const s = await startSharedService({ mode: 'hosted' });
  t.after(() => s.close());
  const p = await createProject(s.base, { password: 'pw' });
  const d1 = newDeviceId('m1');
  const d2 = newDeviceId('m2');
  const page1 = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: d1, deviceName: 'Bob-A', password: 'pw' });
  await page1.opened;
  page1.send({ type: 'shared.watch', reqId: 'w' });
  const first = await page1.next(byReq('w'));
  assert.equal(first.devices.length, 1);
  assert.equal(first.devices[0].displayName, 'bob');
  const render1 = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: d1, deviceName: 'Bob-A', password: 'pw', role: 'render' });
  const agent1 = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: d1, deviceName: 'Bob-A', password: 'pw', role: 'agent', conversation: 2 });
  const page2 = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: d2, deviceName: 'Bob-B', password: 'pw' });
  t.after(() => { page1.close(); render1.close(); agent1.close(); page2.close(); });
  await Promise.all([render1.opened, agent1.opened, page2.opened]);
  const list = await waitFor(async () => {
    page1.send({ type: 'shared.members', reqId: `m${Math.random()}` });
    const r = await page1.next(byType('shared.members.list'));
    return r.devices.length === 2 && r.devices.find((d) => d.deviceId === d1)?.conns.length === 3 ? r : null;
  }, 3000, '两台设备');
  const row1 = list.devices.find((d) => d.deviceId === d1);
  assert.equal(row1.displayName, 'bob (Bob-A)');
  assert.equal(list.devices.find((d) => d.deviceId === d2).displayName, 'bob (Bob-B)');
  assert.deepEqual(row1.tags, { editing: true, rendering: false, agents: 1 });
  assert.deepEqual(row1.conns.map((c) => c.role).sort(), ['agent', 'page', 'render']);
  assert.deepEqual(row1.conns.find((c) => c.role === 'agent'), { role: 'agent', conversation: 2 });
  assert.equal(row1.creator, false);
  assert.notEqual(s.store.peek(p.projectId).creator.username, 'bob');
  page2.close();
  await waitFor(() => page1.all.some((m) => m.type === 'shared.members.list' && m.devices.length === 1 && m.devices[0].displayName === 'bob'), 3000, '走了一台，恢复成只显示用户名');
});

test('角色：page 发 node.hello 回 forbidden、render 可以；agent 的写入 actor 带对话号；成员不能登记服务地址但能订阅', async (t) => {
  const s = await startSharedService({ mode: 'hosted' });
  t.after(() => s.close());
  const p = await createProject(s.base, { password: 'pw' });
  const dev = newDeviceId('r');
  const page = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: dev, password: 'pw' });
  const render = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: dev, password: 'pw', role: 'render' });
  const agent = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: dev, password: 'pw', role: 'agent', conversation: 7 });
  t.after(() => { page.close(); render.close(); agent.close(); });
  await Promise.all([page.opened, render.opened, agent.opened]);
  page.send({ type: 'node.hello', reqId: 'h', nodeId: 'n1', profile: 'pc' });
  assert.equal((await page.next(byReq('h'))).reason, 'forbidden');
  render.send({ type: 'node.hello', reqId: 'h', nodeId: 'n2', profile: 'pc' });
  assert.equal((await render.next(byReq('h'))).type, 'node.welcome');
  agent.send({ type: 'content.put', reqId: 'c', kind: 'card-source', key: 'x', body: 1, session: 's1' });
  await agent.next(byReq('c'));
  page.send({ type: 'content.watch', reqId: 'w', kinds: ['card-source'] });
  await page.next(byReq('w'));
  page.send({ type: 'content.put', reqId: 'c2', kind: 'card-source', key: 'x', body: 2 });
  const changed = await page.next(byType('content.changed'));
  assert.deepEqual(changed.previousActor, { userId: `bob@${dev}`, deviceId: dev, role: 'agent', conversation: 7, session: 's1' });
  assert.deepEqual(changed.actor, { userId: `bob@${dev}`, deviceId: dev, role: 'page', conversation: null, session: null });
  page.send({ type: 'service.announce', reqId: 'a', announcerId: 'asset:x', kind: 'asset', urls: ['http://10.0.0.1:1/api/asset'] });
  assert.equal((await page.next(byReq('a'))).reason, 'forbidden');
  page.send({ type: 'service.watch', reqId: 'sw', kinds: 'all' });
  assert.equal((await page.next(byReq('sw'))).type, 'service.endpoints');
});

test('票据：连接票据让另一条连接以同一身份、render 角色进入；本机身份要不到票据；素材票据能被同一存储核对', async (t) => {
  let loop = false;
  const s = await startSharedService({ mode: 'hosted', isLoopback: () => loop });
  t.after(() => s.close());
  const p = await createProject(s.base, { password: 'pw' });
  const dev = newDeviceId('tk');
  const page = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: dev, deviceName: 'Bob-PC', password: 'pw' });
  t.after(() => page.close());
  await page.opened;
  page.send({ type: 'auth.ticket', reqId: 't', kind: 'conn', role: 'render', owner: { kind: 'agent', c: 3 } });
  const ok = await page.next(byReq('t'));
  assert.equal(ok.type, 'auth.ticket.ok');
  assert.ok(ok.exp - Date.now() <= 2 * 60_000 + 1000);
  const second = wsClient(s.url, ticketProtocols(ok.ticket));
  t.after(() => second.close());
  await second.opened;
  const conn = await waitFor(() => s.service.describe().conns.find((c) => c.principal.role === 'render'), 2000, 'render 连接');
  assert.deepEqual(conn.principal, {
    userId: `bob@${dev}`, tenantId: p.projectId, scope: 'member', username: 'bob', deviceId: dev, deviceName: 'Bob-PC',
    creator: false, role: 'render', conversation: null, owner: { kind: 'agent', c: 3 },
  });
  for (const bad of [{ kind: 'conn', role: 'agent' }, { kind: 'conn', role: 'page', owner: { kind: 'user' } }, { kind: 'x' }, { kind: 'asset', access: 'w' }]) {
    page.send({ type: 'auth.ticket', reqId: 'b', ...bad });
    assert.equal((await page.next(byReq('b'))).reason, 'bad-message', JSON.stringify(bad));
  }
  page.send({ type: 'auth.ticket', reqId: 'a', kind: 'asset', access: 'r' });
  const asset = await page.next(byReq('a'));
  const verifier = createAssetTicketVerifier({ store: s.store });
  assert.deepEqual(verifier.verify(asset.ticket), { ok: true, access: 'r', projectId: p.projectId, userId: `bob@${dev}` });
  assert.equal(verifier.verify(ok.ticket).ok, false, '连接票据不能当素材票据');
  loop = true;
  const local = wsClient(s.url, ['promptcut.v1']);
  t.after(() => local.close());
  await local.opened;
  local.send({ type: 'auth.ticket', reqId: 'l', kind: 'asset' });
  assert.equal((await local.next(byReq('l'))).reason, 'forbidden', '本机 local 身份要不到票据');
});

test('创建者操作：不带证明、证明错、非创建者口令一律 forbidden 并计限速；五种 op 带证明都生效', async (t) => {
  const s = await startSharedService({ mode: 'hosted' });
  t.after(() => s.close());
  const p = await createProject(s.base, { password: 'pw' });
  const devBob = newDeviceId('ab');
  const bob = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: devBob, password: 'pw' });
  const alice = await join(s.base, { projectId: p.projectId, username: 'alice', deviceId: newDeviceId('aa'), password: 'creator-pw', as: 'creator' });
  t.after(() => { bob.close(); alice.close(); });
  await Promise.all([bob.opened, alice.opened]);

  bob.send({ type: 'shared.admin', reqId: 'x', op: 'delete' });
  assert.equal((await bob.next(byReq('x'))).reason, 'forbidden', '不带证明');
  assert.equal((await adminOp(bob, { projectId: p.projectId, op: 'kick', password: 'pw', fields: { username: 'x', deviceId: newDeviceId('z') } })).reason, 'forbidden', '拿项目口令冒充');
  bob.send({ type: 'shared.challenge', reqId: 'c' });
  const ch = await bob.next(byReq('c'));
  bob.send({ type: 'shared.admin', reqId: 'y', op: 'delete', proof: { nonce: ch.nonce, m: crypto.randomBytes(32).toString('base64url') } });
  assert.equal((await bob.next(byReq('y'))).reason, 'forbidden', '证明错');
  // 证明对，但 nonce 是别的连接取的：不认
  alice.send({ type: 'shared.challenge', reqId: 'c2' });
  const ch2 = await alice.next(byReq('c2'));
  const key = await deriveKey('creator-pw', ch2.salt, ch2.kdf);
  bob.send({ type: 'shared.admin', reqId: 'z', op: 'unban', username: 'q', deviceId: newDeviceId('q'), proof: { nonce: ch2.nonce, m: await adminProof({ key, projectId: p.projectId, username: 'alice', op: 'unban', nonce: ch2.nonce }) } });
  assert.equal((await bob.next(byReq('z'))).reason, 'forbidden', 'nonce 须由同一连接取');

  // 知道创建者口令的普通成员：证明对就成功（特权绑口令，不绑连接的身份）
  const gen = s.store.peek(p.projectId).generation;
  const np = await makeCredential('pw2', FAST_KDF);
  assert.equal((await adminOp(bob, { projectId: p.projectId, op: 'set-password', fields: { project: np } })).type, 'shared.admin.ok');
  assert.equal(s.store.peek(p.projectId).generation, gen + 1);
  assert.equal(bob.ws.readyState, WebSocket.OPEN, '改口令时在线连接不断');
  const bad = await join(s.base, { projectId: p.projectId, username: 'carol', deviceId: newDeviceId('ac'), password: 'pw' }).catch((e) => e);
  await assert.rejects(bad.opened, '旧口令进不来');
  const good = await join(s.base, { projectId: p.projectId, username: 'carol', deviceId: newDeviceId('ac'), password: 'pw2' });
  await good.opened;
  good.close();
  assert.equal((await adminOp(alice, { projectId: p.projectId, op: 'set-list', fields: { list: [] } })).reason, 'bad-message', '自由进入没有名单');

  // kick：连接以 4003 关闭、票据立即失效、再进 401；unban 后能进
  bob.send({ type: 'auth.ticket', reqId: 'at', kind: 'asset', access: 'rw' });
  const bobTicket = (await bob.next(byReq('at'))).ticket;
  const verifier = createAssetTicketVerifier({ store: s.store });
  assert.equal(verifier.verify(bobTicket).ok, true);
  assert.equal((await adminOp(alice, { projectId: p.projectId, op: 'kick', fields: { username: 'bob', deviceId: devBob } })).type, 'shared.admin.ok');
  const closed = await bob.closed;
  assert.equal(closed.code, 4003);
  assert.equal(closed.reason, 'kicked');
  assert.equal(verifier.verify(bobTicket).ok, false, '被踢者的票据立即失效');
  const again = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: devBob, password: 'pw2' });
  await assert.rejects(again.opened, '禁入表');
  assert.equal((await adminOp(alice, { projectId: p.projectId, op: 'unban', fields: { username: 'bob', deviceId: devBob } })).type, 'shared.admin.ok');
  const back = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: devBob, password: 'pw2' });
  await back.opened;
  back.close();

  // delete：全空间 4004、记录与数据删掉、名字释放
  alice.send({ type: 'content.put', reqId: 'cp', kind: 'card-source', key: 'k', body: 1 });
  await alice.next(byReq('cp'));
  const tenantDir = path.join(s.dir, 'tenants', p.projectId);
  assert.ok(fs.existsSync(tenantDir));
  const watcher = await join(s.base, { projectId: p.projectId, username: 'dave', deviceId: newDeviceId('ad'), password: 'pw2' });
  await watcher.opened;
  assert.equal((await adminOp(alice, { projectId: p.projectId, op: 'delete' })).type, 'shared.admin.ok');
  assert.equal((await watcher.closed).code, 4004);
  assert.equal((await alice.closed).code, 4004);
  assert.equal(s.store.peek(p.projectId), null);
  await waitFor(() => !fs.existsSync(tenantDir), 2000, '空间数据删掉');
  const lk = await fetch(`${httpBaseOf(s.base)}/shared/lookup?name=${encodeURIComponent(p.name)}`);
  assert.equal(lk.status, 404, '名字释放');
});

test('创建者操作：限定进入的 set-list 移出某人——他的连接以 4003 removed 关闭，再进 401；创建者不受影响', async (t) => {
  const s = await startSharedService({ mode: 'hosted' });
  t.after(() => s.close());
  const p = await createProject(s.base, { mode: 'restricted', list: [{ username: 'bob', password: 'bpw' }, { username: 'carol', password: 'cpw' }] });
  const devBob = newDeviceId('sb');
  const bob = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: devBob, password: 'bpw' });
  const carol = await join(s.base, { projectId: p.projectId, username: 'carol', deviceId: newDeviceId('sc'), password: 'cpw' });
  const alice = await join(s.base, { projectId: p.projectId, username: 'alice', deviceId: newDeviceId('sa'), password: 'creator-pw' });
  t.after(() => { bob.close(); carol.close(); alice.close(); });
  await Promise.all([bob.opened, carol.opened, alice.opened]);
  const keepCarol = { username: 'carol', ...s.store.peek(p.projectId).list.find((e) => e.username === 'carol') };
  const t0 = Date.now();
  assert.equal((await adminOp(alice, { projectId: p.projectId, op: 'set-list', fields: { list: [{ username: 'carol', salt: keepCarol.salt, key: keepCarol.key }] } })).type, 'shared.admin.ok');
  const closed = await bob.closed;
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual([closed.code, closed.reason], [4003, 'removed']);
  assert.equal(carol.ws.readyState, WebSocket.OPEN);
  assert.equal(alice.ws.readyState, WebSocket.OPEN);
  const again = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: devBob, password: 'bpw' });
  await assert.rejects(again.opened);
  assert.equal((await adminOp(alice, { projectId: p.projectId, op: 'set-password', fields: { project: await makeCredential('x', FAST_KDF) } })).reason, 'bad-message', '限定进入没有项目口令');
  // 冷却：同一来源（测试里都是同一个地址）上面 bob 名单外的一次握手算一次失败，再错 4 次创建者证明就进冷却，
  // 之后取挑战回 rate-limited
  for (let i = 0; i < 4; i++) assert.equal((await adminOp(carol, { projectId: p.projectId, op: 'unban', password: 'nope', fields: { username: 'q', deviceId: newDeviceId('q') } })).reason, 'forbidden');
  carol.send({ type: 'shared.challenge', reqId: 'cool' });
  assert.equal((await carol.next(byReq('cool'))).reason, 'rate-limited');
});

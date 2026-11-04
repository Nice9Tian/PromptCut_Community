/**
 * Document service with shared projects, running on real port (0) (implementer self-test;
 * contract `docs/plan/auth-contract.md` sections 4-10):
 * HTTP endpoints, space isolation, member list, creator operations, tickets, role restrictions,
 * admin interface restrictions, attached mode.
 * Run: node --test server/test/auth-impl-service.test.mjs
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

/** Perform a creator operation on a connection: fetch challenge, derive K from passphrase, compute proof */
async function adminOp(c, { projectId, creator = 'alice', password = 'creator-pw', op, fields = {}, reqId = `adm-${op}-${Math.random()}` }) {
  c.send({ type: 'shared.challenge', reqId: `${reqId}-ch` });
  const ch = await c.next(byReq(`${reqId}-ch`));
  assert.equal(ch.type, 'shared.challenge.ok', JSON.stringify(ch));
  const key = await deriveKey(password, ch.salt, ch.kdf);
  const m = await adminProof({ key, projectId, username: creator, op, nonce: ch.nonce });
  c.send({ type: 'shared.admin', reqId, op, proof: { nonce: ch.nonce, m }, ...fields });
  return c.next(byReq(reqId), 4000);
}

test('HTTP: create in both modes, 409 for the same name (case / NFC), 400, lookup, real salt and fake salt in challenge, 404, preflight, 413, no-store', async (t) => {
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
  assert.equal(ch.salt, s.store.peek(p2.projectId).list[0].salt, 'on the list: the salt of that list entry');
  const f1 = await requestChallenge({ base: s.base, projectId: p2.projectId, username: 'mallory', deviceId: newDeviceId('c') });
  const f2 = await requestChallenge({ base: s.base, projectId: p2.projectId, username: 'mallory', deviceId: newDeviceId('c') });
  assert.equal(f1.salt, f2.salt, 'fake salt: the same for the same username every time');
  assert.equal(Buffer.from(f1.salt, 'base64url').length, 16, 'same shape as a real salt');
  assert.deepEqual(Object.keys(f1).sort(), Object.keys(ch).sort());
  const fc = await requestChallenge({ base: s.base, projectId: p1.projectId, username: 'bob', deviceId: newDeviceId('c'), as: 'creator' });
  assert.notEqual(fc.salt, s.store.peek(p1.projectId).creator.salt, 'not the creator: fake salt');
  assert.equal((await post(s.base, 'challenge', { projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', username: 'u', deviceId: newDeviceId('c'), as: 'member' })).status, 404);
  assert.equal((await post(s.base, 'challenge', { projectId: p1.projectId, username: 'u', deviceId: 'short', as: 'member' })).status, 400);

  const pre = await fetch(`${httpBaseOf(s.base)}/shared/create`, { method: 'OPTIONS', headers: { Origin: 'http://192.168.1.5:5190', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-headers'), /content-type/i);
});

test('HTTP: hosted side allows 10 per hour from the same source, the 11th returns 429; service-wide cap; challenge returns 429 during the cooldown period', async (t) => {
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
  assert.equal((await post(s2.base, 'create', createBody('c'))).status, 429, 'the whole service reaches the cap');

  // Cooldown: challenge returns 429 after 5 failures
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

test('mounted mode (LAN host): shared endpoints are under /docservice/shared/; creating a project returns 403 from non-loopback and 201 from loopback; the cluster token is never accepted', async (t) => {
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
  assert.equal(hs.status, 401, 'mounted mode does not accept tokens (same for loopback)');
  const local = await rawHandshake(s.port, { protocols: ['promptcut.v1'], path: '/docservice' });
  local.sock.destroy();
  assert.equal(local.status, 101, 'loopback with nothing: local identity');
  loop = false;
  const remote = await rawHandshake(s.port, { protocols: ['promptcut.v1'], path: '/docservice' });
  remote.sock.destroy();
  assert.equal(remote.status, 401, 'from the LAN with nothing: 401');
  assert.equal(remote.rawHead.includes('no-credential'), false, 'response does not state the reason');
});

test('space isolation: members of two projects and the local space do not leak into each other even with the same channel names; storage is under tenants/<projectId>/, local keeps using the data directory', async (t) => {
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
  assert.deepEqual(await cb.quiet(() => true, 200), [], 'b receives 0 messages');
  assert.deepEqual(await cl.quiet(() => true, 50), [], 'local space receives 0 messages');
  cb.send({ type: 'content.get', reqId: 'g', kind: 'card-source', key: 'k' });
  assert.equal((await cb.next(byReq('g'))).missing, true, 'b cannot see the content of a');
  cl.send({ type: 'project.announce', reqId: 'an2', projectId: 'same-id', digest: 'b'.repeat(64) });
  assert.equal((await cl.next(byReq('an2'))).projectRev, 1, 'local space starts from 1 on its own');

  const dir = s.dir;
  assert.ok(fs.existsSync(path.join(dir, 'tenants', a.projectId, 'content')), 'storage of the shared space');
  assert.ok(fs.existsSync(path.join(dir, 'projects')), 'local space keeps using the data directory');
  assert.equal(fs.existsSync(path.join(dir, 'tenants', b.projectId, 'content')), false);
  const channels = Object.keys(s.service.describe().channels);
  assert.ok(channels.includes(`content:@${a.projectId}/card-source`), channels.join(','));
  assert.ok(channels.includes('content:card-source'), 'local channel names are unchanged');
});

test('member list: grouped by username + device, same name on different devices all carry the device name; reverts after one leaves; watch receives changes; tags', async (t) => {
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
  }, 3000, 'two devices');
  const row1 = list.devices.find((d) => d.deviceId === d1);
  assert.equal(row1.displayName, 'bob (Bob-A)');
  assert.equal(list.devices.find((d) => d.deviceId === d2).displayName, 'bob (Bob-B)');
  assert.deepEqual(row1.tags, { editing: true, rendering: false, agents: 1 });
  assert.deepEqual(row1.conns.map((c) => c.role).sort(), ['agent', 'page', 'render']);
  assert.deepEqual(row1.conns.find((c) => c.role === 'agent'), { role: 'agent', conversation: 2 });
  assert.equal(row1.creator, false);
  assert.notEqual(s.store.peek(p.projectId).creator.username, 'bob');
  page2.close();
  await waitFor(() => page1.all.some((m) => m.type === 'shared.members.list' && m.devices.length === 1 && m.devices[0].displayName === 'bob'), 3000, 'one left, reverts to showing only the username');
});

test('roles: page sending node.hello returns forbidden, render is allowed; the actor of an agent write carries a chat number; members cannot register service addresses but can subscribe', async (t) => {
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

test('tickets: a connection ticket lets another connection in with the same identity and the render role; a local identity cannot get a ticket; an asset ticket can be verified by the same store', async (t) => {
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
  const conn = await waitFor(() => s.service.describe().conns.find((c) => c.principal.role === 'render'), 2000, 'render connection');
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
  assert.equal(verifier.verify(ok.ticket).ok, false, 'a connection ticket cannot be used as an asset ticket');
  loop = true;
  const local = wsClient(s.url, ['promptcut.v1']);
  t.after(() => local.close());
  await local.opened;
  local.send({ type: 'auth.ticket', reqId: 'l', kind: 'asset' });
  assert.equal((await local.next(byReq('l'))).reason, 'forbidden', 'local identity cannot get a ticket');
});

test('creator operations: no proof, wrong proof, and a non-creator passphrase are all forbidden and counted toward rate limiting; all five ops take effect with a proof', async (t) => {
  const s = await startSharedService({ mode: 'hosted' });
  t.after(() => s.close());
  const p = await createProject(s.base, { password: 'pw' });
  const devBob = newDeviceId('ab');
  const bob = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: devBob, password: 'pw' });
  const alice = await join(s.base, { projectId: p.projectId, username: 'alice', deviceId: newDeviceId('aa'), password: 'creator-pw', as: 'creator' });
  t.after(() => { bob.close(); alice.close(); });
  await Promise.all([bob.opened, alice.opened]);

  bob.send({ type: 'shared.admin', reqId: 'x', op: 'delete' });
  assert.equal((await bob.next(byReq('x'))).reason, 'forbidden', 'no proof');
  assert.equal((await adminOp(bob, { projectId: p.projectId, op: 'kick', password: 'pw', fields: { username: 'x', deviceId: newDeviceId('z') } })).reason, 'forbidden', 'impersonating with the project passphrase');
  bob.send({ type: 'shared.challenge', reqId: 'c' });
  const ch = await bob.next(byReq('c'));
  bob.send({ type: 'shared.admin', reqId: 'y', op: 'delete', proof: { nonce: ch.nonce, m: crypto.randomBytes(32).toString('base64url') } });
  assert.equal((await bob.next(byReq('y'))).reason, 'forbidden', 'wrong proof');
  // Proof is correct, but nonce was fetched by another connection: rejected
  alice.send({ type: 'shared.challenge', reqId: 'c2' });
  const ch2 = await alice.next(byReq('c2'));
  const key = await deriveKey('creator-pw', ch2.salt, ch2.kdf);
  bob.send({ type: 'shared.admin', reqId: 'z', op: 'unban', username: 'q', deviceId: newDeviceId('q'), proof: { nonce: ch2.nonce, m: await adminProof({ key, projectId: p.projectId, username: 'alice', op: 'unban', nonce: ch2.nonce }) } });
  assert.equal((await bob.next(byReq('z'))).reason, 'forbidden', 'nonce must be fetched by the same connection');

  // Regular member who knows creator passphrase: succeeds if proof is correct (privilege is bound
  // to passphrase, not connection identity)
  const gen = s.store.peek(p.projectId).generation;
  const np = await makeCredential('pw2', FAST_KDF);
  assert.equal((await adminOp(bob, { projectId: p.projectId, op: 'set-password', fields: { project: np } })).type, 'shared.admin.ok');
  assert.equal(s.store.peek(p.projectId).generation, gen + 1);
  assert.equal(bob.ws.readyState, WebSocket.OPEN, 'live connections stay up when the passphrase is changed');
  const bad = await join(s.base, { projectId: p.projectId, username: 'carol', deviceId: newDeviceId('ac'), password: 'pw' }).catch((e) => e);
  await assert.rejects(bad.opened, 'old passphrase cannot get in');
  const good = await join(s.base, { projectId: p.projectId, username: 'carol', deviceId: newDeviceId('ac'), password: 'pw2' });
  await good.opened;
  good.close();
  assert.equal((await adminOp(alice, { projectId: p.projectId, op: 'set-list', fields: { list: [] } })).reason, 'bad-message', 'open entry has no list');

  // kick: connection closes with 4003, ticket is invalidated immediately, subsequent entry gets 401;
  // can enter after unban
  bob.send({ type: 'auth.ticket', reqId: 'at', kind: 'asset', access: 'rw' });
  const bobTicket = (await bob.next(byReq('at'))).ticket;
  const verifier = createAssetTicketVerifier({ store: s.store });
  assert.equal(verifier.verify(bobTicket).ok, true);
  assert.equal((await adminOp(alice, { projectId: p.projectId, op: 'kick', fields: { username: 'bob', deviceId: devBob } })).type, 'shared.admin.ok');
  const closed = await bob.closed;
  assert.equal(closed.code, 4003);
  assert.equal(closed.reason, 'kicked');
  assert.equal(verifier.verify(bobTicket).ok, false, 'ticket of the kicked member is invalidated immediately');
  const again = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: devBob, password: 'pw2' });
  await assert.rejects(again.opened, 'ban list');
  assert.equal((await adminOp(alice, { projectId: p.projectId, op: 'unban', fields: { username: 'bob', deviceId: devBob } })).type, 'shared.admin.ok');
  const back = await join(s.base, { projectId: p.projectId, username: 'bob', deviceId: devBob, password: 'pw2' });
  await back.opened;
  back.close();

  // delete: entire space 4004, records and data deleted, name released
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
  await waitFor(() => !fs.existsSync(tenantDir), 2000, 'space data deleted');
  const lk = await fetch(`${httpBaseOf(s.base)}/shared/lookup?name=${encodeURIComponent(p.name)}`);
  assert.equal(lk.status, 404, 'name released');
});

test('creator operations: set-list under restricted entry removes someone (their connection closes with 4003 removed, re-entry returns 401); the creator is unaffected', async (t) => {
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
  assert.equal((await adminOp(alice, { projectId: p.projectId, op: 'set-password', fields: { project: await makeCredential('x', FAST_KDF) } })).reason, 'bad-message', 'restricted entry has no project passphrase');
  // Cooldown: from the same origin (all the same address in tests), a handshake outside the list for
  // bob counts as one failure; 4 more creator proof failures trigger cooldown, after which fetching
  // challenges returns rate-limited
  for (let i = 0; i < 4; i++) assert.equal((await adminOp(carol, { projectId: p.projectId, op: 'unban', password: 'nope', fields: { username: 'q', deviceId: newDeviceId('q') } })).reason, 'forbidden');
  carol.send({ type: 'shared.challenge', reqId: 'cool' });
  assert.equal((await carol.next(byReq('cool'))).reason, 'rate-limited');
});

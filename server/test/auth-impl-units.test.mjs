/**
 * Server-side parts of `server/auth/` (implementer self-test; contract `docs/plan/auth-contract.md`
 * sections 3, 4, 5, 8, 9):
 * Credential storage, challenge, rate limiting, tickets, handshake authentication (without starting
 * service, using fake requests).
 * Run: node --test server/test/auth-impl-units.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openCredentialStore, credentialStoreFor, existingCredentialStore, forgetCredentialStore, newProjectId, kidOf } from '../auth/store.mjs';
import { createChallenges } from '../auth/challenges.mjs';
import { createRateLimiter } from '../auth/rate-limit.mjs';
import { signTicket, verifyTicket, userGeneration } from '../auth/tickets.mjs';
import { createHandshakeAuth, credentialFor, admissionOf, LOCAL_PRINCIPAL, ADMIN_PRINCIPAL, isLoopbackAddress } from '../auth/handshake.mjs';
import { authPurpose, isProjectId } from '../auth/protocol.mjs';
import { tempDir, FAST_KDF } from './fake-shared-env.mjs';

const cred = () => ({ salt: crypto.randomBytes(16).toString('base64url'), key: crypto.randomBytes(32).toString('base64url') });
const clock = (t0 = 1_000_000) => { let t = t0; const f = () => t; f.set = (v) => { t = v; }; f.add = (d) => { t += d; }; return f; };

function freshStore(now) {
  return openCredentialStore({ dir: path.join(tempDir('pc-au-'), 'auth'), now });
}

// ------------------------------------------------------------------ Storage

test('store: first open generates server.json; create, look up, update, delete; records survive a reopen; names are unique by NFC + lowercase', () => {
  const dir = path.join(tempDir('pc-au-'), 'auth');
  const st = openCredentialStore({ dir });
  const serverJson = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'));
  assert.equal(serverJson.v, 1);
  assert.equal(Buffer.from(serverJson.secret, 'base64url').length, 32);
  const rec = st.create({ name: 'Café', mode: 'free', kdf: FAST_KDF, creator: { username: 'alice', ...cred() }, project: cred() });
  assert.ok(isProjectId(rec.projectId));
  assert.equal(rec.generation, 1);
  assert.deepEqual(rec.userGenerations, {});
  assert.deepEqual(rec.bans, []);
  assert.equal(Buffer.from(rec.ticketKey, 'base64url').length, 32);
  assert.equal(rec.list, undefined, 'open entry has no list');
  assert.equal(st.nameTaken('CAFÉ'), true);
  assert.equal(st.byName('café').projectId, rec.projectId);
  assert.throws(() => st.create({ name: 'café', mode: 'free', kdf: FAST_KDF, creator: { username: 'x', ...cred() }, project: cred() }), (e) => e.code === 'name-taken');
  const file = path.join(dir, 'projects', `${rec.projectId}.json`);
  assert.ok(fs.existsSync(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), rec);

  const r2 = st.create({ name: 'Restricted', mode: 'restricted', kdf: FAST_KDF, creator: { username: 'alice', ...cred() }, list: [{ username: 'bob', ...cred() }] });
  assert.equal(r2.project, undefined);
  assert.equal(r2.list.length, 1);
  const up = st.update(rec.projectId, (d) => { d.generation += 1; d.name = 'hijack'; });
  assert.equal(up.generation, 2);
  assert.equal(up.name, 'Café', 'update cannot rename');
  assert.equal(st.get(rec.projectId).generation, 2);
  assert.equal(st.update('sp_nope', () => {}), null);

  const reopened = openCredentialStore({ dir });
  assert.equal(reopened.count(), 2);
  assert.equal(reopened.get(rec.projectId).generation, 2);
  assert.equal(reopened.serverSecret.toString('base64url'), serverJson.secret, 'server key is unchanged across reopens');
  assert.equal(st.remove(rec.projectId), true);
  assert.equal(st.remove(rec.projectId), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(st.nameTaken('café'), false, 'deleting releases the name');
  // Returns a replica: modifying it does not affect storage
  const copy = st.get(r2.projectId);
  copy.generation = 99;
  assert.equal(st.get(r2.projectId).generation, 1);
});

test('store: unusable directory (it is a file), corrupt server.json, corrupt project file → throws on open (fail-closed)', () => {
  const base = tempDir('pc-au-');
  const asFile = path.join(base, 'file');
  fs.writeFileSync(asFile, 'x');
  assert.throws(() => openCredentialStore({ dir: path.join(asFile, 'auth') }));
  const d2 = path.join(base, 'a2');
  fs.mkdirSync(path.join(d2, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(d2, 'server.json'), '{broken');
  assert.throws(() => openCredentialStore({ dir: d2 }));
  const d3 = path.join(base, 'a3');
  openCredentialStore({ dir: d3 });
  fs.writeFileSync(path.join(d3, 'projects', `${newProjectId()}.json`), '{"v":2}');
  assert.throws(() => openCredentialStore({ dir: d3 }));
});

test('store: credentialStoreFor returns an in-process singleton per directory; reopens after forget', () => {
  const dir = path.join(tempDir('pc-au-'), 'auth');
  assert.equal(existingCredentialStore(dir), null);
  const a = credentialStoreFor(dir);
  assert.equal(credentialStoreFor(path.join(dir, '.')), a, 'same directory, same instance');
  assert.equal(existingCredentialStore(dir), a);
  forgetCredentialStore(dir);
  assert.notEqual(credentialStoreFor(dir), a);
  forgetCredentialStore(dir);
});

test('store: projectId is sp_ plus 26 lowercase base32 characters, all distinct', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const id = newProjectId();
    assert.ok(isProjectId(id), id);
    seen.add(id);
  }
  assert.equal(seen.size, 500);
});

// ------------------------------------------------------------------ Challenge

test('challenges: single use, expire after 60 s, binding must match; a used one presented again returns used, one never seen returns unknown', () => {
  const now = clock();
  const ch = createChallenges({ now });
  const b = ['join', 'sp_x', 'bob', 'dev', 'member'];
  const n1 = ch.issue(b);
  assert.equal(Buffer.from(n1, 'base64url').length, 32);
  assert.equal(ch.check(n1, b), 'ok');
  assert.equal(ch.check(n1, b), 'used');
  const n2 = ch.issue(b);
  assert.equal(ch.check(n2, ['join', 'sp_x', 'bob', 'dev', 'creator']), 'mismatch');
  assert.equal(ch.check(n2, b), 'used', 'a mismatched binding also voids it');
  const n3 = ch.issue(b);
  now.add(59_999);
  assert.equal(ch.consume(n3, b), true);
  const n4 = ch.issue(b);
  now.add(60_000);
  assert.equal(ch.check(n4, b), 'expired');
  assert.equal(ch.check('nope', b), 'unknown');
  assert.equal(ch.check(undefined, b), 'unknown');
  const n5 = ch.issue(['admin', 'conn-1', 'sp_x']);
  ch.dropWhere((x) => x[1] === 'conn-1');
  assert.equal(ch.check(n5, ['admin', 'conn-1', 'sp_x']), 'used');
});

test('challenges: the number of outstanding entries is capped, the earliest issued is dropped when the cap is exceeded', () => {
  const ch = createChallenges({ max: 3 });
  const ns = [1, 2, 3, 4].map((i) => ch.issue(['x', i]));
  assert.ok(ch.size() <= 3);
  assert.equal(ch.consume(ns[0], ['x', 1]), false);
  assert.equal(ch.consume(ns[3], ['x', 4]), true);
});

// ------------------------------------------------------------------ Rate limiting

test('rate-limit: the 5th failure within 1 minute enters a 60 s cooldown; further failures during the cooldown do not extend it; the count resets afterwards; other sources are unaffected', () => {
  const now = clock();
  const rl = createRateLimiter({ now });
  for (let i = 0; i < 4; i++) assert.equal(rl.fail('1.1.1.1'), false);
  assert.equal(rl.blocked('1.1.1.1'), false);
  assert.equal(rl.fail('1.1.1.1'), true, '5th failure enters cooldown');
  assert.equal(rl.blocked('1.1.1.1'), true);
  assert.equal(rl.blocked('2.2.2.2'), false);
  now.add(30_000);
  rl.fail('1.1.1.1');
  now.add(29_999);
  assert.equal(rl.blocked('1.1.1.1'), true, 'within 60 s');
  now.add(2);
  assert.equal(rl.blocked('1.1.1.1'), false, 'recovers after 60 s');
  assert.equal(rl.fail('1.1.1.1'), false, 'counting restarts from zero after cooldown');
  // Failures spread outside of one minute do not accumulate
  const rl2 = createRateLimiter({ now });
  for (let i = 0; i < 10; i++) { rl2.fail('3.3.3.3'); now.add(15_000); }
  assert.equal(rl2.blocked('3.3.3.3'), false);
});

// ------------------------------------------------------------------ Ticket

function ticketFixture() {
  const now = clock(Date.UTC(2026, 8, 26));
  const st = freshStore(now);
  const rec = st.create({ name: `t-${Math.random()}`, mode: 'free', kdf: FAST_KDF, creator: { username: 'alice', ...cred() }, project: cred() });
  const lookup = (id) => st.peek(id);
  return { now, st, rec, lookup };
}

test('tickets: issued shape and fields; verification passes; the expiry, generation, signature, kind and length cases', () => {
  const { now, st, rec, lookup } = ticketFixture();
  const u = 'bob@dev-000000000001';
  const { ticket, exp } = signTicket(st.peek(rec.projectId), { k: 'asset', u, r: 'rw' }, now());
  assert.match(ticket, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  const [, seg, sig] = ticket.split('.');
  const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload).sort(), ['exp', 'g', 'iat', 'k', 'kid', 'p', 'r', 'u', 'ug'].sort());
  assert.equal(payload.kid, kidOf(rec.ticketKey));
  assert.equal(exp - payload.iat, 15 * 60_000);
  assert.equal(sig, crypto.createHmac('sha256', Buffer.from(rec.ticketKey, 'base64url')).update(`v1.${seg}`).digest('base64url'));
  assert.equal(verifyTicket(ticket, { lookup, now: now() }).ok, true);
  assert.equal(verifyTicket(ticket, { lookup, now: now(), kind: 'conn' }).reason, 'kind');

  // Clock: recognized within 30 s after expiration, rejected beyond that; rejected if issued more
  // than 30 s in the future
  assert.equal(verifyTicket(ticket, { lookup, now: exp + 30_000 }).ok, true);
  assert.equal(verifyTicket(ticket, { lookup, now: exp + 30_001 }).reason, 'expired');
  assert.equal(verifyTicket(ticket, { lookup, now: now() - 30_001 }).reason, 'expired');

  // Signature: modify one character in payload, modify signature, switch key
  const tampered = `v1.${Buffer.from(JSON.stringify({ ...payload, r: 'rw', u: 'mallory@dev-000000000001' })).toString('base64url')}.${sig}`;
  assert.equal(verifyTicket(tampered, { lookup, now: now() }).reason, 'signature');
  const flip = sig[0] === 'A' ? 'B' : 'A';
  assert.equal(verifyTicket(`v1.${seg}.${flip}${sig.slice(1)}`, { lookup, now: now() }).reason, 'signature');
  // exp - iat in payload exceeds validity period: rejected even if signature is valid
  const long = { ...payload, exp: payload.iat + 16 * 60_000 };
  const longSeg = Buffer.from(JSON.stringify(long)).toString('base64url');
  const longSig = crypto.createHmac('sha256', Buffer.from(rec.ticketKey, 'base64url')).update(`v1.${longSeg}`).digest('base64url');
  assert.equal(verifyTicket(`v1.${longSeg}.${longSig}`, { lookup, now: now() }).reason, 'format');

  // Generation: rejected if project generation or user generation changes
  st.update(rec.projectId, (d) => { d.generation += 1; });
  assert.equal(verifyTicket(ticket, { lookup, now: now() }).reason, 'generation');
  const t2 = signTicket(st.peek(rec.projectId), { k: 'asset', u, r: 'r' }, now()).ticket;
  assert.equal(verifyTicket(t2, { lookup, now: now() }).ok, true);
  st.update(rec.projectId, (d) => { d.userGenerations[u] = userGeneration(d, u) + 1; });
  assert.equal(verifyTicket(t2, { lookup, now: now() }).reason, 'generation');
  const other = signTicket(st.peek(rec.projectId), { k: 'asset', u: 'carol@dev-000000000002', r: 'r' }, now()).ticket;
  assert.equal(verifyTicket(other, { lookup, now: now() }).ok, true, 'other users are unaffected');

  // Format
  for (const bad of ['', 'v1', 'v1.a.b', `v2.${seg}.${sig}`, `v1.${seg}`, 'x'.repeat(2049), `v1.${seg}.${sig}.x`]) {
    assert.equal(verifyTicket(bad, { lookup, now: now() }).ok, false, bad.slice(0, 20));
  }
  // Project no longer exists
  st.remove(rec.projectId);
  assert.equal(verifyTicket(other, { lookup, now: now() }).reason, 'no-project');
});

test('tickets: connection ticket lasts 2 minutes and carries role / chat number / ownership; during rotation the old key is still accepted up to until', () => {
  const { now, st, rec, lookup } = ticketFixture();
  const u = 'bob@dev-000000000001';
  const t = signTicket(st.peek(rec.projectId), { k: 'conn', u, r: 'render', o: { kind: 'agent', c: 2 }, dn: 'Bob PC' }, now());
  assert.equal(t.exp - now(), 2 * 60_000);
  const v = verifyTicket(t.ticket, { lookup, now: now(), kind: 'conn' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.payload.o, { kind: 'agent', c: 2 });
  const agent = signTicket(st.peek(rec.projectId), { k: 'conn', u, r: 'agent', c: 3 }, now()).ticket;
  assert.equal(verifyTicket(agent, { lookup, now: now() }).payload.c, 3);

  const oldKey = rec.ticketKey;
  const oldTicket = signTicket(st.peek(rec.projectId), { k: 'asset', u, r: 'r' }, now()).ticket;
  st.update(rec.projectId, (d) => {
    d.oldTicketKeys = [{ kid: kidOf(oldKey), key: oldKey, until: now() + 1000 }];
    d.ticketKey = crypto.randomBytes(32).toString('base64url');
  });
  assert.equal(verifyTicket(oldTicket, { lookup, now: now() }).ok, true, 'old ticket is still accepted during rotation');
  assert.equal(verifyTicket(oldTicket, { lookup, now: now() + 1001 }).reason, 'signature', 'not accepted after until');
  const fresh = signTicket(st.peek(rec.projectId), { k: 'asset', u, r: 'r' }, now()).ticket;
  assert.equal(verifyTicket(fresh, { lookup, now: now() }).ok, true);
});

// ------------------------------------------------------------------ Handshake authentication (fake request)

function handshakeFixture({ loopback = false, token } = {}) {
  const now = clock(Date.UTC(2026, 8, 26));
  const st = freshStore(now);
  const challenges = createChallenges({ now });
  const limiter = createRateLimiter({ now });
  const logs = [];
  const auth = createHandshakeAuth({
    store: st, challenges, limiter, clusterToken: token, isLoopback: () => loopback, remoteOf: () => '10.0.0.9',
    localDevice: { deviceId: 'pc-local-device-0001', deviceName: 'host' }, now, log: (e, f) => logs.push({ e, ...f }),
  });
  const req = (...protocols) => ({ headers: protocols.length ? { 'sec-websocket-protocol': protocols.join(', ') } : {}, socket: { remoteAddress: '10.0.0.9' } });
  return { now, st, challenges, limiter, auth, logs, req };
}

const proofItem = (fields) => `promptcut.auth.${Buffer.from(JSON.stringify(fields)).toString('base64url')}`;
function makeProof({ key, projectId, username, deviceId, as = 'member', nonce, role = 'page', extra = {} }) {
  const m = crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update(Buffer.from(authPurpose({ projectId, username, deviceId, as, nonce }))).digest('base64url');
  return proofItem({ v: 1, p: projectId, u: username, d: deviceId, dn: 'Dev', as, nonce, m, r: role, ...extra });
}

test('handshake: correct proof → member principal has all fields; nonce reuse, four-tuple mismatch, wrong proof, off the list → null and the reason is recorded', () => {
  const f = handshakeFixture();
  const project = cred();
  const creator = cred();
  const rec = f.st.create({ name: 'h1', mode: 'free', kdf: FAST_KDF, creator: { username: 'alice', ...creator }, project });
  const dev = 'dev-000000000001';
  const issue = (u = 'bob', as = 'member') => f.challenges.issue(['join', rec.projectId, u, dev, as]);
  const nonce = issue();
  const good = makeProof({ key: project.key, projectId: rec.projectId, username: 'bob', deviceId: dev, nonce, role: 'render', extra: { o: { kind: 'user' } } });
  assert.deepEqual(f.auth.authenticate(f.req('promptcut.v1', good)), {
    userId: `bob@${dev}`, tenantId: rec.projectId, scope: 'member', username: 'bob', deviceId: dev, deviceName: 'Dev',
    creator: false, role: 'render', conversation: null, owner: { kind: 'user' },
  });
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', good)), null, 'nonce reuse');
  const n2 = issue();
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', makeProof({ key: project.key, projectId: rec.projectId, username: 'bobby', deviceId: dev, nonce: n2 }))), null, 'four-tuple mismatch');
  const n3 = issue();
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', makeProof({ key: cred().key, projectId: rec.projectId, username: 'bob', deviceId: dev, nonce: n3 }))), null, 'wrong passphrase');
  const n4 = issue('bob', 'creator');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', makeProof({ key: project.key, projectId: rec.projectId, username: 'bob', deviceId: dev, as: 'creator', nonce: n4 }))), null, 'not the creator');
  const n5 = issue('alice', 'creator');
  const asCreator = f.auth.authenticate(f.req('promptcut.v1', makeProof({ key: creator.key, projectId: rec.projectId, username: 'alice', deviceId: dev, as: 'creator', nonce: n5, role: 'agent', extra: { c: 2 } })));
  assert.equal(asCreator.creator, true);
  assert.equal(asCreator.conversation, 2);
  assert.deepEqual(f.logs.map((l) => l.reason), ['nonce', 'nonce', 'bad-proof', 'not-listed']);
  assert.ok(f.logs.every((l) => l.e === 'auth.reject' && l.remote === '10.0.0.9'));
  assert.ok(!JSON.stringify(f.logs).includes(project.key));
});

test('handshake: format and combination rules (multiple items, missing promptcut.v1, agent missing chat number, owner given on a non-render role, JSON over 1024 bytes)', () => {
  const f = handshakeFixture();
  const project = cred();
  const rec = f.st.create({ name: 'h2', mode: 'free', kdf: FAST_KDF, creator: { username: 'alice', ...cred() }, project });
  const dev = 'dev-000000000002';
  const p = (extra = {}, role = 'page') => makeProof({ key: project.key, projectId: rec.projectId, username: 'bob', deviceId: dev, nonce: f.challenges.issue(['join', rec.projectId, 'bob', dev, 'member']), role, extra });
  const reasons = () => f.logs.map((l) => l.reason);
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', p(), 'promptcut.ticket.x')), null);
  assert.equal(f.auth.authenticate(f.req(p())), null, 'promptcut.v1 missing');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', p({}, 'agent'))), null, 'agent missing chat number');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', p({ c: 1 }, 'page'))), null, 'page carries a chat number');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', p({ o: { kind: 'user' } }, 'page'))), null, 'owner only for render');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', p({ pad: 'x'.repeat(1100) }))), null, 'JSON over 1024 bytes');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', 'promptcut.auth.!!!')), null);
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', 'promptcut.role.render')), null, 'only a role item');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1')), null, 'non-loopback with nothing');
  assert.deepEqual(reasons(), ['multiple', 'bad-format', 'bad-format', 'bad-format', 'bad-format', 'bad-format', 'bad-format', 'bad-format', 'no-credential']);
});

test('handshake: loopback with nothing is the local identity; a local claim is accepted only on loopback and the project must exist; a token is accepted only when given and allowed', () => {
  const token = crypto.randomBytes(32).toString('base64url');
  const loop = handshakeFixture({ loopback: true, token });
  assert.deepEqual(loop.auth.authenticate(loop.req()), LOCAL_PRINCIPAL);
  assert.deepEqual(loop.auth.authenticate(loop.req('promptcut.v1')), LOCAL_PRINCIPAL);
  const rec = loop.st.create({ name: 'h3', mode: 'restricted', kdf: FAST_KDF, creator: { username: 'alice', ...cred() }, list: [] });
  assert.deepEqual(loop.auth.authenticate(loop.req('promptcut.v1', `promptcut.tenant.${rec.projectId}`, 'promptcut.role.render')), {
    userId: 'local@pc-local-device-0001', tenantId: rec.projectId, scope: 'member', username: 'local', deviceId: 'pc-local-device-0001',
    deviceName: 'host', creator: true, role: 'render', conversation: null, owner: null,
  });
  assert.equal(loop.auth.authenticate(loop.req('promptcut.v1', `promptcut.tenant.${rec.projectId}`)).role, 'page');
  assert.equal(loop.auth.authenticate(loop.req('promptcut.v1', `promptcut.tenant.${rec.projectId}`, 'promptcut.role.agent.4')).conversation, 4);
  assert.equal(loop.auth.authenticate(loop.req('promptcut.v1', `promptcut.tenant.${rec.projectId}`, 'promptcut.role.agent')), null);
  assert.equal(loop.auth.authenticate(loop.req('promptcut.v1', `promptcut.tenant.${newProjectId()}`)), null, 'Project does not exist');
  assert.deepEqual(loop.auth.authenticate(loop.req('promptcut.v1', `promptcut.token.${token}`)), ADMIN_PRINCIPAL);
  assert.equal(loop.auth.authenticate(loop.req('promptcut.v1', `promptcut.token.${token}`, `promptcut.tenant.${rec.projectId}`)), null, 'token cannot be combined with other items');

  const lan = handshakeFixture({ loopback: false });
  const rec2 = lan.st.create({ name: 'h3b', mode: 'free', kdf: FAST_KDF, creator: { username: 'alice', ...cred() }, project: cred() });
  assert.equal(lan.auth.authenticate(lan.req('promptcut.v1', `promptcut.tenant.${rec2.projectId}`)), null, 'local claim from non-loopback');
  assert.equal(lan.auth.authenticate(lan.req('promptcut.v1', `promptcut.token.${token}`)), null, 'no token configured');

  const noToken = handshakeFixture({ loopback: true });
  const auth2 = createHandshakeAuth({ store: noToken.st, challenges: noToken.challenges, limiter: noToken.limiter, clusterToken: token, acceptToken: false, isLoopback: () => true });
  assert.equal(auth2.authenticate(noToken.req('promptcut.v1', `promptcut.token.${token}`)), null, 'mounted mode never accepts tokens');
  assert.throws(() => createHandshakeAuth({ store: null, challenges: noToken.challenges, limiter: noToken.limiter, clusterToken: 'short', isLoopback: () => true }), TypeError);
});

test('handshake: restricted entry (those on the list get in; those off the list or on the ban list get 401); a creator entering as member still counts as the creator', () => {
  const f = handshakeFixture();
  const creator = cred();
  const bob = cred();
  const rec = f.st.create({ name: 'h4', mode: 'restricted', kdf: FAST_KDF, creator: { username: 'alice', ...creator }, list: [{ username: 'bob', ...bob }] });
  const dev = 'dev-000000000004';
  const go = (username, key, as = 'member') => f.auth.authenticate(f.req('promptcut.v1', makeProof({ key, projectId: rec.projectId, username, deviceId: dev, as, nonce: f.challenges.issue(['join', rec.projectId, username, dev, as]) })));
  assert.equal(go('bob', bob.key).username, 'bob');
  assert.equal(go('carol', bob.key), null, 'off the list');
  const a = go('alice', creator.key);
  assert.equal(a.creator, true, 'the creator automatically counts as on the list');
  f.st.update(rec.projectId, (d) => { d.bans.push({ username: 'bob', deviceId: dev }); });
  assert.equal(go('bob', bob.key), null, 'banned');
  assert.deepEqual(f.logs.map((l) => l.reason), ['not-listed', 'banned']);
  assert.equal(credentialFor(f.st.peek(rec.projectId), 'carol', 'member'), null);
  assert.equal(admissionOf(f.st.peek(rec.projectId), { username: 'bob', deviceId: dev, creator: false }), 'banned');
});

test('handshake: rate limiting (after 5 failures from the same source, even a correct passphrase is rejected during cooldown); replaying a used nonce is not counted; recovers after 61 s', () => {
  const f = handshakeFixture();
  const project = cred();
  const rec = f.st.create({ name: 'h5', mode: 'free', kdf: FAST_KDF, creator: { username: 'alice', ...cred() }, project });
  const dev = 'dev-000000000005';
  const attempt = (key) => {
    const nonce = f.challenges.issue(['join', rec.projectId, 'bob', dev, 'member']);
    const item = makeProof({ key, projectId: rec.projectId, username: 'bob', deviceId: dev, nonce });
    return { first: f.auth.authenticate(f.req('promptcut.v1', item)), replay: () => f.auth.authenticate(f.req('promptcut.v1', item)) };
  };
  for (let i = 0; i < 4; i++) {
    const a = attempt(cred().key);
    assert.equal(a.first, null);
    assert.equal(a.replay(), null, 'replay (after a 401, Node WebSocket re-sends the same request once)');
  }
  assert.equal(f.limiter.blocked('10.0.0.9'), false, 'replay is not counted: 4 failures have not reached cooldown yet');
  assert.equal(attempt(cred().key).first, null);
  assert.equal(f.limiter.blocked('10.0.0.9'), true);
  assert.equal(attempt(project.key).first, null, 'rejected during cooldown even with the correct passphrase');
  assert.equal(f.logs.at(-1).reason, 'rate-limited');
  f.now.add(61_000);
  assert.ok(attempt(project.key).first, 'recovers after 61 s');
});

test('isLoopbackAddress', () => {
  for (const a of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ['10.0.0.1', '::ffff:10.0.0.1', '', null, 'fe80::1']) assert.equal(isLoopbackAddress(a), false, String(a));
});

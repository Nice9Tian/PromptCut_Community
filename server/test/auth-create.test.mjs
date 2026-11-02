/**
 * M6a shared project: HTTP endpoints (contract `docs/plan/auth-contract.md` sections 3 and 4, case AU1).
 * Run: node --test server/test/auth-create.test.mjs
 *
 * Written strictly against the contract, without looking at the implementation. The interfaces
 * to start the service are the test side's assumptions, centralized in the `auth-kit.mjs` header.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hostFor, createProject, credential, challenge, uniqueName, KDF, newDevice, joinStatus } from './auth-kit.mjs';

const PUBLIC = '203.0.113.7';
const LAN = '192.168.1.50';

function createBody({ name = uniqueName(), mode = 'free', kdf = KDF } = {}) {
  const body = { name, mode, kdf, creator: credential('creator-pw', 'alice') };
  if (mode === 'free') body.project = credential('project-pw');
  else body.list = [credential('bob-pw', 'bob')];
  return body;
}

test('AU1 shared/create succeeds in both modes: 201 { ok, projectId: sp_<26 lowercase base32 characters>, name, mode }, lookup finds it', async (t) => {
  const env = await hostFor(t);
  for (const mode of ['free', 'restricted']) {
    const body = createBody({ mode });
    const r = await env.http('shared/create', { method: 'POST', body, remote: PUBLIC });
    assert.equal(r.status, 201, `${mode}: ${r.text}`);
    assert.equal(r.json.ok, true);
    assert.match(r.json.projectId, /^sp_[a-z2-7]{26}$/, `projectId shape: ${r.json.projectId}`);
    assert.equal(r.json.name, body.name);
    assert.equal(r.json.mode, mode);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');

    const l = await env.http(`shared/lookup?name=${encodeURIComponent(body.name)}`);
    assert.equal(l.status, 200, l.text);
    assert.deepEqual({ ok: l.json.ok, projectId: l.json.projectId, name: l.json.name, mode: l.json.mode }, { ok: true, projectId: r.json.projectId, name: body.name, mode });

    // Section 3: one record file per shared project
    assert.ok(fs.existsSync(path.join(env.dataDir, 'auth', 'projects', `${r.json.projectId}.json`)), 'credential record is written to <data directory>/auth/projects/<projectId>.json');
  }
  assert.ok(fs.existsSync(path.join(env.dataDir, 'auth', 'server.json')), 'first start generates auth/server.json');
  const miss = await env.http(`shared/lookup?name=${encodeURIComponent(uniqueName('nope'))}`);
  assert.equal(miss.status, 404);
  assert.deepEqual(miss.json, { ok: false, error: 'no-project' });
});

test('AU1 a second creation with the same name returns 409 name-taken: a different case or a different NFC form still counts as the same name', async (t) => {
  const env = await hostFor(t);
  const base = uniqueName('Café');
  const nfc = base.normalize('NFC');
  const nfd = base.normalize('NFD');
  assert.notEqual(nfc, nfd, 'test precondition: the NFC and NFD spellings differ in bytes');
  const first = await env.http('shared/create', { method: 'POST', body: createBody({ name: nfc }) });
  assert.equal(first.status, 201, first.text);
  for (const name of [nfc, nfc.toUpperCase(), nfc.toLowerCase(), nfd, nfd.toUpperCase()]) {
    const r = await env.http('shared/create', { method: 'POST', body: createBody({ name, mode: 'restricted' }) });
    assert.equal(r.status, 409, `"${name}" should be 409: ${r.text}`);
    assert.deepEqual(r.json, { ok: false, error: 'name-taken' });
  }
  // lookup likewise compares using normalization
  const l = await env.http(`shared/lookup?name=${encodeURIComponent(nfd.toUpperCase())}`);
  assert.equal(l.status, 200, l.text);
  assert.equal(l.json.projectId, first.json.projectId);
});

test('AU1 missing or invalid fields return 400 bad-request (lead session ruling: missing list = empty list)', async (t) => {
  const env = await hostFor(t);
  const good = createBody();
  const cases = {
    'no name': (b) => { delete b.name; },
    'name is empty': (b) => { b.name = ''; },
    'name exceeds 64 characters': (b) => { b.name = 'x'.repeat(65); },
    'name contains /': (b) => { b.name = 'a/b'; },
    'name contains control characters': (b) => { b.name = 'a\u0001b'; },
    'no mode': (b) => { delete b.mode; },
    'unknown mode': (b) => { b.mode = 'open'; },
    'no kdf': (b) => { delete b.kdf; },
    'kdf.iter below 100,000': (b) => { b.kdf = { ...KDF, iter: 99_999 }; },
    'kdf.iter above 5,000,000': (b) => { b.kdf = { ...KDF, iter: 5_000_001 }; },
    'no creator': (b) => { delete b.creator; },
    'creator has no username': (b) => { delete b.creator.username; },
    'creator has no salt': (b) => { delete b.creator.salt; },
    'creator has no key': (b) => { delete b.creator.key; },
    'creator.key is not 32 bytes': (b) => { b.creator.key = Buffer.alloc(16).toString('base64url'); },
    'open entry but no project': (b) => { delete b.project; },
  };
  for (const [what, mutate] of Object.entries(cases)) {
    const body = structuredClone(good);
    body.name = uniqueName();
    mutate(body);
    const r = await env.http('shared/create', { method: 'POST', body });
    assert.equal(r.status, 400, `${what}: ${r.status} ${r.text}`);
    assert.deepEqual(r.json, { ok: false, error: 'bad-request' }, what);
  }
  const noList = createBody({ mode: 'restricted' });
  delete noList.list;
  const r = await env.http('shared/create', { method: 'POST', body: noList });
  // Lead session ruling (2026-09-26, contract section 14): restricted entry missing list is
  // equivalent to an empty list, with only the creator alone, valid
  assert.equal(r.status, 201, `restricted entry with a missing list = empty list: ${r.text}`);
  const emptyList = { projectId: r.json.projectId, mode: 'restricted', creator: { username: 'alice', password: 'creator-pw' }, list: [] };
  assert.equal(await joinStatus(env, emptyList, { username: 'bob', password: 'bob-pw', remote: '203.0.113.90' }), 401, 'empty list: handshake with a username not on the list returns 401');
  assert.equal(await joinStatus(env, emptyList, { username: 'alice', as: 'creator', remote: '203.0.113.91' }), 101, 'empty list: the creator can get in');
  const notJson = await env.http('shared/create', { method: 'POST', raw: '{not json', headers: { 'content-type': 'application/json' } });
  assert.equal(notJson.status, 400, 'Request body is not JSON');
});

test('AU1 request body over 64 KiB returns 413; OPTIONS preflight answers with CORS', async (t) => {
  const env = await hostFor(t);
  const big = createBody();
  big.pad = 'x'.repeat(64 * 1024 + 10);
  const r = await env.http('shared/create', { method: 'POST', body: big });
  assert.equal(r.status, 413, r.text);
  assert.equal(r.json?.ok, false);

  const pre = await env.http('shared/create', { method: 'OPTIONS', headers: { Origin: 'http://example.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.ok(pre.status === 204 || pre.status === 200, `preflight: ${pre.status}`);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal(pre.headers.get('access-control-allow-credentials'), null, 'without credentials');
});

test('AU1 LAN host (mounted mode): creating a project from a non-loopback source returns 403 forbidden, from a loopback source it succeeds', async (t) => {
  const env = await hostFor(t, { attached: true });
  for (const remote of [LAN, PUBLIC, '10.0.0.8']) {
    const r = await env.http('shared/create', { method: 'POST', body: createBody(), remote });
    assert.equal(r.status, 403, `${remote}: ${r.text}`);
    assert.deepEqual(r.json, { ok: false, error: 'forbidden' });
  }
  const ok = await env.http('shared/create', { method: 'POST', body: createBody() });
  assert.equal(ok.status, 201, ok.text);
  // Attached mode endpoints are at /docservice/shared/…
  assert.ok(env.httpBase.endsWith('/docservice/'));
  // Non-loopback origins can perform lookup and fetch challenges
  const l = await env.http(`shared/lookup?name=${encodeURIComponent(ok.json.name)}`, { remote: LAN });
  assert.equal(l.status, 200, l.text);
});

test('AU1 hosted side: at most 10 projects per hour from the same source, the 11th returns 429 rate-limited; other sources are unaffected; recovers after an hour', async (t) => {
  const env = await hostFor(t);
  for (let i = 0; i < 10; i++) {
    const r = await env.http('shared/create', { method: 'POST', body: createBody(), remote: PUBLIC });
    assert.equal(r.status, 201, `creation #${i + 1}: ${r.text}`);
  }
  const eleventh = await env.http('shared/create', { method: 'POST', body: createBody(), remote: PUBLIC });
  assert.equal(eleventh.status, 429, eleventh.text);
  assert.deepEqual(eleventh.json, { ok: false, error: 'rate-limited' });
  const other = await env.http('shared/create', { method: 'POST', body: createBody(), remote: '198.51.100.9' });
  assert.equal(other.status, 201, `other source: ${other.text}`);
  env.clock.advance(60 * 60_000 + 1000);
  const later = await env.http('shared/create', { method: 'POST', body: createBody(), remote: PUBLIC });
  assert.equal(later.status, 201, `after one hour: ${later.text}`);
});

test('AU1 shared/challenge: shape { ok, nonce(32 bytes), salt, kdf, mode }; a nonexistent project returns 404; wrong fields return 400', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const dev = newDevice();
  const r = await challenge(env, { projectId: proj.projectId, username: 'zed', deviceId: dev.deviceId, as: 'member', remote: PUBLIC });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(Buffer.from(r.json.nonce, 'base64url').length, 32, 'nonce is 32 bytes');
  assert.match(r.json.nonce, /^[A-Za-z0-9_-]+$/, 'nonce is base64url, without =');
  assert.equal(Buffer.from(r.json.salt, 'base64url').length, 16, 'salt is 16 bytes');
  assert.deepEqual(r.json.kdf, KDF);
  assert.equal(r.json.mode, 'free');
  const r2 = await challenge(env, { projectId: proj.projectId, username: 'zed', deviceId: dev.deviceId, as: 'member', remote: PUBLIC });
  assert.notEqual(r2.json.nonce, r.json.nonce, 'new nonce each time');

  const missing = await challenge(env, { projectId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', username: 'zed', deviceId: dev.deviceId });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { ok: false, error: 'no-project' });

  for (const [what, body] of [
    ['unknown as', { projectId: proj.projectId, username: 'zed', deviceId: dev.deviceId, as: 'admin' }],
    ['deviceId too short', { projectId: proj.projectId, username: 'zed', deviceId: 'short', as: 'member' }],
    ['deviceId contains invalid characters', { projectId: proj.projectId, username: 'zed', deviceId: 'bad device id!!!!', as: 'member' }],
    ['no username', { projectId: proj.projectId, deviceId: dev.deviceId, as: 'member' }],
  ]) {
    const b = await env.http('shared/challenge', { method: 'POST', body });
    assert.equal(b.status, 400, `${what}: ${b.text}`);
    assert.deepEqual(b.json, { ok: false, error: 'bad-request' }, what);
  }
});

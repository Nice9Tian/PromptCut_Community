/**
 * M6a 共享项目：素材票据（契约 `docs/plan/auth-contract.md` 第 8 节，用例 AU7）。
 * 跑：node --test server/test/auth-tickets.test.mjs
 *
 * 只照契约写，不看实现。素材服务与文档服务同一进程、共用凭证存储（`host.auth`），接法是测试方的假设，
 * 集中在 `auth-kit.mjs` 文件头。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostFor, createProject, join, newDevice, ticketOf, parseTicket, tamperTicket, flipSignature, adminOp, credential,
  uploadLocal, remotePut, bearer,
} from './auth-kit.mjs';
import { randomToken } from './fake-ws-kit.mjs';

const LAN = '192.168.1.77';

async function setup(t, { mode = 'free' } = {}) {
  const env = await hostFor(t, { assets: true });
  const blob = await uploadLocal(env);
  const proj = await createProject(env, { mode });
  const dev = newDevice();
  const user = mode === 'free' ? 'zoe' : 'bob';
  const member = await join(env, proj, { username: user, device: dev, remote: LAN });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: '192.168.1.78' });
  return { env, blob, proj, member, creator, dev };
}

const read = (env, hash, headers = {}, query = '', method = 'GET') => env.asset(`media/${hash}${query}`, { remote: LAN, headers, method });

test('AU7 ticket shape: v1.<payload>.<signature>; payload fields complete; asset ticket lifetime is at most 15 minutes', async (t) => {
  const { member, proj, dev } = await setup(t);
  const r = await ticketOf(member, { kind: 'asset', access: 'rw' });
  assert.match(r.ticket, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(r.ticket.length <= 2048);
  const { body } = parseTicket(r.ticket);
  for (const k of ['kid', 'k', 'p', 'u', 'r', 'g', 'ug', 'exp', 'iat']) assert.ok(k in body, `payload has ${k}: ${JSON.stringify(body)}`);
  assert.equal(body.k, 'asset');
  assert.equal(body.r, 'rw');
  assert.equal(body.p, proj.projectId);
  assert.equal(body.u, `zoe@${dev.deviceId}`);
  assert.ok(body.exp - body.iat <= 15 * 60_000 && body.exp > body.iat, `lifetime: ${body.exp - body.iat}`);
  assert.equal(r.exp, body.exp);
  const ro = parseTicket((await ticketOf(member, { kind: 'asset', access: 'r' })).ticket).body;
  assert.equal(ro.r, 'r');
});

test('AU7 read: Bearer or query-string ticket → 200; Range 206; the response for a query-string ticket carries no-store and no-referrer', async (t) => {
  const { env, blob, member } = await setup(t);
  const ro = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  const rw = (await ticketOf(member, { kind: 'asset', access: 'rw' })).ticket;
  for (const [what, tk] of [['read-only', ro], ['read-write', rw]]) {
    const g = await read(env, blob.hash, bearer(tk));
    assert.equal(g.status, 200, `Bearer ${what}`);
    assert.deepEqual(g.buf, blob.bytes);
    const h = await read(env, blob.hash, bearer(tk), '', 'HEAD');
    assert.equal(h.status, 200, `HEAD ${what}`);
    const rg = await read(env, blob.hash, { ...bearer(tk), Range: 'bytes=10-19' });
    assert.equal(rg.status, 206, `Range ${what}`);
    assert.deepEqual(rg.buf, blob.bytes.subarray(10, 20));
  }
  const q = await read(env, blob.hash, {}, `?t=${encodeURIComponent(ro)}`);
  assert.equal(q.status, 200, 'query-string read-only ticket');
  assert.deepEqual(q.buf, blob.bytes);
  assert.equal(q.headers.get('cache-control'), 'no-store');
  assert.equal(q.headers.get('referrer-policy'), 'no-referrer');
  const qr = await read(env, blob.hash, { Range: 'bytes=0-9' }, `?t=${encodeURIComponent(ro)}`);
  assert.equal(qr.status, 206, 'query string + Range');
});

test('AU7 read: no ticket, wrong signature, tampered payload, read-write ticket in the query string → 401 unauthorized', async (t) => {
  const { env, blob, member } = await setup(t);
  const ro = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  const rw = (await ticketOf(member, { kind: 'asset', access: 'rw' })).ticket;
  const cases = [
    ['no ticket', {}, ''],
    ['wrong signature', bearer(flipSignature(ro)), ''],
    ['payload tampered (extended exp)', bearer(tamperTicket(ro, { exp: parseTicket(ro).body.exp + 3_600_000 })), ''],
    ['payload tampered (r → rw)', bearer(tamperTicket(ro, { r: 'rw' })), ''],
    ['not a ticket', bearer('garbage'), ''],
    ['wrong signature in the query string', {}, `?t=${encodeURIComponent(flipSignature(ro))}`],
    ['read-write ticket in the query string', {}, `?t=${encodeURIComponent(rw)}`],
    ['overlong ticket', bearer(`v1.${'A'.repeat(2100)}.AAAA`), ''],
  ];
  for (const [what, headers, query] of cases) {
    const r = await read(env, blob.hash, headers, query);
    assert.equal(r.status, 401, `${what}: ${r.status}`);
    assert.deepEqual(r.json, { ok: false, error: 'unauthorized' }, what);
    const h = await read(env, blob.hash, headers, query, 'HEAD');
    assert.equal(h.status, 401, `HEAD ${what}`);
  }
});

test('AU7 read: expiry (15 minutes + 30 s skew, injected clock) → 401; still valid within the skew; every Range of the same playback is verified again', async (t) => {
  const { env, blob, member } = await setup(t);
  const tk = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  const { exp } = parseTicket(tk).body;
  const until = exp - Date.now();
  env.clock.advance(until + 20_000);
  const r1 = await read(env, blob.hash, { ...bearer(tk), Range: 'bytes=0-9' });
  assert.equal(r1.status, 206, 'still valid 20 s after expiry (within the 30 s skew)');
  env.clock.advance(15_000);
  const r2 = await read(env, blob.hash, { ...bearer(tk), Range: 'bytes=10-19' });
  assert.equal(r2.status, 401, '35 s after expiry: the next Range request returns 401');
  const r3 = await read(env, blob.hash, {}, `?t=${encodeURIComponent(tk)}`);
  assert.equal(r3.status, 401, 'the query string expires the same way');
});

test('AU7 write: no ticket, read-only ticket, wrong signature, query string → 401 / 403; a read-write ticket writes as usual', async (t) => {
  const { env, member } = await setup(t);
  const ro = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  const rw = (await ticketOf(member, { kind: 'asset', access: 'rw' })).ticket;

  const none = await remotePut(env, LAN);
  assert.equal(none.status, 401, 'write with no ticket');
  assert.deepEqual(none.json, { ok: false, error: 'unauthorized' });
  const bad = await remotePut(env, LAN, bearer(flipSignature(rw)));
  assert.equal(bad.status, 401, 'write with a wrong signature');
  const readOnly = await remotePut(env, LAN, bearer(ro));
  assert.equal(readOnly.status, 403, 'write with a read-only ticket');
  assert.deepEqual(readOnly.json, { ok: false, error: 'forbidden' });
  const byQuery = await remotePut(env, LAN, {}, `?t=${encodeURIComponent(rw)}`);
  assert.equal(byQuery.status, 401, 'a query string is never accepted for writes');
  const byQueryRo = await remotePut(env, LAN, {}, `?t=${encodeURIComponent(ro)}`);
  assert.equal(byQueryRo.status, 401, 'write with a read-only ticket in the query string');

  const ok = await remotePut(env, LAN, bearer(rw));
  assert.equal(ok.status, 200, `write with a read-write ticket: ${ok.buf.toString()}`);
  // complete 也要票据
  const hash = ok.json.hash;
  const c0 = await env.asset(`media/${hash}/complete`, { method: 'POST', remote: LAN });
  assert.equal(c0.status, 401, 'complete with no ticket');
  const c1 = await env.asset(`media/${hash}/complete`, { method: 'POST', remote: LAN, headers: bearer(ro) });
  assert.equal(c1.status, 403, 'complete with a read-only ticket');
  const c2 = await env.asset(`media/${hash}/complete`, { method: 'POST', remote: LAN, headers: bearer(rw) });
  assert.equal(c2.status, 200, `complete with a read-write ticket: ${c2.buf.toString()}`);
});

test('AU7 project generation changed (set-password) → old ticket returns 401; new ticket works', async (t) => {
  const { env, blob, member, creator, proj } = await setup(t);
  const old = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  assert.equal((await read(env, blob.hash, bearer(old))).status, 200);
  const r = await adminOp(creator, proj, 'set-password', { project: credential('rotated') });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  const after = await read(env, blob.hash, bearer(old));
  assert.equal(after.status, 401, 'old ticket returns 401 after set-password');
  assert.deepEqual(after.json, { ok: false, error: 'unauthorized' });
  assert.equal((await read(env, blob.hash, {}, `?t=${encodeURIComponent(old)}`)).status, 401, 'same for the query string');
  // 在线连接不断，仍能要新票据
  const fresh = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  assert.ok(parseTicket(fresh).body.g > parseTicket(old).body.g, 'new ticket carries the new project generation');
  assert.equal((await read(env, blob.hash, bearer(fresh))).status, 200);
});

test('AU7 project generation changed (set-list) → old tickets of the others on the list also return 401', async (t) => {
  const { env, blob, member, creator, proj } = await setup(t, { mode: 'restricted' });
  const old = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  const r = await adminOp(creator, proj, 'set-list', { list: [credential('bob-pw', 'bob'), credential('new-pw', 'newbie')] });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  assert.equal((await read(env, blob.hash, bearer(old))).status, 401);
});

test('AU7 user generation changed (kick) → old ticket of the kicked member returns 401, tickets of others are unaffected', async (t) => {
  const { env, blob, member, creator, proj, dev } = await setup(t);
  const other = await join(env, proj, { username: 'yan', remote: '192.168.1.79' });
  const mine = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  const theirs = (await ticketOf(other, { kind: 'asset', access: 'r' })).ticket;
  const r = await adminOp(creator, proj, 'kick', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  assert.equal((await read(env, blob.hash, bearer(mine))).status, 401, 'kicked member');
  assert.equal((await read(env, blob.hash, bearer(theirs))).status, 200, 'Someone else');
});

test('AU7 loopback source reads and writes as usual without a ticket; the cluster token is no longer used for the asset service', async (t) => {
  const env = await hostFor(t, { assets: true, clusterToken: randomToken() });
  const blob = await uploadLocal(env);
  const g = await env.asset(`media/${blob.hash}`);
  assert.equal(g.status, 200, 'loopback read');
  assert.deepEqual(g.buf, blob.bytes);
  const token = env.clusterToken;
  const w = await remotePut(env, LAN, bearer(token));
  assert.equal(w.status, 401, 'non-loopback write with the cluster token → 401 (C5 retired)');
  const r = await env.asset(`media/${blob.hash}`, { remote: LAN, headers: bearer(token) });
  assert.equal(r.status, 401, 'non-loopback read with the cluster token → 401');
});

test('AU7 a ticket can read any known hash on this service (no hash restriction); a ticket from another project can read it too', async (t) => {
  const { env, member } = await setup(t);
  const a = await uploadLocal(env);
  const b = await uploadLocal(env);
  const tk = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  assert.equal((await read(env, a.hash, bearer(tk))).status, 200);
  assert.equal((await read(env, b.hash, bearer(tk))).status, 200);
  const p2 = await createProject(env, { mode: 'free' });
  const m2 = await join(env, p2, { username: 'q', remote: '192.168.1.90' });
  const tk2 = (await ticketOf(m2, { kind: 'asset', access: 'r' })).ticket;
  assert.equal((await read(env, a.hash, bearer(tk2))).status, 200);
});

test('AU7 CORS: the preflight Access-Control-Allow-Headers includes Authorization', async (t) => {
  const env = await hostFor(t, { assets: true });
  const r = await env.asset('media/0000000000000000000000000000000000000000000000000000000000000000', {
    method: 'OPTIONS', remote: LAN, headers: { Origin: 'http://192.168.1.5:5173', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
  });
  assert.equal(r.status, 204);
  assert.match(r.headers.get('access-control-allow-headers') ?? '', /authorization/i);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('AU7 the access log for requests carrying a ticket records only the path, not the query string', async (t) => {
  const { env, blob, member } = await setup(t);
  const tk = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  await read(env, blob.hash, {}, `?t=${encodeURIComponent(tk)}`);
  await read(env, blob.hash, bearer(tk));
  const all = env.logs.map((l) => JSON.stringify(l)).join('\n');
  assert.ok(!all.includes(tk), 'The raw ticket does not appear in the log');
  assert.ok(!all.includes(parseTicket(tk).payload), 'The ticket payload segment does not appear in the log');
});

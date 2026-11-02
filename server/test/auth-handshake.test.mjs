/**
 * M6a shared project: WebSocket handshake, challenges, rate limiting, connection tickets (contract
 * `docs/plan/auth-contract.md` sections 4, 5, 6, 8, 9, 11, cases AU2, AU3, AU8, AU14, and
 * cross-checks against `client.mjs`).
 * Run: node --test server/test/auth-handshake.test.mjs
 *
 * Written strictly against the contract, without looking at the implementation. The interfaces
 * to start the service are the test side's assumptions, centralized in the `auth-kit.mjs` header.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import {
  hostFor, createProject, challenge, proofFor, join, joinStatus, newDevice, authItem, proofFields, derive,
  ticketOf, parseTicket, loadClient, PROTOCOL, KDF, waitFor, b64u, credential, uniqueName, ask,
} from './auth-kit.mjs';

const PUBLIC = '203.0.113.20';
const other = (i) => `198.51.100.${i}`;

/** Retrieve the principal of the newly connected connection (find the last one by userId) */
async function principalOf(env, userId) {
  return waitFor(() => env.principals().filter((p) => p?.userId === userId).at(-1), 2000, `principal ${userId}`);
}

// ------------------------------------------------------------------ AU2

test('AU2 open entry: correct proof → handshake 101, echoes only promptcut.v1; principal fields complete', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const dev = newDevice('Laptop');
  const p = await proofFor(env, proj, { username: 'zoe', device: dev, remote: PUBLIC });
  const raw = await env.handshake(p.protocols, PUBLIC);
  assert.equal(raw.status, 101, 'correct proof should give 101');
  assert.equal(raw.protocol, PROTOCOL, 'echoes only promptcut.v1, not the proof item');

  const c = await join(env, proj, { username: 'zoe', device: dev, remote: PUBLIC });
  assert.ok(c);
  const pr = await principalOf(env, `zoe@${dev.deviceId}`);
  assert.equal(pr.userId, `zoe@${dev.deviceId}`);
  assert.equal(pr.tenantId, proj.projectId);
  assert.equal(pr.scope, 'member');
  assert.equal(pr.username, 'zoe');
  assert.equal(pr.deviceId, dev.deviceId);
  assert.equal(pr.deviceName, dev.deviceName);
  assert.equal(pr.creator, false);
  assert.equal(pr.role, 'page');
  assert.ok('conversation' in pr, 'principal has a conversation field');
  assert.ok('owner' in pr, 'principal has an owner field');
  assert.ok(pr.conversation === null || pr.conversation === undefined, 'page connection has no chat number');
});

test('AU2 open entry: the creator gets in with the creator passphrase → creator: true; a member passphrase used as creator → 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const dev = newDevice();
  await join(env, proj, { username: 'alice', as: 'creator', device: dev, remote: PUBLIC });
  const pr = await principalOf(env, `alice@${dev.deviceId}`);
  assert.equal(pr.creator, true);
  assert.equal(pr.scope, 'member');
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', password: proj.password, device: newDevice(), remote: other(1) }), 401);
  // The creator can also enter as a regular member (project passphrase); here creator is false
  const dev2 = newDevice();
  await join(env, proj, { username: 'alice', as: 'member', device: dev2, remote: PUBLIC });
  assert.equal((await principalOf(env, `alice@${dev2.deviceId}`)).creator, false);
});

test('AU2 open entry: wrong proof → 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  assert.equal(await joinStatus(env, proj, { username: 'zoe', password: 'wrong-pw', remote: other(2) }), 401, 'wrong passphrase');
  assert.equal(await joinStatus(env, proj, {
    username: 'zoe', remote: other(3), mutate: (f) => ({ ...f, m: b64u(randomBytes(32)) }),
  }), 401, 'random m');
  assert.equal(await joinStatus(env, proj, {
    username: 'zoe', remote: other(4), mutate: (f) => ({ ...f, m: f.m.slice(0, 20) }),
  }), 401, 'm is not 32 bytes after decoding');
  assert.equal(await joinStatus(env, proj, {
    username: 'zoe', remote: other(5), mutate: (f) => ({ ...f, m: b64u(Buffer.concat([Buffer.from(f.m, 'base64url'), Buffer.from([0])])) }),
  }), 401, 'm is 33 bytes after decoding (the first 32 bytes are correct)');
});

test('AU2 nonce reuse → 401 (the same nonce used again after the first success)', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const p = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  assert.equal((await env.handshake(p.protocols, PUBLIC)).status, 101);
  assert.equal((await env.handshake(p.protocols, PUBLIC)).status, 401, 'same proof reused');
});

test('AU2 a nonce is also voided by one failure: use it up with a wrong proof first, then a correct proof → 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const p = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  const wrong = [PROTOCOL, authItem({ ...p.fields, m: b64u(randomBytes(32)) })];
  assert.equal((await env.handshake(wrong, PUBLIC)).status, 401);
  assert.equal((await env.handshake(p.protocols, PUBLIC)).status, 401, 'nonce is voided right after verification, whether it succeeds or fails');
});

test('AU2 nonce expiry (injected clock, 60 s) → 401; valid within 59 s', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const fresh = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  env.clock.advance(59_000);
  assert.equal((await env.handshake(fresh.protocols, PUBLIC)).status, 101, 'still valid at 59 s');
  const stale = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  env.clock.advance(61_000);
  assert.equal((await env.handshake(stale.protocols, PUBLIC)).status, 401, 'expired after 61 s');
});

test('AU2 four-tuple bound to the nonce (projectId, username, deviceId, as) does not match the proof → 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const proj2 = await createProject(env, { mode: 'free' });
  const dev = newDevice();
  const cases = [
    ['different username', (f) => ({ username: 'zoe2', deviceId: f.d, projectId: f.p, as: f.as })],
    ['different deviceId', (f) => ({ username: f.u, deviceId: newDevice().deviceId, projectId: f.p, as: f.as })],
    ['different projectId', (f) => ({ username: f.u, deviceId: f.d, projectId: proj2.projectId, as: f.as })],
  ];
  let i = 10;
  for (const [what, tuple] of cases) {
    const remote = other(i++);
    const p = await proofFor(env, proj, { username: 'zoe', device: dev, remote });
    const tu = tuple(p.fields);
    // Recompute m with modified 4-tuple (correct passphrase); only the nonce binding mismatches
    const key = tu.projectId === proj.projectId ? p.key : derive(proj2.password, (await challenge(env, { projectId: proj2.projectId, username: tu.username, deviceId: tu.deviceId, remote })).json.salt);
    const f = proofFields({ projectId: tu.projectId, username: tu.username, deviceId: tu.deviceId, deviceName: dev.deviceName, as: tu.as, nonce: p.nonce, key });
    assert.equal((await env.handshake([PROTOCOL, authItem(f)], remote)).status, 401, what);
  }
  // Different as: challenge fetched as member, proof specifies creator (computed with creator passphrase)
  const remote = other(i++);
  const p = await proofFor(env, proj, { username: 'alice', device: dev, remote });
  const ck = derive(proj.creator.password, (await challenge(env, { projectId: proj.projectId, username: 'alice', deviceId: dev.deviceId, as: 'creator', remote })).json.salt);
  const f = proofFields({ projectId: proj.projectId, username: 'alice', deviceId: dev.deviceId, deviceName: dev.deviceName, as: 'creator', nonce: p.nonce, key: ck });
  assert.equal((await env.handshake([PROTOCOL, authItem(f)], remote)).status, 401, 'different as');
});

test('AU2 proof format: unknown r, agent missing c, c not a positive integer, o given on a non-render role, JSON over 1024 bytes, wrong v → 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const cases = [
    ['unknown r', { role: 'admin' }],
    ['agent missing c', { role: 'agent' }],
    ['agent c is 0', { role: 'agent', c: 0 }],
    ['agent c is a decimal', { role: 'agent', c: 1.5 }],
    ['agent c is a string', { role: 'agent', c: '2' }],
    ['page carries o', { role: 'page', o: { kind: 'user' } }],
    ['render o.kind unknown', { role: 'render', o: { kind: 'robot' } }],
    ['render o belongs to an agent but has no c', { role: 'render', o: { kind: 'agent' } }],
  ];
  let i = 30;
  for (const [what, opts] of cases) {
    assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: other(i++), ...opts }), 401, what);
  }
  assert.equal(await joinStatus(env, proj, {
    username: 'zoe', remote: other(i++), mutate: (f) => ({ ...f, pad: 'x'.repeat(1100) }),
  }), 401, 'JSON over 1024 bytes');
  assert.equal(await joinStatus(env, proj, {
    username: 'zoe', remote: other(i++), mutate: (f) => ({ ...f, v: 2 }),
  }), 401, 'v is not 1');
  // All valid variants can enter
  const ok = [
    ['agent c=3', { role: 'agent', c: 3 }],
    ['render owned by a human', { role: 'render', o: { kind: 'user' } }],
    ['render owned by an agent chat', { role: 'render', o: { kind: 'agent', c: 2 } }],
    ['render with no owner', { role: 'render' }],
  ];
  for (const [what, opts] of ok) {
    assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: other(i++), ...opts }), 101, what);
  }
});

test('AU2 at most one authentication item: proof + local claim, proof + ticket, two proofs → 401; no promptcut.v1 in the subprotocols → 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const a = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  const b = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  assert.equal((await env.handshake([PROTOCOL, a.protocols[1], b.protocols[1]], PUBLIC)).status, 401, 'two proofs');
  const c = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  assert.equal((await env.handshake([PROTOCOL, c.protocols[1], `promptcut.tenant.${proj.projectId}`])).status, 401, 'proof + local claim (loopback)');
  const d = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  assert.equal((await env.handshake([PROTOCOL, d.protocols[1], 'promptcut.ticket.v1.abc.def'], PUBLIC)).status, 401, 'proof + ticket');
  const e = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  assert.equal((await env.handshake([e.protocols[1]], PUBLIC)).status, 401, 'no promptcut.v1');
  assert.equal((await env.handshake([PROTOCOL], PUBLIC)).status, 401, 'non-loopback source carrying nothing');
  assert.equal((await env.handshake([PROTOCOL, 'promptcut.auth.not-json!!'], PUBLIC)).status, 401, 'proof is not base64url JSON');
});

test('AU2 loopback source carrying nothing → local identity { userId: local, tenantId: local, scope: local, role: page }', async (t) => {
  for (const attached of [false, true]) {
    const env = await hostFor(t, { attached });
    const hs = await env.handshake([PROTOCOL]);
    assert.equal(hs.status, 101, `attached=${attached}`);
    assert.equal(hs.protocol, PROTOCOL);
    await env.open([PROTOCOL]);
    const pr = await principalOf(env, 'local');
    assert.equal(pr.tenantId, 'local');
    assert.equal(pr.scope, 'local');
    assert.equal(pr.role, 'page');
  }
});

// ------------------------------------------------------------------ AU3

test('AU3 restricted entry: a username on the list succeeds; the creator is automatically on the list (as: member with the creator passphrase also gets in)', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }, { username: 'cara', password: 'cara-pw' }] });
  const dev = newDevice();
  await join(env, proj, { username: 'bob', device: dev, remote: PUBLIC });
  const pr = await principalOf(env, `bob@${dev.deviceId}`);
  assert.equal(pr.tenantId, proj.projectId);
  assert.equal(pr.creator, false);
  assert.equal(await joinStatus(env, proj, { username: 'bob', password: 'cara-pw', remote: other(40) }), 401, 'passphrase of another user');
  assert.equal(await joinStatus(env, proj, { username: 'cara', remote: other(41) }), 101);
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', remote: other(42) }), 101, 'creator gets in as creator');
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'member', password: proj.creator.password, remote: other(43) }), 101, 'creator counts as being on the list');
});

test('AU3 restricted entry: the challenge for a username not on the list has the same shape as for one on the list, and the same name gets the same fake salt twice; the handshake that follows returns 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'restricted' });
  const dev = newDevice();
  const inList = await challenge(env, { projectId: proj.projectId, username: 'bob', deviceId: dev.deviceId, remote: PUBLIC });
  const out1 = await challenge(env, { projectId: proj.projectId, username: 'mallory', deviceId: dev.deviceId, remote: PUBLIC });
  const out2 = await challenge(env, { projectId: proj.projectId, username: 'mallory', deviceId: newDevice().deviceId, remote: other(44) });
  const out3 = await challenge(env, { projectId: proj.projectId, username: 'trudy', deviceId: dev.deviceId, remote: PUBLIC });
  for (const r of [inList, out1, out2, out3]) assert.equal(r.status, 200, r.text);
  const shape = (j) => Object.keys(j).sort().map((k) => [k, typeof j[k], k === 'nonce' || k === 'salt' ? j[k].length : j[k]]);
  const shapeNoVals = (j) => shape(j).map(([k, ty, v]) => [k, ty, (k === 'nonce' || k === 'salt') ? v : (k === 'kdf' ? JSON.stringify(v) : v)]);
  assert.deepEqual(shapeNoVals(out1.json), shapeNoVals(inList.json), 'off-list and on-list have the same shape (keys, types, nonce and salt lengths, kdf, mode)');
  assert.equal(out1.json.salt, out2.json.salt, 'the same username gets the same salt both times (even with a different device or source)');
  assert.notEqual(out1.json.salt, out3.json.salt, 'different usernames get different fake salts');
  assert.notEqual(out1.json.nonce, out2.json.nonce);
  // Handshake: any passphrase derived with dummy salt returns 401
  assert.equal(await joinStatus(env, proj, { username: 'mallory', password: 'guess', remote: other(45) }), 401);
  // as: creator when username is not the creator: likewise returns dummy salt, stable
  const c1 = await challenge(env, { projectId: proj.projectId, username: 'bob', deviceId: dev.deviceId, as: 'creator', remote: PUBLIC });
  const c2 = await challenge(env, { projectId: proj.projectId, username: 'bob', deviceId: dev.deviceId, as: 'creator', remote: PUBLIC });
  assert.equal(c1.status, 200);
  assert.equal(c1.json.salt, c2.json.salt, 'non-creator requesting a challenge as creator: the fake salt is stable');
  assert.notEqual(c1.json.salt, inList.json.salt, 'not the real list salt for bob');
  assert.equal(await joinStatus(env, proj, { username: 'bob', as: 'creator', password: 'bob-pw', remote: other(46) }), 401);
});

test('AU3 fake salt does not change over time (fetched again 10 minutes later on the same service)', async (t) => {
  // Started twice with the same data directory: dummy salt is identical. The data directory is created
  // by startHost; here we only compare twice on the same service (for restarts see report)
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'restricted' });
  const a = await challenge(env, { projectId: proj.projectId, username: 'ghost', deviceId: newDevice().deviceId });
  env.clock.advance(10 * 60_000);
  const b = await challenge(env, { projectId: proj.projectId, username: 'ghost', deviceId: newDevice().deviceId });
  assert.equal(a.json.salt, b.json.salt, 'unchanged as time passes');
});

// ------------------------------------------------------------------ AU8

test('AU8 rate limiting: 5 failures from the same source within 1 minute → challenge returns 429 for 60 s and handshake returns 401 even with a correct passphrase; recovers after 61 s; other sources are unaffected', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const bad = '198.51.100.200';
  const good = '198.51.100.201';
  // Prepare a proof with correct passphrase in advance (nonce fetched before cooldown)
  const held = await proofFor(env, proj, { username: 'zoe', remote: bad });
  for (let i = 0; i < 5; i++) {
    assert.equal(await joinStatus(env, proj, { username: 'zoe', password: `wrong-${i}`, remote: bad }), 401, `failure #${i + 1}`);
  }
  env.clock.advance(1000);
  const ch = await challenge(env, { projectId: proj.projectId, username: 'zoe', deviceId: newDevice().deviceId, remote: bad });
  assert.equal(ch.status, 429, `challenge during cooldown: ${ch.text}`);
  assert.deepEqual(ch.json, { ok: false, error: 'rate-limited' });
  assert.equal((await env.handshake(held.protocols, bad)).status, 401, 'rejected during cooldown even with the correct passphrase');
  // Other origins are unaffected
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: good }), 101, 'other sources work as usual');
  // Still rejected near the end of cooldown (58 s after the 5th failure)
  env.clock.advance(57_000);
  assert.equal((await challenge(env, { projectId: proj.projectId, username: 'zoe', deviceId: newDevice().deviceId, remote: bad })).status, 429, 'still in cooldown at 58 s');
  // Recovers after 61 s
  env.clock.advance(3000);
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: bad }), 101, 'recovers after 61 s');
});

test('AU8 rate-limit threshold: still gets in after 4 failures; failures outside the 1-minute window are not counted', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const src = '198.51.100.210';
  for (let i = 0; i < 4; i++) assert.equal(await joinStatus(env, proj, { username: 'zoe', password: 'nope', remote: src }), 401);
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: src }), 101, 'correct passphrase gets in after 4 failures');
  const src2 = '198.51.100.211';
  for (let i = 0; i < 4; i++) assert.equal(await joinStatus(env, proj, { username: 'zoe', password: 'nope', remote: src2 }), 401);
  env.clock.advance(61_000);
  assert.equal(await joinStatus(env, proj, { username: 'zoe', password: 'nope', remote: src2 }), 401, '5th failure falls outside the one-minute window');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: src2 }), 101, 'does not enter cooldown');
});

test('AU8 rate limiting: a wrong nonce also counts as a failure; loopback sources are not counted', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const src = '198.51.100.220';
  for (let i = 0; i < 5; i++) {
    const p = await proofFor(env, proj, { username: 'zoe', remote: src, mutate: (f) => ({ ...f, nonce: b64u(randomBytes(32)) }) });
    assert.equal((await env.handshake(p.protocols, src)).status, 401, `wrong nonce #${i + 1}`);
  }
  const ch = await challenge(env, { projectId: proj.projectId, username: 'zoe', deviceId: newDevice().deviceId, remote: src });
  assert.equal(ch.status, 429, 'wrong nonce counts as a failure');

  for (let i = 0; i < 7; i++) assert.equal(await joinStatus(env, proj, { username: 'zoe', password: 'nope' }), 401, `loopback failure #${i + 1}`);
  assert.equal(await joinStatus(env, proj, { username: 'zoe' }), 101, 'loopback source is not counted');
});

test('AU8 rate limiting: a wrong proof on a creator operation is counted; during cooldown a creator operation returns rate-limited', async (t) => {
  const { adminOp } = await import('./auth-kit.mjs');
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const src = '198.51.100.230';
  const c = await join(env, proj, { username: 'alice', as: 'creator', remote: src });
  for (let i = 0; i < 5; i++) {
    const r = await adminOp(c, proj, 'unban', { username: 'x', deviceId: newDevice().deviceId }, { badProof: true });
    assert.equal(r.type, 'error');
    assert.equal(r.reason, 'forbidden', `wrong proof #${i + 1}`);
  }
  const r = await adminOp(c, proj, 'unban', { username: 'x', deviceId: newDevice().deviceId });
  assert.equal(r.type, 'error', `in cooldown: ${JSON.stringify(r)}`);
  assert.equal(r.reason, 'rate-limited');
  assert.equal((await challenge(env, { projectId: proj.projectId, username: 'alice', deviceId: newDevice().deviceId, remote: src })).status, 429, 'challenge also returns 429');
  env.clock.advance(61_000);
  const ok = await adminOp(c, proj, 'unban', { username: 'x', deviceId: newDevice().deviceId });
  assert.equal(ok.type, 'shared.admin.ok', `recovers after 61 s: ${JSON.stringify(ok)}`);
});

// ------------------------------------------------------------------ AU14

test('AU14 connection ticket: the page requests a render ticket, another connection enters with it, with the same identity as the page and role render; 401 after expiry', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const dev = newDevice();
  const page = await join(env, proj, { username: 'zoe', device: dev, remote: PUBLIC });
  const pagePr = await principalOf(env, `zoe@${dev.deviceId}`);
  const tk = await ticketOf(page, { kind: 'conn', role: 'render', owner: { kind: 'user' } });
  const body = parseTicket(tk.ticket).body;
  assert.equal(body.k, 'conn');
  assert.equal(body.p, proj.projectId);
  assert.equal(body.u, `zoe@${dev.deviceId}`);
  assert.equal(body.r, 'render');
  assert.ok(body.exp - body.iat <= 2 * 60_000, 'connection ticket lifetime is at most 2 minutes');
  assert.equal(tk.exp, body.exp, 'auth.ticket.ok.exp matches the exp in the ticket');
  assert.match(tk.ticket, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'ticket shape v1.<payload>.<signature>, without =');

  const before = env.principals().length;
  const hs = await env.handshake([PROTOCOL, `promptcut.ticket.${tk.ticket}`], other(60));
  assert.equal(hs.status, 101);
  assert.equal(hs.protocol, PROTOCOL);
  const r = await env.open([PROTOCOL, `promptcut.ticket.${tk.ticket}`], other(61));
  assert.ok(r);
  await waitFor(() => env.principals().length >= before + 1, 2000, 'second connection registered');
  const rendPr = env.principals().filter((p) => p.userId === pagePr.userId && p.role === 'render').at(-1);
  assert.ok(rendPr, `connection that came in with the ticket: ${JSON.stringify(env.principals())}`);
  for (const k of ['userId', 'tenantId', 'scope', 'username', 'deviceId', 'deviceName', 'creator']) {
    assert.deepEqual(rendPr[k], pagePr[k], `identity field ${k} is the same as the page`);
  }
  assert.equal(rendPr.role, 'render');
  assert.deepEqual(rendPr.owner, { kind: 'user' });

  // Expired: after 2 minutes + 30 s skew
  env.clock.advance(2 * 60_000 + 31_000);
  assert.equal((await env.handshake([PROTOCOL, `promptcut.ticket.${tk.ticket}`], other(62))).status, 401, '401 after expiry');
});

test('AU14 connection ticket: agent role carries a chat number; wrong signature gives 401; an asset ticket cannot be used as a connection ticket; a local identity cannot get a ticket', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const dev = newDevice();
  const page = await join(env, proj, { username: 'zoe', device: dev, remote: PUBLIC });
  const tk = await ticketOf(page, { kind: 'conn', role: 'agent', conversation: 4 });
  await env.open([PROTOCOL, `promptcut.ticket.${tk.ticket}`], other(63));
  const pr = await waitFor(() => env.principals().find((p) => p.role === 'agent' && p.userId === `zoe@${dev.deviceId}`), 2000, 'agent connection');
  assert.equal(pr.conversation, 4);

  const bad = tk.ticket.slice(0, -1) + (tk.ticket.at(-1) === 'A' ? 'B' : 'A');
  assert.equal((await env.handshake([PROTOCOL, `promptcut.ticket.${bad}`], other(64))).status, 401, 'wrong signature');
  const asset = await ticketOf(page, { kind: 'asset', access: 'r' });
  assert.equal(parseTicket(asset.ticket).body.k, 'asset');
  assert.equal((await env.handshake([PROTOCOL, `promptcut.ticket.${asset.ticket}`], other(65))).status, 401, 'asset ticket cannot be used to connect');

  const local = await env.open([PROTOCOL]);
  const r = await ask(local, { type: 'auth.ticket', kind: 'conn', role: 'render' }, 'auth.ticket.ok');
  assert.equal(r.type, 'error', `local identity cannot get a ticket: ${JSON.stringify(r)}`);
});

// ------------------------------------------------------------------ client.mjs cross-check (sections 2 and 11)

test('AU2 client.mjs: deriveKey cross-checked against node:crypto PBKDF2; subprotocols assembled by buildAuthProtocols get in; ticketExpiry reads out exp', async (t) => {
  const client = await loadClient();
  const salt = b64u(randomBytes(16));
  const k = await client.deriveKey('pässwörd-口令', salt, KDF);
  const got = typeof k === 'string' ? k : b64u(k);
  const want = pbkdf2Sync(Buffer.from('pässwörd-口令', 'utf8'), Buffer.from(salt, 'base64url'), KDF.iter, 32, 'sha256').toString('base64url');
  assert.equal(got, want, 'deriveKey = PBKDF2-HMAC-SHA256(passphrase as UTF-8, the 16 bytes of the salt, iter, 32)');

  const env = await hostFor(t);
  // Create project using deriveKey from client.mjs, then enter using buildAuthProtocols
  const csalt = b64u(randomBytes(16));
  const psalt = b64u(randomBytes(16));
  const toB64 = (x) => (typeof x === 'string' ? x : b64u(x));
  const name = uniqueName('client');
  const r = await env.http('shared/create', {
    method: 'POST',
    body: {
      name, mode: 'free', kdf: KDF,
      creator: { username: 'alice', salt: csalt, key: toB64(await client.deriveKey('c-pw', csalt, KDF)) },
      project: { salt: psalt, key: toB64(await client.deriveKey('p-pw', psalt, KDF)) },
    },
  });
  assert.equal(r.status, 201, r.text);
  const dev = newDevice();
  const protocols = await client.buildAuthProtocols({
    base: env.httpBase, projectId: r.json.projectId, username: 'zoe', deviceId: dev.deviceId, deviceName: dev.deviceName,
    as: 'member', password: 'p-pw', role: 'page',
  });
  assert.ok(Array.isArray(protocols) && protocols.includes(PROTOCOL), `buildAuthProtocols returns a subprotocol array: ${JSON.stringify(protocols)}`);
  const c = await env.open(protocols);
  const tk = await ticketOf(c, { kind: 'asset', access: 'r' });
  assert.equal(client.ticketExpiry(tk.ticket), tk.exp);
  // Assembling again with the same parameters (new nonce needed each time) can also enter
  const again = await client.buildAuthProtocols({
    base: env.httpBase, projectId: r.json.projectId, username: 'alice', deviceId: dev.deviceId, deviceName: dev.deviceName,
    as: 'creator', password: 'c-pw', role: 'render', owner: { kind: 'user' },
  });
  assert.equal((await env.handshake(again)).status, 101);
  // Use key instead of password
  const again2 = await client.buildAuthProtocols({
    base: env.httpBase, projectId: r.json.projectId, username: 'zoe', deviceId: dev.deviceId, deviceName: dev.deviceName,
    as: 'member', key: toB64(await client.deriveKey('p-pw', psalt, KDF)), role: 'agent', conversation: 2,
  });
  assert.equal((await env.handshake(again2)).status, 101);
  // K derived from the same credential in test tools matches client (showing both understand salt
  // identically)
  assert.equal(derive('p-pw', psalt), toB64(await client.deriveKey('p-pw', psalt, KDF)));
  void credential;
});

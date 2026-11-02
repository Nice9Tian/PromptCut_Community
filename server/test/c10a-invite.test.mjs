/**
 * C10a 邀请码的契约测试（`docs/plan/c10a-contract.md` 第 5 节、第 12 节「邀请码」一条）。
 * 跑：node --test server/test/c10a-invite.test.mjs
 *
 * 服务端用 `auth-kit.mjs` 组装的共享项目文档服务（真 HTTP、真 WebSocket），创建者操作按 auth 契约第 7 节现算证明。
 * 假设的接口见 `c10a-kit.mjs` 的 K1；端点不在时整组 skip（原因里写「接口缺失」）。
 *
 * 来源地址：回环来源不计入限速（auth 契约第 9 节），所以除了限速那几条，请求都从回环发；
 * 限速用例用 `__remote` 模拟公网来源（`auth-kit.mjs` 文件头）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostFor, createProject, join, joinStatus, newDevice, adminOp, credential, derive, logText, uniqueName, KDF,
} from './auth-kit.mjs';
import {
  inviteSupport, skipIf, resolveInvite, redeemInvite, inviteStatusOf, newInviteCode, INVITE_CODE_RE,
  INVITE_DEFAULT_TTL_MS, filesContaining,
} from './c10a-kit.mjs';

const support = await inviteSupport();
const skip = skipIf(!support.ok, `Invite code endpoints shared/invite/* (${support.detail})`);
const it = (name, fn) => test(name, { skip }, fn);

const INVALID = Object.freeze({ ok: false, error: 'invite-invalid' });
const R = (i) => `203.0.113.${10 + i}`;

/** 建项目、创建者进入、签发邀请码 */
async function setup(t, { mode = 'free', fields = {}, host = {} } = {}) {
  const env = await hostFor(t, host);
  const proj = await createProject(env, { mode });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  const r = await adminOp(creator, proj, 'invite-create', fields);
  assert.equal(r.type, 'shared.admin.ok', `invite-create: ${JSON.stringify(r)}`);
  return { env, proj, creator, invite: r, code: r.code };
}

const status = async (creator, proj) => inviteStatusOf(await adminOp(creator, proj, 'invite-status'));

// ------------------------------------------------------------------ 签发、解析

it('C10A-IV-01 issuing: 43-character base64url; default 7 days, unlimited uses; the plaintext appears only in the issue response; resolve returns the project name and mode and does not consume a use', async (t) => {
  const { env, proj, creator, invite, code } = await setup(t);
  assert.equal(invite.op, 'invite-create');
  assert.match(code, INVITE_CODE_RE, 'The invite code is a 32-byte base64url (43 characters, no padding)');
  assert.equal(invite.maxUses, null, 'Uses are unlimited by default');
  assert.ok(Math.abs(invite.expiresAt - (env.clock.now() + INVITE_DEFAULT_TTL_MS)) < 10_000, `Default validity is 7 days: expiresAt=${invite.expiresAt}`);

  for (let i = 0; i < 3; i++) {
    const r = await resolveInvite(env, code);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual({ ok: r.json.ok, projectId: r.json.projectId, name: r.json.name, mode: r.json.mode },
      { ok: true, projectId: proj.projectId, name: proj.name, mode: 'free' });
    assert.equal(r.text.includes(code), false, 'The resolve response does not carry the plaintext');
    assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  }
  const st = await status(creator, proj);
  assert.equal(st.used, 0, 'resolve does not consume a use');
  assert.equal(st.active, true);
  assert.equal(st.maxUses, null);
  assert.equal(st.revokedAt ?? null, null);
  assert.ok(Math.abs(st.expiresAt - invite.expiresAt) < 1000);
  assert.equal(JSON.stringify(st).includes(code), false, 'invite-status does not contain the plaintext');
});

it('C10A-IV-02 validity and uses can be set when issuing; issuing again revokes the old one at the same time (only one valid invite code)', async (t) => {
  const { env, proj, creator, code: first } = await setup(t, { fields: { expiresInSec: 3600, maxUses: 5 } });
  let st = await status(creator, proj);
  assert.equal(st.maxUses, 5);
  assert.ok(Math.abs(st.expiresAt - (env.clock.now() + 3600_000)) < 10_000);
  const again = await adminOp(creator, proj, 'invite-create');
  assert.equal(again.type, 'shared.admin.ok', JSON.stringify(again));
  assert.notEqual(again.code, first);
  const oldR = await resolveInvite(env, first);
  assert.equal(oldR.status, 404);
  assert.deepEqual(oldR.json, INVALID, 'The old one is revoked');
  assert.equal((await resolveInvite(env, again.code)).status, 200, 'The new one is valid');
  st = await status(creator, proj);
  assert.equal(st.maxUses, null, 'A newly issued one goes back to the defaults');
  assert.equal(st.used, 0);
});

it('C10A-IV-03 revoke: resolve and redeem always give invite-invalid; invite-status is no longer valid and carries revokedAt; people who already joined are unaffected', async (t) => {
  const { env, proj, creator, code } = await setup(t);
  const dev = newDevice('Phone');
  const got = await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId });
  assert.equal(got.status, 200, got.text);
  const r = await adminOp(creator, proj, 'invite-revoke');
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  assert.deepEqual((await resolveInvite(env, code)).json, INVALID);
  const again = await redeemInvite(env, { code, username: 'yan', deviceId: newDevice().deviceId });
  assert.equal(again.status, 404);
  assert.deepEqual(again.json, INVALID);
  const st = await status(creator, proj);
  assert.equal(st.active, false);
  assert.equal(typeof st.revokedAt, 'number');
  // 作废不影响已经进来的人：凭兑换得到的 K 照常握手
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, key: got.json.project.key }), 101);
});

it('C10A-IV-04 time limit: usable until it expires; after expiry resolve / redeem both give invite-invalid, and the status is no longer valid', async (t) => {
  const { env, proj, creator, code } = await setup(t, { fields: { expiresInSec: 60 } });
  assert.equal((await resolveInvite(env, code)).status, 200);
  env.clock.advance(30_000);
  assert.equal((await redeemInvite(env, { code, username: 'zoe', deviceId: newDevice().deviceId })).status, 200, 'Still valid at 30 s');
  env.clock.advance(31_000);
  assert.deepEqual((await resolveInvite(env, code)).json, INVALID, 'expired after 61 s');
  const r = await redeemInvite(env, { code, username: 'yan', deviceId: newDevice().deviceId });
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, INVALID);
  assert.equal((await status(creator, proj)).active, false);
});

it('C10A-IV-05 use limit: maxUses 2 → two devices redeem successfully, the third gets invite-invalid; once used up, resolve also gives invite-invalid', async (t) => {
  const { env, proj, creator, code } = await setup(t, { fields: { maxUses: 2 } });
  for (const name of ['u1', 'u2']) {
    const r = await redeemInvite(env, { code, username: name, deviceId: newDevice().deviceId });
    assert.equal(r.status, 200, `${name}: ${r.text}`);
  }
  const third = await redeemInvite(env, { code, username: 'u3', deviceId: newDevice().deviceId });
  assert.equal(third.status, 404);
  assert.deepEqual(third.json, INVALID);
  assert.deepEqual((await resolveInvite(env, code)).json, INVALID, 'Uses exhausted: resolve follows the same rule');
  const st = await status(creator, proj);
  assert.equal(st.used, 2);
  assert.equal(st.maxUses, 2);
  assert.equal(st.active, false);
});

it('C10A-IV-06 redeeming again with the same userId (username + device) does not consume another use; a different username or device counts as a new userId', async (t) => {
  const { env, proj, creator, code } = await setup(t, { fields: { maxUses: 1 } });
  const dev = newDevice('Pad');
  for (let i = 0; i < 3; i++) {
    const r = await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId });
    assert.equal(r.status, 200, `Attempt ${i + 1}: ${r.text}`);
  }
  assert.equal((await status(creator, proj)).used, 1, 'The same userId consumes only one use');
  assert.deepEqual((await redeemInvite(env, { code, username: 'zoe2', deviceId: dev.deviceId })).json, INVALID, 'same device with a different username is a different userId');
  assert.deepEqual((await redeemInvite(env, { code, username: 'zoe', deviceId: newDevice().deviceId })).json, INVALID, 'same username on a different device is a different userId');
  assert.equal((await status(creator, proj)).used, 1);
});

it('C10A-IV-07 invite-invalid has one uniform shape: unknown, revoked, expired and used-up codes give byte-identical status codes and response bodies', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  const bodies = { resolve: new Map(), redeem: new Map() };
  const record = async (label, code) => {
    const a = await resolveInvite(env, code);
    const b = await redeemInvite(env, { code, username: 'probe', deviceId: newDevice().deviceId });
    bodies.resolve.set(label, `${a.status} ${a.text}`);
    bodies.redeem.set(label, `${b.status} ${b.text}`);
  };
  await record('unknown', newInviteCode());
  const revoked = (await adminOp(creator, proj, 'invite-create')).code;
  await adminOp(creator, proj, 'invite-revoke');
  await record('revoked', revoked);
  const expired = (await adminOp(creator, proj, 'invite-create', { expiresInSec: 10 })).code;
  env.clock.advance(11_000);
  await record('expired', expired);
  const used = (await adminOp(creator, proj, 'invite-create', { maxUses: 1 })).code;
  assert.equal((await redeemInvite(env, { code: used, username: 'first', deviceId: newDevice().deviceId })).status, 200);
  await record('used up', used);
  for (const [ep, map] of Object.entries(bodies)) {
    const values = [...map.values()];
    assert.equal(new Set(values).size, 1, `${ep} all four cases should be identical: ${JSON.stringify(Object.fromEntries(map))}`);
    const [code, ...rest] = values[0].split(' ');
    assert.equal(code, '404');
    assert.deepEqual(JSON.parse(rest.join(' ')), INVALID);
  }
});

// ------------------------------------------------------------------ 兑换：K、禁入

it('C10A-IV-08 open entry returns K: K equals the K derived from the project password, the normal handshake works with it; resolve does not return K', async (t) => {
  const { env, proj, code } = await setup(t);
  const dev = newDevice('Phone');
  const r = await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId });
  assert.equal(r.status, 200, r.text);
  const j = r.json;
  assert.deepEqual({ ok: j.ok, projectId: j.projectId, name: j.name, mode: j.mode }, { ok: true, projectId: proj.projectId, name: proj.name, mode: 'free' });
  assert.deepEqual(j.kdf, KDF, 'kdf is returned as is');
  assert.equal(typeof j.project?.salt, 'string');
  assert.equal(j.project.key, derive(proj.password, j.project.salt, j.kdf), 'K = KDF(project password, salt)');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, key: j.project.key }), 101, 'handshake with K');
  const res = await resolveInvite(env, code);
  assert.equal(res.json.project, undefined, 'resolve does not return K');
  assert.equal(res.text.includes(j.project.key), false);
});

it('C10A-IV-09 restricted entry does not return K: only { ok, projectId, name, mode } is returned, and redeeming consumes a use immediately; afterwards entry is by the passphrase in the list', async (t) => {
  const { env, proj, creator, code } = await setup(t, { mode: 'restricted' });
  const dev = newDevice('Phone');
  const r = await redeemInvite(env, { code, username: 'bob', deviceId: dev.deviceId });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, projectId: proj.projectId, name: proj.name, mode: 'restricted' });
  assert.equal((await status(creator, proj)).used, 1, 'restricted entry consumes a use at redeem time');
  assert.equal(await joinStatus(env, proj, { username: 'bob', device: dev }), 101, 'the passphrase in the list still gets in as usual');
});

it('C10A-IV-10 changing the project password leaves invite codes alone: the old code still works, redeeming returns the new K, and the old K can no longer get in', async (t) => {
  const { env, proj, creator, code } = await setup(t);
  const dev = newDevice();
  const before = (await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId })).json.project;
  const r = await adminOp(creator, proj, 'set-password', { project: credential('pw-2') });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  assert.equal((await resolveInvite(env, code)).status, 200, 'invite code is unaffected');
  const after = await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId });
  assert.equal(after.status, 200, after.text);
  assert.equal(after.json.project.key, derive('pw-2', after.json.project.salt, after.json.kdf), 'returns the K of the new password');
  assert.notEqual(after.json.project.key, before.key);
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, key: before.key }), 401, 'old K is invalid');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, key: after.json.project.key }), 101);
});

it('C10A-IV-11 ban: redeeming for a kicked (username, device) returns 401 banned; the same username on another device is unaffected; redeeming works again after unban', async (t) => {
  const { env, proj, creator, code } = await setup(t);
  const dev = newDevice('Laptop');
  const zoe = await join(env, proj, { username: 'zoe', device: dev });
  const k = await adminOp(creator, proj, 'kick', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal(k.type, 'shared.admin.ok', JSON.stringify(k));
  await zoe.closed;
  const r = await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId });
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { ok: false, error: 'banned' });
  assert.equal((await redeemInvite(env, { code, username: 'zoe', deviceId: newDevice().deviceId })).status, 200, 'bans apply per (username, device)');
  await adminOp(creator, proj, 'unban', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal((await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId })).status, 200, 'after unban');
});

// ------------------------------------------------------------------ 限速

for (const ep of ['resolve', 'redeem']) {
  it(`C10A-IV-12 rate limit (${ep}): after 5 failures from the same source, everything within 60 s gets 429 rate-limited (even a correct code is rejected), another source is unaffected, and it recovers after 61 s`, async (t) => {
    const { env, code } = await setup(t);
    const call = (c, remote) => (ep === 'resolve'
      ? resolveInvite(env, c, { remote })
      : redeemInvite(env, { code: c, username: 'zoe', deviceId: 'rate-device-000001' }, { remote }));
    for (let i = 0; i < 5; i++) await call(newInviteCode(), R(1));
    const blocked = await call(code, R(1));
    assert.equal(blocked.status, 429, `a correct code is also rejected during cooldown: ${blocked.status} ${blocked.text}`);
    assert.equal(blocked.json?.error, 'rate-limited');
    const other = ep === 'resolve' ? 'redeem' : 'resolve';
    const cross = other === 'resolve' ? await resolveInvite(env, code, { remote: R(1) }) : await redeemInvite(env, { code, username: 'zoe', deviceId: 'rate-device-000001' }, { remote: R(1) });
    assert.equal(cross.status, 429, `${other} from the same source is also cooling down`);
    assert.equal((await call(code, R(2))).status, 200, 'another source is unaffected');
    env.clock.advance(61_000);
    assert.equal((await call(code, R(1))).status, 200, 'recovers after 61 s');
  });
}

it('C10A-IV-13 failures from a loopback source do not count toward the rate limit', async (t) => {
  const { env, code } = await setup(t);
  for (let i = 0; i < 8; i++) assert.equal((await resolveInvite(env, newInviteCode())).status, 404);
  assert.equal((await resolveInvite(env, code)).status, 200);
});

// ------------------------------------------------------------------ 创建者操作、存储、日志

it('C10A-IV-14 all three ops need creator proof: a member, no proof, or wrong proof is always forbidden, and none takes effect', async (t) => {
  const { env, proj, creator, code } = await setup(t);
  const member = await join(env, proj, { username: 'zoe' });
  for (const op of ['invite-create', 'invite-revoke', 'invite-status']) {
    const asMember = await adminOp(member, proj, op, {}, { password: proj.password, username: 'zoe' });
    assert.equal(asMember.reason, 'forbidden', `${op} member: ${JSON.stringify(asMember)}`);
    assert.equal((await adminOp(creator, proj, op, {}, { noProof: true })).reason, 'forbidden', `${op} without proof`);
    assert.equal((await adminOp(creator, proj, op, {}, { badProof: true })).reason, 'forbidden', `${op} with wrong proof`);
    assert.equal(JSON.stringify(asMember).includes(code), false);
  }
  assert.equal((await resolveInvite(env, code)).status, 200, 'the original code is still valid: neither revoked nor replaced');
});

it('C10A-IV-15 plaintext never reaches disk or logs: no file in the data directory contains the invite code in plaintext, and no log line does either', async (t) => {
  const { env, proj, creator, code } = await setup(t, { fields: { maxUses: 3 } });
  await resolveInvite(env, code);
  await redeemInvite(env, { code, username: 'zoe', deviceId: newDevice().deviceId });
  await resolveInvite(env, code, { remote: R(20) });
  await redeemInvite(env, { code, username: 'yan', deviceId: newDevice().deviceId }, { remote: R(20) });
  await status(creator, proj);
  // 再签发一个，确保旧记录被改写之后同样不含原文
  const second = (await adminOp(creator, proj, 'invite-create')).code;
  for (const c of [code, second]) {
    assert.deepEqual(filesContaining(env.dataDir, c), [], `the data directory contains the plaintext ${c.slice(0, 6)}…`);
    assert.equal(logText(env).includes(c), false, 'the log contains the plaintext');
  }
});

it('C10A-IV-16 deleting a project: its invite codes are deleted with it, and resolve returns invite-invalid', async (t) => {
  const { env, proj, creator, code } = await setup(t);
  const r = await adminOp(creator, proj, 'delete');
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  const res = await resolveInvite(env, code);
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, INVALID);
});

it('C10A-IV-17 HTTP shape: no-store, Access-Control-Allow-Origin *, answers the OPTIONS preflight', async (t) => {
  const { env, code } = await setup(t);
  for (const rel of ['shared/invite/resolve', 'shared/invite/redeem']) {
    const pre = await env.http(rel, { method: 'OPTIONS', headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    assert.ok(pre.status >= 200 && pre.status < 300, `${rel} OPTIONS: ${pre.status}`);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  }
  const r = await resolveInvite(env, code);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  const bad = await redeemInvite(env, { code: newInviteCode(), username: 'zoe', deviceId: newDevice().deviceId });
  assert.match(bad.headers.get('cache-control') ?? '', /no-store/);
});

it('C10A-IV-18 mount mode (LAN host) implements the same set of endpoints and ops: <WS path>/shared/invite/…', async (t) => {
  const { env, proj, code } = await setup(t, { host: { attached: true } });
  assert.equal(env.attached, true);
  const r = await resolveInvite(env, code, { remote: '192.168.1.50' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.projectId, proj.projectId);
  const dev = newDevice('LanPhone');
  const red = await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId }, { remote: '192.168.1.50' });
  assert.equal(red.status, 200, red.text);
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, key: red.json.project.key, remote: '192.168.1.50' }), 101);
});

it('C10A-IV-19 invite codes of two projects are independent: each resolves to its own project, and revoking one does not affect the other', async (t) => {
  const env = await hostFor(t);
  const a = await createProject(env, { mode: 'free', name: uniqueName('inv-a') });
  const b = await createProject(env, { mode: 'restricted', name: uniqueName('inv-b') });
  const ca = await join(env, a, { username: a.creator.username, as: 'creator' });
  const cb = await join(env, b, { username: b.creator.username, as: 'creator' });
  const codeA = (await adminOp(ca, a, 'invite-create')).code;
  const codeB = (await adminOp(cb, b, 'invite-create')).code;
  assert.equal((await resolveInvite(env, codeA)).json.projectId, a.projectId);
  assert.equal((await resolveInvite(env, codeB)).json.projectId, b.projectId);
  await adminOp(ca, a, 'invite-revoke');
  assert.deepEqual((await resolveInvite(env, codeA)).json, INVALID);
  assert.equal((await resolveInvite(env, codeB)).json.mode, 'restricted');
});

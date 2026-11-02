/**
 * C6.5 补的创建者操作(`server/docservice/modules/shared.mjs`):`set-creator-password`、`list-bans`,
 * 以及 `set-password` 之后发给在线成员的 `shared.notice { event: 'password-changed' }`。
 * 跑:node --test server/test/c65-shared-admin.test.mjs
 *
 * 依据:`docs/plan/c65-design.md` 第 9 节裁定(创建者能改自己的密码,另加 `set-creator-password`,带创建者证明),
 * 2026-09-26 主会话裁定:改完旧密码不能以创建者身份进入、新密码可以,之后的创建者操作按新密码算证明;
 * 成员 / 不带证明 / 证明错回 forbidden;**不作废已发票据**(不加代数)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostFor, createProject, join, joinStatus, newDevice, adminOp, credential, ticketOf, parseTicket, uploadLocal, bearer, waitFor,
} from './auth-kit.mjs';

const R = (i) => `198.51.100.${200 + i}`;

for (const mode of ['free', 'restricted']) {
  test(`C65-SA1 set-creator-password(${mode}): the old password can no longer enter as creator and the new one can; later creator operations compute their proof from the new password`, async (t) => {
    const env = await hostFor(t);
    const proj = await createProject(env, { mode, ...(mode === 'restricted' ? { list: [{ username: 'bob', password: 'bob-pw' }] } : {}) });
    const creator = await join(env, proj, { username: proj.creator.username, as: 'creator', remote: R(1) });
    const r = await adminOp(creator, proj, 'set-creator-password', { creator: credential('creator-new') });
    assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
    assert.equal(r.op, 'set-creator-password');

    assert.equal(await joinStatus(env, proj, { username: proj.creator.username, as: 'creator', remote: R(2) }), 401, 'old creator password');
    assert.equal(await joinStatus(env, proj, { username: proj.creator.username, as: 'creator', password: 'creator-new', remote: R(3) }), 101, 'new creator password');

    // 之后的创建者操作:旧密码算的证明 forbidden,新密码的成功
    const old = await adminOp(creator, proj, 'list-bans', {}, { password: proj.creator.password });
    assert.equal(old.type, 'error');
    assert.equal(old.reason, 'forbidden');
    const ok = await adminOp(creator, proj, 'list-bans', {}, { password: 'creator-new' });
    assert.equal(ok.type, 'shared.admin.ok', JSON.stringify(ok));
    assert.deepEqual(ok.bans, []);
    // 在线连接不断
    assert.equal(creator.ws.readyState, 1);
  });
}

test('C65-SA2 set-creator-password does not revoke tickets already issued (generation not incremented)', async (t) => {
  const env = await hostFor(t, { assets: true });
  const blob = await uploadLocal(env);
  const proj = await createProject(env, { mode: 'free' });
  const member = await join(env, proj, { username: 'zoe', device: newDevice(), remote: '192.168.1.91' });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator', remote: '192.168.1.92' });
  const before = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  const r = await adminOp(creator, proj, 'set-creator-password', { creator: credential('rotated-creator') });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  const read = await env.asset(`media/${blob.hash}`, { remote: '192.168.1.91', headers: bearer(before) });
  assert.equal(read.status, 200, 'the old ticket is still valid');
  const after = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  assert.equal(parseTicket(after).body.g, parseTicket(before).body.g, 'project generation unchanged');
});

test('C65-SA3 set-creator-password: a member, no proof, or wrong proof is always forbidden; wrong fields return bad-message', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator', remote: R(10) });
  const member = await join(env, proj, { username: 'zoe', remote: R(11) });
  const cred = { creator: credential('x-new') };
  const asMember = await adminOp(member, proj, 'set-creator-password', cred, { password: proj.password, username: 'zoe' });
  assert.equal(asMember.reason, 'forbidden', JSON.stringify(asMember));
  assert.equal((await adminOp(creator, proj, 'set-creator-password', cred, { noProof: true })).reason, 'forbidden');
  assert.equal((await adminOp(creator, proj, 'set-creator-password', cred, { badProof: true })).reason, 'forbidden');
  const bad = await adminOp(creator, proj, 'set-creator-password', { creator: { salt: 'x' } });
  assert.equal(bad.type, 'error');
  assert.equal(bad.reason, 'bad-message');
  // 都没生效:旧密码照样能以创建者进入
  assert.equal(await joinStatus(env, proj, { username: proj.creator.username, as: 'creator', remote: R(12) }), 101);
});

test('C65-SA4 list-bans lists the ban list; an entry appears after kick and disappears after unban', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator', remote: R(20) });
  const dev = newDevice('Laptop');
  const zoe = await join(env, proj, { username: 'zoe', device: dev, remote: R(21) });
  assert.deepEqual((await adminOp(creator, proj, 'list-bans')).bans, []);
  assert.equal((await adminOp(creator, proj, 'kick', { username: 'zoe', deviceId: dev.deviceId })).type, 'shared.admin.ok');
  await zoe.closed;
  assert.deepEqual((await adminOp(creator, proj, 'list-bans')).bans, [{ username: 'zoe', deviceId: dev.deviceId }]);
  assert.equal((await adminOp(creator, proj, 'unban', { username: 'zoe', deviceId: dev.deviceId })).type, 'shared.admin.ok');
  assert.deepEqual((await adminOp(creator, proj, 'list-bans')).bans, []);
  assert.equal((await adminOp(creator, proj, 'list-bans', {}, { badProof: true })).reason, 'forbidden');
});

test('C65-SA5 after set-password, each of the other online connections in this space receives one shared.notice password-changed, and the connections stay open', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator', remote: R(30) });
  const zoe = await join(env, proj, { username: 'zoe', remote: R(31) });
  const other = await createProject(env, { mode: 'free' });
  const outsider = await join(env, other, { username: 'yan', remote: R(32) });
  const r = await adminOp(creator, proj, 'set-password', { project: credential('pw-2') });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  await waitFor(() => zoe.all.some((m) => m.type === 'shared.notice' && m.event === 'password-changed'), 3000, 'the member receives the password-changed notice');
  assert.equal(creator.all.some((m) => m.type === 'shared.notice'), false, 'the party that changed the password does not receive it');
  assert.equal(outsider.all.some((m) => m.type === 'shared.notice'), false, 'members of other projects do not receive it');
  assert.equal(zoe.ws.readyState, 1, 'live connection stays up');
});

test('C65-SA6 restricted entry: list-bans also carries the usernames in the list; { username, keep: true } in set-list keeps the original passphrase, and keep for someone not in the list returns bad-message', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }, { username: 'cai', password: 'cai-pw' }] });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator', remote: R(40) });
  const read = await adminOp(creator, proj, 'list-bans');
  assert.deepEqual(read.list, ['bob', 'cai']);
  assert.equal(JSON.stringify(read).includes('"salt"'), false, 'no salt and no K');
  // 留 bob 原口令、删 cai、加 dan
  const r = await adminOp(creator, proj, 'set-list', { list: [{ username: 'bob', keep: true }, credential('dan-pw', 'dan')] });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  proj.list = [{ username: 'bob', password: 'bob-pw' }, { username: 'dan', password: 'dan-pw' }, { username: 'cai', password: 'cai-pw' }];
  assert.equal(await joinStatus(env, proj, { username: 'bob', remote: R(41) }), 101, 'bob keeps the original passphrase');
  assert.equal(await joinStatus(env, proj, { username: 'dan', remote: R(42) }), 101, 'newly added dan');
  assert.equal(await joinStatus(env, proj, { username: 'cai', remote: R(43) }), 401, 'cai is removed');
  assert.deepEqual((await adminOp(creator, proj, 'list-bans')).list, ['bob', 'dan']);
  const bad = await adminOp(creator, proj, 'set-list', { list: [{ username: 'zed', keep: true }] });
  assert.equal(bad.reason, 'bad-message', JSON.stringify(bad));
  const free = await createProject(env, { mode: 'free' });
  const fc = await join(env, free, { username: free.creator.username, as: 'creator', remote: R(44) });
  assert.equal((await adminOp(fc, free, 'list-bans')).list, undefined, 'open entry carries no list');
});

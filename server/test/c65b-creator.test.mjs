/**
 * C6.5 第二批：创建者改自己的密码（`set-creator-password`）。用例 C65B-A-*。
 * 跑：node --test server/test/c65b-creator.test.mjs
 *
 * 依据：`docs/plan/c65-design.md` 第 9 节裁定（「创建者能不能改自己的密码：能……另加操作 set-creator-password（带创建者证明）」）；
 * `docs/plan/auth-contract.md` 第 7 节（证明的算法、不是创建者 / 不带证明一律 forbidden）。
 * 起服务、派生、证明沿用 `auth-kit.mjs`；新操作的字段是假设 B6（`c65b-kit.mjs`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostFor, createProject, join, joinStatus, adminOp, credential, sleep } from './auth-kit.mjs';
import { SET_CREATOR_PASSWORD, creatorPasswordFields } from './c65b-kit.mjs';

const R = (i) => `198.51.100.${100 + i}`;
const NEW_PW = 'creator-new-pw';

test('C65B-A-01 changing the creator password with a creator proof (open entry): succeeds; the old password can no longer join as creator, the new password can; later creator operations need the new password', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(1) });

  const r = await adminOp(creator, proj, SET_CREATOR_PASSWORD, creatorPasswordFields(credential(NEW_PW)));
  assert.equal(r.type, 'shared.admin.ok', `set-creator-password should succeed: ${JSON.stringify(r)}`);

  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', remote: R(2) }), 401, 'old creator password cannot join');
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', password: NEW_PW, remote: R(3) }), 101, 'new creator password can join');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: R(4) }), 101, 'project password is unaffected');

  const oldProof = await adminOp(creator, proj, 'set-password', { project: credential('p2') });
  assert.deepEqual([oldProof.type, oldProof.reason], ['error', 'forbidden'], `proof computed from the old creator password is no longer accepted: ${JSON.stringify(oldProof)}`);
  const newProof = await adminOp(creator, proj, 'set-password', { project: credential('p2') }, { password: NEW_PW });
  assert.equal(newProof.type, 'shared.admin.ok', `proof computed from the new creator password is accepted: ${JSON.stringify(newProof)}`);
});

test('C65B-A-02 non-creator, no proof, wrong proof → forbidden, and no effect', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(10) });
  const member = await join(env, proj, { username: 'zoe', remote: R(11) });
  const fields = creatorPasswordFields(credential('hijack'));

  const byMember = await adminOp(member, proj, SET_CREATOR_PASSWORD, fields, { password: proj.password, username: 'zoe' });
  assert.deepEqual([byMember.type, byMember.reason], ['error', 'forbidden'], `proof computed by a member from their own passphrase: ${JSON.stringify(byMember)}`);
  const memberNoProof = await adminOp(member, proj, SET_CREATOR_PASSWORD, fields, { noProof: true });
  assert.deepEqual([memberNoProof.type, memberNoProof.reason], ['error', 'forbidden'], `member without proof: ${JSON.stringify(memberNoProof)}`);
  const noProof = await adminOp(creator, proj, SET_CREATOR_PASSWORD, fields, { noProof: true });
  assert.deepEqual([noProof.type, noProof.reason], ['error', 'forbidden'], `creator connection without proof: ${JSON.stringify(noProof)}`);
  const badProof = await adminOp(creator, proj, SET_CREATOR_PASSWORD, fields, { badProof: true });
  assert.deepEqual([badProof.type, badProof.reason], ['error', 'forbidden'], `wrong proof: ${JSON.stringify(badProof)}`);

  await sleep(100);
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', remote: R(12) }), 101, 'original creator password still joins as before');
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', password: 'hijack', remote: R(13) }), 401, 'rejected change did not take effect');
});

test('C65B-A-03 restricted entry can also change the creator password; members on the list are unaffected', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'restricted' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(20) });
  const r = await adminOp(creator, proj, SET_CREATOR_PASSWORD, creatorPasswordFields(credential(NEW_PW)));
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', remote: R(21) }), 401, 'old password');
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', password: NEW_PW, remote: R(22) }), 101, 'new password');
  assert.equal(await joinStatus(env, proj, { username: 'bob', remote: R(23) }), 101, 'listed members unchanged');
});

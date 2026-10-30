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

test('C65B-A-01 带创建者证明改创建者密码（自由进入）：成功；旧密码以创建者身份进不来，新密码进得来；之后的创建者操作要用新密码', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(1) });

  const r = await adminOp(creator, proj, SET_CREATOR_PASSWORD, creatorPasswordFields(credential(NEW_PW)));
  assert.equal(r.type, 'shared.admin.ok', `set-creator-password 应成功：${JSON.stringify(r)}`);

  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', remote: R(2) }), 401, '旧的创建者密码进不来');
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', password: NEW_PW, remote: R(3) }), 101, '新的创建者密码进得来');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: R(4) }), 101, '项目密码不受影响');

  const oldProof = await adminOp(creator, proj, 'set-password', { project: credential('p2') });
  assert.deepEqual([oldProof.type, oldProof.reason], ['error', 'forbidden'], `按旧创建者密码算的证明不再认：${JSON.stringify(oldProof)}`);
  const newProof = await adminOp(creator, proj, 'set-password', { project: credential('p2') }, { password: NEW_PW });
  assert.equal(newProof.type, 'shared.admin.ok', `按新创建者密码算的证明认：${JSON.stringify(newProof)}`);
});

test('C65B-A-02 非创建者、不带证明、证明错 → forbidden，且不生效', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(10) });
  const member = await join(env, proj, { username: 'zoe', remote: R(11) });
  const fields = creatorPasswordFields(credential('hijack'));

  const byMember = await adminOp(member, proj, SET_CREATOR_PASSWORD, fields, { password: proj.password, username: 'zoe' });
  assert.deepEqual([byMember.type, byMember.reason], ['error', 'forbidden'], `成员按自己的口令算证明：${JSON.stringify(byMember)}`);
  const memberNoProof = await adminOp(member, proj, SET_CREATOR_PASSWORD, fields, { noProof: true });
  assert.deepEqual([memberNoProof.type, memberNoProof.reason], ['error', 'forbidden'], `成员不带证明：${JSON.stringify(memberNoProof)}`);
  const noProof = await adminOp(creator, proj, SET_CREATOR_PASSWORD, fields, { noProof: true });
  assert.deepEqual([noProof.type, noProof.reason], ['error', 'forbidden'], `创建者连接不带证明：${JSON.stringify(noProof)}`);
  const badProof = await adminOp(creator, proj, SET_CREATOR_PASSWORD, fields, { badProof: true });
  assert.deepEqual([badProof.type, badProof.reason], ['error', 'forbidden'], `证明错：${JSON.stringify(badProof)}`);

  await sleep(100);
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', remote: R(12) }), 101, '原创建者密码照旧能进');
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', password: 'hijack', remote: R(13) }), 401, '被拒的改动没生效');
});

test('C65B-A-03 限定进入同样能改创建者密码；名单里的成员不受影响', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'restricted' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(20) });
  const r = await adminOp(creator, proj, SET_CREATOR_PASSWORD, creatorPasswordFields(credential(NEW_PW)));
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', remote: R(21) }), 401, '旧密码');
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', password: NEW_PW, remote: R(22) }), 101, '新密码');
  assert.equal(await joinStatus(env, proj, { username: 'bob', remote: R(23) }), 101, '名单成员照旧');
});

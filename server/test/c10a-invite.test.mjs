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
const skip = skipIf(!support.ok, `邀请码端点 shared/invite/*（${support.detail}）`);
const it = (name, fn) => test(name, { skip }, fn);

const INVALID = Object.freeze({ ok: false, error: 'invite-invalid' });
const R = (i) => `203.0.113.${10 + i}`;

/** 建项目、创建者进入、签发邀请码 */
async function setup(t, { mode = 'free', fields = {}, host = {} } = {}) {
  const env = await hostFor(t, host);
  const proj = await createProject(env, { mode });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  const r = await adminOp(creator, proj, 'invite-create', fields);
  assert.equal(r.type, 'shared.admin.ok', `invite-create：${JSON.stringify(r)}`);
  return { env, proj, creator, invite: r, code: r.code };
}

const status = async (creator, proj) => inviteStatusOf(await adminOp(creator, proj, 'invite-status'));

// ------------------------------------------------------------------ 签发、解析

it('C10A-IV-01 签发：43 位 base64url；缺省 7 天、次数不限；原文只在签发回包里；resolve 回项目名与模式、不扣次数', async (t) => {
  const { env, proj, creator, invite, code } = await setup(t);
  assert.equal(invite.op, 'invite-create');
  assert.match(code, INVITE_CODE_RE, '邀请码是 32 字节的 base64url（43 个字符，不带填充）');
  assert.equal(invite.maxUses, null, '缺省次数不限');
  assert.ok(Math.abs(invite.expiresAt - (env.clock.now() + INVITE_DEFAULT_TTL_MS)) < 10_000, `缺省有效期 7 天：expiresAt=${invite.expiresAt}`);

  for (let i = 0; i < 3; i++) {
    const r = await resolveInvite(env, code);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual({ ok: r.json.ok, projectId: r.json.projectId, name: r.json.name, mode: r.json.mode },
      { ok: true, projectId: proj.projectId, name: proj.name, mode: 'free' });
    assert.equal(r.text.includes(code), false, 'resolve 回包不带原文');
    assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  }
  const st = await status(creator, proj);
  assert.equal(st.used, 0, 'resolve 不扣次数');
  assert.equal(st.active, true);
  assert.equal(st.maxUses, null);
  assert.equal(st.revokedAt ?? null, null);
  assert.ok(Math.abs(st.expiresAt - invite.expiresAt) < 1000);
  assert.equal(JSON.stringify(st).includes(code), false, 'invite-status 不含原文');
});

it('C10A-IV-02 签发时可改有效期与次数；再签发同时作废旧的（只有一个有效邀请码）', async (t) => {
  const { env, proj, creator, code: first } = await setup(t, { fields: { expiresInSec: 3600, maxUses: 5 } });
  let st = await status(creator, proj);
  assert.equal(st.maxUses, 5);
  assert.ok(Math.abs(st.expiresAt - (env.clock.now() + 3600_000)) < 10_000);
  const again = await adminOp(creator, proj, 'invite-create');
  assert.equal(again.type, 'shared.admin.ok', JSON.stringify(again));
  assert.notEqual(again.code, first);
  const oldR = await resolveInvite(env, first);
  assert.equal(oldR.status, 404);
  assert.deepEqual(oldR.json, INVALID, '旧的作废');
  assert.equal((await resolveInvite(env, again.code)).status, 200, '新的有效');
  st = await status(creator, proj);
  assert.equal(st.maxUses, null, '新签发的回到缺省');
  assert.equal(st.used, 0);
});

it('C10A-IV-03 作废：resolve 与 redeem 一律 invite-invalid；invite-status 不再有效、带 revokedAt；已经进来的人不受影响', async (t) => {
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

it('C10A-IV-04 限时：到期前能用，过期后 resolve / redeem 都是 invite-invalid，状态不再有效', async (t) => {
  const { env, proj, creator, code } = await setup(t, { fields: { expiresInSec: 60 } });
  assert.equal((await resolveInvite(env, code)).status, 200);
  env.clock.advance(30_000);
  assert.equal((await redeemInvite(env, { code, username: 'zoe', deviceId: newDevice().deviceId })).status, 200, '30 s 时还有效');
  env.clock.advance(31_000);
  assert.deepEqual((await resolveInvite(env, code)).json, INVALID, '61 s 后过期');
  const r = await redeemInvite(env, { code, username: 'yan', deviceId: newDevice().deviceId });
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, INVALID);
  assert.equal((await status(creator, proj)).active, false);
});

it('C10A-IV-05 限量：maxUses 2 → 两台设备兑换成功，第三台 invite-invalid；用满后 resolve 也 invite-invalid', async (t) => {
  const { env, proj, creator, code } = await setup(t, { fields: { maxUses: 2 } });
  for (const name of ['u1', 'u2']) {
    const r = await redeemInvite(env, { code, username: name, deviceId: newDevice().deviceId });
    assert.equal(r.status, 200, `${name}：${r.text}`);
  }
  const third = await redeemInvite(env, { code, username: 'u3', deviceId: newDevice().deviceId });
  assert.equal(third.status, 404);
  assert.deepEqual(third.json, INVALID);
  assert.deepEqual((await resolveInvite(env, code)).json, INVALID, '次数用完：resolve 同一口径');
  const st = await status(creator, proj);
  assert.equal(st.used, 2);
  assert.equal(st.maxUses, 2);
  assert.equal(st.active, false);
});

it('C10A-IV-06 同一 userId（用户名 + 设备）再兑换不重复扣次；换用户名或换设备算新的 userId', async (t) => {
  const { env, proj, creator, code } = await setup(t, { fields: { maxUses: 1 } });
  const dev = newDevice('Pad');
  for (let i = 0; i < 3; i++) {
    const r = await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId });
    assert.equal(r.status, 200, `第 ${i + 1} 次：${r.text}`);
  }
  assert.equal((await status(creator, proj)).used, 1, '同一 userId 只扣一次');
  assert.deepEqual((await redeemInvite(env, { code, username: 'zoe2', deviceId: dev.deviceId })).json, INVALID, '同设备换用户名是另一个 userId');
  assert.deepEqual((await redeemInvite(env, { code, username: 'zoe', deviceId: newDevice().deviceId })).json, INVALID, '同用户名换设备是另一个 userId');
  assert.equal((await status(creator, proj)).used, 1);
});

it('C10A-IV-07 invite-invalid 一个口径：未知、已作废、已过期、次数用完，状态码与回包逐字节相同', async (t) => {
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
  await record('未知', newInviteCode());
  const revoked = (await adminOp(creator, proj, 'invite-create')).code;
  await adminOp(creator, proj, 'invite-revoke');
  await record('已作废', revoked);
  const expired = (await adminOp(creator, proj, 'invite-create', { expiresInSec: 10 })).code;
  env.clock.advance(11_000);
  await record('已过期', expired);
  const used = (await adminOp(creator, proj, 'invite-create', { maxUses: 1 })).code;
  assert.equal((await redeemInvite(env, { code: used, username: 'first', deviceId: newDevice().deviceId })).status, 200);
  await record('次数用完', used);
  for (const [ep, map] of Object.entries(bodies)) {
    const values = [...map.values()];
    assert.equal(new Set(values).size, 1, `${ep} 四种情况应完全一样：${JSON.stringify(Object.fromEntries(map))}`);
    const [code, ...rest] = values[0].split(' ');
    assert.equal(code, '404');
    assert.deepEqual(JSON.parse(rest.join(' ')), INVALID);
  }
});

// ------------------------------------------------------------------ 兑换：K、禁入

it('C10A-IV-08 自由进入回 K：K 等于项目密码派生的 K，拿它照常握手；resolve 不给 K', async (t) => {
  const { env, proj, code } = await setup(t);
  const dev = newDevice('Phone');
  const r = await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId });
  assert.equal(r.status, 200, r.text);
  const j = r.json;
  assert.deepEqual({ ok: j.ok, projectId: j.projectId, name: j.name, mode: j.mode }, { ok: true, projectId: proj.projectId, name: proj.name, mode: 'free' });
  assert.deepEqual(j.kdf, KDF, 'kdf 原样给出');
  assert.equal(typeof j.project?.salt, 'string');
  assert.equal(j.project.key, derive(proj.password, j.project.salt, j.kdf), 'K = KDF(项目密码, 盐)');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, key: j.project.key }), 101, '凭 K 握手');
  const res = await resolveInvite(env, code);
  assert.equal(res.json.project, undefined, 'resolve 不给 K');
  assert.equal(res.text.includes(j.project.key), false);
});

it('C10A-IV-09 限定进入不回 K：只回 { ok, projectId, name, mode }，兑换即扣次；之后按名单口令进入', async (t) => {
  const { env, proj, creator, code } = await setup(t, { mode: 'restricted' });
  const dev = newDevice('Phone');
  const r = await redeemInvite(env, { code, username: 'bob', deviceId: dev.deviceId });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, projectId: proj.projectId, name: proj.name, mode: 'restricted' });
  assert.equal((await status(creator, proj)).used, 1, '限定进入在兑换时就扣');
  assert.equal(await joinStatus(env, proj, { username: 'bob', device: dev }), 101, '名单里的口令照常进入');
});

it('C10A-IV-10 改项目密码不动邀请码：旧码照常可用，兑换回新 K，旧 K 不能再进', async (t) => {
  const { env, proj, creator, code } = await setup(t);
  const dev = newDevice();
  const before = (await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId })).json.project;
  const r = await adminOp(creator, proj, 'set-password', { project: credential('pw-2') });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  assert.equal((await resolveInvite(env, code)).status, 200, '邀请码不受影响');
  const after = await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId });
  assert.equal(after.status, 200, after.text);
  assert.equal(after.json.project.key, derive('pw-2', after.json.project.salt, after.json.kdf), '回的是新密码的 K');
  assert.notEqual(after.json.project.key, before.key);
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, key: before.key }), 401, '旧 K 失效');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, key: after.json.project.key }), 101);
});

it('C10A-IV-11 禁入：被踢的 (用户名, 设备) 兑换回 401 banned；同用户名换设备不受影响；unban 后能兑换', async (t) => {
  const { env, proj, creator, code } = await setup(t);
  const dev = newDevice('Laptop');
  const zoe = await join(env, proj, { username: 'zoe', device: dev });
  const k = await adminOp(creator, proj, 'kick', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal(k.type, 'shared.admin.ok', JSON.stringify(k));
  await zoe.closed;
  const r = await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId });
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { ok: false, error: 'banned' });
  assert.equal((await redeemInvite(env, { code, username: 'zoe', deviceId: newDevice().deviceId })).status, 200, '禁入按 (用户名, 设备)');
  await adminOp(creator, proj, 'unban', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal((await redeemInvite(env, { code, username: 'zoe', deviceId: dev.deviceId })).status, 200, 'unban 之后');
});

// ------------------------------------------------------------------ 限速

for (const ep of ['resolve', 'redeem']) {
  it(`C10A-IV-12 限速（${ep}）：同一来源失败 5 次后 60 s 内一律 429 rate-limited（码对也拒），另一来源不受影响，61 s 后恢复`, async (t) => {
    const { env, code } = await setup(t);
    const call = (c, remote) => (ep === 'resolve'
      ? resolveInvite(env, c, { remote })
      : redeemInvite(env, { code: c, username: 'zoe', deviceId: 'rate-device-000001' }, { remote }));
    for (let i = 0; i < 5; i++) await call(newInviteCode(), R(1));
    const blocked = await call(code, R(1));
    assert.equal(blocked.status, 429, `冷却中码对也拒：${blocked.status} ${blocked.text}`);
    assert.equal(blocked.json?.error, 'rate-limited');
    const other = ep === 'resolve' ? 'redeem' : 'resolve';
    const cross = other === 'resolve' ? await resolveInvite(env, code, { remote: R(1) }) : await redeemInvite(env, { code, username: 'zoe', deviceId: 'rate-device-000001' }, { remote: R(1) });
    assert.equal(cross.status, 429, `同一来源的 ${other} 也在冷却`);
    assert.equal((await call(code, R(2))).status, 200, '另一来源不受影响');
    env.clock.advance(61_000);
    assert.equal((await call(code, R(1))).status, 200, '61 s 后恢复');
  });
}

it('C10A-IV-13 回环来源的失败不计入限速', async (t) => {
  const { env, code } = await setup(t);
  for (let i = 0; i < 8; i++) assert.equal((await resolveInvite(env, newInviteCode())).status, 404);
  assert.equal((await resolveInvite(env, code)).status, 200);
});

// ------------------------------------------------------------------ 创建者操作、存储、日志

it('C10A-IV-14 三个 op 都要创建者证明：成员、不带证明、证明错一律 forbidden，且都不生效', async (t) => {
  const { env, proj, creator, code } = await setup(t);
  const member = await join(env, proj, { username: 'zoe' });
  for (const op of ['invite-create', 'invite-revoke', 'invite-status']) {
    const asMember = await adminOp(member, proj, op, {}, { password: proj.password, username: 'zoe' });
    assert.equal(asMember.reason, 'forbidden', `${op} 成员：${JSON.stringify(asMember)}`);
    assert.equal((await adminOp(creator, proj, op, {}, { noProof: true })).reason, 'forbidden', `${op} 不带证明`);
    assert.equal((await adminOp(creator, proj, op, {}, { badProof: true })).reason, 'forbidden', `${op} 证明错`);
    assert.equal(JSON.stringify(asMember).includes(code), false);
  }
  assert.equal((await resolveInvite(env, code)).status, 200, '原码仍有效：没被作废也没被换掉');
});

it('C10A-IV-15 原文不落盘、不进日志：数据目录里任何文件都不含邀请码原文，日志行也不含', async (t) => {
  const { env, proj, creator, code } = await setup(t, { fields: { maxUses: 3 } });
  await resolveInvite(env, code);
  await redeemInvite(env, { code, username: 'zoe', deviceId: newDevice().deviceId });
  await resolveInvite(env, code, { remote: R(20) });
  await redeemInvite(env, { code, username: 'yan', deviceId: newDevice().deviceId }, { remote: R(20) });
  await status(creator, proj);
  // 再签发一个，确保旧记录被改写之后同样不含原文
  const second = (await adminOp(creator, proj, 'invite-create')).code;
  for (const c of [code, second]) {
    assert.deepEqual(filesContaining(env.dataDir, c), [], `数据目录里出现了原文 ${c.slice(0, 6)}…`);
    assert.equal(logText(env).includes(c), false, '日志里出现了原文');
  }
});

it('C10A-IV-16 删项目：邀请码一并删除，resolve 回 invite-invalid', async (t) => {
  const { env, proj, creator, code } = await setup(t);
  const r = await adminOp(creator, proj, 'delete');
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  const res = await resolveInvite(env, code);
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, INVALID);
});

it('C10A-IV-17 HTTP 形状：no-store、Access-Control-Allow-Origin *、答 OPTIONS 预检', async (t) => {
  const { env, code } = await setup(t);
  for (const rel of ['shared/invite/resolve', 'shared/invite/redeem']) {
    const pre = await env.http(rel, { method: 'OPTIONS', headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
    assert.ok(pre.status >= 200 && pre.status < 300, `${rel} OPTIONS：${pre.status}`);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  }
  const r = await resolveInvite(env, code);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  const bad = await redeemInvite(env, { code: newInviteCode(), username: 'zoe', deviceId: newDevice().deviceId });
  assert.match(bad.headers.get('cache-control') ?? '', /no-store/);
});

it('C10A-IV-18 挂载模式（局域网主机）实现同一组端点与 op：<WS 路径>/shared/invite/…', async (t) => {
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

it('C10A-IV-19 两个项目的邀请码互不相干：各自解析到自己的项目，作废一个不影响另一个', async (t) => {
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

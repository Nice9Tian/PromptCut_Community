/**
 * M6a 共享项目：WebSocket 握手、挑战、限速、连接票据（契约 `docs/plan/auth-contract.md` 第 4、5、6、8、9、11 节，
 * 用例 AU2、AU3、AU8、AU14，以及 `client.mjs` 的对拍）。
 * 跑：node --test server/test/auth-handshake.test.mjs
 *
 * 只照契约写，不看实现。起服务的接口是测试方的假设，集中在 `auth-kit.mjs` 文件头。
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

/** 取刚连上的那条连接的 principal（按 userId 找最后一条） */
async function principalOf(env, userId) {
  return waitFor(() => env.principals().filter((p) => p?.userId === userId).at(-1), 2000, `principal ${userId}`);
}

// ------------------------------------------------------------------ AU2

test('AU2 自由进入：证明对 → 握手 101、只回显 promptcut.v1；principal 字段齐全', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const dev = newDevice('Laptop');
  const p = await proofFor(env, proj, { username: 'zoe', device: dev, remote: PUBLIC });
  const raw = await env.handshake(p.protocols, PUBLIC);
  assert.equal(raw.status, 101, '证明对应 101');
  assert.equal(raw.protocol, PROTOCOL, '只回显 promptcut.v1，不回显证明那一项');

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
  assert.ok('conversation' in pr, 'principal 有 conversation 字段');
  assert.ok('owner' in pr, 'principal 有 owner 字段');
  assert.ok(pr.conversation === null || pr.conversation === undefined, 'page 连接没有对话号');
});

test('AU2 自由进入：创建者凭创建者口令进入 → creator: true；成员口令当创建者用 → 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const dev = newDevice();
  await join(env, proj, { username: 'alice', as: 'creator', device: dev, remote: PUBLIC });
  const pr = await principalOf(env, `alice@${dev.deviceId}`);
  assert.equal(pr.creator, true);
  assert.equal(pr.scope, 'member');
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', password: proj.password, device: newDevice(), remote: other(1) }), 401);
  // 创建者也能按普通成员进（项目口令），此时 creator 为 false
  const dev2 = newDevice();
  await join(env, proj, { username: 'alice', as: 'member', device: dev2, remote: PUBLIC });
  assert.equal((await principalOf(env, `alice@${dev2.deviceId}`)).creator, false);
});

test('AU2 自由进入：证明错 → 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  assert.equal(await joinStatus(env, proj, { username: 'zoe', password: 'wrong-pw', remote: other(2) }), 401, '口令错');
  assert.equal(await joinStatus(env, proj, {
    username: 'zoe', remote: other(3), mutate: (f) => ({ ...f, m: b64u(randomBytes(32)) }),
  }), 401, 'm 随机');
  assert.equal(await joinStatus(env, proj, {
    username: 'zoe', remote: other(4), mutate: (f) => ({ ...f, m: f.m.slice(0, 20) }),
  }), 401, 'm 解码后不是 32 字节');
  assert.equal(await joinStatus(env, proj, {
    username: 'zoe', remote: other(5), mutate: (f) => ({ ...f, m: b64u(Buffer.concat([Buffer.from(f.m, 'base64url'), Buffer.from([0])])) }),
  }), 401, 'm 解码后 33 字节（前 32 字节是对的）');
});

test('AU2 nonce 复用 → 401（第一次成功后同一 nonce 再用）', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const p = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  assert.equal((await env.handshake(p.protocols, PUBLIC)).status, 101);
  assert.equal((await env.handshake(p.protocols, PUBLIC)).status, 401, '同一证明再用');
});

test('AU2 nonce 失败一次也作废：先带错证明用掉它，再带对的证明 → 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const p = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  const wrong = [PROTOCOL, authItem({ ...p.fields, m: b64u(randomBytes(32)) })];
  assert.equal((await env.handshake(wrong, PUBLIC)).status, 401);
  assert.equal((await env.handshake(p.protocols, PUBLIC)).status, 401, '核对后 nonce 立即作废，不论成败');
});

test('AU2 nonce 过期（注入时钟，60 s）→ 401；59 s 内有效', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const fresh = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  env.clock.advance(59_000);
  assert.equal((await env.handshake(fresh.protocols, PUBLIC)).status, 101, '59 s 时仍有效');
  const stale = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  env.clock.advance(61_000);
  assert.equal((await env.handshake(stale.protocols, PUBLIC)).status, 401, '61 s 后过期');
});

test('AU2 nonce 绑定的四元组 (projectId, username, deviceId, as) 与证明不符 → 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const proj2 = await createProject(env, { mode: 'free' });
  const dev = newDevice();
  const cases = [
    ['username 不同', (f) => ({ username: 'zoe2', deviceId: f.d, projectId: f.p, as: f.as })],
    ['deviceId 不同', (f) => ({ username: f.u, deviceId: newDevice().deviceId, projectId: f.p, as: f.as })],
    ['projectId 不同', (f) => ({ username: f.u, deviceId: f.d, projectId: proj2.projectId, as: f.as })],
  ];
  let i = 10;
  for (const [what, tuple] of cases) {
    const remote = other(i++);
    const p = await proofFor(env, proj, { username: 'zoe', device: dev, remote });
    const tu = tuple(p.fields);
    // 按改过的四元组重新算 m（口令对），只有 nonce 的绑定不符
    const key = tu.projectId === proj.projectId ? p.key : derive(proj2.password, (await challenge(env, { projectId: proj2.projectId, username: tu.username, deviceId: tu.deviceId, remote })).json.salt);
    const f = proofFields({ projectId: tu.projectId, username: tu.username, deviceId: tu.deviceId, deviceName: dev.deviceName, as: tu.as, nonce: p.nonce, key });
    assert.equal((await env.handshake([PROTOCOL, authItem(f)], remote)).status, 401, what);
  }
  // as 不同：挑战按 member 取，证明写 creator（用创建者口令算）
  const remote = other(i++);
  const p = await proofFor(env, proj, { username: 'alice', device: dev, remote });
  const ck = derive(proj.creator.password, (await challenge(env, { projectId: proj.projectId, username: 'alice', deviceId: dev.deviceId, as: 'creator', remote })).json.salt);
  const f = proofFields({ projectId: proj.projectId, username: 'alice', deviceId: dev.deviceId, deviceName: dev.deviceName, as: 'creator', nonce: p.nonce, key: ck });
  assert.equal((await env.handshake([PROTOCOL, authItem(f)], remote)).status, 401, 'as 不同');
});

test('AU2 证明格式：r 不认识、agent 缺 c、c 不是正整数、o 给了非 render、JSON 超过 1024 字节、v 不对 → 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const cases = [
    ['r 不认识', { role: 'admin' }],
    ['agent 缺 c', { role: 'agent' }],
    ['agent 的 c 是 0', { role: 'agent', c: 0 }],
    ['agent 的 c 是小数', { role: 'agent', c: 1.5 }],
    ['agent 的 c 是字符串', { role: 'agent', c: '2' }],
    ['page 带 o', { role: 'page', o: { kind: 'user' } }],
    ['render 的 o.kind 不认识', { role: 'render', o: { kind: 'robot' } }],
    ['render 的 o 归 agent 却没有 c', { role: 'render', o: { kind: 'agent' } }],
  ];
  let i = 30;
  for (const [what, opts] of cases) {
    assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: other(i++), ...opts }), 401, what);
  }
  assert.equal(await joinStatus(env, proj, {
    username: 'zoe', remote: other(i++), mutate: (f) => ({ ...f, pad: 'x'.repeat(1100) }),
  }), 401, 'JSON 超过 1024 字节');
  assert.equal(await joinStatus(env, proj, {
    username: 'zoe', remote: other(i++), mutate: (f) => ({ ...f, v: 2 }),
  }), 401, 'v 不是 1');
  // 合法的几种都能进
  const ok = [
    ['agent c=3', { role: 'agent', c: 3 }],
    ['render 归真人', { role: 'render', o: { kind: 'user' } }],
    ['render 归 agent 对话', { role: 'render', o: { kind: 'agent', c: 2 } }],
    ['render 不标归属', { role: 'render' }],
  ];
  for (const [what, opts] of ok) {
    assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: other(i++), ...opts }), 101, what);
  }
});

test('AU2 至多一项鉴权：证明 + 本机声明、证明 + 票据、两份证明 → 401；子协议里没有 promptcut.v1 → 401', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const a = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  const b = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  assert.equal((await env.handshake([PROTOCOL, a.protocols[1], b.protocols[1]], PUBLIC)).status, 401, '两份证明');
  const c = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  assert.equal((await env.handshake([PROTOCOL, c.protocols[1], `promptcut.tenant.${proj.projectId}`])).status, 401, '证明 + 本机声明（回环）');
  const d = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  assert.equal((await env.handshake([PROTOCOL, d.protocols[1], 'promptcut.ticket.v1.abc.def'], PUBLIC)).status, 401, '证明 + 票据');
  const e = await proofFor(env, proj, { username: 'zoe', remote: PUBLIC });
  assert.equal((await env.handshake([e.protocols[1]], PUBLIC)).status, 401, '没有 promptcut.v1');
  assert.equal((await env.handshake([PROTOCOL], PUBLIC)).status, 401, '非回环来源什么都不带');
  assert.equal((await env.handshake([PROTOCOL, 'promptcut.auth.not-json!!'], PUBLIC)).status, 401, '证明不是 base64url JSON');
});

test('AU2 回环来源什么都不带 → 本机身份 { userId: local, tenantId: local, scope: local, role: page }', async (t) => {
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

test('AU3 限定进入：名单内用户名成功；创建者自动在名单里（as: member 用创建者口令也能进）', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }, { username: 'cara', password: 'cara-pw' }] });
  const dev = newDevice();
  await join(env, proj, { username: 'bob', device: dev, remote: PUBLIC });
  const pr = await principalOf(env, `bob@${dev.deviceId}`);
  assert.equal(pr.tenantId, proj.projectId);
  assert.equal(pr.creator, false);
  assert.equal(await joinStatus(env, proj, { username: 'bob', password: 'cara-pw', remote: other(40) }), 401, '用别人的口令');
  assert.equal(await joinStatus(env, proj, { username: 'cara', remote: other(41) }), 101);
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'creator', remote: other(42) }), 101, '创建者以 creator 进');
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'member', password: proj.creator.password, remote: other(43) }), 101, '创建者算名单一员');
});

test('AU3 限定进入：名单外用户名的挑战与名单内形状相同、同名两次同一个伪盐；随后握手 401', async (t) => {
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
  assert.deepEqual(shapeNoVals(out1.json), shapeNoVals(inList.json), '名单外与名单内形状相同（键、类型、nonce 与 salt 长度、kdf、mode）');
  assert.equal(out1.json.salt, out2.json.salt, '同一用户名两次同一个盐（设备、来源不同也一样）');
  assert.notEqual(out1.json.salt, out3.json.salt, '不同用户名的伪盐不同');
  assert.notEqual(out1.json.nonce, out2.json.nonce);
  // 握手：按伪盐派生任何口令都 401
  assert.equal(await joinStatus(env, proj, { username: 'mallory', password: 'guess', remote: other(45) }), 401);
  // as: creator 而用户名不是创建者：同样回伪盐、稳定
  const c1 = await challenge(env, { projectId: proj.projectId, username: 'bob', deviceId: dev.deviceId, as: 'creator', remote: PUBLIC });
  const c2 = await challenge(env, { projectId: proj.projectId, username: 'bob', deviceId: dev.deviceId, as: 'creator', remote: PUBLIC });
  assert.equal(c1.status, 200);
  assert.equal(c1.json.salt, c2.json.salt, '非创建者以 creator 取挑战：伪盐稳定');
  assert.notEqual(c1.json.salt, inList.json.salt, '不是 bob 真正的名单盐');
  assert.equal(await joinStatus(env, proj, { username: 'bob', as: 'creator', password: 'bob-pw', remote: other(46) }), 401);
});

test('AU3 伪盐随时间不变（同一台服务上隔 10 分钟再取）', async (t) => {
  // 同一数据目录起两次：伪盐一样。数据目录由 startHost 自建，这里只比同一台服务上两次（重启另见报告）
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'restricted' });
  const a = await challenge(env, { projectId: proj.projectId, username: 'ghost', deviceId: newDevice().deviceId });
  env.clock.advance(10 * 60_000);
  const b = await challenge(env, { projectId: proj.projectId, username: 'ghost', deviceId: newDevice().deviceId });
  assert.equal(a.json.salt, b.json.salt, '时间过去也不变');
});

// ------------------------------------------------------------------ AU8

test('AU8 限速：同一来源 1 分钟内错 5 次 → 60 s 内挑战 429、握手口令对也 401；61 s 后恢复；别的来源不受影响', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const bad = '198.51.100.200';
  const good = '198.51.100.201';
  // 先备好一个口令对的证明（冷却前取的 nonce）
  const held = await proofFor(env, proj, { username: 'zoe', remote: bad });
  for (let i = 0; i < 5; i++) {
    assert.equal(await joinStatus(env, proj, { username: 'zoe', password: `wrong-${i}`, remote: bad }), 401, `第 ${i + 1} 次错`);
  }
  env.clock.advance(1000);
  const ch = await challenge(env, { projectId: proj.projectId, username: 'zoe', deviceId: newDevice().deviceId, remote: bad });
  assert.equal(ch.status, 429, `冷却中挑战：${ch.text}`);
  assert.deepEqual(ch.json, { ok: false, error: 'rate-limited' });
  assert.equal((await env.handshake(held.protocols, bad)).status, 401, '冷却中口令对也拒');
  // 别的来源不受影响
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: good }), 101, '别的来源照常');
  // 冷却快结束（第 5 次失败后 58 s）仍拒
  env.clock.advance(57_000);
  assert.equal((await challenge(env, { projectId: proj.projectId, username: 'zoe', deviceId: newDevice().deviceId, remote: bad })).status, 429, '58 s 时仍在冷却');
  // 61 s 后恢复
  env.clock.advance(3000);
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: bad }), 101, '61 s 后恢复');
});

test('AU8 限速门槛：错 4 次还能进；1 分钟之外的失败不累计', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const src = '198.51.100.210';
  for (let i = 0; i < 4; i++) assert.equal(await joinStatus(env, proj, { username: 'zoe', password: 'nope', remote: src }), 401);
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: src }), 101, '4 次失败后口令对能进');
  const src2 = '198.51.100.211';
  for (let i = 0; i < 4; i++) assert.equal(await joinStatus(env, proj, { username: 'zoe', password: 'nope', remote: src2 }), 401);
  env.clock.advance(61_000);
  assert.equal(await joinStatus(env, proj, { username: 'zoe', password: 'nope', remote: src2 }), 401, '第 5 次在一分钟之外');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: src2 }), 101, '不进冷却');
});

test('AU8 限速：nonce 不对也算失败；回环来源不计数', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const src = '198.51.100.220';
  for (let i = 0; i < 5; i++) {
    const p = await proofFor(env, proj, { username: 'zoe', remote: src, mutate: (f) => ({ ...f, nonce: b64u(randomBytes(32)) }) });
    assert.equal((await env.handshake(p.protocols, src)).status, 401, `nonce 不对 #${i + 1}`);
  }
  const ch = await challenge(env, { projectId: proj.projectId, username: 'zoe', deviceId: newDevice().deviceId, remote: src });
  assert.equal(ch.status, 429, 'nonce 不对计入失败');

  for (let i = 0; i < 7; i++) assert.equal(await joinStatus(env, proj, { username: 'zoe', password: 'nope' }), 401, `回环错 #${i + 1}`);
  assert.equal(await joinStatus(env, proj, { username: 'zoe' }), 101, '回环来源不计数');
});

test('AU8 限速：创建者操作的证明不对计入；冷却中创建者操作回 rate-limited', async (t) => {
  const { adminOp } = await import('./auth-kit.mjs');
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const src = '198.51.100.230';
  const c = await join(env, proj, { username: 'alice', as: 'creator', remote: src });
  for (let i = 0; i < 5; i++) {
    const r = await adminOp(c, proj, 'unban', { username: 'x', deviceId: newDevice().deviceId }, { badProof: true });
    assert.equal(r.type, 'error');
    assert.equal(r.reason, 'forbidden', `证明错 #${i + 1}`);
  }
  const r = await adminOp(c, proj, 'unban', { username: 'x', deviceId: newDevice().deviceId });
  assert.equal(r.type, 'error', `冷却中：${JSON.stringify(r)}`);
  assert.equal(r.reason, 'rate-limited');
  assert.equal((await challenge(env, { projectId: proj.projectId, username: 'alice', deviceId: newDevice().deviceId, remote: src })).status, 429, '挑战也 429');
  env.clock.advance(61_000);
  const ok = await adminOp(c, proj, 'unban', { username: 'x', deviceId: newDevice().deviceId });
  assert.equal(ok.type, 'shared.admin.ok', `61 s 后恢复：${JSON.stringify(ok)}`);
});

// ------------------------------------------------------------------ AU14

test('AU14 连接票据：页面要 render 票据，另一条连接凭它进入，身份与页面相同、角色 render；过期后 401', async (t) => {
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
  assert.ok(body.exp - body.iat <= 2 * 60_000, '连接票据有效期不超过 2 分钟');
  assert.equal(tk.exp, body.exp, 'auth.ticket.ok.exp 与票据里的 exp 一致');
  assert.match(tk.ticket, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, '票据形状 v1.<负载>.<签名>，不带 =');

  const before = env.principals().length;
  const hs = await env.handshake([PROTOCOL, `promptcut.ticket.${tk.ticket}`], other(60));
  assert.equal(hs.status, 101);
  assert.equal(hs.protocol, PROTOCOL);
  const r = await env.open([PROTOCOL, `promptcut.ticket.${tk.ticket}`], other(61));
  assert.ok(r);
  await waitFor(() => env.principals().length >= before + 1, 2000, '第二条连接登记');
  const rendPr = env.principals().filter((p) => p.userId === pagePr.userId && p.role === 'render').at(-1);
  assert.ok(rendPr, `凭票据进来的连接：${JSON.stringify(env.principals())}`);
  for (const k of ['userId', 'tenantId', 'scope', 'username', 'deviceId', 'deviceName', 'creator']) {
    assert.deepEqual(rendPr[k], pagePr[k], `身份字段 ${k} 与页面相同`);
  }
  assert.equal(rendPr.role, 'render');
  assert.deepEqual(rendPr.owner, { kind: 'user' });

  // 过期：2 分钟 + 30 s 偏差之后
  env.clock.advance(2 * 60_000 + 31_000);
  assert.equal((await env.handshake([PROTOCOL, `promptcut.ticket.${tk.ticket}`], other(62))).status, 401, '过期后 401');
});

test('AU14 连接票据：agent 角色带对话号；签名错 401；素材票据不能当连接票据；本机身份要不到票据', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const dev = newDevice();
  const page = await join(env, proj, { username: 'zoe', device: dev, remote: PUBLIC });
  const tk = await ticketOf(page, { kind: 'conn', role: 'agent', conversation: 4 });
  await env.open([PROTOCOL, `promptcut.ticket.${tk.ticket}`], other(63));
  const pr = await waitFor(() => env.principals().find((p) => p.role === 'agent' && p.userId === `zoe@${dev.deviceId}`), 2000, 'agent 连接');
  assert.equal(pr.conversation, 4);

  const bad = tk.ticket.slice(0, -1) + (tk.ticket.at(-1) === 'A' ? 'B' : 'A');
  assert.equal((await env.handshake([PROTOCOL, `promptcut.ticket.${bad}`], other(64))).status, 401, '签名错');
  const asset = await ticketOf(page, { kind: 'asset', access: 'r' });
  assert.equal(parseTicket(asset.ticket).body.k, 'asset');
  assert.equal((await env.handshake([PROTOCOL, `promptcut.ticket.${asset.ticket}`], other(65))).status, 401, '素材票据不能进连接');

  const local = await env.open([PROTOCOL]);
  const r = await ask(local, { type: 'auth.ticket', kind: 'conn', role: 'render' }, 'auth.ticket.ok');
  assert.equal(r.type, 'error', `本机 local 身份要不到票据：${JSON.stringify(r)}`);
});

// ------------------------------------------------------------------ client.mjs 对拍（第 2、11 节）

test('AU2 client.mjs：deriveKey 与 node:crypto 的 PBKDF2 对拍；buildAuthProtocols 拼出的子协议能进；ticketExpiry 读出 exp', async (t) => {
  const client = await loadClient();
  const salt = b64u(randomBytes(16));
  const k = await client.deriveKey('pässwörd-口令', salt, KDF);
  const got = typeof k === 'string' ? k : b64u(k);
  const want = pbkdf2Sync(Buffer.from('pässwörd-口令', 'utf8'), Buffer.from(salt, 'base64url'), KDF.iter, 32, 'sha256').toString('base64url');
  assert.equal(got, want, 'deriveKey = PBKDF2-HMAC-SHA256(口令 UTF-8, 盐的 16 字节, iter, 32)');

  const env = await hostFor(t);
  // 用 client.mjs 的 deriveKey 建项目，再用 buildAuthProtocols 进
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
  assert.ok(Array.isArray(protocols) && protocols.includes(PROTOCOL), `buildAuthProtocols 回子协议数组：${JSON.stringify(protocols)}`);
  const c = await env.open(protocols);
  const tk = await ticketOf(c, { kind: 'asset', access: 'r' });
  assert.equal(client.ticketExpiry(tk.ticket), tk.exp);
  // 同一组参数再拼一次（每次都要新 nonce）也能进
  const again = await client.buildAuthProtocols({
    base: env.httpBase, projectId: r.json.projectId, username: 'alice', deviceId: dev.deviceId, deviceName: dev.deviceName,
    as: 'creator', password: 'c-pw', role: 'render', owner: { kind: 'user' },
  });
  assert.equal((await env.handshake(again)).status, 101);
  // 用 key 代替 password
  const again2 = await client.buildAuthProtocols({
    base: env.httpBase, projectId: r.json.projectId, username: 'zoe', deviceId: dev.deviceId, deviceName: dev.deviceName,
    as: 'member', key: toB64(await client.deriveKey('p-pw', psalt, KDF)), role: 'agent', conversation: 2,
  });
  assert.equal((await env.handshake(again2)).status, 101);
  // 同一份凭证在测试工具里派生出的 K 与 client 一致（说明测试工具与客户端对盐的理解相同）
  assert.equal(derive('p-pw', psalt), toB64(await client.deriveKey('p-pw', psalt, KDF)));
  void credential;
});

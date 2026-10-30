/**
 * `server/auth/` 的服务端部件（实现方自测；契约 `docs/plan/auth-contract.md` 第 3、4、5、8、9 节）：
 * 凭证存储、挑战、限速、票据、握手鉴权（不起服务，用假请求）。
 * 跑：node --test server/test/auth-impl-units.test.mjs
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

// ------------------------------------------------------------------ 存储

test('store：首次打开生成 server.json；建、查、改、删；重开后记录还在；名字按 NFC + 小写唯一', () => {
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
  assert.equal(rec.list, undefined, '自由进入没有名单');
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
  assert.equal(up.name, 'Café', 'update 不能改名');
  assert.equal(st.get(rec.projectId).generation, 2);
  assert.equal(st.update('sp_nope', () => {}), null);

  const reopened = openCredentialStore({ dir });
  assert.equal(reopened.count(), 2);
  assert.equal(reopened.get(rec.projectId).generation, 2);
  assert.equal(reopened.serverSecret.toString('base64url'), serverJson.secret, '服务端密钥跨重开不变');
  assert.equal(st.remove(rec.projectId), true);
  assert.equal(st.remove(rec.projectId), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(st.nameTaken('café'), false, '删了名字就释放');
  // 返回的是副本：改它不影响存储
  const copy = st.get(r2.projectId);
  copy.generation = 99;
  assert.equal(st.get(r2.projectId).generation, 1);
});

test('store：目录不可用（是个文件）、server.json 坏了、项目文件坏了 → 打开时抛错（失败即关）', () => {
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

test('store：credentialStoreFor 按目录取进程内单例；forget 之后重新打开', () => {
  const dir = path.join(tempDir('pc-au-'), 'auth');
  assert.equal(existingCredentialStore(dir), null);
  const a = credentialStoreFor(dir);
  assert.equal(credentialStoreFor(path.join(dir, '.')), a, '同一目录同一份');
  assert.equal(existingCredentialStore(dir), a);
  forgetCredentialStore(dir);
  assert.notEqual(credentialStoreFor(dir), a);
  forgetCredentialStore(dir);
});

test('store：projectId 是 sp_ 加 26 位小写 base32，互不相同', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const id = newProjectId();
    assert.ok(isProjectId(id), id);
    seen.add(id);
  }
  assert.equal(seen.size, 500);
});

// ------------------------------------------------------------------ 挑战

test('challenges：只能用一次、60 s 过期、绑定一致；用过的再交回 used，没见过的 unknown', () => {
  const now = clock();
  const ch = createChallenges({ now });
  const b = ['join', 'sp_x', 'bob', 'dev', 'member'];
  const n1 = ch.issue(b);
  assert.equal(Buffer.from(n1, 'base64url').length, 32);
  assert.equal(ch.check(n1, b), 'ok');
  assert.equal(ch.check(n1, b), 'used');
  const n2 = ch.issue(b);
  assert.equal(ch.check(n2, ['join', 'sp_x', 'bob', 'dev', 'creator']), 'mismatch');
  assert.equal(ch.check(n2, b), 'used', '绑定不符也作废');
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

test('challenges：在册数量有上限，超出丢最早发的', () => {
  const ch = createChallenges({ max: 3 });
  const ns = [1, 2, 3, 4].map((i) => ch.issue(['x', i]));
  assert.ok(ch.size() <= 3);
  assert.equal(ch.consume(ns[0], ['x', 1]), false);
  assert.equal(ch.consume(ns[3], ['x', 4]), true);
});

// ------------------------------------------------------------------ 限速

test('rate-limit：1 分钟内第 5 次失败进入 60 s 冷却；冷却期内再失败不延长；过后清零；别的来源不受影响', () => {
  const now = clock();
  const rl = createRateLimiter({ now });
  for (let i = 0; i < 4; i++) assert.equal(rl.fail('1.1.1.1'), false);
  assert.equal(rl.blocked('1.1.1.1'), false);
  assert.equal(rl.fail('1.1.1.1'), true, '第 5 次进入冷却');
  assert.equal(rl.blocked('1.1.1.1'), true);
  assert.equal(rl.blocked('2.2.2.2'), false);
  now.add(30_000);
  rl.fail('1.1.1.1');
  now.add(29_999);
  assert.equal(rl.blocked('1.1.1.1'), true, '60 s 以内');
  now.add(2);
  assert.equal(rl.blocked('1.1.1.1'), false, '60 s 之后恢复');
  assert.equal(rl.fail('1.1.1.1'), false, '冷却过后从零数');
  // 失败分散在一分钟以外不累计
  const rl2 = createRateLimiter({ now });
  for (let i = 0; i < 10; i++) { rl2.fail('3.3.3.3'); now.add(15_000); }
  assert.equal(rl2.blocked('3.3.3.3'), false);
});

// ------------------------------------------------------------------ 票据

function ticketFixture() {
  const now = clock(Date.UTC(2026, 8, 26));
  const st = freshStore(now);
  const rec = st.create({ name: `t-${Math.random()}`, mode: 'free', kdf: FAST_KDF, creator: { username: 'alice', ...cred() }, project: cred() });
  const lookup = (id) => st.peek(id);
  return { now, st, rec, lookup };
}

test('tickets：签发的形状与字段；核对通过；过期、代数、签名、类别、长度各情形', () => {
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

  // 时钟：过期后 30 s 内照认，再往后不认；签发时刻在未来超过 30 s 不认
  assert.equal(verifyTicket(ticket, { lookup, now: exp + 30_000 }).ok, true);
  assert.equal(verifyTicket(ticket, { lookup, now: exp + 30_001 }).reason, 'expired');
  assert.equal(verifyTicket(ticket, { lookup, now: now() - 30_001 }).reason, 'expired');

  // 签名：改负载一个字、改签名、换密钥
  const tampered = `v1.${Buffer.from(JSON.stringify({ ...payload, r: 'rw', u: 'mallory@dev-000000000001' })).toString('base64url')}.${sig}`;
  assert.equal(verifyTicket(tampered, { lookup, now: now() }).reason, 'signature');
  const flip = sig[0] === 'A' ? 'B' : 'A';
  assert.equal(verifyTicket(`v1.${seg}.${flip}${sig.slice(1)}`, { lookup, now: now() }).reason, 'signature');
  // 负载里的 exp - iat 超过有效期：签名对也不认
  const long = { ...payload, exp: payload.iat + 16 * 60_000 };
  const longSeg = Buffer.from(JSON.stringify(long)).toString('base64url');
  const longSig = crypto.createHmac('sha256', Buffer.from(rec.ticketKey, 'base64url')).update(`v1.${longSeg}`).digest('base64url');
  assert.equal(verifyTicket(`v1.${longSeg}.${longSig}`, { lookup, now: now() }).reason, 'format');

  // 代数：项目代数、用户代数变了都不认
  st.update(rec.projectId, (d) => { d.generation += 1; });
  assert.equal(verifyTicket(ticket, { lookup, now: now() }).reason, 'generation');
  const t2 = signTicket(st.peek(rec.projectId), { k: 'asset', u, r: 'r' }, now()).ticket;
  assert.equal(verifyTicket(t2, { lookup, now: now() }).ok, true);
  st.update(rec.projectId, (d) => { d.userGenerations[u] = userGeneration(d, u) + 1; });
  assert.equal(verifyTicket(t2, { lookup, now: now() }).reason, 'generation');
  const other = signTicket(st.peek(rec.projectId), { k: 'asset', u: 'carol@dev-000000000002', r: 'r' }, now()).ticket;
  assert.equal(verifyTicket(other, { lookup, now: now() }).ok, true, '别的用户不受影响');

  // 格式
  for (const bad of ['', 'v1', 'v1.a.b', `v2.${seg}.${sig}`, `v1.${seg}`, 'x'.repeat(2049), `v1.${seg}.${sig}.x`]) {
    assert.equal(verifyTicket(bad, { lookup, now: now() }).ok, false, bad.slice(0, 20));
  }
  // 项目不在了
  st.remove(rec.projectId);
  assert.equal(verifyTicket(other, { lookup, now: now() }).reason, 'no-project');
});

test('tickets：连接票据 2 分钟、带角色 / 对话号 / 归属；轮换期间旧密钥照认到 until', () => {
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
  assert.equal(verifyTicket(oldTicket, { lookup, now: now() }).ok, true, '轮换期内旧票据照认');
  assert.equal(verifyTicket(oldTicket, { lookup, now: now() + 1001 }).reason, 'signature', '过了 until 不认');
  const fresh = signTicket(st.peek(rec.projectId), { k: 'asset', u, r: 'r' }, now()).ticket;
  assert.equal(verifyTicket(fresh, { lookup, now: now() }).ok, true);
});

// ------------------------------------------------------------------ 握手鉴权（假请求）

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

test('handshake：证明对 → 成员 principal 字段齐全；nonce 复用、四元组不符、证明错、名单外 → null 并记原因', () => {
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
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', good)), null, 'nonce 复用');
  const n2 = issue();
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', makeProof({ key: project.key, projectId: rec.projectId, username: 'bobby', deviceId: dev, nonce: n2 }))), null, '四元组不符');
  const n3 = issue();
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', makeProof({ key: cred().key, projectId: rec.projectId, username: 'bob', deviceId: dev, nonce: n3 }))), null, '口令错');
  const n4 = issue('bob', 'creator');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', makeProof({ key: project.key, projectId: rec.projectId, username: 'bob', deviceId: dev, as: 'creator', nonce: n4 }))), null, '不是创建者');
  const n5 = issue('alice', 'creator');
  const asCreator = f.auth.authenticate(f.req('promptcut.v1', makeProof({ key: creator.key, projectId: rec.projectId, username: 'alice', deviceId: dev, as: 'creator', nonce: n5, role: 'agent', extra: { c: 2 } })));
  assert.equal(asCreator.creator, true);
  assert.equal(asCreator.conversation, 2);
  assert.deepEqual(f.logs.map((l) => l.reason), ['nonce', 'nonce', 'bad-proof', 'not-listed']);
  assert.ok(f.logs.every((l) => l.e === 'auth.reject' && l.remote === '10.0.0.9'));
  assert.ok(!JSON.stringify(f.logs).includes(project.key));
});

test('handshake：格式与组合规则（多项、缺 promptcut.v1、agent 缺对话号、owner 给了非 render、JSON 超 1024 字节）', () => {
  const f = handshakeFixture();
  const project = cred();
  const rec = f.st.create({ name: 'h2', mode: 'free', kdf: FAST_KDF, creator: { username: 'alice', ...cred() }, project });
  const dev = 'dev-000000000002';
  const p = (extra = {}, role = 'page') => makeProof({ key: project.key, projectId: rec.projectId, username: 'bob', deviceId: dev, nonce: f.challenges.issue(['join', rec.projectId, 'bob', dev, 'member']), role, extra });
  const reasons = () => f.logs.map((l) => l.reason);
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', p(), 'promptcut.ticket.x')), null);
  assert.equal(f.auth.authenticate(f.req(p())), null, '缺 promptcut.v1');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', p({}, 'agent'))), null, 'agent 缺对话号');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', p({ c: 1 }, 'page'))), null, 'page 带对话号');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', p({ o: { kind: 'user' } }, 'page'))), null, 'owner 只给 render');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', p({ pad: 'x'.repeat(1100) }))), null, 'JSON 超 1024 字节');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', 'promptcut.auth.!!!')), null);
  assert.equal(f.auth.authenticate(f.req('promptcut.v1', 'promptcut.role.render')), null, '只有角色项');
  assert.equal(f.auth.authenticate(f.req('promptcut.v1')), null, '非回环什么都不带');
  assert.deepEqual(reasons(), ['multiple', 'bad-format', 'bad-format', 'bad-format', 'bad-format', 'bad-format', 'bad-format', 'bad-format', 'no-credential']);
});

test('handshake：回环什么都不带是本机身份；本机声明只在回环认、项目要存在；令牌只在给了且允许时认', () => {
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
  assert.equal(loop.auth.authenticate(loop.req('promptcut.v1', `promptcut.tenant.${newProjectId()}`)), null, '项目不存在');
  assert.deepEqual(loop.auth.authenticate(loop.req('promptcut.v1', `promptcut.token.${token}`)), ADMIN_PRINCIPAL);
  assert.equal(loop.auth.authenticate(loop.req('promptcut.v1', `promptcut.token.${token}`, `promptcut.tenant.${rec.projectId}`)), null, '令牌不能和别的项一起');

  const lan = handshakeFixture({ loopback: false });
  const rec2 = lan.st.create({ name: 'h3b', mode: 'free', kdf: FAST_KDF, creator: { username: 'alice', ...cred() }, project: cred() });
  assert.equal(lan.auth.authenticate(lan.req('promptcut.v1', `promptcut.tenant.${rec2.projectId}`)), null, '非回环的本机声明');
  assert.equal(lan.auth.authenticate(lan.req('promptcut.v1', `promptcut.token.${token}`)), null, '没配令牌');

  const noToken = handshakeFixture({ loopback: true });
  const auth2 = createHandshakeAuth({ store: noToken.st, challenges: noToken.challenges, limiter: noToken.limiter, clusterToken: token, acceptToken: false, isLoopback: () => true });
  assert.equal(auth2.authenticate(noToken.req('promptcut.v1', `promptcut.token.${token}`)), null, '挂载模式一律不认令牌');
  assert.throws(() => createHandshakeAuth({ store: null, challenges: noToken.challenges, limiter: noToken.limiter, clusterToken: 'short', isLoopback: () => true }), TypeError);
});

test('handshake：限定进入——名单内能进、名单外与禁入表 401；创建者以 member 身份进入也算创建者', () => {
  const f = handshakeFixture();
  const creator = cred();
  const bob = cred();
  const rec = f.st.create({ name: 'h4', mode: 'restricted', kdf: FAST_KDF, creator: { username: 'alice', ...creator }, list: [{ username: 'bob', ...bob }] });
  const dev = 'dev-000000000004';
  const go = (username, key, as = 'member') => f.auth.authenticate(f.req('promptcut.v1', makeProof({ key, projectId: rec.projectId, username, deviceId: dev, as, nonce: f.challenges.issue(['join', rec.projectId, username, dev, as]) })));
  assert.equal(go('bob', bob.key).username, 'bob');
  assert.equal(go('carol', bob.key), null, '名单外');
  const a = go('alice', creator.key);
  assert.equal(a.creator, true, '创建者自动算名单的一员');
  f.st.update(rec.projectId, (d) => { d.bans.push({ username: 'bob', deviceId: dev }); });
  assert.equal(go('bob', bob.key), null, '禁入');
  assert.deepEqual(f.logs.map((l) => l.reason), ['not-listed', 'banned']);
  assert.equal(credentialFor(f.st.peek(rec.projectId), 'carol', 'member'), null);
  assert.equal(admissionOf(f.st.peek(rec.projectId), { username: 'bob', deviceId: dev, creator: false }), 'banned');
});

test('handshake：限速——同一来源错 5 次后冷却期内口令对也拒；重放用过的 nonce 不计数；61 s 后恢复', () => {
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
    assert.equal(a.replay(), null, '重放（Node 的 WebSocket 在 401 后会原样再请求一次）');
  }
  assert.equal(f.limiter.blocked('10.0.0.9'), false, '重放不计数：4 次失败还没到冷却');
  assert.equal(attempt(cred().key).first, null);
  assert.equal(f.limiter.blocked('10.0.0.9'), true);
  assert.equal(attempt(project.key).first, null, '冷却期内口令对也拒');
  assert.equal(f.logs.at(-1).reason, 'rate-limited');
  f.now.add(61_000);
  assert.ok(attempt(project.key).first, '61 s 后恢复');
});

test('isLoopbackAddress', () => {
  for (const a of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ['10.0.0.1', '::ffff:10.0.0.1', '', null, 'fe80::1']) assert.equal(isLoopbackAddress(a), false, String(a));
});

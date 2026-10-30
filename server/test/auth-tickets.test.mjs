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

test('AU7 票据形状：v1.<负载>.<签名>；负载字段齐全；素材票据有效期不超过 15 分钟', async (t) => {
  const { member, proj, dev } = await setup(t);
  const r = await ticketOf(member, { kind: 'asset', access: 'rw' });
  assert.match(r.ticket, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(r.ticket.length <= 2048);
  const { body } = parseTicket(r.ticket);
  for (const k of ['kid', 'k', 'p', 'u', 'r', 'g', 'ug', 'exp', 'iat']) assert.ok(k in body, `负载有 ${k}：${JSON.stringify(body)}`);
  assert.equal(body.k, 'asset');
  assert.equal(body.r, 'rw');
  assert.equal(body.p, proj.projectId);
  assert.equal(body.u, `zoe@${dev.deviceId}`);
  assert.ok(body.exp - body.iat <= 15 * 60_000 && body.exp > body.iat, `有效期：${body.exp - body.iat}`);
  assert.equal(r.exp, body.exp);
  const ro = parseTicket((await ticketOf(member, { kind: 'asset', access: 'r' })).ticket).body;
  assert.equal(ro.r, 'r');
});

test('AU7 读：Bearer 或查询串票据 → 200；Range 206；查询串票据的响应带 no-store 与 no-referrer', async (t) => {
  const { env, blob, member } = await setup(t);
  const ro = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  const rw = (await ticketOf(member, { kind: 'asset', access: 'rw' })).ticket;
  for (const [what, tk] of [['只读', ro], ['读写', rw]]) {
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
  assert.equal(q.status, 200, '查询串只读票据');
  assert.deepEqual(q.buf, blob.bytes);
  assert.equal(q.headers.get('cache-control'), 'no-store');
  assert.equal(q.headers.get('referrer-policy'), 'no-referrer');
  const qr = await read(env, blob.hash, { Range: 'bytes=0-9' }, `?t=${encodeURIComponent(ro)}`);
  assert.equal(qr.status, 206, '查询串 + Range');
});

test('AU7 读：无票据、签名错、负载被改、查询串用读写票据 → 401 unauthorized', async (t) => {
  const { env, blob, member } = await setup(t);
  const ro = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  const rw = (await ticketOf(member, { kind: 'asset', access: 'rw' })).ticket;
  const cases = [
    ['无票据', {}, ''],
    ['签名错', bearer(flipSignature(ro)), ''],
    ['负载被改（延长 exp）', bearer(tamperTicket(ro, { exp: parseTicket(ro).body.exp + 3_600_000 })), ''],
    ['负载被改（r → rw）', bearer(tamperTicket(ro, { r: 'rw' })), ''],
    ['不是票据', bearer('garbage'), ''],
    ['查询串签名错', {}, `?t=${encodeURIComponent(flipSignature(ro))}`],
    ['查询串用读写票据', {}, `?t=${encodeURIComponent(rw)}`],
    ['超长票据', bearer(`v1.${'A'.repeat(2100)}.AAAA`), ''],
  ];
  for (const [what, headers, query] of cases) {
    const r = await read(env, blob.hash, headers, query);
    assert.equal(r.status, 401, `${what}：${r.status}`);
    assert.deepEqual(r.json, { ok: false, error: 'unauthorized' }, what);
    const h = await read(env, blob.hash, headers, query, 'HEAD');
    assert.equal(h.status, 401, `HEAD ${what}`);
  }
});

test('AU7 读：过期（15 分钟 + 30 s 偏差，注入时钟）→ 401；偏差之内仍有效；同一段播放的每个 Range 都重新核对', async (t) => {
  const { env, blob, member } = await setup(t);
  const tk = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  const { exp } = parseTicket(tk).body;
  const until = exp - Date.now();
  env.clock.advance(until + 20_000);
  const r1 = await read(env, blob.hash, { ...bearer(tk), Range: 'bytes=0-9' });
  assert.equal(r1.status, 206, '过期后 20 s（30 s 偏差之内）仍有效');
  env.clock.advance(15_000);
  const r2 = await read(env, blob.hash, { ...bearer(tk), Range: 'bytes=10-19' });
  assert.equal(r2.status, 401, '过期 35 s：下一个 Range 请求 401');
  const r3 = await read(env, blob.hash, {}, `?t=${encodeURIComponent(tk)}`);
  assert.equal(r3.status, 401, '查询串同样过期');
});

test('AU7 写：无票据、只读票据、签名错、查询串 → 401 / 403；读写票据照常写', async (t) => {
  const { env, member } = await setup(t);
  const ro = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  const rw = (await ticketOf(member, { kind: 'asset', access: 'rw' })).ticket;

  const none = await remotePut(env, LAN);
  assert.equal(none.status, 401, '无票据写');
  assert.deepEqual(none.json, { ok: false, error: 'unauthorized' });
  const bad = await remotePut(env, LAN, bearer(flipSignature(rw)));
  assert.equal(bad.status, 401, '签名错写');
  const readOnly = await remotePut(env, LAN, bearer(ro));
  assert.equal(readOnly.status, 403, '只读票据写');
  assert.deepEqual(readOnly.json, { ok: false, error: 'forbidden' });
  const byQuery = await remotePut(env, LAN, {}, `?t=${encodeURIComponent(rw)}`);
  assert.equal(byQuery.status, 401, '查询串用于写入一律不认');
  const byQueryRo = await remotePut(env, LAN, {}, `?t=${encodeURIComponent(ro)}`);
  assert.equal(byQueryRo.status, 401, '查询串只读票据写');

  const ok = await remotePut(env, LAN, bearer(rw));
  assert.equal(ok.status, 200, `读写票据写：${ok.buf.toString()}`);
  // complete 也要票据
  const hash = ok.json.hash;
  const c0 = await env.asset(`media/${hash}/complete`, { method: 'POST', remote: LAN });
  assert.equal(c0.status, 401, 'complete 无票据');
  const c1 = await env.asset(`media/${hash}/complete`, { method: 'POST', remote: LAN, headers: bearer(ro) });
  assert.equal(c1.status, 403, 'complete 只读票据');
  const c2 = await env.asset(`media/${hash}/complete`, { method: 'POST', remote: LAN, headers: bearer(rw) });
  assert.equal(c2.status, 200, `complete 读写票据：${c2.buf.toString()}`);
});

test('AU7 项目代数变了（set-password）→ 旧票据 401；新票据可用', async (t) => {
  const { env, blob, member, creator, proj } = await setup(t);
  const old = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  assert.equal((await read(env, blob.hash, bearer(old))).status, 200);
  const r = await adminOp(creator, proj, 'set-password', { project: credential('rotated') });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  const after = await read(env, blob.hash, bearer(old));
  assert.equal(after.status, 401, 'set-password 后旧票据 401');
  assert.deepEqual(after.json, { ok: false, error: 'unauthorized' });
  assert.equal((await read(env, blob.hash, {}, `?t=${encodeURIComponent(old)}`)).status, 401, '查询串同样');
  // 在线连接不断，仍能要新票据
  const fresh = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  assert.ok(parseTicket(fresh).body.g > parseTicket(old).body.g, '新票据带新的项目代数');
  assert.equal((await read(env, blob.hash, bearer(fresh))).status, 200);
});

test('AU7 项目代数变了（set-list）→ 名单里其余人的旧票据也 401', async (t) => {
  const { env, blob, member, creator, proj } = await setup(t, { mode: 'restricted' });
  const old = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  const r = await adminOp(creator, proj, 'set-list', { list: [credential('bob-pw', 'bob'), credential('new-pw', 'newbie')] });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  assert.equal((await read(env, blob.hash, bearer(old))).status, 401);
});

test('AU7 用户代数变了（kick）→ 被踢者旧票据 401，别人的不受影响', async (t) => {
  const { env, blob, member, creator, proj, dev } = await setup(t);
  const other = await join(env, proj, { username: 'yan', remote: '192.168.1.79' });
  const mine = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  const theirs = (await ticketOf(other, { kind: 'asset', access: 'r' })).ticket;
  const r = await adminOp(creator, proj, 'kick', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  assert.equal((await read(env, blob.hash, bearer(mine))).status, 401, '被踢者');
  assert.equal((await read(env, blob.hash, bearer(theirs))).status, 200, '别人');
});

test('AU7 回环来源不带票据照常读写；集群令牌不再用于素材服务', async (t) => {
  const env = await hostFor(t, { assets: true, clusterToken: randomToken() });
  const blob = await uploadLocal(env);
  const g = await env.asset(`media/${blob.hash}`);
  assert.equal(g.status, 200, '回环读');
  assert.deepEqual(g.buf, blob.bytes);
  const token = env.clusterToken;
  const w = await remotePut(env, LAN, bearer(token));
  assert.equal(w.status, 401, '非回环凭集群令牌写 → 401（C5 退役）');
  const r = await env.asset(`media/${blob.hash}`, { remote: LAN, headers: bearer(token) });
  assert.equal(r.status, 401, '非回环凭集群令牌读 → 401');
});

test('AU7 票据能读这台服务上任何已知哈希（不限定哈希）；另一个项目的票据同样能读', async (t) => {
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

test('AU7 CORS：预检的 Access-Control-Allow-Headers 含 Authorization', async (t) => {
  const env = await hostFor(t, { assets: true });
  const r = await env.asset('media/0000000000000000000000000000000000000000000000000000000000000000', {
    method: 'OPTIONS', remote: LAN, headers: { Origin: 'http://192.168.1.5:5173', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
  });
  assert.equal(r.status, 204);
  assert.match(r.headers.get('access-control-allow-headers') ?? '', /authorization/i);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('AU7 带票据请求的访问日志只记路径，不记查询串', async (t) => {
  const { env, blob, member } = await setup(t);
  const tk = (await ticketOf(member, { kind: 'asset', access: 'r' })).ticket;
  await read(env, blob.hash, {}, `?t=${encodeURIComponent(tk)}`);
  await read(env, blob.hash, bearer(tk));
  const all = env.logs.map((l) => JSON.stringify(l)).join('\n');
  assert.ok(!all.includes(tk), '日志里不出现票据原文');
  assert.ok(!all.includes(parseTicket(tk).payload), '日志里不出现票据负载段');
});

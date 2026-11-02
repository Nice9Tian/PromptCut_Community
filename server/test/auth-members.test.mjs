/**
 * M6a 共享项目：成员列表、创建者操作、连接角色（契约 `docs/plan/auth-contract.md` 第 6、7 节，用例 AU4、AU5、AU6、AU10）。
 * 跑：node --test server/test/auth-members.test.mjs
 *
 * 只照契约写，不看实现。起服务的接口是测试方的假设，集中在 `auth-kit.mjs` 文件头。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  hostFor, createProject, join, joinStatus, newDevice, members, adminOp, ask, askOrNull, ticketOf, credential,
  waitFor, sleep, bearer, uploadLocal, uniqueName, PROTOCOL,
} from './auth-kit.mjs';
import { snapshotTaskInput, byType } from './fake-ws-kit.mjs';

const R = (i) => `198.51.100.${i}`;

/** 等连接被服务端关闭，回 { code, reason }；ms 内没关就抛错 */
async function closedWithin(c, ms, what) {
  let timer;
  const e = await Promise.race([
    c.closed,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: did not close within ${ms} ms`)), ms); }),
  ]);
  clearTimeout(timer);
  return { code: e.code, reason: e.reason };
}

const rowOf = (devices, deviceId) => devices.find((d) => d.deviceId === deviceId);

// ------------------------------------------------------------------ AU4

test('AU4 two devices report the same username: userId differs; both show "username (device name)"; after one leaves, the other reverts to showing only the username', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const devA = newDevice('Desk');
  const devB = newDevice('Phone');
  const devC = newDevice('Obs');
  const a = await join(env, proj, { username: 'sam', device: devA, remote: R(1) });
  const b = await join(env, proj, { username: 'sam', device: devB, remote: R(2) });
  const obs = await join(env, proj, { username: 'olga', device: devC, remote: R(3) });

  const ids = env.principals().filter((p) => p.username === 'sam').map((p) => p.userId).sort();
  assert.deepEqual(ids, [`sam@${devA.deviceId}`, `sam@${devB.deviceId}`].sort(), 'the two userIds differ, both are username@deviceId');

  const list = await waitFor(async () => {
    const d = await members(obs);
    return rowOf(d, devA.deviceId) && rowOf(d, devB.deviceId) ? d : null;
  }, 3000, 'two sam devices in the member list');
  const rowA = rowOf(list, devA.deviceId);
  const rowB = rowOf(list, devB.deviceId);
  assert.equal(rowA.displayName, `sam (${devA.deviceName})`);
  assert.equal(rowB.displayName, `sam (${devB.deviceName})`);
  assert.equal(rowA.username, 'sam');
  assert.equal(rowA.deviceName, devA.deviceName);
  assert.equal(rowA.creator, false);
  assert.equal(rowOf(list, devC.deviceId).displayName, 'olga', 'a name that is not duplicated shows only the username');
  for (const row of list) {
    for (const k of ['deviceId', 'deviceName', 'username', 'displayName', 'creator', 'tags', 'conns']) assert.ok(k in row, `row has ${k}: ${JSON.stringify(row)}`);
    for (const k of ['editing', 'rendering', 'agents']) assert.ok(k in row.tags, `tags has ${k}`);
  }

  // 订阅变化：B 离开后观察者收到一条新的 shared.members.list
  await askOrNull(obs, { type: 'shared.watch' });
  const mark = obs.all.length;
  b.close();
  await waitFor(() => obs.all.slice(mark).some((m) => m.type === 'shared.members.list' && !rowOf(m.devices, devB.deviceId)), 3000, 'watch pushes the list after B leaves');
  const after = await members(obs);
  assert.equal(rowOf(after, devB.deviceId), undefined, 'B is no longer in the list');
  assert.equal(rowOf(after, devA.deviceId).displayName, 'sam', 'shows only the username when one device remains');
  void a;
});

// ------------------------------------------------------------------ AU5

test('AU5 creator operation set-password (open entry): takes effect with a proof; old passphrase 401, new passphrase 101; live connections stay up', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(10) });
  const member = await join(env, proj, { username: 'zoe', remote: R(11) });
  const r = await adminOp(creator, proj, 'set-password', { project: credential('new-pw') });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: R(12) }), 401, 'old passphrase');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', password: 'new-pw', remote: R(13) }), 101, 'new passphrase');
  await sleep(200);
  assert.equal(member.ws.readyState, 1, 'live connection stays up');
  // set-password 只用于自由进入：限定进入的项目上回 error
  const rproj = await createProject(env, { mode: 'restricted' });
  const rc = await join(env, rproj, { username: 'alice', as: 'creator', remote: R(14) });
  const bad = await adminOp(rc, rproj, 'set-password', { project: credential('x') });
  assert.equal(bad.type, 'error', `set-password under restricted entry: ${JSON.stringify(bad)}`);
});

test('AU5 creator operation set-list (restricted entry): replaces the whole list; people on the new list get in; the creator still gets in when not in the list', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }] });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(20) });
  const r = await adminOp(creator, proj, 'set-list', { list: [credential('dan-pw', 'dan')] });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  proj.list = [{ username: 'dan', password: 'dan-pw' }];
  assert.equal(await joinStatus(env, proj, { username: 'dan', remote: R(21) }), 101);
  assert.equal(await joinStatus(env, proj, { username: 'bob', password: 'bob-pw', remote: R(22) }), 401, 'removed by the whole-list replacement');
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'member', password: proj.creator.password, remote: R(23) }), 101, 'the creator is always on the list');
  const fproj = await createProject(env, { mode: 'free' });
  const fc = await join(env, fproj, { username: 'alice', as: 'creator', remote: R(24) });
  const bad = await adminOp(fc, fproj, 'set-list', { list: [credential('x', 'x')] });
  assert.equal(bad.type, 'error', `set-list under open entry: ${JSON.stringify(bad)}`);
});

test('AU5 creator operations kick and unban take effect with a proof', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(30) });
  const dev = newDevice();
  const zoe = await join(env, proj, { username: 'zoe', device: dev, remote: R(31) });
  const k = await adminOp(creator, proj, 'kick', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal(k.type, 'shared.admin.ok', JSON.stringify(k));
  const closed = await closedWithin(zoe, 3000, 'connection of the kicked member');
  assert.deepEqual(closed, { code: 4003, reason: 'kicked' });
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, remote: R(32) }), 401, 'banned');
  const u = await adminOp(creator, proj, 'unban', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal(u.type, 'shared.admin.ok', JSON.stringify(u));
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, remote: R(33) }), 101, 'can get in after unban');
});

test('AU5 creator operation delete: all connections in the space close with 4004 deleted; the record and space data are deleted; the name is released', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(40) });
  const m1 = await join(env, proj, { username: 'zoe', remote: R(41) });
  const m2 = await join(env, proj, { username: 'yan', role: 'render', remote: R(42) });
  // 在空间里写点东西，好确认数据被删
  const put = await ask(m1, { type: 'content.put', kind: 'card-source', key: 'k', body: { a: 1 } }, 'content.stored');
  assert.equal(put.type, 'content.stored', JSON.stringify(put));
  const tenantDir = path.join(env.dataDir, 'tenants', proj.projectId);
  const recordFile = path.join(env.dataDir, 'auth', 'projects', `${proj.projectId}.json`);
  assert.ok(fs.existsSync(recordFile));

  // 回包可能先于关闭到，也可能连接直接被关；两种都接受，但连接必须以 4004 关闭
  let r = null;
  try { r = await adminOp(creator, proj, 'delete'); } catch { r = null; }
  if (r) assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  for (const [c, what] of [[creator, 'creator'], [m1, 'member page'], [m2, 'member render']]) {
    assert.deepEqual(await closedWithin(c, 3000, what), { code: 4004, reason: 'deleted' }, what);
  }
  assert.equal(fs.existsSync(recordFile), false, 'project record deleted');
  assert.equal(fs.existsSync(tenantDir), false, 'all data of that space deleted');
  const l = await env.http(`shared/lookup?name=${encodeURIComponent(proj.name)}`);
  assert.equal(l.status, 404);
  const again = await env.http('shared/create', {
    method: 'POST',
    body: { name: proj.name, mode: 'free', kdf: { alg: 'pbkdf2-sha256', iter: 100_000 }, creator: credential('c', 'alice'), project: credential('p') },
  });
  assert.equal(again.status, 201, `name released: ${again.text}`);
  assert.notEqual(again.json.projectId, proj.projectId);
});

test('AU5 no proof, wrong proof, non-creator → forbidden, and no effect', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(50) });
  const member = await join(env, proj, { username: 'zoe', remote: R(51) });
  const victim = newDevice();
  const v = await join(env, proj, { username: 'vic', device: victim, remote: R(52) });

  const noProof = await adminOp(creator, proj, 'kick', { username: 'vic', deviceId: victim.deviceId }, { noProof: true });
  assert.deepEqual([noProof.type, noProof.reason], ['error', 'forbidden'], `no proof: ${JSON.stringify(noProof)}`);
  const wrong = await adminOp(creator, proj, 'kick', { username: 'vic', deviceId: victim.deviceId }, { badProof: true });
  assert.deepEqual([wrong.type, wrong.reason], ['error', 'forbidden'], `wrong proof: ${JSON.stringify(wrong)}`);
  const wrongPw = await adminOp(creator, proj, 'kick', { username: 'vic', deviceId: victim.deviceId }, { password: proj.password });
  assert.deepEqual([wrongPw.type, wrongPw.reason], ['error', 'forbidden'], `proof computed with the project passphrase: ${JSON.stringify(wrongPw)}`);
  // 非创建者：成员连接按自己的口令算证明
  const byMember = await adminOp(member, proj, 'kick', { username: 'vic', deviceId: victim.deviceId }, { password: proj.password, username: 'zoe' });
  assert.deepEqual([byMember.type, byMember.reason], ['error', 'forbidden'], `non-creator: ${JSON.stringify(byMember)}`);
  const byMemberNoProof = await adminOp(member, proj, 'delete', {}, { noProof: true });
  assert.deepEqual([byMemberNoProof.type, byMemberNoProof.reason], ['error', 'forbidden'], `non-creator without proof: ${JSON.stringify(byMemberNoProof)}`);
  // 别的连接的 nonce 不认：成员取的挑战给创建者用
  const ch = await ask(member, { type: 'shared.challenge' }, 'shared.challenge.ok');
  if (ch.type === 'shared.challenge.ok') {
    const { adminMac, derive } = await import('./auth-kit.mjs');
    const cch = await ask(creator, { type: 'shared.challenge' }, 'shared.challenge.ok');
    const key = derive(proj.creator.password, cch.salt);
    const m = adminMac(key, { projectId: proj.projectId, username: 'alice', op: 'kick', nonce: ch.nonce });
    const r = await ask(creator, { type: 'shared.admin', op: 'kick', username: 'vic', deviceId: victim.deviceId, proof: { nonce: ch.nonce, m } }, 'shared.admin.ok');
    assert.deepEqual([r.type, r.reason], ['error', 'forbidden'], `nonce must be fetched by the same connection: ${JSON.stringify(r)}`);
  }
  await sleep(200);
  assert.equal(v.ws.readyState, 1, 'the rejected kick had no effect');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: R(53) }), 101, 'the rejected operations changed nothing');
});

/** 数据面的全部消息类型（渲染任务队列、项目、内容库、服务地址、成员、票据），各给一条固定的消息 */
function dataPlaneScript() {
  const task = snapshotTaskInput({ resultKey: 'rk-au5', projectId: 'p-au5' });
  return [
    { type: 'node.hello', nodeId: 'n-au5', profile: 'pc' },
    { type: 'publisher.hello', publisherId: 'pub-au5' },
    { type: 'queue.watch', projects: 'all' },
    { type: 'task.publish', tasks: [task] },
    { type: 'task.claim', id: task.id, expectVersion: 1 },
    { type: 'task.progress', id: task.id, token: 'x', done: 1 },
    { type: 'task.complete', id: task.id, token: 'x' },
    { type: 'task.release', id: task.id, token: 'x' },
    { type: 'task.fail', id: task.id, token: 'x', error: 'e' },
    { type: 'card.lock', kind: 'bogus' },
    { type: 'task.unsubscribe', ids: [task.id] },
    { type: 'project.open', projectId: 'p-au5' },
    { type: 'project.announce', projectId: 'p-au5', digest: '0123456789abcdef' },
    { type: 'project.snapshot.put', projectId: 'p-au5' },
    { type: 'project.snapshot.get', projectId: 'p-au5', projectRev: 1 },
    { type: 'project.close', projectId: 'p-au5' },
    { type: 'content.put', kind: 'card-source', key: 'k', body: { x: 1 } },
    { type: 'content.get', kind: 'card-source', key: 'k' },
    { type: 'content.list', kind: 'card-source' },
    { type: 'content.watch', kinds: ['card-source'] },
    { type: 'service.watch' },
    { type: 'service.announce', announcerId: 'a-au5', kind: 'asset', urls: ['http://10.0.0.1:1/'] },
    { type: 'service.withdraw', announcerId: 'a-au5', kind: 'asset' },
    { type: 'shared.members' },
    { type: 'shared.watch' },
    { type: 'shared.challenge' },
    { type: 'auth.ticket', kind: 'asset', access: 'r' },
    { type: 'auth.ticket', kind: 'conn', role: 'render' },
    { type: 'no.such.type' },
  ];
}

const outcome = (r) => (r === null ? 'no-reply' : `${r.type}${r.type === 'error' ? `:${r.reason}` : ''}`);

test('AU5 apart from creator operations, creator and member get identical results for all data-plane messages (listed one by one)', async (t) => {
  const env = await hostFor(t);
  // 两个一模一样的项目：一边是创建者连接，一边是普通成员连接，状态演进相同
  const p1 = await createProject(env, { mode: 'free' });
  const p2 = await createProject(env, { mode: 'free' });
  const creator = await join(env, p1, { username: 'alice', as: 'creator', remote: R(60) });
  const member = await join(env, p2, { username: 'zoe', remote: R(61) });
  const rows = [];
  for (const msg of dataPlaneScript()) {
    const a = await askOrNull(creator, msg, 600);
    const b = await askOrNull(member, msg, 600);
    rows.push({ type: msg.type, creator: outcome(a), member: outcome(b) });
  }
  const diff = rows.filter((r) => r.creator !== r.member);
  assert.deepEqual(diff, [], `creator and member differ: ${JSON.stringify(diff)}\nAll: ${JSON.stringify(rows)}`);
  // 顺带核对几条确定的结果
  const byType = Object.fromEntries(rows.map((r) => [r.type, r.creator]));
  assert.equal(byType['node.hello'], 'error:forbidden', 'page connection sends node.hello');
  assert.equal(byType['service.announce'], 'error:forbidden', 'member sends service.announce');
  assert.equal(byType['content.put'], 'content.stored');
});

// ------------------------------------------------------------------ AU6

test('AU6 set-list removes someone: all of their connections close with 4003 removed within 5 s, re-handshake returns 401; people who stay on the list are unaffected', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }, { username: 'cara', password: 'cara-pw' }] });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(70) });
  const devB = newDevice();
  const bobPage = await join(env, proj, { username: 'bob', device: devB, remote: R(71) });
  const bobRender = await join(env, proj, { username: 'bob', device: devB, role: 'render', remote: R(71) });
  const bobOther = await join(env, proj, { username: 'bob', role: 'agent', c: 1, remote: R(72) });
  const cara = await join(env, proj, { username: 'cara', remote: R(73) });
  const r = await adminOp(creator, proj, 'set-list', { list: [credential('cara-pw', 'cara')] });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  const t0 = Date.now();
  for (const [c, what] of [[bobPage, 'bob page'], [bobRender, 'bob render'], [bobOther, 'agent of bob on another device']]) {
    assert.deepEqual(await closedWithin(c, 5000, what), { code: 4003, reason: 'removed' }, what);
  }
  assert.ok(Date.now() - t0 <= 5000);
  assert.equal(await joinStatus(env, proj, { username: 'bob', password: 'bob-pw', remote: R(74) }), 401, 're-handshake returns 401');
  await sleep(200);
  assert.equal(cara.ws.readyState, 1, 'people on the list are unaffected');
  assert.equal(creator.ws.readyState, 1);
});

test('AU6 kick: connection closes, ticket returns 401 immediately, re-entry returns 401; same name on another device or same device under another name is unaffected by the ban list; can get in after unban', async (t) => {
  const env = await hostFor(t, { assets: true });
  const { hash } = await uploadLocal(env);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(80) });
  const dev = newDevice();
  const zoe = await join(env, proj, { username: 'zoe', device: dev, remote: R(81) });
  const zoeRender = await join(env, proj, { username: 'zoe', device: dev, role: 'render', remote: R(81) });
  const other = await join(env, proj, { username: 'yan', remote: R(82) });
  const tk = (await ticketOf(zoe, { kind: 'asset', access: 'r' })).ticket;
  const conn = (await ticketOf(zoe, { kind: 'conn', role: 'render' })).ticket;
  const otk = (await ticketOf(other, { kind: 'asset', access: 'r' })).ticket;
  assert.equal((await env.asset(`media/${hash}`, { remote: R(81), headers: bearer(tk) })).status, 200, 'ticket works before the kick');

  const k = await adminOp(creator, proj, 'kick', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal(k.type, 'shared.admin.ok', JSON.stringify(k));
  for (const [c, what] of [[zoe, 'page'], [zoeRender, 'render']]) {
    assert.deepEqual(await closedWithin(c, 3000, what), { code: 4003, reason: 'kicked' }, what);
  }
  const after = await env.asset(`media/${hash}`, { remote: R(81), headers: bearer(tk) });
  assert.equal(after.status, 401, 'asset ticket returns 401 immediately');
  assert.deepEqual(after.json, { ok: false, error: 'unauthorized' });
  assert.equal((await env.handshake([PROTOCOL, `promptcut.ticket.${conn}`], R(81))).status, 401, 'connection ticket returns 401 immediately');
  assert.equal((await env.asset(`media/${hash}`, { remote: R(82), headers: bearer(otk) })).status, 200, 'tickets of other users are unaffected');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, remote: R(83) }), 401, 'same name on the same device entering again returns 401');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: R(84) }), 101, 'same name on another device is not on the ban list');
  assert.equal(await joinStatus(env, proj, { username: 'zed', device: dev, remote: R(85) }), 101, 'same device under another username is not on the ban list');

  const u = await adminOp(creator, proj, 'unban', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal(u.type, 'shared.admin.ok', JSON.stringify(u));
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, remote: R(86) }), 101, 'can get in after unban');
  // 踢过之后发的新票据可用（代数已前进，新票据带新代数）
  const z2 = await join(env, proj, { username: 'zoe', device: dev, remote: R(87) });
  const tk2 = (await ticketOf(z2, { kind: 'asset', access: 'r' })).ticket;
  assert.equal((await env.asset(`media/${hash}`, { remote: R(87), headers: bearer(tk2) })).status, 200);
  void uniqueName;
});

// ------------------------------------------------------------------ AU10

test('AU10 roles: page and agent connections sending node.hello return forbidden; render and local are allowed', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const hello = (nodeId) => ({ type: 'node.hello', nodeId, profile: 'pc' });
  const page = await join(env, proj, { username: 'zoe', remote: R(90) });
  const r1 = await ask(page, hello('n-page'), 'node.welcome');
  assert.deepEqual([r1.type, r1.reason], ['error', 'forbidden'], `page: ${JSON.stringify(r1)}`);
  const agent = await join(env, proj, { username: 'zoe', role: 'agent', c: 1, remote: R(90) });
  const r2 = await ask(agent, hello('n-agent'), 'node.welcome');
  assert.deepEqual([r2.type, r2.reason], ['error', 'forbidden'], `agent: ${JSON.stringify(r2)}`);
  const render = await join(env, proj, { username: 'zoe', role: 'render', remote: R(90) });
  const r3 = await ask(render, hello('n-render'), 'node.welcome');
  assert.equal(r3.type, 'node.welcome', `render: ${JSON.stringify(r3)}`);
  const local = await env.open([PROTOCOL]);
  const r4 = await ask(local, hello('n-local'), 'node.welcome');
  assert.equal(r4.type, 'node.welcome', `local: ${JSON.stringify(r4)}`);
});

test('AU10 write identity: the actor written by an agent connection carries a chat number; the actor written by a page has role page', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const dev = newDevice();
  const watcher = await join(env, proj, { username: 'wes', remote: R(100) });
  const w = await ask(watcher, { type: 'content.watch', kinds: ['card-source'] }, 'content.watching');
  assert.equal(w.type, 'content.watching');
  const agent = await join(env, proj, { username: 'zoe', device: dev, role: 'agent', c: 7, remote: R(101) });
  await ask(agent, { type: 'content.put', kind: 'card-source', key: 'a', body: 1, session: 's-agent' }, 'content.stored');
  const ch1 = await watcher.next((m) => m.type === 'content.changed' && m.key === 'a');
  assert.equal(ch1.actor.userId, `zoe@${dev.deviceId}`);
  assert.equal(ch1.actor.deviceId, dev.deviceId);
  assert.equal(ch1.actor.role, 'agent');
  assert.equal(ch1.actor.conversation, 7);
  assert.equal(ch1.actor.session, 's-agent');
  const page = await join(env, proj, { username: 'zoe', device: dev, remote: R(101) });
  await ask(page, { type: 'content.put', kind: 'card-source', key: 'b', body: 2 }, 'content.stored');
  const ch2 = await watcher.next((m) => m.type === 'content.changed' && m.key === 'b');
  assert.equal(ch2.actor.role, 'page');
  assert.ok(ch2.actor.conversation === null || ch2.actor.conversation === undefined, `page write has no chat number: ${JSON.stringify(ch2.actor)}`);
  // 项目版本日志同样记 actor
  await ask(watcher, { type: 'project.open', projectId: 'p1' }, 'project.state');
  await ask(agent, { type: 'project.announce', projectId: 'p1', digest: 'abcdef0123456789' }, 'project.announced');
  const rev = await watcher.next(byType('project.rev'));
  assert.equal(rev.actor.role, 'agent');
  assert.equal(rev.actor.conversation, 7);
  assert.equal(rev.actor.userId, `zoe@${dev.deviceId}`);
});

test('AU10 on one device, the two connections page + render are one row in the member list with correct tags; rendering is true once render holds a claim; agent count', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const dev = newDevice('Desk');
  const page = await join(env, proj, { username: 'zoe', device: dev, remote: R(110) });
  const render = await join(env, proj, { username: 'zoe', device: dev, role: 'render', o: { kind: 'user' }, remote: R(110) });
  let row = await waitFor(async () => {
    const r = rowOf(await members(page), dev.deviceId);
    return r && r.conns.length === 2 ? r : null;
  }, 3000, 'one row with two connections');
  assert.equal((await members(page)).filter((d) => d.deviceId === dev.deviceId).length, 1, 'grouped by device into one row');
  assert.deepEqual(row.tags, { editing: true, rendering: false, agents: 0 });
  assert.deepEqual(row.conns.map((c) => c.role).sort(), ['page', 'render']);
  assert.deepEqual(row.conns.find((c) => c.role === 'render').owner, { kind: 'user' });

  const agent = await join(env, proj, { username: 'zoe', device: dev, role: 'agent', c: 2, remote: R(110) });
  const agentRender = await join(env, proj, { username: 'zoe', device: dev, role: 'render', o: { kind: 'agent', c: 2 }, remote: R(110) });
  row = await waitFor(async () => {
    const r = rowOf(await members(page), dev.deviceId);
    return r && r.conns.length === 4 ? r : null;
  }, 3000, 'one row with four connections');
  assert.equal(row.tags.agents, 1);
  assert.equal(row.conns.find((c) => c.role === 'agent').conversation, 2);
  assert.deepEqual(row.conns.filter((c) => c.role === 'render').map((c) => c.owner).sort((a, b) => a.kind.localeCompare(b.kind)), [{ kind: 'agent', c: 2 }, { kind: 'user' }]);

  // render 认领一个任务 → rendering
  const w = await ask(render, { type: 'node.hello', nodeId: 'n-au10', profile: 'pc' }, 'node.welcome');
  assert.equal(w.type, 'node.welcome', JSON.stringify(w));
  await ask(page, { type: 'publisher.hello', publisherId: 'pub-au10' }, 'publisher.welcome');
  const task = snapshotTaskInput({ resultKey: `rk-au10-${Date.now()}` });
  const pub = await ask(page, { type: 'task.publish', tasks: [task] }, 'task.published');
  assert.equal(pub.type, 'task.published', JSON.stringify(pub));
  const claim = await ask(render, { type: 'task.claim', id: task.id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(claim.type, 'task.claimed', JSON.stringify(claim));
  row = await waitFor(async () => {
    const r = rowOf(await members(page), dev.deviceId);
    return r?.tags.rendering ? r : null;
  }, 3000, 'rendering tag');
  assert.deepEqual(row.tags, { editing: true, rendering: true, agents: 1 });
  void agent; void agentRender;
});

test('AU10 a browser-only node claims only tasks of its own userId: the same name on a different device does not count as the same person; a standalone host / local PC can claim tasks of any member', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const devA = newDevice();
  const devB = newDevice();
  const page = await join(env, proj, { username: 'zoe', device: devA, remote: R(120) });
  await ask(page, { type: 'publisher.hello', publisherId: 'pub-au10b' }, 'publisher.welcome');
  const tasks = [0, 1, 2].map((i) => snapshotTaskInput({ resultKey: `rk-au10b-${Date.now()}-${i}` }));
  await ask(page, { type: 'task.publish', tasks }, 'task.published');

  const other = await join(env, proj, { username: 'zoe', device: devB, role: 'render', remote: R(121) });
  await ask(other, { type: 'node.hello', nodeId: 'n-b', profile: 'browser' }, 'node.welcome');
  const r1 = await ask(other, { type: 'task.claim', id: tasks[0].id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.deepEqual([r1.type, r1.reason], ['task.claim-rejected', 'forbidden'], `same name, different device: ${JSON.stringify(r1)}`);

  const mine = await join(env, proj, { username: 'zoe', device: devA, role: 'render', remote: R(120) });
  await ask(mine, { type: 'node.hello', nodeId: 'n-a', profile: 'browser' }, 'node.welcome');
  const r2 = await ask(mine, { type: 'task.claim', id: tasks[0].id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(r2.type, 'task.claimed', `same userId: ${JSON.stringify(r2)}`);

  const hostNode = await join(env, proj, { username: 'rig', role: 'render', remote: R(122) });
  await ask(hostNode, { type: 'node.hello', nodeId: 'n-host', profile: 'host' }, 'node.welcome');
  const r3 = await ask(hostNode, { type: 'task.claim', id: tasks[1].id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(r3.type, 'task.claimed', `standalone host: ${JSON.stringify(r3)}`);
  const pc = await join(env, proj, { username: 'pat', role: 'render', remote: R(123) });
  await ask(pc, { type: 'node.hello', nodeId: 'n-pc', profile: 'pc' }, 'node.welcome');
  const r4 = await ask(pc, { type: 'task.claim', id: tasks[2].id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(r4.type, 'task.claimed', `local PC: ${JSON.stringify(r4)}`);
});

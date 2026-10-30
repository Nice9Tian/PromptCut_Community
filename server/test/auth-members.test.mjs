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
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}：${ms} ms 内没有关闭`)), ms); }),
  ]);
  clearTimeout(timer);
  return { code: e.code, reason: e.reason };
}

const rowOf = (devices, deviceId) => devices.find((d) => d.deviceId === deviceId);

// ------------------------------------------------------------------ AU4

test('AU4 两台设备自报同一用户名：userId 不同；两台都显示「用户名 (设备名)」；一台离开后另一台恢复成只显示用户名', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const devA = newDevice('Desk');
  const devB = newDevice('Phone');
  const devC = newDevice('Obs');
  const a = await join(env, proj, { username: 'sam', device: devA, remote: R(1) });
  const b = await join(env, proj, { username: 'sam', device: devB, remote: R(2) });
  const obs = await join(env, proj, { username: 'olga', device: devC, remote: R(3) });

  const ids = env.principals().filter((p) => p.username === 'sam').map((p) => p.userId).sort();
  assert.deepEqual(ids, [`sam@${devA.deviceId}`, `sam@${devB.deviceId}`].sort(), '两个 userId 不同，都是 用户名@deviceId');

  const list = await waitFor(async () => {
    const d = await members(obs);
    return rowOf(d, devA.deviceId) && rowOf(d, devB.deviceId) ? d : null;
  }, 3000, '成员列表里有两台 sam');
  const rowA = rowOf(list, devA.deviceId);
  const rowB = rowOf(list, devB.deviceId);
  assert.equal(rowA.displayName, `sam (${devA.deviceName})`);
  assert.equal(rowB.displayName, `sam (${devB.deviceName})`);
  assert.equal(rowA.username, 'sam');
  assert.equal(rowA.deviceName, devA.deviceName);
  assert.equal(rowA.creator, false);
  assert.equal(rowOf(list, devC.deviceId).displayName, 'olga', '不重名的只显示用户名');
  for (const row of list) {
    for (const k of ['deviceId', 'deviceName', 'username', 'displayName', 'creator', 'tags', 'conns']) assert.ok(k in row, `行里有 ${k}：${JSON.stringify(row)}`);
    for (const k of ['editing', 'rendering', 'agents']) assert.ok(k in row.tags, `tags 里有 ${k}`);
  }

  // 订阅变化：B 离开后观察者收到一条新的 shared.members.list
  await askOrNull(obs, { type: 'shared.watch' });
  const mark = obs.all.length;
  b.close();
  await waitFor(() => obs.all.slice(mark).some((m) => m.type === 'shared.members.list' && !rowOf(m.devices, devB.deviceId)), 3000, 'watch 推来 B 离开后的列表');
  const after = await members(obs);
  assert.equal(rowOf(after, devB.deviceId), undefined, 'B 已不在列表');
  assert.equal(rowOf(after, devA.deviceId).displayName, 'sam', '剩一台时只显示用户名');
  void a;
});

// ------------------------------------------------------------------ AU5

test('AU5 创建者操作 set-password（自由进入）：带证明生效；旧口令 401、新口令 101；在线连接不断', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(10) });
  const member = await join(env, proj, { username: 'zoe', remote: R(11) });
  const r = await adminOp(creator, proj, 'set-password', { project: credential('new-pw') });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: R(12) }), 401, '旧口令');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', password: 'new-pw', remote: R(13) }), 101, '新口令');
  await sleep(200);
  assert.equal(member.ws.readyState, 1, '在线连接不断');
  // set-password 只用于自由进入：限定进入的项目上回 error
  const rproj = await createProject(env, { mode: 'restricted' });
  const rc = await join(env, rproj, { username: 'alice', as: 'creator', remote: R(14) });
  const bad = await adminOp(rc, rproj, 'set-password', { project: credential('x') });
  assert.equal(bad.type, 'error', `限定进入上 set-password：${JSON.stringify(bad)}`);
});

test('AU5 创建者操作 set-list（限定进入）：整表替换；新名单的人能进；创建者不在 list 里也照样能进', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'restricted', list: [{ username: 'bob', password: 'bob-pw' }] });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(20) });
  const r = await adminOp(creator, proj, 'set-list', { list: [credential('dan-pw', 'dan')] });
  assert.equal(r.type, 'shared.admin.ok', JSON.stringify(r));
  proj.list = [{ username: 'dan', password: 'dan-pw' }];
  assert.equal(await joinStatus(env, proj, { username: 'dan', remote: R(21) }), 101);
  assert.equal(await joinStatus(env, proj, { username: 'bob', password: 'bob-pw', remote: R(22) }), 401, '被整表替换掉');
  assert.equal(await joinStatus(env, proj, { username: 'alice', as: 'member', password: proj.creator.password, remote: R(23) }), 101, '创建者始终在名单里');
  const fproj = await createProject(env, { mode: 'free' });
  const fc = await join(env, fproj, { username: 'alice', as: 'creator', remote: R(24) });
  const bad = await adminOp(fc, fproj, 'set-list', { list: [credential('x', 'x')] });
  assert.equal(bad.type, 'error', `自由进入上 set-list：${JSON.stringify(bad)}`);
});

test('AU5 创建者操作 kick 与 unban 带证明生效', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(30) });
  const dev = newDevice();
  const zoe = await join(env, proj, { username: 'zoe', device: dev, remote: R(31) });
  const k = await adminOp(creator, proj, 'kick', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal(k.type, 'shared.admin.ok', JSON.stringify(k));
  const closed = await closedWithin(zoe, 3000, '被踢者的连接');
  assert.deepEqual(closed, { code: 4003, reason: 'kicked' });
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, remote: R(32) }), 401, '禁入');
  const u = await adminOp(creator, proj, 'unban', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal(u.type, 'shared.admin.ok', JSON.stringify(u));
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, remote: R(33) }), 101, 'unban 后能进');
});

test('AU5 创建者操作 delete：全空间连接 4004 deleted；记录与空间数据删掉；名字释放', async (t) => {
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
  for (const [c, what] of [[creator, '创建者'], [m1, '成员页面'], [m2, '成员渲染']]) {
    assert.deepEqual(await closedWithin(c, 3000, what), { code: 4004, reason: 'deleted' }, what);
  }
  assert.equal(fs.existsSync(recordFile), false, '项目记录删掉');
  assert.equal(fs.existsSync(tenantDir), false, '该空间的全部数据删掉');
  const l = await env.http(`shared/lookup?name=${encodeURIComponent(proj.name)}`);
  assert.equal(l.status, 404);
  const again = await env.http('shared/create', {
    method: 'POST',
    body: { name: proj.name, mode: 'free', kdf: { alg: 'pbkdf2-sha256', iter: 100_000 }, creator: credential('c', 'alice'), project: credential('p') },
  });
  assert.equal(again.status, 201, `名字释放：${again.text}`);
  assert.notEqual(again.json.projectId, proj.projectId);
});

test('AU5 不带证明、证明错、非创建者 → forbidden，且不生效', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: 'alice', as: 'creator', remote: R(50) });
  const member = await join(env, proj, { username: 'zoe', remote: R(51) });
  const victim = newDevice();
  const v = await join(env, proj, { username: 'vic', device: victim, remote: R(52) });

  const noProof = await adminOp(creator, proj, 'kick', { username: 'vic', deviceId: victim.deviceId }, { noProof: true });
  assert.deepEqual([noProof.type, noProof.reason], ['error', 'forbidden'], `不带证明：${JSON.stringify(noProof)}`);
  const wrong = await adminOp(creator, proj, 'kick', { username: 'vic', deviceId: victim.deviceId }, { badProof: true });
  assert.deepEqual([wrong.type, wrong.reason], ['error', 'forbidden'], `证明错：${JSON.stringify(wrong)}`);
  const wrongPw = await adminOp(creator, proj, 'kick', { username: 'vic', deviceId: victim.deviceId }, { password: proj.password });
  assert.deepEqual([wrongPw.type, wrongPw.reason], ['error', 'forbidden'], `用项目口令算的证明：${JSON.stringify(wrongPw)}`);
  // 非创建者：成员连接按自己的口令算证明
  const byMember = await adminOp(member, proj, 'kick', { username: 'vic', deviceId: victim.deviceId }, { password: proj.password, username: 'zoe' });
  assert.deepEqual([byMember.type, byMember.reason], ['error', 'forbidden'], `非创建者：${JSON.stringify(byMember)}`);
  const byMemberNoProof = await adminOp(member, proj, 'delete', {}, { noProof: true });
  assert.deepEqual([byMemberNoProof.type, byMemberNoProof.reason], ['error', 'forbidden'], `非创建者不带证明：${JSON.stringify(byMemberNoProof)}`);
  // 别的连接的 nonce 不认：成员取的挑战给创建者用
  const ch = await ask(member, { type: 'shared.challenge' }, 'shared.challenge.ok');
  if (ch.type === 'shared.challenge.ok') {
    const { adminMac, derive } = await import('./auth-kit.mjs');
    const cch = await ask(creator, { type: 'shared.challenge' }, 'shared.challenge.ok');
    const key = derive(proj.creator.password, cch.salt);
    const m = adminMac(key, { projectId: proj.projectId, username: 'alice', op: 'kick', nonce: ch.nonce });
    const r = await ask(creator, { type: 'shared.admin', op: 'kick', username: 'vic', deviceId: victim.deviceId, proof: { nonce: ch.nonce, m } }, 'shared.admin.ok');
    assert.deepEqual([r.type, r.reason], ['error', 'forbidden'], `nonce 须由同一连接取：${JSON.stringify(r)}`);
  }
  await sleep(200);
  assert.equal(v.ws.readyState, 1, '被拒的 kick 没生效');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: R(53) }), 101, '被拒的操作没改任何东西');
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

test('AU5 除创建者操作外，创建者与成员对全部数据面消息的结果一致（逐条列出）', async (t) => {
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
  assert.deepEqual(diff, [], `创建者与成员不一致：${JSON.stringify(diff)}\n全部：${JSON.stringify(rows)}`);
  // 顺带核对几条确定的结果
  const byType = Object.fromEntries(rows.map((r) => [r.type, r.creator]));
  assert.equal(byType['node.hello'], 'error:forbidden', 'page 连接发 node.hello');
  assert.equal(byType['service.announce'], 'error:forbidden', '成员发 service.announce');
  assert.equal(byType['content.put'], 'content.stored');
});

// ------------------------------------------------------------------ AU6

test('AU6 set-list 移出某人：他的全部连接 5 s 内以 4003 removed 关闭，再握手 401；留在名单里的人不受影响', async (t) => {
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
  for (const [c, what] of [[bobPage, 'bob 页面'], [bobRender, 'bob 渲染'], [bobOther, 'bob 另一台设备的 agent']]) {
    assert.deepEqual(await closedWithin(c, 5000, what), { code: 4003, reason: 'removed' }, what);
  }
  assert.ok(Date.now() - t0 <= 5000);
  assert.equal(await joinStatus(env, proj, { username: 'bob', password: 'bob-pw', remote: R(74) }), 401, '再握手 401');
  await sleep(200);
  assert.equal(cara.ws.readyState, 1, '名单里的人不受影响');
  assert.equal(creator.ws.readyState, 1);
});

test('AU6 kick：连接关闭、票据立即 401、再进入 401；同名换设备、同设备换名不受禁入表影响；unban 后能进', async (t) => {
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
  assert.equal((await env.asset(`media/${hash}`, { remote: R(81), headers: bearer(tk) })).status, 200, '踢之前票据可用');

  const k = await adminOp(creator, proj, 'kick', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal(k.type, 'shared.admin.ok', JSON.stringify(k));
  for (const [c, what] of [[zoe, '页面'], [zoeRender, '渲染']]) {
    assert.deepEqual(await closedWithin(c, 3000, what), { code: 4003, reason: 'kicked' }, what);
  }
  const after = await env.asset(`media/${hash}`, { remote: R(81), headers: bearer(tk) });
  assert.equal(after.status, 401, '素材票据立即 401');
  assert.deepEqual(after.json, { ok: false, error: 'unauthorized' });
  assert.equal((await env.handshake([PROTOCOL, `promptcut.ticket.${conn}`], R(81))).status, 401, '连接票据立即 401');
  assert.equal((await env.asset(`media/${hash}`, { remote: R(82), headers: bearer(otk) })).status, 200, '别人的票据不受影响');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, remote: R(83) }), 401, '同名同设备再进入 401');
  assert.equal(await joinStatus(env, proj, { username: 'zoe', remote: R(84) }), 101, '同名另一台设备不在禁入表');
  assert.equal(await joinStatus(env, proj, { username: 'zed', device: dev, remote: R(85) }), 101, '同设备换用户名不在禁入表');

  const u = await adminOp(creator, proj, 'unban', { username: 'zoe', deviceId: dev.deviceId });
  assert.equal(u.type, 'shared.admin.ok', JSON.stringify(u));
  assert.equal(await joinStatus(env, proj, { username: 'zoe', device: dev, remote: R(86) }), 101, 'unban 后能进');
  // 踢过之后发的新票据可用（代数已前进，新票据带新代数）
  const z2 = await join(env, proj, { username: 'zoe', device: dev, remote: R(87) });
  const tk2 = (await ticketOf(z2, { kind: 'asset', access: 'r' })).ticket;
  assert.equal((await env.asset(`media/${hash}`, { remote: R(87), headers: bearer(tk2) })).status, 200);
  void uniqueName;
});

// ------------------------------------------------------------------ AU10

test('AU10 角色：page 与 agent 连接发 node.hello 回 forbidden；render 与本机 local 可以', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const hello = (nodeId) => ({ type: 'node.hello', nodeId, profile: 'pc' });
  const page = await join(env, proj, { username: 'zoe', remote: R(90) });
  const r1 = await ask(page, hello('n-page'), 'node.welcome');
  assert.deepEqual([r1.type, r1.reason], ['error', 'forbidden'], `page：${JSON.stringify(r1)}`);
  const agent = await join(env, proj, { username: 'zoe', role: 'agent', c: 1, remote: R(90) });
  const r2 = await ask(agent, hello('n-agent'), 'node.welcome');
  assert.deepEqual([r2.type, r2.reason], ['error', 'forbidden'], `agent：${JSON.stringify(r2)}`);
  const render = await join(env, proj, { username: 'zoe', role: 'render', remote: R(90) });
  const r3 = await ask(render, hello('n-render'), 'node.welcome');
  assert.equal(r3.type, 'node.welcome', `render：${JSON.stringify(r3)}`);
  const local = await env.open([PROTOCOL]);
  const r4 = await ask(local, hello('n-local'), 'node.welcome');
  assert.equal(r4.type, 'node.welcome', `local：${JSON.stringify(r4)}`);
});

test('AU10 写入身份：agent 连接写入的 actor 带对话号；page 写入的 actor 角色为 page', async (t) => {
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
  assert.ok(ch2.actor.conversation === null || ch2.actor.conversation === undefined, `page 写入没有对话号：${JSON.stringify(ch2.actor)}`);
  // 项目版本日志同样记 actor
  await ask(watcher, { type: 'project.open', projectId: 'p1' }, 'project.state');
  await ask(agent, { type: 'project.announce', projectId: 'p1', digest: 'abcdef0123456789' }, 'project.announced');
  const rev = await watcher.next(byType('project.rev'));
  assert.equal(rev.actor.role, 'agent');
  assert.equal(rev.actor.conversation, 7);
  assert.equal(rev.actor.userId, `zoe@${dev.deviceId}`);
});

test('AU10 一台设备 page + render 两条连接在成员列表里是一行，标签正确；render 持有认领后 rendering 为真；agent 计数', async (t) => {
  const env = await hostFor(t);
  const proj = await createProject(env, { mode: 'free' });
  const dev = newDevice('Desk');
  const page = await join(env, proj, { username: 'zoe', device: dev, remote: R(110) });
  const render = await join(env, proj, { username: 'zoe', device: dev, role: 'render', o: { kind: 'user' }, remote: R(110) });
  let row = await waitFor(async () => {
    const r = rowOf(await members(page), dev.deviceId);
    return r && r.conns.length === 2 ? r : null;
  }, 3000, '一行两条连接');
  assert.equal((await members(page)).filter((d) => d.deviceId === dev.deviceId).length, 1, '按设备聚合成一行');
  assert.deepEqual(row.tags, { editing: true, rendering: false, agents: 0 });
  assert.deepEqual(row.conns.map((c) => c.role).sort(), ['page', 'render']);
  assert.deepEqual(row.conns.find((c) => c.role === 'render').owner, { kind: 'user' });

  const agent = await join(env, proj, { username: 'zoe', device: dev, role: 'agent', c: 2, remote: R(110) });
  const agentRender = await join(env, proj, { username: 'zoe', device: dev, role: 'render', o: { kind: 'agent', c: 2 }, remote: R(110) });
  row = await waitFor(async () => {
    const r = rowOf(await members(page), dev.deviceId);
    return r && r.conns.length === 4 ? r : null;
  }, 3000, '一行四条连接');
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
  }, 3000, 'rendering 标签');
  assert.deepEqual(row.tags, { editing: true, rendering: true, agents: 1 });
  void agent; void agentRender;
});

test('AU10 纯浏览器节点只认领自己 userId 的任务：同名不同设备不算本人；独立主机 / 本机 PC 能认领任何成员的任务', async (t) => {
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
  assert.deepEqual([r1.type, r1.reason], ['task.claim-rejected', 'forbidden'], `同名不同设备：${JSON.stringify(r1)}`);

  const mine = await join(env, proj, { username: 'zoe', device: devA, role: 'render', remote: R(120) });
  await ask(mine, { type: 'node.hello', nodeId: 'n-a', profile: 'browser' }, 'node.welcome');
  const r2 = await ask(mine, { type: 'task.claim', id: tasks[0].id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(r2.type, 'task.claimed', `同一 userId：${JSON.stringify(r2)}`);

  const hostNode = await join(env, proj, { username: 'rig', role: 'render', remote: R(122) });
  await ask(hostNode, { type: 'node.hello', nodeId: 'n-host', profile: 'host' }, 'node.welcome');
  const r3 = await ask(hostNode, { type: 'task.claim', id: tasks[1].id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(r3.type, 'task.claimed', `独立主机：${JSON.stringify(r3)}`);
  const pc = await join(env, proj, { username: 'pat', role: 'render', remote: R(123) });
  await ask(pc, { type: 'node.hello', nodeId: 'n-pc', profile: 'pc' }, 'node.welcome');
  const r4 = await ask(pc, { type: 'task.claim', id: tasks[2].id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(r4.type, 'task.claimed', `本机 PC：${JSON.stringify(r4)}`);
});

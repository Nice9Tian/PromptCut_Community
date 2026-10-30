/**
 * C6.5 Agent 一侧(`docs/plan/c65-design.md` 第 5、7 节;`cloud-task.md` D1、D2、D4)。用例 AG-1～AG-10。
 *
 * - 握手:本机 local 空间的 agent 连接(`promptcut.role.agent.<n>`);
 * - 副本:按 rev 排队、去重、缺口重开;
 * - 端到端(V3):真实的 src/mcp/handlers(vite ssrLoadModule)+ Agent 服务端副本 + 真的文档服务(WebSocket):
 *   Agent 读后、页面改了同一实体,Agent 的写回 stale,since 与实际改动一致;重读后再写成功;
 * - 事件:每个工具调用都有创建 / 完成;成功的写带 opId、rev、inverse,并补写 event-detail;
 * - 页面侧工具的写入归属、两个对话的写入身份、handler 抛错不提交、有真身时预渲染发布方以真身的 rev 发布。
 *
 * 跑法:node --test server/test/agent-c65.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createHandshakeAuth, LOCAL_PRINCIPAL } from '../auth/handshake.mjs';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { applyOps } from '../docservice/json-ops.mjs';
import { createAgentLink, AgentReplica } from '../agent/doc-link.mjs';
import { createAgentExecutor, StaleWriteError, staleMessage } from '../agent/agent-exec.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { wsClient, byType, waitFor, sleep } from './fake-ws-kit.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const toolDef = (name) => tools.find((t) => t.name === name);

/* ------------------------------------------------------------------ 握手 */

function handshake({ loopback }) {
  const logs = [];
  const auth = createHandshakeAuth({
    store: null,
    challenges: { check: () => 'missing', issue: () => 'x' },
    limiter: { blocked: () => false, fail: () => {} },
    isLoopback: () => loopback,
    log: (event, fields) => logs.push(fields.reason),
  });
  const req = (...protocols) => ({ headers: { 'sec-websocket-protocol': protocols.join(', ') }, socket: { remoteAddress: loopback ? '127.0.0.1' : '192.168.1.9' } });
  return { auth, req, logs };
}

test('AG-1 握手:回环只带 promptcut.role.agent.<n> 是本机 local 空间的 agent 连接;别的组合照旧拒', () => {
  const loop = handshake({ loopback: true });
  assert.deepEqual(loop.auth.authenticate(loop.req('promptcut.v1', 'promptcut.role.agent.7')), { ...LOCAL_PRINCIPAL, role: 'agent', conversation: 7 });
  assert.equal(loop.auth.authenticate(loop.req('promptcut.v1', 'promptcut.role.agent')), null, '没带对话号');
  assert.equal(loop.auth.authenticate(loop.req('promptcut.v1', 'promptcut.role.agent.0')), null, '对话号从 1 起');
  assert.equal(loop.auth.authenticate(loop.req('promptcut.v1', 'promptcut.role.page')), null, '只认 agent 角色项');
  assert.equal(loop.auth.authenticate(loop.req('promptcut.role.agent.2')), null, '缺 promptcut.v1');
  assert.equal(loop.auth.authenticate(loop.req('promptcut.v1', 'promptcut.role.agent.2', 'promptcut.role.agent.3')), null, '两个角色项');
  assert.deepEqual(loop.auth.authenticate(loop.req()), LOCAL_PRINCIPAL, '回环什么都不带仍是页面');
  const lan = handshake({ loopback: false });
  assert.equal(lan.auth.authenticate(lan.req('promptcut.v1', 'promptcut.role.agent.2')), null, '非回环不认');
  assert.deepEqual(loop.logs, ['bad-format', 'bad-format', 'bad-format', 'bad-format', 'multiple']);
  assert.deepEqual(lan.logs, ['bad-format']);
});

/* ------------------------------------------------------------------ 副本 */

test('AG-2 副本:乱序到达按 rev 排队、重复的丢掉、缺口超时重新打开、应用失败也重新打开', async () => {
  const resyncs = [];
  const r = new AgentReplica({ gapTimeoutMs: 40, historyKeep: 10, onResync: (why) => resyncs.push(why), log: () => {} });
  r.offer(3, [{ op: 'set', path: '/a', value: 3 }]);
  r.setState(1, { a: 1 });
  assert.equal(r.rev, 1);
  r.offer(2, [{ op: 'set', path: '/a', value: 2 }], { opId: 'o2' });
  assert.deepEqual([r.rev, r.project], [3, { a: 3 }], '2 到了,缓存的 3 接着应用');
  r.offer(2, [{ op: 'set', path: '/a', value: 99 }]);
  assert.equal(r.project.a, 3, '重复的版本丢掉');
  assert.equal(r.revOfOpId('o2'), 2);
  assert.deepEqual(r.between(1, 3)?.map((h) => h.rev), [2, 3]);
  r.offer(5, [{ op: 'set', path: '/a', value: 5 }]);
  await sleep(80);
  assert.equal(resyncs.length, 1, '缺了 4,超时后重新打开');
  r.setState(5, { a: 5 });
  assert.deepEqual([r.rev, r.resyncing], [5, false]);
  r.offer(6, [{ op: 'remove', path: '/x/@nope' }]);
  assert.equal(resyncs.length, 2, '在副本上落不下去就重新打开');
  const waited = r.waitRev(7, 30);
  r.setState(7, { a: 7 });
  assert.equal(await waited, true);
  r.dispose();
});

/* ------------------------------------------------------------------ 端到端的环境 */

async function startEnv(t) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/docservice`;
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const links = [];
  const clients = [];
  t.after(async () => {
    for (const l of links) l.close();
    for (const c of clients) c.close();
    await vite.close();
    await built.service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const load = (id) => vite.ssrLoadModule(id);
  const { createEmptyProject } = await load('/src/kernel/project.ts');

  /** 一个页面(回环、什么都不带 = 本机页面身份),打开项目收广播 */
  async function page(projectId, session = 'page-1') {
    const c = wsClient(url);
    clients.push(c);
    await c.opened;
    let seq = 0;
    return {
      c,
      async open() {
        c.send({ type: 'project.open', projectId, reqId: `open-${++seq}` });
        return c.next((m) => m.type === 'project.state');
      },
      async commit(ops, extra = {}) {
        const opId = `${session}-op-${++seq}`;
        c.send({ type: 'project.op', projectId, opId, session, ops, reqId: opId, ...extra });
        const reply = await c.next((m) => m.reqId === opId);
        return { opId, reply };
      },
      async ask(msg) {
        const reqId = `ask-${++seq}`;
        c.send({ ...msg, reqId });
        return c.next((m) => m.reqId === reqId);
      },
    };
  }

  function agent(projectId, { prerenderPost = null } = {}) {
    const link = createAgentLink({ url, projectId, protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`] });
    links.push(link);
    const executor = createAgentExecutor({ link, loadHost: () => loadSsrHost(load), prerenderPost, toolGroups });
    const call = (tool, args, key = 'conv-A') => executor.track(tool, args, key, (ctx) => executor.execute(tool, args, key, toolDef(tool), ctx));
    return { link, executor, call };
  }

  /** 项目:一条视频片段 c1 在 t1 上 */
  function project(projectId) {
    const p = createEmptyProject('agent-test');
    p.id = projectId;
    p.media = [{ id: 'v', kind: 'video', name: 'v.mp4', url: '/media/v.mp4', duration: 20 }];
    p.tracks = [
      { id: 't1', name: '画面', clips: [{ id: 'c1', cardId: '', params: {}, mediaId: 'v', start: 0, end: 5 }] },
      { id: 't2', name: '空', clips: [] },
    ];
    return p;
  }

  async function seeded(projectId) {
    const pg = await page(projectId);
    await pg.open();
    const { reply } = await pg.commit([{ op: 'set', path: '', value: project(projectId) }]);
    assert.equal(reply.type, 'project.op.ok', JSON.stringify(reply));
    return pg;
  }

  return { url, load, page, agent, seeded, project };
}

/** docservice 里这个项目此刻的真身 */
async function bodyOf(env, projectId) {
  const probe = await env.page(projectId, 'probe');
  const st = await probe.open();
  probe.c.close();
  return st;
}

/* ------------------------------------------------------------------ V3 端到端 */

test('AG-3(V3 端到端)Agent 读后页面改了同一片段:Agent 的写回 stale,since 与实际改动一致,文档服务不变;重读后再写成功', async (t) => {
  const env = await startEnv(t);
  const pg = await env.seeded('proj-v3');
  const observer = await env.page('proj-v3', 'observer');
  await observer.open();
  const ag = env.agent('proj-v3');

  const read = await ag.call('get_clip', { clipId: 'c1' });
  assert.equal(read.rev, 1, '读工具回包带 rev');
  assert.equal(ag.executor.lastRead('conv-A'), 1);

  const { opId: pageOp, reply: pageOk } = await pg.commit([{ op: 'set', path: '/tracks/@t1/clips/@c1/label', value: '页面改的' }]);
  assert.deepEqual([pageOk.type, pageOk.rev], ['project.op.ok', 2]);
  await ag.link.replica.waitRev(2, 2000);

  await assert.rejects(ag.call('update_clip', { clipId: 'c1', opacity: 0.5 }), (err) => {
    assert.ok(err instanceof StaleWriteError, String(err));
    assert.equal(err.stale.expectRev, 1);
    assert.equal(err.stale.currentRev, 2);
    assert.equal(err.stale.since.length, 1);
    const s = err.stale.since[0];
    assert.equal(s.rev, 2);
    assert.equal(s.opId, pageOp);
    assert.equal(s.actor.role, 'page');
    assert.equal(s.actor.session, 'page-1');
    assert.deepEqual(s.entities, ['/tracks/@t1/clips/@c1']);
    assert.match(err.message, /rev 1.*rev 2/s);
    assert.match(err.message, /rev 2:页面改了 \/tracks\/@t1\/clips\/@c1/);
    return true;
  });
  const afterStale = await bodyOf(env, 'proj-v3');
  assert.equal(afterStale.rev, 2, '被拒的写不落地');
  assert.equal(afterStale.project.tracks[0].clips[0].opacity, undefined);

  const reread = await ag.call('get_clip', { clipId: 'c1' });
  assert.equal(reread.rev, 2);
  const wrote = await ag.call('update_clip', { clipId: 'c1', opacity: 0.5 });
  assert.equal(wrote.ok, true);
  assert.equal(wrote.rev, 3);
  const final = await bodyOf(env, 'proj-v3');
  assert.equal(final.rev, 3);
  assert.equal(final.project.tracks[0].clips[0].opacity, 0.5);
  assert.equal(final.project.tracks[0].clips[0].label, '页面改的', '页面的改动保留');
  assert.deepEqual(ag.link.replica.project, final.project, '副本与真身逐项相同');
  assert.equal(JSON.stringify(ag.link.replica.project), JSON.stringify(final.project), '连键的顺序都相同');

  // 页面收到的广播:写入身份是 agent + 对话号
  const ops = await observer.c.next((m) => m.type === 'project.ops' && m.rev === 3);
  assert.deepEqual({ role: ops.actor.role, conversation: ops.actor.conversation, session: ops.actor.session },
    { role: 'agent', conversation: 1, session: 'agent:conv-A' });
});

test('AG-4 写成功后这个对话读到的版本跟着前进:连着写不会被自己挡住;handler 抛错时整次改动作废', async (t) => {
  const env = await startEnv(t);
  await env.seeded('proj-seq');
  const ag = env.agent('proj-seq');
  await ag.call('get_project', {});
  const a = await ag.call('add_track', { name: '新序列' });
  const b = await ag.call('update_clip', { clipId: 'c1', opacity: 0.3 });
  const c = await ag.call('set_clip_volume', { clipId: 'c1', volume: 0.5 });
  assert.deepEqual([a.rev, b.rev, c.rev], [2, 3, 4]);
  // update_clip 的 trackId 不存在:handler 先改了参数才抛错 —— 服务端整次作废,不提交
  await assert.rejects(ag.call('update_clip', { clipId: 'c1', label: '半截', trackId: 'nope' }), /找不到序列 nope/);
  const st = await bodyOf(env, 'proj-seq');
  assert.equal(st.rev, 4);
  assert.equal(st.project.tracks[0].clips[0].label, undefined, '抛错的那次什么都没写');
  assert.equal(ag.executor.describe().stats.committed, 3);
});

test('AG-5 事件:每个工具调用都有创建 / 完成;只有成功的写带 opId、rev、inverse,完成时补写 event-detail;逆操作能把那一步撤回去', async (t) => {
  const env = await startEnv(t);
  const pg = await env.seeded('proj-ev');
  const observer = await env.page('proj-ev', 'observer');
  await observer.open();
  const ag = env.agent('proj-ev');

  await ag.call('get_clip', { clipId: 'c1' });
  await pg.commit([{ op: 'set', path: '/name', value: '页面改名' }]);
  await ag.link.replica.waitRev(2, 2000);
  await assert.rejects(ag.call('set_clip_volume', { clipId: 'c1', volume: 0.2 }), StaleWriteError);
  await ag.call('get_project', {});
  const before = (await bodyOf(env, 'proj-ev')).project;
  const wrote = await ag.call('set_clip_volume', { clipId: 'c1', volume: 0.2 });
  assert.equal(wrote.rev, 3);

  await waitFor(() => observer.c.all.filter((m) => m.type === 'events.event' && m.phase === 'complete').length >= 4, 3000, '四条完成事件');
  const evs = observer.c.all.filter((m) => m.type === 'events.event');
  const byId = new Map();
  for (const e of evs) byId.set(e.eventId, [...(byId.get(e.eventId) ?? []), e]);
  const calls = [...byId.values()];
  assert.equal(calls.length, 4);
  for (const pair of calls) assert.deepEqual(pair.map((e) => e.phase), ['create', 'complete'], '每个调用先创建后完成');
  const [readEv, staleEv, reread, writeEv] = calls;
  assert.deepEqual([readEv[0].tool, staleEv[0].tool, reread[0].tool, writeEv[0].tool], ['get_clip', 'set_clip_volume', 'get_project', 'set_clip_volume']);
  assert.equal(readEv[0].icon, 'clips');
  assert.equal(readEv[0].target, 'clipId:c1');
  assert.equal(readEv[0].actor.role, 'agent');
  assert.equal(readEv[0].actor.conversation, 1);
  for (const [, done] of [readEv, staleEv, reread]) assert.equal(done.opId, undefined, '读与被拒的写不带 opId');
  assert.equal(staleEv[1].status, 'error');
  assert.match(staleEv[1].summary, /rev 1.*rev 2/s);
  const done = writeEv[1];
  assert.equal(done.status, 'ok');
  assert.equal(done.rev, 3);
  assert.equal(typeof done.opId, 'string');
  assert.ok(Array.isArray(done.inverse) && done.inverse.length > 0);
  // 逆操作把那一步撤回去
  const now = (await bodyOf(env, 'proj-ev')).project;
  assert.deepEqual(applyOps(now, done.inverse).root, before);
  // event-detail 在完成时补写:参数、摘要、写入信息
  const detail = await observer.ask({ type: 'content.get', kind: 'event-detail', key: done.detailKey });
  assert.equal(detail.body.tool, 'set_clip_volume');
  assert.deepEqual(detail.body.args, { clipId: 'c1', volume: 0.2 });
  assert.equal(detail.body.opId, done.opId);
  assert.deepEqual(detail.body.inverse, done.inverse);
  assert.equal(typeof detail.body.summary, 'string');

  // 文字回复整条一条
  ag.executor.text('conv-A', '改好了。');
  const txt = await observer.c.next((m) => m.type === 'events.event' && m.phase === 'text');
  assert.equal(txt.text, '改好了。');
});

test('AG-6 两个对话各用各的连接:写入身份的对话号不同;两路广播与 ok 交错时副本仍与真身相同', async (t) => {
  const env = await startEnv(t);
  await env.seeded('proj-two');
  const observer = await env.page('proj-two', 'observer');
  await observer.open();
  const ag = env.agent('proj-two');
  await ag.call('get_project', {}, 'A');
  await ag.call('get_project', {}, 'B');
  for (let i = 0; i < 6; i++) {
    const who = i % 2 ? 'B' : 'A';
    await ag.call('get_project', {}, who);
    await ag.call('add_track', { name: `${who}-${i}` }, who);
  }
  const st = await bodyOf(env, 'proj-two');
  assert.equal(st.rev, 7);
  await ag.link.replica.waitRev(7, 2000);
  assert.equal(JSON.stringify(ag.link.replica.project), JSON.stringify(st.project));
  const actors = observer.c.all.filter((m) => m.type === 'project.ops' && m.rev > 1).map((m) => [m.actor.conversation, m.actor.session]);
  assert.deepEqual(actors, [[1, 'agent:A'], [2, 'agent:B'], [1, 'agent:A'], [2, 'agent:B'], [1, 'agent:A'], [2, 'agent:B']]);
});

test('AG-7 留在页面的工具写了项目:页面报回的 opIds 进了副本、且期间只有它们,就把对话读到的版本推过去;夹了别人的写入就不推', async (t) => {
  const env = await startEnv(t);
  const pg = await env.seeded('proj-page');
  const other = await env.page('proj-page', 'page-2');
  await other.open();
  const ag = env.agent('proj-page');
  await ag.call('get_project', {});
  // 页面替这个对话执行了一个留在页面的写工具(例:set_project_meta),回包带它的 opId
  const { opId: mine } = await pg.commit([{ op: 'set', path: '/duration', value: 12 }]);
  await ag.executor.notePageWrites('conv-A', [mine]);
  assert.equal(ag.executor.lastRead('conv-A'), 2);
  assert.equal((await ag.call('add_track', { name: 'x' })).rev, 3, '没被自己让页面做的改动挡住');
  // 这回另一个页面先写了一次,才轮到替这个对话执行的那次:中间夹了别人的写入
  await other.commit([{ op: 'set', path: '/name', value: '别人' }]);
  const { opId: mine2 } = await pg.commit([{ op: 'set', path: '/duration', value: 13 }]);
  await ag.executor.notePageWrites('conv-A', [mine2]);
  assert.equal(ag.executor.lastRead('conv-A'), 3, '夹了别人的写入,不推');
  await assert.rejects(ag.call('add_track', { name: 'y' }), StaleWriteError);
});

test('AG-8 事件模块:完成事件透传 opId / rev / inverse,补写 event-detail;带 inverse 不带 opId 回 bad-message', async (t) => {
  const env = await startEnv(t);
  await env.seeded('proj-evm');
  const pageObs = await env.page('proj-evm', 'observer');
  await pageObs.open();
  const agentConn = wsClient(env.url, ['promptcut.v1', 'promptcut.role.agent.9']);
  await agentConn.opened;
  t.after(() => agentConn.close());
  const ask = async (msg) => {
    const reqId = `r-${Math.random()}`;
    agentConn.send({ ...msg, reqId });
    return agentConn.next((m) => m.reqId === reqId);
  };
  await ask({ type: 'events.create', projectId: 'proj-evm', eventId: 'e1', tool: 'add_clip', session: 'agent:x' });
  const ack = await ask({ type: 'events.complete', projectId: 'proj-evm', eventId: 'e1', status: 'ok', session: 'agent:x',
    opId: 'op-1', rev: 5, inverse: [{ op: 'remove', path: '/tracks/@t1/clips/@c9' }], detail: { summary: 's', opId: 'op-1' } });
  assert.equal(ack.detailKey, 'proj-evm/e1');
  const done = await pageObs.c.next((m) => m.type === 'events.event' && m.phase === 'complete');
  assert.deepEqual([done.opId, done.rev, done.inverse, done.detailKey, done.actor.conversation], ['op-1', 5, [{ op: 'remove', path: '/tracks/@t1/clips/@c9' }], 'proj-evm/e1', 9]);
  const listing = await ask({ type: 'events.list', projectId: 'proj-evm' });
  assert.equal(listing.items[0].opId, 'op-1');
  const bad = await ask({ type: 'events.complete', projectId: 'proj-evm', eventId: 'e2', status: 'ok', inverse: [] });
  assert.deepEqual([bad.type, bad.reason], ['error', 'bad-message']);
});

test('AG-9 stale 的报错文字:谁、改了哪些实体,多了折叠', () => {
  const since = Array.from({ length: 10 }, (_, i) => ({ rev: 11 + i, actor: i % 2 ? { role: 'agent', conversation: 2, session: 'agent:B' } : { role: 'page', userId: 'local', session: 'p' },
    entities: i === 9 ? ['/a', '/b', '/c', '/d', '/e', '/f', '/g'] : ['/tracks/@t1'] }));
  const text = staleMessage({ expectRev: 10, currentRev: 20, since, sinceComplete: true });
  assert.match(text, /你读到的是 rev 10,现在是 rev 20/);
  assert.match(text, /rev 20:Agent 对话 2\(agent:B\)改了 \/a、\/b、\/c、\/d、\/e、\/f 等 7 处/);
  assert.match(text, /rev 13:页面改了 \/tracks\/@t1/);
  assert.match(text, /更早的还有 2 次没列出/);
  assert.doesNotMatch(text, /rev 12:/);
});

test('AG-10 工具表:每个工具都标了 side(agent / page / server),事件的分组覆盖全部工具', () => {
  const sides = new Set(tools.map((t) => t.side));
  assert.deepEqual([...sides].sort(), ['agent', 'page', 'server']);
  assert.equal(Object.keys(toolGroups).length, tools.length);
  // 只读页面独有状态的留在页面;写项目的纯项目工具在 Agent 服务端
  for (const n of ['get_selection', 'user_interface_seek', 'user_interface_play', 'user_interface_pause', 'user_interface_web_handoff', 'list_cards']) assert.equal(toolDef(n).side, 'page', n);
  for (const n of ['add_clip', 'update_clip', 'set_position', 'get_layout', 'get_project', 'see_frames', 'apply_card', 'fill_captions']) assert.equal(toolDef(n).side, 'agent', n);
});

test('AG-11 预渲染发布方定版本:没有真身照老流程发号、传快照;有真身不发号、不上传,以真身的 rev 发布,节点取回的是真身;与真身不同就不交给队列', async (t) => {
  const { resolvePublishVersion } = await import('../queue-publish.mjs');
  const { createWsEndpoint, createProjectClient } = await import('../render-node/index.mjs');
  const env = await startEnv(t);
  const endpoint = createWsEndpoint({ url: env.url, log: () => {} });
  t.after(() => endpoint.close());
  await waitFor(() => endpoint.connected === true, 3000, '端点连上');
  const projects = createProjectClient(endpoint);
  const puts = [];
  const spy = { announce: (...a) => projects.announce(...a), putSnapshot: (...a) => { puts.push(a[1]); return projects.putSnapshot(...a); } };

  // 没有真身:老流程
  const raw0 = env.project('proj-pub');
  const rendered0 = JSON.stringify({ ...raw0, rendered: true });
  const v0 = await resolvePublishVersion({ projects: spy, projectId: 'proj-pub', text: rendered0, rawText: JSON.stringify(raw0) });
  assert.deepEqual([v0.via, v0.projectRev, puts], ['announce', 1, [1]]);
  assert.deepEqual(await projects.get('proj-pub', 1), JSON.parse(rendered0));

  // 有真身:页面把项目写进文档服务(根替换),之后又改了一次
  const pg = await env.page('proj-pub');
  await pg.open();
  await pg.commit([{ op: 'set', path: '', value: raw0 }]);
  const { reply } = await pg.commit([{ op: 'set', path: '/name', value: '改过' }]);
  const body = (await bodyOf(env, 'proj-pub')).project;
  const v1 = await resolvePublishVersion({ projects: spy, projectId: 'proj-pub', text: JSON.stringify({ ...body, rendered: true }), rawText: JSON.stringify(body) });
  assert.deepEqual([v1.via, v1.projectRev], ['body', reply.rev]);
  assert.deepEqual(puts, [1], '有真身时不上传快照');
  assert.deepEqual(await projects.get('proj-pub', v1.projectRev), body, '节点取回的是真身');
  assert.equal((await bodyOf(env, 'proj-pub')).rev, reply.rev, '询问不发号');

  // 页面推来的与真身不同(还有没确认的修改):不交给队列
  const v2 = await resolvePublishVersion({ projects: spy, projectId: 'proj-pub', text: '{}', rawText: JSON.stringify({ ...body, name: '本地没确认' }) });
  assert.deepEqual(v2, { skip: 'body-mismatch', projectRev: reply.rev });
});

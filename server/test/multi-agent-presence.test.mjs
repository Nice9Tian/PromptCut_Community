/**
 * 多 Agent 第二阶段:跨设备(经文档服务的在场状态)。计划 docs/plan/agent-workflow-plan.md A3 第 5 条。用例 MA-X1～MA-X5。
 *
 * - MA-X1 文档服务的在场状态模块:set / list / clear / send,只转给同一项目的别的订阅者,不回发给自己,断线撤掉,限大小;
 * - MA-X2～X4 两个成员共用一个真的文档服务(按查询串给身份:alice@devA、bob@devB):
 *     成员 B 的页面发布「正在编辑 c2」→ 成员 A 编辑器进程里的 Agent 读 c2,结果带「用户 bob 正在编辑」;
 *     A 的 Agent 声明范围 → B 的页面收到 presence.update、B 编辑器进程的公告板名单里有它;
 *     B 的 Agent 给 A 的 Agent 发消息 → 进 A 的信箱(标明是成员 bob 那边);
 * - MA-X5 旧版文档服务(没有在场状态模块)的退回:工具照常、不报错、不断线,桥记下「不支持」后不再发。
 *
 * 跑法:node --test server/test/multi-agent-presence.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createDocService } from '../docservice/service.mjs';
import { projectModule } from '../docservice/modules/project.mjs';
import { PRESENCE_LIMITS, presenceModule } from '../docservice/modules/presence.mjs';
import { createAgentSide } from '../agent/agent-side.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { createAgentSessions } from '../agent/agent-sessions.mjs';
import { createAgentBoards } from '../agent/agent-board.mjs';
import { attachLink, createMultiAgent } from '../agent/multi-agent.mjs';
import { createPresenceBridge, memberOf } from '../agent/presence-bridge.mjs';
import { createUserEditingBoard } from '../agent/user-editing.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 查询串给身份:?user=<userId>&role=<page|agent>&conv=<n>(测试里模拟共享项目的成员身份) */
function authByQuery(req) {
  const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const role = q.get('role') ?? 'page';
  return { userId: q.get('user') ?? 'u', tenantId: 't-ma', role, ...(role === 'agent' ? { conversation: Number(q.get('conv')) || 1 } : {}) };
}

async function startService(t, { withPresence = true } = {}) {
  const project = projectModule({});
  const modules = [project, ...(withPresence ? [presenceModule({ project })] : [])];
  const service = createDocService({ authenticate: authByQuery, modules, autoTick: false, log: () => {} });
  const { port } = await service.listen(0, '127.0.0.1');
  const clients = [];
  t.after(async () => { for (const c of clients) { try { c.close(); } catch { /* 已关 */ } } await service.close(); });
  const url = (user, role = 'page', conv) => `ws://127.0.0.1:${port}/?user=${encodeURIComponent(user)}&role=${role}${conv ? `&conv=${conv}` : ''}`;
  let seq = 0;
  async function client(user) {
    const c = wsClient(url(user));
    clients.push(c);
    await c.opened;
    const ask = async (msg) => {
      const reqId = `q${++seq}`;
      c.send({ ...msg, reqId });
      return c.next((m) => m.reqId === reqId, 3000);
    };
    return { c, ask };
  }
  return { url, client, clients };
}

/* ------------------------------------------------------------------ 模块 */

test('MA-X1 在场状态模块:只转给同一项目的别的订阅者、不回发给自己;list 取现有的;clear 与断线撤掉;send 只广播不记;限大小', async (t) => {
  const svc = await startService(t);
  const a = await svc.client('alice@devA');
  const b = await svc.client('bob@devB');
  const other = await svc.client('carol@devC');
  await a.ask({ type: 'project.open', projectId: 'p1' });
  await b.ask({ type: 'project.open', projectId: 'p1' });
  await other.ask({ type: 'project.open', projectId: 'p2' });
  const ok = await a.ask({ type: 'presence.set', projectId: 'p1', session: 'ue-a', key: 'editing', ttlMs: 60000, data: { v: 1, kind: 'editing', session: 'ue-a', entities: [{ clipId: 'c1', kind: 'drag' }] } });
  assert.equal(ok.type, 'presence.ok');
  const up = await b.c.next((m) => m.type === 'presence.update', 2000);
  assert.deepEqual({ key: up.key, user: up.from.userId, role: up.from.role, session: up.from.session, clip: up.data.entities[0].clipId }, { key: 'editing', user: 'alice@devA', role: 'page', session: 'ue-a', clip: 'c1' });
  assert.ok(up.expiresAt > Date.now() + 10_000);
  assert.equal(a.c.inbox.some((m) => m.type === 'presence.update'), false, '不回发给自己');
  assert.equal(other.c.inbox.some((m) => m.type === 'presence.update'), false, '别的项目收不到');
  const st = await b.ask({ type: 'presence.list', projectId: 'p1' });
  assert.equal(st.entries.length, 1);
  // send:只广播
  await b.ask({ type: 'presence.send', projectId: 'p1', data: { v: 1, kind: 'agent-message', to: 'x', text: 'hi' } });
  const msg = await a.c.next((m) => m.type === 'presence.message', 2000);
  assert.equal(msg.from.userId, 'bob@devB');
  assert.equal((await b.ask({ type: 'presence.list', projectId: 'p1' })).entries.length, 1, 'send 不记');
  // clear
  await a.ask({ type: 'presence.clear', projectId: 'p1', session: 'ue-a', key: 'editing' });
  const cl = await b.c.next((m) => m.type === 'presence.update', 2000);
  assert.equal(cl.data, null);
  // 断线撤掉
  await a.ask({ type: 'presence.set', projectId: 'p1', session: 'ue-a', key: 'editing', data: { kind: 'editing' } });
  await b.c.next((m) => m.type === 'presence.update' && m.data, 2000);
  a.c.close();
  const gone = await b.c.next((m) => m.type === 'presence.update', 3000);
  assert.equal(gone.data, null);
  assert.equal((await b.ask({ type: 'presence.list', projectId: 'p1' })).entries.length, 0);
  // 限大小、key 格式
  const big = await b.ask({ type: 'presence.set', projectId: 'p1', key: 'editing', data: { pad: 'x'.repeat(PRESENCE_LIMITS.DATA_BYTES) } });
  assert.deepEqual([big.type, big.reason], ['error', 'too-large']);
  const badKey = await b.ask({ type: 'presence.set', projectId: 'p1', key: 'a b', data: {} });
  assert.deepEqual([badKey.type, badKey.reason], ['error', 'bad-message']);
  assert.equal(memberOf({ userId: 'bob@devB' }), 'bob');
  assert.equal(memberOf({ userId: 'local' }), null);
});

/* ------------------------------------------------------------------ 两个成员 */

async function startVite(t) {
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => vite.close());
  const load = (id) => vite.ssrLoadModule(id);
  return { load, createEmptyProject: (await load('/src/kernel/project.ts')).createEmptyProject };
}

/** 一个成员的编辑器进程:与 vite-plugin-ai.ts 同样的拼装(公告板、A2 看板、multiAgent、在场状态的桥) */
function editorProcess(t, svc, load, { user, projectId }) {
  const sessions = createAgentSessions();
  let bridge = null;
  const boards = createAgentBoards(() => ({ labelOf: (k) => sessions.get(k).vendor, forwardRemote: (m) => bridge?.forward(m) ?? false }));
  const board = () => boards.boardFor(projectId);
  const editing = createUserEditingBoard();
  const ma = createMultiAgent({ sessions, board, openTab: async () => { throw new Error('这个测试里没有页面'); } });
  const side = createAgentSide({
    projectId,
    url: (n) => svc.url(user, 'agent', n),
    protocolsFor: () => ['promptcut.v1'],
    loadHost: () => loadSsrHost(load),
    tools,
    toolGroups,
    callPage: async () => { throw new Error('这个测试里没有页面'); },
    callServer: (tool, args, ctx) => ma.handle(tool, args, ctx?.agent ?? ''),
    userEditing: () => editing.current(),
    agentLabel: (k) => sessions.get(k).vendor,
  });
  const detach = attachLink(side.link, board);
  bridge = createPresenceBridge({ link: side.link, board, editing, conversationNumberOf: (k) => side.conversationNumber(k), labelOf: (k) => sessions.get(k).vendor });
  board().onDeclare = (k) => { void bridge.publishAgent(k); };
  t.after(() => { detach(); bridge.close(); side.close(); });
  const call = (tool, args, agent) => ma.wrap(agent, tool, () => side.callTool(tool, args, { agent }));
  return { sessions, board, editing, side, bridge, call };
}

async function seed(svc, createEmptyProject, projectId) {
  const pg = await svc.client('alice@devA');
  await pg.ask({ type: 'project.open', projectId });
  const p = createEmptyProject('ma-x');
  p.id = projectId;
  p.cuts = [{ id: 'cut-1', name: '剪辑1' }];
  p.activeCutId = 'cut-1';
  p.tracks = [
    { id: 't1', name: '序列1', clips: [{ id: 'c1', cardId: 'title', params: { text: '一' }, start: 0, end: 3 }] },
    { id: 't2', name: '序列2', clips: [{ id: 'c2', cardId: 'title', params: { text: '二' }, start: 3, end: 6 }] },
  ];
  const r = await pg.ask({ type: 'project.op', projectId, opId: 'seed-1', session: 'page-a', ops: [{ op: 'set', path: '', value: p }] });
  assert.equal(r.type, 'project.op.ok', JSON.stringify(r));
  return pg;
}

test('MA-X2～X4 两个成员共用一个文档服务:正在编辑、范围、消息都经在场状态转给另一个成员', async (t) => {
  const svc = await startService(t);
  const { load, createEmptyProject } = await startVite(t);
  const pid = 'proj-ma-x';
  await seed(svc, createEmptyProject, pid);
  const A = editorProcess(t, svc, load, { user: 'alice@devA', projectId: pid });
  A.sessions.register('conv-a', { type: 'cli', vendor: 'claude' });
  await A.bridge.start();

  await t.test('MA-X2 成员 B 的页面正在拖 c2:A 的 Agent 读 c2,结果带「用户 bob 正在编辑」;读 c1 不带;B 撤掉后不再带', async () => {
    const pageB = await svc.client('bob@devB');
    await pageB.ask({ type: 'project.open', projectId: pid });
    const set = await pageB.ask({ type: 'presence.set', projectId: pid, session: 'ue-b', key: 'editing', ttlMs: 60000, data: { v: 1, kind: 'editing', session: 'ue-b', entities: [{ clipId: 'c2', kind: 'drag' }] } });
    assert.equal(set.type, 'presence.ok');
    await waitFor(() => A.editing.current().length === 1, 20_000, 'A 的看板收到 B 的编辑状态');
    assert.deepEqual(A.editing.current().map((e) => [e.clipId, e.kind, e.who]), [['c2', 'drag', 'bob']]);
    const r = await A.call('get_clip', { clipId: 'c2' }, 'conv-a');
    assert.deepEqual(r.userEditing, [{ clipId: 'c2', kind: 'drag', who: 'bob' }]);
    assert.ok(r.notice.startsWith('用户 bob 正在编辑片段 c2(拖动中)。这是提示不是禁止'), r.notice);
    const r1 = await A.call('get_clip', { clipId: 'c1' }, 'conv-a');
    assert.equal(r1.userEditing, undefined);
    // A 本机的页面同时在编辑 c1:两句分开
    A.editing.report('ue-a-local', [{ clipId: 'c1', kind: 'text' }]);
    const whole = await A.call('get_project', {}, 'conv-a');
    assert.match(whole.notice, /^用户正在编辑片段 c1\(文字编辑中\);用户 bob 正在编辑片段 c2\(拖动中\)。/);
    A.editing.report('ue-a-local', []);
    // A 本机页面自己经文档服务发回来的那份(同一个会话号)不当别人
    assert.equal(A.editing.reportRemote('ue-a-local', [{ clipId: 'c1', kind: 'drag' }], { who: 'alice' }), 0);
    await pageB.ask({ type: 'presence.clear', projectId: pid, session: 'ue-b', key: 'editing' });
    await waitFor(() => A.editing.current().length === 0, 20_000, 'B 撤掉后 A 的看板清掉');
  });

  let B = null;
  await t.test('MA-X3 A 的 Agent 声明的范围:B 的页面收到 presence.update;B 编辑器进程的公告板名单里有它(带成员名)', async () => {
    const pageB = await svc.client('bob@devB');
    await pageB.ask({ type: 'project.open', projectId: pid });
    B = editorProcess(t, svc, load, { user: 'bob@devB', projectId: pid });
    B.sessions.register('conv-b', { type: 'cli', vendor: 'codex' });
    await B.bridge.start();
    const d = await A.call('declare_scope', { scope: '剪辑1->序列2', note: '配字幕' }, 'conv-a');
    assert.equal(d.ok, true);
    const up = await pageB.c.next((m) => m.type === 'presence.update' && m.key === 'agent:conv-a', 3000);
    assert.deepEqual({ scope: up.data.scope, vendor: up.data.vendor, user: up.from.userId, role: up.from.role }, { scope: '剪辑1->序列2', vendor: 'claude', user: 'alice@devA', role: 'agent' });
    await waitFor(() => B.board().listRaw('conv-b').some((x) => x.id === 'conv-a'), 20_000, 'B 的公告板收到 A 的 Agent');
    const la = await B.call('list_agents', {}, 'conv-b');
    const remote = la.agents.find((x) => x.id === 'conv-a');
    assert.deepEqual({ scope: remote.scope, member: remote.member, remote: remote.remote, vendor: remote.vendor }, { scope: '剪辑1->序列2', member: 'alice', remote: true, vendor: 'claude' });
    // A 自己那边不把自己的 Agent 当成远端的
    assert.equal(A.board().listRaw('').some((x) => x.remote), false);
    t.diagnostic(`A 的桥:${JSON.stringify(A.bridge.describe())}`);
  });

  await t.test('MA-X4 B 的 Agent 给 A 的 Agent 发消息:进 A 的信箱,标明是成员 bob 那边', async () => {
      const s = await B.call('send_message', { to: 'conv-a', text: '序列2 你来,我改序列1' }, 'conv-b');
      assert.equal(s.ok, true, JSON.stringify(s));
      assert.match(s.note, /经文档服务转过去/);
      await waitFor(() => A.board().checkMessages('conv-a').messages.length === 1, 20_000, 'A 的信箱收到');
      const m = A.board().checkMessages('conv-a').messages[0];
      assert.equal(m.text, '序列2 你来,我改序列1');
      assert.match(m.fromLabel, /^Agent conv-b\(codex,成员 bob 那边\)$/);
      // A 的 Agent 下一次工具结果里带上
      const r = await A.call('get_clip', { clipId: 'c1' }, 'conv-a');
      assert.match(r.notice, /【Agent conv-b\(codex,成员 bob 那边\)】序列2 你来,我改序列1/);
  });
});

test('MA-X5 旧版文档服务(没有在场状态模块):工具照常、不报错、不断线;桥记下「不支持」后不再发', async (t) => {
  const svc = await startService(t, { withPresence: false });
  const { load, createEmptyProject } = await startVite(t);
  const pid = 'proj-ma-old';
  await seed(svc, createEmptyProject, pid);
  const A = editorProcess(t, svc, load, { user: 'alice@devA', projectId: pid });
  await A.bridge.start();
  assert.equal(A.bridge.supported(), false, '旧版回 unsupported');
  const d = await A.call('declare_scope', { scope: '剪辑1->序列1' }, 'conv-a');
  assert.equal(d.ok, true);
  await A.call('get_project', {}, 'conv-a');
  const w = await A.call('update_clip', { clipId: 'c1', opacity: 0.5 }, 'conv-a');
  assert.equal(w.ok, true, '写入照常');
  const sent = A.bridge.describe().stats.sent;
  await A.bridge.publishAgent('conv-a');
  assert.equal(A.bridge.describe().stats.sent, sent, '记下不支持之后不再发');
  assert.equal(A.bridge.forward({ from: 'conv-a', to: 'x', text: 'y', hops: 1 }), false);
  assert.equal(A.side.link.describe().conversations.every((c) => c.state === 'open'), true, '连接没断');
  // 页面那一侧:旧版对 presence.set 回 unsupported,不断线
  const pg = await svc.client('bob@devB');
  const r = await pg.ask({ type: 'presence.set', projectId: pid, key: 'editing', data: { kind: 'editing' } });
  assert.deepEqual([r.type, r.reason], ['error', 'unsupported']);
  const again = await pg.ask({ type: 'project.open', projectId: pid });
  assert.equal(again.type, 'project.state', '同一条连接照常能用');
});

/**
 * Multi-agent phase 2: cross-device (presence via document service). Plan
 * docs/plan/agent-workflow-plan.md A3 item 5. Test cases MA-X1-MA-X5.
 *
 * - MA-X1 Document service presence module: set / list / clear / send, forwards only to other
 *   subscribers of the same project, does not echo back to self, removed on disconnect, size-limited;
 * - MA-X2-X4 Two members share a real document service (identity via query string: alice@devA,
 *   bob@devB):
 *     Member B's page publishes "editing c2" → the Agent in member A's editor process reads c2,
 *     result includes "user bob is editing";
 *     A's Agent declares scope → B's page receives presence.update, present in bulletin board
 *     list of B's editor process;
 *     B's Agent sends message to A's Agent → enters A's inbox (marked as from member bob side);
 * - MA-X5 Fallback for legacy document service (without presence module): tools work as usual,
 *   no errors, does not disconnect; bridge stops sending after recording "unsupported".
 *
 * Run: node --test server/test/multi-agent-presence.test.mjs
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

/**
 * Identity via query string: ?user=<userId>&role=<page|agent>&conv=<n> (simulates member identity
 * in a shared project in tests)
 */
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
  t.after(async () => { for (const c of clients) { try { c.close(); } catch { /* Closed */ } } await service.close(); });
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

/* ------------------------------------------------------------------ Module */

test('MA-X1 presence module: relays only to other subscribers of the same project, never back to the sender; list returns the current entries; clear and disconnect remove them; send only broadcasts and does not record; size-limited', async (t) => {
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
  assert.equal(a.c.inbox.some((m) => m.type === 'presence.update'), false, 'not sent back to itself');
  assert.equal(other.c.inbox.some((m) => m.type === 'presence.update'), false, 'other projects receive nothing');
  const st = await b.ask({ type: 'presence.list', projectId: 'p1' });
  assert.equal(st.entries.length, 1);
  // send: broadcast only
  await b.ask({ type: 'presence.send', projectId: 'p1', data: { v: 1, kind: 'agent-message', to: 'x', text: 'hi' } });
  const msg = await a.c.next((m) => m.type === 'presence.message', 2000);
  assert.equal(msg.from.userId, 'bob@devB');
  assert.equal((await b.ask({ type: 'presence.list', projectId: 'p1' })).entries.length, 1, 'send does not record');
  // clear
  await a.ask({ type: 'presence.clear', projectId: 'p1', session: 'ue-a', key: 'editing' });
  const cl = await b.c.next((m) => m.type === 'presence.update', 2000);
  assert.equal(cl.data, null);
  // Removed on disconnect
  await a.ask({ type: 'presence.set', projectId: 'p1', session: 'ue-a', key: 'editing', data: { kind: 'editing' } });
  await b.c.next((m) => m.type === 'presence.update' && m.data, 2000);
  a.c.close();
  const gone = await b.c.next((m) => m.type === 'presence.update', 3000);
  assert.equal(gone.data, null);
  assert.equal((await b.ask({ type: 'presence.list', projectId: 'p1' })).entries.length, 0);
  // Size limit, key format
  const big = await b.ask({ type: 'presence.set', projectId: 'p1', key: 'editing', data: { pad: 'x'.repeat(PRESENCE_LIMITS.DATA_BYTES) } });
  assert.deepEqual([big.type, big.reason], ['error', 'too-large']);
  const badKey = await b.ask({ type: 'presence.set', projectId: 'p1', key: 'a b', data: {} });
  assert.deepEqual([badKey.type, badKey.reason], ['error', 'bad-message']);
  assert.equal(memberOf({ userId: 'bob@devB' }), 'bob');
  assert.equal(memberOf({ userId: 'local' }), null);
});

/* ------------------------------------------------------------------ Two members */

async function startVite(t) {
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => vite.close());
  const load = (id) => vite.ssrLoadModule(id);
  return { load, createEmptyProject: (await load('/src/kernel/project.ts')).createEmptyProject };
}

/**
 * A member's editor process: same assembly as vite-plugin-ai.ts (bulletin board, A2 board,
 * multiAgent, presence bridge)
 */
function editorProcess(t, svc, load, { user, projectId }) {
  const sessions = createAgentSessions();
  let bridge = null;
  const boards = createAgentBoards(() => ({ labelOf: (k) => sessions.get(k).vendor, forwardRemote: (m) => bridge?.forward(m) ?? false }));
  const board = () => boards.boardFor(projectId);
  const editing = createUserEditingBoard();
  const ma = createMultiAgent({ sessions, board, openTab: async () => { throw new Error('there is no page in this test'); } });
  const side = createAgentSide({
    projectId,
    url: (n) => svc.url(user, 'agent', n),
    protocolsFor: () => ['promptcut.v1'],
    loadHost: () => loadSsrHost(load),
    tools,
    toolGroups,
    callPage: async () => { throw new Error('there is no page in this test'); },
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
  p.cuts = [{ id: 'cut-1', name: 'Cut 1' }];
  p.activeCutId = 'cut-1';
  p.tracks = [
    { id: 't1', name: 'Track 1', clips: [{ id: 'c1', cardId: 'title', params: { text: 'One' }, start: 0, end: 3 }] },
    { id: 't2', name: 'Track 2', clips: [{ id: 'c2', cardId: 'title', params: { text: 'Two' }, start: 3, end: 6 }] },
  ];
  const r = await pg.ask({ type: 'project.op', projectId, opId: 'seed-1', session: 'page-a', ops: [{ op: 'set', path: '', value: p }] });
  assert.equal(r.type, 'project.op.ok', JSON.stringify(r));
  return pg;
}

test('MA-X2 to X4, two members sharing one document service: editing status, scope and messages are all relayed to the other member through presence', async (t) => {
  const svc = await startService(t);
  const { load, createEmptyProject } = await startVite(t);
  const pid = 'proj-ma-x';
  await seed(svc, createEmptyProject, pid);
  const A = editorProcess(t, svc, load, { user: 'alice@devA', projectId: pid });
  A.sessions.register('conv-a', { type: 'cli', vendor: 'claude' });
  await A.bridge.start();

  await t.test('MA-X2 member B\'s page is dragging c2: A\'s Agent reads c2 and the result carries "user bob is editing"; reading c1 does not; after B withdraws it, it no longer does', async () => {
    const pageB = await svc.client('bob@devB');
    await pageB.ask({ type: 'project.open', projectId: pid });
    const set = await pageB.ask({ type: 'presence.set', projectId: pid, session: 'ue-b', key: 'editing', ttlMs: 60000, data: { v: 1, kind: 'editing', session: 'ue-b', entities: [{ clipId: 'c2', kind: 'drag' }] } });
    assert.equal(set.type, 'presence.ok');
    await waitFor(() => A.editing.current().length === 1, 20_000, 'A\'s board receives B\'s editing status');
    assert.deepEqual(A.editing.current().map((e) => [e.clipId, e.kind, e.who]), [['c2', 'drag', 'bob']]);
    const r = await A.call('get_clip', { clipId: 'c2' }, 'conv-a');
    assert.deepEqual(r.userEditing, [{ clipId: 'c2', kind: 'drag', who: 'bob' }]);
    assert.ok(r.notice.startsWith('User bob is editing clip c2 (dragging). This is a hint, not a prohibition'), r.notice);
    const r1 = await A.call('get_clip', { clipId: 'c1' }, 'conv-a');
    assert.equal(r1.userEditing, undefined);
    // A's local page is editing c1 at the same time: two separate statements
    A.editing.report('ue-a-local', [{ clipId: 'c1', kind: 'text' }]);
    const whole = await A.call('get_project', {}, 'conv-a');
    assert.match(whole.notice, /^User is editing clip c1 \(editing text\); User bob is editing clip c2 \(dragging\)\./);
    A.editing.report('ue-a-local', []);
    // The copy sent back by A's local page itself via document service (same session id) is not treated
    // as someone else
    assert.equal(A.editing.reportRemote('ue-a-local', [{ clipId: 'c1', kind: 'drag' }], { who: 'alice' }), 0);
    await pageB.ask({ type: 'presence.clear', projectId: pid, session: 'ue-b', key: 'editing' });
    await waitFor(() => A.editing.current().length === 0, 20_000, 'after B withdraws it, A\'s board clears it');
  });

  let B = null;
  await t.test('MA-X3 scope declared by A\'s Agent: B\'s page receives presence.update; it appears in the bulletin board list of B\'s editor process (with the member name)', async () => {
    const pageB = await svc.client('bob@devB');
    await pageB.ask({ type: 'project.open', projectId: pid });
    B = editorProcess(t, svc, load, { user: 'bob@devB', projectId: pid });
    B.sessions.register('conv-b', { type: 'cli', vendor: 'codex' });
    await B.bridge.start();
    const d = await A.call('declare_scope', { scope: 'Cut 1->Track 2', note: 'Add captions' }, 'conv-a');
    assert.equal(d.ok, true);
    const up = await pageB.c.next((m) => m.type === 'presence.update' && m.key === 'agent:conv-a', 3000);
    assert.deepEqual({ scope: up.data.scope, vendor: up.data.vendor, user: up.from.userId, role: up.from.role }, { scope: 'Cut 1->Track 2', vendor: 'claude', user: 'alice@devA', role: 'agent' });
    await waitFor(() => B.board().listRaw('conv-b').some((x) => x.id === 'conv-a'), 20_000, 'B\'s bulletin board receives A\'s Agent');
    const la = await B.call('list_agents', {}, 'conv-b');
    const remote = la.agents.find((x) => x.id === 'conv-a');
    assert.deepEqual({ scope: remote.scope, member: remote.member, remote: remote.remote, vendor: remote.vendor }, { scope: 'Cut 1->Track 2', member: 'alice', remote: true, vendor: 'claude' });
    // A's own side does not treat its own Agent as remote
    assert.equal(A.board().listRaw('').some((x) => x.remote), false);
    t.diagnostic(`A's bridge:${JSON.stringify(A.bridge.describe())}`);
  });

  await t.test('MA-X4 B\'s Agent sends a message to A\'s Agent: it goes into A\'s mailbox, marked as coming from member bob\'s side', async () => {
      const s = await B.call('send_message', { to: 'conv-a', text: 'You take Track 2, I\'ll edit Track 1' }, 'conv-b');
      assert.equal(s.ok, true, JSON.stringify(s));
      assert.match(s.note, /forwarded through the document service/);
      await waitFor(() => A.board().checkMessages('conv-a').messages.length === 1, 20_000, 'A\'s mailbox received it');
      const m = A.board().checkMessages('conv-a').messages[0];
      assert.equal(m.text, 'You take Track 2, I\'ll edit Track 1');
      assert.match(m.fromLabel, /^Agent conv-b \(codex, on member bob's side\)$/);
      // Included in A's Agent's next tool result
      const r = await A.call('get_clip', { clipId: 'c1' }, 'conv-a');
      assert.match(r.notice, /\[Agent conv-b \(codex, on member bob's side\)\] You take Track 2, I'll edit Track 1/);
  });
});

test('MA-X5 old document service (without the presence module): tools work as usual, no errors, no disconnect; after the bridge records "unsupported" it stops sending', async (t) => {
  const svc = await startService(t, { withPresence: false });
  const { load, createEmptyProject } = await startVite(t);
  const pid = 'proj-ma-old';
  await seed(svc, createEmptyProject, pid);
  const A = editorProcess(t, svc, load, { user: 'alice@devA', projectId: pid });
  await A.bridge.start();
  assert.equal(A.bridge.supported(), false, 'the old version answers unsupported');
  const d = await A.call('declare_scope', { scope: 'Cut 1->Track 1' }, 'conv-a');
  assert.equal(d.ok, true);
  await A.call('get_project', {}, 'conv-a');
  const w = await A.call('update_clip', { clipId: 'c1', opacity: 0.5 }, 'conv-a');
  assert.equal(w.ok, true, 'writes work as usual');
  const sent = A.bridge.describe().stats.sent;
  await A.bridge.publishAgent('conv-a');
  assert.equal(A.bridge.describe().stats.sent, sent, 'stops sending after recording unsupported');
  assert.equal(A.bridge.forward({ from: 'conv-a', to: 'x', text: 'y', hops: 1 }), false);
  assert.equal(A.side.link.describe().conversations.every((c) => c.state === 'open'), true, 'the connection stays up');
  // Page side: legacy version returns unsupported for presence.set, does not disconnect
  const pg = await svc.client('bob@devB');
  const r = await pg.ask({ type: 'presence.set', projectId: pid, key: 'editing', data: { kind: 'editing' } });
  assert.deepEqual([r.type, r.reason], ['error', 'unsupported']);
  const again = await pg.ask({ type: 'project.open', projectId: pid });
  assert.equal(again.type, 'project.state', 'the same connection still works as usual');
});

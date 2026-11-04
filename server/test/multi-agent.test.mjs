/**
 * Server side of multi-agent (plan docs/plan/agent-workflow-plan.md A3). Test cases MA-S1-MA-S14.
 *
 * - Pure logic: subagent spawn limits (depth 1, concurrency 4), desktop app sessions have no tabs
 *   to open, subagent level cannot exceed parent chat, bulletin board list / delivery (immediate
 *   when idle, queued when busy, included in next tool result, chained delivery cap), notices on
 *   both sides when writing into another's declared scope;
 * - End-to-end (real document service + real src/mcp/handlers + createAgentSide + attachLink):
 *   parent and child write in parallel, each recording its own identity; bulletin board is fed by
 *   commit stream (page and both Agents' writes are present); overwritten side is notified in next
 *   tool result;
 * - No leftover entry points after archiving split-work mode (ratchet check by identifier and route).
 *
 * Run: node --test server/test/multi-agent.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createAgentSide } from '../agent/agent-side.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { createAgentSessions } from '../agent/agent-sessions.mjs';
import { BOARD_DEFAULTS, annotateBoard, byOfActor, createAgentBoard, createAgentBoards } from '../agent/agent-board.mjs';
import { SPAWN_LIMITS, attachLink, createMultiAgent } from '../agent/multi-agent.mjs';
import { SPAWN_ROLE_IDS, loadRole } from '../agent/agent-roles.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Assembly setup (same wiring as vite-plugin-ai.ts): registry, per-project bulletin board,
 * multiAgent; openTab is a mock page
 */
function rig({ projectLevel = 'high', openTab } = {}) {
  const sessions = createAgentSessions();
  const boards = createAgentBoards(() => ({ labelOf: (k) => sessions.get(k).vendor, infoOf: (k) => { const e = sessions.get(k); return { role: e.role, parent: e.parent }; } }));
  let projectKey = 'p';
  const board = () => boards.boardFor(projectKey);
  const opened = [];
  const ma = createMultiAgent({
    sessions,
    board,
    projectCreativity: () => projectLevel,
    openTab: openTab ?? (async (spec) => { opened.push(spec); board().setTabs([...board().listRaw('').filter((a) => a.id !== spec.conversationId).map((a) => ({ conversationId: a.id, title: a.title, busy: a.busy })), { conversationId: spec.conversationId, title: spec.roleName, busy: false }]); }),
  });
  return { sessions, boards, board, ma, opened, setProject: (k) => { projectKey = k; } };
}

/* ------------------------------------------------------------------ Pure logic */

test('MA-S1 numbers and roles: depth 1, concurrency 4, chain of 3 levels; every spawnable role can read its prompt, and the enum in the tool table matches them; all five tools are answered on the server', () => {
  assert.equal(SPAWN_LIMITS.maxDepth, 1);
  assert.equal(SPAWN_LIMITS.maxChildren, 4);
  assert.equal(BOARD_DEFAULTS.MAX_AUTO_HOPS, 3);
  assert.equal(BOARD_DEFAULTS.idleMs, 30 * 60_000);
  for (const id of SPAWN_ROLE_IDS) {
    const r = loadRole(id);
    assert.ok(r && r.name && r.prompt.length > 10, id);
  }
  assert.equal(loadRole('manager'), null, 'the production manager role, which only breaks down and schedules work, is archived along with split-work mode');
  const spawn = tools.find((t) => t.name === 'spawn_agent');
  assert.deepEqual(spawn.inputSchema.properties.role.enum, [...SPAWN_ROLE_IDS]);
  for (const n of ['spawn_agent', 'declare_scope', 'list_agents', 'send_message', 'check_messages']) {
    assert.equal(tools.find((t) => t.name === n)?.side, 'server', n);
  }
});

test('MA-S2 spawn_agent: the new identity is registered (vendor / driver inherited from the parent chat, role, parent), a tab is opened, and the task goes into its mailbox as the first message', async () => {
  const r = rig();
  r.sessions.register('conv-main', { type: 'cli', vendor: 'claude', role: 'main' });
  const out = await r.ma.handle('spawn_agent', { role: 'director', task: 'Put the media onto Cut 1->Track 1' }, 'conv-main');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.match(out.conversationId, /^sub-[A-Za-z0-9_-]{12}$/);
  assert.equal(out.roleName, 'Editing director');
  const child = r.sessions.get(out.conversationId);
  assert.deepEqual({ type: child.type, vendor: child.vendor, role: child.role, parent: child.parent }, { type: 'cli', vendor: 'claude', role: 'director', parent: 'conv-main' });
  assert.equal(r.opened.length, 1);
  assert.deepEqual({ ...r.opened[0], task: undefined }, { conversationId: out.conversationId, role: 'director', roleName: 'Editing director', parent: 'conv-main', provider: 'claude', creativity: 'high', task: undefined });
  assert.equal(r.board().hasAutoDeliverable(out.conversationId), true, 'if the tab is idle, the page sends it');
  const first = r.board().takeInbox(out.conversationId, true);
  assert.deepEqual(first.map((m) => [m.from, m.text, m.hops]), [['conv-main', 'Put the media onto Cut 1->Track 1', 1]]);
  // Registration of subsequent messages in AI panel (fixed role main) does not overwrite subagent
  // role and parent chat
  r.sessions.register(out.conversationId, { type: 'cli', vendor: 'claude', role: 'main', creativity: 'high' });
  assert.deepEqual([r.sessions.get(out.conversationId).role, r.sessions.get(out.conversationId).parent], ['director', 'conv-main']);
  // Direct API parent chat: subagent driver is api
  r.sessions.register('conv-api', { type: 'api', vendor: 'anthropic' });
  const api = await r.ma.handle('spawn_agent', { role: 'collector', task: 'x' }, 'conv-api');
  assert.equal(api.provider, 'api');
  // Invalid parameters
  assert.equal((await r.ma.handle('spawn_agent', { role: 'manager', task: 'x' }, 'conv-main')).code, 'bad-role');
  assert.equal((await r.ma.handle('spawn_agent', { role: 'director', task: '  ' }, 'conv-main')).code, 'bad-task');
});

test('MA-S3 depth limit: a subagent spawning again is rejected, and the error says who spawned it', async () => {
  const r = rig();
  r.sessions.register('conv-main', { type: 'cli', vendor: 'codex' });
  const c = await r.ma.handle('spawn_agent', { role: 'fx-assistant', task: 'Add captions' }, 'conv-main');
  const again = await r.ma.handle('spawn_agent', { role: 'director', task: 'Spawn another one' }, c.conversationId);
  assert.equal(again.ok, false);
  assert.equal(again.code, 'depth');
  assert.match(again.error, /sub-Agent \(spawned by conv-main\) and cannot spawn other Agents/);
  assert.equal(r.opened.length, 1, 'no second page was opened');
});

test('MA-S4 concurrency limit: the same lead Agent can have at most 4 subagents open, and the 5th is rejected; closing a tab frees a slot; other lead Agents are unaffected', async () => {
  const r = rig();
  r.sessions.register('conv-main', { type: 'cli', vendor: 'claude' });
  r.sessions.register('conv-other', { type: 'cli', vendor: 'claude' });
  const kids = [];
  for (let i = 0; i < 4; i += 1) {
    const o = await r.ma.handle('spawn_agent', { role: 'director', task: `Task ${i}` }, 'conv-main');
    assert.equal(o.ok, true, JSON.stringify(o));
    kids.push(o.conversationId);
  }
  const fifth = await r.ma.handle('spawn_agent', { role: 'director', task: 'The fifth one' }, 'conv-main');
  assert.equal(fifth.ok, false);
  assert.equal(fifth.code, 'too-many');
  assert.deepEqual(fifth.children.sort(), [...kids].sort());
  assert.match(fifth.error, /already have 4 sub-Agents open at once \(limit 4\)/);
  assert.equal((await r.ma.handle('spawn_agent', { role: 'director', task: 'Someone else\'s' }, 'conv-other')).ok, true, 'counted separately per lead Agent');
  // User closes the first subagent tab
  r.board().setTabs(r.board().listRaw('').filter((a) => a.id !== kids[0]).map((a) => ({ conversationId: a.id, title: a.title, busy: false })));
  assert.equal((await r.ma.handle('spawn_agent', { role: 'director', task: 'Fill the slot' }, 'conv-main')).ok, true);
});

test('MA-S5 no tab can be opened: desktop app session / unregistered chat, no chat ID given, editor not open, all return a clear error and leave no registration', async () => {
  const r = rig({ openTab: async () => { throw new Error('The editor is not open, so there is no tab to open'); } });
  const desk = await r.ma.handle('spawn_agent', { role: 'director', task: 'x' }, 'desk-1');
  assert.equal(desk.code, 'no-tab');
  assert.match(desk.error, /desktop app session/);
  assert.equal((await r.ma.handle('spawn_agent', { role: 'director', task: 'x' }, '')).code, 'no-parent');
  r.sessions.register('conv-main', { type: 'cli', vendor: 'claude' });
  const closed = await r.ma.handle('spawn_agent', { role: 'director', task: 'x' }, 'conv-main');
  assert.equal(closed.code, 'no-tab');
  assert.match(closed.error, /editor is not open/);
  assert.deepEqual(r.sessions.childrenOf('conv-main'), [], 'if no tab can be opened, the registration is withdrawn');
});

test('MA-S6 subagent creativity level: takes the level currently in effect on the parent chat; afterwards it also never exceeds the parent chat (if the parent is downgraded it follows, and raising the child only goes up to the parent\'s tier)', async () => {
  const r = rig({ projectLevel: 'high' });
  r.sessions.register('conv-main', { type: 'cli', vendor: 'claude', creativity: 'medium' });
  const c = await r.ma.handle('spawn_agent', { role: 'director', task: 'x' }, 'conv-main');
  assert.equal(c.creativity, 'medium');
  assert.equal(r.sessions.creativityOf(c.conversationId, 'high').level, 'medium');
  // User sets to "high" in subtab: still capped at parent chat's "medium"
  r.sessions.register(c.conversationId, { type: 'cli', vendor: 'claude', creativity: 'high' });
  const up = r.sessions.creativityOf(c.conversationId, 'high');
  assert.equal(up.level, 'medium');
  assert.match(up.source, /not higher than the chat conv-main that launched it/);
  // Parent chat lowered to "low": child lowers accordingly
  r.sessions.register('conv-main', { type: 'cli', vendor: 'claude', creativity: 'low' });
  assert.equal(r.sessions.creativityOf(c.conversationId, 'high').level, 'low');
  // Subagent lowering itself is allowed
  r.sessions.register('conv-main', { type: 'cli', vendor: 'claude', creativity: 'high' });
  r.sessions.register(c.conversationId, { type: 'cli', vendor: 'claude', creativity: 'low' });
  assert.equal(r.sessions.creativityOf(c.conversationId, 'high').level, 'low');
});

test('MA-S7 bulletin board list: tabs, sessions that have called tools, declared scopes; entries idle for 30 minutes are no longer listed; how the writer identity is determined', () => {
  let t = 1_000_000;
  const b = createAgentBoard({ now: () => t, labelOf: (k) => (k === 'conv-a' ? 'claude' : null) });
  b.setTabs([{ conversationId: 'conv-a', title: 'Agent 1', busy: true }, { conversationId: 'bad id', title: 'x' }]);
  b.touch('desk-1');
  const d = b.declareScope('conv-a', { scope: 'Cut 1->Track 2', note: 'Add captions' });
  assert.equal(d.ok, true);
  assert.deepEqual(b.listRaw('conv-a').map((a) => [a.id, a.scope, a.busy, a.you, a.vendor ?? null]), [['conv-a', 'Cut 1->Track 2', true, true, 'claude'], ['desk-1', null, false, false, null]]);
  const d2 = b.declareScope('desk-1', { scope: 'Cut 1' });
  assert.match(d2.warning, /conv-a\(Cut 1->Track 2\)/, 'a parent scope counts as overlapping');
  t += 31 * 60_000;
  assert.deepEqual(b.listRaw('').map((a) => a.id), ['conv-a'], 'sessions with an open tab always stay; sessions idle for 30 minutes are no longer listed');
  assert.equal(b.declareScope('', { scope: 'x' }).ok, false, 'without a chat ID it cannot be recorded');
  assert.deepEqual(byOfActor({ role: 'page', userId: 'local' }), { kind: 'user' });
  assert.deepEqual(byOfActor({ role: 'page', userId: 'bob' }), { kind: 'user', userId: 'bob' });
  assert.deepEqual(byOfActor({ role: 'agent', session: 'agent:conv-a' }), { kind: 'agent', agent: 'conv-a' });
  assert.deepEqual(byOfActor({ role: 'agent', session: 'agent:default' }), { kind: 'agent', agent: '' });
});

test('MA-S8 message delivery: idle ones are picked up by the page (only those whose chain depth has not hit the cap); busy ones are queued and carried in their next tool result; those at the cap wait until the user next speaks', async () => {
  const r = rig();
  const b = r.board();
  b.setTabs([{ conversationId: 'conv-a', title: 'A' }, { conversationId: 'conv-b', title: 'B' }]);
  // Idle: auto-delivery allowed
  const s1 = b.sendMessage('conv-a', { to: 'conv-b', text: 'I\'ll take Track 2' });
  assert.deepEqual(s1.delivered, ['conv-b']);
  assert.match(s1.note, /The recipient is idle/);
  assert.equal(b.hasAutoDeliverable('conv-b'), true);
  assert.deepEqual(b.takeInbox('conv-b', true).map((m) => m.text), ['I\'ll take Track 2']);
  // Busy: B is running a round
  b.beginRun('conv-b', 0);
  const s2 = b.sendMessage('conv-a', { to: 'conv-b', text: 'I finished editing Track 3' });
  assert.match(s2.note, /is running; the message will be included in the result of its next tool call/);
  const res = await r.ma.wrap('conv-b', 'get_project', async () => ({ ok: true, rev: 3 }));
  assert.ok(res.notice.startsWith('Message from another Agent (attached by the system, not something the user said): [Agent conv-a] I finished editing Track 3'), res.notice);
  assert.deepEqual(res.messages.map((m) => [m.from, m.text]), [['conv-a', 'I finished editing Track 3']]);
  assert.equal(res.rev, 3, 'the original result fields stay as before');
  assert.equal(b.hasAutoDeliverable('conv-b'), false, 'once carried out it counts as delivered, and it is not delivered again after the run finishes');
  const again = await r.ma.wrap('conv-b', 'get_project', async () => ({ ok: true }));
  assert.equal(again.notice, undefined);
  b.endRun('conv-b');
  // Chained delivery cap: B runs in level-2 auto-delivery; what it sends to A is level 3, not
  // automatically triggered
  b.beginRun('conv-b', 2);
  const s3 = b.sendMessage('conv-b', { to: 'conv-a', text: 'OK' });
  assert.match(s3.note, /messaged each other for several rounds in a row/);
  assert.equal(b.hasAutoDeliverable('conv-a'), false);
  const notes = b.consumeNotes('conv-a');
  assert.match(notes, /Message to you from Agent conv-b \d\d:\d\d:\d\d: OK/, 'carried along the next time the user talks to A');
  b.endRun('conv-b');
  // Send to non-existent / all
  assert.throws(() => b.sendMessage('conv-a', { to: 'nobody', text: 'x' }), /No such Agent/);
  assert.deepEqual(b.sendMessage('conv-a', { to: 'all', text: 'All done' }).delivered, ['conv-b']);
  // check_messages does not consume messages
  assert.equal(b.checkMessages('conv-b').messages.length, 1);
  assert.equal(b.checkMessages('conv-b').messages.length, 1);
});

test('MA-S9 writing into a scope declared by someone else: the writer is notified in this result; the declarer is notified in its next result (only once); a write by the user also triggers the notice', async () => {
  const r = rig();
  const b = r.board();
  b.setTabs([{ conversationId: 'conv-a', title: 'A' }, { conversationId: 'conv-b', title: 'B' }]);
  b.declareScope('conv-a', { scope: 'Cut 1->Track 2' });
  const p0 = { tracks: [{ id: 't2', name: 'Track 2', clips: [] }], cuts: [{ id: 'c1', name: 'Cut 1' }], activeCutId: 'c1' };
  const p1 = { ...p0, tracks: [{ ...p0.tracks[0], clips: [{ id: 'x' }] }] };
  const w = await r.ma.wrap('conv-b', 'add_clip', async () => {
    b.noteCommit({ rev: 2, opId: 'op1', actor: { role: 'agent', session: 'agent:conv-b' }, before: p0, after: p1 });
    return { ok: true, id: 'x' };
  });
  assert.deepEqual(w.scopeClash, [{ agent: 'conv-a', who: 'Agent conv-a', scope: 'Cut 1->Track 2', written: ['Cut 1->Track 2'] }]);
  assert.match(w.notice, /^This write falls within a scope another Agent is editing: "Cut 1->Track 2" that Agent conv-a declared it is editing/);
  assert.equal(b._changes().at(-1).tool, 'add_clip', 'the commit stream record carries the tool name');
  const a1 = await r.ma.wrap('conv-a', 'get_clip', async () => ({ ok: true }));
  assert.equal(a1.scopeChanges.length, 1);
  assert.match(a1.notice, /^Someone else is editing a scope you declared: Agent conv-b using add_clip changed Cut 1->Track 2/);
  const a2 = await r.ma.wrap('conv-a', 'get_clip', async () => ({ ok: true }));
  assert.equal(a2.scopeChanges, undefined, 'the same entry is notified only once');
  // User changed A's scope on the page
  const p2 = { ...p1, tracks: [{ ...p1.tracks[0], clips: [] }] };
  b.noteCommit({ rev: 3, actor: { role: 'page', userId: 'local' }, before: p1, after: p2 });
  const a3 = await r.ma.wrap('conv-a', 'get_clip', async () => ({ ok: true }));
  assert.match(a3.notice, /Someone else is editing a scope you declared: User changed Cut 1->Track 2/);
  // These notices do not reappear in "Activity of other Agents" in the next round
  const notes = b.consumeNotes('conv-a');
  assert.equal(notes.includes('changed Cut 1->Track 2'), false, notes);
  // Multi-agent tools themselves do not carry notices
  b.deliver({ from: 'conv-b', to: 'conv-a', text: 'hi' });
  const chk = await r.ma.wrap('conv-a', 'check_messages', async () => b.checkMessages('conv-a'));
  assert.equal(chk.notice, undefined);
});

test('MA-S10 annotateBoard places things the same way as A2: the notice goes first, the original notice follows, fields are preserved; arrays are wrapped in an extra layer; with nothing to add it returns the input unchanged', () => {
  const plain = { ok: true };
  assert.equal(annotateBoard(plain, {}), plain);
  const r = annotateBoard({ ok: true, notice: 'User is editing clip c1 (dragging).', rev: 2 }, { overwrittenBy: [{ entity: '/tracks/@t1/clips/@c1', who: 'Agent conv-a(claude)', by: 'agent', rev: 5 }] });
  assert.deepEqual(Object.keys(r).slice(0, 2), ['notice', 'overwrittenBy']);
  assert.equal(r.notice, 'You wrote clip c1 (overwritten by Agent conv-a(claude), rev 5). Re-read to confirm the current content, coordinate with them if needed, and do not simply revert it.\nUser is editing clip c1 (dragging).');
  assert.equal(r.rev, 2);
  const arr = annotateBoard([1], { messages: [{ from: 'x', text: 'y' }] });
  assert.deepEqual(arr.result, [1]);
});

/* ------------------------------------------------------------------ End-to-end */

async function startEnv(t) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/docservice`;
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const closers = [];
  t.after(async () => {
    for (const c of closers) { try { c(); } catch { /* Closed */ } }
    await vite.close();
    await built.service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const load = (id) => vite.ssrLoadModule(id);
  const { createEmptyProject } = await load('/src/kernel/project.ts');

  async function page(projectId, session = 'page-1') {
    const c = wsClient(url);
    closers.push(() => c.close());
    await c.opened;
    let seq = 0;
    return {
      async open() {
        c.send({ type: 'project.open', projectId, reqId: `open-${++seq}` });
        return c.next((m) => m.type === 'project.state');
      },
      async commit(ops) {
        const opId = `${session}-op-${++seq}`;
        c.send({ type: 'project.op', projectId, opId, session, ops, reqId: opId });
        return c.next((m) => m.reqId === opId);
      },
    };
  }

  async function seeded(projectId) {
    const pg = await page(projectId);
    await pg.open();
    const p = createEmptyProject('ma-test');
    p.id = projectId;
    p.cuts = [{ id: 'cut-1', name: 'Cut 1' }];
    p.activeCutId = 'cut-1';
    p.tracks = [
      { id: 't1', name: 'Track 1', clips: [{ id: 'c1', cardId: 'title', params: { text: 'One' }, start: 0, end: 3 }] },
      { id: 't2', name: 'Track 2', clips: [{ id: 'c2', cardId: 'title', params: { text: 'Two' }, start: 3, end: 6 }] },
    ];
    const reply = await pg.commit([{ op: 'set', path: '', value: p }]);
    assert.equal(reply.type, 'project.op.ok', JSON.stringify(reply));
    return pg;
  }

  /** Same assembly as vite-plugin-ai.ts: tools with side:"server" handed to multiAgent; each call wrapped */
  function agentRig(projectId) {
    const r = rig();
    r.setProject(projectId);
    const s = createAgentSide({
      projectId,
      url,
      protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`],
      loadHost: () => loadSsrHost(load),
      tools,
      toolGroups,
      callPage: async () => { throw new Error('there is no page in this test'); },
      callServer: (tool, args, ctx) => r.ma.handle(tool, args, ctx?.agent ?? ''),
      agentLabel: (k) => r.sessions.get(k).vendor,
      onPageWrites: (agent, ops) => r.board().attributeOps(agent, ops),
    });
    closers.push(() => s.close());
    const detach = attachLink(s.link, r.board);
    closers.push(detach);
    const call = (tool, args, agent) => r.ma.wrap(agent, tool, () => s.callTool(tool, args, { agent }));
    return { ...r, side: s, call };
  }

  return { seeded, agentRig };
}

test('MA-S11 to S13 end to end: spawned identities are isolated, the bulletin board is fed by the commit stream, and the overwritten side learns of it in its next result', async (t) => {
  const env = await startEnv(t);

  await t.test('MA-S11 parallel writes by parent and child are each recorded under their own identity: each write after its own read lands and neither is judged stale by the other; in the commit stream the writer identities are the parent and the child respectively', async () => {
    const pid = 'proj-ma-identity';
    await env.seeded(pid);
    const g = env.agentRig(pid);
    g.sessions.register('conv-main', { type: 'cli', vendor: 'claude' });
    g.board().setTabs([{ conversationId: 'conv-main', title: 'Agent 1' }]);
    const sp = await g.call('spawn_agent', { role: 'fx-assistant', task: 'Add captions to Track 2' }, 'conv-main');
    assert.equal(sp.ok, true, JSON.stringify(sp));
    const kid = sp.conversationId;
    // Both sides read once and alternately write their clips; each write reads the version just
    // committed by the other (read-after-write)
    await Promise.all([g.call('get_project', {}, 'conv-main'), g.call('get_project', {}, kid)]);
    const w1 = await g.call('update_clip', { clipId: 'c1', opacity: 0.5 }, 'conv-main');
    assert.equal(w1.ok, true, JSON.stringify(w1));
    await g.call('get_clip', { clipId: 'c2' }, kid);
    const w2 = await g.call('update_clip', { clipId: 'c2', opacity: 0.6 }, kid);
    assert.equal(w2.ok, true, JSON.stringify(w2));
    await g.call('get_clip', { clipId: 'c1' }, 'conv-main');
    const w3 = await g.call('update_clip', { clipId: 'c1', opacity: 0.7 }, 'conv-main');
    assert.equal(w3.ok, true, JSON.stringify(w3));
    // Respective write identities: different chat numbers, session is each one's chat ID
    const hist = g.side.link.replica.history.filter((h) => h.rev >= w1.rev);
    assert.deepEqual(hist.map((h) => h.session), ['agent:conv-main', `agent:${kid}`, 'agent:conv-main']);
    assert.notEqual(g.side.conversationNumber('conv-main'), g.side.conversationNumber(kid));
    assert.deepEqual([g.side.executor.lastRead('conv-main'), g.side.executor.lastRead(kid)], [w3.rev, w2.rev], 'each records the version it read');
    // Change records on the bulletin board are also tracked separately
    const ch = g.board()._changes().filter((c) => c.kind === 'change');
    assert.deepEqual(ch.map((c) => [c.by.agent, c.tool, c.scopes.join()]), [['conv-main', 'update_clip', 'Cut 1->Track 1'], [kid, 'update_clip', 'Cut 1->Track 2'], ['conv-main', 'update_clip', 'Cut 1->Track 1']]);
    // Note: writing without re-reading is still rejected by document service expected version
    // (product/document-service.md "Agent writes carry expected version")
    await assert.rejects(g.call('update_clip', { clipId: 'c2', opacity: 0.1 }, kid), /changed after your last read|Re-read/);
  });

  await t.test('MA-S12 the bulletin board sees writes from the page and both Agents (the document service\'s commit stream), and writes from other members are labeled by writer identity', async () => {
    const pid = 'proj-ma-feed';
    const pg = await env.seeded(pid);
    const g = env.agentRig(pid);
    g.board().setTabs([{ conversationId: 'conv-a', title: 'A' }, { conversationId: 'conv-b', title: 'B' }]);
    await g.call('get_project', {}, 'conv-a');
    await g.call('update_clip', { clipId: 'c1', opacity: 0.4 }, 'conv-a');
    await g.call('get_project', {}, 'conv-b');
    await g.call('update_clip', { clipId: 'c2', opacity: 0.4 }, 'conv-b');
    const pr = await pg.commit([{ op: 'set', path: '/tracks/@t2/clips/@c2/label', value: 'Changed by the page' }]);
    await waitFor(() => g.board()._changes().some((c) => c.rev === pr.rev), 3000, 'the page\'s commit reaches the bulletin board');
    const ch = g.board()._changes().filter((c) => c.kind === 'change');
    assert.deepEqual(ch.map((c) => [c.by.kind, c.by.agent ?? null, c.scopes.join()]), [
      ['agent', 'conv-a', 'Cut 1->Track 1'], ['agent', 'conv-b', 'Cut 1->Track 2'], ['user', null, 'Cut 1->Track 2'],
    ]);
    // Other members in a shared project: write identity is page + their userId (fed directly here;
    // see multi-agent-presence.test.mjs for cross-device end-to-end)
    const p = g.side.link.replica.project;
    g.board().noteCommit({ rev: 99, actor: { role: 'page', userId: 'bob' }, before: p, after: { ...p, tracks: [p.tracks[0], { ...p.tracks[1], clips: [] }] } });
    const notes = g.board().consumeNotes('conv-a');
    assert.match(notes, /Agent conv-b using update_clip changed Cut 1->Track 2/);
    assert.match(notes, /User changed Cut 1->Track 2/);
    assert.match(notes, /User bob changed Cut 1->Track 2/);
    assert.equal(notes.includes('conv-a using'), false, 'one\'s own changes do not appear in one\'s own activity feed');
  });

  await t.test('MA-S13 the overwritten side learns in its next tool result: the c2 written by conv-b is overwritten by conv-a, and conv-b\'s next call carries "Your write to … overwritten by Agent conv-a(codex)"', async () => {
    const pid = 'proj-ma-overwritten';
    await env.seeded(pid);
    const g = env.agentRig(pid);
    g.sessions.register('conv-a', { type: 'cli', vendor: 'codex' });
    await g.call('get_project', {}, 'conv-a');
    await g.call('get_project', {}, 'conv-b');
    const b1 = await g.call('update_clip', { clipId: 'c2', opacity: 0.2 }, 'conv-b');
    assert.equal(b1.ok, true);
    await g.call('get_clip', { clipId: 'c2' }, 'conv-a');
    const a1 = await g.call('update_clip', { clipId: 'c2', opacity: 0.9 }, 'conv-a');
    assert.equal(a1.overwrote.length, 1, 'the overwriting side is unchanged (A2)');
    await new Promise((r) => setTimeout(r, 200));
    const b2 = await g.call('get_clip', { clipId: 'c1' }, 'conv-b');
    assert.equal(b2.overwrittenBy?.length, 1, JSON.stringify(b2));
    assert.deepEqual({ entity: b2.overwrittenBy[0].entity, who: b2.overwrittenBy[0].who, by: b2.overwrittenBy[0].by, rev: b2.overwrittenBy[0].rev }, { entity: '/tracks/@t2/clips/@c2', who: 'Agent conv-a (codex)', by: 'agent', rev: a1.rev });
    assert.match(b2.notice, /^You wrote clip c2 \(overwritten by Agent conv-a \(codex\), rev \d+\)/);
    const b3 = await g.call('get_clip', { clipId: 'c1' }, 'conv-b');
    assert.equal(b3.overwrittenBy, undefined, 'told only once');
    // The page (user) overwrites what the Agent wrote
    const a2 = await g.call('update_clip', { clipId: 'c1', opacity: 0.3 }, 'conv-a');
    assert.equal(a2.ok, true);
  });
});

/* ------------------------------------------------------------------ Archive */

test('MA-S14 no leftover entry points after split-work mode was archived: identifiers, routes and files are all gone (ratchet: may only decrease)', () => {
  const gone = ['src/ai/teamMode.ts', 'src/ai/orchestrate.ts', 'src/ai/orchestrateGraph.ts', 'src/ai/triage.ts', 'src/ai/runRoleTask.ts', 'src/editor/right/OrchestrationBlock.tsx', 'src/editor/right/OrchestrationBlock.css', 'src/ai/roles/manager.md'];
  for (const f of gone) assert.equal(fs.existsSync(path.join(ROOT, f)), false, `${f} should have been deleted`);
  const patterns = [/\bteamMode\b/i, /\bisTeamMode\b/, /\borchestrat/i, /\btriage\b/i, /\brunRoleTask\b/, /\bOrchestrationBlock\b/, /\/api\/ai\/plan\b/, /\/api\/ai\/triage\b/, /data-pc="ai-team-mode"/, /Split-work mode<\//];
  const hits = [];
  // Baseline file description records which two routes were deleted; its paths are checked separately
  // below
  const skip = new Set(['server/test/multi-agent.test.mjs', 'server/test/c10-api-ratchet-baseline.json']);
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      const rel = path.relative(ROOT, file).replaceAll('\\', '/');
      if (item.isDirectory()) { if (item.name !== 'node_modules') walk(file); continue; }
      if (!/\.(tsx?|mjs|js|cjs|css|json|html)$/.test(item.name) || skip.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const re of patterns) if (re.test(text)) hits.push(`${rel} :: ${re}`);
    }
  };
  for (const d of ['src', 'server', 'scripts']) walk(path.join(ROOT, d));
  assert.deepEqual(hits, [], `Entry points of split-work mode still remain:\n${hits.join('\n')}`);
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/test/c10-api-ratchet-baseline.json'), 'utf8')).paths;
  assert.equal(baseline.includes('/api/ai/plan') || baseline.includes('/api/ai/triage'), false, 'the online build\'s /api ratchet baseline is updated for the deleted routes');
});

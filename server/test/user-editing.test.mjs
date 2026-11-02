/**
 * Server side of "User is editing" for desktop app (Plan docs/plan/agent-workflow-plan.md A2).
 * Test cases UE-S1 to UE-S10.
 *
 * - Editing state remembered by server: full replacement, merge, expiration (scrub / text editing
 *   not renewed for 15s, "just touched" based on remaining milliseconds reported by page);
 * - Which clips this invocation touches: named in parameters, actually written (ops paths), reading
 *   the whole project;
 * - End-to-end (real document service + real src/mcp/handlers + createAgentSide): read tool and write
 *   tool results include userEditing; overwriting an entity just written by the page marks "user
 *   just modified", overwriting one just written by another Agent marks "Agent <identity>
 *   just modified".
 *
 * Run: node --test server/test/user-editing.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createAgentSide } from '../agent/agent-side.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import {
  USER_EDITING_DEFAULTS, createUserEditingBoard, clipIdsOfArgs, clipIdsOfOps, userEditingFor, userEditingNotice,
  overwroteView, writerOf, annotateResult, annotateError,
} from '../agent/user-editing.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { wsClient } from './fake-ws-kit.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/* ------------------------------------------------------------------ Pure logic */

test('UE-S1 numbers: dragging / text editing expires after 15 s without renewal; "recently touched" lasts at most 30 s', () => {
  assert.equal(USER_EDITING_DEFAULTS.ttlMs, 15_000);
  assert.equal(USER_EDITING_DEFAULTS.recentMaxMs, 30_000);
});

test('UE-S2 recording and expiry: replaces this page\'s state as a whole; dragging is cleared after 15 s without renewal and kept if renewed; "recently touched" expires by the remaining milliseconds; malformed entries are skipped', () => {
  let t = 1_000_000;
  const b = createUserEditingBoard({ now: () => t });
  assert.equal(b.report('page-1', [
    { clipId: 'c1', kind: 'drag' },
    { clipId: 'c2', kind: 'recent', remainingMs: 8_000 },
    { clipId: 'c3', kind: 'recent' }, // No remaining milliseconds provided: skip
    { clipId: 'c4', kind: 'hover' }, // Unrecognized kind: skip
    { clipId: '', kind: 'text' },
    'x',
  ]), 2);
  assert.deepEqual(b.current().map((e) => [e.clipId, e.kind]), [['c1', 'drag'], ['c2', 'recent']]);
  t += 8_000;
  assert.deepEqual(b.current().map((e) => e.clipId), ['c1'], '"Recently touched" expires');
  t += 6_000;
  b.report('page-1', [{ clipId: 'c1', kind: 'drag' }]); // Heartbeat renewal
  t += 14_000;
  const kept = b.current();
  assert.deepEqual(kept.map((e) => e.clipId), ['c1'], 'Renewed ones are still there');
  assert.equal(kept[0].forMs, 28_000, 'forMs counts from the first report, renewal does not reset it');
  t += 1_000;
  assert.deepEqual(b.current(), [], '15 s without renewal, cleared (page closed or stuck)');
  b.report('page-1', [{ clipId: 'c5', kind: 'text' }]);
  b.report('page-1', []);
  assert.deepEqual(b.current(), [], 'Reporting empty withdraws everything');
  assert.throws(() => b.report('bad session!', []), /session/);
  assert.throws(() => b.report('page-1', {}), /array/);
});

test('UE-S3 aggregation: when several pages report the same clip, the strongest kind wins (dragging > text editing > recently touched); "recently touched" is capped at 30 s however long it is reported', () => {
  let t = 0;
  const b = createUserEditingBoard({ now: () => t });
  b.report('p1', [{ clipId: 'c1', kind: 'recent', remainingMs: 999_999 }, { clipId: 'c2', kind: 'text' }]);
  b.report('p2', [{ clipId: 'c1', kind: 'drag' }, { clipId: 'c2', kind: 'recent', remainingMs: 5_000 }]);
  assert.deepEqual(b.current().map((e) => [e.clipId, e.kind]), [['c1', 'drag'], ['c2', 'text']]);
  b.clear('p2');
  t = 29_999;
  assert.deepEqual(b.current().map((e) => e.clipId), ['c1']);
  t = 30_000;
  assert.deepEqual(b.current(), []);
});

test('UE-S4 which clips are touched: named in parameters, paths written to (including clips newly inserted by insert, and escaping), and reading the whole project counts as all', () => {
  assert.deepEqual(clipIdsOfArgs({ clipId: 'a', otherClipId: 'b', trackId: 't' }), ['a', 'b']);
  assert.deepEqual(clipIdsOfOps([
    { op: 'set', path: '/tracks/@t1/clips/@c1/opacity', value: 1 },
    { op: 'remove', path: '/tracks/@t1/clips/@c2' },
    { op: 'insert', path: '/tracks/@t2/clips', value: { id: 'c3' } },
    { op: 'set', path: '/tracks/@t1/clips/@x~1y/label', value: '' },
    { op: 'set', path: '/name', value: 'n' },
    '/tracks/@t1/clips/@c1',
  ]), ['c1', 'c2', 'c3', 'x/y']);
  const editing = [{ clipId: 'c1', kind: 'drag' }, { clipId: 'c2', kind: 'recent' }];
  assert.deepEqual(userEditingFor({ tool: 'get_clip', args: { clipId: 'c1' }, editing }), [{ clipId: 'c1', kind: 'drag' }]);
  assert.deepEqual(userEditingFor({ tool: 'get_clip', args: { clipId: 'c9' }, editing }), []);
  assert.deepEqual(userEditingFor({ tool: 'set_project_meta', args: {}, written: ['c2'], editing }), [{ clipId: 'c2', kind: 'recent' }], 'What was actually written to counts even when the args do not name it');
  assert.equal(userEditingFor({ tool: 'get_project', args: {}, editing }).length, 2, 'Reading the whole project');
  assert.equal(userEditingFor({ tool: 'get_layout', args: {}, editing }).length, 2);
  assert.equal(userEditingFor({ tool: 'get_layout', args: { clipId: 'c9' }, editing }).length, 0);
  assert.deepEqual(userEditingFor({ tool: 'get_project', args: {}, editing: [] }), []);
});

test('UE-S5 how the notice is worded and placed: for an object result the notice comes first and the fields are kept; an array is wrapped in one layer; with nothing to report the result is returned as is; an error gets one more sentence appended', () => {
  const ue = [{ clipId: 'c1', kind: 'drag' }, { clipId: 'c2', kind: 'text' }, { clipId: 'c3', kind: 'recent' }];
  assert.equal(userEditingNotice(ue).startsWith('User is editing clip c1 (dragging), clip c2 (editing text), clip c3 (just modified). This is a hint, not a prohibition'), true);
  const r = annotateResult({ ok: true, id: 'c1', rev: 3 }, { userEditing: ue.slice(0, 1) });
  assert.deepEqual(Object.keys(r), ['notice', 'userEditing', 'ok', 'id', 'rev']);
  assert.ok(r.notice.startsWith('User is editing clip c1 (dragging)'), r.notice);
  const plain = { ok: true };
  assert.equal(annotateResult(plain, { userEditing: [] }), plain, 'Returned as is when there is nothing to report (the same object)');
  const arr = annotateResult([1, 2], { userEditing: ue.slice(0, 1) });
  assert.deepEqual(arr.result, [1, 2]);
  assert.match(arr.notice, /User is editing/);
  // overwrote exists first (set by executor) then userEditing is appended (set by entry point):
  // both fields exist, both sentences exist
  const ov = [{ entity: '/tracks/@t1/clips/@c1', clipId: 'c1', by: 'user', who: 'User', label: 'User just edited', rev: 2, agoMs: 3000 }];
  const both = annotateResult(annotateResult({ ok: true }, { overwrote: ov }), { userEditing: ue.slice(0, 1) });
  assert.deepEqual(both.overwrote, ov);
  assert.deepEqual(both.userEditing, ue.slice(0, 1));
  assert.ok(both.notice.startsWith('User is editing clip c1'), both.notice);
  assert.ok(both.notice.includes('\nThis write overwrote content someone else just wrote: clip c1 (User just edited, rev 2, 3 s ago)'), both.notice);
  const err = annotateError(new Error('Rejected'), ue.slice(0, 1));
  assert.match(err.message, /^Rejected\nUser is editing clip c1/);
});

test('UE-S6 how the writer is labeled: local page = user; other members in a shared project carry a name; an Agent carries its chat id and vendor', () => {
  assert.deepEqual(writerOf({ role: 'page', userId: 'local', session: 'p' }), { by: 'user', who: 'User' });
  assert.equal(writerOf({ role: 'page', userId: 'bob' }).who, 'User bob');
  assert.equal(writerOf({ role: 'agent', conversation: 2, session: 'agent:conv-B' }).who, 'Agent conv-B');
  assert.equal(writerOf({ role: 'agent', conversation: 2, session: 'agent:conv-B' }, (k) => (k === 'conv-B' ? 'claude' : null)).who, 'Agent conv-B(claude)');
  assert.equal(writerOf({ role: 'agent', conversation: 5 }).who, 'Agent chat 5');
  const v = overwroteView([{ entity: '/tracks/@t1/clips/@c1', by: { role: 'page', userId: 'local' }, rev: 4, at: 1000 }, { entity: '/meta/name', by: { role: 'agent', session: 'agent:x' }, rev: 5, at: 2000 }], { now: 5000 });
  assert.deepEqual(v, [
    { entity: '/tracks/@t1/clips/@c1', clipId: 'c1', by: 'user', who: 'User', label: 'User just edited', rev: 4, agoMs: 4000 },
    { entity: '/meta/name', by: 'agent', who: 'Agent x', label: 'Agent x just edited', rev: 5, agoMs: 3000 },
  ]);
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
    const p = createEmptyProject('ue-test');
    p.id = projectId;
    p.tracks = [{ id: 't1', name: 'Visual', clips: [
      { id: 'c1', cardId: 'title', params: { text: 'One' }, start: 0, end: 3 },
      { id: 'c2', cardId: 'title', params: { text: 'Two' }, start: 3, end: 6 },
    ] }];
    const reply = await pg.commit([{ op: 'set', path: '', value: p }]);
    assert.equal(reply.type, 'project.op.ok', JSON.stringify(reply));
    return pg;
  }

  function side(projectId, board, agentLabel = null) {
    const s = createAgentSide({
      projectId,
      url,
      protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`],
      loadHost: () => loadSsrHost(load),
      tools,
      toolGroups,
      callPage: async () => { throw new Error('there is no page in this test'); },
      userEditing: () => board.current(),
      agentLabel,
    });
    closers.push(() => s.close());
    return s;
  }

  return { seeded, side };
}

test('UE-S7~S10 end to end: userEditing of the read / write tools; overwriting what the page wrote is labeled "user just edited", overwriting what another Agent wrote is labeled "Agent <identity> just edited"', async (t) => {
  const env = await startEnv(t);

  await t.test('UE-S7 read tools: when the user is dragging c1 and the Agent reads c1, the result carries userEditing and a notice; reading c2 does not', async () => {
    const pid = 'proj-ue-read';
    await env.seeded(pid);
    const board = createUserEditingBoard();
    board.report('page-x', [{ clipId: 'c1', kind: 'drag' }]);
    const s = env.side(pid, board);
    const r1 = await s.callTool('get_clip', { clipId: 'c1' }, { agent: 'conv-A' });
    assert.deepEqual(r1.userEditing, [{ clipId: 'c1', kind: 'drag' }]);
    assert.ok(r1.notice.startsWith('User is editing clip c1 (dragging). This is a hint, not a prohibition'), r1.notice);
    assert.equal(r1.rev, 1, 'The original fields stay as they were');
    const r2 = await s.callTool('get_clip', { clipId: 'c2' }, { agent: 'conv-A' });
    assert.equal(r2.userEditing, undefined);
    assert.equal(r2.notice, undefined);
    const whole = await s.callTool('get_project', {}, { agent: 'conv-A' });
    assert.deepEqual(whole.userEditing, [{ clipId: 'c1', kind: 'drag' }], 'Reading the whole project also gives the notice');
    assert.ok(Array.isArray(whole.tracks));
  });

  await t.test('UE-S8 write tools: the user just touched c2 (within 30 seconds of selecting it), the Agent\'s edit of c2 still lands (notice only, no blocking), and the result carries userEditing', async () => {
    const pid = 'proj-ue-write';
    await env.seeded(pid);
    const board = createUserEditingBoard();
    board.report('page-x', [{ clipId: 'c2', kind: 'recent', remainingMs: 20_000 }]);
    const s = env.side(pid, board);
    await s.callTool('get_project', {}, { agent: 'conv-A' });
    const w = await s.callTool('update_clip', { clipId: 'c2', opacity: 0.5 }, { agent: 'conv-A' });
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.equal(w.rev, 2, 'The write landed');
    assert.deepEqual(w.userEditing, [{ clipId: 'c2', kind: 'recent' }]);
    assert.ok(w.notice.startsWith('User is editing clip c2 (just modified)'), w.notice);
    assert.equal(w.notice.includes('This write overwrote'), false, 'The seed is written in full starting from an empty project, so it does not count as overwriting');
  });

  await t.test('UE-S9 overwrote (page write): the page just edited c1, then the Agent edits c1 again, and the result carries overwrote "user just edited"', async () => {
    const pid = 'proj-ue-ow-page';
    const pg = await env.seeded(pid);
    const board = createUserEditingBoard();
    const s = env.side(pid, board);
    const pageReply = await pg.commit([{ op: 'set', path: '/tracks/@t1/clips/@c1/label', value: 'Changed by the page' }]);
    assert.equal(pageReply.rev, 2);
    await s.callTool('get_project', {}, { agent: 'conv-A' });
    await s.link.replica.waitRev(2, 3000);
    await s.callTool('get_clip', { clipId: 'c1' }, { agent: 'conv-A' });
    const w = await s.callTool('update_clip', { clipId: 'c1', opacity: 0.3 }, { agent: 'conv-A' });
    assert.equal(w.rev, 3);
    assert.equal(w.overwrote.length, 1, JSON.stringify(w.overwrote));
    const o = w.overwrote[0];
    assert.deepEqual({ entity: o.entity, clipId: o.clipId, by: o.by, who: o.who, label: o.label, rev: o.rev },
      { entity: '/tracks/@t1/clips/@c1', clipId: 'c1', by: 'user', who: 'User', label: 'User just edited', rev: 2 });
    assert.ok(o.agoMs >= 0 && o.agoMs < 60_000);
    assert.match(w.notice, /^This write overwrote content someone else just wrote: clip c1 \(User just edited, rev 2, \d+ s ago\)\. Something the user just edited was overwritten by this write/);
    // The same chat immediately writes c1 again: previous writer was itself, no notification
    const again = await s.callTool('update_clip', { clipId: 'c1', opacity: 0.4 }, { agent: 'conv-A' });
    assert.equal(again.overwrote, undefined);
  });

  await t.test('UE-S10 overwrote (another Agent\'s write): conv-B just edited c2, then conv-A edits c2 again, and the result is labeled "Agent conv-B(claude) just edited"', async () => {
    const pid = 'proj-ue-ow-agent';
    await env.seeded(pid);
    const board = createUserEditingBoard();
    const s = env.side(pid, board, (key) => (key === 'conv-B' ? 'claude' : null));
    await s.callTool('get_project', {}, { agent: 'conv-A' });
    await s.callTool('get_project', {}, { agent: 'conv-B' });
    const b = await s.callTool('update_clip', { clipId: 'c2', opacity: 0.2 }, { agent: 'conv-B' });
    assert.equal(b.rev, 2);
    // conv-A read rev 1; reread before writing (otherwise stale)
    await s.callTool('get_clip', { clipId: 'c2' }, { agent: 'conv-A' });
    const a = await s.callTool('update_clip', { clipId: 'c2', opacity: 0.9 }, { agent: 'conv-A' });
    assert.equal(a.rev, 3);
    assert.equal(a.overwrote.length, 1);
    assert.deepEqual({ clipId: a.overwrote[0].clipId, by: a.overwrote[0].by, who: a.overwrote[0].who, label: a.overwrote[0].label, rev: a.overwrote[0].rev },
      { clipId: 'c2', by: 'agent', who: 'Agent conv-B(claude)', label: 'Agent conv-B(claude) just edited', rev: 2 });
    assert.match(a.notice, /Something another Agent just edited was overwritten by this write/);
  });
});

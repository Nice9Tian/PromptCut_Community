/**
 * Cloud Agent modifies clips in a parked cut in place without switching active cuts (production
 * 2026-10-21: each round switches over with switch_cut, edits, then switches back: one doomed
 * update_clip + two redundant writes, activeCutId is a shared field, so all members' UIs flip
 * together).
 *
 * Real document service + real executor (vite ssrLoadModule loads the page's tool implementations
 * and store), Agent side runs handlers via routing table:
 *   PK-1 update_clip edits clips in a parked cut: submitted only once, activeCutId and active
 *        cut kept as-is, response specifies which cut; real copy in document service matches
 *        Agent replica;
 *   PK-2 set_rect / get_clip / list_cuts({cutId}) likewise do not switch; subsequent writes to
 *        clips in active cut are not rejected (no stale);
 *   PK-3 Delete clips in a parked cut: explicit reason (which cut, requires switch_cut), submits
 *        nothing;
 *   PK-4 Model finds and edits clips in parked cuts solely by reading parkedCuts in get_project
 *        (cloud replica), no switch_cut throughout (production 2026-10-21: in new chats the model
 *        only saw active cut in get_project, so both times did switch_cut -> update_clip ->
 *        switch_cut);
 *   PK-5 list_cuts without args also lists clips in parked cuts; switch_cut response explains
 *        switching flips all members' UIs together.
 *
 * Run: node --test server/test/agent-parked-cut-edit.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createAgentLink } from '../agent/doc-link.mjs';
import { createAgentExecutor } from '../agent/agent-exec.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { waitFor } from './fake-ws-kit.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const toolDef = (name) => tools.find((t) => t.name === name);

async function startEnv(t) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/docservice`;
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const closers = [];
  t.after(async () => {
    for (const c of closers.reverse()) { try { c(); } catch { /* Closed */ } }
    await vite.close();
    await built.service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const load = (id) => vite.ssrLoadModule(id);
  const { createEmptyProject } = await load('/src/kernel/project.ts');

  /** A active: one c1(0~5) on t1; B parked: one cb1(0~4) on tb */
  function project(projectId) {
    const p = createEmptyProject('parked-test');
    p.id = projectId;
    p.duration = 5;
    p.tracks = [{ id: 't1', name: 'Visual', clips: [{ id: 'c1', cardId: 'probe', params: {}, start: 0, end: 5 }] }];
    p.cuts = [
      { id: 'cutA', name: 'Cut 1' },
      { id: 'cutB', name: 'Cut 2', duration: 4, transitions: [], tracks: [{ id: 'tb', name: 'Track B', clips: [{ id: 'cb1', cardId: 'probe', label: 'Particle background', params: {}, start: 0, end: 4 }] }] },
    ];
    p.activeCutId = 'cutA';
    return p;
  }

  async function raw(session) {
    const ws = new WebSocket(url);
    closers.push(() => ws.close());
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const inbox = [];
    ws.addEventListener('message', (e) => inbox.push(JSON.parse(e.data)));
    let seq = 0;
    const next = (match, ms = 3000) => waitFor(() => { const i = inbox.findIndex(match); return i >= 0 ? inbox.splice(i, 1)[0] : null; }, ms);
    return {
      async open(projectId) {
        ws.send(JSON.stringify({ type: 'project.open', projectId, reqId: `open-${++seq}` }));
        return next((m) => m.type === 'project.state');
      },
      async commit(projectId, ops) {
        const opId = `${session}-op-${++seq}`;
        ws.send(JSON.stringify({ type: 'project.op', projectId, opId, session, ops, reqId: opId }));
        return next((m) => m.reqId === opId);
      },
    };
  }

  async function seeded(projectId) {
    const r = await raw('seed');
    await r.open(projectId);
    const reply = await r.commit(projectId, [{ op: 'set', path: '', value: project(projectId) }]);
    assert.equal(reply.type, 'project.op.ok', JSON.stringify(reply));
    return r;
  }

  function agent(projectId) {
    const link = createAgentLink({ url, projectId, protocolsFor: (n) => ['promptcut.v1', `promptcut.role.agent.${n}`] });
    closers.push(() => link.close());
    const executor = createAgentExecutor({ link, loadHost: () => loadSsrHost(load), toolGroups });
    const call = (tool, args, key = 'conv-A') => executor.track(tool, args, key, (ctx) => executor.execute(tool, args, key, toolDef(tool), ctx));
    return { link, executor, call };
  }

  return { raw, seeded, agent };
}

const cutOf = (p, id) => p.cuts.find((c) => c.id === id);

test('PK-1 update_clip edits a clip in a parked cut: one commit, activeCutId and the active cut stay as they were, and the reply states which cut it is in', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-pk1');
  const ag = env.agent('proj-pk1');

  const before = (await ag.call('get_project', {}));
  const rev0 = before.rev;
  assert.equal(before.activeCutId, 'cutA');

  const r = await ag.call('update_clip', { clipId: 'cb1', opacity: 0.5, fadeIn: 0.3 });
  assert.equal(r.ok, true);
  assert.equal(r.rev, rev0 + 1, 'only one commit (it used to be three: switch_cut, update_clip, switch_cut)');
  assert.deepEqual(r.cut, { id: 'cutB', name: 'Cut 2', active: false });
  assert.equal(r.look?.args?.cutId, 'cutB', 'look carries cutId: to see its frames, pass cutId to see_frames, no switching needed (2026-10-21)');
  assert.deepEqual(r.timeline.tracks.map((x) => x.trackId), ['tb'], 'timeline is B\'s');

  const body = await probe.open('proj-pk1');
  assert.equal(body.rev, rev0 + 1);
  assert.equal(body.project.activeCutId, 'cutA', 'no switching');
  assert.deepEqual(body.project.tracks.map((x) => x.id), ['t1']);
  assert.equal(body.project.tracks[0].clips[0].opacity, undefined, 'the clip in the active cut is untouched');
  const clip = cutOf(body.project, 'cutB').tracks[0].clips[0];
  assert.deepEqual([clip.opacity, clip.fadeIn], [0.5, 0.3]);
  assert.equal(JSON.stringify(ag.link.replica.project), JSON.stringify(body.project), 'the Agent replica matches the authoritative copy item by item');
});

test('PK-2 get_clip / set_rect / list_cuts({cutId}) do not switch; a write to a clip in the active cut right after is not rejected', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-pk2');
  const ag = env.agent('proj-pk2');
  await ag.call('get_project', {});

  const listed = await ag.call('list_cuts', { cutId: 'cutB' });
  assert.deepEqual(listed.timeline.tracks.map((x) => [x.trackId, x.clips.map((c) => c.id)]), [['tb', ['cb1']]]);
  assert.equal(listed.activeCutId, 'cutA');

  const env1 = await ag.call('get_clip', { clipId: 'cb1' });
  assert.equal(env1.cut.id, 'cutB');
  assert.equal(env1.time.end, 4);

  const placed = await ag.call('set_rect', { clipId: 'cb1', x1: 100, y1: 100, x2: 400, y2: 300 });
  assert.equal(placed.cut.id, 'cutB');
  assert.ok(placed.layout.local, 'the rect was written');

  const second = await ag.call('update_clip', { clipId: 'c1', opacity: 0.4 });
  assert.equal(second.ok, true);
  assert.equal(ag.executor.describe().stats.stale, 0);

  const body = await probe.open('proj-pk2');
  assert.equal(body.project.activeCutId, 'cutA');
  assert.ok(cutOf(body.project, 'cutB').tracks[0].clips[0].frame, 'the clip in B has a rect');
  assert.equal(body.project.tracks[0].clips[0].opacity, 0.4, 'the clip in A was changed');
  assert.equal(cutOf(body.project, 'cutB').tracks[0].clips[0].opacity, undefined);
});

test('PK-3 deleting a clip in a parked cut: states which cut it is in and that switch_cut is required, and commits nothing', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-pk3');
  const ag = env.agent('proj-pk3');
  const rev0 = (await ag.call('get_project', {})).rev;
  await assert.rejects(() => ag.call('remove_clip', { clipId: 'cb1', force: true, reason: 'test' }), /it is in cut "Cut 2" \(cutB\).*switch_cut/);
  const body = await probe.open('proj-pk3');
  assert.equal(body.rev, rev0, 'no commit');
  assert.equal(cutOf(body.project, 'cutB').tracks[0].clips.length, 1);
});

test('PK-4 the model finds and fixes a clip in a parked cut by reading only parkedCuts from get_project, with no switch_cut at all', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-pk4');
  const ag = env.agent('proj-pk4');
  /** A "model" acting on tool responses: does not know clipId, can only look by reading get_project responses; only thinks of switch_cut when not found (production behavior) */
  const called = [];
  const run = (tool, args) => { called.push(tool); return ag.call(tool, args); };

  const project = await run('get_project', {});
  assert.equal(Object.keys(project)[0], 'parkedCuts', 'the index comes first');
  assert.deepEqual(project.parkedCuts.cuts.map((c) => c.cutId), ['cutB']);
  assert.deepEqual(project.parkedCuts.cuts[0].clips, [{ id: 'cb1', trackId: 'tb', cardId: 'probe', label: 'Particle background', start: 0, end: 4 }]);
  assert.match(project.parkedCuts.note, /do not use user_interface_switch_cut/);
  assert.deepEqual(project.tracks.map((x) => x.id), ['t1'], 'tracks is still the active cut\'s');

  const hit = project.parkedCuts.cuts.find((c) => c.name === 'Cut 2')?.clips.find((c) => c.label === 'Particle background');
  assert.ok(hit, 'found in parkedCuts, no need to switch just to look into Cut 2');
  const r = await run('update_clip', { clipId: hit.id, opacity: 0.25 });
  assert.equal(r.ok, true);
  assert.equal(r.rev, project.rev + 1, 'only one commit');
  assert.deepEqual(called, ['get_project', 'update_clip'], 'no switch_cut');

  const body = await probe.open('proj-pk4');
  assert.equal(body.project.activeCutId, 'cutA', 'activeCutId unchanged (other members\' views do not flip)');
  assert.equal(cutOf(body.project, 'cutB').tracks[0].clips[0].opacity, 0.25);
  assert.equal(body.project.tracks[0].clips[0].opacity, undefined);
});

test('PK-5 list_cuts without parameters also lists the clips of parked cuts; the reply of switch_cut explains that switching makes all members\' views flip together', async (t) => {
  const env = await startEnv(t);
  const probe = await env.seeded('proj-pk5');
  const ag = env.agent('proj-pk5');
  await ag.call('get_project', {});

  const listed = await ag.call('list_cuts', {});
  assert.deepEqual(listed.parkedCuts.cuts.map((c) => [c.cutId, c.clips.map((x) => x.id)]), [['cutB', ['cb1']]]);
  assert.equal('timeline' in listed, false);

  const edited = await ag.call('update_clip', { clipId: 'c1', opacity: 0.4 });
  assert.deepEqual(edited.timeline.otherCuts.cuts, [{ cutId: 'cutB', name: 'Cut 2', clipCount: 1 }], 'the reply timeline of the active cut hints that other cuts have clips');

  const sw = await ag.call('switch_cut', { cutId: 'cutB' });
  assert.equal(sw.activeCutId, 'cutB');
  assert.match(sw.note, /flips every member's interface together/);
  assert.match(sw.note, /it is not needed/);
  const body = await probe.open('proj-pk5');
  assert.equal(body.project.activeCutId, 'cutB', 'switching still works when the user explicitly asks to switch');
});

/**
 * Three items decided (user decision, 2026-10-21) (`docs/plan/user-decisions-2026-10-21.md`
 * Section 2.2, Section 3; report `docs/reports/AGENT-cut-look-ui.md`):
 *
 *   CL-1  `cutLookView`: returns as is if cutId is omitted (currently active); if given a parked
 *         cut id, switches to a view with "that cut as active" while original project remains
 *         untouched; reports a clear error if id does not exist
 *   CL-2  Agent server executor (see_frames in `agent-exec.mjs`, used for both local bound project
 *         replica / cloud hosted tier): when cutId is provided, what is passed to render is that
 *         cut's view, omitted t takes that cut's last paused playhead, `cutLook` token is passed to
 *         frame generation side; proceeds as usual without cutId; errors if id does not exist;
 *         no commit throughout, replica unchanged
 *   CL-3  Mirrored path when replica is not bound (runMirroredTool in `instance.mjs`): same as
 *         above
 *   CL-4  Frame generation in account mode (prerenderPost in `account-runner.mjs`): during `cutLook`,
 *         does not query member devices, directly hands off to hosted render service (request body
 *         is the view)
 *   CL-5  Tool renaming: model manifest contains only new names, old names absent; entry points
 *         accept both new and old; SSE `call` sent to page uses old internal operation name;
 *         routing table and page executor accept new names; reverse channel provider accepts new
 *         names, `tool` sent to page remains old name
 *   CL-6  add_cut only creates without switching; set_cut_segment no longer accepts cutId (tool
 *         description); PAGE_STATE_TOOLS / CLOUD_PLAYHEAD_TOOLS updated accordingly
 *
 * Run: npm test -- server/test/cut-look-ui.test.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cutLookView } from '../../src/kernel/agentScopes.mjs';
import { createAgentExecutor, PAGE_STATE_TOOLS, seeFramesView } from '../agent/agent-exec.mjs';
import { tools } from '../mcp-tools.mjs';
import { UI_TOOL_RENAMES, modelToolName, pageToolName, isUserInterfaceTool } from '../tools/ui-names.mjs';
import { TOOL_ROUTES, SPECIAL_TOOLS } from '../../src/mcp/routes.mjs';
import { CLOUD_TOOL_PLAN, CLOUD_OPEN_TOOLS, CLOUD_PLAYHEAD_TOOLS, CLOUD_PAGE_TOOLS, checkCloudTool } from '../agent/service/cloud-tools.mjs';
import { PAGE_BRIDGE_TOOLS, PAGE_CONTROL_TOOL_NAMES, createPageControlTools } from '../agent/service/page-bridge.mjs';
import { HANDOFF_TOOL_NAMES } from '../agent/service/hosted-handoff.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Cut 1 (active, red card) + Cut 2 (parked, blue card, last stopped at 1.5 seconds) */
function project() {
  return {
    version: 1, id: 'p-look', name: 'look', width: 640, height: 360, fps: 30, duration: 4, themeId: 'midnight', media: [],
    tracks: [{ id: 't1', name: 'Track 1', clips: [{ id: 'red', cardId: 'solid', params: { color: '#ff0000' }, start: 0, end: 4 }] }],
    cuts: [
      { id: 'cut-1', name: 'Cut 1' },
      { id: 'cut-2', name: 'Cut 2', t: 1.5, duration: 6, transitions: [], tracks: [{ id: 't2', name: 'Track 1', clips: [{ id: 'blue', cardId: 'solid', params: { color: '#0000ff' }, start: 0, end: 6 }] }] },
    ],
    activeCutId: 'cut-1',
  };
}
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

test('CL-1 cutLookView: without cutId it returns as is; with a parked cut it swaps the view and leaves the original project untouched; a nonexistent one gives a clear error', () => {
  const p = deepFreeze(project());
  const same = cutLookView(p, undefined);
  assert.equal(same.project, p);
  assert.deepEqual([same.active, same.cut, same.parkedT], [true, { id: 'cut-1', name: 'Cut 1' }, null]);
  assert.equal(cutLookView(p, 'cut-1').project, p, 'Passing the currently active id also returns as is');
  assert.equal(cutLookView(p, '').project, p, 'An empty string counts as not passed');
  const v = cutLookView(p, 'cut-2');
  assert.equal(v.active, false);
  assert.deepEqual(v.cut, { id: 'cut-2', name: 'Cut 2' });
  assert.equal(v.parkedT, 1.5);
  assert.equal(v.project.activeCutId, 'cut-2');
  assert.equal(v.project.tracks, p.cuts[1].tracks, 'The view\'s tracks are those of cut 2');
  assert.equal(v.project.duration, 6);
  const entry1 = v.project.cuts.find((c) => c.id === 'cut-1');
  assert.equal(entry1.tracks, p.tracks, 'Cut 1 falls back to an entry that carries its own content (cut segment references resolve as usual)');
  const entry2 = v.project.cuts.find((c) => c.id === 'cut-2');
  assert.equal('tracks' in entry2 || 't' in entry2, false, 'The entry of the active one carries no content');
  assert.equal(p.activeCutId, 'cut-1', 'The original project was not modified');
  assert.throws(() => cutLookView(p, 'cut-9'), (e) => e.code === 'cut-not-found' && /Cut "cut-9" not found/.test(e.message) && /Cut 2\(cut-2\)/.test(e.message));
  assert.throws(() => seeFramesView(p, 3), /cutId must be a string/);
  // Legacy project (no cuts): only Cut 1
  const old = { ...project(), cuts: undefined, activeCutId: undefined };
  assert.deepEqual(cutLookView(old).cut, { id: 'cut-1', name: 'Cut 1' });
  assert.throws(() => cutLookView(old, 'cut-2'), /Cut "cut-2" not found/);
});

/** Minimal project replica required by executor (the few items used by read-only tools) */
function fakeLink(p, rev = 7) {
  const replica = { hasBody: true, project: p, rev, waitRev: async () => true, offer() { throw new Error('A read tool must not commit'); } };
  return {
    projectId: 'p-look', replica,
    ready: async () => {},
    conversation: () => ({ request: async () => { throw new Error('A read tool must not send requests to the document service'); } }),
  };
}

test('CL-2 executor see_frames: with cutId it renders the view of that cut without committing; without it behaves as before; a nonexistent id gives an error', async () => {
  const p = deepFreeze(project());
  const posts = [];
  const exec = createAgentExecutor({
    link: fakeLink(p), loadHost: async () => { throw new Error('see_frames must not enter host'); }, playhead: () => 3,
    prerenderPost: async (path, body, opts) => {
      posts.push({ path, body, opts });
      if (path === '/api/vision/snapshot') return { ok: true, t: body.t ?? null, __image: { mime: 'image/png', base64: 'AAAA' } };
      return { ok: true, visualId: 'v1' };
    },
  });
  const def = tools.find((t) => t.name === 'see_frames');
  assert.ok(def.inputSchema.properties.cutId, 'The description of see_frames includes cutId');

  const r2 = await exec.execute('see_frames', { source: 'timeline', cutId: 'cut-2' }, 'a1', def);
  const snap2 = posts.find((x) => x.path === '/api/vision/snapshot');
  assert.equal(snap2.body.project.activeCutId, 'cut-2', 'What is handed to the renderer is the view with cut 2 as the active one');
  assert.equal(snap2.body.project.tracks[0].clips[0].id, 'blue');
  assert.equal(snap2.body.t, 1.5, 'Without t, it takes the position where cut 2 last stopped, not the page playhead');
  assert.equal('cutId' in snap2.body, false, 'The request body carries no cutId: the old render process only recognizes project and still renders correctly');
  assert.equal(snap2.opts.cutLook, true, 'The rendering side knows this is a look at another cut (account mode uses this to avoid asking member devices)');
  assert.deepEqual(r2.cut, { id: 'cut-2', name: 'Cut 2' }, 'The reply states which cut is being looked at');
  assert.equal(r2.rev, 7);
  assert.equal(p.activeCutId, 'cut-1');

  posts.length = 0;
  const r2t = await exec.execute('see_frames', { source: 'timeline', cutId: 'cut-2', times: [0.5, 2] }, 'a1', def);
  assert.deepEqual(posts[0].body.times, [0.5, 2]);
  assert.equal(posts[0].body.project.activeCutId, 'cut-2');
  assert.deepEqual(r2t.cut, { id: 'cut-2', name: 'Cut 2' });

  posts.length = 0;
  const r1 = await exec.execute('see_frames', { source: 'timeline' }, 'a1', def);
  const snap1 = posts.find((x) => x.path === '/api/vision/snapshot');
  assert.equal(snap1.body.project, p, 'No cutId: the original project is handed over as is');
  assert.equal(snap1.body.t, 3, 'No cutId: the page playhead');
  assert.equal(snap1.opts.cutLook, undefined);
  assert.deepEqual(r1.cut, { id: 'cut-1', name: 'Cut 1' });

  posts.length = 0;
  await assert.rejects(() => exec.execute('see_frames', { source: 'timeline', cutId: 'nope' }, 'a1', def), /Cut "nope" not found/);
  assert.equal(posts.length, 0, 'Nothing is rendered when the id does not exist');
});

/** Minimal host for instance.mjs: registered routes collected into map, does not start HTTP */
async function makeInstance(env = {}) {
  const { createAgentInstance } = await import('../agent/service/instance.mjs');
  const routes = new Map();
  const inst = createAgentInstance({
    server: { httpServer: null, ssrLoadModule: async () => { throw new Error('This test case does not load frontend code'); }, config: { root: ROOT }, middlewares: { use: (route, handler) => routes.set(route, handler) } },
    prerenderPost: async () => null, latestMirror: () => null, latestPlayhead: () => null,
    ...env,
  });
  return { inst, routes };
}

test('CL-3 the mirror path (no replica bound): with cutId it renders the view of that cut; without it behaves as before', async (t) => {
  const p = deepFreeze(project());
  const posts = [];
  const { inst } = await makeInstance({
    latestMirror: () => ({ project: p }), latestPlayhead: () => ({ t: 2.25 }),
    prerenderPost: async (path, body) => { posts.push({ path, body }); return path === '/api/vision/snapshot' ? { ok: true, t: body.t } : { ok: false }; },
  });
  t.after(() => inst.close?.());
  const r = await inst.callTool('see_frames', { source: 'timeline', cutId: 'cut-2' }, 'a1');
  assert.equal(posts[0].body.project.activeCutId, 'cut-2');
  assert.equal(posts[0].body.t, 1.5);
  assert.deepEqual(r.cut, { id: 'cut-2', name: 'Cut 2' });
  const r1 = await inst.callTool('see_frames', { source: 'timeline', t: 1 }, 'a1');
  assert.equal(posts[1].body.project, p);
  assert.equal(posts[1].body.t, 1);
  assert.deepEqual(r1.cut, { id: 'cut-1', name: 'Cut 1' });
  await assert.rejects(() => inst.callTool('see_frames', { source: 'timeline', cutId: 'zz' }, 'a1'), /Cut "zz" not found/);
});

// Reads closed-source cloud/agent/account-runner.mjs; community edition has no cloud/, skips this test
test('CL-4 account mode rendering: with cutLook it does not ask member devices and hands off directly to the hosted render service', { skip: (await import('node:fs')).existsSync(new URL('../../cloud', import.meta.url)) ? false : 'The current checkout has no cloud/ directory (community edition)' }, async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('../../cloud/agent/account-runner.mjs', import.meta.url), 'utf8');
  assert.match(text, /opts\?\.cutLook !== true && typeof toolset\?\.pageBridge\?\.call === 'function'/, 'memberNodes is left empty when cutLook');
  // Scheduling itself: handed off to hosted render when there are no member nodes, request body
  // as is (which is the view)
  const { dispatchFrameSnapshot } = await import('../agent/service/frame-dispatcher.mjs');
  const view = cutLookView(project(), 'cut-2').project;
  let got = null;
  const out = await dispatchFrameSnapshot({
    memberNodes: [], cloudLook: async () => { got = view; return { ok: true }; },
    callLocal: async () => { throw new Error('Must not ask member devices'); },
    request: { path: '/api/vision/snapshot', body: { project: view, t: 1.5 } },
  });
  assert.equal(out.source, 'hosted-render');
  assert.equal(got.activeCutId, 'cut-2');
});

test('CL-5 tool rename: the manifest has only the new name; the entry point accepts both old and new; the page receives the old internal operation name; the route table and provider recognize the new name', async (t) => {
  const names = new Set(tools.map((x) => x.name));
  for (const [oldName, newName] of Object.entries(UI_TOOL_RENAMES)) {
    assert.ok(names.has(newName), `${newName} is in the manifest`);
    assert.equal(names.has(oldName), false, `Old name ${oldName} is not in the manifest handed to the model`);
    assert.match(newName, /^[a-zA-Z0-9_-]{1,64}$/, 'Names on the model side may only be letters, digits, underscores and hyphens');
    assert.equal(modelToolName(oldName), newName);
    assert.equal(pageToolName(newName), oldName);
    assert.ok(isUserInterfaceTool(oldName) && isUserInterfaceTool(newName));
  }
  assert.equal(modelToolName('add_clip'), 'add_clip');
  assert.equal(pageToolName('add_clip'), 'add_clip');
  // Tools that do not modify UI have no prefix in their names
  for (const n of names) if (n.startsWith('user_interface_')) assert.ok(isUserInterfaceTool(n), `${n} is registered in ui-names.mjs`);
  // Routing table / special branches accept new names
  for (const n of ['user_interface_switch_cut', 'user_interface_seek', 'user_interface_play', 'user_interface_pause', 'user_interface_collect_login']) assert.ok(TOOL_ROUTES[n], n);
  assert.ok(SPECIAL_TOOLS.includes('user_interface_web_handoff'));
  for (const n of ['switch_cut', 'seek', 'play', 'pause', 'collect_login']) assert.equal(Object.hasOwn(TOOL_ROUTES, n), false);
  // Cloud tool table accepts new names; reverse channel still sends old names to the page
  for (const n of Object.values(UI_TOOL_RENAMES)) assert.ok(CLOUD_TOOL_PLAN[n], `${n} is in the cloud tool table`);
  for (const n of Object.keys(UI_TOOL_RENAMES)) assert.equal(Object.hasOwn(CLOUD_TOOL_PLAN, n), false, `The old name ${n} is not in the cloud tool table`);
  assert.ok(CLOUD_OPEN_TOOLS.has('user_interface_switch_cut'));
  assert.deepEqual([...CLOUD_PAGE_TOOLS].sort(), ['get_selection', 'user_interface_pause', 'user_interface_play', 'user_interface_seek']);
  assert.deepEqual([...PAGE_BRIDGE_TOOLS], ['seek', 'play', 'pause', 'web_handoff'], 'The internal operation names sent to the page are unchanged (the 0.7.18 page recognizes these)');
  assert.deepEqual([...PAGE_CONTROL_TOOL_NAMES], ['user_interface_seek', 'user_interface_play', 'user_interface_pause']);
  assert.deepEqual([...HANDOFF_TOOL_NAMES], ['user_interface_web_handoff']);
  assert.equal(checkCloudTool('user_interface_seek').ok, true);

  // Reverse channel provider: accepts new names (and old names), tool sent to the page is old name
  const sent = [];
  const control = createPageControlTools({
    bridge: { limits: { pageMs: 15_000 }, initiator: async () => ({ initiatorAccountId: 'acc', pageId: 'pg-1' }),
      requestPage: async (req) => { sent.push(req); return { delivered: true, answer: { ok: true, result: { ok: true } } }; } },
    newRequestId: () => 'req-0000000001',
  });
  await control.call('user_interface_seek', { t: 2 }, { projectId: 'p' });
  await control.call('pause', {}, { projectId: 'p' });
  assert.deepEqual(sent.map((r) => [r.tool, r.args]), [['seek', { t: 2 }], ['pause', {}]]);
  const bad = await control.call('user_interface_seek', {}, { projectId: 'p' });
  assert.match(bad.error, /user_interface_seek needs t/);

  // Local: SSE call sent to the page uses old name; entry points accept both new and old names
  const { inst, routes } = await makeInstance();
  t.after(() => inst.close?.());
  const writes = [];
  const req = new EventEmitter();
  req.method = 'GET';
  const res = { writeHead() {}, flushHeaders() {}, end() {}, write: (chunk) => { writes.push(String(chunk)); return true; } };
  routes.get('/api/mcp/events')(req, res);
  const answer = async () => {
    for (let i = 0; i < 50; i++) {
      const call = writes.map((w) => { try { return JSON.parse(w.replace(/^data: /, '')); } catch { return null; } }).find((m) => m?.type === 'call' && !m.answered);
      if (call) {
        call.answered = true;
        writes.length = 0;
        const rq = new EventEmitter();
        rq.method = 'POST';
        const rs = { statusCode: 0, setHeader() {}, writeHead() {}, end() {} };
        routes.get('/api/mcp/result')(rq, rs);
        rq.emit('data', JSON.stringify({ id: call.id, ok: true, result: { ok: true, echoed: call.tool } }));
        rq.emit('end');
        return call;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('The page did not receive the call');
  };
  for (const [asked, wire] of [['user_interface_seek', 'seek'], ['seek', 'seek'], ['user_interface_play', 'play'], ['user_interface_web_handoff', 'web_handoff']]) {
    const pending = inst.callTool(asked, asked.endsWith('seek') ? { t: 1 } : {}, 'a1');
    const call = await answer();
    const out = await pending;
    assert.equal(call.tool, wire, `${asked} sends the old internal operation name ${wire} to the page`);
    assert.equal(out.echoed, wire);
  }
});

test('CL-6 add_cut only creates and does not switch; set_cut_segment does not accept cutId; the playhead table for switching cuts is updated accordingly', () => {
  const addCut = tools.find((t) => t.name === 'add_cut');
  assert.equal('switch' in addCut.inputSchema.properties, false, 'add_cut drops the switch parameter');
  assert.match(addCut.description, /Create only, no switch/);
  const setSeg = tools.find((t) => t.name === 'set_cut_segment');
  assert.deepEqual(Object.keys(setSeg.inputSchema.properties).sort(), ['clipId', 'cutOffset']);
  assert.match(setSeg.description, /Which cut a cut segment references cannot be changed/);
  assert.deepEqual(Object.keys(PAGE_STATE_TOOLS).sort(), ['attach_clip_motion', 'remove_cut', 'user_interface_switch_cut']);
  assert.deepEqual([...CLOUD_PLAYHEAD_TOOLS].sort(), ['remove_cut', 'user_interface_switch_cut']);
  const switchCut = tools.find((t) => t.name === 'user_interface_switch_cut');
  assert.match(switchCut.description, /Acts on the user's interface/);
  assert.match(switchCut.description, /pass cutId to see_frames/);
});

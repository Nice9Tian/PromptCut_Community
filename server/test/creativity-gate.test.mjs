/**
 * Plan agent-workflow-plan.md A1: creativity level and closing the set_project_meta loophole.
 *
 * Test cases CR-1-CR-10:
 *   CR-1 Page side: set_project_meta with undeclared fields via routing table (used by page
 *        mcpExecutor) is entirely rejected; project object remains unchanged;
 *   CR-2 Two manifests match: SET_PROJECT_META_FIELDS in implementation layer matches tool
 *        schema properties;
 *   CR-3 Server side: Agent server executor (runRoute in agent-exec) executing set_project_meta
 *        with undeclared fields is rejected and does not commit; commits as usual with only
 *        declared fields;
 *   CR-4 Creativity level field cannot be written (rejected on page side, server side, and entry);
 *   CR-5 Strict check at entry (strict-args used by callToolInternal): governs only
 *        set_project_meta, other tools unaffected;
 *   CR-6 Three tiers × comparison table: low tier create_card rejected, medium tier can modify
 *        code (edit_card, modify existing effects) but cannot create new, high tier allows all;
 *   CR-7 create_card determined by card existence: user card with same name already exists
 *        (rewrite entire card) = medium, does not exist = high; invalid id does not query
 *        filesystem;
 *   CR-8 Rejection error states current level, required level, and how to adjust;
 *   CR-9 Session registry: chat override takes precedence over project default; follows project
 *        without override; unregistered / headless instance = desktop app session follows project;
 *   CR-10 Legacy projects with missing field default to "high"; unrecognized values default to
 *        "high";
 *   CR-11 Custom measurement measure_audio_js (plan A6) allowed only on "high"; low and medium
 *        tiers return unified out-of-tier error, built-in measure_audio allowed on all three
 *        tiers.
 *
 * Run: node --test server/test/creativity-gate.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { tools, toolGroups } from '../mcp-tools.mjs';
import { createAgentExecutor } from '../agent/agent-exec.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { checkCreativity, requiredCreativity, TOOL_CREATIVITY } from '../agent/creativity-gate.mjs';
import { createAgentSessions } from '../agent/agent-sessions.mjs';
import { undeclaredArgs, undeclaredArgsError } from '../agent/strict-args.mjs';
import { projectCreativity, effectiveCreativity, normalizeCreativity, creativityAllows, CREATIVITY_LEVELS } from '../../src/kernel/creativity.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const toolDef = (name) => tools.find((t) => t.name === name);

let vitePromise = null;
function vite() {
  vitePromise ??= createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  return vitePromise;
}
test.after(async () => { if (vitePromise) await (await vitePromise).close(); });

const baseProject = () => ({
  version: 1, id: 'p-cr', name: 'Old name', width: 1920, height: 1080, fps: 30, duration: 10, themeId: 'midnight',
  media: [], tracks: [{ id: 't1', name: 'Track 1', clips: [] }],
});

/* ------------------------------------------------------------------ CR-1 / CR-2 / CR-4 Page side */

test('CR-1 page side: set_project_meta with undeclared fields via the route table is rejected as a whole and the project object is unchanged (keys like tracks and media cannot be written through it)', async () => {
  const v = await vite();
  const load = (id) => v.ssrLoadModule(id);
  const host = await loadSsrHost(load);
  const core = await load('/src/store/core.ts');
  const before = baseProject();
  host.setProject(before);
  // Page mcpExecutor uses this routing table → editorApi (same implementation as Agent server)
  await assert.rejects(() => host.callRoute('set_project_meta', { name: 'New name', tracks: [] }), (err) => {
    assert.match(err.message, /does not accept these fields: tracks/);
    assert.match(err.message, /This call was not executed at all/);
    return true;
  });
  assert.equal(core.getState().project, before, 'The project object must not be replaced when rejected');
  assert.equal(core.getState().project.name, 'Old name', 'Fields declared in the same call are not written either');
  await assert.rejects(() => host.callRoute('set_project_meta', { media: [{ id: 'x' }], fooBar: 1 }), /media, fooBar/);
  // Declared fields as usual
  const out = await host.callRoute('set_project_meta', { name: 'New name', fps: 25 });
  assert.equal(out.ok, true);
  assert.equal(core.getState().project.name, 'New name');
  assert.equal(core.getState().project.fps, 25);
});

test('CR-2 SET_PROJECT_META_FIELDS in the implementation layer matches the properties of the tool schema', async () => {
  const v = await vite();
  const mod = await v.ssrLoadModule('/src/mcp/handlers/project.ts');
  const schemaKeys = Object.keys(toolDef('set_project_meta').inputSchema.properties).sort();
  assert.deepEqual([...mod.SET_PROJECT_META_FIELDS].sort(), schemaKeys);
  assert.ok(!schemaKeys.includes('creativity'), 'The schema must not declare the creativity level');
});

test('CR-4a page side: the creativity level field cannot be written', async () => {
  const v = await vite();
  const load = (id) => v.ssrLoadModule(id);
  const host = await loadSsrHost(load);
  const core = await load('/src/store/core.ts');
  const before = { ...baseProject(), creativity: 'low' };
  host.setProject(before);
  await assert.rejects(() => host.callRoute('set_project_meta', { creativity: 'high' }), (err) => {
    assert.match(err.message, /creativity/);
    assert.match(err.message, /Agent cannot write/);
    return true;
  });
  assert.equal(core.getState().project.creativity, 'low');
  assert.equal(core.getState().project, before);
});

/* ------------------------------------------------------------------ CR-3 / CR-4 Server side */

/** Mock document service connection: replica is a project; commits are recorded and persisted */
function fakeLink(project) {
  const commits = [];
  const replica = { project, rev: 1, hasBody: true, waitRev: async () => {}, offer: (rev) => { replica.rev = rev; } };
  return {
    commits,
    link: {
      projectId: 'p-cr', replica,
      ready: async () => {},
      conversation: () => ({
        request: async (msg) => { commits.push(msg); return { type: 'project.op.ok', rev: replica.rev + 1 }; },
      }),
    },
  };
}

test('CR-3 server side: the executor rejects set_project_meta with undeclared fields without committing; with only declared fields it commits as usual', async () => {
  const v = await vite();
  const load = (id) => v.ssrLoadModule(id);
  const { link, commits } = fakeLink(baseProject());
  const executor = createAgentExecutor({ link, loadHost: () => loadSsrHost(load), toolGroups });
  const def = toolDef('set_project_meta');
  await assert.rejects(() => executor.execute('set_project_meta', { name: 'x', cuts: [] }, 'conv-A', def, {}), /does not accept these fields: cuts/);
  assert.equal(commits.length, 0, 'A rejected call must not commit');
  await executor.execute('set_project_meta', { name: 'Renamed on server' }, 'conv-A', def, {});
  assert.equal(commits.length, 1);
  assert.ok(commits[0].ops.some((op) => op.path === 'name' || String(op.path).endsWith('name')), JSON.stringify(commits[0].ops));
});

test('CR-4b server side: the creativity level field cannot be written (no commit)', async () => {
  const v = await vite();
  const load = (id) => v.ssrLoadModule(id);
  const { link, commits } = fakeLink({ ...baseProject(), creativity: 'low' });
  const executor = createAgentExecutor({ link, loadHost: () => loadSsrHost(load), toolGroups });
  await assert.rejects(() => executor.execute('set_project_meta', { creativity: 'high' }, 'conv-A', toolDef('set_project_meta'), {}), /Agent cannot write/);
  await assert.rejects(() => executor.execute('set_project_meta', { name: 'y', creativity: 'high' }, 'conv-A', toolDef('set_project_meta'), {}), /creativity/);
  assert.equal(commits.length, 0);
  assert.equal(link.replica.project.creativity, 'low');
});

/* ------------------------------------------------------------------ CR-5 Entry */

test('CR-5 the strict check at the entry point only covers set_project_meta; CR-4c the entry point also rejects the creativity level', () => {
  const def = toolDef('set_project_meta');
  assert.deepEqual(undeclaredArgs('set_project_meta', def, { name: 'a', width: 1, height: 2, fps: 30, duration: 3, themeId: 'x' }), []);
  assert.deepEqual(undeclaredArgs('set_project_meta', def, { name: 'a', creativity: 'high', tracks: [] }), ['creativity', 'tracks']);
  assert.deepEqual(undeclaredArgs('set_project_meta', def, undefined), []);
  assert.deepEqual(undeclaredArgs('set_project_meta', def, [1]), ['(arguments are not an object)']);
  // Other tools with extra arguments are not handled here
  assert.deepEqual(undeclaredArgs('add_clip', toolDef('add_clip'), { cardId: 'x', start: 0, extra: 1 }), []);
  const msg = undeclaredArgsError('set_project_meta', def, ['creativity']);
  assert.match(msg, /does not accept these fields: creativity/);
  assert.match(msg, /Agent cannot write/);
  assert.match(msg, /name, width, height, fps, duration, themeId/);
});

/* ------------------------------------------------------------------ CR-6 / CR-7 / CR-8 Comparison table */

const exists = (ids) => ({ cardExists: (id) => ids.includes(id) });

test('CR-6 three tiers × lookup table', () => {
  const ctx = exists(['my-card']);
  /** [tool, args, low, medium, high] whether pass is expected */
  const table = [
    ['create_card', { id: 'new-card', source: 'x' }, false, false, true],
    ['create_card', { id: 'my-card', source: 'x', overwrite: true }, false, true, true],
    ['edit_card', { cardId: 'title-card', find: 'a', replace: 'b' }, false, true, true],
    ['create_filter', { name: 'f', ops: [] }, false, false, true],
    ['create_pixel_map', { name: 'p' }, false, false, true],
    ['create_audio_fx', { name: 'a', ops: [] }, false, false, true],
    ['update_filter', { filterId: 'f1', ops: [{ kind: 'brightness', value: '1+0.1*sin(t)' }] }, false, true, true],
    ['update_pixel_map', { pixelMapId: 'm1', where: 'g-r' }, false, true, true],
    ['update_audio_fx', { fxId: 'x1', params: { amount: { default: -6 } } }, false, true, true],
    ['update_filter', { filterId: 'f1', name: 'Renamed' }, true, true, true],
    ['update_audio_fx', { fxId: 'x1', description: 'notes' }, true, true, true],
    ['apply_card', { cardId: 'title-card', clipId: 'c1', params: { text: 'hi' } }, true, true, true],
    ['apply_filter', { clipId: 'c1', filterId: 'f1', params: { amount: 0.2 } }, true, true, true],
    ['add_clip', { cardId: 'title-card', start: 0 }, true, true, true],
    ['update_clip', { clipId: 'c1', params: { text: 'x' } }, true, true, true],
    ['add_part', { clipId: 'c1', partId: 'text' }, true, true, true],
    ['measure_audio', { clipId: 'c1' }, true, true, true],
    ['measure_audio_js', { clipId: 'c1', code: 'return 1' }, false, false, true],
    ['get_project', {}, true, true, true],
  ];
  for (const [tool, args, low, medium, high] of table) {
    assert.equal(checkCreativity(tool, args, 'low', ctx).ok, low, `${tool} ${JSON.stringify(args)} @low`);
    assert.equal(checkCreativity(tool, args, 'medium', ctx).ok, medium, `${tool} ${JSON.stringify(args)} @medium`);
    assert.equal(checkCreativity(tool, args, 'high', ctx).ok, high, `${tool} ${JSON.stringify(args)} @high`);
  }
  // High tier allows all: every tool on the manifest
  for (const t of tools) assert.equal(checkCreativity(t.name, {}, 'high', ctx).ok, true, `${t.name} @high`);
  // Tools in the table actually exist (comparison table will not silently break on rename)
  for (const name of Object.keys(TOOL_CREATIVITY)) assert.ok(toolDef(name), `${name} in the lookup table is not an existing tool`);
});

test('CR-7 create_card: rewriting an existing card in full = medium, creating a new one = high; an invalid id does not query the file system', () => {
  let asked = 0;
  const ctx = { cardExists: (id) => { asked += 1; return id === 'mine'; } };
  assert.equal(requiredCreativity('create_card', { id: 'mine', overwrite: true }, ctx).level, 'medium');
  // Without overwrite when encountering an existing card: implementation returns 409 pointing to
  // edit_card; counted as "modify existing" (medium tier) here so medium tier gets the more useful
  // message
  assert.equal(requiredCreativity('create_card', { id: 'mine' }, ctx).level, 'medium');
  assert.equal(requiredCreativity('create_card', { id: 'fresh', overwrite: true }, ctx).level, 'high');
  const before = asked;
  assert.equal(requiredCreativity('create_card', { id: '../../etc/x', overwrite: true }, ctx).level, 'high');
  assert.equal(requiredCreativity('create_card', { overwrite: true }, ctx).level, 'high');
  assert.equal(asked, before, 'An invalid id must not query the file system');
  // When cardExists is not injected: always treated as creating new
  assert.equal(requiredCreativity('create_card', { id: 'mine', overwrite: true }).level, 'high');
});

test('CR-8 the rejection error states the current level, the required level, and how to change it', () => {
  const r = checkCreativity('create_card', { id: 'new-card', source: 'x' }, 'low', { source: 'Follows the project\'s default level' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.creativity, { current: 'low', required: 'high', tool: 'create_card' });
  assert.match(r.error, /currently at "Low"/);
  assert.match(r.error, /Create a new card requires "High"/);
  assert.match(r.error, /Follows the project's default level/);
  assert.match(r.error, /project settings/);
  assert.match(r.error, /AI panel/);
  assert.match(r.error, /Stop and tell the user/);
  const m = checkCreativity('edit_card', { cardId: 'x' }, 'low');
  assert.match(m.error, /requires "Medium"/);
});

/* ------------------------------------------------------------------ CR-9 Registry */

test('CR-9 session registry: a chat override takes priority over the project default; with no override it follows the project; unregistered sessions and headless instances follow the project as desktop app sessions', () => {
  const s = createAgentSessions({ now: () => 1000 });
  s.register('conv-A', { type: 'cli', vendor: 'claude', creativity: 'low' });
  s.register('conv-B', { type: 'api', vendor: 'anthropic', creativity: null });
  // Override takes precedence
  assert.equal(s.creativityOf('conv-A', 'high').level, 'low');
  assert.equal(s.creativityOf('conv-A', 'medium').level, 'low');
  assert.match(s.creativityOf('conv-A', 'high').source, /Set for this chat only/);
  // Follows project
  assert.equal(s.creativityOf('conv-B', 'medium').level, 'medium');
  assert.equal(s.creativityOf('conv-B', 'low').level, 'low');
  // Override can be higher than project (user raises it individually in chat)
  s.register('conv-C', { type: 'cli', vendor: 'codex', creativity: 'high' });
  assert.equal(s.creativityOf('conv-C', 'low').level, 'high');
  // Registering again switches back to following project
  s.register('conv-A', { type: 'cli', vendor: 'claude', creativity: null });
  assert.equal(s.creativityOf('conv-A', 'medium').level, 'medium');
  // Registration structure
  const b = s.get('conv-B');
  assert.deepEqual({ type: b.type, vendor: b.vendor, role: b.role, override: b.override }, { type: 'api', vendor: 'anthropic', role: 'main', override: null });
  // Unregistered: desktop app session, follows project, not written to table
  const d = s.creativityOf('skill-xyz', 'low');
  assert.equal(d.level, 'low');
  assert.equal(d.entry.type, 'desktop');
  assert.match(d.source, /Desktop app/);
  assert.equal(s.list().some((e) => e.id === 'skill-xyz'), false);
  // Desktop app sessions do not accept override values
  s.register('desk', { type: 'desktop', vendor: 'claude', creativity: 'high' });
  assert.equal(s.creativityOf('desk', 'low').level, 'low');
  // Unrecognized override values are treated as unset
  s.register('conv-D', { type: 'cli', creativity: 'ultra' });
  assert.equal(s.creativityOf('conv-D', 'medium').level, 'medium');
});

/* ------------------------------------------------------------------ CR-10 Defaults */

test('CR-10 an old project missing the field is treated as "high"; an unrecognized value is treated as "high"', () => {
  assert.equal(projectCreativity({ name: 'Old project' }), 'high');
  assert.equal(projectCreativity(null), 'high');
  assert.equal(projectCreativity({ creativity: 'bogus' }), 'high');
  assert.equal(projectCreativity({ creativity: 'medium' }), 'medium');
  assert.equal(effectiveCreativity(null, undefined), 'high');
  assert.equal(effectiveCreativity('low', undefined), 'low');
  assert.equal(normalizeCreativity('HIGH'), null);
  assert.deepEqual([...CREATIVITY_LEVELS], ['low', 'medium', 'high']);
  assert.equal(creativityAllows('medium', 'low'), true);
  assert.equal(creativityAllows('medium', 'high'), false);
  // Legacy project + chat without override: create_card allowed (factory default "high")
  const s = createAgentSessions();
  s.register('c', { type: 'cli' });
  const level = s.creativityOf('c', projectCreativity({ name: 'Old project' })).level;
  assert.equal(checkCreativity('create_card', { id: 'n' }, level).ok, true);
});

/* ------------------------------------------------------------------ CR-11 Custom measurement (plan A6) */

test('CR-11 measure_audio_js is allowed only at "high"; the low and medium tiers return a uniformly formatted out-of-level error', () => {
  const args = { scope: 'timeline', code: 'return input.frames' };
  assert.deepEqual(requiredCreativity('measure_audio_js', args), { level: 'high', what: 'Write custom measurement code' });
  for (const level of ['low', 'medium']) {
    const r = checkCreativity('measure_audio_js', args, level, { source: 'Level set separately for this chat' });
    assert.equal(r.ok, false, level);
    assert.deepEqual(r.creativity, { current: level, required: 'high', tool: 'measure_audio_js' });
    assert.match(r.error, /measure_audio_js was not executed/);
    assert.match(r.error, /Write custom measurement code requires "High"/);
    assert.match(r.error, /Stop and tell the user/);
  }
  assert.match(checkCreativity('measure_audio_js', args, 'low').error, /measure only with built-in methods/);
  assert.equal(checkCreativity('measure_audio_js', args, 'high').ok, true);
  for (const level of CREATIVITY_LEVELS) assert.equal(checkCreativity('measure_audio', { clipId: 'c1' }, level).ok, true, `measure_audio @${level}`);
  assert.equal(toolDef('measure_audio_js')?.side, 'agent');
});

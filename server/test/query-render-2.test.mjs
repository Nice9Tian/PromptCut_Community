/*
 * Second round of query render (report `docs/reports/AGENT-query-render-2.md`; semantics
 * `docs/semantics/mechanism/rendering.md` "Query render and prerender process").
 *
 *   QR2-M-*  Three modes of prerender process (`server/prerender-mode.mjs`, `PROMPTCUT_PRERENDER_MODE`):
 *            which lanes each creates, what requests not accepted by the mode return on the spot
 *            (without hanging), and which to select when the editor process starts up.
 *   QR2-C-*  Claim gate in queue mode (`server/queue-agent-spare.mjs` + node session's `claimLimit`):
 *            when Agent dedicated instance is open and idle, this machine's node claims one extra
 *            item and hands it to dedicated instance; when an Agent task arrives, it does not queue
 *            behind it, nor behind queued prerenders; when dedicated instance is not open, does not
 *            claim extra, and does not open an instance for it.
 *
 * Browsers are completely mocked out (`openBakery` throws on call: test fails if anything tries to
 * open a new Chrome), mock prerender rooms pre-populated on lanes.
 * Run: `node --experimental-test-module-mocks --test server/test/query-render-2.test.mjs`
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let open; const p = new Promise(resolve => { open = resolve; }); return { p, open }; };
async function until(check, ms = 3000) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error('Timed out waiting for the condition');
    await sleep(1);
  }
}

let opened = 0;
mock.module(new URL('../bakery/index.mjs', import.meta.url).href, {
  exports: {
    openBakery: async () => { opened++; throw new Error('Chrome is not opened here'); },
    findFfmpeg: async () => 'ffmpeg',
    bakeFrames: async () => {},
  },
});

const { FramePipeline } = await import('../frame-pipeline.mjs');
const modeLib = await import('../prerender-mode.mjs');
const { createAgentSpareGate, snapshotConflictKey } = await import('../queue-agent-spare.mjs');
const { createNodeSession } = await import('../render-node/session.mjs');

const project = { id: 'p1', width: 64, height: 36, fps: 30, duration: 4, tracks: [], media: [] };

function fakeBakery(name, log = []) {
  return {
    name,
    reset: async () => { log.push(`${name}.reset`); },
    page: { setViewport: async () => {}, evaluate: async () => null },
    client: { send: async () => {} },
    close: async () => { log.push(`${name}.close`); },
  };
}

const tmpRoots = [];
function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-query-render-2-'));
  tmpRoots.push(dir);
  return dir;
}
test.after(() => { for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true }); });

/** Same harness as `query-render.test.mjs`, with an extra `mode` */
function harness({ mode = 'full', agentOpen = false, queueOpen = true, interactive = true } = {}) {
  const log = [];
  const svc = new FramePipeline({ root: tmpRoot(), origin: () => 'http://127.0.0.1:1', interactive, mode });
  svc.agentGraceMs = 0;
  const bakeries = { queue: fakeBakery('queue', log), agent: fakeBakery('agent', log), background: fakeBakery('background', log) };
  if (queueOpen) svc.lanes.set('queue', { bakery: bakeries.queue });
  if (agentOpen) svc.lanes.set('agent', { bakery: bakeries.agent });
  const entry = { key: 'k', project, dir: '.', html: new Map(), controls: new Map(), recordVersion: 0 };
  svc.entry = async () => entry;
  svc.readFramesCore = async (_entry, frames, lane, _signal, _onSession, _onFrame, lease) => {
    const bakery = lease ? await lease(project) : await svc.acquire(lane, project);
    log.push(`${lane}@${bakery.name}`);
    await sleep(3);
    if (!lease) svc.release(lane);
    return new Map(frames.map(n => [n, { buf: Buffer.alloc(0), source: 'mov' }]));
  };
  const task = (name, { hold = null, ...options } = {}) => svc.runQueueTask(async lease => {
    const bakery = await lease(project);
    log.push(`${name}:start@${bakery.name}`);
    if (hold) await hold.p;
    log.push(`${name}:end`);
    return name;
  }, undefined, options);
  const agentTask = name => svc.runAgentTask(async lease => { const bakery = await lease(project); log.push(`${name}@${bakery.name}`); return name; });
  return { svc, log, bakeries, task, agentTask };
}

/** Settles within `ms` (without hanging); returns the settled result `{ ok, value | error }` */
async function settlesWithin(promise, ms = 500) {
  const timer = sleep(ms).then(() => ({ timeout: true }));
  const result = await Promise.race([promise.then(value => ({ ok: true, value }), error => ({ ok: false, error })), timer]);
  assert.ok(!result.timeout, `did not settle within ${ms} ms (hung)`);
  return result;
}

/* ------------------------------------------------------------------ Mode */

test('QR2-M-1 mode value: three values are recognized, case and whitespace are ignored; an unset or unrecognized value in the prerender process is treated as full; when launched by the editor the default is full (this machine always has an Agent), and an explicit value is used as given', () => {
  assert.equal(modeLib.parsePrerenderMode(' Agent '), 'agent');
  assert.equal(modeLib.parsePrerenderMode('USER'), 'user');
  assert.equal(modeLib.parsePrerenderMode('full'), 'full');
  assert.equal(modeLib.parsePrerenderMode('split'), null);
  assert.equal(modeLib.parsePrerenderMode(undefined), null);
  assert.equal(modeLib.prerenderModeOf({}), 'full');
  assert.equal(modeLib.prerenderModeOf({ PROMPTCUT_PRERENDER_MODE: 'bogus' }), 'full');
  assert.equal(modeLib.prerenderModeOf({ PROMPTCUT_PRERENDER_MODE: 'agent' }), 'agent');
  assert.equal(modeLib.localPrerenderMode({}), 'full');
  assert.equal(modeLib.localPrerenderMode({ PROMPTCUT_PRERENDER_MODE: 'user' }), 'user');
  assert.deepEqual(modeLib.lanesOfMode('user'), ['user', 'background', 'queue', 'stream']);
  assert.deepEqual(modeLib.lanesOfMode('agent'), ['agent']);
  assert.deepEqual(modeLib.lanesOfMode('full'), ['user', 'background', 'queue', 'stream', 'agent']);
});

test('QR2-M-2 full mode (default): all three chains are built, and both Agent queries and regular prerender are accepted; passing no mode is the same as passing full', async () => {
  for (const mode of [undefined, 'full']) {
    const { svc, log, task, agentTask } = harness({ mode, agentOpen: true });
    try {
      assert.equal(svc.mode, 'full');
      assert.deepEqual([...svc.laneChains.keys()].sort(), ['agent', 'background', 'user']);
      assert.deepEqual(svc.diagnostics().mode, { mode: 'full', lanes: ['user', 'background', 'queue', 'stream', 'agent'] });
      assert.equal(await agentTask('X'), 'X');
      assert.equal(await task('A'), 'A');
      const frames = await svc.see_frames(project, [0.5], { lane: 'agent' });
      assert.equal(frames.size, 1);
      assert.ok(log.includes('X@agent') && log.includes('agent@agent'));
    } finally { await svc.close(); }
  }
});

test('QR2-M-3 user mode: no Agent lane is built; Agent queries (see_frames, runAgentTask, layout) immediately return 503 NO_AGENT_LANE and are not retryable; prerender proceeds as usual, and the dedicated instance takes no jobs', async () => {
  const { svc, log, task, agentTask } = harness({ mode: 'user' });
  // Even if lanes contains an 'agent' (which won't happen), do not borrow it
  svc.lanes.set('agent', { bakery: fakeBakery('agent', log) });
  try {
    assert.deepEqual([...svc.laneChains.keys()].sort(), ['background', 'user']);
    assert.deepEqual(svc.diagnostics().mode.lanes, ['user', 'background', 'queue', 'stream']);
    const noAgent = error => error.status === 503 && error.code === 'NO_AGENT_LANE' && error.retryable === false && error.mode === 'user';
    for (const call of [() => agentTask('X'), () => svc.see_frames(project, [0.5], { lane: 'agent' }), () => svc.see_frames(project, [0.5]),
      () => svc.layout(project, { t: 0 }), () => svc.acquire('agent', project)]) {
      const result = await settlesWithin(Promise.resolve().then(call));
      assert.ok(!result.ok && noAgent(result.error), String(result.error?.code ?? result.value));
    }
    assert.equal(svc.agentPending, 0, 'nothing is left in the Agent queue');
    // Prerender proceeds as normal: operation previews and normal prerenders are both on the queue lane
    const hold = gate();
    const a = task('A', { hold });
    const b = task('B');
    await until(() => log.includes('A:start@queue'));
    await sleep(15);
    assert.ok(!log.some(e => e.startsWith('B')), 'B was not picked up by the dedicated instance (user mode has no dedicated instance)');
    assert.equal(svc.agentSpareSlot(), false);
    hold.open();
    await Promise.all([a, b]);
    const frames = await svc.see_frames(project, [0.5], { lane: 'preview' });
    assert.equal(frames.size, 1);
    assert.ok(log.includes('preview@queue') && log.includes('B:start@queue'));
    assert.ok(!log.includes('agent.reset'));
  } finally { await svc.close(); }
});

test('QR2-M-4 agent mode: only the Agent lane is built; prerender requests immediately return 503 NO_PRERENDER (not queued, not left hanging, no Chrome opened); preload returns skipped; Agent queries work as usual', async () => {
  const { svc, log, agentTask } = harness({ mode: 'agent', agentOpen: true });
  const openedBefore = opened;
  try {
    assert.deepEqual([...svc.laneChains.keys()], ['agent']);
    assert.deepEqual(svc.diagnostics().mode, { mode: 'agent', lanes: ['agent'] });
    const noPrerender = error => error.status === 503 && error.code === 'NO_PRERENDER' && error.retryable === false && error.mode === 'agent';
    const calls = {
      'see_frames user': () => svc.see_frames(project, [0.5], { lane: 'user' }),
      'see_frames preview': () => svc.see_frames(project, [0.5], { lane: 'preview' }),
      'see_frames prerender': () => svc.see_frames(project, [0.5], { lane: 'prerender' }),
      'see_frames background': () => svc.see_frames(project, [0.5], { lane: 'background' }),
      'see_frames playback': () => svc.see_frames(project, [0.5], { lane: 'playback' }),
      runQueueTask: () => svc.runQueueTask(async () => 'x'),
      updatePlayback: () => svc.updatePlayback(project, { owner: 'o', sequence: 1, t: 0, playing: true }),
      'acquire queue': () => svc.acquire('queue', project),
    };
    for (const [name, call] of Object.entries(calls)) {
      const result = await settlesWithin(Promise.resolve().then(call));
      assert.ok(!result.ok && noPrerender(result.error), `${name}:${result.error?.code ?? JSON.stringify(result.value)}`);
    }
    // Also rejects when background pass borrows 'background', marked cancelled (backs off per yield)
    const bg = await settlesWithin(svc.acquire('background', project));
    assert.ok(!bg.ok && bg.error.code === 'NO_PRERENDER' && bg.error.cancelled === true);
    assert.equal(svc.queueTasks.length, 0, 'not queued in the regular prerender queue');
    assert.deepEqual(await svc.preload(project, { session: 's1', localRev: 1 }), { skipped: 'agent' });
    assert.equal(svc.streamProducer(), null, 'no stream is produced');
    await svc.prewarmUser(project);
    assert.equal(svc.userPool.length, 0, 'no warm pool of interactive frames is kept');
    assert.equal(opened, openedBefore, 'no Chrome was opened');
    assert.equal(svc.agentSpareSlot(), false, 'there is no prerender to pick up');
    // Agent queries proceed as usual
    assert.equal(await agentTask('X'), 'X');
    const frames = await svc.see_frames(project, [0.5, 1]);
    assert.equal(frames.size, 2);
    assert.ok(log.includes('X@agent') && log.includes('agent@agent'));
  } finally { await svc.close(); }
});

test('QR2-M-5 the editor process (interactive: false) is not affected by the mode: NO_AGENT_LANE (retryable) / USE_PRERENDER as before, and the regular prerender queue as before', async () => {
  for (const mode of ['agent', 'user', 'full']) {
    const { svc, task } = harness({ mode, interactive: false });
    try {
      await assert.rejects(svc.runAgentTask(async () => 'x'), error => error.code === 'NO_AGENT_LANE' && error.retryable === true);
      assert.equal(svc.laneRefused('user').code, 'USE_PRERENDER');
      assert.equal(await task('A'), 'A');
      assert.deepEqual(svc.diagnostics().mode.lanes, []);
    } finally { await svc.close(); }
  }
});

test('QR2-M-6 source check: when the editor launches the prerender process it passes PROMPTCUT_PRERENDER_MODE (localPrerenderMode); the frame plugin builds the pipeline according to the mode, and in agent mode it starts no render node, builds no push queue, and /preload returns skipped', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const prerender = fs.readFileSync(path.join(root, 'vite-plugin-prerender.ts'), 'utf8');
  assert.match(prerender, /const mode = localPrerenderMode\(process\.env\)/);
  assert.match(prerender, /PROMPTCUT_PRERENDER_MODE: mode,/);
  assert.match(prerender, /error: s\.error, mode \}/, '/api/prerender/info includes mode');
  const frames = fs.readFileSync(path.join(root, 'vite-plugin-frames.ts'), 'utf8');
  assert.match(frames, /const prerenderMode = isPrerender \? prerenderModeOf\(process\.env\) : "full";/);
  assert.match(frames, /mode: prerenderMode,/);
  assert.match(frames, /if \(servesPrerender\) void startArtifactPush/);
  assert.match(frames, /if \(servesPrerender && queueNodeSwitch\(\)\) void startQueueNode/);
  assert.match(frames, /url\.pathname === "\/preload" && !servesPrerender\) \{\s*\/\/[^\n]*\n\s*return json\(200, \{ ok: true, skipped: prerenderMode/);
  assert.match(frames, /reason: `prerender-mode-\$\{prerenderMode\}`/, 'agent mode does not act as an automatic render node');
});

/* ------------------------------------------------------------------ Claim gate */

test('QR2-C-1 agentSpareSlot: true only in full mode, with the dedicated instance open and not expired, the Agent queue empty, no job in hand, and no pending item it could take', async () => {
  const closed = harness({ agentOpen: false });
  try { assert.equal(closed.svc.agentSpareSlot(), false, 'dedicated instance not open: no instance is opened just to take on prerender'); } finally { await closed.svc.close(); }
  const { svc, task, agentTask } = harness({ agentOpen: true });
  try {
    assert.equal(svc.agentSpareSlot(), true);
    svc.lanes.get('agent').expired = true;
    assert.equal(svc.agentSpareSlot(), false, 'idle close reached');
    svc.lanes.get('agent').expired = false;
    svc.backgroundLeaseUntil = Date.now() + 10_000;
    assert.equal(svc.agentSpareSlot(), false, 'while yielding to playback');
    svc.backgroundLeaseUntil = 0;
    // Agent task in progress: do not open
    const hold = gate();
    const x = svc.runAgentTask(async lease => { await lease(project); await hold.p; return 'X'; });
    await until(() => svc.agentPending === 1);
    assert.equal(svc.agentSpareSlot(), false, 'Agent queue is not empty');
    hold.open();
    await x;
    // queue lane is busy with pending tasks it can take: dedicated instance takes them, no extra claim
    const holdA = gate(), holdB = gate();
    const a = task('A', { hold: holdA });
    const b = task('B', { hold: holdB });
    await until(() => svc.agentUnit !== null);
    assert.equal(svc.agentSpareSlot(), false, 'one item in hand');
    holdB.open(); await b;
    await until(() => svc.agentUnit === null);
    assert.equal(svc.agentSpareSlot(), true, 'queue lane is working on A, dedicated instance is idle');
    holdA.open(); await a;
    await agentTask('Y');
  } finally { await svc.close(); }
});

test('QR2-C-2 claimLimit of a node session: with one extra slot in the limit, a node holding one item still claims another; canClaim receives the current held count; hello still reports maxConcurrent', () => {
  let t = 1000;
  const sent = [];
  let limit = 1;
  const seen = [];
  const view = (name) => ({ id: `snapshot:${name}:0-59`, kind: 'snapshot', tier: 'shared', resultKey: name, range: { unit: 'localFrame', from: 0, to: 59 },
    source: { userId: 'u1', tenantId: 't1', projectId: 'p1', projectRev: 1, publisher: { id: 'P' }, publishedAt: 1, derivedFrom: null },
    input: { compositing: 'independent', contentKey: name }, weight: { class: 'medium', estMs: null, frames: 60 },
    requires: { envFingerprint: 'f', codeVersion: 'c' }, priority: 10, state: 'open', version: 1, attempts: 0 });
  const session = createNodeSession({
    nodeId: 'n1', node: { profile: 'pc', userId: 'u1', envFingerprint: 'f', codeVersions: ['c'], cardSourceVersions: {}, capabilities: { userCards: true } },
    send: m => sent.push(m), now: () => t, random: () => 0, maxConcurrent: 1,
    claimLimit: () => limit, canClaim: (task, info) => { seen.push(info.held); return true; },
  });
  session.start([]);
  assert.equal(sent.find(m => m.type === 'node.hello')?.maxConcurrent, 1);
  session.receive({ type: 'queue.snapshot', epoch: 'e', tasks: [view('a'), view('b')] });
  sent.length = 0;
  session.tick();
  const first = sent.find(m => m.type === 'task.claim');
  assert.ok(first);
  session.receive({ type: 'task.claimed', epoch: 'e', id: first.id, token: 1, version: 1, leaseUntil: t + 30000, task: { ...view(first.id.split(':')[1]), state: 'claimed', version: 1 } });
  sent.length = 0;
  t += 1; session.tick();
  assert.equal(sent.filter(m => m.type === 'task.claim').length, 0, 'limit 1: no more claims once one item is held');
  limit = 2;
  t += 1; session.tick();
  const second = sent.find(m => m.type === 'task.claim');
  assert.ok(second && second.id !== first.id, 'limit 2: claims one more item');
  assert.deepEqual([...new Set(seen)].sort(), [0, 1], 'canClaim received held counts 0 and 1');
});

test('QR2-C-3 slots of the claim gate: the regular slot accepts anything; the extra slot accepts only snapshots, never one for the same card as the one in hand, and is open only when the dedicated instance can take it and the queue lane is busy', async () => {
  const pipeline = { spare: true, queueRunning: { tag: 'x' }, agentSpareSlot() { return this.spare; } };
  const g = createAgentSpareGate({ pipeline, base: 1 });
  const snap = (key, extra = {}) => ({ id: `snapshot:${key}:0-59`, kind: 'snapshot', input: { contentKey: key, ...extra } });
  assert.equal(g.claimLimit(), 2);
  assert.equal(g.canClaim({ id: 'plan:1', kind: 'plan' }, { held: 0 }), true, 'regular slot: plan is accepted too');
  assert.equal(g.canClaim({ id: 'stream:1', kind: 'stream' }, { held: 1 }), false, 'the extra slot does not take streams (it would open an extra stream Chrome)');
  assert.equal(g.canClaim({ id: 'plan:1', kind: 'plan' }, { held: 1 }), false, 'the extra slot does not take plan');
  // Currently working on card-a: do not take another segment of the same card; take other cards
  let release;
  const running = g.wrap({ render: () => new Promise(r => { release = r; }) }).render(snap('card-a'), {});
  assert.equal(g.canClaim(snap('card-a'), { held: 1 }), false);
  assert.equal(g.canClaim(snap('card-b'), { held: 1 }), true);
  assert.equal(snapshotConflictKey(snap('card-b', { entryKey: 'e1' })), 'scene:e1', 'local tier is mutually exclusive per whole scene');
  release(); await running;
  assert.equal(g.canClaim(snap('card-a'), { held: 1 }), true, 'removed once done');
  pipeline.queueRunning = null;
  assert.equal(g.claimLimit(), 1, 'queue lane is idle: the extra claimed item lands on the queue lane, so no slot is opened');
  assert.equal(g.canClaim(snap('card-b'), { held: 1 }), false);
  pipeline.queueRunning = { tag: 'x' }; pipeline.spare = false;
  assert.equal(g.claimLimit(), 1, 'dedicated instance cannot take it: no slot is opened');
  assert.equal(g.canClaim(snap('card-b'), { held: 1 }), false);
});

test('QR2-C-4 dedicated instance is open and idle: the extra claimed item runs on the dedicated instance; if an Agent task arrives in the meantime, it runs first once that item finishes, ahead of the queued prerender', async () => {
  const { svc, log, task, agentTask } = harness({ agentOpen: true });
  const g = createAgentSpareGate({ pipeline: svc, base: 1 });
  try {
    const holdA = gate(), holdB = gate();
    // Normal slot: A is processed on the queue lane
    const a = task('A', { hold: holdA, tag: 'card:a' });
    await until(() => log.includes('A:start@queue'));
    assert.equal(g.claimLimit(), 2, 'dedicated instance open and idle, queue lane busy: one more slot');
    assert.equal(g.canClaim({ id: 'snapshot:b', kind: 'snapshot', input: { contentKey: 'b' } }, { held: 1 }), true);
    // Extra-claimed B (another card) queues up, dedicated instance takes it
    const b = task('B', { hold: holdB, tag: 'card:b' });
    await until(() => log.includes('B:start@agent'));
    assert.equal(g.claimLimit(), 1, 'dedicated instance has a job in hand: the slot is taken back');
    // Another item C queues up (e.g. normal prerender from another source), then Agent task X arrives
    const c = task('C', { tag: 'card:c' });
    const x = agentTask('X');
    await sleep(15);
    assert.ok(!log.includes('B:end') && !log.includes('X@agent'), 'B is not interrupted, X waits for it');
    holdB.open();
    assert.equal(await x, 'X');
    const at = e => log.indexOf(e);
    assert.ok(at('B:end') < at('X@agent'), 'X comes right after B');
    assert.ok(!log.includes('C:start@agent') || at('X@agent') < at('C:start@agent'), 'X is not placed after the queued C');
    await c;
    holdA.open();
    await Promise.all([a, b]);
    assert.ok(at('X@agent') < at('C:start@agent'), JSON.stringify(log));
  } finally { await svc.close(); }
});

test('QR2-C-5 dedicated instance not open: no extra claim; an extra item (if any) is also queued only on the queue lane, and no Chrome is opened for it', async () => {
  const { svc, log, task } = harness({ agentOpen: false });
  const g = createAgentSpareGate({ pipeline: svc, base: 1 });
  const openedBefore = opened;
  try {
    const holdA = gate();
    const a = task('A', { hold: holdA });
    await until(() => log.includes('A:start@queue'));
    assert.equal(g.claimLimit(), 1);
    assert.equal(g.canClaim({ id: 'snapshot:b', kind: 'snapshot', input: { contentKey: 'b' } }, { held: 1 }), false);
    const b = task('B');
    await sleep(15);
    assert.ok(!log.some(e => e.startsWith('B')), 'B waits for the queue lane');
    holdA.open();
    await Promise.all([a, b]);
    assert.ok(log.includes('B:start@queue'));
    assert.ok(!svc.lanes.has('agent'), 'no Agent dedicated instance was opened');
    assert.equal(opened, openedBefore, 'no Chrome was opened');
  } finally { await svc.close(); }
});

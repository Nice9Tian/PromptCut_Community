/**
 * Standalone render hosts are no longer split into pools due to user cards (c66-host-cards;
 * code and semantics conflict exposed in C6.6 T9, report
 * `docs/archive/agent-reports/AGENT-c66-host-cards.md`).
 *
 * Semantics: standalone render hosts "can claim: all" (`product/platforms.md` "render node");
 * each task specifies what capabilities are needed, and nodes filter by their own capabilities
 * (`mechanism/document-service.md` "render queue"); source code of user cards and modified cards
 * is synced via content store `card-source`, and the other end installs them automatically
 * (`docs/plan/c66-design.md` Section 5).
 *
 *   HC1  Two nodes with different user cards remain in the same pool: frameCode excludes
 *        src/cards/user (except the loader entry) and normalizes line endings; modifying other
 *        source code still bumps the version
 *   HC2  If a task requires cards not present locally, it is not claimed (no error); it can be
 *        claimed after being synced and installed via card-source, with claim and complete going
 *        through the real queue
 *   HC3  Modified cards: synced new versions are installed into the host's own overlay layer;
 *        identity changes accordingly, old-version tasks are no longer claimed and new-version
 *        tasks can be (user cards not originally present locally are also only installed into the
 *        overlay layer, without writing any file to the checkout directory: AGENT-card-overlay)
 *   HC4  Different code for the same card does not mix outputs: whole scene keys and local tier /
 *        shared tier result keys all differ; executor context is recomputed by card code revision
 *   HC5  Index of card code identity: does not report identity for a period right after a change;
 *        not cached when algorithm is not injected
 *   HC6  Host sync is read-only: even if the local copy differs from the service, it never writes
 *        to the project
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

delete process.env.PROMPTCUT_CARD_OVERRIDES;
delete process.env.PROMPTCUT_DATA_DIR;

const { frameCode, isUserCardSource } = await import('../frame-code.mjs');
const { createCardCodeIndex, cardEntryCode, projectCardIds } = await import('../card-code.mjs');
const { checkClaimable } = await import('../render-node/filter.mjs');
const { splitPlan, planTaskOf } = await import('../render-node/split.mjs');
const { resultKeyOf } = await import('../render-node/fingerprint.mjs');
const { createRenderHost, HOST_CAPABILITIES } = await import('../render-node/host.mjs');
const { createRenderQueue } = await import('../render-queue/index.mjs');
const { createWsEndpoint } = await import('../render-node/ws-transport.mjs');
const { createDocService } = await import('../docservice/service.mjs');
const { contentModule } = await import('../docservice/modules/content.mjs');
const { createMemoryStore } = await import('../docservice/store/index.mjs');
const { frameIdentity } = await import('../frame-identity.mjs');
const { cardSnapshotIdentity } = await import('../card-identity.mjs');
const { createPrerenderExecutor } = await import('../prerender-executor.mjs');
const { FramePipeline } = await import('../frame-pipeline.mjs');
const { createLoopback } = await import('./fake-loopback-transport.mjs');
const { createTimerClock } = await import('./fake-render-executor.mjs');
const cards = await import('../vite-plugin-cards.ts');

const FP = 'fedcba9876543210';
const CV = 'c0de-host-cards';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what} (${ms} ms)`);
    await sleep(20);
  }
}

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

/**
 * Overlay layer is determined only by environment variables (`overridesRoot` in
 * `card-overrides.mjs` is read fresh each time): temporarily set per call
 */
function withOverlay(dir, fn) {
  const before = process.env.PROMPTCUT_CARD_OVERRIDES;
  if (dir) process.env.PROMPTCUT_CARD_OVERRIDES = dir; else delete process.env.PROMPTCUT_CARD_OVERRIDES;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.PROMPTCUT_CARD_OVERRIDES; else process.env.PROMPTCUT_CARD_OVERRIDES = before;
  }
}

const cardSource = (text) => `import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <motion.div animate={{ opacity: 1 }}>{params.text}</motion.div>;
}
export const priceTag: CardDef<Params> = {
  id: "price-tag", name: "Price", description: "d", source: "user",
  frameMode: "stateful",
  defaults: { text: "${text}" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
`;
const USER_KEY = 'src/cards/user/price-tag.tsx';
const GLASS = `import type { CardDef } from "../../kernel/types";
export const glass: CardDef<{ n: number }> = {
  id: "glass", name: "glass", description: "d", source: "native",
  frameMode: "stateful",
  defaults: { n: 1 },
  controls: [],
  Component: () => null,
};
`;

/** A minimal "checkout": several source files, user card loader entry, a built-in card */
function checkout(prefix, extra = {}) {
  const root = tmp(prefix);
  put(root, 'src/kernel/a.ts', 'export const a = 1;\n');
  put(root, 'src/cards/user/index.ts', 'export const userCards = [];\n');
  put(root, 'src/cards/native/glass.tsx', GLASS);
  for (const [rel, text] of Object.entries(extra)) put(root, rel, text);
  return root;
}

/* ================================================================== HC1 */

test('HC1 two nodes with different user cards are still in the same pool: frameCode does not include src/cards/user (except the loader entry), and line endings are normalized', () => {
  const a = checkout('pc-hc1-a-', { [USER_KEY]: cardSource('v1'), 'src/cards/user/_scopes.json': '{"price-tag":{"scope":"project"}}' });
  const b = checkout('pc-hc1-b-');
  const c = checkout('pc-hc1-c-', { [USER_KEY]: cardSource('another'), 'src/cards/user/lib/helper.ts': 'export const h = 2;\n' });
  // The same source code, line endings from a Windows checkout
  const d = checkout('pc-hc1-d-');
  for (const rel of ['src/kernel/a.ts', 'src/cards/user/index.ts', 'src/cards/native/glass.tsx']) {
    put(d, rel, fs.readFileSync(path.join(b, rel), 'utf8').replace(/\n/g, '\r\n'));
  }
  const code = frameCode(b);
  assert.match(code, /^[0-9a-f]{64}$/);
  assert.equal(frameCode(a), code, 'an extra user card (and the ownership table) does not change the code version');
  assert.equal(frameCode(c), code, 'different user cards, or an extra user-card dependency file, also do not change the code version');
  assert.equal(frameCode(d), code, 'a CRLF checkout and an LF checkout give the same code version');

  // Loader entry, built-in cards, and other source code remain in code version
  const e = checkout('pc-hc1-e-', { 'src/kernel/a.ts': 'export const a = 2;\n' });
  assert.notEqual(frameCode(e), code, 'changing the kernel source changes the code version');
  const f = checkout('pc-hc1-f-', { 'src/cards/user/index.ts': 'export const userCards = [1];\n' });
  assert.notEqual(frameCode(f), code, 'the user-card loader entry is renderer code, so changing it changes the version');
  const g = checkout('pc-hc1-g-', { 'src/cards/native/glass.tsx': GLASS.replace('n: 1', 'n: 2') });
  assert.notEqual(frameCode(g), code, 'changing a built-in card changes the version');

  assert.equal(isUserCardSource('src/cards/user/x.tsx'), true);
  assert.equal(isUserCardSource('src/cards/user/_scopes.json'), true);
  assert.equal(isUserCardSource('src/cards/user/lib/h.ts'), true);
  assert.equal(isUserCardSource('src/cards/user/index.ts'), false);
  assert.equal(isUserCardSource('src\\cards\\user\\x.tsx'), true);
  assert.equal(isUserCardSource('src/cards/native/x.tsx'), false);

  // Filtering: tasks published by creator (with user card) still pass code version check on hosts
  // without this card
  const task = { kind: 'snapshot', source: { projectId: 'p' }, weight: { class: 'medium' },
    requires: { envFingerprint: FP, codeVersion: frameCode(a), cardSources: {}, transcode: false, userCards: true, graphCards: false } };
  assert.deepEqual(checkClaimable(task, { profile: 'host', envFingerprint: FP, codeVersions: [frameCode(b)], capabilities: HOST_CAPABILITIES }), { ok: true });
});

/* ================================================================== Document service, queue fixtures */

async function startDoc(t) {
  const service = createDocService({
    log: () => {},
    authenticate: (req) => {
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
      return { userId: q.get('user') ?? 'u', deviceId: q.get('dev') ?? 'd', role: q.get('role') ?? 'page', tenantId: 't-hc' };
    },
    modules: [contentModule({ store: createMemoryStore() })],
  });
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(() => service.close());
  return { url: (user, role = 'page') => `ws://127.0.0.1:${port}/?user=${user}&dev=dev-${user}&role=${role}` };
}

/** Open another connection to send a request to content store, returning response */
async function rpc(doc, message) {
  const ws = new WebSocket(doc.url('creator'), ['promptcut.v1']);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const reply = await new Promise((resolve) => {
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.reqId === 'r1') resolve(m); });
    ws.send(JSON.stringify({ ...message, reqId: 'r1' }));
  });
  ws.close();
  return reply;
}
const putCard = (doc, key, body) => rpc(doc, { type: 'content.put', kind: 'card-source', key, body, session: 'creator-session' });

/**
 * In-process queue for a project + a page publisher + host (one project, one node; node's
 * cardSourceVersions is a view)
 */
function queueWithHost({ view, executor, sink }) {
  const clock = createTimerClock();
  const lb = createLoopback();
  const queue = createRenderQueue({ now: clock.now, send: lb.queueSend, epoch: 'epoch-hc' });
  lb.attach(queue);
  const page = lb.connect('page', { userId: 'alice@page-device-0001', tenantId: 'proj-hc' });
  const inbox = [];
  page.onMessage((m) => inbox.push(m));
  page.send({ type: 'publisher.hello', publisherId: 'page-hc' });
  const host = createRenderHost({
    entries: [{ projectId: 'proj-hc', url: 'ws://unused.invalid/docservice' }],
    connect: () => ({ endpoint: lb.connect('host-0', { userId: 'renderbox@host-device-0001', tenantId: 'proj-hc' }), executor, sink }),
    nodeIdOf: () => 'host:hc/p0',
    envFingerprint: FP, codeVersion: CV, cardSourceVersions: view, maxConcurrent: 2,
    now: clock.now, random: () => 0,
  });
  const settle = async () => {
    for (let round = 0; round < 500; round++) {
      lb.flush();
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
      if (lb.pending() === 0) return;
    }
    throw new Error('message round trips do not converge');
  };
  const step = async (n = 1) => {
    for (let i = 0; i < n; i++) { await settle(); host.tick(); await settle(); queue.tick(); await settle(); clock.advance(250); }
  };
  return {
    host, queue, step,
    publish: (tasks) => page.send({ type: 'task.publish', tasks }),
    claims: () => lb.log().filter((e) => e.dir === 'in' && e.connId === 'host-0' && e.message.type === 'task.claim').map((e) => e.message.id),
    done: (id) => inbox.filter((m) => m.type === 'task.done' && m.id === id).length,
  };
}

function fakeExecutor() {
  const calls = [];
  return { calls, async plan() { throw new Error('host does not claim plan'); }, async render(task) { calls.push(task.id); return { fake: task.id }; } };
}
const fakeSink = () => ({ async has() { return false; }, async put() { return { complete: true, result: {} }; } });

/**
 * Split of a project revision: a user card clip in shared tier, a built-in card clip in
 * local tier
 */
function splitFor({ entryKey, versions, userSnapshotKey = 'sk-user' }) {
  const control = (o) => ({ count: 30, sampling: { firstFrame: 0 }, ...o });
  return splitPlan({
    planTask: planTaskOf({ projectId: 'proj-hc', projectRev: 3 }),
    entryKey,
    cardPlan: [
      control({ clipId: 'clip-user', cardId: 'price-tag', snapshotKey: userSnapshotKey, tier: 'shared', capabilities: { frameMode: 'stateful', compositing: 'independent' } }),
      control({ clipId: 'clip-glass', cardId: 'glass', snapshotKey: 'sk-glass', tier: 'local', capabilities: { frameMode: 'stateful', compositing: 'belowDependent' } }),
    ],
    envFingerprint: FP, codeVersion: CV, cardSourceVersions: versions,
    isUserCard: (c) => c.cardId === 'price-tag',
  });
}

/* ================================================================== HC2 + HC3 */

test('HC2/HC3 a task whose card is missing on this machine is not claimed; after the card is synced into the overlay layer via card-source it can be claimed (the checkout directory is not written); a changed newer version is also installed into the overlay layer', { timeout: 30000 }, async (t) => {
  const doc = await startDoc(t);

  // ---- Creator: this checkout has user card v1, uploaded to content store; split for this revision
  const creator = checkout('pc-hc2-creator-', { [USER_KEY]: cardSource('v1') });
  const creatorIndex = createCardCodeIndex({ identityOf: (id) => withOverlay(null, () => cards.cardCodeIdentity(creator, id)), settleMs: 0 });
  const project = { tracks: [{ clips: [{ cardId: 'price-tag' }, { cardId: 'glass' }] }] };
  assert.deepEqual(projectCardIds(project), ['glass', 'price-tag']);
  const v1 = creatorIndex.projectVersions(project);
  assert.deepEqual(Object.keys(v1), ['price-tag'], 'only user cards are custom cards; unmodified built-in cards are covered by the global code version');
  assert.match(v1['price-tag'], /^[0-9a-f]{32}$/);
  const stored = await putCard(doc, USER_KEY, cardSource('v1'));
  assert.equal(stored.type, 'content.stored');
  const entryKey1 = frameIdentity(project, cardEntryCode(CV, v1));
  const tasks1 = splitFor({ entryKey: entryKey1, versions: v1 });
  assert.equal(tasks1.length, 2);
  for (const task of tasks1) assert.deepEqual(task.requires.cardSources, v1, `${task.tier} tier needs the price-tag code (the shared tier is its own card, the local tier is the whole scene)`);

  // ---- Host: checkout does not have this card; has its own overlay layer
  const hostRoot = checkout('pc-hc2-host-');
  const overlay = tmp('pc-hc2-overlay-');
  const hostData = tmp('pc-hc2-data-');
  const hostIndex = createCardCodeIndex({ identityOf: (id) => withOverlay(overlay, () => cards.cardCodeIdentity(hostRoot, id)), settleMs: 0 });
  const node = { profile: 'host', envFingerprint: FP, codeVersions: [CV], capabilities: HOST_CAPABILITIES, cardSourceVersions: hostIndex.view };
  for (const task of tasks1) {
    assert.deepEqual(checkClaimable(task, node), { ok: false, rule: 1, reason: 'card-source' }, 'this machine does not have the card: not claimed, no error thrown');
  }
  // Real queue: visible, claimed 0 times
  const executor = fakeExecutor();
  const env = queueWithHost({ view: hostIndex.view, executor, sink: fakeSink() });
  env.host.start();
  env.publish(tasks1);
  await env.step(12);
  assert.equal(env.host.nodes()[0].seen, 2, 'both tasks are visible');
  assert.deepEqual(env.claims(), [], 'no claim was sent at all');

  // ---- Host card sync (read-only, real WebSocket connected to document service content store):
  // install v1
  process.env.PROMPTCUT_CARD_OVERRIDES = overlay;
  t.after(() => { delete process.env.PROMPTCUT_CARD_OVERRIDES; });
  const endpoint = createWsEndpoint({ url: doc.url('renderbox', 'render'), protocols: () => ['promptcut.v1'], backoff: { baseMs: 50, maxMs: 200 } });
  t.after(() => endpoint.close());
  let touched = 0;
  const sync = cards.createHostCardSync({ root: hostRoot, dataDir: hostData, projectId: 'proj-hc', url: doc.url('renderbox', 'render'), endpoint, before: () => { touched++; hostIndex.touch(); } });
  t.after(() => sync.close());
  const overlayFile = path.join(overlay, USER_KEY);
  const userDirBefore = fs.readdirSync(path.join(hostRoot, 'src', 'cards', 'user')).sort();
  await waitFor(() => fs.existsSync(overlayFile), 5000, 'host installs price-tag');
  await sync.idle();
  assert.equal(touched, 1, 'the stabilization period restarts before the card is installed');
  assert.equal(fs.readFileSync(overlayFile, 'utf8'), cardSource('v1'), 'the user card that was missing on this machine is installed into the host\'s own overlay layer');
  assert.equal(fs.existsSync(path.join(hostRoot, USER_KEY)), false, 'checkout directory is not written');
  assert.deepEqual(fs.readdirSync(path.join(hostRoot, 'src', 'cards', 'user')).sort(), userDirBefore);
  assert.equal(sync.status().records[USER_KEY].rev, 1);
  // Vite file watching sends change notifications only after invalidating modules; cleared directly
  // here (which is what onCardSourceChange subscribers do)
  hostIndex.invalidate();
  assert.deepEqual(hostIndex.projectVersions(project), v1, 'after installation the host computes the same identity as the creator');
  for (const task of tasks1) assert.deepEqual(checkClaimable(task, node), { ok: true });
  await env.step(12);
  assert.deepEqual(env.claims().sort(), tasks1.map((x) => x.id).sort(), 'after installation it is claimed on the next tick');
  for (const task of tasks1) assert.equal(env.done(task.id), 1, `${task.id} has exactly one task.done`);

  // ---- HC3: creator modifies card v2; host immediately installs it into overlay layer via
  // content.watch, still without writing to checkout directory
  await putCard(doc, USER_KEY, cardSource('v2'));
  await waitFor(() => fs.existsSync(overlayFile) && fs.readFileSync(overlayFile, 'utf8') === cardSource('v2'), 5000, 'host installs v2 into the overlay layer');
  await sync.idle();
  assert.equal(fs.existsSync(path.join(hostRoot, USER_KEY)), false, 'checkout directory is still not written');
  assert.equal(sync.status().records[USER_KEY].rev, 2);
  hostIndex.invalidate();
  put(creator, USER_KEY, cardSource('v2'));
  creatorIndex.invalidate();
  const v2 = creatorIndex.projectVersions(project);
  assert.notEqual(v2['price-tag'], v1['price-tag']);
  assert.deepEqual(hostIndex.projectVersions(project), v2, 'the host\'s identity changes to v2 accordingly');
  const tasks2 = splitFor({ entryKey: frameIdentity(project, cardEntryCode(CV, v2)), versions: v2, userSnapshotKey: 'sk-user-v2' });
  for (const task of tasks1) assert.deepEqual(checkClaimable(task, node), { ok: false, rule: 1, reason: 'card-source' }, 'v1 tasks are no longer claimed');
  for (const task of tasks2) assert.deepEqual(checkClaimable(task, node), { ok: true }, 'v2 tasks can be claimed');
  env.publish(tasks2);
  await env.step(12);
  for (const task of tasks2) assert.equal(env.done(task.id), 1, `${task.id} has exactly one task.done`);
  env.host.shutdown();
});

/* ================================================================== HC4 */

test('HC4 the same card with different code does not mix outputs: the whole-scene key and the result keys of the local tier and the shared tier all differ; the executor context is recomputed per card code epoch', async () => {
  const project = { id: 'hc4', fps: 30, width: 1920, height: 1080, duration: 2, style: {}, media: [], tracks: [{ id: 't', clips: [{ id: 'c', cardId: 'price-tag', start: 0, end: 2, params: {} }] }] };
  const v1 = { 'price-tag': 'a'.repeat(32) };
  const v2 = { 'price-tag': 'b'.repeat(32) };
  // Whole scene key
  assert.equal(cardEntryCode(CV, {}), CV, 'without custom cards it is just the global code version');
  assert.notEqual(cardEntryCode(CV, v1), cardEntryCode(CV, v2));
  assert.equal(cardEntryCode(CV, { b: '2', a: '1' }), cardEntryCode(CV, { a: '1', b: '2' }), 'independent of key order');
  const e1 = frameIdentity(project, cardEntryCode(CV, v1));
  const e2 = frameIdentity(project, cardEntryCode(CV, v2));
  assert.notEqual(e1, e2);

  // FramePipeline.entry: injected identity enters whole scene key, recorded on entry
  const root = tmp('pc-hc4-pipe-');
  let versions = v1;
  const pipeline = new FramePipeline({ root, origin: () => '', code: () => CV, cardSources: () => versions });
  try {
    const a = await pipeline.entry(project);
    assert.equal(a.key, e1);
    assert.deepEqual(a.cardSources, v1);
    versions = v2;
    const b = await pipeline.entry(project);
    assert.equal(b.key, e2, 'same project version, different card code → different whole-scene entry');
    assert.notEqual(a.dir, b.dir);
    versions = {};
    assert.equal((await pipeline.entry(project)).key, frameIdentity(project, CV));
  } finally {
    await pipeline.close?.();
  }

  // Local tier: different entry.key in content key → different result key
  const local = (entryKey, v) => splitFor({ entryKey, versions: v }).find((x) => x.tier === 'local');
  const l1 = local(e1, v1), l2 = local(e2, v2);
  assert.notEqual(l1.input.contentKey, l2.input.contentKey);
  assert.notEqual(l1.resultKey, l2.resultKey);
  assert.equal(l1.resultKey, resultKeyOf(`${e1}/sk-glass`, FP));
  // Shared tier: different source code version in key → different shared key (`card-identity.mjs`)
  const node = { cardId: 'price-tag', params: {} };
  const s1 = cardSnapshotIdentity(node, { sourceVersion: 'user:v1-source', fps: 30, phase: 0, duration: 60, stage: { width: 1920, height: 1080 } });
  const s2 = cardSnapshotIdentity(node, { sourceVersion: 'user:v2-source', fps: 30, phase: 0, duration: 60, stage: { width: 1920, height: 1080 } });
  assert.notEqual(s1, s2);
  // Nodes holding v1 do not claim v2 tasks, and vice versa
  const holder = (v) => ({ profile: 'host', envFingerprint: FP, codeVersions: [CV], capabilities: HOST_CAPABILITIES, cardSourceVersions: { 'price-tag': [v['price-tag']] } });
  for (const task of splitFor({ entryKey: e2, versions: v2 })) assert.equal(checkClaimable(task, holder(v1)).reason, 'card-source');
  for (const task of splitFor({ entryKey: e1, versions: v1 })) assert.equal(checkClaimable(task, holder(v2)).reason, 'card-source');

  // Executor: for same project revision, when card code revision changes, recompute context with
  // new code (do not match tasks against old control)
  let stamp = 0;
  let planned = 0;
  const fakePipeline = { async planForQueue() { planned++; return { entry: { key: `e${planned}`, cardPlan: [] }, context: { cardPlan: [] } }; } };
  const projects = { async get() { return { tracks: [], duration: 1 }; } };
  const executor = createPrerenderExecutor({ pipeline: fakePipeline, projects, codeStamp: () => stamp });
  const planTask = { id: 'plan:p@1', kind: 'plan', source: { projectId: 'p', projectRev: 1 } };
  await executor.plan(planTask);
  await executor.plan(planTask);
  assert.equal(planned, 1, 'epoch unchanged: reuse');
  stamp = 1;
  await executor.plan(planTask);
  assert.equal(planned, 2, 'card code changed: recompute');
});

/* ================================================================== HC5 */

test('HC5 index of card code identities: nothing is reported for a while after a change; not cached when the algorithm is not injected; computed on demand', () => {
  let now = 1000;
  let ready = false;
  let calls = 0;
  const index = createCardCodeIndex({
    identityOf: (id) => { calls++; if (!ready) return undefined; return id === 'x' ? { version: 'vx', custom: true } : id === 'b' ? { version: 'vb', custom: false } : null; },
    now: () => now, settleMs: 1500,
  });
  assert.deepEqual(index.view.x, [], 'algorithm not injected');
  assert.deepEqual(index.projectVersions({ tracks: [{ clips: [{ cardId: 'x' }] }] }), {});
  ready = true;
  assert.deepEqual(index.view.x, ['vx'], 'the previous "none" was not cached');
  assert.deepEqual(index.view.b, ['vb'], 'unmodified built-in cards also report an identity (the node side makes no distinction)');
  assert.deepEqual(index.view.nope, []);
  assert.deepEqual(index.projectVersions({ tracks: [{ clips: [{ cardId: 'x' }, { cardId: 'b' }] }], cardNodes: [{ cardId: 'x' }] }), { x: 'vx' }, 'lists custom cards only');
  const before = calls;
  void index.view.x;
  assert.equal(calls, before, 'cached per card');
  index.invalidate();
  assert.equal(index.epoch, 1);
  assert.deepEqual(index.view.x, [], 'just changed: not reported');
  now += 1499;
  assert.deepEqual(index.view.x, []);
  now += 1;
  assert.deepEqual(index.view.x, ['vx'], 'back to normal once stable');
  index.touch();
  assert.deepEqual(index.view.x, [], 'about to install a card: restart the timer');
  assert.equal(index.epoch, 1, 'touch does not change the epoch');
  assert.deepEqual(projectCardIds({ tracks: [{ clips: [{ cardId: 'b' }] }], cuts: [{ tracks: [{ clips: [{ cardId: 'a' }] }] }], cardNodes: { n1: { cardId: 'c' } } }), ['a', 'b', 'c']);
});

/* ================================================================== HC6 */

test('HC6 the host\'s card sync is read-only: when the local copy differs from the one on the service, the service\'s is installed and nothing is ever written into the project', { timeout: 20000 }, async (t) => {
  const doc = await startDoc(t);
  await putCard(doc, USER_KEY, cardSource('server'));
  // Host checkout already has a different copy (e.g. installed from another project)
  const hostRoot = checkout('pc-hc6-host-', { [USER_KEY]: cardSource('local') });
  const overlay = tmp('pc-hc6-overlay-');
  const hostData = tmp('pc-hc6-data-');
  process.env.PROMPTCUT_CARD_OVERRIDES = overlay;
  t.after(() => { delete process.env.PROMPTCUT_CARD_OVERRIDES; });
  const endpoint = createWsEndpoint({ url: doc.url('renderbox', 'render'), protocols: () => ['promptcut.v1'], backoff: { baseMs: 50, maxMs: 200 } });
  t.after(() => endpoint.close());
  const sent = [];
  const spy = { ...endpoint, send: (m) => { sent.push(m.type); return endpoint.send(m); }, onMessage: (h) => endpoint.onMessage(h), onOpen: (h) => endpoint.onOpen(h), onClose: (h) => endpoint.onClose(h), get connected() { return endpoint.connected; } };
  const sync = cards.createHostCardSync({ root: hostRoot, dataDir: hostData, projectId: 'proj-hc6', url: doc.url('renderbox', 'render'), endpoint: spy });
  t.after(() => sync.close());
  const overlayFile = path.join(overlay, USER_KEY);
  await waitFor(() => fs.existsSync(overlayFile), 5000, 'installed into the overlay layer');
  await sync.idle();
  assert.equal(fs.readFileSync(overlayFile, 'utf8'), cardSource('server'));
  assert.equal(fs.readFileSync(path.join(hostRoot, USER_KEY), 'utf8'), cardSource('local'), 'the base copy is untouched');
  assert.ok(!sent.includes('content.put'), `read-only: content.put was not sent (sent ${[...new Set(sent)].join(', ')})`);
  const got = await rpc(doc, { type: 'content.get', kind: 'card-source', key: USER_KEY });
  assert.equal(got.rev, 1, 'cardRev in the project was not raised by the host');
  assert.equal(got.body, cardSource('server'));
  // Modify another copy locally: still not uploaded
  put(overlay, USER_KEY, cardSource('local-again'));
  assert.equal(sync.status().pending?.length ?? 0, 0);
  // Backed up in host's own data directory, not under checkout's out/
  assert.ok(!fs.existsSync(path.join(hostRoot, 'out')), 'there is no out/card-edits in the checkout');
  void sha;
});

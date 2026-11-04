/**
 * Push only pushes artifacts of bound project (`server/push-scope.mjs`, `scope` of
 * `artifact-push.mjs`), and on legacy path startup, pushes to configured / registered asset service
 * on first push (`server/asset-select.mjs`).
 * Report `docs/archive/agent-reports/AGENT-push-scope.md`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPushQueue, PUSH_QUEUE_FILE } from '../artifact-push.mjs';
import { ALL, createPushScope } from '../push-scope.mjs';
import { selectAssetClient, foreignAssetEndpoints } from '../asset-select.mjs';
import { normalizeEntry } from '../auth/shared-config.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'push-scope-'));

/**
 * Two projects in frame store simultaneously: A (docA) and B (docB); shared tier keys
 * kA / kB / kAB (used by both projects), one version each in local tier.
 */
function twoProjects() {
  const entries = new Map([
    ['eA', { key: 'eA', project: { id: 'docA' }, cardPlan: [{ snapshotKey: 'kA', contentKey: 'cA' }, { snapshotKey: 'kAB', contentKey: 'cAB' }, { snapshotKey: 'lA', contentKey: 'clA', tier: 'local' }] }],
    ['eB', { key: 'eB', project: { id: 'docB' }, cardPlan: [{ snapshotKey: 'kB', contentKey: 'cB' }, { snapshotKey: 'kAB', contentKey: 'cAB' }, { snapshotKey: 'lB', contentKey: 'clB', tier: 'local' }] }],
  ]);
  const SA = 'a'.repeat(64), SB = 'b'.repeat(64), SX = 'c'.repeat(64);
  const streams = new Map([
    [SA, { entryKey: 'eA', spec: { members: [{ contentKey: 'cA' }] } }],
    [SB, { entryKey: 'eB', spec: { members: [{ contentKey: 'cB' }] } }],
    // This stream's state is recorded on B's version, but member card is also used by A
    // (content addressing): counts as A's
    [SX, { entryKey: 'eB', spec: { members: [{ contentKey: 'cAB' }] } }],
  ]);
  return { pipeline: { root: null, entries, streamProducer: () => ({ streams }) }, SA, SB, SX };
}

const units = ({ SA, SB, SX }) => ({
  sharedA: { kind: 'snapshot', tier: 'shared', resultKey: 'kA', range: { from: 0, to: 29 } },
  sharedB: { kind: 'snapshot', tier: 'shared', resultKey: 'kB', range: { from: 0, to: 29 } },
  sharedAB: { kind: 'snapshot', tier: 'shared', resultKey: 'kAB', range: { from: 0, to: 29 } },
  localA: { kind: 'snapshot', tier: 'local', resultKey: 'rlA', dirKey: 'lA', entryKey: 'eA', range: { from: 0, to: 29 } },
  localB: { kind: 'snapshot', tier: 'local', resultKey: 'rlB', dirKey: 'lB', entryKey: 'eB', range: { from: 0, to: 29 } },
  streamA: { kind: 'stream', resultKey: SA, range: { from: 0, to: 3 } },
  streamB: { kind: 'stream', resultKey: SB, range: { from: 0, to: 3 } },
  streamX: { kind: 'stream', resultKey: SX, range: { from: 0, to: 3 } },
  orphan: { kind: 'snapshot', tier: 'shared', resultKey: 'kGone', range: { from: 0, to: 29 } },
});

const fakeClient = () => ({ put: async () => ({ uploaded: true }), has: async () => false, get: async () => null });
const queueOf = (pipeline, dir, scope) => createPushQueue({ pipeline, client: fakeClient(), content: { put: async () => {} }, dir, attach: false, gate: false, scope });
const ids = queue => queue.stats().items.map(i => i.id).sort();
const fileIds = dir => JSON.parse(fs.readFileSync(path.join(dir, PUSH_QUEUE_FILE), 'utf8')).items.map(i => `${i.unit.kind}:${i.unit.resultKey}`).sort();

test('PS-01 frames of two projects enter the frame store at the same time: only those of the bound project go into the push queue and the queue file', async () => {
  const world = twoProjects();
  const u = units(world);
  const dir = tmp();
  const scope = createPushScope({ pipeline: world.pipeline, contentIds: () => ['docA'] });
  const queue = queueOf(world.pipeline, dir, scope);
  for (const unit of Object.values(u)) await queue.enqueue(unit);
  assert.deepEqual(ids(queue), [
    'snapshot:kA:0-29', 'snapshot:kAB:0-29', 'snapshot:rlA:0-29', `stream:${world.SA}:0-3`, `stream:${world.SX}:0-3`,
  ].sort());
  assert.equal(queue.stats().outOfScope, 4, 'the shared tier, local tier and stream of B, plus the segment with no entry found');
  assert.deepEqual(fileIds(dir), ['snapshot:kA', 'snapshot:kAB', 'snapshot:rlA', `stream:${world.SA}`, `stream:${world.SX}`].sort());
  // Layer table: only writes for bound project
  assert.equal(queue.putLayerMap('docA', { layers: [] }), true);
  assert.equal(queue.putLayerMap('docB', { layers: [] }), false);
  assert.equal(queue.stats().layerMapsOutOfScope, 1);
  await queue.stop();
});

test('PS-02 unrestricted (ALL) and no scope given: same behavior as before, everything is queued', async () => {
  const world = twoProjects();
  const u = units(world);
  for (const scope of [null, createPushScope({ pipeline: world.pipeline, contentIds: () => ALL })]) {
    const queue = queueOf(world.pipeline, tmp(), scope);
    for (const unit of Object.values(u)) await queue.enqueue(unit);
    assert.equal(queue.stats().items.length, Object.keys(u).length);
    assert.equal(queue.stats().outOfScope, 0);
    assert.equal(queue.putLayerMap('docB', { layers: [] }), true);
    await queue.stop();
  }
});

test('PS-03 the document id of the bound project has not arrived yet: hold items back, neither queued nor written to disk; once it arrives, rescope releases only those of the bound project', async () => {
  const world = twoProjects();
  const u = units(world);
  const dir = tmp();
  let bound = null;
  const scope = createPushScope({ pipeline: world.pipeline, contentIds: () => (bound ? [bound] : null) });
  const queue = queueOf(world.pipeline, dir, scope);
  await queue.enqueue(u.sharedA, 1);
  await queue.enqueue(u.sharedB);
  await queue.enqueue(u.localA);
  assert.equal(queue.stats().items.length, 0);
  assert.equal(queue.stats().deferred, 3);
  assert.equal(queue.putLayerMap('docA', { layers: [] }), false, 'a layer table that cannot be judged is not written');
  assert.equal(fs.existsSync(path.join(dir, PUSH_QUEUE_FILE)), false);
  assert.deepEqual(queue.rescope(), { queued: 0, dropped: 0, held: 3 }, 'keep holding while it is still unknown');
  bound = 'docA';
  assert.deepEqual(queue.rescope(), { queued: 2, dropped: 1, held: 0 });
  assert.deepEqual(ids(queue), ['snapshot:kA:0-29', 'snapshot:rlA:0-29']);
  assert.equal(queue.stats().items.find(i => i.id === 'snapshot:kA:0-29').priority, 'low', 'the priority from when it was held is carried over');
  await queue.stop();
  assert.deepEqual(fileIds(dir), ['snapshot:kA', 'snapshot:rlA']);
});

test('PS-04 rebinding and unbinding: queue files are split into directories by project, what the old project has not finished pushing stays in the old directory, and the new project takes only its own', async () => {
  const world = twoProjects();
  const u = units(world);
  const root = tmp();
  const dirA = path.join(root, 'push', 'host-PA'), dirB = path.join(root, 'push', 'host-PB');
  // Bind A
  const qA = queueOf(world.pipeline, dirA, createPushScope({ pipeline: world.pipeline, contentIds: () => ['docA'] }));
  await qA.enqueue(u.sharedA); await qA.enqueue(u.sharedB);
  await qA.stop();   // Change binding: tear down A's queue (unpushed items remain in dirA)
  // Rebind B
  const qB = queueOf(world.pipeline, dirB, createPushScope({ pipeline: world.pipeline, contentIds: () => ['docB'] }));
  assert.equal(qB.stats().restored, 0, 'the directory of B has no segment of A');
  await qB.enqueue(u.sharedA); await qB.enqueue(u.sharedB); await qB.enqueue(u.localB);
  assert.deepEqual(ids(qB), ['snapshot:kB:0-29', 'snapshot:rlB:0-29']);
  await qB.stop();   // Unbind
  assert.deepEqual(fileIds(dirA), ['snapshot:kA']);
  assert.deepEqual(fileIds(dirB), ['snapshot:kB', 'snapshot:rlB']);
  assert.equal(fs.existsSync(path.join(root, PUSH_QUEUE_FILE)), false, 'the old queue file at the frame store root is not written');
  // Bind back to A: resume pushing what A left behind, read-back items are no longer scope-checked
  // (file only contains A's)
  const qA2 = queueOf(world.pipeline, dirA, createPushScope({ pipeline: world.pipeline, contentIds: () => ['docA'] }));
  assert.equal(qA2.stats().restored, 1);
  assert.deepEqual(ids(qA2), ['snapshot:kA:0-29']);
  await qA2.stop();
});

test('PS-05 the shared config on the legacy path may set contentId (optional; an invalid value throws an error)', () => {
  const base = { url: 'ws://127.0.0.1:1/docservice', projectId: 'sp_' + 'a'.repeat(26), username: 'u1', password: 'x', deviceId: 'd'.repeat(16), deviceName: 'dev' };
  assert.equal(normalizeEntry(base).contentId, null);
  assert.equal(normalizeEntry({ ...base, contentId: 'doc-1' }).contentId, 'doc-1');
  assert.throws(() => normalizeEntry({ ...base, contentId: 7 }), /contentId/);
  assert.throws(() => normalizeEntry({ ...base, contentId: '' }), /contentId/);
});

/* ---------------- Legacy path startup: push to configured / registered asset service on first push ---------------- */

function assetWorld() {
  const calls = [];
  let deliver = null;
  const node = { watchServiceEndpoints: (_ep, _kinds, onChange) => { deliver = onChange; return () => { deliver = null; }; } };
  const createAssetClient = ({ base }) => ({ base, put: async (ns) => { calls.push({ base, ns }); return { uploaded: true }; }, has: async () => false });
  return { calls, node, createAssetClient, deliver: list => deliver?.(list) };
}
const common = w => ({ node: w.node, endpoint: {}, origin: 'http://127.0.0.1:5670', ticket: null, createAssetClient: w.createAssetClient, owner: 'push', self: 'asset:me' });
const FOREIGN = [{ kind: 'asset', announcerId: 'asset:pc', urls: ['http://10.0.0.2:5460/api/asset'] }];

test('AS-01 no explicit base URL: the first push waits until registration arrives before sending, and goes straight to the registered asset service (without going to local first)', async () => {
  const w = assetWorld();
  const log = [];
  const sel = selectAssetClient({ ...common(w), envBase: '', settleMs: 60_000, log: (e, f) => log.push([e, f]) });
  assert.equal(sel.settled(), false);
  const pushed = sel.client.put('snap', Buffer.from('x'));   // Segments in queue file not finished pushing last time: pushed right at startup
  await new Promise(r => setTimeout(r, 20));
  assert.equal(w.calls.length, 0, 'no push before registration arrives');
  w.deliver(FOREIGN);
  await pushed;
  assert.deepEqual(w.calls.map(c => c.base), ['http://10.0.0.2:5460/api/asset']);
  assert.equal(sel.settled(), true);
  assert.equal(log.find(([e]) => e === 'push.asset-ready')[1].source, 'announced');
  // Once settled, switch according to registration as usual
  w.deliver([]);
  await sel.client.put('snap', Buffer.from('y'));
  assert.equal(w.calls.at(-1).base, 'http://127.0.0.1:5670/api/asset');
  sel.stop();
});

test('AS-02 registration is empty: local; document service unreachable: wait out the full settleMs, then local; environment variable: use it immediately, no waiting', async () => {
  {
    const w = assetWorld();
    const sel = selectAssetClient({ ...common(w), envBase: '', settleMs: 60_000 });
    const p = sel.client.put('snap', Buffer.from('x'));
    w.deliver([{ kind: 'asset', announcerId: 'asset:me', urls: ['http://10.0.0.9:1/api/asset'] }]);   // Only what this machine registered itself
    await p;
    assert.deepEqual(w.calls.map(c => c.base), ['http://127.0.0.1:5670/api/asset']);
    sel.stop();
  }
  {
    const w = assetWorld();
    const sel = selectAssetClient({ ...common(w), envBase: '', settleMs: 30 });
    await sel.client.put('snap', Buffer.from('x'));
    assert.deepEqual(w.calls.map(c => c.base), ['http://127.0.0.1:5670/api/asset']);
    sel.stop();
  }
  {
    const w = assetWorld();
    const sel = selectAssetClient({ ...common(w), envBase: 'http://10.0.0.5:5460/api/asset/', settleMs: 60_000 });
    assert.equal(sel.settled(), true);
    await sel.client.put('snap', Buffer.from('x'));
    assert.deepEqual(w.calls.map(c => c.base), ['http://10.0.0.5:5460/api/asset']);
    sel.stop();
  }
});

test('AS-03 the page gave an asset base URL: use it immediately; one the page gives late is also picked ahead of the registration', async () => {
  const w = assetWorld();
  let page = null;
  const sel = selectAssetClient({ ...common(w), envBase: '', settleMs: 60_000, preferred: () => page });
  const p = sel.client.put('snap', Buffer.from('x'));
  page = 'https://cloud.example/api/asset';
  sel.client.has('snap', 'h');   // Every fetch checks whether the page provided it
  await p;
  assert.deepEqual(w.calls.map(c => c.base), ['https://cloud.example/api/asset']);
  sel.stop();
  assert.deepEqual(foreignAssetEndpoints(FOREIGN, 'http://127.0.0.1:5670', { self: 'asset:me' })[0].urls, ['http://10.0.0.2:5460/api/asset']);
});

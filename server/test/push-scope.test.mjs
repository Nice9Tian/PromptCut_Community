/**
 * 推送只推绑定项目的产物(`server/push-scope.mjs`、`artifact-push.mjs` 的 `scope`),
 * 以及老路径起步时第一次推送就去配置的 / 已登记的素材服务(`server/asset-select.mjs`)。
 * 报告 `docs/archive/agent-reports/AGENT-push-scope.md`。
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

/** 帧库里同时有两个项目:A(docA)与 B(docB);共享档键 kA / kB / kAB(两个项目都用),本地档各一版 */
function twoProjects() {
  const entries = new Map([
    ['eA', { key: 'eA', project: { id: 'docA' }, cardPlan: [{ snapshotKey: 'kA', contentKey: 'cA' }, { snapshotKey: 'kAB', contentKey: 'cAB' }, { snapshotKey: 'lA', contentKey: 'clA', tier: 'local' }] }],
    ['eB', { key: 'eB', project: { id: 'docB' }, cardPlan: [{ snapshotKey: 'kB', contentKey: 'cB' }, { snapshotKey: 'kAB', contentKey: 'cAB' }, { snapshotKey: 'lB', contentKey: 'clB', tier: 'local' }] }],
  ]);
  const SA = 'a'.repeat(64), SB = 'b'.repeat(64), SX = 'c'.repeat(64);
  const streams = new Map([
    [SA, { entryKey: 'eA', spec: { members: [{ contentKey: 'cA' }] } }],
    [SB, { entryKey: 'eB', spec: { members: [{ contentKey: 'cB' }] } }],
    // 这条流的 state 记在 B 那一版上,但成员卡 A 也用(内容寻址):算 A 的
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

test('PS-01 两个项目的帧同时进帧库:只有绑定项目的进推送队列与队列文件', async () => {
  const world = twoProjects();
  const u = units(world);
  const dir = tmp();
  const scope = createPushScope({ pipeline: world.pipeline, contentIds: () => ['docA'] });
  const queue = queueOf(world.pipeline, dir, scope);
  for (const unit of Object.values(u)) await queue.enqueue(unit);
  assert.deepEqual(ids(queue), [
    'snapshot:kA:0-29', 'snapshot:kAB:0-29', 'snapshot:rlA:0-29', `stream:${world.SA}:0-3`, `stream:${world.SX}:0-3`,
  ].sort());
  assert.equal(queue.stats().outOfScope, 4, 'B 的共享档、本地档、流,加上找不到 entry 的那一段');
  assert.deepEqual(fileIds(dir), ['snapshot:kA', 'snapshot:kAB', 'snapshot:rlA', `stream:${world.SA}`, `stream:${world.SX}`].sort());
  // 层表:只写绑定项目的
  assert.equal(queue.putLayerMap('docA', { layers: [] }), true);
  assert.equal(queue.putLayerMap('docB', { layers: [] }), false);
  assert.equal(queue.stats().layerMapsOutOfScope, 1);
  await queue.stop();
});

test('PS-02 不限(ALL)与不给 scope:行为与原来相同,全进队', async () => {
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

test('PS-03 绑定项目的文档 id 还没到:先扣着不进队也不落盘;到了 rescope 只放行绑定项目的', async () => {
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
  assert.equal(queue.putLayerMap('docA', { layers: [] }), false, '判不了的层表不写');
  assert.equal(fs.existsSync(path.join(dir, PUSH_QUEUE_FILE)), false);
  assert.deepEqual(queue.rescope(), { queued: 0, dropped: 0, held: 3 }, '还不知道就继续扣着');
  bound = 'docA';
  assert.deepEqual(queue.rescope(), { queued: 2, dropped: 1, held: 0 });
  assert.deepEqual(ids(queue), ['snapshot:kA:0-29', 'snapshot:rlA:0-29']);
  assert.equal(queue.stats().items.find(i => i.id === 'snapshot:kA:0-29').priority, 'low', '扣着时的优先级带过去');
  await queue.stop();
  assert.deepEqual(fileIds(dir), ['snapshot:kA', 'snapshot:rlA']);
});

test('PS-04 换绑定、撤绑定:队列文件按项目分目录,旧项目没推完的留在旧目录,新项目只收自己的', async () => {
  const world = twoProjects();
  const u = units(world);
  const root = tmp();
  const dirA = path.join(root, 'push', 'host-PA'), dirB = path.join(root, 'push', 'host-PB');
  // 绑 A
  const qA = queueOf(world.pipeline, dirA, createPushScope({ pipeline: world.pipeline, contentIds: () => ['docA'] }));
  await qA.enqueue(u.sharedA); await qA.enqueue(u.sharedB);
  await qA.stop();   // 换绑定:撤掉 A 的队列(没推完的留在 dirA)
  // 换绑 B
  const qB = queueOf(world.pipeline, dirB, createPushScope({ pipeline: world.pipeline, contentIds: () => ['docB'] }));
  assert.equal(qB.stats().restored, 0, 'B 的目录里没有 A 的段');
  await qB.enqueue(u.sharedA); await qB.enqueue(u.sharedB); await qB.enqueue(u.localB);
  assert.deepEqual(ids(qB), ['snapshot:kB:0-29', 'snapshot:rlB:0-29']);
  await qB.stop();   // 撤绑定
  assert.deepEqual(fileIds(dirA), ['snapshot:kA']);
  assert.deepEqual(fileIds(dirB), ['snapshot:kB', 'snapshot:rlB']);
  assert.equal(fs.existsSync(path.join(root, PUSH_QUEUE_FILE)), false, '帧库根的老队列文件不写');
  // 再绑回 A:接着推 A 留下的,读回的不再判范围(文件里只有 A 的)
  const qA2 = queueOf(world.pipeline, dirA, createPushScope({ pipeline: world.pipeline, contentIds: () => ['docA'] }));
  assert.equal(qA2.stats().restored, 1);
  assert.deepEqual(ids(qA2), ['snapshot:kA:0-29']);
  await qA2.stop();
});

test('PS-05 老路径的共享配置可以写 contentId(可选,不合格报错)', () => {
  const base = { url: 'ws://127.0.0.1:1/docservice', projectId: 'sp_' + 'a'.repeat(26), username: 'u1', password: 'x', deviceId: 'd'.repeat(16), deviceName: 'dev' };
  assert.equal(normalizeEntry(base).contentId, null);
  assert.equal(normalizeEntry({ ...base, contentId: 'doc-1' }).contentId, 'doc-1');
  assert.throws(() => normalizeEntry({ ...base, contentId: 7 }), /contentId/);
  assert.throws(() => normalizeEntry({ ...base, contentId: '' }), /contentId/);
});

/* ---------------- 老路径起步:第一次推送就去配置的 / 已登记的素材服务 ---------------- */

function assetWorld() {
  const calls = [];
  let deliver = null;
  const node = { watchServiceEndpoints: (_ep, _kinds, onChange) => { deliver = onChange; return () => { deliver = null; }; } };
  const createAssetClient = ({ base }) => ({ base, put: async (ns) => { calls.push({ base, ns }); return { uploaded: true }; }, has: async () => false });
  return { calls, node, createAssetClient, deliver: list => deliver?.(list) };
}
const common = w => ({ node: w.node, endpoint: {}, origin: 'http://127.0.0.1:5670', ticket: null, createAssetClient: w.createAssetClient, owner: 'push', self: 'asset:me' });
const FOREIGN = [{ kind: 'asset', announcerId: 'asset:pc', urls: ['http://10.0.0.2:5460/api/asset'] }];

test('AS-01 没有显式基址:第一次推送等到登记才发,直接去登记的素材服务(不先落本机)', async () => {
  const w = assetWorld();
  const log = [];
  const sel = selectAssetClient({ ...common(w), envBase: '', settleMs: 60_000, log: (e, f) => log.push([e, f]) });
  assert.equal(sel.settled(), false);
  const pushed = sel.client.put('snap', Buffer.from('x'));   // 队列文件里上次没推完的段:起步就推
  await new Promise(r => setTimeout(r, 20));
  assert.equal(w.calls.length, 0, '登记没到之前不推');
  w.deliver(FOREIGN);
  await pushed;
  assert.deepEqual(w.calls.map(c => c.base), ['http://10.0.0.2:5460/api/asset']);
  assert.equal(sel.settled(), true);
  assert.equal(log.find(([e]) => e === 'push.asset-ready')[1].source, 'announced');
  // 定下来之后照旧按登记换
  w.deliver([]);
  await sel.client.put('snap', Buffer.from('y'));
  assert.equal(w.calls.at(-1).base, 'http://127.0.0.1:5670/api/asset');
  sel.stop();
});

test('AS-02 登记是空的:本机;连不上文档服务:等满 settleMs 落本机;环境变量:立即用它,不等', async () => {
  {
    const w = assetWorld();
    const sel = selectAssetClient({ ...common(w), envBase: '', settleMs: 60_000 });
    const p = sel.client.put('snap', Buffer.from('x'));
    w.deliver([{ kind: 'asset', announcerId: 'asset:me', urls: ['http://10.0.0.9:1/api/asset'] }]);   // 只有本机自己登记的
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

test('AS-03 页面给了素材基址:立即用它;页面晚给的也在登记之前被选上', async () => {
  const w = assetWorld();
  let page = null;
  const sel = selectAssetClient({ ...common(w), envBase: '', settleMs: 60_000, preferred: () => page });
  const p = sel.client.put('snap', Buffer.from('x'));
  page = 'https://cloud.example/api/asset';
  sel.client.has('snap', 'h');   // 任何一次取用都会看页面给没给
  await p;
  assert.deepEqual(w.calls.map(c => c.base), ['https://cloud.example/api/asset']);
  sel.stop();
  assert.deepEqual(foreignAssetEndpoints(FOREIGN, 'http://127.0.0.1:5670', { self: 'asset:me' })[0].urls, ['http://10.0.0.2:5460/api/asset']);
});

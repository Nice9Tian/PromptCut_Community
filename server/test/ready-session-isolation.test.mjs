/**
 * Item 4:预渲染进程的就绪索引按会话隔离、按版本收口(`docs/reports/REPORT-item4-session-isolation.md`)。
 * 跑:node --test server/test/ready-session-isolation.test.mjs
 *
 * 覆盖三类并发场景:
 *   1. 旧批次晚到 —— 会话换到下一版之后,上一版还在跑的批次(整场景批、控件批、本地档、轨道流)交完;
 *   2. Agent / 导出混杂渲染 —— 别的版本的 `cardRender` / 落盘 / 发层不认领、不 reset、不污染页面会话;
 *   3. 多会话交替 —— 两个页面会话各自的版本交替前进,层不串到对方那里;preload 乱序到达时晚发出的赢。
 * 另有会话回收(断开的会话不常驻内存)。
 *
 * 真的:`ready-index.mjs` 的 hub、`FramePipeline.prototype` 上的 preload / adoptSession / adoptCardPlan /
 * recordCardPlan / cardRender / publishLayer / flushSnapshots / fillAnchorSnapshots 的收尾。
 * 假的:Chrome(`page.evaluate` 直接回 plan)、快照库的批,不碰盘。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePipeline } from '../frame-pipeline.mjs';
import { createReadyHub, DEFAULT_READY_SESSION } from '../ready-index.mjs';

const control = (clipId, snapshotKey, tier = 'shared') => ({ clipId, snapshotKey, tier, capabilities: { frameMode: 'stateful', compositing: tier === 'shared' ? 'independent' : 'belowDependent' } });
const fakeBatch = (clipId, key, frames = [[0, 9]], tier = 'shared') => ({ clipId, key, tier, written: true, close: async () => ({ frames }) });
const entryOf = (key, plan = null) => ({ key, project: { fps: 30, duration: 1, tracks: [] }, ...(plan ? { cardPlan: plan } : {}),
  // `cardRender` 只用到 plan / renderState 两样
  cardCache: { plan: browserPlan => browserPlan, renderState: async () => ({ frames: {}, missing: {} }) } });
const fakeBakery = plan => ({ page: { evaluate: async () => plan } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function pipeline(hub = createReadyHub()) {
  const p = Object.create(FramePipeline.prototype);
  p.ready = hub;
  p.root = undefined;
  p.generations = new Map();
  p.background = Promise.resolve();
  p.lanes = new Map();
  p.entries = new Map();
  // 后台那一趟不开 Chrome:一借就当被取消,preload 只剩「设版本 + 排活」这一半
  p.acquire = async () => { throw Object.assign(new Error('no chrome in unit test'), { cancelled: true }); };
  return p;
}
const watch = (p, session) => {
  const seen = [];
  const off = p.ready.subscribe(session, m => seen.push(m));
  return { seen, off, layers: () => p.ready.peek(session).index.list() };
};
const layerKeys = list => list.map(l => `${l.clipId}:${l.kind}:${l.key}`).sort();

/* ------------------------------------------------------------ 1. 旧批次晚到 */

test('late arrival of old batches: after the session switches to E2, E1\'s whole-scene batch, controls batch, local-tier batch and anchor-frame done are all rejected', async () => {
  const p = pipeline();
  const page = watch(p, 's');
  const E1 = entryOf('E1'), E2 = entryOf('E2');
  p.adoptSession('s', E1, 1);
  p.adoptCardPlan(E1, [control('h', 'KA'), control('blur', 'BA', 'local')]);
  E1.snapshotPending = new Map([['x', fakeBatch('h', 'KA')]]);

  p.adoptSession('s', E2, 2);
  p.adoptCardPlan(E2, [control('h', 'KB'), control('blur', 'BB', 'local')]);
  p.publishLayer(E2, control('h', 'KB'), 'shared', [[0, 4]]);
  page.seen.length = 0;

  // E1 还在跑的几条路此刻才交完
  await p.flushSnapshots(E1);                                                   // 整场景批(疑点 F)
  assert.equal(p.publishLayer(E1, control('h', 'KA'), 'shared', [[0, 30]]), 0);  // fillCardControls 的 4 帧批
  assert.equal(p.publishLayer(E1, control('blur', 'BA'), 'local', [[0, 3]]), 0); // renderLocalSnapshots
  p.ready.markDone(E1.key);                                                     // fillAnchorSnapshots 的收尾

  assert.deepEqual(page.seen, [], `not a single message from the old version should reach the page: ${JSON.stringify(page.seen)}`);
  assert.deepEqual(layerKeys(page.layers()), ['h:html:KB']);
  assert.equal(p.ready.peek('s').index.done, false, 'an old version\'s done does not count as this version\'s anchor frame being ready');
});

test('late arrival of old batches: after the session switches from E2 back to E1 (undo), E1\'s layers are valid again and E2\'s late arrivals are blocked instead', async () => {
  const p = pipeline();
  const page = watch(p, 's');
  const E1 = entryOf('E1', [control('h', 'KA')]), E2 = entryOf('E2', [control('h', 'KB')]);
  p.adoptSession('s', E1, 1);
  p.adoptSession('s', E2, 2);
  p.adoptSession('s', E1, 3);                                    // 撤销:内容回到第一版,键也回到 E1
  assert.equal(p.publishLayer(E2, control('h', 'KB'), 'shared', [[0, 9]]), 0);
  assert.equal(p.publishLayer(E1, control('h', 'KA'), 'shared', [[0, 9]]), 1);
  assert.deepEqual(layerKeys(page.layers()), ['h:html:KA']);
  assert.deepEqual(page.seen.filter(m => m.type === 'reset').map(m => m.localRev), [0, 1, 2, 3], 'one reset per version change (0 is the backlog at connect time)');
});

test('late arrival of old batches: when a track stream segment is written to disk, the stream already belongs to another version, so it is not sent to the session', () => {
  const p = pipeline();
  const page = watch(p, 's');
  p.adoptSession('s', entryOf('E2'), 2);
  page.seen.length = 0;
  // 生产者 `publish(state)` 的形状:按 state.entryKey 过闸
  assert.equal(p.ready.publish('E1', { clipId: 'h', kind: 'stream', key: 'S1', ranges: [[0, 3]] }), 0);
  assert.equal(p.ready.publish('E2', { clipId: 'h', kind: 'stream', key: 'S2', ranges: [[0, 1]] }), 1);
  assert.deepEqual(page.seen.filter(m => m.type === 'layer').map(m => m.key), ['S2']);
  assert.deepEqual(page.seen.map(m => m.type), ['reset', 'layer'], 'the pending reset is added only when E2 is first written in, right next to the new layer');
});

/* ------------------------------------------------------------ 2. Agent / 导出混杂渲染 */

test('cardRender for Agent / export / interactive frames rendering another version: records the plan only on its own entry, does not reset, and does not claim the page session', async () => {
  const p = pipeline();
  p.ready.stageByKey({ kind: 'html', key: 'KC', ranges: [[0, 99]] });   // 扫盘挂着 C 版的键
  const page = watch(p, 's');
  const E1 = entryOf('E1', [control('h', 'KA')]);
  p.adoptSession('s', E1, 1);
  p.publishLayer(E1, control('h', 'KA'), 'shared', [[0, 9]]);
  page.seen.length = 0;

  const C = entryOf('C');
  for (const lane of ['agent', 'final', 'background', 'user', 'playback']) {
    await p.cardRender(C, fakeBakery([control('h', 'KC')]), [0, 1], lane);
  }
  assert.deepEqual(C.cardPlan.map(c => c.snapshotKey), ['KC'], 'the plan is recorded on C itself');
  assert.ok(C.prerenderSet instanceof Set);
  assert.deepEqual(page.seen, [], `the page session should not receive a single message: ${JSON.stringify(page.seen)}`);
  assert.deepEqual(layerKeys(page.layers()), ['h:html:KA'], 'the page\'s layers are left as they were');
  assert.equal(p.ready.current('s'), 'E1');

  // Agent 那一版落盘、交批:没有会话在 C 上,全丢
  C.snapshotPending = new Map([['c', fakeBatch('h', 'KC')]]);
  await p.flushSnapshots(C);
  assert.deepEqual(page.seen, []);
});

test('preloads for export / reordering when resuming after a yield (adopt: false) do not change any session\'s version', async () => {
  const p = pipeline();
  const page = watch(p, 's');
  const E1 = entryOf('E1'), X = entryOf('X');
  p.entry = async project => (project.key === 'X' ? X : E1);
  await p.preload({ key: 'E1', id: 'p', duration: 1 }, { session: 's', localRev: 1 });
  assert.equal(p.ready.current('s'), 'E1');
  page.seen.length = 0;
  await p.preload({ key: 'X', id: 'p', duration: 1 }, { adopt: false, owner: 'session:s' });
  assert.equal(p.ready.current('s'), 'E1', 'adopt: false only schedules work');
  assert.deepEqual(page.seen, []);
  await p.background;
});

test('when the page\'s preload arrives, this version\'s plan has already been computed by the Agent: it claims the pending ranges at once, without waiting for the background queue to reach them', async () => {
  const p = pipeline();
  p.ready.stageByKey({ kind: 'html', key: 'KA', ranges: [[0, 40]] });
  const page = watch(p, 's');
  const E1 = entryOf('E1');
  await p.cardRender(E1, fakeBakery([control('h', 'KA')]), [0], 'agent');   // Agent 先渲过这一版
  assert.deepEqual(page.layers(), [], 'no claim was made while the Agent was rendering');
  p.entry = async () => E1;
  await p.preload({ id: 'p', duration: 1 }, { session: 's', localRev: 7 });
  assert.deepEqual(page.layers(), [{ clipId: 'h', kind: 'html', key: 'KA', ranges: [[0, 40]] }]);
  assert.deepEqual(page.seen.filter(m => m.type === 'reset').at(-1), { type: 'reset', localRev: 7 });
  await p.background;
});

/* ------------------------------------------------------------ 3. 多会话交替 */

test('two sessions advance in alternation: each receives only layers of its own version, and nothing gets mixed up even when the shared keys are the same', () => {
  const p = pipeline();
  const a = watch(p, 'tab-a'), b = watch(p, 'tab-b');
  const A1 = entryOf('A1'), B1 = entryOf('B1'), A2 = entryOf('A2'), B2 = entryOf('B2');
  p.adoptSession('tab-a', A1, 1);
  p.adoptSession('tab-b', B1, 1);
  // 两个版本里同一张卡的共享键一样(内容没变),各自发各自的
  p.publishLayer(A1, control('h', 'K'), 'shared', [[0, 3]]);
  p.publishLayer(B1, control('h', 'K'), 'shared', [[0, 9]]);
  assert.deepEqual(a.layers()[0].ranges, [[0, 3]]);
  assert.deepEqual(b.layers()[0].ranges, [[0, 9]]);

  p.adoptSession('tab-a', A2, 2);
  p.publishLayer(B1, control('g', 'G'), 'shared', [[0, 1]]);      // B 那边继续长
  p.publishLayer(A1, control('h', 'K'), 'shared', [[0, 30]]);     // A 的旧版本晚到
  p.adoptSession('tab-b', B2, 2);
  p.publishLayer(A2, control('h', 'K2'), 'shared', [[0, 2]]);
  p.publishLayer(B1, control('g', 'G'), 'shared', [[0, 5]]);      // B 的旧版本晚到
  p.publishLayer(B2, control('g', 'G2'), 'shared', [[0, 6]]);

  assert.deepEqual(layerKeys(a.layers()), ['h:html:K2']);
  assert.deepEqual(layerKeys(b.layers()), ['g:html:G2']);
  const aReset = a.seen.filter(m => m.type === 'reset').length, bReset = b.seen.filter(m => m.type === 'reset').length;
  assert.equal(aReset, 3, 'A:backlog + A1 + A2');
  assert.equal(bReset, 3, 'B: backlog + B1 + B2: A\'s version change does not clear B\'s table');
  assert.ok(!a.seen.some(m => m.key === 'G' || m.key === 'G2'), 'B\'s layers did not leak into A');
  assert.ok(!b.seen.some(m => m.key === 'K2'), 'A\'s layers did not leak into B');
});

test('two sessions on the same version: one publish reaches both; when one switches away the other carries on as usual', () => {
  const p = pipeline();
  const a = watch(p, 'a'), b = watch(p, 'b');
  const E = entryOf('E');
  p.adoptSession('a', E, 1);
  p.adoptSession('b', E, 1);
  assert.equal(p.publishLayer(E, control('h', 'K'), 'shared', [[0, 3]]), 2);
  p.adoptSession('a', entryOf('F'), 2);
  assert.equal(p.publishLayer(E, control('h', 'K'), 'shared', [[0, 5]]), 1);
  assert.deepEqual(a.layers()[0].ranges, [[0, 3]], 'a switches to F (plan not computed yet): the old table holds for now, but new publishes for E do not get in');
  assert.deepEqual(b.layers()[0].ranges, [[0, 5]]);
});

test('preloads of the same session complete out of order: the version issued later wins (it takes a number), and old localRevs are not accepted either', async () => {
  const p = pipeline();
  const page = watch(p, 's');
  const E1 = entryOf('E1', [control('h', 'K1')]), E2 = entryOf('E2', [control('h', 'K2')]);
  // 第一个请求算 entry 慢(素材打戳),第二个快
  p.entry = async project => { await sleep(project.delay); return project.key === 'E1' ? E1 : E2; };
  const first = p.preload({ key: 'E1', delay: 40, duration: 1 }, { session: 's', localRev: 1 });
  const second = p.preload({ key: 'E2', delay: 1, duration: 1 }, { session: 's', localRev: 2 });
  await Promise.all([first, second]);
  assert.equal(p.ready.current('s'), 'E2', 'the one sent first finishes computing later and must not pull the session back to the old version');
  assert.equal(page.seen.filter(m => m.type === 'reset').length, 2, 'backlog + E2, and there was no reset for E1');
  const generation = p.generations.get('session:s');
  assert.equal(generation?.key, 'E2', 'an invalidated request schedules no background work');
  assert.equal(generation.controller.signal.aborted, false, 'and does not cut off the newer version\'s background generation');

  // 号对得上、但 localRev 比记着的旧:也不认
  const ticket = p.ready.request('s');
  assert.equal(p.ready.adopt('s', 'E1', 1, ticket), false);
  assert.equal(p.ready.current('s'), 'E2');
  await p.background;
});

test('/ready subscribes by session: the backlog contains only the layers of its own session; one without a session is the default session', () => {
  const p = pipeline();
  p.adoptSession('a', entryOf('A'), 4);
  p.publishLayer(entryOf('A'), control('h', 'KA'), 'shared', [[0, 1]]);
  p.adoptSession(DEFAULT_READY_SESSION, entryOf('D'), 0);
  p.publishLayer(entryOf('D'), control('h', 'KD'), 'shared', [[0, 1]]);
  const late = [];
  p.ready.subscribe('a', m => late.push(m));
  assert.deepEqual(late, [{ type: 'reset', localRev: 4 }, { type: 'layer', clipId: 'h', kind: 'html', key: 'KA', ranges: [[0, 1]] }]);
  assert.deepEqual(p.readyIndex.list().map(l => l.key), ['KD'], '`pipeline.readyIndex` is the default session\'s copy');
  const stranger = [];
  p.ready.subscribe('nobody', m => stranger.push(m));
  assert.deepEqual(stranger, [{ type: 'reset', localRev: 0 }], 'a session that never sent a preload has an empty table');
});

/* ------------------------------------------------------------ 回收 */

test('disconnected sessions do not stay resident: with no subscribers and past the idle time they are reclaimed; those with subscribers are never reclaimed', () => {
  let now = 0;
  const hub = createReadyHub({ now: () => now, idleMs: 1000, maxSessions: 100 });
  const offA = hub.subscribe('a', () => {});
  hub.subscribe('b', () => {});
  hub.adopt('c', 'E', 1);                  // 只发过 preload、没订阅
  now = 500;
  offA();                                  // a 断开
  now = 1400;
  hub.request('d');                        // 任何新会话进来时顺带回收
  assert.deepEqual(hub.describe().map(r => r.session).sort(), ['a', 'b', 'd'], 'c idle for 1400 > 1000, reclaimed');
  now = 1600;
  hub.subscribe('e', () => {})();
  assert.deepEqual(hub.describe().map(r => r.session).sort(), ['b', 'd', 'e'], 'a disconnected 1100 > 1000, reclaimed; b stays connected');
  // 被回收的会话再来就是新的:没有版本,发布进不去
  assert.equal(hub.current('c'), undefined);
  assert.equal(hub.publish('E', { clipId: 'h', kind: 'html', key: 'K', ranges: [[0, 0]] }), 0);
});

test('session count cap: when over the limit, first reclaim the one that has been inactive longest and has no subscribers', () => {
  let now = 0;
  const hub = createReadyHub({ now: () => now, idleMs: 1e9, maxSessions: 3 });
  hub.subscribe('live', () => {});
  for (const id of ['x1', 'x2', 'x3', 'x4']) { now++; hub.request(id); }
  const ids = hub.describe().map(r => r.session).sort();
  assert.equal(ids.length, 3);
  assert.ok(ids.includes('live'), 'those with subscribers are not reclaimed');
  assert.ok(ids.includes('x4'), 'the one that just came in is not reclaimed');
  assert.ok(!ids.includes('x1') && !ids.includes('x2'), 'the oldest goes first');
});

test('a session unsubscribing twice, or a subscriber throwing: does not affect other subscribers, and is not reclaimed twice', () => {
  const hub = createReadyHub();
  const good = [];
  hub.subscribe('s', () => { throw new Error('broken'); });
  const off = hub.subscribe('s', m => good.push(m));
  hub.adopt('s', 'E', 1);
  hub.publish('E', { clipId: 'h', kind: 'html', key: 'K', ranges: [[0, 0]] });
  assert.deepEqual(good.map(m => m.type), ['reset', 'reset', 'layer']);
  off(); off();
  assert.equal(hub.peek('s').index.subscriberCount(), 1);
});

test('shared staged: one session calling clear does not wipe the ranges other sessions need to claim', () => {
  const hub = createReadyHub();
  hub.stageByKey({ kind: 'html', key: 'K', ranges: [[0, 9]] });
  hub.session('a').index.clear();
  hub.adopt('b', 'E', 1);
  assert.equal(hub.claim('E', [{ clipId: 'h', kind: 'html', key: 'K' }]), 1);
  assert.deepEqual(hub.peek('b').index.list()[0].ranges, [[0, 9]]);
  // 再认领一次不重复发(区间没变)
  assert.equal(hub.claim('E', [{ clipId: 'h', kind: 'html', key: 'K' }]), 0);
});

/* ------------------------------------------------------------ 审查补的:真的调用点、保活、让路恢复 */

const fullIndex = { count: 3, frames: [[0, 2]], oversize: [] };
const planned = (clipId, key, tier = 'shared') => ({ ...control(clipId, key, tier), count: 3, sampling: { firstFrame: 0 }, end: 1 });

test('the real call sites: when missingSnapshotFrames / fillAnchorSnapshots render an old version, the layers and done they send cannot get into the session of the new version', async () => {
  const p = pipeline();
  p.snapshots = () => ({ snapshotIndex: async () => fullIndex });
  const page = watch(p, 's');
  const E1 = entryOf('E1', [planned('h', 'KA'), planned('blur', 'BA', 'local')]);
  const E2 = entryOf('E2', [planned('h', 'KB')]);
  p.adoptSession('s', E1, 1);
  p.adoptSession('s', E2, 2);
  page.seen.length = 0;
  // 旧版本的整场景那一趟在跑:它顺带把已有区间发成层、锚帧齐了发 done
  assert.deepEqual(await p.missingSnapshotFrames(E1, { tiers: ['shared', 'local'] }), []);
  await p.fillAnchorSnapshots(E1, null, null);
  assert.deepEqual(page.seen, [], `layers / done of the old version do not get in: ${JSON.stringify(page.seen)}`);
  // 正向对照:新版本自己的这两步照常到
  await p.missingSnapshotFrames(E2, { tiers: ['shared'] });
  await p.fillAnchorSnapshots(E2, null, null);
  assert.deepEqual(page.seen.map(m => m.type), ['layer', 'layer', 'done']);
  assert.ok(page.seen.filter(m => m.type === 'layer').every(m => m.key === 'KB'));
});

test('two tabs keep the same ready version alive: the later session gets all layers and done on the spot; each re-runs at most one pass, after which the keep-alive does not cut each other off and does not re-run again', async () => {
  const p = pipeline();
  p.snapshots = () => ({ snapshotIndex: async () => fullIndex });
  const E = entryOf('E', [planned('h', 'K')]);
  p.entries.set('E', E);
  p.entry = async () => E;
  let acquired = 0;
  p.acquire = async () => { acquired++; throw Object.assign(new Error('no chrome'), { cancelled: true }); };
  const a = watch(p, 'a');
  // a 的那一趟在本进程里跑完了:层已经发过(也就挂进了 staged)、锚帧齐了
  await p.preload({ id: 'p', duration: 1 }, { session: 'a', localRev: 1 });
  await p.background;
  acquired = 0;
  await p.missingSnapshotFrames(E, { tiers: ['shared'] });
  await p.fillAnchorSnapshots(E, null, null);
  E.status = 'ready';
  assert.deepEqual(layerKeys(a.layers()), ['h:html:K']);

  const b = watch(p, 'b');
  await p.preload({ id: 'p', duration: 1 }, { session: 'b', localRev: 1 });
  assert.deepEqual(layerKeys(b.layers()), ['h:html:K'], 'claimed back from staged on the spot, without waiting for the background pass');
  assert.equal(p.ready.peek('b').index.done, true, 'the anchor frames were complete long ago: done is also filled in');
  await p.background;
  assert.equal(acquired, 1, 'a new session re-runs one pass the first time it comes (mostly cache hits)');
  E.status = 'ready';                    // 那一趟跑完了(单测里没有 Chrome,手动置回)
  acquired = 0;
  // 30 秒保活一轮一轮地来(远超 PRELOAD_STALE_MS):谁都不重跑
  for (const at of [40000, 80000, 120000]) {
    p.generations.forEach(g => { g.seenAt -= at; });
    await p.preload({ id: 'p', duration: 1 }, { session: 'a', localRev: 1 });
    await p.preload({ id: 'p', duration: 1 }, { session: 'b', localRev: 1 });
  }
  await p.background;
  assert.equal(acquired, 0, 'a version that is already ready no longer opens a background Chrome');
  assert.equal(E.status, 'ready');
  assert.ok(p.generations.has('session:a') && p.generations.has('session:b'), 'a finished generation is not mistaken for stale and cut off');
});

test('yield resume: a version that no session sits on anymore after the yield is not reordered; one that still has sessions is handed back to the original owner as usual', async () => {
  const p = pipeline();
  const E1 = entryOf('E1'), E2 = entryOf('E2'), E3 = entryOf('E3');
  p.adoptSession('s', E1, 1);
  p.adoptSession('s', E2, 2);            // 让路期间会话 s 换到了 E2,没人停在 E1 了
  p.adoptSession('t', E3, 1);
  p.adoptSession(DEFAULT_READY_SESSION, E2, undefined);   // 脚本(缺省会话)也在 E2
  p.pausedPreloads = new Map([['session:s', E1], ['session:t', E3], ['proj', E2]]);
  p.backgroundLeaseOwner = 'o';
  p.backgroundLeaseVersion = 1;
  const resumed = [];
  p.preload = async (project, options) => { resumed.push(options); };
  await p.resumeBackground('o');
  assert.deepEqual(resumed, [{ adopt: false, owner: 'session:t' }, { adopt: false, owner: 'proj' }]);
  assert.equal(p.ready.current('s'), 'E2');
});

test('a session that is reclaimed and recreated after taking a number: not counted as superseded, and the preload claims as usual', () => {
  let now = 0;
  const hub = createReadyHub({ now: () => now, idleMs: 10 });
  const ticket = hub.request('s');
  now = 100;
  hub.request('other');                  // 顺带把 s 回收掉
  assert.equal(hub.peek('s'), undefined);
  assert.equal(hub.stale('s', ticket, 1), false);
  assert.equal(hub.adopt('s', 'E', 1, ticket), true);
  assert.equal(hub.current('s'), 'E');
});

test('staged cap: when over the limit, drop the key untouched the longest', () => {
  const hub = createReadyHub({ maxStaged: 2 });
  hub.stageByKey({ kind: 'html', key: 'A', ranges: [[0, 0]] });
  hub.stageByKey({ kind: 'html', key: 'B', ranges: [[0, 0]] });
  hub.stageByKey({ kind: 'html', key: 'A', ranges: [[1, 1]] });   // A 刚用过
  hub.stageByKey({ kind: 'html', key: 'C', ranges: [[0, 0]] });
  assert.deepEqual(hub.stagedKeys().map(s => s.key), ['A', 'C']);
});

test('session parameter validation: omitted = default session, too long / non-string = rejected', async () => {
  const { readySessionOf, READY_SESSION_ID_MAX } = await import('../ready-index.mjs');
  assert.equal(readySessionOf(undefined), DEFAULT_READY_SESSION);
  assert.equal(readySessionOf('abc'), 'abc');
  assert.equal(readySessionOf('x'.repeat(READY_SESSION_ID_MAX + 1)), null);
  assert.equal(readySessionOf(42), null);
});

test('after recomputing with the new costs the set shrank: the old layer of the card classified as light is removed from the session (reset + re-adding all the remaining layers from staged)', () => {
  const p = pipeline();
  const E = entryOf('E');
  const page = watch(p, 's');
  // 第一次:两张都判重(没有成本记录,按声明兜底)
  p.adoptSession('s', E, 1);
  p.adoptCardPlan(E, [planned('heavy', 'KH'), planned('light', 'KL')]);
  p.publishLayer(E, planned('heavy', 'KH'), 'shared', [[0, 2]]);
  p.publishLayer(E, planned('light', 'KL'), 'shared', [[0, 2]]);
  assert.deepEqual(layerKeys(page.layers()), ['heavy:html:KH', 'light:html:KL']);
  // 新的成本记录让 light 判轻:下一趟的计划只挑 heavy
  p.recordCardPlan = function (entry, plan) { entry.cardPlan = plan; entry.prerenderSet = new Set(['heavy']); return plan; };
  page.seen.length = 0;
  p.adoptCardPlan(E, [planned('heavy', 'KH'), planned('light', 'KL')]);
  assert.deepEqual(layerKeys(page.layers()), ['heavy:html:KH'], 'the one classified as light is removed, the one classified as heavy is added back');
  assert.deepEqual(page.seen.map(m => m.type), ['reset', 'layer']);
  // 集合没再缩:不再 reset
  page.seen.length = 0;
  p.adoptCardPlan(E, [planned('heavy', 'KH'), planned('light', 'KL')]);
  assert.deepEqual(page.seen, []);
});

test('switching to a new version whose plan is not computed yet: the old table holds for now (the gate has already switched over), and once the plan arrives the reset and the layer top-up are sent back to back', () => {
  const p = pipeline();
  p.ready.stageByKey({ kind: 'html', key: 'KB', ranges: [[0, 5]] });
  const page = watch(p, 's');
  const E1 = entryOf('E1', [control('h', 'KA')]);
  p.adoptSession('s', E1, 1);
  p.publishLayer(E1, control('h', 'KA'), 'shared', [[0, 9]]);
  page.seen.length = 0;
  const E2 = entryOf('E2');                                    // 刚编辑完,计划还没算
  assert.equal(p.adoptSession('s', E2, 2), true);
  assert.deepEqual(page.seen, [], 'table not cleared');
  assert.deepEqual(layerKeys(page.layers()), ['h:html:KA'], 'the old layers hold');
  assert.equal(p.publishLayer(E1, control('h', 'KA'), 'shared', [[0, 20]]), 0, 'the gate has switched: the old version cannot get in');
  assert.equal(p.ready.describe().find(r => r.session === 's').pendingReset, true);
  p.adoptCardPlan(E2, [control('h', 'KB')]);                    // 后台那一趟算出了计划
  assert.deepEqual(page.seen, [{ type: 'reset', localRev: 2 }, { type: 'layer', clipId: 'h', kind: 'html', key: 'KB', ranges: [[0, 5]] }]);
});

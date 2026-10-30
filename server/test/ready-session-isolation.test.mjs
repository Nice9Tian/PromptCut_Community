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

test('旧批次晚到:会话换到 E2 之后,E1 的整场景批、控件批、本地档批、锚帧 done 一律进不来', async () => {
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

  assert.deepEqual(page.seen, [], `旧版本的消息一条都不该到页面:${JSON.stringify(page.seen)}`);
  assert.deepEqual(layerKeys(page.layers()), ['h:html:KB']);
  assert.equal(p.ready.peek('s').index.done, false, '旧版本的 done 不算这一版的锚帧就绪');
});

test('旧批次晚到:会话从 E2 切回 E1(撤销)之后,E1 的层重新有效,E2 晚到的反而被拦', async () => {
  const p = pipeline();
  const page = watch(p, 's');
  const E1 = entryOf('E1', [control('h', 'KA')]), E2 = entryOf('E2', [control('h', 'KB')]);
  p.adoptSession('s', E1, 1);
  p.adoptSession('s', E2, 2);
  p.adoptSession('s', E1, 3);                                    // 撤销:内容回到第一版,键也回到 E1
  assert.equal(p.publishLayer(E2, control('h', 'KB'), 'shared', [[0, 9]]), 0);
  assert.equal(p.publishLayer(E1, control('h', 'KA'), 'shared', [[0, 9]]), 1);
  assert.deepEqual(layerKeys(page.layers()), ['h:html:KA']);
  assert.deepEqual(page.seen.filter(m => m.type === 'reset').map(m => m.localRev), [0, 1, 2, 3], '每次换版本各 reset 一次(0 是连上时的 backlog)');
});

test('旧批次晚到:轨道流的分段落盘时流已属于别的版本,不发到会话', () => {
  const p = pipeline();
  const page = watch(p, 's');
  p.adoptSession('s', entryOf('E2'), 2);
  page.seen.length = 0;
  // 生产者 `publish(state)` 的形状:按 state.entryKey 过闸
  assert.equal(p.ready.publish('E1', { clipId: 'h', kind: 'stream', key: 'S1', ranges: [[0, 3]] }), 0);
  assert.equal(p.ready.publish('E2', { clipId: 'h', kind: 'stream', key: 'S2', ranges: [[0, 1]] }), 1);
  assert.deepEqual(page.seen.filter(m => m.type === 'layer').map(m => m.key), ['S2']);
  assert.deepEqual(page.seen.map(m => m.type), ['reset', 'layer'], 'E2 第一次写进来时才补上挂着的 reset,紧挨着新层');
});

/* ------------------------------------------------------------ 2. Agent / 导出混杂渲染 */

test('Agent / 导出 / 交互帧的 cardRender 渲别的版本:只把计划记在它自己的 entry 上,不 reset、不认领页面会话', async () => {
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
  assert.deepEqual(C.cardPlan.map(c => c.snapshotKey), ['KC'], '计划记在 C 自己身上');
  assert.ok(C.prerenderSet instanceof Set);
  assert.deepEqual(page.seen, [], `页面会话一条消息都不该收到:${JSON.stringify(page.seen)}`);
  assert.deepEqual(layerKeys(page.layers()), ['h:html:KA'], '页面的层原样留着');
  assert.equal(p.ready.current('s'), 'E1');

  // Agent 那一版落盘、交批:没有会话在 C 上,全丢
  C.snapshotPending = new Map([['c', fakeBatch('h', 'KC')]]);
  await p.flushSnapshots(C);
  assert.deepEqual(page.seen, []);
});

test('导出 / 让路恢复重排的 preload(adopt: false)不动任何会话的版本', async () => {
  const p = pipeline();
  const page = watch(p, 's');
  const E1 = entryOf('E1'), X = entryOf('X');
  p.entry = async project => (project.key === 'X' ? X : E1);
  await p.preload({ key: 'E1', id: 'p', duration: 1 }, { session: 's', localRev: 1 });
  assert.equal(p.ready.current('s'), 'E1');
  page.seen.length = 0;
  await p.preload({ key: 'X', id: 'p', duration: 1 }, { adopt: false, owner: 'session:s' });
  assert.equal(p.ready.current('s'), 'E1', 'adopt: false 只排活');
  assert.deepEqual(page.seen, []);
  await p.background;
});

test('页面的 preload 到时,这一版的计划已被 Agent 算过:马上认领挂着的区间,不等后台排到', async () => {
  const p = pipeline();
  p.ready.stageByKey({ kind: 'html', key: 'KA', ranges: [[0, 40]] });
  const page = watch(p, 's');
  const E1 = entryOf('E1');
  await p.cardRender(E1, fakeBakery([control('h', 'KA')]), [0], 'agent');   // Agent 先渲过这一版
  assert.deepEqual(page.layers(), [], 'Agent 渲的时候没有认领');
  p.entry = async () => E1;
  await p.preload({ id: 'p', duration: 1 }, { session: 's', localRev: 7 });
  assert.deepEqual(page.layers(), [{ clipId: 'h', kind: 'html', key: 'KA', ranges: [[0, 40]] }]);
  assert.deepEqual(page.seen.filter(m => m.type === 'reset').at(-1), { type: 'reset', localRev: 7 });
  await p.background;
});

/* ------------------------------------------------------------ 3. 多会话交替 */

test('两个会话交替前进:各自只收自己版本的层,共享键相同也不串', () => {
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
  assert.equal(bReset, 3, 'B:backlog + B1 + B2 —— A 换版本不清 B 的表');
  assert.ok(!a.seen.some(m => m.key === 'G' || m.key === 'G2'), 'B 的层没串到 A');
  assert.ok(!b.seen.some(m => m.key === 'K2'), 'A 的层没串到 B');
});

test('两个会话在同一版上:一次发布两边都收到;一边换走另一边照常', () => {
  const p = pipeline();
  const a = watch(p, 'a'), b = watch(p, 'b');
  const E = entryOf('E');
  p.adoptSession('a', E, 1);
  p.adoptSession('b', E, 1);
  assert.equal(p.publishLayer(E, control('h', 'K'), 'shared', [[0, 3]]), 2);
  p.adoptSession('a', entryOf('F'), 2);
  assert.equal(p.publishLayer(E, control('h', 'K'), 'shared', [[0, 5]]), 1);
  assert.deepEqual(a.layers()[0].ranges, [[0, 3]], 'a 换到 F(计划还没算出来):旧表先顶着,但 E 的新发布进不来');
  assert.deepEqual(b.layers()[0].ranges, [[0, 5]]);
});

test('同一会话的 preload 乱序完成:晚发出的那一版赢(领号),旧 localRev 也不认', async () => {
  const p = pipeline();
  const page = watch(p, 's');
  const E1 = entryOf('E1', [control('h', 'K1')]), E2 = entryOf('E2', [control('h', 'K2')]);
  // 第一个请求算 entry 慢(素材打戳),第二个快
  p.entry = async project => { await sleep(project.delay); return project.key === 'E1' ? E1 : E2; };
  const first = p.preload({ key: 'E1', delay: 40, duration: 1 }, { session: 's', localRev: 1 });
  const second = p.preload({ key: 'E2', delay: 1, duration: 1 }, { session: 's', localRev: 2 });
  await Promise.all([first, second]);
  assert.equal(p.ready.current('s'), 'E2', '先发的那个晚算完,不能把会话拉回旧版');
  assert.equal(page.seen.filter(m => m.type === 'reset').length, 2, 'backlog + E2,E1 那次没有 reset');
  const generation = p.generations.get('session:s');
  assert.equal(generation?.key, 'E2', '作废的请求不排后台活');
  assert.equal(generation.controller.signal.aborted, false, '也不掐掉新那一版的后台代次');

  // 号对得上、但 localRev 比记着的旧:也不认
  const ticket = p.ready.request('s');
  assert.equal(p.ready.adopt('s', 'E1', 1, ticket), false);
  assert.equal(p.ready.current('s'), 'E2');
  await p.background;
});

test('/ready 按 session 订阅:backlog 只含自己会话的层;不带 session 的是缺省会话', () => {
  const p = pipeline();
  p.adoptSession('a', entryOf('A'), 4);
  p.publishLayer(entryOf('A'), control('h', 'KA'), 'shared', [[0, 1]]);
  p.adoptSession(DEFAULT_READY_SESSION, entryOf('D'), 0);
  p.publishLayer(entryOf('D'), control('h', 'KD'), 'shared', [[0, 1]]);
  const late = [];
  p.ready.subscribe('a', m => late.push(m));
  assert.deepEqual(late, [{ type: 'reset', localRev: 4 }, { type: 'layer', clipId: 'h', kind: 'html', key: 'KA', ranges: [[0, 1]] }]);
  assert.deepEqual(p.readyIndex.list().map(l => l.key), ['KD'], '`pipeline.readyIndex` 是缺省会话那一份');
  const stranger = [];
  p.ready.subscribe('nobody', m => stranger.push(m));
  assert.deepEqual(stranger, [{ type: 'reset', localRev: 0 }], '没发过 preload 的会话是空表');
});

/* ------------------------------------------------------------ 回收 */

test('断开的会话不常驻:没有订阅者、超过空闲时间就回收;有订阅者的永远不回收', () => {
  let now = 0;
  const hub = createReadyHub({ now: () => now, idleMs: 1000, maxSessions: 100 });
  const offA = hub.subscribe('a', () => {});
  hub.subscribe('b', () => {});
  hub.adopt('c', 'E', 1);                  // 只发过 preload、没订阅
  now = 500;
  offA();                                  // a 断开
  now = 1400;
  hub.request('d');                        // 任何新会话进来时顺带回收
  assert.deepEqual(hub.describe().map(r => r.session).sort(), ['a', 'b', 'd'], 'c 闲了 1400 > 1000,回收');
  now = 1600;
  hub.subscribe('e', () => {})();
  assert.deepEqual(hub.describe().map(r => r.session).sort(), ['b', 'd', 'e'], 'a 断开 1100 > 1000,回收;b 一直连着');
  // 被回收的会话再来就是新的:没有版本,发布进不去
  assert.equal(hub.current('c'), undefined);
  assert.equal(hub.publish('E', { clipId: 'h', kind: 'html', key: 'K', ranges: [[0, 0]] }), 0);
});

test('会话数封顶:超过上限先回收最久没动静、又没有订阅者的', () => {
  let now = 0;
  const hub = createReadyHub({ now: () => now, idleMs: 1e9, maxSessions: 3 });
  hub.subscribe('live', () => {});
  for (const id of ['x1', 'x2', 'x3', 'x4']) { now++; hub.request(id); }
  const ids = hub.describe().map(r => r.session).sort();
  assert.equal(ids.length, 3);
  assert.ok(ids.includes('live'), '有订阅者的不回收');
  assert.ok(ids.includes('x4'), '刚进来的不回收');
  assert.ok(!ids.includes('x1') && !ids.includes('x2'), '最旧的先走');
});

test('一个会话退订两次、订阅者抛错:不影响别的订阅者,也不重复回收', () => {
  const hub = createReadyHub();
  const good = [];
  hub.subscribe('s', () => { throw new Error('断了'); });
  const off = hub.subscribe('s', m => good.push(m));
  hub.adopt('s', 'E', 1);
  hub.publish('E', { clipId: 'h', kind: 'html', key: 'K', ranges: [[0, 0]] });
  assert.deepEqual(good.map(m => m.type), ['reset', 'reset', 'layer']);
  off(); off();
  assert.equal(hub.peek('s').index.subscriberCount(), 1);
});

test('共用的 staged:一个会话 clear 不会清掉别的会话要认领的区间', () => {
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

test('真的调用点:missingSnapshotFrames / fillAnchorSnapshots 渲旧版本时,发层和 done 都进不了新版本的会话', async () => {
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
  assert.deepEqual(page.seen, [], `旧版本的层 / done 不进来:${JSON.stringify(page.seen)}`);
  // 正向对照:新版本自己的这两步照常到
  await p.missingSnapshotFrames(E2, { tiers: ['shared'] });
  await p.fillAnchorSnapshots(E2, null, null);
  assert.deepEqual(page.seen.map(m => m.type), ['layer', 'layer', 'done']);
  assert.ok(page.seen.filter(m => m.type === 'layer').every(m => m.key === 'KB'));
});

test('两个标签页保活同一个已就绪的版本:后来的会话当场拿到全部层和 done;各自至多重跑一趟,之后保活不互相掐、不再重跑', async () => {
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
  assert.deepEqual(layerKeys(b.layers()), ['h:html:K'], '从 staged 当场认领回来,不等后台那一趟');
  assert.equal(p.ready.peek('b').index.done, true, '锚帧早就齐了:done 也补上');
  await p.background;
  assert.equal(acquired, 1, '新会话第一次来重跑一趟(大多命中缓存)');
  E.status = 'ready';                    // 那一趟跑完了(单测里没有 Chrome,手动置回)
  acquired = 0;
  // 30 秒保活一轮一轮地来(远超 PRELOAD_STALE_MS):谁都不重跑
  for (const at of [40000, 80000, 120000]) {
    p.generations.forEach(g => { g.seenAt -= at; });
    await p.preload({ id: 'p', duration: 1 }, { session: 'a', localRev: 1 });
    await p.preload({ id: 'p', duration: 1 }, { session: 'b', localRev: 1 });
  }
  await p.background;
  assert.equal(acquired, 0, '已就绪的版本不再开后台 Chrome');
  assert.equal(E.status, 'ready');
  assert.ok(p.generations.has('session:a') && p.generations.has('session:b'), '跑完的代次不被当成过期掐掉');
});

test('让路恢复:让路期间已经没有会话停在那一版的不重排;还有会话在的照常接回原 owner', async () => {
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

test('会话在领号之后被回收又重建:不算被取代,preload 照常认领', () => {
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

test('staged 封顶:超过上限丢最久没动的键', () => {
  const hub = createReadyHub({ maxStaged: 2 });
  hub.stageByKey({ kind: 'html', key: 'A', ranges: [[0, 0]] });
  hub.stageByKey({ kind: 'html', key: 'B', ranges: [[0, 0]] });
  hub.stageByKey({ kind: 'html', key: 'A', ranges: [[1, 1]] });   // A 刚用过
  hub.stageByKey({ kind: 'html', key: 'C', ranges: [[0, 0]] });
  assert.deepEqual(hub.stagedKeys().map(s => s.key), ['A', 'C']);
});

test('session 参数校验:缺省 = 缺省会话,超长 / 非字符串 = 拒绝', async () => {
  const { readySessionOf, READY_SESSION_ID_MAX } = await import('../ready-index.mjs');
  assert.equal(readySessionOf(undefined), DEFAULT_READY_SESSION);
  assert.equal(readySessionOf('abc'), 'abc');
  assert.equal(readySessionOf('x'.repeat(READY_SESSION_ID_MAX + 1)), null);
  assert.equal(readySessionOf(42), null);
});

test('按新 costs 重算后集合缩了:会话里判轻那张卡的旧层撤掉(reset + 从 staged 全量补回其余层)', () => {
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
  assert.deepEqual(layerKeys(page.layers()), ['heavy:html:KH'], '判轻的那张撤掉,判重的补回来');
  assert.deepEqual(page.seen.map(m => m.type), ['reset', 'layer']);
  // 集合没再缩:不再 reset
  page.seen.length = 0;
  p.adoptCardPlan(E, [planned('heavy', 'KH'), planned('light', 'KL')]);
  assert.deepEqual(page.seen, []);
});

test('换到计划还没算出来的新版本:旧表先顶着(闸门已经换过去),计划一到 reset 和补层紧挨着发', () => {
  const p = pipeline();
  p.ready.stageByKey({ kind: 'html', key: 'KB', ranges: [[0, 5]] });
  const page = watch(p, 's');
  const E1 = entryOf('E1', [control('h', 'KA')]);
  p.adoptSession('s', E1, 1);
  p.publishLayer(E1, control('h', 'KA'), 'shared', [[0, 9]]);
  page.seen.length = 0;
  const E2 = entryOf('E2');                                    // 刚编辑完,计划还没算
  assert.equal(p.adoptSession('s', E2, 2), true);
  assert.deepEqual(page.seen, [], '不清表');
  assert.deepEqual(layerKeys(page.layers()), ['h:html:KA'], '旧层顶着');
  assert.equal(p.publishLayer(E1, control('h', 'KA'), 'shared', [[0, 20]]), 0, '闸门已换:旧版本进不来');
  assert.equal(p.ready.describe().find(r => r.session === 's').pendingReset, true);
  p.adoptCardPlan(E2, [control('h', 'KB')]);                    // 后台那一趟算出了计划
  assert.deepEqual(page.seen, [{ type: 'reset', localRev: 2 }, { type: 'layer', clipId: 'h', kind: 'html', key: 'KB', ranges: [[0, 5]] }]);
});

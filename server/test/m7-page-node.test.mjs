/**
 * M7-T：页面一侧的纯浏览器节点。
 *   - 当节点的条件（第 2 节）：身份为手机、最低一档、退回单舞台、开发构建（D16）、非 Chromium（D14）、非成员、测量没落定 → 不当节点；
 *   - D10 页面侧：`node.hello` 只报原始值 `environment`、`profile: 'browser'`、`maxConcurrent: 1`，watch 只列本项目；
 *   - 第 4.1 节：认领到就 progress(0)；
 *   - D8 让路：播放 / 拖动 / 更急的后台活来了，当前帧做完就放回（一次，不计失败），此后不再生成快照、不再认领；
 *     页面隐藏不等当前帧，立即放回，迟到的帧丢掉；
 *   - D6 用任务的 projectRev：先用发布时留存的已确认版本，没有再 project.snapshot.get，都没有就放回（no-snapshot），不拿别的版本渲。
 * 依据：`docs/plan/m7-contract.md` 第 2、4、5 节与第 13 节裁定 D6、D8、D10、D14、D16。假设见 `m7-kit.mjs` 的 K10、K11。
 * 页面节点的实现还没派（契约第 9 节 `claude/rq-m7-node`），所以这些用例现在都 skip。
 * 跑：node --experimental-test-module-mocks --test server/test/m7-page-node.test.mjs
 *
 * 没有真实计时断言：时钟是假的，异步只用「让出宏任务回合」等 Promise 链走完。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  importRepo, pickMethod, normalizeEligible, eligibilityGate, browserNodeGate, NODE_METHODS, UA, ENV,
  flush, deferred, snapTask, gateOpts,
} from './m7-kit.mjs';

/* ================================================================== K10 当节点的条件 */

const GOOD = Object.freeze({ online: true, codeVersion: 'cv-1', phone: false, lowest: false, stageLayout: 'dual', userAgent: UA.chrome, member: true, measured: true });

test('当节点的条件：身份为电脑、不是最低一档、双舞台、嵌了代码版本、Chromium、成员、测量落定才当；缺一样都不当（第 2 节、D14、D16）', gateOpts(eligibilityGate()), async () => {
  const gate = eligibilityGate();
  const fn = (await importRepo(gate.file))[gate.name];
  const judge = (patch) => normalizeEligible(fn({ ...GOOD, ...patch }));
  assert.equal(judge({}), true, '条件齐全应当节点');
  assert.equal(judge({ userAgent: UA.edge }), true, 'Edge 是 Chromium 内核，能当');
  const no = [
    [{ phone: true }, '身份为手机（2026-10-07 用户定：手机不当渲染节点）'],
    [{ lowest: true }, '最低一档'],
    [{ stageLayout: 'single' }, '退回同源单舞台'],
    [{ stageLayout: 'pending' }, '两个舞台还没都握上手(舞台闸门在试后台舞台)'],
    [{ codeVersion: '' }, '开发构建（CODE_VERSION 为空）'],
    [{ codeVersion: null }, '没有代码版本'],
    [{ userAgent: UA.firefox }, 'Firefox'],
    [{ userAgent: UA.safari }, 'Safari'],
    [{ member: false }, '不是以成员身份连着云端项目'],
    [{ measured: false }, '测量没落定（加载遮罩还在）'],
    [{ online: false }, '不是在线构建'],
  ];
  for (const [patch, what] of no) assert.equal(judge(patch), false, `${what} 不当节点`);
});

/* ================================================================== K11 编排 */

const PROJECT = 'p1';
const USER = 'zoe@devA';

/**
 * 页面节点的试验台（K11 的形状集中在这里；集成对账改这里）。
 * `sent` 是节点发往 render 连接的全部消息；`bakes` 是每次 bakeFrame 的调用（带可控的 deferred）。
 */
async function nodeRig({ kept = new Map(), snapshots = new Map(), idle = true } = {}) {
  const gate = browserNodeGate();
  const factory = (await importRepo(gate.file))[gate.name];
  const sent = [];
  const bakes = [];
  const fetches = [];
  const finishes = [];
  let t = 1_000_000;
  const state = { idle };
  const deps = {
    nodeId: 'n-page', projectId: PROJECT, userId: USER, codeVersion: 'cv-1', environment: { ...ENV.winNvidiaChrome },
    now: () => t,
    isIdle: () => state.idle,
    send: (m) => { sent.push(JSON.parse(JSON.stringify(m))); return true; },
    keptProject: (rev) => kept.get(rev) ?? null,
    fetchSnapshot: async (rev) => { fetches.push(rev); return snapshots.get(rev) ?? null; },
    bakeFrame: (job) => {
      const d = deferred();
      bakes.push({ job, ...d });
      return d.promise;
    },
    finishTask: async (arg) => { finishes.push(arg); return { v: 1, kind: 'snapshot' }; },
  };
  const node = factory(deps);
  const call = (group, ...args) => {
    const name = pickMethod(node, NODE_METHODS[group]);
    if (!name) throw new Error(`假设 K11：节点对象上没有 ${NODE_METHODS[group].join(' / ')}`);
    return node[name](...args);
  };
  const rig = {
    node, sent, bakes, fetches, finishes, state,
    advance(ms) { t += ms; },
    start: () => call('start'),
    receive: (m) => call('receive', m),
    tick: () => call('tick'),
    yieldFor: (cause) => call('yieldFor', cause),
    stop: () => call('stop'),
    of: (type) => sent.filter((m) => m.type === type),
    /** 报到、拿指纹、看见一个任务并认领到它；回认领令牌 */
    async claimOne(task, token = 7) {
      rig.start();
      await flush();
      rig.receive({ type: 'node.welcome', nodeId: 'n-page', resumed: [], lost: [], envFingerprint: task.requires.envFingerprint, epoch: 'e1' });
      rig.receive({ type: 'queue.snapshot', tasks: [{ ...task, state: 'open', version: 1, attempts: 0, source: { ...task.source, userId: USER } }], epoch: 'e1' });
      rig.tick();
      await flush();
      const claim = rig.of('task.claim').at(-1);
      assert.equal(claim?.id, task.id, `应认领 ${task.id}：${JSON.stringify(sent)}`);
      rig.receive({ type: 'task.claimed', id: task.id, token, version: 2, leaseUntil: t + 30_000,
        task: { ...task, state: 'claimed', version: 2, attempts: 0, source: { ...task.source, userId: USER } }, epoch: 'e1' });
      await flush();
      return token;
    },
  };
  return rig;
}

const FP = 'aaaaaaaaaaaaaaaa';
/** 三帧的一段（本地帧 0～2），projectRev 7 */
const TASK = () => snapTask({ fp: FP, span: 3, projectRev: 7, input: { dual: true, bake: { count: 3, sampling: { firstFrame: 0 } } } });
const P7 = { id: PROJECT, rev: 7, marker: 'kept-7' };

test('D10 页面侧：node.hello 只报原始值 environment、profile browser、maxConcurrent 1；watch 只列本项目', gateOpts(browserNodeGate()), async () => {
  const rig = await nodeRig();
  rig.start();
  await flush();
  const hello = rig.of('node.hello')[0];
  assert.ok(hello, JSON.stringify(rig.sent));
  assert.equal(hello.profile, 'browser');
  assert.equal(hello.maxConcurrent, 1);
  assert.deepEqual(hello.environment, ENV.winNvidiaChrome, '报 pageEnvironment() 的原始值');
  assert.ok(hello.envFingerprint === undefined || hello.envFingerprint === null, `页面不自己算指纹：${JSON.stringify(hello)}`);
  const watch = rig.of('queue.watch')[0];
  assert.deepEqual(watch?.projects, [PROJECT], `只 watch 本项目，不许 'all'：${JSON.stringify(watch)}`);
});

test('第 4.1 节：认领到先 progress(0)；逐帧生成快照、全段齐后 task.complete 一次', gateOpts(browserNodeGate()), async () => {
  const rig = await nodeRig({ kept: new Map([[7, P7]]) });
  const task = TASK();
  const token = await rig.claimOne(task);
  const first = rig.sent.findIndex((m) => m.type === 'task.progress');
  assert.ok(first >= 0, '认领到应先报进度');
  assert.equal(rig.sent[first].done, 0);
  assert.equal(rig.sent[first].token, token);
  for (let f = 0; f < 3; f++) {
    await flush();
    const b = rig.bakes[f];
    assert.ok(b, `第 ${f} 帧应开始生成快照：共 ${rig.bakes.length} 次`);
    assert.equal(b.job.localFrame, f);
    b.resolve({ hash: `${f}`.padStart(64, '0'), bytes: 100, htmlGz: new ArrayBuffer(8) });
  }
  await flush();
  assert.equal(rig.bakes.length, 3, '一段三帧，恰好三次');
  const done = rig.of('task.complete');
  assert.equal(done.length, 1, JSON.stringify(rig.sent));
  assert.deepEqual([done[0].id, done[0].token], [task.id, token]);
  assert.equal(rig.of('task.release').length, 0);
});

for (const cause of ['drag', 'play', 'urgent']) {
  test(`D8 让路（${cause}）：当前帧做完就放回一次，不再生成下一帧，不 complete、不 fail；此后不认领`, gateOpts(browserNodeGate()), async () => {
    const rig = await nodeRig({ kept: new Map([[7, P7]]) });
    const task = TASK();
    const token = await rig.claimOne(task);
    await flush();
    assert.equal(rig.bakes.length, 1, '第 0 帧在做');
    // 拖动 / 播放开始时父页的 isIdle() 同时变假（第 2 节闲的判据），并通知节点让路
    rig.state.idle = false;
    rig.yieldFor(cause);
    await flush();
    assert.equal(rig.of('task.release').length, 0, '当前帧还没做完，不放回（「手里那一批做完为止」，一批 = 一帧）');
    rig.bakes[0].resolve({ hash: '0'.repeat(64), bytes: 100, htmlGz: new ArrayBuffer(8) });
    await flush();
    const rel = rig.of('task.release');
    assert.equal(rel.length, 1, `做完当前帧放回恰好一次：${JSON.stringify(rig.sent)}`);
    assert.deepEqual([rel[0].id, rel[0].token], [task.id, token]);
    assert.equal(rig.bakes.length, 1, '放回后不再生成下一帧');
    assert.equal(rig.of('task.complete').length, 0);
    assert.equal(rig.of('task.fail').length, 0, '让路不是失败（C2）');
    // 让路期间不认领
    const claimsBefore = rig.of('task.claim').length;
    rig.receive({ type: 'task.opened', task: { ...TASK(), id: 'snapshot:other:0-2', state: 'open', version: 1, attempts: 0, source: { projectId: PROJECT, projectRev: 7, userId: USER } }, epoch: 'e1' });
    rig.advance(1_000);
    rig.tick();
    await flush();
    assert.equal(rig.of('task.claim').length, claimsBefore, '不闲时不认领');
  });
}

test('D8 页面隐藏：不等当前帧，立即放回；迟到的那一帧丢掉（不报进度、不 complete）', gateOpts(browserNodeGate()), async () => {
  const rig = await nodeRig({ kept: new Map([[7, P7]]) });
  const task = TASK();
  const token = await rig.claimOne(task);
  await flush();
  assert.equal(rig.bakes.length, 1);
  rig.state.idle = false;
  rig.yieldFor('hidden');
  await flush();
  const rel = rig.of('task.release');
  assert.equal(rel.length, 1, `隐藏立即放回：${JSON.stringify(rig.sent)}`);
  assert.deepEqual([rel[0].id, rel[0].token], [task.id, token]);
  const progressBefore = rig.of('task.progress').length;
  // 生成快照的中止信号应已触发（能停就停）
  assert.equal(rig.bakes[0].job.signal?.aborted, true, '隐藏时中止舞台这次生成快照');
  rig.bakes[0].resolve({ hash: '0'.repeat(64), bytes: 100, htmlGz: new ArrayBuffer(8) });
  await flush();
  assert.equal(rig.of('task.progress').length, progressBefore, '迟到的帧不再报进度');
  assert.equal(rig.of('task.complete').length, 0);
  assert.equal(rig.of('task.release').length, 1, '只放回一次');
  assert.equal(rig.bakes.length, 1);
});

/* ================================================================== D6 */

test('D6 用任务的 projectRev：留存里有就用留存的那一版，不去拉快照', gateOpts(browserNodeGate()), async () => {
  const rig = await nodeRig({ kept: new Map([[7, P7], [9, { id: PROJECT, rev: 9 }]]) });
  await rig.claimOne(TASK());
  await flush();
  assert.equal(rig.bakes[0]?.job.project, P7, '用第 7 版（任务的 projectRev），不是别的版本');
  assert.deepEqual(rig.fetches, []);
});

test('D6 留存里没有：取 project.snapshot.get 的那一版', gateOpts(browserNodeGate()), async () => {
  const P7s = { id: PROJECT, rev: 7, marker: 'snapshot-7' };
  const rig = await nodeRig({ kept: new Map([[9, { id: PROJECT, rev: 9 }]]), snapshots: new Map([[7, P7s]]) });
  await rig.claimOne(TASK());
  await flush();
  assert.deepEqual(rig.fetches, [7]);
  assert.equal(rig.bakes[0]?.job.project, P7s);
});

test('D6 两处都没有：放回（reason no-snapshot），不生成快照、不拿别的版本渲', gateOpts(browserNodeGate()), async () => {
  const rig = await nodeRig({ kept: new Map([[9, { id: PROJECT, rev: 9 }]]) });
  const task = TASK();
  const token = await rig.claimOne(task);
  await flush();
  assert.equal(rig.bakes.length, 0, '取不到这一版就不渲');
  const rel = rig.of('task.release');
  assert.equal(rel.length, 1, JSON.stringify(rig.sent));
  assert.deepEqual([rel[0].id, rel[0].token, rel[0].reason], [task.id, token, 'no-snapshot']);
  assert.equal(rig.of('task.fail').length, 0);
});

/**
 * M7-T: Pure browser node on the page side.
 *   - Conditions for acting as a node (Section 2): phone identity, lowest tier, falling back to
 *     single stage, development build (D16), non-Chromium (D14), non-member, measurement not
 *     settled → does not act as a node;
 *   - D10 page side: `node.hello` reports only raw `environment`, `profile: 'browser'`,
 *     `maxConcurrent: 1`, watch lists only this project;
 *   - Section 4.1: progress(0) upon claim;
 *   - D8 yield: when play / scrub / more urgent background job arrives, release after completing
 *     current frame (once, not counted as failure), no longer generating snapshots or claiming
 *     thereafter;
 *     when page is hidden, release immediately without waiting for current frame; late frames are
 *     dropped;
 *   - D6 uses task projectRev: first use confirmed version retained at publish time, if none use
 *     project.snapshot.get, if neither exists release (no-snapshot), without rendering with any
 *     other version.
 * Basis: `docs/plan/m7-contract.md` Sections 2, 4, 5 and Section 13 rulings D6, D8, D10, D14, D16.
 * Assumptions in K10, K11 of `m7-kit.mjs`.
 * Page node implementation has not been assigned yet (Contract Section 9 `claude/rq-m7-node`), so
 * these test cases are all skipped for now.
 * Run: node --experimental-test-module-mocks --test server/test/m7-page-node.test.mjs
 *
 * No real timing assertions: clock is fake, async only uses "yielding macro-task turns" to wait for
 * Promise chains to finish.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  importRepo, pickMethod, normalizeEligible, eligibilityGate, browserNodeGate, NODE_METHODS, UA, ENV,
  flush, deferred, snapTask, gateOpts,
} from './m7-kit.mjs';

/* ================================================================== K10 Conditions for acting as a node */

const GOOD = Object.freeze({ online: true, codeVersion: 'cv-1', phone: false, lowest: false, stageLayout: 'dual', userAgent: UA.chrome, member: true, measured: true });

test('Conditions for acting as a node: identity is a computer, not the lowest tier, dual stage, code version embedded, Chromium, member, and measurement settled; missing any one of them disqualifies it (section 2, D14, D16)', gateOpts(eligibilityGate()), async () => {
  const gate = eligibilityGate();
  const fn = (await importRepo(gate.file))[gate.name];
  const judge = (patch) => normalizeEligible(fn({ ...GOOD, ...patch }));
  assert.equal(judge({}), true, 'Should act as a node when all conditions are met');
  assert.equal(judge({ userAgent: UA.edge }), true, 'Edge is Chromium-based, so it can act as a node');
  const no = [
    [{ phone: true }, 'identity is a phone (user decision, 2026-10-07: phones do not act as render nodes)'],
    [{ lowest: true }, 'lowest tier'],
    [{ stageLayout: 'single' }, 'fell back to a same-origin single stage'],
    [{ stageLayout: 'pending' }, 'the two stages have not both completed the handshake (the stage gate is still trying the background stage)'],
    [{ codeVersion: '' }, 'development build (CODE_VERSION is empty)'],
    [{ codeVersion: null }, 'no code version'],
    [{ userAgent: UA.firefox }, 'Firefox'],
    [{ userAgent: UA.safari }, 'Safari'],
    [{ member: false }, 'not connected to the cloud project as a member'],
    [{ measured: false }, 'measurement not settled (the loading overlay is still up)'],
    [{ online: false }, 'not an online build'],
  ];
  for (const [patch, what] of no) assert.equal(judge(patch), false, `${what} does not act as a node`);
});

/* ================================================================== K11 Arrangement */

const PROJECT = 'p1';
const USER = 'zoe@devA';

/**
 * Test rig for page node (K11 shapes are centralized here; modify here for integration reconciliation).
 * `sent` is all messages sent by node to render connection; `bakes` is each bakeFrame call (with
 * controllable deferred).
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
    if (!name) throw new Error(`Assumption K11: the node object has no ${NODE_METHODS[group].join(' / ')}`);
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
    /** Check in, obtain fingerprint, see a task and claim it; returns claim token */
    async claimOne(task, token = 7) {
      rig.start();
      await flush();
      rig.receive({ type: 'node.welcome', nodeId: 'n-page', resumed: [], lost: [], envFingerprint: task.requires.envFingerprint, epoch: 'e1' });
      rig.receive({ type: 'queue.snapshot', tasks: [{ ...task, state: 'open', version: 1, attempts: 0, source: { ...task.source, userId: USER } }], epoch: 'e1' });
      rig.tick();
      await flush();
      const claim = rig.of('task.claim').at(-1);
      assert.equal(claim?.id, task.id, `Should claim ${task.id}: ${JSON.stringify(sent)}`);
      rig.receive({ type: 'task.claimed', id: task.id, token, version: 2, leaseUntil: t + 30_000,
        task: { ...task, state: 'claimed', version: 2, attempts: 0, source: { ...task.source, userId: USER } }, epoch: 'e1' });
      await flush();
      return token;
    },
  };
  return rig;
}

const FP = 'aaaaaaaaaaaaaaaa';
/** A segment of three frames (local frames 0-2), projectRev 7 */
const TASK = () => snapTask({ fp: FP, span: 3, projectRev: 7, input: { dual: true, bake: { count: 3, sampling: { firstFrame: 0 } } } });
const P7 = { id: PROJECT, rev: 7, marker: 'kept-7' };

test('D10 page side: node.hello reports only the raw value environment, profile browser and maxConcurrent 1; watch lists only this project', gateOpts(browserNodeGate()), async () => {
  const rig = await nodeRig();
  rig.start();
  await flush();
  const hello = rig.of('node.hello')[0];
  assert.ok(hello, JSON.stringify(rig.sent));
  assert.equal(hello.profile, 'browser');
  assert.equal(hello.maxConcurrent, 1);
  assert.deepEqual(hello.environment, ENV.winNvidiaChrome, 'Reports the raw values of pageEnvironment()');
  assert.ok(hello.envFingerprint === undefined || hello.envFingerprint === null, `The page does not compute the fingerprint itself: ${JSON.stringify(hello)}`);
  const watch = rig.of('queue.watch')[0];
  assert.deepEqual(watch?.projects, [PROJECT], `Watch only this project, 'all' is not allowed: ${JSON.stringify(watch)}`);
});

test('Section 4.1: progress(0) first once claimed; snapshots are generated frame by frame, and task.complete once after the whole segment is complete', gateOpts(browserNodeGate()), async () => {
  const rig = await nodeRig({ kept: new Map([[7, P7]]) });
  const task = TASK();
  const token = await rig.claimOne(task);
  const first = rig.sent.findIndex((m) => m.type === 'task.progress');
  assert.ok(first >= 0, 'Progress should be reported first once claimed');
  assert.equal(rig.sent[first].done, 0);
  assert.equal(rig.sent[first].token, token);
  for (let f = 0; f < 3; f++) {
    await flush();
    const b = rig.bakes[f];
    assert.ok(b, `Frame ${f} should have started generating a snapshot: ${rig.bakes.length} times in total`);
    assert.equal(b.job.localFrame, f);
    b.resolve({ hash: `${f}`.padStart(64, '0'), bytes: 100, htmlGz: new ArrayBuffer(8) });
  }
  await flush();
  assert.equal(rig.bakes.length, 3, 'A segment of three frames, exactly three times');
  const done = rig.of('task.complete');
  assert.equal(done.length, 1, JSON.stringify(rig.sent));
  assert.deepEqual([done[0].id, done[0].token], [task.id, token]);
  assert.equal(rig.of('task.release').length, 0);
});

for (const cause of ['drag', 'play', 'urgent']) {
  test(`D8 yield (${cause}): once the current frame is done, release once, do not generate the next frame, do not complete or fail; no claiming afterwards`, gateOpts(browserNodeGate()), async () => {
    const rig = await nodeRig({ kept: new Map([[7, P7]]) });
    const task = TASK();
    const token = await rig.claimOne(task);
    await flush();
    assert.equal(rig.bakes.length, 1, 'Frame 0 is in progress');
    // When scrub / play starts, parent page's isIdle() simultaneously becomes false (Section 2 idle
    // criteria), and notifies node to yield
    rig.state.idle = false;
    rig.yieldFor(cause);
    await flush();
    assert.equal(rig.of('task.release').length, 0, 'The current frame is not done yet, so no release ("finish the batch in hand", one batch = one frame)');
    rig.bakes[0].resolve({ hash: '0'.repeat(64), bytes: 100, htmlGz: new ArrayBuffer(8) });
    await flush();
    const rel = rig.of('task.release');
    assert.equal(rel.length, 1, `Released exactly once after finishing the current frame: ${JSON.stringify(rig.sent)}`);
    assert.deepEqual([rel[0].id, rel[0].token], [task.id, token]);
    assert.equal(rig.bakes.length, 1, 'The next frame is not generated after the release');
    assert.equal(rig.of('task.complete').length, 0);
    assert.equal(rig.of('task.fail').length, 0, 'Yielding is not a failure (C2)');
    // Do not claim during yield
    const claimsBefore = rig.of('task.claim').length;
    rig.receive({ type: 'task.opened', task: { ...TASK(), id: 'snapshot:other:0-2', state: 'open', version: 1, attempts: 0, source: { projectId: PROJECT, projectRev: 7, userId: USER } }, epoch: 'e1' });
    rig.advance(1_000);
    rig.tick();
    await flush();
    assert.equal(rig.of('task.claim').length, claimsBefore, 'No claiming when not idle');
  });
}

test('D8 page hidden: do not wait for the current frame, release immediately; the late frame is dropped (no progress report, no complete)', gateOpts(browserNodeGate()), async () => {
  const rig = await nodeRig({ kept: new Map([[7, P7]]) });
  const task = TASK();
  const token = await rig.claimOne(task);
  await flush();
  assert.equal(rig.bakes.length, 1);
  rig.state.idle = false;
  rig.yieldFor('hidden');
  await flush();
  const rel = rig.of('task.release');
  assert.equal(rel.length, 1, `Release immediately when hidden: ${JSON.stringify(rig.sent)}`);
  assert.deepEqual([rel[0].id, rel[0].token], [task.id, token]);
  const progressBefore = rig.of('task.progress').length;
  // Snapshot generation abort signal should have triggered (stop whenever possible)
  assert.equal(rig.bakes[0].job.signal?.aborted, true, 'Hiding aborts the stage\'s current snapshot generation');
  rig.bakes[0].resolve({ hash: '0'.repeat(64), bytes: 100, htmlGz: new ArrayBuffer(8) });
  await flush();
  assert.equal(rig.of('task.progress').length, progressBefore, 'The late frame no longer reports progress');
  assert.equal(rig.of('task.complete').length, 0);
  assert.equal(rig.of('task.release').length, 1, 'Released only once');
  assert.equal(rig.bakes.length, 1);
});

/* ================================================================== D6 */

test('D6 use the task\'s projectRev: if it is in retention, use the retained version and do not fetch a snapshot', gateOpts(browserNodeGate()), async () => {
  const rig = await nodeRig({ kept: new Map([[7, P7], [9, { id: PROJECT, rev: 9 }]]) });
  await rig.claimOne(TASK());
  await flush();
  assert.equal(rig.bakes[0]?.job.project, P7, 'Use version 7 (the task\'s projectRev), not another version');
  assert.deepEqual(rig.fetches, []);
});

test('D6 not in retention: take the version from project.snapshot.get', gateOpts(browserNodeGate()), async () => {
  const P7s = { id: PROJECT, rev: 7, marker: 'snapshot-7' };
  const rig = await nodeRig({ kept: new Map([[9, { id: PROJECT, rev: 9 }]]), snapshots: new Map([[7, P7s]]) });
  await rig.claimOne(TASK());
  await flush();
  assert.deepEqual(rig.fetches, [7]);
  assert.equal(rig.bakes[0]?.job.project, P7s);
});

test('D6 in neither place: release (reason no-snapshot), do not generate snapshots, do not render another version', gateOpts(browserNodeGate()), async () => {
  const rig = await nodeRig({ kept: new Map([[9, { id: PROJECT, rev: 9 }]]) });
  const task = TASK();
  const token = await rig.claimOne(task);
  await flush();
  assert.equal(rig.bakes.length, 0, 'Do not render if this version cannot be fetched');
  const rel = rig.of('task.release');
  assert.equal(rel.length, 1, JSON.stringify(rig.sent));
  assert.deepEqual([rel[0].id, rel[0].token, rel[0].reason], [task.id, token, 'no-snapshot']);
  assert.equal(rig.of('task.fail').length, 0);
});

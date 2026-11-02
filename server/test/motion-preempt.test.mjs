import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRenderQueue, taskIdOf } from '../render-queue/index.mjs';
import { renderQueueModule } from '../docservice/modules/render-queue.mjs';
import { createNodeSession, deviceRank } from '../render-node/session.mjs';
import { splitPlan, isMotionCard } from '../render-node/split.mjs';
import { pageStreamTasks, isMotionCard as isMotionCardPage } from '../../src/online/pageStreamPlan.ts';
import { createFakeClock, createMessageCollector, T0 } from './fake-render-queue-env.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectStreamResult, createAssetSink, writeManifest } from '../artifact-transfer.mjs';
import { mergeStreamManifest, streamManifest, streamManifestCovers, streamManifestPuts } from '../../src/online/browserNode.ts';
import { OnlineSnapshotSource } from '../../src/render/snapshotSource.ts';

const FP_PC = 'pppppppppppppppp';
const FP_HOST = 'hhhhhhhhhhhhhhhh';
const FP_BROWSER = 'bbbbbbbbbbbbbbbb';
const CV = 'c0de5a';
const PROJECT = 'proj-preempt';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/* ------------------------------------------------------------------ 1. Card Writing / FrameMode determination */

test('MP-01 isMotionCard: recognizes remotion-style and motion-style cards', () => {
  // Built-in motion-style card (review table)
  assert.equal(isMotionCard({ cardId: 'focus-card' }), true, 'focus-card is motion');
  assert.equal(isMotionCard({ cardId: 'punch-pill' }), true, 'punch-pill is motion');
  assert.equal(isMotionCard({ cardId: 'scene-3d' }), true, 'scene-3d is motion');

  // Built-in remotion-style card (review table)
  assert.equal(isMotionCard({ cardId: 'caption-track' }), false, 'caption-track is remotion');
  assert.equal(isMotionCard({ cardId: 'lottie' }), false, 'lottie is remotion');

  // Explicit writing override
  assert.equal(isMotionCard({ writing: 'motion' }), true);
  assert.equal(isMotionCard({ writing: 'remotion' }), false);
  assert.equal(isMotionCard({ capabilities: { writing: 'motion' } }), true);
  assert.equal(isMotionCard({ capabilities: { writing: 'remotion' } }), false);

  // frameMode declaration
  assert.equal(isMotionCard({ frameMode: 'stateful' }), true);
  assert.equal(isMotionCard({ frameMode: 'direct' }), false);

  // Page-side implementation cross-check
  assert.equal(isMotionCardPage({ cardId: 'focus-card' }), true);
  assert.equal(isMotionCardPage({ cardId: 'caption-track' }), false);
  assert.equal(isMotionCardPage({ writing: 'motion' }), true);
  assert.equal(isMotionCardPage({ writing: 'remotion' }), false);
  assert.equal(isMotionCardPage({ frameMode: 'stateful' }), true);
  assert.equal(isMotionCardPage({ frameMode: 'direct' }), false);
});

/* ------------------------------------------------------------------ 2. Segment chunk size */

test('MP-02 stream task splitting: a motion card gets at least 30 seconds (60 segments), and one shorter than 30s gets only 1 task; remotion stays at 8 segments; a sparse stream gets 1 task for the whole card', () => {
  const baseTask = {
    id: 'plan-1', kind: 'plan', resultKey: `${PROJECT}@1`, range: null,
    source: { projectId: PROJECT, projectRev: 1 }, input: {}, weight: { class: 'medium' }, requires: {}, priority: 1,
  };

  // (a) Motion card: 10 segments (150 frames, 5 seconds, < 30 seconds) -> only 1 task [0, 9]
  const motionShortStreams = [{
    streamKey: 'stream-motion-short', topClipId: 'c-m1', firstSegment: 0, lastSegment: 9, fps: 30,
    cardId: 'focus-card',
  }];
  const tasksMotionShort = splitPlan({
    planTask: baseTask, streams: motionShortStreams, envFingerprint: FP_PC, codeVersion: CV,
  }).filter(t => t.kind === 'stream');
  assert.equal(tasksMotionShort.length, 1, 'a motion card shorter than 30 seconds is split into only 1 task');
  assert.deepEqual([tasksMotionShort[0].range.from, tasksMotionShort[0].range.to], [0, 9]);

  // (b) Motion card: split over 30 seconds (60 segments), tail under 60 merged into previous segment:
  // 75 segments (tail 15 segments under 60) merged into previous segment -> 1 task [0, 74]
  // 125 segments (segment 2 has 65 segments >= 60) -> split into 2 tasks: [0, 59] and [60, 124]
  const tasksMotion75 = splitPlan({
    planTask: baseTask, streams: [{ streamKey: 's75', topClipId: 'c75', firstSegment: 0, lastSegment: 74, fps: 30, cardId: 'focus-card' }],
    envFingerprint: FP_PC, codeVersion: CV,
  }).filter(t => t.kind === 'stream');
  assert.equal(tasksMotion75.length, 1, 'in a 75-segment motion card, a tail of fewer than 60 segments merges into the previous piece');
  assert.deepEqual([tasksMotion75[0].range.from, tasksMotion75[0].range.to], [0, 74]);

  const tasksMotion125 = splitPlan({
    planTask: baseTask, streams: [{ streamKey: 's125', topClipId: 'c125', firstSegment: 0, lastSegment: 124, fps: 30, cardId: 'focus-card' }],
    envFingerprint: FP_PC, codeVersion: CV,
  }).filter(t => t.kind === 'stream');
  assert.equal(tasksMotion125.length, 2, 'more than 60 segments, and each piece covers at least 60 segments');
  assert.deepEqual([tasksMotion125[0].range.from, tasksMotion125[0].range.to], [0, 59]);
  assert.deepEqual([tasksMotion125[1].range.from, tasksMotion125[1].range.to], [60, 124]);

  // (c) Remotion card: 10 segments -> still split by 8 segments: [0, 7] and [8, 9]
  const remotionStreams = [{
    streamKey: 'stream-remotion', topClipId: 'c-r1', firstSegment: 0, lastSegment: 9, fps: 30,
    cardId: 'caption-track',
  }];
  const tasksRemotion = splitPlan({
    planTask: baseTask, streams: remotionStreams, envFingerprint: FP_PC, codeVersion: CV,
  }).filter(t => t.kind === 'stream');
  assert.equal(tasksRemotion.length, 2, 'a remotion card keeps the 8-segment split');
  assert.deepEqual([tasksRemotion[0].range.from, tasksRemotion[0].range.to], [0, 7]);
  assert.deepEqual([tasksRemotion[1].range.from, tasksRemotion[1].range.to], [8, 9]);

  // (d) Sparse stream task (sparse): 1 task for the entire card
  const sparseStreams = [{
    streamKey: 'stream-sparse', topClipId: 'c-sp', firstSegment: 0, lastSegment: 74, fps: 30,
    cardId: 'focus-card',
  }];
  const tasksSparse = splitPlan({
    planTask: baseTask, streams: sparseStreams, envFingerprint: FP_PC, codeVersion: CV, sparseStreams: true,
  }).filter(t => t.kind === 'stream' && t.id.endsWith(':sparse'));
  assert.equal(tasksSparse.length, 1, 'a sparse stream task covers the whole card as just 1 task');
  assert.deepEqual([tasksSparse[0].range.from, tasksSparse[0].range.to], [0, 74]);
});

/* ------------------------------------------------------------------ 3. Device rank determination */

test('MP-03 deviceRank: desktop app (3) > host render service with streams (2) > browser / without streams (1)', () => {
  assert.equal(deviceRank({ profile: 'pc' }), 3);
  assert.equal(deviceRank({ profile: 'host', capabilities: { streams: true } }), 2);
  assert.equal(deviceRank({ profile: 'host', capabilities: { streams: false } }), 1);
  assert.equal(deviceRank({ profile: 'host' }), 1);
  assert.equal(deviceRank({ profile: 'browser' }), 1);
  assert.equal(deviceRank(null), 0);
});

/* ------------------------------------------------------------------ 4. Queue cross-layer preemption mechanism */

function setupQueueEnv(startAt = T0, { constants } = {}) {
  const clock = createFakeClock(startAt);
  const collector = createMessageCollector();
  // Every message from the queue passes through document service module's outbound first
  // (assembly layer receives it this way: preemption info for `claimedStreams` and `task.taken`
  // is attached there)
  let mod = null;
  const q = createRenderQueue({ now: clock.now, send: (connId, msg) => { if (mod?.outbound(connId, msg) !== null) collector.send(connId, msg); }, ...(constants ? { constants } : {}) });
  mod = renderQueueModule(q);
  const ctx = {
    now: clock.now,
    send: (connId, msg) => collector.send(connId, msg),
    log: () => {},
    publish: (ch, msg, opts) => {},
    subscribe: () => {},
    unsubscribe: () => {},
  };
  return { clock, collector, q, mod, ctx };
}

function publishStreamTask(env, pubConnId, taskId, { priority = 10, fps = 30, userId = 'u1', requires = {} } = {}) {
  const parts = taskId.split(':');
  const resultKey = parts[1];
  const [from, to] = parts[2].split('-').map(Number);
  const sparse = parts[3] === 'sparse';
  const range = { unit: 'segment', from, to };
  const input = { clipId: 'clip-1', contentKey: 'ck-1', ...(sparse ? { density: 'sparse' } : {}) };
  const task = {
    id: taskId, kind: 'stream', resultKey, range,
    source: { projectId: PROJECT, projectRev: 1 }, input,
    weight: { class: 'medium', estMs: null, frames: (to - from + 1) * 15 }, requires: { ...requires }, priority,
  };
  env.mod.connect(env.ctx, pubConnId, { scope: 'local', userId });
  env.mod.handle(env.ctx, pubConnId, { type: 'publisher.hello', publisherId: 'pub-1' });
  env.mod.handle(env.ctx, pubConnId, { type: 'task.publish', tasks: [task] });
  return task;
}

test('MP-04 cross-rank preemption: PC (rank 3) preempts a stream task running on a browser (rank 1)', () => {
  const env = setupQueueEnv();
  const taskId = 'stream:rk-test:0-9';
  publishStreamTask(env, 'pub-1', taskId);

  // 1. Browser connects and claims task
  const browserConn = 'conn-browser';
  env.mod.connect(env.ctx, browserConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, browserConn, {
    type: 'node.hello', nodeId: 'node-browser', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, browserConn, { type: 'queue.watch', projects: [PROJECT] });
  env.mod.handle(env.ctx, browserConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

  const bClaimed = env.collector.of(browserConn, 'task.claimed');
  assert.equal(bClaimed.length, 1);
  const browserToken = bClaimed[0].token;
  assert.ok(browserToken);

  // 2. PC connects
  const pcConn = 'conn-pc';
  env.mod.connect(env.ctx, pcConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, pcConn, {
    type: 'node.hello', nodeId: 'node-pc', profile: 'pc', envFingerprint: FP_PC,
  });
  env.mod.handle(env.ctx, pcConn, { type: 'queue.watch', projects: 'all' });

  // 3. PC initiates preemption claim
  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

  // 4. Assert: browser receives task.lease-lost and reason is preempted
  const lost = env.collector.of(browserConn, 'task.lease-lost');
  assert.equal(lost.length, 1, 'the browser should receive 1 lease-lost message');
  assert.equal(lost[0].id, taskId);
  assert.equal(lost[0].reason, 'preempted');
  assert.equal(lost[0].token, browserToken);

  // 5. Assert: PC successfully acquires the task (receives task.claimed)
  const pcClaimed = env.collector.of(pcConn, 'task.claimed');
  assert.equal(pcClaimed.length, 1, 'the PC should successfully claim the preempted task');
  assert.equal(pcClaimed[0].id, taskId);
});

test('MP-05 cross-rank preemption: Host (rank 2) preempts a browser (rank 1); but browsers at the same rank cannot preempt each other', () => {
  const env = setupQueueEnv();
  const taskId = 'stream:rk-test2:0-9';
  publishStreamTask(env, 'pub-1', taskId);

  // 1. Browser A claims
  const b1Conn = 'conn-b1';
  env.mod.connect(env.ctx, b1Conn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, b1Conn, {
    type: 'node.hello', nodeId: 'node-b1', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, b1Conn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(b1Conn, 'task.claimed').length, 1);

  // 2. Browser B attempts to preempt Browser A -> fails (returns taken)
  const b2Conn = 'conn-b2';
  env.mod.connect(env.ctx, b2Conn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, b2Conn, {
    type: 'node.hello', nodeId: 'node-b2', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, b2Conn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  const b2Rejected = env.collector.of(b2Conn, 'task.claim-rejected');
  assert.equal(b2Rejected.length, 1);
  assert.equal(b2Rejected[0].reason, 'taken');
  assert.equal(env.collector.of(b1Conn, 'task.lease-lost').length, 0, 'browser A\'s lease is not lost');

  // 3. Host (rank 2) with streams capability preempts Browser A -> succeeds
  const hostConn = 'conn-host';
  env.mod.connect(env.ctx, hostConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, hostConn, {
    type: 'node.hello', nodeId: 'node-host', profile: 'host', envFingerprint: FP_HOST,
    capabilities: { streams: true },
  });
  // Preemption only applies to visible tasks (watched this project)
  env.mod.handle(env.ctx, hostConn, { type: 'queue.watch', projects: [PROJECT] });
  env.mod.handle(env.ctx, hostConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

  // Browser A receives lease-lost preempted
  const lost = env.collector.of(b1Conn, 'task.lease-lost');
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason, 'preempted');

  // Host claims successfully
  const hostClaimed = env.collector.of(hostConn, 'task.claimed');
  assert.equal(hostClaimed.length, 1);
  assert.equal(hostClaimed[0].id, taskId);
});

test('MP-06 non-stream tasks (snapshot and plan) are not preempted', () => {
  const env = setupQueueEnv();
  const snapId = 'snapshot:rk-snap:0-59';
  const task = {
    id: snapId, kind: 'snapshot', tier: 'shared', resultKey: 'rk-snap', range: { unit: 'localFrame', from: 0, to: 59 },
    source: { projectId: PROJECT, projectRev: 1 }, input: { clipId: 'c1' },
    weight: { class: 'medium' }, requires: {}, priority: 10,
  };
  env.mod.connect(env.ctx, 'pub-1', { scope: 'local', userId: 'u1' });
  env.mod.handle(env.ctx, 'pub-1', { type: 'publisher.hello', publisherId: 'pub-1' });
  env.mod.handle(env.ctx, 'pub-1', { type: 'task.publish', tasks: [task] });

  // Browser claims snapshot
  const bConn = 'conn-b';
  env.mod.connect(env.ctx, bConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, bConn, {
    type: 'node.hello', nodeId: 'node-b', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, bConn, { type: 'task.claim', id: snapId, expectVersion: 1 });
  assert.equal(env.collector.of(bConn, 'task.claimed').length, 1);

  // PC attempts to preempt -> rejected (taken)
  const pcConn = 'conn-pc';
  env.mod.connect(env.ctx, pcConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, pcConn, { type: 'node.hello', nodeId: 'node-pc', profile: 'pc' });
  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: snapId, expectVersion: 1 });

  const rejected = env.collector.of(pcConn, 'task.claim-rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'taken');
  assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 0);
});

/* ------------------------------------------------------------------ 5. Session state machine:
   preemption candidate selection when no open tasks */

test('MP-07 node session: with no open candidates, the PC automatically initiates preemption of stream tasks on weaker devices, preferring sparse streams', () => {
  const sent = [];
  const clock = createFakeClock();
  const session = createNodeSession({
    nodeId: 'pc-1',
    node: { profile: 'pc', envFingerprint: FP_PC, capabilities: { streams: true } },
    send: msg => sent.push(msg),
    now: clock.now,
  });
  session.start();
  sent.length = 0;

  // Received snapshot, no open tasks, but two stream tasks held by a weak device (browser)
  // (one full density, one sparse)
  session.receive({
    type: 'queue.snapshot',
    tasks: [],
    claimedStreams: [
      { id: 'stream:rk-dense:0-59', version: 2, holderProfile: 'browser', holderRank: 1, density: null, task: { id: 'stream:rk-dense:0-59', kind: 'stream', requires: { envFingerprint: FP_PC, capabilities: { streams: true } } } },
      { id: 'stream:rk-sparse:0-59:sparse', version: 2, holderProfile: 'browser', holderRank: 1, density: 'sparse', task: { id: 'stream:rk-sparse:0-59:sparse', kind: 'stream', requires: { envFingerprint: FP_PC, capabilities: { streams: true } } } },
    ],
  });

  // tick triggers claim
  session.tick();

  // Assert: sent task.claim, and prioritizes preempting sparse task
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'task.claim');
  assert.equal(sent[0].id, 'stream:rk-sparse:0-59:sparse', 'sparse stream tasks are preempted first');
  assert.equal(sent[0].expectVersion, 2);
});

/* ------------------------------------------------------------------ 6. Shuttle/scrub keepalive (Scrubbing Keepalive) */

test('MP-08 drag/scrub keep-alive: the browser reports node.active (busy: scrub), which refreshes the lease and the stall timer, avoiding timeout and preventing same-rank preemption', () => {
  const env = setupQueueEnv();
  const taskId = 'stream:rk-scrub:0-9';
  publishStreamTask(env, 'pub-1', taskId);

  // Browser claims
  const bConn = 'conn-b';
  env.mod.connect(env.ctx, bConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, bConn, {
    type: 'node.hello', nodeId: 'node-b', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, bConn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(bConn, 'task.claimed').length, 1);

  // Advance time by 25 s (does not exceed LEASE_MS 30s, but about to expire if not refreshed)
  env.clock.advance(25_000);

  // User is scrubbing, browser reports node.active { busy: 'scrub' }
  env.mod.handle(env.ctx, bConn, { type: 'node.active', busy: 'scrub' });

  // Advance time another 10 seconds (35 seconds total, exceeding original 30-second leaseUntil)
  env.clock.advance(10_000);

  // Trigger queue tick scan
  env.mod.tick(env.ctx);

  // Verify task status: not reclaimed by lease-expired, still claimed
  const d = env.q.describe();
  const task = d.tasks.find(t => t.id === taskId);
  assert.equal(task.state, 'claimed', 'kept alive by scrub, so the task was not reclaimed on timeout');
  assert.equal(task.claim.nodeId, 'node-b');

  // Same-layer browser attempts to claim -> still rejected (taken)
  const b2Conn = 'conn-b2';
  env.mod.connect(env.ctx, b2Conn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, b2Conn, {
    type: 'node.hello', nodeId: 'node-b2', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, b2Conn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(b2Conn, 'task.claim-rejected').length, 1);

  // But stronger device (PC) can still cross-layer preempt
  const pcConn = 'conn-pc';
  env.mod.connect(env.ctx, pcConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, pcConn, { type: 'node.hello', nodeId: 'node-pc', profile: 'pc' });
  env.mod.handle(env.ctx, pcConn, { type: 'queue.watch', projects: 'all' });
  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: task.version });

  assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 1);
  assert.equal(env.collector.of(bConn, 'task.lease-lost')[0].reason, 'preempted');
  assert.equal(env.collector.of(pcConn, 'task.claimed').length, 1);
});

test('MP-09 preempted browser node: on receiving task.lease-lost (preempted), it immediately aborts runController and stops working', async () => {
  const { createBrowserNode } = await import('../../src/online/browserNode.ts');
  const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
  const sent = [];
  const jobs = [];
  const taskId = 'stream:rk-preempt-b:0-7';
  const task = {
    id: taskId, kind: 'stream', resultKey: 'rk-preempt-b', range: { unit: 'segment', from: 0, to: 7 },
    source: { projectId: PROJECT, projectRev: 1, userId: 'u1' },
    input: {
      clipId: 'clip-1', cardId: 'focus-card', contentKey: 'ck-1', compositing: 'independent',
      bake: { start: 0, end: 4, count: 120, sampling: { firstFrame: 0, phase: { numerator: 0, denominator: 1 } } },
      stream: { kind: 'card', plane: 'local', clipIds: ['clip-1'], fps: 30, bound: { x: 0, y: 0, w: 100, h: 100 }, offset: { x: 0, y: 0 }, firstFrame: 0, count: 120, total: 120, originFrame: 0, lastFrame: 119 },
    },
    weight: { class: 'medium', estMs: null, frames: 120 }, requires: { capabilities: { streams: true } }, priority: 10,
  };

  const node = createBrowserNode({
    nodeId: 'browser-test',
    projectId: PROJECT,
    userId: 'u1',
    codeVersion: CV,
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
    now: () => 1000,
    isIdle: () => true,
    send: msg => { sent.push(msg); return true; },
    keptProject: () => ({ id: PROJECT }),
    fetchSnapshot: async () => ({ id: PROJECT }),
    bakeFrame: async () => {},
    finishTask: async () => {},
    streams: () => true,
    bakeStream: async (job) => new Promise((resolve, reject) => jobs.push({ job, resolve, reject })),
    finishStream: async () => ({}),
  });

  node.start();
  // Mock successful document service check-in
  node.receive({ type: 'node.welcome', nodeId: 'browser-test', envFingerprint: FP_BROWSER, resumed: [], lost: [] });
  // Mock claiming task
  node.receive({ type: 'task.claimed', id: taskId, token: 11, task });
  await flush();

  // Verify task was handed to bakeStream to start execution
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job.signal.aborted, false, 'signal is not aborted at the start of work');

  // Mock receiving lease-lost caused by preemption
  node.receive({ type: 'task.lease-lost', id: taskId, token: 11, reason: 'preempted' });
  await flush();

  // Assert: executor aborts immediately (signal.aborted is true)
  assert.equal(jobs[0].job.signal.aborted, true, 'signal aborts immediately after preemption');
  assert.equal(node.debug().counters.lost, 1, 'lost counter increments by 1');

  // Even if bakeStream returns late afterward, task.complete is no longer sent
  jobs[0].resolve({ manifest: { header: {}, segments: {} } });
  await flush();
  assert.equal(sent.filter(m => m.type === 'task.complete').length, 0, 'late output is discarded, task.complete is not sent');
});

/* ------------------------------------------------------------------ 6. End-to-end: after two
   full-density tasks for a 125-segment motion card write manifests, cross-boundary buckets merge,
   player reads by layer table, tasks of other shapes find by bucket */

/**
 * On-disk shape of a stream in stream store (StreamStore in prerender process:
 * `<store-root>/streams/<stream-key>/stream.json` + head file + segment files)
 */
async function writeStreamStore(root, { streamKey, lastSegment, originFrame, lastFrame }) {
  const dir = path.join(root, 'streams', streamKey);
  await fs.mkdir(dir, { recursive: true });
  const init = Buffer.from(`....ftypiso6-${streamKey.slice(0, 8)}-init`);
  const initId = sha256(init).slice(0, 16);
  await fs.writeFile(path.join(dir, `init-${initId}.mp4`), init);
  const rect = { x: 0, y: 0, w: 640, h: 360 };
  const manifest = {
    version: 1, streamKey, kind: 'card', plane: 'local', clipIds: ['clip-motion-125'], fps: 30, originFrame, lastFrame,
    bound: rect, offset: { x: 0, y: 0 }, tight: null,
    inits: { [initId]: { codec: 'avc1.640028', width: 640, height: 360, timescale: 15360, rect, encoder: 'h264_nvenc', bytes: init.length } },
    segments: {},
  };
  for (let n = 0; n <= lastSegment; n++) {
    const bytes = Buffer.from(`....moof-${streamKey.slice(0, 8)}-seg-${n}`);
    const file = `${n}-${sha256(bytes).slice(0, 16)}.m4s`;
    await fs.writeFile(path.join(dir, file), bytes);
    manifest.segments[n] = { file, init: initId, stride: 1, samples: 15, bytes: bytes.length, sig: `sig-${n}`, at: 1 };
  }
  await fs.writeFile(path.join(dir, 'stream.json'), JSON.stringify(manifest));
}

/**
 * Content store test double: `get` / `put` follow the shape of `ContentClient`;
 * `storage` key is `<kind>/<key>`
 */
function memoryContentStore() {
  const storage = new Map();
  return {
    storage,
    async get(kind, key) {
      return storage.has(`${kind}/${key}`) ? { body: structuredClone(storage.get(`${kind}/${key}`)) } : null;
    },
    async put(kind, key, body) {
      storage.set(`${kind}/${key}`, structuredClone(body));
      return { ok: true };
    },
  };
}

test('MP-10 end to end: tasks [0, 59] and [60, 124] of a 125-segment motion card go through the real collectStreamResult → writeManifest, the cross-boundary bucket 56-63 is merged, OnlineSnapshotSource reads out each segment by layer table, and tasks of other shapes can be found by bucket lookup', async (t) => {
  const lastSeg = 124; // 125 segments: 0-124, motion card full density split into [0, 59] and [60, 124]
  const originFrame = 0;
  const lastFrame = originFrame + lastSeg * 15 + 9; // Last segment has fewer than 15 frames
  const rk = sha256('rk-motion-125');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-mp10-'));
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-mp10-empty-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(empty, { recursive: true, force: true })]));
  await writeStreamStore(root, { streamKey: rk, lastSegment: lastSeg, originFrame, lastFrame });

  const content = memoryContentStore();
  const { storage } = content;
  const blobStore = new Map();
  // Full-density task issued by splitter to desktop node: does not include `input.stream`
  // (`below-stream.test.mjs` guards this rule); the last segment of the entire stream can only be
  // learned from stream store via manifest header
  const taskOf = (from, to) => ({
    id: `stream:${rk}:${from}-${to}`, kind: 'stream', resultKey: rk, range: { unit: 'segment', from, to },
    source: { projectId: PROJECT, projectRev: 1 }, input: { clipId: 'clip-motion-125', cardId: null, entryKey: null, contentKey: 'ck-m125' },
    weight: { class: 'heavy', estMs: null, frames: (to - from + 1) * 15 }, requires: { envFingerprint: FP_PC, capabilities: { streams: true } }, priority: 10,
  });
  /**
   * Node push step: real `collectStreamResult` lists manifest, chunks stored into asset service test
   * double by hash, manifest written to content store as-is
   */
  const produce = async (task) => {
    const { result, readBlob } = await collectStreamResult({ root }, task);
    for (const meta of [...Object.values(result.inits), ...Object.values(result.segments)]) blobStore.set(meta.hash, new Uint8Array(await readBlob(meta.hash)));
    assert.equal(await writeManifest(content, result), true);
    return result;
  };
  const client = { has: async (_ns, hash) => blobStore.has(hash), put: async () => { throw new Error('lookups never push chunks'); } };
  const sink = createAssetSink({ pipeline: { root: empty }, client, content });
  const segsOf = (key) => Object.keys(storage.get(`render-manifest/${rk}:${key}`)?.segments ?? {}).map(Number);

  // 1. Task [0, 59]: manifest is as-is output of collectStreamResult (header carries the last frame
  // of this stream, taken from stream.json in stream store), last bucket is 56-63
  const first = await produce(taskOf(0, 59));
  assert.deepEqual(Object.keys(first).sort(), ['header', 'inits', 'kind', 'range', 'resultKey', 'segments', 'v'], 'the manifest has only the fields that collectStreamResult produces');
  assert.equal(first.header.originFrame, originFrame);
  assert.equal(first.header.lastFrame, lastFrame, 'header.lastFrame comes from the stream store');
  assert.ok(storage.has(`render-manifest/${rk}:0-59`), 'the task\'s own key is still written');
  assert.deepEqual(segsOf('48-55'), [48, 49, 50, 51, 52, 53, 54, 55]);
  assert.deepEqual(segsOf('56-63'), [56, 57, 58, 59], 'the last bucket key of task [0, 59] is 56-63 (holding only its own 56-59)');
  assert.ok(!storage.has(`render-manifest/${rk}:56-59`), 'not truncated to 56-59 by the task\'s range.to');
  assert.equal(await sink.has(taskOf(60, 124)), false, 'the second half is not produced yet: a bucket lookup is incomplete');

  // 2. Task [60, 124]: first bucket is also 56-63, same key written by previous task,
  // merged into one copy via mergedForWrite
  await produce(taskOf(60, 124));
  assert.deepEqual(segsOf('56-63'), [56, 57, 58, 59, 60, 61, 62, 63], 'segments on both sides of the cross-boundary bucket 56-63 are merged together');
  assert.deepEqual(segsOf('120-124'), [120, 121, 122, 123, 124], 'the last bucket is cut off at the last segment of the whole stream');
  assert.ok(!storage.has(`render-manifest/${rk}:56-59`) && !storage.has(`render-manifest/${rk}:120-127`));

  // 3. Lookup calculates bucket end point by the same rule: tasks of other shapes (one for entire
  // stream, short segment spanning two buckets) have no key of their own, but can be assembled
  // by bucket
  assert.equal(await sink.has(taskOf(0, 124)), true, 'whole stream [0, 124]: assembled from 16 buckets, the end of the last bucket is determined by header.lastFrame of the fetched bucket');
  assert.equal(await sink.has(taskOf(50, 62)), true, '[50, 62]: the two buckets 48-55 and 56-63');
  const whole = await sink.resultFor(taskOf(0, 124));
  assert.deepEqual(Object.keys(whole.segments).map(Number), Array.from({ length: 125 }, (_, n) => n));

  // 4. Layer table (standard 8 segments per bucket segmentsPerTask: 8): player fetches manifests
  // and chunks by bucket
  storage.set(`layer-map/layers:${PROJECT}`, {
    v: 3, kind: 'layer-map', projectId: PROJECT, fps: 30, span: 60, layers: [],
    streams: [{
      topClipId: 'clip-motion-125', clipIds: ['clip-motion-125'], kind: 'card', plane: 'local', contentKey: 'ck-m125',
      candidates: [{ envFingerprint: FP_PC, resultKey: rk }], originFrame, lastSegment: lastSeg, segmentsPerTask: 8,
    }],
  });
  const readyMessages = [];
  let currentT = 0;
  const source = new OnlineSnapshotSource({
    async request(msg) {
      if (msg.key === `layers:${PROJECT}`) return { type: 'content.item', kind: 'snapshot-manifest', key: msg.key, body: storage.get(`layer-map/${msg.key}`) };
      const item = await content.get(msg.kind, msg.key);
      if (!item) return { type: 'content.item', kind: msg.kind, key: msg.key, missing: true };
      return { type: 'content.item', kind: msg.kind, key: msg.key, body: item.body };
    },
    assetBase: () => 'https://example.com/asset/',
    authHeaders: async () => ({}),
    async fetch(url) {
      const b = blobStore.get(url.split('/').pop());
      if (!b) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    },
    now: () => 1000,
    setTimer: () => 0,
    clearTimer: () => {},
  }, { tier: 'original', playhead: { get t() { return currentT; }, fps: 30, playing: false } });
  source.subscribeReady('online', 0, (m) => readyMessages.push(m));
  source.setProject(PROJECT);
  const settleSource = async (sec) => {
    currentT = sec;
    source.focus(sec, 30);
    await source.tickNow();
    await source.idle();
    await source.tickNow();
    await source.idle();
  };
  // Segments 0, 10, 35; segment 58 (29 s) and segment 62 (31 s) in cross-boundary bucket 56-63;
  // segment 70 (35 s) and trailing segment 124 (62 s) in second-half task
  for (const sec of [0, 5, 17.5, 29, 31, 35, 62]) await settleSource(sec);
  const allRanges = readyMessages.filter(m => m.type === 'layer' && m.kind === 'stream').flatMap(m => m.ranges);
  const isSegReady = (seg) => allRanges.some(([a, b]) => seg >= a && seg <= b);
  for (const seg of [0, 10, 35, 58, 62, 70, 124]) assert.ok(isSegReady(seg), `segment ${seg} is ready`);
});

test('MP-12 browser-side per-segment manifest writing: tasks [0, 59] and [60, 124] compute the last segment of the whole stream from input.stream.lastFrame, both write the cross-task bucket 56-63, and the merged result is complete', () => {
  const lastSeg = 124;
  const rk = sha256('rk-browser-motion-125');
  const bound = { x: 0, y: 0, w: 640, h: 360 };
  const browserTask = (from, to) => ({
    id: `stream:${rk}:${from}-${to}`, kind: 'stream', resultKey: rk, range: { unit: 'segment', from, to },
    source: { projectId: PROJECT, projectRev: 1 },
    input: { clipId: 'clip-b', cardId: 'motion-card', entryKey: null, contentKey: 'ck-b', canvasHeavy: false, compositing: 'independent',
      stream: { kind: 'card', plane: 'local', clipIds: ['clip-b'], fps: 30, bound, offset: { x: 0, y: 0 }, firstFrame: 0, count: 1875, total: 1875, originFrame: 0, lastFrame: lastSeg * 15 + 14 } },
  });
  const initHash = sha256('browser-init');
  const initId = initHash.slice(0, 16);
  const partsOf = (from, to) => {
    const segments = {};
    for (let n = from; n <= to; n++) segments[n] = { hash: sha256(`browser-seg-${n}`), bytes: 100 + n, init: initId, stride: 1, samples: 15, sig: null, encoder: 'webcodecs-avc' };
    return { inits: { [initId]: { hash: initHash, bytes: 64, codec: 'avc1.640028', width: 640, height: 360, timescale: 30, rect: bound, encoder: 'webcodecs-avc' } }, segments };
  };
  // Follow host putStreamManifest approach: merge each copy with existing ones in content store
  // (mergeStreamManifest) before writing
  const store = new Map();
  const put = (task) => {
    const manifest = streamManifest(task, partsOf(task.range.from, task.range.to));
    const puts = streamManifestPuts(task, manifest);
    for (const { key, body } of puts) store.set(key, mergeStreamManifest(store.get(key), body));
    return puts.map(p => p.key);
  };
  const firstKeys = put(browserTask(0, 59));
  assert.equal(firstKeys[0], `${rk}:0-59`, 'the task\'s own key comes first');
  assert.ok(firstKeys.includes(`${rk}:56-63`), 'task [0, 59] writes the cross-task bucket 56-63');
  assert.ok(!firstKeys.includes(`${rk}:56-59`), 'not truncated to 56-59 by the task\'s range.to');
  assert.deepEqual(Object.keys(store.get(`${rk}:56-63`).segments).map(Number), [56, 57, 58, 59]);
  assert.equal(store.get(`${rk}:56-63`).header.lastFrame, lastSeg * 15 + 14, 'the browser\'s manifest header also carries the last frame of this stream (same shape as desktop)');

  const secondKeys = put(browserTask(60, 124));
  assert.ok(secondKeys.includes(`${rk}:56-63`), 'the first bucket of task [60, 124] is also 56-63');
  assert.ok(secondKeys.includes(`${rk}:120-124`) && !secondKeys.includes(`${rk}:120-127`));
  const cross = store.get(`${rk}:56-63`);
  assert.deepEqual(cross.range, { from: 56, to: 63 });
  assert.deepEqual(Object.keys(cross.segments).map(Number), [56, 57, 58, 59, 60, 61, 62, 63], 'the segments of the two tasks are merged into one bucket');
  assert.deepEqual(Object.keys(cross.inits), [initId], 'the bucket carries only the init files that are used');
  assert.ok(streamManifestCovers(cross, { resultKey: rk, range: { from: 56, to: 63 } }, { dense: true }), 'the merged cross-boundary bucket is complete');
  // Tasks landing on a single bucket (starting on bucket boundary, no more than 8 segments) only
  // write their own key
  assert.deepEqual(streamManifestPuts(browserTask(8, 15), streamManifest(browserTask(8, 15), partsOf(8, 15))).map(p => p.key), [`${rk}:8-15`]);
});

/* ------------------------------------------------------------------ 7. Preemption eligibility
   verification and safety interception */

test('MP-11 5 illegal preemption scenarios are blocked: no preemption is sent, and the server does not release the original holder either', async () => {
  const taskId = 'stream:rk-target:0-9';

  // Scenario 1: PC fingerprint does not match task required fingerprint
  {
    const env = setupQueueEnv();
    publishStreamTask(env, 'pub-1', taskId, { requires: { envFingerprint: FP_PC } });
    const bConn = 'conn-b1';
    env.mod.connect(env.ctx, bConn, { role: 'render', userId: 'u1' });
    env.mod.handle(env.ctx, bConn, { type: 'node.hello', nodeId: 'node-b1', profile: 'browser' });
    env.mod.handle(env.ctx, bConn, { type: 'task.claim', id: taskId, expectVersion: 1 });
    assert.equal(env.collector.of(bConn, 'task.claimed').length, 1);

    // PC with mismatched fingerprint attempts to preempt
    const pcConn = 'conn-pc-bad-fp';
    env.mod.connect(env.ctx, pcConn, { role: 'render', userId: 'u1' });
    env.mod.handle(env.ctx, pcConn, { type: 'node.hello', nodeId: 'node-pc-bad', profile: 'pc', envFingerprint: 'bad-fingerprint' });
    env.mod.handle(env.ctx, pcConn, { type: 'queue.watch', projects: 'all' });
    env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

    // Original holder is not released, preempting party is explicitly rejected (taken)
    assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 0, 'the original holder does not lose its lease on a fingerprint mismatch');
    assert.equal(env.collector.of(pcConn, 'task.claimed').length, 0, 'the claim from the PC with a mismatched fingerprint did not succeed');
    assert.equal(env.collector.of(pcConn, 'task.claim-rejected').length, 1, 'the preempting side receives task.claim-rejected');
    assert.equal(env.collector.of(pcConn, 'task.claim-rejected')[0].reason, 'taken');
  }

  // Scenario 2: PC node declares streams: false (and no transcode)
  {
    const env = setupQueueEnv();
    publishStreamTask(env, 'pub-1', taskId);
    const bConn = 'conn-b2';
    env.mod.connect(env.ctx, bConn, { role: 'render', userId: 'u1' });
    env.mod.handle(env.ctx, bConn, { type: 'node.hello', nodeId: 'node-b2', profile: 'browser' });
    env.mod.handle(env.ctx, bConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

    const pcConn = 'conn-pc-no-streams';
    env.mod.connect(env.ctx, pcConn, { role: 'render', userId: 'u1' });
    env.mod.handle(env.ctx, pcConn, { type: 'node.hello', nodeId: 'node-pc-no-streams', profile: 'pc', capabilities: { streams: false, transcode: false } });
    env.mod.handle(env.ctx, pcConn, { type: 'queue.watch', projects: 'all' }); // Visible, what blocks it is lack of stream capability
    env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

    assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 0, 'a PC without stream capability did not kick out the original browser');
    assert.equal(env.collector.of(pcConn, 'task.claimed').length, 0);
    assert.equal(env.collector.of(pcConn, 'task.claim-rejected').length, 1, 'the preempting side receives task.claim-rejected');
  }

  // Scenario 3: node-side canClaim returns false
  {
    const sent = [];
    const session = createNodeSession({
      nodeId: 'pc-can-claim-false',
      node: { nodeId: 'pc-can-claim-false', profile: 'pc', capabilities: { streams: true } },
      send: (m) => sent.push(m),
      now: () => 1000,
      canClaim: () => false, // Explicitly rejected
    });
    session.start();
    session.receive({ type: 'node.welcome', nodeId: 'pc-can-claim-false', resumed: [], lost: [] });
    // Push in-flight stream task on weak device
    session.receive({
      type: 'task.taken', id: taskId, version: 1, holderProfile: 'browser', holderRank: 1,
      task: { id: taskId, kind: 'stream', requires: { capabilities: { streams: true } } },
    });
    session.tick();
    assert.equal(sent.filter(m => m.type === 'task.claim').length, 0, 'the node does not initiate preemption when canClaim is false');
  }

  // Scenario 4: node declares planOnly: true
  {
    const sent = [];
    const session = createNodeSession({
      nodeId: 'pc-plan-only',
      node: { nodeId: 'pc-plan-only', profile: 'pc', planOnly: true, capabilities: { streams: true } },
      send: (m) => sent.push(m),
      now: () => 1000,
    });
    session.start();
    session.receive({ type: 'node.welcome', nodeId: 'pc-plan-only', resumed: [], lost: [] });
    session.receive({
      type: 'task.taken', id: taskId, version: 1, holderProfile: 'browser', holderRank: 1,
      task: { id: taskId, kind: 'stream', requires: { capabilities: { streams: true } } },
    });
    session.tick();
    assert.equal(sent.filter(m => m.type === 'task.claim').length, 0, 'a planOnly node does not initiate stream task preemption');
  }

  // Scenario 5: hosted node (rank 2) does not preempt when project streams: false
  {
    const env = setupQueueEnv();
    publishStreamTask(env, 'pub-1', taskId);
    const bConn = 'conn-b5';
    env.mod.connect(env.ctx, bConn, { role: 'render', userId: 'u1' });
    env.mod.handle(env.ctx, bConn, { type: 'node.hello', nodeId: 'node-b5', profile: 'browser' });
    env.mod.handle(env.ctx, bConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

    const hostConn = 'conn-host-off';
    env.mod.connect(env.ctx, hostConn, { role: 'render', userId: 'u1' });
    env.mod.handle(env.ctx, hostConn, {
      type: 'node.hello', nodeId: 'node-host-off', profile: 'host',
      capabilities: { streams: true },
      projectStreams: { [PROJECT]: false }, // Project disabled track stream generation
    });
    env.mod.handle(env.ctx, hostConn, { type: 'queue.watch', projects: [PROJECT] }); // Visible, what blocks it is the project toggle
    env.mod.handle(env.ctx, hostConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

    assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 0, 'with project streams: false, the hosted node does not preempt, and the original holder does not lose its lease');
    assert.equal(env.collector.of(hostConn, 'task.claimed').length, 0);
    assert.equal(env.collector.of(hostConn, 'task.claim-rejected').length, 1, 'the hosted node receives task.claim-rejected');
  }
});

/* ------------------------------------------------------------------ 8. Preemption info
   visibility scope, minimization, and throttling */

/** Browser claims a stream task, reply to its connection */
function browserClaims(env, taskId, connId = 'conn-browser') {
  env.mod.connect(env.ctx, connId, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, connId, { type: 'node.hello', nodeId: `node-${connId}`, profile: 'browser' });
  env.mod.handle(env.ctx, connId, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(connId, 'task.claimed').length, 1, `${connId} claimed ${taskId}`);
  return connId;
}

test('MP-13 a node throttled by the queue initiates preemption: reads throttled from describe().nodes, does not kick out the original holder first, and the claim comes back as throttled', () => {
  const env = setupQueueEnv(T0, { constants: { THROTTLE_REJECTS: 0 } });
  const taskId = 'stream:rk-throttle:0-9';
  publishStreamTask(env, 'pub-1', taskId);
  // Snapshot task with mismatched fingerprint: PC claim rejected (fingerprint-mismatch),
  // rejects this period exceed THROTTLE_REJECTS(0)
  env.mod.handle(env.ctx, 'pub-1', { type: 'task.publish', tasks: [{
    id: 'snapshot:rk-other:0-59', kind: 'snapshot', tier: 'shared', resultKey: 'rk-other', range: { unit: 'localFrame', from: 0, to: 59 },
    source: { projectId: PROJECT, projectRev: 1 }, input: { clipId: 'c1' }, weight: { class: 'medium' }, requires: { envFingerprint: 'zzzzzzzzzzzzzzzz' }, priority: 10,
  }] });
  const bConn = browserClaims(env, taskId);
  const pcConn = 'conn-pc-throttled';
  env.mod.connect(env.ctx, pcConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, pcConn, { type: 'node.hello', nodeId: 'node-pc-throttled', profile: 'pc', envFingerprint: FP_PC });
  env.mod.handle(env.ctx, pcConn, { type: 'queue.watch', projects: [PROJECT] });
  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: 'snapshot:rk-other:0-59', expectVersion: 1 });
  assert.equal(env.collector.of(pcConn, 'task.claim-rejected')[0]?.reason, 'fingerprint-mismatch');
  assert.equal(env.q.describe().nodes.find(n => n.nodeId === 'node-pc-throttled').throttled, true, 'the queue is throttling this PC right now');

  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 0, 'the original holder\'s lease is untouched');
  assert.equal(env.q.describe().tasks.find(x => x.id === taskId).claim.nodeId, `node-${bConn}`);
  const rejected = env.collector.of(pcConn, 'task.claim-rejected').filter(m => m.id === taskId);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'throttled', 'the queue rejects it due to throttling, and the claiming side\'s in-flight claim is cleared');

  // Next scan clears throttling, can preempt as usual
  env.mod.tick(env.ctx);
  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 1);
  assert.equal(env.collector.of(pcConn, 'task.claimed').filter(m => m.id === taskId).length, 1);
});

test('MP-14 claimedStreams and task.taken: only sent to connections that can see them, carry only minimal fields, no claim token; a pure browser gets nothing', () => {
  const env = setupQueueEnv();
  const mine = 'stream:rk-mine:0-59';
  const other = 'stream:rk-elsewhere:0-59';
  publishStreamTask(env, 'pub-1', mine, { requires: { capabilities: { streams: true } } });
  // Stream task from another project
  env.mod.handle(env.ctx, 'pub-1', { type: 'task.publish', tasks: [{
    id: other, kind: 'stream', resultKey: 'rk-elsewhere', range: { unit: 'segment', from: 0, to: 59 },
    source: { projectId: 'proj-elsewhere', projectRev: 1 }, input: { clipId: 'clip-x', contentKey: 'ck-x' },
    weight: { class: 'medium', estMs: null, frames: 900 }, requires: {}, priority: 10,
  }] });

  // Hosted node only watches this project, checks in first (later receives task.taken when
  // browser claims)
  const hostConn = 'conn-host-watch';
  env.mod.connect(env.ctx, hostConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, hostConn, { type: 'node.hello', nodeId: 'node-host-watch', profile: 'host', envFingerprint: FP_HOST, capabilities: { streams: true } });
  env.mod.handle(env.ctx, hostConn, { type: 'queue.watch', projects: [PROJECT] });
  // Another pure browser also watches this project (receives task.taken, but does not
  // preempt others)
  const watcher = 'conn-browser-watch';
  env.mod.connect(env.ctx, watcher, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, watcher, { type: 'node.hello', nodeId: 'node-browser-watch', profile: 'browser' });
  env.mod.handle(env.ctx, watcher, { type: 'queue.watch', projects: [PROJECT] });
  const bConn = browserClaims(env, mine);
  browserClaims(env, other, 'conn-browser-2');

  // task.taken: visible one carries minimal task view, without token
  const taken = env.collector.of(hostConn, 'task.taken');
  assert.deepEqual(taken.map(m => m.id), [mine], 'task.taken of another project is not sent to a hosted node that only watches this project');
  assert.equal(taken[0].holderProfile, 'browser');
  assert.equal(taken[0].holderRank, 1);
  assert.deepEqual(Object.keys(taken[0].task).sort(), ['id', 'input', 'kind', 'requires', 'source', 'version', 'weight']);
  assert.equal(taken[0].task.kind, 'stream');
  assert.deepEqual(taken[0].task.source, { projectId: PROJECT });
  assert.ok(!JSON.stringify(taken[0]).includes('"claim"') && !JSON.stringify(taken[0]).includes('"token"'), 'task.taken does not carry the original holder\'s claim token');

  // claimedStreams in queue.snapshot: likewise only lists visible, minimal fields
  env.mod.handle(env.ctx, hostConn, { type: 'queue.watch', projects: [PROJECT] });
  const snap = env.collector.of(hostConn, 'queue.snapshot').at(-1);
  assert.deepEqual(snap.claimedStreams.map(s => s.id), [mine], 'lists only the in-flight stream tasks visible to this connection (of this project)');
  const [s] = snap.claimedStreams;
  assert.deepEqual(Object.keys(s).sort(), ['density', 'holderProfile', 'holderRank', 'id', 'task', 'version']);
  assert.deepEqual(s.task, {
    id: mine, kind: 'stream', version: s.version, source: { projectId: PROJECT }, weight: { class: 'medium' },
    requires: { capabilities: { streams: true } }, input: {},
  });
  assert.ok(!JSON.stringify(snap.claimedStreams).includes('"token"') && !JSON.stringify(snap.claimedStreams).includes('"claim"'));
  assert.ok(!JSON.stringify(snap.claimedStreams).includes('ck-1'), 'does not carry input details such as the content key');

  // Pure browser: does not preempt others, claimedStreams is empty, task.taken carries neither
  // task view nor holder
  env.mod.handle(env.ctx, bConn, { type: 'queue.watch', projects: [PROJECT] });
  assert.deepEqual(env.collector.of(bConn, 'queue.snapshot').at(-1).claimedStreams, []);
  const browserTaken = env.collector.of(watcher, 'task.taken');
  assert.deepEqual(browserTaken.map(m => m.id), [mine]);
  for (const m of browserTaken) assert.ok(m.task === undefined && m.holderProfile === null && m.holderRank === null, 'task.taken received by a pure browser carries neither the task view nor the holder');
});

test('MP-15 when a project has "Generate track streams" turned off, the hosted node does not take over that project\'s browser stream tasks: claimedStreams in the real queue.snapshot carries kind and project, and canClaim can block it', () => {
  const env = setupQueueEnv();
  const taskId = 'stream:rk-host-gate:0-59';
  publishStreamTask(env, 'pub-1', taskId, { requires: { capabilities: { streams: true } } });
  const bConn = browserClaims(env, taskId);

  // Hosted node session connects to document service module; canClaim matches streamsPass
  // in host.mjs: never claims stream tasks when project disables track stream generation
  let streamsOn = false;
  const hostConn = 'conn-host-gate';
  env.mod.connect(env.ctx, hostConn, { role: 'render', userId: 'u1' });
  const seenTasks = [];
  const sent = [];
  const session = createNodeSession({
    nodeId: 'node-host-gate',
    node: { profile: 'host', envFingerprint: FP_HOST, codeVersions: [CV], capabilities: { streams: true }, maxConcurrent: 1 },
    projects: [PROJECT],
    send: (m) => { sent.push(m); env.mod.handle(env.ctx, hostConn, m); },
    now: env.clock.now,
    canClaim: (task) => { seenTasks.push(task); return task?.kind !== 'stream' || streamsOn !== false; },
  });
  const deliver = () => { for (const m of env.collector.of(hostConn)) session.receive(m); env.collector.clear(); };
  env.collector.clear();
  session.start();
  deliver();

  session.tick();
  assert.equal(sent.filter(m => m.type === 'task.claim').length, 0, 'project turned off generate track streams: no preemption is sent');
  const judged = seenTasks.find(x => x.id === taskId);
  assert.ok(judged, 'canClaim received the in-flight stream task');
  assert.equal(judged.kind, 'stream', 'canClaim can tell it is a stream task');
  assert.equal(judged.source.projectId, PROJECT, 'canClaim can tell which project it belongs to');
  assert.equal(env.q.describe().tasks.find(x => x.id === taskId).claim.nodeId, `node-${bConn}`, 'the browser still holds it');

  // Enable track stream generation: tasks in the same snapshot can be preempted as usual
  streamsOn = true;
  session.tick();
  assert.equal(sent.filter(m => m.type === 'task.claim').length, 1);
  assert.equal(env.q.describe().tasks.find(x => x.id === taskId).claim.nodeId, 'node-host-gate', 'the hosted node takes over');
});

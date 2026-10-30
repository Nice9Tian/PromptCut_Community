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

/* ------------------------------------------------------------------ 1. 卡片 Writing / FrameMode 判定 */

test('MP-01 isMotionCard: 识别 remotion 式与 motion 式卡片', () => {
  // 内置 motion 式卡片（审阅表）
  assert.equal(isMotionCard({ cardId: 'focus-card' }), true, 'focus-card 为 motion');
  assert.equal(isMotionCard({ cardId: 'punch-pill' }), true, 'punch-pill 为 motion');
  assert.equal(isMotionCard({ cardId: 'scene-3d' }), true, 'scene-3d 为 motion');

  // 内置 remotion 式卡片（审阅表）
  assert.equal(isMotionCard({ cardId: 'caption-track' }), false, 'caption-track 为 remotion');
  assert.equal(isMotionCard({ cardId: 'lottie' }), false, 'lottie 为 remotion');

  // 显式 writing 覆盖
  assert.equal(isMotionCard({ writing: 'motion' }), true);
  assert.equal(isMotionCard({ writing: 'remotion' }), false);
  assert.equal(isMotionCard({ capabilities: { writing: 'motion' } }), true);
  assert.equal(isMotionCard({ capabilities: { writing: 'remotion' } }), false);

  // frameMode 声明
  assert.equal(isMotionCard({ frameMode: 'stateful' }), true);
  assert.equal(isMotionCard({ frameMode: 'direct' }), false);

  // 页面端实现对拍
  assert.equal(isMotionCardPage({ cardId: 'focus-card' }), true);
  assert.equal(isMotionCardPage({ cardId: 'caption-track' }), false);
  assert.equal(isMotionCardPage({ writing: 'motion' }), true);
  assert.equal(isMotionCardPage({ writing: 'remotion' }), false);
  assert.equal(isMotionCardPage({ frameMode: 'stateful' }), true);
  assert.equal(isMotionCardPage({ frameMode: 'direct' }), false);
});

/* ------------------------------------------------------------------ 2. 分段切块大小 */

test('MP-02 切分流任务：motion 卡至少 30 秒（60段），短于 30s 仅 1 个任务；remotion 保持 8 段；sparse 整卡 1 任务', () => {
  const baseTask = {
    id: 'plan-1', kind: 'plan', resultKey: `${PROJECT}@1`, range: null,
    source: { projectId: PROJECT, projectRev: 1 }, input: {}, weight: { class: 'medium' }, requires: {}, priority: 1,
  };

  // (a) Motion 卡：10 段（150 帧，5 秒，< 30 秒） -> 仅 1 个任务 [0, 9]
  const motionShortStreams = [{
    streamKey: 'stream-motion-short', topClipId: 'c-m1', firstSegment: 0, lastSegment: 9, fps: 30,
    cardId: 'focus-card',
  }];
  const tasksMotionShort = splitPlan({
    planTask: baseTask, streams: motionShortStreams, envFingerprint: FP_PC, codeVersion: CV,
  }).filter(t => t.kind === 'stream');
  assert.equal(tasksMotionShort.length, 1, '短于 30 秒的 motion 卡只切 1 个任务');
  assert.deepEqual([tasksMotionShort[0].range.from, tasksMotionShort[0].range.to], [0, 9]);

  // (b) Motion 卡：超过 30 秒（60 段）切分，尾段不足 60 段并入前一段：
  // 75 段（尾部 15 段不足 60）并入前一段 -> 1 个任务 [0, 74]
  // 125 段（第 2 段 65 段 >= 60）-> 切成 2 个任务：[0, 59] 和 [60, 124]
  const tasksMotion75 = splitPlan({
    planTask: baseTask, streams: [{ streamKey: 's75', topClipId: 'c75', firstSegment: 0, lastSegment: 74, fps: 30, cardId: 'focus-card' }],
    envFingerprint: FP_PC, codeVersion: CV,
  }).filter(t => t.kind === 'stream');
  assert.equal(tasksMotion75.length, 1, '75 段 motion 卡尾部不足 60 段并入前一段');
  assert.deepEqual([tasksMotion75[0].range.from, tasksMotion75[0].range.to], [0, 74]);

  const tasksMotion125 = splitPlan({
    planTask: baseTask, streams: [{ streamKey: 's125', topClipId: 'c125', firstSegment: 0, lastSegment: 124, fps: 30, cardId: 'focus-card' }],
    envFingerprint: FP_PC, codeVersion: CV,
  }).filter(t => t.kind === 'stream');
  assert.equal(tasksMotion125.length, 2, '超过 60 段且每段至少 60 段');
  assert.deepEqual([tasksMotion125[0].range.from, tasksMotion125[0].range.to], [0, 59]);
  assert.deepEqual([tasksMotion125[1].range.from, tasksMotion125[1].range.to], [60, 124]);

  // (c) Remotion 卡：10 段 -> 仍按 8 段切分：[0, 7] 和 [8, 9]
  const remotionStreams = [{
    streamKey: 'stream-remotion', topClipId: 'c-r1', firstSegment: 0, lastSegment: 9, fps: 30,
    cardId: 'caption-track',
  }];
  const tasksRemotion = splitPlan({
    planTask: baseTask, streams: remotionStreams, envFingerprint: FP_PC, codeVersion: CV,
  }).filter(t => t.kind === 'stream');
  assert.equal(tasksRemotion.length, 2, 'remotion 卡保持 8 段切分');
  assert.deepEqual([tasksRemotion[0].range.from, tasksRemotion[0].range.to], [0, 7]);
  assert.deepEqual([tasksRemotion[1].range.from, tasksRemotion[1].range.to], [8, 9]);

  // (d) 稀疏流任务（sparse）：整张卡 1 个任务
  const sparseStreams = [{
    streamKey: 'stream-sparse', topClipId: 'c-sp', firstSegment: 0, lastSegment: 74, fps: 30,
    cardId: 'focus-card',
  }];
  const tasksSparse = splitPlan({
    planTask: baseTask, streams: sparseStreams, envFingerprint: FP_PC, codeVersion: CV, sparseStreams: true,
  }).filter(t => t.kind === 'stream' && t.id.endsWith(':sparse'));
  assert.equal(tasksSparse.length, 1, '稀疏流任务整张卡仅 1 个任务');
  assert.deepEqual([tasksSparse[0].range.from, tasksSparse[0].range.to], [0, 74]);
});

/* ------------------------------------------------------------------ 3. 设备等级判定 */

test('MP-03 deviceRank：桌面版 (3) > 托管方渲染服务且带 streams (2) > 浏览器 / 不带 streams (1)', () => {
  assert.equal(deviceRank({ profile: 'pc' }), 3);
  assert.equal(deviceRank({ profile: 'host', capabilities: { streams: true } }), 2);
  assert.equal(deviceRank({ profile: 'host', capabilities: { streams: false } }), 1);
  assert.equal(deviceRank({ profile: 'host' }), 1);
  assert.equal(deviceRank({ profile: 'browser' }), 1);
  assert.equal(deviceRank(null), 0);
});

/* ------------------------------------------------------------------ 4. 队列跨层抢占机制 */

function setupQueueEnv(startAt = T0, { constants } = {}) {
  const clock = createFakeClock(startAt);
  const collector = createMessageCollector();
  // 队列发出的每条消息先过文档服务模块的 outbound(组装层就是这么接的:`claimedStreams`、`task.taken` 的抢占信息在那里挂上)
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

test('MP-04 跨层抢占：PC (rank 3) 抢占浏览器 (rank 1) 执行中的 stream 任务', () => {
  const env = setupQueueEnv();
  const taskId = 'stream:rk-test:0-9';
  publishStreamTask(env, 'pub-1', taskId);

  // 1. 浏览器连接并认领任务
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

  // 2. PC 连接
  const pcConn = 'conn-pc';
  env.mod.connect(env.ctx, pcConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, pcConn, {
    type: 'node.hello', nodeId: 'node-pc', profile: 'pc', envFingerprint: FP_PC,
  });
  env.mod.handle(env.ctx, pcConn, { type: 'queue.watch', projects: 'all' });

  // 3. PC 发起抢占认领
  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

  // 4. 断言：浏览器收到 task.lease-lost 且 reason 为 preempted
  const lost = env.collector.of(browserConn, 'task.lease-lost');
  assert.equal(lost.length, 1, '浏览器应收到 1 条 lease-lost');
  assert.equal(lost[0].id, taskId);
  assert.equal(lost[0].reason, 'preempted');
  assert.equal(lost[0].token, browserToken);

  // 5. 断言：PC 成功获得该任务（收到 task.claimed）
  const pcClaimed = env.collector.of(pcConn, 'task.claimed');
  assert.equal(pcClaimed.length, 1, 'PC 应成功认领被抢占的任务');
  assert.equal(pcClaimed[0].id, taskId);
});

test('MP-05 跨层抢占：Host (rank 2) 抢占浏览器 (rank 1)；但同层浏览器之间不可相互抢占', () => {
  const env = setupQueueEnv();
  const taskId = 'stream:rk-test2:0-9';
  publishStreamTask(env, 'pub-1', taskId);

  // 1. 浏览器 A 认领
  const b1Conn = 'conn-b1';
  env.mod.connect(env.ctx, b1Conn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, b1Conn, {
    type: 'node.hello', nodeId: 'node-b1', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, b1Conn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(b1Conn, 'task.claimed').length, 1);

  // 2. 浏览器 B 尝试抢占浏览器 A -> 失败（返回 taken）
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
  assert.equal(env.collector.of(b1Conn, 'task.lease-lost').length, 0, '浏览器 A 租约未丢失');

  // 3. 带 streams 能力的 Host (rank 2) 抢占浏览器 A -> 成功
  const hostConn = 'conn-host';
  env.mod.connect(env.ctx, hostConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, hostConn, {
    type: 'node.hello', nodeId: 'node-host', profile: 'host', envFingerprint: FP_HOST,
    capabilities: { streams: true },
  });
  // 抢占只对看得见的任务(watch 了这个项目)
  env.mod.handle(env.ctx, hostConn, { type: 'queue.watch', projects: [PROJECT] });
  env.mod.handle(env.ctx, hostConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

  // 浏览器 A 收到 lease-lost preempted
  const lost = env.collector.of(b1Conn, 'task.lease-lost');
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason, 'preempted');

  // Host 认领成功
  const hostClaimed = env.collector.of(hostConn, 'task.claimed');
  assert.equal(hostClaimed.length, 1);
  assert.equal(hostClaimed[0].id, taskId);
});

test('MP-06 非 stream 任务（快照与计划）不被抢占', () => {
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

  // 浏览器认领快照
  const bConn = 'conn-b';
  env.mod.connect(env.ctx, bConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, bConn, {
    type: 'node.hello', nodeId: 'node-b', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, bConn, { type: 'task.claim', id: snapId, expectVersion: 1 });
  assert.equal(env.collector.of(bConn, 'task.claimed').length, 1);

  // PC 尝试抢占 -> 拒绝（taken）
  const pcConn = 'conn-pc';
  env.mod.connect(env.ctx, pcConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, pcConn, { type: 'node.hello', nodeId: 'node-pc', profile: 'pc' });
  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: snapId, expectVersion: 1 });

  const rejected = env.collector.of(pcConn, 'task.claim-rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'taken');
  assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 0);
});

/* ------------------------------------------------------------------ 5. 会话状态机：无 open 任务时抢占候选选择 */

test('MP-07 节点会话：无 open 候选时，PC 自动发起对弱设备 stream 任务的抢占，且优先抢占稀疏流', () => {
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

  // 收到快照，没有 open 任务，但有弱设备（browser）持有的两条 stream 任务（一条满密度，一条 sparse）
  session.receive({
    type: 'queue.snapshot',
    tasks: [],
    claimedStreams: [
      { id: 'stream:rk-dense:0-59', version: 2, holderProfile: 'browser', holderRank: 1, density: null, task: { id: 'stream:rk-dense:0-59', kind: 'stream', requires: { envFingerprint: FP_PC, capabilities: { streams: true } } } },
      { id: 'stream:rk-sparse:0-59:sparse', version: 2, holderProfile: 'browser', holderRank: 1, density: 'sparse', task: { id: 'stream:rk-sparse:0-59:sparse', kind: 'stream', requires: { envFingerprint: FP_PC, capabilities: { streams: true } } } },
    ],
  });

  // tick 触发认领
  session.tick();

  // 断言：发送了 task.claim，且优先抢占 sparse 任务
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'task.claim');
  assert.equal(sent[0].id, 'stream:rk-sparse:0-59:sparse', 'sparse 流任务优先被抢占');
  assert.equal(sent[0].expectVersion, 2);
});

/* ------------------------------------------------------------------ 6. 穿梭/拖动保活 (Scrubbing Keepalive) */

test('MP-08 拖动/穿梭保活：浏览器报 node.active (busy: scrub) 刷新租约与停滞计时，免于超时并防同层抢占', () => {
  const env = setupQueueEnv();
  const taskId = 'stream:rk-scrub:0-9';
  publishStreamTask(env, 'pub-1', taskId);

  // 浏览器认领
  const bConn = 'conn-b';
  env.mod.connect(env.ctx, bConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, bConn, {
    type: 'node.hello', nodeId: 'node-b', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, bConn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(bConn, 'task.claimed').length, 1);

  // 时间推进 25 秒（未超 LEASE_MS 30s，但若不刷新即将过期）
  env.clock.advance(25_000);

  // 用户正在穿梭拖动，浏览器报 node.active { busy: 'scrub' }
  env.mod.handle(env.ctx, bConn, { type: 'node.active', busy: 'scrub' });

  // 时间再推进 10 秒（累计 35 秒，超过原先 30 秒的 leaseUntil）
  env.clock.advance(10_000);

  // 触发队列 tick 扫描
  env.mod.tick(env.ctx);

  // 校验任务状态：未被 lease-expired 回收，仍处于 claimed
  const d = env.q.describe();
  const task = d.tasks.find(t => t.id === taskId);
  assert.equal(task.state, 'claimed', '因 scrub 保活，任务未超时回收');
  assert.equal(task.claim.nodeId, 'node-b');

  // 同层浏览器尝试认领 -> 依旧被拒（taken）
  const b2Conn = 'conn-b2';
  env.mod.connect(env.ctx, b2Conn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, b2Conn, {
    type: 'node.hello', nodeId: 'node-b2', profile: 'browser',
    environment: { platform: 'Win32', userAgent: 'Chrome/120.0.0.0', renderer: 'WebGL', vendor: 'Google' },
  });
  env.mod.handle(env.ctx, b2Conn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(b2Conn, 'task.claim-rejected').length, 1);

  // 但更强设备（PC）仍可跨层抢占
  const pcConn = 'conn-pc';
  env.mod.connect(env.ctx, pcConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, pcConn, { type: 'node.hello', nodeId: 'node-pc', profile: 'pc' });
  env.mod.handle(env.ctx, pcConn, { type: 'queue.watch', projects: 'all' });
  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: task.version });

  assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 1);
  assert.equal(env.collector.of(bConn, 'task.lease-lost')[0].reason, 'preempted');
  assert.equal(env.collector.of(pcConn, 'task.claimed').length, 1);
});

test('MP-09 被抢占的浏览器节点：收到 task.lease-lost (preempted) 立即中止 runController 并停工', async () => {
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
  // 模拟文档服务报到成功
  node.receive({ type: 'node.welcome', nodeId: 'browser-test', envFingerprint: FP_BROWSER, resumed: [], lost: [] });
  // 模拟认领任务
  node.receive({ type: 'task.claimed', id: taskId, token: 11, task });
  await flush();

  // 校验任务已交给 bakeStream 开始执行
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job.signal.aborted, false, '开工时 signal 未中止');

  // 模拟收到抢占导致的 lease-lost
  node.receive({ type: 'task.lease-lost', id: taskId, token: 11, reason: 'preempted' });
  await flush();

  // 断言：执行器立即中止（signal.aborted 为 true）
  assert.equal(jobs[0].job.signal.aborted, true, '被抢占后 signal 立即中止');
  assert.equal(node.debug().counters.lost, 1, 'lost 计数加 1');

  // 即使 bakeStream 随后迟到返回，也不再发 task.complete
  jobs[0].resolve({ manifest: { header: {}, segments: {} } });
  await flush();
  assert.equal(sent.filter(m => m.type === 'task.complete').length, 0, '迟到的产出被丢弃，不发 task.complete');
});

/* ------------------------------------------------------------------ 6. 端到端：125 段 motion 卡两个满密度任务写清单后，跨界桶合并、播放器按层表读、别的形状的任务按桶查得到 */

/** 流库里一条流的落盘形状(预渲染进程的 StreamStore:`<库根>/streams/<流键>/stream.json` + 开头文件 + 分段文件) */
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

/** 内容库替身:`get` / `put` 照 `ContentClient` 的形状;`storage` 键是 `<kind>/<key>` */
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

test('MP-10 端到端：125 段 motion 卡任务 [0, 59]、[60, 124] 经真实 collectStreamResult → writeManifest，跨界桶 56-63 合并，OnlineSnapshotSource 按层表读出各分段，别的形状的任务按桶查得到', async (t) => {
  const lastSeg = 124; // 125 个分段：0～124，motion 卡满密度切成 [0, 59] 和 [60, 124]
  const originFrame = 0;
  const lastFrame = originFrame + lastSeg * 15 + 9; // 最后一段不满 15 帧
  const rk = sha256('rk-motion-125');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-mp10-'));
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-mp10-empty-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(empty, { recursive: true, force: true })]));
  await writeStreamStore(root, { streamKey: rk, lastSegment: lastSeg, originFrame, lastFrame });

  const content = memoryContentStore();
  const { storage } = content;
  const blobStore = new Map();
  // 切分方给桌面节点出的满密度任务：不带 `input.stream`(`below-stream.test.mjs` 守着这一条)，整条流的最后一段只能从流库经清单 header 得知
  const taskOf = (from, to) => ({
    id: `stream:${rk}:${from}-${to}`, kind: 'stream', resultKey: rk, range: { unit: 'segment', from, to },
    source: { projectId: PROJECT, projectRev: 1 }, input: { clipId: 'clip-motion-125', cardId: null, entryKey: null, contentKey: 'ck-m125' },
    weight: { class: 'heavy', estMs: null, frames: (to - from + 1) * 15 }, requires: { envFingerprint: FP_PC, capabilities: { streams: true } }, priority: 10,
  });
  /** 节点推送那一步:真实的 `collectStreamResult` 列清单，块按哈希收进素材服务替身，清单原样写内容库 */
  const produce = async (task) => {
    const { result, readBlob } = await collectStreamResult({ root }, task);
    for (const meta of [...Object.values(result.inits), ...Object.values(result.segments)]) blobStore.set(meta.hash, new Uint8Array(await readBlob(meta.hash)));
    assert.equal(await writeManifest(content, result), true);
    return result;
  };
  const client = { has: async (_ns, hash) => blobStore.has(hash), put: async () => { throw new Error('查找不推块'); } };
  const sink = createAssetSink({ pipeline: { root: empty }, client, content });
  const segsOf = (key) => Object.keys(storage.get(`render-manifest/${rk}:${key}`)?.segments ?? {}).map(Number);

  // 1. 任务 [0, 59]：清单是 collectStreamResult 的原样输出(header 带这条流的最后一帧，取自流库的 stream.json)，最后一个桶是 56-63
  const first = await produce(taskOf(0, 59));
  assert.deepEqual(Object.keys(first).sort(), ['header', 'inits', 'kind', 'range', 'resultKey', 'segments', 'v'], '清单只有 collectStreamResult 的那几项');
  assert.equal(first.header.originFrame, originFrame);
  assert.equal(first.header.lastFrame, lastFrame, 'header.lastFrame 取自流库');
  assert.ok(storage.has(`render-manifest/${rk}:0-59`), '任务自己的键照写');
  assert.deepEqual(segsOf('48-55'), [48, 49, 50, 51, 52, 53, 54, 55]);
  assert.deepEqual(segsOf('56-63'), [56, 57, 58, 59], '任务 [0, 59] 的最后一个桶键是 56-63(只装着它自己的 56～59)');
  assert.ok(!storage.has(`render-manifest/${rk}:56-59`), '不按任务的 range.to 截成 56-59');
  assert.equal(await sink.has(taskOf(60, 124)), false, '后一半还没产出：按桶查不全');

  // 2. 任务 [60, 124]：第一个桶也是 56-63，与前一个任务写的同一个键，经 mergedForWrite 合在一份里
  await produce(taskOf(60, 124));
  assert.deepEqual(segsOf('56-63'), [56, 57, 58, 59, 60, 61, 62, 63], '跨界桶 56-63 两边的分段合在一起');
  assert.deepEqual(segsOf('120-124'), [120, 121, 122, 123, 124], '末尾的桶截到整条流的最后一段');
  assert.ok(!storage.has(`render-manifest/${rk}:56-59`) && !storage.has(`render-manifest/${rk}:120-127`));

  // 3. 查找(lookup)按同一个规矩算桶的终点：别的形状的任务(整条流一个、跨两个桶的一小段)自己的键没有，按桶拼得出来
  assert.equal(await sink.has(taskOf(0, 124)), true, '整条流 [0, 124]：拼 16 个桶，末尾那个桶的终点由取到的桶的 header.lastFrame 定');
  assert.equal(await sink.has(taskOf(50, 62)), true, '[50, 62]：48-55 与 56-63 两个桶');
  const whole = await sink.resultFor(taskOf(0, 124));
  assert.deepEqual(Object.keys(whole.segments).map(Number), Array.from({ length: 125 }, (_, n) => n));

  // 4. 层表(标准 8 段一桶 segmentsPerTask: 8)：播放器按桶取清单、取块
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
  // 第 0、10、35 段;跨界桶 56-63 里的第 58 段(29 s)与第 62 段(31 s);后半任务的第 70 段(35 s)与末尾第 124 段(62 s)
  for (const sec of [0, 5, 17.5, 29, 31, 35, 62]) await settleSource(sec);
  const allRanges = readyMessages.filter(m => m.type === 'layer' && m.kind === 'stream').flatMap(m => m.ranges);
  const isSegReady = (seg) => allRanges.some(([a, b]) => seg >= a && seg <= b);
  for (const seg of [0, 10, 35, 58, 62, 70, 124]) assert.ok(isSegReady(seg), `第 ${seg} 段已就绪`);
});

test('MP-12 浏览器端分段写清单：任务 [0, 59]、[60, 124] 按 input.stream.lastFrame 算整条流的最后一段，都写跨任务桶 56-63，合并后齐全', () => {
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
  // 照宿主 putStreamManifest 的做法:每一份先和内容库里已有的合并(mergeStreamManifest),再写
  const store = new Map();
  const put = (task) => {
    const manifest = streamManifest(task, partsOf(task.range.from, task.range.to));
    const puts = streamManifestPuts(task, manifest);
    for (const { key, body } of puts) store.set(key, mergeStreamManifest(store.get(key), body));
    return puts.map(p => p.key);
  };
  const firstKeys = put(browserTask(0, 59));
  assert.equal(firstKeys[0], `${rk}:0-59`, '任务自己的键在第一份');
  assert.ok(firstKeys.includes(`${rk}:56-63`), '任务 [0, 59] 写跨任务桶 56-63');
  assert.ok(!firstKeys.includes(`${rk}:56-59`), '不按任务的 range.to 截成 56-59');
  assert.deepEqual(Object.keys(store.get(`${rk}:56-63`).segments).map(Number), [56, 57, 58, 59]);
  assert.equal(store.get(`${rk}:56-63`).header.lastFrame, lastSeg * 15 + 14, '浏览器的清单 header 也带这条流的最后一帧(与桌面同形)');

  const secondKeys = put(browserTask(60, 124));
  assert.ok(secondKeys.includes(`${rk}:56-63`), '任务 [60, 124] 的第一个桶也是 56-63');
  assert.ok(secondKeys.includes(`${rk}:120-124`) && !secondKeys.includes(`${rk}:120-127`));
  const cross = store.get(`${rk}:56-63`);
  assert.deepEqual(cross.range, { from: 56, to: 63 });
  assert.deepEqual(Object.keys(cross.segments).map(Number), [56, 57, 58, 59, 60, 61, 62, 63], '两个任务的分段合在一个桶里');
  assert.deepEqual(Object.keys(cross.inits), [initId], '桶里只带用到的开头文件');
  assert.ok(streamManifestCovers(cross, { resultKey: rk, range: { from: 56, to: 63 } }, { dense: true }), '合并后的跨界桶整桶齐全');
  // 落在一个桶上的任务(起点在桶边上、不超过 8 段)只写自己的键
  assert.deepEqual(streamManifestPuts(browserTask(8, 15), streamManifest(browserTask(8, 15), partsOf(8, 15))).map(p => p.key), [`${rk}:8-15`]);
});

/* ------------------------------------------------------------------ 7. 抢占资格校验与安全拦截 */

test('MP-11 5 种非法抢占场景被拦截：不发出抢占，服务端也不释放原持有方', async () => {
  const taskId = 'stream:rk-target:0-9';

  // 场景 1：PC 指纹与任务要求指纹不符
  {
    const env = setupQueueEnv();
    publishStreamTask(env, 'pub-1', taskId, { requires: { envFingerprint: FP_PC } });
    const bConn = 'conn-b1';
    env.mod.connect(env.ctx, bConn, { role: 'render', userId: 'u1' });
    env.mod.handle(env.ctx, bConn, { type: 'node.hello', nodeId: 'node-b1', profile: 'browser' });
    env.mod.handle(env.ctx, bConn, { type: 'task.claim', id: taskId, expectVersion: 1 });
    assert.equal(env.collector.of(bConn, 'task.claimed').length, 1);

    // 异指纹 PC 尝试抢占
    const pcConn = 'conn-pc-bad-fp';
    env.mod.connect(env.ctx, pcConn, { role: 'render', userId: 'u1' });
    env.mod.handle(env.ctx, pcConn, { type: 'node.hello', nodeId: 'node-pc-bad', profile: 'pc', envFingerprint: 'bad-fingerprint' });
    env.mod.handle(env.ctx, pcConn, { type: 'queue.watch', projects: 'all' });
    env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

    // 原持有方不被释放，抢占方被明确拒绝（taken）
    assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 0, '指纹不符时原持有方未丢失租约');
    assert.equal(env.collector.of(pcConn, 'task.claimed').length, 0, '指纹不符的 PC 认领未成功');
    assert.equal(env.collector.of(pcConn, 'task.claim-rejected').length, 1, '抢占方收到 task.claim-rejected');
    assert.equal(env.collector.of(pcConn, 'task.claim-rejected')[0].reason, 'taken');
  }

  // 场景 2：PC 节点声明 streams: false（且无 transcode）
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
    env.mod.handle(env.ctx, pcConn, { type: 'queue.watch', projects: 'all' }); // 看得见,挡它的是没有流能力
    env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

    assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 0, '无流能力 PC 未踢掉原浏览器');
    assert.equal(env.collector.of(pcConn, 'task.claimed').length, 0);
    assert.equal(env.collector.of(pcConn, 'task.claim-rejected').length, 1, '抢占方收到 task.claim-rejected');
  }

  // 场景 3：节点侧 canClaim 返回 false
  {
    const sent = [];
    const session = createNodeSession({
      nodeId: 'pc-can-claim-false',
      node: { nodeId: 'pc-can-claim-false', profile: 'pc', capabilities: { streams: true } },
      send: (m) => sent.push(m),
      now: () => 1000,
      canClaim: () => false, // 明确拒绝
    });
    session.start();
    session.receive({ type: 'node.welcome', nodeId: 'pc-can-claim-false', resumed: [], lost: [] });
    // 推入弱设备在途流任务
    session.receive({
      type: 'task.taken', id: taskId, version: 1, holderProfile: 'browser', holderRank: 1,
      task: { id: taskId, kind: 'stream', requires: { capabilities: { streams: true } } },
    });
    session.tick();
    assert.equal(sent.filter(m => m.type === 'task.claim').length, 0, 'canClaim 为 false 时节点不发起抢占');
  }

  // 场景 4：节点声明 planOnly: true
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
    assert.equal(sent.filter(m => m.type === 'task.claim').length, 0, 'planOnly 节点不发起流任务抢占');
  }

  // 场景 5：托管节点 (rank 2) 在项目 streams: false 时不抢占
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
      projectStreams: { [PROJECT]: false }, // 项目关闭了生成轨道流
    });
    env.mod.handle(env.ctx, hostConn, { type: 'queue.watch', projects: [PROJECT] }); // 看得见,挡它的是项目开关
    env.mod.handle(env.ctx, hostConn, { type: 'task.claim', id: taskId, expectVersion: 1 });

    assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 0, '项目 streams: false 时托管节点不抢占，原持有方未丢失租约');
    assert.equal(env.collector.of(hostConn, 'task.claimed').length, 0);
    assert.equal(env.collector.of(hostConn, 'task.claim-rejected').length, 1, '托管节点收到 task.claim-rejected');
  }
});

/* ------------------------------------------------------------------ 8. 抢占信息的可见范围、最小化与限流 */

/** 浏览器认领一条流任务,回它的连接 */
function browserClaims(env, taskId, connId = 'conn-browser') {
  env.mod.connect(env.ctx, connId, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, connId, { type: 'node.hello', nodeId: `node-${connId}`, profile: 'browser' });
  env.mod.handle(env.ctx, connId, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(connId, 'task.claimed').length, 1, `${connId} 认领了 ${taskId}`);
  return connId;
}

test('MP-13 被队列限流的节点发起抢占：读 describe().nodes 的 throttled，不先踢掉原持有方，认领回 throttled', () => {
  const env = setupQueueEnv(T0, { constants: { THROTTLE_REJECTS: 0 } });
  const taskId = 'stream:rk-throttle:0-9';
  publishStreamTask(env, 'pub-1', taskId);
  // 一条指纹对不上的快照任务:PC 认领它被拒(fingerprint-mismatch),本周期的拒绝数超过 THROTTLE_REJECTS(0)
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
  assert.equal(env.q.describe().nodes.find(n => n.nodeId === 'node-pc-throttled').throttled, true, '队列此刻限流这台 PC');

  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 0, '原持有方的租约不动');
  assert.equal(env.q.describe().tasks.find(x => x.id === taskId).claim.nodeId, `node-${bConn}`);
  const rejected = env.collector.of(pcConn, 'task.claim-rejected').filter(m => m.id === taskId);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'throttled', '队列按限流回拒,认领方的在飞认领清掉');

  // 下一次扫描清掉限流后照常能抢
  env.mod.tick(env.ctx);
  env.mod.handle(env.ctx, pcConn, { type: 'task.claim', id: taskId, expectVersion: 1 });
  assert.equal(env.collector.of(bConn, 'task.lease-lost').length, 1);
  assert.equal(env.collector.of(pcConn, 'task.claimed').filter(m => m.id === taskId).length, 1);
});

test('MP-14 claimedStreams 与 task.taken：只给看得见的连接、只带最小字段、不带认领令牌；纯浏览器什么都不带', () => {
  const env = setupQueueEnv();
  const mine = 'stream:rk-mine:0-59';
  const other = 'stream:rk-elsewhere:0-59';
  publishStreamTask(env, 'pub-1', mine, { requires: { capabilities: { streams: true } } });
  // 另一个项目的流任务
  env.mod.handle(env.ctx, 'pub-1', { type: 'task.publish', tasks: [{
    id: other, kind: 'stream', resultKey: 'rk-elsewhere', range: { unit: 'segment', from: 0, to: 59 },
    source: { projectId: 'proj-elsewhere', projectRev: 1 }, input: { clipId: 'clip-x', contentKey: 'ck-x' },
    weight: { class: 'medium', estMs: null, frames: 900 }, requires: {}, priority: 10,
  }] });

  // 托管节点只 watch 本项目,先报到(之后浏览器认领时它收 task.taken)
  const hostConn = 'conn-host-watch';
  env.mod.connect(env.ctx, hostConn, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, hostConn, { type: 'node.hello', nodeId: 'node-host-watch', profile: 'host', envFingerprint: FP_HOST, capabilities: { streams: true } });
  env.mod.handle(env.ctx, hostConn, { type: 'queue.watch', projects: [PROJECT] });
  // 另一台纯浏览器也 watch 本项目(它收 task.taken,但不抢别人)
  const watcher = 'conn-browser-watch';
  env.mod.connect(env.ctx, watcher, { role: 'render', userId: 'u1' });
  env.mod.handle(env.ctx, watcher, { type: 'node.hello', nodeId: 'node-browser-watch', profile: 'browser' });
  env.mod.handle(env.ctx, watcher, { type: 'queue.watch', projects: [PROJECT] });
  const bConn = browserClaims(env, mine);
  browserClaims(env, other, 'conn-browser-2');

  // task.taken:看得见的那一条带最小任务视图,没有令牌
  const taken = env.collector.of(hostConn, 'task.taken');
  assert.deepEqual(taken.map(m => m.id), [mine], '另一个项目的 task.taken 不发给只 watch 本项目的托管节点');
  assert.equal(taken[0].holderProfile, 'browser');
  assert.equal(taken[0].holderRank, 1);
  assert.deepEqual(Object.keys(taken[0].task).sort(), ['id', 'input', 'kind', 'requires', 'source', 'version', 'weight']);
  assert.equal(taken[0].task.kind, 'stream');
  assert.deepEqual(taken[0].task.source, { projectId: PROJECT });
  assert.ok(!JSON.stringify(taken[0]).includes('"claim"') && !JSON.stringify(taken[0]).includes('"token"'), 'task.taken 不带原持有方的认领令牌');

  // queue.snapshot 的 claimedStreams:同样只列看得见的、最小字段
  env.mod.handle(env.ctx, hostConn, { type: 'queue.watch', projects: [PROJECT] });
  const snap = env.collector.of(hostConn, 'queue.snapshot').at(-1);
  assert.deepEqual(snap.claimedStreams.map(s => s.id), [mine], '只列这条连接看得见的(本项目的)在途流任务');
  const [s] = snap.claimedStreams;
  assert.deepEqual(Object.keys(s).sort(), ['density', 'holderProfile', 'holderRank', 'id', 'task', 'version']);
  assert.deepEqual(s.task, {
    id: mine, kind: 'stream', version: s.version, source: { projectId: PROJECT }, weight: { class: 'medium' },
    requires: { capabilities: { streams: true } }, input: {},
  });
  assert.ok(!JSON.stringify(snap.claimedStreams).includes('"token"') && !JSON.stringify(snap.claimedStreams).includes('"claim"'));
  assert.ok(!JSON.stringify(snap.claimedStreams).includes('ck-1'), '不带内容键等输入细节');

  // 纯浏览器:不抢别人,claimedStreams 为空,task.taken 不带任务视图与持有方
  env.mod.handle(env.ctx, bConn, { type: 'queue.watch', projects: [PROJECT] });
  assert.deepEqual(env.collector.of(bConn, 'queue.snapshot').at(-1).claimedStreams, []);
  const browserTaken = env.collector.of(watcher, 'task.taken');
  assert.deepEqual(browserTaken.map(m => m.id), [mine]);
  for (const m of browserTaken) assert.ok(m.task === undefined && m.holderProfile === null && m.holderRank === null, '纯浏览器收的 task.taken 不带任务视图与持有方');
});

test('MP-15 托管节点在项目关了「生成轨道流」时不抢该项目浏览器的流任务：真实 queue.snapshot 的 claimedStreams 带 kind 与项目,canClaim 挡得住', () => {
  const env = setupQueueEnv();
  const taskId = 'stream:rk-host-gate:0-59';
  publishStreamTask(env, 'pub-1', taskId, { requires: { capabilities: { streams: true } } });
  const bConn = browserClaims(env, taskId);

  // 托管节点的会话接在文档服务模块上;canClaim 同 host.mjs 的 streamsPass:项目关了生成轨道流时流任务一律不认领
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
  assert.equal(sent.filter(m => m.type === 'task.claim').length, 0, '项目关了生成轨道流:不发抢占');
  const judged = seenTasks.find(x => x.id === taskId);
  assert.ok(judged, 'canClaim 拿到了在途流任务');
  assert.equal(judged.kind, 'stream', 'canClaim 看得出是流任务');
  assert.equal(judged.source.projectId, PROJECT, 'canClaim 看得出属于哪个项目');
  assert.equal(env.q.describe().tasks.find(x => x.id === taskId).claim.nodeId, `node-${bConn}`, '浏览器仍持有');

  // 打开生成轨道流:同一张快照里的任务照常抢得到
  streamsOn = true;
  session.tick();
  assert.equal(sent.filter(m => m.type === 'task.claim').length, 1);
  assert.equal(env.q.describe().tasks.find(x => x.id === taskId).claim.nodeId, 'node-host-gate', '托管节点接手');
});

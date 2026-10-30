/**
 * 丢认领、失败、丢弃的诊断(`docs/archive/agent-reports/AGENT-stall-phases.md`;契约 `docs/plan/render-queue-contract.md` A.12〔裁〕)。
 * 跑:npm test,或 node --test server/test/stall-phases-diag.test.mjs
 *
 *   D1  队列回收时给原认领者的 `task.lease-lost` 带真实原因(`lease-expired` / `stalled`),
 *       放回 open 时广播的任务视图带 `lastError`;没失败过的任务视图不带这一项
 *   D2  task-runner 的 `lost` 事件带阶段与毫秒数:推送途中丢认领 → `phase: 'push'`、`push` 的块数、距上次帧数变化、距认领
 *   D3  task-runner 的 `failed`(sink-incomplete)带产物库说的原因 `why` 与推送统计
 *   D4  `createAssetSink().put`:推送出错回 `{ complete: false, reason: 'push-failed:…', stats }`、记一行 `sink.incomplete`,
 *       每推完一块经 `report` 报一次;收全时回 `stats`
 *   D5  编辑器进程的转发器放行逐任务收尾行与 `sink.incomplete`,别的 `[queue-node]` 行照旧不转;会话行照旧转
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createRenderQueue } from '../render-queue/index.mjs';
import { createTaskRunner } from '../render-node/task-runner.mjs';
import { createSessionLineForwarder } from '../render-node/session-diag.mjs';
import { createAssetSink } from '../artifact-transfer.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const T0 = 1_000_000;

function fineTask(label, { from = 0, to = 59 } = {}) {
  const resultKey = sha256(`rk:${label}`);
  return {
    id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier: 'shared', resultKey,
    range: { unit: 'localFrame', from, to }, source: { projectId: 'p1', projectRev: 1 },
    input: { clipId: `clip-${label}`, contentKey: sha256(`ck:${label}`) }, weight: { class: 'medium' }, requires: {}, priority: 'normal',
  };
}

/** 一个队列、一个节点连接、一个发布方连接,消息同步投递,假时钟 */
function queueRig(constants = {}) {
  let t = T0;
  const sent = [];
  const q = createRenderQueue({ now: () => t, send: (connId, msg) => sent.push({ connId, msg }), epoch: 'e1', constants });
  q.connect('node', { userId: 'u', tenantId: 't' });
  q.connect('pub', { userId: 'u', tenantId: 't' });
  q.connect('watch', { userId: 'u', tenantId: 't' });
  q.handle('node', { type: 'node.hello', nodeId: 'N', profile: 'pc' });
  q.handle('watch', { type: 'node.hello', nodeId: 'W', profile: 'pc' });
  q.handle('watch', { type: 'queue.watch', projects: 'all' });
  q.handle('pub', { type: 'publisher.hello', publisherId: 'P' });
  return {
    q, sent, at: (v) => { t = v; q.tick(); },
    of: (connId, type) => sent.filter((e) => e.connId === connId && e.msg.type === type).map((e) => e.msg),
  };
}

test('D1 回收的 lease-lost 带真实原因(stalled / lease-expired);放回 open 的任务视图带 lastError', () => {
  const r = queueRig();
  const task = fineTask('a');
  r.q.handle('pub', { type: 'task.publish', tasks: [task] });
  const opened0 = r.of('watch', 'task.opened').at(-1);
  assert.equal('lastError' in opened0.task, false, '没失败过的任务视图不带 lastError');
  r.q.handle('node', { type: 'task.claim', id: task.id, expectVersion: 1 });
  r.q.handle('node', { type: 'task.progress', id: task.id, token: 2, done: 0 });
  // 续约照发、帧数不变:严格超过 STALL_MS 按停滞回收
  for (let s = 10; s <= 120; s += 10) { r.at(T0 + s * 1000); r.q.handle('node', { type: 'task.progress', id: task.id, token: 2, done: 0 }); }
  r.at(T0 + 120_001);
  const lost = r.of('node', 'task.lease-lost');
  assert.deepEqual(lost.map((m) => m.reason), ['stalled']);
  const reopened = r.of('watch', 'task.opened').at(-1);
  assert.equal(reopened.task.lastError, 'stalled', '放回 open 的广播带 lastError');

  // 再认领,不再续约:按租约回收
  r.q.handle('node', { type: 'task.claim', id: task.id, expectVersion: reopened.task.version });
  const claimed = r.of('node', 'task.claimed').at(-1);
  r.at(T0 + 120_001 + 30_001);
  assert.equal(r.of('node', 'task.lease-lost').at(-1).reason, 'lease-expired');
  assert.equal(claimed.task.lastError, 'stalled', '认领回包里的视图也带着上一次的原因');
  assert.equal(r.of('watch', 'task.opened').at(-1).task.lastError, 'lease-expired');
});

/** 可控时钟、假会话、可手动推进的执行器与产物库 */
function runnerRig({ putBlocks = 3 } = {}) {
  let t = T0;
  const events = [];
  const holds = new Map();
  const session = {
    held: () => [...holds.values()],
    progress: (id) => holds.has(id),
    complete: (id) => holds.delete(id),
    fail: (id) => holds.delete(id),
  };
  const gates = {};
  const executor = {
    render: (task, { progress }) => new Promise((resolve) => { gates.render = { resolve, progress }; }),
  };
  const sink = {
    has: async () => false,
    put: (entry, hooks) => new Promise((resolve) => {
      hooks?.report?.({ stage: 'push' });
      hooks?.report?.({ blocks: putBlocks, pushed: 0, bytes: 0 });
      gates.put = { resolve, report: hooks?.report };
    }),
  };
  const runner = createTaskRunner({ nodeId: 'N', session: () => session, executor, sink, emit: (e) => events.push(e), now: () => t });
  return {
    runner, events, gates,
    claim(task, token = 2) { holds.set(task.id, { id: task.id, token }); runner.onTask(task, { token }); },
    advance(ms) { t += ms; },
    drop(id) { holds.delete(id); },
  };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('D2 推送途中丢认领:lost 事件带 phase=push、推送块数、距上次帧数变化与距认领的毫秒数', async () => {
  const r = runnerRig({ putBlocks: 120 });
  const task = fineTask('b');
  r.claim(task);
  await turn();
  r.advance(5_000);
  r.gates.render.progress(30);
  r.advance(5_000);
  r.gates.render.progress(60);
  r.gates.render.resolve(null);
  await turn(); await turn();
  assert.ok(r.gates.put, '渲完进入推送');
  r.advance(1_000);
  r.gates.put.report({ blocks: 120, pushed: 40, bytes: 4_000 });
  r.advance(129_000);
  r.drop(task.id);
  r.runner.onLost(task.id, 'stalled');
  const lost = r.events.find((e) => e.type === 'lost');
  assert.equal(lost.reason, 'stalled');
  assert.equal(lost.phase, 'push');
  assert.equal(lost.done, 60);
  assert.equal(lost.sinceDoneMs, 130_000, '距上次帧数变化');
  assert.equal(lost.sinceClaimMs, 140_000, '距认领');
  assert.equal(lost.phaseMs, 130_000, '在推送阶段多久');
  assert.deepEqual(lost.push, { blocks: 120, pushed: 40, bytes: 4_000, ms: 130_000 });
  await r.runner.settled();
  const discarded = r.events.find((e) => e.type === 'discarded');
  assert.equal(discarded.phase, 'push');
  assert.equal(discarded.reason, 'stalled');
});

test('D3 sink-incomplete 的 failed 事件带产物库给的原因与推送统计', async () => {
  const r = runnerRig({ putBlocks: 10 });
  const task = fineTask('c');
  r.claim(task);
  await turn();
  r.gates.render.progress(60);
  r.gates.render.resolve(null);
  await turn(); await turn();
  r.advance(2_000);
  r.gates.put.report({ blocks: 10, pushed: 7, bytes: 700 });
  r.gates.put.resolve({ complete: false, reason: 'push-failed:timeout' });
  await r.runner.settled();
  const failed = r.events.find((e) => e.type === 'failed');
  assert.equal(failed.error, 'sink-incomplete');
  assert.equal(failed.why, 'push-failed:timeout');
  assert.equal(failed.phase, 'push');
  assert.deepEqual(failed.push, { blocks: 10, pushed: 7, bytes: 700, ms: 2_000 });
});

/** 帧库里有 0..3 帧的最小管线(共享档) */
function tinyPipeline(frames = 4) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-stall-diag-'));
  const dir = path.join(root, 'snap');
  fs.mkdirSync(dir, { recursive: true });
  for (let f = 0; f < frames; f++) fs.writeFileSync(path.join(dir, `${f}.html`), `<div>${f}</div>`);
  return {
    root,
    pipeline: {
      snapshots: () => ({ snapshotIndex: async () => ({ frames: [[0, frames - 1]], oversize: [] }), dir: () => dir }),
      whenSmallSettled: async () => {},
    },
  };
}

test('D4 产物库 put:推送出错回 reason 与 stats 并记 sink.incomplete;每推完一块报一次;收全时带 stats', async () => {
  const { root, pipeline } = tinyPipeline(4);
  try {
    const ref = { kind: 'snapshot', tier: 'shared', resultKey: sha256('rk:d4'), range: { unit: 'localFrame', from: 0, to: 3 } };
    const logs = [];
    let n = 0;
    const flaky = {
      put: async (ns, bytes) => {
        n += 1;
        if (n === 3) throw Object.assign(new Error('素材服务 PUT snap/x/0 超时（30000 ms 没有完成）'), { code: 'timeout' });
        return { hash: sha256(bytes), uploaded: true };
      },
    };
    const reports = [];
    const bad = await createAssetSink({ pipeline, client: flaky, log: (event, fields) => logs.push({ event, fields }) })
      .put({ ...ref, artifacts: null, meta: { taskId: 't', nodeId: 'N', token: 1 } }, { report: (r) => reports.push(r) });
    assert.equal(bad.complete, false);
    assert.equal(bad.reason, 'push-failed:timeout');
    assert.equal(bad.stats.blocks, 4);
    assert.ok(bad.stats.pushed >= 2 && bad.stats.pushed <= 3, `推了 ${bad.stats.pushed} 块`);
    const line = logs.find((l) => l.event === 'sink.incomplete');
    assert.ok(line, '记一行 sink.incomplete');
    assert.equal(line.fields.reason, 'push-failed:timeout');
    assert.ok(reports.some((r) => r.stage === 'collect') && reports.some((r) => r.stage === 'push'), '报了列清单与推块两个阶段');
    assert.ok(reports.some((r) => r.blocks === 4 && r.pushed === 0), '开推时报总块数');

    const ok = { put: async (ns, bytes) => ({ hash: sha256(bytes), uploaded: true }) };
    const counted = [];
    const good = await createAssetSink({ pipeline, client: ok })
      .put({ ...ref, artifacts: null, meta: { taskId: 't', nodeId: 'N', token: 1 } }, { report: (r) => { if (Number.isFinite(r.pushed)) counted.push(r.pushed); } });
    assert.equal(good.complete, true);
    assert.equal(good.stats.blocks, 4);
    assert.equal(good.stats.pushed, 4);
    assert.deepEqual(counted, [0, 1, 2, 3, 4], '开推一次 + 每块一次');

    // 缺帧:reason 是 range-missing
    const short = await createAssetSink({ pipeline, client: ok }).put({ ...ref, range: { unit: 'localFrame', from: 0, to: 9 }, artifacts: null, meta: { taskId: 't', nodeId: 'N', token: 1 } });
    assert.equal(short.complete, false);
    assert.equal(short.reason, 'range-missing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('D5 转发器放行逐任务收尾行、sink.incomplete 与去重诊断(sink.has-miss、manifest.*-failed),别的 queue-node 行不转,会话行照旧转', () => {
  const out = [];
  const forward = createSessionLineForwarder((line) => out.push(line));
  forward([
    '[queue-node] node.task-lost {"id":"snapshot:ab:0-59","reason":"stalled","phase":"push","sinceDoneMs":121000}',
    '[queue-node] node.task-discarded {"id":"snapshot:ab:0-59","phase":"push"}',
    '[queue-node] node.task-failed {"id":"snapshot:cd:0-59","error":"sink-incomplete","why":"push-failed:timeout"}',
    '[queue-node] node.task-completed {"id":"snapshot:ef:0-59","push":{"blocks":120,"pushed":120,"ms":40000}}',
    '[queue-node] sink.incomplete {"resultKey":"ab","reason":"push-failed:timeout"}',
    '[queue-node] sink.has-miss {"resultKey":"ab","reason":"manifest-missing","covered":false}',
    '[queue-node] manifest.get-failed {"kind":"snapshot-manifest","code":"timeout"}',
    '[queue-node] queue.started {"nodeId":"x"}',
    '[queue-node] executor.plan {"version":"p@1"}',
    '[queue-node] docservice.session.resume {"gapMs":600}',
    '',
  ].join('\n'));
  assert.deepEqual(out.map((l) => l.split(' ')[1]), [
    'node.task-lost', 'node.task-discarded', 'node.task-failed', 'node.task-completed', 'sink.incomplete', 'sink.has-miss', 'manifest.get-failed',
    'docservice.session.resume',
  ]);
  // 一轮几十个任务:逐任务行不被会话行的额度(每种每分钟 10 行)压掉
  const many = [];
  const f2 = createSessionLineForwarder((line) => many.push(line));
  f2(`${Array.from({ length: 40 }, (_, i) => `[queue-node] node.task-completed {"id":"t${i}"}`).join('\n')}\n`);
  assert.equal(many.length, 40);
});

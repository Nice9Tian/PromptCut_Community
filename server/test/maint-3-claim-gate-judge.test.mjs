/**
 * 认领闸端到端探针(`scripts/probes/claim-gate-probe.mjs`,AGENT-maint-3 第 4 项)的判定函数。
 *
 *   MNT3-C-1  judgeAgentOrder:Agent 任务开工前专用实例没接新的普通预渲染 → 过;接了 → 不过并列出来;没有这次的 Agent 任务 → 不过;
 *   MNT3-C-2  summarizeSamples:最大持有数、多出的格子、专用实例开没开、专用实例在做队列任务的样本数;
 *   MNT3-C-3  judgeRun:专用实例开着 / 没开两种各自的通过与不通过条件;
 *   MNT3-C-4  judgeAgentWait:Agent 任务的等待不超过「一批加一次切换」的上界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeAgentOrder, judgeAgentWait, summarizeSamples, judgeRun } from '../../scripts/probes/claim-gate-judge.mjs';

test('MNT3-C-1 judgeAgentOrder:发请求那一刻已在做的那一项不算,之后专用实例再接普通预渲染才算插到 Agent 前面', () => {
  const t0 = 10_000;
  const ok = judgeAgentOrder([
    { kind: 'queue', worker: 'agent', at: t0 - 3000, waitMs: 5 },    // 发请求时专用实例手里那一项
    { kind: 'queue', worker: 'queue', at: t0 + 100, waitMs: 50 },    // queue lane 自己接下一项:不相干
    { kind: 'agent', worker: 'agent', at: t0 + 2400, waitMs: 2400 }, // 等手里那一项做完就轮到它
    { kind: 'queue', worker: 'agent', at: t0 + 5000, waitMs: 9 },    // Agent 做完以后再接:没问题
  ], t0);
  assert.deepEqual({ ok: ok.ok, agentAt: ok.agentAt, agentWaitMs: ok.agentWaitMs, jumped: ok.jumped }, { ok: true, agentAt: t0 + 2400, agentWaitMs: 2400, jumped: [] });

  const bad = judgeAgentOrder([
    { kind: 'queue', worker: 'agent', at: t0 - 3000 },
    { kind: 'queue', worker: 'agent', at: t0 + 1000 },
    { kind: 'card-batch', worker: 'agent', at: t0 + 1500 },
    { kind: 'agent', worker: 'agent', at: t0 + 4000 },
  ], t0);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.jumped.map(r => `${r.kind}@${r.at - t0}`), ['queue@1000', 'card-batch@1500']);

  const none = judgeAgentOrder([{ kind: 'agent', worker: 'agent', at: t0 - 1 }], t0);
  assert.equal(none.ok, false);
  assert.match(none.reason, /没有这次请求的 Agent 任务/);
  // 记录乱序也照时间排
  assert.equal(judgeAgentOrder([{ kind: 'agent', worker: 'agent', at: t0 + 50 }, { kind: 'queue', worker: 'agent', at: t0 + 10 }], t0).ok, false);
});

test('MNT3-C-2 summarizeSamples', () => {
  const s = summarizeSamples([
    { at: 1, held: 1, spare: false, agentOpen: true, agentUnit: null, queueAtAgent: 0 },
    { at: 2, held: 2, spare: true, agentOpen: true, agentUnit: null, queueAtAgent: 0 },
    { at: 3, held: 2, spare: false, agentOpen: true, agentUnit: 'queue', queueAtAgent: 1 },
    { at: 4, held: 0, spare: null, agentOpen: true, agentUnit: 'card-batch', queueAtAgent: 3 },
  ]);
  assert.deepEqual(s, { count: 4, maxHeld: 2, heldTwo: 2, spareSeen: true, agentOpenSeen: true, agentOnQueue: 1, maxQueueAtAgent: 3 });
  assert.deepEqual(summarizeSamples(null), { count: 0, maxHeld: 0, heldTwo: 0, spareSeen: false, agentOpenSeen: false, agentOnQueue: 0, maxQueueAtAgent: 0 });
});

test('MNT3-C-3 judgeRun:开着要见到多认领并交给专用实例;没开不许多认领、不许开专用实例', () => {
  const on = { maxHeld: 2, spareSeen: true, agentOpenSeen: true };
  assert.deepEqual(judgeRun({ withAgent: true, summary: on, counts: { 'queue@agent': 2 } }), []);
  const onBad = judgeRun({ withAgent: true, summary: { maxHeld: 1, spareSeen: false, agentOpenSeen: true }, counts: {} });
  assert.equal(onBad.length, 3);
  const off = { maxHeld: 1, spareSeen: false, agentOpenSeen: false };
  assert.deepEqual(judgeRun({ withAgent: false, summary: off, counts: { 'queue@queue': 9 } }), []);
  const offBad = judgeRun({ withAgent: false, summary: { maxHeld: 2, spareSeen: true, agentOpenSeen: true }, counts: { 'queue@agent': 1 } });
  assert.equal(offBad.length, 4);
});

test('MNT3-C-4 judgeAgentWait:等一批加一次切换以内过;像改前那样等整项(38 s)不过;没量到不过', () => {
  assert.deepEqual(judgeAgentWait({ agentWaitMs: 4200 }, 15000), []);
  assert.equal(judgeAgentWait({ agentWaitMs: 38347 }, 15000).length, 1);
  assert.equal(judgeAgentWait({ agentWaitMs: null }, 15000).length, 1);
  assert.equal(judgeAgentWait(null, 15000).length, 1);
});

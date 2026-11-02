/**
 * `claim-gate-probe.mjs` 的判定(纯函数,`server/test/maint-3-claim-gate-judge.test.mjs` 直接测)。
 *
 * 输入是探针一路采到的样本与预渲染进程诊断里的调度记录(`FramePipeline.noteSched`:`{ kind, worker, at, waitMs? }`,
 * `worker` 是在哪个实例上开工,`'agent'` = Agent 专用实例,`'queue'` = `'queue'` lane 的预渲染间)。
 */

/**
 * 一路采到的队列诊断样本 → 摘要。
 * @param {Array<{ at: number, held: number, spare: boolean|null, agentOpen: boolean|null, agentUnit: string|null, queueAtAgent: number }>} samples
 */
export function summarizeSamples(samples) {
  const list = Array.isArray(samples) ? samples : [];
  return {
    count: list.length,
    maxHeld: list.reduce((m, s) => Math.max(m, Number(s.held) || 0), 0),
    /** 持有两项的样本数 */
    heldTwo: list.filter(s => Number(s.held) >= 2).length,
    spareSeen: list.some(s => s.spare === true),
    agentOpenSeen: list.some(s => s.agentOpen === true),
    /** 专用实例手里是一项普通预渲染队列的项(`agentUnit === 'queue'`)的样本数 */
    agentOnQueue: list.filter(s => s.agentUnit === 'queue').length,
    maxQueueAtAgent: list.reduce((m, s) => Math.max(m, Number(s.queueAtAgent) || 0), 0),
  };
}

/**
 * 「Agent 任务来了不排在排队中的预渲染后面」:`sentAt` 时刻发出 Agent 请求,调度记录里
 *   - 必须有一条 `agent@agent` 开工于 `sentAt` 之后(这次请求的第一个 Agent 任务);
 *   - 从 `sentAt` 到那一条之间,专用实例上**不许**再开工新的普通预渲染(`queue@agent` / `card-batch@agent` / `preview@agent`
 *     / `prerender@agent`):开工的只能是发请求那一刻已经在做的那一项(它开工于 `sentAt` 之前,不在这个区间里)。
 * @param {Array<{ kind: string, worker: string, at: number, waitMs?: number }>} recent
 * @param {number} sentAt
 * @returns {{ ok: boolean, agentAt: number|null, agentWaitMs: number|null, jumped: Array<object>, reason?: string }}
 */
export function judgeAgentOrder(recent, sentAt) {
  const rows = (Array.isArray(recent) ? recent : []).filter(r => Number.isFinite(r?.at)).slice().sort((a, b) => a.at - b.at);
  const first = rows.find(r => r.kind === 'agent' && r.worker === 'agent' && r.at >= sentAt);
  if (!first) return { ok: false, agentAt: null, agentWaitMs: null, jumped: [], reason: 'No Agent task for this request in the scheduler log' };
  const jumped = rows.filter(r => r.worker === 'agent' && r.kind !== 'agent' && r.at >= sentAt && r.at < first.at);
  return { ok: jumped.length === 0, agentAt: first.at, agentWaitMs: Number.isFinite(first.waitMs) ? first.waitMs : null, jumped,
    ...(jumped.length ? { reason: 'After the Agent task arrived and before it started, the dedicated instance picked up another ordinary prerender' } : {}) };
}

/**
 * Agent 查询的等待(AGENT-maint-3 第 5 项):专用实例上的队列任务按批(4 帧)让路,Agent 任务至多等手里那一批加一次切换
 * (让路后恢复队列任务的那次页面重置在 Agent 做完之后,不算在等待里)。`limitMs` 是这个量级的上界(探针缺省 15 s;
 * 改前整项 60 帧要等约 38 s)。回不满足的条目(空 = 过)。
 */
export function judgeAgentWait(order, limitMs) {
  if (!order || order.agentWaitMs == null) return ['The Agent task wait time was not measured'];
  return order.agentWaitMs <= limitMs ? [] : [`The Agent task waited ${order.agentWaitMs} ms, more than the order of one batch plus one switch (upper bound ${limitMs} ms)`];
}

/**
 * 一趟的判定。`withAgent`:这一趟先让 Agent 用过专用实例(它开着)。
 *   - 开着:见过持有两项(`maxHeld >= 2`)、见过多出的那一格开(`spareSeen`)、专用实例上做过队列任务(`queue@agent >= 1`);
 *   - 没开:持有数从没超过 1、多出的那一格从没开、专用实例从没开过、专用实例上一项队列任务都没做。
 * @returns {string[]} 不满足的条目(空 = 全过)
 */
export function judgeRun({ withAgent, summary, counts }) {
  const fails = [];
  const queueAtAgent = Number(counts?.['queue@agent']) || 0;
  if (withAgent) {
    if (!(summary.maxHeld >= 2)) fails.push(`Dedicated instance on: the local node should hold one extra item beyond maxConcurrent (max held seen: ${summary.maxHeld})`);
    if (!summary.spareSeen) fails.push('Dedicated instance on: the extra slot in the diagnostics (queue.spare.spare) should have opened');
    if (!(queueAtAgent >= 1)) fails.push(`Dedicated instance on: snapshot tasks should have run on the dedicated instance (queue@agent = ${queueAtAgent})`);
  } else {
    if (summary.maxHeld > 1) fails.push(`Dedicated instance off: the local node should not claim extra (max held seen: ${summary.maxHeld})`);
    if (summary.spareSeen) fails.push('Dedicated instance off: the extra slot should not open');
    if (summary.agentOpenSeen) fails.push('Dedicated instance off: no dedicated instance should be opened for prerender during the whole run');
    if (queueAtAgent !== 0) fails.push(`Dedicated instance off: no queue tasks should run on the dedicated instance (queue@agent = ${queueAtAgent})`);
  }
  return fails;
}

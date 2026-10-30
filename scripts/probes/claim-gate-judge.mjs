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
  if (!first) return { ok: false, agentAt: null, agentWaitMs: null, jumped: [], reason: '调度记录里没有这次请求的 Agent 任务' };
  const jumped = rows.filter(r => r.worker === 'agent' && r.kind !== 'agent' && r.at >= sentAt && r.at < first.at);
  return { ok: jumped.length === 0, agentAt: first.at, agentWaitMs: Number.isFinite(first.waitMs) ? first.waitMs : null, jumped,
    ...(jumped.length ? { reason: 'Agent 任务到达之后、开工之前,专用实例又接了普通预渲染' } : {}) };
}

/**
 * Agent 查询的等待(AGENT-maint-3 第 5 项):专用实例上的队列任务按批(4 帧)让路,Agent 任务至多等手里那一批加一次切换
 * (让路后恢复队列任务的那次页面重置在 Agent 做完之后,不算在等待里)。`limitMs` 是这个量级的上界(探针缺省 15 s;
 * 改前整项 60 帧要等约 38 s)。回不满足的条目(空 = 过)。
 */
export function judgeAgentWait(order, limitMs) {
  if (!order || order.agentWaitMs == null) return ['没有量到 Agent 任务的等待时间'];
  return order.agentWaitMs <= limitMs ? [] : [`Agent 任务等了 ${order.agentWaitMs} ms,超过一批加一次切换的量级(上界 ${limitMs} ms)`];
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
    if (!(summary.maxHeld >= 2)) fails.push(`专用实例开着:本机节点应在 maxConcurrent 之外多持有一项(见过的最大持有数 ${summary.maxHeld})`);
    if (!summary.spareSeen) fails.push('专用实例开着:诊断里多出的那一格(queue.spare.spare)应开过');
    if (!(queueAtAgent >= 1)) fails.push(`专用实例开着:应在专用实例上做过快照任务(queue@agent = ${queueAtAgent})`);
  } else {
    if (summary.maxHeld > 1) fails.push(`专用实例没开:本机节点不应多认领(见过的最大持有数 ${summary.maxHeld})`);
    if (summary.spareSeen) fails.push('专用实例没开:多出的那一格不应开');
    if (summary.agentOpenSeen) fails.push('专用实例没开:整趟不应为预渲染开专用实例');
    if (queueAtAgent !== 0) fails.push(`专用实例没开:专用实例上不应做队列任务(queue@agent = ${queueAtAgent})`);
  }
  return fails;
}

/**
 * Judgment for `claim-gate-probe.mjs` (pure function, directly tested by
 * `server/test/maint-3-claim-gate-judge.test.mjs`).
 *
 * Input consists of samples collected along the way by the probe and scheduling records in prerender
 * process diagnostics (`FramePipeline.noteSched`: `{ kind, worker, at, waitMs? }`, where `worker`
 * indicates on which instance work starts, `'agent'` = Agent dedicated instance, `'queue'` = prerender
 * room in `'queue'` lane).
 */

/**
 * Queue diagnostic samples collected along the way → summary.
 * @param {Array<{ at: number, held: number, spare: boolean|null, agentOpen: boolean|null, agentUnit: string|null, queueAtAgent: number }>} samples
 */
export function summarizeSamples(samples) {
  const list = Array.isArray(samples) ? samples : [];
  return {
    count: list.length,
    maxHeld: list.reduce((m, s) => Math.max(m, Number(s.held) || 0), 0),
    /** Number of samples holding two items */
    heldTwo: list.filter(s => Number(s.held) >= 2).length,
    spareSeen: list.some(s => s.spare === true),
    agentOpenSeen: list.some(s => s.agentOpen === true),
    /** Number of samples where dedicated instance holds a normal prerender queue item (`agentUnit === 'queue'`) */
    agentOnQueue: list.filter(s => s.agentUnit === 'queue').length,
    maxQueueAtAgent: list.reduce((m, s) => Math.max(m, Number(s.queueAtAgent) || 0), 0),
  };
}

/**
 * "Agent tasks do not queue behind queued prerenders when they arrive": send Agent request at
 * `sentAt`; in scheduling records:
 *   - must have an `agent@agent` entry starting after `sentAt` (first Agent task of this request);
 *   - between `sentAt` and that entry, dedicated instance **must not** start any new normal
 *     prerender (`queue@agent` / `card-batch@agent` / `preview@agent` / `prerender@agent`):
 *     the only started work can be the item already in progress when the request was sent (which
 *     started before `sentAt` and is not in this interval).
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
 * Agent query wait time (item 5 of AGENT-maint-3): queue tasks on dedicated instance yield in
 * batches (4 frames); Agent tasks wait at most for the batch in hand plus one switch (the page
 * reset that resumes queue tasks after yielding occurs after the Agent finishes, not counted
 * in wait time). `limitMs` is upper bound of this order of magnitude (probe defaults to 15 s;
 * before change, whole 60-frame item waited ~38 s). Returns unmet items (empty = pass).
 */
export function judgeAgentWait(order, limitMs) {
  if (!order || order.agentWaitMs == null) return ['The Agent task wait time was not measured'];
  return order.agentWaitMs <= limitMs ? [] : [`The Agent task waited ${order.agentWaitMs} ms, more than the order of one batch plus one switch (upper bound ${limitMs} ms)`];
}

/**
 * Judgment for one pass. `withAgent`: this pass first lets Agent use dedicated instance (it is open).
 *   - Open: saw holding two items (`maxHeld >= 2`), saw extra slot open (`spareSeen`), ran queue
 *     tasks on dedicated instance (`queue@agent >= 1`);
 *   - Not open: held count never exceeded 1, extra slot was never open, dedicated instance was never
 *     open, not a single queue task was run on dedicated instance.
 * @returns {string[]} Unmet items (empty = all passed)
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

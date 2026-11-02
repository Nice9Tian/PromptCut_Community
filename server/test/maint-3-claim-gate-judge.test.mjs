/**
 * Decision function for claim gate end-to-end probe (`scripts/probes/claim-gate-probe.mjs`, item 4
 * of AGENT-maint-3).
 *
 *   MNT3-C-1  judgeAgentOrder: dedicated instance took no new regular prerenders before Agent task
 *             starts → passes; took one → fails and lists them; missing this Agent task → fails;
 *   MNT3-C-2  summarizeSamples: max held count, extra slots, whether dedicated instance is enabled,
 *             sample count of dedicated instance running queue tasks;
 *   MNT3-C-3  judgeRun: pass and fail conditions for dedicated instance enabled / disabled;
 *   MNT3-C-4  judgeAgentWait: Agent task wait does not exceed upper bound of "one batch plus one
 *             switch".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeAgentOrder, judgeAgentWait, summarizeSamples, judgeRun } from '../../scripts/probes/claim-gate-judge.mjs';

test('MNT3-C-1 judgeAgentOrder: the item already being worked on at the moment the request is sent does not count; only if the dedicated instance then takes an ordinary prerender afterwards does it count as jumping ahead of the Agent', () => {
  const t0 = 10_000;
  const ok = judgeAgentOrder([
    { kind: 'queue', worker: 'agent', at: t0 - 3000, waitMs: 5 },    // The item held by dedicated instance when request was sent
    { kind: 'queue', worker: 'queue', at: t0 + 100, waitMs: 50 },    // queue lane picks up next item itself: irrelevant
    { kind: 'agent', worker: 'agent', at: t0 + 2400, waitMs: 2400 }, // Its turn arrives once the held item finishes
    { kind: 'queue', worker: 'agent', at: t0 + 5000, waitMs: 9 },    // Picking up after Agent finishes: no problem
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
  assert.match(none.reason, /No Agent task for this request/);
  // Sort by time even if records are out of order
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

test('MNT3-C-3 judgeRun: when enabled, extra claims must be seen and handed to the dedicated instance; when disabled, no extra claims and no dedicated instance are allowed', () => {
  const on = { maxHeld: 2, spareSeen: true, agentOpenSeen: true };
  assert.deepEqual(judgeRun({ withAgent: true, summary: on, counts: { 'queue@agent': 2 } }), []);
  const onBad = judgeRun({ withAgent: true, summary: { maxHeld: 1, spareSeen: false, agentOpenSeen: true }, counts: {} });
  assert.equal(onBad.length, 3);
  const off = { maxHeld: 1, spareSeen: false, agentOpenSeen: false };
  assert.deepEqual(judgeRun({ withAgent: false, summary: off, counts: { 'queue@queue': 9 } }), []);
  const offBad = judgeRun({ withAgent: false, summary: { maxHeld: 2, spareSeen: true, agentOpenSeen: true }, counts: { 'queue@agent': 1 } });
  assert.equal(offBad.length, 4);
});

test('MNT3-C-4 judgeAgentWait: passes if the wait is within one batch plus one switch; waiting for the whole item (38 s) as before the change fails; fails if not measured', () => {
  assert.deepEqual(judgeAgentWait({ agentWaitMs: 4200 }, 15000), []);
  assert.equal(judgeAgentWait({ agentWaitMs: 38347 }, 15000).length, 1);
  assert.equal(judgeAgentWait({ agentWaitMs: null }, 15000).length, 1);
  assert.equal(judgeAgentWait(null, 15000).length, 1);
});

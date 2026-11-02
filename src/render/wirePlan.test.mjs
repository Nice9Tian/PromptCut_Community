import test from 'node:test';
import assert from 'node:assert/strict';

// Explicit .ts extension: unit tests import this module directly in node
// (same as stageBridge.test.mjs)
import { revivePlan, reviveStagePlan, wirePlan } from './wirePlan.ts';
import { planPipelines } from './pipelinePlan.mjs';

const project = {
  fps: 30,
  tracks: [{ id: 'tr', clips: [
    { id: 'a', cardId: 'x', start: 0, end: 4 },
    { id: 'b', cardId: 'y', start: 2, end: 6 },
  ] }],
};
const costs = [
  { identityKey: 'ka', device: 'd', fps: 30, stepMs: 1, inlineMs: 0, rasterMs: 0, serializeMs: 0, catchUpMs: 10, kind: 'stepped', demoted: false, measuredAt: 0 },
  { identityKey: 'kb', device: 'd', fps: 30, stepMs: 99, inlineMs: 0, rasterMs: 0, serializeMs: 0, catchUpMs: 10, kind: 'stepped', demoted: false, measuredAt: 0 },
];
const opts = { identityKeys: { a: 'ka', b: 'kb' } };

test('an array on the wire, a Set after backfill, nothing lost in the round trip', () => {
  const plan = planPipelines(project, costs, 30, opts);
  const wire = wirePlan(plan);
  assert.ok(Array.isArray(wire.prerenderSet));
  assert.ok(wire.segments.every((s) => Array.isArray(s.heavy) && Array.isArray(s.light)));
  // Wire shape must pass through JSON (L1 sends the same table to Worker / cloud via JSON)
  const back = revivePlan(JSON.parse(JSON.stringify(wire)));
  assert.deepEqual([...back.prerenderSet].sort(), [...plan.prerenderSet].sort());
  assert.equal(back.segments.length, plan.segments.length);
  for (let i = 0; i < back.segments.length; i++) {
    assert.equal(back.segments[i].fromSec, plan.segments[i].fromSec);
    assert.equal(back.segments[i].toSec, plan.segments[i].toSec);
    assert.deepEqual([...back.segments[i].heavy].sort(), [...plan.segments[i].heavy].sort());
    assert.deepEqual([...back.segments[i].light].sort(), [...plan.segments[i].light].sort());
  }
});

test('serializing twice gives identical bytes (both ends must agree on the same table)', () => {
  const a = JSON.stringify(wirePlan(planPipelines(project, costs, 30, opts)));
  const b = JSON.stringify(wirePlan(planPipelines(project, costs, 30, opts)));
  assert.equal(a, b);
});

test('reviveStagePlan: clipId → cost records are looked up by identityKeys, tuning comes along with them', () => {
  const plan = planPipelines(project, costs, 30, opts);
  // Stage strictly requires identityKeys: CardCostRecord has no clipId, yet K3 / K5 query vtOk
  // by clip
  const wire = wirePlan(plan, { identityKeys: opts.identityKeys, frameModes: { a: 'stateful', b: 'stateful' } },
    { COST_SCALE: 2, STEP_PERCENTILE: 0.9, STEP_MIN_SAMPLES: 16 });
  const back = reviveStagePlan(JSON.parse(JSON.stringify(wire)), costs);
  assert.equal(back.byClip.get('a')?.identityKey, 'ka');
  assert.equal(back.byClip.get('b')?.identityKey, 'kb');
  assert.equal(back.frameModes.get('a'), 'stateful');
  assert.equal(back.tuning.COST_SCALE, 2);
});

test('reviveStagePlan: no identityKeys does not blow up (old parent page / bad data), records just can\'t be found', () => {
  const back = reviveStagePlan(wirePlan(planPipelines(project, costs, 30, opts)), costs);
  assert.equal(back.byClip.size, 0);
  assert.equal(back.tuning.COST_SCALE, 1);
});

test('bad data is always treated as an empty table, no throw: the stage must not crash because of one table', () => {
  for (const bad of [null, undefined, {}, { segments: 'x' }, { segments: [{}] }, { prerenderSet: 3 }]) {
    const back = revivePlan(bad);
    assert.ok(back.prerenderSet instanceof Set);
    assert.ok(Array.isArray(back.segments));
    for (const s of back.segments) {
      assert.ok(s.heavy instanceof Set);
      assert.ok(s.light instanceof Set);
      assert.equal(Number.isFinite(s.fromSec), true);
    }
  }
});

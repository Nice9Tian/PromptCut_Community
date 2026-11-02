import test from 'node:test';
import assert from 'node:assert/strict';

import { planInputsOfControls, pickLatestCosts, prerenderSetOf, prerenderSetOfPlan } from '../prerender-set.mjs';
import { planPipelines, clipCostIndex } from '../../src/render/pipelinePlan.mjs';
import { cardCostKey } from '../../src/render/cardCostKey.mjs';

/**
 * Final clause of K2: neither side exchanges dispatch tables, only synchronizing `costs`.
 * Therefore **the same input must compute field-by-field identical tables on both sides**.
 *
 * The page-side entry point is `clipCostIndex(project, graph, sourceVersionOf)` (wrapped in
 * `src/editor/costIdentity.ts` to retrieve source version); the prerender process side is
 * `control.costKey` → `planInputsOfControls` computed along the way by `plan()` in
 * `card-cache.mjs`. This test suite pins down that "both paths compute the exact same table".
 */

const fps = 30;

/** Graph node for a card (shaped per `cardGraph.mjs` synthesis: with clipId / cardId / capabilities) */
const nodeOf = (clipId, cardId, caps) => ({
  id: `n:${clipId}`, clipId, cardId, definitionId: `def:${cardId}`, inputs: {},
  params: { text: cardId }, capabilities: caps,
});

const clips = [
  { id: 'a', cardId: 'motion', nodeId: 'n:a', start: 0, end: 6 },
  { id: 'b', cardId: 'lottie', nodeId: 'n:b', start: 2, end: 20 },
  { id: 'c', cardId: 'title', nodeId: 'n:c', start: 4, end: 8 },
];
const caps = {
  a: { frameMode: 'stateful', compositing: 'independent' },
  b: { frameMode: 'stateful', compositing: 'independent' },
  c: { frameMode: 'direct', compositing: 'independent' },
};
const project = { fps, tracks: [{ id: 'tr', clips }] };
const graph = { nodes: clips.map((c) => nodeOf(c.id, c.cardId, caps[c.id])) };
const sourceVersions = { motion: 'builtin:11', lottie: 'builtin:22', title: 'builtin:33' };
const sourceVersionOf = (node) => sourceVersions[node.cardId] ?? null;

/** Prerender process side: `plan()` in `card-cache.mjs` writes these two entries to control */
const controls = clips.map((clip) => {
  const node = graph.nodes.find((n) => n.clipId === clip.id);
  return {
    clipId: clip.id, nodeId: node.id, start: clip.start, end: clip.end,
    costKey: cardCostKey(node, sourceVersionOf(node), fps, Math.max(1, Math.round((clip.end - clip.start) * fps))),
    frameMode: caps[clip.id].frameMode, capabilities: caps[clip.id],
  };
});

const costs = [
  // 6-second Motion card at 1 ms per tick: catchUpMs 180 > B, 180 / (4 × 1) = 45 ticks ≤ 60
  // → light at all positions, routes to (b)
  { identityKey: controls[0].costKey, device: 'dev', fps, stepMs: 1, stepMaxMs: 2, inlineMs: 0, rasterMs: 0, serializeMs: 0,
    catchUpMs: 180, kind: 'stepped', vtOk: true, seekOk: false, seekMs: null, demoted: false, measuredAt: 10 },
  // 18 seconds, 1 ms per tick: catchUpMs 540, 540 / 4 = 135 ticks > 60 → heavy at all positions,
  // entire segment enters prerender set
  { identityKey: controls[1].costKey, device: 'dev', fps, stepMs: 1, stepMaxMs: 2, inlineMs: 0, rasterMs: 0, serializeMs: 0,
    catchUpMs: 540, kind: 'stepped', vtOk: false, seekOk: false, seekMs: null, demoted: false, measuredAt: 10 },
  // Random-access card
  { identityKey: controls[2].costKey, device: 'dev', fps, stepMs: 2, inlineMs: 0, rasterMs: 0, serializeMs: 0,
    catchUpMs: 0, kind: 'random', demoted: false, measuredAt: 10 },
];

test('both sides compute field-by-field identical tables from the same input', () => {
  // Page side
  const pageIndex = clipCostIndex(project, graph, sourceVersionOf);
  const pagePlan = planPipelines(project, costs, fps, { ...pageIndex });
  // Prerender process side
  const { project: synth, identityKeys, frameModes } = planInputsOfControls(controls, fps);
  const serverPlan = planPipelines(synth, costs, fps, { identityKeys, frameModes });

  // Keys themselves match first: identical tables with different keys just mean neither side hit a record
  assert.deepEqual(identityKeys, pageIndex.identityKeys);
  assert.deepEqual(frameModes, pageIndex.frameModes);
  // Field by field: byte-for-byte identical after JSON (set was already sorted by clipId when built)
  const wire = (plan) => JSON.stringify({
    segments: plan.segments.map((s) => ({ fromSec: s.fromSec, toSec: s.toSec, heavy: [...s.heavy], light: [...s.light] })),
    prerenderSet: [...plan.prerenderSet],
  });
  assert.equal(wire(serverPlan), wire(pagePlan));
});

test('the prerender set is the one planPipelines produces, with no fallback to declarations anymore', () => {
  const set = prerenderSetOfPlan(controls, { fps, costs, tuning: null });
  // The 18-second one exceeded frame catch-up upper bound → heavy at all positions, entire segment
  // is in set; 6-second one takes (b), light at all positions → not in set
  assert.deepEqual([...set].sort(), ['b']);
  // Old behavior falling back to declarations would include both stateful cards: this is the
  // criterion for "connected to the real thing"
  const declared = prerenderSetOfPlan(controls, { fps, costs: [], tuning: null });
  assert.deepEqual([...declared].sort(), ['a', 'b']);
});

test('with no records at all, fall back to declarations (same as before planPipelines was wired in)', () => {
  const set = prerenderSetOf(project, [], fps, (clip) => caps[clip.id]);
  assert.deepEqual([...set].sort(), ['a', 'b']);
});

test('K6 downgrade: once demoted is written into costs, that card enters the prerender set', () => {
  const demoted = costs.map((r) => (r.identityKey === controls[0].costKey ? { ...r, capped: true, demoted: true } : r));
  const set = prerenderSetOfPlan(controls, { fps, costs: demoted, tuning: null });
  assert.deepEqual([...set].sort(), ['a', 'b']);
});

test('when one identityKey has several devices, take the entry with the latest measuredAt', () => {
  const two = [
    { identityKey: 'k', device: 'old', measuredAt: 1, stepMs: 99 },
    { identityKey: 'k', device: 'new', measuredAt: 2, stepMs: 1 },
  ];
  const picked = pickLatestCosts(two);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].device, 'new');
});

test('3D mode (includeLightCardsFor3D / view3d) also includes standalone light cards in prerenderSet', () => {
  // Originally the 6-second 'a' takes (b) light pipeline, 'c' is direct light card, only 'b'
  // enters prerenderSet
  const setNormal = prerenderSetOfPlan(controls, { fps, costs, tuning: null });
  assert.deepEqual([...setNormal].sort(), ['b']);

  // After enabling 3D mode, 'a' and 'c' are independent cards, both included in prerenderSet
  const set3D = prerenderSetOfPlan(controls, { fps, costs, tuning: null, includeLightCardsFor3D: true });
  assert.deepEqual([...set3D].sort(), ['a', 'b', 'c']);

  // Passing view3d via prerenderSetOf also takes effect
  const set3DDirect = prerenderSetOf(project, costs, fps, (clip) => caps[clip.id], { view3d: true });
  assert.deepEqual([...set3DDirect].sort(), ['a', 'b', 'c']);
});


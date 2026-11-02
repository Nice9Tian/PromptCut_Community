/**
 * Unknown cards (card clips whose definition cannot be found in the prerender registry) do not
 * enter the card plan (`CardFrameCache.plan()`), and the prerender process schedules no work for them.
 * Run: node --test server/test/card-cache-unknown.test.mjs
 *
 *   CU-01  The same project with or without an unknown card clip: controls (`key` / `contentKey` /
 *          `snapshotKey` / `cacheContentKey` / `costKey` / result key) of remaining clips are
 *          verbatim identical; unknown card clips have no controls
 *   CU-02  Unknown card as input to another card (media effect card filter consumes its output):
 *          that card has controls as usual, with keys verbatim identical to when not skipped
 *   CU-03  Prerender set (`prerenderSetOfPlan`, two paths: fallback by declaration when no cost
 *          record, by dispatch table when cost record exists) excludes unknown card clips; without
 *          `unknownClipIds` (legacy behavior), it was classified as heavy using the default
 *          capability of "no definition" (stateful, requires prerendering): this is the fixed
 *          side effect
 *   CU-04  Wiring: `__pcCardPlan` on the export page includes `unknownClipIds`
 *          (`unknownCardClipIds` in the registry)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CardFrameCache } from '../card-cache.mjs';
import { prerenderSetOfPlan } from '../prerender-set.mjs';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';
import { resultKeyOf } from '../render-node/fingerprint.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FP = '0123456789abcdef';
const Component = () => null;
const DEFS = {
  'known-a': { id: 'known-a', name: 'A', defaults: { text: 'a' }, controls: [], frameMode: 'stateful', Component },
  'known-b': { id: 'known-b', name: 'B', defaults: { n: 1 }, controls: [], frameMode: 'direct', Component },
  gfx: { id: 'gfx', name: 'Filter', kind: 'filter', defaults: { amount: 0.5 }, controls: [], card: () => ({}) },
};
const getCard = (id) => DEFS[id];

function project({ unknown = false, consumer = false } = {}) {
  const tracks = [
    { id: 't-a', name: 'a', clips: [{ id: 'a', cardId: 'known-a', start: 0, end: 2, params: {} }] },
    { id: 't-b', name: 'b', clips: [{ id: 'b', cardId: 'known-b', start: 1, end: 3, params: {}, frame: { x: 10, y: 20, w: 320, h: 180 } }] },
  ];
  if (unknown) tracks.push({ id: 't-x', name: 'x', clips: [{ id: 'x', cardId: 'nobody', start: 0, end: 4, params: { text: 'hi' } }] });
  const p = { version: 1, id: 'p', name: 'p', width: 640, height: 360, fps: 30, duration: 4, media: [], tracks };
  if (consumer) {
    // Media effect card filter consumes output of unknown card clip (`@clip/x/source`), another clip f
    // points to this filter node
    p.cardNodes = [{ id: 'n-f', adapter: 'card', cardId: 'gfx', kind: 'filter', inputs: { source: { nodeId: '@clip/x/source' } }, params: { amount: 0.5 } }];
    tracks.push({ id: 't-f', name: 'f', clips: [{ id: 'f', nodeId: 'n-f', start: 0, end: 4, params: { amount: 0.5 } }] });
  }
  return p;
}

const unknownOf = (p) => p.tracks.flatMap((t) => t.clips).filter((c) => c.cardId && !DEFS[c.cardId]).map((c) => c.id).sort();
function browserPlan(p, withUnknown = true) {
  return {
    graph: projectCardGraph(p, getCard),
    sourceVersions: { 'known-a': 'builtin:va', 'known-b': 'builtin:vb', gfx: 'builtin:vg' },
    environment: { width: p.width, height: p.height, fps: p.fps, theme: undefined, fontFingerprint: 'f' },
    ...(withUnknown ? { unknownClipIds: unknownOf(p) } : {}),
  };
}
function planOf(p, withUnknown = true) {
  const cache = new CardFrameCache({ root: os.tmpdir(), project: p, envFingerprint: FP });
  return cache.plan(browserPlan(p, withUnknown));
}
const keysOf = (c) => ({ clipId: c.clipId, key: c.key, contentKey: c.contentKey, snapshotKey: c.snapshotKey, cacheContentKey: c.cacheContentKey,
  costKey: c.costKey, resultKey: resultKeyOf(c.contentKey, c.envFingerprint), start: c.start, end: c.end, count: c.count });
const byClip = (plan) => Object.fromEntries(plan.map((c) => [c.clipId, keysOf(c)]));

test('CU-01 with or without one unknown card clip: the keys of the remaining clips are identical verbatim; the unknown card clip has no controls', () => {
  const without = byClip(planOf(project()));
  const withX = byClip(planOf(project({ unknown: true })));
  assert.deepEqual(Object.keys(without).sort(), ['a', 'b']);
  assert.deepEqual(Object.keys(withX).sort(), ['a', 'b'], 'unknown card clip x produces no controls');
  assert.deepEqual(withX, without, 'remaining clips: key / contentKey / snapshotKey / cacheContentKey / costKey / result key are identical verbatim');
  for (const c of Object.values(withX)) for (const k of ['key', 'contentKey', 'snapshotKey', 'resultKey']) assert.match(c[k], /^[0-9a-f]+/, `${c.clipId}.${k}`);
  // When not skipped (legacy behavior), x has controls and other cards remain unchanged: skipping only omits x
  const old = byClip(planOf(project({ unknown: true }), false));
  assert.deepEqual(Object.keys(old).sort(), ['a', 'b', 'x']);
  const { x: _x, ...rest } = old;
  assert.deepEqual(rest, withX);
});

test('CU-02 unknown card used as the input of another card: that card still has controls as usual, and its keys are identical verbatim to those without skipping', () => {
  const p = project({ unknown: true, consumer: true });
  const skipped = byClip(planOf(p));
  const old = byClip(planOf(p, false));
  assert.ok(skipped.f, 'clip f that consumes the output of the unknown card still has controls as usual');
  assert.equal(skipped.x, undefined, 'the unknown card clip itself has no controls');
  assert.deepEqual(skipped.f, old.f, 'keys of f are unchanged verbatim');
  assert.deepEqual(skipped.a, old.a);
  assert.deepEqual(skipped.b, old.b);
});

test('CU-03 the prerender set does not include the unknown card clip (two paths: without cost records and with cost records); the old behavior classified it as heavy by the default capability', () => {
  const p = project({ unknown: true });
  const plan = planOf(p);
  const old = planOf(p, false);
  // No cost record: fallback by declaration
  assert.equal(prerenderSetOfPlan(old, { fps: 30, costs: [] }).has('x'), true, 'old behavior: with no definition, classified as heavy by stateful / needs prerender (the side effect that was fixed)');
  assert.equal(prerenderSetOfPlan(plan, { fps: 30, costs: [] }).has('x'), false, 'no cost records: does not include the unknown card clip');
  // Has cost record (tested on other cards, unknown card has no record): by dispatch table
  const costs = plan.map((c) => ({ identityKey: c.costKey, fps: 30, device: 'd', measuredAt: 1, stepMs: 0.3, kind: 'random', catchUpMs: 0.3, seekOk: true, seekMs: 0.3 }));
  assert.equal(prerenderSetOfPlan(old, { fps: 30, costs }).has('x'), true, 'old behavior: with no record, classified as heavy by declaration');
  const set = prerenderSetOfPlan(plan, { fps: 30, costs });
  assert.equal(set.has('x'), false, 'with cost records: does not include the unknown card clip');
  assert.equal(set.has('a') || set.has('b'), false, 'other cards are still classified as light by their records');
});

test('CU-04 wiring: __pcCardPlan of the export page carries unknownClipIds', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ExportView.tsx'), 'utf8');
  const at = src.indexOf('window.__pcCardPlan = () =>');
  const body = src.slice(at, src.indexOf('window.__pcClipFrameModes', at));
  assert.match(body, /unknownClipIds: \[\.\.\.unknownCardClipIds\((?:proj|flat)\.tracks\.flatMap\(\(track\) => track\.clips\)\)\]\.sort\(\)/);
});

/**
 * Two node rules ruled by lead session after M7 probe (`docs/plan/m7-contract.md` Section 13
 * "Corrections after probe"):
 *   - Node-side filtering: pure browser does not accept canvas cards (`input.canvasHeavy`,
 *     sequential frame-by-frame push is not equivalent to desktop), Rule 7;
 *   - Split: canvas cards and cards marked by executor as exceeding frame size limit do not emit a
 *     separate copy for browser (only splitter's own copy as before); Lottie media cards relaxed
 *     starting 2026-10-14, emitting two copies like regular standalone cards;
 *   - Test-only "split-only" (Contract D15): when `PROMPTCUT_TEST_PLAN_ONLY=1`, pc node claims only
 *     plan, not fine-grained tasks (Rule 8).
 * Run: node --test server/test/m7-node-rules.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkClaimable } from '../render-node/filter.mjs';
import { splitPlan } from '../render-node/split.mjs';

const BROWSER = { profile: 'browser', nodeId: 'n', userId: 'u@d', envFingerprint: 'bbbbbbbbbbbbbbbb', codeVersions: ['cv'], capabilities: {} };
const task = (input = {}) => ({
  id: 'snapshot:k:0-29', kind: 'snapshot', tier: 'shared', resultKey: 'k', range: { from: 0, to: 29 },
  source: { projectId: 'p', projectRev: 1, userId: 'u@d' },
  input: { clipId: 'c', compositing: 'independent', canvasHeavy: false, ...input },
  weight: { class: 'light' }, requires: { envFingerprint: 'bbbbbbbbbbbbbbbb', codeVersion: 'cv', cardSources: {}, transcode: false, userCards: false, graphCards: false },
});

test('M7-NR-01 A browser-only node does not accept canvas cards (rule 7 canvas-heavy); other nodes still accept them', () => {
  assert.deepEqual(checkClaimable(task(), BROWSER), { ok: true });
  assert.deepEqual(checkClaimable(task({ canvasHeavy: true }), BROWSER), { ok: false, rule: 7, reason: 'canvas-heavy' });
  const pc = { ...BROWSER, profile: 'pc' };
  assert.equal(checkClaimable(task({ canvasHeavy: true }), pc).ok, true);
});

test('M7-NR-02 Split: canvas cards and cards marked oversized do not get a separate copy for the browser; plain independent cards and Lottie media cards still get two copies', () => {
  const planTask = { id: 'plan:p@1#clips:x', kind: 'plan', resultKey: 'p@1#clips:x', source: { projectId: 'p', projectRev: 1 }, input: { clips: [] }, requires: {} };
  const control = (clipId, cardId, extra = {}) => ({ clipId, cardId, snapshotKey: `sk-${clipId}`, contentKey: `ck-${clipId}`, tier: 'shared', start: 0, end: 1, count: 30,
    sampling: { firstFrame: 0, phase: { numerator: 0, denominator: 1 } }, compositing: 'independent', capabilities: { compositing: 'independent' }, ...extra });
  const cardPlan = [
    control('a', 'punch-pill'),
    control('b', 'lottie-bodymovin'),
    control('c', 'lottie'),
    control('d', 'particles', { capabilities: { compositing: 'independent', canvasHeavy: true } }),
    control('e', 'mu-number-ticker', { snapshotOversize: true }),
  ];
  const tasks = splitPlan({ planTask, entryKey: 'e', cardPlan, prerenderSet: new Set(cardPlan.map((c) => c.clipId)), envFingerprint: 'aaaaaaaaaaaaaaaa',
    codeVersion: 'cv', weightOf: () => ({ class: 'medium', estMs: null }), browserFingerprints: ['bbbbbbbbbbbbbbbb'] });
  const fps = (clipId) => tasks.filter((t) => t.input.clipId === clipId).map((t) => t.requires.envFingerprint).sort();
  for (const id of ['a', 'b', 'c']) assert.deepEqual(fps(id), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'], `${id} has two copies (plain independent card, Lottie media card, generic Lottie card)`);
  for (const id of ['d', 'e']) assert.deepEqual(fps(id), ['aaaaaaaaaaaaaaaa'], `${id} gets only the splitter's copy`);
  for (const t of tasks.filter((x) => ['d', 'e'].includes(x.input.clipId))) assert.equal(t.input.dual, undefined, 'No dual with only one copy');
});

test('M7-NR-03 Test-only "split only" (D15): with PROMPTCUT_TEST_PLAN_ONLY=1 the pc node claims only plans and does not claim fine-grained tasks (rule 8); unset behaves as before', async () => {
  const { testPlanOnly } = await import('../render-node/filter.mjs');
  const index = await import('../render-node/index.mjs');
  assert.equal(index.testPlanOnly, testPlanOnly, 'index.mjs re-exports it (vite-plugin-frames takes it from here)');
  assert.equal(testPlanOnly({}), false);
  assert.equal(testPlanOnly({ PROMPTCUT_TEST_PLAN_ONLY: '0' }), false);
  assert.equal(testPlanOnly({ PROMPTCUT_TEST_PLAN_ONLY: '1' }), true);
  const pc = { profile: 'pc', nodeId: 'pc-1', envFingerprint: 'bbbbbbbbbbbbbbbb', codeVersions: ['cv'], capabilities: {}, planOnly: true };
  const plan = { id: 'plan:p@1#clips:x', kind: 'plan', resultKey: 'p@1#clips:x', range: null, source: { projectId: 'p', projectRev: 1 }, input: { clips: ['c'] }, weight: { class: 'medium' }, requires: { codeVersion: 'cv' } };
  assert.deepEqual(checkClaimable(plan, pc), { ok: true }, 'A split-only node still claims plans');
  assert.deepEqual(checkClaimable(task(), pc), { ok: false, rule: 8, reason: 'plan-only' });
  const { planOnly: _p, ...normal } = pc;
  assert.deepEqual(checkClaimable(task(), normal), { ok: true }, 'When unset, fine-grained tasks are claimed as before');
});

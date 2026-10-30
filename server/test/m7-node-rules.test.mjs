/**
 * M7 探针之后主会话裁定的两条节点规则(`docs/plan/m7-contract.md` 第 13 节「探针之后的更正」):
 *   - 节点侧过滤:纯浏览器不收画布卡(`input.canvasHeavy`,逐帧顺推与桌面不等价),规则 7;
 *   - 切分:画布卡、执行器标了帧超体积上限的卡,不给浏览器另出一份(照旧只出切分方自己那一份);Lottie 素材卡 2026-10-14 起放开,和普通独立卡一样出两份;
 *   - 仅供测试的「只切分」(契约 D15):`PROMPTCUT_TEST_PLAN_ONLY=1` 时 pc 节点只认领 plan、不认领细任务(规则 8)。
 * 跑:node --test server/test/m7-node-rules.test.mjs
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

test('M7-NR-01 纯浏览器不收画布卡(规则 7 canvas-heavy);别的节点照收', () => {
  assert.deepEqual(checkClaimable(task(), BROWSER), { ok: true });
  assert.deepEqual(checkClaimable(task({ canvasHeavy: true }), BROWSER), { ok: false, rule: 7, reason: 'canvas-heavy' });
  const pc = { ...BROWSER, profile: 'pc' };
  assert.equal(checkClaimable(task({ canvasHeavy: true }), pc).ok, true);
});

test('M7-NR-02 切分:画布卡、标了超体积的卡不给浏览器另出一份;普通独立卡和 Lottie 素材卡照出两份', () => {
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
  for (const id of ['a', 'b', 'c']) assert.deepEqual(fps(id), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'], `${id} 两份(普通独立卡、Lottie 素材卡、通用 Lottie 卡)`);
  for (const id of ['d', 'e']) assert.deepEqual(fps(id), ['aaaaaaaaaaaaaaaa'], `${id} 只出切分方那一份`);
  for (const t of tasks.filter((x) => ['d', 'e'].includes(x.input.clipId))) assert.equal(t.input.dual, undefined, '只有一份时不带 dual');
});

test('M7-NR-03 仅供测试的「只切分」(D15):PROMPTCUT_TEST_PLAN_ONLY=1 时 pc 节点只认领 plan,不认领细任务(规则 8);没设照旧', async () => {
  const { testPlanOnly } = await import('../render-node/filter.mjs');
  const index = await import('../render-node/index.mjs');
  assert.equal(index.testPlanOnly, testPlanOnly, 'index.mjs 转出(vite-plugin-frames 从这里取)');
  assert.equal(testPlanOnly({}), false);
  assert.equal(testPlanOnly({ PROMPTCUT_TEST_PLAN_ONLY: '0' }), false);
  assert.equal(testPlanOnly({ PROMPTCUT_TEST_PLAN_ONLY: '1' }), true);
  const pc = { profile: 'pc', nodeId: 'pc-1', envFingerprint: 'bbbbbbbbbbbbbbbb', codeVersions: ['cv'], capabilities: {}, planOnly: true };
  const plan = { id: 'plan:p@1#clips:x', kind: 'plan', resultKey: 'p@1#clips:x', range: null, source: { projectId: 'p', projectRev: 1 }, input: { clips: ['c'] }, weight: { class: 'medium' }, requires: { codeVersion: 'cv' } };
  assert.deepEqual(checkClaimable(plan, pc), { ok: true }, '只切分的节点照样认领 plan');
  assert.deepEqual(checkClaimable(task(), pc), { ok: false, rule: 8, reason: 'plan-only' });
  const { planOnly: _p, ...normal } = pc;
  assert.deepEqual(checkClaimable(task(), normal), { ok: true }, '没设就照旧认领细任务');
});

/**
 * Regression: Root directory for prerender pipeline reading cost records (when
 * `PROMPTCUT_DATA_DIR` is unset during development).
 * Run: node --test server/test/prerender-costs-root.test.mjs
 *
 * Previously `recordCardPlan` passed `this.root` (frame store directory
 * `<repo>/out/frame-library`) as the cost root to `prerenderSetOfPlan`, reading
 * `<frame-store>/out/card-costs.json`: nobody wrote this file; `vite-plugin-costs` wrote to
 * `<repo>/out/card-costs.json`. Measured costs thus never entered the prerender set, always
 * falling back to declared values. Both probes and desktop app set `PROMPTCUT_DATA_DIR`, so this
 * was never caught.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FramePipeline } from '../frame-pipeline.mjs';
import { upsertCosts } from '../costs-store.mjs';
import { cardCostKey } from '../../src/render/cardCostKey.mjs';

const fps = 30;
const caps = {
  a: { frameMode: 'stateful', compositing: 'independent' },
  b: { frameMode: 'stateful', compositing: 'independent' },
};
const clips = [
  { id: 'a', cardId: 'motion', start: 0, end: 6 },
  { id: 'b', cardId: 'lottie', start: 2, end: 20 },
];
// Fields written to control by `plan()` in `card-cache.mjs` (same as fixture in prerender-set.test.mjs)
const plan = clips.map(clip => {
  const node = { id: `n:${clip.id}`, clipId: clip.id, cardId: clip.cardId, definitionId: `def:${clip.cardId}`, inputs: {},
    params: { text: clip.cardId }, capabilities: caps[clip.id] };
  return { clipId: clip.id, nodeId: node.id, start: clip.start, end: clip.end,
    costKey: cardCostKey(node, `builtin:${clip.cardId}`, fps, Math.max(1, Math.round((clip.end - clip.start) * fps))),
    frameMode: caps[clip.id].frameMode, capabilities: caps[clip.id] };
});
// a: 6 seconds, 1 ms per tick, light at all positions; b: 18 seconds, frame catch-up exceeds
// upper bound, heavy at all positions (criteria in prerender-set.test.mjs)
const costs = [
  { identityKey: plan[0].costKey, device: 'dev', fps, stepMs: 1, stepMaxMs: 2, inlineMs: 0, rasterMs: 0, serializeMs: 0,
    catchUpMs: 180, kind: 'stepped', vtOk: true, seekOk: false, seekMs: null, demoted: false, measuredAt: 10 },
  { identityKey: plan[1].costKey, device: 'dev', fps, stepMs: 1, stepMaxMs: 2, inlineMs: 0, rasterMs: 0, serializeMs: 0,
    catchUpMs: 540, kind: 'stepped', vtOk: false, seekOk: false, seekMs: null, demoted: false, measuredAt: 10 },
];

/** Run `fn(repoRoot)` in dev environment without `PROMPTCUT_DATA_DIR`; delete dir and restore env vars after completion */
function devLayout(fn) {
  const saved = process.env.PROMPTCUT_DATA_DIR;
  delete process.env.PROMPTCUT_DATA_DIR;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-costs-root-'));
  try { return fn(repo); }
  finally {
    if (saved === undefined) delete process.env.PROMPTCUT_DATA_DIR; else process.env.PROMPTCUT_DATA_DIR = saved;
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test('In development: records the cost plugin writes into <repo>/out are readable by the prerender pipeline (the set is computed from measured costs, not from the declaration fallback)', () => devLayout(repo => {
  upsertCosts(repo, costs);                                    // vite-plugin-costs convention: root = Vite's root directory
  assert.ok(fs.existsSync(path.join(repo, 'out', 'card-costs.json')));
  const pipeline = new FramePipeline({ root: path.join(repo, 'out', 'frame-library'), origin: () => '', dataRoot: repo });
  const entry = { key: 'E', project: { fps } };
  pipeline.recordCardPlan(entry, plan);
  assert.deepEqual([...entry.prerenderSet].sort(), ['b'], 'a, classified as light, is not in the set: the measured cost took effect');
}));

test('In development: a same-named file under the frame store directory is no longer treated as a cost record (the cost root is dataRoot, not the frame store)', () => devLayout(repo => {
  const library = path.join(repo, 'out', 'frame-library');
  // Place a "both classified as light" record on the old erroneous path: if still read, the set becomes empty
  upsertCosts(library, costs.map(record => ({ ...record, catchUpMs: 0, kind: 'random', stepMs: 1 })));
  assert.ok(fs.existsSync(path.join(library, 'out', 'card-costs.json')));
  // The real record is in <repo>/out
  upsertCosts(repo, costs);
  const pipeline = new FramePipeline({ root: library, origin: () => '', dataRoot: repo });
  const entry = { key: 'E', project: { fps } };
  pipeline.recordCardPlan(entry, plan);
  assert.deepEqual([...entry.prerenderSet].sort(), ['b']);
}));

test('In development: with no records at all under <repo>/out, it falls back to the declarations as before', () => devLayout(repo => {
  const pipeline = new FramePipeline({ root: path.join(repo, 'out', 'frame-library'), origin: () => '', dataRoot: repo });
  const entry = { key: 'E', project: { fps } };
  pipeline.recordCardPlan(entry, plan);
  assert.deepEqual([...entry.prerenderSet].sort(), ['a', 'b']);
}));

test('When PROMPTCUT_DATA_DIR is set (desktop app, probes), it still takes precedence', () => devLayout(repo => {
  const dataDir = path.join(repo, 'appdata');
  process.env.PROMPTCUT_DATA_DIR = dataDir;
  upsertCosts('ignored-when-env-set', costs);
  assert.ok(fs.existsSync(path.join(dataDir, 'card-costs.json')));
  const pipeline = new FramePipeline({ root: path.join(repo, 'out', 'frame-library'), origin: () => '', dataRoot: repo });
  const entry = { key: 'E', project: { fps } };
  pipeline.recordCardPlan(entry, plan);
  assert.deepEqual([...entry.prerenderSet].sort(), ['b']);
}));

test('Without dataRoot, the default is the current working directory (scripts run from the repo root line up with the cost plugin)', () => {
  const pipeline = new FramePipeline({ root: path.join(os.tmpdir(), 'pc-none', 'frame-library'), origin: () => '' });
  assert.equal(pipeline.dataRoot, process.cwd());
});

test('While the old session\'s full-frame background task has not finished, the new preload immediately recomputes the existing card plan with the new costs', async () => {
  const saved = process.env.PROMPTCUT_DATA_DIR;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-costs-preload-'));
  process.env.PROMPTCUT_DATA_DIR = path.join(repo, 'data');
  let unblock;
  try {
    const pipeline = new FramePipeline({ root: path.join(repo, 'frame-library'), origin: () => '', dataRoot: repo });
    const entry = { key: 'same-content', project: { fps }, cardPlan: plan, anchorsReady: false };
    pipeline.entry = async () => entry;
    const waiting = new Promise(resolve => { unblock = resolve; });
    pipeline.acquire = async () => { await waiting; throw new Error('The background render fixture is stuck at acquire'); };

    pipeline.recordCardPlan(entry, plan);
    assert.deepEqual([...entry.prerenderSet].sort(), ['a', 'b']);
    await pipeline.preload(entry.project, { session: 'old', localRev: 1 });
    upsertCosts(repo, costs);
    await pipeline.preload(entry.project, { session: 'new', localRev: 1 });
    assert.deepEqual([...entry.prerenderSet], ['b'], 'The new session must not wait for the old background video to finish before seeing the measured costs');
    assert.equal(pipeline.ready.describe().find(s => s.session === 'new')?.entryKey, entry.key);
    unblock();
    await pipeline.background;
  } finally {
    unblock?.();
    if (saved === undefined) delete process.env.PROMPTCUT_DATA_DIR; else process.env.PROMPTCUT_DATA_DIR = saved;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

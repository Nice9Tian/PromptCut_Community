import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadCosts, loadTuning, saveTuning, upsertCosts, mergeCosts, filterCosts, costsPath, tuningPath, RENAME_RETRIES } from '../costs-store.mjs';
import { DEFAULT_TUNING } from '../../src/render/pipelineTuning.mjs';

/** Clean root for each case; PROMPTCUT_DATA_DIR moves drop target away, stripped during testing */
function withRoot(fn) {
  const saved = process.env.PROMPTCUT_DATA_DIR;
  delete process.env.PROMPTCUT_DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-costs-'));
  try {
    return fn(root);
  } finally {
    if (saved === undefined) delete process.env.PROMPTCUT_DATA_DIR;
    else process.env.PROMPTCUT_DATA_DIR = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const rec = (over = {}) => ({
  identityKey: 'k1', fps: 30, stepMs: 3, inlineMs: 40, rasterMs: 0, serializeMs: 6, catchUpMs: 120,
  kind: 'stepped', measuredAt: 1, device: 'dev-A', ...over,
});

test('Empty / corrupt files are both treated as an empty table, no throw', () => {
  withRoot((root) => {
    assert.deepEqual(loadCosts(root), []);
    fs.mkdirSync(path.dirname(costsPath(root)), { recursive: true });
    fs.writeFileSync(costsPath(root), '{ half-written', 'utf8');
    assert.deepEqual(loadCosts(root), []);
  });
});

test('Dedupe by (identityKey, device): same key overwrites, different devices coexist', () => {
  withRoot((root) => {
    const first = upsertCosts(root, [rec(), rec({ device: 'dev-B', stepMs: 40 })]);
    assert.equal(first.count, 2);
    assert.equal(first.added, 2);

    const second = upsertCosts(root, [rec({ stepMs: 9, measuredAt: 2 })]);
    assert.equal(second.count, 2, 'Same key does not add a row');
    assert.equal(second.updated, 1);

    const all = loadCosts(root);
    assert.equal(all.length, 2);
    assert.equal(all.find((r) => r.device === 'dev-A').stepMs, 9);
    assert.equal(all.find((r) => r.device === 'dev-B').stepMs, 40, 'The other machine\'s result is unaffected');
  });
});

test('Different identityKeys on the same device each take a row', () => {
  withRoot((root) => {
    upsertCosts(root, [rec(), rec({ identityKey: 'k2' })]);
    assert.equal(loadCosts(root).length, 2);
  });
});

test('demoted / pinnedHeavy stay sticky on re-measurement and are overwritten only when a value is given explicitly', () => {
  withRoot((root) => {
    upsertCosts(root, [rec({ demoted: true, pinnedHeavy: true })]);
    // Records reported by probe re-measurement do not have these two fields
    upsertCosts(root, [rec({ stepMs: 11 })]);
    const kept = loadCosts(root)[0];
    assert.equal(kept.stepMs, 11);
    assert.equal(kept.demoted, true, 'If the downgrade flag is wiped, K1 would skip this card forever');
    assert.equal(kept.pinnedHeavy, true);

    // Explicitly passing false takes the new value (K6 undo downgrade takes this path)
    upsertCosts(root, [rec({ demoted: false })]);
    assert.equal(loadCosts(root)[0].demoted, false);
    assert.equal(loadCosts(root)[0].pinnedHeavy, true, 'The flag that was not mentioned stays sticky as before');
  });
});

test('A record missing a key is dropped whole, without polluting the save file', () => {
  withRoot((root) => {
    const out = upsertCosts(root, [rec(), { fps: 30 }, { identityKey: 'x' }, { device: 'dev-A' }, null, 'nope']);
    assert.equal(out.count, 1);
    assert.equal(out.added, 1);
  });
});

test('mergeCosts is a pure function: it does not mutate its arguments', () => {
  const existing = [rec({ demoted: true })];
  const snapshot = JSON.stringify(existing);
  const out = mergeCosts(existing, [rec({ stepMs: 7 })]);
  assert.equal(JSON.stringify(existing), snapshot);
  assert.equal(out.costs[0].stepMs, 7);
  assert.equal(out.costs[0].demoted, true);
});

test('filterCosts filters by mode; old records missing the field count as dev', () => {
  const costs = [rec({ mode: 'dev' }), rec({ identityKey: 'k2', mode: 'build' }), rec({ identityKey: 'k3' })];
  assert.deepEqual(filterCosts(costs, null, 'dev').map((r) => r.identityKey), ['k1', 'k3'], 'Records from before R1 have no mode; they were all measured in dev mode');
  assert.deepEqual(filterCosts(costs, null, 'build').map((r) => r.identityKey), ['k2']);
  assert.equal(filterCosts(costs, null, null).length, 3, 'No mode given means no filtering');
  assert.equal(filterCosts(costs, 'dev-A', 'build').length, 1, 'Both conditions apply together');
});

test('filterCosts filters by device; no device given returns everything', () => {
  const costs = [rec(), rec({ identityKey: 'k2', device: 'dev-B' })];
  assert.equal(filterCosts(costs, 'dev-A').length, 1);
  assert.equal(filterCosts(costs, 'dev-A')[0].identityKey, 'k1');
  assert.equal(filterCosts(costs, 'nobody').length, 0);
  assert.equal(filterCosts(costs, null).length, 2);
  assert.equal(filterCosts(costs, '').length, 2);
});

test('Writing to disk is atomic: no temp files are left besides the save file', () => {
  withRoot((root) => {
    upsertCosts(root, [rec()]);
    const dir = path.dirname(costsPath(root));
    assert.deepEqual(fs.readdirSync(dir), ['card-costs.json']);
    const raw = JSON.parse(fs.readFileSync(costsPath(root), 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.costs.length, 1);
  });
});

/* ------------------------------------------------ K2 tunable coefficients (out/pipeline-tuning.json) */

const writeTuning = (root, text) => {
  fs.mkdirSync(path.dirname(tuningPath(root)), { recursive: true });
  fs.writeFileSync(tuningPath(root), text, 'utf8');
};

test('Without out/pipeline-tuning.json, all defaults are used', () => {
  withRoot((root) => {
    assert.deepEqual({ ...loadTuning(root) }, { ...DEFAULT_TUNING });
  });
});

test('Override values can be read back, and are clamped to the K2 range', () => {
  withRoot((root) => {
    writeTuning(root, JSON.stringify({ COST_SCALE: 2, STEP_PERCENTILE: 0.95 }));
    assert.deepEqual({ ...loadTuning(root) },
      { COST_SCALE: 2, STEP_PERCENTILE: 0.95, STEP_MIN_SAMPLES: DEFAULT_TUNING.STEP_MIN_SAMPLES }, 'The item that was not mentioned uses its default');

    writeTuning(root, JSON.stringify({ COST_SCALE: 99, STEP_MIN_SAMPLES: 0 }));
    const clamped = loadTuning(root);
    assert.equal(clamped.COST_SCALE, 4);
    assert.equal(clamped.STEP_MIN_SAMPLES, 8);
  });
});

test('A corrupt file / a non-object is treated as "no overrides", no throw', () => {
  withRoot((root) => {
    writeTuning(root, '{ half-written');
    assert.deepEqual({ ...loadTuning(root) }, { ...DEFAULT_TUNING });
    writeTuning(root, '[1,2,3]');
    assert.deepEqual({ ...loadTuning(root) }, { ...DEFAULT_TUNING });
    writeTuning(root, 'null');
    assert.deepEqual({ ...loadTuning(root) }, { ...DEFAULT_TUNING });
  });
});

test('Coefficients and cost records live in the same directory without interfering with each other', () => {
  withRoot((root) => {
    writeTuning(root, JSON.stringify({ COST_SCALE: 3 }));
    upsertCosts(root, [rec()]);
    assert.equal(path.dirname(tuningPath(root)), path.dirname(costsPath(root)));
    assert.equal(loadTuning(root).COST_SCALE, 3, 'Writing records did not wipe out the coefficient file');
    assert.equal(loadCosts(root).length, 1);
  });
});

/* ---------------------------------------------- saveTuning(PUT /api/data/costs/tuning) */

test('What saveTuning writes is the clamped copy, and loadTuning can read it back', () => {
  withRoot((root) => {
    const out = saveTuning(root, { COST_SCALE: 2, STEP_PERCENTILE: 0.95 });
    assert.deepEqual({ ...out }, { COST_SCALE: 2, STEP_PERCENTILE: 0.95, STEP_MIN_SAMPLES: DEFAULT_TUNING.STEP_MIN_SAMPLES });
    assert.deepEqual({ ...loadTuning(root) }, { ...out });
    // What is stored in the file is also clamped, not the raw value from the request
    assert.deepEqual(JSON.parse(fs.readFileSync(tuningPath(root), 'utf8')), { ...out });
  });
});

test('saveTuning clamps out-of-range values, and bad values fall back to the default', () => {
  withRoot((root) => {
    assert.equal(saveTuning(root, { COST_SCALE: 100 }).COST_SCALE, 4);
    assert.equal(loadTuning(root).COST_SCALE, 4);
    assert.equal(saveTuning(root, { COST_SCALE: 0 }).COST_SCALE, 0.25);
    assert.equal(saveTuning(root, { COST_SCALE: 'x' }).COST_SCALE, DEFAULT_TUNING.COST_SCALE);
  });
});

test('saveTuning(null) clears the overrides: it deletes the file instead of writing the default values into it', () => {
  withRoot((root) => {
    saveTuning(root, { COST_SCALE: 3 });
    assert.equal(fs.existsSync(tuningPath(root)), true);
    assert.deepEqual({ ...saveTuning(root, null) }, { ...DEFAULT_TUNING });
    assert.equal(fs.existsSync(tuningPath(root)), false, '"No such file = use all defaults" is stated explicitly in K2');
    assert.deepEqual({ ...loadTuning(root) }, { ...DEFAULT_TUNING });
    // Clearing again when there was no file to begin with does not throw
    assert.deepEqual({ ...saveTuning(root, [1, 2]) }, { ...DEFAULT_TUNING });
  });
});

test('saveTuning does not touch cost records', () => {
  withRoot((root) => {
    upsertCosts(root, [rec()]);
    saveTuning(root, { STEP_MIN_SAMPLES: 32 });
    assert.equal(loadCosts(root).length, 1);
    assert.equal(loadTuning(root).STEP_MIN_SAMPLES, 32);
  });
});

test('PROMPTCUT_DATA_DIR overrides where files are written', () => {
  const saved = process.env.PROMPTCUT_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-costs-env-'));
  process.env.PROMPTCUT_DATA_DIR = dir;
  try {
    assert.equal(costsPath('C:/nowhere'), path.join(dir, 'card-costs.json'));
    upsertCosts('C:/nowhere', [rec()]);
    assert.equal(loadCosts('C:/nowhere').length, 1);
  } finally {
    if (saved === undefined) delete process.env.PROMPTCUT_DATA_DIR;
    else process.env.PROMPTCUT_DATA_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Make fs.renameSync throw code errors for the first n times, then rename as usual */
function flakyRename(n, code) {
  const real = fs.renameSync;
  let calls = 0;
  const m = mock.method(fs, 'renameSync', (from, to) => {
    calls += 1;
    if (calls <= n) throw Object.assign(new Error(`${code}: rename ${from} -> ${to}`), { code });
    return real.call(fs, from, to);
  });
  return { calls: () => calls, restore: () => m.mock.restore() };
}

test('Occasional EPERM / EBUSY / EACCES on rename: succeeds after backoff retries, no temp file left', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    withRoot((root) => {
      upsertCosts(root, [rec({ inlineMs: 1 })]);
      const flaky = flakyRename(3, code);
      try {
        const out = upsertCosts(root, [rec({ inlineMs: 2 })]);
        assert.equal(out.updated, 1);
        assert.equal(flaky.calls(), 4, `${code}: fails 3 times, succeeds on the 4th`);
      } finally { flaky.restore(); }
      assert.equal(loadCosts(root)[0].inlineMs, 2);
      assert.deepEqual(fs.readdirSync(path.dirname(costsPath(root))).filter((f) => f.endsWith('.tmp')), []);
    });
  }
});

test('Rename still fails after retries are exhausted: the original error is reported, the old save file is untouched, the temp file is deleted', () => {
  withRoot((root) => {
    upsertCosts(root, [rec({ inlineMs: 1 })]);
    const flaky = flakyRename(Infinity, 'EPERM');
    try {
      assert.throws(() => upsertCosts(root, [rec({ inlineMs: 2 })]), (err) => err.code === 'EPERM');
      assert.equal(flaky.calls(), RENAME_RETRIES + 1);
    } finally { flaky.restore(); }
    assert.equal(loadCosts(root)[0].inlineMs, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(costsPath(root))).filter((f) => f.endsWith('.tmp')), []);
  });
});

test('Rename does not retry on other errors', () => {
  withRoot((root) => {
    const flaky = flakyRename(1, 'ENOENT');
    try {
      assert.throws(() => upsertCosts(root, [rec()]), (err) => err.code === 'ENOENT');
      assert.equal(flaky.calls(), 1);
    } finally { flaky.restore(); }
  });
});

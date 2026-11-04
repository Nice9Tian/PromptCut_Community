/**
 * M7-T: D12 layer table v3 (each layer carries candidates: splitter's own, browser's; page
 * determines which copy is alive per task.done and manifest) and compatibility with reading old v2.
 * Basis: Section 13 D12 ruling in `docs/plan/m7-contract.md`, "layer table v2 upgraded to v3; pages
 * reading old v2 treated as 'one candidate'".
 * Assumptions in K9 of `m7-kit.mjs`. The v2 compatibility test runs now (guards against
 * regressions); v3 tests are behind gates.
 * Run: node --experimental-test-module-mocks --test server/test/m7-layer.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importRepo, rk, layerV3Gate, gateOpts } from './m7-kit.mjs';

const OWN = '1111111111111111';
const BR = '2222222222222222';
const CK = 'ck-m1';

const snapshotSource = () => importRepo('src/render/snapshotSource.ts');

const candidate = (fp) => ({ resultKey: rk(CK, fp), envFingerprint: fp, key: `wire-${fp.slice(0, 4)}` });
/** One layer in v3: resultKey / envFingerprint / key on layer equal first candidate (K9) */
function v3Layer(candidates, clipId = 'clip-m1') {
  const first = candidates[0];
  return { clipId, kind: 'html', key: first.key, tier: 'shared', resultKey: first.resultKey, dirKey: first.resultKey, entryKey: null,
    firstFrame: 0, count: 120, contentKey: CK, envFingerprint: first.envFingerprint, candidates };
}
const table = (v, layers) => ({ v, kind: 'layer-map', projectId: 'p1', entryKey: null, fps: 30, span: 60, at: 0, layers });
const v2Layer = (clipId = 'clip-m1') => ({ clipId, kind: 'html', key: 'wire-v2', tier: 'shared', resultKey: rk(CK, OWN), dirKey: rk(CK, OWN), entryKey: null,
  firstFrame: 0, count: 120, contentKey: CK, envFingerprint: OWN });

/** (resultKey, envFingerprint, key) of returned layer must originate from same candidate (not mixed) */
function assertWholeCandidate(ref, candidates) {
  const hit = candidates.find((c) => c.resultKey === ref.resultKey);
  assert.ok(hit, `The returned resultKey matches no candidate: ${JSON.stringify(ref)}`);
  assert.equal(ref.envFingerprint, hit.envFingerprint, 'The fingerprint and result key must come from the same candidate');
  assert.equal(ref.key, hit.key, 'The online key and result key must come from the same candidate');
}

test('D12 reading old v2: treated as "one candidate", the layer is returned as before whether or not alive is given (regression)', async () => {
  const { layerRefOf } = await snapshotSource();
  const t = table(2, [v2Layer()]);
  const plain = layerRefOf(t, 'clip-m1');
  assert.ok(plain, 'v2 plain tier still works');
  assert.equal(plain.resultKey, rk(CK, OWN));
  for (const alive of [new Set(), new Set(['something-else']), new Set([rk(CK, OWN)])]) {
    const ref = layerRefOf(t, 'clip-m1', { alive });
    assert.equal(ref?.resultKey, rk(CK, OWN), `v2 ignores alive: ${JSON.stringify(ref)}`);
    assert.equal(ref.envFingerprint, OWN);
  }
});

test('D12 v3: when the browser copy is determined to be alive, use the browser\'s as a whole (result key, fingerprint, online key)', gateOpts(layerV3Gate()), async () => {
  const { layerRefOf } = await snapshotSource();
  const cands = [candidate(OWN), candidate(BR)];
  const t = table(3, [v3Layer(cands)]);
  const ref = layerRefOf(t, 'clip-m1', { alive: new Set([rk(CK, BR)]) });
  assert.ok(ref, 'v3 can select one');
  assert.equal(ref.resultKey, rk(CK, BR));
  assert.equal(ref.envFingerprint, BR);
  assertWholeCandidate(ref, cands);
  assert.equal(ref.contentKey, CK);
});

test('D12 v3: when the splitter\'s copy is determined to be alive, use the splitter\'s; when it cannot be determined, return either null or one whole candidate, never a mix', gateOpts(layerV3Gate()), async () => {
  const { layerRefOf } = await snapshotSource();
  const cands = [candidate(OWN), candidate(BR)];
  const t = table(3, [v3Layer(cands)]);
  const own = layerRefOf(t, 'clip-m1', { alive: new Set([rk(CK, OWN)]) });
  assert.equal(own?.resultKey, rk(CK, OWN));
  assertWholeCandidate(own, cands);
  for (const opts of [{}, { alive: new Set() }]) {
    const ref = layerRefOf(t, 'clip-m1', opts);
    if (ref !== null && ref !== undefined) assertWholeCandidate(ref, cands);
  }
  // If candidate order is reversed (fields on layer equal browser copy) and splitter is considered
  // alive, switch in its entirety to splitter
  const rev = table(3, [v3Layer([candidate(BR), candidate(OWN)])]);
  const r2 = layerRefOf(rev, 'clip-m1', { alive: new Set([rk(CK, OWN)]) });
  assert.equal(r2?.resultKey, rk(CK, OWN));
  assertWholeCandidate(r2, cands);
});

test('D12 v3: with only one candidate it is treated as v2 (no need to wait for the determination); a layer whose candidate is broken is not returned', gateOpts(layerV3Gate()), async () => {
  const { layerRefOf } = await snapshotSource();
  const single = table(3, [v3Layer([candidate(OWN)])]);
  const ref = layerRefOf(single, 'clip-m1');
  assert.equal(ref?.resultKey, rk(CK, OWN));
  assert.equal(ref.envFingerprint, OWN);
  // Candidate missing fingerprint: cannot be used in standard tier (same criterion as v2 missing fingerprint)
  const broken = table(3, [v3Layer([{ resultKey: rk(CK, OWN), envFingerprint: null, key: 'w' }])]);
  const b = layerRefOf(broken, 'clip-m1', { alive: new Set([rk(CK, OWN)]) });
  assert.ok(b === null || b === undefined, `A candidate missing its fingerprint should not be returned: ${JSON.stringify(b)}`);
});

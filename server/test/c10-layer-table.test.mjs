/**
 * C10 layer table and environment (`docs/plan/c10-contract.md` Section 5; semantics
 * `product/rendering.md` "results from different environments are not mixed").
 * Run: node --test server/test/c10-layer-table.test.mjs
 *
 *   C10-LT-01 Layer table carries content key of shared tier and fingerprint of producing
 *             environment; matching layer returns both (page uses them to find manifest);
 *   C10-LT-02 Layers missing content key or environment fingerprint (node code version mismatch)
 *             treated as "no prerender output": returns empty, does not throw;
 *   C10-LT-03 Malformed layer table (null, string, missing layers, corrupted items mixed into
 *             layers): returns empty, does not throw, valid layers work as usual;
 *   C10-LT-04 Layer absent in layer table: returns empty;
 *   C10-LT-05 Layer only takes one environment: when two fingerprints appear for same layer in layer
 *             table, only one is returned, same each time (or returns empty on mismatch);
 *   C10-LT-06 Page does not compute keys: module where layer table resides does not import
 *             `resultKeyOf`, `snapshotCode`, `cardCostKey` (distributed queue design Q1).
 *
 * Assumptions see K4 in `c10-kit.mjs`. Skip entire group when implementation is absent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { layerGate, layerEntry, layerTable, importRepo, repoPath } from './c10-kit.mjs';

const gate = layerGate();
const it = (name, fn) => test(name, { skip: gate.ok ? false : gate.reason }, fn);

async function refFn() {
  const mod = await importRepo(gate.file);
  return (table, clipId) => {
    const r = mod[gate.name](table, clipId);
    assert.ok(!(r instanceof Promise), `Assumption K4: ${gate.name} should be a synchronous pure function`);
    return r ?? null;
  };
}

const FP_A = 'env-a'.padEnd(64, 'a');
const FP_B = 'env-b'.padEnd(64, 'b');
const CK = (id) => `ck-${id}`.padEnd(64, '0');

it('C10-LT-01 a layer that matches returns the content key and the environment fingerprint', async () => {
  const ref = await refFn();
  const table = layerTable([layerEntry({ clipId: 'h1', contentKey: CK('h1'), envFingerprint: FP_A }), layerEntry({ clipId: 'h2', contentKey: CK('h2'), envFingerprint: FP_B })]);
  const r1 = ref(table, 'h1');
  assert.ok(r1, 'h1 is in the layer table');
  assert.equal(r1.contentKey, CK('h1'));
  assert.equal(r1.envFingerprint, FP_A);
  assert.equal(ref(table, 'h2').envFingerprint, FP_B);
});

it('C10-LT-02 a layer missing the content key or the environment fingerprint is treated as "no prerender output" and does not throw', async () => {
  const ref = await refFn();
  const noFp = layerEntry({ clipId: 'h1', contentKey: CK('h1'), envFingerprint: undefined });
  delete noFp.envFingerprint;
  const noCk = layerEntry({ clipId: 'h2', contentKey: undefined, envFingerprint: FP_A });
  delete noCk.contentKey;
  const table = layerTable([noFp, noCk, layerEntry({ clipId: 'h3', contentKey: '', envFingerprint: FP_A })]);
  for (const id of ['h1', 'h2', 'h3']) assert.equal(ref(table, id), null, `${id} does not match, should return empty`);
});

it('C10-LT-03 a broken layer table returns empty and does not throw; good layers next to a bad entry are handled as usual', async () => {
  const ref = await refFn();
  for (const bad of [null, undefined, 'x', 42, {}, { layers: 'x' }, { layers: [null, 3, 'y'] }, []]) {
    assert.equal(ref(bad, 'h1'), null, `Layer table ${JSON.stringify(bad)} should return empty`);
  }
  const mixed = layerTable([null, 7, { clipId: 5 }, layerEntry({ clipId: 'h1', contentKey: CK('h1'), envFingerprint: FP_A })]);
  assert.equal(ref(mixed, 'h1')?.envFingerprint, FP_A);
});

it('C10-LT-04 the layer is not in the layer table: returns empty', async () => {
  const ref = await refFn();
  assert.equal(ref(layerTable([layerEntry({ clipId: 'h1', contentKey: CK('h1'), envFingerprint: FP_A })]), 'nope'), null);
});

it('C10-LT-05 a layer takes only one environment: when the same layer shows two fingerprints, only one is returned, the same every time (or empty)', async () => {
  const ref = await refFn();
  const table = layerTable([
    layerEntry({ clipId: 'h1', contentKey: CK('h1'), envFingerprint: FP_A }),
    layerEntry({ clipId: 'h1', contentKey: CK('h1'), envFingerprint: FP_B }),
  ]);
  const a = ref(table, 'h1');
  const b = ref(table, 'h1');
  if (a === null) {
    assert.equal(b, null);
    return;
  }
  assert.equal(typeof a.envFingerprint, 'string');
  assert.ok([FP_A, FP_B].includes(a.envFingerprint));
  assert.equal(b.envFingerprint, a.envFingerprint, 'The same layer table returns the same environment every time');
  assert.ok(!Array.isArray(a.envFingerprints) || a.envFingerprints.length <= 1, 'Does not mix two environments');
});

it('C10-LT-06 the page does not compute keys: the module holding the layer table does not import resultKeyOf, snapshotCode, cardCostKey', () => {
  const src = fs.readFileSync(repoPath(gate.file), 'utf8');
  for (const name of ['resultKeyOf', 'snapshotCode', 'cardCostKey']) {
    assert.equal(new RegExp(`\\b${name}\\b`).test(src), false, `${name} appears in ${gate.file} (the page does not port key computation)`);
  }
});

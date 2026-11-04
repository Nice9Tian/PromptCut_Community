/**
 * How the page reads M7 layer table v 3 (`docs/plan/m7-contract.md` D12: each layer includes
 * candidates; when the page reads v 2 it is treated as a single candidate).
 * Run: node --test src/render/m7-layer-candidates.test.mjs
 *
 * Only handles parsing and compatibility; "which one is alive" is determined by the page node
 * branch based on task.done and the manifest, not here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseLayerMap, layerRefOf, usableLayer, layerCandidates } from "./snapshotSource.ts";

const layer = (over = {}) => ({ clipId: "a", kind: "html", key: "K-P", resultKey: "K-P", firstFrame: 0, count: 30, contentKey: "ck-a", envFingerprint: "fp-p", ...over });

test("M7-LC-01 v 3 is recognized: layer carries candidates, the primary candidate is the key on the layer", () => {
  const map = parseLayerMap({ v: 3, kind: "layer-map", projectId: "p", fps: 30, span: 60, layers: [
    layer({ candidates: [
      { envFingerprint: "fp-p", resultKey: "K-P", key: "K-P", dirKey: "K-P" },
      { envFingerprint: "fp-b", resultKey: "K-B", key: "K-B", dirKey: "K-B" },
      { envFingerprint: "", resultKey: "bad", key: "bad" },
      "junk",
    ] }),
  ] });
  assert.ok(map, "v 3 must not be treated as absent as a whole");
  assert.equal(map.v, 3);
  assert.equal(usableLayer(map, map.layers[0]), true);
  assert.deepEqual(layerCandidates(map.layers[0]), [
    { envFingerprint: "fp-p", resultKey: "K-P", key: "K-P" },
    { envFingerprint: "fp-b", resultKey: "K-B", key: "K-B" },
  ]);
  const ref = layerRefOf(map, "a");
  assert.equal(ref?.resultKey, "K-P");
  assert.equal(ref?.envFingerprint, "fp-p");
});

test("M7-LC-02 v 2 (no candidates) is treated as one candidate: the layer's own key and fingerprint", () => {
  const map = parseLayerMap({ v: 2, kind: "layer-map", projectId: "p", fps: 30, span: 60, layers: [layer()] });
  assert.deepEqual(layerCandidates(map.layers[0]), [{ envFingerprint: "fp-p", resultKey: "K-P", key: "K-P" }]);
});

test("M7-LC-03 A v 3 layer with no candidates written or all entries bad: likewise treated as one candidate; v 1 and layers missing a fingerprint have no candidates", () => {
  const map = parseLayerMap({ v: 3, kind: "layer-map", layers: [layer({ candidates: [] }), layer({ clipId: "b", candidates: [{ key: 1 }] })] });
  assert.deepEqual(layerCandidates(map.layers[0]), [{ envFingerprint: "fp-p", resultKey: "K-P", key: "K-P" }]);
  assert.deepEqual(layerCandidates(map.layers[1]), [{ envFingerprint: "fp-p", resultKey: "K-P", key: "K-P" }]);
  const v1 = parseLayerMap({ kind: "layer-map", layers: [{ clipId: "a", kind: "html", key: "K", resultKey: "R", firstFrame: 0, count: 10 }] });
  assert.deepEqual(layerCandidates(v1.layers[0]), []);
});

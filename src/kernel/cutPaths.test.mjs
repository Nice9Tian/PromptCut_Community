/**
 * Path and entity conversion when tracks move between active cut (/tracks) and parked cuts
 * (/cuts/@X/tracks). Run: node --test src/kernel/cutPaths.test.mjs
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { relocatePath, relocateOps, trackHome, undoEntity, undoEntityOfOp, undoEntitiesOf } = await import("./cutPaths.ts");
const { entityOfPath } = await import("./diffProject.ts");

const project = () => ({
  tracks: [{ id: "ta", clips: [] }],
  cuts: [{ id: "c1", name: "One" }, { id: "c2", name: "Two", tracks: [{ id: "tb", clips: [] }] }],
  activeCutId: "c1",
});

test("trackHome: null for the active one, the cut id for a parked one, undefined for a missing one", () => {
  const p = project();
  assert.equal(trackHome(p, "ta"), null);
  assert.equal(trackHome(p, "tb"), "c2");
  assert.equal(trackHome(p, "zz"), undefined);
});

test("relocatePath: a track under /tracks that now lives in a parked cut → rewritten; and the reverse too", () => {
  const p = project();
  assert.equal(relocatePath(p, "/tracks/@tb/clips/@cb/params/size"), "/cuts/@c2/tracks/@tb/clips/@cb/params/size");
  assert.equal(relocatePath(p, "/cuts/@c1/tracks/@ta/clips/@x"), "/tracks/@ta/clips/@x");
  assert.equal(relocatePath(p, "/cuts/@c9/tracks/@tb/name"), "/cuts/@c2/tracks/@tb/name", "A wrong cut id still resolves by the track's current home");
});

test("relocatePath: already in the right place, track really gone, points at the array itself, non-track path: all returned as is", () => {
  const p = project();
  for (const path of ["/tracks/@ta/clips/@x", "/cuts/@c2/tracks/@tb/clips/@y", "/tracks/@zz/clips/@x", "/tracks", "/cuts/@c2/tracks", "/name", "/cuts/@c2/name", "", "/media/@m"]) {
    assert.equal(relocatePath(p, path), path, path);
  }
  assert.equal(relocatePath({ tracks: [{ id: "ta" }] }, "/tracks/@ta/x"), "/tracks/@ta/x", "An old project without cuts");
});

test("relocateOps: converts entry by entry, does not modify the input, unchanged entries are the same object", () => {
  const p = project();
  const ops = [{ op: "set", path: "/tracks/@tb/clips/@cb/params/size", value: 3 }, { op: "set", path: "/name", value: "x" }];
  const out = relocateOps(p, ops);
  assert.equal(out[0].path, "/cuts/@c2/tracks/@tb/clips/@cb/params/size");
  assert.equal(out[1], ops[1]);
  assert.equal(ops[0].path, "/tracks/@tb/clips/@cb/params/size");
});

test("undoEntity: in the undo conflict convention, the entity of a track / clip does not depend on whether it lives under /tracks or /cuts/@X/tracks; entityOfPath in the spec is unchanged", () => {
  const path = "/cuts/@c2/tracks/@tb/clips/@cb/params/size";
  assert.equal(entityOfPath(path), "/cuts/@c2/tracks/@tb/clips/@cb", "The spec convention is unchanged (same page as the document service)");
  assert.equal(undoEntity(entityOfPath(path)), "/tracks/@tb/clips/@cb");
  assert.equal(undoEntity(entityOfPath("/tracks/@tb/clips/@cb/params/size")), "/tracks/@tb/clips/@cb");
  assert.equal(undoEntity(entityOfPath("/cuts/@c2/tracks/@tb/name")), "/tracks/@tb");
  assert.equal(undoEntity(entityOfPath("/cuts/@c2/name")), "/cuts/@c2", "A cut's own field is still the cut entity");
  assert.equal(undoEntity("/cuts/@c2/transitions/@x"), "/cuts/@c2/transitions/@x");
  assert.equal(undoEntityOfOp({ op: "insert", path: "/cuts/@c2/tracks", index: 0, value: { id: "tn" } }), "/tracks/@tn");
  assert.deepEqual(undoEntitiesOf([{ op: "remove", path: "/cuts/@c2/tracks/@tb" }, { op: "insert", path: "/tracks", index: 0, value: { id: "tb" } }]), ["/tracks/@tb"]);
});

/**
 * 序列在激活剪辑(/tracks)与停放剪辑(/cuts/@X/tracks)之间搬家时,路径与实体的换算。跑:node --test src/kernel/cutPaths.test.mjs
 */
import "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { relocatePath, relocateOps, trackHome, undoEntity, undoEntityOfOp, undoEntitiesOf } = await import("./cutPaths.ts");
const { entityOfPath } = await import("./diffProject.ts");

const project = () => ({
  tracks: [{ id: "ta", clips: [] }],
  cuts: [{ id: "c1", name: "一" }, { id: "c2", name: "二", tracks: [{ id: "tb", clips: [] }] }],
  activeCutId: "c1",
});

test("trackHome:激活的 null、停放的剪辑 id、没有的 undefined", () => {
  const p = project();
  assert.equal(trackHome(p, "ta"), null);
  assert.equal(trackHome(p, "tb"), "c2");
  assert.equal(trackHome(p, "zz"), undefined);
});

test("relocatePath:/tracks 下的序列现在在停放剪辑里 → 改写;反过来也是", () => {
  const p = project();
  assert.equal(relocatePath(p, "/tracks/@tb/clips/@cb/params/size"), "/cuts/@c2/tracks/@tb/clips/@cb/params/size");
  assert.equal(relocatePath(p, "/cuts/@c1/tracks/@ta/clips/@x"), "/tracks/@ta/clips/@x");
  assert.equal(relocatePath(p, "/cuts/@c9/tracks/@tb/name"), "/cuts/@c2/tracks/@tb/name", "剪辑 id 记错了也按序列现在的家");
});

test("relocatePath:已经在对的地方、序列真没了、指到数组本身、非序列路径,都原样", () => {
  const p = project();
  for (const path of ["/tracks/@ta/clips/@x", "/cuts/@c2/tracks/@tb/clips/@y", "/tracks/@zz/clips/@x", "/tracks", "/cuts/@c2/tracks", "/name", "/cuts/@c2/name", "", "/media/@m"]) {
    assert.equal(relocatePath(p, path), path, path);
  }
  assert.equal(relocatePath({ tracks: [{ id: "ta" }] }, "/tracks/@ta/x"), "/tracks/@ta/x", "没有 cuts 的老项目");
});

test("relocateOps:逐条换算,不改入参,没变的条目同一份对象", () => {
  const p = project();
  const ops = [{ op: "set", path: "/tracks/@tb/clips/@cb/params/size", value: 3 }, { op: "set", path: "/name", value: "x" }];
  const out = relocateOps(p, ops);
  assert.equal(out[0].path, "/cuts/@c2/tracks/@tb/clips/@cb/params/size");
  assert.equal(out[1], ops[1]);
  assert.equal(ops[0].path, "/tracks/@tb/clips/@cb/params/size");
});

test("undoEntity:撤销冲突口径里,序列 / 片段的实体不分它住在 /tracks 还是 /cuts/@X/tracks;规范里的 entityOfPath 不变", () => {
  const path = "/cuts/@c2/tracks/@tb/clips/@cb/params/size";
  assert.equal(entityOfPath(path), "/cuts/@c2/tracks/@tb/clips/@cb", "规范口径不动(文档服务同一页)");
  assert.equal(undoEntity(entityOfPath(path)), "/tracks/@tb/clips/@cb");
  assert.equal(undoEntity(entityOfPath("/tracks/@tb/clips/@cb/params/size")), "/tracks/@tb/clips/@cb");
  assert.equal(undoEntity(entityOfPath("/cuts/@c2/tracks/@tb/name")), "/tracks/@tb");
  assert.equal(undoEntity(entityOfPath("/cuts/@c2/name")), "/cuts/@c2", "剪辑自己的字段还是剪辑实体");
  assert.equal(undoEntity("/cuts/@c2/transitions/@x"), "/cuts/@c2/transitions/@x");
  assert.equal(undoEntityOfOp({ op: "insert", path: "/cuts/@c2/tracks", index: 0, value: { id: "tn" } }), "/tracks/@tn");
  assert.deepEqual(undoEntitiesOf([{ op: "remove", path: "/cuts/@c2/tracks/@tb" }, { op: "insert", path: "/tracks", index: 0, value: { id: "tb" } }]), ["/tracks/@tb"]);
});

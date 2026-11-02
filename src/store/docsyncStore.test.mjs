/**
 * docsync 接进编辑器 store(core.ts 的挂钩)。跑:node --test src/store/docsyncStore.test.mjs
 *
 * 钉的是:没连文档服务时一切照旧(快照栈);连上时 setProject / loadProject / undo / redo /
 * canUndo / canRedo 由 docsync 接管,接口不变;别人的改动写进 state 但不进撤销栈。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { MemDocService } from "../testing/memDocService.mjs";

const { actions, getState } = await import(srcUrl("store/project.ts"));
const core = await import(srcUrl("store/core.ts"));
const { DocSync, bindStore } = await import(srcUrl("store/docsync.ts"));

function fresh(name = "起点") {
  actions.newProject(name);
  return getState().project;
}

test("snapshot stack mode: behavior unchanged, canUndo / canRedo reflect history / future", () => {
  fresh();
  assert.equal(actions.canUndo(), false);
  actions.setProjectMeta({ name: "edit 1" });
  actions.setProjectMeta({ name: "edit 2" });
  assert.equal(core.history.length, 2);
  actions.undo();
  assert.equal(getState().project.name, "edit 1");
  assert.equal(actions.canRedo(), true);
  actions.redo();
  assert.equal(getState().project.name, "edit 2");
});

test("V5-snapshot stack mode: consecutive edits with the same mergeKey within 300 ms merge into one step, and do not merge if another edit comes in between", () => {
  const p0 = fresh();
  for (let i = 0; i < 4; i++) core.setProject({ ...getState().project, width: 100 + i }, { mergeKey: "w" });
  assert.equal(core.history.length, 1);
  actions.undo();
  assert.equal(getState().project, p0);
  fresh();
  core.setProject({ ...getState().project, width: 1 }, { mergeKey: "w" });
  actions.setProjectMeta({ name: "别的" });
  core.setProject({ ...getState().project, width: 2 }, { mergeKey: "w" });
  assert.equal(core.history.length, 3);
  // 不传 mergeKey 与以前完全一样:每次一步
  fresh();
  core.setProject({ ...getState().project, width: 1 });
  core.setProject({ ...getState().project, width: 2 });
  assert.equal(core.history.length, 2);
});

test("Connected to the document service: setProject goes through docsync, undo is per page session, other people's changes are written to state and not pushed onto the undo stack; after unbinding, falls back to the snapshot stack", () => {
  const p0 = fresh("共享");
  const svc = new MemDocService({ project: structuredClone(p0), rev: 3 });
  let linkA;
  const A = new DocSync(p0, { projectId: "P", session: "A", send: (m) => linkA.send(m) });
  linkA = svc.connect("A", (m) => A.receive(m));
  const unbind = bindStore(A);
  A.connect();
  let linkB;
  const B = new DocSync(structuredClone(p0), { projectId: "P", session: "B", send: (m) => linkB.send(m) });
  linkB = svc.connect("B", (m) => B.receive(m));
  B.connect();
  svc.drain();

  const historyBefore = core.history.length;
  actions.setProjectMeta({ name: "Edited by A" });
  assert.equal(getState().project.name, "Edited by A");
  assert.equal(getState().project, A.project);
  assert.equal(core.history.length, historyBefore); // 快照栈不动
  assert.equal(actions.canUndo(), true);
  svc.drain();
  assert.equal(svc.project.name, "Edited by A");
  assert.equal(B.project.name, "Edited by A");

  // B 改了(序列名,另一个实体),A 的 state 跟着变,但 A 的撤销栈里没有它
  B.commit({ ...B.project, tracks: B.project.tracks.map((t, i) => (i === 0 ? { ...t, name: "Track edited by B" } : t)) });
  svc.drain();
  assert.equal(getState().project.tracks[0].name, "Track edited by B");
  assert.equal(getState().dirty, true);
  actions.undo();
  assert.equal(getState().project.name, "共享");
  assert.equal(getState().project.tracks[0].name, "Track edited by B");
  assert.equal(actions.canUndo(), false);
  assert.equal(actions.canRedo(), true);
  actions.redo();
  assert.equal(getState().project.name, "Edited by A");
  svc.drain();
  assert.equal(JSON.stringify(getState().project), JSON.stringify(svc.project));
  assert.equal(JSON.stringify(B.project), JSON.stringify(svc.project));

  // loadProject 是一次根替换
  const other = { ...structuredClone(svc.project), name: "Old file that was opened" };
  actions.loadProject(other);
  assert.equal(actions.canUndo(), false);
  svc.drain();
  assert.equal(svc.log[svc.log.length - 1].ops[0].path, "");
  assert.equal(B.project.name, "Old file that was opened");

  unbind();
  actions.setProjectMeta({ name: "After unbinding" });
  assert.equal(core.history.length, 1);
  assert.equal(A.unconfirmed, 0);
});

test("AI panel \"Undo this step\" (revertRemote) undoes the track the Agent added: the project in the store is swapped on the spot for the post-undo copy, without waiting for the next edit", () => {
  const p0 = fresh("Undo this step");
  const svc = new MemDocService({ project: structuredClone(p0), rev: 1 });
  let linkA;
  const A = new DocSync(p0, { projectId: "P", session: "A", send: (m) => linkA.send(m) });
  linkA = svc.connect("A", (m) => A.receive(m));
  const unbind = bindStore(A);
  A.connect();
  let linkG;
  const G = new DocSync(structuredClone(p0), { projectId: "P", session: "agent-1", send: (m) => linkG.send(m) });
  linkG = svc.connect("agent-1", (m) => G.receive(m));
  G.connect();
  svc.drain();

  // Agent 加了一条轨道
  G.commit({ ...G.project, tracks: [...G.project.tracks, { id: "tAgent", name: "Agent's track", clips: [] }] });
  svc.drain();
  const agentOp = svc.log[svc.log.length - 1].opId;
  assert.ok(getState().project.tracks.some((t) => t.id === "tAgent"), "The page received the track the Agent added");
  const before = getState().project;

  const r = A.revertRemote({ opId: agentOp });
  assert.equal(r.done, true);
  // 修前:DocSync 本地副本已撤,store 还停在撤之前(bindStore 把这次当成 setProject 的 commit 跳过了)
  assert.equal(getState().project, A.project, "The store holds the post-undo copy from DocSync");
  assert.notEqual(getState().project, before, "Replaced with a new object, not modified in place");
  assert.ok(!getState().project.tracks.some((t) => t.id === "tAgent"), "The track disappears from the store on the spot");
  assert.ok(before.tracks.some((t) => t.id === "tAgent"), "The object from before the undo was not modified in place");
  assert.equal(getState().dirty, true);
  // 进了页面自己的撤销栈:Ctrl+Z 把 Agent 的轨道恢复回来,store 同样当场跟上
  assert.equal(actions.canUndo(), true);
  actions.undo();
  assert.ok(getState().project.tracks.some((t) => t.id === "tAgent"));
  svc.drain();
  assert.equal(JSON.stringify(getState().project), JSON.stringify(svc.project));
  unbind();
});

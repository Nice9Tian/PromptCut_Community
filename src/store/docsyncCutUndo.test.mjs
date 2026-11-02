/**
 * 「撤销这步」撤 Agent 在停放剪辑里改过的片段(线上 2026-10-21,项目 验收018-复验2):Agent 做了
 * switch_cut→剪辑2 → update_clip → switch_cut→剪辑1,之后点操作卡上的「撤销这步」毫无反应。
 * 跑:node --experimental-test-module-mocks --test src/store/docsyncCutUndo.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { MemDocService } from "../testing/memDocService.mjs";

const { DocSync } = await import(srcUrl("store/docsync.ts"));
const { switchCut } = await import(srcUrl("kernel/cuts.ts"));

function page(svc, session, initial) {
  const notices = [];
  let link = null;
  const ds = new DocSync(initial, { projectId: "P", session, send: (m) => link?.send(m) });
  ds.on("notice", (n) => notices.push(n));
  link = svc.connect(session, (msg) => ds.receive(msg));
  ds.connect();
  return { ds, notices };
}

const base = () => ({
  version: 1, id: "p", name: "p", width: 1920, height: 1080, fps: 30, duration: 10, themeId: "midnight", media: [],
  tracks: [{ id: "ta", name: "Track 1", clips: [{ id: "ca", cardId: "title", start: 0, end: 4, params: { size: 1 } }] }],
  cuts: [
    { id: "cut1", name: "Cut 1" },
    { id: "cut2", name: "Cut 2", duration: 6, transitions: [], tracks: [{ id: "tb", name: "Track B", clips: [{ id: "cb", cardId: "title", start: 0, end: 6, params: { size: 3, color: "#fff" } }] }] },
  ],
  activeCutId: "cut1",
});
const setSize = (p, id, size) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, params: { ...c.params, size } } : c)) })) });
const sizeIn = (p, cutId, id) => {
  const tracks = p.activeCutId === cutId ? p.tracks : p.cuts.find((c) => c.id === cutId).tracks;
  return tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.params.size;
};
const lastOp = (svc) => svc.log[svc.log.length - 1];

function setup() {
  const svc = new MemDocService({ project: base(), rev: 1 });
  const A = page(svc, "A", base());
  const G = page(svc, "agent-1", base());
  svc.drain();
  return { svc, A, G };
}

/** Agent 的老做法:切过去、改、切回来,三次提交 */
function agentSwitchEditSwitch(svc, G) {
  const ops = [];
  const commit = (p) => { G.ds.commit(p); svc.drain(); ops.push(lastOp(svc).opId); };
  commit(switchCut(G.ds.project, "cut2", 0).project);
  commit(setSize(G.ds.project, "cb", 5));
  commit(switchCut(G.ds.project, "cut1", 0).project);
  return ops;
}

test("repro: after switch_cut→edit→switch_cut, undoing that edit should succeed and not switch the active cut", () => {
  const { svc, A, G } = setup();
  const [, editOp] = agentSwitchEditSwitch(svc, G);
  assert.equal(A.ds.project.activeCutId, "cut1");
  assert.equal(sizeIn(A.ds.project, "cut2", "cb"), 5);
  const r = A.ds.revertRemote({ opId: editOp });
  assert.deepEqual([r.done, r.failed, r.skipped], [true, [], []], JSON.stringify(r));
  svc.drain();
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 3, "undone back to 3");
  assert.equal(svc.project.activeCutId, "cut1", "the active cut was not switched");
  assert.equal(sizeIn(svc.project, "cut1", "ca"), 1, "the active cut was untouched");
});

/** 不切换、直接改停放剪辑里的片段(另一条分支的做法:路径在 /cuts/@cut2/tracks 下) */
const setSizeParked = (p, cutId, id, size) => ({
  ...p,
  cuts: p.cuts.map((c) => (c.id !== cutId ? c : { ...c, tracks: c.tracks.map((t) => ({ ...t, clips: t.clips.map((cl) => (cl.id === id ? { ...cl, params: { ...cl.params, size } } : cl)) })) })),
});

test("after undo, Ctrl+Z (redoing that edit) is also unaffected by cut switching", () => {
  const { svc, A, G } = setup();
  const [, editOp] = agentSwitchEditSwitch(svc, G);
  assert.equal(A.ds.revertRemote({ opId: editOp }).done, true);
  svc.drain();
  // 页面撤销栈里的这一步是「撤销这步」本身;撤回它 = 把 Agent 的改动恢复
  assert.equal(A.ds.canUndo(), true);
  A.ds.undo();
  svc.drain();
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 5);
  assert.equal(svc.project.activeCutId, "cut1");
});

test("Reverse direction: the Agent edited in place inside a parked cut (path under /cuts/@cut2), then cut2 was activated, and undo still works", () => {
  const { svc, A, G } = setup();
  G.ds.commit(setSizeParked(G.ds.project, "cut2", "cb", 5));
  svc.drain();
  const editOp = lastOp(svc).opId;
  // 用户点标签把 cut2 切成激活
  A.ds.commit(switchCut(A.ds.project, "cut2", 0).project);
  svc.drain();
  assert.equal(svc.project.activeCutId, "cut2");
  const r = A.ds.revertRemote({ opId: editOp });
  assert.deepEqual([r.done, r.failed, r.skipped], [true, [], []], JSON.stringify(r));
  svc.drain();
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 3);
  assert.equal(svc.project.activeCutId, "cut2", "the active cut was not switched");
});

test("own undo works the same way: after editing a clip while cut2 was active and someone else switched the active cut away, Ctrl+Z can still undo it", () => {
  const { svc, A, G } = setup();
  A.ds.commit(switchCut(A.ds.project, "cut2", 0).project);
  svc.drain();
  A.ds.commit(setSize(A.ds.project, "cb", 9));
  svc.drain();
  G.ds.commit(switchCut(G.ds.project, "cut1", 0).project);
  svc.drain();
  assert.equal(svc.project.activeCutId, "cut1");
  assert.equal(A.ds.canUndo(), true);
  A.ds.undo();
  svc.drain();
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 3, "undone back to 3");
  assert.equal(svc.project.activeCutId, "cut1");
});

test("a real conflict is still handled by the undo rules: if someone else later edited the same clip (whether or not that cut was active at the time), do not undo and report who made the edit", () => {
  const { svc, A, G } = setup();
  const [, editOp] = agentSwitchEditSwitch(svc, G);
  // 用户 A 在 cut2 停放时直接改了同一个片段(路径在 /cuts/@cut2 下)
  A.ds.commit(setSizeParked(A.ds.project, "cut2", "cb", 8));
  svc.drain();
  const r = A.ds.revertRemote({ opId: editOp });
  assert.equal(r.done, false);
  assert.deepEqual(r.skipped.map((s) => s.entity), ["/tracks/@tb/clips/@cb"], "the entity does not depend on where it lived at the time");
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 8, "the current state is kept");
  assert.ok(A.notices.some((n) => n.kind === "revert-remote" && n.result.skipped.length === 1), "there is a notice (undo notice bar)");
});

test("real conflict: someone else later switched to cut2, edited the same clip, and switched back", () => {
  const { svc, A, G } = setup();
  const [, editOp] = agentSwitchEditSwitch(svc, G);
  A.ds.commit(switchCut(A.ds.project, "cut2", 0).project);
  svc.drain();
  A.ds.commit(setSize(A.ds.project, "cb", 8));
  svc.drain();
  A.ds.commit(switchCut(A.ds.project, "cut1", 0).project);
  svc.drain();
  const r = A.ds.revertRemote({ opId: editOp });
  assert.equal(r.done, false);
  assert.deepEqual(r.skipped.map((s) => s.entity), ["/tracks/@tb/clips/@cb"]);
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 8);
});

test("other clips edited later do not block undoing this step", () => {
  const { svc, A, G } = setup();
  const [, editOp] = agentSwitchEditSwitch(svc, G);
  A.ds.commit(setSize(A.ds.project, "ca", 2)); // 激活剪辑 cut1 里另一个片段
  svc.drain();
  const r = A.ds.revertRemote({ opId: editOp });
  assert.deepEqual([r.done, r.skipped, r.failed], [true, [], []]);
  svc.drain();
  assert.equal(sizeIn(svc.project, "cut2", "cb"), 3);
  assert.equal(sizeIn(svc.project, "cut1", "ca"), 2, "edits elsewhere are kept");
});

test("the track was really deleted: undo fails and goes to failed (the notice bar says it cannot be reverted), not silent", () => {
  const { svc, A, G } = setup();
  const [, editOp] = agentSwitchEditSwitch(svc, G);
  const gone = { ...A.ds.project, cuts: A.ds.project.cuts.map((c) => (c.id === "cut2" ? { ...c, tracks: [] } : c)) };
  A.ds.commit(gone);
  svc.drain();
  const r = A.ds.revertRemote({ opId: editOp });
  assert.equal(r.done, false);
  assert.ok(r.failed.length + r.skipped.length > 0, JSON.stringify(r));
});

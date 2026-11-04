/**
 * Clicking undo button encounters conflict → "Conflict merge" dialog (0.7.20 connects to opening
 * left by 0.7.19). Run: node --test src/editor/sync/undoConflict.test.mjs
 *
 * UC-01 Undo subdivided by modified item: properties untouched by others in the same clip undone
 *       directly (do not enter undo stack), properties modified by others enter pending merge
 *       table (source undo), dialog displays "landed → after undo (cloud is currently ...)";
 *       clicking "Merge" writes back value after undo (safety arguments 2, 4)
 * UC-02 No conflict: undo directly as before, provide no dialog material
 * UC-03 AI panel "Undo this step" (undoing that Agent step) encounters conflict: likewise provides
 *       material and subdivides
 * UC-04 Undo triggered by password change exit reaches page: merely a remote modification, generates
 *       no undo notice, does not enter dialog (two paths not mixed, safety argument 4);
 *       bubble text is "<username> revoked content" (safety argument 5)
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { MemDocService } from "../../testing/memDocService.mjs";

const { DocSync } = await import(srcUrl("store/docsync.ts"));
const { undoConflictPlan } = await import(srcUrl("editor/sync/undoConflict.ts"));
const { mergeRows, applyMerge } = await import(srcUrl("editor/sync/mergeItems.ts"));
const { rolledBackText } = await import(srcUrl("editor/sync/labels.ts"));

function project() {
  return {
    version: 1, id: "p", name: "p", width: 1920, height: 1080, fps: 30, duration: 30, themeId: "midnight", media: [],
    tracks: [{ id: "t1", name: "Track 1", clips: [
      { id: "c1", cardId: "title", start: 0, end: 2, opacity: 0.4, label: "One", params: { text: "One" } },
      { id: "c2", cardId: "title", start: 3, end: 5, opacity: 1, label: "Two", params: { text: "Two" } },
    ] }],
  };
}
function page(svc, session) {
  const notices = [];
  let link = null;
  const ds = new DocSync(project(), { projectId: "P", session, send: (msg) => link?.send(msg), saveBackup: () => {} });
  ds.on("notice", (n) => notices.push(n));
  link = svc.connect(session, (msg) => ds.receive(msg));
  ds.connect();
  return { ds, notices };
}
const edit = (p, id, patch) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) })) });
const clip = (p, id) => p.tracks[0].clips.find((c) => c.id === id);
const meta = { batch: "u1", baseRev: 0, at: 1 };

test("UC-01 Undo is broken down per changed item: items nobody else changed are undone directly, and changed ones go into the dialog; the merge writes the value after the undo", () => {
  const svc = new MemDocService({ project: project(), rev: 1 });
  const A = page(svc, "A"), B = page(svc, "B");
  svc.drain();
  A.ds.commit(edit(A.ds.project, "c1", { opacity: 0.8, end: 3 }));
  svc.drain();
  B.ds.commit(edit(B.ds.project, "c1", { opacity: 0.6 }));
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, false, "DocSync blocks per entity: c1 was not undone at all");
  assert.ok(res.conflict, "Provided the material the dialog needs");
  const plan = undoConflictPlan(A.ds.project, res.conflict, meta);
  assert.equal(plan.directCount, 1);
  assert.equal(clip(plan.direct, "c1").end, 2, "Nobody changed the length again: undone directly");
  assert.equal(clip(plan.direct, "c1").opacity, 0.6, "Opacity was changed by someone else: left alone, goes into the dialog");
  assert.deepEqual(plan.things.map((t) => [t.key, t.source, t.props.map((p) => p.prop)]), [["undo:clip:c1", "undo", ["opacity"]]]);
  A.ds.commitAside(plan.direct);
  svc.drain();
  assert.equal(clip(B.ds.project, "c1").end, 2);
  assert.equal(A.ds.canUndo(), false, "The directly undone part is part of this undo and does not enter the undo stack separately");
  const rows = mergeRows(A.ds.project, plan.things);
  assert.equal(rows[0].props[0].text, "Opacity 0.8 → 0.4 (The cloud is now 0.6)");
  assert.equal(rows[0].conflict, true);
  // User checks item in dialog and clicks "Merge": write according to value after undo
  const merged = applyMerge(A.ds.project, plan.things, new Map([["undo:clip:c1", new Set(["opacity"])]]));
  assert.equal(clip(merged.project, "c1").opacity, 0.4);
});

test("UC-02 No conflict: undo directly, give the dialog no material", () => {
  const svc = new MemDocService({ project: project(), rev: 1 });
  const A = page(svc, "A"), B = page(svc, "B");
  svc.drain();
  A.ds.commit(edit(A.ds.project, "c1", { opacity: 0.8 }));
  svc.drain();
  B.ds.commit(edit(B.ds.project, "c2", { opacity: 0.2 }));
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, true); assert.deepEqual(res.skipped, []); assert.equal(res.conflict, undefined);
  svc.drain();
  assert.equal(clip(B.ds.project, "c1").opacity, 0.4);
});

test("UC-03 When \"Undo this step\" in the AI panel hits a conflict: provide the same material and break it down the same way", () => {
  const svc = new MemDocService({ project: project(), rev: 1 });
  const A = page(svc, "A"), Agent = page(svc, "agent");
  svc.drain();
  Agent.ds.commit(edit(Agent.ds.project, "c2", { label: "Edited by Agent", opacity: 0.5 }));
  svc.drain();
  const opId = svc.log[svc.log.length - 1].opId;
  A.ds.commit(edit(A.ds.project, "c2", { opacity: 0.9 }));
  svc.drain();
  const res = A.ds.revertRemote({ opId });
  assert.ok(res.conflict);
  const plan = undoConflictPlan(A.ds.project, res.conflict, meta);
  assert.equal(clip(plan.direct, "c2").label, "Two", "Nobody changed the name again: undone directly");
  assert.deepEqual(plan.things.map((t) => t.props.map((p) => p.prop)), [["opacity"]], "Opacity was changed later on this page of mine: goes into the dialog");
});

test("UC-04 A rollback triggered by sign-out after a password change reaches the page: it is just a remote edit, producing no undo notice and giving the dialog no material; the bubble text", () => {
  const svc = new MemDocService({ project: project(), rev: 1 });
  const A = page(svc, "A");
  svc.drain();
  const before = A.notices.length;
  A.ds.receive({ type: "project.ops", projectId: "P", rev: A.ds.rev + 1, opId: "logout-rollback:pw_1:1",
    ops: [{ op: "set", path: "/tracks/@t1/clips/@c1/opacity", value: 0.1 }],
    actor: { userId: "acc_x", role: "system", accountId: "acc_x", rollbackEventId: "pw_1", session: null }, at: 1 });
  assert.equal(clip(A.ds.project, "c1").opacity, 0.1);
  const kinds = A.notices.slice(before).map((n) => n.kind);
  assert.deepEqual(kinds, ["remote"]);
  assert.equal(rolledBackText("Xiao Wang"), "Xiao Wang undid content");
  assert.equal(rolledBackText(null), "A member undid content");
});

/**
 * Parts of the read-only UI (`readOnly.ts` family) that do not depend on React: the check itself,
 * shortcut gate, drag-and-drop payload, and total duration auto-alignment. How components render:
 * see `readOnlyRender.test.mjs`; full-page behavior in a real browser: see
 * `scripts/probes/guest-readonly-ui-probe.mjs`.
 *
 * Run: node --test src/editor/readOnly.test.mjs
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const vo = await import("./io/viewOnly.ts");
const core = await import("./readOnlyCore.ts");
const keys = await import("./readOnlyKeys.ts");

/** Fake location: the `?observe=1` path has no page URL in Node, simulated using this */
function withLocation(search, fn) {
  const had = Object.hasOwn(globalThis, "location");
  const prev = globalThis.location;
  globalThis.location = { search };
  try { return fn(); } finally { if (had) globalThis.location = prev; else delete globalThis.location; }
}
const reset = () => vo.setProjectAccess(null);

test("RO1 A project with read-only access is locked; read-write access and not being in a project are not locked; leaving the project unlocks it", () => {
  reset();
  assert.equal(core.memberReadOnlyNow(), false, "Not in a shared project (local project): unchanged");
  vo.setProjectAccess("rw");
  assert.equal(core.memberReadOnlyNow(), false, "Read-write access is not locked");
  vo.setProjectAccess("r");
  assert.equal(core.memberReadOnlyNow(), true);
  assert.equal(core.blockedByReadOnly(), true);
  vo.setProjectAccess(null);
  assert.equal(core.memberReadOnlyNow(), false, "After leaving a project, read-only is not carried into the next project");
});

test("RO2 The old ?observe=1 path is not merged in: it does not count as \"this project was granted read-only access only\"", () => {
  reset();
  withLocation("?observe=1", () => {
    assert.equal(vo.isViewOnly(), true, "observe is still read-only (save / delete draft / sound generation already honored it)");
    assert.equal(vo.viewOnlyReason(), "observe");
    assert.equal(core.memberReadOnlyNow(), false, "The newly added UI lock does not cover it: it behaves as before");
    assert.equal(core.readOnlyState(core.memberReadOnlyNow()).locked, false);
  });
  // Both sources present: permissions take precedence (guest opened a URL with observe)
  withLocation("?observe=1", () => {
    vo.setProjectAccess("r");
    assert.equal(vo.viewOnlyReason(), "read-only-member");
    assert.equal(core.memberReadOnlyNow(), true);
  });
  reset();
});

test("RO3 The grayed-out explanation is always viewOnlyText(); when not locked, the original hover text is left alone", () => {
  reset();
  const off = core.readOnlyState(false);
  assert.equal(off.locked, false);
  assert.equal(off.why, "");
  assert.equal(off.title("Original description"), "Original description");
  assert.equal(off.title(), undefined);
  vo.setProjectAccess("r");
  const on = core.readOnlyState(core.memberReadOnlyNow());
  assert.equal(on.locked, true);
  assert.equal(on.why, vo.viewOnlyText());
  assert.match(on.why, /You can only view this project/);
  assert.equal(on.title("Original description"), vo.viewOnlyText(), "When locked it is exactly that one sentence, not something the control made up itself");
  assert.equal(on.title(), vo.viewOnlyText());
  reset();
});

test("RO4 Shortcut gate: when read-only, Delete / Backspace / undo / redo do not reach the editor; the space key and keys typed in input boxes are not blocked", () => {
  const press = (init) => ({ key: "", ctrlKey: false, metaKey: false, shiftKey: false, target: { tagName: "DIV" }, ...init });
  // Pure check: which keys are "project modification keys" (without checking locks)
  assert.equal(keys.isProjectEditKey(press({ key: "Delete" })), true);
  assert.equal(keys.isProjectEditKey(press({ key: "Backspace" })), true);
  assert.equal(keys.isProjectEditKey(press({ key: "z", ctrlKey: true })), true);
  assert.equal(keys.isProjectEditKey(press({ key: "Z", ctrlKey: true, shiftKey: true })), true);
  assert.equal(keys.isProjectEditKey(press({ key: "y", metaKey: true })), true);
  assert.equal(keys.isProjectEditKey(press({ key: " " })), false, "Space is play / pause, and it must work when read-only too");
  assert.equal(keys.isProjectEditKey(press({ key: "ArrowLeft" })), false);
  assert.equal(keys.isProjectEditKey(press({ key: "Delete", target: { tagName: "INPUT" } })), false, "The delete key in an input box belongs to the input box");
  assert.equal(keys.isProjectEditKey(press({ key: "z", ctrlKey: true, target: { tagName: "TEXTAREA" } })), false);

  // Attached to a fake window: preventDefault + stopImmediatePropagation when read-only, does nothing
  // when unlocked
  const handlers = [];
  const fakeWindow = { addEventListener: (type, fn, opts) => handlers.push({ type, fn, opts }) };
  keys.installReadOnlyKeyGuard(fakeWindow);
  keys.installReadOnlyKeyGuard(fakeWindow);
  assert.equal(handlers.length, 1, "Idempotent: installing twice attaches only one copy");
  assert.equal(handlers[0].type, "keydown");
  assert.equal(handlers[0].opts.capture, true, "Capture phase: runs ahead of the editor's bubble-phase listeners");
  const fire = (init) => {
    const log = { prevented: false, stopped: false };
    handlers[0].fn({ ...press(init), preventDefault: () => { log.prevented = true; }, stopImmediatePropagation: () => { log.stopped = true; } });
    return log;
  };
  reset();
  assert.deepEqual(fire({ key: "Delete" }), { prevented: false, stopped: false }, "Not locked: not blocked");
  vo.setProjectAccess("r");
  assert.deepEqual(fire({ key: "Delete" }), { prevented: true, stopped: true });
  assert.deepEqual(fire({ key: "z", ctrlKey: true }), { prevented: true, stopped: true });
  assert.deepEqual(fire({ key: " " }), { prevented: false, stopped: false }, "Playback also works when read-only");
  assert.deepEqual(fire({ key: "Delete", target: { tagName: "INPUT" } }), { prevented: false, stopped: false });
  reset();
});

test("RO5 Drag-and-drop payload: not recorded when read-only, so the timeline does not show the drop target preview or the \"New track\" drop zone", async () => {
  const added = [];
  globalThis.window = { addEventListener: (type) => added.push(type) };
  const dnd = await import("./dnd.ts");
  const payload = { kind: "card", cardId: "x", name: "x", duration: 2 };
  reset();
  dnd.clearDragPayload();
  dnd.setDragPayload(payload);
  assert.deepEqual(dnd.getDragPayload(), payload, "Read-write: recorded as usual");
  dnd.clearDragPayload();
  vo.setProjectAccess("r");
  dnd.setDragPayload(payload);
  assert.equal(dnd.getDragPayload(), null, "Read-only: not recorded");
  reset();
  delete globalThis.window;
});

test("RO6 Automatic total-duration alignment is a write: not done in a read-only project (read-write unchanged)", async () => {
  const stateCore = await import(srcUrl("store/core.ts"));
  const { actions, getState } = await import(srcUrl("store/project.ts"));
  const D = await import(srcUrl("editor/timeline/durationSync.ts"));
  const clip = (id, start, end) => ({ id, cardId: "", start, end, params: {} });
  const load = () => {
    actions.newProject("Duration");
    const p = getState().project;
    // Content ends at 4s, but total duration recorded in project is 10s: aligning will change it to 4
    stateCore.setProject({ ...p, tracks: [{ ...p.tracks[0], clips: [clip("a", 0, 2), clip("b", 2, 4)] }], duration: 10 }, { undoable: false });
    stateCore.set({ durationManual: null });
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  reset();
  load();
  const stopRw = D.mountDurationSync();
  await settle();
  assert.equal(getState().project.duration, 4, "Read-write: aligned to the end of the content");
  stopRw();

  vo.setProjectAccess("r");
  load();
  const stopRo = D.mountDurationSync();
  await settle();
  assert.equal(getState().project.duration, 10, "Read-only: does not change the total duration in the project");
  stopRo();
  reset();
  D.resetDurationSync();
});

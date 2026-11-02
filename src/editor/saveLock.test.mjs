/**
 * Pause foreground editing while saving (`docs/semantics/mechanism/document-service.md`
 * "Save baseline and modification state check": "Save temporarily disables foreground editing while
 * waiting for this machine to finish writing; failures do not overwrite the last valid save, and
 * restore editing").
 * Run: node --experimental-test-module-mocks --test src/editor/saveLock.test.mjs
 *
 * Pin down: from picking a drop target until save completes (success, timeout, write failure),
 * keyboard shortcuts, drag-and-drop, mouse, and Agent panel inputs do not reach the editor's own
 * handlers, and the project cannot be modified; restored as soon as save ends (regardless of
 * success or failure). Clicking Cancel in "Save as" does not lock.
 *
 * No DOM in node: use an EventTarget as window. For interception in real pages, see probe
 * `scripts/probes/save-state-probe.mjs`.
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

// Editor input listeners are all attached to window; interception must be attached first upon
// module load, so window must exist first
globalThis.window = new EventTarget();

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { saveProcFile, savePackedFile } = await import(srcUrl("editor/io/saveFlow.ts"));
const { undoRedoKey } = await import(srcUrl("editor/undoKeys.ts"));

/**
 * Mock input handlers attached across the editor: shortcut undo, drag-and-drop import media, mouse
 * clip edits, Enter to send in the Agent panel
 */
const agentSent = [];
window.addEventListener("keydown", (e) => {
  const op = undoRedoKey(e);
  if (op === "undo") actions.undo();
  if (e.key === "Delete") actions.setProjectMeta({ name: "Changed by Delete" });
  if (e.key === "Enter" && e.pcTarget === "agent-input") agentSent.push("Help me change the title to X");
});
window.addEventListener("drop", () => {
  actions.addMedia({ kind: "image", name: "拖进来的.png", url: "" });
});
window.addEventListener("pointerdown", () => {
  actions.setProjectMeta({ name: "Changed by mouse" });
});
window.addEventListener("paste", () => {
  actions.setProjectMeta({ name: "Changed by paste" });
});
// "Undo" from the desktop app title bar menu (TopBar receives this event)
window.addEventListener("pc-titlebar-command", (e) => {
  if (e.detail === "undo") actions.undo();
});

function fire(type, props = {}) {
  const e = new Event(type, { cancelable: true });
  // Event target is read-only and populated by dispatch: in tests, "where focus is" is placed
  // separately on pcTarget
  Object.assign(e, { ctrlKey: false, metaKey: false, shiftKey: false, key: "" }, props);
  window.dispatchEvent(e);
  return e;
}

/** A save stopped at the "write to disk" step: returns the release function */
function heldDeps(overrides = {}) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const written = [];
  const notes = [];
  const deps = {
    writeProc: async (produce, fileName) => {
      const text = await produce();
      await gate;
      written.push({ fileName, text });
      return { kind: "saved", where: fileName };
    },
    settle: async () => {},
    serialize: () => JSON.stringify({ name: getState().project.name }),
    saveDraft: async () => {},
    markSaved: () => {},
    notify: (m) => notes.push(m),
    ...overrides,
  };
  return { deps, release: () => release(), written, notes };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function startProject() {
  actions.newProject("Starting point");
  actions.setProjectMeta({ name: "Changed once" });
  agentSent.length = 0;
}

test("While saving is in progress: the undo shortcut, Delete, drag-and-drop, mouse, paste and Enter in the Agent panel cannot change the project", async () => {
  startProject();
  const mediaBefore = getState().project.media.length;
  const projectBefore = getState().project;
  const h = heldDeps();
  const saving = saveProcFile("a.proc", h.deps);
  await tick();
  try {
    fire("keydown", { key: "z", ctrlKey: true });
    fire("keydown", { key: "Delete" });
    fire("drop");
    fire("pointerdown");
    fire("paste");
    fire("keydown", { key: "Enter", pcTarget: "agent-input" });
    fire("pc-titlebar-command", { detail: "undo" });

    assert.equal(getState().project, projectBefore, "The project object was not replaced even once during saving");
    assert.equal(getState().project.name, "Changed once");
    assert.equal(getState().project.media.length, mediaBefore);
    assert.deepEqual(agentSent, [], "The Agent panel sent nothing");
  } finally {
    h.release();
  }
  assert.equal(await saving, "saved");
  assert.equal(JSON.parse(h.written[0].text).name, "Changed once");
});

test("Blocked input events had their default action canceled (the browser will no longer type, paste or drop files)", async () => {
  startProject();
  const h = heldDeps();
  const saving = saveProcFile("a.proc", h.deps);
  await tick();
  try {
    for (const type of ["keydown", "beforeinput", "drop", "dragover", "paste", "cut", "pointerdown", "mousedown", "click", "wheel", "contextmenu"]) {
      const e = fire(type, { key: "x" });
      assert.equal(e.defaultPrevented, true, `The default action of ${type} was canceled`);
    }
  } finally {
    h.release();
    await saving;
  }
});

test("After a successful save, editing resumes: the same shortcut can change things again", async () => {
  startProject();
  const h = heldDeps();
  const saving = saveProcFile("a.proc", h.deps);
  await tick();
  h.release();
  assert.equal(await saving, "saved");
  fire("keydown", { key: "z", ctrlKey: true });
  assert.equal(getState().project.name, "Starting point", "Undo takes effect");
  fire("drop");
  assert.ok(getState().project.media.some((m) => m.name === "拖进来的.png"));
});

test("Editing resumes after the wait for confirmation times out (no file written)", async () => {
  startProject();
  let timeUp;
  const h = heldDeps({ settle: () => new Promise((_, reject) => { timeUp = () => reject(new Error("timeout")); }) });
  const saving = saveProcFile("a.proc", h.deps);
  // First wait for it to reach the "wait for document service confirmation" step (before that,
  // also wait for background writes to stop)
  while (!timeUp) await new Promise((r) => setTimeout(r, 20));
  try {
    fire("keydown", { key: "Delete" });
    assert.equal(getState().project.name, "Changed once", "Cannot be changed while waiting either");
  } finally {
    timeUp();
  }
  assert.equal(await saving, "failed");
  assert.equal(h.written.length, 0);
  fire("keydown", { key: "Delete" });
  assert.equal(getState().project.name, "Changed by Delete", "Can be changed after the timeout");
});

test("Editing resumes after a disk write failure", async () => {
  startProject();
  const h = heldDeps({
    writeProc: async (produce) => { await produce(); throw new Error("Disk full"); },
  });
  assert.equal(await saveProcFile("a.proc", h.deps), "failed");
  fire("pointerdown");
  assert.equal(getState().project.name, "Changed by mouse");
});

test("The user clicks Cancel in \"Save as\": the whole process is not locked", async () => {
  startProject();
  let pickerOpen;
  const opened = new Promise((r) => { pickerOpen = r; });
  let answer;
  const h = heldDeps({
    writeProc: async () => { pickerOpen(); await new Promise((r) => { answer = r; }); return { kind: "cancelled" }; },
  });
  const saving = saveProcFile("a.proc", h.deps);
  await opened;
  fire("keydown", { key: "Delete" });
  assert.equal(getState().project.name, "Changed by Delete", "While the save destination is being picked (saving has not started yet), editing works as usual");
  answer();
  assert.equal(await saving, "cancelled");
});

test("Package save is locked in the same way: nothing can be changed between picking the destination and the write finishing", async () => {
  startProject();
  let release;
  const gate = new Promise((r) => { release = r; });
  const writes = [];
  const target = {
    createWritable: async () => ({
      write: async (b) => { await gate; writes.push(b); },
      close: async () => {},
      abort: async () => {},
    }),
  };
  const saving = savePackedFile("a.procp", {
    pick: async () => target,
    settle: async () => {},
    pack: async () => ({ blob: new Blob(["zip"]), missing: [] }),
    download: () => {},
    missingMessage: () => "",
    notify: () => {},
  });
  await tick(); await tick();
  try {
    fire("keydown", { key: "Delete" });
    assert.equal(getState().project.name, "Changed once");
  } finally {
    release();
  }
  assert.equal(await saving, "saved");
  fire("keydown", { key: "Delete" });
  assert.equal(getState().project.name, "Changed by Delete");
});

test("Clicking save again while a save is in progress does not start another one", async () => {
  startProject();
  const h = heldDeps();
  const first = saveProcFile("a.proc", h.deps);
  await tick();
  const other = heldDeps();
  other.release();
  let second;
  try {
    second = await saveProcFile("a.proc", other.deps);
  } finally {
    h.release();
  }
  assert.equal(second, "busy");
  assert.equal(other.written.length, 0, "The second one wrote nothing");
  assert.equal(await first, "saved");
});

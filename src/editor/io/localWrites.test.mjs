/**
 * Wait for local writes to finish before saving (`docs/semantics/mechanism/document-service.md`
 * "Save baseline and modification status checks": "saving temporarily disables foreground editing,
 * waiting for local writes to finish"). Run:
 *   node --experimental-test-module-mocks --test src/editor/io/localWrites.test.mjs
 *
 * Pin down: local Agent tools, assets currently being imported on this device, continuous writes
 * from background tasks, and modifications pending confirmation by document service: save waits
 * for all of them to finish writing before serializing; if timeout is reached and not finished, do
 * not write file, state clearly what it is waiting for, and resume editing; if project is modified
 * locally again after serialization, do not mark it as "saved".
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = new EventTarget();

const { actions, getState } = await import(srcUrl("store/project.ts"));
const { saveProcFile } = await import(srcUrl("editor/io/saveFlow.ts"));
const { beginAgentTool, endAgentTool } = await import(srcUrl("editor/userEditing.ts"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mock dependencies for a save: writing to disk just records the content */
function deps(over = {}) {
  const written = [];
  const notes = [];
  const marked = [];
  const d = {
    writeProc: async (produce, fileName) => {
      const text = await produce();
      written.push(JSON.parse(text));
      return { kind: "saved", where: fileName };
    },
    settle: async () => {},
    serialize: () => JSON.stringify({ name: getState().project.name, tracks: getState().project.tracks.length }),
    saveDraft: async () => {},
    markSaved: (f) => marked.push(f),
    notify: (m, tone = "error") => notes.push({ m, tone }),
    currentProject: () => getState().project,
    waitTimeoutMs: 1500,
    ...over,
  };
  return { d, written, notes, marked };
}

function fresh(name = "Starting point") {
  actions.newProject(name);
}

/** Probing for local Agent (matches defaults in localWrites.ts; written as data here, pre-modification code still runs even if it ignores it) */
let agentBusy = false;
const agentProbe = { label: () => "Changes the Agent is making", count: () => (agentBusy ? 1 : 0) };

test("A local Agent's tool is still running: save waits for it to finish writing before serializing, so the file contains its last write", async () => {
  fresh();
  agentBusy = true;
  setTimeout(() => {
    actions.setProjectMeta({ name: "Edited by Agent" });
    agentBusy = false;
  }, 200);
  const { d, written } = deps({ probes: [agentProbe] });
  assert.equal(await saveProcFile("a.proc", d), "saved");
  assert.equal(written[0].name, "Edited by Agent");
});

test("Media being imported on this device: wait for the upload to finish; media being uploaded by other devices (no local file) is not waited for", async () => {
  fresh();
  const m = actions.addMedia({ kind: "image", name: "local-import.png", url: "", pending: true });
  const other = actions.addMedia({ kind: "image", name: "uploaded-by-others.png", url: "", pending: true });
  const local = new Set([m.id]);
  const mediaProbe = {
    label: (n) => `Media being imported (${n})`,
    count: () => getState().project.media.filter((x) => x.pending && local.has(x.id)).length,
  };
  setTimeout(() => actions.updateMedia(m.id, { pending: undefined, url: "/@media/abc" }), 200);
  const { d, written } = deps({ probes: [mediaProbe], serialize: () => JSON.stringify({ pending: getState().project.media.filter((x) => x.pending).map((x) => x.id) }) });
  assert.equal(await saveProcFile("a.proc", d), "saved");
  assert.deepEqual(written[0].pending, [other.id], "The local image is saved only after its upload finishes; the other device's image is saved even while still pending");
});

test("A background task keeps writing: wait until it stops (no new writes land for a while) before serializing", async () => {
  fresh();
  // Background task is already writing (first write landed before clicking save),
  // then once every 60 ms
  let n = 1;
  actions.setProjectMeta({ name: "Background write 1" });
  const timer = setInterval(() => {
    n += 1;
    actions.setProjectMeta({ name: `Background write ${n}` });
    if (n === 6) clearInterval(timer);
  }, 60);
  await sleep(10);
  const { d, written } = deps({ probes: [] });
  assert.equal(await saveProcFile("a.proc", d), "saved");
  assert.equal(written[0].name, "Background write 6", "What is saved is the state after writing finished, not halfway through");
});

test("The Agent never finishes writing: at the time limit no file is written, the notice says it is waiting for the Agent; editing is restored afterwards", async () => {
  fresh();
  agentBusy = true;
  const { d, written, notes, marked } = deps({ probes: [agentProbe], waitTimeoutMs: 400 });
  try {
    assert.equal(await saveProcFile("a.proc", d), "failed");
  } finally {
    agentBusy = false;
  }
  assert.equal(written.length, 0, "No file was written");
  assert.equal(marked.length, 0, "Not marked as saved");
  assert.match(notes[0].m, /Agent/);
  assert.match(notes[0].m, /The original file was not changed/);
  const { isSaveLocked } = await import(srcUrl("editor/saveLock.ts"));
  assert.equal(isSaveLocked(), false, "The lock is released");
});

test("Media never finishes importing: at the time limit no file is written, and the notice contains the count", async () => {
  fresh();
  const m = actions.addMedia({ kind: "video", name: "big-file.mp4", url: "", pending: true });
  const probe = { label: (n) => `Media being imported (${n})`, count: () => (getState().project.media.find((x) => x.id === m.id)?.pending ? 1 : 0) };
  const { d, written, notes } = deps({ probes: [probe], waitTimeoutMs: 300 });
  assert.equal(await saveProcFile("a.proc", d), "failed");
  assert.equal(written.length, 0);
  assert.match(notes[0].m, /Media being imported \(1\)/);
});

test("Changes awaiting document service confirmation never get it: no file is written, and the existing wording is reused", async () => {
  fresh();
  const { d, written, notes } = deps({ probes: [], settle: async () => { throw new Error("timeout"); } });
  assert.equal(await saveProcFile("a.proc", d), "failed");
  assert.equal(written.length, 0);
  assert.match(notes[0].m, /not been confirmed by the document service/);
});

test("The project was changed locally again after serialization (an Agent write landed during the disk write): the file is still saved but not marked \"saved\", and the user is told", async () => {
  fresh();
  const { d, written, marked, notes } = deps({
    probes: [],
    writeProc: async (produce, fileName) => {
      const text = await produce();
      // An Agent tool landed a write during disk write
      beginAgentTool();
      actions.setProjectMeta({ name: "Changed during disk write" });
      endAgentTool();
      written.push(JSON.parse(text));
      return { kind: "saved", where: fileName };
    },
  });
  assert.equal(await saveProcFile("a.proc", d), "saved");
  assert.equal(written[0].name, "Starting point");
  assert.equal(marked.length, 0, "The project is no longer the one in the file, so it cannot be marked as saved");
  assert.equal(getState().dirty, true);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].tone, "info");
  assert.match(notes[0].m, /later changes are not saved yet/);
});

test("Default probe: agentToolProbe counts 1 while an Agent tool is running; only media being imported locally counts", async () => {
  const lw = await import(srcUrl("editor/io/localWrites.ts"));
  beginAgentTool();
  assert.equal(lw.agentToolProbe.count(), 1);
  endAgentTool();
  assert.equal(lw.agentToolProbe.count(), 0);
  const probe = lw.mediaImportProbe(() => [{ id: "a", pending: true }, { id: "b", pending: true }, { id: "c" }], (id) => id !== "b");
  assert.equal(probe.count(), 1);
  assert.equal(probe.label(1), "Media being imported (1)");
});

test("A collaborator's change arrives after serialization (not written locally): not marked \"saved\", but no extra notice either", async () => {
  fresh();
  const core = await import(srcUrl("store/core.ts"));
  const { d, written, marked, notes } = deps({
    probes: [],
    writeProc: async (produce, fileName) => {
      const text = await produce();
      // Modifications from other devices arrived via document service: docsync directly replaces
      // state.project and marks dirty (bindStore in src/store/docsync.ts)
      core.set({ project: { ...getState().project, name: "Changed by collaborator" }, dirty: true });
      written.push(JSON.parse(text));
      return { kind: "saved", where: fileName };
    },
  });
  assert.equal(await saveProcFile("a.proc", d), "saved");
  assert.equal(written[0].name, "Starting point");
  assert.equal(marked.length, 0, "The file lacks the collaborator's change, so it cannot be marked as saved");
  assert.deepEqual(notes, [], "Collaborator changes mark the project dirty at any time anyway, so nothing more is said");
});

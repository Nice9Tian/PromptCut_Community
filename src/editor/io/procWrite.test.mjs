/**
 * The `.proc` disk-write step (`writeProcToDisk` in `proc.ts`): collects prerender snapshots,
 * writes temporary replica, and does not touch original file on error.
 * Run: node --experimental-test-module-mocks --test src/editor/io/procWrite.test.mjs
 *
 * Enforce:
 *   - Rendering (prerender snapshot) not received by timeout: project is saved anyway (snapshots
 *     are disposable cache), but result flags that no snapshot was included, and the save flow
 *     notifies the user: do not silently pass;
 *
 * Fake file handle: the stream returned by `createWritable` follows browser rules (writes to a
 * temporary replica, replaces original file only on `close`, discards temporary replica on `abort`).
 * Whether this rule holds in real browsers is verified by probe
 * `scripts/probes/save-state-probe.mjs --phases fail`.
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";

/** How prerender snapshot responds this time: ok returns immediately; hang never returns (waits until timeout) */
let archiveMode = "ok";
mock.module(srcUrl("render/frameClient.ts"), {
  namedExports: {
    snapshotsFor: () => undefined,
    restoreSnapshots: () => {},
    frameRequest: (op, project, extra, signal) => {
      if (archiveMode === "ok") return Promise.resolve({ snapshots: "SNAP" });
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("Frame read failed")), { once: true }));
    },
  },
});

/** Fake file following browser rules: content in `bytes`, stream writes into temporary replica */
function fakeFile(name, initial = "") {
  const file = { name, kind: "file", bytes: initial, swaps: 0, log: [] };
  file.createWritable = async () => {
    let swap = "";
    let open = true;
    file.swaps += 1;
    return {
      write: async (data) => {
        if (!open) throw new Error("Stream closed");
        swap += typeof data === "string" ? data : await data.text();
        if (file.failAfterHalf) { file.log.push("write-failed"); throw new Error(file.failAfterHalf); }
      },
      close: async () => { if (!open) throw new Error("Stream closed"); open = false; file.bytes = swap; file.swaps -= 1; file.log.push("close"); },
      abort: async () => { open = false; file.swaps -= 1; file.log.push("abort"); },
    };
  };
  return file;
}

let target = null;
globalThis.window = Object.assign(new EventTarget(), {
  showSaveFilePicker: async () => target,
});

const proc = await import(srcUrl("editor/io/proc.ts"));
const { saveProcFile } = await import(srcUrl("editor/io/saveFlow.ts"));
const { actions, getState } = await import(srcUrl("store/project.ts"));

function saveDeps(notes) {
  return {
    writeProc: (produce, fileName) => proc.writeProcToDisk(produce, fileName),
    settle: async () => {},
    serialize: () => proc.serializeProc(),
    saveDraft: async () => {},
    markSaved: (f) => actions.markSaved(f),
    notify: (m, tone = "error") => notes.push({ m, tone }),
    currentProject: () => getState().project,
    waitTimeoutMs: 2000,
  };
}

test("The prerender snapshots were received: saved into the file with no extra notice", async () => {
  archiveMode = "ok";
  proc.forgetSaveTarget();
  target = fakeFile("snapshot.proc");
  actions.newProject("snapshot");
  const notes = [];
  assert.equal(await saveProcFile("snapshot.proc", saveDeps(notes)), "saved");
  assert.equal(JSON.parse(target.bytes).snapshots, "SNAP");
  assert.deepEqual(notes, []);
});

test("The prerender snapshots were not received by the time limit: the project is still saved (without snapshots), the result flags it, and the user is told", async () => {
  archiveMode = "hang";
  proc.forgetSaveTarget();
  target = fakeFile("snapshot-timeout.proc");
  actions.newProject("Snapshot timeout");
  const outcome = await proc.writeProcToDisk(async () => proc.serializeProc(), "snapshot-timeout.proc");
  assert.equal(outcome.kind, "saved");
  assert.equal(outcome.snapshotsSkipped, true, "The result flags that this save has no snapshots");
  const doc = JSON.parse(target.bytes);
  assert.equal(doc.project.name, "Snapshot timeout", "The project content is still saved");
  assert.equal(doc.snapshots, undefined);

  proc.forgetSaveTarget();
  target = fakeFile("snapshot-timeout2.proc");
  const notes = [];
  assert.equal(await saveProcFile("snapshot-timeout2.proc", saveDeps(notes)), "saved");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].tone, "info");
  assert.match(notes[0].m, /prerender snapshots/);
  assert.equal(getState().dirty, false, "The project content is complete, so it counts as saved");
  archiveMode = "ok";
});

/* ── Failed halfway through write: old save must not be overwritten ── */

test("Error halfway through writing: the original file is byte-for-byte unchanged, the temporary copy is discarded (abort), and there is no close", async () => {
  archiveMode = "ok";
  proc.forgetSaveTarget();
  target = fakeFile("half-written.proc", "Content of the last valid save");
  target.failAfterHalf = "Disk full";
  actions.newProject("partial");
  await assert.rejects(() => proc.writeProcToDisk(async () => proc.serializeProc(), "half-written.proc"), (e) => {
    assert.match(e.message, /Disk full/);
    assert.match(e.message, /The original file was not changed/);
    return true;
  });
  assert.equal(target.bytes, "Content of the last valid save", "The original file is byte-for-byte unchanged");
  assert.deepEqual(target.log, ["write-failed", "abort"], "The temporary copy was aborted and not closed (only close replaces the original file)");
  assert.equal(target.swaps, 0, "No unfinalized temporary copy is left behind");
});

test("Error in the close step (which replaces the original file): abort as well, and the original file is unchanged", async () => {
  proc.forgetSaveTarget();
  const file = fakeFile("close-fails.proc", "Old content");
  const create = file.createWritable;
  file.createWritable = async () => {
    const w = await create();
    return { ...w, close: async () => { file.log.push("close-failed"); throw new Error("Error while replacing the file"); } };
  };
  target = file;
  actions.newProject("Cannot close");
  await assert.rejects(() => proc.writeProcToDisk(async () => proc.serializeProc(), "close-fails.proc"), /The original file was not changed/);
  assert.equal(file.bytes, "Old content");
  assert.deepEqual(file.log, ["close-failed", "abort"]);
});

test("Error halfway through writing in the save flow: the notice states the original file is untouched, it is not marked saved, the draft is not updated, and editing is restored", async () => {
  proc.forgetSaveTarget();
  target = fakeFile("flow.proc", "The old one");
  target.failAfterHalf = "No space left on device";
  actions.newProject("process");
  actions.setProjectMeta({ name: "Flow edited" });
  const notes = [];
  let drafts = 0;
  const d = { ...saveDeps(notes), saveDraft: async () => { drafts += 1; } };
  assert.equal(await saveProcFile("flow.proc", d), "failed");
  assert.equal(target.bytes, "The old one");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].tone, "error");
  assert.match(notes[0].m, /No space left on device/);
  assert.match(notes[0].m, /The original file was not changed/);
  assert.equal(getState().dirty, true, "Not marked as saved");
  assert.equal(drafts, 0, "The draft is untouched");
  const { isSaveLocked } = await import(srcUrl("editor/saveLock.ts"));
  assert.equal(isSaveLocked(), false, "Editing is restored");
});

test("Save again after the error (this time the write succeeds): it saves as usual and the original file gets the new content", async () => {
  target.failAfterHalf = null;
  const notes = [];
  assert.equal(await saveProcFile("flow.proc", saveDeps(notes)), "saved");
  assert.equal(JSON.parse(target.bytes).project.name, "Flow edited");
  assert.equal(getState().dirty, false);
});

test("Error halfway through writing a package save: the package file is unchanged, abort, and the notice says the original file is untouched", async () => {
  const { savePackedFile } = await import(srcUrl("editor/io/saveFlow.ts"));
  const pkg = fakeFile("package.procp", "Old package");
  pkg.failAfterHalf = "Package write error";
  const notes = [];
  const result = await savePackedFile("package.procp", {
    pick: async () => pkg,
    settle: async () => {},
    pack: async () => ({ blob: new Blob(["Bytes of the new package"]), missing: [] }),
    download: () => {},
    missingMessage: () => "",
    notify: (m, tone = "error") => notes.push({ m, tone }),
    waitTimeoutMs: 2000,
  });
  assert.equal(result, "failed");
  assert.equal(pkg.bytes, "Old package");
  assert.deepEqual(pkg.log, ["write-failed", "abort"]);
  assert.match(notes[0].m, /The original file was not changed/);
});

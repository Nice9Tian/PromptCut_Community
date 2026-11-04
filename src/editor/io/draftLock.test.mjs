/**
 * Which exclusive draft lock is released when "switching drafts" (setActiveDraftId in drafts.ts +
 * procLock.ts). Run:
 *   node --experimental-test-module-mocks --test src/editor/io/draftLock.test.mjs
 *
 * Pin down: the order of open(id) on the start page is first openDraft(id) (which acquires the lock
 * for id) then setActiveDraftId(id).
 * In setActiveDraftId, "release the previous lock when switching drafts" can only release the
 * previous one, and must never release the newly acquired lock:
 * otherwise, after "New → Return to home → Open draft" or "Open A → Return to home → Open B",
 * the draft currently being edited has no lock, and another PromptCut could open and overwrite it
 * entirely at the same time.
 * Also pin down that what should be released originally is still released: create new project,
 * open from file (set to null), startNew (set to new id).
 *
 * Both fetch and Tauri invoke are fake; no services are started.
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

/** Fake ledger for /api/skill-lock on the server: which drafts are locked */
const serverLocks = new Set();
/** Locked paths at the shell layer */
const shellLocks = new Set();
const calls = [];

mock.module(srcUrl("editor/io/proc.ts"), {
  exports: {
    loadProc: (_text, opts) => ({ id: opts?.legacyId ?? "p", name: "proj" }),
    serializeProc: () => "{}",
    forgetSaveTarget: () => {},
    withFrameSnapshots: async (s) => s,
  },
});
mock.module(srcUrl("store/project.ts"), { exports: { actions: { loadProject: () => {} } } });

globalThis.window = {
  addEventListener: () => {},
  __TAURI__: {
    core: {
      invoke: async (cmd, args) => {
        calls.push(`${cmd}:${args.procPath}`);
        if (cmd === "acquire_proc_lock") shellLocks.add(args.procPath);
        if (cmd === "release_proc_lock") shellLocks.delete(args.procPath);
      },
    },
  },
};

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

globalThis.fetch = async (url, init = {}) => {
  const m = /^\/api\/skill-lock\/(acquire|release)$/.exec(url);
  if (m) {
    const { draftId } = JSON.parse(init.body);
    calls.push(`${m[1]}:${draftId}`);
    if (m[1] === "acquire") {
      if (serverLocks.has(draftId)) return reply(409, { ok: false, error: "Already in use" });
      serverLocks.add(draftId);
      return reply(200, { ok: true, file: `D:/drafts/${draftId}.proc.lock` });
    }
    serverLocks.delete(draftId);
    return reply(200, { ok: true });
  }
  if (/^\/api\/projects\//.test(url)) return reply(200, { format: "promptcut-proc" });
  throw new Error(`Unexpected request ${url}`);
};

const { openDraft, setActiveDraftId, getActiveDraftId, newDraftId } = await import(srcUrl("editor/io/drafts.ts"));
const { lockedDraftId, releaseDraftLock } = await import(srcUrl("editor/io/procLock.ts"));

/** Lock release in setActiveDraftId is not awaited; inspect after it finishes running */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Order of open(id) on the start page */
async function startPageOpen(id) {
  await openDraft(id);
  setActiveDraftId(id);
  await settle();
}

/** That statement for startNew on the start page */
async function startNew() {
  setActiveDraftId(newDraftId());
  await settle();
}

beforeEach(async () => {
  setActiveDraftId(null);
  await releaseDraftLock();
  await settle();
  serverLocks.clear();
  shellLocks.clear();
  calls.length = 0;
});

test("startNew has set activeDraftId → opening draft D: the lock on D is still held", async () => {
  await startNew();
  await startPageOpen("D");
  assert.equal(getActiveDraftId(), "D");
  assert.equal(lockedDraftId(), "D");
  assert.ok(serverLocks.has("D"), "The server-side half of the lock is still there");
  assert.ok(shellLocks.has("D:/drafts/D.proc.lock"), "The shell-side half of the lock is still there");
  assert.ok(!calls.includes("release:D"), `Should not send release for D, actual calls: ${calls.join(", ")}`);
});

test("Open A → open B: B holds it, A is released", async () => {
  await startPageOpen("A");
  assert.equal(lockedDraftId(), "A");
  await startPageOpen("B");
  assert.equal(getActiveDraftId(), "B");
  assert.equal(lockedDraftId(), "B");
  assert.deepEqual([...serverLocks], ["B"]);
  assert.deepEqual([...shellLocks], ["D:/drafts/B.proc.lock"]);
  assert.ok(calls.includes("release:A"));
  assert.ok(!calls.includes("release:B"), `Should not send release for B, actual calls: ${calls.join(", ")}`);
});

test("Shell's ?draft= path (openDraft then setActiveDraftId) keeps the lock even if an activeDraftId existed before", async () => {
  await startNew();
  await openDraft("S");
  setActiveDraftId("S");
  await settle();
  assert.equal(lockedDraftId(), "S");
  assert.ok(serverLocks.has("S"));
});

test("Opening the same draft twice: no error, the lock stays held, acquired only once", async () => {
  await startPageOpen("A");
  await startPageOpen("A");
  assert.equal(lockedDraftId(), "A");
  assert.ok(serverLocks.has("A"));
  assert.equal(calls.filter((c) => c === "acquire:A").length, 1);
  assert.ok(!calls.includes("release:A"));
});

test("While A is open, new project / open from file (set to null): A's lock is released", async () => {
  await startPageOpen("A");
  setActiveDraftId(null);
  await settle();
  assert.equal(lockedDraftId(), null);
  assert.equal(serverLocks.size, 0);
  assert.equal(shellLocks.size, 0);
  assert.ok(calls.includes("release:A"));
});

test("While A is open, startNew (set to a new id): A's lock is released", async () => {
  await startPageOpen("A");
  await startNew();
  assert.equal(lockedDraftId(), null);
  assert.equal(serverLocks.size, 0);
  assert.equal(shellLocks.size, 0);
});

test("When no draft was ever open, setting null / a new id: no redundant release is sent", async () => {
  await startNew();
  setActiveDraftId(null);
  await settle();
  assert.deepEqual(calls, []);
});

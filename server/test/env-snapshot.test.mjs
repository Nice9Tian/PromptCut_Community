/**
 * node --test server/test/env-snapshot.test.mjs
 *
 * Server-side state in the diagnostic report.
 *
 * The key focus is the **session file cabinet**: chats in the UI are organized by project,
 * while which history the server connects to depends on the session id in localStorage;
 * when the two are disconnected, the UI shows no symptoms at all (see 81f255b).
 * The report must expose "how many histories exist on this machine and how many entries each",
 * providing hard evidence for this type of session mix-up.
 *
 * Equally important: it **must not report chat content**: the user clicks "diagnose" to send
 * the report to us, and every extra original word in the report is an unnecessary leak.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { inspectSessionStore, nodeStatus, sessionStoreDir } = await import("../harness/env-snapshot.mjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pc-envsnap-"));
}

test("when the directory does not exist, reports a plain-language sentence instead of throwing an exception that takes the whole report down", () => {
  const missing = path.join(tmpDir(), "nope");
  const r = inspectSessionStore(missing);
  assert.equal(r.exists, false);
  assert.equal(r.files, 0);
  assert.match(r.note, /Directory does not exist/);
});

test("reports how many entries each history has and which roles: this is the hard evidence for \"the interface is empty but the backend continues the old chat\"", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "api-9433c3ac.json"), JSON.stringify([
    { role: "user", content: "the first sentence of the previous project" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "another sentence" },
  ]));
  const r = inspectSessionStore(dir);
  assert.equal(r.exists, true);
  assert.equal(r.files, 1);
  assert.equal(r.recent[0].sessionId, "api-9433c3ac", "the file name minus .json is the session id, and it must match the one in localStorage");
  assert.equal(r.recent[0].messages, 3);
  assert.deepEqual(r.recent[0].roles, { user: 2, assistant: 1 });
});

test("chat content must never end up in the report", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "s.json"), JSON.stringify([{ role: "user", content: "drank some wild dog milk and instantly turned into a happy puppy" }]));
  const dumped = JSON.stringify(inspectSessionStore(dir));
  assert.ok(!dumped.includes("happy puppy"), `original wording leaked into the report: ${dumped}`);
});

test("a corrupted history file must not break the statistics for the whole directory", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "good.json"), JSON.stringify([{ role: "user" }]));
  fs.writeFileSync(path.join(dir, "broken.json"), "{ this is not JSON");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not json, should not be counted");
  const r = inspectSessionStore(dir);
  assert.equal(r.files, 2, "count .json only");
  const broken = r.recent.find((x) => x.sessionId === "broken");
  assert.equal(broken.messages, "(unreadable)");
  assert.equal(r.recent.find((x) => x.sessionId === "good").messages, 1);
});

test("newest first: when troubleshooting, the first one to look at is the one from just now", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "old.json"), "[]");
  fs.writeFileSync(path.join(dir, "new.json"), "[]");
  const now = Date.now();
  fs.utimesSync(path.join(dir, "old.json"), new Date(now - 86400000), new Date(now - 86400000));
  fs.utimesSync(path.join(dir, "new.json"), new Date(now), new Date(now));
  const r = inspectSessionStore(dir);
  assert.deepEqual(r.recent.map((x) => x.sessionId), ["new", "old"]);
});

test("when there are too many files, inspect only the newest ones in detail, and state clearly that it was truncated", () => {
  const dir = tmpDir();
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(dir, `s${i}.json`), "[]");
  const r = inspectSessionStore(dir);
  assert.equal(r.files, 25, "the total is still reported");
  assert.equal(r.recent.length, 20);
  assert.match(r.note, /25 in total/);
});

test("the default directory must be the same one that runners/api.mjs reads and writes", () => {
  assert.equal(sessionStoreDir("/T"), path.join("/T", "promptcut", "harness-sessions"));
});

test("Node process state must be able to answer \"was it just restarted\" and \"is it a packaged build\"", () => {
  const n = nodeStatus();
  assert.match(n.version, /^v\d+/);
  assert.equal(typeof n.uptimeSeconds, "number");
  assert.equal(typeof n.packaged, "boolean");
  assert.equal(typeof n.memoryMB.rss, "number");
  assert.ok(n.osMemoryMB.total > 0);
});

test("the packaged build must be recognizable: the packaged build and the source build behave differently with paths", () => {
  const fake = { version: "v24.0.0", versions: {}, pid: 1, uptime: () => 5, memoryUsage: () => ({}), execPath: "x", cwd: () => "y", env: { PROMPTCUT_RUNTIME_ROOT: "C:/app" } };
  const o = { tmpdir: () => "/t", totalmem: () => 1, freemem: () => 1, cpus: () => [], release: () => "1" };
  assert.equal(nodeStatus(fake, o).packaged, true);
  assert.equal(nodeStatus({ ...fake, env: {} }, o).packaged, false);
});

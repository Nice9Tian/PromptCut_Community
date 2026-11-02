/**
 * node --test src/ai/envReport.test.mjs
 *
 * "Environment snapshot" in the diagnostic report.
 *
 * What it guards is not an algorithm, but **a manifest**: mode, project path, media library,
 * backend session id. The cost of missing an item is not a crash, but another round of
 * back-and-forth questioning the user: meaning the entire reason for this report's existence is
 * lost. Therefore, each test below targets a field where "troubleshooting cannot proceed without it".
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { buildEnvReport, describeMode, mediaDirs } = await import("./envReport.ts");

function store(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
  };
}

const base = { project: null };

test("Both working modes must be described in plain words; the chat-style layout has been removed, and the layout field in old reports has no effect", () => {
  assert.equal(describeMode({}), "Classic mode");
  assert.equal(describeMode({ layout: "chat" }), "Classic mode");
  assert.match(describeMode({ skill: { active: true } }), /SKILL/);
  assert.doesNotMatch(describeMode({ skill: { active: true } }), /chat-style|read-only/);
  assert.match(describeMode({ agentTabs: 3 }), /Multi-Agent \(3 tabs\)/);
  assert.equal(describeMode({ agentTabs: 1 }), "Classic mode");
});

test("A project that has never been saved must say so **explicitly**: the odd cases of media sitting in the temporary directory all come from here", () => {
  const r = buildEnvReport({ ...base, project: { name: "Untitled", filePath: null, media: [], tracks: [] } });
  assert.equal(r.project.saved, false);
  assert.match(r.project.savedNote, /temp directory/);

  const saved = buildEnvReport({ ...base, project: { name: "x", filePath: "D:\\片子\\a.proc", media: [], tracks: [] } });
  assert.equal(saved.project.saved, true);
  assert.equal(saved.project.savedNote, undefined, "Once saved to disk, that note must no longer be attached");
  assert.equal(saved.project.filePath, "D:\\片子\\a.proc");
});

test("When the media library is empty, the report must say so: if the model can still name media, that is the evidence to confront it with", () => {
  const r = buildEnvReport({ ...base, project: { media: [], tracks: [] } });
  assert.equal(r.media.count, 0);
  assert.match(r.media.note, /library is empty/);
});

test("Media must be reported down to the file level, and the directories they are in must also be listed separately", () => {
  const media = [
    { id: "m1", name: "a.mp4", kind: "video", duration: 12, path: "C:\\Temp\\promptcut\\work\\a.mp4" },
    { id: "m2", name: "b.mp4", kind: "video", path: "C:\\Temp\\promptcut\\work\\b.mp4" },
    { id: "m3", name: "c.wav", kind: "audio", path: "D:\\素材\\c.wav" },
  ];
  const r = buildEnvReport({ ...base, project: { media, tracks: [] } });
  assert.equal(r.media.count, 3);
  assert.deepEqual(r.media.items.map((m) => m.name), ["a.mp4", "b.mp4", "c.wav"]);
  assert.deepEqual(mediaDirs(media).sort(), ["C:\\Temp\\promptcut\\work", "D:\\素材"]);
  assert.deepEqual(r.media.dirs.sort(), ["C:\\Temp\\promptcut\\work", "D:\\素材"]);
});

test("Media without a disk path must not simply lack a field; the report must say what the situation is", () => {
  const r = buildEnvReport({ ...base, project: { media: [{ id: "m", name: "x", kind: "video" }], tracks: [] } });
  assert.match(r.media.items[0].path, /blob/);
});

test("0 visible messages + session id still present = the backend continues the old history, so the two numbers must be shown together", () => {
  const r = buildEnvReport({
    ...base,
    visibleMessages: 0,
    storage: store({ "aiSession:api": "api-9433c3ac", aiProvider: "api" }),
  });
  assert.equal(r.chat.visibleMessages, 0);
  assert.deepEqual(r.chat.backendSessionIds, { "aiSession:api": "api-9433c3ac" });
  assert.match(r.chat.note, /1 backend session ids/);
  assert.deepEqual(r.localSettings, { aiProvider: "api" }, "The session id must not also get mixed into the preferences section");
});

test("Even on a clean start it must say \"it is clean\", instead of leaving an empty object for people to guess", () => {
  const r = buildEnvReport({ ...base, visibleMessages: 0, storage: store({ aiProvider: "api" }) });
  assert.deepEqual(r.chat.backendSessionIds, {});
  assert.match(r.chat.note, /starts from scratch/);
});

test("The body of the script the user wrote must not go into the report: this report is meant to be uploaded", () => {
  /*
   * pc.ai.script stores the user's handwritten script (ai/script.ts). Originally values were
   * collected here via `ai*` / `pc.*` prefix wildcards, so the first 200 characters of the script
   * silently entered the report to be uploaded (ai/reportSubmit.ts). Wildcards also mean that any
   * newly added keys with the same prefix in the future would automatically be sent outbound, which
   * whoever adds the key would not think of.
   */
  const script = "Act 1: The hero finishes drinking wild dog milk and turns straight into a happy puppy, the shot pushes in";
  const r = buildEnvReport({ ...base, storage: store({ "pc.ai.script": script }) });
  const dumped = JSON.stringify(r);
  assert.ok(!dumped.includes("happy puppy"), `The script body leaked into the report: ${dumped}`);
  assert.match(r.localSettings["pc.ai.script"], /has a value/, "But people must be able to tell that such a key exists");
  assert.match(r.localSettings["pc.ai.script"], new RegExp(`${script.length} characters in total`), "The length must be reported");
});

test("Plain setting items on the allowlist still carry their values: otherwise nothing can be seen when troubleshooting", () => {
  const r = buildEnvReport({
    ...base,
    storage: store({ aiProvider: "api", aiShowThinking: "1", "pc.volume": "0.5", "pc.ai.effort.codex": "high" }),
  });
  assert.deepEqual(r.localSettings, {
    aiProvider: "api",
    aiShowThinking: "1",
    "pc.volume": "0.5",
    "pc.ai.effort.codex": "high",
  });
});

test("New keys with the same prefix that have not been seen before do not include their original content by default: whoever adds a key does not need to remember this rule", () => {
  const r = buildEnvReport({ ...base, storage: store({ "pc.someKeyAddedLater": "Who knows what is inside" }) });
  assert.ok(!JSON.stringify(r).includes("Who knows"), "Anything outside the allowlist never carries the original content");
});

test("Keys unrelated to us are not collected at all", () => {
  const r = buildEnvReport({ ...base, storage: store({ "some-other-app": "x", token: "abc" }) });
  assert.deepEqual(r.localSettings, {});
});

test("Long values must be truncated: a single draft can blow up the whole report", () => {
  const r = buildEnvReport({ ...base, storage: store({ aiProvider: "x".repeat(5000) }) });
  assert.ok(r.localSettings.aiProvider.length < 300);
  assert.match(r.localSettings.aiProvider, /5000 characters in total/);
});
test("When localStorage cannot be read, report one sentence; the whole report must not fail along with it", () => {
  const r = buildEnvReport({ ...base, storage: null });
  assert.match(r.localNote, /Can.t read localStorage/);
  assert.deepEqual(r.chat.backendSessionIds, {});
});

test("Tracks report only counts and do not stuff the whole timeline into the report", () => {
  const r = buildEnvReport({
    ...base,
    project: { media: [], tracks: [{ id: "t-1", name: "Track 1", clips: [{}, {}] }, { id: "t-2", clips: [] }] },
  });
  assert.deepEqual(r.project.tracks, [
    { id: "t-1", name: "Track 1", clips: 2 },
    { id: "t-2", name: undefined, clips: 0 },
  ]);
  assert.equal(r.project.clipCount, 2);
});

test("Media under a posix root directory: the directory is the root, not \"no directory\"", () => {
  assert.deepEqual(mediaDirs([{ id: "m", name: "a.mp4", kind: "video", path: "/a.mp4" }]), ["/"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createMirrorStore, MAX_VERSIONS } from "../mirror-store.mjs";
import { changedClips, projectHash } from "../../src/render/changedClips.mjs";

/**
 * Mirror storage core (A7). Mounted once in each of two processes (editor / prerender), frame
 * requests fetch projects here by `{session, localRev}`: so this test pins down "when it can be
 * retrieved, and when the page must re-push":
 *
 * - **8-version window**: requests and pushes interleave; an in-flight frame-fetch request asks for
 *   the version from two seconds ago;
 * - **stale**: when two pushes arrive out of order, the older must not overwrite the newer (not an
 *   error, returns 200);
 * - **resync(409)**: patch baseline slides out of window, or hashes do not match after applying:
 *   the hash step is the **only** place that can detect "two-level diff bug wrote itself wrong",
 *   omitting it allows the mirror to keep serving with a silently corrupted project;
 * - **pulling back to catch up a version** (`insert`) bypasses stale gate: by definition what it
 *   catches up is an older version;
 * - **playhead** and project are stored separately.
 */

const clip = (id, over = {}) => ({ id, start: 0, end: 1, kind: "card", cardId: "c", ...over });
const track = (id, n) => ({ id, name: id, hidden: false, clips: Array.from({ length: n }, (_, i) => clip(`${id}-${i}`)) });
const BASE = {
  id: "p", name: "demo", width: 1920, height: 1080, fps: 30, duration: 10, themeId: "dark", camera3dFov: 50,
  media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
};
const project = (tracks) => ({ ...BASE, tracks });

/** Drag clip `i`: store is updated immutably, only that clip and that track receive new objects */
function drag(p, ti, ci, start) {
  const t = p.tracks[ti];
  return { ...p, tracks: p.tracks.map((x, i) => (i === ti ? { ...t, clips: t.clips.map((c, j) => (j === ci ? { ...c, start, end: start + 1 } : c)) } : x)) };
}

/** Page side: push changes from prev→next to store as a two-level diff */
function pushPatch(store, session, prev, next, fromLocalRev, toLocalRev) {
  return store.pushDiff({ session, fromLocalRev, toLocalRev, hash: projectHash(next), patch: changedClips(prev, next) });
}

test("Full push: retrievable by {session, localRev}", () => {
  const store = createMirrorStore();
  const p = project([track("t1", 2)]);
  const out = store.pushFull({ session: "s1", localRev: 1, project: p });
  assert.equal(out.status, "ok");
  assert.equal(out.localRev, 1);
  assert.equal(out.hash, projectHash(p));

  assert.equal(store.getMirror("s1", 1).project, p);
  assert.equal(store.getMirror("s1").localRev, 1, "No number given = latest version");
  assert.equal(store.getMirror("s1", "1").project, p, "The number is a string when it comes from the query string");
  assert.equal(store.getMirror("s1", 2), null);
  assert.equal(store.getMirror("another session"), null);
  assert.equal(store.latestMirror().project, p);
});

test("Throws when session / project is missing", () => {
  const store = createMirrorStore();
  assert.throws(() => store.pushFull({ session: "", localRev: 1, project: project([]) }), /Missing session/);
  assert.throws(() => store.pushFull({ session: "s1", localRev: 1, project: null }), /Missing project/);
  assert.throws(() => store.pushFull({ session: "s1", localRev: 1, project: { tracks: "nope" } }), /Missing project/);
  assert.throws(() => store.pushDiff({ session: "", toLocalRev: 2 }), /Missing session/);
});

test("8-version window: only the latest 8 versions are kept, and older ones cannot be retrieved", () => {
  const store = createMirrorStore();
  assert.equal(MAX_VERSIONS, 8);
  let p = project([track("t1", 3)]);
  store.pushFull({ session: "s1", localRev: 1, project: p });
  for (let rev = 2; rev <= 12; rev++) {
    const next = drag(p, 0, 0, rev);
    assert.equal(pushPatch(store, "s1", p, next, rev - 1, rev).status, "ok", `Version ${rev} should be accepted`);
    p = next;
  }
  assert.deepEqual(store.revsOf("s1"), [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(store.getMirror("s1", 5));
  assert.equal(store.getMirror("s1", 4), null, "Those that slid out of the window cannot be retrieved");
  assert.equal(store.latestMirror().localRev, 12);
});

test("stale: a number in the same session that is not greater than the largest stored number answers stale rather than an error", () => {
  const store = createMirrorStore();
  const a = project([track("t1", 1)]);
  const b = drag(a, 0, 0, 5);
  store.pushFull({ session: "s1", localRev: 3, project: a });

  for (const rev of [3, 2, 0]) {
    const out = store.pushFull({ session: "s1", localRev: rev, project: b });
    assert.equal(out.status, "stale", `Version ${rev} should be treated as arriving out of order`);
    assert.equal(out.localRev, 3);
  }
  assert.equal(store.getMirror("s1", 3).project, a, "The old one did not overwrite the new one");

  // Same criterion for the patch path
  const late = pushPatch(store, "s1", a, b, 2, 3);
  assert.equal(late.status, "stale");
});

test("Two editor tabs do not overwrite each other", () => {
  const store = createMirrorStore();
  const a = project([track("a", 1)]);
  const b = project([track("b", 2)]);
  store.pushFull({ session: "tab-A", localRev: 7, project: a });
  store.pushFull({ session: "tab-B", localRev: 1, project: b });

  // B's number is much smaller than A's, but it is another session: should not be treated as stale
  assert.equal(store.getMirror("tab-A", 7).project, a);
  assert.equal(store.getMirror("tab-B", 1).project, b);
  assert.equal(store.latestMirror().session, "tab-B", "The Agent gets the page that pushed last");
  assert.deepEqual(store.allLatest().map((v) => v.session).sort(), ["tab-A", "tab-B"]);
});

test("Two-level diff: after applying it is identical to the copy held by the page", () => {
  const store = createMirrorStore();
  const a = project([track("t1", 3), track("t2", 2)]);
  store.pushFull({ session: "s1", localRev: 1, project: a });

  // Drag a clip
  const b = drag(a, 0, 1, 4);
  assert.equal(pushPatch(store, "s1", a, b, 1, 2).status, "ok");
  assert.deepEqual(store.getMirror("s1", 2).project, b);
  // Untouched objects remain same reference in mirror (structural sharing across 8 versions,
  // why it uses no memory)
  assert.equal(store.getMirror("s1", 2).project.tracks[1], a.tracks[1]);

  // Toggle track hidden
  const c = { ...b, tracks: [{ ...b.tracks[0], hidden: true }, b.tracks[1]] };
  assert.equal(pushPatch(store, "s1", b, c, 2, 3).status, "ok");
  assert.equal(store.getMirror("s1", 3).project.tracks[0].hidden, true);

  // Delete a clip + reorder tracks
  const d = { ...c, tracks: [c.tracks[1], { ...c.tracks[0], clips: c.tracks[0].clips.slice(1) }] };
  assert.equal(pushPatch(store, "s1", c, d, 3, 4).status, "ok");
  assert.deepEqual(store.getMirror("s1", 4).project.tracks.map((t) => t.id), ["t2", "t1"]);
  assert.equal(store.getMirror("s1", 4).hash, projectHash(d));

  // Change aspect ratio: top-level field changed → changedClips passes whole set, pushDiff also accepts it
  const e = { ...d, width: 1280 };
  assert.equal(pushPatch(store, "s1", d, e, 4, 5).status, "ok");
  assert.equal(store.getMirror("s1", 5).project.width, 1280);

  // Older versions are still retained; late-arriving frame-fetch requests can still get them
  assert.deepEqual(store.revsOf("s1"), [1, 2, 3, 4, 5]);
  assert.deepEqual(store.getMirror("s1", 1).project, a);
});

test("resync(409): hash mismatch", () => {
  const store = createMirrorStore();
  const a = project([track("t1", 2)]);
  store.pushFull({ session: "s1", localRev: 1, project: a });
  const b = drag(a, 0, 0, 3);

  const out = store.pushDiff({ session: "s1", fromLocalRev: 1, toLocalRev: 2, hash: "0000000000000000", patch: changedClips(a, b) });
  assert.equal(out.status, "resync");
  assert.equal(out.reason, "hash");
  assert.equal(out.localRev, 1);
  assert.equal(out.hash, projectHash(b));
  assert.equal(store.getMirror("s1", 2), null, "The mismatched version must not be accepted");

  // When page receives 409, it re-pushes in full; same number is accepted as usual
  assert.equal(store.pushFull({ session: "s1", localRev: 2, project: b }).status, "ok");
  assert.deepEqual(store.getMirror("s1", 2).project, b);
});

test("resync(409): the baseline slid out of the window / this session has no version at all", () => {
  const store = createMirrorStore();
  const a = project([track("t1", 2)]);
  assert.equal(store.pushDiff({ session: "new page", fromLocalRev: 0, toLocalRev: 1, patch: changedClips(a, a) }).reason, "session");

  let p = a;
  store.pushFull({ session: "s1", localRev: 1, project: p });
  for (let rev = 2; rev <= 12; rev++) { const n = drag(p, 0, 0, rev); pushPatch(store, "s1", p, n, rev - 1, rev); p = n; }

  // Window is [5..12]; patch using version 3 as baseline cannot recover
  const out = store.pushDiff({ session: "s1", fromLocalRev: 3, toLocalRev: 13, hash: "x", patch: { kind: "tracks", order: null, tracks: [] } });
  assert.equal(out.status, "resync");
  assert.equal(out.reason, "window");
  assert.equal(out.localRev, 12);
});

test("resync(409): the patch references a track / clip that does not exist", () => {
  const store = createMirrorStore();
  store.pushFull({ session: "s1", localRev: 1, project: project([track("t1", 1)]) });
  const out = store.pushDiff({ session: "s1", fromLocalRev: 1, toLocalRev: 2, patch: { kind: "tracks", order: null, tracks: [{ id: "ghost track", props: {} }] } });
  assert.equal(out.status, "resync");
  assert.equal(out.reason, "apply");
  assert.match(out.error, /nonexistent track/);
});

test("Accepted even without a hash (migration period / scripts), but verified whenever one is given", () => {
  const store = createMirrorStore();
  const a = project([track("t1", 1)]);
  const b = drag(a, 0, 0, 2);
  store.pushFull({ session: "s1", localRev: 1, project: a });
  assert.equal(store.pushDiff({ session: "s1", fromLocalRev: 1, toLocalRev: 2, patch: changedClips(a, b) }).status, "ok");
});

test("Pull-back fills in a version (insert): it does not go through the stale gate", () => {
  const store = createMirrorStore();
  let p = project([track("t1", 2)]);
  const v = [null, p];
  store.pushFull({ session: "s1", localRev: 1, project: p });
  for (let rev = 2; rev <= 4; rev++) { const n = drag(p, 0, 0, rev); pushPatch(store, "s1", p, n, rev - 1, rev); p = n; v[rev] = n; }
  // Forwarding for version 5 was lost, version 6 caught up in full: currently missing 5
  const five = drag(p, 0, 0, 5);
  const six = drag(five, 0, 1, 6);
  store.pushFull({ session: "s1", localRev: 6, project: six });
  assert.equal(store.getMirror("s1", 5), null);

  // An in-flight frame-fetch request asks for version 5: pulling back can only use insert;
  // pushFull would block it as out of order
  assert.equal(store.pushFull({ session: "s1", localRev: 5, project: five }).status, "stale");
  assert.equal(store.getMirror("s1", 5), null);
  const out = store.insert({ session: "s1", localRev: 5, project: five });
  assert.equal(out.status, "ok");
  assert.deepEqual(store.getMirror("s1", 5).project, five);
  assert.equal(store.latestMirror().localRev, 6, "Filling in an old version should not touch \"the latest version\"");
  assert.deepEqual(store.revsOf("s1"), [1, 2, 3, 4, 5, 6]);

  // Returns existing entries as-is, without storing duplicates
  assert.equal(store.insert({ session: "s1", localRev: 5, project: five }).status, "ok");
  assert.deepEqual(store.revsOf("s1"), [1, 2, 3, 4, 5, 6]);

  // Older than oldest in window: storing it would be evicted immediately, report directly not caught
  let q = six;
  for (let rev = 7; rev <= 14; rev++) { const n = drag(q, 0, 0, rev); store.pushFull({ session: "s1", localRev: rev, project: n }); q = n; }
  assert.equal(store.revsOf("s1").length, 8);
  assert.equal(store.insert({ session: "s1", localRev: 2, project: v[2] }).status, "resync");
});

test("Playhead: stored separately from the project and follows the current editor page", () => {
  const store = createMirrorStore();
  assert.equal(store.latestPlayhead(), null);

  const head = store.setPlayhead("s1", 3.5, false);
  assert.equal(head.t, 3.5);
  assert.equal(head.playing, false);
  assert.equal(store.latestPlayhead().t, 3.5, "Readable even if no project has been pushed yet (falls back to the one reported most recently)");

  store.pushFull({ session: "s1", localRev: 1, project: project([track("t1", 1)]) });
  assert.equal(store.latestPlayhead().t, 3.5);

  // Report once during playback
  store.setPlayhead("s1", 9, true);
  assert.equal(store.latestPlayhead().playing, true);
  assert.equal(store.latestPlayhead().t, 9);

  // Another tab takes over: whichever latestMirror follows, the playhead follows
  store.pushFull({ session: "s2", localRev: 1, project: project([track("t9", 1)]) });
  store.setPlayhead("s2", 1.25, false);
  assert.equal(store.latestMirror().session, "s2");
  assert.equal(store.latestPlayhead().t, 1.25);
  assert.equal(store.latestPlayhead().session, "s2");

  assert.throws(() => store.setPlayhead("", 1, false), /Missing session/);
  assert.equal(store.setPlayhead("s1", "bad number", false).t, 0, "A reported non-number is treated as 0; do not pass NaN to rendering");
});

test("clear: wipe both tables clean", () => {
  const store = createMirrorStore();
  store.pushFull({ session: "s1", localRev: 1, project: project([track("t1", 1)]) });
  store.setPlayhead("s1", 2, false);
  store.clear();
  assert.equal(store.latestMirror(), null);
  assert.equal(store.latestPlayhead(), null);
  assert.deepEqual(store.allLatest(), []);
});

test("Dragging for 2 seconds: every push is far smaller than 8 KB", () => {
  const store = createMirrorStore();
  // 17 tracks × 10 clips, roughly equivalent to a medium project in the editor
  let p = project(Array.from({ length: 17 }, (_, i) => track(`t${i}`, 10)));
  const full = JSON.stringify({ session: "s1", localRev: 1, project: p }).length;
  store.pushFull({ session: "s1", localRev: 1, project: p });

  // 250 ms debounce, 2 seconds ≈ 8 times
  let worst = 0;
  for (let rev = 2; rev <= 9; rev++) {
    const next = drag(p, 9, 4, rev * 0.1);
    const body = JSON.stringify({ session: "s1", fromLocalRev: rev - 1, toLocalRev: rev, projectHash: projectHash(next), patch: changedClips(p, next) });
    worst = Math.max(worst, body.length);
    assert.equal(pushPatch(store, "s1", p, next, rev - 1, rev).status, "ok");
    p = next;
  }
  assert.ok(worst < 8 * 1024, `The largest push while dragging was ${worst} bytes, over 8 KB`);
  assert.ok(worst * 20 < full, `Delta of ${worst} bytes versus ${full} bytes for the full copy, not enough savings`);
});

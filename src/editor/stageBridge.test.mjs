/**
 * Unit tests for E1's two new entry points + event source filtering.
 * Run: node --test src/editor/stageBridge.test.mjs
 *
 * Pin down three things:
 *   1. `whenStageReady(role)`: gets the client whether called before or after arrival; when the
 *      client changes, it is a new Promise (holders of the old Promise will not be silently
 *      switched to the new iframe);
 *   2. `pushProject` and `syncProject` **share the same baseline**: this is the trap called out in
 *      E0: bypassing the baseline to send setProject directly causes subsequent syncProject calls
 *      to silently skip sending because "unchanged compared to baseline";
 *   3. `onStageEvent` filters by role: drops probe from front iframe and frame from back iframe.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const bridge = await import("./stageBridge.ts");
const { setStageClient, whenStageReady, pushProject, syncProject, pushedProject, onStageEvent, resetStageBridge, backRole, backStage, frontStage } = bridge;

/** Minimal fake RPC client: only records received setProject, and can emit events */
function fakeClient(name) {
  const listeners = new Set();
  return {
    name,
    disposed: false,
    calls: [],
    target: {},
    async setProject(project, opts) { this.calls.push({ project, opts }); return { ok: true }; },
    onEvent(l) { listeners.add(l); return () => listeners.delete(l); },
    emit(e) { for (const l of listeners) l(e); },
    dispose() { this.disposed = true; },
  };
}

const project = (name, clips = []) => ({ version: 1, id: "p", name, width: 1920, height: 1080, fps: 30, duration: 10, themeId: "midnight", media: [], tracks: [{ id: "tr", clips }] });

beforeEach(() => resetStageBridge());

test("whenStageReady: arrive first, call later: gets the current client", async () => {
  const c = fakeClient("A");
  setStageClient("back", c);
  assert.equal(await whenStageReady("back"), c);
});

test("whenStageReady: call first, arrive later: still gets it", async () => {
  const p = whenStageReady("back");
  const c = fakeClient("A");
  setStageClient("back", c);
  assert.equal(await p, c);
});

test("whenStageReady: when the client is replaced it is a new Promise, and the old Promise still holds the old client", async () => {
  const a = fakeClient("A");
  setStageClient("front", a);
  const first = whenStageReady("front");
  assert.equal(await first, a);

  const b = fakeClient("B");
  setStageClient("front", b);
  const second = whenStageReady("front");
  assert.notEqual(second, first, "Replacing the client must produce a new Promise");
  assert.equal(await second, b);
  assert.equal(await first, a, "A caller holding the old Promise must not be moved onto the new iframe");
});

test("whenStageReady: after the client deregisters, it goes back to \"waiting for the next one\"", async () => {
  const a = fakeClient("A");
  setStageClient("back", a);
  const first = whenStageReady("back");
  assert.equal(await first, a);
  setStageClient("back", null);
  const pending = whenStageReady("back");
  assert.notEqual(pending, first);
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(settled, false, "Must not resolve while the slot is empty");
  const b = fakeClient("B");
  setStageClient("back", b);
  assert.equal(await pending, b);
});

test("pushProject(reset) updates the baseline: afterwards syncProject does not resend the same project", async () => {
  const c = fakeClient("A");
  setStageClient("back", c);
  const p1 = project("one");
  await pushProject("back", p1, { reset: true });
  assert.equal(c.calls.length, 1);
  assert.deepEqual(c.calls[0].opts, { reset: true });
  assert.equal(pushedProject("back"), p1);
  await syncProject("back", p1);
  assert.equal(c.calls.length, 1, "Nothing is sent when the baseline is the same");
});

test("Bypassing pushProject makes the baseline inaccurate, so it must share the baseline with syncProject", async () => {
  const c = fakeClient("A");
  setStageClient("back", c);
  const full = project("full");
  await syncProject("back", full);          // baseline = full
  const shrunk = project("shrunk");
  await pushProject("back", shrunk, { reset: true });  // Feed reduced project to probe, baseline updates accordingly
  assert.equal(pushedProject("back"), shrunk);
  await syncProject("back", full);          // Switch back after measuring: baseline is shrunk, so it will actually send
  assert.equal(c.calls.length, 3, "The switch back to the full project must really be sent");
  assert.equal(pushedProject("back"), full);
});

test("pushProject without reset sends a delta, like syncProject", async () => {
  const c = fakeClient("A");
  setStageClient("front", c);
  const p1 = project("one", [{ id: "c1", cardId: "punch-pill", start: 0, end: 5, params: {} }]);
  await pushProject("front", p1);
  assert.equal(c.calls[0].opts?.reset, true, "With no baseline, the first send is always the whole project + reset");
  const p2 = { ...p1, tracks: [{ id: "tr", clips: [{ id: "c1", cardId: "punch-pill", start: 0, end: 6, params: {} }] }] };
  await pushProject("front", p2);
  assert.equal(c.calls.length, 2);
  assert.notEqual(c.calls[1].opts?.reset, true, "With a baseline it is a delta patch");
});

test("onStageEvent filters by role: front events are accepted only from the front iframe", () => {
  const f = fakeClient("front");
  const b = fakeClient("back");
  setStageClient("front", f);
  setStageClient("back", b);
  const got = [];
  onStageEvent((e, role) => got.push(`${role}:${e.type}`));

  f.emit({ type: "frame", sec: 1 });         // Accept
  f.emit({ type: "probe-frame", clipId: "c", localFrame: 0, html: "" }); // Drop: probe-frame only recognizes back
  b.emit({ type: "probe-frame", clipId: "c", localFrame: 0, html: "" }); // Accept
  b.emit({ type: "frame", sec: 2 });         // Drop: frame only recognizes front
  f.emit({ type: "ended", sec: 3 });         // Accept
  b.emit({ type: "mediaReady", sec: 0 });    // Accept
  f.emit({ type: "demote", clipId: "c" });   // Accept
  b.emit({ type: "settled", sec: 1, clipIds: [] }); // Drop: settled only recognizes front

  assert.deepEqual(got, ["front:frame", "back:probe-frame", "front:ended", "back:mediaReady", "front:demote"]);
});

test("onStageEvent: after the client is replaced, events from the old iframe no longer come in", () => {
  const a = fakeClient("A");
  setStageClient("front", a);
  const got = [];
  onStageEvent((e) => got.push(e.type));
  a.emit({ type: "frame", sec: 1 });
  setStageClient("front", fakeClient("B"));
  a.emit({ type: "frame", sec: 2 });
  assert.deepEqual(got, ["frame"]);
});

test("backRole / backStage: fall back to front when there is no back (legacy single stage)", () => {
  const f = fakeClient("front");
  setStageClient("front", f);
  assert.equal(backRole(), "front");
  assert.equal(backStage(), f);
  const b = fakeClient("back");
  setStageClient("back", b);
  assert.equal(backRole(), "back");
  assert.equal(backStage(), b);
  assert.equal(frontStage(), f);
});

test("releaseStageClient: the client of an unmounted iframe is removed wherever it sits, and frontStage no longer hands it out", () => {
  const a = fakeClient("A");
  const b = fakeClient("B");
  setStageClient("front", a);
  setStageClient("back", b);
  // After K5 swap, A may be in back position: find position by client, do not guess role by instance name
  bridge.releaseStageClient(b);
  assert.equal(frontStage(), a);
  assert.equal(backRole(), "front", "back is empty, fall back to front");
  bridge.releaseStageClient(a);
  assert.equal(frontStage(), null, "After the visible stage is unmounted, frontStage() must return null, not a client pointing at a closed window");
});

test("releaseStageClient: a client that is in no slot is a no-op (it must not remove the newly registered one by mistake)", () => {
  const old = fakeClient("old");
  const cur = fakeClient("cur");
  setStageClient("front", cur);
  bridge.releaseStageClient(old);
  assert.equal(frontStage(), cur);
});

test("setBeforeFullStagePush runs before full project resets and does not run for track-only patches", async () => {
  const events = [];
  bridge.setBeforeFullStagePush(async (proj) => { events.push(`hook:${proj.name}`); });
  const c = fakeClient("front");
  c.setProject = async function (proj, opts) {
    events.push(`send:${opts?.reset ? "full" : "patch"}`);
    this.calls.push({ project: proj, opts });
    return { ok: true };
  };
  setStageClient("front", c);
  const p1 = project("first", [{ id: "c1", cardId: "punch-pill", start: 0, end: 5, params: {} }]);
  await syncProject("front", p1);
  const p2 = { ...p1, tracks: [{ id: "tr", clips: [{ id: "c1", cardId: "punch-pill", start: 0, end: 6, params: {} }] }] };
  await syncProject("front", p2);
  const p3 = { ...p2, media: [{ id: "m1", kind: "video", name: "a.mp4", url: "/@media/abc" }] };
  await syncProject("front", p3);
  assert.deepEqual(events, ["hook:first", "send:full", "send:patch", "hook:first", "send:full"]);
});

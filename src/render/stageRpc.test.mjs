/**
 * Unit tests for E1 protocol surface. Run: node --test src/render/stageRpc.test.mjs
 *
 * Here we only lock down items that **do not depend on a browser**: which role each of the seven
 * events belongs to (criteria for parent page filtering by event.source), the event whitelist
 * itself, and decoupling stage id from role (`detectHostCapabilities` reads instance name, not role).
 * RPC round trips, role gates, and cross-origin cases are verified in real browsers by
 * scripts/probes/stage-rpc-probe.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { stageEventRole, STAGE_EVENT_TYPES, isStageEvent, isRpcRequest, isRpcReply } = await import("./stageRpc.ts");

test("Each of the seven events only accepts one sender role (E0: without filtering, tick would repeat at the swap beat)", () => {
  // Player stage events
  assert.equal(stageEventRole("frame"), "front");
  assert.equal(stageEventRole("ended"), "front");
  assert.equal(stageEventRole("settled"), "front");
  assert.equal(stageEventRole("demote"), "front");
  // Background stage events
  assert.equal(stageEventRole("mediaReady"), "back");
  assert.equal(stageEventRole("probe"), "back");
  assert.equal(stageEventRole("probe-frame"), "back");
  // M7: Output from generating snapshots only recognizes the background stage
  assert.equal(stageEventRole("bake-frame"), "back");
});

test("The event whitelist is exactly these ten (the seven of E0 + bake-frame of M7 + card-states and sound-state for online execution of user cards and media effect cards), none more, none fewer", () => {
  assert.deepEqual(
    [...STAGE_EVENT_TYPES].sort(),
    ["bake-frame", "card-states", "demote", "ended", "frame", "mediaReady", "probe", "probe-frame", "settled", "sound-state"],
  );
  // The latter two are role-agnostic and sent by both stages: parent page listens directly on
  // respective RPC clients (`STAGE_ANY_ROLE_EVENTS`) instead of filtering by role.
  // Each must be assigned to a role: omit one, and that event will be claimed by both stages as
  // their own.
  for (const type of STAGE_EVENT_TYPES) assert.ok(stageEventRole(type) === "front" || stageEventRole(type) === "back");
});

test("isStageEvent only accepts types in the whitelist; the two RPC message kinds do not leak into the event stream", () => {
  assert.equal(isStageEvent({ type: "frame", sec: 1 }), true);
  assert.equal(isStageEvent({ type: "pc-stage-ready" }), false);
  assert.equal(isStageEvent({ type: "pc-rpc-reply", id: 1, ok: true }), false);
  assert.equal(isStageEvent(null), false);
  assert.equal(isStageEvent("frame"), false);
  assert.equal(isRpcRequest({ type: "pc-rpc", id: 3, method: "setTime", args: [1] }), true);
  assert.equal(isRpcRequest({ type: "pc-rpc", method: "setTime" }), false);
  assert.equal(isRpcReply({ type: "pc-rpc-reply", id: 3, ok: false }), true);
  assert.equal(isRpcReply({ type: "pc-rpc", id: 3 }), false);
});

test("stageId is an instance name, not a role: defaults to A, not front", async () => {
  const { detectHostCapabilities } = await import("./stageRpc.ts");
  const g = globalThis;
  const saved = { location: g.location, navigator: g.navigator, OffscreenCanvas: g.OffscreenCanvas, Worker: g.Worker };
  try {
    Object.defineProperty(g, "location", { value: { search: "?stage=1&id=B&prerender=1" }, configurable: true, writable: true });
    Object.defineProperty(g, "navigator", { value: { userAgent: "Chrome/152", deviceMemory: 32 }, configurable: true, writable: true });
    g.OffscreenCanvas = undefined;
    g.Worker = undefined;
    assert.equal(detectHostCapabilities().stageId, "B");
    assert.equal(detectHostCapabilities().prerender, true);

    Object.defineProperty(g, "location", { value: { search: "?stage=1" }, configurable: true, writable: true });
    assert.equal(detectHostCapabilities().stageId, "A");
    assert.equal(detectHostCapabilities().prerender, false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
    }
  }
});

/*
 * Defense for (2): requests when the target window is closed (iframe removed from DOM) must not
 * hang indefinitely. Previously, after the 3D page unmounted the stage, `play()` hung for a minute
 * with the playhead frozen, because messages sent to the closed window were silently dropped and
 * `call()` rejected only on dispose.
 */
function fakeWindow() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(type, l) { if (type === "message") listeners.add(l); },
    removeEventListener(type, l) { if (type === "message") listeners.delete(l); },
    deliver(source, data) { for (const l of [...listeners]) l({ source, data, origin: "http://stage" }); },
  };
}
function fakeTarget() {
  return { closed: false, sent: [], postMessage(msg) { this.sent.push(msg); } };
}
async function withFakeWindow(fn) {
  const g = globalThis;
  const saved = Object.getOwnPropertyDescriptor(g, "window");
  const win = fakeWindow();
  Object.defineProperty(g, "window", { value: win, configurable: true, writable: true });
  try { await fn(win); } finally {
    if (saved) Object.defineProperty(g, "window", saved); else delete g.window;
  }
}

test("Target window already closed: the request is rejected on the spot as detached and not sent to the window; render still returns aborted", async () => {
  const { createStageRpc } = await import("./stageRpc.ts");
  await withFakeWindow(async (win) => {
    const target = fakeTarget();
    target.closed = true;
    const c = createStageRpc(target, "http://stage");
    await assert.rejects(c.play(0), /detached/);
    assert.deepEqual(await c.render(1), { aborted: true, reason: "detached" });
    assert.equal(target.sent.length, 0, "A closed window should receive nothing");
    assert.equal(c.disposed, true);
    assert.equal(win.listeners.size, 0, "On teardown, the message listener is removed too");
  });
});

test("Window closed while a request is pending: the next sweep rejects it as detached instead of leaving it pending until the next handshake", async (t) => {
  const { createStageRpc, CLOSED_POLL_MS } = await import("./stageRpc.ts");
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withFakeWindow(async () => {
    const target = fakeTarget();
    const c = createStageRpc(target, "http://stage");
    let settled = null;
    c.play(0).then(() => { settled = "resolved"; }, (e) => { settled = String(e.message); });
    assert.equal(target.sent.length, 1);
    target.closed = true;
    t.mock.timers.tick(CLOSED_POLL_MS);
    await new Promise((r) => setImmediate(r));
    assert.match(String(settled), /detached/);
    assert.equal(c.disposed, true);
  });
});

test("A slow request whose window is still open is not killed by the sweep by mistake; when the reply arrives it resolves as usual", async (t) => {
  const { createStageRpc, CLOSED_POLL_MS } = await import("./stageRpc.ts");
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withFakeWindow(async (win) => {
    const target = fakeTarget();
    const c = createStageRpc(target, "http://stage");
    let settled = null;
    c.pause({ atSec: 3 }).then((v) => { settled = v; }, (e) => { settled = e; });
    // Armed stop could wait several seconds in the first place: after ten inspection rounds,
    // it should still be pending
    for (let i = 0; i < 10; i++) t.mock.timers.tick(CLOSED_POLL_MS);
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, null);
    assert.equal(c.disposed, false);
    const id = target.sent[0].id;
    win.deliver(target, { type: "pc-rpc-reply", id, ok: true, result: { ok: true, stoppedAt: 3 } });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(settled, { ok: true, stoppedAt: 3 });
  });
});

test("A live stage lost the setSnapshots reply: bounded failure, the next delivery still works", async (t) => {
  const { createStageRpc, STAGE_UPDATE_TIMEOUT_MS } = await import("./stageRpc.ts");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await withFakeWindow(async (win) => {
    const target = fakeTarget();
    const c = createStageRpc(target, "http://stage");
    const lost = c.setSnapshots({ h: "old" });
    t.mock.timers.tick(STAGE_UPDATE_TIMEOUT_MS);
    await assert.rejects(lost, /timed out/);
    const retry = c.setSnapshots({ h: "new" }, { reset: true });
    win.deliver(target, { type: "pc-rpc-reply", id: target.sent.at(-1).id, ok: true, result: { ok: true, bytes: 3 } });
    assert.deepEqual(await retry, { ok: true, bytes: 3 });
    c.dispose();
  });
});

test("setTime with a probe is not judged by duration: a slow K1 measurement on a heavy card is not killed by mistake", async (t) => {
  const { createStageRpc, STAGE_UPDATE_TIMEOUT_MS, isShortStageUpdate } = await import("./stageRpc.ts");
  assert.equal(isShortStageUpdate("setTime", [1]), true);
  assert.equal(isShortStageUpdate("setTime", [1, { probe: true }]), false);
  assert.equal(isShortStageUpdate("render", [1]), false);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await withFakeWindow(async (win) => {
    const target = fakeTarget();
    const c = createStageRpc(target, "http://stage");
    let settled = null;
    const slow = c.setTime(0.5, { probe: true }).then((v) => { settled = v; }, (e) => { settled = e; });
    t.mock.timers.tick(STAGE_UPDATE_TIMEOUT_MS * 4);
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, null);
    win.deliver(target, { type: "pc-rpc-reply", id: target.sent.at(-1).id, ok: true, result: { path: "set", stepMs: 30000 } });
    await slow;
    assert.deepEqual(settled, { path: "set", stepMs: 30000 });
    c.dispose();
  });
});

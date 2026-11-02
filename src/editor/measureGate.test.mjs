/**
 * Measurement start gate (`measureGate.ts`; measurement on online page starts only after card
 * sources finish syncing for the first time). Run:
 *   node --experimental-test-module-mocks --test src/editor/measureGate.test.mjs
 *
 *   MG-01 Desktop (not online page): open from the start, waiting for gate returns immediately
 *   MG-02 Online page: closed; opens once card sources sync successfully for the first time,
 *         reason synced; once open, never closes
 *   MG-03 Online page: opens even if first sync returns failure, reason failed
 *   MG-04 Online page: no response, opens on its own upon reaching `MEASURE_GATE_MAX_MS`,
 *         reason timeout
 *   MG-05 `OnlineCardSources.onFirstSettled`: rounds not connected to shared project do not count;
 *         calls true once after listing and fetching complete; calls false once if list cannot
 *         be fetched; calls only once
 *   MG-07 Per connection: on connection change (switching project, reconnecting, leaving and
 *         re-entering) gate closes again, opens only when new connection's first sync produces
 *         results; outdated results do not count; waits up to same limit at most, opens as usual
 *         on failure; does not close when disconnected; desktop never closes
 *   MG-08 `OnlineCardSources`: connection changed, calls `onFirstSettled` again on first round
 *         of new connection, passing new connection
 *   MG-06 Wiring: resident probe waits for this gate after background stage is ready; single-stage
 *         bounds search does not start if gate is not open; gate closes when online page starts
 *         syncing card sources, opens upon results (`probeRunner.ts` reads `import.meta.env`,
 *         cannot be loaded in Node, verified against source here)
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const G = await import(srcUrl("editor/measureGate.ts"));
const F = await import(srcUrl("online/pageFlag.ts"));
const S = await import(srcUrl("editor/sync/onlineCardSources.ts"));
const R = await import(srcUrl("kernel/registry.ts"));

/** Manual timer: `fire()` runs all due timers */
function fakeClock() {
  let now = 0;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
    pending: () => timers.size,
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test("MG-01 desktop: open from the start", async () => {
  delete globalThis.__pcOnlinePage;
  G.resetMeasureGate();
  assert.equal(G.measureGateOpen(), true);
  await G.whenMeasureGateOpen();
  assert.equal(G.measureGateDiag().reason, "desktop");
  // Desktop also called hold (will not happen, but even if called, does not close back)
  G.holdMeasureForCardSources();
  assert.equal(G.measureGateOpen(), true);
});

test("MG-02 online page: opens only after the first sync succeeds; once open it never closes", async () => {
  F.markOnlinePage();
  const clock = fakeClock();
  G.resetMeasureGate(clock);
  try {
    assert.equal(G.measureGateOpen(), false, "The online page starts closed");
    let opened = false;
    const wait = G.whenMeasureGateOpen().then(() => { opened = true; });
    G.holdMeasureForCardSources();
    clock.advance(5000);
    await flush();
    assert.equal(opened, false, "5 s without the sync finishing: still closed");
    G.releaseMeasureGate(true);
    await wait;
    assert.equal(opened, true);
    const d = G.measureGateDiag();
    assert.equal(d.reason, "synced");
    assert.equal(d.waitedMs, 5000);
    assert.equal(clock.pending(), 0, "The fallback timer was cleared");
    G.holdMeasureForCardSources();
    G.releaseMeasureGate(false);
    assert.equal(G.measureGateOpen(), true, "Once open, never closes again");
    assert.equal(G.measureGateDiag().reason, "synced", "The reason is unchanged");
  } finally {
    delete globalThis.__pcOnlinePage;
    G.resetMeasureGate();
  }
});

test("MG-03 online page: opens even when the first sync returns a failure", async () => {
  F.markOnlinePage();
  const clock = fakeClock();
  G.resetMeasureGate(clock);
  try {
    G.holdMeasureForCardSources();
    assert.equal(G.measureGateOpen(), false);
    G.releaseMeasureGate(false);
    await G.whenMeasureGateOpen();
    assert.equal(G.measureGateDiag().reason, "failed");
  } finally {
    delete globalThis.__pcOnlinePage;
    G.resetMeasureGate();
  }
});

test("MG-04 online page: no reply at all, opens on its own once the cap is reached", async () => {
  F.markOnlinePage();
  const clock = fakeClock();
  G.resetMeasureGate(clock);
  try {
    assert.equal(G.MEASURE_GATE_MAX_MS, 10_000);
    // Nobody called hold (`Preview` not yet mounted): closes itself and starts timing on first gate query
    assert.equal(G.measureGateOpen(), false);
    clock.advance(G.MEASURE_GATE_MAX_MS - 1);
    assert.equal(G.measureGateOpen(), false);
    clock.advance(1);
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().reason, "timeout");
  } finally {
    delete globalThis.__pcOnlinePage;
    G.resetMeasureGate();
  }
});

test("MG-05 OnlineCardSources.onFirstSettled", async () => {
  const src = `export const c = { id: "s", name: "Sync", defaults: {}, controls: [], Component: V };`;
  let fail = false;
  const request = async (msg) => {
    if (fail) throw new Error("Not connected");
    if (msg.type === "content.list") return { type: "content.listing", items: [{ key: "src/cards/user/s.tsx", hash: "h1" }] };
    return { type: "content.item", key: msg.key, body: src, hash: "h1" };
  };
  // Rounds not connected to shared project do not count; calls true once after listing and fetching
  // complete; does not call again afterwards
  {
    let link = null;
    const calls = [];
    const s = new S.OnlineCardSources({ request, linkKey: () => link, onFirstSettled: (ok) => calls.push(ok), apply: () => false });
    await s.sync();
    assert.deepEqual(calls, [], "Not connected yet: does not count");
    link = { id: 1 };
    await s.sync();
    assert.deepEqual(calls, [true]);
    await s.sync();
    fail = true;
    await s.sync();
    assert.deepEqual(calls, [true], "Called only once");
    fail = false;
    s.stop();
  }
  // Cannot fetch on the very first try: calls false once
  {
    const link = { id: 2 };
    const calls = [];
    fail = true;
    const s = new S.OnlineCardSources({ request, linkKey: () => link, onFirstSettled: (ok) => calls.push(ok), apply: () => false });
    await s.sync();
    assert.deepEqual(calls, [false]);
    fail = false;
    await s.sync();
    assert.deepEqual(calls, [false], "Not called again even after a later success");
    s.stop();
  }
  // Malformed response also counts as failure
  {
    const link = { id: 3 };
    const calls = [];
    const s = new S.OnlineCardSources({ request: async () => ({ type: "error" }), linkKey: () => link, onFirstSettled: (ok) => calls.push(ok), apply: () => false });
    await s.sync();
    assert.deepEqual(calls, [false]);
    s.stop();
  }
  R.setSyncedUserCards([]);
});

test("MG-06 wiring (checked against the source)", () => {
  const read = (rel) => fs.readFileSync(fileURLToPath(srcUrl(rel)), "utf8");
  const runner = read("editor/probeRunner.ts");
  const loop = runner.slice(runner.indexOf("async function runLoop"));
  const ready = loop.indexOf('await whenStageReady("back")');
  const gate = loop.indexOf("await whenMeasureGateOpen()");
  const firstCosts = loop.indexOf("await getCosts()");
  assert.ok(ready >= 0 && gate > ready && gate < firstCosts, "Resident probe: waits for the gate after the background stage is ready and before the first cost record fetch");
  const preview = read("editor/Preview.tsx");
  // Two places for bounds search: when both stages have records (first), and with only one stage
  // (later); both must wait for the gate
  const dualAt = preview.indexOf("setSearchCostStore(l2SearchCostStore())");
  const singleAt = preview.lastIndexOf("setSearchCostStore(l2SearchCostStore())");
  assert.ok(dualAt >= 0 && singleAt > dualAt, "Both bounds searches are present");
  const single = preview.slice(singleAt);
  const tick = single.slice(single.indexOf("const tick = async"), single.indexOf("runCostSearch({"));
  assert.match(tick, /if \(!measureGateOpen\(\)\) return;/, "Single-stage bounds search: does not start work while the gate is closed");
  const dualTick = preview.slice(preview.lastIndexOf("const tick = async", dualAt), dualAt);
  assert.match(dualTick, /!measureGateOpen\(\)\) return;/, "Dual-stage bounds search: does not start work while the gate is closed");
  const sources = preview.slice(preview.indexOf("new OnlineCardSources({") - 400, preview.indexOf("new OnlineCardSources({") + 400);
  assert.match(sources, /holdMeasureForCardSources\(\)/, "Closes the gate when card source sync starts");
  assert.match(sources, /onFirstSettled: \(ok, link\) => releaseMeasureGate\(ok, link\)/, "Opens the gate as soon as the first sync of each connection has a result");
  assert.match(sources, /setMeasureGateLink\(linkKey\)/, "The gate is tracked per connection: it attaches to the current connection");
  assert.match(loop, /for \(;;\) \{[\s\S]{0,400}await whenMeasureGateOpen\(\);/, "Resident probe waits for the gate at the start of every round (when the gate closes again after a connection change, it waits for the new project)");
  assert.match(loop, /if \(gen !== generation \|\| !measureGateOpen\(\)\) break;/, "If the gate closes again within a round, stop");
});

test("MG-07 per connection: after a connection change the gate closes again and waits until the card source sync of the new connection finishes", async () => {
  F.markOnlinePage();
  const clock = fakeClock();
  G.resetMeasureGate(clock);
  const L1 = { id: 1 }, L2 = { id: 2 }, L3 = { id: 3 };
  let link = null;
  G.setMeasureGateLink(() => link);
  try {
    G.holdMeasureForCardSources();
    link = L1;
    assert.equal(G.measureGateOpen(), false);
    G.releaseMeasureGate(true, L1);
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().holds, 1);
    // Switch project: connection changes to L2 → closes again when gate is queried
    link = L2;
    let opened = false;
    const wait = G.whenMeasureGateOpen().then(() => { opened = true; });
    assert.equal(G.measureGateOpen(), false, "Connection changed: the gate closes again");
    assert.equal(G.measureGateDiag().holds, 2);
    G.releaseMeasureGate(true, L1);
    await flush();
    assert.equal(opened, false, "Results coming back from the old connection do not count");
    clock.advance(G.MEASURE_GATE_MAX_MS - 1);
    assert.equal(G.measureGateOpen(), false);
    G.releaseMeasureGate(true, L2);
    await wait;
    assert.equal(G.measureGateOpen(), true, "New connection finished syncing: open");
    assert.equal(G.measureGateDiag().reason, "synced");
    // Does not close again for the same connection
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().holds, 2);
    // Leave project (disconnected): does not close; re-enter (new connection L3): closes, opens on its
    // own upon timeout if no response
    link = null;
    assert.equal(G.measureGateOpen(), true, "Not connected: does not close");
    link = L3;
    assert.equal(G.measureGateOpen(), false, "Leave and re-enter: closed");
    clock.advance(G.MEASURE_GATE_MAX_MS);
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().reason, "timeout");
    assert.equal(G.measureGateOpen(), true, "A gate opened by timeout also counts as opened for L3, and never closes again");
    // New connection's first sync returned failure: opens as usual
    const L4 = { id: 4 };
    link = L4;
    assert.equal(G.measureGateOpen(), false);
    G.releaseMeasureGate(false, L4);
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().reason, "failed");
    // New connection result arrives while gate is open (nobody queried gate yet): record it opened for
    // this, do not close afterwards
    const L5 = { id: 5 };
    link = L5;
    const linksBefore = G.measureGateDiag().links;
    G.releaseMeasureGate(true, L5);
    assert.equal(G.measureGateOpen(), true, "Gate queried after the new connection has already finished syncing: does not close");
    assert.equal(G.measureGateDiag().links, linksBefore + 1, "Records that the gate was opened for the new connection");
  } finally {
    delete globalThis.__pcOnlinePage;
    G.resetMeasureGate();
  }
  // Desktop: never closes even if given a connection
  G.resetMeasureGate();
  let dl = { id: "a" };
  G.setMeasureGateLink(() => dl);
  assert.equal(G.measureGateOpen(), true);
  dl = { id: "b" };
  assert.equal(G.measureGateOpen(), true, "Desktop: does not close even after a connection change");
  G.resetMeasureGate();
});

test("MG-08 OnlineCardSources: after a connection change, the first round of the new connection calls onFirstSettled once more", async () => {
  const src = `export const c = { id: "s", name: "Sync", defaults: {}, controls: [], Component: V };`;
  const request = async (msg) => msg.type === "content.list"
    ? { type: "content.listing", items: [{ key: "src/cards/user/s.tsx", hash: "h1" }] }
    : { type: "content.item", key: msg.key, body: src, hash: "h1" };
  const L1 = { id: 1 }, L2 = { id: 2 };
  let link = L1;
  const calls = [];
  const s = new S.OnlineCardSources({ request, linkKey: () => link, onFirstSettled: (ok, l) => calls.push([ok, l]), apply: () => false });
  await s.sync();
  await s.sync();
  assert.deepEqual(calls, [[true, L1]]);
  link = L2;
  await s.sync();
  await s.sync();
  assert.deepEqual(calls, [[true, L1], [true, L2]], "Called once more for the new connection, passing the new connection");
  link = null;
  await s.sync();
  assert.equal(calls.length, 2, "Not called when not connected");
  link = L1;
  await s.sync();
  assert.deepEqual(calls.at(-1), [true, L1], "Leave and re-enter: called once more");
  s.stop();
  R.setSyncedUserCards([]);
});

/**
 * 测量的开工门(`measureGate.ts`;在线页面的测量等卡片源码第一次同步完再开始)。跑:
 *   node --experimental-test-module-mocks --test src/editor/measureGate.test.mjs
 *
 *   MG-01 桌面(不是在线页面):一开始就开着,等门马上回
 *   MG-02 在线页面:关着;卡片源码第一次同步成功就开,原因 synced;开了不再关
 *   MG-03 在线页面:第一次同步回了失败也开,原因 failed
 *   MG-04 在线页面:一直没回音,满 `MEASURE_GATE_MAX_MS` 自己开,原因 timeout
 *   MG-05 `OnlineCardSources.onFirstSettled`:没连上共享项目的那几轮不算;列完取完叫一次 true;列表取不到叫一次 false;只叫一次
 *   MG-07 按连接算:换了连接(换项目、重连、离开再进)门重新关上,新连接第一次同步有结果才开;过时的结果不算;
 *         最多等同样的上限、失败了照常开;没连着不关;桌面从不关
 *   MG-08 `OnlineCardSources`:连接换了,新连接的第一轮再叫一次 `onFirstSettled`,带上新连接
 *   MG-06 接线:常驻探针在后台舞台就绪之后等这道门;单舞台的界限搜索门没开不开工;在线页面开始同步卡片源码时关门、有结果开门
 *         (`probeRunner.ts` 读 `import.meta.env`,Node 里载不进来,这里按源码核)
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

/** 手动的计时器:`fire()` 把到点的都跑掉 */
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
  // 桌面也叫了 hold(不会发生,但叫了也不关回去)
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
    // 没人叫 hold(`Preview` 还没挂上):第一次问门时自己关上、开始计时
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
  // 没连上共享项目的那几轮不算;连上后列完取完叫一次 true;之后不再叫
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
  // 第一次就取不到:叫一次 false
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
  // 回包不对也算失败
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
  // 界限搜索有两处:两个舞台有记录时(先出现)、只有一个舞台时(后出现);两处都要等门
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
    // 换项目:连接换成 L2 → 问门时重新关上
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
    // 同一条连接不再关
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().holds, 2);
    // 离开项目(没连着):不关;再进(新连接 L3):关,一直没回音满上限自己开
    link = null;
    assert.equal(G.measureGateOpen(), true, "Not connected: does not close");
    link = L3;
    assert.equal(G.measureGateOpen(), false, "Leave and re-enter: closed");
    clock.advance(G.MEASURE_GATE_MAX_MS);
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().reason, "timeout");
    assert.equal(G.measureGateOpen(), true, "A gate opened by timeout also counts as opened for L3, and never closes again");
    // 新连接第一次同步回了失败:照常开
    const L4 = { id: 4 };
    link = L4;
    assert.equal(G.measureGateOpen(), false);
    G.releaseMeasureGate(false, L4);
    assert.equal(G.measureGateOpen(), true);
    assert.equal(G.measureGateDiag().reason, "failed");
    // 门开着时新连接的结果先到(还没人问门):记下为它开的,之后不再关
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
  // 桌面:给了连接也从不关
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

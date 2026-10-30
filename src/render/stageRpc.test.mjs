/**
 * E1 协议面的单测。跑:node --test src/render/stageRpc.test.mjs
 *
 * 这里只钉**不依赖浏览器**的那几条:七种事件各归哪个角色(父页按 event.source 过滤的判据)、
 * 事件白名单本身、以及舞台 id 与角色脱钩(`detectHostCapabilities` 读的是实例名,不是角色)。
 * RPC 往返、角色闸门、跨源那几条由 scripts/probes/stage-rpc-probe.mjs 在真浏览器里验。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { stageEventRole, STAGE_EVENT_TYPES, isStageEvent, isRpcRequest, isRpcReply } = await import("./stageRpc.ts");

test("七种事件各只认一个角色发来的(E0:不过滤就会在互换那一拍重复 tick)", () => {
  // 播放器舞台的事
  assert.equal(stageEventRole("frame"), "front");
  assert.equal(stageEventRole("ended"), "front");
  assert.equal(stageEventRole("settled"), "front");
  assert.equal(stageEventRole("demote"), "front");
  // 后台舞台的事
  assert.equal(stageEventRole("mediaReady"), "back");
  assert.equal(stageEventRole("probe"), "back");
  assert.equal(stageEventRole("probe-frame"), "back");
  // M7:生成快照的产出只认后台舞台
  assert.equal(stageEventRole("bake-frame"), "back");
});

test("事件白名单就是这十种(E0 的七种 + M7 的 bake-frame + 在线执行用户卡与素材效果卡的 card-states、sound-state),一个不多一个不少", () => {
  assert.deepEqual(
    [...STAGE_EVENT_TYPES].sort(),
    ["bake-frame", "card-states", "demote", "ended", "frame", "mediaReady", "probe", "probe-frame", "settled", "sound-state"],
  );
  // 后两种不分角色、两台都发:父页在各自的 RPC 客户端上直接听(`STAGE_ANY_ROLE_EVENTS`),不靠按角色过滤
  // 每一种都能分到一个角色:漏一种,那种事件就会被两个舞台都当成自己的
  for (const type of STAGE_EVENT_TYPES) assert.ok(stageEventRole(type) === "front" || stageEventRole(type) === "back");
});

test("isStageEvent 只认白名单里的 type,RPC 的两种消息不混进事件流", () => {
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

test("stageId 是实例名不是角色:缺省给 A,不给 front", async () => {
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
 * ② 的防线:目标窗口关了(iframe 被拿出 DOM)的请求不能永远挂着。
 * 以前 3D 页卸掉舞台之后 `play()` 挂了一分钟、播放头纹丝不动,就是因为发进关掉的窗口的消息
 * 被静默丢弃,而 `call()` 只有 dispose 才会回绝。
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

test("目标窗口已经关了:请求当场按 detached 回绝,不发进窗口;render 照旧回 aborted", async () => {
  const { createStageRpc } = await import("./stageRpc.ts");
  await withFakeWindow(async (win) => {
    const target = fakeTarget();
    target.closed = true;
    const c = createStageRpc(target, "http://stage");
    await assert.rejects(c.play(0), /detached/);
    assert.deepEqual(await c.render(1), { aborted: true, reason: "detached" });
    assert.equal(target.sent.length, 0, "关掉的窗口一条都不该发");
    assert.equal(c.disposed, true);
    assert.equal(win.listeners.size, 0, "收摊时把 message 监听一起摘掉");
  });
});

test("请求挂着时窗口关了:下一次巡检就按 detached 回绝,不再挂到下一次握手", async (t) => {
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

test("窗口还开着的慢请求不被巡检误杀;回包到了照常 resolve", async (t) => {
  const { createStageRpc, CLOSED_POLL_MS } = await import("./stageRpc.ts");
  t.mock.timers.enable({ apis: ["setInterval"] });
  await withFakeWindow(async (win) => {
    const target = fakeTarget();
    const c = createStageRpc(target, "http://stage");
    let settled = null;
    c.pause({ atSec: 3 }).then((v) => { settled = v; }, (e) => { settled = e; });
    // 武装停本来就可能等好几秒:巡检转十圈,它还该挂着
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

test("活着的舞台丢了 setSnapshots 回包:有界失败,下一次仍能投递", async (t) => {
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

test("带 probe 的 setTime 不按时长判:重卡的 K1 测量很慢也不被误杀", async (t) => {
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

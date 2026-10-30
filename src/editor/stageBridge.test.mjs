/**
 * E1 的两个新口子 + 事件来源过滤的单测。跑:node --test src/editor/stageBridge.test.mjs
 *
 * 钉三件事:
 *   1. `whenStageReady(role)` —— 先叫后到、先到后叫都能拿到客户端,客户端换了就是一个新的
 *      Promise(拿着旧 Promise 的人不会被偷偷换到新 iframe 上);
 *   2. `pushProject` 和 `syncProject` **共用同一份基线** —— 这是 E0 点名的坑:绕过基线
 *      直接发 setProject,之后的 syncProject 会因为「和基线比没变」静默不发;
 *   3. `onStageEvent` 按角色过滤:front 的 iframe 发 probe、back 的 iframe 发 frame 都丢掉。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const bridge = await import("./stageBridge.ts");
const { setStageClient, whenStageReady, pushProject, syncProject, pushedProject, onStageEvent, resetStageBridge, backRole, backStage, frontStage } = bridge;

/** 最小的假 RPC 客户端:只记下收到的 setProject,并能往外发事件 */
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

test("whenStageReady:先到后叫拿到的是当前客户端", async () => {
  const c = fakeClient("A");
  setStageClient("back", c);
  assert.equal(await whenStageReady("back"), c);
});

test("whenStageReady:先叫后到也能拿到", async () => {
  const p = whenStageReady("back");
  const c = fakeClient("A");
  setStageClient("back", c);
  assert.equal(await p, c);
});

test("whenStageReady:客户端换了就是一个新的 Promise,旧 Promise 还是旧客户端", async () => {
  const a = fakeClient("A");
  setStageClient("front", a);
  const first = whenStageReady("front");
  assert.equal(await first, a);

  const b = fakeClient("B");
  setStageClient("front", b);
  const second = whenStageReady("front");
  assert.notEqual(second, first, "换客户端要换一个新的 Promise");
  assert.equal(await second, b);
  assert.equal(await first, a, "拿着旧 Promise 的调用方不该被换到新 iframe 上");
});

test("whenStageReady:客户端注销之后回到「等下一个」", async () => {
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
  assert.equal(settled, false, "位置空着时不该 resolve");
  const b = fakeClient("B");
  setStageClient("back", b);
  assert.equal(await pending, b);
});

test("pushProject(reset) 更新基线:之后 syncProject 同一份项目不再重发", async () => {
  const c = fakeClient("A");
  setStageClient("back", c);
  const p1 = project("one");
  await pushProject("back", p1, { reset: true });
  assert.equal(c.calls.length, 1);
  assert.deepEqual(c.calls[0].opts, { reset: true });
  assert.equal(pushedProject("back"), p1);
  await syncProject("back", p1);
  assert.equal(c.calls.length, 1, "基线相同就什么都不发");
});

test("绕过 pushProject 会让基线失准 —— 所以它必须和 syncProject 共用基线", async () => {
  const c = fakeClient("A");
  setStageClient("back", c);
  const full = project("full");
  await syncProject("back", full);          // 基线 = full
  const shrunk = project("shrunk");
  await pushProject("back", shrunk, { reset: true });  // 探针灌缩水项目,基线跟着换
  assert.equal(pushedProject("back"), shrunk);
  await syncProject("back", full);          // 量完换回来:基线是 shrunk,所以真的会发
  assert.equal(c.calls.length, 3, "换回全量项目那一次必须真的发出去");
  assert.equal(pushedProject("back"), full);
});

test("pushProject 不带 reset 时走增量,和 syncProject 一样", async () => {
  const c = fakeClient("A");
  setStageClient("front", c);
  const p1 = project("one", [{ id: "c1", cardId: "punch-pill", start: 0, end: 5, params: {} }]);
  await pushProject("front", p1);
  assert.equal(c.calls[0].opts?.reset, true, "没有基线时第一次一律整份 + reset");
  const p2 = { ...p1, tracks: [{ id: "tr", clips: [{ id: "c1", cardId: "punch-pill", start: 0, end: 6, params: {} }] }] };
  await pushProject("front", p2);
  assert.equal(c.calls.length, 2);
  assert.notEqual(c.calls[1].opts?.reset, true, "有基线时是增量补丁");
});

test("onStageEvent 按角色过滤:front 的事件只认 front 的 iframe", () => {
  const f = fakeClient("front");
  const b = fakeClient("back");
  setStageClient("front", f);
  setStageClient("back", b);
  const got = [];
  onStageEvent((e, role) => got.push(`${role}:${e.type}`));

  f.emit({ type: "frame", sec: 1 });         // 收
  f.emit({ type: "probe-frame", clipId: "c", localFrame: 0, html: "" }); // 丢:probe-frame 只认 back
  b.emit({ type: "probe-frame", clipId: "c", localFrame: 0, html: "" }); // 收
  b.emit({ type: "frame", sec: 2 });         // 丢:frame 只认 front
  f.emit({ type: "ended", sec: 3 });         // 收
  b.emit({ type: "mediaReady", sec: 0 });    // 收
  f.emit({ type: "demote", clipId: "c" });   // 收
  b.emit({ type: "settled", sec: 1, clipIds: [] }); // 丢:settled 只认 front

  assert.deepEqual(got, ["front:frame", "back:probe-frame", "front:ended", "back:mediaReady", "front:demote"]);
});

test("onStageEvent:客户端换掉之后旧 iframe 的事件不再进来", () => {
  const a = fakeClient("A");
  setStageClient("front", a);
  const got = [];
  onStageEvent((e) => got.push(e.type));
  a.emit({ type: "frame", sec: 1 });
  setStageClient("front", fakeClient("B"));
  a.emit({ type: "frame", sec: 2 });
  assert.deepEqual(got, ["frame"]);
});

test("backRole / backStage:没有 back 时退回 front(legacy 的单舞台)", () => {
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

test("releaseStageClient:卸掉的 iframe 的客户端不管落在哪个位置都摘下,frontStage 不再交出它", () => {
  const a = fakeClient("A");
  const b = fakeClient("B");
  setStageClient("front", a);
  setStageClient("back", b);
  // K5 互换之后 A 可能在 back 位置上:按客户端找位置,不按实例名猜角色
  bridge.releaseStageClient(b);
  assert.equal(frontStage(), a);
  assert.equal(backRole(), "front", "back 空了,退回 front");
  bridge.releaseStageClient(a);
  assert.equal(frontStage(), null, "可见舞台卸掉之后 frontStage() 必须回 null,而不是一个指向已关窗口的客户端");
});

test("releaseStageClient:不在任何位置上的客户端是空操作(不误摘新登记的那个)", () => {
  const old = fakeClient("old");
  const cur = fakeClient("cur");
  setStageClient("front", cur);
  bridge.releaseStageClient(old);
  assert.equal(frontStage(), cur);
});
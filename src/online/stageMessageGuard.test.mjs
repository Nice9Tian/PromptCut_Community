/**
 * 父页对舞台消息的校验(契约 `docs/plan/online-card-exec-contract.md` 第 3.2 节「协议面」):跨源舞台里会执行用户卡与素材效果卡,
 * 它发来的一切当不可信输入 —— 来源、形状、白名单、数字的范围。
 * 跑:node --test src/online/stageMessageGuard.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE_MESSAGE_LIMITS as L, sanitizeStageEvent, sanitizeRpcResult, sanitizeRpcError, sanitizeHostCapabilities } from "./stageMessageGuard.ts";

const HASH = "a".repeat(64);
/** 每种舞台事件一份合法的样本(新增事件类型时这里与 `sanitizeStageEvent` 都要补) */
const SAMPLES = {
  mediaReady: { type: "mediaReady", sec: 1.5 },
  frame: { type: "frame", sec: 2 },
  ended: { type: "ended", sec: 30 },
  settled: { type: "settled", sec: 1, clipIds: ["a", "b"] },
  probe: { type: "probe", identityKey: "{\"card\":\"x\"}", fps: 30, stepMs: 3, inlineMs: 1, rasterMs: 2, serializeMs: 1, catchUpMs: 0, kind: "stepped", capped: false, vtOk: true, seekOk: true, seekMs: 4 },
  demote: { type: "demote", clipId: "c1" },
  "probe-frame": { type: "probe-frame", clipId: "c1", localFrame: 3, html: "<div>x</div>", htmlGz: new ArrayBuffer(8) },
  "bake-frame": { type: "bake-frame", session: "s1", clipId: "c1", localFrame: 3, hash: HASH, bytes: 100, htmlGz: new ArrayBuffer(8), small: { hash: HASH, bytes: 10, webp: new ArrayBuffer(4) } },
  "card-states": { type: "card-states", states: [["card-a", { state: "ready" }], ["card-b", { state: "load-error", detail: "boom", file: "src/cards/user/b.tsx" }]], graph: "ok", visual: true },
  "sound-state": { type: "sound-state", state: { ready: { "card-a": "k3" }, blocked: { "card-b": "载入时出错" } } },
};

test("OCS-M-09 在线执行的两种事件:运行状态只认名单上的十种、文字截短;声音状态只留短文字;形状不对整条丢弃", () => {
  const long = "x".repeat(5000);
  const clean = sanitizeStageEvent({ type: "card-states", states: [["a", { state: "load-error", detail: long, file: long, version: long, ticket: "v1.a.b" }]], graph: "software", visual: false, extra: 1 });
  assert.deepEqual(Object.keys(clean), ["type", "states", "graph", "visual"]);
  assert.deepEqual(Object.keys(clean.states[0][1]), ["state", "detail", "file", "version"]);
  assert.equal(clean.states[0][1].detail.length, 300);
  assert.equal(clean.states[0][1].file.length, 200);
  assert.equal(clean.states[0][1].version.length, 64);
  for (const bad of [
    { type: "card-states", states: [["a", { state: "god-mode" }]], graph: "ok", visual: true },
    { type: "card-states", states: [["a", { state: "ready" }]], graph: "rtx", visual: true },
    { type: "card-states", states: [["a", { state: "ready" }]], graph: "ok", visual: "yes" },
    { type: "card-states", states: [["", { state: "ready" }]], graph: "ok", visual: true },
    { type: "card-states", states: [["a", { state: "ready", detail: 7 }]], graph: "ok", visual: true },
    { type: "card-states", states: { a: { state: "ready" } }, graph: "ok", visual: true },
    { type: "card-states", states: Array.from({ length: 501 }, (_, i) => [`c${i}`, { state: "ready" }]), graph: "ok", visual: true },
    { type: "sound-state", state: { ready: { a: 1 }, blocked: {} } },
    { type: "sound-state", state: { ready: [], blocked: {} } },
    { type: "sound-state", state: "ready" },
    { type: "sound-state" },
  ]) assert.equal(sanitizeStageEvent(bad), null, JSON.stringify(bad).slice(0, 120));
  assert.deepEqual(sanitizeStageEvent({ type: "sound-state", state: null }), { type: "sound-state", state: null });
  const sound = sanitizeStageEvent({ type: "sound-state", state: { ready: { a: long }, blocked: { b: long }, ticket: "v1.a.b" } });
  assert.deepEqual(Object.keys(sound.state), ["ready", "blocked"]);
  assert.equal(sound.state.ready.a.length, 64);
  assert.equal(sound.state.blocked.b.length, 240);
});

test("OCS-M-01 白名单:舞台协议里的每一种事件都有校验,合法的原样通过;不在名单上的、不是对象的一律丢弃", async () => {
  const { STAGE_EVENT_TYPES } = await import("../render/stageRpc.ts");
  for (const type of STAGE_EVENT_TYPES) {
    assert.ok(SAMPLES[type], `事件 ${type} 没有样本:给 stageMessageGuard.ts 的 sanitizeStageEvent 补上它的校验,再在这里补样本(不补的话跨源舞台发来的这种事件会被丢掉)`);
    assert.deepEqual(sanitizeStageEvent(SAMPLES[type]), SAMPLES[type], type);
  }
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...STAGE_EVENT_TYPES].sort());
  for (const bad of [null, undefined, 42, "frame", [], {}, { type: 7 }, { type: "pc-give-me-the-ticket" }, { type: "auth.ticket", kind: "asset" }, { type: "__proto__" }, { type: "setMediaPolicy" }]) {
    assert.equal(sanitizeStageEvent(bad), null, JSON.stringify(bad));
  }
});

test("OCS-M-02 形状:回的是只含认得的字段的新对象;多出来的字段(伪造的票据、原型)带不过去", () => {
  const dirty = JSON.parse('{"type":"frame","sec":1,"ticket":"v1.a.b","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}');
  const clean = sanitizeStageEvent(dirty);
  assert.deepEqual(Object.keys(clean), ["type", "sec"]);
  assert.notEqual(clean, dirty);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(sanitizeStageEvent({ ...SAMPLES.probe, extra: "x", ticket: "v1.a.b" })).includes("ticket"), false);
  // 选填的字段类型不对:整条丢弃(不猜)
  assert.equal(sanitizeStageEvent({ ...SAMPLES.probe, seekMs: "4" }), null);
  assert.equal(sanitizeStageEvent({ ...SAMPLES["probe-frame"], htmlGz: "not a buffer" }), null);
  assert.equal(sanitizeStageEvent({ ...SAMPLES["bake-frame"], small: { hash: "zz", bytes: 1, webp: new ArrayBuffer(1) } }), null);
  assert.equal(sanitizeStageEvent({ ...SAMPLES["bake-frame"], small: null }).small, null);
});

test("OCS-M-03 数字钳到合理范围:时间不为负、不过一天;耗时不为负、十分钟封顶;不是有限数整条丢弃", () => {
  assert.equal(sanitizeStageEvent({ type: "frame", sec: 1e99 }).sec, L.maxSec);
  assert.equal(sanitizeStageEvent({ type: "frame", sec: -5 }).sec, 0);
  // 给了项目时长:舞台报的时刻带不出时间轴(播放头最多到末尾)
  for (const type of ["frame", "ended", "mediaReady"]) assert.equal(sanitizeStageEvent({ type, sec: 1e99 }, { maxSec: 6 }).sec, 6, type);
  assert.equal(sanitizeStageEvent({ type: "settled", sec: 1e99, clipIds: [] }, { maxSec: 6 }).sec, 6);
  assert.equal(sanitizeStageEvent({ type: "frame", sec: 3 }, { maxSec: 6 }).sec, 3);
  for (const maxSec of [NaN, -1, Infinity, undefined]) assert.equal(sanitizeStageEvent({ type: "frame", sec: 1e99 }, { maxSec }).sec, L.maxSec, String(maxSec));
  for (const sec of [NaN, Infinity, -Infinity, "1", null, undefined, {}, { valueOf: () => 1 }]) assert.equal(sanitizeStageEvent({ type: "frame", sec }), null, String(sec));
  // 进成本记录的那几个数
  const huge = sanitizeStageEvent({ ...SAMPLES.probe, stepMs: 7.77e98, inlineMs: -7.77e98, rasterMs: 1e12, serializeMs: L.maxMs + 1, catchUpMs: -1, fps: 1e9, seekMs: 7.77e98 });
  assert.deepEqual({ stepMs: huge.stepMs, inlineMs: huge.inlineMs, rasterMs: huge.rasterMs, serializeMs: huge.serializeMs, catchUpMs: huge.catchUpMs, fps: huge.fps, seekMs: huge.seekMs },
    { stepMs: L.maxMs, inlineMs: 0, rasterMs: L.maxMs, serializeMs: L.maxMs, catchUpMs: 0, fps: 240, seekMs: L.maxMs });
  for (const k of ["stepMs", "inlineMs", "rasterMs", "serializeMs", "catchUpMs", "fps"]) {
    for (const v of [NaN, Infinity, "1", null, {}]) assert.equal(sanitizeStageEvent({ ...SAMPLES.probe, [k]: v }), null, `${k}=${String(v)}`);
  }
  assert.equal(sanitizeStageEvent({ ...SAMPLES.probe, kind: "evil" }), null);
  // 帧号取整并钳住
  assert.equal(sanitizeStageEvent({ ...SAMPLES["probe-frame"], localFrame: 3.9 }).localFrame, 3);
  assert.equal(sanitizeStageEvent({ ...SAMPLES["bake-frame"], localFrame: 1e99 }).localFrame, L.maxFrame);
  assert.equal(sanitizeStageEvent({ ...SAMPLES["bake-frame"], bytes: 7.77e98 }).bytes, L.maxBufferBytes);
  assert.equal(sanitizeStageEvent({ ...SAMPLES["bake-frame"], bytes: -1 }).bytes, 0);
});

test("OCS-M-04 长度上限:片段 id、成本身份、片段数、快照 HTML、字节块超了就丢弃;哈希必须是 64 位十六进制", () => {
  assert.equal(sanitizeStageEvent({ type: "demote", clipId: "x".repeat(L.maxIdLength + 1) }), null);
  assert.equal(sanitizeStageEvent({ type: "demote", clipId: { toString: () => "c" } }), null);
  assert.equal(sanitizeStageEvent({ type: "settled", sec: 1, clipIds: new Array(L.maxClipIds + 1).fill("a") }), null);
  assert.equal(sanitizeStageEvent({ type: "settled", sec: 1, clipIds: ["a", 1] }), null);
  assert.equal(sanitizeStageEvent({ type: "settled", sec: 1, clipIds: "a" }), null);
  assert.equal(sanitizeStageEvent({ ...SAMPLES.probe, identityKey: "x".repeat(L.maxIdentityLength + 1) }), null);
  assert.equal(sanitizeStageEvent({ ...SAMPLES["probe-frame"], html: "x".repeat(L.maxHtmlLength + 1) }), null);
  for (const hash of ["zz", HASH.toUpperCase(), HASH.slice(1), `${HASH}0`, 1, null]) assert.equal(sanitizeStageEvent({ ...SAMPLES["bake-frame"], hash }), null, String(hash));
  // 带脚本的 HTML 只是一段字符串:校验不执行它、也不改它(父页不把它放进活文档,由安全探针断言)
  const xss = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
  assert.equal(sanitizeStageEvent({ ...SAMPLES["probe-frame"], html: xss }).html, xss);
});

test("OCS-M-05 RPC 回包:只许普通对象、数组、字符串、布尔、null、有限数与字节块;耗时类的数钳到 [0, 十分钟]", () => {
  const r = sanitizeRpcResult("render", { elapsedMs: -1e99, steps: [1e99, NaN, Infinity, 5], snapshot: { inlineMs: 7.77e98, rasterMs: -1, serializeMs: 3 }, glGpuMs: { cardA: 1e99, cardB: -3 }, html: "<div/>", ok: true, n: 1e99, nested: { ms: -1 } });
  assert.deepEqual(r, { elapsedMs: 0, steps: [L.maxMs, 0, 0, 5], snapshot: { inlineMs: L.maxMs, rasterMs: 0, serializeMs: 3 }, glGpuMs: { cardA: L.maxMs, cardB: 0 }, html: "<div/>", ok: true, n: L.maxAbs, nested: { ms: 0 } });
  // 不是计时的方法:数字只钳绝对值,不动符号
  assert.deepEqual(sanitizeRpcResult("measure", { elapsedMs: -5, x: -1e99, y: NaN }), { elapsedMs: -5, x: -L.maxAbs, y: 0 });
  for (const v of [null, undefined, true, "ok", 3]) assert.equal(sanitizeRpcResult("play", v), v);
  const buf = new ArrayBuffer(16);
  assert.equal(sanitizeRpcResult("bakeFrame", { htmlGz: buf }).htmlGz, buf);
  // 不认得的东西:抛(调用方把这次调用按失败回绝)
  class Evil { constructor() { this.x = 1; } }
  for (const bad of [{ f: () => 1 }, { s: Symbol("x") }, { d: new Date() }, { m: new Map() }, { e: new Evil() }, { big: 10n }]) assert.throws(() => sanitizeRpcResult("render", bad), /stage rpc/, Object.keys(bad)[0]);
  assert.throws(() => sanitizeRpcResult("render", { s: "x".repeat(L.maxHtmlLength + 1) }), /太长/);
  assert.throws(() => sanitizeRpcResult("render", { b: new ArrayBuffer(L.maxBufferBytes + 1) }), /太大/);
  let deep = {};
  for (let i = 0; i < L.maxDepth + 2; i++) deep = { deep };
  assert.throws(() => sanitizeRpcResult("render", deep), /太深/);
  assert.throws(() => sanitizeRpcResult("render", new Array(L.maxNodes + 1).fill(0)), /太大/);
  // 出错信息只留一段不长的字符串
  assert.equal(sanitizeRpcError("boom"), "boom");
  assert.equal(sanitizeRpcError("x".repeat(5000)).length, 2001);
  for (const bad of [null, undefined, 42, { message: "x" }]) assert.equal(sanitizeRpcError(bad), undefined);
});

test("OCS-M-06 握手里的宿主能力表:只认六项、各按类型收;多出来的字段不带", () => {
  assert.deepEqual(sanitizeHostCapabilities({ prerender: true, offscreenGl: true, compact: true, glRoute: "shared", lowest: true, measure: true, catchUp: true, stageId: "B", ticket: "v1.a.b" }),
    { prerender: true, offscreenGl: true, compact: true, glRoute: "shared", lowest: true, measure: true, catchUp: true, stageId: "B" });
  assert.deepEqual(sanitizeHostCapabilities({ prerender: "yes", offscreenGl: 1, compact: { a: 1 }, glRoute: "evil", lowest: "1", measure: [], catchUp: null, stageId: "Z" }),
    { prerender: false, offscreenGl: false, compact: false, glRoute: null, lowest: false, measure: false, catchUp: false, stageId: "A" });
  for (const bad of [null, undefined, "caps", 42, [], "x".repeat(1024 * 1024)]) assert.equal(sanitizeHostCapabilities(bad), null);
});

/* ------------------------------------------------------------------ RPC 客户端的不可信模式 */
function fakeWindow() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(type, l) { if (type === "message") listeners.add(l); },
    removeEventListener(type, l) { if (type === "message") listeners.delete(l); },
    deliver(source, data, origin) { for (const l of [...listeners]) l({ source, data, origin }); },
  };
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
const STAGE = "https://s1.x.io";

test("OCS-M-07 跨源舞台的 RPC 客户端:只认 event.source 是那个舞台、event.origin 是配置里那个舞台源的消息", async () => {
  const { createStageRpc } = await import("../render/stageRpc.ts");
  await withFakeWindow(async (win) => {
    const target = { closed: false, sent: [], postMessage(msg, origin) { this.sent.push({ msg, origin }); } };
    const c = createStageRpc(target, STAGE, { untrusted: true, maxSec: () => 6 });
    const events = [];
    c.onEvent((e) => events.push(e));
    const call = c.play(0);
    const { msg, origin } = target.sent.at(-1);
    assert.equal(origin, STAGE, "请求只发给那个舞台源");
    let settled = null;
    void call.then((v) => { settled = { ok: v }; }, (e) => { settled = { err: e.message }; });
    // 来源不对:别的窗口、对的窗口但别的源(舞台被带到别处去了)—— 都不认
    win.deliver({ other: true }, { type: "pc-rpc-reply", id: msg.id, ok: true, result: { hijack: 1 } }, STAGE);
    win.deliver(target, { type: "pc-rpc-reply", id: msg.id, ok: true, result: { hijack: 2 } }, "https://evil.io");
    win.deliver(target, { type: "pc-rpc-reply", id: msg.id, ok: true, result: { hijack: 3 } }, "null");
    win.deliver(target, { type: "frame", sec: 9 }, "https://evil.io");
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, null, "来源不对的回包不结算这次调用");
    assert.deepEqual(events, []);
    // 来源对:事件按形状收(超范围的钳住、认不出的丢掉),回包照常
    win.deliver(target, { type: "frame", sec: 1e99, ticket: "v1.a.b" }, STAGE);
    win.deliver(target, { type: "pc-give-me-the-ticket" }, STAGE);
    win.deliver(target, { type: "probe", identityKey: "k", fps: 30, stepMs: Infinity, inlineMs: 1, rasterMs: 1, serializeMs: 1, catchUpMs: 0, kind: "stepped" }, STAGE);
    assert.deepEqual(events, [{ type: "frame", sec: 6 }], "时刻钳到项目时长以内");
    win.deliver(target, { type: "pc-rpc-reply", id: msg.id, ok: true, result: { ok: true } }, STAGE);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(settled, { ok: { ok: true } });
    c.dispose();
  });
});

test("OCS-M-08 跨源舞台的 RPC 回包:形状不对按失败回绝,计时类的数钳住;同源的客户端(桌面、单舞台)照旧原样收", async () => {
  const { createStageRpc } = await import("../render/stageRpc.ts");
  await withFakeWindow(async (win) => {
    const target = { closed: false, sent: [], postMessage(msg) { this.sent.push(msg); } };
    const c = createStageRpc(target, STAGE, { untrusted: true });
    const p1 = c.render(1);
    win.deliver(target, { type: "pc-rpc-reply", id: target.sent.at(-1).id, ok: true, result: { elapsedMs: 7.77e98, steps: [-1, 2] } }, STAGE);
    assert.deepEqual(await p1, { elapsedMs: 600_000, steps: [0, 2] });
    const p2 = c.render(2);
    win.deliver(target, { type: "pc-rpc-reply", id: target.sent.at(-1).id, ok: true, result: { when: new Date() } }, STAGE);
    await assert.rejects(p2, /stage rpc/);
    const p3 = c.play(0);
    win.deliver(target, { type: "pc-rpc-reply", id: target.sent.at(-1).id, ok: false, error: { toString: () => "x" } }, STAGE);
    await assert.rejects(p3, /stage rpc play failed/);
    c.dispose();

    // 不给 untrusted:一个字节不变(桌面运行环境、同源单舞台)
    const t2 = { closed: false, sent: [], postMessage(msg) { this.sent.push(msg); } };
    const plain = createStageRpc(t2, "http://stage");
    const raw = { elapsedMs: -5, when: new Date(0) };
    const p4 = plain.render(1);
    win.deliver(t2, { type: "pc-rpc-reply", id: t2.sent.at(-1).id, ok: true, result: raw }, "http://anything");
    assert.equal(await p4, raw);
    const seen = [];
    plain.onEvent((e) => seen.push(e));
    win.deliver(t2, { type: "frame", sec: 1e99 }, "http://anything");
    assert.deepEqual(seen, [{ type: "frame", sec: 1e99 }]);
    plain.dispose();
  });
});

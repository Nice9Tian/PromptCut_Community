/**
 * C6.6 设计稿第 9 节第 1 条:页面把共享项目的素材服务交给编辑器进程的上传队列(`assetTiers.ts` 的 `startUploadTarget`)。
 * 跑:node --test src/editor/media/uploadTarget.test.mjs
 * 计时器、时钟、推送都注入假的;`fetch` 换成记录用的假件。
 */
import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const T = await import("./assetTiers.ts");

const TTL = 15 * 60_000;

function fakeClock() {
  let now = 1_000_000;
  const timers = [];
  return {
    now: () => now,
    advance(ms) { now += ms; },
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    timers,
    /** 触发到期的第一个计时器 */
    async fire() { const t = timers.shift(); now = Math.max(now, t.at); t.fn(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); },
  };
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };

test("C66-I1-02 进入共享项目:签 rw 素材票据,把 { base, ticket } 推给编辑器进程;剩 1/3 有效期时续签再推;离开推 { base: null }", async () => {
  const clk = fakeClock();
  const posts = [];
  const asks = [];
  let n = 0;
  const link = { request: async (msg) => { asks.push(msg); n++; return { type: "auth.ticket.ok", ticket: `rw-${n}`, exp: clk.now() + TTL }; } };
  const stop = T.startUploadTarget(link, "http://10.0.0.9:5460/api/asset", { post: async (b) => { posts.push(b); }, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  await flush();
  assert.deepEqual(asks, [{ type: "auth.ticket", kind: "asset", access: "rw" }], "票据要能写(rw)");
  assert.deepEqual(posts, [{ base: "http://10.0.0.9:5460/api/asset", ticket: "rw-1" }]);
  assert.equal(clk.timers.length, 1);
  assert.equal(clk.timers[0].ms, TTL * 2 / 3, "从签发起过 2/3 寿命(剩 1/3)时续签");
  await clk.fire();
  await flush();
  assert.deepEqual(posts.at(-1), { base: "http://10.0.0.9:5460/api/asset", ticket: "rw-2" }, "续签后再推一次");
  stop();
  await flush();
  assert.deepEqual(posts.at(-1), { base: null }, "离开共享项目:上传目标换回本机");
  assert.equal(clk.timers.length, 0, "停下后不再续签");
  stop();
  await flush();
  assert.equal(posts.filter((p) => p.base === null).length, 1, "重复停止只推一次");
});

test("C66-I1-03 签不到票据:仍推基址(票据 null),30 s 后再签;挑不到远程素材服务(本机就是主机):只推 { base: null }", async () => {
  const clk = fakeClock();
  const posts = [];
  const link = { request: async () => ({ type: "error", reason: "forbidden" }) };
  const stop = T.startUploadTarget(link, "http://h:1/api/asset", { post: async (b) => { posts.push(b); }, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  await flush();
  assert.deepEqual(posts, [{ base: "http://h:1/api/asset", ticket: null }]);
  assert.equal(clk.timers[0].ms, 30_000);
  stop();
  const posts2 = [];
  T.startUploadTarget(link, null, { post: async (b) => { posts2.push(b); } });
  await flush();
  assert.deepEqual(posts2, [{ base: null }]);
});

test("C66-I1-04 connectSharedAssets / disconnectSharedAssets 接上上传目标:进入推远程基址与 rw 票据,离开推 null(经 /api/media/upload-queue/target)", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true, complete: false }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const link = {
      request: async (msg) => msg.type === "service.watch"
        ? { type: "service.endpoints", endpoints: [{ kind: "asset", urls: ["http://10.0.0.9:5460/api/asset"] }] }
        : { type: "auth.ticket.ok", ticket: `t-${msg.access}`, exp: Date.now() + TTL },
    };
    await T.connectSharedAssets(link, "http://10.0.0.9:5460/");
    await flush();
    const target = calls.filter((c) => c.url === "/api/media/upload-queue/target");
    assert.deepEqual(target.map((c) => c.body), [{ base: "http://10.0.0.9:5460/api/asset", ticket: "t-rw" }]);
    T.disconnectSharedAssets();
    await flush();
    const after = calls.filter((c) => c.url === "/api/media/upload-queue/target").map((c) => c.body);
    assert.deepEqual(after.at(-1), { base: null });
  } finally {
    T.resetAssetTiersForTest();
    await flush();
    globalThis.fetch = realFetch;
  }
});

/**
 * C6.6 design doc section 9 item 1: page hands shared project asset service to editor process
 * upload queue (`startUploadTarget` in `assetTiers.ts`).
 * Run: node --test src/editor/media/uploadTarget.test.mjs
 * Timers, clock, and push are all injected with fakes; `fetch` is replaced with a fake for recording.
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
    /** Triggers the first expired timer */
    async fire() { const t = timers.shift(); now = Math.max(now, t.at); t.fn(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); },
  };
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };

test("C66-I1-02 enter a shared project: sign an rw asset ticket and push { base, ticket } to the editor process; renew and push again when 1/3 of its validity is left; push { base: null } on leaving", async () => {
  const clk = fakeClock();
  const posts = [];
  const asks = [];
  let n = 0;
  const link = { request: async (msg) => { asks.push(msg); n++; return { type: "auth.ticket.ok", ticket: `rw-${n}`, exp: clk.now() + TTL }; } };
  const stop = T.startUploadTarget(link, "http://10.0.0.9:5460/api/asset", { post: async (b) => { posts.push(b); }, now: clk.now, setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  await flush();
  assert.deepEqual(asks, [{ type: "auth.ticket", kind: "asset", access: "rw" }], "The ticket must be writable (rw)");
  assert.deepEqual(posts, [{ base: "http://10.0.0.9:5460/api/asset", ticket: "rw-1" }]);
  assert.equal(clk.timers.length, 1);
  assert.equal(clk.timers[0].ms, TTL * 2 / 3, "Renew once 2/3 of the lifetime has passed since issue (1/3 left)");
  await clk.fire();
  await flush();
  assert.deepEqual(posts.at(-1), { base: "http://10.0.0.9:5460/api/asset", ticket: "rw-2" }, "Push once more after renewing");
  stop();
  await flush();
  assert.deepEqual(posts.at(-1), { base: null }, "Leaving the shared project: the upload target switches back to this machine");
  assert.equal(clk.timers.length, 0, "No more renewals after stopping");
  stop();
  await flush();
  assert.equal(posts.filter((p) => p.base === null).length, 1, "Repeated stops push only once");
});

test("C66-I1-03 cannot get a ticket: still push the base address (ticket null), sign again after 30 s; cannot pick a remote asset service (this machine is the host): push only { base: null }", async () => {
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

test("C66-I1-04 connectSharedAssets / disconnectSharedAssets hook up the upload target: entering pushes the remote base address and an rw ticket, leaving pushes null (via /api/media/upload-queue/target)", async () => {
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

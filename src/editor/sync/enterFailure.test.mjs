/**
 * 进入共享项目时 WebSocket 没建成的判定（`enterFailure.ts`，`claude/join-error`）。跑：
 *   node --test src/editor/sync/enterFailure.test.mjs
 *
 * 修前 `enterShared` 把「打开前就断」一律判成 auth（页面说「用户名或密码不对」）；修后先问 `shared/verify`：
 * 服务端认这份证明 → 连不上；服务端明确 401 → 仍是 auth。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { classifyEnterFailure, classifyProtocolError } = await import(srcUrl("editor/sync/enterFailure.ts"));

/** 浏览器里握手被拒、证书不对、代理挡了升级、网络不通,看到的都是这个 */
const NEVER_OPENED = { code: 1006, reason: "", fatal: false, neverOpened: true };
const httpErr = (status, extra = {}) => Object.assign(new Error(`Responded ${status}`), { status, ...extra });

function deps({ verify = async () => true, fresh = async () => ["promptcut.v1", "promptcut.auth.x"], kicked = false } = {}) {
  const calls = { fresh: 0, verify: [] };
  return {
    calls,
    d: {
      fresh: async () => {
        calls.fresh++;
        return fresh();
      },
      verify: async (p) => {
        calls.verify.push(p);
        return verify(p);
      },
      wasKicked: () => kicked,
    },
  };
}

test("dropped before opening, the server accepts this proof (account and password are fine) → unreachable, not auth", async () => {
  const { d, calls } = deps({ verify: async () => true });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, d), { error: "unreachable" });
  assert.equal(calls.fresh, 1, "fetched a fresh proof");
  assert.deepEqual(calls.verify, [["promptcut.v1", "promptcut.auth.x"]], "asked using the fresh proof");
});

test("dropped before opening, and verify is also unreachable when asked (network error, no status) → unreachable", async () => {
  const { d } = deps({ verify: async () => { throw new TypeError("Failed to fetch"); } });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, d), { error: "unreachable" });
});

test("unreachable while fetching a fresh proof → unreachable; rate limiting → rate-limited with seconds; project gone → no-project", async () => {
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ fresh: async () => { throw new TypeError("Failed to fetch"); } }).d), { error: "unreachable" });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ fresh: async () => { throw httpErr(429, { retryAfter: 30 }); } }).d), { error: "rate-limited", retryAfter: 30 });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ fresh: async () => { throw httpErr(404); } }).d), { error: "no-project" });
});

test("server explicitly reports authentication failure (verify 401) → still classified as auth; one that was kicked is classified as kicked", async () => {
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ verify: async () => false }).d), { error: "auth" });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ verify: async () => false, kicked: true }).d), { error: "kicked" });
});

test("verify rate-limited → rate-limited; 5xx → unreachable; old service without verify (404) → auth as before", async () => {
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ verify: async () => { throw httpErr(429, { retryAfter: 12 }); } }).d), { error: "rate-limited", retryAfter: 12 });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ verify: async () => { throw httpErr(503); } }).d), { error: "unreachable" });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ verify: async () => { throw httpErr(404); } }).d), { error: "auth" });
});

test("15 seconds without connecting or dropping → unreachable, no further asking; 4004 received before opening → project gone", async () => {
  const t = deps();
  assert.deepEqual(await classifyEnterFailure({ code: 0, reason: "timeout", fatal: false, neverOpened: true }, t.d), { error: "unreachable" });
  assert.equal(t.calls.fresh, 0);
  assert.deepEqual(await classifyEnterFailure({ code: 4004, reason: "", fatal: true, neverOpened: true }, deps().d), { error: "no-project" });
});

test("A reconnect challenge that clearly returns 401/403/404/410 must terminate; 429, 5xx and network loss can still retry", async () => {
  for (const [status, expected] of [[401, "auth"], [403, "kicked"], [404, "no-project"], [410, "no-project"]]) {
    const error = httpErr(status);
    assert.equal(classifyProtocolError(error), expected);
    assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ fresh: async () => { throw error; } }).d), { error: expected });
  }
  for (const error of [httpErr(429), httpErr(503), new TypeError("network unavailable")]) assert.equal(classifyProtocolError(error), null);
});

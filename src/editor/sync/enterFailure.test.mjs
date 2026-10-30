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
const httpErr = (status, extra = {}) => Object.assign(new Error(`回 ${status}`), { status, ...extra });

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

test("打开前就断、服务端认这份证明(账号密码没问题)→ 连不上,不是 auth", async () => {
  const { d, calls } = deps({ verify: async () => true });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, d), { error: "unreachable" });
  assert.equal(calls.fresh, 1, "取了一份新证明");
  assert.deepEqual(calls.verify, [["promptcut.v1", "promptcut.auth.x"]], "拿新证明去问");
});

test("打开前就断、问 verify 时也连不上(网络错误,没有 status)→ 连不上", async () => {
  const { d } = deps({ verify: async () => { throw new TypeError("Failed to fetch"); } });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, d), { error: "unreachable" });
});

test("取新证明时连不上 → 连不上;限速 → rate-limited 带秒数;项目没了 → no-project", async () => {
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ fresh: async () => { throw new TypeError("Failed to fetch"); } }).d), { error: "unreachable" });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ fresh: async () => { throw httpErr(429, { retryAfter: 30 }); } }).d), { error: "rate-limited", retryAfter: 30 });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ fresh: async () => { throw httpErr(404); } }).d), { error: "no-project" });
});

test("服务端明确回认证失败(verify 401)→ 仍判 auth;被踢过的判 kicked", async () => {
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ verify: async () => false }).d), { error: "auth" });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ verify: async () => false, kicked: true }).d), { error: "kicked" });
});

test("verify 限速 → rate-limited;5xx → 连不上;旧服务没有 verify(404)→ 照旧 auth", async () => {
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ verify: async () => { throw httpErr(429, { retryAfter: 12 }); } }).d), { error: "rate-limited", retryAfter: 12 });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ verify: async () => { throw httpErr(503); } }).d), { error: "unreachable" });
  assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ verify: async () => { throw httpErr(404); } }).d), { error: "auth" });
});

test("15 秒没连上也没断 → 连不上,不再去问;打开前收到 4004 → 项目没了", async () => {
  const t = deps();
  assert.deepEqual(await classifyEnterFailure({ code: 0, reason: "timeout", fatal: false, neverOpened: true }, t.d), { error: "unreachable" });
  assert.equal(t.calls.fresh, 0);
  assert.deepEqual(await classifyEnterFailure({ code: 4004, reason: "", fatal: true, neverOpened: true }, deps().d), { error: "no-project" });
});

test("重连挑战明确401/403/404/410必须终止；429、5xx和断网仍可重试", async () => {
  for (const [status, expected] of [[401, "auth"], [403, "kicked"], [404, "no-project"], [410, "no-project"]]) {
    const error = httpErr(status);
    assert.equal(classifyProtocolError(error), expected);
    assert.deepEqual(await classifyEnterFailure(NEVER_OPENED, deps({ fresh: async () => { throw error; } }).d), { error: expected });
  }
  for (const error of [httpErr(429), httpErr(503), new TypeError("network unavailable")]) assert.equal(classifyProtocolError(error), null);
});

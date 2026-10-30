/**
 * C10a `/api` 守卫在桌面运行环境不拦（`docs/plan/c10a-contract.md` 第 2 节：桌面构建与开发服务照旧）。
 * 跑：node --experimental-test-module-mocks --test src/online/c10a-api-guard-desktop.test.mjs
 *
 * `src/online/mode.ts` 换成 `{ ONLINE: false }`。约定同 `c10a-api-guard.test.mjs`（K6）。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { exists, skipIf, findApiGuard, repoUrl } from "../../server/test/c10a-kit.mjs";

let guard = null;
if (exists("src/online/mode.ts")) {
  mock.module(srcUrl("online/mode.ts"), { exports: { ONLINE: false } });
  guard = await findApiGuard((rel) => import(repoUrl(rel)));
}
const skip = skipIf(!guard, "src/online/ 下的 /api 守卫（K6）");

test("C10A-API-06 桌面运行环境（ONLINE = false）：装了守卫也不拦 /api/", { skip }, async () => {
  const passed = [];
  const real = globalThis.fetch;
  globalThis.window ??= globalThis;
  globalThis.fetch = async (input) => { passed.push(String(input)); return new Response("{}"); };
  try {
    guard.fn();
    const r = await globalThis.fetch("/api/docservice/device");
    assert.equal(r.status, 200);
    assert.deepEqual(passed, ["/api/docservice/device"]);
  } finally {
    globalThis.fetch = real;
  }
});

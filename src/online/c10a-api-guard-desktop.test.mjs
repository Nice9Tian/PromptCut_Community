/**
 * C10a `/api` guard does not block in desktop runtime environment (`docs/plan/c10a-contract.md`
 * section 2: desktop build and dev server as usual).
 * Run: node --experimental-test-module-mocks --test src/online/c10a-api-guard-desktop.test.mjs
 *
 * `src/online/mode.ts` replaced with `{ ONLINE: false }`. Contract same as `c10a-api-guard.test.mjs` (K6).
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
const skip = skipIf(!guard, "/api guard under src/online/ (K6)");

test("C10A-API-06 desktop runtime (ONLINE = false): the guard does not block /api/ even when installed", { skip }, async () => {
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

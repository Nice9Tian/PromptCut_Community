/**
 * 导出页里的等待按真时间算(`src/export/realClock.ts`;起因见 `docs/reports/AGENT-browser-export-hang.md`)。
 * 跑:node --test src/export/realClock.test.mjs
 *
 *   RC-01 `performance.now` 与 `Date.now` 都被钉住时,`waitReal` 照样按真时间到时限、回 false(不无限等)
 *   RC-02 条件成立就回 true;条件晚一点成立也等得到
 *   RC-03 `realNow` 优先用导出时钟接管前存下的 `__pcRealDateNow`
 *   RC-04 导出页(`ExportView.tsx`)的初始化里不再拿 `performance.now()` 算等待时限(回归:576ad0a3 的两处死等)
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const R = await import(srcUrl("export/realClock.ts"));

test("RC-01 When the clock is pinned, waitReal still times out in real time", async () => {
  const realDateNow = Date.now.bind(Date);
  const realPerfNow = performance.now.bind(performance);
  globalThis.__pcRealDateNow = realDateNow;
  // 模拟导出页:两个钟都钉在 0(项目载入后 __pcExportMs = 0)
  performance.now = () => 0;
  Date.now = () => 0;
  try {
    const t0 = realDateNow();
    const ok = await R.waitReal(() => false, 80, { tickMs: 5 });
    const took = realDateNow() - t0;
    assert.equal(ok, false);
    assert.ok(took >= 70 && took < 5000, `Should time out after about 80ms, actual ${took}ms`);
  } finally {
    performance.now = realPerfNow;
    Date.now = realDateNow;
    delete globalThis.__pcRealDateNow;
  }
});

test("RC-02 Returns true once the condition holds, and also catches a condition that holds a little later", async () => {
  assert.equal(await R.waitReal(() => true, 0), true);
  let n = 0;
  assert.equal(await R.waitReal(() => ++n >= 3, 10_000, { tickMs: 1 }), true);
  assert.equal(n, 3);
  // 注入的钟:到时限就停
  let t = 0;
  const sleeps = [];
  const ok = await R.waitReal(() => false, 100, { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += 40; }, tickMs: 40 });
  assert.equal(ok, false);
  assert.equal(sleeps.length, 3);
});

test("RC-03 realNow prefers __pcRealDateNow", () => {
  globalThis.__pcRealDateNow = () => 123456;
  try { assert.equal(R.realNow(), 123456); } finally { delete globalThis.__pcRealDateNow; }
  const a = Date.now();
  const b = R.realNow();
  assert.ok(Math.abs(b - a) < 1000);
});

test("RC-04 Export page initialization does not use performance.now() to compute wait time limits", () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ExportView.tsx");
  const src = fs.readFileSync(file, "utf8");
  const bad = src.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) =>
    /while\s*\(.*performance\.now\(\)/.test(l) || /if\s*\(\s*performance\.now\(\)\s*-\s*\w+\s*>/.test(l));
  assert.deepEqual(bad, [], "In the export page performance.now is pinned by the export clock, so computing time limits with it waits forever; use waitReal from export/realClock.ts instead");
});

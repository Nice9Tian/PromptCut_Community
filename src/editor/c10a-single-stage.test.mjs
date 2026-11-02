/**
 * C10a 在线页面的单舞台 live 预览（`docs/plan/c10a-contract.md` 第 8 节「不开后台舞台：在线页面只有一个同源舞台」、
 * 第 8.1 节「`ONLINE` 时同源单舞台 A 按 live 变体渲……A 就是可见舞台，没有 B」）。
 * 跑：node --experimental-test-module-mocks --test src/editor/c10a-single-stage.test.mjs
 *
 * 假设 K7（`server/test/c10a-kit.mjs`）：仍由 `src/editor/previewMode.ts` 决定开几个舞台、舞台地址带什么——
 *   `dualStage()` 在 `ONLINE` 时恒为 false（就算页面上有舞台端口表）；`stageSrc('A')` 是同源地址，
 *   带 `preview=stage`（「相当于现在双舞台里 `&preview=stage` 的那一份」，舞台据此渲 live 变体）。
 * 2026-10-22：开几个舞台改由舞台闸门的档位定（`src/online/onlineTier.ts`；停在第一级只开跨源单舞台 A），
 * 原来随低内存档来的那个探测改认 `onlineTier.ts`。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { exists, skipIf, TIER_FILE } from "../../server/test/c10a-kit.mjs";
import { resetOnlineStagesForTest } from "../online/stageOrigins.ts";
import { initTier, resetTierForTest } from "../online/onlineTier.ts";

const missing = !exists(TIER_FILE);
const skip = skipIf(missing, `${TIER_FILE} (the single stage is decided by the stage gate's tier, K7)`);

globalThis.window = globalThis;
let pm = null;
if (!missing) {
  mock.module(srcUrl("online/mode.ts"), { exports: { ONLINE: true } });
  pm = await import(srcUrl("editor/previewMode.ts"));
}

beforeEach(() => { resetOnlineStagesForTest(); resetTierForTest(); });

function page({ ports, search = "" }) {
  const loc = { protocol: "https:", hostname: "203-0-113-16.sslip.io", host: "203-0-113-16.sslip.io", origin: "https://203-0-113-16.sslip.io", pathname: "/editor/", search, hash: "" };
  Object.defineProperty(globalThis, "location", { value: loc, configurable: true, writable: true });
  if (ports) globalThis.__PC_STAGE_PORTS__ = ports;
  else delete globalThis.__PC_STAGE_PORTS__;
  return () => { delete globalThis.location; delete globalThis.__PC_STAGE_PORTS__; };
}

test("C10A-GT-07 On the online page every stage is always cross-origin isolated: with no stage origin configured it throws and refuses to fall back to same-origin; once configured, it loads from the cross-origin stage.html", { skip }, () => {
  for (const ports of [undefined, [], [5191, 5192]]) {
    const restore = page({ ports });
    try {
      // 未配置舞台源：禁止退回同源，直接抛错
      resetOnlineStagesForTest({ origins: null });
      assert.equal(pm.dualStage(), false, `Stage port table ${JSON.stringify(ports)}: dual stage is not enabled when no origin is configured`);
      assert.throws(() => pm.stageSrc("A"), /falling back to the same-origin stage is forbidden/);
      assert.throws(() => pm.stageTargetOrigin("A"), /falling back to the same-origin stage is forbidden/);
      assert.equal(pm.interimStage(), false, "interimStage is always false since the interim period was withdrawn");

      // 配置了跨源舞台源：即使是单舞台也是跨源加载 stage.html，绝不退回同源
      resetOnlineStagesForTest({ origins: { A: "https://s1.203-0-113-16.sslip.io", B: "https://s2.203-0-113-16.sslip.io" } });
      const src = pm.stageSrc("A", { dual: false });
      assert.ok(src.startsWith("https://s1.203-0-113-16.sslip.io/stage.html") || src.startsWith("https://s1.203-0-113-16.sslip.io/editor/stage.html"), `A must load from the cross-origin stage.html: ${src}`);
      assert.match(src, /[?&]preview=stage(?:&|$)/, `A renders with the live variant: ${src}`);
      assert.equal(pm.stageTargetOrigin("A"), "https://s1.203-0-113-16.sslip.io");
    } finally {
      restore();
    }
  }
});


test("C10A-GT-07b When the stage gate stops at level 1 (lite, low-spec) only the cross-origin single stage A is opened; at levels 2 and 3 the dual stage is opened; the URL carries the initial render route and the single-stage flag", { skip }, () => {
  const restore = page({});
  try {
    const origins = { A: "https://s1.203-0-113-16.sslip.io", B: "https://s2.203-0-113-16.sslip.io" };
    resetOnlineStagesForTest({ origins, config: "done" });
    initTier({ online: true, target: 1, lowest: null, identity: "desktop" });
    assert.equal(pm.dualStage(), false, "Level 1: single stage");
    const single = pm.stageSrc("A", { dual: false });
    assert.match(single, /[?&]gl=shared(?:&|$)/, `Level 1 shared renderer: ${single}`);
    assert.match(single, /[?&]compact=1(?:&|$)/, `Only one stage: ${single}`);
    assert.doesNotMatch(single, /[?&]lowest=1/, "Not the lowest tier");

    initTier({ online: true, target: 1, lowest: "stage", identity: "phone" });
    assert.match(pm.stageSrc("A", { dual: false }), /[?&]lowest=1(?:&|$)/, "Lowest tier: the stage starts with the small size only");

    initTier({ online: true, target: 3, reached: 1, lowest: null, identity: "desktop" });
    assert.equal(pm.dualStage(), true, "To try level 3: dual stage");
    const a = pm.stageSrc("A", { dual: true });
    assert.match(a, /[?&]gl=shared(?:&|$)/, `Shared renderer before trying level 3 (level 2): ${a}`);
    assert.doesNotMatch(a, /compact=1/);
    assert.match(a, /[?&]dual=1(?:&|$)/);

    initTier({ online: true, target: 3, reached: 3, lowest: null, identity: "desktop" });
    assert.match(pm.stageSrc("B", { dual: true }), /[?&]gl=perDocument(?:&|$)/, "At level 3 each stage gets its own set");

    // 握手失败退回跨源单舞台 A(只管当次)
    resetOnlineStagesForTest({ origins, config: "done", handshake: "failed" });
    assert.equal(pm.dualStage(), false, "Handshake failed: single stage");
    assert.ok(pm.stageSrc("A", { dual: false }).startsWith("https://s1.203-0-113-16.sslip.io/"), "The single stage after falling back is still the cross-origin A");
  } finally {
    restore();
  }
});

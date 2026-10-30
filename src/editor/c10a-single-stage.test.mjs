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
const skip = skipIf(missing, `${TIER_FILE}（单舞台由舞台闸门的档位定，K7）`);

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

test("C10A-GT-07 在线页面所有舞台一律跨源隔离：未配置舞台源抛错拒绝退回同源；配置后从跨源 stage.html 加载", { skip }, () => {
  for (const ports of [undefined, [], [5191, 5192]]) {
    const restore = page({ ports });
    try {
      // 未配置舞台源：禁止退回同源，直接抛错
      resetOnlineStagesForTest({ origins: null });
      assert.equal(pm.dualStage(), false, `舞台端口表 ${JSON.stringify(ports)}：未配置源不开双舞台`);
      assert.throws(() => pm.stageSrc("A"), /禁止退回同源舞台/);
      assert.throws(() => pm.stageTargetOrigin("A"), /禁止退回同源舞台/);
      assert.equal(pm.interimStage(), false, "interimStage 过渡期已撤销恒为 false");

      // 配置了跨源舞台源：即使是单舞台也是跨源加载 stage.html，绝不退回同源
      resetOnlineStagesForTest({ origins: { A: "https://s1.203-0-113-16.sslip.io", B: "https://s2.203-0-113-16.sslip.io" } });
      const src = pm.stageSrc("A", { dual: false });
      assert.ok(src.startsWith("https://s1.203-0-113-16.sslip.io/stage.html") || src.startsWith("https://s1.203-0-113-16.sslip.io/editor/stage.html"), `A 必须从跨源 stage.html 加载：${src}`);
      assert.match(src, /[?&]preview=stage(?:&|$)/, `A 按 live 变体渲：${src}`);
      assert.equal(pm.stageTargetOrigin("A"), "https://s1.203-0-113-16.sslip.io");
    } finally {
      restore();
    }
  }
});


test("C10A-GT-07b 舞台闸门停在第一级（精简、低配）只开跨源单舞台 A；到第二、三级开双舞台；地址带起手的渲染路线与单舞台标记", { skip }, () => {
  const restore = page({});
  try {
    const origins = { A: "https://s1.203-0-113-16.sslip.io", B: "https://s2.203-0-113-16.sslip.io" };
    resetOnlineStagesForTest({ origins, config: "done" });
    initTier({ online: true, target: 1, lowest: null, identity: "desktop" });
    assert.equal(pm.dualStage(), false, "第一级:单舞台");
    const single = pm.stageSrc("A", { dual: false });
    assert.match(single, /[?&]gl=shared(?:&|$)/, `第一级共用渲染器:${single}`);
    assert.match(single, /[?&]compact=1(?:&|$)/, `只有一个舞台:${single}`);
    assert.doesNotMatch(single, /[?&]lowest=1/, "不是最低一档");

    initTier({ online: true, target: 1, lowest: "stage", identity: "phone" });
    assert.match(pm.stageSrc("A", { dual: false }), /[?&]lowest=1(?:&|$)/, "最低一档:舞台起手只用小尺寸");

    initTier({ online: true, target: 3, reached: 1, lowest: null, identity: "desktop" });
    assert.equal(pm.dualStage(), true, "要试到第三级:双舞台");
    const a = pm.stageSrc("A", { dual: true });
    assert.match(a, /[?&]gl=shared(?:&|$)/, `试第三级之前共用渲染器(第二级):${a}`);
    assert.doesNotMatch(a, /compact=1/);
    assert.match(a, /[?&]dual=1(?:&|$)/);

    initTier({ online: true, target: 3, reached: 3, lowest: null, identity: "desktop" });
    assert.match(pm.stageSrc("B", { dual: true }), /[?&]gl=perDocument(?:&|$)/, "到了第三级各一套");

    // 握手失败退回跨源单舞台 A(只管当次)
    resetOnlineStagesForTest({ origins, config: "done", handshake: "failed" });
    assert.equal(pm.dualStage(), false, "握手失败:单舞台");
    assert.ok(pm.stageSrc("A", { dual: false }).startsWith("https://s1.203-0-113-16.sslip.io/"), "退回的单舞台仍是跨源 A");
  } finally {
    restore();
  }
});

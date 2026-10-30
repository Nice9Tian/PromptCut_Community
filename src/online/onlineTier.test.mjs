/**
 * 在线浏览器的档位(`onlineTier.ts`;语义 `product/platforms.md`「在线浏览器」的「名词」)。用例 OT-01～OT-05。
 * 跑:npm test -- src/online/onlineTier.test.mjs
 *
 *   OT-01 四档的名字与气泡文字照用户定的(2026-10-08),一个字不差
 *   OT-02 由状态推出来的:第三级顶配、第二级标准、第一级精简、最低一档低配;路线:第三级各一套,其余共用
 *   OT-03 桌面恒为桌面的样子(双舞台、各一套、不是最低一档、身份电脑)
 *   OT-04 只升不降、试的途中退回、基准卡跑不动进最低一档(只进不出)
 *   OT-05 起手的样子(舞台地址用):要试的从共用起,定下停在第三级的各一套;之后往上走、进最低一档都不改它
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TIER_BUBBLE_TEXT, TIER_LABEL, initTier, lowestTier, markLowest, markReached, phoneIdentity, resetTierForTest, setBenchmark, settleAt, singleStageTier, tierGlRoute, tierName, tierStart, tierState } from "./onlineTier.ts";

test("OT-01 四档的名字与气泡文字照用户定的", () => {
  assert.deepEqual(TIER_LABEL, { top: "顶配模式", standard: "标准模式", lite: "精简模式", low: "低配模式" });
  assert.deepEqual(TIER_BUBBLE_TEXT, {
    top: "这台设备运行在顶配模式",
    standard: "这台设备运行在标准模式",
    lite: "这台设备运行在精简模式：复杂的效果交给云端渲染",
    low: "这台设备运行在低配模式：播放时只显示已渲染好的画面",
  });
});

test("OT-02 由状态推出来的档、路线、单舞台", () => {
  const s = (o) => ({ online: true, target: 3, reached: 3, gate: "done", lowest: null, identity: "desktop", benchmark: "ok", ...o });
  assert.equal(tierName(s({})), "top");
  assert.equal(tierName(s({ reached: 2, target: 2 })), "standard");
  assert.equal(tierName(s({ reached: 1, target: 1 })), "lite");
  assert.equal(tierName(s({ reached: 1, target: 1, lowest: "stage" })), "low");
  assert.equal(tierName(s({ lowest: "benchmark" })), "low", "两个舞台、基准卡跑不动:也是低配");
  assert.equal(tierGlRoute(s({})), "perDocument");
  assert.equal(tierGlRoute(s({ reached: 2 })), "shared");
  assert.equal(tierGlRoute(s({ reached: 1, target: 1 })), "shared");
  assert.equal(singleStageTier(s({ target: 1, reached: 1 })), true);
  assert.equal(singleStageTier(s({})), false);
  assert.equal(phoneIdentity(s({ identity: "phone" })), true);
});

test("OT-03 桌面恒为桌面的样子", () => {
  resetTierForTest();
  const t = tierState();
  assert.deepEqual([t.online, singleStageTier(), lowestTier(), tierGlRoute(), phoneIdentity()], [false, false, false, "perDocument", false]);
  markLowest("benchmark");
  markReached(1);
  assert.equal(tierState().lowest, null, "桌面不收");
});

test("OT-04 只升不降;退回;最低一档只进不出", () => {
  resetTierForTest();
  initTier({ online: true, target: 3, lowest: null, identity: "desktop" });
  assert.deepEqual([tierState().reached, tierState().gate, tierState().benchmark], [1, "trying", "pending"]);
  markReached(2);
  markReached(1);
  assert.equal(tierState().reached, 2, "只升不降");
  settleAt(1);
  assert.deepEqual([tierState().target, tierState().reached, tierState().gate], [1, 1, "done"], "握手容错退回单舞台");
  setBenchmark("slow");
  assert.equal(tierState().lowest, "benchmark");
  setBenchmark("ok");
  assert.equal(tierState().lowest, "benchmark", "只进不出");
  resetTierForTest();
});

test("OT-05 起手的样子:试的途中、进最低一档都不改", () => {
  resetTierForTest();
  initTier({ online: true, target: 3, lowest: null, identity: "desktop" });
  assert.deepEqual(tierStart(), { route: "shared", lowest: false });
  markReached(3);
  setBenchmark("slow");
  assert.deepEqual(tierStart(), { route: "shared", lowest: false }, "舞台地址不跟着变(变了 iframe 就重新载入)");
  initTier({ online: true, target: 3, reached: 3, lowest: null, identity: "desktop" });
  assert.equal(tierStart().route, "perDocument", "护栏内停在第三级:起手各一套");
  initTier({ online: true, target: 1, reached: 1, lowest: "stage", identity: "phone" });
  assert.deepEqual(tierStart(), { route: "shared", lowest: true });
  resetTierForTest();
});

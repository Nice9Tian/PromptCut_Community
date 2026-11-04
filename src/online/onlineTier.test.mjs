/**
 * Online browser tiers (`onlineTier.ts`; semantics in "Terminology" under "Online browser"
 * in `product/platforms.md`). Test cases OT-01 to OT-05.
 * Run: npm test -- src/online/onlineTier.test.mjs
 *
 *   OT-01 Names and bubble text of four tiers match verbatim (user decision, 2026-10-08)
 *   OT-02 Inferred from state: Tier 3 top-spec, Tier 2 standard, Tier 1 lite, lowest tier low-spec;
 *          route: Tier 3 has separate sets, others shared
 *   OT-03 Desktop is always in desktop form (dual stage, separate sets, not lowest tier,
 *          computer identity)
 *   OT-04 Upgrades only, never downgrades; rolls back midway during trial; baseline card cannot run
 *          and enters lowest tier (one-way entry)
 *   OT-05 Initial state (used for stage URLs): trials start from shared; settled at Tier 3 with
 *          separate sets; subsequent upgrades or entering lowest tier do not change it
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TIER_BUBBLE_TEXT, TIER_LABEL, initTier, lowestTier, markLowest, markReached, phoneIdentity, resetTierForTest, setBenchmark, settleAt, singleStageTier, tierGlRoute, tierName, tierStart, tierState } from "./onlineTier.ts";

test("OT-01 the names and bubble text of the four tiers follow the user decision", () => {
  assert.deepEqual(TIER_LABEL, { top: "Top mode", standard: "Standard mode", lite: "Lite mode", low: "Low mode" });
  assert.deepEqual(TIER_BUBBLE_TEXT, {
    top: "This device is running in top-spec mode",
    standard: "This device is running in standard mode",
    lite: "This device is running in lite mode: complex effects are handed off to cloud rendering",
    low: "This device is running in low-spec mode: playback only shows frames that are already rendered",
  });
});

test("OT-02 tier, route and single stage derived from state", () => {
  const s = (o) => ({ online: true, target: 3, reached: 3, gate: "done", lowest: null, identity: "desktop", benchmark: "ok", ...o });
  assert.equal(tierName(s({})), "top");
  assert.equal(tierName(s({ reached: 2, target: 2 })), "standard");
  assert.equal(tierName(s({ reached: 1, target: 1 })), "lite");
  assert.equal(tierName(s({ reached: 1, target: 1, lowest: "stage" })), "low");
  assert.equal(tierName(s({ lowest: "benchmark" })), "low", "two stages, benchmark card can't keep up: also low tier");
  assert.equal(tierGlRoute(s({})), "perDocument");
  assert.equal(tierGlRoute(s({ reached: 2 })), "shared");
  assert.equal(tierGlRoute(s({ reached: 1, target: 1 })), "shared");
  assert.equal(singleStageTier(s({ target: 1, reached: 1 })), true);
  assert.equal(singleStageTier(s({})), false);
  assert.equal(phoneIdentity(s({ identity: "phone" })), true);
});

test("OT-03 desktop always looks like desktop", () => {
  resetTierForTest();
  const t = tierState();
  assert.deepEqual([t.online, singleStageTier(), lowestTier(), tierGlRoute(), phoneIdentity()], [false, false, false, "perDocument", false]);
  markLowest("benchmark");
  markReached(1);
  assert.equal(tierState().lowest, null, "desktop does not collect");
});

test("OT-04 only up, never down; fall back; the lowest tier is enter-only", () => {
  resetTierForTest();
  initTier({ online: true, target: 3, lowest: null, identity: "desktop" });
  assert.deepEqual([tierState().reached, tierState().gate, tierState().benchmark], [1, "trying", "pending"]);
  markReached(2);
  markReached(1);
  assert.equal(tierState().reached, 2, "only up, never down");
  settleAt(1);
  assert.deepEqual([tierState().target, tierState().reached, tierState().gate], [1, 1, "done"], "handshake fault tolerance falls back to a single stage");
  setBenchmark("slow");
  assert.equal(tierState().lowest, "benchmark");
  setBenchmark("ok");
  assert.equal(tierState().lowest, "benchmark", "enter only, no exit");
  resetTierForTest();
});

test("OT-05 starting state: unchanged during a trial and when entering the lowest tier", () => {
  resetTierForTest();
  initTier({ online: true, target: 3, lowest: null, identity: "desktop" });
  assert.deepEqual(tierStart(), { route: "shared", lowest: false });
  markReached(3);
  setBenchmark("slow");
  assert.deepEqual(tierStart(), { route: "shared", lowest: false }, "the stage URL does not change with it (if it changed, the iframe would reload)");
  initTier({ online: true, target: 3, reached: 3, lowest: null, identity: "desktop" });
  assert.equal(tierStart().route, "perDocument", "within the guard, stay at the third level: one set each at start");
  initTier({ online: true, target: 1, reached: 1, lowest: "stage", identity: "phone" });
  assert.deepEqual(tierStart(), { route: "shared", lowest: true });
  resetTierForTest();
});

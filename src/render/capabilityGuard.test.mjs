/**
 * Unit test for A0.2 runtime fallback. Run: node --test src/render/capabilityGuard.test.mjs
 *
 * If this rule is wrong, no error is thrown; it only causes a dead asset of a frosted-glass card
 * to be shared to the cloud as a "standalone card": changing the lower layer then blurs with
 * someone else's video. So pin one rule for each of three things: measurable, only effective
 * for independent, and cardCapabilities actually changes after downgrade.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { usesBackdropFilter, needsGuard, guardCompositing, resetGuardScans } = await import("./capabilityGuard.ts");
const { cardCapabilities, degradedCards, resetDegradedCards } = await import("../kernel/frameMode.mjs");

/** Minimal fake DOM: only requires querySelector / querySelectorAll and a style table */
function fakeStage(clips) {
  const byClip = new Map();
  for (const [clipId, styles] of Object.entries(clips)) {
    const nodes = styles.map((style) => ({ style }));
    const root = { style: nodes[0]?.style ?? {}, querySelectorAll: () => nodes.slice(1) };
    byClip.set(clipId, root);
  }
  return {
    querySelector: (sel) => byClip.get((sel.match(/\[data-pc-clip="(.*)"\]/) || [])[1]) ?? null,
  };
}
const readStyle = (el) => el.style ?? {};

test("usesBackdropFilter: none / empty string does not count, any truthy value does", () => {
  const el = (v) => ({ style: { backdropFilter: v }, querySelectorAll: () => [] });
  assert.equal(usesBackdropFilter(el("none"), readStyle), false);
  assert.equal(usesBackdropFilter(el(""), readStyle), false);
  assert.equal(usesBackdropFilter(el("blur(24px)"), readStyle), true);
  assert.equal(usesBackdropFilter(null, readStyle), false);
  // The -webkit- prefix branch is handled separately
  const webkit = { style: { webkitBackdropFilter: "blur(24px)" }, querySelectorAll: () => [] };
  assert.equal(usesBackdropFilter(webkit, readStyle), true);
  // Descendant nodes must also be scanned: the glass pane is a div inside the card, not the outer box
  const nested = { style: {}, querySelectorAll: () => [{ style: { backdropFilter: "blur(8px)" } }] };
  assert.equal(usesBackdropFilter(nested, readStyle), true);
});

test("needsGuard: only cards that the review table marks independent need checking", () => {
  assert.equal(needsGuard("punch-pill"), true);
  assert.equal(needsGuard("particles-snow"), true, "particle cards matched by wildcard also count as independent");
  assert.equal(needsGuard("blur-text"), false, "already belowDependent, no check needed");
  assert.equal(needsGuard("no such card"), false, "unknown is already the most conservative tier");
  assert.equal(needsGuard(undefined), false);
});

test("guardCompositing: declared independent but actually has frosted glass → warning + downgrade + cardCapabilities corrected", (t) => {
  resetDegradedCards(); resetGuardScans();
  t.after(() => { resetDegradedCards(); resetGuardScans(); });
  const before = cardCapabilities({ id: "punch-pill", frameMode: "stateful" });
  assert.equal(before.compositing, "independent");
  assert.equal(before.independentCache, true);

  const warnings = [];
  const stage = fakeStage({ c1: [{}, { backdropFilter: "blur(24px)" }] });
  const hit = guardCompositing(stage, [{ id: "c1", cardId: "punch-pill" }], { readStyle, warn: (m) => warnings.push(m) });

  assert.deepEqual(hit, ["punch-pill"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /punch-pill/);
  const after = cardCapabilities({ id: "punch-pill", frameMode: "stateful" });
  assert.equal(after.compositing, "belowDependent");
  assert.equal(after.independentCache, false);
  assert.equal(degradedCards().get("punch-pill"), "backdrop-filter");

  // Do not alert repeatedly for the same card
  const again = guardCompositing(stage, [{ id: "c1", cardId: "punch-pill" }], { readStyle, warn: (m) => warnings.push(m) });
  assert.deepEqual(again, []);
  assert.equal(warnings.length, 1);
});

test("guardCompositing: a clean independent card is left alone", (t) => {
  resetDegradedCards(); resetGuardScans();
  t.after(() => { resetDegradedCards(); resetGuardScans(); });
  const stage = fakeStage({ c1: [{}, { backdropFilter: "none" }] });
  const hit = guardCompositing(stage, [{ id: "c1", cardId: "punch-pill" }], { readStyle, warn: () => {} });
  assert.deepEqual(hit, []);
  assert.equal(cardCapabilities({ id: "punch-pill" }).compositing, "independent");
});

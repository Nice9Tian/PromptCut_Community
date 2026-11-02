/**
 * Unit test for three-tier card visibility. Run: node --test src/editor/cardScope.test.mjs
 *
 * This logic is the sole fix for the bug where "custom cards leaked over from the previous project",
 * and when it breaks it **throws no errors**:
 * only extra or missing cards appear in Agent's list_cards, discovered only when final video is made
 * incorrectly. So lock down:
 *   - Project assets only appear in the project where they were created;
 *   - Old cards (no entry in table) **must not disappear**; silently missing cards is harder to debug
 *     than a leak;
 *   - Allow all when ownership table is unavailable; single network jitter should not suddenly leave
 *     Agent with no cards available.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isCardVisible, usedCardIds, localCardImports } from "./cardScope.ts";

const V = { base: true, groups: { native: true, magicui: true, asset: true }, custom: true, project: true };
const card = (id, source) => ({ id, source, name: id, description: "", defaults: {}, controls: [], Component: () => null });

test("Built-in cards are toggled by group, independent of the ownership table", () => {
  const n = card("odometer", "native");
  const m = card("mu-x", "magicui");
  const a = card("lottie-x", "asset");
  assert.equal(isCardVisible(n, V, {}, "p1"), true);
  assert.equal(isCardVisible(m, V, {}, "p1"), true);
  assert.equal(isCardVisible(a, V, {}, "p1"), true);

  const noMagic = { ...V, groups: { ...V.groups, magicui: false } };
  assert.equal(isCardVisible(m, noMagic, {}, "p1"), false, "After the third-party group is turned off, mu- cards must not appear");
  assert.equal(isCardVisible(n, noMagic, {}, "p1"), true, "Other groups are unaffected");

  assert.equal(isCardVisible(n, { ...V, base: false }, {}, "p1"), false, "With the master base switch off, none appear");
});

test("Project assets appear only in the project that created them: this is the leak in question", () => {
  const logo = card("logo-3d-9tian", "user");
  const scopes = { "logo-3d-9tian": { scope: "project", projectId: "Client A" } };
  assert.equal(isCardVisible(logo, V, scopes, "Client A"), true, "It must be visible in its own project");
  assert.equal(isCardVisible(logo, V, scopes, "Client B"), false, "In another project it must no longer appear");
  assert.equal(isCardVisible(logo, V, scopes, null), false, "It must not leak even when there is no current project");
});

test("Custom cards marked as custom are visible across projects, and turning off that tier hides them all", () => {
  const brand = card("brand-logo", "user");
  const scopes = { "brand-logo": { scope: "custom", projectId: "Client A" } };
  assert.equal(isCardVisible(brand, V, scopes, "Client B"), true, "A shared card is meant to be usable across projects");
  assert.equal(isCardVisible(brand, { ...V, custom: false }, scopes, "Client B"), false);
});

test("Turning off the project assets tier also hides this project's custom cards (used for \"use only ready-made cards this round\")", () => {
  const c = card("x", "user");
  const scopes = { x: { scope: "project", projectId: "p1" } };
  assert.equal(isCardVisible(c, V, scopes, "p1"), true);
  assert.equal(isCardVisible(c, { ...V, project: false }, scopes, "p1"), false);
});

test("Old cards (no entry in the table) must not disappear: a few cards silently missing is harder to track down than a leak", () => {
  const old = card("vertical-trend", "user");
  assert.equal(isCardVisible(old, V, {}, "Any project"), true);
  // But it is treated as "custom", so turning off the custom tier cleans it up completely
  assert.equal(isCardVisible(old, { ...V, custom: false }, {}, "Any project"), false);
});

test("When the ownership table cannot be fetched, let everything through: a single network blip must not leave the Agent suddenly without cards", () => {
  const c = card("whatever", "user");
  assert.equal(isCardVisible(c, V, {}, "p1"), true);
});

test("Old data that recorded the tier but not the project id counts as this project's and is not hidden", () => {
  const c = card("y", "user");
  assert.equal(isCardVisible(c, V, { y: { scope: "project" } }, "p1"), true);
});

test("A custom card in use on the timeline counts as this project's, whatever project id the ownership table records", () => {
  // The "Seven Days in Tokyo" .proc: card is recorded under draft 20260910-wu2hng; opened from desktop has no draft id at all
  const map = card("tokyo7-map", "user");
  const scopes = { "tokyo7-map": { scope: "project", projectId: "20260910-wu2hng" } };
  const used = new Set(["tokyo7-map"]);
  assert.equal(isCardVisible(map, V, scopes, null), false, "Ignoring whether it is in use, it is the card that gets hidden");
  assert.equal(isCardVisible(map, V, scopes, null, used), true, "If it is in use in the video, it must be visible in the card library");
  assert.equal(isCardVisible(map, V, scopes, "p-other", used), true);
  assert.equal(isCardVisible(map, { ...V, project: false }, scopes, null, used), false, "Turning off the project assets tier still hides it");
  assert.equal(isCardVisible(card("other", "user"), V, { other: { scope: "project", projectId: "x" } }, null, used), false, "Other people's unused cards still do not leak");
});

test("usedCardIds scans all cuts: the active one is in tracks, parked ones are in cuts[].tracks", () => {
  const p = {
    tracks: [{ clips: [{ cardId: "a" }, { mediaId: "m" }] }],
    cuts: [{ id: "cut-1" }, { id: "cut-2", tracks: [{ clips: [{ cardId: "b" }, { cardId: "a" }] }] }],
  };
  assert.deepEqual([...usedCardIds(p)].sort(), ["a", "b"]);
  assert.deepEqual([...usedCardIds({})], []);
});

test("localCardImports only recognizes files in the same directory, and strips the .tsx suffix along the way", () => {
  const src = `import { a } from "./shared-bits";\nimport x from "./logo.tsx";\nimport "./side";\nimport { m } from "motion/react";\nimport t from "../../kernel/types";`;
  assert.deepEqual(localCardImports(src).sort(), ["logo", "shared-bits", "side"]);
});

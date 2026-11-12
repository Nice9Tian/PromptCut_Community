/**
 * Pure logic for side rail freeform layout.
 * Run: node --experimental-test-module-mocks --test src/editor/dock/railLayout.test.mjs
 *
 * Lock down: how the loaded layout is validated, how order and selected items change after dragging,
 * where "+" is drawn, and which items are visible when one side is dragged empty.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  SECTION_IDS,
  CUTS_ITEM,
  hasPages,
  agentItem,
  defaultLayout,
  validateLayout,
  moveItem,
  plusAnchor,
  visibleItems,
  effectiveActive,
  syncAgents,
  gapToFullIndex,
  insertAgent,
  withActive,
  sameLayout,
} from "./railLayout.ts";
import { RAIL_W, railWidthFor } from "../sideRails.ts";
import { translate } from "../../i18n/index.ts";

const A = (id) => agentItem(id);
const L = (left, right, active = {}) => ({
  left,
  right,
  active: { left: active.left ?? left[0] ?? null, right: active.right ?? right[0] ?? null },
});

test("Default layout = pre-redesign: five sections on the left, script + each Agent on the right; the selected items reuse the old keys (cut group removed on 2026-10-20)", () => {
  const d = defaultLayout(["main", "t2"]);
  assert.deepEqual(d.left, [...SECTION_IDS]);
  assert.deepEqual(d.right, ["script", A("main"), A("t2")]);
  assert.deepEqual(d.active, { left: "library", right: A("main") });

  const legacy = defaultLayout(["main", "t2"], { section: "captions", rightPage: "agent", activeTabId: "t2" });
  assert.deepEqual(legacy.active, { left: "captions", right: A("t2") });
  assert.equal(defaultLayout(["main"], { rightPage: "script" }).active.right, "script");
  assert.equal(defaultLayout(["main"], { section: "nope", activeTabId: "gone" }).active.left, "library", "Unrecognized values in the old keys are not used");
  assert.equal(defaultLayout(["main"], { activeTabId: "gone" }).active.right, A("main"));
});

test("Validation: use the fallback when the shape is wrong", () => {
  const fb = defaultLayout(["main"]);
  assert.equal(validateLayout(null, ["main"], fb), fb);
  assert.equal(validateLayout("x", ["main"], fb), fb);
  assert.equal(validateLayout({ left: "library" }, ["main"], fb), fb);
});

test("Validation: drop Agents that no longer exist and unrecognized items, keep only the first occurrence of duplicates", () => {
  const raw = {
    left: ["edit", A("gone"), "bogus", 42, "library"],
    right: [A("main"), "edit", "script", "captions", "animations", "effects"],
    active: { left: "edit", right: A("main") },
  };
  const v = validateLayout(raw, ["main"]);
  assert.deepEqual(v.left, ["edit", "library"]);
  assert.deepEqual(v.right, [A("main"), "script", "captions", "animations", "effects"]);
  assert.deepEqual(v.active, { left: "edit", right: A("main") });
});

test("Validation: missing sections are added back at the end of the left rail in a fixed order, and a missing script is added back at the top of the right rail", () => {
  const v = validateLayout({ left: ["captions"], right: [A("main")], active: {} }, ["main"]);
  assert.deepEqual(v.left, ["captions", "library", "animations", "effects", "edit"]);
  assert.deepEqual(v.right, ["script", A("main")]);
});

test("Validation: the script and sections count on the other side too and are not added again", () => {
  const v = validateLayout({ left: ["script", ...SECTION_IDS], right: [A("main"), CUTS_ITEM], active: { left: "script" } }, ["main"]);
  assert.deepEqual(v.left, ["script", ...SECTION_IDS]);
  assert.deepEqual(v.right, [A("main")], "A cut group in an old layout is dropped when read in");
  assert.equal(v.active.left, "script");
});

test("Validation: a missing Agent is placed after the last Agent (right side first, left side if there is none on the right)", () => {
  const v1 = validateLayout({ left: [...SECTION_IDS], right: ["script", A("main")] }, ["main", "t2", "t3"]);
  assert.deepEqual(v1.right, ["script", A("main"), A("t2"), A("t3")]);

  const v2 = validateLayout({ left: ["library", A("main"), "edit"], right: ["script"] }, ["main", "t2"]);
  assert.deepEqual(v2.left.slice(0, 4), ["library", A("main"), A("t2"), "edit"]);
  assert.deepEqual(v2.right, ["script"]);
});

test("Validation: if active is not on that side, fall back to the fallback's selected item, then to the first item; an empty side is null", () => {
  const fb = defaultLayout(["main"], { section: "effects" });
  const v = validateLayout({ left: [...SECTION_IDS], right: ["script", A("main")], active: { left: A("main"), right: "zzz" } }, ["main"], fb);
  assert.equal(v.active.left, "effects", "The fallback's effects is still on the left");
  assert.equal(v.active.right, A("main"), "The fallback's agent:main is still on the right");

  const empty = validateLayout({ left: [], right: ["script", ...SECTION_IDS, A("main")], active: { left: "library" } }, ["main"]);
  assert.deepEqual(empty.left, [], "The cut group was removed on 2026-10-20 and is no longer added back on the left");
  assert.equal(empty.active.left, null, "An empty side has no selected item");
  assert.equal(empty.active.left, null);
  assert.equal(empty.active.right, A("main"), "No saved selected item for right: the default layout's agent:main is still on the right, so use it");

  const noFallbackHit = validateLayout(
    { left: [...SECTION_IDS], right: ["script", A("main")], active: {} },
    ["main"],
    { left: [], right: [], active: { left: A("gone"), right: "captions" } },
  );
  assert.deepEqual(noFallbackHit.active, { left: "library", right: "script" }, "The fallback's selected item is not on that side either, fall back to the first item");
});

test("move: moving down / up on the same side, gap counts as if the dragged item is still in its original position", () => {
  const base = L(["library", "animations", "effects", "edit", "captions"], ["script", A("main")]);
  // Drag library between effects and edit: gap = 3
  const down = moveItem(base, "library", "left", 3);
  assert.deepEqual(down.layout.left, ["animations", "effects", "library", "edit", "captions"]);
  assert.equal(down.layout.active.left, "library");
  assert.equal(down.emptied, null);
  // Drag captions to the top
  const up = moveItem(base, "captions", "left", 0);
  assert.deepEqual(up.layout.left, ["captions", "library", "animations", "effects", "edit"]);
  // Drop in place: order unchanged, but becomes the selected item
  const same = moveItem(base, "effects", "left", 2);
  assert.deepEqual(same.layout.left, base.left);
  assert.equal(same.layout.active.left, "effects");
  assert.deepEqual(moveItem(base, "effects", "left", 3).layout.left, base.left, "The gap directly below itself is also the original position");
});

test("move: across sides, the target side selects it; if it was the source side's selected item, an adjacent one is selected instead (above first, then below)", () => {
  const base = L(["library", "animations", "effects"], ["script", A("main")], { left: "animations", right: A("main") });
  const r = moveItem(base, "animations", "right", 1);
  assert.deepEqual(r.layout.left, ["library", "effects"]);
  assert.deepEqual(r.layout.right, ["script", "animations", A("main")]);
  assert.deepEqual(r.layout.active, { left: "library", right: "animations" });
  assert.equal(r.from, "left");
  assert.equal(r.to, "right");

  const top = moveItem(L(["library", "animations"], ["script"], { left: "library" }), "library", "right", 99);
  assert.equal(top.layout.active.left, "animations", "If there is nothing above, select the item below");
  assert.deepEqual(top.layout.right, ["script", "library"], "A gap out of range is clamped to the end");

  const notActive = moveItem(base, "effects", "right", 0);
  assert.equal(notActive.layout.active.left, "animations", "If the dragged item is not the source side's selected item, the source side is unchanged");
});

test("move: source side dragged empty → emptied, active set to null, the empty rail is still there", () => {
  const base = L(["library"], ["script", A("main")]);
  const r = moveItem(base, "library", "right", 3);
  assert.deepEqual(r.layout.left, []);
  assert.equal(r.layout.active.left, null);
  assert.equal(r.emptied, "left");
  // Drag back to empty rail
  const back = moveItem(r.layout, A("main"), "left", 0);
  assert.deepEqual(back.layout.left, [A("main")]);
  assert.equal(back.layout.active.left, A("main"));
  assert.equal(back.emptied, null);
});

test("move: when selecting an adjacent item, prefer visible ones (visibility check supplied by the caller)", () => {
  const base = L(["script", "library", "edit", A("main")], [A("t2")], { left: A("main") });
  const aiOnly = (id) => id === "script" || id.startsWith("agent:");
  const r = moveItem(base, A("main"), "right", 1, aiOnly);
  assert.equal(r.layout.active.left, "script", "The edit / library directly above are not visible, so skip to script");
  const classic = moveItem(base, A("main"), "right", 1);
  assert.equal(classic.layout.active.left, "edit");
});

test("move: an item not in the layout returns null", () => {
  assert.equal(moveItem(L(["library"], ["script"]), A("nope"), "left", 0), null);
});

test("\"+\": drawn right below the last Agent item on this side; not drawn if there is no Agent", () => {
  assert.equal(plusAnchor(["script", A("main"), A("t2")]), 2);
  assert.equal(plusAnchor([A("main"), "library", "edit"]), 0);
  assert.equal(plusAnchor([A("main"), "library", A("t2"), "edit"]), 2);
  assert.equal(plusAnchor(["script", "library"]), -1);
  assert.equal(plusAnchor([]), -1, "An empty side is not drawn");
});

test("New Agent: inserted after the last Agent on that side and selected on that side", () => {
  const base = L([A("main"), "library", "edit"], ["script", A("t2"), "captions"], { left: "library", right: "script" });
  const r = syncAgents(base, ["main", "t2", "t3"], "left");
  assert.deepEqual(r.layout.left, [A("main"), A("t3"), "library", "edit"]);
  assert.equal(r.layout.active.left, A("t3"));
  assert.equal(r.layout.active.right, "script", "The other side is untouched");
  assert.deepEqual(r.added, [A("t3")]);

  const noHint = syncAgents(base, ["main", "t2", "t9"]);
  assert.deepEqual(noHint.layout.right, ["script", A("t2"), A("t9"), "captions"], "With no hint, it goes after the last Agent on the right");
  assert.equal(noHint.layout.active.right, "script", "With no hint, it does not steal the selection");

  const onlyLeft = syncAgents(L([A("main")], ["script"]), ["main", "x"]);
  assert.deepEqual(onlyLeft.layout.left, [A("main"), A("x")], "If the right side has no Agent, it goes on the left");

  assert.deepEqual(insertAgent(L(["library"], []), "right", A("z")).right, [A("z")], "An empty side takes it directly");
  assert.equal(insertAgent(L(["library"], []), "right", A("z")).active.right, A("z"), "The empty side's active item follows");
});

test("Close an Agent: remove that item; if it was the selected item, select its neighbor; report emptied if that side becomes empty", () => {
  const base = L(["library", A("t2"), A("t3")], [A("main")], { left: A("t2") });
  const r = syncAgents(base, ["main", "t3"]);
  assert.deepEqual(r.layout.left, ["library", A("t3")]);
  assert.equal(r.layout.active.left, A("t3"), "The closed item is an Agent: look among the remaining Agents first");
  assert.deepEqual(r.emptied, []);

  // Close the selected lead Agent (Agent 1) on the right: switch to remaining Agent, do not jump to script
  const main = syncAgents(L(["library"], ["script", A("main"), A("t3")], { right: A("main") }), ["t3"]);
  assert.equal(main.layout.active.right, A("t3"));
  // Fall back to original "top first, then bottom" only when no other Agents remain on this side
  const noAgent = syncAgents(L(["library"], ["script", A("main")], { right: A("main") }), ["t9"]);
  assert.equal(noAgent.layout.active.right, "script");

  const empty = syncAgents(L([A("t2")], ["script", A("main")]), ["main"]);
  assert.deepEqual(empty.layout.left, []);
  assert.equal(empty.layout.active.left, null);
  assert.deepEqual(empty.emptied, ["left"]);

  const unchanged = L([...SECTION_IDS], ["script", A("main")]);
  assert.equal(syncAgents(unchanged, ["main"]).layout, unchanged, "No change returns the same object");
});

test("The rail draws all items; the recorded selected item is the one displayed; a side dragged empty has no selected item", () => {
  const layout = L(["library", A("t2"), "edit"], ["script", "captions", A("main")], { left: "edit", right: A("main") });
  assert.deepEqual(visibleItems(layout.left), ["library", A("t2"), "edit"]);
  assert.equal(effectiveActive(layout, "left"), "edit");
  assert.equal(effectiveActive(layout, "right"), A("main"));
  assert.equal(effectiveActive(L([], ["script"]), "left"), null);
});

test("Drop target index conversion: count only the drawn items", () => {
  const full = ["library", "script", A("a"), "animations"];
  const shown = ["script", A("a")];
  assert.equal(gapToFullIndex(full, shown, 0), 1);
  assert.equal(gapToFullIndex(full, shown, 1), 2);
  assert.equal(gapToFullIndex(full, shown, 2), 3, "Dropping at the end = after the last drawn item");
  assert.equal(gapToFullIndex(full, [], 0), 4);
  assert.equal(gapToFullIndex(full, full, 4), 4, "When everything is drawn, the index stays as is");

  // Pass to moveItem after conversion: drag script to the end
  const layout = L(full, [A("b")], { left: "script" });
  const r = moveItem(layout, "script", "left", gapToFullIndex(full, shown, 2));
  assert.deepEqual(r.layout.left, ["library", A("a"), "script", "animations"]);
});

test("withActive / sameLayout", () => {
  const base = L([...SECTION_IDS], ["script", A("main")]);
  const next = withActive(base, "edit");
  assert.equal(next.active.left, "edit");
  assert.equal(base.active.left, "library", "Does not modify the original object");
  assert.equal(withActive(base, A("nope")), base);
  assert.equal(sameLayout(base, JSON.parse(JSON.stringify(base))), true);
  assert.equal(sameLayout(base, next), false);
});

test("Cut group: not a page, never becomes the selected item; a side with only it left counts as empty", () => {
  // Stored active points to cut group (should not happen, but must be handled): fall back to the first page item on that side
  const v = validateLayout({ left: [CUTS_ITEM, "library"], right: ["script", A("main")], active: { left: CUTS_ITEM } }, ["main"]);
  assert.equal(v.active.left, "library");
  assert.equal(effectiveActive(L([CUTS_ITEM], ["script"], { left: CUTS_ITEM }), "left"), null);
  assert.equal(effectiveActive(L([CUTS_ITEM, "edit"], ["script"], { left: null }), "left"), "edit");
  assert.equal(withActive(L(["library", CUTS_ITEM], ["script"]), CUTS_ITEM).active.left, "library");
  assert.equal(hasPages([CUTS_ITEM]), false);
  assert.equal(hasPages([CUTS_ITEM, "script"]), true);
});

test("Cut group: dragging the whole group to the other side keeps the selected item on both sides unchanged; reports empty when only it was left on the source side", () => {
  const base = L(["library", CUTS_ITEM], ["script", A("main")], { left: "library", right: A("main") });
  const r = moveItem(base, CUTS_ITEM, "right", 1);
  assert.deepEqual(r.layout.left, ["library"]);
  assert.deepEqual(r.layout.right, ["script", CUTS_ITEM, A("main")]);
  assert.deepEqual(r.layout.active, { left: "library", right: A("main") });
  assert.equal(r.emptied, null);

  // All page items on the left are dragged away, leaving only cut group: left counts as empty, selected item set to null
  const onlyCuts = moveItem(L(["library", CUTS_ITEM], ["script"], { left: "library" }), "library", "right", 0);
  assert.deepEqual(onlyCuts.layout.left, [CUTS_ITEM]);
  assert.equal(onlyCuts.layout.active.left, null);
  assert.equal(onlyCuts.emptied, "left");

  // When the selected item is dragged away, skip cut group among adjacent items
  const skip = moveItem(L(["library", CUTS_ITEM, "edit"], ["script"], { left: "library" }), "library", "right", 0);
  assert.equal(skip.layout.active.left, "edit");

  // When only cut group remains on that side after closing Agent: also counted as empty
  const synced = syncAgents(L([...SECTION_IDS], [A("t2"), CUTS_ITEM], { right: A("t2") }), ["main"]);
  assert.deepEqual(synced.layout.right.includes(CUTS_ITEM), true);
  assert.equal(synced.layout.active.right === CUTS_ITEM, false);
});

test("Rail width per locale stays synced with studio.css and fits every rail tab label on a single line", () => {
  const css = fs.readFileSync(new URL("../../skins/studio.css", import.meta.url), "utf8");
  assert.match(css, /:root\s*\{[^}]*--ui-rail-w:\s*64px;/);
  assert.match(css, /:root\[lang="en"\]\s*\{[^}]*--ui-rail-w:\s*80px;/);
  assert.match(css, /:root\[lang="ja"\]\s*\{[^}]*--ui-rail-w:\s*88px;/);
  assert.equal(railWidthFor("zh-CN"), 64);
  assert.equal(railWidthFor("en"), 80);
  assert.equal(railWidthFor("ja"), 88);
  assert.equal(RAIL_W, railWidthFor("en"));

  const labels = ["Media library", "Animation", "Effects", "Edit", "Captions", "Script", "Start"];
  for (const locale of ["en", "zh-CN", "ja"]) {
    const fontSize = locale === "ja" ? 10 : 11;
    // Item pill width is railWidth - 8px, minus 4px inner horizontal padding
    const budget = railWidthFor(locale) - 12;
    for (const key of labels) {
      const text = translate(locale, key);
      const estPx = [...text].reduce((sum, ch) => {
        if (ch.charCodeAt(0) > 0xff) return sum + fontSize;
        return sum + fontSize * (" il1.,:;|!'".includes(ch) ? 0.28 : 0.52);
      }, 0);
      assert.ok(estPx <= budget, `${locale} rail label "${text}" (${estPx.toFixed(1)}px) exceeds ${budget}px`);
    }
  }
});

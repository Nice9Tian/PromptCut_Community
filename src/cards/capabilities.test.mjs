/**
 * Gatekeeper test: card classification registry (`src/cards/capabilities.json`,
 * described in `capabilities.md`).
 * Run: node --test src/cards/capabilities.test.mjs
 *
 *   CT-01 All built-in cards (four groups registered in `src/cards/index.ts`) have all three
 *         items registered in the table: writing style, what it draws on, whether below-dependent
 *   CT-02 Writing style follows card declaration: mismatch between table value and declaration is
 *         an error
 *   CT-03 What it draws on does not conflict with card declaration (canvas contract, whether it
 *         has visuals); whether it is a canvas card is derived from `surface`, table omits
 *         `canvasHeavy`
 *   CT-04 No extra keys in the table (including `frameMode`: writing style only comes from
 *         declaration, registered using `writing`), no entries unmatched to any card
 *   CT-05 Both places reading the table (`src/kernel/frameMode.mjs`, `server/vision-project.mjs`)
 *         read the same copy, and both yield the new fields
 *   CT-06 New fields do not enter card identity digest: `cardCapabilities` return still has only
 *         the original five items, values match registered ones
 *   CT-07 `src/cards/index.ts` still registers these four groups (if an extra group is added, this
 *         test cannot enumerate it and must be updated)
 *   CT-08-CT-11 Intentionally broken fixtures: newly added built-in card unregistered, table
 *         mismatches declaration, missing one of three items, disallowed values, checks all report
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBuiltinCards, BUILTIN_CARD_GROUPS } from "../testing/loadBuiltinCards.mjs";
import { reviewedCard, reviewedCanvas, cardCapabilities, cardFrameMode, normalizeFrameMode, DERIVED_FROM_PARTS } from "../kernel/frameMode.mjs";
import { reviewedCapabilities, reviewedClassification, CARD_WRITINGS, CARD_SURFACES, CANVAS_SURFACES, REVIEWED_COMPOSITING, CARD_COMPOSITINGS } from "../../server/vision-project.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TABLE = JSON.parse(fs.readFileSync(path.join(ROOT, "src/cards/capabilities.json"), "utf8"));

/**
 * Allowed fields for each entry in the table. Whether it is a canvas card is derived from
 * `surface` (`reviewedCanvas` in `frameMode.mjs`); legacy field `canvasHeavy` must not be written
 */
const ENTRY_KEYS = ["writing", "surface", "compositing"];
/**
 * Cards registered as "intentionally unreviewed": probes require their axis 3 to remain unknown.
 * Other cards must not write `unknown`
 */
const DELIBERATELY_UNKNOWN = ["r6-unknown", "probe-css", "probe-motion-js"];
/**
 * Keys in the table but not in the four built-in groups: the card under `src/cards/user/` shipped
 * with the repo. Any newly added keys like this must be explicitly declared here
 */
const KEYS_OUTSIDE_BUILTIN = ["mu-animated-shiny-text"];

/**
 * Table lookup: exact id first, then longest `prefix-*` (same convention as the two places reading
 * the table; queries the passed-in table here to feed fixtures)
 */
function lookup(table, id) {
  const exact = table[id];
  if (exact && typeof exact === "object") return { key: id, entry: exact };
  let best = null;
  for (const key of Object.keys(table)) {
    if (!key.endsWith("-*")) continue;
    const prefix = key.slice(0, -1);
    if (id.startsWith(prefix) && (!best || prefix.length > best.key.length - 1)) best = { key, entry: table[key] };
  }
  return best && typeof best.entry === "object" ? best : null;
}

const hasPicture = (def) => typeof def.Component === "function" || typeof def.card === "function";

/**
 * Check the entire table and return list of issues (empty = no issues). Each issue is
 * `{ code, id, message }`:
 *   unregistered  Built-in card not in table
 *   incomplete    Missing one of three items, or unrecognized value
 *   writing       Table writing style does not match card declaration
 *   surface       What it draws on conflicts with card declaration
 *   compositing   Contains tokens this card should not write (`unknown` / `fromParts`)
 *   extra-field   Entry contains unrecognized fields (including `frameMode`: writing style only
 *                 comes from card declaration; including legacy field `canvasHeavy`: derived
 *                 from `surface`)
 *   dead-key      Table key matches no built-in cards and is not in known exceptions
 */
function checkCardTable(table, cards, { keysOutsideBuiltin = KEYS_OUTSIDE_BUILTIN } = {}) {
  const problems = [], used = new Set();
  const report = (code, id, message) => problems.push({ code, id, message });
  for (const [key, entry] of Object.entries(table)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { report("incomplete", key, "Entry is not an object"); continue; }
    for (const field of Object.keys(entry)) if (!ENTRY_KEYS.includes(field)) {
      report("extra-field", key, field === "frameMode"
        ? "The table must not contain frameMode: the writing is taken only from the card's declaration, so nobody reads it from the table; the writing is registered in writing"
        : field === "canvasHeavy" ? "The table must no longer contain canvasHeavy: whether a card is a canvas card is derived from surface (canvas2d / webgl)"
        : `Unrecognized field ${field}`);
    }
    if (!Object.hasOwn(CARD_WRITINGS, entry.writing)) report("incomplete", key, `writing is missing or unrecognized: ${JSON.stringify(entry.writing)}`);
    if (!CARD_SURFACES.includes(entry.surface)) report("incomplete", key, `surface is missing or unrecognized: ${JSON.stringify(entry.surface)}`);
    if (!CARD_COMPOSITINGS.includes(entry.compositing)) report("incomplete", key, `compositing is missing or unrecognized: ${JSON.stringify(entry.compositing)}`);
  }
  for (const def of cards) {
    const id = def.id, hit = lookup(table, id);
    if (!hit) { report("unregistered", id, "Built-in card is not registered in src/cards/capabilities.json (also update capabilities.md)"); continue; }
    used.add(hit.key);
    const entry = hit.entry;
    // Writing style: declaration takes precedence. Built-in cards must explicitly declare
    // direct / stateful; registered value is taken from it
    const declared = normalizeFrameMode(def.frameMode);
    if (def.frameMode !== "direct" && def.frameMode !== "stateful") report("writing", id, `A built-in card must explicitly declare frameMode as direct or stateful, currently ${JSON.stringify(def.frameMode)}`);
    else if (cardFrameMode(def, def.defaults) !== declared) report("writing", id, `Declared ${declared}, but actually handled as ${cardFrameMode(def, def.defaults)} (need_prerendering conflicts with the declaration)`);
    else if (CARD_WRITINGS[entry.writing] !== declared) report("writing", id, `The table registers ${entry.writing} (${CARD_WRITINGS[entry.writing]}), but the card declares ${declared}; the declaration wins, fix the table`);
    // What it draws on: table takes precedence, but must not conflict with card's own declaration
    if (CARD_SURFACES.includes(entry.surface)) {
      if (!hasPicture(def) !== (entry.surface === "none")) report("surface", id, hasPicture(def) ? "This card has visuals, so surface cannot be none" : "This card has no visuals (sound only), so surface must be none");
      if (def.canvas && !CANVAS_SURFACES.includes(entry.surface)) report("surface", id, `The card declares the canvas contract canvas.kind=${def.canvas.kind}, but the table registers ${entry.surface}`);
      if (def.canvas && (def.canvas.kind === "dom2d") !== (entry.surface === "canvas2d")) report("surface", id, `The canvas contract canvas.kind=${def.canvas.kind} does not match the registered ${entry.surface} (dom2d ↔ canvas2d, all others ↔ webgl)`);
      if (def.canvasHeavy === true && !CANVAS_SURFACES.includes(entry.surface)) report("surface", id, "The card's source declares canvasHeavy, but the table does not list it as a canvas card");
    }
    // Whether below-dependent: the two tokens are only used for explicitly named cards
    if (entry.compositing === "fromParts" && !DERIVED_FROM_PARTS.includes(id)) report("compositing", id, "fromParts is only for composite cards");
    if (DERIVED_FROM_PARTS.includes(id) && entry.compositing !== "fromParts") report("compositing", id, "A composite card's compositing is derived from its parts, so write fromParts in the table");
    if (entry.compositing === "unknown" && !DELIBERATELY_UNKNOWN.includes(id)) report("compositing", id, "unknown is only for probe cards that are deliberately not reviewed; a built-in card needs a review conclusion");
  }
  for (const key of Object.keys(table)) if (!used.has(key) && !keysOutsideBuiltin.includes(key)) report("dead-key", key, "A key in the table matches no built-in card");
  return problems;
}

const describe = (problems) => problems.map((p) => `[${p.code}] ${p.id}: ${p.message}`).join("\n");

let kit;
before(async () => { kit = await loadBuiltinCards(ROOT); });
after(async () => { await kit?.close(); });

test("CT-01~CT-04 All built-in cards are fully registered with all three entries in the table, the writing is taken from the declaration, and the table has nothing extra", () => {
  assert.ok(kit.cards.length >= 100, `There should be about a hundred built-in cards, read ${kit.cards.length}`);
  assert.equal(new Set(kit.cards.map((c) => c.id)).size, kit.cards.length, "Built-in card ids are unique");
  const problems = checkCardTable(TABLE, kit.cards);
  assert.equal(problems.length, 0, `The registry table has ${problems.length} problems:\n${describe(problems)}`);
});

test("CT-02 addendum: every built-in card declared as remotion-style is in the table, none missing", () => {
  const declared = kit.cards.filter((c) => c.frameMode === "direct").map((c) => c.id).sort();
  const registered = kit.cards.filter((c) => lookup(TABLE, c.id)?.entry.writing === "remotion").map((c) => c.id).sort();
  assert.deepEqual(registered, declared);
});

test("CT-05 The two places that read the table read the same copy, and both can carry the new fields; wildcards work as before", () => {
  const ids = [...kit.cards.map((c) => c.id), ...Object.keys(TABLE), "no-such-card", "particles", "particles-", "particlesX"];
  for (const id of ids) assert.deepEqual(reviewedCapabilities(id), reviewedCard(id), `${id}: the Node side and frameMode.mjs find different entries`);
  // frameMode.mjs: entries passed through as is, new fields are readable
  assert.deepEqual(reviewedCard("scene-3d"), { writing: "motion", surface: "webgl", compositing: "independent" });
  // Whether it is a canvas card: derived from surface; cards not in table return undefined
  assert.deepEqual(["scene-3d", "particles", "particles-snow", "r6-canvas", "odometer", "sound-keyboard", "no-such-card"].map(reviewedCanvas), [true, true, true, true, false, false, undefined]);
  for (const id of ids) assert.equal(reviewedCanvas(id), reviewedClassification(id)?.canvas, `${id}: the two places disagree on whether it is a canvas card`);
  assert.equal(reviewedCard("caption-track").writing, "remotion");
  assert.equal(reviewedCard("sound-keyboard").surface, "none");
  // Wildcard: `particles-*` matches `particles-xxx`, does not match `particles` (listed separately),
  // nor other prefixes
  assert.deepEqual(reviewedCard("particles-snow"), TABLE["particles-*"]);
  assert.deepEqual(reviewedCard("particles"), TABLE.particles);
  assert.equal(reviewedCard("particlesX"), undefined);
  assert.equal(reviewedCard("no-such-card"), undefined);
  // vision-project.mjs: the three organized items
  assert.deepEqual(reviewedClassification("particles-snow"), { writing: "motion", frameMode: "stateful", surface: "canvas2d", canvas: true, compositing: "independent", reviewed: true });
  assert.deepEqual(reviewedClassification("caption-track"), { writing: "remotion", frameMode: "direct", surface: "dom", canvas: false, compositing: "independent", reviewed: true });
  assert.deepEqual(reviewedClassification("blur-text"), { writing: "motion", frameMode: "stateful", surface: "dom", canvas: false, compositing: "belowDependent", reviewed: true });
  assert.deepEqual(reviewedClassification("composite"), { writing: "motion", frameMode: "stateful", surface: "dom", canvas: false, compositing: "unknown", reviewed: false });
  assert.deepEqual(reviewedClassification("r6-unknown"), { writing: "motion", frameMode: "stateful", surface: "dom", canvas: false, compositing: "unknown", reviewed: false });
  assert.equal(reviewedClassification("no-such-card"), undefined);
  for (const def of kit.cards) {
    const c = reviewedClassification(def.id);
    assert.equal(c.frameMode, def.frameMode, `${def.id}: the writing read on the Node side differs from the declaration`);
    assert.ok(c.writing && c.surface, `${def.id}: the Node side reads incomplete data`);
  }
});

test("CT-06 New fields do not enter the card identity digest: cardCapabilities still has only the original five items, with values matching the registry", () => {
  for (const def of kit.cards) {
    const caps = cardCapabilities(def), entry = lookup(TABLE, def.id).entry;
    assert.deepEqual(Object.keys(caps).sort(), ["canvasHeavy", "compositing", "frameMode", "independentCache", "need_prerendering"], `${def.id}: the capabilities table has extra or missing fields (the whole table goes into the digest)`);
    assert.equal(caps.frameMode, CARD_WRITINGS[entry.writing], `${def.id}: writing`);
    assert.equal(caps.need_prerendering, caps.frameMode === "stateful", `${def.id}:need_prerendering`);
    assert.equal(caps.canvasHeavy, CANVAS_SURFACES.includes(entry.surface), `${def.id}: canvas card`);
    // Composite cards without parts derive independent; the three intentionally unreviewed cards are
    // unknown; the rest equal review conclusions
    const expected = REVIEWED_COMPOSITING.includes(entry.compositing) ? entry.compositing : entry.compositing === "fromParts" ? "independent" : "unknown";
    assert.equal(caps.compositing, expected, `${def.id}: whether it depends on the layer below`);
    assert.equal(caps.independentCache, expected === "independent", `${def.id}:independentCache`);
  }
  // When a composite card has unresolvable parts, it remains unknown (registering into the table
  // does not change its derivation)
  const composite = kit.cards.find((c) => c.id === "composite");
  assert.equal(cardCapabilities(composite, composite.defaults, [{ partId: "x" }]).compositing, "unknown");
  assert.equal(cardCapabilities(composite, composite.defaults, ["blur-text", "odometer"]).compositing, "belowDependent");
});

test("CT-07 src/cards/index.ts still registers these four groups", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/cards/index.ts"), "utf8");
  const call = /registerCards\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(call, "Cannot find the registerCards([...]) line");
  const names = call[1].split(",").map((s) => s.trim().replace(/^\.\.\./, "")).filter(Boolean).sort();
  assert.deepEqual(names, Object.keys(BUILTIN_CARD_GROUPS).sort(), "The built-in card groups changed: BUILTIN_CARD_GROUPS in loadBuiltinCards.mjs must be updated too, otherwise the gatekeeper test does not enumerate all cards");
});

// -- Intentionally broken fixtures: prove that the checks above really report --

const copy = (value) => structuredClone(value);
const codesFor = (problems, id) => problems.filter((p) => p.id === id).map((p) => p.code);

test("CT-08 fixture: a newly added built-in card that is not registered → reports unregistered", () => {
  const added = { id: "brand-new-card", frameMode: "stateful", defaults: {}, Component: () => null };
  const problems = checkCardTable(TABLE, [...kit.cards, added]);
  assert.deepEqual(problems.map((p) => [p.code, p.id]), [["unregistered", "brand-new-card"]]);
  // Once registered, it no longer reports
  assert.deepEqual(checkCardTable({ ...TABLE, "brand-new-card": { writing: "motion", surface: "dom", compositing: "independent" } }, [...kit.cards, added]), []);
  // Deleting an existing card from the table also reports
  const table = copy(TABLE); delete table.odometer;
  assert.deepEqual(checkCardTable(table, kit.cards).map((p) => [p.code, p.id]), [["unregistered", "odometer"]]);
  // Prefixes not covered by wildcards do not count as registered
  const stray = { id: "particlesnew", frameMode: "stateful", defaults: {}, Component: () => null };
  assert.deepEqual(codesFor(checkCardTable(TABLE, [...kit.cards, stray]), "particlesnew"), ["unregistered"]);
});

test("CT-09 fixture: the writing in the table does not match the card's declaration → reports writing", () => {
  // Incorrect table: remotion-style card registered as motion, motion-style card registered
  // as remotion
  for (const [id, wrong] of [["caption-track", "motion"], ["odometer", "remotion"], ["particles-*", "remotion"]]) {
    const table = copy(TABLE); table[id].writing = wrong;
    const problems = checkCardTable(table, kit.cards);
    assert.ok(problems.length > 0 && problems.every((p) => p.code === "writing"), `${id} changed to ${wrong} should report only writing:\n${describe(problems)}`);
    if (!id.endsWith("*")) assert.deepEqual(problems.map((p) => p.id), [id]);
    else assert.ok(problems.length > 50 && problems.every((p) => p.id.startsWith("particles-")), "A wrong wildcard entry is reported for every card it covers");
  }
  // Card changed declaration, table did not follow: also reports (declaration takes precedence)
  const cards = kit.cards.map((c) => (c.id === "odometer" ? { ...c, frameMode: "direct" } : c));
  assert.deepEqual(checkCardTable(TABLE, cards).map((p) => [p.code, p.id]), [["writing", "odometer"]]);
  // Built-in card omits declaration, or wrote legacy value: reports
  const undeclared = kit.cards.map((c) => (c.id === "odometer" ? { ...c, frameMode: undefined } : c));
  assert.deepEqual(checkCardTable(TABLE, undeclared).map((p) => [p.code, p.id]), [["writing", "odometer"]]);
});

test("CT-10 fixture: one of the three missing, or an unrecognized value → reports incomplete", () => {
  for (const field of ["writing", "surface", "compositing"]) {
    const table = copy(TABLE); delete table.odometer[field];
    const problems = checkCardTable(table, kit.cards);
    assert.ok(problems.some((p) => p.code === "incomplete" && p.id === "odometer" && p.message.includes(field)), `Missing ${field} should be reported:\n${describe(problems)}`);
    const bad = copy(TABLE); bad.odometer[field] = "whatever";
    assert.ok(checkCardTable(bad, kit.cards).some((p) => p.code === "incomplete" && p.id === "odometer"), `An unrecognized value in ${field} should be reported`);
  }
  // Having only the old two items (as before modification) does not count as fully registered
  const old = copy(TABLE); old.odometer = { compositing: "belowDependent" };
  assert.deepEqual(codesFor(checkCardTable(old, kit.cards), "odometer").filter((c) => c === "incomplete").length, 2);
});

test("CT-11 fixture: values that must not be written → each is reported", () => {
  const run = (edit) => { const table = copy(TABLE); edit(table); return checkCardTable(table, kit.cards); };
  // Table writes frameMode (unread; writing style only comes from declaration), unrecognized fields
  assert.deepEqual(run((t) => { t.odometer.frameMode = "stateful"; }).map((p) => [p.code, p.id]), [["extra-field", "odometer"]]);
  assert.deepEqual(run((t) => { t.odometer.note = "x"; }).map((p) => [p.code, p.id]), [["extra-field", "odometer"]]);
  // Legacy field canvasHeavy must not be written (writing true or false both report): whether it
  // is a canvas card is derived from surface
  assert.deepEqual(run((t) => { t["scene-3d"].canvasHeavy = true; }).map((p) => [p.code, p.id]), [["extra-field", "scene-3d"]]);
  assert.deepEqual(run((t) => { t.odometer.canvasHeavy = true; }).map((p) => [p.code, p.id]), [["extra-field", "odometer"]]);
  assert.deepEqual(run((t) => { t.odometer.canvasHeavy = false; }).map((p) => [p.code, p.id]), [["extra-field", "odometer"]]);
  // Conflicts with card's own declaration: three-contract card registered as 2D canvas, particle
  // card registered as WebGL, card with visuals registered as without visuals, audio-only card
  // registered as DOM
  assert.deepEqual(codesFor(run((t) => { t["scene-3d"].surface = "canvas2d"; }), "scene-3d"), ["surface"]);
  assert.deepEqual(codesFor(run((t) => { t.particles.surface = "webgl"; }), "particles"), ["surface"]);
  assert.deepEqual(codesFor(run((t) => { t.odometer.surface = "none"; }), "odometer"), ["surface"]);
  assert.deepEqual(codesFor(run((t) => { t["sound-keyboard"].surface = "dom"; }), "sound-keyboard"), ["surface"]);
  // The two tokens are only for explicitly named cards
  assert.deepEqual(run((t) => { t.odometer.compositing = "unknown"; }).map((p) => [p.code, p.id]), [["compositing", "odometer"]]);
  assert.deepEqual(run((t) => { t.odometer.compositing = "fromParts"; }).map((p) => [p.code, p.id]), [["compositing", "odometer"]]);
  assert.deepEqual(run((t) => { t.composite.compositing = "independent"; }).map((p) => [p.code, p.id]), [["compositing", "composite"]]);
  // Keys that do not match any card
  assert.deepEqual(run((t) => { t["gone-card"] = { writing: "motion", surface: "dom", compositing: "independent" }; }).map((p) => [p.code, p.id]), [["dead-key", "gone-card"]]);
});

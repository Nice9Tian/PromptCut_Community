/**
 * Parameter view seen by parameters panel and timeline subtitle (`paramsView.ts`). Run:
 *   node --test src/editor/left/paramsView.test.mjs
 *
 *   PV-01 First check runnable definitions; if none, use read-only view of synced user card;
 *         return undefined if neither has it
 *   PV-02 Copy when controls cannot be rendered: synced card source has controls but none were
 *         recognized → "Parameters for this card cannot be modified in online browser mode yet…";
 *         truly no controls → "This card has no adjustable parameters"; has controls → null
 *   PV-03 Subtitle: current value of the first text control → default value → description
 *   PV-04 Only some controls recognized: render recognized ones as usual, with a line below:
 *         "Other parameters for this card cannot be modified in online browser mode yet…"
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const V = await import(srcUrl("editor/left/paramsView.ts"));
const P = await import(srcUrl("online/pageFlag.ts"));
const PU = await import(srcUrl("online/onlineUnsupported.ts"));

test("PV-01 Look up the definition first, and fall back to the synced view if there is none", () => {
  const built = { id: "b", name: "Built-in", defaults: {}, controls: [], Component: () => null };
  const view = { id: "s", name: "Synced", defaults: { a: 1 }, controls: [], controlsIncomplete: false, synced: true };
  const lookup = { getCard: (id) => (id === "b" ? built : undefined), syncedCardView: (id) => (id === "s" || id === "b" ? view : undefined) };
  assert.equal(V.paramsCardView("b", lookup), built, "The definition takes priority");
  assert.equal(V.paramsCardView("s", lookup), view);
  assert.equal(V.paramsCardView("x", lookup), undefined);
  assert.equal(V.paramsCardView(undefined, lookup), undefined);
});

test("PV-02 Text shown when controls cannot be drawn", () => {
  const unsupported = PU.onlineUnsupported("changing this card's parameters");
  assert.ok(unsupported.includes("changing this card's parameters"), unsupported); // Prefix and suffix come from src/online/pageFlag.ts (still in Chinese)
  assert.equal(V.paramsEmptyText({ name: "s", defaults: {}, controls: [], controlsIncomplete: true }), unsupported, "The source has controls but none were recognized");
  assert.equal(V.paramsEmptyText({ name: "s", defaults: {}, controls: [], controlsIncomplete: false }), V.NO_PARAMS_TEXT);
  assert.equal(V.paramsEmptyText({ name: "b", defaults: {}, controls: [] }), "This card has no adjustable parameters", "A runnable definition with no controls");
  assert.equal(V.paramsEmptyText(undefined), V.NO_PARAMS_TEXT, "Unknown card");
  assert.equal(V.paramsEmptyText({ name: "s", defaults: {}, controls: [{ key: "t", label: "t", type: "text" }], controlsIncomplete: true }), null, "Partly recognized: draw the recognized ones as usual");
});

test("PV-03 Subtitle", () => {
  const view = { name: "s", description: "Description", defaults: { text: " default " }, controls: [{ key: "n", label: "n", type: "number" }, { key: "text", label: "Text", type: "text" }] };
  assert.equal(V.clipSubtitleOf(view, { text: "Changed" }), "Changed");
  assert.equal(V.clipSubtitleOf(view, {}), "default");
  assert.equal(V.clipSubtitleOf({ ...view, defaults: {} }, {}), "Description");
  assert.equal(V.clipSubtitleOf({ name: "s", defaults: {}, controls: [] }, {}), "");
  assert.equal(V.clipSubtitleOf(undefined, {}), "");
});

test("PV-04 Only some controls are recognized: draw the recognized ones as usual, and a line below says the remaining parameters cannot be changed online", () => {
  const partial = { name: "s", defaults: {}, controls: [{ key: "t", label: "t", type: "text" }], controlsIncomplete: true };
  assert.equal(V.paramsPartialText(partial), PU.onlineUnsupported("changing this card's remaining parameters"));
  assert.ok(V.paramsPartialText(partial).includes("changing this card's remaining parameters"));
  assert.equal(V.paramsEmptyText(partial), null, "Recognized ones render as usual");
  assert.equal(V.paramsPartialText({ ...partial, controlsIncomplete: false }), null, "All recognized: no notice");
  assert.equal(V.paramsPartialText({ ...partial, controls: [] }), null, "None recognized: the empty-state message is used, no repeated notice");
  assert.equal(V.paramsPartialText({ name: "b", defaults: {}, controls: [{ key: "t", label: "t", type: "text" }] }), null, "A definition that can run");
  assert.equal(V.paramsPartialText(undefined), null);
});

test("PV-05 unrecognized controls are explained one by one: which one and why; over 5 items it says \"N in total\"; no per-item records returns null", () => {
  const base = { name: "Synced", defaults: {}, controls: [{ key: "a", label: "A", type: "text" }], controlsIncomplete: true };
  assert.equal(V.paramsSkippedText({ ...base }), null, "Old pages have no per-item records");
  assert.equal(V.paramsSkippedText({ ...base, controlsIncomplete: false, skippedControls: [{ reason: "x" }] }), null);
  const one = V.paramsSkippedText({ ...base, skippedControls: [{ key: "side", label: "Position", type: "select", reason: "dropdown is missing choices (options)" }] });
  assert.equal(one, 'Unrecognized parameters: "Position" (side):dropdown is missing choices (options)');
  const mixed = V.paramsSkippedText({ ...base, skippedControls: [{ key: "k", reason: "r1" }, { label: "Label only", reason: "r2" }, { reason: "spread X could not be fetched: the content store has no ./x file" }] });
  assert.equal(mixed, 'Unrecognized parameters: k:r1;"Label only":r2;a control:spread X could not be fetched: the content store has no ./x file');
  const many = V.paramsSkippedText({ ...base, skippedControls: Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, reason: "r" })) });
  assert.match(many, /k4:r; 7 in total$/);
  assert.ok(!many.includes("k5"));
  // When none are recognized, blank copy as before, item-by-item descriptions on a new line
  // (ParamsForm renders below it)
  assert.equal(V.paramsEmptyText({ ...base, controls: [], skippedControls: [{ reason: "r" }] }), PU.onlineUnsupported("changing this card's parameters"));
});

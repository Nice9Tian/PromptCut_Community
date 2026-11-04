/**
 * Pure logic on stage side of placeholder plane (`placeholderHost.ts`).
 * Run: node --test src/render/placeholderHost.test.mjs
 *
 * Pinned behaviors: which of T1~T4 are shown, visibility only toggles slot's `hidden`
 * (`setPlaceholderShown` of contract), three-tier geometry source (stream manifest entity box →
 * ink box → badge), disabled by default (export page / prerender / background stage never opened),
 * and plane stylesheet exempts placeholder plane. Mounting and screenshot / hit exclusion require
 * a browser, verified in `preview-fallback-probe.mjs`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPlaceholders, geometryFor, hideAllPlaceholders, noteInkBox, placeholdersEnabled, placeholderWanted, keepTopOfGroups,
  resetPlaceholderGeometry, setCatchingUpClips, setPlaceholdersEnabled, setStreamBoxSource, shownPlaceholders,
  PLACEHOLDER_SLOT_ATTR,
} from "./placeholderHost.ts";
import { PLANE_CSS } from "./planeStyle.ts";
import { PLACEHOLDER_ATTR } from "./placeholder/contract.ts";

const set = (...ids) => new Set(ids);
/** Mock slot: `hidden` + property table (only these are used by `applyPlaceholders`) */
function fakeSlot(attrs = {}) {
  return {
    hidden: true, attrs: { ...attrs },
    getAttribute(k) { return this.attrs[k] ?? null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    hasAttribute(k) { return k in this.attrs; },
    toggleAttribute(k, on) { if (on) this.attrs[k] = ""; else delete this.attrs[k]; return !!on; },
  };
}
const base = { suppressed: set(), snapshots: new Map(), awaiting: set(), settling: new Map(), streamShowing: set() };

test("Off by default: only the front of the stage page turns it on (export page, prerender and background stage mount no nodes)", () => {
  assert.equal(placeholdersEnabled(), false);
  setPlaceholdersEnabled(true);
  assert.equal(placeholdersEnabled(), true);
  setPlaceholdersEnabled(false);
  assert.equal(placeholdersEnabled(), false);
});

test("T1: suppressed, stream is blank this beat, and no snapshot attached → show; stream has a picture or a snapshot underneath → do not show", () => {
  const w = placeholderWanted({ ...base, suppressed: set("a", "b", "c"), snapshots: new Map([["b", "<div/>"]]), streamShowing: set("c") });
  assert.deepEqual([...w], [["a", "no-data"]]);
});

test("T2 waiting for snapshot, T3 invisible frame catch-up (when no snapshot is underneath), T4 waiting for light cards re-run in the background", () => {
  setCatchingUpClips(["light"]);
  const w = placeholderWanted({
    ...base,
    suppressed: set("light"),
    awaiting: set("aw"),
    settling: new Map([["st", 1], ["st-snap", 2]]),
    snapshots: new Map([["st-snap", "<div/>"]]),
  });
  assert.equal(w.get("light"), "catching-up");
  assert.equal(w.get("aw"), "awaiting");
  assert.equal(w.get("st"), "catching-up");
  assert.equal(w.has("st-snap"), false, "During frame catch-up the snapshot plane is still shown (`.pc-settling` only hides the subtree)");
  setCatchingUpClips([]);
});

test("T2: if this card's stream is drawing this beat (single-card stream, every member of a group stream), do not show; if the stream is not drawing or the snapshot has not arrived, show as before; layers over budget that send no stream are shown as before", () => {
  // Group stream playback starts: both cards are suppressed and waiting for this frame's snapshot;
  // group stream is already rendering (`showingClips` attributes group stream to each member)
  const drawing = placeholderWanted({ ...base, suppressed: set("a", "b"), awaiting: set("a", "b"), streamShowing: set("a", "b") });
  assert.equal(drawing.size, 0, "Stream drawing: placeholder not shown");
  // Only a's stream is rendering: b's stream is not rendering and snapshot hasn't arrived, still shown
  const half = placeholderWanted({ ...base, suppressed: set("a", "b"), awaiting: set("a", "b"), streamShowing: set("a") });
  assert.deepEqual([...half], [["b", "awaiting"]]);
  // Not suppressed (scrubbing playhead while paused) is likewise judged by whether stream is rendering
  assert.equal(placeholderWanted({ ...base, awaiting: set("a"), streamShowing: set("a") }).size, 0);
  assert.equal(placeholderWanted({ ...base, awaiting: set("a") }).get("a"), "awaiting");
  // Layers exceeding budget have no track and are not in streamShowing: suppressed ones are shown (T1),
  // those waiting for snapshots are shown (T2); keep only the topmost one in the same group
  const over = placeholderWanted({ ...base, suppressed: set("o1", "o2", "s"), awaiting: set("o2", "s"), streamShowing: set("s") });
  assert.deepEqual([...over], [["o1", "no-data"], ["o2", "awaiting"]]);
  assert.deepEqual([...keepTopOfGroups(over, [["o1", "o2"]])], [["o2", "awaiting"]]);
});

test("Visibility only toggles the slot's hidden; those shown last beat but not wanted this beat are turned off", () => {
  const slots = { a: fakeSlot(), b: fakeSlot() };
  const slotOf = (id) => slots[id] ?? null;
  assert.equal(applyPlaceholders(new Map([["a", "no-data"], ["gone", "no-data"]]), slotOf), 1, "Skip those with no slot attached");
  assert.equal(slots.a.hidden, false);
  assert.equal(slots.a.attrs["data-pc-placeholder-reason"], "no-data");
  applyPlaceholders(new Map([["b", "awaiting"]]), slotOf);
  assert.equal(slots.a.hidden, true, "a is no longer wanted this beat");
  assert.equal(slots.b.hidden, false);
  hideAllPlaceholders(slotOf);
  assert.equal(slots.b.hidden, true);
  assert.equal(shownPlaceholders().size, 0);
});

test("Geometry: the stream manifest's entity box takes priority, then the ink box, and if neither exists the badge goes at the center of the position box; the same input returns the same object", () => {
  resetPlaceholderGeometry();
  let streamBox = null;
  setStreamBoxSource(() => streamBox);
  const size = { width: 400, height: 200 };
  const badge = geometryFor("c", size);
  assert.deepEqual(badge, { kind: "badge", center: { x: 200, y: 100 } });
  assert.equal(geometryFor("c", size), badge, "Unchanged means the same object (the placeholder component is React.memo)");
  noteInkBox("c", null);
  assert.equal(geometryFor("c", size).kind, "badge", "If the ink box cannot be measured, it is not recorded; no noise overlay");
  noteInkBox("c", { left: 10, top: 20, width: 30, height: 40 });
  assert.deepEqual(geometryFor("c", size), { kind: "solid", box: { left: 10, top: 20, width: 30, height: 40 } });
  streamBox = { x: 1, y: 2, w: 3, h: 4 };
  assert.deepEqual(geometryFor("c", size), { kind: "solid", box: { left: 1, top: 2, width: 3, height: 4 } });
  streamBox = null;
  assert.deepEqual(geometryFor("c", size).box, { left: 1, top: 2, width: 3, height: 4 }, "Stream stopped; the box measured earlier is kept");
  resetPlaceholderGeometry();
  assert.equal(geometryFor("c", size).kind, "badge", "Cleared on project switch");
});

test("The plane stylesheet leaves the placeholder plane alone: none of the four subtree-hiding rules touch the slot or the component root element", () => {
  for (const line of PLANE_CSS.split("\n")) {
    assert.ok(line.includes(`:not([${PLACEHOLDER_SLOT_ATTR}])`), line);
    assert.ok(line.includes(`:not([${PLACEHOLDER_ATTR}])`), line);
  }
});

/* ---------------------------------------------------------------- P3: On-screen limit, visibility and evaluation for cards that cannot run locally */

import { localOnlyClipIds, needsLocalPc, setMaxAnimated, setOnlineBrowserMode, unsupportedHere } from "./placeholderHost.ts";
import { PLACEHOLDER_FIXED_ATTR, PLACEHOLDER_STATIC_ATTR } from "./placeholder/contract.ts";

test("More than maxAnimated on screen at once: the extra slots get a still marker, removed on teardown", () => {
  setMaxAnimated(1);
  const slots = { a: fakeSlot(), b: fakeSlot(), c: fakeSlot() };
  const slotOf = (id) => slots[id] ?? null;
  applyPlaceholders(new Map([["a", "no-data"], ["b", "no-data"], ["c", "awaiting"]]), slotOf);
  const still = Object.entries(slots).filter(([, s]) => s.hasAttribute(PLACEHOLDER_STATIC_ATTR)).map(([id]) => id);
  assert.equal(still.length, 2, "Only one is spinning");
  hideAllPlaceholders(slotOf);
  for (const s of Object.values(slots)) {
    assert.equal(s.hidden, true);
    assert.equal(s.hasAttribute(PLACEHOLDER_STATIC_ATTR), false);
  }
  setMaxAnimated(Infinity);
});

test("The hourglass of a card that cannot run on this machine enters the visibility scheduler: shown with a reason label when wanted, removed when not; the old persistent marker has no privilege", () => {
  const slot = fakeSlot();
  const slotOf = () => slot;
  applyPlaceholders(new Map([["u", "awaiting"]]), slotOf);
  assert.equal(slot.hidden, false);
  assert.equal(slot.getAttribute("data-pc-placeholder-reason"), "awaiting");
  applyPlaceholders(new Map(), slotOf);
  assert.equal(slot.hidden, true, "Snapshot or stream arrived: removed if not wanted this beat");
  // The legacy resident flag is no longer privileged: it is scheduled as usual even with the flag
  const legacy = fakeSlot({ [PLACEHOLDER_FIXED_ATTR]: "" });
  legacy.hidden = false;
  applyPlaceholders(new Map([["x", "awaiting"]]), () => legacy);
  applyPlaceholders(new Map(), () => legacy);
  assert.equal(legacy.hidden, true);
});

test("placeholderWanted: a card that cannot run on this machine with no snapshot / stream attached is always an awaiting hourglass (since 2026-10-21 there is no \"Needs local PC render assist\"); if one is attached, not shown", () => {
  const unsupported = new Set(["u", "s", "w", "q"]);
  const wanted = placeholderWanted({
    suppressed: new Set(["u", "b", "w", "q"]),
    snapshots: new Map([["s", "<div/>"]]),
    awaiting: new Set(["u", "a"]),
    settling: new Map([["u", 0]]),
    streamShowing: new Set(["w"]),
    unsupported,
    isLight: () => false,
  });
  assert.equal(wanted.get("u"), "awaiting", "Suppressed, waiting for snapshot, frame catch-up: all show the hourglass (the result comes from the render node)");
  assert.equal(wanted.get("q"), "awaiting");
  assert.equal(wanted.has("s"), false, "Snapshot attached: not shown");
  assert.equal(wanted.has("w"), false, "Stream drawing this beat: not shown");
  assert.equal(wanted.get("b"), "no-data", "Built-in cards unchanged");
  assert.equal(wanted.get("a"), "awaiting");
  // Displays hourglass even when not suppressed and not waiting for snapshot (paused):
  // it has no live render locally, waiting for results from render node
  const idle = { suppressed: new Set(), snapshots: new Map(), awaiting: new Set(), settling: new Map(), streamShowing: new Set(), unsupported: new Set(["p"]) };
  assert.equal(placeholderWanted(idle).get("p"), "awaiting", "Also an hourglass when paused");
  for (const r of [...wanted.values(), ...placeholderWanted(idle).values()]) assert.notEqual(r, "unsupported");
  // Without unsupported: identical to before item by item
  const old = placeholderWanted({ suppressed: new Set(["u"]), snapshots: new Map(), awaiting: new Set(), settling: new Map(), streamShowing: new Set(), isLight: () => false });
  assert.deepEqual([...old], [["u", "no-data"]]);
});

test("needsLocalPc / localOnlyClipIds: synced user cards are recognized even without a definition; ids absent from both sides do not count; default looks up the registry", async () => {
  const R = await import("../kernel/registry.ts");
  R.setUserCardSources({ built: "" }, { "built-user": "built" });
  R.setSyncedUserCards([{ id: "synced-user", name: "Synced card" }]);
  try {
    assert.equal(needsLocalPc("synced-user", undefined), true, "Synced user card: recognized even without a def");
    assert.equal(needsLocalPc("built-user", { Component: () => null }), true, "Build-time user card");
    assert.equal(needsLocalPc("nobody", undefined), false, "Absent on both sides: unknown card, does not count");
    assert.equal(needsLocalPc("builtin", { Component: () => null }), false);
    assert.equal(needsLocalPc("graph", { card: () => ({}) }), true);
    const clips = [{ id: "a", cardId: "synced-user" }, { id: "b", cardId: "built-user" }, { id: "c", cardId: "nobody" }, { id: "d" }];
    assert.deepEqual([...localOnlyClipIds(clips)], [], "Mode off: empty");
    setOnlineBrowserMode(true);
    try {
      assert.deepEqual([...localOnlyClipIds(clips)].sort(), ["a", "b"]);
      assert.equal(unsupportedHere("synced-user", undefined), true);
    } finally {
      setOnlineBrowserMode(false);
    }
  } finally {
    R.setSyncedUserCards([]);
    R.setUserCardSources({}, {});
  }
});

test("OCE-X-01 export page for online export: only after the switch is on, the wrapper layer of synced user cards (no definition) is mounted; built-in cards, cards with definitions, unknown cards, and switch off are all unaffected", async () => {
  const R = await import("../kernel/registry.ts");
  const H = await import("./placeholderHost.ts");
  R.setSyncedUserCards([{ id: "synced-user", name: "Synced card" }]);
  try {
    assert.equal(H.exportSyncedMountFor("synced-user", undefined), false, "switch is off (always the case on desktop, preview, prerender): do not mount");
    H.setExportSyncedMount(true);
    assert.equal(H.exportSyncedMountFor("synced-user", undefined), true, "synced card has no definition: mount the wrapper layer so it can be swapped for the prerender's original size");
    assert.equal(H.exportSyncedMountFor("synced-user", { Component: () => null }), false, "cards with a definition (already in the bundle at build time) take the original path");
    assert.equal(H.exportSyncedMountFor("nobody", undefined), false, "a card missing on both sides is an unknown card, still not drawn");
    assert.equal(H.exportSyncedMountFor("builtin-card", undefined), false);
    assert.equal(H.exportSyncedMountFor(undefined, undefined), false);
    H.setExportSyncedMount(false);
    assert.equal(H.exportSyncedMountFor("synced-user", undefined), false, "turned off, then restored");
  } finally {
    H.setExportSyncedMount(false);
    R.setSyncedUserCards([]);
  }
});

test("unsupported: only in online browser mode, and only for user cards and media effect cards", () => {
  const isUser = (id) => id === "my-card";
  const dom = { Component: () => null };
  const graph = { card: () => ({}) };
  const audio = { audio: () => ({}) };
  assert.equal(unsupportedHere("my-card", dom, isUser), false, "mode is off: never counts");
  setOnlineBrowserMode(true);
  try {
    assert.equal(unsupportedHere("my-card", dom, isUser), true, "user card");
    assert.equal(unsupportedHere("builtin-dom", dom, isUser), false, "built-in DOM cards render as usual");
    assert.equal(unsupportedHere("builtin-graph", graph, isUser), true, "素材效果卡");
    assert.equal(unsupportedHere("builtin-audio", audio, isUser), true, "audio media effect card");
    assert.equal(unsupportedHere(undefined, dom, isUser), false, "media clip has no cardId");
  } finally {
    setOnlineBrowserMode(false);
  }
});

/* ---------------------------------------------------------------- Placeholder size on screen (pure function in placeholderFit.test.mjs) */

import { placeholderFitFor, placeholderViewScale, setPlaceholderViewScale } from "./placeholderHost.ts";

test("placeholderFitFor: the hourglass only cancels the preview zoom; the badge uses the position box, fill uses the solid box; the same input returns the same object", () => {
  try {
    assert.equal(setPlaceholderViewScale(0.25), true);
    assert.equal(setPlaceholderViewScale(0.25), false, "unchanged returns false");
    assert.equal(placeholderViewScale(), 0.25);
    const badge = { kind: "badge", center: { x: 320, y: 180 } };
    const size = { width: 640, height: 360 };
    const h = placeholderFitFor("h", "awaiting", badge, size, 0.5);
    assert.deepEqual(h, { scale: 4 }, "hourglass: 1 / 0.25, ignoring this layer's 0.5");
    assert.equal(placeholderFitFor("h", "awaiting", badge, size, 0.5), h, "same input, same object");
    const solid = { kind: "solid", box: { left: 0, top: 0, width: 20, height: 20 } };
    assert.ok(placeholderFitFor("s", "no-data", solid, size, 1).scale < 1, "fill form uses the solid box (a 4x hourglass does not fit in 20×20, scale to the box)");
    setPlaceholderViewScale(1);
    assert.deepEqual(placeholderFitFor("h", "awaiting", badge, size, 1), { scale: 1 }, "preview 100%: unchanged");
    for (const bad of [0, -1, NaN, undefined, "x"]) { setPlaceholderViewScale(bad); assert.equal(placeholderViewScale(), 1, String(bad)); }
  } finally {
    setPlaceholderViewScale(1);
  }
});

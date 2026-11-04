/**
 * Unit tests for kernel/parts.ts. Run: node --test src/kernel/parts.test.mjs
 *
 * The part instance tree is the entirety of a composite card; Agent's add_part / set_part /
 * remove_part / move_part all land here:
 *   - Add, delete, update, and move return a new tree without mutating the original tree;
 *   - If any validation fails, the entire tree is not written, and errors are human-readable;
 *   - World coordinates compose hierarchically by parent box; timing accumulates via enterMs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { addPart, removePart, updatePart, movePart, validatePartFrame, validatePartTree, placeParts, partsTiming, findPart, flattenParts, MAX_PART_NODES } from "./parts.ts";

const title = {
  id: "text-title", name: "Title", description: "", role: "text",
  defaults: { text: "T", size: 48 },
  controls: [{ key: "text", label: "Title", type: "text", required: true }, { key: "size", label: "Font size", type: "number" }],
  defaultFrame: { x: 100, y: 100, w: 800, h: 160 },
  settleMs: () => 600,
  after: "hold",
  Component: () => null,
};
const pins = {
  id: "list-pins", name: "Pinboard key points", description: "", role: "list",
  defaults: { items: "a|b|c", stepMs: 200 },
  controls: [{ key: "items", label: "Key points", type: "text", required: true }, { key: "stepMs", label: "Interval", type: "number" }],
  settleMs: (p) => (p.items.split("|").filter(Boolean).length - 1) * p.stepMs + 400,
  after: "hold",
  Component: () => null,
};
const box = { id: "group-box", name: "Group", description: "", role: "group", defaults: {}, controls: [], after: "evolve", Component: () => null };
const lookup = (id) => ({ "text-title": title, "list-pins": pins, "group-box": box })[id];

test("addPart: the default frame comes from the part, params are merged with defaults, the original tree is untouched; removePart / updatePart / movePart each return a new tree", () => {
  const t0 = [];
  const { tree: t1, node } = addPart(t0, { partId: "text-title", params: { text: "Hi" } }, lookup);
  assert.equal(t0.length, 0, "The original tree is untouched");
  assert.deepEqual(node.frame, { x: 100, y: 100, w: 800, h: 160 });
  assert.deepEqual(node.params, { text: "Hi", size: 48 });

  const { tree: t2 } = addPart(t1, { partId: "list-pins", id: "pins", frame: { x: 0, y: 300 }, enterMs: 300 }, lookup);
  assert.deepEqual(t2.map((n) => n.id), [node.id, "pins"]);
  assert.equal(t1.length, 1);

  const { tree: t3 } = updatePart(t2, "pins", { params: { stepMs: 500 }, frame: null, label: "Key points" }, lookup);
  const pinsNode = findPart(t3, "pins").node;
  assert.equal(pinsNode.params.stepMs, 500);
  assert.equal(pinsNode.params.items, "a|b|c", "Sparse merge");
  assert.equal(pinsNode.frame, undefined, "frame null = cleared");
  assert.equal(pinsNode.label, "Key points");
  assert.equal(findPart(t2, "pins").node.params.stepMs, 200, "The original tree is untouched");

  const { tree: t4 } = addPart(t3, { partId: "group-box", id: "g" }, lookup, { index: 0 });
  const t5 = movePart(t4, "pins", { parentId: "g" });
  assert.deepEqual(t5.map((n) => n.id), ["g", node.id]);
  assert.deepEqual(findPart(t5, "g").node.children.map((n) => n.id), ["pins"]);
  assert.equal(findPart(t5, "pins").parentId, "g");
  assert.equal(flattenParts(t5).length, 3);

  const t6 = removePart(t5, "g");
  assert.deepEqual(flattenParts(t6).map((n) => n.id), [node.id], "Deleting a parent node deletes its subtree too");
});

test("Validation: plain-language errors, and if one spot fails the whole tree is rejected", () => {
  assert.throws(() => addPart([], { partId: "nope" }, lookup), /No part with id "nope"/);
  assert.throws(() => addPart([], { partId: "text-title", params: { size: "big" } }, lookup), /needs a number/);
  assert.throws(() => addPart([], { partId: "text-title", params: { text: "" } }, lookup), /required/);
  assert.throws(() => addPart([], { partId: "text-title", params: { nope: 1 } }, lookup), /is not a parameter of part text-title/);
  assert.throws(() => addPart([], { partId: "text-title", frame: { x: 1 } }, lookup), /frame\.x \/ frame\.y of .+ must be numbers/);
  assert.throws(() => addPart([], { partId: "text-title", enterMs: -1 }, lookup), /non-negative/);
  const { tree } = addPart([], { partId: "text-title", id: "a" }, lookup);
  assert.throws(() => addPart(tree, { partId: "text-title", id: "a" }, lookup), /already exists/);
  assert.throws(() => movePart(tree, "a", { parentId: "a" }), /its own subtree/);
  assert.throws(() => removePart(tree, "zzz"), /Part instance zzz not found/);
  // Whole-tree validation: if the second is invalid, the first doesn't count either
  assert.throws(() => validatePartTree([{ id: "a", partId: "text-title", params: { text: "x" } }, { id: "a", partId: "text-title", params: { text: "y" } }], lookup), /Duplicate/);
  assert.throws(() => validatePartTree("nope", lookup), /must be an array/);
  const ok = validatePartTree([{ id: "a", partId: "text-title", params: { text: "x" }, frame: { x: 1, y: 2 }, enterMs: 0, children: [{ id: "b", partId: "list-pins", params: {} }] }], lookup);
  assert.equal(ok[0].enterMs, undefined, "0 is not stored");
  assert.deepEqual(ok[0].children[0].params, { items: "a|b|c", stepMs: 200 }, "Child instance params are also filled in with defaults");
});

test("placeParts: local frames are composed level by level relative to the parent frame into on-screen rectangles; scaling is around the anchor", () => {
  const tree = [
    { id: "g", partId: "group-box", params: {}, frame: { x: 100, y: 50, w: 800, h: 400 }, children: [
      { id: "t", partId: "text-title", params: {}, frame: { x: 10, y: 20, w: 200, h: 100 } },
      { id: "s", partId: "text-title", params: {}, frame: { x: 400, y: 200, w: 200, h: 100, anchor: [0.5, 0.5], scale: 2 } },
    ] },
    { id: "full", partId: "list-pins", params: {} },
  ];
  const placed = placeParts(tree, { box: { left: 0, top: 0, width: 1920, height: 1080 }, scale: 1 });
  assert.deepEqual(placed.get("g").world, { left: 100, top: 50, width: 800, height: 400 });
  assert.deepEqual(placed.get("t").world, { left: 110, top: 70, width: 200, height: 100 }, "The child frame adds the parent frame's offset");
  const s = placed.get("s").world;
  assert.deepEqual([s.left, s.top, s.width, s.height], [100 + 300 - 100, 50 + 150 - 50, 400, 200], "Anchor centered, scaled up 2x: the center stays put and each side extends outward by half");
  assert.deepEqual(placed.get("full").world, { left: 0, top: 0, width: 1920, height: 1080 }, "No frame = fills the parent frame");
  // The composite card itself is scaled to half and moved to (200,100)
  const half = placeParts(tree, { box: { left: 200, top: 100, width: 960, height: 540 }, scale: 0.5 });
  assert.deepEqual(half.get("g").world, { left: 250, top: 125, width: 400, height: 200 });
  assert.deepEqual(half.get("t").world, { left: 255, top: 135, width: 100, height: 50 });
});

test("partsTiming: enterMs accumulates level by level, settleMs follows the part formula, and after takes the most active one", () => {
  const tree = [
    { id: "t", partId: "text-title", params: {}, enterMs: 100 },
    { id: "g", partId: "group-box", params: {}, enterMs: 500, children: [
      { id: "p", partId: "list-pins", params: { items: "a|b|c|d", stepMs: 250 }, enterMs: 200 },
    ] },
  ];
  const tm = partsTiming(tree, lookup);
  assert.deepEqual(tm.parts.get("t"), { enterMs: 100, settleMs: 700, after: "hold" });
  assert.equal(tm.parts.get("p").enterMs, 700, "A child instance's entrance = parent entrance + its own enterMs");
  assert.equal(tm.parts.get("p").settleMs, 700 + 3 * 250 + 400);
  assert.equal(tm.settleMs, 700 + 3 * 250 + 400);
  assert.equal(tm.after, "evolve", "If one part keeps changing, the whole card counts as continuously changing");
  assert.equal(partsTiming([tree[0]], lookup).after, "hold");
});

test("The tree has a node limit; frame is rebuilt with a fixed key order when written back", () => {
  const many = Array.from({ length: MAX_PART_NODES + 1 }, (_, i) => ({ id: "n" + i, partId: "text-title", params: { text: "x" } }));
  assert.throws(() => validatePartTree(many, lookup), /at most/);
  const ok = validatePartTree([{ id: "a", partId: "text-title", params: { text: "x" }, frame: { scale: 2, y: 1, x: 0, anchor: [0.5, 0.5] } }], lookup);
  assert.deepEqual(Object.keys(ok[0].frame), ["x", "y", "anchor", "scale"]);
});

/*
 * Part-level 3D: **reject**, not support.
 *
 * Adding 3D to clip-level FRAME_KEYS was to fix set_clip (see envelope.test.mjs); one version
 * allowed it at the part level too, but rendering could not handle it: CSS perspective only
 * applies to direct children and does not propagate to the part cell. In testing, the bounding box
 * height of a part rotateY(40°) without preserve-3d on the card is 300.00 (pure affine), but with
 * preserve-3d it becomes 336.44 (true perspective), and once the card has opacity/filter it reverts
 * to 300.00. Three cases, three results: so reject immediately with a clear explanation.
 */
test("A part's frame rejects 3D and tells the caller what to do instead", () => {
  for (const k of ["rotateX", "rotateY", "translateZ"]) {
    assert.throws(
      () => validatePartFrame({ x: 0, y: 0, [k]: 30 }, "Part a"),
      new RegExp(`does not support ${k} yet`),
      `${k} should be rejected`,
    );
  }
  // Error messages must provide guidance, not just say "unrecognized"
  assert.throws(() => validatePartFrame({ x: 0, y: 0, rotateY: 30 }, "Part a"), /set_position/);
});

test("A part's frame: the in-plane fields are accepted as usual, and no extra keys are carried", () => {
  assert.deepEqual(validatePartFrame({ x: 1, y: 2, scale: 0.5, rotate: 8 }, "Part a"), { x: 1, y: 2, scale: 0.5, rotate: 8 });
});

test("A part's frame: unrecognized keys are still rejected with the old wording", () => {
  assert.throws(() => validatePartFrame({ x: 0, y: 0, wat: 1 }, "Part a"), /does not recognize "wat"/);
});

/**
 * Unit tests for kernel/envelope.ts. Run: node --test src/kernel/envelope.test.mjs
 *
 * The envelope is the only entry point for Agents and code pages to inspect a card; reading and
 * writing must be self-consistent:
 *   - Extracted parts carry only their respective params, params is full, both are the same data;
 *   - Writing back touches only segments with differences, in a fixed order;
 *   - Invalid inputs write nothing (leaving no partial state), error messages are human-readable;
 *   - Read-only segments (world / motion / lifecycle) have no effect even if written.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { envelopeOf, applyEnvelope, ENVELOPE_SCHEMA, describeLifecycle, rejectAudioVolumeKeys } from "./envelope.ts";

const STAGE = { width: 1920, height: 1080 };

const card = {
  id: "pin-board",
  name: "Key points pin board",
  source: "native",
  description: "",
  defaults: { position: "left", accent: "", title: "SUMMARY", subtitle: "核心要点总结", items: "a|b|c", stepMs: 200 },
  controls: [
    { key: "position", label: "Position", type: "select", options: [{ value: "left", label: "l" }, { value: "center", label: "c" }] },
    { key: "accent", label: "Primary color", type: "color" },
    { key: "title", label: "Heading", type: "text" },
    { key: "subtitle", label: "Subtitle", type: "text" },
    { key: "items", label: "Key points", type: "text" },
    { key: "stepMs", label: "Interval", type: "number" },
  ],
  parts: [
    { id: "title", label: "Heading", role: "text", params: ["title"], enterMs: 0, settleMs: 600 },
    { id: "subtitle", label: "Subtitle", role: "text", params: ["subtitle", "accent"], enterMs: 100, settleMs: 700 },
    { id: "items", label: "Key points", role: "list", params: ["items", "stepMs"], enterMs: 300, settleMs: 1100 },
  ],
  lifecycle: { settleMs: 1100, after: "hold", exit: ["fade"] },
  Component: () => null,
};

function project(clip) {
  return { name: "p", width: 1920, height: 1080, fps: 30, duration: 20, themeId: "t", media: [], tracks: [{ id: "t1", kind: "overlay", name: "Track 1", clips: [clip] }], cuts: [] };
}

function clipOf(extra = {}) {
  return { id: "c1", cardId: "pin-board", start: 2.4, end: 5.4, params: { ...card.defaults }, ...extra };
}

function recorder() {
  const calls = [];
  return {
    calls,
    writer: {
      setClipCard: (id, cardId) => calls.push(["card", id, cardId]),
      setClipParams: (id, params, opts) => calls.push(["params", id, params, opts]),
      moveClip: (id, patch) => calls.push(["time", id, patch]),
      setClipFrame: (id, frame) => calls.push(["frame", id, frame]),
      updateClip: (id, patch) => calls.push(["blend", id, patch]),
    },
  };
}

// validateCardParams uses the global registry; register this card in the test
const { registerCards } = await import("./registry.ts");
registerCards([card]);

test("Read: parts carry only their own params, params is the full set, lifecycle comes from the card, world is computed from frame", () => {
  const env = envelopeOf(project(clipOf()), clipOf(), card, STAGE);
  assert.equal(env.$schema, ENVELOPE_SCHEMA);
  assert.equal(env.card.lifecycle.settleMs, 1100);
  assert.deepEqual(env.time, { start: 2.4, end: 5.4, duration: 3 });
  assert.equal(env.frame.local, null);
  assert.equal(env.frame.world.w, 1920);
  assert.deepEqual(env.blend, { opacity: 1, fadeIn: 0, fadeOut: 0 });
  assert.equal(env.motion.attached, false);
  assert.deepEqual(env.parts.map((p) => p.id), ["title", "subtitle", "items"]);
  assert.deepEqual(env.parts[1].params, { subtitle: "核心要点总结", accent: "" });
  assert.equal(Object.keys(env.params).length, 6);
  assert.equal(env.missingParams, undefined);
  assert.match(describeLifecycle(env), /settles in about 1\.1s/);
  assert.match(describeLifecycle(env), /is static for 1\.9s/);
});

test("Read: a card that declares no parts is one root part and all params belong to it; params missing on an old clip are listed in missingParams", () => {
  const bare = { ...card, id: "bare", parts: undefined, lifecycle: undefined };
  const clip = clipOf({ cardId: "bare", params: { title: "x" } });
  const env = envelopeOf(project(clip), clip, bare, STAGE);
  assert.equal(env.parts.length, 1);
  assert.equal(env.parts[0].id, "root");
  assert.deepEqual(env.parts[0].params, { title: "x" });
  assert.deepEqual(env.card.lifecycle, { after: "hold", exit: ["fade"] });
  assert.deepEqual(env.missingParams.sort(), ["accent", "items", "position", "stepMs", "subtitle"]);
});

test("Write: passing it back unchanged writes nothing; changing one section writes only that section", () => {
  const clip = clipOf();
  const env = envelopeOf(project(clip), clip, card, STAGE);
  const r0 = recorder();
  assert.deepEqual(applyEnvelope(project(clip), "c1", env, card, STAGE, r0.writer, () => card).changed, []);
  assert.equal(r0.calls.length, 0);

  const r1 = recorder();
  const edited = JSON.parse(JSON.stringify(env));
  edited.blend.fadeOut = 0.4;
  edited.time.end = 3.6;
  const rep = applyEnvelope(project(clip), "c1", edited, card, STAGE, r1.writer, () => card);
  assert.deepEqual(rep.changed, ["time", "blend"]);
  assert.deepEqual(r1.calls, [["time", "c1", { start: 2.4, end: 3.6 }], ["blend", "c1", { fadeOut: 0.4 }]]);
});

test("Write: putting volume into blend is rejected on the spot with a pointer to set_clip_volume, and nothing is written (it used to return changed: [] which looked like success)", () => {
  const clip = clipOf();
  const r = recorder();
  assert.throws(
    () => applyEnvelope(project(clip), "c1", { blend: { volume: 0.3, fadeOut: 0.4 } }, card, STAGE, r.writer, () => card),
    /set_clip_volume/,
  );
  assert.equal(r.calls.length, 0);
});

test("update_clip params: volume / audioVolume / gain are rejected with a pointer to the right tool, other params pass as usual", () => {
  assert.throws(() => rejectAudioVolumeKeys({ clipId: "c1", volume: "0.3" }, "update_clip"), /update_clip.*set_clip_volume/);
  assert.throws(() => rejectAudioVolumeKeys({ clipId: "c1", audioVolume: 0.5 }, "update_clip"), /audioVolume/);
  assert.doesNotThrow(() => rejectAudioVolumeKeys({ clipId: "c1", opacity: 0.5, fadeIn: 1 }, "update_clip"));
  assert.doesNotThrow(() => rejectAudioVolumeKeys(undefined, "update_clip"));
});

test("Write: changing a param inside parts equals changing params; if both are given, params wins", () => {
  const clip = clipOf();
  const env = envelopeOf(project(clip), clip, card, STAGE);
  const r = recorder();
  const edited = JSON.parse(JSON.stringify(env));
  edited.parts[0].params.title = "TAKEAWAYS";
  assert.deepEqual(applyEnvelope(project(clip), "c1", edited, card, STAGE, r.writer, () => card).changed, ["params"]);
  assert.equal(r.calls[0][2].title, "TAKEAWAYS");
  assert.equal(r.calls[0][2].items, "a|b|c", "Unchanged params are carried over as is");

  const r2 = recorder();
  applyEnvelope(project(clip), "c1", { params: { ...clip.params, title: "P" }, parts: edited.parts }, card, STAGE, r2.writer, () => card);
  assert.equal(r2.calls[0][2].title, "P");
});

test("Write: frame.local is writable, world is read-only; null clears the frame", () => {
  const clip = clipOf({ frame: { x: 100, y: 100, anchor: [0, 0] } });
  const r = recorder();
  applyEnvelope(project(clip), "c1", { frame: { local: { x: 200, y: 300, w: 640, h: 360, anchor: [0.5, 0.5], scale: 0.5 }, world: { x: 1 } } }, card, STAGE, r.writer, () => card);
  assert.deepEqual(r.calls, [["frame", "c1", { x: 200, y: 300, w: 640, h: 360, anchor: [0.5, 0.5], scale: 0.5 }]]);
  const r2 = recorder();
  applyEnvelope(project(clip), "c1", { frame: { local: null } }, card, STAGE, r2.writer, () => card);
  assert.deepEqual(r2.calls, [["frame", "c1", undefined]]);
});

test("Write: if any part is invalid, nothing is written, and errors are in plain language", () => {
  const clip = clipOf();
  const bad = [
    [{ time: { end: 1 } }, /end > start/],
    [{ frame: { local: { x: 1 } } }, /x and y of frame\.local must be numbers/],
    [{ frame: { local: { x: 1, y: 1, foo: 2 } } }, /does not recognize "foo"/],
    [{ blend: { opacity: 2 } }, /0~1/],
    [{ card: { id: "nope" } }, /No such card/],
    [{ params: { position: "top" } }, /can only be left \/ center/],
    [{ params: { nope: 1 } }, /is not a parameter of pin-board/],
    [{ blend: { fadeIn: -1 }, time: { end: 9 } }, /cannot be negative/],
  ];
  for (const [input, re] of bad) {
    const r = recorder();
    assert.throws(() => applyEnvelope(project(clip), "c1", input, card, STAGE, r.writer, (id) => (id === "pin-board" ? card : undefined)), re, JSON.stringify(input));
    assert.equal(r.calls.length, 0, "Nothing should be written when invalid:" + JSON.stringify(input));
  }
});

test("Write: changing the card comes before writing params, and the new card's params are validated against the new card", () => {
  const other = { ...card, id: "other-card", controls: [{ key: "text", label: "Text", type: "text", required: true }], defaults: { text: "" }, parts: undefined };
  registerCards([card, other]);
  const clip = clipOf();
  const r = recorder();
  const rep = applyEnvelope(project(clip), "c1", { card: { id: "other-card" }, params: { text: "hi" } }, card, STAGE, r.writer, (id) => (id === "other-card" ? other : card));
  assert.deepEqual(rep.changed, ["card", "params"]);
  assert.equal(r.calls[0][0], "card");
  assert.throws(() => applyEnvelope(project(clip), "c1", { card: { id: "other-card" } }, card, STAGE, recorder().writer, (id) => (id === "other-card" ? other : card)), /required/);
});

test("Timing is recomputed with params: more items settle later; the static value is only a reference under the default params", () => {
  const timed = {
    ...card,
    id: "timed-card",
    timing: (p) => {
      const count = String(p.items).split("|").filter(Boolean).length;
      const settle = 300 + (count - 1) * Number(p.stepMs) + 400;
      return { settleMs: settle, parts: { items: { settleMs: settle } } };
    },
  };
  registerCards([card, timed]);
  const base = clipOf({ cardId: "timed-card" });
  const env0 = envelopeOf(project(base), base, timed, STAGE);
  assert.equal(env0.card.lifecycle.settleMs, 1100, "Default 3 items × 200ms matches the static declaration");
  const more = clipOf({ cardId: "timed-card", params: { ...card.defaults, items: "a|b|c|d|e|f", stepMs: 500 } });
  const env1 = envelopeOf(project(more), more, timed, STAGE);
  assert.equal(env1.card.lifecycle.settleMs, 300 + 5 * 500 + 400);
  assert.equal(env1.parts.find((p) => p.id === "items").settleMs, 300 + 5 * 500 + 400);
  assert.equal(env1.parts.find((p) => p.id === "title").settleMs, 600, "Parts not mentioned in timing keep the static value");
  // Timing calculation failures must not crash the envelope
  const broken = { ...timed, id: "broken-card", timing: () => { throw new Error("boom"); } };
  registerCards([card, broken]);
  const b = clipOf({ cardId: "broken-card" });
  assert.equal(envelopeOf(project(b), b, broken, STAGE).card.lifecycle.settleMs, 1100);
});

test("Composite card: parts is an instance tree with partId / on-screen position / timing; writing back replaces the whole tree, read-only sections have no effect", () => {
  const compositeCard = { id: "composite", name: "Composite card", source: "native", description: "", defaults: {}, controls: [], lifecycle: { after: "hold", exit: ["fade"] }, Component: () => null };
  registerCards([card, compositeCard]);
  const titlePart = {
    id: "text-title", name: "Title", description: "", role: "text",
    defaults: { text: "T", size: 48 }, controls: [{ key: "text", label: "Title", type: "text", required: true }, { key: "size", label: "Font size", type: "number" }],
    defaultFrame: { x: 100, y: 100, w: 800, h: 160 }, settleMs: () => 600, after: "hold", Component: () => null,
  };
  const lookup = (id) => (id === "text-title" ? titlePart : undefined);
  const clip = { id: "c1", cardId: "composite", start: 0, end: 4, params: {}, frame: { x: 0, y: 0, w: 960, h: 540 },
    parts: [{ id: "a", partId: "text-title", params: { text: "Hi", size: 48 }, frame: { x: 100, y: 100, w: 800, h: 160 }, enterMs: 300 }] };
  const env = envelopeOf(project(clip), clip, compositeCard, STAGE, lookup);
  assert.equal(env.card.composite, true);
  assert.equal(env.card.lifecycle.settleMs, 900, "300 entrance + 600 settle");
  assert.equal(env.parts[0].partId, "text-title");
  assert.equal(env.parts[0].label, "Title");
  assert.deepEqual(env.parts[0].frame.local, { x: 100, y: 100, w: 800, h: 160 });
  assert.deepEqual(env.parts[0].frame.world, { left: 100, top: 100, width: 800, height: 160 }, "The composite card canvas is at (0,0), scale 1");
  assert.deepEqual(env.parts[0].params, { text: "Hi", size: 48 });

  // Write back as-is: no changes
  const r0 = recorder(); r0.writer.setClipParts = (id, parts) => r0.calls.push(["parts", id, parts]);
  assert.deepEqual(applyEnvelope(project(clip), "c1", env, compositeCard, STAGE, r0.writer, (id) => (id === "composite" ? compositeCard : card), lookup).changed, []);

  // Modify parameters and box of one part, add one part
  const edited = JSON.parse(JSON.stringify(env));
  edited.parts[0].params.text = "Hello";
  edited.parts[0].frame.local = { x: 50, y: 60, w: 700, h: 120 };
  edited.parts[0].frame.world = { left: 999, top: 999, width: 1, height: 1 };
  edited.parts.push({ id: "b", partId: "text-title", params: { text: "Sub" }, enterMs: 500 });
  const r1 = recorder(); r1.writer.setClipParts = (id, parts) => r1.calls.push(["parts", id, parts]);
  const rep = applyEnvelope(project(clip), "c1", edited, compositeCard, STAGE, r1.writer, (id) => (id === "composite" ? compositeCard : card), lookup);
  assert.deepEqual(rep.changed, ["parts"]);
  const tree = r1.calls[0][2];
  assert.equal(tree[0].params.text, "Hello");
  assert.deepEqual(tree[0].frame, { x: 50, y: 60, w: 700, h: 120 }, "Only local is written in, world is ignored");
  assert.equal(tree[0].label, undefined, "The part name is for display and is not stored");
  assert.deepEqual(tree[1], { id: "b", partId: "text-title", params: { text: "Sub", size: 48 }, enterMs: 500 }, "New instance params are filled in with defaults");

  // Malformed trees are rejected entirely
  const bad = JSON.parse(JSON.stringify(env));
  bad.parts.push({ id: "a", partId: "text-title", params: {} });
  assert.throws(() => applyEnvelope(project(clip), "c1", bad, compositeCard, STAGE, recorder().writer, () => compositeCard, lookup), /Duplicate/);
});

test("Composite card: writing a nested part tree back unchanged does not count as a change (enterMs stays relative to the parent), enterAtMs is an absolute time; in a scaled composite card, a part's on-screen position is computed from the scaled frame", () => {
  const compositeCard = { id: "composite", name: "Composite card", source: "native", description: "", defaults: {}, controls: [], lifecycle: { after: "hold", exit: ["fade"] }, Component: () => null };
  const box = { id: "group-box", name: "Group", description: "", role: "group", defaults: {}, controls: [], after: "hold", Component: () => null };
  const titlePart = { id: "text-title", name: "Title", description: "", role: "text", defaults: { text: "T" }, controls: [{ key: "text", label: "Title", type: "text" }], settleMs: () => 600, after: "hold", Component: () => null };
  const lookup = (id) => ({ "group-box": box, "text-title": titlePart })[id];
  registerCards([card, compositeCard]);
  const clip = { id: "c1", cardId: "composite", start: 0, end: 4, params: {},
    frame: { x: 960, y: 540, w: 1920, h: 1080, anchor: [0.5, 0.5], scale: 0.5 },
    parts: [{ id: "g", partId: "group-box", params: {}, enterMs: 500, frame: { x: 100, y: 100, w: 800, h: 400 }, children: [{ id: "t", partId: "text-title", params: { text: "Hi" }, enterMs: 300 }] }] };
  const env = envelopeOf(project(clip), clip, compositeCard, STAGE, lookup);
  const g = env.parts[0], t = g.children[0];
  assert.equal(g.enterMs, 500); assert.equal(g.enterAtMs, 500);
  assert.equal(t.enterMs, 300, "What is written out is still the value relative to the parent"); assert.equal(t.enterAtMs, 800, "The absolute time is given separately");
  assert.equal(t.settleMs, 1400);
  // Composite card scaled to half around center: canvas visual box is (480,270,960,540);
  // g's box (100,100,800,400) scaled to half lands at (530,320,400,200)
  assert.deepEqual(g.frame.world, { left: 530, top: 320, width: 400, height: 200 });
  assert.deepEqual(t.frame.world, g.frame.world, "A child part without a frame fills the parent frame");
  const r = recorder(); r.writer.setClipParts = (id, parts) => r.calls.push(["parts", id, parts]);
  assert.deepEqual(applyEnvelope(project(clip), "c1", env, compositeCard, STAGE, r.writer, () => compositeCard, lookup).changed, [], "A round trip must not write anything");
  // Over two consecutive round-trips, sub-instance enterMs does not drift
  const again = envelopeOf(project(clip), clip, compositeCard, STAGE, lookup);
  assert.equal(again.parts[0].children[0].enterMs, 300);
});

/*
 * 3D regression. ClipFrame added rotateX / rotateY / translateZ, but the FRAME_KEYS allowlist here
 * was not synced at the time: the consequence was not "cannot change 3D", but **set_clip for this
 * card was completely unusable**:
 * envelopeOf places frame into frame.local as-is, and applyEnvelope validates it unconditionally
 * before diffing; thus even if one only wanted to change params, throwing an error whenever the
 * envelope contained a frame segment. The error message would tell the Agent "rotateY is not a
 * valid frame key", and following instructions to delete it would reset the card back to the plane.
 */
test("3D: a card placed into space should not error when its envelope is passed back unchanged", () => {
  for (const frame of [
    { x: 960, y: 540, anchor: [0.5, 0.5], rotateY: 30 },
    { x: 960, y: 540, anchor: [0.5, 0.5], rotateX: -12 },
    { x: 960, y: 540, anchor: [0.5, 0.5], translateZ: 200 },
    { x: 960, y: 540, anchor: [0.5, 0.5], rotateX: 5, rotateY: 30, translateZ: -80 },
  ]) {
    const clip = clipOf({ frame });
    const env = envelopeOf(project(clip), clip, card, STAGE);
    assert.deepEqual(env.frame.local, frame, "The local that is read out must carry the 3D fields as they are");
    const r = recorder();
    // Returned as-is = nothing changed, changed should be empty, and must not throw
    assert.deepEqual(
      applyEnvelope(project(clip), "c1", env, card, STAGE, r.writer, () => card).changed,
      [],
      `frame=${JSON.stringify(frame)} passed back unchanged should have no changes`,
    );
  }
});

test("3D: a card can be placed into space through set_clip, and can be changed back", () => {
  const clip = clipOf({ frame: { x: 960, y: 540, anchor: [0.5, 0.5] } });
  const env = envelopeOf(project(clip), clip, card, STAGE);
  const r = recorder();
  const edited = { ...env, frame: { ...env.frame, local: { ...env.frame.local, rotateY: 25, translateZ: 120 } } };
  const rep = applyEnvelope(project(clip), "c1", edited, card, STAGE, r.writer, () => card);
  assert.deepEqual(rep.changed, ["frame"]);
  const wrote = r.calls.find((c) => c[0] === "frame");
  assert.equal(wrote[2].rotateY, 25);
  assert.equal(wrote[2].translateZ, 120);
});

test("3D: the 3D fields in frame.local must be numbers", () => {
  const clip = clipOf({ frame: { x: 960, y: 540 } });
  const env = envelopeOf(project(clip), clip, card, STAGE);
  const r = recorder();
  const bad = { ...env, frame: { ...env.frame, local: { x: 960, y: 540, rotateY: "a lot" } } };
  assert.throws(
    () => applyEnvelope(project(clip), "c1", bad, card, STAGE, r.writer, () => card),
    /frame\.local\.rotateY must be a number/,
  );
});

/*
 * 3D for media clips: the set_clip path must also be blocked.
 *
 * An intercept was first added on the set_position side, but set_clip is another path: getting
 * the envelope via get_clip, stuffing rotateY into frame.local, and writing it back could still
 * succeed (confirmed in review testing). Every path that can modify frame goes through
 * applyEnvelope; placing the rule there truly guards it.
 */
test("Media clip: set_clip also cannot put 3D into frame", () => {
  const mediaClip = { id: "m1", mediaId: "v1", start: 0, end: 3, frame: { x: 960, y: 540, w: 1920, h: 1080 } };
  const proj = { name: "p", width: 1920, height: 1080, fps: 30, duration: 20, themeId: "t", media: [{ id: "v1", url: "x", kind: "video" }], tracks: [{ id: "t1", kind: "overlay", name: "Track 1", clips: [mediaClip] }], cuts: [] };
  const env = envelopeOf(proj, mediaClip, undefined, STAGE);
  const r = recorder();
  const edited = { ...env, frame: { ...env.frame, local: { ...env.frame.local, rotateY: 35 } } };
  assert.throws(
    () => applyEnvelope(proj, "m1", edited, undefined, STAGE, r.writer, () => undefined),
    /only works on cards/,
  );
  // When intercepted, not a single byte should be written
  assert.equal(r.calls.length, 0);
});

test("Media clip: the in-plane position / size / rotation can still be changed as usual", () => {
  const mediaClip = { id: "m1", mediaId: "v1", start: 0, end: 3, frame: { x: 960, y: 540, w: 1920, h: 1080 } };
  const proj = { name: "p", width: 1920, height: 1080, fps: 30, duration: 20, themeId: "t", media: [{ id: "v1", url: "x", kind: "video" }], tracks: [{ id: "t1", kind: "overlay", name: "Track 1", clips: [mediaClip] }], cuts: [] };
  const env = envelopeOf(proj, mediaClip, undefined, STAGE);
  const r = recorder();
  const edited = { ...env, frame: { ...env.frame, local: { ...env.frame.local, x: 500, rotate: 12 } } };
  assert.deepEqual(applyEnvelope(proj, "m1", edited, undefined, STAGE, r.writer, () => undefined).changed, ["frame"]);
});

test("Card clip: 3D can still be written through set_clip as usual (the block only targets media)", () => {
  const clip = clipOf({ frame: { x: 960, y: 540, anchor: [0.5, 0.5] } });
  const env = envelopeOf(project(clip), clip, card, STAGE);
  const r = recorder();
  const edited = { ...env, frame: { ...env.frame, local: { ...env.frame.local, rotateY: 35 } } };
  assert.deepEqual(applyEnvelope(project(clip), "c1", edited, card, STAGE, r.writer, () => card).changed, ["frame"]);
});

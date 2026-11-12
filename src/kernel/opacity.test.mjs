/**
 * Card clip opacity / fade. Run: node --test src/kernel/opacity.test.mjs
 *
 * Previously only video layers respected these three fields; setting them on cards was a no-op:
 * the system prompt told the model to "lower opacity when covering people", it complied, looked at
 * the frame, and nothing changed. Now flattenOverlay carries the fields into the timeline, and
 * Stage applies them via cardOpacityAt. Pin down:
 *   - For unset cards hasOpacityControls is false, Stage touches nothing (export baselines of
 *     legacy projects cannot change);
 *   - The pre-mount period (t < start) must not swallow the first entrance frame to 0;
 *   - flattenOverlay actually brings the three fields over.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { opacityAt, cardOpacityAt, hasOpacityControls, flattenOverlay } from "./project.ts";

const clip = (extra = {}) => ({ id: "c", cardId: "x", start: 2, end: 5, params: {}, ...extra });

test("hasOpacityControls: false if never set, true if any one is set; a fade of 0 does not count as set", () => {
  assert.equal(hasOpacityControls(clip()), false);
  assert.equal(hasOpacityControls(clip({ fadeIn: 0, fadeOut: 0 })), false);
  assert.equal(hasOpacityControls(clip({ opacity: 1 })), true);
  assert.equal(hasOpacityControls(clip({ fadeIn: 0.5 })), true);
});

test("opacityAt: inside the interval it follows fade-in/fade-out, outside the interval it is 0", () => {
  const c = clip({ opacity: 0.8, fadeIn: 1, fadeOut: 1 });
  assert.equal(opacityAt(c, 1.9), 0);
  assert.equal(opacityAt(c, 2), 0);
  assert.ok(Math.abs(opacityAt(c, 2.5) - 0.4) < 1e-9);
  assert.ok(Math.abs(opacityAt(c, 3.5) - 0.8) < 1e-9);
  assert.ok(Math.abs(opacityAt(c, 4.5) - 0.4) < 1e-9);
  assert.equal(opacityAt(c, 5), 0);
});

test("cardOpacityAt: the early-mount period is computed as of the start moment, so without a fade-in it is opacity itself, not 0", () => {
  assert.equal(cardOpacityAt(clip({ opacity: 0.6 }), 1.96), 0.6);
  assert.equal(cardOpacityAt(clip({ opacity: 0.6 }), 3), 0.6);
});

test("cardOpacityAt: with a fade-in the early-mount period is 0 (a fade-in starts from 0 anyway)", () => {
  assert.equal(cardOpacityAt(clip({ fadeIn: 0.5 }), 1.96), 0);
  assert.ok(Math.abs(cardOpacityAt(clip({ fadeIn: 0.5 }), 2.25) - 0.5) < 1e-9);
});

test("cardOpacityAt: after end it is computed as of the last moment, and does not suddenly become 0 because t>=end", () => {
  assert.equal(cardOpacityAt(clip({ opacity: 0.7 }), 5.01), 0.7);
});

test("flattenOverlay carries opacity / fadeIn / fadeOut into the timeline; keys that are not set do not appear", () => {
  const p = {
    version: 1, name: "p", width: 1920, height: 1080, fps: 30, duration: 10, themeId: "t", media: [],
    tracks: [{ id: "t1", name: "s", clips: [
      clip({ id: "a", opacity: 0.5, fadeIn: 0.3 }),
      clip({ id: "b" }),
    ] }],
  };
  const tl = flattenOverlay(p);
  const a = tl.clips.find((c) => c.id === "a");
  const b = tl.clips.find((c) => c.id === "b");
  assert.equal(a.opacity, 0.5);
  assert.equal(a.fadeIn, 0.3);
  assert.equal("fadeOut" in a, false);
  assert.equal("opacity" in b, false);
  assert.equal("fadeIn" in b, false);
});

test("hasOpacityControls: non-empty cutEnv counts as active opacity control; empty cutEnv does not", () => {
  assert.equal(hasOpacityControls(clip({ cutEnv: [] })), false);
  assert.equal(hasOpacityControls(clip({ cutEnv: [{ start: 0, end: 10, opacity: 0.5 }] })), true);
});

test("opacityAt and cardOpacityAt multiply nested cutEnv envelopes without duplicating envelope math", () => {
  // Inner clip: [2, 5], opacity 0.8, fadeIn 1s -> at t=2.5 inner is 0.4, at t=3.5 inner is 0.8
  // Outer cutEnv #1: [1, 6], opacity 0.5, fadeIn 2s -> at t=2.5 env1 is 0.5 * (1.5 / 2) = 0.375; at t=3.5 env1 is 0.5
  // Outer cutEnv #2: [0, 5], fadeOut 2s -> at t=2.5 env2 is 1; at t=3.5 env2 is (5 - 3.5) / 2 = 0.75
  const c = clip({
    opacity: 0.8,
    fadeIn: 1,
    cutEnv: [
      { start: 1, end: 6, opacity: 0.5, fadeIn: 2 },
      { start: 0, end: 5, fadeOut: 2 },
    ],
  });
  assert.ok(Math.abs(opacityAt(c, 2.5) - 0.4 * 0.375 * 1) < 1e-9);
  assert.ok(Math.abs(cardOpacityAt(c, 2.5) - 0.4 * 0.375 * 1) < 1e-9);
  assert.ok(Math.abs(opacityAt(c, 3.5) - 0.8 * 0.5 * 0.75) < 1e-9);
  assert.ok(Math.abs(cardOpacityAt(c, 3.5) - 0.8 * 0.5 * 0.75) < 1e-9);
});

test("flattenOverlay preserves cutEnv on derived clips and computes @cut segment envelopes with pre-roll and overrun", () => {
  const p = {
    version: 1,
    name: "p",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 10,
    themeId: "t",
    media: [],
    activeCutId: "main",
    cuts: [
      { id: "main", name: "Main", duration: 10, tracks: [] },
      {
        id: "sub",
        name: "Sub",
        duration: 2.5,
        tracks: [{ id: "st1", name: "SubTrack", clips: [clip({ id: "inner", start: 0, end: 2.5 })] }],
      },
    ],
    tracks: [
      {
        id: "t1",
        name: "MainTrack",
        clips: [
          {
            id: "seg1",
            cutId: "sub",
            cutOffset: 0.5,
            start: 2,
            end: 5,
            opacity: 0.8,
            fadeIn: 1,
            fadeOut: 1,
            cutEnv: [{ start: 0, end: 10, opacity: 0.5 }],
          },
          clip({ id: "derived", cutEnv: [{ start: 1, end: 6, opacity: 0.75 }] }),
        ],
      },
    ],
  };
  const tl = flattenOverlay(p);
  const seg = tl.clips.find((c) => c.id === "seg1");
  const derived = tl.clips.find((c) => c.id === "derived");
  assert.ok(seg, "Cut segment must appear in flattened overlay");
  assert.ok(seg.start < 2, "Pre-roll shifts timeline start before visible segment start (2s)");
  // During pre-roll (before seg.from = 2.0), opacity must be strictly 0
  assert.equal(cardOpacityAt(seg, 1.95), 0);
  // Mid fade-in at t=2.5: segment fade (0.5 / 1.0) * 0.8 * outer cutEnv 0.5 = 0.2
  assert.ok(Math.abs(cardOpacityAt(seg, 2.5) - 0.2) < 1e-9);
  // Plateau at t=3.2 (localT = 0.5 + (3.2 - seg.start) -> 0.5 + 1.2 = 1.7 < 2.5): 0.8 * 0.5 = 0.4
  assert.ok(Math.abs(cardOpacityAt(seg, 3.2) - 0.4) < 1e-9);
  // Overrun past sub cut duration (localT >= 2.5 -> t >= 4.0): strictly 0
  assert.equal(cardOpacityAt(seg, 4.1), 0);
  assert.deepEqual(derived.cutEnv, [{ start: 1, end: 6, opacity: 0.75 }]);
});

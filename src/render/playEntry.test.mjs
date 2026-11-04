/**
 * Criteria for natural entrance vs. starting playback from middle of a card (`playEntry.mjs`).
 * Playback state swap is only for the latter; see module header for rules.
 *   node --test src/render/playEntry.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlayRun, enteredNaturally, notePlayBeat, notePlaySeam, notePlayStart } from "./playEntry.mjs";
import { mountFrameOf } from "./frameWindow.mjs";

const FPS = 30;
/** Start playback from `fromFrame`, check in tick-by-tick up to `toFrame` (inclusive) */
function playFrames(run, fromFrame, toFrame) {
  notePlayStart(run, fromFrame / FPS, FPS);
  const kinds = [];
  for (let f = fromFrame + 1; f <= toFrame; f++) kinds.push(notePlayBeat(run, f / FPS, FPS));
  return kinds;
}

test("ST-C-01 playback starts before the card and steps through the mount frame tick by tick during playback: natural entrance", () => {
  const run = createPlayRun();
  const m = mountFrameOf({ start: 2, end: 6 }, FPS);   // 59
  assert.equal(m, 59);
  const kinds = playFrames(run, 0, 70);
  assert.ok(kinds.every((k) => k === "continuous"));
  assert.equal(enteredNaturally(run, m), true);
});

test("ST-C-02 playback starts mid-card (seek into the card then play, open the page parked mid-card then play): not a natural entrance", () => {
  const run = createPlayRun();
  playFrames(run, 90, 100);   // Card mounted starting from frame 59, playback starts from frame 90
  assert.equal(enteredNaturally(run, 59), false);
});

test("ST-C-03 playback starts exactly on the mount frame: the card is already mounted at the moment playback starts, so it is not a natural entrance; starting one frame before the mount frame counts", () => {
  const at = createPlayRun();
  playFrames(at, 59, 70);
  assert.equal(enteredNaturally(at, 59), false, "mount frame = start: state comes from paused-state positioning, still estimated by time as before");
  const before = createPlayRun();
  playFrames(before, 58, 70);
  assert.equal(enteredNaturally(before, 59), true, "mount frame = start + 1: mounted tick by tick from the first tick");
});

test("ST-C-04 resuming mid-card after a pause: the start of the new playback run is the pause point, and cards that entered naturally before count as starting mid-card in this run", () => {
  const run = createPlayRun();
  playFrames(run, 0, 90);
  assert.equal(enteredNaturally(run, 59), true);
  // Pause at 90, resume playback
  playFrames(run, 90, 100);
  assert.equal(enteredNaturally(run, 59), false);
  // Cards mounted only after this round are still natural entrances
  playFrames(run, 90, 130);
  assert.equal(enteredNaturally(run, 120), true);
});

test("ST-C-05 dropped frames: the stage waits on slow frames, tick numbers still increase one by one (just arriving late), counts as continuous", () => {
  const run = createPlayRun();
  notePlayStart(run, 0, FPS);
  // Parent page main thread stuttered: events for ticks 50~65 arrived all at once,
  // without missing tick sequence numbers
  for (let f = 1; f <= 70; f++) assert.equal(notePlayBeat(run, f / FPS, FPS), "continuous");
  assert.equal(run.breaks, 0);
  assert.equal(enteredNaturally(run, 59), true);
});

test("ST-C-06 tick number really jumps (gap > 1) counts as a break: cards mounted at the landing point or before count as starting mid-card, cards mounted after it are still natural entrances", () => {
  const run = createPlayRun();
  notePlayStart(run, 0, FPS);
  for (let f = 1; f <= 55; f++) notePlayBeat(run, f / FPS, FPS);
  // 55 → 62: crossed mount frame 59
  assert.equal(notePlayBeat(run, 62 / FPS, FPS), "break");
  assert.equal(run.startFrame, 62);
  assert.equal(enteredNaturally(run, 59), false);
  assert.equal(enteredNaturally(run, 62), false, "cards mounted on the landing frame do not count either");
  for (let f = 63; f <= 80; f++) notePlayBeat(run, f / FPS, FPS);
  assert.equal(enteredNaturally(run, 70), true);
});

test("ST-C-07 rewind (jumping back during playback) counts as a break; the same tick reported twice (the tick where the armed stop happens) does not", () => {
  const run = createPlayRun();
  playFrames(run, 0, 80);
  assert.equal(notePlayBeat(run, 80 / FPS, FPS), "repeat");
  assert.equal(run.breaks, 0);
  assert.equal(enteredNaturally(run, 59), true);
  assert.equal(notePlayBeat(run, 40 / FPS, FPS), "break");
  assert.equal(enteredNaturally(run, 30), false);
});

test("ST-C-08 never started playback (start unknown): never counts as a natural entrance, takes the original path; the first tick is taken as the start", () => {
  const run = createPlayRun();
  assert.equal(enteredNaturally(run, 59), false);
  assert.equal(notePlayBeat(run, 60 / FPS, FPS), "break");
  assert.equal(enteredNaturally(run, 59), false);
  for (let f = 61; f <= 70; f++) notePlayBeat(run, f / FPS, FPS);
  assert.equal(enteredNaturally(run, 65), true);
});

test("ST-C-09 seam: the new stage swapped in by a playing-state swap keeps reporting ticks from T, counts as continuous, start unchanged", () => {
  const run = createPlayRun();
  playFrames(run, 30, 40);
  // Ticks 41~44 of old stage did not reach parent page (filtered when switching roles),
  // new stage is exact at T = 45
  notePlaySeam(run, 45 / FPS, FPS);
  assert.equal(run.startFrame, 30);
  assert.equal(notePlayBeat(run, 46 / FPS, FPS), "continuous");
  for (let f = 47; f <= 70; f++) notePlayBeat(run, f / FPS, FPS);
  assert.equal(enteredNaturally(run, 59), true);
  assert.equal(enteredNaturally(run, 20), false, "cards already mounted before playback started still start mid-card");
});

test("ST-C-10 a mount frame not yet reached does not count (that card is not mounted yet)", () => {
  const run = createPlayRun();
  playFrames(run, 0, 50);
  assert.equal(enteredNaturally(run, 59), false);
});

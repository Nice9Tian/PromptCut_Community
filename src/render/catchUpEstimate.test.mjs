/**
 * K3(b) Frame catch-up cost estimated by playhead position (pinned render 4). Run:
 *   node --test src/render/catchUpEstimate.test.mjs
 *
 * Pins four things:
 *   1. The formula is simply `frames × t_oc`; `t_oc` prioritizes single-frame worst case `stepMaxMs`;
 *   2. Falls back to p90 `stepMs` when `stepMaxMs` is absent;
 *   3. Position estimation is capped at full-clip `catchUpMs` (`t_oc` is single-frame worst case,
 *      multiplying across the entire clip is even more pessimistic than measured);
 *   4. Falls back to full-clip cost when position cannot be calculated
 *      (0 frames / no single-frame cost).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { catchUpEstimateMs, playingLeadMs, sceneCatchUpCost } from './catchUpEstimate.mjs';

test('Estimate by position: frames × stepMaxMs', () => {
  // 60-second, 30 fps long motion: entire clip 1800 frames × 2 ms = 3600 ms;
  // playhead at second 2 = 60 frames
  const record = { catchUpMs: 3600, stepMaxMs: 2, stepMs: 1 };
  assert.equal(catchUpEstimateMs(record, 60), 120, 'only catch up the 60 frames from the in point to now');
  assert.equal(catchUpEstimateMs(record, 300), 600);
});

test('Without a worst single frame, use stepMs (p90)', () => {
  assert.equal(catchUpEstimateMs({ catchUpMs: 3600, stepMs: 1.5 }, 100), 150);
});

test('capped at the cost of the whole segment', () => {
  // Position estimate 1800 × 2 = 3600 > measured clip total 1200: take the clip total
  assert.equal(catchUpEstimateMs({ catchUpMs: 1200, stepMaxMs: 2 }, 1800), 1200);
});

test('If the position cannot be computed, fall back to the whole-segment cost', () => {
  assert.equal(catchUpEstimateMs({ catchUpMs: 900, stepMaxMs: 2 }, 0), 900, 'exactly at the in point');
  assert.equal(catchUpEstimateMs({ catchUpMs: 900, stepMaxMs: 2 }, -5), 900, 'playhead is before the in point');
  assert.equal(catchUpEstimateMs({ catchUpMs: 900 }, 60), 900, 'no single-frame cost at all');
  assert.equal(catchUpEstimateMs({ catchUpMs: 900, stepMaxMs: 2 }, NaN), 900);
});

test('Returns 0 when there is nothing, leaving the fallback to the caller', () => {
  assert.equal(catchUpEstimateMs(null, 60), 0);
  assert.equal(catchUpEstimateMs(undefined, 60), 0);
  assert.equal(catchUpEstimateMs({}, 60), 0);
});

test('A random-access card (catchUpMs is 0) does not conjure up a cost estimate', () => {
  assert.equal(catchUpEstimateMs({ catchUpMs: 0, stepMs: 0 }, 300), 0);
});

test('Whole scene: the backlog is the sum, over every card on stage, of pushing from max(in point, push start point) to t; the rate is the sum of the single-frame costs of the currently active cards (the same figure as the backlog) × fps', () => {
  const entries = [
    { start: 0, end: 10, record: { stepMs: 2, stepMaxMs: 3, catchUpMs: 200 } },   // 30 frames × 3 = 90
    { start: 0, end: 10, record: { stepMs: 40, stepMaxMs: 60 } },                 // 30 frames × 60 = 1800; rate also uses stepMaxMs of 60
    { start: 0, end: 0.5, record: { stepMs: 40 } },                               // Already exited: 0-0.5 s, 15 frames × 40 = 600, not included in rate
    { start: 0.5, end: 10, record: null },                                        // No record: 0
  ];
  const { backlogMs, ratePerSec } = sceneCatchUpCost(entries, 1, 30);
  assert.equal(backlogMs, 90 + 1800 + 600);
  assert.equal(ratePerSec, (3 + 60) * 30);
  assert.deepEqual(sceneCatchUpCost([], 1, 30), { backlogMs: 0, ratePerSec: 0 });
  // Card with only full-clip cost: backlog takes full clip, rate is amortized over full clip
  // (10 s, 300 frames, 1200 ms → 4 ms/frame → 120 ms/s)
  assert.deepEqual(sceneCatchUpCost([{ start: 0, end: 10, record: { catchUpMs: 1200 } }], 1, 30), { backlogMs: 1200, ratePerSec: 120 });
});

test('Lead amount: backlog ÷ (1 − rate / 1000); if pushing 1 second of timeline in the background takes more than 1 second, it can never catch up (null)', () => {
  assert.equal(playingLeadMs(90, 0), 90);
  assert.equal(playingLeadMs(390, 360), 390 / 0.64);
  assert.equal(playingLeadMs(90, 1000), null);
  assert.equal(playingLeadMs(90, 10800), null, 'C10-A4 probe scenario: 9 heavy cards at 40 ms/frame');
});

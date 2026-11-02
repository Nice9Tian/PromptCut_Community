/**
 * Unit tests for sync arithmetic and state machine of mobile app mini timeline
 * (`src/mobile/ThumbStrip.tsx` + `src/mobile/mainContent.ts`).
 * Verifies cardPosAtTime / timeAtCardPos / scrollForPos / posFromScroll under "1 6-second card clip"
 * and "control group of 3 2-second clips each", frame-by-frame simulation of useLayoutEffect 1px
 * dead zone at 60 / 30 / 24 fps, and onScroll 1.5px threshold readings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardPosAtTime, timeAtCardPos } from './mainContent.ts';

/**
 * Faithfully copied from lines 43-53 of `src/mobile/ThumbStrip.tsx` (`posFromScroll`), only changing
 * `sc.current!` and `blocks()` read from closure to parameters `(el, bl)`, without changing
 * any expressions or boundary checks.
 */
/**
 * Copied from `ThumbStrip.tsx`'s `spanOf`: interval occupied by segment i is "left edge of this card
 * → left edge of next card", merging the 30px transition marker into previous segment
 */
function spanOf(bl, i) {
  const l = bl[i].offsetLeft;
  return [l, i + 1 < bl.length ? bl[i + 1].offsetLeft : l + bl[i].offsetWidth];
}
function posFromScroll(el, bl) {
  const x = el.scrollLeft + el.clientWidth / 2;
  for (let i = 0; i < bl.length; i++) {
    const [l, r] = spanOf(bl, i);
    if (x < l) return i;
    if (x < r) return i + (x - l) / (r - l);
  }
  return bl.length;
}

/**
 * Faithfully copied from lines 54-61 of `src/mobile/ThumbStrip.tsx` (`scrollForPos`), only changing
 * `sc.current!` and `blocks()` read from closure to parameters `(el, bl, pos)`, without changing
 * any expressions or boundary checks.
 */
function scrollForPos(el, bl, pos) {
  if (!bl.length) return 0;
  const i = Math.min(Math.floor(pos), bl.length - 1);
  const f = pos >= bl.length ? 1 : pos - i;
  const [l, r] = spanOf(bl, i);
  return l + f * (r - l) - el.clientWidth / 2;
}

/**
 * Faithfully copied from sync step of `useLayoutEffect` in lines 64-71 of
 * `src/mobile/ThumbStrip.tsx`.
 */
function runLayoutSyncStep(el, bl, clips, t, dragging, progSl, { integerScrollLeft = false } = {}) {
  if (!el || !el.clientWidth || dragging.current) return false;
  const want = scrollForPos(el, bl, cardPosAtTime(clips, t));
  if (Math.abs(el.scrollLeft - want) < 1) return false;
  el.scrollLeft = integerScrollLeft ? Math.round(want) : want;
  progSl.current = el.scrollLeft;
  return true;
}

/**
 * Faithfully copied from lines 76-80 of `src/mobile/ThumbStrip.tsx` (`onScroll`).
 */
function runOnScrollStep(el, bl, clips, progSl, onScrub) {
  if (!el.clientWidth || Math.abs(el.scrollLeft - progSl.current) < 1.5) return false;
  progSl.current = el.scrollLeft;
  onScrub(timeAtCardPos(clips, posFromScroll(el, bl)));
  return true;
}

/**
 * Construct mock DOM based on given geometric parameters:
 * - `.strip-scroll` width W (= clientWidth)
 * - `.sp-l` width W/2 - 46
 * - `.madd` width 40 + margin-right 6 = 46
 * - `.mblock` per segment width 80 (border-box, offsetWidth = 80)
 * - inter-segment `.mark` width 24 + left and right margin 3 each = 30
 * - `.sp-r` width W/2
 */
function makeStripLayout(W, blockCount) {
  const spL = W / 2 - 46;
  const madd = 40 + 6;
  const bl = [];
  let cursor = spL + madd; // = W / 2
  for (let i = 0; i < blockCount; i++) {
    if (i > 0) cursor += 3 + 24 + 3; // .mark: width 24, margin 0 3px
    bl.push({ offsetLeft: cursor, offsetWidth: 80 });
    cursor += 80;
  }
  const spR = W / 2;
  const scrollWidth = cursor + spR;
  const maxScrollLeft = scrollWidth - W;
  const el = { scrollLeft: 0, clientWidth: W, scrollWidth, maxScrollLeft };
  return { el, bl };
}

const clip = (id, start, end) => ({ id, cardId: 'card-1', start, end, params: {} });

test('SS1 1 clip of 6 s card: pos and want at t = 0 / 1 / 3 / 5.7 / 6 (W = 390) and endpoint continuity', () => {
  const W = 390;
  const clips = [clip('c1', 0, 6)];
  const { el, bl } = makeStripLayout(W, 1);

  assert.equal(bl[0].offsetLeft, 195);
  assert.equal(bl[0].offsetWidth, 80);
  assert.equal(el.scrollWidth, 470);
  assert.equal(el.maxScrollLeft, 80);

  const sampleTimes = [0, 1, 3, 5.7, 6];
  const readings = sampleTimes.map((t) => {
    const pos = cardPosAtTime(clips, t);
    const want = scrollForPos(el, bl, pos);
    return { t, pos, want };
  });

  console.log('[SS1] 1 clip of 6 s (W=390) geometry and sampled readings:', {
    offsetLeft: bl[0].offsetLeft,
    offsetWidth: bl[0].offsetWidth,
    scrollWidth: el.scrollWidth,
    maxScrollLeft: el.maxScrollLeft,
    readings,
  });

  assert.equal(readings[0].pos, 0);
  assert.equal(readings[0].want, 0);

  assert.ok(Math.abs(readings[1].pos - 1 / 6) < 1e-15);
  assert.ok(Math.abs(readings[1].want - 80 / 6) < 1e-12);

  assert.equal(readings[2].pos, 0.5);
  assert.equal(readings[2].want, 40);

  assert.ok(Math.abs(readings[3].pos - 0.95) < 1e-15);
  assert.ok(Math.abs(readings[3].want - 76) < 1e-12);

  assert.equal(readings[4].pos, 1);
  assert.equal(readings[4].want, 80);

  // Check whether a jump exists near the t = 6 endpoint (6 - 2e-9, 6 - 1e-9, 6)
  const posJustBefore = cardPosAtTime(clips, 6 - 2e-9);
  const posAtThreshold = cardPosAtTime(clips, 6 - 1e-9);
  const posAtEnd = cardPosAtTime(clips, 6);
  console.log('[SS1] t=6 left limit at endpoint and endpoint value:', {
    't=6-2e-9': posJustBefore,
    't=6-1e-9': posAtThreshold,
    't=6': posAtEnd,
    diff: posAtEnd - posJustBefore,
  });
  assert.ok(Math.abs(posAtEnd - posJustBefore) < 1e-9, 'continuous at t=6 with no jump');
});

test('SS2 want total travel, speed per second, per-tick displacement at 60/30/24 fps and 1px time error (1 clip of 6 s)', () => {
  const W = 390;
  const clips = [clip('c1', 0, 6)];
  const { el, bl } = makeStripLayout(W, 1);

  const wantStart = scrollForPos(el, bl, cardPosAtTime(clips, 0));
  const wantEnd = scrollForPos(el, bl, cardPosAtTime(clips, 6));
  const totalTravelPx = wantEnd - wantStart;
  const pxPerSec = totalTravelPx / 6;
  const pxPerTick60 = totalTravelPx / 360;
  const pxPerTick30 = totalTravelPx / 180;
  const pxPerTick24 = totalTravelPx / 144;
  const secPerPx = 6 / totalTravelPx;
  const secPer1_5Px = (1.5 * 6) / totalTravelPx;

  console.log('[SS2] 1 clip of 6 s speed and resolution readings:', {
    totalTravelPx,
    pxPerSec,
    pxPerTick60,
    pxPerTick30,
    pxPerTick24,
    secPerPx,
    secPer1_5Px,
  });

  assert.equal(totalTravelPx, 80);
  assert.ok(Math.abs(pxPerSec - 40 / 3) < 1e-12);
  assert.ok(Math.abs(pxPerTick60 - 2 / 9) < 1e-12);
  assert.ok(Math.abs(pxPerTick30 - 4 / 9) < 1e-12);
  assert.ok(Math.abs(pxPerTick24 - 5 / 9) < 1e-12);
  assert.equal(secPerPx, 0.075);
  assert.equal(secPer1_5Px, 0.1125);
});

test('SS3 playback simulation loop (1 clip of 6 s, fps = 60 / 30 / 24 tiers): verify final scrollLeft of each tier under the < 1 dead zone', () => {
  const W = 390;
  const duration = 6;
  const clips = [clip('c1', 0, duration)];
  const dragging = { current: false };

  function simulateFps(fps) {
    const totalTicks = duration * fps;
    const pxPerTick = 80 / totalTicks;
    const ticksPerJump = Math.ceil(1 / pxPerTick);
    const jumpPx = ticksPerJump * pxPerTick;

    const { el, bl } = makeStripLayout(W, 1);
    const progSl = { current: 0 };
    let updateCount = 0;
    const firstUpdates = [];
    for (let tick = 1; tick <= totalTicks; tick++) {
      const t = tick / fps;
      if (runLayoutSyncStep(el, bl, clips, t, dragging, progSl)) {
        updateCount++;
        if (firstUpdates.length < 4) {
          firstUpdates.push(`tick=${tick}(t=${t.toFixed(4)}s)->sl=${el.scrollLeft.toFixed(4)}`);
        }
      }
    }

    const { el: elInt, bl: blInt } = makeStripLayout(W, 1);
    const progSlInt = { current: 0 };
    let updateCountInt = 0;
    for (let tick = 1; tick <= totalTicks; tick++) {
      const t = tick / fps;
      if (runLayoutSyncStep(elInt, blInt, clips, t, dragging, progSlInt, { integerScrollLeft: true })) {
        updateCountInt++;
      }
    }

    return {
      fps,
      totalTicks,
      pxPerTick,
      ticksPerJump,
      jumpPx,
      floatScrollLeft: { finalScrollLeft: el.scrollLeft, updateCount, firstUpdates: firstUpdates.join(', ') },
      intScrollLeft: { finalScrollLeft: elInt.scrollLeft, updateCount: updateCountInt },
    };
  }

  const r60 = simulateFps(60);
  const r30 = simulateFps(30);
  const r24 = simulateFps(24);

  console.log('[SS3] 1 clip of 6 s three fps tiers (60 / 30 / 24) simulation results:', { r60, r30, r24 });

  // fps = 60: 2/9 px per tick, jumps 10/9 px every 5 ticks, 72 writes total over 360 ticks, endpoint 80
  assert.equal(r60.ticksPerJump, 5);
  assert.equal(r60.floatScrollLeft.updateCount, 72);
  assert.equal(r60.floatScrollLeft.finalScrollLeft, 80);
  assert.equal(r60.intScrollLeft.updateCount, 80);
  assert.equal(r60.intScrollLeft.finalScrollLeft, 80);

  // fps = 30 (project default fps): 4/9 px per tick, jumps 4/3 px every 3 ticks, 60 writes total
  // over 180 ticks, endpoint 80
  assert.equal(r30.ticksPerJump, 3);
  assert.equal(r30.floatScrollLeft.updateCount, 60);
  assert.equal(r30.floatScrollLeft.finalScrollLeft, 80);
  assert.equal(r30.intScrollLeft.updateCount, 80);
  assert.equal(r30.intScrollLeft.finalScrollLeft, 80);

  // fps = 24: 5/9 px per tick, jumps 10/9 px every 2 ticks, 72 writes total over 144 ticks, endpoint 80
  assert.equal(r24.ticksPerJump, 2);
  assert.equal(r24.floatScrollLeft.updateCount, 72);
  assert.equal(r24.floatScrollLeft.finalScrollLeft, 80);
  assert.equal(r24.intScrollLeft.updateCount, 80);
  assert.equal(r24.intScrollLeft.finalScrollLeft, 80);
});

test('SS4 control group: 3 clips of 2 s each (two .mark in the middle) run the full 6 s at 60fps and 30fps', () => {
  const W = 390;
  const clips = [clip('c1', 0, 2), clip('c2', 2, 4), clip('c3', 4, 6)];
  const dragging = { current: false };

  function run3Seg(fps) {
    const { el, bl } = makeStripLayout(W, 3);
    const progSl = { current: 0 };
    const totalTicks = 6 * fps;
    let updateCount = 0;
    for (let tick = 1; tick <= totalTicks; tick++) {
      const t = tick / fps;
      if (runLayoutSyncStep(el, bl, clips, t, dragging, progSl)) {
        updateCount++;
      }
    }
    return { el, bl, updateCount };
  }

  const s60 = run3Seg(60);
  const s30 = run3Seg(30);
  const wantStart = scrollForPos(s60.el, s60.bl, cardPosAtTime(clips, 0));
  const wantEnd = scrollForPos(s60.el, s60.bl, cardPosAtTime(clips, 6));
  const totalTravelPx = wantEnd - wantStart;

  console.log('[SS4] 3 clips of 2 s each control group (W=390) simulation results:', {
    blockOffsets: s60.bl.map((b) => b.offsetLeft),
    scrollWidth: s60.el.scrollWidth,
    maxScrollLeft: s60.el.maxScrollLeft,
    totalTravelPx,
    fps60: { finalScrollLeft: s60.el.scrollLeft, updateCount: s60.updateCount },
    fps30: { finalScrollLeft: s30.el.scrollLeft, updateCount: s30.updateCount },
  });

  assert.deepEqual(s60.bl.map((b) => b.offsetLeft), [195, 305, 415]);
  assert.equal(s60.el.scrollWidth, 690);
  assert.equal(s60.el.maxScrollLeft, 300);
  assert.equal(totalTravelPx, 300);
  assert.equal(s60.el.scrollLeft, 300);
  assert.equal(s60.updateCount, 180);
  assert.equal(s30.el.scrollLeft, 300);
  assert.equal(s30.updateCount, 180, 'At 30fps each clip moves 4/3 >= 1 px per tick, updates on every tick, 180 ticks give 180 updates in total');
});

test('SS5 posFromScroll and scrollForPos round-trip consistency (1 clip of 6 s) and onScroll 1.5px threshold check', () => {
  const W = 390;
  const clips = [clip('c1', 0, 6)];
  const { el, bl } = makeStripLayout(W, 1);

  const testPositions = [0, 0.01, 1 / 6, 0.25, 0.5, 0.75, 0.95, 1];
  const roundTrips = testPositions.map((pos) => {
    const want = scrollForPos(el, bl, pos);
    el.scrollLeft = want;
    const posBack = posFromScroll(el, bl);
    const tFromPos = timeAtCardPos(clips, pos);
    const tBack = timeAtCardPos(clips, posBack);
    return { pos, want, posBack, tFromPos, tBack };
  });

  console.log('[SS5] 1 segment of 6 s scrollForPos <-> posFromScroll round-trip readings:', roundTrips);

  for (const r of roundTrips) {
    assert.ok(Math.abs(r.posBack - r.pos) < 1e-12, `pos=${r.pos} round-trip consistent`);
    assert.ok(Math.abs(r.tBack - r.tFromPos) < 1e-12, `t=${r.tFromPos} round-trip consistent`);
  }

  // Verify onScroll 1.5px threshold: slight movements < 1.5px are swallowed, cumulative >= 1.5px
  // triggers onScrub normally
  el.scrollLeft = 0;
  const progSl = { current: 0 };
  const scrubbedTimes = [];
  const onScrub = (t) => scrubbedTimes.push(t);

  el.scrollLeft = 1.0; // |1.0 - 0| < 1.5 -> swallowed
  assert.equal(runOnScrollStep(el, bl, clips, progSl, onScrub), false);
  assert.equal(progSl.current, 0, 'progSl.current is not updated when swallowed, later displacement keeps accumulating');

  el.scrollLeft = 1.49; // |1.49 - 0| < 1.5 -> still swallowed
  assert.equal(runOnScrollStep(el, bl, clips, progSl, onScrub), false);

  el.scrollLeft = 1.5; // |1.5 - 0| >= 1.5 -> triggers onScrub(0.1125s)
  assert.equal(runOnScrollStep(el, bl, clips, progSl, onScrub), true);
  assert.equal(progSl.current, 1.5);
  assert.equal(scrubbedTimes.length, 1);
  assert.ok(Math.abs(scrubbedTimes[0] - 0.1125) < 1e-15);

  console.log('[SS5] onScroll 1.5px threshold check:', {
    progSlAfter1_5px: progSl.current,
    scrubbedTimeAt1_5px: scrubbedTimes[0],
  });
});

/*
 * 30px dead zone at segment boundaries (fixed 2026-10-25). Before the change: `scrollForPos` was
 * calculated from card width; when pos crossed from 1-ε to 1, want jumped directly from end of
 * previous segment to left edge of next segment, and the 30px in between (.mark width 24 + 3 on each
 * side) did not belong to any segment: playback teleported at boundaries, and manually scrolling into
 * it froze time. After changing to calculate by "left edge of this card → left edge of next card",
 * both ends are continuous.
 */
test('SS6 segment boundaries no longer have a 30px dead zone: want is continuous and reversible back and forth (3 segments of 2 s each, two .mark in the middle)', () => {
  const W = 390, CARD = 80, MARK = 30;
  const el = { clientWidth: W, scrollLeft: 0 };
  const left0 = W / 2;
  const bl = [0, 1, 2].map((i) => ({ offsetLeft: left0 + i * (CARD + MARK), offsetWidth: CARD }));

  // 1) want is monotonic and everywhere continuous across the whole strip: the span between adjacent
  // sample points must not show that 30px jump from .mark
  const STEP = 1 / 512;
  let prev = scrollForPos(el, bl, 0), maxJump = 0;
  for (let pos = STEP; pos <= 3; pos += STEP) {
    const w = scrollForPos(el, bl, pos);
    assert.ok(w >= prev - 1e-9, `want must be monotonically non-decreasing, pos=${pos}`);
    maxJump = Math.max(maxJump, w - prev);
    prev = w;
  }
  // Each segment spans CARD+MARK=110px, 512 steps, ~0.215px per step; relaxing margin to 1px is
  // still far less than 30
  assert.ok(maxJump < 1, `Max span between adjacent steps is ${maxJump}px, a 30px jump must not occur`);

  // 2) Reversible across the whole strip: scroll position → pos → scroll position, error is
  // negligible (before the change, that 30px of .mark always returned integers)
  const maxScroll = scrollForPos(el, bl, 3);
  for (let x = 0; x <= maxScroll; x += 1) {
    el.scrollLeft = x;
    const back = scrollForPos(el, bl, posFromScroll(el, bl));
    assert.ok(Math.abs(back - x) < 1e-6, `x=${x} inconsistent round trip: came back as ${back}`);
  }
  el.scrollLeft = 0;

  // 3) Taking one point each on left and right of segment boundary, pos must cross integers
  // continuously, rather than being stuck at 1 on both sides
  const boundary = scrollForPos(el, bl, 1);
  el.scrollLeft = boundary - 5; const before = posFromScroll(el, bl);
  el.scrollLeft = boundary + 5; const after = posFromScroll(el, bl);
  assert.ok(before < 1 && before > 0.9, `Left of the boundary should be close to 1 but below 1, actual ${before}`);
  assert.ok(after > 1 && after < 1.1, `Right of the boundary should be just past 1, actual ${after}`);
});

/**
 * Unit test for mediaSync. Run: node --test src/render/mediaSync.test.mjs
 *
 * One rule is locked down: **correction itself must not create a reason for the next correction**.
 * The previous version's "seek when drift > 0.2s" caused a self-sustaining loop in the middle of
 * the timeline: seeking in the middle requires decoding over a hundred frames from the previous
 * keyframe (user media has one every 5 seconds) before displaying a frame; during these several
 * hundred milliseconds the playhead keeps moving, so upon settling it exceeds the threshold again,
 * triggering another seek. The symptom was "stuttering when starting playback from the middle or
 * end, while starting from the first dozen seconds was fine".
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  planSync, planSlots, reloadOnComplete,
  HARD_SEEK_SEC, SEEK_COOLDOWN_MS, IN_SYNC_SEC, MAX_RATE_SKEW, PAUSED_SEEK_SEC, SCRUB_SEEK_MIN_MS, PREROLL_SEC, NOT_READY_GRACE_SEC,
} from "./mediaSync.ts";

const base = { elTime: 0, seeking: false, paused: false, target: 0, playing: true, now: 10_000, lastSeekAt: 0 };
const at = (o) => planSync({ ...base, ...o });

test("well aligned: do nothing, keep rate at 1", () => {
  const p = at({ elTime: 300, target: 300.01 });
  assert.equal(p.seekTo, null);
  assert.equal(p.rate, 1);
  assert.equal(p.play, false);
});

test("medium drift is chased with a rate change, no seek: seeking mid-segment is exactly what causes stutter", () => {
  const behind = at({ elTime: 300, target: 300.25 }); // Video behind by 0.25s
  assert.equal(behind.seekTo, null, "this tier must never seek");
  assert.ok(behind.rate > 1 && behind.rate <= 1 + MAX_RATE_SKEW, `should play a bit faster, got ${behind.rate}`);

  const ahead = at({ elTime: 300.25, target: 300 }); // Video ahead by 0.25s
  assert.equal(ahead.seekTo, null);
  assert.ok(ahead.rate < 1 && ahead.rate >= 1 - MAX_RATE_SKEW, `should play a bit slower, got ${ahead.rate}`);
});

test("rate change is capped at ±10%: any more and the pitch shift is audible", () => {
  const p = at({ elTime: 300, target: 300 + HARD_SEEK_SEC - 0.001 });
  assert.ok(p.rate <= 1 + MAX_RATE_SKEW + 1e-9);
});

test("seek only when truly out of sync (over 0.5s)", () => {
  const p = at({ elTime: 300, target: 301 });
  assert.equal(p.seekTo, 301);
  assert.equal(p.rate, 1, "reset the rate together with the seek, do not land with the fine adjustment");
});

test("seek has a cooldown: hold off if 700ms have not passed since the last one", () => {
  const p = at({ elTime: 300, target: 301, now: 10_000, lastSeekAt: 10_000 - (SEEK_COOLDOWN_MS - 50) });
  assert.equal(p.seekTo, null, "no further seek allowed during the cooldown");
  const q = at({ elTime: 300, target: 301, now: 10_000, lastSeekAt: 10_000 - (SEEK_COOLDOWN_MS + 50) });
  assert.equal(q.seekTo, 301, "once the cooldown is over, it should correct");
});

test("element played to the end of the media: do not call play() while the playhead has not left this segment, as that would replay from the start", () => {
  // Audio is 0.2s ahead of playhead and finishes first (media 3.945s, playhead at 3.733s)
  const p = at({ elTime: 3.945, target: 3.733, paused: true, ended: true });
  assert.equal(p.play, false, "calling play() on a finished element goes back to 0 and replays");
  assert.equal(p.seekTo, null);
  assert.equal(p.pause, false);
  // Clip is longer than media: playhead has passed the end of media, quietly waiting as well
  const q = at({ elTime: 3.945, target: 4.6, paused: true, ended: true });
  assert.equal(q.play, false);
  assert.equal(q.seekTo, null);
  // Control: elements that have not finished playing and are merely paused start playback as usual
  assert.equal(at({ elTime: 3.9, target: 3.733, paused: true }).play, true);
});

test("after playing to the end, the playhead really went back to an earlier point: seek back and keep playing, hold off during the cooldown", () => {
  const p = at({ elTime: 3.945, target: 1.2, paused: true, ended: true });
  assert.equal(p.seekTo, 1.2);
  assert.equal(p.play, true);
  const q = at({ elTime: 3.945, target: 1.2, paused: true, ended: true, now: 10_000, lastSeekAt: 10_000 - 100 });
  assert.equal(q.seekTo, null);
  assert.equal(q.play, false);
});

test("issue no new commands while seeking: currentTime then reads the target value, not the real progress", () => {
  const p = at({ elTime: 301, target: 305, seeking: true });
  assert.equal(p.seekTo, null);
  assert.equal(p.rate, null);
  assert.equal(p.pause, false);
});

test("if playback has not started while seeking, still send play(): starting playback should not be blocked by a seek", () => {
  const p = at({ elTime: 300, target: 300, seeking: true, paused: true });
  assert.equal(p.play, true);
  assert.equal(p.seekTo, null);
});

test("paused: align precisely (0.03s) and reset the rate", () => {
  const p = at({ playing: false, paused: true, elTime: 300, target: 300.5 });
  assert.equal(p.seekTo, 300.5);
  assert.equal(p.rate, 1);
  const q = at({ playing: false, paused: true, elTime: 300, target: 300.01 });
  assert.equal(q.seekTo, null, "if already within 0.03s, leave it alone: random seeks are painful when stepping frame by frame");
});

test("paused but the element is still playing: must pause", () => {
  const p = at({ playing: false, paused: false, elTime: 300, target: 300 });
  assert.equal(p.pause, true);
});

test("do nothing when target is invalid", () => {
  assert.equal(at({ target: NaN }).seekTo, null);
  assert.equal(at({ target: -1 }).seekTo, null);
  assert.equal(at({ elTime: NaN, target: 3 }).seekTo, null);
});

/*
 * The core of the regression test: simulate the entire "mid-playback start" process and count
 * how many times it seeks in total.
 *
 * Model values are based on actual measurements: playhead follows the wall clock; a seek takes
 * 400ms to display a frame (one keyframe every 5 seconds, requiring over a hundred frames
 * decoded in the middle), during which seeking=true and video time does not advance; when not
 * seeking, video advances normally according to playbackRate. At playback start, a 250ms startup
 * delay is given first to make it naturally lag behind.
 */
function simulate(planner, { frames = 600, startupLagMs = 250 } = {}) {
  let t = 300;            // Playhead
  let el = 300;           // Video clock
  let seeking = false, seekEndsAt = 0, lastSeekAt = 0, paused = true;
  let rate = 1, seeks = 0, stalledFrames = 0;
  const dt = 1000 / 60;

  for (let i = 0, now = 0; i < frames; i++, now += dt) {
    if (seeking && now >= seekEndsAt) seeking = false;
    if (!paused && !seeking && now >= startupLagMs) el += (dt / 1000) * rate;
    if (seeking) stalledFrames++;

    const p = planner({ elTime: el, seeking, paused, target: t, playing: true, now, lastSeekAt });
    if (p.rate !== null) rate = p.rate;
    if (p.seekTo !== null) { el = p.seekTo; seeking = true; seekEndsAt = now + 400; lastSeekAt = now; seeks++; }
    if (p.play) paused = false;

    t += dt / 1000;
  }
  return { seeks, stalledFrames, finalDrift: +(t - el).toFixed(3) };
}

/** The original logic, copied verbatim for comparison */
const oldPlanner = ({ elTime, target, paused }) => ({
  seekTo: Math.abs(elTime - target) > 0.2 ? target : null,
  rate: null,
  play: paused,
  pause: false,
});

test("start playback mid-segment for 10 seconds: old logic seeks repeatedly (the stuttering), new logic converges", () => {
  const before = simulate(oldPlanner);
  const after = simulate(planSync);

  // Old logic: every seek creates the reason for the next seek, seeking all the way to the end
  assert.ok(before.seeks >= 5, `old logic should seek repeatedly, but only ${before.seeks} times`);
  // New logic: corrects at most once, then catches up via speed changes
  assert.ok(after.seeks <= 1, `new logic should not seek repeatedly, got ${after.seeks} times`);
  assert.ok(
    after.stalledFrames * 4 < before.stalledFrames,
    `stalled frame count should drop sharply: old ${before.stalledFrames} → new ${after.stalledFrames}`,
  );
  assert.ok(Math.abs(after.finalDrift) < HARD_SEEK_SEC, `should catch up in the end, but the gap is ${after.finalDrift}s`);
});

test("starting at the beginning (seek is cheap), neither version stutters: the difference really comes from the cost of seek", () => {
  const cheapSeek = (planner) => simulate(planner, { startupLagMs: 30 });
  assert.ok(cheapSeek(oldPlanner).seeks === 0);
  assert.ok(cheapSeek(planSync).seeks === 0);
});

/* ─────────────── Scrub playhead: sparser seeks, catch up once after settling ─────────────── */

test("while scrubbing, throttle seeks in paused state: if less than SCRUB_SEEK_MIN_MS since the last one, do not send yet, but report when to catch up", () => {
  const p = at({ playing: false, paused: true, scrubbing: true, elTime: 40, target: 41, now: 10_000, lastSeekAt: 10_000 - 20 });
  assert.equal(p.seekTo, null);
  assert.equal(p.retryInMs, SCRUB_SEEK_MIN_MS - 20, "the suppressed seek must be scheduled for later, otherwise nothing triggers a sync once the hand stops");
  const q = at({ playing: false, paused: true, scrubbing: true, elTime: 40, target: 41, now: 10_000, lastSeekAt: 10_000 - SCRUB_SEEK_MIN_MS });
  assert.equal(q.seekTo, 41);
  assert.equal(q.retryInMs, null);
});

test("when not scrubbing (single click, frame stepping, after release), still align precisely right away", () => {
  const p = at({ playing: false, paused: true, scrubbing: false, elTime: 40, target: 41, now: 10_000, lastSeekAt: 10_000 - 5 });
  assert.equal(p.seekTo, 41);
  const q = at({ playing: false, paused: true, scrubbing: true, elTime: 40, target: 40 + PAUSED_SEEK_SEC / 2, now: 10_000, lastSeekAt: 10_000 - 5 });
  assert.equal(q.seekTo, null);
  assert.equal(q.retryInMs, null, "if already aligned, no need to schedule");
});

/*
 * The entire process of scrubbing for 3 seconds: pointer moves every 16ms (each move = one
 * render = one sync); seeks take seekMs to settle. resyncOnSeeked / retrying via retryInMs
 * corresponds to driveMedia in MediaLayers.tsx; the old version had neither.
 */
function simulateScrub({ seekMs, scrubbing, resync }) {
  let el = 10, want = 10, seeking = false, seekEnds = 0, lastSeekAt = -1e9, seeks = 0, retryAt = null;
  let now = 0, lastMoveDuringSeek = false;
  const sync = () => {
    const p = planSync({ elTime: el, seeking, paused: true, target: want, playing: false, scrubbing, now, lastSeekAt });
    if (p.seekTo !== null) { el = p.seekTo; seeking = true; seekEnds = now + seekMs; lastSeekAt = now; seeks++; }
    retryAt = resync && p.retryInMs !== null ? now + p.retryInMs : null;
  };
  for (now = 0; now <= 4000; now++) {
    if (seeking && now >= seekEnds) { seeking = false; if (resync) sync(); }
    if (retryAt !== null && now >= retryAt) { retryAt = null; sync(); }
    if (now <= 3000 && now % 16 === 0) {
      lastMoveDuringSeek = seeking; // Last assignment = whether a seek was in progress at the moment of the last move
      want = 10 + (9.5 * now) / 3000;
      sync();
    }
  }
  return { seeks, finalOff: Math.abs(el - want), seeking, lastMoveDuringSeek };
}

test("when the last scrub move lands in the middle of a seek: the old version leaves the picture on a stale frame, the new version adds the final position after the seek settles", () => {
  // seek 100ms: much longer than pointer interval. The two versions have different seek cadences;
  // each confirms that the last move (2992ms) actually caught a seek
  const before = simulateScrub({ seekMs: 100, scrubbing: false, resync: false });
  assert.ok(before.lastMoveDuringSeek, "scenario set up wrong: the old version's last move did not land in the middle of a seek");
  assert.ok(before.finalOff > PAUSED_SEEK_SEC, `old version should stay at the old position, but the gap is only ${before.finalOff}`);
  const after = simulateScrub({ seekMs: 100, scrubbing: true, resync: true });
  assert.ok(after.lastMoveDuringSeek, "scenario set up wrong: the new version's last move did not land in the middle of a seek");
  assert.ok(after.finalOff <= PAUSED_SEEK_SEC, `new version should land at the final position, but the gap is ${after.finalOff}`);
  assert.equal(after.seeking, false);
});

test("even when seek is cheap (moving forward within the same GOP), it does not seek on every move", () => {
  const before = simulateScrub({ seekMs: 5, scrubbing: false, resync: false });
  const after = simulateScrub({ seekMs: 5, scrubbing: true, resync: true });
  assert.ok(before.seeks >= 150, `old version seeks on every move, got ${before.seeks} times`);
  assert.ok(after.seeks <= 3000 / SCRUB_SEEK_MIN_MS + 1, `new version should do at most ~60 times in 3 seconds, got ${after.seeks} times`);
  assert.ok(after.finalOff <= PAUSED_SEEK_SEC, `still lands at the final position, but the gap is ${after.finalOff}`);
});

/* ─────────────── Double-buffered slots ─────────────── */

const sc = (id, url, start, end, offset = 0) => ({ id, url, start, end, offset });
const c1 = sc("c1", "/a.mp4", 0, 5, 20);
const c2 = sc("c2", "/a.mp4", 5, 8, 133); // Same file, non-contiguous in the source file
const c3 = sc("c3", "/b.mp4", 8, 10, 7);
const slot = (clip, ready = true) => ({ clip, ready });
const empty = { clip: null, ready: false };

test("far from the next segment: play only the current segment, no preparation", () => {
  const p = planSlots({ slots: [slot(c1), empty], shown: 0, cur: c1, next: c2, t: 5 - PREROLL_SEC - 0.5, playing: true });
  assert.equal(p.active, 0);
  assert.equal(p.shown, 0);
  assert.equal(p.preload, null);
  assert.equal(p.load[1], null);
});

test("within the lead time: load the next segment into the other slot, current segment displays as usual", () => {
  const p = planSlots({ slots: [slot(c1), empty], shown: 0, cur: c1, next: c2, t: 5 - PREROLL_SEC + 0.1, playing: true });
  assert.equal(p.preload, 1);
  assert.equal(p.load[1].id, "c2");
  assert.equal(p.shown, 0);
});

test("at the boundary, next segment already showing: only switch the display, leave what both slots hold untouched", () => {
  const p = planSlots({ slots: [slot(c1), slot(c2)], shown: 0, cur: c2, next: c3, t: 5, playing: true });
  assert.equal(p.active, 1);
  assert.equal(p.shown, 1);
  assert.equal(p.load[0].id, "c1");
  assert.equal(p.load[1].id, "c2");
});

test("at the boundary, next segment not showing yet: for back-to-back segments let the previous segment's last frame cover, and do not use the covering slot to load the segment after next", () => {
  const c3soon = sc("c3", "/b.mp4", 5.5, 7, 7); // Very short, the next clip is already within the lookahead
  const p = planSlots({ slots: [slot(c1), slot(c2, false)], shown: 0, cur: c2, next: c3soon, t: 5.01, playing: true });
  assert.equal(p.active, 1);
  assert.equal(p.shown, 0, "cover");
  assert.equal(p.preload, null, "slot 0 is covering, cannot be used for loading");
  assert.equal(p.load[0].id, "c1");
});

test("covering lasts at most NOT_READY_GRACE_SEC, after that it hard-cuts", () => {
  const p = planSlots({ slots: [slot(c1), slot(c2, false)], shown: 0, cur: c2, next: null, t: 5 + NOT_READY_GRACE_SEC, playing: true });
  assert.equal(p.shown, 1);
});

test("not loaded in advance (segment too short / jumped in during playback): load into the other slot, the one on display covers for now", () => {
  const p = planSlots({ slots: [slot(c1), slot(c3)], shown: 0, cur: c2, next: null, t: 5.02, playing: true });
  assert.equal(p.active, 1);
  assert.equal(p.load[1].id, "c2");
  assert.equal(p.shown, 0);
});

test("cannot connect (gap in between): leave it empty for now, do not cover with an unrelated old picture", () => {
  const early = sc("e", "/a.mp4", 0, 3, 0);
  const p = planSlots({ slots: [slot(early), slot(c2, false)], shown: 0, cur: c2, next: null, t: 5.02, playing: true });
  assert.equal(p.shown, null);
});

test("When paused, wherever you drag to is what counts: use only the slot that is showing, and do not prepare the next segment", () => {
  const far = sc("far", "/c.mp4", 30, 33, 60);
  const p = planSlots({ slots: [slot(c1), slot(c2)], shown: 0, cur: far, next: sc("n", "/d.mp4", 33.5, 35), t: 33, playing: false });
  assert.equal(p.active, 0);
  assert.equal(p.load[0].id, "far");
  assert.equal(p.load[1].id, "c2", "The other slot is left untouched");
  assert.equal(p.preload, null);
  assert.equal(p.shown, 0, "When paused, do not wait for the exit from view, same as the old single-element behavior");
});

test("When paused and the current segment happens to be in the other slot already (e.g. paused right after switching): use it directly", () => {
  const p = planSlots({ slots: [slot(c1), slot(c2)], shown: 1, cur: c2, next: null, t: 6, playing: false });
  assert.equal(p.active, 1);
  assert.equal(p.shown, 1);
});

test("In a gap: show nothing, but the segment after the gap is still preloaded in advance; prefer a slot that already holds the same file", () => {
  const after = sc("x", "/b.mp4", 11, 14, 3);
  const p = planSlots({ slots: [slot(c1), slot(c3)], shown: null, cur: null, next: after, t: 11 - PREROLL_SEC + 0.2, playing: true });
  assert.equal(p.shown, null);
  assert.equal(p.preload, 1, "Slot 1 already holds b.mp4, so no file reload, only seek");
  assert.equal(p.load[1].id, "x");
});

/* ─────────────── Tier switch (T1a review #5: same clip changed address = new clip) ─────────────── */

const c1small = sc("c1", "/@media/small", 0, 5, 20);
const c1orig = sc("c1", "/@media/orig", 0, 5, 20);

test("Tier switch (playing): the new tier loads into the other slot to warm up, the previous tier keeps playing as active, no freeze, no black flash", () => {
  // Clip has played to 3s (well past NOT_READY_GRACE_SEC); small-size asset is displayed on slot 0,
  // original-size asset just fully arrived
  const p = planSlots({ slots: [slot(c1small), empty], shown: 0, cur: c1orig, next: null, t: 3, playing: true });
  assert.equal(p.active, 0, "The previous tier keeps playing (C6.6: load the new tier muted in the background)");
  assert.equal(p.warm, 1);
  assert.equal(p.load[1].url, "/@media/orig");
  assert.equal(p.load[0].url, "/@media/small", "The previous tier is left untouched");
  assert.equal(p.shown, 0, "The new tier is not aligned to show yet: the previous tier holds the screen");
  // New tier is still warming up (loaded, not ready): previous tier is still active
  const w = planSlots({ slots: [slot(c1small), slot(c1orig, false)], shown: 0, cur: c1orig, next: null, t: 3.05, playing: true });
  assert.equal(w.active, 0);
  assert.equal(w.warm, 1);
  assert.equal(w.shown, 0);
  // New tier is aligned and displayed: swapped in a single planning pass
  const q = planSlots({ slots: [slot(c1small), slot(c1orig)], shown: 0, cur: c1orig, next: null, t: 3.1, playing: true });
  assert.equal(q.active, 1);
  assert.equal(q.shown, 1);
  assert.equal(q.warm, null);
});

test("Tier switch (paused): the new tier loads into the other slot to warm up, and the previous tier on display is not torn down", () => {
  const p = planSlots({ slots: [slot(c1small), empty], shown: 0, cur: c1orig, next: null, t: 3, playing: false });
  assert.equal(p.active, 0);
  assert.equal(p.warm, 1);
  assert.equal(p.load[0].url, "/@media/small");
  assert.equal(p.shown, 0);
  const q = planSlots({ slots: [slot(c1small), slot(c1orig)], shown: 0, cur: c1orig, next: null, t: 3, playing: false });
  assert.equal(q.shown, 1);
  assert.equal(q.active, 1);
});

test("The tier switch rule does not step in when the URL is unchanged: the same segment keeps using its original slot", () => {
  const p = planSlots({ slots: [slot(c1orig), empty], shown: 0, cur: c1orig, next: null, t: 3, playing: true });
  assert.equal(p.active, 0);
  assert.equal(p.shown, 0);
  assert.equal(p.load[1], null);
});

/* ---------------- Reload after fully arrived (C6.6 T9-X2) ---------------- */

const reload = (o) => reloadOnComplete({ doneNow: true, seenBefore: false, hasClip: true, freshSrc: false, error: false, networkState: 1, ...o });

test("At the moment it is ready: an element that previously failed to attach (error, or NETWORK_NO_SOURCE) reloads once", () => {
  assert.equal(reload({ error: true, networkState: 3 }), true);
  assert.equal(reload({ networkState: 3 }), true);
  assert.equal(reload({ error: true }), true);
});

test("An element that just had its src set in this round does not reload: as soon as src changes, networkState is NO_SOURCE right away, and calling load() again would only interrupt the load that just started", () => {
  // Tier switch round: original size fully arrived → warmup slot switched to original-size address,
  // doneNow flips to true and src just updated in the same commit
  assert.equal(reload({ freshSrc: true, networkState: 3 }), false);
  assert.equal(reload({ freshSrc: true, networkState: 3, error: true }), false);
});

test("Not failed, not ready, ready long since seen, slot empty: none of them reload", () => {
  assert.equal(reload({ networkState: 1 }), false);
  assert.equal(reload({ networkState: 2 }), false);
  assert.equal(reload({ doneNow: false, networkState: 3, error: true }), false);
  assert.equal(reload({ seenBefore: true, networkState: 3, error: true }), false);
  assert.equal(reload({ hasClip: false, networkState: 3, error: true }), false);
});

test("An idle slot (not playing, not warming up, not preparing the next segment) does not reload when ready: reloading would only compete with the playability probe for bandwidth; reload when it is its turn to be used", () => {
  // Cross-machine T9 ht9a0927: idle original-size slot reloaded, pulling original size concurrently
  // with playability probe; probe timed out on slow link as a result (AGENT-tier-reload-seek)
  assert.equal(reload({ inUse: false, networkState: 3, error: true }), false);
  assert.equal(reload({ inUse: true, networkState: 3, error: true }), true);
  // Omitting inUse counts as "in use" (same as before)
  assert.equal(reload({ networkState: 3, error: true }), true);
});

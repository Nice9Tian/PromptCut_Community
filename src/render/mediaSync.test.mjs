/**
 * mediaSync 的单测。跑:node --test src/render/mediaSync.test.mjs
 *
 * 钉死的是一条:**纠偏本身不能制造下一次纠偏的理由**。
 * 原来那版「偏差 > 0.2s 就 seek」在时间轴中段会自持循环 —— 中段 seek 要从上一个关键帧
 * (用户素材是每 5 秒一个)解出上百帧才出画,这几百毫秒里播放头照走,落定时又超阈值,
 * 于是再 seek。表现就是「从中间或尾部起播一卡一卡,从开头十几秒起播没事」。
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
  const behind = at({ elTime: 300, target: 300.25 }); // 视频落后 0.25s
  assert.equal(behind.seekTo, null, "this tier must never seek");
  assert.ok(behind.rate > 1 && behind.rate <= 1 + MAX_RATE_SKEW, `should play a bit faster, got ${behind.rate}`);

  const ahead = at({ elTime: 300.25, target: 300 }); // 视频超前 0.25s
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
  // 声音比播放头快了 0.2s 先放完(素材 3.945s,播放头在 3.733s)
  const p = at({ elTime: 3.945, target: 3.733, paused: true, ended: true });
  assert.equal(p.play, false, "calling play() on a finished element goes back to 0 and replays");
  assert.equal(p.seekTo, null);
  assert.equal(p.pause, false);
  // 片段比素材长:播放头已经越过素材尽头,同样安静等着
  const q = at({ elTime: 3.945, target: 4.6, paused: true, ended: true });
  assert.equal(q.play, false);
  assert.equal(q.seekTo, null);
  // 对照:没放完、只是暂停着的元素照旧起播
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
 * 回归的正主:模拟「中段起播」整个过程,数它一共 seek 了几次。
 *
 * 模型按实测取值:播放头按墙钟走;seek 一次要 400ms 才出画(关键帧 5 秒一个,
 * 中段得解出上百帧),这期间 seeking=true 且视频时间不前进;不 seek 的时候视频按
 * playbackRate 正常走。起播时先给 250ms 的启动延迟,让它天然落后一截。
 */
function simulate(planner, { frames = 600, startupLagMs = 250 } = {}) {
  let t = 300;            // 播放头
  let el = 300;           // 视频时钟
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

/** 原来那版逻辑,逐字照抄,用来对照 */
const oldPlanner = ({ elTime, target, paused }) => ({
  seekTo: Math.abs(elTime - target) > 0.2 ? target : null,
  rate: null,
  play: paused,
  pause: false,
});

test("start playback mid-segment for 10 seconds: old logic seeks repeatedly (the stuttering), new logic converges", () => {
  const before = simulate(oldPlanner);
  const after = simulate(planSync);

  // 旧逻辑:每次 seek 都制造下一次 seek 的理由,一路 seek 到底
  assert.ok(before.seeks >= 5, `old logic should seek repeatedly, but only ${before.seeks} times`);
  // 新逻辑:最多纠一次,之后靠变速追平
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

/* ─────────────── 拖动播放头:seek 放疏,落定后补一次 ─────────────── */

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
 * 拖 3 秒的整个过程:指针每 16ms 动一下(每动一下 = 一次渲染 = 一次同步),seek 要 seekMs 才落定。
 * resyncOnSeeked / 按 retryInMs 补,对应 MediaLayers.tsx 的 driveMedia;旧版两样都没有。
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
      lastMoveDuringSeek = seeking; // 最后一次赋值 = 最后一次移动那一刻是不是正在 seek
      want = 10 + (9.5 * now) / 3000;
      sync();
    }
  }
  return { seeks, finalOff: Math.abs(el - want), seeking, lastMoveDuringSeek };
}

test("when the last scrub move lands in the middle of a seek: the old version leaves the picture on a stale frame, the new version adds the final position after the seek settles", () => {
  // seek 100ms:比指针间隔长得多。两版的 seek 节奏不同,各自确认最后一次移动(2992ms)真的赶上了 seek
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

/* ─────────────── 双缓冲槽位 ─────────────── */

const sc = (id, url, start, end, offset = 0) => ({ id, url, start, end, offset });
const c1 = sc("c1", "/a.mp4", 0, 5, 20);
const c2 = sc("c2", "/a.mp4", 5, 8, 133); // 同一个文件,源文件里不连续
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
  const c3soon = sc("c3", "/b.mp4", 5.5, 7, 7); // 很短,再下一段已经在提前量里
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

/* ─────────────── 换档(T1a 审查 #5:同一片段换了地址 = 新的一段) ─────────────── */

const c1small = sc("c1", "/@media/small", 0, 5, 20);
const c1orig = sc("c1", "/@media/orig", 0, 5, 20);

test("Tier switch (playing): the new tier loads into the other slot to warm up, the previous tier keeps playing as active, no freeze, no black flash", () => {
  // 片段已经放到第 3 秒(早过了 NOT_READY_GRACE_SEC),素材小尺寸在 0 号显示,素材原尺寸刚到齐
  const p = planSlots({ slots: [slot(c1small), empty], shown: 0, cur: c1orig, next: null, t: 3, playing: true });
  assert.equal(p.active, 0, "The previous tier keeps playing (C6.6: load the new tier muted in the background)");
  assert.equal(p.warm, 1);
  assert.equal(p.load[1].url, "/@media/orig");
  assert.equal(p.load[0].url, "/@media/small", "The previous tier is left untouched");
  assert.equal(p.shown, 0, "The new tier is not aligned to show yet: the previous tier holds the screen");
  // 新档还在预热(装着、没 ready):上一档仍是 active
  const w = planSlots({ slots: [slot(c1small), slot(c1orig, false)], shown: 0, cur: c1orig, next: null, t: 3.05, playing: true });
  assert.equal(w.active, 0);
  assert.equal(w.warm, 1);
  assert.equal(w.shown, 0);
  // 新档对齐出画了:一次规划里对调
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

/* ---------------- 到齐后重载(C6.6 T9-X2) ---------------- */

const reload = (o) => reloadOnComplete({ doneNow: true, seenBefore: false, hasClip: true, freshSrc: false, error: false, networkState: 1, ...o });

test("At the moment it is ready: an element that previously failed to attach (error, or NETWORK_NO_SOURCE) reloads once", () => {
  assert.equal(reload({ error: true, networkState: 3 }), true);
  assert.equal(reload({ networkState: 3 }), true);
  assert.equal(reload({ error: true }), true);
});

test("An element that just had its src set in this round does not reload: as soon as src changes, networkState is NO_SOURCE right away, and calling load() again would only interrupt the load that just started", () => {
  // 换档那一轮:原尺寸到齐 → 预热槽位换成原尺寸地址,同一次提交里 doneNow 翻真、src 刚换上
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
  // 跨机 T9 ht9a0927:闲着的原尺寸槽位被重载,和可播性探测同时拉原尺寸,慢链路上探测因此超时(AGENT-tier-reload-seek)
  assert.equal(reload({ inUse: false, networkState: 3, error: true }), false);
  assert.equal(reload({ inUse: true, networkState: 3, error: true }), true);
  // 不给 inUse 按「在用」算(和以前一样)
  assert.equal(reload({ networkState: 3, error: true }), true);
});

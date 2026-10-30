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

test("对齐得好好的:什么都不动,速度保持 1", () => {
  const p = at({ elTime: 300, target: 300.01 });
  assert.equal(p.seekTo, null);
  assert.equal(p.rate, 1);
  assert.equal(p.play, false);
});

test("中等偏差用变速追,不 seek —— 中段 seek 正是卡顿的来源", () => {
  const behind = at({ elTime: 300, target: 300.25 }); // 视频落后 0.25s
  assert.equal(behind.seekTo, null, "这一档绝不能 seek");
  assert.ok(behind.rate > 1 && behind.rate <= 1 + MAX_RATE_SKEW, `应该快放一点,实际 ${behind.rate}`);

  const ahead = at({ elTime: 300.25, target: 300 }); // 视频超前 0.25s
  assert.equal(ahead.seekTo, null);
  assert.ok(ahead.rate < 1 && ahead.rate >= 1 - MAX_RATE_SKEW, `应该慢放一点,实际 ${ahead.rate}`);
});

test("变速幅度封顶在 ±10%:再多就听得出变调了", () => {
  const p = at({ elTime: 300, target: 300 + HARD_SEEK_SEC - 0.001 });
  assert.ok(p.rate <= 1 + MAX_RATE_SKEW + 1e-9);
});

test("真脱节了(超过 0.5s)才 seek", () => {
  const p = at({ elTime: 300, target: 301 });
  assert.equal(p.seekTo, 301);
  assert.equal(p.rate, 1, "seek 的同时把速度还原,别带着微调落地");
});

test("seek 有冷却:上一次还没过 700ms 就先忍着", () => {
  const p = at({ elTime: 300, target: 301, now: 10_000, lastSeekAt: 10_000 - (SEEK_COOLDOWN_MS - 50) });
  assert.equal(p.seekTo, null, "冷却期内不许再 seek");
  const q = at({ elTime: 300, target: 301, now: 10_000, lastSeekAt: 10_000 - (SEEK_COOLDOWN_MS + 50) });
  assert.equal(q.seekTo, 301, "冷却过了就该纠了");
});

test("放到素材尽头的元素:播放头还没走出这一段时不调 play() —— 那会从头重播", () => {
  // 声音比播放头快了 0.2s 先放完(素材 3.945s,播放头在 3.733s)
  const p = at({ elTime: 3.945, target: 3.733, paused: true, ended: true });
  assert.equal(p.play, false, "放完了的元素再 play() 会回到 0 重播");
  assert.equal(p.seekTo, null);
  assert.equal(p.pause, false);
  // 片段比素材长:播放头已经越过素材尽头,同样安静等着
  const q = at({ elTime: 3.945, target: 4.6, paused: true, ended: true });
  assert.equal(q.play, false);
  assert.equal(q.seekTo, null);
  // 对照:没放完、只是暂停着的元素照旧起播
  assert.equal(at({ elTime: 3.9, target: 3.733, paused: true }).play, true);
});

test("放到尽头之后播放头真的回到了前面:seek 回去接着放,冷却期内先忍着", () => {
  const p = at({ elTime: 3.945, target: 1.2, paused: true, ended: true });
  assert.equal(p.seekTo, 1.2);
  assert.equal(p.play, true);
  const q = at({ elTime: 3.945, target: 1.2, paused: true, ended: true, now: 10_000, lastSeekAt: 10_000 - 100 });
  assert.equal(q.seekTo, null);
  assert.equal(q.play, false);
});

test("seeking 期间一律不下新指令 —— 这时候 currentTime 读的是目标值不是真实进度", () => {
  const p = at({ elTime: 301, target: 305, seeking: true });
  assert.equal(p.seekTo, null);
  assert.equal(p.rate, null);
  assert.equal(p.pause, false);
});

test("seeking 期间如果还没起播,play() 照发:起播不该被 seek 挡住", () => {
  const p = at({ elTime: 300, target: 300, seeking: true, paused: true });
  assert.equal(p.play, true);
  assert.equal(p.seekTo, null);
});

test("暂停:精确对齐(0.03s),并且把速度还原", () => {
  const p = at({ playing: false, paused: true, elTime: 300, target: 300.5 });
  assert.equal(p.seekTo, 300.5);
  assert.equal(p.rate, 1);
  const q = at({ playing: false, paused: true, elTime: 300, target: 300.01 });
  assert.equal(q.seekTo, null, "已经在 0.03s 以内就别动,逐帧看的时候乱 seek 很难受");
});

test("暂停但元素还在放:要 pause", () => {
  const p = at({ playing: false, paused: false, elTime: 300, target: 300 });
  assert.equal(p.pause, true);
});

test("target 不合法时什么都不做", () => {
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

test("中段起播 10 秒:旧逻辑反复 seek(就是那个一卡一卡),新逻辑收敛", () => {
  const before = simulate(oldPlanner);
  const after = simulate(planSync);

  // 旧逻辑:每次 seek 都制造下一次 seek 的理由,一路 seek 到底
  assert.ok(before.seeks >= 5, `旧逻辑本该反复 seek,实际只有 ${before.seeks} 次`);
  // 新逻辑:最多纠一次,之后靠变速追平
  assert.ok(after.seeks <= 1, `新逻辑不该反复 seek,实际 ${after.seeks} 次`);
  assert.ok(
    after.stalledFrames * 4 < before.stalledFrames,
    `卡住的帧数该大幅下降:旧 ${before.stalledFrames} → 新 ${after.stalledFrames}`,
  );
  assert.ok(Math.abs(after.finalDrift) < HARD_SEEK_SEC, `最终应该追平,实际差 ${after.finalDrift}s`);
});

test("开头起播(seek 便宜)两版都不卡 —— 说明差别真的出在 seek 代价上", () => {
  const cheapSeek = (planner) => simulate(planner, { startupLagMs: 30 });
  assert.ok(cheapSeek(oldPlanner).seeks === 0);
  assert.ok(cheapSeek(planSync).seeks === 0);
});

/* ─────────────── 拖动播放头:seek 放疏,落定后补一次 ─────────────── */

test("拖动时暂停态 seek 放疏:离上一次不到 SCRUB_SEEK_MIN_MS 先不发,但给出什么时候补", () => {
  const p = at({ playing: false, paused: true, scrubbing: true, elTime: 40, target: 41, now: 10_000, lastSeekAt: 10_000 - 20 });
  assert.equal(p.seekTo, null);
  assert.equal(p.retryInMs, SCRUB_SEEK_MIN_MS - 20, "压下来的这次必须约好时间补,不然手停住以后没人再触发同步");
  const q = at({ playing: false, paused: true, scrubbing: true, elTime: 40, target: 41, now: 10_000, lastSeekAt: 10_000 - SCRUB_SEEK_MIN_MS });
  assert.equal(q.seekTo, 41);
  assert.equal(q.retryInMs, null);
});

test("不拖的时候(点一下、逐帧看、松手之后)照旧立刻精确对齐", () => {
  const p = at({ playing: false, paused: true, scrubbing: false, elTime: 40, target: 41, now: 10_000, lastSeekAt: 10_000 - 5 });
  assert.equal(p.seekTo, 41);
  const q = at({ playing: false, paused: true, scrubbing: true, elTime: 40, target: 40 + PAUSED_SEEK_SEC / 2, now: 10_000, lastSeekAt: 10_000 - 5 });
  assert.equal(q.seekTo, null);
  assert.equal(q.retryInMs, null, "已经对齐了就不用约");
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

test("拖动时最后一下落在 seek 中间:旧版画面停在旧的一帧,新版 seek 落定后补上最终位置", () => {
  // seek 100ms:比指针间隔长得多。两版的 seek 节奏不同,各自确认最后一次移动(2992ms)真的赶上了 seek
  const before = simulateScrub({ seekMs: 100, scrubbing: false, resync: false });
  assert.ok(before.lastMoveDuringSeek, "场景没搭对:旧版最后一次移动没落在 seek 中间");
  assert.ok(before.finalOff > PAUSED_SEEK_SEC, `旧版本该停在旧位置,实际只差 ${before.finalOff}`);
  const after = simulateScrub({ seekMs: 100, scrubbing: true, resync: true });
  assert.ok(after.lastMoveDuringSeek, "场景没搭对:新版最后一次移动没落在 seek 中间");
  assert.ok(after.finalOff <= PAUSED_SEEK_SEC, `新版该落在最终位置,实际差 ${after.finalOff}`);
  assert.equal(after.seeking, false);
});

test("seek 很便宜时(同一个 GOP 里往后挪)也不会每动一下就 seek 一次", () => {
  const before = simulateScrub({ seekMs: 5, scrubbing: false, resync: false });
  const after = simulateScrub({ seekMs: 5, scrubbing: true, resync: true });
  assert.ok(before.seeks >= 150, `旧版每动一下就 seek,实际 ${before.seeks} 次`);
  assert.ok(after.seeks <= 3000 / SCRUB_SEEK_MIN_MS + 1, `新版 3 秒最多 ~60 次,实际 ${after.seeks} 次`);
  assert.ok(after.finalOff <= PAUSED_SEEK_SEC, `照样落在最终位置,实际差 ${after.finalOff}`);
});

/* ─────────────── 双缓冲槽位 ─────────────── */

const sc = (id, url, start, end, offset = 0) => ({ id, url, start, end, offset });
const c1 = sc("c1", "/a.mp4", 0, 5, 20);
const c2 = sc("c2", "/a.mp4", 5, 8, 133); // 同一个文件,源文件里不连续
const c3 = sc("c3", "/b.mp4", 8, 10, 7);
const slot = (clip, ready = true) => ({ clip, ready });
const empty = { clip: null, ready: false };

test("离下一段还远:只放当前段,不预备", () => {
  const p = planSlots({ slots: [slot(c1), empty], shown: 0, cur: c1, next: c2, t: 5 - PREROLL_SEC - 0.5, playing: true });
  assert.equal(p.active, 0);
  assert.equal(p.shown, 0);
  assert.equal(p.preload, null);
  assert.equal(p.load[1], null);
});

test("进了提前量:下一段装进另一个槽位,当前段照常显示", () => {
  const p = planSlots({ slots: [slot(c1), empty], shown: 0, cur: c1, next: c2, t: 5 - PREROLL_SEC + 0.1, playing: true });
  assert.equal(p.preload, 1);
  assert.equal(p.load[1].id, "c2");
  assert.equal(p.shown, 0);
});

test("到了交界、下一段已经出画:只换显示,两个槽位装的东西都不动", () => {
  const p = planSlots({ slots: [slot(c1), slot(c2)], shown: 0, cur: c2, next: c3, t: 5, playing: true });
  assert.equal(p.active, 1);
  assert.equal(p.shown, 1);
  assert.equal(p.load[0].id, "c1");
  assert.equal(p.load[1].id, "c2");
});

test("交界时下一段还没出画:首尾相接就让上一段末帧顶着,顶班的槽位不拿去装再下一段", () => {
  const c3soon = sc("c3", "/b.mp4", 5.5, 7, 7); // 很短,再下一段已经在提前量里
  const p = planSlots({ slots: [slot(c1), slot(c2, false)], shown: 0, cur: c2, next: c3soon, t: 5.01, playing: true });
  assert.equal(p.active, 1);
  assert.equal(p.shown, 0, "顶班");
  assert.equal(p.preload, null, "0 号正在顶班,不能拿去装");
  assert.equal(p.load[0].id, "c1");
});

test("顶班最多撑 NOT_READY_GRACE_SEC,过了就硬切", () => {
  const p = planSlots({ slots: [slot(c1), slot(c2, false)], shown: 0, cur: c2, next: null, t: 5 + NOT_READY_GRACE_SEC, playing: true });
  assert.equal(p.shown, 1);
});

test("没提前装上(片段太短 / 播放中跳过来):装进另一个槽位,显示着的那个先顶着", () => {
  const p = planSlots({ slots: [slot(c1), slot(c3)], shown: 0, cur: c2, next: null, t: 5.02, playing: true });
  assert.equal(p.active, 1);
  assert.equal(p.load[1].id, "c2");
  assert.equal(p.shown, 0);
});

test("接不上(中间有空档):先空着,不拿一段不相干的旧画面顶", () => {
  const early = sc("e", "/a.mp4", 0, 3, 0);
  const p = planSlots({ slots: [slot(early), slot(c2, false)], shown: 0, cur: c2, next: null, t: 5.02, playing: true });
  assert.equal(p.shown, null);
});

test("暂停时拖到哪算哪:只用显示着的那个槽位,也不预备下一段", () => {
  const far = sc("far", "/c.mp4", 30, 33, 60);
  const p = planSlots({ slots: [slot(c1), slot(c2)], shown: 0, cur: far, next: sc("n", "/d.mp4", 33.5, 35), t: 33, playing: false });
  assert.equal(p.active, 0);
  assert.equal(p.load[0].id, "far");
  assert.equal(p.load[1].id, "c2", "另一个槽位原样放着");
  assert.equal(p.preload, null);
  assert.equal(p.shown, 0, "暂停时不等出画,和原来一个元素的行为一样");
});

test("暂停时当前段恰好已经在另一个槽位里(比如刚切过去就暂停):直接用它", () => {
  const p = planSlots({ slots: [slot(c1), slot(c2)], shown: 1, cur: c2, next: null, t: 6, playing: false });
  assert.equal(p.active, 1);
  assert.equal(p.shown, 1);
});

test("空档里:什么都不显示,但空档后面那段照样提前装好;优先挑已经装着同一个文件的槽位", () => {
  const after = sc("x", "/b.mp4", 11, 14, 3);
  const p = planSlots({ slots: [slot(c1), slot(c3)], shown: null, cur: null, next: after, t: 11 - PREROLL_SEC + 0.2, playing: true });
  assert.equal(p.shown, null);
  assert.equal(p.preload, 1, "1 号装着 b.mp4,不用重新加载文件,只 seek");
  assert.equal(p.load[1].id, "x");
});

/* ─────────────── 换档(T1a 审查 #5:同一片段换了地址 = 新的一段) ─────────────── */

const c1small = sc("c1", "/@media/small", 0, 5, 20);
const c1orig = sc("c1", "/@media/orig", 0, 5, 20);

test("换档(播放中):新档装进另一个槽位预热,上一档照常当 active 往下放,不冻、不闪黑", () => {
  // 片段已经放到第 3 秒(早过了 NOT_READY_GRACE_SEC),素材小尺寸在 0 号显示,素材原尺寸刚到齐
  const p = planSlots({ slots: [slot(c1small), empty], shown: 0, cur: c1orig, next: null, t: 3, playing: true });
  assert.equal(p.active, 0, "上一档接着放(C6.6:后台静音加载新档)");
  assert.equal(p.warm, 1);
  assert.equal(p.load[1].url, "/@media/orig");
  assert.equal(p.load[0].url, "/@media/small", "上一档原样放着");
  assert.equal(p.shown, 0, "新档没对齐出画:上一档顶着");
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

test("换档(暂停):新档装进另一个槽位预热,显示着的上一档不被拆掉", () => {
  const p = planSlots({ slots: [slot(c1small), empty], shown: 0, cur: c1orig, next: null, t: 3, playing: false });
  assert.equal(p.active, 0);
  assert.equal(p.warm, 1);
  assert.equal(p.load[0].url, "/@media/small");
  assert.equal(p.shown, 0);
  const q = planSlots({ slots: [slot(c1small), slot(c1orig)], shown: 0, cur: c1orig, next: null, t: 3, playing: false });
  assert.equal(q.shown, 1);
  assert.equal(q.active, 1);
});

test("地址不变时换档规则不介入:同一段照旧认原来的槽位", () => {
  const p = planSlots({ slots: [slot(c1orig), empty], shown: 0, cur: c1orig, next: null, t: 3, playing: true });
  assert.equal(p.active, 0);
  assert.equal(p.shown, 0);
  assert.equal(p.load[1], null);
});

/* ---------------- 到齐后重载(C6.6 T9-X2) ---------------- */

const reload = (o) => reloadOnComplete({ doneNow: true, seenBefore: false, hasClip: true, freshSrc: false, error: false, networkState: 1, ...o });

test("到齐那一刻:之前挂失败了的元素(报错,或 NETWORK_NO_SOURCE)重载一次", () => {
  assert.equal(reload({ error: true, networkState: 3 }), true);
  assert.equal(reload({ networkState: 3 }), true);
  assert.equal(reload({ error: true }), true);
});

test("这一轮刚换上 src 的元素不重载:src 一换 networkState 当场就是 NO_SOURCE,再 load() 只会打断刚开始的加载", () => {
  // 换档那一轮:原尺寸到齐 → 预热槽位换成原尺寸地址,同一次提交里 doneNow 翻真、src 刚换上
  assert.equal(reload({ freshSrc: true, networkState: 3 }), false);
  assert.equal(reload({ freshSrc: true, networkState: 3, error: true }), false);
});

test("没失败、没到齐、到齐早就看过、槽位空着:都不重载", () => {
  assert.equal(reload({ networkState: 1 }), false);
  assert.equal(reload({ networkState: 2 }), false);
  assert.equal(reload({ doneNow: false, networkState: 3, error: true }), false);
  assert.equal(reload({ seenBefore: true, networkState: 3, error: true }), false);
  assert.equal(reload({ hasClip: false, networkState: 3, error: true }), false);
});

test("闲着的槽位(不播、不预热、不备下一段)到齐时不重载:重载只会和可播性探测抢带宽;轮到它用时再重载", () => {
  // 跨机 T9 ht9a0927:闲着的原尺寸槽位被重载,和可播性探测同时拉原尺寸,慢链路上探测因此超时(AGENT-tier-reload-seek)
  assert.equal(reload({ inUse: false, networkState: 3, error: true }), false);
  assert.equal(reload({ inUse: true, networkState: 3, error: true }), true);
  // 不给 inUse 按「在用」算(和以前一样)
  assert.equal(reload({ networkState: 3, error: true }), true);
});

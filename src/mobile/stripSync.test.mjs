/**
 * 手机版缩略时间轴（`src/mobile/ThumbStrip.tsx` + `src/mobile/mainContent.ts`）同步算术与状态机单元测试。
 * 验证「1 段 6 秒卡片段」与「3 段各 2 秒对照组」下 cardPosAtTime / timeAtCardPos / scrollForPos / posFromScroll、
 * useLayoutEffect 的 1px 死区在 60 / 30 / 24 fps 下的逐帧模拟、以及 onScroll 的 1.5px 门限读数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardPosAtTime, timeAtCardPos } from './mainContent.ts';

/**
 * 忠实照抄 `src/mobile/ThumbStrip.tsx` 第 43~53 行 `posFromScroll`，
 * 仅把闭包读取的 `sc.current!` 与 `blocks()` 改为参数 `(el, bl)`，未改动任何表达式或边界判断。
 */
/** 照抄 `ThumbStrip.tsx` 的 `spanOf`：第 i 段占的区间是「本卡左缘 → 下一卡左缘」，把转场标记那 30px 并进前一段 */
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
 * 忠实照抄 `src/mobile/ThumbStrip.tsx` 第 54~61 行 `scrollForPos`，
 * 仅把闭包读取的 `sc.current!` 与 `blocks()` 改为参数 `(el, bl, pos)`，未改动任何表达式或边界判断。
 */
function scrollForPos(el, bl, pos) {
  if (!bl.length) return 0;
  const i = Math.min(Math.floor(pos), bl.length - 1);
  const f = pos >= bl.length ? 1 : pos - i;
  const [l, r] = spanOf(bl, i);
  return l + f * (r - l) - el.clientWidth / 2;
}

/**
 * 忠实照抄 `src/mobile/ThumbStrip.tsx` 第 64~71 行 `useLayoutEffect` 的同步步。
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
 * 忠实照抄 `src/mobile/ThumbStrip.tsx` 第 76~80 行 `onScroll`。
 */
function runOnScrollStep(el, bl, clips, progSl, onScrub) {
  if (!el.clientWidth || Math.abs(el.scrollLeft - progSl.current) < 1.5) return false;
  progSl.current = el.scrollLeft;
  onScrub(timeAtCardPos(clips, posFromScroll(el, bl)));
  return true;
}

/**
 * 按给定几何参数构造假 DOM：
 * - `.strip-scroll` 宽度 W（= clientWidth）
 * - `.sp-l` 宽 W/2 - 46
 * - `.madd` 宽 40 + margin-right 6 = 46
 * - 每段 `.mblock` 宽 80（border-box，offsetWidth = 80）
 * - 段间 `.mark` 宽 24 + 左右 margin 各 3 = 30
 * - `.sp-r` 宽 W/2
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

test('SS1 1 段 6 秒卡片：t = 0 / 1 / 3 / 5.7 / 6 的 pos 与 want（W = 390）及端点连续性', () => {
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

  console.log('[SS1] 1段6秒 (W=390) 几何与采样读数:', {
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

  // 检查 t = 6 端点附近（6 - 2e-9、6 - 1e-9、6）是否存在跳变
  const posJustBefore = cardPosAtTime(clips, 6 - 2e-9);
  const posAtThreshold = cardPosAtTime(clips, 6 - 1e-9);
  const posAtEnd = cardPosAtTime(clips, 6);
  console.log('[SS1] t=6 端点左极限与端点值:', {
    't=6-2e-9': posJustBefore,
    't=6-1e-9': posAtThreshold,
    't=6': posAtEnd,
    diff: posAtEnd - posJustBefore,
  });
  assert.ok(Math.abs(posAtEnd - posJustBefore) < 1e-9, 't=6 处连续无跳变');
});

test('SS2 want 总行程、每秒速度、60/30/24 fps 每 tick 位移与 1px 时间误差（1 段 6 秒）', () => {
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

  console.log('[SS2] 1段6秒 速度与分辨率读数:', {
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

test('SS3 播放模拟循环（1 段 6 秒，fps = 60 / 30 / 24 三档）：验证 < 1 死区下每档最终 scrollLeft', () => {
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

  console.log('[SS3] 1段6秒 三档 fps (60 / 30 / 24) 模拟结果:', { r60, r30, r24 });

  // fps = 60: 每 tick 2/9 px，每 5 tick 跳 10/9 px，360 ticks 共写入 72 次，终点 80
  assert.equal(r60.ticksPerJump, 5);
  assert.equal(r60.floatScrollLeft.updateCount, 72);
  assert.equal(r60.floatScrollLeft.finalScrollLeft, 80);
  assert.equal(r60.intScrollLeft.updateCount, 80);
  assert.equal(r60.intScrollLeft.finalScrollLeft, 80);

  // fps = 30 (项目默认 fps): 每 tick 4/9 px，每 3 tick 跳 4/3 px，180 ticks 共写入 60 次，终点 80
  assert.equal(r30.ticksPerJump, 3);
  assert.equal(r30.floatScrollLeft.updateCount, 60);
  assert.equal(r30.floatScrollLeft.finalScrollLeft, 80);
  assert.equal(r30.intScrollLeft.updateCount, 80);
  assert.equal(r30.intScrollLeft.finalScrollLeft, 80);

  // fps = 24: 每 tick 5/9 px，每 2 tick 跳 10/9 px，144 ticks 共写入 72 次，终点 80
  assert.equal(r24.ticksPerJump, 2);
  assert.equal(r24.floatScrollLeft.updateCount, 72);
  assert.equal(r24.floatScrollLeft.finalScrollLeft, 80);
  assert.equal(r24.intScrollLeft.updateCount, 80);
  assert.equal(r24.intScrollLeft.finalScrollLeft, 80);
});

test('SS4 对照组：3 段各 2 秒（中间两个 .mark）在 60fps 与 30fps 下跑满 6 秒', () => {
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

  console.log('[SS4] 3段各2秒对照组 (W=390) 模拟结果:', {
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
  assert.equal(s30.updateCount, 180, '30fps 下每段每 tick 走 4/3 >= 1 px，每 tick 都更新，180 ticks 共更新 180 次');
});

test('SS5 posFromScroll 与 scrollForPos 来回一致性（1 段 6 秒）与 onScroll 1.5px 门限验证', () => {
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

  console.log('[SS5] 1段6秒 scrollForPos <-> posFromScroll 往返读数:', roundTrips);

  for (const r of roundTrips) {
    assert.ok(Math.abs(r.posBack - r.pos) < 1e-12, `pos=${r.pos} 往返一致`);
    assert.ok(Math.abs(r.tBack - r.tFromPos) < 1e-12, `t=${r.tFromPos} 往返一致`);
  }

  // 验证 onScroll 的 1.5px 门限：微动 < 1.5px 被吞，累计 >= 1.5px 正常触发 onScrub
  el.scrollLeft = 0;
  const progSl = { current: 0 };
  const scrubbedTimes = [];
  const onScrub = (t) => scrubbedTimes.push(t);

  el.scrollLeft = 1.0; // |1.0 - 0| < 1.5 -> 吞掉
  assert.equal(runOnScrollStep(el, bl, clips, progSl, onScrub), false);
  assert.equal(progSl.current, 0, '被吞时 progSl.current 不更新，后续位移继续累加');

  el.scrollLeft = 1.49; // |1.49 - 0| < 1.5 -> 仍被吞掉
  assert.equal(runOnScrollStep(el, bl, clips, progSl, onScrub), false);

  el.scrollLeft = 1.5; // |1.5 - 0| >= 1.5 -> 触发 onScrub(0.1125s)
  assert.equal(runOnScrollStep(el, bl, clips, progSl, onScrub), true);
  assert.equal(progSl.current, 1.5);
  assert.equal(scrubbedTimes.length, 1);
  assert.ok(Math.abs(scrubbedTimes[0] - 0.1125) < 1e-15);

  console.log('[SS5] onScroll 1.5px 门限验证:', {
    progSlAfter1_5px: progSl.current,
    scrubbedTimeAt1_5px: scrubbedTimes[0],
  });
});

/*
 * 段边界那 30px 死区（2026-10-25 修）。改之前：`scrollForPos` 按卡宽算，pos 从 1−ε 跨到 1 时
 * want 从上一段末尾直接跳到下一段左缘，中间那 30px（.mark 宽 24 + 左右各 3）不属于任何一段 ——
 * 播到边界瞬移、手动滚进去时间卡住。改成按「本卡左缘 → 下一卡左缘」算之后两头都连续。
 */
test('SS6 段边界不再有 30px 死区：want 连续、来回可逆（3 段各 2 秒，中间两个 .mark）', () => {
  const W = 390, CARD = 80, MARK = 30;
  const el = { clientWidth: W, scrollLeft: 0 };
  const left0 = W / 2;
  const bl = [0, 1, 2].map((i) => ({ offsetLeft: left0 + i * (CARD + MARK), offsetWidth: CARD }));

  // 1) want 在整条上单调且处处连续：相邻采样点的跨度不许出现 .mark 那一下 30px 的跳变
  const STEP = 1 / 512;
  let prev = scrollForPos(el, bl, 0), maxJump = 0;
  for (let pos = STEP; pos <= 3; pos += STEP) {
    const w = scrollForPos(el, bl, pos);
    assert.ok(w >= prev - 1e-9, `want 必须单调不减，pos=${pos}`);
    maxJump = Math.max(maxJump, w - prev);
    prev = w;
  }
  // 每段跨 CARD+MARK=110px、512 步，单步约 0.215px；留宽到 1px 仍远小于 30
  assert.ok(maxJump < 1, `相邻两步最大跨度 ${maxJump}px，不该出现 30px 的瞬移`);

  // 2) 整条可逆：滚动位置 → pos → 滚动位置，误差可忽略（改之前 .mark 那 30px 恒回整数）
  const maxScroll = scrollForPos(el, bl, 3);
  for (let x = 0; x <= maxScroll; x += 1) {
    el.scrollLeft = x;
    const back = scrollForPos(el, bl, posFromScroll(el, bl));
    assert.ok(Math.abs(back - x) < 1e-6, `x=${x} 来回不一致：回来是 ${back}`);
  }
  el.scrollLeft = 0;

  // 3) 段边界左右各取一点，pos 必须连续穿过整数，不是两边都卡在 1
  const boundary = scrollForPos(el, bl, 1);
  el.scrollLeft = boundary - 5; const before = posFromScroll(el, bl);
  el.scrollLeft = boundary + 5; const after = posFromScroll(el, bl);
  assert.ok(before < 1 && before > 0.9, `边界左边应接近 1 但小于 1，实际 ${before}`);
  assert.ok(after > 1 && after < 1.1, `边界右边应刚过 1，实际 ${after}`);
});

/**
 * 自然进场与从卡中间开始播放的判据（`playEntry.mjs`）。播放态互换只给后者；规则见模块文件头。
 *   node --test src/render/playEntry.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlayRun, enteredNaturally, notePlayBeat, notePlaySeam, notePlayStart } from "./playEntry.mjs";
import { mountFrameOf } from "./frameWindow.mjs";

const FPS = 30;
/** 从 `fromFrame` 起播，逐拍报到 `toFrame`（含） */
function playFrames(run, fromFrame, toFrame) {
  notePlayStart(run, fromFrame / FPS, FPS);
  const kinds = [];
  for (let f = fromFrame + 1; f <= toFrame; f++) kinds.push(notePlayBeat(run, f / FPS, FPS));
  return kinds;
}

test("ST-C-01 起播在卡之前、播放中逐拍走过挂载帧:自然进场", () => {
  const run = createPlayRun();
  const m = mountFrameOf({ start: 2, end: 6 }, FPS);   // 59
  assert.equal(m, 59);
  const kinds = playFrames(run, 0, 70);
  assert.ok(kinds.every((k) => k === "continuous"));
  assert.equal(enteredNaturally(run, m), true);
});

test("ST-C-02 从卡中间起播(跳到卡中间再播、打开页面停在卡中间再播):不是自然进场", () => {
  const run = createPlayRun();
  playFrames(run, 90, 100);   // 卡 59 起挂载,从第 90 帧起播
  assert.equal(enteredNaturally(run, 59), false);
});

test("ST-C-03 恰好停在挂载帧起播:起播那一刻卡已挂着,不算自然进场;停在挂载帧前一帧起播才算", () => {
  const at = createPlayRun();
  playFrames(at, 59, 70);
  assert.equal(enteredNaturally(at, 59), false, "挂载帧 = 起点:状态来自暂停态定位,照旧按估时");
  const before = createPlayRun();
  playFrames(before, 58, 70);
  assert.equal(enteredNaturally(before, 59), true, "挂载帧 = 起点 + 1:第一拍就逐拍挂上");
});

test("ST-C-04 暂停后在卡中间继续播:新一轮播放的起点是暂停处,之前自然进场的卡这一轮算从中间开始", () => {
  const run = createPlayRun();
  playFrames(run, 0, 90);
  assert.equal(enteredNaturally(run, 59), true);
  // 暂停在 90,继续播
  playFrames(run, 90, 100);
  assert.equal(enteredNaturally(run, 59), false);
  // 这一轮之后才挂载的卡照样是自然进场
  playFrames(run, 90, 130);
  assert.equal(enteredNaturally(run, 120), true);
});

test("ST-C-05 掉帧:舞台慢帧就等、拍序号仍逐一递增(只是到得晚),算连续", () => {
  const run = createPlayRun();
  notePlayStart(run, 0, FPS);
  // 父页主线程卡了一下:第 50～65 拍的事件一口气到,拍序号不缺
  for (let f = 1; f <= 70; f++) assert.equal(notePlayBeat(run, f / FPS, FPS), "continuous");
  assert.equal(run.breaks, 0);
  assert.equal(enteredNaturally(run, 59), true);
});

test("ST-C-06 拍序号真跳了(差 > 1)算断开:落点及之前挂载的卡算从中间开始,之后挂载的仍是自然进场", () => {
  const run = createPlayRun();
  notePlayStart(run, 0, FPS);
  for (let f = 1; f <= 55; f++) notePlayBeat(run, f / FPS, FPS);
  // 55 → 62:跨过了挂载帧 59
  assert.equal(notePlayBeat(run, 62 / FPS, FPS), "break");
  assert.equal(run.startFrame, 62);
  assert.equal(enteredNaturally(run, 59), false);
  assert.equal(enteredNaturally(run, 62), false, "落点那一帧挂上的也不算");
  for (let f = 63; f <= 80; f++) notePlayBeat(run, f / FPS, FPS);
  assert.equal(enteredNaturally(run, 70), true);
});

test("ST-C-07 回退(播放中往回跳)算断开;同一拍重复报(武装停那一拍)不算", () => {
  const run = createPlayRun();
  playFrames(run, 0, 80);
  assert.equal(notePlayBeat(run, 80 / FPS, FPS), "repeat");
  assert.equal(run.breaks, 0);
  assert.equal(enteredNaturally(run, 59), true);
  assert.equal(notePlayBeat(run, 40 / FPS, FPS), "break");
  assert.equal(enteredNaturally(run, 30), false);
});

test("ST-C-08 没起播过(不知道起点):一律不算自然进场,走原来的路;第一拍当起点", () => {
  const run = createPlayRun();
  assert.equal(enteredNaturally(run, 59), false);
  assert.equal(notePlayBeat(run, 60 / FPS, FPS), "break");
  assert.equal(enteredNaturally(run, 59), false);
  for (let f = 61; f <= 70; f++) notePlayBeat(run, f / FPS, FPS);
  assert.equal(enteredNaturally(run, 65), true);
});

test("ST-C-09 接缝:播放态互换换上来的新舞台从 T 接着报拍,算连续、起点不变", () => {
  const run = createPlayRun();
  playFrames(run, 30, 40);
  // 旧舞台的第 41～44 拍没到父页(换角色时被过滤),新舞台在 T = 45 精确
  notePlaySeam(run, 45 / FPS, FPS);
  assert.equal(run.startFrame, 30);
  assert.equal(notePlayBeat(run, 46 / FPS, FPS), "continuous");
  for (let f = 47; f <= 70; f++) notePlayBeat(run, f / FPS, FPS);
  assert.equal(enteredNaturally(run, 59), true);
  assert.equal(enteredNaturally(run, 20), false, "起播前就挂着的仍是从中间开始");
});

test("ST-C-10 还没走到的挂载帧不算(那张卡此刻还没挂上)", () => {
  const run = createPlayRun();
  playFrames(run, 0, 50);
  assert.equal(enteredNaturally(run, 59), false);
});

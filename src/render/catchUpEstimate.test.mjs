/**
 * K3(b) 追帧代价按播放位置估（pinned 渲染 4）。跑：node --test src/render/catchUpEstimate.test.mjs
 *
 * 钉四件事：
 *   1. 公式就是 `frames × t_oc`，`t_oc` 优先取单帧最差 `stepMaxMs`；
 *   2. 没有 `stepMaxMs` 时退回 p90 的 `stepMs`；
 *   3. 位置估算封顶在整段 `catchUpMs` 上（`t_oc` 是单帧最差，乘满整段比实测还悲观）；
 *   4. 算不出位置（帧数 0 / 没有单帧成本）就退回整段代价。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { catchUpEstimateMs, playingLeadMs, sceneCatchUpCost } from './catchUpEstimate.mjs';

test('按位置估：frames × stepMaxMs', () => {
  // 60 秒、30 fps 的长 motion：整段 1800 帧 × 2 ms = 3600 ms;播放头在第 2 秒 = 60 帧
  const record = { catchUpMs: 3600, stepMaxMs: 2, stepMs: 1 };
  assert.equal(catchUpEstimateMs(record, 60), 120, '只追入点到此刻那 60 帧');
  assert.equal(catchUpEstimateMs(record, 300), 600);
});

test('没有单帧最差就用 stepMs（p90）', () => {
  assert.equal(catchUpEstimateMs({ catchUpMs: 3600, stepMs: 1.5 }, 100), 150);
});

test('封顶在整段代价上', () => {
  // 位置估算 1800 × 2 = 3600 > 实测整段 1200：取整段那个
  assert.equal(catchUpEstimateMs({ catchUpMs: 1200, stepMaxMs: 2 }, 1800), 1200);
});

test('算不出位置就退回整段代价', () => {
  assert.equal(catchUpEstimateMs({ catchUpMs: 900, stepMaxMs: 2 }, 0), 900, '刚好在入点上');
  assert.equal(catchUpEstimateMs({ catchUpMs: 900, stepMaxMs: 2 }, -5), 900, '播放头在入点之前');
  assert.equal(catchUpEstimateMs({ catchUpMs: 900 }, 60), 900, '没有任何单帧成本');
  assert.equal(catchUpEstimateMs({ catchUpMs: 900, stepMaxMs: 2 }, NaN), 900);
});

test('什么都没有回 0，交给调用方兜底', () => {
  assert.equal(catchUpEstimateMs(null, 60), 0);
  assert.equal(catchUpEstimateMs(undefined, 60), 0);
  assert.equal(catchUpEstimateMs({}, 60), 0);
});

test('随机访问卡（catchUpMs 为 0）不会凭空估出一个代价', () => {
  assert.equal(catchUpEstimateMs({ catchUpMs: 0, stepMs: 0 }, 300), 0);
});

test('整场景:积压是场上每张卡从 max(入点, 起推点) 推到 t 的和,速率是此刻活跃的卡单帧代价(与积压同一个数)之和 × fps', () => {
  const entries = [
    { start: 0, end: 10, record: { stepMs: 2, stepMaxMs: 3, catchUpMs: 200 } },   // 30 帧 × 3 = 90
    { start: 0, end: 10, record: { stepMs: 40, stepMaxMs: 60 } },                 // 30 帧 × 60 = 1800;速率同样按 stepMaxMs 60
    { start: 0, end: 0.5, record: { stepMs: 40 } },                               // 已出场:0～0.5 秒 15 帧 × 40 = 600,不进速率
    { start: 0.5, end: 10, record: null },                                        // 没有记录:0
  ];
  const { backlogMs, ratePerSec } = sceneCatchUpCost(entries, 1, 30);
  assert.equal(backlogMs, 90 + 1800 + 600);
  assert.equal(ratePerSec, (3 + 60) * 30);
  assert.deepEqual(sceneCatchUpCost([], 1, 30), { backlogMs: 0, ratePerSec: 0 });
  // 只有整段代价的卡:积压取整段,速率按整段均摊(10 秒 300 帧、1200 ms → 每帧 4 ms → 120 ms/秒)
  assert.deepEqual(sceneCatchUpCost([{ start: 0, end: 10, record: { catchUpMs: 1200 } }], 1, 30), { backlogMs: 1200, ratePerSec: 120 });
});

test('领先量:积压 ÷ (1 − 速率 / 1000);后台推 1 秒时间线要 1 秒以上就追不上(null)', () => {
  assert.equal(playingLeadMs(90, 0), 90);
  assert.equal(playingLeadMs(390, 360), 390 / 0.64);
  assert.equal(playingLeadMs(90, 1000), null);
  assert.equal(playingLeadMs(90, 10800), null, 'C10-A4 探针那台戏:9 张 40 ms/帧的重卡');
});

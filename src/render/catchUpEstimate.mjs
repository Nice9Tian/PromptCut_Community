/**
 * K3(b)「实际要追多少」的估算（pinned 渲染 4）。纯函数，单独一个文件是为了能单测 ——
 * `stageSwap.ts` 那一侧要卡片注册表和 store，拿不进 `node --test`。
 *
 * # 公式
 *
 *   `t_c = (t − t_start) × FPS × t_oc`
 *
 * 长 motion 走的是**虚拟时间**：播放头此刻踩在它身上的第几帧，就只要追这么多帧。
 * `t_oc` 是单帧最差耗时 —— K1 探针量的正是「推帧过程中最慢一帧」（`stepMaxMs`），
 * 没有这个数就退回 p90 的 `stepMs`。
 *
 * # 为什么不直接用整段 `catchUpMs`
 *
 * 整段 `catchUpMs` 是「从第 0 帧冲到**最后一帧**」的总代价（pinned 渲染 3 末句，K2 用它
 * 判轻重）。播放头刚进入一个 60 秒的片段时按它估，K5 第二路的目标拍 `T` 会被推出去好几秒：
 * 可见舞台白等，那张卡在 `suppressed` 里多透明一大截，而后台其实几十毫秒就补完了。
 *
 * # 封顶
 *
 * 位置估算**取不过整段代价**：`t_oc` 是单帧最差，乘满整段会比实测的整段总代价还悲观。
 * 算不出位置（没有 `t_oc`、或帧数为 0）就退回整段代价。
 *
 * **只影响「追多少」这个实际取值**：K2 的轻重分派仍按整段最差判（`clipWeight` 不受影响）。
 */

/**
 * 一张卡在播放位置 `frames`（= `(t − t_start) × fps`，已推进的帧数）上的补跑代价估计（毫秒）。
 *
 * @param {{ catchUpMs?: number, stepMaxMs?: number, stepMs?: number } | null | undefined} record K1 的成本记录
 * @param {number} frames 从入点到此刻的帧数
 * @returns {number} 毫秒；没有任何可用的数就回 0（调用方自己兜底）
 */
export function catchUpEstimateMs(record, frames) {
  const whole = Number(record?.catchUpMs) || 0;
  const perFrame = Number(record?.stepMaxMs) || Number(record?.stepMs) || 0;
  const n = Number(frames);
  const steps = Number.isFinite(n) && n > 0 ? n : 0;
  const byPosition = perFrame > 0 && steps > 0 ? steps * perFrame : 0;
  if (byPosition <= 0) return whole;
  return whole > 0 ? Math.min(byPosition, whole) : byPosition;
}

/**
 * **整场景**补跑的代价（K3(b) 播放态互换的估时）。
 *
 * 后台舞台补跑是 `render(T, { jump: true })`：此刻活跃的卡全部重挂载，时钟从它们里最早的入点起
 * **整台戏**逐帧推到 `T`。后台舞台没有分派表，判重的卡在那里同样活渲 —— 所以要花的墙钟不是
 * 那张轻卡自己的追帧代价，而是这段时间里场上每张卡各自推帧代价的**和**（C10-A4 实测：
 * 一张 90 ms 的轻卡带着 9 张 40 ms/帧的重卡，补到 1.03 秒用了 11 秒）。
 *
 * @param {{ start: number, end: number, record?: object | null }[]} entries 场上的卡片段（不分轻重）
 * @param {number} t 播放头此刻（秒）
 * @param {number} fps
 * @param {(entry: { start: number, end: number }, t: number) => boolean} [activeAt] 这一刻挂没挂载（缺省按入点、出点判）
 * @returns {{ backlogMs: number, ratePerSec: number }}
 *   - `backlogMs`：从起推点（此刻活跃的卡里最早的入点）推到 `t` 的墙钟。每张卡从 max(入点, 起推点)
 *     推到 min(出点, t)，按 `catchUpEstimateMs` 估（和单卡同一个公式、同样封顶在整段代价上）；
 *   - `ratePerSec`：`t` 之后每多推 1 秒时间线要多花的墙钟（毫秒）＝ Σ(此刻活跃的卡的单帧代价) × fps。
 *     单帧和积压用**同一个数**（`stepMaxMs`，没有才退回 `stepMs`），积压与速率才是同一把尺子。
 *     实测（c10-browser-probe，PC）：按 `stepMaxMs` 估的积压 10982 ms 对上实测的 11 秒补跑；
 *     按 p90 `stepMs` 算的速率只有实测推帧速度的约九分之一。
 */
export function sceneCatchUpCost(entries, t, fps, activeAt = (e, sec) => sec >= e.start && sec < e.end) {
  const f = Math.max(1, Number(fps) || 30);
  const list = Array.isArray(entries) ? entries : [];
  const active = list.filter((e) => activeAt(e, t));
  if (!active.length) return { backlogMs: 0, ratePerSec: 0 };
  const from = Math.min(...active.map((e) => e.start));
  let backlogMs = 0;
  for (const e of list) {
    const lo = Math.max(e.start, from);
    const hi = Math.min(e.end, t);
    if (!(hi > lo)) continue;
    backlogMs += catchUpEstimateMs(e.record, (hi - lo) * f);
  }
  let ratePerSec = 0;
  for (const e of active) {
    const clipFrames = (e.end - e.start) * f;
    // 没有单帧数、只有整段代价的记录:按整段均摊到每帧(积压那一侧 catchUpEstimateMs 对它直接取整段)
    const perFrame = Number(e.record?.stepMaxMs) || Number(e.record?.stepMs)
      || (clipFrames > 0 ? (Number(e.record?.catchUpMs) || 0) / clipFrames : 0);
    ratePerSec += perFrame * f;
  }
  return { backlogMs, ratePerSec };
}

/**
 * 播放态互换的目标拍要领先播放头多少毫秒；追不上回 `null`。
 *
 * 后台舞台先要补完 `backlogMs`，这期间可见舞台按 1 秒 / 秒往前走，后台每多推 1 秒时间线又要多花
 * `ratePerSec` 毫秒。领先 L 要满足 L ＝ backlog ＋ rate × L / 1000，即 L ＝ backlog ÷ (1 − rate / 1000)。
 * `rate ≥ 1000`（后台推 1 秒时间线就要 1 秒以上墙钟）时后台永远追不上可见舞台，没有这样的 L。
 *
 * @param {number} backlogMs
 * @param {number} ratePerSec
 * @returns {number | null}
 */
export function playingLeadMs(backlogMs, ratePerSec) {
  const backlog = Math.max(0, Number(backlogMs) || 0);
  const rate = Math.max(0, Number(ratePerSec) || 0);
  if (rate >= 1000) return null;
  return backlog / (1 - rate / 1000);
}

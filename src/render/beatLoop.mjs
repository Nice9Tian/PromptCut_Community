/**
 * K4 节拍循环和 K6 一秒窗口里的纯算那一半。循环本身（等真帧、推时钟、post 事件）
 * 留在 `StageView.tsx` 的闭包里；拆到这里是为了能 `node --test` —— `StageView.tsx`
 * 带 JSX 和卡片注册表，进不了 node。
 */
import { pipelineAt } from './pipelinePlan.mjs';

/** K6 的窗口长度(ms) */
export const K6_WINDOW_MS = 1000;

/**
 * 第 `n` 拍（从 1 数）落在哪一秒。拍序号按帧格算，`sec` 一律是 `帧号 / fps` ——
 * 连续累加浮点会飘。走到或越过片尾就是最后一拍，`sec` 钳在 `duration` 上。
 *
 * @param {number} fromFrame 起播那一帧（`Math.round(fromSec × fps)`）
 * @param {number} n 拍序号，从 1 起
 * @param {number} fps
 * @param {number} duration 项目总时长（秒）
 * @returns {{ sec: number, frame: number, ended: boolean }}
 */
export function beatAt(fromFrame, n, fps, duration) {
  const frame = fromFrame + n;
  const rawSec = frame / fps;
  const ended = rawSec >= duration - 1e-9;
  return { sec: ended ? duration : rawSec, frame, ended };
}

/**
 * 一拍的活干完之后，下一拍的绝对时刻。**慢帧就等**：只有这一拍的活本身超过了
 * `nextDue` 才把时间轴整体后移（`playStart += 超出量`），不补、不跳帧、不往前冲；
 * 没超就原样返回，由调用方等到 `nextDue`。
 *
 * @param {number} playStart 起播的真墙钟（可能已被前面的慢拍后移过）
 * @param {number} n 刚做完的拍序号
 * @param {number} period 一拍的毫秒数（`1000 / fps`）
 * @param {number} workEnd 这一拍的活干完的真墙钟
 * @returns {{ playStart: number, nextDue: number, late: boolean }}
 */
export function scheduleNextBeat(playStart, n, period, workEnd) {
  const nextDue = playStart + n * period;
  if (workEnd > nextDue) return { playStart: playStart + (workEnd - nextDue), nextDue, late: true };
  return { playStart, nextDue, late: false };
}

/**
 * @typedef {{ at: number, over: number, byClip: Map<string, number> }} K6Beat
 * @typedef {{ beats: K6Beat[], pending: ReadonlySet<string> }} K6State
 */

/** @returns {K6State} */
export function createK6State() {
  return { beats: [], pending: new Set() };
}

/**
 * 记一拍的账（K6），并判这一刻要不要降级。**只降不升**。
 *
 * - **超时**只算每拍耗时超出 1/fps 的那一部分；窗口只留最近 `K6_WINDOW_MS` 毫秒。
 * - **`pending`（已降级、死素材还没就绪）的卡这一拍的耗时不计入超时**，也不当候选：
 *   它照常活渲、照常把这一拍拖慢，要是还算进去，窗口每秒都爆、每秒再降一张，
 *   直到轻管线为空。
 * - 窗口里至少两拍、累计超时 > 1/fps，就把本窗口**实测**累计耗时最大的那张**轻卡**
 *   降级（重卡本来就在贴死素材，降它没有意义）；同分按 clipId 定序。
 * - 降了一张就清空窗口：下一张要重新攒够超时才降，不然一秒之内会连降好几张。
 *
 * 直接改 `state`。回要降的那张 clipId，没有就 `null`。
 *
 * @param {K6State} state
 * @param {{ at: number, beatCost: number, byClip: Map<string, number>, fps: number, sec: number, plan: any }} beat
 * @returns {string | null}
 */
export function noteK6Beat(state, { at, beatCost, byClip, fps, sec, plan }) {
  let excused = 0;
  for (const id of state.pending) excused += byClip.get(id) ?? 0;
  const over = Math.max(0, beatCost - excused - 1000 / fps);
  const beats = state.beats;
  beats.push({ at, over, byClip: new Map(byClip) });
  while (beats.length && at - beats[0].at > K6_WINDOW_MS) beats.shift();

  if (beats.length < 2) return null;
  let totalOver = 0;
  for (const b of beats) totalOver += b.over;
  if (totalOver <= 1000 / fps) return null;
  const total = new Map();
  for (const b of beats) {
    for (const [id, ms] of b.byClip) {
      if (state.pending.has(id)) continue;
      if (pipelineAt(plan, id, sec) !== 'light') continue;
      total.set(id, (total.get(id) ?? 0) + ms);
    }
  }
  let worst = null;
  let worstMs = 0;
  for (const id of [...total.keys()].sort()) {
    const ms = total.get(id);
    if (ms > worstMs) { worst = id; worstMs = ms; }
  }
  if (!worst) return null;
  state.pending = new Set([...state.pending, worst]);
  state.beats = [];
  return worst;
}

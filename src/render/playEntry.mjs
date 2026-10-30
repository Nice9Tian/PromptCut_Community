/**
 * 这一轮播放里，播放头是不是逐拍走过了某张卡的挂载帧（「自然进场」），还是从它中间开始播的。
 *
 * 为什么要分：播放态互换（K3(b)，`src/editor/stageSwap.ts` 的 `runPlayingSwap`）是给「推不动子树虚拟时间、
 * 只认全局时钟」的轻卡（`vtOk = false` 的 (b) 档）补状态用的。连续播放中自然进场的这类卡，可见舞台按全局
 * 时钟逐拍推、它在自己的挂载帧挂上，状态本来就对（和导出一样逐帧推过去）；只有从它中间开始播放
 * （跳到卡中间再播、打开页面就停在卡中间再播、暂停后在卡中间继续播）时，它的状态才来自暂停态的定位，
 * 才需要整场景补跑后互换（`AGENT-pause-precise.md`「没做的与观察」第 1 条）。
 *
 * # 规则（纯状态机，浏览器与 Node 同一份）
 *
 * - **起播**（`notePlayStart`）：这一轮播放从 `fromSec` 那一帧起。起播那一帧的画面来自暂停态（`setTime` 定位，
 *   或暂停态第二路互换），那一刻已经挂着的卡算「从中间开始」。
 * - **一拍**（`notePlayBeat`）：可见舞台每报一拍（`frame` 事件），拍序号按 `round(sec × fps)` 算。
 *   - 恰好比上一拍多 1：连续。
 *   - 与上一拍相同：重复报（例如武装停那一拍），不算断。
 *   - 跳了（差 > 1）或回退：**断开**，从落点重新起算，落点当新的起点。
 * - **掉帧不算断**：主线程卡住时可见舞台是「慢帧就等」——这一拍变长、时间轴整体后移，不跳拍号
 *   （`StageView.tsx` 的 `runBeatLoop`、`beatLoop.mjs` 的 `scheduleNextBeat`），父页收到的拍序号仍逐一递增，
 *   只是到得晚；卡片的时钟也仍是一拍一拍推过去的。所以连续与否只看拍序号，不看墙钟间隔。
 *   拍序号真跳了（例如播放中跳转、换了舞台而没接上）才算断。
 * - **接缝**（`notePlaySeam`）：播放态互换换上来的新可见舞台在 `T` 那一帧是整场景补跑出来的精确状态，
 *   从 `T` 接着报拍，算连续（起点不变）。
 * - **自然进场**（`enteredNaturally`）：起点之后才挂载的卡（挂载帧 > 起点）。挂载帧 = 起点的不算：起播那一刻它已经挂着，
 *   状态来自暂停态定位（例如往回跳到挂载帧时组件实例没换、保留着跳之前的状态），照旧按估时决定。
 *   还没起播过（不知道起点）一律不算自然进场，走原来的路。
 */

/** @param {number} sec @param {number} fps */
function frameOf(sec, fps) {
  const rate = Math.max(1, Number(fps) || 30);
  return Math.round((Number(sec) || 0) * rate);
}

/** @returns {{ startFrame: number | null, lastFrame: number | null, breaks: number }} */
export function createPlayRun() {
  return { startFrame: null, lastFrame: null, breaks: 0 };
}

/**
 * 这一轮播放从 `fromSec` 起（按下播放、换了舞台重起节拍）。直接改 `run`。
 * @param {{ startFrame: number | null, lastFrame: number | null, breaks: number }} run
 * @param {number} fromSec
 * @param {number} fps
 */
export function notePlayStart(run, fromSec, fps) {
  const f = frameOf(fromSec, fps);
  run.startFrame = f;
  run.lastFrame = f;
}

/**
 * 可见舞台报来一拍。直接改 `run`，回这一拍算什么。
 * @param {{ startFrame: number | null, lastFrame: number | null, breaks: number }} run
 * @param {number} sec
 * @param {number} fps
 * @returns {'continuous' | 'repeat' | 'break'}
 */
export function notePlayBeat(run, sec, fps) {
  const f = frameOf(sec, fps);
  if (run.lastFrame !== null && f === run.lastFrame + 1) {
    run.lastFrame = f;
    return 'continuous';
  }
  if (run.lastFrame !== null && f === run.lastFrame) return 'repeat';
  // 没起播过（不知道起点）、跳拍或回退：从落点重新起算
  run.startFrame = f;
  run.lastFrame = f;
  run.breaks++;
  return 'break';
}

/**
 * 可见舞台在 `sec` 那一帧的状态是整场景精确的（播放态互换换上来的新舞台），之后从这一帧接着报拍。
 * 起点不变；还没起播过就以这一帧为起点。
 * @param {{ startFrame: number | null, lastFrame: number | null, breaks: number }} run
 * @param {number} sec
 * @param {number} fps
 */
export function notePlaySeam(run, sec, fps) {
  const f = frameOf(sec, fps);
  if (run.startFrame === null || f < run.startFrame) run.startFrame = f;
  run.lastFrame = f;
}

/**
 * 挂载帧为 `mountFrame` 的卡，在这一轮播放里是不是自然进场（起点之后逐拍走到它的挂载帧）。
 * @param {{ startFrame: number | null, lastFrame: number | null }} run
 * @param {number} mountFrame
 */
export function enteredNaturally(run, mountFrame) {
  if (run.startFrame === null || run.lastFrame === null) return false;
  if (!Number.isFinite(mountFrame)) return false;
  return mountFrame > run.startFrame && mountFrame <= run.lastFrame;
}

/**
 * K5 第二路：`vtOk = false` 的卡（Motion 的 JS 驱动动画）整场景在后台补跑之后**互换角色**。
 *
 * 为什么非得整场景：`advanceToAsync` 改的是模块级的 `now`、`pinAnimations` 的 `sync` 钉全部动画，
 * 而这类卡的 JS 动画只认全局帧时间戳。单张卡用子树虚拟时间推不动它（那正是 `vtOk` 要测的），
 * 所以只能让后台舞台把整台戏从最早的 `mountFrameOf` 补到 `t`，再把两个 iframe 的身份对调。
 *
 * # 顺序（E0 / K5，一步都不许省）
 *
 *  1. `setRole('back', { job: 'catchup' })`（经 `stageJobs` 的单飞队列：**补跑 > 页面侧测量 > 探针**，
 *     排进去就等于让探针让路）→ `pushProject('back', 当前项目, { reset: true })`
 *     —— 探针可能把后台舞台换成了缩水项目，直接发 `setProject` 会绕过 `stageBridge` 的基线；
 *  2. `render(t, { jump: true, maxCatchUp: Infinity })`（不传 `maxCatchUp` 的话
 *     `DEFAULT_MAX_CATCH_UP = 6000` 会削掉起点）；
 *  3. `setMediaT(t)`，等 `{ type: 'mediaReady' }`，最多 300 ms，超时照样换；
 *  4. **互换**：先在一次 React 提交里对调两个 iframe 的可见性（父页的「当前 front」指针同一刻切过去），
 *     **再** `oldFront.setRole('back')` 并等回包，**最后** `back.setRole('front')`；
 *  5. 对新 `front` 补发 `setPlan`（它作为 `back` 时没有表）/ `setLocalHashes` /
 *     `setSnapshots(new Map(), { reset: true })` / `setPlaying(false)` / `setScrubbing(false)` / `setProxy`；
 *  6. 新 `front` post `{ type: 'settled', sec, clipIds: [] }`（舞台侧在 `setRole('front')` 里做）。
 *
 * # 播放态互换（K3(b)）
 *
 * 目标不是 `store.t` 而是**目标拍 `T`**（= `store.t` + 预估补跑时长，取整到拍格；预估按播放位置
 * 算，见 `guessCatchUpMs`）：(1)(2)(3) 的实参
 * 全部是 `T`（拿 `store.t` 会让互换后新 `front` 的 `mediaT` 偏差约一秒、必走硬 seek）。补完之后对
 * 旧 `front` 发 `pause({ atSec: T })` **武装停**，收到 `frame.sec === T`（按拍序号比，不比浮点）
 * 再做 (4)(5)，(5) 末尾改成 `play(T)` + `setPlaying(true)`。可见舞台先走到了 `T`（回 `passed`）
 * 就重取 `T' = store.t + 上次预估 × 2`，对 `back` 续推（不带 `jump`）再武装一次；两次仍追不上按 K6 降级。
 *
 * 只给**从卡中间开始播放**的卡发起：这一轮播放中逐拍走过挂载帧、自然进场的卡不发起（`playingSwapTargets`，
 * 规则见 `src/render/playEntry.mjs`）。
 */
import { getState } from "../store/project";
import { flattenOverlay, type Project } from "../kernel/project";
import { cutOf } from "../kernel/cutSegments";
import { flatPlanProject, isFlatClipId } from "../kernel/cutFlatten.mjs";
import { cardMountedAt, mountFrameOf } from "../render/frameWindow.mjs";
import { createPlayRun, enteredNaturally, notePlayBeat, notePlaySeam, notePlayStart } from "../render/playEntry.mjs";
import { catchUpEstimateMs, playingLeadMs, sceneCatchUpCost } from "../render/catchUpEstimate.mjs";
import { clipWeight, pipelineAt } from "../render/pipelinePlan.mjs";
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import type { StageEvent, StageRpcClient } from "../render/stageRpc";
import { backStage, frontStage, onStageEvent, pushProject, syncProject } from "./stageBridge";
import { runBackJob } from "./stageJobs";
import { currentCosts, currentPlan, currentTuning, sendPlanTo } from "./planDispatch";
import { clipIdentityOf } from "./costIdentity";
import { clearSettled, markAllSettled, markBaselineReset, setExtraSuppressed, streamPlanesAt, suppressedAt } from "./snapshotFeed";
import { onStageDemote } from "./demote";

/** K5 (3)：等后台舞台的素材层画出一帧，最多等这么久（真墙钟），超时照样换 */
export const MEDIA_READY_TIMEOUT_MS = 300;
/** K3(b)：没有 `catchUpMs` 时预估的补跑时长 */
export const DEFAULT_CATCHUP_GUESS_MS = 1000;
/** K3(b)：武装停等 `frame(T)` 的兜底 */
export const ARM_WAIT_TIMEOUT_MS = 5000;

export interface SwapHost {
  /**
   * 把「谁是可见舞台」切到另一个 iframe：一次 React 提交里对调可见性，并在 `stageBridge`
   * 里重新登记两个角色。回互换之后的两个客户端。
   *
   * 后台 iframe 只能用 `opacity: 0; pointer-events: none` 藏，**禁止 `display: none` /
   * `visibility: hidden`**：整份 OOPIF 退出渲染树之后 `requestVideoFrameCallback` 不再回调，
   * 第 (3) 步的 `mediaReady` 就只能等到超时。
   */
  swapRoles(): { front: StageRpcClient | null; back: StageRpcClient | null } | null;
  /** 当前实体模式（互换后要对新 `front` 重发 —— 它作为 `back` 时是默认值） */
  proxy(): boolean;
  /** A1 的本地素材哈希表 */
  localHashes(): string[];
  /**
   * 只有一个舞台(在线页面舞台闸门第一级、最低一档、握手失败退回):没有后台舞台,暂停后追到活渲再互换的这几条路一律不走,
   * 停下时由可见舞台逐层追一帧(`settleLayers`)。不给 = 双舞台。
   */
  singleStage?(): boolean;
}

/** 诊断:最近几次暂停态第二路的结果(探针看) */
const swapLog: { at: number; t: number; stale: number; ready: boolean; swapped: boolean; error?: string }[] = [];
export function stageSwapDebug() {
  return swapLog.slice();
}
/** 诊断:暂停态第二路每次进门、判据与出门的原因(C10-A4 排障;探针看) */
const swapTrace: Record<string, unknown>[] = [];
function trace(entry: Record<string, unknown>): void {
  swapTrace.push({ at: Math.round(performance.now()), ...entry });
  if (swapTrace.length > 40) swapTrace.shift();
}
export function stageSwapTrace() {
  return swapTrace.slice();
}
/** 诊断:按卡说明 `staleOnBackCatchUp` 为什么收 / 不收它 */
export function staleExplain(project: Project, t: number): Record<string, unknown>[] {
  const plan = currentPlan();
  const fps = Math.max(1, project.fps || 30);
  const { identityKeys, frameModes } = clipIdentityOf(project);
  return activeCardClips(project, t).map((clip) => {
    const record = recordOf(project, clip.id);
    let tier: string | undefined;
    try { if (record) tier = clipWeight(record, frameModes[clip.id], fps, currentTuning()).tier; } catch { tier = "error"; }
    return { id: clip.id.slice(0, 8), pipeline: pipelineAt(plan, clip.id, t) ?? null, key: identityKeys[clip.id]?.slice(0, 10) ?? null, record: !!record, vtOk: record?.vtOk, tier };
  });
}

/** 此刻是不是只有一个舞台(宿主说了算;没有宿主 = 双舞台) */
export function swapBlockedBySingleStage(): boolean {
  try { return host?.singleStage?.() === true; } catch { return false; }
}

let host: SwapHost | null = null;
export function setSwapHost(next: SwapHost | null): void {
  host = next;
}

/** 正在跑的那一次（同时只能有一次：后台舞台只有一台） */
let running = false;
/** 诊断:占着 `running` 的是哪一路 */
let runningKind: "settle" | "playing" | null = null;
/** 上一次的预估补跑时长（K3(b) 第二次翻倍） */
let lastGuessMs = 0;
/** 第二路正在跑时又来的 settle：只记**最后**那一次，当前这次结束后补做（R5-15） */
let pendingSettleT: number | null = null;
/** 占着 `running` 的是第几次（让路之后旧的那一次收手时不能再动 `running`） */
let runSeq = 0;
let owner = 0;
/**
 * 正在跑的播放态互换的中止开关。停下时（暂停 / 点击 / 拖动松开 / 播放到头）暂停态第二路拿它
 * **抢断**播放态补跑，不等它自己收手（C10-A4 后续）。进了互换那一步（`swapAndDress`）就置空、
 * 不再可抢 —— 换到一半的新 `front` 还没穿戴好，让它换完，停下那一次照 R5-15 在收手时补做。
 */
let playingAbort: AbortController | null = null;
/** 诊断:让路的次数与最近一次 */
let preemptCount = 0;
/**
 * 被抢断时后台舞台上还在跑的补跑 `render`（父页已经不等它的回包了）。暂停态第二路的第 (1) 步
 * `pushProject(reset)` 会在舞台下一次让出时把它掐成 `'project'`；这一刻没有要补跑的卡时，
 * 由 `abortOrphanRender` 单独掐一次，免得它在后台白推十几秒。
 */
let orphanRender: Promise<unknown> | null = null;

/** `p` 与中止信号赛跑：信号先到回 `null`（不等 `p`） */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

/** 记下没人等的补跑 `render`：它落定（推完或被掐）就不再算孤儿 */
function markOrphan(p: Promise<unknown>): void {
  orphanRender = p;
  const clear = () => { if (orphanRender === p) orphanRender = null; };
  p.then(clear, clear);
}

/**
 * 掐掉后台舞台上没人等的补跑。排在 `catchup` 档（探针让路）；`pushProject(reset)` 让舞台在下一次
 * 让出时把在飞的 `render` 回成 `'project'`（`job: 'catchup'` 期间一律丢弃，不重发）。
 * 这份项目本来就是当前项目，之后探针要缩水项目时照常自己重灌。
 */
async function abortOrphanRender(project: Project): Promise<void> {
  // 不在这里先看 `orphanRender`:刚抢断的那一刻,被抢的那个活还没来得及记下它;排在它后面的这个活开工时就记下了
  await runBackJob("catchup", async (ctx) => {
    if (!orphanRender || !ctx.stage || ctx.stage === frontStage()) return;
    trace({ op: "orphan-abort" });
    await pushProject("back", project, { reset: true });
  });
}

export function swapInFlight(): boolean {
  return running;
}

/* ------------------------------------------------------------------ 判据 */

/** 这一刻活跃的卡片段 */
function activeCardClips(project: Project, t: number) {
  const out: { id: string; start: number; end: number }[] = [];
  for (const tr of project.tracks) {
    if (tr.hidden) continue;
    for (const clip of tr.clips) {
      if (!clip.cardId && !clip.nodeId) continue;
      if (cardMountedAt(clip, t)) out.push(clip);
    }
  }
  return out;
}

/** clipId → 这张卡的 K1 记录（`costs` 按 `identityKey` 索引，记录里没有 clipId） */
function recordOf(project: Project, clipId: string): CardCostRecord | undefined {
  const key = clipIdentityOf(project).identityKeys[clipId];
  if (!key) return undefined;
  return currentCosts().find((r) => r.identityKey === key);
}

/**
 * 此刻挂着、要按历史推进的**剪辑段**(`kernel/cutSegments.ts`)。它们不是注册表里的卡,没有成本记录、不进分派表,
 * 舞台的子树虚拟时间推不动里面那些按全局时钟走的卡,所以跳转、从段中间开始播放都要整场景在后台补跑后互换
 * (和 `vtOk = false` 的卡同一条第二路)。停在挂载帧上的不用补。
 */
export function statefulSegmentsAt(project: Project, t: number): { id: string; start: number; end: number }[] {
  const fps = Math.max(1, project.fps || 30);
  const frame = Math.round(t * fps);
  return flattenOverlay(project).clips.filter((c) => cutOf(c)?.frameMode === "stateful" && cardMountedAt(c, t) && frame > mountFrameOf(c, fps));
}

/**
 * 这一刻有没有「判重 + `vtOk = false`」的卡 —— 有就得走第二路（整场景补跑后互换）。
 * 只要有一张，就整场景走（正在自己追的 `vtOk` 卡被整场景结果覆盖，无害）。
 */
export function needsBackCatchUp(project: Project, t: number): string[] {
  const plan = currentPlan();
  const out: string[] = [];
  for (const clip of activeCardClips(project, t)) {
    if (pipelineAt(plan, clip.id, t) !== "heavy") continue;
    const record = recordOf(project, clip.id);
    /*
     * **没有成本记录的卡不走这条路**（K1 末段：兜底分派只用于「新卡还没测完」那几秒）。
     * 没记录时 `clipWeight` 按声明把 stateful 卡一律判重，而 `vtOk` 是 `undefined`——
     * 照「不是 true 就走第二路」读的话，**刚打开一个项目、探针还没测完就会整场景补跑 + 互换**：
     * 实测 `editor-preview-smoke --stage` 里，加两张卡再 `seek` 一下就换了一次身份，
     * 而那时后台舞台正在跑 K1 探针（补跑排在 `catchup` 档，会把探针整体挤掉）。
     * 记录一到 `setPlan` 就会重算，那时该走哪条路自然就定了。
     */
    if (!record) continue;
    if (record.vtOk === true) continue;   // 第一路自己追
    out.push(clip.id);
  }
  /*
   * 剪辑段里判重、贴着自己的流(或占位)的卡(`kernel/cutFlatten.mjs` 的虚拟片段):停下时它在嵌套场景里的活子树还冻在开始抑制那一刻。
   * 舞台的第一路(子树虚拟时间)只认顶层片段,嵌套场景里的卡推不动,所以要按历史推进的那些一律整场景在后台补跑后互换
   * (补跑好之前照旧贴流或占位)。remotion 式的不用补:撤了抑制当场就画对。
   */
  const { frameModes } = clipIdentityOf(project);
  for (const tr of flatPlanProject(project).tracks) {
    if (tr.hidden) continue;
    for (const clip of tr.clips) {
      if (!isFlatClipId(clip.id) || !clip.cardId || !cardMountedAt(clip, t)) continue;
      if (pipelineAt(plan, clip.id, t) !== "heavy" || frameModes[clip.id] === "direct") continue;
      if (clipIdentityOf(project).capabilities.get(clip.id)?.compositing !== "independent") continue;
      if (!recordOf(project, clip.id)) continue;
      out.push(clip.id);
    }
  }
  return out;
}

/**
 * 播放中要等后台补跑的**轻卡**（K3(b) 的 `vtOk = false` 那一支）。
 *
 * 它在 K2 里判轻（各位置都活渲），但整段 `catchUpMs` 超了一拍预算、又推不动子树虚拟时间，
 * 所以播放头进入它时只能整场景在后台补跑后互换。等待期间它进 `front` 的 `suppressed`，舞台在它的位置上显示占位符（T4）。
 */
export function playingCatchUpTargets(project: Project, t: number): string[] {
  const plan = currentPlan();
  const fps = Math.max(1, project.fps || 30);
  const { frameModes } = clipIdentityOf(project);
  const out: string[] = [];
  for (const clip of activeCardClips(project, t)) {
    if (pipelineAt(plan, clip.id, t) !== "light") continue;
    const record = recordOf(project, clip.id);
    // 同 `needsBackCatchUp`：没测过的卡不发起互换
    if (!record) continue;
    if (record.vtOk === true) continue;    // 在可见舞台里自己追（K5 第一路的机制）
    if (clipWeight(record, frameModes[clip.id], fps, currentTuning()).tier !== "catchup-b") continue;
    out.push(clip.id);
  }
  return out;
}

/* ------------------------------------------------------------------ 自然进场与从卡中间开始播放 */

/**
 * 这一轮播放的起点与报到哪一拍了（`src/render/playEntry.mjs`）。播放态互换只给「从卡中间开始播放」的卡：
 * 连续播放中逐拍走过挂载帧、自然进场的 (b) 档 `vtOk = false` 轻卡，可见舞台按全局时钟逐拍推、在自己的挂载帧挂上，
 * 状态本来就对，不发起互换（`AGENT-pause-precise.md`「没做的与观察」第 1 条）。
 */
const playRun = createPlayRun();
/** 诊断：因为自然进场而没发起播放态互换的次数与最近一次 */
let naturalSkips = 0;
let lastNaturalSkip: { t: number; ids: string[] } | null = null;
/** 诊断：这一轮播放里因为自然进场而没发起的卡（完整 clipId；起播时清空） */
let naturalSkipped = new Set<string>();

function projectFps(): number {
  return Math.max(1, getState().project?.fps || 30);
}

/** 按下播放（或换了舞台重起节拍）：这一轮播放从 `fromSec` 起。宿主在发 `play(fromSec)` 之前调 */
export function notePlayRunStart(fromSec: number): void {
  notePlayStart(playRun, fromSec, projectFps());
  naturalSkipped = new Set();
}

/** 可见舞台报来一拍（`frame` 事件）。宿主在算播放态互换的目标之前调；回这一拍算连续、重复还是断开 */
export function notePlayFrame(sec: number): "continuous" | "repeat" | "break" {
  return notePlayBeat(playRun, sec, projectFps());
}

/**
 * 播放中这一拍**要发起**播放态互换的卡：`playingCatchUpTargets` 里去掉这一轮播放中自然进场的。
 * 暂停态第二路（`staleOnBackCatchUp`）不经这里，照旧收全部 (b) 档 `vtOk = false` 的轻卡。
 */
export function playingSwapTargets(project: Project, t: number): string[] {
  const segments = statefulSegmentsAt(project, t);
  const all = [...playingCatchUpTargets(project, t), ...segments.map((c) => c.id)];
  if (!all.length) return all;
  const fps = Math.max(1, project.fps || 30);
  const clipOf = new Map([...activeCardClips(project, t), ...segments].map((c) => [c.id, c]));
  const out: string[] = [];
  const natural: string[] = [];
  for (const id of all) {
    const clip = clipOf.get(id);
    if (clip && enteredNaturally(playRun, mountFrameOf(clip, fps))) natural.push(id);
    else out.push(id);
  }
  if (natural.length) {
    naturalSkips++;
    lastNaturalSkip = { t, ids: natural };
    for (const id of natural) naturalSkipped.add(id);
  }
  return out;
}

/**
 * **暂停 / 点时间轴 / 拖动松开**时要靠后台补跑才能变精确的全部卡（R5-12）。
 *
 * 两类并起来：
 *   - 判**重**且 `vtOk = false` 的（`needsBackCatchUp`）——第二路原本就收它；
 *   - 判**轻**、(b) 档、`vtOk = false` 的（`playingCatchUpTargets`）——舞台的 `routeJump`
 *     对它 `continue`（注释写「第二路由父页发起」），而父页暂停态只看前一类，
 *     于是跳转之后它停在全局 `clock.set` 给出的错误状态上，没有任何一方去补，
 *     违背 pinned 架构 9（暂停时精确活渲）。
 *
 * 第二路本来就是**整场景**补跑再互换，多收这一类不多花一分钱：只是让「只有这类卡过期」
 * 的那一刻也真的走一次互换。
 */
export function staleOnBackCatchUp(project: Project, t: number): string[] {
  return [...new Set([...needsBackCatchUp(project, t), ...playingCatchUpTargets(project, t), ...statefulSegmentsAt(project, t).map((c) => c.id)])].sort();
}

/**
 * 这张卡估计要补跑多久（K3(b) 的目标拍 `T` 用）。
 *
 * **按播放位置估，不再一律用整段最差代价**（pinned 渲染 4；分册 K3(b)「实际要追的帧数按
 * pinned 渲染 4 的公式取播放头落点」）：长 motion 走的是虚拟时间，播放头此刻踩在它身上的
 * 第几帧，就只要追这么多帧 ——
 *
 *   `t_c = (t − t_start) × fps × t_oc`
 *
 * `t_oc` 是单帧最差耗时，取成本记录的 `stepMaxMs`（K1 量的就是「推帧过程中最慢一帧」），
 * 没有就退回 p90 的 `stepMs`。整段 `catchUpMs` 是从第 0 帧冲到**最后一帧**的总代价 ——
 * 播放头刚进入片段时按它估，目标拍 `T` 会被推出去好几秒：可见舞台白等，那张卡在
 * `suppressed` 里多顶着占位符一大截，而 `back` 其实几十毫秒就补完了。
 *
 * 位置估算**封顶在整段代价上**（两者取小）：`t_oc` 是单帧最差，乘满整段会比实测的整段
 * 总代价还悲观。算不出位置（没有 `t_oc`、或拿不到片段）就退回整段代价，都没有就 1 秒。
 *
 * **只改「追多少」这个实际取值**：K2 的轻重分派仍按整段最差判（pinned 渲染 3、
 * `clipWeight` 一个字不动）。
 *
 * **补跑是整场景推的，所以估的是整台戏**（C10-A4 后续）：场上每张卡（判重的也算，后台舞台没有
 * 分派表、整台戏都活渲）各按上面的公式从 max(入点, 起推点) 估到 `t`，加起来。只有目标卡一张时
 * 和以前一样。`clipIds` 只用来判「目标卡有没有数」，都没有就再加 1 秒兜底。
 */
export function guessCatchUpMs(project: Project, clipIds: readonly string[], t: number): number {
  return sceneCostOf(project, clipIds, t).backlogMs;
}

/**
 * 场上全部卡片段（隐藏轨道除外）连同成本记录 —— 后台舞台补跑时整台戏都活渲，判重的卡也推。
 */
function sceneEntries(project: Project) {
  const out: { id: string; start: number; end: number; record: CardCostRecord | undefined }[] = [];
  for (const tr of project.tracks) {
    if (tr.hidden) continue;
    for (const clip of tr.clips) {
      if (!clip.cardId && !clip.nodeId) continue;
      out.push({ id: clip.id, start: clip.start, end: clip.end, record: recordOf(project, clip.id) });
    }
  }
  return out;
}

/**
 * 整场景补跑到 `t` 的积压与此后的推帧速率（`sceneCatchUpCost`）。
 *
 * **同场的重卡一起算**（C10-A4 后续）：以前只按目标轻卡自己的 `catchUpMs` 估，而后台舞台是整台戏
 * 从最早的入点逐帧推，判重的慢卡每帧都要推一遍 —— 实测一张 90 ms 的轻卡带着 9 张 40 ms/帧的重卡，
 * 补到 1.03 秒用了 11 秒，目标拍早被可见舞台走过。
 *
 * 目标卡自己一个数都没有时（没有成本记录，照理不会发起），积压上再加 1 秒的兜底。
 */
function sceneCostOf(project: Project, clipIds: readonly string[], t: number): { backlogMs: number; ratePerSec: number } {
  const fps = Math.max(1, project.fps || 30);
  const entries = sceneEntries(project);
  const { backlogMs, ratePerSec } = sceneCatchUpCost(entries, t, fps, cardMountedAt);
  const known = entries.some((e) => clipIds.includes(e.id) && catchUpEstimateMs(e.record, Math.max(0, t - e.start) * fps) > 0);
  return { backlogMs: backlogMs + (known ? 0 : DEFAULT_CATCHUP_GUESS_MS), ratePerSec };
}

/**
 * 播放态互换发起前的判断：目标拍领先播放头多少；**追不上就不发起**（C10-A4 后续）。
 *
 * 追不上有两种：
 *   - `rate`：后台舞台推 1 秒时间线要花 1 秒以上墙钟（场上的卡每帧加起来超过一拍）—— 可见舞台
 *     按 1 秒 / 秒往前走，后台永远到不了目标拍；
 *   - `past-end`：解出来的目标拍落在这几张目标卡全部出场之后 —— 换过去它们已经不在画面上了。
 *
 * 这两种情况以前也发起互换：整场景补跑白占后台舞台十几秒（测量、认领都得让路），换来的只是
 * 「武装停已过」两次之后的降级。播放中本来就不追精确（`product/rendering.md`「停下就精确」只管停下），
 * 所以这里干脆不发起；停下那一刻暂停态第二路照常把它补成精确活渲。
 */
export function planPlayingSwap(project: Project, clipIds: readonly string[], t: number):
  { ok: true; leadMs: number; backlogMs: number; ratePerSec: number } | { ok: false; reason: "rate" | "past-end"; backlogMs: number; ratePerSec: number; leadMs: number | null } {
  const { backlogMs, ratePerSec } = sceneCostOf(project, clipIds, t);
  const leadMs = playingLeadMs(backlogMs, ratePerSec);
  if (leadMs === null) return { ok: false, reason: "rate", backlogMs, ratePerSec, leadMs };
  let lastEnd = -Infinity;
  for (const tr of project.tracks) for (const clip of tr.clips) if (clipIds.includes(clip.id)) lastEnd = Math.max(lastEnd, clip.end);
  if (t + leadMs / 1000 >= lastEnd) return { ok: false, reason: "past-end", backlogMs, ratePerSec, leadMs };
  return { ok: true, leadMs, backlogMs, ratePerSec };
}

/* ------------------------------------------------------------------ 等事件 */

function waitForEvent(match: (e: StageEvent) => boolean, timeoutMs: number): Promise<StageEvent | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (e: StageEvent | null) => {
      if (done) return;
      done = true;
      off();
      window.clearTimeout(timer);
      resolve(e);
    };
    const off = onStageEvent((e) => { if (match(e)) finish(e); });
    const timer = window.setTimeout(() => finish(null), timeoutMs);
  });
}

/* ------------------------------------------------------------------ 主流程 */

interface BackReady {
  back: StageRpcClient;
  /** 后台舞台补到了哪一秒 */
  atSec: number;
}

/**
 * (1)(2)(3)：把后台舞台补到 `targetSec` 并等它的素材层出一帧。
 * 排进 `stageJobs` 的 `catchup` 档 —— 探针整体让路，掐出来的 `'project'` 一律丢弃（E0 的例外）。
 */
async function catchUpBack(project: Project, targetSec: number, preempt?: AbortSignal): Promise<BackReady | null> {
  // 只有一个舞台:没有后台舞台可以追,一步都不排
  if (swapBlockedBySingleStage()) return null;
  trace({ op: "catchup-queued", t: targetSec });
  return await runBackJob("catchup", async (ctx) => {
    const back = ctx.stage;
    trace({ op: "catchup-start", t: targetSec, back: !!back, sameAsFront: back === frontStage() });
    if (preempt?.aborted) return null;
    if (!back || back === frontStage()) return null;   // legacy 单舞台：没有后台可换
    // (1) 探针可能把它换成了缩水项目，整份重灌并更新 stageBridge 的基线
    await pushProject("back", project, { reset: true });
    if (ctx.signal.aborted || preempt?.aborted) return null;
    // (2) 整场景从最早的 mountFrameOf 补到目标拍。不传 maxCatchUp 会被 6000 ms 削掉起点
    const pending = back.render(targetSec, { jump: true, maxCatchUp: Infinity });
    /*
     * 被抢断(停下了)就**不等这次 render 的回包**,当场把单飞队列让给暂停态第二路:它的第 (1) 步
     * `pushProject(reset)` 会在舞台下一次让出时掐掉这次 render。等回包的话要等舞台把整台戏推到
     * 目标拍(C10-A4 实测约 1.5 秒,重的项目十几秒)。
     */
    const reply = await untilAborted(pending, preempt);
    if (reply === null) { markOrphan(pending); trace({ op: "catchup-preempted", t: targetSec }); return null; }
    trace({ op: "catchup-rendered", t: targetSec, aborted: "aborted" in reply ? reply.aborted : false, reason: (reply as { reason?: string }).reason });
    if ("aborted" in reply && reply.aborted) return null;
    if (ctx.signal.aborted || preempt?.aborted) return null;
    // (3) 素材层也到位（最多等 300 ms，超时照样换）
    const ready = waitForEvent((e) => e.type === "mediaReady", MEDIA_READY_TIMEOUT_MS);
    await back.setMediaT(targetSec);
    await untilAborted(ready, preempt);
    if (preempt?.aborted) return null;
    return { back, atSec: targetSec };
  });
}

/** (4)(5)：互换并把新 `front` 该有的状态补齐 */
async function swapAndDress(sec: number, playing: boolean): Promise<StageRpcClient | null> {
  dressError = null;
  const oldFront = frontStage();
  const swapped = host?.swapRoles();
  if (!swapped?.front) return null;
  const next = swapped.front;
  // 先对调可见性（上一行），**再** oldFront.setRole('back') 并等回包，**最后** back.setRole('front')
  if (oldFront && oldFront !== next) {
    try { await oldFront.setRole("back"); } catch { /* iframe 正在换 */ }
  }
  try { await next.setRole("front"); } catch { return null; }

  /* (5) 它作为 back 时没有表、没有哈希、实体模式是默认值 —— 一条都不能省 */
  const project = getState().project;
  try {
    /*
     * 根因 A:新 `front` 手里是补跑开始时 (1) 灌进去的那一份,补跑期间用户的编辑只推给了当时的 `front`。
     * 基线跟着客户端走(`stageBridge` 的 `swapStageClients`),所以这里补推一次就是**增量**,
     * 被删的片段当场摘掉;没有编辑时基线相同、一条都不发。暂停态和播放态两条互换路都经过这里。
     */
    await syncProject("front", project);
    // 补发分派表:它作为 `back` 时没有(E0 的「角色转正时必须补发」)
    await sendPlanTo("front", { force: true });
    await next.setLocalHashes(host?.localHashes() ?? []);
    if (playing) {
      clearSettled("front", "playing");
      /*
       * 播放态互换：先把三个集合摆好，再 play(T)。**先发流平面、后发抑制**（和 `Preview` 的 `syncPlanes` 同一个顺序）：
       * 舞台收到抑制时已经知道这张卡有流要来，流画出第一帧之前先不藏它补跑出来的精确画面（`StageView` 的 `streamWaiting`）。
       * 反过来发的话，舞台当场藏了活子树，流的第一帧出来之前（约 0.1 秒）这一层是空的。
       */
      await next.setStreamPlanes(streamPlanesAt({ project, t: sec, playing: true }));
      await next.setSuppressed(suppressedAt({ project, t: sec, playing: true }));
      await next.setScrubbing(false);
      await next.setProxy(host?.proxy() ?? false);
      await next.play(sec);
      await next.setPlaying(true);
    } else {
      markBaselineReset("front");
      markAllSettled("front");
      await next.setStreamPlanes(streamPlanesAt({ project, t: sec, playing: false }));
      await next.setSuppressed(suppressedAt({ project, t: sec, playing: false }));
      await next.setPlaying(false);
      await next.setScrubbing(false);
      await next.setProxy(host?.proxy() ?? false);
    }
  } catch (e) { dressError = String((e as Error)?.message ?? e).slice(0, 160); /* iframe 正在换：下一次 setTime 会把状态重新摆一遍 */ }
  return next;
}
let dressError: string | null = null;

/**
 * 暂停态的第二路（K5）：`setTime(t, { settle: true })` 之后，只要有一张判重卡是
 * `vtOk = false` 就走它。
 */
export async function runSettleSwap(t: number): Promise<boolean> {
  /*
   * **运行中来的新请求不丢，记下最后那一个**（R5-15）。以前这里直接 `return false`：
   * 真实地连点时间轴（间隔小于一次补跑的几百毫秒），最后一次点击的位置永远不互换，
   * 判重的 `vtOk = false` 卡就停在快照上。现在当前这一次完成或中止之后，
   * 按最后那一次的 `t` 再做一遍；中间被盖掉的那些本来就不用做。
   */
  // 只有一个舞台:暂停后不经后台舞台追到活渲(停下追一帧由可见舞台逐层做)
  if (swapBlockedBySingleStage()) { trace({ op: "settle", t, out: "single" }); return false; }
  /*
   * **播放态补跑立即让路**(C10-A4 后续):停下时正在跑的若是播放态互换,当场中止它、接过 `running`,
   * 暂停态第二路马上开始,不等它收手。播放态那一次整场景补跑的目标拍是「播放头 + 估时」,停下之后
   * 它推出来的那一拍用不上;以前要等它推完(实测约 1.5 秒)、放掉 `running`,停下那一次才轮得到。
   * 仍在播放(没停)、或它已经进了互换那一步(`playingAbort` 置空)时照旧只记下,由它收手时补做。
   */
  let preempted = false;
  if (running) {
    if (runningKind === "playing" && playingAbort && !getState().playing) {
      trace({ op: "settle", t, out: "preempt" });
      playingAbort.abort();
      playingAbort = null;
      preemptCount++;
      preempted = true;
    } else {
      trace({ op: "settle", t, out: "running", runningKind });
      pendingSettleT = t;
      return false;
    }
  }
  running = true;
  runningKind = "settle";
  const me = owner = ++runSeq;
  try {
    let target = t;
    for (;;) {
      pendingSettleT = null;
      let swapped = false;
      const project = getState().project;
      const stale = staleOnBackCatchUp(project, target).length;
      trace({ op: "settle", t: target, stale, plan: !!currentPlan(), costs: currentCosts().length, ...(stale ? {} : { cards: staleExplain(project, target) }) });
      // 这一拍不用补跑,但刚抢断的播放态补跑可能还在后台舞台上推:单独掐掉(要补跑时第 (1) 步顺手就掐了)
      if (!stale && (preempted || orphanRender)) await abortOrphanRender(project);
      preempted = false;
      if (stale) {
        const ready = await catchUpBack(project, target);
        // 补跑期间用户又动了：这一次作废（下面那一轮按最新的 `t` 重来）
        if (ready && Math.abs(getState().t - target) <= 1e-6 && !getState().playing) {
          swapped = !!(await swapAndDress(target, false));
        }
        swapLog.push({ at: Math.round(performance.now()), t: target, stale, ready: !!ready, swapped, ...(dressError ? { error: dressError } : {}) });
        if (swapLog.length > 10) swapLog.shift();
      }
      const next = pendingSettleT;
      // 没有新请求、或新请求就是刚做完的这一拍：收工
      if (next === null || Math.abs(next - target) <= 1e-6 || getState().playing) return swapped;
      target = next;
    }
  } finally {
    if (owner === me) {
      running = false;
      runningKind = null;
      pendingSettleT = null;
    }
  }
}

/**
 * 播放态互换（K3(b)）。目标拍 `T = store.t + 预估补跑时长`，取整到拍格。
 *
 * `back` 补完并 `mediaReady` **之后**才对旧 `front` 武装停 —— 反过来的话可见舞台会在
 * `back` 没就绪时停住，停多久没有上界。武装回 `{ passed: true }`（可见舞台先走到了 `T`）
 * 就重取 `T' = store.t + 上次预估 × 2`、对 `back` 续推（不带 `jump`）再武装一次；
 * 两次仍追不上就不换了（那张卡留在 `suppressed` 里，等 K6 降级后的死素材）。
 */
export async function runPlayingSwap(pendingIds: readonly string[]): Promise<boolean> {
  if (running) return false;
  if (swapBlockedBySingleStage()) return false;
  const project = getState().project;
  if (!pendingIds.length) return false;
  /*
   * 估出来追不上就不发起(C10-A4 后续,`planPlayingSwap`):不抑制、不排后台任务、不占 `running`。
   * 以前照样发起,整场景补跑白占后台舞台十几秒,最后「武装停已过」两次再降级。
   */
  const plan = planPlayingSwap(project, pendingIds, getState().t);
  lastPlayingPlan = { at: Math.round(performance.now()), t: getState().t, ids: [...pendingIds], ...plan };
  playingPlans.push(lastPlayingPlan);
  if (playingPlans.length > 20) playingPlans.shift();
  if (!plan.ok) {
    trace({ op: "playing", t: getState().t, ids: pendingIds.map((id) => id.slice(0, 8)), out: `skip-${plan.reason}`, backlogMs: Math.round(plan.backlogMs), ratePerSec: Math.round(plan.ratePerSec) });
    return false;
  }
  running = true;
  runningKind = "playing";
  const me = owner = ++runSeq;
  const abort = new AbortController();
  playingAbort = abort;
  trace({ op: "playing", t: getState().t, ids: pendingIds.map((id) => id.slice(0, 8)), leadMs: Math.round(plan.leadMs), backlogMs: Math.round(plan.backlogMs), ratePerSec: Math.round(plan.ratePerSec) });
  // 等待期间这几张卡进 front 的 suppressed（藏子树、t 冻住 —— 没有平面时舞台显示占位符 T4）
  setExtraSuppressed(pendingIds);
  /**
   * 两次都追不上：**改判为重（K6），而且不回到活渲**（R5-11）。
   *
   * 计划明写这张卡是例外：它活渲出来的状态本来就是错的（`vtOk = false`，子树虚拟
   * 时间推不动它），追不上才等在 `suppressed` 里，所以死素材就绪之前它留在
   * `suppressed`（显示占位符），不像别的降级卡那样「就绪前照常活渲」。
   * 以前这里直接 `return false`，`finally` 的 `setExtraSuppressed([])` 又把它放回活渲，
   * `swapTried` 还让这一轮播放不再重试 —— 状态是错的、也没人去修。
   */
  const giveUp = async (): Promise<false> => {
    gaveUp = true;
    for (const id of pendingIds) { try { await onStageDemote(id); } catch { /* 没有记录 / PUT 失败:下一拍 K6 还会来 */ } }
    return false;
  };
  let gaveUp = false;
  try {
    const fps = Math.max(1, project.fps || 30);
    // 领先量按整场景估(同场的重卡一起推),含「边补边被可见舞台追」的那一截
    lastGuessMs = plan.leadMs;
    const beatOf = (sec: number) => Math.round(sec * fps);
    let target = Math.ceil((getState().t + lastGuessMs / 1000) * fps) / fps;
    let ready = await catchUpBack(project, target, abort.signal);
    if (!ready) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const oldFront = frontStage();
      if (!oldFront || !getState().playing || abort.signal.aborted) return false;
      const armed = waitForEvent((e) => e.type === "frame" && beatOf(e.sec) >= beatOf(target), ARM_WAIT_TIMEOUT_MS);
      const reply = await untilAborted(oldFront.pause({ atSec: target }), abort.signal);
      if (!reply) return false;
      if (reply.ok && reply.passed) {
        // 可见舞台先走到了 T：重取 T' 并对 back **续推**（不带 jump，从 T 接着推）
        // 两次都追不上 → 改判为重（K6）并留在 suppressed（R5-11）
        if (attempt >= 1) return giveUp();
        lastGuessMs *= 2;
        target = Math.ceil((getState().t + lastGuessMs / 1000) * fps) / fps;
        const back = backStage();
        if (!back) return false;
        const pending = back.render(target, { maxCatchUp: Infinity });
        const again = await untilAborted(pending, abort.signal);
        if (!again) { markOrphan(pending); return false; }
        if ("aborted" in again && again.aborted) return false;
        const media = waitForEvent((e) => e.type === "mediaReady", MEDIA_READY_TIMEOUT_MS);
        await back.setMediaT(target);
        await untilAborted(media, abort.signal);
        continue;
      }
      if (!reply.ok) return false;
      await untilAborted(armed, abort.signal);
      // 停下了(抢断),或武装停等到超时时已不在播放:不再换成播放态
      if (abort.signal.aborted || !getState().playing) return false;
      // 进了互换这一步就不再可抢:换到一半的新 front 还没穿戴好(停下那一次照 R5-15 在收手时补做)
      if (playingAbort === abort) playingAbort = null;
      // 互换之后新 front 的 H(T) 里没有它们(它们判轻),所以这一份要先清掉
      setExtraSuppressed([]);
      const swapped = !!(await swapAndDress(target, true));
      // 换上来的新可见舞台在 T 那一帧是整场景精确的，从 T 接着报拍：算连续（起点不变）
      if (swapped) notePlaySeam(playRun, target, fps);
      return swapped;
    }
    return giveUp();
  } finally {
    const preempted = owner !== me;
    trace({ op: "playing-end", t: getState().t, gaveUp, preempted, pendingSettleT: preempted ? null : pendingSettleT });
    if (playingAbort === abort) playingAbort = null;
    // 放弃那一次**不清**：那张卡活渲出来的状态是错的，死素材就绪前留在 suppressed（R5-11）
    if (!gaveUp) setExtraSuppressed([]);
    // 被暂停态第二路抢断了:`running` 已经归它,下面的交接也轮不到这里
    if (!preempted) {
      running = false;
      runningKind = null;
      /*
       * **跑着时来的暂停态 settle 交给暂停态那一路**(R5-15 的另一半;C10-A4)。
       * 停下时一般已经当场抢断(见 `runSettleSwap`),走到这里的是抢不了的那几种:停下那一刻它已经进了
       * 互换那一步,或者 settle 来时 store 还在播放。以前只有暂停态那一路会消费 `pendingSettleT`,
       * 这里收手时既不做也不交出去 —— 判重的 `vtOk = false` 卡就停在快照上,直到下一次跳转或播放,
       * 违背「停下就精确」。收手时又在播放了就不补:下一次停下自己会再来一次。
       */
      const next = pendingSettleT;
      pendingSettleT = null;
      if (next !== null && !getState().playing) void runSettleSwap(next).catch(() => { /* 后台舞台正在换:下一次 setTime 会重来 */ });
    }
  }
}

/** 诊断:最近一次播放态互换的发起判断(领先量、积压、速率,或为什么不发起)与让路次数(探针看) */
let lastPlayingPlan: Record<string, unknown> | null = null;
/** 诊断:最近 20 次发起判断(含完整 clipId) */
const playingPlans: Record<string, unknown>[] = [];
export function stageSwapPlayingDebug() {
  return { lastPlan: lastPlayingPlan, plans: playingPlans.slice(), preemptCount, orphan: !!orphanRender,
    playRun: { ...playRun }, naturalSkips, lastNaturalSkip, naturalSkipped: [...naturalSkipped] };
}

/** 测试用 */
export function resetStageSwap(): void {
  running = false;
  runningKind = null;
  pendingSettleT = null;
  lastGuessMs = 0;
  host = null;
  playingAbort = null;
  orphanRender = null;
  owner = 0;
  preemptCount = 0;
  lastPlayingPlan = null;
  playRun.startFrame = null;
  playRun.lastFrame = null;
  playRun.breaks = 0;
  naturalSkips = 0;
  lastNaturalSkip = null;
  naturalSkipped = new Set();
  playingPlans.length = 0;
}

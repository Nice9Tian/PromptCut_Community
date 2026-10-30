/**
 * K1 的**常驻探针**（父页一侧的驱动）。
 *
 * 打开项目时在加载遮罩（`ProbeGate`）下把所有活跃卡逐张测完才进编辑（pinned 渲染 5）；
 * 之后新添加的卡、或 `cardCostKey` 变了的卡随即在后台舞台补测，那时不再挡界面。
 *
 * 离线版是 `scripts/probe-card-costs.mjs`，做的是同一件事、同一套数：
 * `device` 串（`src/render/costDevice.mjs`）和统计口径（`src/render/probeSummary.mjs`）
 * 都是同一份代码，两条路测出来的记录因此互相认得、可以并排比。
 *
 * # 一张卡怎么测（K1）
 *
 * 1. `pushProject('back', 缩水项目, { reset: true })` —— **一次只测一个片段**：`render` 没有
 *    clipId，不缩水的话舞台会把此刻全部活跃卡一起推，测出来的数被污染还不报错。
 *    形状同 `FrameScene` 的 `legacyTimeline`：一条轨道一个 clip。
 *    必须走 `pushProject` 而不是直接 `setProject` —— 后者绕过基线，之后的 `syncProject`
 *    会因为「和基线比没变」静默不发，`back` 就一直留在缩水项目上（E0 点名的坑）。
 * 2. `stepped` 卡三趟：
 *    - **计时趟** `render(最后一帧, { jump: true, probe: 'time', maxCatchUp: Infinity })`，
 *      拿逐帧活渲耗时 `steps`；**撞封顶回的 `{ aborted: true, reason: 'timeout' }` 是长片段的
 *      正常路径，不是失败**（R4a 报告 §8 第 8 条），按已推帧外推 `catchUpMs`；
 *    - **快照趟** `render(…, { probe: 'snapshot' })`，拿逐帧的三段生成快照耗时
 *      （回包的 `snapshotSteps`，一次往返；离线脚本为了同一批数逐帧发了 40 次往返，
 *      那在加载遮罩下太慢）。它仍受一拍预算约束，截断不影响任何判定；
 *    - **两趟布尔探针** `render(…, { probe: 'booleans' })`：`vtOk` / `seekOk` / `seekMs`
 *      整趟在舞台里跑（要 `pinner.syncIn` 钉子树虚拟时间，父页够不到）。
 * 3. `direct` 卡：按 cardId 播种随机抽本地帧，各发一次 `setTime(t, { probe: true })`，
 *    抽满 `STEP_MIN_SAMPLES`（8 不够就补抽，否则走不到百分位），`catchUpMs = 0`。
 * 4. 父页补齐 `device` / `mode` / `measuredAt` / `demoted: false` 后**整条 PUT**
 *    （`costs-store` 是整条替换，`validRecord` 要 `identityKey` + `device`）。
 *    `demoted: false` 要**显式写**：`STICKY_FLAGS` 是「没带就沿用旧值」，不写的话 K6 写过一次
 *    `true` 之后每次重测都会被贴回 `true`，卡就永久判重了（3.3）。
 *
 * # 跳过已经测过的
 *
 * 同一 `(identityKey, device)` 已有记录**且 `demoted !== true`** 的整张跳过
 * （pinned 渲染 5 末句：身份没变就直接复用）。`costs` 全命中时一张都不测，遮罩一帧都不出现。
 *
 * # 排队与掐断
 *
 * 每张卡的整套活经 `stageJobs` 的单飞队列排一次，档位是最低的 `'probe'` ——
 * 补跑（K5）和页面侧测量（D4）进来时探针让路，`ctx.signal` 一响就收摊，
 * 这张卡从头重排（E0：「`settled` 或补跑中止后……探针从当前这张卡的头重排」）。
 *
 * `render` 中止回包按 E0 的五条规矩走（`renderAbortAction`）：
 *   `'timeout'` 忽略（正常路径）、`'project'` 重发（先重发缩水项目，最多 3 次）、
 *   `'superseded'` 丢弃、`'detached'` 换客户端重来、`'role'` 当错误。
 *
 * **项目变了按新项目重排队列**：`syncProbeRun(project)` 递增代数，正在跑的那一张测完就退出，
 * 重新拉一次 `costs`、重新算 `identityKey`、重新排。新添加或 `cardCostKey` 变了的卡自然补测。
 *
 * # 测完一张卡之后（在线页面：测量时就产稀疏的轨道流）
 *
 * `docs/semantics/mechanism/rendering.md`「测量」：第二趟给判重的卡产一套稀疏的轨道流，在线页面由后台舞台紧接着这张卡的第一趟自己产。
 * 这里只留一个口子 `setCardMeasuredHook`：加载遮罩挡着的那一轮里，每测完一张卡、记录并进分派表之后调它一次并等它回
 * （遮罩因此等稀疏版）；产不产、等多久（最多 50 秒）由接的那一方定（`browserNodeHost.ts` → `online/pageStreams.ts` 的 `measure()`）。
 * 不挡界面的补测不调：之后要补的只在闲时产。没人接（桌面版）时一个字不变。
 */
import { flatPlanProject, isFlatClipId } from "../kernel/cutFlatten.mjs";
import type { Project } from "../kernel/project";
import { costDeviceString, readGpuRenderer, resolveGlRoute } from "../render/costDevice.mjs";
import { budgetOf } from "../render/pipelinePlan.mjs";
import { resolveTuning, PROBE_MAX_FRAMES, type PipelineTuning } from "../render/pipelineTuning.mjs";
import { summarizeProbe } from "../render/probeSummary.mjs";
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import type { RenderAborted, RenderReply, SetTimeAborted, SetTimeReply, StageRpcClient } from "../render/stageRpc";
import { clipIdentityOf, resetClipIdentityCache } from "./costIdentity";
import { mergePlanCosts, setPlanCosts } from "./planDispatch";
import { backStage, pushProject, stageCapabilities, whenStageReady } from "./stageBridge";
import { MAX_PROJECT_RESENDS, currentBackJob, renderAbortAction, runBackJob } from "./stageJobs";
import { measureGateOpen, whenMeasureGateOpen } from "./measureGate";
import { tierGlRoute, tierState } from "../online/onlineTier";

/* ------------------------------------------------------------------ 进度 */

export interface ProbeProgress {
  /** 这一轮还在测 */
  running: boolean;
  /**
   * 这一轮**要不要挡住界面**。只有「打开项目的第一轮」是 true（pinned 渲染 5）；
   * 之后新添加的卡在后台补测，不再挡（K1：「兜底分派只用于『新卡还没测完』那几秒」）。
   */
  blocking: boolean;
  /** 这一轮要测几张 */
  total: number;
  /** 测完几张 */
  done: number;
  /** 正在测的那张卡的 id（遮罩上的文案用） */
  card: string | null;
  /** 测不出来的（诊断用，不挡流程） */
  failed: string[];
}

const IDLE: ProbeProgress = { running: false, blocking: true, total: 0, done: 0, card: null, failed: [] };

let progress: ProbeProgress = IDLE;
const listeners = new Set<(p: ProbeProgress) => void>();

export function probeProgress(): ProbeProgress {
  return progress;
}

export function onProbeProgress(cb: (p: ProbeProgress) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function setProgress(patch: Partial<ProbeProgress>): void {
  progress = { ...progress, ...patch };
  for (const cb of listeners) cb(progress);
}

/* ------------------------------------------------------------------ 常量 */

/** 挂载那一下给一个真任务边界再开测：React 要建树、Motion 要解析关键帧 */
const MOUNT_SETTLE_MS = 150;
/** canvas 卡（three.js / tsParticles）还要等它异步把画布装起来，不然量的是一个空壳 */
const CANVAS_WAIT_TRIES = 20;
const CANVAS_WAIT_STEP_MS = 50;
/** 一张卡最多重来几次（`'project'` 重发的上限 + 一次换客户端） */
const MAX_ATTEMPTS = MAX_PROJECT_RESENDS + 1;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 测完一张卡之后的口子 */

export interface CardMeasuredInfo {
  /** 测的是哪一版项目(store 里的对象) */
  project: Project;
  /** 身份与刚测的这张卡相同的全部片段(同一张卡的多个片段只测一次) */
  clipIds: string[];
  cardId: string;
  identityKey: string;
  /** 这一轮遮罩的编号:遮罩每出现一轮(打开项目、切帧率)换一个 */
  round: number;
  /** 这一轮测量作废了没有(项目变了、换了连接) */
  stale: () => boolean;
}
type CardMeasuredHook = (info: CardMeasuredInfo) => Promise<unknown>;
let cardMeasuredHook: CardMeasuredHook | null = null;
/** 接上「测完一张卡之后」的口子;回退订。只有加载遮罩挡着的那一轮会调,调了就等它回(它自己管上限) */
export function setCardMeasuredHook(hook: CardMeasuredHook | null): () => void {
  cardMeasuredHook = hook;
  return () => { if (cardMeasuredHook === hook) cardMeasuredHook = null; };
}
/** 这一轮遮罩的编号 */
let maskRound = 0;
/**
 * 遮罩下别的测量(两个舞台的界限搜索,`Preview.tsx`)测完一张卡之后也走同一个口子:给判重的卡产稀疏版,等它回。
 * 遮罩编号与常驻探针的同一个(一轮遮罩只有一个 50 秒的等稀疏版上限)。没人接(桌面版)时什么都不做。
 */
export async function runCardMeasuredHook(info: Omit<CardMeasuredInfo, "round">): Promise<void> {
  const hook = cardMeasuredHook;
  if (!hook) return;
  try { await hook({ ...info, round: maskRound }); }
  catch (err) { console.warn("[probeRunner] 测完一张卡之后的口子出错", err); }
}

/* ------------------------------------------------------------------ 身份与设备 */

/** `import.meta.env.DEV`：桌面版跑的就是 vite dev server，分派用当前运行模式的记录（3.1） */
const RUN_MODE: "dev" | "build" = import.meta.env.DEV ? "dev" : "build";

/**
 * 本机身份（J4）。`compact` / `offscreenGl` 取**舞台握手报上来的那一份** ——
 * 离线探针拿的也是它，主文档自己再探一遍会是第二份实现、会走偏。
 */
/*
 * GPU 渲染器串一个页面会话里不变:读一次记下(C6.6 集成,T4)。以前每排一轮都新建一个 WebGL 上下文去读、再还回去,
 * 编辑时每改一次项目就多出几毫秒到十几毫秒。读成 `unknown`(上下文没建成)的不记,下次再读。
 */
let gpuRenderer: string | null = null;
function gpuRendererOnce(): string {
  if (gpuRenderer) return gpuRenderer;
  const r = readGpuRenderer(document);
  if (r !== "unknown") gpuRenderer = r;
  return r;
}

function deviceStringOf(tuning: PipelineTuning): string {
  const caps = stageCapabilities("back");
  return costDeviceString({
    ua: navigator.userAgent,
    renderer: gpuRendererOnce(),
    compact: !!caps?.compact,
    offscreenGl: !!caps?.offscreenGl,
    // 生效路线(M2):桌面按项目选项、缺省路线 1;在线页面按舞台闸门(`onlineTier.ts`)。切了路线等于换机器,旧记录不命中、重探针
    glRoute: effectiveGlRoute(currentProject),
    mode: RUN_MODE,
    tuning,
  });
}

/* ------------------------------------------------------------------ 要测哪些卡 */

interface ProbeJob {
  clipId: string;
  cardId: string;
  identityKey: string;
  /** 声明的帧模式：`direct` 抽样，其余推帧 */
  frameMode: string;
  canvasHeavy: boolean;
  /** 审阅表的轴三。只有 `independent` 的卡才把探针帧存成预渲染素材（K1 末句） */
  independent: boolean;
  fps: number;
  lenSec: number;
  durationFrames: number;
  /** 缩水项目：一条轨道一个 clip，形状同 `FrameScene` 的 `legacyTimeline` */
  project: Project;
}

/** 缩水项目（K1「一次只测一个片段」） */
function shrinkProject(project: Project, track: Project["tracks"][number], clip: Project["tracks"][number]["clips"][number]): Project {
  return {
    ...project,
    duration: Math.max(1 / Math.max(1, project.fps || 30), clip.end - clip.start),
    media: [],
    filters: undefined,
    cardNodes: undefined,
    tracks: [{ ...track, hidden: false, clips: [{ ...clip, start: 0, end: clip.end - clip.start }] }],
  } as Project;
}

function planJobs(project: Project, costs: CardCostRecord[], device: string): ProbeJob[] {
  // 身份键和能力表和 `planDispatch` 共用同一份（`costIdentity.ts`）：
  // 探针写进去的记录和分派表查的键必须是同一个算法算出来的
  const { identityKeys, capabilities: capsOf } = clipIdentityOf(project);

  // 已有记录且 demoted !== true 的整张跳过（pinned 渲染 5 末句）
  const known = new Set(costs.filter((r) => r.device === device && r.demoted !== true).map((r) => r.identityKey));
  const fps = Math.max(1, project.fps || 30);
  const jobs: ProbeJob[] = [];
  const seen = new Set<string>();
  // 剪辑段里的卡照测(`kernel/cutFlatten.mjs` 的摊平视图;片段 id 是 `<段 id>~<卡的片段 id>`):缩水项目里它就是一张顶层卡
  for (const track of flatPlanProject(project).tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (!clip.cardId && !clip.nodeId) continue;
      const identityKey = identityKeys[clip.id];
      if (!identityKey) continue;
      // 同一张卡的多个片段身份相同，只测一次
      if (seen.has(identityKey) || known.has(identityKey)) continue;
      seen.add(identityKey);
      const caps = capsOf.get(clip.id) ?? {};
      const lenSec = Math.max(1 / fps, Number(clip.end) - Number(clip.start));
      jobs.push({
        clipId: clip.id,
        cardId: clip.cardId ?? clip.nodeId ?? "?",
        identityKey,
        frameMode: typeof caps.frameMode === "string" ? caps.frameMode : "stateful",
        canvasHeavy: caps.canvasHeavy === true,
        // 剪辑段里的卡的探针帧不当预渲染素材(它们只产单卡轨道流,隔离工程要带着剪辑段链)
        independent: caps.compositing === "independent" && !isFlatClipId(clip.id),
        fps,
        lenSec,
        durationFrames: Math.max(1, Math.round(lenSec * fps)),
        project: shrinkProject(project, track, clip),
      });
    }
  }
  return jobs;
}

/* ------------------------------------------------------------------ 端点 */

/**
 * 成本记录存在哪(C10 契约第 3 节):桌面运行环境是编辑器进程的 `GET / PUT /api/data/costs`;在线双舞台由 `Preview` 换成
 * 页面内快照库 L2 的 `costs` 表(`src/online/l2Costs.ts`,`mode=build`,关掉再开不重测)。
 * `forwardFrames`:探针帧要不要转发给预渲染进程(在线页面没有预渲染进程,不转发)。
 */
export interface CostBackend {
  load(): Promise<{ costs: CardCostRecord[]; tuning: PipelineTuning }>;
  save(records: CardCostRecord[]): Promise<boolean>;
  forwardFrames?: boolean;
}
const httpBackend: CostBackend = { load: () => getCostsHttp(), save: (records) => putCostsHttp(records), forwardFrames: true };
let backend: CostBackend = httpBackend;

/** 换成本记录的存放处;null 回到编辑器进程 */
export function setCostBackend(next: CostBackend | null): void {
  backend = next ?? httpBackend;
}

/**
 * 测完写进成本记录的那一处留的订阅口(C10 契约第 18 节第 7 条):每写一次,把这次测得的记录发给订阅方
 * (`stored`:写没写成)。文档服务那一侧的共享成本记录由 `claude/c10-cost` 接在这里(集成时由主会话接线)。
 */
const costRecordListeners = new Set<(records: CardCostRecord[], info: { stored: boolean }) => void>();
export function onCostRecords(cb: (records: CardCostRecord[], info: { stored: boolean }) => void): () => void {
  costRecordListeners.add(cb);
  return () => { costRecordListeners.delete(cb); };
}

async function getCosts(): Promise<{ costs: CardCostRecord[]; tuning: PipelineTuning }> {
  return backend.load();
}

async function putCosts(records: CardCostRecord[]): Promise<boolean> {
  const stored = await backend.save(records).catch(() => false);
  for (const l of [...costRecordListeners]) { try { l(records, { stored }); } catch { /* 订阅方坏了不影响测量 */ } }
  return stored;
}

/** 测过的片段(诊断、探针用;最近 200 条):哪个片段、哪张卡、身份键、什么时候开测 */
const probedLog: Array<{ clipId: string; cardId: string; identityKey: string; at: number }> = [];
export function probeRunDiag() {
  return { probed: probedLog.map((e) => ({ ...e })), running: progress.running, done: progress.done, total: progress.total };
}

/** 探针帧的诊断:收到几帧、其中几帧是压过的可转移字节(C10 契约第 2 节「大块产出」) */
const probeFrameStats = { frames: 0, gzFrames: 0, gzBytes: 0, htmlBytes: 0 };
export function probeFrameDiag() {
  return { ...probeFrameStats };
}

async function getCostsHttp(): Promise<{ costs: CardCostRecord[]; tuning: PipelineTuning }> {
  try {
    const res = await fetch("/api/data/costs");
    if (!res.ok) return { costs: [], tuning: resolveTuning(null) };
    const data = await res.json();
    return {
      costs: Array.isArray(data?.costs) ? (data.costs as CardCostRecord[]) : [],
      tuning: resolveTuning(data?.tuning),
    };
  } catch {
    // 插件没挂上 / 离线：这一轮用缺省系数，不跳过任何卡（测完 PUT 也会失败，但不该因此卡住界面）
    return { costs: [], tuning: resolveTuning(null) };
  }
}

async function putCostsHttp(records: CardCostRecord[]): Promise<boolean> {
  try {
    const res = await fetch("/api/data/costs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records }),
    });
    return res.ok;
  } catch {
    return false;
  }
}



/* ------------------------------------------------------------------ 测一张卡 */

const isAborted = (r: RenderReply): r is RenderAborted => !!r && (r as { aborted?: boolean }).aborted === true;
/** 带 `probe` 的 `setTime` 只会被角色闸门拒（`{ aborted: true, reason: 'role' }`） */
const isSetTimeAborted = (r: SetTimeReply): r is SetTimeAborted => !!r && (r as { aborted?: boolean }).aborted === true;

type Attempt =
  | { kind: "ok"; record: CardCostRecord }
  /** 这张卡从头重排（`'project'` / `'detached'` / 更急的活抢了队） */
  | { kind: "retry" }
  /** 这一轮别再试了（`'role'` / 抛错） */
  | { kind: "fail" };

/** 按 cardId 播种的随机数，和离线探针同一份实现 —— 同一台机器上复跑抽到同一批帧、可比 */
const seedOf = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/**
 * canvas 卡把画布装起来了没有。**跨源摸不到 iframe 的 document**（离线探针那一侧是同源、
 * 直接查 `[data-pc-clip] canvas`），所以改问 `rectsWithBounds({ pixels: 'all' })`：
 * 它会让舞台读一次画布像素算实体框，框出来了就说明画布真画上了东西。
 */
async function waitForCanvas(stage: StageRpcClient, clipId: string): Promise<void> {
  for (let i = 0; i < CANVAS_WAIT_TRIES; i++) {
    try {
      const list = await stage.rectsWithBounds({ pixels: "all", clipIds: [clipId] });
      const box = list.find((r) => r.clipId === clipId)?.bounds;
      if (box && box.width > 1 && box.height > 1) break;
    } catch {
      return;
    }
    await sleep(CANVAS_WAIT_STEP_MS);
  }
  await sleep(MOUNT_SETTLE_MS);
}

async function probeCardOnce(
  job: ProbeJob,
  stage: StageRpcClient,
  signal: AbortSignal,
  tuning: PipelineTuning,
  device: string,
  stale: () => boolean,
): Promise<Attempt> {
  /** 中止回包按 E0 的五条规矩翻译成「这张卡怎么办」 */
  const onAbort = (r: RenderAborted): Attempt | null => {
    if (r.reason === "role" && (stage !== backStage() || signal.aborted)) return { kind: "retry" };
    switch (renderAbortAction(r.reason, currentBackJob())) {
      case "ignore": return null;            // 'timeout'：长片段的正常路径，不是失败
      case "resend": return { kind: "retry" };
      case "rebind": return { kind: "retry" };
      case "drop": return { kind: "retry" };
      case "error": return { kind: "fail" };
    }
  };

  // 一次只测一个片段：先换缩水项目，再 render（顺序反了会在全量项目上把全部活跃卡一起推）
  await pushProject("back", job.project, { reset: true });
  if (stale() || signal.aborted) return { kind: "retry" };
  await stage.setTime(0);
  await sleep(MOUNT_SETTLE_MS);
  if (job.canvasHeavy) await waitForCanvas(stage, job.clipId);
  if (stale() || signal.aborted) return { kind: "retry" };

  const steps: number[] = [];
  const inline: number[] = [];
  const raster: number[] = [];
  const serialize: number[] = [];
  let kind: "random" | "stepped";
  let totalFrames = job.durationFrames;
  let truncated = false;
  let booleans: { vtOk?: boolean; seekOk?: boolean; seekMs?: number | null } = {};

  if (job.frameMode === "direct") {
    kind = "random";
    /*
     * 固定随机抽本地帧，**抽满 STEP_MIN_SAMPLES**（K1：8 次不够就补抽）——
     * 不补的话 8 个样本走不到百分位，`robustStep` 只好退回取最大。
     */
    const want = Math.max(8, Math.min(tuning.STEP_MIN_SAMPLES, job.durationFrames));
    const rnd = mulberry32(seedOf(job.cardId));
    const picks = new Set<number>();
    for (let i = 0; i < want * 64 && picks.size < Math.min(want, job.durationFrames); i++) picks.add(Math.floor(rnd() * job.durationFrames));
    const frames = [...picks].sort((a, b) => a - b);
    for (const n of frames) {
      if (stale() || signal.aborted) return { kind: "retry" };
      const r = await stage.setTime(n / job.fps, { probe: true });
      if (isSetTimeAborted(r)) {
        // K5 可能在 setTime 往返期间互换前后台舞台；旧客户端此时成了 front。
        // 只在舞台已经换人或被高优先级工作抢占时，从新 back 重试。
        return stage !== backStage() || signal.aborted ? { kind: "retry" } : { kind: "fail" };
      }
      // stepMs 是舞台在等那一次真 rAF **之前**取的，所以已经不含垂直同步（3.8 末条）
      steps.push(Number(r.stepMs) || 0);
      inline.push(Number(r.snapshot?.inlineMs) || 0);
      raster.push(Number(r.snapshot?.rasterMs) || 0);
      serialize.push(Number(r.snapshot?.serializeMs) || 0);
    }
    totalFrames = frames.length;
  } else {
    kind = "stepped";
    const lastSec = Math.max(0, job.lenSec - 1 / job.fps);
    totalFrames = Math.max(1, Math.round(lastSec * job.fps) + 1);

    /* ---- 计时趟：只推进、不生成快照 ---- */
    const timePass = await stage.render(lastSec, { jump: true, probe: "time", maxCatchUp: Infinity, maxFrames: PROBE_MAX_FRAMES });
    if (isAborted(timePass)) {
      const out = onAbort(timePass);
      if (out) return out;
      truncated = true;                        // 'timeout'：撞封顶，正常路径
    }
    for (const s of (timePass as { steps?: number[] }).steps ?? []) steps.push(Number(s) || 0);
    if (stale() || signal.aborted) return { kind: "retry" };



    /* ---- 两趟布尔探针：整趟在舞台里跑（K1） ---- */
    const boolPass = await stage.render(lastSec, { jump: true, probe: "booleans" });
    if (isAborted(boolPass)) {
      const out = onAbort(boolPass);
      if (out) return out;
    } else if (boolPass.booleans) {
      booleans = boolPass.booleans;
    }
  }

  const summary = summarizeProbe({ kind, steps, inline, raster, serialize, totalFrames, truncated }, tuning);
  const capped = summary.stepMs * tuning.COST_SCALE > budgetOf(job.fps);
  const round = (x: number) => Number(x.toFixed(3));

  return {
    kind: "ok",
    record: {
      identityKey: job.identityKey,
      fps: job.fps,
      // 五个数分开报（3.8 + K1）；旧的 frameMs 已删，不留兼容
      stepMs: round(summary.stepMs),
      stepMaxMs: round(summary.stepMaxMs),
      inlineMs: round(summary.inlineMs),
      rasterMs: round(summary.rasterMs),
      serializeMs: round(summary.serializeMs),
      catchUpMs: round(summary.catchUpMs),
      // 计时趟真实采到的帧数(共享成本记录要它;没有时转写按 `device` 串里的 stepN 记,见 `sharedCosts.ts` 的 `samplesOf`)
      ...(summary.samples > 0 ? { samples: summary.samples } : {}),
      ...(capped ? { capped: true } : {}),
      kind,
      ...(typeof booleans.vtOk === "boolean" ? { vtOk: booleans.vtOk } : {}),
      ...(typeof booleans.seekOk === "boolean" ? { seekOk: booleans.seekOk } : {}),
      ...(booleans.seekMs !== undefined ? { seekMs: booleans.seekMs === null ? null : round(booleans.seekMs) } : {}),
      mode: RUN_MODE,
      // **显式写 false**（3.3）：STICKY_FLAGS 是「没带就沿用旧值」，不写的话 K6 写过一次 true
      // 之后每次重测都会被贴回 true，这张卡就永久判重了。pinnedHeavy 留给人工钉死，这里不写。
      demoted: false,
      measuredAt: Date.now(),
      device,
    },
  };
}

/* ------------------------------------------------------------------ 主循环 */

let currentProject: Project | null = null;
let queuedIdentity: string | null = null;
let queuedBackend: CostBackend | null = null;
let queuedDeviceInputs = "";
/** 项目变了就 +1：正在跑的那一轮据此收摊、按新项目重排 */
let generation = 0;
let settledGeneration = 0;
let looping = false;
/** 「打开项目的第一轮」过去了没有 —— 之后的补测不再挡界面 */
let firstPassDone = false;

const hasCardClip = (p: Project | null): boolean =>
  !!p && !!flatPlanProject(p).tracks?.some((tr) => tr.clips?.some((c) => !!c.cardId || !!c.nodeId));

/** The preload for this project can use the measured costs. */
export function probeSettledFor(project: Project): boolean {
  return currentProject === project && settledGeneration === generation;
}

/**
 * 项目变了叫一次（`ProbeGate` 在 effect 里叫）。同一个对象引用不重排 ——
 * store 是不可变更新，引用没变就什么都没变。
 */
export function syncProbeRun(project: Project | null): void {
  if (project === currentProject) return;
  queueProbeRun(project, identitySignature(project));
}

function identitySignature(project: Project | null): string | null {
  if (!project) return null;
  const { identityKeys, capabilities } = clipIdentityOf(project);
  return JSON.stringify(Object.keys(identityKeys).sort().map((clipId) => {
    const caps = capabilities.get(clipId) ?? {};
    return [clipId, identityKeys[clipId], typeof caps.frameMode === "string" ? caps.frameMode : "stateful",
      caps.canvasHeavy === true, caps.compositing === "independent"];
  }));
}

function deviceInputs(project: Project | null): string {
  const caps = stageCapabilities("back");
  return JSON.stringify([!!caps?.compact, !!caps?.offscreenGl, effectiveGlRoute(project)]);
}

/** 生效的 canvas 渲染路线:在线页面跟舞台闸门走(`tierGlRoute`),桌面按项目选项、缺省路线 1 */
function effectiveGlRoute(project: Project | null): "perDocument" | "shared" {
  return tierState().online ? tierGlRoute() : resolveGlRoute(project?.glRoute ?? null);
}

function queueProbeRun(project: Project | null, identity: string | null): void {
  /*
   * **切 fps 要重走遮罩**（pinned 架构 7 的项目选项 + 渲染 5 的「每次打开项目都测」）。
   * `cardCostKey` 把 fps 吃进了身份键，换帧率之后全部卡的记录都失配、一张都不能复用，
   * 这一轮要测的张数和打开新项目时一样多 —— 不挡遮罩的话用户会看到一段边测边编辑的
   * 空窗期，分派表在那期间还是兜底的那份。所以把 `firstPassDone` 拨回去，
   * 让这一轮重新 `blocking`。预算 `B = 1000/fps × 70%` 也跟着变，重测正是必须的。
   */
  if (project && currentProject && Number(project.fps) !== Number(currentProject.fps)) { if (firstPassDone) maskRound++; firstPassDone = false; }
  currentProject = project;
  queuedIdentity = identity;
  queuedBackend = backend;
  queuedDeviceInputs = deviceInputs(project);
  generation++;
  if (!looping) void runLoop();
}

/**
 * 卡片代码换了而项目没变(C6.6 第 5 节:同步装上了别人改的卡):`cardCostKey` 里的源码版本跟着变,
 * 但 `syncProbeRun` 按项目引用早退、`clipIdentityOf` 按项目引用记忆化,都看不出来;
 * 卡片模块的热更新虽然沿导入链重跑了本模块,实测并不会重排(C6.6 探针)。
 * 这里清掉身份缓存、按当前项目重排一轮,身份键变了、没有记录的卡照现有规则补测(分派表在这一轮开头跟着重算)。
 * 同一批热更新可能发多次通知:身份和测量环境相同的通知保留正在跑的测量,不递增代数。
 * 由 `ProbeGate.tsx` 在注册表 `onCardsUpdated` 通知、舞台装上新版代码之后调用。
 */
export function requeueProbeRun(project: Project | null): void {
  resetClipIdentityCache();
  const identity = identitySignature(project);
  if (project === currentProject && identity === queuedIdentity && backend === queuedBackend
    && deviceInputs(project) === queuedDeviceInputs && progress.failed.length === 0) return;
  queueProbeRun(project, identity);
}

/**
 * 即时渲染闸门的口子(在线页面由 `Preview` 接到 `online/stageGate.ts`):测每张卡之前留崩溃记录、测完收;测崩过的卡(`skip`)不再测,
 * 直接当重卡(`planDispatch.setPlanForcedHeavy`)。桌面不接。
 */
export interface ProbeMeasureHooks {
  before?(identityKey: string, cardId: string): void;
  after?(identityKey: string): void;
  skip?(identityKey: string): boolean;
}
let measureHooks: ProbeMeasureHooks = {};
export function setProbeMeasureHooks(next: ProbeMeasureHooks | null): void {
  measureHooks = next ?? {};
}

/**
 * 在线页面两个舞台、项目里已经有别的机器测好的成本记录时(语义 `product/platforms.md`「轻重判定」:有记录就二分只测几张来划线),
 * 打开项目先由界限搜索在后台舞台里只测几张(`Preview` 的界限搜索,遮罩下),常驻探针等它定下来:
 * - `holdProbe()`:先别开工(打开项目时由 `Preview` 叫);
 * - `releaseProbe({ blocking })`:开工;`blocking: false` = 这一轮不挡界面(界限搜索已经在遮罩下划好了线,探针在后台把其余的卡补测完,
 *   补齐 K3/K5 要的记录;补测完了分派表改按成本记录判)。没有记录的照旧在遮罩下逐张实测(`blocking: true`)。
 * 桌面不叫,一直开着。
 */
let holdGate: { promise: Promise<void>; release: () => void } | null = null;
export function holdProbe(): void {
  if (holdGate) return;
  let release = () => {};
  const promise = new Promise<void>((r) => { release = r; });
  holdGate = { promise, release };
}
export function releaseProbe({ blocking = true }: { blocking?: boolean } = {}): void {
  if (!blocking) firstPassDone = true;
  const g = holdGate;
  holdGate = null;
  g?.release();
}
export function probeHeld(): boolean {
  return holdGate !== null;
}

async function runLoop(): Promise<void> {
  looping = true;
  try {
    // E1：后台舞台就绪了才开工（不去够 Preview 内部的 stageReady）
    await whenStageReady("back");
    for (;;) {
      /*
       * 在线页面:等卡片源码第一次同步完(同步来的用户卡在那之前是未知 id,不能测;`measureGate.ts`)。每一轮开头都问:
       * 换了项目 / 连接,门会重新关上,等新项目的卡片源码同步完。桌面这道门一开始就开着。
       */
      await whenMeasureGateOpen();
      while (holdGate) await holdGate.promise;
      const gen = generation;
      const project = currentProject;
      if (!project) break;

      const { costs, tuning } = await getCosts();
      const device = deviceStringOf(tuning);
      // K2 的表跟着 `costs` / `tuning` 走（E0 的 setPlan）
      setPlanCosts(costs, tuning);
      if (gen !== generation) continue;          // 拉 costs 期间项目又变了：重排

      const jobs = planJobs(project, costs, device);
      const blocking = !firstPassDone;
      setProgress({ running: jobs.length > 0, blocking, total: jobs.length, done: 0, card: jobs[0]?.cardId ?? null, failed: [] });

      const failed: string[] = [];
      let done = 0;
      for (const job of jobs) {
        // 门在这一轮里又关上了(换了连接):收摊,下一轮开头等门
        if (gen !== generation || !measureGateOpen()) break;
        setProgress({ card: job.cardId, done });
        if (measureHooks.skip?.(job.identityKey)) { done++; setProgress({ done }); continue; }
        probedLog.push({ clipId: job.clipId, cardId: job.cardId, identityKey: job.identityKey, at: Date.now() });
        if (probedLog.length > 200) probedLog.splice(0, probedLog.length - 200);
        try { measureHooks.before?.(job.identityKey, job.cardId); } catch { /* 记不下崩溃记录不挡测量 */ }
        let record: CardCostRecord | null;
        try {
          record = await probeCard(job, tuning, device, () => gen !== generation);
        } finally {
          try { measureHooks.after?.(job.identityKey); } catch { /* 同上 */ }
        }
        if (gen !== generation) break;
        if (record) {
          await putCosts([record]);
          // 表跟着新记录走。就地合并,不再 GET 一次 —— 这条记录本来就在手上
          mergePlanCosts([record]);
          // 遮罩挡着的这一轮:紧接着这张卡的第一趟,给它产稀疏的轨道流(在线页面;判不判重、产不产、等多久由接的一方定)
          const hook = cardMeasuredHook;
          if (hook && blocking) {
            const { identityKeys } = clipIdentityOf(project);
            const clipIds = Object.keys(identityKeys).filter((id) => identityKeys[id] === job.identityKey);
            try { await hook({ project, clipIds, cardId: job.cardId, identityKey: job.identityKey, round: maskRound, stale: () => gen !== generation }); }
            catch (err) { console.warn("[probeRunner] 测完一张卡之后的口子出错", err); }
            if (gen !== generation) break;
          }
        } else {
          failed.push(job.cardId);
        }
        done++;
        setProgress({ done, failed: [...failed] });
      }

      if (gen !== generation || !measureGateOpen()) continue;          // 中途换了项目或连接：从头再排一轮
      // 这一轮走完了。项目里确实有卡片段时才算「打开项目的第一轮」过去了 ——
      // 空项目 / 还没加载完时那一轮不算，否则真项目到位时遮罩就不出现了。
      if (hasCardClip(project)) firstPassDone = true;
      setProgress({ running: false, card: null });
      if (gen === generation) {
        settledGeneration = gen;
        // A zero-job pass never changes the visible progress, but preload still
        // needs to hear that its project is ready.
        setProgress({ running: false });
        break;
      }
    }
  } catch (err) {
    // 探针挂了不能把编辑器挡在遮罩后面：记一条诊断，放行
    console.error("[probeRunner] 探针这一轮出错", err);
    queuedIdentity = null; // 暂时的 RPC/存储错误仍允许下一次通知重试。
    settledGeneration = generation;
    setProgress({ running: false, card: null });
    firstPassDone = true;
  } finally {
    looping = false;
    // 收摊期间又换了项目：接着跑下一轮
    if (generation !== 0 && currentProject && progress.running) void runLoop();
  }
}

/** 一张卡：排进单飞队列，按 E0 的规矩最多重来几次 */
async function probeCard(job: ProbeJob, tuning: PipelineTuning, device: string, stale: () => boolean): Promise<CardCostRecord | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (stale()) return null;
    let out: Attempt;
    try {
      out = await runBackJob("probe", (ctx) => probeCardOnce(job, ctx.stage, ctx.signal, tuning, device, stale));
    } catch {
      // iframe 正在换 / RPC 抛了：换一次客户端再来
      await whenStageReady("back").catch(() => undefined);
      continue;
    }
    if (out.kind === "ok") return out.record;
    if (out.kind === "fail") return null;
  }
  return null;
}

/** 测试用：把驱动恢复成刚加载的样子 */
export function resetProbeRunner(): void {
  currentProject = null;
  queuedIdentity = null;
  queuedBackend = null;
  queuedDeviceInputs = "";
  generation = 0;
  settledGeneration = 0;
  firstPassDone = false;
  holdGate = null;
  maskRound = 0;
  cardMeasuredHook = null;
  progress = IDLE;
  listeners.clear();
  probedLog.length = 0;
}

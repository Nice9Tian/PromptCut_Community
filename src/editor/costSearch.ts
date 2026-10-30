/**
 * 只有一个舞台时的轻重判定:共享成本记录加界限搜索(语义 `product/platforms.md`「在线浏览器」的「轻重判定」与「即时渲染闸门」、
 * `mechanism/rendering.md`「界限搜索与成本记录」;契约 `docs/plan/c10-contract.md` 第 3 节)。纯的部分在 `src/render/boundarySearch.mjs`,
 * 这里是页面一侧的驱动:取记录、在唯一那个舞台里测、把结果交给分派(`planDispatch.setPlanSearchLight`)、测完写进文档服务。
 * 只有一个舞台(舞台闸门停在第一级、握手失败退回)时借可见舞台测;两个舞台、项目里已有别的机器测好的记录时在后台舞台里测(`borrow: false`),
 * 划好线之后常驻探针(`probeRunner.ts`)在后台把其余的卡补测完、不挡界面;两个舞台而一条记录都没有的,照旧由常驻探针在遮罩下逐张实测。
 *
 * # 流程
 *
 * 1. 打开项目时经共享项目的文档服务连接读本项目的全部成本记录(`sharedCosts.ts` 的 `listSharedCosts`),顺带拿到本机环境的指纹;
 * 2. 项目里每张卡(按 `identityKey` 去重;本页跑不了的用户卡、素材效果卡不参加、按重卡)交给 `boundarySearch`:
 *    有记录的二分只测几张,没有记录的逐张实测(`measureUnrecorded`,2026-10-07 用户定);
 * 3. 测量在**自己的舞台**里做:只有一个舞台,不开后台舞台。测量期间把它临时切成 `back` 角色(舞台的探针闸门只认 `back`),
 *    一次只测一个片段(缩水项目,同 `probeRunner.ts`),只走计时趟、不生成快照(`render(…, { probe: 'time' })`;
 *    `direct` 卡按播种的随机帧逐帧 `setTime(…, { probe: true })`),单帧耗时按 `summarizeProbe` 同一口径取;
 *    测完切回 `front`,整份项目重灌,由调用方(`Preview`)把画面、抑制与快照重投一遍;
 * 4. 测每张卡之前经 `beforeMeasure` 留崩溃记录(即时渲染闸门:测某张卡把页面撑崩了,重新载入后这张卡直接当重卡),测完 `afterMeasure`;
 * 5. 本机测过的结果按「卡片身份 + 本机环境指纹」经注入的 `store`(`getCost` / `putCost`)存下,下次打开复用;
 *    真测出来的经 `publish` 写进文档服务(所有在线浏览器测完都写,2026-10-07 用户定);
 * 6. 之后项目里加了新卡:有记录的按已有的界限判,没有记录的补测那几张(`measureNewCards`;随项目变化更新相关测量)。
 *
 * # 界面
 *
 * 真要在舞台里测的时候(本地复用全命中就一次都不测),盖一层与桌面加载遮罩同样的遮罩(`CostSearchGate`):舞台测量时画面会被
 * 拨到缩水项目上,遮罩挡住这段画面和编辑操作(语义 `product/rendering.md`「测量」:打开项目时在加载遮罩下测;
 * 测量遮罩是「预览不无提示地透明」的唯一例外)。测量期间父页不投快照、不发抑制、不拨时间(`costSearchMeasuring()`)。
 * 取记录、判定都很快,不挡界面。
 */
import type { Project } from "../kernel/project";
import type { RenderAborted, RenderReply, SetTimeAborted, SetTimeReply, StageRpcClient } from "../render/stageRpc";
import { boundarySearch, classifyWithBoundary, localCostKey, maxMeasurements, type BoundaryResult, type CostStore } from "../render/boundarySearch.mjs";
import { budgetOf } from "../render/pipelinePlan.mjs";
import { PROBE_MAX_FRAMES, resolveTuning, type PipelineTuning } from "../render/pipelineTuning.mjs";
import { summarizeProbe } from "../render/probeSummary.mjs";
import { listSharedCosts, type PageEnvironment, type SharedCostInput, type SharedCostRecord } from "./sharedCosts";

type Request = (msg: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
type Clip = Project["tracks"][number]["clips"][number];

/* ------------------------------------------------------------------ 状态(遮罩与父页的闸门读它) */

export interface CostSearchState {
  /** 正在舞台里测(遮罩在) */
  measuring: boolean;
  /** 这一轮已经真测了几张 */
  done: number;
  /** 最多测几张(`maxMeasurements`) */
  estimate: number;
  /** 正在测的卡(cardId) */
  card: string | null;
}

const IDLE: CostSearchState = { measuring: false, done: 0, estimate: 0, card: null };
let state: CostSearchState = IDLE;
const listeners = new Set<(s: CostSearchState) => void>();

function setState(patch: Partial<CostSearchState>) {
  state = { ...state, ...patch };
  for (const cb of listeners) cb(state);
}

export function costSearchState(): CostSearchState {
  return state;
}
/**
 * 两个舞台的界限搜索测完以后,给测过的重卡产稀疏版(`mechanism/rendering.md`「测量」:在线页面紧接着这张卡的第一趟产)的那一段,
 * 加载遮罩照旧挡着:`holdCostSearchMask` 立起(显示正在产哪张卡),`releaseCostSearchMask` 撤下。
 */
export function holdCostSearchMask(card: string | null, done = 0, estimate = 0): void {
  setState({ measuring: true, card, done, estimate });
}
export function releaseCostSearchMask(): void {
  if (state.measuring) setState({ measuring: false, card: null });
}
export function onCostSearch(cb: (s: CostSearchState) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
/** 舞台此刻被测量占着:父页不投快照、不发抑制、不拨时间、不推项目 */
export function costSearchMeasuring(): boolean {
  return state.measuring;
}

/* ------------------------------------------------------------------ 测一张卡 */

/** 挂载后给一个真任务边界再开测(同 `probeRunner.ts`) */
const MOUNT_SETTLE_MS = 150;
const CANVAS_WAIT_TRIES = 20;
const CANVAS_WAIT_STEP_MS = 50;
/** 一张卡被项目重灌(`'project'`)打断后最多重来几次 */
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isAborted = (r: RenderReply): r is RenderAborted => !!r && (r as { aborted?: boolean }).aborted === true;
const isSetTimeAborted = (r: SetTimeReply): r is SetTimeAborted => !!r && (r as { aborted?: boolean }).aborted === true;
const seedOf = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export interface MeasureJob {
  clipId: string;
  cardId: string;
  frameMode: string;
  canvasHeavy: boolean;
  fps: number;
  lenSec: number;
  durationFrames: number;
  project: Project;
}

/** 缩水项目:一条轨道一个片段,从 0 开始(同 `probeRunner.ts` 的 `shrinkProject`) */
export function shrinkProject(project: Project, track: Project["tracks"][number], clip: Clip): Project {
  return {
    ...project,
    duration: Math.max(1 / Math.max(1, project.fps || 30), clip.end - clip.start),
    media: [],
    filters: undefined,
    cardNodes: undefined,
    tracks: [{ ...track, hidden: false, clips: [{ ...clip, start: 0, end: clip.end - clip.start }] }],
  } as Project;
}

/** 项目里每个 identityKey 取第一个片段做测量任务 */
export function measureJobsOf(project: Project, identityKeys: Record<string, string>, capabilities: ReadonlyMap<string, Record<string, unknown>>): Map<string, MeasureJob> {
  const fps = Math.max(1, project.fps || 30);
  const out = new Map<string, MeasureJob>();
  for (const track of project.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (!clip.cardId && !clip.nodeId) continue;
      const key = identityKeys[clip.id];
      if (!key || out.has(key)) continue;
      const caps = capabilities.get(clip.id) ?? {};
      const lenSec = Math.max(1 / fps, Number(clip.end) - Number(clip.start));
      out.set(key, {
        clipId: clip.id,
        cardId: clip.cardId ?? clip.nodeId ?? "?",
        frameMode: typeof caps.frameMode === "string" ? caps.frameMode : "stateful",
        canvasHeavy: caps.canvasHeavy === true,
        fps,
        lenSec,
        durationFrames: Math.max(1, Math.round(lenSec * fps)),
        project: shrinkProject(project, track, clip),
      });
    }
  }
  return out;
}

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

/**
 * 在(已切成 `back` 的)舞台里测一张卡的活渲单帧耗时:只计时、不生成快照。回 `{ stepMs, samples }`,测不出来回 null;
 * 被项目重灌打断回 `'retry'`。
 */
export async function measureOnce(
  stage: StageRpcClient,
  job: MeasureJob,
  pushProject: (project: Project) => Promise<void>,
  tuning: PipelineTuning,
): Promise<{ stepMs: number; samples: number } | null | "retry"> {
  await pushProject(job.project);
  await stage.setTime(0);
  await sleep(MOUNT_SETTLE_MS);
  if (job.canvasHeavy) await waitForCanvas(stage, job.clipId);
  const steps: number[] = [];
  let kind: "random" | "stepped";
  let totalFrames = job.durationFrames;
  let truncated = false;
  if (job.frameMode === "direct") {
    kind = "random";
    const want = Math.max(8, Math.min(tuning.STEP_MIN_SAMPLES, job.durationFrames));
    const rnd = mulberry32(seedOf(job.cardId));
    const picks = new Set<number>();
    for (let i = 0; i < want * 64 && picks.size < Math.min(want, job.durationFrames); i++) picks.add(Math.floor(rnd() * job.durationFrames));
    const frames = [...picks].sort((a, b) => a - b);
    for (const n of frames) {
      const r = await stage.setTime(n / job.fps, { probe: true });
      if (isSetTimeAborted(r)) return null;
      steps.push(Number(r.stepMs) || 0);
    }
    totalFrames = frames.length;
  } else {
    kind = "stepped";
    const lastSec = Math.max(0, job.lenSec - 1 / job.fps);
    totalFrames = Math.max(1, Math.round(lastSec * job.fps) + 1);
    const timePass = await stage.render(lastSec, { jump: true, probe: "time", maxCatchUp: Infinity, maxFrames: PROBE_MAX_FRAMES });
    if (isAborted(timePass)) {
      if (timePass.reason === "project" || timePass.reason === "superseded") return "retry";
      if (timePass.reason !== "timeout") return null;
      truncated = true; // 撞封顶:长片段的正常路径,按已推帧算
    }
    for (const s of (timePass as { steps?: number[] }).steps ?? []) steps.push(Number(s) || 0);
  }
  if (!steps.length) return null;
  const summary = summarizeProbe({ kind, steps, inline: [], raster: [], serialize: [], totalFrames, truncated }, tuning);
  return { stepMs: Number(summary.stepMs.toFixed(3)), samples: steps.length };
}

/* ------------------------------------------------------------------ 一轮搜索 */

export interface CostSearchDeps {
  request: Request;
  projectId: string;
  project: Project;
  environment: PageEnvironment;
  identityKeys: Record<string, string>;
  capabilities: ReadonlyMap<string, Record<string, unknown>>;
  /** 本页跑不了的片段(没载入成功的用户卡、素材效果卡):不参加、按重卡 */
  unsupported: (clip: Clip) => boolean;
  /** 测量用的舞台:只有一个舞台时是唯一那个(借它,`borrow` 缺省真);两个舞台时是后台舞台(`borrow: false`,不切角色、不重灌、不盖可见舞台) */
  stage: () => StageRpcClient | null;
  /** 借可见舞台来测(只有一个舞台)。两个舞台在后台舞台里测时给 false */
  borrow?: boolean;
  /** 往这个舞台整份重灌一个项目(`stageBridge.pushProject('front', p, { reset: true })`) */
  pushProject: (project: Project) => Promise<void>;
  /** 测完:切回 `front` 之后调,由调用方把整份项目、时间、抑制与快照重投一遍 */
  restore: () => Promise<void> | void;
  /** 此刻的整份项目(测完重灌用) */
  currentProject: () => Project;
  store: CostStore;
  tuning?: PipelineTuning;
  mode?: "dev" | "build";
  /** 测这张卡之前(即时渲染闸门留崩溃记录);`key` 是 identityKey */
  beforeMeasure?: (key: string, cardId: string) => void;
  /** 这张卡测完了(不论测没测出来) */
  afterMeasure?: (key: string) => void;
  /** 真测出来的记录写进文档服务(所有在线浏览器测完都写);失败不影响判定 */
  publish?: (records: SharedCostInput[]) => Promise<unknown> | void;
}

export interface CostSearchOutcome {
  result: BoundaryResult;
  records: SharedCostRecord[];
  envFingerprint: string;
  /** 参加搜索的卡(identityKey) */
  keys: string[];
  /** 本页跑不了的用户卡、素材效果卡(identityKey):按重卡 */
  forcedHeavy: string[];
  /** 判轻的卡(identityKey),交给 `setPlanSearchLight` */
  light: Set<string>;
  elapsedMs: number;
}

/** 项目里要判的卡:参加搜索的与这台设备渲染不了的(都按 identityKey 去重) */
export function keysOf(project: Project, identityKeys: Record<string, string>, unsupported: (clip: Clip) => boolean): { keys: string[]; forcedHeavy: string[] } {
  const keys = new Set<string>();
  const forced = new Set<string>();
  for (const track of project.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (!clip.cardId && !clip.nodeId) continue;
      const key = identityKeys[clip.id];
      if (!key) continue;
      (unsupported(clip) ? forced : keys).add(key);
    }
  }
  for (const k of forced) keys.delete(k);
  return { keys: [...keys].sort(), forcedHeavy: [...forced].sort() };
}

/**
 * 跑一轮界限搜索。取不到记录(没连上、被拒)抛错,由调用方稍后再试;测量中的舞台错误按那张卡跑不动算。
 */
export async function runCostSearch(deps: CostSearchDeps): Promise<CostSearchOutcome> {
  const started = Date.now();
  const tuning = resolveTuning(deps.tuning ?? null);
  const { records, envFingerprint } = await listSharedCosts({ request: deps.request, projectId: deps.projectId, environment: deps.environment });
  const { keys, forcedHeavy } = keysOf(deps.project, deps.identityKeys, deps.unsupported);
  const jobs = measureJobsOf(deps.project, deps.identityKeys, deps.capabilities);
  const fps = Math.max(1, deps.project.fps || 30);
  const withRecords = new Set(records.map((r) => r.identityKey));
  const estimate = maxMeasurements(keys.filter((k) => withRecords.has(k)).length) + keys.filter((k) => !withRecords.has(k)).length;

  const lease = createLease(deps, estimate, jobs, tuning);
  let result: BoundaryResult;
  try {
    result = await boundarySearch({
      keys, records, budgetMs: budgetOf(fps), measure: lease.measure, store: deps.store, envFingerprint,
      scale: tuning.COST_SCALE, mode: deps.mode ?? "build", measureUnrecorded: true,
    });
  } finally {
    await lease.end();
  }
  await publishMeasured(deps, lease.fresh);
  const light = new Set(result.light);
  for (const k of forcedHeavy) light.delete(k);
  return { result, records, envFingerprint, keys, forcedHeavy, light, elapsedMs: Date.now() - started };
}

/**
 * 借唯一那个舞台来测:第一次真要测时把它切成 `back`、盖遮罩;`end` 切回 `front`、整份重灌、撤遮罩。
 * `fresh` 收这一轮真测出来的(不含本地复用命中的),测完写进文档服务。
 */
function createLease(deps: CostSearchDeps, estimate: number, jobs: Map<string, MeasureJob>, tuning: PipelineTuning) {
  let leased: StageRpcClient | null = null;
  let done = 0;
  const fresh: SharedCostInput[] = [];
  const measure = async (key: string): Promise<{ stepMs: number; samples: number } | null> => {
    const job = jobs.get(key);
    const stage = deps.stage();
    if (!job || !stage) return null;
    if (!leased) {
      setState({ measuring: true, done: 0, estimate, card: job.cardId });
      if (deps.borrow !== false) { try { await stage.setRole("back", { job: "probe" }); } catch { return null; } }
      leased = stage;
    }
    setState({ card: job.cardId, done });
    try { deps.beforeMeasure?.(key, job.cardId); } catch { /* 记不下崩溃记录不挡测量 */ }
    try {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const r = await measureOnce(stage, job, deps.pushProject, tuning);
        if (r === "retry") continue;
        if (r) fresh.push({ identityKey: key, stepMs: r.stepMs, samples: r.samples, measuredAt: Date.now(), mode: deps.mode ?? "build" });
        return r;
      }
      return null;
    } catch {
      return null;
    } finally {
      try { deps.afterMeasure?.(key); } catch { /* 同上 */ }
      done++;
      setState({ done });
    }
  };
  const end = async () => {
    if (!leased) return;
    const stage: StageRpcClient = leased;
    leased = null;
    if (deps.borrow === false) { setState({ measuring: false, card: null }); return; }
    try { await stage.setRole("front"); } catch { /* iframe 换了:新的握手会重设角色 */ }
    try { await deps.pushProject(deps.currentProject()); } catch { /* 同上 */ }
    setState({ measuring: false, card: null });
    try { await deps.restore(); } catch { /* 调用方自己兜 */ }
  };
  return { measure, end, fresh };
}

async function publishMeasured(deps: CostSearchDeps, fresh: SharedCostInput[]): Promise<void> {
  if (!fresh.length || !deps.publish) return;
  try { await deps.publish(fresh); } catch { /* 写不进去不影响判定;下一次测量再写 */ }
}

/**
 * 搜索做完之后项目里加了新卡:没有共享成本记录、本机也没测过的那几张补测(随项目变化更新相关测量;有记录的按已有的界限判,
 * 不测)。回补测之后的结果(`result.measured` 里多了这几张);没有要补测的回原样。测量期间同样借舞台、盖遮罩、留崩溃记录。
 */
export async function measureNewCards(outcome: CostSearchOutcome, deps: Omit<CostSearchDeps, "request" | "projectId" | "environment">): Promise<CostSearchOutcome> {
  const { keys, forcedHeavy } = keysOf(deps.project, deps.identityKeys, deps.unsupported);
  const withRecords = new Set(outcome.records.map((r) => r.identityKey));
  const todo = keys.filter((k) => !withRecords.has(k) && !outcome.result.measured.has(k));
  if (!todo.length) return outcome;
  const tuning = resolveTuning(deps.tuning ?? null);
  const jobs = measureJobsOf(deps.project, deps.identityKeys, deps.capabilities);
  const lease = createLease(deps as CostSearchDeps, todo.length, jobs, tuning);
  const measured = new Map(outcome.result.measured);
  try {
    for (const key of todo) {
      const local = await (async () => { try { return await deps.store.getCost(localCostKey(key, outcome.envFingerprint)); } catch { return undefined; } })() as { stepMs?: unknown } | undefined;
      if (local && typeof local.stepMs === "number" && Number.isFinite(local.stepMs)) { measured.set(key, { ms: local.stepMs, cached: true, failed: false }); continue; }
      const r = await lease.measure(key);
      const ok = !!r && Number.isFinite(r.stepMs) && r.stepMs >= 0;
      measured.set(key, { ms: ok ? r!.stepMs : Infinity, cached: false, failed: !ok });
      if (ok) {
        try { await deps.store.putCost(localCostKey(key, outcome.envFingerprint), { identityKey: key, envFingerprint: outcome.envFingerprint, stepMs: r!.stepMs, samples: r!.samples, measuredAt: Date.now(), mode: deps.mode ?? "build" }); } catch { /* 存不下就下次再测 */ }
      }
    }
  } finally {
    await lease.end();
  }
  await publishMeasured(deps as CostSearchDeps, lease.fresh);
  const result = { ...outcome.result, measured };
  const light = classifyWithBoundary(result, keys, outcome.records).light;
  for (const k of forcedHeavy) light.delete(k);
  return { ...outcome, result, keys, forcedHeavy, light };
}

/**
 * 搜索做完之后项目又变了(加了卡、改了参数):按已有的界限判(`classifyWithBoundary`;没有记录又没测的新卡先由 `measureNewCards` 补测)。
 * 回判轻的 identityKey。
 */
export function reclassify(outcome: CostSearchOutcome, project: Project, identityKeys: Record<string, string>, unsupported: (clip: Clip) => boolean): Set<string> {
  const { keys } = keysOf(project, identityKeys, unsupported);
  return classifyWithBoundary(outcome.result, keys, outcome.records).light;
}

/* ------------------------------------------------------------------ 基准卡(即时渲染闸门的「最低一档」判据) */

/**
 * 基准卡〔裁〕:内置的「金句药丸」(`punch-pill`,一行字的胶囊弹入,DOM 卡、`motion` 写法、一层模糊光晕),缺省参数、2 秒。
 * 语义 `product/platforms.md`「最低一档」:连最简单的一张基准卡都跑不动的设备进最低一档。跑不动的界线与判重同一个式子
 * (单帧耗时 × 成本倍率 > 预算 B,`pipelinePlan.mjs` 的 `budgetOf`):这台设备连它都判重,别的卡更不用说。
 */
export const BENCHMARK_CARD_ID = "punch-pill";
export const BENCHMARK_SECONDS = 2;
export const BENCHMARK_FPS = 30;

/** 基准卡的缩水项目与测量任务 */
export function benchmarkJob(): MeasureJob {
  const fps = BENCHMARK_FPS;
  const clip = { id: "pc-benchmark-clip", cardId: BENCHMARK_CARD_ID, start: 0, end: BENCHMARK_SECONDS, params: {} } as unknown as Clip;
  const project = {
    version: 1, id: "pc-benchmark", name: "基准卡", width: 1920, height: 1080, fps, duration: BENCHMARK_SECONDS, themeId: "midnight", media: [],
    tracks: [{ id: "pc-benchmark-track", name: "基准", clips: [clip] }],
  } as unknown as Project;
  return { clipId: clip.id, cardId: BENCHMARK_CARD_ID, frameMode: "stateful", canvasHeavy: false, fps, lenSec: BENCHMARK_SECONDS, durationFrames: BENCHMARK_SECONDS * fps, project };
}

export interface BenchmarkOutcome {
  /** `ok` 跑得动,`slow` 跑不动(进最低一档),`unknown` 没测出来(舞台在换、被打断):不算跑不动 */
  verdict: "ok" | "slow" | "unknown";
  stepMs: number | null;
  budgetMs: number;
  scale: number;
}

/** 由单帧耗时判:单帧耗时 × 成本倍率 > 预算 B 就是跑不动 */
export function benchmarkVerdict(stepMs: number | null, tuning: PipelineTuning = resolveTuning(null)): BenchmarkOutcome {
  const budgetMs = budgetOf(BENCHMARK_FPS);
  const scale = tuning.COST_SCALE;
  if (stepMs === null || !Number.isFinite(stepMs)) return { verdict: "unknown", stepMs: null, budgetMs, scale };
  return { verdict: stepMs * scale > budgetMs ? "slow" : "ok", stepMs, budgetMs, scale };
}

/**
 * 在一台舞台里测基准卡。`borrow` 为真(只有一个舞台):借可见舞台,测完切回、整份重灌、`restore`(同界限搜索);
 * 为假(有后台舞台):调用方在后台舞台的单飞队列里给 `stage` 与 `pushProject`。测之前、之后经 `beforeMeasure` / `afterMeasure` 留崩溃记录。
 */
export async function runBenchmark(deps: Pick<CostSearchDeps, "stage" | "pushProject" | "restore" | "currentProject" | "beforeMeasure" | "afterMeasure" | "tuning"> & { borrow: boolean }): Promise<BenchmarkOutcome> {
  const tuning = resolveTuning(deps.tuning ?? null);
  const job = benchmarkJob();
  const key = "@benchmark";
  if (deps.borrow) {
    const lease = createLease({ ...deps, mode: "build" } as unknown as CostSearchDeps, 1, new Map([[key, job]]), tuning);
    let r: { stepMs: number } | null = null;
    try { r = await lease.measure(key); } finally { await lease.end(); }
    return benchmarkVerdict(r?.stepMs ?? null, tuning);
  }
  const stage = deps.stage();
  if (!stage) return benchmarkVerdict(null, tuning);
  try { deps.beforeMeasure?.(key, BENCHMARK_CARD_ID); } catch { /* 记不下不挡 */ }
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = await measureOnce(stage, job, deps.pushProject, tuning);
      if (r === "retry") continue;
      return benchmarkVerdict(r?.stepMs ?? null, tuning);
    }
    return benchmarkVerdict(null, tuning);
  } catch {
    return benchmarkVerdict(null, tuning);
  } finally {
    try { deps.afterMeasure?.(key); } catch { /* 同上 */ }
  }
}

/** 测试用 */
export function resetCostSearch(): void {
  state = IDLE;
  listeners.clear();
}

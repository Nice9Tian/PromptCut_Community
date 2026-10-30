/**
 * 本页产流的**编排**(任务书 `docs/plan/render-refactor-task.md`「甲二」;做法与〔裁〕见 `docs/plan/browser-stream-task.md`「本页产流」)。
 *
 * 线上没有能切分的节点时,身份为电脑的在线页面在后台舞台闲时自己生成单卡轨道流、推到素材服务、自己播;产物和经队列产的是同一种东西
 * (键、清单、层表里的那一行都相同,计划在 `pageStreamPlan.ts`,与服务端对拍),别的成员的页面、之后上线的桌面应用和渲染主机直接用。
 *
 * 本模块只有判据与次序,不碰舞台、网络、存储:它们由宿主(`src/editor/browserNodeHost.ts`)经 `deps` 注入。宿主每拍调一次 `tick()`。
 *
 * # 什么时候轮到本页自己产(〔裁〕)
 *
 *   1. 本页是浏览器节点(当节点的条件全部成立、拿到了指纹、探到了编码器),或只为本页产稀疏版的页面(身份为手机、只有一个舞台;
 *      2026-10-14 用户定「手机、平板也为本页产稀疏版」)—— 最低一档不产;
 *   2. 本页这一版的清单计划已经发出去(清单 = 本页自己判重的片段:只为自己打开的项目、自己要播的卡),其中有本页能产的单卡流还没有产物;
 *   3. **线上没有能切分的节点接这份计划**:计划发出去满 `PAGE_STREAM_WAIT_MS` 仍然没人认领(队列里它还是 `open`)。怎么知道:把同一个计划任务
 *      再发布一次(队列对同一个结果键只合并,不另起任务),回包里带它此刻的状态;有活要做的期间每 `PAGE_STREAM_POLL_MS` 问一次。
 *      状态是 `claimed` / `done` 就是有节点接了活:不产;正在产的做完当前这一帧就停(已经推完的分段按任务 id 留着,切分方把同一个任务
 *      发进队列后本页的节点认领它,只补缺的)。`failed`(切分方试过、做不成)与 `open` 同样对待;
 *   4. 闲(`deps.isIdle()`:宿主的闲的判据,再加本页的节点手里没有认领)。
 *
 * # 先查,没有才产
 *
 * 每一段任务动手之前查两处:本页自己的键在内容库里有没有覆盖这一段的清单、块都在素材服务上(另一个同指纹的页面、上一次打开时产的);
 * 层表里这张卡有没有别的**能播的**单卡流(桌面应用、渲染主机、别的指纹的页面产的;能播的判据与播放那一侧相同:同一个内容键,或输入签名没过期),
 * 它的清单覆盖这一段、块都在。查到就直接用,不产。产的途中每 `PAGE_STREAM_RECHECK_MS` 再查一次,别处已经产出来了就做完当前这一帧停下,改用现成的。
 *
 * # 层表
 *
 * 没有切分方时层表没人写:本页开工前把自己的那一行并进内容库里的层表(`mergeLayerStreams`,只动 `streams` 里自己这几行),
 * 之后每隔 `PAGE_STREAM_ROWS_MS` 核对一次还在不在(两个页面同时写,后写的会盖掉先写的)。本页的那一行不在了、而表里这张卡已经有别人整条产好的流时
 * 不再写回去(不和别的写层表的一方来回盖)。有切分方接了活之后不再写(层表归它)。
 *
 * # 让路
 *
 * 规矩同浏览器节点认领任务(`browserNode.ts` 的 D8):播放、拖动、后台舞台来了更急的活 —— 当前这一帧做完就停,`YIELD_FRAME_MAX_MS` 之内
 * 做不完就中止;页面隐藏不等当前帧,马上中止。已经推完的分段留着,闲下来接着补缺的。
 *
 * # 两趟:先稀疏,后满密度(`docs/semantics/mechanism/rendering.md`「重管线:预渲染」)
 *
 * 每条流产两趟(`passes`,缺省 `[稀疏, 满密度]`):稀疏的一趟每个分段只截分段的第一帧(任务是 `pageStreamTasks(…, { density: 'sparse' })`,
 * 与切分方出的稀疏流任务逐字段相同),满密度的一趟每帧都截;两趟用同一个结果键、同一个清单键,清单由宿主合并。
 * **所有流的稀疏那一趟都落定了(产了、查到已有、或这一版里放下了),才开始满密度的一趟**:稀疏的某一段在退避,满密度的也等着。
 * 先查按这一趟的密度认:稀疏的一趟,清单里每个分段有一版(稀疏或满密度)就算有;满密度的一趟要每个分段都是满密度。
 *
 * # 测量时就产稀疏版(`measure()`;语义同上「测量」)
 *
 * 打开项目、加载遮罩下逐张测量时,一张卡的第一趟(计时)测完、判重,测量方(`src/editor/probeRunner.ts`)紧接着调 `measure()`:
 * 把这张卡的单卡流的稀疏那一趟做出来 —— 先查(素材服务里已经有就直接用)、把本页的那一行并进层表、产、写清单、叫宿主认它。
 * 这条路不等清单计划、不问有没有切分方、不看闲不闲(遮罩下用户动不了;页面隐藏照旧中止)。它只做稀疏的一趟,满密度留给闲时。
 *
 * 遮罩等稀疏版有墙上时钟的上限 `MEASURE_SPARSE_MAX_MS`(50 秒):从这一轮遮罩下第一次调 `measure()` 起算,到时在产的做完当前这一帧就停
 * (已经推完的分段按任务 id 留着)、`measure()` 当场回,之后这一轮再调一律马上回;没产完的归闲时那条路(清单计划发出去以后照上面的次序接着做,
 * 任务 id 相同,只补缺的分段)。上限只管遮罩下产稀疏版,不截断测量本身(「太慢」按单帧判)。
 * 时钟、等本页当上节点(拿到指纹、探到编码器,最多 `MEASURE_READY_WAIT_MS`)都由 `tick()` 推,所以宿主在 `measure()` 没回之前要照常调 `tick()`。
 *
 * 测量用的那一份记账(`measure` 的 ctx)在清单计划发出来之前留着(层表里本页的那几行照常核对);计划发出来(发成的时刻不早于它)就换成计划的那一份,
 * 稀疏的任务再先查一遍,查到的是测量时产的。
 *
 * 本模块属于 render 这一层(`src/online/`):不引 editor。
 */
import type { NodeTask } from "./browserNode.ts";
import { STREAM_SEGMENT_FRAMES, YIELD_FRAME_MAX_MS, type YieldCause } from "./browserNode.ts";
import { candidateSpans, layerStreamCandidates, mergeLayerStreams, pageStreamRow, pageStreamTasks, type PageStreamRow, type PageStreamSpec } from "./pageStreamPlan.ts";
import { packedSize, avcCodecFor } from "../render/streamEncode.ts";

/** 清单计划发出去之后没人认领,等这么久本页才自己产(三级数字;空闲的切分方认领计划在一秒以内,留出它正忙着别的活的余量) */
export const PAGE_STREAM_WAIT_MS = 5000;
/** 有活要做的期间,多久问一次计划的状态 */
export const PAGE_STREAM_POLL_MS = 2000;
/** 产的途中多久查一次「别处产出来了没有」 */
export const PAGE_STREAM_RECHECK_MS = 5000;
/** 多久核对一次本页的那几行还在不在层表里 */
export const PAGE_STREAM_ROWS_MS = 20_000;
/** 一段任务连着做不成几次就不再试(这一版里) */
export const PAGE_STREAM_ATTEMPTS = 3;
/**
 * 打开项目时加载遮罩等稀疏版最多这么久(墙上时钟;`docs/semantics/mechanism/rendering.md`「测量」:遮罩下产稀疏版最多等 50 秒,
 * 到时就先进编辑,剩下的闲时接着产)。从这一轮遮罩下第一次等稀疏版起算。这个数只写在这一处。
 */
export const MEASURE_SPARSE_MAX_MS = 50_000;
/** 测量时等本页当上节点(拿到指纹、探到编码器)最多这么久;算在上面的 50 秒里。等不到这张卡就归闲时 */
export const MEASURE_READY_WAIT_MS = 3000;

/** 队列里这一版清单计划的状态;`none` = 问不到(没发出去、连接断着) */
export type PlanState = "none" | "open" | "claimed" | "done" | "failed";

/** 本页最近发成的那一版清单计划(`planPublisher.ts` 的 `current()`) */
export interface PublishedPlan {
  /** 计划任务的 id(`plan:<项目>@<版本>#clips:<签名>`) */
  id: string;
  projectId: string;
  projectRev: number;
  /** 清单:本页自己判重的片段 */
  clips: readonly string[];
  /** 发成的时刻 */
  at: number;
}

/** 一趟产流:`stride` 是每几帧取一张(1 = 每帧都取,满密度;大于 1 是稀疏的一趟,任务是稀疏流任务) */
export interface PageStreamPass { name: string; stride: number }
/** 缺省的两趟:先稀疏(每个分段只截分段的第一帧),后满密度 */
export const PAGE_STREAM_PASSES: readonly PageStreamPass[] = [{ name: "sparse", stride: STREAM_SEGMENT_FRAMES }, { name: "dense", stride: 1 }];

/** 测量时要产稀疏版的一张卡(`measure()` 的入参) */
export interface MeasureRequest {
  /** 这一轮遮罩的编号(遮罩每出现一轮换一个):50 秒的时钟按它算 */
  round: number | string;
  projectId: string;
  /** 用哪一版已确认项目算流(宿主留存着这一版) */
  projectRev: number;
  /** 刚测完的这张卡的片段(同一张卡的几个片段身份相同,一起给) */
  clips: readonly string[];
  /** 此刻本页判重的全部片段(合并成组流的判据要看全部;只产 `clips` 里的) */
  heavy: readonly string[];
  /** 这一轮测量作废了(项目变了):停手 */
  stale?: () => boolean;
}
/** `measure()` 的结果:`ok` 这张卡的稀疏版都落定了;其余是没做完的原因 */
export interface MeasureOutcome {
  result: "ok" | "none" | "deadline" | "incapable" | "busy" | "stale" | "stopped" | "interrupted" | "failed";
  /** 这一次落定的任务数:本页产的、查到自己的键已有的、查到别的候选已有的;`left` 没做完的(归闲时) */
  produced: number; have: number; elsewhere: number; left: number;
}

export interface PageStreamsDeps {
  now: () => number;
  /** 本页此刻能不能产流:是浏览器节点、拿到了指纹、探到了编码器、有代码指纹 */
  capable: () => boolean;
  /** 闲不闲(宿主的闲的判据,再加本页的节点手里没有认领) */
  isIdle: () => boolean;
  /** 本页最近发成的那一版清单计划;没有回 null */
  plan: () => PublishedPlan | null;
  /** 问队列这一版计划此刻的状态;问不到回 `none` */
  planState: () => Promise<PlanState>;
  /** 这一版里本页能产的单卡流(`pageStreamPlan.ts` 的 `planPageStreams`,宿主按那一版的已确认项目算);算不出回 null(过一会儿再算) */
  specs: (plan: PublishedPlan) => Promise<{ specs: PageStreamSpec[]; skipped: Record<string, string>; project: unknown } | null>;
  /** 嵌在页面里的代码版本(写进任务的 `requires.codeVersion`,与切分方出的任务同形) */
  codeVersion?: string | null;
  /** 先查之一:本页自己的键,这一段的清单在内容库里、块都在素材服务上 */
  lookupOwn: (task: NodeTask, need: { dense: boolean }) => Promise<boolean>;
  /** 先查之二:别的候选的结果键,这一段的清单在内容库里、块都在素材服务上。`need.dense`:要每个分段都是满密度(稀疏的一趟不要求) */
  lookupOther: (resultKey: string, range: { from: number; to: number }, need: { dense: boolean }) => Promise<boolean>;
  /** 内容库里现有的层表(没有回 null);读不到抛 */
  readLayerMap: (project: unknown) => Promise<unknown | null>;
  /** 把整张层表写回内容库 */
  writeLayerMap: (project: unknown, body: Record<string, unknown>) => Promise<void>;
  /**
   * 产一段:逐帧向后台舞台要像素、送编码器、推分段,全部分段齐了写清单。每帧前问 `yielding()`,为真就做完当前帧停手、回 `yielded`;
   * `signal` 中止时尽早停手(抛)。`stride` 是这一趟每几帧取一张。
   */
  produce: (job: { task: NodeTask; project: unknown; stride: number; signal: AbortSignal; yielding: () => boolean }) => Promise<"done" | "yielded">;
  /** 这个结果键有了可用的流(本页产的、先查查到的):宿主叫在线来源认它、马上重取层表 */
  onAlive?: (resultKey: string) => void;
  /** 产几趟、每趟多密;缺省先稀疏后满密度(`PAGE_STREAM_PASSES`) */
  passes?: readonly PageStreamPass[];
  /** 遮罩等稀疏版的上限;缺省 `MEASURE_SPARSE_MAX_MS` */
  measureMaxMs?: number;
  measureReadyMs?: number;
  waitMs?: number;
  pollMs?: number;
  recheckMs?: number;
  rowsMs?: number;
  /** 只为本页产稀疏版(身份为手机、只有一个舞台):只产稀疏版;产流前调 VideoEncoder.isConfigSupported 检查配置。缺省假 */
  sparseOnly?: boolean | (() => boolean);
  /** 检查编码器配置是否支持(单测注入桩,缺省查 globalThis.VideoEncoder.isConfigSupported) */
  isConfigSupported?: (config: Record<string, unknown>) => Promise<{ supported?: boolean } | boolean>;
}

type TaskState = "todo" | "produced" | "have" | "elsewhere" | "failed";
interface Job { task: NodeTask; spec: PageStreamSpec; pass: PageStreamPass; passIndex: number; state: TaskState; fails: number; retryAt: number; via: string | null }
interface Ctx {
  /** 测量时的那一份记账(没有清单计划;`plan` 是照项目与版本拼的一个替身) */
  measure: boolean;
  plan: PublishedPlan;
  specs: PageStreamSpec[] | null;
  /** 每条流在层表里的那一行(结果键 → 行;先查与写层表都用它的输入签名) */
  rows: Map<string, PageStreamRow>;
  skipped: Record<string, string>;
  project: unknown;
  jobs: Job[];
  /** 本页有份的流(产了、在产、或查到自己的键已经有):层表里要有本页的那一行 */
  mine: Set<string>;
  rowsAt: number;
  specsAt: number;
  probe: { state: PlanState; at: number; flying: boolean };
}
interface Run {
  job: Job;
  controller: AbortController;
  yieldCause: YieldCause | null;
  yieldAt: number | null;
  /** 不是让路的停手原因:`splitter`(有切分方接了活)、`elsewhere`(别处产出来了)、`plan-changed`、`stopped`、`deadline`(遮罩等稀疏版到时了)、`stale` */
  stop: string | null;
  recheckAt: number;
  rechecking: boolean;
}

export interface PageStreamsDebug {
  /** `off` 不产(不是节点、没有计划)、`planning` 在算这一版的流、`none` 这一版没有本页能产的、`waiting` 在等有没有切分方、
   *  `taken` 有切分方接了活、`checking` 在先查、`producing` 在产、`idle-wait` 等闲、`done` 都有了、
   *  `measuring` 测量时那一份记账(清单计划还没发出来) */
  state: "off" | "planning" | "none" | "waiting" | "taken" | "checking" | "producing" | "idle-wait" | "done" | "measuring";
  planId: string | null;
  planState: PlanState;
  /** 计划发出去多久了 */
  waitedMs: number | null;
  streams: { clipId: string; contentKey: string; streamKey: string; firstSegment: number; lastSegment: number; mine: boolean }[];
  jobs: { id: string; clipId: string; pass: string; state: TaskState; via: string | null; fails: number }[];
  skipped: Record<string, string>;
  running: { id: string; yield: string | null; stop: string | null } | null;
  counters: {
    /** 本页产完的任务数、先查查到自己的键已有的、查到别的候选已有的 */
    produced: number; have: number; elsewhere: number; failed: number;
    /** 开工次数(每次进 `produce` 记一次,让路后回来再记一次) */
    starts: number;
    yields: Record<string, number>;
    stops: Record<string, number>;
    aborts: number;
    probes: number; rowsWritten: number; rowsFailed: number;
    /** 本页的那一行不在层表里了、别人整条产好的流在:不写回去的次数 */
    rowsYielded: number;
  };
  /** 测量时产稀疏版:这一轮遮罩的编号、时钟从哪一刻起、到哪一刻止、调了几次、各种结果的次数、各自落定的任务数、此刻有没有在等 */
  measure: {
    round: number | string | null; startedAt: number | null; deadlineAt: number | null; calls: number; active: boolean;
    results: Record<string, number>; produced: number; have: number; elsewhere: number; left: number;
    log: { at: number; clips: string[]; result: string; ms: number; produced: number; have: number; elsewhere: number; left: number }[];
  };
  lastError: string | null;
}

export interface PageStreams {
  tick(): void;
  /** 让路(规矩同浏览器节点):`hidden` 马上中止,其余做完当前这一帧就停 */
  yieldFor(cause: YieldCause): void;
  /** 此刻有没有在产、或测量时在等稀疏版(宿主据此不让节点同时认领:两条路共用后台舞台的同一份活) */
  running(): boolean;
  /**
   * 测量时就产稀疏版:一张卡的第一趟测完、判重之后调。先查,没有才产;遮罩等它,最多等到这一轮的 50 秒到头(到时当场回)。
   * 不抛。没回之前宿主要照常调 `tick()`(时钟由它推)。
   */
  measure(req: MeasureRequest): Promise<MeasureOutcome>;
  /** 下线、换项目:停下、清掉这一版的记账 */
  stop(reason?: string): void;
  debug(): PageStreamsDebug;
}

export function createPageStreams(deps: PageStreamsDeps): PageStreams {
  const passes: readonly PageStreamPass[] = deps.passes?.length ? deps.passes : PAGE_STREAM_PASSES;
  const isLow = () => typeof deps.sparseOnly === "function" ? deps.sparseOnly() : !!deps.sparseOnly;
  /** 这一趟是不是稀疏的(任务是稀疏流任务、先查不要求满密度) */
  const sparse = (pass: PageStreamPass) => pass.stride > 1;
  const effectivePasses = (): readonly PageStreamPass[] => {
    if (isLow()) {
      const sp = passes.filter(sparse);
      return sp.length ? sp : [{ name: "sparse", stride: STREAM_SEGMENT_FRAMES }];
    }
    return passes;
  };
  let consecutiveErrors = 0;
  const checkEncoderSupported = async (spec: PageStreamSpec): Promise<boolean> => {
    const w = spec.bound?.w || 640;
    const h = spec.bound?.h || 360;
    const fps = spec.fps || 30;
    const size = packedSize(w, h);
    const config = {
      codec: avcCodecFor(size.width, size.height),
      width: size.width,
      height: size.height,
      framerate: fps,
      avc: { format: "avc" },
      latencyMode: "quality",
    };
    if (typeof deps.isConfigSupported === "function") {
      try {
        const r = await deps.isConfigSupported(config);
        return typeof r === "boolean" ? r : r?.supported === true;
      } catch {
        return false;
      }
    }
    const ve = (globalThis as any).VideoEncoder;
    if (typeof ve?.isConfigSupported === "function") {
      try {
        const r = await ve.isConfigSupported(config);
        return typeof r === "boolean" ? r : r?.supported === true;
      } catch {
        return false;
      }
    }
    return false;
  };
  const measureMaxMs = deps.measureMaxMs ?? MEASURE_SPARSE_MAX_MS, measureReadyMs = deps.measureReadyMs ?? MEASURE_READY_WAIT_MS;
  const waitMs = deps.waitMs ?? PAGE_STREAM_WAIT_MS, pollMs = deps.pollMs ?? PAGE_STREAM_POLL_MS;
  const recheckMs = deps.recheckMs ?? PAGE_STREAM_RECHECK_MS, rowsMs = deps.rowsMs ?? PAGE_STREAM_ROWS_MS;
  let ctx: Ctx | null = null;
  let run: Run | null = null;
  /** 在算流、在先查、在写层表:一次只做一件 */
  let working = false;
  let phase: "planning" | "checking" | null = null;
  let lastError: string | null = null;
  const counters: PageStreamsDebug["counters"] = { produced: 0, have: 0, elsewhere: 0, failed: 0, starts: 0, yields: {}, stops: {}, aborts: 0, probes: 0, rowsWritten: 0, rowsFailed: 0, rowsYielded: 0 };
  const bump = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1; };
  const fail = (e: unknown) => { lastError = String((e as Error)?.message ?? e).slice(0, 200); };
  const alive = (key: string) => { try { deps.onAlive?.(key); } catch { /* 宿主坏了 */ } };

  const stopRun = (reason: string, abort = false) => {
    const r = run;
    if (!r) return;
    if (!r.stop) r.stop = reason;
    if (abort) r.controller.abort();
  };

  /* ---------------- 测量时产稀疏版:这一轮遮罩的时钟、在等的那一次 ---------------- */
  let clock: { round: number | string; startedAt: number } | null = null;
  interface Measuring { req: MeasureRequest; at: number; done: boolean; resolve: (out: MeasureOutcome) => void; out: MeasureOutcome }
  let measuring: Measuring | null = null;
  /** 等下一拍(`tick()` 里叫醒) */
  let tickWaiters: (() => void)[] = [];
  const nextTick = () => new Promise<void>((resolve) => { tickWaiters.push(resolve); });
  const mstats: PageStreamsDebug["measure"] = { round: null, startedAt: null, deadlineAt: null, calls: 0, active: false, results: {}, produced: 0, have: 0, elsewhere: 0, left: 0, log: [] };
  const endMeasure = (m: Measuring, result: MeasureOutcome["result"]) => {
    if (m.done) return;
    m.done = true;
    if (measuring === m) measuring = null;
    m.out.result = result;
    bump(mstats.results, result);
    mstats.produced += m.out.produced; mstats.have += m.out.have; mstats.elsewhere += m.out.elsewhere; mstats.left += m.out.left;
    mstats.log.push({ at: m.at, clips: [...m.req.clips], result, ms: deps.now() - m.at, produced: m.out.produced, have: m.out.have, elsewhere: m.out.elsewhere, left: m.out.left });
    if (mstats.log.length > 40) mstats.log.splice(0, mstats.log.length - 40);
    m.resolve({ ...m.out });
  };

  /** 层表 `map` 里这条流别的候选,有没有哪一个的清单把分段 `[from, to]` 整个盖住、块都在。回那个候选的结果键 */
  const coveredBy = async (c: Ctx, spec: PageStreamSpec, map: unknown, from: number, to: number, dense = true): Promise<string | null> => {
    const row = c.rows.get(spec.streamKey) ?? pageStreamRow(c.project, spec);
    for (const cand of layerStreamCandidates(map, row)) {
      if (cand.resultKey === spec.streamKey) continue;
      const spans = candidateSpans(cand, from, to);
      if (!spans?.length) continue;
      let all = true;
      for (const [a, b] of spans) if (!(await deps.lookupOther(cand.resultKey, { from: a, to: b }, { dense }).catch(() => false))) { all = false; break; }
      if (all) return cand.resultKey;
    }
    return null;
  };

  /** 把本页有份的那几行并进层表;没有变化不写 */
  const syncRows = async (c: Ctx): Promise<void> => {
    c.rowsAt = deps.now();
    if (!c.mine.size) return;
    try {
      const existing = await deps.readLayerMap(c.project);
      if (ctx !== c) return;
      const listed = (key: string, row: PageStreamRow) => layerStreamCandidates(existing, row).some((x) => x.resultKey === key);
      const rows: PageStreamRow[] = [];
      for (const spec of c.specs ?? []) {
        if (!c.mine.has(spec.streamKey)) continue;
        const row = c.rows.get(spec.streamKey) ?? pageStreamRow(c.project, spec);
        // 本页的这一行不在表里(还没写过,或被别的写层表的一方盖掉了),而表里这张卡已经有别人整条产好的流:不写回去
        if (!listed(spec.streamKey, row) && await coveredBy(c, spec, existing, spec.firstSegment, spec.lastSegment)) {
          if (ctx !== c) return;
          c.mine.delete(spec.streamKey);
          counters.rowsYielded++;
          continue;
        }
        rows.push(row);
      }
      if (ctx !== c || !rows.length) return;
      const body = mergeLayerStreams(existing, { project: c.project as Record<string, any>, rows, now: deps.now() });
      if (!body) return;
      await deps.writeLayerMap(c.project, body);
      counters.rowsWritten++;
    } catch (e) {
      counters.rowsFailed++;
      fail(e);
      // 没写成:下一拍再核对
      c.rowsAt = -Infinity;
    }
  };

  /** 先查:这一段的结果在不在。回查到的结果键(自己的或别的候选的),没有回 null */
  const check = async (c: Ctx, job: Job): Promise<{ resultKey: string; own: boolean } | null> => {
    const range = { from: job.task.range!.from, to: job.task.range!.to };
    // 稀疏的一趟:每个分段有一版就算有;满密度的一趟要每个分段都是满密度
    const dense = !sparse(job.pass);
    if (await deps.lookupOwn(job.task, { dense }).catch(() => false)) return { resultKey: job.task.resultKey, own: true };
    let map: unknown = null;
    try { map = await deps.readLayerMap(c.project); } catch { return null; }
    const other = await coveredBy(c, job.spec, map, range.from, range.to, dense);
    return other ? { resultKey: other, own: false } : null;
  };

  const settle = (c: Ctx, job: Job, found: { resultKey: string; own: boolean }) => {
    job.state = found.own ? "have" : "elsewhere";
    job.via = found.resultKey;
    if (found.own) { counters.have++; c.mine.add(job.spec.streamKey); } else counters.elsewhere++;
    alive(found.resultKey);
  };

  /** 这几条流在这一趟的任务(稀疏的一趟出稀疏流任务,id 末尾多 `:sparse`;与切分方出的逐字段相同) */
  const jobsOf = (c: Ctx, specs: readonly PageStreamSpec[], pass: PageStreamPass, passIndex: number): Job[] =>
    specs.flatMap((spec) => pageStreamTasks(spec, { projectId: c.plan.projectId, projectRev: c.plan.projectRev, codeVersion: deps.codeVersion ?? null,
      derivedFrom: c.measure ? null : c.plan.id, density: sparse(pass) ? "sparse" : null })
      .map((task): Job => ({ task, spec, pass, passIndex, state: "todo", fails: 0, retryAt: -Infinity, via: null })));

  const loadSpecs = async (c: Ctx) => {
    working = true;
    phase = "planning";
    c.specsAt = deps.now();
    try {
      const got = await deps.specs(c.plan);
      if (ctx !== c || !got) return;
      c.specs = got.specs;
      c.skipped = got.skipped;
      c.project = got.project;
      c.rows = new Map(got.specs.map((spec) => [spec.streamKey, pageStreamRow(got.project, spec)]));
      c.jobs = effectivePasses().flatMap((pass, passIndex) => jobsOf(c, got.specs, pass, passIndex));
    } catch (e) {
      fail(e);
    } finally {
      working = false;
      phase = null;
    }
  };

  const taken = (c: Ctx) => c.probe.state === "claimed" || c.probe.state === "done";

  const pollPlan = (c: Ctx) => {
    const now = deps.now();
    // `done` 是终态:切分方接了这一版,不用再问(再发布过了保留期的任务会把它重新建出来)
    if (c.probe.flying || c.probe.state === "done" || now - c.probe.at < pollMs) return;
    c.probe.flying = true;
    c.probe.at = now;
    counters.probes++;
    void deps.planState().then((s) => { if (ctx === c) c.probe.state = s; }, () => { if (ctx === c) c.probe.state = "none"; }).finally(() => { c.probe.flying = false; });
  };

  const start = (c: Ctx, job: Job): Promise<void> => {
    const r: Run = { job, controller: new AbortController(), yieldCause: null, yieldAt: null, stop: null, recheckAt: deps.now() + recheckMs, rechecking: false };
    run = r;
    counters.starts++;
    let work: Promise<"done" | "yielded">;
    try {
      work = deps.produce({ task: job.task, project: c.project, stride: job.pass.stride, signal: r.controller.signal, yielding: () => r.yieldCause !== null || r.stop !== null });
    } catch (e) { work = Promise.reject(e); }
    return work.then((out) => {
      if (out === "done") {
        job.state = "produced";
        job.via = job.task.resultKey;
        counters.produced++;
        consecutiveErrors = 0;
        alive(job.task.resultKey);
        // 这一段的清单进了内容库:马上核对一次层表里本页的那一行
        if (ctx === c) c.rowsAt = -Infinity;
      } else if (r.stop) bump(counters.stops, r.stop);
      else bump(counters.yields, r.yieldCause ?? "urgent");
    }, (e) => {
      if (r.controller.signal.aborted) {
        counters.aborts++;
        if (r.stop) bump(counters.stops, r.stop); else bump(counters.yields, r.yieldCause ?? "hidden");
        return;
      }
      fail(e);
      job.fails++;
      consecutiveErrors++;
      // 做不成:退避后再试,连着不成就放下这一段(这一版里)
      if (job.fails >= PAGE_STREAM_ATTEMPTS || (e as { retryable?: boolean })?.retryable === false || (isLow() && consecutiveErrors >= 3)) {
        job.state = "failed";
        counters.failed++;
      } else {
        job.retryAt = deps.now() + 2000 * job.fails;
      }
    }).finally(() => { if (run === r) run = null; });
  };

  /** 挑下一段:先查,查不到、还闲、还没人接活才开工 */
  const step = async (c: Ctx) => {
    working = true;
    phase = "checking";
    try {
      const now = deps.now();
      // 一趟一趟来:前面的趟(稀疏)还有没落定的任务时,后面的趟(满密度)不开工 —— 在退避的也算没落定,等它
      const todo = c.jobs.filter((j) => j.state === "todo");
      const pass = todo.reduce((min, j) => Math.min(min, j.passIndex), Infinity);
      const job = todo.find((j) => j.passIndex === pass && now >= j.retryAt);
      if (!job) return;
      const found = await check(c, job);
      if (ctx !== c) return;
      if (found) { settle(c, job, found); if (found.own) await syncRows(c); return; }
      if (taken(c) || !deps.isIdle() || !deps.capable()) return;
      if (isLow()) {
        if (consecutiveErrors >= 3) {
          job.state = "failed";
          counters.failed++;
          return;
        }
        const supported = await checkEncoderSupported(job.spec);
        if (!supported) {
          job.state = "failed";
          counters.failed++;
          return;
        }
      }
      // 开工前把这一行写进层表:别的页面(和本页的在线来源)据此找这条流的清单
      if (!c.mine.has(job.spec.streamKey)) { c.mine.add(job.spec.streamKey); await syncRows(c); }
      // 写的时候发现别人整条产好了(`syncRows` 把这条流从本页的名下拿掉了):不开工,下一拍先查会认它
      if (ctx !== c || run || taken(c) || !deps.isIdle() || !c.mine.has(job.spec.streamKey)) return;
      void start(c, job);
    } catch (e) {
      fail(e);
    } finally {
      working = false;
      phase = null;
    }
  };

  /** 产的途中再查一次:别处已经有了就做完当前帧停下,改用现成的 */
  const recheck = (c: Ctx, r: Run) => {
    const now = deps.now();
    if (r.rechecking || r.stop || now < r.recheckAt) return;
    r.rechecking = true;
    r.recheckAt = now + recheckMs;
    void check(c, r.job).then((found) => {
      if (!found || run !== r || ctx !== c || r.job.state !== "todo") return;
      stopRun("elsewhere");
      settle(c, r.job, found);
    }, () => {}).finally(() => { r.rechecking = false; });
  };

  const drop = (reason: string) => {
    stopRun(reason, true);
    ctx = null;
  };

  const newCtx = (plan: PublishedPlan, measure: boolean): Ctx =>
    ({ measure, plan, specs: null, rows: new Map(), skipped: {}, project: null, jobs: [], mine: new Set(), rowsAt: -Infinity, specsAt: -Infinity, probe: { state: "none", at: -Infinity, flying: false } });

  /** 遮罩等稀疏版到头了、或这一轮测量作废了:在产的做完当前这一帧就停(迟迟做不完照让路的时限中止),在等的那一次当场回 */
  const cutMeasure = (m: Measuring, why: "deadline" | "stale" | "stopped") => {
    const r = run;
    if (r && ctx?.measure) {
      if (!r.stop) r.stop = why;
      if (r.yieldAt === null) r.yieldAt = deps.now();
    }
    endMeasure(m, why);
  };

  /** 测量时这一张卡的稀疏那一趟:先查,没有才产。每一步之后看这一次还在不在等(到时了就不再往下做) */
  const runMeasure = async (m: Measuring): Promise<MeasureOutcome["result"]> => {
    const { req } = m;
    const eff = effectivePasses();
    const sparsePass = eff.findIndex(sparse);
    if (sparsePass < 0 || !req.clips.length) return "none";
    // 等本页当上节点(拿到指纹、探到编码器):最多 `measureReadyMs`,等不到这张卡归闲时
    const readyBy = deps.now() + measureReadyMs;
    for (;;) {
      let ok = false;
      try { ok = deps.capable() === true; } catch { ok = false; }
      if (ok) break;
      if (deps.now() >= readyBy) return "incapable";
      await nextTick();
      if (m.done) return "stopped";
    }
    // 这一份记账:同一个项目、同一版接着用(这一轮里一张卡一张卡地加);清单计划的那一份在的话先停掉、换下
    const id = `measure:${req.projectId}@${req.projectRev}`;
    if (!ctx || !ctx.measure || ctx.plan.id !== id) {
      if (run) {
        stopRun("measure", true);
        // 等它收尾(中止之后马上回)
        for (let i = 0; run && i < 40; i++) { await nextTick(); if (m.done) return "stopped"; }
        if (run) return "busy";
      }
      ctx = newCtx({ id, projectId: req.projectId, projectRev: req.projectRev, clips: [], at: deps.now() }, true);
      ctx.specs = [];
    }
    const c = ctx;
    const got = await deps.specs({ ...c.plan, clips: [...new Set([...req.heavy, ...req.clips])] });
    if (m.done) return "stopped";
    if (ctx !== c) return "interrupted";
    if (!got) return "incapable";
    c.project = got.project;
    Object.assign(c.skipped, got.skipped);
    const wanted = new Set(req.clips);
    const known = new Set((c.specs ?? []).map((spec) => spec.streamKey));
    const fresh = got.specs.filter((spec) => wanted.has(spec.topClipId) && !known.has(spec.streamKey));
    for (const spec of fresh) { c.specs!.push(spec); c.rows.set(spec.streamKey, pageStreamRow(got.project, spec)); }
    const mine = new Set(got.specs.filter((spec) => wanted.has(spec.topClipId)).map((spec) => spec.streamKey));
    c.jobs.push(...jobsOf(c, fresh, eff[sparsePass], sparsePass));
    const jobs = c.jobs.filter((j) => mine.has(j.spec.streamKey) && j.state === "todo");
    if (!jobs.length) return c.jobs.some((j) => mine.has(j.spec.streamKey)) ? "ok" : "none";
    m.out.left = jobs.length;
    let failed = false;
    for (const job of jobs) {
      if (job.state !== "todo") { m.out.left--; continue; }
      const found = await check(c, job);
      if (m.done) return "stopped";
      if (ctx !== c) return "interrupted";
      if (found) {
        settle(c, job, found);
        m.out.left--;
        if (found.own) { m.out.have++; await syncRows(c); if (m.done) return "stopped"; } else m.out.elsewhere++;
        continue;
      }
      // 开工前把这一行写进层表(本页的在线来源、别的页面据此找这条流的清单)
      if (!c.mine.has(job.spec.streamKey)) { c.mine.add(job.spec.streamKey); await syncRows(c); if (m.done) return "stopped"; }
      if (ctx !== c) return "interrupted";
      // 写的时候发现别人整条产好了:这一段下一次先查会认它,这里不产
      if (!c.mine.has(job.spec.streamKey)) continue;
      if (run) return "busy";
      if (isLow()) {
        if (consecutiveErrors >= 3) {
          job.state = "failed";
          counters.failed++;
          failed = true;
          break;
        }
        const supported = await checkEncoderSupported(job.spec);
        if (!supported) {
          job.state = "failed";
          counters.failed++;
          failed = true;
          break;
        }
      }
      await start(c, job);
      if (m.done) return "stopped";
      if (ctx !== c) return "interrupted";
      if ((job.state as TaskState) === "produced") { m.out.produced++; m.out.left--; await syncRows(c); if (m.done) return "stopped"; continue; }
      if ((job.state as TaskState) === "have" || (job.state as TaskState) === "elsewhere") { m.out.left--; continue; }
      // 没做成(页面隐藏中止、舞台出错):这张卡剩下的归闲时
      failed = true;
      break;
    }
    return failed ? "failed" : m.out.left > 0 ? "interrupted" : "ok";
  };

  return {
    tick() {
      const now = deps.now();
      // 测量时在等的那一次:时钟到头、这一轮作废,当场回
      const m = measuring;
      if (m && clock && now - clock.startedAt >= measureMaxMs) cutMeasure(m, "deadline");
      else if (m) { let stale = false; try { stale = m.req.stale?.() === true; } catch { stale = false; } if (stale) cutMeasure(m, "stale"); }
      if (tickWaiters.length) { const wake = tickWaiters; tickWaiters = []; for (const w of wake) w(); }
      const plan = deps.plan();
      let capable = false;
      try { capable = deps.capable() === true; } catch { capable = false; }
      // 测量时的那一份记账:清单计划发出来之前留着(没有计划不算「不产」);在等的那一次没回之前也不换
      const mc = ctx?.measure ? ctx : null;
      if (mc && capable && (measuring || !plan || plan.projectId !== mc.plan.projectId || plan.at < mc.plan.at)) {
        const r = run;
        if (r && r.yieldAt !== null && now - r.yieldAt >= YIELD_FRAME_MAX_MS && !r.controller.signal.aborted) r.controller.abort();
        // 本页的那几行还在不在层表里(同下)
        if (!measuring && !working && mc.mine.size && now - mc.rowsAt >= rowsMs) { working = true; void syncRows(mc).finally(() => { working = false; }); }
        return;
      }
      if (!plan || !capable) { if (ctx || run) drop(!plan ? "no-plan" : "incapable"); return; }
      if (!ctx || ctx.plan.id !== plan.id) {
        // 换了一版(或清单变了):旧一版在产的马上停(那一版的流多半已经过期)
        if (run) stopRun("plan-changed", true);
        ctx = newCtx(plan, false);
      }
      const c = ctx;
      const r = run;
      // 让路之后当前帧迟迟做不完(播放、拖动时后台活的门关了):不再等,中止
      if (r && r.yieldAt !== null && now - r.yieldAt >= YIELD_FRAME_MAX_MS && !r.controller.signal.aborted) r.controller.abort();
      if (!c.specs) { if (!working && now - c.specsAt >= 1000) void loadSpecs(c); return; }
      if (!c.jobs.length) return;
      const pending = c.jobs.some((j) => j.state === "todo");
      // 没活了就不再问队列(一条消息也不多发)
      if (pending || r) pollPlan(c);
      if (taken(c)) { if (r) stopRun("splitter"); return; }
      // 本页的那几行还在不在层表里(后写的会盖掉先写的)
      if (!working && c.mine.size && now - c.rowsAt >= rowsMs) { working = true; void syncRows(c).finally(() => { working = false; }); return; }
      if (r) { recheck(c, r); return; }
      if (!pending || working) return;
      if (c.probe.state !== "open" && c.probe.state !== "failed") return;
      if (now - c.plan.at < waitMs) return;
      let idle = false;
      try { idle = deps.isIdle() === true; } catch { idle = false; }
      if (!idle) return;
      void step(c);
    },
    yieldFor(cause) {
      const r = run;
      if (!r) return;
      if (cause === "hidden") { if (!r.yieldCause) r.yieldCause = cause; r.controller.abort(); return; }
      if (!r.yieldCause) { r.yieldCause = cause; r.yieldAt = deps.now(); }
    },
    running: () => run !== null || measuring !== null,
    measure(req) {
      const now = deps.now();
      mstats.calls++;
      const blank = (result: MeasureOutcome["result"]): MeasureOutcome => { bump(mstats.results, result); return { result, produced: 0, have: 0, elsewhere: 0, left: 0 }; };
      if (measuring) return Promise.resolve(blank("busy"));
      // 这一轮遮罩的时钟:第一次等稀疏版起算
      if (!clock || clock.round !== req.round) {
        clock = { round: req.round, startedAt: now };
        Object.assign(mstats, { round: req.round, startedAt: now, deadlineAt: now + measureMaxMs });
      }
      if (now - clock.startedAt >= measureMaxMs) return Promise.resolve(blank("deadline"));
      return new Promise<MeasureOutcome>((resolve) => {
        const m: Measuring = { req, at: now, done: false, resolve, out: { result: "ok", produced: 0, have: 0, elsewhere: 0, left: 0 } };
        measuring = m;
        void runMeasure(m).then((result) => endMeasure(m, result), (e) => { fail(e); endMeasure(m, "failed"); });
      });
    },
    stop(reason = "stopped") {
      const m = measuring;
      drop(reason);
      if (m) endMeasure(m, "stopped");
      if (tickWaiters.length) { const wake = tickWaiters; tickWaiters = []; for (const w of wake) w(); }
    },
    debug() {
      const c = ctx;
      const now = deps.now();
      let state: PageStreamsDebug["state"] = "off";
      if (c) {
        if (c.measure) state = run ? "producing" : "measuring";
        else if (!c.specs) state = "planning";
        else if (!c.jobs.length) state = "none";
        else if (run) state = "producing";
        else if (taken(c)) state = "taken";
        else if (!c.jobs.some((j) => j.state === "todo")) state = "done";
        else if (phase === "checking") state = "checking";
        else if ((c.probe.state !== "open" && c.probe.state !== "failed") || now - c.plan.at < waitMs) state = "waiting";
        else state = "idle-wait";
      }
      return {
        state, planId: c?.plan.id ?? null, planState: c?.probe.state ?? "none", waitedMs: c ? now - c.plan.at : null,
        streams: (c?.specs ?? []).map((s) => ({ clipId: s.topClipId, contentKey: s.contentKey, streamKey: s.streamKey, firstSegment: s.firstSegment, lastSegment: s.lastSegment, mine: c!.mine.has(s.streamKey) })),
        jobs: (c?.jobs ?? []).map((j) => ({ id: j.task.id, clipId: j.spec.topClipId, pass: j.pass.name, state: j.state, via: j.via, fails: j.fails })),
        skipped: { ...(c?.skipped ?? {}) },
        running: run ? { id: run.job.task.id, yield: run.yieldCause, stop: run.stop } : null,
        counters: { ...counters, yields: { ...counters.yields }, stops: { ...counters.stops } },
        measure: { ...mstats, active: measuring !== null, results: { ...mstats.results }, log: mstats.log.map((e) => ({ ...e, clips: [...e.clips] })) },
        lastError,
      };
    },
  };
}

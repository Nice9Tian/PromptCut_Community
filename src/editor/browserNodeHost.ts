/**
 * 在线页面的纯浏览器渲染节点的宿主(M7 契约 `docs/plan/m7-contract.md` 第 2、4、5、7 节):把 `src/online/browserNode.ts` 的编排
 * 接到这一页的连接、舞台、素材服务、页面内快照库与界面状态上。
 *
 * # 何时当节点(第 2 节)
 *
 * 每 `HOST_TICK_MS` 判一次 `browserNodeEligibility`(在线构建且嵌了代码版本、身份为电脑、不是最低一档、两个跨源舞台都握上手、Chromium、
 * 以成员身份连着云端项目、测量落定)。成立就开 render 连接当节点;不成立(退回单舞台、离开项目……)就放回全部、结束会话。
 * 身份为手机、或只有一个舞台的页面不当队列节点,但照样开 render 连接报到拿指纹、只为本页产稀疏版(2026-10-14 用户定);最低一档两样都不做。
 * 被踢(4003)、项目被删(4004)、报到被拒(`forbidden` / `not-chromium` / `bad-message`)之后这一页不再当节点。
 *
 * # render 连接与票据(第 5 节)
 *
 * 父页开(不放舞台里:舞台会互换角色),地址与页面连接相同。每建一次会话,在页面连接上现签一张
 * `auth.ticket { kind: 'conn', role: 'render', owner: { kind: 'browser' } }`(2 分钟),子协议 `promptcut.ticket.<票据>`;
 * 会话层 `createDocEndpoint`:保留期内传输断开就接续,不重交凭证;新会话在 `onOpen` 里报到(节点的 `start()`,带手里的认领)。
 * 票据不进地址、日志、诊断。
 *
 * # 闲的判据与让路(第 2 节、D8)
 *
 * `isIdle()`(父页判,舞台不判):后台活的门开着(页面可见、父页 rAF 不断档、父页 rIC 在回调,`backWorkGate`)、不在播放、不在拖动、
 * 离上一次播放或拖动已过 `INTERACTION_QUIET_MS`、单飞队列里没有更急的活(补跑、测量、探针)、有后台舞台。
 * 让路:播放开始 → `yieldFor('play')`,拖动开始 → `'drag'`(当前帧做完就放回);更急的后台活来了(生成快照那个单飞活收到 abort)
 * → `'urgent'`;页面隐藏或父页 rAF 断档 → `'hidden'`(不等当前帧,立即放回)。
 *
 * # 报忙(M7 D2 补充〔裁〕,`claude/queue-maint`)
 *
 * 手里没有认领、单飞队列里有更急的后台活(补跑、测量、探针)时,`busy()` 回 `'stage'`,节点据此按队列给的间隔发 `node.active`,
 * 它锁着的卡不因页面只是忙被别的节点接手。页面隐藏、父页 rAF 断档时回 null(那时后台活停着,锁照旧按产出算闲置)。
 *
 * # 一帧(第 4.3～4.5 节,D3、D5、D7)
 *
 * 认领到的第一帧开一个单飞活 `bake`(最不急),`pushProject('back', 隔离单卡工程, { reset })` 灌进后台舞台(走 stageBridge 的基线),
 * 再逐帧 `bakeFrame`;舞台的 `bake-frame` 事件带回压过的 HTML 与小尺寸 WebP。父页:解压 → 推素材服务(`snap`、`px`,D7 父页推)→
 * 块进页面内快照库(`snap/<hash>`、`px/<hash>`)、这一层的 `ranges` 写这一帧(写入即就绪,通知在线来源)。
 * 两档并行推;推的同时先把下一帧发给舞台(顺推、还闲时),每帧耗时是「舞台一帧」与「推两档的网络往返」取大,不是两者相加。
 * 全段齐后组清单(形状同桌面 `collectSnapshotResult`)、写内容库(失败只记诊断),`task.complete { ranges, ...清单 }`。
 * 这一段收尾(完成、失败、放回、丢认领)就交还后台舞台。
 *
 * # 一段流任务(`docs/plan/browser-stream-task.md` 第四处)
 *
 * 能不能产流:按当前项目的画幅与帧率问一次浏览器自带的编码器(`probeStreamEncoder`,整幅画面拼合后的尺寸),压得了才把能力位报真;
 * 画幅或帧率变了重问。认领到的流任务(切分方给浏览器的单卡流那一份)整段在 `bakeStream` 里做:
 *
 *   同一个单飞活 `bake`、同一份隔离单卡工程(`input.bake`)灌进后台舞台 → 任务范围里每个分段 15 帧:全局帧号减 `firstFrame` 得本地帧,
 *   不在卡的范围里的帧送一张全透明的画布;在范围里的向舞台 `bakeFrame` 要像素(`pixels: { rect: bound }`、不要 HTML、不要小尺寸),
 *   位图送进 `openStreamEncoder`、用完就关 → 开头文件与每个满了的分段算 sha256、推素材服务的像素那一类(`px`)→
 *   全部分段齐了组清单(`streamManifest`,形状同桌面 `collectStreamResult`),写内容库 `render-manifest`(键 `<结果键>:<起>-<止>`),再报完成。
 *
 * 舞台往返复用 `stageBake.ts` 的那一套(每帧前核后台位置、中途换了人就重灌重做、顺推时先发下一帧),另开一个不出小尺寸的实例,
 * 经一层薄包装把「要像素」加进它发的 `bakeFrame` 请求;位图在这里另存、用完或这一段收尾时关掉。
 * 让路:每帧前看节点要不要让路,要让就把编码器里已经满了的分段冲出来(没满的那一段丢掉)、放回;已推完的分段按任务 id 留着,
 * 重新认领同一段只补缺的分段。中止(页面隐藏、丢认领)直接关编码器。
 *
 * # 本页产流(任务书 `render-refactor-task.md`「甲二」;判据与次序在 `src/online/pageStreams.ts`)
 *
 * 线上没有能切分的节点接本页的清单计划时,本页自己把清单里能产的单卡流做出来,不经过任务队列:流的计划由 `pageStreamPlan.ts` 按那一版的
 * 已确认项目算(键与切分方算的相同),每一段照队列里那种流任务的形状组一个任务,交给上面同一个 `bakeStream`(同一份活、同一个编码器、
 * 同一份「已推完的分段」登记),清单同样写内容库;层表里本页的那一行由本页并进去。先查、让路、有切分方接了活就停,都在 `pageStreams.ts`。
 * 两条路共用后台舞台的同一份活:本页在产时节点不认领(`isIdle` 多一条),节点手里有认领时本页不产。
 * 每条流先产稀疏的一趟(每个分段只截第一帧)、所有流的稀疏版都落定了才补满密度。
 *
 * # 测量时就产稀疏版(`docs/semantics/mechanism/rendering.md`「测量」;次序与 50 秒的上限在 `pageStreams.ts` 的 `measure()`)
 *
 * 打开项目、加载遮罩下,测量方(`probeRunner.ts`)每测完一张卡调这里接的口子:这张卡判重、本页能单独产它的流,就紧接着把稀疏版产出来
 * (先查素材服务,有就直接用)。为此 render 连接**在测量落定之前就开**、照常报到拿指纹,但测量落定之前节点不认领、本页闲时那条路不动
 * (`settled` 为假时两边的 `isIdle` 都是假)——第 2 节「测量落定才当节点」的本意是测量期间后台舞台不被队列的活占着,这一点没有变〔裁〕。
 * 用哪一版项目:此刻的已确认版本(`deps.confirmed()`),按版本号留存;判重的片段取 `deps.heavyClips()`(与清单计划的清单同一个来源)。
 *
 * # 播放保活
 *
 * 播放、拖动时本页不产流、不认领(闲的判据),手里锁着的卡没有产出。这时 `busy()` 回 `'play'`,节点照队列给的间隔(10 秒)发
 * `node.active { busy: 'play' }`:队列据此不把本页锁着的卡判成闲置(闲置超 30 秒会被切分方接手、另一份作废重产)。
 * 页面隐藏、父页 rAF 断档时不发(同原来的规矩)。本页不经队列自己产的流没有锁、没有认领,别的页面只按产物先查,没有「接手」可言,不用保活。
 *
 * # 项目版本(D6)
 *
 * 清单计划发布前(`planPublisher` 的 `onPublish`)把此刻的已确认版本按版本号留在内存,最多 `KEPT_REVISIONS` 版;
 * 细任务先用留存的,没有再经 render 连接 `project.snapshot.get`,都没有就放回(`no-snapshot`)。
 *
 * # 诊断(第 7 节)
 *
 * `window.__pcBrowserNode()`:资格与原因、节点状态与计数(`browserNode.ts` 的 `debug()`)、推了几块 / 跳过几块 / 多少字节、
 * 小尺寸几帧、舞台每帧耗时 p50 / p95 与被门挡住的时长、连接状态、最近一次错误;`pageStreams` 是本页产流的状态与计数。
 */
import { alphaBoxOf, browserNodeEligibility, createBrowserNode, isChromiumUserAgent, isSparseStreamTask, mergeStreamManifest, streamManifest, streamManifestBlocks, streamManifestCovers, streamManifestPuts, streamTaskFrames, streamTaskStride,
  BROWSER_STREAM_ENCODER,
  type BrowserNode, type EligibilityInput, type FrameRecord, type NodeTask, type StreamInitMeta, type StreamManifestOut, type StreamRectLike, type StreamSegmentMeta } from "../online/browserNode";
import { openStreamEncoder, probeStreamEncoder } from "../render/streamEncode";
import { manifestBlocks, manifestCovers, manifestKey, snapshotManifest } from "../online/bakeTask";
import { createSnapUploader, sha256Hex, type SnapUploader } from "../online/snapUploader";
import { pageL2 } from "../online/l2";
import { getNodeCardInfo, setNodeCardEnvFingerprint } from "../online/nodeCardInfo";
import { startNodeCardInfoLive } from "./nodeCardInfoLive";
import { pageEnvironment } from "./pageEnvironment.mjs";
import { backWorkDiag } from "./backWorkGate";
import { runBackJob, urgentBackJobs } from "./stageJobs";
import { backRole, backStage, frontStage, onStageEvent, pushProject } from "./stageBridge";
import { getState, subscribe } from "../store/project";
import { isScrubbing, subscribeScrub } from "./timeline/useScrub";
import { docRequest, remoteAssetBase } from "./media/assetTiers";
import { currentSharedUrl, me, pageSession } from "./sync/syncManager";
import type { Project } from "../kernel/project";
import { createStageBaker } from "./stageBake";
import type { BakeFrameRequest, StageEvent, StageRpcClient } from "../render/stageRpc";
import { createPageStreams, type MeasureOutcome, type PlanState, type PublishedPlan } from "../online/pageStreams";
import { setCardMeasuredHook, type CardMeasuredInfo } from "./probeRunner";
import { pageStreamCodes, planPageStreams, type PageCardPlanValue } from "../online/pageStreamPlan";
import { projectCardGraph } from "../kernel/cardGraph.mjs";
import { withMediaRates } from "../kernel/clipTime.mjs";
import { flatPlanProject, withFlatNodes } from "../kernel/cutFlatten.mjs";
import { getCard, unknownCardClipIds } from "../kernel/registry";
import { sourceVersionsOf } from "./costIdentity";
import { fontFingerprintOf } from "../render/fontFingerprint";
// @ts-expect-error 无类型声明的 .mjs(浏览器与 Node 通用,只用 WebSocket 与计时器)
import { createDocEndpoint as createDocEndpointUntyped } from "../../server/render-node/session-link.mjs";

/** 多久判一次资格、节拍一次(认领与续约由会话自己按间隔节流) */
export const HOST_TICK_MS = 250;
/** 离上一次播放或拖动至少这么久才算闲(沿用桌面节点的 500 ms,`server/queue-idle.mjs`;三级数字) */
export const INTERACTION_QUIET_MS = 500;
/** 发布时留存的已确认版本最多几版(同执行器的 `PLAN_CACHE_SIZE`) */
export const KEPT_REVISIONS = 4;
/** 取项目快照最多等多久 */
export const SNAPSHOT_FETCH_MS = 30_000;
/** render 会话建不成 / 结束后重建的退避 */
const REDIAL_MIN_MS = 1000;
const REDIAL_MAX_MS = 30_000;
/** 推帧口径(契约第 4.3 节):逐帧顺推(探针 P2:DOM 独立卡与桌面 4 帧一批从头推等价、便宜 4～7 倍;画布卡不进浏览器) */
export const BAKE_MODE: "batch4" | "seq" = "seq";
/** 流任务已推完的分段按任务 id 留几段任务(让路后重新认领同一段只补缺的分段;同节点的 `RETAINED_TASKS`) */
const STREAM_KEPT_TASKS = 8;
/** 被踢、项目被删:不再重连(HT-a) */
const FATAL_CLOSE = new Set([4003, 4004]);

type DocEndpoint = {
  send(message: object): boolean;
  onMessage(handler: (message: Record<string, unknown>) => void): void;
  onOpen(handler: () => void): void;
  onResume(handler: () => void): void;
  onClose(handler: (info: { code: number; reason: string }) => void): void;
  onConnectFail(handler: (info: { code: number; reason: string }) => void): void;
  close(): void;
  readonly connected: boolean;
  stats(): { transport: string | null; resumes: number; [k: string]: unknown };
};
const createDocEndpoint = createDocEndpointUntyped as (options: Record<string, unknown>) => DocEndpoint;

/* ------------------------------------------------------------------ 模块级:给清单计划与在线来源用 */

/** 发布时留存的已确认版本:版本号 → 项目(只读,不改) */
const kept = new Map<number, Project>();
/** D6:清单计划发布前留存这一版 */
export function keepConfirmedProject(rev: number, project: Project | null): void {
  if (!Number.isSafeInteger(rev) || rev <= 0 || !project) return;
  kept.delete(rev);
  kept.set(rev, project);
  while (kept.size > KEPT_REVISIONS) kept.delete(kept.keys().next().value as number);
}

let readyState: "none" | "pending" | "ready" = "none";
const readyListeners = new Set<() => void>();
const setReady = (next: "none" | "pending" | "ready") => {
  if (next === readyState) return;
  readyState = next;
  for (const l of [...readyListeners]) { try { l(); } catch { /* 订阅方坏了 */ } }
};
/** 本页的纯浏览器节点报到了没有(清单计划据此等,最多 3 s):不当节点 `none`、在报到 `pending`、拿到指纹 `ready` */
export function browserNodeReady(): "none" | "pending" | "ready" {
  return readyState;
}
export function subscribeBrowserNodeReady(cb: () => void): () => void {
  readyListeners.add(cb);
  return () => { readyListeners.delete(cb); };
}

/* ------------------------------------------------------------------ 宿主 */

export interface BrowserNodeHostDeps {
  /** 此刻当节点的条件(第 2 节) */
  eligibility: () => EligibilityInput;
  /** 此刻连着的共享项目 id */
  projectId: () => string | null;
  /** 本页产出并完成了这一段:在线来源把这个结果键认作活着(D12) */
  onAlive?: (resultKey: string) => void;
  /** 本页产流(「甲二」):本页最近发成的那一版清单计划(`planPublisher.ts` 的 `current()`);不给就不走本页产流这条路 */
  pagePlan?: () => PublishedPlan | null;
  /** 本页产流:问队列那一版计划此刻的状态(`planPublisher.ts` 的 `probe()`);问不到回 null */
  planState?: () => Promise<string | null>;
  /** 本页产流:这个结果键有了可用的流(本页产的、先查查到的),宿主叫在线来源认它、马上重取层表 */
  onPageStream?: (resultKey: string) => void;
  /** 测量时就产稀疏版:此刻本页判重的片段(与清单计划的清单同一个来源);不给就不在测量时产 */
  heavyClips?: () => readonly string[];
  /** 测量时就产稀疏版:此刻文档服务确认的那一版项目与版本号;没有回 null */
  confirmed?: () => { rev: number; project: Project } | null;
  /** 单舞台下产流后恢复前台舞台抑制与流平面 */
  restore?: () => void;
}

/**
 * 只为本页产稀疏版、不当队列节点:身份为手机(语义 `product/platforms.md`「渲染节点」:手机、平板也为本页产稀疏版),
 * 或只有一个舞台(没有后台舞台可以兼做节点)。最低一档两样都不做(连基准卡都跑不动,不在本页产流)。
 */
/** `stageLayout` 为 `pending`(按两个舞台开、还没都握上手)不算只有一个舞台 */
export function ownSparseOnly(e: Pick<EligibilityInput, "phone" | "lowest" | "stageLayout">): boolean {
  return !e.lowest && (e.phone || e.stageLayout === "single");
}

/**
 * 页面一侧的「卡片计划」原料,与导出页 `window.__pcCardPlan()` 同形(`src/ExportView.tsx`):卡片图、每张卡的源码版本、环境。
 * 切分方的键是拿导出页的这一份算的;本页产流拿这一份算,同一个项目、同一份代码两边就得出同一个键。
 * 字体指纹取本页文档已加载的字体(导出页取它自己文档的);两边加载的字体不一样时键不同,那条流切分方会当没有、按自己的键另产。
 */
export function pageCardPlanValue(project: Project): PageCardPlanValue | null {
  try {
    const fonts = typeof document !== "undefined" ? (document.fonts as unknown as Iterable<{ family: string; status: string }>) : null;
    // 剪辑段换成它里面的卡(`kernel/cutFlatten.mjs`),与导出页的 `__pcCardPlan` 同一份:两边算出同一个键
    const flat = flatPlanProject(project);
    return {
      // 变速段的素材节点补上倍率(kernel/clipTime.mjs 的 withMediaRates),与导出页的 `__pcCardPlan` 同一份
      graph: withFlatNodes(flat, withMediaRates(flat, projectCardGraph(flat, getCard))) as unknown as PageCardPlanValue["graph"],
      sourceVersions: sourceVersionsOf(),
      unknownClipIds: [...unknownCardClipIds(flat.tracks.flatMap((track) => track.clips))].sort(),
      environment: { width: project.width, height: project.height, fps: project.fps, theme: project.themeId, fontFingerprint: fontFingerprintOf(fonts) },
    };
  } catch {
    // 卡片图算不出来(悬空输入):这一版不产
    return null;
  }
}

const quantile = (sorted: number[], p: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;

async function sha256HexText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gunzip(buf: ArrayBuffer): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw Object.assign(new Error("浏览器没有 DecompressionStream"), { retryable: false });
  const stream = new Blob([buf]).stream().pipeThrough(new DS("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function startBrowserNodeHost(deps: BrowserNodeHostDeps): () => void {
  let stopped = false;
  let fatal: string | null = null;
  let node: BrowserNode | null = null;
  let nodeProject: string | null = null;
  let ep: DocEndpoint | null = null;
  let dialing = false;
  let redialAt = 0;
  let redialDelay = REDIAL_MIN_MS;
  let lastInteractionAt = -Infinity;
  let lastError: string | null = null;
  let eligibility: { ok: boolean; reason: string | null } = { ok: false, reason: "starting" };
  const nodeId = `browser-${pageSession()}`;
  const conn = { sessions: 0, opens: 0, closes: 0, resumes: 0, lastClose: null as { code: number; reason: string } | null };
  const stage = { frames: 0, ms: [] as number[], pausedMs: 0, remounts: 0, small: 0, smallMs: [] as number[], readyMs: [] as number[], errors: {} as Record<string, number> };
  /** 父页一侧每帧的时间构成(毫秒,最近 200 帧):开活与灌工程、舞台往返、解压、推两档、进页面内快照库 */
  const PHASES = ["lease", "rpc", "gunzip", "snap", "px", "push", "l2", "total"] as const;
  const phases = Object.fromEntries(PHASES.map((k) => [k, [] as number[]])) as Record<(typeof PHASES)[number], number[]>;
  const notePhase = (k: (typeof PHASES)[number], ms: number) => { const a = phases[k]; a.push(ms); if (a.length > 200) a.splice(0, a.length - 200); };
  const manifestStats = { written: 0, failed: 0, lastError: null as string | null };

  /* ---------------- 写票据与上传器(D7:父页推) ---------------- */

  let rw: { ticket: string; exp: number; issued: number } | null = null;
  /** 在签的那一次:两档并行推时同时来要票据,只签一张 */
  let rwSigning: Promise<string | null> | null = null;
  const rwTicket = (force = false): Promise<string | null> => {
    const now = Date.now();
    if (!force && rw && now < rw.issued + ((rw.exp - rw.issued) * 2) / 3) return Promise.resolve(rw.ticket);
    if (rwSigning) return rwSigning;
    rwSigning = signRw().finally(() => { rwSigning = null; });
    return rwSigning;
  };
  const signRw = async (): Promise<string | null> => {
    const now = Date.now();
    try {
      const r = await docRequest({ type: "auth.ticket", kind: "asset", access: "rw" });
      if (r.type === "auth.ticket.ok" && typeof r.ticket === "string") {
        rw = { ticket: r.ticket, exp: Number(r.exp) || now + 15 * 60_000, issued: now };
        return rw.ticket;
      }
    } catch { /* 签不到:上传回 401,按可重试失败交回 */ }
    return rw?.ticket ?? null;
  };
  const uploader: SnapUploader = createSnapUploader({ base: remoteAssetBase, ticket: rwTicket });
  const store = pageL2().catch(() => null);

  /* ---------------- 生成快照的活 ---------------- */

  /**
   * 活与每帧的舞台往返在 `stageBake.ts`(任务 F 拆出):单飞队列里的 `bake` 活、每帧前核后台位置(换了人就重灌)、
   * 顺推时先发下一帧、一帧中途换了人就在新舞台上重做。这里接着做一帧的后半段:解压、推素材服务、进页面内快照库。
   */
  const baker = createStageBaker({
    runBackJob: (kind, run) => runBackJob(kind, run),
    backStage, pushProject, onStageEvent,
    onUrgent: () => { node?.yieldFor("urgent"); pages.yieldFor("urgent"); },
    isIdle: () => isIdle(),
    mode: BAKE_MODE,
    now: () => performance.now(),
    notePhase: (k, ms) => notePhase(k, ms),
    noteError: (reason) => { stage.errors[reason] = (stage.errors[reason] ?? 0) + 1; },
  });
  const closeLease = () => { baker.close(); closeStreamLease(); };

  const bakeFrame = async ({ task, project, localFrame, signal }: { task: NodeTask; project: unknown; localFrame: number; signal: AbortSignal }) => {
    const t0 = performance.now();
    const { reply, event: ev } = await baker.bakeFrame({ task, project, localFrame, signal });
    stage.frames++;
    stage.ms.push(reply.ms);
    stage.readyMs.push(reply.readyMs);
    if (stage.ms.length > 200) { stage.ms.splice(0, stage.ms.length - 200); stage.readyMs.splice(0, stage.readyMs.length - 200); }
    stage.pausedMs += reply.pausedMs;
    if (reply.remounted) stage.remounts++;
    let tp = performance.now();
    const bytes = ev.htmlGz ? await gunzip(ev.htmlGz) : new Uint8Array(ev.htmlRaw ?? new ArrayBuffer(0));
    notePhase("gunzip", performance.now() - tp);
    if (bytes.length !== ev.bytes) throw Object.assign(new Error("解压后的快照字节数对不上"), { retryable: true });
    // 推素材服务:两档并行推(各自至少一次网络往返,互不依赖),两档都推成功才算这一帧做完(c10a 第 9 节)
    tp = performance.now();
    const timed = (k: "snap" | "px", work: Promise<unknown>) => work.then(() => notePhase(k, performance.now() - tp));
    const pushes = [timed("snap", uploader.put("snap", ev.hash, bytes, "html"))];
    if (ev.small) pushes.push(timed("px", uploader.put("px", ev.small.hash, new Uint8Array(ev.small.webp), "webp")));
    const settled = await Promise.allSettled(pushes);
    const bad = settled.find((x): x is PromiseRejectedResult => x.status === "rejected");
    if (bad) throw bad.reason;
    notePhase("push", performance.now() - tp);
    let small: { hash: string; bytes: number } | null = null;
    if (ev.small) {
      small = { hash: ev.small.hash, bytes: ev.small.bytes };
      stage.small++;
      stage.smallMs.push(reply.smallMs);
      if (stage.smallMs.length > 200) stage.smallMs.splice(0, stage.smallMs.length - 200);
    }
    // 自产的块进页面内快照库;这一层的 ranges 写这一帧(写入即就绪,在线来源据此换上)
    tp = performance.now();
    const s = await store;
    if (s) {
      await s.putBlock(`snap/${ev.hash}`, bytes, "text/html").catch(() => {});
      if (ev.small) await s.putBlock(`px/${ev.small.hash}`, new Uint8Array(ev.small.webp), "image/webp").catch(() => {});
      await s.putRange(task.resultKey, localFrame, localFrame).catch(() => {});
    }
    notePhase("l2", performance.now() - tp);
    notePhase("total", performance.now() - t0);
    return { hash: ev.hash, bytes: bytes.length, small };
  };

  /* ---------------- 流任务(browser-stream-task.md 第四处) ---------------- */

  /** 能不能产流:按「拼合后的画面尺寸 @ 帧率」探一次,记结果;画幅或帧率变了重探 */
  const streamCap = { key: "", capable: false, probing: false, mode: null as string | null, reason: null as string | null };
  const probeStreams = () => {
    const p = getState().project;
    // 流的矩形不超过整幅画面(单卡流的 bound 夹在画面范围里),宽高取偶
    const w = Math.max(2, Math.floor(Number(p?.width) || 0) & ~1), h = Math.max(2, Math.floor(Number(p?.height) || 0) & ~1);
    const fps = Math.max(1, Number(p?.fps) || 30);
    const key = `${w}x${h}@${fps}`;
    if (key === streamCap.key || streamCap.probing) return;
    streamCap.probing = true;
    void probeStreamEncoder({ width: w, height: h, fps }).then(
      (r) => { Object.assign(streamCap, { key, capable: r.supported === true, mode: r.mode ?? null, reason: r.reason ?? null }); },
      (e) => { Object.assign(streamCap, { key, capable: false, mode: null, reason: String((e as Error)?.message ?? e).slice(0, 120) }); },
    ).finally(() => { streamCap.probing = false; });
  };
  const streamStats = { tasks: 0, encoders: 0, frames: 0, blank: 0, segments: 0, inits: 0, bytes: 0, yields: 0, resumedSegments: 0, pixelsMs: [] as number[], encodeMs: [] as number[], lastError: null as string | null };
  /** 已推完的分段:任务 id → 这段任务的开头文件与分段登记(按插入顺序淘汰) */
  const streamKept = new Map<string, { inits: Record<string, StreamInitMeta>; segments: Record<number, StreamSegmentMeta> }>();
  /** 舞台交来、还没用的位图:会话号 + 本地帧 → 位图(用完、这一段收尾时关掉) */
  const pixelStash = new Map<string, ImageBitmap>();
  const dropPixels = () => { for (const b of pixelStash.values()) { try { b.close(); } catch { /* 已经关了 */ } } pixelStash.clear(); };
  /** 这一段流任务向舞台要的矩形(就是流的 bound);不在做流任务时为 null */
  let pixelRectNow: { x: number; y: number; w: number; h: number } | null = null;
  /** 给流任务用的舞台客户端:`bakeFrame` 的请求加上「要像素、不要 HTML、不要小尺寸」。同一台舞台回同一个包装(活按对象认舞台) */
  const pixelStages = new WeakMap<StageRpcClient, StageRpcClient>();
  const withPixels = (s: StageRpcClient | null): StageRpcClient | null => {
    if (!s) return null;
    let w = pixelStages.get(s);
    if (!w) {
      w = new Proxy(s, {
        get(target, key) {
          if (key === "bakeFrame") return (req: BakeFrameRequest) => target.bakeFrame({ ...req, small: false, html: false, ...(pixelRectNow ? { pixels: { rect: pixelRectNow } } : {}) });
          const v = Reflect.get(target, key, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      pixelStages.set(s, w);
    }
    return w;
  };
  let singleStageBaking = false;
  const restoreFrontFromBake = async () => {
    if (!singleStageBaking && backRole() !== "front") return;
    singleStageBaking = false;
    const stage = frontStage();
    if (stage) {
      try { await stage.setRole("front"); } catch { /* ignore */ }
      try { await pushProject("front", getState().project, { reset: true }); } catch { /* ignore */ }
    }
    try { deps.restore?.(); } catch { /* ignore */ }
  };

  const streamBaker = createStageBaker({
    runBackJob: (kind, run) => runBackJob(kind, async (ctx) => {
      const single = backRole() === "front";
      if (single) {
        singleStageBaking = true;
        try { await ctx.stage.setRole("back", { job: "bake" }); } catch { /* ignore */ }
      }
      try {
        return await run({ ...ctx, stage: withPixels(ctx.stage)! });
      } finally {
        if (single) {
          await restoreFrontFromBake();
        }
      }
    }),
    backStage: () => withPixels(backStage()),
    pushProject,
    // 位图不进活的事件表(它最多留 16 条、不关位图):这里另存,交给它的事件不带位图
    onStageEvent: (listener) => onStageEvent((e: StageEvent) => {
      if (e.type === "bake-frame" && e.pixels) {
        const key = `${e.session}#${e.localFrame}`;
        try { pixelStash.get(key)?.close(); } catch { /* 已经关了 */ }
        pixelStash.set(key, e.pixels.bitmap);
        listener({ ...e, pixels: null });
        return;
      }
      listener(e);
    }),
    onUrgent: () => { node?.yieldFor("urgent"); pages.yieldFor("urgent"); },
    isIdle: () => isIdle(),
    mode: BAKE_MODE,
    small: false,
    now: () => performance.now(),
    noteError: (reason) => { stage.errors[reason] = (stage.errors[reason] ?? 0) + 1; },
  });

  /** 交还流任务那一份活:停掉在推的帧、关掉还没用的位图 */
  const closeStreamLease = () => {
    streamBaker.close();
    dropPixels();
    pixelRectNow = null;
    if (singleStageBaking) {
      void restoreFrontFromBake();
    }
  };

  /**
   * `stride`:每几帧向舞台取一张。大于 1 时取到的那一张连着送 `stride` 次(分段的样本数不变),清单里这一段记这个 `stride`。
   * 不给时照任务的密度定(`streamTaskStride`):认领来的稀疏流任务(`input.density: 'sparse'`)是一个分段的帧数——每段只截分段的第一帧;
   * 满密度任务是 1。本页产流(`pageStreams.ts`)自己给。
   * 稀疏的一趟(`stride > 1`)另量每个分段的位置矩形(`box`,截的那一张里不透明像素的外接框,平面坐标),记进清单里这个分段的条目。
   */
  const bakeStream = async ({ task, project, signal, progress, yielding, stride: strideIn }: {
    task: NodeTask; project: unknown; signal: AbortSignal; progress: (frames: number) => void; yielding: () => boolean; stride?: number;
  }): Promise<{ manifest: Record<string, unknown> } | { yielded: true }> => {
    const stride = Number.isInteger(strideIn) && (strideIn as number) >= 1 ? (strideIn as number) : streamTaskStride(task);
    const plan = streamTaskFrames(task);
    if (!plan) throw Object.assign(new Error("任务没有 input.stream(切分方没给浏览器那一份的参数)"), { retryable: false });
    const { input } = plan;
    let kept = streamKept.get(task.id);
    if (!kept) {
      kept = { inits: {}, segments: {} };
      streamKept.set(task.id, kept);
      while (streamKept.size > STREAM_KEPT_TASKS) streamKept.delete(streamKept.keys().next().value as string);
    }
    const parts = kept;
    const expected = new Map(plan.segments.map((s) => [s.index, s.frames.length]));
    const framesOf = (done: (n: number) => boolean) => plan.segments.reduce((sum, s) => sum + (done(s.index) ? s.frames.length : 0), 0);
    /** 这一段已经有不比这一趟稀的分段(上一次推完的):不重做 */
    const have = (n: number) => !!parts.segments[n] && parts.segments[n].stride <= stride;
    /** 上一次认领里推完的分段(让路放回之后回来的):不重做 */
    const before = framesOf(have);
    streamStats.resumedSegments += plan.segments.filter((s) => have(s.index)).length;
    let fed = 0;
    progress(before);
    // 流任务用自己那份「活」向舞台要帧:范围按卡的本地帧给(它据此决定要不要先发下一帧)
    const frameTask: NodeTask = { ...task, range: { unit: "localFrame", from: 0, to: input.count - 1 } };
    const session = task.id;
    pixelRectNow = { ...input.bound };
    const blank = new OffscreenCanvas(input.bound.w, input.bound.h);
    const timescale = Math.round(input.fps);
    /** 稀疏的一趟里量到的位置矩形:分段号 → 框(平面坐标)/ null(那一张全透明);量不出来的不记 */
    const boxes = new Map<number, StreamRectLike | null>();
    const measureBox = (bitmap: ImageBitmap): StreamRectLike | null | undefined => {
      try {
        const w = bitmap.width, h = bitmap.height;
        if (!(w > 0) || !(h > 0)) return undefined;
        const canvas = new OffscreenCanvas(w, h);
        const g = canvas.getContext("2d", { willReadFrequently: true });
        if (!g) return undefined;
        g.drawImage(bitmap, 0, 0);
        const local = alphaBoxOf(g.getImageData(0, 0, w, h).data, w, h);
        if (!local) return null;
        // 位图和平面矩形一般一样大;不一样大(按倍率取的)就换算回平面坐标,往外取整
        const sx = input.bound.w / w, sy = input.bound.h / h;
        const x0 = Math.floor(local.x * sx), y0 = Math.floor(local.y * sy);
        const x1 = Math.min(input.bound.w, Math.ceil((local.x + local.w) * sx)), y1 = Math.min(input.bound.h, Math.ceil((local.y + local.h) * sy));
        return { x: input.bound.x + x0, y: input.bound.y + y0, w: x1 - x0, h: y1 - y0 };
      } catch { return undefined; }
    };
    // 缺的分段按连续的几段分组:每组一个编码器(每段段首是关键帧,组与组之间不相干)
    const runs: (typeof plan.segments)[] = [];
    for (const s of plan.segments) {
      if (have(s.index)) continue;
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1].index === s.index - 1) last.push(s); else runs.push([s]);
    }
    /** 稀疏的一趟里,`seg` 的第 `at` 个样本之后下一个要向舞台取的本地帧(同一组里;没有回 null) */
    const nextWanted = (seg: (typeof plan.segments)[number], at: number): number | null => {
      if (at + stride < seg.frames.length) return seg.frames[at + stride];
      for (const group of runs) {
        const i = group.indexOf(seg);
        if (i >= 0) return group[i + 1]?.frames[0] ?? null;
      }
      return null;
    };
    for (const group of runs) {
      let initId: string | null = null;
      streamStats.encoders++;
      const enc = await openStreamEncoder({
        width: input.bound.w, height: input.bound.h, fps: input.fps, firstSegment: group[0].index,
        onInit: async (init) => {
          const hash = await sha256Hex(init.bytes);
          await uploader.put("px", hash, init.bytes, "mp4");
          initId = hash.slice(0, 16);
          if (!parts.inits[initId]) { streamStats.inits++; streamStats.bytes += init.bytes.length; }
          parts.inits[initId] = { hash, bytes: init.bytes.length, codec: init.codec, width: init.width, height: init.height, timescale, rect: { ...input.bound }, encoder: BROWSER_STREAM_ENCODER };
        },
        onSegment: async (seg) => {
          // 没满的一段(让路时从编码器里冲出来的)不要:一个分段的样本数必须是它该有的那么多
          if (seg.samples !== expected.get(seg.index) || !initId) return;
          const hash = await sha256Hex(seg.bytes);
          await uploader.put("px", hash, seg.bytes, "m4s");
          parts.segments[seg.index] = { hash, bytes: seg.bytes.length, init: initId, stride, samples: seg.samples, sig: null, encoder: BROWSER_STREAM_ENCODER,
            ...(boxes.has(seg.index) ? { box: boxes.get(seg.index) ?? null } : {}) };
          streamStats.segments++;
          streamStats.bytes += seg.bytes.length;
        },
      });
      let finished = false;
      try {
        for (const seg of group) {
          for (let at = 0; at < seg.frames.length; at += stride) {
            const local = seg.frames[at];
            /** 这一张连着送几次(满密度时是 1) */
            const repeat = Math.min(stride, seg.frames.length - at);
            if (signal.aborted) throw Object.assign(new Error("已中止"), { retryable: true });
            if (yielding()) {
              // 让路:已经满了的分段冲出来(推完才算数),没满的那一段丢掉
              finished = true;
              await enc.finish().catch(() => {});
              streamStats.yields++;
              return { yielded: true };
            }
            const t0 = performance.now();
            if (local === null) {
              streamStats.blank += repeat;
              if (stride > 1 && at === 0) boxes.set(seg.index, null);
              for (let k = 0; k < repeat; k++) await enc.add(blank);
            } else {
              // 稀疏的一趟先发给舞台的是下一个要截的帧(下一个分段的第一帧),不是下一帧
              const { reply } = await streamBaker.bakeFrame({ task: frameTask, project, localFrame: local, signal, ...(stride > 1 ? { ahead: nextWanted(seg, at) } : {}) });
              const key = `${session}#${local}`;
              const bitmap = pixelStash.get(key);
              pixelStash.delete(key);
              if (!bitmap) throw Object.assign(new Error("舞台没有交出这一帧的像素"), { retryable: true });
              stage.frames++;
              stage.ms.push(reply.ms);
              stage.readyMs.push(reply.readyMs);
              if (stage.ms.length > 200) { stage.ms.splice(0, stage.ms.length - 200); stage.readyMs.splice(0, stage.readyMs.length - 200); }
              stage.pausedMs += reply.pausedMs;
              if (reply.remounted) stage.remounts++;
              streamStats.pixelsMs.push(reply.pixelsMs ?? 0);
              if (stride > 1 && at === 0) {
                const box = measureBox(bitmap);
                if (box !== undefined) boxes.set(seg.index, box);
              }
              const e0 = performance.now();
              try { for (let k = 0; k < repeat; k++) await enc.add(bitmap); } finally { try { bitmap.close(); } catch { /* 已经关了 */ } }
              streamStats.encodeMs.push(performance.now() - e0);
              if (streamStats.pixelsMs.length > 200) { streamStats.pixelsMs.splice(0, streamStats.pixelsMs.length - 200); streamStats.encodeMs.splice(0, Math.max(0, streamStats.encodeMs.length - 200)); }
            }
            notePhase("total", performance.now() - t0);
            fed += repeat;
            streamStats.frames += repeat;
            progress(before + fed);
          }
        }
        finished = true;
        await enc.finish();
      } catch (e) {
        if (!finished) enc.abort();
        streamStats.lastError = String((e as Error)?.message ?? e).slice(0, 200);
        throw e;
      }
    }
    for (const s of plan.segments) if (!have(s.index)) throw Object.assign(new Error(`分段 ${s.index} 没出齐`), { retryable: true });
    streamStats.tasks++;
    return { manifest: streamManifest(task as Parameters<typeof streamManifest>[0], parts) as unknown as Record<string, unknown> };
  };

  /**
   * 流任务全部分段齐后:清单写内容库(`render-manifest`,键 `<结果键>:<起>-<止>`);失败只记诊断(同快照、同桌面 writeManifest)。
   * 另按「8 段一桶」写(`streamManifestPuts`:桶的终点截到任务 `input.stream.lastFrame` 换算出的整条流的最后一段),读的一侧只按桶找。
   * 每一份先和内容库里已有的那一份合并(`mergeStreamManifest`):不降级(已有的满密度分段留着),相邻任务写进同一个桶的分段合在一起,
   * 稀疏的一趟量的位置矩形带到满密度的清单里。全部写成回 true。
   */
  const putStreamManifest = async (task: NodeTask, manifest: Record<string, unknown>): Promise<boolean> => {
    const puts = streamManifestPuts(task as Parameters<typeof streamManifestPuts>[0], manifest as unknown as StreamManifestOut);
    if (!puts.length) return false;
    let ok = true;
    for (const { key, body } of puts) {
      let merged: StreamManifestOut = body;
      try {
        const got = await docRequest({ type: "content.get", kind: "render-manifest", key });
        if (got.type === "content.item" && got.body) merged = mergeStreamManifest(got.body, body);
      } catch { /* 取不到就照新的写 */ }
      try {
        const r = await docRequest({ type: "content.put", kind: "render-manifest", key, body: merged });
        if (r.type === "content.stored") { manifestStats.written++; continue; }
        manifestStats.failed++;
        manifestStats.lastError = String(r.reason ?? r.type);
      } catch (e) {
        manifestStats.failed++;
        manifestStats.lastError = String((e as Error)?.message ?? e);
      }
      ok = false;
    }
    return ok;
  };
  const finishStream = async ({ task, manifest }: { task: NodeTask; manifest: Record<string, unknown> }) => {
    await putStreamManifest(task, manifest);
    streamKept.delete(task.id);
    return manifest;
  };

  const finishTask = async ({ task, frames }: { task: NodeTask; frames: FrameRecord[] }) => {
    const manifest = snapshotManifest(task as Parameters<typeof snapshotManifest>[0], frames);
    const key = manifestKey(task);
    try {
      const r = await docRequest({ type: "content.put", kind: "snapshot-manifest", key, body: manifest });
      if (r.type === "content.stored") manifestStats.written++;
      else { manifestStats.failed++; manifestStats.lastError = String(r.reason ?? r.type); }
    } catch (e) {
      // 写内容库失败只记诊断(同桌面 writeManifest):清单照样随 task.complete 交给订阅方
      manifestStats.failed++;
      manifestStats.lastError = String((e as Error)?.message ?? e);
    }
    return manifest as unknown as Record<string, unknown>;
  };

  /** 去重(第 4.1 节):内容库清单在、覆盖整段、两档齐、每块都在素材服务上 */
  const lookupResult = async (task: NodeTask) => {
    const key = manifestKey(task);
    if (!key) return null;
    if (task.kind === "stream") {
      // 流任务:内容库里这一段的流清单在、任务范围里的分段都列着、开头文件与分段都在素材服务上
      let found: unknown = null;
      try {
        const r = await docRequest({ type: "content.get", kind: "render-manifest", key });
        found = r.type === "content.item" ? r.body : null;
      } catch { return null; }
      // 满密度任务要每个分段都是满密度;稀疏流任务每段有一版就算数
      if (!streamManifestCovers(found, task as Parameters<typeof streamManifestCovers>[1], { dense: !isSparseStreamTask(task) })) return null;
      for (const b of streamManifestBlocks(found)) if (!(await uploader.has(b.ns, b.hash))) return null;
      return found as unknown as Record<string, unknown>;
    }
    let body: unknown = null;
    try {
      const r = await docRequest({ type: "content.get", kind: "snapshot-manifest", key });
      body = r.type === "content.item" ? r.body : null;
    } catch { return null; }
    if (!manifestCovers(body, task as Parameters<typeof manifestCovers>[1])) return null;
    for (const b of manifestBlocks(body)) if (!(await uploader.has(b.ns, b.hash))) return null;
    return body as unknown as Record<string, unknown>;
  };

  /* ---------------- 取项目快照(经 render 连接) ---------------- */

  const snapshotWaiters = new Map<string, (m: Record<string, unknown>) => void>();
  let snapSeq = 0;
  const fetchSnapshot = (rev: number): Promise<Project | null> => new Promise((resolve) => {
    const e = ep;
    const projectId = nodeProject;
    if (!e || !projectId) { resolve(null); return; }
    const reqId = `browser-snap-${++snapSeq}`;
    const parts: string[] = [];
    let count = -1;
    const finish = (p: Project | null) => { snapshotWaiters.delete(reqId); clearTimeout(timer); resolve(p); };
    const timer = setTimeout(() => finish(null), SNAPSHOT_FETCH_MS);
    snapshotWaiters.set(reqId, (m) => {
      if (m.type === "project.snapshot.part") {
        if (m.missing === true) { finish(null); return; }
        const i = Number(m.index);
        if (Number.isInteger(i) && typeof m.data === "string") { parts[i] = m.data; count = Number(m.count); }
      } else if (m.type === "project.snapshot.end") {
        const text = parts.join("");
        if (count >= 0 && parts.filter((x) => typeof x === "string").length !== count) { finish(null); return; }
        void sha256HexText(text).then((digest) => {
          if (digest !== m.digest) { finish(null); return; }
          try { finish(JSON.parse(text) as Project); } catch { finish(null); }
        }, () => finish(null));
      } else if (m.type === "error") {
        finish(null);
      }
    });
    if (!e.send({ type: "project.snapshot.get", projectId, projectRev: rev, reqId })) finish(null);
  });

  /* ---------------- 闲的判据与让路 ---------------- */

  const isIdle = (): boolean => {
    const bw = backWorkDiag();
    if (!bw.on) return false;
    if (getState().playing || isScrubbing()) return false;
    if (Date.now() - lastInteractionAt < INTERACTION_QUIET_MS) return false;
    if (urgentBackJobs() > 0) return false;
    if (!backStage()) return false;
    return true;
  };

  /**
   * 报忙(M7 D2 补充):手里没有认领时,后台舞台有没有更急的活在排着或跑着;
   * 播放保活:播放、拖动时本页不产不认领,回 `'play'`,队列不把本页锁着的卡判成闲置(文件头「播放保活」)。
   */
  const busy = (): string | null => {
    const bw = backWorkDiag();
    if (!bw.on && (bw.reason === "hidden" || bw.reason === "raf-gap")) return null;
    if (urgentBackJobs() > 0) return "stage";
    return getState().playing || isScrubbing() ? "play" : null;
  };
  /** 打开项目的那一轮测量落定了没有(每拍由 `loop` 更新):落定之前节点不认领、本页闲时那条路不动 */
  let settled = false;
  /** 当节点的条件除「测量落定」之外都成立(每拍由 `loop` 更新):render 连接开着 */
  let connectable = false;

  /* ---------------- 本页产流(「甲二」;判据与次序在 pageStreams.ts) ---------------- */

  /** 清单覆盖这一段、块都在素材服务上;`need.dense`(缺省要):每个分段都是每帧一张才算有,稀疏的一趟不要求 */
  const streamRangePresent = async (resultKey: string, range: { from: number; to: number }, need: { dense: boolean } = { dense: true }): Promise<boolean> => {
    let found: unknown = null;
    try {
      const r = await docRequest({ type: "content.get", kind: "render-manifest", key: `${resultKey}:${range.from}-${range.to}` });
      found = r.type === "content.item" ? r.body : null;
    } catch { return false; }
    const ref = { resultKey, range };
    if (!streamManifestCovers(found, ref)) return false;
    if (need.dense) for (let n = range.from; n <= range.to; n++) if (found.segments[n]?.stride !== 1) return false;
    for (const b of streamManifestBlocks(found)) if (!(await uploader.has(b.ns, b.hash))) return false;
    return true;
  };
  /** 层表在内容库里的键:`layers:<项目 id>`(与在线来源、与渲染节点写的同一个键) */
  const layerMapKey = (project: unknown): string => {
    const id = (project as Project | null)?.id;
    if (typeof id !== "string" || !id) throw new Error("项目没有 id,写不了层表");
    return `layers:${id}`;
  };
  const pages = createPageStreams({
    now: Date.now,
    capable: () => !!deps.pagePlan && !!node && !!node.envFingerprint && readyState === "ready" && streamCap.capable && pageStreamCodes() !== null,
    isIdle: () => settled && isIdle() && !node?.working(),
    plan: () => {
      const p = deps.pagePlan?.() ?? null;
      return p && p.projectId === nodeProject ? p : null;
    },
    planState: async () => {
      const s = await deps.planState?.();
      return s === "open" || s === "claimed" || s === "done" || s === "failed" ? (s as PlanState) : "none";
    },
    codeVersion: deps.eligibility().codeVersion ?? null,
    sparseOnly: () => ownSparseOnly(deps.eligibility()),
    waitMs: ownSparseOnly(deps.eligibility()) ? 0 : undefined,
    specs: async (plan) => {
      const project = kept.get(plan.projectRev) ?? null;
      const fp = node?.envFingerprint ?? null;
      if (!project || !fp) return null;
      const value = pageCardPlanValue(project);
      if (!value) return { specs: [], skipped: {}, project };
      const out = await planPageStreams({ project: project as unknown as Record<string, unknown>, value, clips: plan.clips, codes: pageStreamCodes(), envFingerprint: fp });
      return { ...out, project };
    },
    lookupOwn: async (task, need) => !!task.range && streamRangePresent(task.resultKey, task.range, need),
    lookupOther: streamRangePresent,
    readLayerMap: async (project) => {
      const r = await docRequest({ type: "content.get", kind: "snapshot-manifest", key: layerMapKey(project) });
      if (r.type !== "content.item") throw new Error(`取层表:${String(r.reason ?? r.type)}`);
      return r.missing ? null : (r.body ?? null);
    },
    writeLayerMap: async (project, body) => {
      const r = await docRequest({ type: "content.put", kind: "snapshot-manifest", key: layerMapKey(project), body });
      if (r.type !== "content.stored") throw new Error(`写层表:${String(r.reason ?? r.type)}`);
    },
    produce: async ({ task, project, stride, signal, yielding }) => {
      try {
        const out = await bakeStream({ task, project, signal, progress: () => {}, yielding, stride });
        if (!("manifest" in out)) return "yielded";
        // 清单没写进内容库,这一段别人就找不到:按做不成算(已推完的分段留着,下次只差写清单)
        if (!(await putStreamManifest(task, out.manifest))) throw Object.assign(new Error(`流清单没写进内容库:${manifestStats.lastError ?? "?"}`), { retryable: true });
        streamKept.delete(task.id);
        return "done";
      } finally {
        closeLease();
      }
    },
    onAlive: (resultKey) => {
      try { deps.onAlive?.(resultKey); } catch { /* 宿主坏了 */ }
      try { deps.onPageStream?.(resultKey); } catch { /* 宿主坏了 */ }
    },
  });
  /* ---------------- 测量时就产稀疏版(文件头同名一节) ---------------- */

  const measureStats = { calls: 0, skipped: {} as Record<string, number>, last: null as (MeasureOutcome & { cardId: string; clips: string[]; ms: number }) | null };
  const onCardMeasured = async (info: CardMeasuredInfo): Promise<void> => {
    measureStats.calls++;
    const skip = (why: string) => { measureStats.skipped[why] = (measureStats.skipped[why] ?? 0) + 1; };
    // 不当节点的页面(手机身份、退回单舞台、不是 Chromium、开发构建)不产;没有本页产流这条路也不产
    const projectId = deps.projectId();
    if (!connectable || !projectId || !deps.heavyClips || !deps.confirmed || !deps.pagePlan) { skip("no-node"); return; }
    const heavy = [...deps.heavyClips()];
    const clips = info.clipIds.filter((id) => heavy.includes(id));
    if (!clips.length) { skip("light"); return; }
    const at = deps.confirmed();
    if (!at || !Number.isSafeInteger(at.rev) || at.rev <= 0) { skip("no-confirmed"); return; }
    keepConfirmedProject(at.rev, at.project);
    const t0 = Date.now();
    const out = await pages.measure({ round: info.round, projectId, projectRev: at.rev, clips, heavy, stale: info.stale });
    measureStats.last = { ...out, cardId: info.cardId, clips, ms: Date.now() - t0 };
  };
  const offMeasured = setCardMeasuredHook(onCardMeasured);

  /** 让路:认领来的任务与本页产流同一套规矩 */
  const yieldAll = (cause: "play" | "drag" | "urgent" | "hidden") => { node?.yieldFor(cause); pages.yieldFor(cause); };

  let wasPlaying = !!getState().playing;
  const offStore = subscribe(() => {
    const playing = !!getState().playing;
    if (playing) lastInteractionAt = Date.now();
    if (playing && !wasPlaying) yieldAll("play");
    if (!playing && wasPlaying) lastInteractionAt = Date.now();
    wasPlaying = playing;
  });
  let wasScrubbing = isScrubbing();
  const offScrub = subscribeScrub(() => {
    const s = isScrubbing();
    lastInteractionAt = Date.now();
    if (s && !wasScrubbing) yieldAll("drag");
    wasScrubbing = s;
  });
  const onVisibility = () => { if (typeof document !== "undefined" && document.visibilityState === "hidden") yieldAll("hidden"); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  /*
   * 冻结(M7 探针 P5):冻结只发生在隐藏之后,D8 已经放回;`freeze` 事件来时再尽力放回一次(切走约 2 s 后到,还发得出消息)。
   * 冻结恢复时 Chrome 会关掉 WebSocket,手里的认领在冻结超过租约时已经丢了:`resume` 一律当一次重连 —— 结束这条会话、马上重建、重新报到。
   */
  const onFreeze = () => { yieldAll("hidden"); };
  const onResume = () => {
    conn.resumes++;
    const e = ep;
    if (!e) return;
    ep = null;
    if (readyState === "ready") setReady("pending");
    for (const w of [...snapshotWaiters.values()]) w({ type: "error" });
    try { e.close(); } catch { /* 已经关了 */ }
    redialAt = 0;
    redialDelay = REDIAL_MIN_MS;
  };
  if (typeof document !== "undefined") { document.addEventListener("freeze", onFreeze); document.addEventListener("resume", onResume); }
  const onPageHide = () => teardown("pagehide");
  if (typeof window !== "undefined") window.addEventListener("pagehide", onPageHide);

  /* ---------------- render 连接 ---------------- */

  const dial = async () => {
    if (stopped || fatal || dialing || ep || !node) return;
    const url = currentSharedUrl();
    if (!url) return;
    dialing = true;
    let ticket: string | null = null;
    try {
      const r = await docRequest({ type: "auth.ticket", kind: "conn", role: "render", owner: { kind: "browser" } });
      if (r.type === "auth.ticket.ok" && typeof r.ticket === "string") ticket = r.ticket;
      else lastError = `签 render 票据被拒:${String(r.reason ?? r.type)}`;
    } catch (e) {
      lastError = `签 render 票据失败:${String((e as Error)?.message ?? e)}`;
    }
    dialing = false;
    if (stopped || fatal || !node || !ticket) { scheduleRedial(); return; }
    const protocols = ["promptcut.v1", `promptcut.ticket.${ticket}`];
    let e: DocEndpoint;
    try {
      e = createDocEndpoint({ url, protocols: () => protocols, transport: "ws", renew: false, backoff: { baseMs: 500, factor: 2, maxMs: 5000, jitter: 0.2 } });
    } catch (err) {
      lastError = `建 render 会话失败:${String((err as Error)?.message ?? err)}`;
      scheduleRedial();
      return;
    }
    ep = e;
    conn.sessions++;
    e.onOpen(() => {
      if (ep !== e || !node) return;
      conn.opens++;
      redialDelay = REDIAL_MIN_MS;
      node.start();
    });
    e.onMessage((m) => {
      if (ep !== e || !m || typeof m !== "object") return;
      const reqId = typeof m.reqId === "string" ? m.reqId : null;
      const w = reqId ? snapshotWaiters.get(reqId) : undefined;
      if (w) { w(m); return; }
      node?.receive(m);
      if (m.type === "node.welcome" && node?.envFingerprint) setReady("ready");
    });
    const gone = (info: { code: number; reason: string }) => {
      if (ep !== e) return;
      ep = null;
      conn.closes++;
      conn.lastClose = { code: info.code, reason: String(info.reason ?? "").slice(0, 80) };
      if (readyState === "ready") setReady("pending");
      for (const w of [...snapshotWaiters.values()]) w({ type: "error" });
      if (FATAL_CLOSE.has(info.code)) { fatal = `closed-${info.code}`; teardown(fatal); return; }
      scheduleRedial();
    };
    e.onClose(gone);
    e.onConnectFail(gone);
  };
  const scheduleRedial = () => {
    if (stopped || fatal) return;
    redialAt = Date.now() + redialDelay;
    redialDelay = Math.min(REDIAL_MAX_MS, redialDelay * 2);
  };

  const openNode = (projectId: string) => {
    nodeProject = projectId;
    setReady("pending");
    node = createBrowserNode({
      nodeId, projectId, userId: me().userId ?? "", codeVersion: deps.eligibility().codeVersion ?? null, environment: pageEnvironment(),
      // 本页自己在产流时不认领:两条路共用后台舞台的同一份活
      // 测量落定之前不认领(连接先开着,为的是测量时就能产稀疏版);只为本页产稀疏版的(手机、单舞台)绝不当队列节点
      now: Date.now, isIdle: () => !ownSparseOnly(deps.eligibility()) && settled && isIdle() && !pages.running(), busy,
      send: (m) => ep?.send(m) ?? false,
      keptProject: (rev) => kept.get(rev) ?? null,
      fetchSnapshot, bakeFrame, finishTask, lookupResult,
      streams: () => streamCap.capable, bakeStream, finishStream,
      onTaskEnd: (task, outcome) => {
        closeLease();
        if (outcome === "completed" || outcome === "dedup") { try { deps.onAlive?.(task.resultKey); } catch { /* 宿主坏了 */ } }
      },
      onFingerprint: () => setReady("ready"),
      // 块 N:能执行用户卡与素材效果卡时的登记(运行时版本、能力位、卡片代码身份),与文档服务回的 cardEnvFingerprint
      cardInfo: () => getNodeCardInfo(),
      onCardEnvFingerprint: (fp) => setNodeCardEnvFingerprint(fp),
      onRefused: (reason) => { fatal = `refused-${reason}`; lastError = `报到被拒:${reason}`; teardown(fatal); },
    });
    redialAt = 0;
    redialDelay = REDIAL_MIN_MS;
  };

  let lastStop: { reason: string; at: number; debug: ReturnType<BrowserNode["debug"]> } | null = null;
  /** 下线:放回全部、结束会话(第 2 节「下线」) */
  function teardown(reason: string) {
    const n = node;
    node = null;
    nodeProject = null;
    if (n) { try { n.stop(); } catch { /* 连接已坏 */ } lastStop = { reason, at: Date.now(), debug: n.debug() }; }
    pages.stop(reason);
    closeLease();
    setNodeCardEnvFingerprint(null);
    const e = ep;
    ep = null;
    // 放回的消息先发出去再关(会话层 close 先发 session.close)
    if (e) setTimeout(() => { try { e.close(); } catch { /* 已经关了 */ } }, 50);
    setReady("none");
  }

  /**
   * 打开项目的那一轮测量落定过的项目(第 2 节「打开项目的测量已落定(加载遮罩撤下)」)。之后新加的卡在后台舞台里补测时
   * 不下线 —— 那是单飞队列里更急的活,由 `isIdle()` 让它先行,不必结束会话再重连。
   */
  const measuredProjects = new Set<string>();
  const loop = () => {
    if (stopped) return;
    const projectId = deps.projectId();
    const raw = deps.eligibility();
    if (raw.measured && projectId) measuredProjects.add(projectId);
    const input = projectId && measuredProjects.has(projectId) ? { ...raw, measured: true } : raw;
    eligibility = browserNodeEligibility(input);
    const sparseOnly = ownSparseOnly(raw);
    settled = eligibility.ok || (sparseOnly && !!raw.measured);
    const ownCanConnect = sparseOnly && !!raw.online && !!raw.codeVersion && !!raw.member && isChromiumUserAgent(raw.userAgent);
    // 别的条件都成立、只差测量没落定:连接先开、照常报到拿指纹(测量时就产稀疏版要它),不认领(`settled` 为假)
    // 身份为手机、只有一个舞台的页面满足在线成员条件时允许开 render 连接报到拿指纹供本页算流键、产本页的稀疏版,但不认领队列任务
    connectable = !fatal && !!projectId && (eligibility.ok || eligibility.reason === "measuring" || ownCanConnect);
    if (!connectable || !projectId) {
      if (node) teardown(fatal ?? eligibility.reason ?? "no-project");
      // 测量方还在等的那一次要有人推时钟
      try { pages.tick(); } catch (e) { lastError = String((e as Error)?.message ?? e); }
      return;
    }
    if (node && nodeProject !== projectId) teardown("project-changed");
    if (!node) openNode(projectId);
    probeStreams();
    if (!ep && !dialing && Date.now() >= redialAt) void dial();
    // 页面隐藏、父页 rAF 断档:不等当前帧,立即放回(D8)
    const bw = backWorkDiag();
    if (!bw.on && (bw.reason === "hidden" || bw.reason === "raf-gap")) yieldAll("hidden");
    if (getState().playing || isScrubbing()) lastInteractionAt = Date.now();
    try { node?.tick(); } catch (e) { lastError = String((e as Error)?.message ?? e); }
    try { pages.tick(); } catch (e) { lastError = String((e as Error)?.message ?? e); }
  };
  const timer = setInterval(loop, HOST_TICK_MS);
  // 块 N:本页能运行哪些用户卡与素材效果卡的登记(随注册表、闸门、图形能力更新)
  const offCardInfo = startNodeCardInfoLive();
  loop();

  const w = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : null;
  if (w) {
    w.__pcBrowserNode = () => {
      const d = node?.debug() ?? null;
      const ms = [...stage.ms].sort((a, b) => a - b);
      const sm = [...stage.smallMs].sort((a, b) => a - b);
      const up = uploader.stats();
      return {
        eligibility, fatal, ready: readyState, nodeId,
        state: d?.state ?? "off", reason: d?.reason ?? (fatal ?? eligibility.reason),
        envFingerprint: d?.envFingerprint ?? null, codeVersion: d?.codeVersion ?? null, holding: d?.holding ?? [],
        cardEnvFingerprint: d?.cardEnvFingerprint ?? null, cards: d?.cards ?? null,
        counters: d?.counters ?? null,
        idle: node ? isIdle() : false,
        stage: {
          frames: stage.frames, remounts: stage.remounts, pausedMs: Math.round(stage.pausedMs), errors: { ...stage.errors },
          // 换过几次后台舞台、一帧中途换了人重做几次、灌了几次隔离单卡工程(stageBake.ts)
          restage: baker.diag(),
          frameMs: { p50: quantile(ms, 0.5), p95: quantile(ms, 0.95) },
          smallFrames: stage.small, smallMs: { p50: quantile(sm, 0.5), p95: quantile(sm, 0.95) },
          phases: Object.fromEntries(PHASES.map((k) => { const a = [...phases[k]].sort((x, y) => x - y); return [k, { n: a.length, p50: quantile(a, 0.5), p95: quantile(a, 0.95) }]; })),
        },
        upload: { pushed: up.pushed, skipped: up.skipped, bytes: up.pushedBytes, failed: up.failed, reauth: up.reauth, recheck: up.recheck, lastError: up.lastError, ms: up.ms },
        manifests: { ...manifestStats },
        // 流任务:能不能压(按哪种画面探的、用哪种码率模式)、做了几段任务、送了几帧(其中全透明几帧)、推了几个分段与开头文件、让路几次
        streams: (() => {
          const px = [...streamStats.pixelsMs].sort((a, b) => a - b), en = [...streamStats.encodeMs].sort((a, b) => a - b);
          return { capable: streamCap.capable, probe: streamCap.key || null, mode: streamCap.mode, reason: streamCap.reason,
            // 起过几个编码器(两条路合计;「先查到了就不产」的验收看它)
            encoders: streamStats.encoders,
            tasks: streamStats.tasks, frames: streamStats.frames, blank: streamStats.blank, segments: streamStats.segments, inits: streamStats.inits, bytes: streamStats.bytes,
            yields: streamStats.yields, resumedSegments: streamStats.resumedSegments, kept: streamKept.size, restage: streamBaker.diag(),
            pixelsMs: { p50: quantile(px, 0.5), p95: quantile(px, 0.95) }, encodeMs: { p50: quantile(en, 0.5), p95: quantile(en, 0.95) }, lastError: streamStats.lastError };
        })(),
        // 本页产流(不经队列):状态、这一版的流与每一段的去向、计数
        pageStreams: pages.debug(),
        // 测量时就产稀疏版:口子被调了几次、没进 `measure()` 的原因、最近一次的结果
        measureSparse: { calls: measureStats.calls, skipped: { ...measureStats.skipped }, last: measureStats.last, settled, connectable },
        connection: { connected: !!ep?.connected, transport: ep?.stats().transport ?? null, ...conn },
        kept: [...kept.keys()],
        lastError: d?.lastError ?? lastError,
        lastStop: lastStop && { reason: lastStop.reason, at: lastStop.at, counters: lastStop.debug.counters },
      };
    };
  }

  return () => {
    stopped = true;
    clearInterval(timer);
    offCardInfo();
    offMeasured();
    teardown("unmount");
    pages.stop("unmount");
    baker.dispose();
    streamBaker.dispose();
    dropPixels();
    offStore();
    offScrub();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
    }
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
    if (w) delete w.__pcBrowserNode;
  };
}

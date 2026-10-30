/**
 * 父页侧的快照 / 抑制投递（C4、C5、A3c 的消费方）。
 *
 * R6 把「拿得到」那一半做完了（`snapshotSource.ts` 的就绪索引 SSE + 取字节、
 * `snapshotPick.mjs` 的回溯选帧纯函数、`dataMirror.pushWanted`）；这个文件是排程那一半：
 *
 * - 每个播放头位置按 `planDispatch.currentPlan()` 的 `pipelineAt` 分出这一刻的重卡集合 `H(t)`，
 *   给每张重卡按就绪索引选一帧（`pickLayerSnapshot`，同区间内回溯、不跨区间、**不等待**）；
 * - **投递基线按 iframe 各一份**（A3c）：`patch` 是相对上次投递的增量，`null` = 摘掉；
 *   `setProject` 整份替换、K5 的角色互换要带 `reset`；`settled` 消息把 clipId 从基线里删掉，
 *   否则下次 C4 选到同一帧会按基线判「已挂着」不投、露出过期的活组件；
 * - **换 DOM 有节流**：每 ≥ 33 ms 一次（C4）。带 `reset` 的那次（互换后的首投）不受节流；
 * - **一次投递 ≤ 2 MB**（A3c）：一次一包，按兜底级别装（无流 > 超预算），装不下的下一拍再投、不摘。
 *
 * # 为什么取字节不能挡住 `setTime`
 *
 * 总规则是「永远不等」。所以这里分成同步和异步两半：`pickForSetTime(t)` **同步**回
 * 手里已经有的那些字节（`have`），缺的那几帧当场发起 `fetchSnapshot`，到货之后走
 * 独立的 `setSnapshots` 投递。拖过一张 stateful 卡的入点时，缓存命中的那一份和 `t`
 * 在同一次 React 提交里生效（不闪初始态）；没命中的那一层由 `.pc-awaiting` 藏 500 ms。
 *
 * # 兜底顺序（mechanism/rendering.md「兜底顺序」）
 *
 * 重卡贴的是轨道流，**播放、暂停、拖动都一样**（2026-10-13 用户定：每张卡的 HTML 快照作废）：这一帧的满密度流 →
 * 稀疏流（不晚于这一帧的最近一张）→ 占位符。父页这一侧管三件事：
 *
 *   1. 流平面只发这一帧所在分段已经就绪、解码器预算放行的那几条（`planesWithinBudget`，和舞台同一个函数）；
 *   2. 抑制：播放中是全部重卡；暂停 / 拖动时是「这一帧有流、还没追到精确活渲」的重卡（`FeedPlan.scrub`）——
 *      已经追到精确活渲的卡不抑制，它的流平面照发，舞台只拿它把播放头下这一帧先解好（起播头一拍就有）；
 *   3. **有流盖着的卡不读快照**（下面「快照这条路的分界」）：不选帧、不取字节、不投递、不等。
 *
 * **依赖下层的卡**（毛玻璃这一类，和审阅表没覆盖到的卡）走的是同一条顺序，只有两处不同（`streamLayers`）：
 * 它的流按舞台坐标产，流平面带 `plane: "stage"`（舞台把画布挂在舞台根下）；它的流只对产它时的那一版下层有效，
 * 那一层带着产流时的输入签名（`inputSig`），和父页按当前项目算的对不上就是**过期**的 —— 当作这张卡没有流，落到下一步。
 *
 * 流这一拍画不出来时舞台留着上一张，最多留一个分段的时长，再没有才显示占位符（`streamPlayer`、`StageView`）。
 *
 * **只有一个舞台**(精简模式与最低一档,在线浏览器性能不足时;2026-10-13 用户定「只贴轨道流的稀疏版、同时活着的解码器给得少」)走的也是这条顺序,不同的只有:
 * 流平面带 `first`(舞台每个分段只解第一帧那一张,那一段是满密度的也一样);同屏流的预算用小的那一组
 * (`sparseStreamBudget`:4 个解码器、画幅之和两张 1080p 满屏卡);这一档的兜底顺序是「流的分段第一帧 → 占位符」。
 * **只有一个舞台**(舞台闸门第一级、最低一档、握手失败退回)时没有后台舞台可以追到精确再互换:暂停、拖动时重卡一律抑制、
 * 停下后由舞台在可见舞台里逐层追一帧精确活渲(`Preview` 的 `syncPlanes`、`settleLayers`)。
 *
 * # 快照已撤掉（己二）
 *
 * 每张卡的 HTML 快照已全量下线。重卡播放、暂停与拖动贴轨道流；
 * 这一帧贴不上流（流还没就绪、超预算、或没有流）的重卡在暂停/拖动态进 scrub 显示占位符（可活渲的纯 remotion 卡直接活渲）。
 * picks 恒回空表、wanted 恒回空数组、deliverSnapshots 退役为返回 0 的空操作。
 */
import { cardMountedAt } from "../render/frameWindow.mjs";
import type { ReadyKind } from "../render/snapshotPick.mjs";
import { applyReadyMessage, HttpSnapshotSource, type ReadyIndex, type ReadyMessage, type SnapshotSource } from "../render/snapshotSource";
import { pipelineAt } from "../render/pipelinePlan.mjs";
import { mirrorKey } from "../render/dataMirror";
import type { Project, TrackClip } from "../kernel/project";
import type { StageRole, StageRpcClient } from "../render/stageRpc";
import * as planDispatch from "./planDispatch";
import type { CardCostRecord } from "../render/cardCostKey.mjs";

type CostResolver = (project: Project, clipId: string) => CardCostRecord | undefined;
let costResolver: CostResolver | null = null;
let dualStageResolver: (() => boolean) | null = null;

export function setCostResolver(fn: CostResolver | null, dual?: (() => boolean) | null): void {
  costResolver = fn;
  if (dual !== undefined) dualStageResolver = dual;
}
import { cardRunStatesGen, cardsRegistryGen, syncedUserCardsGen, getCard } from "../kernel/registry";
import { localOnlyClipIds, onlineBrowserMode } from "../render/placeholderHost";
import { planesWithinBudget, rangesHave, streamPlanesFor, type StreamPlaneRequest } from "../render/streamPlayer";
import { localStreamPixels, sparseStreamBudget, stageStreamPixels, STREAM_BUDGET_MIN_FPS } from "../render/streamBudget.mjs";
import { isStreamOrigin, streamSegmentOf } from "../render/streamSegments.mjs";
import { streamInputSig, streamSigStale } from "../render/streamInputSig.mjs";
import { cardCapabilities, clipFrameMode } from "../kernel/frameMode.mjs";
import { flatPlanProject, isFlatClipId } from "../kernel/cutFlatten.mjs";

/** C4：换 DOM 每 rAF 至多一次、间隔 ≥ 33 ms */
export const SNAPSHOT_THROTTLE_MS = 33;
/** A3c：一次 `setSnapshots` 投递 ≤ 2 MB（回包的 `bytes` 是实测口子，超了就拆） */
export const SNAPSHOT_DELIVERY_MAX_BYTES = 2 * 1024 * 1024;
/** A lost iframe reply must not leave the delivery baseline committed forever. */
export const SNAPSHOT_DELIVERY_TIMEOUT_MS = 8000;
/** C4：一次最多报 8 条缺口给预渲染进程 */
export const MAX_WANTED = 8;

/**
 * 就绪索引里全部 `stream` 层(单卡流的成员就是它自己;组流挂在组里最上面那张上、带 `groupClipIds`)。
 * `originFrame` 是这条流自己的第一帧(分段从它起数,`render/streamSegments.mjs`);没带它的层(改分段规则之前的生产者发的)
 * 没法把帧号换成分段号,这里不收 —— 当作这张卡没有流。
 */
interface StreamLayer { clipId: string; key: string; ranges: Array<[number, number]>; groupClipIds?: string[]; originFrame: number; members: string[]; plane?: "stage"; px?: number }
/**
 * 一条流的编码画幅(预算按它乘帧率算,`render/streamBudget.mjs`;划分流的一侧用的是同一个式子):
 * 按舞台坐标产的流(组流、依赖下层的流)是整幅画面;单卡流是它的矩形上界(包裹层的框外扩一圈、夹在画面里)。
 * 每份项目(不可变对象)缓存一张 clipId → 像素数。项目里找不到这张卡的回 undefined(预算那边按满屏卡算)。
 */
const streamPixels = new WeakMap<Project, Map<string, number | undefined>>();
function streamPixelsOf(project: Project, clipId: string, stage: boolean): number | undefined {
  const size = { width: Number(project.width) || 1920, height: Number(project.height) || 1080 };
  if (stage) return stageStreamPixels(size);
  let byClip = streamPixels.get(project);
  if (!byClip) { byClip = new Map(); streamPixels.set(project, byClip); }
  if (!byClip.has(clipId)) {
    let found: TrackClip | undefined;
    // 剪辑段里的卡在摊平视图里(`kernel/cutFlatten.mjs`)
    for (const track of flatPlanProject(project).tracks ?? []) { found = (track.clips ?? []).find((c) => c.id === clipId); if (found) break; }
    byClip.set(clipId, found ? localStreamPixels(found.frame, size) : undefined);
  }
  return byClip.get(clipId);
}
function streamLayers(project: Project): StreamLayer[] {
  const out: StreamLayer[] = [];
  for (const [clipId, byKind] of readyIndex) {
    const layer = byKind.get("stream");
    if (!layer || !isStreamOrigin(layer.originFrame)) continue;
    const below = layer.streamKind === "below";
    // 依赖下层的流:下层已经改过、预渲染进程还没换版本的这一小段里,就绪索引里还是旧流 —— 签名对不上的不贴
    if (below && belowStreamStale(project, clipId, layer.inputSig)) continue;
    out.push({ clipId, key: layer.key, ranges: layer.ranges as Array<[number, number]>, groupClipIds: layer.groupClipIds, originFrame: layer.originFrame,
      members: layer.groupClipIds?.length ? layer.groupClipIds : [clipId], ...(below ? { plane: "stage" as const } : {}),
      px: streamPixelsOf(project, clipId, below || (layer.groupClipIds?.length ?? 0) > 1) });
  }
  return out;
}

/**
 * 依赖下层的流过没过期:那一层带的输入签名(产流时的那一版项目)和按当前项目算的对不上。签名里是目标卡和它下面每一层的
 * 片段输入、采样窗口、框、不透明度、淡入淡出、轨迹,以及下层的上下顺序(`render/streamInputSig.mjs`);上面的层不在里面。
 * 两边都有、同一算法版本、而且不同才算过期(`streamSigStale`);那一层没带签名的不判(照贴)。
 * 每份项目(不可变对象)缓存一张 clipId → 签名:父页每拍都问,项目不换新对象就不重算。
 */
const belowSigs = new WeakMap<Project, Map<string, string | null>>();
function belowSigOf(project: Project, clipId: string): string | null {
  let byClip = belowSigs.get(project);
  if (!byClip) { byClip = new Map(); belowSigs.set(project, byClip); }
  if (!byClip.has(clipId)) byClip.set(clipId, streamInputSig(project, { clipIds: [clipId], kind: "below" }));
  return byClip.get(clipId) ?? null;
}
function belowStreamStale(project: Project, clipId: string, layerSig: string | undefined): boolean {
  if (!layerSig) return false;
  return streamSigStale(layerSig, belowSigOf(project, clipId));
}

export type PickTier = "none" | "over";

/** 这一刻某张卡选中的那一帧（向后兼容类型签名） */
export interface Pick {
  clipId: string;
  kind: ReadyKind;
  key: string;
  localFrame: number;
  /** 投递基线的比较键：换了它才换 DOM */
  id: string;
  tier: PickTier;
}

interface Baseline {
  needsReset: boolean;
  lastSentAt: number;
  /** 暂停态已经 settled(精确活渲、舞台自己撤了抑制)的卡:暂停中不再抑制(根因 B) */
  settled: Set<string>;
  /** 暂停态第二路互换之后:整台都精确 */
  settledAll: boolean;
}

const newBaseline = (): Baseline => ({ needsReset: false, lastSentAt: 0, settled: new Set(), settledAll: false });

const baselines: Record<StageRole, Baseline> = { front: newBaseline(), back: newBaseline() };

let source: SnapshotSource = new HttpSnapshotSource();
let readyIndex: ReadyIndex = new Map();
let unsubscribe: (() => void) | null = null;
let subscribedTo = "";
/** 到货之后要重投一次：由宿主（`Preview`）挂上 */
let onArrive: (() => void) | null = null;

/** 测试 / 探针:换一个快照来源 */
export function setSnapshotSource(next: SnapshotSource): void {
  source = next;
}

/**
 * 状态到货后叫宿主刷新。传 null 撤掉。
 */
export function setSnapshotArrive(notify: (() => void) | null): void {
  onArrive = notify;
}

/** 就绪索引此刻的样子（验收探针看） */
export function currentReadyIndex(): ReadyIndex {
  return readyIndex;
}

/** Safe probe diagnostics for a paused online page; no snapshot bytes or tickets. */
export function snapshotFeedDebug(head: Playhead) {
  const planned = planFeed(head);
  return {
    ready: [...readyIndex].map(([clipId, kinds]) => ({ clipId, kinds: [...kinds].map(([kind, layer]) => ({ kind, key: layer.key.slice(0, 12), ranges: layer.ranges.length })) })),
    heavy: planned.heavy,
    picks: [],
    // 这一刻发给舞台的流平面盖着哪几张卡、暂停 / 拖动时抑制哪几张(贴流)
    streams: planned.streamPlanes.map((p) => ({ clipIds: p.clipIds, key: (p.key ?? "").slice(0, 12), originFrame: p.originFrame ?? null, plane: p.plane ?? null })),
    // 就绪索引里有、但输入签名对不上当前项目的依赖下层的流(下层改过了,旧流不贴)
    staleBelow: [...readyIndex].filter(([clipId, kinds]) => {
      const layer = kinds.get("stream");
      return layer?.streamKind === "below" && belowStreamStale(head.project, clipId, layer.inputSig);
    }).map(([clipId]) => clipId),
    scrub: planned.scrub,
    mounted: [],
    reset: baselines.front.needsReset,
    settled: [...baselines.front.settled],
    settledAll: baselines.front.settledAll,
    settledLog: settledLog.slice(),
  };
}

/**
 * 订阅就绪索引（C3 的 SSE，页面直连预渲染进程）。**只按 session 做键**（根因 E）：
 * 编辑一次 `localRev` + 1，以前这里就清表、重连，而服务端 `/api/frames/ready` 根本不看
 * session / localRev —— 重连空档里播放中的重卡一律透明。现在客户端不抢先清表：旧的层按
 * 「沿用旧的预渲染结果」顶着，等预渲染进程发 `reset` 再清（这个会话的 preload 换了版本时，Item 4）。
 * 换项目（session 变了）才重连。
 */
export function syncSnapshotSubscription(notify: () => void): void {
  onArrive = notify;
  const key = mirrorKey();
  const want = key ? key.session : "";
  if (want === subscribedTo) return;
  unsubscribe?.();
  unsubscribe = null;
  subscribedTo = want;
  readyIndex = new Map();
  if (!key) return;
  unsubscribe = source.subscribeReady(key.session, key.localRev, (message: ReadyMessage) => {
    applyReadyMessage(readyIndex, message);
    if (message.type !== "done") onArrive?.();
  });
}

export function stopSnapshotFeed(): void {
  unsubscribe?.();
  unsubscribe = null;
  subscribedTo = "";
  onArrive = null;
  readyIndex = new Map();
  baselines.front = newBaseline();
  baselines.back = newBaseline();
}

/** `setProject` 整份替换 / K5 的角色互换：下一次投递带 `reset` */
export function markBaselineReset(role: StageRole): void {
  baselines[role].needsReset = true;
}

/**
 * K5 第一路 settled：舞台自己撤了抑制，父页记进 settled 表。
 */
export function noteSettled(role: StageRole, clipIds: readonly string[]): void {
  const base = baselines[role];
  for (const id of clipIds) {
    base.settled.add(id);
  }
}

/**
 * K5 第二路暂停态互换之后:新 `front` 是后台整场景补跑出来的,**整台**都是精确活渲(根因 B)。
 * 暂停中不再抑制任何卡,直到下一次 `setTime` / 播放。
 */
export function markAllSettled(role: StageRole): void {
  noteSettledLog("all", role, "");
  baselines[role].settledAll = true;
}

/**
 * 「停下就撤兜底」(product/rendering.md「兜底顺序」末条):暂停态已经追到精确活渲的卡,暂停中不再盖回流。
 * 下一次 `setTime`(`clearSettled`)或播放时清空。
 */
/** 诊断:最近几次 settled 的清与设(谁、何时),探针排查「占位撤下后又盖回」用 */
const settledLog: { at: number; op: string; role: StageRole; why: string }[] = [];
function noteSettledLog(op: string, role: StageRole, why: string) {
  settledLog.push({ at: Math.round(performance.now()), op, role, why });
  if (settledLog.length > 30) settledLog.shift();
}
export function clearSettled(role: StageRole, why = ""): void {
  if (baselines[role].settled.size || baselines[role].settledAll) noteSettledLog("clear", role, why);
  const base = baselines[role];
  if (base.settled.size) base.settled = new Set();
  base.settledAll = false;
}

function isSettled(role: StageRole, clipId: string): boolean {
  const base = baselines[role];
  return base.settledAll || base.settled.has(clipId);
}

/* --------------------------------------------------------------- 按拍换快照（已退役保留签名兼容） */

let beatSwap = false;

export function setBeatSwap(on: boolean, _opts: { swapMs?: number; occupied?: (t: number) => number; costOf?: ((project: Project, clipId: string) => number) | null } = {}): void {
  beatSwap = !!on;
}

/** 探针看 */
export function beatSwapDebug() {
  return { on: beatSwap, swapMs: 0, perLayer: false, knownSizes: 0, last: null, deliveries: 0, underThrottle: 0, placeholders: 0 };
}

/** 这几张卡从上到下的顺序:轨道按项目里的先后(第一条在最上面),同一轨道里后面的片段盖在前面的上面 */
export function topDownOrder(project: Project, clipIds: Iterable<string>): string[] {
  const want = new Set(clipIds);
  const out: string[] = [];
  for (const tr of project.tracks) {
    for (let i = tr.clips.length - 1; i >= 0; i--) {
      const id = tr.clips[i].id;
      if (want.has(id)) { out.push(id); want.delete(id); }
    }
  }
  for (const id of want) out.push(id);
  return out;
}

/* --------------------------------------------------------------- 选帧与降级 */

/** 这一层的采样窗口。`firstFrame` 和预渲染进程的 `cardSampling(start, fps)` 同一个算式 */
function samplingOf(clip: { start: number; end: number }, fps: number): { firstFrame: number; count: number } {
  const firstFrame = Math.max(0, Math.ceil(clip.start * fps - 1e-9));
  const phase = firstFrame / fps - clip.start;
  const count = Math.max(1, Math.ceil((clip.end - clip.start - phase) * fps - 1e-9));
  return { firstFrame, count };
}

/**
 * K6：已经降级、但死素材还没就绪的卡。**照常活渲**（用户看到的画面不变，只是可能慢），
 * 就绪之后的下一拍才切进 `suppressed` / `streamPlanes` —— 和别的重卡同一机制。
 *
 * 每张卡 HTML 快照作废后，只看 `streamLayers(project)`（每帧所在分段已就绪）。
 */
const pendingDemote = new Set<string>();

export function markPendingDemote(clipId: string): void {
  pendingDemote.add(clipId);
}

export function pendingDemotes(): ReadonlySet<string> {
  return pendingDemote;
}

/**
 * 「就绪」按当前播放位置判(mechanism/rendering.md「降级」;根因 D):从当前位置起 `min(fps, 片段剩余帧数)` 帧
 * 都有轨道流覆盖 —— 流按分段(这几帧落在的每一段都在同一条流的就绪区间里,组流算成员)。
 */
function demoteReady(project: Project, clipId: string, globalFrame: number, localFrame: number, count: number, fps: number): boolean {
  const need = Math.max(0, Math.min(fps, count - localFrame) - 1);
  for (const layer of streamLayers(project)) {
    if (!layer.members.includes(clipId)) continue;
    // 这几帧落在这条流的哪几段:按这条流自己的第一帧换算(早于第一帧的是负数段,不在就绪区间里)
    const firstSeg = streamSegmentOf(Math.max(0, globalFrame), layer.originFrame);
    const lastSeg = streamSegmentOf(Math.max(0, globalFrame + need), layer.originFrame);
    let all = true;
    for (let seg = firstSeg; seg <= lastSeg && all; seg++) all = rangesHave(layer.ranges, seg);
    if (all) return true;
  }
  return false;
}

/**
 * 在线浏览器模式下本页运行不了的卡（素材效果卡、运行不了的用户卡，`placeholderHost.needsLocalPc`；C10 契约第 9 节，2026-10-06 起本页能运行的用户卡不算）：
 * 有预渲染结果就照贴，与内置卡相同。它们在这台设备上**一律按重卡**：不管分派表怎么判（表还没算出来、旧记录判轻），
 * 播放中抑制；停下时不追（没有组件可追），所以暂停态的「已精确」（`settled`）对它们不成立，一直进 scrub 贴流或显示占位。
 * 判法与舞台同一个（`localOnlyClipIds`）；开关是 `setOnlineBrowserMode`，桌面恒为关，这里恒为空集合。
 */
let localOnlyMemo: { project: Project; key: string; ids: ReadonlySet<string> } | null = null;
const NO_IDS: ReadonlySet<string> = new Set();
export function localOnlyOf(project: Project): ReadonlySet<string> {
  if (!onlineBrowserMode()) return NO_IDS;
  const key = `${cardsRegistryGen()}:${syncedUserCardsGen()}:${cardRunStatesGen()}`;
  if (localOnlyMemo && localOnlyMemo.project === project && localOnlyMemo.key === key) return localOnlyMemo.ids;
  // 剪辑段里的卡也算(摊平视图里的虚拟片段,`kernel/cutFlatten.mjs`)
  const ids = localOnlyClipIds(flatPlanProject(project).tracks.flatMap((tr) => tr.clips));
  localOnlyMemo = { project, key, ids };
  return ids;
}

/**
 * 这一刻活跃的卡片段（口径同 `Stage` / `FrameScene` 的 live 路：含 LEAD）。剪辑段换成它里面的卡(`kernel/cutFlatten.mjs` 的摊平视图;
 * 用户 2026-10-21 定:剪辑段里的卡和没有剪辑段时一样,轻卡活渲,重卡各自贴自己的流,没流时显示占位)
 */
function activeCardClips(project: Project, t: number): TrackClip[] {
  const out: TrackClip[] = [];
  for (const tr of flatPlanProject(project).tracks) {
    if (tr.hidden) continue;
    for (const clip of tr.clips) {
      if (!clip.cardId && !clip.nodeId) continue;
      if (cardMountedAt(clip, t)) out.push(clip);
    }
  }
  return out;
}

/**
 * 剪辑段里的这张卡有没有自己的单卡流可产(独立卡;`streamPlanRules.mjs` 的 `soloStreamKind` 回 `'flat'` 的那一种)。
 * 能力表与卡片图里这张卡的节点同一个算法(`cardCapabilities`)
 */
export function flatStreamable(clip: TrackClip): boolean {
  const def = clip.cardId ? getCard(clip.cardId) : undefined;
  return cardCapabilities(def, { ...def?.defaults, ...clip.params }, clip.parts as Parameters<typeof cardCapabilities>[2]).compositing === "independent";
}

export interface Playhead {
  project: Project;
  t: number;
  /** 播放中才有抑制集合（C5 / K5：拖动和暂停下不抑制、改贴流） */
  playing: boolean;
  /**
   * 只有一个舞台:播放、拖动、暂停时判重的卡一律抑制(父页 `Preview` 的 `pumpFeed`);
   * 停下时舞台把当前这一帧逐层追一次(`settleLayers`),画好的层照双舞台一样收 `settled`、不再盖回流。
   */
  single?: boolean;
  /**
   * 只贴稀疏版(只有一个舞台:精简模式与最低一档,即舞台闸门没到双舞台的设备):流平面带 `first`(每个分段只解第一帧),
   * 预算用 `sparseStreamBudget`;页面一侧的在线来源也只取稀疏版(`snapshotSource.ts` 的 `small`)
   */
  sparseOnly?: boolean;
}

export interface FeedPlan {
  /** 这一刻判重的卡（播放中就是 `setSuppressed` 的实参，再并上 K3(b) 的额外抑制） */
  heavy: string[];
  /** 快照已撤掉，恒为空表（保留签名向后兼容） */
  picks: Map<string, Pick>;
  /** 缺口上报已撤掉，恒为空数组（保留签名向后兼容） */
  wanted: { clipId: string; frame: number }[];
  /**
   * 这一刻发给舞台的流平面（已按同屏流的预算截过，`planesWithinBudget`）：这一帧所在分段已经就绪的重卡的流。
   * 播放、暂停、拖动都有。只有一个舞台时每条带 `first`（舞台每个分段只解第一帧那一张）。
   */
  streamPlanes: StreamPlaneRequest[];
  /**
   * 这一帧有流、但超出预算的那几条（每条带 `over: true`）。舞台不为它们建解码器，只取清单，
   * 占位符照清单里这一帧所在分段的位置矩形摆。和 `streamPlanes` 一起发给舞台（`streamPlanesAt`）。
   */
  overPlanes: StreamPlaneRequest[];
  /**
   * 暂停 / 拖动时父页该抑制的卡：
   * 还没追到精确活渲的重卡（以及 localOnly 卡）。
   * 这一帧有流的贴流；没有流的若为 remotion 式卡则不进 scrub（露出活组件当场算），其余重卡进 scrub 显示占位符。
   * 播放中恒为空（播放中抑制的是 `heavy`）。
   */
  scrub: string[];
}

/**
 * 这一刻的投递计划。**纯算，不 fetch、不发 RPC**，所以验收探针可以单独看它。
 *
 * 兜底顺序（mechanism/rendering.md「兜底顺序」）在父页这一侧：
 * 流平面只发这一帧有流、解码器预算放行的那几条；超出预算的标 `over`。
 */
export function planFeed({ project, t, playing, single, sparseOnly }: Playhead): FeedPlan {
  const plan = planDispatch.currentPlan();
  const fps = Math.max(1, project.fps || 30);
  const globalFrame = Math.max(0, Math.floor(t * fps + 1e-6));
  const heavy: string[] = [];
  const clips: { clip: TrackClip; firstFrame: number; count: number }[] = [];
  const localOnly = localOnlyOf(project);
  for (const clip of activeCardClips(project, t)) {
    // 这台设备跑不了的卡一律按重卡(在线浏览器模式;见 `localOnlyOf`)
    if (pipelineAt(plan, clip.id, t) !== "heavy" && !localOnly.has(clip.id)) continue;
    // 剪辑段里的卡只有独立卡产流(`streamPlanRules.mjs` 的 `'flat'`);别的(依赖下层、源依赖、没审阅过)在嵌套场景里照旧活渲,不抑制
    if (isFlatClipId(clip.id) && !flatStreamable(clip)) continue;
    const { firstFrame, count } = samplingOf(clip, fps);
    if (pendingDemote.has(clip.id)) {
      // K6：死素材就绪之前照常活渲，**不进 heavy**（也就不会被抑制、不会发流平面）
      if (!demoteReady(project, clip.id, globalFrame, globalFrame - firstFrame, count, fps)) continue;
      pendingDemote.delete(clip.id);
    }
    heavy.push(clip.id);
    clips.push({ clip, firstFrame, count });
  }

  let streamPlanes: StreamPlaneRequest[] = [];
  let overPlanes: StreamPlaneRequest[] = [];
  const wantedStream = new Set<string>();
  const scrub = new Set<string>();
  const layers = streamLayers(project);
  if (layers.length) {
    const members = new Set(heavy);
    if (playing) for (const id of extraSuppressed) members.add(id);
    const all = streamPlanesFor(layers, members, globalFrame);
    const pixelsOf = new Map(layers.map((l) => [l.key, l.px]));
    streamPlanes = sparseOnly
      ? planesWithinBudget(all, STREAM_BUDGET_MIN_FPS, (p) => pixelsOf.get(p.key ?? ""), sparseStreamBudget())
      : planesWithinBudget(all, fps, (p) => pixelsOf.get(p.key ?? ""));
    if (streamPlanes.length < all.length) {
      const within = new Set(streamPlanes);
      overPlanes = all.filter((p) => !within.has(p)).map((p) => ({ ...p, over: true as const }));
    }
    if (sparseOnly) streamPlanes = streamPlanes.map((p) => ({ ...p, first: true as const }));
    for (const p of all) for (const id of p.clipIds) wantedStream.add(id);
    if (!playing) {
      for (const p of all) {
        if (p.clipIds.some((id) => !isSettled("front", id) || localOnly.has(id))) {
          for (const id of p.clipIds) scrub.add(id);
        }
      }
    }
  }

  if (!playing) {
    for (const { clip } of clips) {
      if (wantedStream.has(clip.id)) continue;
      if (!isSettled("front", clip.id) || localOnly.has(clip.id)) {
        const def = clip.cardId ? getCard(clip.cardId) : undefined;
        const isDirect = clipFrameMode(clip, def) === "direct";
        const runnableRemotion = isDirect && !localOnly.has(clip.id) && !single;
        if (!runnableRemotion) {
          if (costResolver && !localOnly.has(clip.id) && !single) {
            const record = costResolver(project, clip.id);
            const dual = dualStageResolver ? dualStageResolver() : true;
            if (!record || (record.vtOk === false && !dual)) {
              continue;
            }
          }
          scrub.add(clip.id);
        }
      }
    }
  }

  return { heavy: heavy.sort(), picks: new Map(), wanted: [], streamPlanes, overPlanes, scrub: [...scrub].sort() };
}

/**
 * 取出这一次 `setTime` 能一起带过去的快照（已退役保留签名兼容）。
 * 仅执行 `clearSettled("front")` 并返回空快照。
 */
export function pickForSetTime(head: Playhead): { snapshots: Record<string, string | null>; awaiting: string[] } {
  clearSettled("front", `setTime ${head.t}`);
  return { snapshots: {}, awaiting: [] };
}

/**
 * 投快照（已退役保留签名兼容）。
 * 播放中清空 settled，返回 0。
 */
export async function deliverSnapshots(_stage: StageRpcClient, role: StageRole, head: Playhead): Promise<number> {
  if (head.playing) clearSettled(role, "playing");
  return 0;
}

/**
 * K3(b)：播放中正在等后台补跑的 `vtOk = false` **轻卡**也要抑制（藏子树、`t` 冻住）。
 * 它没有流平面 —— 等待期间舞台在它的位置上显示占位符（T4，product/rendering.md「兜底顺序」：
 * 「等后台舞台补跑后互换」也不透明），用户看不到它用错状态跳变。互换之后这份就清空。
 */
let extraSuppressed: readonly string[] = [];
export function setExtraSuppressed(clipIds: readonly string[]): void {
  extraSuppressed = [...clipIds];
}

/**
 * R8：这一刻的流平面（C3 末段：由就绪索引里 `kind: 'stream'` 的层合成）：这一帧有流的重卡，播放、暂停、拖动都有，
 * **已按同屏流的预算截过**（`planesWithinBudget`，和舞台同一个函数）；超出预算的那几条跟在后面、带 `over: true`（舞台只拿它们的清单摆占位符）。
 * 父页在发 `setSuppressed(...)` 的同一处、**先于它**发 `setStreamPlanes(...)`（舞台等流的第一帧画出来才藏活子树）。
 */
export function streamPlanesAt(head: Playhead): StreamPlaneRequest[] {
  const feed = planFeed(head);
  return feed.overPlanes.length ? [...feed.streamPlanes, ...feed.overPlanes] : feed.streamPlanes;
}

/**
 * 这一刻该抑制哪几张。播放中：全部重卡（C5 / K5），加上等后台补跑互换的那几张。
 * 暂停 / 拖动：还没追到精确活渲的重卡（`FeedPlan.scrub`）—— 贴流或占位，不露出没推到位的活组件。
 */
export function suppressedAt(head: Playhead): string[] {
  const feed = planFeed(head);
  if (!head.playing) return feed.scrub;
  if (!extraSuppressed.length) return feed.heavy;
  return [...new Set([...feed.heavy, ...extraSuppressed])].sort();
}

/** 测试用 */
export function resetSnapshotFeed(): void {
  stopSnapshotFeed();
  beatSwap = false;
  pendingDemote.clear();
  costResolver = null;
  dualStageResolver = null;
  source = new HttpSnapshotSource();
}


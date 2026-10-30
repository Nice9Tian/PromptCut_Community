import fs from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { openBakery, bakeFrames } from './bakery/index.mjs';
// 直接按文件名引,不走 index:既有测试用 mock.module 替换整个 index,替身里没有这个出口
import { probeBrowserEnvironment } from './bakery/environment.mjs';
import { captureSnapshot } from './bakery/capture-snapshot.mjs';
import { frameIdentity, trackPrefixes } from './frame-identity.mjs';
import { cardEntryCode } from './card-code.mjs';
import { packFrames, unpackFrameArchive, createFrameArchive, packFrameCache, unpackFrameCache } from './frame-archive.mjs';
import { MovFrameStore, PlaybackMovStore, atomic } from './frame-mov.mjs';
import { FramePlayback } from './frame-playback.mjs';
import { sweepFrameLibrary } from './storage-leftovers.mjs';
/** 本进程已做过启动清理的帧库根 */
const sweptRoots = new Set();
import { CardFrameCache } from './card-cache.mjs';
import { SnapshotStore, snapshotTier, rangeHas, rangeCount } from './snapshot-store.mjs';
import { createReadyHub, DEFAULT_READY_SESSION, READY_SESSION_IDLE_MS, kindOfTier, wireSnapshotKey } from './ready-index.mjs';
import { prerenderSetOfPlan } from './prerender-set.mjs';
import { createMediaStamper } from './media-stamp.mjs';
import { createHash } from 'node:crypto';
import { isFullyTransparentPng } from './frame-validity.mjs';
import { resolveFrameSize } from '../src/kernel/frameSize.mjs';
import { isolatedCardProject } from '../src/kernel/isolatedCard.mjs';
import { anchorFrames } from '../src/render/snapshotPick.mjs';
import { StreamProducer, STREAM_POOL_DEFAULT, STREAM_POOL_MAX, STREAM_CODE_VERSION, planStreams, planListStreams, queueStreamOf, streamDecoderBudget } from './frame-stream.mjs';
import { dirtyStreamLease } from './bakery/bake.mjs';
import { createCardLockStore, cardLockDecision, CARD_LOCK_IDLE_MS } from './card-lock.mjs';
import { QUEUE_DEFAULTS } from './render-queue/index.mjs';
import { applyResult, manifestKindOf, manifestKeyOf, manifestMatches, spansOf } from './artifact-transfer.mjs';

/** 同一版里延后的卡最多重判几次(契约 F.8 第 2 条),之后等下一版 */
export const CARD_LOCK_RETRY_MAX = 20;
import { resultKeyOf } from './render-node/fingerprint.mjs';
import { withInnerCards, isUserCardControl } from './render-node/split.mjs';
import { expandProject, streamNeed, subsetCardSources } from './render-node/expand.mjs';
import { createSmallRenderer, SMALL_SUFFIX } from './bakery/small-bitmap.mjs';
import { layerMapOf, streamCandidateKey, STREAM_CANDIDATE_PREFIX, layerMapKeyOf } from './artifact-transfer.mjs';
import { PRERENDER_MODE, parsePrerenderMode, lanesOfMode, modeRefusal, modeServesAgent, modeServesPrerender } from './prerender-mode.mjs';
import { exportSpecOf, exportStreamOf, shotToPng, storeExportFrame } from './export-frames.mjs';
import { streamInputSig } from '../src/render/streamInputSig.mjs';

/**
 * C6.4 推送与换机取用按什么段长切段:与渲染任务队列的切分(`render-node/split.mjs`)完全一致 ——
 * 快照每 `SNAPSHOT_SPAN` 个本地帧一段(从 0 起),流每 `STREAM_SEGMENTS` 个分段一段(从这条流的 `firstSegment` 起)。
 * 键因此和细任务的结果键、区间一模一样(`manifest-contract.md` 第 1 节)。
 */
export const PUSH_SNAPSHOT_SPAN = QUEUE_DEFAULTS.SNAPSHOT_SPAN;
export const PUSH_STREAM_SEGMENTS = QUEUE_DEFAULTS.STREAM_SEGMENTS;
/** 流锁(`FramePipeline.streamLocks`:别的环境产好、本机整条拉回来了的单卡流)最多记几条 */
export const STREAM_LOCKS_MAX = 2000;
/** c10a 第 9 节:还没画成小位图的帧最多攒这么多(本进程好久没换页时只留最新的) */
export const SMALL_PENDING_MAX = 480;
/** 推送优先级(`artifact-push.mjs` 的 `PUSH_PRIORITY`):0 normal、1 low。这里不引那个模块,只用数 */
const PUSH_NORMAL = 0, PUSH_LOW = 1;
/** 换机取用时同时查几段清单 */
const ADOPT_CONCURRENCY = 4;

const pad = n => String(n).padStart(6, '0');
const exists = file => fs.access(file).then(() => true, () => false);
// The interactive editor must never wait forever on a renderer that stopped
// answering.  Agent/background renders have their own (longer) budgets; this
// watchdog is only for the human preview lane.
// TODO: 10 seconds may be too aggressive for complex projects or a cold media
// decode. Keep this configurable until we have latency telemetry; raise it
// with PROMPTCUT_USER_RENDER_TIMEOUT_MS when the preview needs more headroom.
const USER_RENDER_TIMEOUT_MS = Math.max(1000, Number(process.env.PROMPTCUT_USER_RENDER_TIMEOUT_MS) || 10000);
// An open preview repeats its preload request every 2 s until the scene is
// ready (UnifiedPreview). An owner that has not asked for this long has gone
// away: its page was closed or reloaded, and a reloaded default project gets a
// new id. Its background pass must not keep the current project waiting.
export const PRELOAD_STALE_MS = 8000;
/** Agent lane 的 Chrome 空闲这么久就关,下次查询再拉起(cloud-task.md I1) */
export const AGENT_IDLE_MS = 10 * 60 * 1000;
/**
 * Agent 专用实例做完一个 Agent 任务之后,至少空这么久才接普通预渲染(`kickAgentIdle`)。Agent 的一次工具调用常常是
 * 前后脚的几个任务(`see_frames` 的一批渲完才排「量实体框」),空档里接一批卡批(一批要换页、推 4 帧,几秒)会让
 * 紧跟着的那个任务白等一批。这段时间里专用实例什么都不接,到点再判。
 */
export const AGENT_GRACE_MS = 1000;
/**
 * 专用实例做队列任务、中途给 Agent 让路时,每隔这么久报一次「还在干活」(执行器的 `heartbeat` → 会话的工作计数),
 * 免得 Agent 连着几个任务做得久、队列按停滞(`STALL_MS`,120 s)把手里这一项收回(AGENT-maint-3)。
 */
export const AGENT_YIELD_BEAT_MS = 20_000;

const roundBox = b => ({ left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) });

/**
 * 素材段的 `contentBox` **一律等于它的 `frameCss` 框**(D4(b)):不在快照里量,按项目数据算。
 * 和 `src/kernel/layout.ts` 的 `frameBox` 同一个式子(锚点在 (x,y),左上角 = (x,y) 减锚点偏移),
 * 宽高走 `src/kernel/frameSize.mjs` 的 `resolveFrameSize` —— 舞台和服务端共用的唯一一份。
 */
export function frameContentBox(frame, stage) {
  const { w, h } = resolveFrameSize(frame, stage);
  const anchor = frame?.anchor ?? [0, 0];
  return roundBox({ left: (frame?.x ?? 0) - (anchor[0] ?? 0) * w, top: (frame?.y ?? 0) - (anchor[1] ?? 0) * h, width: w, height: h });
}

/**
 * D4(b) 回包的**纯计算**部分:片段分成「素材段(按 frameBox 算)」和「卡片(按生成的快照量)」,
 * 再把量出来的实体框并回去。`measured` = `window.__pcSolid.rectsWithBounds` 的返回值,
 * 传 null 表示还没量(只要名单)。不传 `clipIds` 就是全部片段(卡片 + 素材段)。
 *
 * 取 `bounds ?? rect`、四舍五入到整数 —— 和页面侧 `measureContentBoxes` 一字不差。
 */
export function layoutClips(project, clipIds, measured = null, t = 0) {
  const stage = { width: Number(project?.width) > 0 ? project.width : 1920, height: Number(project?.height) > 0 ? project.height : 1080 };
  const byId = new Map();
  for (const track of project?.tracks || []) for (const clip of track?.clips || []) if (clip?.id && !byId.has(clip.id)) byId.set(clip.id, clip);
  const ids = clipIds?.length ? [...new Set(clipIds.map(String))] : [...byId.keys()];
  const clips = {};
  const cardIds = [];
  for (const id of ids) {
    const clip = byId.get(id);
    if (!clip) { clips[id] = { contentBox: null, contentNote: `找不到 clip ${id}` }; continue; }
    // 素材段:不进快照测量,框由项目数据决定
    if (!clip.cardId) { clips[id] = { contentBox: frameContentBox(clip.frame, stage) }; continue; }
    cardIds.push(id);
    if (!measured) { clips[id] = { contentBox: null }; continue; }
    const hit = measured.find(m => m?.clipId === id);
    if (!hit) {
      clips[id] = { contentBox: null, contentNote: `这张卡此刻不在画面上(t=${t}s 不在它的 ${clip.start}~${clip.end}s 区间内),先 seek 进它的时段再读` };
      continue;
    }
    clips[id] = { contentBox: roundBox(hit.bounds ?? hit.rect) };
  }
  return { stage, clips, cardIds };
}

/**
 * D3:`see_frames` 每帧附的实体矩形,在 `captureSnapshot` 的 `afterFonts` 钩子里量(和 `layoutNow` 同一个钩子位置)。
 * 根传 `#pc-frame-snapshot [data-pc-scene]`,调 `window.__pcSolid.rectsWithBounds(root, { pixels: 'all' })`。
 *
 * 回 `Array<{ clipId, box: [x, y, w, h], solid: [x, y, w, h] | null }>`,舞台像素坐标、取整:
 * `box` = 包裹层外框,`solid` = 实体范围,**`null` = 这张卡此刻没有实体像素**。
 * `bounds()` 量不到实体时会退回包裹层外框(给选中描边兜底),和「实体正好铺满包裹层」分不开,
 * 所以这里按 `bounds()` 同一条走法(平面算实体、`isSolid` 的元素不再往下、组流平面跳过、
 * 快照里的 `<img>` 按 `data-pc-painted-box` 那块算)先问一句「舞台内有没有实体」,没有就给 `null`。
 * 页面上没挂 `__pcSolid` 时回 null(不是空数组),调用方据此说「没量出来」。
 */
export const measureEntityRects = page => page.evaluate(() => {
  const root = document.querySelector('#pc-frame-snapshot [data-pc-scene]');
  const api = window.__pcSolid;
  if (!root || typeof api?.rectsWithBounds !== 'function' || typeof api.isSolid !== 'function') return null;
  const origin = root.getBoundingClientRect();
  const r4 = b => [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
  const onStage = rc => rc.width > 0 && rc.height > 0 && rc.right > origin.left && rc.left < origin.right && rc.bottom > origin.top && rc.top < origin.bottom;
  // 同 solid.ts 的 paintedBoxAttr + paintedBoxRect:画布像素坐标按 <img> 当前外框换算
  const paintedRect = el => {
    const n = (el.getAttribute('data-pc-painted-box') || '').split(',').map(Number);
    if (n.length !== 4 || n.some(v => !Number.isFinite(v))) return null;
    const rect = el.getBoundingClientRect();
    const w = Number(el.getAttribute('width')) || el.naturalWidth || rect.width;
    const h = Number(el.getAttribute('height')) || el.naturalHeight || rect.height;
    if (!(w > 0) || !(h > 0) || !(rect.width > 0) || !(rect.height > 0)) return null;
    const sx = rect.width / w, sy = rect.height / h;
    return new DOMRect(rect.left + n[0] * sx, rect.top + n[1] * sy, n[2] * sx, n[3] * sy);
  };
  const painted = el => {
    if (el.hasAttribute('data-pc-group-plane')) return false;
    if (el.hasAttribute('data-pc-proxy-plane') || el.hasAttribute('data-pc-snapshot-plane') || el.hasAttribute('data-pc-stream-plane')) return onStage(el.getBoundingClientRect());
    if (api.isSolid(el, root)) return onStage((el.tagName === 'IMG' && paintedRect(el)) || el.getBoundingClientRect());
    for (const c of el.children) if (painted(c)) return true;
    return false;
  };
  return api.rectsWithBounds(root, { pixels: 'all' }).map(({ clipId, rect, bounds }) => {
    const wrap = root.querySelector(`[data-pc-clip="${CSS.escape(clipId)}"]`);
    const solid = bounds && wrap && [...wrap.children].some(painted) ? r4(bounds) : null;
    return { clipId, box: r4(rect), solid };
  });
});

/** A foreground batch queue, B complete HTML sampling, C cumulative-track rasterization.
 * Each lane owns its Chrome; foreground never waits for a background bake to finish.
 */
/** C4:没接镜像插件时的播放头(`frameService` 会把真的那个注进来) */
const NO_PLAYHEAD = () => /** @type {{ t: number, playing: boolean, wanted?: { clipId: string, frame: number }[] } | null} */ (null);

/**
 * 预渲染重试登记(c10a 契约第 17 节)里一张卡的内容身份:共享档用内容键(与环境、锁定方无关),本地档再带上整场景的 entry.key。
 * 没有快照键的卡不产快照,回 null。
 */
function backfillIdentity(entry, control) {
  if (!control?.clipId || !control.snapshotKey) return null;
  const tier = control.tier || snapshotTier(control.capabilities);
  const content = control.contentKey ?? control.snapshotKey;
  return `${control.clipId}\u0000${tier === 'local' ? `${entry?.key ?? ''}/${content}` : content}`;
}

/** 切分候选(M7 D12)最多记几张卡 */
const SPLIT_CANDIDATES_MAX = 4096;

export class FramePipeline {
  /**
   * `interactive`(D5):这个实例要不要为页面的交互帧请求养一对热 Chrome。
   *
   *   预渲染进程 `interactive: true` —— 热池在这里,改叫 `streamPool`(G 的分段和
   *     C2 的锚帧用它;大小是 G0-b 的输出参数,初值 2);
   *   编辑器进程 `interactive: false` —— `user` / `playback` lane 立即拒绝
   *     `USE_PRERENDER`,不进 `acquireUser`,两处 `prewarmUser` 都不调。
   *
   * **R6 只加参数和代码路径,默认值保持今天的行为**(两个进程都 `true`);真正把
   * 编辑器进程切成 `false` 是 R7 的原子切换。播放热池的借还和 `stopPlayback()`
   * 还在用,没有删(计划 3.4 末条:底稿说「已删除」是错的)。
   *
   * `playhead`:C4 的 `wanted` 从哪儿读(镜像插件的 `latestPlayhead()`)。
   * frame-pipeline 是 .mjs、镜像插件是 .ts,所以由 `frameService()` 注进来。
   *
   * `mediaUrl(m)`:素材服务上这条素材的绝对 HTTP 地址(取不到回 null),给没有内容哈希的素材打戳时
   * 发 `HEAD` 用(`media-stamp.mjs`)。同样由 `frameService()` 注进来(`ffmpeg-frames.ts` 的
   * `mediaSourceOf`,基址按 `asset-client.ts` 定);不注就是「素材服务不可达」,那种素材的戳是 `'missing'`。
   *
   * `dataRoot`:成本记录和可调系数(`card-costs.json` / `pipeline-tuning.json`)按它定位,口径和
   * `vite-plugin-costs` 一样 —— `costs-store.mjs` 的 `costsDir(dataRoot)` = `PROMPTCUT_DATA_DIR || <dataRoot>/out`。
   * `frameService()` 传 Vite 的根目录。**不能用 `root`**:`root` 是帧库目录,没设 `PROMPTCUT_DATA_DIR`
   * 的开发期会读到没人写的 `<帧库>/out/card-costs.json`,实测成本永远进不了预渲染集合。
   * 缺省是当前工作目录(从仓库根跑的脚本和探针正好对上)。
   *
   * `environment`(M4,契约 E.2):这个进程预渲染用的环境,`describeEnvironment` 的形状(至少有
   * `fingerprint`)。给了就不探测、直接用(测试,以及以后环境已知的独立渲染主机);不给就等第一个
   * 预渲染间开起来时探测一次(`ensureEnvironment`)。
   */
  constructor({ root, origin, code = () => '', cardSources = () => ({}), captureCode = () => undefined, interactive = true, playhead = NO_PLAYHEAD, mediaUrl = () => null, dataRoot = process.cwd(), environment = null, cardLockIdleMs = CARD_LOCK_IDLE_MS, pushQueue = null, mode = PRERENDER_MODE.FULL }) {
    this.root = root;
    /**
     * 存储计划 A 部分:启动时清掉死进程留在帧库里的临时文件(`storage-leftovers.mjs` 文件头列了认哪几种)。
     * 只对真正的帧库根(`<导出目录>/frame-library`)做,一个进程一个根只做一次;测试用的临时根不碰。
     * 不等它:清理和开工并行,只删死进程的东西,不会和本进程的写入撞上。
     */
    if (typeof root === 'string' && path.basename(root) === 'frame-library' && !sweptRoots.has(path.resolve(root))) {
      sweptRoots.add(path.resolve(root));
      this.leftoverSweep = sweepFrameLibrary(root, { log: message => console.log(message) }).catch(() => null);
    } else this.leftoverSweep = Promise.resolve(null);
    /**
     * C6.4 的推送队列(`artifact-push.mjs` 的 `createPushQueue`,它建好后自己挂到这里)。**只有它不是 null 时**
     * 快照 / 流的推送钩子和 `preload` 里的换机取用才生效;null(缺省,含所有现有测试和探针)时逐路径行为不变。
     * 预渲染进程只在连得上素材服务和文档服务时才建它(`vite-plugin-frames.ts`)。
     */
    this.pushQueue = pushQueue;
    /**
     * 帧库的使用索引与淘汰(`frame-library-storage.mjs`,存储占用计划 B 部分)。只有预渲染进程接上(`attachPipeline`);
     * null 时下面三处 `this.usage?.` 什么都不做。
     */
    this.usage = null;
    /**
     * 环境指纹(M4):card plan、轨道流的全部结果键都乘上它。定下来之前是 null —— 那时
     * `CardFrameCache.plan()` 抛出、`planStreams` 回 [],什么键都不产。
     */
    this.environment = environment && typeof environment === 'object' ? environment : null;
    this.environmentProbe = null;
    /**
     * 卡片级指纹锁(契约 F.3):共享档快照这一种结果,一张卡只出自一种环境。锁库在 `<库根>/controls-lock/`,
     * 构造时就开始读盘;用到锁的地方先 `await this.ensureCardLocks()`。
     */
    this.cardLockStore = typeof root === 'string' && root ? createCardLockStore({ dir: path.join(root, 'controls-lock') }) : null;
    this.cardLocksLoading = this.cardLockStore ? this.cardLockStore.load().catch(() => {}) : Promise.resolve();
    /** 锁让某张卡换了键(或换了 `foreign`)就加一:`snapshotTargets` 的缓存据此失效 */
    this.cardLockEpoch = 0;
    /**
     * 锁定方多久没再产出就算闲置(契约 F.8 第 2 条):`cardLockDecision` 的 `idleMs` 和延后重判的计时器都用它。
     * 测试给小值。
     */
    this.cardLockIdleMs = Number.isFinite(cardLockIdleMs) && cardLockIdleMs >= 0 ? cardLockIdleMs : CARD_LOCK_IDLE_MS;
    /** 还没触发的延后重判计时器(`close()` 统一清掉) */
    this.cardLockTimers = new Set();
    this.dataRoot = dataRoot;
    this.origin = origin;
    this.code = code;
    /**
     * 这一版项目用到的定制卡(用户卡、改动层里改过的卡)的代码身份 `{ cardId: 身份 }`(c66-host-cards,`server/card-code.mjs`)。
     * `code` 是全局代码版本、不再覆盖用户卡,整场景键在它后面接上这些身份(`cardEntryCode`);
     * 队列切分时原样写进细任务的 `requires.cardSources`。缺省没有定制卡(测试、探针、脚本)。
     */
    this.cardSources = cardSources;
    this.captureCode = captureCode;
    this.interactive = interactive !== false;
    /**
     * 预渲染进程的模式(`prerender-mode.mjs`;`mechanism/rendering.md`「查询渲染与预渲染进程」):`'user'` 不建 Agent lane,
     * `'agent'` 只建 Agent lane、不预渲染,`'full'` 都建(缺省,和加模式之前相同)。认不得的值按 `'full'`。
     * 只对 `interactive: true` 的实例(预渲染进程)有意义;编辑器进程本来就没有这些 lane。
     */
    this.mode = parsePrerenderMode(mode) ?? PRERENDER_MODE.FULL;
    this.playhead = playhead;
    /**
     * 素材戳(`_frameSourceStamp`,进 `frameIdentity`):有哈希就是哈希,没有就问素材服务的 `HEAD`,
     * 不读素材服务的存储目录(`media-stamp.mjs` 文件头)。`/@export/<id>/media/` 是导出自己的产物目录,照旧本地 stat。
     */
    this.mediaStamper = createMediaStamper({ mediaUrl, exportRoot: () => process.env.PROMPTCUT_EXPORT_DIR || path.dirname(this.root) });
    /**
     * C3 的就绪索引,**按页面会话分片**(Item 4)。SSE 端点(`GET /api/frames/ready?session=`)
     * 只订阅自己那个会话;会话的当前版本只由 `preload` 设定,发布一律经 `publishLayer(entry, …)` 过闸。
     */
    this.ready = createReadyHub();
    this.entries = new Map();
    /**
     * 别的环境已经产好、本机整条拉回来了的单卡流(任务书「甲二」):流的内容键 → 产它的环境指纹。每个 entry 带着这张表的引用
     * (`entry.streamLocks`),本机的流计划照它出键(`frame-stream.mjs` 的 `relockStreams`)。由 `adoptForeignStreams` 记,落盘在库根的
     * `stream-locks.json`(重启后拉回来的流照样用,不重产)。
     */
    this.streamLocks = this.loadStreamLocks();
    this.queue = [];
    // The human preview, Agent and background bake each own an independent
    // serialized queue.  A long Agent render must never hold the hot user Chrome.
    this.foreground = Promise.resolve();
    // 按模式建(`lanesOfMode`):`user` 模式没有 `'agent'`,`agent` 模式只有 `'agent'`
    this.laneChains = new Map(['user', 'agent', 'background'].filter(lane => lanesOfMode(this.mode).includes(lane)).map(lane => [lane, Promise.resolve()]));
    /**
     * 普通预渲染队列(`'queue'` lane 的待办,见 `runQueueTask`):按先后排,AI 栏的操作预览插在所有待办之前。
     * `queueRunning` 是 `'queue'` 预渲染间上正在跑的那一项(至多一项)。
     */
    this.queueTasks = [];
    this.queueRunning = null;
    /**
     * Agent 专用实例(`mechanism/rendering.md`「Agent 优先只是插队」):`agentPending` 是已排进 `runAgentTask`、
     * 还没做完的 Agent 任务数;它为 0 时专用实例接普通预渲染(`kickAgentIdle`),`agentUnit` 是它此刻借去做的那一项。
     */
    this.agentPending = 0;
    this.agentUnit = null;
    /** 专用实例做队列任务时给 Agent 让路的记录(诊断 `scheduler.yields`):批边界让路次数、做了几个 Agent 任务、让路总耗时、最近一次 */
    this.agentYieldStats = { count: 0, tasks: 0, ms: 0, last: null };
    /** 最近一个 Agent 任务做完的时刻;`agentGraceMs` 之内专用实例不接预渲染(测试给 0) */
    this.agentDoneAt = 0;
    this.agentGraceMs = AGENT_GRACE_MS;
    this.agentGraceTimer = null;
    /** 后台那一趟正在做的那张卡还没开工的批(`fillCardControls` 的 `share`),Agent 专用实例空闲时从这里取 */
    this.cardBatchPool = null;
    this.background = Promise.resolve();
    this.generations = new Map();
    this.lanes = new Map();
    // Keep two independent renderer processes ready for the editor.  A stuck
    // renderer can be discarded while the other one takes the next request.
    this.userPool = [];
    this.userPoolSize = 2;
    this.userPrewarm = null;
    // The editor can emit many pointer events before the previous render
    // completes. Keep one generation only; stale user requests must never
    // accumulate pages or force both hot Chromes to restart.
    this.userGeneration = 0;
    this.userGenerationController = null;
    /**
     * R8 的 `streamPool`(D5):轨道流自己的裸 bakery,**不经 `acquireUser`、不进 `laneChains`**,
     * 和 legacy 的 `userPool` 热池不共用会话。数量由 `StreamProducer` 定(缺省 1,最多 2)。
     */
    this.streamSessions = [];
  }
  /**
   * 热池在预渲染进程里的名字(D5)。R8 的轨道流按分段借还它
   * (`leaseStreamBakery()` / `returnStreamBakery()`,连同 G4 租约的 `dirty` 位:
   * 任何非 `bakeStream` 的调用跑完就置 `dirty`,下一次 `bakeStream` 见 `dirty`
   * 当租约断掉、付一次完整回放)—— 那两个方法是 R8 的,这里只留位。
   */
  get streamPool() { return this.streamSessions; }
  /** 本进程预渲染 Chrome 的环境指纹(16 位十六进制);还没定下来是 null */
  get envFingerprint() { return this.environment?.fingerprint ?? null; }
  /**
   * 定下本进程的环境(契约 E.2)。只在真的预渲染间上探测:`bakery.browser` / `bakery.page`
   * 缺一个就不探测(测试的假 bakery),原样返回 `this.environment`。
   *
   * **整个进程只定一次**,探测失败(`detected: false`)的结果也照样定下来。理由:指纹是结果键
   * 的因子,中途换一次指纹,这个进程此前写的快照、PNG 缓存、流就全部成了另一个键下的孤儿,
   * 页面上已经贴好的层也要整层重来;而同一个进程里所有预渲染间是同一套启动参数、同一个
   * Chrome 二进制,环境本来就不会变,再探一次得不到新信息。并发的调用共用同一趟探测。
   */
  async ensureEnvironment(bakery) {
    if (this.environment) return this.environment;
    if (!bakery?.browser || !bakery?.page) return this.environment;
    this.environmentProbe ||= probeBrowserEnvironment({ browser: bakery.browser, page: bakery.page }).then(environment => {
      /*
       * 仅供测试:`PROMPTCUT_TEST_ENV_FINGERPRINT`(16 位小写十六进制)把本进程的环境指纹换成给定值 —— 同一台机器上造一个
       * 「环境不同」的渲染节点(C10-A5:独立渲染主机的本机替身认领在线页面发布的清单计划)。生产环境不设。
       */
      const fake = String(process.env.PROMPTCUT_TEST_ENV_FINGERPRINT ?? '');
      if (/^[0-9a-f]{16}$/.test(fake)) environment = { ...environment, fingerprint: fake, testOverride: true };
      this.environment ||= environment;
      return this.environment;
    });
    return this.environmentProbe;
  }
  /** 等构造时开始的那次锁库 `load()` 落定(契约 F.3)。读盘失败也算落定 —— 当成没有锁 */
  async ensureCardLocks() {
    await this.cardLocksLoading;
  }
  /**
   * 按锁库把 plan 里共享档 control 的键换成锁定方的(契约 F.3 `applyCardLocks`)。**原地改**,
   * 对同一份 plan 重复调结果相同。每个 `tier === 'shared'` 且有 `contentKey` 的 control:
   *
   *   - 第一次见到时记下自己的键和指纹(`ownSnapshotKey` / `ownEnvFingerprint`);
   *   - 锁在别的指纹上:`snapshotKey = resultKeyOf(contentKey, 锁指纹)`、`envFingerprint = 锁指纹`、
   *     `cardLock = { envFingerprint, source, foreign: true }`;
   *   - 否则换回自己的键和指纹,`cardLock` 是锁(`foreign: false`)或 null。
   *
   * 投递、认领、就绪索引、扫盘重建因此都自动用锁定方的键。`key`(PNG 缓存)和 `contentKey` 不动。
   * 回这一趟有没有 control 换了键。
   */
  applyCardLocks(plan) {
    if (!Array.isArray(plan)) return false;
    const store = this.cardLockStore;
    let changed = false;
    for (const control of plan) {
      if (!control?.contentKey) continue;
      if ((control.tier || snapshotTier(control.capabilities)) !== 'shared') continue;
      if (!Object.hasOwn(control, 'ownSnapshotKey')) {
        control.ownSnapshotKey = control.snapshotKey;
        control.ownEnvFingerprint = control.envFingerprint;
      }
      const before = `${control.snapshotKey}\u0000${control.envFingerprint}\u0000${control.cardLock?.foreign === true}`;
      const lock = store?.get(control.contentKey) ?? null;
      if (lock && lock.envFingerprint !== control.ownEnvFingerprint) {
        control.snapshotKey = resultKeyOf(control.contentKey, lock.envFingerprint);
        control.envFingerprint = lock.envFingerprint;
        control.cardLock = { envFingerprint: lock.envFingerprint, source: lock.source, foreign: true };
      } else {
        control.snapshotKey = control.ownSnapshotKey;
        control.envFingerprint = control.ownEnvFingerprint;
        control.cardLock = lock ? { envFingerprint: lock.envFingerprint, source: lock.source, foreign: false } : null;
      }
      if (before !== `${control.snapshotKey}\u0000${control.envFingerprint}\u0000${control.cardLock?.foreign === true}`) changed = true;
    }
    if (changed) this.cardLockEpoch = (this.cardLockEpoch || 0) + 1;
    return changed;
  }
  /** 锁变了之后把 entry 的 card plan(以及调用方手里另一份 control 列表)一起按锁库重排一遍 */
  reapplyCardLocks(entry, controls = null) {
    let changed = this.applyCardLocks(entry?.cardPlan);
    if (Array.isArray(controls) && controls !== entry?.cardPlan) changed = this.applyCardLocks(controls) || changed;
    return changed;
  }
  /** 不带 session 的调用方(脚本、探针)那个会话的索引。页面走 `this.ready.subscribe(session, …)` */
  get readyIndex() { return this.ready.session(DEFAULT_READY_SESSION).index; }
  get streamPoolSize() { return this._streams?.pool ?? STREAM_POOL_DEFAULT; }
  set streamPoolSize(value) { if (this._streams) this._streams.pool = Math.max(1, Math.min(STREAM_POOL_MAX, Math.round(value) || 1)); }
  /**
   * 轨道流的生产者(R8 / G4)。**只在接交互的那个实例(预渲染进程,`interactive: true`)里有** ——
   * 编辑器进程不产流;`streams` 开关关着(`PROMPTCUT_STREAMS=0`)时它在,但什么都不做。
   */
  streamProducer() {
    // `agent` 模式不产流(不预渲染)
    if (!this.interactive || this.closed || !modeServesPrerender(this.mode)) return null;
    return this._streams ||= new StreamProducer(this);
  }
  /**
   * 借一个轨道流会话(G4「会话从哪来」)。空闲的先借;没有就新开一个裸 bakery
   * (停在空项目页上,第一次 `bakeStream` 之前由生产者把隔离工程灌进来)。
   * 同时开着的会话不超过 `STREAM_POOL_MAX`。
   */
  async leaseStreamBakery() {
    for (;;) {
      if (this.closed) throw Object.assign(new Error('Renderer closed'), { cancelled: true });
      const free = this.streamSessions.find(s => !s.busy && !s.dead && s.bakery);
      if (free) {
        free.busy = true;
        clearTimeout(free.idleTimer);
        return free.bakery;
      }
      if (this.streamSessions.filter(s => !s.dead).length < STREAM_POOL_MAX) {
        const session = { bakery: null, busy: true, dead: false, idleTimer: null };
        this.streamSessions.push(session);
        try {
          session.bakery = await openBakery({ url: this.emptyUrl() });
          session.bakery.streamLease = null;
          // M4:和 `bakery()` 一样,开起来就定指纹(这两处是本进程仅有的 openBakery 调用点)
          await this.ensureEnvironment(session.bakery);
          return session.bakery;
        } catch (error) {
          session.dead = true;
          const at = this.streamSessions.indexOf(session);
          if (at >= 0) this.streamSessions.splice(at, 1);
          throw error;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  /**
   * 还回轨道流会话。`dirty`:借去做了别的(非 `bakeStream`)事 —— 租约作废(D5)。
   * `dead`:会话坏了,关掉。空闲 60 秒的会话也关掉(预渲染进程自建池,不常驻热池)。
   */
  returnStreamBakery(bakery, { dirty = false, dead = false } = {}) {
    const session = this.streamSessions.find(s => s.bakery === bakery);
    if (!session) return;
    if (dirty) dirtyStreamLease(bakery);
    if (dead || this.closed) {
      session.dead = true;
      const at = this.streamSessions.indexOf(session);
      if (at >= 0) this.streamSessions.splice(at, 1);
      void bakery.close().catch(() => {});
      return;
    }
    session.busy = false;
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.busy || session.dead) return;
      session.dead = true;
      const at = this.streamSessions.indexOf(session);
      if (at >= 0) this.streamSessions.splice(at, 1);
      void bakery.close().catch(() => {});
    }, 60000);
    session.idleTimer.unref?.();
  }
  /**
   * 现在是不是「忙」(G0-b 结论 1:只在机器空闲时生产;用户拖动或播放时生产暂停让路)。
   * 判据:legacy 播放热池在用 / 后台让路租约在期;镜像插件报的播放头「在播」且 5 秒内有过音讯
   * (播放中页面每 2 秒发一条保活 `PLAYHEAD_KEEPALIVE_MS`,有缺口时另按 100 ms 节流报 `wanted`,停下也会报一次);或者 800 ms 内刚动过(拖动)。
   */
  streamBusy(now = Date.now()) {
    if (this.closed) return true;
    if (this.playback?.playing) return true;
    if (this.backgroundLeaseUntil > now) return true;
    let head = null;
    try { head = this.playhead(); } catch {}
    const at = Number(head?.at);
    if (Number.isFinite(at)) {
      if (head.playing && now - at < 5000) return true;
      if (now - at < 800) return true;
    }
    return false;
  }
  /**
   * 这个实例接不接页面的交互 / 播放 lane(D5 的 `interactive`),以及 Agent lane。
   *
   * `interactive: false` 的实例(编辑器进程)**没有 Agent lane**:Agent 的查询(`see_frames` 的
   * agent 批、`layout`、`entityRects`、`/api/cards/dom`)只在预渲染进程里跑
   * (`docs/semantics/mechanism/rendering.md`「查询渲染与预渲染进程」)。编辑器进程里
   * 走到这里就回 `503 NO_AGENT_LANE`,不在编辑器这一侧开 Chrome。
   */
  laneRefused(lane) {
    // 预渲染进程按模式拒(`modeRefusal`):`user` 模式拒 Agent 的查询,`agent` 模式拒预渲染的各条 lane
    if (this.interactive) return modeRefusal(this.mode, lane);
    if (lane === 'agent') return Object.assign(new Error('这个进程没有 Agent lane:Agent 的查询只在预渲染进程里跑。'), { status: 503, code: 'NO_AGENT_LANE', retryable: true });
    if (lane !== 'user' && lane !== 'playback') return null;
    return Object.assign(new Error('交互帧请求请直接打预渲染进程。'), { status: 503, code: 'USE_PRERENDER' });
  }
  /**
   * **Agent lane 的唯一入队口**(T1a 审查 #12)。`see_frames` 的 agent 批、`layout`、`entityRects`、
   * `/api/cards/dom`(`vite-plugin-cards.ts`)都经它排进同一条链:每个任务「等前一个 → 借 bakery →
   * 干活 → 还」,所以同一时刻至多一个任务在驱动 agent lane 的那一个页面,谁也绕不过谁。
   *
   * 以前 `layout` / `entityRects` 各自 `laneChains.get('agent')` 再 `set` 回去,`/api/cards/dom`
   * 另有一条 `domChain` 和一个自己的 Chrome —— 后者和在飞的 `see_frames` 同时驱动页面是可能的。
   *
   * `work(lease)`:`lease(project)` 借 agent lane 的 bakery,按 `project` 重置同一个页面
   * (一个任务里可以借多次,比如一批里有两个项目);`lease(project, { asIs: true })` 不重置、
   * 原样交出(调用方马上自己 `reset`,省一次开页)。**借过才还,还由这里统一做**,调用方不调
   * `release('agent')`。空闲关闭见 `release`。
   */
  runAgentTask(work) {
    const refused = this.laneRefused('agent');
    if (refused) return Promise.reject(refused);
    // 专用实例正借去做一项普通预渲染(`kickAgentIdle`)时,这个任务排在那一项之后:不打断它,做完就轮到这里
    this.agentPending++;
    const queuedAt = Date.now();
    const body = async () => {
      this.noteSched('agent', 'agent', Date.now() - queuedAt);
      let leased = false;
      const lease = async (project, { asIs = false } = {}) => {
        leased = true;
        const current = this.lanes.get('agent');
        if (asIs && current) { clearTimeout(current.timer); current.expired = false; return current.bakery; }
        return this.acquire('agent', project);
      };
      try { return await work(lease); }
      finally { if (leased) this.release('agent'); }
    };
    /*
     * 专用实例正借去做一项普通预渲染队列的项(`kickAgentIdle` 取的 `source: 'queue'`)时,不排在它整项之后:
     * 放进它的收件箱,由它在下一个批边界(4 帧)停下来先做(`drainAgentInbox`),做完再接着做它自己的
     * (AGENT-maint-3)。那一项的工作不在批边界停时(计划、预览这类),收件箱在它开工前、做完后各清一次。
     */
    const unit = this.agentUnit;
    if (unit?.inbox && !unit.inboxClosed) {
      const task = new Promise((resolve, reject) => { unit.inbox.push({ body, resolve, reject }); unit.wake?.(); });
      task.catch(() => {}).finally(() => { this.agentPending--; this.agentDoneAt = Date.now(); this.kickAgentIdle(); });
      return task;
    }
    const task = (this.laneChains.get('agent') || Promise.resolve()).catch(() => {}).then(body);
    const settled = task.finally(() => { this.agentPending--; this.agentDoneAt = Date.now(); this.kickAgentIdle(); });
    this.laneChains.set('agent', settled.catch(() => {}));
    return task;
  }
  /**
   * **普通预渲染队列的入队口**(`'queue'` lane)。队列执行器(`prerender-executor.mjs`,契约 J.4)的细任务、
   * AI 栏的操作预览(`see_frames` 的 `'preview'` 批)、3D 视图的空闲贴图预取(`'prerender'` 批)都排在这里;
   * `'queue'` lane 自己一个预渲染间,一次做一项(等前一个 → 借 → 干活 → 还),`closeNow` 会等它(`queueSettled`)。
   *
   * `work(lease)`:`lease(project)` 借预渲染间并按 `project` 重置;借过才还,还由这里做(空闲 30 秒关,同 `'background'`)。
   * 轮到它时 `signal` 已经中止、或管线已关,就不借、直接以 `cancelled` 拒绝。
   *
   * 选项(`mechanism/rendering.md`「查询渲染与预渲染进程」、`product/rendering.md`「AI 栏的操作预览可以插队」):
   *   - `front`:插在所有待办之前(已排着的插队项之后,插队项之间仍按先后)。**正在跑的那一项不打断** ——
   *     它做完,下一个就是插队项。缺省排队尾。
   *   - `agentOk`:Agent 专用实例空闲时能不能替 `'queue'` 预渲染间接这一项(`kickAgentIdle`)。缺省是 `!front`:
   *     插队项是用户触发的,**不占用 Agent 的专用实例**;普通预渲染可以。
   *   - `tag`:同一 `tag` 的两项不同时在两个实例上跑(`card:<control.key>` / `scene:<entry.key>`:同一张卡、
   *     同一版的整场景不并发渲)。缺省没有,不设限。
   *   - `scaleLane`:借预渲染间时按哪条 lane 的缩放(`scaleForLane`)。缺省 `'queue'`;操作预览、贴图预取给 1 倍。
   *   - `kind`:只给诊断看(`diagnostics().scheduler`):`'queue'`(细任务)/ `'preview'` / `'prerender'`。
   */
  runQueueTask(work, signal, { front = false, agentOk = !front, tag = null, scaleLane = 'queue', kind = 'queue' } = {}) {
    // `agent` 模式不做预渲染:队列任务、操作预览、贴图预取一律当场回 `503 NO_PRERENDER`,不排队、不挂住
    const refused = this.laneRefused('queue');
    if (refused) return Promise.reject(refused);
    return new Promise((resolve, reject) => {
      const item = { work, signal, front, agentOk, tag, scaleLane, kind, resolve, reject, queuedAt: Date.now() };
      if (front) {
        const at = this.queueTasks.findIndex(other => !other.front);
        if (at < 0) this.queueTasks.push(item); else this.queueTasks.splice(at, 0, item);
      } else this.queueTasks.push(item);
      this.pumpQueue();
      this.kickAgentIdle();
    });
  }
  /** `'queue'` 预渲染间空着就取下一项:队头优先,跳过和 Agent 专用实例手里那一项同 `tag` 的 */
  pumpQueue() {
    if (this.queueRunning) return;
    const busy = this.agentUnit?.tag ?? null;
    const at = this.queueTasks.findIndex(item => !item.tag || item.tag !== busy);
    if (at < 0) return;
    const [item] = this.queueTasks.splice(at, 1);
    this.queueRunning = item;
    this.noteSched(item.kind, 'queue', Date.now() - item.queuedAt);
    item.run = this.runQueueItem(item, 'queue').then(item.resolve, item.reject)
      .finally(() => { this.queueRunning = null; this.pumpQueue(); this.kickAgentIdle(); });
  }
  /**
   * 在某个实例上做一项普通预渲染。`worker`:`'queue'` 借 `'queue'` lane 的预渲染间(借过才还);
   * `'agent'` 借 Agent 专用实例那个已经开着的预渲染间(`resetAgentFor`),不还、不动它的空闲计时器 ——
   * 那个计时器只按 Agent 自己的任务算。
   */
  async runQueueItem(item, worker, unit = null) {
    if (this.closed || item.signal?.aborted) throw Object.assign(new Error('Queue task cancelled'), { cancelled: true });
    let leased = false, session = null;
    const lease = async project => {
      leased = true;
      if (worker !== 'agent') return this.acquire('queue', project, { scaleLane: item.scaleLane });
      const bakery = await this.resetAgentFor(project, item.scaleLane);
      session = this.lanes.get('agent') ?? null;
      return bakery;
    };
    /*
     * 第二个参数(AGENT-maint-3):在哪个实例上做,以及专用实例上的让路口。`work` 不认它时行为不变。
     *   `shouldYield()`  此刻有 Agent 任务在等这个实例(收件箱不空);
     *   `yieldPoint({ heartbeat })`  在批边界调:有 Agent 任务就先把它们做完(连着来的一次做完)再回来,回 true。
     *                   页面被 Agent 任务换过,下一批开头自己会按队列任务的状态 `reset`。专用实例在让路时被换掉
     *                   (Agent 任务重开了 Chrome)抛 `agentGone`,这一项交还 `'queue'` 预渲染间接着做(已交的帧不重做)。
     */
    const ctx = worker === 'agent' && unit?.inbox ? {
      worker,
      shouldYield: () => unit.inbox.length > 0,
      yieldPoint: async ({ heartbeat } = {}) => {
        if (!unit.inbox.length) return false;
        await this.drainAgentInbox(unit, { heartbeat, reason: 'batch' });
        if (this.closed || item.signal?.aborted) throw Object.assign(new Error('Queue task cancelled'), { cancelled: true });
        if (session && this.lanes.get('agent') !== session) throw Object.assign(new Error('Agent 专用实例在让路时换掉了'), { agentGone: true });
        return true;
      },
    } : { worker, shouldYield: () => false, yieldPoint: async () => false };
    try { return await item.work(lease, ctx); }
    finally { if (leased && worker === 'queue') this.release('queue'); }
  }
  /**
   * 把专用实例收件箱里的 Agent 任务按先后做完(做的时候又来的也接着做:「连着来的一次做完再切回」),
   * 期间每 `AGENT_YIELD_BEAT_MS` 调一次 `heartbeat`(队列任务的工作计数,租约不因让路被当成停滞)。记进 `agentYieldStats`。
   * 批边界让路时,收件箱清空后再等 `agentGraceMs`(1 秒)看有没有紧跟着的:Agent 的一次工具调用常是前后脚的几个任务
   * (`see_frames` 渲完才排「量实体框」),不等的话中间要切回队列任务一次(一次换页加一个 4 帧块)才轮到下一个〔裁〕。
   * `reason`:`'batch'` = 队列任务在批边界让路;`'start'` / `'end'` = 那一项开工前、做完后清收件箱。回做了几个。
   */
  async drainAgentInbox(unit, { heartbeat = null, reason = 'batch' } = {}) {
    if (!unit?.inbox?.length) return 0;
    const t0 = Date.now();
    let tasks = 0;
    const beat = () => { try { heartbeat?.(); } catch { /* 心跳出错不影响让路 */ } };
    beat();
    const timer = heartbeat ? setInterval(beat, AGENT_YIELD_BEAT_MS) : null;
    timer?.unref?.();
    const grace = reason === 'batch' ? Math.max(0, Number(this.agentGraceMs) || 0) : 0;
    const next = () => new Promise(resolve => {
      if (unit.inbox.length || !grace || this.closed) return resolve();
      const timer = setTimeout(() => { unit.wake = null; resolve(); }, grace);
      unit.wake = () => { clearTimeout(timer); unit.wake = null; resolve(); };
    });
    try {
      for (;;) {
        while (unit.inbox.length) {
          const job = unit.inbox.shift();
          tasks++;
          try { job.resolve(await job.body()); } catch (error) { job.reject(error); }
        }
        await next();
        if (!unit.inbox.length) break;
      }
    } finally {
      if (timer) clearInterval(timer);
      beat();
    }
    const ms = Date.now() - t0;
    const stats = this.agentYieldStats;
    if (reason === 'batch') stats.count++;
    stats.tasks += tasks;
    stats.ms += ms;
    stats.last = { at: t0, ms, tasks, reason };
    return tasks;
  }
  /**
   * 把 Agent 专用实例那个开着的预渲染间按 `project` 重置,交给一项普通预渲染用。专用实例已经关了、或重置失败
   * (失败时关掉它,下一个 Agent 任务重开)都抛 `agentGone`:调用方把这一项交还 `'queue'` 预渲染间。
   */
  async resetAgentFor(project, scaleLane = 'queue') {
    const session = this.lanes.get('agent');
    if (!session) throw Object.assign(new Error('Agent 专用实例已经关了'), { agentGone: true });
    try {
      await session.bakery.reset(project, this.emptyUrl(project), { deferCards: true });
      await session.bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: this.scaleForLane(scaleLane) });
      await session.bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      return session.bakery;
    } catch (error) {
      if (this.lanes.get('agent') === session) { clearTimeout(session.timer); this.lanes.delete('agent'); }
      await Promise.resolve(session.bakery.close?.()).catch(() => {});
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { agentGone: true });
    }
  }
  /**
   * **Agent 专用实例空闲时接普通预渲染**(`mechanism/rendering.md`「Agent 优先只是插队」)。
   *
   * 条件全部成立才接一项:
   *   - 这个实例有 Agent lane(`interactive`,编辑器进程没有);
   *   - Agent 队列空(`agentPending === 0`),手里也没有别的预渲染项(`agentUnit`);
   *   - 专用实例的预渲染间**已经开着、还没到空闲关闭**(`lanes.get('agent')`,且没标 `expired`):
   *     不为接预渲染去开 Chrome,Agent 最近 `AGENT_IDLE_MS` 用过它才接;
   *   - 不在播放让路期间(同后台那一趟);
   *   - 离最近一个 Agent 任务做完已经过了 `agentGraceMs`(`AGENT_GRACE_MS`):还没到就定个计时器,到点再判。
   *
   * 接哪一项:先是普通预渲染队列里第一个 `agentOk`、且和 `'queue'` 预渲染间手里那一项不同 `tag` 的;没有就从后台那一趟
   * 正在做的那张卡里取一批(`cardBatchPool`)。**一次只接一项**,接的那一项挂在 `laneChains.get('agent')` 链尾:
   *   - 它开工时 Agent 队列是空的,所以它不排在任何 Agent 任务前面;
   *   - 它开工之后到的 Agent 任务排在它后面 —— 不打断它,它做完就轮到 Agent;
   *   - 它做完回到这里重新判,Agent 队列不空就不接(`agentPending > 0`),所以 Agent 任务永远不排在排队中的预渲染后面。
   */
  kickAgentIdle() {
    if (this.closed || !this.interactive || this.agentPending > 0 || this.agentUnit) return;
    // 只有 `full` 模式两样都有:`user` 模式没有专用实例,`agent` 模式没有预渲染可接
    if (!modeServesAgent(this.mode) || !modeServesPrerender(this.mode)) return;
    const session = this.lanes.get('agent');
    if (!session || session.expired) return;
    if (this.backgroundYielding || this.backgroundLeaseUntil > Date.now()) return;
    const wait = this.agentDoneAt + this.agentGraceMs - Date.now();
    if (wait > 0) {
      if (!this.agentGraceTimer) {
        this.agentGraceTimer = setTimeout(() => { this.agentGraceTimer = null; this.kickAgentIdle(); }, wait);
        this.agentGraceTimer.unref?.();
      }
      return;
    }
    const unit = this.takeAgentUnit();
    if (!unit) return;
    this.agentUnit = unit;
    const run = (this.laneChains.get('agent') || Promise.resolve()).catch(() => {}).then(async () => {
      // 排进来到开工之间到的 Agent 任务先做(它们进了收件箱,不排在这一项之后)
      await this.drainAgentInbox(unit, { reason: 'start' });
      const current = this.lanes.get('agent');
      if (!current || current !== session || this.closed) { unit.giveBack(); return; }
      current.unitRunning = true;
      try { await unit.run(current.bakery); }
      finally {
        current.unitRunning = false;
        // 空闲计时器在它做的时候到了点:做完再关;这时又有 Agent 任务排着就不关,由它接着用
        if (current.expired && this.agentPending === 0 && this.lanes.get('agent') === current) {
          this.lanes.delete('agent');
          void Promise.resolve(current.bakery.close?.()).catch(() => {});
        }
      }
    }).finally(async () => {
      // 收件箱里剩下的(最后一批之后才到的)做完再放手;清空的那一刻关上收件箱,之后到的照常排链
      try { await this.drainAgentInbox(unit, { reason: 'end' }); } finally {
        if (unit.inbox) unit.inboxClosed = true;
        this.agentUnit = null; this.pumpQueue(); this.kickAgentIdle();
      }
    });
    this.laneChains.set('agent', run.catch(() => {}));
  }
  /**
   * `kickAgentIdle` 取的那一项,形状 `{ tag, source, run(bakery), giveBack() }`。取出即从原处摘掉;
   * `giveBack` 放回原处(专用实例在它开工前关了)。没有能接的回 null。
   */
  takeAgentUnit() {
    const busy = this.queueRunning?.tag ?? null;
    const at = this.queueTasks.findIndex(item => item.agentOk && (!item.tag || item.tag !== busy));
    if (at >= 0) {
      const [item] = this.queueTasks.splice(at, 1);
      this.noteSched(item.kind, 'agent', Date.now() - item.queuedAt);
      const giveBack = () => { this.queueTasks.splice(Math.min(at, this.queueTasks.length), 0, item); this.pumpQueue(); };
      const unit = {
        tag: item.tag, source: 'queue', giveBack,
        /** 等这个实例的 Agent 任务(`runAgentTask` 放进来,`drainAgentInbox` 做) */
        inbox: [],
        run: async () => {
          try { item.resolve(await this.runQueueItem(item, 'agent', unit)); }
          catch (error) {
            // 借不到专用实例的预渲染间:这一项没做成,交还 `'queue'` 预渲染间,不算失败
            if (error?.agentGone && !this.closed && !item.signal?.aborted) giveBack();
            else item.reject(error);
          }
        },
      };
      return unit;
    }
    const batch = this.cardBatchPool?.take() ?? null;
    if (batch) this.noteSched('card-batch', 'agent');
    return batch;
  }
  /**
   * **队列模式的认领闸**(`mechanism/rendering.md`「Agent 优先只是插队」;`AGENT-query-render.md` 第 7 节第 2 条):
   * 此刻 Agent 专用实例能不能再接一项普通预渲染 —— 本机渲染节点据此在 `maxConcurrent` 之外多认领一项快照任务给它做。
   *
   * 条件与 `kickAgentIdle` 接活的条件相同(`full` 模式、专用实例开着且没到空闲关闭、Agent 队列空、手里没有预渲染项、
   * 不在播放让路),外加普通预渲染队列里没有它能接的待办(有的话它自己会接,不用多认领)。**不看 1 秒空档**:
   * 认领要一个来回,任务到手时空档多半已过;没过的话 `kickAgentIdle` 自己等到点再接。
   * 专用实例没开时回 false —— 不为接预渲染开新实例。
   */
  agentSpareSlot() {
    if (this.closed || !this.interactive || !modeServesAgent(this.mode) || !modeServesPrerender(this.mode)) return false;
    if (this.agentPending > 0 || this.agentUnit) return false;
    const session = this.lanes.get('agent');
    if (!session || session.expired) return false;
    if (this.backgroundYielding || this.backgroundLeaseUntil > Date.now()) return false;
    const busy = this.queueRunning?.tag ?? null;
    return !this.queueTasks.some(item => item.agentOk && (!item.tag || item.tag !== busy));
  }
  /**
   * 调度记录(只给诊断看,`diagnostics().scheduler`):`kind` 是哪种活(`'agent'` = Agent 任务,`'queue'` / `'preview'` /
   * `'prerender'` = 普通预渲染队列的项,`'card-batch'` = 后台那一趟的一批),`worker` 是在哪个实例上开工
   * (`'agent'` = Agent 专用实例,`'queue'` = `'queue'` lane 的预渲染间),`waitMs` 是从排进来到开工等了多久
   * (Agent 任务等专用实例手里那一项做完;普通预渲染等排在它前面的)。计数一直累加,明细留最近 64 条。
   */
  noteSched(kind, worker, waitMs = null) {
    const stats = (this.schedStats ||= { counts: {}, recent: [] });
    const key = `${kind}@${worker}`;
    stats.counts[key] = (stats.counts[key] ?? 0) + 1;
    stats.recent.push({ kind, worker, at: Date.now(), ...(waitMs === null ? {} : { waitMs }) });
    while (stats.recent.length > 64) stats.recent.shift();
  }
  /** 普通预渲染队列做完:待办清空、两个实例手里都没有它的项(`closeNow` 等它) */
  async queueSettled() {
    for (;;) {
      const running = [this.queueRunning?.run, this.agentUnit?.source === 'queue' ? this.laneChains.get('agent') : null].filter(Boolean);
      if (!running.length) {
        if (!this.queueTasks.length) return;
        this.pumpQueue();
        if (!this.queueRunning) return;
        continue;
      }
      await Promise.allSettled(running);
    }
  }
  /** C4:镜像插件里这一刻的 `wanted`(页面报的「播放头附近现在缺哪些层」) */
  playheadWanted() {
    try { return this.playhead()?.wanted ?? []; } catch { return []; }
  }
  /** C4:`wanted` 让哪一批插了队。只给诊断看,留最近 32 条 */
  notePromotion(record) {
    (this.promotions ||= []).push({ ...record, at: Date.now() });
    while (this.promotions.length > 32) this.promotions.shift();
  }
  /** 端到端探针的读口:超限帧(A3c)、`wanted` 的插队(C4)、预渲染集合(pinned 渲染 9) */
  diagnostics() {
    return { oversize: this._snapshots?.oversize ?? [], promotions: this.promotions ?? [], plans: this.planDiagnostics(),
      streams: this._streams?.status() ?? null, ready: this.ready.describe(), environment: this.environment,
      // 契约 F.3:本机锁库此刻的全部锁
      cardLocks: this.cardLockStore?.list() ?? [],
      // 查询渲染的调度(`noteSched`):Agent 任务、普通预渲染各在哪个实例上开工;此刻 Agent 队列与普通预渲染队列的长度
      scheduler: { ...(this.schedStats ?? { counts: {}, recent: [] }), agentPending: this.agentPending, queueWaiting: this.queueTasks.length,
        queueRunning: this.queueRunning?.kind ?? null, agentUnit: this.agentUnit?.source ?? null, agentOpen: this.lanes.has('agent'), agentSpare: this.agentSpareSlot(),
        // 专用实例做队列任务时给 Agent 让路(AGENT-maint-3):批边界让路次数、做了几个 Agent 任务、让路总耗时、最近一次
        yields: { ...this.agentYieldStats } },
      // 预渲染进程的模式与它建的 lane(`prerender-mode.mjs`);编辑器进程(`interactive: false`)没有这些 lane
      mode: { mode: this.mode, lanes: this.interactive ? lanesOfMode(this.mode) : [] },
      // C6.4:只在配了推送队列时才有这两项(没配时诊断的形状不变)
      ...(this.pushQueue ? { push: this.pushQueue.stats?.() ?? null, adoption: this.lastAdoption ?? null } : {}),
      // 任务书「甲二」:别的环境产好、本机整条拉回来照它的键用的单卡流(有才带这一项,没有时诊断的形状不变)
      ...(this.streamLocks.size || this.lastForeignStreams ? { foreignStreams: { locks: [...this.streamLocks], last: this.lastForeignStreams ?? null } } : {}) };
  }
  /**
   * 每个 entry 此刻的预渲染集合和它的 card plan 摘要 —— `ready-index-probe` 靠它
   * 证明「在所有位置都判轻的卡不产快照」,顺带把 `costKey` 露出来,探针才能为某张卡
   * PUT 一条成本记录(那个键只有 `card-cache.mjs` 的 `plan()` 算得出来)。只读、不改状态。
   */
  planDiagnostics() {
    const list = [];
    for (const entry of this.entries?.values?.() ?? []) {
      if (!entry?.cardPlan?.length) continue;
      list.push({
        key: entry.key,
        prerenderSet: entry.prerenderSet instanceof Set ? [...entry.prerenderSet].sort() : null,
        controls: entry.cardPlan.map(control => ({
          clipId: control.clipId, costKey: control.costKey, snapshotKey: control.snapshotKey,
          // M4:探针据此核对 `snapshotKey === resultKeyOf(contentKey, envFingerprint)`
          contentKey: control.contentKey, envFingerprint: control.envFingerprint,
          // 契约 F.3:锁在谁身上(`foreign: true` = 锁定方是别的环境,键已换成锁定方的)
          cardLock: control.cardLock ?? null,
          frameMode: control.frameMode ?? control.capabilities?.frameMode ?? null,
          tier: control.snapshotKey ? (control.tier || snapshotTier(control.capabilities)) : 'none',
          picked: this.prerenderPicked(entry, control.clipId),
        })),
      });
    }
    return list;
  }
  /**
   * 子集的整场景键：`project` 按 `need` 展开（`render-node/expand.mjs`，确定的），再照 `entry()` 同一个算法算键
   * （卡片代码身份也只取子集里用到的）。同步：`project` 要是已经盖过素材戳的那一份（`entry.project`）。`need` 为空回整个项目的键
   */
  subsetFrameKey(project, need) {
    const sub = need ? expandProject(project, need).project : project;
    let cardSources = {};
    try { cardSources = this.cardSources(sub) ?? {}; } catch { cardSources = {}; }
    return frameIdentity(sub, cardEntryCode(this.code(sub), cardSources));
  }
  async entry(project) {
    project = { ...project, media: await Promise.all((project.media || []).map(async media => {
      const stamp = await this.mediaStamper.stamp(media);
      return stamp === undefined ? media : { ...media, _frameSourceStamp: stamp };
    })) };
    // 身份在这里算一次、记在 entry 上:整场景键与切分时的 requires.cardSources 必须出自同一次计算
    let cardSources = {};
    try { cardSources = this.cardSources(project) ?? {}; } catch { cardSources = {}; }
    const code = cardEntryCode(this.code(project), cardSources);
    const key = frameIdentity(project, code);
    if (!this.entries.has(key)) {
      const entry = { key, code, cardSources, project: structuredClone(project), recordVersion: 0, html: new Map(), controls: new Map(), dir: path.join(this.root, key), status: 'idle', error: null };
      // Controls are content addressed independently of the full-scene entry;
      // a project edit that invalidates the scene can still reuse an unchanged
      // card MOV from <pipeline-root>/controls/<control-key>.
      entry.cardCache = new CardFrameCache({ root: this.root, project: entry.project,
        capture: () => this.captureCode(), scale: () => this.scaleForLane('background'),
        // 传函数不传值:entry 可能在第一个预渲染间开起来、指纹定下之前就建好了
        envFingerprint: () => this.envFingerprint });
      const cold = createFrameArchive({ spillDir: path.join(entry.dir, 'html-cache') });
      entry.html = cold.frames; entry.controls = cold.controls;
      entry.createControl = cold.createControl; entry.disposeArchive = cold.dispose;
      entry.mov = new MovFrameStore({ dir: entry.dir, fps: project.fps || 30, movie: false });
      // A removed or replaced full-scene frame must not stay published in the
      // playback movie: put that sample back to transparent.
      entry.mov.onEvict = frame => entry.playbackMovie?.evict(frame);
      entry.streamLocks = this.streamLocks;
      // 按「这几帧展开出的子集」算的整场景键（0.7.19 多项目模式定的键口径：键认的是会影响这几帧画面的东西，不是整个项目）。
      // 依赖下层的流退回整场景时用它（`frame-stream.mjs` 的 `belowStreamSpecs`）；发布方与节点同一个算法，所以同一条流两边逐字节相同
      entry.subsetKey = need => this.subsetFrameKey(entry.project, need);
      this.entries.set(key, entry);
      entry.loading = this.loadArchive(entry).then(archive => {
        try {
          entry.disposeArchive?.();
          entry.html = archive.frames;
          entry.controls = archive.controls;
          entry.createControl = archive.createControl;
          entry.disposeArchive = archive.dispose;
        } catch { /* Disposable cache. */ }
      }, () => {});
    }
    const entry = this.entries.get(key);
    await entry.loading;
    return entry;
  }
  async loadArchive(entry) {
    const options = { dir: entry.dir, spillDir: path.join(entry.dir, 'html-cache') };
    try { return unpackFrameCache(await fs.readFile(path.join(entry.dir, 'html-manifest.json'), 'utf8'), entry.key, options); }
    catch {
      const file = path.join(entry.dir, 'snapshots.base64');
      // Old monolithic local caches are disposable. Do not read a multi-GB
      // legacy file into memory just to discover that it cannot be opened.
      if ((await fs.stat(file)).size > 32 * 1024 * 1024) throw new Error('Legacy frame cache exceeds import budget');
      return unpackFrameArchive(await fs.readFile(file, 'utf8'), entry.key, options);
    }
  }
  async portableArchive(entry) {
    await this.save(entry);
    return packFrames(entry.key, entry.html, entry.controls, { fps: entry.project.fps || 30, maxBytes: 16 * 1024 * 1024 });
  }
  async bakery(project, lane = 'agent') {
    const empty = { ...project, tracks: [], media: [] };
    const url = this.origin() + '/?export=1&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty)));
    const bakery = await openBakery({ url });
    try {
      // M4:第一个预渲染间开起来就定下本进程的环境指纹,之后算 card plan 才有键可产
      await this.ensureEnvironment(bakery);
      // c10a 第 9 节:换页之前先把攒着的预渲染小尺寸在旧页上画完
      bakery.beforeReset = b => this.flushSmallOn(b);
      await bakery.loadProject(project, { deferCards: true });
      await bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: this.scaleForLane(lane) });
      await bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
      return bakery;
    }
    catch (e) { await bakery.close(); throw e; }
  }
  scaleForLane(lane) {
    // J.4:`'queue'` lane 产的是后台那一趟同一种结果,用同一个缩放
    if (lane !== 'background' && lane !== 'queue') return 1;
    const value = Number(process.env.PROMPTCUT_PRERENDER_SCALE || 1);
    return Number.isFinite(value) && value > 0 ? Math.min(3, Math.max(0.5, value)) : 1;
  }
  /** What a full-scene frame must have been produced by to be served: the
   * capture code and the keys of the cards visible at that frame. The entry key
   * already covers the project; these are the inputs it does not. Card keys are
   * unknown (null) until a browser plan has been computed for this entry.
   *
   * The device scale is deliberately not part of it: with
   * PROMPTCUT_PRERENDER_SCALE set, the background lane and the 1x lanes would
   * evict each other's frames forever and full.mov would never complete. Mixed
   * scales in one store predate this check and remain as they were. */
  // eslint-disable-next-line no-unused-vars
  renderSignature(entry, frame, lane) {
    const fps = Number(entry.project.fps) || 30;
    let cards = null;
    if (Array.isArray(entry.cardPlan)) {
      const keys = entry.cardPlan.filter(control => frame >= control.sampling.firstFrame && frame / fps < control.end - 1e-9)
        .map(control => control.key).sort();
      cards = createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 32);
    }
    return { capture: this.captureCode() || undefined, cards };
  }
  /**
   * `scaleLane`:按哪条 lane 的缩放设视口(`scaleForLane`),缺省就是 `lane`。`'queue'` lane 上做 AI 栏的操作预览、
   * 贴图预取时给 `'preview'`(1 倍,同它们原来在 Agent lane 上的缩放)。
   */
  async acquire(lane, project, { scaleLane = lane } = {}) {
    // 模式不接这条 lane(`agent` 模式的 `'background'` / `'queue'`,`user` 模式的 `'agent'`):不开 Chrome,当场拒。
    // `'background'` 同时标 `cancelled`,后台那一趟照「让路」收手(cloud-task.md I1)
    const refused = this.interactive ? modeRefusal(this.mode, lane) : null;
    if (refused) throw Object.assign(refused, lane === 'background' ? { cancelled: true } : {});
    // 只有后台那一趟在借预渲染间时给播放让路。`'queue'` lane 不在这里让路(M6c 集成裁定,语义 product/platforms.md
    // 「手里在做的那一批做完为止」):到这里的队列任务已经认领在手,做完为止;不认领新的由本机节点的闲时门槛管
    // (`queue-idle.mjs`)。M5b 时这里连 `'queue'` 一起抛,认领在手的任务会被当成可重试失败放回去。
    if (lane === 'background' && (this.backgroundYielding || this.backgroundLeaseUntil > Date.now())) throw Object.assign(new Error('Background yielded to playback'), { cancelled: true });
    const previous = this.lanes.get(lane);
    clearTimeout(previous?.timer);
    // Agent 专用实例:空闲计时器在它借去做预渲染时到点只记 `expired`(见 `release`);Agent 又来借,它就不算过期
    if (previous) previous.expired = false;
    if (previous) {
      const empty = { ...project, tracks: [], media: [] };
      const url = this.origin() + '/?export=1&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty)));
      try {
        await previous.bakery.reset(project, url, { deferCards: true });
        await previous.bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: this.scaleForLane(scaleLane) });
        await previous.bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        return previous.bakery;
      } catch { await previous.bakery.close().catch(() => {}); this.lanes.delete(lane); }
    }
    const bakery = await this.bakery(project, scaleLane);
    if (lane === 'background' && (this.backgroundYielding || this.backgroundLeaseUntil > Date.now())) {
      await bakery.close();
      throw Object.assign(new Error('Background yielded to playback'), { cancelled: true });
    }
    this.lanes.set(lane, { bakery });
    return bakery;
  }
  emptyProject(project = {}) {
    return {
      width: Number(project.width) > 0 ? project.width : 1920,
      height: Number(project.height) > 0 ? project.height : 1080,
      fps: Number(project.fps) > 0 ? project.fps : 30,
      duration: 1,
      tracks: [],
      media: [],
    };
  }
  emptyUrl(project = {}) {
    const empty = this.emptyProject(project);
    return this.origin() + '/?export=1&timeline=' + encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(empty)));
  }
  async prewarmUser(project = {}) {
    // D5:`interactive: false` 的实例(R7 之后的编辑器进程)不养热 Chrome;`agent` 模式也不养(不服务用户的交互帧)
    if (!this.interactive || !modeServesPrerender(this.mode)) return;
    if (this.userPrewarm) return this.userPrewarm;
    this.userPrewarm = (async () => {
      while (!this.closed && this.userPool.filter(s => !s.dead).length < this.userPoolSize) {
        try {
          const bakery = await this.bakery(this.emptyProject(project), 'user');
          if (this.closed) { await bakery.close(); return; }
          this.userPool.push({ bakery, busy: false, dead: false });
        } catch (e) {
          // A missing browser should be reported by the first request with the
          // original error.  Do not make server startup fail just because the
          // optional hot pair could not be warmed yet.
          this.userPrewarm = null;
          return;
        }
      }
    })().finally(() => { this.userPrewarm = null; });
    return this.userPrewarm;
  }
  dropUserSession(session) {
    session.dead = true;
    const at = this.userPool.indexOf(session);
    if (at >= 0) this.userPool.splice(at, 1);
    void session.bakery?.close().catch(() => {});
  }
  async acquireUser(project, signal, onSession = () => {}) {
    if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
    await this.prewarmUser(project);
    const waitStart = Date.now();
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
      const session = this.userPool.find(s => !s.dead && !s.busy);
      if (session) {
        session.busy = true;
        onSession(session);
        try {
          await session.bakery.reset(project, this.emptyUrl(project), { deferCards: true });
          await session.bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: 1 });
          await session.bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
          if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
          return session;
        } catch (e) {
          if (e.cancelled) this.releaseUser(session);
          else this.dropUserSession(session);
          throw e;
        }
      }
      // The pair is intentionally bounded.  Waiting here is short in normal
      // use; a watchdog around readFrames will kill a renderer that does not
      // release its slot.
      if (Date.now() - waitStart > USER_RENDER_TIMEOUT_MS) {
        throw Object.assign(new Error(`用户预览等待 Chrome 超过 ${USER_RENDER_TIMEOUT_MS / 1000} 秒，已放弃这次旧请求。`), { status: 504, timedOut: true });
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  releaseUser(session) {
    if (!session || session.dead) return;
    session.busy = false;
    if (this.userPool.length > this.userPoolSize) this.dropUserSession(session);
  }
  /**
   * 还 lane 的 bakery,起空闲计时器。`background` 30 秒没人借就关;`agent` 10 分钟
   * (`docs/plan/cloud-task.md` I1:一个 Chrome、按需拉起、空闲 10 分钟关 —— 以前 `/api/cards/dom`
   * 自己那个 Chrome 闲 90 秒关,并进 agent lane 之后统一由这里管)。下一次 `acquire` 清掉计时器。
   */
  release(lane) {
    const session = this.lanes.get(lane);
    if (!session) return;
    if (lane === 'user') return;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (this.lanes.get(lane) !== session) return;
      // Agent 专用实例此刻借去做一项普通预渲染(`kickAgentIdle`):不在它脚下关,记下过期,做完由那边关
      if (session.unitRunning) { session.expired = true; return; }
      this.lanes.delete(lane);
      void session.bakery.close().catch(() => {});
    }, lane === 'agent' ? AGENT_IDLE_MS : 30000);
    session.timer.unref?.();
  }
  /** Shared public entry point. Independent requests in the same turn merge into one forward pass. */
  async see_frames(project, times, { signal, lane = 'agent', onFrame } = {}) {
    // `inter_face` is the explicit name used by the interactive client. Keep
    // `user` as a backwards-compatible alias; both must use the two hot pages.
    //
    // `preview` / `prerender`(`mechanism/rendering.md`「查询渲染与预渲染进程」):不是 Agent 的请求,不进 Agent lane,
    // 排进普通预渲染队列(`runQueueTask`)。`preview` = 用户在 AI 栏点开的操作预览,插在所有待办之前、不占用
    // Agent 的专用实例;`prerender` = 普通的预渲染(3D 视图的空闲贴图预取),排队尾,Agent 专用实例空闲时可以接。
    lane = lane === 'playback' ? lane : lane === 'inter_face' || lane === 'user' ? 'user' : lane === 'background' ? 'background'
      : lane === 'preview' || lane === 'prerender' ? lane : 'agent';
    // 模式不接这条 lane:当场回错(`user` 模式的 Agent 查询 → NO_AGENT_LANE,`agent` 模式的预渲染 → NO_PRERENDER),不进批处理
    if (this.interactive) {
      const refused = modeRefusal(this.mode, lane);
      if (refused) throw refused;
    }
    const generation = lane === 'user' ? ++this.userGeneration : 0;
    const generationController = lane === 'user' ? new AbortController() : null;
    if (generationController) {
      this.userGenerationController?.abort();
      this.userGenerationController = generationController;
    }
    const renderSignal = generationController
      ? (signal ? AbortSignal.any([signal, generationController.signal]) : generationController.signal)
      : signal;
    const entry = await this.entry(project);
    const fps = project.fps || 30;
    const max = Math.max(0, Math.floor(project.duration * fps) - 1);
    if (!times.length || times.some(t => !Number.isFinite(t))) throw new Error('Frame times must be finite numbers');
    const frames = [...new Set(times.map(t => Math.max(0, Math.min(max, Math.round(t * fps)))))];
    // Playback reservations already bound concurrency and supersede by epoch.
    // They must not cancel one another like interactive pointer requests do.
    if (lane === 'playback') return this.readFrames(entry, frames.sort((a, b) => a - b), lane, signal, onFrame);
    return new Promise((resolve, reject) => {
      if (lane === 'user' && generation !== this.userGeneration) {
        reject(Object.assign(new Error('交互帧请求已过期，已跳过旧请求。'), { status: 499, cancelled: true, superseded: true }));
        return;
      }
      if (lane === 'user') {
        // Remove requests that reached the queue before this pointer event.
        // Agent/background queues are deliberately left untouched.
        const stale = this.queue.filter(r => r.lane === 'user');
        this.queue = this.queue.filter(r => r.lane !== 'user');
        stale.forEach(r => r.reject(Object.assign(new Error('交互帧请求已被更新的请求替代。'), { status: 499, cancelled: true, superseded: true })));
      }
      this.queue.push({ entry, frames, signal: renderSignal, lane, generation, onFrame, resolve, reject });
      if (!this.timer) this.timer = setTimeout(() => {
        this.timer = null;
        const requests = this.queue.splice(0);
        for (const currentLane of ['user', 'agent', 'preview', 'prerender', 'background']) {
          const laneRequests = requests.filter(r => r.lane === currentLane);
          if (!laneRequests.length) continue;
          // User requests are independent: the two hot Chrome slots are
          // deliberately allowed to overlap.  Agent/background lanes remain
          // serialized for deterministic animation state.
          if (currentLane === 'user') {
            const task = this.flush(laneRequests, currentLane);
            this.foreground = task;
            task.catch(() => {});
          } else if (currentLane === 'agent') {
            // #12:agent 批和 layout / entityRects / DOM 查询排同一条队,bakery 由 runAgentTask 借还
            this.runAgentTask(lease => this.flush(laneRequests, currentLane, lease))
              .catch(error => laneRequests.forEach(r => r.reject(error)));
          } else if (currentLane === 'preview' || currentLane === 'prerender') {
            // 1 倍缩放(`scaleLane: 'preview'`),同它们原来在 Agent lane 上渲时一样
            this.runQueueTask(lease => this.flush(laneRequests, currentLane, lease), undefined, { front: currentLane === 'preview', scaleLane: 'preview', kind: currentLane })
              .catch(error => laneRequests.forEach(r => r.reject(error)));
          } else {
            const chain = (this.laneChains.get(currentLane) || Promise.resolve()).catch(() => {}).then(() => this.flush(laneRequests, currentLane));
            this.laneChains.set(currentLane, chain);
          }
        }
      }, 12);
    });
  }
  /** `lease`:agent 批由 `runAgentTask` 传进来的借 bakery 函数;其余 lane 不传,照旧自己 `acquire` */
  async flush(requests, lane = 'agent', lease) {
    const groups = new Map();
    for (const request of requests) {
      if (request.signal?.aborted || (lane === 'user' && request.generation !== this.userGeneration)) {
        request.reject(Object.assign(new Error('交互帧请求已过期，已跳过旧请求。'), { status: 499, cancelled: true, superseded: true }));
        continue;
      }
      const list = groups.get(request.entry.key) || [];
      list.push(request); groups.set(request.entry.key, list);
    }
    for (const group of groups.values()) {
      const entry = group[0].entry;
      const frames = [...new Set(group.flatMap(r => r.frames))].sort((a, b) => a - b);
      try {
        const result = await this.readFrames(entry, frames, lane, group.find(r => !r.signal?.aborted)?.signal, async (frame, value) => {
          for (const request of group) if (!request.signal?.aborted && request.frames.includes(frame)) await request.onFrame?.(frame, value);
        }, lease);
        for (const request of group) {
          if (request.signal?.aborted || (lane === 'user' && request.generation !== this.userGeneration)) request.reject(Object.assign(new Error('交互帧请求已过期，已跳过旧请求。'), { status: 499, cancelled: true, superseded: true }));
          else request.resolve(new Map(request.frames.map(n => [n, result.get(n)])));
        }
      } catch (e) { group.forEach(r => r.reject(e)); }
    }
  }
  async readFrames(entry, frames, lane = 'agent', signal, onFrame, lease) {
    // D5:`interactive: false` 时这两条 lane 立即拒绝,不进 `acquireUser`
    const refused = this.laneRefused(lane);
    if (refused) throw refused;
    if (lane === 'user' || lane === 'playback') {
      const watchdog = new AbortController();
      const combined = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;
      let timer, ownedSession;
      let arm = () => {};
      const work = this.readFramesCore(entry, frames, lane, combined, session => { ownedSession = session; }, async (frame, value) => {
        if (lane === 'playback') arm(); // A healthy stream may run longer than ten seconds.
        await onFrame?.(frame, value);
      });
      let cancel;
      const cancelled = new Promise((_, reject) => {
        cancel = () => {
          if (ownedSession && !ownedSession.dead) this.dropUserSession(ownedSession);
          reject(Object.assign(new Error('Frame request cancelled'), { cancelled: true }));
        };
        if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
      });
      const timeout = new Promise((_, reject) => {
        arm = () => { clearTimeout(timer); timer = setTimeout(() => {
          watchdog.abort();
          // A stalled old request must not kill the other hot Chrome serving
          // the latest pointer position. Ownership begins before reset awaits.
          if (ownedSession && !ownedSession.dead) this.dropUserSession(ownedSession);
          void this.prewarmUser(entry.project).catch(() => {});
          reject(Object.assign(new Error(`用户预览渲染超过 ${USER_RENDER_TIMEOUT_MS / 1000} 秒，已重启 Chrome。`), { status: 504, timedOut: true }));
        }, USER_RENDER_TIMEOUT_MS); };
        arm();
      });
      try { return await Promise.race([work, timeout, cancelled]); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); work.catch(() => {}); }
    }
    return this.readFramesCore(entry, frames, lane, signal, undefined, onFrame, lease);
  }
  /** `lease`:见 `flush`。传了就用它借 bakery、不自己还(`runAgentTask` 统一还) */
  async readFramesCore(entry, frames, lane = 'agent', signal, onSession, onFrame, lease) {
    const result = new Map();
    const htmlFrames = [];
    const missing = [];
    await entry.mov?.ready;
    // MOV is the first lookup: it is already the full scene with media and is
    // the cheapest exact answer. HTML is the high-priority producer for a
    // missing MOV frame, so random access can still avoid loading media.
    for (const frame of frames) {
      if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
      const buf = await entry.mov?.lookup(frame, this.renderSignature(entry, frame, lane));
      if (buf) result.set(frame, { buf, source: 'mov' });
      else {
        // Compatibility with the pre-MOV cumulative PNG cache. It is still a
        // valid full-scene result and lets old projects avoid a re-render.
        // It has no render record, so an empty image there is not trusted.
        try {
          const legacy = await fs.readFile(path.join(entry.dir, 'frames', pad(frame) + '.png'));
          if (isFullyTransparentPng(legacy)) throw new Error('Empty legacy frame');
          result.set(frame, { buf: legacy, source: 'rendered' });
        }
        catch { if (entry.html?.has?.(frame)) htmlFrames.push(frame); else missing.push(frame); }
      }
      if (result.has(frame)) await onFrame?.(frame, result.get(frame));
    }
    if (!htmlFrames.length && !missing.length) return result;
    // While a required card is still being prerendered, the paused stage asks
    // for the same frame every 700 ms. Serve the placeholder already rendered
    // for exactly the cards still missing instead of rendering another one.
    if ((lane === 'user' || lane === 'playback') && entry.placeholders?.size && entry.cardPlan?.length) {
      const waiting = [...htmlFrames, ...missing].filter(frame => entry.placeholders.has(frame));
      const state = waiting.length ? await entry.cardCache.renderState(entry.cardPlan, waiting) : null;
      for (const frame of waiting) {
        const absent = state.missing[frame] || [];
        if (!absent.length || entry.placeholders.get(frame) !== absent.join('\n')) continue;
        const buf = await fs.readFile(path.join(entry.dir, 'preview-frames', pad(frame) + '.png')).catch(() => null);
        if (!buf) continue;
        const value = { buf, source: 'preview', incomplete: true, missing: absent };
        result.set(frame, value);
        await onFrame?.(frame, value);
      }
      for (const list of [htmlFrames, missing]) {
        for (let i = list.length - 1; i >= 0; i--) if (result.has(list[i])) list.splice(i, 1);
      }
      if (!htmlFrames.length && !missing.length) return result;
    }
    const userSession = lane === 'user' || lane === 'playback' ? await this.acquireUser(entry.project, signal, onSession) : null;
    const bakery = userSession?.bakery || await (lease ? lease(entry.project) : this.acquire(lane, entry.project));
    try {
      // The browser owns graph planning because it is the only place that can
      // prove a legacy Chrome card's capabilities.  Cache misses are supplied
      // only to interactive rendering; agent/final lanes keep the real Chrome
      // card so their result can never accidentally become a final placeholder.
      const cardRender = await this.cardRender(entry, bakery, frames, lane);
      const incompleteFor = frame => (lane === 'user' || lane === 'playback') ? (cardRender?.missing?.[frame] || []) : [];
      if (cardRender && (Object.keys(cardRender.frames).length || (lane === 'user' || lane === 'playback') && Object.keys(cardRender.missing).length)) {
        await this.installCardRender(bakery, entry.project, cardRender);
      }
      // The full-scene MOV lane owns the result returned by see_frames. It
      // still records HTML snapshots while it advances, so the next request
      // can replay without loading media. HTML is the higher-priority cache;
      // MOV only fills frames absent from its table.
      const htmlReplay = async frame => {
        if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
        const prefixes = this.prefixes(entry);
        let buf;
        for (let i = 0; i < prefixes.length; i++) buf = await this.rasterPrefix(entry, bakery, frame, i, prefixes);
        if (!incompleteFor(frame).length) await atomic(path.join(entry.dir, 'frames', pad(frame) + '.png'), buf);
        const absent = incompleteFor(frame);
        // A placeholder is a user-preview artifact.  It must never enter the
        // durable full-scene MOV or HTML/final raster cache.
        if (!absent.length) await this.writeMov(entry, frame, buf, this.renderSignature(entry, frame, lane));
        else {
          await atomic(path.join(entry.dir, 'preview-frames', pad(frame) + '.png'), buf);
          (entry.placeholders ||= new Map()).set(frame, absent.join('\n'));
        }
        const value = absent.length ? { buf, source: 'preview', incomplete: true, missing: absent }
          : { buf, source: 'html', ...(entry.mov?.unconfirmedClear(frame) ? { unconfirmedClear: true } : {}) };
        result.set(frame, value);
        await onFrame?.(frame, value);
      };
      for (const frame of htmlFrames) await htmlReplay(frame);
      if (!missing.length) return result;
      const transient = Object.keys(cardRender?.missing || {}).length ? new Map() : null;
      await this.renderMovFrames(entry, missing, bakery, signal, async (frame, value) => {
        const absent = incompleteFor(frame);
        if (absent.length) {
          await atomic(path.join(entry.dir, 'preview-frames', pad(frame) + '.png'), value.buf);
          (entry.placeholders ||= new Map()).set(frame, absent.join('\n'));
        }
        await onFrame?.(frame, absent.length ? { ...value, source: 'preview', incomplete: true, missing: absent } : value);
      }, transient, lane);
      for (const frame of missing) {
        const buf = transient?.get(frame) || await entry.mov.get(frame);
        const absent = incompleteFor(frame);
        if (!buf && !absent.length) throw new Error(`MOV frame ${frame} was not written`);
        if (absent.length) result.set(frame, { buf, source: 'preview', incomplete: true, missing: absent });
        else result.set(frame, { buf, source: 'mov', ...(entry.mov.unconfirmedClear(frame) ? { unconfirmedClear: true } : {}) });
      }
    } finally {
      if (userSession) this.releaseUser(userSession);
      else if (!lease) this.release(lane);
    }
    return result;
  }
  async browserCardPlan(bakery) {
    try {
      return await bakery.page.evaluate(() => typeof window.__pcCardPlan === 'function' ? window.__pcCardPlan() : null);
    } catch { return null; }
  }
  async cardRender(entry, bakery, frames, lane) {
    const browserPlan = await this.browserCardPlan(bakery);
    if (!browserPlan) return null;
    // 契约 F.3:算 card plan 之前锁库要读完(`recordCardPlan` 按锁换键)
    await this.ensureCardLocks();
    let plan;
    try { plan = entry.cardCache.plan(browserPlan); } catch { return null; }
    // Item 4:这里的 entry 可能是 Agent 查询、导出或别的会话的那一版 —— 只把计划记在它自己身上,
    // 不认领、不 reset 任何会话的就绪索引(那只由页面的 preload 做)
    this.recordCardPlan(entry, plan);
    if (!plan.length) return null;
    const state = await entry.cardCache.renderState(plan, frames);
    // The final/agent path deliberately does not inject `missing`: an absent
    // control must fall through to the original Chrome implementation.  The
    // interactive path gets an explicit incomplete signal for its placeholder.
    if (lane !== 'user' && lane !== 'playback') state.missing = {};
    return state;
  }
  async installCardRender(bakery, project, cardRender) {
    const rendered = { ...project, _cardRender: cardRender };
    await bakery.loadProject(rendered, { deferCards: true });
    await bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: 1 });
  }
  async renderMovFrames(entry, frames, bakery, signal, onFrame, transient = null, lane = 'background') {
    // Every write and every "already rendered" decision is checked against
    // what would produce the frame now (see renderSignature). An empty image
    // stays "waiting to render" until a second render agrees with it.
    const signature = frame => this.renderSignature(entry, frame, lane);
    const flag = frame => !transient && entry.mov.unconfirmedClear(frame) ? { unconfirmedClear: true } : {};
    // Frames the other process (editor server / prerender worker) already rendered count.
    await entry.mov.hydrate(frames);
    // Reuse HTML-complete frames first. This is the background equivalent of
    // see_frames' HTML lookup and avoids loading media for frames already
    // frozen by the higher-priority lane.
    const htmlFrames = frames.filter(frame => !entry.mov.valid(frame, signature(frame)) && entry.html.has(frame));
    for (const frame of htmlFrames) {
      if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
      const prefixes = this.prefixes(entry);
      let buf;
      for (let i = 0; i < prefixes.length; i++) buf = await this.rasterPrefix(entry, bakery, frame, i, prefixes);
      if (!transient) await atomic(path.join(entry.dir, 'frames', pad(frame) + '.png'), buf);
      if (transient) transient.set(frame, buf); else await this.writeMov(entry, frame, buf, signature(frame));
      await onFrame?.(frame, { buf, source: 'html', ...flag(frame) });
    }
    const missing = frames.filter(frame => !entry.mov.valid(frame, signature(frame)));
    if (!missing.length) return;
    const requested = new Set(missing);
    await bakeFrames(bakery, {
      out: entry.dir, targetFrames: missing, snapshotOnly: false, fullFrame: true,
      snapshotFrames: new Set(missing),
      writeFrames: false, signal,
      onFrame: async (frame, buf) => {
        if (requested.has(frame)) {
          if (transient) transient.set(frame, buf); else await this.writeMov(entry, frame, buf, signature(frame));
          await onFrame?.(frame, { buf, source: 'live', ...flag(frame) });
        }
      },
      // MOV passes still record HTML for the same live state, but only when the
      // HTML lane did not already have that frame.
      onSnapshot: (n, html, controls) => !transient && !entry.html.has(n) && requested.has(n) && this.record(entry, n, html, controls),
    });
    if (!transient) await this.save(entry);
  }
  async writeMov(entry, frame, buf, signature = null) {
    if (!entry.mov) return;
    // 整场景这一份只存逐帧 PNG(随机取用的那一侧)。以前这里顺手起 ffmpeg 把连续前缀编成
    // `mov/full.mov`,那个文件只被判过存在、没有人读内容,已不再产(legacy 整帧通道方案 B)。
    await entry.mov.put(frame, buf, signature);
  }
  /** `options.anchors`:锚帧那一趟(`fillAnchorSnapshots`)记的帧。只在队列模式下有区别,见 `recordSnapshots` */
  record(entry, n, html, controls = [], options = undefined) {
    entry.recordVersion = (entry.recordVersion || 0) + 1;
    entry.html.set(n, html);
    for (const control of controls) {
      if (!entry.controls.has(control.id)) entry.controls.set(control.id, entry.createControl?.(control.id) || new Map());
      entry.controls.get(control.id).set(control.frame, control.html);
    }
  }
  /**
   * 队列模式(契约 J.5)下由队列细任务产快照的那些卡:共享档里可缓存的(隔离单卡渲)与本地档(整场景渲)。
   * 共享档里不可缓存的(`sourceDependent`)不进队列,照旧只由整场景路或 B 趟产(附件第 2 节)。
   * `planForQueue` 与 `recordSnapshots` 的队列闸用同一个判据。
   */
  queueHandles(control) {
    if (!control?.snapshotKey || !control.clipId) return false;
    const caps = control?.capabilities ?? {};
    const tier = control.tier || snapshotTier(caps);
    if (tier === 'local' || (tier === 'shared' && control.cacheable === true)) return true;
    if (tier === 'none') {
      const stateful = control.frameMode === 'stateful' || caps.frameMode === 'stateful' || control.needPrerendering === true || caps.need_prerendering === true || caps.needPrerendering === true;
      const compositing = control.compositing ?? caps.compositing ?? 'unknown';
      return stateful && (compositing !== 'sourceDependent' || control.cacheable === true);
    }
    return false;
  }
  /** 这个 entry 的 card plan 里 `queueHandles` 为真的 clipId(按 plan 对象缓存) */
  queueHandledClips(entry) {
    const plan = entry?.cardPlan;
    if (!Array.isArray(plan)) return new Set();
    if (entry.queueHandledPlan !== plan) {
      entry.queueHandledPlan = plan;
      entry.queueHandledSet = new Set(plan.filter(control => this.queueHandles(control)).map(control => control.clipId));
    }
    return entry.queueHandledSet;
  }
  /**
   * pinned 渲染 9:**只预渲染预渲染集合 `plan.prerenderSet`(任一位置判重的卡的并集)
   * 里的卡** —— 在所有位置都判轻的卡不产快照、不进就绪索引。
   *
   * 集合由 `adoptCardPlan` 用两端同一份 `planPipelines` 按实测 `costs` 算;一条成本
   * 记录都没有时 `prerenderSetOfPlan` 自己按声明兜底(`declaredHeavy`)。集合压根没
   * 算过(没走过 `adoptCardPlan`,比如手工构造 entry 的调用方)时不过滤。
   */
  prerenderPicked(entry, clipId) {
    const set = entry?.prerenderSet;
    if (!(set instanceof Set)) return true;
    return set.has(clipId);
  }
  /**
   * 轨道流只给**本机判重**的卡(`basePrerenderSet`,不含预渲染重试进来的片段):预渲染重试计划(旧页面的 `backfill` 档;2026-10-07 起在线页面一律发普通优先级的清单计划,这一档没有新的发布方,留着只为认部署切换期间的老页面)不切流,
   * 为它进集合的轻卡产流只是白做。没有基础集合时退回 `prerenderPicked`。
   */
  streamPicked(entry, clipId) {
    const base = entry?.basePrerenderSet;
    if (!(base instanceof Set)) return this.prerenderPicked(entry, clipId);
    return base.has(clipId);
  }
  /**
   * 预渲染重试(c10a 契约第 17 节)(旧页面的 `backfill` 档;2026-10-07 起在线页面一律发普通优先级的清单计划,这一档没有新的发布方,留着只为认部署切换期间的老页面):判重、素材服务里又没有产物的片段,
   * 页面发布带片段清单的预渲染重试计划任务;认领它的节点在这里把清单里的片段记成「这张卡的这一份内容要产」,
   * 于是它们进这一版的预渲染集合(`prerenderPicked` 为真:细任务渲得出来、层表里列着它们,在线页面据此取小尺寸)。
   *
   * 按「项目 id → 片段 + 内容身份」记,不按 entry:同一版项目在本机可能有不止一个 entry(页面推来的、从文档服务取的),
   * 谁写层表都要带上预渲染重试的片段,不然两边轮流写,页面上它们时有时无。内容身份换了(这张卡改了参数)就不再算 ——
   * 新内容没有产物,页面会再发一次预渲染重试。只记在内存里,和队列一样随进程作废。
   * 回新记下了几个片段。
   */
  addBackfill(entry, clipIds) {
    const projectId = entry?.project?.id;
    if (!projectId || !Array.isArray(entry.cardPlan)) return 0;
    const want = new Set((clipIds ?? []).filter(id => typeof id === 'string' && id));
    if (!want.size) return 0;
    this._backfill ??= new Map();
    let keys = this._backfill.get(projectId);
    if (!keys) this._backfill.set(projectId, (keys = new Set()));
    let added = 0;
    for (const control of entry.cardPlan) {
      if (!want.has(control?.clipId)) continue;
      const id = backfillIdentity(entry, control);
      if (id && !keys.has(id)) { keys.add(id); added++; }
    }
    if (!added) return 0;
    for (const other of this.entries?.values?.() ?? []) {
      if (other?.project?.id === projectId && Array.isArray(other.cardPlan)) this.applyBackfill(other);
    }
    this.publishLayerMap(entry);
    return added;
  }
  /** 按预渲染重试登记把片段并进这个 entry 的预渲染集合(`basePrerenderSet` ∪ 登记过、内容身份对得上的片段) */
  applyBackfill(entry) {
    const base = entry?.basePrerenderSet;
    if (!(base instanceof Set)) return;
    const keys = this._backfill?.get(entry.project?.id);
    const extra = [];
    if (keys?.size) {
      for (const control of entry.cardPlan ?? []) {
        if (!control?.clipId || base.has(control.clipId)) continue;
        const id = backfillIdentity(entry, control);
        if (id && keys.has(id)) extra.push(control.clipId);
      }
    }
    const next = extra.length ? new Set([...base, ...extra].sort()) : base;
    const cur = entry.prerenderSet;
    if (cur instanceof Set && cur.size === next.size && [...next].every(id => cur.has(id))) return;
    entry.prerenderSet = next;
  }
  /** clipId → { tier, key }:整场景路冻出来的 control 子树该落到哪个档、哪个键。
   * 只有 `card-cache.mjs` 的 `plan` 手里有共享键(`cardSnapshotIdentity` 算的),
   * 所以这里认 `entry.cardPlan`(`preload` 里存下来的那份);拿不到就不写快照库。
   * 不在预渲染集合里的卡一律不给 target —— 整场景路(`recordSnapshots` /
   * `renderLocalSnapshots`)因此对它什么都不产(pinned 渲染 9)。 */
  snapshotTargets(entry) {
    const plan = entry.cardPlan;
    if (!plan?.length) return null;
    if (entry.snapshotPlan !== plan || entry.snapshotTargetSet !== entry.prerenderSet || entry.snapshotLockEpoch !== this.cardLockEpoch) {
      entry.snapshotPlan = plan;
      entry.snapshotTargetSet = entry.prerenderSet;
      entry.snapshotLockEpoch = this.cardLockEpoch;
      entry.snapshotTargetMap = new Map(plan
        // 契约 F.3「不替锁定方产帧」:被别的环境锁定的卡不给 target,整场景路(含锚帧那一趟)不写它
        .filter(control => control.clipId && control.snapshotKey && control.cardLock?.foreign !== true && this.prerenderPicked(entry, control.clipId))
        .map(control => [control.clipId, { tier: control.tier || snapshotTier(control.capabilities), key: control.snapshotKey, capabilities: control.capabilities,
          // 写帧前得锁用:共享档的锁键和本机自己的指纹
          contentKey: control.contentKey, envFingerprint: control.ownEnvFingerprint ?? control.envFingerprint }])
        .filter(([, target]) => target.tier === 'shared' || target.tier === 'local'));
    }
    return entry.snapshotTargetMap;
  }
  /**
   * 本机为一个共享档 target 写帧前得锁(契约 F.3「渲之前得锁」)。没有锁库、不是共享档、没有内容键或
   * 指纹的一律当得到(不参与锁)。得不到(页面刚抢先锁了这张卡)就把 entry 的 card plan 按锁库重排,
   * 回 false —— 调用方这张卡本趟不再写 HTML 快照。
   */
  acquireCardLock(entry, target, controls = null) {
    const store = this.cardLockStore;
    if (!store || target?.tier !== 'shared' || !target.contentKey || !target.envFingerprint) return true;
    let granted = true;
    try { granted = store.acquire(target.contentKey, target.envFingerprint, 'prerender').granted; } catch { return true; }
    // 得不到:按锁库重排。刚建了锁:把 `cardLock` 记到 control 上(诊断看得见),键不变
    const unmarked = list => Array.isArray(list) && list.some(control => control?.contentKey === target.contentKey && !control.cardLock);
    if (!granted || unmarked(entry?.cardPlan) || unmarked(controls)) this.reapplyCardLocks(entry, controls);
    return granted;
  }
  /**
   * 整场景路(C2)冻出来的 control HTML 同时写进 A3a 的快照库
   * (`<root>/controls-html/<共享键>/` 与 `<root>/controls-local/<entry.key>/<共享键>/`)。
   *
   * 老的 `entry.controls` → `html-manifest.json` **一并保留**:今天的回放和导出
   * 还从那份 manifest 读(`renderState` / `unpackFrameCache`),现在抽掉会直接缺料。
   * 两处并存期间快照库是「去向」、manifest 是「现状」,第 4 步之后才换读侧。
   *
   * `belowDependent`(毛玻璃)只能由这条整场景路产:它的结果受下层影响,隔离工程
   * 里画不出来。它的本地档键这一版按 A3a 先用整项目的 `entry.key` 兜底
   * (更粗:项目里任何改动都会换 `entry.key`、整棵本地档作废),`localSceneKey`
   * 和「下层活跃控件的共享键 + 位置」是后面的事。
   */
  recordSnapshots(entry, controls, options = undefined) {
    let targets = this.snapshotTargets(entry);
    if (!targets?.size || !controls?.length) return;
    /*
     * 队列模式(契约 J.5:「不再跑原来后台那一趟的快照部分;锚帧、流、整场景照旧由 preload 产」):
     * 由队列细任务产的卡(`queueHandles`),整场景路(B 趟、MOV 那一趟、Agent 查询顺带记的帧)只记整帧 HTML,
     * 不再顺手写它们的快照;锚帧那一趟照写。`entry.queueSnapshots` 只有队列模式的 preload 会设,
     * 没设(开关关着、以及所有现有调用方)时这里什么都不跳。
     */
    const handled = entry.queueSnapshots === true && options?.anchors !== true ? this.queueHandledClips(entry) : null;
    for (const control of controls) {
      if (handled?.has(control.id)) continue;
      const target = targets.get(control.id);
      if (!target || !Number.isInteger(control.frame)) continue;
      // 契约 F.3「渲之前得锁」:共享档每帧入批之前得锁;得不到(页面刚锁了这张卡)这帧不写,
      // card plan 已按锁库重排,重取 target 之后这张卡不再有 target
      if (this.acquireCardLock && !this.acquireCardLock(entry, target)) {
        targets = this.snapshotTargets(entry) ?? new Map();
        continue;
      }
      const entryKey = target.tier === 'local' ? entry.key : undefined;
      const batches = (entry.snapshotPending ||= new Map());
      const id = `${target.tier}\u0000${entryKey ?? ''}\u0000${target.key}`;
      // #9:写帧、判体积、并 index 由快照库的 `batch` 一起做(攒满 4 帧交一次)。A3c 的通用兜底
      // 照旧:超限的那一帧**照常落盘**,但不进就绪索引、不投递 —— 那一层按缺料处理(贴更早的
      // 合格快照,没有就透明),并记一条诊断;R6-14:帧号记进 index.json 的 `oversize`,下一趟跳过。
      if (!batches.has(id)) batches.set(id, this.snapshots().batch({ tier: target.tier, entryKey, key: target.key, clipId: control.id, capabilities: target.capabilities }));
      const batch = batches.get(id);
      const html = control.html;
      entry.snapshotChain = (entry.snapshotChain || Promise.resolve()).then(async () => {
        // 快照库是旁路:写失败不能把整条预渲染管线带下去(老 manifest 仍然写成了)。
        try { await batch.add(control.frame, html); } catch {}
      });
    }
  }
  /** 等这一批帧交完(写文件 + 并 index,由快照库的 `batch` 一起做),再按 C3 把这一层此刻的
   * 全部就绪区间发出去(全量语义)。全是超限帧的批也照样写了 index(R6-14),只是不发 `layer`。 */
  async flushSnapshots(entry) {
    try { await entry.snapshotChain; } catch {}
    const batches = entry.snapshotPending;
    if (!batches?.size) return;
    entry.snapshotPending = new Map();
    for (const batch of batches.values()) {
      try {
        const index = await batch.close();
        /*
         * 疑点 F(`server/test/ready-stale-flush.test.mjs`):页面已经换到下一版之后,旧 entry 这一批才交完。
         * 批照常落盘(快照库是内容寻址的,别的版本还用得上);发不发布由 `publishLayer` 的闸门定 ——
         * 只进当前版本正是这个 entry 的会话。
         */
        // 契约 F.3:这张卡此刻锁在别的环境上(层已经换成锁定方的键),本机这一批不再发层,免得把层换回来
        const lockedAway = batch.tier === 'shared' && (entry.cardPlan ?? []).some(control =>
          control?.clipId === batch.clipId && control.cardLock?.foreign === true && control.snapshotKey !== batch.key);
        if (index && batch.written && !lockedAway) this.publishLayer(entry, { clipId: batch.clipId, snapshotKey: batch.key }, batch.tier, index.frames);
      } catch {}
    }
  }
  async save(entry) {
    const work = (entry.saveChain || Promise.resolve()).catch(() => {}).then(() => this.saveNow(entry)).then(() => this.flushSnapshots(entry));
    entry.saveChain = work;
    return work;
  }
  async saveNow(entry) {
    const version = entry.recordVersion;
    if (entry.savedVersion !== undefined && entry.savedVersion === version) return;
    const encoded = packFrameCache(entry.dir, entry.key, entry.html, entry.controls, {
      fps: entry.project.fps || 30,
    });
    await atomic(path.join(entry.dir, 'html-manifest.json'), encoded);
    entry.savedVersion = version;
    if (entry.recordVersion !== version) return;
    // Re-open our own archive so the hot pipeline keeps compressed blocks and
    // only a small expanded window, rather than every full HTML string.
    const archive = unpackFrameCache(encoded, entry.key, { dir: entry.dir, spillDir: path.join(entry.dir, 'html-cache') });
    // Concurrent playback batches may record new frames during the disk write.
    // Do not replace their live map with the older archive snapshot.
    if (entry.recordVersion === version) {
      const dispose = entry.disposeArchive;
      entry.html = archive.frames;
      entry.controls = archive.controls;
      entry.createControl = archive.createControl;
      entry.disposeArchive = archive.dispose;
      dispose?.();
    }
  }
  /** Abort the background generations of owners that stopped asking (PRELOAD_STALE_MS).
   * Background passes run one after another, so a generation nobody waits
   * for would otherwise hold every later project behind its whole pipeline. */
  retireStalePreloads(owner, now = Date.now()) {
    for (const [other, generation] of this.generations) {
      if (other === owner || now - generation.seenAt <= PRELOAD_STALE_MS) continue;
      // 已经跑完的代次没有活可掐:留着,不然它的 owner 下一次保活 preload 会把整趟后台重跑一遍
      // (两个标签页互相掐、各自 30 秒重跑一次,Item 4 审查 #1)。新会话第一次来仍会重跑一趟(大多命中缓存),
      // 之后就走「同一个 entry 直接返回」。很久没人问的才删,免得常驻
      if (this.entries.get(generation.key)?.status === 'ready' && now - generation.seenAt <= READY_SESSION_IDLE_MS) continue;
      generation.controller.abort();
      this.generations.delete(other);
    }
  }
  /**
   * 页面这一版的后台预渲染。**会话「当前版本」的唯一来源**(Item 4 业务决断 2):
   * `session` 是页面镜像的会话(HTTP 的 `/preload` 从 body 里带来;脚本不带就是缺省会话),
   * `localRev` 是页面的版本号。`adopt: false`(让路之后重新排上的那些)只排活、不动任何会话的版本。
   *
   * `queue`(契约 J.5):`true` = 队列模式的 `/preload` 路由传,
   * `false` = 退回本机自己产(连不上文档服务时);不传(缺省,所有现有调用方)就不动 entry 上记着的模式。
   * 己二：撤掉每张卡的 HTML 快照后，锚帧直接标记就绪、流照常更新，整场景与旧整帧通道写 PNG/MOV 照旧。
   *
   * @param {any} project
   * @param {{ session?: string, localRev?: unknown, adopt?: boolean, owner?: string, ticket?: number, queue?: boolean }} [options]
   */
  async preload(project, { session = DEFAULT_READY_SESSION, localRev, adopt = true, owner: as = undefined, ticket: issued = undefined, queue = undefined } = {}) {
    // `agent` 模式不预渲染(cloud-task.md I1):什么都不排,回 `{ skipped: 'agent' }`,路由照回给调用方
    if (this.interactive && !modeServesPrerender(this.mode)) return { skipped: this.mode };
    session = typeof session === 'string' ? session : DEFAULT_READY_SESSION;
    // `ticket`:HTTP 入口在等镜像之前就替它领了号(按到达顺序,不按算完的顺序,审查 #6)
    const ticket = adopt ? (issued ?? this.ready.request(session)) : undefined;
    const entry = await this.entry(project);
    // 存储占用:打开的这一版用到的键记为使用(计划还没算出来时先记整场景与本地档,算出来后 `recordCardPlan` 再记全)
    this.usage?.touchEntry(entry);
    if (queue !== undefined) entry.queueSnapshots = queue === true;
    if (adopt) {
      // 算 entry 的那一段里同一会话又来了更新的 preload:这个请求作废 —— 不认领,也不排后台活
      // (排了会把更新那一版刚开的后台代次掐掉)
      if (this.ready.stale(session, ticket, localRev)) return entry;
      // 同一内容键可被新会话复用；旧会话的整帧 MOV / 视频仍可能占着后台队列。
      // card plan 已在手时先按最新 costs 重算集合并撤掉判轻卡的旧层，
      // 不让新会话的管线判定等整段视频结束后才生效。后台仍会按这份集合补缺帧。
      if (entry.cardPlan?.length) this.adoptCardPlan(entry, entry.cardPlan);
      this.adoptSession(session, entry, localRev, ticket);
      // c10a 第 9 节:换回一个计划已算好的版本(撤销、来回切)时,层表也换回这一版
      if (entry.cardPlan?.length) this.publishLayerMap(entry);
    }
    // 后台代次按会话分(两个标签页各自一代,不互相掐);缺省会话照旧按项目 id
    const owner = as ?? (session !== DEFAULT_READY_SESSION ? `session:${session}` : (project.id || 'active'));
    const now = Date.now();
    this.retireStalePreloads(owner, now);
    const previous = this.generations.get(owner);
    if (previous?.key === entry.key && !previous.controller.signal.aborted && !['error', 'cancelled', 'partial'].includes(entry.status)) {
      previous.seenAt = now;
      return entry;
    }
    previous?.controller.abort();
    const controller = new AbortController();
    this.generations.set(owner, { key: entry.key, controller, seenAt: now });
    entry.status = 'queued';
    this.background = this.background.catch(() => {}).then(async () => {
      if (controller.signal.aborted) return;
      let bakery;
      // 契约 F.8 第 2 条:这一趟里被延后、末尾再判仍新鲜的卡,一趟结束时定时重判
      const deferredCards = [];
      try {
        entry.status = 'html';
        const count = Math.max(1, Math.floor(project.duration * (project.fps || 30)));
        bakery = await this.acquire('background', entry.project);
        const browserPlan = await this.browserCardPlan(bakery);
        await this.ensureCardLocks();
        let cardPlan = [];
        try { cardPlan = browserPlan ? entry.cardCache.plan(browserPlan) : []; } catch {}
        if (browserPlan) this.adoptCardPlan(entry, cardPlan);
        // c10a 第 9 节:这一版的层表写进内容库,在线页面据此按清单拉预渲染小尺寸
        if (browserPlan && !controller.signal.aborted) this.publishLayerMap(entry);
        // C6.4 第 5 节:配了推送队列(连得上素材服务和文档服务)时,先按这一版的 card plan 查内容库里的清单、
        // 拉别的机器已经产好的段,再开始后台那一趟 —— 拉到的段本机不再渲。没配时这里什么都不做
        if (browserPlan && this.pushQueue && !controller.signal.aborted) {
          try { await this.adoptFromManifests(entry, this.pushQueue.content, this.pushQueue.client, { signal: controller.signal }); } catch {}
          // 任务书「甲二」:别的环境(在线页面自己产的)已经有整条的单卡流,拉回来、照它的键用,本机不重产
          try { await this.adoptForeignStreams(entry, this.pushQueue.content, this.pushQueue.client, { signal: controller.signal }); } catch {}
        }
        entry.stage = 'required';
        if (!controller.signal.aborted) {
          entry.anchorsReady = true;
          this.ready.markDone(entry.key);
        }
        // R8 / G4:启动轨道流生产。它有自己的会话(`streamPool`),不占这条 lane,
        // 也不等它 —— 这里只是把这一版的流交给生产者
        if (!controller.signal.aborted) void this.streamProducer()?.update(entry).catch(() => {});
        // 己二：保留 fillCardControls 中给旧整帧通道写 controls/<key> PNG/MOV 的那一支
        deferredCards.push(...(await this.fillCardControls(entry, bakery, controller.signal, cardPlan.filter(c => c.cacheable && c.needPrerendering), { share: true })) ?? []);
        // 己二：撤掉本地档快照趟 renderLocalSnapshots
        await this.fillRequiredScene(entry, bakery, controller.signal, cardPlan);
        if (this.playback?.playing) { entry.status = 'partial'; return; }
        entry.stage = 'direct';
        deferredCards.push(...(await this.fillCardControls(entry, bakery, controller.signal, cardPlan.filter(c => c.cacheable && !c.needPrerendering), { share: true })) ?? []);
        // `size === count` is not enough for a sparse archive: a foreground
        // request can contain exactly `count` entries while still missing one
        // frame and containing an out-of-range index.  C must only start after
        // B has every frame in the canonical 0..count-1 range.
        const complete = entry.html.size === count && [...Array(count).keys()].every(n => entry.html.has(n));
        if (!complete) {
          const blockFrames = Math.max(1, Math.min(16, Math.round(project.fps || 30)));
          await bakeFrames(bakery, { out: entry.dir, frames: `0-${count - 1}`, snapshotOnly: true,
            signal: controller.signal, onSnapshot: async (n, html, controls) => {
              this.record(entry, n, html, controls);
              // Publish small increments: a 60-second batch of frozen 1080p
              // HTML can take seconds to compress even when spills bound RAM.
              if ((n + 1) % blockFrames === 0) await this.save(entry);
            } });
          await this.save(entry);
        }
        entry.status = 'mov';
        // MOV must contain the full scene, including media. Its pass shares
        // the already warm background Chrome but deliberately uses the live
        // full-frame capture path; HTML snapshots have media removed.
        await this.fillMov(entry, controller.signal, bakery);
        entry.status = 'video';
        await this.prerender(entry, bakery, controller.signal);
        entry.status = 'ready';
        entry.stage = 'ready';
      } catch (e) {
        entry.status = controller.signal.aborted ? 'cancelled' : 'error';
        entry.error = controller.signal.aborted ? null : String(e.message || e);
        // A cancelled MOV pass leaves its stream open; closing the pipeline
        // later would publish that prefix as the whole movie. Drop the stream;
        // the next pass replays the PNGs.
        if (controller.signal.aborted) await entry.mov?.suspend().catch(() => {});
      } finally {
        if (entry.stage !== 'ready') entry.stage = undefined;
        if (bakery && this.lanes.get('background')?.bakery === bakery) this.release('background');
        if (deferredCards.length && !controller.signal.aborted) this.scheduleCardLockRetry(entry, deferredCards, controller.signal);
        // 存储占用:这一趟做完再记一次(轨道流此时才有),到节拍了就判一次要不要淘汰
        this.usage?.touchEntry(entry);
        this.usage?.afterBatch();
      }
    });
    return entry;
  }
  /**
   * 整场景逐帧 PNG 补齐(含素材的整帧,`readFramesCore` 第一步查的就是它)。以前以 `mov/full.mov` 在不在
   * 判「做过了」、并把 PNG 编成那个文件;方案 B 起不再编,`renderMovFrames` 自己跳过表里已有且有效的帧,
   * 所以第二趟只读一遍各帧的产出记录,不重渲。
   */
  async fillMov(entry, signal, bakery) {
    if (!entry.mov) return;
    const fps = entry.project.fps || 30;
    const count = Math.max(1, Math.floor(entry.project.duration * fps));
    if (signal?.aborted) throw new Error('Cancelled');
    await this.renderMovFrames(entry, Array.from({ length: count }, (_, i) => i), bakery, signal);
    await entry.mov.finish();
  }
  async fillRequiredScene(entry, bakery, signal, controls) {
    const fps = Number(entry.project.fps) || 30, wanted = new Set();
    for (const control of controls) if (control.needPrerendering && !control.cacheable) {
      for (let frame = control.sampling.firstFrame; frame / fps < control.end - 1e-9; frame++) wanted.add(frame);
    }
    if (wanted.size) await this.renderMovFrames(entry, [...wanted].sort((a, b) => a - b), bakery, signal);
  }
  /** A3a 的 HTML 快照库(<root>/controls-html、<root>/controls-local)。
   * 和 `entry.cardCache`(PNG/MOV,legacy 整帧通道和导出用)并存 —— 后者随
   * legacy 通道一起删,在那之前照常写,不然导出和旧播放路会缺料。 */
  snapshots() {
    if (this._snapshots) return this._snapshots;
    const store = new SnapshotStore(this.root);
    /*
     * C6.4 第 4 节的快照钩子:`commitSnapshots`(`batch` 也经它)每写完一批,把这一批覆盖到的每一段进推送队列。
     * 没配推送队列、也没开小尺寸时原样返回 `commitSnapshots` 自己的 promise —— 不多一个 tick、不多写任何东西。
     */
    const commit = store.commitSnapshots.bind(store);
    store.commitSnapshots = args => {
      const done = commit(args);
      // 独立渲染主机:没有推送队列,但打开了小尺寸(`enableSmallTier`),照样记下这一批的小尺寸
      if (!this.pushQueue && !this.smallTierEnabled()) return done;
      return done.then(index => {
        if (this.pushQueue) { try { this.enqueueSnapshotPush(args); } catch {} }
        // c10a 第 9 节:同一批帧的预渲染小尺寸(只在推送队列配着、本进程已有开着的预渲染 Chrome 时;不挡这一批)
        try { this.scheduleSmallSnapshots(args); } catch {}
        return index;
      });
    };
    return this._snapshots = store;
  }
  /**
   * 共享键 / 本地档目录键 → card plan 里对应的 control(推送钩子要它的 `count`、`contentKey`、能力)。
   * 本地档只在那个 entry 的计划里找;共享档在所有活着的 entry 里找(键是内容寻址的,哪个 entry 的都一样)。
   */
  controlForSnapshotKey(tier, entryKey, key) {
    const match = control => control && (control.snapshotKey === key) && (control.tier || snapshotTier(control.capabilities)) === tier;
    if (tier === 'local') return (this.entries.get(entryKey)?.cardPlan ?? []).find(match) ?? null;
    for (const entry of this.entries.values()) {
      const hit = (entry.cardPlan ?? []).find(match);
      if (hit) return hit;
    }
    return null;
  }
  /**
   * 卡级推送优先级(A5):`canvasHeavy`、素材效果卡、`unknown`、`belowDependent`(以及同属下层依赖的 `context`),或本地档 → 1 `low`;
   * 其余共享档 → 0 `normal`。块级(`data:image` 过半、超体积帧)由推送队列轮到这一段时自己算,取低的那个。
   */
  cardPushPriority(control, tier, capabilities) {
    if (tier === 'local') return PUSH_LOW;
    const caps = capabilities ?? control?.capabilities ?? {};
    if (caps.canvasHeavy === true || control?.capabilities?.canvasHeavy === true) return PUSH_LOW;
    const compositing = caps.compositing ?? control?.compositing ?? control?.capabilities?.compositing;
    // 共享档按定义只有 independent / sourceDependent;这里只认明写的下层依赖值,没写不算(不猜)
    if (compositing === 'unknown' || compositing === 'belowDependent' || compositing === 'context') return PUSH_LOW;
    if (this.isGraphCardControl(control)) return PUSH_LOW;
    return PUSH_NORMAL;
  }
  /**
   * 这张卡是不是素材效果卡(H)。服务端的 card plan 里目前没有能判它的字段(`split.mjs` 的 `isGraphCard` 也由调用方注入、
   * 缺省 false),所以缺省回 false;只认 control 上明写的 `graphCard: true`。报告里记为疑点。
   */
  isGraphCardControl(control) {
    return control?.graphCard === true || control?.capabilities?.graphCard === true;
  }
  /**
   * 快照钩子的本体:`commitSnapshots` 的这一批帧落在哪几段,每段进推送队列一次(队列自己去重)。
   * 段与 `split.mjs` 同一种切法:本地帧 0 起每 `PUSH_SNAPSHOT_SPAN` 帧一段,最后一段到 `count - 1`
   * (card plan 里查不到这张卡时不知道 `count`,就按整段长算)。
   *
   *   共享档:`resultKey = 共享键`(目录键);
   *   本地档:`resultKey = resultKeyOf("<entryKey>/<contentKey>", 指纹)`,`dirKey` 是落盘目录键(E.9)。
   *           本地档要从 card plan 找到这张卡才算得出结果键,找不到就不进队。
   *
   * 从素材服务拉来的帧(`applyResult` 带 `adopted: true`)不进队:它们本来就在素材服务上。
   */
  enqueueSnapshotPush(args) {
    const queue = this.pushQueue;
    if (!queue || !args || args.adopted === true) return 0;
    const { tier, key } = args;
    if ((tier !== 'shared' && tier !== 'local') || !key) return 0;
    const frames = (args.items ?? []).map(item => item?.localFrame).filter(frame => Number.isInteger(frame) && frame >= 0);
    if (!frames.length) return 0;
    const entryKey = tier === 'local' ? args.entryKey : null;
    if (tier === 'local' && !entryKey) return 0;
    const control = this.controlForSnapshotKey(tier, entryKey, key);
    let resultKey = key;
    if (tier === 'local') {
      const fp = control?.envFingerprint ?? this.envFingerprint;
      if (!control || !fp) return 0;
      resultKey = resultKeyOf(`${entryKey}/${control.contentKey ?? control.snapshotKey}`, fp);
    }
    const span = PUSH_SNAPSHOT_SPAN;
    const count = Number.isInteger(control?.count) && control.count > 0 ? control.count : null;
    const priority = this.cardPushPriority(control, tier, args.capabilities);
    const canvasHeavy = args.capabilities?.canvasHeavy === true || control?.capabilities?.canvasHeavy === true;
    let queued = 0;
    for (const from of new Set(frames.map(frame => frame - (frame % span)))) {
      const to = count !== null && from < count ? Math.min(count - 1, from + span - 1) : from + span - 1;
      // 契约第 9 节第 1 条:进队同步生效,回的 promise 是落盘;钩子不等它
      void Promise.resolve(queue.enqueue({ kind: 'snapshot', tier, resultKey, dirKey: key, entryKey, range: { from, to }, canvasHeavy }, priority)).catch(() => {});
      queued++;
    }
    return queued;
  }
  /**
   * 流钩子的本体(`StreamProducer.storeSegment` 每写完一个分段调):把它所在的段进推送队列,流一律按 1 `low`。
   * 段从这条流的 `firstSegment` 起每 `PUSH_STREAM_SEGMENTS` 个分段一段,最后一段到 `lastSegment`(同 `split.mjs`)。
   */
  /*
   * ---------------------------------------------------------------- 预渲染小尺寸(c10a 第 9 节)
   *
   * 渲染节点产出一批 HTML 快照(`commitSnapshots` 写完)之后,在**同一个预渲染间**上(它换页之前、旧页空着的时候,`flushSmallOn`)
   * 把这一批的每一帧截成一张 WebP 小位图(`bakery/small-bitmap.mjs`:片段框里的内容,按项目画幅缩进 800×600),
   * 写在快照同目录的 `<localFrame>.small.webp`(`index.json` 与 `<localFrame>.html` 一字不动)。写完把这一批所在的段
   * 再进一次推送队列 —— 小位图随同一段推到素材服务(`px`),清单里带 `small` 表(`artifact-transfer.mjs`)。
   *
   * 己二（2026-10-13 契约）：预渲染小尺寸已停产，两档改成一档，smallTierEnabled 恒为 false。
   */
  smallTierEnabled() {
    return false;
  }
  /**
   * 独立渲染主机(`vite-plugin-frames.ts` 的 `startHostNode`)没有推送队列,产物由各项目节点的 sink 推 —— 它也是渲染节点,
   * 照 `product/rendering.md`「两档」与 c10a 第 9 节(「由渲染节点(桌面版的队列节点、独立渲染主机)一并生成」)同样要产小尺寸:
   * 起节点前调这里打开。打开之后 `commitSnapshots` 照样记下每一批的小尺寸、换页时画掉,sink 的完成条件照样要两档
   * (`docs/archive/agent-reports/AGENT-xnode-dedup.md`:主机只推原尺寸时,别的节点领到它做完的段只能补画小尺寸,不能去重)。
   */
  enableSmallTier() {
    this.smallTierForced = true;
  }
  /**
   * 这一批要生成小尺寸:记下来(不等、不开 Chrome),等下一次有预渲染间要换页时在它**要扔掉的那一页**上画(`flushSmallOn`)。
   * 为什么不当场另开一页:受帧控制(`--enable-begin-frame-control`)的 Chrome 里同时开第二个受控页面,实测把预渲染间
   * 那一页的就绪等待卡死(「导出页 60 秒没就绪」);而预渲染间每一批开工前本来就要 `reset` 换一张新页,旧页这时空着。
   * 回有没有记下。攒太多(本进程好久没换页)只留最新的 `SMALL_PENDING_MAX` 帧。
   */
  scheduleSmallSnapshots(args) {
    if (!this.smallTierEnabled() || !args || args.adopted === true) return false;
    const { tier, key } = args;
    if ((tier !== 'shared' && tier !== 'local') || !key) return false;
    const items = (args.items ?? []).filter(item => Number.isInteger(item?.localFrame) && item.localFrame >= 0 && typeof item.html === 'string');
    if (!items.length) return false;
    const pending = this.smallPending ??= [];
    pending.push({ ...args, items });
    let frames = pending.reduce((n, job) => n + job.items.length, 0);
    while (frames > SMALL_PENDING_MAX && pending.length > 1) { frames -= pending.shift().items.length; this.smallStats.dropped++; }
    return true;
  }
  /** 正在生成的预渲染小尺寸都落定(`collectSnapshotResult` 列清单前等它;没有在生成的立刻兑现,不渲染) */
  whenSmallSettled() {
    return (this.smallChain ?? Promise.resolve()).catch(() => {});
  }
  get smallStats() {
    return this._smallStats ??= { written: 0, skipped: 0, failed: 0, dropped: 0, lastError: null };
  }
  /**
   * 预渲染间要换页了(`chrome.mjs` 的 `reset` / `resetWith` 开头调 `beforeReset`):把记下的小尺寸在这一页上画完。
   * 这一页马上就被关掉,在它上面改视口、藏根节点都不影响之后的渲染。
   */
  flushSmallOn(bakery) {
    const jobs = this.smallPending?.splice(0) ?? [];
    if (!jobs.length || this.closed || !this.smallTierEnabled()) return this.whenSmallSettled();
    this.smallChain = (this.smallChain || Promise.resolve()).catch(() => {}).then(async () => {
      const started = Date.now();
      const renderer = createSmallRenderer(bakery);
      for (const job of jobs) {
        try { await this.writeSmallSnapshots(job, renderer); }
        catch (error) { this.smallStats.failed++; this.smallStats.lastError = String(error?.message ?? error); break; }
      }
      // 诊断(不改行为):画小尺寸累计用了多久(队列细任务的分段耗时要它)
      this.smallStats.ms = (this.smallStats.ms ?? 0) + (Date.now() - started);
    });
    return this.smallChain;
  }
  /** 把这一批的小位图写到快照同目录;已经有的跳过。回写了几张 */
  async writeSmallSnapshots(args, renderer) {
    if (this.closed || !renderer) return 0;
    const { tier, key } = args;
    const entryKey = tier === 'local' ? args.entryKey : null;
    const control = this.controlForSnapshotKey(tier, entryKey, key);
    const width = Number(control?.appearance?.width), height = Number(control?.appearance?.height);
    if (!control || !(width > 0) || !(height > 0)) { this.smallStats.skipped += args.items.length; return 0; }
    const box = resolveFrameSize(control.appearance?.frame, { width, height });
    const dir = this.snapshots().dir({ tier, entryKey, key });
    await fs.mkdir(dir, { recursive: true });
    let written = 0;
    for (const item of args.items) {
      if (this.closed) break;
      const file = path.join(dir, `${item.localFrame}${SMALL_SUFFIX}`);
      if (await exists(file)) continue;
      const webp = await renderer.renderHtml({ html: item.html, projectWidth: width, projectHeight: height, boxWidth: Number(box.w) || width, boxHeight: Number(box.h) || height });
      await atomic(file, webp);
      written++;
    }
    this.smallStats.written += written;
    // 小位图随同一段推(推送队列按段去重;正在推的段推完再推一遍)
    if (written) { try { this.enqueueSnapshotPush({ ...args, adopted: false }); } catch {} }
    return written;
  }
  /**
   * 队列细任务「两档都推送成功才算完成」(c10a 第 9 节)的生成那一半:这一段里**已经有原尺寸、却没有小尺寸**的帧,
   * 从帧库读回 HTML,记进待画的小尺寸(`scheduleSmallSnapshots`),由接下来的换页画掉(`flushPendingSmall`)。
   *
   * 这些帧从哪来:本进程还没配推送队列时产的(比如共享配置写好之前、预渲染进程重启之前先渲的锚帧和播放头那一批 ——
   * 阿里云演示 2026-09-27 的 295/300 就是这样缺的 5 帧)、攒太多被丢掉的、上一次生成失败的、记下后进程退出没画的。
   * 只按新产出的帧排小尺寸时,这些帧所在的段原尺寸齐了、小尺寸永远缺那几张。
   * 回排了几帧。己二：预渲染小尺寸已停产，smallTierEnabled() 恒回 false，不读任何文件。
   */
  async scheduleMissingSmall(entry, control, range) {
    if (!this.smallTierEnabled() || !control?.snapshotKey || !range) return 0;
    const tier = control.tier || snapshotTier(control.capabilities);
    if (tier !== 'shared' && tier !== 'local') return 0;
    const entryKey = tier === 'local' ? entry?.key : undefined;
    if (tier === 'local' && !entryKey) return 0;
    const target = { tier, entryKey, key: control.snapshotKey };
    const store = this.snapshots();
    const index = await store.snapshotIndex(target);
    const dir = store.dir(target);
    const last = Number.isInteger(control.count) ? Math.min(range.to, control.count - 1) : range.to;
    const items = [];
    for (let frame = Math.max(0, range.from); frame <= last; frame++) {
      if (!rangeHas(index.frames, frame) && !rangeHas(index.oversize, frame)) continue;
      if (await exists(path.join(dir, `${frame}${SMALL_SUFFIX}`))) continue;
      let html;
      try { html = await fs.readFile(path.join(dir, `${frame}.html`), 'utf8'); } catch { continue; }
      items.push({ localFrame: frame, html });
    }
    if (!items.length) return 0;
    const scheduled = this.scheduleSmallSnapshots({ tier, ...(entryKey ? { entryKey } : {}), key: control.snapshotKey, clipId: control.clipId, capabilities: control.capabilities, items });
    return scheduled ? items.length : 0;
  }
  /**
   * 队列细任务收尾:还有记下没画的小尺寸,就在这个预渲染间上换一次页把它们画掉(换页前的钩子 `flushSmallOn`),
   * 并把页面恢复成干净的空项目(同 `acquire` 借出时的样子)。任务回来之后 sink 立刻列清单,不能把小尺寸留给
   * 「下一次有人换页」—— 本地档那一趟、以及整段都已有原尺寸只差小尺寸的一段,之后可能再也没人换页。
   * 没有待画的就什么都不做。
   */
  async flushPendingSmall(bakery, project, lane = 'queue') {
    if (!bakery || !this.smallPending?.length || this.closed) return false;
    await bakery.reset(project, this.emptyUrl(project), { deferCards: true });
    await bakery.page.setViewport({ width: project.width, height: project.height, deviceScaleFactor: this.scaleForLane(lane) });
    await bakery.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    return true;
  }
  /**
   * c10a 第 9 节「在线页面按清单拉取」:在线页面没有预渲染进程,算不出每张重卡的键(键里有渲染节点的环境指纹、
   * 快照代码的哈希)。渲染节点在认下一版 card plan 时把「片段 → 层的键、清单的结果键、采样窗口」写进内容库
   * (`artifact-transfer.mjs` 的 `layerMapOf`),页面按它逐段取清单、按清单的 `small` 表拉小位图。只在配了推送队列时写。
   */
  publishLayerMap(entry) {
    const queue = this.pushQueue;
    const projectId = entry?.project?.id;
    if (!queue || typeof queue.putLayerMap !== 'function' || !projectId || !Array.isArray(entry.cardPlan)) return false;
    try {
      const body = layerMapOf(entry, {
        picked: clipId => this.prerenderPicked(entry, clipId),
        fingerprint: this.envFingerprint,
        candidatesOf: control => this.splitCandidatesFor(control?.contentKey),
        ...this.layerMapStreamOptions(entry),
      });
      return queue.putLayerMap(projectId, body);
    } catch { return false; }
  }
  /**
   * 层表的 `streams` 表要的两样(`artifact-transfer.mjs` 的 `layerStreamsOf`;`docs/plan/browser-stream-task.md` 第五处):这一版的流,
   * 和每条流最近一次切分实际出键的指纹。在线页面按这张表找流清单。流有两个来处:
   *
   *   1. 本机自己这一版要产的(与生产者、与队列切分同一组参数的 `planStreams`,所以流键相同):本机没有生产者或开关关着
   *      (`PROMPTCUT_STREAMS=0`)时没有这一部分。这里不探编码器(那是异步的):列了而没人产的流,页面取不到清单,照旧每拍换快照。
   *      托管方的渲染节点按项目的「生成轨道流」产流(任务书「甲三」):这一版所属的项目此刻不产流时,执行器在 entry 上记
   *      `ownStreamsOff`(`prerender-executor.mjs` 的 `plan`),这一部分同样不列;
   *   2. 切分给别的指纹出过键、本机自己不产的单卡流(`issuedStreamSpecs`):在线页面的清单计划只给浏览器出一份流任务
   *      (`listStreamSpecs`),本机没有生产者、关着流开关、或这张卡本机没判重时第 1 部分里没有它,不列的话别的在线页面找不到
   *      浏览器产出来的那条流。清单计划切出的**依赖下层的流**(只按切分方自己的指纹出、由切分方自己产)同样从这里列:
   *      清单里的卡本机多半没判重,第 1 部分里没有它。
   *
   * 两部分都空时回空对象,层表里不带 `streams`(与以前逐字相同);只有第 1 部分时结果也与以前逐字相同。
   * 写层表的两处(本机推送队列、独立渲染主机)都经这里。
   */
  layerMapStreamOptions(entry) {
    if (!entry) return {};
    const producer = this.streamProducer();
    let own = [];
    if (producer?.enabled && entry.ownStreamsOff !== true) {
      try {
        own = planStreams(entry, { picked: clipId => this.streamPicked(entry, clipId), budget: producer.budget,
          codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: this.envFingerprint });
      } catch { own = []; }
    }
    const issued = this.issuedStreamSpecs(entry, own);
    const streams = issued.length ? [...own, ...issued] : own;
    if (!streams.length) return {};
    return { streams, streamCandidatesOf: spec => this.splitCandidatesFor(streamCandidateKey(spec?.contentKey)) };
  }
  /**
   * 切分给别的指纹出过键、而 `own`(本机自己这一版要产的流)里没有的单卡流。判据是切分候选记录(`recordSplitCandidates`,
   * 执行器在每次切分完成后按最终发布成功的流任务记,键 `stream:<流的内容键>`):这一版某张卡的单卡流的内容键在记录里,
   * 就是「有人被派过这条流」。单卡流的内容键只由这张卡的内容、采样窗口、帧率、画幅、代码版本决定,与同一版里还有哪些卡无关,
   * 所以这里不按解码器预算合并(预算给无穷大),逐张卡算出单卡流去对记录;组流不会派给浏览器,对不上,不列。
   * 依赖下层的流同样对记录(任务书「戊二」的「下层四」):它的内容键只由目标卡和它下面的层决定,清单计划切出过它的任务就列;
   * 它的候选是记录里的指纹(切分方自己的)。
   *
   * 只看在预渲染集合里的卡(清单计划的片段由 `addBackfill` 并进集合,层表的 `layers` 里有它的快照层),
   * 已经是 `own` 某条流成员的卡不再另列。每项标 `ownCandidate: false`:本机不产它,层表的候选只列记录里的指纹。
   * 记录里一条流都没有时直接回空(不算流计划)。
   */
  issuedStreamSpecs(entry, own = []) {
    let any = false;
    for (const key of this.loadSplitCandidates().keys()) if (key.startsWith(STREAM_CANDIDATE_PREFIX)) { any = true; break; }
    if (!any) return [];
    const covered = new Set(own.flatMap(spec => spec?.clipIds ?? []));
    let singles = [];
    try {
      singles = planStreams(entry, { picked: clipId => !covered.has(clipId) && this.prerenderPicked(entry, clipId), budget: Infinity,
        codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: this.envFingerprint });
    } catch { singles = []; }
    return singles
      .filter(spec => (spec.kind === 'card' || spec.kind === 'below') && this.splitCandidatesFor(streamCandidateKey(spec.contentKey))?.length)
      .map(spec => ({ ...spec, ownCandidate: false }));
  }
  /**
   * M7 契约 D12:队列切分完成后记下每张共享档卡实际出键的指纹(`artifact-transfer.mjs` 的 `splitCandidatesOf`,
   * 内容键 → 指纹表,切分方自己的在前),之后写层表(本机推送队列写的、独立渲染主机写的)都按它列候选。
   * 后记的覆盖先记的;最多留 SPLIT_CANDIDATES_MAX 张卡(按记下的先后淘汰)。
   * 落盘在库根的 `split-candidates.json`(整份重写),进程重启后照样按它列候选 —— 不然重启后的第一次写层表
   * (preload、预渲染重试登记)只剩自己一个候选,页面找不到自己产的那一层(M7 验收探针查出)。读写失败只当没有记录。
   */
  splitCandidatesPath() {
    return typeof this.root === 'string' && this.root ? path.join(this.root, 'split-candidates.json') : null;
  }
  loadSplitCandidates() {
    if (this._splitCandidates) return this._splitCandidates;
    this._splitCandidates = new Map();
    const file = this.splitCandidatesPath();
    if (!file) return this._splitCandidates;
    try {
      const body = JSON.parse(readFileSync(file, 'utf8'));
      for (const [contentKey, fps] of Array.isArray(body?.entries) ? body.entries : []) {
        if (typeof contentKey === 'string' && contentKey && Array.isArray(fps) && fps.every(fp => typeof fp === 'string' && fp)) this._splitCandidates.set(contentKey, [...fps]);
      }
    } catch { /* 没有或坏了:当没有记录 */ }
    return this._splitCandidates;
  }
  recordSplitCandidates(candidates) {
    if (!(candidates instanceof Map)) return 0;
    this.loadSplitCandidates();
    let n = 0;
    for (const [contentKey, fps] of candidates) {
      if (typeof contentKey !== 'string' || !contentKey || !Array.isArray(fps) || !fps.length) continue;
      this._splitCandidates.delete(contentKey);
      this._splitCandidates.set(contentKey, [...fps]);
      n++;
    }
    while (this._splitCandidates.size > SPLIT_CANDIDATES_MAX) this._splitCandidates.delete(this._splitCandidates.keys().next().value);
    const file = n > 0 ? this.splitCandidatesPath() : null;
    if (file) {
      try {
        writeFileSync(`${file}.tmp`, JSON.stringify({ v: 1, entries: [...this._splitCandidates.entries()] }));
        renameSync(`${file}.tmp`, file);
      } catch { /* 落不了盘:这一进程里照样按内存里的列 */ }
    }
    return n;
  }
  /** 这张卡(共享档内容键)最近一次切分实际出键的指纹;没记过回 null */
  splitCandidatesFor(contentKey) {
    const list = typeof contentKey === 'string' ? this.loadSplitCandidates().get(contentKey) : undefined;
    return list ? [...list] : null;
  }
  enqueueStreamPush(spec, segment) {
    const queue = this.pushQueue;
    if (!queue || !spec?.streamKey || !Number.isInteger(segment) || segment < 0) return false;
    const first = Number.isInteger(spec.firstSegment) && spec.firstSegment <= segment ? spec.firstSegment : 0;
    const span = PUSH_STREAM_SEGMENTS;
    const from = first + Math.floor((segment - first) / span) * span;
    const last = Number.isInteger(spec.lastSegment) && spec.lastSegment >= from ? spec.lastSegment : null;
    const to = last !== null ? Math.min(last, from + span - 1) : from + span - 1;
    // 契约第 9 节第 1 条:进队同步生效,回的 promise 是落盘;钩子不等它
    void Promise.resolve(queue.enqueue({ kind: 'stream', resultKey: spec.streamKey, range: { from, to } }, PUSH_LOW)).catch(() => {});
    return true;
  }
  streamLocksPath() {
    return typeof this.root === 'string' && this.root ? path.join(this.root, 'stream-locks.json') : null;
  }
  loadStreamLocks() {
    const locks = new Map();
    const file = this.streamLocksPath();
    if (!file) return locks;
    try {
      const body = JSON.parse(readFileSync(file, 'utf8'));
      for (const [contentKey, fingerprint] of Array.isArray(body?.entries) ? body.entries : []) {
        if (typeof contentKey === 'string' && contentKey && typeof fingerprint === 'string' && fingerprint) locks.set(contentKey, fingerprint);
      }
    } catch { /* 没有记录、读不了:当没有锁 */ }
    return locks;
  }
  saveStreamLocks() {
    const file = this.streamLocksPath();
    if (!file) return;
    try {
      // 只留最近记的 STREAM_LOCKS_MAX 条(Map 的插入顺序)
      while (this.streamLocks.size > STREAM_LOCKS_MAX) this.streamLocks.delete(this.streamLocks.keys().next().value);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, entries: [...this.streamLocks] }));
      renameSync(tmp, file);
    } catch { /* 落不了盘:这一进程里照样按内存里的用 */ }
  }
  /**
   * 「先查,没有才产」的桌面一侧(任务书 `render-refactor-task.md`「甲二」):这一版的单卡流,别的环境(在线页面在没有切分节点时自己产的、
   * 别的桌面)已经在素材服务上有**整条满密度**的,就拉回本机流库,并把这条流锁到那个指纹上(`streamLocks`:内容键 → 指纹)。
   * 之后本机的流计划照锁出键(`relockStreams`):生产者不重产、舞台播的就是拉回来的那一条、层表的候选是那个指纹;切分时照锁只出一份
   * (`planForQueue` 把锁并进 `cardLocks`)。
   *
   *   - 候选从哪来:内容库里这个项目的层表(`layers:<项目 id>` 的 `streams` 表里同内容键的行列着的指纹),加上本机的切分候选记录;
   *   - 本机自己的键已经整条都有的不查、不锁;别的候选只有一部分的不锁(照旧按自己的键产);
   *   - 已经记的锁每次复核:拉回来的那条在本机流库里不齐了(被清掉了)就解锁,回到自己的键。
   *
   * 回 `{ checked, locked, unlocked }`(查了几条流、新锁了几条、解了几条);出错只记进 `this.lastForeignStreams`,不抛。
   */
  async adoptForeignStreams(entry, content, client, { signal } = {}) {
    const report = { checked: 0, locked: 0, unlocked: 0, at: Date.now(), error: null };
    const own = this.envFingerprint;
    const producer = this.streamProducer();
    const projectId = entry?.project?.id;
    if (!own || !producer || !entry || !content || typeof content.get !== 'function' || !client) return report;
    let singles = [];
    try {
      // 按本机自己的指纹算(不带锁);预算给无穷大:只看单卡流,每张进得了流的卡一条
      singles = planStreams({ ...entry, streamLocks: null }, { budget: Infinity, codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: own })
        .filter(spec => spec.kind === 'card');
    } catch { singles = []; }
    if (!singles.length) return report;
    /** 这个键的流在本机流库里是不是整条满密度 */
    const complete = async (streamKey, spec) => {
      let manifest = null;
      try { manifest = producer.streams?.get(streamKey)?.manifest ?? await producer.store?.load(streamKey); } catch { manifest = null; }
      if (!manifest) return false;
      for (let n = spec.firstSegment; n <= spec.lastSegment; n++) if (!(manifest.segments?.[n]?.stride === 1)) return false;
      return true;
    };
    let changed = false;
    try {
      // 复核已有的锁
      for (const spec of singles) {
        const fingerprint = this.streamLocks.get(spec.contentKey);
        if (!fingerprint || await complete(resultKeyOf(spec.contentKey, fingerprint), spec)) continue;
        this.streamLocks.delete(spec.contentKey);
        report.unlocked++;
        changed = true;
      }
      let rows = null;
      for (const spec of singles) {
        if (signal?.aborted || this.closed) break;
        if (this.streamLocks.has(spec.contentKey) || await complete(spec.streamKey, spec)) continue;
        if (rows === null) {
          rows = [];
          const key = layerMapKeyOf(projectId);
          if (key) {
            const body = (await content.get('snapshot-manifest', key))?.body;
            if (Array.isArray(body?.streams)) rows = body.streams;
          }
        }
        const listed = rows.filter(row => row?.kind === 'card' && row.contentKey === spec.contentKey).flatMap(row => (Array.isArray(row.candidates) ? row.candidates : []).map(c => c?.envFingerprint));
        const fingerprints = [...new Set([...listed, ...(this.splitCandidatesFor(streamCandidateKey(spec.contentKey)) ?? [])])].filter(fp => typeof fp === 'string' && fp && fp !== own);
        if (!fingerprints.length) continue;
        report.checked++;
        for (const fingerprint of fingerprints) {
          const resultKey = resultKeyOf(spec.contentKey, fingerprint);
          if (!await complete(resultKey, spec)) {
            // 每一份清单都要在、覆盖它那一段、全是满密度,才整条拉;缺一份就不要这个候选
            const bodies = [];
            for (const [from, to] of spansOf(spec.firstSegment, spec.lastSegment, PUSH_STREAM_SEGMENTS)) {
              const ref = { kind: 'stream', resultKey, range: { from, to } };
              const body = (await content.get('render-manifest', manifestKeyOf(ref)))?.body;
              let full = !!body && manifestMatches(body, ref);
              for (let n = from; full && n <= to; n++) if (!(body.segments?.[n]?.stride === 1)) full = false;
              if (!full) { bodies.length = 0; break; }
              bodies.push(body);
            }
            if (!bodies.length) continue;
            for (const body of bodies) await applyResult(this, client, body);
            if (!await complete(resultKey, spec)) continue;
          }
          this.streamLocks.set(spec.contentKey, fingerprint);
          report.locked++;
          changed = true;
          break;
        }
      }
    } catch (error) {
      report.error = String(error?.message ?? error).slice(0, 200);
    }
    if (changed) this.saveStreamLocks();
    this.lastForeignStreams = report;
    return report;
  }
  /**
   * C6.4 第 5 节:换机取用。给一个活的 entry(某个会话当前版本的 card plan),按它每个共享档与本地档的 control、
   * 以及每条流,算出各段的键(与推送、与队列细任务同一种切法),逐段 `content.get` 清单;查到的交给 C6.2 的
   * `applyResult` 拉取、落盘、发布。本机已经有的段跳过,查不到的段也跳过(由本机照常预渲染)。
   *
   * 回 `{ manifests, fetched, written }`:查到并交去拉取的清单数、下载的块数(init 也算)、实际落盘的帧数 / 分段数。
   * 一段拉失败只记下来(`this.lastAdoption.failed`),不影响别的段;内容库断线就停下,剩下的段不再查。
   */
  async adoptFromManifests(entry, content, client, { signal } = {}) {
    const out = { manifests: 0, fetched: 0, written: 0 };
    const report = { ...out, skipped: 0, missing: 0, failed: 0, at: Date.now() };
    if (!entry || !content || typeof content.get !== 'function' || !client) return out;
    const jobs = new Map();
    const add = job => {
      const kind = manifestKindOf(job.kind);
      const key = manifestKeyOf(job);
      if (kind && key && !jobs.has(`${kind}\u0000${key}`)) jobs.set(`${kind}\u0000${key}`, { ...job, manifestKind: kind, manifestKey: key });
    };
    const producer = this.streamProducer();
    if (producer?.enabled) {
      let specs = [];
      try {
        specs = planStreams(entry, { picked: clipId => this.streamPicked(entry, clipId), budget: producer.budget,
          codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: this.envFingerprint });
      } catch { specs = []; }
      for (const spec of specs) {
        if (!spec?.streamKey) continue;
        for (const [from, to] of spansOf(spec.firstSegment, spec.lastSegment, PUSH_STREAM_SEGMENTS)) add({ kind: 'stream', resultKey: spec.streamKey, range: { from, to } });
      }
    }
    const store = this.snapshots();
    /** 本机是不是已经有整段 */
    const haveLocally = async job => {
      const { from, to } = job.range;
      if (job.kind === 'snapshot') {
        const index = await store.snapshotIndex({ tier: job.tier, entryKey: job.entryKey ?? undefined, key: job.dirKey });
        for (let f = from; f <= to; f++) if (!rangeHas(index.frames, f) && !rangeHas(index.oversize, f)) return false;
        return true;
      }
      const manifest = producer?.streams?.get(job.resultKey)?.manifest ?? await producer?.store?.load(job.resultKey);
      if (!manifest) return false;
      for (let n = from; n <= to; n++) if (!manifest.segments?.[n]) return false;
      return true;
    };
    let offline = false;
    const list = [...jobs.values()];
    let next = 0;
    const lane = async () => {
      for (;;) {
        const job = list[next++];
        if (!job || offline || signal?.aborted || this.closed) return;
        try {
          if (await haveLocally(job)) { report.skipped++; continue; }
        } catch { /* 当本机没有 */ }
        let item;
        try { item = await content.get(job.manifestKind, job.manifestKey); }
        catch (error) {
          if (error?.code === 'disconnected') offline = true;
          report.failed++;
          continue;
        }
        const body = item?.body;
        if (!body) { report.missing++; continue; }
        const sameTarget = job.kind !== 'snapshot' || (body.tier === job.tier && body.dirKey === job.dirKey && (job.tier !== 'local' || body.entryKey === job.entryKey));
        if (!manifestMatches(body, job) || !sameTarget) { report.missing++; continue; }
        out.manifests++;
        try {
          const applied = await applyResult(this, client, body);
          out.fetched += applied.fetched;
          out.written += applied.written;
        } catch {
          report.failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ADOPT_CONCURRENCY, list.length) }, lane));
    this.lastAdoption = { ...report, ...out, jobs: list.length, offline };
    return out;
  }
  /**
   * C6.2(契约第 6 节):别的节点产的一段结果已经落进本机帧库,把它发布进就绪索引。
   *
   *   - 快照:按落盘后的 `index.json` 把线上的键(`wireSnapshotKey(tier, entryKey, dirKey)`)挂进 `stageByKey`,
   *     再对每个 entry 认领一次(`claimSessions`):凡是 card plan 用到这个键、当前有会话在这一版上的,
   *     都收到 `layer`。不需要知道 `clipId` —— 键是内容寻址的,认领按 card plan 把键对回片段。
   *   - 轨道流:由 `streamProducer().adoptSegments` 负责发布,这里什么都不做。
   *
   * 回 `{ kind, key, ranges, claimed }`(`ranges` 是这个键此刻在盘上的区间,`claimed` 是并进了几层)。
   */
  async adoptResult(result) {
    if (!result || typeof result !== 'object' || result.v !== 1) throw new Error('Unknown artifact result');
    if (result.kind === 'stream') return { kind: 'stream', key: result.resultKey ?? null, ranges: null, claimed: 0 };
    if (result.kind !== 'snapshot') throw new Error(`Unknown artifact result kind ${result.kind}`);
    const { tier, dirKey } = result;
    const entryKey = tier === 'local' ? result.entryKey : null;
    const kind = kindOfTier(tier);
    const key = wireSnapshotKey(tier, entryKey, dirKey);
    if (!kind || !key) throw new Error('Snapshot result has no usable key');
    const index = await this.snapshots().snapshotIndex({ tier, entryKey, key: dirKey });
    if (index.frames.length) this.ready.stageByKey({ kind, key, ranges: index.frames });
    let claimed = 0;
    for (const entry of this.entries.values()) claimed += this.claimSessions(entry);
    return { kind, key, ranges: index.frames, claimed };
  }
  /**
   * F5 预渲染进程重启后的恢复:起来先扫
   * `controls-html/<共享键>/index.json` 和 `controls-local/<entry.key>/<共享键>/index.json`,
   * 重建 C3 的就绪索引。
   *
   * **扫盘只得到「键 → 区间」** —— 目录名是剥掉 clipId 的共享键,所以这里只把它们
   * 挂在键上(`stageByKey`,所有会话共用),不发 `layer`;等页面的 `preload` 把会话的版本
   * 设回来、card plan 重算出来,再按 `control.clipId` ↔ `control.snapshotKey` 反查、
   * 并进那个会话的索引(`claimSessions`)。
   *
   * 轨道流(R8)的清单 `<库根>/streams/<streamKey>/stream.json` 同样扫一遍、挂在键上(`kind: 'stream'`)。
   */
  async rescanSnapshots() {
    // 契约 F.3:锁库先读完 —— 被别的环境锁定的卡,认领时认的是锁定方的键(`applyCardLocks`)
    await this.ensureCardLocks();
    let found = 0;
    try { found += (await this.streamProducer()?.rescan()) ?? 0; } catch {}
    return found;
  }
  /**
   * 页面这一版的 card plan 到位(**只有 `preload` 的后台那一趟调**,Item 4):记计划 + 认领。
   * 扫盘只得到「键 → 区间」,`layer` 和页面的 `readyIndex` 却都按 clipId 索引 —— 所以要等
   * card plan 才能用 `control.clipId` ↔ `control.snapshotKey` 反查。清表不在这里:会话换版本时
   * `adoptSession` 已经 reset 过。别的 lane 只调 `recordCardPlan`。
   *
   * 顺带把「产哪些卡」记在 entry 上(`prerenderSetOf` 的窄接口)。这个集合是
   * **消费方**:`prerenderPicked` 把它接进 `snapshotTargets` / `missingSnapshotFrames` /
   * `fillCardControls` / 就绪索引认领,在所有位置都判轻的卡因此什么都不产(pinned 渲染 9)。
   */
  adoptCardPlan(entry, plan) {
    this.recordCardPlan(entry, plan);
    // 按新的 costs 重算之后集合缩了(有卡判轻了):会话里它们的旧层要撤掉。线上没有「删一层」,
    // 只能 reset 再全量补回来 —— `staged` 里有这一版发过的全部区间,补得回来(Item 4)
    const claimed = entry.claimedSet;
    if (claimed instanceof Set && [...claimed].some(clipId => !this.prerenderPicked(entry, clipId))) {
      this.ready.resetOn(entry.key);
      if (entry.anchorsReady) this.ready.markDone(entry.key);
    }
    this.claimSessions(entry);
    // 认领只补扫盘挂着的区间,组流的 `groupClipIds` 不在认领表里 —— 由生产者按清单补发一次(同样过闸)
    this._streams?.republish();
    return plan;
  }
  /**
   * 「把计划记在 entry 上」(Item 4 拆开的前一半):`entry.cardPlan` 和预渲染集合。**任何 lane 都可以调**,
   * 只动这个 entry 自己,不碰任何会话的就绪索引 —— `cardRender`(Agent 查询、导出、交互帧)只做这一步。
   */
  recordCardPlan(entry, plan) {
    // 契约 F.3:被别的环境锁定的共享档卡换成锁定方的键 —— 之后的投递、认领、扫盘重建都认这个键
    this.applyCardLocks(plan);
    entry.cardPlan = plan;
    // K2 / K6:真的按 planPipelines 的表算(costs / tuning 由编辑器进程转发过来、落在本机那一份)
    entry.basePrerenderSet = prerenderSetOfPlan(plan, { fps: Number(entry.project?.fps) || 30, root: this.dataRoot });
    entry.prerenderSet = entry.basePrerenderSet;
    // c10a 契约第 17 节:预渲染重试登记过的片段并进来(`addBackfill`)
    this.applyBackfill(entry);
    // 存储占用:任何 lane 用到这一版的计划,它的键都记为使用
    this.usage?.touchEntry(entry);
    return plan;
  }
  /**
   * 「认领」(拆开的后一半):把扫盘 / 轨道流挂着的区间并进**当前版本正是这个 entry** 的会话。
   * 不 reset(清表只在会话换版本时由 `adoptSession` 做),别的会话一概不动。回并进了几层。
   */
  claimSessions(entry) {
    if (!entry?.cardPlan || !this.ready.sessionsOn(entry.key).length) return 0;
    const layers = [];
    for (const control of entry.cardPlan ?? []) {
      // pinned 渲染 9:在所有位置都判轻的卡不进就绪索引
      if (!this.prerenderPicked(entry, control.clipId)) continue;
      const tier = control.snapshotKey ? (control.tier || snapshotTier(control.capabilities)) : 'none';
      const kind = kindOfTier(tier);
      const key = wireSnapshotKey(tier, entry.key, control.snapshotKey);
      if (kind && key && control.clipId) layers.push({ clipId: control.clipId, kind, key });
    }
    // R8:生产者手里属于这一版的流一并认领(F5 扫盘挂着的流键也在这里认);判轻的卡同样不认
    for (const layer of this._streams?.claimLayers(entry.key) ?? []) if (this.prerenderPicked(entry, layer.clipId)) layers.push(layer);
    // 记下这次是按哪一份集合认领的:集合之后缩了,`adoptCardPlan` 据此撤层
    entry.claimedSet = entry.prerenderSet instanceof Set ? new Set(entry.prerenderSet) : undefined;
    try { return this.ready.claim(entry.key, layers); } catch { return 0; }
  }
  /**
   * 设定页面会话的当前版本(**只有 `preload` 调**,Item 4 业务决断 2)。版本换了,hub 先 reset 这个会话
   * (页面清表);这一版的计划已经算过的话(Agent 查询 / 别的会话先渲过它),马上认领一次 ——
   * 不必等后台那一趟排到。`ticket` 是 preload 进门时领的号,过期的不认。
   */
  adoptSession(session, entry, localRev, ticket) {
    let changed = false;
    // 这一版的计划还没算出来就先不清页面的表(`defer`):等后台那一趟算出计划、认领时再 reset + 补层
    try { changed = this.ready.adopt(session, entry.key, localRev, ticket, { defer: !entry.cardPlan }); } catch { return false; }
    if (changed && entry.cardPlan) {
      this.claimSessions(entry);
      if (this._streams?.entryKey === entry.key) this._streams.republish();
    }
    // 这一版的锚帧早就齐了(别的会话先跑过):换到它的会话同样该收到 `done`
    if (changed && entry.anchorsReady) this.ready.markDone(entry.key);
    return changed;
  }
  /**
   * C3:把某一层此刻的全部就绪区间发出去(全量语义,`ready-index.mjs`)。**所有发层都走这一个口子**
   * (Item 4):带上它属于的 `entry`,只进当前版本正是这个 entry 的会话;旧版本晚到的批次、
   * Agent / 导出渲的别的版本一律丢弃。回写进了几个会话。
   */
  publishLayer(entry, control, tier, ranges) {
    // 成本记录可能在旧后台批还在飞时把卡改判为轻；旧批不能把撤掉的层补回来。
    if (!this.prerenderPicked(entry, control?.clipId)) return 0;
    const kind = kindOfTier(tier);
    const key = wireSnapshotKey(tier, entry?.key, control?.snapshotKey);
    if (!entry?.key || !kind || !key || !control?.clipId) return 0;
    return this.ready.publish(entry.key, { clipId: control.clipId, kind, key, ranges });
  }
  /**
   * 锁换了主人之后的整层换键(契约 F.3):同一内容键的每个共享档片段都发一条 `layer`,键是它此刻的
   * `snapshotKey`(新锁定方的),区间是新键下现有的(可能为空)。`setLayer` 按 (clipId, kind) 整条覆盖,
   * 页面据此丢掉旧环境的帧。`control` 本身排第一个发。
   */
  publishRelocked(entry, controls, control, ranges) {
    const seen = new Set();
    for (const item of [control, ...(entry?.cardPlan ?? []), ...(Array.isArray(controls) ? controls : [])]) {
      if (!item?.clipId || seen.has(item.clipId) || item.contentKey !== control.contentKey) continue;
      if ((item.tier || snapshotTier(item.capabilities)) !== 'shared' || !item.snapshotKey || !this.prerenderPicked(entry, item.clipId)) continue;
      seen.add(item.clipId);
      this.publishLayer(entry, item, 'shared', ranges);
    }
  }
  /**
   * C4 的调度点:这一批该从哪个本地帧开始。
   *
   * 镜像插件里有页面报的 `wanted`(播放头附近缺的层)时,含它的那一批先跑;
   * 没有就回到顺序批。**不打断正在跑的那一批** —— 这个函数只在批与批之间被调。
   */
  nextBatchStart(pending, control) {
    const ordered = [...pending].sort((a, b) => a - b);
    for (const item of this.playheadWanted()) {
      if (item?.clipId !== control.clipId) continue;
      const local = Number(item.frame) - control.sampling.firstFrame;
      if (!Number.isInteger(local) || local < 0 || local >= control.count) continue;
      const start = local - (local % 4);
      if (!pending.has(start) || start === ordered[0]) continue;
      console.log(`[frames] wanted: 片段 ${control.clipId} 的第 ${start}~${Math.min(start + 3, control.count - 1)} 批提前(顺序批本来是 ${ordered[0]})`);
      // 预渲染进程的 stdout 被编辑器进程收走了(`vite-plugin-prerender` 的 `keep`),
      // 端到端探针看不见上面那行;所以同一件事也记一条,经 `/api/frames/diagnostics` 读。
      this.notePromotion({ clipId: control.clipId, start, instead: ordered[0], frame: Number(item.frame) });
      return start;
    }
    return ordered[0];
  }
  /**
   * C2 的本地档那一趟:**一趟整场景渲染服务该帧上全部本地档卡**(不是每卡一趟)。
   *
   * 为什么不能走隔离单卡:`isolatedCardProject` 剥掉了下层场景,毛玻璃没有背景
   * 可采;`unknown` 卡(定制卡、带部件的组合卡片段)同理拿不到自己要的上下文。
   *
   * 为什么不能复用 `renderMovFrames` 现成的回调:它的 `requested` 只含 MOV 缺的帧,
   * `onSnapshot` 还被 `!entry.html.has(n)` 挡着,`htmlFrames` 重放路根本不进 `bakeFrames`。
   *
   * 参数照 C2 钉死:`targetFrames: frames`、`fullFrame: true`(不带它 `bake.mjs:69`
   * 的帧窗规划不生效)、`snapshotOnly: false`(`bake.mjs:281` 的守卫;改成 `true`
   * 会关掉帧窗规划、也跳过 `shoot` 里的 `prepareFrameMedia`,而本地档正是毛玻璃 /
   * `unknown` 卡 —— 素材层没准备好,快照里就是错的画面)、`writeFrames: false`、
   * `snapshotFrames: new Set(frames)`。**每帧因此多截一张没人消费的 PNG,这是已知代价。**
   *
   * `frames` = 本地档索引里任一本地档卡缺的**全局**帧的并集。
   */
  /**
   * `options.shouldStop`(AGENT-maint-3,只有做在 Agent 专用实例上的队列细任务传):每交 4 帧问一次,为真就在这一帧之后停下,
   * 已攒的批照常收尾发层,回停下的那一帧(全局帧号);没停回 undefined。
   */
  async renderLocalSnapshots(entry, frames, bakery, signal, { shouldStop = null } = {}) {
    const targets = this.snapshotTargets(entry);
    if (!targets?.size) return;
    const locals = new Map([...targets].filter(([, target]) => target.tier === 'local'));
    const list = [...new Set(frames ?? [])].filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
    if (!locals.size || !list.length) return;
    const capabilities = new Map((entry.cardPlan ?? []).map(control => [control.clipId, control.capabilities]));
    /** clipId → 快照库的攒批写(#9:写帧 + 判体积 + 并 index 一步做,A3c / R6-14 的超限帧记进 `oversize`) */
    const batches = new Map();
    const stop = shouldStop ? new AbortController() : null;
    let stoppedAfter, seen = 0;
    try {
    await bakeFrames(bakery, {
      out: entry.dir, targetFrames: list, snapshotOnly: false, fullFrame: true, writeFrames: false, signal: stop ? AbortSignal.any([signal, stop.signal].filter(Boolean)) : signal,
      snapshotFrames: new Set(list),
      // `__pcCreateSnapshot` 的产物每项只有 id(= clipId)/ frame / html,**不含共享键** ——
      // 键用 card plan 的 `control.clipId` ↔ `control.snapshotKey` 反查。
      onSnapshot: async (_frame, _html, produced) => {
        if (signal?.aborted) return;
        for (const item of produced ?? []) {
          const target = locals.get(item.id);
          if (!target || !Number.isInteger(item.frame)) continue;
          if (!batches.has(item.id)) batches.set(item.id, this.snapshots().batch({ tier: 'local', entryKey: entry.key, key: target.key, clipId: item.id, capabilities: capabilities.get(item.id) }));
          try { await batches.get(item.id).add(item.frame, item.html); }
          catch { continue; }
        }
        seen++;
        if (stop && seen % 4 === 0 && _frame < list[list.length - 1] && shouldStop()) { stoppedAfter = _frame; stop.abort(); }
      },
    });
    } catch (error) {
      if (!(stop?.signal.aborted && !signal?.aborted && stoppedAfter !== undefined)) throw error;
    }
    // 中途取消:已经交掉的批都在 index 里(盘面和 index 一致),没交的几帧丢掉,下一趟补
    if (signal?.aborted) return;
    for (const [clipId, batch] of batches) {
      const index = await batch.close();
      if (index && batch.written) this.publishLayer(entry, { clipId, snapshotKey: batch.key }, 'local', index.frames);
    }
    return stoppedAfter;
  }
  /**
   * 整场景路要渲哪些**全局**帧:某一档的卡在这一帧还缺快照,这一帧就得渲(并集 ——
   * 一趟整场景渲染服务该帧上全部同档卡)。顺带把已有的区间发成 `layer`(C3)。
   *
   *   `tiers`      只看这几档(本地档那一趟传 `['local']`,锚帧那一趟两档都要);
   *   `restrictTo` 只在这些全局帧里挑(锚帧那一趟传锚帧集合;不传 = 全部)。
   */
  async missingSnapshotFrames(entry, { tiers = ['local'], restrictTo = null } = {}) {
    const plan = entry.cardPlan;
    if (!plan?.length) return [];
    const fps = Number(entry.project.fps) || 30;
    const only = restrictTo ? new Set(restrictTo) : null;
    const wanted = new Set();
    for (const control of plan) {
      // pinned 渲染 9:不在预渲染集合里的卡不产快照,也就没有「缺帧」可言
      if (!this.prerenderPicked(entry, control.clipId)) continue;
      const tier = control.snapshotKey ? (control.tier || snapshotTier(control.capabilities)) : 'none';
      if (!tiers.includes(tier)) continue;
      const entryKey = tier === 'local' ? entry.key : undefined;
      const index = await this.snapshots().snapshotIndex({ tier, entryKey, key: control.snapshotKey });
      if (index.count) this.publishLayer(entry, control, tier, index.frames);
      // 契约 F.3「不替锁定方产帧」:被别的环境锁定的卡照常发它现有的区间(上面那条,键是锁定方的),
      // 但它的帧不算「缺」—— 整场景路不为它渲
      if (control.cardLock?.foreign === true) continue;
      // R6-14:超限被丢掉的帧不算「缺」—— 它们已经渲过一次、也已经判过一次超限
      if (index.count + rangeCount(index.oversize) >= control.count) continue;
      for (let local = 0; local < control.count; local++) {
        if (rangeHas(index.frames, local) || rangeHas(index.oversize, local)) continue;
        const global = local + control.sampling.firstFrame;
        if (global / fps >= control.end - 1e-9) break;
        if (!only || only.has(global)) wanted.add(global);
      }
    }
    return [...wanted].sort((a, b) => a - b);
  }
  /**
   * C2 **先预渲染锚帧**:锚帧全部就绪前不开始其余后台预渲染。
   *
   * 锚帧集合 = 每个片段的 `mountFrameOf`、`clipFrameSpan` 的 `last + 1`、第 0 帧
   * (C1 末句;算式在 `src/render/snapshotPick.mjs`,两端同一份)。这一趟走整场景
   * 路,所以共享档和本地档的卡一起产 —— C4 的「同区间内回溯」靠的正是段起点那一帧
   * 早早就绪,冷缓存拖到第 1000 帧才有东西可贴。
   */
  async fillAnchorSnapshots(entry, bakery, signal) {
    const fps = Number(entry.project.fps) || 30;
    const count = Math.max(1, Math.floor(entry.project.duration * fps));
    const clips = (entry.project.tracks || []).flatMap(track => track.clips || []);
    const anchors = anchorFrames(clips, fps).filter(frame => frame >= 0 && frame < count);
    const frames = await this.missingSnapshotFrames(entry, { tiers: ['shared', 'local'], restrictTo: anchors });
    if (!frames.length) { entry.anchorsReady = true; return this.ready.markDone(entry.key); }
    await bakeFrames(bakery, {
      out: entry.dir, targetFrames: frames, snapshotOnly: false, fullFrame: true, writeFrames: false, signal,
      snapshotFrames: new Set(frames),
      // `anchors`:队列模式下锚帧仍由这一趟产(J.5),见 `recordSnapshots`
      onSnapshot: (n, html, controls) => this.record(entry, n, html, controls, { anchors: true }),
    });
    await this.flushSnapshots(entry);
    if (!signal?.aborted) { entry.anchorsReady = true; this.ready.markDone(entry.key); }
  }
  /**
   * 后台那一趟正在做的这张卡,把还没开工的批(`pending` 里的批首)交给 Agent 专用实例空闲时借(`takeAgentUnit`)。
   * 一次只借一批(4 帧),借最靠后的那一批:后台自己从前往后做(C4 的 `wanted` 那一批仍由后台先做),两边不抢同一批。
   * 借走的批在 Agent 专用实例自己的预渲染间上跑同一个 `runBatch`;快照入库(`commitSnapshots` 按键串行)、PNG 缓存
   * (`MovFrameStore.put` 按 store 串行)本来就容得下同一张卡不同的帧并发写。这张卡的收尾(`cardCache.finish`,
   * 起 ffmpeg 编 MOV)只由后台做,而且等借走的批都落定之后 —— 所以不会有两处同时收尾同一张卡。
   * 借走的批出错(不是被掐)就交还 `pending`,由后台补做。
   */
  openCardBatchPool({ control, pending, stolen, signal, runBatch }) {
    const pool = {
      tag: `card:${control.key}`,
      take: () => {
        if (this.cardBatchPool !== pool || signal?.aborted || !pending.size) return null;
        const first = Math.max(...pending);
        pending.delete(first);
        let settle;
        const item = { first, done: new Promise(resolve => { settle = resolve; }) };
        stolen.add(item);
        const finish = () => { stolen.delete(item); settle(); };
        return {
          tag: pool.tag, source: 'card-batch',
          giveBack: () => { if (!signal?.aborted) pending.add(first); finish(); },
          run: async agentBakery => {
            try { await runBatch(agentBakery, first, first); }
            catch {
              if (!signal?.aborted) {
                pending.add(first);
                // 专用实例的预渲染间可能坏了:关掉它(下一个 Agent 任务重开),免得空闲时一再借它、一再失败
                this.dropAgentSession(agentBakery);
              }
            }
            finally { finish(); }
          },
        };
      },
    };
    this.cardBatchPool = pool;
    this.kickAgentIdle();
    return pool;
  }
  closeCardBatchPool(pool) {
    if (this.cardBatchPool === pool) this.cardBatchPool = null;
  }
  /** 关掉 Agent 专用实例那个预渲染间(只在它还是 `bakery` 时);下一个 Agent 任务 `acquire` 时重开 */
  dropAgentSession(bakery) {
    const session = this.lanes.get('agent');
    if (!session || session.bakery !== bakery) return;
    clearTimeout(session.timer);
    this.lanes.delete('agent');
    void Promise.resolve(session.bakery.close?.()).catch(() => {});
  }
  /**
   * 第 5 个参数(契约 J.4,只有队列执行器的 `renderCardSnapshotRange` 传;preload 从来不传):
   *   `range`   `{ from, to }` 本地帧闭区间:批次只从覆盖这个区间的那几批起(起点按 4 帧对齐),
   *             生成快照的帧只取区间内缺的;PNG 那一支、锁的判断、批内的帧照旧;
   *   `onBatch` 每批交完调一次 `({ control, first, frames, snapshotFrames })`(进度用)。
   *   `share`   后台那一趟传 `true`:每张卡还没开工的批让 Agent 专用实例空闲时借走(`openCardBatchPool`,
   *             `mechanism/rendering.md`「Agent 优先只是插队」的「Agent 队列空时接普通预渲染任务」)。
   *             没有开着、空着的专用实例时没人来借,行为与不传相同。和 `range` 不同时用。
   *   `yieldPoint` / `shouldYield`  队列细任务做在 Agent 专用实例上时由 `runQueueItem` 给(AGENT-maint-3):批边界
   *             (4 帧)问 `shouldYield()`,有 Agent 任务在等就 `await yieldPoint()` 让它先做。逐批跑时就在两批之间;
   *             一趟顺推(`singlePass`)时在交完一个 4 帧块之后停下这一趟(取消只在两帧之间生效,页面不在半路上),
   *             让完从下一个没做的批起再顺推 —— 起点仍按 4 帧对齐,和逐批跑的批一模一样,已交的帧不重做。
   * 不传时逐字节是原来的行为。
   */
  async fillCardControls(entry, bakery, signal, controls = null, { range = null, onBatch = null, timing = null, singlePass = false, share = false, yieldPoint = null, shouldYield = null } = {}) {
    // 诊断(不改行为):给了 `timing` 就把换页、推帧、入库各花了多久累进去(队列细任务的分段耗时,`prerender-executor.mjs` 记进 executor.render)
    const clock = timing ? () => Date.now() : null;
    const add = (k, ms) => { if (timing) timing[k] = (timing[k] ?? 0) + ms; };
    if (!controls) {
      const browserPlan = await this.browserCardPlan(bakery);
      if (!browserPlan) return [];
      try { controls = entry.cardCache.plan(browserPlan); } catch { return []; }
    }
    // 契约 F.3:锁可能在 card plan 记下之后变过(页面刚存了测量帧),开工前按锁库重排一遍
    this.reapplyCardLocks(entry, controls);
    const store = this.cardLockStore;
    /*
     * 延后列表(契约 F.3 的 `'defer'`):锁定方可能还在产的卡先放到末尾,其余卡做完后再判一次
     * (`lastChance`);仍是 `'defer'` 就这一趟跳过,放进 `skipped` 回给调用方 —— 后台那一趟结束时
     * 据此定一个 `cardLockIdleMs` 之后的重判(契约 F.8 第 2 条,`scheduleCardLockRetry`)。
     */
    const skipped = [];
    const work = controls.filter(control => control.cacheable).map(control => ({ control, lastChance: false }));
    for (let at = 0; at < work.length; at++) {
      const { control, lastChance } = work[at];
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      // 走哪一档由审阅表的 capabilities 决定,不由 `cacheable` 决定:
      // 共享档 = independent / sourceDependent 且 stateful;其余 stateful
      // (含 belowDependent 和 unknown)本地档;非 stateful 不产快照。
      // 本地档在这里只可能出现在显式传进来的 controls 上 —— 常规路径上
      // belowDependent / unknown 的快照由 C2 的整场景路(`renderLocalSnapshots`)产。
      // 没有共享键就没法寻址(手工构造的 control、以及还没接上键的调用方),不写快照。
      // pinned 渲染 9:不在预渲染集合里的卡走 `target = null` —— 不写快照、不更新
      // index.json、不发 `layer`。PNG 那一支(legacy 整帧通道与 `renderState` 的料)
      // 照旧,不然 `?preview=legacy` 会缺料。
      const tier = control.snapshotKey && this.prerenderPicked(entry, control.clipId)
        ? (control.tier || snapshotTier(control.capabilities)) : 'none';
      const entryKey = tier === 'local' ? entry.key : undefined;
      let target = tier === 'none' ? null : { tier, entryKey, key: control.snapshotKey };
      // C2:HTML 侧另有一条完整性判据 —— `index.json` 的 `count` 是**已有帧数**
      // (`snapshot-store.mjs` 的 `rangeCount`),完整 = `index.count === control.count`。
      // PNG 侧的 `hasComplete` 管不到它:同一趟里 PNG 可能齐了而快照缺一段。
      let index = target ? await this.snapshots().snapshotIndex(target) : { count: 0, frames: [], oversize: [] };
      let published = false;
      /*
       * 契约 F.3「不替锁定方产帧」:这张卡锁在别的环境上(键已是锁定方的,`index` 看的也是锁定方的键)。
       *   'reuse'    锁定方已齐:发它的层,HTML 这一支不产(`target` 当 null),PNG 那一支照旧;
       *   'defer'    锁定方还新鲜:放到末尾再判一次,仍新鲜就这一趟跳过;
       *   'takeover' 锁定方闲置且不齐:锁转给本机,同一内容键的 control 都换回自己的键,先用自己键
       *              现有的区间(可能为空)发层 —— 线上是整层换键,页面丢掉旧环境的帧 —— 再照常产。
       */
      if (target && tier === 'shared' && control.cardLock?.foreign === true && store && control.contentKey) {
        const ownFingerprint = control.ownEnvFingerprint ?? null;
        const complete = index.count + rangeCount(index.oversize) >= control.count;
        const decision = cardLockDecision({ lock: store.get(control.contentKey), ownFingerprint, complete, now: Date.now(), idleMs: this.cardLockIdleMs ?? CARD_LOCK_IDLE_MS });
        if (decision === 'defer') {
          if (!lastChance) {
            if (index.count) this.publishLayer(entry, control, tier, index.frames);
            work.push({ control, lastChance: true });
          } else skipped.push(control);
          continue;
        }
        if (decision === 'reuse') {
          if (index.count) this.publishLayer(entry, control, tier, index.frames);
          published = true;
          target = null;
        } else {
          if (decision === 'takeover' && ownFingerprint) store.takeover(control.contentKey, ownFingerprint, 'prerender');
          this.reapplyCardLocks(entry, controls);
          target = { tier, entryKey, key: control.snapshotKey };
          index = await this.snapshots().snapshotIndex(target);
          if (decision === 'takeover') {
            this.publishRelocked(entry, controls, control, index.frames);
            published = true;
          }
        }
      }
      // R6-14:超限被丢掉的帧算「已经处理过」—— 不然 `htmlComplete` 永远为 false,
      // 每一趟都把整张卡重渲一遍、再判一遍超限、再丢一遍。
      let htmlComplete = !target || index.count + rangeCount(index.oversize) >= control.count;
      /*
       * 契约 F.3「渲之前得锁」+ F.8 第 1 条「本机已有结果也得锁」:走到一个共享档卡就用本机指纹得锁,
       * 不管本机是不是已经齐了 —— 免得本机早已产齐、只是还没有锁文件的卡(锁库之前的缓存)被页面的
       * 测量帧抢走。得不到(页面刚抢先锁了)这张卡本趟不再写 HTML 快照,card plan 已按锁库重排。
       */
      if (target && tier === 'shared'
        && !this.acquireCardLock(entry, { tier, contentKey: control.contentKey, envFingerprint: control.ownEnvFingerprint ?? control.envFingerprint }, controls)) {
        target = null;
        htmlComplete = true;
      }
      if (target && index.count && !published) this.publishLayer(entry, control, tier, index.frames);
      if (htmlComplete && await entry.cardCache.hasComplete(control)) continue;
      const isolated = this.isolatedCardProject(entry.project, control);
      // A small batch retains Chrome state inside a stateful card, while every
      // batch boundary remains cancellable/schedulable.  `fullFrame` is vital:
      // the cache image is a full transparent stage, never a crop to be framed
      // again during composition.
      //
      // C4:批次边界是可调度点 —— 每批开始前读镜像插件的 `latestPlayhead().wanted`,
      // 含它的那一批先跑,再回到顺序批(`nextBatchStart`)。
      const pending = new Set();
      if (range) {
        // J.4:只跑覆盖 [from, to] 的那几批;批的起点仍按 4 帧对齐,和整张卡一趟渲时的批一模一样
        const last = Math.min(range.to, control.count - 1);
        for (let first = Math.max(0, range.from - (range.from % 4)); first <= last; first += 4) pending.add(first);
      } else for (let first = 0; first < control.count; first += 4) pending.add(first);
      const inRange = range ? n => n >= range.from && n <= range.to : () => true;
      /*
       * 队列细任务的一段(`range`)一趟顺推(`singlePass`,由 `renderCardSnapshotRange` 按 `queueSinglePass` 判):
       * 这一段原来要跑的那几批并成一批 —— 帧集合与逐批跑的并集相同,只换一次页、只从挂载帧回放一次。
       * 逐批时每批都要换一张新页(预渲染间重新取几百个模块)并从挂载帧回放到批首,一段 60 帧里换页占一半以上的时间
       * (`docs/archive/agent-reports/AGENT-uc-latency.md`)。顺推与逐批从头推对 DOM 卡像素相同(M7 探针 P2,
       * `docs/archive/agent-reports/AGENT-m7-probe.md`);canvas 卡不等价,不走这条(见 `queueSinglePass`)。
       * 入库照旧每 4 帧交一次(进度、发层的粒度不变)。
       */
      const oneBatch = !!(range && singlePass && pending.size > 1);
      if (timing) timing.singlePass = oneBatch;
      /*
       * 一批(或 `oneBatch` 的一整段)在给定的预渲染间上做完:换页、推帧、入库、发层。后台那一趟(`share`)时
       * Agent 专用实例空闲可以借走其中还没开工的批(`openCardBatchPool`),在它自己的预渲染间上跑同一个函数。
       */
      /** 一趟顺推在这一帧交完之后停下(给 Agent 让路);null = 没停 */
      let stoppedAfter = null;
      const runBatch = async (bkr, first, lastFirst, stop = null) => {
        const localFrames = Array.from({ length: Math.min(lastFirst + 4, control.count) - first }, (_, n) => first + n);
        // C2:帧集合收窄成**本卡缺的那些帧**(按该键 `index.json` 已有区间扣除)。
        // PNG 那一支照旧要全部帧(`targetFrames` 不动),只有生成快照这一支收窄。
        // R6-14:已经判过超限的那些帧也扣掉,不再白渲一遍
        const missing = target ? localFrames.filter(n => inRange(n) && !rangeHas(index.frames, n) && !rangeHas(index.oversize, n)) : [];
        const t0 = clock?.();
        const small0 = timing ? (this.smallStats.ms ?? 0) : 0;
        await bkr.reset(isolated, this.emptyUrl(isolated), { deferCards: true });
        await bkr.page.setViewport({ width: isolated.width, height: isolated.height, deviceScaleFactor: this.scaleForLane('background') });
        const t1 = clock?.();
        if (timing) { add('resetMs', t1 - t0); add('smallMs', (this.smallStats.ms ?? 0) - small0); timing.batches = (timing.batches ?? 0) + 1; timing.resetMaxMs = Math.max(timing.resetMaxMs ?? 0, t1 - t0); }
        const produced = [];
        // 每批(4 帧)交一次(不是每帧):写帧文件、判体积、并 index.json 由快照库一步做(#9)。
        // A3c:超限的帧照常落盘,但不进就绪索引、不投递(诊断记在快照库里);R6-14:帧号记进
        // `oversize`,下一趟跳过。一个键几千帧时,读-改-写一个小 JSON 也比不上批量摊薄。
        const commitProduced = async () => {
          if (!produced.length || signal?.aborted || !this.prerenderPicked(entry, control.clipId)) return;
          const c0 = clock?.();
          index = await this.snapshots().commitSnapshots({ ...target, clipId: control.clipId, capabilities: control.capabilities, items: produced.splice(0) });
          // C3:这一层的区间长了就发一条全量 `layer`
          if (index.written.length) this.publishLayer(entry, control, tier, index.frames);
          if (timing) add('commitMs', clock() - c0);
        };
        // 一趟顺推(`oneBatch`)时照旧每 4 帧交一次、报一次进度:截过图的帧攒够 4 帧就交(这一帧的快照在截图之前已经生成)
        const shotChunk = [];
        const flushChunk = async () => {
          await commitProduced();
          const frames = shotChunk.splice(0);
          if (frames.length && onBatch && !signal?.aborted) onBatch({ control, first: frames[0], frames, snapshotFrames: frames.filter(n => missing.includes(n)) });
          // 给 Agent 让路:交完这一块、后面还有帧时停下这一趟(下一帧开头就不再推了)
          if (stop && frames.length && frames[frames.length - 1] < localFrames[localFrames.length - 1] && shouldYield?.()) {
            stoppedAfter = frames[frames.length - 1];
            stop.abort();
          }
        };
        const bakeSignal = stop ? AbortSignal.any([signal, stop.signal].filter(Boolean)) : signal;
        let baked;
        try {
          baked = await bakeFrames(bkr, { out: path.join(this.root, 'controls', control.key), targetFrames: localFrames,
          snapshotOnly: false, fullFrame: true, writeFrames: false, signal: bakeSignal,
          snapshotFrames: new Set(missing),
          onFrame: async (frame, png) => {
            const put = await entry.cardCache.put(control.key, frame, png, () => !signal?.aborted);
            if (oneBatch) { shotChunk.push(frame); if (shotChunk.length >= 4) await flushChunk(); }
            return put;
          },
          // 隔离工程里目标片段是唯一可见输出,所以这一帧的 control 列表里认
          // `control.clipId` 那一条就是这张卡的子树。`data-pc-local-frame` 是卡片
          // 自己的本地帧,和隔离工程的帧号一致(片段被平移到了 -phase),但仍以
          // 快照结果里带的那个为准 —— 目录是按本地帧寻址的。
          onSnapshot: async (frame, html, items) => {
            if (!target || signal?.aborted || !this.prerenderPicked(entry, control.clipId)) return;
            const own = (items || []).find(item => item.id === control.clipId);
            if (!own || !Number.isInteger(own.frame)) return;
            produced.push({ localFrame: own.frame, html: own.html });
          } });
        } catch (error) {
          // 让路停下的这一趟:已交的块都在库里;停下那一刻之后没有再推过帧(取消只在两帧之间生效)
          if (stop?.signal.aborted && !signal?.aborted && stoppedAfter !== null) { produced.length = 0; shotChunk.length = 0; return; }
          throw error;
        }
        const t2 = clock?.();
        if (timing) { add('bakeMs', t2 - t1); add('advancedFrames', Number(baked?.advancedFrames) || 0); add('shotFrames', localFrames.length); }
        if (oneBatch) await flushChunk();
        else {
          await commitProduced();
          if (onBatch && !signal?.aborted) onBatch({ control, first, frames: localFrames, snapshotFrames: missing });
        }
      };
      // Agent 专用实例借走、还没做完的批(`share` 时才有):这张卡收尾(`finish`)之前要等它们
      const stolen = new Set();
      const pool = share && !range && !oneBatch ? this.openCardBatchPool({ control, pending, stolen, signal, runBatch }) : null;
      try {
        while (pending.size || stolen.size) {
          if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
          // 剩下的批都在 Agent 专用实例手里:等其中一批落定(借走的批出错会交还到 `pending`,这里接着做)
          if (!pending.size) { await Promise.race([...stolen].map(item => item.done)); continue; }
          // 批边界:有 Agent 任务在等这个实例就让它先做(只有队列细任务做在专用实例上时才有 `yieldPoint`)
          if (yieldPoint && shouldYield?.()) {
            const y0 = clock?.();
            await yieldPoint();
            if (timing) { add('yieldMs', clock() - y0); timing.yields = (timing.yields ?? 0) + 1; }
            if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
          }
          const first = oneBatch ? Math.min(...pending) : this.nextBatchStart(pending, control);
          const lastFirst = oneBatch ? Math.max(...pending) : first;
          const all = oneBatch ? [...pending] : null;
          if (oneBatch) pending.clear(); else pending.delete(first);
          stoppedAfter = null;
          await runBatch(bakery, first, lastFirst, oneBatch && yieldPoint ? new AbortController() : null);
          // 顺推停下来让路:没做的批(起点在停下那一帧之后)放回去,下一圈先让路再从它们接着顺推
          if (stoppedAfter !== null) for (const f of all) if (f > stoppedAfter) pending.add(f);
        }
      } finally {
        if (pool) this.closeCardBatchPool(pool);
        // 这一趟被掐了也等借走的批停下(它们看同一个 signal),免得收尾之后还有人往这张卡里写
        if (stolen.size) await Promise.allSettled([...stolen].map(item => item.done));
      }
      if (!signal?.aborted) {
        const f0 = clock?.();
        await entry.cardCache.finish(control);
        if (timing) add('finishMs', clock() - f0);
      }
    }
    // `fillCardControls` shares the background Chrome with the mandatory
    // complete-scene pass. Restore its normal project before snapshot/MOV.
    const r0 = clock?.();
    await bakery.reset(entry.project, this.emptyUrl(entry.project), { deferCards: true });
    await bakery.page.setViewport({ width: entry.project.width, height: entry.project.height, deviceScaleFactor: this.scaleForLane('background') });
    if (timing) add('restoreMs', clock() - r0);
    return skipped;
  }
  /**
   * 延后的卡再判一次(契约 F.8 第 2 条;`mechanism/rendering.md`:锁定方停下一段时间后本机接手)。
   *
   * 后台那一趟结束时仍有 `'defer'` 的卡(`controls`,按 `clipId` 记),就定一个一次性、`unref` 的计时器,
   * `cardLockIdleMs` 之后触发。触发时要同时满足:这一版的 `signal` 没 abort、还有会话的当前版本是这个
   * entry、这些卡仍在预渲染集合里 —— 才把一小趟排进 `this.background` 串行链:借 `'background'` 的
   * 预渲染间,只对这些卡跑 `fillCardControls`(同一个 `signal`)。重判时锁定方已齐就投递、已闲置就接手、
   * 仍新鲜就再排一次;同一版(同一个 entry)最多排 `CARD_LOCK_RETRY_MAX` 次,之后等下一版。
   *
   * 计时器在 `signal` abort(这一版被换掉)或 `close()` 时清掉,不会挂住进程。
   */
  scheduleCardLockRetry(entry, controls, signal) {
    const clipIds = [...new Set((controls ?? []).map(control => control?.clipId).filter(Boolean))];
    if (!clipIds.length || this.closed || signal?.aborted || !entry) return false;
    const state = (entry.cardLockRetry ||= { count: 0, timer: null });
    if (state.count >= CARD_LOCK_RETRY_MAX) return false;
    state.count++;
    if (state.timer) { clearTimeout(state.timer); this.cardLockTimers?.delete(state.timer); }
    const onAbort = () => {
      if (!state.timer) return;
      clearTimeout(state.timer);
      this.cardLockTimers?.delete(state.timer);
      state.timer = null;
    };
    const timer = setTimeout(() => {
      this.cardLockTimers?.delete(timer);
      if (state.timer === timer) state.timer = null;
      signal?.removeEventListener?.('abort', onAbort);
      this.retryDeferredCards(entry, clipIds, signal);
    }, this.cardLockIdleMs ?? CARD_LOCK_IDLE_MS);
    timer.unref?.();
    state.timer = timer;
    this.cardLockTimers?.add(timer);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    return true;
  }
  /** 计时器触发:三条都满足才排那一小趟(见 `scheduleCardLockRetry`)。回排进去的那一趟的 Promise,没排回 null */
  retryDeferredCards(entry, clipIds, signal) {
    if (this.closed || signal?.aborted) return null;
    if (!this.ready.sessionsOn(entry.key).length) return null;
    const wanted = new Set(clipIds);
    const pick = () => (entry.cardPlan ?? []).filter(control => wanted.has(control?.clipId) && control.cacheable && this.prerenderPicked(entry, control.clipId));
    if (!pick().length) return null;
    const pass = this.background.catch(() => {}).then(async () => {
      if (this.closed || signal?.aborted) return;
      // 排队期间 card plan 可能重算过(新对象):按 clipId 从当前的 plan 里重取
      const controls = pick();
      if (!controls.length) return;
      let bakery, skipped = controls;
      try {
        bakery = await this.acquire('background', entry.project);
        skipped = await this.fillCardControls(entry, bakery, signal, controls);
      } catch {
        // 让路给播放、借不到预渲染间:这些卡仍待判,照样再排(计数照算)
        if (signal?.aborted) return;
      } finally {
        if (bakery && this.lanes.get('background')?.bakery === bakery) this.release('background');
      }
      if (skipped?.length) this.scheduleCardLockRetry(entry, skipped, signal);
    });
    this.background = pass;
    return pass;
  }
  /**
   * 页面测量时推过的帧存成共享快照(契约 F.3;语义 `mechanism/rendering.md`「预渲染结果的复用」)。
   * 路由 `PUT /api/frames/snapshot` 的全部判断在这里。`control` 是 entry 的 card plan 里那一项,
   * 路由已经确认它是审阅表 `independent` 的共享档卡。按顺序:
   *
   *   1. 等锁库读完;
   *   2. 页面指纹不是 16 位小写十六进制 → `ENV_MISSING`,不写;
   *   3. 按页面指纹得锁,得不到(锁在别的环境上)→ `CARD_LOCKED`,带 `lockedBy`;
   *   4. 写在页面自己的键 `resultKeyOf(contentKey, 页面指纹)` 下;一帧都没进索引(超限)→ `OVER_LIMIT`;
   *   5. card plan 按锁库重排(这张卡换成页面的键),发层;
   *   6. 回 `{ ok, stored, indexed, count, envFingerprint, key }`。
   *
   * 页面指纹恰好和本机预渲染的相同时,第 3 步同指纹得锁,第 4 步的键就是本机自己的键,两边的结果合在一起。
   */
  async acceptMeasuredSnapshot(entry, control, { envFingerprint, localFrame, html } = {}) {
    await this.ensureCardLocks();
    if (typeof envFingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(envFingerprint)) return { ok: true, stored: false, reason: 'ENV_MISSING' };
    const contentKey = control?.contentKey;
    // 没有内容键就没有锁键,也算不出页面的键(card plan 的旧形状);不存,由预渲染进程自己产
    if (typeof contentKey !== 'string' || !/^[0-9a-f]{64}$/.test(contentKey) || !this.cardLockStore) return { ok: true, stored: false, reason: 'NO_CONTENT_KEY' };
    const { granted, lock } = this.cardLockStore.acquire(contentKey, envFingerprint, 'page');
    if (!granted) return { ok: true, stored: false, reason: 'CARD_LOCKED', lockedBy: lock?.envFingerprint ?? null };
    const key = resultKeyOf(contentKey, envFingerprint);
    const index = await this.snapshots().commitSnapshots({ tier: 'shared', key, clipId: control.clipId, capabilities: control.capabilities,
      items: [{ localFrame, html }] });
    if (!index.written.length) return { ok: true, stored: true, indexed: false, reason: 'OVER_LIMIT', envFingerprint, key };
    this.reapplyCardLocks(entry);
    this.publishLayer(entry, { clipId: control.clipId, snapshotKey: key }, 'shared', index.frames);
    // 同一内容键的别的片段(同一张卡摆了几次)也锁到了页面上,它们的层一起换成页面的键
    for (const item of entry?.cardPlan ?? []) {
      if (item?.clipId && item.clipId !== control.clipId && item.contentKey === contentKey && item.snapshotKey === key && this.prerenderPicked(entry, item.clipId)) {
        this.publishLayer(entry, item, 'shared', index.frames);
      }
    }
    return { ok: true, stored: true, indexed: true, count: index.count, envFingerprint, key };
  }
  /**
   * 队列执行器的 `plan`(契约 J.4,设计附件第 2 节)。`project` 已经过 `renderProject`,和 `/preload` 路由对
   * 镜像做的是同一件事,所以同一份 JSON 算出同一个 `entry.key`。
   *
   *   1. `entry = this.entry(project)`;
   *   2. 在 `'queue'` lane 上开预渲染间、取浏览器的卡片计划(`browserCardPlan`,不需要页面会话);
   *   3. `entry.cardPlan` 还不是数组时 `recordCardPlan`(不调 `adoptCardPlan`:它会去认领会话);
   *   4. 按本机锁库给共享档卡定 `cardLocks` / `takeover`(`cardLockDecision`):`reuse` / `defer` 照锁定方的指纹
   *      出键;`takeover` 先在本机锁库里接手(同 `fillCardControls` 的做法,同一内容键的片段一起换键发层),
   *      再让切分按本机指纹出键、任务带 `takeover`;
   *   5. 只留 `queueHandles` 的卡,补上里面的卡 `cardId` / `cardIds`(`split.mjs` 的 `withInnerCards`:卡片计划里的 control
   *      只有 `nodeId`;片段挂了强调、滤镜时输出节点是外面那一层,要顺着输入找到里面那张卡);
   *   6. 轨道流(M6c X1):本机能产流(`queueStreamSpecs`:开关开着、探到编码器)时按这一版算出全部流,
   *      放进 `context.streams`(`splitPlan` 按它切流任务);否则为空,与 M5b 相同。
   *
   * 回 `{ entry, context, streamSpecs }`,`context` 就是交给 `splitPlan` 的 PlanContext;`streamSpecs` 是
   * `planStreams` 的完整结果(执行器按它把流任务对回这一版的流)。
   */
  async planForQueue(project, { signal } = {}) {
    const entry = await this.entry(project);
    const browserPlan = await this.runQueueTask(async lease => {
      const bakery = await lease(entry.project);
      if (signal?.aborted) throw Object.assign(new Error('Queue task cancelled'), { cancelled: true });
      return this.browserCardPlan(bakery);
    }, signal);
    if (!browserPlan) throw Object.assign(new Error('预渲染间没有给出卡片计划(window.__pcCardPlan)'), { code: 'no-card-plan', retryable: true });
    await this.ensureCardLocks();
    if (!Array.isArray(entry.cardPlan)) {
      let plan;
      try { plan = entry.cardCache.plan(browserPlan); }
      catch (error) { throw Object.assign(new Error(`算不出卡片计划:${error?.message || error}`), { code: 'no-card-plan', retryable: true }); }
      this.recordCardPlan(entry, plan);
    }
    // 锁可能在 card plan 记下之后变过(页面刚存了测量帧):按锁库重排一遍
    this.reapplyCardLocks(entry);
    const fps = Number(entry.project.fps) || 30;
    const count = Math.max(1, Math.floor(Number(entry.project.duration) * fps));
    const graph = browserPlan?.graph || browserPlan;
    const sourceVersions = browserPlan?.sourceVersions ?? {};
    const store = this.cardLockStore;
    const own = this.envFingerprint;
    const cardLocks = new Map();
    const takeover = new Set();
    for (const control of entry.cardPlan) {
      if (!this.queueHandles(control) || !this.prerenderPicked(entry, control.clipId)) continue;
      if ((control.tier || snapshotTier(control.capabilities)) !== 'shared' || !control.contentKey || !store) continue;
      const lock = store.get(control.contentKey);
      const ownFingerprint = control.ownEnvFingerprint ?? own;
      if (!lock || lock.envFingerprint === ownFingerprint) continue;
      const lockKey = `snapshot:${control.contentKey}`;
      const foreign = await this.snapshots().snapshotIndex({ tier: 'shared', key: resultKeyOf(control.contentKey, lock.envFingerprint) });
      const complete = foreign.count + rangeCount(foreign.oversize) >= control.count;
      const decision = cardLockDecision({ lock, ownFingerprint, complete, now: Date.now(), idleMs: this.cardLockIdleMs ?? CARD_LOCK_IDLE_MS });
      // 队列那边的锁多半也在锁定方身上:照它的指纹出键,或带 `takeover` 按本机指纹出键(契约 F.2)
      cardLocks.set(lockKey, lock.envFingerprint);
      if (decision !== 'takeover' || !ownFingerprint) continue;
      store.takeover(control.contentKey, ownFingerprint, 'prerender');
      this.reapplyCardLocks(entry);
      const index = await this.snapshots().snapshotIndex({ tier: 'shared', key: control.snapshotKey });
      this.publishRelocked(entry, null, control, index.frames);
      takeover.add(lockKey);
    }
    const cardPlan = withInnerCards(entry.cardPlan.filter(control => this.queueHandles(control)), graph);
    const clips = (entry.project.tracks || []).flatMap(track => track.clips || []);
    // 任务书「甲二」:先查,没有才产。这一版的单卡流别的环境已经有整条的(在线页面在没有切分节点时自己产的),先拉回本机、记锁;
    // 下面的流计划与切分都照锁出键:这条流只照那个指纹出一份,本机不出自己的那一份、不重产
    if (this.pushQueue) { try { await this.adoptForeignStreams(entry, this.pushQueue.content, this.pushQueue.client, { signal }); } catch {} }
    for (const [contentKey, fingerprint] of this.streamLocks) cardLocks.set(`stream:${contentKey}`, fingerprint);
    const streamSpecs = await this.queueStreamSpecs(entry);
    const ownListStreams = await this.streamCapable();
    const context = {
      entryKey: entry.key,
      // 普通计划只切本机判重的卡;预渲染重试进集合的片段只由预渲染重试计划任务切(标 backfill,排在本机判重的任务之后,c10a 契约第 17 节)
      prerenderSet: entry.basePrerenderSet instanceof Set ? new Set(entry.basePrerenderSet)
        : entry.prerenderSet instanceof Set ? new Set(entry.prerenderSet) : undefined,
      cardPlan,
      // 每条流连同它的形状(`queueStreamOf`):切分给浏览器出单卡流那一份时要(browser-stream-task.md 第一处)
      streams: streamSpecs.map(queueStreamOf),
      // 在线页面的清单计划用(`local-node.mjs` 的 `listPlanOverrides`):按清单里的片段算流。浏览器那一份不看本机判没判重、
      // 本机能不能产流(`queueStreamSpecs` 那两道闸只管切分方自己产的那一份)
      browserStreamsFor: clips => this.listStreamSpecs(entry, clips).map(queueStreamOf),
      // 只为导出的清单计划用(`local-node.mjs` 的 `listPlanOverrides`):清单里每个片段的导出位图怎么出、哪些出不了
      exportStreamsFor: (clips, salt) => { const { specs, unsupported } = this.exportStreamSpecs(entry, clips, salt); return { streams: specs.map(exportStreamOf), unsupported }; },
      // 任务书「甲三」:清单计划里切分方自己的那一份出不出,看本机此刻能不能产流(有生产者、开关开着、探到了编码器 ——
      // 与 `node.hello` 报的 `capabilities.streams` 同一个判据)。托管方的渲染节点另看这个项目的「生成轨道流」(执行器按项目再收一道)。
      // 本机判没判重不看:清单是发布方判的,流任务回来时执行器按清单里的片段把它对回这一版(`prerender-executor.mjs` 的 `matchStream`)
      ownListStreams,
      anchorFrames: anchorFrames(clips, fps).filter(frame => frame >= 0 && frame < count),
      // c66-host-cards:全局代码版本(`frameCode`)不再覆盖用户卡与改动层;这一版用到的定制卡的代码身份
      // 由切分写进 requires.cardSources(共享档只写这张卡的,本地档、流写全部),节点手里没有这份代码就不认领
      cardSourceVersions: { ...(entry.cardSources ?? {}) },
      // 流任务（单卡流、依赖下层的流、导出位图）只要这条流展开出的子集里用到的那几份代码（0.7.19：键与要求都按子集算；
      // `render-node/expand.mjs` 的 `streamNeed` / `subsetCardSources`，产流的节点按同一个子集建隔离工程）
      streamCardSources: stream => subsetCardSources(entry.project, streamNeed(stream), entry.cardSources ?? {}),
      weightOf: control => ({ class: this.queueWeightClass(control), estMs: null }),
      // 片段里面任何一张是用户卡就算(挂了强调、滤镜的片段看里面那张);里面拿不准时,这一版有用户卡就算
      isUserCard: control => isUserCardControl(control, sourceVersions),
      isGraphCard: control => this.isGraphCardControl(control),
      cardLocks,
      takeover,
    };
    return { entry, context, streamSpecs };
  }
  /**
   * M6c X1:这一版里要经队列产的轨道流(`planStreams` 的完整结果,与 `StreamProducer.update` 同一种算法、
   * 同一组参数,所以流键相同)。本机没有生产者(`interactive: false`)、开关关着(`PROMPTCUT_STREAMS=0`)、
   * 或探不到编码器(`capable()`)时回 `[]` —— 这时不发布流任务,行为与 M5b 相同。
   */
  async queueStreamSpecs(entry) {
    const producer = this.streamProducer();
    if (!producer?.enabled || !(await producer.capable())) return [];
    try {
      return planStreams(entry, { picked: clipId => this.streamPicked(entry, clipId), budget: producer.budget,
        codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: this.envFingerprint });
    } catch {
      return [];
    }
  }
  /**
   * 清单计划里的片段各自的流(与 `queueStreamSpecs` 同一组参数,所以单卡流的内容键相同);算不出回 `[]`。
   * 切分时用(`planForQueue` 的 `browserStreamsFor`),流任务回来时执行器也用它把任务对回这一版:清单计划里切分方自己的那一份只出单卡流
   * 和依赖下层的流(`local-node.mjs` 的 `listPlanOverrides`),这两种流的内容键与清单里还有哪些片段无关,所以只给一个片段也算得出同一条流。
   */
  listStreamSpecs(entry, clips) {
    try {
      return planListStreams(entry, clips, { budget: this.streamProducer()?.budget ?? streamDecoderBudget(),
        codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: this.envFingerprint });
    } catch {
      return [];
    }
  }
  /**
   * 导出专用的逐帧位图(`export-frames.mjs`;在线浏览器导出时本页不执行的卡的画面):清单里每个片段各算一条流的计划
   * (与 `listStreamSpecs` 同一组参数,所以内容键和这张卡的轨道流相同),不按解码器预算合并 —— 一张卡一份。
   * 平面的独立卡、源依赖卡、三维外框的卡出单卡流的形状(包裹层坐标),依赖下层的卡出依赖下层的流的形状(舞台坐标,差分取层)。
   * 回 `{ specs, unsupported }`:`specs` 是 `exportSpecOf` 的结果(另带这一版项目的输入签名 `inputSig`);
   * `unsupported` 是出不了的片段和原因 —— `no-card`(这一版的卡片计划里没有它:节点手里没有这张卡的代码,或片段已经不在)、
   * `no-stream`(这张卡没有任何一种流的形状,例如依赖下层又带三维外框)。本机还没有环境指纹时全部算 `no-fingerprint`。
   */
  exportStreamSpecs(entry, clips, salt = '') {
    const wanted = [...new Set((Array.isArray(clips) ? clips : [...(clips ?? [])]).filter(id => typeof id === 'string' && id))];
    const own = this.envFingerprint;
    if (!own) return { specs: [], unsupported: wanted.map(clipId => ({ clipId, reason: 'no-fingerprint' })) };
    const listed = new Set(wanted);
    let planned = [];
    try {
      planned = planStreams(entry, { picked: clipId => listed.has(clipId), budget: Infinity,
        codeVersion: `${STREAM_CODE_VERSION}:${this.captureCode?.() || ''}`, envFingerprint: own });
    } catch { planned = []; }
    const controls = new Set((entry?.cardPlan ?? []).map(control => control?.clipId));
    const specs = [], unsupported = [];
    for (const clipId of wanted) {
      const hit = planned.find(spec => Array.isArray(spec?.clipIds) && spec.clipIds.length === 1 && spec.clipIds[0] === clipId);
      let inputSig = null;
      try { inputSig = hit ? streamInputSig(entry.project, { clipIds: [clipId], kind: hit.kind }) : null; } catch { inputSig = null; }
      const spec = hit ? exportSpecOf({ ...hit, ...(inputSig ? { inputSig } : {}) }, own, salt) : null;
      if (spec) specs.push(spec);
      else unsupported.push({ clipId, reason: controls.has(clipId) ? 'no-stream' : 'no-card' });
    }
    return { specs, unsupported };
  }
  /**
   * 导出位图任务的一段(`[from, to]` 是分段号):逐帧取、存成 PNG 落在 `<库根>/export-frames/<结果键>/`(`storeExportFrame`),
   * 由产物库那一侧推素材服务、写清单、删本机的帧(`createExportFramesSink`)。回 `null`。
   */
  async renderExportFrames(entry, spec, range, { signal, progress } = {}) {
    const producer = this.streamProducer();
    if (!producer) throw Object.assign(new Error('这个预渲染实例没有轨道流生产者,取不了导出位图'), { code: 'no-stream-producer', retryable: false });
    await producer.produceExportRange(entry, spec, range, { signal, progress,
      onFrame: async (frame, shot) => { await storeExportFrame(this.root, spec.exportResultKey, frame, shotToPng(shot)); } });
    return null;
  }
  /**
   * M6c X1:本机节点 `node.hello` 的 `capabilities.streams`:有生产者、开关开着、探到了编码器才是 true
   * (一次进程只探一次)。编辑器进程(`interactive: false`)没有生产者,回 false。
   */
  async streamCapable() {
    const producer = this.streamProducer();
    return !!producer && producer.enabled === true && (await producer.capable()) === true;
  }
  /**
   * M6c X1:流任务的一段(`[from, to]` 是分段号):交给轨道流生产者按段产出(`StreamProducer.produceRange`),
   * 每个分段落盘、发层之后才回。回 `null`:产物在流库里,sink 自己读(`collectStreamResult`)。
   */
  async renderStreamRange(entry, spec, range, { signal, progress, density = null } = {}) {
    const producer = this.streamProducer();
    if (!producer) throw Object.assign(new Error('这个预渲染实例没有轨道流生产者'), { code: 'no-stream-producer', retryable: false });
    await producer.produceRange(entry, spec, range, { signal, progress, density });
    return null;
  }
  /** 细任务的重度(附件第 2 节):`canvasHeavy`、`belowDependent`、`context`、`unknown`、本地档记 `heavy`,其余 `medium` */
  queueWeightClass(control) {
    const caps = control?.capabilities ?? {};
    const compositing = control?.compositing ?? caps.compositing;
    if (control?.tier === 'local' || caps.canvasHeavy === true || control?.innerCanvasHeavy === true || compositing === 'belowDependent' || compositing === 'context' || compositing === 'unknown') return 'heavy';
    return 'medium';
  }
  /**
   * 共享档快照任务的一段(契约 J.4,附件第 3 节):在 `'queue'` lane 上对这一张卡跑 `fillCardControls`,
   * 只跑覆盖 `range` 的批。`control` 是 `entry.cardPlan` 里的那一项(锁的状态记在它身上)。
   * 这张卡被别的环境锁住(开工前或渲的途中被页面抢了锁)抛 `card-locked-local`(不可重试)。
   * `progress(done)` 报这一段里已经交过的本地帧数。回 `null`:产物在帧库里,sink 自己读。
   */
  /**
   * 队列细任务的一段能不能一趟顺推(`fillCardControls` 的 `singlePass`,`docs/archive/agent-reports/AGENT-uc-latency.md`):
   *   - `PROMPTCUT_QUEUE_SINGLE_PASS=0`、或实例上 `queueSinglePassOff = true`(对照探针用)时不走;
   *   - canvas 重卡(审阅表 `canvasHeavy`)不走:异步装载的画布卡顺推与逐批从头推不等价(M7 探针 P2);
   *   - 页面报的播放头正要这张卡在这一段里的帧(C4 `wanted`)时照逐批跑,含播放头的那一批先出。
   */
  queueSinglePass(control, range) {
    if (this.queueSinglePassOff === true || process.env.PROMPTCUT_QUEUE_SINGLE_PASS === '0') return false;
    if (!range || control?.capabilities?.canvasHeavy === true) return false;
    const firstFrame = Number(control?.sampling?.firstFrame) || 0;
    for (const item of this.playheadWanted()) {
      if (item?.clipId !== control?.clipId) continue;
      const local = Number(item.frame) - firstFrame;
      if (Number.isInteger(local) && local >= range.from - (range.from % 4) && local <= range.to) return false;
    }
    return true;
  }
  /** `heartbeat`:专用实例给 Agent 让路期间定时调(执行器的阶段回调 → 会话的工作计数,租约不被当成停滞) */
  async renderCardSnapshotRange(entry, control, range, { signal, progress, timing = null, heartbeat = null } = {}) {
    const locked = () => Object.assign(new Error(`片段 ${control.clipId} 这张卡锁在别的环境上`), { code: 'card-locked-local', retryable: false });
    if (control.cardLock?.foreign === true) throw locked();
    let done = 0;
    // 诊断(不改行为):`timing` 给了就记各步用时(排队等 lane、借预渲染间、推帧各项、收尾画小尺寸)
    const queuedAt = Date.now();
    await this.runQueueTask(async (lease, ctx) => {
      if (timing) timing.laneWaitMs = Date.now() - queuedAt;
      if (timing && ctx?.worker) timing.worker = ctx.worker;
      // c10a 第 9 节:这一段里已有原尺寸、缺小尺寸的帧先记下,借出预渲染间的换页、各批的换页会把它们画掉
      try { await this.scheduleMissingSmall(entry, control, range); } catch { /* 读不了帧库:完成条件那一关会拦下 */ }
      const l0 = Date.now();
      const bakery = await lease(entry.project);
      if (timing) timing.leaseMs = Date.now() - l0;
      await this.fillCardControls(entry, bakery, signal, [control], {
        range,
        timing,
        singlePass: this.queueSinglePass(control, range),
        ...(ctx?.worker === 'agent' ? { shouldYield: ctx.shouldYield, yieldPoint: () => ctx.yieldPoint({ heartbeat }) } : {}),
        onBatch: ({ frames }) => {
          done += frames.filter(n => n >= range.from && n <= range.to).length;
          try { progress?.(done); } catch { /* 进度回调出错不影响渲染 */ }
        },
      });
      const s0 = Date.now();
      if (!signal?.aborted) await this.flushPendingSmall(bakery, entry.project);
      if (timing) timing.flushSmallMs = Date.now() - s0;
    }, signal, { tag: `card:${control.key}` });
    if (signal?.aborted) throw Object.assign(new Error('Queue task cancelled'), { cancelled: true });
    if (control.cardLock?.foreign === true) throw locked();
    return null;
  }
  /**
   * 本地档快照任务的一段(契约 J.4,附件第 3 节):本地帧换成全局帧,照 `missingSnapshotFrames` 的条件挑出
   * 这张卡在这一段里缺的帧,交给 `renderLocalSnapshots`(一趟整场景服务该帧上的全部本地档卡)。回 `null`。
   */
  async renderSceneSnapshotRange(entry, control, range, { signal, progress, heartbeat = null } = {}) {
    const fps = Number(entry.project.fps) || 30;
    const index = await this.snapshots().snapshotIndex({ tier: 'local', entryKey: entry.key, key: control.snapshotKey });
    const frames = [];
    for (let local = range.from; local <= range.to && local < control.count; local++) {
      if (rangeHas(index.frames, local) || rangeHas(index.oversize, local)) continue;
      const global = local + control.sampling.firstFrame;
      if (global / fps >= control.end - 1e-9) break;
      frames.push(global);
    }
    // c10a 第 9 节:已有原尺寸、缺小尺寸的帧也要在这一趟补上(见 `scheduleMissingSmall`)
    let missingSmall = 0;
    try { missingSmall = await this.scheduleMissingSmall(entry, control, range); } catch { /* 完成条件那一关会拦下 */ }
    if (frames.length || missingSmall) {
      await this.runQueueTask(async (lease, ctx) => {
        let bakery = await lease(entry.project);
        // 做在 Agent 专用实例上时每 4 帧问一次要不要让路(AGENT-maint-3):停下、让 Agent 先做,再把页面按这一版重置,
        // 从没做的帧接着做(`renderLocalSnapshots` 本来就收任意帧集合,中途起步从挂载帧回放)
        const yielding = ctx?.worker === 'agent' ? ctx : null;
        let rest = frames;
        while (rest.length) {
          const stopped = await this.renderLocalSnapshots(entry, rest, bakery, signal, yielding ? { shouldStop: ctx.shouldYield } : undefined);
          if (stopped == null || signal?.aborted) break;
          rest = rest.filter(n => n > stopped);
          if (!rest.length) break;
          await yielding.yieldPoint({ heartbeat });
          bakery = await lease(entry.project);
        }
        if (!signal?.aborted) await this.flushPendingSmall(bakery, entry.project);
      }, signal, { tag: `scene:${entry.key}` });
    }
    if (signal?.aborted) throw Object.assign(new Error('Queue task cancelled'), { cancelled: true });
    try { progress?.(range.to - range.from + 1); } catch { /* 同上 */ }
    return null;
  }
  /**
   * 连不上文档服务(契约 J.5「中途连不上文档服务」):队列模式的 entry 一律退回本机自己产。
   * 这些 entry 的后台代次掐掉重排(`adopt: false`,不动会话版本);已经跑完的那一趟也要重排 ——
   * 它跳过了快照那几步。重排的这一趟 B 趟因为整帧 HTML 已齐会跳过,快照由 `fillCardControls` /
   * `renderLocalSnapshots` 补。没有会话停在这一版上的不重排。回重排了几个。
   */
  /**
   * M6c X1 的空档(集成裁定):队列模式下本机的流归队列产(`StreamProducer.queueOwned`),流任务由切分 plan 的
   * 节点按它自己的能力切出。切分方关着流(或探不到编码器)时这一版一个流任务都没有,本机的流就没人产了。
   * 发布方看到自己那个 plan 的 `task.done` 里没有流任务时调这里:把这一版(`entryKey`)的流交还本机自动生产
   * (不经队列),快照照旧走队列。本机自己不能产流时什么都不做。回交还了几个 entry(0 或 1)。
   */
  releaseQueueStreams(entryKey) {
    const entry = this.entries.get(entryKey);
    if (!entry || entry.queueSnapshots !== true || entry.queueStreamsLocal === true) return 0;
    const producer = this.streamProducer();
    if (!producer?.enabled) return 0;
    entry.queueStreamsLocal = true;
    producer.kick();
    return 1;
  }
  leaveQueueMode() {
    const rerun = [];
    for (const [owner, generation] of this.generations) {
      const entry = this.entries.get(generation.key);
      if (entry?.queueSnapshots !== true) continue;
      generation.controller.abort();
      rerun.push([owner, entry]);
    }
    for (const entry of this.entries.values()) if (entry.queueSnapshots === true) entry.queueSnapshots = false;
    let count = 0;
    if (!this.closed) for (const [owner, entry] of rerun) {
      if (!this.ready.sessionsOn(entry.key).length) continue;
      void this.preload(entry.project, { adopt: false, owner }).catch(() => {});
      count++;
    }
    return count;
  }
  /** 隔离单卡工程:与在线页面的纯浏览器节点共用 `src/kernel/isolatedCard.mjs`(M7 契约第 4.3 节),行为不变 */
  isolatedCardProject(project, control) {
    return isolatedCardProject(project, control);
  }
  prefixes(entry) {
    const prefixes = trackPrefixes(entry.project, entry.code);
    if (!prefixes.length) prefixes.push({ key: entry.key, trackIds: [] });
    return prefixes;
  }
  async rasterPrefix(entry, bakery, frame, i, prefixes) {
    const prefix = prefixes[i];
    const dir = path.join(this.root, 'tracks', prefix.key);
    const file = path.join(dir, pad(frame) + '.png');
    try { return await fs.readFile(file); } catch {}
    // A lower cumulative track is a single lossless bitmap under the upper HTML.
    const base = i ? await fs.readFile(path.join(this.root, 'tracks', prefixes[i - 1].key, `${pad(frame)}.png`)) : null;
    const html = await bakery.page.evaluate(({ html, ids, base }) => {
      const template = document.createElement('template'); template.innerHTML = html;
      const tracks = [...template.content.querySelectorAll('[data-pc-track]')];
      for (const track of tracks) if (!ids.includes(track.getAttribute('data-pc-track'))) track.remove();
      if (base) {
        const img = document.createElement('img'); img.src = 'data:image/png;base64,' + base;
        img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
        template.content.firstElementChild.prepend(img);
      }
      return template.innerHTML;
    }, { html: entry.html.get(frame), ids: i ? [prefix.trackId] : prefix.trackIds, base: base?.toString('base64') || null });
    const buf = await captureSnapshot(bakery, html);
    await atomic(path.join(dir, `${pad(frame)}.png`), buf);
    return buf;
  }
  /**
   * D4(b) `/api/cards/layout`:Agent 的 `get_layout` —— **整场景**在 t 时刻的实体框,跑在预渲染进程
   * (pinned 架构 4:Agent 的 query 走预渲染,用户交互的 query 走自己的离屏舞台)。
   *
   * 一次请求只渲**一遍**,和问了几个 clipId 无关:`entry.html` 有这一帧就直接拿它,没有就
   * `bakeFrames` 出这一帧并 `record`(下次就命中)。**MOV/PNG 命中不能短路** —— 实体框要 DOM,
   * 像素答不了;所以只看 `entry.html`,不看 `entry.mov`。
   *
   * 量法:把快照 HTML 注进 `#pc-frame-snapshot`(和 `rasterPrefix` 同一条 `captureSnapshot` 路),
   * 在 `document.fonts.ready` 之后、`prepareFrameMedia` 之前对 `#pc-frame-snapshot [data-pc-scene]`
   * 调 `window.__pcSolid.rectsWithBounds({ pixels: 'none' })` —— 快照里 canvas 已经换成
   * 带 `data-pc-painted-box` 的 `<img>`,所以不用(也不能)读像素。`screenshot: false` 让这一趟
   * 不白付一张 1080p PNG。
   *
   * agent 车道串行:经 `runAgentTask` 和 `see_frames` 的 agent 批、`entityRects`、DOM 查询排同一条队(#12)。
   */
  async layout(project, options = {}) {
    return this.runAgentTask(lease => this.layoutNow(project, options, lease));
  }
  /** `lease` 缺省时自己 `acquire` / `release`;经 `layout` 进来时由 `runAgentTask` 借还 */
  async layoutNow(project, { t = 0, clipIds = null, signal } = {}, lease = null) {
    const lane = 'agent';
    const entry = await this.entry(project);
    const fps = Number(entry.project.fps) > 0 ? entry.project.fps : 30;
    const max = Math.max(0, Math.floor((Number(entry.project.duration) || 0) * fps) - 1);
    const frame = Math.max(0, Math.min(max, Math.round((Number(t) || 0) * fps)));
    const at = frame / fps;
    const { cardIds } = layoutClips(entry.project, clipIds, null, at);
    let baked = false;
    let measured = [];
    // 只问素材段(或问的片段一个都不存在)时不用开浏览器:它们的框全由项目数据决定
    if (!cardIds.length) {
      const { stage, clips } = layoutClips(entry.project, clipIds, [], at);
      return { stage, t: at, frame, clips, baked };
    }
    const bakery = await (lease ? lease(entry.project) : this.acquire(lane, entry.project));
    try {
      if (!entry.html?.has?.(frame)) {
        baked = true;
        await bakeFrames(bakery, {
          out: entry.dir, targetFrames: [frame], snapshotOnly: true, writeFrames: false,
          snapshotFrames: new Set([frame]), signal,
          onSnapshot: (n, html, controls) => { if (n === frame) this.record(entry, n, html, controls); },
        });
        await this.save(entry);
      }
      const html = entry.html?.get?.(frame);
      if (typeof html !== 'string' || !html) throw new Error(`第 ${frame} 帧没有生成的快照，量不到实体框`);
      measured = await captureSnapshot(bakery, html, undefined, {
        screenshot: false,
        afterFonts: page => page.evaluate(ids => {
          const root = document.querySelector('#pc-frame-snapshot [data-pc-scene]');
          if (!root || typeof window.__pcSolid?.rectsWithBounds !== 'function') return [];
          return window.__pcSolid.rectsWithBounds(root, { pixels: 'none', ...(ids ? { clipIds: ids } : null) });
        }, cardIds.length ? cardIds : null),
      }) || [];
    } finally { if (!lease) this.release(lane); }
    const { stage, clips } = layoutClips(entry.project, clipIds, measured, at);
    return { stage, t: at, frame, clips, baked };
  }
  /**
   * D3:`see_frames` 渲出来的那几帧各附一份实体矩形(`measureEntityRects`)。回 `Map<帧号, 矩形数组 | null>`。
   *
   * 和 `layoutNow` 同一个道理:像素命中(MOV / PNG)答不了实体框,只看 `entry.html`。`see_frames`
   * 刚渲过的帧多半已经 `record` 进去了(MOV 那一趟边推边记快照),直接注回去量;没有的一次
   * `bakeFrames` 补齐(只生成快照、不产 PNG)。每帧只注一次快照、`screenshot: false`,不装素材。
   * 经 `runAgentTask` 走 agent 车道的同一条队(#12)。
   */
  async entityRects(project, times, options = {}) {
    return this.runAgentTask(lease => this.entityRectsNow(project, times, options, lease));
  }
  async entityRectsNow(project, times, { signal } = {}, lease = null) {
    const lane = 'agent';
    const entry = await this.entry(project);
    const fps = Number(entry.project.fps) > 0 ? entry.project.fps : 30;
    const max = Math.max(0, Math.floor((Number(entry.project.duration) || 0) * fps) - 1);
    const frames = [...new Set(times.map(t => Math.max(0, Math.min(max, Math.round((Number(t) || 0) * fps)))))].sort((a, b) => a - b);
    const out = new Map();
    if (!frames.length) return out;
    const bakery = await (lease ? lease(entry.project) : this.acquire(lane, entry.project));
    try {
      const missing = frames.filter(frame => !entry.html?.has?.(frame));
      if (missing.length) {
        const wanted = new Set(missing);
        await bakeFrames(bakery, {
          out: entry.dir, targetFrames: missing, snapshotOnly: true, writeFrames: false,
          snapshotFrames: wanted, signal,
          onSnapshot: (n, html, controls) => { if (wanted.has(n) && !entry.html.has(n)) this.record(entry, n, html, controls); },
        });
        await this.save(entry);
      }
      for (const frame of frames) {
        if (signal?.aborted) throw Object.assign(new Error('Frame request cancelled'), { cancelled: true });
        const html = entry.html?.get?.(frame);
        out.set(frame, typeof html === 'string' && html
          ? (await captureSnapshot(bakery, html, undefined, { screenshot: false, afterFonts: measureEntityRects })) ?? null
          : null);
      }
    } finally { if (!lease) this.release(lane); }
    return out;
  }
  /**
   * 后台那一趟的最后一步:按轨道前缀逐帧栅格化(`tracks/<前缀>/NNNNNN.png`,`rasterPrefix` 的缓存),
   * 最后一个前缀的结果抄进 `<键>/frames/`(`readFramesCore` 的兼容读法、播放的暖帧都读它)。
   *
   * legacy 整帧通道方案 B(AGENT-maint-3):以前每个前缀还编一个 `preview.mp4`、整场景再抄一份,
   * 没有任何消费方,不再产;旧版本留下的这些文件在这里顺手删掉。
   */
  async prerender(entry, bakery, signal) {
    const prefixes = this.prefixes(entry);
    const frames = [...entry.html.keys()].sort((a, b) => a - b);
    for (let i = 0; i < prefixes.length; i++) {
      if (signal.aborted) throw new Error('Cancelled');
      const prefix = prefixes[i];
      const dir = path.join(this.root, 'tracks', prefix.key);
      const final = i === prefixes.length - 1;
      await fs.rm(path.join(dir, 'preview.mp4'), { force: true }).catch(() => {});
      for (const frame of frames) {
        if (signal.aborted) throw new Error('Cancelled');
        await this.rasterPrefix(entry, bakery, frame, i, prefixes);
      }
      if (final) {
        for (const frame of frames) {
          await atomic(path.join(entry.dir, 'frames', `${pad(frame)}.png`), await fs.readFile(path.join(dir, `${pad(frame)}.png`)));
        }
        await fs.rm(path.join(entry.dir, 'preview.mp4'), { force: true }).catch(() => {});
      }
    }
  }
  /** Revoke only speculative B/MOV work; Agent renders keep their own lane. */
  async yieldBackground(owner, ttl = 5000) {
    const already = this.backgroundLeaseUntil > Date.now();
    this.backgroundLeaseVersion = (this.backgroundLeaseVersion || 0) + 1;
    this.backgroundLeaseOwner = owner;
    this.backgroundLeaseUntil = Date.now() + ttl;
    clearTimeout(this.backgroundLeaseTimer);
    this.backgroundLeaseTimer = setTimeout(() => { void this.resumeBackground(owner); }, ttl);
    this.backgroundLeaseTimer.unref?.();
    if (already || this.backgroundYielding) return this.yielding;
    this.backgroundYielding = true;
    this.yielding = (async () => {
      this.pausedPreloads ||= new Map();
      const requiredActive = [...this.generations.values()].some(generation => this.entries.get(generation.key)?.stage === 'required');
      for (const [id, generation] of this.generations) {
        const entry = this.entries.get(generation.key);
        if (entry && entry.status !== 'ready') this.pausedPreloads.set(id, entry);
        // Required work is allowed to finish while playback starts. Direct
        // control/HTML/MOV work observes this abort at its four-frame boundary.
        if (entry?.stage !== 'required') generation.controller.abort();
      }
      const session = this.lanes.get('background');
      if (session && !requiredActive) { clearTimeout(session.timer); this.lanes.delete('background'); await session.bakery.close().catch(() => {}); }
      await Promise.allSettled([...this.entries.values()].map(entry => entry.mov?.suspend()));
      await this.background.catch(() => {});
      await Promise.allSettled([...this.entries.values()].filter(entry => entry.html.size).map(entry => this.save(entry)));
    })().finally(() => { this.backgroundYielding = false; });
    return this.yielding;
  }
  async resumeBackground(owner) {
    if (owner !== this.backgroundLeaseOwner) return;
    const version = this.backgroundLeaseVersion;
    clearTimeout(this.backgroundLeaseTimer);
    await this.yielding?.catch(() => {});
    if (owner !== this.backgroundLeaseOwner || version !== this.backgroundLeaseVersion) return;
    clearTimeout(this.backgroundLeaseTimer); this.backgroundLeaseUntil = 0;
    const paused = [...(this.pausedPreloads?.entries() || [])]; this.pausedPreloads?.clear();
    // 只把活重新排上、接回原来的 owner:会话的版本不能由这里认领(Item 4)。
    // 让路期间已经没有会话停在这一版的(页面换到了别的版本),不再重排 —— 页面的下一次 preload 会排新的(审查 #4)
    // 播放让路期间 Agent 专用实例不接预渲染(`kickAgentIdle`);让路结束,空着就接
    this.kickAgentIdle();
    if (!this.closed) for (const [owner, entry] of paused) {
      if (!this.ready.sessionsOn(entry.key).length) continue;
      await this.preload(entry.project, { adopt: false, owner });
    }
  }
  async updatePlayback(project, input, { borrow = async () => false, release = async () => {} } = {}) {
    // `agent` 模式不服务用户的播放:当场回 NO_PRERENDER
    if (this.interactive) {
      const refused = modeRefusal(this.mode, 'playback');
      if (refused) throw refused;
    }
    const work = (this.playbackChain || Promise.resolve()).catch(() => {}).then(() => this.updatePlaybackNow(project, input, { borrow, release }));
    this.playbackChain = work;
    return work;
  }
  async updatePlaybackNow(project, input, { borrow, release }) {
    if (this.closed) return { closed: true };
    this.retiredPlaybackOwners ||= new Set();
    if (this.retiredPlaybackOwners.has(input.owner)) return { closed: true };
    const entry = await this.entry(project);
    // A delayed cleanup from a previous project/tab cannot release its successor.
    if (input.close) {
      if (this.playback?.owner === input.owner && input.sequence > this.playback.sequence) {
        this.playback.sequence = input.sequence; await this.stopPlayback();
        this.retiredPlaybackOwners.add(input.owner);
        // 会话结束:播放 MOV 只是中转,用完即删(存储计划 A 部分)
        await this.disposePlaybackMovie(this.playback.entry);
      }
      return { closed: true };
    }
    if (!entry.playbackMovie) entry.playbackMovie = new PlaybackMovStore({ dir: entry.dir, width: project.width, height: project.height,
      fps: project.fps || 30, count: Math.max(1, Math.floor(project.duration * (project.fps || 30))) });
    await entry.playbackMovie.ready;
    if (!this.playback || this.playback.owner !== input.owner || this.playback.entry !== entry) {
      if (this.playback && this.playback.owner !== input.owner) this.retiredPlaybackOwners.add(this.playback.owner);
      const previous = this.playback?.entry;
      await this.stopPlayback();
      // 换了版本(另一个 entry):上一个版本的播放 MOV 没人再读,删掉
      if (previous && previous !== entry) await this.disposePlaybackMovie(previous);
      this.playback = new FramePlayback({ entry, movie: entry.playbackMovie,
        render: (times, options) => this.see_frames(entry.project, times, options),
        // Warm frames are verified like see_frames lookups; an empty legacy
        // raster is not trusted and goes back to the render queue instead.
        cached: async frame => await entry.mov.lookup(frame, this.renderSignature(entry, frame, 'playback'))
          || await fs.readFile(path.join(entry.dir, 'frames', pad(frame) + '.png')).then(buf => isFullyTransparentPng(buf) ? null : buf, () => null),
        stop: () => this.stopPlayback(), workers: 2 });
      this.playback.owner = input.owner;
    }
    const playback = this.playback;
    if (!playback.update(input)) return { ...playback.status(), key: entry.key, movie: `/api/frames/${entry.key}/mov/${entry.playbackMovie.name}` };
    if (input.playing) {
      playback.preparing = true;
      playback.release = release;
      // Playback must answer this heartbeat immediately. Yielding a low lane,
      // borrowing a remote slot and adopting its snapshots are background
      // housekeeping, never a prerequisite for the hot two local renderers.
      playback.setWorkers(2); this.userPoolSize = 2; playback.preparing = false;
      void this.yieldBackground(input.owner).catch(() => {});
      void (async () => {
        const wasBorrowed = playback.borrowed;
        const borrowed = await borrow(input.owner);
        if (this.playback !== playback || !playback.playing) { if (borrowed) await release(input.owner); return; }
        playback.borrowed = borrowed;
        playback.setWorkers(borrowed ? 3 : 2); this.userPoolSize = playback.workers;
        if (borrowed && !wasBorrowed) await this.refreshSnapshots(entry);
      })().catch(() => {});
    } else {
      this.userPoolSize = 2;
      for (const session of [...this.userPool].reverse()) if (!session.busy && this.userPool.length > 2) this.dropUserSession(session);
      await this.resumeBackground(input.owner); await release(input.owner);
    }
    return { ...playback.status(), key: entry.key, movie: `/api/frames/${entry.key}/mov/${entry.playbackMovie.name}` };
  }
  /** 关掉并删掉一个 entry 的播放 MOV;下次播放这一版时重新建一份(帧从 MOV 缓存的 PNG 回填)。 */
  async disposePlaybackMovie(entry) {
    const movie = entry?.playbackMovie;
    if (!movie) return;
    entry.playbackMovie = null;
    await movie.dispose().catch(() => {});
  }
  async stopPlayback() {
    const playback = this.playback;
    if (!playback) return;
    playback.playing = false; playback.cancel();
    this.userPoolSize = 2;
    await this.resumeBackground(playback.owner); await playback.release?.(playback.owner);
    for (const session of [...this.userPool].reverse()) if (!session.busy && this.userPool.length > 2) this.dropUserSession(session);
  }
  async refreshSnapshots(entry) {
    // The separate background process flushes B before acknowledging yield.
    // Adopt those compressed blocks while preserving newer local samples.
    try {
      const archive = await this.loadArchive(entry);
      for (const frame of entry.html.keys()) if (!archive.frames.has(frame)) archive.frames.set(frame, entry.html.get(frame));
      for (const [id, frames] of entry.controls) {
        if (!archive.controls.has(id)) archive.controls.set(id, archive.createControl(id));
        for (const frame of frames.keys()) if (!archive.controls.get(id).has(frame)) archive.controls.get(id).set(frame, frames.get(frame));
      }
      const dispose = entry.disposeArchive;
      entry.html = archive.frames; entry.controls = archive.controls; entry.disposeArchive = archive.dispose;
      entry.createControl = archive.createControl;
      entry.recordVersion = (entry.recordVersion || 0) + 1;
      dispose?.();
    } catch { /* A missing/corrupt disposable archive cannot block playback. */ }
  }
  async close() {
    this.closing ||= this.closeNow();
    return this.closing;
  }
  async closeNow() {
    this.closed = true;
    await this.playbackChain?.catch(() => {});
    await this.stopPlayback();
    clearTimeout(this.backgroundLeaseTimer);
    clearTimeout(this.timer);
    clearTimeout(this.agentGraceTimer);
    for (const timer of this.cardLockTimers ?? []) clearTimeout(timer);
    this.cardLockTimers?.clear();
    this.userGenerationController?.abort();
    this.userGenerationController = null;
    await this.userPrewarm;
    for (const r of this.queue.splice(0)) r.reject(new Error('Renderer closed'));
    for (const generation of this.generations.values()) generation.controller.abort();
    await Promise.allSettled([this.foreground, this.background, ...this.laneChains.values(), this.queueSettled()]);
    await this._streams?.close();
    // C6.4:推送队列停止派新活(没推完的段留在队列文件里,下次起来接着推)
    if (this.pushQueue) { try { await this.pushQueue.stop?.(); } catch {} }
    // c10a 第 9 节:小尺寸那一页(浏览器随 lane 一起关)
    this.smallPending = [];
    await this.smallChain?.catch(() => {});
    await Promise.allSettled(this.streamSessions.splice(0).map(session => { clearTimeout(session.idleTimer); return session.bakery?.close(); }));
    await Promise.allSettled([...this.lanes.values()].map(session => { clearTimeout(session.timer); return session.bakery.close(); }));
    this.lanes.clear();
    await Promise.allSettled(this.userPool.map(session => session.bakery.close()));
    this.userPool.length = 0;
    await Promise.allSettled([...this.entries.values()].flatMap(entry => [entry.mov?.close(), this.disposePlaybackMovie(entry), entry.cardCache?.close()]));
    for (const entry of this.entries.values()) entry.disposeArchive?.();
  }
}

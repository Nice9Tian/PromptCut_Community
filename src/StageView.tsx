import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Stage, type StreamPlaneGroup } from "./render/Stage";
import { FrameScene } from "./render/FrameScene";
import { flattenOverlay, type Project } from "./kernel/project";
import { projectCardGraph } from "./kernel/cardGraph.mjs";
import { withMediaRates } from "./kernel/clipTime.mjs";
import { cardsStamp, cardsVersion, getCard, onCardsUpdated, onRuntimeCardsChanged, runtimeCardsGen, setSyncedUserCards, syncedUserCardsGen, cardsRegistryGen } from "./kernel/registry";
import { installStageClock } from "./render/stageClock";
import { cardMountedAt, mountFrameOf } from "./render/frameWindow.mjs";
import { createAnimationPinner } from "./render/pinAnimations";
import { createSnapshot } from "./render/createSnapshot";
import { flatClipOf, isFlatClipId } from "./kernel/cutFlatten.mjs";
import { clipWrapper, hitTest as solidHitTest, rectsWithBounds as solidRectsWithBounds } from "./render/solid";
import { applyProjectPatch, type ProjectPatch } from "./render/changedClips.mjs";
import {
  detectHostCapabilities,
  postStageEvent,
  compressHtml,
  postStageReady,
  serveStageRpc,
  postStageCards,
  type BackJob,
  type BakeFrameReply,
  type PlayReply,
  type ProbeBooleans,
  type RenderReply,
  type SetTimeReply,
  type SnapshotCost,
  type StageRole,
  type StageRpcApi,
} from "./render/stageRpc";
import { PROBE_BOOL_FRAMES, PROBE_BOOL_MS, PROBE_MAX_FRAMES, PROBE_MAX_MS } from "./render/pipelineTuning.mjs";
import { compareSnapshotHtml } from "./render/snapshotCompare.mjs";
import { budgetOf, CATCHUP_STEPS_PER_BEAT, clipWeight, pipelineAt } from "./render/pipelinePlan.mjs";
import { beatAt, createK6State, noteK6Beat, scheduleNextBeat } from "./render/beatLoop.mjs";
import { reviveStagePlan, type StagePlan, type WirePlan } from "./render/wirePlan";
import { ensureProxyStyle, proxyAllowed, proxyOf, resetInk, sampleAll } from "./render/solidMode";
import { PushedStreamSource, StreamPlayer } from "./render/streamPlayer";
import {
  applyPlaceholders, hideAllPlaceholders, localOnlyClipIds, onlineBrowserMode, setPlaceholderViewScale, noteInkBox, removePlaceholderStyle, PLACEHOLDER_SLOT_ATTR, placeholdersEnabled, placeholderWanted,
  resetPlaceholderGeometry, setCatchingUpClips, setOnlineBrowserMode, setPlaceholdersEnabled, keepTopOfGroups, setOverBoxSource, setStreamBoxSource, shownPlaceholders, stageBoxToLocal, shownSince,
  unsupportedHere,
} from "./render/placeholderHost";

/*
 * 在线浏览器模式(product/platforms.md「在线浏览器模式」):在线构建(`ONLINE`)恒开;桌面上由舞台地址的 `platform=browser`
 * 显式打开(截图和探针用,编辑页的同名参数经 `stageSrc` 转发过来)。开着时这台设备跑不了的卡(用户卡、素材效果卡)不挂组件,
 * 照贴预渲染结果,什么都贴不上才显示 `unsupported` 占位(C10 契约第 9 节)。
 */
try { setOnlineBrowserMode(ONLINE || new URLSearchParams(location.search).get("platform") === "browser"); } catch { /* 没有 location:导出 / 单测 */ }
import { PLACEHOLDER_SHOW_DELAY_MS } from "./render/placeholder/contract";
import { measureLocalContentBox, type CanvasPixels } from "./render/contentBox";
import { createGlHost } from "./render/gl/glHost";
import { glPlanes } from "./render/gl/planes";
import { resolveGlRoute } from "./render/costDevice.mjs";
import { themeStyle } from "./themes";
import { ONLINE } from "./online/mode";
import { mediaTierPolicy, setMediaTierPolicy } from "./render/mediaTier";
import { netSpeedState, startNetSpeed } from "./render/netSpeed";
import { cardExecGate as stageExecGate, cardVisualExecAllowed, noteMediaPolicy, subscribeCardExecGate as subscribeStageExecGate } from "./online/isolation/execGate";
import type { StageCardRuntime } from "./online/cardRuntime/stageRuntime";
import type { StageSound } from "./online/cardRuntime/stageSound";
import type { CardBundle } from "./online/cardRuntime/protocol";
import { announceStageIsolation } from "./online/isolation/stageGuard";
import { clampSettleTimeout, runSettle, settleKindOf, type DrawOutcome, type SettleItem, type SettleResult } from "./render/settleFrame";
import { cardCapabilities, clipFrameMode } from "./kernel/frameMode.mjs";
import { resolveFrameSize } from "./kernel/frameSize.mjs";
import { frameWorkStatus, waitForFrameWork } from "./kernel/frameReady";
import { pixelRect, renderSmallWebp, renderSnapshotBitmap } from "./render/bakeSmall";
import "./cards";

/**
 * 渲染面(?stage=1)。编辑器把它放在一个 iframe 里,只下发「现在是时间轴的第几秒」,
 * 由它渲染出那一秒的画面。它自己不按墙上时钟播:时间被 stageClock 接管,
 * 卡片的 Motion 帧循环和 rAF 都由这里显式推进,所以
 *   - 拖播放头到片段中间 = 直接出那一刻的画面(不会从头重播一遍进场动画)
 *   - 播放 = 编辑器每帧下发新的 t,这里推进一帧
 * 和导出视图(?export=1)是同一套办法、同一份卡片代码,预览所见 = 导出所得。
 *
 * **和父页只经 postMessage RPC 说话(E0,见 render/stageRpc.ts),时间一律秒。**
 * 角色(`front` / `back`)是运行时状态(J4):同一份代码,`front` 是可见的播放器舞台,
 * `back` 是探针 / 补跑用的后台舞台。**查询串里的 `id=A` / `id=B` 只是实例名,不是角色**
 * (E1);默认角色是 `front`,父页握手之后立刻用 `setRole` 把两个实例各就各位。
 * `render` 和带 `probe: true` 的 `setTime` 有**角色闸门**:不是 `back` 就回
 * `{ aborted: true, reason: 'role' }`,父页当错误、不重发。
 *
 * 两条路:
 *   - `setTime(t)`:暂停 / 拖动时父页发它。**不重挂载、不递增 playToken**:时钟拨过去、提交 React、
 *     钉动画 —— 任何 dt 都一样(唯一例外:往前且不到半秒,按连续播放同步推几帧)。
 *     stateful 卡往回拖 / 远跳之后的组件状态是错的,第 4 步由快照平面盖住(C3 / C4);
 *     direct 卡、素材层、`data-pc-local-frame`、命中测试都跟着它走。
 *   - `render(t, { jump })`:只给后台舞台(K1 探针):重挂载 + 从挂载帧逐帧推到 t,
 *     Promise 在推完之后才 resolve;被新的 render / setProject 掐掉时按 `superseded` / `project` 回。
 *
 * `?preview=legacy`:保留旧路(setProject 立刻按跳转重算这一帧),给对比和回退用。
 */

const isStageRoute = typeof window !== "undefined" && new URLSearchParams(location.search).has("stage");
const LEGACY = typeof window !== "undefined" && new URLSearchParams(location.search).get("preview") === "legacy";
/**
 * 舞台内容走哪条路(R3)。**`?preview=stage` 由父页写进 iframe 的 src**
 * (`editor/previewMode.ts` 的 `stageSrc`),只有真的开了双舞台的那一次才带。
 *
 * 带了 = 渲 `FrameScene` 的 **live 变体**:素材层在舞台里(E7 第 1 条)、六个平面 prop 生效。
 * 不带(缺省,今天用户手里那份编辑台)= 照旧只渲 `Stage`,一个字都不变。
 */
const LIVE = typeof window !== "undefined" && new URLSearchParams(location.search).get("preview") === "stage";

/**
 * 重卡被点名抑制、它的轨道流还没画出第一帧时,先不藏它原来的画面,最多等这么久(mechanism/rendering.md「兜底顺序」:
 * 「起播和跳转后的第一拍,流的第一帧画出来之前不藏这张卡原来的画面」);到时还没有就照常藏起来,这一层落到占位符。
 * 流的第一帧实测 80～130 毫秒出来(取清单、取分段、建解码器;原型 `claude/scrub-streams` 量的)。
 */
const STREAM_FIRST_WAIT_MS = 500;

/**
 * K4 的节拍按**绝对时刻**排:`nextDue = playStart + n × 1000 / fps`。等到 `nextDue − 这个值`
 * 就开工 —— 真 rAF 的粒度是一个垂直同步(60 Hz 上 16.6 ms),差这一点点不该再多等一整帧。
 */
const BEAT_SLACK_MS = 1;

/**
 * 武装停(`pause({ atSec })`)的兜底(真墙钟,E4b)。武装的那一拍正常情况下几十毫秒就到,
 * 但要是循环因为别的原因卡住了,RPC 不能永不回包 —— 超时按「循环此刻停在哪儿」回。
 */
const ARM_TIMEOUT_MS = 5000;

/** 按片段追帧每推这么多步就让出一个宏任务(E4 的调用约定) */
const CATCHUP_YIELD_STEPS = 8;

/** E3:拖动中向后重推节流到每 100 ms 至多一次,其间保持上一状态 */
const SCRUB_REPUSH_MS = 100;
// 时间必须在任何卡片挂载之前接管
const clock = isStageRoute ? installStageClock() : null;
const pinner = createAnimationPinner();

/** 时间差小于这个值(秒)且往前走,当成连续播放,只推进不重挂载 */
const CONTINUOUS_MAX = 0.5;

/** 改参数停手多久之后重算这一帧(毫秒)—— 只在 legacy 路上用 */
const SETTLE_MS = 200;

/** 「这一帧长什么样」只取决于这些;它变了才需要重挂载重跑,改卡片参数不算(legacy 路) */
function layoutKeyOf(p: Project): string {
  const clips = flattenOverlay(p).clips.map((c) => `${c.id}:${c.cardId}:${c.start}:${c.end}`).join("|");
  return `${p.width}x${p.height}#${p.themeId}#${clips}`;
}

/** 真墙钟:接管之后 performance.now 是舞台时间,量耗时要用 stageClock 留下的那份 */
const realNow = () => (window.__pcRealNow ?? (() => Date.now()))();
/** 探针只需跨一个真实任务边界让异步 DOM 更新落地；后台 iframe 的真实 rAF 可能被节流到每秒一次。 */
const probeTaskBoundary = () => new Promise<void>((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
  channel.port2.postMessage(null);
});
/**
 * 等一次真帧,但**不许无限等**(K4 的节拍循环用)。
 *
 * 跨源 iframe 被浏览器判成「不可见」时(滚出视口、被整块盖住、窗口挪到屏幕外)rAF 会被
 * 节流到零 —— 实测 `editor-preview-smoke --stage` 里可见舞台走完第一拍就再也没有下一帧,
 * 节拍循环永远挂在这里:`pause()` 回不了包、`play()` 等不到上一轮收摊、K5 的武装停等不到
 * `frame(T)`,整条链一起僵住。总规则是「永远不等」,所以超时就当这一帧已经画过,
 * 循环照常往下走(画面来不及渲是允许的退化,循环僵死不是)。
 */
const realRafOrAfter = (ms: number) => new Promise<boolean>((resolve) => {
  let done = false;
  const finish = (painted: boolean) => { if (done) return; done = true; resolve(painted); };
  (window.__pcRealRaf ?? window.requestAnimationFrame)(() => finish(true));
  (window.__pcRealSetTimeout ?? window.setTimeout.bind(window))(() => finish(false), ms);
});

/** 连着这么多拍都等不到真帧,就认定这个 iframe 被节流了,此后不再为它等 */
const RAF_MISS_GIVEUP = 3;
/** 判定被节流之后,每拍只象征性地让一个宏任务(Motion 解析关键帧要一个任务边界) */
const RAF_GIVEUP_MS = 4;
/**
 * **舞台自身的墙钟定时器一律用真实的**(E4b)。`window.setTimeout` 被 `stageClock` 换成了
 * 登记在虚拟时钟上的 fake timer —— 暂停态虚拟时钟不动,用它的话 `.pc-awaiting` 的 500 ms 兜底
 * 一辈子不响、卡片永久隐身;legacy 那条 `SETTLE_MS` 防抖同理会永远不触发。
 * 虚拟定时器的 id 从 1e9 起,所以被接管后的 `clearTimeout` 对真 id 会自己转交回去,直接用即可。
 */
const realSetTimeout = (cb: () => void, ms: number): number =>
  (window.__pcRealSetTimeout ?? window.setTimeout.bind(window))(cb, ms);

const isProjectPatch = (v: unknown): v is ProjectPatch =>
  !!v && typeof v === "object" && (((v as ProjectPatch).kind === "full" && "project" in (v as object)) || ((v as ProjectPatch).kind === "tracks" && "order" in (v as object)));

/**
 * 两份项目之间变了的卡片段(按对象引用比:store 是不可变更新,没动过的 clip 引用不变)。
 * 新增 / 删除的也算变了。只看卡片段:素材段由视频层画,和舞台无关。(legacy 路用)
 */
function changedCardClips(prev: Project | null, next: Project): { id: string; start: number; end: number }[] {
  const before = new Map<string, unknown>();
  if (prev) for (const tr of prev.tracks) for (const c of tr.clips) if (c.cardId) before.set(c.id, c);
  const out: { id: string; start: number; end: number }[] = [];
  const seen = new Set<string>();
  for (const tr of next.tracks) {
    for (const c of tr.clips) {
      if (!c.cardId) continue;
      seen.add(c.id);
      if (before.get(c.id) !== c) out.push({ id: c.id, start: c.start, end: c.end });
    }
  }
  for (const [id, c] of before) if (!seen.has(id)) out.push({ id, start: (c as { start: number }).start, end: (c as { end: number }).end });
  return out;
}

interface PendingRender {
  gen: number;
  startedAt: number;
  frames: () => number;
  resolve: (r: RenderReply) => void;
}

export default function StageView() {
  const [project, setProject] = useState<Project | null>(null);
  const [t, setT] = useState(0);
  const [token, setToken] = useState(1);
  /*
   * 实体模式开关。只有 ?stage=1&proxy=1 这条路能打开(见 render/solidMode.ts),
   * 导出页 ?export=1 拿不到它 —— 退化方向必须是「慢但正确」。
   */
  const [proxy, setProxy] = useState(false);
  /** 场景根:带 data-pc-scene 的那个 relative div。实体几何(solid.ts)的一切查询都从它出发 */
  const rootRef = useRef<HTMLDivElement>(null);
  const ref = useRef({
    project: null as Project | null,
    t: 0,
    layoutKey: "",
    settle: 0,
    proxy: false,
    role: "front" as StageRole,
    job: undefined as BackJob | undefined,
    wantedSettle: false,
    /** K2 的分派表(已回填成 `Set`)+ K1 的每卡记录。查询走下面的 `pipelineOf` */
    plan: null as StagePlan | null,
    /*
     * 下面这几个集合**一律整份替换,不就地改**:`Stage` 靠「上一次 render 的 suppressed 集合」
     * 判「谁刚进入抑制」,就地 mutate 的话它看到的前后两份是同一个对象,永远判不出变化。
     */
    snapshots: new Map<string, string>() as ReadonlyMap<string, string>,
    /**
     * 实际生效的抑制集合 = 父页发来的(`parentSuppressed`)减去单舞台停下追一帧正在画 / 已画好的(`settleLive`)。
     * 读抑制的地方(渲染、占位符、钉动画要跳过谁)一律读这一份;两份源头变了由 `applySuppressed` 重算。
     */
    suppressed: new Set<string>() as ReadonlySet<string>,
    /** 父页经 `setSuppressed` 发来的那一份(原样) */
    parentSuppressed: new Set<string>() as ReadonlySet<string>,
    /**
     * 单舞台停下追当前一帧(`settleLayers`,`render/settleFrame.ts`):正在画和已经画好的层。它们不再按父页的抑制藏起来;
     * 下一次 `setTime` / `play` / `setRole` 清空(下一次播放回到播放时的样子)。没画好(被打断)的从这里拿掉,回到抑制(兜底)。
     */
    settleLive: new Set<string>() as ReadonlySet<string>,
    /** 上一次停下追一帧的结果(诊断 `__pcStageDiag().lastSettle`) */
    lastSettle: null as SettleResult | null,
    streamPlanes: [] as readonly StreamPlaneGroup[],
    /**
     * 父页点名抑制了、挂着流平面、但流还没画出第一帧的卡 → 从什么时候起等的(真实毫秒)。这段时间**不藏它原来的画面**
     * (藏了那一层就是空的),等流画出来(`StreamPlayer` 的 `onShowingChange`)或 `STREAM_FIRST_WAIT_MS` 到了再藏。
     */
    streamWaiting: new Map<string, number>() as ReadonlyMap<string, number>,
    streamWaitTimer: 0,
    /** 停下追帧被上面那一条推后的卡:流的第一帧画出来(或到时)再起步,这之前露着的是跳之前那一刻的画面 */
    deferredSettle: new Map<string, { target: number; fps: number; gen: number }>(),
    /** 组流里先追上的成员:留在 `settling` 里(不可见、时间钉在目标帧),等同组此刻在场的都追上了一起露出来 */
    settledHeld: new Set<string>() as ReadonlySet<string>,
    /** 这一帧的快照还没到、先藏着等的片段(E0 的 `setTime({ awaiting })`) */
    awaiting: new Set<string>() as ReadonlySet<string>,
    /** 正在用子树虚拟时间追帧的片段 → 它此刻的全局舞台毫秒(K5 第一路,R5 才填) */
    settling: new Map<string, number>() as ReadonlyMap<string, number>,
    /** K3:按片段重挂载的代数(空表时 `Stage` 退回整舞台 playToken) */
    remountGen: new Map<string, number>() as ReadonlyMap<string, number>,
    /** 正在跑的按片段追帧(K3(a) / K3(b) / K5 第一路共用一套驱动) */
    catchUps: new Map<string, { clipId: string; stageMs: number; targetMs: number; stepMs: number; announce: boolean; gen: number }>(),
    /** 这个片段上一次的目标帧号(K3(a′):目标帧变小 = 向后跳,要先走重挂载定位配方) */
    lastTargetFrame: new Map<string, number>(),
    /** 这个片段上一次重推的真实时刻(E3:拖动中向后重推节流到每 100 ms 至多一次) */
    repushAt: new Map<string, number>(),
    /** 上一拍活跃的卡(K3(b):播放头**刚进入**哪张卡) */
    lastActive: new Set<string>() as ReadonlySet<string>,
    scrubbing: false,
    playing: false,
    mediaT: 0,
    localHashes: [] as readonly string[],
    /** K4 的节拍循环停着没有(`setRole('back')` / `pause()` 要能停它) */
    beatPaused: true,
    /** 循环真的还在跑(`pause()` 置了 `beatPaused` 之后本拍还要走完) */
    beatRunning: false,
    /** 最后一拍的 `sec`:`pause()` 回包的 `stoppedAt` */
    beatLastSec: 0,
    /** 最后一拍的**帧序号**(武装停按它比,不比浮点) */
    beatLastFrame: -1,
    /** 武装停(`pause({ atSec })`):post 完这一拍就停 */
    beatArmed: null as { frame: number; atSec: number; resolve: (r: PlayReply) => void; timer: number } | null,
    /** 等循环停下来的那些 `pause()` 调用 */
    beatWaiters: [] as ((r: PlayReply) => void)[],
    /** K6 的一秒窗口:每拍的总耗时和每张卡的耗时(都用 `__pcRealNow`) */
    k6: createK6State(),
    /** 这一拍每张卡的 React 渲染耗时(`<Profiler>` 报的,每拍清空) */
    cardCost: new Map<string, number>(),
    pending: null as PendingRender | null,
  });
  /**
   * 平面状态(快照 / 抑制 / 流 / 等待 / 追帧)改了就敲一下,让这一帧重渲。
   * 真值放在 `ref.current` 里 —— RPC 方法要能**同步**读到最新值,React state 做不到;
   * 而渲染只要一个「变了」的信号,读的仍是 `ref.current`。
   */
  const [, bumpPlanes] = useReducer((n: number) => n + 1, 0);
  /**
   * 第一路追帧的代数(K5):`setRole('back')` 和任何新的 `setTime` / `play` / `setProject`
   * 都递增它,把可见舞台里正在进行的子树追帧中止掉。R5 往里填实现时不用再动这里。
   */
  const catchUpGen = useRef(0);
  /** 落定补拍的代数:又渲了一帧就作废上一次挂着的补拍(见 settle 的说明) */
  const settleGen = useRef(0);
  /** 渲染代数:又来一次渲染 / 换项目就作废上一次还在飞的异步补跑;和 RPC 请求一一对应 */
  const renderGen = useRef(0);
  /**
   * 换了几次项目。两趟布尔探针那一支不走 `abortPending`(它自己 `return`,不是 resolve
   * 挂着的那个 pending),所以要另有一样东西分得清「被 `setProject` 掐的」和「被新 `render`
   * 掐的」—— 两者的重发规矩不一样(E0:`'project'` 重发,`'superseded'` 丢弃)。
   */
  const projectGen = useRef(0);

  /*
   * 卡片图(H3):素材效果卡的输入在这里解。projectCardGraph 对悬空输入会 throw
   * (删片段不清 cardNodes),所以包 try —— 一张坏卡不能让整台舞台卸载。
   * 放在 `if (!project) return null` 之前:hooks 不能条件调用。
   */
  /*
   * 卡片代码换了(热更新在 `cards/index.ts` 接住、重装了整套卡片,C6.6 集成 3b):本组件不在热更新链上,
   * 靠这个版本号重渲,卡片按新定义重新挂上;卡片图也按新定义重解。项目、时间、RPC 都不动。
   */
  const cardsGen = useSyncExternalStore(onCardsUpdated, cardsVersion, cardsVersion);
  // 按新卡重渲提交之后告诉父页换到了哪一版(父页等两个舞台都报到才排重测,`editor/stageCards.ts`)
  useEffect(() => {
    if (cardsGen > 0) postStageCards(cardsStamp());
  }, [cardsGen]);
  // 在线舞台里运行时载入的用户卡与素材效果卡换了一批(`online/cardRuntime/stageRuntime.ts`):卡片图按新定义重解。桌面运行环境里这个数恒为 0
  const runtimeGen = useSyncExternalStore(onRuntimeCardsChanged, runtimeCardsGen, runtimeCardsGen);
  const graph = useMemo(() => {
    if (!project) return undefined;
    try {
      // 变速段的素材节点补上倍率(kernel/clipTime.mjs 的 withMediaRates;没有变速段时原样)
      return withMediaRates(project, projectCardGraph(project, getCard));
    } catch {
      return undefined;
    }
    // cardsGen:卡片定义换了,图也要重解;runtimeGen:在线舞台里运行时载入的卡换了(桌面恒为 0)
  }, [project, cardsGen, runtimeGen]);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.overflow = "hidden";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
  }, []);

  /**
   * 全局钉动画时要跳过谁(K5 第一路 / E7 第 5 条):正在用子树虚拟时间追帧(`.pc-settling`)
   * 和被抑制(`.pc-suppressed`)的片段,它们的动画不能被全局时钟拨回去。
   * 收的是**包裹层**(`[data-pc-clip]`),`pinner.sync` 对每条动画取目标元素往上最近的那个查表。
   */
  const skipWrappers = useCallback((): ReadonlySet<Element> | undefined => {
    const { settling, suppressed } = ref.current;
    if (!settling.size && !suppressed.size) return undefined;
    const root = rootRef.current;
    if (!root) return undefined;
    const out = new Set<Element>();
    for (const id of [...settling.keys(), ...suppressed]) {
      const el = clipWrapper(root, id);
      if (el) out.add(el);
    }
    return out.size ? out : undefined;
  }, []);

  /**
   * 素材层画出一帧了(K5 第 (4) 步)。**只有 `back` 报**:父页要的是「后台舞台的素材也到位了,
   * 可以互换」这一条;可见舞台在播放时每帧都有新的视频帧,照报就是每秒几十条 postMessage。
   * 父页按 `event.source` 只认当前 `back` 发来的 `mediaReady`,这里再把源头收一道。
   */
  const onMediaFrame = useCallback(() => {
    if (ref.current.role !== "back") return;
    postStageEvent({ type: "mediaReady", sec: ref.current.mediaT });
  }, []);

  /**
   * 这一拍这张卡花了多少毫秒(K6)。`FrameScene` 的 live 路给每个片段套了一个
   * `<Profiler>`,一拍里同一个片段可能提交不止一次,所以是累加;每拍开头清空。
   */
  const onCardCost = useCallback((clipId: string, ms: number) => {
    const cur = ref.current.cardCost;
    cur.set(clipId, (cur.get(clipId) ?? 0) + ms);
  }, []);

  useEffect(() => {
    if (!clock) return;

    /*
     * 轨道流的解码与合成(R8 / G5)。**只在 `front` 角色下工作**:`setRole('back')` 停掉它、
     * `close()` 全部 `VideoFrame`;`back` 不收 `streamPlanes`,也就不建 decoder、不画(K5)。
     * 它往 `Stage` 已经渲好的 `[data-pc-stream-plane]` / `[data-pc-group-plane]` 上画。
     */
    /*
     * 字节从哪来:桌面直连预渲染进程(缺省的字节源);在线页面没有预渲染进程,清单与字节由父页随流平面推来
     * (理由见 `streamPlayer.ts`「在线页面:清单与字节由父页推来」)—— 这里给一个只认推来的块的源,
     * 没带清单的平面(父页还没取到)在它这里取不到东西,不会去请求不存在的预渲染进程。
     */
    /** 某条流的画面有无变了(异步解出第一帧、留到时限清空);实现在下面,等用到的函数都定义了再接上 */
    let onStreamShowing: () => void = () => {};
    const player = new StreamPlayer({ root: () => rootRef.current, ...(ONLINE ? { source: new PushedStreamSource() } : {}), onShowingChange: () => onStreamShowing(),
      // 超出预算的层的位置矩形变了(清单到了、播放头进了下一个分段):占位符的几何是渲染时取的,提交一次让它重取
      onBoxChange: () => onStreamBoxes() });
    let onStreamBoxes: () => void = () => {};
    /*
     * 占位符的几何首选流清单里的矩形(mechanism/rendering.md「重管线:预渲染」;`placeholderHost` 的 `geometryFor`)。
     * 超出预算的层取这一帧所在分段的位置矩形:单卡流的是包裹层自己的坐标,直接用;组流、依赖下层的流的是舞台坐标,
     * 按屏幕上量到的包裹层位置换过来(换不了的回 null,照老办法定位)。这个矩形只管这一帧,和预算以内的流的框分开给
     * (那一种会被记下来留到以后用,这一种不记)。
     */
    setStreamBoxSource((clipId) => player.boxOf(clipId));
    setOverBoxSource((clipId) => {
      const own = player.overBoxOf(clipId);
      if (own) return own;
      const staged = player.stageBoxOf(clipId);
      const wrap = staged ? rootRef.current?.querySelector<HTMLElement>(`[data-pc-clip="${CSS.escape(clipId)}"]`) : null;
      const ref = (wrap?.offsetParent ?? null) as HTMLElement | null;
      if (!staged || !wrap || !ref || !(ref.offsetWidth > 0) || !(wrap.offsetWidth > 0)) return null;
      return stageBoxToLocal(staged, { ref: ref.getBoundingClientRect(), refWidth: ref.offsetWidth, wrap: wrap.getBoundingClientRect(), wrapWidth: wrap.offsetWidth,
        transform: getComputedStyle(wrap).transform });
    });

    /*
     * canvas 卡的共享 WebGL 渲染器(R9 M2)。`stageId` 是实例名(`A` / `B`),**和角色无关**:
     * 互换角色时它不变,Worker 里这个舞台那份图集区域跟着实例走,不跟着角色走。
     * 路线先按宿主能力的缺省建,收到项目后按 `project.glRoute` 的生效值改(`setProject`)。
     * 路线 2 的端口由父页在握手之后、任何 RPC 之前经 `{ type: 'gl-port' }` 交来(下面那个监听)。
     */
    const caps = detectHostCapabilities({ online: ONLINE });
    // 最低一档(父页在 src 里给 `lowest=1`)起手就只用小尺寸;远程素材服务的基址与票据、素材闸门的结果等父页 `setMediaPolicy` 下发
    setMediaTierPolicy({ smallOnly: caps.lowest, online: ONLINE });
    /*
     * 主线程画布丢了 WebGL 上下文:素材效果卡的图形能力按「运行中丢过上下文」算不够(`cardRuntime`,契约 4.3)。
     * 它不再用来判整台设备的性能(原来的「运行中整体降档」2026-10-07 用户定撤销),只在线页面接。
     * 事件不冒泡,在 document 上按捕获阶段接;OffscreenCanvas 在 Worker 里丢上下文不经这里(glHost 自己有退路)。
     */
    const onContextLost = () => { cardExec.runtime?.noteContextLost(); };
    if (ONLINE) document.addEventListener("webglcontextlost", onContextLost, true);
    /*
     * 素材闸门的网速(`render/netSpeed.ts`):看素材实际下载的快慢,慢就先拉小尺寸、再拉原尺寸替换,快就只拉原尺寸;使用中随时切换。
     * 素材是这一台舞台自己读的,所以在舞台里看、写进这一台的取档策略;切换时报父页一声(查看口)。只在线页面。
     */
    const stopNetSpeed = ONLINE ? startNetSpeed((st) => {
      setMediaTierPolicy({ smallFirst: st.smallFirst });
      commitPlanes();
      postStageEvent({ type: "net-speed", mbps: st.mbps, samples: st.samples, smallFirst: st.smallFirst });
    }) : () => {};
    /*
     * 在线执行同步来的用户卡与素材效果卡(`docs/plan/online-card-exec-contract.md` 第 2、3、4、8 节)。编辑页面经 `loadUserCards` 发来转译好的包;
     * 这里只在**本文档自己的执行闸门**开着时执行(`online/isolation/execGate.ts`:是跨源舞台入口、自检通过、父页点头、从没见过票据、没出过加固拦下的事):
     *   - 画面那一半还要本文档的出口由浏览器拦(`cardVisualExecAllowed`;〔裁:主会话 2026-10-06〕只靠脚本加固的浏览器上不执行画面);
     *   - 声音那一半在这一台起的后台线程里执行(线程从 blob 地址引导,继承本文档的策略),只有父页点名的那一台(实例 B)起。
     * 闸门晚开:包先记着,开了再执行;闸门关上(出了加固拦下的事):已载入的全部撤下。加载器与声音宿主都按需载入,桌面构建里整段剪掉。
     */
    const cardExec: { bundles: CardBundle[] | null; sound: boolean; runtime: StageCardRuntime | null; soundHost: StageSound | null; seq: number; stopped: boolean } =
      { bundles: null, sound: false, runtime: null, soundHost: null, seq: 0, stopped: false };
    const applyCardBundles = async (): Promise<void> => {
      if (import.meta.env.VITE_PC_ONLINE !== "1" || cardExec.stopped) return;
      const seq = ++cardExec.seq;
      const stale = () => seq !== cardExec.seq || cardExec.stopped;
      const bundles = cardExec.bundles;
      if (!stageExecGate().allowed || !bundles) {
        const had = !!cardExec.runtime || !!cardExec.soundHost;
        cardExec.runtime?.dispose(); cardExec.runtime = null;
        cardExec.soundHost?.dispose(); cardExec.soundHost = null;
        if (had) {
          postStageEvent({ type: "card-states", states: [], graph: "unknown", visual: false });
          postStageEvent({ type: "sound-state", state: null });
          commitPlanes();
        }
        return;
      }
      try {
        if (cardVisualExecAllowed()) {
          if (!cardExec.runtime) {
            const m = await import("./online/cardRuntime/stageRuntime");
            if (stale() || !cardVisualExecAllowed()) return;
            cardExec.runtime ??= m.createStageCardRuntime({
              longSide: () => Math.max(ref.current.project?.width ?? 1920, ref.current.project?.height ?? 1080),
              onStates: (states, graph) => {
                postStageEvent({ type: "card-states", states, graph, visual: true });
                // 能运行的卡换了一批:重渲一次(活组件挂上 / 撤下、占位符重算)
                commitPlanes();
              },
            });
          }
          await cardExec.runtime.setBundles(bundles);
          if (stale()) return;
        } else {
          cardExec.runtime?.dispose(); cardExec.runtime = null;
          postStageEvent({ type: "card-states", states: [], graph: "unknown", visual: false });
        }
        // 没有同步来的卡就不起声音线程(也不报声音状态):项目里没有用户卡、素材效果卡时这一台与以前一样安静
        if (cardExec.sound && (bundles.length > 0 || cardExec.soundHost)) {
          if (!cardExec.soundHost) {
            const [m, sp] = await Promise.all([import("./online/cardRuntime/stageSound"), import("./online/cardRuntime/soundSpawn")]);
            if (stale() || !stageExecGate().allowed) return;
            cardExec.soundHost ??= m.createStageSound({ spawn: sp.spawnSoundWorker, onState: (state) => postStageEvent({ type: "sound-state", state }) });
          }
          await cardExec.soundHost.setBundles(bundles);
        } else if (cardExec.soundHost) {
          cardExec.soundHost.dispose(); cardExec.soundHost = null;
          postStageEvent({ type: "sound-state", state: null });
        }
      } catch (err) {
        console.warn("[stage] 载入同步来的卡片出错", err);
      }
    };
    const offCardExecGate = ONLINE ? subscribeStageExecGate(() => { void applyCardBundles(); }) : () => {};
    /*
     * 在线页面的路线由父页按舞台闸门定(起手看 src 里的 `gl=`,试第三级时经 `setGlRoute` 换),不看项目选项;
     * 桌面运行环境照旧按项目选项(`setProject` 里 `resolveGlRoute(project.glRoute)`),缺省路线 1。
     */
    let onlineGlRoute: "perDocument" | "shared" = caps.glRoute ?? "perDocument";
    const gl = createGlHost({ stageId: caps.stageId, compact: caps.compact, route: ONLINE ? onlineGlRoute : resolveGlRoute(null) });
    const onGlPort = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      const d = e.data as { type?: string; port?: MessagePort | null } | null;
      if (d?.type !== "gl-port") return;
      gl.acceptPort(d.port ?? e.ports[0] ?? null);
    };
    window.addEventListener("message", onGlPort);
    /** 严格的一拍:探针、生成快照、补跑落定都等它(没有 gl 平面时回 `undefined`,不多让一次微任务) */
    const glStrict = (sec: number) => gl.beat({ strict: true, t: sec }) ?? undefined;
    const presentStreams = (sec: number) => {
      // 没有流平面、但有超出预算的层时也要走:它们的位置矩形跟着播放头换
      if (ref.current.role !== "front" || (!ref.current.streamPlanes.length && !player.hasOver)) return;
      player.present(sec);
    };

    /*
     * 补一拍「落定」。**同步补跑完的那一瞬间,Motion 还没把新值写回 DOM。**
     *
     * Motion 的 JS 动画(transform 这类)确实挂在我们接管的 rAF 上 —— 手动 tick 能推动它,
     * 推出来的值和导出逐位相同。但它解析关键帧要**跨一个任务边界**:实测在同一个 JS 任务里
     * 再补多少拍都没用,让出一个微任务之后只补一拍就够。而跳转那条路是一个同步块跑完的,
     * 于是补跑结束时卡片还停在 initial 那一帧。
     *
     * 实测 chapter-bar 第 9 帧:导出 translateY(-8.65515px),预览 translateY(-120px)——
     * 进场条整个悬在画面外,而且不报错。补上这一拍之后两边逐位相同。
     * 导出那边不需要这个:它每一帧都是真实的浏览器帧,任务边界白捡。
     *
     * 时间不动(还是 target),所以这一拍只让写回发生,不会让动画多走。
     */
    const settle = (target: number) => {
      const gen = ++settleGen.current;
      queueMicrotask(() => {
        if (gen !== settleGen.current || !clock) return;
        const ms = Math.max(0, target) * 1000;
        clock.tick(ms);
        pinner.sync(ms, skipWrappers());
      });
    };

    /*
     * 真渲之后采一次墨色(实体模式的色块要用)。
     *
     * 「每次真渲都是一次采样机会」—— 用得越久,实体模式越准:用户改了主色、换了文案,
     * 方块跟着变。播放中是实体模式,不会走到这里,所以不会拖慢播放。
     * 防抖是因为连续拖播放头会一帧一个 setTime,而采样要遍历每张卡的所有元素读 computed style。
     */
    let sampleTimer = 0;
    let inkTimer = 0;
    /**
     * 占位符的第二个几何来源:这张卡上次活渲时的墨迹框(`measureContentBox`,相对包裹层)。
     * 只在停下来之后防抖量一次(播放 / 拖动中不量 —— 那时正是占位符要顶上的时候,量到的是兜底画面),
     * 被抑制 / 等快照 / 追帧的卡子树藏着,跳过。量不到的不记(`noteInkBox` 丢掉 null),几何退回徽标。
     */
    /** 当场把此刻活渲着的每张卡的墨迹框量一遍(被抑制 / 等快照 / 追帧的子树藏着,跳过) */
    const measureInkBoxesNow = () => {
      const root = rootRef.current;
      if (!root) return;
      const cache = new Map<HTMLCanvasElement, CanvasPixels | null>();
      for (const el of root.querySelectorAll<HTMLElement>("[data-pc-clip]:not([data-pc-media])")) {
        const id = el.getAttribute("data-pc-clip");
        if (!id || el.classList.contains("pc-suppressed") || el.classList.contains("pc-awaiting") || el.classList.contains("pc-settling")) continue;
        noteInkBox(id, measureLocalContentBox(el, cache));
      }
    };
    const scheduleInkBoxes = () => {
      if (!placeholdersEnabled()) return;
      window.clearTimeout(inkTimer);
      inkTimer = realSetTimeout(() => {
        if (ref.current.beatRunning || ref.current.scrubbing || !placeholdersEnabled()) return;
        measureInkBoxesNow();
      }, 300);
    };
    const scheduleSample = () => {
      scheduleInkBoxes();
      if (!proxyAllowed() || ref.current.proxy) return;
      window.clearTimeout(sampleTimer);
      sampleTimer = realSetTimeout(() => {
        const root = rootRef.current;
        if (root && !ref.current.proxy) sampleAll(root);
      }, 120);
    };

    /** 这张卡包裹层里的占位槽位(`Stage` 挂的;没挂着回 null) */
    /** 槽位引用缓存(P4 性能修正):每拍都 querySelector 一遍太贵;还挂在原包裹层下就直接用 */
    const slotCache = new Map<string, HTMLElement>();
    const slotOf = (clipId: string): HTMLElement | null => {
      const hit = slotCache.get(clipId);
      if (hit && hit.isConnected && (hit.parentElement?.getAttribute("data-pc-clip") === clipId || hit.parentElement?.getAttribute("data-pc-flat-clip") === clipId)) return hit;
      // 剪辑段里的卡(`kernel/cutFlatten.mjs` 的虚拟片段):包裹层在嵌套场景里,挂的是 `data-pc-flat-clip`
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-pc-clip="${CSS.escape(clipId)}"] > [${PLACEHOLDER_SLOT_ATTR}]`)
        ?? rootRef.current?.querySelector<HTMLElement>(`[data-pc-flat-clip="${CSS.escape(clipId)}"] > [${PLACEHOLDER_SLOT_ATTR}]`) ?? null;
      if (el) slotCache.set(clipId, el);
      else slotCache.delete(clipId);
      if (slotCache.size > 512) slotCache.clear();
      return el;
    };
    const NO_CLIPS: ReadonlySet<string> = new Set();
    /**
     * 这份项目里这台设备跑不了的片段(在线浏览器模式下的用户卡、素材效果卡;`localOnlyClipIds`)。按项目引用、注册表与同步表的代数记忆化;
     * 模式关着(桌面)恒为空集合,不多花一次遍历。
     */
    let localOnlyMemo: { project: unknown; reg: number; synced: number; ids: ReadonlySet<string> } | null = null;
    const localOnlyAll = (): ReadonlySet<string> => {
      const p = ref.current.project;
      if (!p) return NO_CLIPS;
      const reg = cardsRegistryGen(), synced = syncedUserCardsGen();
      if (localOnlyMemo && localOnlyMemo.project === p && localOnlyMemo.reg === reg && localOnlyMemo.synced === synced) return localOnlyMemo.ids;
      const ids = localOnlyClipIds(p.tracks.flatMap((tr) => tr.clips as { id: string; cardId?: string }[]));
      localOnlyMemo = { project: p, reg, synced, ids };
      return ids;
    };
    /** 此刻在场的那几张(口径同 `Stage`:含 LEAD) */
    const localOnlyAt = (sec: number): ReadonlySet<string> => {
      const all = localOnlyAll();
      if (!all.size) return NO_CLIPS;
      const out = new Set<string>();
      for (const id of all) {
        const c = clipById(id);
        if (c && cardMountedAt(c, sec)) out.add(id);
      }
      return out;
    };
    /**
     * 按这一拍的状态切占位符(product/rendering.md「兜底顺序」;T1~T4 的判据在 `placeholderHost.placeholderWanted`)。
     * **只切槽位的 `hidden`,不经 React 提交**;满 120 ms 才可见由占位组件的 CSS 负责。
     * T1 的「流这一拍 blank」按 `player.showingClips()` 当拍读 —— 所以每拍在 `presentStreams` 之后叫它。
     * 这台设备跑不了的卡(`localOnlyAt`)贴不上快照 / 流时显示 `unsupported`。
     * 没有任何来不及的层、也没有显示着的占位符时一个 DOM 查询都不做。
     */
    const refreshPlaceholders = (): void => {
      if (!placeholdersEnabled()) return;
      const { suppressed, snapshots, awaiting, settling } = ref.current;
      const unsupported = localOnlyAt(ref.current.t);
      if (!suppressed.size && !awaiting.size && !settling.size && !unsupported.size && !shownPlaceholders().size) return;
      const streamShowing = ref.current.streamPlanes.length ? player.showingClips() : NO_CLIPS;
      // 停下追帧时这张卡的流平面还画着:它不算「不可见地追帧」(T3),不显示占位符
      let settlingBlank = settling;
      if (settling.size && streamShowing.size) settlingBlank = new Map([...settling].filter(([id]) => !streamShowing.has(id)));
      const wanted = placeholderWanted({ suppressed, snapshots, awaiting, settling: settlingBlank, streamShowing, unsupported });
      /*
       * 超出预算的组流:整组只有一个位置矩形(成员的并集),每个成员的占位符都会铺在它上面。只留这一拍要显示占位符的成员里
       * 最上面的那一张(画家顺序里最后一个),其余的不显示。这一组这一帧没有位置矩形时不动(各自照老办法定位)。
       */
      if (wanted.size > 1 && player.hasOver) keepTopOfGroups(wanted, player.overGroups());
      applyPlaceholders(wanted, slotOf);
    };

    /**
     * 验收探针的逐拍记录(`scripts/probes/preview-fallback-probe.mjs`):`window.__pcFallbackTrace` 是数组时,
     * 每拍记下被抑制的每张卡落在兜底顺序的哪一级,以及这一拍主线程干活的毫秒数。不是数组时什么都不做。
     */
    const traceFallback = (sec: number, workMs: number): void => {
      const log = (window as unknown as { __pcFallbackTrace?: unknown[] }).__pcFallbackTrace;
      if (!Array.isArray(log)) return;
      const streams = player.levels();
      const now = realNow();
      const levels: Record<string, string> = {};
      for (const id of ref.current.suppressed) {
        const stream = streams.get(id);
        if (stream) levels[id] = stream;
        else if (ref.current.snapshots.has(id)) levels[id] = "snapshot";
        else if (shownPlaceholders().has(id)) levels[id] = now - (shownSince(id) ?? now) < PLACEHOLDER_SHOW_DELAY_MS ? "placeholder-delay" : "placeholder";
        else levels[id] = "transparent";
      }
      log.push({ sec, workMs, levels, snapshots: ref.current.snapshots.size, planes: ref.current.streamPlanes.length });
      if (log.length > 20000) log.splice(0, log.length - 20000);
    };

    /** 平面状态改了:同步一次 React 提交,让这一帧就带上新的类和平面;占位符跟着这一次的状态切 */
    const commitPlanes = () => {
      flushSync(() => bumpPlanes());
      refreshPlaceholders();
    };
    onStreamBoxes = () => { if (ref.current.role === "front") commitPlanes(); };

    /** 掐掉还在飞的 render:回包按 reason 给,不允许静默丢 */
    const abortPending = (reason: "superseded" | "project") => {
      const p = ref.current.pending;
      if (!p) return;
      ref.current.pending = null;
      p.resolve({ aborted: true, reason, elapsedMs: realNow() - p.startedAt, frames: p.frames() });
    };

    /**
     * 此刻活跃的卡里最早的那个挂载帧(秒)。
     *
     * **挂载时刻必须落在帧格上** —— 不然「预览所见 = 导出所得」在每个卡片入点都破一次。
     *
     * 导出是一帧一帧推的:一张卡在第一个 ≥ start-LEAD 的**帧**上挂载,时间原点就是那一帧,
     * 而不是 start-LEAD 本身。挂载帧统一由 frameWindow.mjs 的 mountFrameOf 给
     * (预览、导出、分片同一个算式)。夹一下:target 本身不在帧格上时,对齐后可能反超它。
     */
    const mountSecOf = (target: number, fps: number): number => {
      const p = ref.current.project;
      const active = p ? flattenOverlay(p).clips.filter((c) => cardMountedAt(c, target)) : [];
      return active.length
        ? Math.min(Math.min(...active.map((c) => mountFrameOf(c, fps))) / fps, Math.max(0, target))
        : Math.max(0, target);
    };

    /**
     * 重挂载定位:把此刻活跃的卡全部重挂载,时钟拨到它们里最早的挂载帧,空跑两拍。
     * 返回从哪一秒起推。render(jump) 用;legacy 的 setProject 也走它。
     */
    const remountAt = (target: number, fps: number): number => {
      const from = mountSecOf(target, fps);
      pinner.reset();
      clock.set(from * 1000);
      flushSync(() => {
        setToken((n) => n + 1);
        setT(from);
      });
      /*
       * **在 from 这一刻空跑两拍**,不是笔误。
       *
       * 第一拍跑卡片自己注册的 rAF —— 那里面才会把动画建起来(数字滚动的 useSpring 就是在
       * 这一拍里 .set() 的)。Motion 建完动画要到**下一拍**才做第一次推进,所以只跑一拍的话,
       * 补跑的第一格被拿去当了动画的起跑线,整条动画比导出慢一帧。
       *
       * 导出那边是白捡的:预热阶段先在挂载点空跑了一帧(warmUp 里 __pcRestartCards 之后那次
       * step(0)),等正式第 0 帧渲的时候动画早就上好膛了。这里补上同一拍,两边起跑线才一致。
       * 两拍的时刻相同,delta 为 0,不会让动画多走 —— 只是把「建立」和「推进」分开。
       */
      clock.tick(from * 1000);
      clock.tick(from * 1000);
      pinner.sync(from * 1000, skipWrappers());
      return from;
    };

    /**
     * legacy 路的跳转渲染(?preview=legacy):重挂载 + 异步逐帧补跑到 target,不回包。
     * 和第 3 步之前的 renderAt 一样;新路不走它。
     */
    const legacyJump = (target: number) => {
      const p = ref.current.project;
      if (!p) return;
      const fps = Math.max(1, p.fps || 30);
      remountAt(target, fps);
      const gen = ++renderGen.current;
      void (async () => {
        await clock.advanceToAsync(Math.max(0, target) * 1000, {
          step: 1000 / fps,
          abort: () => gen !== renderGen.current,
          onFrame: (ms) => flushSync(() => setT(ms / 1000)),
          afterFrame: (ms) => pinner.sync(ms, skipWrappers()),
        });
        if (gen !== renderGen.current) return;
        flushSync(() => setT(target));
        clock.tick(Math.max(0, target) * 1000);
        pinner.sync(Math.max(0, target) * 1000, skipWrappers());
        settle(target);
        scheduleSample();
      })();
    };

    /* ------------------------------------------ K3 / K5 第一路:按片段的子树虚拟时间追帧 */

    /** 项目里这个片段(入点出点) */
    const clipById = (clipId: string): { id: string; start: number; end: number } | null => {
      const p = ref.current.project;
      if (!p) return null;
      for (const tr of p.tracks) for (const c of tr.clips) if (c.id === clipId) return c;
      return null;
    };

    /** 这张卡的包裹层(`Stage` 挂的 `[data-pc-clip]`) */
    const wrapOf = (clipId: string): Element | null => {
      const root = rootRef.current;
      return root ? clipWrapper(root, clipId) : null;
    };

    /**
     * 实际生效的抑制集合 = 父页发来的,减去单舞台停下追一帧正在画 / 已画好的(`settleLive`),
     * 再减去流还没画出第一帧、先不藏的(`streamWaiting`)。
     * 只改 `ref.current`,不提交;调用方随后的那次提交(`commitPlanes` / `flushSync`)一起生效。整份换新(`Stage` 按引用判)。
     */
    const applySuppressed = (): void => {
      const parent = ref.current.parentSuppressed;
      const live = ref.current.settleLive;
      const waiting = ref.current.streamWaiting;
      ref.current.suppressed = live.size || waiting.size ? new Set([...parent].filter((id) => !live.has(id) && !waiting.has(id))) : parent;
    };

    /* ------------------------------------------ 重卡贴轨道流:等第一帧、追上以后撤抑制 */

    /** 这张卡此刻挂着的流平面(它自己的单卡流,或它所在的组流);没有回 null */
    const planeOf = (clipId: string): StreamPlaneGroup | null => {
      for (const g of ref.current.streamPlanes) if (g.clipIds.includes(clipId)) return g;
      return null;
    };
    /** 换一份 `streamWaiting`(整份换新),并按最早到时的那一张排真定时器:流一直画不出来也不能让原来的画面一直露着 */
    const setStreamWaiting = (next: ReadonlyMap<string, number>): void => {
      ref.current.streamWaiting = next;
      window.clearTimeout(ref.current.streamWaitTimer);
      ref.current.streamWaitTimer = 0;
      if (!next.size) return;
      const earliest = Math.min(...next.values());
      ref.current.streamWaitTimer = realSetTimeout(() => {
        ref.current.streamWaitTimer = 0;
        const now = realNow();
        // 到时限流还没画面:照父页说的藏起来,这一层落到占位符(兜底顺序尽头)
        endStreamWaiting([...ref.current.streamWaiting].filter(([, since]) => now - since >= STREAM_FIRST_WAIT_MS - 1).map(([id]) => id));
        if (ref.current.streamWaiting.size) setStreamWaiting(ref.current.streamWaiting);
      }, Math.max(1, earliest + STREAM_FIRST_WAIT_MS - realNow()));
    };
    /**
     * 这几张卡不再等流的第一帧(流画出来了、到时了、流平面撤了):现在真的藏起来(父页还点着名的),同一次提交里画面从原来的换成流。
     * 被推后的停下追帧(`deferredSettle`)这时起步。
     */
    const endStreamWaiting = (ids: readonly string[]): void => {
      const rest = new Map(ref.current.streamWaiting);
      let changed = false;
      for (const id of ids) if (rest.delete(id)) changed = true;
      if (!changed) return;
      setStreamWaiting(rest);
      applySuppressed();
      commitPlanes();
      let started = false;
      for (const id of ids) {
        const d = ref.current.deferredSettle.get(id);
        if (!d) continue;
        ref.current.deferredSettle.delete(id);
        if (d.gen !== catchUpGen.current || !ref.current.parentSuppressed.has(id)) continue;
        const task = startCatchUp(id, d.target * 1000, d.fps, true);
        if (task) { started = true; void runCatchUpAsync(task); }
      }
      // 追帧的起步重挂载了包裹层,流的画布换了一块:当场把画面画回去(`streamPlayer` 的 `redraw`)
      if (started) { presentStreams(ref.current.t); refreshPlaceholders(); }
    };
    /** 这几张卡不再被抑制(舞台自己撤:它们追到精确活渲了)。只改 `ref.current`,调用方提交 */
    const unsuppress = (ids: readonly string[]): void => {
      const parent = new Set(ref.current.parentSuppressed);
      let changed = false;
      for (const id of ids) if (parent.delete(id)) changed = true;
      if (changed) ref.current.parentSuppressed = parent;
      if (ids.some((id) => ref.current.streamWaiting.has(id))) {
        const rest = new Map(ref.current.streamWaiting);
        for (const id of ids) rest.delete(id);
        setStreamWaiting(rest);
      }
      applySuppressed();
    };
    /**
     * 这张卡追到精确活渲了:它的抑制由舞台自己撤,和摘 `.pc-settling` 同一次提交(父页收到 `settled` 再撤的话,中间那一个来回
     * 里它会先落回 `.pc-suppressed`、子树没有布局盒,刚追好的状态就废了)。流平面不撤:不抑制的卡的流平面是藏着的(`Stage`),
     * 留着它把播放头下这一帧先解好,按下播放头一拍就有;父页照旧发着它。回这一次该报 `settled` 的卡。
     *
     * **组流整组一起撤**:组里各卡的外观画在同一条流里,不能只撤一张。先追上的成员留在 `.pc-settling` 的样子里
     * (不可见、有布局盒、时间钉在目标帧),等组里此刻在场的都追上了一起露出来、一起报。
     * 单舞台停下追一帧画好的层另有 `settleLive` 管着,不动父页的那一份。
     */
    const releaseSettled = (clipId: string, targetMs: number): string[] => {
      if (ref.current.settleLive.has(clipId) || !ref.current.parentSuppressed.has(clipId)) return [clipId];
      const plane = planeOf(clipId);
      if (plane && plane.clipIds.length > 1) {
        const held = new Set(ref.current.settledHeld);
        held.add(clipId);
        const active = new Set(cardClipsAt(ref.current.t).map((c) => c.id));
        const members = plane.clipIds.filter((id) => active.has(id));
        if (!members.every((id) => held.has(id))) {
          ref.current.settledHeld = held;
          setSettlingAt(clipId, targetMs);
          return [];
        }
        for (const id of members) { held.delete(id); setSettlingAt(id, null); }
        ref.current.settledHeld = held;
        unsuppress(members);
        return members;
      }
      unsuppress([clipId]);
      return [clipId];
    };
    onStreamShowing = () => {
      if (ref.current.role !== "front") return;
      // 等着的卡里流画出来了的那几张:现在真的藏起原来的画面(同一个任务里换成流,中间不空)
      if (ref.current.streamWaiting.size) {
        const showing = player.showingClips();
        const done = [...ref.current.streamWaiting.keys()].filter((id) => showing.has(id));
        if (done.length) { endStreamWaiting(done); return; }
      }
      // 画面有无变了,占位符跟着切:暂停着没有下一拍来刷(帧是异步解出来的)
      refreshPlaceholders();
    };
    const setSettleLive = (next: ReadonlySet<string>): void => {
      ref.current.settleLive = next;
      applySuppressed();
    };
    /** 下一次跳转 / 播放 / 转后台:停下追一帧画的层全部回到父页的抑制(贴预渲染结果)。回有没有变 */
    const clearSettleLive = (): boolean => {
      if (!ref.current.settleLive.size) return false;
      setSettleLive(new Set());
      return true;
    };

    /** `settling` 表整份换一个(`Stage` 按引用判「谁刚变」) */
    const setSettlingAt = (clipId: string, stageMs: number | null): void => {
      const next = new Map(ref.current.settling);
      if (stageMs === null) next.delete(clipId);
      else next.set(clipId, stageMs);
      ref.current.settling = next;
    };

    /**
     * **重挂载定位配方**,片段粒度(K3;K3(a′) 向后跳、K3(a) 的重推、K5 第一路的起步都用它)。
     * 一步都不许省:
     *
     *   `resetIn(包裹层)` → 重挂载(`remountGen` 递增)+ `flushSync`
     *   → `clock.tick(clock.now())` **两次** → `pinner.syncIn(包裹层, mountMs)`
     *
     * `tick` 传**当前全局毫秒**、不是 `mountMs`:`tick(ms)` 先 `now = ms` 再排空 rAF 队列,
     * 传 `mountMs` 会把可见舞台的全局时钟拨回挂载帧、settle 结束后没人还原,
     * 下一次 `play` 第一拍要同步补 6000 ms。传当前值时钟不动,只是把队列排空 ——
     * 第一拍跑卡片自己注册的 rAF 把动画建起来,第二拍让 Motion 做第一次推进。
     *
     * 最后钉一次**挂载帧**锚点:`patchAnimate` 让新动画出生即 `pause()` + `currentTime = 0`,
     * 少了这一次锚点会记成目标毫秒、画面停在第 0 帧。
     *
     * **配方到钉挂载帧锚点为止**,之后怎么走由调用方定。
     */
    const remountClipRecipe = (clipId: string, mountMs: number): Element | null => {
      const before = wrapOf(clipId);
      if (before) pinner.resetIn(before);
      // 组件这一次要按**挂载帧**渲(`Stage` 的 `localTOf` 读 `settling`),所以先写表再提交
      setSettlingAt(clipId, mountMs);
      const next = new Map(ref.current.remountGen);
      next.set(clipId, (next.get(clipId) ?? 0) + 1);
      ref.current.remountGen = next;
      flushSync(() => bumpPlanes());
      clock.tick(clock.now());
      clock.tick(clock.now());
      const after = wrapOf(clipId);
      if (after) pinner.syncIn(after, mountMs);
      return after;
    };

    /** 一次按片段的追帧 */
    interface CatchUpTask {
      clipId: string;
      /** 已经推到的全局舞台毫秒 */
      stageMs: number;
      targetMs: number;
      stepMs: number;
      /** 追上之后 post `{ type: 'settled', clipIds: [clipId] }`(K5 第一路 / 重卡才要) */
      announce: boolean;
      gen: number;
      /** canvas 卡追到了、正在等这一拍的 `done`(R9 M3):等到之前不摘 `.pc-settling` */
      finishing?: boolean;
      /** 收摊时叫(单舞台停下追一帧用:没追上的层在同一次提交里回到抑制) */
      onEnd?: (caughtUp: boolean) => void;
    }

    /** 追帧被中止 / 追完:摘 `.pc-settling` */
    const endCatchUp = (task: CatchUpTask, caughtUp: boolean): void => {
      // 先让调用方改完抑制集合(`settleLive`),和摘 `.pc-settling` 同一次提交:没追上的层不会露出一帧旧的活组件
      const onEnd = task.onEnd;
      task.onEnd = undefined;
      try { onEnd?.(caughtUp); } catch { /* 收摊回调出错不影响收摊 */ }
      task.finishing = false;
      /*
       * 这一次追帧已经收过摊,或者已经被同一张卡后来的那一次顶掉了:不再动表里那一条和 `.pc-settling`。
       * 连着两次「停下」(刚暂停时父页常常隔一两毫秒发两次带 settle 的 `setTime`)就会走到这里:前一次的循环被 `abortCatchUps` 收过摊,
       * 它让出的那个宏任务醒来发现代数变了,又来收一次 —— 以前这一下把后来那一次的表项和 `.pc-settling` 一起摘了,那张卡的子树
       * 掉一拍布局盒(回到 `.pc-suppressed` 的 `display: none`),CSS 动画被取消、从那一步重新起跑,
       * 追完以后露出来的画面落后好几帧(`scrub-stream-probe` 第 3 步实测落后 10 帧)。
       */
      if (ref.current.catchUps.get(task.clipId) !== task) return;
      ref.current.catchUps.delete(task.clipId);
      setSettlingAt(task.clipId, null);
      let announce: string[] = [];
      if (caughtUp && task.announce) {
        // 贴着流的卡:抑制也由舞台自己撤(组流等整组),同一次提交
        announce = releaseSettled(task.clipId, task.targetMs);
      }
      commitPlanes();
      if (announce.length) postStageEvent({ type: "settled", sec: ref.current.t, clipIds: announce });
    };

    /**
     * 往前推几步。**只推它子树的本地时间**:每步 `stageMs += 1000 / fps`,
     * `pinner.syncIn(包裹层, stageMs)` + 给该组件 `t = stageMs / 1000`(`settling` 表)+ `flushSync`。
     * **全局时钟不动**,全局的 `pinner.sync(nowMs, skip)` 跳过 `.pc-settling` 子树(`skipWrappers`)。
     *
     * 回 `true` 表示追上了(或被中止),调用方该收摊。
     */
    const advanceCatchUp = (task: CatchUpTask, steps: number): boolean => {
      if (task.gen !== catchUpGen.current) {
        endCatchUp(task, false);
        return true;
      }
      if (task.finishing) return true;
      const wrap = wrapOf(task.clipId);
      for (let i = 0; i < steps && task.stageMs < task.targetMs; i++) {
        task.stageMs = Math.min(task.targetMs, task.stageMs + task.stepMs);
        if (wrap) pinner.syncIn(wrap, task.stageMs);
        setSettlingAt(task.clipId, task.stageMs);
        flushSync(() => bumpPlanes());
      }
      if (task.stageMs < task.targetMs) return false;
      /*
       * 追到目标那一步:锚点本来就在全局基上,交回全局 `pinner.sync` 天然连续,
       * 不需要额外动作 —— 摘了 `.pc-settling` 它就是精确的活组件。
       *
       * **canvas 卡要先等这一拍的 `done`**(R9 M3):追帧中间步不发 `beat`(被 `.pc-settling` 藏着),
       * 追上那一步发一拍、等位图贴上,再摘 `.pc-settling` —— 否则曝光的是上一拍的旧位图。
       */
      if (glPlanes.has(task.clipId)) {
        const pending = gl.beat({ strict: true, t: task.targetMs / 1000 });
        if (pending) {
          task.finishing = true;
          void pending.then(() => {
            if (!task.finishing || ref.current.catchUps.get(task.clipId) !== task) return;
            if (task.gen !== catchUpGen.current) { endCatchUp(task, false); return; }
            endCatchUp(task, true);
          });
          return true;
        }
      }
      endCatchUp(task, true);
      return true;
    };

    /**
     * 一路推到底,**每 8 步让出一个宏任务**(E4;让出点检查 `catchUpGen`)。
     * K3(b) 的跳转 / 拖动、K5 第一路的暂停态追帧走它。
     */
    const runCatchUpAsync = async (task: CatchUpTask): Promise<void> => {
      const breathe = () => new Promise<void>((r) => realSetTimeout(r, 0));
      for (;;) {
        if (advanceCatchUp(task, CATCHUP_YIELD_STEPS)) return;
        await breathe();
      }
    };

    /**
     * 一拍内推完(K3(a)):帧间**只让微任务**、不让宏任务 —— 微任务之间浏览器不绘制,
     * 所以中间态一帧都画不出来。`catchUpMs` 是估计值,所以带**墙钟兜底**:
     * 累计超过 `1000 / fps` 还没推完就改走 (b)(K3:不让主线程被估错的卡长时间占住)。
     */
    const runCatchUpSync = async (task: CatchUpTask, budgetMs: number): Promise<void> => {
      const started = realNow();
      for (;;) {
        if (advanceCatchUp(task, 1)) return;
        if (realNow() - started > budgetMs) {
          // 改走 (b):后面的步数每 8 步让一个宏任务,画面继续被 `.pc-settling` 藏着
          void runCatchUpAsync(task);
          return;
        }
        await Promise.resolve();
      }
    };

    /** 登记一个追帧任务:先走重挂载定位配方,再从挂载帧逐步推 */
    const startCatchUp = (clipId: string, targetMs: number, fps: number, announce: boolean): CatchUpTask | null => {
      const clip = clipById(clipId);
      if (!clip) return null;
      const mountMs = (mountFrameOf(clip, fps) / fps) * 1000;
      if (mountMs >= targetMs) return null;
      const old = ref.current.catchUps.get(clipId);
      if (old) endCatchUp(old, false);
      remountClipRecipe(clipId, mountMs);
      const task: CatchUpTask = { clipId, stageMs: mountMs, targetMs, stepMs: 1000 / fps, announce, gen: catchUpGen.current };
      ref.current.catchUps.set(clipId, task);
      return task;
    };

    /**
     * 单舞台停下追一帧(`render/settleFrame.ts`)的一层:把它从抑制里放出来、在 `.pc-settling` 下不可见地画到 `targetMs`
     * (直接定位的一步到位,推帧卡从入点逐帧推),画好了撤兜底(`endCatchUp(true)`:post `settled`)。
     * 画的时候兜底照常显示(占位符的 T3 管)。
     * 不设时限时 `deadline` 是 `Infinity`;给了时限(测试、诊断)到点还没画好:这一层回到抑制(贴预渲染结果或占位符),直到下一次停下。
     */
    const drawSettleLayer = async (item: SettleItem, deadline: number, targetMs: number, fps: number): Promise<DrawOutcome> => {
      const { clipId } = item;
      const gen = catchUpGen.current;
      let ended: boolean | null = null;
      let timedOut = false;
      const onEnd = (caughtUp: boolean) => {
        ended = caughtUp;
        // 没画好(到时限 / 被打断)的层回到父页的抑制;画好的留在 settleLive 里,直到下一次跳转或播放
        if (!caughtUp && ref.current.settleLive.has(clipId)) {
          const rest = new Set(ref.current.settleLive);
          rest.delete(clipId);
          setSettleLive(rest);
        }
      };
      setSettleLive(new Set([...ref.current.settleLive, clipId]));
      let task: CatchUpTask | null = null;
      if (item.kind === "catchup") {
        // 推帧卡:重挂载定位配方 + 从入点逐帧推(同 K5 第一路),每 8 步让一次宏任务
        task = startCatchUp(clipId, targetMs, fps, true);
      }
      if (!task) {
        // 直接定位:不可见地钉到目标,一次提交画好
        const old = ref.current.catchUps.get(clipId);
        if (old) endCatchUp(old, false);
        setSettlingAt(clipId, targetMs);
        flushSync(() => bumpPlanes());
        const wrap = wrapOf(clipId);
        if (wrap) pinner.syncIn(wrap, targetMs);
        task = { clipId, stageMs: targetMs, targetMs, stepMs: 1000 / fps, announce: true, gen };
        ref.current.catchUps.set(clipId, task);
      }
      task.onEnd = onEnd;
      // 画的时候兜底照常显示:暂停着没有下一拍来刷占位符,这里刷一次(T3:不可见地追帧、又没有快照或流在画的层显示占位符;
      // 「停下以后先显示占位……渲好一层替换一层」,`product/platforms.md` 的最低一档)
      refreshPlaceholders();
      const breathe = () => new Promise<void>((r) => realSetTimeout(r, 0));
      for (;;) {
        if (ended !== null) return ended ? "drawn" : timedOut ? "timeout" : "aborted";
        if (task.gen !== catchUpGen.current) { endCatchUp(task, false); continue; }
        if (realNow() >= deadline) {
          timedOut = true;
          endCatchUp(task, false);
          continue;
        }
        // 追上那一步 canvas 卡要等这一拍的 `done`(`finishing`),等的时候照样看时限
        advanceCatchUp(task, CATCHUP_YIELD_STEPS);
        if (ended !== null) continue;
        await breathe();
      }
    };

    /** 全部中止(新的 `setTime` / `play` / `setProject` / `setRole` / `setSuppressed` 都走它) */
    const abortCatchUps = (): void => {
      // 推后还没起步的、组流里先追上等着同组的,一并作废(后者回到抑制:流还贴着)
      ref.current.deferredSettle.clear();
      if (ref.current.settledHeld.size) {
        for (const id of ref.current.settledHeld) setSettlingAt(id, null);
        ref.current.settledHeld = new Set();
        if (!ref.current.catchUps.size) commitPlanes();
      }
      if (!ref.current.catchUps.size) return;
      for (const task of [...ref.current.catchUps.values()]) endCatchUp(task, false);
    };

    /**
     * K4 每一拍多推几步(K3(b) 的播放态追帧):每拍除本拍那一帧外最多再多推
     * `CATCHUP_STEPS_PER_BEAT` 步本地时间(即最快 5 倍速)。每拍的追帧成本按实测计入
     * K6 的一秒窗口 —— 追帧把窗口顶爆就由 K6 降最贵的那张。
     */
    const stepCatchUps = (fps: number): void => {
      if (!ref.current.catchUps.size) return;
      const nowMs = ref.current.t * 1000;
      for (const task of [...ref.current.catchUps.values()]) {
        // 播放中目标跟着播放头走:不然追上的那一刻它已经落后了
        task.targetMs = Math.max(task.targetMs, nowMs);
        task.stepMs = 1000 / fps;
        advanceCatchUp(task, CATCHUP_STEPS_PER_BEAT);
      }
    };

    /* ------------------------------------------------ K3:三条跳转路 */

    /** 这一刻活跃的**卡**片段(口径同 `Stage`:含 LEAD) */
    const cardClipsAt = (sec: number): { id: string; start: number; end: number }[] => {
      const p = ref.current.project;
      if (!p) return [];
      return flattenOverlay(p).clips
        .filter((c) => (c as { cardId?: string; nodeId?: string }).cardId || (c as { nodeId?: string }).nodeId)
        .filter((c) => cardMountedAt(c, sec));
    };

    const mountMsOf = (clip: { start: number; end: number }, fps: number): number => (mountFrameOf(clip, fps) / fps) * 1000;

    /**
     * 这张卡走哪一档 —— 用的是 K2 的 `clipWeight`,**和父页、预渲染进程同一份纯函数**
     * (`tuning` 随 `setPlan` 一起下来,两边系数一致)。
     * `tier`: `direct` / `seek`(a′) / `catchup-a`(a) / `catchup-b`(b) / `capped` / `over-catchup` / 声明兜底。
     */
    const tierOf = (clipId: string, fps: number) => {
      const sp = ref.current.plan;
      const record = sp?.byClip.get(clipId);
      return { tier: clipWeight(record, sp?.frameModes.get(clipId), fps, sp?.tuning).tier as string, record };
    };

    /** 拖动中向后重推的节流(E3):这张卡刚推过就保持上一状态 */
    const repushAllowed = (clipId: string, now: number): boolean => {
      if (!ref.current.scrubbing) return true;
      const last = ref.current.repushAt.get(clipId);
      if (last !== undefined && now - last < SCRUB_REPUSH_MS) return false;
      ref.current.repushAt.set(clipId, now);
      return true;
    };

    /**
     * K5 第一路的起步:`setTime(t, { settle: true })` 之后,`vtOk` 的**重卡**在可见舞台里
     * 用子树虚拟时间追到精确活渲。`vtOk = false` 的由父页走第二路(整场景在后台补跑后互换),
     * 舞台这边什么都不做。
     */
    const routeSettle = (target: number, fps: number, onlySuppressed = false): void => {
      const plan = ref.current.plan?.plan ?? null;
      const localOnly = localOnlyAll();
      const immediateSettled: string[] = [];
      const targetMs = target * 1000;
      for (const clip of cardClipsAt(target)) {
        if (onlySuppressed && (!ref.current.suppressed.has(clip.id) || ref.current.catchUps.has(clip.id))) continue;
        if (pipelineAt(plan, clip.id, target) !== "heavy") continue;
        // 这台设备跑不了的卡停下不追(没有组件可追),快照照贴着
        if (localOnly.has(clip.id)) continue;
        const { record } = tierOf(clip.id, fps);
        if (record?.vtOk !== true) continue;
        // 它的流还没画出第一帧、原来的画面还露着:追帧一起步子树就不可见了,所以等流的第一帧画出来(或到时)再追(`endStreamWaiting`)
        if (ref.current.streamWaiting.has(clip.id)) {
          ref.current.deferredSettle.set(clip.id, { target, fps, gen: catchUpGen.current });
          continue;
        }
        const mountMs = mountMsOf(clip, fps);
        if (mountMs >= targetMs) {
          // 停在挂载帧上（例如 t = 0 或片段起点）：此刻本来就是精确的初始帧，不需要追帧，立即解除抑制并报 settled
          const announced = releaseSettled(clip.id, targetMs);
          immediateSettled.push(...announced);
          continue;
        }
        const task = startCatchUp(clip.id, targetMs, fps, true);
        if (task) void runCatchUpAsync(task);
      }
      if (immediateSettled.length) {
        commitPlanes();
        postStageEvent({ type: "settled", sec: target, clipIds: [...new Set(immediateSettled)] });
      }
    };

    /**
     * K3 的三条跳转路(远跳 / 向后那一支;向前且 `dt < CONTINUOUS_MAX` 的连续路在 `setTime` 里
     * 已经由全局 `advanceTo` 走完了)。**可见舞台里永远看不到推帧过程。**
     *
     * - **(a′) `seekOk` 且 `seekMs ≤ B`**:直接定位。向前不用做什么(全局 `pinner.sync` 已经钉过);
     *   **向后**要先走重挂载定位配方 —— 越过结尾的动画被 `finish()` 收了、此后永久跳过,
     *   不重挂载就停在终态。
     * - **(a) `catchUpMs ≤ B`**:按片段重挂载 + 从 `mountFrameOf` 逐帧推,帧间**只让微任务**
     *   (中间态一帧都画不出来),带墙钟兜底,超了改走 (b)。
     * - **(b)**:`vtOk` 的在可见舞台里用子树虚拟时间追(每 8 步让宏任务,追上摘 `.pc-settling`);
     *   `vtOk = false` 的走 K5 第二路(父页的事)。
     */
    const routeJump = (target: number, fps: number): void => {
      const targetMs = target * 1000;
      const targetFrame = Math.round(target * fps);
      const now = realNow();
      const plan = ref.current.plan?.plan ?? null;
      for (const clip of cardClipsAt(target)) {
        const prevFrame = ref.current.lastTargetFrame.get(clip.id);
        const backwards = prevFrame !== undefined && targetFrame < prevFrame;
        ref.current.lastTargetFrame.set(clip.id, targetFrame);
        // 重卡在跳转里贴快照,追到活渲是 `settle` 的事(routeSettle)
        if (pipelineAt(plan, clip.id, target) === "heavy") continue;
        const { tier, record } = tierOf(clip.id, fps);
        if (tier === "direct" || tier === "declared-light") continue;   // 随机访问:跟着 setTime 走
        if (tier === "seek") {
          if (!backwards) continue;
          if (!repushAllowed(clip.id, now)) continue;
          const wrap = remountClipRecipe(clip.id, mountMsOf(clip, fps));
          // 一步到位:钉目标毫秒,组件 `t` 交回全局(把它从 `settling` 里拿掉)
          setSettlingAt(clip.id, null);
          if (wrap) pinner.syncIn(wrap, targetMs);
          commitPlanes();
          continue;
        }
        if (tier === "catchup-a") {
          if (!repushAllowed(clip.id, now)) continue;
          const task = startCatchUp(clip.id, targetMs, fps, false);
          if (task) void runCatchUpSync(task, 1000 / fps);
          continue;
        }
        if (tier === "catchup-b") {
          if (record?.vtOk !== true) continue;   // 第二路由父页发起
          if (!repushAllowed(clip.id, now)) continue;
          const task = startCatchUp(clip.id, targetMs, fps, false);
          if (task) void runCatchUpAsync(task);
        }
      }
    };

    /**
     * 播放头**刚进入**一张 (b) 档 `vtOk` 轻卡:让它从 `mountFrameOf` 起追(K3(b))。
     * 追上之前这一层透明 —— 轻卡没有快照平面,`.pc-settling` 是 `visibility: hidden`。
     */
    const enterCatchUps = (sec: number, fps: number): void => {
      const plan = ref.current.plan?.plan ?? null;
      const active = new Set<string>();
      for (const clip of cardClipsAt(sec)) {
        active.add(clip.id);
        if (ref.current.lastActive.has(clip.id)) continue;
        if (ref.current.catchUps.has(clip.id)) continue;
        if (pipelineAt(plan, clip.id, sec) !== "light") continue;
        const { tier, record } = tierOf(clip.id, fps);
        if (tier !== "catchup-b" || record?.vtOk !== true) continue;
        startCatchUp(clip.id, sec * 1000, fps, false);
      }
      ref.current.lastActive = active;
    };

    /* ------------------------------------------------ K1 的两趟布尔探针(vtOk / seekOk / seekMs) */

    /**
     * 这一张卡的包裹层(`Stage.tsx` 挂的 `[data-pc-clip]`)。
     *
     * 探针**只在缩水项目上跑**(K1:一条轨道一个 clip),所以舞台里恰好一棵卡片子树,
     * 第一个匹配就是最外层那个包裹层 —— 组合卡的部件包裹层嵌在它里面,
     * `getAnimations({ subtree: true })` 一并覆盖。`:not([data-pc-media])` 排掉素材层
     * (`FrameScene` 的素材层也带 `data-pc-clip`)。
     */
    const probeWrap = (): Element | null =>
      rootRef.current?.querySelector("[data-pc-clip]:not([data-pc-media])") ?? null;

    /**
     * **K3 的「重挂载定位配方」,片段粒度**(K1 的两趟布尔探针复位用;K3(a′) 向后跳、
     * K5 第一路起步是 R5 的事,用的是同一段)。一步都不许省:
     *
     *   `resetIn(包裹层)` → 重挂载(`remountGen` / 这里是 `playToken`)
     *   → `clock.tick(clock.now())` **两次** → `pinner.syncIn(包裹层, mountMs)`
     *
     * 为什么要复位:计时趟已经把这张卡推到了片段最后一帧,越过结尾的动画被
     * `pinAnimations` 的 `finish()` 收了、此后永久跳过 —— 不复位就是在终态实例上比对,
     * 两个布尔必然记 `false`。
     *
     * 为什么 `tick` 传 `clock.now()` 而不是 `mountMs`:`tick(ms)` 先 `now = ms` 再排空 rAF 队列,
     * 传别的值等于把全局时钟拨走。这里上一行刚 `clock.set(mountMs)`,两者正好相等,
     * 写成 `clock.now()` 是为了和 K3 里「当前全局毫秒」那条统一。
     *
     * 为什么最后要钉一次挂载帧锚点:`patchAnimate` 让新动画出生即 `pause()` + `currentTime = 0`,
     * 少了这一次,锚点会记成第一次 `syncIn` 的目标毫秒,画面停在第 0 帧。
     */
    const remountClipAt = (mountSec: number): Element | null => {
      const before = probeWrap();
      // 探针的缩水项目里只有这一张卡,没有包裹层(还没挂上)时退回整份重建
      if (before) pinner.resetIn(before);
      else pinner.reset();
      clock.set(mountSec * 1000);
      flushSync(() => {
        setToken((n) => n + 1);
        setT(mountSec);
      });
      clock.tick(clock.now());
      clock.tick(clock.now());
      const after = probeWrap();
      if (after) pinner.syncIn(after, mountSec * 1000);
      return after;
    };

    /**
     * 此刻这张卡的控件 HTML(比对的那一份)。`lossy > 0` 时回 null ——
     * WebGL 画布读不出像素、两趟都是空画布,比对没有意义,K1 明写这时两个布尔一律记 `false`。
     * 组合卡有多个控件,按文档序拼起来一起比(两趟序列化的是同一棵树,顺序一致)。
     * 分隔符用一条 HTML 注释:`compareSnapshotHtml` 的词法分析把它当一个 comment 记号逐字比,
     * 两边都有、位置一样,不会影响判定;比用不可打印字符省心(源码里留不可打印字符会让
     * git 把整个文件当二进制,而 R3 正在同时改这个文件)。
     */
    const probeControlHtml = (): string | null => {
      const root = rootRef.current;
      if (!root) return null;
      const snap = createSnapshot(root);
      if (snap.lossy > 0) return null;
      return snap.controls.map((c) => c.html).join("<!--pc-next-control-->");
    };

    /**
     * 两趟布尔探针(K1 / pinned 划分轴一「如何区分 SeekOK」)。四趟,各自先走复位配方:
     *
     *   1. **基线趟**:全局时钟从挂载帧逐帧推 8 帧,第 8 帧的控件 HTML 留在**内存里**
     *      (K1:不依赖父页回传)。推法和计时 / 快照趟逐字一致 —— 同一个 `advanceToAsync`、
     *      同一组 `onFrame` / `afterFrame`,否则比的就不是同一件事了。
     *   2. **`vtOk` 趟**:**不动全局时钟**,只 `pinner.syncIn(包裹层, 该帧的全局舞台毫秒)`
     *      + 给组件本地 `t`,推 8 帧。全局 rAF 队列没人排空,读全局帧循环时间戳的
     *      Motion JS 动画因此推不动 —— 这正是 `vtOk = false` 要抓的那一类。
     *      帧间同样只让微任务(和基线趟的 `advanceToAsync` 一致),不多让也不少让。
     *   3. **`seekOk` 趟**:一步钉到第 8 帧(不经 1～7 帧),再比。
     *   4. **`seekMs`**:从第 0 帧直接钉到片段最后一帧,`__pcRealNow` 量这一次的墙钟。
     *
     * 「给组件本地 `t`」在这里就是 `setT` —— 缩水项目里只有这一张卡,舞台的全局 `t` 就是它的
     * 本地时间基。R5 要在整份项目上对**单张**卡做同样的事时才需要 `Stage` 的 `settling` prop
     * (K5 第一路),探针不需要,所以这一步不碰 `Stage.tsx`。
     *
     * 各趟 `PROBE_BOOL_FRAMES` 帧或 `PROBE_BOOL_MS` 毫秒封顶;比对趟超了记 `false`,
     * 量 `seekMs` 那一趟超了记 `null`。**生成的快照一律不 post `probe-frame`**(K1)。
     */
    const runBooleanProbe = async (lastSec: number, fps: number, gen: number): Promise<{ booleans?: ProbeBooleans; aborted?: true }> => {
      const step = 1000 / fps;
      const mountSec = mountSecOf(lastSec, fps);
      const mountMs = mountSec * 1000;
      const frames = PROBE_BOOL_FRAMES;
      const stale = () => gen !== renderGen.current;
      /**
       * 帧间让出一个宏任务:让父页的 RPC 消息、iframe 自己的 resize 有机会进来(趟与趟之间用)。
       * 后台活停着时(C10 契约第 2 节)就在趟与趟之间等,不在一趟里面停(一趟的墙钟就是量的数)。
       */
      const breathe = async () => {
        await new Promise<void>((r) => (window.__pcRealSetTimeout ?? window.setTimeout)(r, 0));
        const g = backGate(stale);
        if (g) await g;
      };

      /* ---- 1. 基线趟:全局时钟推 8 帧 ---- */
      { const g = backGate(stale); if (g) await g; }
      if (stale()) return { aborted: true };
      remountClipAt(mountSec);
      let pushed = 0;
      const baseStarted = realNow();
      await clock.advanceToAsync(mountMs + frames * step, {
        step,
        maxCatchUp: Infinity,
        abort: () => stale() || pushed >= frames || realNow() - baseStarted > PROBE_BOOL_MS,
        onFrame: (ms) => flushSync(() => setT(ms / 1000)),
        afterFrame: (ms) => {
          pinner.sync(ms);
          pushed++;
        },
      });
      if (stale()) return { aborted: true };
      // canvas 卡:比对前这一帧的位图要贴上(R9 M3:K1 探针生成快照的每一帧都发 beat)
      await glStrict(clock.now() / 1000);
      // 第 8 帧之前就被截断的卡没有基线,两个布尔一律记 false、不比对(K1)
      const baseline = pushed >= frames ? probeControlHtml() : null;

      /* ---- 2. vtOk 趟:只推子树虚拟时间 ---- */
      await breathe();
      if (stale()) return { aborted: true };
      let vtHtml: string | null = null;
      if (baseline !== null) {
        const wrap = remountClipAt(mountSec);
        const vtStarted = realNow();
        let done = 0;
        for (let k = 1; k <= frames; k++) {
          // 和基线趟的 advanceToAsync 一样:帧间只让微任务(Motion 解析关键帧要一个边界)
          await Promise.resolve();
          if (stale()) return { aborted: true };
          if (realNow() - vtStarted > PROBE_BOOL_MS) break;
          const ms = mountMs + k * step;
          if (wrap) pinner.syncIn(wrap, ms);
          flushSync(() => setT(ms / 1000));
          done++;
        }
        if (done >= frames) {
          await glStrict(ref.current.t);
          vtHtml = probeControlHtml();
        }
      }
      const vtOk = baseline !== null && vtHtml !== null && compareSnapshotHtml(baseline, vtHtml).same;

      /* ---- 3. seekOk 趟:一步钉到第 8 帧 ---- */
      await breathe();
      if (stale()) return { aborted: true };
      let seekHtml: string | null = null;
      if (baseline !== null) {
        const wrap = remountClipAt(mountSec);
        const seekStarted = realNow();
        const ms = mountMs + frames * step;
        if (wrap) pinner.syncIn(wrap, ms);
        flushSync(() => setT(ms / 1000));
        await glStrict(ms / 1000);
        if (realNow() - seekStarted <= PROBE_BOOL_MS) seekHtml = probeControlHtml();
      }
      const seekOk = baseline !== null && seekHtml !== null && compareSnapshotHtml(baseline, seekHtml).same;

      /* ---- 4. seekMs:第 0 帧直接钉到最后一帧的墙钟 ---- */
      await breathe();
      if (stale()) return { aborted: true };
      const wrap = remountClipAt(mountSec);
      const lastMs = Math.max(mountMs, lastSec * 1000);
      const seekStarted = realNow();
      if (wrap) pinner.syncIn(wrap, lastMs);
      flushSync(() => setT(lastMs / 1000));
      const elapsed = realNow() - seekStarted;
      ref.current.t = lastMs / 1000;

      return { booleans: { vtOk, seekOk, seekMs: elapsed > PROBE_BOOL_MS ? null : elapsed } };
    };

    /* ------------------------------------------------------------------ K4 节拍器 */

    /**
     * 这一拍的账(K6 的一秒窗口),顺带判要不要降级(**只降不升**)。每张卡的耗时来自
     * `<Profiler>`(`FrameScene` 的 live 路每个片段一个,E7),每拍清空一次。
     *
     * 超时怎么算、`pendingDemote` 的卡为什么不计入、降哪一张,都在 `beatLoop.mjs` 的
     * `noteK6Beat`。降了一张就 post `{ type: 'demote', clipId }`,父页查旧记录整条 PUT
     * `{ ...旧记录, capped: true, demoted: true }`。「最贵」按实测算、不按探针的 `stepMs`。
     */
    const noteBeat = (beatCost: number, fps: number, sec: number): void => {
      const worst = noteK6Beat(ref.current.k6, {
        at: realNow(),
        beatCost,
        byClip: ref.current.cardCost,
        fps,
        sec,
        plan: ref.current.plan?.plan ?? null,
      });
      if (worst) postStageEvent({ type: "demote", clipId: worst });
    };

    /**
     * 停下节拍循环,并把等着的 `pause()` 回包落定。
     *
     * **三处入口**:`pause()`(立即停)、武装停到达、`setRole('back')` / 播放到头。
     * 不管从哪儿来,挂着的 RPC 都必须回包 —— 循环停了没人再去 resolve 它们。
     */
    const settleBeatWaiters = (): void => {
      const armed = ref.current.beatArmed;
      const waiters = ref.current.beatWaiters;
      ref.current.beatArmed = null;
      ref.current.beatWaiters = [];
      const stoppedAt = ref.current.beatLastSec;
      if (armed) {
        window.clearTimeout(armed.timer);
        armed.resolve({ ok: true, stoppedAt });
      }
      for (const resolve of waiters) resolve({ ok: true, stoppedAt });
    };

    /** 停循环(`setRole('back')`、`pause()`、播放到头都走它) */
    const stopBeat = (): void => {
      ref.current.beatPaused = true;
      if (!ref.current.beatRunning) settleBeatWaiters();
    };

    /**
     * 节拍循环(K4)。**只有 `front` 跑**,每拍:
     *
     *   `t += 1 / fps` → `clock.advanceTo(t × 1000, { step: 1000 / fps })` 推轻卡并提交
     *   → 贴平面(平面状态在 `ref` 里,和 `setT` 同一次提交) → 等**真实**一帧
     *   → 补一拍落定(`clock.tick` + `pinner.sync`,让 Motion 把新值写回 DOM)
     *   → post `{ type: 'frame', sec }` → 下一拍。
     *
     * **节拍按绝对时刻排**:`nextDue = playStart + n × 1000 / fps`(`__pcRealNow`),
     * 一拍的活干完之后 `await __pcRealRaf()` 直到 `__pcRealNow() ≥ nextDue − 1 ms`。
     * 60 Hz 屏上一次 rAF 只有 16.6 ms,30 fps 等一次等不满一拍,所以是个循环;
     * 24 / 25 fps 自然落成 2 / 3 帧交替,均值仍是 1000 / fps。
     *
     * **慢帧就等**:只有**这一拍的活本身**超过了 `nextDue` 才把时间轴整体后移
     * (`playStart += 超出量`),不补、不跳帧、不往前冲 —— 所以连续两条 `frame` 的
     * `sec` 差恒为 1/fps。等 rAF 那一下的粒度溢出**不后移**:每拍都后移一点的话,
     * 30 fps 以外的帧率会被一路推成「每拍整数个垂直同步」,均值就不是 1000/fps 了。
     */
    const runBeatLoop = async (fromSec: number): Promise<void> => {
      const p = ref.current.project;
      if (!p) return;
      const fps = Math.max(1, p.fps || 30);
      const period = 1000 / fps;
      const duration = Math.max(0, Number(p.duration) || 0);
      /** 平时等真帧的上限:一拍,至少 20 ms */
      const rafBudget = Math.max(20, period);
      /** 连着几拍没等到真帧了(被节流的 iframe 会一直等不到) */
      let rafMisses = 0;
      // 拍序号按帧格算,`sec` 一律是 `帧号 / fps` —— 连续累加浮点会飘
      const fromFrame = Math.round(fromSec * fps);
      let playStart = realNow();
      ref.current.beatRunning = true;
      try {
        for (let n = 1; ; n++) {
          // 每拍开头查 `paused` / 角色(E0)
          if (ref.current.beatPaused || ref.current.role !== "front") break;
          const { sec, frame, ended } = beatAt(fromFrame, n, fps, duration);
          const beatStarted = realNow();

          /* ---- 一拍的活 ---- */
          ref.current.t = sec;
          ref.current.cardCost.clear();
          flushSync(() => setT(sec));
          clock.advanceTo(sec * 1000, { step: period, onFrame: (ms) => pinner.sync(ms, skipWrappers()) });
          // 重卡贴流(K5 / G5):这一拍的帧手里有就当场画上,没有就留着上一张或透明 —— 从不等它
          presentStreams(sec);
          // K3(b) 的播放态追帧:这一拍除了本拍那一帧,再多推几步它自己的本地时间
          enterCatchUps(sec, fps);
          stepCatchUps(fps);
          // 兜底顺序的尽头(T1~T4):流这一拍 blank、又没挂快照的层显示占位符;当拍判,不等下一次分派
          refreshPlaceholders();
          traceFallback(sec, realNow() - beatStarted);
          /*
           * canvas 卡(R9 M3,一拍的顺序写死):DOM 提交完 → `beat` → **`await done`(慢帧就等在这里)**
           * → 位图贴到各平面(`glHost` 里做)→ 等真帧 → post `frame`。`done` 偶有几十毫秒的尖峰,
           * 等它就是 K4 的「慢帧就等」:这一拍变长,下面的排拍把时间轴整体后移,不跳帧。
           * Worker 真卡死时 `glHost` 1 秒后放行,平面留上一张,循环不会挂住。
           */
          const glBeat = gl.beat({ t: sec });
          if (glBeat) await glBeat;
          /*
           * 等真实一帧,**带超时**(见 `realRafOrAfter`)。连着几拍都等不到就认定这个 iframe
           * 被浏览器节流了 —— 那时画面本来就不在刷,再为它等只会把拍长拖成节流周期;
           * 改成只让一个宏任务(Motion 解析关键帧要的是任务边界,不是真帧)。
           */
          const painted = await realRafOrAfter(rafMisses >= RAF_MISS_GIVEUP ? RAF_GIVEUP_MS : rafBudget);
          rafMisses = painted ? 0 : rafMisses + 1;
          /*
           * 补一拍落定。`settle()` 排的是微任务,而这里本来就在 `await` 之后 ——
           * 直接同步做完即可,顺手作废还挂着的那一次(又渲了一帧,上一次补拍不作数)。
           */
          settleGen.current++;
          clock.tick(sec * 1000);
          pinner.sync(sec * 1000, skipWrappers());
          const beatCost = realNow() - beatStarted;

          // post `frame` 之前再查一次角色(E0):互换那一拍新 `back` 不能还在报
          if (ref.current.role !== "front") break;
          ref.current.beatLastSec = sec;
          ref.current.beatLastFrame = frame;
          if (ended) {
            postStageEvent({ type: "ended", sec: duration });
            break;
          }
          postStageEvent({ type: "frame", sec });
          noteBeat(beatCost, fps, sec);

          // 武装停(E0):post 完 `frame(atSec)` 那一拍就停在那一帧,平面不摘
          const armed = ref.current.beatArmed;
          if (armed && ref.current.beatLastFrame >= armed.frame) break;

          /* ---- 等到下一拍的绝对时刻 ---- */
          const next = scheduleNextBeat(playStart, n, period, realNow());
          playStart = next.playStart;
          const { nextDue } = next;
          if (!next.late) {
            while (realNow() < nextDue - BEAT_SLACK_MS) {
              await realRafOrAfter(Math.max(BEAT_SLACK_MS, nextDue - realNow()));
              if (ref.current.beatPaused || ref.current.role !== "front") break;
            }
          }
        }
      } finally {
        ref.current.beatRunning = false;
        ref.current.beatPaused = true;
        settleBeatWaiters();
      }
    };

    /*
     * 后台活的开始 / 停止(C10 契约第 2 节):编辑器页判空闲,经 `setBackWork` 发来。停着时后台活在帧与帧之间等
     * (不推、不丢),恢复了接着推;被新的 render / setProject 掐掉(`stale`)也不再等。桌面运行环境从不发它,永远开着。
     */
    const backWork = { on: true, waiters: new Set<() => void>() };
    const backGate = (stale: () => boolean): Promise<void> | undefined => {
      if (backWork.on || ref.current.role !== "back") return undefined;
      return new Promise<void>((resolve) => {
        const done = () => { backWork.waiters.delete(done); clearInterval(poll); resolve(); };
        // 掐断(新的 render、setProject)或角色变了也要放行,不然 RPC 永不回包
        const poll = (window.__pcRealSetInterval ?? window.setInterval.bind(window))(() => {
          if (backWork.on || stale() || ref.current.role !== "back") done();
        }, 50) as unknown as number;
        backWork.waiters.add(done);
      });
    };


    /*
     * M7 生成快照(`bakeFrame`,契约第 4.3 节):代数(`bakeCancel`、新的一帧作废在飞的那一帧)与顺推的接续点
     * (上一帧推到了哪一帧、在哪份项目上;项目换了对象就接不上,从头推)。
     */
    let bakeGen = 0;
    let bakeCursor: { project: Project; clipId: string; frame: number } | null = null;
    /** 落定时看舞台的 DOM 这一轮变没变(只在 `bakeSettle` 里挂着) */
    let bakeMutations: MutationObserver | null = null;
    /** 落定最多做几轮(同导出页的 `settleDom`) */
    const BAKE_SETTLE_ROUNDS = 4;
    /**
     * 把已经排下、还没提交的 React 更新提交完(`bakeFrame` 推的每一帧都做,见那里的 `frameEnd`)。
     *
     * 卡片在每帧的回调里改状态(进度值、打了几个字、第几个词)、Motion 在动画结束的回调里换人,React 都不当场提交,
     * 交给调度器排到后面的宏任务里。不管它的话,这次提交落在哪一帧就看两帧之间隔了多久:顺着做时快照里是上一帧的值,
     * 从头推时又是这一帧的;换进来的元素哪一帧开始动也跟着差一帧(`docs/reports/AGENT-rr-a1-verify.md`「原因三」)。
     * 导出页每帧都排空(`snapshotSettle.ts` 的 `settleDom`),这里是同一件事。
     *
     * 一轮两步:
     *   1. 让出一个宏任务。改状态的那一下常常藏在一串 Promise 回调后面(Motion 的「全部退场动画播完」),
     *      微任务链走完它才真的发生;一个宏任务的边界把这条链排空。
     *   2. 同步提交一次(`flushSync` 带一次真的状态变化)。这一次渲染会把同一棵树上排着的更新一起做掉,
     *      提交之后的副作用(Motion 在那里起新动画)也当场跑完。**不靠等调度器**:它的任务排在哪条消息后面、
     *      提交完要不要先让浏览器画一帧再跑副作用,都不归这里管;同步提交则只由这里说了算,每次都落在这一帧的时刻上。
     * 这一轮里 DOM 变了就再做一轮(副作用里可能又改了状态),不变就够了;最多 `BAKE_SETTLE_ROUNDS` 轮。
     * 让出用 MessageChannel 不用定时器:连着等的定时器每次至少 4 毫秒,后台页面的定时器还会被浏览器降速。
     */
    const bakeSettle = async (): Promise<void> => {
      const root = rootRef.current;
      if (root) {
        bakeMutations ??= new MutationObserver(() => {});
        bakeMutations.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      try {
        for (let round = 0; round < BAKE_SETTLE_ROUNDS; round++) {
          await probeTaskBoundary();
          flushSync(() => bumpPlanes());
          if (!root || !bakeMutations?.takeRecords().length) return;
        }
      } finally {
        bakeMutations?.disconnect();
      }
    };
    /**
     * 舞台这一侧的生成快照诊断(契约第 7 节「舞台」,`__pcStageDiag().bake`):逐帧耗时(不含被门挡住的时长)、
     * 被门挡住的时长单记、从头推的次数、没成的原因计数。
     */
    const bakeStats = { frames: 0, ms: [] as number[], pausedMs: 0, remounts: 0, smallMs: [] as number[], errors: {} as Record<string, number> };
    const bakeFail = <R extends { ok: false; reason: string }>(r: R): R => { bakeStats.errors[r.reason] = (bakeStats.errors[r.reason] ?? 0) + 1; return r; };
    const q = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10; };
    /** 就绪闸的上限(照预渲染 `waitFrameReady`:控件异步活、字体、图片都就绪才生成快照) */
    const BAKE_READY_MAX_MS = 20_000;
    /**
     * 每帧生成快照之前的就绪闸(M7 探针 P2 之后主会话裁定,照预渲染 `server/bakery/frame-ready.mjs` 的 `waitFrameReady`):
     * 控件的异步活、字体、图片都就绪才生成快照;等的时候照样给同一时刻的拍(不推时间,靠 rAF 装载的控件要拍才走得动);
     * 控件报错、或 `BAKE_READY_MAX_MS` 之内没就绪,回不就绪 —— 这一段 `fail`,不出空白帧。
     */
    const bakeReady = async (stale: () => boolean): Promise<{ ok: true } | { ok: false; detail: string }> => {
      const t0 = realNow();
      let failure: string | null = null;
      let done = false;
      const gate = (async () => {
        do {
          await waitForFrameWork();
          // 先排一次版,新挂上的文字才会开始装字体
          document.documentElement.getBoundingClientRect();
          await document.fonts.ready;
          await Promise.all([...document.images].filter((img) => img.getAttribute("src") || img.getAttribute("srcset")).map((img) => img.decode().catch(() => {})));
          // 一个装载做完可能在 React 提交里又挂上另一个控件
        } while (frameWorkStatus().length > 0 || document.fonts.status !== "loaded");
      })().catch((e) => { failure = String((e as Error)?.message ?? e); }).finally(() => { done = true; });
      while (!done) {
        await Promise.race([gate, new Promise<void>((r) => realSetTimeout(r, 4))]);
        if (done || stale()) break;
        if (realNow() - t0 > BAKE_READY_MAX_MS) {
          return { ok: false, detail: `控件、字体或图片在 ${Math.round(BAKE_READY_MAX_MS / 1000)} 秒内未就绪:${frameWorkStatus().map((w) => w.label).join("、") || (document.fonts.status !== "loaded" ? "字体" : "图片")}` };
        }
        clock?.tick(clock.now());
      }
      if (failure) return { ok: false, detail: failure };
      return { ok: true };
    };
    const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");

    const api: StageRpcApi = {
      /**
       * 换项目文档。patch 复用 A7 的 changedClips 结构,合并时**保持未变片段的对象引用**
       * (applyProjectPatch 就是这么做的);full 带 reset。
       * 两种角色都**不再**按跳转重算这一帧:front 只更新项目(第 4 步 D5 接「按 changedClips
       * 让变了的层重新查索引」);back 在飞的探针推帧被掐断后回 { aborted, reason: 'project' }。
       */
      async setProject(next, opts = {}) {
        const prev = ref.current.project;
        let full: Project;
        if (isProjectPatch(next)) {
          if (next.kind === "full") full = next.project;
          else {
            if (!prev) throw new Error("setProject: 收到增量补丁但舞台上还没有项目(先发一份 full)");
            full = applyProjectPatch(prev, next);
          }
        } else {
          full = next;
        }
        if (opts.reset || full !== prev) {
          // clipId 会在不同项目里复用,不清掉就会张冠李戴
          if (full !== prev) { resetInk(); resetPlaceholderGeometry(); }
        }
        const prevKey = ref.current.layoutKey;
        const nextKey = layoutKeyOf(full);
        ref.current.project = full;
        ref.current.layoutKey = nextKey;
        // R9:项目选项的路线(生效值;切了就重建 glHost 那一侧的连接,M2 / 约束第 1 条)。在线页面的路线跟舞台闸门走,不看项目选项
        gl.setRoute(ONLINE ? onlineGlRoute : resolveGlRoute(full.glRoute));
        flushSync(() => setProject(full));
        // 画幅可能变了:素材效果卡的图形能力(最大纹理尺寸那一条)按新的长边重判
        if (!prev || prev.width !== full.width || prev.height !== full.height) cardExec.runtime?.refreshGraph();
        window.clearTimeout(ref.current.settle);
        // 项目变了,在飞的补跑作废:探针会按新项目重发
        renderGen.current++;
        projectGen.current++;
        abortPending("project");
        // 换项目同样中止第一路追帧(K5:五个 RPC 各递增一次)
        catchUpGen.current++;
        abortCatchUps();
        if (LEGACY) {
          if (prevKey !== nextKey) {
            legacyJump(ref.current.t);
          } else {
            const changed = changedCardClips(prev, full);
            const tt = ref.current.t;
            if (changed.length && changed.some((c) => cardMountedAt(c, tt))) {
              ref.current.settle = realSetTimeout(() => legacyJump(ref.current.t), SETTLE_MS);
            }
          }
        }
        return { ok: true as const };
      },

      /**
       * 拨到 tSec(暂停 / 拖动的唯一入口)。独立路径,不复用 render:
       *   clock.set → flushSync(setT) → pinner.sync → settle。不递增 playToken,组件实例不变。
       * 唯一例外:往前且不到 CONTINUOUS_MAX 秒,按连续播放用 advanceTo 同步推几帧(≤ 30 步)。
       * 远跳或向后一律不 advanceTo(会同步空转几百次 tick)。
       * probe: 一律走跳转路径(量的必须是单帧),跨任务边界后生成控件快照,回包带 elapsedMs。
       *
       * **`snapshots` / `awaiting` 和 `t` 在同一次 React 提交里生效**(E0):拖过一张 stateful 卡的
       * 入点时,新挂载的组件和它的快照平面同帧出现,不闪初始态。所以这两样在 `flushSync(setT)`
       * **之前**写进 `ref.current` —— 渲染读的就是它。`settle` 是 K5 的暂停态活渲(R5)。
       */
      async setTime(tSec, opts = {}) {
        /*
         * 角色闸门(E1)。带 `probe: true` 的这一支量的是 K1 的成绩,只有后台舞台能接 ——
         * 可见舞台正在给用户播画面,在它上面跑探针既量不准(要和用户的交互抢主线程),
         * 又会把画面拨到探针的时刻去。不带 `probe` 的 `setTime` 两种角色都收
         * (拖动发给 `front`、D4 的页面侧测量发给 `back`),所以闸门只挡 `probe`。
         */
        if (opts.probe && ref.current.role !== "back") return { aborted: true, reason: "role" as const };
        // 后台活停着(C10 契约第 2 节):探针的这一帧等恢复了再量(等的时间不算进耗时)
        if (opts.probe) { const g = backGate(() => ref.current.role !== "back"); if (g) await g; }
        const target = Math.max(0, Number(tSec) || 0);
        const started = realNow();
        const p = ref.current.project;
        const prev = ref.current.t;
        const dt = target - prev;
        ref.current.t = target;
        ref.current.wantedSettle = !!opts.settle;
        if (!p) return { path: "set" } satisfies SetTimeReply;
        // 暂停 / 拖动时来了 setTime,就没有「还在飞的补跑」这回事了
        renderGen.current++;
        abortPending("superseded");
        // 新的 setTime 中止正在进行的第一路追帧(K5:五个 RPC 各递增一次)
        catchUpGen.current++;
        // 单舞台:上一次停下画好的层回到抑制(拖动、跳转时贴预渲染结果;停下时父页再发 settleLayers)
        clearSettleLive();
        abortCatchUps();
        const fps = Math.max(1, p.fps || 30);

        if (!opts.probe && dt >= 0 && dt < CONTINUOUS_MAX) {
          // 连续播放:接着往下跑一两帧就行(≤ 30 步,同步)。轻卡跟着全局时钟走,K3 不用再分路
          flushSync(() => setT(target));
          clock.advanceTo(target * 1000, { step: 1000 / fps, maxCatchUp: CONTINUOUS_MAX * 1000, onFrame: (ms) => pinner.sync(ms, skipWrappers()) });
          for (const clip of cardClipsAt(target)) ref.current.lastTargetFrame.set(clip.id, Math.round(target * fps));
          settle(target);
          scheduleSample();
          if (opts.settle) routeSettle(target, fps);
          presentStreams(target);
          refreshPlaceholders();
          // 同步的 advanceTo 不逐步发 beat,只在它结束后发一次带终点 t 的(K3(a) / M3)
          void gl.beat({ t: target });
          return { path: "continuous" } satisfies SetTimeReply;
        }

        clock.set(target * 1000);
        flushSync(() => setT(target));
        pinner.sync(target * 1000, skipWrappers());
        settle(target);
        scheduleSample();
        if (!opts.probe) {
          // K3 的三条跳转路;`settle: true` 时再起 K5 第一路
          routeJump(target, fps);
          if (opts.settle) routeSettle(target, fps);
          presentStreams(target);
          refreshPlaceholders();
          // `setTime` 落定那一帧发一拍(M3;点时间轴一次只发这一拍)
          void gl.beat({ t: target });
        }
        if (opts.probe) {
          /*
           * K1 的四个数(任务书 3.8)。`stepMs` 在任务边界之前取；异步提交和生成快照
           * 的等待都不属于活渲单帧成本。
           */
          // canvas 卡的 `stepMs` 含 `beat → done` 往返(M4):两条路线量级不同,所以路线进 `device`
          const glDone = await (gl.beat({ strict: true, measure: true, t: target }) ?? undefined);
          const stepMs = realNow() - started;
          // 快照读 computed style 时会同步刷新样式；GL 位图已由严格 beat 等到。
          // 真 rAF 在隐藏的后台舞台可能一秒才来一次，逐样本等待会把 16 帧拖成 16 秒。
          await probeTaskBoundary();
          const root = rootRef.current;
          const snap = root ? createSnapshot(root).timing : { inlineMs: 0, rasterMs: 0, serializeMs: 0 };
          return { path: "set", elapsedMs: realNow() - started, stepMs,
            snapshot: { inlineMs: snap.inlineMs, rasterMs: snap.rasterMs, serializeMs: snap.serializeMs },
            ...(glDone?.gpuMs ? { glGpuMs: glDone.gpuMs } : {}) } satisfies SetTimeReply;
        }
        return { path: "set" } satisfies SetTimeReply;
      },

      /**
       * 后台舞台的补跑(K1 探针 / K3(b) 续推)。
       *   jump: true  —— 重挂载并从 mountFrameOf 推到 tSec;
       *                  `probe: 'snapshot'`(或 `true`)每推一帧就生成控件快照并 post `probe-frame`,
       *                  maxFrames 到或累计墙钟超过 B(1000/fps×70%)就截断;
       *                  `probe: 'time'` 只推进、不生成快照、不 post,按 PROBE_MAX_FRAMES /
       *                  PROBE_MAX_MS 封顶,回包带每帧的活渲耗时 `steps`(K1 的计时趟)。
       *                  截断都回 { aborted: true, reason: 'timeout', elapsedMs, frames, truncated: true }。
       *   jump 缺省   —— 续推:不重挂载、不动 playToken,从 clock.now() 推到 tSec;
       *                  tSec 在当前时刻之前直接回 { aborted, reason: 'superseded' }。
       * Promise 在推完之后才 resolve;被新 render 掐掉回 'superseded',被 setProject 掐掉回 'project'。
       */
      async render(tSec, opts = {}) {
        /*
         * 角色闸门(E1)。`render` 会重挂载整台戏、逐帧推过去 —— 落在可见舞台上就是
         * 用户眼前的画面从入点重播一遍。父页本来就只发给 `back`,这道闸门是**兜底**:
         * 角色互换(K5)那一拍父页手里的「谁是 back」可能比舞台晚一步,宁可回
         * `{ aborted: true, reason: 'role' }` 让父页当错误,也不能让可见舞台开始推帧。
         * 父页收到 `role` 不重发 —— 重发也还是同一个角色。
         */
        if (ref.current.role !== "back") return { aborted: true, reason: "role" } satisfies RenderReply;
        const target = Math.max(0, Number(tSec) || 0);
        const started = realNow();
        const p = ref.current.project;
        if (!p) return { aborted: true, reason: "project", elapsedMs: 0 } satisfies RenderReply;
        const fps = Math.max(1, p.fps || 30);
        const probeMode = opts.probe === true ? "time" : opts.probe || null;
        const timing = probeMode === "time";
        const maxFrames = opts.maxFrames ?? (timing ? PROBE_MAX_FRAMES : Infinity);

        const gen = ++renderGen.current;
        abortPending("superseded");
        window.clearTimeout(ref.current.settle);

        /*
         * 两趟布尔探针走自己那一支:它不是「推到 tSec」,而是四趟各自复位再比对
         * (K1)。`tSec` 在这里的含义是**片段最后一帧**,只用来量 `seekMs`。
         * 掐断和别的探针一样按 `renderGen` 判,回 `superseded` / `project`。
         */
        if (probeMode === "booleans") {
          const pg = projectGen.current;
          const out = await runBooleanProbe(target, fps, gen);
          const elapsedMs = realNow() - started;
          if (out.aborted || gen !== renderGen.current) {
            // 和别的路一样:被 setProject 掐的回 'project',被新 render 掐的回 'superseded'
            return { aborted: true, reason: projectGen.current !== pg ? "project" : "superseded", elapsedMs } satisfies RenderReply;
          }
          scheduleSample();
          return { remounted: true, caughtUpAtSec: clock.now() / 1000, elapsedMs, stepMs: elapsedMs,
            booleans: out.booleans } satisfies RenderReply;
        }

        let remounted = false;
        if (opts.jump) {
          remountAt(target, fps);
          remounted = true;
        } else if (target * 1000 < clock.now()) {
          // 续推不支持倒退
          return { aborted: true, reason: "superseded", elapsedMs: realNow() - started } satisfies RenderReply;
        }

        let frames = 0;
        let truncated = false;
        /* 计时趟:每帧的活渲耗时(提交 React → 跑 rAF 回调 → 钉动画),帧间让出的时间不算进来 */
        const steps: number[] = [];
        let frameStarted = 0;
        /*
         * 后台活停着的时间(C10 契约第 2 节):不算进探针的封顶与耗时。在线的后台舞台逐帧让一个宏任务(`setTimeout(0)`),
         * 帧与帧之间查停止标志;桌面照旧每 8 帧让一次,从不停。
         */
        let pausedMs = 0;
        const wall = () => realNow() - started - pausedMs;
        const gate = () => {
          const g = backGate(() => gen !== renderGen.current);
          if (!g) return undefined;
          const t0 = realNow();
          return g.then(() => { pausedMs += realNow() - t0; });
        };
        return await new Promise<RenderReply>((resolve) => {
          ref.current.pending = { gen, startedAt: started, frames: () => frames, resolve };
          void (async () => {
            await clock.advanceToAsync(target * 1000, {
              step: 1000 / fps,
              maxCatchUp: opts.maxCatchUp,
              yieldEvery: ONLINE ? 1 : 8,
              gate,
              abort: () => {
                if (gen !== renderGen.current) return true;
                /*
                 * 计时趟**不按一拍预算截断**(任务书 K1):那样 61 张推帧卡全部只推得了 1～10 帧,
                 * catchUpMs 靠含挂载成本的前几帧外推、偏大 1.7～3.6 倍。这里的封顶只为长片段留,
                 * 剩下的帧由父页按「首帧实测 + 其余帧中位数 × 剩余帧数」外推。
                 */
                if (timing) {
                  if (frames >= maxFrames || wall() > PROBE_MAX_MS) {
                    truncated = true;
                    return true;
                  }
                  return false;
                }
                return false;
              },
              onFrame: (ms) => {
                if (timing) frameStarted = realNow();
                flushSync(() => setT(ms / 1000));
              },
              afterFrame: (ms) => {
                pinner.sync(ms, skipWrappers());
                if (!timing) return;
                frames++;
                /*
                 * canvas 卡(R9 M3 / M4):K1 探针的每一帧都发 beat、等 done —— 计时趟的每帧耗时含这段往返
                 * (`stepMs` 的口径)。
                 * 没有 gl 平面时 `glStrict` 回 `undefined`,这一帧和以前一模一样同步走完。
                 */
                const glDone = glStrict(ms / 1000);
                if (glDone) return glDone.then(() => { steps.push(realNow() - frameStarted); });
                steps.push(realNow() - frameStarted);
              },
            });
            if (gen !== renderGen.current) return; // 已被 abortPending 按 reason 回包
            ref.current.pending = null;
            const elapsedMs = wall();
            if (truncated) {
              resolve({ aborted: true, reason: "timeout", elapsedMs, stepMs: elapsedMs, frames, truncated: true, steps });
              return;
            }
            flushSync(() => setT(target));
            clock.tick(target * 1000);
            pinner.sync(target * 1000, skipWrappers());
            settle(target);
            scheduleSample();
            ref.current.t = target;
            // K5 第二路补跑到目标的那一帧(中间帧不发,同步 advanceTo 的豁免同理):位图贴上再回包
            if (!timing) {
              await glStrict(target);
              if (gen !== renderGen.current) return;
              /*
               * 补跑到目标拍时整台戏正是精确活渲:趁这时把墨迹框量好(Item 7)。互换之后这一台转正,
               * 占位符的实体框已经在手,不必等转正后的补量 —— 那一刻被抑制 / 不可见的卡也不会退成徽标。
               */
              measureInkBoxesNow();
            }
            resolve({ remounted, caughtUpAtSec: clock.now() / 1000, elapsedMs, stepMs: elapsedMs,
              ...(timing ? { frames, truncated: false, steps } : {}) });
          })();
        });
      },

      async hitTest(x, y) {
        const root = rootRef.current;
        return root ? solidHitTest(root, x, y) : null;
      },
      async rectsWithBounds(opts = { pixels: "none" }) {
        const root = rootRef.current;
        return root ? solidRectsWithBounds(root, opts) : [];
      },
      async size() {
        const p = ref.current.project;
        return { width: p?.width ?? 1920, height: p?.height ?? 1080 };
      },
      async setProxy(on) {
        // 只有显式带了 ?proxy=1 的页面才允许开。导出页永远进不来这一条。
        if (!proxyAllowed()) return { ok: true as const };
        const want = !!on;
        if (want === ref.current.proxy) return { ok: true as const };
        ref.current.proxy = want;
        if (want) ensureProxyStyle();
        /*
         * 从实体切回真渲的那一刻要采一次样,而不是切进实体时采 ——
         * 实体模式下画面上只有色块,量它等于把上一次的结论抄一遍再劣化。
         * 采样排在这一帧提交之后(真卡已经画出来了),所以放 flushSync 后面。
         */
        flushSync(() => setProxy(want));
        // 实体模式开着时 `.pc-proxy` 连流平面一起藏:停解码,不占解码帧预算(E7 第 4 条)
        player.setProxy(want);
        if (!want) {
          const root = rootRef.current;
          if (root) sampleAll(root);
        }
        return { ok: true as const };
      },
      /**
       * 角色是运行时状态(J4)。收到 `back` 就地转成后台舞台,**组件不重挂载** ——
       * 互换(K5)靠的正是「同一棵树换个身份」,重挂载等于把追了半天的状态扔掉。
       *
       * 清理的全集(E0 的 `setRole` 那条,两条互换路都不再逐条列):
       *   1. 停 K4 的节拍循环(循环每拍开头和 post `frame` 之前都查 `beatPaused` / 角色);
       *   2. 清空 `suppressed` / `snapshots` / `streamPlanes` —— `back` 永远不收它们的非空集合;
       *   3. 停 `streamPlayer` 并 `close()` 所有 `VideoFrame`(R8 的轨道流);
       *   4. 去掉全部平面和类(快照 / 抑制 / 等待 / 追帧);
       *   5. 中止可见舞台里正在进行的第一路追帧(`catchUpGen` 递增)并清空 `settling` / `awaiting`。
       * R3 把第 2、4、5 条接到真实状态上(平面本体已经有了);循环本体(第 1 条)在 R5,
       * `streamPlayer`(第 3 条)在 R8。
       *
       * `bake` 在本地模式不支持(预渲染者是预渲染进程),回 `unsupported`、不抛。
       */
      async setRole(role, opts = {}) {
        // `bake`:本地模式不支持(预渲染者是预渲染进程);在线构建的后台舞台兼做纯浏览器节点(M7 契约 D3)
        if (role === "back" && opts.job === "bake" && !ONLINE) return { ok: false, reason: "unsupported" as const };
        /*
         * K5 (6):**从 `back` 转正**的舞台要报一次 `settled`(`clipIds` 为空数组)。
         *
         * 判据是「上一刻是不是 `back`」,**不看工作项** —— 单飞队列在补跑那个活做完之后
         * 会把工作项交还成 `'probe'`(`stageJobs` 的 `pump`),那条 `setRole('back', { job: 'probe' })`
         * 和互换的 `setRole('front')` 是两条并行的 RPC,谁先到没有保证。按工作项判的话
         * 交还先到就永远报不出 `settled`,父页那边等到超时。
         */
        const wasBack = ref.current.role === "back";
        ref.current.role = role;
        ref.current.job = role === "back" ? opts.job ?? "probe" : undefined;
        gl.setRole(role);
        if (role === "back") {
          ref.current.wantedSettle = false;
          // 1. 停 K4 的节拍循环(挂着的 pause() 回包一并落定)
          stopBeat();
          // R9:放掉这个 stageId 在 Worker 里的那份图集(互换时 stageId 不变,只清这一份)
          gl.release();
          ref.current.snapshots = new Map();
          ref.current.suppressed = new Set();
          ref.current.parentSuppressed = new Set();
          ref.current.settleLive = new Set();
          setStreamWaiting(new Map());
          ref.current.deferredSettle.clear();
          ref.current.settledHeld = new Set();
          ref.current.streamPlanes = [];
          // 3. 停 `streamPlayer` 并 `close()` 全部 `VideoFrame`(R8)
          player.stop();
          ref.current.settling = new Map();
          ref.current.catchUps.clear();
          ref.current.lastActive = new Set();
          catchUpGen.current++;
          // 后台舞台永远没有占位符(product/rendering.md「兜底顺序」):先撤下,再关掉 —— 这一次提交里槽位一起摘掉
          hideAllPlaceholders(slotOf);
          setPlaceholdersEnabled(false);
          removePlaceholderStyle();
          setCatchingUpClips([]);
          // 同一次提交里把全部平面和类去掉 —— 互换那一拍新 `back` 不能还盖着旧画面
          commitPlanes();
        } else {
          // 人看的预览(live 舞台页、`front`)才挂占位平面;导出页 / 预渲染页不经这里,永远没有
          if (LIVE && !placeholdersEnabled()) {
            setPlaceholdersEnabled(true);
            commitPlanes();
          }
          // 墨迹框是每个舞台自己量的:刚转正的这一台(K5 互换)手里没有,趁它此刻是精确活渲量一次
          scheduleInkBoxes();
          // K5 (6):新 `front` post 一次 `{ type: 'settled', sec, clipIds: [] }`
          if (wasBack) postStageEvent({ type: "settled", sec: ref.current.t, clipIds: [] });
        }
        return { ok: true };
      },
      /**
       * K2 的分派表 + K1 的每卡记录(E0)。父页在 `costs` / 项目 / `tuning` 变了时算好发过来,
       * **集合在线上是数组**(`wirePlan.ts`),这里回填成 `Set`,消费侧照常用 `pipelineAt`。
       *
       * `back` 也收得下(只是存着不用):角色转正(K5 (5) / K3(b) (5))时父页会在
       * `setRole('front')` 之后的同一批里先补发一次,那时它就派上用场了。
       *
       * 消费它的是 K3 / K5(R5):`pipelineAt(plan, clipId, t)` 决定这一拍活渲还是贴死素材,
       * `costs` 里的 `vtOk` / `seekOk` / `catchUpMs` 决定走 (a′) / (a) / (b) 和 K5 的两路。
       * 这一步只把表存进来、并把查询口子放好。
       */
      async setPlan(plan) {
        const wire = (plan?.plan ?? null) as WirePlan | null;
        ref.current.plan = reviveStagePlan(wire, Array.isArray(plan?.costs) ? plan.costs : []);
        if (ref.current.role === "front" && ref.current.wantedSettle && !ref.current.playing && !ref.current.scrubbing && ref.current.suppressed.size > 0) {
          const p = ref.current.project;
          const fps = Math.max(1, p?.fps || 30);
          routeSettle(ref.current.t, fps, true);
        }
        return { ok: true as const };
      },
      /**
       * K4:可见舞台是节拍器。`play(fromSec)` 只是**起**循环 —— 立刻回包,不等第一拍,
       * 父页拿它的回包时刻当「相邻两条 `frame` 的到达间隔」的起点(`mediaStalled`)。
       *
       * 只有 `front` 跑:`back` 要么在做探针、要么在补跑,起循环会把它的时钟一路推走。
       */
      async play(fromSec) {
        if (ref.current.role !== "front") return { ok: false, reason: "role" };
        ref.current.wantedSettle = false;
        const p = ref.current.project;
        if (!p) return { ok: false, reason: "no-project" };
        const from = Math.max(0, Number(fromSec) || 0);
        // 连着来两条 `play`:先让上一轮收摊,不然两个循环会各推各的时钟
        if (ref.current.beatRunning) {
          ref.current.beatPaused = true;
          await new Promise<PlayReply>((resolve) => { ref.current.beatWaiters.push(resolve); });
        }
        const fps = Math.max(1, p.fps || 30);
        ref.current.beatLastSec = from;
        ref.current.beatLastFrame = Math.round(from * fps);
        ref.current.k6.beats = [];
        ref.current.lastActive = new Set();
        ref.current.beatPaused = false;
        // 按下播放同样中止第一路追帧(K5:五个 RPC 各递增一次)
        catchUpGen.current++;
        // 单舞台:下一次播放回到播放时的样子(最低一档只贴预渲染结果)
        const hadLive = clearSettleLive();
        abortCatchUps();
        if (hadLive) commitPlanes();
        void runBeatLoop(from);
        return { ok: true, stoppedAt: from };
      },
      /**
       * `pause()` 立即停:**本拍走完、post 完这一拍的 `frame` 后**停,回 `{ stoppedAt }`
       * (= 最后一拍的 `sec`)。循环已经停着(`ended` 之后、重复 `pause()`)立即回最后一拍。
       *
       * `pause({ atSec })` 是**武装停**(K3(b) 的播放态互换用):post 完 `frame(atSec)`
       * 那一拍就停在那一帧、平面不摘,回 `{ stoppedAt: atSec }`。那一拍**已经 post 过**
       * (当前拍序号 ≥ `atSec` 的拍序号,**等号也算过了**)时不停、回 `{ passed: true }` ——
       * 否则永远等不到那一拍、RPC 永不回包。拍序号按帧号比,不比浮点。
       */
      async pause(opts = {}) {
        const atSec = opts?.atSec;
        const fps = Math.max(1, ref.current.project?.fps || 30);
        if (!ref.current.beatRunning) return { ok: true, stoppedAt: ref.current.beatLastSec };
        if (typeof atSec === "number" && Number.isFinite(atSec)) {
          const frame = Math.round(atSec * fps);
          if (ref.current.beatLastFrame >= frame) return { ok: true, passed: true };
          // 只保留最后一次武装:上一次作废(按 `passed` 回,告诉父页别再等它)
          const prev = ref.current.beatArmed;
          if (prev) {
            window.clearTimeout(prev.timer);
            ref.current.beatArmed = null;
            prev.resolve({ ok: true, passed: true });
          }
          return await new Promise<PlayReply>((resolve) => {
            // 兜底用**真** setTimeout(E4b):循环要是卡住了,RPC 不能永不回包
            const timer = realSetTimeout(() => {
              if (ref.current.beatArmed?.timer !== timer) return;
              ref.current.beatArmed = null;
              resolve({ ok: true, stoppedAt: ref.current.beatLastSec });
            }, ARM_TIMEOUT_MS);
            ref.current.beatArmed = { frame, atSec, resolve, timer };
          });
        }
        return await new Promise<PlayReply>((resolve) => {
          ref.current.beatWaiters.push(resolve);
          stopBeat();
        });
      },
      /**
       * 播放中被判重的卡(E7 第 5 条):`Stage` 给包裹层加 `.pc-suppressed`、藏子树,
       * 传给组件的那个 `t` 冻在抑制开始那一刻;包裹层留在布局树里,几何不变,
       * `rects()` / `hitTest` 照常点得中它。
       *
       * **`.pc-suppressed` 与 `.pc-settling` 互斥**:K6 在追帧中途把一张卡降为重时走的就是这条,
       * 所以这里先把它从 `settling` 里删掉、并递增 `catchUpGen` 中止那一路追帧,再同一次提交里
       * 加上抑制 —— 两个类不会同帧共存。
       */
      async setSuppressed(clipIds) {
        const before = ref.current.suppressed;
        ref.current.parentSuppressed = new Set(clipIds);
        /*
         * 这一次**新**点名的卡,挂着流平面而流还没画出第一帧:先不藏它原来的画面(`streamWaiting`),等流画出来再藏
         * (起播、跳转、拖动起步都走这里;父页先发流平面、再发抑制)。已经藏着的、流已经有画面的(暂停着先解好了)照常当场藏。
         * 没有流平面的卡(没有流、超出解码器预算、等后台补跑互换的轻卡)不等。
         * **只有一个舞台时不等**(精简模式与最低一档:舞台闸门没到双舞台的设备,和「只贴稀疏版」同一批,原低内存档那一批):
         * 重卡播放、拖动时一律不活渲(这台设备跑不动;等的那几拍里活组件照跑,每拍都要算它,流的解码输出反而排在后面出不来)。
         * 流的第一张没到之前这一层先空着(占位符过 120 毫秒才显示)。看舞台能力表的 `compact`(只有一个舞台),最低一档另看取档策略的 `smallOnly`。
         */
        {
          const showing = ref.current.streamPlanes.length ? player.showingClips() : NO_CLIPS;
          const lowestHere = ONLINE && (caps.compact || mediaTierPolicy().smallOnly);
          const waiting = new Map<string, number>();
          const now = realNow();
          for (const id of ref.current.parentSuppressed) {
            if (showing.has(id) || !planeOf(id)) continue;
            const since = ref.current.streamWaiting.get(id);
            if (since !== undefined) waiting.set(id, since);
            else if (!lowestHere && !before.has(id) && !ref.current.settling.has(id)) waiting.set(id, now);
          }
          if (waiting.size || ref.current.streamWaiting.size) setStreamWaiting(waiting);
        }
        // 单舞台停下追一帧正在画 / 画好的层不按父页的抑制藏;下面按生效的那一份判
        applySuppressed();
        const next = ref.current.suppressed;
        // T4:被抑制、这一刻判轻的卡在等后台补跑互换(占位符的 reason 用;显隐判据不看它)
        {
          const plan = ref.current.plan?.plan ?? null;
          setCatchingUpClips([...next].filter((id) => pipelineAt(plan, id, ref.current.t) === "light"));
        }
        /*
         * K6:被切进 `suppressed` 就说明死素材就绪了,从 `pendingDemote` 里移出 ——
         * 它此后是重卡,本来就不参加 K6 的判定。
         */
        if (ref.current.k6.pending.size) {
          const rest = new Set(ref.current.k6.pending);
          for (const id of next) rest.delete(id);
          if (rest.size !== ref.current.k6.pending.size) ref.current.k6.pending = rest;
        }
        if (ref.current.settling.size) {
          const rest = new Map(ref.current.settling);
          let changed = false;
          /*
           * 打断的是轻卡的追帧(K6 把追帧中的轻卡降为重)。停下以后追精确活渲的重卡(`announce` 的那种)不打断:它本来就贴着流、
           * 被点着名,父页重发抑制集合(别的卡变了;或者它上一次追上的 `settled` 迟到,父页按新位置又把它点上)都不该让它停在流上 ——
           * 它追上时照常由 `releaseSettled` 撤抑制。组流里先追上、等着同组的成员同理。
           */
          for (const id of next) {
            if (ref.current.catchUps.get(id)?.announce || ref.current.settledHeld.has(id)) continue;
            if (rest.delete(id)) changed = true;
          }
          if (changed) {
            ref.current.settling = rest;
            catchUpGen.current++;
          }
        }
        commitPlanes();
        return { ok: true as const };
      },
      /**
       * 单舞台停下追当前一帧(纯的部分在 `render/settleFrame.ts`)。父页在暂停、点击或拖动松开、
       * 播放到头的那次 `setTime` 之后发。当前这一帧的所有卡(重卡也画)按「直接定位的先、推帧卡要推的帧少的先」一层层活渲,
       * 画好一层撤一层兜底、换上活渲;不设时限(`timeoutMs` 只给测试与诊断)。本页跑不了的用户卡、素材效果卡不追:有这一帧的
       * 预渲染结果就贴,没有才显示 `unsupported` 占位(2026-09-29 用户改语义)。
       * 新的 `setTime` / `play` / `setProject` / `setRole` 递增 `catchUpGen`,这一次随之收摊、回 `ok: false`。
       */
      async settleLayers(tSec, opts = {}) {
        const timeoutMs = clampSettleTimeout(opts?.timeoutMs);
        const sec = Math.max(0, Number(tSec) || 0);
        const empty = (reason: SettleResult["reason"]): SettleResult =>
          ({ ok: false, reason, sec, timeoutMs, ms: 0, drawn: [], timedOut: [], skipped: [] });
        if (ref.current.role !== "front") return empty("role");
        const p = ref.current.project;
        if (!p) return empty("no-project");
        // 父页发它之前刚 setTime 过这一秒;对不上(又拨走了)、或者在播,就不追
        if (ref.current.beatRunning || Math.abs(ref.current.t - sec) > 1e-6) return empty("superseded");
        const fps = Math.max(1, p.fps || 30);
        const targetMs = sec * 1000;
        const targetFrame = Math.round(sec * fps);
        const gen = catchUpGen.current;
        const items: SettleItem[] = [];
        for (const clip of cardClipsAt(sec)) {
          const c = clip as { id: string; start: number; end: number; cardId?: string; parts?: unknown[]; params?: unknown };
          const def = c.cardId ? getCard(c.cardId) : undefined;
          // 这台设备跑不了的卡(用户卡、素材效果卡)不追:有这一帧的预渲染结果就贴着,没有就是 `unsupported` 占位
          const unsupported = unsupportedHere(c.cardId, def);
          const mountFrame = mountFrameOf(clip, fps);
          const frameMode = def ? clipFrameMode(c as never, def) : undefined;
          const kind = settleKindOf({ unsupported, frameMode, mountFrame, targetFrame });
          items.push({ clipId: c.id, kind, frames: Math.max(0, targetFrame - mountFrame) });
        }
        const result = await runSettle({
          sec, items, timeoutMs, now: realNow,
          aborted: () => gen !== catchUpGen.current,
          draw: (item, deadline) => drawSettleLayer(item, deadline, targetMs, fps),
        });
        ref.current.lastSettle = result;
        refreshPlaceholders();
        return result;
      },
      /**
       * G1 的流平面分组;渲染位置在 `Stage`(包裹层里 / 舞台根下),解码与合成在 `streamPlayer`。
       * 每条带流键 `key` 和就绪的分段号 `ranges`(C3 的 `stream` 表);不带 `key` 的只占位、不解码。
       * **`back` 不收非空集合**(K5:三个集合只发给 `front`),收到也只清空。
       */
      async setStreamPlanes(planes) {
        if (ref.current.role !== "front") {
          ref.current.streamPlanes = [];
          player.stop();
          commitPlanes();
          return { ok: true as const };
        }
        const sent = (Array.isArray(planes) ? planes : []).filter((g) => Array.isArray(g?.clipIds) && g.clipIds.length);
        // 父页标了 `over` 的是这一拍超出预算的:不挂流平面、不建解码器,只交给播放器取清单(占位符照清单里的位置矩形摆)
        const incoming = sent.filter((g) => !g.over);
        const over = sent.filter((g) => g.over).map((g) => ({
          clipIds: g.clipIds.map(String),
          ...(typeof g.key === "string" && g.key ? { key: g.key } : {}),
          ...(Number.isInteger(g.originFrame) && (g.originFrame as number) >= 0 ? { originFrame: g.originFrame as number } : {}),
          ...(g.plane === "stage" ? { plane: "stage" as const } : {}),
          ...(g.manifest && typeof g.manifest === "object" && g.manifest.segments ? { manifest: g.manifest } : {}),
          over: true as const,
        }));
        const groupsOf = (list: readonly { clipIds: readonly string[]; plane?: string }[]) => list.map((g) => `${g.clipIds.join(",")}${g.plane === "stage" ? "@stage" : ""}`).join("|");
        const before = groupsOf(ref.current.streamPlanes);
        ref.current.streamPlanes = incoming.map((g) => ({
          clipIds: g.clipIds.map(String),
          ...(typeof g.key === "string" && g.key ? { key: g.key } : {}),
          ...(Array.isArray(g.ranges) ? { ranges: g.ranges.map((r) => [Number(r[0]), Number(r[1])] as [number, number]) } : {}),
          // 这条流自己的第一帧:播放器按它把帧号换成分段号(`render/streamSegments.mjs`);不带的平面播放器不收
          ...(Number.isInteger(g.originFrame) && (g.originFrame as number) >= 0 ? { originFrame: g.originFrame as number } : {}),
          // 依赖下层的流:按舞台坐标产,画布挂在舞台根下(`Stage` 的 `[data-pc-group-plane]`),不挂进包裹层
          ...(g.plane === "stage" ? { plane: "stage" as const } : {}),
        }));
        /*
         * 在线页面的流平面另带清单与字节(`streamPlayer.ts` 的 `PushedStreamSource`),播放中每取到一段就来一次;
         * `Stage` 只看每条平面的 `clipIds`,分组没变就不为它多做一次 React 提交(占位符的显隐下面照样当场重算)。桌面照旧每次都提交。
         */
        if (!ONLINE || groupsOf(ref.current.streamPlanes) !== before) commitPlanes();
        const fps = Math.max(1, ref.current.project?.fps || 30);
        // 清单与字节只交给播放器,不进 `ref.current.streamPlanes`(那一份会进 React 的 props)
        player.setPlanes(ref.current.streamPlanes.map((p, i) => {
          const g = incoming[i];
          const manifest = g.manifest && typeof g.manifest === "object" && g.manifest.bound && g.manifest.segments && g.manifest.inits ? g.manifest : null;
          // 最低一档:父页带的 `first`(每个分段只解第一帧)只交给播放器,和清单、字节一样不进 React 的 props
          const base = g.first === true ? { ...p, first: true as const } : p;
          return manifest ? { ...base, manifest, ...(g.blocks && typeof g.blocks === "object" ? { blocks: g.blocks } : {}) } : base;
        }), fps, over);
        // 等着流画出第一帧的卡,流平面撤了:不再等(父页还点着名的当场藏起来,落到快照 / 占位符)
        if (ref.current.streamWaiting.size) {
          const gone = [...ref.current.streamWaiting.keys()].filter((id) => !planeOf(id));
          if (gone.length) endStreamWaiting(gone);
        }
        // 画布刚随这次提交挂上:当场画一次,不等下一拍
        presentStreams(ref.current.t);
        refreshPlaceholders();
        return { ok: true as const };
      },
      /** 手按着播放头拖:素材层 seek 放疏一点(`mediaSync` 的 SCRUB_SEEK_MIN_MS) */
      async setScrubbing(on) {
        ref.current.scrubbing = !!on;
        if (on) ref.current.wantedSettle = false;
        commitPlanes();
        return { ok: true as const };
      },
      /** **只管素材层**(`VideoTrack` 的 `playing`):不碰 K4 的节拍循环,那个只由 play / pause / setRole 起停 */
      async setPlaying(on) {
        ref.current.playing = !!on;
        if (on) ref.current.wantedSettle = false;
        commitPlanes();
        return { ok: true as const };
      },
      /**
       * 素材层跟的时刻。平时等于 `t`;K5 第二路补跑时父页单独给 `back` 下发目标拍 ——
       * `VideoTrack` 见偏差过了 `PAUSED_SEEK_SEC` 就补注册一次 rVFC,出画即 post `mediaReady`,
       * 不用等满 300 ms 兜底。
       */
      async setMediaT(tSec) {
        ref.current.mediaT = Number(tSec) || 0;
        commitPlanes();
        return { ok: true as const };
      },
      /**
       * A1 的换档集合:当前连接的素材服务报 `complete` 的哈希(C6.6,父页每 2 秒轮询后下发)。
       * 变了就当场重渲一次:暂停中也要换档(`VideoTrack` 的双缓冲)。
       */
      async setBackWork(on) {
        backWork.on = !!on;
        if (backWork.on) for (const w of [...backWork.waiters]) w();
        return { ok: true as const };
      },
      /**
       * M7 生成快照的一帧(契约第 4.3、4.4 节;协议见 `stageRpc.ts` 的 `BakeFrameRequest`)。项目是父页经 `pushProject('back', …)`
       * 灌进来的隔离单卡工程,目标片段是唯一可见输出,本地帧 n 就是全局帧 n。
       *
       * 推帧:`seq`(缺省)接着上一帧顺推,接不上才从头推 —— 探针 P2 证明对 DOM 独立卡(含 Motion)与桌面 4 帧一批从头推等价、
       * 便宜 4～7 倍(画布卡不等价,节点侧与切分都不让它进浏览器);`batch4` 批起点按 4 帧对齐、每批从头推(同桌面 `fillCardControls`)。帧与帧之间让一个宏任务、查后台活的停止标志(停着的时长记进 `pausedMs`,不算耗时);
       * 不受一拍预算截断。到了这一帧先过就绪闸,再生成快照、取本控件的 HTML:有读不出像素的画布(`lossy`)回 `lossy`
       * (父页按不可重试失败交回,同 `server/bakery/bake.mjs`)。
       *
       * **接续**(`prerender-products-contract.md` 第 2.3 节):上一帧不晚于这一帧就接着推(隔若干帧取一张时,中间的帧只推不生成快照),
       * 同一帧再要一次不再推;舞台时钟不在上一帧的时刻上(别人拨过)、项目或片段换了,就从头推。`batch4` 另要求两帧在同一批里。
       *
       * **顺着做和从头推得到同一帧**:两条路推的每一帧(挂载帧也算)走同一套 `frameEnd` —— 提交这一帧排下的 React 更新
       * (`bakeSettle`)→ 钉动画(拨到结尾的当场交付结束回调,`pinAnimations.ts`)→ 有动画结束就再提交一次(结束回调里换人、写回终值)→ 等 GL 位图。
       * 一帧做完时没有挂着没提交的更新,所以两帧之间隔了多久(顺着做隔着生成快照和一次 RPC 往返,从头推只隔一个宏任务)
       * 不影响结果;每一帧的时刻由舞台时钟按帧号直接算(`stageClock.ts` 的 `frameGrid`),从哪一帧起推都是同一个数。
       *
       * **remotion 式的卡不回放**(同上契约第 4.2 节):隔离工程里唯一那张卡声明成 remotion 式(画面只由时间和参数决定)时,
       * 直接把时钟拨到这一帧、提交、跑这一帧的一拍,不重挂载、不从挂载帧逐帧推;回包的 `remounted` 恒为 `false`。
       *
       * 要像素(`req.pixels`,浏览器节点产轨道流用):生成快照之后照小尺寸那条路按原尺寸把矩形那一块画成位图(`bakeSmall.ts` 的
       * `renderSnapshotBitmap`),随 `bake-frame` 事件转移给父页;画不出来回 `pixels-failed`。`req.html === false` 时事件不带 HTML 字节。
       *
       * **剪辑段里的卡**(片段 id 是摊平出来的虚拟片段,〔裁〕R02:在线浏览器也替剪辑段里的重卡产流):灌进来的是带着剪辑段链的隔离工程
       * (`online/bakeTask.ts` 的 `isolatedBakeProject`),时间不平移,所以本地帧 n 是项目帧 `req.frameBase + n`;顶层只有那个剪辑段,
       * 一律从挂载帧逐帧推(嵌套场景里的卡按段的预卷挂上,不走直接拨到那一支);快照取这张卡在嵌套场景里的包裹层
       * (`[data-pc-flat-clip]`,`createSnapshot` 的 `flatControls`)。包裹层的本地帧按卡自己的起点算(露出窗口可以截了头),
       * 核对时按同一个式子算期望值,允许差一帧(两边的浮点次序不同)。顶层的卡一个字不变。
       */
      async bakeFrame(req) {
        if (!ONLINE || !clock) return { ok: false, reason: "unsupported" } satisfies BakeFrameReply;
        if (ref.current.role !== "back") return { ok: false, reason: "role" } satisfies BakeFrameReply;
        const p = ref.current.project;
        if (!p) return { ok: false, reason: "no-project" } satisfies BakeFrameReply;
        const flat = isFlatClipId(req.clipId);
        const clip = flat
          ? (flatClipOf(p, req.clipId)?.clip as Project["tracks"][number]["clips"][number] | undefined)
          : p.tracks.filter((tr) => !tr.hidden).flatMap((tr) => tr.clips).find((c) => c.id === req.clipId);
        if (!clip) return { ok: false, reason: "no-clip" } satisfies BakeFrameReply;
        const fps = Math.max(1, p.fps || 30);
        const n = Math.max(0, Math.floor(Number(req.localFrame) || 0));
        // 剪辑段里的卡:本地帧 0 是项目的第 `frameBase` 帧;顶层的卡是 0(本地帧就是全局帧)
        const base = flat ? Math.max(0, Math.floor(Number(req.frameBase) || 0)) : 0;
        const g = n + base;
        const sec = g / fps;
        const gen = ++bakeGen;
        const started = realNow();
        let pausedMs = 0;
        const stale = () => gen !== bakeGen || ref.current.role !== "back" || ref.current.project !== p;
        const cur = bakeCursor;
        bakeCursor = null;
        const targetMs = sec * 1000;
        // 隔离工程里唯一那张卡是 remotion 式:画面只由时间和参数决定,直接拨到这一帧。
        // 判据和预渲染进程给流定「要不要回放」的那一条相同(`server/frame-stream.mjs` 的 `streamNeedsReplay`):
        // 取卡的能力表里的写法,声明了要预渲染的、认不出来的卡一律按有状态处理(宁可多推,不可画错)
        const def = clip.cardId ? getCard(clip.cardId) : undefined;
        const caps = def && !unsupportedHere(clip.cardId, def) ? cardCapabilities(def as never, { ...def.defaults, ...clip.params }, clip.parts as never) : null;
        const direct = !flat && !!caps && caps.frameMode === "direct" && caps.need_prerendering !== true
          && p.tracks.filter((tr) => !tr.hidden).flatMap((tr) => tr.clips).length === 1;
        // 接得上:舞台还挂着这份项目的这个片段,时钟就停在上一帧的时刻上(接续点记的是全局帧;顶层的卡全局帧就是本地帧)
        const held = !!cur && cur.project === p && cur.clipId === req.clipId && Math.abs(clock.now() - (cur.frame / fps) * 1000) < 1e-6;
        const continuing = !direct && held && cur.frame <= g
          && (req.mode !== "batch4" || (g % 4 !== 0 && Math.floor(cur.frame / 4) === Math.floor(g / 4)));
        /**
         * 一帧收尾(挂载帧、推过的每一帧、直接拨到的那一帧都走它,两条路一样):这一帧的回调跑完以后,
         * 提交排下的 React 更新 → 钉动画并当场交付结束回调 → 有动画在这一帧结束就再提交一次 → 等 GL 位图。
         * 和导出页一帧的顺序相同(`server/bakery/bake.mjs` 的 `createStepper`:排空 → 钉动画 → 排空)。
         * 中途被作废就停手,不去钉新一帧的动画。
         */
        const frameEnd = async (ms: number): Promise<void> => {
          await bakeSettle();
          if (stale()) return;
          pinner.sync(ms, skipWrappers());
          if (pinner.endedInLastSync() > 0) await bakeSettle();
          if (stale()) return;
          const g = glStrict(ms / 1000);
          if (g) await g;
        };
        if (direct) {
          if (!held) {
            renderGen.current++;
            abortPending("superseded");
          }
          clock.set(targetMs);
          flushSync(() => setT(sec));
          clock.tick(targetMs);
          await frameEnd(targetMs);
        } else {
          if (!continuing) {
            // 从头推:别的在飞的补跑 / 探针作废(单飞队列本来就不会让它们并存,这里兜底)
            renderGen.current++;
            abortPending("superseded");
            await frameEnd(remountAt(sec, fps) * 1000);
          }
          if (!stale()) await clock.advanceToAsync(targetMs, {
            step: 1000 / fps,
            fps,
            // 从挂载帧一帧不落地推到这一帧:不传的话缺省的 6 秒补跑上限会把起点削掉(那是给可见舞台跳转「只求不卡」用的),
            // 生成出来的就不是这一帧该有的状态。测量、互换、整场景补跑同样传 Infinity
            maxCatchUp: Infinity,
            yieldEvery: 1,
            gate: () => {
              const g = backGate(stale);
              if (!g) return undefined;
              const t0 = realNow();
              return g.then(() => { pausedMs += realNow() - t0; });
            },
            abort: stale,
            onFrame: (ms) => { flushSync(() => setT(ms / 1000)); },
            afterFrame: frameEnd,
          });
        }
        if (stale()) return { ok: false, reason: "cancelled" } satisfies BakeFrameReply;
        // 时钟没落在这一帧上(不该发生:每一步都按帧号算,最后一步就是这一帧的时刻):不拿别的时刻的画面充数,按可重试交回
        if (Math.abs(clock.now() - targetMs) > 1e-6) return bakeFail({ ok: false, reason: "cancelled", detail: `舞台时钟在 ${clock.now()} 毫秒,这一帧是 ${targetMs} 毫秒` } satisfies BakeFrameReply);
        ref.current.t = sec;
        const t0 = realNow();
        const ready = await bakeReady(stale);
        if (stale()) return { ok: false, reason: "cancelled" } satisfies BakeFrameReply;
        if (!ready.ok) return bakeFail({ ok: false, reason: "not-ready", detail: ready.detail.slice(0, 300) } satisfies BakeFrameReply);
        const readyMs = realNow() - t0;
        const root = rootRef.current;
        const snap = createSnapshot(root, flat ? { flatControls: true } : undefined);
        if (snap.lossy) return bakeFail({ ok: false, reason: "lossy", detail: `${snap.lossy} 张读不出像素的画布` } satisfies BakeFrameReply);
        const own = snap.controls.find((c) => c.id === req.clipId);
        if (!own) return bakeFail({ ok: false, reason: "no-control" } satisfies BakeFrameReply);
        // 剪辑段里的卡:包裹层的本地帧从卡自己的起点算 = 这一刻 − (露出起点 − 截掉的那一截)
        const wantFrame = flat ? Math.round((sec - (clip.start - (Number((clip as { flat?: { lead?: number } }).flat?.lead) || 0))) * fps) : n;
        if (flat ? Math.abs(own.frame - wantFrame) > 1 : own.frame !== n) return bakeFail({ ok: false, reason: "frame-mismatch", detail: `生成快照的本地帧是 ${own.frame},要的是 ${wantFrame}` } satisfies BakeFrameReply);
        const bytes = new TextEncoder().encode(own.html);
        const hash = await sha256Hex(bytes);
        const wantHtml = req.html !== false;
        const gz = wantHtml ? await compressHtml(own.html) : null;
        let pixels: { rect: { x: number; y: number; w: number; h: number }; bitmap: ImageBitmap } | null = null;
        let pixelsMs = 0;
        if (req.pixels) {
          const rect = pixelRect(req.pixels.rect);
          if (!rect) return bakeFail({ ok: false, reason: "pixels-failed", detail: "要像素的矩形不对(要整数、宽高为偶数)" } satisfies BakeFrameReply);
          const p0 = realNow();
          const box = resolveFrameSize(clip.frame, p);
          try {
            const bitmap = await renderSnapshotBitmap({ html: own.html, boxWidth: Number(box.w) || p.width, boxHeight: Number(box.h) || p.height, rect });
            pixels = { rect, bitmap };
          } catch (e) {
            return bakeFail({ ok: false, reason: "pixels-failed", detail: String((e as Error)?.message ?? e).slice(0, 200) } satisfies BakeFrameReply);
          }
          pixelsMs = realNow() - p0;
        }
        /** 这一帧不交了(被作废、小尺寸没成):位图还没转移走,关掉 */
        const dropPixels = () => { try { pixels?.bitmap.close(); } catch { /* 已经关了 */ } };
        let small: { hash: string; bytes: number; webp: ArrayBuffer } | null = null;
        let smallMs = 0;
        if (req.small) {
          const s0 = realNow();
          const box = resolveFrameSize(clip.frame, p);
          let webp: ArrayBuffer | null = null;
          try {
            webp = await renderSmallWebp({ html: own.html, projectWidth: p.width, projectHeight: p.height, boxWidth: Number(box.w) || p.width, boxHeight: Number(box.h) || p.height });
          } catch (e) {
            dropPixels();
            return { ok: false, reason: "small-failed", detail: String((e as Error)?.message ?? e).slice(0, 200) } satisfies BakeFrameReply;
          }
          if (!webp) { dropPixels(); return { ok: false, reason: "small-failed", detail: "浏览器出不了 WebP" } satisfies BakeFrameReply; }
          small = { hash: await sha256Hex(new Uint8Array(webp)), bytes: webp.byteLength, webp };
          smallMs = realNow() - s0;
        }
        if (stale()) { dropPixels(); return { ok: false, reason: "cancelled" } satisfies BakeFrameReply; }
        const transfer: Transferable[] = [];
        const event = { type: "bake-frame" as const, session: req.session, clipId: req.clipId, localFrame: n, hash, bytes: bytes.length,
          ...(!wantHtml ? {} : gz ? { htmlGz: gz } : { htmlRaw: bytes.buffer as ArrayBuffer }), small, ...(pixels ? { pixels } : {}) };
        if (wantHtml) transfer.push(gz ?? (bytes.buffer as ArrayBuffer));
        if (small) transfer.push(small.webp);
        if (pixels) transfer.push(pixels.bitmap);
        postStageEvent(event, "*", transfer);
        bakeCursor = { project: p, clipId: req.clipId, frame: g };
        bakeStats.frames++;
        bakeStats.ms.push(realNow() - started - pausedMs);
        bakeStats.pausedMs += pausedMs;
        if (!continuing && !direct) bakeStats.remounts++;
        if (req.small) bakeStats.smallMs.push(smallMs);
        if (bakeStats.ms.length > 200) { bakeStats.ms.splice(0, bakeStats.ms.length - 200); bakeStats.smallMs.splice(0, Math.max(0, bakeStats.smallMs.length - 200)); }
        return { ok: true, localFrame: n, hash, bytes: bytes.length, small: small ? { hash: small.hash, bytes: small.bytes } : null,
          ms: realNow() - started - pausedMs, pausedMs, remounted: !continuing && !direct, smallMs, readyMs, ...(pixels ? { pixelsMs } : {}) } satisfies BakeFrameReply;
      },
      async bakeCancel() {
        bakeGen++;
        bakeCursor = null;
        return { ok: true as const };
      },
      /** 在线执行同步来的用户卡与素材效果卡:收下编辑页面发来的包(全量);执行不执行看本文档自己的闸门(见上面 `applyCardBundles`) */
      async loadUserCards(bundles, opts = {}) {
        if (import.meta.env.VITE_PC_ONLINE !== "1") return { ok: false, reason: "unsupported" as const };
        const gate = stageExecGate();
        // 不是跨源舞台入口的文档(同源单舞台、编辑页面):不记、不执行
        if (gate.reason === "not-stage") return { ok: false, reason: "unsupported" as const };
        cardExec.bundles = Array.isArray(bundles) ? (bundles as CardBundle[]) : [];
        cardExec.sound = opts?.sound === true;
        void applyCardBundles();
        return gate.allowed ? { ok: true } : { ok: false, reason: "gate" as const };
      },
      async synthCardAudio(request) {
        if (!cardExec.soundHost || !stageExecGate().allowed) throw new Error("这一台舞台没有声音线程");
        return cardExec.soundHost.render(request);
      },
      /**
       * 在线页面读内容库卡片源码得到的「已知但本机不能运行」的用户卡(C10 契约第 9 节「识别」)。舞台是另一份文档,
       * 由父页发一份过来进本页的注册表;变了就重渲一次(这些片段改挂快照 / 流平面与 `unsupported` 占位)。
       */
      async setSyncedUserCards(entries) {
        const changed = setSyncedUserCards(Array.isArray(entries) ? entries : []);
        if (changed) commitPlanes();
        return { ok: true as const, changed };
      },
      /**
       * 父页的预览缩放倍数(桌面与在线都发):占位符按它补偿,屏幕上看得清(`placeholderFit.ts`:沙漏只抵消预览缩放)。变了就重渲一次(`Stage` 给占位组件换 `fit`)。
       * 占位符只在人看的预览里挂(导出、预渲染、后台舞台没有),这里只改预览。
       */
      async setViewScale(scale) {
        if (setPlaceholderViewScale(scale) && placeholdersEnabled()) commitPlanes();
        return { ok: true as const };
      },
      async setMediaPolicy(next) {
        // 最低一档只进不出:起手的 `lowest=1` 不被父页的 false 盖掉
        // 执行闸门(契约 `online-card-exec-contract.md` 第 3.1 节):带票据的策略让本文档永久不执行用户卡;闸门开过之后再来的票据不收
        const gate = ONLINE ? noteMediaPolicy({ ticket: next?.remote?.ticket ?? null, cardExec: next?.cardExec }) : { acceptTicket: true };
        const remote = next?.remote && !gate.acceptTicket && next.remote.ticket ? { ...next.remote, ticket: null } : next?.remote ?? null;
        const decode = typeof next?.decodeMaxPixels === "number" && Number.isFinite(next.decodeMaxPixels) && next.decodeMaxPixels > 0 ? next.decodeMaxPixels : null;
        // 网速(`smallFirst`)由这一台自己看(`netSpeed.ts`),父页不给;给了(测试)才照它
        setMediaTierPolicy({ smallOnly: caps.lowest || next?.smallOnly === true, decodeMaxPixels: decode, smallFirst: typeof next?.smallFirst === "boolean" ? next.smallFirst : netSpeedState().smallFirst, remote });
        commitPlanes();
        return { ok: true as const };
      },
      /**
       * 在线页面换 canvas 卡的渲染路线(舞台闸门试第三级时父页发 `perDocument`;语义 `mechanism/platforms.md`「舞台闸门的步骤」)。
       * 原地换(`glHost.setRoute` 拆掉旧连接、下一拍按新路线接上),不重建舞台、不重灌项目。桌面运行环境的路线跟项目选项走,这里不收。
       */
      async setGlRoute(route) {
        if (!ONLINE || (route !== "perDocument" && route !== "shared")) return { ok: true as const, route: onlineGlRoute, mode: gl.diag().mode };
        onlineGlRoute = route;
        gl.setRoute(route);
        commitPlanes();
        return { ok: true as const, route: onlineGlRoute, mode: gl.diag().mode };
      },
      async setLocalHashes(hashes) {
        const next = [...hashes];
        const prev = ref.current.localHashes;
        if (prev.length === next.length && prev.every((h, i) => h === next[i])) return { ok: true as const };
        ref.current.localHashes = next;
        commitPlanes();
        return { ok: true as const };
      },
      /**
       * HTML 快照已由己二撤掉，留作空桩兼容旧接口。
       */
      async setSnapshots(_patch, _opts = {}) {
        return { ok: true as const, bytes: 0 };
      },
    };

    const stopRpc = serveStageRpc(api);
    window.__pcStage = api;
    // K1 探针 / L1 / probe-frame 生成快照都在舞台页调它;导出页挂的是同一个 createSnapshot(J1)。
    // 场景根就是 rootRef 指着的那个 [data-pc-scene] div(不走 document.querySelector:预渲染页上 #root 只是 display:none)。
    window.__pcCreateSnapshot = () => {
      const root = rootRef.current;
      if (!root) throw new Error("stage: 还没有项目,没什么可生成快照的");
      return createSnapshot(root);
    };
    /*
     * K2 的表的查询口子。R5 的 K3 / K5 在舞台内部直接读 `ref.current.plan`,
     * 挂在 window 上这一份是给验收探针和 puppeteer 看的(表到没到、这一刻判轻还是判重)。
     * 没有表时 `pipelineAt` 回 `'heavy'` —— 保守侧,和「没有记录按声明兜底」同一个方向。
     */
    window.__pcStagePlan = () => ref.current.plan;
    /*
     * 验收探针的观察口(K4 / K3 / K5 / K6):跨源摸不到 iframe 的 document,
     * 所以把「此刻的内部状态」摊成一个可结构化克隆的对象,探针用 CDP 在舞台上下文里读。
     * 只读,没有副作用。
     */
    window.__pcStageDiag = () => ({
      role: ref.current.role,
      job: ref.current.job ?? null,
      t: ref.current.t,
      beatRunning: ref.current.beatRunning,
      beatPaused: ref.current.beatPaused,
      beatLastSec: ref.current.beatLastSec,
      beatLastFrame: ref.current.beatLastFrame,
      armedFrame: ref.current.beatArmed?.frame ?? null,
      settling: [...ref.current.settling.keys()],
      suppressed: [...ref.current.suppressed],
      /** 单舞台停下追一帧:正在画 / 画好的层、上一次的结果 */
      settleLive: [...ref.current.settleLive],
      lastSettle: ref.current.lastSettle,
      snapshots: [...ref.current.snapshots.keys()],
      awaiting: [...ref.current.awaiting],
      remountGen: [...ref.current.remountGen.entries()],
      catchUps: [...ref.current.catchUps.values()].map((c) => ({ clipId: c.clipId, stageMs: c.stageMs, targetMs: c.targetMs })),
      pendingDemote: [...ref.current.k6.pending],
      k6Beats: ref.current.k6.beats.length,
      k6Over: ref.current.k6.beats.reduce((n, b) => n + b.over, 0),
      /** 最后一拍每张卡的耗时(`<Profiler>` 报的);K6 挑「最贵的那张」就按它 */
      cardCost: [...ref.current.cardCost.entries()],
      /** R8:流平面与解码器的状态(持有的帧数 / 字节、每条流画了几帧、当前变体……) */
      streamPlanes: ref.current.streamPlanes.map((g) => ({ clipIds: g.clipIds, key: g.key ?? null, ranges: g.ranges ?? null, originFrame: g.originFrame ?? null, plane: g.plane ?? null })),
      /** 贴轨道流:父页点名抑制了、流还没画出第一帧、原来的画面先没藏的卡;被推后的停下追帧;组流里先追上等着同组的 */
      parentSuppressed: [...ref.current.parentSuppressed],
      streamWaiting: [...ref.current.streamWaiting.keys()],
      deferredSettle: [...ref.current.deferredSettle.keys()],
      settledHeld: [...ref.current.settledHeld],
      streams: player.diag(),
      /** R9:共享 WebGL 渲染器这一侧的状态(路线、连接方式、往返耗时、超时次数……) */
      gl: gl.diag(),
      /** 兜底顺序尽头:此刻显示着占位符的卡 */
      placeholders: [...shownPlaceholders()],
      /** M7 生成快照(契约第 7 节「舞台」):逐帧耗时不含被门挡住的时长,后者单记 */
      bake: {
        frames: bakeStats.frames, frameMs: { p50: q(bakeStats.ms, 0.5), p95: q(bakeStats.ms, 0.95) }, pausedMs: Math.round(bakeStats.pausedMs),
        remounts: bakeStats.remounts, smallMs: { p50: q(bakeStats.smallMs, 0.5), p95: q(bakeStats.smallMs, 0.95) }, errors: { ...bakeStats.errors },
        cursor: bakeCursor ? { clipId: bakeCursor.clipId, frame: bakeCursor.frame } : null,
      },
    });
    // 探针用:问 Worker 要它那一侧的诊断(上下文数、纹理上传次数、图集尺寸)
    (window as unknown as Record<string, unknown>).__pcGlWorkerDiag = () => gl.workerDiag();
    window.__pcStagePipelineAt = (clipId: string, tSec: number) => pipelineAt(ref.current.plan?.plan ?? null, clipId, tSec);
    postStageReady(caps);
    // 跨源舞台的自检结果排在握手之后发(`online/isolation/stageGuard.ts`);别的文档什么都不发
    if (ONLINE) announceStageIsolation();
    return () => {
      stopRpc();
      cardExec.stopped = true;
      offCardExecGate();
      cardExec.runtime?.dispose(); cardExec.runtime = null;
      cardExec.soundHost?.dispose(); cardExec.soundHost = null;
      player.stop();
      window.removeEventListener("message", onGlPort);
      if (ONLINE) document.removeEventListener("webglcontextlost", onContextLost, true);
      stopNetSpeed();
      gl.dispose();
      delete (window as unknown as Record<string, unknown>).__pcGlWorkerDiag;
      window.clearTimeout(ref.current.settle);
      window.clearTimeout(ref.current.streamWaitTimer);
      window.clearTimeout(sampleTimer);
      window.clearTimeout(inkTimer);
      setPlaceholdersEnabled(false);
      if (window.__pcStage === api) delete window.__pcStage;
      delete window.__pcStagePlan;
      delete window.__pcStageDiag;
      delete window.__pcStagePipelineAt;
    };
  }, [skipWrappers]);

  if (!project) return null;
  const timeline = flattenOverlay(project, graph);
  /*
   * 组流平面挂在组里**此刻活跃的最上面那张卡**那一层(G1)。live 路每个片段一个单片段 `Stage`,
   * 哪张卡此刻在场只有这里知道;`timeline.clips` 已经是画家顺序(最后一个在最上面)。
   */
  const streamPlanes = ref.current.streamPlanes.some((g) => g.clipIds.length > 1)
    ? ref.current.streamPlanes.map((g) => {
      if (g.clipIds.length < 2) return g;
      const members = new Set(g.clipIds);
      const live = timeline.clips.filter((c) => members.has(c.id) && cardMountedAt(c, t));
      const host = live.length ? live[live.length - 1].id : g.clipIds[g.clipIds.length - 1];
      return g.host === host ? g : { ...g, host };
    })
    : ref.current.streamPlanes;

  return (
    <div
      ref={rootRef}
      data-pc-scene=""
      style={{
        position: "relative",
        width: project.width,
        height: project.height,
        overflow: "hidden",
        background: "transparent",
        // 和 ExportView 读同一处(Timeline),不是各读各的 project —— 见 Timeline.themeId 的说明
        ...themeStyle(timeline.themeId),
        /*
         * 三维的 perspective **不在这里**。这一格和卡片之间还隔着 Stage 的根和 AnimClock
         * 两层 div,而 CSS 的 perspective 只作用于直接子元素 —— 挂在这里等于没挂
         * (实测卡片高度纹丝不动,rotateY 只剩仿射拉伸,而且不报错)。
         * 它挂在 render/Stage.tsx 里卡片的直接父元素上,预览和导出共用同一处。
         */
      }}
    >
      {LIVE ? (
        /*
         * E7:舞台页渲 `FrameScene` 的**活播放变体** —— 素材层在舞台里(第 1 条)、
         * 卡片活跃判据用 `cardMountedAt`(第 2 条)、六个平面 prop 原样透传(第 3～5 条)。
         * `graph` 就是上面那个 `useMemo`:**漏传的话** `graphVisualNode` 恒为 false、
         * 素材段被画两层,而且 `timeline.graph` 为空、素材效果卡解不出输入,编译器不会拦。
         */
        <FrameScene
          project={project}
          graph={graph}
          t={t}
          directT={t}
          mediaT={ref.current.mediaT}
          playToken={token}
          mediaMode="live"
          proxy={proxy ? proxyOf : undefined}
          scrubbing={ref.current.scrubbing}
          playing={ref.current.playing}
          suppressed={ref.current.suppressed}
          streamPlanes={streamPlanes}
          snapshots={ref.current.snapshots}
          remountGen={ref.current.remountGen}
          settling={ref.current.settling}
          awaiting={ref.current.awaiting}
          localHashes={ref.current.localHashes}
          onMediaFrame={onMediaFrame}
          onCardCost={onCardCost}
        />
      ) : (
        <Stage timeline={timeline} t={t} playToken={token} proxy={proxy ? proxyOf : undefined} />
      )}
    </div>
  );
}

import { UnifiedPreview } from "./preview/UnifiedPreview";
import { flatPlanProject } from "../kernel/cutFlatten.mjs";
import { usePrerenderPreload } from "./preview/usePrerenderPreload";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isScrubbing, subscribeScrub } from "./timeline/useScrub";
import { MediaLayers } from "./preview/MediaLayers";
import { Scene3DView } from "./preview/Scene3DView";
import { themeStyle } from "../themes";
import { actions, getState, useStore } from "../store/project";
import { findClip, type Project } from "../kernel/project";
import { nudgeFrame } from "../kernel/layout";
import { createStageRpc, type HostCapabilities, type StageGraphCapability, type StageMediaPolicy, type StageRpcClient } from "../render/stageRpc";
import { frontStage, onStageEvent, pushProject, releaseStageClient, setStageClient, swapStageClients, syncProject, whenStageReady } from "./stageBridge";
import { bindStageCards, noteStageCards, noteStageFresh } from "./stageCards";
import { INITIAL_ROLE_OF, STAGE_IDS, dualStage, interimStage, liveStage, singleLiveStage, stageOrigins, stageSrc, stageTargetOrigin, type StageId } from "./previewMode";
import { ControlBar } from "./preview/ControlBar";
import { ToolBar, ToolType } from "./preview/ToolBar";
import { useMemberReadOnly } from "./readOnly";
import { PreviewContextMenu } from "./preview/PreviewContextMenu";
import { cardRunState, getCard, onCardRunStatesChanged, onSyncedUserCardsChanged, setCardRunStates, syncedUserCards, type CardRunState } from "../kernel/registry";
import { fitView, frameOrigin, panBy, wheelZoomFactor, zoomAt, type View2D } from "./preview/viewport2d";
import "./preview/preview.css";
import { atFrameGrid } from "../render/frameGrid";
import { contentStartOf } from "./timeline/utils";
import { startAssetTiers, tierHashes, useTierHashes } from "./media/assetTiers";
import { startTierBackfill } from "./io/mediaUpload";
import { backfillHooks } from "./sync/backfillUpload";
import { clearSettled, currentReadyIndex, localOnlyOf, markBaselineReset, noteSettled, pendingDemotes, setCostResolver, setSnapshotArrive, setSnapshotSource, snapshotFeedDebug, stopSnapshotFeed, streamPlanesAt, suppressedAt, syncSnapshotSubscription } from "./snapshotFeed";
import { OnlineSnapshotSource, activeOnlineSource, applyReadyMessage, setActiveOnlineSource } from "../render/snapshotSource";
import { StreamPlaneSender } from "../render/streamPlayer";
import { notePlayFrame, notePlayRunStart, playingSwapTargets, runPlayingSwap, runSettleSwap, setSwapHost, stageSwapDebug, stageSwapPlayingDebug, stageSwapTrace, swapInFlight } from "./stageSwap";
import { demotedClips, onStageDemote } from "./demote";
import { flushSync } from "react-dom";
import { useUserEditing } from "./userEditing";
import { createSharedGl, type SharedGl } from "../render/gl/glParent";
import { resolveGlRoute } from "../render/costDevice.mjs";
import { ONLINE } from "../online/mode";
import { lowestTier, phoneIdentity, setBenchmark, subscribeTier, tierGlRoute, tierState } from "../online/onlineTier";
import { stageGate } from "../online/stageGate";
import { MEDIA_MARK_MS, decodeLimit, originalLoadSignature, subscribeDecodeLimit } from "../online/mediaGate";
import { TierBubble } from "./TierBubble";
import { GateViewer, gateViewerWanted } from "./GateViewer";
import { setMediaTierPolicy, type MediaTierPolicy } from "../render/mediaTier";
import { assetAuthHeaders, docRequest, hasDocLink, remoteAccountProjectId, remoteAssetBase, remoteAssetTicket, remoteAssetTicketInfo, setNoEditorProcess, subscribeRemoteAssets } from "./media/assetTiers";
import { currentDocProjectId, currentSharedLink, getSyncView, pageSession, pushToast, subscribeQueueEvents } from "./sync/syncManager";
import { hostedStreamsOn } from "./sync/hostedServices";
import { needsLocalPc, onlineBrowserMode, setOnlineBrowserMode } from "../render/placeholderHost";
import { OnlineCardSources, CARD_SOURCE_POLL_MS } from "./sync/onlineCardSources";
import { editorRunStates } from "./sync/cardRunStates";
import { exportWantedClips } from "../export/exportWanted";
import { cardExecAvailable, cardExecBlockedDetail, cardVisualExecAvailable, setCardExecGate, subscribeCardExecGate } from "../online/cardRuntime/gate";
import type { BundleResult, CardBundle } from "../online/cardRuntime/protocol";
import { setNodeGraphCapable } from "../online/nodeCardInfo";
import { createIsolatedSoundLink, type IsolatedSoundLink } from "./io/isolatedSound";
import { holdMeasureForCardSources, measureGateDiag, measureGateOpen, releaseMeasureGate, setMeasureGateLink } from "./measureGate";
import { setCoverageSource } from "./onlineCoverage";
import { currentCosts, currentPlan, judgedPlan, lightCostAt, onPlanUpdated, planSearch, planSearchLight, searchJudged, sendPlanTo, setPlanDeadMs, setPlanForcedHeavy, setPlanLowest, setPlanSearch, setPlanSearchLight } from "./planDispatch";
import { benchmarkVerdict, costSearchMeasuring, costSearchState, holdCostSearchMask, measureNewCards, reclassify, releaseCostSearchMask, runBenchmark, runCostSearch, type BenchmarkOutcome, type CostSearchOutcome } from "./costSearch";
import { runBackJob } from "./stageJobs";
import { CostSearchGate } from "./CostSearchGate";
import { SHARED_COST_RELAY_MS, SharedCostRelay, listSharedCosts, publishSharedCosts, toSharedInput, type SharedCostInput } from "./sharedCosts";
import { clipIdentityOf } from "./costIdentity";
import { pageEnvironment } from "./pageEnvironment.mjs";
import { createMemoryCostStore, type CostStore } from "../render/boundarySearch.mjs";
import { beatSwapDebug, setBeatSwap } from "./snapshotFeed";
import { SWAP_MS } from "../render/beatSwap.mjs";
import { layerSwapMs } from "./swapCost";
import { markStageHandshake, onlineStageState, stageAssetBase, subscribeOnlineStages } from "../online/stageOrigins";
import { STAGE_SANDBOX, onlineCardExec, pageStageIsolation, sanitizeBreach, sanitizeIsolationReport, subscribeOnlineCardExec, type StageSidScope } from "../online/stageIsolation";
import { sanitizeHostCapabilities } from "../online/stageMessageGuard";
import { MEDIA_PROXY_BASE } from "../online/stagePolicy.mjs";
import type { IsolationReport } from "../online/isolation/isolationCheck";
import { createStageHandshake, type StageHandshake } from "../online/stageHandshake";

/** 换回双舞台时盖板最多留多久(〔裁〕2026-09-30 `claude/stage-handshake`) */
const STAGE_HANDOVER_MAX_MS = 3000;
/** 新的可见舞台第一次 `setTime` 回包(或报来第一拍)之后再等这么久撤盖板,让它把这一帧画到屏上 */
const STAGE_HANDOVER_SETTLE_MS = 150;
import { createStageWatch, type StageWatch } from "../online/stageWatch";
import { builtinCardSourceFiles } from "../render/cardSourceFiles.mjs";
import { builtinSourceExports } from "../cards/builtinSourceExports";
import { pageL2 } from "../online/l2";
import { l2CostBackend } from "../online/l2Costs";
import { createPlanPublisher, type PlanPublisher } from "../online/planPublisher";
import { CODE_VERSION } from "../online/boot";
import { backWorkDiag, startBackWorkGate } from "./backWorkGate";
import { backStage } from "./stageBridge";
import { holdProbe, onCostRecords, onProbeProgress, probeFrameDiag, probeProgress, probeRunDiag, probeSettledFor, releaseProbe, runCardMeasuredHook, setCostBackend, setProbeMeasureHooks } from "./probeRunner";
import { browserNodeReady, keepConfirmedProject, startBrowserNodeHost, subscribeBrowserNodeReady } from "./browserNodeHost";
import type { SettleResult } from "../render/settleFrame";

setCostResolver((proj, clipId) => {
  const key = clipIdentityOf(proj).identityKeys[clipId];
  return key ? currentCosts().find((r) => r.identityKey === key) : undefined;
}, () => dualStage());

/**
 * 单舞台界限搜索的本地复用(「卡片身份 + 本机环境指纹」→ 本机实测的单帧耗时;`boundarySearch.mjs`)。
 * 缺省是页面内存;在线页面经 `setSearchCostStore` 接到页面内快照库 L2 的 `costs` 表(方法同名 `getCost` / `putCost`)。
 */
let searchCostStore: CostStore = createMemoryCostStore();
export function setSearchCostStore(store: CostStore): void {
  searchCostStore = store;
}

/**
 * 界限搜索的本地复用接到页面内快照库 L2 的 `costs` 表(C10 集成:交接文件第 2.2 节第 3 条)。键形 `<identityKey>|<envFingerprint>`
 * (`boundarySearch.mjs` 的 `localCostKey`),与后台舞台 K1 记录的键(`<identityKey>
<device>`,`l2Costs.ts`)不相撞;
 * 这些记录没有 `device`,读 K1 记录时滤掉。L2 打不开(没有 IndexedDB、被浏览器拒)时退回页面内存。
 */
/**
 * 此刻页面自己判重的卡片段(预渲染集合):清单计划的清单、测量时产稀疏流的对象都取它。
 * 只列卡片段(素材段不产预渲染结果)。导出期间并上必须用预渲染原尺寸的同步卡片段(判轻时不在预渲染集合里,`export/exportWanted.ts`)
 */
function heavyCardClips(): string[] {
  const plan = currentPlan();
  if (!plan) return [];
  // 剪辑段里的卡(`kernel/cutFlatten.mjs` 的虚拟片段)也在里面:它们各自产单卡流,只由桌面应用与托管方的渲染服务产
  const p = flatPlanProject(getState().project);
  const byId = new Map(p.tracks.flatMap((tr) => tr.clips).map((c) => [c.id, c] as const));
  return [...new Set([...plan.prerenderSet, ...exportWantedClips()])].filter((id) => !!byId.get(id)?.cardId);
}

/** 界限搜索、基准卡测每张卡之前、之后:即时渲染闸门留崩溃记录(`online/stageGate.ts`;测崩了的卡下次直接当重卡) */
const searchMeasureHooks = {
  before: (key: string, cardId: string): void => { stageGate()?.measureStart(key, cardId); },
  after: (_key: string): void => { stageGate()?.measureEnd(); },
};

/** 测崩过的卡(identityKey;崩溃记录里的,这次使用期间不变) */
function crashedCards(): ReadonlySet<string> {
  return stageGate()?.heavyCards() ?? new Set();
}

/**
 * 此刻挂着哪几台舞台:桌面两台(端口没起来时 legacy 只有 A,那时不经这里);在线页面读不到舞台源时一台都不挂,
 * 双舞台两台,只有一个舞台(舞台闸门第一级、最低一档、握手失败退回)只挂跨源的 A。
 */
function mountedStageIds(): StageId[] {
  if (!ONLINE) return [...STAGE_IDS];
  if (!stageOrigins()) return [];
  return dualStage() ? [...STAGE_IDS] : ["A"];
}

/**
 * 舞台素材路径号的作用域(`online/stageIsolation.ts` 的 `setScope`):路径号跟素材连接的项目走(cookie 里是那个项目的票据);
 * `codeProjectId` 是此刻打开的项目(要往舞台发的卡片代码属于它)。页面原地换项目时,项目先换、素材连接后换,
 * 中间这一段两者不同,本页不点头执行,新项目的卡片代码不进拿着上一个项目路径号的舞台文档。
 */
function stageSidScope(): StageSidScope {
  const codeProjectId = currentDocProjectId() || null;
  return { accountId: getSyncView().shared?.accountId || null, projectId: remoteAccountProjectId() || codeProjectId, codeProjectId };
}

/** 声音线程起在哪一台:双舞台实例 B(后台舞台,线程跟实例走),单舞台只有 A */
function soundStageId(): StageId {
  return ONLINE && !dualStage() ? "A" : "B";
}

/** 打开项目的测量落定了没有:只有一个舞台时看界限搜索,两个舞台看后台舞台的常驻探针 */
function measurementSettled(): boolean {
  return planSearch() ? searchJudged() : probeSettledFor(getState().project);
}

/**
 * 素材闸门的结果交给取档策略(`render/mediaTier.ts`):最低一档视频素材只用小尺寸;超过解码上限(`online/mediaGate.ts`,打开时测一次)的
 * 视频素材只用小尺寸。网速(先拉小尺寸还是只拉原尺寸)由舞台自己看(`render/netSpeed.ts`),父页不给。
 */
function mediaGatePolicy(lowest: boolean): Pick<MediaTierPolicy, "smallOnly" | "decodeMaxPixels" | "smallFirst"> {
  return { smallOnly: lowest, decodeMaxPixels: decodeLimit()?.maxPixels ?? null, smallFirst: true };
}

/** 各舞台报来的网速(查看口用) */
const netSpeedByStage: Partial<Record<StageId, { mbps: number | null; samples: number; smallFirst: boolean; at: number }>> = {};

/** 查看口:素材闸门的结果 */
function mediaGateSnapshot(): unknown {
  return { decode: decodeLimit(), net: { ...netSpeedByStage } };
}

function l2SearchCostStore(): CostStore {
  const fallback = createMemoryCostStore();
  const l2 = () => pageL2().catch(() => null);
  return {
    async getCost(key: string) {
      const s = await l2();
      return s ? s.getCost(key) : fallback.getCost(key);
    },
    async putCost(key: string, rec) {
      const s = await l2();
      if (s) await s.putCost(key, rec);
      else fallback.putCost(key, rec);
    },
  };
}

/*
 * 父页的在线浏览器模式开关(C10 契约第 9 节):与舞台 `StageView` 同一个判据(在线构建,或编辑页地址上的
 * `platform=browser`,后者经 `stageSrc` 转给舞台)。开着时这台设备跑不了的卡(用户卡、素材效果卡)一律按重卡贴预渲染结果
 * (`snapshotFeed` 的 `localOnlyOf`、`costIdentity.ts` 不给它们身份),贴不上时是沙漏、等渲染节点的结果
 * (2026-10-21 起没有「本地 PC 辅助渲染」的图标与徽标)。
 */
try { setOnlineBrowserMode(ONLINE || new URLSearchParams(location.search).get("platform") === "browser"); } catch { /* 没有 location */ }

/*
 * A1 的 `localHashes`:**当前连接的素材服务**报 `complete` 的哈希集合,换档判据只看它
 * (`src/render/mediaTier.ts` 的 chooseTier;`docs/semantics/mechanism/asset-service.md`「同步状态只问素材服务」)。
 * 来源是主文档每 2 秒轮询 `GET media/<hash>/chunks`(C6.6,`./media/assetTiers.ts`):
 * 预览挂着时开轮询,集合变了就下发给两个舞台(`setLocalHashes`),主文档的声音层直接读。
 */

/**
 * 中央预览:视频层 + 动效渲染面,按容器缩放。播放循环也在这里(rAF 推进 store.t)。
 *
 * 动效不在这个文档里播:它跑在下面那个 ?stage=1 的 iframe(渲染面)里,时间被接管,
 * 这里只下发「现在是时间轴第几秒」,渲染面渲染出那一帧。所以拖播放头到片段中间
 * 看到的是那一刻该有的画面,而不是把进场动画从头重播一遍。详见 src/StageView.tsx。
 *
 * 视频层:按 videoClipAt 找当前该播的素材段,src 变了换源,时间对不上(>0.2s)就 seek。
 */
export function Preview(props: { variant?: "mobile" } = {}) {
  /** 手机版界面(`src/mobile/`)只要画面:不挂 2D/3D 分页、工具条、播放条,播放与 seek 由手机版自己的控件调同一套 store 动作 */
  const mobile = props.variant === "mobile";

  const project = useStore((s) => s.project);
  // C6.6:两档素材的换档集合(预览挂着时每 2 秒问一次当前素材服务)
  const tierList = useTierHashes();
  // 在线页面没有本机编辑器进程与本地素材服务(c10a 第 2 节:不请求 `/api/*`),先告诉轮询再开
  useEffect(() => { setNoEditorProcess(ONLINE); return startAssetTiers(); }, []);
  // C6.6 设计稿第 9 节第 2 条:打开项目时,缺素材小尺寸、本地有素材原尺寸的视频在后台补转
  // 在线页面没有本机转码(C6.6 的补转走编辑器进程),不补
  // 同一时机补入库没有哈希的老素材;本机取不到的标「(缺失)」,放云端时补上哈希的交给上传队列(backfillUpload.ts)
  useEffect(() => (ONLINE ? undefined : startTierBackfill(backfillHooks)), []);
  const t = useStore((s) => s.t);
  const playing = useStore((s) => s.playing);
  const playToken = useStore((s) => s.playToken);
  const volume = useStore((s) => s.volume);
  const muted = useStore((s) => s.muted);
  const selection = useStore((s) => s.selection);
  const boxRef = useRef<HTMLDivElement>(null);
  /**
   * 两个舞台 iframe(E1)。`A` / `B` **只是实例名,和角色无关** —— 起手 A 当可见舞台、
   * B 当后台舞台(`INITIAL_ROLE_OF`),角色只经 `setRole` 定,K5 的互换之后就换过来了。
   * legacy(缺省)下只挂 A 那一个、同源,和今天一模一样。
   */
  const frameARef = useRef<HTMLIFrameElement>(null);
  const frameBRef = useRef<HTMLIFrameElement>(null);
  /*
   * 在线双舞台的两个舞台(C10 契约第 2 节):舞台源来自运行配置(页面载入时取,`src/online/boot.ts`),握手失败退回同源单舞台。
   * 状态变了要重渲(`dualStage()` 读的是这一份)。运行配置还没取完时先不挂舞台 iframe,免得先按同源挂上、再换源重载一次。
   */
  const onlineStages = useSyncExternalStore(subscribeOnlineStages, onlineStageState, onlineStageState);
  /*
   * 在线浏览器这一次的档位(`src/online/onlineTier.ts`):舞台闸门在页面载入时定下(`online/stageGate.ts`,`boot.ts` 开),
   * 定下之前(要问别的标签页、读崩溃记录)和运行配置还没取完一样,先不挂舞台。
   */
  const tierNow = useSyncExternalStore(subscribeTier, tierState, tierState);
  const stagesPending = ONLINE && (onlineStages.config !== "done" || !tierNow.online);
  const dual = dualStage();
  /**
   * 首次握手的过渡期(`stageHandshake.ts` 的 `interim`,〔裁〕2026-09-30 `claude/stage-handshake`):可见舞台 A 挂上 20 秒还没握上,
   * 先按同源单舞台出画面(`dual` 为假,和退回单舞台同一条路),原来那两个跨源 iframe 不拆,改作隐藏的预热 iframe 继续加载;
   * 两台都握上手就换回双舞台(只换一次)。
   */
  const interim = interimStage();
  /** 首次握手这一轮还在进行(双舞台等握手,或过渡期):计时器跨过「双舞台 → 过渡期 → 换回双舞台」不重建 */
  const handshakeRound = dual || interim;
  /**
   * 换回双舞台那一下的画面衔接〔裁〕:过渡期的同源单舞台留在原位当盖板(不再连 RPC,停在最后一帧),新的可见舞台
   * 先不露出来;等它按新项目画好当前这一帧(第一次 `setTime` 回包之后一小会儿,或播放中报来第一拍)再一次换过来,
   * 最多等 `STAGE_HANDOVER_MAX_MS`。
   */
  const [handoverDone, setHandoverDone] = useState(false);
  const handover = ONLINE && dual && onlineStages.interimAt !== null && !handoverDone;
  const handoverRef = useRef(handover);
  handoverRef.current = handover;
  /**
   * 可见舞台渲 live 变体:双舞台,或在线页面的同源单舞台(`docs/plan/c10a-contract.md` 第 8.1 节)。
   * 播放头跟舞台的 `frame`、快照 / 抑制经 RPC 投递、素材层在舞台里 —— 这些按 `live` 判;
   * 只和后台舞台 B 有关的(互换、补跑、页面触发预渲染)仍按 `dual` 判。
   */
  const live = liveStage();
  const online = singleLiveStage();
  /**
   * 在线浏览器这一次的档位(`src/online/onlineTier.ts`;语义 `product/platforms.md`「在线浏览器」):
   * - `single`:只有一个舞台(舞台闸门停在第一级、最低一档,或握手失败退回):轻重按界限搜索判(借可见舞台测),
   *   停下时由可见舞台逐层追一帧;
   * - `lowest`:最低一档:播放时不做任何即时渲染(显示用的表全部判重)、素材只用小尺寸、轨道流只贴稀疏版。
   * 桌面恒为假。
   */
  const lowest = ONLINE && lowestTier(tierNow);
  const lowestRef = useRef(lowest);
  lowestRef.current = lowest;
  const single = ONLINE && online && !dual && !stagesPending;
  const singleRef = useRef(single);
  singleRef.current = single;
  /**
   * 怎么看这块画布:缩放多少、平移到哪、是不是还跟着窗口自动适应。换算见 preview/viewport2d.ts。
   *
   * `scale` 下面还有七八处在用(命中测试、拖动换算、描边框),所以在这里解出来一个同名的量,
   * 那些地方一个字都不用改 —— 它们本来就只关心「一个画面像素在屏幕上是几像素」。
   */
  const [cam, setCam] = useState<View2D>({ scale: 0.4, tx: 0, ty: 0, auto: true });
  const scale = cam.scale;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const camRef = useRef(cam);
  camRef.current = cam;
  /**
   * 预览窗口有多大。**画框摆在哪儿由我们自己算**,所以这个尺寸得一直拿在手上。
   *
   * 本来是想省掉它的:外层是 grid + place-items:center,画面自己就在正中,
   * 只要再叠一个「相对中心的偏移」就行。**实测发现这条路不通**:画框一旦比窗口高,
   * 浏览器就不再居中了,而是把顶边贴到 0(grid 的 safe 对齐,怕内容溢出到够不着的地方)。
   * 试过 `align-items: unsafe center` 强制真居中 —— 计算样式确实变了,画框照样贴顶。
   * 而「画框比窗口大」正是放大之后的常态,也正是最需要拖动的时候。
   * 于是改成:画框绝对定位在左上角,位置完全由 frameOrigin 算出来,浏览器不掺和。
   */
  const [boxSize, setBoxSize] = useState<{ width: number; height: number } | null>(null);
  /**
   * 渲染面就绪的**代数**,不是一个布尔。0 = 还没就绪,之后每换一个新的渲染面就 +1。
   *
   * 为什么不能是布尔:iframe 里的渲染面换了一个(开发时热更新整页重载、iframe 重新挂载),
   * 它是空的,得重新收一遍 project 和时间。而 `setStageReady(true)` 在已经是 true 时
   * 不改变 state,下面那两个 effect(下发 project、下发时间)就不会重跑 —— 画面一片空白,
   * 得去碰一下时间轴让 `t` 变一下才回来。(最早撞上它的是切 3D 再切回;现在 3D 页不卸 2D 了,
   * 但热重载照样是「新的渲染面 + 旧的 true」。)
   *
   * 换成代数之后,每来一次 `pc-stage-ready` 都是一个新值,两个 effect 必定重跑。
   *
   * `!stageReady` 对 0 照样成立,所以下面那几处判断一个字都不用改。
   */
  const [stageReady, setStageReady] = useState(0);
  /** 每台舞台 iframe 的重建代数:原地换项目(`plan.reload`)时 +1,让 React 卸掉旧 iframe、挂一个全新的浏览上下文(清掉会话历史) */
  const [stageFrameGen, setStageFrameGen] = useState<{ A: number; B: number }>({ A: 0, B: 0 });
  const tRef = useRef(t);
  tRef.current = t;
  /** 上一次收尾(pause)之后给舞台发过 play 没有:收尾时只有真停过播放才认舞台回的 `stoppedAt` */
  const playedRef = useRef(false);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  /*
   * 预览分两页。2D 是成片(预览所见 = 导出所得),3D 是"这些东西在空间里怎么摆"。
   * 两页各自回答一个问题,不要互相迁就 —— 2D 里出现代理色块就是把它的契约破了。
   */
  const [view, setView] = useState<"2d" | "3d">("2d");
  const [pickedTool, setTool] = useState<ToolType>("select");
  // 这个项目只给了只读权限(游客):移动、改文字都是写,工具一律退回「选择」(只能点选看参数);工具栏上那两个也置灰
  const readOnlyProject = useMemberReadOnly();
  const tool: ToolType = readOnlyProject ? "select" : pickedTool;
  const [rects, setRects] = useState<{ clipId: string; left: number; top: number; width: number; height: number }[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clipId: string; cardId: string } | null>(null);
  const [editingText, setEditingText] = useState<{ clipId: string; key: string; value: string; x: number; y: number } | null>(null);
  
  // 记录拖动工具过程中的位移预览状态
  const [dragPreview, setDragPreview] = useState<{ clipId: string; dx: number; dy: number } | null>(null);
  // 舞台上拖动 / 改字中:告诉 Agent 用户正在编辑这张卡(A2)
  useUserEditing("stage-move", dragPreview?.clipId ?? null, "drag");
  useUserEditing("stage-text", editingText?.clipId ?? null, "text");

  /**
   * 舞台的 RPC 客户端(E0):一个 iframe 实例一个,`pc-stage-ready` 握手到了就换新的、旧的 dispose。
   * 主文档和舞台之间只有 postMessage,不再摸 iframe 里的 window.__pcStage。
   * 右栏的定位工具经 stageBridge 拿同一个客户端(D4 页面侧),这里每换一次就登记一次。
   */
  const rpcRef = useRef<Record<StageId, StageRpcClient | null>>({ A: null, B: null });
  const hostCapsRef = useRef<Record<StageId, HostCapabilities | null>>({ A: null, B: null });
  /** 在线双舞台这一轮握上手的舞台(C10 契约第 2 节:两个都握上才算成;超时算失败,退回同源单舞台) */
  const handshookRef = useRef(new Set<StageId>());
  /** 在线双舞台握手之后的看守(心跳断 → 重载那一台 → 重载也握不回来就退回单舞台;`src/online/stageWatch.ts`) */
  const stageWatchRef = useRef<StageWatch | null>(null);
  /** 在线双舞台的首次握手计时(每台从自己 iframe 的 `load` 起算,另有总上限;`src/online/stageHandshake.ts`) */
  const handshakeRef = useRef<StageHandshake | null>(null);
  /**
   * 在线双舞台:后台舞台 B 等可见舞台 A 的 iframe `load` 之后才挂〔裁:2026-09-30 `claude/stage-handshake`〕。
   * 两个舞台各在自己的源上、各下一遍主脚本,同时下载就平分带宽;慢网络下让 A 先独占带宽,用户先看到画面,
   * B 的握手时限从 B 自己的 `load` 起算,不吃亏。桌面(本机)不受影响,照旧一起挂。
   */
  const [backStageMount, setBackStageMount] = useState(false);
  /** 过渡期里预热的两个跨源 iframe(同一个元素,换回双舞台时直接接任 A / B,不重新加载) */
  const warmRef = useRef<Record<StageId, HTMLIFrameElement | null>>({ A: null, B: null });
  const warmRefOf = useMemo(() => ({
    A: (el: HTMLIFrameElement | null) => { warmRef.current.A = el; },
    B: (el: HTMLIFrameElement | null) => { warmRef.current.B = el; },
  }), []);
  /** 每个舞台窗口最近一次的 `pc-stage-ready`(预热期间收到的握手,换回双舞台时照它补一遍握手) */
  const readyByWinRef = useRef(new WeakMap<object, { origin: string; caps: HostCapabilities | null }>());
  /** 握手处理本体(消息 effect 里建;换回双舞台时补握手也走它) */
  const processReadyRef = useRef<(id: StageId, win: Window, origin: string, caps: HostCapabilities | null) => void>(() => {});
  /**
   * 下面那一堆(拖动、命中、心跳、节拍)问的都是**可见舞台**。
   *
   * 起手是 A,但 **K5 的角色互换之后就不是了** —— 所以问 `stageBridge` 要「此刻谁是 `front`」,
   * 不能写死 `rpcRef.current.A`。legacy 的单舞台照样成立(它只登记了一个 `front`)。
   */
  const stage = useCallback((): StageRpcClient | null => frontStage(), []);
  /**
   * 舞台 iframe 的 ref。**卸掉的那一刻就把它的客户端 dispose 并从 stageBridge 摘下。**
   *
   * 以前只在下一次 `pc-stage-ready` 才换掉旧客户端,中间这段 `frontStage()` 一直交出一个
   * 指向已关窗口的客户端:发给它的请求被浏览器静默丢弃、永不回包(3D 页播放失效就是这么挂住的)。
   * 摘掉之后 `stage()` 回 null,各处本来就有的「没有舞台就先不发」分支接手。
   *
   * 回调要**稳定**(useMemo 只建一次):每次渲染换一个新函数的话,React 会先拿 null 调旧的 ——
   * 那就成了每渲染一次 dispose 一次。
   */
  const frameRefOf = useMemo(() => {
    const bind = (id: StageId, holder: React.RefObject<HTMLIFrameElement | null>) => (el: HTMLIFrameElement | null) => {
      holder.current = el;
      if (el) return;
      const client = rpcRef.current[id];
      if (!client) return;
      rpcRef.current[id] = null;
      hostCapsRef.current[id] = null;
      releaseStageClient(client);
      client.dispose();
    };
    return { A: bind("A", frameARef), B: bind("B", frameBRef) };
  }, []);
  /*
   * R9 路线 2(`shared`):编辑器文档开**一个** GL Worker,两个舞台经各自的 `MessageChannel` 共用它。
   * 懒建:生效路线真是 `shared` 时才建。端口在握手之后、任何 RPC 之前交(见下面 `pc-stage-ready` 那段)。
   */
  const sharedGlRef = useRef<SharedGl | null>(null);
  /*
   * 在线执行同步来的用户卡与素材效果卡(`docs/plan/online-card-exec-contract.md` 第 2、8 节)的页面一侧:转译好的包、各舞台报回的运行状态与图形能力、
   * 声音线程的连接。编辑页面只转译、发包、收状态,**不执行任何卡片代码**;包里只有转译结果,不带凭证或票据。
   */
  const cardBundlesRef = useRef<BundleResult[]>([]);
  const stageCardStatesRef = useRef<Partial<Record<StageId, Map<string, CardRunState>>>>({});
  const stageGraphRef = useRef<Partial<Record<StageId, StageGraphCapability>>>({});
  const refreshRunStatesRef = useRef<() => void>(() => {});
  const soundLinkRef = useRef<IsolatedSoundLink | null>(null);
  /** 把此刻的包发给一台(或两台)舞台。本页不能执行时发空表(舞台把已载入的撤下)。声音线程只在一台起(双舞台实例 B,单舞台 A):线程跟实例走,不跟角色走 */
  const pushCardBundles = useCallback((only?: StageId) => {
    if (!ONLINE) return;
    // 先按此刻打开的项目重算作用域:项目换了而素材连接还没换过来(或路径号要换)时,隔离会话当场改判不执行,下面就发空表
    pageStageIsolation(() => onlineStageState().cardExec).setScope(stageSidScope());
    const list: CardBundle[] = cardExecAvailable() ? cardBundlesRef.current.filter((b): b is Extract<BundleResult, { ok: true }> => b.ok).map((b) => b.bundle) : [];
    for (const id of STAGE_IDS) {
      if (only && only !== id) continue;
      const c = rpcRef.current[id];
      if (c) void c.loadUserCards(list, { sound: id === soundStageId() }).catch(() => { /* iframe 正在换:下一次握手会重发 */ });
    }
  }, []);
  const pushCardBundlesRef = useRef(pushCardBundles);
  pushCardBundlesRef.current = pushCardBundles;
  /*
   * 页面一侧的执行前提(`cardRuntime/gate.ts`)由隔离会话立起来:站点总开关、双舞台握手、两台自检、票据交接(`online/stageIsolation.ts`)。
   * 画面那一半另要两台的出口都由浏览器拦(`egress: "allowlist"`;〔裁:主会话 2026-10-06〕只靠脚本加固的浏览器上画面不执行,声音线程照常)。
   */
  useEffect(() => {
    if (!ONLINE) return;
    const sync = () => {
      const s = onlineCardExec();
      setCardExecGate({ site: onlineStageState().cardExec, isolated: s.enabled, reason: s.enabled ? null : s.reason, visual: true });
    };
    const offs = [subscribeOnlineCardExec(sync), subscribeOnlineStages(sync)];
    sync();
    return () => { for (const off of offs) off(); setCardExecGate({ isolated: false, reason: "页面卸载", visual: true }); };
  }, []);
  /** 每台舞台的取档策略发到第几次了(等自检与票据交接是异步的,晚回来的旧一次不许盖掉新的) */
  const policySeqRef = useRef<Partial<Record<StageId, number>>>({});
  /** 各舞台窗口(含预热的)发来的自检结果:握手时清、结果到了存;换回双舞台时补交给隔离会话 */
  const isoByWinRef = useRef(new WeakMap<object, IsolationReport | null>());
  const glPortTo = useCallback((id: StageId, win: Window, caps: HostCapabilities | null) => {
    // 在线页面的路线跟舞台闸门走(`tierGlRoute`),桌面按项目选项
    if ((ONLINE ? tierGlRoute() : resolveGlRoute(getState().project.glRoute)) !== "shared") return;
    sharedGlRef.current ??= createSharedGl({ compact: !!caps?.compact });
    sharedGlRef.current.connect(win, stageTargetOrigin(id), id);
    if (typeof window !== "undefined") (window as unknown as Record<string, unknown>).__pcSharedGlDiag = () => sharedGlRef.current?.diag() ?? Promise.resolve(null);
  }, []);
  /*
   * c10a 第 8 节:取档策略(素材闸门的结果 + 在线页面的远程素材服务)。主文档自己的声音层读模块级那份,
   * 舞台是另一个文档,经 `setMediaPolicy` 下发。**只在在线模式里发**:桌面运行环境两边都照缺省,一个字节不变。
   */
  const pushMediaPolicy = useCallback(async (): Promise<void> => {
    if (!ONLINE) return;
    const base = remoteAssetBase();
    let ticket: string | null = null;
    // 等票据时素材连接或打开的项目换了(A → B):A 的票据不能交到按 B 算的路径号下,这一次作废(换连接、换作用域都会再推一次)
    const scopeKey = () => JSON.stringify([remoteAssetBase(), stageSidScope()]);
    const scopeBefore = scopeKey();
    if (base) { try { ticket = await remoteAssetTicket(); } catch { ticket = null; } }
    if (scopeKey() !== scopeBefore) return;
    const policy: MediaTierPolicy = { ...mediaGatePolicy(lowestRef.current), online: true, remote: base ? { base, ticket } : null };
    setMediaTierPolicy(policy);
    /*
     * 跨源的舞台(C10 契约第 2 节「舞台读素材」):一律用相对地址读**自己源上**的反代,不跨源直读素材服务
     * (那要靠 CORS,媒体画进 canvas 会污染它)。
     *
     * 票据怎么给(契约 `online-card-exec-contract.md` 第 4.1 节,`online/stageIsolation.ts`):这一台自检通过、票据交接成功 →
     * 舞台读 `/media-s/<sid>/media/<哈希>`,票据不经 RPC(舞台源的服务端把它换成 HttpOnly cookie);否则照旧:基址换成 `/media` 的路径、
     * 票据经 RPC 下发、走 `?t=`(这样的舞台文档不执行用户卡)。素材服务不在编辑器页源的 `/media/api/asset` 上(别的主机、别的路径)时没有那条反代,照旧。
     */
    const iso = pageStageIsolation(() => onlineStageState().cardExec);
    iso.setStages(mountedStageIds());
    iso.setScope(stageSidScope());
    const origins = stageOrigins();
    const stageBase = base ? stageAssetBase(base, location.origin) : null;
    await Promise.all(STAGE_IDS.map(async (id) => {
      const c = rpcRef.current[id];
      if (!c) return;
      const seq = (policySeqRef.current[id] = (policySeqRef.current[id] ?? 0) + 1);
      let stagePolicy: StageMediaPolicy = { smallOnly: policy.smallOnly, decodeMaxPixels: policy.decodeMaxPixels, remote: policy.remote };
      if (base && stageBase) {
        const plan = stageBase === MEDIA_PROXY_BASE && origins
          ? await iso.plan(id, { active: mountedStageIds().includes(id), stageOrigin: origins[id], ticket })
          : { mode: "legacy" as const, base: null, ticket, cardExec: false };
        // 等自检与交接的时候这一台换了、或者又发起了一次更新的:这一次作废
        if (rpcRef.current[id] !== c || policySeqRef.current[id] !== seq) return;
        if (plan.reload) {
          // 舞台已经拿过上一个项目的路径号:重建这个槽位的 iframe 元素(新浏览上下文,清掉会话历史条目与 window.name)
          releaseStageClient(c);
          c.dispose();
          rpcRef.current[id] = null;
          hostCapsRef.current[id] = null;
          setStageFrameGen((prev) => ({ ...prev, [id]: prev[id] + 1 }));
          return;
        }
        stagePolicy = plan.mode === "cookie"
          ? { smallOnly: policy.smallOnly, decodeMaxPixels: policy.decodeMaxPixels, remote: { base: plan.base!, ticket: null }, cardExec: plan.cardExec }
          : { smallOnly: policy.smallOnly, decodeMaxPixels: policy.decodeMaxPixels, remote: { base: stageBase, ticket: plan.ticket } };
      }
      void c.setMediaPolicy(stagePolicy).catch(() => { /* iframe 正在换:下一次握手会重发 */ });
    }));
  }, []);
  // 本页能不能执行用户卡变了(另一台也隔离好了、出了加固拦下的事):两台的取档策略重发一遍
  useEffect(() => {
    if (!ONLINE) return;
    return pageStageIsolation(() => onlineStageState().cardExec).subscribe(() => { void pushMediaPolicyRef.current(); });
  }, []);
  const pushMediaPolicyRef = useRef(pushMediaPolicy);
  pushMediaPolicyRef.current = pushMediaPolicy;
  // 布局变了(握手失败退回单舞台):隔离会话按此刻挂着的舞台重算能不能执行(单舞台同样跨源隔离,照样执行用户卡)
  useEffect(() => {
    if (ONLINE) pageStageIsolation(() => onlineStageState().cardExec).setStages(mountedStageIds());
  }, [dual, stagesPending]);
  useEffect(() => {
    if (!ONLINE) return;
    void pushMediaPolicy();
    // 远程素材服务换了(进入 / 离开共享项目)就重发。票据按它自己的寿命续:剩一半就重发一次(15 分钟的票据约 7 分钟一次;
    // 测试里缩短了票据时限时跟着变快 —— C10 契约第 12 节),至多 5 分钟一次
    const off = subscribeRemoteAssets(() => { void pushMediaPolicy(); });
    // 解码上限测出来了(打开时测一次):重发一次,超过上限的视频素材改用小尺寸
    const offDecode = subscribeDecodeLimit(() => { void pushMediaPolicy(); });
    let timer = 0;
    let alive = true;
    const loop = async () => {
      if (!alive) return;
      await pushMediaPolicy();
      const info = await remoteAssetTicketInfo(false);
      const left = info ? info.exp - Date.now() : 5 * 60_000;
      if (alive) timer = window.setTimeout(() => { void loop(); }, Math.max(1000, Math.min(5 * 60_000, left / 2)));
    };
    timer = window.setTimeout(() => { void loop(); }, 1000);
    return () => { alive = false; off(); offDecode(); window.clearTimeout(timer); };
  }, [lowest, pushMediaPolicy]);
  /*
   * 素材闸门:载入原尺寸之前留崩溃记录(`mechanism/platforms.md`「素材闸门」)。项目里要载入原尺寸的视频(没超过解码上限)换了一批
   * (打开项目、导入了新素材)时,记「载入素材原尺寸」,`MEDIA_MARK_MS` 之后回到原来那一步;这段时间里页面崩了,下次载入解码上限调低一级。
   * 最低一档不拉原尺寸,不记。
   */
  const mediaSigRef = useRef("");
  const decodeReady = useSyncExternalStore(subscribeDecodeLimit, () => decodeLimit() !== null, () => false);
  const mediaMarkTimerRef = useRef(0);
  useEffect(() => {
    // 等舞台闸门走完、基准卡测完再记(免得这一步盖掉舞台闸门的那几步,崩了算错地方)
    if (!ONLINE || lowest || !stageReady || tierNow.gate !== "done" || tierNow.benchmark === "pending") return;
    const g = stageGate();
    const lim = decodeLimit();
    if (!g || !lim) return;
    const sig = originalLoadSignature(project.media ?? [], lim.maxPixels);
    if (!sig || sig === mediaSigRef.current) return;
    mediaSigRef.current = sig;
    g.mediaStart(lim.index);
    window.clearTimeout(mediaMarkTimerRef.current);
    mediaMarkTimerRef.current = window.setTimeout(() => stageGate()?.mediaEnd(), MEDIA_MARK_MS);
  }, [project.media, lowest, stageReady, tierNow.gate, tierNow.benchmark, decodeReady]);
  useEffect(() => () => window.clearTimeout(mediaMarkTimerRef.current), []);
  /*
   * 只有一个舞台时轻重按共享成本记录加界限搜索判(下面那个 effect);最低一档播放时不做任何即时渲染(显示用的表全部判重)。
   * 判定的表决定清单计划发哪些片段、导出时谁本机渲(语义 `product/platforms.md`「在线浏览器」的「轻重判定」与「最低一档」)。
   */
  /** 两个舞台、项目里有别的机器测好的记录:打开时按界限搜索判(在后台舞台里只测几张),常驻探针补测完再改按成本记录(下面那个 effect) */
  const [dualSearch, setDualSearch] = useState(false);
  useEffect(() => {
    setPlanSearch(single || dualSearch);
    return () => setPlanSearch(false);
  }, [single, dualSearch]);
  useEffect(() => {
    setPlanLowest(lowest);
    return () => setPlanLowest(false);
  }, [lowest]);
  /*
   * L4(C10 契约第 6 节、第 18 节第 1 条):在线页面重层每拍的换帧成本进每拍预算,分派时每张重卡每拍的固定成本也换成它
   * (两边同一个预算)。最低一档播放时不活渲,不用这一套。
   */
  useEffect(() => {
    const on = ONLINE && !lowest;
    // 每层的换帧成本按卡种取(swap-tuning 实测,`beatSwap.mjs` 的 `SWAP_MS_BY_KIND`);认不出卡种的按缺省 `SWAP_MS`
    setBeatSwap(on, { swapMs: SWAP_MS, occupied: lightCostAt, costOf: on ? layerSwapMs : null });
    setPlanDeadMs(on ? SWAP_MS : null, on ? layerSwapMs : null);
    return () => { setBeatSwap(false, { costOf: null }); setPlanDeadMs(null); };
  }, [lowest]);
  /* C10 契约第 3 节:在线页面后台舞台测的成本记录存进 L2 的 `costs` 表(`mode=build`,关掉再开不重测) */
  useEffect(() => {
    if (!ONLINE) return;
    setCostBackend({ ...l2CostBackend(pageL2()), forwardFrames: false });
    /*
     * 测完写进文档服务(契约第 3 节、第 18 节第 7 条;交接文件第 2.2 节第 2 条):连着共享项目时,每测完一张卡当场转写一次。
     * 下面的 `SharedCostRelay` 每 5 秒也会从分派表里补传(接上共享项目之前测过的、这里没发成的),两路都走也无害:
     * 文档服务按测量时刻留最新。
     */
    const diag = { calls: 0, ok: 0, failed: 0, records: 0, lastError: null as string | null };
    const off = onCostRecords((records) => {
      if (!hasDocLink() || !currentSharedLink()) return;
      const projectId = currentDocProjectId();
      if (!projectId) return;
      const input = records.map((r) => toSharedInput(r)).filter((r): r is SharedCostInput => !!r);
      if (!input.length) return;
      diag.calls++;
      void publishSharedCosts({ request: docRequest, projectId, environment: pageEnvironment(), records: input })
        .then((r) => { if (r.ok) { diag.ok++; diag.records += input.length; } else { diag.failed++; diag.lastError = r.error ?? null; } })
        .catch((e) => { diag.failed++; diag.lastError = String(e); });
    });
    const w = window as unknown as Record<string, unknown>;
    w.__pcCostPublish = () => ({ ...diag });
    return () => { off(); setCostBackend(null); delete w.__pcCostPublish; };
  }, []);
  /* 最低一档切到后台时停预览(c10a 契约第 13 节 Q2 的采纳:后台计时器、rAF 都不保证继续,回来时从停着的地方接) */
  useEffect(() => {
    if (!ONLINE || !lowest) return;
    const onHide = () => { if (document.visibilityState === "hidden" && getState().playing) actions.pause(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => { document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", onHide); };
  }, [lowest]);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  /*
   * 播放循环。**播放头只停在成片真有的那些帧上。**
   *
   * 以前是按墙上时钟连续推的:显示器 60Hz 就一秒推 60 个 t,而成片是 fps 帧的,
   * 于是有一半的 t 在成片里根本不存在。单看 2D 察觉不到,一切到 3D 就露馅 ——
   * 那边显示的是预渲染好的整帧,两个视图对同一个播放头能差半帧,而进场动画最陡的就是那一段。
   * 量化之后 2D 播放显示的就是导出会写出来的那一帧,3D 贴的也是同一帧。
   *
   * 累加器 acc 必须保持不量化,不然每帧丢掉的那点余数会累起来,播放越走越慢。
   *
   * 播放范围 = 最早的卡片 ~ 最晚的卡片(project.duration 由时间轴按内容末尾同步)。
   * 按播放时播放头不在这个范围里(在第一张卡前面,或者已经播到头),从最早那张卡开始播。
   */
  const contentStart = contentStartOf(project.tracks);
  /** 舞台那一路的 `playing` effect 依赖只有三项(见那里的说明),播放起点从这里读 */
  const contentStartRef = useRef(contentStart);
  contentStartRef.current = contentStart;
  useEffect(() => {
    /*
     * E6:**非 legacy 下这个循环不启动** —— 播放头由 K4 的 `frame` 事件推进
     * (可见舞台自己按帧节拍,每拍渲完才报)。墙钟循环只留给 `?preview=legacy`。
     */
    if (live) return;
    if (!playing) return;
    const fps = Math.max(1, project.fps || 30);
    let raf = 0;
    let last = performance.now();
    let acc = tRef.current;      // 真实推进到哪儿(不量化)
    if (acc < contentStart || acc >= project.duration - 0.5 / fps) {
      acc = contentStart;
      actions.seek(contentStart);
    }
    let wrote = atFrameGrid(acc, fps);  // 上一次交出去的帧时刻
    const tick = (now: number) => {
      /*
       * 播放中外面也可能 seek(点时间轴、拖播放头),那时以外面的为准。
       * 判据是「差得比一帧还多」而不是「不相等」:tRef 在 render 里才赋值,量化之后 store 的 t
       * 可能比这里晚一帧,那不是 seek —— 按 seek 处理会让播放隔几帧倒退一格。
       */
      if (Math.abs(tRef.current - wrote) > 1.5 / fps) acc = tRef.current;
      acc += (now - last) / 1000;
      last = now;
      if (acc >= project.duration) {
        actions.pause();
        actions.seek(project.duration);
        return;
      }
      wrote = atFrameGrid(acc, fps);
      actions.tick(wrote);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // contentStart 不进依赖:播放中挪了第一张卡不该把播放头拽回去
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, playing, project.duration, project.fps]);

  /*
   * 量一次窗口有多大,顺便在「自动适应」还开着时重新算缩放比。
   *
   * 两件事都要做,原因不同:
   *   - 窗口尺寸**必须一直跟着量**,因为画框摆在哪儿是我们自己算的(见下面 frameOrigin),
   *     算式里就有窗口宽高;
   *   - 缩放比只在 auto 时重算。以前这里是无条件重算的,那时候没有手动缩放也就无所谓。
   *     现在不行了:用户放大到 200% 去调一个字的位置,拖一下侧栏宽度(ResizeObserver 就响了),
   *     画面「啪」地跳回适应窗口,刚找好的地方就没了。
   *
   * 用 useLayoutEffect 而不是 useEffect:第一次渲染时还不知道窗口多大,画框会先摆在左上角。
   * 布局效应在浏览器绘制**之前**同步跑完并触发重渲染,所以那一帧用户看不见。
   */
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      setBoxSize({ width: r.width, height: r.height });
      if (camRef.current.auto) setCam(fitView(project, r, mobile ? 0 : undefined));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height, view]);

  /** 回到「适应窗口」。工具行那个徽章点一下就走这儿 */
  const fitToWindow = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    setCam(fitView({ width: project.width, height: project.height }, r, mobile ? 0 : undefined));
  }, [project.width, project.height]);

  /*
   * 滚轮缩放 + 中键拖动平移。
   *
   * 为什么不用 React 的 onWheel:React 17 起把 wheel 绑成**被动**监听器,
   * 里面调 preventDefault 不但不起作用,还会在控制台报一行警告 ——
   * 于是滚轮在缩放画面的同时把整个面板也滚了。只能自己 addEventListener 并显式关掉 passive。
   *
   * 依赖里只有画幅:cam 走 ref 读最新值,否则每缩放一格就要重新解绑重绑一次监听器。
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const box = () => el.getBoundingClientRect();
    const size = { width: project.width, height: project.height };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = box();
      const factor = wheelZoomFactor(e.deltaY, e.deltaMode);
      if (factor === 1) return;
      const cur = camRef.current;
      setCam(zoomAt(cur, size, r, { x: e.clientX - r.left, y: e.clientY - r.top }, cur.scale * factor));
    };

    /*
     * 中键拖动:按住不放拖动画布。左键留给选择 / 移动工具(它自己判 button !== 0 就退出),
     * 右键留给菜单,所以平移只认中键 —— 三个键各管一件事,不用按修饰键。
     */
    let panning = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      // 中键在很多浏览器上是「自动滚动」,不拦住就会弹出那个圆形滚动光标
      e.preventDefault();
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      // 抓住指针,拖出预览区也照样跟手。指针要是已经没了(松开得比这行还早)会抛,不该因此中断拖动
      try { el.setPointerCapture(e.pointerId); } catch { /* 没抓住就算了,照样能拖,只是出了区域会断 */ }
      el.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (!panning) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      setCam(panBy(camRef.current, size, box(), dx, dy));
    };
    const stopPan = (e: PointerEvent) => {
      if (!panning) return;
      panning = false;
      try { if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); } catch { /* 已经放开了 */ }
      el.style.cursor = "";
    };
    // 中键按下默认会开自动滚动,auxclick 也要拦一下,否则松开时还会触发
    const onAux = (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", stopPan);
    el.addEventListener("pointercancel", stopPan);
    el.addEventListener("auxclick", onAux);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", stopPan);
      el.removeEventListener("pointercancel", stopPan);
      el.removeEventListener("auxclick", onAux);
    };
  }, [project.width, project.height, view]);

  /*
   * 渲染面就绪:它挂载完会 postMessage 过来(带 J4 的宿主能力表);每来一次就给**那一个实例**
   * 建一个新的 RPC 客户端。跨源时 `targetOrigin` 必须点名舞台的源(不能再用 `location.origin`)。
   *
   * 握手之后立刻发一次 `setRole` 把实例和角色对上:舞台自己的缺省角色是 `front`,
   * B 那个 iframe 不发就会顶着 `front` 的身份收探针(角色闸门会挡下来,但那是兜底不是设计)。
   */
  useEffect(() => {
    const frames: Record<StageId, React.RefObject<HTMLIFrameElement | null>> = { A: frameARef, B: frameBRef };
    /*
     * 在线的跨源舞台(契约 `online-card-exec-contract.md` 第 3.2 节):只认 `event.origin` 是运行配置里那个舞台源的消息。
     * 同源单舞台、桌面运行环境照旧不看(那里由 `event.source` 把关)。
     */
    const originOk = (id: StageId, origin: string, crossOrigin: boolean): boolean => {
      if (!ONLINE || !crossOrigin) return true;
      const o = stageOrigins();
      return !!o && origin === o[id];
    };
    const onMessage = (e: MessageEvent) => {
      const type = (e.data as { type?: string } | null)?.type;
      if (type === "pc-stage-isolation") {
        // 跨源舞台的自检结果、或加固拦下了事(`online/isolation/stageGuard.ts`):只在在线模式里认,只认自己挂的跨源舞台
        if (!ONLINE || !e.source) return;
        const iso = pageStageIsolation(() => onlineStageState().cardExec);
        for (const id of STAGE_IDS) {
          const warm = warmRef.current[id]?.contentWindow;
          const live = mountedStageIds().includes(id) ? frames[id].current?.contentWindow : null;
          if (e.source !== warm && e.source !== live) continue;
          if (!originOk(id, e.origin, true)) return;
          const d = e.data as { report?: unknown; breach?: unknown };
          const breach = sanitizeBreach(d.breach);
          if (breach) { iso.breach(breach); return; }
          const report = sanitizeIsolationReport(d.report);
          isoByWinRef.current.set(e.source, report);
          if (e.source === live && rpcRef.current[id]) iso.report(id, report);
          return;
        }
        return;
      }
      if (type === "pc-stage-cards") {
        // 舞台按新卡重渲完了(C6.6 集成 3b,`stageCards.ts`)
        for (const id of STAGE_IDS) if (e.source === frames[id].current?.contentWindow) noteStageCards(id, Number((e.data as { stamp?: number }).stamp) || 0);
        return;
      }
      if (type !== "pc-stage-ready") return;
      const rawCaps = (e.data as { hostCapabilities?: HostCapabilities }).hostCapabilities ?? null;
      // 在线页面:能力表按形状收一遍(跨源舞台的消息当不可信输入);桌面运行环境原样
      const readyCaps = ONLINE ? (sanitizeHostCapabilities(rawCaps) as HostCapabilities | null) : rawCaps;
      if (e.source && !ONLINE) readyByWinRef.current.set(e.source, { origin: e.origin, caps: readyCaps });
      // 过渡期里预热的跨源舞台握上手了:只记进首次握手的计时(不建 RPC;换回双舞台时再补握手)
      for (const id of STAGE_IDS) {
        const warm = warmRef.current[id]?.contentWindow;
        if (warm && e.source === warm) {
          if (!originOk(id, e.origin, true)) return;
          readyByWinRef.current.set(warm, { origin: e.origin, caps: readyCaps });
          isoByWinRef.current.delete(warm); // 新文档:旧的自检结果作废
          handshakeRef.current?.ready(id);
          return;
        }
      }
      for (const id of STAGE_IDS) {
        const win = frames[id].current?.contentWindow;
        if (!win || e.source !== win) continue;
        if (!originOk(id, e.origin, dualRef.current || ONLINE)) return;
        readyByWinRef.current.set(win, { origin: e.origin, caps: readyCaps });
        isoByWinRef.current.delete(win);
        processReadyRef.current(id, win, e.origin, readyCaps);
        return;
      }
    };
    processReadyRef.current = (id, win, origin, caps) => {
      {
        /*
         * 这个实例此刻该是什么角色。**不能一律照 `INITIAL_ROLE_OF` 走** ——
         * K5 的互换之后 A 可能已经是后台那一个了,它热重载一次就会顶着 `front` 回来、
         * 把真正的可见舞台顶掉。
         */
        const role = frontIdRef.current === id ? "front" : "back";
        // 新载入的舞台就是最新的卡片代码
        noteStageFresh(id);
        rpcRef.current[id]?.dispose();
        // 回包发给这个 iframe 此刻真实的源(换源重载的过渡期里 `stageTargetOrigin` 可能已经是另一个)
        const targetOrigin = origin && origin !== "null" ? origin : stageTargetOrigin(id);
        // 在线的跨源舞台:回包与事件当不可信输入校验(`online/stageMessageGuard.ts`);同源单舞台、桌面运行环境照旧
        const untrusted = ONLINE && targetOrigin !== location.origin;
        const client = createStageRpc(win, targetOrigin, { untrusted, maxSec: () => getState().project.duration });
        if (ONLINE) {
          /*
           * 轨道流(`docs/plan/browser-stream-task.md` 第七处):在线页面的舞台不自己取流的字节,父页发流平面时把清单和这台舞台还没有的
           * 块一起带过去(`streamPlayer.ts` 的 `StreamPlaneSender` / `PushedStreamSource`;为什么不让舞台自己取,见那里的说明)。
           * 接在这台舞台的 RPC 客户端上:每一处发流平面的(下面的 `pumpFeed`、`stageSwap.ts` 换班时那一次)都经过它,不用各改一遍。
           * 一台舞台一本账;调用失败(舞台在换)就清账,下一次全部重发。
           */
          const sender = new StreamPlaneSender((key) => activeOnlineSource()?.streamPlane(key) ?? null);
          const sendPlanes = client.setStreamPlanes.bind(client);
          client.setStreamPlanes = (planes) => sendPlanes(sender.decorate(planes)).catch((err: unknown) => { sender.reset(); throw err; });
        }
        if (ONLINE) {
          // 隔离会话:这一台是新文档,先清掉旧的自检结果与取档方式;它的结果要是已经到了(预热期间)就补交
          const iso = pageStageIsolation(() => onlineStageState().cardExec);
          iso.setStages(mountedStageIds());
          iso.handshake(id);
          const stored = isoByWinRef.current.get(win);
          if (mountedStageIds().includes(id) && stored !== undefined) iso.report(id, stored);
        }
        handshookRef.current.add(id);
        // 过渡期的同源单舞台握手不算首次握手(那是 A 的另一个 iframe)
        if (dualRef.current) handshakeRef.current?.ready(id);
        if (ONLINE && dualRef.current && handshookRef.current.has("A") && handshookRef.current.has("B")) markStageHandshake("ok");
        stageWatchRef.current?.ready(id);
        rpcRef.current[id] = client;
        hostCapsRef.current[id] = caps;
        if (ONLINE) {
          // 新文档:这一台以前报的运行状态、图形能力、声音线程都作废,等它重新载入后再报
          delete stageCardStatesRef.current[id];
          delete stageGraphRef.current[id];
          if (id === soundStageId()) soundLinkRef.current?.setState(null);
          refreshRunStatesRef.current();
          client.onEvent((e) => {
            if (rpcRef.current[id] !== client) return;
            if (e.type === "card-states") {
              // 画面那一半在这一台不执行(`visual: false`)时没有状态可言:当它没报
              if (e.visual) stageCardStatesRef.current[id] = new Map(e.states); else delete stageCardStatesRef.current[id];
              stageGraphRef.current[id] = e.graph;
              setNodeGraphCapable(STAGE_IDS.every((s) => stageGraphRef.current[s] === "ok"));
              refreshRunStatesRef.current();
            } else if (e.type === "net-speed") {
              netSpeedByStage[id] = { mbps: e.mbps, samples: e.samples, smallFirst: e.smallFirst, at: Date.now() };
            } else if (e.type === "sound-state" && id === soundStageId()) {
              soundLinkRef.current?.setState(e.state);
            }
          });
        }
        // R9 端口转交协议:路线 2 下,握手之后、发任何 RPC(含下面的 setRole)之前先把 GL 端口交过去
        glPortTo(id, win, caps);
        // 能力表一起登记:K1 的 device 串要 compact / offscreenGl,而它必须是**舞台**探到的那一份
        setStageClient(role, client, caps);
        void client.setRole(role).catch(() => { /* iframe 又换了,下一次握手会重发 */ });
        // c10a 第 8 节:在线页面把取档策略(素材闸门的结果、远程素材服务)交给这一台舞台;桌面运行环境不发,舞台照缺省
        if (ONLINE) void pushMediaPolicyRef.current();
        // C10 契约第 9 节:内容库同步来的用户卡(本机跑不了)交给这一台舞台;桌面运行环境不发
        if (ONLINE) void client.setSyncedUserCards([...syncedUserCards().values()]).catch(() => { /* iframe 又换了,下一次握手会重发 */ });
        // 在线执行:转译好的包交给这一台(排在同步表之后:舞台按同步表把入口摊到卡片 id 上);闸门没开的舞台先记着
        if (ONLINE) pushCardBundlesRef.current(id);
        // 预览缩放倍数交给舞台:占位符(沙漏)据此补偿,屏幕上看得清;桌面与在线都发
        void client.setViewScale(scaleRef.current).catch(() => { /* 同上 */ });
        // 每来一次就 +1:同一个值再赋一遍不会触发重渲染,而新挂的 iframe 需要重新收一遍 project 和时间
        if (role === "front") setStageReady((n) => n + 1);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const id of STAGE_IDS) {
        rpcRef.current[id]?.dispose();
        rpcRef.current[id] = null;
        setStageClient(INITIAL_ROLE_OF[id], null);
      }
      sharedGlRef.current?.dispose();
      sharedGlRef.current = null;
    };
  }, [glPortTo]);

  /*
   * 首次握手(C10 契约第 2 节;〔裁〕2026-09-30 `claude/stage-handshake`):每台的 20 秒从那一台 iframe 的 `load` 起算
   * (慢网络下舞台页光下载就要几十秒,不再算作握手失败),自挂上起另有总上限;到点没都握上照旧退回同源单舞台。
   */
  useEffect(() => {
    if (!ONLINE || !handshakeRound) return;
    // 这一轮只从 `pending` 开始计时(过渡期、换回之后都不重建;真走到这里说明布局被别的原因打断过,按失败收场)
    if (onlineStageState().handshake !== "pending") {
      if (onlineStageState().handshake === "interim") markStageHandshake("failed", "过渡期的首次握手计时中断");
      return;
    }
    handshookRef.current = new Set();
    const hs = createStageHandshake({
      ids: STAGE_IDS,
      fail: (reason) => {
        console.warn(`[preview] ${reason},退回同源单舞台`);
        markStageHandshake("failed", reason);
      },
      ok: () => markStageHandshake("ok"),
      interim: (reason) => {
        console.warn(`[preview] ${reason}`);
        markStageHandshake("interim", reason);
      },
    });
    handshakeRef.current = hs;
    // 这一轮已经握过手的舞台(effect 晚于握手跑到时)照样记上
    for (const id of STAGE_IDS) if (rpcRef.current[id]) hs.ready(id);
    const w = window as unknown as { __pcStageHandshake?: () => unknown };
    w.__pcStageHandshake = () => hs.status();
    return () => {
      hs.dispose();
      if (handshakeRef.current === hs) handshakeRef.current = null;
      // 退回、换回之后留着观察口(探针核原因与时刻)
      if (hs.phase !== "failed" && hs.phase !== "ok") delete w.__pcStageHandshake;
    };
  }, [handshakeRound]);
  /** 跨源舞台 iframe 的 `load`(跨源也触发;预热期间也是它):首次握手按它起算;A 加载完才挂 B */
  const onStageFrameLoad = useCallback((id: StageId) => {
    handshakeRef.current?.loaded(id);
    // 在线页面的后台舞台由舞台闸门挂(可见舞台就绪、载入项目之后才试后台舞台,下面那个 effect);桌面照旧 A 加载完就挂
    if (id === "A" && !ONLINE) setBackStageMount(true);
  }, []);
  /*
   * 即时渲染闸门(语义 `product/platforms.md`「即时渲染闸门」;做法 `mechanism/platforms.md`「即时渲染闸门」):
   * - 测每张卡之前留崩溃记录(后台舞台的常驻探针、单舞台的界限搜索都经这里);测崩过的卡不再测、直接当重卡;
   * - 舞台闸门走完之后先测基准卡:连它都跑不动就进最低一档(播放时不做任何即时渲染)。最低一档(一个舞台都撑不住)不测。
   */
  useEffect(() => {
    if (!ONLINE) return;
    setProbeMeasureHooks({
      before: (key, cardId) => stageGate()?.measureStart(key, cardId),
      after: () => stageGate()?.measureEnd(),
      skip: (key) => crashedCards().has(key),
    });
    setPlanForcedHeavy(crashedCards());
    return () => { setProbeMeasureHooks(null); setPlanForcedHeavy([]); };
  }, [tierNow.online]);
  /*
   * 舞台按这一级挂好了(后面舞台闸门的驱动走完)。护栏内、崩过、安卓不到 8 GB 的(`fixed`)一打开 `gate` 就是 `done`,可舞台还没挂好:
   * 基准卡要等它,不然在后台舞台还没起来时测、测不出来(语义「即时渲染闸门」:舞台闸门走完之后先测基准卡)。
   */
  const [gateDriven, setGateDriven] = useState(false);
  const benchmarkRunRef = useRef(false);
  const [benchmarkInfo, setBenchmarkInfo] = useState<BenchmarkOutcome | null>(null);
  useEffect(() => {
    if (!ONLINE || benchmarkRunRef.current || !stageReady || tierNow.gate !== "done" || !gateDriven) return;
    benchmarkRunRef.current = true;
    if (tierNow.lowest) { setBenchmark("skipped"); return; }
    const borrow = !dualRef.current;
    void (async () => {
      let out: BenchmarkOutcome;
      if (borrow) {
        out = await runBenchmark({
          borrow: true, stage: frontStage, pushProject: (p) => pushProject("front", p, { reset: true }), currentProject: () => getState().project,
          restore: () => { suppressedRef.current = ""; streamPlanesRef.current = "[]"; markBaselineReset("front"); setStageReady((n) => n + 1); },
          beforeMeasure: searchMeasureHooks.before, afterMeasure: searchMeasureHooks.after,
        });
      } else {
        out = await runBackJob("measure", (ctx) => runBenchmark({
          borrow: false, stage: () => ctx.stage, pushProject: (p) => pushProject("back", p, { reset: true }), currentProject: () => getState().project,
          restore: () => {}, beforeMeasure: searchMeasureHooks.before, afterMeasure: searchMeasureHooks.after,
        })).catch(() => benchmarkVerdict(null));
      }
      setBenchmarkInfo(out);
      if (out.verdict === "slow") stageGate()?.benchmarkSlow();
      setBenchmark(out.verdict === "slow" ? "slow" : out.verdict === "ok" ? "ok" : "skipped");
    })();
  }, [stageReady, tierNow.gate, tierNow.lowest, gateDriven]);

  /*
   * 舞台闸门(语义 `product/platforms.md`「在线浏览器」;做法 `mechanism/platforms.md`「舞台闸门的步骤」第 2～5 条):
   * 可见舞台握上手、载入项目 → 记「可见舞台就绪」;要试第二级就记「开始试后台舞台」再挂 B,两个舞台都握上手并载入项目后记「双舞台已载入」;
   * 要试第三级就记「开始试每个舞台各一套渲染器」,两台原地换到路线 1(`setGlRoute`,不重建舞台),回包后记下;走完之后这次使用期间
   * 停在到达的那一级。护栏内、崩过、安卓不到 8 GB 的(`fixed`)不试,只把舞台按那一级挂好。每一步的记录写在崩溃记录里(`stageGate.ts`)。
   * 握手容错(握不上、握上又断就退回单舞台)只管当次、不留崩溃记录(下面另一个 effect)。
   */
  const gateRunRef = useRef(false);
  const [gateDiag, setGateDiag] = useState<string>("");
  useEffect(() => {
    if (!ONLINE || !stageReady || gateRunRef.current) return;
    const g = stageGate();
    if (!g) return;
    gateRunRef.current = true;
    const trying = !g.decision.fixed;
    /*
     * `?gateHold=<一步>` 只给验收用(`scripts/probes/stage-gate-probe.mjs`):记下这一步之后停住不往下走,探针趁这时把页面进程杀掉,
     * 验「崩在这一步、重新载入停在下一级」,或给舞台降速后叫 `__pcGateRelease()` 放行。不带它与平时一样。
     */
    const hold = (() => { try { return new URLSearchParams(location.search).get("gateHold"); } catch { return null; } })();
    const mark = async (what: Parameters<typeof g.stage>[0]) => {
      if (!trying) return;
      g.stage(what);
      // 停住,直到探针叫 `window.__pcGateRelease()`(不叫就一直停着:杀页面进程的那几个场景)
      if (hold === what) await new Promise<void>((resolve) => { (window as unknown as Record<string, unknown>).__pcGateRelease = resolve; });
    };
    void (async () => {
      try {
        if (trying && hold === "open-visible") await new Promise<never>(() => {});
        await syncProject("front", getState().project);
        await mark("visible-ready");
        g.reached(1);
        if (tierState().target < 2 || !dualRef.current) { g.done(); return; }
        await mark("try-back");
        setBackStageMount(true);
        const back = await whenStageReady("back");
        if (!dualRef.current) return; // 握手失败退回了单舞台(下面那个 effect 收摊)
        await syncProject("back", getState().project);
        await mark("dual-loaded");
        g.reached(2);
        if (tierState().target < 3) { g.done(); return; }
        await mark("try-separate");
        const front = frontStage();
        const results = await Promise.all([front, back].map((c) => c?.setGlRoute("perDocument").catch(() => null) ?? Promise.resolve(null)));
        if (!dualRef.current) return;
        if (results.some((r) => !r)) { g.done(); return; } // 换不过去(舞台在换):这次停在第二级
        await mark("separate-ready");
        g.reached(3);
        // 共用的那一个 Worker 不再有人用:放掉(第三级每个舞台各一套)
        sharedGlRef.current?.dispose();
        sharedGlRef.current = null;
        g.done();
      } catch (e) {
        setGateDiag(String((e as Error)?.message ?? e).slice(0, 200));
        stageGate()?.done();
      } finally {
        setGateDriven(true);
      }
    })();
  }, [stageReady]);
  /* 握手容错:握不上手、握上又断而退回单舞台(只管当次,不留崩溃记录;语义「三道闸门」的握手容错照旧) */
  useEffect(() => {
    if (!ONLINE || onlineStages.handshake !== "failed") return;
    const g = stageGate();
    if (g && tierState().target !== 1) g.fallback(1);
  }, [onlineStages.handshake]);
  /* 查看口与探针:此刻各闸门的结果与崩溃记录(不含凭证;`?gates=1` 的面板读同一份) */
  useEffect(() => {
    if (!ONLINE) return;
    const w = window as unknown as Record<string, unknown>;
    w.__pcGates = () => ({ ...(stageGate()?.snapshot() ?? null), media: mediaGateSnapshot(), benchmark: benchmarkInfo, driverError: gateDiag || null });
    return () => { delete w.__pcGates; };
  }, [gateDiag, benchmarkInfo]);

  /*
   * 过渡期之后换回双舞台(只换一次):两个预热 iframe 已经接任 A / B(同一个元素,没重新加载),照它们预热时发来的
   * `pc-stage-ready` 补一遍握手(建 RPC、定角色、灌项目);同源单舞台留作盖板,直到新的可见舞台画好当前这一帧。
   */
  const handoverTimerRef = useRef<number | null>(null);
  /** 诊断:换回那一下从哪一刻开始、因为什么撤的盖板(`setTime` / `frame` / `cap`)、撤盖板时离开始多久 */
  const handoverInfoRef = useRef<{ startedAt: number | null; by: string | null; ms: number | null }>({ startedAt: null, by: null, ms: null });
  const endHandover = useCallback((by: string) => {
    const info = handoverInfoRef.current;
    if (info.by === null && info.startedAt !== null) handoverInfoRef.current = { ...info, by, ms: Math.round(performance.now() - info.startedAt) };
    setHandoverDone(true);
  }, []);
  const finishHandover = useCallback((delayMs: number, by: string) => {
    if (!handoverRef.current || handoverTimerRef.current !== null) return;
    handoverTimerRef.current = window.setTimeout(() => { handoverTimerRef.current = null; endHandover(by); }, delayMs);
  }, [endHandover]);
  useEffect(() => {
    if (!handover) return;
    for (const id of STAGE_IDS) {
      const win = (id === "A" ? frameARef : frameBRef).current?.contentWindow;
      const msg = win ? readyByWinRef.current.get(win) : undefined;
      if (win && msg && !rpcRef.current[id]) processReadyRef.current(id, win, msg.origin, msg.caps);
    }
    handoverInfoRef.current = { startedAt: performance.now(), by: null, ms: null };
    const cap = window.setTimeout(() => endHandover("cap"), STAGE_HANDOVER_MAX_MS);
    return () => window.clearTimeout(cap);
  }, [handover, endHandover]);

  /*
   * 握手之后又断(C10 契约第 2 节「握手之后又断」〔裁〕):已握手的舞台心跳断了(卡死、跨源 iframe 的渲染进程崩了),
   * 先照原来的做法整页重载那一台;重载后 20 秒内没握回来(或反复断),走首次握不上手的同一条路退回同源单舞台,
   * 退回之后看守作废、不再重载(`markStageHandshake("failed")` 之后 `dual` 变假,本 effect 收摊)。
   */
  useEffect(() => {
    if (!ONLINE || !dual) return;
    const frames: Record<StageId, React.RefObject<HTMLIFrameElement | null>> = { A: frameARef, B: frameBRef };
    const watch = createStageWatch({
      ids: STAGE_IDS,
      ping: (id) => rpcRef.current[id]?.size() ?? null,
      reload: (id, reason) => {
        const frame = frames[id].current;
        const client = rpcRef.current[id];
        if (client) {
          releaseStageClient(client);
          client.dispose();
          rpcRef.current[id] = null;
          hostCapsRef.current[id] = null;
        }
        console.warn(`[preview] 舞台 ${id} 断开(${reason}),整页重载它`);
        if (frame) frame.src = frame.src;
      },
      fallback: (reason) => {
        console.warn(`[preview] ${reason},退回同源单舞台`);
        markStageHandshake("failed", reason);
      },
      hidden: () => typeof document !== "undefined" && document.hidden,
    });
    stageWatchRef.current = watch;
    // 这一轮已经握过手的舞台(effect 晚于握手跑到时)照样看守
    for (const id of STAGE_IDS) if (rpcRef.current[id]) watch.ready(id);
    const w = window as unknown as { __pcStageWatch?: () => unknown };
    w.__pcStageWatch = () => ({ A: watch.status("A"), B: watch.status("B"), reloads: watch.reloads, fellBack: watch.fellBack, handshake: onlineStageState().handshake, reason: onlineStageState().reason });
    return () => {
      watch.dispose();
      if (stageWatchRef.current === watch) stageWatchRef.current = null;
      // 退回之后留着观察口(探针核「退回后不再重载」),只把看守换成已作废的那一份
      if (!watch.fellBack) delete w.__pcStageWatch;
    };
  }, [dual]);

  /*
   * 卡片代码换了一般不重载舞台(C6.6 集成 3b)。以前改一张卡,热更新冒到本组件,Fast Refresh 重跑上面那个握手 effect,
   * 清掉了舞台的 RPC 客户端,舞台停在旧画面,只好每次都整页重载两个 iframe(`b25f482`)。现在热更新在 `cards/index.ts`
   * 接住、不冒到这里;舞台自己也收到同一份热更新,在舞台里重装卡片、重渲,然后发 `pc-stage-cards` 报到。
   * 只有过了时限还没报到的舞台(代码确实过期)才在这里整页重载那一个(`stageCards.ts` 的 `whenStagesHaveCards`)。
   */
  useEffect(() => {
    const ids: StageId[] = dual ? [...STAGE_IDS] : ["A"];
    return bindStageCards(ids, (id) => {
      const frame = (id === "A" ? frameARef : frameBRef).current;
      if (!frame) return;
      const client = rpcRef.current[id];
      if (client) {
        releaseStageClient(client);
        client.dispose();
        rpcRef.current[id] = null;
        hostCapsRef.current[id] = null;
      }
      console.warn(`[preview] 舞台 ${id} 没换上新的卡片代码,整页重载它`);
      frame.src = frame.src;
    });
  }, [dual]);

  /*
   * 项目选项切了 `glRoute`(R9 约束第 1 条):切到 `shared` 时给已经握过手的舞台补交端口;
   * 切回 `perDocument` 什么都不用发 —— 舞台收到新项目自己按生效路线重建 `glHost` 那一侧的连接。
   * 重走 `ProbeGate` 遮罩(`device` 变了)不在这里,见 R9 报告。
   */
  const glRoute = project.glRoute;
  const glRouteSeen = useRef(glRoute);
  useEffect(() => {
    if (glRouteSeen.current === glRoute) return;
    glRouteSeen.current = glRoute;
    const frames: Record<StageId, React.RefObject<HTMLIFrameElement | null>> = { A: frameARef, B: frameBRef };
    for (const id of STAGE_IDS) {
      const win = frames[id].current?.contentWindow;
      if (win && rpcRef.current[id]) glPortTo(id, win, hostCapsRef.current[id]);
    }
  }, [glRoute, glPortTo]);

  /**
   * 素材和音频按墙钟播:**一拍的名义时长之外再慢这么多**就暂停它们
   * (K4 / pinned 架构 10;`mediaSync.ts` 的 `IN_SYNC_SEC` 同值)。
   * 下一拍准时到达时再放回去 —— 这就是用户能感到的「小卡」。
   *
   * 阈值按 pinned 固定 40 毫秒、不按帧算;**量的是「停顿」而不是两条 `frame` 之间的
   * 总间隔** —— 一拍本来就要 `1000/fps` 毫秒,把它算进卡顿是把正常节拍当成了停顿。
   * 24 / 25 fps 尤其明显:60 Hz 屏上一拍 41.7 / 40 ms 排不进 16.7 ms 的格子,
   * 实际到达是 33 / 50 交替(`StageView.tsx` 的节拍循环自己也这么说),
   * 按总间隔判的话每隔一拍就误判一次卡顿、音频每 ~80 ms 暂停恢复一次。
   * 按「超出名义拍长多少」判:24 fps 的 50 ms 拍只超出 8.3 ms,60 fps 掉一次 vsync
   * 也只超出 16.7 ms,都进不了 40 ms;而真的卡一下(比如 300 ms)照样当场判出来。
   */
  const MEDIA_STALL_MS = 40;
  /** E6:播放中 `refreshRects` 改成定时器,别每拍都往返一次 */
  const RECTS_POLL_MS = 500;

  /**
   * 播放中素材层 / 音频是不是被掐住了(K4 的 `mediaStalled`)。
   *
   * **通道写死**:`MediaLayers` 的 `playing` prop 改成 `playing && !mediaStalled`,舞台侧经
   * `setPlaying(false)` 同步。直接对元素 `pause()` 没用 —— `planSync` 在播放态的每个分支
   * 都返回 `play: paused`,下一拍就被 `play()` 回来了。
   */
  const [mediaStalled, setMediaStalled] = useState(false);
  const stalledRef = useRef(false);
  /** 上一条 `frame` 的**真实**到达时刻(首拍以 `play()` 回包时刻为起点) */
  const lastFrameAtRef = useRef(0);
  /** 验收口:这一轮播放判过几次卡顿、最大的一次超出名义拍长多少毫秒 */
  const stallCountRef = useRef(0);
  const gapMaxRef = useRef(0);
  /*
   * 「音频跟随时刻」(`mechanism/rendering.md`)要音频跟着舞台的拍子走,原来有两处漏着,声音会先跑出去:
   *
   * 1. **起播到第一拍之间**:`playing` 一翻,主文档的音频立刻起播,而播放头要等舞台收到项目、回了 `play`、
   *    渲完第一拍才动。舞台起步慢(刚打开项目、重卡)时声音先放出去几百毫秒,偏差过了硬 seek 的门槛又被拉回来重放一遍。
   *    `firstBeatRef`:这一轮播放的第一拍到了才放开音频。只管主文档的音频,不动舞台里的素材层。
   * 2. **卡顿是到货时才判的**:晚到的那一拍到了才知道它晚了,卡住的那几百毫秒里音频照放。
   *    看门狗:上一拍(或 `play` 回包)之后过了「名义拍长 + 40 ms」还没有下一拍,当场按卡顿掐住;
   *    判据与到货时那一条相同(超出名义拍长 40 ms),只是不等它到。
   */
  const firstBeatRef = useRef(false);
  const [, setFirstBeatSeen] = useState(0);
  if (!playing) firstBeatRef.current = false;
  const stallWatchRef = useRef(0);
  const armStallWatch = useCallback(() => {
    window.clearTimeout(stallWatchRef.current);
    if (!playingRef.current) return;
    const beat = 1000 / Math.max(1, getState().project.fps || 30);
    stallWatchRef.current = window.setTimeout(() => {
      if (!playingRef.current || stalledRef.current || !lastFrameAtRef.current) return;
      stallCountRef.current++;
      stalledRef.current = true;
      setMediaStalled(true);
      void frontStage()?.setPlaying(false).catch(() => {});
    }, beat + MEDIA_STALL_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(stallWatchRef.current), []);

  /*
   * 流平面 / 抑制 / 快照的投递(C4、C5、A3c;排程在 `snapshotFeed.ts`)。
   *
   * 叫它的地方:每拍收到 `frame` 之后(播放中)、`setTime` 发完之后(暂停 / 拖动)、起播之前、舞台报 `settled` 之后,
   * 项目改了之后,以及快照字节 / 新的就绪层到货之后。33 ms 的节流在 `deliverSnapshots` 里,所以可以放心地多叫几次。
   */
  const dualRef = useRef(dual);
  dualRef.current = dual;
  const liveRef = useRef(live);
  liveRef.current = live;
  /** 上一次发出去的抑制集合(拼成一条字符串比,省掉没变也发) */
  const suppressedRef = useRef("");
  /** 上一次发出去的流平面(R8;同样拼成字符串比) */
  const streamPlanesRef = useRef("[]");
  /** 上一次的流平面发给了哪一台舞台(在线页面:换了一台就得重发,新的那台手里没有清单和字节) */
  const streamPlanesStageRef = useRef<StageRpcClient | null>(null);
  /**
   * 流平面与抑制集合各发一次(没变不发),**先发流平面、再发抑制**:重卡贴的是轨道流,播放、暂停、拖动都一样
   * (mechanism/rendering.md「重管线:预渲染」)。舞台收到抑制时,这张卡的流还没画出第一帧就先不藏它原来的画面
   * (`StageView` 的 `streamWaiting`),所以流平面要先到 —— 反过来的话那一层先空一下。
   *
   *   - 播放中:全部重卡抑制,这一帧有流的发流平面。
   *   - 暂停 / 拖动:这一帧有流、还没追到精确活渲的重卡抑制、贴流;已经追上的不抑制,流平面照发,
   *     舞台拿它把播放头下这一帧先解好(起播头一拍就有)。没有流的重卡进 scrub 待占位符（可活渲的纯 remotion 卡直接活渲）。
   *   - **只有一个舞台时例外**(没有后台舞台可以追到精确再互换):暂停、拖动时重卡一律抑制 ——
   *     子树藏着、不活渲,贴轨道流(最低一档贴每个分段的第一帧那一张,`snapshotFeed` 给流平面带 `first`),
   *     没有流就由舞台显示占位符;停下后舞台逐层追一帧精确活渲(`settleLayersAt`),画好的层不再按抑制藏。
   */
  const syncPlanes = useCallback((s: StageRpcClient, head: { project: ReturnType<typeof getState>["project"]; t: number; playing: boolean; single: boolean; sparseOnly: boolean }) => {
    const planes = streamPlanesAt(head);
    /*
     * 在线页面:流的清单与字节随流平面发给舞台(见握手那里的 `StreamPlaneSender`)。有流平面时把在线来源的 `streamRev` 也算进比较键 ——
     * 同一段换了文件(稀疏段换成满密度)时就绪区间一个字不变,光比区间不会重发;可见舞台换了一台同样要重发。
     */
    const pushed = ONLINE && planes.length > 0;
    const planesKey = JSON.stringify(planes) + (pushed ? `#${activeOnlineSource()?.streamRev ?? 0}` : "");
    if (planesKey !== streamPlanesRef.current || (pushed && streamPlanesStageRef.current !== s)) {
      streamPlanesRef.current = planesKey;
      streamPlanesStageRef.current = s;
      void s.setStreamPlanes(planes).catch(() => {});
    }
    const want = (!head.playing && head.single ? suppressedAt({ ...head, playing: true }) : suppressedAt(head)).join("|");
    if (want !== suppressedRef.current) {
      suppressedRef.current = want;
      void s.setSuppressed(want ? want.split("|") : []).catch(() => {});
    }
  }, []);
  /** `at`:不按 store 此刻的播放头,按给定的时刻与播放状态投一次(起播之前:按起播的那一秒、当作在播) */
  const pumpFeed = useCallback(async (at?: { t: number; playing: boolean }) => {
    // 界限搜索正占着唯一那个舞台测量:不投快照、不发抑制(测完由 restore 重投)
    if (!liveRef.current || costSearchMeasuring()) return;
    const s = frontStage();
    if (!s) return;
    const head = { project: getState().project, t: at?.t ?? tRef.current, playing: at?.playing ?? playingRef.current, single: singleRef.current, sparseOnly: singleRef.current };
    if (head.playing) clearSettled("front", "playing");
    /*
     * 暂停态第二路(后台整场景补跑后互换)正在跑:这一次不动抑制和流平面。互换那一步新的可见舞台已经是精确活渲,
     * 而「整台都精确」(`markAllSettled`)要晚几个回包才记上 —— 这中间按「还没精确」重发的话,会把流平面盖回新的可见舞台上。
     * 用户这时又拖了的话,`sendSetTime` 那一处照发(不经这里)。
     */
    const holdForSwap = !head.playing && !head.single && swapInFlight();
    if (!holdForSwap) syncPlanes(s, head);
  }, [syncPlanes]);
  const pumpRef = useRef(pumpFeed);
  pumpRef.current = pumpFeed;

  /*
   * C3 的就绪索引:页面直连预渲染进程的那条 SSE(`snapshotSource.ts`)。
   *
   * **编辑不重连、不清表**(根因 E):项目每变一次这里只核一下 session(镜像可能刚起来、或换了项目),
   * 同一个 session 什么都不做。以前清理函数挂在带 `project` 的 effect 上 —— 每次编辑先
   * `stopSnapshotFeed()` 把就绪索引、字节缓存、投递基线全清掉再重连,重连空档里播放中的重卡全透明。
   * 拆成两个:核 session 的跟着 `project` 跑,收摊的只在 `dual` 变了 / 卸载时跑。
   */
  // 在线页面没有预渲染进程(没有 SSE 就绪索引):双舞台时快照来源照旧是下面的在线实现
  useEffect(() => {
    if (!dual || ONLINE) return;
    syncSnapshotSubscription(() => { void pumpRef.current(); });
  }, [dual, project]);
  useEffect(() => {
    if (!dual || ONLINE) return;
    return () => stopSnapshotFeed();
  }, [dual]);

  /*
   * c10a 第 9 节「在线页面拉取」:在线页面没有预渲染进程,重层的画面是渲染节点推到素材服务的预渲染结果(轨道流)。
   * 快照来源换成在线实现(`snapshotSource.ts` 的 `OnlineSnapshotSource`:按内容库的层表与清单、凭只读票据取 `px/<hash>`),
   * 它发的 C3 消息直接并进 `snapshotFeed` 的就绪索引 —— 选帧、兜底、投递那一整条消费路一行不改。
   * 小位图到货后自己重投一次(`snapshotFeed` 的到货回调只在 SSE 那条路上挂)。
   */
  const onlineSourceRef = useRef<OnlineSnapshotSource | null>(null);
  /** 本页的清单计划发布器(本页产流要问它「这一版计划发出去了没有、有没有节点接」;任务书「甲二」) */
  const planPublisherRef = useRef<PlanPublisher | null>(null);
  useEffect(() => {
    if (!online) return;
    /*
     * C10 契约第 4、5 节:取预渲染原尺寸(`snap/<hash>`,按层表 v 2 与清单)进页面内快照库 L2;只有一个舞台(精简模式、最低一档)
     * 按 `small` 开(轨道流只贴稀疏版、流字节在内存里留得少,`snapshotSource.ts` 文件头第 7 条;`mechanism/platforms.md`「三道闸门」)。
     */
    const src = new OnlineSnapshotSource({
      request: docRequest, assetBase: remoteAssetBase, authHeaders: assetAuthHeaders,
      /*
       * 用户卡、素材效果卡的层与内置卡一样取清单与字节(C10 契约第 9 节,2026-09-29 起不再豁免);另外整段的清单都取,
       * 时间轴据此判「预渲染结果覆盖整段没有」(徽标)。
       */
      coverageLayer: (clipId) => localOnlyOf(getState().project).has(clipId),
    }, { tier: singleRef.current ? "small" : "original", store: pageL2() });
    onlineSourceRef.current = src;
    setActiveOnlineSource(src);
    setCoverageSource(src);
    setSnapshotSource(src);
    // 投递时缺的那一帧取到之后也要重投一次(暂停着的页面没有别的事件会再投)
    setSnapshotArrive(() => { void pumpRef.current(); });
    src.onFetched = () => { void pumpRef.current(); };
    const off = src.subscribeReady("online", 0, (m) => {
      applyReadyMessage(currentReadyIndex(), m);
      if (m.type !== "done") void pumpRef.current();
    });
    src.setProject(getState().project.id || null);
    src.setInputs(getState().project);
    src.focus(tRef.current, getState().project.fps || 30);
    const resume = () => {
      if (document.visibilityState === "visible") src.focus(tRef.current, getState().project.fps || 30);
    };
    document.addEventListener("visibilitychange", resume);
    if (typeof window !== "undefined") (window as unknown as Record<string, unknown>).__pcOnlineSnapshots = () => src.debug();
    return () => {
      off();
      document.removeEventListener("visibilitychange", resume);
      src.stop();
      onlineSourceRef.current = null;
      setActiveOnlineSource(null);
      setCoverageSource(null);
      stopSnapshotFeed();
    };
  }, [online, single]);
  /*
   * stale-layer:项目每变一次(本页改的、别的成员改了同步过来的)都把它交给在线来源。来源按它算各片段的输入签名,
   * 与层表里每层记的 `inputSig` 比对:对不上的旧参数层马上撤掉(就绪区间发空,下一次投递就不再贴,用户卡、素材效果卡显示沙漏,
   * 内置重卡照在线页面的兜底),渲染节点按新输入重写层表后新结果照常换上;改回原来的参数、原来那一层还在就照贴。
   * 放在建来源那个 effect 之后:同一次提交里先建好来源再交项目。
   */
  useEffect(() => {
    if (!online) return;
    onlineSourceRef.current?.setInputs(project);
  }, [online, single, project]);
  /*
   * C10 契约第 9 节「识别」:在线页面经同一条文档服务连接读本项目内容库的卡片源码(`card-source`,键前缀 `src/cards/user/`),
   * 解析出卡片的 id 与名字,进注册表作「已知但本机不能运行」的条目(`sync/onlineCardSources.ts`)。定时重取;连接换了
   * (重连、换项目)清表重取。表变了发给两个舞台(舞台是另一份文档,有它自己的注册表)。
   */
  useEffect(() => {
    if (!online) return;
    /*
     * 测量等卡片源码第一次同步完再开始(`measureGate.ts`):在那之前同步卡被当成未知 id,后台舞台可能把它测一次。
     * 第一次同步有了结果(成功或失败)就开门;最多等 `MEASURE_GATE_MAX_MS`。桌面不关这道门。
     */
    const linkKey = () => (hasDocLink() ? currentSharedLink() : null);
    // 门按连接算:换了项目 / 连接,问门时重新关上,等新连接的卡片源码同步完(`measureGate.ts`)
    setMeasureGateLink(linkKey);
    holdMeasureForCardSources();
    const sources = new OnlineCardSources({
      request: docRequest, linkKey,
      // 用户卡源码从内置模块引进来的控件、默认值:用页面自己带着的那份(`src/cards/builtinSourceExports.ts`)
      builtins: builtinSourceExports, sourceFiles: builtinCardSourceFiles,
      onFirstSettled: (ok, link) => releaseMeasureGate(ok, link),
      /*
       * 在线执行同步来的用户卡与素材效果卡(`docs/plan/online-card-exec-contract.md` 第 1、8 节):本页能执行时(`cardRuntime/gate.ts`,
       * 由舞台的隔离自检立起来)把源码转译成包。转译器按需载入,不能执行的页面不取它。编辑页面只转译、不执行。
       */
      bundling: {
        enabled: cardExecAvailable,
        // 编译期判:桌面构建里这一行整个剪掉,转译器那一块不进桌面的产物
        run: (job) => (import.meta.env.VITE_PC_ONLINE === "1" ? import("../online/cardRuntime/transpile.browser").then((m) => m.bundleCards(job)) : Promise.resolve([])),
        onBundles: (results) => { bundles = results; cardBundlesRef.current = results; refreshRunStates(); pushCardBundlesRef.current(); },
      },
    });
    let bundles: BundleResult[] = [];
    /*
     * 每张同步卡在本页的运行状态(参数面板、徽标、轻重判定读 `registry.cardRunState`):页面自己知道的(没有隔离环境、转译不成)
     * 合上挂着的舞台报回来的(载入成功、载入出错、图形能力不够、素材解不了、运行出错)。挂着的都报了能运行才算能运行(双舞台两台、单舞台一台)。
     */
    const refreshRunStates = () => {
      setCardRunStates(editorRunStates({
        cards: syncedUserCards().values(), available: cardVisualExecAvailable(), blockedDetail: cardExecBlockedDetail(), bundles,
        stages: mountedStageIds().map((id) => stageCardStatesRef.current[id]), stageCount: Math.max(1, mountedStageIds().length),
      }));
    };
    refreshRunStatesRef.current = refreshRunStates;
    // 声音线程(双舞台的实例 B、单舞台的 A 起的专用后台线程)接成 `cardAudio.ts` 的隔离宿主;舞台报了声音状态才算接上
    const soundLink = createIsolatedSoundLink({
      render: (request) => {
        const c = rpcRef.current[soundStageId()];
        return c ? c.synthCardAudio(request) : Promise.reject(new Error("起声音线程的那一台舞台不在"));
      },
    });
    soundLinkRef.current = soundLink;
    const offGate = subscribeCardExecGate(() => {
      // 本页不能执行了(出了加固拦下的事、站点关了):舞台报过的状态与声音线程都作废
      if (!cardExecAvailable()) { stageCardStatesRef.current = {}; stageGraphRef.current = {}; setNodeGraphCapable(false); soundLink.setState(null); }
      refreshRunStates();
      pushCardBundlesRef.current();
      void sources.sync();
    });
    const offStates = onSyncedUserCardsChanged(refreshRunStates);
    const push = () => {
      const entries = [...syncedUserCards().values()];
      for (const id of STAGE_IDS) {
        const c = rpcRef.current[id];
        if (c) void c.setSyncedUserCards(entries).catch(() => { /* iframe 正在换:下一次握手会重发 */ });
      }
    };
    const offChange = onSyncedUserCardsChanged(push);
    const timer = window.setInterval(() => { void sources.sync(); }, CARD_SOURCE_POLL_MS);
    void sources.sync();
    const w = window as unknown as Record<string, unknown>;
    w.__pcCardSources = () => sources.debug();
    w.__pcCardSourcesSync = () => sources.sync();
    w.__pcCardExecDiag = () => ({
      available: cardExecAvailable(), visual: cardVisualExecAvailable(),
      run: Object.fromEntries([...syncedUserCards().values()].map((c) => [c.id, cardRunState(c.id) ?? null])),
      bundles: bundles.map((b) => ({ entry: b.entry, ok: b.ok, state: b.ok ? null : b.state.state })),
      stages: Object.fromEntries(STAGE_IDS.map((id) => [id, { graph: stageGraphRef.current[id] ?? null, states: [...(stageCardStatesRef.current[id] ?? [])] }])),
    });
    return () => {
      window.clearInterval(timer); offChange(); offGate(); offStates(); sources.stop(); setCardRunStates([]);
      refreshRunStatesRef.current = () => {}; soundLinkRef.current = null; soundLink.dispose(); cardBundlesRef.current = []; stageCardStatesRef.current = {}; stageGraphRef.current = {};
      setNodeGraphCapable(false);
      delete w.__pcCardSources; delete w.__pcCardSourcesSync; delete w.__pcCardExecDiag;
    };
  }, [online]);
  /*
   * 预览缩放倍数变了,发给两个舞台(占位符据此补偿:沙漏在屏幕上保持原大小)。
   * 握手时另发一次(见 `pc-stage-ready` 那段)。桌面与在线都发。
   */
  useEffect(() => {
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (c) void c.setViewScale(scale).catch(() => { /* iframe 正在换:下一次握手会重发 */ });
    }
  }, [scale]);
  useEffect(() => {
    if (!onlineBrowserMode()) return;
    const refresh = () => {
      // planDispatch 在同一批通知里用 queueMicrotask 重算 currentPlan;排在它后面重投一次流平面与抑制集合,
      // 让刚变成 ready 的同步用户卡当场解除抑制(不必等用户点播放或拖时间轴)
      queueMicrotask(() => { void pumpRef.current(); });
    };
    const offSynced = onSyncedUserCardsChanged(refresh);
    const offRun = onCardRunStatesChanged(refresh);
    return () => { offSynced(); offRun(); };
  }, [online]);
  /*
   * C10 契约第 7 节:队列报 task.done(本页发布的清单计划或它切出的细任务做完了):马上重取层表与清单,新快照下一拍换上。
   * M7 D12:task.done 的结果键认定活着、task.failed { error: 'superseded' } 是另一份活着(不是失败),在线来源据此选层表 v 3 的候选。
   */
  useEffect(() => {
    if (!online) return;
    return subscribeQueueEvents((m) => {
      if (m.type !== "task.done" && m.type !== "task.failed") return;
      onlineSourceRef.current?.noteQueueEvent(m);
      if (m.type === "task.done") onlineSourceRef.current?.refresh();
    });
  }, [online]);
  /*
   * M7(契约第 2 节):身份为电脑的在线页面,后台舞台在闲时兼做纯浏览器渲染节点。当不当节点由宿主每拍按条件判
   * (在线构建且嵌了代码版本、身份为电脑、不是最低一档、两个跨源舞台都握上手、Chromium、以成员身份连着云端项目、测量落定)。
   * 身份为手机、只有一个舞台的页面不当节点,只为本页产稀疏版(`browserNodeHost.ts` 的 `ownSparseOnly`)。
   */
  useEffect(() => {
    if (!online) return;
    return startBrowserNodeHost({
      eligibility: () => ({
        online: ONLINE,
        codeVersion: CODE_VERSION,
        phone: phoneIdentity(),
        lowest: lowestRef.current,
        // 按两个舞台开、还没都握上手(舞台闸门正在试后台舞台)是 `pending`:不当节点,也不按只有一个舞台算(不然本页产流会当成只产稀疏版、不等计划)
        stageLayout: !dualRef.current ? "single" : onlineStageState().handshake === "ok" ? "dual" : "pending",
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
        member: !!currentSharedLink() && hasDocLink(),
        measured: measurementSettled(),
      }),
      projectId: () => (currentSharedLink() ? currentDocProjectId() || null : null),
      onAlive: (resultKey) => onlineSourceRef.current?.markAlive(resultKey),
      // 本页产流(任务书「甲二」):线上没有能切分的节点接本页的清单计划时,本页自己产单卡流(判据在 `online/pageStreams.ts`)
      pagePlan: () => planPublisherRef.current?.current() ?? null,
      planState: () => planPublisherRef.current?.probe() ?? Promise.resolve(null),
      // 这条流有了(本页产的、先查查到的):不等下一轮轮询,马上重取层表与清单
      onPageStream: () => onlineSourceRef.current?.refresh(),
      // 测量时就产稀疏版:此刻判重的片段(与清单计划的清单同一个算法)、此刻的已确认版本
      heavyClips: () => (singleRef.current ? [...(judgedPlan()?.prerenderSet ?? [])].sort() : heavyCardClips()),
      confirmed: () => {
        const ds = currentSharedLink()?.ds;
        return ds?.confirmedProject && typeof ds.rev === "number" ? { rev: ds.rev, project: ds.confirmedProject } : null;
      },
      restore: () => {
        suppressedRef.current = "";
        streamPlanesRef.current = "[]";
        markBaselineReset("front");
        setStageReady((n) => n + 1);
      },
    });
  }, [online]);
  /*
   * C10 契约第 7 节、第 18 节第 9 条:在线页面自己发布清单计划(各档都发,一律普通优先级;原来「为弱设备预渲染任务」的
   * `backfill` 优先级 2026-10-07 撤销)—— 测量落定后发、防抖、项目每次改动(文档服务确认的版本变了)
   * 或清单变了就重发;清单是页面自己判重的片段(预渲染集合)。这台设备跑不了的用户卡、素材效果卡一律判重(`costIdentity.ts`),
   * 照样进清单,由桌面版等渲染节点认领(C10 契约第 9 节,2026-09-29 起不再去掉)。没人认领不报错。
   */
  useEffect(() => {
    if (!online) return;
    const clips = heavyCardClips;
    // 托管方渲染节点的「生成轨道流」(任务书「甲三」):本页看到它开着时清单计划带这一项(是另一个计划);从关变开时马上重发,
    // 渲染节点据此再切一次、出它自己的那一份流任务,不用等项目下一次改动
    const streamsOn = () => { const v = getSyncView(); return hostedStreamsOn(v.shared?.where, v.hosted); };
    let lastStreams = streamsOn();
    const publisher = createPlanPublisher({
      request: docRequest, publisherId: `page-${pageSession()}`, clips, codeVersion: CODE_VERSION, streams: streamsOn,
      // M7:本页当纯浏览器节点时,这一版的清单计划等节点报到完(拿到指纹)再发,最多 3 s(契约第 3.3 节)
      nodeReady: browserNodeReady,
      // M7 D6:发之前把这一版的已确认项目按版本号留在内存,执行细任务时用任务的 projectRev 那一版
      onPublish: () => {
        const ds = currentSharedLink()?.ds;
        if (ds) keepConfirmedProject(ds.rev, ds.confirmedProject);
      },
    });
    planPublisherRef.current = publisher;
    const offNodeReady = subscribeBrowserNodeReady(() => publisher.nodeChanged());
    let link: unknown = null;
    let lastKey = "";
    const version = () => ({ projectId: currentDocProjectId() || null, projectRev: currentSharedLink()?.ds.rev ?? null });
    const check = () => {
      const shared = currentSharedLink();
      if (shared !== link) { link = shared; publisher.reset(); }
      if (!shared || !measurementSettled()) return;
      const v = version();
      const key = `${v.projectId}@${v.projectRev}|${clips().sort().join(",")}`;
      const streamsNow = streamsOn();
      const turnedOn = streamsNow && !lastStreams;
      lastStreams = streamsNow;
      if (key === lastKey) { if (turnedOn) publisher.streamsOn(); return; }
      const first = !lastKey;
      lastKey = key;
      if (first) publisher.measured(v);
      else publisher.changed(v);
    };
    const offProbe = onProbeProgress(() => check());
    const timer = window.setInterval(check, 1000);
    check();
    const w = window as unknown as Record<string, unknown>;
    w.__pcPlanPublisher = () => publisher.debug();
    return () => { offProbe(); offNodeReady(); window.clearInterval(timer); publisher.dispose(); if (planPublisherRef.current === publisher) planPublisherRef.current = null; delete w.__pcPlanPublisher; };
  }, [online]);
  useEffect(() => { onlineSourceRef.current?.setProject(project.id || null); }, [project.id]);

  /*
   * 两个舞台时的轻重判定(即时渲染闸门;语义 `product/platforms.md`「轻重判定」:项目里已经有别的机器测好的耗时时,按它排序、用二分法只测几张来划线):
   * 打开项目时常驻探针先等着(`holdProbe`)。基准卡测完、卡片源码同步完、连上共享项目后读本项目的成本记录:
   * - 一条都对不上项目里的卡:常驻探针照旧在遮罩下逐张实测(`releaseProbe({ blocking: true })`);
   * - 有记录:界限搜索在后台舞台里只测几张(遮罩下,`borrow: false`,排进后台舞台的单飞队列),划好线就按它判轻重;测过的卡里判重的,
   *   遮罩照旧挡着、紧接着给它产稀疏版(和常驻探针同一个口子 `runCardMeasuredHook`;`mechanism/rendering.md`「测量」),没测的(按记录划线
   *   判重的)归闲时产;常驻探针随后在后台把其余的卡补测完(不挡界面,K3/K5 要的记录由它补齐),补测完分派表改按成本记录判。
   * 读不到记录(没连上、被拒)隔一拍再试,40 拍之后照旧让常驻探针逐张测。
   */
  const dualSearchRef = useRef<"idle" | "deciding" | "searched" | "probe">("idle");
  useEffect(() => {
    if (!online || !dual || lowest) return;
    if (dualSearchRef.current !== "idle") return;
    dualSearchRef.current = "deciding";
    holdProbe();
    let disposed = false;
    let waited = 0;
    const release = (blocking: boolean, next: "searched" | "probe") => { dualSearchRef.current = next; releaseProbe({ blocking }); };
    const tick = async () => {
      if (disposed || dualSearchRef.current !== "deciding") return;
      if (++waited > 40 && waited < 1000) { waited = 1000; release(true, "probe"); return; }
      const t = tierState();
      if (t.gate !== "done" || t.benchmark === "pending" || !measureGateOpen()) return;
      if (t.lowest) { release(true, "probe"); return; }
      const shared = currentSharedLink();
      const projectId = currentDocProjectId();
      if (!shared || !hasDocLink() || !projectId || !((shared.ds?.rev ?? 0) > 0) || !backStage()) return;
      dualSearchRef.current = "searched"; // 这一拍在做,别的拍不进来
      const project = getState().project;
      const identity = clipIdentityOf(project);
      let listed: Awaited<ReturnType<typeof listSharedCosts>>;
      try { listed = await listSharedCosts({ request: docRequest, projectId, environment: pageEnvironment() }); }
      catch { dualSearchRef.current = "deciding"; return; }
      const keys = new Set(Object.values(identity.identityKeys));
      if (!listed.records.some((r) => keys.has(r.identityKey))) { release(true, "probe"); return; }
      const crashed = crashedCards();
      const unsupported = (clip: { id?: string; cardId?: string }) => needsLocalPc(clip.cardId, clip.cardId ? getCard(clip.cardId) : undefined)
        || (!!clip.id && crashed.has(identity.identityKeys[clip.id] ?? ""));
      setSearchCostStore(l2SearchCostStore());
      setDualSearch(true);
      try {
        const outcome = await runBackJob("measure", (ctx) => runCostSearch({
          request: docRequest, projectId, project, environment: pageEnvironment(), identityKeys: identity.identityKeys, capabilities: identity.capabilities, unsupported,
          stage: () => ctx.stage, borrow: false, pushProject: (p) => pushProject("back", p, { reset: true }), currentProject: () => getState().project, restore: () => {},
          store: searchCostStore, mode: import.meta.env.DEV ? "dev" : "build",
          beforeMeasure: searchMeasureHooks.before, afterMeasure: searchMeasureHooks.after,
          publish: (records) => publishSharedCosts({ request: docRequest, projectId, environment: pageEnvironment(), records }),
        }));
        if (disposed) return;
        const latest = getState().project;
        setPlanSearchLight(latest === project ? outcome.light : reclassify(outcome, latest, clipIdentityOf(latest).identityKeys, unsupported));
        // 测过的卡:判重的紧接着产稀疏版(遮罩照旧挡着;判不判重、产不产、等多久由接的一方定,和常驻探针那一轮同一套)
        const measured = [...outcome.result.measured.entries()].filter(([, v]) => !v.cached && !v.failed).map(([k]) => k);
        const sparse: string[] = [];
        try {
          for (const [i, key] of measured.entries()) {
            if (disposed || getState().project !== project) break;
            const clipIds = Object.keys(identity.identityKeys).filter((id) => identity.identityKeys[id] === key);
            const cardId = project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipIds[0])?.cardId ?? null;
            if (!clipIds.length || !cardId) continue;
            holdCostSearchMask(cardId, i, measured.length);
            sparse.push(cardId);
            await runCardMeasuredHook({ project, clipIds, cardId, identityKey: key, stale: () => disposed || getState().project !== project });
          }
        } finally {
          releaseCostSearchMask();
        }
        (window as unknown as Record<string, unknown>).__pcDualSearch = () => ({ keys: outcome.keys, light: [...outcome.light].sort(), measurements: outcome.result.measurements, records: outcome.records.length, boundary: outcome.result.boundary, sparseAfter: sparse });
        release(false, "searched");
      } catch {
        setDualSearch(false);
        release(true, "probe");
      }
    };
    const timer = window.setInterval(() => { void tick(); }, 1000);
    void tick();
    return () => { disposed = true; window.clearInterval(timer); if (dualSearchRef.current === "deciding") release(true, "probe"); };
  }, [online, dual, lowest]);
  /* 常驻探针在后台把其余的卡补测完了:分派表改按成本记录判(两个舞台的界限搜索只管打开的那一下) */
  useEffect(() => {
    if (!dualSearch) return;
    const check = () => { if (!probeProgress().running && probeSettledFor(getState().project)) setDualSearch(false); };
    const off = onProbeProgress(check);
    check();
    return off;
  }, [dualSearch]);

  /*
   * 只有一个舞台时的轻重判定(即时渲染闸门):共享成本记录加界限搜索(`costSearch.ts`;语义 `mechanism/rendering.md`「界限搜索与成本记录」)。
   * 连上共享项目、项目到了、舞台就绪后,每个共享项目搜一次(有记录的二分只测几张,没有记录的逐张实测);之后项目变了(加卡、改参数):
   * 没有记录的新卡补测那几张,其余按已有的界限判。取不到记录(没连上、被拒)隔一拍再试;真要测时 `CostSearchGate` 盖遮罩。
   * 最低一档不测:播放时不做任何即时渲染,判定的表全部按重(清单计划照显示用的表发全部片段)。
   */
  const stageReadyRef = useRef(stageReady);
  stageReadyRef.current = stageReady;
  const searchRef = useRef<{ projectId: string; outcome: CostSearchOutcome | null; running: boolean; waited: number } | null>(null);
  useEffect(() => {
    if (!online || !single) return;
    if (lowest) { setPlanSearchLight([]); return; }
    // 本地复用接 L2(要在第一次界限搜索之前接上,否则那一轮用页面内存)
    setSearchCostStore(l2SearchCostStore());
    let disposed = false;
    // 本页跑不了的卡(没载入成功的用户卡、素材效果卡)与测崩过的卡不测、一律判重(界限搜索的 `forcedHeavy`)
    const crashed = crashedCards();
    const unsupported = (clip: { id?: string; cardId?: string }) => needsLocalPc(clip.cardId, clip.cardId ? getCard(clip.cardId) : undefined)
      || (!!clip.id && crashed.has(clipIdentityOf(getState().project).identityKeys[clip.id] ?? ""));
    const stageDeps = {
      stage: frontStage,
      pushProject: (p: Project) => pushProject("front", p, { reset: true }),
      currentProject: () => getState().project,
      restore: () => {
        // 舞台回到可见舞台:整份项目已重灌;抑制、流平面、快照基线作废,stageReady +1 让时间与投递重来一遍
        suppressedRef.current = "";
        streamPlanesRef.current = "[]";
        markBaselineReset("front");
        setStageReady((n) => n + 1);
      },
      store: searchCostStore,
      mode: (import.meta.env.DEV ? "dev" : "build") as "dev" | "build",
      beforeMeasure: (key: string, cardId: string) => searchMeasureHooks.before(key, cardId),
      afterMeasure: (key: string) => searchMeasureHooks.after(key),
      publish: (records: SharedCostInput[]) => {
        const projectId = currentDocProjectId();
        if (!projectId || !hasDocLink() || !currentSharedLink()) return;
        return publishSharedCosts({ request: docRequest, projectId, environment: pageEnvironment(), records });
      },
    };
    const tick = async () => {
      if (disposed) return;
      // 测量等卡片源码第一次同步完(`measureGate.ts`):同步卡在那之前是未知 id,不能被当成普通卡去测
      if (!measureGateOpen()) return;
      // 先等基准卡测完(它也借这一个舞台;跑不动就进最低一档,这里不再测)
      if (tierState().benchmark === "pending") return;
      const shared = currentSharedLink();
      const projectId = currentDocProjectId();
      const s = frontStage();
      if (!shared || !hasDocLink() || !projectId || !s || !stageReadyRef.current || !((shared.ds?.rev ?? 0) > 0)) return;
      if (getState().playing) return;
      const project = getState().project;
      const cur = searchRef.current;
      if (cur && cur.projectId === projectId) {
        if (cur.running || !cur.outcome) return;
        const identity = clipIdentityOf(project);
        // 项目变了:没有记录又没测过的新卡补测(随项目变化更新相关测量),其余按已有的界限判
        cur.running = true;
        try {
          const next = await measureNewCards(cur.outcome, { ...stageDeps, project, identityKeys: identity.identityKeys, capabilities: identity.capabilities, unsupported });
          if (disposed) return;
          cur.outcome = next;
        } catch { /* 下一拍再来 */ } finally { cur.running = false; }
        const latest = getState().project;
        setPlanSearchLight(reclassify(cur.outcome, latest, clipIdentityOf(latest).identityKeys, unsupported));
        return;
      }
      const identity = clipIdentityOf(project);
      const cardClips = project.tracks.some((tr) => tr.clips.some((c) => !!c.cardId || !!c.nodeId));
      // 卡片身份还没算出来(卡片注册表还在装):多等几拍,10 拍之后照样开始(算不出身份的卡按重卡)
      const waitKey = `${projectId}#wait`;
      const waited = cur?.projectId === waitKey ? cur.waited : 0;
      if (cardClips && !Object.keys(identity.identityKeys).length && waited < 10) {
        searchRef.current = { projectId: waitKey, outcome: null, running: false, waited: waited + 1 };
        return;
      }
      searchRef.current = { projectId, outcome: null, running: true, waited };
      try {
        const outcome = await runCostSearch({
          ...stageDeps,
          request: docRequest,
          projectId,
          project,
          environment: pageEnvironment(),
          identityKeys: identity.identityKeys,
          capabilities: identity.capabilities,
          unsupported,
        });
        if (disposed) return;
        searchRef.current = { projectId, outcome, running: false, waited };
        // 搜索期间项目可能又变了:按最新的项目判一遍
        const latest = getState().project;
        setPlanSearchLight(latest === project ? outcome.light : reclassify(outcome, latest, clipIdentityOf(latest).identityKeys, unsupported));
        const ds = currentSharedLink()?.ds;
        if (ds?.confirmedProject && typeof ds.rev === "number") keepConfirmedProject(ds.rev, ds.confirmedProject);
      } catch {
        // 取不到记录:下一拍再试
        if (searchRef.current?.projectId === projectId) searchRef.current = null;
      }
    };
    const timer = window.setInterval(() => { void tick(); }, 1000);
    void tick();
    const w = window as unknown as Record<string, unknown>;
    w.__pcCostSearch = () => {
      const cur = searchRef.current;
      const o = cur?.outcome ?? null;
      return {
        projectId: cur?.projectId ?? null,
        running: cur?.running ?? false,
        state: costSearchState(),
        light: [...(planSearchLight() ?? [])].sort(),
        judgedHeavyClips: [...(judgedPlan()?.prerenderSet ?? [])].sort(),
        outcome: o && {
          keys: o.keys, forcedHeavy: o.forcedHeavy, records: o.records.length, envFingerprint: o.envFingerprint, elapsedMs: o.elapsedMs,
          measurements: o.result.measurements, searchMeasurements: o.result.searchMeasurements, boundary: o.result.boundary,
          threshold: o.result.threshold, order: o.result.order, trace: o.result.trace, budgetMs: o.result.budgetMs,
          heavy: [...o.result.heavy].sort(), light: [...o.light].sort(), unrecorded: o.result.unrecorded,
          measured: [...o.result.measured.entries()].map(([key, v]) => ({ key, ms: Number.isFinite(v.ms) ? v.ms : null, cached: v.cached, failed: v.failed })),
        },
      };
    };
    return () => {
      disposed = true;
      window.clearInterval(timer);
      delete w.__pcCostSearch;
      searchRef.current = null;
    };
  }, [online, single, lowest]);

  /*
   * 桌面版与在线浏览器连着共享项目时,把本机后台舞台测完的成本记录转写进文档服务(`sharedCosts.ts`;
   * 语义 `mechanism/document-service.md`「成本记录」:所有在线浏览器测完都写)。没连就不写、不报错;只转写这台浏览器测的、
   * 当前项目用到的卡。只有一个舞台时界限搜索测的由 `costSearch.ts` 测完直接写。
   */
  useEffect(() => {
    const relay = new SharedCostRelay({
      request: docRequest,
      linkKey: () => (hasDocLink() ? currentSharedLink() : null),
      projectId: () => (currentSharedLink() ? currentDocProjectId() || null : null),
      environment: pageEnvironment,
      costs: currentCosts,
      identityKeys: () => new Set(Object.values(clipIdentityOf(getState().project).identityKeys)),
    });
    const timer = window.setInterval(() => { void relay.sync().catch(() => 0); }, SHARED_COST_RELAY_MS);
    void relay.sync().catch(() => 0);
    const w = window as unknown as Record<string, unknown>;
    w.__pcSharedCosts = () => relay.debug();
    w.__pcSharedCostsSync = () => relay.sync();
    return () => { window.clearInterval(timer); delete w.__pcSharedCosts; delete w.__pcSharedCostsSync; };
  }, []);

  useEffect(() => { onlineSourceRef.current?.focus(t, project.fps || 30); }, [t, project.fps]);

  /* 换了 iframe:那一份投递基线跟着作废,下一次带 `reset`(A3c) */
  useEffect(() => {
    if (!live || !stageReady) return;
    markBaselineReset("front");
    suppressedRef.current = "";
    // 暂停着也发流平面了:换了一台舞台,这一份记录同样从零开始(新的那台手里没有)
    streamPlanesRef.current = "[]";
    /*
     * 在线页面:预渲染小尺寸常常在舞台握手之前就取到了(取到时 `frontStage()` 还是空,那一次投递落空)。
     * 暂停着的页面之后没有别的事件会再投,重卡就一直是占位 —— 舞台一握手就投一次(c10a-demo-probe 实测)。
     */
    if (onlineSourceRef.current) void pumpRef.current();
  }, [live, stageReady]);
  /*
   * 项目改了(store 换了新的项目对象):流平面和抑制按新项目重算一次。依赖下层的卡的流只对产它时的那一版下层有效 ——
   * 下层一改,那一层带的输入签名就对不上了(`snapshotFeed.ts` 的 `streamLayers`),旧流要当场撤下,不能等下一次 `setTime`:
   * 暂停着、手按着标尺不动时改下层,之后没有别的事件会来投。播放中下一拍自己会投,这里多投一次无妨;没变的不会重发
   * (`syncPlanes` 按内容比,快照那一半有 33 毫秒的节流)。
   */
  useEffect(() => {
    if (!live || !stageReady) return;
    void pumpRef.current();
  }, [live, stageReady, project]);

  /*
   * K5 (4) 的角色互换。**A / B 只是实例名**,谁是 `front` 由这个 state 说了算 ——
   * 起手 A,互换之后就换过来了。两件事必须在**一次 React 提交**里做完:
   * 对调两个 iframe 的可见性,和把「当前 front」指针切过去(`stageBridge` 的登记)。
   *
   * 后台那个只能用 `opacity: 0; pointer-events: none` 藏 —— `display: none` /
   * `visibility: hidden` 会让整份 OOPIF 退出渲染树,`requestVideoFrameCallback` 不再回调,
   * K5 (3) 的 `mediaReady` 就只能等到超时(见 K5 (4) 的说明)。
   */
  const [frontId, setFrontId] = useState<StageId>("A");
  const frontIdRef = useRef<StageId>("A");
  frontIdRef.current = frontId;
  const swapRoles = useCallback(() => {
    const cur = frontIdRef.current;
    const nextId: StageId = cur === "A" ? "B" : "A";
    const nextFront = rpcRef.current[nextId];
    if (!nextFront) return null;
    const nextBack = rpcRef.current[cur];
    frontIdRef.current = nextId;
    flushSync(() => setFrontId(nextId));
    /*
     * 基线跟着客户端走(根因 A):新 front 手里是补跑开始时灌的那一份,**不是**此刻的最新项目。
     * 以前这里 `markPushed(role, getState().project)`,补跑期间的编辑(删片段)就永远补不上;
     * 现在 `swapAndDress` 在互换之后补推一次 `syncProject`,按它真正持有的那份算增量。
     */
    swapStageClients({ client: nextFront, caps: hostCapsRef.current[nextId] }, { client: nextBack, caps: hostCapsRef.current[cur] });
    // 新 front 的抑制集合、流平面都从零开始记(暂停态互换时旧 front 挂着流平面,新 front 没有)
    suppressedRef.current = "";
    streamPlanesRef.current = "[]";
    return { front: nextFront, back: nextBack };
  }, []);
  /* 退回单舞台(握手失败)时,可见舞台回到 A(B 已经卸掉) */
  useEffect(() => {
    if (!dual && frontIdRef.current !== "A") { frontIdRef.current = "A"; setFrontId("A"); }
  }, [dual]);
  /*
   * C10 契约第 2 节「后台舞台的摆放与节拍」:在线双舞台的后台活由本页判空闲(页面可见、rAF 间隔不持续超过 500 ms、
   * 父页 rIC 在回调),经 RPC 发开始 / 停止。桌面运行环境不发(照旧)。
   */
  useEffect(() => {
    if (!dual || !ONLINE) return;
    return startBackWorkGate({ back: () => { const b = backStage(); return b && b !== frontStage() ? b : null; } });
  }, [dual]);
  useEffect(() => {
    if (!dual) return;
    setSwapHost({
      swapRoles,
      // 2D 预览**不加 proxy=1**(见下面 iframe 那段注释),所以互换后重发的也是 false
      proxy: () => false,
      // A1 的换档:舞台的 VideoTrack / 像素映射素材按它选档(T1a 审查 #5);来源见 LOCAL_HASHES
      localHashes: () => [...tierHashes()],
      // 只有一个舞台时暂停后不经后台舞台追活渲(双舞台下不会是单舞台,这里只是兜一道)
      singleStage: () => singleRef.current,
    });
    return () => setSwapHost(null);
  }, [dual, swapRoles]);

  /** 这一轮播放已经为哪几张卡发起过互换(别每拍都发一次) */
  const swapTriedRef = useRef(new Set<string>());

  /* 验收探针的观察口:父页这一侧的状态(哪个 iframe 是 front、素材掐住没有、降级到哪一步) */
  useEffect(() => {
    if (!live) return;
    const w = window as unknown as { __pcPreviewDiag?: () => unknown };
    w.__pcPreviewDiag = () => ({
      frontId: frontIdRef.current,
      mediaStalled: stalledRef.current,
      // K4 / pinned 架构 10:这一轮播放里判过几次卡顿(正常播放应当是 0)
      mediaStallCount: stallCountRef.current,
      mediaGapMaxMs: gapMaxRef.current,
      suppressed: suppressedRef.current ? suppressedRef.current.split("|") : [],
      // 上一次发给可见舞台的流平面(暂停 / 拖动时也有)
      streamPlanes: streamPlanesRef.current,
      pendingDemote: [...pendingDemotes()],
      demoted: [...demotedClips()],
      swapInFlight: swapInFlight(),
      swapLog: stageSwapDebug(),
      swapTrace: stageSwapTrace(),
      // 播放态互换的发起判断(整场景估时 / 追不上不发起)与停下时的让路次数
      swapPlaying: stageSwapPlayingDebug(),
      setTimeLog: setTimeLogRef.current.slice(),
      setTimeError: setTimeErrorRef.current,
      // 这一次的档位(`onlineTier.ts`)与单舞台停下追一帧的上一次结果
      tier: ONLINE ? { ...tierState() } : null,
      single: singleRef.current,
      lowest: lowestRef.current,
      lastSettle: settleResultRef.current,
      // C10:在线双舞台、按拍换快照、后台活开关、探针帧的可转移字节
      dual: dualRef.current,
      onlineStages: onlineStageState(),
      // 在线执行用户卡与素材效果卡:本页此刻能不能执行、为什么不能、路径号(按账号加项目固定,对其它项目的舞台保密;票据不在这里)
      cardExec: ONLINE ? { ...onlineCardExec(), sid: pageStageIsolation().sid } : null,
      // 首次握手过渡期之后换回双舞台那一下(盖板因为什么、多久撤下)
      handover: { ...handoverInfoRef.current },
      beatSwap: beatSwapDebug(),
      backWork: backWorkDiag(),
      probeFrames: probeFrameDiag(),
      // 常驻探针测过哪些片段、测量门什么时候开的(online-user-cards-probe 核对同步卡从没被测过)
      probeRun: probeRunDiag(),
      measureGate: measureGateDiag(),
      hostCaps: { ...hostCapsRef.current },
      snapshotFeed: snapshotFeedDebug({ project: getState().project, t: tRef.current, playing: playingRef.current, single: singleRef.current, sparseOnly: singleRef.current }),
    });
    return () => { delete w.__pcPreviewDiag; };
  }, [live]);

  /*
   * 舞台事件的分发(E0 的七种;来源过滤在 stageBridge 里按角色做完了)。
   *
   * 监听只登记一次,所以里面读的一律是 ref / store,不读闭包里的 state。
   */
  useEffect(() => onStageEvent((e) => {
    switch (e.type) {
      case "frame": {
        // K4:可见舞台每渲完一拍报一次 t,播放头跟它走(那时 Preview 的 rAF 循环不启动)
        if (handoverRef.current) finishHandover(STAGE_HANDOVER_SETTLE_MS, "frame");
        const now = performance.now();
        const prev = lastFrameAtRef.current;
        lastFrameAtRef.current = now;
        armStallWatch();
        if (!firstBeatRef.current && playingRef.current) { firstBeatRef.current = true; setFirstBeatSeen((n) => n + 1); }
        actions.tick(e.sec);
        // 这一拍的抑制集合和快照(C5:播放中发 setSuppressed(H(t)) + setSnapshots)
        void pumpRef.current();
        /*
         * K3(b) 的 `vtOk = false` 轻卡:播放头刚进入它时整场景在后台补跑后互换。
         * 每张卡这一轮播放只发起一次 —— 补跑一次要几百毫秒,每拍发一次只会互相掐。
         * 只给从它中间开始播放的卡:这一轮播放中逐拍走过挂载帧、自然进场的不发起(`playingSwapTargets`)。
         * 拍序号先记下(连续、重复还是断开),再算目标。
         */
        notePlayFrame(e.sec);
        // 只有双舞台才有后台舞台可换;在线页面的单舞台不走;最低一档播放时不活渲,也不走
        if (dualRef.current && !lowestRef.current && !swapInFlight()) {
          const targets = playingSwapTargets(getState().project, e.sec).filter((id) => !swapTriedRef.current.has(id));
          if (targets.length) {
            for (const id of targets) swapTriedRef.current.add(id);
            void runPlayingSwap(targets);
          }
        }
        if (!prev) break;
        // 一拍的名义时长之外还慢了多少(见 MEDIA_STALL_MS 上面那段)
        const overBeat = now - prev - 1000 / Math.max(1, getState().project.fps || 30);
        if (overBeat > gapMaxRef.current) gapMaxRef.current = overBeat;
        const stalled = overBeat > MEDIA_STALL_MS;
        if (stalled === stalledRef.current) break;
        if (stalled) stallCountRef.current++;
        stalledRef.current = stalled;
        setMediaStalled(stalled);
        // 舞台侧的素材层同步掐住 / 放回;主文档的音频由 MediaLayers 的 playing prop 管
        void frontStage()?.setPlaying(!stalled && playingRef.current).catch(() => {});
        break;
      }
      case "ended":
        /*
         * K4 播放到头:写 store(`pause()` + `seek(duration)`)。剩下三步
         * (`setPlaying(false)`、`pause()` 拿 `stoppedAt`、`setTime(stoppedAt, { settle: true })`)
         * 和按暂停**是同一段收尾** —— `playing` 翻成 false 之后由下面那个 effect 统一做,
         * 少了最后一步的话最后一帧的重卡永远停在抑制态(pinned 架构 9)。
         */
        actions.pause();
        actions.seek(e.sec);
        break;
      case "settled": {
        /*
         * 舞台追上之后自己把这几张卡的抑制撤了(和露出活组件同一次提交,`StageView` 的 `releaseSettled`):
         * 父页记的「上次发的抑制集合」不再可信,下一次照现状重发。互换转正的那一条(`clipIds` 为空)不走:
         * 那边由 `swapRoles` 清记录、`markAllSettled` 记整台精确。
         */
        const named = e.clipIds.length > 0;
        if (named) suppressedRef.current = "\u0000";
        // 只认这一次停下的那一秒:迟到的(用户又拖走了,舞台在新的跳转里已经把它们放回抑制)不算精确。
        // 贴流的卡按 store 此刻的播放头比(`tRef` 要等下一次渲染才更新,刚暂停的那一下会慢一步);单舞台逐层追一帧照旧按 `tRef` 比
        const stale = singleRef.current ? Math.abs(e.sec - tRef.current) > 1e-6 : named && Math.abs(e.sec - getState().t) > 1e-6;
        if (stale) {
          if (named) void pumpRef.current();
          break;
        }
        // K5:暂停态活渲就绪 —— 把这几张卡从投递基线里删掉(A3c),平面舞台自己摘了
        noteSettled("front", e.clipIds);
        if (named) void pumpRef.current();
        break;
      }
      case "demote":
        // K6:这张卡降级,父页整条 PUT { ...旧记录, capped: true, demoted: true }
        void onStageDemote(e.clipId);
        break;
      case "probe":
      case "probe-frame":
        // K1(R4):探针的成绩和它顺手推出来的死素材(消费方在 probeRunner)
        break;
      case "mediaReady":
        // K5 第 (4) 步:后台舞台的素材层画出一帧了(消费方在 catchUp.ts,它自己订阅)
        break;
    }
  }), []);

  /**
   * 选中描边用的外框:不用包裹层(每张卡都占满整屏),用片段的实体范围——
   * 字幕卡的描边贴着字幕本身,而不是绕屏幕一圈。老渲染面没有 bounds 就退回包裹层。
   */
  /*
   * R7(D3 第 4 步 / D5):主文档的 `mediaRects` 已经删掉。
   *
   * 素材段现在由舞台自己画(E7 第 1 条,R3 落地),`data-pc-clip` 写在显示着的视频槽位
   * 和图片层上,所以舞台的 `rects()` / `hitTest` 本来就认得它们 —— 主文档再补一份,
   * 同一个 clipId 就会出现两次、命中时挑到错的那个。命中测试和实体框**全部走舞台**的
   * `hitTest` / `rectsWithBounds`。
   */

  /**
   * 一次往返拿全部活跃片段的外框 + 实体范围(rectsWithBounds,合并了以前 rects() 后逐个 bounds() 的 N+1)。
   * 心跳只带 pixels: 'selected':只对选中的卡扫 canvas 像素(选中描边不回退到整块画布),
   * 未选中的卡用元素矩形 —— 它们的框只进 rects 列表、不画描边。'all' 只在用户点击那一次用。
   * 回包乱序时旧的一次不能盖掉新的,用代数守着。
   */
  const rectsGen = useRef(0);
  const refreshRects = useCallback(async (pixels: "selected" | "all" = "selected") => {
    const s = stage();
    const gen = ++rectsGen.current;
    let cards: { clipId: string; left: number; top: number; width: number; height: number }[] = [];
    if (s) {
      try {
        const list = await s.rectsWithBounds(pixels === "selected" ? { pixels, clipIds: selectionRef.current } : { pixels });
        cards = list.map((r) => ({ clipId: r.clipId, ...(r.bounds ?? r.rect) }));
      } catch {
        // iframe 正在换(detached):这一次作废,新的 ready 会再刷一遍
        return;
      }
    }
    if (gen !== rectsGen.current) return;
    // R7:素材段也在舞台里了(E7 第 1 条),`rectsWithBounds` 一次就把卡片和素材段都带回来
    setRects(cards);
  }, [stage]);

  /** 刚被点中的片段:描边闪一下,让用户看清点到的是谁 */
  const [flash, setFlash] = useState<{ clipId: string; token: number } | null>(null);
  const flashClip = (clipId: string) => setFlash({ clipId, token: Date.now() });

  /**
   * 实体命中:问渲染面这一点上从最上层往下第一个「画了东西」的元素属于哪个片段。
   * 透明容器穿过去——字幕卡在最上层也不会挡住下面的卡。老渲染面没有 hitTest 时
   * 退回按包裹层外框找最上层的那个。
   */
  const hitAt = async (e: { clientX: number; clientY: number; currentTarget: EventTarget & Element }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    const s = stage();
    /*
     * R7:卡片和素材段都在舞台里,一次 `hitTest` 往返就是最终答案(D3)。
     * 主文档只在**完全没有舞台**时(还没握手 / iframe 正在换)退回上一轮 `rects` 找一下。
     */
    let card: { clipId: string; left: number; top: number; width: number; height: number } | null = null;
    if (s) {
      try { card = await s.hitTest(x, y); } catch { card = null; }
    }
    const inside = (r: { left: number; top: number; width: number; height: number }) =>
      x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    const hit = card ?? (s ? null : [...rects].reverse().find(inside)) ?? null;
    return { hit, overlayRect: rect };
  };

  // 项目文档变了就发过去:经 stageBridge 只发变了的片段(两层 diff),没有基线时整份 + reset
  useEffect(() => {
    // 界限搜索测量期间舞台上是缩水项目:不推(测完整份重灌、stageReady +1 再来一次)
    if (!stageReady || costSearchMeasuring()) return;
    void syncProject("front", project).then(() => refreshRects(), () => {});
  }, [stageReady, project, refreshRects]);

  // 时间变了就下发。播放中是连续推进;拖播放头 / 跳转 / 重播(playToken 变)都按跳转处理:
  // 重挂载 + 从入点补跑到那一刻。两者合在一个 effect 里,一次 seek 只渲染一帧。
  /*
   * 只认「时间真的变了」:stage / refreshRects 这两个回调的引用会跟着项目、缩放一起换,
   * 以前它们一换这个 effect 就重跑,于是 Agent 每写一次项目都多来一次 jump 渲染 ——
   * 重挂载活跃的卡、从入点逐帧补跑到播放头,实测播放头在 60 秒处每次 230~350 ms 的主线程,
   * 而项目变了该不该补跑,setProject 那边(StageView)已经按「哪张卡变了、在不在画面上」判过了。
   */
  /*
   * E0:暂停、拖动只发 setTime(不重挂载、不递增 playToken —— 时钟拨过去、提交 React、钉动画);
   * 父页对可见舞台**不再**发 render(jump)。
   *
   * **E6:这个 effect 拆成了两半。** 发 `setTime(t)` 那半**播放中不跑**(K4 由舞台自己按帧节拍
   * 推进,父页再发就是两个人抢方向盘);`refreshRects()` 那半改成播放中每 500 ms 一次的定时器
   * (见下面那个 effect),结果按请求序号丢弃过期的(`refreshRects` 里的 `rectsGen`)。
   * 先同步项目再拨时间,两条 RPC 顺序不能反(setTime 要在新项目上算活跃卡)。
   */
  const scrubbing = useSyncExternalStore(subscribeScrub, isScrubbing, isScrubbing);
  /*
   * 双舞台模式下由页面触发预渲染(公共 hook,legacy 那一路在 `UnifiedPreview` 里用同一份):
   * 编辑推送成功(`frameRequest` 先 `alignMirror`)且空闲(不在播放、不在拖动)时防抖发 `preload`,没就绪就接着问。
   */
  usePrerenderPreload(project, { enabled: dual && !ONLINE, idle: !playing && !scrubbing, waitForProbe: true });
  /** 诊断:最近几次 setTime 与上一次失败(探针排查暂停后没追到活渲用) */
  const setTimeLogRef = useRef<{ at: number; sec: number; settle: boolean }[]>([]);
  const setTimeErrorRef = useRef<{ at: number; sec: number; error: string } | null>(null);
  const scrubbingRef = useRef(scrubbing);
  scrubbingRef.current = scrubbing;
  const lastRenderKey = useRef("");
  /**
   * 给可见舞台拨一次时间。**暂停和拖动的唯一入口**(播放走 K4)。
   *
   * `settle: true` 启动 K5 的暂停态活渲:点时间轴、拖动松开、按暂停、播放到头都带它,
   * **拖动过程中不带**(E3)。
   */
  /**
   * 发给可见舞台的 `setTime` 的代数(每发一次 +1)。单舞台停下追一帧按「此刻最新的 setTime + 秒数」去重:
   * 暂停那一下父页会连着发几次 setTime(暂停、舞台最后一拍改写的 t),各自的追一帧可能在最后一次 setTime 之后才发出;
   * 同一秒两次追一帧在舞台里并发,后一次会把前一次画好的层打断成「没画好」,画好的层又回到抑制(单舞台在线探针 G3 实测)。
   */
  const setTimeEpochRef = useRef(0);
  const settleKeyRef = useRef<string | null>(null);
  const sendSetTime = useCallback(async (sec: number, opts: { settle?: true } = {}) => {
    setTimeLogRef.current.push({ at: Math.round(performance.now()), sec, settle: !!opts.settle });
    if (setTimeLogRef.current.length > 12) setTimeLogRef.current.shift();
    const s = stage();
    if (!s || costSearchMeasuring()) return;
    try {
      await syncProject("front", getState().project);
      if (liveRef.current) {
        clearSettled("front", `setTime ${sec}`);
        syncPlanes(s, { project: getState().project, t: sec, playing: false, single: singleRef.current, sparseOnly: singleRef.current });
      }
      // 只有一个舞台时停下追一帧另走 `settleLayers`(下面),舞台的 K5 第一路不起
      const { settle: _settle, ...stageOpts } = opts;
      setTimeEpochRef.current++;
      await s.setTime(sec, singleRef.current ? stageOpts : opts);
    } catch (e) {
      // iframe 正在换(detached):新的 ready 会重发
      setTimeErrorRef.current = { at: Math.round(performance.now()), sec, error: String((e as Error)?.message ?? e).slice(0, 120) };
      markBaselineReset("front");
      return;
    }
    // 换回双舞台的衔接:新的可见舞台按新项目落好这一帧了,稍等它画到屏上再撤盖板
    if (handoverRef.current && s === stage()) finishHandover(STAGE_HANDOVER_SETTLE_MS, "setTime");
    void refreshRects();
    void pumpRef.current();
    /*
     * K5 第二路:只要这一刻有一张判重卡是 `vtOk = false`,就让后台舞台整场景补跑、
     * 补完互换成精确活渲。`vtOk` 的那些已经在可见舞台里自己追了(K5 第一路,舞台侧)。
     */
    // 互换完了再投一次:新的可见舞台手里没有流平面,把播放头下这一帧先解好(互换期间 `pumpFeed` 不动流平面)
    if (dualRef.current && opts.settle && !singleRef.current) void runSettleSwap(sec).then((swapped) => { if (swapped) void pumpRef.current(); }, () => { /* 后台舞台正在换:下一次 setTime 会重来 */ });
    /*
     * 只有一个舞台时停下追当前一帧:暂停、点击或拖动松开、播放到头的这一次,舞台在可见舞台里把当前这一帧的所有卡活渲一次;
     * 画好之前照兜底顺序显示(有预渲染结果贴它,没有是占位),画好一层替换一层,不设时限(最低一档「停下以后……不设时限」)。
     */
    if (liveRef.current && opts.settle && singleRef.current) void settleLayersAt(s, sec);
  }, [stage, refreshRects, syncPlanes]);
  /** 单舞台停下追一帧的代数(又停了一次 / 又动了:旧的结果不记)与上一次的结果(诊断) */
  const settleGenRef = useRef(0);
  const settleResultRef = useRef<(SettleResult & { at: number }) | null>(null);
  const settleLayersAt = useCallback(async (s: StageRpcClient, sec: number): Promise<void> => {
    // 同一次 setTime 之后同一秒已经在追:不再发第二次(见 setTimeEpochRef)
    const key = `${setTimeEpochRef.current}|${sec}`;
    if (settleKeyRef.current === key) return;
    settleKeyRef.current = key;
    const gen = ++settleGenRef.current;
    let result: SettleResult;
    try {
      result = await s.settleLayers(sec);
    } catch {
      result = { ok: false, reason: "rpc", sec, timeoutMs: null, ms: 0, drawn: [], timedOut: [], skipped: [] };
    }
    if (gen !== settleGenRef.current) return;
    settleResultRef.current = { ...result, at: Date.now() };
    // 画好的层已经收到 `settled`;再投一次,把基线对齐到舞台此刻的样子
    void pumpRef.current();
  }, []);
  /** K4 的起 / 停节拍只认 `playing`,所以那个 effect 读这一份、不把 `sendSetTime` 进依赖 */
  const sendSetTimeRef = useRef(sendSetTime);
  sendSetTimeRef.current = sendSetTime;
  /** 上一次这个 effect 看到的 `playing` —— 「刚从播放翻成暂停」那一次要让给收尾那个 effect */
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    if (!stageReady) return;
    // K4:播放中播放头由舞台的 `frame` 推,父页一拍都不发
    if (live && playing) { wasPlayingRef.current = true; return; }
    /*
     * **刚暂停的那一次不在这里发**(E0 / R5-4)。收尾是下面那个 effect 的事,它按
     * `pause()` 回包的 `stoppedAt` 发;这里手上只有 `store.t`,可能比舞台落后一拍,
     * 抢着发一次会走向后跳路径(全场 stateful 卡重挂载、`.pc-settling` 闪一下),
     * 而且把 K5 的追帧 / 互换白启动一遍。播放到头(`ended`)走的是同一段。
     */
    const justPaused = live && wasPlayingRef.current;
    wasPlayingRef.current = false;
    if (justPaused) return;
    /*
     * **`scrubbing` 也进键**(E3 / pinned 架构 9)。拖动松开、在时间轴上点一下,
     * `t` 都可能一点没变(松手坐标等于最后一次 flush 的位置;点击时 `seek` 和
     * `beginScrub` 在同一个 React 事件里批成一次渲染,那一次 `scrubbing` 已经是 true)。
     * 键里不带这一位的话,拖动 / 点击结束之后永远补不上那条 `settle: true`,
     * 判重卡就停在快照上 —— 正是「点时间轴、拖动松开后不精确活渲」那条。
     * legacy 下 `dual` 为 false,后缀恒定,不会多发。
     */
    const key = `${stageReady}|${t}|${playToken}|${live && scrubbing ? "scrub" : "settle"}`;
    if (key === lastRenderKey.current) return;
    lastRenderKey.current = key;
    // 单舞台同样带 settle:停下时逐层追当前一帧,拖动过程中不带
    void sendSetTime(t, live && !scrubbingRef.current ? { settle: true } : {});
  }, [stageReady, live, playing, t, playToken, scrubbing, sendSetTime]);

  /*
   * 同步卡运行状态变成 ready、或测量结果到了导致分派表重算后，停着的舞台重新投递抑制并结算当前帧：
   * 刚打开项目时同步卡尚未 ready，首次 setTime(t, { settle: true }) 按 localOnly 把它记入抑制（显示沙漏）、
   * swapTrace 也只记下没测过的那一次；之后卡 ready、测量完成，暂停中若不再触发结算就会一直停在沙漏。
   */
  useEffect(() => {
    if (!live) return;
    let queued = false;
    const settlePaused = () => {
      queued = false;
      if (!liveRef.current || !stageReadyRef.current || playingRef.current || scrubbingRef.current || costSearchMeasuring()) return;
      void sendPlanTo("front");
      void pumpRef.current();
      if (!probeProgress().running) {
        void sendSetTimeRef.current(tRef.current, { settle: true });
      }
    };
    const trigger = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(settlePaused);
    };
    const offPlan = onPlanUpdated(trigger);
    const offRunStates = onCardRunStatesChanged(trigger);
    let wasRunning = probeProgress().running;
    const offProbe = onProbeProgress((p) => {
      const finished = wasRunning && !p.running;
      wasRunning = p.running;
      if (finished) trigger();
    });
    return () => { offPlan(); offRunStates(); offProbe(); };
  }, [live]);

  /* E6:播放中 `refreshRects` 改成定时器,一次往返、结果按序号丢过期的 */
  useEffect(() => {
    if (!live || !stageReady || !playing) return;
    const id = window.setInterval(() => { void refreshRects(); }, RECTS_POLL_MS);
    return () => window.clearInterval(id);
  }, [live, stageReady, playing, refreshRects]);

  /*
   * K4 的父页侧:`playing` 翻成 true 就 `play(t)` 起节拍,翻成 false 就走收尾
   * (`setPlaying(false)` → `pause()` 拿 `stoppedAt` → `setTime(stoppedAt, { settle: true })`)。
   *
   * **以舞台最后一拍的 `t` 为准,不用 `store.t`**(E0):store 的 `t` 可能比舞台落后一拍,
   * 按它发会走向后跳路径、全场 stateful 卡重挂载。
   * 播放到头(`ended`)走的是同一段 —— 那边只写 store,`playing` 翻 false 之后落到这里。
   *
   * 起播位置见 `playStartOf`:播放头不在内容范围里就回到最早那张卡(和 legacy 循环同一条规矩)。
   */
  /**
   * 这一次按播放从哪一秒起。和 legacy 的墙钟循环(`:155-158`)逐字同一条规矩:
   * 播放头在第一张卡之前、或者已经播到头,就从最早那张卡重播。
   *
   * R7 把缺省翻成舞台之后这条规矩漏了,播到头再按播放会在舞台第一拍就
   * `rawSec >= duration`、立刻 post `ended` —— 按下去什么都不发生(R7-11 的回归)。
   */
  const playStartOf = useCallback((): number => {
    const project = getState().project;
    const fps = Math.max(1, project.fps || 30);
    const start = contentStartRef.current;
    const from = tRef.current;
    if (from >= start && from < project.duration - 0.5 / fps) return from;
    // store 也要跟着回到起点:时间轴、素材层、`ended` 之后的那次 settle 都按 store.t 走
    actions.seek(start);
    return start;
  }, []);
  useEffect(() => {
    if (!live || !stageReady) return;
    let alive = true;
    const s = stage();
    if (!s) return;
    if (playing) {
      playedRef.current = true;
      lastFrameAtRef.current = 0;
      stalledRef.current = false;
      stallCountRef.current = 0;
      gapMaxRef.current = 0;
      setMediaStalled(false);
      swapTriedRef.current = new Set();
      void (async () => {
        try {
          /*
           * **先等项目送到这个舞台,再起节拍。**
           *
           * 新 iframe 握手之后 `stageReady` +1,上面那个 effect 发 `syncProject`、这里发 `play` ——
           * 但 `syncProject` 走 stageBridge 的串行链(`chain.then`),真正 postMessage 要晚一个微任务,
           * 而 `play` 是同步发的。于是「带着 `playing` 换 iframe」(切回 2D、舞台热重载)时
           * 舞台先收到 `play`,手里还没有项目,回 `no-project`;这里又不重试 —— 按钮是「暂停」、画面不动。
           * 串在同一条链上等它落定,顺序就钉死了。基线没变时 `syncProject` 什么都不发,不多一次往返。
           */
          await syncProject("front", getState().project);
          if (!alive) return;
          const from = playStartOf();
          // 这一轮播放的起点:起播那一刻已经挂着的卡算「从中间开始」,之后逐拍挂上的算自然进场(播放态互换只给前者)
          notePlayRunStart(from);
          /*
           * 起播之前先把这一秒的流平面、抑制、快照摆好(以前等第一拍的 `frame` 才发:头一拍重卡是活渲的,又慢又会和流接不上)。
           * 暂停着舞台已经把播放头下这一帧先解好了,这里一抑制,头一拍就是流的画面;流还没画出来的,舞台先不藏它原来的画面。
           * 不等回包:几条消息和下面的 `play` 按发出的先后到。
           */
          void pumpRef.current({ t: from, playing: true });
          const reply = await s.play(from);
          if (!alive) return;
          // 首拍的到达间隔以 `play()` 回包时刻为起点(K4)
          if (reply.ok) { lastFrameAtRef.current = performance.now(); armStallWatch(); }
          /*
           * 舞台说起不了(没项目、角色不对):**把 store 也翻回暂停**,别让界面停在「在播」。
           * 翻回去之后下面那一支照常收尾(`pause()` 拿 `stoppedAt` → `setTime(settle)`),
           * 画面和播放头对齐到舞台真实停着的那一帧;用户再按一次播放就是一次干净的起播。
           */
          else if (getState().playing) actions.pause();
        } catch { /* iframe 正在换:新的握手会让这个 effect 带着 playing 重跑一遍 */ }
      })();
    } else {
      void (async () => {
        // **发 pause() 的这一处同步清空 lastRenderKey**(E6),否则下一次 setTime 被去重吞掉
        lastRenderKey.current = "";
        window.clearTimeout(stallWatchRef.current);
        stalledRef.current = false;
        setMediaStalled(false);
        let stoppedAt = tRef.current;
        /*
         * 只有「刚从播放停下来」才以舞台的 `stoppedAt` 为准。暂停中换了一个新的渲染面(`stageReady` +1:
         * 卡片代码装上后舞台整页重载、热更新、iframe 重挂)也会走到这一支 —— 新舞台还停在 0,
         * 照它改 store 就把用户定好的播放头冲回 0(C6.6 T9:成员加入共享项目、装上用户卡之后播放头从 2.5 s 回到 0)。
         * 那时以 store 的 `t` 为准,只把它发给新舞台。
         */
        const fromPlay = playedRef.current;
        playedRef.current = false;
        try {
          const reply = await s.pause();
          if (fromPlay && reply.ok && typeof reply.stoppedAt === "number") stoppedAt = reply.stoppedAt;
        } catch { /* iframe 正在换 */ }
        if (!alive) return;
        if (Math.abs(getState().t - stoppedAt) > 1e-6) actions.tick(stoppedAt);
        await sendSetTimeRef.current(stoppedAt, { settle: true });
      })();
    }
    return () => { alive = false; };
    /*
     * **依赖只有三项**。`t` 每拍都在变,`stage` / `sendSetTime` 的身份也会跟着换 ——
     * 进了依赖这个 effect 就每拍重跑一次:播放中会把刚起的节拍循环停掉重起,
     * 暂停中那一支的 `actions.tick(stoppedAt)` 会把自己再触发一遍(无限更新)。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, stageReady, playing]);

  /*
   * R3 的最小接线:非 legacy 下素材层在**舞台里**(E7 第 1 条),它要三样东西才动得起来 ——
   * `mediaT`(跟哪一刻)、`scrubbing`(seek 放疏一点)、`playing`(只管素材层,不碰 K4 的节拍循环)。
   *
   * **两个舞台都发**(E3:「素材层 `mediaT = t`,两种角色一样」):K5 第二路互换前
   * `back` 的素材必须已经在目标拍上,不然互换后偏差过 `HARD_SEEK_SEC`、必付一次硬 seek。
   * legacy 下一条都不发 —— 那边素材层还在主文档。
   *
   * `playing` 带上 `mediaStalled`(K4):舞台的素材层和主文档的音频一起掐、一起放。
   */
  useEffect(() => {
    if (!live || !stageReady) return;
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (!c) continue;
      void c.setScrubbing(scrubbing).catch(() => {});
      void c.setPlaying(playing && !mediaStalled).catch(() => {});
    }
  }, [live, stageReady, scrubbing, playing, mediaStalled]);
  useEffect(() => {
    if (!live || !stageReady) return;
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (!c) continue;
      void c.setMediaT(t).catch(() => {});
    }
  }, [live, stageReady, t]);
  // C6.6:换档集合变了就下发给两个舞台(E3:素材层两种角色一样)
  useEffect(() => {
    if (!live || !stageReady) return;
    for (const id of STAGE_IDS) {
      const c = rpcRef.current[id];
      if (!c) continue;
      void c.setLocalHashes([...tierList]).catch(() => {});
    }
  }, [live, stageReady, tierList]);

  // 画面层和声音层都由 MediaLayers 管:可以同时有多条画面(重叠+淡化=交叉溶解),音频段单独出声

  // 命中测试与拖拽逻辑
  /**
   * 命中是一次异步往返(舞台在 iframe 里),但**起点不能丢**:pointerdown 时先同步抓住指针、记下起点,
   * 再 await hitTest;await 期间到达的 pointermove / pointerup 先累积,命中结果回来后再决定是选中还是开始拖动 ——
   * 「点画布后立刻拖动」的那几个 move 事件不会漏,松手早于回包也不会留下一个永远在拖的状态。
   */
  const handleOverlayPointerDown = async (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const overlay = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    try { overlay.setPointerCapture(pointerId); } catch { /* 指针已经没了,照样能算命中 */ }

    // await 期间的事件先记着
    let lastX = startX;
    let lastY = startY;
    let released = false;
    const onEarlyMove = (ev: PointerEvent) => { if (ev.pointerId === pointerId) { lastX = ev.clientX; lastY = ev.clientY; } };
    const onEarlyUp = (ev: PointerEvent) => { if (ev.pointerId === pointerId) released = true; };
    window.addEventListener("pointermove", onEarlyMove);
    window.addEventListener("pointerup", onEarlyUp);
    window.addEventListener("pointercancel", onEarlyUp);

    const { hit: targetRect } = await hitAt({ clientX: startX, clientY: startY, currentTarget: overlay });

    window.removeEventListener("pointermove", onEarlyMove);
    window.removeEventListener("pointerup", onEarlyUp);
    window.removeEventListener("pointercancel", onEarlyUp);

    const release = () => { try { if (overlay.hasPointerCapture(pointerId)) overlay.releasePointerCapture(pointerId); } catch { /* 已经放开了 */ } };

    if (tool === "select") {
      release();
      // 选择工具：点在实体上则选中并闪一下描边，点空白(或透明区域下面没东西)则取消选中
      if (targetRect) {
        actions.select([targetRect.clipId]);
        flashClip(targetRect.clipId);
        // 点击那一次用 'all':新选中的 canvas 卡描边按像素框来,不回退到整块画布
        void refreshRects("all");
      } else {
        actions.select([]);
      }
    } else if (tool === "move") {
      // 移动工具：按下开始拖拽，移动时更新本地拖拽状态，松开才写入 store 记录撤销
      if (!targetRect) { release(); return; }
      actions.select([targetRect.clipId]);
      flashClip(targetRect.clipId);
      const clipId = targetRect.clipId;

      let currentDx = 0;
      let currentDy = 0;
      const applyMove = (cx: number, cy: number) => {
        // 覆盖层是按 scale 缩放显示的,位移换算回舞台像素,和 frame 用的是同一套单位
        currentDx = (cx - startX) / scale;
        currentDy = (cy - startY) / scale;
        setDragPreview({ clipId, dx: currentDx, dy: currentDy });
      };
      const onMove = (ev: PointerEvent) => { if (ev.pointerId === pointerId) applyMove(ev.clientX, ev.clientY); };
      const onUp = () => {
        setDragPreview(null);
        release();
        if (Math.abs(currentDx) > 0.5 || Math.abs(currentDy) > 0.5) {
          /*
           * 拖动改的是 clip 的 frame(位置框),不是卡片参数:卡片没有 x / y 参数,以前往 params 里
           * 写 x / y 等于什么都没改 —— 描边跟着鼠标走了一段,松手就弹回去。
           * 走 nudgeFrame 和 Agent 的 nudge / set_position 是同一条路:没有 frame 的卡先按铺满舞台
           * 算出当前位置再加位移,松手只写一次,一次拖动 = 一步撤销。
           */
          const hit = findClip(getState().project, clipId);
          if (hit) {
            const stageSize = { width: getState().project.width, height: getState().project.height };
            actions.setClipFrame(clipId, nudgeFrame({ dx: Math.round(currentDx), dy: Math.round(currentDy) }, hit.clip.frame, stageSize));
          }
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };

      // 回包之前已经动过 / 松过手的,现在补上
      if (lastX !== startX || lastY !== startY) applyMove(lastX, lastY);
      if (released) { onUp(); return; }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    } else {
      release();
    }
  };

  // 文字工具逻辑
  const handleOverlayDoubleClick = async (e: React.MouseEvent) => {
    if (tool !== "text") return;
    const { hit: targetRect, overlayRect: rect } = await hitAt(e);
    if (!targetRect) return;
    flashClip(targetRect.clipId);

    const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === targetRect.clipId);
    if (!clip) return;
    const def = getCard(clip.cardId);
    if (!def) return;
    const textControl = def.controls.find((c) => c.type === "text");
    if (!textControl) return;

    const val = (clip.params[textControl.key] as string) ?? def.defaults[textControl.key] ?? "";
    
    // 输入框位置定位到卡片左上角（根据命中的目标矩形来换算）
    const inputX = targetRect.left * scale + rect.left;
    const inputY = targetRect.top * scale + rect.top;

    setEditingText({
      clipId: clip.id,
      key: textControl.key,
      value: val,
      x: inputX,
      y: inputY,
    });
  };

  const handleOverlayContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const { clientX, clientY, currentTarget } = e;
    const { hit: targetRect } = await hitAt({ clientX, clientY, currentTarget });
    if (targetRect) {
      const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === targetRect.clipId);
      if (clip) {
        actions.select([clip.id]);
        flashClip(clip.id);
        setContextMenu({ x: clientX, y: clientY, clipId: clip.id, cardId: clip.cardId });
      }
    }
  };

  const submitTextEdit = () => {
    if (editingText) {
      actions.setClipParams(editingText.clipId, { [editingText.key]: editingText.value }, { merge: true });
    }
    setEditingText(null);
  };

  /** 画框左上角该摆在窗口的哪个位置。还没量到窗口大小时先不摆(那一帧在绘制前就过去了) */
  const frameXY = boxSize ? frameOrigin(cam, project, boxSize) : null;

  return (
    <div className={mobile ? "pc-pv pc-pv--mobile" : "pc-pv"} data-pc="preview">
      {!mobile && <div className="pc-pv-tabs" data-pc="preview-tabs">
        {([["2d", "2D"], ["3d", "3D"]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={view === id ? "is-on" : undefined}
            onClick={() => setView(id)}
            title={id === "2d" ? "成片预览:所见即导出所得" : "三维视图:像 Blender 那样绕着看这些卡在空间里怎么摆"}
          >
            {label}
          </button>
        ))}
      </div>}
      {online && <CostSearchGate />}
      {online && gateViewerWanted() && <GateViewer />}

      {view === "2d" && !mobile && <ToolBar tool={tool} onToolChange={setTool} zoom={cam.scale} fitted={cam.auto} onFit={fitToWindow} />}

      {/*
        * **2D 这一页在 3D 页下面常驻,只是藏起来,不卸载。**
        *
        * 以前是 `view === "3d" ? <3D/> : <2D/>`,切到 3D 就把舞台 iframe 连同主文档的音频层一起卸掉。
        * 可播放头**跟随舞台**(docs/semantics/product/rendering.md「播放头跟随舞台」,K4:
        * 非 legacy 下只有可见舞台的 `frame` 事件在推 `t`)—— 舞台没了,3D 页按播放就什么都不会动,
        * 声音也没了。现在舞台一直在跑,3D 页读的还是同一个 `t`,播放轴和声音和 2D 页一模一样。
        *
        * 藏法只能是 `opacity: 0` + 不收指针(和后台舞台同一个理由,见 iframe B 的注释):
        * `display: none` 会让 iframe 里的 rAF 和 `<video>` 停掉,`visibility: hidden` 会让 `isSolid`
        * 判错实体框。`inert` 顺带挡掉键盘焦点落进看不见的那一页。
        * 藏起来的那一页 `inset: 0` 铺在同一块地方,窗口尺寸不变,切回 2D 不用重新适应缩放。
        */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* 档位气泡:舞台闸门走完、进入编辑界面后在预览窗口上方显示一次,几秒后自动消失(`TierBubble.tsx`) */}
      {online && <TierBubble ready={stageReady > 0} />}
      {view === "3d" && (
        <div className="pc-pv-stage" style={{ position: "relative" }}>
          <Scene3DView project={project} t={t} />
        </div>
      )}
      <div
        ref={boxRef}
        className="pc-pv-stage"
        data-pc="preview-2d"
        aria-hidden={view === "3d" || undefined}
        inert={view === "3d"}
        style={view === "3d" ? { position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" } : undefined}
      >
        <div
          className="pc-pv-frame pc-checker"
          style={{
            width: project.width * scale,
            height: project.height * scale,
            /*
             * 位置完全由自己算(见 boxSize 那段说明:靠浏览器居中在放大之后会失准)。
             * 绝对定位到左上角,再用 transform 挪到该在的地方 —— transform 不触发重排,
             * 拖动时每一帧都在改它,用 left/top 会一路重排。
             */
            position: "absolute",
            left: 0,
            top: 0,
            transform: frameXY ? `translate(${frameXY.x}px, ${frameXY.y}px)` : undefined,
            /*
             * 透明棋盘格搬到 .pc-checker 了(见 preview/preview.css)。
             *
             * 原来这儿内联写着另一套偏暗的值,理由是「配色规范 04 条:透明格要比周围画布更暗更弱」。
             * 那条规矩本身没错,但它和这块底真正要回答的问题冲突:**这儿是不是什么都没有?**
             * 底一暗,一张深色的卡和「什么都没画」就长得一模一样 —— see_frames 和 3D 视图
             * 都因为这个踩过坑。而且 2D 和 3D 两页各用一套值,同一个项目在两页里
             * 「透明」长得都不一样。所以统一到中灰那一套,和 see_frames 逐值对齐。
             */
          }}
        >
          <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0", position: "absolute", left: 0, top: 0, ...themeStyle(project.themeId) }}>
            <div style={{ position: "relative", width: project.width, height: project.height }}>
              {/* K4 的 `mediaStalled`:舞台的一拍比应到时刻晚出超过 40 ms 时,音频跟着停一下;这一轮播放的第一拍到之前音频不起播 */}
              <MediaLayers project={project} t={t} playing={playing && !mediaStalled && (!live || firstBeatRef.current)} masterVolume={muted ? 0 : volume} audioOnly localHashes={tierList} />
              {/*
                * 舞台 iframe 按槽位挂:单舞台(`single`,舞台闸门第一级、最低一档、握手失败退回,都是跨源 A)、跨源的 A(`dualA`)、
                * 跨源的 B(`dualB`),顺序固定、按槽位作 key。
                * 在线模式下一律跨源隔离:读不到舞台源时不再退回同源单舞台,直接不挂载舞台 iframe(2026-10-14 用户定);
                * 握手失败退回跨源单舞台 A(只管当次,不留崩溃记录;`mechanism/platforms.md`「三道闸门」)。
                */}
              {!stagesPending && !(ONLINE && !stageOrigins()) && (() => {
                const base = {
                  position: "absolute" as const,
                  inset: 0,
                  width: project.width,
                  height: project.height,
                  border: 0,
                  display: "block",
                  background: "transparent",
                  colorScheme: "normal" as const,
                };
                const hidden = { opacity: 0, pointerEvents: "none" as const };
                const out: React.ReactNode[] = [];
                const showSingle = !dual || handover;
                if (showSingle) {
                  const cover = dual && handover;
                  out.push(<iframe
                    key={`single-${stageFrameGen.A}`}
                    ref={cover ? undefined : frameRefOf.A}
                    data-pc={cover ? "stage-frame-cover" : "stage-frame"}
                    title="预览舞台"
                    sandbox={ONLINE ? STAGE_SANDBOX : undefined}
                    onLoad={() => onStageFrameLoad("A")}
                    /*
                     * 这里**不加 proxy=1**:2D 预览的契约是「预览所见 = 导出所得」,
                     * 播放时换成色块就把这条破了 —— 用户按播放是要看成片长什么样,
                     * 不是要看构图草图。代理只活在 3D 视图里,而且只是预渲染没跟上时的过渡。
                     */
                    src={stageSrc("A", { dual: false })}
                    style={{
                      ...base,
                      /*
                       * R7:**舞台露出来**(D5)。可见的那一个不再是全透明的,用户看到的
                       * 就是舞台 iframe 本身,不再是主文档里那张整帧 `<img>`。
                       *
                       * 判据是 `live`:在线页面的同源单舞台也渲 live 变体(`stageSrc` 带 `&preview=stage`)。
                       * 桌面端口被占退回同源单舞台时那一份还是 placeholder 内容,
                       * 露出来会是一张没有素材的画面 —— 那时候要继续用 `UnifiedPreview` 的整帧。
                       * 换回双舞台的盖板照样露着(停在最后一帧),挡掉指针。
                       */
                      ...(cover ? { opacity: 1, pointerEvents: "none" as const } : { opacity: live ? 1 : 0 }),
                    }}
                  />);
                }
                if (dual || interim) {
                  const warm = !dual;
                  out.push(<iframe
                    key={`dualA-${stageFrameGen.A}`}
                    ref={warm ? warmRefOf.A : frameRefOf.A}
                    data-pc={warm ? "stage-frame-warm" : "stage-frame"}
                    title={warm ? "预热舞台" : "预览舞台"}
                    /*
                     * 在线的跨源舞台带 sandbox(契约 `online-card-exec-contract.md` 第 3.3 节):只开脚本与保有自己的源两项,
                     * 不给弹窗、带走顶层、表单、模态框、下载。舞台是跨源地址,`allow-same-origin` 只是让它保有自己的源
                     * (读自己源上的素材要它),不会变成编辑器页的源。桌面运行环境不带。
                     */
                    sandbox={ONLINE ? STAGE_SANDBOX : undefined}
                    src={stageSrc("A", { dual: true })}
                    onLoad={() => onStageFrameLoad("A")}
                    style={{
                      ...base,
                      // 后台那个还要挡掉指针 —— K5 互换之后 A 可能就是后台那一个;换回双舞台的衔接期间先不露出来
                      ...(!warm && live && frontId === "A" && !handover ? { opacity: 1 } : hidden),
                    }}
                  />);
                  if (!ONLINE || backStageMount) {
                    out.push(<iframe
                      key={`dualB-${stageFrameGen.B}`}
                      ref={warm ? warmRefOf.B : frameRefOf.B}
                      data-pc={warm ? "stage-frame-warm" : "stage-frame-back"}
                      title={warm ? "预热舞台" : "后台舞台"}
                      sandbox={ONLINE ? STAGE_SANDBOX : undefined}
                      src={stageSrc("B", { dual: true })}
                      onLoad={() => onStageFrameLoad("B")}
                      style={{
                        ...base,
                        /*
                         * 后台舞台**只能这么藏**(K5 (4)):`display: none` 会让里面的
                         * `<video>` 和 rAF 停掉、布局全归零,补跑出来的画面和可见舞台对不上;
                         * `visibility: hidden` 会让 `solid.ts` 的 `isSolid` 判它不是实体,
                         * 量出来的实体框退回整屏。`opacity: 0` 保留布局和渲染,只是看不见。
                         *
                         * R7:互换之后 B 可能是可见的那一个,那时它跟着露出来。
                         */
                        ...(!warm && frontId === "B" && !handover ? { opacity: 1 } : hidden),
                      }}
                    />);
                  }
                }
                return out;
              })()}
              {/*
                * R7(D5):整帧 `<img>` / `MovPlayer` canvas **只留在 legacy 分支**。
                * 露出舞台之后再画一层整帧,等于把舞台盖住,而且那一层要等 HTTP
                * ——「暂停拖动画面同一帧内更新、不等待 HTTP」这条就没了。
                */}
              {!live && <UnifiedPreview project={project} t={t} playing={playing} />}
            </div>
          </div>
          
          {/* 四角标记:设计稿画面四角各一个 16 方的 L 形,提示这是可编辑画布 */}
          <span className="pc-pv-corner tl" aria-hidden="true" />
          <span className="pc-pv-corner tr" aria-hidden="true" />
          <span className="pc-pv-corner bl" aria-hidden="true" />
          <span className="pc-pv-corner br" aria-hidden="true" />

          {/* 画布覆盖层，处理命中测试以及拖拽绘制 */}
          <div
            style={{ position: "absolute", inset: 0, zIndex: 10 }}
            onPointerDown={handleOverlayPointerDown}
            onDoubleClick={handleOverlayDoubleClick}
            onContextMenu={handleOverlayContextMenu}
          >
            {rects.map((r) => {
              const isSelected = selection.includes(r.clipId);
              if (!isSelected) return null;
              const dragDx = (dragPreview?.clipId === r.clipId) ? dragPreview.dx : 0;
              const dragDy = (dragPreview?.clipId === r.clipId) ? dragPreview.dy : 0;

              // 描边贴着实体范围;刚点中的那个用 key 带上 token,每次点击都重新跑一遍脉冲动画
              const pulsing = flash?.clipId === r.clipId;
              return (
                <div
                  key={pulsing ? `${r.clipId}:${flash!.token}` : r.clipId}
                  className={`pc-pv-hit${pulsing ? " is-pulse" : ""}`}
                  style={{
                    left: (r.left + dragDx) * scale,
                    top: (r.top + dragDy) * scale,
                    width: r.width * scale,
                    height: r.height * scale,
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
      </div>

      {!mobile && <ControlBar />}
      
      {contextMenu && (
        <PreviewContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          clipId={contextMenu.clipId}
          cardId={contextMenu.cardId}
          onClose={() => setContextMenu(null)}
        />
      )}
      
      {editingText && (
        <div style={{ position: "fixed", left: editingText.x, top: editingText.y, zIndex: 9999 }}>
          <input
            autoFocus
            type="text"
            value={editingText.value}
            onChange={(e) => setEditingText({ ...editingText, value: e.target.value })}
            onBlur={submitTextEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitTextEdit();
              if (e.key === "Escape") setEditingText(null);
            }}
            style={{
              padding: "4px 8px",
              border: "1px solid var(--ui-accent)",
              borderRadius: 4,
              background: "var(--ui-panel-2)",
              color: "var(--ui-fg)",
              outline: "none",
              fontSize: 14,
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 舞台 ↔ 父页的 postMessage RPC(E0)。
 *
 * - 一个 iframe 实例一个客户端(`createStageRpc`),请求带自增 id,回包按 id 对上;
 *   iframe 换了(热重载、卸载)就换一个客户端,旧客户端挂着的请求全部按 `detached` 回绝;
 *   目标窗口关了(iframe 被拿出 DOM)也一样 —— 发请求时、以及有请求挂着时每 `CLOSED_POLL_MS` 查一次。
 * - **时间一律秒**(`setTime(tSec)`、`render(tSec)`、`play(fromSec)`、`setMediaT(tSec)`、
 *   回包里的 `caughtUpAtSec`、事件里的 `sec`);舞台内部自己换算成毫秒(stageClock 的 `now` 是毫秒)。
 * - 舞台 → 父页除 `pc-stage-ready` 握手和 RPC 回包外只有七种事件(`StageEvent`),父页按
 *   `event.source` 过滤来源:`frame` / `ended` / `settled` / `demote` 只认当前 `front`,
 *   `mediaReady` / `probe` / `probe-frame` 只认当前 `back`(第 4 步 E1 双舞台时生效;第 3 步单舞台
 *   全部来自同一个 iframe)。
 * - 现在同源,第 4 步 E1 之后跨源;协议里不放任何依赖同源的东西(不传函数、不传 DOM、只传可结构化克隆的值)。
 */
import type { Project } from "../kernel/project";
import type { RectWithBounds, RectsWithBoundsOptions, StageHit } from "./solid";
import type { ProjectPatch } from "./changedClips.mjs";
import type { CardCostRecord } from "./cardCostKey.mjs";
import type { StreamPlaneRequest } from "./streamPlayer";
import { sanitizeRpcError, sanitizeRpcResult, sanitizeStageEvent } from "../online/stageMessageGuard.ts";
import { SETTLE_MAX_MS, SETTLE_RPC_CAP_MS } from "./settleFrame.ts";
import type { SettleResult } from "./settleFrame";
import type { CardRunState } from "../kernel/registry.ts";

export type { StreamPlaneRequest };

export type StageRole = "front" | "back";
export type BackJob = "probe" | "catchup" | "bake";

export interface HostCapabilities {
  /** 本地模式有预渲染进程(由父页经 iframe 的 src 查询串告知,舞台自己不探测) */
  prerender: boolean;
  /** Worker 里能拿到 OffscreenCanvas 的 webgl2 */
  offscreenGl: boolean;
  /**
   * 只有一个舞台(在线页面舞台闸门停在第一级、最低一档、握手失败退回单舞台;父页在 src 查询串里给 `compact=1`):
   * canvas 卡的图集按小的上限开、后台角色走路线 1 时不开 Worker。桌面运行环境恒为 false。
   */
  compact: boolean;
  /**
   * 起手的 canvas 渲染路线(在线页面由父页按舞台闸门在 src 查询串里给 `gl=`;试第三级时父页经 `setGlRoute` 换)。
   * 桌面运行环境不给,按项目选项(`project.glRoute`)与缺省(路线 1 各一套)。
   */
  glRoute: "perDocument" | "shared" | null;
  /**
   * 最低一档(在线页面父页给 `lowest=1`):素材起手就只用小尺寸,不等父页的取档策略。桌面运行环境恒为 false。
   */
  lowest: boolean;
  /**
   * 这一台舞台有后台舞台做伴(双舞台,父页在 src 查询串里给 `dual=1`):能在后台舞台测量卡片成本(C10 契约第 2 节
   * 「宿主能力表照实报」;在线页面开了后台舞台也报 true)。单舞台为 false。
   */
  measure: boolean;
  /** 能在后台舞台追到精确活渲再互换(K5 第二路);条件同 `measure` */
  catchUp: boolean;
  /**
   * 父页在 src 查询串里给的舞台 id(`A` / `B`)。**只是实例名,和角色无关**(E1):
   * 角色只经 `setRole` 定,两个 iframe 谁当 `front` 都行、中途还会互换(K5)。
   */
  stageId: string;
}

export interface StageReadyMessage {
  type: "pc-stage-ready";
  hostCapabilities: HostCapabilities;
}

/**
 * 生成快照的三段耗时(任务书 3.8):在一次 `render` / `setTime` 里**累加**本次推过的每一帧。
 * 三个都不进判重 —— 判重只看活渲的 `stepMs`。
 */
export interface SnapshotCost {
  /** 样式内联(含复制 DOM) */
  inlineMs: number;
  /** 画布栅格化(没有画布的卡是 0) */
  rasterMs: number;
  /** 素材层占位 + 序列化 */
  serializeMs: number;
}

/**
 * K1 的探针分两趟(任务书 K1,用户 2026-09-22 确认)。
 * - `'time'` **计时趟**:只推进,不生成快照、不 post `probe-frame`;按
 *   `PROBE_MAX_FRAMES` / `PROBE_MAX_MS` 封顶(**不按一拍预算截断**——旧做法让 61 张推帧卡
 *   全部只推了 1～10 帧);回包带 `steps`(每帧的活渲耗时),`stepMs` 取它的稳健值、
 *   `catchUpMs` 取它的和。
 * - `'snapshot'` **快照趟**:每帧先推进、再生成快照并 post `probe-frame`,量三段快照耗时;
 *   仍受一拍预算约束,它的截断不影响任何判定。
 *
 * - `'booleans'` **两趟布尔探针**(R4b 加):`vtOk` / `seekOk` / `seekMs`。整趟都在舞台里跑
 *   (它要 `pinner.syncIn` 钉子树虚拟时间,父页够不到),回包带 `booleans`。
 *   三趟各自先按 K3 的「重挂载定位配方」复位,各 `PROBE_BOOL_FRAMES` 帧或 `PROBE_BOOL_MS` 封顶;
 *   **生成的快照一律不 post `probe-frame`**(它们按定义可能与正确帧不同,存下去会覆盖正确的死素材)。
 *
 * `true` 等于 `'snapshot'`(兼容旧调用方)。
 */
export type ProbeMode = "time" | "snapshot" | "booleans";

/**
 * K1 的两趟布尔探针结果(pinned 划分轴一「如何区分 SeekOK」)。
 *
 * - `vtOk`:能不能只用**子树虚拟时间**推(`pinner.syncIn` + 组件本地 `t`,全局时钟不动)。
 *   决定 K3(b) / K5 走哪条追帧路。读全局帧循环时间戳的 Motion JS 动画推不动,是 `false`。
 * - `seekOk`:能不能**一步钉到**目标帧(不经中间帧),结果和逐帧推到那一帧相同。
 *   **只看结果一致,不看代价** —— 代价是 K2 的事。
 * - `seekMs`:从第 0 帧直接钉到片段最后一帧的墙钟(`__pcRealNow`)。
 *   超过 `PROBE_BOOL_MS` 记 `null`(未知)—— 记上限值再线性缩放得到的是乐观的下界,
 *   K2 对 `null` 一律按推帧卡规则走,和 `catchUpMs` 截断时的外推口径一样是保守的。
 */
export interface ProbeBooleans {
  vtOk: boolean;
  seekOk: boolean;
  seekMs: number | null;
}

export interface RenderResult {
  remounted: boolean;
  caughtUpAtSec: number;
  elapsedMs: number;
  /**
   * **活渲耗时**:`elapsedMs` 减掉本次生成快照花的时间(任务书 3.3 / 3.8)。
   * 只有它进判重(`capped = stepMs > B`)。不带 `probe` 时 = `elapsedMs`。
   */
  stepMs: number;
  /** probe 第一趟:推了几帧、有没有被上限截断 */
  frames?: number;
  truncated?: boolean;
  /** 只在 probe 时有 */
  snapshot?: SnapshotCost;
  /**
   * 只在 `probe: 'time'` 时有:**每一帧**的活渲耗时(`__pcRealNow` 量,不含帧间让出的时间、
   * 不含生成快照)。`stepMs` 要取它的百分位(`robustStep`)而不是单次最大 ——
   * 限 2 核下同一张卡两次实测的单帧最差能差十几倍,越线的是偶发卡顿、不是稳定成本。
   */
  steps?: number[];
  /**
   * 只在 `probe: 'snapshot'` 时有:**每一帧**生成快照那三段的耗时。
   *
   * 同一趟的 `snapshot` 是这些的**累加**(给「这一趟花了多久」用),而成本记录要的是
   * **单帧的稳健值**(`robustStep`,任务书 K1),累加值换算不回来。离线探针为了拿逐帧数
   * 只好一帧发一次 `render`(40 次往返);常驻探针在加载遮罩下跑,40 × N 次往返太慢,
   * 所以这里和 `steps` 对称地把逐帧样本一起带回去,一次往返就够。
   */
  snapshotSteps?: SnapshotCost[];
  /** 只在 `probe: 'booleans'` 时有 */
  booleans?: ProbeBooleans;
}
/**
 * `render` 被掐断 / 拒绝时的回包。父页对每个 reason 的规矩不一样(E0):
 *   - `superseded`:父页自己的新 `render` 掐的,**直接丢弃**,重发只会再掐掉新的那次;
 *   - `project`:`setProject` 掐的,按当前目标重发(最多 3 次);**例外**是 `back` 正处在
 *     `job: 'catchup'` 期间(补跑 / 页面侧测量自己灌的项目),那时一律丢弃 —— 闸门按工作项判、
 *     不按 `settling` 标志判(stageJobs.ts 的 `renderAbortAction`);
 *   - `timeout`:K1 探针的封顶,既不重发也不当错误(截断 ≠ `capped`);
 *   - `role`:E1 的角色闸门,收到的舞台不是 `back`。**当错误、不重发** —— 重发也还是同一个角色;
 *   - `detached`:RPC 客户端在 iframe 换掉 / 卸载时自己造的。丢弃回包、按新客户端重发当前目标。
 */
export interface RenderAborted {
  aborted: true;
  reason: "superseded" | "project" | "timeout" | "role" | "detached";
  elapsedMs?: number;
  stepMs?: number;
  frames?: number;
  truncated?: boolean;
  snapshot?: SnapshotCost;
  steps?: number[];
  snapshotSteps?: SnapshotCost[];
}
export type RenderReply = RenderResult | RenderAborted;

export interface SetTimeOptions {
  /** C4 的快照增量,和 t 同一次提交生效(第 4 步) */
  snapshots?: Record<string, string | null>;
  /** 本次要加 `.pc-awaiting` 的片段(第 4 步) */
  awaiting?: string[];
  /** 启动 K5 的暂停态活渲(第 4 步) */
  settle?: true;
  /** K1 探针:走跳转路径、等一次真 rAF、生成一次本控件的快照,回包带四个数 */
  probe?: true;
}
export interface SetTimeResult {
  /** 只在 probe 时有:`__pcRealNow` 量的墙钟(含那一次真 rAF 的等待) */
  elapsedMs?: number;
  /**
   * 只在 probe 时有:**活渲耗时**,唯一进判重的数(任务书 3.3 / 3.8)。
   * 量的是 `clock.set` → `flushSync` → 钉动画 → `settle` 这一段,
   * **不含**那一次真 rAF 的等待(它至少是一个垂直同步,约 17 ms,见 3.8 末条),
   * 也不含生成快照。
   */
  stepMs?: number;
  /** 只在 probe 时有:生成快照的三段耗时 */
  snapshot?: SnapshotCost;
  /**
   * 只在 probe 且有 canvas 卡时有(R9 M4):GL Worker 报的每卡 GPU 时间(毫秒,`gl.finish()` 前后的墙钟)。
   * 诊断用,不进判重 —— 判重的 `stepMs` 已经含 `beat → done` 往返。
   */
  glGpuMs?: Record<string, number>;
  /** 这次 setTime 走的路径,给验收和调试看 */
  path: "continuous" | "set";
}
/**
 * 带 `probe: true` 的 `setTime` 撞上角色闸门(E1):收到的舞台不是 `back`。
 * 和 `render` 的 `role` 同一条规矩 —— 父页当错误、不重发。不带 `probe` 的 `setTime`
 * 两种角色都收(拖动发给 `front`、D4 的页面侧测量发给 `back`),不会走到这里。
 */
export interface SetTimeAborted {
  aborted: true;
  reason: "role";
}
export type SetTimeReply = SetTimeResult | SetTimeAborted;

export interface RenderOptions {
  /** true = 重挂载并从 mountFrameOf 推到 tSec;缺省 = 续推(不重挂载,从 clock.now() 推到 tSec) */
  jump?: boolean;
  maxCatchUp?: number;
  /** K1 探针的趟别(见 `ProbeMode`)。`true` 等于 `'snapshot'`。 */
  probe?: true | ProbeMode;
  /** 封顶帧数。计时趟不给就用 `PROBE_MAX_FRAMES`。 */
  maxFrames?: number;
}

export interface SetProjectOptions {
  /** full 项目整份替换 */
  reset?: boolean;
}
export interface SetRoleOptions {
  job?: BackJob;
}

/**
 * M7 生成快照的一帧(契约 `docs/plan/m7-contract.md` 第 4.3、4.4 节;D3 后台舞台里跑):父页先经 `pushProject('back', 隔离单卡工程, { reset })`
 * 把隔离单卡工程灌进后台舞台,再逐帧发这条。舞台把这一帧推到、生成快照、取本控件的 HTML,算 sha256、压 gzip,
 * 要小尺寸时按 `foreignObject` 栅格化成 WebP;字节经 `bake-frame` 事件随消息转移,回包只带摘要。
 *
 * 推帧口径:`mode: 'seq'`(缺省)—— 接着上一帧顺推,只有接不上时才从头推(探针 P2:对 DOM 独立卡与桌面 4 帧一批等价、便宜 4～7 倍);
 * `mode: 'batch4'` —— 与桌面预渲染一致,批起点按 4 帧对齐,每批从头推(重挂载、从挂载帧推到这一帧)。
 * 每帧生成快照前过就绪闸(控件异步活、字体、图片,同预渲染的 `waitFrameReady`),20 秒没就绪回 `not-ready`(这一段失败,不出空白帧)。帧间查后台活的停止标志(`setBackWork`),
 * 被门挡住的时长单记(`pausedMs`),不算进耗时。
 *
 * 要像素(`pixels`,`docs/plan/browser-stream-task.md` 第三处;浏览器节点产轨道流用):生成快照之后,照预渲染小尺寸那条路
 * (`bakeSmall.ts`:把快照包进 SVG `foreignObject`、内嵌页面样式表、画上画布)按**原尺寸**把 `rect` 这一块画出来,
 * 位图(`ImageBitmap`,带透明)随 `bake-frame` 事件转移给父页。`rect` 是包裹层自己的坐标(框的左上角是原点,可以为负:框外留给阴影、描边),
 * 就是轨道流的 `bound`。
 */
export interface BakeFrameRequest {
  /** 这一段的会话号(任务 id + 令牌),`bake-frame` 事件原样带回 */
  session: string;
  clipId: string;
  /** 本地帧号(隔离单卡工程里就是全局帧号) */
  localFrame: number;
  mode?: "batch4" | "seq";
  /** 要不要出预渲染小尺寸 */
  small?: boolean;
  /** 要像素:把这个矩形(包裹层坐标,整数,宽高为偶数)按原尺寸画成位图,随事件交给父页 */
  pixels?: { rect: BakePixelRect };
  /** 给 `false` 时事件不带 HTML 字节(只要像素的调用方省一次压缩与转移);`hash`、`bytes` 照给。缺省带 */
  html?: boolean;
  /**
   * 剪辑段里的卡(`clipId` 是摊平出来的虚拟片段,〔裁〕R02):隔离工程时间不平移,本地帧 n 是项目帧 `frameBase + n`
   * (`online/bakeTask.ts` 的 `bakeFrameBase`)。顶层的卡不给(本地帧就是全局帧)。
   */
  frameBase?: number;
}
/** `bakeFrame` 要像素时的矩形:包裹层自己的坐标(框的左上角是原点),单位是项目像素 */
export interface BakePixelRect { x: number; y: number; w: number; h: number }
export type BakeFrameReply =
  | { ok: true; localFrame: number; hash: string; bytes: number; small: { hash: string; bytes: number } | null; ms: number; pausedMs: number; remounted: boolean; smallMs: number; readyMs: number;
    /** 要了像素时:画这一张位图用的时间(毫秒) */
    pixelsMs?: number }
  | { ok: false; reason: "unsupported" | "role" | "no-project" | "no-clip" | "cancelled" | "lossy" | "no-control" | "frame-mismatch" | "small-failed" | "not-ready" | "pixels-failed"; detail?: string };
export interface SetRoleReply {
  ok: boolean;
  reason?: "unsupported";
}
/**
 * `play` / `pause` 共用的回包(K4)。第 3 步 `play` 的内联回包和 `PauseReply` 是两个形状,
 * R2 统一成这一个,**`ok` 不可选** —— 调用方先看 `ok` 再取别的字段,不用猜缺省值。
 *
 * 三种情况:
 *   - `{ ok: true, stoppedAt }`:停在这一秒(= 最后一拍的 `sec`)。不带 `atSec` 的立即停、
 *     带 `atSec` 的武装停到达、以及循环本来就停着(`ended` 之后 / 重复 `pause()`)都回它;
 *   - `{ ok: true, passed: true }`:武装停的那一拍**已经 post 过**(当前拍序号 ≥ `atSec` 的拍序号),
 *     不停 —— 否则永远等不到那一拍、RPC 永不回包;
 *   - `{ ok: false, reason }`:做不了。R2 的舞台还没有节拍循环(K4 是 R5 的活),
 *     `play` / `pause` 一律回 `{ ok: false, reason: 'unsupported' }`。
 */
export type PlayReply =
  | { ok: true; stoppedAt: number; passed?: undefined }
  | { ok: true; stoppedAt?: undefined; passed: true }
  | { ok: false; reason: string };

/** 舞台对父页暴露的方法(全部异步、带请求 id) */
export interface StageRpcApi {
  setProject(project: Project | ProjectPatch, opts?: SetProjectOptions): Promise<{ ok: true }>;
  setTime(tSec: number, opts?: SetTimeOptions): Promise<SetTimeReply>;
  render(tSec: number, opts?: RenderOptions): Promise<RenderReply>;
  hitTest(x: number, y: number): Promise<StageHit | null>;
  rectsWithBounds(opts?: RectsWithBoundsOptions): Promise<RectWithBounds[]>;
  size(): Promise<{ width: number; height: number }>;
  setProxy(on: boolean): Promise<{ ok: true }>;
  setRole(role: StageRole, opts?: SetRoleOptions): Promise<SetRoleReply>;
  /** K2 的分派表 + K1 的每卡记录(第 4 步用;第 3 步舞台只存起来) */
  setPlan(plan: { plan: unknown; costs: CardCostRecord[] }): Promise<{ ok: true }>;
  /** K4(R5):R2 的舞台还没有节拍循环,两个都回 { ok: false, reason: 'unsupported' } */
  play(fromSec: number): Promise<PlayReply>;
  pause(opts?: { atSec?: number }): Promise<PlayReply>;
  setSuppressed(clipIds: string[]): Promise<{ ok: true }>;
  /**
   * G1 / C3 的流平面(父页按就绪索引里 `kind: 'stream'` 的层合成)。元素的形状仍是 `{ clipIds }`,
   * R8 加了两个可选字段:`key`(流键)和 `ranges`(就绪的分段号闭区间)—— 舞台里的 `streamPlayer`
   * 凭它们去拉分段;不带 `key` 的平面只占位、不解码(R8 之前的调用方照旧只发 `clipIds`)。
   * 另带 `originFrame`:这条流自己的第一帧(项目帧号),分段从它起每 15 帧一段(`streamSegments.mjs`);
   * 舞台按它把这一拍的帧号换成分段号,不带它的平面同样只占位、不解码。
   * 依赖下层的流另带 `plane: "stage"`:只有目标卡一张,但按舞台坐标产,舞台把它的画布挂在舞台根下(同组流),不挂进包裹层。
   */
  setStreamPlanes(planes: StreamPlaneRequest[]): Promise<{ ok: true }>;
  setScrubbing(on: boolean): Promise<{ ok: true }>;
  setPlaying(on: boolean): Promise<{ ok: true }>;
  setMediaT(tSec: number): Promise<{ ok: true }>;
  setLocalHashes(hashes: string[]): Promise<{ ok: true }>;
  /**
   * c10a 第 8 节:舞台这一侧的取档策略(`mediaTier.ts` 的 `setMediaTierPolicy`)。父页握手后发一次,
   * 票据续签、素材闸门的结果变了(网速快慢切换、解码上限调低)时再发。缺省(不发)= 桌面运行环境。
   */
  setMediaPolicy(policy: StageMediaPolicy): Promise<{ ok: true }>;
  /**
   * 在线页面:换 canvas 卡的 WebGL 渲染路线(舞台闸门试第三级「两个舞台各一套渲染器」时父页发 `perDocument`)。
   * 舞台原地换(`glHost.setRoute`),不重建舞台。回包时新路线已经生效。桌面运行环境不发(路线跟项目选项走)。
   */
  setGlRoute(route: "perDocument" | "shared"): Promise<{ ok: true; route: "perDocument" | "shared"; mode: string }>;
  /**
   * C10 契约第 9 节「识别」:在线页面从内容库卡片源码里认出的用户卡(本机没有它们的代码,「已知但本机不能运行」)。
   * 父页握手后发一次,表变了再发;舞台写进自己的注册表(`registry.setSyncedUserCards`)。只在线页面发,桌面运行环境不发。
   */
  setSyncedUserCards(entries: { id: string; name: string; source?: string }[]): Promise<{ ok: true; changed: boolean }>;
  /**
   * 父页此刻的预览缩放倍数(舞台 iframe 被 CSS `scale` 缩到预览框的那个数)。舞台的占位符按它补偿(`placeholderFit.ts`):
   * 沙漏在屏幕上保持原大小(只抵消预览缩放)。
   * 父页握手后发一次,倍数变了再发;桌面与在线都发。
   */
  setViewScale(scale: number): Promise<{ ok: true }>;
  /** A3c:patch 是相对上次投递的增量,null = 摘掉;reset = 先清空全部再应用 */
  setSnapshots(patch: Record<string, string | null>, opts?: { reset?: boolean }): Promise<{ ok: true; bytes: number }>;
  /**
   * 单舞台「停下追当前一帧」(`settleFrame.ts`):只有一个舞台时,暂停、点击或拖动松开、播放到头之后
   * (`setTime` 之后)父页发它。舞台把当前这一帧的所有卡活渲一次(重卡也画),画好一层撤掉兜底、换上活渲一层;
   * 不设时限(`timeoutMs` 只给测试与诊断)。回包在全部画好之后才回。
   * 新的 `setTime` / `play` / `setProject` / `setRole` 打断它(回 `ok: false, reason: 'superseded'`)。
   */
  settleLayers(tSec: number, opts?: { timeoutMs?: number | null }): Promise<SettleResult>;
  /**
   * 后台活的开始 / 停止(C10 契约第 2 节「后台舞台的摆放与节拍」):后台舞台 `opacity: 0` 原位叠放,舞台里的
   * `requestIdleCallback` 不可靠,由编辑器页判空闲(页面可见、父页 rAF 间隔不持续超过 500 ms、父页自己的 rIC 在回调)
   * 经这条 RPC 发开始、停止。舞台逐帧用 `setTimeout(0)` 推进,帧与帧之间查停止标志,停着就等,不丢活。
   * 缺省(不发)= 开着(桌面运行环境)。
   */
  setBackWork(on: boolean): Promise<{ ok: true }>;
  /** M7:生成快照的一帧(见 `BakeFrameRequest`);只在在线构建的后台舞台上做,别处回 `unsupported` */
  bakeFrame(req: BakeFrameRequest): Promise<BakeFrameReply>;
  /** M7:停掉正在推的那一帧(帧边界停;在飞的 `bakeFrame` 回 `cancelled`),清掉顺推的接续点 */
  bakeCancel(): Promise<{ ok: true }>;
  /**
   * 在线执行同步来的用户卡与素材效果卡(`docs/plan/online-card-exec-contract.md` 第 2、8 节):编辑页面把转译好的包(全量)发给舞台。
   * 包里只有转译结果(`src/online/cardRuntime/protocol.ts` 的 `CardBundle`),**不带任何凭证或票据**。舞台先记下,
   * 自己的执行闸门开着才执行(`online/isolation/execGate.ts`;画面不另要求出口拦截),闸门晚开就到时再执行;载入结果经
   * `card-states` 事件报回。`opts.sound`:这一台同时起声音线程(舞台实例 B;线程跟实例走,不跟角色走),结果经 `sound-state` 事件报回。
   * 桌面运行环境、同源单舞台回 `{ ok: false }`。
   */
  loadUserCards(bundles: unknown[], opts?: { sound?: boolean }): Promise<LoadUserCardsReply>;
  /**
   * 同步来的用户卡与素材效果卡的声音(契约 3.5):在这一台舞台起的声音线程里求一块采样。请求的形状见
   * `src/online/cardRuntime/stageSound.ts` 的 `StageSoundRequest`。没有声音线程(没起、闸门关着)就抛错。
   */
  synthCardAudio(request: StageSoundRpcRequest): Promise<Float32Array>;
}

export interface LoadUserCardsReply {
  ok: boolean;
  /** `ok` 为假时:`unsupported` = 这份文档不执行(桌面、同源单舞台);`gate` = 闸门还关着(包已记下,闸门开了自动执行) */
  reason?: "unsupported" | "gate";
}

export interface StageSoundRpcRequest {
  projectKey: string;
  project?: unknown;
  nodeId: string;
  start: number;
  count: number;
  sampleRate: number;
}

/** 这一台舞台的图形能力(契约 4.3):`ok` 能跑素材效果卡;其余是不够的原因;`unknown` = 还没判(还没挂过素材效果卡) */
export type StageGraphCapability = "unknown" | "ok" | "no-webgl2" | "software" | "texture" | "context-lost";

export type StageEvent =
  | { type: "mediaReady"; sec: number }
  | { type: "frame"; sec: number }
  | { type: "ended"; sec: number }
  | { type: "settled"; sec: number; clipIds: string[] }
  /**
   * K1 的一条成绩。只报**测量值** —— `device` / `measuredAt` / `mode` / `demoted` 由父页补齐
   * 后整条 PUT(任务书 3.3)。四个数分开报(3.8):`stepMs` 是活渲单帧最差、唯一进判重的数;
   * `inlineMs` / `rasterMs` / `serializeMs` 是生成快照那三段各自的单帧最差,只排产能。
   * 旧的 `frameMs`(含生成快照的单帧最差)已删,不留兼容。
   */
  | { type: "probe"; identityKey: string; fps: number; stepMs: number; inlineMs: number; rasterMs: number; serializeMs: number; catchUpMs: number; capped?: boolean; kind: "random" | "stepped"; vtOk?: boolean; seekOk?: boolean; seekMs?: number | null }
  | { type: "demote"; clipId: string }
  /**
   * K1 探针推过的一帧。跨源的在线舞台(C10 契约第 2 节「大块产出压成可转移的 ArrayBuffer」)不直接传大字符串:
   * `html` 为空串,改在 `htmlGz` 里交 gzip 压过的字节(随 postMessage 转移,不拷贝),父页用 `probeFrameHtml` 解开。
   */
  | { type: "probe-frame"; clipId: string; localFrame: number; html: string; htmlGz?: ArrayBuffer }
  /**
   * M7 生成快照的一帧(`bakeFrame` 的产出,契约第 4.3 节):`hash` 是原始 HTML 字节的 sha256(舞台里 WebCrypto 算),
   * `htmlGz` 是 gzip 压过的 HTML(压不了时 `htmlRaw` 给原始字节),`small` 是预渲染小尺寸 WebP;字节都随消息转移。
   * 要了像素(`BakeFrameRequest.pixels`)时另带 `pixels`:`rect` 这一块按原尺寸画出来的位图(随消息转移;收的一方用完要 `close()`)。
   */
  | { type: "bake-frame"; session: string; clipId: string; localFrame: number; hash: string; bytes: number; htmlGz?: ArrayBuffer; htmlRaw?: ArrayBuffer;
    small?: { hash: string; bytes: number; webp: ArrayBuffer } | null;
    pixels?: { rect: BakePixelRect; bitmap: ImageBitmap } | null }
  /**
   * 在线执行用户卡与素材效果卡:这一台舞台里每张同步卡的运行状态(整份;卡片 id → 状态,契约第 8 节),连同这一台的图形能力
   * 与「画面那一半在这一台执行不执行」。两台都发(不分角色);父页当不可信输入收(`online/stageMessageGuard.ts`)。
   */
  | { type: "card-states"; states: [string, CardRunState][]; graph: StageGraphCapability; visual: boolean }
  /**
   * 素材闸门的网速(在线页面的舞台看素材实际下载的快慢,`render/netSpeed.ts`):先拉小尺寸还是只拉原尺寸变了时报一次,父页记进查看口。
   */
  | { type: "net-speed"; mbps: number | null; samples: number; smallFirst: boolean }
  /** 声音线程的状态(形状同 `src/online/cardRuntime/stageSound.ts` 的 `StageSoundState`);`state: null` = 这一台没有声音线程了 */
  | { type: "sound-state"; state: { ready: Record<string, string>; blocked: Record<string, string> } | null };

export const STAGE_EVENT_TYPES = new Set<StageEvent["type"]>(["mediaReady", "frame", "ended", "settled", "probe", "demote", "probe-frame", "bake-frame", "card-states", "sound-state"]);
/** 不分角色、两台舞台都会发的事件:父页在各自的 RPC 客户端上直接听,不经 `stageBridge` 的按角色过滤 */
export const STAGE_ANY_ROLE_EVENTS = new Set<StageEvent["type"]>(["card-states", "sound-state"]);

/**
 * 每种事件**只认哪个角色**发来的(E0 末条:父页按 `event.source` 过滤来源)。
 *
 * `frame` / `ended` / `settled` / `demote` 是播放器舞台的事,只认当前 `front` 那个 iframe;
 * `mediaReady` / `probe` / `probe-frame` 是后台舞台的事,只认当前 `back` 的。
 * **不过滤就会重复 `tick`**:K5 的角色互换那一拍两个舞台都可能 post
 * (旧 `front` 走完本拍才停,新 `front` 已经开始报 `frame`)。
 *
 * 过滤落在 `stageBridge.ts` 的 `onStageEvent`:只有那里同时知道「哪个客户端」和
 * 「它此刻是什么角色」。`createStageRpc` 那一层的 `e.source !== target` 只解决前半个问题。
 */
const FRONT_EVENT_TYPES = new Set<StageEvent["type"]>(["frame", "ended", "settled", "demote"]);

/** 这种事件该由哪个角色的舞台发出来 */
export function stageEventRole(type: StageEvent["type"]): StageRole {
  return FRONT_EVENT_TYPES.has(type) ? "front" : "back";
}

interface RpcRequest {
  type: "pc-rpc";
  id: number;
  method: keyof StageRpcApi;
  args: unknown[];
}
interface RpcReply {
  type: "pc-rpc-reply";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export const isRpcRequest = (d: unknown): d is RpcRequest => !!d && typeof d === "object" && (d as RpcRequest).type === "pc-rpc" && typeof (d as RpcRequest).id === "number";
export const isRpcReply = (d: unknown): d is RpcReply => !!d && typeof d === "object" && (d as RpcReply).type === "pc-rpc-reply" && typeof (d as RpcReply).id === "number";
export const isStageEvent = (d: unknown): d is StageEvent => !!d && typeof d === "object" && STAGE_EVENT_TYPES.has((d as StageEvent).type);

export interface StageRpcClient extends StageRpcApi {
  /** 这个客户端绑的 iframe 窗口 */
  readonly target: Window;
  /** 订阅舞台事件(只收这个 iframe 发来的) */
  onEvent(listener: (e: StageEvent) => void): () => void;
  /** iframe 换了 / 卸了:挂着的请求全部按 detached 回绝,不再收消息 */
  dispose(): void;
  readonly disposed: boolean;
}

const METHODS: (keyof StageRpcApi)[] = ["setProject", "setTime", "render", "hitTest", "rectsWithBounds", "size", "setProxy", "setRole", "setPlan",
  "play", "pause", "setSuppressed", "setStreamPlanes", "setScrubbing", "setPlaying", "setMediaT", "setLocalHashes", "setSnapshots", "setMediaPolicy",
  "setSyncedUserCards", "setViewScale", "settleLayers", "setGlRoute", "setBackWork", "bakeFrame", "bakeCancel", "loadUserCards", "synthCardAudio"];

/**
 * 有请求挂着时,每隔这么久看一眼目标窗口还在不在。
 *
 * **为什么要有它**:iframe 从 DOM 里拿掉之后,发给它的 `postMessage` 被浏览器**静默丢弃**,
 * 不抛错、也永远没有回包;而 `call()` 一般不设超时(`render` / 武装停的 `pause` 本来就可能等很久,
 * 一刀切的超时会误杀它们;例外见 STAGE_UPDATE_TIMEOUT_MS)。以前唯一的出路是等下一次 `pc-stage-ready` 来 `dispose()` ——
 * 3D 页卸掉舞台 iframe 那一次,`play()` 就这样挂了一分钟,播放头纹丝不动。
 * 窗口关了就不可能再回包,所以按「关了」判比按时长判准:活着的慢请求一个都不误杀。
 */
export const CLOSED_POLL_MS = 1000;
/**
 * 例外:`setSnapshots` 与不带 `probe` 的 `setTime` 在舞台里是同步做完的短更新,活着的窗口也可能丢回包
 * (舞台 iframe 原地重载时 `contentWindow` 不变、`closed` 一直为假,新文档不认旧的请求号)。
 * 这两种按时长判:过了这么久没回包就拒绝,由调用方作废投递基线后重投(C10a)。
 * 带 `probe` 的 `setTime` 要等严格 beat 与任务边界,重卡在忙机器上可能很久,仍不设时限。
 */
export const STAGE_UPDATE_TIMEOUT_MS = 8000;
/**
 * 带时限的调用(`synthCardAudio`、给了时限的 `settleLayers`)舞台在时限之内一定回包;活着的窗口原地重载会丢回包,
 * 所以父页这边按「它的时限 + 这么多」判超时。不设时限的 `settleLayers` 按 `SETTLE_RPC_CAP_MS` 判。
 */
export const STAGE_RPC_SLACK_MS = 3000;
/**
 * M7 生成快照的一帧最长等多久回包:活着的窗口原地重载会丢回包(同 `STAGE_UPDATE_TIMEOUT_MS` 的理由),父页要能放手。
 * 被后台活的门挡住的时间也算在内,所以给得宽;真超时按可重试失败交回。
 */
export const BAKE_FRAME_TIMEOUT_MS = 120_000;
/** 这次调用按时长判超时的话,等多久(毫秒);不按时长判回 null */
export function stageCallTimeoutMs(method: string, args: unknown[]): number | null {
  if (method === "bakeFrame") return BAKE_FRAME_TIMEOUT_MS;
  if (method === "loadUserCards") return STAGE_UPDATE_TIMEOUT_MS;
  if (method === "synthCardAudio") {
    // 声音线程自己有时限(每秒声音 2 秒墙钟、最少 10 秒,另加载入卡片的 20 秒);活着的窗口原地重载会丢回包,父页按它的时限再宽一点判超时
    const r = args[0] as { count?: unknown; sampleRate?: unknown } | undefined;
    const sec = Number(r?.count) / Math.max(1, Number(r?.sampleRate) || 48_000);
    return Math.max(10_000, Math.ceil((Number.isFinite(sec) ? sec : 0) * 2000)) + 20_000 + STAGE_RPC_SLACK_MS;
  }
  if (method === "settleLayers") {
    const ms = Number((args[1] as { timeoutMs?: unknown } | undefined)?.timeoutMs);
    return Number.isFinite(ms) && ms > 0 ? Math.min(ms, SETTLE_MAX_MS) + STAGE_RPC_SLACK_MS : SETTLE_RPC_CAP_MS;
  }
  if (method === "setGlRoute") return STAGE_UPDATE_TIMEOUT_MS;
  return isShortStageUpdate(method, args) ? STAGE_UPDATE_TIMEOUT_MS : null;
}
/** 按时长判的调用(见 STAGE_UPDATE_TIMEOUT_MS) */
export function isShortStageUpdate(method: string, args: unknown[]): boolean {
  if (method === "setSnapshots") return true;
  if (method !== "setTime") return false;
  const opts = args[1] as { probe?: unknown } | undefined;
  return !opts?.probe;
}

/**
 * 父页侧:给一个舞台 iframe 建一个 RPC 客户端。
 * `targetOrigin` 现在是 `location.origin`(同源);第 4 步 E1 跨源时传舞台端口的 origin。
 *
 * `opts.untrusted`(在线的跨源舞台,契约 `online-card-exec-contract.md` 第 3.2 节):舞台里会执行用户卡与素材效果卡,它发来的一切当不可信输入 ——
 * 只认 `event.origin` 等于 `targetOrigin` 的消息;事件与回包按形状校验、数字钳到合理范围(`online/stageMessageGuard.ts`;
 * `opts.maxSec` 给了就把事件里的时刻钳到它以内,一般是项目时长),
 * 不合形状的事件丢弃、回包按失败回绝。不给(桌面运行环境、同源单舞台)照旧,一个字节不变。
 */
export function createStageRpc(target: Window, targetOrigin: string = location.origin, opts: { untrusted?: boolean; maxSec?: () => number } = {}): StageRpcClient {
  const untrusted = opts.untrusted === true;
  let nextId = 1;
  let disposed = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string; timer?: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(e: StageEvent) => void>();
  const onMessage = (e: MessageEvent) => {
    if (e.source !== target) return;
    if (untrusted && e.origin !== targetOrigin) return;
    const d = e.data;
    if (isRpcReply(d)) {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (p.timer) clearTimeout(p.timer);
      if (untrusted) {
        if (d.ok !== true) { p.reject(new Error(sanitizeRpcError(d.error) || `stage rpc ${p.method} failed`)); return; }
        let result: unknown;
        try { result = sanitizeRpcResult(p.method, d.result); } catch (err) { p.reject(err instanceof Error ? err : new Error(String(err))); return; }
        p.resolve(result);
        return;
      }
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || `stage rpc ${p.method} failed`));
      return;
    }
    if (untrusted) {
      const clean = sanitizeStageEvent(d, { maxSec: opts.maxSec?.() }) as StageEvent | null;
      if (clean) for (const l of listeners) l(clean);
      return;
    }
    if (isStageEvent(d)) for (const l of listeners) l(d);
  };
  window.addEventListener("message", onMessage);
  /** 窗口关了没有。`closed` 读不到(极老的宿主 / 测试替身)时当作还开着,退回旧行为 */
  const targetClosed = () => { try { return target.closed === true; } catch { return false; } };
  /** 挂着请求时才转的巡检(见 CLOSED_POLL_MS);窗口一关就整个客户端按 detached 收摊 */
  let poll: ReturnType<typeof setInterval> | null = null;
  const stopPoll = () => { if (poll !== null) { clearInterval(poll); poll = null; } };
  const startPoll = () => {
    if (poll !== null) return;
    poll = setInterval(() => {
      if (!pending.size) stopPoll();
      else if (targetClosed()) client.dispose();
    }, CLOSED_POLL_MS);
  };
  const call = (method: keyof StageRpcApi, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      // 窗口已经关了:和 dispose 之后同一套回法,别把请求发进一个不会回包的窗口
      if (!disposed && targetClosed()) client.dispose();
      if (disposed) {
        if (method === "render") resolve({ aborted: true, reason: "detached" });
        else reject(new Error("stage rpc: detached"));
        return;
      }
      const id = nextId++;
      const waitMs = stageCallTimeoutMs(method, args);
      const timer = waitMs !== null ? setTimeout(() => {
        pending.delete(id);
        reject(new Error(`stage rpc ${method}: timed out`));
      }, waitMs) : undefined;
      pending.set(id, { resolve, reject, method, timer });
      const msg: RpcRequest = { type: "pc-rpc", id, method, args };
      try {
        target.postMessage(msg, targetOrigin);
      } catch (err) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      startPoll();
    });
  const client = {
    target,
    get disposed() { return disposed; },
    onEvent(listener: (e: StageEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopPoll();
      window.removeEventListener("message", onMessage);
      for (const [id, p] of pending) {
        pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        if (p.method === "render") p.resolve({ aborted: true, reason: "detached" });
        else p.reject(new Error("stage rpc: detached"));
      }
      listeners.clear();
    },
  } as StageRpcClient;
  for (const m of METHODS) (client as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => call(m, args);
  return client;
}

/**
 * 舞台侧:把方法表挂到 message 上。每个方法可以返回值或 Promise;抛错就回 `{ ok: false, error }`。
 * 只认 `window.parent` 发来的请求;回包发回 `event.source`(它就是父页)。
 */
export function serveStageRpc(api: StageRpcApi, opts: { parentOrigin?: string } = {}): () => void {
  const onMessage = (e: MessageEvent) => {
    const d = e.data;
    if (!isRpcRequest(d)) return;
    if (e.source !== window.parent) return;
    const reply = (r: RpcReply) => {
      try {
        (e.source as Window | null)?.postMessage(r, opts.parentOrigin ?? (e.origin && e.origin !== "null" ? e.origin : "*"));
      } catch (err) {
        console.error("[stage rpc] reply failed", err);
      }
    };
    const fn = (api as unknown as Record<string, unknown>)[d.method];
    if (typeof fn !== "function") {
      reply({ type: "pc-rpc-reply", id: d.id, ok: false, error: `unknown method ${String(d.method)}` });
      return;
    }
    let out: unknown;
    try {
      out = (fn as (...a: unknown[]) => unknown).apply(api, d.args);
    } catch (err) {
      reply({ type: "pc-rpc-reply", id: d.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    Promise.resolve(out).then(
      (result) => reply({ type: "pc-rpc-reply", id: d.id, ok: true, result }),
      (err) => reply({ type: "pc-rpc-reply", id: d.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

/** 舞台侧:向父页发一条事件(七种之一)。`transfer` 里的 ArrayBuffer 随消息转移(不拷贝,发完本侧就不能再用) */
export function postStageEvent(e: StageEvent, parentOrigin = "*", transfer: Transferable[] = []): void {
  if (transfer.length) window.parent?.postMessage(e, parentOrigin, transfer);
  else window.parent?.postMessage(e, parentOrigin);
}

/** 舞台侧:把一帧 HTML 快照压成可转移的字节(gzip);浏览器没有 `CompressionStream` 时回 null(调用方照旧传字符串) */
export async function compressHtml(html: string): Promise<ArrayBuffer | null> {
  const CS = (globalThis as { CompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).CompressionStream;
  if (!CS || typeof Blob === "undefined") return null;
  try {
    const stream = new Blob([html]).stream().pipeThrough(new CS("gzip"));
    return await new Response(stream).arrayBuffer();
  } catch {
    return null;
  }
}

/** 父页侧:取出 `probe-frame` 的 HTML(带 `htmlGz` 的先解压) */
export async function probeFrameHtml(e: { html: string; htmlGz?: ArrayBuffer }): Promise<string> {
  if (!e.htmlGz) return e.html;
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) return e.html;
  const stream = new Blob([e.htmlGz]).stream().pipeThrough(new DS("gzip"));
  return await new Response(stream).text();
}

/** 舞台侧:握手(带宿主能力表,J4) */
export function postStageReady(hostCapabilities: HostCapabilities, parentOrigin = "*"): void {
  const msg: StageReadyMessage = { type: "pc-stage-ready", hostCapabilities };
  window.parent?.postMessage(msg, parentOrigin);
}

/**
 * 舞台侧:卡片热更新接住、按新卡重渲之后告诉父页「换到 `stamp` 这一版了」(C6.6 集成 3b,`editor/stageCards.ts`)。
 * 和 `pc-stage-ready` 一样是握手类消息,不是 `StageEvent`。
 */
export interface StageCardsMessage {
  type: "pc-stage-cards";
  stamp: number;
}
/**
 * `setMediaPolicy` 的实参:素材闸门的结果(最低一档只用小尺寸、解码上限、网速慢先小后大)、在线浏览器模式的远程素材服务(基址与只读票据)。
 *
 * 隔离的跨源舞台(契约 `online-card-exec-contract.md` 第 4.1 节):`remote.base` 是舞台自己源上的 `/media-s/<sid>`、`remote.ticket` 恒为 null
 * (票据由编辑器页交给舞台源的服务端换成 HttpOnly cookie,不进舞台的脚本);`cardExec` 为真 = 父页点头,这一台可以执行用户卡与素材效果卡
 * (舞台自己还要核自检与「本文档没见过票据」,`online/isolation/execGate.ts`)。旧办法(没隔离的舞台)照旧带票据、不带 `cardExec`。
 */
export interface StageMediaPolicy {
  /** 最低一档:视频素材只用小尺寸 */
  smallOnly: boolean;
  /** 素材闸门的解码上限(宽 × 高的像素数);超过的视频素材只用小尺寸。不给 / null = 不限 */
  decodeMaxPixels?: number | null;
  /** 素材闸门的网速:慢 —— 先拉小尺寸显示,再拉原尺寸替换 */
  smallFirst?: boolean;
  remote: { base: string; ticket: string | null } | null;
  cardExec?: boolean;
}

export function postStageCards(stamp: number, parentOrigin = "*"): void {
  const msg: StageCardsMessage = { type: "pc-stage-cards", stamp };
  window.parent?.postMessage(msg, parentOrigin);
}

/**
 * 舞台侧:按 J4 探测宿主能力。`prerender` 与 `stageId` 来自父页写在 src 查询串里的值。
 * `online`:在线浏览器模式(`src/online/mode.ts` 的 `ONLINE`),由调用方传 —— 本文件不读编译期常量,单测里没有它。
 */
export function detectHostCapabilities({ online = false }: { online?: boolean } = {}): HostCapabilities {
  const q = new URLSearchParams(location.search);
  const ua = navigator.userAgent;
  const safari = /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua);
  let offscreenGl = false;
  try {
    // 主线程上的近似:Worker 里的 OffscreenCanvas webgl2 与主线程同源同能力(Safari 17 之前 Worker 里没有 WebGL)。
    // 真正决定走不走 Worker 的是 glHost 在 Worker 里的实测(R9 M2);这里只给 `device` 串和父页选路线用。
    const probe = typeof OffscreenCanvas !== "undefined" && typeof Worker !== "undefined" ? new OffscreenCanvas(1, 1).getContext("webgl2") : null;
    offscreenGl = !!probe && !(safari && !/Version\/(1[7-9]|[2-9]\d)/.test(ua));
    // 探完立刻放掉:验收要「舞台主线程 0 个活的 WebGL 上下文」(R9),这一个不能留着等 GC
    probe?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    offscreenGl = false;
  }
  // `?glOffscreen=0`:把探测强制为 false(R9 验收「能力退路」;glHost 读同一个开关走主线程)
  if (q.get("glOffscreen") === "0") offscreenGl = false;
  /*
   * 在线页面:父页按舞台闸门在 src 里给起手的路线(`gl=`)、只有一个舞台(`compact=1`)、最低一档(`lowest=1`)。
   * 跨源舞台读不到编辑器页那个源的页面本地存储(崩溃记录、闸门结果都在那边),照父页给的走;桌面运行环境不看这几项。
   */
  const gl = q.get("gl");
  const glRoute = online && (gl === "perDocument" || gl === "shared") ? gl : null;
  const compact = online && q.get("compact") === "1";
  const lowest = online && q.get("lowest") === "1";
  // C10 契约第 2 节:开了后台舞台(父页给 `dual=1`),就照实报能测量、能追活渲
  const backStage = q.get("dual") === "1";
  return {
    prerender: q.get("prerender") === "1",
    offscreenGl,
    compact,
    glRoute,
    lowest,
    measure: backStage,
    catchUp: backStage,
    // stageId **只是实例名,和角色无关**(E1):两个 iframe 是 `A` / `B`,谁是 front / back
    // 只经 setRole 定。缺省给 `A` 而不是 `front`,免得又把实例名读成角色名。
    stageId: q.get("id") || "A",
  };
}

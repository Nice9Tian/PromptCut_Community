/**
 * 在线页面的纯浏览器渲染节点(M7 契约 `docs/plan/m7-contract.md` 第 2、4、5、7 节;第 13 节裁定 D6、D8、D10、D14、D16)。
 *
 * 本模块只有编排与判据,不碰舞台、网络、存储、界面:它们由宿主(`src/editor/browserNodeHost.ts`)经 `deps` 注入。
 * 节点会话(认领、续约、放回、丢认领)用渲染节点同一份状态机 `server/render-node/session.mjs`;细任务的执行规矩(先报 0、去重、
 * 推完才完成、丢认领丢结果)用桌面同一份 `server/render-node/task-runner.mjs`(D11 (a));本页只在它的 `render` 里管帧与让路。
 *
 * # 当节点的条件(`browserNodeEligibility`,第 2 节)
 *
 * 在线构建、嵌了代码版本(D16:开发构建不当)、身份是电脑(手机不当)、不是最低一档、两个跨源舞台都握上手、Chromium 内核(D14)、以成员身份连着云端项目、
 * 打开项目的测量已落定 —— 全部成立才当。纯函数,不读编译期常量(Node 单测直接载它)。
 *
 * # 报到(D10 页面侧)
 *
 * `node.hello { profile: 'browser', maxConcurrent: 1, environment }`:只报原始值(`pageEnvironment()`),不报指纹;
 * 指纹由文档服务按原始值算、在 `node.welcome.envFingerprint` 回来,节点记下它(节点侧过滤按它比任务的指纹),
 * 并交给宿主(清单计划的 `input.browser` 要它,第 3.3 节)。`queue.watch` 只列本项目(队列不许纯浏览器 watch `'all'`)。
 *
 * # 用户卡与素材效果卡(块 N,`docs/plan/online-card-exec-contract.md` 第 7 节)
 *
 * 本页能执行同步来的用户卡与素材效果卡时(`deps.cardInfo()` 回登记处的内容,`nodeCardInfo.ts`):
 *   - `node.hello` 多报一项 `cardRuntime`(在线卡片运行时版本,原始值;指纹仍由文档服务算);
 *   - 文档服务在 `node.welcome` 多回 `cardEnvFingerprint`(环境三项再加运行时版本),节点记下:用户卡、素材效果卡的任务用它比指纹
 *     (`filter.mjs` 规则 1),内置卡的任务照旧比 `envFingerprint`;
 *   - 能力位 `capabilities.userCards` / `graphCards` 与 `cardSourceVersions`(每张本页已载入成功的卡的代码身份)随登记处实时更新,
 *     节点侧过滤(规则 1、3)据此认领;换代后一小段时间不报(登记处的 `NODE_CARD_SETTLE_MS`)。
 * 运行时版本在报到之后才变得可报(闸门晚于报到才立起来)时,重发一次 `node.hello`(带手里的认领接续)。不能执行时与原来完全相同。
 *
 * # 一段细任务(第 4 节)
 *
 *   认领到 → `progress(0)`(停滞规则要覆盖卡死的执行器)→ 去重(给了 `lookupResult`:内容库清单在、块都在就直接 complete)
 *   → 取项目:任务的 `projectRev` 那一版,先用发布时留存的(`keptProject`),没有再 `fetchSnapshot`,都没有就放回
 *     (`reason: 'no-snapshot'`),不拿别的版本渲(D6)
 *   → 逐帧 `bakeFrame`(后台舞台生成快照、推素材服务、进页面内快照库都在宿主那一侧),每帧 `progress(已做帧数)`
 *   → 全段齐后 `finishTask`(组清单、写内容库)→ `task.complete { ranges, ...清单 }`。
 *
 * 已做的帧按任务 id 留在本页:让路放回后重新认领到同一段只补缺的帧(第 2 节「让路」)。
 *
 * # 一段流任务(`docs/plan/browser-stream-task.md` 第四处)
 *
 * 宿主报了能压流(`deps.streams()`,按 `probeStreamEncoder` 探的结果)才把能力位 `capabilities.streams` 报成真;切分方给浏览器出的
 * 单卡流那一份(`kind: 'stream'`,`input.stream`、`input.bake`)照快照任务同一套规矩走:先报 0、去重、取任务那一版的项目,
 * 然后整段交给宿主的 `bakeStream`(按 `input.bake` 建隔离单卡工程、逐帧向舞台要像素、送编码器、分段推素材服务),
 * 全部分段齐了由 `finishStream` 写内容库的流清单,`task.complete { ranges, ...清单 }`。
 * 帧号怎么换算(`streamTaskFrames`)、清单长什么样(`streamManifest`,与桌面 `collectStreamResult` 逐字段同形)是这里的纯函数。
 * 让路:宿主每帧前问 `yielding()`,当前这一帧做完就停手、回 `{ yielded: true }`,节点放回(已推完的分段留在宿主那一侧,
 * 重新认领同一段只补缺的分段);页面隐藏、丢认领照旧中止(`signal`)。
 *
 * # 让路(D8,`yieldFor`)
 *
 * - `play` / `drag` / `urgent`(播放、拖动开始,更急的后台活来了):不再认领;当前这一帧做完就 `task.release`(不计失败,C2),
 *   不再生成下一帧。手里没有在做的帧(还在取项目、查去重)就立即放回。
 * - `hidden`(页面隐藏、父页 rAF 断档):不等当前帧,中止它(`signal`)并立即放回;迟到的结果丢掉。
 * 让路之后认不认领由宿主的 `isIdle()` 定(不在播放、不在拖动、离上一次交互过了安静期……)。
 *
 * # 报忙(M7 D2 补充〔裁〕,`claude/queue-maint`)
 *
 * 队列锁闲置超 30 s 会被切分方接手(D2)。页面锁着一张卡、手里却在做别的(生成别的卡的快照,或后台舞台在测量、补跑)时,
 * 那张卡没有产出,但页面没走。`node.welcome` 带 `activeIntervalMs`(新队列)时,节点在这种时候按这个间隔发
 * `node.active { busy }`(`busy`:手里有认领为 `'bake'`,否则问宿主的 `busy()`,如 `'stage'`);队列据此不把它锁着的卡判闲置。
 * 闲着、页面隐藏、只是在播放或拖动而后台没活时不发:这些时候锁照旧按产出算闲置。旧队列不带 `activeIntervalMs`,一条也不发。
 *
 * # 丢认领
 *
 * `task.lease-lost`、`node.welcome.lost`:中止这次生成快照、丢弃结果;已推的块不回收(按内容寻址,下一个认领者去重用得上)。
 *
 * # 诊断(第 7 节)
 *
 * `debug()`:状态(`off` / `idle` / `busy` / `baking`)与原因、`nodeId`、`envFingerprint`、`codeVersion`、持有的任务;
 * 计数(认领、完成、去重、放回按原因、失败、丢认领、生成快照帧数与每帧耗时 p50 / p95、被节点侧过滤挡掉的任务按原因);最近一次错误。
 *
 * 本模块属于 render 这一层(`src/online/`):不引 editor,不引 `mode.ts`。
 */
import { isStreamOrigin, STREAM_SEGMENT_FRAMES as SEGMENT_FRAMES_SHARED, streamSegmentFirstFrame, streamSegmentLastFrame } from "../render/streamSegments.mjs";
import { streamBucketManifest, streamBucketRanges, streamLastSegmentOf } from "../render/streamBuckets.mjs";
// @ts-expect-error 无类型声明的 .mjs(浏览器与 Node 通用,纯逻辑)
import { createNodeSession as createNodeSessionUntyped } from "../../server/render-node/session.mjs";
// @ts-expect-error 无类型声明的 .mjs(纯函数)
import { checkClaimable as checkClaimableUntyped } from "../../server/render-node/filter.mjs";
// @ts-expect-error 无类型声明的 .mjs(同构:细任务的执行规矩,桌面与页面共用,D11)
import { createTaskRunner as createTaskRunnerUntyped, ABORTED as ABORTED_UNTYPED } from "../../server/render-node/task-runner.mjs";

/* ------------------------------------------------------------------ 当节点的条件 */

/**
 * UA 是不是 Chromium 内核(D14)。认 `Chrome/<数>`、`Chromium/<数>`、`HeadlessChrome/<数>`(Edge、Opera 等 Chromium 系都带);
 * iOS 上的 Chrome / Firefox / Edge(`CriOS`、`FxiOS`、`EdgiOS`)是 WebKit,Firefox 带 `Firefox/`,都不算。
 * 与文档服务一侧的判法相同(那边挡住不诚实的页面,这边让诚实的页面干脆不开连接)。
 */
export function isChromiumUserAgent(userAgent: unknown): boolean {
  const ua = String(userAgent ?? "");
  if (/\b(?:CriOS|FxiOS|EdgiOS)\//.test(ua) || /\bFirefox\//.test(ua)) return false;
  return /\b(?:HeadlessChrome|Chrome|Chromium)\/\d+/.test(ua);
}

export interface EligibilityInput {
  /** 在线构建(`src/online/mode.ts` 的 `ONLINE`,由调用方传) */
  online: boolean;
  /** 在线构建嵌的代码版本(`buildInfo.ts` 的 `CODE_VERSION`);开发构建为空 */
  codeVersion: string | null | undefined;
  /** 身份为手机(`onlineTier.ts`;语义 `product/platforms.md`「身份」:手机不当渲染节点) */
  phone: boolean;
  /** 最低一档(基准卡都跑不动或一个舞台都撑不住):不当节点,也不为本页产流 */
  lowest: boolean;
  /** 两个跨源舞台都握上手为 `'dual'`;只有一个舞台(舞台闸门第一级、握手失败退回)为 `'single'` */
  /** `pending`:按两个舞台开、还没都握上手(舞台闸门在试后台舞台);不当节点,也不按只有一个舞台算 */
  stageLayout: "dual" | "single" | "pending";
  userAgent: string;
  /** 以成员身份连着放云端的共享项目(页面连接在线) */
  member: boolean;
  /** 打开项目的测量已落定(加载遮罩撤下) */
  measured: boolean;
}

export type EligibilityReason = "not-online" | "dev-build" | "lowest" | "phone" | "single-stage" | "not-chromium" | "not-member" | "measuring";

/** 当节点的条件(第 2 节):全部成立回 `{ ok: true }`,否则回第一条不成立的原因 */
export function browserNodeEligibility(input: EligibilityInput): { ok: boolean; reason: EligibilityReason | null } {
  const no = (reason: EligibilityReason) => ({ ok: false, reason });
  if (input.online !== true) return no("not-online");
  if (typeof input.codeVersion !== "string" || !input.codeVersion) return no("dev-build");
  if (input.lowest) return no("lowest");
  if (input.phone) return no("phone");
  if (input.stageLayout !== "dual") return no("single-stage");
  if (!isChromiumUserAgent(input.userAgent)) return no("not-chromium");
  if (input.member !== true) return no("not-member");
  if (input.measured !== true) return no("measuring");
  return { ok: true, reason: null };
}

/* ------------------------------------------------------------------ 流任务的纯函数 */

/** 轨道流每段的帧数:数和换算都在 `render/streamSegments.mjs`(产流、读流共用),这里照旧的名字再导出一次 */
export const STREAM_SEGMENT_FRAMES = SEGMENT_FRAMES_SHARED;
/** 浏览器压的流在清单里写的编码器名(桌面那边是 ffmpeg 的编码器名,如 `libx264`):看得出是浏览器用自带的编码器压的 */
export const BROWSER_STREAM_ENCODER = "webcodecs-avc";
/** 清单的版本与体积上限(同 `server/artifact-transfer.mjs` 的 `RESULT_VERSION`、`RESULT_MAX_BYTES`) */
const STREAM_RESULT_VERSION = 1;
const STREAM_RESULT_MAX_BYTES = 256 * 1024;

export interface StreamRectLike { x: number; y: number; w: number; h: number }
/** 切分方写在浏览器那一份流任务里的 `input.stream`(`server/render-node/split.mjs`):页面不自己算这些 */
export interface StreamTaskInput {
  kind: "card";
  plane: "local";
  clipIds: string[];
  fps: number;
  /** 流的矩形:包裹层自己的坐标(框的左上角是原点) */
  bound: StreamRectLike;
  /** 桌面隔离工程里把框摆到哪儿;浏览器这条路用不上,只原样写进清单 */
  offset: { x: number; y: number };
  /** 卡的本地帧 0 对应的全局帧号 */
  firstFrame: number;
  /** 卡的帧数:本地帧 0 .. count-1 之外是全透明 */
  count: number;
  /** 项目的总帧数(原来用它截最后一个分段;现在分段截到 `lastFrame`,这一项只照旧带着) */
  total: number;
  /** 这条流自己的第一帧(项目帧号):分段从它起每 15 帧一段。单卡流的它就是 `firstFrame` */
  originFrame: number;
  /** 这条流自己的最后一帧(项目帧号):最后一个分段到它为止,可以不满 15 帧 */
  lastFrame: number;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const HEX64 = /^[a-f0-9]{64}$/;

/** 任务 → `input.stream`;形状不对回 null(不猜) */
export function streamInputOf(task: { input?: Record<string, unknown> } | null | undefined): StreamTaskInput | null {
  const s = task?.input?.stream as Partial<StreamTaskInput> | undefined;
  if (!s || typeof s !== "object" || s.kind !== "card" || s.plane !== "local") return null;
  const ids = s.clipIds;
  if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string" || !ids[0]) return null;
  const b = s.bound, o = s.offset;
  const fps = Number(s.fps);
  if (!(fps > 0) || !Number.isFinite(fps) || !isInt(s.firstFrame) || !isInt(s.count) || s.count < 1 || !isInt(s.total) || s.total < 1) return null;
  // 分段从这条流自己的第一帧起数:任务没带这一帧的(改分段规则之前的切分方出的)不做,不拿项目的第 0 帧去猜
  if (!isStreamOrigin(s.originFrame) || !isInt(s.lastFrame) || s.lastFrame < s.originFrame) return null;
  if (!b || !isInt(b.x) || !isInt(b.y) || !isInt(b.w) || !isInt(b.h) || b.w < 2 || b.h < 2 || b.w % 2 || b.h % 2) return null;
  if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return null;
  return { kind: "card", plane: "local", clipIds: [ids[0]], fps, bound: { x: b.x, y: b.y, w: b.w, h: b.h }, offset: { x: o.x, y: o.y },
    firstFrame: s.firstFrame, count: s.count, total: s.total, originFrame: s.originFrame, lastFrame: s.lastFrame };
}

export interface StreamSegmentPlan {
  /** 分段号:这一段的第一帧是项目的第 `originFrame + index × 15` 帧 */
  index: number;
  /** 这一段每一帧要的本地帧号;`null` = 这一帧不在卡的范围里,送全透明 */
  frames: (number | null)[];
}

/**
 * 一段流任务要做哪些帧(第四处「帧号怎么换算」):任务范围里每个分段 15 帧(从这条流的第一帧 `originFrame` 起数,最后一段到这条流的
 * 最后一帧 `lastFrame` 为止;换算用 `render/streamSegments.mjs`,与切分方、播放器同一份),
 * 项目帧号减去 `firstFrame` 得卡的本地帧;落在 0 .. count-1 之外的帧不在卡的范围里,送全透明。
 * 任务不是浏览器形状的流任务回 null。`frames` 是这一段任务的总帧数。
 */
export function streamTaskFrames(task: { range?: { from: number; to: number } | null; input?: Record<string, unknown> } | null | undefined): { input: StreamTaskInput; segments: StreamSegmentPlan[]; frames: number } | null {
  const input = streamInputOf(task);
  const range = task?.range;
  if (!input || !range || !isInt(range.from) || !isInt(range.to) || range.from < 0 || range.to < range.from) return null;
  const segments: StreamSegmentPlan[] = [];
  let frames = 0;
  for (let n = range.from; n <= range.to; n++) {
    const first = streamSegmentFirstFrame(n, input.originFrame);
    const last = streamSegmentLastFrame(n, input.originFrame, input.lastFrame);
    const list: (number | null)[] = [];
    for (let g = first; g <= last; g++) {
      const local = g - input.firstFrame;
      list.push(local >= 0 && local < input.count ? local : null);
    }
    // 整段都在这条流的最后一帧之后:这样的分段不该出现在任务里(切分按流的末段切),出现了就是任务对不上,不做
    if (!list.length) return null;
    segments.push({ index: n, frames: list });
    frames += list.length;
  }
  return { input, segments, frames };
}

/** 清单里一个开头文件(`ftyp + moov`)的登记;键是哈希的前 16 位 */
export interface StreamInitMeta { hash: string; bytes: number; codec: string | null; width: number | null; height: number | null; timescale: number | null; rect: StreamRectLike | null; encoder: string | null }
/**
 * 清单里一个分段(`moof + mdat`)的登记;键是分段号。`stride`:1 是满密度,大于 1 是稀疏版(只截分段的第一帧、其余帧重复它)。
 * `box`:这个分段的位置矩形——截的那一张里不透明像素的外接框,平面坐标(与 `inits[].rect`、`header.bound` 同一个坐标系),
 * 全透明是 null;产稀疏版时量,没量过的不带这一项(与桌面 `stream.json` 的 `segments[n].box` 同一个约定)。
 */
export interface StreamSegmentMeta { hash: string; bytes: number; init: string; stride: number; samples: number; sig: string | null; encoder: string | null; box?: StreamRectLike | null }

/** 流任务的密度:`input.density: 'sparse'` 是稀疏流任务(id 末尾多 `:sparse`,`server/render-queue/messages.mjs` 的 `taskIdOf`);不带是满密度任务 */
export const STREAM_DENSITY_SPARSE = "sparse";
export const isSparseStreamTask = (task: { kind?: unknown; input?: Record<string, unknown> | null } | null | undefined): boolean =>
  task?.kind === "stream" && task.input?.density === STREAM_DENSITY_SPARSE;
/** 这个流任务每几帧截一张:稀疏流任务是一个分段的帧数(每段只截第一帧),满密度任务是 1 */
export const streamTaskStride = (task: { kind?: unknown; input?: Record<string, unknown> | null } | null | undefined): number =>
  (isSparseStreamTask(task) ? SEGMENT_FRAMES_SHARED : 1);

/**
 * 一张 RGBA 画面里不透明像素(alpha > 0)的外接框 `{ x, y, w, h }`(像素,左上角为原点);全透明回 null。
 * 稀疏版每个分段量一次(位置矩形 `box`),量法与桌面 `server/bakery/capture-canvas.mjs` 的 `rgbaAlphaBox` 相同。
 */
export function alphaBoxOf(data: ArrayLike<number>, width: number, height: number): StreamRectLike | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    let first = -1, last = -1;
    for (let x = 0; x < width; x++) if (data[row + x * 4 + 3] > 0) { first = x; break; }
    if (first < 0) continue;
    for (let x = width - 1; x >= first; x--) if (data[row + x * 4 + 3] > 0) { last = x; break; }
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
    if (y < y0) y0 = y;
    y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export interface StreamManifestOut {
  v: 1;
  kind: "stream";
  resultKey: string;
  range: { from: number; to: number };
  /** `lastFrame`:这条流自己的最后一帧(项目帧号);写内容库时按它截 8 段一桶的终点(`render/streamBuckets.mjs`)。旧清单没有这一项 */
  header: { kind: "card"; plane: "local"; clipIds: string[]; fps: number; originFrame: number; lastFrame?: number; bound: StreamRectLike; offset: { x: number; y: number }; tight: null };
  inits: Record<string, StreamInitMeta>;
  segments: Record<string, StreamSegmentMeta>;
}

/**
 * 一段流任务的清单:形状与桌面 `server/artifact-transfer.mjs` 的 `collectStreamResult` 逐字段相同(单测对拍、过 `manifestMatches`
 * 与 `streamAdoption`),桌面才能把浏览器产的流拉回去用。只列任务范围里的分段和它们用到的开头文件;分段照它产出时的密度记 `stride`
 * (稀疏流任务的是一个分段的帧数,带 `box`;满密度的是 1)、矩形固定用 `bound`(`header.tight: null`)、不算分段签名(`sig: null`,桌面按 `adopted` 认,不按本机编码器重算)。
 * 超过 256 KiB 抛 `code: 'result-too-large'`(不可重试)。
 */
export function streamManifest(
  task: { resultKey: string; range: { from: number; to: number } | null; input?: Record<string, unknown> },
  parts: { inits: Readonly<Record<string, StreamInitMeta>>; segments: Readonly<Record<string | number, StreamSegmentMeta>> },
): StreamManifestOut {
  const input = streamInputOf(task);
  if (!input || !task.range) throw Object.assign(new Error("任务没有 input.stream / range"), { retryable: false });
  const { from, to } = task.range;
  const inits: Record<string, StreamInitMeta> = {};
  const segments: Record<string, StreamSegmentMeta> = {};
  for (let n = from; n <= to; n++) {
    const seg = parts.segments[n];
    const init = seg ? parts.inits[seg.init] : undefined;
    if (!seg || !init) continue;
    if (!inits[seg.init]) inits[seg.init] = { hash: init.hash, bytes: init.bytes, codec: init.codec ?? null, width: init.width ?? null, height: init.height ?? null,
      timescale: init.timescale ?? null, rect: init.rect ? { ...init.rect } : null, encoder: init.encoder ?? null };
    segments[n] = { hash: seg.hash, bytes: seg.bytes, init: seg.init, stride: seg.stride, samples: seg.samples, sig: seg.sig ?? null, encoder: init.encoder ?? null,
      ...(seg.box !== undefined ? { box: seg.box ? { ...seg.box } : null } : {}) };
  }
  const out: StreamManifestOut = {
    v: STREAM_RESULT_VERSION, kind: "stream", resultKey: task.resultKey, range: { from, to },
    header: { kind: "card", plane: "local", clipIds: [...input.clipIds], fps: input.fps, originFrame: input.originFrame, lastFrame: input.lastFrame, bound: { ...input.bound }, offset: { ...input.offset }, tight: null },
    inits, segments,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
  if (bytes > STREAM_RESULT_MAX_BYTES) throw Object.assign(new Error(`任务清单 ${bytes} 字节,超过上限 ${STREAM_RESULT_MAX_BYTES}`), { code: "result-too-large", bytes, retryable: false });
  return out;
}

/**
 * 一段流任务的清单要写进内容库(`render-manifest`)的几份:任务自己的键 `<结果键>:<起>-<止>`,另加「8 段一桶」里与它不同的每个桶
 * (`render/streamBuckets.mjs`,与桌面 `server/artifact-transfer.mjs` 的 `writeManifest` 同一个规矩)。桶的终点截到**整条流的最后一段**,
 * 由任务的 `input.stream`(`originFrame` / `lastFrame`)换算,不拿任务的 `range.to` 顶:任务 `[0, 59]` 不是流的末尾时最后一个桶是 `56-63`,
 * 与任务 `[60, 124]` 写的同一个键。每一份写之前由调用方各自和内容库里已有的那一份合并(`mergeStreamManifest`),两边的分段合在一起。
 */
export function streamManifestPuts(
  task: { resultKey: string; range: { from: number; to: number } | null; input?: Record<string, unknown> },
  manifest: StreamManifestOut,
): { key: string; body: StreamManifestOut }[] {
  const range = task.range;
  if (!range || typeof task.resultKey !== "string" || !task.resultKey || !isInt(range.from) || !isInt(range.to) || range.from < 0 || range.to < range.from) return [];
  const out = [{ key: `${task.resultKey}:${range.from}-${range.to}`, body: manifest }];
  const span = task.input?.stream as { originFrame?: unknown; lastFrame?: unknown } | undefined;
  const lastSegment = streamLastSegmentOf(span) ?? streamLastSegmentOf(manifest.header);
  for (const bucket of streamBucketRanges(range.from, range.to, lastSegment)) {
    if (bucket.from === range.from && bucket.to === range.to) continue;
    out.push({ key: `${task.resultKey}:${bucket.from}-${bucket.to}`, body: streamBucketManifest(manifest, bucket) as StreamManifestOut });
  }
  return out;
}

/**
 * 写流清单前和内容库里已有的那一份合并(同一个键),不降级:新清单里某一段是稀疏的而已有的是满密度的,留已有的;新清单里没有、
 * 已有的清单里有的分段留着;其余用新的。留下的分段连它的开头文件一起带过来。新的分段没带位置矩形(`box`,只在稀疏的一趟量)而已有的
 * 那一段带着,把它带过来 —— 补成满密度以后位置矩形还在。与桌面 `server/artifact-transfer.mjs` 的 `mergeStreamResult` 同一个规矩。
 * 已有的对不上(键、范围、形状)就原样回新的。
 */
export function mergeStreamManifest(existing: unknown, next: StreamManifestOut): StreamManifestOut {
  const old = existing as StreamManifestOut | null;
  if (!old || typeof old !== "object" || old.v !== next.v || old.kind !== "stream" || old.resultKey !== next.resultKey) return next;
  if (old.range?.from !== next.range.from || old.range?.to !== next.range.to || !old.segments || typeof old.segments !== "object" || !old.inits || typeof old.inits !== "object") return next;
  const segments = { ...next.segments }, inits = { ...next.inits };
  let kept = 0;
  for (const [n, seg] of Object.entries(old.segments)) {
    const init = seg && typeof seg === "object" ? old.inits[seg.init] : undefined;
    if (!init || !HEX64.test(String(seg.hash)) || !HEX64.test(String(init.hash))) continue;
    const cur = segments[n];
    if (cur && (!(cur.stride > 1) || seg.stride > 1)) {
      if (cur.box === undefined && seg.box !== undefined) { segments[n] = { ...cur, box: seg.box }; kept++; }
      continue;
    }
    segments[n] = seg;
    if (!inits[seg.init]) inits[seg.init] = init;
    kept++;
  }
  return kept ? { ...next, inits, segments } : next;
}

/**
 * 内容库里取回的流清单能不能直接当这一段的结果用(去重):形状对、任务范围里每个分段和它的开头文件都列着。
 * `dense`(满密度任务)时另要每个分段都是满密度;稀疏流任务每段有一版就算数。
 */
export function streamManifestCovers(body: unknown, task: { resultKey: string; range: { from: number; to: number } | null }, opts: { dense?: boolean } = {}): body is StreamManifestOut {
  const b = body as StreamManifestOut | null;
  if (!b || typeof b !== "object" || b.v !== STREAM_RESULT_VERSION || b.kind !== "stream" || b.resultKey !== task.resultKey || !task.range) return false;
  if (b.range?.from !== task.range.from || b.range?.to !== task.range.to) return false;
  if (!b.header || !Array.isArray(b.header.clipIds) || !isStreamOrigin(b.header.originFrame) || !b.inits || typeof b.inits !== "object" || !b.segments || typeof b.segments !== "object") return false;
  for (let n = task.range.from; n <= task.range.to; n++) {
    const seg = b.segments[n];
    const init = seg ? b.inits[seg.init] : undefined;
    if (!seg || !init || !HEX64.test(String(seg.hash)) || !HEX64.test(String(init.hash))) return false;
    if (!isInt(seg.samples) || seg.samples < 1 || !isInt(seg.stride) || seg.stride < 1) return false;
    if (opts.dense === true && seg.stride !== 1) return false;
  }
  return true;
}

/** 流清单里要在素材服务上的块(都在像素那一类 `px`):开头文件与分段,按哈希去重 */
export function streamManifestBlocks(m: StreamManifestOut): { ns: "px"; hash: string }[] {
  const out = new Map<string, { ns: "px"; hash: string }>();
  for (const init of Object.values(m.inits ?? {})) out.set(init.hash, { ns: "px", hash: init.hash });
  for (const seg of Object.values(m.segments ?? {})) out.set(seg.hash, { ns: "px", hash: seg.hash });
  return [...out.values()];
}

/* ------------------------------------------------------------------ 编排 */

/** 队列里的一个任务(契约 A.4 的 TaskView;这里只用到这些字段) */
export interface NodeTask {
  id: string;
  kind: string;
  tier?: string;
  resultKey: string;
  range: { unit?: string; from: number; to: number } | null;
  source: { projectId: string; projectRev: number; userId?: string };
  input?: Record<string, unknown>;
  requires?: Record<string, unknown>;
  version?: number;
  [k: string]: unknown;
}

/** 一帧的产出(宿主的 `bakeFrame` 回的) */
export interface BakedFrame {
  /** 原尺寸 HTML 快照(原始字节)的 sha256 */
  hash: string;
  bytes: number;
  htmlGz?: ArrayBuffer;
  /** 预渲染小尺寸(WebP)的 sha256 与字节数 */
  small?: { hash: string; bytes: number } | null;
  [k: string]: unknown;
}
export type FrameRecord = BakedFrame & { localFrame: number };

export type YieldCause = "play" | "drag" | "urgent" | "hidden";

export interface BrowserNodeDeps {
  nodeId: string;
  projectId: string;
  /** 「用户名@设备」(与文档服务按凭证填的 `source.userId` 同形) */
  userId: string;
  codeVersion: string | null;
  /** `pageEnvironment()` 的原始值 */
  environment: { platform: string; userAgent: string; renderer: string; vendor: string };
  now: () => number;
  /** 闲的判据(父页判,第 2 节) */
  isIdle: () => boolean;
  /** 往 render 连接发一条 */
  send: (message: Record<string, unknown>) => boolean | void;
  /** 发布清单计划时留存的已确认版本(D6);没有回 null */
  keptProject: (rev: number) => unknown | null;
  /** `project.snapshot.get` 那一版;没有回 null */
  fetchSnapshot: (rev: number) => Promise<unknown | null>;
  /** 生成这一帧(后台舞台)并推送;`signal` 中止时尽早停手 */
  bakeFrame: (job: { task: NodeTask; project: unknown; localFrame: number; signal: AbortSignal }) => Promise<BakedFrame>;
  /** 全段齐后组清单、写内容库;回的对象展开进 `task.complete` 的结果 */
  finishTask: (arg: { task: NodeTask; frames: FrameRecord[] }) => Promise<Record<string, unknown>>;
  /** 去重(第 4.1 节):内容库清单在、覆盖整段、块都在素材服务上就回清单,否则 null */
  lookupResult?: (task: NodeTask) => Promise<Record<string, unknown> | null>;
  /**
   * 本页此刻压不压得了轨道流(宿主按 `probeStreamEncoder` 探的结果)。每个节拍读一次,不缓存;回真且给了 `bakeStream`,
   * 能力位 `capabilities.streams` 才报真(节点侧过滤规则 2 据此认领流任务)。不给就是不产流的节点,与原来相同。
   */
  streams?: () => boolean;
  /**
   * 执行一段流任务(`kind: 'stream'`):按 `input.bake` 建隔离单卡工程,任务范围里逐段逐帧要像素、送编码器、把开头文件与分段推素材服务。
   * `progress(n)` 报已经做了几帧(开工先报一次起点:上一次认领里已经推完的分段的帧数,没有就是 0);每帧前问 `yielding()`,为真就在当前帧做完后停手、回 `{ yielded: true }`;`signal` 中止时尽早停手。
   * 全部分段都推完回 `{ manifest }`(清单,`streamManifest` 的形状)。
   */
  bakeStream?: (job: { task: NodeTask; project: unknown; signal: AbortSignal; progress: (frames: number) => void; yielding: () => boolean }) => Promise<{ manifest: Record<string, unknown> } | { yielded: true }>;
  /** 流任务全部分段齐后写内容库(`render-manifest`);回的对象展开进 `task.complete` 的结果。不给就直接用 `bakeStream` 回的清单 */
  finishStream?: (arg: { task: NodeTask; manifest: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  /** 一段任务收尾(完成、失败、放回、丢认领)之后调:宿主据此交还后台舞台 */
  onTaskEnd?: (task: NodeTask, outcome: string) => void;
  /** `node.welcome` 回了指纹 */
  onFingerprint?: (envFingerprint: string) => void;
  /**
   * 本页能执行同步来的用户卡与素材效果卡时回登记处的内容(`nodeCardInfo.ts` 的 `getNodeCardInfo`);不能或不给就是原来的纯浏览器节点。
   * 每个节拍读一次,不缓存。
   */
  cardInfo?: () => { cardRuntime: string | null; userCards: boolean; graphCards: boolean; cardSources: Readonly<Record<string, string>> } | null;
  /** `node.welcome` 回了(或没回)用户卡、素材效果卡用的指纹(没有时传 null) */
  onCardEnvFingerprint?: (cardEnvFingerprint: string | null) => void;
  /** 报到被文档服务拒了(`forbidden`、`not-chromium`、`bad-message`……):宿主结束会话,不重连 */
  onRefused?: (reason: string) => void;
  /**
   * 手里没有认领时,页面此刻在忙什么(报忙用,M7 D2 补充):后台舞台在测量、补跑回 `'stage'` 之类的短串;闲着、页面隐藏、
   * 只是在播放或拖动而后台没活回 null。不给就只在手里有认领时报忙
   */
  busy?: () => string | null;
  random?: () => number;
  constants?: Record<string, unknown>;
}

export interface BrowserNodeDebug {
  state: "off" | "idle" | "busy" | "baking";
  reason: string | null;
  nodeId: string;
  envFingerprint: string | null;
  /** 用户卡、素材效果卡的任务用的指纹(块 N);没报运行时版本或旧队列为 null */
  cardEnvFingerprint: string | null;
  /** 此刻报给节点侧过滤的用户卡、素材效果卡能力与卡片代码身份(块 N):卡片 id → 身份 */
  cards: { runtime: string | null; userCards: boolean; graphCards: boolean; sources: Record<string, string> };
  /** 此刻报给节点侧过滤的「能产轨道流」(宿主探到了编码器、给了执行流任务的方法) */
  streams: boolean;
  codeVersion: string | null;
  holding: { id: string; token: number; done: number; of: number; projectRev: number | null }[];
  counters: {
    claims: number; completed: number; dedup: number; failed: number; lost: number; bakedFrames: number;
    /** 流任务:送进编码器的帧数(含全透明的)与做完的流任务数 */
    streamFrames: number; streamTasks: number;
    /** 发了几条 `node.active`(报忙,M7 D2 补充) */
    active: number;
    released: Record<string, number>;
    /** 被节点侧过滤挡掉的任务,按「规则号:原因」(每个任务 id 只记一次) */
    blocked: Record<string, number>;
    frameMs: { n: number; p50: number | null; p95: number | null };
  };
  lastError: string | null;
}

export interface BrowserNode {
  /** 报到并 watch 本项目(新会话建成时调;带手里的认领去接续) */
  start(): void;
  /** render 连接上收到的消息 */
  receive(message: Record<string, unknown>): void;
  /** 认领与续约的节拍(宿主按间隔调) */
  tick(): void;
  /** 让路(D8) */
  yieldFor(cause: YieldCause): void;
  /** 下线:放回全部,不再认领 */
  stop(): void;
  debug(): BrowserNodeDebug;
  /** 手里有没有认领(在做、在查去重、在取项目都算)。本页产流(`pageStreams.ts`)据此不与认领来的任务同时用后台舞台 */
  working(): boolean;
  readonly envFingerprint: string | null;
  readonly cardEnvFingerprint: string | null;
}

type NodeSession = {
  start(resume?: { id: string; token: number }[]): void;
  receive(message: unknown): void;
  tick(): void;
  progress(id: string, done: number): boolean;
  complete(id: string, result?: unknown): boolean;
  fail(id: string, error?: string, retryable?: boolean): boolean;
  yieldAll(reason?: string): number;
  held(): { id: string; token: number; lastSentAt: number }[];
  known(): NodeTask[];
};
const createNodeSession = createNodeSessionUntyped as (options: Record<string, unknown>) => NodeSession;
const checkClaimable = checkClaimableUntyped as (task: unknown, node: unknown) => { ok: boolean; rule?: number; reason?: string };

type TaskRunner = {
  onTask(task: NodeTask, ctx: { token: number }): void;
  onLost(id: string, reason: string): void;
  stop(reason?: string): void;
  tokenOf(id: string): number | null;
};
const createTaskRunner = createTaskRunnerUntyped as (options: Record<string, unknown>) => TaskRunner;
/** 中止标记(与 task-runner 同一个:赛跑输给中止信号,不是执行器的错) */
const ABORTED = ABORTED_UNTYPED as symbol;

function untilAborted<T>(work: () => Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(ABORTED);
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const settled = new Promise<T>((resolve) => resolve(work()));
  return Promise.race([settled, aborted]).finally(() => { if (onAbort) signal.removeEventListener("abort", onAbort); });
}

const quantile = (sorted: number[], p: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;

/** 每帧耗时留最近这么多个样本算 p50 / p95 */
const FRAME_SAMPLES = 200;
/**
 * 让路(play / drag / urgent)之后等当前这一帧做完最多这么久;过了就像页面隐藏那样中止它、立即放回(三级数字)。
 * 播放、拖动时后台活的门会关,正在做的那一帧在舞台里被挡住,不设上限就既不出帧也不放回(M7 验收探针 A5 / A6)。
 */
export const YIELD_FRAME_MAX_MS = 1000;
/** 已做的帧留几段(让路后重新认领同一段只补缺的帧) */
const RETAINED_TASKS = 8;

/** 本页这一侧对一次认领的记账(执行的规矩在 task-runner 里;这里只管帧、让路与诊断) */
interface Run {
  task: NodeTask;
  token: number;
  /** 中止舞台这次生成快照:跟着 runner 的中止信号,另在隐藏时由本页中止 */
  controller: AbortController;
  /** 在哪一步:查去重与取项目(`prep`)、等 `bakeFrame` 回来(`baking`)、帧间(`between`)、全段齐后组清单(`finishing`) */
  phase: "prep" | "baking" | "between" | "finishing";
  /** 要求让路的原因(做完当前帧就放回) */
  yieldCause: YieldCause | null;
  /** 要求让路的时刻(`deps.now()`):当前帧 `YIELD_FRAME_MAX_MS` 之内做不完就立即放回 */
  yieldAt: number | null;
  frames: Map<number, FrameRecord>;
  /** 流任务:这一次认领里做到了第几帧(宿主报的) */
  streamDone: number;
  /** 流任务:宿主开工报的起点帧数(还没报过为 null) */
  streamBase: number | null;
  /** 去重查到的清单(`sink.resultFor` 回它) */
  found: Record<string, unknown> | null;
  ended: boolean;
}

export function createBrowserNode(deps: BrowserNodeDeps): BrowserNode {
  const nodeDesc = {
    profile: "browser",
    nodeId: deps.nodeId,
    userId: deps.userId,
    envFingerprint: null as string | null,
    /** 用户卡、素材效果卡的任务用的指纹(块 N,`node.welcome.cardEnvFingerprint`);filter.mjs 规则 1 对这类任务拿它比 */
    cardEnvFingerprint: null as string | null,
    codeVersions: deps.codeVersion ? [deps.codeVersion] : [],
    capabilities: { transcode: false, streams: false, userCards: false, graphCards: false },
    cardSourceVersions: {} as Record<string, string[]>,
  };
  /** 最近一次报给节点侧过滤的卡片登记(诊断)与最近一次 `node.hello` 里报的运行时版本(判要不要重新报到) */
  let cardsNow: { runtime: string | null; userCards: boolean; graphCards: boolean; sources: Record<string, string> } = { runtime: null, userCards: false, graphCards: false, sources: {} };
  let helloRuntime: string | null = null;
  /** 此刻本页的卡片登记(宿主给);读不到、抛错都当没有 */
  const readCardInfo = () => {
    try {
      const info = deps.cardInfo?.() ?? null;
      if (!info || typeof info.cardRuntime !== "string" || !info.cardRuntime) return { runtime: null, userCards: false, graphCards: false, sources: {} as Record<string, string> };
      return { runtime: info.cardRuntime, userCards: info.userCards === true, graphCards: info.graphCards === true, sources: { ...info.cardSources } };
    } catch { return { runtime: null, userCards: false, graphCards: false, sources: {} as Record<string, string> }; }
  };
  /** 本页此刻能不能产流:宿主探到了编码器、也给了执行流任务的方法(读不到、抛错都当不能) */
  const canStream = (): boolean => {
    if (typeof deps.bakeStream !== "function") return false;
    try { return deps.streams?.() === true; } catch { return false; }
  };
  /** 把登记同步进节点描述(能力位与卡片代码身份):节点侧过滤与认领据此判 */
  const refreshCards = () => {
    cardsNow = readCardInfo();
    // 文档服务没有回 cardEnvFingerprint(旧队列、运行时版本不合格)时不报能力:认领了也会因为指纹对不上被拒,不必白发请求
    const usable = cardsNow.runtime !== null && nodeDesc.cardEnvFingerprint !== null;
    nodeDesc.capabilities = { ...nodeDesc.capabilities, streams: canStream(), userCards: usable && cardsNow.userCards, graphCards: usable && cardsNow.graphCards };
    const versions: Record<string, string[]> = {};
    if (usable) for (const [id, v] of Object.entries(cardsNow.sources)) versions[id] = [v];
    nodeDesc.cardSourceVersions = versions;
  };
  let stopped = false;
  let welcomed = false;
  let refused: string | null = null;
  let run: Run | null = null;
  let lastError: string | null = null;
  /** 报忙的间隔(`node.welcome.activeIntervalMs`);旧队列不带,为 null,一条也不发 */
  let activeEvery: number | null = null;
  let lastActiveAt = -Infinity;
  /** 已做的帧:任务 id → 帧;按插入顺序淘汰 */
  const retained = new Map<string, Map<number, FrameRecord>>();
  const blockedSeen = new Set<string>();
  const frameMs: number[] = [];
  const counters = {
    claims: 0, completed: 0, dedup: 0, failed: 0, lost: 0, bakedFrames: 0, streamFrames: 0, streamTasks: 0, active: 0,
    released: {} as Record<string, number>,
    blocked: {} as Record<string, number>,
  };
  const bump = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1; };

  /** 发往 render 连接:`node.hello` 只报原始值(D10),自报的指纹去掉 */
  const send = (message: Record<string, unknown>) => {
    let m = message;
    if (m.type === "node.hello") {
      const { envFingerprint: _own, ...rest } = m;
      m = { ...rest, profile: "browser", maxConcurrent: 1, environment: { ...deps.environment } };
      // 块 N:能执行用户卡与素材效果卡就多报运行时版本(原始值,文档服务算 cardEnvFingerprint);不能执行时与原来一字不差
      const runtime = readCardInfo().runtime;
      helloRuntime = runtime;
      if (runtime) m = { ...m, cardRuntime: runtime };
    }
    if (m.type === "task.claim") counters.claims++;
    return deps.send(m);
  };

  const holding = (r: Run) => !stopped && !r.ended && run === r && !r.controller.signal.aborted
    && session.held().some((h) => h.id === r.task.id && h.token === r.token);

  const endRun = (r: Run, outcome: string) => {
    if (r.ended) return;
    r.ended = true;
    if (run === r) run = null;
    try { deps.onTaskEnd?.(r.task, outcome); } catch { /* 宿主坏了不影响协议 */ }
  };

  const keepFrames = (id: string, frames: Map<number, FrameRecord>) => {
    retained.delete(id);
    if (!frames.size) return;
    retained.set(id, frames);
    while (retained.size > RETAINED_TASKS) retained.delete(retained.keys().next().value as string);
  };

  /** 不等当前帧:中止它并立即放回(页面隐藏;让路之后当前帧超时做不完) */
  const abortAndRelease = (r: Run, reason: string) => {
    if (!holding(r)) return;
    keepFrames(r.task.id, r.frames);
    session.yieldAll(reason);
    bump(counters.released, reason);
    r.controller.abort();
    endRun(r, `released:${reason}`);
  };

  /** 放回手里这一段(让路、取不到项目):不计失败(C2)。放回之后 runner 判「不再持有」,丢掉这次执行 */
  const release = (r: Run, reason: string) => {
    if (!holding(r)) { endRun(r, "discarded"); return; }
    keepFrames(r.task.id, r.frames);
    session.yieldAll(reason);
    bump(counters.released, reason);
    endRun(r, `released:${reason}`);
  };

  const runOf = (ref: { resultKey?: unknown; range?: { from?: unknown; to?: unknown } | null }) => {
    const r = run;
    return r && r.task.resultKey === ref?.resultKey && r.task.range?.from === ref?.range?.from && r.task.range?.to === ref?.range?.to ? r : null;
  };

  /** 执行一段(task-runner 的 executor.render):取项目、逐帧生成快照、处理让路。回这一段的帧 */
  async function render(task: NodeTask, { signal, progress }: { signal: AbortSignal; progress: (done: number) => void }): Promise<FrameRecord[] | { stream: Record<string, unknown> } | null> {
    const r = run && run.task.id === task.id ? run : null;
    if (!r) throw ABORTED;
    signal.addEventListener("abort", () => r.controller.abort(), { once: true });
    const mine = r.controller.signal;
    const isStream = task.kind === "stream";
    if ((task.kind !== "snapshot" && !isStream) || !task.range || (isStream && (typeof deps.bakeStream !== "function" || !streamTaskFrames(task)))) {
      // 节点侧过滤只让快照任务与浏览器形状的单卡流进来;万一来了别的(或宿主不产流),放回、不做
      release(r, "unsupported");
      return null;
    }
    if (r.yieldCause) { release(r, `yield-${r.yieldCause}`); return null; }
    // D6:任务的 projectRev 那一版;先用发布时留存的,没有再取快照,都没有就放回,不拿别的版本渲
    const rev = Number(task.source?.projectRev);
    let project: unknown = Number.isSafeInteger(rev) ? deps.keptProject(rev) : null;
    if (!project && Number.isSafeInteger(rev)) {
      project = await untilAborted(() => deps.fetchSnapshot(rev), mine).catch((e) => { if (e === ABORTED) throw e; return null; });
      if (!holding(r)) return null;
    }
    if (!project) {
      lastError = `取不到第 ${Number.isSafeInteger(rev) ? rev : "?"} 版项目`;
      release(r, "no-snapshot");
      return null;
    }
    if (isStream) {
      // 流任务整段交给宿主:它逐帧要像素、送编码器、推分段;每帧前问让不让路,当前帧做完才停
      r.phase = "baking";
      let out: { manifest: Record<string, unknown> } | { yielded: true };
      try {
        out = await untilAborted(() => deps.bakeStream!({
          task, project, signal: mine,
          progress: (n) => {
            const done = Math.max(0, Math.floor(Number(n) || 0));
            // 宿主开工先报一次起点(上一次认领里已经推完的分段的帧数,让路放回后回来时不为 0):起点不算这一次送进编码器的
            if (r.streamBase !== null && done > r.streamDone) counters.streamFrames += done - r.streamDone;
            if (r.streamBase === null) r.streamBase = done;
            r.streamDone = Math.max(r.streamDone, done);
            if (holding(r)) progress(r.streamDone);
          },
          yielding: () => r.yieldCause !== null,
        }), mine);
      } finally {
        r.phase = "between";
      }
      if (!holding(r)) return null;
      if (!("manifest" in out)) { release(r, `yield-${r.yieldCause ?? "urgent"}`); return null; }
      // 全部分段齐:此后即使被要求让路也收尾(同快照任务)
      r.phase = "finishing";
      counters.streamTasks++;
      return { stream: out.manifest };
    }
    const { from, to } = task.range;
    for (let f = from; f <= to; f++) {
      if (r.frames.has(f)) continue;
      if (r.yieldCause) { release(r, `yield-${r.yieldCause}`); return null; }
      if (!holding(r)) return null;
      const t0 = deps.now();
      r.phase = "baking";
      let out: BakedFrame;
      try {
        out = await untilAborted(() => deps.bakeFrame({ task, project, localFrame: f, signal: mine }), mine);
      } finally {
        r.phase = "between";
      }
      if (!holding(r)) return null;
      r.frames.set(f, { ...out, localFrame: f });
      counters.bakedFrames++;
      frameMs.push(Math.max(0, deps.now() - t0));
      if (frameMs.length > FRAME_SAMPLES) frameMs.splice(0, frameMs.length - FRAME_SAMPLES);
      progress(r.frames.size);
    }
    // 全段齐:此后即使被要求让路也收尾(这一批已做完,放回只会让下一个认领者重做)
    r.phase = "finishing";
    return [...r.frames.values()].sort((a, b) => a.localFrame - b.localFrame);
  }

  const sink = {
    /** 去重(第 4.1 节):内容库清单在、覆盖整段、块都在就直接完成 */
    async has(ref: { resultKey: string; range: NodeTask["range"] }) {
      const r = runOf(ref);
      if (!r || !deps.lookupResult) return false;
      const found = await untilAborted(() => deps.lookupResult!(r.task), r.controller.signal).catch((e) => { if (e === ABORTED) throw e; return null; });
      r.found = found && typeof found === "object" ? found : null;
      return !!r.found;
    },
    async resultFor(ref: { resultKey: string; range: NodeTask["range"] }) {
      return runOf(ref)?.found ?? null;
    },
    /** 全段齐后组清单、写内容库(宿主的 finishTask);回的清单展开进 `task.complete` */
    async put(entry: { resultKey: string; range: NodeTask["range"]; artifacts: FrameRecord[] | { stream: Record<string, unknown> } | null }) {
      const r = runOf(entry);
      if (r && entry.artifacts && !Array.isArray(entry.artifacts) && entry.artifacts.stream && typeof entry.artifacts.stream === "object") {
        // 流任务:分段都已推到素材服务,这里只差把清单写进内容库(写失败只记诊断,清单照样随 task.complete 交给订阅方)
        const manifest = entry.artifacts.stream;
        const result = deps.finishStream ? await deps.finishStream({ task: r.task, manifest }) : manifest;
        return { complete: true, result };
      }
      if (!r || !Array.isArray(entry.artifacts)) return { complete: false };
      const result = await deps.finishTask({ task: r.task, frames: entry.artifacts });
      return { complete: true, result };
    },
  };

  /** task-runner 的诊断事件:收尾与计数 */
  const onRunnerEvent = (e: { type: string; id: string; error?: string; retryable?: boolean }) => {
    const r = run && run.task.id === e.id ? run : null;
    switch (e.type) {
      case "completed":
        counters.completed++;
        retained.delete(e.id);
        if (r) endRun(r, "completed");
        break;
      case "dedup":
        counters.dedup++;
        retained.delete(e.id);
        if (r) endRun(r, "dedup");
        break;
      case "failed":
        counters.failed++;
        lastError = e.error ?? lastError;
        if (r) { keepFrames(e.id, r.frames); endRun(r, e.retryable === false ? "failed-final" : "failed"); }
        break;
      case "discarded":
        if (r) { keepFrames(e.id, r.frames); endRun(r, "discarded"); }
        break;
      default:
        break;
    }
  };

  const runner = createTaskRunner({
    nodeId: deps.nodeId,
    session: () => session,
    executor: { render },
    sink,
    emit: (e: { type: string; id: string; error?: string; retryable?: boolean }) => { try { onRunnerEvent(e); } catch { /* 诊断出错不打断协议 */ } },
  });

  const session = createNodeSession({
    nodeId: deps.nodeId,
    node: nodeDesc,
    send,
    now: deps.now,
    isIdle: () => !stopped && refused === null && welcomed && deps.isIdle(),
    maxConcurrent: 1,
    projects: [deps.projectId],
    ...(deps.random ? { random: deps.random } : {}),
    ...(deps.constants ? { constants: deps.constants } : {}),
    onTask: (task: NodeTask, ctx: { token: number }) => {
      if (!task || typeof task.id !== "string") return;
      if (run) { run.controller.abort(); endRun(run, "replaced"); }
      run = {
        task, token: ctx.token, controller: new AbortController(), phase: "prep", yieldCause: null, yieldAt: null,
        frames: new Map(retained.get(task.id) ?? []), streamDone: 0, streamBase: null, found: null, ended: false,
      };
      // 开工先报 0、去重、执行、推送、完成的规矩在 task-runner(桌面与页面同一份,D11)
      runner.onTask(task, ctx);
    },
    onLost: (id: string, reason: string) => {
      counters.lost++;
      runner.onLost(id, reason);
      const r = run;
      if (r && r.task.id === id) { r.controller.abort(); keepFrames(id, r.frames); endRun(r, `lost:${reason}`); }
    },
  });

  /** 此刻忙什么(报忙用):手里有认领就是在生成快照/压流;拖动/穿梭报 scrub，播放报 play；否则问宿主(后台舞台的更急的活) */
  const busyNow = (): string | null => {
    const r = run;
    if (r && !r.ended) {
      if (r.yieldCause === "drag") return "scrub";
      if (r.yieldCause === "play") return "play";
      return "bake";
    }
    try {
      const b = deps.busy?.() ?? null;
      if (typeof b === "string" && b) {
        if (b === "drag") return "scrub";
        return b.slice(0, 32);
      }
      return null;
    } catch { return null; }
  };

  /** 报忙(M7 D2 补充):新队列、报到过、忙着、离上一次过了间隔才发 */
  const reportActive = () => {
    if (activeEvery === null || !welcomed || stopped || refused) return;
    const now = deps.now();
    if (now - lastActiveAt < activeEvery) return;
    const busy = busyNow();
    if (!busy) return;
    if (send({ type: "node.active", busy }) === false) return;
    lastActiveAt = now;
    counters.active++;
  };

  /** 被节点侧过滤挡掉的任务按原因记一次(诊断;服务端与节点侧都挡,页面不另判) */
  const noteBlocked = () => {
    for (const task of session.known()) {
      if (blockedSeen.has(task.id)) continue;
      const c = checkClaimable(task, nodeDesc);
      if (c.ok) continue;
      blockedSeen.add(task.id);
      bump(counters.blocked, `${c.rule}:${c.reason}`);
    }
    if (blockedSeen.size > 5000) blockedSeen.clear();
  };

  return {
    start() {
      if (stopped || refused) return;
      welcomed = false;
      // 报到带的能力位取此刻的(宿主探到编码器了没有);之后每个节拍照常同步
      refreshCards();
      // 新会话:带手里、真在跑的认领去接续(HT-a 第 4.4 节;队列按令牌接续,对不上的回 lost)
      session.start(session.held().filter((h) => runner.tokenOf(h.id) === h.token).map(({ id, token }) => ({ id, token })));
    },
    receive(message) {
      if (stopped || !message || typeof message !== "object") return;
      if (message.type === "node.welcome") {
        welcomed = true;
        // 新队列认 node.active(M7 D2 补充):记下间隔;每次报到从头算,忙着就在下一拍报
        const every = Number(message.activeIntervalMs);
        activeEvery = Number.isFinite(every) && every > 0 ? every : null;
        lastActiveAt = -Infinity;
        const fp = typeof message.envFingerprint === "string" && message.envFingerprint ? message.envFingerprint : null;
        if (fp && fp !== nodeDesc.envFingerprint) {
          nodeDesc.envFingerprint = fp;
          try { deps.onFingerprint?.(fp); } catch { /* 宿主坏了 */ }
        }
        // 块 N:用户卡、素材效果卡用的指纹(没有就清掉:重新报到、旧队列)
        const cardFp = typeof message.cardEnvFingerprint === "string" && message.cardEnvFingerprint ? message.cardEnvFingerprint : null;
        if (cardFp !== nodeDesc.cardEnvFingerprint) {
          nodeDesc.cardEnvFingerprint = cardFp;
          try { deps.onCardEnvFingerprint?.(cardFp); } catch { /* 宿主坏了 */ }
        }
        refreshCards();
      } else if (message.type === "error" && !welcomed && message.reqId === undefined) {
        // 报到被拒(D9 forbidden、D14 not-chromium、D10 bad-message):不当节点、不重连
        refused = String(message.reason ?? "error");
        lastError = `报到被拒:${refused}`;
        try { deps.onRefused?.(refused); } catch { /* 宿主坏了 */ }
      }
      if (message.type === "queue.snapshot" || message.type === "task.opened") refreshCards();
      session.receive(message);
      if (message.type === "queue.snapshot" || message.type === "task.opened") noteBlocked();
    },
    tick() {
      if (stopped || refused) return;
      // 块 N:登记变了随时同步进节点描述;运行时版本在报到之后才可报(或变了)就重新报到一次(带手里的认领接续)
      refreshCards();
      if (welcomed && cardsNow.runtime !== helloRuntime) {
        welcomed = false;
        session.start(session.held().filter((h) => runner.tokenOf(h.id) === h.token).map(({ id, token }) => ({ id, token })));
      }
      // 让路之后当前帧迟迟做不完(播放、拖动时后台活的门关了,这一帧在舞台里被挡住):不再等,中止并立即放回
      const r = run;
      if (r && !r.ended && r.yieldCause && r.phase === "baking" && r.yieldAt !== null && deps.now() - r.yieldAt >= YIELD_FRAME_MAX_MS) {
        abortAndRelease(r, `yield-${r.yieldCause}`);
      }
      session.tick();
      reportActive();
    },
    yieldFor(cause) {
      const r = run;
      if (!r || r.ended) return;
      if (cause === "hidden") {
        // 隐藏页的计时器被节流,续约不可靠:不等当前帧,中止并立即放回;迟到的结果丢掉
        abortAndRelease(r, "yield-hidden");
        return;
      }
      if (!r.yieldCause) { r.yieldCause = cause; r.yieldAt = deps.now(); }
      // 在等哪一步决定什么时候放回:
      //   prep       还没开始生成快照(查去重、取项目),没有「当前这一批」:立即放回并中止
      //   baking     当前这一帧做完再放回(执行循环在帧回来之后看 yieldCause)
      //   finishing  全段已齐,只剩组清单与报完成:照常完成(放回只会让下一个认领者重做)
      if (r.phase === "prep") {
        release(r, `yield-${cause}`);
        r.controller.abort();
      }
    },
    stop() {
      if (stopped) return;
      const r = run;
      if (r) { r.controller.abort(); keepFrames(r.task.id, r.frames); }
      try { session.yieldAll("offline"); } catch { /* 连接已坏 */ }
      if (r) endRun(r, "released:offline");
      stopped = true;
      runner.stop("offline");
    },
    debug() {
      const sorted = [...frameMs].sort((a, b) => a - b);
      const r = run;
      const held = session.held();
      const state: BrowserNodeDebug["state"] = stopped || refused ? "off" : r && !r.ended ? (r.phase === "baking" ? "baking" : "busy") : "idle";
      return {
        state,
        reason: stopped ? "stopped" : refused ? `refused:${refused}` : !welcomed ? "hello" : r?.yieldCause ? `yield-${r.yieldCause}` : null,
        nodeId: deps.nodeId,
        envFingerprint: nodeDesc.envFingerprint,
        cardEnvFingerprint: nodeDesc.cardEnvFingerprint,
        cards: { runtime: cardsNow.runtime, userCards: nodeDesc.capabilities.userCards, graphCards: nodeDesc.capabilities.graphCards, sources: { ...cardsNow.sources } },
        streams: nodeDesc.capabilities.streams === true,
        codeVersion: deps.codeVersion,
        holding: held.map((h) => ({
          id: h.id, token: h.token,
          // 流任务的范围是分段号:按帧数报(宿主报的已做帧数 / 这一段任务的总帧数)
          done: r && r.task.id === h.id ? (r.task.kind === "stream" ? r.streamDone : r.frames.size) : 0,
          of: r && r.task.id === h.id && r.task.range ? (r.task.kind === "stream" ? streamTaskFrames(r.task)?.frames ?? 0 : r.task.range.to - r.task.range.from + 1) : 0,
          projectRev: r && r.task.id === h.id ? Number(r.task.source?.projectRev) : null,
        })),
        counters: {
          claims: counters.claims, completed: counters.completed, dedup: counters.dedup, failed: counters.failed, lost: counters.lost,
          bakedFrames: counters.bakedFrames, streamFrames: counters.streamFrames, streamTasks: counters.streamTasks, active: counters.active,
          released: { ...counters.released }, blocked: { ...counters.blocked },
          frameMs: { n: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95) },
        },
        lastError,
      };
    },
    working() { return !stopped && ((!!run && !run.ended) || session.held().length > 0); },
    get envFingerprint() { return nodeDesc.envFingerprint; },
    get cardEnvFingerprint() { return nodeDesc.cardEnvFingerprint; },
  };
}

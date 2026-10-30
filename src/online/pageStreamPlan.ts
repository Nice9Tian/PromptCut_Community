/**
 * 本页产流(任务书 `docs/plan/render-refactor-task.md`「甲二」)的**计划**:同一条单卡轨道流,页面一侧算出的结果键、
 * 流任务的形状、层表里的那一行,与切分方(桌面应用、渲染主机)算出的逐字段相同。
 *
 * 流的计划本来在服务端算(`server/card-cache.mjs` 的 `CardFrameCache.plan` → `server/frame-stream.mjs` 的 `planStreams` →
 * `server/render-node/split.mjs` 给浏览器出的那一份流任务 → `server/artifact-transfer.mjs` 的 `layerStreamsOf`),页面的构建不带
 * 服务端模块。这里把这条链上的**纯计算**照抄一份(先例:`planPublisher.ts` 对 `server/render-queue/messages.mjs`),由
 * `server/test/page-stream-plan.test.mjs` 拿同一份输入与服务端那几个函数逐字段对拍。服务端那一侧改了,这里要跟着改,对拍会红。
 *
 * # 键里和实现有关的两处,各只有一个地方
 *
 *   - **成员键** `streamMemberKey`:单卡流里代表「这张卡的内容」的那一项。与服务端 `CardFrameCache.plan` 的 `streamMemberKey` 相同
 *     (`cardSnapshotIdentity` 的那一份身份,不带生成快照的代码指纹:流的像素是截图来的,和快照 HTML 怎么生成无关)。
 *     别处不要自己再拼这个键;服务端的算法再换,只改这一个函数;
 *   - **流的代码版本** `streamCodeVersion`:`<STREAM_CODE_VERSION>:<截图代码的指纹>`。版本号 `PAGE_STREAM_CODE_VERSION` 与
 *     `server/frame-stream.mjs` 的 `STREAM_CODE_VERSION` 同值(对拍),截图代码的指纹由在线构建嵌进页面(`pageStreamCodes`)。
 *
 * # 页面只算哪些流
 *
 * 只算单卡流,而且只算切分方会给浏览器出一份的那些(`browser-stream-task.md` 第一处):共享档(有状态的卡)、独立卡、
 * 不是画布卡、框不带三维、序列没有隐藏。剪辑段里摊出来的独立卡(切分方单独成流的 `'flat'`)里外框平面的那些也算(〔裁〕R02:
 * 在线浏览器也替剪辑段里的重卡产流;切分方给浏览器出这一份,见 `render-node/split.mjs` 的 `browserStreamInputOf`):它们不并组流,
 * 照切分方的算法只算进预算、各出一条单卡流。清单里的卡超过解码器预算时照切分方同一个办法合并(`groupStreams`;切分方另出、页面不产的
 * 两种流——单独成流的两类卡、依赖下层的流——照同一份判据 `render/streamPlanRules.mjs` 算进预算),
 * 并进组流的卡页面不产(组流浏览器画不了)。另有两条比切分方更紧的(〔裁〕,见 `browser-stream-task.md`「本页产流」):
 * 只算页面自带的内置卡片(源码版本以 `builtin:` 开头;同步来的用户卡的源码版本页面一侧算不准,算错了改卡以后键不变),
 * 只算输出节点就是这张卡自己的片段(片段上另挂了滤镜、强调时输出节点是外面那一层,键里没有卡的参数)。
 *
 * 哈希用浏览器自带的 `crypto.subtle`(异步);Node 单测里同名的全局对象也有。本模块属于 render 这一层(`src/online/`):
 * 不引 editor,不碰注册表(卡片图与源码版本由调用方算好给进来),不碰舞台、网络。
 */
import { CARD_RUNTIME_ABI, selectedCardStyle } from "../kernel/cardGraph.mjs";
import { resolveFrameSize } from "../kernel/frameSize.mjs";
import { mountFrameOf } from "../render/frameWindow.mjs";
import { streamInputSig, streamSigStale } from "../render/streamInputSig.mjs";
import { isStreamOrigin, streamSegmentFrameCount, streamSegmentSpan, STREAM_SEGMENT_FRAMES } from "../render/streamSegments.mjs";
import { belowTargets, frame3d, mountClipOf, soloStreamKind, streamEligible } from "../render/streamPlanRules.mjs";
import { groupStreams, localStreamPixels, stageStreamPixels, streamCost, STREAM_COUNT_BUDGET, type StreamBudget, type StreamGroupItem } from "../render/streamBudget.mjs";
import { reviewedCard } from "../kernel/frameMode.mjs";
import { flatPlanProject } from "../kernel/cutFlatten.mjs";
import type { NodeTask, StreamTaskInput } from "./browserNode.ts";

/**
 * 与 `server/frame-stream.mjs` 的 `STREAM_CODE_VERSION` 同值(对拍)。2:「己一」起单卡流的成员键不带生成快照的代码指纹;
 * 3:分段从这条流自己的第一帧起每 15 帧一段(`render/streamSegments.mjs`),旧流全部重产;
 * 4:稀疏版每个分段只截第一帧、清单里每个分段带位置矩形 `box`。
 */
export const PAGE_STREAM_CODE_VERSION = 4;
/** 同屏流的条数上限:与 `server/frame-stream.mjs` 的 `STREAM_DECODER_BUDGET` 是同一个数(`render/streamBudget.mjs`);预算的口径(数像素)也在那里 */
export const PAGE_STREAM_DECODER_BUDGET = STREAM_COUNT_BUDGET;
/** 与 `server/frame-stream.mjs` 的 `LOCAL_OVERFLOW_PX` 同值 */
export const PAGE_LOCAL_OVERFLOW_PX = 32;
/** 一个流任务几个分段(与 `server/render-queue/constants.mjs` 的 `QUEUE_DEFAULTS.STREAM_SEGMENTS` 同值):流清单按它分份 */
export const PAGE_STREAM_SEGMENTS_PER_TASK = 8;
/** 层表的版本、快照段长(与 `server/artifact-transfer.mjs` 的 `LAYER_MAP_VERSION`、`QUEUE_DEFAULTS.SNAPSHOT_SPAN` 同值) */
export const PAGE_LAYER_MAP_VERSION = 3;
export const PAGE_SNAPSHOT_SPAN = 60;

/* ------------------------------------------------------------------ 在线构建嵌进页面的代码指纹 */

/** 流的键里和代码有关的那一项:截图代码的指纹(`server/frame-code.mjs` 的 `captureCode`,流的 `codeVersion` 里的后半) */
export interface StreamCodes { capture: string }

declare const __PC_STREAM_CODES__: { capture?: unknown } | undefined;

/**
 * 在线构建时由 `vite.config.ts` 用服务端同一套算法算出、以 `__PC_STREAM_CODES__` 嵌进页面的代码指纹;
 * 桌面构建、Node 单测里没有,回 null(本页不产流:算不出与切分方相同的键)。
 */
export function pageStreamCodes(): StreamCodes | null {
  const raw = typeof __PC_STREAM_CODES__ === "object" && __PC_STREAM_CODES__ ? __PC_STREAM_CODES__ : null;
  if (!raw || typeof raw.capture !== "string" || !raw.capture) return null;
  return { capture: raw.capture };
}

/* ------------------------------------------------------------------ 哈希(同 `server/frame-identity.mjs`) */

/** 与 `server/frame-identity.mjs` 的 `stableJson` 同一个式子:键排序、去掉 undefined */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stableJson(o[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

async function sha256Text(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let out = "";
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0");
  return out;
}

/** 与 `server/frame-identity.mjs` 的 `digest` 同值 */
export const digest = (value: unknown): Promise<string> => sha256Text(stableJson(value));

/** 结果键 = 内容键 × 环境指纹(与 `server/render-node/fingerprint.mjs` 的 `resultKeyOf` 同值) */
export const resultKeyOf = (contentKey: string, envFingerprint: string): Promise<string> => sha256Text(`${contentKey ?? ""}\n${envFingerprint ?? ""}`);

/* ------------------------------------------------------------------ 采样(同 `server/card-identity.mjs`) */

interface Ratio { numerator: string; denominator: string }
export interface CardSampling { firstFrame: number; fps: Ratio; phase: Ratio }

const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; while (b) { const next = a % b; a = b; b = next; } return a || 1n; };
const reduce = (n: bigint, d: bigint) => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; };
function decimal(value: number) {
  if (!Number.isFinite(value)) throw new Error("Non-finite card clock");
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value))!;
  const power = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  let n = BigInt(match[2] + (match[3] ?? "")) * (match[1] ? -1n : 1n), d = 1n;
  if (power >= 0) n *= 10n ** BigInt(power); else d = 10n ** BigInt(-power);
  return reduce(n, d);
}
const ceilDiv = (n: bigint, d: bigint) => (n >= 0n ? (n + d - 1n) / d : n / d);
const pair = (value: { n: bigint; d: bigint }): Ratio => ({ numerator: String(value.n), denominator: String(value.d) });
const ratio = (value: unknown): Ratio | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object") { const v = value as Ratio; return pair(reduce(BigInt(v.numerator), BigInt(v.denominator))); }
  return pair(decimal(Number(value)));
};

/** 与 `server/card-identity.mjs` 的 `cardSampling` 同值:入点落在帧与帧之间时,第一帧取入点之后的第一个采样点,相位记下差多少 */
export function cardSampling(start: number, fps: number): CardSampling {
  if (!(fps > 0)) throw new Error("Invalid card frame rate");
  const s = decimal(start), rate = decimal(fps);
  const first = ceilDiv(s.n * rate.n, s.d * rate.d);
  if (first > BigInt(Number.MAX_SAFE_INTEGER) || first < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("Card frame out of range");
  const phase = reduce(first * rate.d * s.d - s.n * rate.n, rate.n * s.d);
  return { firstFrame: Number(first), fps: pair(rate), phase: pair(phase) };
}

/* ------------------------------------------------------------------ 键 */

export interface StageSize { width: number; height: number; camera3dFov?: unknown }

/**
 * 单卡流的**成员键**(这张卡的内容身份;流的内容键拿它再加上时间上的摆放、画幅、帧率、流的代码版本)。
 *
 * 与服务端 `CardFrameCache.plan` 的 `streamMemberKey` 相同(`planStreams` 取它当成员键):`cardSnapshotIdentity` 的那一份身份,
 * 生成快照的代码指纹那一项是空串。片段身份(节点 id、输入、定义 id、片段 id)剥掉,参数、源码版本、片段时长、采样相位、帧率、框宽高、
 * 画幅、主题、字体指纹都在里面;位置、缩放、旋转、不透明度、淡入淡出、motion、强调不在(由包裹层加)。
 *
 * **整个页面一侧只有这一处拼成员键。** 服务端的算法再换,改这里,再把 `PAGE_STREAM_CODE_VERSION` 跟上,对拍单测就又对得上。
 */
export function streamMemberKey(o: {
  node: Record<string, unknown>;
  definition?: Record<string, unknown>;
  style: Record<string, unknown>;
  environment: Record<string, unknown>;
  sourceVersions: Readonly<Record<string, string>>;
  fps: number;
  sampling: CardSampling;
  duration: number;
  stage: { width: unknown; height: unknown; camera3dFov?: unknown };
  frame: { w?: number; h?: number } | undefined;
  themeId: unknown;
}): Promise<string> {
  const { id: _id, inputs: _inputs, definitionId: _definitionId, clipId: _clipId, ...stripped } = o.node ?? {};
  const usedStyle = o.definition ? selectedCardStyle(o.definition as never, o.style) : stripped.adapter === "chrome" ? o.style : {};
  const parent = { width: o.stage.width as number, height: o.stage.height as number };
  const size = resolveFrameSize(o.frame as never, parent);
  const cardId = typeof stripped.cardId === "string" ? stripped.cardId : "";
  return digest({
    abi: CARD_RUNTIME_ABI, environment: o.environment, node: stripped, definition: o.definition, style: usedStyle,
    sourceVersion: cardId ? o.sourceVersions[cardId] : undefined,
    inputs: {},
    snapshot: {
      fps: ratio(o.fps), phase: ratio(o.sampling.phase), duration: o.duration,
      stage: { width: parent.width, height: parent.height, camera3dFov: o.stage.camera3dFov },
      frame: { width: size.w, height: size.h },
      themeId: o.themeId, fontFingerprint: (o.environment?.fontFingerprint as string) || "", snapshotCode: "",
    },
  });
}

/** 流的代码版本(键里的 `codeVersion`):与 `frame-pipeline.mjs` 各处传给 `planStreams` 的那个串同形 */
export const streamCodeVersion = (codes: StreamCodes): string => `${PAGE_STREAM_CODE_VERSION}:${codes.capture || ""}`;

/** 单卡流的内容键(与 `server/card-identity.mjs` 的 `cardStreamIdentity({ kind: 'card', … })` 同值) */
export function cardStreamContentKey(o: { memberKey: string; sampling: CardSampling; count: number; fps: number; stage: StageSize; codeVersion: string }): Promise<string> {
  return digest({
    stream: 1, kind: "card", fps: ratio(o.fps), codeVersion: o.codeVersion,
    stage: { width: o.stage.width, height: o.stage.height, camera3dFov: o.stage.camera3dFov },
    members: [{ key: o.memberKey, firstFrame: o.sampling?.firstFrame, phase: o.sampling?.phase ? ratio(o.sampling.phase) : undefined, count: o.count, frame: undefined }],
  });
}

/* ------------------------------------------------------------------ 矩形与摆放(同 `server/frame-stream.mjs`) */

export interface Rect { x: number; y: number; w: number; h: number }
const rectOf = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) });
const intersectRect = (a: Rect, b: Rect) => rectOf(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.min(a.x + a.w, b.x + b.w), Math.min(a.y + a.h, b.y + b.h));
const padRect = (r: Rect, pad: number) => rectOf(r.x - pad, r.y - pad, r.x + r.w + pad, r.y + r.h + pad);

/** 整数化并外扩到偶数宽、偶数高,不出 `limit`(与服务端 `evenRect` 同一个式子) */
export function evenRect(r: Rect, limit: Rect): Rect {
  let x0 = Math.floor(r.x), y0 = Math.floor(r.y), x1 = Math.ceil(r.x + r.w), y1 = Math.ceil(r.y + r.h);
  const lx0 = limit.x, ly0 = limit.y, lx1 = limit.x + limit.w, ly1 = limit.y + limit.h;
  x0 = Math.max(x0, lx0); y0 = Math.max(y0, ly0); x1 = Math.min(x1, lx1); y1 = Math.min(y1, ly1);
  if (x1 - x0 < 2) { x1 = Math.min(lx1, x0 + 2); x0 = x1 - 2; }
  if (y1 - y0 < 2) { y1 = Math.min(ly1, y0 + 2); y0 = y1 - 2; }
  if ((x1 - x0) % 2) { if (x1 < lx1) x1++; else x0--; }
  if ((y1 - y0) % 2) { if (y1 < ly1) y1++; else y0--; }
  return rectOf(x0, y0, x1, y1);
}

/** 这张卡的框在隔离工程里摆到哪儿、流的矩形上界(与服务端 `localPlacement` 同一个式子) */
export function localPlacement(clip: { frame?: { w?: number; h?: number } }, stage: StageSize): { offset: { x: number; y: number }; bound: Rect } {
  const size = resolveFrameSize(clip.frame as never, stage);
  const w = Math.max(2, Math.ceil(size.w)), h = Math.max(2, Math.ceil(size.h));
  const ox = Math.max(0, Math.floor((stage.width - w) / 2));
  const oy = Math.max(0, Math.floor((stage.height - h) / 2));
  const view = { x: -ox || 0, y: -oy || 0, w: stage.width, h: stage.height };
  const bound = evenRect(intersectRect(view, padRect({ x: 0, y: 0, w, h }, PAGE_LOCAL_OVERFLOW_PX)), view);
  return { offset: { x: ox, y: oy }, bound };
}

/* ------------------------------------------------------------------ 画家顺序与组流(同 `server/frame-stream.mjs`) */

interface AnyClip { id: string; start: number; end: number; cardId?: string; mediaId?: string; frame?: any; [k: string]: any }
type AnyTrack = { id?: string; hidden?: boolean; sourceOnly?: boolean; clips?: AnyClip[] };
interface PaintLayer { clipId: string; order: number; from: number; to: number }

function paintLayers(project: { tracks?: AnyTrack[]; media?: { id: string; kind?: string }[] }, fps: number): PaintLayer[] {
  const tracks = project?.tracks ?? [];
  const media = new Map((project?.media ?? []).map((m) => [m.id, m]));
  const out: PaintLayer[] = [];
  tracks.forEach((track, ti) => {
    if (track.hidden || track.sourceOnly) return;
    (track.clips ?? []).forEach((clip, ci) => {
      const card = !!clip.cardId;
      const m = clip.mediaId ? media.get(clip.mediaId) : null;
      if (!card && !(m && m.kind !== "audio")) return;
      const from = card ? mountFrameOf(clip, fps) : Math.max(0, Math.floor(clip.start * fps));
      const to = Math.max(from, Math.ceil(clip.end * fps - 1e-9) - 1);
      out.push({ clipId: clip.id, order: (tracks.length - 1 - ti) * 1e6 + ci, from, to });
    });
  });
  return out.sort((a, b) => a.order - b.order);
}

/** 组流的合并在 `render/streamBudget.mjs`(`groupStreams`),与切分方用的是同一个函数 */
type Single = StreamGroupItem;

/* ------------------------------------------------------------------ 这一版的卡(同 `CardFrameCache.plan`) */

/** 页面一侧的「卡片计划」原料:与导出页 `window.__pcCardPlan()` 同形(`{ graph, sourceVersions, environment }`),由调用方算好 */
export interface PageCardPlanValue {
  graph: { nodes: Record<string, any>[]; outputs: Record<string, any>[]; definitions?: Record<string, any>[] };
  sourceVersions: Readonly<Record<string, string>>;
  environment: { width?: unknown; height?: unknown; fps?: unknown; theme?: unknown; fontFingerprint?: string };
  unknownClipIds?: readonly string[];
}

/** 与 `server/snapshot-tier.mjs` 的 `snapshotTier` 同一个式子 */
function snapshotTier(_caps: Record<string, any>): "none" | "shared" | "local" {
  return "none";
}

/** 这一版里一张卡的计划(`CardFrameCache.plan` 的 control 里页面要用到的那几项) */
export interface PageControl {
  clipId: string;
  cardId: string | null;
  nodeId: string;
  /** 输出节点(整形过的图节点) */
  node: Record<string, any>;
  definition?: Record<string, any>;
  capabilities: Record<string, any>;
  compositing: string;
  tier: "none" | "shared" | "local";
  frameMode?: "stateful" | "direct";
  needPrerendering?: boolean;
  start: number;
  end: number;
  count: number;
  sampling: CardSampling;
  frame: { w?: number; h?: number } | undefined;
}

/** 卡片图的每个输出 → 这张卡的采样窗口与能力(与 `CardFrameCache.plan` 同一个式子;键另算,见 `planPageStreams`) */
export function pageControls(project: { fps?: number }, value: PageCardPlanValue): PageControl[] {
  const graph = value?.graph;
  if (!graph?.nodes || !graph?.outputs) return [];
  const fps = Number(project.fps) || 30;
  const nodes = new Map(graph.nodes.map((node) => [node.id as string, node]));
  const definitions = new Map((graph.definitions || []).map((d) => [d.id as string, d]));
  const unknown = new Set(Array.isArray(value.unknownClipIds) ? value.unknownClipIds : []);
  const out: PageControl[] = [];
  for (const output of graph.outputs) {
    if (output?.clipId && unknown.has(output.clipId)) continue;
    const node = nodes.get(output.nodeId);
    const definition = definitions.get(node?.definitionId);
    const caps = output.capabilities || node?.capabilities || node?.definition?.capabilities || definition || {};
    const compositing = caps.compositing || node?.compositing || "unknown";
    const start = Number(output.start ?? node?.start ?? 0), end = Number(output.end ?? node?.end ?? start);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const sampling = cardSampling(start, fps);
    const phase = Number(sampling.phase.numerator) / Number(sampling.phase.denominator);
    const count = Math.max(1, Math.ceil((end - start - phase) * fps - 1e-9));
    const clipId = output.clipId || node?.clipId;
    if (!node || typeof clipId !== "string" || !clipId) continue;
    out.push({ clipId, cardId: typeof node.cardId === "string" ? node.cardId : null, nodeId: output.nodeId, node, definition, capabilities: caps, compositing,
      tier: snapshotTier(caps), frameMode: caps.frameMode, needPrerendering: caps.need_prerendering === true || caps.needPrerendering === true, start, end, count, sampling, frame: output.frame });
  }
  return out;
}

/* ------------------------------------------------------------------ 流的计划 */

/** 页面算出的一条单卡流(`planStreams` 的一项里页面要用到的字段,字段名相同) */
export interface PageStreamSpec {
  kind: "card";
  plane: "local";
  clipIds: [string];
  topClipId: string;
  cardId: string | null;
  contentKey: string;
  /** 结果键 = 内容键 × 本页的环境指纹 */
  streamKey: string;
  envFingerprint: string;
  fps: number;
  stage: StageSize;
  total: number;
  firstFrame: number;
  lastFrame: number;
  /** 这条流自己的第一帧(项目帧号):分段从它起每 15 帧一段(`render/streamSegments.mjs`),所以 `firstSegment` 恒为 0 */
  originFrame: number;
  firstSegment: number;
  lastSegment: number;
  offset: { x: number; y: number };
  bound: Rect;
  compositing: string;
  /** 隔离单卡工程要的参数(切分方写在浏览器那一份任务的 `input.bake` 里的) */
  bake: { start: number; end: number; count: number; sampling: CardSampling };
  writing?: "motion" | "remotion";
  frameMode?: "stateful" | "direct";
}

/** 判断卡或流是否为 motion 式卡（相对应为 remotion 式） */
export function isMotionCard(controlOrSpec: { writing?: string; frameMode?: string; cardId?: string | null; capabilities?: { writing?: string; frameMode?: string } } | null | undefined): boolean {
  if (!controlOrSpec) return true;
  const writing = controlOrSpec.writing ?? controlOrSpec.capabilities?.writing;
  if (writing === "remotion") return false;
  if (writing === "motion") return true;

  const cardId = controlOrSpec.cardId;
  if (cardId) {
    const rev = reviewedCard(cardId);
    if (rev?.writing === "remotion") return false;
    if (rev?.writing === "motion") return true;
  }

  const frameMode = controlOrSpec.frameMode ?? controlOrSpec.capabilities?.frameMode;
  if (frameMode === "direct") return false;
  if (frameMode === "stateful") return true;

  return false;
}


/** 为什么这张卡页面不产流(诊断用);能产回 null */
export function pageStreamBlock(control: PageControl, at: { clip: AnyClip; track: AnyTrack } | undefined, sourceVersions: Readonly<Record<string, string>>): string | null {
  if (!at) return "no-clip";
  if (at.track.hidden || at.track.sourceOnly) return "hidden-track";
  if (!at.clip.cardId) return "not-card";
  // 进不进流(`streamEligible`):独立卡、框不带三维、有帧
  if (control.compositing !== "independent") return "not-independent";
  if (frame3d(at.clip.frame)) return "frame-3d";
  if (!Number.isInteger(control.count) || control.count <= 0) return "no-frames";
  // 浏览器做不做得了(`split.mjs` 的 `browserEligible`):有状态/need_prerendering(轻卡不产流)、不是画布卡
  const caps = control.capabilities ?? {};
  const isStateful = control.tier === "shared" || control.frameMode === "stateful" || caps.frameMode === "stateful" || (control as any).needPrerendering === true || caps.need_prerendering === true || caps.needPrerendering === true;
  if (!isStateful) return "not-shared-tier";
  if (caps.canvasHeavy === true) return "canvas";
  // 〔裁〕比切分方更紧的两条:只算页面自带的内置卡片;只算输出节点就是这张卡自己的片段
  if (control.node.adapter !== "chrome" || control.node.clipId !== control.clipId) return "wrapped-node";
  if (!control.cardId || !String(sourceVersions[control.cardId] ?? "").startsWith("builtin:")) return "not-builtin";
  return null;
}

export interface PageStreamPlan {
  specs: PageStreamSpec[];
  /** 清单里没出流的片段 → 原因(`pageStreamBlock` 的原因,或 `grouped`:超过解码器预算并进了组流) */
  skipped: Record<string, string>;
}

/**
 * 这一版项目里,清单 `clips`(页面自己判重的片段)各自的单卡流。与切分方对清单计划算的(`planListStreams` 之后 `splitPlan`
 * 给浏览器出的那一份)是同一批流、同样的键:同一份 `value` 两边算,`contentKey`、`streamKey`、分段范围、矩形逐字段相同。
 * 没有指纹、没有代码指纹、算不出卡片图时回空。
 */
export async function planPageStreams(o: {
  project: Record<string, any>;
  value: PageCardPlanValue;
  clips: Iterable<string>;
  codes: StreamCodes | null;
  envFingerprint: string | null;
  budget?: StreamBudget;
}): Promise<PageStreamPlan> {
  const { codes, envFingerprint } = o;
  // 剪辑段换成它里面的卡(`kernel/cutFlatten.mjs`),与切分方的 `planStreams` 同一份视图(没有剪辑段时原样)
  const project = o.project ? flatPlanProject(o.project) : o.project;
  const empty: PageStreamPlan = { specs: [], skipped: {} };
  if (!project || !codes || typeof envFingerprint !== "string" || !envFingerprint) return empty;
  // 桌面那一侧的图是经调试协议从导出页取回来的(JSON 往返过一次):这里照样往返一次,函数、undefined 这类取不过去的值两边都没有
  const value = JSON.parse(JSON.stringify(o.value ?? null)) as PageCardPlanValue | null;
  if (!value?.graph) return empty;
  const listed = new Set(o.clips);
  const fps = Number(project.fps) || 30;
  const stage: StageSize = { width: Number(project.width) || 1920, height: Number(project.height) || 1080, camera3dFov: project.camera3dFov };
  const total = Math.max(1, Math.floor((Number(project.duration) || 0) * fps));
  const where = new Map<string, { clip: AnyClip; track: AnyTrack }>();
  for (const track of (project.tracks ?? []) as AnyTrack[]) for (const clip of track.clips ?? []) where.set(clip.id, { clip, track });
  const layers = paintLayers(project, fps);
  const orderOf = new Map(layers.map((l) => [l.clipId, l.order]));
  const skipped: Record<string, string> = {};
  // 进不进流照切分方的判据(`streamEligible`);合并也照它:预算按「清单里全部进流的卡」算,不只按页面能产的那几张
  const singles: (Single & { control: PageControl; clip: AnyClip })[] = [];
  // 切分方另出的两种流页面不产,只照切分方同一份判据(`render/streamPlanRules.mjs`)算进解码器预算:
  // 单独成流的两类卡(`soloStreamKind`,按它的单卡流矩形算开销)、依赖下层的流(`belowTargets`,按整幅画面算开销)
  const fixed: { from: number; to: number; cost: number }[] = [];
  const soloSeen = new Set<string>();
  // 剪辑段里外框平面的独立卡(切分方的 `'flat'`,〔裁〕R02):不并组流,照切分方只算进预算;页面也给它们各出一条单卡流
  const flats: { control: PageControl; clip: AnyClip; to: number }[] = [];
  const controls = pageControls(project, value);
  for (const control of controls) {
    if (!listed.has(control.clipId)) continue;
    const at = where.get(control.clipId);
    if (!at || !streamEligible(control, at.clip, at.track)) {
      const block = pageStreamBlock(control, at, value.sourceVersions ?? {}) ?? "not-eligible";
      const solo = at && !soloSeen.has(control.clipId) ? soloStreamKind(control, at.clip, at.track, project) : null;
      if (at && solo) {
        const first = control.sampling.firstFrame;
        const last = Math.min(total - 1, first + control.count - 1);
        // 回放起点同切分方:剪辑段里的卡从嵌套场景最早挂上的那一帧算(`mountClipOf`;别的卡就是它自己)
        if (last >= first) { soloSeen.add(control.clipId); fixed.push({ from: Math.min(mountFrameOf(mountClipOf(at.clip), fps), first), to: last, cost: streamCost(localStreamPixels(at.clip.frame, stage), fps) }); }
        if (last >= first && solo === "flat" && block === "not-eligible") { flats.push({ control, clip: at.clip, to: last }); continue; }
      }
      skipped[control.clipId] = block;
      continue;
    }
    const firstFrame = control.sampling.firstFrame;
    const lastFrame = Math.min(total - 1, firstFrame + control.count - 1);
    if (lastFrame < firstFrame) { skipped[control.clipId] = "past-end"; continue; }
    const mountFrame = mountFrameOf(at.clip, fps);
    singles.push({ control, clip: at.clip, clipIds: [control.clipId], order: orderOf.get(control.clipId) ?? 0, from: Math.min(mountFrame, firstFrame), to: lastFrame,
      cost: streamCost(localStreamPixels(at.clip.frame, stage), fps) });
  }
  singles.sort((a, b) => a.order - b.order);
  const byClip = new Map(singles.map((s) => [s.clipIds[0], s]));
  const stageCost = streamCost(stageStreamPixels(stage), fps);
  // 依赖下层的流:切分方缺省出(`belowStreamsEnabled`,环境变量只在预渲染进程那一侧能关),页面照缺省算
  for (const b of belowTargets(controls, { picked: (id) => listed.has(id), where, fps, total, orderOf, taken: soloSeen })) fixed.push({ from: b.from, to: b.to, cost: stageCost });
  const grouped = groupStreams(singles, layers, o.budget, fixed, stageCost);
  const codeVersion = streamCodeVersion(codes);
  const environment = (value.environment ?? {}) as Record<string, unknown>;
  const specs: PageStreamSpec[] = [];
  /** 一张卡的单卡流(包裹层自己的坐标系;外观不在流里),与切分方 `planStreams` 的 `cardSpec` 同一个式子 */
  const emit = async (control: PageControl, clip: AnyClip, to: number) => {
    const memberKey = await streamMemberKey({
      node: control.node, definition: control.definition, style: project.style || {}, environment, sourceVersions: value.sourceVersions ?? {},
      fps, sampling: control.sampling, duration: control.end - control.start,
      stage: { width: project.width, height: project.height, camera3dFov: project.camera3dFov },
      frame: control.frame, themeId: project.themeId,
    });
    const contentKey = await cardStreamContentKey({ memberKey, sampling: control.sampling, count: control.count, fps, stage, codeVersion });
    const streamKey = await resultKeyOf(contentKey, envFingerprint);
    const placement = localPlacement(clip, stage);
    const firstVisible = control.sampling.firstFrame;
    const isMotion = isMotionCard(control);
    specs.push({
      kind: "card", plane: "local", clipIds: [control.clipId], topClipId: control.clipId, cardId: control.cardId, contentKey, streamKey, envFingerprint,
      fps, stage, total, firstFrame: firstVisible, lastFrame: to,
      ...streamSegmentSpan(firstVisible, to),
      offset: placement.offset, bound: placement.bound, compositing: control.compositing,
      bake: { start: control.start, end: control.end, count: control.count, sampling: structuredClone(control.sampling) },
      writing: isMotion ? "motion" : "remotion",
      frameMode: (control.capabilities?.frameMode as any) || (isMotion ? "stateful" : "direct"),
    });
  };
  for (const g of grouped) {
    if (g.clipIds.length !== 1) { for (const id of g.clipIds) skipped[id] = "grouped"; continue; }
    const m = byClip.get(g.clipIds[0])!;
    const block = pageStreamBlock(m.control, where.get(m.control.clipId), value.sourceVersions ?? {});
    if (block) { skipped[m.control.clipId] = block; continue; }
    await emit(m.control, m.clip, m.to);
  }
  // 剪辑段里外框平面的独立卡(上面已按 `pageStreamBlock` 筛过:它只因为「不进组流」才没过)
  for (const f of flats) await emit(f.control, f.clip, f.to);
  return { specs, skipped };
}

/* ------------------------------------------------------------------ 流任务与层表的那一行 */

/** 稀疏流任务的名次(与 `server/render-node/split.mjs` 的 `SPARSE_STREAM_PRIORITY` 同一个数;单测对拍) */
export const PAGE_SPARSE_STREAM_PRIORITY = 30;
/** 稀疏流任务的密度记号(`input.density` 的值、id 的结尾;与 `server/render-queue/messages.mjs` 的 `STREAM_DENSITY_SPARSE` 同一个字) */
const STREAM_DENSITY_SPARSE = "sparse";

/** `[from, to]` 闭区间:first .. last 每 span 一段(与 `split.mjs` 的 `spans` 同一个式子)。若指定了 minSpan 且尾段不足 minSpan 则并入前一段 */
export function spansOf(first: number, last: number, span: number, minSpan = 1): [number, number][] {
  const out: [number, number][] = [];
  const step = Math.max(1, Math.floor(Number(span) || 0));
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return out;
  for (let from = first; from <= last; from += step) out.push([from, Math.min(last, from + step - 1)]);
  if (minSpan > 1 && out.length > 1) {
    const lastSpan = out[out.length - 1];
    if (lastSpan[1] - lastSpan[0] + 1 < minSpan) {
      out[out.length - 2][1] = lastSpan[1];
      out.pop();
    }
  }
  return out;
}

/**
 * 这条流的流任务,每 `PAGE_STREAM_SEGMENTS_PER_TASK` 个分段一个:id、结果键、范围、`input` 与切分方给浏览器出的那一份逐字段相同
 * (`split.mjs`;`input.dual` 是切分方两份都出时才带的,页面这里没有另一份,不带)。本页不经队列自己做这些任务;之后有切分方接了活、
 * 把同一个任务发进队列时 id 相同,本页已经推完的分段按任务 id 留着,认领之后只补缺的。
 *
 * `o.density: 'sparse'`:出这条流的**稀疏流任务**(每个分段只截第一帧),形状同切分方出的稀疏流任务:范围与满密度任务逐个相同
 * (内容库里的清单键相同)、id 末尾多 `:sparse`、`input.density: 'sparse'`、`priority` 30(`split.mjs` 的 `SPARSE_STREAM_PRIORITY`)。
 * 不给是满密度任务,与原来逐字相同。
 */
export function pageStreamTasks(spec: PageStreamSpec, o: { projectId: string; projectRev: number; codeVersion?: string | null; derivedFrom?: string | null; density?: "sparse" | null }): NodeTask[] {
  const sparse = o.density === STREAM_DENSITY_SPARSE;
  const isMotion = isMotionCard(spec);
  const fps = Number(spec.fps) > 0 ? Number(spec.fps) : 30;
  const motionSpan = Math.ceil(30 * fps / STREAM_SEGMENT_FRAMES);
  const span = sparse
    ? Math.max(1, spec.lastSegment - spec.firstSegment + 1)
    : isMotion
      ? motionSpan
      : PAGE_STREAM_SEGMENTS_PER_TASK;
  const minSpan = (!sparse && isMotion) ? motionSpan : 1;
  const stream: StreamTaskInput = { kind: "card", plane: "local", clipIds: [spec.topClipId], fps: spec.fps, bound: { ...spec.bound }, offset: { ...spec.offset },
    firstFrame: spec.firstFrame, count: spec.bake.count, total: spec.total, originFrame: spec.originFrame, lastFrame: spec.lastFrame };
  return spansOf(spec.firstSegment, spec.lastSegment, span, minSpan).map(([from, to]) => {
    const range = { unit: "segment", from, to };
    // 这一段任务的帧数:每个分段按它实际的帧数(流的末段可以不满 15 帧),与切分方算的同一个数
    let frames = 0;
    for (let n = from; n <= to; n++) frames += streamSegmentFrameCount(n, spec.originFrame, spec.lastFrame);
    return {
      id: `stream:${spec.streamKey}:${from}-${to}${sparse ? `:${STREAM_DENSITY_SPARSE}` : ""}`, kind: "stream", resultKey: spec.streamKey, range,
      source: { projectId: o.projectId, projectRev: o.projectRev, derivedFrom: o.derivedFrom ?? null },
      input: { clipId: spec.topClipId, cardId: spec.cardId ?? null, entryKey: null, contentKey: spec.contentKey, canvasHeavy: false,
        ...(sparse ? { density: STREAM_DENSITY_SPARSE } : {}),
        compositing: spec.compositing, bake: structuredClone(spec.bake), stream: structuredClone(stream) },
      weight: { class: "medium", estMs: null, frames },
      requires: { envFingerprint: spec.envFingerprint, ...(o.codeVersion ? { codeVersion: o.codeVersion } : {}), cardSources: {}, transcode: false,
        userCards: false, graphCards: false, belowDependent: false, capabilities: { streams: true } },
      priority: sparse ? PAGE_SPARSE_STREAM_PRIORITY : 10,
    } as NodeTask;
  });
}

/** 层表 `streams` 表的一行(与 `server/artifact-transfer.mjs` 的 `layerStreamsOf` 写出来的同形) */
export interface PageStreamRow {
  topClipId: string;
  clipIds: string[];
  kind: "card";
  plane: "local";
  contentKey: string;
  candidates: { envFingerprint: string; resultKey: string }[];
  /** 这条流自己的第一帧(项目帧号)。行里不写 `firstSegment`(恒为 0;理由见 `layerStreamsOf`) */
  originFrame: number;
  lastSegment: number;
  segmentsPerTask: number;
  inputSig?: string;
}

/** 这条流在层表里的那一行;候选只有本页这一份(合进现有层表时再与别人的候选并,见 `mergeLayerStreams`) */
export function pageStreamRow(project: unknown, spec: PageStreamSpec): PageStreamRow {
  const inputSig = streamInputSig(project, { clipIds: spec.clipIds, kind: spec.kind });
  return { topClipId: spec.topClipId, clipIds: [...spec.clipIds], kind: "card", plane: "local", contentKey: spec.contentKey,
    candidates: [{ envFingerprint: spec.envFingerprint, resultKey: spec.streamKey }],
    originFrame: spec.originFrame, lastSegment: spec.lastSegment, segmentsPerTask: PAGE_STREAM_SEGMENTS_PER_TASK, ...(inputSig ? { inputSig } : {}) };
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 把本页的几行并进内容库里现有的层表(没有切分方时层表没人写,由本页写它的 `streams` 那一部分)。回要写回去的整张表;
 * 现有的表已经含这几行(本页的候选都在、排在最前)时回 null,不用写。
 *
 *   - 现有的表不是认得的层表(没有、版本不认识、别的项目的):新写一张,`layers` 是空的(本页不写快照层);
 *   - 别的字段、`layers`、别的卡的流一个字不动,先后也不动(两个页面各写各的卡时不来回倒);
 *   - 同一张卡、同一个内容键的行:本页的候选提到最前(这一份是实际产出来的;之后才进来的页面取第一个候选),别人的候选留在后面;
 *   - 同一张卡、别的内容键的行:输入签名过期的(旧参数的流)去掉;没过期的(别的环境按它自己的键产的同一条流)留着,排在本页那一行后面
 *     (同一张卡列两行时页面只认第一行)。
 */
export function mergeLayerStreams(existing: unknown, o: { project: Record<string, any>; rows: readonly PageStreamRow[]; now: number }): Record<string, unknown> | null {
  const { project, rows } = o;
  if (!rows.length) return null;
  const usable = isObj(existing) && existing.kind === "layer-map" && Array.isArray(existing.layers) && existing.v === PAGE_LAYER_MAP_VERSION
    && (existing.projectId == null || existing.projectId === (project.id ?? null));
  const base: Record<string, unknown> = usable ? { ...(existing as Record<string, unknown>) } : {
    v: PAGE_LAYER_MAP_VERSION, kind: "layer-map", projectId: project.id ?? null, entryKey: null,
    fps: Number(project.fps) || 30, width: Number(project.width) || null, height: Number(project.height) || null,
    span: PAGE_SNAPSHOT_SPAN, at: o.now, layers: [],
  };
  const old: Record<string, any>[] = usable && Array.isArray((existing as Record<string, unknown>).streams) ? ((existing as Record<string, unknown>).streams as Record<string, any>[]).filter(isObj) : [];
  const mine = new Map(rows.map((r) => [r.topClipId, r]));
  /** 本页这一行,候选并上现有同内容键那几行里别人的候选(本页的在前) */
  const mergedRow = (next: PageStreamRow): Record<string, any> => {
    const others = old.filter((row) => row.topClipId === next.topClipId && row.contentKey === next.contentKey)
      .flatMap((row) => (Array.isArray(row.candidates) ? row.candidates : []))
      .filter((c: any, i: number, all: any[]) => isObj(c) && !next.candidates.some((m) => m.resultKey === c.resultKey) && all.findIndex((x: any) => x?.resultKey === c.resultKey) === i);
    return { ...next, candidates: [...next.candidates, ...others] };
  };
  const merged: Record<string, any>[] = [];
  const placed = new Set<string>();
  for (const row of old) {
    const next = typeof row.topClipId === "string" ? mine.get(row.topClipId) : undefined;
    if (!next) { merged.push(row); continue; }
    // 这张卡的第一行所在的位置放本页的那一行
    if (!placed.has(next.topClipId)) { merged.push(mergedRow(next)); placed.add(next.topClipId); }
    if (row.contentKey === next.contentKey) continue;
    if (streamSigStale(row.inputSig, next.inputSig)) continue;
    merged.push(row);
  }
  const fresh = rows.filter((r) => !placed.has(r.topClipId)).map((r) => ({ ...r, candidates: [...r.candidates] }));
  const streams = [...fresh, ...merged];
  if (usable && JSON.stringify(streams) === JSON.stringify(old)) return null;
  return { ...base, at: o.now, streams };
}

/** 层表里这张卡的一条现成的流的一个候选,连同那一行的分段范围(它的清单按这个范围分份) */
export interface LayerStreamCandidate { envFingerprint: string; resultKey: string; firstSegment: number; lastSegment: number; segmentsPerTask: number }

/**
 * 现有的层表里,这张卡此刻**能播的**单卡流有哪些候选(「先查」用:哪种环境产的都算)。能播的判据与在线来源播放时的相同
 * (`snapshotSource.ts` 的 `streamStale`):同一个内容键,或者输入签名没有过期(那一行没带签名也算)。别的环境算出的内容键可能与本页的不同
 * (代码版本不同、加载的字体不同),但它的输入签名对得上、页面本来就会播它 —— 有了就不必再产。
 * 没带 `originFrame` 的行不算(改分段规则之前的节点写的,在线来源不播它,`parseLayerStreams`);分段号从 0 起。
 */
export function layerStreamCandidates(existing: unknown, row: { topClipId: string; contentKey: string; inputSig?: string | null }): LayerStreamCandidate[] {
  if (!isObj(existing) || existing.kind !== "layer-map" || !Array.isArray(existing.streams)) return [];
  const out: LayerStreamCandidate[] = [];
  for (const r of existing.streams as Record<string, any>[]) {
    if (!isObj(r) || r.topClipId !== row.topClipId || r.kind !== "card") continue;
    if (r.contentKey !== row.contentKey && streamSigStale(r.inputSig, row.inputSig)) continue;
    const firstSegment = 0, lastSegment = Number(r.lastSegment), segmentsPerTask = Number(r.segmentsPerTask);
    if (!isStreamOrigin(r.originFrame) || !Number.isInteger(lastSegment) || lastSegment < firstSegment || !Number.isInteger(segmentsPerTask) || segmentsPerTask < 1) continue;
    for (const c of Array.isArray(r.candidates) ? r.candidates : []) {
      if (isObj(c) && typeof c.envFingerprint === "string" && c.envFingerprint && typeof c.resultKey === "string" && c.resultKey && !out.some((x) => x.resultKey === c.resultKey)) {
        out.push({ envFingerprint: c.envFingerprint, resultKey: c.resultKey, firstSegment, lastSegment, segmentsPerTask });
      }
    }
  }
  return out;
}

/** 这个候选的清单里,盖住分段 `[from, to]` 的那几份的范围;候选的分段范围没把它盖全回 null */
export function candidateSpans(cand: LayerStreamCandidate, from: number, to: number): [number, number][] | null {
  if (cand.firstSegment > from || cand.lastSegment < to) return null;
  return spansOf(cand.firstSegment, cand.lastSegment, cand.segmentsPerTask).filter(([a, b]) => a <= to && b >= from);
}

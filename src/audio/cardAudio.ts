/** 素材效果卡音频按片段本地的采样块取,块协议不变,只是求值搬回了页面里。这个文件刻意是它
 * 唯一的浏览器适配层:素材效果卡音频节点还在算或者算失败时,消费方绝不拿 media.url 顶上。 */
import { opacityAt, type MediaAsset, type Project, type TrackClip } from "../kernel/project";
import type { CardDef } from "../kernel/types";
import { cyrb53 } from "../render/cyrb53.mjs";
import { evaluateCardAudio, type AudioSourceContext } from "../render/cards/audioSources";
import { syncedUserCards, onSyncedUserCardsChanged } from "../kernel/registry";
import { onlinePage } from "../online/pageFlag";
import { ONLINE_CARD_AUDIO_BLOCKED, onlineCardAudioRunnable } from "../online/soundPolicy";
import { projectCardGraph, cardJson } from "../kernel/cardGraph.mjs";
import { clipHasEmbeddedAudio, cardAudioIdentity, resolveCardAudioRendition, assertAudiovisualCardKind } from "../kernel/cardAudioRendition.mjs";
import { audioProjectOf } from "../kernel/cutAudio.mjs";
import { speedMutesSource, withMediaRates } from "../kernel/clipTime.mjs";

export const CARD_AUDIO_SAMPLE_RATE = 48000 as const;
export const CARD_AUDIO_MAX_BLOCK_FRAMES = 1_048_576;
export type CardAudioRequest = { project: unknown; nodeId: string; start: number; count: number; sampleRate: typeof CARD_AUDIO_SAMPLE_RATE };
/** 采样块留在内存:`samples` 是交错(frame-major)的 Float32。`url` 只有租约那条路才有 */
export type CardAudioReply = { samples: Float32Array; url?: string; format: "wav"; sampleRate: number; frames: number; channels: number };
export class CardAudioError extends Error {
  readonly code: "pending" | "invalid-reply" | "request-failed";
  constructor(code: "pending" | "invalid-reply" | "request-failed", message: string) { super(message); this.code = code; }
}

/* ------------------------------------------------------------------ *
 * 定义和源码版本:模块级注入,不逐层传参
 * ------------------------------------------------------------------ */

export interface CardAudioHooks {
  getCard: (id: string) => CardDef<any> | undefined;
  sourceVersionOf: (id: string) => string;
}

let hooks: CardAudioHooks | null = null;
let epoch = 0;
const epochListeners = new Set<() => void>();
onSyncedUserCardsChanged(() => { epoch++; for (const listener of [...epochListeners]) listener(); });

/**
 * `src/cards/index.ts` 加载时调一次(HMR 重跑会再调)。每调一次 `cardAudioEpoch` +1 ——
 * 换卡之后 `project` 引用不变,靠它让预览的 effect 重跑、重新取块。
 */
export function configureCardAudio(next: CardAudioHooks) {
  hooks = next;
  epoch++;
  for (const listener of [...epochListeners]) listener();
}

/** `useSyncExternalStore` 的 getSnapshot */
export function getCardAudioEpoch(): number { return epoch; }

/** `useSyncExternalStore` 的 subscribe */
export function subscribeCardAudioEpoch(listener: () => void): () => void {
  epochListeners.add(listener);
  return () => { epochListeners.delete(listener); };
}

export function requireCardAudioHooks(): CardAudioHooks {
  if (!hooks) throw new CardAudioError("request-failed", "card audio hooks not configured");
  return hooks;
}

/* ------------------------------------------------------------------ *
 * 同步来的用户卡与素材效果卡:声音在隔离的声音线程里合成(`docs/plan/online-card-exec-contract.md` 3.5、第 6 节)
 * ------------------------------------------------------------------ */

/**
 * 隔离的声音宿主(在线页面:后台舞台起的专用后台线程,经舞台 RPC 接过来)。编辑页面的源里**不执行**同步来的卡的 `audio()`:
 * 这里只把「项目、节点、采样范围」交给它,收回 Float32 采样块。打包成 WAV、上传、提交产物记录仍在编辑页面做。
 * 没接(本页没有隔离环境、桌面运行环境)时为 null,同步来的卡的声音照旧只用已入库的产物。
 */
export interface IsolatedCardAudioHost {
  /** 这张卡的声音代码此刻在声音线程里载入成功、能合成 */
  runnable(cardId: string): boolean;
  /** 合成不了的原因(给面板:顶层用了声音线程里没有的模块、载入出错、超时);能合成或不认得这张卡回 null */
  blocker?(cardId: string): string | null;
  /** 这张卡这一代声音代码的签名(块缓存的键:换代后旧块作废) */
  versionOf(cardId: string): string;
  render(request: CardAudioRequest, signal?: AbortSignal): Promise<Float32Array>;
}

let isolatedHost: IsolatedCardAudioHost | null = null;
/** 接上 / 撤下隔离的声音宿主;宿主里哪些卡能合成变了也再叫一次(预览据 `cardAudioEpoch` 重新取块) */
export function setIsolatedCardAudioHost(host: IsolatedCardAudioHost | null): void {
  isolatedHost = host;
  epoch++;
  for (const listener of [...epochListeners]) listener();
}
export function isolatedCardAudioHost(): IsolatedCardAudioHost | null { return isolatedHost; }

export const SYNCED_AUDIO_NOT_HERE = "同步来的卡的声音代码不在编辑页面里执行";
export const ONLINE_AUDIO_NEEDS_MEDIA = "这张卡要读素材的声音采样,在线页面取不到,用已经生成的声音(没有就由渲染节点提供)";
export const ONLINE_AUDIO_NO_THREAD = "这个页面没有隔离的声音线程,用户卡与素材效果卡的声音用已经生成的(没有就由渲染节点提供)";
export const ONLINE_AUDIO_MIXED = "同步来的卡与内置卡串在一起的声音在线合成不了,用已经生成的声音(没有就由渲染节点提供)";

/**
 * 同步来的有声用户卡在编辑页面里的替身:只给「把项目摊成图、算身份」用(要有 `audio` 才会合成素材效果卡节点,要有默认参数才算得出身份)。
 * 它的 `audio()` 一调就抛 —— 编辑页面的源里永远不会真去执行同步来的卡的声音代码;真的定义只在声音线程里。
 */
const standIns = new WeakMap<object, CardDef<any>>();
function StandInComponent() { return null; }
function syncedAudioStandIn(id: string): CardDef<any> | undefined {
  const entry = syncedUserCards().get(id);
  if (!entry?.embeddedAudio) return undefined;
  let def = standIns.get(entry);
  if (!def) {
    def = { id, name: entry.name, source: "user", defaults: entry.defaults ?? {}, controls: [], kind: "animation", inputs: {}, Component: StandInComponent,
      audio: () => { throw new CardAudioError("request-failed", SYNCED_AUDIO_NOT_HERE); } } as unknown as CardDef<any>;
    standIns.set(entry, def);
  }
  return def;
}

/** 摊图、算身份用的取卡:页面里有定义的用定义;没有的、同步来的有声用户卡给替身 */
export function cardAudioGraphCard(id: string): CardDef<any> | undefined {
  return hooks?.getCard(id) ?? syncedAudioStandIn(id);
}

/** 一张卡的声音源码版本:页面里有定义的照旧;同步来的取声音线程里这一代的签名,没接宿主时取静态解析出来的那一个 */
function audioVersionOfCard(id: string): string {
  if (hooks?.getCard(id)) return hooks.sourceVersionOf(id);
  return isolatedHost?.versionOf(id) || syncedUserCards().get(id)?.audioSourceVersion || "";
}

/** 持久声音的身份用的那一对(`cardAudioIdentity`):同步来的卡用替身的默认参数与内容库里的声音源码版本(与桌面同一算法) */
export function cardAudioIdentityHooks(): CardAudioHooks {
  const ready = requireCardAudioHooks();
  return { getCard: cardAudioGraphCard, sourceVersionOf: (id) => (ready.getCard(id) ? ready.sourceVersionOf(id) : syncedUserCards().get(id)?.audioSourceVersion ?? ready.sourceVersionOf(id)) };
}

export type CardAudioRoute = { route: "page" | "isolated"; reason?: undefined } | { route: null; reason: string };

/**
 * 在线页面:这个音频节点连同它的整条上游,在哪里合成。
 *   - `page`:全是页面里有定义、放开了的卡(内置卡)→ 编辑页面自己求值;
 *   - `isolated`:全是同步来的、声音线程里载入成功的卡 → 交给隔离的声音宿主;
 *   - null:合成不了(一路上有素材输入、有没放开或没载入的卡、两种卡串在一起),`reason` 给面板。
 * 只回答「在哪里跑、能不能跑」,轻重另判(`src/editor/io/onlineSoundJudge.ts`)。
 */
export function cardAudioRoute(project: unknown, nodeId: string): CardAudioRoute {
  const ready = hooks;
  if (!ready || !nodeId) return { route: null, reason: ONLINE_CARD_AUDIO_BLOCKED };
  let nodes: ReturnType<typeof projectCardGraph>["nodes"];
  try { nodes = projectCardGraph(project, cardAudioGraphCard).nodes; } catch { return { route: null, reason: ONLINE_CARD_AUDIO_BLOCKED }; }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  let page = 0, isolated = 0;
  const walk = (id: string): string | null => {
    if (seen.has(id)) return null;
    seen.add(id);
    const node = byId.get(id);
    if (!node) return ONLINE_CARD_AUDIO_BLOCKED;
    if (node.adapter !== "card" || typeof node.cardId !== "string") return ONLINE_AUDIO_NEEDS_MEDIA;
    const def = ready.getCard(node.cardId);
    if (def) {
      if (!onlineCardAudioRunnable(def)) return ONLINE_CARD_AUDIO_BLOCKED;
      page++;
    } else {
      if (!isolatedHost) return ONLINE_AUDIO_NO_THREAD;
      if (!isolatedHost.runnable(node.cardId)) return isolatedHost.blocker?.(node.cardId) ?? ONLINE_CARD_AUDIO_BLOCKED;
      isolated++;
    }
    for (const ref of Object.values(node.inputs ?? {})) {
      const next = typeof ref === "string" ? ref : (ref as { nodeId?: unknown } | null)?.nodeId;
      if (typeof next !== "string") return ONLINE_AUDIO_NEEDS_MEDIA;
      const bad = walk(next);
      if (bad) return bad;
    }
    return null;
  };
  const bad = walk(nodeId);
  if (bad) return { route: null, reason: bad };
  if (page && isolated) return { route: null, reason: ONLINE_AUDIO_MIXED };
  return { route: isolated ? "isolated" : "page" };
}

/** 声音线程回来的采样块当不可信输入:形状不对、带非有限值的一律不要 */
function checkedIsolatedBlock(samples: unknown, count: number): Float32Array {
  if (!(samples instanceof Float32Array) || samples.length < 1 || samples.length % count !== 0 || samples.length / count > 8) throw new CardAudioError("invalid-reply", "声音线程回的采样块形状不对");
  for (let i = 0; i < samples.length; i++) if (!Number.isFinite(samples[i])) throw new CardAudioError("invalid-reply", "声音线程回的采样块里有无效的值");
  return samples;
}

/**
 * 这个节点的声音由谁求一块:在线页面按 `cardAudioRoute`;桌面运行环境恒在页面里求。合成不了时抛出原因。
 * 测量(`onlineSoundJudge.ts`)、生成持久产物(`renderEmbeddedCardWav`)、预览取块(`requestCardAudio`)都经这里,
 * 所以同步来的卡的 `audio()` 只会在隔离的声音宿主里跑。
 */
export function cardAudioBlockRenderer(project: unknown, nodeId: string, signal?: AbortSignal): (start: number, count: number) => Promise<Float32Array> {
  const ready = requireCardAudioHooks();
  const routed: CardAudioRoute = onlinePage() ? cardAudioRoute(project, nodeId) : { route: "page" };
  if (routed.route === null) throw new CardAudioError("request-failed", routed.reason);
  if (routed.route === "isolated") {
    const host = isolatedHost!;
    return async (start, count) => checkedIsolatedBlock(await host.render({ project, nodeId, start, count, sampleRate: CARD_AUDIO_SAMPLE_RATE }, signal), count);
  }
  let context: AudioSourceContext | null = null;
  return (start, count) => {
    context ??= { graph: audioGraphOf(project, ready.getCard), project: project as Pick<Project, "tracks" | "media">, getCard: ready.getCard, sampleRate: CARD_AUDIO_SAMPLE_RATE, signal };
    return evaluateCardAudio(context, nodeId, { start, count, sampleRate: CARD_AUDIO_SAMPLE_RATE });
  };
}

/**
 * 求声音用的图:和画面同一份(`projectCardGraph` 之后接 `withMediaRates`)。挂在变速素材段上的声画一体卡,
 * 卡片时钟在这里换成 mediaOffset ÷ speed(`kernel/clipTime.mjs` 的 `cardClockOffset`),和画面、已生成声音的对位同一个口径。
 * 没有变速段时 `withMediaRates` 回同一个对象,图一个字节不变。
 */
function audioGraphOf(project: unknown, getCard: (id: string) => CardDef<any> | undefined) {
  return withMediaRates(project, projectCardGraph(project, getCard));
}

const projectBlocks = new WeakMap<object, Map<string, Promise<CardAudioReply>>>();
interface CachedClip { promise: Promise<string>; url?: string; refs: number; }
const projectClips = new WeakMap<object, Map<string, CachedClip>>();

/**
 * 缓存键带素材效果卡源码版本:改了素材效果卡源码之后 `project` 对象不变,不带它就一直播旧采样块
 * 和旧 `blob:`。沿 `inputs[*]` 向上游走,只收 `adapter === 'card'` 的节点(素材节点没有源码)。
 */
function versionKeyOf(project: unknown, nodeId: string): string {
  requireCardAudioHooks();
  const nodes = projectCardGraph(project, cardAudioGraphCard).nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>(), cardIds = new Set<string>();
  const walk = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const node = byId.get(id);
    if (!node) return;
    if (node.adapter === "card" && typeof node.cardId === "string") cardIds.add(node.cardId);
    for (const ref of Object.values(node.inputs ?? {})) {
      // 生节点的 ref 可能是字符串简写(cardGraph.d.mts:11 是 CardInput | string)
      const next = typeof ref === "string" ? ref : (ref as { nodeId?: unknown } | null)?.nodeId;
      if (typeof next === "string") walk(next);
    }
  };
  walk(nodeId);
  return cyrb53([...cardIds].sort().map((id) => `${id}\u0000${audioVersionOfCard(id)}`).join("\u0001"));
}

const key = (x: CardAudioRequest) => `${versionKeyOf(x.project, x.nodeId)}:${cyrb53(cardJson(audioGraphOf(x.project, cardAudioGraphCard)))}:${x.nodeId}:${x.start}:${x.count}:${x.sampleRate}`;
const ownerOf = (project: unknown): object => {
  if (!project || (typeof project !== "object" && typeof project !== "function")) throw new CardAudioError("invalid-reply", "card audio project must be an object");
  return project as object;
};

/** True only for a graph card node explicitly declared as an audio card. */
export function isCardAudioNode(project: Pick<Project, "cardNodes">, nodeId: string | undefined): nodeId is string {
  if (!nodeId) return false;
  const node = project.cardNodes?.find((x) => x.id === nodeId);
  return node?.adapter === "card" && (node.kind === "audio" || node.embeddedAudio === true || typeof hooks?.getCard(node.cardId ?? "")?.audio === "function");
}

export function cardAudioNodeOf(project: Pick<Project, "cardNodes">, clip: Pick<TrackClip, "nodeId"> & Partial<TrackClip>): string | null {
  if (clipHasEmbeddedAudio(project, clip, hooks?.getCard) || (!hooks?.getCard(clip.cardId ?? "") && syncedUserCards().get(clip.cardId ?? "")?.embeddedAudio)) return clip.nodeId ?? `@clip/${clip.id}/card`;
  if (typeof hooks?.getCard(clip.cardId ?? "")?.audio === "function") return clip.nodeId ?? `@clip/${clip.id}/card`;
  return isCardAudioNode(project, clip.nodeId) ? clip.nodeId : null;
}

/**
 * 在线页面:这个音频节点连同它的整条上游,本页能不能合成(在编辑页面里,或在隔离的声音线程里;`cardAudioRoute`)。
 * 只回答「能不能跑」,轻重另判(`src/editor/io/onlineSoundJudge.ts`)。
 */
export function onlineCardAudioSynthesizable(project: unknown, nodeId: string): boolean {
  return cardAudioRoute(project, nodeId).route !== null;
}

/** 在线页面:这个节点的声音合成不了的原因(给面板);能合成回 null */
export function onlineCardAudioBlocker(project: unknown, nodeId: string): string | null {
  const routed = cardAudioRoute(project, nodeId);
  return routed.route === null ? routed.reason : null;
}

/** A generated node owns a video-backed clip's audio too; callers must mute that native media element. */
export function shouldMuteNativeAudio(project: Project, clip: TrackClip, globallyMuted = false) {
  // 变速的素材段不出原声(〔裁〕第一版,kernel/clipTime.mjs)
  return globallyMuted || !!clip.audioMuted || speedMutesSource(clip, project) || !!cardAudioNodeOf(project, clip);
}

/** Active generated audio is independent of whether its source happened to be an audio asset, video, or no media asset. */
export function generatedCardAudioClipsAt(project: Project, t: number): { clip: TrackClip; media?: MediaAsset; volume: number }[] {
  const out: { clip: TrackClip; media?: MediaAsset; volume: number }[] = [];
  // 变速的视频段上挂的卡片声音照常出:音频素材效果卡(2026-10-23 用户定「放开。」)与声画一体卡(同日用户定「出声。」)
  // 读这一段素材时随倍率变速变调(`render/cards/audioSources.ts` 的 `varispeedBlock`),声画一体卡的卡片时钟见 `kernel/clipTime.mjs` 的 `cardClockOffset`
  // 在线浏览器模式:素材效果卡(含音频素材效果卡)在这台设备上渲染不了(C10 契约第 9 节,由渲染节点出),
  // 不求值、不发 `/@media/<hash>/pcm` 请求;这一段的原生声音照旧被 `shouldMuteNativeAudio` 静掉,不拿素材声音顶上
  for (const track of project.tracks) for (const clip of track.clips) {
    if (track.hidden || track.muted || clip.audioMuted || !cardAudioNodeOf(project, clip) || t < clip.start || t >= clip.end) continue;
    out.push({ clip, media: clip.mediaId ? project.media.find(m => m.id === clip.mediaId) : undefined, volume: opacityAt(clip, t) * (clip.audioVolume ?? 1) });
  }
  return out;
}

function isSameOriginOrBlob(url: string): boolean {
  if (url.startsWith("/")) return true;
  if (url.startsWith("blob:")) return true;
  try { return typeof location !== "undefined" && new URL(url, location.href).origin === location.origin; } catch { return false; }
}

/**
 * 页内求值:找到节点 → 注册表里的定义 → `audio(sources, { start, count, sampleRate }, params)`。
 * `fetchImpl` 保留在签名里只为不动消费方(`renderMix.ts:61` 还按老样子传),块本身不再走 HTTP。
 */
export async function requestCardAudio(x: CardAudioRequest, signal?: AbortSignal, _fetchImpl: typeof fetch = fetch): Promise<CardAudioReply> {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  if (!Number.isSafeInteger(x.start) || !Number.isSafeInteger(x.count) || x.count < 1 || x.count > CARD_AUDIO_MAX_BLOCK_FRAMES) throw new CardAudioError("invalid-reply", `audio range must be 1…${CARD_AUDIO_MAX_BLOCK_FRAMES} samples`);
  const routed: CardAudioRoute = onlinePage() ? cardAudioRoute(x.project, x.nodeId) : { route: "page" };
  if (routed.route === null) throw new CardAudioError("request-failed", routed.reason);
  const ready = requireCardAudioHooks();
  const owner = ownerOf(x.project), k = key(x), blocks = projectBlocks.get(owner) ?? new Map<string, Promise<CardAudioReply>>();
  projectBlocks.set(owner, blocks);
  let pending = blocks.get(k);
  if (!pending) {
    const context: AudioSourceContext = {
      graph: audioGraphOf(x.project, ready.getCard),
      project: x.project as Pick<Project, "tracks" | "media">,
      getCard: ready.getCard,
      sampleRate: x.sampleRate,
    };
    pending = (async () => {
      // 同步来的卡:交给隔离的声音宿主(编辑页面不执行它们的 audio());其余在页面里求值
      const samples = routed.route === "isolated"
        ? checkedIsolatedBlock(await isolatedHost!.render(x, signal), x.count)
        : await evaluateCardAudio(context, x.nodeId, { start: x.start, count: x.count, sampleRate: x.sampleRate });
      const channels = samples.length / x.count;
      if (!Number.isInteger(channels) || channels < 1) throw new CardAudioError("invalid-reply", "invalid card audio descriptor");
      const reply: CardAudioReply = { samples, format: "wav", sampleRate: x.sampleRate, frames: x.count, channels };
      // 带 url 的回包(只有租约那条路会有)照旧查同源
      if (reply.url && !isSameOriginOrBlob(reply.url)) throw new CardAudioError("invalid-reply", "invalid card audio descriptor");
      return reply;
    })();
    blocks.set(k, pending); pending.catch(() => blocks.delete(k));
  }
  const reply = await pending;
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  return reply;
}

export interface CardAudioClip { project: unknown; nodeId: string; frames: number; sampleRate?: typeof CARD_AUDIO_SAMPLE_RATE; }

/** Evaluate bounded blocks in page and concatenate them exactly to the requested local range. */
export async function decodeCardAudioClip(ctx: BaseAudioContext, clip: CardAudioClip, fetchImpl: typeof fetch = fetch): Promise<AudioBuffer> {
  const sampleRate = clip.sampleRate ?? CARD_AUDIO_SAMPLE_RATE;
  if (!Number.isSafeInteger(clip.frames) || clip.frames < 1) throw new CardAudioError("invalid-reply", "card audio clip has invalid frame count");
  const requests: CardAudioRequest[] = [], replies: CardAudioReply[] = [];
  for (let start = 0; start < clip.frames; start += CARD_AUDIO_MAX_BLOCK_FRAMES) {
    const request: CardAudioRequest = { project: clip.project, nodeId: clip.nodeId, start, count: Math.min(CARD_AUDIO_MAX_BLOCK_FRAMES, clip.frames - start), sampleRate };
    requests.push(request);
    replies.push(await requestCardAudio(request, undefined, fetchImpl));
  }
  const channels = Math.max(...replies.map((reply) => reply.channels));
  const output = ctx.createBuffer(channels, clip.frames, sampleRate);
  let at = 0;
  for (const reply of replies) {
    if (reply.samples.length !== reply.frames * reply.channels) throw new CardAudioError("invalid-reply", `card audio block is ${reply.samples.length} samples, expected ${reply.frames} × ${reply.channels}`);
    for (let channel = 0; channel < channels; channel++) {
      const data = output.getChannelData(channel), source = Math.min(channel, reply.channels - 1);
      for (let frame = 0; frame < reply.frames; frame++) data[at + frame] = reply.samples[frame * reply.channels + source];
    }
    at += reply.frames;
  }
  // 拼完整条删掉:一块立体声 1_048_576 × 2 × 4 = 8 MB,不删就在 project 存活期内常驻。
  // 只摘 samples 字段不行 —— 留一份没有 samples 的回包会让下一次拿到空块。
  const blocks = projectBlocks.get(ownerOf(clip.project));
  if (blocks) for (const request of requests) blocks.delete(key(request));
  return output;
}

function wavOf(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels, bytes = buffer.length * channels * 4, raw = new ArrayBuffer(44 + bytes), view = new DataView(raw);
  const put = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  put(0, "RIFF"); view.setUint32(4, 36 + bytes, true); put(8, "WAVE"); put(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 4, true); view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true); put(36, "data"); view.setUint32(40, bytes, true);
  const interleaved = new Float32Array(raw, 44, buffer.length * channels);
  for (let frame = 0; frame < buffer.length; frame++) for (let channel = 0; channel < channels; channel++) interleaved[frame * channels + channel] = buffer.getChannelData(channel)[frame];
  return new Blob([raw], { type: "audio/wav" });
}

/** Preview's <audio> needs one seekable URL, so join blocks into one local WAV once per source version + node + duration. */
export interface CardAudioLease { url: string; release(): void; }
export async function acquireCardAudioClipUrl(clip: CardAudioClip): Promise<CardAudioLease> {
  const owner = ownerOf(clip.project), sampleRate = clip.sampleRate ?? CARD_AUDIO_SAMPLE_RATE, k = `${versionKeyOf(clip.project, clip.nodeId)}:${clip.nodeId}:${clip.frames}:${sampleRate}`;
  const urls = projectClips.get(owner) ?? new Map<string, CachedClip>(); projectClips.set(owner, urls);
  let cached = urls.get(k);
  if (!cached) {
    cached = { refs: 0, promise: (async () => { const context = new AudioContext({ sampleRate }); try { return URL.createObjectURL(wavOf(await decodeCardAudioClip(context, { ...clip, sampleRate }))); } finally { await context.close(); } })() };
    urls.set(k, cached); cached.promise.then(url => { cached!.url = url; }, () => urls.delete(k));
  }
  const url = await cached.promise; cached.refs++;
  let released = false;
  return { url, release() { if (released) return; released = true; if (--cached!.refs === 0 && cached!.url) { URL.revokeObjectURL(cached!.url); urls.delete(k); } } };
}

/** Use when a complete project preview is discarded; revokes object URLs and drops retained sample blocks. */
export function disposeProjectCardAudio(project: unknown) {
  const owner = ownerOf(project);
  projectBlocks.get(owner)?.clear();
  const urls = projectClips.get(owner); if (!urls) return;
  for (const cached of urls.values()) if (cached.url) URL.revokeObjectURL(cached.url);
  urls.clear();
}
export function clearCardAudioCache() { /* retained API; per-project disposal is explicit. */ }

/** 校验持久声音。在线端只取 WAV，不执行用户卡 audio()。 */
export function persistentCardAudio(project: Project, clip: TrackClip) {
  return resolveCardAudioRendition(project, clip, { getCard: hooks?.getCard,
    sourceVersionOf: (id) => onlinePage() && syncedUserCards().get(id)?.audioSourceVersion
      ? syncedUserCards().get(id)!.audioSourceVersion
      : hooks?.getCard(id) ? hooks.sourceVersionOf(id) : syncedUserCards().get(id)?.audioSourceVersion });
}
/** 导出前核一遍:剪辑段按混音同一份展开(`audioProjectOf`)走进被引用的剪辑,里面出声的有声卡缺了、过期了同样当场报出原片段。
 * 变速段上的声画一体卡同样要核(2026-10-23 用户定「出声。」) */
export function assertProjectCardAudio(project: Project) {
  for (const track of audioProjectOf(project).tracks) for (const clip of track.clips) {
    if (track.hidden || track.muted || clip.audioMuted || !(clipHasEmbeddedAudio(project, clip, hooks?.getCard) || syncedUserCards().get(clip.cardId)?.embeddedAudio)) continue;
    persistentCardAudio(project, clip);
  }
}

/** 复用已有 audio() 采样管线，逐小块让出页面。只在明确生成动作运行，预览从不自动重生成。 */
export async function renderEmbeddedCardWav(project: Project, clip: TrackClip, signal: AbortSignal,
  onProgress?: (done: number, total: number) => void): Promise<{ wav: Uint8Array; channels: number; frames: number }> {
  requireCardAudioHooks();
  const nodeId = cardAudioNodeOf(project, clip);
  if (onlinePage() && !(nodeId && onlineCardAudioSynthesizable(project, nodeId))) throw new Error((nodeId && onlineCardAudioBlocker(project, nodeId)) || ONLINE_CARD_AUDIO_BLOCKED);
  if (!nodeId || !clipHasEmbeddedAudio(project, clip, cardAudioGraphCard)) throw new Error("这张卡没有内嵌声音");
  assertAudiovisualCardKind(cardAudioGraphCard(clip.cardId));
  cardAudioIdentity(project, clip, cardAudioIdentityHooks());
  const frames = Math.round((clip.end - clip.start) * CARD_AUDIO_SAMPLE_RATE);
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > 60 * CARD_AUDIO_SAMPLE_RATE) throw new Error("卡片声音生成范围必须在 1 个采样至 60 秒内");
  let channels = 0, output: Uint8Array | undefined, view: DataView | undefined;
  const block = cardAudioBlockRenderer(project, nodeId, signal);
  for (let start = 0; start < frames; start += 8192) {
    signal.throwIfAborted();
    const count = Math.min(8192, frames - start);
    const samples = await block(start, count);
    const blockChannels = samples.length / count;
    if (!channels) {
      channels = blockChannels;
      output = new Uint8Array(44 + frames * channels * 4); view = new DataView(output.buffer);
      const put = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view!.setUint8(at + i, text.charCodeAt(i)); };
      put(0, "RIFF"); view.setUint32(4, output.byteLength - 8, true); put(8, "WAVE"); put(12, "fmt ");
      view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, channels, true);
      view.setUint32(24, CARD_AUDIO_SAMPLE_RATE, true); view.setUint32(28, CARD_AUDIO_SAMPLE_RATE * channels * 4, true);
      view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true); put(36, "data"); view.setUint32(40, frames * channels * 4, true);
    } else if (blockChannels !== channels) throw new Error("卡片声音的声道数不能在生成途中改变");
    for (let i = 0; i < samples.length; i++) view!.setFloat32(44 + (start * channels + i) * 4, samples[i], true);
    onProgress?.(start + count, frames);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return { wav: output!, frames, channels };
}

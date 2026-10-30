/**
 * 音频素材效果卡的输入取样 —— `sources[name].block(start, count)` 的实现,以及一个节点的
 * `audio()` 求值。视觉那条路(`at()` / `pixels()`)由 `GraphCard.tsx` 自己给,这里只管声音。
 *
 * ## 导出的接口
 *
 * ```ts
 * blockOf(ctx, ref, start, count): Promise<Float32Array>
 * ```
 *
 * - `ctx: AudioSourceContext`
 *   - `graph` —— 节点表。可以是 `project.cardNodes`(生节点),也可以是
 *     `projectCardGraph()` 的返回值(`{ nodes }`);两种都认。
 *   - `project` —— 只用来按 **片段 id** 找素材:素材输入 `@clip/<id>/source` 在生
 *     `cardNodes` 里没有节点,得回片段上取 `mediaId`(→ 内容哈希)和 `mediaOffset`。
 *   - `getCard(id)` —— 卡片注册表(`src/kernel/registry`)。
 *   - `sampleRate` —— 本次求值的采样率(48000)。
 * - `ref: AudioSourceRef` —— **解析过的**输入:`{ nodeId }`(素材效果卡节点)或 `{ clipId }`
 *   (素材片段),都可以带边上的 `offset`(秒)/ `rate`(播放速率)。
 * - 素材片段变了速(`clip.speed ≠ 1`)时,它的声音按倍率变速变调(`varispeedBlock`);边上的 `rate ≠ 1` 仍不支持。
 * - 返回 **交错**(frame-major)的 `Float32Array`,长度 = `count × 声道数`,和
 *   `cardAudio.ts` 的 `wavOf` 同一口径。
 *
 * 另外导出 `audioSourcesOf(ctx, node)`(给一个节点拼 `sources`)、
 * `evaluateCardAudio(ctx, nodeId, range)`(找节点 → 定义 → `audio()`)、
 * `paramsOfAudioNode(ctx, node)`(H2 的「实例参数」口径)和 `clearAudioBlockCache()`。
 *
 * ## 为什么素材要走服务端
 *
 * 浏览器里不解整份素材文件(`renderMix.ts:9-10`:10 分钟 4K 视频就是 1 GB)。素材输入
 * 改走 `GET /@media/<hash>/pcm`(`server/vite-plugin-media.ts`),由 ffmpeg 按采样区间裁。
 * 路由没有 `offset` 参数:`clip.mediaOffset + 边.offset` 在页面里折算一次,折进 `start`。
 * 回来的字节直接当 `Float32Array` 读,**不经 `decodeAudioData`、不需要任何 `AudioContext`**
 * —— `requestCardAudio` 拿不到调用方的 context,自建一个默认 44100 Hz 的会让音高和长度全错。
 */
import type { CardDef } from "../../kernel/types";
import type { MediaAsset, Project, TrackClip } from "../../kernel/project";
import type { CardNode } from "../../kernel/cardGraph.mjs";
import { clipSpeed } from "../../kernel/clipTime.mjs";
import { onlinePage } from "../../online/pageFlag";
import { ONLINE_CARD_AUDIO_BLOCKED, onlineCardAudioRunnable } from "../../online/soundPolicy";

/** 一路输入解析后的样子。`offset` 是秒,`rate` 是播放速率(第一版只支持 1) */
export type AudioSourceRef =
  | { nodeId: string; clipId?: undefined; offset?: number; rate?: number }
  | { clipId: string; nodeId?: undefined; offset?: number; rate?: number };

export interface AudioSourceContext {
  /** `project.cardNodes`,或 `projectCardGraph()` 的返回值 */
  graph: CardNode[] | { nodes: CardNode[] } | undefined;
  /** 片段 / 素材查表用 */
  project: Pick<Project, "tracks" | "media">;
  getCard: (id: string) => CardDef<any> | undefined;
  sampleRate: number;
  signal?: AbortSignal;
}

/** 声道恒定 2:路由固定 `ch=2`,和 `card-service.mjs` 那条老路一致 */
export const MEDIA_PCM_CHANNELS = 2;
/** 页面侧的块缓存上限(一块立体声 48 kHz 一秒 ≈ 384 KB) */
export const AUDIO_BLOCK_CACHE_LIMIT = 32;

const fail = (message: string): never => { throw new Error(`Card audio: ${message}`); };

function nodesOf(graph: AudioSourceContext["graph"]): CardNode[] {
  if (!graph) return [];
  return Array.isArray(graph) ? graph : (graph.nodes ?? []);
}

function nodeOf(ctx: AudioSourceContext, id: string): CardNode | undefined {
  return nodesOf(ctx.graph).find((node) => node.id === id);
}

function clipOf(project: Pick<Project, "tracks">, clipId: string): TrackClip | undefined {
  for (const track of project.tracks ?? []) for (const clip of track.clips ?? []) if (clip.id === clipId) return clip;
  return undefined;
}

/** 片段 id 从 `@clip/<id>/source` 里取回来(节点 id 的写法见 cardGraph.mjs:121) */
const CLIP_SOURCE = /^@clip\/(.+)\/source$/;

/**
 * 把一条 `inputs[name]` 解析成 `blockOf` 认的引用。生 `cardNodes` 里没有
 * `@clip/<id>/source` 这种节点,所以它被翻成 `{ clipId }`;其余按 `{ nodeId }`。
 */
export function resolveAudioRef(ctx: AudioSourceContext, input: unknown): AudioSourceRef {
  const raw = typeof input === "string" ? { nodeId: input } : (input ?? {}) as { nodeId?: string; offset?: number; rate?: number };
  const nodeId = raw.nodeId;
  if (typeof nodeId !== "string" || !nodeId) fail("input must reference a node");
  const offset = raw.offset ?? 0, rate = raw.rate ?? 1;
  const clipSource = CLIP_SOURCE.exec(nodeId!);
  // 图里已经合成过这个节点时(projectCardGraph 的返回值)照 nodeId 走,没有才回片段上找
  if (clipSource && !nodeOf(ctx, nodeId!)) return { clipId: clipSource[1], offset, rate };
  return { nodeId: nodeId!, offset, rate };
}

/* ------------------------------------------------------------------ *
 * 素材块:服务端 ffmpeg 裁,页面按 (hash, position, count) 缓存
 * ------------------------------------------------------------------ */

const blockCache = new Map<string, Promise<Float32Array>>();

export function clearAudioBlockCache() { blockCache.clear(); }

async function mediaBlock(hash: string, position: number, count: number, sampleRate: number): Promise<Float32Array> {
  const cacheKey = `${hash}:${position}:${count}:${sampleRate}`;
  const hit = blockCache.get(cacheKey);
  if (hit) {
    // 命中的挪到表尾:LRU 的淘汰顺序靠 Map 的插入序
    blockCache.delete(cacheKey); blockCache.set(cacheKey, hit);
    return hit;
  }
  /*
   * 在线浏览器模式:`/@media/<hash>/pcm` 是编辑器进程(ffmpeg 裁采样)的接口,远程素材服务没有这一路;
   * 素材效果卡在这台设备上本来就渲染不了(由渲染节点出,C10 契约第 9 节),这里不发请求,当场失败。
   */
  if (onlinePage()) fail("在线浏览器模式不取素材的采样块(素材效果卡的声音由渲染节点提供)");
  const pending = (async () => {
    const url = `/@media/${hash}/pcm?start=${position}&count=${count}&sampleRate=${sampleRate}&ch=${MEDIA_PCM_CHANNELS}`;
    const response = await fetch(url);
    if (!response.ok) fail(`media PCM request failed (${response.status})`);
    const bytes = await response.arrayBuffer();
    const expected = count * MEDIA_PCM_CHANNELS * 4;
    if (bytes.byteLength !== expected) fail(`media PCM returned ${bytes.byteLength} bytes, expected ${expected}`);
    return new Float32Array(bytes);
  })();
  blockCache.set(cacheKey, pending);
  pending.catch(() => blockCache.delete(cacheKey));
  while (blockCache.size > AUDIO_BLOCK_CACHE_LIMIT) {
    const oldest = blockCache.keys().next();
    if (oldest.done) break;
    blockCache.delete(oldest.value);
  }
  return pending;
}

function mediaOf(ctx: AudioSourceContext, clip: TrackClip): MediaAsset {
  const media = clip.mediaId ? (ctx.project.media ?? []).find((m) => m.id === clip.mediaId) : undefined;
  if (!media) fail(`clip ${clip.id} has no media input`);
  if (!media!.hash) fail(`素材「${media!.name || media!.id}」还没有内容哈希,重新导入一次再用它喂音频素材效果卡`);
  return media!;
}

/* ------------------------------------------------------------------ *
 * 实例参数(H2):节点存一份,片段指向的那个节点以 clip.params 为准
 * ------------------------------------------------------------------ */

export function paramsOfAudioNode(ctx: AudioSourceContext, node: CardNode): Record<string, unknown> {
  const def = typeof node.cardId === "string" ? ctx.getCard(node.cardId) : undefined;
  for (const track of ctx.project.tracks ?? []) for (const clip of track.clips ?? []) {
    if (clip.nodeId === node.id) return { ...def?.defaults, ...clip.params };
  }
  return { ...def?.defaults, ...(node.params ?? {}) };
}

/* ------------------------------------------------------------------ *
 * 取样
 * ------------------------------------------------------------------ */

/** 素材节点的倍率:节点上的 `rate`(`withMediaRates` 加的)优先,其次是节点 clipId 指向的片段的速度,都没有为 1 */
function mediaNodeSpeed(ctx: AudioSourceContext, node: CardNode): number {
  const rate = Number(node.rate);
  if (node.rate !== undefined && Number.isFinite(rate) && rate > 0) return rate;
  const owner = typeof node.clipId === "string" ? clipOf(ctx.project, node.clipId) : undefined;
  return owner ? clipSpeed(owner) : 1;
}

/** 一次向服务端要的最多帧数(`server/vite-plugin-media.ts` 的 `PCM_MAX_FRAMES`) */
const MEDIA_PCM_MAX_FRAMES = 1_048_576;

/** 素材的原始采样 `[position, position + count)`,超过路由上限时分几次取再拼起来 */
async function mediaSpan(hash: string, position: number, count: number, sampleRate: number): Promise<Float32Array> {
  if (count <= MEDIA_PCM_MAX_FRAMES) return mediaBlock(hash, position, count, sampleRate);
  const out = new Float32Array(count * MEDIA_PCM_CHANNELS);
  for (let done = 0; done < count; done += MEDIA_PCM_MAX_FRAMES) {
    const n = Math.min(MEDIA_PCM_MAX_FRAMES, count - done);
    out.set(await mediaBlock(hash, position + done, n, sampleRate), done * MEDIA_PCM_CHANNELS);
  }
  return out;
}

/**
 * 变速段的声音(变速变调,不保调):下游第 `local + i` 个采样 = 素材第 `mediaStart + (local + i) × speed` 个采样。
 * 和导出两条混音路(`kernel/clipTime.mjs` 的 `ffmpegVarispeed`)、在线浏览器导出(`resampleVarispeed`)是同一个语义:
 * 读「时长 × 倍率」那么长的素材,压/拉成时长那么长。
 *
 * 为什么在页面里按倍率多取、取回来再插值,不让服务端的 ffmpeg 做:素材效果卡的声音是**一块一块**取的
 * (生成卡片声音按 8192 帧一块,导出的离线混音按它自己的块),而块的起点落到素材上一般不在整数采样上。
 * ffmpeg 的 `asetrate` 每次从块起点重新起滤镜,块与块之间相位对不上、首尾还有滤波器的过渡段,拼起来每块一声咔哒。
 * 这里按**绝对采样坐标**算每个输出采样在素材上的位置,同一时刻不论落在哪一块都取到同一个值,块缝是无缝的;
 * 插值和 `resampleVarispeed` 一样是线性插值(没有抗混叠滤波,失真问题随「可以分离,失真问题记待办」一并记待办)。
 */
async function varispeedBlock(hash: string, local: number, mediaStart: number, speed: number, count: number, sampleRate: number): Promise<Float32Array> {
  const x0 = mediaStart + local * speed;
  const first = Math.floor(x0);
  // 最后一个输出采样要用到 floor(x_last) + 1 那个采样做插值
  const last = Math.floor(mediaStart + (local + count - 1) * speed) + 1;
  const raw = await mediaSpan(hash, first, last - first + 1, sampleRate);
  const frames = raw.length / MEDIA_PCM_CHANNELS;
  const out = new Float32Array(count * MEDIA_PCM_CHANNELS);
  for (let i = 0; i < count; i++) {
    // 按绝对坐标算(不累加步长),块缝两侧取到的是同一条曲线
    const x = mediaStart + (local + i) * speed - first;
    const k = Math.floor(x), f = x - k;
    if (k < 0 || k >= frames) continue;
    const k1 = k + 1 < frames ? k + 1 : k;
    for (let c = 0; c < MEDIA_PCM_CHANNELS; c++) {
      const a = raw[k * MEDIA_PCM_CHANNELS + c], b = raw[k1 * MEDIA_PCM_CHANNELS + c];
      out[i * MEDIA_PCM_CHANNELS + c] = a + (b - a) * f;
    }
  }
  return out;
}

/**
 * 取 `[start, start + count)` 这段采样(交错多声道)。`start` 是**下游**的本地采样序号;
 * 边上的 `offset`(秒)和素材的 `mediaOffset` 在这里一次折进请求位置。
 */
export async function blockOf(ctx: AudioSourceContext, ref: AudioSourceRef, start: number, count: number): Promise<Float32Array> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 1) fail("audio block range must be whole samples");
  const rate = ref.rate ?? 1;
  if (rate !== 1) fail("音频素材效果卡输入边上的播放速率第一版不支持(rate ≠ 1)");
  const edge = Math.round((ref.offset ?? 0) * ctx.sampleRate);
  if (ref.clipId !== undefined) {
    const clip = clipOf(ctx.project, ref.clipId);
    if (!clip) fail(`audio input clip ${ref.clipId} is missing`);
    const media = mediaOf(ctx, clip!);
    // 服务端没有 offset 参数:clip.mediaOffset + 边.offset 折算一次,折进 start
    const mediaStart = Math.round((clip!.mediaOffset ?? 0) * ctx.sampleRate);
    // 变速段(2026-10-23 用户定「放开。」):声音随倍率变速变调,见 `varispeedBlock`
    const speed = clipSpeed(clip);
    if (speed !== 1) return varispeedBlock(media.hash!.toLowerCase(), start + edge, mediaStart, speed, count, ctx.sampleRate);
    const position = start + edge + mediaStart;
    return mediaBlock(media.hash!.toLowerCase(), position, count, ctx.sampleRate);
  }
  const node = nodeOf(ctx, ref.nodeId!);
  if (!node) fail(`audio input node ${ref.nodeId} is missing`);
  if (node!.adapter === "media") {
    // projectCardGraph 已经合成过的素材节点:offset 就在节点上(cardGraph.mjs:121-122)
    const media = node!.media as MediaAsset | undefined;
    if (!media?.hash) fail(`素材节点 ${node!.id} 没有内容哈希,重新导入一次素材`);
    const mediaStart = Math.round((Number(node!.offset) || 0) * ctx.sampleRate);
    // 变速段:节点上带了倍率(`withMediaRates`)以它为准,没带时按节点的 clipId 在项目里查片段的速度
    const speed = mediaNodeSpeed(ctx, node!);
    if (speed !== 1) return varispeedBlock(media!.hash!.toLowerCase(), start + edge, mediaStart, speed, count, ctx.sampleRate);
    const position = start + edge + mediaStart;
    return mediaBlock(media!.hash!.toLowerCase(), position, count, ctx.sampleRate);
  }
  // 素材效果卡节点:递归调它的 audio()
  return evaluateCardAudio(ctx, ref.nodeId!, { start: start + edge, count, sampleRate: ctx.sampleRate });
}

/** 一个节点的 `sources`。音频求值只用得上 `block()`,视觉两路在这里是明确的报错 */
export function audioSourcesOf(ctx: AudioSourceContext, node: CardNode): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, input] of Object.entries(node.inputs ?? {})) {
    const ref = resolveAudioRef(ctx, input);
    out[name] = {
      nodeId: ref.nodeId ?? `@clip/${ref.clipId}/source`,
      at() { return fail("音频素材效果卡的 sources 只支持 block(),没有画面"); },
      pixels() { return Promise.reject(new Error("Card audio: 音频素材效果卡的 sources 只支持 block(),没有画面")); },
      block: (start: number, count: number) => blockOf(ctx, ref, start, count),
    };
  }
  return out;
}

export interface AudioRange { start: number; count: number; sampleRate: number }

/** 找节点 → 注册表里的定义 → `def.audio(sources, range, params)`。返回交错的采样块 */
export async function evaluateCardAudio(ctx: AudioSourceContext, nodeId: string, range: AudioRange): Promise<Float32Array> {
  if (ctx.signal?.aborted) throw new DOMException("aborted", "AbortError");
  const node = nodeOf(ctx, nodeId);
  if (!node) fail(`audio node ${nodeId} is missing`);
  const cardId = typeof node!.cardId === "string" ? node!.cardId : "";
  const def = cardId ? ctx.getCard(cardId) : undefined;
  // 在线页面只执行放开了的卡(第一段:内置卡;`src/online/soundPolicy.ts`),其余照旧用已生成的声音素材
  if (onlinePage() && !onlineCardAudioRunnable(def)) fail(ONLINE_CARD_AUDIO_BLOCKED);
  if (!def?.audio) fail(`card ${cardId || node!.id} has no audio()`);
  const mapped = { ...range, start: range.start + Math.round((Number(node!.timeOffset) || 0) * range.sampleRate) };
  const samples = await def!.audio!(audioSourcesOf(ctx, node!), mapped, paramsOfAudioNode(ctx, node!) as any);
  if (!(samples instanceof Float32Array)) fail(`card ${cardId} audio() must return a Float32Array`);
  if (samples.length < 1 || samples.length % range.count !== 0) {
    fail(`card ${cardId} audio() returned ${samples.length} samples for ${range.count} frames (not a whole number of channels)`);
  }
  if (ctx.signal?.aborted) throw new DOMException("aborted", "AbortError");
  if (samples.length / range.count > 8 || samples.some(value => !Number.isFinite(value))) fail(`card ${cardId} audio() returned invalid samples or too many channels`);
  return samples;
}

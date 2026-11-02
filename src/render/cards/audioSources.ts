/**
 * Input sampling for audio media effect cards: implementation of `sources[name].block(start, count)`,
 * and evaluation of a node's `audio()`. The visual path (`at()` / `pixels()`) is provided by
 * `GraphCard.tsx` itself; this only handles audio.
 *
 * ## Exported interfaces
 *
 * ```ts
 * blockOf(ctx, ref, start, count): Promise<Float32Array>
 * ```
 *
 * - `ctx: AudioSourceContext`
 *   - `graph`: node table. Can be `project.cardNodes` (raw nodes), or the return value of
 *     `projectCardGraph()` (`{ nodes }`); accepts both.
 *   - `project`: used only to locate media by **clip id**: media input `@clip/<id>/source` has no
 *     node in raw `cardNodes`, requiring retrieving `mediaId` (→ content hash) and `mediaOffset`
 *     from the clip.
 *   - `getCard(id)`: card registry (`src/kernel/registry`).
 *   - `sampleRate`: sample rate for this evaluation (48000).
 * - `ref: AudioSourceRef`: **resolved** input: `{ nodeId }` (media effect card node) or `{ clipId }`
 *   (media clip), both of which can carry `offset` (seconds) / `rate` (playback rate) on the edge.
 * - When a media clip has changed speed (`clip.speed ≠ 1`), its audio is varispeed pitch-shifted by
 *   the rate multiplier (`varispeedBlock`); `rate ≠ 1` on the edge is still unsupported.
 * - Returns **interleaved** (frame-major) `Float32Array`, length = `count × channel count`, matching
 *   the convention of `wavOf` in `cardAudio.ts`.
 *
 * Also exports `audioSourcesOf(ctx, node)` (constructs `sources` for a node),
 * `evaluateCardAudio(ctx, nodeId, range)` (find node → definition → `audio()`),
 * `paramsOfAudioNode(ctx, node)` (H2's "instance parameters" convention), and
 * `clearAudioBlockCache()`.
 *
 * ## Why media goes through the server
 *
 * The browser does not decode the entire media file (`renderMix.ts:9-10`: a 10-minute 4K video is
 * 1 GB). Media inputs instead use `GET /@media/<hash>/pcm` (`server/vite-plugin-media.ts`), sliced by
 * ffmpeg according to sample ranges. The route has no `offset` parameter:
 * `clip.mediaOffset + edge.offset` is converted once in the page and folded into `start`.
 * Returned bytes are read directly as `Float32Array`, **without `decodeAudioData` and without any
 * `AudioContext`**: `requestCardAudio` cannot get the caller's context, and creating its own default
 * 44100 Hz context would make pitch and duration completely wrong.
 */
import type { CardDef } from "../../kernel/types";
import type { MediaAsset, Project, TrackClip } from "../../kernel/project";
import type { CardNode } from "../../kernel/cardGraph.mjs";
import { clipSpeed } from "../../kernel/clipTime.mjs";
import { onlinePage } from "../../online/pageFlag";
import { ONLINE_CARD_AUDIO_BLOCKED, onlineCardAudioRunnable } from "../../online/soundPolicy";

/** Resolved representation of an input. `offset` is in seconds, `rate` is playback rate (v1 only supports 1) */
export type AudioSourceRef =
  | { nodeId: string; clipId?: undefined; offset?: number; rate?: number }
  | { clipId: string; nodeId?: undefined; offset?: number; rate?: number };

export interface AudioSourceContext {
  /** `project.cardNodes`, or return value of `projectCardGraph()` */
  graph: CardNode[] | { nodes: CardNode[] } | undefined;
  /** Used for clip / media lookup */
  project: Pick<Project, "tracks" | "media">;
  getCard: (id: string) => CardDef<any> | undefined;
  sampleRate: number;
  signal?: AbortSignal;
}

/** Constant 2 channels: route is fixed to `ch=2`, consistent with the legacy path in `card-service.mjs` */
export const MEDIA_PCM_CHANNELS = 2;
/** Page-side chunk cache limit (one stereo 48 kHz chunk of one second ≈ 384 KB) */
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

/** Clip ID retrieved from `@clip/<id>/source` (see cardGraph.mjs:121 for node ID formatting) */
const CLIP_SOURCE = /^@clip\/(.+)\/source$/;

/**
 * Resolves an `inputs[name]` entry into a reference recognized by `blockOf`. Raw `cardNodes`
 * contains no `@clip/<id>/source` nodes, so it is translated into `{ clipId }`; others use `{ nodeId }`.
 */
export function resolveAudioRef(ctx: AudioSourceContext, input: unknown): AudioSourceRef {
  const raw = typeof input === "string" ? { nodeId: input } : (input ?? {}) as { nodeId?: string; offset?: number; rate?: number };
  const nodeId = raw.nodeId;
  if (typeof nodeId !== "string" || !nodeId) fail("input must reference a node");
  const offset = raw.offset ?? 0, rate = raw.rate ?? 1;
  const clipSource = CLIP_SOURCE.exec(nodeId!);
  // When this node is already synthesized in the graph (return value of projectCardGraph),
  // follow nodeId; otherwise look it up on the clip
  if (clipSource && !nodeOf(ctx, nodeId!)) return { clipId: clipSource[1], offset, rate };
  return { nodeId: nodeId!, offset, rate };
}

/* ------------------------------------------------------------------ *
 * Media chunk: sliced by server ffmpeg, cached on page by (hash, position, count)
 * ------------------------------------------------------------------ */

const blockCache = new Map<string, Promise<Float32Array>>();

export function clearAudioBlockCache() { blockCache.clear(); }

async function mediaBlock(hash: string, position: number, count: number, sampleRate: number): Promise<Float32Array> {
  const cacheKey = `${hash}:${position}:${count}:${sampleRate}`;
  const hit = blockCache.get(cacheKey);
  if (hit) {
    // Move hits to end of map: LRU eviction order relies on Map insertion order
    blockCache.delete(cacheKey); blockCache.set(cacheKey, hit);
    return hit;
  }
  /*
   * Online browser mode: `/@media/<hash>/pcm` is an endpoint of the editor process (ffmpeg slices
   * samples), which is absent in remote asset service; media effect cards cannot be rendered on this
   * device anyway (handled by render nodes, C10 contract Section 9), so no request is sent here and
   * it fails immediately.
   */
  if (onlinePage()) fail("Online browser mode does not fetch asset sample chunks (the sound of media effect cards is provided by the render node)");
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
  if (!media!.hash) fail(`Media "${media!.name || media!.id}" has no content hash yet; re-import it once before using it to feed an audio media effect card`);
  return media!;
}

/* ------------------------------------------------------------------ *
 * Instance parameters (H2): stored on node; node pointed to by clip defaults to clip.params
 * ------------------------------------------------------------------ */

export function paramsOfAudioNode(ctx: AudioSourceContext, node: CardNode): Record<string, unknown> {
  const def = typeof node.cardId === "string" ? ctx.getCard(node.cardId) : undefined;
  for (const track of ctx.project.tracks ?? []) for (const clip of track.clips ?? []) {
    if (clip.nodeId === node.id) return { ...def?.defaults, ...clip.params };
  }
  return { ...def?.defaults, ...(node.params ?? {}) };
}

/* ------------------------------------------------------------------ *
 * Sampling
 * ------------------------------------------------------------------ */

/** Media node rate multiplier: `rate` on node (from `withMediaRates`) takes precedence, then clip speed from node clipId; defaults to 1 */
function mediaNodeSpeed(ctx: AudioSourceContext, node: CardNode): number {
  const rate = Number(node.rate);
  if (node.rate !== undefined && Number.isFinite(rate) && rate > 0) return rate;
  const owner = typeof node.clipId === "string" ? clipOf(ctx.project, node.clipId) : undefined;
  return owner ? clipSpeed(owner) : 1;
}

/** Maximum frames requested from server at once (`PCM_MAX_FRAMES` in `server/vite-plugin-media.ts`) */
const MEDIA_PCM_MAX_FRAMES = 1_048_576;

/** Raw media samples `[position, position + count)`; fetched in multiple passes and stitched together if exceeding route limit */
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
 * Audio for speed-changed clip (varispeed pitch shift without pitch preservation): downstream
 * sample `local + i` = media sample `mediaStart + (local + i) × speed`. Shares the same semantics
 * with two export mix paths (`ffmpegVarispeed` in `kernel/clipTime.mjs`) and online browser export
 * (`resampleVarispeed`): reads media of length "duration × rate multiplier" and compresses/stretches
 * it to the duration.
 *
 * Why over-fetch by rate multiplier in the page and interpolate locally instead of letting server
 * ffmpeg do it: audio for media effect cards is fetched **chunk by chunk** (card audio generation
 * uses 8192 frames per chunk; export offline mix uses its own chunk size), and chunk start positions
 * on the media usually do not land on integer sample boundaries. ffmpeg's `asetrate` restarts filters
 * from each chunk start, causing phase mismatches between chunks and filter transition bands at ends,
 * producing a click for every stitched chunk. Here, each output sample's position on media is computed
 * in **absolute sample coordinates**; regardless of which chunk a given moment falls into, it yields
 * the same value, making chunk seams seamless; interpolation is linear just like `resampleVarispeed`
 * (no anti-aliasing filter; distortion issue tracked as TODO alongside "can be separated, track distortion as TODO").
 */
async function varispeedBlock(hash: string, local: number, mediaStart: number, speed: number, count: number, sampleRate: number): Promise<Float32Array> {
  const x0 = mediaStart + local * speed;
  const first = Math.floor(x0);
  // The last output sample needs sample floor(x_last) + 1 for interpolation
  const last = Math.floor(mediaStart + (local + count - 1) * speed) + 1;
  const raw = await mediaSpan(hash, first, last - first + 1, sampleRate);
  const frames = raw.length / MEDIA_PCM_CHANNELS;
  const out = new Float32Array(count * MEDIA_PCM_CHANNELS);
  for (let i = 0; i < count; i++) {
    // Computed using absolute coordinates (no step accumulation); both sides of chunk seam sample the same curve
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
 * Fetches sample range `[start, start + count)` (interleaved multi-channel). `start` is the local
 * sample index of **downstream**; `offset` (seconds) on the edge and media `mediaOffset` are folded
 * into the request position here at once.
 */
export async function blockOf(ctx: AudioSourceContext, ref: AudioSourceRef, start: number, count: number): Promise<Float32Array> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 1) fail("audio block range must be whole samples");
  const rate = ref.rate ?? 1;
  if (rate !== 1) fail("Playback rate on the input edge of an audio media effect card is not supported in the first version (rate ≠ 1)");
  const edge = Math.round((ref.offset ?? 0) * ctx.sampleRate);
  if (ref.clipId !== undefined) {
    const clip = clipOf(ctx.project, ref.clipId);
    if (!clip) fail(`audio input clip ${ref.clipId} is missing`);
    const media = mediaOf(ctx, clip!);
    // The server has no offset parameter: clip.mediaOffset + edge.offset is converted once,
    // folded into start
    const mediaStart = Math.round((clip!.mediaOffset ?? 0) * ctx.sampleRate);
    // Speed-changed clip (user decision, 2026-10-23: "Enable."): audio changes speed and pitch
    // with rate; see `varispeedBlock`
    const speed = clipSpeed(clip);
    if (speed !== 1) return varispeedBlock(media.hash!.toLowerCase(), start + edge, mediaStart, speed, count, ctx.sampleRate);
    const position = start + edge + mediaStart;
    return mediaBlock(media.hash!.toLowerCase(), position, count, ctx.sampleRate);
  }
  const node = nodeOf(ctx, ref.nodeId!);
  if (!node) fail(`audio input node ${ref.nodeId} is missing`);
  if (node!.adapter === "media") {
    // Asset nodes already composited by projectCardGraph: offset is directly on the node
    // (cardGraph.mjs:121-122)
    const media = node!.media as MediaAsset | undefined;
    if (!media?.hash) fail(`Media node ${node!.id} has no content hash; re-import the media once`);
    const mediaStart = Math.round((Number(node!.offset) || 0) * ctx.sampleRate);
    // Speed-changed clip: if the node carries a rate (`withMediaRates`), use it; otherwise look up
    // the clip speed in the project by the node's clipId
    const speed = mediaNodeSpeed(ctx, node!);
    if (speed !== 1) return varispeedBlock(media!.hash!.toLowerCase(), start + edge, mediaStart, speed, count, ctx.sampleRate);
    const position = start + edge + mediaStart;
    return mediaBlock(media!.hash!.toLowerCase(), position, count, ctx.sampleRate);
  }
  // Media effect card node: recursively call its audio()
  return evaluateCardAudio(ctx, ref.nodeId!, { start: start + edge, count, sampleRate: ctx.sampleRate });
}

/** A node's `sources`. Audio evaluation only uses `block()`; the two visual channels
 * explicitly throw errors here */
export function audioSourcesOf(ctx: AudioSourceContext, node: CardNode): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, input] of Object.entries(node.inputs ?? {})) {
    const ref = resolveAudioRef(ctx, input);
    out[name] = {
      nodeId: ref.nodeId ?? `@clip/${ref.clipId}/source`,
      at() { return fail("The sources of an audio media effect card only support block(), with no picture"); },
      pixels() { return Promise.reject(new Error("Card audio: the sources of an audio media effect card only support block(), with no picture")); },
      block: (start: number, count: number) => blockOf(ctx, ref, start, count),
    };
  }
  return out;
}

export interface AudioRange { start: number; count: number; sampleRate: number }

/** Find node → definition in registry → `def.audio(sources, range, params)`.
 * Returns interleaved sample chunks */
export async function evaluateCardAudio(ctx: AudioSourceContext, nodeId: string, range: AudioRange): Promise<Float32Array> {
  if (ctx.signal?.aborted) throw new DOMException("aborted", "AbortError");
  const node = nodeOf(ctx, nodeId);
  if (!node) fail(`audio node ${nodeId} is missing`);
  const cardId = typeof node!.cardId === "string" ? node!.cardId : "";
  const def = cardId ? ctx.getCard(cardId) : undefined;
  // Online pages only execute enabled cards (phase 1: built-in cards; `src/online/soundPolicy.ts`);
  // the rest continue using generated audio assets as before
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

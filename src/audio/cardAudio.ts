/** Media effect card audio is fetched by the clip's local sample chunks; the chunk protocol is
 * unchanged, and only the evaluation has moved back into the page. This file is deliberately its
 * only browser adapter layer: while a media effect card audio node is still computing or has failed,
 * consumers must never substitute media.url. */
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
/** The sample chunk stays in memory: `samples` is an interleaved (frame-major) Float32. `url` exists only on the lease path */
export type CardAudioReply = { samples: Float32Array; url?: string; format: "wav"; sampleRate: number; frames: number; channels: number };
export class CardAudioError extends Error {
  readonly code: "pending" | "invalid-reply" | "request-failed";
  constructor(code: "pending" | "invalid-reply" | "request-failed", message: string) { super(message); this.code = code; }
}

/* ------------------------------------------------------------------ *
 * Definitions and source versions: injected at module level, not passed down layer by layer
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
 * Called once when `src/cards/index.ts` loads (an HMR rerun calls it again). Each call increments
 * `cardAudioEpoch` by 1: after the cards are swapped the `project` reference does not change, and
 * this is what makes the preview's effect rerun and fetch the chunks again.
 */
export function configureCardAudio(next: CardAudioHooks) {
  hooks = next;
  epoch++;
  for (const listener of [...epochListeners]) listener();
}

/** getSnapshot for `useSyncExternalStore` */
export function getCardAudioEpoch(): number { return epoch; }

/** subscribe for `useSyncExternalStore` */
export function subscribeCardAudioEpoch(listener: () => void): () => void {
  epochListeners.add(listener);
  return () => { epochListeners.delete(listener); };
}

export function requireCardAudioHooks(): CardAudioHooks {
  if (!hooks) throw new CardAudioError("request-failed", "card audio hooks not configured");
  return hooks;
}

/* ------------------------------------------------------------------ *
 * Synced user cards and media effect cards: the sound is synthesized in the isolated sound thread
 * (`docs/plan/online-card-exec-contract.md` 3.5, section 6)
 * ------------------------------------------------------------------ */

/**
 * The isolated sound host (online page: a dedicated background thread started by the background
 * stage, attached through stage RPC). The editor page's source **does not execute** the `audio()` of
 * synced cards: here it only hands the "project, node, sample range" to the host and gets Float32
 * sample chunks back. Packing into WAV, uploading and submitting the output record are still done in
 * the editor page.
 * When not attached (this page has no isolated environment, or it is the desktop runtime) it is
 * null, and the sound of synced cards keeps using only the outputs already stored.
 */
export interface IsolatedCardAudioHost {
  /** This card's sound code has loaded successfully in the sound thread right now and can synthesize */
  runnable(cardId: string): boolean;
  /**
   * The reason it cannot synthesize (for the panel: the top level uses a module the sound thread does
   * not have, a load error, a timeout); returns null when it can synthesize or the card is unknown
   */
  blocker?(cardId: string): string | null;
  /**
   * The signature of this generation of the card's sound code (the key of the chunk cache: old chunks
   * are invalidated once a new generation comes)
   */
  versionOf(cardId: string): string;
  render(request: CardAudioRequest, signal?: AbortSignal): Promise<Float32Array>;
}

let isolatedHost: IsolatedCardAudioHost | null = null;
/**
 * Attach / detach the isolated sound host; call it again when the set of cards in the host that can
 * synthesize has changed (the preview refetches chunks based on `cardAudioEpoch`)
 */
export function setIsolatedCardAudioHost(host: IsolatedCardAudioHost | null): void {
  isolatedHost = host;
  epoch++;
  for (const listener of [...epochListeners]) listener();
}
export function isolatedCardAudioHost(): IsolatedCardAudioHost | null { return isolatedHost; }

export const SYNCED_AUDIO_NOT_HERE = "Audio code of synced cards does not run in the editor";
export const ONLINE_AUDIO_NEEDS_MEDIA = "This card reads audio samples from media, which the online page cannot access. It uses the already generated audio (or the render node provides it if there is none)";
export const ONLINE_AUDIO_NO_THREAD = "This page has no isolated audio thread. Audio for user cards and media effect cards uses the already generated audio (or the render node provides it if there is none)";
export const ONLINE_AUDIO_MIXED = "Audio chained across synced cards and built-in cards cannot be synthesized online. It uses the already generated audio (or the render node provides it if there is none)";

/**
 * The stand-in in the editor page for a synced audio user card: used only for "flattening the
 * project into a graph and computing identities" (it needs `audio` for a media effect card node to
 * be synthesized, and default parameters for the identity to be computed).
 * Its `audio()` throws as soon as it is called: the editor page's source never actually executes the
 * sound code of synced cards; the real definition lives only in the sound thread.
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

/**
 * Card lookup for flattening graphs and computing identities: use the definition if the page has
 * one; for a synced audio user card that has none, give the stand-in
 */
export function cardAudioGraphCard(id: string): CardDef<any> | undefined {
  return hooks?.getCard(id) ?? syncedAudioStandIn(id);
}

/**
 * The sound source version of a card: as before if the page has a definition; for a synced card, take
 * this generation's signature from the sound thread, or the one parsed statically when no host is
 * attached
 */
function audioVersionOfCard(id: string): string {
  if (hooks?.getCard(id)) return hooks.sourceVersionOf(id);
  return isolatedHost?.versionOf(id) || syncedUserCards().get(id)?.audioSourceVersion || "";
}

/**
 * The pair used for the identity of a persistent sound (`cardAudioIdentity`): a synced card uses the
 * stand-in's default parameters and the sound source version in the content store (the same
 * algorithm as the desktop app)
 */
export function cardAudioIdentityHooks(): CardAudioHooks {
  const ready = requireCardAudioHooks();
  return { getCard: cardAudioGraphCard, sourceVersionOf: (id) => (ready.getCard(id) ? ready.sourceVersionOf(id) : syncedUserCards().get(id)?.audioSourceVersion ?? ready.sourceVersionOf(id)) };
}

export type CardAudioRoute = { route: "page" | "isolated"; reason?: undefined } | { route: null; reason: string };

/**
 * Online page: where this audio node, together with its whole upstream, is synthesized.
 *   - `page`: all cards have definitions in the page and are allowed (built-in cards) → the editor
 *     page evaluates them itself;
 *   - `isolated`: all cards are synced and loaded successfully in the sound thread → handed to the
 *     isolated sound host;
 *   - null: cannot be synthesized (media inputs along the way, a card that is not allowed or not
 *     loaded, or two kinds of cards chained together), with `reason` given to the panel.
 * It only answers "where to run and whether it can run"; whether it is light or heavy is judged
 * separately (`src/editor/io/onlineSoundJudge.ts`).
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

/**
 * Sample chunks coming back from the sound thread are treated as untrusted input: anything with the
 * wrong shape or non-finite values is rejected
 */
function checkedIsolatedBlock(samples: unknown, count: number): Float32Array {
  if (!(samples instanceof Float32Array) || samples.length < 1 || samples.length % count !== 0 || samples.length / count > 8) throw new CardAudioError("invalid-reply", "Sample chunk returned by the audio thread has the wrong shape");
  for (let i = 0; i < samples.length; i++) if (!Number.isFinite(samples[i])) throw new CardAudioError("invalid-reply", "Sample chunk returned by the audio thread contains invalid values");
  return samples;
}

/**
 * Who computes a chunk of this node's sound: the online page goes by `cardAudioRoute`; the desktop
 * runtime always computes it in the page. When it cannot be synthesized, it throws the reason.
 * Measurement (`onlineSoundJudge.ts`), generating persistent outputs (`renderEmbeddedCardWav`) and
 * the preview's chunk fetch (`requestCardAudio`) all go through here, so the `audio()` of synced
 * cards only ever runs in the isolated sound host.
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
 * The graph used to compute sound: the same one as for the picture (`projectCardGraph` followed by
 * `withMediaRates`). For an audio-visual card attached to a speed-changed media clip, the card clock
 * here becomes mediaOffset ÷ speed (`cardClockOffset` in `kernel/clipTime.mjs`), on the same basis
 * as the picture and the alignment of already generated sound.
 * When there are no speed-changed clips, `withMediaRates` returns the same object, and the graph is
 * unchanged by a single byte.
 */
function audioGraphOf(project: unknown, getCard: (id: string) => CardDef<any> | undefined) {
  return withMediaRates(project, projectCardGraph(project, getCard));
}

const projectBlocks = new WeakMap<object, Map<string, Promise<CardAudioReply>>>();
interface CachedClip { promise: Promise<string>; url?: string; refs: number; }
const projectClips = new WeakMap<object, Map<string, CachedClip>>();

/**
 * The cache key carries the media effect card source version: after the media effect card source is
 * changed the `project` object stays the same, and without the version the old sample chunks and
 * the old `blob:` would keep being played. Walk upstream along `inputs[*]`, taking only nodes with
 * `adapter === 'card'` (media nodes have no source).
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
      // The ref of a raw node may be a string shorthand (cardGraph.d.mts:11 says CardInput | string)
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
 * Online page: whether this page can synthesize this audio node together with its whole upstream (in
 * the editor page, or in the isolated sound thread; `cardAudioRoute`).
 * It only answers "can it run"; whether it is light or heavy is judged separately
 * (`src/editor/io/onlineSoundJudge.ts`).
 */
export function onlineCardAudioSynthesizable(project: unknown, nodeId: string): boolean {
  return cardAudioRoute(project, nodeId).route !== null;
}

/** Online page: the reason this node's sound cannot be synthesized (for the panel); null when it can be */
export function onlineCardAudioBlocker(project: unknown, nodeId: string): string | null {
  const routed = cardAudioRoute(project, nodeId);
  return routed.route === null ? routed.reason : null;
}

/** A generated node owns a video-backed clip's audio too; callers must mute that native media element. */
export function shouldMuteNativeAudio(project: Project, clip: TrackClip, globallyMuted = false) {
  // A speed-changed media clip produces no original audio ([ruling] first version, kernel/clipTime.mjs)
  return globallyMuted || !!clip.audioMuted || speedMutesSource(clip, project) || !!cardAudioNodeOf(project, clip);
}

/** Active generated audio is independent of whether its source happened to be an audio asset, video, or no media asset. */
export function generatedCardAudioClipsAt(project: Project, t: number): { clip: TrackClip; media?: MediaAsset; volume: number }[] {
  const out: { clip: TrackClip; media?: MediaAsset; volume: number }[] = [];
  // Card sound attached to a speed-changed video clip is produced as usual: audio media effect cards
  // (user decision, 2026-10-23: "Allow it.") and audio-visual cards (user decision, same day: "Let it
  // make sound.")
  // read this clip's media with speed and pitch changing along with the rate (`varispeedBlock` in
  // `render/cards/audioSources.ts`); for the card clock of audio-visual cards see `cardClockOffset` in
  // `kernel/clipTime.mjs`
  // Online browser mode: media effect cards (including audio media effect cards) cannot be rendered on
  // this device (C10 contract section 9, they are produced by render nodes), so they are not
  // evaluated and no `/@media/<hash>/pcm` request is sent; the native sound of this clip is still
  // muted by `shouldMuteNativeAudio`, and the media's sound is not substituted
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
 * In-page evaluation: find the node → the definition in the registry →
 * `audio(sources, { start, count, sampleRate }, params)`.
 * `fetchImpl` stays in the signature only so as not to touch consumers (`renderMix.ts:61` still
 * passes it the old way); the chunks themselves no longer go over HTTP.
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
      // Synced cards: handed to the isolated sound host (the editor page does not execute their audio());
      // the rest are evaluated in the page
      const samples = routed.route === "isolated"
        ? checkedIsolatedBlock(await isolatedHost!.render(x, signal), x.count)
        : await evaluateCardAudio(context, x.nodeId, { start: x.start, count: x.count, sampleRate: x.sampleRate });
      const channels = samples.length / x.count;
      if (!Number.isInteger(channels) || channels < 1) throw new CardAudioError("invalid-reply", "invalid card audio descriptor");
      const reply: CardAudioReply = { samples, format: "wav", sampleRate: x.sampleRate, frames: x.count, channels };
      // A response carrying a url (only the lease path has one) is still checked for same origin
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
  // Delete it once the whole piece is assembled: one stereo chunk is 1_048_576 × 2 × 4 = 8 MB, and
  // without deleting it would stay resident for the whole life of the project.
  // Removing only the samples field does not work: leaving a response without samples would make the
  // next fetch get an empty chunk.
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

/** Validates persistent sound. The online side only takes the WAV and does not execute the user card's audio(). */
export function persistentCardAudio(project: Project, clip: TrackClip) {
  return resolveCardAudioRendition(project, clip, { getCard: hooks?.getCard,
    sourceVersionOf: (id) => onlinePage() && syncedUserCards().get(id)?.audioSourceVersion
      ? syncedUserCards().get(id)!.audioSourceVersion
      : hooks?.getCard(id) ? hooks.sourceVersionOf(id) : syncedUserCards().get(id)?.audioSourceVersion });
}
/** Checked once before export: cut segments are expanded the same way as the mix (`audioProjectOf`)
 * into the referenced cut, and an audio card inside that makes sound which is missing or stale is
 * likewise reported on the spot with the original clip.
 * Audio-visual cards on speed-changed clips must be checked too (user decision, 2026-10-23: "Let it
 * make sound.") */
export function assertProjectCardAudio(project: Project) {
  for (const track of audioProjectOf(project).tracks) for (const clip of track.clips) {
    if (track.hidden || track.muted || clip.audioMuted || !(clipHasEmbeddedAudio(project, clip, hooks?.getCard) || syncedUserCards().get(clip.cardId)?.embeddedAudio)) continue;
    persistentCardAudio(project, clip);
  }
}

/**
 * Reuses the existing audio() sampling pipeline, yielding to the page after each small chunk. It
 * runs only on an explicit generate action; the preview never regenerates automatically.
 */
export async function renderEmbeddedCardWav(project: Project, clip: TrackClip, signal: AbortSignal,
  onProgress?: (done: number, total: number) => void): Promise<{ wav: Uint8Array; channels: number; frames: number }> {
  requireCardAudioHooks();
  const nodeId = cardAudioNodeOf(project, clip);
  if (onlinePage() && !(nodeId && onlineCardAudioSynthesizable(project, nodeId))) throw new Error((nodeId && onlineCardAudioBlocker(project, nodeId)) || ONLINE_CARD_AUDIO_BLOCKED);
  if (!nodeId || !clipHasEmbeddedAudio(project, clip, cardAudioGraphCard)) throw new Error("This card has no embedded audio");
  assertAudiovisualCardKind(cardAudioGraphCard(clip.cardId));
  cardAudioIdentity(project, clip, cardAudioIdentityHooks());
  const frames = Math.round((clip.end - clip.start) * CARD_AUDIO_SAMPLE_RATE);
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > 60 * CARD_AUDIO_SAMPLE_RATE) throw new Error("Card audio generation range must be between 1 sample and 60 seconds");
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
    } else if (blockChannels !== channels) throw new Error("The channel count of card audio cannot change during generation");
    for (let i = 0; i < samples.length; i++) view!.setFloat32(44 + (start * channels + i) * 4, samples[i], true);
    onProgress?.(start + count, frames);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return { wav: output!, frames, channels };
}

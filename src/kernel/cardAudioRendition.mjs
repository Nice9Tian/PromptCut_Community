import { cardJson } from './cardGraph.mjs';
import { cardClockOffset, clipSpeed, speedMutesSource } from './clipTime.mjs';

/**
 * The audio of an audio-visual card belongs to the original clip and cannot be separated as a
 * normal asset. Pure audio media effect cards are not audio-visual cards.
 */
export const isAudiovisualCard = def => !!def && typeof def.audio === 'function' &&
  (typeof def.Component === 'function' || typeof def.Component === 'object' && def.Component !== null || typeof def.card === 'function');
export function assertAudiovisualCardKind(def) {
  if (isAudiovisualCard(def) && def.kind === 'audio') throw new Error('Audio-visual cards cannot use kind:audio, declare a visual type: animation/filter/transition/emphasis');
}
const nodeOf = (p, c) => p.cardNodes?.find(n => n.id === c.nodeId);
export function clipHasEmbeddedAudio(project, clip, getCard = () => undefined) {
  const node = nodeOf(project, clip);
  return isAudiovisualCard(getCard(clip.cardId || node?.cardId)) || clip.embeddedAudio === true || node?.embeddedAudio === true || !!clip.cardAudio;
}
export function clipHasAudio(project, clip, getCard = () => undefined) {
  // Cut segments (kernel/cutSegments.ts) carry the mix of the referenced cut: can be independently
  // muted or have volume adjusted
  if (typeof clip.cutId === 'string' && clip.cutId) return true;
  const node = nodeOf(project, clip), media = project.media?.find(m => m.id === clip.mediaId);
  return clipHasEmbeddedAudio(project, clip, getCard) || node?.adapter === 'card' && node.kind === 'audio' ||
    typeof getCard(clip.cardId || node?.cardId)?.audio === 'function' || media?.kind === 'video' || media?.kind === 'audio';
}
/**
 * **Card audio** attached to this clip: audio-visual cards, audio media effect cards, and the
 * already generated one.
 * Excludes the asset's own original audio: when asking "does a speed-changed clip still emit
 * sound", what is needed is precisely "whether there is any audio other than original audio", so
 * the difference between here and `clipHasAudio` is the trailing `media.kind` part (which refers
 * to original audio).
 */
export function clipHasCardAudio(project, clip, getCard = () => undefined) {
  const node = nodeOf(project, clip);
  if (clipHasEmbeddedAudio(project, clip, getCard)) return true;
  if (node?.adapter === 'card' && node.kind === 'audio') return true;
  return typeof getCard(clip.cardId || node?.cardId)?.audio === 'function';
}

/**
 * This clip **produces no sound at all** (criterion for the timeline badge, after user decision,
 * 2026-10-23).
 *
 * Speed-changed media clips produce no original audio (`clipTime.mjs`'s `speedMutesSource`), but
 * on that day the user relaxed two things (semantics `docs/semantics/product/project-model.md`
 * "Audio"): audio-visual cards attached to a speed-changed clip emit sound as usual ("Emits
 * sound."), and speed-changed clips can also serve as audio inputs for audio media effect cards
 * ("Relaxed."). So "speed-changed" no longer equals "no sound": only when original audio is not
 * produced **and** no card audio is attached to it is this clip truly silent.
 *
 * What is checked is "attached to this clip": when a card elsewhere takes this clip's asset as
 * input, audio comes from that card, which does not count as this clip emitting sound.
 */
export function clipGoesSilentBySpeed(project, clip, getCard = () => undefined) {
  return speedMutesSource(clip, project) && !clipHasCardAudio(project, clip, getCard);
}

/**
 * Shared source clock for both paths. Splitting has already written both mediaOffset/node.timeOffset;
 * they must never be added together.
 * On speed-changed media clips, follow the card clock (mediaOffset / speed, `clipTime.mjs`'s
 * `cardClockOffset`; at 1x it is bit-for-bit mediaOffset): splitting and trimming only advance it by
 * those few seconds on the timeline, and already-generated audio is aligned as before by "current
 * source clock - interval start" (user decision, 2026-10-23, "Emits sound.").
 */
export function cardAudioSourceOffset(project, clip) {
  return cardClockOffset(clip) ?? nodeOf(project, clip)?.timeOffset ?? 0;
}
export class CardAudioRenditionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, clip, message) => { throw new CardAudioRenditionError(code, `Card audio for ${clip.id}: ${message}`); };

/**
 * Synchronous pure-data identity: parameter/event tables, all upstream asset hashes and mappings,
 * code version. The online client without source code only reads saved snapshots.
 */
export function cardAudioIdentity(project, clip, hooks = {}, saved = clip.cardAudio?.identity) {
  const getCard = hooks.getCard ?? (() => undefined), versions = hooks.sourceVersionOf;
  const nodes = new Map((project.cardNodes ?? []).map(n => [n.id, n]));
  const clips = (project.tracks ?? []).flatMap(t => t.clips ?? []);
  const root = nodeOf(project, clip) ?? { cardId: clip.cardId, inputs: {} };
  const visit = (node, owner, fallback, seen = new Set()) => {
    if (seen.has(node)) fail('stale', clip, 'inputs form a cycle, cannot generate');
    const nextSeen = new Set(seen).add(node), def = getCard(node.cardId);
    const defaults = def?.defaults ?? fallback?.defaults ?? {};
    const sourceVersion = versions?.(node.cardId) ?? fallback?.sourceVersion;
    if (!sourceVersion) fail('missing', clip, 'source version is missing, please regenerate locally');
    const inputs = {};
    for (const [name, raw] of Object.entries(node.inputs ?? {})) {
      const ref = typeof raw === 'string' ? { nodeId: raw } : raw;
      const sourceId = /^@clip\/(.+)\/source$/.exec(ref.nodeId)?.[1];
      const sourceClip = sourceId ? clips.find(c => c.id === sourceId) : undefined;
      if (sourceId) {
        const media = project.media?.find(m => m.id === sourceClip?.mediaId);
        if (!media?.hash) fail('missing', clip, 'input media is missing or has no content hash');
        // Its own asset is already accessed via the source clock; split edge compensation must not change
        // the identity again.
        const offset = sourceClip === owner ? (ref.offset ?? 0) + (node.timeOffset ?? 0) : (ref.offset ?? 0) + (sourceClip?.mediaOffset ?? 0);
        // When an input media clip changes speed, audio changes speed and pitch accordingly (varispeedBlock
        // in audioSources.ts); the speed ratio enters identity; omitted at 1x, leaving identity verbatim
        // unchanged
        const speed = clipSpeed(sourceClip);
        inputs[name] = { media: media.hash, offset, rate: ref.rate ?? 1, ...(speed !== 1 ? { speed } : {}) };
      } else {
        const upstream = nodes.get(ref.nodeId);
        if (!upstream) fail('missing', clip, 'input node has been deleted');
        const upstreamOwner = clips.find(c => c.nodeId === upstream.id);
        inputs[name] = { offset: ref.offset ?? 0, rate: ref.rate ?? 1,
          value: visit(upstream, upstreamOwner, fallback?.inputs?.[name]?.value, nextSeen) };
      }
    }
    return { cardId: node.cardId, sourceVersion, defaults, params: { ...defaults, ...(owner?.params ?? node.params ?? {}) }, inputs,
      ...(owner === clip ? {} : { timeOffset: node.timeOffset ?? 0 }) };
  };
  return JSON.parse(cardJson(visit(root, clip, saved)));
}

/**
 * Clips expanded from cut segments (`audioProjectOf` in `cutAudio.mjs`, with `cutOrigin`): their
 * ids carry the cut segment path prefix, and start/end are translated and trimmed; input assets
 * looked up by clip id in identity cannot be found in the expanded project. Therefore, verify
 * identity and coverage against its original clip in the referenced cut (same standard as when
 * generated in that cut); if the original clip cannot be found (bad data), verify against the
 * expanded clip.
 */
function cutOriginOf(project, clip) {
  const o = clip.cutOrigin;
  if (!o || typeof o.cutId !== 'string' || typeof o.clipId !== 'string') return null;
  const tracks = project.cuts?.find(c => c.id === o.cutId)?.tracks;
  if (!Array.isArray(tracks)) return null;
  const original = tracks.flatMap(t => t.clips ?? []).find(c => c.id === o.clipId);
  return original ? { project: { ...project, tracks }, clip: original } : null;
}

/**
 * A WAV's sourceOffset is its interval start; play offset is current source clock minus interval
 * start. Supports trimming/splitting covered by the original WAV.
 */
export function resolveCardAudioRendition(project, clip, hooks = {}) {
  const origin = cutOriginOf(project, clip);
  if (origin) {
    // The whole original clip was verified, and the expanded one is a section of it: add the trimmed
    // section to offset (source clock was already shifted forward by the same amount upon expansion)
    const base = resolveCardAudioRendition(origin.project, origin.clip, hooks);
    const shift = cardAudioSourceOffset(project, clip) - cardAudioSourceOffset(origin.project, origin.clip);
    return { ...base, offset: base.offset + Math.round(shift * base.rendition.sampleRate) / base.rendition.sampleRate };
  }
  const r = clip.cardAudio;
  if (!r) fail('missing', clip, 'not generated yet, please generate the card audio first');
  if (r.version !== 1 || r.cardId !== clip.cardId || r.sampleRate !== 48000 || !Number.isSafeInteger(r.frames) || r.frames < 1 ||
      !Number.isInteger(r.channels) || r.channels < 1 || r.channels > 8 || !Number.isFinite(r.sourceOffset) || !r.identity)
    fail('stale', clip, 'record is invalid, please regenerate');
  const identity = cardAudioIdentity(project, clip, hooks);
  if (cardJson(identity) !== cardJson(r.identity)) fail('stale', clip, 'out of date (parameters, events, inputs or source have changed), please regenerate');
  const offset = cardAudioSourceOffset(project, clip) - r.sourceOffset;
  const frames = Math.round((clip.end - clip.start) * r.sampleRate), start = Math.round(offset * r.sampleRate);
  if (!Number.isFinite(offset) || start < 0 || frames < 1 || start + frames > r.frames)
    fail('stale', clip, 'prerender output does not cover the current range, please regenerate');
  const media = project.media?.find(m => m.id === r.mediaId);
  if (!media || media.kind !== 'audio' || !/^[0-9a-f]{64}$/i.test(media.hash ?? '') || !media.url || /^blob:/.test(media.url) || media.pending)
    fail('missing', clip, 'media is missing, please restore the media or regenerate');
  return { media, offset: start / r.sampleRate, rendition: r };
}

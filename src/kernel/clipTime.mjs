/**
 * Clip speed and the conversion between "timeline time ↔ media time". The only copy in the whole project;
 * every place calls it instead of writing its own.
 *
 * # Rule
 *
 *   media time = mediaOffset + (timeline time − start) × speed
 *
 * `speed` is the playback speed of a media clip (`TrackClip.speed`), 1 by default. 0.5 is slow motion
 * (1 second on the timeline only advances 0.5 seconds of the media), 2 is fast forward. Only set it on
 * **video** media clips (images have no time, and a sound clip with a speed change would be silent, see below).
 *
 * # With the default 1 nothing changes by a single byte
 *
 * - If there is no `speed` field, or it is not a finite positive number, it counts as 1. In IEEE 754
 *   `x × 1 === x` and `x / 1 === x`, so `mediaOffset + (t − start) × 1` is bit-for-bit identical to the
 *   old `mediaOffset + (t − start)`.
 * - When the store writes a speed, setting it back to 1 deletes the field (`withSpeed`) and does not leave
 *   `speed: 1`: the few identities that hash a whole track list (the frame identity of the frame service,
 *   the project hash of the mirror, the snapshot signature) stay unchanged as long as the clip object has
 *   no extra key.
 * - The places that pick individual fields into a key (the input signature of the layer table, the asset
 *   node of the card graph) only add this item when `speed !== 1` (`speedKeyPart`).
 *
 * # Sound
 *
 * [ruling] In the first version the original audio of a speed-changed clip is never output
 * (`speedMutesSource`), and the UI says so. The browser's offline mix has no ready-made pitch-preserving
 * speed change; ffmpeg has `atempo`; the two would produce different results, which would break
 * "export matches preview" (`src/audio/renderMix.ts` and `server/bakery/mux-audio.mjs` correspond one to
 * one). Only "no sound" is guaranteed to match on both sides.
 *
 * Plain JS (.mjs): the server (export composition, viewing frames, frame identity) imports it directly,
 * without going through TS.
 */

/** Lower and upper limits of the speed (multiples) */
export const CLIP_SPEED_MIN = 0.25;
export const CLIP_SPEED_MAX = 4;
/**
 * The sentence in the UI that says "a speed-changed clip has no original audio" ([ruling], first version):
 * the same sentence in the desktop editing section and in the "Speed" panel of the mobile app
 */
export const SPEED_MUTE_NOTE = "After a speed change, this video segment plays no original audio (the first version has no speed-changed audio). To hear sound, split the audio from the video; the split-out audio follows the speed change and its pitch shifts. Set it back to 1× to restore.";
/** The note for when a sound clip (including ones separated by audio-visual separation) changes speed */
export const SPEED_AUDIO_NOTE = "Audio segments shift in pitch after a speed change (the first version has no pitch-preserving speed change).";
/** The few presets offered in the UI */
export const CLIP_SPEED_PRESETS = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]);

/** The speed of a clip; 1 when absent or not a finite positive number */
export function clipSpeed(clip) {
  const s = clip?.speed;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 1;
}

/** This clip has had its speed changed (it is not 1) */
export function isSpeedChanged(clip) {
  return clipSpeed(clip) !== 1;
}

/**
 * Whether the **original video audio** of this clip is silenced because of the speed change ([ruling] in
 * the first version, the original audio of speed-changed clips is muted). Only video media clips count:
 * card clips and cut segments have no media speed;
 * **sound clips** (the asset is audio, for example the one separated out by audio-visual separation) still
 * make sound when their speed changes, with the pitch changing with the rate (`ffmpegVarispeed` /
 * `resampleVarispeed`, user decision, 2026-10-23: "separation is allowed, record the distortion problem
 * as a to-do").
 * If `project` is given, it judges by the kind of the asset; if not (places that cannot get the project),
 * it is treated as video.
 * The preview's sound layer, the export mix (`audioPlanOf`) and loudness measurement all use this one.
 * The card sound of a card attached to a speed-changed video clip is not governed by it: an **audio media
 * effect card** reads this clip's asset as its input, and its speed and pitch change with the rate
 * (`varispeedBlock` in `render/cards/audioSources.ts`, user decision, 2026-10-23: "allow it."); an
 * **integrated audio-visual card** also makes sound as usual (user decision, 2026-10-23: "make sound."),
 * its speed and pitch change the same way when it reads this clip's asset, and the part it synthesizes
 * itself follows the card's clock (`cardClockOffset`).
 */
export function speedMutesSource(clip, project) {
  if (!clip?.mediaId || !isSpeedChanged(clip)) return false;
  const kind = Array.isArray(project?.media) ? project.media.find((m) => m?.id === clip.mediaId)?.kind : undefined;
  return kind !== "audio";
}

/**
 * The filter segment in ffmpeg for a sound clip's speed change (with pitch change): first unify the
 * sample rate, then `asetrate` treats it as a sample rate faster/slower by a factor of speed, then
 * resample back. When reading the asset, `duration × speed` seconds must be read, so that exactly the
 * duration on the timeline comes out. The two export mixing paths (the segment trimming of Chrome's
 * offline mix, and the ffmpeg mix) and the loudness measurement all use this one copy, so both paths get
 * the same resampling result. Returns an empty array when speed is 1 (the filter chain does not change
 * by a single word).
 */
export function ffmpegVarispeed(speed, rate = 48000) {
  if (!(speed > 0) || speed === 1) return [];
  return [`aresample=${rate}`, `asetrate=${Math.round(rate * speed)}`, `aresample=${rate}`];
}

/**
 * The speed change with pitch change on the online browser export path (which has no ffmpeg): starting
 * at `src[from]`, stepping by speed, take n samples with linear interpolation.
 * The semantics are the same as `ffmpegVarispeed` (sample i on the timeline = sample from + i × speed of
 * the media), and the interpolation algorithm differs (ffmpeg uses swr's sinc).
 */
export function resampleVarispeed(src, from, speed, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = from + i * speed;
    const k = Math.floor(x);
    if (k < 0 || k >= src.length) continue;
    const f = x - k;
    const a = src[k], b = k + 1 < src.length ? src[k + 1] : a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

/**
 * The starting point (seconds) of the **card clock** of an integrated audio-visual card: for an integrated
 * audio-visual card attached to a media clip, both the picture (`t`) and the sound (`range.start` of
 * `audio()`) run on "in-clip time (timeline seconds) + this starting point", and the already generated
 * card sound is also aligned by it (`cardAudioSourceOffset` of `cardAudioRendition.mjs`).
 *
 *   card clock start = mediaOffset ÷ speed
 *
 * At 1x it is just `mediaOffset` (bit-for-bit identical; `x / 1` is not done: the original value is
 * returned directly). Why divide by the rate when the speed changes: splitting and trimming advance the
 * media start by the rate (`mediaOffsetAfter`: going dt seconds forward on the timeline adds dt × speed to
 * mediaOffset), while the card's own picture and sound run in timeline seconds.
 * If the start used mediaOffset directly, then when a 2x clip is split at second d, the card clock of the
 * second half would jump forward by d seconds out of nowhere (the picture jumps a stretch, the already
 * generated sound is misaligned, or is judged "not covered" and has to be regenerated); after dividing by
 * the rate, splitting and trimming only advance it by dt, which connects with the clock at that moment
 * before the split.
 * The path on which the card reads this clip's media is unaffected: the position at which the media is read
 * is still mediaOffset + (in-clip time + the offset of the edge) × speed (`withMediaRates` compensates the
 * edge). When `mediaOffset` is not written it returns undefined, and the caller falls back to the node's
 * `timeOffset` as before.
 */
export function cardClockOffset(clip) {
  const m = clip?.mediaOffset;
  if (m === undefined || m === null) return undefined;
  const s = clipSpeed(clip);
  return s === 1 ? m : m / s;
}

/** Timeline time t → media time (seconds) */
export function mediaTimeAt(clip, t) {
  return (clip.mediaOffset ?? 0) + (t - clip.start) * clipSpeed(clip);
}

/** Media time → timeline time (seconds). The inverse function of `mediaTimeAt` */
export function timelineTimeAt(clip, mediaSec) {
  return clip.start + (mediaSec - (clip.mediaOffset ?? 0)) / clipSpeed(clip);
}

/**
 * The media start after moving `dt` seconds (timeline) forward from the clip start: the second half of a
 * split, the part trimmed off a cut segment
 */
export function mediaOffsetAfter(clip, dt) {
  return (clip.mediaOffset ?? 0) + dt * clipSpeed(clip);
}

/** How many seconds of media a stretch of `dur` on the timeline (the whole clip by default) uses up */
export function mediaSpanOf(clip, dur = clip.end - clip.start) {
  return dur * clipSpeed(clip);
}

/** How many seconds of timeline a stretch of media duration takes up on this clip */
export function timelineSpanOf(clip, mediaDur) {
  return mediaDur / clipSpeed(clip);
}

/**
 * Normalizes the input speed into a valid value: not a finite positive number → null (the caller
 * rejects it); otherwise clamp to [MIN, MAX] and round to 0.01x.
 */
export function normalizeSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Math.min(CLIP_SPEED_MAX, Math.max(CLIP_SPEED_MIN, n)) * 100) / 100;
}

/**
 * Whether this rate is within the allowed range (a manually entered rate outside the range is rejected,
 * not clamped, so the user knows)
 */
export function speedInRange(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= CLIP_SPEED_MIN - 1e-9 && n <= CLIP_SPEED_MAX + 1e-9;
}

/**
 * The clip with the new speed applied (a new object); when the speed is 1 the **field is deleted**,
 * leaving no `speed: 1` (see the file header, "With the default 1 nothing changes by a single byte")
 */
export function withSpeed(clip, speed) {
  const { speed: _old, ...rest } = clip;
  return speed === 1 ? rest : { ...rest, speed };
}

/**
 * The item that goes into the identity key: `{ speed }` when the speed is not 1, null when it is 1
 * (spreading it adds nothing)
 */
export function speedKeyPart(clip) {
  const s = clipSpeed(clip);
  return s === 1 ? null : { speed: s };
}

/**
 * Adds the rate `rate` to the media nodes of speed-changed clips in the card graph (the result of
 * `projectCardGraph` in `kernel/cardGraph.mjs`) (frame fetch time = in-clip time × rate + offset,
 * `render/cards/GraphCard.tsx`). It goes into the node's identity, so the prerender keys of media effect
 * cards connected to this media and of transitions change with it (without it, old snapshots would be
 * hit and the picture would be wrong without any error).
 *
 * Why it is not written directly in `projectCardGraph`: `cardGraph.mjs` is in the source import closure
 * of the built-in sound cards, and changing a single word in it would make every card sound the user has
 * already generated be judged "expired" (gatekeeper test `src/render/audioCardSourceVersion.test.mjs`,
 * source `docs/plan/prerender-products-contract.md` section 9.2). So the few places that produce pictures
 * and keys call this one function after getting the graph: the export page (picture and `__pcCardPlan`),
 * the stage, the nested scene of cut segments, and the card plan of the online page
 * (`editor/browserNodeHost.ts`).
 *
 * The same place also swaps the card clock for the **integrated audio-visual card nodes** attached to
 * speed-changed media clips (user decision, 2026-10-23: "make sound."): `projectCardGraph` writes its
 * `timeOffset` as `mediaOffset` (media seconds), and here it is changed to `cardClockOffset` (mediaOffset ÷
 * speed), and the same difference is added to the `offset` of the edge by which it reads its own clip's
 * media, so the position at which the media is read does not change by a single sample (see
 * `cardClockOffset`). The picture (`GraphCard.tsx`) and the sound (`audio/cardAudio.ts`, the online sound
 * thread) take the same graph, so both sides share the same clock.
 *
 * When there are no speed-changed clips it returns **the same object** (graph and keys are unchanged by a
 * single byte).
 */
export function withMediaRates(project, graph) {
  if (!graph || !Array.isArray(graph.nodes)) return graph;
  const rates = new Map(), clocks = new Map();
  for (const track of Array.isArray(project?.tracks) ? project.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
      if (!clip?.mediaId || !isSpeedChanged(clip)) continue;
      rates.set(`@clip/${clip.id}/source`, clipSpeed(clip));
      if (typeof clip.nodeId === "string" && typeof clip.mediaOffset === "number") clocks.set(clip.nodeId, clip);
    }
  }
  if (!rates.size) return graph;
  return { ...graph, nodes: graph.nodes.map((node) => {
    if (node?.adapter === "media" && rates.has(node.id)) return { ...node, rate: rates.get(node.id) };
    const clip = node?.adapter === "card" && node.embeddedAudio === true ? clocks.get(node.id) : undefined;
    // projectCardGraph only writes timeOffset as mediaOffset when mediaOffset has a value (the instance
    // parameters part of cardGraph.mjs), and this only handles that case
    if (!clip || node.timeOffset !== clip.mediaOffset) return node;
    const clock = cardClockOffset(clip), shift = clip.mediaOffset - clock, own = `@clip/${clip.id}/source`;
    const inputs = Object.fromEntries(Object.entries(node.inputs ?? {}).map(([name, ref]) =>
      [name, ref && typeof ref === "object" && ref.nodeId === own ? { ...ref, offset: (ref.offset ?? 0) + shift } : ref]));
    return { ...node, timeOffset: clock, inputs };
  }) };
}

const TRANSITION_NAME = { crossfade: "Crossfade", fadeIn: "Fade in", fadeOut: "Fade out" };

/**
 * The note after changing speed (shared by the hint of the desktop editing section and the bubble of the
 * mobile app): how many seconds the transitions shrank with it, which ones moved along, how many clips
 * behind were pushed apart.
 * Returns null if there is nothing to say. `r` is the result of a successful setClipSpeed of the store.
 */
export function speedChangeNotes(r, clipId) {
  const parts = [];
  for (const t of r?.transitions ?? []) parts.push(`${TRANSITION_NAME[t.kind] ?? "Transition"} shortened accordingly: ${t.from.toFixed(2)} s → ${t.to.toFixed(2)} s (this segment got shorter, so the original transition no longer fits)`);
  const moved = r?.moved ?? [];
  if (moved.includes(clipId)) parts.push("To shorten the crossfade, this segment was shifted later as a whole (content unchanged)");
  if (moved.some((id) => id !== clipId)) parts.push("The other segment of the crossfade was shifted too");
  if (r?.pushed) parts.push(`The following ${r.pushed.clips} segments were pushed later by ${r.pushed.by.toFixed(2)} s`);
  return parts.length ? parts.join("; ") : null;
}

/** The multiple shown to people: `2×`, `0.5×` */
export function speedLabel(speed) {
  return `${Math.round(speed * 100) / 100}×`;
}

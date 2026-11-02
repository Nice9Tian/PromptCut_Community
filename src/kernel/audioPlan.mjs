/**
 * Manifest of "who makes sound when, and how loud" on the timeline; pure function, does not
 * touch disk.
 *
 * Three places share the same rules to avoid implementing them separately and getting out of sync:
 *   - Export mix (buildAudioPlan in server/bakery/mux-audio.mjs → ffmpeg; Chrome offline rendering
 *     in server/bakery/audio-mix.mjs)
 *   - Loudness measurement (timeline tier of measure_audio; browser sends this manifest to server)
 *   - Preview does not use it (preview queries audioClipsAt / videoLayersAt by timestamp), but
 *     rules match: hidden / muted tracks make no sound, clips with audioMuted make no sound,
 *     speed-changed video clips do not emit original audio (`speedMutesSource`; speed-changed
 *     audio clips emit sound and pitch-shift as usual; integrated audio-visual cards attached
 *     to speed-changed clips emit sound as usual), images have no sound,
 *     volume = opacity × audioVolume, linear fade-in / fade-out.
 */

import { audioFxOfClip } from "./audioFx.mjs";
import { clipHasEmbeddedAudio, resolveCardAudioRendition } from "./cardAudioRendition.mjs";
import { audioProjectOf, envelopeAt } from "./cutAudio.mjs";
import { clipSpeed, speedMutesSource } from "./clipTime.mjs";

const r3 = (n) => +Number(n).toFixed(3);

/**
 * @returns Each entry: { clipId, trackId, mediaId, start, dur, offset, volume, fadeIn, fadeOut, fx: { def, params } | null, env? }
 *   start / dur are timeline positions (seconds), offset is start second within media. Order is
 *   tracks top-to-bottom, clips in original order.
 *   Cut segments (kernel/cutSegments.ts): first expands cut segments in the active cut into
 *   translated, trimmed clips via `audioProjectOf`; their clipId carries the cut segment path
 *   prefix, and `env` is the envelope of outer segments (absolute timeline time), multiplied by
 *   the mixer (`gainCurve`).
 *   Projects without cut segments remain byte-for-byte identical to before.
 */
export function audioPlanOf(source) {
  const project = audioProjectOf(source);
  const out = [];
  for (const tr of project.tracks || []) {
    if (tr.hidden || tr.muted) continue;
    for (const c of tr.clips || []) {
      if (c.audioMuted) continue;
      // [ruling] In v1, speed-changed clips emit no original audio (header of kernel/clipTime.mjs):
      // browser offline mixing and ffmpeg cannot produce identical varispeed audio; only "no audio"
      // matches on both sides. Audio effects attached to it also emit no sound (their audio source is
      // this original audio).
      // Integrated audio-visual cards emit sound as usual (user decision, 2026-10-23: "Emit sound."):
      // their audio is already-generated WAV, originally generated according to timeline duration
      // (reading this media was already varispeeded and pitch-shifted with rate; see cardClockOffset in
      // clipTime.mjs for card clock), positioned here at 1x without carrying speed.
      // Audio media effect cards do not use this manifest (handled separately by buildAudioPlan in
      // mux-audio); when a speed-changed clip is its input, it varispeeds and pitch-shifts with rate
      // (user decision, 2026-10-23: "Allow.").
      const embedded = clipHasEmbeddedAudio(project, c);
      if (!embedded && speedMutesSource(c, project)) continue;
      const rendition = embedded ? resolveCardAudioRendition(project, c) : null;
      const m = rendition?.media ?? (project.media || []).find((x) => x.id === c.mediaId);
      // Synthesized audio is stored project content; losing references must not silently export silent clips.
      const generated = embedded || !!(c.soundEffect || m?.soundEffect);
      if (generated && (!m || !m.url)) throw new Error(`The synthesized sound effect media for ${c.id} is missing, please regenerate it or restore the media`);
      if (!c.mediaId && !embedded) continue;
      if (!m || !m.url || m.kind === "image") continue;
      // Ordinary legacy media keeps existing standards; synthesized WAV positioning is kept to samples, not rounded to ms first.
      const time = generated ? (value) => value : r3;
      const dur = time(c.end - c.start);
      if (!(dur > 0)) continue;
      const def = audioFxOfClip(project, c);
      out.push({
        clipId: c.id,
        trackId: tr.id,
        mediaId: m.id,
        start: time(c.start),
        dur,
        offset: time(rendition?.offset ?? c.mediaOffset ?? 0),
        volume: (c.opacity ?? 1) * (c.audioVolume ?? 1),
        fadeIn: c.fadeIn ?? 0,
        fadeOut: c.fadeOut ?? 0,
        fx: def ? { def, params: c.audioFx.params } : null,
        // Speed-changed audio clips (separated from audio-visual): varispeed and pitch-shift with rate;
        // both mix paths use ffmpegVarispeed (kernel/clipTime.mjs); default 1 omits this field, keeping
        // the manifest verbatim.
        ...(!generated && clipSpeed(c) !== 1 ? { speed: clipSpeed(c) } : null),
        ...(c.cutEnv?.length ? { env: c.cutEnv } : null),
      });
    }
  }
  return out;
}

/**
 * Volume envelope of a clip: volume × fade-in (linear 0→1) × fade-out (linear 1→0), sampled
 * into n points (one each at start and end, equidistant between).
 * Semantics are identical to the ffmpeg path (server/bakery/mux-audio.mjs: afade t=in then
 * afade t=out, default tri curve): multiplying two fades together.
 * When fade-in and fade-out overlap (fadeIn + fadeOut > dur), it is the product of two slopes
 * (parabola); when fade-in is longer than the clip, the end reaches only dur/fadeIn, naturally
 * yielded by multiplication. Previously, "stitching two automations together" would have the
 * entire fade-in swallowed by AudioParam event ordering during overlap (tested: hard jump).
 * Export fills it via setValueCurveAtTime with linear interpolation between points; 5 ms per
 * point is sufficient.
 */
export function fadeEnvelope(volume, fadeIn, fadeOut, dur, n) {
  const count = Math.max(2, Math.floor(n) || 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * dur;
    let g = volume;
    if (fadeIn > 0) g *= Math.min(1, t / fadeIn);
    if (fadeOut > 0) g *= Math.min(1, (dur - t) / fadeOut);
    out[i] = Math.max(0, g);
  }
  return out;
}

/**
 * Full gain curve for a clip: `fadeEnvelope` multiplied by the cut segment envelope (`entry.env`,
 * absolute timeline time).
 * Point-by-point identical to `fadeEnvelope` when there is no envelope.
 */
export function gainCurve(entry, n) {
  const curve = fadeEnvelope(entry.volume, entry.fadeIn, entry.fadeOut, entry.dur, n);
  if (!entry.env?.length) return curve;
  const count = curve.length;
  for (let i = 0; i < count; i++) {
    // The envelope is open at the interval's right end; the curve's last point falls at the clip end,
    // so step back slightly to avoid the last point computing as 0 and causing clicks
    const t = entry.start + Math.min((i / (count - 1)) * entry.dur, entry.dur - 1e-6);
    for (const e of entry.env) curve[i] *= envelopeAt(e, t, false);
  }
  return curve;
}

/** Whether this segment needs a point-by-point gain curve (has fading or cut segment envelopes) */
export function needsGainCurve(entry) {
  return entry.fadeIn > 0 || entry.fadeOut > 0 || !!entry.env?.some((e) => (e.fadeIn ?? 0) > 0 || (e.fadeOut ?? 0) > 0);
}

/** Clips currently producing sound at timeline time T (for second-by-second loudness attribution) */
export function soundingAt(plan, T) {
  return plan.filter((p) => T >= p.start && T < p.start + p.dur).map((p) => p.clipId);
}

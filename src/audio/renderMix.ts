/**
 * The exported mix: renders the sound of the whole timeline into one piece of PCM in an
 * OfflineAudioContext.
 *
 * The input is the plan.json written by server/bakery/audio-mix.mjs: one wav per segment that ffmpeg
 * has already trimmed (containing only the stretch the timeline uses, 48 kHz stereo float), plus its
 * position on the timeline, volume, fades, and attached effects. What is done here corresponds
 * one-to-one with the old ffmpeg route (server/bakery/mux-audio.mjs): adelay = start
 * (source.start(at)), afade = gain automation (linear, the same as afade's default tri),
 * volume = gain, amix normalize=0 = plain summation; the only addition is the effect chain
 * (src/audio/fxChain.ts, the same one as the preview).
 *
 * Why the whole media file is not handed to decodeAudioData: a 10-minute 4K video file is 1 GB, and
 * the browser would have to read all of it into memory before decoding; after ffmpeg trims it to the
 * few seconds actually used, it is a few MB.
 */

import { isAudioFxAnimated, type AudioFxDef } from "../kernel/audioFx.mjs";
import { gainCurve, needsGainCurve } from "../kernel/audioPlan.mjs";
import type { CutEnvelope } from "../kernel/cutAudio.mjs";
import { buildFxChain } from "./fxChain";
import { decodeCardAudioClip, type CardAudioClip } from "./cardAudio";

export interface MixPlanClip {
  clipId: string;
  /** Address of the trimmed wav (same origin) */
  url: string;
  start: number;
  dur: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  fx: { def: AudioFxDef; params?: Record<string, number> } | null;
  /** The sound produced by an audio media effect card. If present it completely replaces url, and it must be obtained. */
  cardAudio?: CardAudioClip;
  /**
   * Clips expanded from a cut segment: the envelopes of the outer segments (absolute timeline time,
   * multiplied in by gainCurve of kernel/audioPlan.mjs)
   */
  env?: CutEnvelope[];
}

export interface MixPlan {
  sampleRate: number;
  duration: number;
  clips: MixPlanClip[];
}

/**
 * Effects that vary over time are automated at this step (50 Hz: finer than the zipper-noise
 * threshold, yet not tens of thousands of entries)
 */
const AUTOMATION_STEP = 0.02;

export interface MixResult {
  buffer: AudioBuffer;
  /** Render time (milliseconds) */
  ms: number;
  /**
   * Notes from decoding / wiring each segment. A failure rejects the whole export; a track must not
   * be dropped silently.
   */
  notes: string[];
}

export async function renderMix(plan: MixPlan, fetchImpl: typeof fetch = fetch): Promise<MixResult> {
  const sr = plan.sampleRate || 48000;
  const length = Math.max(1, Math.ceil(plan.duration * sr));
  const ctx = new OfflineAudioContext(2, length, sr);
  const notes: string[] = [];
  const t0 = performance.now();

  // Decode all inputs first (in parallel), then wire. A media effect card chunk that comes up short,
  // a failed evaluation, or an ordinary wav that cannot be read must all make the export fail; this
  // used to return null, which would produce a final video that silently dropped a track.
  const buffers = await Promise.all(
    plan.clips.map(async (c) => {
      try {
        if (c.cardAudio) return await decodeCardAudioClip(ctx, c.cardAudio, fetchImpl);
        const res = await fetchImpl(c.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await ctx.decodeAudioData(await res.arrayBuffer());
      } catch (e) {
        const message = `Audio of ${c.clipId} could not be decoded: ${e instanceof Error ? e.message : String(e)}`;
        notes.push(message);
        throw new Error(message, { cause: e });
      }
    }),
  );

  plan.clips.forEach((c, i) => {
    const buf = buffers[i];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    // Fades × volume: lay in one curve (fadeEnvelope in kernel/audioPlan.mjs, consistent with ffmpeg's
    // two afades multiplied together).
    // Do not stitch two stretches of automation: when the fades overlap, events are sorted by time, and
    // setValueAtTime would be inserted before the fade-in's ramp, swallowing the whole fade-in
    if (needsGainCurve(c)) {
      g.gain.setValueCurveAtTime(gainCurve(c, Math.ceil(c.dur * 200) + 1), c.start, c.dur);
    } else {
      g.gain.value = c.volume;
    }
    src.connect(g);
    let tail: AudioNode = g;
    if (c.fx) {
      const animated = isAudioFxAnimated(c.fx.def);
      const chain = buildFxChain(ctx, c.fx.def, c.fx.params, c.dur, animated);
      tail.connect(chain.input);
      tail = chain.output;
      if (animated) {
        // The first point pins the start with setValueAtTime, then linearRamp point by point: continuous
        // like the preview's setTargetAtTime; otherwise an a-rate parameter (gain / frequency / pan) jumping
        // every 20 ms would produce a stair-step sound
        chain.setTime(0, c.dur, c.start, false);
        for (let t = AUTOMATION_STEP; t <= c.dur + 1e-9; t += AUTOMATION_STEP) chain.setTime(t, c.dur, c.start + t, true);
      } else {
        chain.setTime(0, c.dur, c.start, false);
      }
    }
    tail.connect(ctx.destination);
    src.start(c.start, 0, c.dur);
  });

  const buffer = await ctx.startRendering();
  return { buffer, ms: performance.now() - t0, notes };
}

/** AudioBuffer → 32-bit float WAV (read directly by ffmpeg, without quantizing again) */
export function encodeWavFloat32(buffer: AudioBuffer): ArrayBuffer {
  const ch = buffer.numberOfChannels;
  const n = buffer.length;
  const bytes = n * ch * 4;
  const out = new ArrayBuffer(44 + bytes);
  const v = new DataView(out);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + bytes, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, ch, true);
  v.setUint32(24, buffer.sampleRate, true); v.setUint32(28, buffer.sampleRate * ch * 4, true);
  v.setUint16(32, ch * 4, true); v.setUint16(34, 32, true);
  str(36, "data"); v.setUint32(40, bytes, true);
  const chans = Array.from({ length: ch }, (_, i) => buffer.getChannelData(i));
  const f = new Float32Array(out, 44, n * ch);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) f[i * ch + c] = chans[c][i];
  return out;
}

/** Peak (largest absolute value), for the export log and measure */
export function peakOf(buffer: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  return peak;
}

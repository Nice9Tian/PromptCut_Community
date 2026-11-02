/**
 * Decoding half of custom measurement (`measure_audio_js`, plan `docs/plan/agent-workflow-plan.md`
 * A6): decodes the target audio with ffmpeg into 32-bit floating-point PCM, splits it by channel
 * into Float32Array, and passes it to `audio-sandbox.mjs` to run Agent-written JS inside an isolated
 * Chrome instance.
 *
 * "Target selection" is completely consistent with built-in `measure_audio`: clip (the slice of
 * asset original audio used by that clip), asset (entire file), timeline (mix, same mix graph
 * `timelineMixParts` as loudness measurement / export). This file contains only pure functions
 * and a decode function that spawns ffmpeg; it does not touch vite.
 *
 * Numeric [ruling] see `PCM_LIMITS`: default 16 kHz (sufficient for RMS, peak, zero-crossing rate,
 * spectrum below 8 kHz), up to 48 kHz; up to 2 channels (multichannel source mixed to stereo),
 * `mono: true` downmixed to mono; all channels combined hold up to `maxSamples` samples (~6 minutes
 * of 16 kHz stereo); if exceeded, aborts decoding and returns advice on how to reduce (downsampling,
 * mono, measure a single slice).
 */
import { spawn } from "node:child_process";
import { timelineMixParts } from "./audio-measure.mjs";
import { tr } from "./i18n.mjs";

export const PCM_LIMITS = Object.freeze({
  defaultSampleRate: 16000,
  minSampleRate: 8000,
  maxSampleRate: 48000,
  maxChannels: 2,
  /** Maximum sample count across all channels combined (Float32, 12M samples = 48 MB) */
  maxSamples: 12_000_000,
  /** Timeout for ffmpeg decoding */
  decodeTimeoutMs: 30_000,
});

/** Normalize sample rate and channels: clamp sample rate to [min, max] and round; default if omitted */
export function pcmFormat({ sampleRate, mono } = {}, limits = PCM_LIMITS) {
  const raw = Number(sampleRate);
  const sr = Number.isFinite(raw) && raw > 0
    ? Math.round(Math.min(limits.maxSampleRate, Math.max(limits.minSampleRate, raw)))
    : limits.defaultSampleRate;
  return { sampleRate: sr, mono: mono === true };
}

/**
 * Before decoding, checks whether sample count will exceed the limit based on expected duration.
 * Returns null when `duration` is unknown (entire asset, duration not probed), counting while
 * reading during decoding. If exceeded, returns guidance for the Agent to reduce it accordingly.
 */
export function sampleBudgetError({ duration, sampleRate, channels }, limits = PCM_LIMITS) {
  if (!(duration > 0)) return null;
  const need = Math.ceil(duration * sampleRate) * channels;
  if (need <= limits.maxSamples) return null;
  const maxSec = Math.floor(limits.maxSamples / (sampleRate * channels));
  return tr("The segment to measure is {0} s, {1} Hz, {2} channels, {3} samples in total, over the limit of {4}", duration.toFixed(1), sampleRate, channels, need, limits.maxSamples) +
    tr(" (at most {0} s at this sample rate and channel count). Lower sampleRate, pass mono: true, or measure only one segment with start / duration.", maxSec);
}

/**
 * Crops a sub-window (`start` / `duration`, in seconds relative to the start of that audio)
 * within the audio selected by "target selection". Returns `{ offset, duration }`: offset is the
 * start point in the source file (clip / asset) or mix; duration may be undefined (measure to end).
 */
export function windowOf({ baseOffset = 0, baseDuration, start, duration }) {
  const s = Number(start);
  const d = Number(duration);
  const from = Number.isFinite(s) && s > 0 ? s : 0;
  if (baseDuration !== undefined && from >= baseDuration) throw new Error(tr("start {0} s is beyond the length of this audio ({1} s)", from, baseDuration));
  let dur = baseDuration !== undefined ? baseDuration - from : undefined;
  if (Number.isFinite(d) && d > 0) dur = dur === undefined ? d : Math.min(dur, d);
  return { offset: baseOffset + from, duration: dur };
}

const pcmOut = ({ sampleRate, channels }) => ["-ac", String(channels), "-ar", String(sampleRate), "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"];

/**
 * Downmixing to mono = averaging all channels. ffmpeg `-ac 1` defaults to power-based mixing
 * (multiplying each stereo channel by 0.707), where two identical sine waves mix to 3 dB louder
 * than the original, causing a 3 dB discrepancy when the Agent compares against mono assets;
 * here we explicitly average them.
 */
export function averagePan(sourceChannels) {
  const n = Math.max(1, Math.floor(sourceChannels));
  const w = +(1 / n).toFixed(6);
  return "pan=mono|c0=" + Array.from({ length: n }, (_, i) => `${w}*c${i}`).join("+");
}

/**
 * ffmpeg arguments for decoding a single file (asset / clip) to PCM. sourceChannels: source channel
 * count; averages channels when mono and source has more than one channel
 */
export function filePcmArgs({ file, offset, duration, sampleRate, channels, sourceChannels = channels }) {
  const args = ["-hide_banner", "-nostats", "-v", "error"];
  if (offset !== undefined && offset > 0) args.push("-ss", String(offset));
  if (duration !== undefined) args.push("-t", String(duration));
  args.push("-i", file, "-map", "0:a:0", "-vn");
  if (channels === 1 && sourceChannels > 1) args.push("-af", averagePan(sourceChannels));
  args.push(...pcmOut({ sampleRate, channels }));
  return args;
}

/**
 * ffmpeg arguments for decoding timeline mix to PCM. Uses the same mix graph as loudness
 * measurement (`timelineMixParts`), then trims by window.
 * @param {Array<object>} entries Same as `timelineMeasureArgs`
 * @param {{ total?: number, offset?: number, duration?: number, sampleRate: number, channels: number }} opts
 */
export function timelinePcmArgs(entries, { total, offset = 0, duration, sampleRate, channels }) {
  const { inputs, filters, mix } = timelineMixParts(entries, total);
  let tail = "";
  if (offset > 0 || duration !== undefined) {
    tail = `,atrim=start=${offset}${duration !== undefined ? `:duration=${duration}` : ""},asetpts=PTS-STARTPTS`;
  }
  // Mix channel count follows input (mono asset mixes to mono); when mono is requested,
  // normalize to stereo first then average
  if (channels === 1) tail += `,aformat=channel_layouts=stereo,${averagePan(2)}`;
  return [
    "-hide_banner", "-nostats", "-v", "error", ...inputs,
    "-filter_complex", [...filters, `${mix}${tail}[aout]`].join(";"),
    "-map", "[aout]", ...pcmOut({ sampleRate, channels }),
  ];
}

/**
 * Splits interleaved f32le bytes into one Float32Array per channel. When byte length is not an
 * integer multiple of 4 × channel count, drops the incomplete trailing frame.
 * @param {Buffer} buf
 * @param {number} channels
 */
export function deinterleave(buf, channels) {
  const frames = Math.floor(buf.length / (4 * channels));
  // Copy to 4-byte-aligned memory before reading (Buffer may land on an odd offset in the pool)
  const aligned = new Float32Array(frames * channels);
  new Uint8Array(aligned.buffer).set(buf.subarray(0, frames * channels * 4));
  if (channels === 1) return [aligned];
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0, k = 0; i < frames; i++) for (let c = 0; c < channels; c++) out[c][i] = aligned[k++];
  return out;
}

/**
 * Runs ffmpeg and collects stdout into PCM. Counts while reading: kills immediately and returns
 * an error if `maxSamples` is exceeded; also kills on timeout.
 * @returns {Promise<Float32Array[]>}
 */
export function decodePcm(ffmpeg, args, { channels, sampleRate, limits = PCM_LIMITS, spawnImpl = spawn } = {}) {
  const maxBytes = limits.maxSamples * 4;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(ffmpeg, args, { windowsHide: true });
    const chunks = [];
    let bytes = 0;
    let stderr = "";
    let failed = null;
    const fail = (msg) => { if (!failed) { failed = msg; try { child.kill(); } catch { /* Already exited */ } } };
    const timer = setTimeout(() => fail(tr("Decoding timed out ({0} s)", limits.decodeTimeoutMs / 1000)), limits.decodeTimeoutMs);
    child.stdout.on("data", (d) => {
      if (failed) return;
      bytes += d.length;
      if (bytes > maxBytes) {
        const maxSec = Math.floor(limits.maxSamples / (sampleRate * channels));
        fail(tr("The audio to measure exceeds the sample limit {0} (at most {3} s at {1} Hz, {2} channels). Lower sampleRate, pass mono: true, or measure only one segment with start / duration.", limits.maxSamples, sampleRate, channels, maxSec));
        return;
      }
      chunks.push(d);
    });
    child.stderr.on("data", (d) => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(tr("Failed to start ffmpeg: ") + e.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return reject(new Error(failed));
      if (code !== 0) return reject(new Error(tr("ffmpeg decoding failed: ") + stderr.trim().slice(-300)));
      resolve(deinterleave(Buffer.concat(chunks), channels));
    });
  });
}

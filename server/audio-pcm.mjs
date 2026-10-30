/**
 * 自定义测量(`measure_audio_js`,计划 `docs/plan/agent-workflow-plan.md` A6)的解码那一半:把要测的那段声音
 * 用 ffmpeg 解成 32 位浮点 PCM,按声道拆成 Float32Array,交给 `audio-sandbox.mjs` 在隔离的 Chrome 里跑 Agent 写的 JS。
 *
 * 「测谁」与内置的 `measure_audio` 完全一致:片段(那一段用到的那截素材原声)、素材(整个文件)、时间轴(混音,
 * 与测响度 / 导出同一张混音图 `timelineMixParts`)。本文件只有纯函数和一个 spawn ffmpeg 的解码函数,不碰 vite。
 *
 * 数字〔裁〕见 `PCM_LIMITS`:缺省 16 kHz(够算 RMS、峰值、过零率、8 kHz 以下的频谱),最多 48 kHz;声道最多 2 个
 * (多声道源混成立体声),`mono: true` 混成单声道;所有声道加起来最多 `maxSamples` 个样本(16 kHz 立体声约 6 分钟),
 * 超了先不解码,回一句怎么缩(降采样、单声道、只测一段)。
 */
import { spawn } from "node:child_process";
import { timelineMixParts } from "./audio-measure.mjs";

export const PCM_LIMITS = Object.freeze({
  defaultSampleRate: 16000,
  minSampleRate: 8000,
  maxSampleRate: 48000,
  maxChannels: 2,
  /** 所有声道加起来的样本数上限(Float32,12M 个 = 48 MB) */
  maxSamples: 12_000_000,
  /** ffmpeg 解码的时限 */
  decodeTimeoutMs: 30_000,
});

/** 规整采样率与声道:采样率夹到 [min, max] 并取整,不给按缺省 */
export function pcmFormat({ sampleRate, mono } = {}, limits = PCM_LIMITS) {
  const raw = Number(sampleRate);
  const sr = Number.isFinite(raw) && raw > 0
    ? Math.round(Math.min(limits.maxSampleRate, Math.max(limits.minSampleRate, raw)))
    : limits.defaultSampleRate;
  return { sampleRate: sr, mono: mono === true };
}

/**
 * 解码前按预计时长判样本数会不会超。`duration` 不知道(整个素材、没探出时长)时回 null,解码时边读边数。
 * 超了回一句 Agent 能照着缩的话。
 */
export function sampleBudgetError({ duration, sampleRate, channels }, limits = PCM_LIMITS) {
  if (!(duration > 0)) return null;
  const need = Math.ceil(duration * sampleRate) * channels;
  if (need <= limits.maxSamples) return null;
  const maxSec = Math.floor(limits.maxSamples / (sampleRate * channels));
  return `要测的这段 ${duration.toFixed(1)} 秒、${sampleRate} Hz、${channels} 声道,共 ${need} 个样本,超过上限 ${limits.maxSamples}` +
    `(这个采样率和声道数下最多 ${maxSec} 秒)。降 sampleRate、传 mono: true,或用 start / duration 只测一段。`;
}

/**
 * 在「测谁」选出的那段声音里再截一个窗口(`start` / `duration`,相对那段声音的开头,秒)。
 * 回 `{ offset, duration }`:offset 是在源文件(片段 / 素材)或混音里的起点,duration 可能是 undefined(测到结尾)。
 */
export function windowOf({ baseOffset = 0, baseDuration, start, duration }) {
  const s = Number(start);
  const d = Number(duration);
  const from = Number.isFinite(s) && s > 0 ? s : 0;
  if (baseDuration !== undefined && from >= baseDuration) throw new Error(`start ${from} 秒超出了这段声音的长度(${baseDuration} 秒)`);
  let dur = baseDuration !== undefined ? baseDuration - from : undefined;
  if (Number.isFinite(d) && d > 0) dur = dur === undefined ? d : Math.min(dur, d);
  return { offset: baseOffset + from, duration: dur };
}

const pcmOut = ({ sampleRate, channels }) => ["-ac", String(channels), "-ar", String(sampleRate), "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"];

/**
 * 混成单声道 = 各声道取平均。ffmpeg 的 `-ac 1` 缺省按功率混(立体声每路乘 0.707),两路相同的正弦波混出来比原来响 3 dB,
 * Agent 拿去和单声道素材比会差 3 dB;这里显式按平均混。
 */
export function averagePan(sourceChannels) {
  const n = Math.max(1, Math.floor(sourceChannels));
  const w = +(1 / n).toFixed(6);
  return "pan=mono|c0=" + Array.from({ length: n }, (_, i) => `${w}*c${i}`).join("+");
}

/** 单个文件(素材 / 片段)解码成 PCM 的 ffmpeg 参数。sourceChannels:源的声道数,mono 且源多于一个声道时按平均混 */
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
 * 时间轴混音解码成 PCM 的 ffmpeg 参数。混音图与测响度同一份(`timelineMixParts`),再按窗口截一段。
 * @param {Array<object>} entries 同 `timelineMeasureArgs`
 * @param {{ total?: number, offset?: number, duration?: number, sampleRate: number, channels: number }} opts
 */
export function timelinePcmArgs(entries, { total, offset = 0, duration, sampleRate, channels }) {
  const { inputs, filters, mix } = timelineMixParts(entries, total);
  let tail = "";
  if (offset > 0 || duration !== undefined) {
    tail = `,atrim=start=${offset}${duration !== undefined ? `:duration=${duration}` : ""},asetpts=PTS-STARTPTS`;
  }
  // 混音的声道数随输入(单声道素材混出单声道);要单声道时先统一成立体声再按平均混
  if (channels === 1) tail += `,aformat=channel_layouts=stereo,${averagePan(2)}`;
  return [
    "-hide_banner", "-nostats", "-v", "error", ...inputs,
    "-filter_complex", [...filters, `${mix}${tail}[aout]`].join(";"),
    "-map", "[aout]", ...pcmOut({ sampleRate, channels }),
  ];
}

/**
 * 交错的 f32le 字节拆成每声道一个 Float32Array。字节数不是 4 × 声道数的整倍数时丢掉尾巴上不完整的那一帧。
 * @param {Buffer} buf
 * @param {number} channels
 */
export function deinterleave(buf, channels) {
  const frames = Math.floor(buf.length / (4 * channels));
  // 拷到一块 4 字节对齐的内存再读(Buffer 可能落在池子里的奇数偏移上)
  const aligned = new Float32Array(frames * channels);
  new Uint8Array(aligned.buffer).set(buf.subarray(0, frames * channels * 4));
  if (channels === 1) return [aligned];
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0, k = 0; i < frames; i++) for (let c = 0; c < channels; c++) out[c][i] = aligned[k++];
  return out;
}

/**
 * 跑 ffmpeg,把 stdout 收成 PCM。边读边数:超过 `maxSamples` 立即杀掉并回错;超时同样杀掉。
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
    const fail = (msg) => { if (!failed) { failed = msg; try { child.kill(); } catch { /* 已经退了 */ } } };
    const timer = setTimeout(() => fail(`解码超时(${limits.decodeTimeoutMs / 1000} 秒)`), limits.decodeTimeoutMs);
    child.stdout.on("data", (d) => {
      if (failed) return;
      bytes += d.length;
      if (bytes > maxBytes) {
        const maxSec = Math.floor(limits.maxSamples / (sampleRate * channels));
        fail(`要测的声音超过样本上限 ${limits.maxSamples}(${sampleRate} Hz、${channels} 声道下最多 ${maxSec} 秒)。降 sampleRate、传 mono: true,或用 start / duration 只测一段。`);
        return;
      }
      chunks.push(d);
    });
    child.stderr.on("data", (d) => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error("启动 ffmpeg 失败: " + e.message)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return reject(new Error(failed));
      if (code !== 0) return reject(new Error("ffmpeg 解码失败: " + stderr.trim().slice(-300)));
      resolve(deinterleave(Buffer.concat(chunks), channels));
    });
  });
}

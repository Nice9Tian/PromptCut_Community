/**
 * 导出的混音:在 OfflineAudioContext 里把整条时间轴的声音渲成一段 PCM。
 *
 * 输入是 server/bakery/audio-mix.mjs 写好的 plan.json:每段一个 ffmpeg 已经裁好的 wav(只含时间轴用到的那一截,
 * 48 kHz 立体声 float),加上它在时间轴的位置、音量、淡入淡出、挂的效果。这里做的事和 ffmpeg 那条老路
 * (server/bakery/mux-audio.mjs)一一对应:adelay = start(source.start(at)),afade = 增益自动化(线性,和 afade 默认的 tri 一样),
 * volume = 增益,amix normalize=0 = 直接相加 —— 多出来的只有效果链(src/audio/fxChain.ts,和预览同一份)。
 *
 * 为什么不把整个素材文件塞给 decodeAudioData:一段 10 分钟的 4K 视频文件就是 1 GB,浏览器要整份读进内存再解;
 * ffmpeg 先裁成用到的那几秒是几 MB。
 */

import { isAudioFxAnimated, type AudioFxDef } from "../kernel/audioFx.mjs";
import { gainCurve, needsGainCurve } from "../kernel/audioPlan.mjs";
import type { CutEnvelope } from "../kernel/cutAudio.mjs";
import { buildFxChain } from "./fxChain";
import { decodeCardAudioClip, type CardAudioClip } from "./cardAudio";

export interface MixPlanClip {
  clipId: string;
  /** 裁好的 wav 地址(同源) */
  url: string;
  start: number;
  dur: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  fx: { def: AudioFxDef; params?: Record<string, number> } | null;
  /** 音频素材效果卡产的声音。有它就完全取代 url,而且一定要拿到。 */
  cardAudio?: CardAudioClip;
  /** 剪辑段展开出来的片段:外层各段的包络(时间轴绝对时间,kernel/audioPlan.mjs 的 gainCurve 乘上去) */
  env?: CutEnvelope[];
}

export interface MixPlan {
  sampleRate: number;
  duration: number;
  clips: MixPlanClip[];
}

/** 随时间变的效果按这个步长排自动化(50 Hz:比拉链噪声的门槛细,又不至于排几万条) */
const AUTOMATION_STEP = 0.02;

export interface MixResult {
  buffer: AudioBuffer;
  /** 渲染耗时(毫秒) */
  ms: number;
  /** 各段解码 / 接线时的提醒。失败会拒绝整个导出，不能静默漏一轨。 */
  notes: string[];
}

export async function renderMix(plan: MixPlan, fetchImpl: typeof fetch = fetch): Promise<MixResult> {
  const sr = plan.sampleRate || 48000;
  const length = Math.max(1, Math.ceil(plan.duration * sr));
  const ctx = new OfflineAudioContext(2, length, sr);
  const notes: string[] = [];
  const t0 = performance.now();

  // 先把所有输入解好(并行),再接线。一个素材效果卡块短了、求值失败或普通 wav
  // 读不到都必须让导出失败；以前这里返回 null 会产出一条悄悄漏轨的成片。
  const buffers = await Promise.all(
    plan.clips.map(async (c) => {
      try {
        if (c.cardAudio) return await decodeCardAudioClip(ctx, c.cardAudio, fetchImpl);
        const res = await fetchImpl(c.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await ctx.decodeAudioData(await res.arrayBuffer());
      } catch (e) {
        const message = `${c.clipId} 的声音解不出来:${e instanceof Error ? e.message : String(e)}`;
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
    // 淡入淡出 × 音量:一条曲线铺进去(kernel/audioPlan.mjs 的 fadeEnvelope,和 ffmpeg 两条 afade 相乘一致)。
    // 不用两段自动化拼:淡入淡出重叠时事件按时间排序,setValueAtTime 会插到淡入的 ramp 前面,把淡入整个吃掉
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
        // 第一点 setValueAtTime 定住起点,之后逐点 linearRamp —— 和预览的 setTargetAtTime 一样是连续的,
        // 不然 a-rate 参数(增益 / 频率 / 声像)每 20 ms 一跳会有台阶声
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

/** AudioBuffer → 32 位浮点 WAV(ffmpeg 直接读,不再量化一次) */
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

/** 峰值(绝对值最大),给导出日志和 measure 用 */
export function peakOf(buffer: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  return peak;
}

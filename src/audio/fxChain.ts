/**
 * 音频效果的节点图:把 kernel/audioFx.mjs 里「这一刻每个参数是多少」接成 Web Audio 节点。
 *
 * 预览(src/audio/previewAudio.ts,实时 AudioContext)和导出(src/audio/renderMix.ts,OfflineAudioContext)
 * 都调这里的 buildFxChain —— 同一份代码、同一套 DSP,所以编辑台听到的就是导出的。这是整个音频效果系统
 * 成立的前提,别在两边各写一份。
 *
 * # 每种效果怎么接
 *   gain        GainNode,gain = 10^(db/20)
 *   highpass /  BiquadFilterNode。注意规范里这两种的 Q 是**分贝**(峰值量),不是传统 Q:
 *   lowpass     Q_dB = 20·log10(q)。q = 0.707 → -3.01 dB 就是 Butterworth,实测和 ffmpeg highpass=w=0.707 差 -91.8 dB
 *   peaking     BiquadFilterNode,Q 是传统 Q,gain 是 dB
 *   lowshelf /  BiquadFilterNode,只有 frequency 和 gain
 *   highshelf
 *   compressor  DynamicsCompressorNode。Chrome 会自动补偿增益(makeup,见规范 full_range_makeup_gain^0.6),
 *               压过的人声会比原来响一点 —— 这通常正是想要的,保留
 *   limiter     同一个节点,threshold = ceiling、knee 0、ratio 20、attack 1 ms、release 100 ms,
 *               再接一个 GainNode 把上面那个自动补偿**抵消掉**,不然峰值会超过 ceiling 约半个 dB
 *   delay       input → dry(1-mix) → out;input → DelayNode → wet(mix) → out;delay → feedback → delay
 *   reverb      input → dry(1-mix) → out;input → ConvolverNode(合成的脉冲响应,normalize=false) → wet(mix) → out。
 *               decay 决定脉冲响应的长度,换 decay 要重建节点,所以它不随时间变(表达式里写了也按初值)
 *   pan         StereoPannerNode
 *
 * 参数随时间变:apply(values, when) 把每一步的参数写到 AudioParam 上。预览每帧调、when 省略 →
 * setTargetAtTime 平滑到位(20 ms,免得拉链噪声);导出按固定步长排自动化、when 给绝对时间 → setValueAtTime。
 */

import { AUDIO_FX_KINDS, isNeutralOp, resolveAudioOps, reverbImpulse, type AudioFxDef, type ResolvedAudioOp } from "../kernel/audioFx.mjs";

export interface FxChain {
  input: AudioNode;
  output: AudioNode;
  /**
   * 这一刻的参数写到节点上。when 省略 = 现在(预览,setTargetAtTime 平滑过渡);给绝对秒数 = 排自动化(导出):
   * ramp 为 true 从上一点线性过渡到这一点(a-rate 参数用),false 是 setValueAtTime(第一点、以及 k-rate 的压缩器参数)
   */
  setTime(t: number, d: number, when?: number, ramp?: boolean): void;
  /** 有没有随时间变的参数;没有的话调用方只需 setTime 一次 */
  animated: boolean;
  dispose(): void;
}

/** 一步接好的节点:apply 把这一步的数值写进去 */
interface Stage {
  input: AudioNode;
  output: AudioNode;
  apply(values: Record<string, number>, when: number | undefined, ctx: BaseAudioContext, ramp: boolean): void;
  nodes: AudioNode[];
}

const SMOOTH = 0.02;
const dbToGain = (db: number) => Math.pow(10, db / 20);

function setParam(p: AudioParam, v: number, when: number | undefined, ctx: BaseAudioContext, ramp = false) {
  if (when === undefined) {
    p.setTargetAtTime(v, ctx.currentTime, SMOOTH);
  } else if (ramp) {
    p.linearRampToValueAtTime(v, when);
  } else {
    p.setValueAtTime(v, when);
  }
}

/* ---------------------------------------------------------------- 混响脉冲响应缓存 */

// 同一个 context 里同一个 decay 只合成一次(一条 2 秒的尾巴是 96000 × 2 个样本)
const irCache = new WeakMap<BaseAudioContext, Map<number, AudioBuffer>>();
function irBufferFor(ctx: BaseAudioContext, decay: number): AudioBuffer {
  let m = irCache.get(ctx);
  if (!m) irCache.set(ctx, (m = new Map()));
  const key = Math.round(decay * 100) / 100;
  let buf = m.get(key);
  if (!buf) {
    const [l, r] = reverbImpulse(ctx.sampleRate, key);
    buf = ctx.createBuffer(2, l.length, ctx.sampleRate);
    buf.copyToChannel(l, 0);
    buf.copyToChannel(r, 1);
    m.set(key, buf);
  }
  return buf;
}

/**
 * 规范里 DynamicsCompressor 的自动补偿增益:full_range_gain = 压缩曲线在 0 dBFS 处的线性输出,
 * makeup = (1 / full_range_gain)^0.6。限幅器要把它抵消掉,ceiling 才是真的上限。
 */
function compressorMakeupDb(thresholdDb: number, kneeDb: number, ratio: number): number {
  const x = 0; // 0 dBFS
  let y: number;
  if (x < thresholdDb - kneeDb / 2) y = x;
  else if (x > thresholdDb + kneeDb / 2 || kneeDb === 0) y = thresholdDb + (x - thresholdDb) / ratio;
  else {
    const k = x - thresholdDb + kneeDb / 2;
    y = x + ((1 / ratio - 1) * k * k) / (2 * kneeDb);
  }
  return -0.6 * y; // dB
}

/* ---------------------------------------------------------------- 每种效果 */

function stageOf(ctx: BaseAudioContext, op: ResolvedAudioOp): Stage {
  const { kind, values } = op;
  if (kind === "gain") {
    const g = ctx.createGain();
    g.gain.value = dbToGain(values.db);
    return { input: g, output: g, nodes: [g], apply: (v, when, c, ramp) => setParam(g.gain, dbToGain(v.db), when, c, ramp) };
  }
  if (kind === "highpass" || kind === "lowpass") {
    const f = ctx.createBiquadFilter();
    f.type = kind;
    f.frequency.value = values.freq;
    f.Q.value = 20 * Math.log10(values.q);
    return {
      input: f, output: f, nodes: [f],
      apply: (v, when, c, ramp) => { setParam(f.frequency, v.freq, when, c, ramp); setParam(f.Q, 20 * Math.log10(v.q), when, c, ramp); },
    };
  }
  if (kind === "peaking") {
    const f = ctx.createBiquadFilter();
    f.type = "peaking";
    f.frequency.value = values.freq;
    f.Q.value = values.q;
    f.gain.value = values.db;
    return {
      input: f, output: f, nodes: [f],
      apply: (v, when, c, ramp) => { setParam(f.frequency, v.freq, when, c, ramp); setParam(f.Q, v.q, when, c, ramp); setParam(f.gain, v.db, when, c, ramp); },
    };
  }
  if (kind === "lowshelf" || kind === "highshelf") {
    const f = ctx.createBiquadFilter();
    f.type = kind;
    f.frequency.value = values.freq;
    f.gain.value = values.db;
    return {
      input: f, output: f, nodes: [f],
      apply: (v, when, c, ramp) => { setParam(f.frequency, v.freq, when, c, ramp); setParam(f.gain, v.db, when, c, ramp); },
    };
  }
  if (kind === "compressor") {
    const cp = ctx.createDynamicsCompressor();
    const set = (v: Record<string, number>, when: number | undefined, c: BaseAudioContext) => {
      setParam(cp.threshold, v.threshold, when, c);
      setParam(cp.knee, v.knee, when, c);
      setParam(cp.ratio, v.ratio, when, c);
      setParam(cp.attack, v.attack, when, c);
      setParam(cp.release, v.release, when, c);
    };
    cp.threshold.value = values.threshold; cp.knee.value = values.knee; cp.ratio.value = values.ratio;
    cp.attack.value = values.attack; cp.release.value = values.release;
    return { input: cp, output: cp, nodes: [cp], apply: set };
  }
  if (kind === "limiter") {
    const cp = ctx.createDynamicsCompressor();
    const trim = ctx.createGain();
    cp.connect(trim);
    /*
     * ratio 是 20 不是无穷:0 dBFS 进来稳态输出是 ceiling + (0 - ceiling)/20,比 ceiling 高 -ceiling/20 dB
     * (ceiling -12 时高 0.6 dB,实测 0.85)。把这一截也从 trim 里减掉;瞬态(attack 1 ms、没有前瞻)仍可能穿过去。
     */
    const trimDb = (ceiling: number) => -compressorMakeupDb(ceiling, 0, 20) + ceiling / 20;
    const set = (v: Record<string, number>, when: number | undefined, c: BaseAudioContext) => {
      setParam(cp.threshold, v.ceiling, when, c);
      setParam(trim.gain, dbToGain(trimDb(v.ceiling)), when, c);
    };
    cp.knee.value = 0; cp.ratio.value = 20; cp.attack.value = 0.001; cp.release.value = 0.1;
    cp.threshold.value = values.ceiling;
    trim.gain.value = dbToGain(trimDb(values.ceiling));
    return { input: cp, output: trim, nodes: [cp, trim], apply: set };
  }
  if (kind === "delay") {
    const inp = ctx.createGain();
    const out = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const dl = ctx.createDelay(2);
    const fb = ctx.createGain();
    inp.connect(dry).connect(out);
    inp.connect(dl).connect(wet).connect(out);
    dl.connect(fb).connect(dl);
    const set = (v: Record<string, number>, when: number | undefined, c: BaseAudioContext, ramp: boolean) => {
      setParam(dl.delayTime, v.time, when, c, ramp);
      setParam(fb.gain, v.feedback, when, c, ramp);
      setParam(wet.gain, v.mix, when, c, ramp);
      setParam(dry.gain, 1 - v.mix, when, c, ramp);
    };
    dl.delayTime.value = values.time; fb.gain.value = values.feedback; wet.gain.value = values.mix; dry.gain.value = 1 - values.mix;
    return { input: inp, output: out, nodes: [inp, out, dry, wet, dl, fb], apply: set };
  }
  if (kind === "reverb") {
    const inp = ctx.createGain();
    const out = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const cv = ctx.createConvolver();
    cv.normalize = false; // 脉冲响应已经按能量归一(kernel/audioFx.mjs 的 reverbImpulse)
    cv.buffer = irBufferFor(ctx, values.decay);
    inp.connect(dry).connect(out);
    inp.connect(cv).connect(wet).connect(out);
    const set = (v: Record<string, number>, when: number | undefined, c: BaseAudioContext, ramp: boolean) => {
      setParam(wet.gain, v.mix, when, c, ramp);
      setParam(dry.gain, 1 - v.mix, when, c, ramp);
    };
    wet.gain.value = values.mix; dry.gain.value = 1 - values.mix;
    return { input: inp, output: out, nodes: [inp, out, dry, wet, cv], apply: set };
  }
  if (kind === "pan") {
    const p = ctx.createStereoPanner();
    p.pan.value = values.pan;
    return { input: p, output: p, nodes: [p], apply: (v, when, c, ramp) => setParam(p.pan, v.pan, when, c, ramp) };
  }
  throw new Error(`不认识的音频效果种类 ${String(kind)}`);
}

/* ---------------------------------------------------------------- 整条链 */

/**
 * 按效果定义接一条链。中性的步骤(增益 0 dB、混响 mix 0……)在**不随时间变**时直接省掉,
 * 全省掉就是一个直通 GainNode。随时间变的一律接上 —— 现在中性不代表下一秒也中性。
 */
export function buildFxChain(ctx: BaseAudioContext, def: AudioFxDef, clipParams: Record<string, number> | undefined, d: number, animated: boolean): FxChain {
  const initial = resolveAudioOps(def, clipParams, 0, d);
  const stages: (Stage | null)[] = initial.map((op) => (!animated && isNeutralOp(op) ? null : stageOf(ctx, op)));
  const live = stages.filter((s): s is Stage => !!s);
  let input: AudioNode;
  let output: AudioNode;
  if (!live.length) {
    const g = ctx.createGain();
    input = output = g;
  } else {
    input = live[0].input;
    output = live[live.length - 1].output;
    for (let i = 0; i + 1 < live.length; i++) live[i].output.connect(live[i + 1].input);
  }
  return {
    input,
    output,
    animated,
    setTime(t, dd, when, ramp = false) {
      const ops = resolveAudioOps(def, clipParams, t, dd);
      ops.forEach((op, i) => {
        const s = stages[i];
        if (s) s.apply(op.values, when, ctx, ramp);
      });
    },
    dispose() {
      for (const s of live) for (const n of s.nodes) { try { n.disconnect(); } catch { /* 已经断了 */ } }
      if (!live.length) { try { input.disconnect(); } catch { /* 同上 */ } }
    },
  };
}

/** 同一个效果 + 同一份片段参数才能复用一条链;定义改了(update_audio_fx 是整份替换)key 就变 */
export function fxChainKey(def: AudioFxDef, clipParams: Record<string, number> | undefined, d: number): string {
  return `${def.id}|${JSON.stringify(def.ops)}|${JSON.stringify(def.params ?? null)}|${JSON.stringify(clipParams ?? null)}|${Math.round(d * 1000)}`;
}

export const FX_KINDS = AUDIO_FX_KINDS;

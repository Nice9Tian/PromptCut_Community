/**
 * The node graph of audio effects: wires "what each parameter is at this moment" from
 * kernel/audioFx.mjs into Web Audio nodes.
 *
 * Both the preview (src/audio/previewAudio.ts, live AudioContext) and the export
 * (src/audio/renderMix.ts, OfflineAudioContext) call buildFxChain here: the same code and the same
 * DSP, so what is heard in the editor is what is exported. This is the premise on which the whole
 * audio effects system stands; do not write a copy on each side.
 *
 * # How each effect is wired
 *   gain        GainNode, gain = 10^(db/20)
 *   highpass /  BiquadFilterNode. Note that in the spec the Q of these two is in **decibels** (peak
 *   lowpass     amount), not the traditional Q: Q_dB = 20·log10(q). q = 0.707 → -3.01 dB is
 *               Butterworth, and measured it differs from ffmpeg highpass=w=0.707 by -91.8 dB
 *   peaking     BiquadFilterNode, Q is the traditional Q, gain is in dB
 *   lowshelf /  BiquadFilterNode, only frequency and gain
 *   highshelf
 *   compressor  DynamicsCompressorNode. Chrome compensates the gain automatically (makeup, see spec
 *               full_range_makeup_gain^0.6), so compressed vocals come out a bit louder than the
 *               original: this is usually exactly what is wanted, so it is kept
 *   limiter     the same node, threshold = ceiling, knee 0, ratio 20, attack 1 ms, release 100 ms,
 *               followed by a GainNode that **cancels** the automatic compensation above, otherwise
 *               peaks would exceed the ceiling by about half a dB
 *   delay       input → dry(1-mix) → out; input → DelayNode → wet(mix) → out; delay → feedback → delay
 *   reverb      input → dry(1-mix) → out; input → ConvolverNode (synthesized impulse response,
 *               normalize=false) → wet(mix) → out. decay determines the length of the impulse
 *               response, and changing decay requires rebuilding the node, so it does not vary with
 *               time (even if an expression writes one, the initial value is used)
 *   pan         StereoPannerNode
 *
 * Parameters vary over time: apply(values, when) writes each step's parameters to the AudioParams.
 * The preview calls it every frame with when omitted → setTargetAtTime smooths to the target (20 ms,
 * to avoid zipper noise); the export schedules automation at a fixed step with when given as an
 * absolute time → setValueAtTime.
 */

import { AUDIO_FX_KINDS, isNeutralOp, resolveAudioOps, reverbImpulse, type AudioFxDef, type ResolvedAudioOp } from "../kernel/audioFx.mjs";

export interface FxChain {
  input: AudioNode;
  output: AudioNode;
  /**
   * Writes this moment's parameters to the nodes. when omitted = now (preview, smoothed with
   * setTargetAtTime); an absolute number of seconds = schedule automation (export):
   * ramp true transitions linearly from the previous point to this one (for a-rate parameters), and
   * false is setValueAtTime (the first point, and the compressor's k-rate parameters)
   */
  setTime(t: number, d: number, when?: number, ramp?: boolean): void;
  /** Whether any parameter varies over time; if none, the caller only needs to call setTime once */
  animated: boolean;
  dispose(): void;
}

/** The nodes wired for one step: apply writes this step's values into them */
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

/* ---------------------------------------------------------------- Reverb impulse response cache */

// In the same context, the same decay is synthesized only once (a 2-second tail is 96000 × 2 samples)
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
 * The automatic makeup gain of DynamicsCompressor in the spec: full_range_gain = the linear output of
 * the compression curve at 0 dBFS, makeup = (1 / full_range_gain)^0.6. The limiter has to cancel it
 * out for the ceiling to be the real upper limit.
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

/* ---------------------------------------------------------------- Each effect */

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
     * ratio is 20, not infinity: with 0 dBFS coming in, the steady-state output is
     * ceiling + (0 - ceiling)/20, which is -ceiling/20 dB above the ceiling (0.6 dB higher at
     * ceiling -12, measured 0.85). This stretch is also subtracted from the trim; transients
     * (attack 1 ms, no lookahead) can still get through.
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
    cv.normalize = false; // The impulse response is already normalized by energy (reverbImpulse in kernel/audioFx.mjs)
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
  throw new Error(`Unknown audio effect kind ${String(kind)}`);
}

/* ---------------------------------------------------------------- The whole chain */

/**
 * Wires a chain from the effect definitions. Neutral steps (gain 0 dB, reverb mix 0, ...) are simply
 * omitted when they **do not vary over time**, and omitting all of them leaves a pass-through
 * GainNode. Anything that varies over time is always wired in: being neutral now does not mean it
 * will be neutral a second later.
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
      for (const s of live) for (const n of s.nodes) { try { n.disconnect(); } catch { /* Already disconnected */ } }
      if (!live.length) { try { input.disconnect(); } catch { /* Same as above */ } }
    },
  };
}

/**
 * A chain can be reused only for the same effect + the same clip parameters; when the definition
 * changes (update_audio_fx replaces the whole thing) the key changes
 */
export function fxChainKey(def: AudioFxDef, clipParams: Record<string, number> | undefined, d: number): string {
  return `${def.id}|${JSON.stringify(def.ops)}|${JSON.stringify(def.params ?? null)}|${JSON.stringify(clipParams ?? null)}|${Math.round(d * 1000)}`;
}

export const FX_KINDS = AUDIO_FX_KINDS;

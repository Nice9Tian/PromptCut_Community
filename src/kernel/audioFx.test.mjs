/**
 * Unit tests for kernel/audioFx.mjs. Run: node --test src/kernel/audioFx.test.mjs
 *
 * Effect definitions are delivered by Agents; validation must keep non-compliant ones out and
 * use human-readable copy; numeric evaluation is shared between preview and export, with
 * expressions, parameter overrides, and neutrality checks locked down here; reverb impulse
 * response must be deterministic (generating once across both pipelines must be identical
 * sample-by-sample).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  AUDIO_FX_KINDS, AUDIO_FX_PRESETS, normalizeAudioFxDef, normalizeAudioClipParams, resolveAudioOps, isNeutralOp,
  isAudioFxAnimated, describeAudioFx, reverbImpulse, audioFxOfClip, clipAudioFxAt,
} from "./audioFx.mjs";

test("Definition: unfilled parameters take default; out-of-range numbers / unknown kinds / unknown parameters are all rejected", () => {
  const def = normalizeAudioFxDef({ name: "Test", ops: [{ kind: "highpass", freq: 100 }] });
  assert.deepEqual(def.ops, [{ kind: "highpass", freq: 100, q: 0.707 }]);
  assert.throws(() => normalizeAudioFxDef({ name: "x", ops: [{ kind: "gain", db: 40 }] }), /-60~24/);
  assert.throws(() => normalizeAudioFxDef({ name: "x", ops: [{ kind: "wah" }] }), /is not recognized/);
  assert.throws(() => normalizeAudioFxDef({ name: "x", ops: [{ kind: "gain", freq: 3 }] }), /no parameter freq/);
  assert.throws(() => normalizeAudioFxDef({ name: "x", ops: [] }), /at least one step/);
  assert.throws(() => normalizeAudioFxDef({ name: "", ops: [{ kind: "gain" }] }), /name is required/);
});

test("Definition: the { kind, params: {...} } form is also accepted and normalizes to the same result as the flat form", () => {
  const a = normalizeAudioFxDef({ name: "a", ops: [{ kind: "peaking", params: { freq: 3000, db: 3 } }] });
  const b = normalizeAudioFxDef({ name: "a", ops: [{ kind: "peaking", freq: 3000, db: 3 }] });
  assert.deepEqual(a.ops, b.ops);
});

test("Expressions: custom parameters go into expressions; a parameter name cannot collide with a kind's parameter name; NaN is rejected on the spot", () => {
  const def = normalizeAudioFxDef({
    name: "Fade in",
    params: { from: { default: -18, min: -60, max: 0 } },
    ops: [{ kind: "gain", db: "lerp(from, 0, smoothstep(0, 1, t))" }],
  });
  assert.equal(resolveAudioOps(def, undefined, 0, 4)[0].values.db, -18);
  assert.equal(resolveAudioOps(def, undefined, 2, 4)[0].values.db, 0);
  assert.equal(resolveAudioOps(def, { from: -6 }, 0, 4)[0].values.db, -6);
  assert.throws(() => normalizeAudioFxDef({ name: "x", params: { freq: 1 }, ops: [{ kind: "gain" }] }), /Parameter name "freq" is invalid/);
  assert.throws(() => normalizeAudioFxDef({ name: "x", ops: [{ kind: "gain", db: "log(0)" }] }), /evaluates to/);
  assert.throws(() => normalizeAudioFxDef({ name: "x", ops: [{ kind: "gain", db: "nope" }] }), /Unknown "nope"/);
});

test("Evaluation: out-of-range values are clamped, clip overrides only accept declared keys, neutral check", () => {
  const def = normalizeAudioFxDef({ name: "x", ops: [{ kind: "gain", db: "-30 * p" }, { kind: "reverb", mix: 0 }] });
  const ops = resolveAudioOps(def, undefined, 10, 10);
  assert.equal(ops[0].values.db, -30);
  assert.equal(isNeutralOp(ops[0]), false);
  assert.equal(isNeutralOp(ops[1]), true, "Reverb with mix 0 is the same as not applied");
  assert.equal(isNeutralOp(resolveAudioOps(def, undefined, 0, 10)[0]), true, "At p=0, a gain of 0 dB is neutral");
  assert.throws(() => normalizeAudioClipParams(def, { zzz: 1 }), /no parameter zzz/);
  const withP = normalizeAudioFxDef({ name: "y", params: { k: { default: 1, min: 0, max: 2 } }, ops: [{ kind: "gain", db: "k" }] });
  assert.deepEqual(normalizeAudioClipParams(withP, { k: 9 }), { k: 2 });
  assert.equal(normalizeAudioClipParams(withP, undefined), undefined);
});

test("Animation check and description", () => {
  const still = normalizeAudioFxDef({ name: "s", ops: [{ kind: "lowpass", freq: 3400 }, { kind: "gain", db: 3 }] });
  const anim = normalizeAudioFxDef({ name: "a", ops: [{ kind: "lowpass", freq: "lerp(400, 8000, p)" }] });
  assert.equal(isAudioFxAnimated(still), false);
  assert.equal(isAudioFxAnimated(anim), true);
  assert.equal(describeAudioFx(still), "Low-pass(Cutoff frequency 3400Hz) · Gain(Decibels 3dB)");
  assert.match(describeAudioFx(anim), /lerp/);
  assert.equal(describeAudioFx(normalizeAudioFxDef({ name: "d", ops: [{ kind: "compressor" }] })), "Compressor", "All defaults: report only the kind");
});

test("Reverb impulse response: deterministic, length = decay × sample rate, tail decays to -60 dB, left and right differ", () => {
  const [l, r] = reverbImpulse(48000, 0.5);
  const [l2] = reverbImpulse(48000, 0.5);
  assert.equal(l.length, 24000);
  assert.deepEqual(Array.from(l.subarray(0, 64)), Array.from(l2.subarray(0, 64)), "Two generations with the same parameters are identical sample by sample");
  assert.notDeepEqual(Array.from(l.subarray(0, 64)), Array.from(r.subarray(0, 64)), "Left and right channels use different seeds");
  // RMS ratio of first 1% to last 1% is ~1000 (60 dB); noise is random, relaxed to 300~3000
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const ratio = rms(l.subarray(0, 240)) / rms(l.subarray(l.length - 240));
  assert.ok(ratio > 300 && ratio < 3000, `Head-to-tail energy ratio ${ratio}`);
  let e = 0;
  for (const v of l) e += v * v;
  assert.ok(Math.abs(e - 1) < 1e-3, `Total energy normalized to 1, actual ${e}`);
});

test("All presets are valid and no names repeat", () => {
  const names = new Set();
  for (const p of AUDIO_FX_PRESETS) {
    const def = normalizeAudioFxDef(p);
    assert.ok(def.ops.length > 0);
    assert.ok(!names.has(def.name), `Duplicate preset name: ${def.name}`);
    names.add(def.name);
  }
});

test("Every effect's parameters have a label, and a default within min~max", () => {
  for (const [kind, spec] of Object.entries(AUDIO_FX_KINDS)) {
    for (const [k, ps] of Object.entries(spec.params)) {
      assert.ok(ps.label, `${kind}.${k} is missing label`);
      assert.ok(ps.default >= ps.min && ps.default <= ps.max, `default of ${kind}.${k} is out of range`);
    }
  }
});

test("Lookup in the project: find the definition by clip.audioFx, evaluate at the timeline time, and treat a deleted definition as not attached", () => {
  const def = { id: "afx1", ...normalizeAudioFxDef({ name: "g", ops: [{ kind: "gain", db: "-12 * p" }] }) };
  const project = { audioFx: [def] };
  const clip = { start: 10, end: 20, audioFx: { id: "afx1" } };
  assert.equal(audioFxOfClip(project, clip), def);
  assert.equal(clipAudioFxAt(project, clip, 15)[0].values.db, -6);
  assert.equal(clipAudioFxAt({ audioFx: [] }, clip, 15), null);
  assert.equal(audioFxOfClip(project, { start: 0, end: 1 }), null);
});

test("A bad expression falls back to default without throwing; the animation check returns false", () => {
  const def = { ops: [{ kind: "gain", db: "zzz" }] };
  assert.equal(resolveAudioOps(def, undefined, 1, 2)[0].values.db, 0);
  assert.equal(isAudioFxAnimated(def), false);
});

/**
 * kernel/audioFx.mjs 的单测。跑:node --test src/kernel/audioFx.test.mjs
 *
 * 效果定义是 Agent 交来的,校验要把不合规的挡在门外、文案说人话;数值求值是预览和导出共用的,
 * 表达式、参数覆盖、中性判断都在这里钉死;混响脉冲响应必须确定性(两条管线各生成一次要逐样本相同)。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  AUDIO_FX_KINDS, AUDIO_FX_PRESETS, normalizeAudioFxDef, normalizeAudioClipParams, resolveAudioOps, isNeutralOp,
  isAudioFxAnimated, describeAudioFx, reverbImpulse, audioFxOfClip, clipAudioFxAt,
} from "./audioFx.mjs";

test("定义:没填的参数取 default,数字超范围 / 不认识的种类 / 不认识的参数都拒", () => {
  const def = normalizeAudioFxDef({ name: "试", ops: [{ kind: "highpass", freq: 100 }] });
  assert.deepEqual(def.ops, [{ kind: "highpass", freq: 100, q: 0.707 }]);
  assert.throws(() => normalizeAudioFxDef({ name: "x", ops: [{ kind: "gain", db: 40 }] }), /-60~24/);
  assert.throws(() => normalizeAudioFxDef({ name: "x", ops: [{ kind: "wah" }] }), /不认识/);
  assert.throws(() => normalizeAudioFxDef({ name: "x", ops: [{ kind: "gain", freq: 3 }] }), /没有参数 freq/);
  assert.throws(() => normalizeAudioFxDef({ name: "x", ops: [] }), /至少一步/);
  assert.throws(() => normalizeAudioFxDef({ name: "", ops: [{ kind: "gain" }] }), /name 必填/);
});

test("定义:{ kind, params: {...} } 的写法也认,和扁平写法洗出同一个结果", () => {
  const a = normalizeAudioFxDef({ name: "a", ops: [{ kind: "peaking", params: { freq: 3000, db: 3 } }] });
  const b = normalizeAudioFxDef({ name: "a", ops: [{ kind: "peaking", freq: 3000, db: 3 }] });
  assert.deepEqual(a.ops, b.ops);
});

test("表达式:自定义参数进表达式;参数名不能撞种类的参数名;NaN 当场拒", () => {
  const def = normalizeAudioFxDef({
    name: "淡入",
    params: { from: { default: -18, min: -60, max: 0 } },
    ops: [{ kind: "gain", db: "lerp(from, 0, smoothstep(0, 1, t))" }],
  });
  assert.equal(resolveAudioOps(def, undefined, 0, 4)[0].values.db, -18);
  assert.equal(resolveAudioOps(def, undefined, 2, 4)[0].values.db, 0);
  assert.equal(resolveAudioOps(def, { from: -6 }, 0, 4)[0].values.db, -6);
  assert.throws(() => normalizeAudioFxDef({ name: "x", params: { freq: 1 }, ops: [{ kind: "gain" }] }), /参数名「freq」不行/);
  assert.throws(() => normalizeAudioFxDef({ name: "x", ops: [{ kind: "gain", db: "log(0)" }] }), /算出了/);
  assert.throws(() => normalizeAudioFxDef({ name: "x", ops: [{ kind: "gain", db: "nope" }] }), /不认识「nope」/);
});

test("求值:超范围夹住、片段覆盖只认声明过的键、中性判断", () => {
  const def = normalizeAudioFxDef({ name: "x", ops: [{ kind: "gain", db: "-30 * p" }, { kind: "reverb", mix: 0 }] });
  const ops = resolveAudioOps(def, undefined, 10, 10);
  assert.equal(ops[0].values.db, -30);
  assert.equal(isNeutralOp(ops[0]), false);
  assert.equal(isNeutralOp(ops[1]), true, "mix 0 的混响等于没接");
  assert.equal(isNeutralOp(resolveAudioOps(def, undefined, 0, 10)[0]), true, "p=0 时增益 0 dB 是中性");
  assert.throws(() => normalizeAudioClipParams(def, { zzz: 1 }), /没有参数 zzz/);
  const withP = normalizeAudioFxDef({ name: "y", params: { k: { default: 1, min: 0, max: 2 } }, ops: [{ kind: "gain", db: "k" }] });
  assert.deepEqual(normalizeAudioClipParams(withP, { k: 9 }), { k: 2 });
  assert.equal(normalizeAudioClipParams(withP, undefined), undefined);
});

test("动画判断和描述", () => {
  const still = normalizeAudioFxDef({ name: "s", ops: [{ kind: "lowpass", freq: 3400 }, { kind: "gain", db: 3 }] });
  const anim = normalizeAudioFxDef({ name: "a", ops: [{ kind: "lowpass", freq: "lerp(400, 8000, p)" }] });
  assert.equal(isAudioFxAnimated(still), false);
  assert.equal(isAudioFxAnimated(anim), true);
  assert.equal(describeAudioFx(still), "低通(截止频率 3400Hz) · 增益(分贝 3dB)");
  assert.match(describeAudioFx(anim), /lerp/);
  assert.equal(describeAudioFx(normalizeAudioFxDef({ name: "d", ops: [{ kind: "compressor" }] })), "压缩", "全是默认值只报种类");
});

test("混响脉冲响应:确定性、长度 = decay × 采样率、尾巴衰减到 -60 dB、左右不同", () => {
  const [l, r] = reverbImpulse(48000, 0.5);
  const [l2] = reverbImpulse(48000, 0.5);
  assert.equal(l.length, 24000);
  assert.deepEqual(Array.from(l.subarray(0, 64)), Array.from(l2.subarray(0, 64)), "同参数两次生成逐样本相同");
  assert.notDeepEqual(Array.from(l.subarray(0, 64)), Array.from(r.subarray(0, 64)), "左右声道不同种子");
  // 头 1% 和尾 1% 的 RMS 之比约 1000(60 dB);噪声有随机性,放宽到 300~3000
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const ratio = rms(l.subarray(0, 240)) / rms(l.subarray(l.length - 240));
  assert.ok(ratio > 300 && ratio < 3000, `头尾能量比 ${ratio}`);
  let e = 0;
  for (const v of l) e += v * v;
  assert.ok(Math.abs(e - 1) < 1e-3, `总能量归一到 1,实际 ${e}`);
});

test("预设全部合规,而且名字不重", () => {
  const names = new Set();
  for (const p of AUDIO_FX_PRESETS) {
    const def = normalizeAudioFxDef(p);
    assert.ok(def.ops.length > 0);
    assert.ok(!names.has(def.name), `预设名重复:${def.name}`);
    names.add(def.name);
  }
});

test("每种效果的参数都有 label / default 在 min~max 内", () => {
  for (const [kind, spec] of Object.entries(AUDIO_FX_KINDS)) {
    for (const [k, ps] of Object.entries(spec.params)) {
      assert.ok(ps.label, `${kind}.${k} 缺 label`);
      assert.ok(ps.default >= ps.min && ps.default <= ps.max, `${kind}.${k} 的 default 出界`);
    }
  }
});

test("项目里的查找:按 clip.audioFx 找定义、按时间轴时刻求值,删了定义就当没挂", () => {
  const def = { id: "afx1", ...normalizeAudioFxDef({ name: "g", ops: [{ kind: "gain", db: "-12 * p" }] }) };
  const project = { audioFx: [def] };
  const clip = { start: 10, end: 20, audioFx: { id: "afx1" } };
  assert.equal(audioFxOfClip(project, clip), def);
  assert.equal(clipAudioFxAt(project, clip, 15)[0].values.db, -6);
  assert.equal(clipAudioFxAt({ audioFx: [] }, clip, 15), null);
  assert.equal(audioFxOfClip(project, { start: 0, end: 1 }), null);
});

test("坏表达式按 default 算、不抛;动画判断按 false", () => {
  const def = { ops: [{ kind: "gain", db: "zzz" }] };
  assert.equal(resolveAudioOps(def, undefined, 1, 2)[0].values.db, 0);
  assert.equal(isAudioFxAnimated(def), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { normalizePixelMapDef, mapRgba, parseColor, classifyPixelMap, pixelMapOpsDiff, compilePixelMapGlsl } from "./pixelMap.mjs";
import { normalizeFilterDef, applyTableOps, FUNC_ARITY } from "./filters.mjs";

const pm = (raw) => ({ id: "pm-test", ...normalizePixelMapDef(raw) });

test("pixel map safely evaluates selection and channel expressions", () => {
  const d = normalizePixelMapDef({ name: "Shadows", where: "1-smoothstep(0,.25,luma)", to: { kind: "expr", r: "r^1.6", g: "g^1.6", b: "b^1.6", a: "a" } });
  const out = mapRgba(d, [.1, .1, .1, 1]);
  assert.ok(out[0] < .1 && out[3] === 1);
  assert.deepEqual(parseColor("#f30"), [1, 0.2, 0, 1]);
});

test("pixel map supports shorthand colors, transparent and continuous sequence alignment", () => {
  const red = normalizePixelMapDef({ name: "Red", where: "1", to: "#ff0000" });
  assert.deepEqual(mapRgba(red, [0, 0, 0, 1]), [1, 0, 0, 1]);
  const clear = normalizePixelMapDef({ name: "Cutout", where: "1", to: "transparent" });
  assert.equal(mapRgba(clear, [1, 0, 0, 1])[3], 0);
  const seq = normalizePixelMapDef({ name: "track", where: "1", to: "#fff", colorSequence: { from: ["#000", "#fff"], to: ["#001133", "#ffcc88", "#ffffff"], mode: "continuous" } });
  const out = mapRgba(seq, [1, 1, 1, 1]);
  assert.deepEqual(out.slice(0, 3), [1, 1, 1]);
});

test("unsafe expressions and malformed stages are rejected", () => {
  assert.throws(() => normalizePixelMapDef({ name: "x", where: "window.alert(1)", to: "#fff" }), /has an invalid expression/);
  assert.throws(() => normalizePixelMapDef({ name: "x", where: "1", to: { kind: "color", value: "#fff" }, source: { stage: "shader" } }), /stage/);
});

/* ------------------------------------------------------------ Category: A whole-frame color grading */

test("classify A: channel curve / linear color mix / solid color, the equivalent ops pass normalizeFilterDef", () => {
  const cases = [
    ["Channel curve", { name: "Brighten", where: "1", to: { kind: "expr", r: "r^1.6", g: "g^1.6", b: "b^1.6", a: "a" } }, "curves"],
    ["Channel curve-single channel", { name: "Reduce blue", where: "1", to: { kind: "expr", r: "r", g: "g", b: "b*0.8", a: "a" } }, "curves"],
    ["Linear color mix", { name: "Teal orange", where: "1", to: { kind: "expr", r: "1.1*r+0.05*g", g: "g+0.05*b", b: "0.02*r+0.9*b", a: "a" } }, "matrix"],
    ["Desaturate by luma", { name: "Faded", where: "1", to: { kind: "expr", r: "luma", g: "luma", b: "luma", a: "a" } }, "matrix"],
    ["Channel swap", { name: "Recolor", where: "1", to: { kind: "expr", r: "g", g: "r", b: "b", a: "a" } }, "matrix"],
    ["A constant where is folded into the coefficients", { name: "Half faded", where: "0.5", to: { kind: "expr", r: "luma", g: "luma", b: "luma", a: "a" } }, "matrix"],
    ["Solid color for the whole frame", { name: "Red", where: "1", to: "#ff0000" }, "matrix"],
  ];
  for (const [label, raw, kind] of cases) {
    const c = classifyPixelMap(pm(raw));
    assert.equal(c.kind, "A", `${label} should classify as A, got ${c.kind}: ${c.reason}`);
    assert.ok(c.diff <= 1, `${label}: equivalent ops differ by ${c.diff} levels`);
    if (kind) assert.ok(c.ops.some((op) => op.kind === kind), `${label} should produce ${kind}, got ${c.ops.map((o) => o.kind).join("+")}`);
    // ops in the response must be able to be fed directly to create_filter
    assert.doesNotThrow(() => normalizeFilterDef({ name: raw.name, ops: c.ops }), `ops of ${label} fail normalizeFilterDef`);
  }
});

test("classify A: equivalent ops and mapRgba differ by ≤ 1 level over the full 0~255 range", () => {
  const def = pm({ name: "Brighten", where: "1", to: { kind: "expr", r: "r^1.6", g: "g^0.8", b: "b*0.9+0.05", a: "a" } });
  const c = classifyPixelMap(def);
  assert.equal(c.kind, "A");
  // Each channel depends only on itself, so 256 grayscale levels cover the entire range
  let worst = 0;
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    const ref = mapRgba(def, [v, v, v, 1]);
    const got = applyTableOps(c.ops, [v, v, v]);
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(Math.round(ref[k] * 255) - Math.round(got[k] * 255)));
  }
  assert.ok(worst <= 1, `max per-value difference is ${worst} levels`);

  const mix = pm({ name: "Mix", where: "1", to: { kind: "expr", r: "0.6*r+0.3*g+0.1*b", g: "0.2*r+0.7*g+0.1*b", b: "0.1*r+0.2*g+0.7*b", a: "a" } });
  const cm = classifyPixelMap(mix);
  assert.equal(cm.kind, "A");
  assert.equal(pixelMapOpsDiff(mix, cm.ops), 0);
});

/* ------------------------------------------------------------ Category: B per-pixel */

test("classify B: color keying, by position, by time, transparent, asset, step, alpha change", () => {
  const cases = [
    // The chroma key expression cited in the tool description
    ["Key green to transparent", { name: "Key out green", where: "smoothstep(0.35,0.8,g-r)*(1-smoothstep(0.15,0.45,b))", to: "transparent" }],
    ["Key green to solid color", { name: "Key out green, fill blue", where: "smoothstep(0.35,0.8,g-r)*(1-smoothstep(0.15,0.45,b))", to: "#0033ff" }],
    ["Gradient selection by x", { name: "Horizontal", where: "x", to: "#000000" }],
    ["Gradient selection by y", { name: "Vertical", where: "smoothstep(0.2,0.8,y)", to: "#000000" }],
    ["Flicker by t", { name: "Flash", where: "0.5+0.5*sin(t*6)", to: "#ffffff" }],
    ["Whole frame transparent", { name: "Hide", where: "1", to: "transparent" }],
    ["Target is another media item", { name: "Swap background", where: "1-step(0.5,luma)", to: { kind: "media", mediaId: "m2", stage: "origin" } }],
    ["Step function (33 points cannot represent it)", { name: "Levels", where: "1", to: { kind: "expr", r: "step(0.5,r)", g: "step(0.5,g)", b: "step(0.5,b)", a: "a" } }],
    ["Change alpha", { name: "Semi-transparent", where: "1", to: { kind: "expr", r: "r", g: "g", b: "b", a: "a*0.5" } }],
    ["continuous color sequence", { name: "track", where: "1", to: "#fff", colorSequence: { from: ["#000", "#808080", "#fff"], to: ["#001133", "#ffcc88", "#ffffff"], mode: "continuous" } }],
    ["discrete color sequence", { name: "Discrete", where: "1", to: "#fff", mode: "discrete", colorSequence: { from: ["#000", "#fff"], to: ["#ff0000", "#00ff00"], mode: "discrete" } }],
  ];
  for (const [label, raw] of cases) {
    const c = classifyPixelMap(pm(raw));
    assert.equal(c.kind, "B", `${label} should classify as B, got ${c.kind}`);
    assert.equal(c.backend, "webgl");
    assert.ok(c.reason.length > 0);
  }
  assert.equal(classifyPixelMap(pm({ name: "Swap background", where: "1-step(0.5,luma)", to: { kind: "media", mediaId: "m2", stage: "origin" } })).usesTarget, true);
});

/* ------------------------------------------------------------ Category: C untranslatable */

test("classify C: powers whose base may be negative and whose exponent is not an integer constant", () => {
  const c = classifyPixelMap(pm({ name: "Bad", where: "(r-g)^0.5", to: "#ffffff" }));
  assert.equal(c.kind, "C");
  assert.match(c.reason, /pow is undefined for a negative base/);
  const c2 = classifyPixelMap(pm({ name: "Bad2", where: "1", to: { kind: "expr", r: "pow(r-g, luma)", g: "g", b: "b", a: "a" } }));
  assert.equal(c2.kind, "C");
  // Wrapping the base in abs or writing the exponent as an integer constant makes it translatable
  assert.equal(classifyPixelMap(pm({ name: "OK", where: "abs(r-g)^0.5", to: "#ffffff" })).kind, "B");
  assert.equal(classifyPixelMap(pm({ name: "Good2", where: "(r-g)^2", to: "#ffffff" })).kind, "B");
});

/* ------------------------------------------------------------ GLSL */

test("compilePixelMapGlsl: key fragments that follow the same conventions as mapRgba", () => {
  const { fragment, vertex, usesTarget, usesTime } = compilePixelMapGlsl(
    pm({ name: "Key out green", where: "smoothstep(0.35,0.8,g-r)*(1-smoothstep(0.15,0.45,b))", to: "transparent" }));
  assert.match(fragment, /^#version 300 es\n/);
  assert.match(fragment, /uniform sampler2D uTex;/);
  assert.match(fragment, /float luma = r \* 0\.2126 \+ g \* 0\.7152 \+ b \* 0\.0722;/);
  // Input is first clamped to 0~1 (pc01v); where is also clamped to 0~1, returning as-is when 0
  assert.match(fragment, /vec4 src = pc01v\(texture\(uTex, uv\)\);/);
  assert.match(fragment, /float w = pc01\(\(smoothstep\(0\.35, 0\.8, \(g - r\)\) \* \(1\.0 - smoothstep\(0\.15, 0\.45, b\)\)\)\);/);
  assert.match(fragment, /if \(!\(w > 0\.0\)\) \{ fragColor = src; return; \}/);
  // continuous blends by w
  assert.match(fragment, /fragColor = src \* \(1\.0 - w\) \+ target \* w;/);
  assert.match(fragment, /target = vec4\(src\.rgb, 0\.0\);/);
  // y counts from top to bottom, consistent with ImageData row order
  assert.match(fragment, /float row = uSize\.y - gl_FragCoord\.y - 0\.5;/);
  assert.match(fragment, /float y = row \/ uSize\.y;/);
  assert.match(vertex, /gl_VertexID/);
  assert.equal(usesTarget, false);
  assert.equal(usesTime, false);
});

test("compilePixelMapGlsl: functions map one to one, lerp→mix, ^→pow, round→floor(x+0.5), t→uT", () => {
  const f = (where) => compilePixelMapGlsl(pm({ name: "x", where, to: "#ffffff" })).fragment;
  assert.match(f("lerp(0.2, 0.9, luma)"), /mix\(0\.2, 0\.9, luma\)/);
  assert.match(f("r^2"), /pow\(r, 2\.0\)/);
  assert.match(f("pow(luma, 0.45)"), /pow\(luma, 0\.45\)/);
  assert.match(f("round(luma*4)/4"), /floor\(\(\(luma \* 4\.0\)\) \+ 0\.5\)/);
  assert.match(f("0.5+0.5*sin(t*6)"), /sin\(\(uT \* 6\.0\)\)/);
  assert.match(f("mod(x*8, 1)"), /mod\(\(x \* 8\.0\), 1\.0\)/);
  assert.match(f("min(r, g, b)"), /min\(min\(r, g\), b\)/);
  assert.match(f("clamp(luma*2, 0, 1)"), /clamp\(\(luma \* 2\.0\), 0\.0, 1\.0\)/);
  assert.match(f("step(0.5, luma)"), /step\(0\.5, luma\)/);
  // Negative base + integer constant exponent: JS Math.pow is defined, GLSL must handle sign itself
  assert.match(f("(r-g)^3"), /\(sign\(\(r - g\)\) \* pow\(abs\(\(r - g\)\), 3\.0\)\)/);
  // Not a single parser whitelisted function can be omitted
  for (const name of Object.keys(FUNC_ARITY)) {
    const args = { min: "r, g", max: "r, g", pow: "r, 2", mod: "r, 0.5", clamp: "r, 0, 1", lerp: "0, 1, r", step: "0.5, r", smoothstep: "0, 1, r" }[name] ?? "r";
    assert.doesNotThrow(() => f(`${name}(${args})`), `${name}() cannot be translated`);
  }
});

test("compilePixelMapGlsl: color sequences are translated following the semantics of sequenceTarget", () => {
  const disc = compilePixelMapGlsl(pm({ name: "Discrete", where: "1", to: "#fff", mode: "discrete", colorSequence: { from: ["#000", "#fff"], to: ["#ff0000", "#00ff00"], mode: "discrete" } })).fragment;
  assert.match(disc, /const vec4 PC_FROM\[2\] = vec4\[2\]\(/);
  assert.match(disc, /float dd = dot\(dv, dv\);/);
  // In a tie, pick the earlier one (sequenceTarget uses strict less-than): float32 rounds
  // unpredictably on exact ties, so the comparison subtracts an amount larger than float32
  // noise but much smaller than adjacent non-tie distances
  assert.match(disc, /const float PC_SEQ_EPS = 1e-6;/);
  assert.match(disc, /if \(dd < best - PC_SEQ_EPS\)/);
  assert.match(disc, /target = PC_TO\[min\(idx, 1\)\];/);
  const cont = compilePixelMapGlsl(pm({ name: "Continuous", where: "1", to: "#fff", colorSequence: { from: ["#000", "#808080", "#fff"], to: ["#001133", "#ffcc88", "#ffffff"], mode: "continuous" } })).fragment;
  assert.match(cont, /float seqP = float\(idx\) \/ 2\.0;/);
  assert.match(cont, /target = PC_TO\[i0\] \+ \(PC_TO\[i0 \+ 1\] - PC_TO\[i0\]\) \* seqF;/);
  // Same definition shares the same key; different definitions have different keys
  const a = compilePixelMapGlsl(pm({ name: "a", where: "x", to: "#000000" }));
  const b = compilePixelMapGlsl(pm({ name: "b", where: "x", to: "#000000" }));
  const c = compilePixelMapGlsl(pm({ name: "c", where: "y", to: "#000000" }));
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, c.key);
});

test("compilePixelMapGlsl: uses the second texture when the target is another asset", () => {
  const { fragment, usesTarget } = compilePixelMapGlsl(pm({ name: "Swap background", where: "1-step(0.5,luma)", to: { kind: "media", mediaId: "m2", stage: "origin" } }));
  assert.equal(usesTarget, true);
  assert.match(fragment, /target = uHasTarget \? pc01v\(texture\(uTarget, uv\)\) : src;/);
});

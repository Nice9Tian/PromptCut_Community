import test from "node:test";
import assert from "node:assert/strict";
import { normalizePixelMapDef, mapRgba, parseColor, classifyPixelMap, pixelMapOpsDiff, compilePixelMapGlsl } from "./pixelMap.mjs";
import { normalizeFilterDef, applyTableOps, FUNC_ARITY } from "./filters.mjs";

const pm = (raw) => ({ id: "pm-test", ...normalizePixelMapDef(raw) });

test("pixel map safely evaluates selection and channel expressions", () => {
  const d = normalizePixelMapDef({ name: "暗部", where: "1-smoothstep(0,.25,luma)", to: { kind: "expr", r: "r^1.6", g: "g^1.6", b: "b^1.6", a: "a" } });
  const out = mapRgba(d, [.1, .1, .1, 1]);
  assert.ok(out[0] < .1 && out[3] === 1);
  assert.deepEqual(parseColor("#f30"), [1, 0.2, 0, 1]);
});

test("pixel map supports shorthand colors, transparent and continuous sequence alignment", () => {
  const red = normalizePixelMapDef({ name: "红", where: "1", to: "#ff0000" });
  assert.deepEqual(mapRgba(red, [0, 0, 0, 1]), [1, 0, 0, 1]);
  const clear = normalizePixelMapDef({ name: "抠", where: "1", to: "transparent" });
  assert.equal(mapRgba(clear, [1, 0, 0, 1])[3], 0);
  const seq = normalizePixelMapDef({ name: "序列", where: "1", to: "#fff", colorSequence: { from: ["#000", "#fff"], to: ["#001133", "#ffcc88", "#ffffff"], mode: "continuous" } });
  const out = mapRgba(seq, [1, 1, 1, 1]);
  assert.deepEqual(out.slice(0, 3), [1, 1, 1]);
});

test("unsafe expressions and malformed stages are rejected", () => {
  assert.throws(() => normalizePixelMapDef({ name: "x", where: "window.alert(1)", to: "#fff" }), /表达式有问题/);
  assert.throws(() => normalizePixelMapDef({ name: "x", where: "1", to: { kind: "color", value: "#fff" }, source: { stage: "shader" } }), /stage/);
});

/* ------------------------------------------------------------ 分类:A 整帧调色 */

test("classify A:通道曲线 / 线性混色 / 纯色,等价 ops 能过 normalizeFilterDef", () => {
  const cases = [
    ["通道曲线", { name: "提亮", where: "1", to: { kind: "expr", r: "r^1.6", g: "g^1.6", b: "b^1.6", a: "a" } }, "curves"],
    ["通道曲线-单通道", { name: "压蓝", where: "1", to: { kind: "expr", r: "r", g: "g", b: "b*0.8", a: "a" } }, "curves"],
    ["线性混色", { name: "青橙", where: "1", to: { kind: "expr", r: "1.1*r+0.05*g", g: "g+0.05*b", b: "0.02*r+0.9*b", a: "a" } }, "matrix"],
    ["按亮度去色", { name: "褪色", where: "1", to: { kind: "expr", r: "luma", g: "luma", b: "luma", a: "a" } }, "matrix"],
    ["通道对调", { name: "换色", where: "1", to: { kind: "expr", r: "g", g: "r", b: "b", a: "a" } }, "matrix"],
    ["常数 where 折进系数", { name: "半褪", where: "0.5", to: { kind: "expr", r: "luma", g: "luma", b: "luma", a: "a" } }, "matrix"],
    ["整帧纯色", { name: "红", where: "1", to: "#ff0000" }, "matrix"],
  ];
  for (const [label, raw, kind] of cases) {
    const c = classifyPixelMap(pm(raw));
    assert.equal(c.kind, "A", `${label} 应该判 A,实际 ${c.kind}:${c.reason}`);
    assert.ok(c.diff <= 1, `${label} 的等价 ops 差了 ${c.diff} 级`);
    if (kind) assert.ok(c.ops.some((op) => op.kind === kind), `${label} 应该出 ${kind},实际 ${c.ops.map((o) => o.kind).join("+")}`);
    // 回包里的 ops 必须能直接喂给 create_filter
    assert.doesNotThrow(() => normalizeFilterDef({ name: raw.name, ops: c.ops }), `${label} 的 ops 过不了 normalizeFilterDef`);
  }
});

test("classify A:等价 ops 和 mapRgba 在 0~255 全值域上差 ≤ 1 级", () => {
  const def = pm({ name: "提亮", where: "1", to: { kind: "expr", r: "r^1.6", g: "g^0.8", b: "b*0.9+0.05", a: "a" } });
  const c = classifyPixelMap(def);
  assert.equal(c.kind, "A");
  // 每通道只依赖自己,所以 256 级灰阶就是全值域
  let worst = 0;
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    const ref = mapRgba(def, [v, v, v, 1]);
    const got = applyTableOps(c.ops, [v, v, v]);
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(Math.round(ref[k] * 255) - Math.round(got[k] * 255)));
  }
  assert.ok(worst <= 1, `逐值最大差 ${worst} 级`);

  const mix = pm({ name: "混", where: "1", to: { kind: "expr", r: "0.6*r+0.3*g+0.1*b", g: "0.2*r+0.7*g+0.1*b", b: "0.1*r+0.2*g+0.7*b", a: "a" } });
  const cm = classifyPixelMap(mix);
  assert.equal(cm.kind, "A");
  assert.equal(pixelMapOpsDiff(mix, cm.ops), 0);
});

/* ------------------------------------------------------------ 分类:B 逐像素 */

test("classify B:抠色、按位置、按时间、透明、素材、阶跃、改 alpha", () => {
  const cases = [
    // 工具描述里举的那条抠色表达式
    ["抠绿到透明", { name: "抠绿", where: "smoothstep(0.35,0.8,g-r)*(1-smoothstep(0.15,0.45,b))", to: "transparent" }],
    ["抠绿到纯色", { name: "抠绿填蓝", where: "smoothstep(0.35,0.8,g-r)*(1-smoothstep(0.15,0.45,b))", to: "#0033ff" }],
    ["按 x 的渐变选区", { name: "横向", where: "x", to: "#000000" }],
    ["按 y 的渐变选区", { name: "纵向", where: "smoothstep(0.2,0.8,y)", to: "#000000" }],
    ["按 t 闪烁", { name: "闪", where: "0.5+0.5*sin(t*6)", to: "#ffffff" }],
    ["整帧透明", { name: "隐", where: "1", to: "transparent" }],
    ["目标是另一段素材", { name: "换底", where: "1-step(0.5,luma)", to: { kind: "media", mediaId: "m2", stage: "origin" } }],
    ["阶跃函数(33 点表示不了)", { name: "色阶", where: "1", to: { kind: "expr", r: "step(0.5,r)", g: "step(0.5,g)", b: "step(0.5,b)", a: "a" } }],
    ["改 alpha", { name: "半透", where: "1", to: { kind: "expr", r: "r", g: "g", b: "b", a: "a*0.5" } }],
    ["continuous 颜色序列", { name: "序列", where: "1", to: "#fff", colorSequence: { from: ["#000", "#808080", "#fff"], to: ["#001133", "#ffcc88", "#ffffff"], mode: "continuous" } }],
    ["discrete 颜色序列", { name: "离散", where: "1", to: "#fff", mode: "discrete", colorSequence: { from: ["#000", "#fff"], to: ["#ff0000", "#00ff00"], mode: "discrete" } }],
  ];
  for (const [label, raw] of cases) {
    const c = classifyPixelMap(pm(raw));
    assert.equal(c.kind, "B", `${label} 应该判 B,实际 ${c.kind}`);
    assert.equal(c.backend, "webgl");
    assert.ok(c.reason.length > 0);
  }
  assert.equal(classifyPixelMap(pm({ name: "换底", where: "1-step(0.5,luma)", to: { kind: "media", mediaId: "m2", stage: "origin" } })).usesTarget, true);
});

/* ------------------------------------------------------------ 分类:C 翻译不了 */

test("classify C:底数可能为负、指数又不是整数常量的幂", () => {
  const c = classifyPixelMap(pm({ name: "坏", where: "(r-g)^0.5", to: "#ffffff" }));
  assert.equal(c.kind, "C");
  assert.match(c.reason, /pow 在底数为负时无定义/);
  const c2 = classifyPixelMap(pm({ name: "坏2", where: "1", to: { kind: "expr", r: "pow(r-g, luma)", g: "g", b: "b", a: "a" } }));
  assert.equal(c2.kind, "C");
  // 底数包进 abs 或指数写成整数常量就能翻译
  assert.equal(classifyPixelMap(pm({ name: "好", where: "abs(r-g)^0.5", to: "#ffffff" })).kind, "B");
  assert.equal(classifyPixelMap(pm({ name: "好2", where: "(r-g)^2", to: "#ffffff" })).kind, "B");
});

/* ------------------------------------------------------------ GLSL */

test("compilePixelMapGlsl:口径和 mapRgba 一致的关键片段", () => {
  const { fragment, vertex, usesTarget, usesTime } = compilePixelMapGlsl(
    pm({ name: "抠绿", where: "smoothstep(0.35,0.8,g-r)*(1-smoothstep(0.15,0.45,b))", to: "transparent" }));
  assert.match(fragment, /^#version 300 es\n/);
  assert.match(fragment, /uniform sampler2D uTex;/);
  assert.match(fragment, /float luma = r \* 0\.2126 \+ g \* 0\.7152 \+ b \* 0\.0722;/);
  // 输入先夹到 0~1(pc01v),where 也夹到 0~1,为 0 时原样返回
  assert.match(fragment, /vec4 src = pc01v\(texture\(uTex, uv\)\);/);
  assert.match(fragment, /float w = pc01\(\(smoothstep\(0\.35, 0\.8, \(g - r\)\) \* \(1\.0 - smoothstep\(0\.15, 0\.45, b\)\)\)\);/);
  assert.match(fragment, /if \(!\(w > 0\.0\)\) \{ fragColor = src; return; \}/);
  // continuous 是按 w 混合
  assert.match(fragment, /fragColor = src \* \(1\.0 - w\) \+ target \* w;/);
  assert.match(fragment, /target = vec4\(src\.rgb, 0\.0\);/);
  // y 从上往下数,和 ImageData 的行序一致
  assert.match(fragment, /float row = uSize\.y - gl_FragCoord\.y - 0\.5;/);
  assert.match(fragment, /float y = row \/ uSize\.y;/);
  assert.match(vertex, /gl_VertexID/);
  assert.equal(usesTarget, false);
  assert.equal(usesTime, false);
});

test("compilePixelMapGlsl:函数逐个对应 —— lerp→mix、^→pow、round→floor(x+0.5)、t→uT", () => {
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
  // 负底数 + 整数常量指数:JS 的 Math.pow 有定义,GLSL 要自己补符号
  assert.match(f("(r-g)^3"), /\(sign\(\(r - g\)\) \* pow\(abs\(\(r - g\)\), 3\.0\)\)/);
  // 解析器的白名单函数一个都不能漏
  for (const name of Object.keys(FUNC_ARITY)) {
    const args = { min: "r, g", max: "r, g", pow: "r, 2", mod: "r, 0.5", clamp: "r, 0, 1", lerp: "0, 1, r", step: "0.5, r", smoothstep: "0, 1, r" }[name] ?? "r";
    assert.doesNotThrow(() => f(`${name}(${args})`), `${name}() 翻译不了`);
  }
});

test("compilePixelMapGlsl:颜色序列照 sequenceTarget 的语义翻译", () => {
  const disc = compilePixelMapGlsl(pm({ name: "离散", where: "1", to: "#fff", mode: "discrete", colorSequence: { from: ["#000", "#fff"], to: ["#ff0000", "#00ff00"], mode: "discrete" } })).fragment;
  assert.match(disc, /const vec4 PC_FROM\[2\] = vec4\[2\]\(/);
  assert.match(disc, /float dd = dot\(dv, dv\);/);
  // 并列时取靠前那个(sequenceTarget 用的是严格小于):float32 在精确并列上会往两边乱舍,
  // 所以比较要减掉一个比 float32 噪声大、比相邻非并列距离差小得多的量
  assert.match(disc, /const float PC_SEQ_EPS = 1e-6;/);
  assert.match(disc, /if \(dd < best - PC_SEQ_EPS\)/);
  assert.match(disc, /target = PC_TO\[min\(idx, 1\)\];/);
  const cont = compilePixelMapGlsl(pm({ name: "连续", where: "1", to: "#fff", colorSequence: { from: ["#000", "#808080", "#fff"], to: ["#001133", "#ffcc88", "#ffffff"], mode: "continuous" } })).fragment;
  assert.match(cont, /float seqP = float\(idx\) \/ 2\.0;/);
  assert.match(cont, /target = PC_TO\[i0\] \+ \(PC_TO\[i0 \+ 1\] - PC_TO\[i0\]\) \* seqF;/);
  // 同一条定义同一个 key,不同定义不同 key
  const a = compilePixelMapGlsl(pm({ name: "a", where: "x", to: "#000000" }));
  const b = compilePixelMapGlsl(pm({ name: "b", where: "x", to: "#000000" }));
  const c = compilePixelMapGlsl(pm({ name: "c", where: "y", to: "#000000" }));
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, c.key);
});

test("compilePixelMapGlsl:目标是另一段素材时取第二张纹理", () => {
  const { fragment, usesTarget } = compilePixelMapGlsl(pm({ name: "换底", where: "1-step(0.5,luma)", to: { kind: "media", mediaId: "m2", stage: "origin" } }));
  assert.equal(usesTarget, true);
  assert.match(fragment, /target = uHasTarget \? pc01v\(texture\(uTarget, uv\)\) : src;/);
});

// 滤镜内核:表达式、定义校验、求值、CSS / ffmpeg 翻译。
// 跑法:node --test src/kernel/filters.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  compileExpr, normalizeFilterDef, normalizeClipParams, resolveOps, isAnimated, cssFilter,
  colorMatrix, ffmpegStages, ffmpegChain, ffmpegStaticChain, sendcmdScript, clipFilterOpsAt, FilterExprError,
} from "./filters.mjs";

const ev = (src, env = {}, vars) => compileExpr(src, vars).fn({ t: 0, d: 1, p: 0, ...env });

test("表达式:优先级、结合性、函数、常量", () => {
  assert.equal(ev("1 + 2*3"), 7);
  assert.equal(ev("-2^2"), -4); // 一元负号比 ^ 松,和数学习惯一致
  assert.equal(ev("2^3^2"), 512); // ^ 右结合
  assert.equal(ev("(1+2)*3"), 9);
  assert.equal(ev("7 % 3"), 1);
  assert.equal(ev("mod(-1, 3)"), 2);
  assert.equal(ev("clamp(5, 0, 1)"), 1);
  assert.equal(ev("lerp(0, 10, 0.25)"), 2.5);
  assert.equal(ev("smoothstep(0, 1, 0.5)"), 0.5);
  assert.equal(ev("max(1, 3, 2)"), 3);
  assert.ok(Math.abs(ev("sin(PI/2)") - 1) < 1e-12);
  assert.equal(ev("t*2 + p", { t: 1.5, p: 0.5 }), 3.5);
  assert.equal(ev("1e-1 + .5"), 0.6);
});

test("表达式:只认白名单,碰不到 JS 运行时", () => {
  for (const bad of ["__proto__", "constructor", "toString()", "hasOwnProperty(1)", "process.exit()", "x", "alert(1)", "t[0]", "'a'", "t;1", "Math.PI", "eval(1)"]) {
    assert.throws(() => compileExpr(bad), FilterExprError, bad);
  }
  assert.throws(() => compileExpr("sin(1, 2)"), /1 个参数/);
  assert.throws(() => compileExpr("1 +"), /不完整/);
  assert.throws(() => compileExpr("(1"), /缺少「\)」/);
  assert.throws(() => compileExpr("1".repeat(301)), /太长/);
  assert.throws(() => compileExpr("amount"), /params 里声明/);
  assert.equal(compileExpr("amount*2", ["t", "d", "p", "amount"]).fn({ amount: 3 }), 6);
  assert.deepEqual([...compileExpr("sin(t) + d").uses].sort(), ["d", "t"]);
});

test("定义校验:种类、范围、参数、试算", () => {
  const def = normalizeFilterDef({
    name: " 呼吸 ", description: "亮度一呼一吸",
    params: { amount: { default: 0.2, min: 0, max: 1, label: "幅度" } },
    ops: [{ kind: "brightness", value: "1 + amount*sin(t*2*PI)" }, { kind: "saturate", value: 1.2 }],
  });
  assert.equal(def.name, "呼吸");
  assert.equal(def.params.amount.label, "幅度");
  assert.equal(isAnimated(def), true);
  assert.equal(isAnimated({ ops: [{ kind: "blur", value: "d/2" }] }), false, "只用 d 的不随时间变");

  assert.throws(() => normalizeFilterDef({ name: "x", ops: [] }), /至少一步/);
  assert.throws(() => normalizeFilterDef({ name: "x", ops: [{ kind: "vignette", value: 1 }] }), /不认识/);
  assert.throws(() => normalizeFilterDef({ name: "x", ops: [{ kind: "constructor", value: 1 }] }), /不认识/);
  assert.throws(() => normalizeFilterDef({ name: "x", ops: [{ kind: "saturate", value: 3 }] }), /0~2/);
  assert.throws(() => normalizeFilterDef({ name: "x", ops: [{ kind: "blur", value: "log(t)" }] }), /-Infinity/);
  assert.throws(() => normalizeFilterDef({ name: "x", params: { t: 1 }, ops: [{ kind: "blur", value: 1 }] }), /重名/);
  assert.throws(() => normalizeFilterDef({ name: "x", params: { k: { default: 5, max: 1 } }, ops: [{ kind: "blur", value: 1 }] }), /超出/);
  assert.throws(() => normalizeFilterDef({ ops: [{ kind: "blur", value: 1 }] }), /name/);

  assert.deepEqual(normalizeClipParams(def, { amount: 5 }), { amount: 1 });
  assert.throws(() => normalizeClipParams(def, { nope: 1 }), /没有参数 nope/);
  assert.throws(() => normalizeClipParams(def, { toString: 1 }), /没有参数/);
});

test("求值:片段内时间、夹住范围、NaN 退回中性", () => {
  // 定义校验会拒掉试算出 NaN 的表达式;这里绕过校验,钉住 resolveOps 自己的兜底(老数据、手改的工程)
  const def = {
    name: "渐糊", params: { k: { default: 2 } },
    ops: [{ kind: "blur", value: "k*t" }, { kind: "brightness", value: "1 + p" }, { kind: "hue", value: "sqrt(t - 5)" }],
  };
  const at0 = resolveOps(def, undefined, 0, 10);
  assert.deepEqual(at0.map((o) => o.value), [0, 1, 0]); // sqrt(-5) = NaN → 色相中性 0
  const at30 = resolveOps(def, { k: 10 }, 30, 10); // t 夹到片段时长以内
  assert.deepEqual(at30.map((o) => o.value), [40, 2, 2.236068]); // blur 100 → 夹到上限 40

  const project = { filters: [{ id: "f1", ...def }] };
  const clip = { start: 4, end: 14, filter: { id: "f1" } };
  assert.equal(clipFilterOpsAt(project, clip, 5)[0].value, 2); // 时间轴 5s = 片段内 1s
  assert.equal(clipFilterOpsAt(project, { ...clip, filter: { id: "gone" } }, 5), null);
});

test("CSS:中性步骤跳过,blur 跟着缩放", () => {
  const ops = [
    { kind: "brightness", value: 1.2 }, { kind: "contrast", value: 1 }, { kind: "hue", value: 30 },
    { kind: "blur", value: 4 }, { kind: "grayscale", value: 0.5 },
  ];
  assert.equal(cssFilter(ops), "brightness(1.2) hue-rotate(30deg) blur(4px) grayscale(0.5)");
  assert.equal(cssFilter(ops, 0.5), "brightness(1.2) hue-rotate(30deg) blur(2px) grayscale(0.5)");
  assert.equal(cssFilter([{ kind: "saturate", value: 1 }]), "");
});

/** 按 CSS 规范对一个像素做一遍(每步截断),用来核对 ffmpeg 那边的翻译 */
function cssPixel(ops, rgb) {
  let [r, g, b] = rgb;
  const c = (x) => Math.min(1, Math.max(0, x));
  for (const { kind, value: v } of ops) {
    if (kind === "brightness") [r, g, b] = [r, g, b].map((x) => c(x * v));
    else if (kind === "contrast") [r, g, b] = [r, g, b].map((x) => c(x * v + 0.5 - 0.5 * v));
    else if (kind === "invert") [r, g, b] = [r, g, b].map((x) => c(v + (1 - 2 * v) * x));
    else if (kind !== "blur") {
      const m = colorMatrix(kind, v);
      [r, g, b] = [c(m[0] * r + m[1] * g + m[2] * b), c(m[3] * r + m[4] * g + m[5] * b), c(m[6] * r + m[7] * g + m[8] * b)];
    }
  }
  return [r, g, b];
}

/** 按 ffmpeg 滤镜的公式对一个像素做一遍;lutrgb 的表达式先核对一遍它和 linear 说的是同一条线 */
function ffPixel(stages, rgb) {
  let px = [...rgb];
  const c = (x) => Math.min(1, Math.max(0, x));
  for (const s of stages) {
    if (s.filter === "lutrgb") {
      const m = /^val\*(-?[\d.]+)([+-][\d.]+)$/.exec(s.opts.r);
      assert.ok(m, `lutrgb 表达式形状不对:${s.opts.r}`);
      assert.ok(Math.abs(Number(m[1]) - s.linear.slope) < 1e-9 && Math.abs(Number(m[2]) - (s.linear.icpt * 255 + 0.5)) < 1e-4);
      assert.ok(!s.opts.r.includes(","), "表达式里有逗号 sendcmd 会拆坏");
      px = px.map((x) => c(s.linear.slope * x + s.linear.icpt));
    } else if (s.filter === "colorchannelmixer") {
      const o = s.opts;
      const [r, g, b] = px;
      px = [c(o.rr * r + o.rg * g + o.rb * b), c(o.gr * r + o.gg * g + o.gb * b), c(o.br * r + o.bg * g + o.bb * b)];
    }
  }
  return px;
}

test("ffmpeg 翻译和 CSS 规范逐像素一致(含超出 0~1 被截断的情况)", () => {
  const cases = [
    [{ kind: "brightness", value: 1.6 }], [{ kind: "brightness", value: 0.4 }], [{ kind: "brightness", value: 0 }],
    [{ kind: "contrast", value: 2.5 }], [{ kind: "contrast", value: 0.3 }], [{ kind: "contrast", value: 0 }],
    [{ kind: "invert", value: 1 }], [{ kind: "invert", value: 0.3 }], [{ kind: "invert", value: 0.8 }],
    [{ kind: "saturate", value: 2 }], [{ kind: "hue", value: 120 }], [{ kind: "grayscale", value: 0.7 }], [{ kind: "sepia", value: 1 }],
    [{ kind: "brightness", value: 1.3 }, { kind: "contrast", value: 1.4 }, { kind: "saturate", value: 0.5 }, { kind: "hue", value: -45 }],
  ];
  const pixels = [[0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], [0.9, 0.2, 0.1], [0.1, 0.6, 0.95], [0.3, 0.3, 0.7]];
  for (const ops of cases) {
    const stages = ffmpegStages(ops);
    for (const px of pixels) {
      const want = cssPixel(ops, px);
      const got = ffPixel(stages, px);
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(want[i] - got[i]) < 1e-5, `${JSON.stringify(ops)} @ ${px}: ${want} vs ${got}`);
    }
    for (const s of stages) {
      if (s.filter === "colorchannelmixer") for (const v of Object.values(s.opts)) assert.ok(v >= -2 && v <= 2, "colorchannelmixer 每项只能在 -2~2");
    }
  }
});

test("ffmpeg:命名实例、模糊包一圈透明边、逐帧命令", () => {
  const def = normalizeFilterDef({ name: "呼吸", ops: [{ kind: "brightness", value: "1 + 0.5*t" }, { kind: "blur", value: "2*t" }] });
  const chain = ffmpegChain(ffmpegStages(resolveOps(def, undefined, 0, 2)), "f3", 12);
  assert.match(
    chain,
    /^lutrgb@f3_0=r=val\*1\+0\.5:g=val\*1\+0\.5:b=val\*1\+0\.5,premultiply=inplace=1,pad=iw\+24:ih\+24:12:12:color=black@0,gblur@f3_1=sigma=0:steps=6,crop=iw-24:ih-24:12:12,unpremultiply=inplace=1$/,
  );
  const { script, blurPad } = sendcmdScript(def, undefined, 2, [{ ts: 10, t: 0 }, { ts: 10.5, t: 0.5 }, { ts: 12, t: 2 }], "f3", 1, 30);
  const lines = script.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^9\.991667 lutrgb@f3_0 r val\*1\+0\.5, lutrgb@f3_0 g /);
  assert.match(lines[1], /lutrgb@f3_0 r val\*1\.25\+0\.5,.*gblur@f3_1 sigma 1;$/);
  assert.equal(blurPad, 12); // 整段最大 σ = 4 → 3σ

  assert.equal(ffmpegStaticChain([{ kind: "brightness", value: 1 }, { kind: "hue", value: 0 }]), "");
  assert.match(ffmpegStaticChain([{ kind: "saturate", value: 0.5 }]), /^colorchannelmixer=rr=0\.6065:rg=0\.3575:/);
  assert.match(ffmpegStaticChain([{ kind: "invert", value: 0.8 }]), /^lutrgb=r=val\*-0\.6\+204\.5:/);
  assert.match(ffmpegStaticChain([{ kind: "blur", value: 3 }], 2), /pad=iw\+36:ih\+36:18:18:.*gblur=sigma=6:steps=6/);
});

// 工程文件里的坏表达式(别的版本存的、手改过的):预览每帧都在 render 里调 resolveOps,抛了就是白屏
test("坏表达式按中性算、不抛;isAnimated 按 false", () => {
  const def = { ops: [{ kind: "brightness", value: "nope + 1" }, { kind: "blur", value: 3 }] };
  assert.deepEqual(resolveOps(def, undefined, 1, 2), [{ kind: "brightness", value: 1 }, { kind: "blur", value: 3 }]);
  assert.equal(isAnimated(def), false);
});

test("sendcmd 脚本:数值没变的帧不发命令", () => {
  const def = { ops: [{ kind: "brightness", value: "step(1, t)" }] };
  const frames = [0, 0.5, 1, 1.5, 2].map((t) => ({ ts: t, t }));
  const { script } = sendcmdScript(def, undefined, 2, frames, "d", 1, 30);
  assert.equal(script.trim().split("\n").length, 2, "0 和 1 处各一次");
});

// ---------------------------------------------------------------- curves / matrix(查表与颜色矩阵)
{
  const F = await import("./filters.mjs");
  test("curves / matrix:补齐形状、原样判定、描述", () => {
    const def = F.normalizeFilterDef({ name: "调色", ops: [{ kind: "curves", rgb: [0, 0.3, 1], b: [0.1, 0.9] }, { kind: "matrix", values: [1, 0, 0, 0, 1, 0, 0, 0, 1] }] });
    assert.deepEqual(def.ops[0], { kind: "curves", r: [0, 0.3, 1], g: [0, 0.3, 1], b: [0.1, 0.9] });
    assert.deepEqual(def.ops[1], { kind: "matrix", values: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] });
    const ops = F.resolveOps(def, undefined, 0.5, 2);
    assert.equal(F.isNeutralOp(ops[0]), false);
    assert.equal(F.isNeutralOp(ops[1]), true);
    assert.equal(F.isAnimated(def), false);
    assert.match(F.describeFilter(def), /曲线/);
  });
  test("curves / matrix:不合规的当场拒", () => {
    const bad = (ops, re) => assert.throws(() => F.normalizeFilterDef({ name: "x", ops }), re);
    bad([{ kind: "curves" }], /至少给/);
    bad([{ kind: "curves", rgb: [0.5] }], /2~33/);
    bad([{ kind: "curves", rgb: [0, 1.2] }], /0~1/);
    bad([{ kind: "curves", rgb: [0, 1], value: 1 }], /不用 value/);
    bad([{ kind: "matrix", values: [1, 0, 0] }], /9 个数/);
    bad([{ kind: "matrix", values: [9, 0, 0, 0, 1, 0, 0, 0, 1] }], /-4~4/);
    bad([{ kind: "matrix", values: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [2, 0, 0] }], /-1~1/);
    bad(Array.from({ length: 5 }, () => ({ kind: "curves", rgb: [0, 0.5, 1] })), /最多 4 步/);
  });
  test("curves:lutrgb 表达式就是那张分段线性表,而且不含逗号", () => {
    for (const table of [[0, 0.3, 0.62, 0.86, 1], [0.03, 0.5, 0.92], [1, 0], Array.from({ length: 33 }, (_, k) => Math.round(Math.pow(k / 32, 1.6) * 1e6) / 1e6)]) {
      const expr = F.tableLutExpr(table);
      assert.equal(expr.includes(","), false);
      const fn = new Function("val", "abs", "return " + expr);
      const n = table.length - 1;
      for (let v = 0; v <= 255; v++) {
        const x = (v / 255) * n, k = Math.min(n - 1, Math.floor(x));
        const want = (table[k] + (x - k) * (table[k + 1] - table[k])) * 255 + 0.5;
        assert.ok(Math.abs(fn(v, Math.abs) - want) < 1e-3, `table ${table.length} 点, val=${v}`);
      }
    }
    assert.equal(F.tableLutExpr([0, 1]), "0.5+1*val");
  });
  test("curves / matrix:预览是 url(#id),同内容同 id;导出是固定步骤,sendcmd 不重发", () => {
    const def = F.normalizeFilterDef({ name: "x", ops: [{ kind: "matrix", values: [1.1, 0.05, 0, 0, 1, 0.05, 0.02, 0, 0.9], offset: [-0.02, 0, 0.03] }, { kind: "curves", rgb: [0, 0.2, 1] }, { kind: "brightness", value: "1+0.1*sin(t)" }] });
    const ops = F.resolveOps(def, undefined, 1, 4);
    const css = F.cssFilter(ops);
    assert.match(css, /^url\(#pc-f-m[0-9a-z]+\) url\(#pc-f-c[0-9a-z]+\) brightness\(/);
    assert.equal(F.svgFilterId(ops[1]), F.svgFilterId({ kind: "curves", r: [0, 0.2, 1], g: [0, 0.2, 1], b: [0, 0.2, 1] }));
    assert.match(F.svgFilterMarkup(ops[0]), /<feColorMatrix type="matrix" values="1.1 0.05 0 0 0 0 1 0.05 0 0 0.02 0 0.9 0 0 0 0 0 1 0"\/><feComponentTransfer><feFuncR type="linear" slope="1" intercept="-0.02"\/>/);
    assert.match(F.svgFilterMarkup(ops[1]), /<feFuncG type="table" tableValues="0 0.2 1"\/>/);
    const stages = F.ffmpegStages(ops);
    assert.deepEqual(stages.map((s) => [s.filter, !!s.fixed]), [["colorchannelmixer", true], ["lutrgb", true], ["lutrgb", true], ["lutrgb", false]]);
    const { script } = F.sendcmdScript(def, undefined, 4, [{ ts: 0, t: 0 }, { ts: 1, t: 1 }], "fx0");
    assert.equal(/colorchannelmixer@/.test(script), false);
    assert.match(script, /lutrgb@fx0_3 r val\*/); // 只有会动的那一步(下标 3)在发命令,下标和建链时一致
    assert.equal(/lutrgb@fx0_[12] /.test(script), false);
    assert.equal(F.ffmpegStaticChain(F.resolveOps(F.normalizeFilterDef({ name: "n", ops: [{ kind: "curves", rgb: [0, 1] }] }), undefined, 0, 1)), "");
  });
}

/* 本文件由 scripts/login-art/make-card.mjs 生成，别手改。
 * 要改画面就去改 src/start/BrandGlow.tsx（屏幕上那一版），再重跑一次生成脚本，
 * 两边画的才是同一段 GLSL。生成时间不写进文件，免得每次重跑都产生无谓的 diff。
 *
 * 这张卡只为一件事存在：让 PromptCut 自己的渲染器把它**预渲染成循环视频**（用户 2026-10-24 定）。
 * 画面写成帧时钟 t 的函数，不自己跑帧循环，符合 server/card-authoring-guide.md。
 * uLoop = (t / 循环秒数) 的小数部分，走满一圈逐字节回到起点，所以第一帧和最后一帧接得上。
 */
import { useLayoutEffect, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";

interface Params {
  /** 底色（官网的 --bg、本仓库「流光」皮肤的 --ui-bg） */
  bg: string;
  /** 第一团光的颜色（屏幕上那一版取 --ui-accent；这里写死，导出要可重放） */
  colA: string;
  /** 第二团光的颜色 */
  colB: string;
  /** 循环一圈多少秒 */
  loopSeconds: number;
}

const WIDTH = 559;
const HEIGHT = 1290;

const LOOK = {
  /**
   * 飘一圈多少秒。`drift` 为 0 时这一项不起作用。
   *
   * 这个数同时是**预渲染出来那段循环视频的长度**：两团光的相位都是 uLoop 的整数倍频，
   * uLoop 从 0 走到 1 正好回到出发点，所以第一帧和最后一帧算出来一样，循环接得上。
   * 28 秒 × 24 帧 = 672 帧，整数，不会差半帧。
   */
  loopSeconds: 28,
  /** 两团光各自飘多远（CSS 像素）。0 = 完全不动，页面也就不用逐帧重画 */
  drift: 110,

  /**
   * 基准视口（CSS 像素）：下面那两组位置是在**这个尺寸**上调出来的。
   *
   * 用户 2026-10-23 定：「以铺满屏幕版的中心对齐。」所以两团光不按当前视口的比例摆
   * —— 那样手机和宽屏上的构图会完全不同 —— 而是换算成**相对屏幕中心的固定像素偏移**：
   *
   *     中心 = 视口中心 + (位置 - 0.5) × 基准视口
   *
   * 视口正好是基准尺寸时，这一式就还原成「位置 × 基准视口」，和调参台上看到的一模一样；
   * 屏幕小了就是同一张构图的中心裁切，大了就是往外多露一圈。半径本来就是固定像素，不跟着缩放。
   *
   * 559×1290 是调参台那块「铺满宽屏」预览当时的实际尺寸。
   */
  refW: 559,
  refH: 1290,

  /** 第一团（冷色，从左上压进来） */
  ax: 0.41,
  ay: -0.1,
  arx: 1900,
  ary: 1830,
  aAlpha: 0.225,
  aStop: 0.43,

  /** 第二团（暖色，从右下压进来） */
  bx: 1.08,
  by: 0.68,
  brx: 2400,
  bry: 1100,
  bAlpha: 0.025,
  bStop: 0.13,

  /** 抖动：打散色带用的噪声强度（0.004 ≈ 1/255）。grainSize 调大就从抖动变成看得见的颗粒 */
  grain: 0.008,
  grainSize: 2,

  /**
   * 颜色。留空就跟着皮肤走（底色 `--ui-bg`、光 `--ui-accent`），填了就用填的。
   *
   * 底色和冷的那团留空：换皮肤、在设置里改强调色，这一层要跟着变。
   * 暖的那团是用户 2026-10-23 挑定的橘色，和皮肤无关，所以写死
   * —— 和 `BrandCanvas.tsx` 那边「冷侧跟皮肤、暖侧写死」是同一套做法。
   */
  bg: "",
  colA: "",
  colB: "#FF7B00",

  /** 内部分辨率 = min(设备像素比, 2) × 这个数。渐变很便宜，给到 1 就是一比一 */
  resScale: 1,
};

const VERT = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;

const FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2 uRes;      // 画布的内部像素
uniform float uPxScale; // 内部像素 / CSS 像素
/* 循环相位，0→1 走满一圈回到起点 */
uniform float uLoop;

uniform vec3 uBg;
uniform vec3 uColA;
uniform vec3 uColB;

uniform float uAx, uAy, uArx, uAry, uAAlpha, uAStop;
uniform float uBx, uBy, uBrx, uBry, uBAlpha, uBStop;
uniform float uGrain, uGrainSize, uDrift;
uniform float uRefW, uRefH;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

/*
 * 一团 CSS 式的径向光：radial-gradient(rx ry at cx cy, 色 浓度 a0, transparent stop)。
 * CSS 的渐变是在**预乘**的空间里线性插值的，所以色相一路不变，只有 alpha 从 a0 直线降到 0，
 * 到 stop（相对椭圆半径的比例）就没了。这里照这个算，不用 smoothstep，不然和官网对不上。
 */
float glow(vec2 px, vec2 c, vec2 r, float stop, float a0) {
  float t = length((px - c) / max(r, vec2(1.0)));
  return a0 * clamp(1.0 - t / max(stop, 1e-4), 0.0, 1.0);
}

void main() {
  float s = max(uPxScale, 1e-4);
  vec2 cssPx = gl_FragCoord.xy / s;
  float wCss = uRes.x / s;
  float hCss = uRes.y / s;
  // gl_FragCoord 的 y 从下往上数，CSS 从上往下：翻过来，位置参数才和官网写的那组数一个意思
  cssPx.y = hCss - cssPx.y;

  // 两团朝相反方向飘，错开一点才看得出是两团；drift = 0 时这一项是 0
  /*
   * 两团朝相反方向飘，错开一点才看得出是两团；drift = 0 时这一项是 0。
   *
   * 两个频率取 4 和 3（原来是 1 和 0.75，比值一样是 0.75，但不是整数倍频）：
   * 整数倍频才保证 uLoop 走满一圈时两项同时回到出发点 —— 预渲染成视频要靠这一条接上循环。
   * 快慢没变：一圈的秒数由 LOOK.loopSeconds 定。
   */
  vec2 d = uDrift * vec2(sin(uLoop * 6.2831853 * 4.0), cos(uLoop * 6.2831853 * 3.0));

  /*
   * 以屏幕中心对齐：位置不按当前视口的比例算，而是换算成相对中心的固定像素偏移
   * （基准视口见组件里的 refW / refH）。视口正好是基准尺寸时结果和「位置 × 视口」相同；
   * 屏幕小了就是同一张构图的中心裁切。
   */
  vec2 mid = vec2(wCss, hCss) * 0.5;
  vec2 ref = vec2(max(uRefW, 1.0), max(uRefH, 1.0));

  float aA = glow(cssPx, mid + (vec2(uAx, uAy) - 0.5) * ref + d, vec2(uArx, uAry), uAStop, uAAlpha);
  float aB = glow(cssPx, mid + (vec2(uBx, uBy) - 0.5) * ref - d, vec2(uBrx, uBry), uBStop, uBAlpha);

  // 叠的顺序同官网：CSS 里先写的那层在上面，所以 B 先压在底色上，A 再压上去
  vec3 col = uBg;
  col = mix(col, uColB, aB);
  col = mix(col, uColA, aA);

  // 抖动：深色上的大面积渐变在 8 位里会起一圈圈色带，撒一点噪声把台阶打散
  float n = hash(floor(gl_FragCoord.xy / max(uGrainSize, 1.0)) + 0.5);
  col += (n - 0.5) * uGrain;

  fragColor = vec4(max(col, 0.0), 1.0);
}`;

function hexToRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function BrandGlow({ params, t = 0, stage }: CardProps<Params>) {
  const ref = useRef<HTMLCanvasElement>(null);
  // 画幅跟着项目走（两团光的半径是固定像素，所以在什么尺寸上渲就是那个尺寸的构图）
  const w = Math.max(2, Math.round(stage?.width ?? WIDTH));
  const h = Math.max(2, Math.round(stage?.height ?? HEIGHT));
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    // WebGL2 起不来就画一块底色，别让整张卡炸掉
    if (!gl) {
      const c2 = canvas.getContext("2d");
      if (c2) { c2.fillStyle = params.bg || "#111016"; c2.fillRect(0, 0, w, h); }
      return;
    }
    const make = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, make(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, make(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    gl.useProgram(prog);
    const at = (n: string) => gl.getUniformLocation(prog, n);

    gl.uniform1f(at("uAx"), LOOK.ax);
    gl.uniform1f(at("uAy"), LOOK.ay);
    gl.uniform1f(at("uArx"), LOOK.arx);
    gl.uniform1f(at("uAry"), LOOK.ary);
    gl.uniform1f(at("uAAlpha"), LOOK.aAlpha);
    gl.uniform1f(at("uAStop"), LOOK.aStop);
    gl.uniform1f(at("uBx"), LOOK.bx);
    gl.uniform1f(at("uBy"), LOOK.by);
    gl.uniform1f(at("uBrx"), LOOK.brx);
    gl.uniform1f(at("uBry"), LOOK.bry);
    gl.uniform1f(at("uBAlpha"), LOOK.bAlpha);
    gl.uniform1f(at("uBStop"), LOOK.bStop);
    gl.uniform1f(at("uGrain"), LOOK.grain);
    gl.uniform1f(at("uGrainSize"), LOOK.grainSize);
    gl.uniform1f(at("uDrift"), LOOK.drift);
    gl.uniform1f(at("uRefW"), LOOK.refW);
    gl.uniform1f(at("uRefH"), LOOK.refH);
    gl.uniform3f(at("uBg"), ...hexToRgb(params.bg, [0.067, 0.063, 0.086]));
    gl.uniform3f(at("uColA"), ...hexToRgb(params.colA, [0.000, 0.859, 0.859]));
    gl.uniform3f(at("uColB"), ...hexToRgb(params.colB, [1.000, 0.482, 0.000]));
    gl.uniform2f(at("uRes"), w, h);
    gl.uniform1f(at("uPxScale"), 1);
    // 走满一圈回到起点：t 到了 loopSeconds 这一帧和 t = 0 那一帧算出来一样
    const secs = Math.max(0.001, params.loopSeconds);
    gl.uniform1f(at("uLoop"), ((t % secs) + secs) % secs / secs);

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.deleteProgram(prog);
  }, [t, params.bg, params.colA, params.colB, params.loopSeconds, w, h]);
  return <canvas ref={ref} width={w} height={h} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />;
}

export const brandGlow: CardDef<Params> = {
  id: "pc-brand-glow",
  name: "首页背景光",
  description: "官网首页与手机版登录的背景那两团光。画面是帧时钟的函数，走满一圈回到起点，专门用来预渲染成无缝循环的视频。",
  source: "user",
  useWhen: "只给「把首页／手机登录的背景光渲成循环视频」这一件事用；别的场合要背景光请另写一张。",
  tags: ["背景", "光", "着色器", "首页"],
  frameMode: "direct",
  defaults: { bg: "#111016", colA: "#00dbdb", colB: "#FF7B00", loopSeconds: 28 },
  controls: [
    { key: "bg", label: "底色", type: "color" },
    { key: "colA", label: "冷光", type: "color" },
    { key: "colB", label: "暖光", type: "color" },
    { key: "loopSeconds", label: "循环秒数", type: "number", min: 4, max: 600, step: 1 },
  ],
  Component: BrandGlow,
};

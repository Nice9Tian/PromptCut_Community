/*
 * 官网首页那层背景光，用渲染器做一遍。
 *
 * 官网首页的背景是 `body` 上两团固定的径向光，原文在 VisuHive 仓库
 * `site/assets/home.css`：
 *
 *   background:
 *     radial-gradient(1200px 700px at 15% -10%, var(--glow-a), transparent 60%),
 *     radial-gradient(900px  600px at 100% 40%, var(--glow-b), transparent 60%),
 *     var(--bg);
 *   background-attachment: fixed;
 *
 * 深色下 `--glow-a` 是 rgba(0,219,219,.14)、`--glow-b` 是 rgba(0,219,219,.08)、`--bg` 是 #111016
 * ——也就是本仓库「流光」皮肤的 `--ui-accent` 和 `--ui-bg`。2026-10-23 线上实测：首页零个 canvas，
 * 整层就是这段 CSS，没有别的动态背景。
 *
 * **那为什么还要用渲染器？** 两条：
 *   1. 大片深色上的渐变在 8 位里会起色带（banding），尤其手机 OLED 上一圈一圈很明显。
 *      着色器里加一点抖动噪声就能把台阶打散，CSS 渐变做不到。
 *   2. 参数能调：位置、半径、浓度、颜色、飘动都是 uniform，用户在调参台上拖，定下来的数写回
 *      下面的 LOOK。`drift` 调成 0 就和官网一模一样、完全不动。
 *
 * 和 `BrandCanvas.tsx`（登录页左边那块流动的极光）是两件事，互不影响：那一块电脑版已经定稿。
 *
 * 起不来 WebGL2 时退回一张 `div`，上面铺的就是官网原样的 CSS 渐变——兜底和原版完全一致，
 * 只是少了抖动。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import "./brandGlow.css";

/**
 * 画面参数。调参台（scratchpad 的 make-glow-lab.mjs）直接读这里的数做滑杆，
 * 调好把「当前值」整段写回来就同步。
 *
 * 位置 `ax/ay/bx/by` 是视口的比例（0 = 左/上，1 = 右/下，可以是负数），
 * 半径 `arx/ary/brx/bry` 是 CSS 像素——和官网一样是固定像素，不跟着窗口缩放。
 */
export const LOOK = {
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

/** 皮肤读不到时的兜底：流光深色的 `--ui-bg` #111016 和 `--ui-accent` #00dbdb */
const BG_FALLBACK: [number, number, number] = [0.067, 0.063, 0.086];
const ACCENT_FALLBACK: [number, number, number] = [0, 0.859, 0.859];

export const VERT = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;

export const FRAG = `#version 300 es
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

/** 十六进制 → 0..1 的 RGB */
function hexToRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** 把一个 CSS 变量解析成 0..1 的 RGB。读不到就用兜底 —— 变量可能是 color-mix()，所以让浏览器自己算 */
function readColor(name: string, fallback: [number, number, number]): [number, number, number] {
  try {
    const probe = document.createElement("span");
    probe.style.cssText = `color: var(${name}); position: absolute; opacity: 0; pointer-events: none;`;
    document.body.appendChild(probe);
    const got = getComputedStyle(probe).color;
    probe.remove();
    const m = /rgba?\(([^)]+)\)/.exec(got);
    if (!m) return fallback;
    const parts = m[1].split(/[,\s/]+/).map(Number).filter((n) => Number.isFinite(n));
    if (parts.length < 3) return fallback;
    return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
  } catch {
    return fallback;
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // 编译不过就退回 CSS 那一版；把原因留在控制台，不然只看到一块底色没法查。
    // 开发期有一个常见原因：改这个文件触发热更新会反复重挂组件，每次新建一个 WebGL 上下文，
    // 用满浏览器的上限（Chrome 约 16 个）之后新上下文一建就是坏的 —— 这时日志会是 null。
    // 整页刷新一下就好，不是着色器写错了。
    console.warn(
      "[BrandGlow] 着色器编译失败：",
      gl.getShaderInfoLog(sh),
      "gl.getError=", gl.getError(),
      "（开发期若日志为 null，多半是热更新累积的 WebGL 上下文超了上限，整页刷新即可）",
    );
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function BrandGlow(): JSX.Element {
  const host = useRef<HTMLCanvasElement>(null);
  /** 起不来就退回官网原样的 CSS 渐变 */
  const [dead, setDead] = useState(false);

  useEffect(() => {
    const canvas = host.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", {
      // 这一层是不透明的背景（底色也由它画），不用混合
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
      // 之后要截这一帧做成静态图，不保留就读不到像素
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      setDead(true);
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) {
      setDead(true);
      return;
    }
    const prog = gl.createProgram();
    if (!prog) {
      setDead(true);
      return;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[BrandGlow] 着色器链接失败：", gl.getProgramInfoLog(prog));
      setDead(true);
      return;
    }
    gl.useProgram(prog);

    const at = (n: string) => gl.getUniformLocation(prog, n);
    const uRes = at("uRes");
    const uPxScale = at("uPxScale");
    const uLoop = at("uLoop");
    const uBg = at("uBg");
    const uColA = at("uColA");
    const uColB = at("uColB");

    // 几何和浓度不随帧变，设一遍就够
    for (const [name, value] of [
      ["uAx", LOOK.ax], ["uAy", LOOK.ay], ["uArx", LOOK.arx], ["uAry", LOOK.ary],
      ["uAAlpha", LOOK.aAlpha], ["uAStop", LOOK.aStop],
      ["uBx", LOOK.bx], ["uBy", LOOK.by], ["uBrx", LOOK.brx], ["uBry", LOOK.bry],
      ["uBAlpha", LOOK.bAlpha], ["uBStop", LOOK.bStop],
      ["uGrain", LOOK.grain], ["uGrainSize", LOOK.grainSize], ["uDrift", LOOK.drift],
      ["uRefW", LOOK.refW], ["uRefH", LOOK.refH],
    ] as const) {
      gl.uniform1f(at(name), value);
    }

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    /** 不飘就是一张静止的画：画一帧就够，不开逐帧循环 —— 手机上这点电省得值 */
    const animated = LOOK.drift > 0.0001 && !still;

    let raf = 0;
    let visible = true;
    let frames = 0;
    const started = performance.now();

    const resize = () => {
      const box = canvas.getBoundingClientRect();
      const s = Math.min(window.devicePixelRatio || 1, 2) * LOOK.resScale;
      const w = Math.max(2, Math.round(box.width * s));
      const h = Math.max(2, Math.round(box.height * s));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uPxScale, s);
    };

    const draw = () => {
      resize();
      // 换皮肤、改强调色都要跟着变。每半秒重读一次就够；不逐帧画的时候每次 draw 都读
      if (frames % 30 === 0) {
        gl.uniform3f(uBg, ...(LOOK.bg ? hexToRgb(LOOK.bg, BG_FALLBACK) : readColor("--ui-bg", BG_FALLBACK)));
        gl.uniform3f(uColA, ...(LOOK.colA ? hexToRgb(LOOK.colA, ACCENT_FALLBACK) : readColor("--ui-accent", ACCENT_FALLBACK)));
        gl.uniform3f(uColB, ...(LOOK.colB ? hexToRgb(LOOK.colB, ACCENT_FALLBACK) : readColor("--ui-accent", ACCENT_FALLBACK)));
      }
      // 取小数部分：走满一圈回到 0，屏幕上这一版也就跟着无缝接上了
      const secs = (performance.now() - started) / 1000;
      gl.uniform1f(uLoop, animated ? (secs / LOOK.loopSeconds) % 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frames++;
    };

    const loop = () => {
      if (!visible || document.hidden) {
        raf = 0;
        return;
      }
      draw();
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (animated && raf === 0 && visible && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    draw(); // 先画一帧：不飘的时候这一帧就是全部
    start();

    // 切到后台、滚出视野就停（不飘的时候本来就没有循环，这两条只是兜着）
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      if (visible) start();
      else stop();
    });
    io.observe(canvas);

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);

    // 窗口变了要重画：不飘的时候没有循环，全靠这里补一帧
    const ro = new ResizeObserver(() => {
      draw();
      start();
    });
    ro.observe(canvas);

    // 显卡驱动重置、切换独显集显都会丢上下文；丢了就退回 CSS 那一版，别留一块黑的
    const onLost = (e: Event) => {
      e.preventDefault();
      stop();
      setDead(true);
    };
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  // 兜底就是官网那段 CSS 本身（见 brandGlow.css），和原版一致，只是没有抖动
  if (dead) return <div className="ps-brand-glow ps-brand-glow--css" aria-hidden="true" />;
  return <canvas ref={host} className="ps-brand-glow" data-pc="start-brand-glow" aria-hidden="true" />;
}

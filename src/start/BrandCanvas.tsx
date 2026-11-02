/**
 * 登录页左边那块的底:WebGL 着色器画的流动渐变(用户 2026-10-23 给了参考海报)。
 *
 * **先说清楚它不是光追。** 参考图那种效果是「烟雾般的渐变」,做法是在片元着色器里把分形噪声反复
 * **域扭曲**(domain warp)后映成色带 —— 路径追踪解的是光线和几何的交互,这张图里既没有几何也没有光源,
 * 拿路径追踪去做慢几十倍,出来的也不是这个样子。所以这里是着色器,不是光追。
 * 要是你要的就是「有体积、有光照衰减」的那种,我可以再加一段体积步进(单次散射),代价是帧率。
 *
 * 配色:冷的那一侧取软件主题色 `--ui-accent`(用户 2026-10-23 定:「蓝颜色部分换成本软件的主题色」),
 * 暖的那一侧是参考图里的琥珀色。换皮肤、改强调色都会跟着变 —— 每隔半秒重读一次变量。
 *
 * 省电:页面切到后台、这一块滚出视野就停;`prefers-reduced-motion` 只画一帧不动;内部分辨率按
 * 设备像素比打折(画面本来就是糊的,放大看不出来)。WebGL2 起不来、或者上下文丢了,退回
 * `BrandAurora`(CSS 那一版),不会留一块黑的。
 *
 * LOOK 里那一组数是在调参台上逐个试出来的(会话 scratchpad 的 `shader-lab.html`,同一份着色器配滑杆),
 * 不是拍脑袋写的;要再调,把那一页起起来拖滑杆,拖好把数抄回来即可。
 */
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { BrandAurora } from "./BrandAurora";
import "./brandCanvas.css";
import { tr } from "../i18n/index.ts";

/** 画面参数。每一条都对应着色器里的一个 uniform,改数就换花样,不用动 GLSL */
export const LOOK = {
  /**
   * 循环一圈多少秒。预渲染出来的视频就是这么长,越长越不容易看出在循环,代价是文件大一点。
   * 实时那一版也按同一个周期走,所以屏幕上和预渲染的是同一段动作
   */
  loopSeconds: 48,
  /**
   * 噪声域里那个圈有多大(噪声单位)。改之前是「每秒漂 0.025 个单位」一直往前,
   * 一圈 48 秒就是 1.2 个单位的路程;圈的周长要跟它相当,画面动起来才和原来一样慢。
   * 基频加二次谐波的那条闭合曲线,周长大约是 2π·R·1.3,所以 R ≈ 1.2 / (2π·1.3) ≈ 0.15
   */
  swirl: 0.15,
  /** 噪声尺度:大了碎,小了只剩一道平滑的渐变,看不出形 */
  scale: 0.9,
  /**
   * 纹理的参考尺寸(CSS 像素)。纹理按屏幕像素锚定,不随这一块缩放 ——
   * 这个数定「多少像素算一个单位」,改它等于整体放大缩小;窗口变大只会露出更多
   */
  refPx: 460,
  /** 纵向压扁的倍数(<1 = 纹理在竖直方向拉长):参考图里那种「帘子」靠它 */
  yStretch: 0.9,
  /** 冷暖分界大概在横向哪个位置(0 左 1 右) */
  split: 0.54,
  /**
   * 冷暖各自的衰减次方。>1 时中间两边都弱 → 自然变暗变灰(参考图中间那片深色就是这么来的);
   * =1 就是普通插值,中间不会暗
   */
  falloff: 1.5,
  /**
   * **两色融合的范围**(用户 2026-10-23 要的那个旋钮):过渡带有多宽。
   * 0 = 一条硬边,两边各自为政;1 = 整块都在过渡,到处都是混出来的颜色
   */
  blend: 0.42,
  /**
   * 噪声把冷暖的分界推得多乱。大了之后橘黄会伸进青的那一侧、青也会探进橘黄那边,
   * 两色互相咬合 —— 这是「融合」的另一半,光把过渡带拉宽只会得到一条平直的渐变
   */
  mixWarp: 0.8,
  /** 细竖条纹的强弱(参考海报右半边那些细线) */
  streak: 0.0,
  /** 条纹毛玻璃:一屏放几条 */
  stripeN: 2.0,
  /** 条纹的倾斜(0 = 正竖直;照上一版 CSS 的 104° 略微斜一点) */
  stripeSkew: 0.0,
  /** 磨砂的模糊半径(噪声坐标里的距离):越大越糊 */
  frostBlur: 0.68,
  /** 磨砂条和清条的对比 */
  frost: 1.0,
  /** 磨砂面的乳白(散射):玻璃磨过的那面会亮一点 */
  milky: 0.25,
  /** 清条与磨砂条交界那道细高光(玻璃的棱) */
  edge: 0.056,
  /** 颗粒的强弱 */
  grain: 0.125,
  /** 颗粒多粗:一格几个像素(内部分辨率下算),格子越大颗粒越粗 */
  grainSize: 1.0,
  /** 颗粒参与折射的程度:磨砂玻璃靠表面微小凹凸把光打散,这个数就是「凹凸有多乱」 */
  grainJitter: 0.0,
  /**
   * 颗粒的柔化。0 = 只有插值(已经不是马赛克了);往上加会再做一次 5 点平均,
   * 相当于一道很轻的高斯,颗粒越来越绵
   */
  grainSoft: 0.5,
  /** 两道域扭曲各推多远 */
  warpA: 4.0,
  warpB: 4.2,
  /** 明暗曲线:次方越大暗部压得越狠 */
  gamma: 3.35,
  /** 亮部提多少 */
  gain: 4.0,
  /** 最暗处还剩多少(不给 0,全黑一片没有层次) */
  floor: 0.1,
  /** 高光滚落:越大越早压住,防止冲成霓虹 */
  roll: 0.8,
  /** 饱和度:1 不变,大于 1 更浓 */
  sat: 1.38,
  /** 内部分辨率的倍率:0.6 表示按 CSS 尺寸的六成渲染再拉大 */
  resScale: 0.6,
  /**
   * 冷侧颜色。空串 = 跟着软件主题色 `--ui-accent` 走(换皮肤会变);
   * 想钉死就填十六进制,比如 "#00DBDB"
   */
  cool: "",
  /** 暖侧颜色(参考图里的琥珀) */
  warm: "#E2731F",
  /** 主题色读不到时的兜底 */
  coolFallback: [0.0, 0.859, 0.859] as [number, number, number],
  /**
   * 分色的方向:0 = 横向(左冷右暖),1 = 纵向(上冷下暖)。
   * 用户 2026-10-23 想要的「黄从下面进、蓝从上面进」就是把它拉到 1
   */
  axis: 0.0,
  /**
   * **背景以 alpha 的形式进来**(用户 2026-10-23 定的做法):暗的地方让画布透明,
   * 透出页面本身的底色,而不是在着色器里画一层假的背景色 —— 这样换皮肤、改底色都不用动这儿,
   * 透出来的永远是真的那个背景。0 = 不透(和原来一样),1 = 暗处全透
   */
  seeThrough: 0.55,
  /** 再沿右边缘淡出到透明的宽度(0 = 不淡出),配合上面那条做「右侧是背景色」的格局 */
  fadeEdge: 0.6,
};

/**
 * 顶点与片元着色器、以及那组画面参数,都**导出**:预渲染登录页左栏那段循环动画时,
 * 生成用户卡源码的脚本要原样拿走它们(`scripts/login-art/make-card.mjs`),
 * 这样屏幕上这一版和预渲染出来的那一版画的是同一段 GLSL,不会各自漂。
 */
export const VERT = tr("#version 300 es\nvoid main() {\n  // A triangle covering the whole screen: no vertex buffer, coordinates are computed from the vertex ID\n  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);\n  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n}");

export const FRAG = tr("#version 300 es\nprecision highp float;\nout vec4 fragColor;\n\nuniform vec2  uRes;\n/* Radius of the circle in the noise domain (noise units). 0 = no motion at all */\nuniform float uSwirl;\n/* Loop phase, 0→1 is one full turn. A full turn lands exactly on the start, so frame 0 and frame N are byte-identical */\nuniform float uLoop;\nuniform vec3  uCool;\nuniform vec3  uWarm;\nuniform float uScale, uYStretch, uSplit, uFalloff, uBlend, uMixWarp, uStreak, uGrain;\nuniform float uAxis, uSeeThrough, uFadeEdge;\nuniform float uRefPx, uPxScale;\n/* Flatten: set to 1 when prerendering to video. Video cannot carry alpha, so the background color is composited in first and the output is opaque; the on-screen version sets 0 and still outputs premultiplied semi-transparent color */\nuniform float uFlatten;\n/* Color laid underneath when flattening (--bg-canvas of the login page) */\nuniform vec3  uBg;\nuniform float uWarpA, uWarpB, uGamma, uGain, uFloor, uRoll, uSat;\nuniform float uStripeN, uStripeSkew, uFrostBlur, uFrost, uMilky, uEdge;\nuniform float uGrainSize, uGrainJitter, uGrainSoft;\n\nfloat hash12(vec2 p) {\n  vec3 p3 = fract(vec3(p.xyx) * 0.1031);\n  p3 += dot(p3, p3.yzx + 33.33);\n  return fract((p3.x + p3.y) * p3.z);\n}\n\nfloat vnoise(vec2 x) {\n  vec2 i = floor(x), f = fract(x);\n  f = f * f * (3.0 - 2.0 * f);\n  float a = hash12(i);\n  float b = hash12(i + vec2(1.0, 0.0));\n  float c = hash12(i + vec2(0.0, 1.0));\n  float d = hash12(i + vec2(1.0, 1.0));\n  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);\n}\n\n/**\n * Noise for the grain: **interpolated**, not floor-ed squares.\n *\n * With floor + hash each cell is a constant and jumps at the borders, which looks like a mosaic (pointed out by the user, 2026-10-23).\n * In vnoise the four corner hashes are interpolated with smoothstep, so cells blend into one continuous surface.\n * When uGrainSoft > 0, a 5-point average (up, down, left, right plus center) is applied once more,\n * which acts like a very light Gaussian and softens the grain further;\n * at 0 only the interpolation layer remains.\n */\nfloat grainNoise(vec2 c, float soft) {\n  float n = vnoise(c);\n  if (soft > 0.001) {\n    float d = soft * 0.5;\n    n = (n + vnoise(c + vec2(d, 0.0)) + vnoise(c - vec2(d, 0.0))\n           + vnoise(c + vec2(0.0, d)) + vnoise(c - vec2(0.0, d))) * 0.2;\n  }\n  return n;\n}\n\nfloat fbm(vec2 p) {\n  float s = 0.0, a = 0.5;\n  for (int i = 0; i < 4; i++) {\n    s += a * vnoise(p);\n    p *= 2.03;\n    a *= 0.5;\n  }\n  return s;\n}\n\nvoid main() {\n  vec2 uv = gl_FragCoord.xy / uRes;\n\n  /*\n   * The texture is anchored to **screen pixels** and does not scale with the size of this block (user decision, 2026-10-23):\n   * widening or heightening the window only \"reveals more\"; it does not stretch the same picture.\n   *\n   * The origin is the split line (the skeleton of the composition) and the vertical midline, so however wide this block is,\n   * the texture near the cool/warm boundary always looks the same, and changes only happen at the two ends.\n   *\n   * First convert gl_FragCoord back to CSS pixels (internal rendering is scaled down by uPxScale), so the texture\n   * thickness is the same on high-DPI and regular screens; uRefPx is the reference size, and changing it scales the whole thing up or down.\n   */\n  vec2 cssPx = gl_FragCoord.xy / max(0.0001, uPxScale);\n  vec2 anchor = vec2(uSplit * uRes.x, 0.5 * uRes.y) / max(0.0001, uPxScale);\n  vec2 p = (cssPx - anchor) / max(1.0, uRefPx) * uScale;\n  p.y *= uYStretch;\n  /*\n   * Time **walks a closed loop** in the noise domain; it does not drift forward forever.\n   *\n   * Why it changed (2026-10-24, user decision: \"the left side is the renderer's prerendered animation\"): the prerender produces a finite-length video\n   * that must loop seamlessly. The old four terms were all forward-only translations like p + t * k, which do not close on the timeline,\n   * so cutting a segment to loop would jump at the seam. Now each term's offset is a periodic function of uLoop,\n   * and uLoop going from 0 to 1 returns exactly to the starting point: frame 0 and frame N are computed byte-identical, and the seam is invisible.\n   *\n   * The path is not a perfect circle but loops within loops (fundamental + second harmonic): a perfect circle looks like spinning in place and the loop is obvious at a glance;\n   * with a second harmonic added, the trajectory is a curled closed curve that travels farther and looks less like circling, while the period is still 1.\n   * The four terms each get a different phase and direction so the four layers do not move together.\n   * Each term subtracts its value at loopAng = 0, so the frame at uLoop = 0 is exactly the same as before this change: the numbers from the tuning bench still work.\n   * (The variable is called loopAng, not a: this shader already has two a's, one of the four corners in the noise at line 166 and the opacity at line 323. Naming it a gives ERROR: a : redefinition, the whole shader fails to compile, and it falls back to the CSS version on the spot.)\n   */\n  float loopAng = 6.2831853 * uLoop;\n  #define LOOPV(ph, dir, amp) (uSwirl * (amp) * (       vec2(sin(loopAng * (dir) + (ph)) - sin(ph), cos(loopAng * (dir) + (ph)) - cos(ph))     + vec2(sin(loopAng * 2.0 * (dir) + (ph)) - sin(ph), cos(loopAng * 2.0 * (dir) + (ph)) - cos(ph)) * 0.45))\n\n  // Two domain warps: the first pushes the coordinates apart, the second pushes the result of the first again.\n  // This is how the \"stirred\" layering in the reference image comes about; a single noise layer cannot produce it\n  vec2 q = vec2(fbm(p + LOOPV(0.0, 1.0, 1.0)), fbm(p + vec2(5.2, 1.3) + LOOPV(2.1, -1.0, 0.7)));\n  vec2 r = vec2(fbm(p + uWarpA * q + vec2(1.7, 9.2) + LOOPV(4.0, 1.0, 0.5)),\n                fbm(p + uWarpA * q + vec2(8.3, 2.8) + LOOPV(5.6, -1.0, 0.4)));\n  // Striped frosted glass: within each diagonal stripe the texture underneath is \"ground down\": one less layer of detail and pushed sideways a bit,\n  // as if seen through frosted glass; between stripes it is clear. This is the shader equivalent of the previous version's backdrop-filter striped frost\n  // (what the user asked for by name was the three things \"flowing aurora + striped frosted glass + grain\", so we cannot keep just two of them)\n  // The stripe profile uses sin, not fract: fract jumps back to 0 at the end, breaking at every stripe seam and looking like window blinds\n  float phase = (uv.x * uStripeN + uv.y * uStripeSkew) * 6.2831853;\n  float frost = smoothstep(-0.85, 0.85, sin(phase));\n  vec2 pw = p + uWarpB * r;\n\n  /*\n   * Frosted stripes: **smear the pixels behind sideways** (average four horizontal neighbor samples), which is exactly what glass does.\n   *\n   * The previous two versions both got it wrong: one blended in noise at another scale (that is ghosting), the other pulled out the detail layer (that is downsampling).\n   * The base image at scale≈0.9 is already smooth with little detail to pull out, so after pulling it out only flat slabs remain, which looks like window blinds.\n   * The radius of a clear stripe is 0, so the four samples land on the same point and the result equals the original image; stripes are therefore continuous with no seams.\n   */\n  /*\n   * Grain: **does not change over time**. Glass is a motionless thing, so of course the grain on its surface does not move either ---\n   * the old version recomputed it every frame (time was in the hash), which looked like the whole screen flickering (pointed out by the user, 2026-10-23).\n   * Coarse grain works by quantizing screen coordinates by uGrainSize: one random number per cell, and the larger the cell the coarser the grain.\n   */\n  // Grain is also computed in CSS pixels, otherwise it would get finer on high-DPI screens\n  vec2 gco = cssPx / max(1.0, uGrainSize);\n  float gn1 = grainNoise(gco, uGrainSoft);\n  float gn2 = grainNoise(gco + 71.3, uGrainSoft);\n\n  float br = frost * uFrost * uFrostBlur;\n  /*\n   * Frost \"perturbation\": each grain samples with an extra offset in its own random direction. Frosted glass scatters light\n   * through tiny bumps on its surface, so the grain has to **take part in the refraction**, rather than being sprinkled over the picture afterwards.\n   * The offset is multiplied by br: on clear stripes br=0, the grain has no effect, and clear areas stay clear.\n   */\n  vec2 jit = vec2(gn1 - 0.5, gn2 - 0.5) * br * uGrainJitter;\n  float f = (fbm(pw + jit + vec2(-1.5 * br, 0.0)) + fbm(pw + jit + vec2(-0.5 * br, 0.0))\n           + fbm(pw + jit + vec2(0.5 * br, 0.0)) + fbm(pw + jit + vec2(1.5 * br, 0.0))) * 0.25;\n\n  // The cool/warm boundary is roughly a vertical line, and noise only nudges it lightly: push too much and the two sides bite into each other.\n  // The reference image is \"cool on the left, warm on the right, a dark band in the middle\", not mixed together\n  // Direction of the color split: uAxis=0 splits horizontally (cool left, warm right), =1 splits vertically (cool top, warm bottom).\n  // When splitting vertically use 1-uv.y so that \"top\" is the cool color\n  float axisC = mix(uv.x, 1.0 - uv.y, clamp(uAxis, 0.0, 1.0));\n  // The boundary is pushed around by noise: the larger uMixWarp, the deeper the two colors bite into each other\n  float split = uSplit + (r.x - 0.5) * uMixWarp;\n  // Half-width of the transition band: uBlend opens from \"a hard edge\" all the way to \"the whole block is transition\"\n  float halfW = mix(0.02, 0.85, clamp(uBlend, 0.0, 1.0));\n  float m = smoothstep(split - halfW, split + halfW, axisC);\n\n  // The dark region in the middle is **not painted on**: each light falls off outward from its own side, and in the middle neither is strong,\n  // so the sum is dark and desaturated. This is how blue and orange mix into a dark color in the reference image (pointed out by the user, 2026-10-23).\n  // The larger uFalloff, the harder the middle drops; at 1 it degrades to plain interpolation and the middle does not darken\n  float wc = pow(clamp(1.0 - m, 0.0, 1.0), uFalloff);\n  float ww = pow(clamp(m, 0.0, 1.0), uFalloff);\n  vec3 base = uCool * wc + uWarm * ww;\n\n  // Light and dark: the dark parts are pushed down hard, so most places are close to black and color lights up only in a few spots. This is the weight of the reference image\n  float lum = pow(clamp(f * 1.18, 0.0, 1.0), uGamma);\n  vec3 col = base * (uFloor + uGain * lum);\n  // Highlight roll-off: bright parts obtained by direct multiplication would blow out into neon, and this step pushes them back down\n  col = col / (1.0 + col * uRoll);\n  // Fine-tune saturation\n  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, uSat);\n\n  // Two things about glass: the frosted face itself is milky (scattering lifts the brightness a little), and where clear stripes meet frosted stripes there is a thin highlight (the glass edge)\n  col *= 1.0 + frost * uMilky;\n  float edge = 1.0 - abs(frost * 2.0 - 1.0);\n  col += pow(edge, 3.0) * uEdge;\n\n  // Fine vertical stripes: one fixed random number per column, more visible toward the right (the fine lines on the right half of the reference poster)\n  float band = hash12(vec2(floor(uv.x * 240.0), 7.0));\n  col *= 1.0 + (band - 0.5) * uStreak * smoothstep(0.18, 0.9, uv.x);\n\n  // Vignette\n  vec2 d = (uv - 0.5) * vec2(1.08, 1.0);\n  col *= 0.30 + 0.70 * smoothstep(1.15, 0.18, length(d));\n\n  // The overlaid grain layer is likewise motionless, and more visible on frosted stripes: it is part of the glass, not film grain laid over the picture\n  col += (gn1 - 0.5) * uGrain * (0.3 + 0.7 * frost);\n\n  /*\n   * The background comes in as alpha (user decision, 2026-10-23): dark areas leave the canvas transparent, letting the page's real background color show through,\n   * instead of painting a fake background color here. The benefit is that changing skins or the background color never requires touching the shader: what shows through is always the real one.\n   * Bright areas are opaque, so colors that should be rich stay rich.\n   */\n  // uSeeThrough acts as a threshold: luminance below it is fully see-through, above it fully opaque.\n  // It used to be written as interpolation, and the darkest spots kept an opacity of (1-uSeeThrough), so dark areas were \"a layer laid over the background\" rather than the background itself\n  float a = uSeeThrough < 0.001 ? 1.0 : smoothstep(0.0, uSeeThrough, lum);\n  // Then fade out along the right edge (basically has no effect when uFadeEdge=0): works with the line above to make the \"right side is the background color\" layout\n  if (uFadeEdge > 0.001) a *= 1.0 - smoothstep(1.0 - uFadeEdge, 1.0, uv.x);\n\n  // Premultiplied output: color is multiplied by alpha first (the context is opened in premultiplied mode).\n  // Straight alpha gets drawn as opaque on the GPU compositing path (the bug the user reported on 2026-10-24)\n  float aOut = clamp(a, 0.0, 1.0);\n  vec3 rgbOut = max(col, 0.0);\n  // The flatten path: composite the background color in and set alpha to 1. Prerendering to video must take this path: video cannot carry alpha,\n  // and the export writes straight-alpha PNGs, so storing premultiplied values directly as straight would leave a ring of red-green fringes on the fade-out edge.\n  fragColor = uFlatten > 0.5\n    ? vec4(mix(uBg, rgbOut, aOut), 1.0)\n    : vec4(rgbOut * aOut, aOut);\n}");

/** 十六进制 → 0..1 的 RGB */
function hexToRgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** 把一个 CSS 变量解析成 0..1 的 RGB。读不到就用兜底 —— 变量可能是 color-mix(),所以让浏览器自己算 */
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
    // 编译不过就退回 CSS 那一版;把原因留在控制台,不然只看到一块兜底背景没法查。
    // 开发期有一个常见原因:改这个文件触发热更新会反复重挂组件,每次新建一个 WebGL 上下文,
    // 用满浏览器的上限(Chrome 约 16 个)之后新上下文一建就是坏的 —— 这时日志会是 null。
    // 整页刷新一下就好,不是着色器写错了。
    console.warn(
      "[BrandCanvas] shader compile failed:",
      gl.getShaderInfoLog(sh),
      "gl.getError=", gl.getError(),
      "(in development, if the log is null, the WebGL context limit was most likely exceeded by accumulated hot reloads; refresh the whole page)",
    );
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function BrandCanvas(): JSX.Element {
  const host = useRef<HTMLCanvasElement>(null);
  /** 起不来就退回 CSS 那一版 */
  const [dead, setDead] = useState(false);

  useEffect(() => {
    const canvas = host.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", {
      // 要透出页面底色,所以画布必须带 alpha。
      // **用预乘 alpha（默认那条路）**:2026-10-24 用户报「登录界面背景的 alpha 显示失败」,
      // 用系统截图核实 —— 屏幕上这块是**完全不透明**的青橙渐变,而经 CDP 回读截到的却是正常的半透明烟雾。
      // 两条路不同:回读走 CPU、按直通 alpha 算得对;屏幕走 GPU 合成,`premultipliedAlpha: false`
      // 在这条路上没被正确处理,RGB 被按满强度画了出来。预乘是浏览器的默认、也是所有合成器都稳的那条路,
      // 代价只是着色器里自己把颜色乘上 alpha(见片元着色器末尾)。
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
      // 之后要截这一帧烘成静态图,不保留就读不到像素
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
      console.warn("[BrandCanvas] shader link failed:", gl.getProgramInfoLog(prog));
      setDead(true);
      return;
    }
    gl.useProgram(prog);

    const at = (n: string) => gl.getUniformLocation(prog, n);
    const uRes = at("uRes");
    const uLoop = at("uLoop");
    const uCool = at("uCool");
    const uPxScale = at("uPxScale");

    // 一次性的那些:画面参数不随帧变,设一遍就够
    gl.uniform3f(at("uWarm"), ...hexToRgb(LOOK.warm, [0.886, 0.451, 0.122]));
    gl.uniform1f(at("uFlatten"), 0);   // 屏幕上这一版要半透明,不压平
    gl.uniform3f(at("uBg"), 0, 0, 0);  // 不压平时用不到,传个值免得驱动抱怨
    gl.uniform1f(at("uSwirl"), LOOK.swirl);
    gl.uniform1f(at("uScale"), LOOK.scale);
    gl.uniform1f(at("uYStretch"), LOOK.yStretch);
    gl.uniform1f(at("uSplit"), LOOK.split);
    gl.uniform1f(at("uFalloff"), LOOK.falloff);
    gl.uniform1f(at("uBlend"), LOOK.blend);
    gl.uniform1f(at("uMixWarp"), LOOK.mixWarp);
    gl.uniform1f(at("uAxis"), LOOK.axis);
    gl.uniform1f(at("uSeeThrough"), LOOK.seeThrough);
    gl.uniform1f(at("uFadeEdge"), LOOK.fadeEdge);
    gl.uniform1f(at("uRefPx"), LOOK.refPx);
    gl.uniform1f(at("uStreak"), LOOK.streak);
    gl.uniform1f(at("uGrain"), LOOK.grain);
    gl.uniform1f(at("uWarpA"), LOOK.warpA);
    gl.uniform1f(at("uWarpB"), LOOK.warpB);
    gl.uniform1f(at("uGamma"), LOOK.gamma);
    gl.uniform1f(at("uGain"), LOOK.gain);
    gl.uniform1f(at("uFloor"), LOOK.floor);
    gl.uniform1f(at("uRoll"), LOOK.roll);
    gl.uniform1f(at("uSat"), LOOK.sat);
    gl.uniform1f(at("uStripeN"), LOOK.stripeN);
    gl.uniform1f(at("uStripeSkew"), LOOK.stripeSkew);
    gl.uniform1f(at("uFrostBlur"), LOOK.frostBlur);
    gl.uniform1f(at("uFrost"), LOOK.frost);
    gl.uniform1f(at("uMilky"), LOOK.milky);
    gl.uniform1f(at("uEdge"), LOOK.edge);
    gl.uniform1f(at("uGrainSize"), LOOK.grainSize);
    gl.uniform1f(at("uGrainJitter"), LOOK.grainJitter);
    gl.uniform1f(at("uGrainSoft"), LOOK.grainSoft);

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let raf = 0;
    let visible = true;
    let frames = 0;
    const started = performance.now();

    const resize = () => {
      const box = canvas.getBoundingClientRect();
      const s = Math.min(window.devicePixelRatio || 1, 1.5) * LOOK.resScale;
      const w = Math.max(2, Math.round(box.width * s));
      const h = Math.max(2, Math.round(box.height * s));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, canvas.width, canvas.height);
      // 内部像素 / CSS 像素:着色器拿它把坐标换算回 CSS 像素,纹理和颗粒才不会在高分屏上变细
      gl.uniform1f(uPxScale, s);
    };

    const draw = () => {
      resize();
      // 换皮肤、改强调色都要跟着变。每半秒重读一次就够,不必每帧都读
      // 冷侧:LOOK.cool 填了就用填的,没填就跟着主题色走(每半秒重读一次,换皮肤会变)
      if (frames % 30 === 0) {
        gl.uniform3f(uCool, ...(LOOK.cool ? hexToRgb(LOOK.cool, LOOK.coolFallback) : readColor("--ui-accent", LOOK.coolFallback)));
      }
      // 相位取小数部分:走满一圈回到 0,屏幕上这一版也就跟着无缝接上了
      const secs = (performance.now() - started) / 1000;
      gl.uniform1f(uLoop, still ? 0 : (secs / LOOK.loopSeconds) % 1);
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
      if (raf === 0 && visible && !document.hidden && !still) raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    draw(); // 先画一帧:还没进视野、或者关了动画,至少有画面
    if (!still) start();

    // 滚出视野、切到后台就停:登录页在后台标签里不该一直占着 GPU
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      if (visible) start();
      else stop();
    });
    io.observe(canvas);

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);

    const ro = new ResizeObserver(() => {
      draw();
      start();
    });
    ro.observe(canvas);

    // 显卡驱动重置、切换独显集显都会丢上下文;丢了就退回 CSS 那一版,别留一块黑的
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

  if (dead) return <BrandAurora />;
  return <canvas ref={host} className="ps-brand-canvas" data-pc="start-brand-canvas" aria-hidden="true" />;
}

/*
 * 烘成不用实时渲染的版本(用户说审核过了就做)。
 *
 * **只烘与颜色无关的那一层**,颜色仍由 `--ui-accent` 在运行时染上去 —— 这一条是硬的:
 * 用户换皮肤、在设置里改强调色,这一块必须跟着变(`src/skins/` 十套皮肤 × 深浅)。整张焗死的图
 * 换了皮肤就对不上。做法:
 *   1. 把着色器改成只输出**亮度与结构**(f、frost、band、暗角那几项合成一个单通道),不乘颜色;
 *   2. 按目标尺寸渲一帧(或一个循环)存成单通道的 WebP / AVIF,或者 H.264 / VP9 的灰度视频;
 *   3. 页面上拿它当遮罩:一个铺着 `--ui-accent` → 琥珀渐变的层,用 `mask-image`(或 `-webkit-mask`)
 *      套这张灰度图。换皮肤只换渐变那一层,遮罩不用重烘。
 *
 * 循环要无缝:现在时间是一直往前走的,**不能直接首尾相接**。要循环得把时间维换成在圆上转
 * (噪声的时间参数取 `cos/sin` 两路),或者两段交叉淡入。
 *
 * 真要「整张连颜色一起烘死」(比如要的就是参考海报那个特定配色,不跟皮肤走),那是另一个决定,
 * 得先问用户 —— 代价就是换皮肤这一块不跟着变。
 */

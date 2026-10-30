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
export const VERT = `#version 300 es
void main() {
  // 一个盖住整屏的三角形:不用顶点缓冲,靠顶点号算坐标
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  uRes;
/* 噪声域里那个圆的半径(噪声单位)。0 = 完全不动 */
uniform float uSwirl;
/* 循环相位,0→1 走满一圈。走满正好回到起点,所以第 0 帧和第 N 帧逐字节相同 */
uniform float uLoop;
uniform vec3  uCool;
uniform vec3  uWarm;
uniform float uScale, uYStretch, uSplit, uFalloff, uBlend, uMixWarp, uStreak, uGrain;
uniform float uAxis, uSeeThrough, uFadeEdge;
uniform float uRefPx, uPxScale;
/* 压平:预渲染成视频时置 1。视频带不了 alpha,要把底色先合进来、输出不透明;屏幕上那一版置 0,照旧出预乘的半透明 */
uniform float uFlatten;
/* 压平时垫在底下的颜色(登录页的 --bg-canvas) */
uniform vec3  uBg;
uniform float uWarpA, uWarpB, uGamma, uGain, uFloor, uRoll, uSat;
uniform float uStripeN, uStripeSkew, uFrostBlur, uFrost, uMilky, uEdge;
uniform float uGrainSize, uGrainJitter, uGrainSoft;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/**
 * 颗粒用的噪声:**插值**过的,不是 floor 出来的方格。
 *
 * floor + hash 每一格是一个常数、边界上直接跳变,看着就是马赛克(用户 2026-10-23 指出)。
 * vnoise 里四角哈希按 smoothstep 插值,所以格子之间是连成一片的。
 * uGrainSoft > 0 时再做一次 5 点平均(上下左右加中心),相当于一道很轻的高斯,
 * 把颗粒进一步揉软;等于 0 就只有插值那一层。
 */
float grainNoise(vec2 c, float soft) {
  float n = vnoise(c);
  if (soft > 0.001) {
    float d = soft * 0.5;
    n = (n + vnoise(c + vec2(d, 0.0)) + vnoise(c - vec2(d, 0.0))
           + vnoise(c + vec2(0.0, d)) + vnoise(c - vec2(0.0, d))) * 0.2;
  }
  return n;
}

float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;

  /*
   * 纹理锚在**屏幕像素**上,不随这一块的大小缩放(用户 2026-10-23 定):
   * 窗口拉宽拉高只是「露出更多」,不是把同一张图拉长。
   *
   * 原点取 split 那条线(构图的骨架)和纵向中线 —— 所以不管这一块多宽,冷暖交界附近的纹理
   * 永远是同一副样子,变化只发生在两头。
   *
   * 先把 gl_FragCoord 换算回 CSS 像素(内部渲染按 uPxScale 打了折),这样纹理的粗细
   * 在高分屏和普通屏上一致;uRefPx 是参考尺寸,改它等于整体放大缩小。
   */
  vec2 cssPx = gl_FragCoord.xy / max(0.0001, uPxScale);
  vec2 anchor = vec2(uSplit * uRes.x, 0.5 * uRes.y) / max(0.0001, uPxScale);
  vec2 p = (cssPx - anchor) / max(1.0, uRefPx) * uScale;
  p.y *= uYStretch;
  /*
   * 时间在噪声域里**走一个闭合的圈**,不是一直往前漂。
   *
   * 为什么改(2026-10-24 用户定「左侧为渲染器经过预渲染的动画」):预渲染出来的是一段有限长的视频,
   * 要能无缝循环播。原来四项都是 p + t * k 这种一直往前的平移,时间轴上不闭合,
   * 截一段来循环会在接缝处跳一下。现在每一项的偏移都是 uLoop 的周期函数,
   * uLoop 从 0 走到 1 正好回到出发点 —— 第 0 帧和第 N 帧算出来逐字节相同,接缝看不出来。
   *
   * 路径不是正圆,是一圈套一圈(基频 + 二次谐波):正圆走起来像在原地打转,一眼能看出是循环;
   * 叠一个二次谐波之后轨迹是条卷曲的闭合曲线,走的路更长、更不像在转圈,而周期还是 1。
   * 四项各给不同的相位与转向,免得四层一起动。
   * 每一项都减去 loopAng = 0 时的值,所以 uLoop = 0 这一帧和改之前那一帧完全一样 —— 调参台上的那组数照旧能用。
   * (变量叫 loopAng 不叫 a:这段着色器里已经有两个 a 了 —— 166 行噪声的四角之一、323 行的透明度。叫 a 会 ERROR: a : redefinition,整段编不过、当场退回 CSS 那一版。)
   */
  float loopAng = 6.2831853 * uLoop;
  #define LOOPV(ph, dir, amp) (uSwirl * (amp) * (       vec2(sin(loopAng * (dir) + (ph)) - sin(ph), cos(loopAng * (dir) + (ph)) - cos(ph))     + vec2(sin(loopAng * 2.0 * (dir) + (ph)) - sin(ph), cos(loopAng * 2.0 * (dir) + (ph)) - cos(ph)) * 0.45))

  // 域扭曲两道:第一道把坐标推开,第二道拿推开的结果再推一次。
  // 参考图里那种「被搅过」的层次就是这么来的,一层噪声出不来
  vec2 q = vec2(fbm(p + LOOPV(0.0, 1.0, 1.0)), fbm(p + vec2(5.2, 1.3) + LOOPV(2.1, -1.0, 0.7)));
  vec2 r = vec2(fbm(p + uWarpA * q + vec2(1.7, 9.2) + LOOPV(4.0, 1.0, 0.5)),
                fbm(p + uWarpA * q + vec2(8.3, 2.8) + LOOPV(5.6, -1.0, 0.4)));
  // 条纹毛玻璃:一道道斜条里,底下的纹理被「磨」过 —— 少一层细节、还被横向推开一点,
  // 就像隔着磨砂玻璃看;条与条之间是清的。这是上一版那层 backdrop-filter 条纹磨砂在着色器里的等价做法
  // (用户点名要的就是「流动的极光 + 条纹毛玻璃 + 噪点」这三样,不能只剩前后两样)
  // 条纹的轮廓用 sin,不用 fract:fract 到头会跳回 0,每条接缝处断一下,看着就是百叶窗
  float phase = (uv.x * uStripeN + uv.y * uStripeSkew) * 6.2831853;
  float frost = smoothstep(-0.85, 0.85, sin(phase));
  vec2 pw = p + uWarpB * r;

  /*
   * 磨砂条:把背后的像**横向抹开**(取四个横向邻样平均) —— 玻璃干的就是这件事。
   *
   * 前两版都想岔了:一版拿另一个尺度的噪声去混(那是重影),一版把细节层抽掉(那是降采样)。
   * 底图在 scale≈0.9 下本来就很平滑,没多少细节可抽,抽完只剩一条条平板,看着就是百叶窗。
   * 清条的半径是 0,四个样本落在同一点、结果等于原图,所以条与条之间是连续的,不会有接缝。
   */
  /*
   * 颗粒:**不随时间变**。玻璃是一块不动的东西,它表面的颗粒当然也不动 ——
   * 原来那套每帧重算(hash 里带了时间),看着就是满屏闪(用户 2026-10-23 指出)。
   * 粗粒靠把屏幕坐标按 uGrainSize 量化:一格一个随机数,格子越大颗粒越粗。
   */
  // 颗粒同样按 CSS 像素算,不然高分屏上会变细
  vec2 gco = cssPx / max(1.0, uGrainSize);
  float gn1 = grainNoise(gco, uGrainSoft);
  float gn2 = grainNoise(gco + 71.3, uGrainSoft);

  float br = frost * uFrost * uFrostBlur;
  /*
   * 磨砂的「扰动」:每一粒按自己的随机方向再偏一点去取样 —— 磨砂玻璃就是靠表面微小的凹凸
   * 把光打散的,所以颗粒要**参与折射**,而不是事后往画面上撒一层。
   * 偏移乘 br:清条上 br=0,颗粒不起作用,清的地方依旧清楚。
   */
  vec2 jit = vec2(gn1 - 0.5, gn2 - 0.5) * br * uGrainJitter;
  float f = (fbm(pw + jit + vec2(-1.5 * br, 0.0)) + fbm(pw + jit + vec2(-0.5 * br, 0.0))
           + fbm(pw + jit + vec2(0.5 * br, 0.0)) + fbm(pw + jit + vec2(1.5 * br, 0.0))) * 0.25;

  // 冷暖的分界大体是一条竖线,只让噪声轻轻推一下 —— 推多了两边就互相咬进去,
  // 参考图是「左冷右暖、中间一道暗」,不是搅在一起
  // 分色沿哪个方向:uAxis=0 横着分(左冷右暖),=1 竖着分(上冷下暖)。
  // 竖着分时用 1-uv.y,让「上面」是冷色
  float axisC = mix(uv.x, 1.0 - uv.y, clamp(uAxis, 0.0, 1.0));
  // 分界被噪声推着走:uMixWarp 越大,两色互相咬合得越深
  float split = uSplit + (r.x - 0.5) * uMixWarp;
  // 过渡带的半宽:uBlend 从「一条硬边」一路开到「整块都在过渡」
  float halfW = mix(0.02, 0.85, clamp(uBlend, 0.0, 1.0));
  float m = smoothstep(split - halfW, split + halfW, axisC);

  // 中间那片深色**不是画上去的**:两种光各自从自己那一侧往外衰减,中间谁都不强,
  // 加起来就暗、而且去饱和 —— 参考图里蓝和橘黄混成深色就是这么来的(用户 2026-10-23 指出)。
  // uFalloff 越大中间掉得越狠;等于 1 就退化成普通插值,中间不会暗
  float wc = pow(clamp(1.0 - m, 0.0, 1.0), uFalloff);
  float ww = pow(clamp(m, 0.0, 1.0), uFalloff);
  vec3 base = uCool * wc + uWarm * ww;

  // 明暗:暗部压得很狠,所以大部分地方接近黑,颜色只在几处亮起来 —— 这是参考图的分量感
  float lum = pow(clamp(f * 1.18, 0.0, 1.0), uGamma);
  vec3 col = base * (uFloor + uGain * lum);
  // 高光滚落:直接乘出来的亮部会冲成霓虹,这一步把它压回去
  col = col / (1.0 + col * uRoll);
  // 饱和度微调
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, uSat);

  // 玻璃的两样:磨砂面本身是乳白的(散射抬一点亮),清条与磨砂条交界处有一道细高光(玻璃的棱)
  col *= 1.0 + frost * uMilky;
  float edge = 1.0 - abs(frost * 2.0 - 1.0);
  col += pow(edge, 3.0) * uEdge;

  // 细竖条纹:按列取一个固定的随机数,越往右越明显(参考海报右半边那些细线)
  float band = hash12(vec2(floor(uv.x * 240.0), 7.0));
  col *= 1.0 + (band - 0.5) * uStreak * smoothstep(0.18, 0.9, uv.x);

  // 暗角
  vec2 d = (uv - 0.5) * vec2(1.08, 1.0);
  col *= 0.30 + 0.70 * smoothstep(1.15, 0.18, length(d));

  // 叠加的那一层颗粒同样不动,而且磨砂条上更明显 —— 它是玻璃的一部分,不是蒙在画面上的胶片颗粒
  col += (gn1 - 0.5) * uGrain * (0.3 + 0.7 * frost);

  /*
   * 背景以 alpha 的形式进来(用户 2026-10-23 定):暗的地方把画布放透明,透出页面真实的底色,
   * 而不是在这里画一层假的背景色。好处是换皮肤、改底色都不用动着色器 —— 透出来的永远是真的那个。
   * 亮的地方不透,所以颜色该浓的地方照样浓。
   */
  // uSeeThrough 当门槛用:亮度低于它就一路透到底,高于它完全不透。
  // 原来写成插值,最暗处仍留着 (1-uSeeThrough) 的不透明度,于是暗处是「背景上蒙了一层」而不是背景本身
  float a = uSeeThrough < 0.001 ? 1.0 : smoothstep(0.0, uSeeThrough, lum);
  // 再沿右边缘淡出(uFadeEdge=0 时基本不起作用):配合上面那条做「右侧是背景色」的格局
  if (uFadeEdge > 0.001) a *= 1.0 - smoothstep(1.0 - uFadeEdge, 1.0, uv.x);

  // 预乘输出:颜色先乘上 alpha(上下文开的是预乘模式)。
  // 直通 alpha 在 GPU 合成那条路上会被当成不透明画出来(2026-10-24 用户报的那个毛病)
  float aOut = clamp(a, 0.0, 1.0);
  vec3 rgbOut = max(col, 0.0);
  // 压平那条路:把底色合进来、alpha 给 1。预渲染成视频要走这条 —— 视频带不了 alpha,
  // 而且导出写的是直通 alpha 的 PNG,预乘的值直接当直通存会在淡出边缘出一圈红绿杂边。
  fragColor = uFlatten > 0.5
    ? vec4(mix(uBg, rgbOut, aOut), 1.0)
    : vec4(rgbOut * aOut, aOut);
}`;

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
      "[BrandCanvas] 着色器编译失败：",
      gl.getShaderInfoLog(sh),
      "gl.getError=", gl.getError(),
      "（开发期若日志为 null，多半是热更新累积的 WebGL 上下文超了上限，整页刷新即可）",
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
      console.warn("[BrandCanvas] 着色器链接失败：", gl.getProgramInfoLog(prog));
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

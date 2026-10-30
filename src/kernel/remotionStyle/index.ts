/**
 * remotion 式的框架（`docs/plan/render-standard.md`「还要做的」第 3 条）。
 *
 * remotion 式的卡（`frameMode: "direct"`）：这一帧的画面只由时间 t、参数和输入素材决定，跳到任意一帧都是直接算。
 * 这类卡只用这里的工具写。这里的每一个都是「时间 t 和参数 → 值」的纯函数：
 *
 *   按时间插值      interpolate、interpolateColors、clamp、lerp、loop、pingPong
 *   带缓动的过渡    tween、Easing
 *   弹簧            spring、springDuration        （解析解，直接算第 N 帧，不用从头推）
 *   错开进场        stagger、staggerDuration
 *   带种子的随机    random、randomRange、randomInt、randomPick、noise   （按种子和序号直接算，和调用先后无关）
 *
 * 这里**没有**能把东西从一帧带到下一帧的工具（没有可写的存储、没有计数器、没有「上一次的值」），
 * 守门测试 `remotionStyle.test.mjs` 钉着。载入时锁只读的 `lockTopLevel` 在 `./lock.ts`，由载入用户卡的地方接上，卡片不直接引。
 *
 * 用法（用户卡在 `src/cards/user/` 下）：
 *   import { interpolate, spring, stagger, random, Easing } from "./";
 */
export { Easing, type EasingFn } from "./easing.ts";
export {
  clamp, lerp, interpolate, interpolateColors, tween, loop, pingPong,
  type Extrapolate, type InterpolateOptions, type TweenOptions,
} from "./interpolate.ts";
export { spring, springDuration, type SpringConfig } from "./spring.ts";
export { stagger, staggerDuration, type StaggerOptions } from "./stagger.ts";
export { random, randomRange, randomInt, randomPick, noise, type RandomKey } from "./random.ts";

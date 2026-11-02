/**
 * remotion-style framework (`docs/plan/render-standard.md`, "Still to do", item 3).
 *
 * remotion-style cards (`frameMode: "direct"`): the picture of a frame is determined only by the time
 * t, the parameters and the input assets, and jumping to any frame is computed directly.
 * Cards of this kind are written using only the tools here. Each of them is a pure function of
 * "time t and parameters → value":
 *
 *   Interpolate over time    interpolate, interpolateColors, clamp, lerp, loop, pingPong
 *   Eased transitions        tween, Easing
 *   Springs                  spring, springDuration
 *                            (closed-form solution: computes frame N directly, no stepping from the start)
 *   Staggered entrances      stagger, staggerDuration
 *   Seeded randomness        random, randomRange, randomInt, randomPick, noise
 *                            (computed directly from seed and index, independent of call order)
 *
 * There are **no** tools here that can carry anything from one frame to the next (no writable storage,
 * no counters, no "previous value"); the gatekeeper test `remotionStyle.test.mjs` pins this down. The
 * `lockTopLevel` that locks things read-only at load time is in `./lock.ts`; it is hooked up where
 * user cards are loaded, and cards do not import it directly.
 *
 * Usage (user cards live under `src/cards/user/`):
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

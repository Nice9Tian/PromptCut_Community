# PromptCut card authoring rules

These rules are obtained through the `card_authoring_guide` tool. **You must read them before calling `create_card`**; do not write from memory.

## 0. Do not rush to create a card

Creating a new card is the last resort, for these reasons:

- Existing cards have already been tuned for layout, motion pacing and theme adaptation, so using them directly works better;
- Every additional card adds a bit more noise to future card selection.

So take these three steps first:

1. `list_cards()`: get the summaries of all cards, and focus on each card's `useWhen` (when it should be chosen) and `tags`.
2. After finding a candidate, `list_cards({ cardId })`: get the card's complete `controls` and `defaults`, and confirm the parameters are sufficient.
3. Only when you have confirmed that **no card can meet the need by adjusting parameters** do you `create_card`.

"The color is wrong", "the copy needs changing" and "the position needs moving" are all matters of adjusting parameters; do not create a new card for them.

### 0.1 Structure of the film

A card is **one reusable visual subject or graphic beat**, never an entire multi-scene film, multi-room walkthrough, or camera rig:

- **Never put multiple scenes, rooms, chapters, or shots into one card**, and **never hardcode a camera keyframe array (`CAM_KEYS`, `CAMERA_PATH`, `SCENES`, `SHOTS`) inside a card's TSX source**. `create_card` checks for monolith schedules and embedded camera rigs and rejects them on the spot.
- Instead, build the film's structure on the timeline:
  1. Place each visual board, title, chart, or video/image media item as **its own clip** on a `"2d"` or `"3d"` cut (`add_cut({ kind: "3d" })`, `add_clip`, `set_position` with numbers or `t`/`d`/`p` `frameExpr` expressions).
  2. Drive continuous one-take camera motion on the cut's dedicated **camera lane** with `add_camera` / `update_camera` (`x, y, zoom, rotate` on 2D cuts; `x, y, z, rx, ry, rz, fovDeg` on 3D cuts, each accepting numbers or `t`/`d`/`p` expressions).
  3. Keep screen-locked captions (`caption-track`) and 2D HUD overlays in a `"2d"` cut (and embed `"3d"` cuts inside it via `add_cut_segment`, or pre-render a `"3d"` cut to an `.mp4` asset in a new `"2d"` cut via `prerender_cut_to_2d`).
  4. Pre-overlay cards (`overlay: "pre"`) only attach to true 3D scene hosts (`scene-3d` or a `"3d"` cut segment); `apply_card` rejects attaching a pre-overlay to an ordinary DOM card or media clip.

## 1. Two styles: pick one before creating a card

Every PromptCut card picks one of two styles (motion graphics cards and media effect cards alike); **both are official styles and neither is recommended over the other**, so choose according to what the picture needs. Whichever you choose, write `frameMode` as the corresponding literal in the card definition object (the exported `CardDef`; see section 4.1 for its fields). **`frameMode` is required**: leaving it out when creating the card is rejected, and writing it as a variable or a computed value is also rejected (the card creation check must read directly from the source which one you chose).

| | remotion-style | motion-style |
|---|---|---|
| Declaration | `frameMode: "direct"` | `frameMode: "stateful"` |
| How the picture is obtained | Computed only from time `t`, the parameters and the input media; jumping to any frame is computed directly, at the same cost | Stateful: it must advance frame by frame from the clip start to reach the target frame |
| How to write it | Use only react, PromptCut's built-in remotion-style framework (`interpolate`, `tween`, `spring`, `stagger`, `random` and so on) and the modules on the list in section 2.5. **There must be an import that references the framework**: cards that are pure arithmetic or GLSL (media effect cards) also declare `"direct"`, and if you use none of the tools, write a bare import line `import "../../kernel/remotionStyle";`. Section 2 | You can use Motion animations, springs, `AnimatePresence`, CSS animation, `lottie-web`, particles and three, and you may also accumulate state yourself. A card that uses a library outside the list in section 2.5 (three, a directly imported `lottie-web` and the like) also declares `"stateful"`, and it is not required to actually accumulate state. To place a Lottie animation you do not need to import `lottie-web` yourself: use the ready-made `lottie` card, which is a built-in remotion-style card. Section 3 |
| Suitable for | A picture that can be written as "a function of t": title and caption entrances and exits, numbers and bar charts, a batch of elements laid out by a seed, graphics whose positions are computed by formula on a canvas | When you want to use ready-made Motion or CSS animation without writing the curves yourself; effects such as particles and physics simulation where each frame depends on the previous one; when you want to use three |
| Cost | You can only use the tools in the framework, and anything written outside the framework is rejected on the spot when the card is created (section 2.4); springs, easing and staggered entrances must use the framework's own | When paused or scrubbed to the middle of a clip, it has to advance again from the clip start to that frame, and the longer the clip the slower; prerender has to store a snapshot of every frame for it |
| Check at card creation | Strict, pointing out line by line which line fails | Hard constraints and general compliance: required fields, dependencies that are not installed, animation classes that are not defined, source and license, and so on (sections 6 and 8) |

- Which style a card belongs to is decided **only by its `frameMode` declaration**; the software will not judge it for you. Writing `"direct"` is a guarantee that "this frame's picture is determined only by t, the parameters and the input media", and the card creation check inspects your source against that guarantee.
- There are only these two literals: `"direct"` and `"stateful"`. The old values `"react"` and `"non-react"` that can be found in old projects are **both read as motion-style** (old cards need not be rewritten), and new cards must not write them any more.
- Media effect cards (filters, transitions, emphasis, audio; section 4.3) must also write `frameMode`: those that use only `at()` + GLSL write `"direct"`, and those that use `pixels()` or carry their own state write `"stateful"`. Those that write `"direct"` must likewise reference the framework, and if they use none of the tools, write a bare import line (section 2.4).
- For a picture that can be written either way (for example a title fading in while moving up): the difference is exactly the "How to write it" and "Cost" rows of the table above. With remotion-style you write the curves yourself with the framework, and the cost is the same wherever you jump to; with motion-style you can use Motion's ready-made curves directly, at the cost that when paused or scrubbed to the middle of a clip it has to advance from the clip start. Which one to choose is up to you, based on the picture and ease of maintenance.
- The existing built-in cards include both styles, and none of them needs to be rewritten.

## 2. Writing remotion-style cards

**In one sentence: this frame's picture may be computed only from time t, the parameters and the input media.** Do not read anything left over from the previous frame, do not read real time, do not use animation that carries its own clock, and do not use unseeded random numbers.

Declaration: `frameMode: "direct"`. Time `t` is the clip-local **seconds** the component receives (counted from the clip start, not a frame number); write `{ params, t = 0 }` in the component signature. Exception: for a card that also writes `audio()`, the `t` it receives already includes the part trimmed off the start of the clip (`sourceOffset`); for a clip that has not been trimmed the two are the same, see section 10.

### 2.1 The framework

The framework lives in `src/kernel/remotionStyle/`; a user card imports it like this:

```ts
import { interpolate, tween, spring, stagger, random, Easing } from "../../kernel/remotionStyle";
```

They are all pure functions of "time t and parameters → value"; they do not read a clock or remember the previous result, and the same input always gives the same output. **Time is always in seconds.**

| Tool | Usage | Returns | Example |
|---|---|---|---|
| `interpolate` | `interpolate(t, times[], values[], { easing?, extrapolateLeft?, extrapolateRight? })`. There must be at least two times, each larger than the last, and the number of values must match, otherwise it throws an error. `easing` takes one curve, or one per segment (an array); the default is constant speed. `extrapolateLeft` / `extrapolateRight` have only two values: `"clamp"` (the default, stays at the endpoint) and `"extend"` (extends along the slope of the outermost segment) | A number | `interpolate(t, [0, 0.4], [0, 1])`: goes from 0 to 1 within 0.4 seconds, then stays at 1 |
| `interpolateColors` | `interpolateColors(t, times[], colors[], same as above)`. Colors accept `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` | `"rgba(r, g, b, a)"` | `interpolateColors(t, [0, 1], ["#ff0000", "#0000ff"])` |
| `tween` | `tween(t, { from = 0, to = 1, delay = 0, duration, easing = Easing.easeOut })`. `duration` has no default and must be written; when `duration` is not greater than 0 there is no transition, and once `t` reaches `delay` the value is `to` | A number; `from` before the start, `to` once finished | `tween(t, { from: 40, to: 0, delay: 0.2, duration: 0.5 })` |
| `Easing` | `linear` `quad` `cubic` `quart` `sin` `circ` `expo` `bounce`; `back(overshoot)` `elastic(bounciness)`; `in(e)` `out(e)` `inOut(e)`; `bezier(x1, y1, x2, y2)`; `steps(n, atEnd)`; the ready-made `easeIn` `easeOut` `easeInOut` (cubic curves); four aliases: `circle` (same as `circ`), `exp` (same as `expo`), `ease` (Bezier `(0.42, 0, 1, 1)`, slow start, not one of those three cubic curves), `poly(n)` (the n-th power of progress; `poly(4)` equals `quart`) | An easing function `(p) => number` | `Easing.bezier(0.16, 1, 0.3, 1)`, `Easing.out(Easing.back(1.4))`. The base curves all have a "slow start" shape; for a "fast start" wrap one in `Easing.out(...)` |
| `spring` | `spring(t, { stiffness = 100, damping = 10, mass = 1, from = 0, to = 1, delay = 0, velocity = 0, clamp = false })`: the analytic solution of a damped oscillator, which computes the position directly from t without stepping from the beginning. The first parameter is clip-local seconds, unlike Remotion's `spring({ frame, fps, config })`: if the first parameter is not a number, or `frame` `fps` `config` appear in the second parameter, it reports an error immediately | The position at second t; `from` before `delay`; `clamp: true` does not allow it to pass the end point | `spring(t, { from: 0.6, to: 1, stiffness: 180, damping: 12 })` |
| `springDuration` | `springDuration(same parameters, restRatio = 0.001)` | Seconds to come to rest (including `delay`) | `springDuration({ stiffness: 180, damping: 12 })` gives about 1.17 |
| `stagger` | `stagger(t, index, { each, delay = 0, from = "first", count })`; `from` can be `"first"`, `"last"`, `"center"` or an index; `last` and `center` also need `count` | Local time of the index-th element (negative until its turn comes) | `tween(stagger(t, i, { each: 0.08 }), { duration: 0.4 })` |
| `staggerDuration` | `staggerDuration(count, same stagger parameters, duration of a single element = 0)`; the `delay` in those parameters also counts toward the total duration | Seconds for the whole group to finish | `staggerDuration(5, { each: 0.08 }, 0.4)` = 0.72 |
| `random` | `random(seed, ...index)`, seed and index are numbers or strings; **a seed is required** | [0, 1) | `random(params.seed, i)`; for a second, unrelated number add one more index: `random(params.seed, i, "hue")` |
| `randomRange` | `randomRange(min, max, seed, ...index)` | [min, max) | `randomRange(-20, 20, params.seed, i)` |
| `randomInt` | `randomInt(min, max, seed, ...index)` | Integer, both ends inclusive | `randomInt(1, 6, params.seed, i)` |
| `randomPick` | `randomPick(array, seed, ...index)` | One item from the array | `randomPick(["#f43", "#3af"], params.seed, i)` |
| `noise` | `noise(x, seed, ...index)` | −1 to 1, rises and falls smoothly with x; a function of x, not accumulated step by step | `noise(t * 2, params.seed, i) * 12`: "keeps swaying gently" |
| `clamp` `lerp` `loop` `pingPong` | `clamp(x, lo = 0, hi = 1)`, `lerp(a, b, p)`, `loop(t, period)`, `pingPong(t, period)` | A number. `loop` returns [0, period), `pingPong` returns [0, period] | `loop(t, 2)` runs from the start every 2 seconds; `pingPong(t, 1)` goes back and forth 0 → 1 → 0 |

The names match the same-named tools in the Remotion library, but two things differ, so do not write from memory:

- **Time is in seconds, not frames.** There is no `fps` and no `useCurrentFrame`; `delay`, `duration` and time points are all in seconds.
- **Outside its range, `interpolate` holds the endpoint value by default** (Remotion keeps extending by default). To extend, write `{ extrapolateLeft: "extend", extrapolateRight: "extend" }`.

Other conventions:

- **Always use the `random` family for randomness, and give a seed and an index.** Put the seed in the parameters (make `seed` a `number` control), and give each random thing its own index (an array index, or something like `i, "hue"`), so the number that frame N gets does not depend on how many calls came before.
- **For "keeps moving", use `loop`, `pingPong` or `noise`, and do not accumulate values yourself.** They are all functions of t.
- **Which values become parameters** (consistent with section 5): values that the user (a user or an Agent) would ask to change with "a bit faster, a bit bigger, change the color" go into `controls` / `defaults` (see sections 4.2 and 5); the card's own design constants (the shape of an easing curve, a spring's stiffness and damping, the distance the card moves up on entrance) can be written as named `const` declarations at the top of the file (`POP` and `LINE_EASE` in Example 1). Write only constants at module top level. The check does not enforce this; it just makes later changes easier.
- `lifecycle.settleMs` is in milliseconds, counted from the clip start (not a duration); the settle time can be computed in seconds with `springDuration` or `staggerDuration` and multiplied by 1000, and cards whose parameters can change put it in `timing` (both Example 1 and Example 2 have it).

### 2.2 Examples

The three below are all complete cards that can be created as they are (replace `id` with your own). When writing a remotion-style card, you can start directly from them.

**Example 1: a title that pops in character by character** (spring, staggered entrance, color transition, interpolation, `timing`)

```tsx complete card
import type { CardDef, CardProps } from "../../kernel/types";
import { Easing, interpolate, interpolateColors, spring, springDuration, stagger, staggerDuration, tween } from "../../kernel/remotionStyle";

interface Params { text: string; accent: string; size: number; each: number }

const POP = { stiffness: 180, damping: 14 };
const LINE_EASE = Easing.bezier(0.16, 1, 0.3, 1);

function TitleReveal({ params, t = 0 }: CardProps<Params>) {
  const chars = [...params.text];
  const lineStart = staggerDuration(chars.length, { each: params.each }, 0.2);
  const line = interpolate(t, [lineStart, lineStart + 0.6], [0, 1], { easing: LINE_EASE });
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", fontSize: params.size, fontWeight: 800 }}>
        {chars.map((ch, i) => {
          const local = stagger(t, i, { each: params.each });
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                whiteSpace: "pre",
                opacity: tween(local, { duration: 0.25 }),
                transform: `translateY(${spring(local, { ...POP, from: 80, to: 0 })}px) scale(${spring(local, { ...POP, from: 0.6, to: 1 })})`,
                color: interpolateColors(local, [0, 0.5], [params.accent, "#ffffff"]),
              }}
            >
              {ch}
            </span>
          );
        })}
      </div>
      <div style={{ marginTop: 24, height: 8, width: 720 * line, borderRadius: 4, background: params.accent, opacity: line }} />
    </div>
  );
}

export const titleReveal: CardDef<Params> = {
  id: "rs-title-reveal",
  name: "Character-by-character pop-in title",
  description: "The title pops up one character at a time, then an underline unfolds from the left",
  source: "user",
  useWhen: "Framework example: use when a single-line large title should appear character by character.",
  tags: ["title", "example"],
  frameMode: "direct",
  defaults: { text: "Computed directly from t", accent: "#ffd166", size: 132, each: 0.07 },
  controls: [
    { key: "text", label: "Text", type: "text" },
    { key: "accent", label: "Primary color", type: "color" },
    { key: "size", label: "Font size", type: "number", min: 24, max: 240, step: 4 },
    { key: "each", label: "Interval between characters (seconds)", type: "number", min: 0, max: 0.5, step: 0.01 },
  ],
  Component: TitleReveal,
  timing: (p) => ({ settleMs: Math.round((staggerDuration([...p.text].length, { each: p.each }, springDuration(POP)) + 0.8) * 1000) }),
  lifecycle: { settleMs: 2000, after: "hold", exit: ["fade"] },
};
```

**Example 2: random bar chart** (seeded randomness, staggered outward from the middle, `noise` fluctuation)

```tsx complete card
import type { CardDef, CardProps } from "../../kernel/types";
import { Easing, noise, randomPick, randomRange, stagger, staggerDuration, tween } from "../../kernel/remotionStyle";

interface Params { count: number; seed: number; accent: string }

const PALETTE = ["#ef476f", "#ffd166", "#06d6a0", "#118ab2"];
const GROW = Easing.out(Easing.back(1.4));

function BarRace({ params, t = 0 }: CardProps<Params>) {
  const count = Math.max(1, Math.min(24, Math.round(params.count)));
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 18, paddingBottom: 160, fontFamily: "sans-serif" }}>
      {Array.from({ length: count }, (_, i) => {
        const local = stagger(t, i, { each: 0.06, from: "center", count });
        const target = randomRange(180, 620, params.seed, i);
        const grown = tween(local, { duration: 0.7, easing: GROW });
        const sway = 1 + noise(t * 1.5, params.seed, i, "sway") * 0.04 * tween(local, { delay: 0.7, duration: 0.3 });
        const height = target * grown * sway;
        return (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <div style={{ color: "#ffffff", fontSize: 26, fontWeight: 700, opacity: tween(local, { delay: 0.3, duration: 0.3 }) }}>{Math.round(target * grown)}</div>
            <div style={{ width: 44, height, borderRadius: 8, background: i % 5 === 0 ? params.accent : randomPick(PALETTE, params.seed, i, "color") }} />
          </div>
        );
      })}
    </div>
  );
}

export const barRace: CardDef<Params> = {
  id: "rs-bar-race",
  name: "Random fluctuating bars",
  description: "A row of bars with random heights grows outward from the middle, then sways gently once fully grown",
  source: "user",
  useWhen: "Framework example: use when you need a set of seeded random bars.",
  tags: ["bars", "random", "example"],
  frameMode: "direct",
  defaults: { count: 14, seed: 7, accent: "#ffffff" },
  controls: [
    { key: "count", label: "Number of bars", type: "number", min: 1, max: 24, step: 1 },
    { key: "seed", label: "Random seed", type: "number", min: 0, max: 9999, step: 1 },
    { key: "accent", label: "Emphasis color", type: "color" },
  ],
  Component: BarRace,
  // The number of bars is adjustable and the moment the last bar finishes growing changes with it: compute the settle time from the count with staggerDuration (each bar takes 0.7 seconds to grow, plus 0.3 seconds for the sway to fade in)
  timing: (p) => ({ settleMs: Math.round(staggerDuration(Math.max(1, Math.min(24, Math.round(p.count))), { each: 0.06, from: "center" }, 1.0) * 1000) }),
  lifecycle: { settleMs: 1400, after: "evolve", exit: ["fade"] },
};
```

**Example 3: orbiting glowing dots on a canvas** (canvas cards: clear first on every frame, then redraw the whole canvas)

```tsx complete card
import { useLayoutEffect, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { interpolate, loop, noise, pingPong, random, randomRange, tween } from "../../kernel/remotionStyle";

interface Params { count: number; seed: number; color: string; speed: number }

const WIDTH = 1920;
const HEIGHT = 1080;

function OrbitCanvas({ params, t = 0 }: CardProps<Params>) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    // Redraw the whole canvas from blank on every frame: no pixels from the previous frame stay on the canvas
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    const count = Math.max(1, Math.min(400, Math.round(params.count)));
    const appear = tween(t, { duration: 0.8 });
    for (let i = 0; i < count; i++) {
      const radius = randomRange(120, 460, params.seed, i, "r") * interpolate(t, [0, 1.2], [0.2, 1]);
      const turns = randomRange(0.05, 0.35, params.seed, i, "w") * params.speed;
      const angle = (random(params.seed, i, "a") + loop(t * turns, 1)) * Math.PI * 2;
      const wobble = noise(t * 2, params.seed, i) * 14;
      const x = WIDTH / 2 + Math.cos(angle) * (radius + wobble);
      const y = HEIGHT / 2 + Math.sin(angle) * (radius + wobble) * 0.6;
      const size = randomRange(3, 11, params.seed, i, "s") * (0.7 + 0.3 * pingPong(t + random(params.seed, i, "p"), 0.5) * 2);
      ctx.globalAlpha = appear * randomRange(0.35, 1, params.seed, i, "o");
      ctx.fillStyle = params.color;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, [t, params.count, params.seed, params.color, params.speed]);
  return <canvas ref={ref} width={WIDTH} height={HEIGHT} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />;
}

export const orbitCanvas: CardDef<Params> = {
  id: "rs-orbit-canvas",
  name: "Orbiting dots",
  description: "A ring of dots on the canvas orbits the center; positions and sizes are determined by the seed",
  source: "user",
  useWhen: "Framework example: use when drawing on a canvas a set of points whose positions are computed directly from time.",
  tags: ["canvas", "dots", "example"],
  frameMode: "direct",
  defaults: { count: 160, seed: 11, color: "#9bf6ff", speed: 1 },
  controls: [
    { key: "count", label: "Number of dots", type: "number", min: 1, max: 400, step: 1 },
    { key: "seed", label: "Random seed", type: "number", min: 0, max: 9999, step: 1 },
    { key: "color", label: "Color", type: "color" },
    { key: "speed", label: "Rotation speed", type: "number", min: 0, max: 4, step: 0.1 },
  ],
  Component: OrbitCanvas,
  lifecycle: { settleMs: 1200, after: "evolve", exit: ["fade"] },
};
```

### 2.3 Key points for writing cards

- **At the top level of the file, write only `import`, types, functions and `const` constants**; constant initializers use no `new`, no `await` and no assignment. For lookup tables use object or array literals; if you need a `Map`, a `Set` or a class instance, create it inside a function at the point of use.
- **React hooks: do not use the state-holding kind** (`useState`, `useReducer`, `useSyncExternalStore`, `useTransition`, `useDeferredValue`, `useOptimistic`, `useActionState`). The values they hold outlive a single frame, so the picture is no longer determined by t and the parameters alone. You can use `useMemo` (to cache things computed from the parameters), `useEffect`, `useLayoutEffect` (to draw on the canvas) and `useId`.
- **Write `useRef` only as `useRef(null)`**, to get a DOM node (Example 3 above). `useRef(0)` with an initial value, or writing into `.current`, carries things over to the next frame.
- **For canvas cards, call `clearRect` first on every frame and then redraw the whole canvas**, so no pixels from the previous frame remain on the canvas (Example 3).
- **Use `beginFrameWork` to hold back screenshots during async preparation.** For a card that must wait for an image to decode, for a piece of data, or for a font before it can draw correctly, call `beginFrameWork("name")` in an effect to take a ticket; call `ready.ready()` when it is prepared and `ready.fail(error)` on failure; when the effect cleans up (on unmount, or before it reruns because `t` changed on the next frame) always call `ready.dispose()` to return the ticket. Prerender and export wait for all outstanding tickets before capturing each frame, and a failure raises an explicit error instead of capturing a half-finished frame. Cache the image object with `useMemo` keyed on `src`; do not create a new one on every frame:

```tsx
import { beginFrameWork } from "../../kernel/frameReady";
// inside the component
const img = useMemo(() => { const i = new Image(); i.src = params.src; return i; }, [params.src]);
useLayoutEffect(() => {
  const ready = beginFrameWork("cover image");               // take a ticket
  let stale = false;
  img.decode().then(
    () => { if (!stale) draw(img, t); ready.ready(); },  // decoded: draw with this frame's t, then signal ready
    (e) => ready.fail(e),                                 // failed: report an explicit error
  );
  return () => { stale = true; ready.dispose(); };      // return the ticket on unmount or when the next frame arrives
}, [img, t]);
```

- **Even if you do not take a ticket, screenshots wait for fonts and `<img>` to finish loading**; but the pattern of "draw one version first, then swap in another once loaded" is still wrong: draw only after everything is ready, and draw only one version.
- In `CardProps`, `t` is an optional property (`t?: number`), so write `t = 0` as the default when destructuring in the component; but a remotion-style card's picture is a function of t, so it must read it.

### 2.4 Patterns rejected on the spot when creating a card

For a card that declares `frameMode: "direct"`, `create_card` and `edit_card` check the source rule by rule and report back **every violation with its line number**, in the form `[remotion-style] line 6: used unseeded randomness (Math.random): ...`; fix them as reported and call again.

| Pattern | Why it is not allowed | Change it to |
|---|---|---|
| Importing modules outside the list (including helper files in the same directory such as `./xxx`, style files, and third-party libraries not on the list), dynamic `import()`, `require()` | A remotion-style card may only import modules on the list in section 2.5 | Use the framework and the modules on the list instead; write helper functions into the same file |
| `motion` / `motion/react`, `<motion.div>`, and interaction props such as `whileHover` | Motion's animations and springs advance by themselves in real time, so jumping to a frame cannot compute that frame; there is also no mouse or scrolling during export | Use the framework's `tween`, `spring`, `stagger` and write the picture as a function of t; to make it appear, write a condition on t |
| `<AnimatePresence>` | Components that enter and exit play their exit by checking "present in the previous frame, absent in this one", which reads the previous frame's state | Write entrance and exit as conditions and transitions on t: render it during the time range when it should appear, and compute opacity and offset from t with `tween` / `interpolate` |
| CSS animations and transitions: `animation*` and `transition*` in styles; `@keyframes` in style text; class names `animate-*` and `transition*`; an element's `.animate()`; SVG's `<animate>` | They follow real time, so frames go out of sync whenever the machine lags | Write time-varying styles as functions of t, directly in `style` (writing `"none"` in a style is not a violation) |
| `Date.now()`, `new Date()` without arguments, `performance` | They read real time; export and prerender run on the stage's own frame clock | Use the `t` the component receives |
| `setTimeout`, `setInterval`, `setImmediate`, `requestIdleCallback` | Timers fire in real time and do not follow frames | Write "appear after a while" as a condition on t, or as the `delay` of `tween` / `stagger` |
| `requestAnimationFrame`, `cancelAnimationFrame`, `setAnimationLoop`, `requestVideoFrameCallback` | How many times the browser's per-frame callback fires, and at what interval, is not deterministic | The stage re-renders this card on every frame with a new t, so just write the picture as a function of t |
| `Math.random`, `crypto` | Unseeded, and each call advances one step, so jumping straight to frame N gives a different result | The `random(seed, index)` family |
| State-holding hooks such as `useState` | The values they hold outlive a single frame | Compute time-varying quantities directly from t; for caching use only `useMemo` |
| `useRef(initial value)`, writing into `.current` | Values stored in a ref outlive a single frame | Use a ref only to get a DOM node: `useRef(null)` |
| Writing into names at the top level of the file or into imported things (assignment, increment, `delete`, mutating methods such as `push`, `Object.assign`) | It outlives a single frame, so what was written in one frame can be read in the next | Do not store it; compute time-varying quantities from t |
| Global objects such as `window`, `globalThis`, `self`, `localStorage`, plus `eval` and `Function()` | Global objects and local storage outlive a single frame; code assembled at runtime cannot be checked when the card is created | Do not use them |
| Top-level `let` / `var` / `class` / `enum`, directly executed statements, and `new`, `await` or assignment in top-level initializers | The top level must contain only constants so that it can be locked read-only as a whole on load | Write only `const` constants; put anything that needs `new` inside a function |
| `IntersectionObserver` | A card plays as soon as it mounts; there is no "scrolling into the viewport" (not allowed for any card) | Do not use it |
| `frameMode` written as a variable or a computed value | When the card is created, it cannot be determined which style the card uses, so "the declaration is authoritative" falls through | Write the literal `"direct"` or `"stateful"` directly |
| No import statement that references the framework (a type-only `import type …` does not count) | On load, only cards that reference the framework get their file top level locked read-only; without a reference there is no lock, and writing into a top-level object through a variable cannot be detected. The error points to the `frameMode` line | If you use its tools, write `import { tween } from "../../kernel/remotionStyle";` as usual; if you use none (cards that only do arithmetic on `t`, media effect cards that only use GLSL, cards with sound only), write a bare import on one line at the top of the file: `import "../../kernel/remotionStyle";` |

**Also:**

- One more general note without a line number is appended at the end, reminding you that this card declares remotion-style; an effect that must be advanced frame by frame from the start to get its picture uses the other declaration, `frameMode: "stateful"` (section 3).
- Checked only when creating or editing a card. Cards already in the library (built-in cards, previously created cards) load and run as before and will not break because of the added checks.
- When editing an old remotion-style card that **was created before the framework existed and does not reference it**, only violations **newly added** by this edit are rejected; existing ones are not pursued (the "no framework reference" rule is also not forced on it). Once the card references the framework, every rule must be fixed from that moment on. Converting between the two styles: changing a motion-style card to remotion-style is checked like a newly created card (every violation is rejected); changing a remotion-style card to motion-style is no longer covered by this section's checks and follows the motion-style checks.
- When a card that references the framework is loaded, the objects at the top level of the file are locked **read-only** as a whole, and writing into them fails on the spot. Every newly created remotion-style card must reference the framework, so all of them get locked; a bare import counts as a reference too.
- The checks in this section look at the syntax tree, not at text matches: writing these words in comments is not blocked; `animate-*`, `transition` and `@keyframes` inside strings and class names are checked. (The three old rules for motion-style cards, `Date.now()`, `setTimeout` / `setInterval` and `IntersectionObserver`, are text matches, so writing these words in comments is blocked too.)

### 2.5 Modules a remotion-style card may import

User cards live under `src/cards/user/`; write the paths as below:

| Module | Used for |
|---|---|
| `react`, `react/jsx-runtime` | Components, and hooks that hold no state |
| `../../kernel/remotionStyle` | The framework (section 2.1). **Must be imported**: if you use none of its tools, write the bare import `import "../../kernel/remotionStyle";` |
| `../../kernel/types` | `CardDef`, `CardProps` |
| `../../kernel/frameReady` | `beginFrameWork`: holds back screenshots until async preparation is done |
| `../../kernel/soundEffects`, `../native/sound-effects` | Sound recipes and `cardSoundBlock` (pure computation, for cards with sound) |
| `../../render/cards/graphValues` | The outputs of media effect cards: `glsl`, `draw`, `bitmap` |
| `../native/hud` | Conventions for position and primary color |
| `../magicui/vendor/cn` | Joining class names |

Type-only imports (`import type …`) are unrestricted. **Not on the list**: `motion`, `motion/react`; `lottie-web`, `@tsparticles/*` (they bring their own clock or draw randomness internally; to place a Lottie animation use the built-in `lottie` card and the media wrapper cards, which are remotion-style, with the playback library's random numbers pinned by the card, see section 3); `three`; other files in the same directory and style files (animations inside style files cannot be seen when the card is created).

### 2.6 Patterns the check cannot detect but that are equally forbidden

The card-creation check looks only at the source, so it cannot see the following; you must enforce them yourself:

- **Drawing on without clearing the canvas.** The canvas itself outlives a single frame, so the previous frame's pixels stay. On every frame, call `clearRect` first and then draw.
- **Storing things on DOM nodes** (`el.dataset.n`, attaching properties to nodes).
- **Writing into `params`.** (No card should write into `params`, see section 7.)
- **Writing, via a variable, into an object exported by another module.**
- **A new remotion-style card that does not reference the framework writing, via a variable, into an object at its own top level** (it is not locked read-only on load).
- **Depending on "whichever loads first"**: draw only after fonts, images and the like are all ready; do not draw one version first and then change it (use `beginFrameWork`, see 2.3).

## 3. The motion style

Declaration: `frameMode: "stateful"`. The picture has state, and the target frame can only be reached by advancing frame by frame from the clip start. **This is an official style on a par with remotion-style; the built-in cards include both styles, and neither needs to be rewritten.**

**What it suits:**

- Using Motion's ready-made animations: `initial` / `animate` / `transition`, springs, `AnimatePresence` entrances and exits, layout animations. Easy to write, with the curves ready-made.
- CSS keyframes and transitions.
- Effects where one frame depends on the previous one: particles (`@tsparticles`), physics simulation, JS that accumulates its own state.
- Cards that import `lottie-web` directly (position by frame with `goToAndStop(frame, true)`, do not autoplay). **Placing a Lottie animation does not require this**: the generic `lottie` card (put JSON text or a URL into the parameters) is a built-in remotion-style card, in which `random()` and `wiggle()` in the playback library's expressions and the random order of text are pinned by the card, so jumping to any frame gives the same result as playing through to it; the Lottie files in the asset catalog are already ready-made cards, see section 4.6, so do not rewrite them. A card that imports `lottie-web` itself does not get this pinning (for assets with random expressions, the picture changes with how playback advances), and since `lottie-web` is not on the remotion-style module list (section 2.5), it can only declare `"stateful"`.
- three (write the 3D picture as a pure function of t, and call render explicitly once more when t changes; see `src/cards/native/scene-3d.tsx`). three is not on the remotion-style module list (section 2.5), so cards that use it declare `"stateful"`.

**Cost:**

- When paused or scrubbed to the middle of a clip, the card must be re-advanced from the clip start (the mount frame) to that frame, which gets slower the longer the clip is.
- Prerender has to store a snapshot of every frame for it (pasted in while paused or scrubbing).
- The picture is sensitive to the "advancing process": for the same t, advancing step by step and jumping straight there should give the same result, so reading real time is still not allowed.

**Rules (looser than remotion-style, but these are hard rules):**

- Do not use `Date.now()` or `new Date()`: export runs on virtual time, and reading real time will not match the picture.
- Do not use `setTimeout` / `setInterval` to drive animations: they are not controlled by the virtual clock. Leave animation to `motion/react`, and if you need to advance by time, read the `t` the component receives.
- Do not use `IntersectionObserver`: a card plays as soon as it mounts.
- Do not run your own frame loop (`setAnimationLoop`, or `requestAnimationFrame` for 3D), and do not rely on the mouse, scrolling or hover to drive things (the review table in section 6).
- You may use `Math.random` (the stage pins it to a seeded one), but each call advances one step, so the result depends on call order. To get the same random number for the same `t` however you jump, use the framework's `random(seed, index)` (section 2.1; it depends only on the seed and index, and motion-style cards may import it too).
- Play on mount: `motion` runs the animation to completion by itself, so **the vast majority of cards that use Motion do not need to read `t`**. Only cards that "follow the timeline" (a captions track that switches the current sentence by time, chapter navigation that highlights by time) and cards that render explicitly from `t` (3D cards; cards that import `lottie-web` themselves and position by frame number convert `t` to a frame number) read `t`; such a card states in `useWhen` that it needs the clip to cover the whole time range, not just a short stretch.
- Other Motion usages (springs with `type: "spring"`, keyframe arrays, `delay`, `repeat`) are all allowed; write them as Motion's own documentation says. During export the stage's virtual clock drives Motion's frame loop and also pins CSS and Web Animations animations to "stage time minus the stage time at which it appeared", so the phase of an infinitely looping (`repeat: Infinity`) animation in export is also determined by time alone; for such a card, write its behavior after settling as `after: "loop"` or `"evolve"` (section 4.4).

### 3.1 Example: price tag

Below is a motion-style DOM card (for a remotion-style DOM card see section 2.2):

```tsx complete card
import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";

/** The parameters this card recognizes */
interface Params {
  text: string;
  accent: string;
  size: number;
}

function PriceTagCard({ params }: CardProps<Params>) {
  // Starts playing as soon as it mounts. Do not write logic like "play only when entering the viewport".
  return (
    <div className="absolute inset-0 grid place-items-center">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        style={{ color: params.accent, fontSize: params.size }}
      >
        {params.text}
      </motion.div>
    </div>
  );
}

export const priceTag: CardDef<Params> = {
  id: "price-tag",              // lowercase kebab-case, globally unique, must match the id passed to create_card
  name: "Price tag",              // name shown in the UI
  description: "The price number appears with a bounce",  // one sentence on what it looks like
  source: "user",               // cards created by the AI or the user are always set to "user"
  useWhen: "When the narration states a price or a price range, make the price the main visual. For merely stating an ordinary number, use stat-proof.",
  tags: ["price", "number", "tag"],
  frameMode: "stateful",        // required: Motion's animation must advance from the start, so it is motion-style
  defaults: { text: "¥199", accent: "#ffd166", size: 96 },
  controls: [
    { key: "text", label: "Text", type: "text", hint: "The price to display, including the currency symbol" },   // has a decent default, so not marked required (see 4.2)
    { key: "accent", label: "Primary color", type: "color" },
    { key: "size", label: "Font size", type: "number", min: 24, max: 240, step: 4 },
  ],
  Component: PriceTagCard,
};
```

## 4. The CardDef contract

### 4.1 Field reference

First, look at all the fields of a card. **Both styles and media effect cards use the same `CardDef`**; here is its shape (`?` means optional):

```ts
interface CardDef<Params> {
  id: string;  name: string;  description: string;  source: "user";
  useWhen?: string;  tags?: string[];
  frameMode: "direct" | "stateful";                           // required, section 1
  defaults: Params;  controls: Control[];                     // sections 4.2 and 5
  Component?: (props: CardProps<Params>) => JSX.Element;      // the picture (DOM card)
  card?: …;  audio?: …;  kind?: …;  inputs?: …;               // outputs of media effect cards, section 4.3
  parts?: CardPart[];                                         // part tree, section 4.4
  lifecycle?: { settleMs?: number; after: "hold" | "loop" | "evolve"; exit: ["fade"] };
  timing?: (params: Params) => { settleMs?: number; parts?: Record<string, { enterMs?: number; settleMs?: number }>; after?: "hold" | "loop" | "evolve" };
}
```

| Field | Required | Description |
|---|---|---|
| `id` | ✓ | Lowercase kebab-case. Must not use the `mu-` prefix (reserved for Magic UI) or the `lottie-` / `particles-` prefixes (reserved for media wrapper cards), and must not duplicate an existing card's name |
| `name` | ✓ | Short name, shown in the card library |
| `description` | ✓ | One sentence stating the **appearance and motion graphics** |
| `source` | ✓ | Always `"user"` when creating a new card |
| `useWhen` | Strongly recommended | **When this card should be chosen**, written for the AI that comes later. State the trigger conditions and how to tell it apart from similar cards ("use this one in case XX, the other in case YY"; if you do not know which similar cards exist, check with `list_cards()` first, and if you cannot get the list, state what this card does and does not do, and do not cite a card id you have not confirmed exists). Without it, this card will basically never be chosen later |
| `tags` | Recommended | Search keywords |
| `defaults` | ✓ | The default value of each parameter. See "Default value rules" in section 4.2 |
| `controls` | ✓ | The parameter control table. Both the UI panel and the AI rely on it to learn the schema |
| `frameMode` | ✓ | **Required; must be the literal `"direct"` (remotion-style) or `"stateful"` (motion-style)**; see section 1 for how to choose. Omitting it or writing it as a variable is rejected by `create_card`. The old values `"react"` and `"non-react"` exist only for reading old projects and are both read as motion-style; do not write them in new cards |
| `Component` / `card` / `audio` | Write at least one | `Component` is a React visual component and can also declare `audio`; `card` is the output of a visual media effect card, and you choose either it or `Component`; `audio` is the audio output and can be written alone or together with `Component` / `card` (section 4.3) |
| `parts` | Recommended | **Part tree** (the structure of the card contract): which parts this card is made of from the outside, which parameters drive each part, when it enters and how long until it settles. The code page and `get_clip` organize parameters by it. See "Part tree and lifecycle" below |
| `lifecycle` | Recommended | **Lifecycle** (the timing of the card contract): how long until the entrance settles (`settleMs`, in milliseconds), then `hold` to stay still / `loop` to repeat / `evolve` to keep changing, and the supported exits (`exit`, currently `["fade"]`). See section 4.4 |
| `timing` | Depends | Give it for cards whose settle time varies with parameters: `(params) => ({ settleMs?, parts?, after? })`, see section 4.4 |

### 4.2 Default value rules (important)

`clip.params` is a **sparse overlay**, merged with `defaults` only at render time. So the default must be something that "passes even if left unfilled".

- For parameters that can have a reasonable default: give a decent default value so that the card has an effect the moment it is added.
- **For parameters whose content can only come from outside and that cannot have a meaningful default** (for example caption text or transcribed text):
  leave the default empty **and** mark `required: true` on the control.

  Do not put demo copy in as the default. The captions card's `lines` once had three sample lines as its default, and as a result the AI left out `lines` when creating a card,
  and the picture played those three lines of copy unrelated to the video, looking like "captions added": the failure was hidden by the default, and nothing reported an error anywhere.

For parameters marked `required`, `add_clip` / `update_clip` validate before writing and fail outright if the value is empty. What is validated is the **merged** result (`defaults` + existing parameters + the keys written this time): so only a required parameter whose default is left empty fails when omitted; marking `required` on a parameter with a non-empty default has no effect, so do not mark it.
`hint` is returned to the AI along with it, so state the format and the range of values.

### 4.3 The media effect card route

When a requirement needs a **filter, transition, audio algorithm or multi-input composition** that the existing parameters cannot do, write a **media effect card**. A media effect card is not a separate system: it is an ordinary `CardDef`, whose source is likewise a single file `src/cards/user/<id>.tsx`, likewise saved to disk with `create_card` and modified with `get_card_source` + `edit_card`. A visual media effect card writes `card()` and sound writes `audio()`, each evaluated separately by the host. A motion graphics card can write a visual `Component` or `card()` together with `audio()` **in the same `CardDef`**, and the picture and the sound belong to the same timeline clip (audio motion card; see section 10 for the rules).

Creating a card and applying it are **two steps**: `create_card({ id, source })` saves the definition to disk, then `apply_card({ cardId, clipId, ... })` creates an instance.

#### Contract

On top of the fields of an ordinary `CardDef`, a media effect card has these extra items:

| Field | Description |
|---|---|
| `kind` | `"animation"` / `"filter"` / `"transition"` / `"emphasis"` / `"audio"`, default `"animation"` |
| `inputs` | `Record<string, { description?: string }>`. `filter` / `emphasis` / `audio` default to `{ source: {} }`, `transition` defaults to `{ A: {}, B: {} }`, and `animation` defaults to no inputs |
| `card` | `(sources, t, params, ctx) => CardGpuValue \| Promise<CardGpuValue>`, the output of a visual media effect card |
| `audio` | `(sources, range, params) => Float32Array \| Promise<Float32Array>`, the output of an audio media effect card |
| `Component` | The DOM visual output; can coexist with `audio`. Choose either the visual `card` or `Component`; a pure audio card writes only `audio` |

- `sources[name]` = `{ nodeId, at(t?), pixels(t?, signal?), block(start, count) }`.
  - `at(t)` returns a **lazy reference** (no pixels are materialized) that you feed directly to GLSL; this is the default and also the cheapest route.
  - Only `pixels(t)` actually decodes an `ImageBitmap`; use it only for CPU pixel algorithms, as it is noticeably slower.
  - `block(start, count)` fetches an audio sample chunk.
- `t` is in **clip-local seconds** (not absolute timeline time).
- `range` = `{ start, count, sampleRate: 48000 }`, where `start` / `count` are the sample position and sample count; the number of samples returned and the start point must **exactly match** the request.
- `ctx` = `{ fps, width, height, duration, stage }`.
- `params` is the result of merging the instance parameters into `defaults`, on the same basis as `params` in a TSX card.

The helper functions are in `src/render/cards/graphValues`:

- `glsl(fragment, inputs, uniforms)`: the GPU fragment shader. Input textures are named `u_input0`, `u_input1` and so on in turn, the UV is `v_uv`, and the output is written to `outColor`; **the shader must declare every uniform it uses itself**, as passing a value does not add the declaration automatically.
- `draw(commands)`: drawing commands.
- `bitmap(image)`: hands an `ImageBitmap` / `ImageData` / `OffscreenCanvas` directly over as the result; it is the output for CPU pixel algorithms.

**Declare capabilities with `frameMode` only**: a media effect card that uses only `at()` + GLSL writes `"direct"`; one that uses `pixels()` or keeps its own state writes `"stateful"`. **Do not write `compositing: 'independent'` in the source** (it will be rejected by `create_card`): this value is honored only from the manual review table `src/cards/capabilities.json`; other `compositing` values written in the source do not count. When the card is first created it takes the most conservative route as `unknown`, and `independent` is added after human review. The first version of a media effect card also must **not** declare `canvasHeavy`.

**A media effect card written as `"direct"` must also import the framework.** In the three examples below, the picture is computed directly from GLSL and `t` (or by multiplying audio chunks directly), and they use none of the framework's tools, so each writes a bare import on one line, `import "../../kernel/remotionStyle";`; besides that they import only `../../kernel/types` and `../../render/cards/graphValues`, both on the list in section 2.5. Once the import is there, the objects at the top level of the file are locked read-only when the card is loaded (shader strings and the card definition are unaffected). They must still pass the checks in section 2.4 (no modules outside the list, only constants at the top level, no reading real time, no `Math.random`), and the code in the examples satisfies all of them.

#### Example 1: GLSL invert filter

```tsx complete card
import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

interface Params { amount: number }

export const invertFilter: CardDef<Params> = {
  id: "invert-filter",
  name: "Invert filter",
  description: "Blends the input picture toward its inverse by the given amount; 0 is unchanged, 1 is fully inverted",
  source: "user",
  useWhen: "Use when you want an overall inverted / negative look on a piece of media or on a media effect card. For adjusting only color temperature or brightness, use the color grading parameters and do not create a card for it.",
  tags: ["filter", "invert", "negative"],
  kind: "filter",
  frameMode: "direct",
  inputs: { source: { description: "The picture to process" } },
  defaults: { amount: 0.5 },
  controls: [
    { key: "amount", label: "Intensity", type: "number", min: 0, max: 1, step: 0.01 },
  ],
  card: (sources, t, params) => glsl(
    `uniform sampler2D u_input0;
     uniform float amount;
     void main() {
       vec4 c = texture(u_input0, v_uv);
       outColor = vec4(mix(c.rgb, 1.0 - c.rgb, amount), c.a);
     }`,
    [sources.source.at(t)],
    { amount: params.amount },
  ),
};
```

Save it with `create_card({ id: "invert-filter", source })`, then apply it to a clip with `apply_card({ cardId: "invert-filter", clipId: "clip-a" })`. When `inputs` is not passed: if that clip already has a media effect card, it automatically connects to that card's output ("invert first, then blur" is a natural action); otherwise it connects to the original media of that clip.

#### Example 2: two-input crossfade transition

```tsx complete card
import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

interface Params { duration: number }

export const crossfade: CardDef<Params> = {
  id: "crossfade",
  name: "Crossfade",
  description: "Picture A dissolves evenly into picture B over the given duration",
  source: "user",
  useWhen: "Use when you want the plainest dissolve transition between two pieces of media. For directional push, pull or wipe transitions, create a separate card.",
  tags: ["transition", "dissolve", "crossfade"],
  kind: "transition",
  frameMode: "direct",
  inputs: { A: { description: "The picture before the transition" }, B: { description: "The picture after the transition" } },
  defaults: { duration: 1 },
  controls: [
    { key: "duration", label: "Duration (seconds)", type: "number", min: 0.1, max: 5, step: 0.1 },
  ],
  card: (sources, t, params) => glsl(
    `uniform sampler2D u_input0;
     uniform sampler2D u_input1;
     uniform float progress;
     void main() {
       outColor = mix(texture(u_input0, v_uv), texture(u_input1, v_uv), clamp(progress, 0.0, 1.0));
     }`,
    [sources.A.at(t), sources.B.at(t)],
    { progress: t / Math.max(1e-6, params.duration) },
  ),
};
```

Clamping is written in the GLSL. The two inputs are named in `apply_card`: `apply_card({ cardId: "crossfade", trackId: "main", start: 3, end: 4, inputs: { A: { clipId: "clip-a" }, B: { clipId: "clip-b" } } })`. A `{ clipId }` in `inputs` that points to a media clip means that media, and one that points to a media effect card clip means that card's output; `{ nodeId }` connects directly to another node's output; `offset` (seconds) and `rate` (multiplier) define the local time mapping of that input.

#### Example 3: gain audio card

```tsx complete card
import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";

interface Params { gain: number }

export const gainAudio: CardDef<Params> = {
  id: "gain-audio",
  name: "Gain",
  description: "Amplifies or attenuates the input audio by a multiplier and returns the sample range unchanged",
  source: "user",
  useWhen: "Use when a sound is overall too quiet or too loud and you do not want to change the media itself.",
  tags: ["audio", "gain", "volume"],
  kind: "audio",
  frameMode: "direct",
  inputs: { source: { description: "The sound to process" } },
  defaults: { gain: 1.5 },
  controls: [
    { key: "gain", label: "Gain", type: "number", min: 0, max: 4, step: 0.05 },
  ],
  audio: async (sources, range, params) => {
    const block = await sources.source.block(range.start, range.count);
    const out = new Float32Array(block.length);
    for (let i = 0; i < block.length; i++) out[i] = block[i] * params.gain;
    return out;
  },
};
```

An audio card has `kind: "audio"`, and its samples are interleaved `float32` (frames × channels). **The number of samples returned and the start point must exactly match `range`**, and non-finite samples are rejected. An audio media effect card writes only `clip.nodeId` and not `clip.cardId`, so no extra layer appears in the picture; on the timeline, the same clip **cannot** carry both a "pure audio media effect card" (`kind: "audio"`, no visual output, goes through `apply_card`, attached to `clip.nodeId`) and a visual media effect card, because they are two nodes (if you want both, duplicate the clip first); this is a different matter from "one card that has both a picture and `audio()`" above. `rate ≠ 1` on an input edge is not supported in the first version.

#### Limits of the first version

- A media effect card's inputs connect only to **media nodes** and **other media effect card nodes**; connecting a DOM card (an ordinary TSX card) is rejected by `apply_card`.
- Passing the current `clip.nodeId` to `apply_card` = modifying this instance's parameters and inputs in place (when `inputs` is not passed, the old ones are inherited), and it will not be wired to itself.
- To change the source, call `get_card_source` first and then `edit_card`; do not create duplicate definitions; one definition can have several instances with different parameters. When done, use `see_frames` to check the actual result.

### 4.4 Part tree and lifecycle (card contract)

What the Agent and the code page see is not the component source but a fixed-shape **contract** (the object returned by `get_clip`): card + lifecycle, time, frame, blend, parts, params.
The component source passes through the review gate and is saved to disk only once, when a card is created or edited, and from then on is **operated on only through the contract**. So a card must state its own structure and timing clearly:

```ts
  parts: [
    { id: "title", label: "Subheading", role: "text", params: ["title"], enterMs: 0, settleMs: 600 },
    { id: "items", label: "Key points", role: "list", params: ["items", "stepMs"], enterMs: 300, settleMs: 1100 },
  ],
  lifecycle: { settleMs: 1100, after: "hold", exit: ["fade"] },
```

- `parts[].role` has only five values: `"text"` (text), `"media"` (images, animations, canvases), `"list"` (lists), `"decor"` (decoration, such as background dots or progress bars), `"group"` (a group, which can carry `children`).
- Keys in `parts[].params` must actually exist in `controls`; a parameter belongs to only one part. Parameters that belong to no particular part, such as seed, count and color, may be left out of every part. For a card without `parts`, all parameters belong to a single root part called `root`.
- `enterMs` / `settleMs` are both **moments in milliseconds counted from the clip start**: `enterMs` is when this part starts its entrance, and `settleMs` is when it settles (= start moment + animation duration, not the duration itself); for a list, count by the last item. For a card using Motion, add up its delay / duration (estimate a spring as +400ms; lightly damped springs with large displacement are not necessarily accurate); a remotion-style card computes it with the framework's `springDuration` and `staggerDuration` (section 2.1), which is accurate.
- `lifecycle.settleMs` is the moment the whole card settles at the latest (likewise in milliseconds from the clip start). From it the Agent knows "the last few seconds of this clip are still", and whether to shorten the duration or add a fade-out.
- `lifecycle.after`: `hold` stays still after settling; `loop` repeats the whole entrance animation over and over; `evolve` keeps the picture changing after settling (pulsing, fluctuating, orbiting, particles, following the timeline).
- `lifecycle.exit` is currently written as `["fade"]` (fade out as a whole using the clip's fade-out).
- A card without these two fields is treated as "one root part, with an entrance animation, then holds, supports only fade-out", with no error.
- **For cards whose timing varies with parameters (item count, character count, interval and speed determine the settle time), also give a `timing`**: `timing: (p) => ({ settleMs, parts: { items: { settleMs } }, after? })`,
  The contract is recomputed from the clip's actual parameters on every read; like the local → world of frame, it is a derived quantity and is not saved to disk; the static values in `parts` / `lifecycle` serve only as a reference under the default parameters. The `parts` returned by `timing` may list only the parts that change.

### 4.5 Parts library and composite cards (free composition without creating a card)

For a combination that no ready-made card offers, such as "title + key points + a ring metric", **do not write a new card with create_card**; use a composite card:

- `list_parts` shows the parts library (src/parts/lib; each part is the smallest independently renderable unit: title, key points, ring metric, ranking bar, Lottie, ...);
- `add_composite({ start, duration, parts: [{ partId, params?, frame?, enterMs? }, …] })` builds it in one go, or create an empty one first and then `add_part`;
- `set_part` / `remove_part` / `move_part` change parameters, frame, entrance timing, order and parent-child relations; in `get_clip`, each instance in parts carries partId, frame.local (relative to the parent frame, writable), frame.world (absolute position in the picture, read-only), enterMs, settleMs.
- Every part with text has a `size` parameter: `size` 0 = fit automatically to the frame (default), a positive number = fixed pixels; if unsure, leave it 0 and only place the frame.
- A part's frame is relative to its **parent frame**: the parent frame of a root part is the composite card's canvas (the whole stage by default; if set_rect shrinks the composite card, the whole tree shrinks with it), and the parent frame of a child part is its parent part's frame. Parts later in the order are drawn on top.

To write a new part (adding a new one to the parts library), put it in src/parts/lib/<id>.tsx; the contract is in src/kernel/partTypes.ts: root element absolute inset 0, lay out within its own frame, no full-screen positioning parameters, provide defaultFrame and settleMs; if it has text, add a `size` parameter (default 0) and compute the font size with `fitOr(params.size, { width, height, text })`.

### 4.6 Media wrapper cards (do not hand-write them again)

The Lottie animations and particle configurations in the asset catalog **are already cards**: `lottie-<name>` and `particles-<name>` (src/cards/assets, generated from the catalog at build time).
They are the product of "motion asset → function translation → card contract": the original files stay in the catalog, and the components reuse LottieView / ParticlesView,
and only the translated knobs are exposed (a particles card exposes the count / speed / size / color / opacity / links that really exist in its configuration).
To use an asset, call `add_clip({ cardId: "lottie-adrock" })`; **do not** read the asset JSON and do not wrap it again with create_card;
The `lottie-` / `particles-` prefixes are a reserved namespace.
The Lottie wrapper cards and the generic `lottie` card are remotion-style (on every frame the time is converted to a frame number and computed directly, and the random numbers in the playback library are pinned by the card); the particles wrapper cards are motion-style.

### 4.7 Referencing images / videos in the media library

When a card parameter needs a file from the media library (the image of an image card, the `texture` of `scene-3d`, a background video, ...), **fill in the `cardUrl` returned by `list_media`**,
which looks like `/@media/<filename>`. The editor preview, the `see_frames` render page and export are all same-origin with it, so all three can fetch it.

- Do not fill in `path` (a disk path): the browser and the render page cannot read disk paths.
- Do not fill in an address starting with `blob:`: it is private to the editor page, rendering and export cannot open it, and that part of the picture will be empty.
- Do not assemble `/media/…` or `http://localhost:port/…` yourself: the port is not fixed, and export does not go through that port either.
- If the media library does not have the image you want: after finding a direct image link, bring it in with `import_media({ url, name })`, and the response contains the `cardUrl`.

## 5. Control types

Hand-written cards use these four (media wrapper cards have one more, `asset`, which picks a Lottie or particles from the asset catalog; hand-written cards do not use it). All four can take `required` and `hint`:

```ts
{ key, label, type: "text",   required?, hint? }
{ key, label, type: "number", required?, hint?, min?, max?, step? }
{ key, label, type: "select", required?, hint?, options: [{ value, label }] }
{ key, label, type: "color",  required?, hint? }
```

For a "list" parameter use `text`, define a separator format yourself, and state it clearly in `hint`
(for example, the `lines` of a captions track separates items by newline and columns by `|`). Several lines of text with a fixed count (for example a three-line description) can also simply be made into several `text` parameters (`line1`, `line2`, `line3`), with empty lines taking no space, which the component handles itself; use a separator format only when the count is not fixed.

- **`color` control**: what the UI picks is a `#rrggbb` hex string; when written through `update_clip` the format is not validated, so an Agent may write a color name or `hsl()`. The framework's `interpolateColors` recognizes only `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`, and throws an error on anything else (the card will fail to render), so such a `color` control must say in its `hint`: "hex color, e.g. #4cc9f0".
- **The `min` / `max` / `step` of a `number` control** only govern the UI (the range for dragging and the input box). `update_clip` only validates that the value is a number and **will not** reject or clamp out-of-range values; they are passed to the component as is. So the component must clamp the parameter into a reasonable range itself, to avoid computing NaN or a negative duration.

### Values that will be tuned always become parameters

**Any value where "changing the number/color gives a different effect" must go into `controls` + `defaults`; do not hard-code them in
the component.** (The check does not enforce this; it is for easier changes later. The card's own design constants, such as the shape of an easing curve, a spring's stiffness and damping, and the distance the card moves up on entrance, are not "values that will be tuned" and can be written as named `const` declarations at the top of the file, see section 2.1.) Font size, font weight, spacing, corner radius, color, animation duration and delay, entrance direction, scale factor, random seed: these
all belong to this category.

This is not a style suggestion but a matter of cost: a hard-coded value can only be tuned by changing the source, and every change to the source carries the risk of breaking
something else; once it is a parameter, "make the text a bit bigger" is a single `update_clip`, takes effect immediately, and does not touch
anything else in the card. It is normal for a user to ask for "a bit bigger" once, and by the third time you will be glad you made it into
a parameter.

The criterion: if "about this big, I guess" ever crossed your mind while writing the literal, it should be a parameter.
Conversely, the layout structure (flex or grid), the element hierarchy and the type of animation are things whose change makes it a different card,
so hard-coding them in the source is correct.

## 6. Hard constraints

Both styles must obey these. What `create_card` rejects outright, telling you which rule failed: the first three below (for motion-style these are text matches, so writing these words in comments is blocked too); the tiers in the table after "The review rejects these categories" at the end of this section (own frame loop, mouse / scroll / hover driving, dependencies that are not installed, animation classes that are not defined, source and license); writing `compositing: 'independent'` in the source, missing required fields, and syntax errors. A remotion-style card additionally has that whole table in section 2.4. `new Date()` also reads real time and must likewise not be used: it is not blocked when a new card is created, but export will not match; it is blocked only when editing a built-in card.

1. **Do not use `Date.now()`**. Export runs on virtual time, and reading real time will not match the picture.
2. **Do not use `setTimeout` / `setInterval` to drive animations**. Same as above: they are not controlled by the virtual clock.
   If you need to advance by time, read the `t` the component receives; motion-style cards can leave animation to `motion/react`.
3. **Do not use `IntersectionObserver`**. A card plays as soon as it mounts; there is no "scrolling into the viewport".
4. **A card is a transparent layer on a 1920×1080 stage**; the root element uses `absolute inset-0`, and the background stays transparent
   (unless the card is meant to fill the whole area with a background color).
5. Use fixed pixels at 1920×1080 for font sizes and spacing, not responsive units; the stage scales as a whole. (Whether specific values should become parameters: see section 5.)
6. **Do not start background threads, and do not use cross-page channels or browser storage**: do not use `Worker`, `SharedWorker`, `BroadcastChannel`, `navigator.locks`, `localStorage` / `sessionStorage`, IndexedDB, `caches`, `navigator.storage`, `window.name` or `history.pushState`, and do not store the parameters (which contain asset addresses) anywhere. In the online browser's stage these are either absent or valid only for the current opening, and in the desktop app they would also make preview and export disagree.

### Dependencies you may use

| | remotion-style (`"direct"`) | motion-style (`"stateful"`) |
|---|---|---|
| Packages | `react`; the framework `../../kernel/remotionStyle` (see the list in section 2.5) | `react`, `motion/react`, `lottie-web`, `@tsparticles/engine` + `@tsparticles/slim` (canvas particles; call `setRandom(() => Math.random())` first on mount, see `src/cards/native/particles.tsx`), `three` |
| Relative paths | Only those on the list in section 2.5 | `../../kernel/types`, `../native/hud`, `../magicui/vendor/*`, etc. |
| Styles | Tailwind classes (the project already has Tailwind installed), excluding `animate-*` and `transition*` | Tailwind classes |

Both styles may:

- `import type { CardDef, CardProps } from "../../kernel/types"`
- Reuse the HUD's position / primary color convention (optional): `import { hudControls, hudDefaults, getPositionClass, accentOf, easeExpoOut, type HudParams } from "../native/hud"`,
  then `interface Params extends HudParams`, `defaults: { ...hudDefaults, ... }`, `controls: [...hudControls, ...]`.
  This way the card automatically gets the two parameters "position" (`position`, with values `"center"` / `"bottom"` / `"left"` / `"right"`, defaulting to center) and "primary color" (`accent`, empty by default), consistent with the built-in cards. `getPositionClass(params.position)` returns the corresponding positioning class name (`hud-pos-center` and so on), `accentOf(params)` returns `accent`, or the theme color `var(--pc-accent, #4f8cff)` when it is empty, and `easeExpoOut` is the easing array `[0.16, 1, 0.3, 1]` used by Motion.

Do not import other third-party libraries: ones that are not installed fail to compile outright.

### Porting third-party components (Magic UI and others)

You can hand the source of a Magic UI component directly to `create_card`; it runs it through a translator first and then reviews it. Ported components mostly use Motion or CSS animations, so write `frameMode: "stateful"`:

- **Changed automatically**: `"use client"` is removed; `@/lib/utils` is pointed to the local `../magicui/vendor/cn`. What was changed is listed in the returned `rewrites`.
- **What you must do**: wrap the component into a `CardDef`, writing `Component` (feed `params` to it and wrap it in an `absolute inset-0` 1920×1080 layer), `defaults`, `controls`, `useWhen` and `frameMode`. The returned `suggestedControls` are parameters inferred from its `*Props` interface that you have not exposed yet; you decide whether to surface them.
- **The file header must declare the source and license**, following the form in `src/cards/magicui/vendor/word-rotate.tsx`: `Source: <URL>` plus the license name. Only MIT / Apache-2.0 / BSD / ISC / CC0 can be ported. React Bits (Commons Clause), Aceternity (proprietary), animate.css (Hippocratic) and GSAP (prohibited for no-code animation tools) **cannot be ported**.
- A card whose file header declares magicui as the source may use the `mu-` prefix.
- **No need to look for source online**: the original source of all Magic UI components is in a local directory, and the appendix "Appendix: catalog of portable Magic UI components" at the end of this document lists every one by tier. For whichever one you want, read it with `get_card_source({ cardId: "mu-<name>" })` (the `hint` in the response tells you what to handle first), and after wrapping it, call `create_card` with the same id.

The review **rejects** these categories, and the returned `findings` carry a type label on each item (written verbatim in the error as `[Tier 2·pipeline not yet supported]`, `[Tier 3·interaction-driven]`, `[dependency]`, `[animation class]`, `[source/license]`; "Tier 2" and "Tier 3" are only internal numbers, and there is no "Tier 1"; the three old rules above are not in this table, and their errors carry no label):

| Type | Trigger | Why |
|---|---|---|
| Tier 2·pipeline not yet supported | **Own frame loops** such as `setAnimationLoop`, @react-three/fiber, cobe | A loop that accumulates by delta takes an indeterminate number of extra steps during export, and scrubbing the playhead backward cannot return to the earlier state. `<canvas>`, `Math.random` and **WebGL and three are all supported now** (three is installed, export enables software WebGL, and two passes were measured to be byte-for-byte identical), so they are no longer rejected |
| Tier 3·interaction-driven | mousemove / scroll listeners, `whileHover` / `whileTap` / `whileInView`, `useScroll` | There is no mouse or scrolling in export, so it would just stay in its initial state; it can enter export only after being changed into parameters driven by `t` |
| Dependency | Importing a library that is not installed | Installed: react, motion/react, three, lottie-web, @tsparticles/*, Tailwind classes, and relative paths (remotion-style allows only those on the list in section 2.5) |
| Animation class | `animate-xxx` is not defined | Tailwind ships 4; MagicUI's 22 sets are already in `magicui-animations.css`; others you must write in yourself (remotion-style cards do not use CSS animations) |
| Source/license | A ported component has no source declared, or its license does not allow it | It is unknown whether it can be distributed with the installer |

Magic UI components verified at the mechanism level as directly portable (plus 5 similar ones that have passed a byte-for-byte comparison): text components (Text Animate, Typing, Number Ticker, Word Rotate, Shiny / Gradient / Aurora Text, Morphing, Spinning, Text 3D Flip), Blur Fade, Border Beam, Shine Border, Marquee, Orbiting Circles, Animated List, all the buttons, all the background patterns, device frames. After porting, always check with `see_frames`.

## 7. What the component receives

```ts
interface CardProps<P> {
  params: P;        // the complete parameters after merging defaults and clip.params
  playToken: number; // +1 on every replay; Stage uses it as a key to remount, and a component usually does not need to read it
  t?: number;        // seconds since the clip start, passed in on every frame
  duration?: number; // total clip duration (seconds)
}
```

- **A remotion-style card must read `t`**: the picture is a function of t. `t` is an optional property in `CardProps`, so write `{ params, t = 0 }` when destructuring.
- **The vast majority of cards that use Motion do not need `t`**: they play on mount, and `motion` runs the animation to completion by itself. Only cards that "follow the timeline" read `t`: a captions track (switches the current sentence by time), chapter navigation (highlights the current chapter by time), and cards that render explicitly from `t` (3D cards, and cards that import `lottie-web` themselves and position by frame number).
  If your card reads `t`, state in `useWhen` that it needs the clip to cover the whole time range, not just a short stretch.
- **Do not write into `params`** (the same for all cards): it is input handed in by the host, and writing into it carries state over to the next frame or to another clip.
- Where `t` starts: for an ordinary card it is clip-local seconds; for a card that writes `audio()`, `t` already includes the portion trimmed off the start of the clip, see section 10.

## 8. Card creation workflow

```
card_authoring_guide()                     ← read the rules first (this document)
create_card({ id, source })                ← save to disk + hot reload + automatic registration
list_cards({ cardId: "price-tag" })        ← confirm registration succeeded and the schema is what you want
add_clip({ cardId: "price-tag", start, duration, params })   ← put it on the timeline
see_frames({ source: "timeline", clipId })                    ← look at the picture and confirm it really looks the way you want
user_interface_seek({ t: start + 0.5 })    ← optional: move the user's playhead there so they see the effect directly (this touches the user's UI; do not use it if you can avoid it)
```

Write the source to `src/cards/user/<id>.tsx`; **no** registry file needs to be changed, because that directory is scanned automatically.

Before saving to disk, `create_card` validates: the id is valid and not a duplicate (pass `overwrite: true` only when throwing the whole card away and starting over, see section 8.1), `CardDef` is actually exported,
the `id` in the source matches the `id` in the arguments, all required fields are present (including `frameMode`), no forbidden APIs are used, and the TypeScript syntax passes;
A card declared as remotion-style is additionally checked rule by rule per section 2.4.
If it fails, it returns **exactly which rule failed** (with a line number for remotion-style); just fix it as reported and call again.

### 8.1 Editing a card that has already been created

First work out whether what you want to change is a **parameter** or the **source**: the vast majority of "a bit bigger" and "change the color" requests are parameters:

```
list_cards({ cardId })          ← see which parameters this card has
update_clip({ clipId, params }) ← change values, takes effect immediately, source untouched
see_frames({ source: "timeline", clipId })         ← look at how it turned out
```

Touch the source only for what parameters cannot cover (adding a new parameter, changing the layout, changing the animation type), in these three steps:

```
get_card_source({ cardId })                   ← read back the current source; you must read it first
edit_card({ cardId, find, replace })          ← replace only that part; leave everything else as is
see_frames({ source: "timeline", clipId })                       ← check against the picture; do not imagine it from the source
```

`find` must be **copied verbatim** from the source returned by `get_card_source` (indentation and spaces must all match), and must
match exactly once in the whole text; if there are multiple matches, make `find` longer and include a few lines around it.

**Built-in cards can have their source edited this way too** (not only cards built with `create_card`). If you don't know which source line renders a given part of the picture, look at its DOM tree first:

```
inspect_card_dom({ clipId })                  ← read-only: every node is tagged with its component and source line, e.g. src/cards/native/rank-bars.tsx:49
inspect_card_dom({ clipId, ref: 6 })          ← expand downward from a node (cached for the same moment, no re-render)
get_card_source({ cardId, file })             ← read that file (it must be in the returned files list)
edit_card({ cardId, file, find, replace })    ← edit that line
```

- **Edit the source only, never the HTML**: the DOM is rendered from the source, so there is no tool that edits the DOM directly, and you should not go looking for one.
- Every file in `files` carries `sharedBy`: a value greater than 1 means a part shared by several cards (e.g. `hud.ts`), and editing it changes all of them together; to change just this one card, edit its own definition file.
- A node marked "the same source line generated N sibling nodes" is a list; editing that line changes all N together.
- Built-in files are backed up automatically to `out/card-edits/` before they are edited; never newly introduce `Date.now` / `new Date()` / `setTimeout` / `setInterval` / `IntersectionObserver` / `setAnimationLoop` or similar patterns that do not advance with the frame.
- Editing a card that declares itself remotion-style (including the few built-in ones) is checked against section 2.4 as well: for cards written with the framework every violation is rejected; for old cards created before the framework existed, only the violations newly added by this edit are rejected.
- Changing a motion-style card to remotion-style (or the reverse) amounts to rewriting how the card is written, and cannot be done by changing one field: a change to remotion-style is checked like a newly created card, and every violation is rejected.

**Do not use `create_card` + `overwrite: true` to edit a card.** That is a full rewrite: you do not have the current
version in hand, so you can only rebuild it from memory, and details not mentioned this time (font size, spacing, color) drift a little more each time, and the user
will find that things they never asked to change have shifted for no apparent reason. `overwrite` is reserved for "tear this card down and start over".

For built-in cards too, try tuning parameters first; only when you really must touch the source, use `get_card_source` + `edit_card` above.

## 9. Building cards from transcription results

Once the media has been transcribed (`transcribe_media` → `get_transcript`) you get:

```json
{ "segments": [ { "start": 0.0, "end": 1.6, "text": "Hello everyone, welcome to this episode." } ] }
```

`start` / `end` are seconds **within the media**.

### Laying out the captions track

**Use `fill_captions`; do not assemble the `lines` string yourself.**

```
add_clip({ cardId: "caption-track", start: 0, duration: total duration, params: { lines: "placeholder" } })
fill_captions({ clipId })
```

`fill_captions` computes time alignment and trimming locally in one pass, so dozens or hundreds of captions do not need to be re-entered one by one,
so lines and timings never go wrong and no tokens are burned. **One card** is enough for a whole run of captions; do not create one card per sentence.

When no `trackId` is given, it lands on the "captions" track by itself (it creates one if there is none, on the top layer).
To change a single caption later, check its index with `list_captions` and then use `edit_caption`; do not reload the whole set.

### Matching motion graphics to the content

`auto_workflow` already automates this path (segmenting + picking cards + laying out captions); when the user says "do it automatically" or "one-click effects",
call it directly; do not `add_clip` card by card yourself.

When refining by hand, follow the transcript to find points worth visualizing, and use each card's `useWhen` to decide which one to pick,
then `add_clip` at the time point of the matching segment. Note that clips on the same track must not overlap
(the store will move them apart automatically, but the result is usually not what you want); to show them side by side, first `add_track` to create a new overlay track.

## 10. Audio motion cards and persistent sound

- The same `CardDef` can be written as `Component + audio` or `card + audio`; `kind` stays the visual category. Do not call live sound playback when the component mounts as a substitute for `audio()`; that side effect cannot guarantee that seeking, muting and the final video stay consistent.
- `audio()` returns interleaved floating-point PCM by 48 kHz sample position; it may depend only on the full parameters, a deterministic seed, event identity and sample position, and must not advance the sound with a real clock or a random call order. Pure synthesis declares `inputs: {}` explicitly.
- After creating or modifying, call `render_card_audio({ clipId })`; only once it is stored successfully can it play across devices. Regenerate after changing parameters or source; `cancel_card_audio` is supported, and a failure does not pretend to succeed.
- `set_clip_muted` only silences the sound and marks the clip conspicuously on the timeline; the sound stays inside the original motion graphics clip. Calling `separate_audio` on it explicitly returns `EMBEDDED_CARD_AUDIO_UNSEPARABLE` and does not automatically fall back to generating a standalone sound clip. Separation of ordinary video media is unchanged.
- For a standalone notification sound or keyboard sound effect, use `sound_presets` / `sound_generate` first; there is no need to recreate the card.

- For an audio-visual card (a card that defines `audio()`), the `t` received by its `Component`, the `t` of the visual `card()`, and `range.start / sampleRate` of `audio()` have already been normalized by the host onto the same timeline: this axis is "clip-local seconds + the seconds trimmed or split off the head of the clip (`sourceOffset`)", and for a clip that was never trimmed it equals clip-local seconds. The `sourceOffset` given separately in `CardProps` is for diagnostics only, **do not add it to `t` again**. For an ordinary DOM card without `audio`, `t` is simply clip-local seconds.

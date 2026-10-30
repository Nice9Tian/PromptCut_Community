# PromptCut 建卡规则

这份规则通过 `card_authoring_guide` 工具取得。**调 `create_card` 之前必须先读它**，不要凭印象写。

## 0. 先别急着建卡

新建卡片是最后手段，理由：

- 现有卡已经调过版式、动效节奏和主题适配，直接用效果更好；
- 每多一张卡，以后选卡就多一分噪音。

所以先走这三步：

1. `list_cards()` —— 拿到所有卡的摘要，重点看每张的 `useWhen`（什么时候该选它）和 `tags`。
2. 找到候选后 `list_cards({ cardId })` —— 拿这张卡的完整 `controls` 和 `defaults`，确认参数够用。
3. 只有确认**没有任何一张卡能通过调参数达成需求**时，才 `create_card`。

「颜色不对」「文案要换」「位置要挪」都是调参数的事，不要为此建新卡。

## 1. 两种写法：建卡前先定一种

PromptCut 的卡都在两种写法里二选一（动效卡、素材效果卡一样），**两种都是正式写法，没有哪一种更推荐**，按画面的需要选。选哪一种，就在卡片定义对象（导出的 `CardDef`，字段见第 4.1 节）里把 `frameMode` 写成对应的字面量。**`frameMode` 是必填项**：建卡时不写会被拒绝，写成变量或算出来的值也会被拒绝（建卡检查要在源码里直接读出你选了哪一种）。

| | remotion 式 | motion 式 |
|---|---|---|
| 声明 | `frameMode: "direct"` | `frameMode: "stateful"` |
| 画面怎么得到 | 只由时间 `t`、参数和输入素材算出来；跳到哪一帧都是直接算，代价一样 | 有状态：要从片段起点一帧帧推进，才得到目标帧 |
| 怎么写 | 只用 react、PromptCut 自带的 remotion 式框架（`interpolate`、`tween`、`spring`、`stagger`、`random` 等）和第 2.5 节名单里的模块。**必须有一句引用框架的 import**：纯算术、GLSL 的卡（素材效果卡）也写 `"direct"`，用不到工具就写一行裸导入 `import "../../kernel/remotionStyle";`。第 2 节 | 可以用 Motion 的动画、弹簧、`AnimatePresence`，CSS 动画，`lottie-web`，粒子，three，也可以自己累积状态。用了第 2.5 节名单之外的库（three、自己直接引的 `lottie-web` 等）的卡也写 `"stateful"`，不要求它真的累积状态。放一段 Lottie 动画不用自己引 `lottie-web`：用现成的 `lottie` 卡，它是内置的 remotion 式卡。第 3 节 |
| 适合 | 画面能写成「t 的函数」：标题与字幕的进出场、数字与柱图、按种子摆出来的一批元素、画布上按公式算位置的图形 | 要用 Motion 或 CSS 现成的动画而不想自己写曲线；要用粒子、物理模拟这类一帧依赖上一帧的效果；要用 three |
| 代价 | 只能用框架里有的工具，框架外的写法建卡时当场拒绝（第 2.4 节）；弹簧、缓动、错开进场要用框架自己的 | 暂停、拖动到片段中间时，要从片段起点重新推进到那一帧，片段越长越慢；预渲染要为它存每一帧的快照 |
| 建卡时的检查 | 严格，逐条指出哪一行不行 | 硬约束与通用合规：必填字段、没装的依赖、没定义的动画 class、来源与许可证等（第 6、8 节） |

- 一张卡属于哪一种，**只看它的 `frameMode` 声明**，软件不会替你判定。写了 `"direct"` 就是在保证「这一帧的画面只由 t、参数和输入素材决定」，建卡检查按这个保证查你的源码。
- 字面量只有这两个：`"direct"`、`"stateful"`。旧项目里能读到的旧值 `"react"`、`"non-react"` **都按 motion 式读**（老卡不用重写），新卡不要再写它们。
- 素材效果卡（滤镜、转场、强调、音频，第 4.3 节）也要写 `frameMode`：只用 `at()` + GLSL 的写 `"direct"`，用了 `pixels()` 或自带状态的写 `"stateful"`。写 `"direct"` 的同样要引用框架，用不到工具就写一行裸导入（第 2.4 节）。
- 两种写法都写得出来的画面（例如标题的淡入上移）：差别就是上表的「怎么写」和「代价」两行。remotion 式要自己用框架写曲线，跳到哪一帧代价都一样；motion 式可以直接用 Motion 现成的曲线，代价是暂停、拖动到片段中间时要从片段起点推进。选哪一种由你按画面和维护方便来定。
- 现有的内置卡里两种写法的都有，都不用改写。

## 2. remotion 式写法

**一句话：这一帧的画面，只许用时间 t、参数、输入素材算出来。** 不读上一帧留下的东西，不读真实时间，不用自带时钟的动画，不用不带种子的随机数。

声明：`frameMode: "direct"`。时间 `t` 是组件收到的片段本地**秒**（从片段起点算，不是帧号）；组件签名里写 `{ params, t = 0 }`。例外：同时写了 `audio()` 的卡，收到的 `t` 已经加上了片段开头被裁掉的那一段（`sourceOffset`），没裁过的片段两者相同，见第 10 节。

### 2.1 框架

框架在 `src/kernel/remotionStyle/`，用户卡这样引：

```ts
import { interpolate, tween, spring, stagger, random, Easing } from "../../kernel/remotionStyle";
```

全是「时间 t 和参数 → 值」的纯函数，不读时钟、不记上一次的结果，同样的输入永远得同样的输出。**时间一律是秒。**

| 工具 | 写法 | 返回 | 例子 |
|---|---|---|---|
| `interpolate` | `interpolate(t, 时间点[], 取值[], { easing?, extrapolateLeft?, extrapolateRight? })`。时间点至少两个、一个比一个大，取值个数要一样多，否则抛错。`easing` 给一条，或每一段各给一条（数组）；缺省匀速。`extrapolateLeft` / `extrapolateRight` 只有两个值：`"clamp"`（缺省，停在端点）、`"extend"`（顺着最边上一段的斜率延伸） | 数 | `interpolate(t, [0, 0.4], [0, 1])`：0.4 秒内从 0 到 1，之后停在 1 |
| `interpolateColors` | `interpolateColors(t, 时间点[], 颜色[], 同上)`。颜色认 `#rgb`、`#rrggbb`、`#rrggbbaa`、`rgb()`、`rgba()` | `"rgba(r, g, b, a)"` | `interpolateColors(t, [0, 1], ["#ff0000", "#0000ff"])` |
| `tween` | `tween(t, { from = 0, to = 1, delay = 0, duration, easing = Easing.easeOut })`。`duration` 没有缺省，要写；`duration` 不大于 0 时没有过渡，`t` 到了 `delay` 就是 `to` | 数；开始前是 `from`，走完是 `to` | `tween(t, { from: 40, to: 0, delay: 0.2, duration: 0.5 })` |
| `Easing` | `linear` `quad` `cubic` `quart` `sin` `circ` `expo` `bounce`；`back(overshoot)` `elastic(bounciness)`；`in(e)` `out(e)` `inOut(e)`；`bezier(x1, y1, x2, y2)`；`steps(n, atEnd)`；现成的 `easeIn` `easeOut` `easeInOut`（三次曲线）；四个别名：`circle`（同 `circ`）、`exp`（同 `expo`）、`ease`（贝塞尔 `(0.42, 0, 1, 1)`，起步慢，不是那三条三次曲线）、`poly(n)`（进度的 n 次方，`poly(4)` 等于 `quart`） | 缓动函数 `(p) => 数` | `Easing.bezier(0.16, 1, 0.3, 1)`、`Easing.out(Easing.back(1.4))`。基础曲线都是「起步慢」的形状，要「起步快」就包一层 `Easing.out(...)` |
| `spring` | `spring(t, { stiffness = 100, damping = 10, mass = 1, from = 0, to = 1, delay = 0, velocity = 0, clamp = false })`：阻尼振子的解析解，给 t 直接算位置，不从头推。第一个参数是片段本地秒，不是 Remotion 的 `spring({ frame, fps, config })`：第一个参数不是数、或第二个参数里出现 `frame` `fps` `config`，直接报错 | 第 t 秒的位置；`delay` 之前是 `from`；`clamp: true` 不许越过终点 | `spring(t, { from: 0.6, to: 1, stiffness: 180, damping: 12 })` |
| `springDuration` | `springDuration(同一组参数, restRatio = 0.001)` | 停稳要多少秒（含 `delay`） | `springDuration({ stiffness: 180, damping: 12 })` 约 1.17 |
| `stagger` | `stagger(t, index, { each, delay = 0, from = "first", count })`；`from` 可以是 `"first"`、`"last"`、`"center"` 或一个下标；`last` 和 `center` 要同时给 `count` | 第 index 个元素自己的时间（还没轮到它是负数） | `tween(stagger(t, i, { each: 0.08 }), { duration: 0.4 })` |
| `staggerDuration` | `staggerDuration(count, 同一组 stagger 参数, 单个元素的时长 = 0)`；那组参数里的 `delay` 也算进总时长 | 整组走完要多少秒 | `staggerDuration(5, { each: 0.08 }, 0.4)` = 0.72 |
| `random` | `random(种子, ...序号)`，种子和序号是数或字符串；**必须给种子** | [0, 1) | `random(params.seed, i)`；要互不相干的第二个数就多加一个序号：`random(params.seed, i, "hue")` |
| `randomRange` | `randomRange(min, max, 种子, ...序号)` | [min, max) | `randomRange(-20, 20, params.seed, i)` |
| `randomInt` | `randomInt(min, max, 种子, ...序号)` | 整数，两头都取得到 | `randomInt(1, 6, params.seed, i)` |
| `randomPick` | `randomPick(数组, 种子, ...序号)` | 数组里的一个 | `randomPick(["#f43", "#3af"], params.seed, i)` |
| `noise` | `noise(x, 种子, ...序号)` | −1～1，随 x 平滑起伏；是 x 的函数，不是一步步累加的 | `noise(t * 2, params.seed, i) * 12`：「一直在轻轻晃」 |
| `clamp` `lerp` `loop` `pingPong` | `clamp(x, lo = 0, hi = 1)`、`lerp(a, b, p)`、`loop(t, period)`、`pingPong(t, period)` | 数。`loop` 返回 [0, period)，`pingPong` 返回 [0, period] | `loop(t, 2)` 每 2 秒从头走一遍；`pingPong(t, 1)` 0 → 1 → 0 来回走 |

名字和 Remotion 这个库里的同名工具对得上，但有两处不同，不要凭印象写：

- **时间是秒，不是帧。** 没有 `fps`、没有 `useCurrentFrame`；`delay`、`duration`、时间点都是秒。
- **`interpolate` 范围之外缺省是停在端点的值**（Remotion 缺省是继续延伸）。要延伸写 `{ extrapolateLeft: "extend", extrapolateRight: "extend" }`。

别的约定：

- **随机一律用 `random` 这一族，并给种子和序号。** 种子放进参数（`seed` 做成一个 `number` 控件），每个要随机的东西用自己的序号（下标，或 `i, "hue"` 这样），这样第 N 帧拿到的数和前面调过几次无关。
- **「一直在动」用 `loop`、`pingPong`、`noise`，不要自己累加。** 它们都是 t 的函数。
- **哪些值做成参数**（和第 5 节一致）：使用者（用户或 Agent）会说「再快一点、再大一点、换个颜色」的值，放进 `controls` / `defaults`（见第 4.2、5 节）；卡自己的设计常量——缓动曲线的形状、弹簧的刚度与阻尼、进场上移的距离——可以写成文件开头起了名字的 `const`（例一的 `POP`、`LINE_EASE`）。模块顶层只写常量。这不是检查强制的，是为了以后改起来省事。
- `lifecycle.settleMs` 是毫秒，从片段起点算（不是时长）；落定时刻可以用 `springDuration`、`staggerDuration` 算出秒数再乘 1000，参数会变的卡写进 `timing`（例一、例二都有）。

### 2.2 例子

下面三个都是完整的卡，原样可以建（`id` 换成自己的）。写 remotion 式的卡可以直接从它们改起。

**例一：逐字弹入的标题**（弹簧、错开进场、颜色过渡、插值、`timing`）

```tsx 完整卡片
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
  name: "逐字弹入标题",
  description: "标题一个字一个字弹上来，随后一条下划线从左展开",
  source: "user",
  useWhen: "框架示例：要一行大标题逐字出现时用。",
  tags: ["标题", "示例"],
  frameMode: "direct",
  defaults: { text: "由 t 直接算", accent: "#ffd166", size: 132, each: 0.07 },
  controls: [
    { key: "text", label: "文字", type: "text" },
    { key: "accent", label: "主色", type: "color" },
    { key: "size", label: "字号", type: "number", min: 24, max: 240, step: 4 },
    { key: "each", label: "每个字相隔(秒)", type: "number", min: 0, max: 0.5, step: 0.01 },
  ],
  Component: TitleReveal,
  timing: (p) => ({ settleMs: Math.round((staggerDuration([...p.text].length, { each: p.each }, springDuration(POP)) + 0.8) * 1000) }),
  lifecycle: { settleMs: 2000, after: "hold", exit: ["fade"] },
};
```

**例二：随机柱状图**（带种子的随机、从中间往两边错开、`noise` 起伏）

```tsx 完整卡片
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
  name: "随机柱状起伏",
  description: "一排高度随机的柱子从中间往两边长出来，长好后轻轻起伏",
  source: "user",
  useWhen: "框架示例：要一组带种子的随机柱子时用。",
  tags: ["柱状", "随机", "示例"],
  frameMode: "direct",
  defaults: { count: 14, seed: 7, accent: "#ffffff" },
  controls: [
    { key: "count", label: "柱子个数", type: "number", min: 1, max: 24, step: 1 },
    { key: "seed", label: "随机种子", type: "number", min: 0, max: 9999, step: 1 },
    { key: "accent", label: "强调色", type: "color" },
  ],
  Component: BarRace,
  // 柱子个数可调，最后一根长好的时刻跟着变：落定时刻用 staggerDuration 按个数算（每根 0.7 秒长高再加 0.3 秒起伏淡入）
  timing: (p) => ({ settleMs: Math.round(staggerDuration(Math.max(1, Math.min(24, Math.round(p.count))), { each: 0.06, from: "center" }, 1.0) * 1000) }),
  lifecycle: { settleMs: 1400, after: "evolve", exit: ["fade"] },
};
```

**例三：画布上的环绕光点**（画布类的卡：每一帧先清空，整张重画）

```tsx 完整卡片
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
    // 每一帧从空白开始整张重画：画布上不留上一帧的像素
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
  name: "环绕光点",
  description: "画布上的一圈光点绕着中心转，位置和大小由种子决定",
  source: "user",
  useWhen: "框架示例：要用画布画一组按时间直接算位置的点时用。",
  tags: ["画布", "光点", "示例"],
  frameMode: "direct",
  defaults: { count: 160, seed: 11, color: "#9bf6ff", speed: 1 },
  controls: [
    { key: "count", label: "光点个数", type: "number", min: 1, max: 400, step: 1 },
    { key: "seed", label: "随机种子", type: "number", min: 0, max: 9999, step: 1 },
    { key: "color", label: "颜色", type: "color" },
    { key: "speed", label: "转速", type: "number", min: 0, max: 4, step: 0.1 },
  ],
  Component: OrbitCanvas,
  lifecycle: { settleMs: 1200, after: "evolve", exit: ["fade"] },
};
```

### 2.3 写法要点

- **文件顶层只写 `import`、类型、函数和 `const` 常量**，常量的初始化式里不用 `new`、不用 `await`、不赋值。查表用对象或数组字面量；要用 `Map`、`Set`、类的实例就放进函数里现算。
- **React 的 hook：不能用记状态的那一类**（`useState`、`useReducer`、`useSyncExternalStore`、`useTransition`、`useDeferredValue`、`useOptimistic`、`useActionState`）。它们记的值活得比一帧长，画面就不再只由 t 和参数决定。可以用 `useMemo`（缓存由参数算出来的东西）、`useEffect`、`useLayoutEffect`（往画布上画）、`useId`。
- **`useRef` 只写 `useRef(null)`**，用来拿 DOM 节点（上面例三）。带初值的 `useRef(0)`、往 `.current` 里写，都是在把东西带到下一帧。
- **画布类的卡，每一帧先 `clearRect` 再整张重画**，画布上不留上一帧的像素（例三）。
- **异步准备用 `beginFrameWork` 挡住截图。** 要等图片解码、等一份数据、等字体才能画对的卡，在 effect 里调 `beginFrameWork("名字")` 领一张票；准备好了调 `ready.ready()`，失败调 `ready.fail(错误)`；effect 清理时（卸载，或下一帧 `t` 变了重跑之前）一定调 `ready.dispose()` 退票。预渲染和导出每一帧截图前会等所有没退的票，失败会明确报错、不会截一张半成品。图片对象用 `useMemo` 按 `src` 缓存，别每一帧新建：

```tsx
import { beginFrameWork } from "../../kernel/frameReady";
// 组件里
const img = useMemo(() => { const i = new Image(); i.src = params.src; return i; }, [params.src]);
useLayoutEffect(() => {
  const ready = beginFrameWork("封面图");               // 领票
  let stale = false;
  img.decode().then(
    () => { if (!stale) draw(img, t); ready.ready(); },  // 解码好了：按这一帧的 t 画，再通知就绪
    (e) => ready.fail(e),                                 // 失败：明确报错
  );
  return () => { stale = true; ready.dispose(); };      // 卸载或下一帧到来时退票
}, [img, t]);
```

- **字体和 `<img>` 即使不领票，截图也会等它们加载完**；但「先画一版、加载好再换一版」这种写法仍然不对：画面要在准备好之后才画，且只画一版。
- 在 `CardProps` 里 `t` 是可选属性（`t?: number`），所以组件里解构时写 `t = 0` 当缺省；但 remotion 式的卡画面就是 t 的函数，一定要读它。

### 2.4 建卡时会被当场拒绝的写法

声明了 `frameMode: "direct"` 的卡，`create_card` 和 `edit_card` 会逐条检查源码，**违规的每一条都带行号**报回来，形如 `[remotion 式] 第 6 行：用了不带种子的随机（Math.random）：……`，照着改再调一次。

| 写法 | 为什么不行 | 改成 |
|---|---|---|
| 引用名单之外的模块（含同目录的辅助文件 `./xxx`、样式文件、没列在名单里的第三方库），动态 `import()`、`require()` | remotion 式的卡只许引用 2.5 节名单里的模块 | 改用框架和名单里的模块；辅助函数写进同一个文件 |
| `motion` / `motion/react`、`<motion.div>`、`whileHover` 这类交互属性 | Motion 的动画和弹簧按真实时间自己往前走，跳到某一帧算不出那一帧；导出时也没有鼠标和滚动 | 用框架的 `tween`、`spring`、`stagger`，写成 t 的函数；要它出现就写 t 的条件 |
| `<AnimatePresence>` | 进出场组件靠「上一帧有、这一帧没有」播退场，是在读前一帧的状态 | 出场、退场写成 t 的条件和过渡：该出现的时间段里渲染它，透明度、位移由 `tween` / `interpolate` 按 t 算 |
| CSS 动画与过渡：样式里的 `animation*`、`transition*`；样式文本里的 `@keyframes`；类名 `animate-*`、`transition*`；元素的 `.animate()`；SVG 的 `<animate>` | 它们跟着真实时间走，机器一卡就对不上帧 | 把随时间变的样式写成 t 的函数，直接写进 `style`（样式里写 `"none"` 的不算违规） |
| `Date.now()`、不带参数的 `new Date()`、`performance` | 读真实时间；导出和预渲染走的是舞台自己的帧时钟 | 用组件收到的 `t` |
| `setTimeout`、`setInterval`、`setImmediate`、`requestIdleCallback` | 定时器按真实时间触发，不跟着帧走 | 「过一会儿再出现」写成 t 的条件，或 `tween` / `stagger` 的 `delay` |
| `requestAnimationFrame`、`cancelAnimationFrame`、`setAnimationLoop`、`requestVideoFrameCallback` | 浏览器逐帧回调回调几次、隔多久都不确定 | 舞台每一帧会带着新的 t 重新渲染这张卡，画面写成 t 的函数就行 |
| `Math.random`、`crypto` | 不带种子，每调一次往前走一步，直接跳到第 N 帧就对不上 | `random(种子, 序号)` 这一族 |
| `useState` 等记状态的 hook | 记的值活得比一帧长 | 随时间变的量由 t 直接算；要缓存只用 `useMemo` |
| `useRef(初值)`、往 `.current` 里写 | ref 里存的值活得比一帧长 | ref 只用来拿 DOM 节点：`useRef(null)` |
| 往文件顶层的名字或导入的东西里写（赋值、自增、`delete`、`push` 这类会改内容的方法、`Object.assign`） | 它活得比一帧长，上一帧写进去的东西下一帧读得到 | 不要存；随时间变的量由 t 算 |
| `window`、`globalThis`、`self`、`localStorage` 等全局对象，`eval`、`Function()` | 全局对象和本地存储活得比一帧长；运行时拼出来的代码建卡时查不了 | 不用 |
| 顶层的 `let` / `var` / `class` / `enum`、直接执行的语句，顶层初始化式里的 `new`、`await`、赋值 | 顶层必须只有常量，载入时才能整体锁成只读 | 只写 `const` 常量；要 `new` 的放进函数里 |
| `IntersectionObserver` | 卡片挂载即播放，不存在「滚动进入视口」（所有卡都不许） | 不用 |
| `frameMode` 写成变量或算出来的值 | 建卡时读不出这张卡是哪种写法，「以声明为准」就落空了 | 直接写字面量 `"direct"` 或 `"stateful"` |
| 没有一句引用框架的 import（只带类型的 `import type …` 不算） | 载入时只给引用了框架的卡把文件顶层锁成只读；不引用就不上锁，绕一道变量往顶层的对象里写查不出来。报错指到 `frameMode` 那一行 | 用到工具的照常写 `import { tween } from "../../kernel/remotionStyle";`；用不到工具的（只用 `t` 做算术的卡、只用 GLSL 的素材效果卡、只有声音的卡）在文件开头写一行裸导入 `import "../../kernel/remotionStyle";` |

**另外：**

- 末尾会多一句不带行号的总说明，提醒这张卡声明的是 remotion 式；要从起点一帧帧推进才能得到画面的效果，是另一种声明 `frameMode: "stateful"`（第 3 节）。
- 只在建卡、改卡时检查。已经在库里的卡（内置卡、以前建的卡）照旧载入、照旧运行，不会因为多了检查而坏。
- 改一张**框架出现之前建的、没有引用框架**的 remotion 式老卡，只拒绝这次编辑**新增**的违规，原来就有的不追究（「没有引用框架」这一条也不强求它补）。一旦这张卡引用了框架，从那一刻起每一条都要改掉。两种写法互相改：把 motion 式的卡改成 remotion 式，按新建卡检查（每一条违规都拒）；把 remotion 式的卡改成 motion 式，就不再归这一节的检查管，按 motion 式的检查走。
- 引用了框架的卡载入时，文件顶层的对象会被整体锁成**只读**，往里写当场报错。新建的 remotion 式的卡都必须引用框架，所以都会上锁；裸导入同样算引用。
- 这一节的检查看的是语法树，不是文本匹配：注释里写到这些词不会被拦；字符串和类名里的 `animate-*`、`transition`、`@keyframes` 会被查。（motion 式那三条老规矩——`Date.now()`、`setTimeout` / `setInterval`、`IntersectionObserver`——是文本匹配，注释里写出这几个词也会被拦。）

### 2.5 remotion 式的卡可以引用的模块

用户卡在 `src/cards/user/` 下，路径照下面写：

| 模块 | 给什么用 |
|---|---|
| `react`、`react/jsx-runtime` | 组件，和不记状态的 hook |
| `../../kernel/remotionStyle` | 框架（2.1 节）。**必须引用**：用不到工具时写裸导入 `import "../../kernel/remotionStyle";` |
| `../../kernel/types` | `CardDef`、`CardProps` |
| `../../kernel/frameReady` | `beginFrameWork`：异步准备好之前挡住截图 |
| `../../kernel/soundEffects`、`../native/sound-effects` | 声音配方与 `cardSoundBlock`（纯计算，给有声卡用） |
| `../../render/cards/graphValues` | 素材效果卡的出口 `glsl`、`draw`、`bitmap` |
| `../native/hud` | 位置与主色的约定 |
| `../magicui/vendor/cn` | 拼类名 |

只带类型的导入（`import type …`）不限。**不在名单里的**：`motion`、`motion/react`；`lottie-web`、`@tsparticles/*`（它们自带时钟或内部取随机；放 Lottie 动画用内置的 `lottie` 卡和素材封装卡，那两种是 remotion 式的，播放库的随机数由卡片固定住，见第 3 节）；`three`；同目录的别的文件与样式文件（样式文件里的动画建卡时看不见）。

### 2.6 检查查不出来、但同样不许的写法

建卡检查只看源码，下面这些它看不出来，要自己守：

- **画布不清就接着画。** 画布本身就活得比一帧长，上一帧的像素会留着。每一帧先 `clearRect` 再画。
- **往 DOM 节点上存东西**（`el.dataset.n`、往节点上挂属性）。
- **往 `params` 里写。**（所有卡都不要往 `params` 里写，见第 7 节。）
- **绕一道变量，往别的模块导出的对象里写。**
- **没引用框架的 remotion 式新卡，绕一道变量往自己顶层的对象里写**（它不会被载入时锁只读）。
- **依赖「谁先加载好」**：字体、图片等齐了再画，不能先画一版再变（用 `beginFrameWork`，见 2.3）。

## 3. motion 式写法

声明：`frameMode: "stateful"`。画面有状态，要从片段起点一帧帧推进才能得到目标帧。**这是和 remotion 式并列的正式写法，内置卡里两种写法的都有，都不用改写。**

**适合什么：**

- 用 Motion 现成的动画：`initial` / `animate` / `transition`、弹簧、`AnimatePresence` 进出场、布局动画。写起来省力，曲线现成。
- CSS 关键帧与过渡。
- 一帧依赖上一帧的效果：粒子（`@tsparticles`）、物理模拟、自己累积状态的 JS。
- 自己直接引 `lottie-web` 的卡（按帧定位用 `goToAndStop(frame, true)`，不要 autoplay）。**放一段 Lottie 动画不需要这样做**：通用的 `lottie` 卡（把 JSON 文本或 URL 填进参数）是内置的 remotion 式卡，播放库表达式里的 `random()`、`wiggle()` 和文字的随机顺序由卡片固定住，跳到哪一帧都和顺着播到那一帧相同；素材目录里的 Lottie 已经是现成的卡，见 4.6 节，不要重写。自己引 `lottie-web` 的卡拿不到这层固定（带随机表达式的素材，画面会随推进的方式变），而且 `lottie-web` 不在 remotion 式的模块名单里（第 2.5 节），只能声明 `"stateful"`。
- three（三维画面写成 t 的纯函数，t 变了再显式 render 一次；参考 `src/cards/native/scene-3d.tsx`）。three 不在 remotion 式的模块名单里（第 2.5 节），所以用它的卡声明 `"stateful"`。

**代价：**

- 暂停、拖动到片段中间时，要从片段起点（挂载那一帧）重新推进到那一帧，片段越长越慢。
- 预渲染要为它存每一帧的快照（暂停和拖动时贴）。
- 画面对「推进过程」敏感：同一个 t，顺着推和直接推到，结果应当一样——所以仍然不能读真实时间。

**规矩（比 remotion 式宽，但这几条是硬的）：**

- 不用 `Date.now()`、`new Date()`：导出走的是虚拟时间，读真实时间会和画面对不上。
- 不用 `setTimeout` / `setInterval` 驱动动画：它们不受虚拟时钟控制。动画交给 `motion/react`，需要按时间推进就读组件收到的 `t`。
- 不用 `IntersectionObserver`：卡片挂载即播放。
- 不自己跑帧循环（`setAnimationLoop`、`requestAnimationFrame` 配三维），不靠鼠标、滚动、hover 驱动（第 6 节的审查表）。
- 可以用 `Math.random`（舞台把它钉成了带种子的），但它每调一次往前走一步，结果取决于调用的先后。要让同一个 `t` 不管怎么跳转都得到同一个随机数，用框架的 `random(种子, 序号)`（第 2.1 节；它只依赖种子和序号，motion 式的卡也可以引用）。
- 挂载即播放：`motion` 自己会把动画走完，**绝大多数用 Motion 的卡不需要读 `t`**。只有「跟着时间轴走」的卡（字幕轨按时间切换当前句、章节导航按时间高亮）和按 `t` 显式渲染的卡（三维卡；自己引 `lottie-web` 按帧号定位的卡把 `t` 换算成帧号）才读 `t`；这样的卡在 `useWhen` 里说明它需要 clip 覆盖整段时间，而不是一小截。
- Motion 的其它写法（`type: "spring"` 的弹簧、关键帧数组、`delay`、`repeat`）都可以用，照 Motion 自己的文档写。导出时舞台的虚拟时钟管着 Motion 的帧循环，也把 CSS 与 Web Animations 的动画钉在「舞台时间减去它出现时的舞台时间」上，所以无限循环（`repeat: Infinity`）的动画在导出里的相位也只由时间决定；这样的卡落定之后的行为写 `after: "loop"` 或 `"evolve"`（第 4.4 节）。

### 3.1 例子：价格标签

下面是一张 motion 式的 DOM 卡（remotion 式的 DOM 卡见第 2.2 节）：

```tsx 完整卡片
import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";

/** 这张卡认哪些参数 */
interface Params {
  text: string;
  accent: string;
  size: number;
}

function PriceTagCard({ params }: CardProps<Params>) {
  // 挂载即开始播放。不要写「进入视口才播」这类逻辑。
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
  id: "price-tag",              // 小写 kebab-case，全局唯一，必须和 create_card 传的 id 一致
  name: "价格标签",              // 界面上显示的名字
  description: "价格数字带弹跳浮现",  // 一句话说清长什么样
  source: "user",               // AI/用户建的卡一律填 "user"
  useWhen: "口播报价格、报价区间时，把价格做成主视觉。只是陈述普通数字用 stat-proof。",
  tags: ["价格", "数字", "标签"],
  frameMode: "stateful",        // 必填：Motion 的动画要从起点推进，所以是 motion 式
  defaults: { text: "¥199", accent: "#ffd166", size: 96 },
  controls: [
    { key: "text", label: "文字", type: "text", hint: "要显示的价格，含货币符号" },   // 有像样的默认值，所以不标 required（见 4.2）
    { key: "accent", label: "主色", type: "color" },
    { key: "size", label: "字号", type: "number", min: 24, max: 240, step: 4 },
  ],
  Component: PriceTagCard,
};
```

## 4. CardDef 契约

### 4.1 字段说明

先看一张卡的全部字段。**两种写法、素材效果卡都是同一个 `CardDef`**，下面是它的形状（`?` 是可以不写的）：

```ts
interface CardDef<Params> {
  id: string;  name: string;  description: string;  source: "user";
  useWhen?: string;  tags?: string[];
  frameMode: "direct" | "stateful";                           // 必填，第 1 节
  defaults: Params;  controls: Control[];                     // 第 4.2、5 节
  Component?: (props: CardProps<Params>) => JSX.Element;      // 画面（DOM 卡）
  card?: …;  audio?: …;  kind?: …;  inputs?: …;               // 素材效果卡的出口，第 4.3 节
  parts?: CardPart[];                                         // 部件树，第 4.4 节
  lifecycle?: { settleMs?: number; after: "hold" | "loop" | "evolve"; exit: ["fade"] };
  timing?: (params: Params) => { settleMs?: number; parts?: Record<string, { enterMs?: number; settleMs?: number }>; after?: "hold" | "loop" | "evolve" };
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | 小写 kebab-case。不能用 `mu-` 前缀（留给 Magic UI），不能用 `lottie-` / `particles-` 前缀（留给素材封装卡），不能和现有卡重名 |
| `name` | ✓ | 中文短名，显示在卡片库里 |
| `description` | ✓ | 一句话说清**外观和动效** |
| `source` | ✓ | 建新卡固定填 `"user"` |
| `useWhen` | 强烈建议 | **什么时候该选这张卡**，写给以后的 AI 看。写清触发条件，以及和近义卡怎么区分（「XX 情况用这张，YY 情况用另一张」；不知道有哪些近义卡就先 `list_cards()` 看，拿不到列表时写清这张卡做什么、不做什么，不要引用没确认过存在的卡 id）。不写的话这张卡以后基本不会被选中 |
| `tags` | 建议 | 检索关键词 |
| `defaults` | ✓ | 每个参数的默认值。见 4.2 节「默认值规则」 |
| `controls` | ✓ | 参数控件表。界面面板和 AI 都靠它了解 schema |
| `frameMode` | ✓ | **必填，只能是字面量 `"direct"`（remotion 式）或 `"stateful"`（motion 式）**，选法见第 1 节。不写、写成变量都会被 `create_card` 拒绝。旧值 `"react"`、`"non-react"` 只为读老项目，都按 motion 式读，新卡不要写 |
| `Component` / `card` / `audio` | 至少写一个 | `Component` 是 React 视觉组件，可以同时声明 `audio`；`card` 是视觉素材效果卡的出口，与 `Component` 二选一；`audio` 是音频出口，可以单独写，也可以和 `Component` / `card` 一起写（第 4.3 节） |
| `parts` | 建议 | **部件树**(约定封装的结构):这张卡对外由哪几块组成,每块由哪些参数驱动、什么时候进场、多久落定。代码页和 `get_clip` 按它组织参数。见下面「部件树与生命周期」 |
| `lifecycle` | 建议 | **生命周期**(约定封装的时间):进场多久落定(`settleMs`，毫秒)、之后 `hold` 停住 / `loop` 循环 / `evolve` 持续变化、支持的退场(`exit`,目前写 `["fade"]`)。见 4.4 节 |
| `timing` | 看情况 | 落定时刻随参数变的卡再给：`(params) => ({ settleMs?, parts?, after? })`，见 4.4 节 |

### 4.2 默认值规则（重要）

`clip.params` 是**稀疏覆盖层**，渲染时才和 `defaults` 合并。所以默认值必须是「不填也说得过去」的东西。

- 能给出合理默认的参数：给一个像样的默认值，让卡片一加上去就有效果。
- **内容只能来自外部、给不出有意义默认值的参数**（比如字幕正文、转写文本）：
  默认值留空 **并且** 在 control 上标 `required: true`。

  别放演示文案当默认值。曾经字幕卡的 `lines` 默认放了三行样例，结果 AI 建卡时漏传 `lines`，
  画面照播那三行与视频无关的文案，看上去像「字幕加好了」——失败被默认值盖住，没有任何一处报错。

标了 `required` 的参数，`add_clip` / `update_clip` 会在写入前校验，为空直接报错。校验的是**合并之后**的结果（`defaults` + 已有参数 + 这次写入的键）：所以只有默认值留空的必填参数，漏传才会报错；默认值非空的参数标 `required` 不起作用，不要标。
`hint` 会一起返回给 AI，写清格式和取值范围。

### 4.3 素材效果卡路线

当需求需要现有参数做不到的**滤镜、转场、音频算法或多输入合成**时，写一张**素材效果卡**。素材效果卡不是另一套体系：它就是一张普通的 `CardDef`，源码同样是 `src/cards/user/<id>.tsx` 一个文件，同样用 `create_card` 落盘、`get_card_source` + `edit_card` 修改。视觉的素材效果卡写 `card()`，声音写 `audio()`，由宿主分别求值。动效卡可以在**同一张 `CardDef` 里**同时写视觉 `Component` 或 `card()` 与 `audio()`，画面和声音属于同一个时间轴片段（有声动效卡，规则见第 10 节）。

建卡和应用是**两步**：`create_card({ id, source })` 落盘定义，再 `apply_card({ cardId, clipId, ... })` 建实例。

#### 契约

在普通 `CardDef` 的字段之上，素材效果卡多这几项：

| 字段 | 说明 |
|---|---|
| `kind` | `"animation"` / `"filter"` / `"transition"` / `"emphasis"` / `"audio"`，缺省 `"animation"` |
| `inputs` | `Record<string, { description?: string }>`。`filter` / `emphasis` / `audio` 缺省 `{ source: {} }`，`transition` 缺省 `{ A: {}, B: {} }`，`animation` 缺省无输入 |
| `card` | `(sources, t, params, ctx) => CardGpuValue \| Promise<CardGpuValue>`，视觉素材效果卡的出口 |
| `audio` | `(sources, range, params) => Float32Array \| Promise<Float32Array>`，音频素材效果卡的出口 |
| `Component` | DOM 视觉出口；可以与 `audio` 同时存在。视觉 `card` 与 `Component` 二选一，纯音频卡只写 `audio` |

- `sources[name]` = `{ nodeId, at(t?), pixels(t?, signal?), block(start, count) }`。
  - `at(t)` 返回一个**惰性引用**（不落像素），直接喂给 GLSL；这是默认、也是最便宜的一条路。
  - `pixels(t)` 才真的解出 `ImageBitmap`，CPU 像素算法才用它，会明显变慢。
  - `block(start, count)` 取音频采样块。
- `t` 是**片段本地秒**（不是时间轴绝对时间）。
- `range` = `{ start, count, sampleRate: 48000 }`，`start` / `count` 是采样位置和采样数；返回的样本数和起点必须和请求**完全一致**。
- `ctx` = `{ fps, width, height, duration, stage }`。
- `params` 是 `defaults` 合并实例参数后的结果，和 TSX 卡里的 `params` 同一口径。

帮助函数在 `src/render/cards/graphValues`：

- `glsl(fragment, inputs, uniforms)` —— GPU 片元着色器。输入纹理依次叫 `u_input0`、`u_input1`…，UV 是 `v_uv`，输出写进 `outColor`；**着色器必须自己声明用到的每一个 uniform**，传值不会自动补声明。
- `draw(commands)` —— 绘制指令。
- `bitmap(image)` —— 把 `ImageBitmap` / `ImageData` / `OffscreenCanvas` 直接当结果交出去，是 CPU 像素算法的出口。

**能力声明只写 `frameMode`**：只用 `at()` + GLSL 的素材效果卡写 `"direct"`；用了 `pixels()` 或自带状态的写 `"stateful"`。**不要在源码里写 `compositing: 'independent'`**（写了会被 `create_card` 拒掉）——这个值只认人工审阅表 `src/cards/capabilities.json`；别的 `compositing` 值写在源码里不作数。卡建出来之前按 `unknown` 走最保守的一条路，由人审阅后再加 `independent`。第一版素材效果卡也**不要**声明 `canvasHeavy`。

**写成 `"direct"` 的素材效果卡同样要引用框架。** 下面三个例子的画面由 GLSL 和 `t` 直接算（或者直接对音频块做乘法），用不到框架的工具，所以各写一行裸导入 `import "../../kernel/remotionStyle";`；另外只引了 `../../kernel/types` 和 `../../render/cards/graphValues`，都在 2.5 节的名单里。引用以后，这张卡载入时文件顶层的对象会被锁成只读（着色器字符串和卡片定义不受影响）。它们仍然要过 2.4 节的检查——名单之外的模块不能引、顶层只写常量、不读真实时间、不用 `Math.random`——例子里的写法都满足。

#### 例一：GLSL 反色滤镜

```tsx 完整卡片
import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

interface Params { amount: number }

export const invertFilter: CardDef<Params> = {
  id: "invert-filter",
  name: "反色滤镜",
  description: "把输入画面按强度混向它的反色，0 是原样、1 是完全反色",
  source: "user",
  useWhen: "要给一段素材或一张素材效果卡加整体反色 / 负片观感时用。只调色温亮度用调色参数，不要为此建卡。",
  tags: ["滤镜", "反色", "负片"],
  kind: "filter",
  frameMode: "direct",
  inputs: { source: { description: "要处理的画面" } },
  defaults: { amount: 0.5 },
  controls: [
    { key: "amount", label: "强度", type: "number", min: 0, max: 1, step: 0.01 },
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

用 `create_card({ id: "invert-filter", source })` 落盘，再 `apply_card({ cardId: "invert-filter", clipId: "clip-a" })` 套到某一段上。不传 `inputs` 时：那个片段上已经有素材效果卡就自动接它的输出（「先反色再模糊」是自然动作），否则接这一段的原始素材。

#### 例二：双输入 crossfade 转场

```tsx 完整卡片
import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

interface Params { duration: number }

export const crossfade: CardDef<Params> = {
  id: "crossfade",
  name: "交叉溶解",
  description: "A 画面在给定时长内均匀溶解到 B 画面",
  source: "user",
  useWhen: "两段素材之间要一个最朴素的溶解转场时用。要带方向的推拉擦除另建卡。",
  tags: ["转场", "溶解", "crossfade"],
  kind: "transition",
  frameMode: "direct",
  inputs: { A: { description: "转场前的画面" }, B: { description: "转场后的画面" } },
  defaults: { duration: 1 },
  controls: [
    { key: "duration", label: "时长(秒)", type: "number", min: 0.1, max: 5, step: 0.1 },
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

钳位写在 GLSL 里。两个输入用 `apply_card` 指名：`apply_card({ cardId: "crossfade", trackId: "main", start: 3, end: 4, inputs: { A: { clipId: "clip-a" }, B: { clipId: "clip-b" } } })`。`inputs` 里的 `{ clipId }` 指素材段就是该素材，指素材效果卡片段就是那张卡的输出；`{ nodeId }` 直接接另一个节点的输出；`offset`（秒）和 `rate`（倍率）定义该输入的局部时间映射。

#### 例三：增益音频卡

```tsx 完整卡片
import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";

interface Params { gain: number }

export const gainAudio: CardDef<Params> = {
  id: "gain-audio",
  name: "增益",
  description: "把输入音频按倍数放大或衰减，采样范围原样返回",
  source: "user",
  useWhen: "一段声音整体偏轻或偏响，又不想改素材本身时用。",
  tags: ["音频", "增益", "音量"],
  kind: "audio",
  frameMode: "direct",
  inputs: { source: { description: "要处理的声音" } },
  defaults: { gain: 1.5 },
  controls: [
    { key: "gain", label: "增益", type: "number", min: 0, max: 4, step: 0.05 },
  ],
  audio: async (sources, range, params) => {
    const block = await sources.source.block(range.start, range.count);
    const out = new Float32Array(block.length);
    for (let i = 0; i < block.length; i++) out[i] = block[i] * params.gain;
    return out;
  },
};
```

音频卡 `kind: "audio"`，样本是交错的 `float32`（frames × channels）。**返回的样本数和起点必须和 `range` 完全一致**，非有限样本会被拒绝。音频素材效果卡只写 `clip.nodeId`、不写 `clip.cardId`，所以画面上不会多出一层；时间轴上，同一个片段**不能**同时挂「纯音频素材效果卡」（`kind: "audio"`、没有视觉出口，走 `apply_card`、挂在 `clip.nodeId` 上）和视觉素材效果卡——它们是两个节点（要两样就先复制片段）；这和上面「同一张卡里既有画面又有 `audio()`」是两回事。输入边上的 `rate ≠ 1` 第一版不支持。

#### 第一版的边界

- 素材效果卡的输入只接**素材节点**和**别的素材效果卡节点**；接 DOM 卡（普通 TSX 卡）会被 `apply_card` 拒掉。
- 传当前 `clip.nodeId` 给 `apply_card` = 原地改这个实例的参数和输入（不传 `inputs` 时继承旧的），不会接成自指。
- 改源码先 `get_card_source` 再 `edit_card`，不要建重复定义；同一张定义可以有多个参数不同的实例。做完用 `see_frames` 看实际效果。

### 4.4 部件树与生命周期(约定封装)

Agent 和代码页看到的不是组件源码,而是一份固定形状的**封装**(`get_clip` 返回的对象):card + lifecycle、time、frame、blend、parts、params。
组件源码只在建卡 / 改卡时经过审查门落盘一次,之后**只通过封装操作**。所以一张卡要把自己的结构和时序说清楚:

```ts
  parts: [
    { id: "title", label: "小标题", role: "text", params: ["title"], enterMs: 0, settleMs: 600 },
    { id: "items", label: "要点", role: "list", params: ["items", "stepMs"], enterMs: 300, settleMs: 1100 },
  ],
  lifecycle: { settleMs: 1100, after: "hold", exit: ["fade"] },
```

- `parts[].role` 只有五个取值：`"text"`（文字）、`"media"`（图、动画、画布）、`"list"`（列表）、`"decor"`（装饰，例如背景圆点、进度条）、`"group"`（分组，可以带 `children`）。
- `parts[].params` 里的键必须是 `controls` 里真有的;一个参数只归一个部件。种子、个数、颜色这类不属于哪一块的参数可以不写进任何部件。没写 `parts` 的卡，所有参数都归一个叫 `root` 的根部件。
- `enterMs` / `settleMs` 都是**从片段起点算的毫秒时刻**：`enterMs` 是这一块什么时候开始进场，`settleMs` 是它什么时候落定（= 开始时刻 + 动画时长，不是时长本身）；列表按最后一项算。用 Motion 的卡按它的 delay / duration 相加（弹簧按 +400ms 估，弱阻尼、位移大的弹簧不一定准）；remotion 式的卡用框架的 `springDuration`、`staggerDuration` 算（第 2.1 节），是准的。
- `lifecycle.settleMs` 是整张卡最晚落定的时刻（同样是从片段起点算的毫秒）。Agent 据此知道「这段 clip 后面几秒是静止的」,该缩短时长还是加淡出。
- `lifecycle.after`：`hold` 落定后停住不动；`loop` 整段进场动画一遍遍重来；`evolve` 落定后画面仍在持续变化（脉动、起伏、绕转、粒子、跟着时间轴走）。
- `lifecycle.exit` 目前写 `["fade"]`（用片段的淡出整体淡出）。
- 没写这两个字段的卡按「一个根部件、有进场动画、之后停住、只支持淡出」处理,不报错。
- **时序随参数变的卡(条目数、字数、间隔、速度决定落定时刻)再给一个 `timing`**:`timing: (p) => ({ settleMs, parts: { items: { settleMs } }, after? })`,
  封装每次读的时候按 clip 的实际参数重算,和 frame 的 local → world 一样是派生量、不落盘;`parts` / `lifecycle` 里的静态值只当默认参数下的参考。`timing` 返回的 `parts` 可以只写会变的那几块。

### 4.5 部件库与组合卡(自由组合不用建卡)

要「标题 + 要点 + 一个环形指标」这种现成卡里没有的搭配,**不要 create_card 写新卡**,用组合卡:

- `list_parts` 看部件库(src/parts/lib,每个部件是可独立渲染的最小单元:标题、要点、环形指标、排行条、Lottie……);
- `add_composite({ start, duration, parts: [{ partId, params?, frame?, enterMs? }, …] })` 一次搭好,或先建空的再 `add_part`;
- `set_part` / `remove_part` / `move_part` 改参数、框、进场时机、次序和父子关系;`get_clip` 里 parts 每个实例带 partId、frame.local(相对父框,可写)、frame.world(画面绝对位置,只读)、enterMs、settleMs。
- 有文字的部件都带 `size` 参数,`size` 填 0 = 按框自适应(默认),填正数 = 固定像素;不确定就留 0,只摆框。
- 部件的框相对**父框**:根部件的父框是组合卡的画布(默认整个舞台,set_rect 缩小组合卡整棵跟着缩),子部件的父框是父部件的框。次序靠后的画在上面。

写新部件(给部件库添零件)放 src/parts/lib/<id>.tsx,契约见 src/kernel/partTypes.ts:根元素 absolute inset 0、在自己的框里排版、不带整屏定位参数、给 defaultFrame 和 settleMs;有文字就加 `size` 参数(默认 0),用 `fitOr(params.size, { width, height, text })` 算字号。

### 4.6 素材封装卡(不要再手写)

素材目录里的 Lottie 动画和粒子配置**已经是卡**:`lottie-<name>`、`particles-<name>`(src/cards/assets,构建时由目录生成)。
它们是「动效素材 → 函数翻译 → 约定封装」的产物:原始文件留在目录里,组件复用 LottieView / ParticlesView,
对外只有翻译出来的旋钮(粒子卡露出配置里真有的数量 / 速度 / 大小 / 颜色 / 不透明度 / 连线)。
想用某个素材就 `add_clip({ cardId: "lottie-adrock" })`,**不要**去读素材 JSON、不要用 create_card 再包一层;
`lottie-` / `particles-` 前缀是保留命名空间。
Lottie 的封装卡和通用的 `lottie` 卡是 remotion 式的(每一帧把时间换算成帧号直接算,播放库里的随机数由卡片固定住);粒子的封装卡是 motion 式的。

### 4.7 引用素材库里的图片 / 视频

卡片参数里要放素材库的文件(图片卡的图、`scene-3d` 的 `texture`、背景视频……),**填 `list_media` 返回的 `cardUrl`**,
形如 `/@media/<文件名>`。编辑台预览、`see_frames` 的渲染页、导出都和它同源,三处都取得到。

- 不要填 `path`(磁盘路径):浏览器和渲染页读不了磁盘路径。
- 不要填 `blob:` 开头的地址:那是编辑器页面私有的,渲染和导出打不开,画面里那一块会是空的。
- 不要自己拼 `/media/…`、`http://localhost:端口/…`:端口不固定,导出时也不走那个端口。
- 素材库里没有想要的图:找到图片直链后 `import_media({ url, name })` 装进来,返回里就有 `cardUrl`。

## 5. 控件类型

手写的卡用这四种（素材封装卡里另有一种 `asset`，从素材目录挑 Lottie 或粒子，手写的卡不用它）。四种都可以写 `required`、`hint`：

```ts
{ key, label, type: "text",   required?, hint? }
{ key, label, type: "number", required?, hint?, min?, max?, step? }
{ key, label, type: "select", required?, hint?, options: [{ value, label }] }
{ key, label, type: "color",  required?, hint? }
```

要一个「列表」参数就用 `text`，自己定一个分隔格式，并在 `hint` 里写清楚
（例如字幕轨的 `lines` 用换行分条、`|` 分列）。条数固定的几行文字（例如三行说明）也可以直接做成几个 `text` 参数（`line1`、`line2`、`line3`），空的行不占位由组件自己处理；条数不固定才用分隔格式。

- **`color` 控件**：界面里选出来的是 `#rrggbb` 十六进制字符串；通过 `update_clip` 写入时不校验格式，Agent 可能写进颜色名或 `hsl()`。用框架的 `interpolateColors` 只认 `#rgb`、`#rrggbb`、`#rrggbbaa`、`rgb()`、`rgba()`，认不出会抛错（卡会渲不出来），所以这样的 `color` 控件要在 `hint` 里写明「十六进制颜色，如 #4cc9f0」。
- **`number` 控件的 `min` / `max` / `step`** 只管界面（拖动、输入框的范围）。`update_clip` 只校验是不是数字，**不会**拒绝或夹住越界值，越界值会原样交给组件。所以组件里要自己把参数夹进合理范围，免得算出 NaN 或负的时长。

### 会被调的值，一律做成参数

**凡是「换个数字/颜色就是另一种效果」的值，都要放进 `controls` + `defaults`，不要写死在
组件里。**（检查不会强制这一条，是为了以后好改。卡自己的设计常量——缓动曲线的形状、弹簧的刚度与阻尼、进场上移的距离——不属于「会被调的值」，可以写成文件开头起了名字的 `const`，见第 2.1 节。） 字号、字重、间距、圆角、颜色、动画时长和延迟、进场方向、缩放系数、随机种子——这些
都属于这一类。

这不是风格建议，是成本问题：写死的值只能靠改源码来调，而每改一次源码就有把别处改
坏的风险；做成参数之后，「字大一点」就是一次 `update_clip`，改完立刻生效，也不会碰
到卡片其他任何地方。用户提一次「再大点」很正常，提第三次的时候你会庆幸当初把它做成
了参数。

判断标准：写这个字面量的时候如果心里冒出过「差不多这么大吧」，那它就该是参数。
反过来，布局结构（用 flex 还是 grid）、元素层级、动画的类型这些改了就是另一张卡的东西，
写死在源码里是对的。

## 6. 硬性约束

两种写法都要守。`create_card` 会直接拒绝、并告诉你哪条不过的有：下面的前三条（对 motion 式是文本匹配，注释里写出这几个词也会被拦）；本节末「审查会拒绝这几类」那张表里的各档（自带帧循环、鼠标 / 滚动 / hover 驱动、没装的依赖、没定义的动画 class、来源与许可证）；源码里写 `compositing: 'independent'`、缺必填字段、语法错误。remotion 式的卡另有第 2.4 节那一整张表。`new Date()` 读的也是真实时间，同样不要用——新建卡时不拦它，导出会对不上；改内置卡时才拦。

1. **不要用 `Date.now()`**。导出走的是虚拟时间，读真实时间会和画面对不上。
2. **不要用 `setTimeout` / `setInterval` 驱动动画**。同上，它们不受虚拟时钟控制。
   需要按时间推进就读组件收到的 `t`；motion 式的卡可以把动画交给 `motion/react`。
3. **不要用 `IntersectionObserver`**。卡片挂载即播放，不存在「滚动进入视口」。
4. **卡片是 1920×1080 舞台上的透明层**，根元素用 `absolute inset-0`，背景保持透明
   （除非这张卡就是要铺满底色）。
5. 字号、间距用 1920×1080 下的固定像素，不用响应式单位，舞台会整体缩放。（具体数值要不要做成参数，见第 5 节。）
6. **不要起后台线程、不要用跨页通道和浏览器存储**：`Worker`、`SharedWorker`、`BroadcastChannel`、`navigator.locks`、`localStorage` / `sessionStorage`、IndexedDB、`caches`、`navigator.storage`、`window.name`、`history.pushState` 都不用，也不要把参数（里面有素材地址）存到任何地方。在线浏览器的舞台里这些要么没有、要么只在当前这一次打开期间有效，在桌面上也会让预览和导出对不上。

### 可以用的依赖

| | remotion 式（`"direct"`） | motion 式（`"stateful"`） |
|---|---|---|
| 包 | `react`；框架 `../../kernel/remotionStyle`（见 2.5 节名单） | `react`、`motion/react`、`lottie-web`、`@tsparticles/engine` + `@tsparticles/slim`（canvas 粒子；挂载时先 `setRandom(() => Math.random())`，参考 `src/cards/native/particles.tsx`）、`three` |
| 相对路径 | 只有 2.5 节名单里的那几个 | `../../kernel/types`、`../native/hud`、`../magicui/vendor/*` 等 |
| 样式 | Tailwind class（项目已装 Tailwind），不含 `animate-*`、`transition*` | Tailwind class |

两种写法都可以：

- `import type { CardDef, CardProps } from "../../kernel/types"`
- 复用 HUD 那套位置/主色约定（不是必须用）：`import { hudControls, hudDefaults, getPositionClass, accentOf, easeExpoOut, type HudParams } from "../native/hud"`，
  然后 `interface Params extends HudParams`、`defaults: { ...hudDefaults, ... }`、`controls: [...hudControls, ...]`。
  这样卡片自动获得「位置」（`position`，取值 `"center"` / `"bottom"` / `"left"` / `"right"`，缺省居中）和「主色」（`accent`，缺省留空）两个参数，和内置卡保持一致。`getPositionClass(params.position)` 回对应的定位类名（`hud-pos-center` 等），`accentOf(params)` 回 `accent`，留空时回主题色 `var(--pc-accent, #4f8cff)`，`easeExpoOut` 是 Motion 用的缓动数组 `[0.16, 1, 0.3, 1]`。

别引其他第三方库——没装的会直接编译失败。

### 搬第三方组件（Magic UI 等）

可以把 Magic UI 的组件源码直接交给 `create_card`，它会先过一遍翻译器再审查。搬来的组件多半用 Motion 或 CSS 动画，所以写 `frameMode: "stateful"`：

- **自动改掉的**：`"use client"` 去掉；`@/lib/utils` 指到本地的 `../magicui/vendor/cn`。改了什么在返回的 `rewrites` 里。
- **必须你来做的**：把组件包成 `CardDef`——写 `Component`（把 `params` 喂给它、套上 `absolute inset-0` 的 1920×1080 层）、`defaults`、`controls`、`useWhen`、`frameMode`。返回的 `suggestedControls` 是从它的 `*Props` 接口推出来、你还没露出来的参数，由你决定要不要提。
- **文件头必须声明来源和许可证**，照 `src/cards/magicui/vendor/word-rotate.tsx` 的写法：`来源: <URL>` 加许可证名。能搬的只有 MIT / Apache-2.0 / BSD / ISC / CC0。React Bits（Commons Clause）、Aceternity（专有）、animate.css（Hippocratic）、GSAP（禁止用于无代码动画工具）**不能搬**。
- 文件头声明了来源是 magicui 的卡可以用 `mu-` 前缀。
- **不用上网找源码**：Magic UI 全部组件的原始源码在本地目录里，本文末尾「附:Magic UI 可搬目录」按档位列了每一个。想用哪个就 `get_card_source({ cardId: "mu-<name>" })` 读它（返回里的 `hint` 会告诉你要先处理什么），包好后用同一个 id `create_card`。

审查会**拒绝**这几类，返回的 `findings` 逐条带类型标签（报错里原样写成 `[第二档·管线暂不支持]`、`[第三档·交互驱动]`、`[依赖]`、`[动画 class]`、`[来源/许可证]`；「第二档」「第三档」只是内部的编号，没有「第一档」这一档——前面那三条老规矩不在这张表里，它们的报错不带标签）：

| 类型 | 触发 | 为什么 |
|---|---|---|
| 第二档·管线暂不支持 | `setAnimationLoop` 这类**自带帧循环**、@react-three/fiber、cobe | 按 delta 累积的循环在导出里会多走不确定的步数，往回拖播放头也回不去。`<canvas>`、`Math.random`、**WebGL 和 three 现在都接得住**（three 已装，导出开了软件 WebGL，实测两趟逐字节相同），不再拒 |
| 第三档·交互驱动 | mousemove / scroll 监听、`whileHover` / `whileTap` / `whileInView`、`useScroll` | 导出里没有鼠标和滚动，只会停在初态；改成由 `t` 驱动的参数才能进导出 |
| 依赖 | import 了没装的库 | 装了的:react、motion/react、three、lottie-web、@tsparticles/*、Tailwind class,以及相对路径（remotion 式只许 2.5 节名单里的） |
| 动画 class | `animate-xxx` 没定义 | Tailwind 自带 4 个；MagicUI 的 22 组已在 `magicui-animations.css`；别的要自己写进去（remotion 式的卡不用 CSS 动画） |
| 来源/许可证 | 搬来的没写来源，或许可证不允许 | 不知道能不能随安装包分发 |

机制上已验证能直接搬的 Magic UI 组件（和已过逐字节比对的 5 张同类）：文字类（Text Animate、Typing、Number Ticker、Word Rotate、Shiny / Gradient / Aurora Text、Morphing、Spinning、Text 3D Flip）、Blur Fade、Border Beam、Shine Border、Marquee、Orbiting Circles、Animated List、各按钮、各背景图案、设备框。搬进来后一定 `see_frames` 看一眼。

## 7. 组件收到什么

```ts
interface CardProps<P> {
  params: P;        // defaults 和 clip.params 合并后的完整参数
  playToken: number; // 每次重播 +1；Stage 用它作 key 重新挂载，组件里通常不用读
  t?: number;        // 自 clip 起点起的秒数，逐帧传入
  duration?: number; // clip 总时长（秒）
}
```

- **remotion 式的卡一定要读 `t`**：画面就是 t 的函数。`t` 在 `CardProps` 里是可选属性，所以解构时写 `{ params, t = 0 }`。
- **用 Motion 的卡绝大多数不需要 `t`**——挂载即播，`motion` 自己会把动画走完。只有「跟着时间轴走」的卡才读 `t`：字幕轨（按时间切换当前句）、章节导航（按时间高亮当前章节），以及按 `t` 显式渲染的卡（三维卡、自己引 `lottie-web` 按帧号定位的卡）。
  如果你的卡要读 `t`，在 `useWhen` 里说明它需要 clip 覆盖整段时间，而不是一小截。
- **不要往 `params` 里写**（所有卡都一样）：它是宿主交来的输入，往里写会把状态带到下一帧或别的片段。
- `t` 的起点：普通卡是片段本地秒；写了 `audio()` 的卡，`t` 已经加上片段开头被裁掉的那一段，见第 10 节。

## 8. 建卡流程

```
card_authoring_guide()                     ← 先读规则（就是这份）
create_card({ id, source })                ← 落盘 + 热更新 + 自动注册
list_cards({ cardId: "price-tag" })        ← 确认注册成功、schema 是你想要的
add_clip({ cardId: "price-tag", start, duration, params })   ← 放上时间轴
see_frames({ source: "timeline", clipId })                    ← 看一眼画面，确认它真的长成你想要的样子
user_interface_seek({ t: start + 0.5 })    ← 可选:把用户的播放头挪过去，让他直接看到效果(会动用户的界面，能不用就不用)
```

源码写到 `src/cards/user/<id>.tsx`，**不需要**改任何注册表文件——该目录是自动扫描的。

`create_card` 落盘前会校验：id 合法且不重名（整张推倒重来才传 `overwrite: true`，见 8.1 节）、确实导出了 `CardDef`、
源码里的 `id` 和参数里的 `id` 一致、必需字段齐全（含 `frameMode`）、没用禁用 API、TypeScript 语法能过；
声明成 remotion 式的卡另外按第 2.4 节逐条检查。
不合格会返回**具体哪一条不过**（remotion 式的带行号），照着改再调一次即可。

### 8.1 改一张已经建好的卡

先想清楚要改的是**参数**还是**源码**——绝大多数「再大一点」「换个颜色」都是参数：

```
list_cards({ cardId })          ← 看这张卡有哪些参数
update_clip({ clipId, params }) ← 改值，立刻生效，不碰源码
see_frames({ source: "timeline", clipId })         ← 看一眼改成什么样了
```

只有参数覆盖不到的（要加一个新参数、改布局、改动画类型）才动源码，走这三步：

```
get_card_source({ cardId })                   ← 读回当前源码，必须先读
edit_card({ cardId, find, replace })          ← 只替换那一段，别处原样不动
see_frames({ source: "timeline", clipId })                       ← 看画面确认，别凭源码想象
```

`find` 要从 `get_card_source` 返回的源码里**逐字照抄**（缩进、空格都要一致），并且在
全文里唯一命中；匹配到多处就把 `find` 写长一点、带上周围几行。

**内置卡也能这样改源码**（不只是 `create_card` 建出来的）。不知道画面上某一块是源码哪一行渲染的，先看它的 DOM 树：

```
inspect_card_dom({ clipId })                  ← 只读：每个节点标出组件和源码行，如 src/cards/native/rank-bars.tsx:49
inspect_card_dom({ clipId, ref: 6 })          ← 从某个节点往下展开（同一时刻有缓存，不重渲）
get_card_source({ cardId, file })             ← 读那个文件（必须在返回的 files 列表里）
edit_card({ cardId, file, find, replace })    ← 改那一行
```

- **只能改源码，不能改 HTML**：DOM 是源码渲染出来的，没有直接改 DOM 的工具，也不该找。
- `files` 里每个文件带 `sharedBy`：大于 1 的是多张卡共用的部件（比如 `hud.ts`），改了它们一起变；只想改这一张，就改它自己的定义文件。
- 标着「同一行源码生成了 N 个兄弟节点」的是列表，改那一行 N 个一起变。
- 内置文件改之前自动备份到 `out/card-edits/`；不许新引入 `Date.now` / `new Date()` / `setTimeout` / `setInterval` / `IntersectionObserver` / `setAnimationLoop` 这类不跟帧走的写法。
- 改声明成 remotion 式的卡（包括内置的那几张），同样按第 2.4 节检查：用框架写的卡每一条违规都拒；框架出现之前建的老卡只拒绝这次新增的。
- 把 motion 式的卡改成 remotion 式（或反过来）等于重写这张卡的写法，不是改一个字段能完成的：改成 remotion 式按新建卡检查，每一条违规都拒。

**不要用 `create_card` + `overwrite: true` 去改卡。** 那是整篇重写：你手上没有当前
版本，就只能凭记忆重建，这次没提到的细节（字号、间距、颜色）会一次比一次漂，用户
会看到自己没要求改的地方莫名其妙变了。`overwrite` 只留给「这张卡整个推倒重来」。

内置卡同样先试调参数；确实要动源码，才用上面的 `get_card_source` + `edit_card`。

## 9. 用转写结果做卡

素材转写完（`transcribe_media` → `get_transcript`）后拿到：

```json
{ "segments": [ { "start": 0.0, "end": 1.6, "text": "大家好，欢迎收看本期节目。" } ] }
```

`start` / `end` 是**素材内**的秒数。

### 铺字幕轨

**用 `fill_captions`，不要自己拼 `lines` 字符串。**

```
add_clip({ cardId: "caption-track", start: 0, duration: 整段时长, params: { lines: "占位" } })
fill_captions({ clipId })
```

`fill_captions` 在本地一次算完时间对齐和裁切，几十上百条字幕不用逐条重打，
既不会错行错时间，也不烧 token。一整段字幕**一张卡**就够，不要每句话建一张。

不给 `trackId` 时它会自己落到「字幕」序列上（没有就新建，建在最上层）。
之后要改某一条，用 `list_captions` 看下标再 `edit_caption`，不要重灌整份。

### 按内容配动效

`auto_workflow` 已经把这条路自动化了（切段 + 选卡 + 铺字幕），用户说「自动做」「一键配特效」
就直接调它，不要自己一张张 `add_clip`。

要手动精修时，顺着文字稿找可视化的点，用每张卡的 `useWhen` 决定选哪张，
在对应 segment 的时间点 `add_clip`。注意同一条轨上的 clip 不能重叠
（store 会自动挪开，但结果多半不是你想要的）；需要并排显示就先 `add_track` 建新的 overlay 轨。

## 10. 有声动效卡与持久声音

- 同一 `CardDef` 可写 `Component + audio` 或 `card + audio`；`kind` 保持视觉类别。不要在组件挂载时调用实时声音播放来代替 `audio()`，那种副作用不能保证定位、静音和成片一致。
- `audio()` 按 48 kHz 采样位置返回交错浮点 PCM；只依赖完整参数、确定种子、事件身份与采样位置，不能用真实时钟或随机调用顺序推进声音。纯合成显式 `inputs: {}`。
- 创建或修改后调用 `render_card_audio({ clipId })`，成功入库才可跨设备播放。改参数或源码后重新生成；支持 `cancel_card_audio`，失败不假装成功。
- `set_clip_muted` 只关声音，时间轴醒目标记；声音仍在原动效片段中。对它调用 `separate_audio` 明确返回 `EMBEDDED_CARD_AUDIO_UNSEPARABLE`，不自动退回生成独立声音段。普通视频素材的分离能力不变。
- 单独提示音或键盘音效先用 `sound_presets` / `sound_generate`，无需重新创建卡片。

- 有声视觉卡（写了 `audio()` 的卡）的 `Component` 所收到的 `t`、视觉 `card()` 的 `t`、`audio()` 的 `range.start / sampleRate`，宿主已经归到同一根时间轴上：这根轴是「片段本地秒 + 片段开头被裁切、切分掉的秒数（`sourceOffset`）」，没裁过的片段就等于片段本地秒。`CardProps` 里另给的 `sourceOffset` 只作诊断，**不要再把它加到 `t` 上**。没有 `audio` 的普通 DOM 卡，`t` 就是片段本地秒。
